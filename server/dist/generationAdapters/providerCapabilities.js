import { isGptImageModel, resolveProviderProtocol as resolveSharedProviderProtocol } from '@mkg/shared';
export const resolveProviderProtocol = ({ providerId, providerName, provider, baseUrl }) => resolveSharedProviderProtocol({
    id: providerId ?? provider?.id,
    name: providerName ?? provider?.name,
    baseUrl: baseUrl ?? provider?.baseUrl,
    kind: provider?.kind
});
export const getProviderCapabilities = (protocol) => {
    if (protocol === 'comfyui' || protocol === 'runninghub') {
        return {
            protocol,
            supports: {
                text: false,
                image: true,
                video: true,
                audio: false,
                imageUpload: true,
                localImageReference: true,
                localVideoReference: true,
                localAudioReference: true
            },
            image: { supportsQuality: () => false },
            video: { referenceShape: 'multipart', asyncStatusEndpoint: 'provider-specific' }
        };
    }
    if (protocol === 'apimart') {
        return {
            protocol,
            supports: {
                text: true,
                image: true,
                video: true,
                audio: true,
                imageUpload: true,
                localImageReference: true,
                localVideoReference: false,
                localAudioReference: false
            },
            image: {
                supportsQuality: isGptImageModel
            },
            video: {
                referenceField: 'image_urls',
                referenceShape: 'string-array',
                asyncStatusEndpoint: 'tasks'
            }
        };
    }
    if (protocol === 'zhenzhen') {
        return {
            protocol,
            supports: {
                text: true,
                image: true,
                video: true,
                audio: true,
                imageUpload: false,
                localImageReference: true,
                localVideoReference: false,
                localAudioReference: false
            },
            image: {
                supportsQuality: isGptImageModel
            },
            video: {
                referenceField: 'reference_images',
                referenceShape: 'data-url-array',
                asyncStatusEndpoint: 'openai-compatible'
            }
        };
    }
    if (protocol === 'doubao-gateway') {
        return {
            protocol,
            supports: {
                text: false,
                image: true,
                video: true,
                audio: false,
                imageUpload: true,
                localImageReference: true,
                localVideoReference: false,
                localAudioReference: false
            },
            image: {
                supportsQuality: () => false
            },
            video: {
                referenceShape: 'multipart',
                asyncStatusEndpoint: 'provider-specific'
            }
        };
    }
    if (protocol === 'dola-gateway') {
        return {
            protocol,
            supports: {
                text: false,
                image: true,
                video: true,
                audio: false,
                imageUpload: true,
                localImageReference: true,
                localVideoReference: false,
                localAudioReference: false
            },
            image: {
                supportsQuality: () => false
            },
            video: {
                referenceShape: 'multipart',
                asyncStatusEndpoint: 'provider-specific'
            }
        };
    }
    if (protocol === 'xyq-gateway') {
        return {
            protocol,
            supports: {
                text: false,
                image: true,
                video: true,
                audio: false,
                imageUpload: true,
                localImageReference: true,
                localVideoReference: false,
                localAudioReference: true
            },
            image: {
                supportsQuality: () => false
            },
            video: {
                referenceField: 'xyq_reference_images',
                referenceShape: 'object-url-array',
                asyncStatusEndpoint: 'provider-specific'
            }
        };
    }
    return {
        protocol: 'openai-compatible',
        supports: {
            text: true,
            image: true,
            video: true,
            audio: true,
            imageUpload: false,
            localImageReference: true,
            localVideoReference: false,
            localAudioReference: false
        },
        image: {
            supportsQuality: isGptImageModel
        },
        video: {
            referenceField: 'reference_images',
            referenceShape: 'data-url-array',
            asyncStatusEndpoint: 'openai-compatible'
        }
    };
};
export const getProviderCapabilitiesForContext = (context) => getProviderCapabilities(resolveProviderProtocol(context));
export const providerSupportsImageQuality = (context) => getProviderCapabilitiesForContext(context).image.supportsQuality(context.model);
