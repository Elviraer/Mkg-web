import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
const DEFAULT_THUMBNAIL_TIMEOUT_MS = 30000;
const readThumbnailTimeoutMs = () => {
    const configured = Number(process.env.MK_THUMBNAIL_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_THUMBNAIL_TIMEOUT_MS;
};
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
const hashFile = async (filePath) => {
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return hash.digest('hex');
};
export const createHistoryThumbnailService = ({ rootDir, publicUrlPrefix, ffmpegPath = process.env.MK_FFMPEG_PATH ?? 'ffmpeg', spawnProcess = spawn, timeoutMs = readThumbnailTimeoutMs(), terminateProcess = terminateProcessTree }) => {
    const thumbnailsDir = path.join(rootDir, 'thumbnails');
    fs.mkdirSync(thumbnailsDir, { recursive: true });
    const runThumbnailTask = createTaskQueue(2);
    const runFfmpeg = (args) => new Promise((resolve, reject) => {
        const child = spawnProcess(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
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
        child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
        child.once('error', (error) => settle(() => reject(error)));
        child.once('close', (code) => {
            settle(() => {
                if (code === 0)
                    resolve();
                else
                    reject(new Error(stderr.trim() || `ffmpeg exited with ${code}`));
            });
        });
        timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                terminateProcess(child);
            }
            catch {
                // Rejecting still releases the queue even if the operating system refuses termination.
            }
            reject(new Error(`ffmpeg thumbnail timed out after ${timeoutMs}ms`));
        }, Math.max(1, timeoutMs));
    });
    const createThumbnail = async (sourcePath, kind, knownContentHash) => runThumbnailTask(async () => {
        const contentHash = knownContentHash ?? await hashFile(sourcePath);
        const filename = `${contentHash}.webp`;
        const outputPath = path.join(thumbnailsDir, filename);
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
            const temporaryPath = path.join(thumbnailsDir, `${contentHash}.${process.pid}.${Date.now()}.tmp.webp`);
            try {
                await runFfmpeg([
                    ...(kind === 'video' ? ['-ss', '0'] : []),
                    '-i', sourcePath,
                    '-frames:v', '1',
                    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease',
                    '-c:v', 'libwebp',
                    '-quality', '78',
                    temporaryPath
                ]);
                await fs.promises.rename(temporaryPath, outputPath);
            }
            finally {
                await fs.promises.rm(temporaryPath, { force: true });
            }
        }
        return { publicUrl: `${publicUrlPrefix}/thumbnails/${filename}` };
    });
    return { thumbnailsDir, createThumbnail };
};
