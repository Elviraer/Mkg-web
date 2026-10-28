import { asUniqueList, fetchJson } from './httpClient.js';
import { createProviderOutboundPolicy, resolveProvider, trimTrailingSlash } from './providers.js';
export const localGatewayCandidates = (providerId, baseUrl) => {
    const candidates = [trimTrailingSlash(baseUrl)];
    if (providerId === 'doubao') {
        candidates.push('http://localhost:3000', 'http://localhost:3003');
    }
    if (providerId === 'xyq') {
        candidates.push('http://localhost:3000');
    }
    return asUniqueList(candidates);
};
export const firstHealthyGateway = async (providerId, baseUrl, healthPath, init = {}) => {
    let lastError = '';
    const provider = resolveProvider(providerId);
    for (const candidate of localGatewayCandidates(providerId, baseUrl)) {
        try {
            const { response, data } = await fetchJson(`${candidate}${healthPath}`, init, 5000, createProviderOutboundPolicy(provider, candidate));
            if (response.ok)
                return { baseUrl: candidate, data };
            lastError = `${candidate}${healthPath} -> HTTP ${response.status}`;
        }
        catch (err) {
            lastError = `${candidate}${healthPath} -> ${err instanceof Error ? err.message : 'Unknown error'}`;
        }
    }
    throw new Error(lastError || 'gateway health check failed');
};
