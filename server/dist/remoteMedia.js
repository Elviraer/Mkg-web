import { once } from 'node:events';
import { detectMediaBuffer } from './mediaFileType.js';
import { outboundFetch, } from './outboundHttp.js';
export const DEFAULT_MAX_REMOTE_MEDIA_BYTES = 256 * 1024 * 1024;
export const DEFAULT_REMOTE_MEDIA_TIMEOUT_MS = 30000;
const DETECTION_BYTES = 4100;
export class RemoteMediaError extends Error {
    constructor(code, message, statusCode) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
        this.name = 'RemoteMediaError';
    }
}
const readContentLength = (response) => {
    const value = Number(response.headers.get('content-length'));
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};
const assertExpectedKind = (detected, expectedKind) => {
    if (!detected || (expectedKind && detected.kind !== expectedKind)) {
        throw new RemoteMediaError('unsupported_media_type', '远程响应不是受支持的媒体类型', 415);
    }
    return detected;
};
const withRemoteMediaTimeout = async (timeoutMs, run) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await run(controller.signal);
    }
    catch (error) {
        if (controller.signal.aborted) {
            throw new RemoteMediaError('remote_media_timeout', '远程媒体读取超时', 504);
        }
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
};
const assertResponseSize = (response, maxBytes) => {
    const contentLength = readContentLength(response);
    if (contentLength !== undefined && contentLength > maxBytes) {
        throw new RemoteMediaError('remote_media_too_large', '远程媒体超过大小限制', 413);
    }
    return contentLength;
};
const assertSuccessfulResponse = (response) => {
    if (!response.ok) {
        throw new RemoteMediaError('remote_media_fetch_failed', `远程媒体请求失败: HTTP ${response.status}`, 502);
    }
};
export const readMediaResponseBuffer = async (response, { maxBytes = DEFAULT_MAX_REMOTE_MEDIA_BYTES, expectedKind, } = {}) => {
    try {
        assertSuccessfulResponse(response);
        assertResponseSize(response, maxBytes);
    }
    catch (error) {
        await response.body?.cancel();
        throw error;
    }
    if (!response.body) {
        throw new RemoteMediaError('remote_media_fetch_failed', '远程媒体响应为空', 502);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new RemoteMediaError('remote_media_too_large', '远程媒体超过大小限制', 413);
        }
        chunks.push(value);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes);
    const detected = assertExpectedKind(await detectMediaBuffer(bytes), expectedKind);
    return { bytes, detected };
};
export const fetchRemoteMediaBuffer = async (url, { policy, maxBytes = DEFAULT_MAX_REMOTE_MEDIA_BYTES, timeoutMs = DEFAULT_REMOTE_MEDIA_TIMEOUT_MS, expectedKind, } = {}) => withRemoteMediaTimeout(timeoutMs, async (signal) => {
    const response = await outboundFetch(url, { signal }, policy);
    return readMediaResponseBuffer(response, { maxBytes, expectedKind });
});
export const streamRemoteMediaResponse = async ({ url, response, filename, inline, policy, maxBytes = DEFAULT_MAX_REMOTE_MEDIA_BYTES, timeoutMs = DEFAULT_REMOTE_MEDIA_TIMEOUT_MS, }) => withRemoteMediaTimeout(timeoutMs, async (signal) => {
    const upstream = await outboundFetch(url, { signal }, policy);
    let contentLength;
    try {
        assertSuccessfulResponse(upstream);
        contentLength = assertResponseSize(upstream, maxBytes);
    }
    catch (error) {
        await upstream.body?.cancel();
        throw error;
    }
    if (!upstream.body)
        throw new RemoteMediaError('remote_media_fetch_failed', '远程媒体响应为空', 502);
    const reader = upstream.body.getReader();
    const initialChunks = [];
    let totalBytes = 0;
    while (totalBytes < DETECTION_BYTES) {
        const { done, value } = await reader.read();
        if (done)
            break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new RemoteMediaError('remote_media_too_large', '远程媒体超过大小限制', 413);
        }
        initialChunks.push(value);
    }
    const initialBytes = Buffer.concat(initialChunks.map((chunk) => Buffer.from(chunk)), totalBytes);
    const detected = assertExpectedKind(await detectMediaBuffer(initialBytes));
    response.setHeader('Content-Type', detected.mime);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(filename)}"`);
    if (contentLength !== undefined)
        response.setHeader('Content-Length', String(contentLength));
    if (initialBytes.length > 0 && !response.write(initialBytes))
        await once(response, 'drain');
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new RemoteMediaError('remote_media_too_large', '远程媒体超过大小限制', 413);
        }
        if (!response.write(Buffer.from(value)))
            await once(response, 'drain');
    }
    response.end();
    return { bytes: totalBytes, detected };
});
