import { extractGenerationUrls, extractTextContent, normalizeGenerationStatus } from '../generationParsers.js';
import { asUniqueList, fetchJson } from '../httpClient.js';
import { createProviderOutboundPolicy, openAiEndpointUrl } from '../providers.js';
import { compileImageRequestParameters } from '@mkg/shared';
import { getErrorMessage, readErrorMessage } from '../unknownJson.js';
import { assertNoUnsupportedLocalMediaReferences, extractUrlsFromGeneratedText, openAiCompatibleEndpointCandidates, prepareOpenAiCompatibleImageReferences, readGenerationFailureReason, readGenerationStatus, readGenerationTaskId, toTextReferenceNote } from './openAiCompatibleUtils.js';
import { resolveModelParameterCapabilities } from './modelParameterCapabilities.js';
import { assertGenerationSubmissionMode, generationEndpointUrl, generationStatusEndpointUrl, resolveGenerationEndpoint } from './generationEndpointProfiles.js';
const zhenzhenImageSizeMap = {
    '1k': {
        '1:1': '1024x1024',
        '3:2': '1536x1024',
        '2:3': '1024x1536',
        '4:3': '1024x768',
        '3:4': '768x1024',
        '5:4': '1280x1024',
        '4:5': '1024x1280',
        '16:9': '1536x864',
        '9:16': '864x1536',
        '2:1': '2048x1024',
        '1:2': '1024x2048',
        '3:1': '1536x512',
        '1:3': '512x1536',
        '21:9': '2016x864',
        '9:21': '864x2016'
    },
    '2k': {
        '1:1': '2048x2048',
        '3:2': '2048x1360',
        '2:3': '1360x2048',
        '4:3': '2048x1536',
        '3:4': '1536x2048',
        '5:4': '2560x2048',
        '4:5': '2048x2560',
        '16:9': '2048x1152',
        '9:16': '1152x2048',
        '2:1': '2688x1344',
        '1:2': '1344x2688',
        '3:1': '3072x1024',
        '1:3': '1024x3072',
        '21:9': '2688x1152',
        '9:21': '1152x2688'
    },
    '4k': {
        '1:1': '2880x2880',
        '3:2': '3520x2336',
        '2:3': '2336x3520',
        '4:3': '3312x2480',
        '3:4': '2480x3312',
        '5:4': '3216x2576',
        '4:5': '2576x3216',
        '16:9': '3840x2160',
        '9:16': '2160x3840',
        '2:1': '3840x1920',
        '1:2': '1920x3840',
        '3:1': '3840x1280',
        '1:3': '1280x3840',
        '21:9': '3840x1648',
        '9:21': '1648x3840'
    }
};
const normalizeZhenzhenResolution = (resolution) => {
    const normalized = resolution?.trim().toLowerCase();
    if (normalized === '1k')
        return '1k';
    if (normalized === '4k' || normalized === '8k')
        return '4k';
    return '2k';
};
const parseZhenzhenImageSize = (ratio, resolution) => {
    const normalizedRatio = ratio?.trim().toLowerCase() || '16:9';
    if (/^\d{3,4}x\d{3,4}$/.test(normalizedRatio))
        return normalizedRatio;
    const resolutionKey = normalizeZhenzhenResolution(resolution);
    return zhenzhenImageSizeMap[resolutionKey][normalizedRatio] ?? zhenzhenImageSizeMap[resolutionKey]['16:9'];
};
const buildJsonHeaders = (effectiveApiKey) => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (effectiveApiKey)
        headers.Authorization = `Bearer ${effectiveApiKey}`;
    return headers;
};
const resultMessage = (data, normalizedStatus, referenceCount = 0) => {
    const referenceSuffix = referenceCount > 0 ? `，已传递 ${referenceCount} 张参考图` : '';
    if (normalizedStatus === 'completed')
        return `生成完成${referenceSuffix}`;
    if (normalizedStatus === 'failed')
        return readGenerationFailureReason(data) || '生成失败';
    if (normalizedStatus === 'processing')
        return `异步生成中${referenceSuffix}`;
    return `任务已提交${referenceSuffix}`;
};
export const submitZhenzhenGeneration = async ({ kind, providerId, providerName, provider, generationEndpoints, effectiveBaseUrl, effectiveApiKey, cleanPrompt, cleanModel, imagePresetId, imageRequestEncoding, ratio, resolution, quality, duration, batchSize, modelCapabilities, modelRequestProfile, executionTimeoutMs, signal, references }) => {
    const headers = buildJsonHeaders(effectiveApiKey);
    const outboundPolicy = createProviderOutboundPolicy(provider, effectiveBaseUrl);
    const requestTimeoutMs = executionTimeoutMs ?? (kind === 'video' ? 30000 : kind === 'image' ? 240000 : 60000);
    if (kind === 'text') {
        assertNoUnsupportedLocalMediaReferences(references);
        const textImageRefs = (await Promise.all(references.rawImageRefs.map((ref) => references.toImageDataUrl(ref)))).filter((url) => Boolean(url));
        const textReferenceNotes = [
            ...references.videoRefs.map((url, index) => toTextReferenceNote('video', index, url)),
            ...references.audioRefs.map((url, index) => toTextReferenceNote('audio', index, url))
        ];
        const textPrompt = textReferenceNotes.length > 0
            ? `${cleanPrompt}\n\n参考素材：\n${textReferenceNotes.join('\n')}`
            : cleanPrompt;
        const messageContent = textImageRefs.length > 0
            ? [
                { type: 'text', text: textPrompt },
                ...textImageRefs.map((url) => ({ type: 'image_url', image_url: { url } }))
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
                const { response, data } = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(payload), ...(signal ? { signal } : {}) }, requestTimeoutMs, outboundPolicy);
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
            message: '文本生成完成'
        };
    }
    assertNoUnsupportedLocalMediaReferences(references);
    const imageReferenceInputs = await prepareOpenAiCompatibleImageReferences(references, {
        maxEncodedBytes: 20 * 1024 * 1024
    });
    const resolvedProfile = modelRequestProfile ?? 'auto';
    if (kind === 'image' && resolvedProfile === 'chat-image') {
        const messageContent = imageReferenceInputs.length > 0
            ? [
                { type: 'text', text: cleanPrompt },
                ...imageReferenceInputs.map((url) => ({ type: 'image_url', image_url: { url } }))
            ]
            : cleanPrompt;
        const payload = {
            model: cleanModel,
            stream: false,
            messages: [{ role: 'user', content: messageContent }]
        };
        let lastError = '';
        for (const url of openAiCompatibleEndpointCandidates(effectiveBaseUrl, 'chat/completions')) {
            try {
                const { response, data } = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(payload), ...(signal ? { signal } : {}) }, requestTimeoutMs, outboundPolicy);
                if (!response.ok) {
                    lastError = readErrorMessage(data, `HTTP ${response.status}`);
                    continue;
                }
                const text = extractTextContent(data).trim();
                const previewUrls = extractGenerationUrls(data);
                const textPreviewUrls = previewUrls.length > 0 ? previewUrls : extractUrlsFromGeneratedText(text);
                if (textPreviewUrls.length === 0) {
                    throw new Error(text ? `Chat 生图已返回文本，但未识别到图片地址：${text.slice(0, 80)}` : 'Chat 生图未返回图片地址');
                }
                return {
                    ok: true,
                    providerId,
                    providerName,
                    status: 'completed',
                    previewUrl: textPreviewUrls[0],
                    previewUrls: textPreviewUrls,
                    message: `生成完成${imageReferenceInputs.length > 0 ? `，已传递 ${imageReferenceInputs.length} 张参考图` : ''}`,
                    referenceCount: imageReferenceInputs.length
                };
            }
            catch (err) {
                lastError = getErrorMessage(err);
            }
        }
        throw new Error(`Chat 生图请求失败：${lastError || '未返回有效图片'}`);
    }
    const configuredEndpoint = resolveGenerationEndpoint({ kind, protocol: 'zhenzhen', configured: generationEndpoints });
    const endpoint = kind === 'image' ? 'images/generations' : 'videos/generations';
    const parameterCapabilities = resolveModelParameterCapabilities({
        protocol: 'zhenzhen',
        kind,
        model: cleanModel
    });
    const payload = kind === 'image' && parameterCapabilities.kind === 'image'
        ? (() => {
            const imageParameters = compileImageRequestParameters({
                protocol: 'zhenzhen',
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
                ...(imageReferenceInputs.length > 0 ? { image: imageReferenceInputs } : {})
            };
        })()
        : {
            model: cleanModel,
            prompt: cleanPrompt,
            size: ratio,
            duration: duration ?? 5,
            ...(imageReferenceInputs.length > 0 ? { reference_images: imageReferenceInputs } : {}),
            ...(references.videoRefs.length > 0 ? { reference_videos: references.videoRefs } : {}),
            ...(references.audioRefs.length > 0 ? { reference_audios: references.audioRefs } : {})
        };
    const submittedReferenceCount = imageReferenceInputs.length
        + (kind === 'video' ? references.videoRefs.length + references.audioRefs.length : 0);
    const { response, data } = await fetchJson(configuredEndpoint ? generationEndpointUrl(effectiveBaseUrl, configuredEndpoint.submitPath) : openAiEndpointUrl(effectiveBaseUrl, endpoint), { method: 'POST', headers, body: JSON.stringify(payload), ...(signal ? { signal } : {}) }, requestTimeoutMs, outboundPolicy);
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
        message: resultMessage(data, normalizedStatus, imageReferenceInputs.length),
        referenceCount: submittedReferenceCount
    };
};
export const queryZhenzhenGenerationStatus = async ({ kind, providerId, provider, generationEndpoints, effectiveBaseUrl, effectiveApiKey, taskId, requestTimeoutMs, signal }) => {
    const headers = buildJsonHeaders(effectiveApiKey);
    const outboundPolicy = createProviderOutboundPolicy(provider, effectiveBaseUrl);
    const configuredEndpoint = resolveGenerationEndpoint({ kind, protocol: 'zhenzhen', configured: generationEndpoints });
    if (configuredEndpoint?.mode === 'sync')
        return { ok: true, providerId, status: 'completed', taskId, previewUrls: [], message: '同步生成无需查询状态' };
    const endpoint = kind === 'image' ? 'images/generations' : 'videos/generations';
    const candidateUrls = configuredEndpoint?.statusPath
        ? [generationStatusEndpointUrl(effectiveBaseUrl, configuredEndpoint.statusPath, taskId)]
        : asUniqueList([
            kind === 'image' ? openAiEndpointUrl(effectiveBaseUrl, `images/tasks/${encodeURIComponent(taskId)}`) : '',
            openAiEndpointUrl(effectiveBaseUrl, `${endpoint}/${encodeURIComponent(taskId)}`),
            openAiEndpointUrl(effectiveBaseUrl, `tasks/${encodeURIComponent(taskId)}`),
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
