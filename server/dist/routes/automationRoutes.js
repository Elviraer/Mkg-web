import { automationCommandDefinitions, parseAutomationCommandEnvelope, } from '@mkg/shared';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
const readBearerToken = (request) => {
    const authorization = request.header('authorization') ?? '';
    return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
};
const readPathParam = (request, name) => {
    const value = request.params[name];
    return typeof value === 'string' ? value : '';
};
export const createAutomationRoutes = ({ gateway, store, }) => {
    const router = Router();
    const sessionRequestRateLimit = rateLimit({
        windowMs: 60000,
        limit: 5,
        standardHeaders: true,
        legacyHeaders: false,
        message: { ok: false, code: 'session_request_rate_limited', message: '自动化会话申请过于频繁' },
    });
    const authenticationFailureRateLimit = rateLimit({
        windowMs: 60000,
        limit: 20,
        skipSuccessfulRequests: true,
        standardHeaders: true,
        legacyHeaders: false,
        message: { ok: false, code: 'automation_auth_rate_limited', message: '自动化鉴权失败次数过多' },
    });
    const canvasTicketRateLimit = rateLimit({
        windowMs: 60000,
        limit: 30,
        standardHeaders: true,
        legacyHeaders: false,
        message: { ok: false, code: 'canvas_ticket_rate_limited', message: '画布连接申请过于频繁' },
    });
    const auditAuthFailure = (request, reason) => {
        console.warn('[MK automation auth failure]', JSON.stringify({
            reason,
            ip: request.ip,
            origin: request.header('origin') ?? null,
            path: request.path,
        }));
    };
    router.post('/automation/sessions', sessionRequestRateLimit, (request, response) => {
        const clientName = typeof request.body?.clientName === 'string' ? request.body.clientName : undefined;
        const clientId = typeof request.body?.clientId === 'string' ? request.body.clientId.trim() : '';
        const trustedClientId = typeof request.body?.trustedClientId === 'string' ? request.body.trustedClientId.trim() : '';
        const trustedClientToken = typeof request.body?.trustedClientToken === 'string' ? request.body.trustedClientToken : '';
        const projectId = typeof request.body?.projectId === 'string' ? request.body.projectId.trim() : '';
        const canvasId = typeof request.body?.canvasId === 'string' ? request.body.canvasId.trim() : '';
        if (clientId && trustedClientId && trustedClientToken && projectId && canvasId) {
            const trustedSession = store.createTrustedSession({
                clientId,
                trustedClientId,
                trustedClientToken,
                projectId,
                canvasId,
            });
            if (trustedSession) {
                response.status(201).json({ ok: true, status: 'approved', session: trustedSession });
                return;
            }
            console.warn('[MK automation trusted client failure]', JSON.stringify({ clientId, trustedClientId }));
        }
        const created = store.createSessionRequest(clientName, Date.now(), {
            ...(clientId ? { clientId } : {}),
            ...(projectId ? { projectId } : {}),
            ...(canvasId ? { canvasId } : {}),
        });
        console.info('[MK automation session request]', JSON.stringify({
            requestId: created.requestId,
            clientName: created.clientName,
            createdAt: created.createdAt,
        }));
        gateway.notifySessionRequest(created);
        response.status(202).json({ ok: true, ...created });
    });
    router.get('/automation/session-requests/:requestId', authenticationFailureRateLimit, (request, response) => {
        const token = readBearerToken(request);
        const status = store.getSessionRequestStatus(readPathParam(request, 'requestId'), token);
        if (!status) {
            auditAuthFailure(request, 'invalid_session_request');
            response.status(401).json({ ok: false, code: 'invalid_session_request', message: '自动化会话申请无效或已过期' });
            return;
        }
        response.status(status.status === 'pending' ? 202 : 200).json({ ok: true, ...status });
    });
    router.get('/automation/sessions/:sessionId', authenticationFailureRateLimit, (request, response) => {
        const session = store.authenticate(readPathParam(request, 'sessionId'), readBearerToken(request));
        if (!session) {
            auditAuthFailure(request, 'invalid_session');
            response.status(401).json({ ok: false, code: 'invalid_session', message: '自动化会话无效或已过期' });
            return;
        }
        response.json({
            ok: true,
            sessionId: session.sessionId,
            clientName: session.clientName,
            projectId: session.projectId,
            canvasId: session.canvasId,
            status: session.status,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
        });
    });
    router.post('/automation/commands', authenticationFailureRateLimit, (request, response) => {
        const parsed = parseAutomationCommandEnvelope(request.body);
        if (!parsed.success) {
            response.status(400).json({
                ok: false,
                code: 'invalid_command',
                message: '命令格式无效',
                issues: parsed.error.issues,
            });
            return;
        }
        const session = store.authenticate(parsed.data.sessionId, readBearerToken(request));
        if (!session) {
            auditAuthFailure(request, 'invalid_session');
            response.status(401).json({ ok: false, code: 'invalid_session', message: '自动化会话无效或已过期' });
            return;
        }
        if (!store.sessionCanAccess(session, parsed.data.projectId, parsed.data.canvasId)) {
            auditAuthFailure(request, 'session_scope_mismatch');
            response.status(403).json({ ok: false, code: 'session_scope_mismatch', message: '会话不能访问当前项目或画布' });
            return;
        }
        const { record, created } = store.createCommand(parsed.data);
        const current = created ? gateway.dispatch(record.commandId) ?? record : record;
        const payload = {
            commandId: current.commandId,
            status: current.status,
            risk: current.risk,
            ...(current.result ? { result: current.result } : {}),
        };
        response.status(created ? 202 : 200).json({ ok: true, ...payload });
    });
    router.get('/automation/commands/:commandId', authenticationFailureRateLimit, (request, response) => {
        const record = store.getCommand(readPathParam(request, 'commandId'));
        if (!record || !store.authenticate(record.sessionId, readBearerToken(request))) {
            auditAuthFailure(request, 'invalid_command_session');
            response.status(404).json({ ok: false, code: 'command_not_found', message: '未找到命令' });
            return;
        }
        response.json({
            ok: true,
            commandId: record.commandId,
            status: record.status,
            risk: record.risk,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            ...(record.result ? { result: record.result } : {}),
        });
    });
    router.post('/automation/commands/:commandId/cancel', authenticationFailureRateLimit, (request, response) => {
        const record = store.getCommand(readPathParam(request, 'commandId'));
        if (!record || !store.authenticate(record.sessionId, readBearerToken(request))) {
            auditAuthFailure(request, 'invalid_command_session');
            response.status(404).json({ ok: false, code: 'command_not_found', message: '未找到命令' });
            return;
        }
        if (['completed', 'failed', 'rejected', 'cancelled'].includes(record.status)) {
            response.status(409).json({ ok: false, code: 'command_already_finished', message: '命令已经结束' });
            return;
        }
        const result = {
            ok: false,
            commandId: record.commandId,
            projectId: record.command.projectId,
            canvasId: record.command.canvasId,
            status: 'cancelled',
            error: { code: 'command_cancelled', message: '命令已取消' },
        };
        store.updateCommand(record.commandId, { status: 'cancelled', result });
        response.json({ ok: true, commandId: record.commandId, status: 'cancelled' });
    });
    router.post('/automation/canvas-tickets', canvasTicketRateLimit, (request, response) => {
        const origin = request.header('origin');
        const clientId = typeof request.body?.clientId === 'string' ? request.body.clientId.trim() : '';
        const projectId = typeof request.body?.projectId === 'string' ? request.body.projectId.trim() : '';
        const canvasId = typeof request.body?.canvasId === 'string' ? request.body.canvasId.trim() : '';
        if (!origin || !clientId || !projectId || !canvasId) {
            response.status(400).json({ ok: false, code: 'canvas_ticket_fields_required', message: 'Origin、clientId、projectId 和 canvasId 必填' });
            return;
        }
        try {
            response.status(201).json({ ok: true, ...store.createCanvasTicket({ clientId, projectId, canvasId, origin: new URL(origin).origin }) });
        }
        catch {
            response.status(400).json({ ok: false, code: 'invalid_origin', message: 'Origin 无效' });
        }
    });
    router.get('/automation/status', authenticationFailureRateLimit, (request, response) => {
        const sessionId = typeof request.query.sessionId === 'string' ? request.query.sessionId : '';
        const session = sessionId ? store.authenticate(sessionId, readBearerToken(request)) : null;
        if (!session) {
            auditAuthFailure(request, 'status_requires_session');
            response.status(401).json({ ok: false, code: 'status_requires_session', message: '状态查询需要有效自动化会话' });
            return;
        }
        const activeClients = store.sessionHasCrossWorkspaceAccess(session)
            ? gateway.listActiveClients()
            : gateway.listActiveClients().filter((client) => (client.projectId === session.projectId && client.canvasId === session.canvasId));
        response.json({
            ok: true,
            service: 'mk-automation-gateway',
            protocolVersion: 1,
            activeClient: activeClients[0] ?? null,
            activeClients,
            commandTypes: Object.values(automationCommandDefinitions),
        });
    });
    return router;
};
