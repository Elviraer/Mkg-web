import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { Router } from 'express';
import { OutboundUrlPolicyError } from '../outboundHttp.js';
import { getErrorMessage } from '../unknownJson.js';
import { deduplicateUploadedFile, deduplicateUploadedVideo } from '../uploadDeduplication.js';
import { applyCanonicalMediaExtension, describeUnsupportedMediaFile, detectMediaFile } from '../mediaFileType.js';
import { RemoteMediaError, streamRemoteMediaResponse } from '../remoteMedia.js';
const DEFAULT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ROLE_ASSET_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_PROVIDER_ASSET_BYTES = 2 * 1024 * 1024;
const providerLogoMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const multerLimits = (fileSize) => ({
    fileSize,
    files: 1,
    fields: 4,
    parts: 5,
    fieldNameSize: 100
});
export const createUploadRoutes = ({ uploadsDir, roleAssetsDir, providerAssetsDir, createRoleThumbnail, maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES, maxRoleAssetBytes = DEFAULT_MAX_ROLE_ASSET_BYTES, maxProviderAssetBytes = DEFAULT_MAX_PROVIDER_ASSET_BYTES }) => {
    const router = Router();
    const storage = multer.diskStorage({
        destination: (_req, _file, cb) => {
            cb(null, uploadsDir);
        },
        filename: (_req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
            cb(null, `${uniqueSuffix}.upload`);
        }
    });
    const upload = multer({ storage, limits: multerLimits(maxUploadBytes) });
    const roleAssetStorage = multer.diskStorage({
        destination: (_req, _file, cb) => {
            cb(null, roleAssetsDir);
        },
        filename: (_req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
            cb(null, `${uniqueSuffix}.upload`);
        }
    });
    const uploadRoleAsset = multer({ storage: roleAssetStorage, limits: multerLimits(maxRoleAssetBytes) });
    const providerAssetStorage = multer.diskStorage({
        destination: (_req, _file, cb) => {
            cb(null, providerAssetsDir);
        },
        filename: (_req, _file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
            cb(null, `${uniqueSuffix}.upload`);
        }
    });
    const uploadProviderAsset = multer({ storage: providerAssetStorage, limits: multerLimits(maxProviderAssetBytes) });
    router.post('/upload', upload.single('file'), async (req, res) => {
        if (!req.file) {
            res.status(400).json({ ok: false, message: 'No file uploaded' });
            return;
        }
        const detected = await detectMediaFile(req.file.path);
        if (!detected) {
            const unsupportedHint = await describeUnsupportedMediaFile(req.file.path);
            fs.rmSync(req.file.path, { force: true });
            res.status(415).json({
                ok: false,
                code: 'unsupported_media_type',
                message: unsupportedHint ?? '文件内容不是受支持的图片、视频或音频'
            });
            return;
        }
        let canonicalFile;
        try {
            canonicalFile = await applyCanonicalMediaExtension(req.file, detected);
        }
        catch (error) {
            fs.rmSync(req.file.path, { force: true });
            res.status(500).json({ ok: false, message: getErrorMessage(error, '上传文件落盘失败') });
            return;
        }
        const originalNameUtf8 = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        let storedFileName = canonicalFile.filename;
        if (detected.kind === 'video') {
            try {
                storedFileName = (await deduplicateUploadedVideo(canonicalFile.path, uploadsDir)).fileName;
            }
            catch (error) {
                fs.rmSync(canonicalFile.path, { force: true });
                res.status(500).json({ ok: false, message: getErrorMessage(error, '视频去重失败') });
                return;
            }
        }
        res.json({
            ok: true,
            fileName: originalNameUtf8,
            previewUrl: `/api/uploads/${storedFileName}`,
            kind: detected.kind
        });
    });
    router.post('/role-assets/upload', uploadRoleAsset.single('file'), async (req, res) => {
        if (!req.file) {
            res.status(400).json({ ok: false, message: 'No file uploaded' });
            return;
        }
        const detected = await detectMediaFile(req.file.path);
        if (detected?.kind !== 'image') {
            fs.rmSync(req.file.path, { force: true });
            res.status(415).json({ ok: false, code: 'unsupported_media_type', message: '角色素材仅支持有效图片文件' });
            return;
        }
        let canonicalFile;
        try {
            canonicalFile = await applyCanonicalMediaExtension(req.file, detected);
        }
        catch (error) {
            fs.rmSync(req.file.path, { force: true });
            res.status(500).json({ ok: false, message: getErrorMessage(error, '角色素材落盘失败') });
            return;
        }
        try {
            const stored = await deduplicateUploadedFile(canonicalFile.path, roleAssetsDir);
            let thumbnailUrl;
            if (createRoleThumbnail) {
                try {
                    thumbnailUrl = (await createRoleThumbnail(stored.filePath, 'image', stored.contentHash)).publicUrl;
                }
                catch {
                    // The original remains usable when an optional thumbnail runtime is unavailable.
                }
            }
            const originalNameUtf8 = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
            res.json({
                ok: true,
                fileName: originalNameUtf8,
                previewUrl: `/api/role-assets/files/${stored.fileName}`,
                ...(thumbnailUrl ? { thumbnailUrl } : {}),
                deduplicated: stored.deduplicated,
                kind: 'image'
            });
        }
        catch (error) {
            fs.rmSync(canonicalFile.path, { force: true });
            res.status(500).json({ ok: false, message: getErrorMessage(error, '角色素材去重失败') });
        }
    });
    router.post('/provider-assets/upload', uploadProviderAsset.single('file'), async (req, res) => {
        if (!req.file) {
            res.status(400).json({ ok: false, message: 'No file uploaded' });
            return;
        }
        const detected = await detectMediaFile(req.file.path);
        if (!detected || !providerLogoMimeTypes.has(detected.mime)) {
            fs.rmSync(req.file.path, { force: true });
            res.status(415).json({
                ok: false,
                code: 'unsupported_media_type',
                message: '供应商 LOGO 仅支持有效 PNG、JPEG 或 WebP 图片'
            });
            return;
        }
        try {
            const canonicalFile = await applyCanonicalMediaExtension(req.file, detected);
            res.json({
                ok: true,
                previewUrl: `/api/provider-assets/files/${canonicalFile.filename}`,
                kind: 'image'
            });
        }
        catch (error) {
            fs.rmSync(req.file.path, { force: true });
            res.status(500).json({ ok: false, message: getErrorMessage(error, '供应商 LOGO 落盘失败') });
        }
    });
    router.delete('/provider-assets/files/:fileName', (req, res) => {
        const fileName = path.basename(req.params.fileName);
        const targetPath = path.resolve(providerAssetsDir, fileName);
        const providerRoot = `${path.resolve(providerAssetsDir)}${path.sep}`;
        if (fileName !== req.params.fileName
            || !/^\d+-\d+\.(?:png|jpe?g|webp)$/i.test(fileName)
            || !targetPath.startsWith(providerRoot)) {
            res.status(400).json({ ok: false, code: 'invalid_provider_asset', message: '供应商 LOGO 文件名无效' });
            return;
        }
        fs.rmSync(targetPath, { force: true });
        res.status(204).end();
    });
    router.get('/download', async (req, res) => {
        const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
        const rawFilename = typeof req.query.filename === 'string' ? req.query.filename : 'download';
        const inline = req.query.inline === '1' || req.query.inline === 'true';
        const filename = path.basename(rawFilename) || 'download';
        if (!/^https?:\/\//i.test(rawUrl)) {
            res.status(400).json({ ok: false, message: '仅支持 http(s) 下载链接' });
            return;
        }
        try {
            await streamRemoteMediaResponse({ url: rawUrl, response: res, filename, inline });
        }
        catch (err) {
            if (res.headersSent) {
                res.destroy(err instanceof Error ? err : undefined);
                return;
            }
            if (err instanceof OutboundUrlPolicyError) {
                res.status(400).json({ ok: false, code: err.code, message: err.message });
                return;
            }
            if (err instanceof RemoteMediaError) {
                res.status(err.statusCode).json({ ok: false, code: err.code, message: err.message });
                return;
            }
            res.status(502).json({ ok: false, message: `下载失败: ${getErrorMessage(err, '未知错误')}` });
        }
    });
    const handleUploadError = (error, _request, response, next) => {
        if (!(error instanceof multer.MulterError)) {
            next(error);
            return;
        }
        if (error.code === 'LIMIT_FILE_SIZE') {
            response.status(413).json({ ok: false, code: 'upload_too_large', message: '上传文件超过大小限制' });
            return;
        }
        response.status(400).json({ ok: false, code: error.code, message: '上传请求格式无效' });
    };
    router.use(handleUploadError);
    return router;
};
