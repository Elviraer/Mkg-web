import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isAssetRef } from '@ftv/shared';
import { Router } from 'express';
const readText = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const revealInFileManager = (sourcePath) => {
    const resolved = fs.realpathSync(sourcePath);
    const command = process.platform === 'win32'
        // Explorer parses /select and its target as one command-line argument. Keeping the
        // process visible is essential here: this command is explicitly a user-facing reveal.
        ? { executable: path.join(process.env.WINDIR || 'C:\\Windows', 'explorer.exe'), args: [`/select,${resolved}`] }
        : process.platform === 'darwin'
            ? { executable: 'open', args: ['-R', resolved] }
            : { executable: 'xdg-open', args: [path.dirname(resolved)] };
    return new Promise((resolve, reject) => {
        const child = spawn(command.executable, command.args, { windowsHide: false, detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
};
const libraryStatus = (asset) => {
    if (!asset.sourcePath || !fs.existsSync(asset.sourcePath))
        return 'missing-file';
    if (asset.storageMode !== 'linked')
        return 'ready';
    const stat = fs.statSync(asset.sourcePath);
    return stat.isFile()
        && stat.size === asset.sourceSizeBytes
        && Math.trunc(stat.mtimeMs) === Math.trunc(asset.sourceModifiedAtMs ?? -1)
        ? 'ready'
        : 'changed-source';
};
export const createAssetIdentityRoutes = (appDatabase, { sourceRoots = [], resolveManagedSource, revealFile = revealInFileManager } = {}) => {
    const router = Router();
    const resolveControlledSource = (sourceUrl) => {
        if (!sourceUrl)
            return undefined;
        const managed = resolveManagedSource?.(sourceUrl);
        if (managed && fs.existsSync(managed) && fs.statSync(managed).isFile())
            return fs.realpathSync(managed);
        let pathname;
        try {
            pathname = new URL(sourceUrl, 'http://mk.local').pathname;
        }
        catch {
            return undefined;
        }
        for (const sourceRoot of sourceRoots) {
            if (!pathname.startsWith(`${sourceRoot.prefix}/`))
                continue;
            let relativePath;
            try {
                relativePath = decodeURIComponent(pathname.slice(sourceRoot.prefix.length + 1));
            }
            catch {
                return undefined;
            }
            if (!relativePath)
                return undefined;
            const rootDir = path.resolve(sourceRoot.rootDir);
            const candidate = path.resolve(rootDir, relativePath);
            if (candidate !== rootDir && !candidate.startsWith(`${rootDir}${path.sep}`))
                return undefined;
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
                return fs.realpathSync(candidate);
        }
        return undefined;
    };
    const resolveLibrary = (ref) => {
        const asset = appDatabase.getLibraryAsset(ref.assetId);
        if (!asset)
            return { ref, status: 'missing-identity' };
        return {
            ref,
            status: libraryStatus(asset),
            kind: asset.kind,
            name: asset.name,
            mimeType: asset.mimeType,
            fileUrl: asset.fileUrl,
            ...(asset.thumbnailUrl ? { thumbnailUrl: asset.thumbnailUrl } : {})
        };
    };
    const readRoleImage = (roleId, imageId) => {
        const role = appDatabase.getRole(roleId);
        const images = [
            ...(Array.isArray(role?.images) ? role.images : []),
            ...(Array.isArray(role?.retiredImages) ? role.retiredImages : [])
        ];
        return images.find((item) => Boolean(item && typeof item === 'object' && !Array.isArray(item) && item.id === imageId)) ?? null;
    };
    router.post('/asset-refs/resolve', (request, response) => {
        const rawRefs = Array.isArray(request.body?.refs) ? request.body.refs : [];
        const refs = rawRefs.filter(isAssetRef).slice(0, 200);
        if (refs.length === 0 || refs.length !== rawRefs.length) {
            response.status(400).json({ ok: false, message: 'refs must contain 1-200 valid asset references' });
            return;
        }
        const projectId = readText(request.body?.projectId);
        const canvasId = readText(request.body?.canvasId);
        const items = refs.map((ref) => {
            if (ref.owner === 'library')
                return resolveLibrary(ref);
            if (ref.owner === 'history') {
                if (!projectId || !canvasId)
                    return { ref, status: 'missing-identity' };
                const asset = appDatabase.getHistoryAsset(ref.assetId, { projectId, canvasId });
                if (!asset)
                    return { ref, status: 'missing-identity' };
                const blob = asset.blobId ? appDatabase.getAssetBlob(asset.blobId) : null;
                if (!blob) {
                    const legacy = asset.libraryAssetId ? appDatabase.getLibraryAsset(asset.libraryAssetId) : null;
                    return legacy ? { ...resolveLibrary({ owner: 'library', assetId: legacy.id }), ref } : { ref, status: 'missing-file' };
                }
                return {
                    ref,
                    status: fs.existsSync(blob.sourcePath) ? 'ready' : 'missing-file',
                    kind: blob.kind,
                    name: asset.name,
                    mimeType: blob.mimeType,
                    fileUrl: `/api/history-assets/${encodeURIComponent(asset.id)}/file?${new URLSearchParams({ projectId, canvasId })}`,
                    ...(asset.thumbnailUrl || blob.thumbnailUrl ? { thumbnailUrl: asset.thumbnailUrl ?? blob.thumbnailUrl } : {})
                };
            }
            const image = readRoleImage(ref.roleId, ref.imageId);
            if (!image)
                return { ref, status: 'missing-identity' };
            const blobId = readText(image.blobId);
            const blob = blobId ? appDatabase.getAssetBlob(blobId) : null;
            if (blob) {
                const name = readText(image.name);
                return {
                    ref,
                    status: fs.existsSync(blob.sourcePath) ? 'ready' : 'missing-file',
                    kind: blob.kind,
                    mimeType: blob.mimeType,
                    ...(name ? { name } : {}),
                    fileUrl: `/api/roles/${encodeURIComponent(ref.roleId)}/images/${encodeURIComponent(ref.imageId)}/file`,
                    ...(readText(image.thumbnailUrl) || blob.thumbnailUrl ? { thumbnailUrl: readText(image.thumbnailUrl) ?? blob.thumbnailUrl } : {})
                };
            }
            const legacyId = readText(image.libraryAssetId);
            return legacyId
                ? { ...resolveLibrary({ owner: 'library', assetId: legacyId }), ref }
                : { ref, status: 'missing-file' };
        });
        response.json({ ok: true, items });
    });
    router.post('/asset-refs/reveal', async (request, response) => {
        const ref = isAssetRef(request.body?.ref) ? request.body.ref : null;
        const projectId = readText(request.body?.projectId);
        const canvasId = readText(request.body?.canvasId);
        const sourceUrl = readText(request.body?.sourceUrl);
        if (!ref && !sourceUrl) {
            response.status(400).json({ ok: false, message: 'ref or a controlled sourceUrl is required' });
            return;
        }
        let sourcePath;
        if (ref?.owner === 'library') {
            const asset = appDatabase.getLibraryAsset(ref.assetId);
            sourcePath = asset?.sourcePath
                ?? (asset?.blobId ? appDatabase.getAssetBlob(asset.blobId)?.sourcePath : undefined)
                ?? (asset ? appDatabase.resolveLibraryAssetSource(asset.fileUrl) ?? undefined : undefined);
        }
        else if (ref?.owner === 'history') {
            if (!projectId || !canvasId) {
                response.status(400).json({ ok: false, message: 'projectId and canvasId are required for history assets' });
                return;
            }
            // A duplicated canvas can retain the authoritative history identity while the
            // original record owns the Blob. The Blob remains local and revealable.
            const asset = appDatabase.getHistoryAsset(ref.assetId, { projectId, canvasId })
                ?? appDatabase.getHistoryAssetById(ref.assetId);
            sourcePath = asset?.blobId ? appDatabase.getAssetBlob(asset.blobId)?.sourcePath : undefined;
            if (!sourcePath && asset?.libraryAssetId) {
                const libraryAsset = appDatabase.getLibraryAsset(asset.libraryAssetId);
                sourcePath = libraryAsset?.sourcePath
                    ?? (libraryAsset?.blobId ? appDatabase.getAssetBlob(libraryAsset.blobId)?.sourcePath : undefined);
            }
        }
        else if (ref?.owner === 'role') {
            const image = readRoleImage(ref.roleId, ref.imageId);
            const blobId = image ? readText(image.blobId) : undefined;
            sourcePath = blobId ? appDatabase.getAssetBlob(blobId)?.sourcePath : undefined;
            if (!sourcePath && image) {
                const libraryAssetId = readText(image.libraryAssetId);
                sourcePath = libraryAssetId ? appDatabase.getLibraryAsset(libraryAssetId)?.sourcePath : undefined;
            }
        }
        sourcePath ?? (sourcePath = resolveControlledSource(sourceUrl));
        if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
            response.status(404).json({ ok: false, code: 'asset_file_not_found', message: '资源文件不存在或已不可用' });
            return;
        }
        try {
            await revealFile(sourcePath);
            response.json({ ok: true });
        }
        catch {
            response.status(500).json({ ok: false, code: 'asset_reveal_failed', message: '无法打开资源所在位置' });
        }
    });
    router.post('/history-assets/fork', (request, response) => {
        const projectId = readText(request.body?.projectId);
        const canvasId = readText(request.body?.canvasId);
        const rawIds = Array.isArray(request.body?.ids) ? request.body.ids : [];
        const ids = Array.from(new Set(rawIds.map(readText).filter((id) => Boolean(id)))).slice(0, 500);
        if (!projectId || !canvasId || ids.length === 0 || ids.length !== rawIds.length) {
            response.status(400).json({ ok: false, message: 'projectId, canvasId and 1-500 history IDs are required' });
            return;
        }
        const mappings = [];
        ids.forEach((sourceAssetId) => {
            const source = appDatabase.getHistoryAssetById(sourceAssetId);
            if (!source)
                return;
            if (source.projectId === projectId && source.canvasId === canvasId) {
                mappings.push({ sourceAssetId, targetAssetId: sourceAssetId });
                return;
            }
            const digest = createHash('sha256')
                .update(`${projectId}\0${canvasId}\0${sourceAssetId}`)
                .digest('hex')
                .slice(0, 32);
            const targetAssetId = `history-fork-${digest}`;
            appDatabase.upsertHistoryAssets([{
                    ...source,
                    id: targetAssetId,
                    projectId,
                    canvasId,
                    previewUrl: `/api/history-assets/${encodeURIComponent(targetAssetId)}/file?${new URLSearchParams({ projectId, canvasId })}`,
                    createdAt: new Date().toISOString(),
                    metadata: { ...source.metadata, originHistoryAssetId: sourceAssetId }
                }]);
            mappings.push({ sourceAssetId, targetAssetId });
        });
        response.json({ ok: true, mappings });
    });
    router.get('/roles/:roleId/images/:imageId/file', (request, response) => {
        const image = readRoleImage(request.params.roleId, request.params.imageId);
        if (!image) {
            response.status(404).json({ ok: false, code: 'role_image_not_found', message: '角色图片不存在' });
            return;
        }
        const blobId = readText(image.blobId);
        const blob = blobId ? appDatabase.getAssetBlob(blobId) : null;
        if (blob && fs.existsSync(blob.sourcePath)) {
            response.type(blob.mimeType);
            response.sendFile(blob.sourcePath);
            return;
        }
        const legacyId = readText(image.libraryAssetId);
        if (legacyId && appDatabase.getLibraryAsset(legacyId)) {
            response.redirect(307, `/api/library-assets/${encodeURIComponent(legacyId)}/file`);
            return;
        }
        response.status(404).json({ ok: false, code: 'role_image_file_not_found', message: '角色图片文件不存在' });
    });
    return router;
};
