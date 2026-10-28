import { inferProviderImageTransportProfile, normalizeProviderImageTransportProfile } from '@mkg/shared';
const imageTransportContracts = {
    'openai-images': {
        id: 'openai-images',
        generationEndpoint: 'images/generations',
        referenceEndpoint: 'images/edits',
        referenceBody: 'multipart-files'
    },
    'json-image-edits': {
        id: 'json-image-edits',
        generationEndpoint: 'images/generations',
        referenceEndpoint: 'images/edits',
        referenceBody: 'json-image-values'
    },
    'grok2api-images': {
        id: 'grok2api-images',
        generationEndpoint: 'images/generations',
        referenceEndpoint: 'images/edits',
        referenceBody: 'json-image-objects'
    },
    'generation-reference-images': {
        id: 'generation-reference-images',
        generationEndpoint: 'images/generations',
        referenceEndpoint: 'images/generations',
        referenceBody: 'reference-images'
    },
    'generation-image-urls': {
        id: 'generation-image-urls',
        generationEndpoint: 'images/generations',
        referenceEndpoint: 'images/generations',
        referenceBody: 'image-url-values'
    },
    'generation-images-array': {
        id: 'generation-images-array',
        generationEndpoint: 'images/generations',
        referenceEndpoint: 'images/generations',
        referenceBody: 'images-array'
    },
    'generation-input-image': {
        id: 'generation-input-image',
        generationEndpoint: 'images/generations',
        referenceEndpoint: 'images/generations',
        referenceBody: 'input-image'
    }
};
const isGrokImagineImageModel = (model) => {
    const normalized = model.trim().toLowerCase();
    return normalized === 'grok-imagine'
        || normalized === 'grok-imagine-edit'
        || normalized.startsWith('grok-imagine-image');
};
export const resolveProviderImageTransportProfile = ({ providerTransport, modelTransport, providerProfile, providerId, providerName, baseUrl, model }) => {
    const explicitModel = normalizeProviderImageTransportProfile(modelTransport);
    if (explicitModel)
        return explicitModel;
    const inferredProviderProfile = inferProviderImageTransportProfile({
        value: providerTransport,
        providerProfile,
        id: providerId,
        name: providerName,
        baseUrl
    });
    if (inferredProviderProfile)
        return inferredProviderProfile;
    // Preserve the previously verified SUB2API/Grok route while new Provider records migrate
    // to an explicit image transport profile.
    if (isGrokImagineImageModel(model))
        return 'grok2api-images';
    return 'openai-images';
};
export const resolveProviderImageTransportContract = (input) => imageTransportContracts[resolveProviderImageTransportProfile(input)];
