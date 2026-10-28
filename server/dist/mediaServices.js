import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import crypto from 'node:crypto';
/**
 * ffprobe fields the playback decision needs. `disposition` is a separate ffprobe section
 * (`stream_disposition`); listing it inside `stream=` is silently ignored, which would disable
 * cover-art detection entirely, so keep this string covered by a real-ffprobe test.
 */
export const PLAYBACK_PROBE_ENTRIES = 'format=format_name:stream=index,codec_type,codec_name,pix_fmt,profile,level,width,height:stream_disposition=attached_pic';
const createTaskQueue = (concurrency) => {
    let activeCount = 0;
    const queue = [];
    const runNext = () => {
        if (activeCount >= concurrency)
            return;
        queue.shift()?.();
    };
    return (task) => new Promise((resolve, reject) => {
        const run = () => {
            activeCount += 1;
            task().then(resolve, reject).finally(() => {
                activeCount -= 1;
                runNext();
            });
        };
        if (activeCount < concurrency)
            run();
        else
            queue.push(run);
    });
};
const runFfmpeg = (command, args, options) => new Promise((resolve, reject) => {
    const child = spawn(command, ['-hide_banner', '-y', ...args], { windowsHide: true });
    let stderr = '';
    let settled = false;
    let timer;
    const settle = (callback) => {
        if (settled)
            return;
        settled = true;
        if (timer)
            clearTimeout(timer);
        callback();
    };
    const timeoutMs = options?.timeoutMs ?? 0;
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });
    child.on('error', (error) => settle(() => reject(error)));
    child.on('close', (code) => {
        settle(() => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr.trim() || `ffmpeg exited with ${code}`));
        });
    });
    if (timeoutMs > 0) {
        timer = setTimeout(() => {
            if (settled)
                return;
            settle(() => {
                try {
                    options?.terminateProcess?.(child);
                }
                catch {
                    // Rejecting still releases the queue even if the OS refuses termination.
                }
                reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
            });
        }, Math.max(1, timeoutMs));
    }
});
const terminateProcessTree = (child) => {
    if (process.platform === 'win32' && child.pid) {
        const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 5000
        });
        if (!result.error && result.status === 0)
            return;
    }
    child.kill('SIGKILL');
};
const runFfprobe = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, ['-v', 'error', ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
        if (code === 0) {
            resolve(stdout);
            return;
        }
        reject(new Error(stderr.trim() || `ffprobe exited with ${code}`));
    });
});
const getReducedRatio = (width, height) => {
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const divisor = gcd(Math.round(width), Math.round(height)) || 1;
    return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
};
/**
 * Video tracks that carry timing/metadata rather than pictures. Some demuxers surface QuickTime
 * timecode (`tmcd`) or metadata (`gpmd`, `fdsc`) tracks as video streams, and MP4/M4A files can
 * carry cover art (`attached_pic`). Selecting one of those instead of the real picture track used to
 * produce a proxy without a decodable video stream, which WebView2 renders as a black frame.
 */
const NON_PICTURE_VIDEO_CODECS = new Set(['tmcd', 'gpmd', 'fdsc', 'meta', 'data', 'text', 'c608', 'c708']);
/** Largest edge WebView2/Chromium software H.264 decoding handles reliably. */
export const PLAYBACK_MAX_EDGE = 4096;
/** H.264 level 5.2 is the highest level Chromium decodes in software. */
export const PLAYBACK_MAX_H264_LEVEL = 52;
/** Bounded memo for ffprobe results; probes are small and keyed by full source identity. */
const PLAYBACK_PROBE_CACHE_LIMIT = 64;
const readStreamEdge = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0;
};
export const selectPlayableVideoStream = (probe) => {
    const videoStreams = (probe.streams ?? []).filter((stream) => stream.codec_type === 'video');
    const pictureStreams = videoStreams.filter((stream) => (stream.disposition?.attached_pic !== 1
        && !NON_PICTURE_VIDEO_CODECS.has((stream.codec_name ?? '').toLowerCase())));
    return pictureStreams[0] ?? videoStreams[0];
};
export const isWebViewPlaybackCompatible = (probe) => {
    const formatNames = new Set((probe.format?.format_name ?? '').split(',').map((value) => value.trim().toLowerCase()));
    const video = selectPlayableVideoStream(probe);
    const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
    if (!video)
        return false;
    const maxEdge = Math.max(readStreamEdge(video.width), readStreamEdge(video.height));
    const level = Number(video.level ?? 0);
    return (formatNames.has('mp4') || formatNames.has('mov') || formatNames.has('m4v'))
        && video.codec_name === 'h264'
        && video.pix_fmt === 'yuv420p'
        && (!audio || audio.codec_name === 'aac')
        && maxEdge <= PLAYBACK_MAX_EDGE
        && !(Number.isFinite(level) && level > 0 && level > PLAYBACK_MAX_H264_LEVEL);
};
export const buildPlaybackTranscodeArgs = (sourcePath, probe) => {
    const video = selectPlayableVideoStream(probe);
    const maxEdge = Math.max(readStreamEdge(video?.width), readStreamEdge(video?.height));
    const needsScale = maxEdge > PLAYBACK_MAX_EDGE;
    const streamIndex = typeof video?.index === 'number' && Number.isInteger(video.index) && video.index >= 0
        ? `0:${video.index}`
        : '0:v:0';
    return [
        '-i', sourcePath,
        '-map', streamIndex,
        '-map', '0:a:0?',
        ...(needsScale
            ? ['-vf', `scale='min(${PLAYBACK_MAX_EDGE},iw)':'min(${PLAYBACK_MAX_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`]
            : []),
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-sn',
        '-dn',
        '-movflags', '+faststart'
    ];
};
export const createMediaService = ({ uploadsDir, playbackCacheDir = path.join(uploadsDir, '.playback'), ffmpegPath = process.env.MK_FFMPEG_PATH ?? 'ffmpeg', ffprobePath = process.env.MK_FFPROBE_PATH ?? 'ffprobe' }) => {
    const postersDir = path.join(uploadsDir, '.posters');
    fs.mkdirSync(playbackCacheDir, { recursive: true });
    fs.mkdirSync(postersDir, { recursive: true });
    const posterTasks = new Map();
    const playbackTasks = new Map();
    const playbackProbeTasks = new Map();
    const playbackProbeCache = new Map();
    const runPosterTask = createTaskQueue(2);
    const runPlaybackTask = createTaskQueue(2);
    const playbackCacheTtlMs = 30 * 24 * 60 * 60 * 1000;
    // A stuck ffmpeg process must not hold a playback request open forever; the node UI shows an
    // actionable retry instead. Long sources legitimately need minutes, so the budget is generous.
    const playbackTranscodeTimeoutMs = (() => {
        const configured = Number(process.env.MK_PLAYBACK_TRANSCODE_TIMEOUT_MS);
        return Number.isFinite(configured) && configured > 0 ? configured : 15 * 60 * 1000;
    })();
    for (const entry of fs.readdirSync(playbackCacheDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.mp4'))
            continue;
        const filePath = path.join(playbackCacheDir, entry.name);
        try {
            if (fs.statSync(filePath).mtimeMs < Date.now() - playbackCacheTtlMs)
                fs.rmSync(filePath, { force: true });
        }
        catch {
            // Concurrent cache cleanup is harmless.
        }
    }
    const safeUploadFilename = (fileName) => {
        const normalized = path.basename(fileName);
        const resolved = path.resolve(uploadsDir, normalized);
        if (!resolved.startsWith(path.resolve(uploadsDir))) {
            throw new Error('非法文件路径');
        }
        if (!fs.existsSync(resolved)) {
            throw new Error('文件不存在');
        }
        return resolved;
    };
    const uploadPublicUrl = (filePath) => `/api/uploads/${path.basename(filePath)}`;
    const getVideoPoster = async (fileName) => {
        const inputPath = safeUploadFilename(fileName);
        const outputPath = path.join(postersDir, `${path.basename(inputPath)}.jpg`);
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0)
            return outputPath;
        const pending = posterTasks.get(inputPath);
        if (pending)
            return pending;
        const task = runPosterTask(async () => {
            if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0)
                return outputPath;
            const temporaryPath = path.join(postersDir, `${path.basename(inputPath)}.${Date.now()}.tmp.jpg`);
            try {
                await runFfmpeg(ffmpegPath, [
                    '-ss', '0',
                    '-i', inputPath,
                    '-frames:v', '1',
                    '-vf', 'scale=640:640:force_original_aspect_ratio=decrease',
                    '-q:v', '4',
                    temporaryPath
                ]);
                await fs.promises.rename(temporaryPath, outputPath);
                return outputPath;
            }
            finally {
                await fs.promises.rm(temporaryPath, { force: true });
            }
        }).finally(() => posterTasks.delete(inputPath));
        posterTasks.set(inputPath, task);
        return task;
    };
    const makeUploadOutputPath = (prefix, extension) => {
        const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'media';
        const safeExt = extension.startsWith('.') ? extension : `.${extension}`;
        return path.join(uploadsDir, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safePrefix}${safeExt}`);
    };
    const probeVideoSize = async (filePath) => {
        const output = await runFfprobe(ffprobePath, [
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'json',
            filePath
        ]);
        const parsed = JSON.parse(output || '{}');
        const stream = parsed.streams?.[0];
        const width = Math.max(0, Math.round(Number(stream?.width ?? 0)));
        const height = Math.max(0, Math.round(Number(stream?.height ?? 0)));
        return {
            width,
            height,
            resolution: width && height ? `${width} × ${height}` : '',
            aspectRatio: width && height ? getReducedRatio(width, height) : '16:9'
        };
    };
    const probeVideoPlayback = async (filePath) => {
        const output = await runFfprobe(ffprobePath, [
            '-show_entries', PLAYBACK_PROBE_ENTRIES,
            '-of', 'json',
            filePath
        ]);
        return JSON.parse(output || '{}');
    };
    const probeVideoPlaybackOnce = (sourceIdentity, filePath) => {
        // Every video surface (node player, mask preview, reference thumbnails) asks for the same probe.
        // Source identity already contains size and mtime, so a cached probe cannot outlive its file.
        const cached = playbackProbeCache.get(sourceIdentity);
        if (cached)
            return Promise.resolve(cached);
        const pending = playbackProbeTasks.get(sourceIdentity);
        if (pending)
            return pending;
        const task = probeVideoPlayback(filePath)
            .then((probe) => {
            playbackProbeCache.delete(sourceIdentity);
            playbackProbeCache.set(sourceIdentity, probe);
            while (playbackProbeCache.size > PLAYBACK_PROBE_CACHE_LIMIT) {
                const oldest = playbackProbeCache.keys().next().value;
                if (oldest === undefined)
                    break;
                playbackProbeCache.delete(oldest);
            }
            return probe;
        })
            .finally(() => playbackProbeTasks.delete(sourceIdentity));
        playbackProbeTasks.set(sourceIdentity, task);
        return task;
    };
    const getVideoPlaybackSource = async (sourcePath) => {
        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile())
            throw new Error('文件不存在');
        const stat = fs.statSync(sourcePath);
        const sourceIdentity = `${path.resolve(sourcePath)}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
        // Probing requires FFprobe. When it is unavailable the source is still the best available
        // playback contract: a natively decodable file plays, and the player keeps its own error
        // affordance for the rest. Failing here would black out every video preview on that machine.
        let probe = null;
        try {
            probe = await probeVideoPlaybackOnce(sourceIdentity, sourcePath);
        }
        catch {
            probe = null;
        }
        if (!probe)
            return { filePath: sourcePath, transcoded: false };
        const key = crypto.createHash('sha256')
            .update(`${sourceIdentity}|${JSON.stringify(probe)}`)
            .digest('hex');
        const outputPath = path.join(playbackCacheDir, `${key}.mp4`);
        const cached = fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0;
        if (cached) {
            fs.utimesSync(outputPath, new Date(), new Date());
            return { filePath: outputPath, transcoded: true };
        }
        const pending = playbackTasks.get(key);
        if (pending)
            return pending;
        const task = runPlaybackTask(async () => {
            if (isWebViewPlaybackCompatible(probe))
                return { filePath: sourcePath, transcoded: false };
            const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp.mp4`;
            try {
                await runFfmpeg(ffmpegPath, [
                    ...buildPlaybackTranscodeArgs(sourcePath, probe),
                    temporaryPath
                ], { timeoutMs: playbackTranscodeTimeoutMs, terminateProcess: terminateProcessTree });
                await fs.promises.rename(temporaryPath, outputPath);
                return { filePath: outputPath, transcoded: true };
            }
            finally {
                await fs.promises.rm(temporaryPath, { force: true });
            }
        }).finally(() => playbackTasks.delete(key));
        playbackTasks.set(key, task);
        return task;
    };
    const cropVideo = async ({ sourcePath, crop }) => {
        const inputPath = sourcePath;
        if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile())
            throw new Error('文件不存在');
        const sourceWidth = Math.max(1, Math.round(crop.sourceWidth));
        const sourceHeight = Math.max(1, Math.round(crop.sourceHeight));
        const x = Math.max(0, Math.round((Math.min(100, Math.max(0, crop.x)) / 100) * sourceWidth));
        const y = Math.max(0, Math.round((Math.min(100, Math.max(0, crop.y)) / 100) * sourceHeight));
        const width = Math.max(2, Math.min(sourceWidth - x, Math.round((Math.min(100, Math.max(1, crop.width)) / 100) * sourceWidth)));
        const height = Math.max(2, Math.min(sourceHeight - y, Math.round((Math.min(100, Math.max(1, crop.height)) / 100) * sourceHeight)));
        const evenX = x - (x % 2);
        const evenY = y - (y % 2);
        const evenWidth = Math.max(2, width - (width % 2));
        const evenHeight = Math.max(2, height - (height % 2));
        const outputPath = makeUploadOutputPath('video-crop', '.mp4');
        await runFfmpeg(ffmpegPath, [
            '-i', inputPath,
            '-vf', `crop=${evenWidth}:${evenHeight}:${evenX}:${evenY}`,
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '20',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            outputPath
        ]);
        return {
            ok: true,
            mode: 'ffmpeg',
            fileName: path.basename(outputPath),
            previewUrl: uploadPublicUrl(outputPath),
            resolution: `${evenWidth} × ${evenHeight}`,
            aspectRatio: getReducedRatio(evenWidth, evenHeight),
            width: evenWidth,
            height: evenHeight
        };
    };
    const separateVideoAudio = async (sourcePath) => {
        const inputPath = sourcePath;
        if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile())
            throw new Error('文件不存在');
        const sourceExtension = path.extname(inputPath).toLowerCase();
        const videoExtension = sourceExtension === '.webm' ? '.webm' : '.mp4';
        const videoPath = makeUploadOutputPath('video-muted', videoExtension);
        const audioPath = makeUploadOutputPath('video-audio', '.mp3');
        try {
            await runFfmpeg(ffmpegPath, [
                '-i', inputPath,
                '-map', '0:v:0',
                '-c:v', 'copy',
                '-an',
                ...(videoExtension === '.mp4' ? ['-movflags', '+faststart'] : []),
                videoPath
            ]);
        }
        catch {
            await runFfmpeg(ffmpegPath, [
                '-i', inputPath,
                '-map', '0:v:0',
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '20',
                '-an',
                '-movflags', '+faststart',
                videoPath
            ]);
        }
        const videoSize = await probeVideoSize(videoPath);
        let audioResult = null;
        try {
            await runFfmpeg(ffmpegPath, [
                '-i', inputPath,
                '-map', '0:a:0',
                '-vn',
                '-c:a', 'libmp3lame',
                '-ac', '2',
                '-q:a', '2',
                audioPath
            ]);
            if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0) {
                audioResult = {
                    fileName: path.basename(audioPath),
                    previewUrl: uploadPublicUrl(audioPath)
                };
            }
        }
        catch {
            fs.rmSync(audioPath, { force: true });
            audioResult = null;
        }
        return {
            ok: true,
            mode: 'ffmpeg',
            video: {
                fileName: path.basename(videoPath),
                previewUrl: uploadPublicUrl(videoPath),
                width: videoSize.width,
                height: videoSize.height,
                resolution: videoSize.resolution,
                aspectRatio: videoSize.aspectRatio,
                mode: 'ffmpeg'
            },
            audio: audioResult
        };
    };
    /**
     * Starts (or joins) proxy generation for a source without waiting for the encode, so the caller can
     * pre-generate as soon as a video node appears instead of making the user's first play wait for it.
     */
    const prepareVideoPlayback = async (sourcePath) => {
        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile())
            throw new Error('文件不存在');
        const stat = fs.statSync(sourcePath);
        const sourceIdentity = `${path.resolve(sourcePath)}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
        let probe = null;
        try {
            probe = await probeVideoPlaybackOnce(sourceIdentity, sourcePath);
        }
        catch {
            probe = null;
        }
        // Without a probe there is nothing to decide, and a compatible source needs no proxy at all.
        if (!probe || isWebViewPlaybackCompatible(probe))
            return { transcoded: false, preparing: false };
        const key = crypto.createHash('sha256')
            .update(`${sourceIdentity}|${JSON.stringify(probe)}`)
            .digest('hex');
        const outputPath = path.join(playbackCacheDir, `${key}.mp4`);
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            return { transcoded: true, preparing: false };
        }
        // Reuses the same coalescing map as playback requests, so a hover that arrives while this runs
        // waits on the existing encode instead of starting a second one.
        void getVideoPlaybackSource(sourcePath).catch(() => undefined);
        return { transcoded: true, preparing: true };
    };
    return {
        getVideoPoster,
        getVideoPlaybackSource,
        prepareVideoPlayback,
        resolveUploadSource: safeUploadFilename,
        cropVideo,
        separateVideoAudio
    };
};
