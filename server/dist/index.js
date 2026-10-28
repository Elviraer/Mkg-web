import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import { FTV_PRODUCT_VERSION } from '@ftv/shared';
import { createAppDatabase } from './appDatabase.js';
import { createHistoryAssetStore } from './historyAssetStore.js';
import { persistAssetBlobFile } from './assetBlobStore.js';
import { createDerivedHistoryAssetWriter } from './derivedHistoryAssetWriter.js';
import { createHistoryThumbnailService } from './historyThumbnailService.js';
import { AutomationStore } from './automationStore.js';
import { attachAutomationGateway } from './automationGateway.js';
import { DirectorRemoteSessionStore } from './directorRemoteSessionStore.js';
import { attachDirectorRemoteGateway } from './directorRemoteGateway.js';
import { createPhotoshopJobStore } from './photoshopJobStore.js';
import { createBlenderJobStore } from './blenderJobStore.js';
import { createMotionJobStore } from './motionJobStore.js';
import { createDirectorVideoExportJobStore } from './directorVideoExportJobStore.js';
import { createMediaTransformJobStore } from './mediaTransformJobStore.js';
import { createRuntimeExecutableAvailability, describeMissingRuntimeExecutables } from './runtimeExecutables.js';
import { createDirectorModelAssetStore } from './directorModelAssetStore.js';
import { createBlenderRoutes } from './routes/blenderRoutes.js';
import { createMotionRoutes } from './routes/motionRoutes.js';
import { createDirectorVideoExportRoutes } from './routes/directorVideoExportRoutes.js';
import { createMediaTransformRoutes } from './routes/mediaTransformRoutes.js';
import { createDirectorModelAssetRoutes } from './routes/directorModelAssetRoutes.js';
import { createDirectorRemoteRoutes } from './routes/directorRemoteRoutes.js';
import { createGenerationRoutes } from './routes/generationRoutes.js';
import { createAutomationRoutes } from './routes/automationRoutes.js';
import { createHistoryAssetRoutes } from './routes/historyAssetRoutes.js';
import { createLibraryAssetRoutes } from './routes/libraryAssetRoutes.js';
import { createMediaRoutes } from './routes/mediaRoutes.js';
import { createPhotoshopRoutes } from './routes/photoshopRoutes.js';
import { createProjectRoutes } from './routes/projectRoutes.js';
import { createProviderRoutes } from './routes/providerRoutes.js';
import { createWorkflowStoreRoutes } from './routes/workflowStoreRoutes.js';
import { createRoleRoutes } from './routes/roleRoutes.js';
import { createAssetIdentityRoutes } from './routes/assetIdentityRoutes.js';
import { createUploadRoutes } from './routes/uploadRoutes.js';
import { createTrustedAssetUrlRegistry } from './trustedAssetUrlRegistry.js';
import { normalizeGenerationTimeoutPolicy } from '@ftv/shared';
import { createCorsMiddleware, createCorsOriginGuard, formatListeningOrigin, resolveAllowedCorsOrigins, resolveServerHost, } from './serverNetworkPolicy.js';
import { isAuthorizedDesktopRequest, writeDesktopReadyFile } from './desktopRuntime.js';
import { detectMediaBuffer, detectMediaFile } from './mediaFileType.js';
import { createRoleAssetSourceResolver } from './roleAssetSource.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.set('trust proxy', 'loopback');
const port = Number(process.env.PORT ?? 4000);
let localPort = port;
const host = resolveServerHost(process.env.MK_SERVER_HOST);
const httpsCertPath = process.env.MK_HTTPS_CERT;
const httpsKeyPath = process.env.MK_HTTPS_KEY;
const publicOrigin = process.env.MK_PUBLIC_ORIGIN;
const desktopToken = process.env.MK_DESKTOP_TOKEN?.trim();
const readHttpsFile = (envName, filePath) => {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`${envName} file does not exist: ${resolvedPath}. Set it to a real certificate file or clear both MK_HTTPS_CERT and MK_HTTPS_KEY for HTTP development.`);
    }
    return fs.readFileSync(resolvedPath);
};
const ensureDirectory = (dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};
const migrateRuntimeAssetDirectory = (legacyDir, targetDir) => {
    ensureDirectory(targetDir);
    const legacyPath = path.resolve(legacyDir);
    const targetPath = path.resolve(targetDir);
    if (legacyPath === targetPath || !fs.existsSync(legacyPath))
        return;
    fs.readdirSync(legacyPath, { withFileTypes: true }).forEach((entry) => {
        const source = path.join(legacyPath, entry.name);
        const target = path.join(targetPath, entry.name);
        if (fs.existsSync(target))
            return;
        if (entry.isDirectory()) {
            fs.cpSync(source, target, { recursive: true });
            return;
        }
        fs.copyFileSync(source, target);
    });
};
const uploadsDir = process.env.MK_UPLOADS_DIR
    ? path.resolve(process.env.MK_UPLOADS_DIR)
    : path.join(__dirname, '../uploads');
ensureDirectory(uploadsDir);
const dataDir = process.env.MK_DATA_DIR
    ? path.resolve(process.env.MK_DATA_DIR)
    : path.join(__dirname, '../data');
const webDistDir = process.env.MK_WEB_DIST_DIR
    ? path.resolve(process.env.MK_WEB_DIST_DIR)
    : undefined;
const desktopReadyFile = process.env.MK_DESKTOP_READY_FILE
    ? path.resolve(process.env.MK_DESKTOP_READY_FILE)
    : undefined;
const runtimeAssetsDir = path.join(dataDir, 'assets');
const legacyRoleAssetsDir = path.join(__dirname, '../role-assets');
const legacyHistoryAssetsDir = path.join(__dirname, '../history-assets');
const roleAssetsDir = path.join(runtimeAssetsDir, 'roles');
const historyAssetsDir = path.join(runtimeAssetsDir, 'history');
const providerAssetsDir = path.join(runtimeAssetsDir, 'providers');
const libraryAssetsDir = path.join(runtimeAssetsDir, 'library');
const libraryThumbnailsDir = path.join(runtimeAssetsDir, 'library-thumbnails');
const motionAssetsDir = path.join(runtimeAssetsDir, 'motion-assets');
const motionImportsDir = path.join(runtimeAssetsDir, 'motion-imports');
const mediaTransformJobsDir = path.join(runtimeAssetsDir, 'media-transform-jobs');
const directorModelsDir = path.join(runtimeAssetsDir, 'director-models');
migrateRuntimeAssetDirectory(legacyRoleAssetsDir, roleAssetsDir);
migrateRuntimeAssetDirectory(legacyHistoryAssetsDir, historyAssetsDir);
ensureDirectory(providerAssetsDir);
ensureDirectory(libraryAssetsDir);
ensureDirectory(libraryThumbnailsDir);
ensureDirectory(motionAssetsDir);
ensureDirectory(motionImportsDir);
ensureDirectory(mediaTransformJobsDir);
ensureDirectory(directorModelsDir);
const appDatabase = await createAppDatabase({
    dbPath: path.join(dataDir, 'mk.sqlite')
});
const resolveRoleAssetSource = createRoleAssetSourceResolver({
    getRole: appDatabase.getRole,
    getAssetBlob: appDatabase.getAssetBlob,
    resolveLibraryAssetSource: appDatabase.resolveLibraryAssetSource
});
const directorModelAssetStore = createDirectorModelAssetStore({
    appDatabase,
    rootDir: directorModelsDir
});
directorModelAssetStore.reclaimPendingDeletionAssets();
const resolveManagedSource = (sourceUrl) => (appDatabase.resolveLibraryAssetSource(sourceUrl)
    ?? appDatabase.resolveHistoryAssetSource(sourceUrl)
    ?? resolveRoleAssetSource(sourceUrl)
    ?? directorModelAssetStore.resolveSourceUrl(sourceUrl));
const resolveCacheSourceUrl = (value) => {
    if (/^(https?:)?\/\//i.test(value) || value.startsWith('data:'))
        return value;
    if (value.startsWith('/'))
        return `http://127.0.0.1:${localPort}${value}`;
    return value;
};
const historyThumbnailService = createHistoryThumbnailService({
    rootDir: historyAssetsDir,
    publicUrlPrefix: '/api/history-assets/files',
    ffmpegPath: process.env.MK_FFMPEG_PATH ?? 'ffmpeg'
});
const trustedAssetUrlRegistry = createTrustedAssetUrlRegistry();
const historyAssetStore = createHistoryAssetStore({
    rootDir: historyAssetsDir,
    publicUrlPrefix: '/api/history-assets/files',
    resolveSourceUrl: resolveCacheSourceUrl,
    resolveOutboundPolicy: trustedAssetUrlRegistry.resolve,
    database: appDatabase,
    createThumbnail: historyThumbnailService.createThumbnail,
    persistManagedAsset: async ({ filePath, fileName, detected, historyAsset }) => {
        const { blob } = await persistAssetBlobFile({
            appDatabase,
            assetBlobsDir: libraryAssetsDir,
            filePath,
            detected
        });
        const scope = new URLSearchParams({
            projectId: historyAsset.projectId ?? '',
            canvasId: historyAsset.canvasId ?? ''
        });
        return {
            blobId: blob.id,
            fileUrl: `/api/history-assets/${encodeURIComponent(historyAsset.id)}/file?${scope.toString()}`,
            ...(blob.thumbnailUrl ? { thumbnailUrl: blob.thumbnailUrl } : {})
        };
    }
});
const libraryThumbnailService = createHistoryThumbnailService({
    rootDir: libraryThumbnailsDir,
    publicUrlPrefix: '/api/library-assets/files',
    ffmpegPath: process.env.MK_FFMPEG_PATH ?? 'ffmpeg'
});
const persistDerivedHistoryAsset = createDerivedHistoryAssetWriter({
    historyAssetsDir,
    cacheAssets: historyAssetStore.cacheAssets
});
const photoshopJobStore = createPhotoshopJobStore({
    uploadsDir,
    persistDerivedHistoryAsset
});
const roleThumbnailService = createHistoryThumbnailService({
    rootDir: roleAssetsDir,
    publicUrlPrefix: '/api/role-assets/files',
    ffmpegPath: process.env.MK_FFMPEG_PATH ?? 'ffmpeg'
});
const blenderJobStore = createBlenderJobStore({
    jobsDir: path.join(runtimeAssetsDir, 'blender-jobs'),
    persistDerivedHistoryAsset,
    persistDirectorModelFile: async (filePath, fileName) => {
        const temporaryPath = path.join(directorModelsDir, `.blender-model-${randomUUID()}.upload`);
        fs.copyFileSync(filePath, temporaryPath);
        const { asset } = await directorModelAssetStore.importFile(temporaryPath, fileName, { retained: false });
        return { id: asset.id, fileUrl: asset.fileUrl };
    },
    resolveLinkedSource: resolveManagedSource,
    sourceRoots: [
        { prefix: '/api/uploads', rootDir: uploadsDir },
        { prefix: '/api/history-assets/files', rootDir: historyAssetsDir },
        { prefix: '/api/role-assets/files', rootDir: roleAssetsDir },
        { prefix: '/api/library-assets/files', rootDir: libraryAssetsDir },
        { prefix: '/api/motion/imports/files', rootDir: motionImportsDir }
    ]
});
const defaultKimodoRoot = path.join(os.homedir(), '.codex', 'deps', 'Kimodo');
const motionJobStore = createMotionJobStore({
    appDatabase,
    jobsDir: path.join(runtimeAssetsDir, 'motion-jobs'),
    motionAssetsDir,
    workerScriptPath: process.env.MK_MOTION_WORKER_SCRIPT
        ?? path.resolve(__dirname, '../../../scripts/motion-worker/worker.py'),
    targetGlbPath: process.env.MK_MOTION_TARGET_GLB
        ?? path.resolve(__dirname, '../../web/public/models/ue-mannequin-retopology.glb'),
    mediapipeModelsDir: process.env.MK_MEDIAPIPE_MODELS_DIR
        ?? path.resolve(__dirname, '../../../scripts/motion-worker/models'),
    kimodoRoot: process.env.MK_KIMODO_ROOT ?? defaultKimodoRoot,
    resolveLinkedSource: resolveManagedSource,
    ...(process.env.MK_UE5_EDITOR_PATH ? { ue5EditorPath: process.env.MK_UE5_EDITOR_PATH } : {}),
    ...(process.env.MK_UE5_PROJECT_PATH ? { ue5ProjectPath: process.env.MK_UE5_PROJECT_PATH } : {}),
    ...(process.env.MK_UE5_RETARGETER_ASSET ? { ue5RetargeterAsset: process.env.MK_UE5_RETARGETER_ASSET } : {}),
    ...(process.env.MK_UE5_SOURCE_SKELETON ? { ue5SourceSkeletonAsset: process.env.MK_UE5_SOURCE_SKELETON } : {}),
    sourceRoots: [
        { prefix: '/api/uploads', rootDir: uploadsDir },
        { prefix: '/api/history-assets/files', rootDir: historyAssetsDir },
        { prefix: '/api/library-assets/files', rootDir: libraryAssetsDir },
        { prefix: '/api/motion/imports/files', rootDir: motionImportsDir }
    ]
});
const directorVideoExportJobStore = createDirectorVideoExportJobStore({
    appDatabase,
    jobsDir: path.join(runtimeAssetsDir, 'director-video-jobs'),
    motionAssetsDir,
    persistDerivedHistoryAsset,
    targetGlbPath: process.env.MK_MOTION_TARGET_GLB
        ?? path.resolve(__dirname, '../../web/public/models/ue-mannequin-retopology.glb'),
    resolveLinkedSource: resolveManagedSource,
    sourceRoots: [
        { prefix: '/api/uploads', rootDir: uploadsDir },
        { prefix: '/api/history-assets/files', rootDir: historyAssetsDir },
        { prefix: '/api/role-assets/files', rootDir: roleAssetsDir },
        { prefix: '/api/library-assets/files', rootDir: libraryAssetsDir }
    ]
});
const mediaTransformJobStore = createMediaTransformJobStore({
    appDatabase,
    jobsDir: mediaTransformJobsDir,
    uploadsDir,
    libraryAssetsDir,
    createLibraryThumbnail: libraryThumbnailService.createThumbnail,
    workerScriptPath: process.env.MK_DEPTH_WORKER_SCRIPT
        ?? path.resolve(__dirname, '../../../scripts/depth-worker/worker.py'),
    sceneWorkerScriptPath: process.env.MK_OMNISHOTCUT_WORKER_SCRIPT
        ?? path.resolve(__dirname, '../../../scripts/omnishotcut-worker/worker.py'),
    audioWorkerScriptPath: process.env.MK_AUDIO_WORKER_SCRIPT
        ?? path.resolve(__dirname, '../../../scripts/audio-worker/worker.py'),
    resolveLinkedSource: resolveManagedSource,
    sourceRoots: [
        { prefix: '/api/uploads', rootDir: uploadsDir },
        { prefix: '/api/history-assets/files', rootDir: historyAssetsDir },
        { prefix: '/api/library-assets/files', rootDir: libraryAssetsDir }
    ]
});
// FFmpeg/FFprobe are external prerequisites for thumbnails and every video/audio transform. Probe
// once at startup, warn once, and publish the memoized result on /health (which the desktop and dev
// launchers poll every 100-250 ms, so it must never spawn a process itself).
const runtimeExecutables = createRuntimeExecutableAvailability(process.env.MK_FFMPEG_PATH ?? 'ffmpeg', process.env.MK_FFPROBE_PATH ?? 'ffprobe');
const initialExecutableAvailability = runtimeExecutables.read();
{
    const missing = describeMissingRuntimeExecutables(initialExecutableAvailability);
    if (missing) {
        console.error(`[MK prerequisites] 未检测到 ${missing}。参考文件缩略图、视频播放代理、裁剪/截取/智能切割/深度与音频分离将不可用；`
            + '请安装 FFmpeg 并加入 PATH（或用 MK_FFMPEG_PATH / MK_FFPROBE_PATH 指定路径）后重新检测。');
    }
}
const directorRemoteSessionStore = new DirectorRemoteSessionStore();
const automationStore = new AutomationStore({
    load: () => appDatabase.getSetting('automationSecurity', {
        trustedClients: [],
        sessionIdleTimeoutMs: 30 * 60 * 1000,
    }),
    save: (state) => appDatabase.setSetting('automationSecurity', state),
});
const photoshopSweepTimer = setInterval(() => photoshopJobStore.sweep(), 60 * 1000);
photoshopSweepTimer.unref();
const directorRemoteSweepTimer = setInterval(() => directorRemoteSessionStore.sweep(), 60 * 1000);
directorRemoteSweepTimer.unref();
const automationSweepTimer = setInterval(() => automationStore.sweep(), 60 * 1000);
automationSweepTimer.unref();
const generationJobSweepTimer = setInterval(() => {
    const now = new Date();
    appDatabase.sweepGenerationJobs(now.toISOString(), new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString());
}, 60 * 60 * 1000);
generationJobSweepTimer.unref();
const isHttps = Boolean(httpsCertPath && httpsKeyPath);
const protocol = isHttps ? 'https' : 'http';
const allowedCorsOrigins = resolveAllowedCorsOrigins({
    protocol,
    port,
    publicOrigin,
    configuredOrigins: process.env.MK_CORS_ORIGINS,
});
app.use(createCorsOriginGuard(allowedCorsOrigins));
app.use(createCorsMiddleware(allowedCorsOrigins));
app.use(express.json({ limit: '80mb' }));
app.use('/api/uploads', express.static(uploadsDir));
app.use('/api/role-assets/files/thumbnails', express.static(roleThumbnailService.thumbnailsDir, {
    immutable: true,
    maxAge: '1y'
}));
app.use('/api/role-assets/files', express.static(roleAssetsDir));
app.use('/api/role-assets/files', express.static(legacyRoleAssetsDir));
app.use('/api/provider-assets/files', express.static(providerAssetsDir));
app.use('/api/library-assets/files/thumbnails', express.static(libraryThumbnailService.thumbnailsDir, {
    immutable: true,
    maxAge: '1y'
}));
app.use('/api/library-assets/files', express.static(libraryAssetsDir));
app.use('/api/history-assets/files/thumbnails', express.static(historyThumbnailService.thumbnailsDir, {
    immutable: true,
    maxAge: '1y'
}));
app.use('/api/history-assets/files', express.static(historyAssetsDir));
app.use('/api/history-assets/files', express.static(legacyHistoryAssetsDir));
app.get('/api/settings/generation-timeouts', (_request, response) => {
    response.json(appDatabase.getSetting('generationTimeoutPolicy', normalizeGenerationTimeoutPolicy(undefined)));
});
app.put('/api/settings/generation-timeouts', (request, response) => {
    const policy = normalizeGenerationTimeoutPolicy(request.body);
    appDatabase.setSetting('generationTimeoutPolicy', policy);
    response.json(policy);
});
let shutdownGenerationExecutions = async () => { };
app.use('/api', createGenerationRoutes({
    uploadsDir,
    historyAssetsDir,
    libraryAssetsDir,
    resolveLinkedSource: resolveManagedSource,
    registerTrustedAssetUrls: trustedAssetUrlRegistry.register,
    resolveTrustedAssetPolicy: trustedAssetUrlRegistry.resolve,
    generationJobStore: appDatabase,
    registerExecutionShutdown: (shutdown) => {
        shutdownGenerationExecutions = shutdown;
    },
    persistGeneratedMedia: async ({ bytes, contentType, fileName, kind, projectId, canvasId }) => {
        const buffer = Buffer.from(bytes);
        const detected = await detectMediaBuffer(buffer);
        if (!detected || (kind && detected.kind !== kind))
            throw new Error('上游返回内容不是受支持的媒体文件');
        if (projectId && canvasId && (detected.kind === 'image' || detected.kind === 'video' || detected.kind === 'audio')) {
            const [asset] = await historyAssetStore.cacheAssets([{
                    projectId,
                    canvasId,
                    name: fileName,
                    kind: detected.kind,
                    source: '工作流生成',
                    previewUrl: `data:${contentType || detected.mime};base64,${buffer.toString('base64')}`
                }]);
            if (!asset?.previewUrl)
                throw new Error('工作流输出写入 History/AssetBlob 失败');
            return { previewUrl: asset.previewUrl, historyAssetId: asset.id };
        }
        if (detected.kind !== 'audio')
            throw new Error('缺少画布作用域，不能保存工作流图片或视频');
        const storedName = `${randomUUID()}${detected.extension}`;
        fs.writeFileSync(path.join(historyAssetsDir, storedName), buffer);
        return { previewUrl: `/api/history-assets/files/${encodeURIComponent(storedName)}` };
    },
}));
app.use('/api', createHistoryAssetRoutes(historyAssetStore, {
    resolveControlledSource: resolveManagedSource,
    sourceRoots: [
        { prefix: '/api/uploads', rootDir: uploadsDir },
        { prefix: '/api/history-assets/files', rootDir: historyAssetsDir },
        { prefix: '/api/library-assets/files', rootDir: libraryAssetsDir }
    ]
}));
app.use('/api', createMediaRoutes({
    uploadsDir,
    playbackCacheDir: path.join(runtimeAssetsDir, 'media-playback-cache'),
    // Generated media is published as a scoped History/AssetBlob URL. FFmpeg must
    // resolve that owned identity as well as a Library asset, without accepting
    // unrelated managed asset categories.
    resolveLinkedSource: (sourceUrl) => (appDatabase.resolveLibraryAssetSource(sourceUrl)
        ?? appDatabase.resolveHistoryAssetSource(sourceUrl)),
    imageThumbnailSources: [
        {
            prefix: '/api/role-assets/files',
            rootDir: roleAssetsDir,
            createThumbnail: (sourcePath) => roleThumbnailService.createThumbnail(sourcePath, 'image')
        },
        {
            prefix: '/api/role-assets/files',
            rootDir: legacyRoleAssetsDir,
            createThumbnail: (sourcePath) => roleThumbnailService.createThumbnail(sourcePath, 'image')
        },
        {
            prefix: '/api/history-assets/files',
            rootDir: historyAssetsDir,
            createThumbnail: (sourcePath) => historyThumbnailService.createThumbnail(sourcePath, 'image')
        },
        {
            prefix: '/api/history-assets/files',
            rootDir: legacyHistoryAssetsDir,
            createThumbnail: (sourcePath) => historyThumbnailService.createThumbnail(sourcePath, 'image')
        },
        {
            prefix: '/api/library-assets/files',
            rootDir: libraryAssetsDir,
            createThumbnail: (sourcePath) => libraryThumbnailService.createThumbnail(sourcePath, 'image')
        }
    ],
    videoPosterSources: [
        { prefix: '/api/uploads', rootDir: uploadsDir },
        {
            prefix: '/api/role-assets/files',
            rootDir: roleAssetsDir,
            createPoster: (sourcePath) => roleThumbnailService.createThumbnail(sourcePath, 'video')
        },
        {
            prefix: '/api/role-assets/files',
            rootDir: legacyRoleAssetsDir,
            createPoster: (sourcePath) => roleThumbnailService.createThumbnail(sourcePath, 'video')
        },
        {
            prefix: '/api/history-assets/files',
            rootDir: historyAssetsDir,
            createPoster: (sourcePath) => historyThumbnailService.createThumbnail(sourcePath, 'video')
        },
        {
            prefix: '/api/history-assets/files',
            rootDir: legacyHistoryAssetsDir,
            createPoster: (sourcePath) => historyThumbnailService.createThumbnail(sourcePath, 'video')
        },
        {
            prefix: '/api/library-assets/files',
            rootDir: libraryAssetsDir,
            createPoster: (sourcePath) => libraryThumbnailService.createThumbnail(sourcePath, 'video')
        }
    ]
}));
app.use('/api', createPhotoshopRoutes({ store: photoshopJobStore }));
app.use('/api', createBlenderRoutes(blenderJobStore));
app.use('/api', createMotionRoutes(motionJobStore, { importDir: motionImportsDir }));
app.use('/api', createDirectorVideoExportRoutes(directorVideoExportJobStore));
app.use('/api', createMediaTransformRoutes(mediaTransformJobStore));
app.use('/api', createDirectorModelAssetRoutes({
    store: directorModelAssetStore,
    uploadsDir: directorModelsDir
}));
app.use('/api', createDirectorRemoteRoutes({
    store: directorRemoteSessionStore,
    ...(publicOrigin ? { publicOrigin } : {}),
}));
app.use('/api', createProjectRoutes(appDatabase, historyAssetStore, {
    libraryAssetsDir,
    reclaimDirectorModelAssets: directorModelAssetStore.reclaimDetachedProjectAssets,
    reclaimProjectMotionAssets: motionJobStore.deleteProjectAssets,
    reclaimProjectMediaTransformJobs: mediaTransformJobStore.deleteScopeJobs
}));
app.use('/api', createWorkflowStoreRoutes({ dataDir }));
app.use('/api', createLibraryAssetRoutes({
    appDatabase,
    libraryAssetsDir,
    libraryThumbnailsDir: libraryThumbnailService.thumbnailsDir,
    createThumbnail: libraryThumbnailService.createThumbnail,
    ...(desktopToken ? { desktopToken } : {}),
    sourceRoots: [
        { prefix: '/api/uploads', rootDir: uploadsDir },
        { prefix: '/api/history-assets/files', rootDir: historyAssetsDir },
        { prefix: '/api/role-assets/files', rootDir: roleAssetsDir }
    ]
}));
app.use('/api', createRoleRoutes(appDatabase, {
    snapshotLibraryAssetBlob: async (libraryAssetId) => {
        const asset = appDatabase.getLibraryAsset(libraryAssetId);
        if (!asset)
            return undefined;
        if (asset.blobId)
            return asset.blobId;
        if (!asset.sourcePath || !fs.existsSync(asset.sourcePath))
            throw new Error('角色来源素材文件不存在');
        if (asset.storageMode === 'linked') {
            const stat = fs.statSync(asset.sourcePath);
            if (!stat.isFile()
                || stat.size !== asset.sourceSizeBytes
                || Math.trunc(stat.mtimeMs) !== Math.trunc(asset.sourceModifiedAtMs ?? -1))
                throw new Error('角色来源素材已变化，请先重新链接');
        }
        const temporaryPath = path.join(libraryAssetsDir, `.role-snapshot-${randomUUID()}.upload`);
        fs.copyFileSync(asset.sourcePath, temporaryPath);
        const detected = await detectMediaFile(temporaryPath);
        if (!detected || detected.kind !== 'image') {
            fs.rmSync(temporaryPath, { force: true });
            throw new Error('角色来源不是受支持的图片');
        }
        const { blob } = await persistAssetBlobFile({
            appDatabase,
            assetBlobsDir: libraryAssetsDir,
            filePath: temporaryPath,
            detected
        });
        return blob.id;
    },
    snapshotRoleAssetBlob: async (sourceUrl, thumbnailUrl) => {
        const prefix = '/api/role-assets/files/';
        if (!sourceUrl.startsWith(prefix))
            return undefined;
        let fileName = '';
        try {
            fileName = decodeURIComponent(sourceUrl.slice(prefix.length));
        }
        catch {
            return undefined;
        }
        if (!fileName || path.basename(fileName) !== fileName)
            return undefined;
        const sourcePath = path.resolve(roleAssetsDir, fileName);
        const roleRoot = path.resolve(roleAssetsDir);
        if (!sourcePath.startsWith(`${roleRoot}${path.sep}`) || !fs.existsSync(sourcePath))
            return undefined;
        const temporaryPath = path.join(libraryAssetsDir, `.role-upload-snapshot-${randomUUID()}.upload`);
        fs.copyFileSync(sourcePath, temporaryPath);
        const detected = await detectMediaFile(temporaryPath);
        if (!detected || detected.kind !== 'image') {
            fs.rmSync(temporaryPath, { force: true });
            return undefined;
        }
        const { blob } = await persistAssetBlobFile({
            appDatabase,
            assetBlobsDir: libraryAssetsDir,
            filePath: temporaryPath,
            detected
        });
        if (thumbnailUrl && !blob.thumbnailUrl)
            appDatabase.updateAssetBlobThumbnail(blob.id, thumbnailUrl);
        return blob.id;
    },
    consumeRoleAssetSources: (sourceUrls) => {
        const retained = new Set(appDatabase.listRoles().flatMap((role) => [
            ...(Array.isArray(role.images) ? role.images : []),
            ...(Array.isArray(role.retiredImages) ? role.retiredImages : [])
        ]).flatMap((value) => {
            const url = value && typeof value === 'object' && !Array.isArray(value)
                ? value.url
                : undefined;
            return typeof url === 'string' ? [url] : [];
        }));
        const prefix = '/api/role-assets/files/';
        sourceUrls.forEach((sourceUrl) => {
            if (!sourceUrl.startsWith(prefix) || retained.has(sourceUrl))
                return;
            let fileName = '';
            try {
                fileName = decodeURIComponent(sourceUrl.slice(prefix.length));
            }
            catch {
                return;
            }
            if (!fileName || path.basename(fileName) !== fileName)
                return;
            const sourcePath = path.resolve(roleAssetsDir, fileName);
            const root = path.resolve(roleAssetsDir);
            if (sourcePath.startsWith(`${root}${path.sep}`) && fs.existsSync(sourcePath)) {
                fs.rmSync(sourcePath, { force: true });
            }
        });
    },
    reclaimBlobFiles: (blob) => {
        if (fs.existsSync(blob.sourcePath))
            fs.rmSync(blob.sourcePath, { force: true });
        if (!blob.thumbnailUrl || appDatabase.countHistoryAssetFileReferences(blob.thumbnailUrl) > 0)
            return;
        const thumbnailRoots = [
            { prefix: '/api/library-assets/files/thumbnails', root: libraryThumbnailService.thumbnailsDir },
            { prefix: '/api/history-assets/files/thumbnails', root: historyThumbnailService.thumbnailsDir },
            { prefix: '/api/role-assets/files/thumbnails', root: roleThumbnailService.thumbnailsDir }
        ];
        const match = thumbnailRoots.find((entry) => blob.thumbnailUrl.startsWith(`${entry.prefix}/`));
        if (!match)
            return;
        let fileName = '';
        try {
            fileName = decodeURIComponent(blob.thumbnailUrl.slice(match.prefix.length + 1));
        }
        catch {
            return;
        }
        if (!fileName || path.basename(fileName) !== fileName)
            return;
        const thumbnailPath = path.resolve(match.root, fileName);
        const root = path.resolve(match.root);
        if (thumbnailPath.startsWith(`${root}${path.sep}`) && fs.existsSync(thumbnailPath)) {
            fs.rmSync(thumbnailPath, { force: true });
        }
    }
}));
app.use('/api', createAssetIdentityRoutes(appDatabase, {
    resolveManagedSource,
    sourceRoots: [
        { prefix: '/api/uploads', rootDir: uploadsDir },
        { prefix: '/api/history-assets/files', rootDir: historyAssetsDir },
        { prefix: '/api/role-assets/files', rootDir: roleAssetsDir },
        { prefix: '/api/library-assets/files', rootDir: libraryAssetsDir }
    ]
}));
app.use('/api', createUploadRoutes({
    uploadsDir,
    roleAssetsDir,
    providerAssetsDir,
    createRoleThumbnail: roleThumbnailService.createThumbnail
}));
app.use('/api/providers', createProviderRoutes());
app.get('/health', (request, response) => {
    const refresh = request.query.refresh === '1' || request.query.refresh === 'true';
    const executables = runtimeExecutables.read(refresh);
    response.json({
        ok: true,
        service: 'mk-server',
        ffmpeg: executables.ffmpeg,
        ffprobe: executables.ffprobe
    });
});
if (Boolean(httpsCertPath) !== Boolean(httpsKeyPath)) {
    throw new Error('MK_HTTPS_CERT and MK_HTTPS_KEY must be configured together');
}
const server = isHttps
    ? createHttpsServer({
        cert: readHttpsFile('MK_HTTPS_CERT', httpsCertPath),
        key: readHttpsFile('MK_HTTPS_KEY', httpsKeyPath),
    }, app)
    : createHttpServer(app);
const directorRemoteGateway = attachDirectorRemoteGateway(server, directorRemoteSessionStore);
const automationGateway = attachAutomationGateway(server, automationStore);
app.use('/api', createAutomationRoutes({ gateway: automationGateway, store: automationStore }));
let shutdownRequested = false;
let listenRetryTimer;
let serverListening = false;
const formatProcessFailure = (value) => {
    if (value instanceof Error)
        return `${value.name}: ${value.message}\n${value.stack ?? ''}`.trim();
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
};
const shutdown = () => {
    if (shutdownRequested)
        return;
    shutdownRequested = true;
    if (listenRetryTimer) {
        clearTimeout(listenRetryTimer);
        listenRetryTimer = undefined;
    }
    clearInterval(photoshopSweepTimer);
    clearInterval(directorRemoteSweepTimer);
    clearInterval(automationSweepTimer);
    clearInterval(generationJobSweepTimer);
    directorRemoteGateway.close();
    automationGateway.close();
    blenderJobStore.close();
    motionJobStore.close();
    directorVideoExportJobStore.close();
    mediaTransformJobStore.close();
    const serverClosed = new Promise((resolve) => server.close(() => resolve()));
    void Promise.allSettled([shutdownGenerationExecutions(), serverClosed]).then(() => {
        appDatabase.close();
    });
};
server.on('error', (error) => {
    const processError = error;
    if (processError.code === 'EADDRINUSE' && !shutdownRequested) {
        serverListening = false;
        console.error(`[MK recoverable] server port ${port} is already in use; retrying in 1000ms\n${formatProcessFailure(error)}`);
        if (!listenRetryTimer) {
            listenRetryTimer = setTimeout(() => {
                listenRetryTimer = undefined;
                if (!shutdownRequested)
                    startListening();
            }, 1000);
        }
        return;
    }
    process.exitCode = 1;
    console.error(`[MK fatal] server error\n${formatProcessFailure(error)}`);
    shutdown();
});
process.once('uncaughtException', (error) => {
    process.exitCode = 1;
    console.error(`[MK fatal] uncaughtException\n${formatProcessFailure(error)}`);
    shutdown();
});
process.once('unhandledRejection', (reason) => {
    process.exitCode = 1;
    console.error(`[MK fatal] unhandledRejection\n${formatProcessFailure(reason)}`);
    shutdown();
});
process.once('exit', (code) => {
    console.error(`[MK process] exit code=${code}`);
});
if (desktopToken) {
    app.post('/api/desktop/shutdown', (request, response) => {
        if (!isAuthorizedDesktopRequest({
            configuredToken: desktopToken,
            requestToken: request.get('x-mk-desktop-token'),
            remoteAddress: request.socket.remoteAddress,
        })) {
            response.status(403).json({ ok: false, message: 'Desktop shutdown request denied' });
            return;
        }
        response.status(202).json({ ok: true });
        console.error('[MK process] authenticated desktop shutdown requested');
        setImmediate(shutdown);
    });
}
if (webDistDir) {
    const indexPath = path.join(webDistDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
        throw new Error(`MK_WEB_DIST_DIR does not contain index.html: ${webDistDir}`);
    }
    app.use(express.static(webDistDir));
    app.get('*', (request, response, next) => {
        if (request.path === '/health' || request.path.startsWith('/api/') || request.path === '/api') {
            next();
            return;
        }
        response.sendFile(indexPath);
    });
}
function startListening() {
    if (shutdownRequested || serverListening)
        return;
    serverListening = true;
    server.listen(port, host, () => {
        const address = server.address();
        const listeningHost = address && typeof address !== 'string' ? address.address : host;
        const listeningPort = address && typeof address !== 'string' ? address.port : port;
        localPort = listeningPort;
        const origin = formatListeningOrigin({
            protocol,
            host: listeningHost,
            port: listeningPort,
        });
        allowedCorsOrigins.add(`${protocol}://127.0.0.1:${listeningPort}`);
        allowedCorsOrigins.add(`${protocol}://localhost:${listeningPort}`);
        if (desktopReadyFile) {
            writeDesktopReadyFile(desktopReadyFile, {
                port: listeningPort,
                origin: `${protocol}://127.0.0.1:${listeningPort}`,
            });
        }
        console.log(`MK ${FTV_PRODUCT_VERSION} server listening on ${origin}`);
    });
}
startListening();
process.once('SIGINT', () => {
    console.error('[MK process] received SIGINT');
    shutdown();
});
process.once('SIGTERM', () => {
    console.error('[MK process] received SIGTERM');
    shutdown();
});
