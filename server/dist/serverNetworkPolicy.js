import cors from 'cors';
const DEFAULT_SERVER_HOST = '127.0.0.1';
const DEFAULT_WEB_PORT = 5170;
const normalizeOrigin = (value, source) => {
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        throw new Error(`${source} contains an invalid origin: ${value}`);
    }
    if (!['http:', 'https:'].includes(url.protocol)
        || url.username
        || url.password
        || url.pathname !== '/'
        || url.search
        || url.hash) {
        throw new Error(`${source} must contain HTTP(S) origins without paths, credentials, queries, or fragments: ${value}`);
    }
    return url.origin;
};
export const resolveServerHost = (value) => value?.trim() || DEFAULT_SERVER_HOST;
export const resolveAllowedCorsOrigins = ({ protocol, port, publicOrigin, configuredOrigins, }) => {
    const origins = new Set([
        `${protocol}://127.0.0.1:${DEFAULT_WEB_PORT}`,
        `${protocol}://localhost:${DEFAULT_WEB_PORT}`,
        `${protocol}://127.0.0.1:${port}`,
        `${protocol}://localhost:${port}`,
    ]);
    if (publicOrigin?.trim()) {
        origins.add(normalizeOrigin(publicOrigin, 'MK_PUBLIC_ORIGIN'));
    }
    configuredOrigins
        ?.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
        .forEach((origin) => origins.add(normalizeOrigin(origin, 'MK_CORS_ORIGINS')));
    return origins;
};
export const createCorsOriginGuard = (allowedOrigins) => (request, response, next) => {
    const origin = request.header('origin');
    if (origin && !allowedOrigins.has(origin)) {
        response.status(403).json({
            ok: false,
            code: 'origin_not_allowed',
            message: '请求来源不在允许列表中',
        });
        return;
    }
    next();
};
export const createCorsMiddleware = (allowedOrigins) => {
    const options = {
        origin: (origin, callback) => callback(null, Boolean(origin && allowedOrigins.has(origin))),
    };
    return cors(options);
};
export const formatListeningOrigin = ({ protocol, host, port, }) => {
    const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `${protocol}://${displayHost}:${port}`;
};
