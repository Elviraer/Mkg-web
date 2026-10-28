import { Router } from 'express';
import { extractOpenAiModelIds } from '../generationParsers.js';
import { firstHealthyGateway } from '../gatewayClient.js';
import { asUniqueList, fetchJson } from '../httpClient.js';
import { outboundFetch } from '../outboundHttp.js';
import { extractDolaAccounts, extractDoubaoAccounts, extractXyqAccounts } from '../providerParsers.js';
import { APIMART_MODELS, DEEPSEEK_MODELS, DOUBAO_MODELS, DOLA_MODELS, OPENAI_IMAGE_MODELS, XYQ_FALLBACK_MODELS, openAiModelsUrls, providers, createProviderOutboundPolicy, ProviderRequestConfigError, resolveProvider, resolveProviderRequestConfig, trimTrailingSlash } from '../providers.js';
import { getErrorMessage, readErrorMessage, readString } from '../unknownJson.js';
import { applyProviderAuthorization, getOpenAiProviderProfile } from '../generationAdapters/openAiProviderProfiles.js';
const providerRequestHeaders = (body, apiKey) => {
    const headers = {};
    return applyProviderAuthorization(headers, apiKey, body.authMode, getOpenAiProviderProfile('openai-standard'));
};
const providerModelsTimeout = (provider) => (provider?.id === 'apimart' ? 30000 : 8000);
const isAbortError = (error) => error instanceof Error && error.name === 'AbortError';
const resolveRequestConfig = (body, response) => {
    try {
        return resolveProviderRequestConfig({
            providerId: body.id,
            suppliedBaseUrl: body.baseUrl,
            suppliedApiKey: body.apiKey,
            outboundPolicy: { trustedOrigins: body.outboundAllowedOrigins, allowedPorts: body.outboundAllowedPorts },
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
export const createProviderRoutes = () => {
    const router = Router();
    router.get('/doubao/accounts', async (_req, res) => {
        const provider = resolveProvider('doubao');
        const baseUrl = provider?.baseUrl ?? 'http://localhost:3003';
        try {
            const response = await outboundFetch(`${trimTrailingSlash(baseUrl)}/api/accounts`, {}, createProviderOutboundPolicy(provider, baseUrl));
            if (!response.ok) {
                throw new Error(`Upstream returned status ${response.status}`);
            }
            const data = await response.json();
            const accounts = extractDoubaoAccounts(data);
            res.json({ success: true, accounts });
        }
        catch (err) {
            const message = getErrorMessage(err);
            console.error('Failed to fetch Doubao accounts from gateway:', message);
            res.json({
                success: false,
                message,
                accounts: []
            });
        }
    });
    router.get('/dola/accounts', async (_req, res) => {
        const provider = resolveProvider('dola');
        const baseUrl = provider?.baseUrl ?? 'http://localhost:3005';
        try {
            const response = await outboundFetch(`${trimTrailingSlash(baseUrl)}/api/accounts`, {}, createProviderOutboundPolicy(provider, baseUrl));
            if (!response.ok)
                throw new Error(`Upstream returned status ${response.status}`);
            const data = await response.json();
            res.json({ success: true, accounts: extractDolaAccounts(data) });
        }
        catch (err) {
            const message = getErrorMessage(err);
            console.error('Failed to fetch Dola accounts from gateway:', message);
            res.json({ success: false, message, accounts: [] });
        }
    });
    router.get('/xyq/accounts', async (_req, res) => {
        const provider = resolveProvider('xyq');
        const baseUrl = provider?.baseUrl ?? 'http://localhost:3000';
        try {
            const headers = {};
            if (process.env.XYQ_ADMIN_API_KEY) {
                headers['x-admin-api-key'] = process.env.XYQ_ADMIN_API_KEY;
            }
            const response = await outboundFetch(`${trimTrailingSlash(baseUrl)}/v1/accounts`, { headers }, createProviderOutboundPolicy(provider, baseUrl));
            if (!response.ok) {
                throw new Error(`Upstream returned status ${response.status}`);
            }
            const data = await response.json();
            const accounts = extractXyqAccounts(data);
            res.json({ success: true, accounts });
        }
        catch (err) {
            const message = getErrorMessage(err);
            console.error('Failed to fetch XYQ accounts from gateway:', message);
            res.json({
                success: false,
                message,
                accounts: []
            });
        }
    });
    router.get('/', (_request, response) => {
        const items = providers.map((provider) => {
            if (provider.id === 'apimart') {
                return { ...provider, models: APIMART_MODELS, enabledModels: APIMART_MODELS };
            }
            if (provider.id === 'deepseek') {
                return { ...provider, models: DEEPSEEK_MODELS, enabledModels: DEEPSEEK_MODELS };
            }
            if (provider.id === 'doubao') {
                return { ...provider, models: DOUBAO_MODELS, enabledModels: DOUBAO_MODELS };
            }
            if (provider.id === 'dola') {
                return { ...provider, models: DOLA_MODELS, enabledModels: DOLA_MODELS };
            }
            if (provider.id === 'xyq') {
                return { ...provider, models: XYQ_FALLBACK_MODELS, enabledModels: XYQ_FALLBACK_MODELS };
            }
            return provider;
        });
        response.json({ items });
    });
    router.post('/test', async (req, res) => {
        const body = req.body;
        const { id, name } = body;
        const config = resolveRequestConfig(body, res);
        if (!config)
            return;
        const { provider, effectiveBaseUrl, effectiveApiKey } = config;
        const requestKind = body.kind ?? provider?.kind;
        try {
            if (requestKind === 'comfyui') {
                const headers = providerRequestHeaders(body, effectiveApiKey);
                const response = await outboundFetch(`${trimTrailingSlash(effectiveBaseUrl)}/system_stats`, { headers }, createProviderOutboundPolicy(provider, effectiveBaseUrl, { trustedOrigins: body.outboundAllowedOrigins, allowedPorts: body.outboundAllowedPorts }));
                if (!response.ok)
                    throw new Error(`ComfyUI 返回 HTTP ${response.status}`);
                res.json({ ok: true, message: `ComfyUI 连接成功 (${effectiveBaseUrl})` });
                return;
            }
            if (requestKind === 'runninghub') {
                const response = await outboundFetch(`${trimTrailingSlash(effectiveBaseUrl)}/uc/openapi/accountStatus`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${effectiveApiKey}` },
                    body: JSON.stringify({ apikey: effectiveApiKey })
                }, createProviderOutboundPolicy(provider, effectiveBaseUrl, { trustedOrigins: body.outboundAllowedOrigins, allowedPorts: body.outboundAllowedPorts }));
                const data = await response.json();
                if (!response.ok || data.code !== 0) {
                    res.status(response.status === 401 || response.status === 403 || data.code !== 0 ? 401 : 502).json({
                        ok: false,
                        message: data.message || data.msg || `RunningHub 连接失败: HTTP ${response.status}`
                    });
                    return;
                }
                res.json({ ok: true, message: `RunningHub 连接与 API Key 验证成功 (${effectiveBaseUrl})` });
                return;
            }
            if (provider?.kind === 'doubao-gateway') {
                const { baseUrl: healthyBaseUrl, data } = await firstHealthyGateway(provider.id, effectiveBaseUrl, '/api/health');
                const status = readString(data, 'status') ?? 'ok';
                res.json({
                    ok: true,
                    message: `豆包网关连接成功 (${healthyBaseUrl}, ${status})`
                });
                return;
            }
            if (provider?.kind === 'xyq-gateway') {
                const headers = {};
                if (effectiveApiKey)
                    headers.Authorization = `Bearer ${effectiveApiKey}`;
                const { baseUrl: healthyBaseUrl } = await firstHealthyGateway(provider.id, effectiveBaseUrl, '/healthz', { headers });
                res.json({
                    ok: true,
                    message: `小云雀网关连接成功 (${healthyBaseUrl})`
                });
                return;
            }
            const headers = providerRequestHeaders(body, effectiveApiKey);
            const urls = openAiModelsUrls(effectiveBaseUrl);
            const outboundPolicy = createProviderOutboundPolicy(provider, effectiveBaseUrl);
            let lastStatus = 0;
            let lastMessage = '';
            for (const url of urls) {
                const { response, data } = await fetchJson(url, { headers }, providerModelsTimeout(provider), outboundPolicy);
                lastStatus = response.status;
                if (response.ok) {
                    const models = extractOpenAiModelIds(data);
                    res.json({
                        ok: true,
                        message: `${name || provider?.name || 'Provider'} 接口连接成功${models.length > 0 ? `，读取到 ${models.length} 个模型` : ''}`
                    });
                    return;
                }
                lastMessage = readErrorMessage(data, `HTTP ${response.status}`);
                if (response.status === 401 || response.status === 403)
                    break;
            }
            res.status(lastStatus === 401 || lastStatus === 403 ? 401 : 502).json({
                ok: false,
                message: lastStatus === 401 || lastStatus === 403
                    ? `网络已连通，但鉴权失败 (${lastStatus})，请检查 API Key`
                    : `连接失败: ${lastMessage || `HTTP ${lastStatus}`}`
            });
        }
        catch (err) {
            res.status(isAbortError(err) ? 504 : 500).json({
                ok: false,
                message: isAbortError(err)
                    ? `${name || provider?.name || 'Provider'} 连接超时，请检查服务是否已启动及网络或代理配置`
                    : `连接失败: ${getErrorMessage(err)}`
            });
        }
    });
    router.post('/fetch-models', async (req, res) => {
        const body = req.body;
        const { id, name } = body;
        const config = resolveRequestConfig(body, res);
        if (!config)
            return;
        const { provider, effectiveBaseUrl, effectiveApiKey } = config;
        const requestKind = body.kind ?? provider?.kind;
        try {
            if (requestKind === 'comfyui' || requestKind === 'runninghub') {
                res.status(400).json({ ok: false, models: [], message: '工作流平台不提供 OpenAI 模型目录，请在工作流设置中添加工作流' });
                return;
            }
            if (provider?.kind === 'doubao-gateway') {
                let note = '已使用豆包网关实时模型目录';
                try {
                    const { baseUrl: healthyBaseUrl } = await firstHealthyGateway(provider.id, effectiveBaseUrl, '/api/health');
                    const { response, data } = await fetchJson(`${trimTrailingSlash(healthyBaseUrl)}/v1/models`, {}, 8000, createProviderOutboundPolicy(provider, healthyBaseUrl));
                    if (!response.ok)
                        throw new Error(readErrorMessage(data, `HTTP ${response.status}`));
                    const models = extractOpenAiModelIds(data);
                    if (models.length === 0)
                        throw new Error('模型目录为空');
                    res.json({ ok: true, models, note: `${note}；网关在线: ${healthyBaseUrl}` });
                    return;
                }
                catch (err) {
                    note = `豆包网关模型目录暂不可用，已使用内置保底目录：${getErrorMessage(err)}`;
                }
                res.json({ ok: true, models: DOUBAO_MODELS, note });
                return;
            }
            if (provider?.id === 'dola') {
                let note = 'Dola 网关无标准模型接口，已使用 Dola Studio 文档声明的真实支持模型';
                try {
                    const { baseUrl: healthyBaseUrl } = await firstHealthyGateway(provider.id, effectiveBaseUrl, '/api/health');
                    note = `${note}；网关在线: ${healthyBaseUrl}`;
                }
                catch (err) {
                    note = `${note}；网关暂未连通: ${getErrorMessage(err)}`;
                }
                res.json({ ok: true, models: DOLA_MODELS, note });
                return;
            }
            const headers = providerRequestHeaders(body, effectiveApiKey);
            const outboundPolicy = createProviderOutboundPolicy(provider, effectiveBaseUrl);
            if (provider?.kind === 'xyq-gateway') {
                const { response, data } = await fetchJson(`${trimTrailingSlash(effectiveBaseUrl)}/v1/models`, { headers }, 8000, outboundPolicy);
                if (!response.ok)
                    throw new Error(readErrorMessage(data, `HTTP ${response.status}`));
                const models = extractOpenAiModelIds(data);
                res.json({ ok: true, models: models.length > 0 ? models : XYQ_FALLBACK_MODELS });
                return;
            }
            const urls = openAiModelsUrls(effectiveBaseUrl);
            let lastError = '';
            for (const url of urls) {
                const { response, data } = await fetchJson(url, { headers }, providerModelsTimeout(provider), outboundPolicy);
                if (response.ok) {
                    const fetched = extractOpenAiModelIds(data);
                    if (fetched.length > 0) {
                        res.json({ ok: true, models: asUniqueList(fetched) });
                        return;
                    }
                    lastError = '未返回有效的 OpenAI 标准模型格式';
                }
                else {
                    lastError = readErrorMessage(data, `HTTP ${response.status}`);
                    if (response.status === 401 || response.status === 403)
                        break;
                }
            }
            throw new Error(lastError || `无法从 ${name || provider?.name || 'provider'} 获取模型`);
        }
        catch (err) {
            const fallback = provider?.kind === 'dola-gateway'
                ? DOLA_MODELS
                : provider?.kind === 'xyq-gateway'
                    ? XYQ_FALLBACK_MODELS
                    : provider?.id === 'apimart'
                        ? APIMART_MODELS
                        : provider?.id === 'deepseek'
                            ? DEEPSEEK_MODELS
                            : provider?.kind === 'openai-compatible'
                                ? OPENAI_IMAGE_MODELS
                                : [];
            if (fallback.length > 0) {
                res.json({
                    ok: true,
                    models: fallback,
                    message: `获取模型失败: ${getErrorMessage(err)}`,
                    note: '已返回保底模型，建议修正凭证后重新拉取'
                });
                return;
            }
            res.status(500).json({ ok: false, message: `获取模型失败: ${getErrorMessage(err)}` });
        }
    });
    return router;
};
