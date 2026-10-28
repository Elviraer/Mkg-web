import { automationCommandTypes, automationCommandDefinitions, automationSessionIdleTimeoutOptions, defaultAutomationApprovalPolicy, } from '@ftv/shared';
import { WebSocket, WebSocketServer } from 'ws';
const send = (socket, message) => {
    if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
};
const createGatewayResult = (record, status, code, message, graphRevision) => ({
    ok: false,
    commandId: record.commandId,
    projectId: record.command.projectId,
    canvasId: record.command.canvasId,
    status,
    ...(graphRevision !== undefined ? { graphRevision } : {}),
    error: { code, message },
});
const normalizeApprovalPolicy = (value) => {
    if (!value || typeof value !== 'object')
        return structuredClone(defaultAutomationApprovalPolicy);
    const candidate = value;
    const risks = { ...defaultAutomationApprovalPolicy.risks };
    for (const risk of Object.keys(risks)) {
        if (candidate.risks?.[risk] === 'allow' || candidate.risks?.[risk] === 'approval') {
            risks[risk] = candidate.risks[risk];
        }
    }
    const commands = {};
    automationCommandTypes.forEach((type) => {
        const mode = candidate.commands?.[type];
        if (mode === 'allow' || mode === 'approval')
            commands[type] = mode;
    });
    const sessionIdleTimeoutMs = automationSessionIdleTimeoutOptions.includes(candidate.sessionIdleTimeoutMs)
        ? candidate.sessionIdleTimeoutMs
        : defaultAutomationApprovalPolicy.sessionIdleTimeoutMs;
    return { risks, commands, sessionIdleTimeoutMs };
};
export function attachAutomationGateway(server, store) {
    const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    const clientsByProject = new Map();
    const clientBySocket = new Map();
    const commandTimeouts = new Map();
    const authBySocket = new Map();
    const finishCommand = (commandId, result) => {
        const timeout = commandTimeouts.get(commandId);
        if (timeout)
            clearTimeout(timeout);
        commandTimeouts.delete(commandId);
        store.updateCommand(commandId, {
            status: result.ok
                ? 'completed'
                : result.status === 'cancelled'
                    ? 'cancelled'
                    : result.status === 'rejected'
                        ? 'rejected'
                        : 'failed',
            result,
        });
    };
    const sendApprovalRequest = (client, record) => {
        send(client.socket, {
            type: 'approval.request',
            approval: {
                commandId: record.commandId,
                commandType: record.command.type,
                risk: record.risk,
                projectId: record.command.projectId,
                canvasId: record.command.canvasId,
                payload: record.command.payload,
                createdAt: record.createdAt,
            },
        });
    };
    const sendTrustedClients = (client) => {
        send(client.socket, {
            type: 'trusted-clients.updated',
            clients: store.listTrustedClients(),
        });
    };
    const broadcastTrustedClients = () => clientsByProject.forEach(sendTrustedClients);
    const dispatch = (commandId, approved = false) => {
        const record = store.getCommand(commandId);
        if (!record)
            return null;
        if (record.status === 'completed' || record.status === 'running')
            return record;
        const client = clientsByProject.get(record.command.projectId);
        const permission = client?.approvalPolicy.commands[record.command.type]
            ?? client?.approvalPolicy.risks[record.risk]
            ?? defaultAutomationApprovalPolicy.risks[record.risk];
        if (!approved && permission === 'approval') {
            const waiting = store.updateCommand(commandId, { status: 'waiting_approval' });
            const approvalClient = clientsByProject.get(record.command.projectId);
            if (approvalClient && approvalClient.canvasId === record.command.canvasId) {
                sendApprovalRequest(approvalClient, record);
            }
            return waiting;
        }
        if (!client || client.socket.readyState !== WebSocket.OPEN || client.canvasId !== record.command.canvasId) {
            const result = createGatewayResult(record, 'canvas_unavailable', 'canvas_unavailable', '目标画布没有活动 Web 客户端');
            finishCommand(commandId, result);
            return store.getCommand(commandId);
        }
        const definition = automationCommandDefinitions[record.command.type];
        if (definition.risk !== 'read'
            && record.command.expectedGraphRevision !== undefined
            && record.command.expectedGraphRevision !== client.graphRevision) {
            const result = createGatewayResult(record, 'version_conflict', 'graph_revision_conflict', '画布 Revision 已变化，请重新读取', client.graphRevision);
            finishCommand(commandId, result);
            return store.getCommand(commandId);
        }
        store.updateCommand(commandId, { status: 'running' });
        send(client.socket, { type: 'command.execute', command: record.command });
        commandTimeouts.set(commandId, setTimeout(() => {
            finishCommand(commandId, createGatewayResult(record, 'timeout', 'command_timeout', '命令执行超时', client.graphRevision));
        }, definition.timeoutMs));
        return store.getCommand(commandId);
    };
    const handleClientMessage = (socket, message) => {
        const auth = authBySocket.get(socket);
        if (!auth) {
            socket.close(4003, 'authentication required');
            return;
        }
        if (message.type === 'client.register') {
            if (message.clientId !== auth.clientId
                || message.projectId !== auth.projectId
                || message.canvasId !== auth.canvasId) {
                socket.close(4003, 'ticket scope mismatch');
                return;
            }
            const existing = clientsByProject.get(message.projectId);
            if (existing && existing.socket !== socket && existing.clientId !== message.clientId) {
                socket.close(4001, 'active canvas already registered');
                return;
            }
            if (existing && existing.socket !== socket)
                existing.socket.close(4001, 'replaced');
            const client = {
                socket,
                clientId: message.clientId,
                projectId: message.projectId,
                canvasId: message.canvasId,
                graphRevision: message.graphRevision,
                lastSeenAt: Date.now(),
                approvalPolicy: normalizeApprovalPolicy(message.approvalPolicy),
            };
            store.setSessionIdleTimeoutMs(client.approvalPolicy.sessionIdleTimeoutMs);
            clientsByProject.set(message.projectId, client);
            clientBySocket.set(socket, client);
            send(socket, { type: 'ready', clientId: message.clientId });
            store.listCommands('waiting_approval')
                .filter((record) => record.command.projectId === client.projectId && record.command.canvasId === client.canvasId)
                .forEach((record) => sendApprovalRequest(client, record));
            store.listPendingSessionRequests().forEach((request) => send(socket, {
                type: 'session.request',
                request: {
                    requestId: request.requestId,
                    clientName: request.clientName,
                    createdAt: request.createdAt,
                    expiresAt: request.expiresAt,
                },
            }));
            sendTrustedClients(client);
            return;
        }
        const client = clientBySocket.get(socket);
        if (!client) {
            send(socket, { type: 'error', code: 'client_not_registered', message: '请先注册活动画布客户端' });
            return;
        }
        client.lastSeenAt = Date.now();
        if (message.type === 'client.policy') {
            client.approvalPolicy = normalizeApprovalPolicy(message.approvalPolicy);
            store.setSessionIdleTimeoutMs(client.approvalPolicy.sessionIdleTimeoutMs);
            return;
        }
        if (message.type === 'client.state') {
            if (message.projectId === client.projectId && message.canvasId === auth.canvasId) {
                client.canvasId = message.canvasId;
                client.graphRevision = message.graphRevision;
            }
            else {
                socket.close(4003, 'ticket scope mismatch');
            }
            return;
        }
        if (message.type === 'session.resolve') {
            const request = store.resolveSessionRequest(message.requestId, message.decision, {
                projectId: client.projectId,
                canvasId: client.canvasId,
            });
            if (!request)
                return;
            console.info('[MK automation session decision]', JSON.stringify({
                requestId: message.requestId,
                decision: message.decision,
                projectId: client.projectId,
                canvasId: client.canvasId,
            }));
            clientsByProject.forEach((active) => send(active.socket, { type: 'session.resolved', requestId: message.requestId }));
            return;
        }
        if (message.type === 'trusted-client.revoke') {
            if (store.revokeTrustedClient(message.trustedClientId))
                broadcastTrustedClients();
            return;
        }
        if (message.type === 'trusted-client.scope') {
            if (store.setTrustedClientCrossWorkspace(message.trustedClientId, message.crossWorkspace)) {
                broadcastTrustedClients();
            }
            return;
        }
        if (message.type === 'command.result') {
            const record = store.getCommand(message.result.commandId);
            if (!record || record.command.projectId !== client.projectId || record.command.canvasId !== client.canvasId)
                return;
            client.graphRevision = message.result.graphRevision ?? client.graphRevision;
            finishCommand(record.commandId, message.result);
            return;
        }
        if (message.type === 'approval.resolve') {
            const record = store.getCommand(message.commandId);
            if (!record
                || record.status !== 'waiting_approval'
                || record.command.projectId !== client.projectId
                || record.command.canvasId !== client.canvasId)
                return;
            if (message.decision === 'approve') {
                dispatch(record.commandId, true);
                return;
            }
            finishCommand(record.commandId, createGatewayResult(record, 'rejected', 'approval_rejected', 'MK 用户拒绝了该命令', client.graphRevision));
        }
    };
    websocketServer.on('connection', (socket) => {
        socket.on('message', (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            }
            catch {
                send(socket, { type: 'error', code: 'invalid_json', message: '消息不是有效 JSON' });
                return;
            }
            if (!message || typeof message !== 'object' || typeof message.type !== 'string')
                return;
            handleClientMessage(socket, message);
        });
        socket.on('close', () => {
            const client = clientBySocket.get(socket);
            clientBySocket.delete(socket);
            authBySocket.delete(socket);
            if (client && clientsByProject.get(client.projectId)?.socket === socket) {
                clientsByProject.delete(client.projectId);
            }
        });
    });
    const notifySessionRequest = (request) => {
        clientsByProject.forEach((client) => send(client.socket, { type: 'session.request', request }));
    };
    const handleUpgrade = (request, socket, head) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname !== '/ws/automation')
            return;
        const origin = request.headers.origin;
        const protocolVersion = url.searchParams.get('protocolVersion');
        const ticketId = url.searchParams.get('ticketId') ?? '';
        const token = url.searchParams.get('token') ?? '';
        const challenge = url.searchParams.get('challenge') ?? '';
        if (!origin || protocolVersion !== '1') {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        const auth = store.consumeCanvasTicket(ticketId, token, challenge, origin);
        if (!auth) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        websocketServer.handleUpgrade(request, socket, head, (websocket) => {
            authBySocket.set(websocket, auth);
            websocketServer.emit('connection', websocket, request);
        });
    };
    server.on('upgrade', handleUpgrade);
    return {
        dispatch,
        getActiveClient(projectId) {
            const client = clientsByProject.get(projectId);
            return client ? {
                clientId: client.clientId,
                projectId: client.projectId,
                canvasId: client.canvasId,
                graphRevision: client.graphRevision,
                connected: client.socket.readyState === WebSocket.OPEN,
            } : null;
        },
        listActiveClients() {
            return Array.from(clientsByProject.values()).map((client) => ({
                clientId: client.clientId,
                projectId: client.projectId,
                canvasId: client.canvasId,
                graphRevision: client.graphRevision,
                connected: client.socket.readyState === WebSocket.OPEN,
            }));
        },
        close() {
            server.off('upgrade', handleUpgrade);
            commandTimeouts.forEach(clearTimeout);
            commandTimeouts.clear();
            clientsByProject.forEach((client) => client.socket.close(1001, 'server shutdown'));
            clientsByProject.clear();
            clientBySocket.clear();
            authBySocket.clear();
            websocketServer.close();
        },
        notifySessionRequest,
    };
}
