export const DEFAULT_GENERATION_TIMEOUT_POLICY = {
    textExecutionMs: 5 * 60 * 1000,
    imageExecutionMs: 5 * 60 * 1000,
    videoSubmitMs: 60 * 1000,
    imageTaskWaitMs: 10 * 60 * 1000,
    videoTaskWaitMs: 30 * 60 * 1000,
    statusRequestMs: 30 * 1000
};
const generationTimeoutBounds = {
    textExecutionMs: [10000, 60 * 60 * 1000],
    imageExecutionMs: [10000, 60 * 60 * 1000],
    videoSubmitMs: [10000, 30 * 60 * 1000],
    imageTaskWaitMs: [60000, 24 * 60 * 60 * 1000],
    videoTaskWaitMs: [60000, 24 * 60 * 60 * 1000],
    statusRequestMs: [5000, 2 * 60 * 1000]
};
export const normalizeGenerationTimeoutPolicy = (value, fallback = DEFAULT_GENERATION_TIMEOUT_POLICY) => {
    const normalized = { ...fallback };
    Object.keys(generationTimeoutBounds).forEach((key) => {
        const candidate = value?.[key];
        if (typeof candidate !== 'number' || !Number.isFinite(candidate))
            return;
        const [minimum, maximum] = generationTimeoutBounds[key];
        normalized[key] = Math.round(Math.min(maximum, Math.max(minimum, candidate)));
    });
    return normalized;
};
const isRecord = (value) => (typeof value === 'object' && value !== null && !Array.isArray(value));
const readString = (value) => typeof value === 'string' && value.length > 0 ? value : undefined;
const readStringArray = (value) => Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.length > 0)
    : undefined;
const readFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
export const parseGenerationApiResult = (value) => {
    if (!isRecord(value))
        return { ok: false, message: '接口返回格式异常' };
    const message = readString(value.message);
    const status = readString(value.status);
    const taskId = readString(value.taskId);
    const text = readString(value.text);
    const previewUrl = readString(value.previewUrl);
    const previewUrls = readStringArray(value.previewUrls);
    const historyAssetIds = readStringArray(value.historyAssetIds);
    const providerId = readString(value.providerId);
    const providerName = readString(value.providerName);
    const referenceCount = readFiniteNumber(value.referenceCount);
    const retryable = value.retryable === true ? true : undefined;
    const retryReason = value.retryReason === 'generation-timeout' || value.retryReason === 'remote-media-timeout'
        ? value.retryReason
        : undefined;
    return {
        ok: typeof value.ok === 'boolean' ? value.ok : false,
        ...(message ? { message } : {}),
        ...(status ? { status } : {}),
        ...(taskId ? { taskId } : {}),
        ...(text ? { text } : {}),
        ...(previewUrl ? { previewUrl } : {}),
        ...(previewUrls ? { previewUrls } : {}),
        ...(historyAssetIds ? { historyAssetIds } : {}),
        ...(providerId ? { providerId } : {}),
        ...(providerName ? { providerName } : {}),
        ...(referenceCount !== undefined ? { referenceCount } : {}),
        ...(retryable ? { retryable } : {}),
        ...(retryReason ? { retryReason } : {}),
        ...('position' in value ? { position: value.position } : {})
    };
};
