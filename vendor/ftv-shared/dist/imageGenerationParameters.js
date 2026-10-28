import { normalizeProviderModelCapabilityOverrides } from './modelParameterCapabilities.js';
const COMMON_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '21:9', '9:21'];
const OPENAI_LEGACY_RATIOS = COMMON_RATIOS;
const GPT_QUALITIES = ['auto', 'low', 'medium', 'high'];
const STANDARD_HD_QUALITIES = ['standard', 'hd'];
const imageCapabilities = (aspectRatios, resolutions, qualities, defaults, batchSizes = [1]) => ({
    aspectRatios,
    resolutions,
    qualities,
    batchSizes,
    defaults: {
        aspectRatio: defaults.aspectRatio,
        ...(defaults.resolution ? { resolution: defaults.resolution } : {}),
        ...(defaults.quality ? { quality: defaults.quality } : {}),
        batchSize: defaults.batchSize ?? 1
    }
});
const pixelSizes = {
    '1K': {
        '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536', '4:3': '1024x768',
        '3:4': '768x1024', '5:4': '1280x1024', '4:5': '1024x1280', '16:9': '1536x864',
        '9:16': '864x1536', '2:1': '2048x1024', '1:2': '1024x2048', '21:9': '2016x864',
        '9:21': '864x2016'
    },
    '2K': {
        '1:1': '2048x2048', '3:2': '2048x1360', '2:3': '1360x2048', '4:3': '2048x1536',
        '3:4': '1536x2048', '5:4': '2560x2048', '4:5': '2048x2560', '16:9': '2048x1152',
        '9:16': '1152x2048', '2:1': '2688x1344', '1:2': '1344x2688', '21:9': '2688x1152',
        '9:21': '1152x2688'
    },
    '4K': {
        '1:1': '2880x2880', '3:2': '3520x2336', '2:3': '2336x3520', '4:3': '3312x2480',
        '3:4': '2480x3312', '5:4': '3216x2576', '4:5': '2576x3216', '16:9': '3840x2160',
        '9:16': '2160x3840', '2:1': '3840x1920', '1:2': '1920x3840', '21:9': '3840x1648',
        '9:21': '1648x3840'
    }
};
const flattenPixelSizes = (resolutions, ratios) => Object.fromEntries(resolutions.flatMap((resolution) => ratios.flatMap((ratio) => {
    const size = pixelSizes[resolution]?.[ratio];
    return size ? [[`${ratio}|${resolution}`, size]] : [];
})));
const ratioEncoding = (field, resolutionField, options = {}) => ({
    aspectRatio: { field, value: field === 'omit' ? 'omit' : 'ratio', casing: 'preserve' },
    resolution: { field: resolutionField, casing: options.resolutionCase ?? 'preserve' },
    quality: { field: options.quality ? 'quality' : 'omit', casing: options.qualityCase ?? 'preserve' },
    batch: { field: 'n' }
});
const pixelEncoding = (options = {}) => ({
    aspectRatio: { field: 'size', value: 'pixel-map', casing: 'preserve' },
    resolution: { field: 'omit', casing: 'preserve' },
    quality: { field: options.quality ? 'quality' : 'omit', casing: 'preserve' },
    batch: { field: options.batch === false ? 'omit' : 'n' },
    sizeMap: flattenPixelSizes(['1K', '2K', '4K'], COMMON_RATIOS)
});
const legacyOpenAiSizeMap = Object.fromEntries(OPENAI_LEGACY_RATIOS.map((ratio) => {
    const size = ratio === '1:1'
        ? '1024x1024'
        : ['9:16', '3:4', '2:3', '4:5', '1:2', '9:21'].includes(ratio)
            ? '1024x1792'
            : '1792x1024';
    return [`${ratio}|2K`, size];
}));
const PRESETS = {
    'openai-gpt-image-2': {
        id: 'openai-gpt-image-2',
        label: 'OpenAI GPT Image 2',
        description: '将比例与分辨率编译为满足 GPT Image 2 限制的像素 size。',
        capabilities: imageCapabilities(COMMON_RATIOS, ['1K', '2K', '4K'], GPT_QUALITIES, {
            aspectRatio: '1:1', resolution: '1K', quality: 'auto'
        }, [1, 2, 4]),
        encoding: pixelEncoding({ quality: true })
    },
    'openai-gpt-image-legacy': {
        id: 'openai-gpt-image-legacy',
        label: 'OpenAI GPT Image 旧版',
        description: '使用旧版 GPT Image 的三个标准像素尺寸。',
        capabilities: imageCapabilities(OPENAI_LEGACY_RATIOS, ['2K'], GPT_QUALITIES, {
            aspectRatio: '1:1', resolution: '2K', quality: 'auto'
        }, [1, 2, 4]),
        encoding: {
            ...pixelEncoding({ quality: true }),
            sizeMap: legacyOpenAiSizeMap
        }
    },
    'openai-dall-e-legacy': {
        id: 'openai-dall-e-legacy',
        label: 'OpenAI DALL-E 兼容旧版',
        description: '保持旧版 DALL-E 兼容尺寸，不默认发送 quality；需要 standard/hd 时可在高级覆盖中启用。',
        capabilities: imageCapabilities(OPENAI_LEGACY_RATIOS, ['2K'], [], {
            aspectRatio: '1:1', resolution: '2K'
        }, [1, 2, 4]),
        encoding: {
            ...pixelEncoding(),
            sizeMap: legacyOpenAiSizeMap
        }
    },
    'apimart-gpt-image': {
        id: 'apimart-gpt-image',
        label: 'APIMART GPT Image',
        description: '发送 size=比例、resolution=分辨率档位和 OpenAI 质量枚举。',
        capabilities: imageCapabilities(COMMON_RATIOS, ['1K', '2K', '4K'], GPT_QUALITIES, {
            aspectRatio: '16:9', resolution: '2K', quality: 'auto'
        }, [1, 2, 4]),
        encoding: ratioEncoding('size', 'resolution', { resolutionCase: 'lower', quality: true })
    },
    'apimart-seedream': {
        id: 'apimart-seedream',
        label: 'APIMART Seedream',
        description: '发送 size=比例与 resolution=1k/2k，不发送 quality。',
        capabilities: imageCapabilities(COMMON_RATIOS, ['1K', '2K'], [], {
            aspectRatio: '16:9', resolution: '2K'
        }),
        encoding: ratioEncoding('size', 'resolution', { resolutionCase: 'lower' })
    },
    'grok2api-imagine': {
        id: 'grok2api-imagine',
        label: 'GROK2API Imagine',
        description: '发送 aspect_ratio 与小写 resolution，不发送 quality。',
        capabilities: imageCapabilities(COMMON_RATIOS, ['1K', '2K'], [], {
            aspectRatio: '16:9', resolution: '2K'
        }, [1, 2, 4]),
        encoding: ratioEncoding('aspect_ratio', 'resolution', { resolutionCase: 'lower' })
    },
    'google-nano-banana': {
        id: 'google-nano-banana',
        label: 'Google Nano Banana 原生参数',
        description: '在 response_format 中发送 aspect_ratio 与大写 image_size。仅用于确认支持该结构的网关。',
        capabilities: imageCapabilities(COMMON_RATIOS, ['512P', '1K', '2K', '4K'], [], {
            aspectRatio: '1:1', resolution: '1K'
        }),
        encoding: {
            ...ratioEncoding('response_format.aspect_ratio', 'response_format.image_size', { resolutionCase: 'upper' }),
            batch: { field: 'omit' }
        }
    },
    'seedream-size-pixels': {
        id: 'seedream-size-pixels',
        label: 'Seedream 像素 size',
        description: '把比例与 1K/2K/4K 映射为像素 size，不发送独立 resolution。',
        capabilities: imageCapabilities(COMMON_RATIOS, ['1K', '2K', '4K'], [], {
            aspectRatio: '16:9', resolution: '2K'
        }),
        encoding: pixelEncoding({ batch: false })
    },
    'zhenzhen-gpt-image': {
        id: 'zhenzhen-gpt-image',
        label: '贞贞 GPT Image',
        description: '按贞贞现有映射发送像素 size，并支持 OpenAI 质量枚举。',
        capabilities: imageCapabilities(COMMON_RATIOS, ['1K', '2K', '4K'], GPT_QUALITIES, {
            aspectRatio: '16:9', resolution: '2K', quality: 'auto'
        }),
        encoding: pixelEncoding({ quality: true, batch: false })
    }
};
const isRecord = (value) => (typeof value === 'object' && value !== null && !Array.isArray(value));
const presetIds = new Set(Object.keys(PRESETS));
const aspectFields = new Set(['size', 'aspect_ratio', 'response_format.aspect_ratio', 'omit']);
const resolutionFields = new Set(['resolution', 'image_size', 'response_format.image_size', 'omit']);
const cases = new Set(['preserve', 'lower', 'upper']);
export const IMAGE_QUALITY_PRESETS = [...GPT_QUALITIES, ...STANDARD_HD_QUALITIES];
export const getImageGenerationPresets = () => Object.values(PRESETS);
export const getImageGenerationPreset = (id) => (id ? PRESETS[id] : undefined);
export const normalizeImageGenerationPresetId = (value) => (typeof value === 'string' && presetIds.has(value)
    ? value
    : undefined);
const readCase = (value, fallback) => (typeof value === 'string' && cases.has(value) ? value : fallback);
const normalizeStringMap = (value, fallback) => {
    if (!isRecord(value))
        return fallback ? { ...fallback } : undefined;
    const entries = Object.entries(value)
        .filter((entry) => typeof entry[1] === 'string')
        .map(([key, item]) => [key.trim(), item.trim()])
        .filter(([key, item]) => key.length > 0 && item.length > 0)
        .slice(0, 256);
    return entries.length > 0 ? Object.fromEntries(entries) : fallback ? { ...fallback } : undefined;
};
export const normalizeImageRequestEncoding = (value, fallback) => {
    if (!isRecord(value) && !fallback)
        return undefined;
    const source = isRecord(value) ? value : {};
    const aspect = isRecord(source.aspectRatio) ? source.aspectRatio : {};
    const resolution = isRecord(source.resolution) ? source.resolution : {};
    const quality = isRecord(source.quality) ? source.quality : {};
    const batch = isRecord(source.batch) ? source.batch : {};
    if (!fallback) {
        if (!isRecord(source.aspectRatio) || !isRecord(source.resolution) || !isRecord(source.quality) || !isRecord(source.batch)) {
            return undefined;
        }
        if (typeof aspect.field !== 'string' || !aspectFields.has(aspect.field)
            || (aspect.value !== 'ratio' && aspect.value !== 'pixel-map' && aspect.value !== 'omit')
            || typeof aspect.casing !== 'string' || !cases.has(aspect.casing)
            || typeof resolution.field !== 'string' || !resolutionFields.has(resolution.field)
            || typeof resolution.casing !== 'string' || !cases.has(resolution.casing)
            || (quality.field !== 'quality' && quality.field !== 'omit')
            || typeof quality.casing !== 'string' || !cases.has(quality.casing)
            || (batch.field !== 'n' && batch.field !== 'omit')) {
            return undefined;
        }
    }
    const aspectField = typeof aspect.field === 'string' && aspectFields.has(aspect.field)
        ? aspect.field
        : fallback?.aspectRatio.field ?? 'omit';
    const aspectValue = aspect.value === 'ratio' || aspect.value === 'pixel-map' || aspect.value === 'omit'
        ? aspect.value
        : fallback?.aspectRatio.value ?? (aspectField === 'omit' ? 'omit' : 'ratio');
    const resolutionField = typeof resolution.field === 'string' && resolutionFields.has(resolution.field)
        ? resolution.field
        : fallback?.resolution.field ?? 'omit';
    const qualityField = quality.field === 'quality' ? 'quality' : quality.field === 'omit'
        ? 'omit'
        : fallback?.quality.field ?? 'omit';
    const batchField = batch.field === 'n' ? 'n' : batch.field === 'omit'
        ? 'omit'
        : fallback?.batch.field ?? 'n';
    return {
        aspectRatio: {
            field: aspectField,
            value: aspectField === 'omit' ? 'omit' : aspectValue,
            casing: readCase(aspect.casing, fallback?.aspectRatio.casing ?? 'preserve')
        },
        resolution: {
            field: resolutionField,
            casing: readCase(resolution.casing, fallback?.resolution.casing ?? 'preserve')
        },
        quality: {
            field: qualityField,
            casing: readCase(quality.casing, fallback?.quality.casing ?? 'preserve'),
            ...(normalizeStringMap(quality.valueMap, fallback?.quality.valueMap)
                ? { valueMap: normalizeStringMap(quality.valueMap, fallback?.quality.valueMap) }
                : {})
        },
        batch: { field: batchField },
        ...(normalizeStringMap(source.sizeMap, fallback?.sizeMap)
            ? { sizeMap: normalizeStringMap(source.sizeMap, fallback?.sizeMap) }
            : {})
    };
};
const normalizeModel = (model) => model?.trim().toLowerCase().split('/').at(-1) ?? '';
const isGptImage2 = (model) => /(?:^|[-_])gpt[-_]?image[-_]?2(?:$|[-_])/.test(normalizeModel(model));
const isGptImage = (model) => /(?:^|[-_])gpt[-_]?image(?:$|[-_])/.test(normalizeModel(model));
const isDallE = (model) => /dall[-_\s]?e/.test(normalizeModel(model));
const isSeedream = (model) => /seedream/.test(normalizeModel(model));
const isNanoBanana = (model) => /nano[-_\s]?banana|gemini.*image/.test(normalizeModel(model));
export const inferImageGenerationPresetId = ({ protocol, providerProfile, model }) => {
    if (providerProfile === 'grok2api')
        return 'grok2api-imagine';
    if (protocol === 'apimart') {
        if (isGptImage(model))
            return 'apimart-gpt-image';
        if (isSeedream(model))
            return 'apimart-seedream';
        return undefined;
    }
    if (protocol === 'zhenzhen') {
        if (isGptImage(model))
            return 'zhenzhen-gpt-image';
        if (isSeedream(model) || isNanoBanana(model))
            return 'seedream-size-pixels';
        return undefined;
    }
    if (protocol !== 'openai-compatible')
        return undefined;
    if (isGptImage2(model))
        return 'openai-gpt-image-2';
    if (isGptImage(model))
        return 'openai-gpt-image-legacy';
    if (isDallE(model))
        return 'openai-dall-e-legacy';
    if (/^grok-imagine/.test(normalizeModel(model)))
        return 'grok2api-imagine';
    return undefined;
};
const modelFamilyCapabilities = (model) => {
    if (isNanoBanana(model)) {
        return PRESETS['google-nano-banana'].capabilities;
    }
    if (isSeedream(model)) {
        return PRESETS['seedream-size-pixels'].capabilities;
    }
    return imageCapabilities(COMMON_RATIOS, [], [], { aspectRatio: '1:1' });
};
export const resolveImageGenerationContract = ({ protocol, providerProfile, model, presetId, capabilityOverrides, encodingOverride }) => {
    const inferredPresetId = inferImageGenerationPresetId({ protocol, providerProfile, model });
    const selectedPresetId = presetId ?? inferredPresetId;
    const preset = getImageGenerationPreset(selectedPresetId);
    const baseCapabilities = preset?.capabilities ?? modelFamilyCapabilities(model);
    const capabilities = normalizeProviderModelCapabilityOverrides(capabilityOverrides, { image: baseCapabilities }).image;
    const encoding = encodingOverride
        ? normalizeImageRequestEncoding(encodingOverride, preset?.encoding)
        : preset?.encoding;
    if (encoding) {
        return {
            status: 'ready',
            source: encodingOverride ? 'custom' : presetId ? 'explicit-preset' : 'verified-preset',
            ...(selectedPresetId ? { presetId: selectedPresetId } : {}),
            capabilities,
            encoding
        };
    }
    const familyKnown = isNanoBanana(model) || isSeedream(model);
    return {
        status: 'unknown',
        source: familyKnown ? 'model-family' : 'unknown',
        capabilities,
        message: familyKnown
            ? '已识别图片模型族，但当前 Provider 的请求字段尚未确认。请在模型高级设置中选择图片参数预设或配置字段映射。'
            : '当前图片模型没有已验证的参数合同。请在模型高级设置中选择图片参数预设或配置字段映射。'
    };
};
const applyCase = (value, casing) => (casing === 'lower' ? value.toLowerCase() : casing === 'upper' ? value.toUpperCase() : value);
const setPayloadPath = (payload, path, value) => {
    const parts = path.split('.');
    let current = payload;
    parts.forEach((part, index) => {
        if (index === parts.length - 1) {
            current[part] = value;
            return;
        }
        const nested = isRecord(current[part]) ? current[part] : {};
        current[part] = nested;
        current = nested;
    });
};
const requireChoice = (value, supported, fallback, label) => {
    const selected = value ?? fallback;
    if (!supported.includes(selected)) {
        throw new Error(`${label} ${String(selected)} 不受当前图片模型支持，可用值：${supported.join('、') || '无'}`);
    }
    return selected;
};
export const compileImageRequestParameters = (input) => {
    const contract = resolveImageGenerationContract(input);
    if (contract.status !== 'ready' || !contract.encoding) {
        throw new Error(contract.message ?? '当前图片模型缺少可用的参数合同');
    }
    const { capabilities, encoding } = contract;
    const aspectRatio = requireChoice(input.aspectRatio, capabilities.aspectRatios, capabilities.defaults.aspectRatio, '比例');
    const resolution = capabilities.resolutions.length > 0
        ? requireChoice(input.resolution, capabilities.resolutions, capabilities.defaults.resolution ?? capabilities.resolutions[0], '分辨率')
        : undefined;
    const quality = capabilities.qualities.length > 0
        ? requireChoice(input.quality, capabilities.qualities, capabilities.defaults.quality ?? capabilities.qualities[0], '质量')
        : undefined;
    if (input.quality && !quality)
        throw new Error(`当前图片模型不支持质量参数 ${input.quality}`);
    const batchSize = requireChoice(input.batchSize, capabilities.batchSizes, capabilities.defaults.batchSize, '生成数量');
    const payload = {};
    if (encoding.aspectRatio.field !== 'omit' && encoding.aspectRatio.value !== 'omit') {
        const aspectValue = encoding.aspectRatio.value === 'pixel-map'
            ? encoding.sizeMap?.[`${aspectRatio}|${resolution ?? ''}`]
            : aspectRatio;
        if (!aspectValue) {
            throw new Error(`比例 ${aspectRatio}${resolution ? ` + ${resolution}` : ''} 没有可用的 size 映射`);
        }
        setPayloadPath(payload, encoding.aspectRatio.field, applyCase(aspectValue, encoding.aspectRatio.casing));
    }
    if (resolution && encoding.resolution.field !== 'omit') {
        setPayloadPath(payload, encoding.resolution.field, applyCase(resolution, encoding.resolution.casing));
    }
    if (quality && encoding.quality.field !== 'omit') {
        const mapped = encoding.quality.valueMap?.[quality] ?? quality;
        setPayloadPath(payload, encoding.quality.field, applyCase(mapped, encoding.quality.casing));
    }
    if (encoding.batch.field !== 'omit')
        setPayloadPath(payload, encoding.batch.field, batchSize);
    return {
        payload,
        values: {
            aspectRatio,
            ...(resolution ? { resolution } : {}),
            ...(quality ? { quality } : {}),
            batchSize
        },
        contract
    };
};
