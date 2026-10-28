import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { detectMediaFile } from '../mediaFileType.js';
const readString = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const removeUploadedFile = (file) => {
    if (!file?.path)
        return;
    try {
        fs.rmSync(file.path, { force: true });
    }
    catch (error) {
        console.warn(`Failed to remove History upload: ${file.path}`, error);
    }
};
const readScope = (request) => {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const projectId = readString(request.query.projectId) ?? readString(body.projectId);
    const canvasId = readString(request.query.canvasId) ?? readString(body.canvasId);
    return projectId && canvasId ? { projectId, canvasId } : null;
};
const requireScope = (request, response) => {
    const scope = readScope(request);
    if (!scope)
        response.status(400).json({ ok: false, message: 'projectId and canvasId are required' });
    return scope;
};
const withThumbnailEndpoint = (item, scope) => {
    if (item.kind === 'audio' || item.thumbnailUrl)
        return item;
    const params = new URLSearchParams(scope);
    return {
        ...item,
        thumbnailUrl: `/api/history-assets/${encodeURIComponent(item.id)}/thumbnail?${params.toString()}`
    };
};
export const createHistoryAssetRoutes = (historyAssetStore, { sourceRoots = [], resolveControlledSource } = {}) => {
    const router = Router();
    const upload = multer({
        storage: multer.diskStorage({
            destination: (_request, _file, callback) => callback(null, historyAssetStore.rootDir ?? process.cwd()),
            filename: (_request, _file, callback) => callback(null, `${Date.now()}-${randomUUID()}.upload`)
        }),
        limits: { fileSize: 256 * 1024 * 1024, files: 1 }
    });
    router.get('/history-assets', (request, response) => {
        const scope = requireScope(request, response);
        if (!scope)
            return;
        const rawKinds = request.query.kind === undefined
            ? []
            : Array.isArray(request.query.kind)
                ? request.query.kind
                : [request.query.kind];
        const kinds = rawKinds.map(readString).filter((kind) => Boolean(kind));
        if (kinds.length !== rawKinds.length || kinds.some((kind) => kind !== 'image' && kind !== 'video' && kind !== 'audio')) {
            response.status(400).json({ ok: false, message: 'invalid kind' });
            return;
        }
        const order = request.query.order === 'asc' ? 'asc' : 'desc';
        const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 60));
        const page = historyAssetStore.listPage({
            ...scope,
            limit,
            order,
            ...(kinds.length === 1 ? { kind: kinds[0] } : {}),
            ...(kinds.length > 1 ? { kinds: kinds } : {}),
            ...(readString(request.query.cursor) ? { cursor: readString(request.query.cursor) } : {}),
            ...(readString(request.query.model) ? { model: readString(request.query.model) } : {}),
            ...(readString(request.query.providerId) ? { providerId: readString(request.query.providerId) } : {}),
            ...(readString(request.query.query) ? { query: readString(request.query.query) } : {})
        });
        response.json({
            ...page,
            items: page.items.map((item) => withThumbnailEndpoint(item, scope))
        });
    });
    router.post('/history-assets/cache', async (request, response) => {
        try {
            const scope = requireScope(request, response);
            if (!scope)
                return;
            const { assets } = request.body;
            if (!Array.isArray(assets) || assets.length === 0) {
                response.status(400).json({ ok: false, message: 'assets is required' });
                return;
            }
            const cachedItems = await historyAssetStore.cacheAssets(assets.map((asset) => ({ ...asset, ...scope })));
            response.json({ ok: true, items: cachedItems });
        }
        catch (error) {
            response.status(500).json({ ok: false, message: error instanceof Error ? error.message : '缓存历史资产失败' });
        }
    });
    router.post('/history-assets/delete', (request, response) => {
        const scope = requireScope(request, response);
        if (!scope)
            return;
        const { ids } = request.body;
        if (!Array.isArray(ids)) {
            response.status(400).json({ ok: false, message: 'ids is required' });
            return;
        }
        response.json({ ok: true, deleted: historyAssetStore.deleteAssets(ids, scope) });
    });
    router.post('/history-assets/upload', upload.single('file'), async (request, response) => {
        const scope = requireScope(request, response);
        if (!scope) {
            removeUploadedFile(request.file);
            return;
        }
        if (!request.file) {
            response.status(400).json({ ok: false, message: 'file is required' });
            return;
        }
        try {
            const detected = await detectMediaFile(request.file.path);
            if (!detected) {
                removeUploadedFile(request.file);
                response.status(415).json({ ok: false, code: 'unsupported_media_type', message: '文件内容不是受支持的媒体' });
                return;
            }
            const id = `history-${detected.kind}-${randomUUID()}`;
            const [item] = await historyAssetStore.cacheAssets([{
                    id,
                    ...scope,
                    name: readString(request.body?.name) ?? request.file.originalname,
                    kind: detected.kind,
                    source: readString(request.body?.source) ?? '画布派生资产',
                    previewUrl: `/api/history-assets/files/${encodeURIComponent(path.basename(request.file.path))}`,
                    createdAt: new Date().toISOString()
                }]);
            if (!item)
                throw new Error('历史资产写入失败');
            response.status(201).json({ ok: true, item: withThumbnailEndpoint(item, scope) });
        }
        catch (error) {
            removeUploadedFile(request.file);
            response.status(500).json({ ok: false, message: error instanceof Error ? error.message : '历史资产上传失败' });
        }
    });
    router.post('/history-assets/import', async (request, response) => {
        const scope = requireScope(request, response);
        if (!scope)
            return;
        const sourceUrl = readString(request.body?.sourceUrl);
        const root = sourceUrl ? sourceRoots.find((entry) => sourceUrl.startsWith(`${entry.prefix}/`)) : undefined;
        const identitySourcePath = sourceUrl ? resolveControlledSource?.(sourceUrl) ?? null : null;
        if (!sourceUrl || (!root && !identitySourcePath)) {
            response.status(400).json({ ok: false, code: 'invalid_history_source', message: '只允许导入受控本地资产' });
            return;
        }
        const relative = root
            ? sourceUrl.slice(root.prefix.length + 1).split('/').map((segment) => decodeURIComponent(segment))
            : [];
        const rootPath = root ? path.resolve(root.rootDir) : '';
        const sourcePath = identitySourcePath ?? path.resolve(rootPath, ...relative);
        if ((root && (relative.some((segment) => !segment || segment === '.' || segment === '..')
            || !sourcePath.startsWith(`${rootPath}${path.sep}`)))
            || !fs.existsSync(sourcePath)
            || !fs.statSync(sourcePath).isFile()) {
            response.status(400).json({ ok: false, code: 'invalid_history_source', message: '受控本地资产不存在' });
            return;
        }
        const temporaryName = `${Date.now()}-${randomUUID()}.upload`;
        const temporaryPath = path.join(historyAssetStore.rootDir ?? process.cwd(), temporaryName);
        fs.copyFileSync(sourcePath, temporaryPath);
        try {
            const detected = await detectMediaFile(temporaryPath);
            if (!detected) {
                fs.rmSync(temporaryPath, { force: true });
                response.status(415).json({ ok: false, code: 'unsupported_media_type', message: '源文件不是受支持的媒体' });
                return;
            }
            const id = `history-${detected.kind}-${randomUUID()}`;
            const [item] = await historyAssetStore.cacheAssets([{
                    id,
                    ...scope,
                    name: readString(request.body?.name) ?? path.basename(sourcePath),
                    kind: detected.kind,
                    source: readString(request.body?.source) ?? '画布派生资产',
                    previewUrl: `/api/history-assets/files/${encodeURIComponent(temporaryName)}`,
                    createdAt: new Date().toISOString()
                }]);
            if (!item)
                throw new Error('历史资产写入失败');
            if (root && request.body?.consumeSource === true)
                fs.rmSync(sourcePath, { force: true });
            response.status(201).json({ ok: true, item: withThumbnailEndpoint(item, scope) });
        }
        catch (error) {
            fs.rmSync(temporaryPath, { force: true });
            response.status(500).json({ ok: false, message: error instanceof Error ? error.message : '历史资产导入失败' });
        }
    });
    router.post('/history-assets/delete-impact', (request, response) => {
        const scope = requireScope(request, response);
        if (!scope)
            return;
        const rawIds = request.body?.ids;
        const ids = Array.isArray(rawIds)
            ? Array.from(new Set(rawIds.map(readString).filter((id) => Boolean(id)))).slice(0, 500)
            : [];
        if (ids.length === 0) {
            response.status(400).json({ ok: false, message: 'ids are required' });
            return;
        }
        const items = historyAssetStore.getDeletionImpact?.(ids, scope)
            ?? ids.flatMap((id) => {
                const asset = historyAssetStore.getAsset(id, scope);
                return asset ? [{ id: asset.id, name: asset.name, references: [] }] : [];
            });
        response.json({
            ok: true,
            items,
            totalReferences: items.reduce((count, item) => count + item.references.length, 0)
        });
    });
    router.post('/history-assets/resolve', (request, response) => {
        const scope = requireScope(request, response);
        if (!scope)
            return;
        const rawIds = request.body?.ids;
        const ids = Array.isArray(rawIds)
            ? rawIds.map((id) => readString(id)).filter((id) => Boolean(id))
            : [];
        if (ids.length === 0 || ids.length > 100 || ids.length !== (Array.isArray(rawIds) ? rawIds.length : 0)) {
            response.status(400).json({ ok: false, message: 'ids must contain 1-100 asset IDs' });
            return;
        }
        const uniqueIds = [...new Set(ids)];
        const items = uniqueIds
            .map((id) => historyAssetStore.getAsset(id, scope))
            .filter((item) => Boolean(item))
            .map((item) => withThumbnailEndpoint(item, scope));
        response.json({ ok: true, items });
    });
    router.post('/history-assets/reclaim-orphans', (_request, response) => {
        response.json({ ok: true, ...historyAssetStore.reclaimOrphanFiles() });
    });
    router.get('/history-assets/:assetId/thumbnail', async (request, response) => {
        const scope = requireScope(request, response);
        if (!scope)
            return;
        const item = await historyAssetStore.ensureThumbnail(request.params.assetId, scope);
        response.setHeader('Cache-Control', 'no-store');
        if (!item?.thumbnailUrl) {
            // Thumbnail generation depends on FFmpeg. An image can fall back to its original file, but a
            // video must not: the caller renders this URL as an image, so streaming a whole video there
            // would waste the payload without ever displaying. 404 lets the player keep its own poster.
            if (item?.kind === 'image') {
                const params = new URLSearchParams(scope);
                response.redirect(307, `/api/history-assets/${encodeURIComponent(request.params.assetId)}/file?${params.toString()}`);
                return;
            }
            response.status(404).json({ ok: false, code: 'history_thumbnail_unavailable', message: '素材预览生成失败' });
            return;
        }
        response.redirect(307, item.thumbnailUrl);
    });
    router.get('/history-assets/:assetId/file', (request, response) => {
        const scope = requireScope(request, response);
        if (!scope)
            return;
        const file = historyAssetStore.getAssetFile?.(request.params.assetId, scope);
        if (!file) {
            response.status(404).json({ ok: false, code: 'history_asset_file_not_found', message: '历史资产文件不存在' });
            return;
        }
        response.type(file.mimeType);
        response.sendFile(file.sourcePath);
    });
    router.get('/history-assets/:assetId', (request, response) => {
        const scope = requireScope(request, response);
        if (!scope)
            return;
        const item = historyAssetStore.getAsset(request.params.assetId, scope);
        if (!item) {
            response.status(404).json({ ok: false, message: '未找到历史资产' });
            return;
        }
        response.json({ ok: true, item });
    });
    router.patch('/history-assets/:assetId', (request, response) => {
        const scope = requireScope(request, response);
        if (!scope)
            return;
        const patch = request.body;
        const updated = historyAssetStore.updateAsset(request.params.assetId, scope, patch);
        if (!updated) {
            response.status(404).json({ ok: false, message: '未找到历史资产' });
            return;
        }
        response.json({ ok: true, item: updated });
    });
    router.get('/reference-history', (request, response) => {
        const scope = requireScope(request, response);
        if (!scope)
            return;
        response.json({ items: historyAssetStore.readManifest(scope) });
    });
    return router;
};
