import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export const createDerivedHistoryAssetWriter = ({ historyAssetsDir, cacheAssets }) => async ({ filePath, fileName, kind, scope, source, metadata }) => {
    const temporaryName = `${Date.now()}-${randomUUID()}${path.extname(fileName) || '.upload'}`;
    const temporaryPath = path.join(historyAssetsDir, temporaryName);
    fs.copyFileSync(filePath, temporaryPath);
    try {
        const id = `history-${kind}-${randomUUID()}`;
        const [asset] = await cacheAssets([{
                id,
                ...scope,
                name: fileName,
                kind,
                source,
                previewUrl: `/api/history-assets/files/${encodeURIComponent(temporaryName)}`,
                createdAt: new Date().toISOString(),
                ...(metadata ? { metadata } : {})
            }]);
        if (!asset)
            throw new Error('历史资产写入失败');
        return asset;
    }
    catch (error) {
        fs.rmSync(temporaryPath, { force: true });
        throw error;
    }
};
