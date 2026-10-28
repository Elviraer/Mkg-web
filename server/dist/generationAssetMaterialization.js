import { fetchRemoteMediaBuffer } from './remoteMedia.js';
const isMediaKind = (kind) => (kind === 'image' || kind === 'video' || kind === 'audio');
const isRemoteUrl = (value) => /^https?:\/\//i.test(value);
const resultPreviewUrls = (result) => (result.previewUrls?.filter(Boolean) ?? (result.previewUrl ? [result.previewUrl] : []));
/**
 * A remote provider URL is previewable but cannot be supplied to FFmpeg or other
 * local media tools. Materialize it before exposing the terminal task result so
 * every completed media node receives an MK-owned History/AssetBlob URL.
 */
export const materializeCompletedGenerationAssets = async ({ result, kind, projectId, canvasId, taskId, fallbackOutboundPolicy, resolveTrustedAssetPolicy, persistGeneratedMedia, }) => {
    if (result.status !== 'completed' || !isMediaKind(kind))
        return result;
    const previewUrls = resultPreviewUrls(result);
    if (!previewUrls.some(isRemoteUrl))
        return result;
    if (!persistGeneratedMedia || !projectId || !canvasId) {
        throw new Error('生成结果缺少 MK 本地素材归档范围，无法发布可处理媒体');
    }
    const materialized = await Promise.all(previewUrls.map(async (url, index) => {
        if (!isRemoteUrl(url)) {
            const historyAssetId = result.historyAssetIds?.[index];
            return { previewUrl: url, ...(historyAssetId ? { historyAssetId } : {}) };
        }
        const { bytes, detected } = await fetchRemoteMediaBuffer(url, {
            policy: resolveTrustedAssetPolicy?.(url) ?? fallbackOutboundPolicy,
            expectedKind: kind,
        });
        return persistGeneratedMedia({
            bytes,
            contentType: detected.mime,
            fileName: `generated-${taskId}-${String(index + 1).padStart(2, '0')}${detected.extension}`,
            kind,
            projectId,
            canvasId,
        });
    }));
    const materializedUrls = materialized.map((asset) => asset.previewUrl);
    const historyAssetIds = materialized.map((asset) => asset.historyAssetId);
    return {
        ...result,
        previewUrl: materializedUrls[0],
        previewUrls: materializedUrls,
        ...(historyAssetIds.every((id) => Boolean(id)) ? { historyAssetIds } : {}),
        message: '生成完成，结果已归档为 MK 受控素材',
    };
};
