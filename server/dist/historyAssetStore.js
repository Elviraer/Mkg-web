import fs from 'fs';
import path from 'path';
import { detectMediaBuffer, detectMediaFile } from './mediaFileType.js';
import { DEFAULT_MAX_REMOTE_MEDIA_BYTES, fetchRemoteMediaBuffer } from './remoteMedia.js';
const encodeCursor = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const decodeCursor = (value) => {
    if (!value)
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string')
            return undefined;
        return { createdAt: parsed.createdAt, id: parsed.id };
    }
    catch {
        return undefined;
    }
};
const contentTypeExtension = (contentType) => {
    const normalized = (String(contentType ?? '').split(';')[0] ?? '').trim().toLowerCase();
    const map = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'video/mp4': '.mp4',
        'video/webm': '.webm',
        'video/quicktime': '.mov',
        'audio/mpeg': '.mp3',
        'audio/mp3': '.mp3',
        'audio/wav': '.wav',
        'audio/ogg': '.ogg'
    };
    return map[normalized] ?? '';
};
const safeAssetFileName = (name, ext) => {
    const base = path.basename(name, path.extname(name)).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'asset';
    return `${Date.now()}-${Math.round(Math.random() * 1e9)}-${base}${ext}`;
};
const parseDataUrlAsset = (value) => {
    const match = value.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
    if (!match)
        return null;
    const contentType = match[1] || 'application/octet-stream';
    const isBase64 = Boolean(match[2]);
    const body = match[3] || '';
    try {
        return {
            contentType,
            bytes: isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body))
        };
    }
    catch {
        return null;
    }
};
const hashString = (value) => {
    let hash = 5381;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
    }
    return (hash >>> 0).toString(36);
};
const createSourcePreviewMarker = (previewUrl) => {
    if (!previewUrl.startsWith('data:'))
        return previewUrl;
    const mime = previewUrl.match(/^data:([^;,]+)/)?.[1] ?? 'application/octet-stream';
    return `data:${mime};length=${previewUrl.length};hash=${hashString(previewUrl)}`;
};
const normalizeDedupePart = (value) => String(value ?? '').trim();
const getHistoryAssetDedupeKey = (asset) => {
    const scopePrefix = `${asset.projectId ?? 'unscoped'}:${asset.canvasId ?? 'unscoped'}`;
    const sourcePreviewUrl = normalizeDedupePart(asset.metadata?.sourcePreviewUrl);
    if (sourcePreviewUrl)
        return `${scopePrefix}:source:${asset.kind}:${sourcePreviewUrl}`;
    const metadata = asset.metadata;
    const semanticParts = [
        metadata?.nodeId,
        metadata?.model,
        metadata?.prompt,
        metadata?.aspectRatio,
        metadata?.resolution,
        metadata?.duration,
        metadata?.batchSize,
        asset.name
    ].map(normalizeDedupePart).filter(Boolean);
    if (semanticParts.length >= 3) {
        return `${scopePrefix}:semantic:${asset.kind}:${semanticParts.join('|')}`;
    }
    const previewUrl = normalizeDedupePart(asset.previewUrl);
    if (previewUrl)
        return `${scopePrefix}:preview:${asset.kind}:${previewUrl}`;
    return `${scopePrefix}:id:${asset.id}`;
};
const dedupeHistoryAssets = (items) => {
    const seen = new Set();
    const duplicateIds = [];
    const dedupedItems = items.filter((item) => {
        const key = getHistoryAssetDedupeKey(item);
        if (seen.has(key)) {
            duplicateIds.push(item.id);
            return false;
        }
        seen.add(key);
        return true;
    });
    return { items: dedupedItems, duplicateIds };
};
export const createHistoryAssetStore = ({ rootDir, publicUrlPrefix, resolveSourceUrl, resolveOutboundPolicy, database, createThumbnail, persistManagedAsset }) => {
    const manifestPath = path.join(rootDir, 'manifest.json');
    if (!fs.existsSync(rootDir)) {
        fs.mkdirSync(rootDir, { recursive: true });
    }
    const readManifestFile = () => {
        try {
            if (!fs.existsSync(manifestPath))
                return [];
            const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            return [];
        }
    };
    if (database) {
        const manifestItems = readManifestFile();
        if (manifestItems.length > 0 && database.listHistoryAssets().length === 0) {
            database.upsertHistoryAssets(manifestItems);
        }
    }
    const readManifest = (scope) => {
        const rawItems = database ? database.listHistoryAssets(scope) : readManifestFile().filter((item) => (!scope || (item.projectId === scope.projectId && item.canvasId === scope.canvasId)));
        if (database)
            return rawItems;
        let migrated = false;
        const materializedItems = rawItems.map((item) => {
            if (!item.previewUrl?.startsWith('data:'))
                return item;
            const dataUrlAsset = parseDataUrlAsset(item.previewUrl);
            if (!dataUrlAsset)
                return item;
            const ext = contentTypeExtension(dataUrlAsset.contentType)
                || (item.kind === 'video' ? '.mp4' : item.kind === 'audio' ? '.mp3' : '.png');
            const filename = safeAssetFileName(item.name || `${item.kind}-${Date.now()}`, ext);
            fs.writeFileSync(path.join(rootDir, filename), dataUrlAsset.bytes);
            migrated = true;
            return {
                ...item,
                previewUrl: `${publicUrlPrefix}/${filename}`,
                metadata: {
                    ...item.metadata,
                    sourcePreviewUrl: item.metadata?.sourcePreviewUrl || createSourcePreviewMarker(item.previewUrl)
                }
            };
        });
        const { items, duplicateIds } = dedupeHistoryAssets(materializedItems);
        if (migrated || duplicateIds.length > 0) {
            fs.writeFileSync(manifestPath, JSON.stringify(items, null, 2), 'utf8');
        }
        return items;
    };
    const writeManifest = (items) => {
        if (database) {
            database.upsertHistoryAssets(items);
            return;
        }
        fs.writeFileSync(manifestPath, JSON.stringify(items, null, 2), 'utf8');
    };
    const findExistingLocalAsset = (previewUrl) => {
        const prefixPattern = new RegExp(`${publicUrlPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/?#]+)`);
        const match = previewUrl.match(prefixPattern);
        const filename = match?.[1];
        if (!filename)
            return null;
        const filePath = path.join(rootDir, path.basename(filename));
        return fs.existsSync(filePath) ? `${publicUrlPrefix}/${path.basename(filename)}` : null;
    };
    const resolveLocalAssetPath = (publicUrl) => {
        if (!publicUrl?.startsWith(`${publicUrlPrefix}/`))
            return null;
        const relativePath = decodeURIComponent(publicUrl.slice(publicUrlPrefix.length + 1));
        const resolvedPath = path.resolve(rootDir, relativePath);
        const resolvedRoot = `${path.resolve(rootDir)}${path.sep}`;
        return resolvedPath.startsWith(resolvedRoot) ? resolvedPath : null;
    };
    const attachThumbnail = async (item, sourcePath) => {
        if (!createThumbnail || item.kind === 'audio')
            return item;
        try {
            const thumbnail = await createThumbnail(sourcePath, item.kind, item.id);
            return { ...item, thumbnailUrl: thumbnail.publicUrl };
        }
        catch {
            return item;
        }
    };
    const collectLocalAssetUrls = (value, urls) => {
        if (typeof value === 'string') {
            if (value.startsWith(`${publicUrlPrefix}/`))
                urls.add(value);
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((item) => collectLocalAssetUrls(item, urls));
            return;
        }
        if (!value || typeof value !== 'object')
            return;
        Object.values(value).forEach((item) => collectLocalAssetUrls(item, urls));
    };
    const reclaimDeletedAssets = ({ assets, detachedData, excludedCanvasScope }) => {
        const candidates = new Set();
        assets.forEach((item) => {
            collectLocalAssetUrls(item.previewUrl, candidates);
            collectLocalAssetUrls(item.thumbnailUrl, candidates);
        });
        collectLocalAssetUrls(detachedData, candidates);
        const referencedUrls = database?.listHistoryAssetFileReferences?.(excludedCanvasScope);
        let reclaimedFiles = 0;
        const blobIds = assets.map((item) => item.blobId).filter((id) => Boolean(id));
        database?.deleteUnreferencedAssetBlobs?.(blobIds).forEach((blob) => {
            if (!fs.existsSync(blob.sourcePath))
                return;
            fs.rmSync(blob.sourcePath, { force: true });
            reclaimedFiles += 1;
        });
        candidates.forEach((publicUrl) => {
            const references = referencedUrls
                ? (referencedUrls.has(publicUrl) ? 1 : 0)
                : database?.countHistoryAssetFileReferences?.(publicUrl, excludedCanvasScope)
                    ?? readManifestFile().filter((item) => item.previewUrl === publicUrl || item.thumbnailUrl === publicUrl).length;
            if (references > 0)
                return;
            const filePath = resolveLocalAssetPath(publicUrl);
            if (!filePath || !fs.existsSync(filePath))
                return;
            try {
                fs.rmSync(filePath, { force: true });
                reclaimedFiles += 1;
            }
            catch (error) {
                console.warn(`Failed to reclaim history asset file: ${filePath}`, error);
            }
        });
        return reclaimedFiles;
    };
    const cacheAssets = async (assets) => {
        const cachedItems = [];
        for (const asset of assets) {
            if (!asset.previewUrl || !asset.kind || !asset.projectId || !asset.canvasId)
                continue;
            const scope = { projectId: asset.projectId, canvasId: asset.canvasId };
            const manifest = readManifest(scope);
            const existingLocalUrl = findExistingLocalAsset(asset.previewUrl);
            const candidateKey = getHistoryAssetDedupeKey({
                id: asset.id || '',
                ...scope,
                name: asset.name || `${asset.kind}-${Date.now()}`,
                kind: asset.kind,
                previewUrl: existingLocalUrl || asset.previewUrl,
                ...(asset.metadata ? { metadata: asset.metadata } : {})
            });
            const existingManifestItem = [...cachedItems, ...manifest].find((item) => getHistoryAssetDedupeKey(item) === candidateKey);
            if (existingManifestItem) {
                cachedItems.push(existingManifestItem);
                continue;
            }
            if (existingLocalUrl) {
                const historyAssetId = asset.id || `history-${asset.kind}-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
                const sourcePath = resolveLocalAssetPath(existingLocalUrl);
                const detected = sourcePath ? await detectMediaFile(sourcePath) : null;
                const managedAsset = sourcePath && detected && persistManagedAsset
                    ? await persistManagedAsset({
                        filePath: sourcePath,
                        fileName: path.basename(sourcePath),
                        detected,
                        historyAsset: { ...asset, id: historyAssetId }
                    })
                    : null;
                const item = {
                    id: historyAssetId,
                    ...scope,
                    name: asset.name || `${asset.kind}-${Date.now()}`,
                    kind: asset.kind,
                    source: asset.source || '生成历史',
                    previewUrl: managedAsset?.fileUrl ?? existingLocalUrl,
                    ...(managedAsset?.blobId ? { blobId: managedAsset.blobId } : {}),
                    ...(managedAsset?.id ? { libraryAssetId: managedAsset.id } : {}),
                    createdAt: asset.createdAt || new Date().toISOString(),
                    ...(asset.metadata ? { metadata: asset.metadata } : {})
                };
                cachedItems.push(!database && sourcePath ? await attachThumbnail(item, sourcePath) : item);
                continue;
            }
            const sourceName = asset.name || `${asset.kind}-${Date.now()}`;
            const historyAssetId = asset.id || `history-${asset.kind}-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
            const sourceUrl = resolveSourceUrl(asset.previewUrl);
            const dataUrlAsset = sourceUrl.startsWith('data:') ? parseDataUrlAsset(sourceUrl) : null;
            let bytes;
            let detected;
            let ext = dataUrlAsset ? contentTypeExtension(dataUrlAsset.contentType) : '';
            if (dataUrlAsset) {
                if (dataUrlAsset.bytes.byteLength > DEFAULT_MAX_REMOTE_MEDIA_BYTES) {
                    throw new Error('缓存资产失败: 媒体超过大小限制');
                }
                const detectedBuffer = await detectMediaBuffer(dataUrlAsset.bytes);
                if (!detectedBuffer || detectedBuffer.kind !== asset.kind) {
                    throw new Error('缓存资产失败: 媒体类型无效');
                }
                detected = detectedBuffer;
                bytes = dataUrlAsset.bytes;
                ext = detectedBuffer.extension;
            }
            else {
                const remote = await fetchRemoteMediaBuffer(sourceUrl, {
                    policy: resolveOutboundPolicy?.(sourceUrl),
                    expectedKind: asset.kind
                });
                ext = remote.detected.extension;
                detected = remote.detected;
                bytes = remote.bytes;
            }
            ext || (ext = asset.kind === 'video' ? '.mp4' : asset.kind === 'audio' ? '.mp3' : '.png');
            const filename = safeAssetFileName(sourceName, ext);
            const filePath = path.join(rootDir, filename);
            fs.writeFileSync(filePath, bytes);
            const managedAsset = persistManagedAsset
                ? await persistManagedAsset({
                    filePath,
                    fileName: filename,
                    detected,
                    historyAsset: { ...asset, id: historyAssetId }
                })
                : null;
            const item = {
                id: historyAssetId,
                ...scope,
                name: sourceName,
                kind: asset.kind,
                source: asset.source || '生成历史',
                previewUrl: managedAsset?.fileUrl ?? `${publicUrlPrefix}/${filename}`,
                ...(managedAsset?.id ? { libraryAssetId: managedAsset.id } : {}),
                ...(managedAsset?.blobId ? { blobId: managedAsset.blobId } : {}),
                ...(managedAsset?.id && asset.kind !== 'audio' ? {
                    thumbnailUrl: managedAsset.thumbnailUrl
                        ?? `/api/library-assets/${encodeURIComponent(managedAsset.id)}/thumbnail`
                } : {}),
                createdAt: asset.createdAt || new Date().toISOString(),
                ...(asset.metadata ? { metadata: asset.metadata } : {})
            };
            cachedItems.push(database ? item : await attachThumbnail(item, filePath));
        }
        if (database) {
            database.upsertHistoryAssets(cachedItems);
            cachedItems.forEach((item) => {
                if (item.kind !== 'audio' && item.projectId && item.canvasId) {
                    void ensureThumbnail(item.id, { projectId: item.projectId, canvasId: item.canvasId });
                }
            });
        }
        else {
            const manifest = readManifestFile();
            const { items: merged } = dedupeHistoryAssets([...cachedItems, ...manifest].filter((item, index, list) => (list.findIndex((candidate) => candidate.id === item.id) === index)));
            writeManifest(merged);
        }
        return cachedItems;
    };
    const deleteAssets = (ids, scope) => {
        const idSet = new Set(ids);
        const manifest = database ? readManifest(scope) : readManifestFile();
        const deleting = manifest.filter((item) => (idSet.has(item.id) && item.projectId === scope.projectId && item.canvasId === scope.canvasId));
        if (database) {
            database.deleteHistoryAssets(ids, scope);
            const blobIds = deleting.map((item) => item.blobId).filter((id) => Boolean(id));
            database.deleteUnreferencedAssetBlobs?.(blobIds).forEach((blob) => {
                if (fs.existsSync(blob.sourcePath))
                    fs.rmSync(blob.sourcePath, { force: true });
            });
        }
        else {
            const deletingIds = new Set(deleting.map((item) => item.id));
            const remaining = manifest.filter((item) => !deletingIds.has(item.id));
            writeManifest(remaining);
        }
        reclaimDeletedAssets({ assets: deleting });
        return deleting.length;
    };
    const reclaimOrphanFiles = () => {
        let scannedFiles = 0;
        let reclaimedFiles = 0;
        const referencedUrls = database?.listHistoryAssetFileReferences?.();
        const visit = (directory) => {
            fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
                const filePath = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    visit(filePath);
                    return;
                }
                if (!entry.isFile() || entry.name === 'manifest.json' || entry.name.startsWith('.') || entry.name.endsWith('.tmp'))
                    return;
                scannedFiles += 1;
                const relativePath = path.relative(rootDir, filePath).split(path.sep).map(encodeURIComponent).join('/');
                const publicUrl = `${publicUrlPrefix}/${relativePath}`;
                const references = referencedUrls
                    ? (referencedUrls.has(publicUrl) ? 1 : 0)
                    : database?.countHistoryAssetFileReferences?.(publicUrl)
                        ?? readManifestFile().filter((item) => item.previewUrl === publicUrl || item.thumbnailUrl === publicUrl).length;
                if (references > 0)
                    return;
                try {
                    fs.rmSync(filePath, { force: true });
                    reclaimedFiles += 1;
                }
                catch (error) {
                    console.warn(`Failed to reclaim orphan history asset file: ${filePath}`, error);
                }
            });
        };
        visit(rootDir);
        return { scannedFiles, reclaimedFiles };
    };
    const updateAsset = (id, scope, patch) => {
        if (database?.updateHistoryAsset)
            return database.updateHistoryAsset(id, scope, patch);
        const manifest = readManifestFile();
        const existing = manifest.find((item) => (item.id === id && item.projectId === scope.projectId && item.canvasId === scope.canvasId));
        if (!existing)
            return null;
        const updated = {
            ...existing,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.source !== undefined ? { source: patch.source } : {}),
            ...(patch.metadata !== undefined ? { metadata: { ...existing.metadata, ...patch.metadata } } : {})
        };
        writeManifest(manifest.map((item) => (item.id === id && item.projectId === scope.projectId && item.canvasId === scope.canvasId ? updated : item)));
        return updated;
    };
    const getAsset = (id, scope) => (database?.getHistoryAsset?.(id, scope)
        ?? readManifest(scope).find((item) => item.id === id)
        ?? null);
    const getAssetFile = (id, scope) => {
        const asset = getAsset(id, scope);
        const blob = asset?.blobId ? database?.getAssetBlob?.(asset.blobId) : null;
        if (!asset || !blob || !fs.existsSync(blob.sourcePath))
            return null;
        return { sourcePath: blob.sourcePath, mimeType: blob.mimeType };
    };
    const getDeletionImpact = (ids, scope) => (database?.listHistoryDeletionImpact?.(ids, scope)
        ?? ids.flatMap((id) => {
            const asset = getAsset(id, scope);
            return asset ? [{ id: asset.id, name: asset.name, references: [] }] : [];
        }));
    const listPage = (query) => {
        const limit = Math.min(200, Math.max(1, query.limit));
        const cursorPoint = decodeCursor(query.cursor);
        const order = query.order ?? 'desc';
        let items = database?.listHistoryAssetsPage
            ? database.listHistoryAssetsPage({ ...query, order, limit: limit + 1, ...(cursorPoint ? { cursorPoint } : {}) })
            : readManifest(query)
                .filter((item) => !query.kind || item.kind === query.kind)
                .filter((item) => !query.kinds || query.kinds.includes(item.kind))
                .filter((item) => !query.providerId || item.metadata?.providerId === query.providerId)
                .filter((item) => !query.model || item.metadata?.model === query.model)
                .filter((item) => {
                const term = query.query?.trim().toLocaleLowerCase();
                return !term || [item.name, item.source, item.metadata?.model, item.metadata?.prompt]
                    .some((value) => String(value ?? '').toLocaleLowerCase().includes(term));
            })
                .sort((left, right) => {
                const result = `${left.createdAt ?? ''}\0${left.id}`.localeCompare(`${right.createdAt ?? ''}\0${right.id}`);
                return order === 'asc' ? result : -result;
            })
                .filter((item) => !cursorPoint || (order === 'asc'
                ? `${item.createdAt ?? ''}\0${item.id}` > `${cursorPoint.createdAt}\0${cursorPoint.id}`
                : `${item.createdAt ?? ''}\0${item.id}` < `${cursorPoint.createdAt}\0${cursorPoint.id}`))
                .slice(0, limit + 1);
        const hasMore = items.length > limit;
        items = items.slice(0, limit);
        const last = items.at(-1);
        return {
            items,
            counts: database?.countHistoryAssetsByKind?.(query) ?? {
                image: readManifest(query).filter((item) => item.kind === 'image').length,
                video: readManifest(query).filter((item) => item.kind === 'video').length,
                audio: readManifest(query).filter((item) => item.kind === 'audio').length
            },
            hasMore,
            nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt ?? '', id: last.id }) : null
        };
    };
    const thumbnailTasks = new Map();
    const ensureThumbnail = async (id, scope) => {
        const asset = getAsset(id, scope);
        if (!asset || asset.kind === 'audio' || !asset.previewUrl)
            return asset;
        if (asset.thumbnailUrl)
            return asset;
        const taskKey = `${scope.projectId}:${scope.canvasId}:${id}`;
        const pending = thumbnailTasks.get(taskKey);
        if (pending)
            return pending;
        const task = (async () => {
            const sourcePath = asset.blobId
                ? database?.getAssetBlob?.(asset.blobId)?.sourcePath ?? null
                : resolveLocalAssetPath(asset.previewUrl);
            if (!sourcePath || !createThumbnail)
                return asset;
            if (!fs.existsSync(sourcePath))
                return asset;
            const thumbnail = await createThumbnail(sourcePath, asset.kind, asset.id);
            if (database?.updateHistoryAssetThumbnail) {
                database.updateHistoryAssetThumbnail(asset.id, thumbnail.publicUrl);
            }
            else {
                writeManifest(readManifestFile().map((item) => (item.id === asset.id && item.projectId === scope.projectId && item.canvasId === scope.canvasId
                    ? { ...item, thumbnailUrl: thumbnail.publicUrl }
                    : item)));
            }
            return { ...asset, thumbnailUrl: thumbnail.publicUrl };
        })().catch(() => asset).finally(() => thumbnailTasks.delete(taskKey));
        thumbnailTasks.set(taskKey, task);
        return task;
    };
    return {
        rootDir,
        readManifest,
        listPage,
        getAsset,
        getAssetFile,
        getDeletionImpact,
        ensureThumbnail,
        cacheAssets,
        deleteAssets,
        reclaimDeletedAssets,
        reclaimOrphanFiles,
        updateAsset
    };
};
