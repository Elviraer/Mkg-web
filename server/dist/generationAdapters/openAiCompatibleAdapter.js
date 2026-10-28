import { extractGenerationUrls, extractTextContent, normalizeGenerationStatus } from '../generationParsers.js';
import { fetchBinary, fetchJson } from '../httpClient.js';
import { createProviderOutboundPolicy, openAiEndpointUrl } from '../providers.js';
import { getErrorMessage, readErrorMessage, readField, readString } from '../unknownJson.js';
import { compileImageRequestParameters, compileVideoRequestParameters } from '@mkg/shared';
import { assertNoUnsupportedLocalMediaReferences, extractUrlsFromGeneratedText, isPublicHttpReference, openAiCompatibleEndpointCandidates, readGenerationFailureReason, readGenerationStatus, readGenerationTaskId, shouldUseLegacyImageResponseFormat, toTextReferenceNote } from './openAiCompatibleUtils.js';
import { isSeedAudioGenerationModel, normalizeAudioParameters, normalizeVideoParameters, resolveModelParameterCapabilities } from './modelParameterCapabilities.js';
import { applyProviderAuthorization, getOpenAiProviderProfile } from './openAiProviderProfiles.js';
import { resolveProviderImageTransportContract } from './imageTransportProfiles.js';
import { assertGenerationSubmissionMode, generationEndpointUrl, generationStatusEndpointUrl, resolveGenerationEndpoint } from './generationEndpointProfiles.js';
const isGrokImagineImageModel = (model) => {
    const normalized = model.trim().toLowerCase();
    return normalized === 'grok-imagine'
        || normalized === 'grok-imagine-edit'
        || normalized.startsWith('grok-imagine-image');
};
const readRetryAfterSeconds = (response) => {
    const value = response.headers.get('retry-after')?.trim();
    if (!value)
        return undefined;
    if (/^\d+$/.test(value))
        return Number(value);
    const retryAt = Date.parse(value);
    if (!Number.isFinite(retryAt))
        return undefined;
    return Math.max(1, Math.ceil((retryAt - Date.now()) / 1000));
};
const describeGrokUpstreamError = (message, model, providerName, response) => {
    if (!isGrokImagineImageModel(model))
        return message;
    const providerLabel = providerName || 'Provider';
    if (/upstream access forbidden/i.test(message)) {
        return `${providerLabel} 的 Grok 上游账号返回 403：请检查该账号的 Imagine 权限、验证或封禁状态`;
    }
    if (/xai upstream returned status 404/i.test(message)) {
        return `${providerLabel} 的 xAI 上游未找到图像编辑接口或模型，请检查 ${providerLabel} 的 Grok 账号 BaseURL、版本及 Imagine Image Quality 权限`;
    }
    if (response.status === 429 || /upstream rate limit exceeded/i.test(message)) {
        const retryAfter = readRetryAfterSeconds(response);
        const retryHint = retryAfter ? `，请至少等待 ${retryAfter} 秒后重试` : '';
        return `${providerLabel} 的 Grok 上游账号池已限流${retryHint}；请检查 ${providerLabel} 中 Grok 账号的配额和重置时间，或增加同组可用账号`;
    }
    return message;
};
const prepareOpenAiImageEditFiles = async (references) => {
    const sourceRefs = references.rawImageRefs.length > 0 ? references.rawImageRefs : references.imageRefs;
    const files = [];
    for (const reference of sourceRefs) {
        const file = await references.toReferenceBlob(reference);
        if (!file || !file.blob.type.startsWith('image/')) {
            throw new Error('OpenAI 图片编辑参考图准备失败：未能读取有效图片文件');
        }
        files.push(file);
    }
    return files;
};
const providerUploadEndpointUrl = (baseUrl, uploadPath) => {
    const normalized = uploadPath.trim();
    if (normalized.startsWith('/') || /^v1\//i.test(normalized)) {
        return new URL(`/${normalized.replace(/^\/+/, '')}`, baseUrl).toString();
    }
    return openAiEndpointUrl(baseUrl, normalized);
};
const isStandardOpenAiFilesPath = (uploadPath) => /(^|\/)files\/?$/i.test(uploadPath.trim());
const resolveReferenceModes = (preferred, supported) => {
    if (supported?.length)
        return supported;
    return preferred ? [preferred] : ['data-url'];
};
const resolveUploadPath = (kind, fallback, paths, mediaKinds) => {
    if (!mediaKinds?.length && kind !== 'image')
        return undefined;
    if (mediaKinds?.length && !mediaKinds.includes(kind))
        return undefined;
    return paths?.[kind] ?? fallback;
};
const uploadReference = async (ref, kind, context) => {
    const uploadPath = resolveUploadPath(kind, context.providerFileUploadPath, context.providerFileUploadPaths, context.providerFileUploadMediaKinds);
    if (!uploadPath)
        return null;
    const file = await context.references.toReferenceBlob(ref);
    if (!file)
        return null;
    const form = new FormData();
    form.append('file', file.blob, file.filename);
    if (isStandardOpenAiFilesPath(uploadPath)) {
        form.append('purpose', context.providerFileUploadPurpose ?? 'vision');
    }
    const headers = { Accept: 'application/json' };
    applyProviderAuthorization(headers, context.effectiveApiKey, context.providerAuthMode, getOpenAiProviderProfile(context.providerProfile));
    const { response, data } = await fetchJson(providerUploadEndpointUrl(context.effectiveBaseUrl, uploadPath), { method: 'POST', headers, body: form, ...(context.signal ? { signal: context.signal } : {}) }, context.executionTimeoutMs ?? 60000, createProviderOutboundPolicy(context.provider, context.effectiveBaseUrl));
    if (!response.ok)
        throw new Error(readErrorMessage(data, `文件上传失败: HTTP ${response.status}`));
    const nested = readField(data, 'data');
    const fileId = readString(data, 'file_id') ?? readString(data, 'fileId') ?? readString(data, 'upload_id') ?? readString(data, 'id')
        ?? readString(nested, 'file_id') ?? readString(nested, 'fileId') ?? readString(nested, 'upload_id') ?? readString(nested, 'id');
    const url = readString(data, 'url') ?? readString(data, 'download_url') ?? readString(nested, 'url');
    if (!fileId && !url)
        throw new Error('文件上传成功但响应中没有 file_id 或 URL');
    return { value: url ?? fileId, ...(fileId ? { fileId } : {}) };
};
export const resolveReferenceValues = async (kind, rawRefs, publicRefs, context) => {
    if (!context.providerReferenceInputModes?.length && context.providerReferenceInputMode === undefined && rawRefs.length === 0) {
        return publicRefs.map((value) => ({ value }));
    }
    const modes = resolveReferenceModes(context.providerReferenceInputMode, context.providerReferenceInputModes);
    const canUpload = modes.includes('file-upload') && Boolean(resolveUploadPath(kind, context.providerFileUploadPath, context.providerFileUploadPaths, context.providerFileUploadMediaKinds));
    const canDataUrl = modes.includes('data-url');
    const sourceRefs = rawRefs.length > 0 ? rawRefs : publicRefs;
    if (sourceRefs.length === 0)
        return [];
    if (canDataUrl) {
        const values = (await Promise.all(sourceRefs.map((ref) => (kind === 'image'
            ? context.references.toImageDataUrl(ref)
            : context.references.toMediaDataUrl?.(ref))))).filter((value) => Boolean(value));
        if (values.length === sourceRefs.length)
            return values.map((value) => ({ value }));
    }
    if (canUpload) {
        const uploaded = [];
        for (const ref of sourceRefs) {
            const result = await uploadReference(ref, kind, context);
            if (!result)
                throw new Error(`${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}参考无法读取，不能上传到供应商接口`);
            uploaded.push(result);
        }
        return uploaded;
    }
    if (rawRefs.length > 0 && rawRefs.some((ref) => !isPublicHttpReference(ref))) {
        throw new Error('参考文件没有可用的 Base64、上传或公网 URL 传输方式');
    }
    const urls = publicRefs.filter(isPublicHttpReference);
    if (urls.length === sourceRefs.length)
        return urls.map((value) => ({ value }));
    throw new Error('参考文件没有可用的 Base64、上传或公网 URL 传输方式');
};
export const submitOpenAiCompatibleGeneration = async ({ kind, providerId, providerName, providerProfile, providerImageTransport, generationEndpoints, providerAuthMode, providerTextProtocol, providerReferenceInputMode, providerReferenceInputModes, providerFileUploadPath, providerFileUploadPaths, providerFileUploadMediaKinds, providerFileUploadPurpose, provider, effectiveBaseUrl, effectiveApiKey, cleanPrompt, cleanModel, imagePresetId, imageRequestEncoding, videoRequestEncoding, ratio, resolution, quality, duration, batchSize, audioMode, voice, volume, pitch, speed, modelCapabilities, videoReferenceMode, modelRequestProfile, modelImageTransport, executionTimeoutMs, idempotencyKey, signal, persistGeneratedMedia, references }) => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const outboundPolicy = createProviderOutboundPolicy(provider, effectiveBaseUrl);
    const profile = getOpenAiProviderProfile(providerProfile);
    applyProviderAuthorization(headers, effectiveApiKey, providerAuthMode, profile);
    if (idempotencyKey && profile.idempotencyHeader)
        headers[profile.idempotencyHeader] = idempotencyKey;
    if (idempotencyKey && profile.requestIdHeader)
        headers[profile.requestIdHeader] = idempotencyKey;
    if (kind === 'audio') {
        const capabilities = resolveModelParameterCapabilities({
            protocol: 'openai-compatible',
            kind,
            model: cleanModel,
            overrides: modelCapabilities
        });
        if (capabilities.kind !== 'audio')
            throw new Error('音频模型参数能力无效');
        const normalized = normalizeAudioParameters(capabilities.audio, { mode: audioMode, voice, speed, volume, pitch });
        const useSeedAudioGeneration = isSeedAudioGenerationModel(cleanModel);
        const useSpeechEndpoint = !useSeedAudioGeneration
            && modelRequestProfile !== 'openai-audio-generation'
            && normalized.mode === 'speech';
        if (useSpeechEndpoint) {
            if (references.rawImageRefs.length + references.rawVideoRefs.length + references.rawAudioRefs.length > 0) {
                throw new Error('标准 audio/speech 请求不支持参考媒体');
            }
            const { response, bytes } = await fetchBinary(openAiEndpointUrl(effectiveBaseUrl, 'audio/speech'), {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: cleanModel,
                    input: cleanPrompt,
                    voice: normalized.voice ?? 'alloy',
                    speed: normalized.speed,
                    response_format: 'mp3'
                }),
                ...(signal ? { signal } : {})
            }, executionTimeoutMs ?? 240000, outboundPolicy);
            if (!response.ok) {
                const raw = new TextDecoder().decode(bytes).trim();
                let message = raw;
                try {
                    message = readErrorMessage(JSON.parse(raw), raw);
                }
                catch { /* use raw response */ }
                throw new Error(message || `音频生成失败: HTTP ${response.status}`);
            }
            if (bytes.byteLength === 0)
                throw new Error('音频生成完成但返回内容为空');
            if (!persistGeneratedMedia)
                throw new Error('服务端未配置生成音频资产存储');
            const persisted = await persistGeneratedMedia({
                bytes,
                contentType: response.headers.get('content-type') ?? 'audio/mpeg',
                fileName: `${cleanModel || 'audio'}.mp3`
            });
            return {
                ok: true,
                providerId,
                providerName,
                status: 'completed',
                previewUrl: persisted.previewUrl,
                previewUrls: [persisted.previewUrl],
                message: '音频生成完成'
            };
        }
        if (useSeedAudioGeneration && references.rawVideoRefs.length > 0) {
            throw new Error('Seed Audio 不支持视频参考');
        }
        if (useSeedAudioGeneration && references.rawImageRefs.length > 0 && references.rawAudioRefs.length > 0) {
            throw new Error('Seed Audio 的参考图片与参考音频不能同时使用');
        }
        if (useSeedAudioGeneration && normalized.voice && references.rawImageRefs.length + references.rawAudioRefs.length > 0) {
            throw new Error('Seed Audio 的音色不能与参考图片或参考音频同时使用');
        }
        if (useSeedAudioGeneration && references.rawAudioRefs.length > 3) {
            throw new Error(`Seed Audio 最多支持 3 个参考音频，实际 ${references.rawAudioRefs.length} 个`);
        }
        const shouldResolveAudioReferences = Boolean(providerReferenceInputModes?.length || providerReferenceInputMode);
        const resolvedAudioImageRefs = shouldResolveAudioReferences
            ? (await resolveReferenceValues('image', references.rawImageRefs, references.imageRefs, {
                references, providerReferenceInputMode, providerReferenceInputModes, providerFileUploadPath,
                providerFileUploadPaths, providerFileUploadMediaKinds, providerFileUploadPurpose, providerTextProtocol,
                effectiveBaseUrl, effectiveApiKey, provider, providerAuthMode, providerProfile, signal, executionTimeoutMs
            })).map((input) => input.value)
            : references.imageRefs;
        const resolvedAudioVideoRefs = shouldResolveAudioReferences
            ? (await resolveReferenceValues('video', references.rawVideoRefs, references.videoRefs, {
                references, providerReferenceInputMode, providerReferenceInputModes, providerFileUploadPath,
                providerFileUploadPaths, providerFileUploadMediaKinds, providerFileUploadPurpose, providerTextProtocol,
                effectiveBaseUrl, effectiveApiKey, provider, providerAuthMode, providerProfile, signal, executionTimeoutMs
            })).map((input) => input.value)
            : references.videoRefs;
        const resolvedAudioRefs = shouldResolveAudioReferences
            ? (await resolveReferenceValues('audio', references.rawAudioRefs, references.audioRefs, {
                references, providerReferenceInputMode, providerReferenceInputModes, providerFileUploadPath,
                providerFileUploadPaths, providerFileUploadMediaKinds, providerFileUploadPurpose, providerTextProtocol,
                effectiveBaseUrl, effectiveApiKey, provider, providerAuthMode, providerProfile, signal, executionTimeoutMs
            })).map((input) => input.value)
            : references.audioRefs;
        const submittedImageReferences = useSeedAudioGeneration
            ? resolvedAudioImageRefs.slice(0, 1)
            : resolvedAudioImageRefs;
        const submittedAudioReferences = useSeedAudioGeneration
            ? resolvedAudioRefs.slice(0, 3)
            : resolvedAudioRefs;
        const payload = useSeedAudioGeneration
            ? {
                model: cleanModel,
                prompt: cleanPrompt,
                ...(submittedImageReferences.length > 0 ? { images: submittedImageReferences } : {}),
                metadata: {
                    format: 'mp3',
                    sample_rate: '24000',
                    ...(normalized.voice ? { speaker: normalized.voice } : {}),
                    ...(submittedAudioReferences.length === 1 ? { audio_url: submittedAudioReferences[0] } : {}),
                    ...(submittedAudioReferences.length > 1 ? { audio_urls: submittedAudioReferences } : {}),
                    speech_rate: normalized.speed,
                    loudness_rate: normalized.volume,
                    pitch_rate: normalized.pitch
                }
            }
            : {
                model: cleanModel,
                prompt: cleanPrompt,
                mode: normalized.mode,
                ...(normalized.voice ? { voice: normalized.voice } : {}),
                speed: normalized.speed,
                volume: normalized.volume,
                pitch: normalized.pitch,
                ...(resolvedAudioImageRefs.length > 0 ? { reference_images: resolvedAudioImageRefs } : {}),
                ...(resolvedAudioVideoRefs.length > 0 ? { reference_videos: resolvedAudioVideoRefs } : {}),
                ...(resolvedAudioRefs.length > 0 ? { reference_audios: resolvedAudioRefs } : {})
            };
        const { response, data } = await fetchJson(openAiEndpointUrl(effectiveBaseUrl, 'audio/generations'), { method: 'POST', headers, body: JSON.stringify(payload), ...(signal ? { signal } : {}) }, executionTimeoutMs ?? 30000, outboundPolicy);
        if (!response.ok)
            throw new Error(readErrorMessage(data, `音频生成失败: HTTP ${response.status}`));
        const previewUrls = extractGenerationUrls(data);
        const status = previewUrls.length > 0 ? 'completed' : normalizeGenerationStatus(readGenerationStatus(data));
        return {
            ok: true,
            providerId,
            providerName,
            status,
            taskId: readGenerationTaskId(data),
            previewUrl: previewUrls[0],
            previewUrls,
            message: previewUrls.length > 0
                ? '音频生成完成'
                : status === 'failed'
                    ? readGenerationFailureReason(data) || '音频生成失败'
                    : '音频生成任务已提交',
            referenceCount: submittedImageReferences.length
                + (useSeedAudioGeneration ? 0 : resolvedAudioVideoRefs.length)
                + submittedAudioReferences.length
        };
    }
    if (kind === 'text') {
        const textCapabilities = resolveModelParameterCapabilities({
            protocol: 'openai-compatible',
            kind,
            model: cleanModel,
            overrides: modelCapabilities
        });
        if (textCapabilities.kind === 'text'
            && !textCapabilities.text.multimodal
            && references.rawImageRefs.length + references.rawVideoRefs.length + references.rawAudioRefs.length > 0) {
            throw new Error('当前语言模型能力配置不支持多模态参考输入');
        }
        assertNoUnsupportedLocalMediaReferences(references);
        const textProtocol = providerTextProtocol ?? 'chat-completions';
        const textReferenceInputModes = textProtocol === 'responses'
            ? providerReferenceInputModes
            : providerReferenceInputModes?.filter((mode) => mode !== 'file-upload');
        if (textProtocol !== 'responses' && providerReferenceInputMode === 'file-upload' && !textReferenceInputModes?.length) {
            throw new Error('Chat Completions 不能消费 file_id；请启用 Base64 或公网 URL，或改用 Responses API');
        }
        const textImageInputs = [];
        const textReferences = await resolveReferenceValues('image', references.rawImageRefs, references.imageRefs, {
            references,
            providerReferenceInputMode,
            providerReferenceInputModes: textReferenceInputModes,
            providerFileUploadPath,
            providerFileUploadPaths,
            providerFileUploadMediaKinds,
            providerFileUploadPurpose,
            providerTextProtocol: textProtocol,
            effectiveBaseUrl,
            effectiveApiKey,
            provider,
            providerAuthMode,
            providerProfile,
            signal,
            executionTimeoutMs
        });
        textReferences.forEach((input) => textImageInputs.push(input.fileId ? { fileId: input.fileId } : { url: input.value }));
        const textReferenceNotes = [
            ...references.videoRefs.map((url, index) => toTextReferenceNote('video', index, url)),
            ...references.audioRefs.map((url, index) => toTextReferenceNote('audio', index, url))
        ];
        const textPrompt = textReferenceNotes.length > 0
            ? `${cleanPrompt}\n\n参考素材：\n${textReferenceNotes.join('\n')}`
            : cleanPrompt;
        const messageContent = textImageInputs.length > 0
            ? [
                { type: 'text', text: textPrompt },
                ...textImageInputs.map((input) => ({ type: 'image_url', image_url: { url: input.url } }))
            ]
            : textPrompt;
        const responseContent = [
            { type: 'input_text', text: textPrompt },
            ...textImageInputs.map((input) => input.fileId
                ? { type: 'input_image', file_id: input.fileId }
                : { type: 'input_image', image_url: input.url })
        ];
        const payload = textProtocol === 'responses'
            ? {
                model: cleanModel,
                input: textImageInputs.length > 0 ? [{ role: 'user', content: responseContent }] : textPrompt,
                stream: false
            }
            : {
                model: cleanModel,
                messages: [{ role: 'user', content: messageContent }],
                stream: false
            };
        let text = '';
        let lastError = '';
        const textEndpoint = textProtocol === 'responses' ? 'responses' : 'chat/completions';
        const endpointCandidates = profile.textEndpointStyle === 'canonical'
            ? [openAiEndpointUrl(effectiveBaseUrl, textEndpoint)]
            : openAiCompatibleEndpointCandidates(effectiveBaseUrl, textEndpoint);
        const textTimeoutMs = executionTimeoutMs ?? (textImageInputs.length > 0
            ? profile.multimodalTextTimeoutMs
            : profile.textTimeoutMs);
        for (const url of endpointCandidates) {
            try {
                const { response, data } = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(payload), ...(signal ? { signal } : {}) }, textTimeoutMs, outboundPolicy);
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
        if (!text) {
            throw new Error(`文本推理请求失败：${lastError || '未返回有效内容'}`);
        }
        return {
            ok: true,
            providerId,
            providerName,
            status: 'completed',
            text,
            message: '文本生成完成'
        };
    }
    if (!providerReferenceInputModes?.length && providerReferenceInputMode === undefined) {
        assertNoUnsupportedLocalMediaReferences(references);
    }
    const imageTransport = resolveProviderImageTransportContract({
        providerTransport: providerImageTransport,
        modelTransport: modelImageTransport,
        providerProfile: profile.id,
        providerId,
        providerName,
        baseUrl: effectiveBaseUrl,
        model: cleanModel
    });
    const hasImageReferences = references.rawImageRefs.length > 0 || references.imageRefs.length > 0;
    const useOpenAiMultipartEdit = kind === 'image'
        && modelRequestProfile !== 'chat-image'
        && hasImageReferences
        && imageTransport.referenceBody === 'multipart-files';
    const imageReferenceFiles = useOpenAiMultipartEdit
        ? await prepareOpenAiImageEditFiles(references)
        : [];
    const imageReferenceInputs = useOpenAiMultipartEdit
        ? []
        : (await resolveReferenceValues('image', references.rawImageRefs, references.imageRefs, {
            references,
            providerReferenceInputMode,
            providerReferenceInputModes,
            providerFileUploadPath,
            providerFileUploadPaths,
            providerFileUploadMediaKinds,
            providerFileUploadPurpose,
            providerTextProtocol,
            effectiveBaseUrl,
            effectiveApiKey,
            provider,
            providerAuthMode,
            providerProfile,
            signal,
            executionTimeoutMs
        })).map((input) => input.value);
    const imageReferenceCount = imageReferenceFiles.length || imageReferenceInputs.length;
    if (imageReferenceInputs.some((value) => value.startsWith('data:'))
        && imageReferenceInputs.reduce((total, value) => total + Buffer.byteLength(value), 0) > profile.maxEncodedReferenceBytes) {
        throw new Error(`参考图编码后总大小超过本机上限：最多 ${Math.floor(profile.maxEncodedReferenceBytes / 1024 / 1024)} MiB；可改用公网 URL 或减少本地参考图数量`);
    }
    const videoReferenceInputs = kind === 'video'
        ? await resolveReferenceValues('video', references.rawVideoRefs, references.videoRefs, {
            references, providerReferenceInputMode, providerReferenceInputModes, providerFileUploadPath,
            providerFileUploadPaths, providerFileUploadMediaKinds, providerFileUploadPurpose, providerTextProtocol,
            effectiveBaseUrl, effectiveApiKey, provider, providerAuthMode, providerProfile, signal, executionTimeoutMs
        })
        : [];
    const audioReferenceInputs = kind === 'video'
        ? await resolveReferenceValues('audio', references.rawAudioRefs, references.audioRefs, {
            references, providerReferenceInputMode, providerReferenceInputModes, providerFileUploadPath,
            providerFileUploadPaths, providerFileUploadMediaKinds, providerFileUploadPurpose, providerTextProtocol,
            effectiveBaseUrl, effectiveApiKey, provider, providerAuthMode, providerProfile, signal, executionTimeoutMs
        })
        : [];
    const videoReferenceValues = videoReferenceInputs.map((input) => input.value);
    const audioReferenceValues = audioReferenceInputs.map((input) => input.value);
    const resolvedProfile = modelRequestProfile ?? 'auto';
    if (kind === 'video'
        && profile.id === 'grok2api'
        && (references.videoRefs.length > 0 || references.audioRefs.length > 0)) {
        throw new Error('GROK2API 视频协议仅支持图片参考，不支持视频或音频参考');
    }
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
                const { response, data } = await fetchJson(url, { method: 'POST', headers, body: JSON.stringify(payload), ...(signal ? { signal } : {}) }, executionTimeoutMs ?? 240000, outboundPolicy);
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
    const useJsonImageEdit = kind === 'image'
        && imageReferenceInputs.length > 0
        && imageTransport.referenceBody === 'json-image-values';
    const useGrokImageEdit = kind === 'image'
        && imageReferenceInputs.length > 0
        && imageTransport.referenceBody === 'json-image-objects';
    const useLegacyGrokImageEdit = useGrokImageEdit
        && profile.id !== 'grok2api'
        && isGrokImagineImageModel(cleanModel);
    const configuredEndpoint = resolveGenerationEndpoint({ kind, protocol: 'openai-compatible', configured: generationEndpoints });
    const endpoint = kind === 'image'
        ? (hasImageReferences ? imageTransport.referenceEndpoint : imageTransport.generationEndpoint)
        : profile.videoGenerationEndpoint;
    const usesConfiguredImageEditEndpoint = kind === 'image'
        && hasImageReferences
        && imageTransport.referenceEndpoint === 'images/edits';
    if (configuredEndpoint && usesConfiguredImageEditEndpoint && !configuredEndpoint.editPath) {
        throw new Error('当前图片传输合同需要独立编辑接口，但 Provider 未配置 editPath；请填写编辑接口或改用统一 generations 合同');
    }
    const submitEndpoint = configuredEndpoint
        ? (usesConfiguredImageEditEndpoint ? configuredEndpoint.editPath : configuredEndpoint.submitPath)
        : endpoint;
    const requestModel = useLegacyGrokImageEdit
        ? 'grok-imagine-image-quality'
        : cleanModel;
    const parameterCapabilities = resolveModelParameterCapabilities({
        protocol: 'openai-compatible',
        kind,
        model: cleanModel,
        overrides: modelCapabilities
    });
    const compiledImageParameters = kind === 'image'
        ? compileImageRequestParameters({
            protocol: 'openai-compatible',
            providerProfile: profile.id,
            model: cleanModel,
            presetId: imagePresetId,
            capabilityOverrides: modelCapabilities,
            encodingOverride: imageRequestEncoding,
            aspectRatio: ratio,
            resolution,
            quality,
            batchSize
        })
        : null;
    const imagePayloadParameters = compiledImageParameters?.payload ?? {};
    const imageEditPayloadParameters = Object.fromEntries(Object.entries(imagePayloadParameters).filter(([key]) => key !== 'aspect_ratio' && key !== 'size'));
    const normalizedVideoParameters = kind === 'video' && parameterCapabilities.kind === 'video'
        ? normalizeVideoParameters(parameterCapabilities.video, {
            aspectRatio: ratio,
            resolution,
            duration,
            mode: videoReferenceMode
        })
        : null;
    // A model-level video mapping is an explicit Provider decision, so it replaces the built-in
    // generic video fields instead of being layered on top of them. Without it the legacy payload is
    // kept byte-for-byte, which is what every existing verified video Provider relies on.
    const compiledVideoParameters = kind === 'video' && videoRequestEncoding && parameterCapabilities.kind === 'video'
        ? compileVideoRequestParameters({
            capabilities: parameterCapabilities.video,
            encoding: videoRequestEncoding,
            ...(ratio ? { aspectRatio: ratio } : {}),
            ...(resolution ? { resolution } : {}),
            ...(duration !== undefined ? { duration } : {}),
            ...(videoReferenceMode ? { mode: videoReferenceMode } : {})
        }).payload
        : null;
    let submittedImageReferenceCount = imageReferenceCount;
    const payload = kind === 'image' && useJsonImageEdit
        ? {
            model: requestModel,
            prompt: cleanPrompt,
            ...imagePayloadParameters
        }
        : kind === 'image' && useGrokImageEdit
            ? {
                model: requestModel,
                prompt: cleanPrompt,
                ...imageEditPayloadParameters,
                response_format: 'url'
            }
            : kind === 'image' && profile.mediaParameterStyle === 'grok-native'
                ? {
                    model: requestModel,
                    prompt: cleanPrompt,
                    ...(compiledImageParameters?.payload ?? {}),
                    response_format: 'url'
                }
                : kind === 'image'
                    ? {
                        model: requestModel,
                        prompt: cleanPrompt,
                        ...(compiledImageParameters?.payload ?? {}),
                        ...(shouldUseLegacyImageResponseFormat(cleanModel) ? { response_format: 'url' } : {})
                    }
                    : profile.mediaParameterStyle === 'grok-native'
                        ? {
                            model: cleanModel,
                            prompt: cleanPrompt,
                            ...(compiledVideoParameters ?? {
                                duration: normalizedVideoParameters?.duration ?? duration ?? 5,
                                aspect_ratio: normalizedVideoParameters?.aspectRatio ?? ratio,
                                ...(normalizedVideoParameters?.resolution
                                    ? { resolution: normalizedVideoParameters.resolution.toLowerCase() }
                                    : {})
                            }),
                            ...(imageReferenceInputs.length > 0
                                ? { reference_images: imageReferenceInputs.map((url) => ({ url })) }
                                : {})
                        }
                        : {
                            model: cleanModel,
                            prompt: cleanPrompt,
                            ...(compiledVideoParameters ?? {
                                size: ratio,
                                duration: duration ?? 5
                            }),
                            ...(imageReferenceInputs.length > 0 ? { reference_images: imageReferenceInputs } : {}),
                            ...(videoReferenceValues.length > 0 ? { reference_videos: videoReferenceValues } : {}),
                            ...(audioReferenceValues.length > 0 ? { reference_audios: audioReferenceValues } : {})
                        };
    if (kind === 'image' && imageReferenceInputs.length > 0) {
        if (useJsonImageEdit) {
            if (imageReferenceInputs.length === 1)
                payload.image = imageReferenceInputs[0];
            else
                payload.images = imageReferenceInputs;
        }
        else if (useGrokImageEdit) {
            if (imageReferenceInputs.length === 1) {
                payload.image = useLegacyGrokImageEdit
                    ? { url: imageReferenceInputs[0], type: 'image_url' }
                    : { url: imageReferenceInputs[0] };
            }
            else {
                payload.images = imageReferenceInputs.map((url) => useLegacyGrokImageEdit
                    ? { url, type: 'image_url' }
                    : { url });
            }
        }
        else if (imageTransport.referenceBody === 'input-image') {
            if (imageReferenceInputs.length > 1) {
                throw new Error(`当前图片传输合同只支持 1 张参考图，实际 ${imageReferenceInputs.length} 张`);
            }
            payload.input_image = imageReferenceInputs[0];
            submittedImageReferenceCount = 1;
        }
        else if (imageTransport.referenceBody === 'images-array') {
            payload.images = imageReferenceInputs;
        }
        else if (imageTransport.referenceBody === 'image-url-values') {
            payload.image_urls = imageReferenceInputs;
        }
        else if (imageTransport.referenceBody === 'reference-images') {
            payload.reference_images = imageReferenceInputs;
        }
    }
    if (useOpenAiMultipartEdit) {
        const form = new FormData();
        form.append('model', requestModel);
        form.append('prompt', cleanPrompt);
        for (const [key, value] of Object.entries(imagePayloadParameters)) {
            if (value !== undefined && value !== null)
                form.append(key, String(value));
        }
        for (const file of imageReferenceFiles) {
            form.append(imageReferenceFiles.length === 1 ? 'image' : 'image[]', file.blob, file.filename);
        }
        const multipartHeaders = { ...headers };
        delete multipartHeaders['Content-Type'];
        const { response, data } = await fetchJson(configuredEndpoint ? generationEndpointUrl(effectiveBaseUrl, submitEndpoint) : openAiEndpointUrl(effectiveBaseUrl, endpoint), { method: 'POST', headers: multipartHeaders, body: form, ...(signal ? { signal } : {}) }, executionTimeoutMs ?? 240000, outboundPolicy);
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
            ...(taskId ? { taskId } : {}),
            ...(previewUrls[0] ? { previewUrl: previewUrls[0] } : {}),
            ...(previewUrls.length > 0 ? { previewUrls } : {}),
            message: `生成完成，已传递 ${submittedImageReferenceCount} 张参考图`,
            referenceCount: submittedImageReferenceCount
        };
    }
    const { response, data } = await fetchJson(configuredEndpoint ? generationEndpointUrl(effectiveBaseUrl, submitEndpoint) : openAiEndpointUrl(effectiveBaseUrl, endpoint), { method: 'POST', headers, body: JSON.stringify(payload), ...(signal ? { signal } : {}) }, executionTimeoutMs ?? (kind === 'image' ? 240000 : 30000), outboundPolicy);
    if (!response.ok) {
        const message = readErrorMessage(data, `HTTP ${response.status}`);
        throw new Error(describeGrokUpstreamError(message, cleanModel, providerName, response));
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
            ? `生成完成${submittedImageReferenceCount > 0 ? `，已传递 ${submittedImageReferenceCount} 张参考图` : ''}`
            : (normalizedStatus === 'failed'
                ? readGenerationFailureReason(data) || '生成失败'
                : normalizedStatus === 'processing'
                    ? `异步生成中${submittedImageReferenceCount > 0 ? `，已传递 ${submittedImageReferenceCount} 张参考图` : ''}`
                    : `任务已提交${submittedImageReferenceCount > 0 ? `，已传递 ${submittedImageReferenceCount} 张参考图` : ''}`),
        referenceCount: submittedImageReferenceCount + (kind === 'video' ? videoReferenceValues.length + audioReferenceValues.length : 0)
    };
};
export const queryOpenAiCompatibleGenerationStatus = async ({ kind, providerId, providerProfile, providerAuthMode, generationEndpoints, provider, effectiveBaseUrl, effectiveApiKey, taskId, requestTimeoutMs, signal }) => {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    const outboundPolicy = createProviderOutboundPolicy(provider, effectiveBaseUrl);
    const profile = getOpenAiProviderProfile(providerProfile);
    applyProviderAuthorization(headers, effectiveApiKey, providerAuthMode, profile);
    const configuredEndpoint = resolveGenerationEndpoint({ kind, protocol: 'openai-compatible', configured: generationEndpoints });
    if (configuredEndpoint?.mode === 'sync') {
        return { ok: true, providerId, status: 'completed', taskId, previewUrls: [], message: '同步生成无需查询状态' };
    }
    const endpoint = kind === 'image' ? 'images/generations' : kind === 'audio' ? 'audio/generations' : 'videos/generations';
    const candidateUrls = configuredEndpoint?.statusPath
        ? [generationStatusEndpointUrl(effectiveBaseUrl, configuredEndpoint.statusPath, taskId)]
        : kind === 'video' && profile.videoStatusStyle === 'grok-video'
            ? [openAiEndpointUrl(effectiveBaseUrl, `videos/${encodeURIComponent(taskId)}`)]
            : [
                openAiEndpointUrl(effectiveBaseUrl, `${endpoint}/${encodeURIComponent(taskId)}`),
                kind === 'image' ? openAiEndpointUrl(effectiveBaseUrl, `images/tasks/${encodeURIComponent(taskId)}`) : '',
                openAiEndpointUrl(effectiveBaseUrl, `tasks/${encodeURIComponent(taskId)}`),
                openAiEndpointUrl(effectiveBaseUrl, `task/${encodeURIComponent(taskId)}`),
                openAiEndpointUrl(effectiveBaseUrl, `async/tasks/${encodeURIComponent(taskId)}`),
                kind === 'video' ? openAiEndpointUrl(effectiveBaseUrl, `videos/${encodeURIComponent(taskId)}`) : ''
            ].filter(Boolean);
    let lastError = '';
    let preferredError = '';
    for (const url of candidateUrls) {
        const { response, data } = await fetchJson(url, { headers, ...(signal ? { signal } : {}) }, requestTimeoutMs ?? 10000, outboundPolicy);
        if (!response.ok) {
            lastError = readErrorMessage(data, `HTTP ${response.status}`);
            if (!preferredError && response.status !== 404 && !/invalid url/i.test(lastError)) {
                preferredError = lastError;
            }
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
