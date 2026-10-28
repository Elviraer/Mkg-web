import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { hashAssetFile, persistAssetBlobFile } from '../assetBlobStore.js';
import { describeUnsupportedMediaFile, detectMediaFile } from '../mediaFileType.js';
import { getErrorMessage } from '../unknownJson.js';
const DEFAULT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const assetKinds = new Set(['image', 'video', 'audio']);
const encodeCursor = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const decodeCursor = (value) => {
    if (!value)
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        return typeof parsed.updatedAt === 'string' && typeof parsed.id === 'string'
            ? { updatedAt: parsed.updatedAt, id: parsed.id }
            : undefined;
    }
    catch {
        return undefined;
    }
};
const normalizeTags = (value) => Array.isArray(value)
    ? Array.from(new Set(value.filter((tag) => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean))).slice(0, 32)
    : [];
const parseProvenance = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const input = value;
    if (!['upload', 'linked', 'derived', 'generated', 'director'].includes(String(input.origin)))
        return undefined;
    const optionalText = (key) => typeof input[key] === 'string' && input[key].trim()
        ? input[key].trim().slice(0, 180)
        : undefined;
    const parameters = input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters)
        ? Object.fromEntries(Object.entries(input.parameters)
            .filter(([, item]) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
            .slice(0, 24))
        : undefined;
    const operation = optionalText('operation');
    const sourceAssetId = optionalText('sourceAssetId');
    const sourceNodeId = optionalText('sourceNodeId');
    const projectId = optionalText('projectId');
    const canvasId = optionalText('canvasId');
    return {
        origin: input.origin,
        ...(operation ? { operation } : {}),
        ...(sourceAssetId ? { sourceAssetId } : {}),
        ...(sourceNodeId ? { sourceNodeId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(canvasId ? { canvasId } : {}),
        ...(parameters && Object.keys(parameters).length > 0 ? { parameters } : {})
    };
};
const parseProvenanceJson = (value) => {
    if (typeof value !== 'string' || !value.trim())
        return undefined;
    try {
        return parseProvenance(JSON.parse(value));
    }
    catch {
        return undefined;
    }
};
const readOriginalName = (value) => {
    const decoded = Buffer.from(value, 'latin1').toString('utf8').trim();
    return path.basename(decoded || value || '未命名素材').slice(0, 180);
};
const readNativeFileName = (value) => {
    const name = path.basename(value || '未命名素材').trim().slice(0, 180);
    return name || '未命名素材';
};
const hasInvalidNativeFileName = (value) => /[\u0000-\u001f\u007f\ufffd]/u.test(value);
const isLoopbackRequest = (request) => {
    const address = request.socket.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
};
const libraryThumbnailTasks = new Map();
/** Content hashes whose thumbnail generation failed, so the client can be told the original is used. */
const unavailableLibraryThumbnails = new Set();
const UNAVAILABLE_THUMBNAIL_LIMIT = 512;
const markThumbnailUnavailable = (contentHash) => {
    unavailableLibraryThumbnails.delete(contentHash);
    unavailableLibraryThumbnails.add(contentHash);
    while (unavailableLibraryThumbnails.size > UNAVAILABLE_THUMBNAIL_LIMIT) {
        const oldest = unavailableLibraryThumbnails.values().next().value;
        if (oldest === undefined)
            break;
        unavailableLibraryThumbnails.delete(oldest);
    }
};
const ensureLibraryThumbnail = async ({ contentHash, sourcePath, kind, createThumbnail }) => {
    if (!createThumbnail || kind === 'audio')
        return undefined;
    const pending = libraryThumbnailTasks.get(contentHash);
    if (pending)
        return pending;
    const task = createThumbnail(sourcePath, kind, contentHash)
        .then((result) => {
        unavailableLibraryThumbnails.delete(contentHash);
        return result.publicUrl;
    })
        .catch(() => {
        markThumbnailUnavailable(contentHash);
        return undefined;
    })
        .finally(() => libraryThumbnailTasks.delete(contentHash));
    libraryThumbnailTasks.set(contentHash, task);
    return task;
};
const resolveControlledSource = (sourceUrl, roots) => {
    const source = roots.find((entry) => sourceUrl.startsWith(`${entry.prefix}/`));
    if (!source)
        return null;
    const relativeSegments = sourceUrl.slice(source.prefix.length + 1).split('/').map((segment) => decodeURIComponent(segment));
    if (relativeSegments.some((segment) => !segment || segment === '.' || segment === '..'))
        return null;
    const root = path.resolve(source.rootDir);
    const resolved = path.resolve(root, ...relativeSegments);
    return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
};
export const persistLibraryAssetFile = async ({ appDatabase, libraryAssetsDir, createThumbnail, filePath, fileName, detected, tags = [], provenance }) => {
    const persistedBlob = await persistAssetBlobFile({
        appDatabase,
        assetBlobsDir: libraryAssetsDir,
        filePath,
        detected
    });
    const { blob } = persistedBlob;
    const contentHash = blob.contentHash;
    const existing = appDatabase.getLibraryAssetByHash(contentHash);
    if (existing) {
        const identity = existing.blobId ? existing : appDatabase.attachLibraryAssetBlob(existing.id, blob.id) ?? existing;
        if (provenance)
            appDatabase.addLibraryAssetProvenance(existing.id, provenance);
        const availableAsset = identity.archivedAt
            ? appDatabase.restoreLibraryAsset(identity.id) ?? identity
            : identity;
        if (!availableAsset.thumbnailUrl && createThumbnail && availableAsset.kind !== 'audio') {
            const existingPath = availableAsset.sourcePath
                ?? resolveControlledSource(availableAsset.fileUrl, [{ prefix: '/api/library-assets/files', rootDir: libraryAssetsDir }]);
            if (existingPath && fs.existsSync(existingPath)) {
                void ensureLibraryThumbnail({
                    contentHash,
                    sourcePath: existingPath,
                    kind: availableAsset.kind,
                    createThumbnail
                }).then((thumbnailUrl) => {
                    if (thumbnailUrl)
                        appDatabase.updateLibraryAssetThumbnail(availableAsset.id, thumbnailUrl);
                }).catch(() => undefined);
            }
        }
        return { asset: availableAsset, deduplicated: true };
    }
    const timestamp = new Date().toISOString();
    const id = `library-${randomUUID()}`;
    const asset = {
        id,
        name: readOriginalName(fileName),
        kind: detected.kind,
        tags,
        fileUrl: `/api/library-assets/${encodeURIComponent(id)}/file`,
        mimeType: blob.mimeType,
        sizeBytes: blob.sizeBytes,
        contentHash,
        ...(provenance ? { provenance } : {}),
        storageMode: 'managed',
        availability: 'ready',
        createdAt: timestamp,
        updatedAt: timestamp
    };
    try {
        const created = appDatabase.createLibraryAsset({
            ...asset,
            blobId: blob.id,
            sourcePath: blob.sourcePath,
            sourceSizeBytes: blob.sizeBytes,
            sourceModifiedAtMs: Math.trunc(fs.statSync(blob.sourcePath).mtimeMs)
        });
        void ensureLibraryThumbnail({ contentHash, sourcePath: blob.sourcePath, kind: detected.kind, createThumbnail })
            .then((thumbnailUrl) => {
            if (thumbnailUrl) {
                appDatabase.updateAssetBlobThumbnail(blob.id, thumbnailUrl);
                appDatabase.updateLibraryAssetThumbnail(created.id, thumbnailUrl);
            }
        }).catch(() => undefined);
        return { asset: created, deduplicated: false };
    }
    catch (error) {
        const concurrentAsset = appDatabase.getLibraryAssetByHash(contentHash);
        if (concurrentAsset)
            return { asset: concurrentAsset, deduplicated: true };
        throw error;
    }
};
export const createLibraryAssetRoutes = ({ appDatabase, libraryAssetsDir, libraryThumbnailsDir, sourceRoots, maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES, desktopToken, createThumbnail }) => {
    const router = Router();
    fs.mkdirSync(libraryAssetsDir, { recursive: true });
    const resolveAssetSource = (asset) => asset.sourcePath
        ?? resolveControlledSource(asset.fileUrl, [{ prefix: '/api/library-assets/files', rootDir: libraryAssetsDir }]);
    const getAvailability = (asset) => {
        const sourcePath = resolveAssetSource(asset);
        if (!sourcePath || !fs.existsSync(sourcePath))
            return 'missing';
        if (asset.storageMode !== 'linked')
            return 'ready';
        const stat = fs.statSync(sourcePath);
        return stat.isFile()
            && stat.size === asset.sourceSizeBytes
            && Math.trunc(stat.mtimeMs) === Math.trunc(asset.sourceModifiedAtMs ?? -1)
            ? 'ready'
            : 'changed';
    };
    const toPublicAsset = (record) => {
        const { sourcePath: _sourcePath, sourceSizeBytes: _sourceSizeBytes, sourceModifiedAtMs: _sourceModifiedAtMs, archivedAt: _archivedAt, ...asset } = record;
        const availability = getAvailability(record);
        if (asset.kind === 'audio')
            return { ...asset, availability };
        if (asset.thumbnailUrl)
            return { ...asset, availability, thumbnailStatus: 'ready' };
        // The client must be able to distinguish "still generating" from "cannot be generated", because
        // only the latter means the preview falls back to the original file.
        const thumbnailStatus = unavailableLibraryThumbnails.has(asset.contentHash) ? 'unavailable' : 'pending';
        return createThumbnail
            ? { ...asset, availability, thumbnailStatus, thumbnailUrl: `/api/library-assets/${encodeURIComponent(asset.id)}/thumbnail` }
            : { ...asset, availability, thumbnailStatus };
    };
    const ensureAssetThumbnail = async (asset) => {
        if (asset.thumbnailUrl || asset.kind === 'audio' || !createThumbnail)
            return asset;
        const sourcePath = resolveAssetSource(asset);
        if (!sourcePath || !fs.existsSync(sourcePath))
            return asset;
        const thumbnailUrl = await ensureLibraryThumbnail({
            contentHash: asset.contentHash,
            sourcePath,
            kind: asset.kind,
            createThumbnail
        });
        return thumbnailUrl
            ? appDatabase.updateLibraryAssetThumbnail(asset.id, thumbnailUrl) ?? { ...asset, thumbnailUrl }
            : asset;
    };
    const upload = multer({
        storage: multer.diskStorage({
            destination: (_request, _file, callback) => callback(null, libraryAssetsDir),
            filename: (_request, _file, callback) => callback(null, `${Date.now()}-${randomUUID()}.upload`)
        }),
        limits: { fileSize: maxUploadBytes, files: 1, fields: 4, parts: 5, fieldNameSize: 100 }
    });
    const persistDetectedFile = async ({ filePath, fileName, detected, tags = [], provenance }) => {
        return persistLibraryAssetFile({
            appDatabase,
            libraryAssetsDir,
            filePath,
            fileName,
            detected,
            tags,
            ...(provenance ? { provenance } : {}),
            ...(createThumbnail ? { createThumbnail } : {})
        });
    };
    router.get('/library-assets', (request, response) => {
        const limit = Math.max(1, Math.min(100, Number(request.query.limit) || 48));
        const kind = typeof request.query.kind === 'string' && assetKinds.has(request.query.kind)
            ? request.query.kind
            : undefined;
        const query = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 120) : undefined;
        const tags = normalizeTags(Array.isArray(request.query.tag) ? request.query.tag : request.query.tag ? [request.query.tag] : []);
        const cursor = decodeCursor(typeof request.query.cursor === 'string' ? request.query.cursor : undefined);
        const page = appDatabase.listLibraryAssetsPage({ limit, ...(query ? { query } : {}), ...(kind ? { kind } : {}), ...(tags.length ? { tags } : {}), ...(cursor ? { cursor } : {}) });
        const last = page.items.at(-1);
        response.json({
            ok: true,
            items: page.items.map(toPublicAsset),
            hasMore: page.hasMore,
            nextCursor: page.hasMore && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
            counts: appDatabase.countLibraryAssetsByKind()
        });
    });
    router.get('/library-asset-tags', (request, response) => {
        const limit = Math.max(1, Math.min(500, Number(request.query.limit) || 200));
        response.json({ ok: true, items: appDatabase.listLibraryAssetTags(limit) });
    });
    router.get('/library-assets/:id/thumbnail', async (request, response) => {
        const asset = appDatabase.getLibraryAsset(request.params.id);
        if (!asset || asset.kind === 'audio') {
            response.status(404).json({ ok: false, code: 'library_thumbnail_not_found', message: '素材预览不存在' });
            return;
        }
        const resolved = await ensureAssetThumbnail(asset);
        if (!resolved.thumbnailUrl) {
            // FFmpeg may be unavailable or unable to decode this format. An image can fall back to its
            // original file, but a video must not: callers render this URL as an image, so streaming a
            // whole video there wastes the payload without ever displaying. 404 keeps the card/player
            // placeholder instead. `no-store` keeps the fallback from outliving the real thumbnail.
            if (asset.kind === 'image') {
                response.setHeader('Cache-Control', 'no-store');
                response.redirect(307, `/api/library-assets/${encodeURIComponent(asset.id)}/file`);
                return;
            }
            response.status(404).json({ ok: false, code: 'library_thumbnail_unavailable', message: '素材预览生成失败' });
            return;
        }
        response.redirect(307, resolved.thumbnailUrl);
    });
    router.get('/library-assets/:id', (request, response) => {
        const asset = appDatabase.getLibraryAsset(request.params.id);
        if (!asset) {
            response.status(404).json({ ok: false, code: 'library_asset_not_found', message: '素材不存在' });
            return;
        }
        response.json({ ok: true, asset: toPublicAsset(asset) });
    });
    router.get('/library-assets/:id/file', (request, response) => {
        const asset = appDatabase.getLibraryAsset(request.params.id);
        if (!asset) {
            response.status(404).json({ ok: false, code: 'library_asset_not_found', message: '素材不存在' });
            return;
        }
        const availability = getAvailability(asset);
        if (availability === 'missing') {
            response.status(404).json({ ok: false, code: 'library_asset_source_missing', message: '链接素材源文件不存在' });
            return;
        }
        if (availability === 'changed') {
            response.status(409).json({ ok: false, code: 'library_asset_source_changed', message: '链接素材源文件已发生变化，请重新链接' });
            return;
        }
        const sourcePath = resolveAssetSource(asset);
        if (!sourcePath || !fs.existsSync(sourcePath)) {
            response.status(404).json({ ok: false, code: 'library_asset_file_not_found', message: '素材文件不存在' });
            return;
        }
        response.type(asset.mimeType);
        response.sendFile(path.resolve(sourcePath));
    });
    router.post('/library-assets/upload', upload.single('file'), async (request, response) => {
        if (!request.file) {
            response.status(400).json({ ok: false, message: 'No file uploaded' });
            return;
        }
        const detected = await detectMediaFile(request.file.path);
        if (!detected) {
            const unsupportedHint = await describeUnsupportedMediaFile(request.file.path);
            fs.rmSync(request.file.path, { force: true });
            response.status(415).json({
                ok: false,
                code: 'unsupported_media_type',
                message: unsupportedHint ?? '文件内容不是受支持的图片、视频或音频'
            });
            return;
        }
        try {
            const provenance = parseProvenanceJson(request.body.provenance);
            const result = await persistDetectedFile({
                filePath: request.file.path,
                fileName: request.file.originalname,
                detected,
                tags: normalizeTags(request.body.tags ? String(request.body.tags).split(',') : []),
                ...(provenance ? { provenance } : {})
            });
            response.status(result.deduplicated ? 200 : 201).json({ ok: true, ...result, asset: toPublicAsset(result.asset) });
        }
        catch (error) {
            fs.rmSync(request.file.path, { force: true });
            response.status(500).json({ ok: false, message: getErrorMessage(error, '素材上传失败') });
        }
    });
    router.post('/library-assets/import', async (request, response) => {
        const sourceUrl = typeof request.body?.sourceUrl === 'string' ? request.body.sourceUrl : '';
        const sourcePath = resolveControlledSource(sourceUrl, sourceRoots);
        if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
            response.status(400).json({ ok: false, code: 'invalid_library_source', message: '只允许导入受控本地素材' });
            return;
        }
        const tempPath = path.join(libraryAssetsDir, `${Date.now()}-${randomUUID()}.upload`);
        fs.copyFileSync(sourcePath, tempPath);
        const detected = await detectMediaFile(tempPath);
        if (!detected) {
            fs.rmSync(tempPath, { force: true });
            response.status(415).json({ ok: false, code: 'unsupported_media_type', message: '源文件不是受支持的媒体' });
            return;
        }
        try {
            const provenance = parseProvenance(request.body?.provenance);
            const result = await persistDetectedFile({
                filePath: tempPath,
                fileName: typeof request.body?.name === 'string' ? request.body.name : path.basename(sourcePath),
                detected,
                tags: normalizeTags(request.body?.tags),
                ...(provenance ? { provenance } : {})
            });
            if (request.body?.consumeSource === true && sourceUrl.startsWith('/api/uploads/')) {
                fs.rmSync(sourcePath, { force: true });
            }
            response.status(result.deduplicated ? 200 : 201).json({ ok: true, ...result, asset: toPublicAsset(result.asset) });
        }
        catch (error) {
            fs.rmSync(tempPath, { force: true });
            response.status(500).json({ ok: false, message: getErrorMessage(error, '素材导入失败') });
        }
    });
    router.post('/history-assets/:id/publish-to-library', (request, response) => {
        const projectId = typeof request.body?.projectId === 'string' ? request.body.projectId.trim() : '';
        const canvasId = typeof request.body?.canvasId === 'string' ? request.body.canvasId.trim() : '';
        if (!projectId || !canvasId) {
            response.status(400).json({ ok: false, message: 'projectId and canvasId are required' });
            return;
        }
        const history = appDatabase.getHistoryAsset(request.params.id, { projectId, canvasId });
        if (!history) {
            response.status(404).json({ ok: false, code: 'history_asset_not_found', message: '历史资产不存在' });
            return;
        }
        const legacyLibrary = history.libraryAssetId ? appDatabase.getLibraryAsset(history.libraryAssetId) : null;
        if (legacyLibrary) {
            const restored = legacyLibrary.archivedAt
                ? appDatabase.restoreLibraryAsset(legacyLibrary.id) ?? legacyLibrary
                : legacyLibrary;
            response.json({ ok: true, asset: toPublicAsset(restored), deduplicated: true });
            return;
        }
        const blob = history.blobId ? appDatabase.getAssetBlob(history.blobId) : null;
        if (!blob || !fs.existsSync(blob.sourcePath)) {
            response.status(404).json({ ok: false, code: 'history_asset_file_not_found', message: '历史资产文件不存在' });
            return;
        }
        const existing = appDatabase.getLibraryAssetByHash(blob.contentHash);
        if (existing) {
            const restored = existing.archivedAt
                ? appDatabase.restoreLibraryAsset(existing.id) ?? existing
                : existing;
            appDatabase.addLibraryAssetProvenance(restored.id, {
                origin: 'generated', operation: 'publish-history', sourceAssetId: history.id, projectId, canvasId
            });
            response.json({ ok: true, asset: toPublicAsset(restored), deduplicated: true });
            return;
        }
        const timestamp = new Date().toISOString();
        const id = `library-${randomUUID()}`;
        const requestedName = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
        const asset = appDatabase.createLibraryAsset({
            id,
            name: (requestedName || history.name).slice(0, 180),
            kind: blob.kind,
            tags: normalizeTags(request.body?.tags),
            fileUrl: `/api/library-assets/${encodeURIComponent(id)}/file`,
            ...(history.thumbnailUrl || blob.thumbnailUrl ? { thumbnailUrl: history.thumbnailUrl ?? blob.thumbnailUrl } : {}),
            mimeType: blob.mimeType,
            sizeBytes: blob.sizeBytes,
            contentHash: blob.contentHash,
            provenance: {
                origin: 'generated', operation: 'publish-history', sourceAssetId: history.id, projectId, canvasId
            },
            storageMode: 'managed',
            availability: 'ready',
            blobId: blob.id,
            sourcePath: blob.sourcePath,
            sourceSizeBytes: blob.sizeBytes,
            sourceModifiedAtMs: Math.trunc(fs.statSync(blob.sourcePath).mtimeMs),
            createdAt: timestamp,
            updatedAt: timestamp
        });
        response.status(201).json({ ok: true, asset: toPublicAsset(asset), deduplicated: false });
    });
    router.post('/roles/:roleId/images/:imageId/publish-to-library', (request, response) => {
        const role = appDatabase.getRole(request.params.roleId);
        if (!role) {
            response.status(404).json({ ok: false, code: 'role_not_found', message: '角色不存在' });
            return;
        }
        const images = [
            ...(Array.isArray(role.images) ? role.images : []),
            ...(Array.isArray(role.retiredImages) ? role.retiredImages : [])
        ];
        const image = images.find((value) => (Boolean(value)
            && typeof value === 'object'
            && !Array.isArray(value)
            && value.id === request.params.imageId));
        const blobId = image && typeof image.blobId === 'string' ? image.blobId : '';
        const blob = blobId ? appDatabase.getAssetBlob(blobId) : null;
        if (!image || !blob || !fs.existsSync(blob.sourcePath)) {
            response.status(404).json({ ok: false, code: 'role_image_file_not_found', message: '角色图片不存在' });
            return;
        }
        const provenance = {
            origin: 'derived',
            operation: 'publish-role-image',
            sourceAssetId: `${request.params.roleId}:${request.params.imageId}`
        };
        const existing = appDatabase.getLibraryAssetByHash(blob.contentHash);
        if (existing) {
            const restored = existing.archivedAt
                ? appDatabase.restoreLibraryAsset(existing.id) ?? existing
                : existing;
            appDatabase.addLibraryAssetProvenance(restored.id, provenance);
            response.json({ ok: true, asset: toPublicAsset(restored), deduplicated: true });
            return;
        }
        const timestamp = new Date().toISOString();
        const id = `library-${randomUUID()}`;
        const requestedName = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
        const imageName = typeof image.name === 'string' ? image.name.trim() : '';
        const asset = appDatabase.createLibraryAsset({
            id,
            name: (requestedName || imageName || `${String(role.name || '角色')}图片`).slice(0, 180),
            kind: blob.kind,
            tags: normalizeTags(request.body?.tags),
            fileUrl: `/api/library-assets/${encodeURIComponent(id)}/file`,
            ...((typeof image.thumbnailUrl === 'string' && image.thumbnailUrl) || blob.thumbnailUrl
                ? { thumbnailUrl: (typeof image.thumbnailUrl === 'string' && image.thumbnailUrl) || blob.thumbnailUrl }
                : {}),
            mimeType: blob.mimeType,
            sizeBytes: blob.sizeBytes,
            contentHash: blob.contentHash,
            provenance,
            storageMode: 'managed',
            availability: 'ready',
            blobId: blob.id,
            sourcePath: blob.sourcePath,
            sourceSizeBytes: blob.sizeBytes,
            sourceModifiedAtMs: Math.trunc(fs.statSync(blob.sourcePath).mtimeMs),
            createdAt: timestamp,
            updatedAt: timestamp
        });
        response.status(201).json({ ok: true, asset: toPublicAsset(asset), deduplicated: false });
    });
    const authorizeDesktop = (request) => Boolean(desktopToken
        && isLoopbackRequest(request)
        && request.get('x-mk-desktop-token') === desktopToken);
    router.post('/desktop/library-assets/link', async (request, response) => {
        if (!authorizeDesktop(request)) {
            response.status(403).json({ ok: false, code: 'desktop_authorization_required', message: '仅允许 MK 桌面程序链接本地素材' });
            return;
        }
        try {
            const sourcePath = typeof request.body?.path === 'string' ? path.resolve(request.body.path) : '';
            if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
                response.status(400).json({ ok: false, code: 'invalid_local_source', message: '本地素材文件不存在' });
                return;
            }
            const detected = await detectMediaFile(sourcePath);
            if (!detected) {
                const unsupportedHint = await describeUnsupportedMediaFile(sourcePath);
                response.status(415).json({
                    ok: false,
                    code: 'unsupported_media_type',
                    message: unsupportedHint ?? '文件内容不是受支持的图片、视频或音频'
                });
                return;
            }
            const contentHash = await hashAssetFile(sourcePath);
            const existing = appDatabase.getLibraryAssetByHash(contentHash);
            if (existing) {
                const availableAsset = existing.archivedAt
                    ? appDatabase.restoreLibraryAsset(existing.id) ?? existing
                    : existing;
                if (availableAsset.storageMode === 'linked') {
                    const stat = fs.statSync(sourcePath);
                    let relinked = appDatabase.relinkLibraryAsset(availableAsset.id, {
                        sourcePath,
                        sourceSizeBytes: stat.size,
                        sourceModifiedAtMs: Math.trunc(stat.mtimeMs)
                    });
                    if (relinked && hasInvalidNativeFileName(relinked.name)) {
                        relinked = appDatabase.updateLibraryAsset(relinked.id, { name: readNativeFileName(sourcePath) });
                    }
                    response.json({ ok: true, asset: toPublicAsset(relinked), deduplicated: true });
                    return;
                }
                response.json({ ok: true, asset: toPublicAsset(availableAsset), deduplicated: true });
                return;
            }
            const stat = fs.statSync(sourcePath);
            const timestamp = new Date().toISOString();
            const id = `library-${randomUUID()}`;
            const asset = appDatabase.createLibraryAsset({
                id,
                name: readNativeFileName(sourcePath),
                kind: detected.kind,
                tags: normalizeTags(request.body?.tags),
                fileUrl: `/api/library-assets/${encodeURIComponent(id)}/file`,
                mimeType: detected.mime,
                sizeBytes: stat.size,
                contentHash,
                provenance: { origin: 'linked' },
                storageMode: 'linked',
                availability: 'ready',
                sourcePath,
                sourceSizeBytes: stat.size,
                sourceModifiedAtMs: Math.trunc(stat.mtimeMs),
                createdAt: timestamp,
                updatedAt: timestamp
            });
            void ensureLibraryThumbnail({ contentHash, sourcePath, kind: detected.kind, createThumbnail })
                .then((thumbnailUrl) => {
                if (thumbnailUrl)
                    appDatabase.updateLibraryAssetThumbnail(asset.id, thumbnailUrl);
            }).catch(() => undefined);
            response.status(201).json({ ok: true, asset: toPublicAsset(asset), deduplicated: false });
        }
        catch {
            response.status(500).json({ ok: false, code: 'desktop_library_link_failed', message: '本地素材链接失败' });
        }
    });
    router.post('/desktop/library-assets/:id/relink', async (request, response) => {
        if (!authorizeDesktop(request)) {
            response.status(403).json({ ok: false, code: 'desktop_authorization_required', message: '仅允许 MK 桌面程序重新链接本地素材' });
            return;
        }
        try {
            const current = appDatabase.getLibraryAsset(request.params.id);
            const sourcePath = typeof request.body?.path === 'string' ? path.resolve(request.body.path) : '';
            if (!current || !sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
                response.status(404).json({ ok: false, code: 'library_asset_or_source_not_found', message: '素材或本地源文件不存在' });
                return;
            }
            const contentHash = await hashAssetFile(sourcePath);
            if (contentHash !== current.contentHash) {
                response.status(409).json({ ok: false, code: 'library_asset_hash_mismatch', message: '所选文件与原素材内容不一致' });
                return;
            }
            const stat = fs.statSync(sourcePath);
            const asset = appDatabase.relinkLibraryAsset(current.id, {
                sourcePath,
                sourceSizeBytes: stat.size,
                sourceModifiedAtMs: Math.trunc(stat.mtimeMs)
            });
            response.json({ ok: true, asset: toPublicAsset(asset) });
        }
        catch {
            response.status(500).json({ ok: false, code: 'desktop_library_relink_failed', message: '本地素材重新链接失败' });
        }
    });
    router.patch('/library-assets/:id', (request, response) => {
        const patch = {
            ...(typeof request.body?.name === 'string' ? { name: request.body.name.slice(0, 180) } : {}),
            ...(request.body?.tags !== undefined ? { tags: normalizeTags(request.body.tags) } : {})
        };
        const asset = appDatabase.updateLibraryAsset(request.params.id, patch);
        if (!asset) {
            response.status(404).json({ ok: false, code: 'library_asset_not_found', message: '素材不存在' });
            return;
        }
        response.json({ ok: true, asset: toPublicAsset(asset) });
    });
    router.post('/library-assets/:id/restore', (request, response) => {
        const current = appDatabase.getLibraryAsset(request.params.id);
        if (!current) {
            response.status(404).json({ ok: false, code: 'library_asset_not_found', message: '素材不存在' });
            return;
        }
        const asset = current.archivedAt ? appDatabase.restoreLibraryAsset(current.id) ?? current : current;
        response.json({ ok: true, asset: toPublicAsset(asset) });
    });
    const readAssetIds = (value) => Array.isArray(value)
        ? Array.from(new Set(value.filter((id) => typeof id === 'string' && Boolean(id.trim())))).slice(0, 500)
        : [];
    router.post('/library-assets/delete-impact', (request, response) => {
        const ids = readAssetIds(request.body?.ids);
        if (ids.length === 0) {
            response.status(400).json({ ok: false, message: 'ids are required' });
            return;
        }
        const items = appDatabase.listLibraryAssetDeletionImpact(ids);
        response.json({
            ok: true,
            items,
            totalReferences: items.reduce((count, item) => count + item.references.length, 0)
        });
    });
    router.delete('/library-assets', (request, response) => {
        const ids = readAssetIds(request.body?.ids);
        if (ids.length === 0) {
            response.status(400).json({ ok: false, message: 'ids are required' });
            return;
        }
        const requestedMode = request.body?.mode;
        const mode = requestedMode === 'archive' || requestedMode === 'force' ? requestedMode : 'safe';
        const protectedIds = mode === 'safe' ? appDatabase.listReferencedLibraryAssetIds(ids) : new Set();
        const archived = mode === 'archive' ? appDatabase.archiveLibraryAssets(ids) : 0;
        const deleted = mode === 'archive'
            ? []
            : appDatabase.deleteLibraryAssets(ids.filter((id) => !protectedIds.has(id)));
        let reclaimedFiles = 0;
        deleted.forEach((asset) => {
            const roots = [
                ...(libraryThumbnailsDir ? [{ prefix: '/api/library-assets/files/thumbnails', rootDir: libraryThumbnailsDir }] : []),
                { prefix: '/api/library-assets/files', rootDir: libraryAssetsDir }
            ];
            if (asset.blobId) {
                const blobs = appDatabase.deleteUnreferencedAssetBlobs([asset.blobId]);
                blobs.forEach((blob) => {
                    if (fs.existsSync(blob.sourcePath)) {
                        fs.rmSync(blob.sourcePath, { force: true });
                        reclaimedFiles += 1;
                    }
                    [asset.thumbnailUrl, blob.thumbnailUrl].forEach((publicUrl) => {
                        if (!publicUrl)
                            return;
                        const filePath = resolveControlledSource(publicUrl, roots);
                        if (filePath && fs.existsSync(filePath)) {
                            fs.rmSync(filePath, { force: true });
                            reclaimedFiles += 1;
                        }
                    });
                });
                return;
            }
            if (asset.storageMode === 'managed'
                && asset.sourcePath
                && appDatabase.countHistoryAssetFileReferences(asset.fileUrl) === 0
                && fs.existsSync(asset.sourcePath)) {
                fs.rmSync(asset.sourcePath, { force: true });
                reclaimedFiles += 1;
            }
            [asset.storageMode === 'managed' && !asset.sourcePath ? asset.fileUrl : undefined, asset.thumbnailUrl].forEach((publicUrl) => {
                if (!publicUrl || appDatabase.countHistoryAssetFileReferences(publicUrl) > 0)
                    return;
                const filePath = resolveControlledSource(publicUrl, roots);
                if (filePath && fs.existsSync(filePath)) {
                    fs.rmSync(filePath, { force: true });
                    reclaimedFiles += 1;
                }
            });
        });
        response.json({
            ok: true,
            deleted: deleted.length,
            archived,
            protectedIds: Array.from(protectedIds),
            reclaimedFiles
        });
    });
    const handleUploadError = (error, _request, response, next) => {
        if (!(error instanceof multer.MulterError)) {
            next(error);
            return;
        }
        response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
            ok: false,
            code: error.code,
            message: error.code === 'LIMIT_FILE_SIZE' ? '上传文件超过大小限制' : '上传请求格式无效'
        });
    };
    router.use(handleUploadError);
    return router;
};
