import fs from 'fs';
import multer from 'multer';
import { Router } from 'express';
import { isSupportedPhotoshopImageMime } from '../photoshopJobStore.js';
import { getErrorMessage } from '../unknownJson.js';
const isLoopbackRequest = (request) => {
    const address = request.socket.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
};
const readBearerToken = (request) => {
    const authorization = request.header('authorization') ?? '';
    return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
};
const readJobId = (request) => {
    const value = request.params.jobId;
    if (typeof value !== 'string' || !value)
        throw new Error('缺少 Photoshop 任务 ID');
    return value;
};
export const createPhotoshopRoutes = ({ store, maxFileSize = 50 * 1024 * 1024 }) => {
    const router = Router();
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: maxFileSize, files: 1 }
    });
    router.use('/photoshop', (request, response, next) => {
        if (!isLoopbackRequest(request)) {
            response.status(403).json({ ok: false, message: 'Photoshop 往返仅允许本机访问' });
            return;
        }
        next();
    });
    router.post('/photoshop/heartbeat', (request, response) => {
        const role = request.body && typeof request.body.role === 'string' ? request.body.role : 'web';
        const status = role === 'uxp' ? store.recordPluginHeartbeat() : store.getPluginStatus();
        response.json({ ok: true, ...status });
    });
    router.post('/photoshop/jobs', upload.single('file'), (request, response) => {
        try {
            const sourceNodeId = typeof request.body?.sourceNodeId === 'string' ? request.body.sourceNodeId : '';
            const projectId = typeof request.body?.projectId === 'string' ? request.body.projectId : '';
            const canvasId = typeof request.body?.canvasId === 'string' ? request.body.canvasId : '';
            if (!request.file)
                throw new Error('缺少 Photoshop 源图');
            if (!isSupportedPhotoshopImageMime(request.file.mimetype)) {
                throw new Error('Photoshop 仅支持 PNG、JPEG、WebP 或 GIF 图片');
            }
            const result = store.createJob({
                sourceNodeId,
                sourceBuffer: request.file.buffer,
                sourceMime: request.file.mimetype,
                projectId,
                canvasId
            });
            response.status(201).json({ ok: true, ...result.job, token: result.token });
        }
        catch (error) {
            response.status(400).json({ ok: false, message: getErrorMessage(error, '创建 Photoshop 任务失败') });
        }
    });
    router.get('/photoshop/jobs/next', (_request, response) => {
        const result = store.claimNextJob();
        if (!result) {
            response.status(204).end();
            return;
        }
        response.json({
            ok: true,
            ...result.job,
            token: result.token,
            sourceMime: result.sourceMime,
            sourceUrl: `/api/photoshop/jobs/${result.job.jobId}/source`
        });
    });
    router.get('/photoshop/jobs/:jobId', (request, response) => {
        try {
            response.json({ ok: true, ...store.getJob(readJobId(request), readBearerToken(request)) });
        }
        catch (error) {
            response.status(404).json({ ok: false, message: getErrorMessage(error, '读取 Photoshop 任务失败') });
        }
    });
    router.get('/photoshop/jobs/:jobId/source', (request, response) => {
        try {
            const source = store.getSource(readJobId(request), readBearerToken(request));
            response.type(source.mime);
            response.send(fs.readFileSync(source.filePath));
        }
        catch (error) {
            response.status(404).json({ ok: false, message: getErrorMessage(error, '读取 Photoshop 源图失败') });
        }
    });
    router.post('/photoshop/jobs/:jobId/result', upload.single('file'), async (request, response) => {
        const token = readBearerToken(request);
        let jobId = '';
        try {
            jobId = readJobId(request);
            if (!request.file)
                throw new Error('缺少 Photoshop 回传图片');
            if (request.file.mimetype !== 'image/png')
                throw new Error('Photoshop 回传仅支持扁平 PNG');
            store.beginUpload(jobId, token);
            response.json({ ok: true, ...await store.completeJob(jobId, token, request.file.buffer) });
        }
        catch (error) {
            try {
                if (jobId)
                    store.failUpload(jobId, token, getErrorMessage(error, 'Photoshop 回传失败'));
            }
            catch {
                // Preserve the original upload error when the job/token is also invalid.
            }
            response.status(400).json({ ok: false, message: getErrorMessage(error, 'Photoshop 回传失败') });
        }
    });
    router.post('/photoshop/jobs/:jobId/cancel', (request, response) => {
        try {
            response.json({ ok: true, ...store.cancelJob(readJobId(request), readBearerToken(request)) });
        }
        catch (error) {
            response.status(400).json({ ok: false, message: getErrorMessage(error, '取消 Photoshop 任务失败') });
        }
    });
    router.use((error, _request, response, next) => {
        if (error instanceof multer.MulterError) {
            response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
                ok: false,
                message: error.code === 'LIMIT_FILE_SIZE' ? 'Photoshop 图片超过 50MB 限制' : 'Photoshop 图片上传失败'
            });
            return;
        }
        next(error);
    });
    return router;
};
