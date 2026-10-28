import { automationCommandDefinitions, automationSessionIdleTimeoutOptions, defaultAutomationApprovalPolicy, } from '@ftv/shared';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
const SESSION_REQUEST_TTL_MS = 2 * 60 * 1000;
const CANVAS_TICKET_TTL_MS = 60 * 1000;
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const tokensEqual = (leftHash, token) => {
    const left = Buffer.from(leftHash, 'hex');
    const right = Buffer.from(hashToken(token), 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
};
const createSecret = () => randomBytes(32).toString('base64url');
export class AutomationStore {
    constructor(persistence) {
        this.persistence = persistence;
        this.sessions = new Map();
        this.sessionRequests = new Map();
        this.canvasTickets = new Map();
        this.commands = new Map();
        this.trustedClients = new Map();
        this.sessionIdleTimeoutMs = defaultAutomationApprovalPolicy.sessionIdleTimeoutMs;
        const loaded = persistence?.load();
        if (!loaded || typeof loaded !== 'object')
            return;
        const state = loaded;
        if (automationSessionIdleTimeoutOptions.includes(state.sessionIdleTimeoutMs)) {
            this.sessionIdleTimeoutMs = state.sessionIdleTimeoutMs;
        }
        if (!Array.isArray(state.trustedClients))
            return;
        state.trustedClients.forEach((client) => {
            if (client
                && typeof client.trustedClientId === 'string'
                && typeof client.clientId === 'string'
                && typeof client.tokenHash === 'string'
                && typeof client.clientName === 'string'
                && typeof client.projectId === 'string'
                && typeof client.canvasId === 'string') {
                this.trustedClients.set(client.trustedClientId, {
                    ...client,
                    crossWorkspace: client.crossWorkspace === true,
                });
            }
        });
    }
    persistSettings() {
        this.persistence?.save({
            trustedClients: Array.from(this.trustedClients.values()),
            sessionIdleTimeoutMs: this.sessionIdleTimeoutMs,
        });
    }
    setSessionIdleTimeoutMs(value) {
        if (!automationSessionIdleTimeoutOptions.includes(value))
            return false;
        if (this.sessionIdleTimeoutMs === value)
            return true;
        this.sessionIdleTimeoutMs = value;
        this.persistSettings();
        return true;
    }
    getSessionIdleTimeoutMs() {
        return this.sessionIdleTimeoutMs;
    }
    createSessionRequest(clientName = 'MK automation client', now = Date.now(), details = {}) {
        const requestId = `automation-request-${randomUUID()}`;
        const requestToken = createSecret();
        const createdAt = new Date(now).toISOString();
        const expiresAt = new Date(now + SESSION_REQUEST_TTL_MS).toISOString();
        const normalizedClientName = clientName.trim().slice(0, 200) || 'MK automation client';
        this.sessionRequests.set(requestId, {
            requestId,
            requestTokenHash: hashToken(requestToken),
            clientName: normalizedClientName,
            clientId: details.clientId?.trim() || `untrusted-${randomUUID()}`,
            ...(details.projectId ? { requestedProjectId: details.projectId } : {}),
            ...(details.canvasId ? { requestedCanvasId: details.canvasId } : {}),
            status: 'pending',
            createdAt,
            expiresAt,
        });
        return { requestId, requestToken, status: 'pending', clientName: normalizedClientName, createdAt, expiresAt };
    }
    createSessionRecord({ clientName, projectId, canvasId, trustedClientId, ttlMs, now = Date.now(), }) {
        const sessionId = `automation-${randomUUID()}`;
        const token = createSecret();
        const createdAt = new Date(now).toISOString();
        const idleTimeoutMs = ttlMs ?? this.sessionIdleTimeoutMs;
        const session = {
            sessionId,
            tokenHash: hashToken(token),
            clientName: clientName.trim().slice(0, 200) || 'MK automation client',
            projectId,
            canvasId,
            status: 'active',
            createdAt,
            expiresAt: new Date(now + idleTimeoutMs).toISOString(),
            lastActivityAt: createdAt,
            idleTimeoutMs,
            ...(trustedClientId ? { trustedClientId } : {}),
        };
        this.sessions.set(sessionId, session);
        return { session, token };
    }
    toSessionResponse(session, token, trustedClientToken) {
        return {
            sessionId: session.sessionId,
            token,
            projectId: session.projectId,
            canvasId: session.canvasId,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
            ...(session.trustedClientId ? { trustedClientId: session.trustedClientId } : {}),
            ...(trustedClientToken ? { trustedClientToken } : {}),
        };
    }
    getSessionRequest(requestId, now = Date.now()) {
        const request = this.sessionRequests.get(requestId);
        if (!request)
            return null;
        if (request.status === 'pending' && Date.parse(request.expiresAt) <= now)
            request.status = 'expired';
        return request;
    }
    authenticateSessionRequest(requestId, requestToken) {
        const request = this.getSessionRequest(requestId);
        if (!request || !tokensEqual(request.requestTokenHash, requestToken))
            return null;
        return request;
    }
    getSessionRequestStatus(requestId, requestToken) {
        const request = this.authenticateSessionRequest(requestId, requestToken);
        if (!request)
            return null;
        if (request.status === 'approved' && request.approvedSession) {
            return { requestId, status: 'approved', session: request.approvedSession };
        }
        if (request.status === 'rejected' || request.status === 'expired')
            return { requestId, status: request.status };
        return {
            requestId,
            status: 'pending',
            clientName: request.clientName,
            createdAt: request.createdAt,
            expiresAt: request.expiresAt,
        };
    }
    listPendingSessionRequests() {
        return Array.from(this.sessionRequests.values())
            .filter((request) => this.getSessionRequest(request.requestId)?.status === 'pending');
    }
    resolveSessionRequest(requestId, decision, scope) {
        const request = this.getSessionRequest(requestId);
        if (!request || request.status !== 'pending')
            return null;
        if (decision === 'reject') {
            request.status = 'rejected';
            return request;
        }
        const trustedClientId = `automation-client-${randomUUID()}`;
        const trustedClientToken = createSecret();
        const createdAt = new Date().toISOString();
        this.trustedClients.set(trustedClientId, {
            trustedClientId,
            clientId: request.clientId,
            tokenHash: hashToken(trustedClientToken),
            clientName: request.clientName,
            projectId: scope.projectId,
            canvasId: scope.canvasId,
            createdAt,
            lastUsedAt: createdAt,
            crossWorkspace: false,
        });
        this.persistSettings();
        const { session, token } = this.createSessionRecord({
            clientName: request.clientName,
            projectId: scope.projectId,
            canvasId: scope.canvasId,
            trustedClientId,
        });
        request.status = 'approved';
        request.approvedSession = this.toSessionResponse(session, token, trustedClientToken);
        return request;
    }
    createTrustedSession({ clientId, trustedClientId, trustedClientToken, projectId, canvasId, }) {
        const trusted = this.trustedClients.get(trustedClientId);
        if (!trusted
            || trusted.clientId !== clientId
            || (!trusted.crossWorkspace && (trusted.projectId !== projectId || trusted.canvasId !== canvasId))
            || !tokensEqual(trusted.tokenHash, trustedClientToken))
            return null;
        trusted.lastUsedAt = new Date().toISOString();
        this.persistSettings();
        const { session, token } = this.createSessionRecord({
            clientName: trusted.clientName,
            projectId,
            canvasId,
            trustedClientId,
        });
        return this.toSessionResponse(session, token);
    }
    listTrustedClients() {
        return Array.from(this.trustedClients.values())
            .map(({ clientId: _clientId, tokenHash: _tokenHash, ...client }) => client)
            .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt));
    }
    revokeTrustedClient(trustedClientId) {
        const trusted = this.trustedClients.get(trustedClientId);
        if (!trusted)
            return false;
        this.trustedClients.delete(trustedClientId);
        this.sessions.forEach((session) => {
            if (session.trustedClientId === trustedClientId)
                session.status = 'stopped';
        });
        this.persistSettings();
        return true;
    }
    setTrustedClientCrossWorkspace(trustedClientId, crossWorkspace) {
        const trusted = this.trustedClients.get(trustedClientId);
        if (!trusted)
            return false;
        trusted.crossWorkspace = crossWorkspace;
        this.persistSettings();
        return true;
    }
    sessionCanAccess(session, projectId, canvasId) {
        if (session.trustedClientId) {
            const trusted = this.trustedClients.get(session.trustedClientId);
            if (!trusted)
                return false;
            return trusted.crossWorkspace || (trusted.projectId === projectId && trusted.canvasId === canvasId);
        }
        return session.projectId === projectId && session.canvasId === canvasId;
    }
    sessionHasCrossWorkspaceAccess(session) {
        return Boolean(session.trustedClientId && this.trustedClients.get(session.trustedClientId)?.crossWorkspace);
    }
    createCanvasTicket({ clientId, projectId, canvasId, origin }) {
        const ticketId = `automation-ticket-${randomUUID()}`;
        const token = createSecret();
        const challenge = createSecret();
        this.canvasTickets.set(ticketId, {
            ticketId,
            tokenHash: hashToken(token),
            challengeHash: hashToken(challenge),
            clientId,
            projectId,
            canvasId,
            origin,
            expiresAt: Date.now() + CANVAS_TICKET_TTL_MS,
        });
        return { ticketId, token, challenge, expiresAt: new Date(Date.now() + CANVAS_TICKET_TTL_MS).toISOString() };
    }
    consumeCanvasTicket(ticketId, token, challenge, origin) {
        const ticket = this.canvasTickets.get(ticketId);
        this.canvasTickets.delete(ticketId);
        if (!ticket || ticket.expiresAt <= Date.now())
            return null;
        if (ticket.origin !== origin || !tokensEqual(ticket.tokenHash, token) || !tokensEqual(ticket.challengeHash, challenge))
            return null;
        return ticket;
    }
    createSession(clientName = 'MK automation client', ttlMs = defaultAutomationApprovalPolicy.sessionIdleTimeoutMs, scope = { projectId: 'project-1', canvasId: 'canvas-1' }) {
        const sessionId = `automation-${randomUUID()}`;
        const token = createSecret();
        const createdAt = new Date();
        const session = {
            sessionId,
            tokenHash: hashToken(token),
            clientName: clientName.trim().slice(0, 200) || 'MK automation client',
            projectId: scope.projectId,
            canvasId: scope.canvasId,
            status: 'active',
            createdAt: createdAt.toISOString(),
            expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
            lastActivityAt: createdAt.toISOString(),
            idleTimeoutMs: ttlMs,
        };
        this.sessions.set(sessionId, session);
        return {
            sessionId,
            token,
            projectId: session.projectId,
            canvasId: session.canvasId,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
        };
    }
    authenticate(sessionId, token) {
        const session = this.sessions.get(sessionId);
        if (!session || session.status !== 'active')
            return null;
        if (Date.parse(session.expiresAt) <= Date.now()) {
            session.status = 'expired';
            return null;
        }
        if (!tokensEqual(session.tokenHash, token))
            return null;
        const now = new Date();
        session.lastActivityAt = now.toISOString();
        session.idleTimeoutMs = this.sessionIdleTimeoutMs;
        session.expiresAt = new Date(now.getTime() + session.idleTimeoutMs).toISOString();
        if (session.trustedClientId) {
            const trusted = this.trustedClients.get(session.trustedClientId);
            if (trusted)
                trusted.lastUsedAt = session.lastActivityAt;
        }
        return session;
    }
    getSession(sessionId) {
        return this.sessions.get(sessionId) ?? null;
    }
    stopSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return false;
        session.status = 'stopped';
        return true;
    }
    createCommand(command) {
        const existing = this.commands.get(command.commandId);
        if (existing)
            return { record: existing, created: false };
        const timestamp = new Date().toISOString();
        const record = {
            commandId: command.commandId,
            sessionId: command.sessionId,
            command,
            risk: automationCommandDefinitions[command.type].risk,
            status: 'received',
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        this.commands.set(command.commandId, record);
        return { record, created: true };
    }
    getCommand(commandId) {
        return this.commands.get(commandId) ?? null;
    }
    listCommands(status) {
        return Array.from(this.commands.values())
            .filter((record) => !status || record.status === status)
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }
    updateCommand(commandId, patch) {
        const record = this.commands.get(commandId);
        if (!record)
            return null;
        if (patch.status)
            record.status = patch.status;
        if (patch.result)
            record.result = patch.result;
        record.updatedAt = new Date().toISOString();
        return record;
    }
    sweep(now = Date.now()) {
        this.sessions.forEach((session, id) => {
            if (session.status === 'active' && Date.parse(session.expiresAt) <= now)
                session.status = 'expired';
            if (session.status !== 'active' && Date.parse(session.expiresAt) + SESSION_REQUEST_TTL_MS <= now)
                this.sessions.delete(id);
        });
        this.sessionRequests.forEach((request, id) => {
            if (Date.parse(request.expiresAt) + SESSION_REQUEST_TTL_MS <= now)
                this.sessionRequests.delete(id);
        });
        this.canvasTickets.forEach((ticket, id) => {
            if (ticket.expiresAt <= now)
                this.canvasTickets.delete(id);
        });
    }
}
