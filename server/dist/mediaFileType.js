import fs from 'node:fs';
import path from 'node:path';
import { fileTypeFromBuffer, fileTypeFromFile } from 'file-type';
const supportedTypes = new Map([
    ['jpg', { kind: 'image', mime: 'image/jpeg', extension: '.jpg' }],
    ['png', { kind: 'image', mime: 'image/png', extension: '.png' }],
    ['gif', { kind: 'image', mime: 'image/gif', extension: '.gif' }],
    ['webp', { kind: 'image', mime: 'image/webp', extension: '.webp' }],
    ['avif', { kind: 'image', mime: 'image/avif', extension: '.avif' }],
    ['bmp', { kind: 'image', mime: 'image/bmp', extension: '.bmp' }],
    ['tif', { kind: 'image', mime: 'image/tiff', extension: '.tiff' }],
    ['tiff', { kind: 'image', mime: 'image/tiff', extension: '.tiff' }],
    ['mp4', { kind: 'video', mime: 'video/mp4', extension: '.mp4' }],
    ['m4v', { kind: 'video', mime: 'video/x-m4v', extension: '.m4v' }],
    ['mov', { kind: 'video', mime: 'video/quicktime', extension: '.mov' }],
    ['webm', { kind: 'video', mime: 'video/webm', extension: '.webm' }],
    ['avi', { kind: 'video', mime: 'video/x-msvideo', extension: '.avi' }],
    ['mkv', { kind: 'video', mime: 'video/x-matroska', extension: '.mkv' }],
    ['mpg', { kind: 'video', mime: 'video/mpeg', extension: '.mpg' }],
    ['mp3', { kind: 'audio', mime: 'audio/mpeg', extension: '.mp3' }],
    ['wav', { kind: 'audio', mime: 'audio/wav', extension: '.wav' }],
    ['flac', { kind: 'audio', mime: 'audio/flac', extension: '.flac' }],
    ['aac', { kind: 'audio', mime: 'audio/aac', extension: '.aac' }],
    ['m4a', { kind: 'audio', mime: 'audio/mp4', extension: '.m4a' }],
    ['oga', { kind: 'audio', mime: 'audio/ogg', extension: '.oga' }],
    ['ogg', { kind: 'audio', mime: 'audio/ogg', extension: '.ogg' }]
]);
const supportedMimeAliases = new Map([
    ['m4a', new Set(['audio/x-m4a'])]
]);
/**
 * Formats the content sniffer recognises but MK does not import. Naming them turns a generic
 * "文件内容不是受支持的图片、视频或音频" rejection into an actionable message (HEIC is the default
 * iPhone camera format, so this is a very common import attempt).
 */
const recognizedUnsupportedFormats = new Map([
    ['heic', 'HEIC/HEIF（iPhone 默认图片格式）'],
    ['heif', 'HEIC/HEIF（iPhone 默认图片格式）'],
    ['jxl', 'JPEG XL']
]);
const normalizeDetectedType = (detected) => {
    if (!detected)
        return null;
    const extension = detected.ext.toLowerCase();
    const mime = detected.mime.toLowerCase();
    const supported = supportedTypes.get(extension);
    const mimeMatches = supported?.mime === mime || supportedMimeAliases.get(extension)?.has(mime);
    return supported && mimeMatches ? supported : null;
};
export const detectMediaBuffer = async (buffer) => {
    try {
        return normalizeDetectedType(await fileTypeFromBuffer(buffer));
    }
    catch {
        return null;
    }
};
export const detectMediaFile = async (filePath) => {
    try {
        return normalizeDetectedType(await fileTypeFromFile(filePath));
    }
    catch {
        return null;
    }
};
/**
 * Actionable reason for a rejected import, or `undefined` when the content is simply unknown.
 * Call it only after {@link detectMediaFile} returned `null`.
 */
export const describeUnsupportedMediaFile = async (filePath) => {
    try {
        const detected = await fileTypeFromFile(filePath);
        const label = detected ? recognizedUnsupportedFormats.get(detected.ext.toLowerCase()) : undefined;
        return label ? `暂不支持 ${label}，请先转换为 JPEG 或 PNG 后重新导入` : undefined;
    }
    catch {
        return undefined;
    }
};
export const applyCanonicalMediaExtension = async (file, detected) => {
    const nextFilename = `${path.parse(file.filename).name}${detected.extension}`;
    const nextPath = path.join(path.dirname(file.path), nextFilename);
    if (path.resolve(nextPath) !== path.resolve(file.path)) {
        await fs.promises.rename(file.path, nextPath);
    }
    return { filename: nextFilename, path: nextPath };
};
