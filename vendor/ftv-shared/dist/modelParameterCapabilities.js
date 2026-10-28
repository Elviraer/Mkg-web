import { isGptImageModel } from './providerProtocol.js';
const defaultVideoRequestEncoding = {
    aspectRatio: { field: 'aspect_ratio' },
    resolution: { field: 'resolution' },
    duration: { field: 'duration' },
    mode: { field: 'mode' }
};
const videoRequestPathPattern = /^[a-z0-9_~!$&'()*+,;=:@%\-]+(?:\.[a-z0-9_~!$&'()*+,;=:@%\-]+)*$/i;
const normalizeVideoRequestField = (value, fallback) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return { ...fallback };
    const source = value;
    const field = source.field === 'omit' ? 'omit' : typeof source.field === 'string' && videoRequestPathPattern.test(source.field) ? source.field : fallback.field;
    const casing = source.casing === 'lower' || source.casing === 'upper' || source.casing === 'preserve' ? source.casing : fallback.casing ?? 'preserve';
    const valueMap = typeof source.valueMap === 'object' && source.valueMap !== null && !Array.isArray(source.valueMap)
        ? Object.fromEntries(Object.entries(source.valueMap).filter(([key, mapped]) => typeof mapped === 'string' && key.length <= 96 && mapped.length <= 160).slice(0, 64))
        : fallback.valueMap;
    return { field, ...(casing !== 'preserve' ? { casing } : {}), ...(valueMap && Object.keys(valueMap).length > 0 ? { valueMap } : {}) };
};
export const normalizeVideoRequestEncoding = (value, fallback = defaultVideoRequestEncoding) => {
    const source = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
    return {
        aspectRatio: normalizeVideoRequestField(source.aspectRatio, fallback.aspectRatio),
        resolution: normalizeVideoRequestField(source.resolution, fallback.resolution),
        duration: normalizeVideoRequestField(source.duration, fallback.duration),
        mode: normalizeVideoRequestField(source.mode, fallback.mode)
    };
};
export const DEFAULT_VIDEO_REQUEST_ENCODING = defaultVideoRequestEncoding;
const videoRequestEncodingKeys = ['aspectRatio', 'resolution', 'duration', 'mode'];
const videoRequestEncodingKeySet = new Set(videoRequestEncodingKeys);
const videoRequestEncodingBlockKeys = new Set(['field', 'casing', 'valueMap']);
/**
 * Validates an Agent/UI supplied video request mapping before it is persisted.
 * `normalizeVideoRequestEncoding` fills every gap from the default mapping, so an unknown field
 * name or a typo would otherwise be silently replaced by the default and the mapping would look
 * applied while sending something else.
 */
export const validateVideoRequestEncodingInput = (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return '视频请求字段映射必须是对象';
    }
    const source = value;
    const unknownKeys = Object.keys(source).filter((key) => !videoRequestEncodingKeySet.has(key));
    if (unknownKeys.length > 0) {
        return `视频请求字段映射包含不支持的键：${unknownKeys.join('、')}（可用：${videoRequestEncodingKeys.join('、')}）`;
    }
    for (const key of videoRequestEncodingKeys) {
        const block = source[key];
        if (block === undefined)
            continue;
        if (typeof block !== 'object' || block === null || Array.isArray(block)) {
            return `视频请求字段映射 ${key} 必须是对象`;
        }
        const record = block;
        const unknownBlockKeys = Object.keys(record).filter((item) => !videoRequestEncodingBlockKeys.has(item));
        if (unknownBlockKeys.length > 0) {
            return `视频请求字段映射 ${key} 包含不支持的键：${unknownBlockKeys.join('、')}`;
        }
        if (record.field !== 'omit' && !(typeof record.field === 'string' && videoRequestPathPattern.test(record.field))) {
            return `视频请求字段映射 ${key} 的 field 无效：请填写请求字段路径或 "omit"`;
        }
        if (record.casing !== undefined && !['preserve', 'lower', 'upper'].includes(String(record.casing))) {
            return `视频请求字段映射 ${key} 的 casing 无效：可用 preserve、lower、upper`;
        }
        if (record.valueMap !== undefined) {
            if (typeof record.valueMap !== 'object' || record.valueMap === null || Array.isArray(record.valueMap)) {
                return `视频请求字段映射 ${key} 的 valueMap 必须是字符串到字符串的映射`;
            }
            const invalidEntry = Object.entries(record.valueMap)
                .find(([mapKey, mapped]) => mapKey.trim().length === 0 || typeof mapped !== 'string' || mapped.length === 0);
            if (invalidEntry)
                return `视频请求字段映射 ${key} 的 valueMap 含无效键值：${invalidEntry[0]}`;
        }
    }
    return undefined;
};
const applyVideoRequestValue = (value, field) => {
    if (typeof value === 'number' && !field.casing && !field.valueMap)
        return value;
    const raw = String(value);
    const casing = field.casing ?? 'preserve';
    const cased = casing === 'lower' ? raw.toLowerCase() : casing === 'upper' ? raw.toUpperCase() : raw;
    return field.valueMap?.[cased] ?? cased;
};
const setVideoRequestPath = (payload, path, value) => {
    const parts = path.split('.');
    let current = payload;
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
export const compileVideoRequestParameters = (input) => {
    const values = normalizeVideoParameters(input.capabilities, input);
    const encoding = normalizeVideoRequestEncoding(input.encoding);
    const payload = {};
    const write = (field, value) => {
        if (field.field !== 'omit' && value !== undefined)
            setVideoRequestPath(payload, field.field, applyVideoRequestValue(value, field));
    };
    write(encoding.aspectRatio, values.aspectRatio);
    write(encoding.resolution, values.resolution);
    write(encoding.duration, values.duration);
    write(encoding.mode, values.mode);
    return { payload, values, encoding };
};
const COMMON_IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '2:1', '1:2', '5:4', '4:5', '9:21', '21:9'];
const DOUBAO_IMAGE_ASPECT_RATIOS = ['3:4', '4:3', '1:1', '9:16', '16:9', '2:3'];
const DOLA_IMAGE_ASPECT_RATIOS = ['3:4', '4:3', '1:1', '9:16', '16:9', '2:3'];
const XYQ_IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
const APIMART_GPT_IMAGE_RESOLUTIONS = ['1K', '2K', '4K'];
const XYQ_IMAGE_RESOLUTIONS = ['1K', '2K', '4K', '8K'];
const APIMART_SEEDREAM_IMAGE_RESOLUTIONS = ['1K', '2K'];
const GPT_IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'];
const COMMON_IMAGE_BATCH_SIZES = [1, 2, 4];
const SINGLE_IMAGE_BATCH_SIZE = [1];
const COMMON_VIDEO_ASPECT_RATIOS = ['9:16', '16:9', '4:3', '3:4', '1:1', '21:9'];
const APIMART_VIDEO_RESOLUTIONS = ['480P', '720P', '768P', '1080P', '4K'];
const COMMON_VIDEO_MODES = ['全能参考', '首尾帧'];
const COMMON_AUDIO_MODES = ['speech', 'music', 'sound-effect'];
const OPENAI_AUDIO_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
export const isSeedAudioGenerationModel = (model) => {
    const normalized = model?.trim().toLowerCase().split('/').at(-1) ?? '';
    return normalized === 'doubao-seed-audio-1.0';
};
const isApimartSeedreamImageModel = (model) => {
    const normalized = model?.trim().toLowerCase() ?? '';
    return /seedream/.test(normalized) && /(?:^|[-_\s])5(?:\.0)?(?:[-_\s]|$)/.test(normalized);
};
const normalizeStringChoice = (value, supportedValues, fallback) => {
    const normalized = value?.trim().toLowerCase();
    const matched = supportedValues.find((item) => item.toLowerCase() === normalized);
    const supportedFallback = supportedValues.find((item) => item.toLowerCase() === fallback.trim().toLowerCase());
    return matched ?? supportedFallback ?? supportedValues[0] ?? fallback;
};
const normalizeNumberChoice = (value, supportedValues, fallback) => {
    const numeric = Number(value);
    const rounded = Number.isFinite(numeric) ? Math.round(numeric) : fallback;
    return supportedValues.includes(rounded)
        ? rounded
        : supportedValues.includes(fallback)
            ? fallback
            : supportedValues[0] ?? fallback;
};
const normalizeDurationRange = (value, capabilities) => {
    const { min, max, defaultValue } = capabilities.durationRange;
    const numeric = Number(value);
    const rounded = Number.isFinite(numeric) ? Math.round(numeric) : defaultValue;
    const clamped = Math.min(Math.max(rounded, min), max);
    const supportedDurations = capabilities.supportedDurations;
    if (!supportedDurations || supportedDurations.length === 0)
        return clamped;
    return supportedDurations.reduce((closest, current) => {
        const closestDistance = Math.abs(clamped - closest);
        const currentDistance = Math.abs(clamped - current);
        return currentDistance < closestDistance || (currentDistance === closestDistance && current > closest)
            ? current
            : closest;
    }, capabilities.defaults.duration);
};
const openAiCompatibleImageCapabilities = (model) => ({
    aspectRatios: COMMON_IMAGE_ASPECT_RATIOS,
    resolutions: APIMART_GPT_IMAGE_RESOLUTIONS,
    qualities: isGptImageModel(model) ? GPT_IMAGE_QUALITIES : [],
    batchSizes: COMMON_IMAGE_BATCH_SIZES,
    defaults: {
        aspectRatio: '16:9',
        resolution: '2K',
        quality: isGptImageModel(model) ? 'auto' : undefined,
        batchSize: 1
    }
});
const apimartImageCapabilities = (model) => {
    if (isGptImageModel(model)) {
        return {
            aspectRatios: COMMON_IMAGE_ASPECT_RATIOS,
            resolutions: APIMART_GPT_IMAGE_RESOLUTIONS,
            qualities: GPT_IMAGE_QUALITIES,
            batchSizes: COMMON_IMAGE_BATCH_SIZES,
            defaults: {
                aspectRatio: '16:9',
                resolution: '2K',
                quality: 'auto',
                batchSize: 1
            }
        };
    }
    if (isApimartSeedreamImageModel(model)) {
        return {
            aspectRatios: COMMON_IMAGE_ASPECT_RATIOS,
            resolutions: APIMART_SEEDREAM_IMAGE_RESOLUTIONS,
            qualities: [],
            batchSizes: SINGLE_IMAGE_BATCH_SIZE,
            defaults: {
                aspectRatio: '16:9',
                resolution: '2K',
                batchSize: 1
            }
        };
    }
    return {
        aspectRatios: COMMON_IMAGE_ASPECT_RATIOS,
        resolutions: [],
        qualities: [],
        batchSizes: SINGLE_IMAGE_BATCH_SIZE,
        defaults: {
            aspectRatio: '16:9',
            batchSize: 1
        }
    };
};
const zhenzhenImageCapabilities = (model) => ({
    aspectRatios: COMMON_IMAGE_ASPECT_RATIOS,
    resolutions: APIMART_GPT_IMAGE_RESOLUTIONS,
    qualities: isGptImageModel(model) ? GPT_IMAGE_QUALITIES : [],
    batchSizes: SINGLE_IMAGE_BATCH_SIZE,
    defaults: {
        aspectRatio: '16:9',
        resolution: '2K',
        quality: isGptImageModel(model) ? 'auto' : undefined,
        batchSize: 1
    }
});
const doubaoImageCapabilities = () => ({
    aspectRatios: DOUBAO_IMAGE_ASPECT_RATIOS,
    resolutions: [],
    qualities: [],
    batchSizes: SINGLE_IMAGE_BATCH_SIZE,
    defaults: {
        aspectRatio: '16:9',
        batchSize: 1
    }
});
const xyqImageCapabilities = () => ({
    aspectRatios: XYQ_IMAGE_ASPECT_RATIOS,
    resolutions: XYQ_IMAGE_RESOLUTIONS,
    qualities: [],
    batchSizes: SINGLE_IMAGE_BATCH_SIZE,
    defaults: {
        aspectRatio: '16:9',
        resolution: '2K',
        batchSize: 1
    }
});
const openAiCompatibleVideoCapabilities = () => ({
    aspectRatios: COMMON_VIDEO_ASPECT_RATIOS,
    resolutions: ['720P', '768P', '1080P', '4K'],
    modes: COMMON_VIDEO_MODES,
    durationRange: {
        min: 4,
        max: 30,
        defaultValue: 5
    },
    defaults: {
        aspectRatio: '16:9',
        resolution: '720P',
        duration: 5,
        mode: '全能参考'
    }
});
const dolaImageCapabilities = () => ({
    aspectRatios: DOLA_IMAGE_ASPECT_RATIOS,
    resolutions: [],
    qualities: [],
    batchSizes: SINGLE_IMAGE_BATCH_SIZE,
    defaults: {
        aspectRatio: '16:9',
        batchSize: 1
    }
});
const boundedVideoCapabilities = () => ({
    ...openAiCompatibleVideoCapabilities(),
    durationRange: {
        min: 4,
        max: 15,
        defaultValue: 5
    }
});
const apimartVideoCapabilities = () => ({
    aspectRatios: COMMON_VIDEO_ASPECT_RATIOS,
    resolutions: APIMART_VIDEO_RESOLUTIONS,
    modes: COMMON_VIDEO_MODES,
    durationRange: {
        min: 4,
        max: 15,
        defaultValue: 5
    },
    defaults: {
        aspectRatio: '16:9',
        resolution: '720P',
        duration: 5,
        mode: '全能参考'
    }
});
const doubaoVideoCapabilities = (model) => ({
    aspectRatios: COMMON_VIDEO_ASPECT_RATIOS,
    resolutions: ['720P'],
    modes: COMMON_VIDEO_MODES,
    durationRange: {
        min: 4,
        max: model?.toLocaleLowerCase() === 'seedance_v2.5' ? 30 : 15,
        defaultValue: 10
    },
    defaults: {
        aspectRatio: '16:9',
        resolution: '720P',
        duration: 10,
        mode: '全能参考'
    }
});
const dolaVideoCapabilities = () => ({
    aspectRatios: COMMON_VIDEO_ASPECT_RATIOS,
    resolutions: ['720P'],
    supportedDurations: [5, 10, 15, 20, 25, 30],
    modes: COMMON_VIDEO_MODES,
    durationRange: { min: 5, max: 30, defaultValue: 10 },
    defaults: {
        aspectRatio: '16:9',
        resolution: '720P',
        duration: 10,
        mode: '全能参考'
    }
});
const openAiCompatibleAudioCapabilities = () => ({
    modes: COMMON_AUDIO_MODES,
    voices: OPENAI_AUDIO_VOICES,
    speedRange: { min: 0.25, max: 4, step: 0.05, defaultValue: 1 },
    volumeRange: { min: 0, max: 2, step: 0.05, defaultValue: 1 },
    pitchRange: { min: -12, max: 12, step: 1, defaultValue: 0 },
    defaults: { mode: 'speech', voice: 'alloy', speed: 1, volume: 1, pitch: 0 }
});
const seedAudioGenerationCapabilities = () => ({
    modes: COMMON_AUDIO_MODES,
    voices: [],
    speedRange: { min: -50, max: 100, step: 1, defaultValue: 0 },
    volumeRange: { min: -50, max: 100, step: 1, defaultValue: 0 },
    pitchRange: { min: -12, max: 12, step: 1, defaultValue: 0 },
    defaults: { mode: 'speech', speed: 0, volume: 0, pitch: 0 }
});
const normalizeStringList = (value, fallback, allowEmpty = false) => {
    if (!Array.isArray(value))
        return [...fallback];
    const normalized = Array.from(new Set(value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)))
        .slice(0, 64);
    return normalized.length > 0 || allowEmpty ? normalized : [...fallback];
};
const normalizeNumberList = (value, fallback, allowEmpty = false) => {
    if (!Array.isArray(value))
        return [...fallback];
    const normalized = Array.from(new Set(value
        .filter((item) => typeof item === 'number' && Number.isFinite(item))))
        .sort((left, right) => left - right)
        .slice(0, 64);
    return normalized.length > 0 || allowEmpty ? normalized : [...fallback];
};
const readRecord = (value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {});
const readFinite = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const normalizeNumericParameterRange = (value, fallback) => {
    const range = readRecord(value);
    const min = readFinite(range.min, fallback.min);
    const max = Math.max(min, readFinite(range.max, fallback.max));
    const step = Math.max(0.0001, readFinite(range.step, fallback.step));
    const defaultValue = Math.min(max, Math.max(min, readFinite(range.defaultValue, fallback.defaultValue)));
    return { min, max, step, defaultValue };
};
const normalizeNumericParameterValue = (value, range, fallback) => {
    const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.min(range.max, Math.max(range.min, numeric));
};
export const normalizeProviderModelCapabilityOverrides = (value, fallback = {}) => {
    const source = readRecord(value);
    const normalized = {};
    if ('text' in source || fallback.text) {
        const text = readRecord(source.text);
        normalized.text = { multimodal: typeof text.multimodal === 'boolean' ? text.multimodal : fallback.text?.multimodal ?? true };
    }
    if ('image' in source || fallback.image) {
        const base = fallback.image ?? openAiCompatibleImageCapabilities(undefined);
        const image = readRecord(source.image);
        const defaults = readRecord(image.defaults);
        const aspectRatios = normalizeStringList(image.aspectRatios, base.aspectRatios);
        const resolutions = normalizeStringList(image.resolutions, base.resolutions);
        const qualities = normalizeStringList(image.qualities, base.qualities, true)
            .filter((item) => ['auto', 'low', 'medium', 'high', 'standard', 'hd'].includes(item));
        const batchSizes = normalizeNumberList(image.batchSizes, base.batchSizes)
            .map((item) => Math.max(1, Math.round(item)));
        normalized.image = {
            aspectRatios,
            resolutions,
            qualities,
            batchSizes,
            defaults: {
                aspectRatio: normalizeStringChoice(String(defaults.aspectRatio ?? ''), aspectRatios, base.defaults.aspectRatio),
                ...(resolutions.length > 0 ? { resolution: normalizeStringChoice(String(defaults.resolution ?? ''), resolutions, base.defaults.resolution ?? resolutions[0]) } : {}),
                ...(qualities.length > 0 ? { quality: normalizeStringChoice(String(defaults.quality ?? ''), qualities, base.defaults.quality ?? qualities[0]) } : {}),
                batchSize: normalizeNumberChoice(readFinite(defaults.batchSize, base.defaults.batchSize), batchSizes, base.defaults.batchSize)
            }
        };
    }
    if ('video' in source || fallback.video) {
        const base = fallback.video ?? openAiCompatibleVideoCapabilities();
        const video = readRecord(source.video);
        const range = readRecord(video.durationRange);
        const defaults = readRecord(video.defaults);
        const aspectRatios = normalizeStringList(video.aspectRatios, base.aspectRatios);
        const resolutions = normalizeStringList(video.resolutions, base.resolutions);
        const modes = normalizeStringList(video.modes, base.modes);
        const hasExplicitSupportedDurations = 'supportedDurations' in video;
        const supportedDurations = normalizeNumberList(video.supportedDurations, base.supportedDurations ?? [], hasExplicitSupportedDurations);
        const min = Math.max(1, readFinite(range.min, base.durationRange.min));
        const max = Math.max(min, readFinite(range.max, base.durationRange.max));
        const defaultValue = Math.min(max, Math.max(min, readFinite(range.defaultValue, base.durationRange.defaultValue)));
        normalized.video = {
            aspectRatios,
            resolutions,
            modes,
            ...(hasExplicitSupportedDurations || supportedDurations.length > 0 ? { supportedDurations } : {}),
            durationRange: { min, max, defaultValue },
            defaults: {
                aspectRatio: normalizeStringChoice(String(defaults.aspectRatio ?? ''), aspectRatios, base.defaults.aspectRatio),
                ...(resolutions.length > 0 ? { resolution: normalizeStringChoice(String(defaults.resolution ?? ''), resolutions, base.defaults.resolution ?? resolutions[0]) } : {}),
                duration: Math.min(max, Math.max(min, readFinite(defaults.duration, defaultValue))),
                ...(modes.length > 0 ? { mode: normalizeStringChoice(String(defaults.mode ?? ''), modes, base.defaults.mode ?? modes[0]) } : {})
            }
        };
    }
    if ('audio' in source || fallback.audio) {
        const base = fallback.audio ?? openAiCompatibleAudioCapabilities();
        const audio = readRecord(source.audio);
        const defaults = readRecord(audio.defaults);
        const modes = normalizeStringList(audio.modes, base.modes)
            .filter((item) => COMMON_AUDIO_MODES.includes(item));
        const safeModes = modes.length > 0 ? modes : [...base.modes];
        // Models without a voice catalog must be able to persist an explicit empty list.
        const voices = normalizeStringList(audio.voices, base.voices, true);
        const speedRange = normalizeNumericParameterRange(audio.speedRange, base.speedRange);
        const volumeRange = normalizeNumericParameterRange(audio.volumeRange, base.volumeRange);
        const pitchRange = normalizeNumericParameterRange(audio.pitchRange, base.pitchRange);
        normalized.audio = {
            modes: safeModes,
            voices,
            speedRange,
            volumeRange,
            pitchRange,
            defaults: {
                mode: safeModes.includes(defaults.mode)
                    ? defaults.mode
                    : safeModes.includes(base.defaults.mode)
                        ? base.defaults.mode
                        : safeModes[0],
                ...(voices.length > 0 ? { voice: normalizeStringChoice(String(defaults.voice ?? ''), voices, base.defaults.voice ?? voices[0]) } : {}),
                speed: normalizeNumericParameterValue(readFinite(defaults.speed, speedRange.defaultValue), speedRange, speedRange.defaultValue),
                volume: normalizeNumericParameterValue(readFinite(defaults.volume, volumeRange.defaultValue), volumeRange, volumeRange.defaultValue),
                pitch: normalizeNumericParameterValue(readFinite(defaults.pitch, pitchRange.defaultValue), pitchRange, pitchRange.defaultValue)
            }
        };
    }
    return normalized;
};
export const resolveModelParameterCapabilities = ({ protocol, kind, model, overrides }) => {
    if (kind === 'text') {
        const text = normalizeProviderModelCapabilityOverrides(overrides, { text: { multimodal: true } }).text;
        return { kind, text };
    }
    if (kind === 'audio') {
        const base = isSeedAudioGenerationModel(model)
            ? seedAudioGenerationCapabilities()
            : openAiCompatibleAudioCapabilities();
        const audio = normalizeProviderModelCapabilityOverrides(overrides, { audio: base }).audio;
        return { kind, audio };
    }
    if (kind === 'video') {
        const video = protocol === 'apimart'
            ? apimartVideoCapabilities()
            : protocol === 'doubao-gateway'
                ? doubaoVideoCapabilities(model)
                : protocol === 'dola-gateway'
                    ? dolaVideoCapabilities()
                    : protocol === 'xyq-gateway' || protocol === 'zhenzhen'
                        ? boundedVideoCapabilities()
                        : openAiCompatibleVideoCapabilities();
        return {
            kind,
            video: normalizeProviderModelCapabilityOverrides(overrides, { video }).video
        };
    }
    if (protocol === 'apimart') {
        return {
            kind,
            image: normalizeProviderModelCapabilityOverrides(overrides, { image: apimartImageCapabilities(model) }).image
        };
    }
    if (protocol === 'zhenzhen') {
        return {
            kind,
            image: normalizeProviderModelCapabilityOverrides(overrides, { image: zhenzhenImageCapabilities(model) }).image
        };
    }
    if (protocol === 'doubao-gateway') {
        return {
            kind,
            image: normalizeProviderModelCapabilityOverrides(overrides, { image: doubaoImageCapabilities() }).image
        };
    }
    if (protocol === 'dola-gateway') {
        return {
            kind,
            image: normalizeProviderModelCapabilityOverrides(overrides, { image: dolaImageCapabilities() }).image
        };
    }
    if (protocol === 'xyq-gateway') {
        return {
            kind,
            image: normalizeProviderModelCapabilityOverrides(overrides, { image: xyqImageCapabilities() }).image
        };
    }
    return {
        kind,
        image: normalizeProviderModelCapabilityOverrides(overrides, { image: openAiCompatibleImageCapabilities(model) }).image
    };
};
export const normalizeImageParameters = (capabilities, values) => {
    const aspectRatio = normalizeStringChoice(values.aspectRatio, capabilities.aspectRatios, capabilities.defaults.aspectRatio);
    const resolution = capabilities.resolutions.length > 0
        ? normalizeStringChoice(values.resolution, capabilities.resolutions, capabilities.defaults.resolution ?? capabilities.resolutions[0])
        : undefined;
    const quality = capabilities.qualities.length > 0
        ? normalizeStringChoice(values.quality, capabilities.qualities, capabilities.defaults.quality ?? capabilities.qualities[0])
        : undefined;
    const batchSize = normalizeNumberChoice(values.batchSize, capabilities.batchSizes, capabilities.defaults.batchSize);
    return {
        aspectRatio,
        ...(resolution ? { resolution } : {}),
        ...(quality ? { quality } : {}),
        batchSize
    };
};
export const normalizeVideoParameters = (capabilities, values) => {
    const aspectRatio = normalizeStringChoice(values.aspectRatio, capabilities.aspectRatios, capabilities.defaults.aspectRatio);
    const resolution = capabilities.resolutions.length > 0
        ? normalizeStringChoice(values.resolution, capabilities.resolutions, capabilities.defaults.resolution ?? capabilities.resolutions[0])
        : undefined;
    const duration = normalizeDurationRange(values.duration, capabilities);
    const mode = capabilities.modes.length > 0
        ? normalizeStringChoice(values.mode, capabilities.modes, capabilities.defaults.mode ?? capabilities.modes[0])
        : undefined;
    return {
        aspectRatio,
        ...(resolution ? { resolution } : {}),
        duration,
        ...(mode ? { mode } : {})
    };
};
export const normalizeAudioParameters = (capabilities, values) => {
    const mode = capabilities.modes.includes(values.mode ?? capabilities.defaults.mode)
        ? values.mode ?? capabilities.defaults.mode
        : capabilities.defaults.mode;
    const voice = capabilities.voices.length > 0
        ? normalizeStringChoice(values.voice, capabilities.voices, capabilities.defaults.voice ?? capabilities.voices[0])
        : undefined;
    const speed = normalizeNumericParameterValue(values.speed, capabilities.speedRange, capabilities.defaults.speed);
    const volume = normalizeNumericParameterValue(values.volume, capabilities.volumeRange, capabilities.defaults.volume);
    const pitch = normalizeNumericParameterValue(values.pitch, capabilities.pitchRange, capabilities.defaults.pitch);
    return { mode, ...(voice ? { voice } : {}), speed, volume, pitch };
};
