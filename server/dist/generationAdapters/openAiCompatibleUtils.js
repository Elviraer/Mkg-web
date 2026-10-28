import { isGptImageModel } from '@ftv/shared';
import { asUniqueList } from '../httpClient.js';
import { openAiEndpointUrl, trimTrailingSlash } from '../providers.js';
import { readField, readString } from '../unknownJson.js';
export const openAiCompatibleEndpointCandidates = (baseUrl, endpoint) => {
    const base = trimTrailingSlash(baseUrl.trim());
    return asUniqueList([
        openAiEndpointUrl(base, endpoint),
        `${base}/${endpoint}`,
        `${base}/v1beta/openai/${endpoint}`
    ]);
};
export const parseSizeFromRatio = (ratio) => {
    if (ratio === '1:1')
        return '1024x1024';
    if (ratio === '9:16' || ratio === '3:4')
        return '1024x1792';
    if (ratio === '16:9' || ratio === '4:3' || ratio === '21:9')
        return '1792x1024';
    return '1024x1024';
};
export { isGptImageModel } from '@ftv/shared';
export const shouldUseLegacyImageResponseFormat = (model) => !isGptImageModel(model);
export const extractUrlsFromGeneratedText = (value) => {
    const urls = [];
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
    return asUniqueList(urls);
};
const readNestedString = (data, key) => {
    const direct = readString(data, key);
    if (direct)
        return direct;
    const nestedData = readField(data, 'data');
    if (Array.isArray(nestedData)) {
        for (const item of nestedData) {
            const nested = readNestedString(item, key);
            if (nested)
                return nested;
        }
        return undefined;
    }
    if (nestedData && nestedData !== data) {
        return readNestedString(nestedData, key);
    }
    return undefined;
};
export const readGenerationTaskId = (data) => (readNestedString(data, 'id')
    ?? readNestedString(data, 'task_id')
    ?? readNestedString(data, 'taskId')
    ?? readNestedString(data, 'request_id'));
export const readGenerationStatus = (data) => (readNestedString(data, 'status')
    ?? readString(readField(data, 'result'), 'status'));
export const readGenerationFailureReason = (data) => (readNestedString(data, 'fail_reason')
    ?? readNestedString(data, 'failure_reason')
    ?? readNestedString(data, 'error_message')
    ?? readNestedString(data, 'message'));
export const isLocalReference = (value) => (value.startsWith('/api/')
    || /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//i.test(value));
export const isPublicHttpReference = (value) => (/^https?:\/\//i.test(value) && !isLocalReference(value));
export const assertNoUnsupportedLocalMediaReferences = (references) => {
    const localVideoCount = references.rawVideoRefs.filter(isLocalReference).length;
    const localAudioCount = references.rawAudioRefs.filter(isLocalReference).length;
    if (localVideoCount === 0 && localAudioCount === 0)
        return;
    const parts = [
        localVideoCount > 0 ? `${localVideoCount} 个本地视频参考` : '',
        localAudioCount > 0 ? `${localAudioCount} 个本地音频参考` : ''
    ].filter(Boolean).join('、');
    throw new Error(`参考素材准备失败：当前 OpenAI 兼容供应商没有通用文件上传协议，不能直接读取${parts}。请改用公网 URL，或选择支持本地上传的专用网关。`);
};
export const prepareOpenAiCompatibleImageReferences = async (references, options) => {
    if (references.rawImageRefs.length === 0 && references.imageRefs.length === 0)
        return [];
    const sourceCount = references.rawImageRefs.length > 0
        ? references.rawImageRefs.length
        : references.imageRefs.length;
    if (options.maxCount !== undefined && sourceCount > options.maxCount) {
        throw new Error(`参考图数量超过当前提供商限制：最多 ${options.maxCount} 张，实际 ${sourceCount} 张`);
    }
    if (references.rawImageRefs.length === 0)
        return references.imageRefs;
    const preparedReferences = (await Promise.all(references.rawImageRefs.map((ref) => references.toImageDataUrl(ref)))).filter((url) => Boolean(url));
    if (references.rawImageRefs.length > 0 && preparedReferences.length === 0) {
        throw new Error('参考图准备失败：未能读取本地参考图，请重新上传后再生成');
    }
    const encodedBytes = preparedReferences.reduce((total, value) => total + Buffer.byteLength(value), 0);
    if (encodedBytes > options.maxEncodedBytes) {
        throw new Error(`参考图编码后总大小超过本机上限：最多 ${Math.floor(options.maxEncodedBytes / 1024 / 1024)} MiB；可改用公网 URL 或减少本地参考图数量`);
    }
    return preparedReferences;
};
export const toTextReferenceNote = (kind, index, url) => {
    const label = kind === 'video' ? '视频' : '音频';
    return `${label}参考${index + 1}: ${url}`;
};
