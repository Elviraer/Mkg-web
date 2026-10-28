const profiles = {
    'openai-standard': {
        id: 'openai-standard',
        textEndpoint: 'chat/completions',
        textEndpointStyle: 'candidates',
        textTimeoutMs: 60000,
        multimodalTextTimeoutMs: 60000,
        mediaParameterStyle: 'openai-size',
        videoStatusStyle: 'candidates',
        authorization: { header: 'Authorization', prefix: 'Bearer ' },
        videoGenerationEndpoint: 'videos/generations',
        maxEncodedReferenceBytes: 20 * 1024 * 1024
    },
    grok2api: {
        id: 'grok2api',
        textEndpoint: 'chat/completions',
        textEndpointStyle: 'canonical',
        textTimeoutMs: 60000,
        multimodalTextTimeoutMs: 240000,
        mediaParameterStyle: 'grok-native',
        videoStatusStyle: 'grok-video',
        authorization: { header: 'Authorization', prefix: 'Bearer ' },
        videoGenerationEndpoint: 'videos/generations',
        idempotencyHeader: 'Idempotency-Key',
        requestIdHeader: 'X-Request-ID',
        maxEncodedReferenceBytes: 28 * 1024 * 1024,
        imageResolutions: ['1K', '2K']
    }
};
export const normalizeProviderProfile = (value) => (value === 'grok2api' ? 'grok2api' : 'openai-standard');
export const getOpenAiProviderProfile = (profile) => (profiles[normalizeProviderProfile(profile)]);
export const normalizeProviderAuthMode = (value) => (value === 'x-api-key' || value === 'api-key' || value === 'none' ? value : 'bearer');
export const applyProviderAuthorization = (headers, apiKey, authMode, profile) => {
    if (!apiKey || normalizeProviderAuthMode(authMode) === 'none')
        return headers;
    const mode = normalizeProviderAuthMode(authMode);
    if (mode === 'x-api-key')
        headers['x-api-key'] = apiKey;
    else if (mode === 'api-key')
        headers['api-key'] = apiKey;
    else
        headers[profile.authorization.header] = `${profile.authorization.prefix}${apiKey}`;
    return headers;
};
