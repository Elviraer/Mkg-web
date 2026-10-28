import { asUniqueList } from './httpClient.js';
const isRecord = (value) => (typeof value === 'object' && value !== null);
const readRecord = (value, key) => {
    if (!isRecord(value))
        return undefined;
    return value[key];
};
const readString = (value, key) => {
    const field = readRecord(value, key);
    return typeof field === 'string' ? field : undefined;
};
const readArray = (value, key) => {
    const field = readRecord(value, key);
    return Array.isArray(field) ? field : [];
};
export const extractOpenAiModelIds = (data) => {
    return readArray(data, 'data')
        .map((item) => {
        if (typeof item === 'string')
            return item;
        return readString(item, 'id') ?? '';
    })
        .filter((id) => id.length > 0);
};
export const extractImageUrls = (data) => {
    return readArray(data, 'data')
        .map((item) => {
        const url = readString(item, 'url');
        if (url)
            return url;
        const base64 = readString(item, 'b64_json');
        return base64 ? `data:image/png;base64,${base64}` : '';
    })
        .filter((url) => url.length > 0);
};
export const extractTaskOutputUrls = (data) => {
    return readArray(data, 'output')
        .map((item) => readString(item, 'url') ?? readString(item, 'cover_url') ?? '')
        .filter((url) => url.length > 0);
};
export const normalizeGenerationStatus = (value) => {
    const status = String(value ?? '').toLowerCase();
    if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(status))
        return 'completed';
    if (['failed', 'fail', 'error', 'errored', 'cancelled', 'canceled', 'rejected'].includes(status))
        return 'failed';
    if (['processing', 'running', 'in_progress', 'generating', 'executing'].includes(status))
        return 'processing';
    if (['timeout', 'timed_out', 'expired'].includes(status))
        return 'timeout';
    return 'queued';
};
/**
 * A returned value is only treated as a generation resource when it is unambiguously a media
 * location: an absolute http(s) URL, a same-origin controlled path, a blob URL, or a raster/video
 * base64 data URL. Bare filenames, `../` traversal, protocol-relative `//host` URLs, `file:` and
 * `ftp:` were previously accepted but can never be materialised into MK assets, so they now fail
 * closed instead of producing a broken preview that skips archiving.
 */
export const isGenerationPreviewResource = (value) => {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed))
        return true;
    if (trimmed.startsWith('//'))
        return false;
    if (trimmed.startsWith('/'))
        return true;
    if (/^blob:/i.test(trimmed))
        return true;
    return /^data:(?:image\/(?:png|jpe?g|webp|gif|bmp|avif)|video\/[a-z0-9.+-]+);base64,/i.test(trimmed);
};
/** `imageUrl` / `imageURL` / `IMAGE_URL` all normalise to `image_url`. */
const normalizeResourceKey = (key) => key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
/** Wrapper/array keys that contain generation resources rather than text. */
const resourceContainerKeys = new Set([
    'data', 'output', 'outputs', 'result', 'results',
    'images', 'image_urls', 'assets', 'medias', 'media',
    'videos', 'video_urls', 'audios', 'audio_urls',
    'urls', 'files', 'items',
    'response', 'payload', 'body', 'artifacts'
]);
const directResourceKeys = new Set([
    'url', 'cover_url', 'image_url', 'video_url', 'audio_url', 'watermark_free_url', 'fallback_url',
    'b64_json', 'image', 'video', 'audio'
]);
const embeddedUrlTextKeys = new Set([
    '',
    'content',
    'message',
    'output',
    'output_text',
    'response',
    'result',
    'text'
]);
const b64JsonKeys = new Set(['b64_json']);
export const extractGenerationUrls = (data, options = {}) => {
    const urls = [];
    const allowEmbeddedUrlText = options.allowEmbeddedUrlText ?? true;
    const restrictToResourceContainers = options.restrictToResourceContainers ?? false;
    const looksLikePreviewResource = (value) => {
        return isGenerationPreviewResource(value);
    };
    const pushUrlsFromString = (value) => {
        const patterns = [
            /!\[[^\]]*]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/gi,
            /\[[^\]]*]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/gi,
            /(https?:\/\/[^\s"'<>）)]+|data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+)/gi
        ];
        patterns.forEach((pattern) => {
            for (const match of value.matchAll(pattern)) {
                const url = match[1]?.trim();
                if (url)
                    urls.push(url);
            }
        });
    };
    const pushUrl = (value) => {
        if (typeof value !== 'string')
            return;
        const trimmed = value.trim();
        if (looksLikePreviewResource(trimmed))
            urls.push(trimmed);
    };
    const pushKnownUrlValue = (value) => {
        if (typeof value === 'string') {
            pushUrl(value);
            return;
        }
        if (!isRecord(value))
            return;
        pushUrl(value.url);
    };
    const pushBase64Value = (value) => {
        if (typeof value !== 'string' || value.length === 0)
            return;
        urls.push(`data:image/png;base64,${value}`);
    };
    const pushItem = (item) => {
        if (!isRecord(item))
            return;
        pushKnownUrlValue(item.url);
        pushKnownUrlValue(item.cover_url);
        pushKnownUrlValue(item.image_url);
        pushKnownUrlValue(item.video_url);
        pushKnownUrlValue(item.audio_url);
        pushKnownUrlValue(item.watermark_free_url);
        pushKnownUrlValue(item.fallback_url);
        pushKnownUrlValue(item.image);
        pushKnownUrlValue(item.video);
        pushKnownUrlValue(item.audio);
        pushBase64Value(item.b64_json);
    };
    const walk = (value, key = '') => {
        if (typeof value === 'string') {
            if (key === 'url'
                || key.endsWith('_url')
                || key === 'image'
                || key === 'video'
                || key === 'audio'
                || resourceContainerKeys.has(key)) {
                pushUrl(value);
            }
            else if (allowEmbeddedUrlText && embeddedUrlTextKeys.has(key)) {
                pushUrlsFromString(value);
            }
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((item) => {
                if (resourceContainerKeys.has(key) && typeof item === 'string')
                    pushUrl(item);
                else if (resourceContainerKeys.has(key))
                    pushItem(item);
                walk(item, key);
            });
            return;
        }
        if (!isRecord(value))
            return;
        Object.entries(value).forEach(([entryKey, entryValue]) => {
            const normalizedKey = normalizeResourceKey(entryKey);
            if (b64JsonKeys.has(normalizedKey))
                pushBase64Value(entryValue);
            if (!restrictToResourceContainers
                || resourceContainerKeys.has(normalizedKey)
                || directResourceKeys.has(normalizedKey)
                || normalizedKey.endsWith('_url')) {
                walk(entryValue, normalizedKey);
            }
        });
    };
    readArray(data, 'data').forEach((item) => typeof item === 'string' ? pushUrl(item) : pushItem(item));
    readArray(data, 'output').forEach((item) => typeof item === 'string' ? pushUrl(item) : pushItem(item));
    const result = readRecord(data, 'result');
    readArray(result, 'images').forEach((item) => typeof item === 'string' ? pushUrl(item) : pushItem(item));
    readArray(result, 'image_urls').forEach((item) => typeof item === 'string' ? pushUrl(item) : pushItem(item));
    readArray(result, 'assets').forEach((item) => typeof item === 'string' ? pushUrl(item) : pushItem(item));
    pushItem(result);
    pushItem(data);
    walk(data);
    return asUniqueList(urls);
};
export const extractTextContent = (data) => {
    const normalizeContent = (value) => {
        if (typeof value === 'string')
            return value;
        if (Array.isArray(value)) {
            return value
                .map((item) => {
                if (typeof item === 'string')
                    return item;
                return readString(item, 'text') ?? readString(item, 'content') ?? readString(item, 'value') ?? '';
            })
                .filter(Boolean)
                .join('');
        }
        return '';
    };
    const outputText = readString(data, 'output_text');
    if (outputText)
        return outputText;
    const text = readString(data, 'text');
    if (text)
        return text;
    const message = readString(data, 'message');
    if (message && readArray(data, 'choices').length === 0)
        return message;
    for (const choice of readArray(data, 'choices')) {
        const content = normalizeContent(readRecord(readRecord(choice, 'message'), 'content'))
            || normalizeContent(readRecord(readRecord(choice, 'delta'), 'content'))
            || normalizeContent(readRecord(choice, 'text'));
        if (content.trim())
            return content;
    }
    for (const item of readArray(data, 'output')) {
        const content = normalizeContent(readRecord(item, 'content')) || normalizeContent(readRecord(item, 'text'));
        if (content.trim())
            return content;
    }
    return '';
};
export const doubaoTaskAssetUrls = (baseUrl, taskId, data) => {
    const result = readRecord(data, 'result');
    if (!isRecord(result))
        return [];
    const imageCount = readArray(result, 'images').length;
    const hasSingleAsset = Boolean(readString(result, 'watermark_free_url')
        || readString(result, 'video_url')
        || readString(result, 'image_url'));
    const assetCount = Math.max(imageCount, hasSingleAsset ? 1 : 0);
    return Array.from({ length: assetCount }, (_, index) => (`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/assets/${index}`));
};
export const dolaTaskAssetUrls = (baseUrl, taskId, data) => {
    const result = readRecord(data, 'result');
    const direct = result ?? data;
    if (!isRecord(direct))
        return [];
    const images = readArray(direct, 'images');
    const assets = readArray(direct, 'assets');
    const hasSingleAsset = Boolean(readString(direct, 'image_url')
        || readString(direct, 'video_url')
        || readString(direct, 'watermark_free_url')
        || readString(direct, 'video_model'));
    const assetCount = Math.max(images.length, assets.length, hasSingleAsset ? 1 : 0);
    return Array.from({ length: assetCount }, (_, index) => (`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/assets/${index}`));
};
