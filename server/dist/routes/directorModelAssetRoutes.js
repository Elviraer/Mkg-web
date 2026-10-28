import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
export const createDirectorModelAssetRoutes = ({ store, uploadsDir, maxUploadBytes = 512 * 1024 * 1024 }) => {
    const router = Router();
    fs.mkdirSync(uploadsDir, { recursive: true });
    const upload = multer({
        storage: multer.diskStorage({
            destination: (_request, _file, callback) => callback(null, uploadsDir),
            filename: (_request, _file, callback) => callback(null, `.director-model-upload-${crypto.randomUUID()}`)
        }),
        limits: { fileSize: maxUploadBytes, files: 1 }
    });
    router.post('/director-model-assets/upload', upload.single('file'), async (request, response) => {
        if (!request.file) {
            response.status(400).json({ ok: false, message: '缺少模型文件' });
            return;
        }
        try {
            const result = await store.importFile(request.file.path, request.file.originalname, {
                retained: request.body?.retained !== 'false'
            });
            response.status(result.deduplicated ? 200 : 201).json({ ok: true, ...result });
        }
        catch (error) {
            fs.rmSync(request.file.path, { force: true });
            response.status(415).json({ ok: false, message: error instanceof Error ? error.message : '模型导入失败' });
        }
    });
    router.get('/director-model-assets/:id/file', (request, response) => {
        const asset = store.getFile(request.params.id);
        if (!asset) {
            response.status(404).json({ ok: false, message: '导演台模型不存在' });
            return;
        }
        response.type(asset.mimeType);
        response.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`);
        response.sendFile(path.resolve(asset.sourcePath));
    });
    router.delete('/director-model-assets', (request, response) => {
        const ids = Array.isArray(request.body?.ids)
            ? Array.from(new Set(request.body.ids.filter((id) => typeof id === 'string'))).slice(0, 100)
            : [];
        if (ids.length === 0) {
            response.status(400).json({ ok: false, message: 'ids are required' });
            return;
        }
        response.json({ ok: true, ...store.delete(ids) });
    });
    const handleUploadError = (error, _request, response, next) => {
        if (!(error instanceof multer.MulterError)) {
            next(error);
            return;
        }
        response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
            ok: false,
            message: error.code === 'LIMIT_FILE_SIZE' ? '模型文件超过大小限制' : '模型上传请求无效'
        });
    };
    router.use(handleUploadError);
    return router;
};
