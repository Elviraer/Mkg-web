import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyCanonicalMediaExtension } from './mediaFileType.js';
export const hashAssetFile = async (filePath) => {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath))
        hash.update(chunk);
    return hash.digest('hex');
};
export const persistAssetBlobFile = async ({ appDatabase, assetBlobsDir, filePath, detected }) => {
    fs.mkdirSync(assetBlobsDir, { recursive: true });
    const canonical = await applyCanonicalMediaExtension({ path: filePath, filename: path.basename(filePath) }, detected);
    const contentHash = await hashAssetFile(canonical.path);
    const existing = appDatabase.getAssetBlobByHash(contentHash);
    if (existing) {
        if (!fs.existsSync(existing.sourcePath)) {
            fs.mkdirSync(path.dirname(existing.sourcePath), { recursive: true });
            fs.renameSync(canonical.path, existing.sourcePath);
        }
        else {
            fs.rmSync(canonical.path, { force: true });
        }
        return { blob: existing, deduplicated: true };
    }
    const storedPath = path.join(assetBlobsDir, `${contentHash}${detected.extension}`);
    if (path.resolve(canonical.path) !== path.resolve(storedPath)) {
        if (fs.existsSync(storedPath))
            fs.rmSync(canonical.path, { force: true });
        else
            fs.renameSync(canonical.path, storedPath);
    }
    const timestamp = new Date().toISOString();
    const stat = fs.statSync(storedPath);
    const blob = {
        id: `blob-${randomUUID()}`,
        kind: detected.kind,
        mimeType: detected.mime,
        sizeBytes: stat.size,
        contentHash,
        sourcePath: storedPath,
        createdAt: timestamp,
        updatedAt: timestamp
    };
    try {
        return { blob: appDatabase.createAssetBlob(blob), deduplicated: false };
    }
    catch (error) {
        const concurrent = appDatabase.getAssetBlobByHash(contentHash);
        if (concurrent)
            return { blob: concurrent, deduplicated: true };
        throw error;
    }
};
