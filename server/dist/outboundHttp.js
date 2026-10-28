import dns from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';
const DEFAULT_ALLOWED_PORTS = new Set(['80', '443']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const SENSITIVE_REDIRECT_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
// Undici's default header/body timeout is 300 seconds. That is the same value
// exposed as MK's default image execution timeout, so the transport layer can
// win the race and close a request at the exact application deadline. The
// generation AbortSignal remains the source of truth; keep the dispatcher
// timeout above the maximum MK policy instead of introducing a second shorter
// timeout.
const OUTBOUND_HEADER_BODY_TIMEOUT_MS = 65 * 60 * 1000;
export class OutboundUrlPolicyError extends Error {
    constructor(message) {
        super(message);
        this.code = 'outbound_url_not_allowed';
        this.name = 'OutboundUrlPolicyError';
    }
}
const normalizeTrustedOrigins = (values) => new Set([...(values ?? [])].map((value) => new URL(value).origin));
const resolveAllowedPorts = (values) => {
    const ports = new Set(DEFAULT_ALLOWED_PORTS);
    for (const value of values ?? []) {
        const port = String(value).trim();
        if (/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535)
            ports.add(port);
    }
    return ports;
};
const effectivePort = (url) => url.port || (url.protocol === 'https:' ? '443' : '80');
export const isPublicIpAddress = (value) => {
    try {
        return ipaddr.process(value).range() === 'unicast';
    }
    catch {
        return false;
    }
};
export const validateOutboundUrl = (value, policy = {}) => {
    let url;
    try {
        url = value instanceof URL ? new URL(value) : new URL(value);
    }
    catch {
        throw new OutboundUrlPolicyError('远程地址格式无效');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new OutboundUrlPolicyError('远程地址仅支持 HTTP(S)');
    }
    if (url.username || url.password) {
        throw new OutboundUrlPolicyError('远程地址不能包含用户凭证');
    }
    const trustedOrigins = normalizeTrustedOrigins(policy.trustedOrigins);
    const isTrustedOrigin = trustedOrigins.has(url.origin);
    if (!isTrustedOrigin && !resolveAllowedPorts(policy.allowedPorts).has(effectivePort(url))) {
        throw new OutboundUrlPolicyError(`远程地址端口不在允许列表中: ${effectivePort(url)}`);
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (ipaddr.isValid(hostname) && !isTrustedOrigin && !isPublicIpAddress(hostname)) {
        throw new OutboundUrlPolicyError('远程地址不能指向本机、私网、链路本地或保留地址');
    }
    return { url, isTrustedOrigin };
};
export const createValidatedLookup = ({ allowPrivateNetwork, lookup = dns.lookup, }) => (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) {
            callback(error, [], undefined);
            return;
        }
        if (addresses.length === 0) {
            callback(new OutboundUrlPolicyError(`远程地址 DNS 未返回结果: ${hostname}`), [], undefined);
            return;
        }
        if (!allowPrivateNetwork && addresses.some((item) => !isPublicIpAddress(item.address))) {
            callback(new OutboundUrlPolicyError(`远程地址 DNS 解析到了非公网地址: ${hostname}`), [], undefined);
            return;
        }
        if (options.all) {
            callback(null, addresses);
            return;
        }
        callback(null, addresses[0].address, addresses[0].family);
    });
};
const publicAgent = new Agent({
    connect: { lookup: createValidatedLookup({ allowPrivateNetwork: false }) },
    headersTimeout: OUTBOUND_HEADER_BODY_TIMEOUT_MS,
    bodyTimeout: OUTBOUND_HEADER_BODY_TIMEOUT_MS,
});
const trustedAgent = new Agent({
    connect: { lookup: createValidatedLookup({ allowPrivateNetwork: true }) },
    headersTimeout: OUTBOUND_HEADER_BODY_TIMEOUT_MS,
    bodyTimeout: OUTBOUND_HEADER_BODY_TIMEOUT_MS,
});
const redirectInit = (init, status, from, to) => {
    const headers = new Headers(init.headers);
    if (from.origin !== to.origin) {
        SENSITIVE_REDIRECT_HEADERS.forEach((header) => headers.delete(header));
    }
    const method = (init.method ?? 'GET').toUpperCase();
    if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        headers.delete('content-length');
        headers.delete('content-type');
        const nextInit = { ...init, method: 'GET', headers };
        delete nextInit.body;
        return nextInit;
    }
    return { ...init, headers };
};
export const outboundFetch = async (value, init = {}, policy = {}) => {
    let current = value instanceof URL ? new URL(value) : new URL(value);
    let currentInit = { ...init };
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
        const { url, isTrustedOrigin } = validateOutboundUrl(current, policy);
        const response = await fetch(url, {
            ...currentInit,
            redirect: 'manual',
            dispatcher: isTrustedOrigin ? trustedAgent : publicAgent,
        });
        if (!REDIRECT_STATUSES.has(response.status))
            return response;
        const location = response.headers.get('location');
        if (!location)
            return response;
        if (redirectCount === MAX_REDIRECTS) {
            await response.body?.cancel();
            throw new OutboundUrlPolicyError(`远程地址重定向超过 ${MAX_REDIRECTS} 次`);
        }
        const next = new URL(location, url);
        await response.body?.cancel();
        currentInit = redirectInit(currentInit, response.status, url, next);
        current = next;
    }
    throw new OutboundUrlPolicyError('远程请求重定向失败');
};
