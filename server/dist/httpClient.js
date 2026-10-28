import { outboundFetch, OutboundUrlPolicyError } from './outboundHttp.js';
const sanitizeRequestUrl = (value) => {
    try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
    }
    catch {
        return '[invalid-url]';
    }
};
const withNetworkErrorContext = (url, error, requestPhase) => {
    if (!(error instanceof Error))
        return error;
    const cause = 'cause' in error ? error.cause : undefined;
    const causeCode = cause && typeof cause === 'object' && 'code' in cause
        ? (typeof cause.code === 'string' ? cause.code : '')
        : '';
    // Undici reports a socket reset while reading the response as "terminated"
    // rather than "fetch failed". Enrich both forms so the log identifies the
    // phase without exposing request data or credentials.
    if (error.message !== 'fetch failed' && !causeCode && error.message !== 'terminated')
        return error;
    const causeMessage = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
    const enriched = new Error(causeMessage ? `请求失败: ${causeMessage}` : error.message);
    Object.defineProperty(enriched, 'cause', { value: error, enumerable: false, configurable: true });
    enriched.requestUrl = sanitizeRequestUrl(url);
    enriched.requestPhase = requestPhase;
    return enriched;
};
const assertTrustedJsonRequestOrigin = (url, policy) => {
    const requestOrigin = new URL(url).origin;
    const trustedOrigins = new Set([...(policy.trustedOrigins ?? [])].map((value) => new URL(value).origin));
    if (!trustedOrigins.has(requestOrigin)) {
        throw new OutboundUrlPolicyError(`JSON 请求缺少可信 Provider 原点: ${requestOrigin}`);
    }
};
export const withTimeout = async (timeoutMs, run, externalSignal) => {
    const controller = new AbortController();
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted)
        abortFromExternal();
    else
        externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    const timeoutId = setTimeout(() => {
        controller.abort();
    }, timeoutMs);
    try {
        return await run(controller.signal);
    }
    finally {
        clearTimeout(timeoutId);
        externalSignal?.removeEventListener('abort', abortFromExternal);
    }
};
export const fetchJson = async (url, init, timeoutMs, policy) => {
    assertTrustedJsonRequestOrigin(url, policy);
    const { signal: externalSignal, ...requestInit } = init;
    return withTimeout(timeoutMs, async (signal) => {
        let response;
        try {
            response = await outboundFetch(url, { ...requestInit, signal }, policy);
        }
        catch (error) {
            throw withNetworkErrorContext(url, error, 'connect');
        }
        let text;
        try {
            text = await response.text();
        }
        catch (error) {
            throw withNetworkErrorContext(url, error, 'response_body');
        }
        let data = null;
        if (text) {
            try {
                data = JSON.parse(text);
            }
            catch {
                data = { raw: text };
            }
        }
        return { response, data };
    }, externalSignal ?? undefined);
};
export const fetchBinary = async (url, init, timeoutMs, policy) => {
    assertTrustedJsonRequestOrigin(url, policy);
    const { signal: externalSignal, ...requestInit } = init;
    return withTimeout(timeoutMs, async (signal) => {
        let response;
        try {
            response = await outboundFetch(url, { ...requestInit, signal }, policy);
        }
        catch (error) {
            throw withNetworkErrorContext(url, error, 'connect');
        }
        let bytes;
        try {
            bytes = new Uint8Array(await response.arrayBuffer());
        }
        catch (error) {
            throw withNetworkErrorContext(url, error, 'response_body');
        }
        return { response, bytes };
    }, externalSignal ?? undefined);
};
export const asUniqueList = (items) => [...new Set(items.filter(Boolean))];
