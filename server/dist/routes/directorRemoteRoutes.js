import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
function readBearerToken(value) {
    return value?.match(/^Bearer\s+(.+)$/i)?.[1] ?? '';
}
function readRequiredString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
export function createDirectorRemoteRoutes(options) {
    const router = Router();
    const pairRateLimit = rateLimit({
        windowMs: 60000,
        limit: 5,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'too many pairing attempts' },
    });
    router.post('/director-remote/sessions', (request, response) => {
        const nodeId = readRequiredString(request.body?.nodeId);
        const cameraId = readRequiredString(request.body?.cameraId);
        const requestedOrigin = readRequiredString(request.body?.publicOrigin);
        if (!nodeId || !cameraId) {
            response.status(400).json({ error: 'nodeId and cameraId are required' });
            return;
        }
        const fallbackOrigin = `${request.protocol}://${request.get('host')}`;
        const publicOrigin = options.publicOrigin || requestedOrigin || fallbackOrigin;
        try {
            const parsedOrigin = new URL(publicOrigin);
            response.status(201).json(options.store.create({ nodeId, cameraId, publicOrigin: parsedOrigin.origin }));
        }
        catch {
            response.status(400).json({ error: 'publicOrigin must be a valid origin' });
        }
    });
    router.post('/director-remote/pair', pairRateLimit, (request, response) => {
        const pairingCode = readRequiredString(request.body?.pairingCode)?.replace(/\D/g, '');
        if (!pairingCode || pairingCode.length !== 6) {
            response.status(400).json({ error: 'a 6-digit pairingCode is required' });
            return;
        }
        const pairedSession = options.store.pair(pairingCode);
        if (!pairedSession) {
            response.status(404).json({ error: 'pairing code is invalid or expired' });
            return;
        }
        response.json(pairedSession);
    });
    router.get('/director-remote/sessions/:sessionId', (request, response) => {
        const role = request.query.role === 'mobile' ? 'mobile' : 'desktop';
        const token = readBearerToken(request.headers.authorization) || String(request.query.token ?? '');
        const status = options.store.getStatus(request.params.sessionId, role, token);
        if (!status) {
            response.status(404).json({ error: 'session not found or expired' });
            return;
        }
        response.json(status);
    });
    router.post('/director-remote/sessions/:sessionId/cancel', (request, response) => {
        const token = readBearerToken(request.headers.authorization);
        if (!options.store.cancel(request.params.sessionId, token)) {
            response.status(404).json({ error: 'session not found or expired' });
            return;
        }
        response.status(204).end();
    });
    return router;
}
