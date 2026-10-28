import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
const collectLibraryUrls = (value, urls) => {
    if (typeof value === 'string') {
        if (value.startsWith('/api/library-assets/files/'))
            urls.add(value);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item) => collectLibraryUrls(item, urls));
        return;
    }
    if (!value || typeof value !== 'object')
        return;
    Object.values(value).forEach((item) => collectLibraryUrls(item, urls));
};
const collectLegacyDirectorStorageIds = (value, ids) => {
    if (Array.isArray(value)) {
        value.forEach((item) => collectLegacyDirectorStorageIds(item, ids));
        return;
    }
    if (!value || typeof value !== 'object')
        return;
    Object.entries(value).forEach(([key, item]) => {
        if (key === 'storageId' && typeof item === 'string' && item.trim())
            ids.add(item);
        else
            collectLegacyDirectorStorageIds(item, ids);
    });
};
export const createProjectRoutes = (appDatabase, historyAssetStore, options = {}) => {
    const router = Router();
    const reclaimDetachedLibraryFiles = (detachedData, excludedCanvasScope) => {
        if (!options.libraryAssetsDir)
            return 0;
        const urls = new Set();
        collectLibraryUrls(detachedData, urls);
        let reclaimed = 0;
        urls.forEach((url) => {
            if (appDatabase.countHistoryAssetFileReferences(url, excludedCanvasScope) > 0)
                return;
            const fileName = decodeURIComponent(url.slice('/api/library-assets/files/'.length));
            if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..'))
                return;
            const filePath = path.join(options.libraryAssetsDir, fileName);
            if (!fs.existsSync(filePath))
                return;
            fs.rmSync(filePath, { force: true });
            reclaimed += 1;
        });
        return reclaimed;
    };
    router.get('/projects', (_request, response) => {
        response.json({
            ok: true,
            items: appDatabase.listProjects(),
            activeProjectId: appDatabase.getSetting('activeProjectId', null)
        });
    });
    router.get('/project-summaries', (_request, response) => {
        response.json({
            ok: true,
            items: appDatabase.listProjectSummaries(),
            activeProjectId: appDatabase.getSetting('activeProjectId', null)
        });
    });
    router.get('/projects/:id', (request, response) => {
        const project = appDatabase.getProject(request.params.id);
        if (!project) {
            response.status(404).json({ ok: false, code: 'project_not_found', message: '项目不存在' });
            return;
        }
        response.set('ETag', `"${project.revision ?? 0}"`);
        response.json({ ok: true, project });
    });
    router.patch('/projects/:id', (request, response) => {
        const patch = request.body;
        const ifMatch = request.get('if-match');
        const headerMatch = ifMatch?.match(/^(?:(?:W\/)?"(\d+)"|(\d+))$/);
        const expectedRevision = headerMatch ? Number(headerMatch[1] ?? headerMatch[2]) : Number.NaN;
        const validName = patch.name === undefined || (typeof patch.name === 'string' && patch.name.trim().length > 0 && patch.name.length <= 120);
        const validCover = patch.coverAssetId === undefined || patch.coverAssetId === null || typeof patch.coverAssetId === 'string';
        if (!validName || !validCover || (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
            response.status(400).json({ ok: false, code: 'invalid_project_metadata', message: '项目元数据或 If-Match 无效' });
            return;
        }
        if (patch.coverAssetId) {
            const cover = appDatabase.getLibraryAsset(patch.coverAssetId);
            if (!cover || cover.kind !== 'image') {
                response.status(400).json({ ok: false, code: 'invalid_project_cover', message: '项目封面必须是素材库图片' });
                return;
            }
        }
        const result = appDatabase.patchProjectMetadata({
            id: request.params.id,
            expectedRevision,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.coverAssetId !== undefined ? { coverAssetId: patch.coverAssetId } : {})
        });
        if (result.status === 'conflict') {
            response.status(409).json({ ok: false, code: 'project_revision_conflict', current: result.current });
            return;
        }
        response.set('ETag', `"${result.project.revision ?? 0}"`);
        response.json({ ok: true, project: result.project });
    });
    router.put('/projects/:id', (request, response) => {
        const id = request.params.id;
        const { name, data, activeProjectId, expectedRevision: bodyExpectedRevision } = request.body;
        if (!id || !data || typeof name !== 'string') {
            response.status(400).json({ ok: false, message: 'id, name and data are required' });
            return;
        }
        const ifMatch = request.get('if-match');
        const headerMatch = ifMatch?.match(/^(?:(?:W\/)?"(\d+)"|(\d+))$/);
        const expectedRevision = headerMatch ? Number(headerMatch[1] ?? headerMatch[2]) : bodyExpectedRevision;
        if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0) {
            response.status(428).json({ ok: false, code: 'project_revision_required', message: 'If-Match project revision is required' });
            return;
        }
        const result = appDatabase.saveProject({ id, name, data, expectedRevision: Number(expectedRevision) });
        if (result.status === 'conflict') {
            response.status(409).json({
                ok: false,
                code: 'project_revision_conflict',
                message: 'Project revision does not match the current server revision',
                current: result.current
            });
            return;
        }
        if (activeProjectId) {
            appDatabase.setSetting('activeProjectId', activeProjectId);
        }
        response.set('ETag', `"${result.project.revision ?? 0}"`);
        response.json({ ok: true, project: result.project });
    });
    router.patch('/projects/:id/node-positions', (request, response) => {
        const id = request.params.id;
        const { canvasId, patches, expectedRevision: bodyExpectedRevision } = request.body;
        const ifMatch = request.get('if-match');
        const headerMatch = ifMatch?.match(/^(?:(?:W\/)?"(\d+)"|(\d+))$/);
        const expectedRevision = headerMatch ? Number(headerMatch[1] ?? headerMatch[2]) : bodyExpectedRevision;
        const validPatches = Array.isArray(patches) && patches.length > 0 && patches.every((patch) => {
            if (!patch || typeof patch !== 'object' || Array.isArray(patch))
                return false;
            const value = patch;
            return typeof value.nodeId === 'string' &&
                Number.isFinite(value.fromPosition?.x) && Number.isFinite(value.fromPosition?.y) &&
                Number.isFinite(value.toPosition?.x) && Number.isFinite(value.toPosition?.y);
        });
        const uniquePatchIds = validPatches ? new Set(patches.map((patch) => patch.nodeId)) : null;
        if (!id || typeof canvasId !== 'string' || !validPatches || uniquePatchIds?.size !== patches.length) {
            response.status(400).json({ ok: false, message: 'canvasId and valid position patches are required' });
            return;
        }
        if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0) {
            response.status(428).json({ ok: false, code: 'project_revision_required', message: 'If-Match project revision is required' });
            return;
        }
        const result = appDatabase.patchProjectNodePositions({
            id,
            canvasId,
            patches,
            expectedRevision: Number(expectedRevision)
        });
        if (result.status === 'conflict') {
            response.status(409).json({
                ok: false,
                code: 'project_revision_conflict',
                current: result.current ? {
                    id: result.current.id,
                    name: result.current.name,
                    revision: result.current.revision,
                    updatedAt: result.current.updatedAt
                } : null
            });
            return;
        }
        response.set('ETag', `"${result.project.revision ?? 0}"`);
        response.json({
            ok: true,
            project: {
                id: result.project.id,
                name: result.project.name,
                revision: result.project.revision,
                updatedAt: result.project.updatedAt
            },
            touchedNodeIds: patches.map((patch) => patch.nodeId),
            patchCount: patches.length
        });
    });
    router.delete('/projects/:id', (request, response) => {
        const result = appDatabase.deleteProject(request.params.id);
        const reclaimedHistoryFiles = historyAssetStore?.reclaimDeletedAssets({
            assets: result.historyAssets,
            detachedData: result.detachedData
        }) ?? 0;
        const reclaimedLibraryFiles = reclaimDetachedLibraryFiles(result.detachedData);
        const reclaimedDirectorModelFiles = options.reclaimDirectorModelAssets?.(result.detachedData) ?? 0;
        const reclaimedMotion = options.reclaimProjectMotionAssets?.(request.params.id);
        const reclaimedMediaTransformJobs = options.reclaimProjectMediaTransformJobs?.({ projectId: request.params.id }) ?? 0;
        const legacyDirectorStorageIds = new Set();
        collectLegacyDirectorStorageIds(result.detachedData, legacyDirectorStorageIds);
        response.json({
            ok: true,
            deleted: result.deleted,
            deletedHistoryAssets: result.deletedHistoryAssets,
            clearedSettings: result.clearedSettings,
            reclaimedFiles: reclaimedHistoryFiles + reclaimedLibraryFiles + reclaimedDirectorModelFiles,
            deletedMotionAssets: reclaimedMotion?.deletedAssets ?? 0,
            deletedMotionJobs: reclaimedMotion?.deletedJobs ?? 0,
            deletedMediaTransformJobs: reclaimedMediaTransformJobs,
            legacyDirectorStorageIds: Array.from(legacyDirectorStorageIds)
        });
    });
    router.delete('/projects/:projectId/canvases/:canvasId/history-assets', (request, response) => {
        const scope = {
            projectId: request.params.projectId,
            canvasId: request.params.canvasId
        };
        const result = appDatabase.deleteCanvasHistoryAssets(scope);
        const reclaimedHistoryFiles = historyAssetStore?.reclaimDeletedAssets({
            assets: result.historyAssets,
            detachedData: result.detachedData,
            excludedCanvasScope: scope
        }) ?? 0;
        const reclaimedLibraryFiles = reclaimDetachedLibraryFiles(result.detachedData, scope);
        const deletedMediaTransformJobs = options.reclaimProjectMediaTransformJobs?.(scope) ?? 0;
        response.json({
            ok: true,
            deletedHistoryAssets: result.deletedHistoryAssets,
            reclaimedFiles: reclaimedHistoryFiles + reclaimedLibraryFiles,
            deletedMediaTransformJobs
        });
    });
    return router;
};
