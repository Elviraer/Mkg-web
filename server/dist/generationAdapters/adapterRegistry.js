import { submitApimartGeneration, queryApimartGenerationStatus } from './apimartAdapter.js';
import { cancelDoubaoGeneration, submitDoubaoGeneration, queryDoubaoGenerationStatus } from './doubaoAdapter.js';
import { submitDolaGeneration, queryDolaGenerationStatus } from './dolaAdapter.js';
import { submitOpenAiCompatibleGeneration, queryOpenAiCompatibleGenerationStatus } from './openAiCompatibleAdapter.js';
import { resolveProviderProtocol } from './providerCapabilities.js';
import { submitXyqGeneration, queryXyqGenerationStatus } from './xyqAdapter.js';
import { submitZhenzhenGeneration, queryZhenzhenGenerationStatus } from './zhenzhenAdapter.js';
import { submitComfyUiGeneration, queryComfyUiGenerationStatus } from './comfyUiAdapter.js';
import { submitRunningHubGeneration, queryRunningHubGenerationStatus } from './runningHubAdapter.js';
import { cancelConfiguredMediaGeneration, submitConfiguredMediaGeneration, queryConfiguredMediaGenerationStatus } from './configuredMediaAdapter.js';
const adapters = {
    'openai-compatible': {
        protocol: 'openai-compatible',
        submit: submitOpenAiCompatibleGeneration,
        queryStatus: queryOpenAiCompatibleGenerationStatus
    },
    apimart: {
        protocol: 'apimart',
        submit: submitApimartGeneration,
        queryStatus: queryApimartGenerationStatus
    },
    zhenzhen: {
        protocol: 'zhenzhen',
        submit: submitZhenzhenGeneration,
        queryStatus: queryZhenzhenGenerationStatus
    },
    'doubao-gateway': {
        protocol: 'doubao-gateway',
        submit: submitDoubaoGeneration,
        queryStatus: queryDoubaoGenerationStatus,
        cancel: cancelDoubaoGeneration
    },
    'dola-gateway': {
        protocol: 'dola-gateway',
        submit: submitDolaGeneration,
        queryStatus: queryDolaGenerationStatus
    },
    'xyq-gateway': {
        protocol: 'xyq-gateway',
        submit: submitXyqGeneration,
        queryStatus: queryXyqGenerationStatus
    },
    comfyui: {
        protocol: 'comfyui',
        submit: submitComfyUiGeneration,
        queryStatus: queryComfyUiGenerationStatus
    },
    runninghub: {
        protocol: 'runninghub',
        submit: submitRunningHubGeneration,
        queryStatus: queryRunningHubGenerationStatus
    }
};
export const resolveGenerationAdapterProtocol = (context) => {
    const resolved = resolveProviderProtocol({
        providerId: context.providerId,
        providerName: context.providerName,
        provider: context.provider,
        baseUrl: context.effectiveBaseUrl ?? context.baseUrl
    });
    return context.providerProtocol && context.providerProtocol !== 'openai-compatible'
        ? context.providerProtocol
        : resolved;
};
export const getGenerationAdapter = (context) => ((() => {
    const resolvedProtocol = resolveGenerationAdapterProtocol(context);
    const canUseConfiguredContract = Boolean(context.mediaContracts
        && context.kind
        && (context.kind === 'image' || context.kind === 'video' || context.kind === 'audio')
        && context.mediaContracts[context.kind]
        && resolvedProtocol === 'openai-compatible');
    return canUseConfiguredContract
        ? { protocol: 'openai-compatible', submit: submitConfiguredMediaGeneration, queryStatus: queryConfiguredMediaGenerationStatus, cancel: cancelConfiguredMediaGeneration }
        : context.kind === 'audio' ? adapters['openai-compatible'] : adapters[resolvedProtocol];
})());
