import { isDirectorRemoteSignal } from '@mkg/shared';
import { WebSocket, WebSocketServer } from 'ws';
function send(socket, message) {
    if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
}
export function attachDirectorRemoteGateway(server, store) {
    const webSocketServer = new WebSocketServer({ noServer: true });
    const peers = new Map();
    const registerConnection = (socket, auth) => {
        const { sessionId, role } = auth;
        const currentPeers = peers.get(sessionId) ?? {};
        currentPeers[role]?.close(4001, 'Replaced by a newer connection');
        currentPeers[role] = socket;
        peers.set(sessionId, currentPeers);
        store.setConnected(sessionId, role, true);
        const session = store.getActive(sessionId);
        if (!session)
            return socket.close(4004, 'Session expired');
        send(socket, { type: 'ready', role, status: session.status });
        if (role === 'mobile' && session.status === 'paired') {
            send(currentPeers.desktop, { type: 'pair-accepted' });
        }
        socket.on('message', (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            }
            catch {
                send(socket, { type: 'error', code: 'invalid-json', message: 'Invalid realtime message' });
                return;
            }
            if (!isDirectorRemoteSignal(message))
                return;
            store.touch(sessionId);
            const peer = peers.get(sessionId);
            const targetRole = role === 'desktop' ? 'mobile' : 'desktop';
            if (message.type === 'heartbeat')
                return;
            const activeSession = store.getActive(sessionId);
            if (!activeSession || activeSession.status !== 'paired') {
                send(socket, { type: 'error', code: 'not-paired', message: 'Remote controller is not paired' });
                return;
            }
            send(peer?.[targetRole], message);
        });
        socket.on('close', () => {
            const current = peers.get(sessionId);
            if (current?.[role] === socket)
                delete current[role];
            store.setConnected(sessionId, role, false);
            const targetRole = role === 'desktop' ? 'mobile' : 'desktop';
            send(current?.[targetRole], { type: 'disconnect', reason: 'Peer disconnected' });
            if (!current?.desktop && !current?.mobile)
                peers.delete(sessionId);
        });
    };
    server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname !== '/ws/director-remote')
            return;
        const sessionId = url.searchParams.get('session') ?? '';
        const role = url.searchParams.get('role') === 'mobile' ? 'mobile' : 'desktop';
        const token = url.searchParams.get('token') ?? '';
        if (!store.authenticate(sessionId, role, token)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
            registerConnection(webSocket, { sessionId, role });
        });
    });
    return {
        close: () => webSocketServer.close(),
    };
}
