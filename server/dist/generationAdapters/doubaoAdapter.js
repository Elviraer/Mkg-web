import { DOUBAO_REFERENCE_IMAGE_LIMIT } from '@mkg/shared';
import { doubaoTaskAssetUrls, normalizeGenerationStatus } from '../generationParsers.js';
import { firstHealthyGateway } from '../gatewayClient.js';
import { fetchJson } from '../httpClient.js';
import { createProviderOutboundPolicy, resolveProvider } from '../providers.js';
import { readBoolean, readErrorMessage, readField, readString } from '../unknownJson.js';
import { normalizeDoubaoImageModel, normalizeDoubaoImageRatio, normalizeDoubaoVideoDuration, normalizeDoubaoVideoModel, normalizeDoubaoVideoRatio } from './parameterCapabilities.js';
const isReferenceFile = (file) => Boolean(file);
export const submitDoubaoGeneration = async ({ kind, providerId, provider, effectiveBaseUrl, cleanPrompt, cleanModel, ratio, duration, accountId, executionTimeoutMs, signal, references }) => {
    if (references.rawImageRefs.length > DOUBAO_REFERENCE_IMAGE_LIMIT) {
        throw new Error(`豆包参考图最多支持 ${DOUBAO_REFERENCE_IMAGE_LIMIT} 张，实际 ${references.rawImageRefs.length} 张`);
    }
    const form = new FormData();
    form.append('prompt', cleanPrompt);
    form.append('ratio', kind === 'image' ? normalizeDoubaoImageRatio(ratio) : normalizeDoubaoVideoRatio(ratio));
    if (accountId)
        form.append('accountId', accountId);
    const endpoint = kind === 'image' ? 'generate-image' : 'generate-video';
    if (kind === 'image') {
        form.append('model', normalizeDoubaoImageModel(cleanModel));
    }
    else {
        const videoModel = normalizeDoubaoVideoModel(cleanModel);
        form.append('model', videoModel);
        form.append('duration', String(normalizeDoubaoVideoDuration(duration, videoModel)));
    }
    const uploadedReferenceFiles = await Promise.all(references.rawImageRefs.map((ref) => references.toReferenceBlob(ref)));
    const referenceFiles = uploadedReferenceFiles.filter(isReferenceFile);
    referenceFiles.forEach((file) => {
        form.append('images', file.blob, file.filename);
    });
    const { baseUrl: healthyBaseUrl } = await firstHealthyGateway(provider?.id, effectiveBaseUrl, '/api/health');
    const { response, data } = await fetchJson(`${healthyBaseUrl}/api/${endpoint}`, { method: 'POST', body: form, ...(signal ? { signal } : {}) }, executionTimeoutMs ?? 15000, createProviderOutboundPolicy(provider ?? resolveProvider(providerId), healthyBaseUrl));
    if (!response.ok || readBoolean(data, 'success') === false) {
        throw new Error(readErrorMessage(data, `HTTP ${response.status}`));
    }
    return {
        ok: true,
        providerId: 'doubao',
        status: 'queued',
        taskId: readString(data, 'taskId') ?? readString(data, 'id'),
        message: readString(data, 'message') ?? '豆包任务已提交',
        referenceCount: referenceFiles.length
    };
};
export const queryDoubaoGenerationStatus = async ({ providerId, provider, effectiveBaseUrl, taskId, requestTimeoutMs, signal }) => {
    const { baseUrl: healthyBaseUrl } = await firstHealthyGateway(provider?.id, effectiveBaseUrl, '/api/health');
    const { response, data } = await fetchJson(`${healthyBaseUrl}/api/tasks/${encodeURIComponent(taskId)}`, signal ? { signal } : {}, requestTimeoutMs ?? 10000, createProviderOutboundPolicy(provider ?? resolveProvider(providerId), healthyBaseUrl));
    if (!response.ok || readBoolean(data, 'success') === false) {
        throw new Error(readErrorMessage(data, `HTTP ${response.status}`));
    }
    const status = normalizeGenerationStatus(readField(data, 'status'));
    const previewUrls = status === 'completed'
        ? doubaoTaskAssetUrls(healthyBaseUrl, taskId, data)
        : [];
    const position = readField(data, 'position');
    return {
        ok: true,
        providerId: 'doubao',
        status,
        taskId,
        previewUrl: previewUrls[0],
        previewUrls,
        message: status === 'completed'
            ? '豆包生成完成'
            : status === 'failed'
                ? readErrorMessage(data, '豆包生成失败')
                : status === 'processing'
                    ? '豆包异步生成中'
                    : '豆包任务排队中',
        ...(position !== undefined ? { position } : {})
    };
};
export const cancelDoubaoGeneration = async ({ providerId, provider, effectiveBaseUrl, taskId, requestTimeoutMs }) => {
    const { baseUrl: healthyBaseUrl } = await firstHealthyGateway(provider?.id, effectiveBaseUrl, '/api/health');
    const { response, data } = await fetchJson(`${healthyBaseUrl}/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }, requestTimeoutMs ?? 10000, createProviderOutboundPolicy(provider ?? resolveProvider(providerId), healthyBaseUrl));
    if (!response.ok || readBoolean(data, 'success') === false) {
        throw new Error(readErrorMessage(data, `HTTP ${response.status}`));
    }
    return {
        ok: true,
        providerId: 'doubao',
        taskId,
        status: 'cancelled',
        message: readString(data, 'message') ?? '豆包任务已取消'
    };
};
