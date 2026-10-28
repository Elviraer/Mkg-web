import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { imageTransportFromLegacyRequestProfile, normalizeImageGenerationPresetId, normalizeImageRequestEncoding, normalizeVideoRequestEncoding, normalizeProviderImageTransportProfile, normalizeProviderGenerationEndpoints, normalizeProviderMediaGenerationContracts, normalizeProviderModelCapabilityOverrides, normalizeGenerationTimeoutPolicy } from '@ftv/shared';
import { Router } from 'express';
import { asUniqueList, fetchJson } from '../httpClient.js';
import { detectMediaBuffer } from '../mediaFileType.js';
import { DEFAULT_MAX_REMOTE_MEDIA_BYTES, fetchRemoteMediaBuffer, RemoteMediaError } from '../remoteMedia.js';
import { getGenerationAdapter } from '../generationAdapters/adapterRegistry.js';
import { materializeCompletedGenerationAssets } from '../generationAssetMaterialization.js';
import { normalizeProviderAuthMode, normalizeProviderProfile } from '../generationAdapters/openAiProviderProfiles.js';
import { getProviderCapabilities, getProviderCapabilitiesForContext } from '../generationAdapters/providerCapabilities.js';
import { createProviderOutboundPolicy, ProviderRequestConfigError, resolveProvider, resolveProviderRequestConfig, } from '../providers.js';
import { getErrorMessage, readErrorMessage, readField, readString } from '../unknownJson.js';
import { createMemoryGenerationJobStore } from '../generationJobStore.js';
const getInternalReferencePathname = (origin, value) => {
    if (value.startsWith('/'))
        return value;
    if (!/^https?:\/\//i.test(value))
        return null;
    try {
        const url = new URL(value);
        return url.origin === new URL(origin).origin ? url.pathname : null;
    }
    catch {
        return null;
    }
};
const getLocalReferenceFile = (origin, value, { uploadsDir, historyAssetsDir, libraryAssetsDir, resolveLinkedSource }) => {
    const pathname = getInternalReferencePathname(origin, value);
    if (!pathname)
        return null;
    const linkedSource = resolveLinkedSource?.(value) ?? resolveLinkedSource?.(pathname);
    if (linkedSource)
        return { filePath: path.resolve(linkedSource), databaseResolved: true };
    if (pathname.startsWith('/api/uploads/')) {
        return { filePath: path.join(uploadsDir, path.basename(pathname)), databaseResolved: false };
    }
    if (pathname.startsWith('/api/history-assets/files/')) {
        return { filePath: path.join(historyAssetsDir, path.basename(pathname)), databaseResolved: false };
    }
    if (libraryAssetsDir && pathname.startsWith('/api/library-assets/files/')) {
        return { filePath: path.join(libraryAssetsDir, path.basename(pathname)), databaseResolved: false };
    }
    return null;
};
const getRequestOrigin = (req) => `${req.protocol}://${req.get('host')}`;
const toPublicReferenceUrl = (origin, value) => {
    if (/^https?:\/\//.test(value))
        return value;
    if (value.startsWith('/api/uploads/')
        || value.startsWith('/api/history-assets/files/')
        || /^\/api\/history-assets\/[^/]+\/file(?:[?#].*)?$/.test(value)
        || value.startsWith('/api/library-assets/files/')
        || /^\/api\/library-assets\/[^/]+\/file(?:[?#].*)?$/.test(value)) {
        return `${origin}${value}`;
    }
    return null;
};
const referenceToBlob = async (origin, value, referenceDirs, outboundPolicy) => {
    const internalPathname = getInternalReferencePathname(origin, value);
    const localFile = getLocalReferenceFile(origin, value, referenceDirs);
    if (localFile) {
        const { filePath: localFilePath, databaseResolved } = localFile;
        if (!databaseResolved) {
            const rootDir = internalPathname?.startsWith('/api/history-assets/files/')
                ? referenceDirs.historyAssetsDir
                : internalPathname?.startsWith('/api/library-assets/files/')
                    ? referenceDirs.libraryAssetsDir
                    : referenceDirs.uploadsDir;
            if (!rootDir)
                return null;
            const relativePath = path.relative(path.resolve(rootDir), path.resolve(localFilePath));
            if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath))
                return null;
        }
        if (!fs.existsSync(localFilePath) || !fs.statSync(localFilePath).isFile())
            return null;
        const buffer = await fs.promises.readFile(localFilePath);
        const detected = await detectMediaBuffer(buffer);
        if (!detected)
            return null;
        const sourceName = path.parse(path.basename(databaseResolved ? localFilePath : internalPathname ?? localFilePath)).name
            || `reference-${Date.now()}`;
        const filename = `${sourceName}${detected.extension}`;
        return {
            blob: new Blob([buffer], { type: detected.mime }),
            filename
        };
    }
    if (value.startsWith('data:')) {
        const [header = '', body = ''] = value.split(',', 2);
        const isBase64 = /;base64/i.test(header);
        const buffer = isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body));
        if (buffer.byteLength > DEFAULT_MAX_REMOTE_MEDIA_BYTES)
            return null;
        const detected = await detectMediaBuffer(buffer);
        if (!detected)
            return null;
        const filename = `reference-${Date.now()}${detected.extension}`;
        return {
            blob: new Blob([buffer], { type: detected.mime }),
            filename
        };
    }
    if (/^https?:\/\//.test(value)) {
        const remote = await fetchRemoteMediaBuffer(value, { policy: outboundPolicy });
        const sourceName = path.parse(path.basename(new URL(value).pathname)).name || `reference-${Date.now()}`;
        const filename = `${sourceName}${remote.detected.extension}`;
        return {
            blob: new Blob([remote.bytes], { type: remote.detected.mime }),
            filename
        };
    }
    return null;
};
const toImageDataUrl = async (origin, value, referenceDirs, outboundPolicy) => {
    if (value.startsWith('data:image/'))
        return value;
    const file = await referenceToBlob(origin, value, referenceDirs, outboundPolicy);
    if (!file || !file.blob.type.startsWith('image/'))
        return toPublicReferenceUrl(origin, value);
    const buffer = Buffer.from(await file.blob.arrayBuffer());
    return `data:${file.blob.type};base64,${buffer.toString('base64')}`;
};
const toMediaDataUrl = async (origin, value, referenceDirs, outboundPolicy) => {
    if (value.startsWith('data:'))
        return value;
    const file = await referenceToBlob(origin, value, referenceDirs, outboundPolicy);
    if (!file)
        return toPublicReferenceUrl(origin, value);
    const buffer = Buffer.from(await file.blob.arrayBuffer());
    return `data:${file.blob.type};base64,${buffer.toString('base64')}`;
};
const toXyqReferenceImageInput = async (origin, value, baseUrl, headers, referenceDirs) => {
    if (/^https?:\/\//.test(value) && !getInternalReferencePathname(origin, value))
        return value;
    const file = await referenceToBlob(origin, value, referenceDirs);
    if (!file)
        return toPublicReferenceUrl(origin, value);
    const form = new FormData();
    form.append('file', file.blob, file.filename);
    const { response, data } = await fetchJson(`${baseUrl}/v1/uploads/images`, { method: 'POST', headers, body: form }, 30000, createProviderOutboundPolicy(resolveProvider('xyq'), baseUrl));
    if (!response.ok) {
        throw new Error(readErrorMessage(data, `小云雀参考图上传失败: HTTP ${response.status}`));
    }
    const uploadId = readString(data, 'id') ?? readString(data, 'upload_id') ?? readString(readField(data, 'data'), 'id');
    if (!uploadId) {
        throw new Error('小云雀参考图上传成功但未返回 upload_id');
    }
    return { upload_id: uploadId };
};
const toXyqReferenceAudioInput = async (origin, value, baseUrl, headers, referenceDirs) => {
    if (/^https?:\/\//.test(value) && !getInternalReferencePathname(origin, value))
        return value;
    const file = await referenceToBlob(origin, value, referenceDirs);
    if (!file)
        return toPublicReferenceUrl(origin, value);
    const form = new FormData();
    form.append('file', file.blob, file.filename);
    const { response, data } = await fetchJson(`${baseUrl}/v1/uploads/audios`, { method: 'POST', headers, body: form }, 30000, createProviderOutboundPolicy(resolveProvider('xyq'), baseUrl));
    if (!response.ok) {
        throw new Error(readErrorMessage(data, `小云雀参考音频上传失败: HTTP ${response.status}`));
    }
    const uploadId = readString(data, 'id') ?? readString(data, 'upload_id') ?? readString(readField(data, 'data'), 'id');
    if (!uploadId) {
        throw new Error('小云雀参考音频上传成功但未返回 upload_id');
    }
    return { upload_id: uploadId };
};
const providerRequestProfiles = new Set([
    'auto',
    'openai-chat',
    'chat-image',
    'openai-image',
    'image-reference-images',
    'image-input-image',
    'image-images-array',
    'async-video-task',
    'openai-audio-speech',
    'openai-audio-generation'
]);
const imageQualityValues = new Set(['auto', 'low', 'medium', 'high', 'standard', 'hd']);
const providerTextProtocols = new Set(['chat-completions', 'responses']);
const providerReferenceInputModeValues = new Set(['public-url', 'data-url', 'file-upload']);
const providerFileUploadMediaKindValues = new Set(['image', 'video', 'audio']);
const providerFileUploadPurposes = new Set(['vision', 'user_data', 'assistants']);
const normalizeProviderRequestProfile = (value) => {
    return typeof value === 'string' && providerRequestProfiles.has(value)
        ? value
        : undefined;
};
const normalizeImageQuality = (value) => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return imageQualityValues.has(normalized) ? normalized : undefined;
};
const normalizeProviderOption = (value, allowed, fallback) => (typeof value === 'string' && allowed.has(value) ? value : fallback);
const normalizeProviderFileUploadPath = (value) => {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    const normalized = trimmed.startsWith('/') ? `/${trimmed.replace(/^\/+/, '')}` : trimmed;
    if (!normalized || normalized.includes('..') || /[\\?#]/.test(normalized) || !/^\/?[a-z0-9._~!$&'()*+,;=:@/-]+$/i.test(normalized)) {
        return undefined;
    }
    return normalized;
};
const normalizeProviderReferenceInputModes = (value) => (Array.isArray(value)
    ? Array.from(new Set(value.filter((item) => (typeof item === 'string' && providerReferenceInputModeValues.has(item)))))
    : undefined);
const normalizeProviderFileUploadPaths = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const entries = Object.entries(value)
        .filter(([kind]) => providerFileUploadMediaKindValues.has(kind))
        .map(([kind, path]) => [kind, normalizeProviderFileUploadPath(path)])
        .filter((entry) => Boolean(entry[1]));
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};
const normalizeFiniteNumber = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
};
const safeBaseUrl = (value) => {
    if (!value)
        return '';
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '');
    }
    catch {
        return value.replace(/\?.*$/, '').replace(/\/+$/, '');
    }
};
const resolveGenerationProviderConfig = (response, providerId, baseUrl, apiKey, outboundPolicy = {}) => {
    try {
        return resolveProviderRequestConfig({
            providerId,
            suppliedBaseUrl: baseUrl,
            suppliedApiKey: apiKey,
            outboundPolicy,
        });
    }
    catch (error) {
        if (error instanceof ProviderRequestConfigError) {
            response.status(400).json({ ok: false, code: error.code, message: error.message });
            return null;
        }
        throw error;
    }
};
const isGenerationFailureStatus = (status) => (status === 'failed' || status === 'timeout');
const providerSupportsGenerationKind = (capabilities, kind) => {
    if (kind === 'text')
        return capabilities.supports.text;
    if (kind === 'image')
        return capabilities.supports.image;
    if (kind === 'video')
        return capabilities.supports.video;
    return capabilities.supports.audio;
};
const readErrorDiagnostic = (errorOrMessage) => {
    const diagnostics = {};
    let current = errorOrMessage;
    let depth = 0;
    while (current instanceof Error && depth < 4) {
        const candidate = current;
        if (depth === 0 && typeof candidate.requestUrl === 'string')
            diagnostics.requestUrl = candidate.requestUrl;
        if (depth === 0 && typeof candidate.requestPhase === 'string')
            diagnostics.requestPhase = candidate.requestPhase;
        if (depth === 0 && typeof candidate.timeoutMs === 'number')
            diagnostics.timeoutMs = candidate.timeoutMs;
        if (typeof candidate.code === 'string' || typeof candidate.code === 'number') {
            diagnostics[`errorCode${depth ? depth : ''}`] = candidate.code;
        }
        if (typeof candidate.errno === 'string' || typeof candidate.errno === 'number') {
            diagnostics[`errno${depth ? depth : ''}`] = candidate.errno;
        }
        if (candidate.message)
            diagnostics[`causeMessage${depth ? depth : ''}`] = candidate.message;
        current = candidate.cause;
        depth += 1;
    }
    return diagnostics;
};
const logGenerationFailure = (event, context, errorOrMessage, extra = {}) => {
    const errorMessage = getErrorMessage(errorOrMessage, String(errorOrMessage || '生成请求失败'));
    const stack = errorOrMessage instanceof Error ? errorOrMessage.stack : undefined;
    console.error(`[MK generation ${event} failed]`, JSON.stringify({
        time: new Date().toISOString(),
        ...context,
        ...extra,
        ...readErrorDiagnostic(errorOrMessage),
        error: errorMessage,
        ...(stack ? { stack } : {})
    }, null, 2));
};
const logGenerationResultFailure = (event, context, result) => {
    if (!isGenerationFailureStatus(result.status))
        return;
    logGenerationFailure(event, context, result.message, {
        resultStatus: result.status,
        resultTaskId: result.taskId,
        previewUrlCount: result.previewUrls?.length ?? (result.previewUrl ? 1 : 0)
    });
};
const validClientTaskId = (value) => (value.length >= 16
    && value.length <= 64
    && /^[A-Za-z0-9._:-]+$/.test(value));
const registerTrustedGenerationAssets = (result, provider, effectiveBaseUrl, register) => {
    if (!register)
        return;
    const outboundPolicy = createProviderOutboundPolicy(provider, effectiveBaseUrl);
    if (!outboundPolicy.trustedOrigins)
        return;
    const urls = result.previewUrls?.filter((url) => /^https?:\/\//i.test(url))
        ?? (result.previewUrl && /^https?:\/\//i.test(result.previewUrl) ? [result.previewUrl] : []);
    if (urls.length > 0)
        register(urls, outboundPolicy);
};
export const createGenerationRoutes = ({ uploadsDir, historyAssetsDir, libraryAssetsDir, resolveLinkedSource, registerTrustedAssetUrls, resolveTrustedAssetPolicy, generationJobStore = createMemoryGenerationJobStore(), registerExecutionShutdown, persistGeneratedMedia, }) => {
    const router = Router();
    const referenceDirs = { uploadsDir, historyAssetsDir, libraryAssetsDir, resolveLinkedSource };
    const executionPromises = new Map();
    const executionControllers = new Map();
    const runtimeWorkflows = new Map();
    const providerQueryPromises = new Map();
    const providerQueryControllers = new Map();
    registerExecutionShutdown?.(async () => {
        executionControllers.forEach((controller) => {
            controller.abort(new DOMException('Generation server shutdown', 'AbortError'));
        });
        providerQueryControllers.forEach((controller) => {
            controller.abort(new DOMException('Generation server shutdown', 'AbortError'));
        });
        await Promise.allSettled([...executionPromises.values(), ...providerQueryPromises.values()]);
    });
    const recoveredJobs = generationJobStore.recoverInterruptedGenerationJobs();
    if (recoveredJobs > 0)
        console.info(`[MK generation jobs] 已恢复 ${recoveredJobs} 个中断任务，等待客户端续查`);
    const sweepGenerationJobs = () => {
        const now = new Date();
        const result = generationJobStore.sweepGenerationJobs(now.toISOString(), new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
        if (result.timedOut > 0 || result.deleted > 0) {
            console.info(`[MK generation jobs] 超时 ${result.timedOut} 个，清理 ${result.deleted} 个终态任务`);
        }
    };
    sweepGenerationJobs();
    const isPastDeadline = (job) => Date.now() >= Date.parse(job.deadlineAt);
    const executionTimeoutFor = (job) => {
        const policy = normalizeGenerationTimeoutPolicy(job.request.timeoutPolicy);
        return job.kind === 'text'
            ? policy.textExecutionMs
            : job.kind === 'image' || job.kind === 'audio'
                ? policy.imageExecutionMs
                : policy.videoSubmitMs;
    };
    const taskWaitTimeoutFor = (payload) => {
        const policy = normalizeGenerationTimeoutPolicy(payload.timeoutPolicy);
        return payload.kind === 'text'
            ? policy.textExecutionMs
            : payload.kind === 'image' || payload.kind === 'audio'
                ? policy.imageTaskWaitMs
                : policy.videoTaskWaitMs;
    };
    const generationRetryReason = (job) => {
        if (job.kind !== 'video')
            return undefined;
        if (job.result?.retryReason === 'remote-media-timeout' && job.upstreamTaskId)
            return 'remote-media-timeout';
        if (job.status === 'failed' && job.upstreamTaskId && /\u8fdc程媒体读取超时/.test(job.errorMessage ?? '')) {
            return 'remote-media-timeout';
        }
        if (job.status === 'timeout' && job.upstreamTaskId)
            return 'generation-timeout';
        return undefined;
    };
    const toInternalTaskResult = (job) => {
        if (job.status === 'completed' && job.result)
            return { ...job.result, taskId: job.id, status: 'completed' };
        if (job.status === 'failed' || job.status === 'timeout') {
            const retryReason = generationRetryReason(job);
            return {
                ok: true,
                taskId: job.id,
                status: job.status,
                message: job.errorMessage || (job.status === 'timeout' ? '生成任务超时' : '生成失败'),
                ...(retryReason ? { retryable: true, retryReason } : {})
            };
        }
        return {
            ok: true,
            taskId: job.id,
            status: job.status === 'queued' || job.status === 'retry_pending' ? 'queued' : 'processing',
            message: job.status === 'retry_pending'
                ? '服务已重启，任务等待恢复执行'
                : job.status === 'provider_pending'
                    ? '上游任务生成中'
                    : job.status === 'running'
                        ? '生成任务执行中'
                        : '生成任务已入队'
        };
    };
    const markTimedOut = (job) => generationJobStore.updateGenerationJob(job.id, {
        status: 'timeout',
        errorMessage: '生成任务已超过设置的总等待时间',
        ...(job.kind === 'video' && job.upstreamTaskId ? {
            result: {
                ...(job.result ?? { ok: true, status: 'timeout', taskId: job.id }),
                retryable: true,
                retryReason: 'generation-timeout'
            }
        } : {}),
        updatedAt: new Date().toISOString()
    });
    const runGenerationJob = async (jobId, suppliedApiKey, signal) => {
        const job = generationJobStore.getGenerationJob(jobId);
        if (!job || !['queued', 'retry_pending'].includes(job.status))
            return;
        if (isPastDeadline(job)) {
            markTimedOut(job);
            return;
        }
        const request = job.request;
        const startedAt = new Date().toISOString();
        const effectiveTimeoutPolicy = normalizeGenerationTimeoutPolicy(request.timeoutPolicy);
        const executionTimeoutMs = executionTimeoutFor(job);
        const rawImageRefs = asUniqueList(request.referenceImages ?? []);
        const rawVideoRefs = asUniqueList(request.referenceVideos ?? []);
        const rawAudioRefs = asUniqueList(request.referenceAudios ?? []);
        generationJobStore.updateGenerationJob(job.id, {
            status: 'running',
            attempts: job.attempts + 1,
            startedAt,
            updatedAt: startedAt
        });
        const generationLogContext = {
            route: '/api/generate/background',
            taskId: job.id,
            kind: job.kind,
            providerId: job.providerId,
            providerName: job.providerName,
            providerProfile: normalizeProviderProfile(job.providerProfile),
            baseUrl: safeBaseUrl(job.baseUrl),
            model: request.model,
            attempt: job.attempts + 1,
            executionTimeoutMs,
            taskWaitTimeoutMs: taskWaitTimeoutFor(request),
            statusRequestMs: effectiveTimeoutPolicy.statusRequestMs,
            referenceCount: rawImageRefs.length + rawVideoRefs.length + rawAudioRefs.length
        };
        try {
            const { provider, effectiveBaseUrl, effectiveApiKey } = resolveProviderRequestConfig({
                providerId: job.providerId,
                suppliedBaseUrl: job.baseUrl,
                suppliedApiKey,
                outboundPolicy: { trustedOrigins: request.outboundAllowedOrigins, allowedPorts: request.outboundAllowedPorts }
            });
            const cleanPrompt = request.prompt.trim();
            const cleanModel = request.model || (job.kind === 'text'
                ? 'gpt-4o-mini'
                : job.kind === 'image'
                    ? 'gpt-image-1'
                    : job.kind === 'audio'
                        ? 'gpt-4o-mini-tts'
                        : 'sora-2');
            const normalizedModelRequestProfile = normalizeProviderRequestProfile(request.modelRequestProfile);
            const normalizedQuality = job.kind === 'image' ? normalizeImageQuality(request.quality) : undefined;
            const ratio = request.aspectRatio || '16:9';
            const imageRefs = rawImageRefs.map((url) => toPublicReferenceUrl(request.origin, url)).filter((url) => Boolean(url));
            const videoRefs = rawVideoRefs.map((url) => toPublicReferenceUrl(request.origin, url)).filter((url) => Boolean(url));
            const audioRefs = rawAudioRefs.map((url) => toPublicReferenceUrl(request.origin, url)).filter((url) => Boolean(url));
            const providerOutboundPolicy = createProviderOutboundPolicy(provider, effectiveBaseUrl, { trustedOrigins: request.outboundAllowedOrigins, allowedPorts: request.outboundAllowedPorts });
            const referenceOutboundPolicy = (value) => resolveTrustedAssetPolicy?.(value) ?? providerOutboundPolicy;
            const adapterContext = {
                kind: job.kind,
                providerId: job.providerId,
                providerProtocol: request.providerProtocol,
                providerName: job.providerName,
                providerProfile: normalizeProviderProfile(job.providerProfile),
                providerImageTransport: request.providerImageTransport,
                generationEndpoints: request.generationEndpoints,
                mediaContracts: request.mediaContracts,
                providerAuthMode: normalizeProviderAuthMode(job.request.providerAuthMode),
                providerTextProtocol: normalizeProviderOption(job.request.providerTextProtocol, providerTextProtocols, 'chat-completions'),
                providerReferenceInputMode: normalizeProviderOption(job.request.providerReferenceInputMode, providerReferenceInputModeValues, 'data-url'),
                providerReferenceInputModes: normalizeProviderReferenceInputModes(job.request.providerReferenceInputModes),
                providerFileUploadPath: normalizeProviderFileUploadPath(job.request.providerFileUploadPath),
                providerFileUploadPaths: normalizeProviderFileUploadPaths(job.request.providerFileUploadPaths),
                providerFileUploadMediaKinds: Array.isArray(job.request.providerFileUploadMediaKinds)
                    ? job.request.providerFileUploadMediaKinds.filter((item) => providerFileUploadMediaKindValues.has(item))
                    : undefined,
                providerFileUploadPurpose: normalizeProviderOption(job.request.providerFileUploadPurpose, providerFileUploadPurposes, 'vision'),
                provider,
                effectiveBaseUrl,
                effectiveApiKey,
                cleanPrompt,
                cleanModel,
                modelRequestProfile: normalizedModelRequestProfile,
                modelImageTransport: request.modelImageTransport,
                imagePresetId: request.imagePresetId,
                imageRequestEncoding: request.imageRequestEncoding,
                videoRequestEncoding: request.videoRequestEncoding,
                ratio,
                customWidth: request.customWidth,
                customHeight: request.customHeight,
                floatValues: request.floatValues,
                seed: request.seed,
                resolution: request.resolution,
                quality: normalizedQuality,
                duration: request.duration,
                batchSize: request.batchSize,
                audioMode: request.audioMode,
                voice: request.voice,
                volume: request.volume,
                pitch: request.pitch,
                speed: request.speed,
                modelCapabilities: request.modelCapabilities,
                videoReferenceMode: request.videoReferenceMode,
                accountId: request.accountId,
                executionTimeoutMs,
                idempotencyKey: job.id,
                signal,
                projectId: request.projectId,
                canvasId: request.canvasId,
                persistGeneratedMedia,
                workflow: runtimeWorkflows.get(job.id),
                references: {
                    rawImageRefs,
                    rawVideoRefs,
                    rawAudioRefs,
                    imageRefs,
                    videoRefs,
                    audioRefs,
                    toReferenceBlob: (value) => referenceToBlob(request.origin, value, referenceDirs, referenceOutboundPolicy(value)),
                    toImageDataUrl: (value) => toImageDataUrl(request.origin, value, referenceDirs, referenceOutboundPolicy(value)),
                    toMediaDataUrl: (value) => toMediaDataUrl(request.origin, value, referenceDirs, referenceOutboundPolicy(value)),
                    toXyqReferenceImageInput: (value, targetBaseUrl, headers) => (toXyqReferenceImageInput(request.origin, value, targetBaseUrl, headers, referenceDirs)),
                    toXyqReferenceAudioInput: (value, targetBaseUrl, headers) => (toXyqReferenceAudioInput(request.origin, value, targetBaseUrl, headers, referenceDirs))
                }
            };
            const adapter = getGenerationAdapter(adapterContext);
            let result = await adapter.submit(adapterContext);
            const currentAfterSubmit = generationJobStore.getGenerationJob(job.id);
            if (!currentAfterSubmit || currentAfterSubmit.status !== 'running' || signal.aborted)
                return;
            registerTrustedGenerationAssets(result, provider, effectiveBaseUrl, registerTrustedAssetUrls);
            try {
                result = await materializeCompletedGenerationAssets({
                    result,
                    kind: job.kind,
                    projectId: request.projectId,
                    canvasId: request.canvasId,
                    taskId: job.id,
                    fallbackOutboundPolicy: providerOutboundPolicy,
                    resolveTrustedAssetPolicy,
                    persistGeneratedMedia,
                });
            }
            catch (error) {
                if (job.kind === 'video' && result.taskId && error instanceof RemoteMediaError && error.code === 'remote_media_timeout') {
                    const updatedAt = new Date().toISOString();
                    generationJobStore.updateGenerationJob(job.id, {
                        status: 'failed',
                        ...(result.taskId ? { upstreamTaskId: result.taskId } : {}),
                        result: {
                            ...result,
                            taskId: job.id,
                            status: 'failed',
                            retryable: true,
                            retryReason: 'remote-media-timeout'
                        },
                        errorMessage: error.message,
                        updatedAt
                    });
                    return;
                }
                throw error;
            }
            const currentBeforePublish = generationJobStore.getGenerationJob(job.id);
            if (!currentBeforePublish || currentBeforePublish.status !== 'running' || signal.aborted)
                return;
            logGenerationResultFailure('submit', generationLogContext, result);
            const updatedAt = new Date().toISOString();
            if ((result.status === 'queued' || result.status === 'processing') && result.taskId) {
                generationJobStore.updateGenerationJob(job.id, {
                    status: 'provider_pending',
                    upstreamTaskId: result.taskId,
                    result: { ...result, taskId: job.id },
                    updatedAt
                });
            }
            else if (result.status === 'failed' || result.status === 'timeout') {
                generationJobStore.updateGenerationJob(job.id, {
                    status: result.status,
                    errorMessage: result.message,
                    result: { ...result, taskId: job.id },
                    updatedAt
                });
            }
            else {
                generationJobStore.updateGenerationJob(job.id, {
                    status: 'completed',
                    result: { ...result, taskId: job.id, status: 'completed' },
                    updatedAt
                });
            }
        }
        catch (error) {
            if (signal.aborted)
                return;
            logGenerationFailure('submit', generationLogContext, error);
            const current = generationJobStore.getGenerationJob(job.id);
            if (!current || current.status !== 'running')
                return;
            generationJobStore.updateGenerationJob(job.id, {
                status: isPastDeadline(current) ? 'timeout' : 'failed',
                errorMessage: getErrorMessage(error, '生成失败'),
                updatedAt: new Date().toISOString()
            });
        }
        finally {
            runtimeWorkflows.delete(job.id);
        }
    };
    const executeGenerationJob = (jobId, suppliedApiKey) => {
        const existing = executionPromises.get(jobId);
        if (existing)
            return existing;
        const controller = new AbortController();
        executionControllers.set(jobId, controller);
        const execution = runGenerationJob(jobId, suppliedApiKey, controller.signal).finally(() => {
            executionPromises.delete(jobId);
            if (executionControllers.get(jobId) === controller)
                executionControllers.delete(jobId);
        });
        executionPromises.set(jobId, execution);
        return execution;
    };
    const queryProviderJob = async (job, suppliedApiKey, signal) => {
        if (!job.upstreamTaskId)
            throw new Error('持久化任务缺少上游 taskId');
        if (isPastDeadline(job))
            return markTimedOut(job);
        const { provider, effectiveBaseUrl, effectiveApiKey } = resolveProviderRequestConfig({
            providerId: job.providerId,
            suppliedBaseUrl: job.baseUrl,
            suppliedApiKey,
            outboundPolicy: { trustedOrigins: job.request.outboundAllowedOrigins, allowedPorts: job.request.outboundAllowedPorts }
        });
        const requestTimeoutMs = normalizeGenerationTimeoutPolicy(job.request.timeoutPolicy).statusRequestMs;
        const adapterContext = {
            kind: job.kind,
            providerId: job.providerId,
            providerProtocol: job.request.providerProtocol,
            providerProfile: normalizeProviderProfile(job.providerProfile),
            providerAuthMode: normalizeProviderAuthMode(job.request.providerAuthMode),
            generationEndpoints: normalizeProviderGenerationEndpoints(job.request.generationEndpoints),
            mediaContracts: normalizeProviderMediaGenerationContracts(job.request.mediaContracts),
            provider,
            effectiveBaseUrl,
            effectiveApiKey,
            taskId: job.upstreamTaskId,
            requestTimeoutMs,
            signal,
            persistGeneratedMedia,
            projectId: job.request.projectId,
            canvasId: job.request.canvasId
        };
        let result = await getGenerationAdapter(adapterContext).queryStatus(adapterContext);
        const current = generationJobStore.getGenerationJob(job.id);
        if (!current ||
            current.status !== 'provider_pending' ||
            current.upstreamTaskId !== job.upstreamTaskId)
            return current;
        registerTrustedGenerationAssets(result, provider, effectiveBaseUrl, registerTrustedAssetUrls);
        try {
            result = await materializeCompletedGenerationAssets({
                result,
                kind: job.kind,
                projectId: job.request.projectId,
                canvasId: job.request.canvasId,
                taskId: job.id,
                fallbackOutboundPolicy: createProviderOutboundPolicy(provider, effectiveBaseUrl, {
                    trustedOrigins: job.request.outboundAllowedOrigins,
                    allowedPorts: job.request.outboundAllowedPorts,
                }),
                resolveTrustedAssetPolicy,
                persistGeneratedMedia,
            });
        }
        catch (error) {
            logGenerationFailure('status', {
                route: '/api/generate/status',
                taskId: job.id,
                kind: job.kind,
                providerId: job.providerId,
            }, error);
            const currentAfterMaterializationFailure = generationJobStore.getGenerationJob(job.id);
            if (!currentAfterMaterializationFailure
                || currentAfterMaterializationFailure.status !== 'provider_pending'
                || currentAfterMaterializationFailure.upstreamTaskId !== job.upstreamTaskId)
                return currentAfterMaterializationFailure;
            const remoteMediaTimeout = job.kind === 'video'
                && error instanceof RemoteMediaError
                && error.code === 'remote_media_timeout';
            return generationJobStore.updateGenerationJob(job.id, {
                status: 'failed',
                ...(remoteMediaTimeout ? {
                    result: {
                        ...(result ?? { ok: true, status: 'failed', taskId: job.id, previewUrls: [] }),
                        taskId: job.id,
                        status: 'failed',
                        retryable: true,
                        retryReason: 'remote-media-timeout'
                    }
                } : {}),
                errorMessage: getErrorMessage(error, '生成结果归档失败'),
                updatedAt: new Date().toISOString()
            });
        }
        const currentBeforePublish = generationJobStore.getGenerationJob(job.id);
        if (!currentBeforePublish
            || currentBeforePublish.status !== 'provider_pending'
            || currentBeforePublish.upstreamTaskId !== job.upstreamTaskId)
            return currentBeforePublish;
        const updatedAt = new Date().toISOString();
        if (result.status === 'completed') {
            return generationJobStore.updateGenerationJob(job.id, {
                status: 'completed',
                result: { ...result, taskId: job.id },
                updatedAt
            });
        }
        if (result.status === 'failed' || result.status === 'timeout') {
            return generationJobStore.updateGenerationJob(job.id, {
                status: result.status,
                result: { ...result, taskId: job.id },
                errorMessage: result.message,
                updatedAt
            });
        }
        return generationJobStore.updateGenerationJob(job.id, {
            status: 'provider_pending',
            result: { ...result, taskId: job.id },
            updatedAt
        });
    };
    const queryProviderJobOnce = (job, suppliedApiKey) => {
        const existing = providerQueryPromises.get(job.id);
        if (existing)
            return existing;
        const controller = new AbortController();
        providerQueryControllers.set(job.id, controller);
        const query = queryProviderJob(job, suppliedApiKey, controller.signal).finally(() => {
            if (providerQueryPromises.get(job.id) === query)
                providerQueryPromises.delete(job.id);
            if (providerQueryControllers.get(job.id) === controller)
                providerQueryControllers.delete(job.id);
        });
        providerQueryPromises.set(job.id, query);
        return query;
    };
    router.post('/generate', (req, res) => {
        const body = req.body;
        const { kind, providerId, providerName, providerProtocol, providerProfile, providerImageTransport, providerAuthMode, baseUrl, apiKey, prompt, model } = body;
        if (kind !== 'text' && kind !== 'image' && kind !== 'video' && kind !== 'audio') {
            res.status(400).json({ ok: false, message: 'kind 必须是 text、image、video 或 audio' });
            return;
        }
        const normalizedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
        const normalizedImagePresetId = normalizeImageGenerationPresetId(body.imagePresetId);
        const normalizedImageRequestEncoding = normalizeImageRequestEncoding(body.imageRequestEncoding);
        const normalizedVideoRequestEncoding = body.videoRequestEncoding === undefined ? undefined : normalizeVideoRequestEncoding(body.videoRequestEncoding);
        const normalizedProviderImageTransport = normalizeProviderImageTransportProfile(providerImageTransport);
        const normalizedGenerationEndpoints = normalizeProviderGenerationEndpoints(body.generationEndpoints);
        const normalizedMediaContracts = normalizeProviderMediaGenerationContracts(body.mediaContracts);
        const normalizedModelImageTransport = normalizeProviderImageTransportProfile(body.modelImageTransport)
            ?? imageTransportFromLegacyRequestProfile(body.modelRequestProfile);
        if (kind === 'image' && body.imagePresetId !== undefined && !normalizedImagePresetId) {
            res.status(400).json({ ok: false, message: '图片参数预设无效' });
            return;
        }
        if (kind === 'image' && body.imageRequestEncoding !== undefined && !normalizedImageRequestEncoding) {
            res.status(400).json({ ok: false, message: '图片请求字段映射无效' });
            return;
        }
        if (providerImageTransport !== undefined && !normalizedProviderImageTransport) {
            res.status(400).json({ ok: false, message: '图片传输合同无效' });
            return;
        }
        if (body.modelImageTransport !== undefined && !normalizedModelImageTransport) {
            res.status(400).json({ ok: false, message: '模型图片传输合同无效' });
            return;
        }
        if (body.generationEndpoints !== undefined && !normalizedGenerationEndpoints) {
            res.status(400).json({ ok: false, message: '生成端点配置无效；异步模式必须填写包含 {task_id} 的查询地址' });
            return;
        }
        if (body.mediaContracts !== undefined && !normalizedMediaContracts) {
            res.status(400).json({ ok: false, message: '媒体生成合同无效' });
            return;
        }
        const isWorkflowRequest = ((providerProtocol === 'comfyui' || providerProtocol === 'runninghub')
            && body.workflow?.protocol === providerProtocol
            && body.workflow.output?.kind === kind
            && Array.isArray(body.workflow.inputs));
        const workflowRequiresPrompt = isWorkflowRequest
            && body.workflow.inputs.some((binding) => binding?.source === 'prompt' && binding.required === true);
        if ((!isWorkflowRequest || workflowRequiresPrompt) && !normalizedPrompt) {
            res.status(400).json({ ok: false, message: '请输入提示词' });
            return;
        }
        if (!providerId) {
            res.status(400).json({ ok: false, message: '缺少 providerId' });
            return;
        }
        const providerConfig = resolveGenerationProviderConfig(res, providerId, baseUrl, apiKey, { trustedOrigins: body.outboundAllowedOrigins, allowedPorts: body.outboundAllowedPorts });
        if (!providerConfig)
            return;
        const { provider, effectiveBaseUrl } = providerConfig;
        if (!effectiveBaseUrl) {
            res.status(400).json({ ok: false, message: '缺少 provider BaseURL' });
            return;
        }
        const capabilities = providerProtocol && providerProtocol !== 'openai-compatible'
            ? getProviderCapabilities(providerProtocol)
            : getProviderCapabilitiesForContext({ providerId, providerName, provider, baseUrl: effectiveBaseUrl });
        if (!providerSupportsGenerationKind(capabilities, kind)) {
            res.status(400).json({ ok: false, message: `当前提供商协议 ${capabilities.protocol} 不支持该生成类型` });
            return;
        }
        const timeoutPolicy = normalizeGenerationTimeoutPolicy(body.timeoutPolicy);
        const volume = normalizeFiniteNumber(body.volume);
        const pitch = normalizeFiniteNumber(body.pitch);
        const speed = normalizeFiniteNumber(body.speed);
        const providerTextProtocol = normalizeProviderOption(body.providerTextProtocol, providerTextProtocols, 'chat-completions');
        const providerReferenceInputMode = normalizeProviderOption(body.providerReferenceInputMode, providerReferenceInputModeValues, 'data-url');
        const providerReferenceInputModes = normalizeProviderReferenceInputModes(body.providerReferenceInputModes);
        const providerFileUploadPath = normalizeProviderFileUploadPath(body.providerFileUploadPath);
        const providerFileUploadPaths = normalizeProviderFileUploadPaths(body.providerFileUploadPaths);
        const providerFileUploadMediaKinds = Array.isArray(body.providerFileUploadMediaKinds)
            ? Array.from(new Set(body.providerFileUploadMediaKinds.filter((item) => (typeof item === 'string' && providerFileUploadMediaKindValues.has(item)))))
            : undefined;
        const requestedReferenceModes = providerReferenceInputModes ?? [providerReferenceInputMode];
        if (kind === 'text'
            && providerTextProtocol !== 'responses'
            && requestedReferenceModes.includes('file-upload')
            && !requestedReferenceModes.some((mode) => mode === 'data-url' || mode === 'public-url')) {
            res.status(400).json({ ok: false, message: 'Files API 参考输入仅支持 Responses API' });
            return;
        }
        if (requestedReferenceModes.includes('file-upload') && !providerFileUploadPath && !providerFileUploadPaths) {
            res.status(400).json({ ok: false, message: 'Files API 参考输入缺少有效的相对上传接口' });
            return;
        }
        if (requestedReferenceModes.includes('file-upload')
            && providerFileUploadMediaKinds?.some((mediaKind) => !providerFileUploadPaths?.[mediaKind] && !providerFileUploadPath)) {
            res.status(400).json({ ok: false, message: 'Files API 参考输入缺少有效的相对上传接口' });
            return;
        }
        const normalizedPayload = {
            kind,
            providerId,
            providerName: providerName || provider?.name || providerId,
            ...(providerProtocol ? { providerProtocol } : {}),
            ...(providerProfile ? { providerProfile: normalizeProviderProfile(providerProfile) } : {}),
            ...(normalizedProviderImageTransport ? { providerImageTransport: normalizedProviderImageTransport } : {}),
            ...(normalizedGenerationEndpoints ? { generationEndpoints: normalizedGenerationEndpoints } : {}),
            ...(normalizedMediaContracts ? { mediaContracts: normalizedMediaContracts } : {}),
            ...(providerAuthMode ? { providerAuthMode: normalizeProviderAuthMode(providerAuthMode) } : {}),
            providerTextProtocol,
            providerReferenceInputMode,
            ...(providerReferenceInputModes?.length ? { providerReferenceInputModes } : {}),
            ...(providerFileUploadPath ? { providerFileUploadPath } : {}),
            ...(providerFileUploadPaths ? { providerFileUploadPaths } : {}),
            ...(providerFileUploadMediaKinds?.length ? { providerFileUploadMediaKinds } : {}),
            providerFileUploadPurpose: normalizeProviderOption(body.providerFileUploadPurpose, providerFileUploadPurposes, 'vision'),
            baseUrl: effectiveBaseUrl,
            prompt: normalizedPrompt,
            model: model || (kind === 'text' ? 'gpt-4o-mini' : kind === 'image' ? 'gpt-image-1' : kind === 'audio' ? 'gpt-4o-mini-tts' : 'sora-2'),
            ...(body.modelRequestProfile ? { modelRequestProfile: body.modelRequestProfile } : {}),
            ...(normalizedModelImageTransport ? { modelImageTransport: normalizedModelImageTransport } : {}),
            ...(normalizedImagePresetId ? { imagePresetId: normalizedImagePresetId } : {}),
            ...(normalizedImageRequestEncoding ? { imageRequestEncoding: normalizedImageRequestEncoding } : {}),
            ...(normalizedVideoRequestEncoding ? { videoRequestEncoding: normalizedVideoRequestEncoding } : {}),
            ...(body.aspectRatio ? { aspectRatio: body.aspectRatio } : {}),
            ...(body.resolution ? { resolution: body.resolution } : {}),
            ...(typeof body.customWidth === 'number' && Number.isFinite(body.customWidth) ? { customWidth: Math.round(body.customWidth) } : {}),
            ...(typeof body.customHeight === 'number' && Number.isFinite(body.customHeight) ? { customHeight: Math.round(body.customHeight) } : {}),
            ...(Array.isArray(body.floatValues) ? { floatValues: body.floatValues } : {}),
            ...(typeof body.seed === 'number' && Number.isFinite(body.seed) ? { seed: Math.round(body.seed) } : {}),
            ...(body.quality ? { quality: body.quality } : {}),
            ...(body.duration !== undefined ? { duration: body.duration } : {}),
            ...(body.batchSize !== undefined ? { batchSize: body.batchSize } : {}),
            ...(body.audioMode ? { audioMode: body.audioMode } : {}),
            ...(body.voice ? { voice: body.voice.trim() } : {}),
            ...(volume !== undefined ? { volume } : {}),
            ...(pitch !== undefined ? { pitch } : {}),
            ...(speed !== undefined ? { speed } : {}),
            ...(body.modelCapabilities ? {
                modelCapabilities: normalizeProviderModelCapabilityOverrides(body.modelCapabilities)
            } : {}),
            ...(body.accountId ? { accountId: body.accountId } : {}),
            ...(body.videoReferenceMode ? { videoReferenceMode: body.videoReferenceMode } : {}),
            referenceImages: asUniqueList(body.referenceImages ?? []),
            referenceVideos: asUniqueList(body.referenceVideos ?? []),
            referenceAudios: asUniqueList(body.referenceAudios ?? []),
            timeoutPolicy,
            ...(body.projectId ? { projectId: body.projectId } : {}),
            ...(body.canvasId ? { canvasId: body.canvasId } : {}),
            ...(body.workflow ? { workflow: body.workflow } : {}),
            ...(body.outboundAllowedOrigins?.length ? { outboundAllowedOrigins: body.outboundAllowedOrigins } : {}),
            ...(body.outboundAllowedPorts?.length ? { outboundAllowedPorts: body.outboundAllowedPorts } : {})
        };
        const now = new Date();
        const requestedTaskId = body.clientTaskId?.trim();
        if (requestedTaskId && !validClientTaskId(requestedTaskId)) {
            res.status(400).json({ ok: false, message: 'clientTaskId 格式无效' });
            return;
        }
        const jobId = requestedTaskId || randomUUID();
        const { apiKey: _ignoredApiKey, clientTaskId: _ignoredClientTaskId, workflow: runtimeWorkflow, ...persistedPayload } = normalizedPayload;
        const existingJob = generationJobStore.getGenerationJob(jobId);
        if (existingJob) {
            if (runtimeWorkflow)
                runtimeWorkflows.set(jobId, runtimeWorkflow);
            const { origin: _ignoredOrigin, ...existingPayload } = existingJob.request;
            if (existingJob.kind !== kind
                || existingJob.providerId !== providerId
                || safeBaseUrl(existingJob.baseUrl) !== safeBaseUrl(effectiveBaseUrl)
                || JSON.stringify(existingPayload) !== JSON.stringify(persistedPayload)) {
                res.status(409).json({ ok: false, message: 'clientTaskId 已被其他生成请求使用' });
                return;
            }
            res.status(202).json(toInternalTaskResult(existingJob));
            return;
        }
        const job = {
            id: jobId,
            kind,
            providerId,
            providerName: normalizedPayload.providerName,
            ...(normalizedPayload.providerProfile ? { providerProfile: normalizedPayload.providerProfile } : {}),
            baseUrl: effectiveBaseUrl,
            request: { ...persistedPayload, origin: getRequestOrigin(req) },
            status: 'queued',
            attempts: 0,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            deadlineAt: new Date(now.getTime() + taskWaitTimeoutFor(normalizedPayload)).toISOString()
        };
        if (runtimeWorkflow)
            runtimeWorkflows.set(jobId, runtimeWorkflow);
        generationJobStore.createGenerationJob(job);
        setImmediate(() => { void executeGenerationJob(jobId, apiKey); });
        res.status(202).json({ ok: true, status: 'queued', taskId: jobId, message: '生成任务已入队' });
    });
    router.post('/generate/status', async (req, res) => {
        const { kind, providerId, providerProtocol, providerProfile, providerAuthMode, generationEndpoints, mediaContracts, baseUrl, apiKey, taskId, workflow, retry } = req.body;
        if (!taskId) {
            res.status(400).json({ ok: false, message: '缺少 taskId' });
            return;
        }
        const normalizedGenerationEndpoints = normalizeProviderGenerationEndpoints(generationEndpoints);
        if (generationEndpoints !== undefined && !normalizedGenerationEndpoints) {
            res.status(400).json({ ok: false, message: '生成端点配置无效；异步查询接口必须包含 {task_id} 的查询地址' });
            return;
        }
        const job = generationJobStore.getGenerationJob(taskId);
        if (job) {
            if (providerId !== job.providerId || safeBaseUrl(baseUrl) !== safeBaseUrl(job.baseUrl) || (kind && kind !== job.kind)) {
                res.status(409).json({ ok: false, message: '任务身份与当前提供商配置不匹配' });
                return;
            }
            if (workflow
                && workflow.protocol === job.request.providerProtocol
                && workflow.output.kind === job.kind
                && (job.status === 'queued' || job.status === 'retry_pending' || job.status === 'running')) {
                runtimeWorkflows.set(job.id, workflow);
            }
            try {
                let current = job;
                if (retry === true) {
                    const retryReason = generationRetryReason(current) ?? (current.kind === 'video' && current.status === 'provider_pending' && current.upstreamTaskId
                        ? 'generation-timeout'
                        : undefined);
                    if (!retryReason || !current.upstreamTaskId) {
                        res.status(409).json({ ok: false, message: '当前视频任务不支持重新轮询' });
                        return;
                    }
                    const retriedAt = new Date();
                    const retryResult = current.result
                        ? (({ retryable: _retryable, retryReason: _retryReason, ...result }) => result)(current.result)
                        : undefined;
                    current = generationJobStore.updateGenerationJob(current.id, {
                        status: 'provider_pending',
                        errorMessage: '',
                        ...(retryResult ? { result: retryResult } : {}),
                        updatedAt: retriedAt.toISOString(),
                        deadlineAt: new Date(retriedAt.getTime() + taskWaitTimeoutFor(current.request)).toISOString()
                    }) ?? current;
                }
                if (current.status === 'queued' || current.status === 'retry_pending') {
                    void executeGenerationJob(current.id, apiKey);
                }
                else if (current.status === 'provider_pending') {
                    current = await queryProviderJobOnce(current, apiKey) ?? current;
                }
                res.json(toInternalTaskResult(generationJobStore.getGenerationJob(current.id) ?? current));
            }
            catch (error) {
                logGenerationFailure('status', { route: '/api/generate/status', taskId, providerId, kind }, error);
                res.status(502).json({ ok: false, message: `查询任务失败: ${getErrorMessage(error)}` });
            }
            return;
        }
        if ((kind !== 'image' && kind !== 'video' && kind !== 'audio') || !providerId) {
            res.status(404).json({ ok: false, message: '生成任务不存在' });
            return;
        }
        const providerConfig = resolveGenerationProviderConfig(res, providerId, baseUrl, apiKey, { trustedOrigins: req.body?.outboundAllowedOrigins, allowedPorts: req.body?.outboundAllowedPorts });
        if (!providerConfig)
            return;
        const { provider, effectiveBaseUrl, effectiveApiKey } = providerConfig;
        try {
            const adapterContext = {
                kind,
                providerId,
                providerProtocol,
                providerProfile: normalizeProviderProfile(providerProfile),
                providerAuthMode: normalizeProviderAuthMode(providerAuthMode),
                generationEndpoints: normalizedGenerationEndpoints,
                mediaContracts: normalizeProviderMediaGenerationContracts(mediaContracts),
                provider,
                effectiveBaseUrl,
                effectiveApiKey,
                taskId,
                requestTimeoutMs: 30000
            };
            const result = await getGenerationAdapter(adapterContext).queryStatus(adapterContext);
            registerTrustedGenerationAssets(result, provider, effectiveBaseUrl, registerTrustedAssetUrls);
            res.json(result);
        }
        catch (error) {
            res.status(500).json({ ok: false, message: `查询任务失败: ${getErrorMessage(error)}` });
        }
    });
    router.post('/generate/cancel', async (req, res) => {
        const { kind, providerId, providerProtocol, providerProfile, providerAuthMode, generationEndpoints, mediaContracts, baseUrl, apiKey, taskId } = req.body;
        if (!taskId || (kind !== undefined && kind !== 'text' && kind !== 'image' && kind !== 'video' && kind !== 'audio')) {
            res.status(400).json({ ok: false, message: 'taskId 必填，kind 必须是 text、image、video 或 audio' });
            return;
        }
        const normalizedGenerationEndpoints = normalizeProviderGenerationEndpoints(generationEndpoints);
        if (generationEndpoints !== undefined && !normalizedGenerationEndpoints) {
            res.status(400).json({ ok: false, message: '生成端点配置无效；异步查询接口必须包含 {task_id} 的查询地址' });
            return;
        }
        const internalJob = generationJobStore.getGenerationJob(taskId);
        if (internalJob) {
            if (providerId !== internalJob.providerId || safeBaseUrl(baseUrl) !== safeBaseUrl(internalJob.baseUrl)) {
                res.status(409).json({ ok: false, message: '任务身份与当前提供商配置不匹配' });
                return;
            }
            if (internalJob.status === 'queued' || internalJob.status === 'retry_pending' || internalJob.status === 'running') {
                executionControllers.get(taskId)?.abort(new DOMException('Generation cancelled', 'AbortError'));
                generationJobStore.updateGenerationJob(taskId, {
                    status: 'failed',
                    errorMessage: '任务已取消',
                    updatedAt: new Date().toISOString()
                });
                res.json({ ok: true, taskId, status: 'cancelled', message: '任务已取消' });
                return;
            }
            if (internalJob.status === 'provider_pending' && internalJob.upstreamTaskId) {
                try {
                    const { provider, effectiveBaseUrl, effectiveApiKey } = resolveProviderRequestConfig({
                        providerId: internalJob.providerId,
                        suppliedBaseUrl: internalJob.baseUrl,
                        suppliedApiKey: apiKey,
                        outboundPolicy: { trustedOrigins: internalJob.request.outboundAllowedOrigins, allowedPorts: internalJob.request.outboundAllowedPorts }
                    });
                    const requestTimeoutMs = normalizeGenerationTimeoutPolicy(internalJob.request.timeoutPolicy).statusRequestMs;
                    const adapterContext = {
                        kind: internalJob.kind,
                        providerId: internalJob.providerId,
                        providerProtocol: internalJob.request.providerProtocol,
                        providerProfile: normalizeProviderProfile(internalJob.providerProfile),
                        providerAuthMode: normalizeProviderAuthMode(internalJob.request.providerAuthMode),
                        generationEndpoints: normalizeProviderGenerationEndpoints(internalJob.request.generationEndpoints),
                        mediaContracts: normalizeProviderMediaGenerationContracts(internalJob.request.mediaContracts),
                        provider,
                        effectiveBaseUrl,
                        effectiveApiKey,
                        taskId: internalJob.upstreamTaskId,
                        requestTimeoutMs
                    };
                    const adapter = getGenerationAdapter(adapterContext);
                    if (!adapter.cancel) {
                        res.status(409).json({ ok: false, message: `当前提供商协议 ${adapter.protocol} 不支持取消任务` });
                        return;
                    }
                    const result = await adapter.cancel(adapterContext);
                    providerQueryControllers.get(taskId)?.abort(new DOMException('Generation cancelled', 'AbortError'));
                    const current = generationJobStore.getGenerationJob(taskId);
                    if (!current ||
                        current.status !== 'provider_pending' ||
                        current.upstreamTaskId !== internalJob.upstreamTaskId) {
                        if (current)
                            res.json(toInternalTaskResult(current));
                        else
                            res.status(404).json({ ok: false, message: '生成任务不存在' });
                        return;
                    }
                    generationJobStore.updateGenerationJob(taskId, {
                        status: 'failed',
                        errorMessage: result.message,
                        updatedAt: new Date().toISOString()
                    });
                    res.json({ ...result, taskId });
                    return;
                }
                catch (error) {
                    res.status(500).json({ ok: false, message: `取消任务失败: ${getErrorMessage(error)}` });
                    return;
                }
            }
            res.status(409).json({ ok: false, message: '当前任务阶段不支持取消' });
            return;
        }
        if (kind !== 'image' && kind !== 'video' && kind !== 'audio') {
            res.status(404).json({ ok: false, message: '生成任务不存在' });
            return;
        }
        const providerConfig = resolveGenerationProviderConfig(res, providerId, baseUrl, apiKey, { trustedOrigins: req.body?.outboundAllowedOrigins, allowedPorts: req.body?.outboundAllowedPorts });
        if (!providerConfig)
            return;
        const { provider, effectiveBaseUrl, effectiveApiKey } = providerConfig;
        try {
            const adapterContext = {
                kind,
                providerId,
                providerProtocol,
                providerProfile: normalizeProviderProfile(providerProfile),
                providerAuthMode: normalizeProviderAuthMode(providerAuthMode),
                generationEndpoints: normalizedGenerationEndpoints,
                mediaContracts: normalizeProviderMediaGenerationContracts(mediaContracts),
                provider,
                effectiveBaseUrl,
                effectiveApiKey,
                taskId,
                requestTimeoutMs: 30000
            };
            const adapter = getGenerationAdapter(adapterContext);
            if (!adapter.cancel) {
                res.status(409).json({
                    ok: false,
                    code: 'generation_cancel_unsupported',
                    message: `当前提供商协议 ${adapter.protocol} 不支持取消任务`
                });
                return;
            }
            res.json(await adapter.cancel(adapterContext));
        }
        catch (err) {
            res.status(500).json({ ok: false, message: `取消任务失败: ${getErrorMessage(err)}` });
        }
    });
    return router;
};
