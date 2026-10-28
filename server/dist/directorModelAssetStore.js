import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const extensions = new Set(['.fbx', '.obj', '.glb']);
const deletionGraceMs = 24 * 60 * 60 * 1000;
const hashFile = async (filePath) => {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath))
        hash.update(chunk);
    return hash.digest('hex');
};
const toPublicAsset = ({ sourcePath: _sourcePath, retained: _retained, releasedAt: _releasedAt, ...asset }) => ({
    ...asset,
    fileUrl: `/api/director-model-assets/${encodeURIComponent(asset.id)}/file`
});
const collectModelIds = (value, ids) => {
    if (Array.isArray(value)) {
        value.forEach((item) => collectModelIds(item, ids));
        return;
    }
    if (!value || typeof value !== 'object')
        return;
    Object.entries(value).forEach(([key, item]) => {
        if (key === 'directorModelAssetId' && typeof item === 'string')
            ids.add(item);
        else
            collectModelIds(item, ids);
    });
};
export const createDirectorModelAssetStore = ({ appDatabase, rootDir }) => {
    fs.mkdirSync(rootDir, { recursive: true });
    const removeRecordsAndFiles = (ids) => {
        const protectedIds = appDatabase.listReferencedDirectorModelAssetIds(ids);
        const deleted = appDatabase.deleteDirectorModelAssets(ids.filter((id) => !protectedIds.has(id)));
        deleted.forEach((asset) => fs.rmSync(asset.sourcePath, { force: true }));
        return { deleted: deleted.length, protectedIds: Array.from(protectedIds) };
    };
    const reclaimUnretainedAssets = (candidateIds) => {
        const releasedIds = new Set(appDatabase.listReleasedDirectorModelAssets().map((asset) => asset.id));
        const ids = candidateIds ? candidateIds.filter((id) => releasedIds.has(id)) : Array.from(releasedIds);
        return removeRecordsAndFiles(ids);
    };
    const getFile = (id) => {
        const asset = appDatabase.getDirectorModelAsset(id);
        return asset && fs.existsSync(asset.sourcePath) ? asset : null;
    };
    return {
        async importFile(temporaryPath, originalName, options = {}) {
            const extension = path.extname(originalName).toLowerCase();
            if (!extensions.has(extension))
                throw new Error('导演台模型仅支持 FBX、OBJ 或 GLB');
            const stat = fs.statSync(temporaryPath);
            if (!stat.isFile() || stat.size === 0)
                throw new Error('导演台模型文件为空');
            const contentHash = await hashFile(temporaryPath);
            const existing = appDatabase.getDirectorModelAssetByHash(contentHash);
            if (existing) {
                fs.rmSync(temporaryPath, { force: true });
                if (options.retained !== false && !existing.retained) {
                    appDatabase.setDirectorModelAssetsRetained([existing.id], true);
                }
                return { asset: toPublicAsset(appDatabase.getDirectorModelAsset(existing.id)), deduplicated: true };
            }
            const storedPath = path.join(rootDir, `${contentHash}${extension}`);
            if (fs.existsSync(storedPath))
                fs.rmSync(temporaryPath, { force: true });
            else
                fs.renameSync(temporaryPath, storedPath);
            const fileName = path.basename(originalName).slice(0, 180) || `model${extension}`;
            const record = appDatabase.createDirectorModelAsset({
                id: `director-model-${randomUUID()}`,
                name: fileName.replace(/\.[^.]+$/, ''),
                fileName,
                extension,
                mimeType: extension === '.glb' ? 'model/gltf-binary' : 'application/octet-stream',
                byteSize: stat.size,
                contentHash,
                sourcePath: storedPath,
                retained: options.retained !== false,
                createdAt: new Date().toISOString()
            });
            return { asset: toPublicAsset(record), deduplicated: false };
        },
        get(id) {
            const asset = appDatabase.getDirectorModelAsset(id);
            return asset ? toPublicAsset(asset) : null;
        },
        getFile,
        resolveSourceUrl(sourceUrl) {
            let pathname;
            try {
                pathname = new URL(sourceUrl, 'http://mk.local').pathname;
            }
            catch {
                return null;
            }
            const match = pathname.match(/^\/api\/director-model-assets\/([^/]+)\/file$/);
            if (!match)
                return null;
            let id;
            try {
                id = decodeURIComponent(match[1]);
            }
            catch {
                return null;
            }
            return getFile(id)?.sourcePath ?? null;
        },
        delete(ids) {
            appDatabase.setDirectorModelAssetsRetained(ids, false);
            return reclaimUnretainedAssets(ids);
        },
        reclaimDetachedProjectAssets(detachedData) {
            const ids = new Set();
            collectModelIds(detachedData, ids);
            return reclaimUnretainedAssets(Array.from(ids)).deleted;
        },
        reclaimPendingDeletionAssets(now = Date.now()) {
            return removeRecordsAndFiles(appDatabase.listPendingDeletionDirectorModelAssets()
                .filter((asset) => asset.releasedAt && now - Date.parse(asset.releasedAt) >= deletionGraceMs)
                .map((asset) => asset.id)).deleted;
        }
    };
};
