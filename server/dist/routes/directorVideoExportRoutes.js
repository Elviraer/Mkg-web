import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { getErrorMessage } from '../unknownJson.js';
const isLoopback = (request) => {
    const address = request.socket.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
};
export const createDirectorVideoExportRoutes = (store) => {
    const router = Router();
    const upload = multer({
        storage: multer.diskStorage({
            destination: store.getPreviewUploadDirectory(),
            filename: (_request, _file, callback) => callback(null, `preview-${crypto.randomUUID()}.webm`)
        }),
        limits: { files: 1, fileSize: 512 * 1024 * 1024 },
        fileFilter: (_request, file, callback) => callback(null, ['video/webm', 'video/mp4', 'application/octet-stream'].includes(file.mimetype))
    });
    router.use('/director-video', (request, response, next) => {
        if (!isLoopback(request))
            return response.status(403).json({ ok: false, message: '导演台视频导出仅允许本机访问' });
        next();
    });
    router.get('/director-video/status', (_request, response) => response.json({ ok: true, ...store.getStatus() }));
    router.get('/director-video/jobs', (_request, response) => response.json({ ok: true, items: store.listJobs() }));
    router.get('/director-video/jobs/:id', (request, response) => {
        const job = store.getJob(request.params.id);
        if (!job)
            return response.status(404).json({ ok: false, message: '视频导出任务不存在' });
        response.json({ ok: true, job });
    });
    router.post('/director-video/jobs', (request, response) => {
        try {
            const projectId = typeof request.body?.projectId === 'string' ? request.body.projectId : '';
            const canvasId = typeof request.body?.canvasId === 'string' ? request.body.canvasId : '';
            response.status(202).json({
                ok: true,
                job: store.createJob(request.body?.snapshot, request.body?.aspectRatio, request.body?.settings, { projectId, canvasId })
            });
        }
        catch (error) {
            response.status(400).json({ ok: false, message: getErrorMessage(error, '创建视频导出任务失败') });
        }
    });
    router.post('/director-video/preview-jobs', upload.single('file'), (request, response) => {
        if (!request.file)
            return response.status(400).json({ ok: false, message: '缺少视口录制文件' });
        try {
            const settings = typeof request.body?.settings === 'string'
                ? JSON.parse(request.body.settings)
                : request.body?.settings;
            response.status(202).json({
                ok: true,
                job: store.createPreviewJob(request.file.path, request.body?.aspectRatio, settings, request.body?.durationFrames, {
                    projectId: typeof request.body?.projectId === 'string' ? request.body.projectId : '',
                    canvasId: typeof request.body?.canvasId === 'string' ? request.body.canvasId : ''
                })
            });
        }
        catch (error) {
            fs.rmSync(path.resolve(request.file.path), { force: true });
            response.status(400).json({ ok: false, message: getErrorMessage(error, '创建视口视频导出任务失败') });
        }
    });
    router.post('/director-video/jobs/:id/cancel', (request, response) => {
        const job = store.cancelJob(request.params.id);
        if (!job)
            return response.status(404).json({ ok: false, message: '视频导出任务不存在' });
        response.json({ ok: true, job });
    });
    router.use((error, _request, response, next) => {
        if (!(error instanceof multer.MulterError))
            return next(error);
        response.status(400).json({ ok: false, message: error.code === 'LIMIT_FILE_SIZE' ? '视口录制文件超过 512MB' : '视口录制上传失败' });
    });
    return router;
};
