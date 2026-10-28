import fs from 'node:fs';
import { Router } from 'express';
const parseCursor = (value) => {
    if (typeof value !== 'string' || !value)
        return null;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (!parsed || typeof parsed !== 'object')
            return null;
        const cursor = parsed;
        return typeof cursor.updatedAt === 'string' && typeof cursor.id === 'string'
            ? { updatedAt: cursor.updatedAt, id: cursor.id }
            : null;
    }
    catch {
        return null;
    }
};
const encodeCursor = (cursor) => (cursor ? Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url') : null);
const readRole = (value) => {
    if (!value || typeof value !== 'object')
        return null;
    const role = value;
    return typeof role.id === 'string' && role.id.trim() ? role : null;
};
const readTagGroup = (value) => {
    if (typeof value !== 'string')
        return [];
    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed))
            return [];
        return Array.from(new Set(parsed
            .filter((tag) => typeof tag === 'string' && Boolean(tag.trim()))
            .map((tag) => tag.trim())));
    }
    catch {
        return [];
    }
};
export const createRoleRoutes = (appDatabase, { snapshotLibraryAssetBlob, snapshotRoleAssetBlob, consumeRoleAssetSources, reclaimBlobFiles } = {}) => {
    const router = Router();
    const asyncRoute = (handler) => (request, response, next) => { void handler(request, response).catch(next); };
    const normalizeRoleImages = (roleId, values) => Promise.all(values.map(async (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return value;
        const image = value;
        const imageId = typeof image.id === 'string' ? image.id : '';
        let blobId = typeof image.blobId === 'string' ? image.blobId : '';
        if (blobId && !appDatabase.getAssetBlob(blobId))
            blobId = '';
        if (!blobId && typeof image.historyAssetId === 'string') {
            blobId = appDatabase.getHistoryAssetById(image.historyAssetId)?.blobId ?? '';
        }
        if (!blobId && typeof image.libraryAssetId === 'string') {
            blobId = appDatabase.getLibraryAsset(image.libraryAssetId)?.blobId
                ?? await snapshotLibraryAssetBlob?.(image.libraryAssetId)
                ?? '';
        }
        if (!blobId && typeof image.url === 'string') {
            blobId = await snapshotRoleAssetBlob?.(image.url, typeof image.thumbnailUrl === 'string' ? image.thumbnailUrl : undefined) ?? '';
        }
        const hasExplicitManagedSource = typeof image.historyAssetId === 'string'
            || typeof image.libraryAssetId === 'string'
            || (typeof image.url === 'string' && image.url.startsWith('/api/role-assets/files/'));
        if (!blobId || !imageId) {
            if (imageId && hasExplicitManagedSource)
                throw new Error('角色图片来源不存在或已变化');
            return image;
        }
        return {
            ...image,
            blobId,
            url: `/api/roles/${encodeURIComponent(roleId)}/images/${encodeURIComponent(imageId)}/file`
        };
    }));
    const preserveRetiredImages = (role, current) => {
        if (!current)
            return role;
        const nextIds = new Set((Array.isArray(role.images) ? role.images : []).flatMap((value) => (value && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string'
            ? [value.id]
            : [])));
        const candidates = [
            ...(Array.isArray(current.images) ? current.images : []),
            ...(Array.isArray(current.retiredImages) ? current.retiredImages : []),
            ...(Array.isArray(role.retiredImages) ? role.retiredImages : [])
        ];
        const retired = new Map();
        candidates.forEach((value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                return;
            const id = value.id;
            if (typeof id === 'string' && id && !nextIds.has(id))
                retired.set(id, value);
        });
        return { ...role, retiredImages: Array.from(retired.values()) };
    };
    const normalizeRoleAssetOwnership = async (role) => ({
        ...role,
        ...(Array.isArray(role.images) ? { images: await normalizeRoleImages(role.id, role.images) } : {}),
        ...(Array.isArray(role.retiredImages) ? { retiredImages: await normalizeRoleImages(role.id, role.retiredImages) } : {})
    });
    const collectRoleUploadSources = (role) => [
        ...(Array.isArray(role.images) ? role.images : []),
        ...(Array.isArray(role.retiredImages) ? role.retiredImages : [])
    ].flatMap((value) => {
        const url = value && typeof value === 'object' && !Array.isArray(value)
            ? value.url
            : undefined;
        return typeof url === 'string' && url.startsWith('/api/role-assets/files/') ? [url] : [];
    });
    const collectRoleBlobIds = (role) => [
        ...(Array.isArray(role?.images) ? role.images : []),
        ...(Array.isArray(role?.retiredImages) ? role.retiredImages : [])
    ].flatMap((value) => {
        const id = value && typeof value === 'object' && !Array.isArray(value)
            ? value.blobId
            : undefined;
        return typeof id === 'string' && id ? [id] : [];
    });
    const reclaimRoleBlobs = (ids) => {
        appDatabase.deleteUnreferencedAssetBlobs(ids).forEach((blob) => {
            if (reclaimBlobFiles)
                reclaimBlobFiles(blob);
            else if (fs.existsSync(blob.sourcePath))
                fs.rmSync(blob.sourcePath, { force: true });
        });
    };
    const readRoleIds = (value) => Array.isArray(value)
        ? Array.from(new Set(value.filter((id) => typeof id === 'string' && Boolean(id.trim())))).slice(0, 500)
        : [];
    router.get('/roles', (request, response) => {
        const rawLimit = Number(request.query.limit);
        const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 60;
        const search = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, 120) : '';
        const tags = (Array.isArray(request.query.tag) ? request.query.tag : [request.query.tag])
            .filter((tag) => typeof tag === 'string' && Boolean(tag.trim()))
            .map((tag) => tag.trim())
            .slice(0, 12);
        const rawTagGroups = Array.isArray(request.query.tagGroup)
            ? request.query.tagGroup
            : [request.query.tagGroup];
        const requestedTagGroups = rawTagGroups
            .slice(0, 8)
            .map((value) => readTagGroup(value).slice(0, 16))
            .filter((group) => group.length > 0);
        const tagGroups = requestedTagGroups.length > 0
            ? requestedTagGroups
            : tags.map((tag) => [tag]);
        const rawCursor = request.query.cursor;
        const cursor = parseCursor(rawCursor);
        if (typeof rawCursor === 'string' && rawCursor && !cursor) {
            response.status(400).json({ ok: false, message: 'invalid cursor' });
            return;
        }
        const page = appDatabase.listRolesPage({
            limit,
            ...(search ? { search } : {}),
            ...(tagGroups.length > 0 ? { tagGroups } : {}),
            ...(cursor ? { cursor } : {})
        });
        response.json({ ...page, ok: true, nextCursor: encodeCursor(page.nextCursor) });
    });
    router.put('/roles', asyncRoute(async (request, response) => {
        const { items } = request.body;
        if (!Array.isArray(items)) {
            response.status(400).json({ ok: false, message: 'items is required' });
            return;
        }
        const normalized = items
            .filter((item) => typeof item?.id === 'string' && item.id.length > 0);
        if (appDatabase.listRoles().length > 0) {
            response.status(409).json({ ok: false, code: 'migration_already_completed', message: '角色库已迁移' });
            return;
        }
        const now = new Date().toISOString();
        const consumedSources = normalized.flatMap(collectRoleUploadSources);
        const migrated = await Promise.all(normalized.map((item) => normalizeRoleAssetOwnership({ ...item, updatedAt: now })));
        appDatabase.replaceRoles(migrated);
        consumeRoleAssetSources?.(consumedSources);
        response.json({ ok: true, migrated: migrated.length, items: migrated });
    }));
    router.post('/roles/migrate', asyncRoute(async (request, response) => {
        const { items } = request.body;
        if (!Array.isArray(items)) {
            response.status(400).json({ ok: false, message: 'items is required' });
            return;
        }
        if (appDatabase.listRoles().length > 0) {
            response.status(409).json({ ok: false, code: 'migration_already_completed', message: '角色库已迁移' });
            return;
        }
        const now = new Date().toISOString();
        const roles = items.map(readRole).filter((item) => Boolean(item));
        const consumedSources = roles.flatMap(collectRoleUploadSources);
        const migrated = await Promise.all(roles.map((item) => normalizeRoleAssetOwnership({ ...item, updatedAt: now })));
        appDatabase.replaceRoles(migrated);
        consumeRoleAssetSources?.(consumedSources);
        response.json({ ok: true, migrated: migrated.length });
    }));
    router.post('/roles', asyncRoute(async (request, response) => {
        const item = readRole(request.body?.item);
        if (!item) {
            response.status(400).json({ ok: false, message: 'item.id is required' });
            return;
        }
        if (appDatabase.getRole(item.id)) {
            response.status(409).json({ ok: false, code: 'role_exists', message: '角色已存在' });
            return;
        }
        const consumedSources = collectRoleUploadSources(item);
        const persisted = await normalizeRoleAssetOwnership({ ...item, updatedAt: new Date().toISOString() });
        appDatabase.upsertRole(persisted);
        consumeRoleAssetSources?.(consumedSources);
        response.status(201).json({ ok: true, item: persisted });
    }));
    router.post('/roles/delete-impact', (request, response) => {
        const ids = readRoleIds(request.body?.ids);
        if (ids.length === 0) {
            response.status(400).json({ ok: false, message: 'ids are required' });
            return;
        }
        const items = appDatabase.listRoleDeletionImpact(ids);
        response.json({
            ok: true,
            items,
            totalReferences: items.reduce((count, item) => count + item.references.length, 0)
        });
    });
    router.patch('/roles/:roleId', asyncRoute(async (request, response) => {
        const roleId = String(request.params.roleId ?? '');
        const current = appDatabase.getRole(roleId);
        if (!current) {
            response.status(404).json({ ok: false, code: 'role_not_found', message: '角色不存在' });
            return;
        }
        const patch = request.body?.patch;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            response.status(400).json({ ok: false, message: 'patch is required' });
            return;
        }
        const nextRole = preserveRetiredImages({
            ...current,
            ...patch,
            id: current.id,
            updatedAt: new Date().toISOString()
        }, current);
        const consumedSources = collectRoleUploadSources(nextRole);
        const persisted = await normalizeRoleAssetOwnership(nextRole);
        appDatabase.upsertRole(persisted);
        consumeRoleAssetSources?.(consumedSources);
        response.json({ ok: true, item: persisted });
    }));
    router.delete('/roles/:roleId', (request, response) => {
        const role = appDatabase.getRole(request.params.roleId);
        const blobIds = collectRoleBlobIds(role);
        const deleted = appDatabase.deleteRoles([request.params.roleId]);
        if (deleted > 0)
            reclaimRoleBlobs(blobIds);
        response.status(deleted > 0 ? 200 : 404).json({ ok: deleted > 0, deleted });
    });
    router.delete('/roles', (request, response) => {
        const ids = request.body?.ids;
        if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
            response.status(400).json({ ok: false, message: 'ids is required' });
            return;
        }
        const blobIds = ids.flatMap((id) => collectRoleBlobIds(appDatabase.getRole(id)));
        const deleted = appDatabase.deleteRoles(ids);
        if (deleted > 0)
            reclaimRoleBlobs(blobIds);
        response.json({ ok: true, deleted });
    });
    router.use((error, _request, response, _next) => {
        response.status(500).json({
            ok: false,
            message: error instanceof Error ? error.message : '角色资产保存失败'
        });
    });
    return router;
};
