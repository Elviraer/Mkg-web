import { extractGenerationUrls, extractTextContent, normalizeGenerationStatus } from '../generationParsers.js';
import { asUniqueList, fetchJson } from '../httpClient.js';
import { createProviderOutboundPolicy, openAiEndpointUrl } from '../providers.js';
import { compileImageRequestParameters } from '@mkg/shared';
import { getErrorMessage, readErrorMessage, readField, readString } from '../unknownJson.js';
import { assertNoUnsupportedLocalMediaReferences, isPublicHttpReference, openAiCompatibleEndpointCandidates, readGenerationFailureReason, readGenerationStatus, readGenerationTaskId, toTextReferenceNote } from './openAiCompatibleUtils.js';
import { normalizeVideoParameters, resolveModelParameterCapabilities } from './modelParameterCapabilities.js';
import { assertGenerationSubmissionMode, generationEndpointUrl, generationStatusEndpointUrl, resolveGenerationEndpoint } from './generationEndpointProfiles.js';
const normalizeApimartVideoResolution = (resolution) => {
    const normalized = resolution?.trim().toLowerCase();
    return normalized === '480p' || normalized === '720p' || normalized === '1080p' || normalized === '4k'
        ? normalized
        : '720p';
};
const uploadApimartImageReference = async (reference, effectiveBaseUrl, headers, references, outboundPolicy, signal) => {
    if (isPublicHttpReference(reference))
        return reference;
    const file = await references.toReferenceBlob(reference);
    if (!file || !file.blob.type.startsWith('image/')) {
        throw new Error('APIMART 参考图上传失败：未能读取有效图片文件，请重新上传参考图后再生成');
    }
    const form = new FormData();
    form.append('file', file.blob, file.filename);
    let responseData;
    try {
        responseData = await fetchJson(openAiEndpointUrl(effectiveBaseUrl, 'uploads/images'), {
            method: 'POST',
            headers,
            body: form,
            ...(signal ? { signal } : {})
        }, 120000, outboundPolicy);
    }
    catch (err) {
        throw new Error(`APIMART 参考图上传请求失败: ${getErrorMessage(err)}`);
    }
    const { response, data } = responseData;
    if (!response.ok) {
        throw new Error(readErrorMessage(data, `APIMART 参考图上传失败: HTTP ${response.status}`));
    }
    const uploadedUrl = readString(data, 'url') ?? readString(readField(data, 'data'), 'url');
    if (!uploadedUrl) {
        throw new Error('APIMART 参考图上传成功但未返回图片 URL');
    }
    console.info('[MK APIMART image upload success]', JSON.stringify({
        filename: file.filename,
        contentType: file.blob.type,
        bytes: file.blob.size,
        url: uploadedUrl
    }));
    return uploadedUrl;
};
const prepareApimartImageReferences = async (effectiveBaseUrl, uploadHeaders, references, outboundPolicy, signal) => {
    const sourceRefs = references.rawImageRefs.length > 0 ? references.rawImageRefs : references.imageRefs;
    if (sourceRefs.length === 0)
        return [];
    return Promise.all(sourceRefs.map((ref) => uploadApimartImageReference(ref, effectiveBaseUrl, uploadHeaders, references, outboundPolicy, signal)));
};
export const submitApimartGeneration = async ({ kind, providerId, providerName, provider, effectiveBaseUrl, effectiveApiKey, cleanPrompt, cleanModel, generationEndpoints, imagePresetId, imageRequestEncoding, ratio, resolution, quality, duration, batchSize, modelCapabilities, executionTimeoutMs, signal, references }) => {
    const authHeaders = { Accept: 'application/json' };
    if (effectiveApiKey)
        authHeaders.Authorization = `Bearer ${effectiveApiKey}`;
    const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' };
    const outboundPolicy = createProviderOutboundPolicy(provider, effectiveBaseUrl);
    assertNoUnsupportedLocalMediaReferences(references);
    const requestTimeoutMs = executionTimeoutMs ?? (kind === 'video' ? 30000 : kind === 'image' ? 240000 : 60000);
    const imageReferenceInputs = await prepareApimartImageReferences(effectiveBaseUrl, authHeaders, references, outboundPolicy, signal);
    if (kind === 'text') {
        const textReferenceNotes = [
            ...references.videoRefs.map((url, index) => toTextReferenceNote('video', index, url)),
            ...references.audioRefs.map((url, index) => toTextReferenceNote('audio', index, url))
        ];
        const textPrompt = textReferenceNotes.length > 0
            ? `${cleanPrompt}\n\n参考素材：\n${textReferenceNotes.join('\n')}`
            : cleanPrompt;
        const messageContent = imageReferenceInputs.length > 0
            ? [
                { type: 'text', text: textPrompt },
                ...imageReferenceInputs.map((url) => ({ type: 'image_url', image_url: { url } }))
            ]
            : textPrompt;
        const payload = {
            model: cleanModel,
            messages: [{ role: 'user', content: messageContent }],
            stream: false
        };
        let text = '';
        let lastError = '';
        for (const url of openAiCompatibleEndpointCandidates(effectiveBaseUrl, 'chat/completions')) {
            try {
                const { response, data } = await fetchJson(url, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload), ...(signal ? { signal } : {}) }, requestTimeoutMs, outboundPolicy);
                if (!response.ok) {
                    lastError = readErrorMessage(data, `HTTP ${response.status}`);
                    continue;
                }
                text = extractTextContent(data).trim();
                if (text)
                    break;
                lastError = '模型未返回文本内容';
            }
            catch (err) {
                lastError = getErrorMessage(err);
            }
        }
        if (!text)
            throw new Error(`文本推理请求失败：${lastError || '未返回有效内容'}`);
        return {
            ok: true,
            providerId,
            providerName,
            status: 'completed',
            text,
            message: '文本生成完成',
            referenceCount: imageReferenceInputs.length
        };
    }
    const configuredEndpoint = resolveGenerationEndpoint({ kind, protocol: 'apimart', configured: generationEndpoints });
    const endpoint = kind === 'image' ? 'images/generations' : 'videos/generations';
    const parameterCapabilities = resolveModelParameterCapabilities({
        protocol: 'apimart',
        kind,
        model: cleanModel
    });
    const payload = kind === 'image' && parameterCapabilities.kind === 'image'
        ? (() => {
            const imageParameters = compileImageRequestParameters({
                protocol: 'apimart',
                model: cleanModel,
                presetId: imagePresetId,
                capabilityOverrides: modelCapabilities,
                encodingOverride: imageRequestEncoding,
                aspectRatio: ratio,
                resolution,
                quality,
                batchSize
            });
            return {
                model: cleanModel,
                prompt: cleanPrompt,
                ...imageParameters.payload,
                // APIMART's generations contract defines image_urls as a string URL array,
                // unlike the JSON image object shape used by some /images/edits gateways.
                ...(imageReferenceInputs.length > 0 ? { image_urls: imageReferenceInputs } : {})
            };
        })()
        : (() => {
            const videoParameters = parameterCapabilities.kind === 'video'
                ? normalizeVideoParameters(parameterCapabilities.video, {
                    aspectRatio: ratio,
                    resolution,
                    duration
                })
                : {
                    aspectRatio: ratio,
                    resolution: normalizeApimartVideoResolution(resolution),
                    duration: duration ?? 5
                };
            return {
                model: cleanModel,
                prompt: cleanPrompt,
                size: videoParameters.aspectRatio,
                resolution: (videoParameters.resolution ?? '720P').toLowerCase(),
                duration: videoParameters.duration,
                ...(imageReferenceInputs.length > 0 ? { image_urls: imageReferenceInputs } : {}),
                ...(references.videoRefs.length > 0 ? { video_urls: references.videoRefs } : {}),
                ...(references.audioRefs.length > 0 ? { audio_urls: references.audioRefs } : {})
            };
        })();
    const { response, data } = await fetchJson(configuredEndpoint ? generationEndpointUrl(effectiveBaseUrl, configuredEndpoint.submitPath) : openAiEndpointUrl(effectiveBaseUrl, endpoint), { method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload), ...(signal ? { signal } : {}) }, requestTimeoutMs, outboundPolicy);
    if (!response.ok) {
        throw new Error(readErrorMessage(data, `HTTP ${response.status}`));
    }
    const previewUrls = extractGenerationUrls(data);
    const normalizedStatus = previewUrls.length > 0 ? 'completed' : normalizeGenerationStatus(readGenerationStatus(data));
    const taskId = readGenerationTaskId(data);
    assertGenerationSubmissionMode({ endpoint: configuredEndpoint, kind, previewUrls, taskId, status: normalizedStatus });
    return {
        ok: true,
        providerId,
        providerName,
        status: normalizedStatus,
        taskId,
        previewUrl: previewUrls[0],
        previewUrls,
        message: previewUrls.length > 0
            ? `生成完成${imageReferenceInputs.length > 0 ? `，已传递 ${imageReferenceInputs.length} 张参考图` : ''}`
            : (normalizedStatus === 'failed'
                ? readGenerationFailureReason(data) || '生成失败'
                : normalizedStatus === 'processing'
                    ? `异步生成中${imageReferenceInputs.length > 0 ? `，已传递 ${imageReferenceInputs.length} 张参考图` : ''}`
                    : `任务已提交${imageReferenceInputs.length > 0 ? `，已传递 ${imageReferenceInputs.length} 张参考图` : ''}`),
        referenceCount: imageReferenceInputs.length + (kind === 'video' ? references.videoRefs.length + references.audioRefs.length : 0)
    };
};
export const queryApimartGenerationStatus = async ({ kind, providerId, provider, generationEndpoints, effectiveBaseUrl, effectiveApiKey, taskId, requestTimeoutMs, signal }) => {
    const outboundPolicy = createProviderOutboundPolicy(provider, effectiveBaseUrl);
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (effectiveApiKey)
        headers.Authorization = `Bearer ${effectiveApiKey}`;
    const configuredEndpoint = resolveGenerationEndpoint({ kind, protocol: 'apimart', configured: generationEndpoints });
    if (configuredEndpoint?.mode === 'sync')
        return { ok: true, providerId, status: 'completed', taskId, previewUrls: [], message: '同步生成无需查询状态' };
    const endpoint = kind === 'image' ? 'images/generations' : 'videos/generations';
    const candidateUrls = configuredEndpoint?.statusPath
        ? [generationStatusEndpointUrl(effectiveBaseUrl, configuredEndpoint.statusPath, taskId)]
        : asUniqueList([
            openAiEndpointUrl(effectiveBaseUrl, `tasks/${encodeURIComponent(taskId)}`),
            openAiEndpointUrl(effectiveBaseUrl, `${endpoint}/${encodeURIComponent(taskId)}`),
            kind === 'image' ? openAiEndpointUrl(effectiveBaseUrl, `images/tasks/${encodeURIComponent(taskId)}`) : '',
            openAiEndpointUrl(effectiveBaseUrl, `task/${encodeURIComponent(taskId)}`),
            openAiEndpointUrl(effectiveBaseUrl, `async/tasks/${encodeURIComponent(taskId)}`),
            kind === 'video' ? openAiEndpointUrl(effectiveBaseUrl, `videos/${encodeURIComponent(taskId)}`) : ''
        ]);
    let lastError = '';
    let preferredError = '';
    for (const url of candidateUrls) {
        const { response, data } = await fetchJson(url, { headers, ...(signal ? { signal } : {}) }, requestTimeoutMs ?? 10000, outboundPolicy);
        if (!response.ok) {
            lastError = readErrorMessage(data, `HTTP ${response.status}`);
            if (!preferredError && response.status !== 404 && !/invalid url/i.test(lastError))
                preferredError = lastError;
            continue;
        }
        const previewUrls = extractGenerationUrls(data);
        const status = previewUrls.length > 0 ? 'completed' : normalizeGenerationStatus(readGenerationStatus(data));
        return {
            ok: true,
            providerId,
            status,
            taskId: readGenerationTaskId(data) ?? taskId,
            previewUrl: previewUrls[0],
            previewUrls,
            message: status === 'completed'
                ? '生成完成'
                : status === 'failed'
                    ? readGenerationFailureReason(data) || readErrorMessage(data, '生成失败')
                    : status === 'processing'
                        ? '异步生成中'
                        : '任务排队中'
        };
    }
    throw new Error(preferredError || lastError || '无法查询任务状态');
};
