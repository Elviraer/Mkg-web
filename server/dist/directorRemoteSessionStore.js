import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
const DEFAULT_TTL_MS = 10 * 60 * 1000;
function createToken() {
    return randomBytes(32).toString('base64url');
}
function createPairingCode() {
    return randomInt(0, 1000000).toString().padStart(6, '0');
}
function equalToken(actual, expected) {
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
export class DirectorRemoteSessionStore {
    constructor(options = {}) {
        this.sessions = new Map();
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    }
    create(input) {
        this.cancelForNode(input.nodeId);
        const now = Date.now();
        let pairingCode = createPairingCode();
        while ([...this.sessions.values()].some((item) => item.pairingCode === pairingCode && item.expiresAt > now)) {
            pairingCode = createPairingCode();
        }
        const session = {
            id: randomUUID(),
            nodeId: input.nodeId,
            cameraId: input.cameraId,
            desktopToken: createToken(),
            mobileToken: createToken(),
            pairingCode,
            createdAt: now,
            expiresAt: now + this.ttlMs,
            status: 'waiting',
            desktopConnected: false,
            mobileConnected: false,
        };
        this.sessions.set(session.id, session);
        const origin = input.publicOrigin.replace(/\/$/, '');
        return {
            sessionId: session.id,
            desktopToken: session.desktopToken,
            pairingCode: session.pairingCode,
            expiresAt: new Date(session.expiresAt).toISOString(),
            mobileUrl: `${origin}/director-remote`,
        };
    }
    pair(pairingCode) {
        const normalizedCode = pairingCode.replace(/\D/g, '');
        const session = [...this.sessions.values()].find((item) => item.pairingCode === normalizedCode
            && item.desktopConnected
            && (item.status === 'waiting' || (item.status === 'paired' && !item.mobileConnected))
            && item.expiresAt > Date.now());
        if (!session)
            return null;
        session.status = 'paired';
        return {
            sessionId: session.id,
            mobileToken: session.mobileToken,
            expiresAt: new Date(session.expiresAt).toISOString(),
        };
    }
    authenticate(sessionId, role, token) {
        const session = this.getActive(sessionId);
        if (!session)
            return null;
        const expected = role === 'desktop' ? session.desktopToken : session.mobileToken;
        return equalToken(token, expected) ? session : null;
    }
    getActive(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return null;
        if (session.expiresAt <= Date.now()) {
            session.status = 'expired';
            session.desktopConnected = false;
            session.mobileConnected = false;
            return null;
        }
        if (session.status === 'closed' || session.status === 'expired')
            return null;
        return session;
    }
    getStatus(sessionId, role, token) {
        const session = this.authenticate(sessionId, role, token);
        if (!session)
            return null;
        return {
            sessionId: session.id,
            status: session.status,
            expiresAt: new Date(session.expiresAt).toISOString(),
            desktopConnected: session.desktopConnected,
            mobileConnected: session.mobileConnected,
        };
    }
    setConnected(sessionId, role, connected) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return;
        if (role === 'desktop')
            session.desktopConnected = connected;
        if (role === 'mobile')
            session.mobileConnected = connected;
        if (!connected && session.status === 'paired')
            session.status = 'waiting';
    }
    touch(sessionId) {
        const session = this.getActive(sessionId);
        if (!session)
            return false;
        session.expiresAt = Date.now() + this.ttlMs;
        return true;
    }
    cancel(sessionId, desktopToken) {
        const session = this.authenticate(sessionId, 'desktop', desktopToken);
        if (!session)
            return false;
        session.status = 'closed';
        session.desktopConnected = false;
        session.mobileConnected = false;
        return true;
    }
    cancelForNode(nodeId) {
        this.sessions.forEach((session) => {
            if (session.nodeId === nodeId && session.status !== 'closed')
                session.status = 'closed';
        });
    }
    sweep() {
        const now = Date.now();
        this.sessions.forEach((session, id) => {
            if (session.expiresAt <= now || session.status === 'closed')
                this.sessions.delete(id);
        });
    }
}
