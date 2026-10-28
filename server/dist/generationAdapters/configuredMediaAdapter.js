import { compileImageRequestParameters, compileVideoRequestParameters, resolveModelParameterCapabilities } from '@ftv/shared';
import { fetchJson } from '../httpClient.js';
import { createProviderOutboundPolicy } from '../providers.js';
import { extractGenerationUrls, isGenerationPreviewResource, normalizeGenerationStatus } from '../generationParsers.js';
import { generationEndpointUrl, generationStatusEndpointUrl, assertGenerationSubmissionMode, resolveGenerationEndpoint } from './generationEndpointProfiles.js';
import { applyProviderAuthorization, getOpenAiProviderProfile } from './openAiProviderProfiles.js';
import { resolveReferenceValues } from './openAiCompatibleAdapter.js';
const defaultConfiguredEndpoint = (kind) => (kind === 'image'
    ? { mode: 'sync', submitPath: 'images/generations' }
    : kind === 'video'
        ? { mode: 'async', submitPath: 'videos/generations', statusPath: 'videos/generations/{task_id}' }
        : undefined);
const resolveConfiguredEndpoint = (kind, configured) => (resolveGenerationEndpoint({ kind, protocol: undefined, configured }) ?? defaultConfiguredEndpoint(kind));
const getPathValues = (value, path) => {
    const parts = path.split('.');
    const walk = (current, index) => {
        if (index >= parts.length)
            return [current];
        if (current === null || current === undefined)
            return [];
        const part = parts[index];
        if (part.endsWith('[]')) {
            const key = part.slice(0, -2);
            const next = key ? current[key] : current;
            return Array.isArray(next) ? next.flatMap((item) => walk(item, index + 1)) : [];
        }
        if (part === '[]')
            return Array.isArray(current) ? current.flatMap((item) => walk(item, index + 1)) : [];
        if (typeof current !== 'object')
            return [];
        return walk(current[part], index + 1);
    };
    return walk(value, 0);
};
const firstString = (value, paths) => (paths?.flatMap((path) => getPathValues(value, path)).map((item) => typeof item === 'string' ? item.trim() : '').find(Boolean));
const stringValues = (value, paths) => Array.from(new Set(paths.flatMap((path) => getPathValues(value, path)).flatMap((item) => {
    if (typeof item === 'string')
        return isGenerationPreviewResource(item) ? [item.trim()] : [];
    if (item && typeof item === 'object') {
        const record = item;
        for (const key of ['url', 'image_url', 'video_url', 'audio_url', 'cover_url', 'watermark_free_url', 'fallback_url']) {
            if (typeof record[key] === 'string' && isGenerationPreviewResource(record[key]))
                return [record[key].trim()];
        }
        if (typeof record.b64_json === 'string' && record.b64_json.length > 0)
            return [`data:image/png;base64,${record.b64_json}`];
    }
    return [];
})));
const setPath = (target, path, value) => {
    const parts = path.split('.');
    let current = target;
    parts.forEach((part, index) => {
        if (index === parts.length - 1)
            current[part] = value;
        else {
            const next = current[part];
            current[part] = next && typeof next === 'object' && !Array.isArray(next) ? next : {};
            current = current[part];
        }
    });
};
const valueForField = (context, field) => {
    const values = {
        prompt: context.cleanPrompt,
        model: context.cleanModel,
    };
    return values[field];
};
const transformValue = (field, value, transform) => {
    if (!transform || value === undefined || value === null)
        return value;
    const raw = String(value);
    const casing = transform.casing ?? 'preserve';
    const applyCasing = (input) => casing === 'lower' ? input.toLowerCase() : casing === 'upper' ? input.toUpperCase() : input;
    const transformed = applyCasing(raw);
    const mapped = Object.entries(transform.valueMap ?? {}).find(([key]) => applyCasing(key) === transformed)?.[1];
    if (mapped !== undefined)
        return mapped;
    return typeof value === 'string' ? transformed : value;
};
const resolveConfiguredReference = async (context, kind, contract) => {
    if (contract.shape === 'omit')
        return [];
    const rawRefs = kind === 'image' ? context.references.rawImageRefs : kind === 'video' ? context.references.rawVideoRefs : context.references.rawAudioRefs;
    const publicRefs = kind === 'image' ? context.references.imageRefs : kind === 'video' ? context.references.videoRefs : context.references.audioRefs;
    const sourceRefs = rawRefs.length > 0 ? rawRefs : publicRefs;
    const single = contract.shape === 'string' || contract.shape === 'object-url' || contract.shape === 'multipart-single';
    const maxCount = single ? Math.min(contract.maxCount ?? 1, 1) : contract.maxCount;
    if (maxCount !== undefined && sourceRefs.length > maxCount)
        throw new Error(`参考素材最多支持 ${maxCount} 个，实际 ${sourceRefs.length} 个`);
    // Multipart sends blobs directly; resolving/uploading URLs first can fail
    // unnecessarily and would read the same reference twice.
    if (contract.shape === 'multipart-single' || contract.shape === 'multipart-array')
        return sourceRefs;
    const inputs = await resolveReferenceValues(kind, rawRefs, publicRefs, {
        references: context.references,
        providerReferenceInputMode: contract.input === 'public-url' ? 'public-url' : contract.input === 'data-url' ? 'data-url' : context.providerReferenceInputMode,
        providerReferenceInputModes: contract.input === 'auto' ? context.providerReferenceInputModes : [contract.input],
        providerFileUploadPath: context.providerFileUploadPath,
        providerFileUploadPaths: context.providerFileUploadPaths,
        providerFileUploadMediaKinds: context.providerFileUploadMediaKinds,
        providerFileUploadPurpose: context.providerFileUploadPurpose,
        providerTextProtocol: context.providerTextProtocol,
        effectiveBaseUrl: context.effectiveBaseUrl,
        effectiveApiKey: context.effectiveApiKey,
        provider: context.provider,
        providerAuthMode: context.providerAuthMode,
        providerProfile: context.providerProfile,
        signal: context.signal,
        executionTimeoutMs: context.executionTimeoutMs
    });
    if (contract.maxCount && inputs.length > contract.maxCount)
        throw new Error(`参考素材最多支持 ${contract.maxCount} 个`);
    return inputs.map((item) => item.value);
};
const appendMultipartReference = async (form, context, contract, values) => {
    if (contract.shape === 'omit')
        return;
    if (contract.shape !== 'multipart-single' && contract.shape !== 'multipart-array')
        throw new Error('multipart 请求的参考素材结构必须是 multipart-single 或 multipart-array');
    const files = await Promise.all(values.map((value) => context.references.toReferenceBlob(value)));
    if (files.some((file) => !file))
        throw new Error('multipart 参考素材读取失败');
    const validFiles = files.filter((file) => Boolean(file));
    if (contract.shape === 'multipart-single' && validFiles.length > 1)
        throw new Error(`当前 multipart 合同只支持 1 个参考素材，实际 ${validFiles.length} 个`);
    validFiles.forEach((file) => form.append(contract.field, file.blob, file.filename));
};
const buildPayload = async (context, contract) => {
    const references = contract.references ?? (contract.reference ? { [context.kind]: contract.reference } : {});
    const resolvedReferences = await Promise.all(Object.entries(references).map(async ([kind, reference]) => [kind, await resolveConfiguredReference(context, kind, reference)]));
    const referenceValues = resolvedReferences.flatMap(([, values]) => values);
    const compiledParameters = context.kind === 'image'
        ? compileImageRequestParameters({
            protocol: context.providerProtocol ?? 'openai-compatible',
            providerProfile: context.providerProfile,
            model: context.cleanModel,
            presetId: context.imagePresetId,
            capabilityOverrides: context.modelCapabilities,
            encodingOverride: context.imageRequestEncoding,
            aspectRatio: context.ratio,
            resolution: context.resolution,
            quality: context.quality,
            batchSize: context.batchSize
        }).payload
        : context.kind === 'video'
            ? (() => {
                const capabilities = resolveModelParameterCapabilities({
                    protocol: context.providerProtocol ?? 'openai-compatible',
                    kind: 'video',
                    model: context.cleanModel,
                    overrides: context.modelCapabilities
                });
                if (capabilities.kind !== 'video')
                    return {};
                return compileVideoRequestParameters({
                    capabilities: capabilities.video,
                    ...(context.videoRequestEncoding ? { encoding: context.videoRequestEncoding } : {}),
                    ...(context.ratio ? { aspectRatio: context.ratio } : {}),
                    ...(context.resolution ? { resolution: context.resolution } : {}),
                    ...(context.duration !== undefined ? { duration: context.duration } : {}),
                    ...(context.videoReferenceMode ? { mode: context.videoReferenceMode } : {})
                }).payload;
            })()
            : {};
    if (contract.requestFormat === 'multipart') {
        const form = new FormData();
        for (const [field, path] of Object.entries(contract.fields)) {
            if (field !== 'prompt' && field !== 'model')
                continue;
            const value = transformValue(field, valueForField(context, field), contract.valueTransforms?.[field]);
            if (value !== undefined && value !== null)
                form.append(path, String(value));
        }
        for (const [path, value] of Object.entries(compiledParameters))
            form.append(path, String(value));
        for (const [kind, reference] of Object.entries(references))
            await appendMultipartReference(form, context, reference, resolvedReferences.find(([item]) => item === kind)?.[1] ?? []);
        return { body: form, referenceCount: referenceValues.length, multipart: true };
    }
    const payload = {};
    for (const [field, path] of Object.entries(contract.fields)) {
        if (field !== 'prompt' && field !== 'model')
            continue;
        const value = transformValue(field, valueForField(context, field), contract.valueTransforms?.[field]);
        if (value !== undefined && value !== null)
            setPath(payload, path, value);
    }
    Object.entries(compiledParameters).forEach(([path, value]) => setPath(payload, path, value));
    for (const [kind, reference] of Object.entries(references)) {
        if (reference.shape === 'omit')
            continue;
        const values = resolvedReferences.find(([item]) => item === kind)?.[1] ?? [];
        if (reference.shape === 'string')
            setPath(payload, reference.field, values[0]);
        else if (reference.shape === 'string-array')
            setPath(payload, reference.field, values);
        else if (reference.shape === 'object-url')
            setPath(payload, reference.field, values[0] ? { url: values[0] } : undefined);
        else if (reference.shape === 'object-url-array')
            setPath(payload, reference.field, values.map((url) => ({ url })));
        else
            throw new Error('JSON 请求的参考素材结构配置无效');
    }
    return { body: JSON.stringify(payload), referenceCount: referenceValues.length, multipart: false };
};
const parseConfiguredResult = (data, contract, taskIdFallback) => {
    const taskId = firstString(data, contract.response.taskIdPath ? [contract.response.taskIdPath] : undefined) ?? taskIdFallback;
    const rawStatus = firstString(data, contract.response.statusPath ? [contract.response.statusPath] : undefined);
    const declaredStatus = contract.response.statusMap?.[rawStatus ?? ''] ?? (rawStatus ? normalizeGenerationStatus(rawStatus) : undefined);
    const terminalFailure = declaredStatus === 'failed' || declaredStatus === 'timeout';
    const explicitPreviewUrls = terminalFailure ? [] : stringValues(data, contract.response.previewPaths);
    const compatibilityPreviewUrls = explicitPreviewUrls.length === 0 && !terminalFailure
        ? extractGenerationUrls(data, { allowEmbeddedUrlText: false, restrictToResourceContainers: true })
        : [];
    const previewUrls = explicitPreviewUrls.length > 0 ? explicitPreviewUrls : compatibilityPreviewUrls;
    // A provider that explicitly reports an in-progress task must keep polling: treating a partial
    // or preview resource as the finished result would drop the upstream task id, so MK could no
    // longer poll it or cancel it.
    const declaredPending = declaredStatus === 'queued' || declaredStatus === 'processing';
    const status = terminalFailure
        ? declaredStatus
        : declaredPending && (Boolean(taskId) || previewUrls.length === 0)
            ? declaredStatus
            : previewUrls.length > 0
                ? 'completed'
                : declaredStatus ?? (taskId ? 'processing' : 'completed');
    const message = firstString(data, contract.response.errorPaths)
        ?? (terminalFailure ? '供应商返回生成失败' : status === 'completed' ? '生成完成' : '异步生成中');
    return {
        previewUrls,
        taskId,
        status,
        message,
        position: contract.response.positionPath ? getPathValues(data, contract.response.positionPath)[0] : undefined
    };
};
export const submitConfiguredMediaGeneration = async (context) => {
    const contract = context.mediaContracts?.[context.kind === 'image' || context.kind === 'video' || context.kind === 'audio' ? context.kind : 'image'];
    if (!contract)
        throw new Error('缺少当前媒体类型的自定义生成合同');
    const endpoint = resolveConfiguredEndpoint(context.kind, context.generationEndpoints);
    const hasReferences = context.references.rawImageRefs.length + context.references.rawVideoRefs.length + context.references.rawAudioRefs.length > 0;
    const path = hasReferences && contract.referenceEndpoint === 'edit' ? endpoint?.editPath : endpoint?.submitPath;
    if (!path)
        throw new Error('自定义媒体合同缺少提交接口');
    // Some OpenAI-compatible gateways/proxies close an idle keep-alive socket
    // while a reference-image request is being prepared or processed. Do not
    // reuse the previous no-reference request's socket for this submission.
    const headers = { Accept: 'application/json', Connection: 'close' };
    const profile = getOpenAiProviderProfile(context.providerProfile);
    applyProviderAuthorization(headers, context.effectiveApiKey, context.providerAuthMode, profile);
    if (!contract.requestFormat || contract.requestFormat === 'json')
        headers['Content-Type'] = 'application/json';
    const built = await buildPayload(context, contract);
    if (built.multipart)
        delete headers['Content-Type'];
    const { response, data } = await fetchJson(generationEndpointUrl(context.effectiveBaseUrl, path), { method: 'POST', headers, body: built.body, ...(context.signal ? { signal: context.signal } : {}) }, context.executionTimeoutMs ?? 240000, createProviderOutboundPolicy(context.provider, context.effectiveBaseUrl));
    if (!response.ok)
        throw new Error(firstString(data, contract.response.errorPaths) ?? `HTTP ${response.status}`);
    const parsed = parseConfiguredResult(data, contract);
    assertGenerationSubmissionMode({ endpoint, kind: context.kind, previewUrls: parsed.previewUrls, taskId: parsed.taskId, status: parsed.status });
    return { ok: true, providerId: context.providerId, providerName: context.providerName, status: parsed.status, ...(parsed.taskId ? { taskId: parsed.taskId } : {}), ...(parsed.previewUrls[0] ? { previewUrl: parsed.previewUrls[0] } : {}), previewUrls: parsed.previewUrls.filter((value) => Boolean(value)), message: parsed.message, referenceCount: built.referenceCount };
};
export const queryConfiguredMediaGenerationStatus = async (context) => {
    const contract = context.mediaContracts?.[context.kind];
    if (!contract)
        throw new Error('缺少当前媒体类型的自定义生成合同');
    const endpoint = resolveConfiguredEndpoint(context.kind, context.generationEndpoints);
    if (endpoint?.mode === 'sync')
        return { ok: true, providerId: context.providerId, status: 'completed', taskId: context.taskId, previewUrls: [], message: '同步生成无需查询状态' };
    if (!endpoint?.statusPath)
        throw new Error('异步媒体合同缺少查询接口');
    const headers = { Accept: 'application/json' };
    applyProviderAuthorization(headers, context.effectiveApiKey, context.providerAuthMode, getOpenAiProviderProfile(context.providerProfile));
    const { response, data } = await fetchJson(generationStatusEndpointUrl(context.effectiveBaseUrl, endpoint.statusPath, context.taskId), { headers, ...(context.signal ? { signal: context.signal } : {}) }, context.requestTimeoutMs ?? 30000, createProviderOutboundPolicy(context.provider, context.effectiveBaseUrl));
    if (!response.ok)
        throw new Error(firstString(data, contract.response.errorPaths) ?? `HTTP ${response.status}`);
    const parsed = parseConfiguredResult(data, contract, context.taskId);
    return { ok: true, providerId: context.providerId, status: parsed.status, taskId: context.taskId, ...(parsed.previewUrls[0] ? { previewUrl: parsed.previewUrls[0] } : {}), previewUrls: parsed.previewUrls.filter((value) => Boolean(value)), message: parsed.message, ...(parsed.position !== undefined ? { position: parsed.position } : {}) };
};
export const cancelConfiguredMediaGeneration = async (context) => {
    const endpoint = resolveConfiguredEndpoint(context.kind, context.generationEndpoints);
    if (endpoint?.mode !== 'async')
        throw new Error('同步媒体合同没有取消任务接口');
    if (!endpoint?.cancelPath)
        throw new Error('当前自定义媒体合同未配置取消接口');
    const headers = { Accept: 'application/json' };
    applyProviderAuthorization(headers, context.effectiveApiKey, context.providerAuthMode, getOpenAiProviderProfile(context.providerProfile));
    const { response, data } = await fetchJson(generationStatusEndpointUrl(context.effectiveBaseUrl, endpoint.cancelPath, context.taskId), { method: endpoint.cancelMethod ?? 'POST', headers, ...(context.signal ? { signal: context.signal } : {}) }, context.requestTimeoutMs ?? 30000, createProviderOutboundPolicy(context.provider, context.effectiveBaseUrl));
    if (!response.ok)
        throw new Error(firstString(data, context.mediaContracts?.[context.kind]?.response.errorPaths) ?? `HTTP ${response.status}`);
    return { ok: true, ...(context.providerId ? { providerId: context.providerId } : {}), taskId: context.taskId, status: 'cancelled', message: '供应商任务已取消' };
};
