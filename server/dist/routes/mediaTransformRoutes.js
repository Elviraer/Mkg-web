import { Router } from 'express';
import { getErrorMessage } from '../unknownJson.js';
const isLoopback = (request) => {
    const address = request.socket.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
};
export const createMediaTransformRoutes = (store) => {
    const router = Router();
    router.use('/media-transforms', (request, response, next) => {
        if (!isLoopback(request))
            return response.status(403).json({ ok: false, message: '媒体转换仅允许本机访问' });
        next();
    });
    router.get('/media-transforms/capabilities', (request, response) => {
        // The capability probe spawns FFmpeg/FFprobe/Python workers, so it is cached; `refresh=1` is an
        // explicit user action ("重新检测") after installing a prerequisite at runtime.
        const refresh = request.query.refresh === '1' || request.query.refresh === 'true';
        response.json({ ok: true, ...store.getCapabilities(refresh ? { refresh: true } : undefined) });
    });
    router.get('/media-transforms/jobs', (request, response) => {
        const projectId = typeof request.query.projectId === 'string' ? request.query.projectId : undefined;
        const canvasId = typeof request.query.canvasId === 'string' ? request.query.canvasId : undefined;
        response.json({
            ok: true,
            items: store.listJobs({
                ...(projectId ? { projectId } : {}),
                ...(canvasId ? { canvasId } : {})
            })
        });
    });
    router.get('/media-transforms/jobs/:id', (request, response) => {
        const job = store.getJob(request.params.id);
        if (!job)
            return response.status(404).json({ ok: false, message: '媒体转换任务不存在' });
        response.json({ ok: true, job });
    });
    router.get('/media-transforms/jobs/:id/timeline-preview/:index', (request, response) => {
        const index = Number.parseInt(request.params.index, 10);
        const previewPath = store.getScenePreviewPath(request.params.id, index);
        if (!previewPath)
            return response.status(404).json({ ok: false, message: '时间线缩略图不存在' });
        response.type('image/webp');
        response.sendFile(previewPath);
    });
    router.get('/media-transforms/jobs/:id/timeline-scrub-proxy', (request, response) => {
        const proxyPath = store.getSceneScrubProxyPath(request.params.id);
        if (!proxyPath)
            return response.status(404).json({ ok: false, message: '时间线拖动代理不存在' });
        response.type('video/mp4');
        response.sendFile(proxyPath);
    });
    router.post('/media-transforms/jobs', (request, response) => {
        try {
            response.status(202).json({ ok: true, job: store.createJob(request.body) });
        }
        catch (error) {
            response.status(400).json({ ok: false, message: getErrorMessage(error, '创建媒体转换任务失败') });
        }
    });
    router.post('/media-transforms/jobs/:id/cancel', (request, response) => {
        const job = store.cancelJob(request.params.id);
        if (!job)
            return response.status(404).json({ ok: false, message: '媒体转换任务不存在' });
        response.json({ ok: true, job });
    });
    return router;
};
