import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
const IMAGE_EXTENSIONS = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif'
};
const removeFile = (filePath) => {
    if (filePath)
        fs.rmSync(filePath, { force: true });
};
export const isSupportedPhotoshopImageMime = (mime) => Boolean(IMAGE_EXTENSIONS[mime.toLowerCase()]);
export const createPhotoshopJobStore = ({ uploadsDir, persistDerivedHistoryAsset, ttlMs = 30 * 60 * 1000, claimLeaseMs = 2 * 60 * 1000, pluginOnlineWindowMs = 15 * 1000, now = Date.now }) => {
    fs.mkdirSync(uploadsDir, { recursive: true });
    const jobs = new Map();
    let pluginHeartbeatAt = 0;
    const toView = (job) => ({
        jobId: job.jobId,
        sourceNodeId: job.sourceNodeId,
        status: job.status,
        createdAt: job.createdAt,
        expiresAt: job.expiresAt,
        ...(job.claimedAt ? { claimedAt: job.claimedAt } : {}),
        ...(job.completedAt ? { completedAt: job.completedAt } : {}),
        ...(job.resultUrl ? { resultUrl: job.resultUrl } : {}),
        ...(job.resultFileName ? { resultFileName: job.resultFileName } : {}),
        ...(job.historyAssetId ? { historyAssetId: job.historyAssetId } : {}),
        ...(job.libraryAssetId ? { libraryAssetId: job.libraryAssetId } : {}),
        ...(job.thumbnailUrl ? { thumbnailUrl: job.thumbnailUrl } : {}),
        ...(job.message ? { message: job.message } : {})
    });
    const expireAndRequeue = () => {
        const timestamp = now();
        jobs.forEach((job) => {
            const expiresAt = Date.parse(job.expiresAt);
            if (!['completed', 'cancelled', 'expired'].includes(job.status) && timestamp >= expiresAt) {
                job.status = 'expired';
                job.message = 'Photoshop 编辑任务已过期';
                removeFile(job.sourcePath);
                return;
            }
            if ((job.status === 'claimed' || job.status === 'editing')
                && job.claimedAtMs
                && timestamp - job.claimedAtMs >= claimLeaseMs) {
                job.status = 'queued';
                job.claimedAt = undefined;
                job.claimedAtMs = undefined;
                job.message = 'Photoshop 插件领取超时，任务已重新排队';
            }
        });
    };
    const requireJob = (jobId) => {
        expireAndRequeue();
        const job = jobs.get(jobId);
        if (!job)
            throw new Error('Photoshop 编辑任务不存在');
        return job;
    };
    const requireToken = (job, token) => {
        const expected = Buffer.from(job.token);
        const received = Buffer.from(token);
        if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
            throw new Error('Photoshop 编辑任务令牌无效');
        }
    };
    return {
        createJob(input) {
            if (!input.sourceNodeId.trim())
                throw new Error('缺少源节点 ID');
            if (!input.projectId.trim() || !input.canvasId.trim())
                throw new Error('缺少当前项目或画布 ID');
            const extension = IMAGE_EXTENSIONS[input.sourceMime.toLowerCase()];
            if (!extension)
                throw new Error('Photoshop 仅支持 PNG、JPEG、WebP 或 GIF 图片');
            const timestamp = now();
            const jobId = crypto.randomUUID();
            const token = crypto.randomBytes(24).toString('base64url');
            const sourceFileName = `photoshop-source-${jobId}${extension}`;
            const sourcePath = path.join(uploadsDir, sourceFileName);
            fs.writeFileSync(sourcePath, input.sourceBuffer);
            const job = {
                jobId,
                sourceNodeId: input.sourceNodeId,
                token,
                status: 'queued',
                sourcePath,
                sourceMime: input.sourceMime.toLowerCase(),
                projectId: input.projectId,
                canvasId: input.canvasId,
                createdAt: new Date(timestamp).toISOString(),
                expiresAt: new Date(timestamp + ttlMs).toISOString()
            };
            jobs.set(jobId, job);
            return { job: toView(job), token };
        },
        recordPluginHeartbeat() {
            pluginHeartbeatAt = now();
            return { online: true, lastSeenAt: new Date(pluginHeartbeatAt).toISOString() };
        },
        getPluginStatus() {
            const online = pluginHeartbeatAt > 0 && now() - pluginHeartbeatAt <= pluginOnlineWindowMs;
            return {
                online,
                ...(pluginHeartbeatAt > 0 ? { lastSeenAt: new Date(pluginHeartbeatAt).toISOString() } : {})
            };
        },
        claimNextJob() {
            expireAndRequeue();
            const job = Array.from(jobs.values()).find((candidate) => candidate.status === 'queued');
            if (!job)
                return null;
            const timestamp = now();
            job.status = 'claimed';
            job.claimedAtMs = timestamp;
            job.claimedAt = new Date(timestamp).toISOString();
            job.message = undefined;
            return {
                job: toView(job),
                token: job.token,
                sourceMime: job.sourceMime
            };
        },
        getJob(jobId, token) {
            const job = requireJob(jobId);
            requireToken(job, token);
            return toView(job);
        },
        getSource(jobId, token) {
            const job = requireJob(jobId);
            requireToken(job, token);
            if (job.status === 'cancelled' || job.status === 'expired')
                throw new Error(job.message || '任务已结束');
            if (!fs.existsSync(job.sourcePath))
                throw new Error('Photoshop 源图已被清理');
            if (job.status === 'claimed' || job.status === 'queued')
                job.status = 'editing';
            job.claimedAtMs = now();
            return { filePath: job.sourcePath, mime: job.sourceMime };
        },
        beginUpload(jobId, token) {
            const job = requireJob(jobId);
            requireToken(job, token);
            if (job.status === 'completed')
                return toView(job);
            if (job.status === 'cancelled' || job.status === 'expired')
                throw new Error(job.message || '任务已结束');
            job.status = 'uploading';
            return toView(job);
        },
        async completeJob(jobId, token, resultBuffer) {
            const job = requireJob(jobId);
            requireToken(job, token);
            if (job.status === 'completed')
                return toView(job);
            if (job.status === 'cancelled' || job.status === 'expired')
                throw new Error(job.message || '任务已结束');
            const resultFileName = `photoshop-result-${jobId}.png`;
            const temporaryPath = path.join(uploadsDir, `${resultFileName}.upload`);
            fs.writeFileSync(temporaryPath, resultBuffer);
            const asset = await persistDerivedHistoryAsset({
                filePath: temporaryPath,
                fileName: resultFileName,
                kind: 'image',
                scope: { projectId: job.projectId, canvasId: job.canvasId },
                source: 'Photoshop 编辑',
                metadata: { operation: 'photoshop-roundtrip', nodeId: job.sourceNodeId }
            });
            removeFile(temporaryPath);
            job.status = 'completed';
            job.resultFileName = asset.name;
            job.resultUrl = asset.previewUrl;
            job.historyAssetId = asset.id;
            job.thumbnailUrl = asset.thumbnailUrl;
            job.completedAt = new Date(now()).toISOString();
            job.message = undefined;
            removeFile(job.sourcePath);
            return toView(job);
        },
        failUpload(jobId, token, message) {
            const job = requireJob(jobId);
            requireToken(job, token);
            if (!['completed', 'cancelled', 'expired'].includes(job.status)) {
                job.status = 'editing';
                job.message = message;
            }
            return toView(job);
        },
        cancelJob(jobId, token) {
            const job = requireJob(jobId);
            requireToken(job, token);
            if (job.status === 'completed')
                return toView(job);
            job.status = 'cancelled';
            job.message = 'Photoshop 编辑任务已取消';
            removeFile(job.sourcePath);
            return toView(job);
        },
        sweep() {
            expireAndRequeue();
        }
    };
};
