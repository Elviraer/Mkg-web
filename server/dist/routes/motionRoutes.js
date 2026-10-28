import { Router } from 'express';
import { getErrorMessage } from '../unknownJson.js';
const isLoopbackRequest = (request) => {
    const address = request.socket.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
};
export const createMotionRoutes = (store, _options) => {
    const router = Router();
    router.use('/motion', (request, response, next) => {
        if (!isLoopbackRequest(request)) {
            response.status(403).json({ ok: false, message: 'Motion 任务仅允许本机访问' });
            return;
        }
        next();
    });
    router.get('/motion/capabilities', (_request, response) => response.json({ ok: true, ...store.getCapabilities() }));
    router.get('/motion/jobs', (_request, response) => response.json({ ok: true, items: store.listJobs() }));
    router.get('/motion/jobs/:id', (request, response) => {
        const job = store.getJob(request.params.id);
        if (!job)
            return response.status(404).json({ ok: false, message: 'Motion 任务不存在' });
        response.json({ ok: true, job });
    });
    router.post('/motion/jobs', (request, response) => {
        try {
            response.status(202).json({ ok: true, job: store.createJob(request.body) });
        }
        catch (error) {
            response.status(400).json({ ok: false, message: getErrorMessage(error, '创建 Motion 任务失败') });
        }
    });
    router.post('/motion/imports', (_request, response) => {
        response.status(410).json({
            ok: false,
            message: 'Mixamo 动作导入与白模转换已退役，请使用 Epic 官方动作预设',
        });
    });
    router.post('/motion/jobs/:id/cancel', (request, response) => {
        const job = store.cancelJob(request.params.id);
        if (!job)
            return response.status(404).json({ ok: false, message: 'Motion 任务不存在' });
        response.json({ ok: true, job });
    });
    router.get('/motion/assets', (request, response) => {
        const projectId = typeof request.query.projectId === 'string' && request.query.projectId.trim()
            ? request.query.projectId.trim().slice(0, 160) : undefined;
        response.json({ ok: true, items: store.listAssets(projectId) });
    });
    router.get('/motion/assets/:id', (request, response) => {
        const asset = store.getAsset(request.params.id);
        if (!asset)
            return response.status(404).json({ ok: false, message: 'Motion Asset 不存在' });
        response.json({ ok: true, asset });
    });
    router.delete('/motion/assets/:id', (request, response) => {
        const projectId = typeof request.body?.projectId === 'string' && request.body.projectId.trim()
            ? request.body.projectId.trim().slice(0, 160) : undefined;
        try {
            const asset = store.deleteAsset(request.params.id, projectId);
            if (!asset)
                return response.status(404).json({ ok: false, message: 'Motion Asset 不存在' });
            response.json({ ok: true, assetId: asset.id });
        }
        catch (error) {
            response.status(400).json({ ok: false, message: getErrorMessage(error, '删除 Motion Asset 失败') });
        }
    });
    router.get('/motion/assets/:id/files/:kind', (request, response) => {
        const kind = request.params.kind === 'soma' || request.params.kind === 'skeleton'
            || request.params.kind === 'ue4' || request.params.kind === 'source' ? request.params.kind : null;
        if (!kind)
            return response.status(404).end();
        const filePath = store.getAssetFile(request.params.id, kind);
        if (!filePath)
            return response.status(404).end();
        const fileName = kind === 'soma' ? 'soma.npz' : kind === 'skeleton' ? 'skeleton.json'
            : kind === 'ue4' ? 'animation.glb' : undefined;
        if (fileName)
            response.download(filePath, fileName);
        else
            response.download(filePath);
    });
    return router;
};
