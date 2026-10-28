import { DOLA_REFERENCE_IMAGE_LIMIT } from '@ftv/shared';
import { dolaTaskAssetUrls, normalizeGenerationStatus } from '../generationParsers.js';
import { firstHealthyGateway } from '../gatewayClient.js';
import { fetchJson } from '../httpClient.js';
import { createProviderOutboundPolicy, resolveProvider } from '../providers.js';
import { readBoolean, readErrorMessage, readField, readString } from '../unknownJson.js';
import { normalizeDolaImageModel, normalizeDolaImageRatio, normalizeDolaVideoDuration, normalizeDolaVideoModel, normalizeDolaVideoRatio } from './parameterCapabilities.js';
const isReferenceFile = (file) => Boolean(file);
export const submitDolaGeneration = async ({ kind, providerId, provider, effectiveBaseUrl, cleanPrompt, cleanModel, ratio, duration, accountId, executionTimeoutMs, signal, references }) => {
    if (references.rawImageRefs.length > DOLA_REFERENCE_IMAGE_LIMIT) {
        throw new Error(`Dola 参考图最多支持 ${DOLA_REFERENCE_IMAGE_LIMIT} 张，实际 ${references.rawImageRefs.length} 张`);
    }
    const form = new FormData();
    form.append('prompt', cleanPrompt);
    form.append('ratio', kind === 'image' ? normalizeDolaImageRatio(ratio) : normalizeDolaVideoRatio(ratio));
    if (accountId)
        form.append('accountId', accountId);
    if (kind === 'image') {
        form.append('model', normalizeDolaImageModel(cleanModel));
    }
    else {
        const model = normalizeDolaVideoModel(cleanModel);
        form.append('model', model);
        form.append('duration', String(normalizeDolaVideoDuration(duration, model)));
    }
    const uploadedReferenceFiles = await Promise.all(references.rawImageRefs.map((ref) => references.toReferenceBlob(ref)));
    const referenceFiles = uploadedReferenceFiles.filter(isReferenceFile);
    referenceFiles.forEach((file) => form.append('images', file.blob, file.filename));
    const { baseUrl: healthyBaseUrl } = await firstHealthyGateway(provider?.id, effectiveBaseUrl, '/api/health');
    const endpoint = kind === 'image' ? 'generate-image' : 'generate-video';
    const { response, data } = await fetchJson(`${healthyBaseUrl}/api/${endpoint}`, { method: 'POST', body: form, ...(signal ? { signal } : {}) }, executionTimeoutMs ?? 20000, createProviderOutboundPolicy(provider ?? resolveProvider(providerId), healthyBaseUrl));
    if (!response.ok || readBoolean(data, 'success') === false) {
        throw new Error(readErrorMessage(data, `Dola HTTP ${response.status}`));
    }
    const taskId = readString(data, 'taskId') ?? readString(data, 'id');
    const status = normalizeGenerationStatus(readField(data, 'status'));
    return {
        ok: true,
        providerId: 'dola',
        status,
        taskId,
        message: readString(data, 'message') ?? 'Dola 任务已提交',
        referenceCount: referenceFiles.length
    };
};
export const queryDolaGenerationStatus = async ({ providerId, provider, effectiveBaseUrl, taskId, requestTimeoutMs, signal }) => {
    const { baseUrl: healthyBaseUrl } = await firstHealthyGateway(provider?.id, effectiveBaseUrl, '/api/health');
    const { response, data } = await fetchJson(`${healthyBaseUrl}/api/tasks/${encodeURIComponent(taskId)}`, signal ? { signal } : {}, requestTimeoutMs ?? 10000, createProviderOutboundPolicy(provider ?? resolveProvider(providerId), healthyBaseUrl));
    if (!response.ok || readBoolean(data, 'success') === false) {
        throw new Error(readErrorMessage(data, `Dola HTTP ${response.status}`));
    }
    const status = normalizeGenerationStatus(readField(data, 'status'));
    const previewUrls = status === 'completed' ? dolaTaskAssetUrls(healthyBaseUrl, taskId, data) : [];
    const position = readField(data, 'position');
    return {
        ok: true,
        providerId: 'dola',
        status,
        taskId,
        previewUrl: previewUrls[0],
        previewUrls,
        message: status === 'completed'
            ? 'Dola 生成完成'
            : status === 'failed'
                ? readErrorMessage(data, 'Dola 生成失败')
                : status === 'processing'
                    ? 'Dola 异步生成中'
                    : 'Dola 任务排队中',
        ...(position !== undefined ? { position } : {})
    };
};
