import { OutboundUrlPolicyError, validateOutboundUrl, } from './outboundHttp.js';
export const providers = [
    {
        id: 'apimart',
        name: 'APIMART',
        baseUrl: 'https://api.apimart.ai/v1',
        apiKeyLabel: 'API Key',
        testStatus: 'OpenAI 兼容接口，可直接测试连接',
        docsUrl: 'https://apimart.ai',
        kind: 'openai-compatible',
        apiKeyEnv: 'APIMART_API_KEY'
    },
    {
        id: 'zhenzhen',
        name: 'zhenzhen',
        baseUrl: 'https://ai.t8star.org',
        apiKeyLabel: 'API Key',
        testStatus: 'zhenzhen OpenAI 兼容接口，可直接测试连接',
        docsUrl: 'https://ai.t8star.org',
        kind: 'openai-compatible',
        apiKeyEnv: 'OPENAI_COMPAT_API_KEY'
    },
    {
        id: 'custom',
        name: '贞贞平价小屋',
        baseUrl: 'https://api.seedance.nz',
        apiKeyLabel: 'API Key',
        testStatus: '贞贞平价小屋 OpenAI 兼容接口，可直接测试连接',
        docsUrl: 'https://api.seedance.nz',
        kind: 'openai-compatible',
        apiKeyEnv: 'OPENAI_COMPAT_API_KEY'
    },
    {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeyLabel: 'API Key',
        testStatus: 'DeepSeek OpenAI 兼容接口，可直接测试连接',
        docsUrl: 'https://platform.deepseek.com/api-docs',
        kind: 'openai-compatible',
        apiKeyEnv: 'DEEPSEEK_API_KEY'
    },
    {
        id: 'doubao',
        name: '豆包 Studio 网关',
        baseUrl: process.env.DOUBAO_GATEWAY_URL ?? 'http://localhost:3003',
        apiKeyLabel: '无需 API Key',
        testStatus: '通过本地豆包网关真实同步账号和任务',
        docsUrl: process.env.DOUBAO_GATEWAY_URL ?? 'http://localhost:3003',
        kind: 'doubao-gateway'
    },
    {
        id: 'dola',
        name: 'Dola Studio 网关',
        baseUrl: process.env.DOLA_GATEWAY_URL ?? 'http://localhost:3005',
        apiKeyLabel: '无需 API Key',
        testStatus: '通过本地 Dola Studio 网关真实同步账号和任务',
        docsUrl: process.env.DOLA_GATEWAY_URL ?? 'http://localhost:3005',
        kind: 'dola-gateway'
    },
    {
        id: 'xyq',
        name: '小云雀网关',
        baseUrl: process.env.XYQ_GATEWAY_URL ?? 'http://localhost:3000',
        apiKeyLabel: 'Bearer Token',
        testStatus: '通过小云雀网关真实同步账号、模型和任务',
        docsUrl: process.env.XYQ_GATEWAY_URL ?? 'http://localhost:3000',
        kind: 'xyq-gateway',
        apiKeyEnv: 'XYQ_API_KEY'
    }
];
export const APIMART_MODELS = [
    'gpt-image-2-official',
    'seedream-5.0-pro',
    'doubao-seedance-2.0',
    'doubao-seedance-2.0-fast',
    'doubao-seedance-2.0-mini'
];
export const DEEPSEEK_MODELS = ['deepseek-chat', 'deepseek-reasoner'];
export const OPENAI_IMAGE_MODELS = ['gpt-image-1', 'gpt-image-2-official', 'dall-e-3', 'dall-e-2'];
export const DOUBAO_MODELS = [
    'seedance_v2.0',
    'seedance_v2.0_mini',
    'seedance_v2.0_std',
    'seedance_v2.5',
    'Seedream 5.0 Lite',
    'Seedream 4.5',
    'Seedream 4.0'
];
export const DOLA_MODELS = [
    'seedance_v2.0',
    'seedance_v2.5',
    'Seedream 5.0 Pro',
    'Seedream 5.0 Lite',
    'Seedream 4.5',
    'Seedream 4.0'
];
export const XYQ_FALLBACK_MODELS = [
    'xyq-image-1',
    'Seedream 5.0',
    'Seedream 4.5',
    'Seedream 4.3',
    'Seedream 4.1',
    'Seedream 4.0',
    'Nano Banana Pro',
    'GPT Image 2',
    'xyq-video-1',
    'Seedance 2.0 Fast',
    'Seedance 2.0 Mini',
    'Seedance 2.0'
];
export const trimTrailingSlash = (value) => value.replace(/\/+$/, '');
export const resolveProvider = (id) => {
    return providers.find((item) => item.id === id);
};
export const resolveApiKey = (provider, supplied) => {
    if (supplied)
        return supplied;
    if (provider?.apiKeyEnv)
        return process.env[provider.apiKeyEnv] ?? '';
    return '';
};
export class ProviderRequestConfigError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ProviderRequestConfigError';
        this.code = code;
    }
}
const normalizeBaseUrl = (value) => trimTrailingSlash(new URL(value).href);
export const resolveProviderRequestConfig = ({ providerId, suppliedBaseUrl, suppliedApiKey, outboundPolicy, }) => {
    const provider = resolveProvider(providerId);
    if (provider) {
        if (suppliedBaseUrl?.trim()) {
            let matchesConfiguredUrl = false;
            try {
                matchesConfiguredUrl = normalizeBaseUrl(suppliedBaseUrl) === normalizeBaseUrl(provider.baseUrl);
            }
            catch {
                matchesConfiguredUrl = false;
            }
            if (!matchesConfiguredUrl) {
                throw new ProviderRequestConfigError('provider_base_url_override', `内置 Provider ${provider.name} 不允许覆盖 BaseURL`);
            }
        }
        return {
            provider,
            effectiveBaseUrl: provider.baseUrl,
            effectiveApiKey: resolveApiKey(provider, suppliedApiKey),
        };
    }
    const effectiveBaseUrl = suppliedBaseUrl?.trim();
    if (!effectiveBaseUrl) {
        throw new ProviderRequestConfigError('provider_base_url_required', '自定义 Provider 缺少 BaseURL');
    }
    try {
        let parsedBaseUrl;
        try {
            parsedBaseUrl = new URL(effectiveBaseUrl);
        }
        catch {
            throw new ProviderRequestConfigError('provider_base_url_not_allowed', 'Provider BaseURL 格式无效');
        }
        if (parsedBaseUrl.search || parsedBaseUrl.hash) {
            throw new ProviderRequestConfigError('provider_base_url_not_allowed', 'Provider BaseURL 不能包含查询参数或 hash；请只填写协议、主机、端口和路径');
        }
        validateOutboundUrl(effectiveBaseUrl, createProviderOutboundPolicy(undefined, effectiveBaseUrl, outboundPolicy));
    }
    catch (error) {
        if (error instanceof ProviderRequestConfigError)
            throw error;
        if (error instanceof OutboundUrlPolicyError) {
            throw new ProviderRequestConfigError('provider_base_url_not_allowed', error.message);
        }
        throw error;
    }
    return {
        provider: undefined,
        effectiveBaseUrl,
        effectiveApiKey: suppliedApiKey?.trim() ?? '',
    };
};
export const createProviderOutboundPolicy = (provider, baseUrl, overrides = {}) => {
    const origins = [baseUrl, ...(overrides.trustedOrigins ?? [])].flatMap((value) => {
        try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:' ? [url.origin] : [];
        }
        catch {
            return [];
        }
    });
    if (provider?.id === 'doubao')
        origins.push('http://localhost:3000', 'http://localhost:3003');
    if (provider?.id === 'dola')
        origins.push('http://localhost:3005');
    if (provider?.id === 'xyq')
        origins.push('http://localhost:3000');
    return {
        trustedOrigins: origins,
        ...(overrides.allowedPorts ? { allowedPorts: overrides.allowedPorts } : {})
    };
};
export const openAiModelsUrls = (baseUrl) => {
    const base = trimTrailingSlash(baseUrl.trim());
    if (!base)
        return [];
    if (base.endsWith('/models'))
        return [base];
    if (base.endsWith('/v1'))
        return [`${base}/models`];
    return [`${base}/v1/models`, `${base}/models`];
};
export const openAiEndpointUrl = (baseUrl, endpoint) => {
    const base = trimTrailingSlash(baseUrl.trim());
    if (base.endsWith('/v1'))
        return `${base}/${endpoint}`;
    return `${base}/v1/${endpoint}`;
};
