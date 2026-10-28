import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createMediaService } from '../mediaServices.js';
import { getErrorMessage, isRecord, readField, readNumber, readString } from '../unknownJson.js';
/**
 * A `<video>` element (or any client) routinely closes an in-flight media response: Chromium reads
 * the metadata from a range request and then aborts the socket, and every source switch or unmount
 * aborts again. `res.sendFile` reports that as an abort error, which must never be answered with a
 * new status line — doing so throws `ERR_HTTP_HEADERS_SENT` inside an async handler, and Node turns
 * that into an unhandled rejection that terminates the whole Server.
 */
const isClientAbortError = (error) => {
    const code = error?.code;
    if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
        return true;
    }
    return /aborted|premature close|socket hang up/i.test(getErrorMessage(error, ''));
};
const parseVideoSourceInput = (body) => {
    const fileName = readString(body, 'fileName')?.trim() ?? '';
    const sourceUrl = readString(body, 'sourceUrl')?.trim() ?? '';
    if ((!fileName && !sourceUrl) || (fileName && sourceUrl)) {
        return { ok: false, message: '缺少视频文件' };
    }
    return { ok: true, value: fileName ? { fileName } : { sourceUrl } };
};
const parseVideoCropRequest = (body) => {
    const source = parseVideoSourceInput(body);
    if (!source.ok)
        return source;
    const crop = readField(body, 'crop');
    if (!isRecord(crop)) {
        return { ok: false, message: '缺少视频裁剪参数' };
    }
    const sourceWidth = readNumber(crop, 'sourceWidth');
    const sourceHeight = readNumber(crop, 'sourceHeight');
    if (sourceWidth === undefined || sourceHeight === undefined || sourceWidth <= 0 || sourceHeight <= 0) {
        return { ok: false, message: '缺少视频裁剪参数' };
    }
    return {
        ok: true,
        value: {
            ...source.value,
            crop: {
                x: readNumber(crop, 'x') ?? 0,
                y: readNumber(crop, 'y') ?? 0,
                width: readNumber(crop, 'width') ?? 100,
                height: readNumber(crop, 'height') ?? 100,
                sourceWidth,
                sourceHeight
            }
        }
    };
};
const resolveControlledMediaSource = (sourceUrl, sources) => {
    // Only accept relative, same-origin application paths. In particular, reject
    // protocol-relative URLs (`//host/...`) before URL normalisation turns them
    // into an apparently valid `/api/...` pathname.
    if (!sourceUrl.startsWith('/') || sourceUrl.startsWith('//'))
        return null;
    let pathname;
    try {
        const parsed = new URL(sourceUrl, 'http://mk.local');
        if (parsed.origin !== 'http://mk.local')
            return null;
        pathname = decodeURIComponent(parsed.pathname);
    }
    catch {
        return null;
    }
    for (const source of sources) {
        const prefix = source.prefix.replace(/\/+$/, '');
        if (!pathname.startsWith(`${prefix}/`))
            continue;
        const relativePath = pathname.slice(prefix.length + 1);
        const rootPath = path.resolve(source.rootDir);
        const resolvedPath = path.resolve(rootPath, relativePath);
        if (!resolvedPath.startsWith(`${rootPath}${path.sep}`) || !fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile())
            continue;
        return { source, filePath: resolvedPath };
    }
    return null;
};
const isLocalControlledSourceUrl = (sourceUrl) => {
    if (!sourceUrl.startsWith('/') || sourceUrl.startsWith('//'))
        return false;
    try {
        return new URL(sourceUrl, 'http://mk.local').origin === 'http://mk.local';
    }
    catch {
        return false;
    }
};
const getIdentityThumbnailUrl = (sourceUrl) => {
    try {
        const parsed = new URL(sourceUrl, 'http://mk.local');
        const libraryMatch = parsed.pathname.match(/^\/api\/library-assets\/([^/]+)\/file$/);
        if (libraryMatch?.[1]) {
            const assetId = decodeURIComponent(libraryMatch[1]);
            return assetId ? `/api/library-assets/${encodeURIComponent(assetId)}/thumbnail` : null;
        }
        // Scoped History videos resolve through the same owned identity as their file route, so the
        // poster must carry the project/canvas scope the thumbnail endpoint requires.
        const historyMatch = parsed.pathname.match(/^\/api\/history-assets\/([^/]+)\/file$/);
        if (historyMatch?.[1]) {
            const assetId = decodeURIComponent(historyMatch[1]);
            if (!assetId)
                return null;
            const scope = new URLSearchParams(parsed.search);
            const query = scope.toString();
            return `/api/history-assets/${encodeURIComponent(assetId)}/thumbnail${query ? `?${query}` : ''}`;
        }
        return null;
    }
    catch {
        return null;
    }
};
export const createMediaRoutes = ({ uploadsDir, videoPosterSources = [], imageThumbnailSources = [], resolveLinkedSource, playbackCacheDir, mediaService: providedMediaService }) => {
    const router = Router();
    const mediaService = providedMediaService ?? createMediaService({
        uploadsDir,
        ...(playbackCacheDir ? { playbackCacheDir } : {})
    });
    const resolveRegisteredSource = (sourceUrl) => (isLocalControlledSourceUrl(sourceUrl) ? resolveLinkedSource?.(sourceUrl) ?? null : null);
    const resolveVideoSource = (source) => {
        try {
            if (source.fileName)
                return mediaService.resolveUploadSource(source.fileName);
            if (!source.sourceUrl)
                return null;
            return resolveRegisteredSource(source.sourceUrl)
                ?? resolveControlledMediaSource(source.sourceUrl, videoPosterSources)?.filePath
                ?? null;
        }
        catch {
            return null;
        }
    };
    router.get('/media/video/poster', async (req, res) => {
        const fileName = typeof req.query.fileName === 'string' ? req.query.fileName.trim() : '';
        const sourceUrl = typeof req.query.sourceUrl === 'string' ? req.query.sourceUrl.trim() : '';
        if (!fileName && !sourceUrl) {
            res.status(400).json({ ok: false, message: '缺少视频文件' });
            return;
        }
        try {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            if (sourceUrl) {
                const resolved = resolveControlledMediaSource(sourceUrl, videoPosterSources);
                if (resolved) {
                    if (resolved.source.createPoster) {
                        const poster = await resolved.source.createPoster(resolved.filePath);
                        res.redirect(302, poster.publicUrl);
                        return;
                    }
                    const posterPath = await mediaService.getVideoPoster(path.basename(resolved.filePath));
                    res.sendFile(posterPath);
                    return;
                }
                const libraryThumbnailUrl = getIdentityThumbnailUrl(sourceUrl);
                if (libraryThumbnailUrl && resolveRegisteredSource(sourceUrl)) {
                    res.redirect(302, libraryThumbnailUrl);
                    return;
                }
                res.status(400).json({ ok: false, message: '视频文件不在受控目录中' });
                return;
            }
            const posterPath = await mediaService.getVideoPoster(fileName);
            res.sendFile(posterPath);
        }
        catch (err) {
            // FFmpeg may be missing or unable to decode the source. A poster is decorative, so report it
            // as unavailable and let the player keep its own placeholder instead of surfacing an error.
            res.status(404).json({
                ok: false,
                code: 'video_poster_unavailable',
                message: getErrorMessage(err, '视频封面生成失败')
            });
        }
    });
    /**
     * Pre-generates the playback proxy for a source. Clients call it as soon as a video node appears so
     * the first play does not wait for the codec probe or the whole transcode. The response returns as
     * soon as the decision is made; the encode keeps running in the background.
     */
    router.post('/media/video/playback/prepare', async (req, res) => {
        const sourceUrl = isRecord(req.body) && typeof req.body.sourceUrl === 'string' ? req.body.sourceUrl.trim() : '';
        if (!sourceUrl) {
            res.status(400).json({ ok: false, message: '缺少视频文件' });
            return;
        }
        const sourcePath = resolveRegisteredSource(sourceUrl)
            ?? resolveControlledMediaSource(sourceUrl, videoPosterSources)?.filePath
            ?? null;
        if (!sourcePath) {
            res.status(400).json({ ok: false, message: '视频文件不在 MK 受控素材中' });
            return;
        }
        try {
            res.json({ ok: true, ...await mediaService.prepareVideoPlayback(sourcePath) });
        }
        catch (err) {
            res.status(500).json({ ok: false, message: getErrorMessage(err, '视频播放代理预生成失败') });
        }
    });
    router.get('/media/video/playback', async (req, res) => {
        const sourceUrl = typeof req.query.sourceUrl === 'string' ? req.query.sourceUrl.trim() : '';
        if (!sourceUrl) {
            res.status(400).json({ ok: false, message: '缺少视频文件' });
            return;
        }
        const sourcePath = resolveRegisteredSource(sourceUrl)
            ?? resolveControlledMediaSource(sourceUrl, videoPosterSources)?.filePath
            ?? null;
        if (!sourcePath) {
            res.status(400).json({ ok: false, message: '视频文件不在 MK 受控素材中' });
            return;
        }
        try {
            const playback = await mediaService.getVideoPlaybackSource(sourcePath);
            res.setHeader('Cache-Control', playback.transcoded ? 'private, max-age=31536000, immutable' : 'no-cache');
            res.setHeader('Content-Disposition', 'inline');
            // The playback endpoint has one stable browser/WebView contract even when
            // a compatible source is a MOV/M4V file or a generated MP4 proxy.
            res.type('video/mp4');
            await new Promise((resolve, reject) => {
                res.sendFile(playback.filePath, { acceptRanges: true, cacheControl: false }, (error) => {
                    // A client abort is a normal end of stream, not a failure to report.
                    if (!error || isClientAbortError(error))
                        resolve();
                    else
                        reject(error);
                });
            });
        }
        catch (err) {
            if (res.headersSent || res.writableEnded) {
                // The file response already started; the only safe cleanup is to drop the connection.
                res.destroy();
                return;
            }
            res.status(500).json({ ok: false, message: getErrorMessage(err, '视频播放兼容处理失败') });
        }
    });
    router.get('/media/image/thumbnail', async (req, res) => {
        const sourceUrl = typeof req.query.sourceUrl === 'string' ? req.query.sourceUrl.trim() : '';
        const resolved = sourceUrl ? resolveControlledMediaSource(sourceUrl, imageThumbnailSources) : null;
        if (!resolved) {
            const libraryThumbnailUrl = getIdentityThumbnailUrl(sourceUrl);
            if (libraryThumbnailUrl && resolveRegisteredSource(sourceUrl)) {
                res.redirect(307, libraryThumbnailUrl);
                return;
            }
            res.status(400).json({ ok: false, message: '图片文件不在受控目录中' });
            return;
        }
        try {
            const thumbnail = await resolved.source.createThumbnail(resolved.filePath);
            res.setHeader('Cache-Control', 'no-store');
            res.redirect(307, thumbnail.publicUrl);
        }
        catch (error) {
            // Thumbnails are a convenience; when FFmpeg is unavailable the controlled original is still
            // a valid preview, so degrade to it instead of returning a broken image to the panel.
            if (!sourceUrl.includes('/thumbnail')) {
                res.setHeader('Cache-Control', 'no-store');
                res.redirect(307, sourceUrl);
                return;
            }
            res.status(404).json({ ok: false, code: 'image_thumbnail_unavailable', message: getErrorMessage(error, '图片缩略图生成失败') });
        }
    });
    router.post('/media/video/crop', async (req, res) => {
        const parsed = parseVideoCropRequest(req.body);
        if (!parsed.ok) {
            res.status(400).json({ ok: false, message: parsed.message });
            return;
        }
        const sourcePath = resolveVideoSource(parsed.value);
        if (!sourcePath) {
            res.status(400).json({ ok: false, message: '视频文件不在 MK 受控素材中' });
            return;
        }
        try {
            res.json(await mediaService.cropVideo({ sourcePath, crop: parsed.value.crop }));
        }
        catch (err) {
            res.status(500).json({ ok: false, message: getErrorMessage(err, '视频裁剪失败') });
        }
    });
    router.post('/media/video/separate', async (req, res) => {
        const parsed = parseVideoSourceInput(req.body);
        if (!parsed.ok) {
            res.status(400).json({ ok: false, message: parsed.message });
            return;
        }
        const sourcePath = resolveVideoSource(parsed.value);
        if (!sourcePath) {
            res.status(400).json({ ok: false, message: '视频文件不在 MK 受控素材中' });
            return;
        }
        try {
            res.json(await mediaService.separateVideoAudio(sourcePath));
        }
        catch (err) {
            res.status(500).json({ ok: false, message: getErrorMessage(err, '音视频分离失败') });
        }
    });
    return router;
};
