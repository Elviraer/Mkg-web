import { XYQ_REFERENCE_IMAGE_LIMIT } from '@ftv/shared';
import { extractGenerationUrls, normalizeGenerationStatus } from '../generationParsers.js';
import { firstHealthyGateway } from '../gatewayClient.js';
import { fetchJson } from '../httpClient.js';
import { createProviderOutboundPolicy, resolveProvider } from '../providers.js';
import { readErrorMessage, readField, readString } from '../unknownJson.js';
import { normalizeXyqImageRatio, normalizeXyqImageResolution, normalizeXyqVideoDuration, normalizeXyqVideoRatio } from './parameterCapabilities.js';
const isXyqReferenceImageInput = (value) => (value !== null);
export const submitXyqGeneration = async ({ kind, providerId, provider, effectiveBaseUrl, effectiveApiKey, cleanPrompt, cleanModel, ratio, resolution, duration, executionTimeoutMs, signal, references }) => {
    if (references.rawImageRefs.length > XYQ_REFERENCE_IMAGE_LIMIT) {
        throw new Error(`小云雀参考图最多支持 ${XYQ_REFERENCE_IMAGE_LIMIT} 张，实际 ${references.rawImageRefs.length} 张`);
    }
    if (kind === 'video' && references.rawAudioRefs.length > 4) {
        throw new Error(`小云雀音频参考最多支持 4 个，实际 ${references.rawAudioRefs.length} 个`);
    }
    const authHeaders = {};
    if (effectiveApiKey)
        authHeaders.Authorization = `Bearer ${effectiveApiKey}`;
    const headers = { ...authHeaders, 'Content-Type': 'application/json' };
    const { baseUrl: healthyBaseUrl } = await firstHealthyGateway(provider?.id, effectiveBaseUrl, '/healthz', { headers: authHeaders });
    const xyqReferenceImages = (await Promise.all(references.rawImageRefs.map((ref) => references.toXyqReferenceImageInput(ref, healthyBaseUrl, authHeaders)))).filter(isXyqReferenceImageInput);
    const xyqReferenceAudios = kind === 'video'
        ? (await Promise.all(references.rawAudioRefs.map((ref) => references.toXyqReferenceAudioInput(ref, healthyBaseUrl, authHeaders)))).filter(isXyqReferenceImageInput)
        : [];
    const payload = kind === 'image'
        ? {
            prompt: cleanPrompt,
            model: 'xyq-image-1',
            xyq_model: cleanModel,
            xyq_ratio: normalizeXyqImageRatio(ratio),
            xyq_resolution: normalizeXyqImageResolution(resolution),
            xyq_reference_images: xyqReferenceImages,
            xyq_async: true,
            response_format: 'url',
            n: 1
        }
        : {
            prompt: cleanPrompt,
            model: 'xyq-video-1',
            xyq_model: cleanModel,
            xyq_ratio: normalizeXyqVideoRatio(ratio),
            duration: normalizeXyqVideoDuration(duration),
            xyq_reference_images: xyqReferenceImages,
            ...(xyqReferenceAudios.length > 0 ? { xyq_reference_audios: xyqReferenceAudios } : {})
        };
    const endpoint = kind === 'image' ? 'images/generations' : 'videos/generations';
    const { response, data } = await fetchJson(`${healthyBaseUrl}/v1/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(payload), ...(signal ? { signal } : {}) }, executionTimeoutMs ?? 20000, createProviderOutboundPolicy(provider ?? resolveProvider(providerId), healthyBaseUrl));
    if (!response.ok) {
        throw new Error(readErrorMessage(data, `HTTP ${response.status}`));
    }
    const previewUrls = extractGenerationUrls(data);
    const normalizedStatus = previewUrls.length > 0 ? 'completed' : normalizeGenerationStatus(readField(data, 'status'));
    return {
        ok: true,
        providerId: 'xyq',
        status: normalizedStatus,
        taskId: readString(data, 'id'),
        previewUrl: previewUrls[0],
        previewUrls,
        message: previewUrls.length > 0 ? '小云雀生成完成' : (normalizedStatus === 'processing' ? '小云雀异步生成中' : '小云雀任务已提交'),
        referenceCount: xyqReferenceImages.length + xyqReferenceAudios.length
    };
};
export const queryXyqGenerationStatus = async ({ kind, providerId, provider, effectiveBaseUrl, effectiveApiKey, taskId, requestTimeoutMs, signal }) => {
    const headers = {};
    if (effectiveApiKey)
        headers.Authorization = `Bearer ${effectiveApiKey}`;
    const { baseUrl: healthyBaseUrl } = await firstHealthyGateway(provider?.id, effectiveBaseUrl, '/healthz', { headers });
    const endpoint = kind === 'image' ? 'images/generations' : 'videos/generations';
    const { response, data } = await fetchJson(`${healthyBaseUrl}/v1/${endpoint}/${encodeURIComponent(taskId)}`, { headers, ...(signal ? { signal } : {}) }, requestTimeoutMs ?? 10000, createProviderOutboundPolicy(provider ?? resolveProvider(providerId), healthyBaseUrl));
    if (!response.ok) {
        throw new Error(readErrorMessage(data, `HTTP ${response.status}`));
    }
    const previewUrls = extractGenerationUrls(data);
    const status = previewUrls.length > 0 ? 'completed' : normalizeGenerationStatus(readField(data, 'status'));
    return {
        ok: true,
        providerId: 'xyq',
        status,
        taskId,
        previewUrl: previewUrls[0],
        previewUrls,
        message: status === 'completed'
            ? '小云雀生成完成'
            : status === 'failed'
                ? readErrorMessage(data, '小云雀生成失败')
                : status === 'processing'
                    ? '小云雀异步生成中'
                    : '小云雀任务排队中'
    };
};
