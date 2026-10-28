import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sweepExpiredJobDirectories } from './jobDirectorySweep.js';
const MAX_DURATION_SECONDS = 30;
const MAX_PROMPT_SEGMENTS = 24;
const MAX_PATH_POINTS = 512;
const RIG_VERSION = 'mk-ue4-67-v1';
const MIXAMO_NATIVE_RIG_VERSION = 'mixamo-native-v1';
const DEFAULT_UE5_RETARGETER_ASSET = '/Game/MK_Retarget/RTG_Mixamo_To_MK_UE4_Balanced';
const DEFAULT_UE5_SOURCE_SKELETON_ASSET = '/Game/MK_Retarget/SK_Mixamo_Skeleton';
const ROOT_MOTION_MODES = new Set(['original', 'in-place', 'grounded']);
const MOTION_PRESET_CATEGORIES = new Set(['idle', 'walk', 'run', 'start', 'stop', 'turn', 'jump', 'acting']);
const safeText = (value, label, maxLength) => {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`${label} 不能为空`);
    return value.trim().slice(0, maxLength);
};
const optionalId = (value, label) => {
    if (value === undefined || value === null || value === '')
        return undefined;
    return safeText(value, label, 160);
};
const finiteNumber = (value, label, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${label} 必须是 ${min} 到 ${max} 之间的有限数值`);
    }
    return value;
};
const resolveRootMotionMode = (value) => {
    const mode = value === undefined ? 'grounded' : value;
    if (typeof mode !== 'string' || !ROOT_MOTION_MODES.has(mode)) {
        throw new Error('rootMotionMode 不受支持');
    }
    return mode;
};
const resolveControlledSource = (url, roots) => {
    const root = roots.find((candidate) => url.startsWith(`${candidate.prefix}/`));
    if (!root)
        throw new Error('视频输入必须来自 MK 受控素材');
    let relative;
    try {
        relative = decodeURIComponent(url.slice(root.prefix.length + 1));
    }
    catch {
        throw new Error('视频输入路径编码无效');
    }
    if (!relative || relative.includes('/') || relative.includes('\\') || relative.includes('..') || path.basename(relative) !== relative) {
        throw new Error('视频输入路径无效');
    }
    const resolvedRoot = path.resolve(root.rootDir);
    const resolved = path.resolve(resolvedRoot, relative);
    if (!resolved.startsWith(`${resolvedRoot}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error('视频输入文件不存在');
    }
    return resolved;
};
const parseRequest = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('任务请求必须是对象');
    const input = value;
    const projectId = optionalId(input.projectId, 'projectId');
    const characterId = optionalId(input.characterId, 'characterId');
    const common = {
        ...(projectId ? { projectId } : {}),
        ...(characterId ? { characterId } : {}),
        name: safeText(input.name, 'name', 120),
        rootMotionMode: resolveRootMotionMode(input.rootMotionMode)
    };
    if (input.kind === 'mediapipe_capture') {
        if (input.captureCameraMotion !== undefined && typeof input.captureCameraMotion !== 'boolean') {
            throw new Error('captureCameraMotion 必须是布尔值');
        }
        if (input.sampleFps !== undefined && input.sampleFps !== 15 && input.sampleFps !== 24) {
            throw new Error('sampleFps 只支持 15 或 24');
        }
        if (input.poseModel !== undefined && input.poseModel !== 'lite' && input.poseModel !== 'full') {
            throw new Error('poseModel 只支持 lite 或 full');
        }
        return {
            kind: 'mediapipe_capture',
            ...common,
            sourceUrl: safeText(input.sourceUrl, 'sourceUrl', 2048),
            captureCameraMotion: input.captureCameraMotion !== false,
            sampleFps: input.sampleFps === 15 ? 15 : 24,
            poseModel: input.poseModel === 'full' ? 'full' : 'lite'
        };
    }
    if (input.kind === 'kimodo_generate') {
        if (!Array.isArray(input.promptSegments) || input.promptSegments.length === 0 || input.promptSegments.length > MAX_PROMPT_SEGMENTS) {
            throw new Error(`promptSegments 必须包含 1-${MAX_PROMPT_SEGMENTS} 段`);
        }
        const promptSegments = input.promptSegments.map((segment, index) => {
            if (!segment || typeof segment !== 'object' || Array.isArray(segment))
                throw new Error(`promptSegments[${index}] 必须是对象`);
            const record = segment;
            return {
                text: safeText(record.text, `promptSegments[${index}].text`, 1000),
                durationSeconds: finiteNumber(record.durationSeconds, `promptSegments[${index}].durationSeconds`, 0.1, MAX_DURATION_SECONDS)
            };
        });
        if (promptSegments.reduce((total, segment) => total + segment.durationSeconds, 0) > MAX_DURATION_SECONDS) {
            throw new Error(`单次动作最长 ${MAX_DURATION_SECONDS} 秒`);
        }
        const rootPath = input.rootPath === undefined ? undefined : (() => {
            if (!Array.isArray(input.rootPath) || input.rootPath.length > MAX_PATH_POINTS)
                throw new Error(`rootPath 最多 ${MAX_PATH_POINTS} 个点`);
            return input.rootPath.map((point, index) => {
                if (!Array.isArray(point) || point.length !== 2)
                    throw new Error(`rootPath[${index}] 必须是二维坐标`);
                return [
                    finiteNumber(point[0], `rootPath[${index}][0]`, -100000, 100000),
                    finiteNumber(point[1], `rootPath[${index}][1]`, -100000, 100000)
                ];
            });
        })();
        return {
            kind: 'kimodo_generate',
            ...common,
            promptSegments,
            seed: Math.trunc(finiteNumber(input.seed, 'seed', 0, 2147483647)),
            ...(rootPath ? { rootPath } : {})
        };
    }
    if (input.kind === 'soma_to_ue4') {
        return {
            kind: 'soma_to_ue4',
            ...common,
            sourceMotionAssetId: safeText(input.sourceMotionAssetId, 'sourceMotionAssetId', 160)
        };
    }
    if (input.kind === 'mixamo_import') {
        const presetCategory = input.presetCategory;
        if (typeof presetCategory !== 'string' || !MOTION_PRESET_CATEGORIES.has(presetCategory)) {
            throw new Error('presetCategory 不受支持');
        }
        if (typeof input.loop !== 'boolean')
            throw new Error('loop 必须是布尔值');
        return {
            kind: 'mixamo_import',
            ...common,
            sourceUrl: safeText(input.sourceUrl, 'sourceUrl', 2048),
            presetCategory: presetCategory,
            loop: input.loop,
        };
    }
    if (input.kind === 'mixamo_to_ue4') {
        return {
            kind: 'mixamo_to_ue4',
            ...common,
            sourceMotionAssetId: safeText(input.sourceMotionAssetId, 'sourceMotionAssetId', 160),
        };
    }
    if (input.kind === 'motion_optimize') {
        const presetCategory = input.presetCategory;
        if (typeof presetCategory !== 'string' || !MOTION_PRESET_CATEGORIES.has(presetCategory)) {
            throw new Error('presetCategory 不受支持');
        }
        if (typeof input.loop !== 'boolean')
            throw new Error('loop 必须是布尔值');
        return {
            kind: 'motion_optimize',
            ...common,
            sourceMotionAssetId: safeText(input.sourceMotionAssetId, 'sourceMotionAssetId', 160),
            presetCategory: presetCategory,
            loop: input.loop,
        };
    }
    throw new Error('Motion Job kind 不受支持');
};
const existingFile = (value) => Boolean(value && fs.existsSync(path.resolve(value)) && fs.statSync(path.resolve(value)).isFile());
const existingDirectory = (value) => Boolean(value && fs.existsSync(path.resolve(value)) && fs.statSync(path.resolve(value)).isDirectory());
const rejectRetiredMixamoJob = (request) => {
    if (request.kind === 'mixamo_import' || request.kind === 'mixamo_to_ue4') {
        throw new Error('Mixamo 动作导入与白模转换已退役，请使用 Epic 官方动作预设');
    }
};
export const createMotionJobStore = ({ appDatabase, jobsDir, motionAssetsDir, sourceRoots, resolveLinkedSource, workerScriptPath, targetGlbPath, pythonPath = process.env.MK_MOTION_PYTHON, mediapipeModelsDir = process.env.MK_MEDIAPIPE_MODELS_DIR, kimodoRoot = process.env.MK_KIMODO_ROOT, blenderPath = process.env.MK_BLENDER_PATH, ue5EditorPath = process.env.MK_UE5_EDITOR_PATH, ue5ProjectPath = process.env.MK_UE5_PROJECT_PATH, ue5RetargeterAsset = process.env.MK_UE5_RETARGETER_ASSET, ue5SourceSkeletonAsset = process.env.MK_UE5_SOURCE_SKELETON, timeoutMs = 30 * 60 * 1000, spawnProcess = (command, args, options) => spawn(command, args, options) }) => {
    fs.mkdirSync(jobsDir, { recursive: true });
    sweepExpiredJobDirectories(jobsDir, 7 * 24 * 60 * 60 * 1000);
    fs.mkdirSync(motionAssetsDir, { recursive: true });
    const workerRoot = path.dirname(path.resolve(workerScriptPath));
    const inferredPython = process.platform === 'win32'
        ? path.join(workerRoot, '.venv', 'Scripts', 'python.exe')
        : path.join(workerRoot, '.venv', 'bin', 'python');
    const resolvedPython = pythonPath ? path.resolve(pythonPath) : inferredPython;
    const resolvedMediaPipeModels = path.resolve(mediapipeModelsDir ?? path.join(workerRoot, 'models'));
    const resolvedWorkerScript = path.resolve(workerScriptPath);
    const resolvedTargetGlb = path.resolve(targetGlbPath);
    const resolvedBlender = blenderPath ? path.resolve(blenderPath) : process.platform === 'win32' ? 'D:/Blender/blender.exe' : blenderPath;
    const defaultUe5Project = path.resolve(workerRoot, '..', '..', '.tmp', 'ue5-retarget', 'MKMotionRetarget.uproject');
    const resolvedUe5Editor = ue5EditorPath
        ? path.resolve(ue5EditorPath)
        : process.platform === 'win32' ? 'E:/UE5/UE_5.8/Engine/Binaries/Win64/UnrealEditor-Cmd.exe' : undefined;
    const resolvedUe5Project = ue5ProjectPath ? path.resolve(ue5ProjectPath) : defaultUe5Project;
    const resolvedUe5RetargeterAsset = ue5RetargeterAsset ?? DEFAULT_UE5_RETARGETER_ASSET;
    const resolvedUe5SourceSkeletonAsset = ue5SourceSkeletonAsset ?? DEFAULT_UE5_SOURCE_SKELETON_ASSET;
    const jobs = new Map();
    const getCapabilities = () => {
        const workerAvailable = existingFile(resolvedPython) && existingFile(resolvedWorkerScript);
        const somaAvailable = workerAvailable && existingFile(resolvedTargetGlb) && existingFile(resolvedBlender);
        const mixamoNativeAvailable = workerAvailable && existingFile(resolvedBlender);
        const mediaPipeAvailable = workerAvailable && existingDirectory(resolvedMediaPipeModels)
            && existingFile(path.join(resolvedMediaPipeModels, 'pose_landmarker_lite.task'))
            && existingFile(path.join(resolvedMediaPipeModels, 'hand_landmarker.task'));
        const mediaPipeFullAvailable = mediaPipeAvailable
            && existingFile(path.join(resolvedMediaPipeModels, 'pose_landmarker_full.task'));
        const kimodoAvailable = workerAvailable && existingDirectory(kimodoRoot)
            && existingFile(path.join(path.resolve(kimodoRoot), 'scripts', 'mk_generate.py'));
        return {
            worker: workerAvailable ? { available: true } : { available: false, reason: 'Motion Worker Python 或脚本不可用' },
            mediaPipeCapture: mediaPipeAvailable ? { available: true } : { available: false, reason: 'MediaPipe 轻量模型环境不可用' },
            mediaPipeFull: mediaPipeFullAvailable ? { available: true } : { available: false, reason: 'MediaPipe Full 模型不可用，请重新运行 setup-mediapipe.ps1' },
            kimodoGenerate: kimodoAvailable ? { available: true } : { available: false, reason: 'Kimodo 模型环境不可用' },
            somaToUe4: somaAvailable ? { available: true } : { available: false, reason: 'Blender 或 UE4 目标模型不可用' },
            mixamoImport: { available: false, reason: 'Mixamo 新导入已退役，请使用 Epic 官方动作预设' },
            ue5Retarget: { available: false, reason: 'Mixamo 白模转换已退役，请使用 Epic 官方动作预设' },
            motionOptimize: mixamoNativeAvailable ? { available: true } : { available: false, reason: 'Blender 或 Motion Worker 不可用' },
            rigVersion: RIG_VERSION
        };
    };
    const view = (job) => ({
        id: job.id,
        kind: job.kind,
        status: job.status,
        request: job.request,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        ...(job.progress !== undefined ? { progress: job.progress } : {}),
        ...(job.stage ? { stage: job.stage } : {}),
        ...(job.message ? { message: job.message } : {}),
        ...(job.motionAsset ? { motionAsset: job.motionAsset } : {})
    });
    const update = (job, patch) => {
        Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    };
    const relativeAssetFile = (assetDirectory, fileName) => path.relative(motionAssetsDir, path.join(assetDirectory, fileName)).split(path.sep).join('/');
    const resolveAssetFile = (relativePath) => {
        const root = path.resolve(motionAssetsDir);
        const resolved = path.resolve(root, relativePath);
        return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
    };
    const resolveAssetDirectory = (assetId) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(assetId))
            return null;
        const root = path.resolve(motionAssetsDir);
        const resolved = path.resolve(root, assetId);
        return resolved.startsWith(`${root}${path.sep}`) && path.basename(resolved) === assetId ? resolved : null;
    };
    const cleanupMixamoUpload = (request, sourcePath) => {
        if (request.kind !== 'mixamo_import' || !sourcePath || !request.sourceUrl.startsWith('/api/motion/imports/files/'))
            return;
        const importRoot = sourceRoots.find((root) => root.prefix === '/api/motion/imports/files')?.rootDir;
        if (!importRoot)
            return;
        const resolvedRoot = path.resolve(importRoot);
        const resolvedSource = path.resolve(sourcePath);
        if (resolvedSource.startsWith(`${resolvedRoot}${path.sep}`))
            fs.rmSync(resolvedSource, { force: true });
    };
    return {
        getCapabilities,
        listJobs: () => Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(view),
        getJob: (id) => {
            const job = jobs.get(id);
            return job ? view(job) : null;
        },
        listAssets: (projectId) => appDatabase.listMotionAssets(projectId),
        getAsset: (id) => appDatabase.getMotionAsset(id),
        deleteAsset(id, projectId) {
            const asset = appDatabase.getMotionAsset(id);
            if (!asset)
                return null;
            if (asset.projectId && asset.projectId !== projectId)
                throw new Error('Motion Asset 不属于当前导演台项目');
            const assetDirectory = resolveAssetDirectory(id);
            if (!assetDirectory)
                throw new Error('Motion Asset 标识无效');
            const root = path.resolve(motionAssetsDir);
            const quarantineDirectory = path.join(root, `.deleting-${id}-${crypto.randomUUID()}`);
            const directoryExists = fs.existsSync(assetDirectory);
            if (directoryExists)
                fs.renameSync(assetDirectory, quarantineDirectory);
            try {
                if (appDatabase.deleteMotionAsset(id) !== 1)
                    throw new Error('Motion Asset 删除记录失败');
            }
            catch (error) {
                if (directoryExists && fs.existsSync(quarantineDirectory))
                    fs.renameSync(quarantineDirectory, assetDirectory);
                throw error;
            }
            if (directoryExists)
                fs.rmSync(quarantineDirectory, { recursive: true, force: true });
            return asset;
        },
        getAssetFile(id, kind) {
            const asset = appDatabase.getMotionAsset(id);
            if (!asset)
                return null;
            const relativePath = kind === 'soma' ? asset.somaFile
                : kind === 'skeleton' ? asset.skeletonFile
                    : kind === 'ue4' ? asset.ue4File : asset.sourceFile;
            if (!relativePath)
                return null;
            const resolved = resolveAssetFile(relativePath);
            return resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : null;
        },
        createJob(rawRequest) {
            const request = parseRequest(rawRequest);
            rejectRetiredMixamoJob(request);
            const capabilities = getCapabilities();
            if (!capabilities.worker.available)
                throw new Error(capabilities.worker.reason);
            if (request.kind === 'mediapipe_capture' && !capabilities.mediaPipeCapture.available)
                throw new Error(capabilities.mediaPipeCapture.reason);
            if (request.kind === 'mediapipe_capture' && request.poseModel === 'full' && !capabilities.mediaPipeFull.available) {
                throw new Error(capabilities.mediaPipeFull.reason);
            }
            if (request.kind === 'kimodo_generate' && !capabilities.kimodoGenerate.available)
                throw new Error(capabilities.kimodoGenerate.reason);
            if (request.kind === 'soma_to_ue4' && !capabilities.somaToUe4.available)
                throw new Error(capabilities.somaToUe4.reason);
            if (request.kind === 'mixamo_to_ue4' && !capabilities.ue5Retarget.available)
                throw new Error(capabilities.ue5Retarget.reason);
            if (request.kind === 'motion_optimize' && !capabilities.motionOptimize.available)
                throw new Error(capabilities.motionOptimize.reason);
            const id = `motion-job-${crypto.randomUUID()}`;
            const assetId = `motion-${crypto.randomUUID()}`;
            const directory = path.join(jobsDir, id);
            const assetDirectory = path.join(motionAssetsDir, assetId);
            const sourceAsset = request.kind === 'soma_to_ue4' || request.kind === 'mixamo_to_ue4' || request.kind === 'motion_optimize'
                ? appDatabase.getMotionAsset(request.sourceMotionAssetId) : null;
            const sourceSkeletonPath = request.kind === 'soma_to_ue4'
                ? (() => {
                    if (!sourceAsset)
                        throw new Error('源 Motion Asset 不存在');
                    if (!sourceAsset.skeletonFile)
                        throw new Error('源 SOMA 骨架文件不存在');
                    const resolved = resolveAssetFile(sourceAsset.skeletonFile);
                    if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
                        throw new Error('源 SOMA 骨架文件不存在');
                    }
                    return resolved;
                })()
                : undefined;
            const sourcePath = request.kind === 'mediapipe_capture' || request.kind === 'mixamo_import'
                ? resolveLinkedSource?.(request.sourceUrl) ?? resolveControlledSource(request.sourceUrl, sourceRoots)
                : request.kind === 'soma_to_ue4'
                    ? (() => {
                        if (!sourceAsset)
                            throw new Error('源 Motion Asset 不存在');
                        if (!sourceAsset.somaFile)
                            throw new Error('源 SOMA 文件不存在');
                        const resolved = resolveAssetFile(sourceAsset.somaFile);
                        if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile())
                            throw new Error('源 SOMA 文件不存在');
                        return resolved;
                    })()
                    : request.kind === 'mixamo_to_ue4'
                        ? (() => {
                            if (!sourceAsset || sourceAsset.sourceKind !== 'mixamo_import' || sourceAsset.rigVersion !== MIXAMO_NATIVE_RIG_VERSION) {
                                throw new Error('只能转换已导入的 Mixamo 原生动作资产');
                            }
                            if (sourceAsset.projectId && sourceAsset.projectId !== request.projectId)
                                throw new Error('源 Motion Asset 不属于当前导演台项目');
                            if (!sourceAsset.sourceFile)
                                throw new Error('Mixamo 源文件不存在，请重新导入 With Skin 的 FBX');
                            const resolved = resolveAssetFile(sourceAsset.sourceFile);
                            if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
                                throw new Error('Mixamo 源文件不存在，请重新导入 With Skin 的 FBX');
                            }
                            if (path.extname(resolved).toLowerCase() !== '.fbx')
                                throw new Error('UE5 重定向当前只支持从 With Skin 的 Mixamo FBX 转换');
                            return resolved;
                        })()
                        : request.kind === 'motion_optimize'
                            ? (() => {
                                if (!sourceAsset || sourceAsset.rigVersion !== RIG_VERSION) {
                                    throw new Error('只能优化当前项目的 UE4 白模动作资产');
                                }
                                if (sourceAsset.projectId && sourceAsset.projectId !== request.projectId) {
                                    throw new Error('源 Motion Asset 不属于当前导演台项目');
                                }
                                const resolved = resolveAssetFile(sourceAsset.ue4File);
                                if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
                                    throw new Error('源 UE4 白模动作文件不存在');
                                }
                                return resolved;
                            })()
                            : undefined;
            fs.mkdirSync(directory, { recursive: true });
            fs.mkdirSync(assetDirectory, { recursive: true });
            const workerRequest = sourceAsset && request.kind === 'mixamo_to_ue4'
                ? {
                    ...request,
                    presetCategory: typeof sourceAsset.metadata?.presetCategory === 'string' ? sourceAsset.metadata.presetCategory : 'acting',
                    loop: sourceAsset.metadata?.loop === true,
                    sourceFps: sourceAsset.sourceFps,
                }
                : sourceAsset && request.kind === 'motion_optimize'
                    ? {
                        ...request,
                        sourceFps: sourceAsset.sourceFps,
                        sourceRootMotionDistance: typeof sourceAsset.metadata?.rootMotionDistance === 'number'
                            ? sourceAsset.metadata.rootMotionDistance
                            : 0,
                    }
                    : request;
            const manifest = {
                version: 1,
                jobId: id,
                assetId,
                kind: request.kind,
                request: workerRequest,
                sourcePath,
                ...(sourceAsset ? {
                    sourceSomaPath: sourceAsset.somaFile ? resolveAssetFile(sourceAsset.somaFile) : undefined,
                    sourceSkeletonPath
                } : {}),
                outputDir: assetDirectory,
                resultPath: path.join(directory, 'result.json'),
                targetGlbPath: resolvedTargetGlb,
                blenderPath: resolvedBlender,
                mediapipeModelsDir: resolvedMediaPipeModels,
                kimodoRoot: kimodoRoot ? path.resolve(kimodoRoot) : undefined,
                ue5EditorPath: resolvedUe5Editor,
                ue5ProjectPath: resolvedUe5Project,
                ue5RetargeterAsset: resolvedUe5RetargeterAsset,
                ue5SourceSkeletonAsset: resolvedUe5SourceSkeletonAsset,
            };
            const manifestPath = path.join(directory, 'manifest.json');
            fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
            const timestamp = new Date().toISOString();
            const job = {
                id,
                kind: request.kind,
                status: 'queued',
                request,
                createdAt: timestamp,
                updatedAt: timestamp,
                directory,
                log: '',
                progressBuffer: ''
            };
            jobs.set(id, job);
            const child = spawnProcess(resolvedPython, [resolvedWorkerScript, '--manifest', manifestPath], {
                cwd: directory,
                windowsHide: true,
                stdio: 'pipe',
                env: {
                    ...process.env,
                    PYTHONIOENCODING: 'utf-8',
                    PYTHONUTF8: '1',
                    MK_MEDIAPIPE_MODELS_DIR: resolvedMediaPipeModels,
                    ...(kimodoRoot ? { MK_KIMODO_ROOT: path.resolve(kimodoRoot) } : {}),
                    ...(resolvedBlender ? { MK_BLENDER_PATH: resolvedBlender } : {})
                }
            });
            job.process = child;
            update(job, { status: 'running', stage: 'starting', progress: 0 });
            const appendLog = (chunk) => {
                const text = chunk.toString('utf8');
                job.log = `${job.log}${text}`.slice(-64 * 1024);
                const buffered = `${job.progressBuffer}${text}`;
                const lines = buffered.split(/\r?\n/);
                job.progressBuffer = (lines.pop() ?? '').slice(-4096);
                for (const line of lines) {
                    if (!line.startsWith('MK_MOTION_PROGRESS '))
                        continue;
                    try {
                        const progress = JSON.parse(line.slice('MK_MOTION_PROGRESS '.length));
                        update(job, {
                            ...(typeof progress.stage === 'string' ? { stage: progress.stage.slice(0, 120) } : {}),
                            ...(typeof progress.progress === 'number' && Number.isFinite(progress.progress)
                                ? { progress: Math.max(0, Math.min(1, progress.progress)) } : {})
                        });
                    }
                    catch {
                        // Ignore malformed progress lines; the terminal result remains authoritative.
                    }
                }
            };
            child.stdout.on('data', appendLog);
            child.stderr.on('data', appendLog);
            job.timeout = setTimeout(() => {
                if (job.status !== 'running')
                    return;
                child.kill();
                fs.rmSync(assetDirectory, { recursive: true, force: true });
                cleanupMixamoUpload(request, sourcePath);
                update(job, { status: 'timeout', stage: 'timeout', message: 'Motion Worker 处理超时' });
            }, timeoutMs);
            child.once('error', (error) => {
                if (job.timeout)
                    clearTimeout(job.timeout);
                fs.rmSync(assetDirectory, { recursive: true, force: true });
                cleanupMixamoUpload(request, sourcePath);
                update(job, { status: 'failed', stage: 'failed', message: error.message });
            });
            child.once('exit', (code) => {
                if (job.timeout)
                    clearTimeout(job.timeout);
                delete job.process;
                if (job.status !== 'running')
                    return;
                const resultPath = path.join(directory, 'result.json');
                if (code !== 0 || !fs.existsSync(resultPath)) {
                    fs.rmSync(assetDirectory, { recursive: true, force: true });
                    cleanupMixamoUpload(request, sourcePath);
                    update(job, { status: 'failed', stage: 'failed', message: job.log.trim().slice(-1000) || `Motion Worker exited with code ${code}` });
                    return;
                }
                try {
                    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
                    const durationFrames = Math.trunc(finiteNumber(result.durationFrames, 'durationFrames', 1, 30 * 240));
                    const sourceFps = finiteNumber(result.sourceFps, 'sourceFps', 1, 240);
                    const poseFileName = typeof result.poseFile === 'string' && path.basename(result.poseFile) === result.poseFile
                        ? result.poseFile : 'soma.npz';
                    const isMixamoImport = request.kind === 'mixamo_import';
                    const isMixamoDerived = isMixamoImport || request.kind === 'mixamo_to_ue4' || request.kind === 'motion_optimize';
                    const required = isMixamoDerived ? ['animation.glb'] : [poseFileName, 'skeleton.json', 'animation.glb'];
                    if (required.some((fileName) => !fs.existsSync(path.join(assetDirectory, fileName)))) {
                        throw new Error('Motion Worker 未生成完整姿态/骨架/UE4 产物');
                    }
                    const sourceKind = request.kind === 'soma_to_ue4' || request.kind === 'mixamo_to_ue4' || request.kind === 'motion_optimize'
                        ? appDatabase.getMotionAsset(request.sourceMotionAssetId)?.sourceKind ?? 'mediapipe_capture'
                        : request.kind;
                    const asset = appDatabase.createMotionAsset({
                        id: assetId,
                        projectId: request.projectId ?? null,
                        name: request.name,
                        sourceKind,
                        ...(isMixamoDerived ? {} : {
                            somaFile: relativeAssetFile(assetDirectory, poseFileName),
                            skeletonFile: relativeAssetFile(assetDirectory, 'skeleton.json'),
                        }),
                        ue4File: relativeAssetFile(assetDirectory, 'animation.glb'),
                        ...(isMixamoImport && typeof result.sourceFile === 'string' && path.basename(result.sourceFile) === result.sourceFile
                            ? { sourceFile: relativeAssetFile(assetDirectory, result.sourceFile) }
                            : {}),
                        durationFrames,
                        sourceFps,
                        rigVersion: isMixamoImport ? MIXAMO_NATIVE_RIG_VERSION : RIG_VERSION,
                        metadata: {
                            ...(result.metadata && typeof result.metadata === 'object' && !Array.isArray(result.metadata) ? result.metadata : {}),
                            ...(request.kind === 'mixamo_to_ue4' ? {
                                sourceMotionAssetId: request.sourceMotionAssetId,
                                retargetEngine: 'ue5-ik-rig',
                                presetCategory: sourceAsset?.metadata?.presetCategory,
                                loop: sourceAsset?.metadata?.loop,
                            } : {}),
                            ...(request.kind === 'motion_optimize' ? {
                                optimizationSourceMotionAssetId: request.sourceMotionAssetId,
                                presetCategory: request.presetCategory,
                                categoryId: sourceAsset?.metadata?.categoryId,
                                loop: request.loop,
                            } : {}),
                            rootMotionMode: request.rootMotionMode,
                            ...(request.characterId ? { characterId: request.characterId } : {})
                        },
                        createdAt: new Date().toISOString()
                    });
                    cleanupMixamoUpload(request, sourcePath);
                    update(job, { status: 'completed', stage: 'completed', progress: 1, motionAsset: asset });
                }
                catch (error) {
                    fs.rmSync(assetDirectory, { recursive: true, force: true });
                    cleanupMixamoUpload(request, sourcePath);
                    update(job, { status: 'failed', stage: 'failed', message: error instanceof Error ? error.message : 'Motion 产物入库失败' });
                }
            });
            return view(job);
        },
        cancelJob(id) {
            const job = jobs.get(id);
            if (!job)
                return null;
            if (job.status === 'queued' || job.status === 'running') {
                job.process?.kill();
                if (job.timeout)
                    clearTimeout(job.timeout);
                const manifest = JSON.parse(fs.readFileSync(path.join(job.directory, 'manifest.json'), 'utf8'));
                if (manifest.outputDir)
                    fs.rmSync(manifest.outputDir, { recursive: true, force: true });
                const sourcePath = job.request.kind === 'mixamo_import'
                    ? (() => { try {
                        return resolveControlledSource(job.request.sourceUrl, sourceRoots);
                    }
                    catch {
                        return undefined;
                    } })()
                    : undefined;
                cleanupMixamoUpload(job.request, sourcePath);
                update(job, { status: 'cancelled', stage: 'cancelled', message: 'Motion 任务已取消' });
            }
            return view(job);
        },
        deleteProjectAssets(projectId) {
            const projectJobs = Array.from(jobs.values()).filter((job) => job.request.projectId === projectId);
            projectJobs.forEach((job) => {
                if (job.status === 'queued' || job.status === 'running') {
                    job.process?.kill();
                    if (job.timeout)
                        clearTimeout(job.timeout);
                }
                fs.rmSync(job.directory, { recursive: true, force: true });
                jobs.delete(job.id);
            });
            const assets = appDatabase.listMotionAssets(projectId);
            assets.forEach((asset) => {
                const assetDirectory = resolveAssetDirectory(asset.id);
                if (assetDirectory)
                    fs.rmSync(assetDirectory, { recursive: true, force: true });
                appDatabase.deleteMotionAsset(asset.id);
            });
            return { deletedAssets: assets.length, deletedJobs: projectJobs.length };
        },
        close() {
            jobs.forEach((job) => {
                if (job.status === 'running')
                    job.process?.kill();
                if (job.timeout)
                    clearTimeout(job.timeout);
            });
        }
    };
};
