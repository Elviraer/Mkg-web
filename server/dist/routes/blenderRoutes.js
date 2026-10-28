import { Router } from 'express';
import { getErrorMessage } from '../unknownJson.js';
const isLoopbackRequest = (request) => {
    const address = request.socket.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
};
export const createBlenderRoutes = (store) => {
    const router = Router();
    router.use('/blender', (request, response, next) => {
        if (!isLoopbackRequest(request)) {
            response.status(403).json({ ok: false, message: 'Blender 任务仅允许本机访问' });
            return;
        }
        next();
    });
    router.get('/blender/status', (_request, response) => response.json({ ok: true, ...store.getStatus() }));
    router.get('/blender/jobs', (_request, response) => response.json({ ok: true, items: store.listJobs() }));
    router.get('/blender/jobs/:id', (request, response) => {
        const job = store.getJob(request.params.id);
        if (!job)
            return response.status(404).json({ ok: false, message: 'Blender 任务不存在' });
        response.json({ ok: true, job });
    });
    router.post('/blender/jobs', (request, response) => {
        try {
            const snapshot = request.body?.snapshot;
            const projectId = typeof request.body?.projectId === 'string' ? request.body.projectId : '';
            const canvasId = typeof request.body?.canvasId === 'string' ? request.body.canvasId : '';
            if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
                throw new Error('缺少导演台场景快照');
            response.status(202).json({ ok: true, job: store.createJob(snapshot, { projectId, canvasId }) });
        }
        catch (error) {
            response.status(400).json({ ok: false, message: getErrorMessage(error, '创建 Blender 任务失败') });
        }
    });
    router.post('/blender/jobs/:id/cancel', (request, response) => {
        const job = store.cancelJob(request.params.id);
        if (!job)
            return response.status(404).json({ ok: false, message: 'Blender 任务不存在' });
        response.json({ ok: true, job });
    });
    router.get('/blender/jobs/:id/files/:kind', (request, response) => {
        const kind = request.params.kind === 'render' ? 'render' : request.params.kind === 'glb' ? 'glb' : null;
        if (!kind)
            return response.status(404).end();
        const filePath = store.getOutputPath(request.params.id, kind);
        if (!filePath)
            return response.status(404).end();
        response.download(filePath, kind === 'render' ? 'render.png' : 'scene.glb');
    });
    return router;
};
