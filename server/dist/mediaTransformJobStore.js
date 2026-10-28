import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { persistAssetBlobFile } from './assetBlobStore.js';
import { sweepExpiredJobDirectories } from './jobDirectorySweep.js';
import { executableAvailable } from './runtimeExecutables.js';
const PROCESS_RES_OPTIONS = [336, 504, 756];
const ANALYSIS_LAYERS = ['depth', 'pose', 'face'];
const DEPTH_MAPPINGS = ['balanced', 'detail', 'contrast'];
const FACE_MODES = ['stable', 'multi'];
const AUDIO_STEMS = ['vocals', 'other'];
const ACTIVE_STATUSES = new Set(['queued', 'running', 'encoding']);
const CAPABILITIES_CACHE_MS = 5 * 60 * 1000;
const DEPTH_START_DEFER_MS = 50;
const SCENE_PREVIEW_FRAME_COUNT = 24;
const SCENE_SCRUB_MAX_EDGE = 720;
const safeId = (value, label) => {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`${label} 不能为空`);
    return value.trim().slice(0, 160);
};
const safeUrl = (value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048)
        throw new Error('sourceUrl 无效');
    return value.trim();
};
const integer = (value, label, min, max) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${label} 必须是 ${min}-${max} 的整数`);
    }
    return value;
};
export const parseMediaTransformRequest = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('任务请求必须是对象');
    const input = value;
    const common = {
        projectId: safeId(input.projectId, 'projectId'),
        canvasId: safeId(input.canvasId, 'canvasId'),
        sourceNodeId: safeId(input.sourceNodeId, 'sourceNodeId'),
        sourceUrl: safeUrl(input.sourceUrl)
    };
    if (input.kind === 'video_trim') {
        const startCs = integer(input.startCs, 'startCs', 0, 86400000);
        const endCs = integer(input.endCs, 'endCs', 1, 86400000);
        if (endCs <= startCs)
            throw new Error('截取结束时间必须晚于开始时间');
        return { kind: 'video_trim', ...common, startCs, endCs };
    }
    if (input.kind === 'audio_separate') {
        const rawStems = input.stems === undefined ? AUDIO_STEMS : input.stems;
        if (!Array.isArray(rawStems) || rawStems.length === 0 || rawStems.some((stem) => !AUDIO_STEMS.includes(stem))) {
            throw new Error('至少选择一个受支持的声音输出');
        }
        const selected = new Set(rawStems);
        const stems = AUDIO_STEMS.filter((stem) => selected.has(stem));
        if (input.outputFormat !== undefined && input.outputFormat !== 'mp3')
            throw new Error('声音分离仅支持 MP3 输出');
        return { kind: 'audio_separate', ...common, stems, outputFormat: 'mp3' };
    }
    if (input.kind === 'video_scene_detect') {
        const algorithm = input.algorithm === undefined ? 'fast' : input.algorithm;
        if (algorithm !== 'omnishotcut' && algorithm !== 'fast')
            throw new Error('智能切割算法不受支持');
        const detectionMode = input.detectionMode === undefined ? 'clean_shot' : input.detectionMode;
        if (detectionMode !== 'clean_shot' && detectionMode !== 'default')
            throw new Error('智能切割检测模式不受支持');
        const sceneThreshold = typeof input.sceneThreshold === 'number' && Number.isFinite(input.sceneThreshold)
            ? input.sceneThreshold
            : detectionMode === 'default' ? 0.22 : 0.35;
        if (sceneThreshold < 0.05 || sceneThreshold > 0.95)
            throw new Error('镜头边界灵敏度必须在 0.05-0.95 之间');
        return {
            kind: 'video_scene_detect',
            ...common,
            algorithm,
            detectionMode,
            sceneThreshold,
            minClipDurationMs: input.minClipDurationMs === undefined
                ? Math.round(integer(input.minClipFrames, 'minClipFrames', 1, 86400) / 24 * 1000)
                : integer(input.minClipDurationMs, 'minClipDurationMs', 100, 86400000)
        };
    }
    if (input.kind === 'video_scene_split') {
        const minClipDurationMs = input.minClipDurationMs === undefined
            ? Math.round(integer(input.minClipFrames, 'minClipFrames', 1, 86400) / 24 * 1000)
            : integer(input.minClipDurationMs, 'minClipDurationMs', 100, 86400000);
        if (!Array.isArray(input.segments) || input.segments.length === 0 || input.segments.length > 120) {
            throw new Error('智能切割片段数量无效');
        }
        const segments = input.segments.map((segment) => {
            if (!segment || typeof segment !== 'object')
                throw new Error('智能切割片段格式无效');
            const value = segment;
            const startFrame = integer(value.startFrame, 'startFrame', 0, 86400000);
            const endFrame = integer(value.endFrame, 'endFrame', 1, 86400000);
            return { startFrame, endFrame };
        });
        for (let index = 1; index < segments.length; index += 1) {
            if (segments[index - 1].endFrame !== segments[index].startFrame)
                throw new Error('智能切割片段必须首尾相连');
        }
        return { kind: 'video_scene_split', ...common, minClipDurationMs, segments };
    }
    if (input.kind === 'video_depth') {
        if (input.model !== 'DA3-SMALL' && input.model !== 'DA3-BASE')
            throw new Error('深度模型不受支持');
        if (!PROCESS_RES_OPTIONS.includes(input.processRes))
            throw new Error('处理尺寸不受支持');
        const rawLayers = input.layers === undefined ? ['depth'] : input.layers;
        if (!Array.isArray(rawLayers) || rawLayers.length === 0 || rawLayers.some((layer) => !ANALYSIS_LAYERS.includes(layer))) {
            throw new Error('至少选择一个受支持的分析图层');
        }
        const selected = new Set(rawLayers);
        const layers = ANALYSIS_LAYERS.filter((layer) => selected.has(layer));
        const depthMapping = input.depthMapping === undefined ? 'balanced' : input.depthMapping;
        if (!DEPTH_MAPPINGS.includes(depthMapping))
            throw new Error('深度灰度映射不受支持');
        const faceMode = input.faceMode === undefined ? 'stable' : input.faceMode;
        if (!FACE_MODES.includes(faceMode))
            throw new Error('面部点云模式不受支持');
        if (input.subjectEnhancement !== undefined && typeof input.subjectEnhancement !== 'boolean') {
            throw new Error('人物深度增强参数不受支持');
        }
        if (input.subjectEnhancement === true && !layers.includes('depth')) {
            throw new Error('人物深度增强需要选择深度图层');
        }
        return {
            kind: 'video_depth',
            ...common,
            model: input.model,
            processRes: input.processRes,
            layers,
            depthMapping: depthMapping,
            faceMode: faceMode,
            subjectEnhancement: input.subjectEnhancement === true
        };
    }
    throw new Error('媒体转换类型不受支持');
};
export const resolveControlledMediaSource = (sourceUrl, roots) => {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(sourceUrl, 'http://mk.local').pathname);
    }
    catch {
        throw new Error('视频输入路径编码无效');
    }
    const root = roots.find((candidate) => pathname.startsWith(`${candidate.prefix.replace(/\/+$/, '')}/`));
    if (!root)
        throw new Error('视频输入必须来自 MK 受控素材');
    const prefix = root.prefix.replace(/\/+$/, '');
    const relative = pathname.slice(prefix.length + 1);
    if (!relative || relative.includes('\0'))
        throw new Error('视频输入路径无效');
    const resolvedRoot = fs.realpathSync(path.resolve(root.rootDir));
    const resolved = path.resolve(resolvedRoot, relative);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error('视频输入文件不存在');
    }
    const realSource = fs.realpathSync(resolved);
    const rootPrefix = `${resolvedRoot}${path.sep}`.toLocaleLowerCase();
    if (!realSource.toLocaleLowerCase().startsWith(rootPrefix))
        throw new Error('视频输入路径无效');
    return realSource;
};
const reducedRatio = (width, height) => {
    const gcd = (a, b) => b ? gcd(b, a % b) : a;
    const divisor = gcd(Math.max(1, width), Math.max(1, height));
    return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
};
const normalizeProbeRate = (value) => {
    if (typeof value !== 'string')
        return 0;
    const [numerator, denominator] = value.split('/').map(Number);
    return typeof numerator === 'number'
        && typeof denominator === 'number'
        && Number.isFinite(numerator)
        && Number.isFinite(denominator)
        && denominator !== 0
        ? numerator / denominator
        : 0;
};
export const normalizeSceneCutFrames = (candidates, frameCount, minimumFrames) => {
    const finalFrame = Math.max(1, Math.round(frameCount));
    const minimum = Math.max(1, Math.round(minimumFrames));
    return [...new Set(candidates.map((frame) => Math.round(frame)))]
        .filter((frame) => Number.isFinite(frame) && frame > 0 && frame < finalFrame)
        .sort((left, right) => left - right)
        .reduce((frames, frame) => {
        const previous = frames[frames.length - 1] ?? 0;
        if (frame - previous >= minimum && finalFrame - frame >= minimum)
            frames.push(frame);
        return frames;
    }, []);
};
export const frameToSceneTime = (frameTimestamps, frame) => {
    if (frameTimestamps.length < 2)
        return 0;
    const index = Math.min(frameTimestamps.length - 1, Math.max(0, Math.round(frame)));
    return frameTimestamps[index] ?? 0;
};
export const sceneTimeToFrame = (frameTimestamps, seconds) => {
    if (frameTimestamps.length < 2)
        return 0;
    const target = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    let low = 0;
    let high = frameTimestamps.length - 1;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if ((frameTimestamps[middle] ?? 0) < target)
            low = middle + 1;
        else
            high = middle;
    }
    if (low <= 0)
        return 0;
    const previous = frameTimestamps[low - 1] ?? 0;
    const current = frameTimestamps[low] ?? previous;
    return target - previous <= current - target ? low - 1 : low;
};
export const normalizeSceneCutFramesByTime = (candidates, frameTimestamps, minimumDurationMs) => {
    const finalFrame = Math.max(1, frameTimestamps.length - 1);
    const minimumSeconds = Math.max(0.001, minimumDurationMs / 1000);
    const finalTime = frameToSceneTime(frameTimestamps, finalFrame);
    return [...new Set(candidates.map((frame) => Math.round(frame)))]
        .filter((frame) => Number.isFinite(frame) && frame > 0 && frame < finalFrame)
        .sort((left, right) => left - right)
        .reduce((frames, frame) => {
        const previous = frames[frames.length - 1] ?? 0;
        const currentTime = frameToSceneTime(frameTimestamps, frame);
        if (currentTime - frameToSceneTime(frameTimestamps, previous) >= minimumSeconds
            && finalTime - currentTime >= minimumSeconds)
            frames.push(frame);
        return frames;
    }, []);
};
export const sceneVideoCodecArgs = (useNvenc) => useNvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '20', '-b:v', '0', '-forced-idr', '1']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
const parseLastJsonObject = (stdout) => {
    const lines = stdout.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line)
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            // Third-party imports may write warnings to stdout before the worker result.
        }
    }
    throw new Error('stdout 中没有可解析的 JSON 对象');
};
const view = (job) => ({
    id: job.id,
    kind: job.kind,
    status: job.status,
    projectId: job.projectId,
    canvasId: job.canvasId,
    sourceNodeId: job.sourceNodeId,
    request: job.request,
    stage: job.stage,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.result ? { result: job.result } : {}),
    ...(job.results?.length ? { results: job.results } : {}),
    ...(job.sceneFrames ? { sceneFrames: job.sceneFrames } : {}),
    ...(job.sceneFps !== undefined ? { sceneFps: job.sceneFps } : {}),
    ...(job.sceneFrameCount !== undefined ? { sceneFrameCount: job.sceneFrameCount } : {}),
    ...(job.sceneFrameTimestamps?.length ? { sceneFrameTimestamps: job.sceneFrameTimestamps } : {}),
    ...(job.sceneDuration !== undefined ? { sceneDuration: job.sceneDuration } : {}),
    ...(job.sceneVariableFrameRate !== undefined ? { sceneVariableFrameRate: job.sceneVariableFrameRate } : {}),
    ...(job.scenePreviewUrl ? { scenePreviewUrl: job.scenePreviewUrl } : {}),
    ...(job.scenePreviewFrameCount !== undefined ? { scenePreviewFrameCount: job.scenePreviewFrameCount } : {}),
    ...(job.scenePreviewUrls?.length ? { scenePreviewUrls: job.scenePreviewUrls } : {}),
    ...(job.sceneScrubProxyUrl ? { sceneScrubProxyUrl: job.sceneScrubProxyUrl } : {}),
    ...(job.message ? { message: job.message } : {})
});
export const createMediaTransformJobStore = ({ jobsDir, uploadsDir, appDatabase, libraryAssetsDir, createLibraryThumbnail, sourceRoots, resolveLinkedSource, workerScriptPath, pythonPath = process.env.MK_DEPTH_WORKER_PYTHON, sceneWorkerScriptPath = path.resolve(path.dirname(workerScriptPath), '..', 'omnishotcut-worker', 'worker.py'), scenePythonPath = process.env.MK_OMNISHOTCUT_PYTHON, sceneCheckpointPath = process.env.MK_OMNISHOTCUT_CHECKPOINT, audioWorkerScriptPath = path.resolve(path.dirname(workerScriptPath), '..', 'audio-worker', 'worker.py'), audioPythonPath = process.env.MK_AUDIO_WORKER_PYTHON, audioModelDir = process.env.MK_AUDIO_SEPARATOR_MODEL_DIR, modelDir = process.env.MK_DA3_SMALL_MODEL_DIR ?? process.env.MK_DA3_MODEL_DIR, baseModelDir = process.env.MK_DA3_BASE_MODEL_DIR, poseLandmarkerPath = process.env.MK_POSE_LANDMARKER_PATH, faceLandmarkerPath = process.env.MK_FACE_LANDMARKER_PATH, ffmpegPath = process.env.MK_FFMPEG_PATH ?? 'ffmpeg', ffprobePath = process.env.MK_FFPROBE_PATH ?? 'ffprobe', timeoutMs = 6 * 60 * 60 * 1000, spawnProcess = spawn }) => {
    fs.mkdirSync(jobsDir, { recursive: true });
    sweepExpiredJobDirectories(jobsDir, 7 * 24 * 60 * 60 * 1000);
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.mkdirSync(libraryAssetsDir, { recursive: true });
    const workerRoot = path.dirname(path.resolve(workerScriptPath));
    const inferredPython = process.platform === 'win32'
        ? path.join(workerRoot, '.venv', 'Scripts', 'python.exe')
        : path.join(workerRoot, '.venv', 'bin', 'python');
    const resolvedPython = path.resolve(pythonPath ?? inferredPython);
    const resolvedWorker = path.resolve(workerScriptPath);
    const resolvedSceneWorker = path.resolve(sceneWorkerScriptPath);
    const resolvedScenePython = path.resolve(scenePythonPath ?? resolvedPython);
    const resolvedSceneCheckpoint = path.resolve(sceneCheckpointPath
        ?? path.join(path.dirname(resolvedSceneWorker), 'models', 'OmniShotCut_ckpt.pth'));
    const audioWorkerRoot = path.dirname(path.resolve(audioWorkerScriptPath));
    const inferredAudioPython = process.platform === 'win32'
        ? path.join(audioWorkerRoot, '.venv', 'Scripts', 'python.exe')
        : path.join(audioWorkerRoot, '.venv', 'bin', 'python');
    const resolvedAudioPython = path.resolve(audioPythonPath ?? inferredAudioPython);
    const resolvedAudioWorker = path.resolve(audioWorkerScriptPath);
    const resolvedAudioModelDir = audioModelDir ? path.resolve(audioModelDir) : '';
    const resolvedModelDir = modelDir ? path.resolve(modelDir) : path.join(workerRoot, 'models', 'DA3-SMALL');
    const resolvedBaseModelDir = baseModelDir ? path.resolve(baseModelDir) : path.join(workerRoot, 'models', 'DA3-BASE');
    const resolvedPoseLandmarker = poseLandmarkerPath ? path.resolve(poseLandmarkerPath) : path.join(workerRoot, 'models', 'pose_landmarker_full.task');
    const resolvedFaceLandmarker = faceLandmarkerPath ? path.resolve(faceLandmarkerPath) : path.join(workerRoot, 'models', 'face_landmarker.task');
    const jobs = new Map();
    const depthQueue = [];
    const audioQueue = [];
    const sceneQueue = [];
    let activeDepthJobId = null;
    let activeAudioJobId = null;
    let activeSceneJobId = null;
    let sceneWorkerProcess = null;
    let sceneWorkerReady = false;
    let sceneWorkerBuffer = '';
    const sceneMetadata = new Map();
    let depthStartTimer = null;
    let audioStartTimer = null;
    let capabilitiesCache = null;
    const terminateProcess = (job) => {
        const child = job.process;
        if (!child)
            return;
        if (process.platform === 'win32' && child.pid) {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        }
        else {
            child.kill();
        }
    };
    const persistNow = (job) => {
        if (job.persistTimer)
            clearTimeout(job.persistTimer);
        delete job.persistTimer;
        fs.mkdirSync(job.directory, { recursive: true });
        const payload = { ...view(job), sourcePath: job.sourcePath };
        const temporary = path.join(job.directory, 'job.json.tmp');
        fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
        fs.renameSync(temporary, path.join(job.directory, 'job.json'));
    };
    const schedulePersist = (job) => {
        if (job.persistTimer)
            return;
        job.persistTimer = setTimeout(() => persistNow(job), 250);
    };
    const update = (job, patch, immediate = false) => {
        Object.assign(job, patch, { updatedAt: new Date().toISOString() });
        if (immediate)
            persistNow(job);
        else
            schedulePersist(job);
    };
    for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        const directory = path.join(jobsDir, entry.name);
        const manifestPath = path.join(directory, 'job.json');
        if (!fs.existsSync(manifestPath))
            continue;
        try {
            const stored = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const request = parseMediaTransformRequest(stored.request);
            const status = ACTIVE_STATUSES.has(stored.status) ? 'interrupted' : stored.status;
            const job = {
                ...stored,
                request,
                status,
                stage: status === 'interrupted' ? '服务重启，任务已中断' : stored.stage,
                ...(status === 'interrupted'
                    ? { message: '任务可从原媒体重新发起' }
                    : stored.message
                        ? { message: stored.message }
                        : {}),
                directory,
                sourcePath: stored.sourcePath ?? '',
                log: '',
                progressBuffer: ''
            };
            jobs.set(job.id, job);
            if (status === 'interrupted')
                persistNow(job);
        }
        catch {
            // Ignore corrupt job manifests without blocking server startup.
        }
    }
    const getCapabilities = (options) => {
        if (!options?.refresh && capabilitiesCache && Date.now() - capabilitiesCache.checkedAt < CAPABILITIES_CACHE_MS) {
            return capabilitiesCache.value;
        }
        const ffmpeg = executableAvailable(ffmpegPath);
        const ffprobe = executableAvailable(ffprobePath);
        const python = fs.existsSync(resolvedPython) && fs.statSync(resolvedPython).isFile();
        const depthWorker = python && fs.existsSync(resolvedWorker) && fs.statSync(resolvedWorker).isFile();
        let da3Small = false;
        let da3Base = false;
        let poseLandmarker = false;
        let faceLandmarker = false;
        let cuda = false;
        let nvenc = false;
        let deviceName;
        let reason;
        const audioPython = fs.existsSync(resolvedAudioPython) && fs.statSync(resolvedAudioPython).isFile();
        const audioWorker = audioPython && fs.existsSync(resolvedAudioWorker) && fs.statSync(resolvedAudioWorker).isFile();
        let audioModel = false;
        let audioCuda = false;
        let audioDeviceName;
        let audioReason;
        const omniShotCutWorker = fs.existsSync(resolvedScenePython) && fs.statSync(resolvedScenePython).isFile()
            && fs.existsSync(resolvedSceneWorker) && fs.statSync(resolvedSceneWorker).isFile();
        let omniShotCut = false;
        let omniShotCutModelReady = false;
        let omniShotCutModelPath;
        let omniShotCutVersion;
        let omniShotCutReason;
        if (depthWorker) {
            const probe = spawnSync(resolvedPython, [resolvedWorker, '--capabilities',
                '--small-model-dir', resolvedModelDir, '--base-model-dir', resolvedBaseModelDir,
                '--pose-model', resolvedPoseLandmarker, '--face-model', resolvedFaceLandmarker, '--ffmpeg', ffmpegPath], {
                windowsHide: true,
                encoding: 'utf8',
                timeout: 30000,
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
            });
            try {
                const parsed = parseLastJsonObject(probe.stdout || '');
                da3Small = parsed.da3Small === true;
                da3Base = parsed.da3Base === true;
                poseLandmarker = parsed.poseLandmarker === true;
                faceLandmarker = parsed.faceLandmarker === true;
                cuda = parsed.cuda === true;
                nvenc = parsed.nvenc === true;
                deviceName = typeof parsed.deviceName === 'string' ? parsed.deviceName : undefined;
                reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
            }
            catch {
                reason = (probe.stderr || '').trim().slice(-500) || 'Depth Worker 能力探测失败';
            }
        }
        else {
            reason = 'Depth Worker Python 或脚本不可用';
        }
        if (audioWorker) {
            const probe = spawnSync(resolvedAudioPython, [resolvedAudioWorker, '--capabilities',
                '--model-dir', resolvedAudioModelDir, '--ffmpeg', ffmpegPath], {
                windowsHide: true,
                encoding: 'utf8',
                timeout: 60000,
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
            });
            try {
                const parsed = parseLastJsonObject(probe.stdout || '');
                audioModel = parsed.audioModel === true;
                audioCuda = parsed.cuda === true;
                audioDeviceName = typeof parsed.deviceName === 'string' ? parsed.deviceName : undefined;
                audioReason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
            }
            catch {
                audioReason = (probe.stderr || '').trim().slice(-500) || 'Audio Worker 能力探测失败';
            }
        }
        else {
            audioReason = 'Audio Worker Python 或脚本不可用';
        }
        if (omniShotCutWorker) {
            const probe = spawnSync(resolvedScenePython, [resolvedSceneWorker, '--capabilities',
                ...(resolvedSceneCheckpoint ? ['--checkpoint-path', resolvedSceneCheckpoint] : [])], {
                windowsHide: true,
                encoding: 'utf8',
                timeout: 30000,
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
            });
            try {
                const parsed = parseLastJsonObject(probe.stdout || '');
                omniShotCut = parsed.omniShotCut === true;
                omniShotCutModelReady = parsed.modelReady === true;
                omniShotCutModelPath = typeof parsed.modelPath === 'string' ? parsed.modelPath : undefined;
                omniShotCutVersion = typeof parsed.version === 'string' ? parsed.version : undefined;
                omniShotCutReason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
            }
            catch {
                omniShotCutReason = (probe.stderr || '').trim().slice(-500) || 'OmniShotCut Worker 能力探测失败';
            }
        }
        else {
            omniShotCutReason = 'OmniShotCut Worker Python 或脚本不可用';
        }
        const value = {
            ffmpeg,
            ffprobe,
            python,
            depthWorker,
            da3Small,
            da3Base,
            poseLandmarker,
            faceLandmarker,
            cuda,
            nvenc,
            ...(deviceName ? { deviceName } : {}),
            audioPython,
            audioWorker,
            audioModel,
            audioCuda,
            ...(audioDeviceName ? { audioDeviceName } : {}),
            ...(audioReason ? { audioReason } : {}),
            omniShotCut,
            omniShotCutWorker,
            omniShotCutModelReady,
            ...(omniShotCutModelPath ? { omniShotCutModelPath } : {}),
            ...(omniShotCutVersion ? { omniShotCutVersion } : {}),
            ...(omniShotCutReason ? { omniShotCutReason } : {}),
            processResOptions: [...PROCESS_RES_OPTIONS],
            defaultProcessRes: cuda ? 504 : 336,
            ...(!da3Small && !da3Base && !poseLandmarker && !faceLandmarker && reason ? { reason } : {})
        };
        capabilitiesCache = { checkedAt: Date.now(), value };
        return value;
    };
    const probeMedia = (sourcePath) => new Promise((resolve, reject) => {
        const child = spawnProcess(ffprobePath, [
            '-v', 'error', '-show_entries', 'format=duration:stream=index,codec_type,width,height,duration,avg_frame_rate,nb_frames',
            '-of', 'json', sourcePath
        ], { windowsHide: true, stdio: 'pipe' });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        child.once('error', reject);
        child.once('exit', (code) => {
            if (code !== 0)
                return reject(new Error(stderr.trim() || `FFprobe exited with ${code}`));
            try {
                const parsed = JSON.parse(stdout);
                const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
                const formatDuration = Math.max(0, Number(parsed.format?.duration ?? 0));
                const videoDuration = Math.max(0, Number(video?.duration ?? 0));
                const duration = video && videoDuration > 0 ? videoDuration : formatDuration;
                const fps = Math.max(0, normalizeProbeRate(video?.avg_frame_rate));
                resolve({
                    width: Math.max(0, Math.round(video?.width ?? 0)),
                    height: Math.max(0, Math.round(video?.height ?? 0)),
                    duration,
                    fps,
                    frameCount: Math.max(0, Math.round(Number(video?.nb_frames ?? 0) || duration * fps)),
                    hasAudio: Boolean(parsed.streams?.some((stream) => stream.codec_type === 'audio'))
                });
            }
            catch (error) {
                reject(error);
            }
        });
    });
    const probeSceneMedia = async (sourcePath) => {
        const metadata = await probeMedia(sourcePath);
        const frameProbe = await new Promise((resolve, reject) => {
            const child = spawnProcess(ffprobePath, [
                '-v', 'error', '-select_streams', 'v:0', '-show_frames',
                '-show_entries', 'frame=best_effort_timestamp_time,pkt_duration_time',
                '-of', 'json', sourcePath
            ], { windowsHide: true, stdio: 'pipe' });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
            child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
            child.once('error', reject);
            child.once('exit', (code) => {
                if (code !== 0)
                    return reject(new Error(stderr.trim() || `FFprobe frame timeline exited with ${code}`));
                try {
                    const parsed = JSON.parse(stdout);
                    resolve(parsed.frames ?? []);
                }
                catch (error) {
                    reject(error);
                }
            });
        });
        if (frameProbe.length === 0)
            throw new Error('无法读取视频逐帧时间戳');
        const nominalDuration = metadata.fps > 0 ? 1 / metadata.fps : 1 / 30;
        const rawTimestamps = [];
        const frameDurations = [];
        frameProbe.forEach((frame, index) => {
            const parsedTimestamp = Number(frame.best_effort_timestamp_time);
            const previous = rawTimestamps[index - 1];
            const timestamp = Number.isFinite(parsedTimestamp)
                ? parsedTimestamp
                : previous === undefined ? 0 : previous + (frameDurations[index - 1] ?? nominalDuration);
            rawTimestamps.push(previous === undefined ? timestamp : Math.max(previous, timestamp));
            const parsedDuration = Number(frame.pkt_duration_time);
            frameDurations.push(Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : 0);
        });
        const timestampOrigin = rawTimestamps[0] ?? 0;
        const normalized = rawTimestamps.map((timestamp) => Math.max(0, timestamp - timestampOrigin));
        const intervals = normalized.slice(1).map((timestamp, index) => timestamp - normalized[index]).filter((value) => value > 0);
        const sortedIntervals = [...intervals].sort((left, right) => left - right);
        const medianInterval = sortedIntervals.length > 0
            ? sortedIntervals[Math.floor(sortedIntervals.length / 2)]
            : nominalDuration;
        const lastTimestamp = normalized[normalized.length - 1];
        const inferredDuration = lastTimestamp + (frameDurations[frameDurations.length - 1] || medianInterval);
        const finalDuration = Math.max(metadata.duration >= lastTimestamp - 0.000001 ? metadata.duration : inferredDuration, 0.001);
        const variableFrameRate = intervals.some((interval) => Math.abs(interval - medianInterval) > Math.max(0.001, medianInterval * 0.05));
        return {
            ...metadata,
            duration: finalDuration,
            fps: normalized.length / finalDuration,
            frameCount: normalized.length,
            frameTimestamps: [...normalized, finalDuration],
            timestampOrigin,
            variableFrameRate
        };
    };
    const finish = async (job, temporaryOutput, partial) => {
        const fileName = `${Date.now()}-${crypto.randomUUID()}-${job.kind}.mp4`;
        const { blob } = await persistAssetBlobFile({
            appDatabase,
            assetBlobsDir: libraryAssetsDir,
            filePath: temporaryOutput,
            detected: { kind: 'video', mime: 'video/mp4', extension: '.mp4' }
        });
        const historyAssetId = `history-${job.id}`;
        const thumbnailUrl = createLibraryThumbnail
            ? await createLibraryThumbnail(blob.sourcePath, 'video', blob.contentHash)
                .then((thumbnail) => thumbnail.publicUrl)
                .catch(() => undefined)
            : undefined;
        if (thumbnailUrl)
            appDatabase.updateAssetBlobThumbnail(blob.id, thumbnailUrl);
        const previewUrl = `/api/history-assets/${encodeURIComponent(historyAssetId)}/file?${new URLSearchParams({
            projectId: job.projectId,
            canvasId: job.canvasId
        })}`;
        appDatabase.upsertHistoryAssets([{
                id: historyAssetId,
                projectId: job.projectId,
                canvasId: job.canvasId,
                name: fileName,
                kind: 'video',
                source: job.kind === 'video_trim' ? '视频截取' : job.kind === 'video_scene_split' ? '智能切割' : '视觉分析',
                previewUrl,
                blobId: blob.id,
                ...(thumbnailUrl ? { thumbnailUrl } : {}),
                createdAt: new Date().toISOString(),
                metadata: { nodeId: job.sourceNodeId }
            }]);
        update(job, {
            status: 'completed',
            stage: '转换完成',
            progress: 1,
            result: {
                fileName,
                previewUrl,
                historyAssetId,
                ...(thumbnailUrl ? { thumbnailUrl } : {}),
                ...partial
            }
        }, true);
    };
    const audioOutputPath = (job, stem) => path.join(job.directory, `${stem}.mp3`);
    const cleanupJobOutputs = (job) => {
        fs.rmSync(path.join(job.directory, 'output.mp4'), { force: true });
        for (const entry of fs.readdirSync(job.directory, { withFileTypes: true })) {
            if (entry.isFile() && /^scene-\d+\.mp4$/i.test(entry.name))
                fs.rmSync(path.join(job.directory, entry.name), { force: true });
        }
        AUDIO_STEMS.forEach((stem) => fs.rmSync(audioOutputPath(job, stem), { force: true }));
    };
    const finishAudio = async (job, request) => {
        const metadata = await probeMedia(job.sourcePath);
        const sourceBase = (path.parse(job.sourcePath).name || 'audio')
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
            .slice(0, 96);
        const createdAt = new Date().toISOString();
        const results = [];
        const historyAssets = [];
        for (const stem of request.stems) {
            const temporaryOutput = audioOutputPath(job, stem);
            if (!fs.existsSync(temporaryOutput) || fs.statSync(temporaryOutput).size <= 0) {
                throw new Error(`${stem} MP3 输出不存在`);
            }
            const { blob } = await persistAssetBlobFile({
                appDatabase,
                assetBlobsDir: libraryAssetsDir,
                filePath: temporaryOutput,
                detected: { kind: 'audio', mime: 'audio/mpeg', extension: '.mp3' }
            });
            const stemLabel = stem === 'vocals' ? '人声' : '其它';
            const fileName = `${sourceBase}-${stemLabel}.mp3`;
            const historyAssetId = `history-${job.id}-${stem}`;
            const previewUrl = `/api/history-assets/${encodeURIComponent(historyAssetId)}/file?${new URLSearchParams({
                projectId: job.projectId,
                canvasId: job.canvasId
            })}`;
            historyAssets.push({
                id: historyAssetId,
                projectId: job.projectId,
                canvasId: job.canvasId,
                name: fileName,
                kind: 'audio',
                source: `声音分离 · ${stemLabel}`,
                previewUrl,
                blobId: blob.id,
                createdAt,
                metadata: { nodeId: job.sourceNodeId, operation: `audio_separate:${stem}` }
            });
            results.push({
                fileName,
                previewUrl,
                historyAssetId,
                width: 0,
                height: 0,
                resolution: '44.1 kHz · MP3',
                aspectRatio: '',
                duration: metadata.duration,
                fps: 0,
                frameCount: 0,
                sourceLabel: `声音分离 · ${stemLabel}`,
                stem,
                mimeType: 'audio/mpeg'
            });
        }
        appDatabase.upsertHistoryAssets(historyAssets);
        update(job, {
            status: 'completed',
            stage: '声音分离完成',
            progress: 1,
            results
        }, true);
    };
    const fail = (job, message) => {
        if (job.timeout)
            clearTimeout(job.timeout);
        delete job.process;
        cleanupJobOutputs(job);
        update(job, { status: 'failed', stage: '转换失败', message: message.slice(-1000) }, true);
    };
    const getCapabilityError = (request, capabilities) => {
        if (!capabilities.ffmpeg || !capabilities.ffprobe)
            return 'FFmpeg 或 FFprobe 不可用';
        if (request.layers.includes('depth')) {
            if (request.model === 'DA3-SMALL' && !capabilities.da3Small)
                return 'DA3-SMALL 权重或运行环境不可用';
            if (request.model === 'DA3-BASE' && !capabilities.da3Base)
                return 'DA3-BASE 权重或运行环境不可用';
        }
        if (request.layers.includes('pose') && !capabilities.poseLandmarker)
            return 'MediaPipe Pose Landmarker 不可用';
        if (request.subjectEnhancement && !capabilities.poseLandmarker)
            return '人物主体分割模型不可用';
        if (request.layers.includes('face') && !capabilities.faceLandmarker)
            return 'MediaPipe Face Landmarker 不可用';
        return null;
    };
    const getAudioCapabilityError = (capabilities) => {
        if (!capabilities.ffmpeg || !capabilities.ffprobe)
            return 'FFmpeg 或 FFprobe 不可用';
        if (!capabilities.audioWorker)
            return capabilities.audioReason || 'Audio Worker 不可用';
        if (!capabilities.audioModel)
            return capabilities.audioReason || '未配置声音分离模型目录';
        return null;
    };
    const runTrim = async (job, request) => {
        try {
            const metadata = await probeMedia(job.sourcePath);
            if (!metadata.width || !metadata.height || !metadata.duration)
                throw new Error('无法读取视频元数据');
            const start = request.startCs / 100;
            const end = request.endCs / 100;
            if (start < 0 || end <= start || end > metadata.duration + 0.01)
                throw new Error('截取范围超出视频时长');
            const duration = end - start;
            const outputPath = path.join(job.directory, 'output.mp4');
            const videoFilter = `[0:v:0]trim=start=${start.toFixed(2)}:end=${end.toFixed(2)},setpts=PTS-STARTPTS[v]`;
            const audioFilter = `[0:a:0]atrim=start=${start.toFixed(2)}:end=${end.toFixed(2)},asetpts=PTS-STARTPTS[a]`;
            const args = metadata.hasAudio
                ? ['-hide_banner', '-y', '-i', job.sourcePath, '-filter_complex', `${videoFilter};${audioFilter}`, '-map', '[v]', '-map', '[a]']
                : ['-hide_banner', '-y', '-i', job.sourcePath, '-vf', `trim=start=${start.toFixed(2)}:end=${end.toFixed(2)},setpts=PTS-STARTPTS`, '-an'];
            args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', ...(metadata.hasAudio ? ['-c:a', 'aac'] : []), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outputPath);
            const child = spawnProcess(ffmpegPath, args, { windowsHide: true, stdio: 'pipe' });
            job.process = child;
            update(job, { status: 'encoding', stage: 'FFmpeg 正在截取视频', progress: 0.02 }, true);
            let stderr = '';
            child.stdout.on('data', (chunk) => {
                const text = chunk.toString('utf8');
                const match = text.match(/out_time_us=(\d+)/);
                if (match)
                    update(job, { progress: Math.min(0.98, Number(match[1]) / 1000000 / duration) });
            });
            child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-64 * 1024); });
            job.timeout = setTimeout(() => {
                if (!ACTIVE_STATUSES.has(job.status))
                    return;
                terminateProcess(job);
                fail(job, '视频截取超时');
            }, timeoutMs);
            child.once('error', (error) => fail(job, error.message));
            child.once('exit', async (code) => {
                if (job.timeout)
                    clearTimeout(job.timeout);
                delete job.process;
                if (!ACTIVE_STATUSES.has(job.status))
                    return;
                if (code !== 0 || !fs.existsSync(outputPath))
                    return fail(job, stderr.trim() || `FFmpeg exited with ${code}`);
                try {
                    const resultProbe = await probeMedia(outputPath);
                    await finish(job, outputPath, {
                        width: resultProbe.width,
                        height: resultProbe.height,
                        resolution: `${resultProbe.width} × ${resultProbe.height}`,
                        aspectRatio: reducedRatio(resultProbe.width, resultProbe.height),
                        duration: resultProbe.duration,
                        fps: resultProbe.fps,
                        frameCount: resultProbe.frameCount,
                        sourceLabel: `视频截取 ${start.toFixed(2)}s-${end.toFixed(2)}s · FFmpeg`,
                        startCs: request.startCs,
                        endCs: request.endCs
                    });
                }
                catch (error) {
                    fail(job, error instanceof Error ? error.message : '视频截取结果校验失败');
                }
            });
        }
        catch (error) {
            fail(job, error instanceof Error ? error.message : '视频截取失败');
        }
    };
    let sceneWorkerDispatchedJobId = null;
    const terminateSceneWorker = () => {
        const child = sceneWorkerProcess;
        sceneWorkerProcess = null;
        sceneWorkerReady = false;
        sceneWorkerBuffer = '';
        sceneWorkerDispatchedJobId = null;
        if (!child)
            return;
        if (process.platform === 'win32' && child.pid) {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        }
        else {
            child.kill();
        }
    };
    const finishSceneDetection = (job, request, metadata, candidates) => {
        const sceneFrames = normalizeSceneCutFramesByTime(candidates, metadata.frameTimestamps, request.minClipDurationMs);
        update(job, {
            status: 'encoding',
            stage: '正在准备时间线预览',
            progress: 0.96,
            sceneFrames,
            sceneFps: metadata.fps,
            sceneFrameCount: metadata.frameCount,
            sceneFrameTimestamps: metadata.frameTimestamps,
            sceneDuration: metadata.duration,
            sceneVariableFrameRate: metadata.variableFrameRate
        }, true);
        void finalizeSceneDetect(job, metadata.duration);
    };
    const dispatchSceneWorkerJob = () => {
        if (!sceneWorkerReady || !sceneWorkerProcess || !activeSceneJobId || sceneWorkerDispatchedJobId === activeSceneJobId)
            return;
        const job = jobs.get(activeSceneJobId);
        if (!job || job.request.kind !== 'video_scene_detect' || !ACTIVE_STATUSES.has(job.status))
            return;
        sceneWorkerDispatchedJobId = job.id;
        update(job, { status: 'running', stage: 'OmniShotCut 正在分析镜头', progress: 0.08 }, true);
        job.timeout = setTimeout(() => {
            if (activeSceneJobId !== job.id || !ACTIVE_STATUSES.has(job.status))
                return;
            activeSceneJobId = null;
            sceneMetadata.delete(job.id);
            terminateSceneWorker();
            fail(job, 'OmniShotCut 镜头检测超时');
            void runNextScene();
        }, timeoutMs);
        sceneWorkerProcess.stdin.write(`${JSON.stringify({
            jobId: job.id,
            inputPath: job.sourcePath,
            mode: job.request.detectionMode
        })}\n`);
    };
    const runNextScene = async () => {
        if (activeSceneJobId)
            return;
        const job = sceneQueue.shift();
        if (!job || job.request.kind !== 'video_scene_detect')
            return;
        activeSceneJobId = job.id;
        try {
            const metadata = await probeSceneMedia(job.sourcePath);
            if (!metadata.width || !metadata.height || !metadata.duration || !metadata.fps)
                throw new Error('无法读取视频帧率或元数据');
            sceneMetadata.set(job.id, metadata);
            update(job, {
                status: 'running',
                stage: sceneWorkerReady ? 'OmniShotCut 正在分析镜头' : '正在加载 OmniShotCut 模型',
                progress: sceneWorkerReady ? 0.08 : 0.02
            }, true);
            if (!sceneWorkerProcess) {
                const args = [resolvedSceneWorker, ...(resolvedSceneCheckpoint ? ['--checkpoint-path', resolvedSceneCheckpoint] : [])];
                const child = spawnProcess(resolvedScenePython, args, {
                    windowsHide: true,
                    stdio: 'pipe',
                    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
                });
                sceneWorkerProcess = child;
                const append = (chunk) => {
                    const lines = `${sceneWorkerBuffer}${chunk.toString('utf8')}`.split(/\r?\n/);
                    sceneWorkerBuffer = (lines.pop() ?? '').slice(-16 * 1024);
                    for (const line of lines) {
                        const parsePayload = (prefix) => {
                            if (!line.startsWith(prefix))
                                return null;
                            try {
                                return JSON.parse(line.slice(prefix.length));
                            }
                            catch {
                                return {};
                            }
                        };
                        const ready = parsePayload('MK_SCENE_READY ');
                        if (ready) {
                            sceneWorkerReady = ready.ready === true;
                            const current = activeSceneJobId ? jobs.get(activeSceneJobId) : undefined;
                            if (current && typeof ready.stage === 'string')
                                update(current, { stage: ready.stage.slice(0, 160) });
                            if (sceneWorkerReady)
                                dispatchSceneWorkerJob();
                            continue;
                        }
                        const progress = parsePayload('MK_SCENE_PROGRESS ');
                        if (progress) {
                            const jobId = typeof progress.jobId === 'string' ? progress.jobId : '';
                            const current = jobs.get(jobId);
                            if (current && jobId === activeSceneJobId)
                                update(current, {
                                    ...(typeof progress.stage === 'string' ? { stage: progress.stage.slice(0, 160) } : {}),
                                    ...(typeof progress.progress === 'number' && Number.isFinite(progress.progress)
                                        ? { progress: Math.max(0.01, Math.min(0.94, progress.progress)) } : {})
                                });
                            continue;
                        }
                        const result = parsePayload('MK_SCENE_RESULT ');
                        if (result) {
                            const jobId = typeof result.jobId === 'string' ? result.jobId : '';
                            const current = jobs.get(jobId);
                            const metadata = sceneMetadata.get(jobId);
                            if (current && metadata && current.request.kind === 'video_scene_detect' && jobId === activeSceneJobId) {
                                if (current.timeout)
                                    clearTimeout(current.timeout);
                                const ranges = Array.isArray(result.ranges) ? result.ranges : [];
                                const candidates = ranges.flatMap((range) => Array.isArray(range) && typeof range[1] === 'number' ? [range[1]] : []);
                                activeSceneJobId = null;
                                sceneWorkerDispatchedJobId = null;
                                sceneMetadata.delete(jobId);
                                finishSceneDetection(current, current.request, metadata, candidates);
                                void runNextScene();
                            }
                            continue;
                        }
                        const workerError = parsePayload('MK_SCENE_ERROR ');
                        if (workerError) {
                            const jobId = typeof workerError.jobId === 'string' ? workerError.jobId : activeSceneJobId;
                            const current = jobId ? jobs.get(jobId) : undefined;
                            if (current && ACTIVE_STATUSES.has(current.status)) {
                                if (current.timeout)
                                    clearTimeout(current.timeout);
                                fail(current, typeof workerError.message === 'string' ? workerError.message : 'OmniShotCut 检测失败');
                            }
                            if (jobId && jobId === activeSceneJobId) {
                                activeSceneJobId = null;
                                sceneWorkerDispatchedJobId = null;
                                sceneMetadata.delete(jobId);
                            }
                        }
                    }
                };
                child.stdout.on('data', append);
                child.stderr.on('data', (chunk) => {
                    const current = activeSceneJobId ? jobs.get(activeSceneJobId) : undefined;
                    if (current)
                        current.log = `${current.log}${chunk.toString('utf8')}`.slice(-64 * 1024);
                });
                child.once('error', (error) => {
                    const current = activeSceneJobId ? jobs.get(activeSceneJobId) : undefined;
                    if (current && ACTIVE_STATUSES.has(current.status))
                        fail(current, error.message);
                });
                child.once('exit', (code) => {
                    if (sceneWorkerProcess === child)
                        sceneWorkerProcess = null;
                    sceneWorkerReady = false;
                    sceneWorkerBuffer = '';
                    sceneWorkerDispatchedJobId = null;
                    const currentId = activeSceneJobId;
                    activeSceneJobId = null;
                    if (currentId) {
                        const current = jobs.get(currentId);
                        sceneMetadata.delete(currentId);
                        if (current?.timeout)
                            clearTimeout(current.timeout);
                        if (current && ACTIVE_STATUSES.has(current.status))
                            fail(current, current.log.trim().slice(-1000) || `OmniShotCut Worker exited with ${code}`);
                    }
                    void runNextScene();
                });
            }
            dispatchSceneWorkerJob();
        }
        catch (error) {
            activeSceneJobId = null;
            sceneMetadata.delete(job.id);
            fail(job, error instanceof Error ? error.message : 'OmniShotCut 检测失败');
            void runNextScene();
        }
    };
    const runSceneDetect = async (job, request) => {
        if (request.algorithm === 'omnishotcut') {
            sceneQueue.push(job);
            void runNextScene();
            return;
        }
        try {
            const metadata = await probeSceneMedia(job.sourcePath);
            if (!metadata.width || !metadata.height || !metadata.duration || !metadata.fps)
                throw new Error('无法读取视频帧率或元数据');
            const child = spawnProcess(ffmpegPath, [
                '-hide_banner', '-i', job.sourcePath,
                '-vf', `select='gt(scene,${request.sceneThreshold.toFixed(2)})',showinfo`,
                '-an', '-f', 'null', '-'
            ], { windowsHide: true, stdio: 'pipe' });
            job.process = child;
            update(job, { status: 'running', stage: '正在检测镜头边界', progress: 0.03 }, true);
            let stderr = '';
            child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-512 * 1024); });
            job.timeout = setTimeout(() => {
                if (!ACTIVE_STATUSES.has(job.status))
                    return;
                terminateProcess(job);
                fail(job, '镜头边界检测超时');
            }, timeoutMs);
            child.once('error', (error) => fail(job, error.message));
            child.once('exit', (code) => {
                if (job.timeout)
                    clearTimeout(job.timeout);
                delete job.process;
                if (!ACTIVE_STATUSES.has(job.status))
                    return;
                if (code !== 0)
                    return fail(job, stderr.trim() || `FFmpeg exited with ${code}`);
                const candidates = Array.from(stderr.matchAll(/pts_time:([0-9.]+)/g))
                    .map((match) => sceneTimeToFrame(metadata.frameTimestamps, Number(match[1]) - metadata.timestampOrigin))
                    .filter((frame) => Number.isFinite(frame) && frame > 0 && frame < metadata.frameCount);
                finishSceneDetection(job, request, metadata, candidates);
            });
        }
        catch (error) {
            fail(job, error instanceof Error ? error.message : '镜头边界检测失败');
        }
    };
    const finalizeSceneDetect = async (job, duration) => {
        job.timeout = setTimeout(() => {
            if (!ACTIVE_STATUSES.has(job.status))
                return;
            terminateProcess(job);
            fail(job, '时间线预览准备超时');
        }, timeoutMs);
        const preview = await createScenePreviewFrames(job, duration);
        const proxy = ACTIVE_STATUSES.has(job.status) ? await createSceneScrubProxy(job) : undefined;
        if (job.timeout)
            clearTimeout(job.timeout);
        if (jobs.get(job.id) !== job || !ACTIVE_STATUSES.has(job.status))
            return;
        update(job, {
            status: 'completed',
            stage: '镜头边界检测完成',
            progress: 1,
            ...preview,
            ...proxy
        }, true);
    };
    const createScenePreviewFrames = async (job, duration) => {
        const outputDirectory = path.join(job.directory, 'timeline-frames');
        const outputPattern = path.join(outputDirectory, 'frame-%03d.webp');
        const frameRate = Math.max(0.01, SCENE_PREVIEW_FRAME_COUNT / Math.max(0.1, duration));
        try {
            fs.mkdirSync(outputDirectory, { recursive: true });
            const child = spawnProcess(ffmpegPath, [
                '-hide_banner', '-loglevel', 'error', '-y', '-i', job.sourcePath,
                '-vf', `fps=${frameRate.toFixed(6)},scale=160:90:force_original_aspect_ratio=increase,crop=160:90`,
                '-frames:v', String(SCENE_PREVIEW_FRAME_COUNT), '-c:v', 'libwebp', '-q:v', '72', outputPattern
            ], { windowsHide: true, stdio: 'pipe' });
            job.process = child;
            let stderr = '';
            child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8 * 1024); });
            await new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', (code) => {
                    if (code === 0 && fs.existsSync(outputDirectory))
                        resolve();
                    else
                        reject(new Error(stderr.trim() || `FFmpeg exited with ${code}`));
                });
            });
            if (job.process === child)
                delete job.process;
            if (jobs.get(job.id) !== job)
                return;
            const previewFiles = fs.readdirSync(outputDirectory)
                .filter((fileName) => /^frame-\d{3}\.webp$/.test(fileName))
                .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
            if (previewFiles.length === 0)
                return;
            return {
                scenePreviewUrl: `/api/media-transforms/jobs/${encodeURIComponent(job.id)}/timeline-preview/0`,
                scenePreviewFrameCount: previewFiles.length,
                scenePreviewUrls: previewFiles.map((_fileName, index) => `/api/media-transforms/jobs/${encodeURIComponent(job.id)}/timeline-preview/${index}`)
            };
        }
        catch {
            // The timeline remains operable without thumbnails. Scene detection is already authoritative.
            return undefined;
        }
    };
    const createSceneScrubProxy = async (job) => {
        const outputPath = path.join(job.directory, 'timeline-scrub-proxy.mp4');
        try {
            const child = spawnProcess(ffmpegPath, [
                '-hide_banner', '-loglevel', 'error', '-y', '-i', job.sourcePath,
                '-map', '0:v:0', '-an',
                '-vf', `scale='min(${SCENE_SCRUB_MAX_EDGE},iw)':'min(${SCENE_SCRUB_MAX_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`,
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
                '-fps_mode', 'passthrough',
                '-g', '1', '-keyint_min', '1', '-sc_threshold', '0', '-movflags', '+faststart', outputPath
            ], { windowsHide: true, stdio: 'pipe' });
            job.process = child;
            let stderr = '';
            await new Promise((resolve, reject) => {
                child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8 * 1024); });
                child.once('error', reject);
                child.once('exit', (code) => {
                    if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0)
                        resolve();
                    else
                        reject(new Error(stderr.trim() || `FFmpeg exited with ${code}`));
                });
            });
            if (job.process === child)
                delete job.process;
            if (jobs.get(job.id) !== job)
                return;
            return { sceneScrubProxyUrl: `/api/media-transforms/jobs/${encodeURIComponent(job.id)}/timeline-scrub-proxy` };
        }
        catch {
            // The original source remains available if the optional drag proxy cannot be encoded.
            return undefined;
        }
    };
    const runSceneSplit = async (job, request) => {
        try {
            const metadata = await probeSceneMedia(job.sourcePath);
            if (!metadata.width || !metadata.height || !metadata.duration || !metadata.fps)
                throw new Error('无法读取视频帧率或元数据');
            const finalFrame = metadata.frameCount;
            const segments = request.segments;
            if (segments[0]?.startFrame !== 0 || segments[segments.length - 1]?.endFrame !== finalFrame)
                throw new Error('智能切割范围必须覆盖完整视频');
            if (segments.some((segment) => segment.endFrame > finalFrame
                || frameToSceneTime(metadata.frameTimestamps, segment.endFrame) - frameToSceneTime(metadata.frameTimestamps, segment.startFrame) < request.minClipDurationMs / 1000)) {
                throw new Error('智能切割片段短于最短时长或超出视频范围');
            }
            const outputs = segments.map((segment, index) => ({
                path: path.join(job.directory, `scene-${String(index).padStart(3, '0')}.mp4`),
                ...segment
            }));
            const cutTimes = segments.slice(0, -1).map((segment) => frameToSceneTime(metadata.frameTimestamps, segment.endFrame).toFixed(6));
            const positiveIntervals = metadata.frameTimestamps.slice(1)
                .map((timestamp, index) => timestamp - metadata.frameTimestamps[index])
                .filter((interval) => interval > 0);
            const segmentTimeDelta = Math.max(0.000001, Math.min(...positiveIntervals, 1 / metadata.fps) / 2);
            const useNvenc = getCapabilities().nvenc;
            const videoCodecArgs = sceneVideoCodecArgs(useNvenc);
            const outputPattern = path.join(job.directory, 'scene-%03d.mp4');
            const args = [
                '-hide_banner', '-y', '-i', job.sourcePath,
                '-map', '0:v:0', ...(metadata.hasAudio ? ['-map', '0:a:0'] : ['-an']),
                ...videoCodecArgs, '-pix_fmt', 'yuv420p',
                '-fps_mode', 'passthrough',
                ...(metadata.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []),
                ...(cutTimes.length ? ['-force_key_frames', cutTimes.join(',')] : []),
                '-f', 'segment',
                ...(cutTimes.length ? ['-segment_times', cutTimes.join(',')] : []),
                '-segment_time_delta', segmentTimeDelta.toFixed(9),
                '-reset_timestamps', '1',
                '-segment_format', 'mp4',
                '-segment_format_options', 'movflags=+faststart',
                '-progress', 'pipe:1', '-nostats', outputPattern
            ];
            const child = spawnProcess(ffmpegPath, args, { windowsHide: true, stdio: 'pipe' });
            job.process = child;
            let stderr = '';
            update(job, { status: 'encoding', stage: 'FFmpeg 正在智能切割', progress: 0.01 }, true);
            job.timeout = setTimeout(() => {
                if (!ACTIVE_STATUSES.has(job.status))
                    return;
                terminateProcess(job);
                fail(job, '智能切割超时');
            }, timeoutMs);
            child.stdout.on('data', (chunk) => {
                const match = chunk.toString('utf8').match(/out_time_us=(\d+)/);
                if (match)
                    update(job, { progress: Math.min(0.98, Math.max(0.01, Number(match[1]) / 1000000 / metadata.duration)) });
            });
            child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-64 * 1024); });
            await new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', (code) => {
                    delete job.process;
                    if (!ACTIVE_STATUSES.has(job.status))
                        return resolve();
                    if (code !== 0 || outputs.some((output) => !fs.existsSync(output.path)))
                        return reject(new Error(stderr.trim() || `FFmpeg exited with ${code}`));
                    resolve();
                });
            });
            if (!ACTIVE_STATUSES.has(job.status))
                return;
            if (job.timeout)
                clearTimeout(job.timeout);
            const sourceBase = path.parse(job.sourcePath).name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 96) || 'video';
            const results = [];
            const historyAssets = [];
            for (let index = 0; index < outputs.length; index += 1) {
                const output = outputs[index];
                const fileName = `${sourceBase}-镜头-${String(index + 1).padStart(2, '0')}.mp4`;
                const historyAssetId = `history-${job.id}-${index + 1}`;
                const { blob } = await persistAssetBlobFile({ appDatabase, assetBlobsDir: libraryAssetsDir, filePath: output.path, detected: { kind: 'video', mime: 'video/mp4', extension: '.mp4' } });
                const previewUrl = `/api/history-assets/${encodeURIComponent(historyAssetId)}/file?${new URLSearchParams({ projectId: job.projectId, canvasId: job.canvasId })}`;
                const startTime = frameToSceneTime(metadata.frameTimestamps, output.startFrame);
                const endTime = frameToSceneTime(metadata.frameTimestamps, output.endFrame);
                const frameCount = output.endFrame - output.startFrame;
                const segmentDuration = endTime - startTime;
                historyAssets.push({ id: historyAssetId, projectId: job.projectId, canvasId: job.canvasId, name: fileName, kind: 'video', source: '智能切割', previewUrl, blobId: blob.id, createdAt: new Date().toISOString(), metadata: { nodeId: job.sourceNodeId, operation: `video_scene_split:${output.startFrame}-${output.endFrame}` } });
                results.push({ fileName, previewUrl, historyAssetId, width: metadata.width, height: metadata.height, resolution: `${metadata.width} × ${metadata.height}`, aspectRatio: reducedRatio(metadata.width, metadata.height), duration: segmentDuration, fps: segmentDuration > 0 ? frameCount / segmentDuration : metadata.fps, frameCount, sourceLabel: `智能切割 · 镜头 ${String(index + 1).padStart(2, '0')}`, startFrame: output.startFrame, endFrame: output.endFrame });
                if (createLibraryThumbnail) {
                    void createLibraryThumbnail(blob.sourcePath, 'video', blob.contentHash)
                        .then((thumbnail) => appDatabase.updateAssetBlobThumbnail(blob.id, thumbnail.publicUrl))
                        .catch(() => undefined);
                }
            }
            appDatabase.upsertHistoryAssets(historyAssets);
            update(job, { status: 'completed', stage: '智能切割完成', progress: 1, results }, true);
        }
        catch (error) {
            fail(job, error instanceof Error ? error.message : '智能切割失败');
        }
    };
    const runNextDepth = () => {
        if (activeDepthJobId)
            return;
        const job = depthQueue.shift();
        if (!job)
            return;
        activeDepthJobId = job.id;
        const request = job.request;
        const outputPath = path.join(job.directory, 'output.mp4');
        const capabilities = getCapabilities();
        const capabilityError = getCapabilityError(request, capabilities);
        if (capabilityError) {
            activeDepthJobId = null;
            fail(job, capabilityError);
            runNextDepth();
            return;
        }
        const selectedModelDir = request.model === 'DA3-BASE' ? resolvedBaseModelDir : resolvedModelDir;
        const args = [resolvedWorker, '--input', job.sourcePath, '--output', outputPath, '--model-dir', selectedModelDir,
            '--model', request.model, '--process-res', String(request.processRes), '--layers', request.layers.join(','),
            '--depth-mapping', request.depthMapping, '--pose-model', resolvedPoseLandmarker, '--face-model', resolvedFaceLandmarker,
            '--face-mode', request.faceMode, ...(request.subjectEnhancement ? ['--subject-enhancement'] : []),
            '--ffmpeg', ffmpegPath, '--ffprobe', ffprobePath];
        const child = spawnProcess(resolvedPython, args, {
            cwd: job.directory,
            windowsHide: true,
            stdio: 'pipe',
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
        });
        job.process = child;
        update(job, { status: 'running', stage: '正在启动视频分析', progress: 0 }, true);
        const append = (chunk) => {
            const text = chunk.toString('utf8');
            job.log = `${job.log}${text}`.slice(-64 * 1024);
            const lines = `${job.progressBuffer}${text}`.split(/\r?\n/);
            job.progressBuffer = (lines.pop() ?? '').slice(-4096);
            for (const line of lines) {
                if (!line.startsWith('MK_DEPTH_PROGRESS '))
                    continue;
                try {
                    const progress = JSON.parse(line.slice('MK_DEPTH_PROGRESS '.length));
                    update(job, {
                        ...(typeof progress.stage === 'string' ? { stage: progress.stage.slice(0, 160) } : {}),
                        ...(typeof progress.progress === 'number' && Number.isFinite(progress.progress)
                            ? { progress: Math.max(0, Math.min(0.99, progress.progress)) } : {})
                    });
                }
                catch {
                    // The final worker result remains authoritative.
                }
            }
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        job.timeout = setTimeout(() => {
            if (!ACTIVE_STATUSES.has(job.status))
                return;
            terminateProcess(job);
            fail(job, '视频分析转换超时');
        }, timeoutMs);
        child.once('error', (error) => {
            activeDepthJobId = null;
            fail(job, error.message);
            runNextDepth();
        });
        child.once('exit', async (code) => {
            if (job.timeout)
                clearTimeout(job.timeout);
            delete job.process;
            activeDepthJobId = null;
            if (ACTIVE_STATUSES.has(job.status)) {
                if (code !== 0 || !fs.existsSync(outputPath)) {
                    fail(job, job.log.trim().slice(-1000) || `Depth Worker exited with ${code}`);
                }
                else {
                    try {
                        const metadata = await probeMedia(outputPath);
                        const layerLabels = request.layers.map((layer) => ({ depth: '深度', pose: '姿态', face: '面部' })[layer]);
                        await finish(job, outputPath, {
                            width: metadata.width,
                            height: metadata.height,
                            resolution: `${metadata.width} × ${metadata.height}`,
                            aspectRatio: reducedRatio(metadata.width, metadata.height),
                            duration: metadata.duration,
                            fps: metadata.fps,
                            frameCount: metadata.frameCount,
                            sourceLabel: `视觉分析 · ${layerLabels.join('+')}${request.layers.includes('depth') ? ` · ${request.model}` : ''}${request.subjectEnhancement ? ' · 主体增强' : ''} · ${request.processRes}`,
                            model: request.model,
                            processRes: request.processRes,
                            layers: request.layers,
                            depthMapping: request.depthMapping,
                            faceMode: request.faceMode,
                            subjectEnhancement: request.subjectEnhancement
                        });
                    }
                    catch (error) {
                        fail(job, error instanceof Error ? error.message : '深度视频结果校验失败');
                    }
                }
            }
            runNextDepth();
        });
    };
    const scheduleNextDepth = () => {
        if (activeDepthJobId || depthStartTimer)
            return;
        depthStartTimer = setTimeout(() => {
            depthStartTimer = null;
            runNextDepth();
        }, DEPTH_START_DEFER_MS);
    };
    const runNextAudio = () => {
        if (activeAudioJobId)
            return;
        const job = audioQueue.shift();
        if (!job)
            return;
        activeAudioJobId = job.id;
        const request = job.request;
        const capabilities = getCapabilities();
        const capabilityError = getAudioCapabilityError(capabilities);
        if (capabilityError) {
            activeAudioJobId = null;
            fail(job, capabilityError);
            runNextAudio();
            return;
        }
        const args = [resolvedAudioWorker, '--input', job.sourcePath, '--output-dir', job.directory,
            '--model-dir', resolvedAudioModelDir, '--stems', request.stems.join(','), '--format', request.outputFormat,
            '--ffmpeg', ffmpegPath];
        const child = spawnProcess(resolvedAudioPython, args, {
            cwd: job.directory,
            windowsHide: true,
            stdio: 'pipe',
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
        });
        job.process = child;
        update(job, { status: 'running', stage: '正在启动声音分离', progress: 0 }, true);
        const append = (chunk) => {
            const text = chunk.toString('utf8');
            job.log = `${job.log}${text}`.slice(-64 * 1024);
            const lines = `${job.progressBuffer}${text}`.split(/\r?\n/);
            job.progressBuffer = (lines.pop() ?? '').slice(-4096);
            for (const line of lines) {
                if (!line.startsWith('MK_AUDIO_PROGRESS '))
                    continue;
                try {
                    const progress = JSON.parse(line.slice('MK_AUDIO_PROGRESS '.length));
                    update(job, {
                        ...(typeof progress.stage === 'string' ? { stage: progress.stage.slice(0, 160) } : {}),
                        ...(typeof progress.progress === 'number' && Number.isFinite(progress.progress)
                            ? { progress: Math.max(0, Math.min(0.99, progress.progress)) } : {})
                    });
                }
                catch {
                    // Output files and the worker exit code remain authoritative.
                }
            }
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        job.timeout = setTimeout(() => {
            if (!ACTIVE_STATUSES.has(job.status))
                return;
            terminateProcess(job);
            fail(job, '声音分离超时');
        }, timeoutMs);
        child.once('error', (error) => {
            if (activeAudioJobId === job.id)
                activeAudioJobId = null;
            fail(job, error.message);
            runNextAudio();
        });
        child.once('exit', async (code) => {
            if (job.timeout)
                clearTimeout(job.timeout);
            delete job.process;
            if (activeAudioJobId === job.id)
                activeAudioJobId = null;
            if (ACTIVE_STATUSES.has(job.status)) {
                if (code !== 0 || request.stems.some((stem) => !fs.existsSync(audioOutputPath(job, stem)))) {
                    fail(job, job.log.trim().slice(-1000) || `Audio Worker exited with ${code}`);
                }
                else {
                    try {
                        update(job, { status: 'encoding', stage: '正在保存分离结果', progress: 0.99 }, true);
                        await finishAudio(job, request);
                    }
                    catch (error) {
                        fail(job, error instanceof Error ? error.message : '声音分离结果校验失败');
                    }
                }
            }
            runNextAudio();
        });
    };
    const scheduleNextAudio = () => {
        if (activeAudioJobId || audioStartTimer)
            return;
        audioStartTimer = setTimeout(() => {
            audioStartTimer = null;
            runNextAudio();
        }, DEPTH_START_DEFER_MS);
    };
    return {
        getCapabilities,
        listJobs: (scope) => Array.from(jobs.values())
            .filter((job) => (!scope?.projectId || job.projectId === scope.projectId) && (!scope?.canvasId || job.canvasId === scope.canvasId))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map(view),
        getJob: (id) => jobs.has(id) ? view(jobs.get(id)) : null,
        getScenePreviewPath(id, index = 0) {
            const job = jobs.get(id);
            if (!job || job.kind !== 'video_scene_detect')
                return null;
            if (!Number.isInteger(index) || index < 0 || index >= SCENE_PREVIEW_FRAME_COUNT)
                return null;
            const previewPath = path.join(job.directory, 'timeline-frames', `frame-${String(index + 1).padStart(3, '0')}.webp`);
            return fs.existsSync(previewPath) && fs.statSync(previewPath).isFile() ? previewPath : null;
        },
        getSceneScrubProxyPath(id) {
            const job = jobs.get(id);
            if (!job || job.kind !== 'video_scene_detect')
                return null;
            const proxyPath = path.join(job.directory, 'timeline-scrub-proxy.mp4');
            return fs.existsSync(proxyPath) && fs.statSync(proxyPath).isFile() ? proxyPath : null;
        },
        createJob(value) {
            const request = parseMediaTransformRequest(value);
            if (request.kind === 'video_trim' || request.kind === 'video_scene_detect' || request.kind === 'video_scene_split') {
                if (!executableAvailable(ffmpegPath) || !executableAvailable(ffprobePath))
                    throw new Error('FFmpeg 或 FFprobe 不可用');
                if (request.kind === 'video_scene_detect' && request.algorithm === 'omnishotcut') {
                    const capabilities = getCapabilities();
                    if (!capabilities.omniShotCut)
                        throw new Error(capabilities.omniShotCutReason || 'OmniShotCut 不可用');
                }
            }
            else if (request.kind === 'video_depth' && capabilitiesCache) {
                // Only the warm cache is consulted here on purpose: job creation must return immediately and
                // must never block on a cold Python capability probe. The UI gates this action on the same
                // capabilities it fetches when the panel opens, so a cold cache is not user-reachable.
                const capabilityError = getCapabilityError(request, capabilitiesCache.value);
                if (capabilityError)
                    throw new Error(capabilityError);
            }
            else if (request.kind === 'audio_separate' && capabilitiesCache) {
                const capabilityError = getAudioCapabilityError(capabilitiesCache.value);
                if (capabilityError)
                    throw new Error(capabilityError);
            }
            const sourcePath = resolveLinkedSource?.(request.sourceUrl)
                ?? resolveControlledMediaSource(request.sourceUrl, sourceRoots);
            const id = `media-transform-${crypto.randomUUID()}`;
            const directory = path.join(jobsDir, id);
            fs.mkdirSync(directory, { recursive: true });
            const now = new Date().toISOString();
            const job = {
                id,
                kind: request.kind,
                status: 'queued',
                projectId: request.projectId,
                canvasId: request.canvasId,
                sourceNodeId: request.sourceNodeId,
                request,
                stage: request.kind === 'video_depth' ? '等待视频分析转换' : request.kind === 'audio_separate' ? '等待声音分离' : request.kind === 'video_scene_detect' ? '等待镜头边界检测' : request.kind === 'video_scene_split' ? '等待智能切割' : '等待视频截取',
                progress: 0,
                createdAt: now,
                updatedAt: now,
                directory,
                sourcePath,
                log: '',
                progressBuffer: ''
            };
            jobs.set(id, job);
            persistNow(job);
            if (request.kind === 'video_trim')
                void runTrim(job, request);
            else if (request.kind === 'video_scene_detect')
                void runSceneDetect(job, request);
            else if (request.kind === 'video_scene_split')
                void runSceneSplit(job, request);
            else if (request.kind === 'video_depth') {
                depthQueue.push(job);
                scheduleNextDepth();
            }
            else {
                audioQueue.push(job);
                scheduleNextAudio();
            }
            return view(job);
        },
        cancelJob(id) {
            const job = jobs.get(id);
            if (!job)
                return null;
            if (!ACTIVE_STATUSES.has(job.status))
                return view(job);
            const queueIndex = depthQueue.findIndex((item) => item.id === id);
            if (queueIndex >= 0)
                depthQueue.splice(queueIndex, 1);
            const audioQueueIndex = audioQueue.findIndex((item) => item.id === id);
            if (audioQueueIndex >= 0)
                audioQueue.splice(audioQueueIndex, 1);
            const sceneQueueIndex = sceneQueue.findIndex((item) => item.id === id);
            if (sceneQueueIndex >= 0)
                sceneQueue.splice(sceneQueueIndex, 1);
            if (activeSceneJobId === id) {
                activeSceneJobId = null;
                sceneMetadata.delete(id);
                terminateSceneWorker();
            }
            terminateProcess(job);
            if (job.timeout)
                clearTimeout(job.timeout);
            cleanupJobOutputs(job);
            update(job, { status: 'cancelled', stage: '任务已取消', message: '用户取消了媒体转换' }, true);
            if (activeDepthJobId === id) {
                activeDepthJobId = null;
                runNextDepth();
            }
            if (activeAudioJobId === id) {
                activeAudioJobId = null;
                runNextAudio();
            }
            if (!activeSceneJobId)
                void runNextScene();
            return view(job);
        },
        deleteScopeJobs(scope) {
            const deleting = Array.from(jobs.values()).filter((job) => (job.projectId === scope.projectId && (!scope.canvasId || job.canvasId === scope.canvasId)));
            deleting.forEach((job) => {
                const queueIndex = depthQueue.findIndex((item) => item.id === job.id);
                if (queueIndex >= 0)
                    depthQueue.splice(queueIndex, 1);
                const audioQueueIndex = audioQueue.findIndex((item) => item.id === job.id);
                if (audioQueueIndex >= 0)
                    audioQueue.splice(audioQueueIndex, 1);
                const sceneQueueIndex = sceneQueue.findIndex((item) => item.id === job.id);
                if (sceneQueueIndex >= 0)
                    sceneQueue.splice(sceneQueueIndex, 1);
                terminateProcess(job);
                if (job.timeout)
                    clearTimeout(job.timeout);
                if (job.persistTimer)
                    clearTimeout(job.persistTimer);
                if (activeDepthJobId === job.id)
                    activeDepthJobId = null;
                if (activeAudioJobId === job.id)
                    activeAudioJobId = null;
                if (activeSceneJobId === job.id) {
                    activeSceneJobId = null;
                    sceneMetadata.delete(job.id);
                    terminateSceneWorker();
                }
                fs.rmSync(job.directory, { recursive: true, force: true });
                jobs.delete(job.id);
            });
            if (!activeDepthJobId)
                runNextDepth();
            if (!activeAudioJobId)
                runNextAudio();
            if (!activeSceneJobId)
                void runNextScene();
            return deleting.length;
        },
        close() {
            if (depthStartTimer)
                clearTimeout(depthStartTimer);
            depthStartTimer = null;
            if (audioStartTimer)
                clearTimeout(audioStartTimer);
            audioStartTimer = null;
            terminateSceneWorker();
            jobs.forEach((job) => {
                if (job.persistTimer)
                    clearTimeout(job.persistTimer);
                if (job.timeout)
                    clearTimeout(job.timeout);
                if (ACTIVE_STATUSES.has(job.status)) {
                    update(job, {
                        status: 'interrupted',
                        stage: '服务关闭，任务已中断',
                        message: '任务可从原媒体重新发起'
                    }, true);
                    terminateProcess(job);
                    cleanupJobOutputs(job);
                }
                persistNow(job);
            });
        }
    };
};
