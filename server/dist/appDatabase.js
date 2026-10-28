import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { isAssetRef, readAuthoritativeAssetRef } from '@ftv/shared';
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8');
const SQLJS_BACKUP_SUFFIX = '.sqljs-backup';
const STORAGE_DRIVER_KEY = 'storage_driver';
const STORAGE_DRIVER_VALUE = 'better-sqlite3';
const nowIso = () => new Date().toISOString();
const migrateNodeAssetIdentity = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return value;
    const data = value;
    const referenceAsset = data.referenceAsset && typeof data.referenceAsset === 'object' && !Array.isArray(data.referenceAsset)
        ? data.referenceAsset
        : null;
    const nextReference = referenceAsset && !isAssetRef(referenceAsset.assetRef)
        ? readAuthoritativeAssetRef(referenceAsset)
        : undefined;
    const nextRoot = !isAssetRef(data.assetRef)
        ? readAuthoritativeAssetRef(data)
        : undefined;
    const historyIds = Array.isArray(data.historyAssetIds)
        ? data.historyAssetIds.filter((id) => typeof id === 'string' && Boolean(id))
        : [];
    const libraryIds = Array.isArray(data.libraryAssetIds)
        ? data.libraryAssetIds.filter((id) => typeof id === 'string' && Boolean(id))
        : [];
    const nextRefs = Array.isArray(data.assetRefs) && data.assetRefs.every(isAssetRef)
        ? undefined
        : historyIds.length > 0
            ? historyIds.map((assetId) => ({ owner: 'history', assetId }))
            : libraryIds.length > 0
                ? libraryIds.map((assetId) => ({ owner: 'library', assetId }))
                : undefined;
    if (!nextReference && !nextRoot && !nextRefs)
        return value;
    return {
        ...data,
        ...(nextRoot ? { assetRef: nextRoot } : {}),
        ...(nextRefs ? { assetRefs: nextRefs } : {}),
        ...(referenceAsset ? { referenceAsset: { ...referenceAsset, ...(nextReference ? { assetRef: nextReference } : {}) } } : {})
    };
};
const migrateProjectAssetIdentities = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return value;
    const project = value;
    if (!Array.isArray(project.canvases))
        return value;
    return {
        ...project,
        canvases: project.canvases.map((canvas) => {
            if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas))
                return canvas;
            const record = canvas;
            if (!Array.isArray(record.nodes))
                return canvas;
            return {
                ...record,
                nodes: record.nodes.map((node) => {
                    if (!node || typeof node !== 'object' || Array.isArray(node))
                        return node;
                    const nodeRecord = node;
                    return { ...nodeRecord, data: migrateNodeAssetIdentity(nodeRecord.data) };
                })
            };
        })
    };
};
const collectStructuredAssetRefs = (value, refs) => {
    if (Array.isArray(value)) {
        value.forEach((item) => collectStructuredAssetRefs(item, refs));
        return;
    }
    if (!value || typeof value !== 'object')
        return;
    const record = value;
    if (isAssetRef(record.assetRef))
        refs.push(record.assetRef);
    if (Array.isArray(record.assetRefs))
        record.assetRefs.filter(isAssetRef).forEach((ref) => refs.push(ref));
    Object.entries(record).forEach(([key, item]) => {
        if (key !== 'assetRef' && key !== 'assetRefs')
            collectStructuredAssetRefs(item, refs);
    });
};
const parseJson = (value, fallback) => {
    if (!value)
        return fallback;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
};
const isSqliteDatabaseFile = (filePath) => {
    const handle = fs.openSync(filePath, 'r');
    try {
        const header = Buffer.alloc(SQLITE_HEADER.length);
        return fs.readSync(handle, header, 0, header.length, 0) === header.length && header.equals(SQLITE_HEADER);
    }
    finally {
        fs.closeSync(handle);
    }
};
const hasBetterSqliteStorageMarker = (dbPath) => {
    const database = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'storage_metadata'").get();
        if (!table)
            return false;
        const row = database.prepare('SELECT value FROM storage_metadata WHERE key = ?').get(STORAGE_DRIVER_KEY);
        return row?.value === STORAGE_DRIVER_VALUE;
    }
    finally {
        database.close();
    }
};
const createSqlJsMigrationBackup = (dbPath) => {
    if (!fs.existsSync(dbPath))
        return null;
    if (!isSqliteDatabaseFile(dbPath)) {
        throw new Error(`Invalid SQLite database file: ${dbPath}`);
    }
    if (hasBetterSqliteStorageMarker(dbPath))
        return null;
    const backupPath = `${dbPath}${SQLJS_BACKUP_SUFFIX}`;
    if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(dbPath, backupPath, fs.constants.COPYFILE_EXCL);
    }
    return backupPath;
};
const selectAll = (db, sql, params = []) => db.prepare(sql).all(...params);
const selectOne = (db, sql, params = []) => db.prepare(sql).get(...params);
const run = (db, sql, params = []) => (db.prepare(sql).run(...params).changes);
export const createAppDatabase = async ({ dbPath }) => {
    const dbDir = path.dirname(dbPath);
    fs.mkdirSync(dbDir, { recursive: true });
    const migrationBackupPath = createSqlJsMigrationBackup(dbPath);
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    const journalMode = String(db.pragma('journal_mode = WAL', { simple: true }));
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
    CREATE TABLE IF NOT EXISTS history_assets (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      canvas_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video')),
      source TEXT NOT NULL,
      preview_url TEXT,
      thumbnail_url TEXT,
      created_at TEXT NOT NULL,
      metadata_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_history_assets_created_at
      ON history_assets(created_at DESC);

    CREATE TABLE IF NOT EXISTS role_library (
      id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asset_blobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video')),
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      source_path TEXT NOT NULL,
      thumbnail_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_blobs_content_hash
      ON asset_blobs(content_hash);

    CREATE INDEX IF NOT EXISTS idx_role_library_updated_id
      ON role_library(updated_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data_json TEXT NOT NULL,
      cover_asset_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS library_assets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video')),
      tags_json TEXT NOT NULL,
      file_url TEXT NOT NULL UNIQUE,
      thumbnail_url TEXT,
      library_asset_id TEXT,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      provenance_json TEXT,
      storage_mode TEXT NOT NULL DEFAULT 'managed' CHECK (storage_mode IN ('managed', 'linked')),
      source_path TEXT,
      source_size_bytes INTEGER,
      source_modified_at_ms INTEGER,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_library_assets_updated_id
      ON library_assets(updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_library_assets_kind_updated_id
      ON library_assets(kind, updated_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS library_asset_provenance (
      asset_id TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(asset_id, provenance_json),
      FOREIGN KEY (asset_id) REFERENCES library_assets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_canvas_nodes (
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      PRIMARY KEY (project_id, canvas_id, node_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_node_positions (
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, canvas_id, node_id),
      FOREIGN KEY (project_id, canvas_id, node_id)
        REFERENCES project_canvas_nodes(project_id, canvas_id, node_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_project_node_positions_project_canvas
      ON project_node_positions(project_id, canvas_id);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS storage_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS generation_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('text', 'image', 'video')),
      provider_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      provider_profile TEXT,
      base_url TEXT NOT NULL,
      request_json TEXT NOT NULL,
      status TEXT NOT NULL,
      upstream_task_id TEXT,
      result_json TEXT,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      deadline_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_generation_jobs_status_updated
      ON generation_jobs(status, updated_at);

    CREATE TABLE IF NOT EXISTS director_motion_assets (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('mediapipe_capture', 'gem_capture', 'kimodo_generate', 'mixamo_import')),
      source_file TEXT,
      soma_file TEXT,
      skeleton_file TEXT,
      ue4_file TEXT NOT NULL,
      duration_frames INTEGER NOT NULL CHECK (duration_frames > 0),
      source_fps REAL NOT NULL CHECK (source_fps > 0),
      rig_version TEXT NOT NULL CHECK (rig_version IN ('mk-ue4-67-v1', 'mixamo-native-v1')),
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_node_asset_refs (
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      owner TEXT NOT NULL CHECK (owner IN ('library', 'history', 'role')),
      asset_id TEXT,
      role_id TEXT,
      image_id TEXT,
      PRIMARY KEY (project_id, canvas_id, node_id, owner, asset_id, role_id, image_id),
      FOREIGN KEY (project_id, canvas_id, node_id)
        REFERENCES project_canvas_nodes(project_id, canvas_id, node_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_project_node_asset_refs_owner_asset
      ON project_node_asset_refs(owner, asset_id);
    CREATE INDEX IF NOT EXISTS idx_project_node_asset_refs_role
      ON project_node_asset_refs(owner, role_id);

    CREATE INDEX IF NOT EXISTS idx_director_motion_assets_project_created
      ON director_motion_assets(project_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS director_model_assets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      extension TEXT NOT NULL CHECK (extension IN ('.fbx', '.obj', '.glb')),
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      source_path TEXT NOT NULL,
      retained INTEGER NOT NULL DEFAULT 1,
      released_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_director_model_assets_created
      ON director_model_assets(created_at DESC, id DESC);
  `);
    // Remove the two legacy demo-only records from existing browser and desktop databases.
    db.prepare(`
    DELETE FROM role_library
    WHERE id IN ('role-shen-zhaozhao', 'role-cyber-youth')
  `).run();
    const motionTableSql = selectOne(db, `
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'director_motion_assets'
  `)?.sql ?? '';
    if (!motionTableSql.includes("'mixamo_import'") || !motionTableSql.includes("'mixamo-native-v1'") || motionTableSql.includes('soma_file TEXT NOT NULL')) {
        db.transaction(() => {
            db.exec(`
        DROP INDEX IF EXISTS idx_director_motion_assets_project_created;
        ALTER TABLE director_motion_assets RENAME TO director_motion_assets_legacy_v1;
        CREATE TABLE director_motion_assets (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          name TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('mediapipe_capture', 'gem_capture', 'kimodo_generate', 'mixamo_import')),
          source_file TEXT,
          soma_file TEXT,
          skeleton_file TEXT,
          ue4_file TEXT NOT NULL,
          duration_frames INTEGER NOT NULL CHECK (duration_frames > 0),
          source_fps REAL NOT NULL CHECK (source_fps > 0),
          rig_version TEXT NOT NULL CHECK (rig_version IN ('mk-ue4-67-v1', 'mixamo-native-v1')),
          metadata_json TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO director_motion_assets (
          id, project_id, name, source_kind, source_file, soma_file, skeleton_file,
          ue4_file, duration_frames, source_fps, rig_version, metadata_json, created_at
        ) SELECT
          id, project_id, name, source_kind, source_file, soma_file, skeleton_file,
          ue4_file, duration_frames, source_fps, rig_version, metadata_json, created_at
        FROM director_motion_assets_legacy_v1;
        DROP TABLE director_motion_assets_legacy_v1;
        CREATE INDEX idx_director_motion_assets_project_created
          ON director_motion_assets(project_id, created_at DESC, id DESC);
      `);
        })();
    }
    const historyColumns = new Set(db.prepare('PRAGMA table_info(history_assets)').all().map((column) => column.name));
    if (!historyColumns.has('project_id'))
        db.exec('ALTER TABLE history_assets ADD COLUMN project_id TEXT');
    if (!historyColumns.has('canvas_id'))
        db.exec('ALTER TABLE history_assets ADD COLUMN canvas_id TEXT');
    if (!historyColumns.has('thumbnail_url'))
        db.exec('ALTER TABLE history_assets ADD COLUMN thumbnail_url TEXT');
    if (!historyColumns.has('library_asset_id'))
        db.exec('ALTER TABLE history_assets ADD COLUMN library_asset_id TEXT');
    if (!historyColumns.has('blob_id'))
        db.exec('ALTER TABLE history_assets ADD COLUMN blob_id TEXT');
    const libraryAssetColumns = new Set(db.prepare('PRAGMA table_info(library_assets)').all().map((column) => column.name));
    if (!libraryAssetColumns.has('thumbnail_url'))
        db.exec('ALTER TABLE library_assets ADD COLUMN thumbnail_url TEXT');
    if (!libraryAssetColumns.has('storage_mode'))
        db.exec("ALTER TABLE library_assets ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'managed'");
    if (!libraryAssetColumns.has('source_path'))
        db.exec('ALTER TABLE library_assets ADD COLUMN source_path TEXT');
    if (!libraryAssetColumns.has('source_size_bytes'))
        db.exec('ALTER TABLE library_assets ADD COLUMN source_size_bytes INTEGER');
    if (!libraryAssetColumns.has('source_modified_at_ms'))
        db.exec('ALTER TABLE library_assets ADD COLUMN source_modified_at_ms INTEGER');
    if (!libraryAssetColumns.has('provenance_json'))
        db.exec('ALTER TABLE library_assets ADD COLUMN provenance_json TEXT');
    if (!libraryAssetColumns.has('archived_at'))
        db.exec('ALTER TABLE library_assets ADD COLUMN archived_at TEXT');
    if (!libraryAssetColumns.has('blob_id'))
        db.exec('ALTER TABLE library_assets ADD COLUMN blob_id TEXT');
    const assetBlobMigrationKey = 'asset_blob_identity_v1';
    const assetBlobMigrated = selectOne(db, 'SELECT value FROM storage_metadata WHERE key = ?', [assetBlobMigrationKey])?.value === 'complete';
    if (!assetBlobMigrated) {
        db.transaction(() => {
            db.exec(`
        INSERT OR IGNORE INTO asset_blobs (
          id, kind, mime_type, size_bytes, content_hash, source_path, thumbnail_url, created_at, updated_at
        )
        SELECT 'blob-' || content_hash, kind, mime_type, size_bytes, content_hash, source_path,
          thumbnail_url, created_at, updated_at
        FROM library_assets
        WHERE storage_mode = 'managed' AND source_path IS NOT NULL AND trim(source_path) <> '';

        UPDATE library_assets
        SET blob_id = (SELECT id FROM asset_blobs WHERE asset_blobs.content_hash = library_assets.content_hash)
        WHERE blob_id IS NULL AND storage_mode = 'managed';

        UPDATE history_assets
        SET blob_id = (
          SELECT library_assets.blob_id FROM library_assets
          WHERE library_assets.id = history_assets.library_asset_id
        )
        WHERE blob_id IS NULL AND library_asset_id IS NOT NULL;
      `);
            const roleRows = selectAll(db, 'SELECT id, data_json AS dataJson FROM role_library');
            const updateRole = db.prepare('UPDATE role_library SET data_json = ?, updated_at = ? WHERE id = ?');
            roleRows.forEach((row) => {
                const role = parseJson(row.dataJson, null);
                if (!role || !Array.isArray(role.images))
                    return;
                let changed = false;
                const images = role.images.map((value) => {
                    if (!value || typeof value !== 'object' || Array.isArray(value))
                        return value;
                    const image = value;
                    if (typeof image.blobId === 'string' && image.blobId)
                        return image;
                    let blobId;
                    if (typeof image.historyAssetId === 'string') {
                        blobId = selectOne(db, 'SELECT blob_id AS blobId FROM history_assets WHERE id = ?', [image.historyAssetId])?.blobId ?? undefined;
                    }
                    if (!blobId && typeof image.libraryAssetId === 'string') {
                        blobId = selectOne(db, 'SELECT blob_id AS blobId FROM library_assets WHERE id = ?', [image.libraryAssetId])?.blobId ?? undefined;
                    }
                    if (!blobId)
                        return image;
                    changed = true;
                    return {
                        ...image,
                        blobId,
                        ...(typeof image.id === 'string'
                            ? { url: `/api/roles/${encodeURIComponent(row.id)}/images/${encodeURIComponent(image.id)}/file` }
                            : {})
                    };
                });
                if (changed)
                    updateRole.run(JSON.stringify({ ...role, images }), nowIso(), row.id);
            });
            db.prepare('INSERT INTO storage_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
                .run(assetBlobMigrationKey, 'complete');
        })();
    }
    const directorModelAssetColumns = new Set(db.prepare('PRAGMA table_info(director_model_assets)').all().map((column) => column.name));
    if (!directorModelAssetColumns.has('retained'))
        db.exec('ALTER TABLE director_model_assets ADD COLUMN retained INTEGER NOT NULL DEFAULT 1');
    if (!directorModelAssetColumns.has('released_at'))
        db.exec('ALTER TABLE director_model_assets ADD COLUMN released_at TEXT');
    const projectColumns = new Set(db.prepare('PRAGMA table_info(projects)').all().map((column) => column.name));
    if (!projectColumns.has('revision'))
        db.exec('ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    if (!projectColumns.has('cover_asset_id'))
        db.exec('ALTER TABLE projects ADD COLUMN cover_asset_id TEXT');
    if (!projectColumns.has('created_at')) {
        db.exec('ALTER TABLE projects ADD COLUMN created_at TEXT');
        db.prepare('UPDATE projects SET created_at = updated_at WHERE created_at IS NULL').run();
    }
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_history_assets_scope_created_id
      ON history_assets(project_id, canvas_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_history_assets_scope_kind_created_id
      ON history_assets(project_id, canvas_id, kind, created_at DESC, id DESC);
  `);
    const unscopedHistoryRows = selectAll(db, `
    SELECT id, metadata_json AS metadataJson
    FROM history_assets
    WHERE project_id IS NULL OR canvas_id IS NULL
  `);
    if (unscopedHistoryRows.length > 0) {
        const projectRows = selectAll(db, 'SELECT id, data_json AS dataJson FROM projects');
        const scopesByNodeId = new Map();
        const projectFallbacks = projectRows.map((project) => {
            const data = parseJson(project.dataJson, {});
            (data.canvases ?? []).forEach((canvas) => {
                const canvasId = canvas.id;
                if (!canvasId)
                    return;
                (canvas.nodes ?? []).forEach((node) => {
                    if (!node.id)
                        return;
                    const scopes = scopesByNodeId.get(node.id) ?? [];
                    scopes.push({ projectId: project.id, canvasId });
                    scopesByNodeId.set(node.id, scopes);
                });
            });
            return data.activeCanvasId ? { projectId: project.id, canvasId: data.activeCanvasId } : null;
        }).filter((scope) => Boolean(scope));
        const singleProjectFallback = projectRows.length === 1 ? projectFallbacks[0] : undefined;
        const backfill = db.prepare(`
      UPDATE history_assets SET project_id = ?, canvas_id = ?
      WHERE id = ? AND (project_id IS NULL OR canvas_id IS NULL)
    `);
        db.transaction(() => {
            unscopedHistoryRows.forEach((row) => {
                const nodeId = parseJson(row.metadataJson, {}).nodeId;
                const nodeScopes = nodeId ? scopesByNodeId.get(nodeId) ?? [] : [];
                const scope = nodeScopes.length === 1 ? nodeScopes[0] : singleProjectFallback;
                if (scope)
                    backfill.run(scope.projectId, scope.canvasId, row.id);
            });
        })();
    }
    const nodeRegistryMigrationKey = 'project_canvas_nodes_v1';
    const nodeRegistryMigrated = db.prepare('SELECT value FROM storage_metadata WHERE key = ?').get(nodeRegistryMigrationKey);
    if (!nodeRegistryMigrated) {
        const insertNodeRegistry = db.prepare(`
      INSERT OR IGNORE INTO project_canvas_nodes (project_id, canvas_id, node_id) VALUES (?, ?, ?)
    `);
        const projectRows = selectAll(db, 'SELECT id, data_json AS dataJson FROM projects');
        db.transaction(() => {
            projectRows.forEach((project) => {
                const data = parseJson(project.dataJson, {});
                (data.canvases ?? []).forEach((canvas) => {
                    if (!canvas.id)
                        return;
                    (canvas.nodes ?? []).forEach((node) => {
                        if (node.id)
                            insertNodeRegistry.run(project.id, canvas.id, node.id);
                    });
                });
            });
            db.prepare('INSERT INTO storage_metadata (key, value) VALUES (?, ?)').run(nodeRegistryMigrationKey, 'complete');
        })();
    }
    db.prepare(`
    INSERT INTO storage_metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(STORAGE_DRIVER_KEY, STORAGE_DRIVER_VALUE);
    const mapHistoryAssetRows = (rows) => rows.map(({ metadataJson, model, previewUrl, thumbnailUrl, libraryAssetId, blobId, projectId, canvasId, ...item }) => {
        const asset = {
            id: item.id,
            name: item.name,
            kind: item.kind,
            source: item.source,
            createdAt: item.createdAt
        };
        if (projectId)
            asset.projectId = projectId;
        if (canvasId)
            asset.canvasId = canvasId;
        if (previewUrl)
            asset.previewUrl = previewUrl;
        if (thumbnailUrl)
            asset.thumbnailUrl = thumbnailUrl;
        if (libraryAssetId)
            asset.libraryAssetId = libraryAssetId;
        if (blobId)
            asset.blobId = blobId;
        if (metadataJson) {
            const metadata = parseJson(metadataJson, null);
            if (metadata)
                asset.metadata = metadata;
        }
        else if (model) {
            asset.metadata = { model };
        }
        return asset;
    });
    const historySelect = `
    SELECT id, project_id AS projectId, canvas_id AS canvasId, name, kind, source,
      preview_url AS previewUrl, thumbnail_url AS thumbnailUrl, library_asset_id AS libraryAssetId,
      blob_id AS blobId, created_at AS createdAt,
      metadata_json AS metadataJson
    FROM history_assets
  `;
    const listHistoryAssets = (scope) => {
        const where = scope ? 'WHERE project_id = ? AND canvas_id = ?' : '';
        const params = scope ? [scope.projectId, scope.canvasId] : [];
        return mapHistoryAssetRows(selectAll(db, `${historySelect} ${where} ORDER BY created_at DESC, id DESC`, params));
    };
    const listHistoryAssetsPage = (query) => {
        const clauses = ['project_id = ?', 'canvas_id = ?'];
        const params = [query.projectId, query.canvasId];
        const kinds = query.kinds ?? (query.kind ? [query.kind] : []);
        if (kinds.length > 0) {
            clauses.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
            params.push(...kinds);
        }
        if (query.providerId) {
            clauses.push("json_extract(metadata_json, '$.providerId') = ?");
            params.push(query.providerId);
        }
        if (query.model) {
            clauses.push("json_extract(metadata_json, '$.model') = ?");
            params.push(query.model);
        }
        const term = query.query?.trim();
        if (term) {
            clauses.push('(name LIKE ? OR source LIKE ? OR metadata_json LIKE ?)');
            const pattern = `%${term}%`;
            params.push(pattern, pattern, pattern);
        }
        const order = query.order ?? 'desc';
        if (query.cursorPoint) {
            const comparator = order === 'asc' ? '>' : '<';
            clauses.push(`(created_at ${comparator} ? OR (created_at = ? AND id ${comparator} ?))`);
            params.push(query.cursorPoint.createdAt, query.cursorPoint.createdAt, query.cursorPoint.id);
        }
        params.push(query.limit);
        return mapHistoryAssetRows(selectAll(db, `
      SELECT id, project_id AS projectId, canvas_id AS canvasId, name, kind, source,
        preview_url AS previewUrl, thumbnail_url AS thumbnailUrl, library_asset_id AS libraryAssetId,
        blob_id AS blobId, created_at AS createdAt,
        json_extract(metadata_json, '$.model') AS model
      FROM history_assets
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at ${order === 'asc' ? 'ASC' : 'DESC'}, id ${order === 'asc' ? 'ASC' : 'DESC'}
      LIMIT ?
    `, params));
    };
    const countHistoryAssetsByKind = (scope) => {
        const counts = { image: 0, video: 0, audio: 0 };
        const rows = selectAll(db, `
      SELECT kind, COUNT(*) AS count
      FROM history_assets
      WHERE project_id = ? AND canvas_id = ?
      GROUP BY kind
    `, [scope.projectId, scope.canvasId]);
        rows.forEach((row) => { counts[row.kind] = Number(row.count); });
        return counts;
    };
    const getHistoryAsset = (id, scope) => {
        const rows = selectAll(db, `
      ${historySelect}
      WHERE id = ? AND project_id = ? AND canvas_id = ?
      LIMIT 1
    `, [id, scope.projectId, scope.canvasId]);
        return mapHistoryAssetRows(rows)[0] ?? null;
    };
    const upsertHistoryAssetStatement = db.prepare(`
    INSERT INTO history_assets (id, project_id, canvas_id, name, kind, source, preview_url, thumbnail_url, library_asset_id, blob_id, created_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      project_id = excluded.project_id,
      canvas_id = excluded.canvas_id,
      kind = excluded.kind,
      source = excluded.source,
      preview_url = excluded.preview_url,
      thumbnail_url = COALESCE(excluded.thumbnail_url, history_assets.thumbnail_url),
      library_asset_id = COALESCE(excluded.library_asset_id, history_assets.library_asset_id),
      blob_id = COALESCE(excluded.blob_id, history_assets.blob_id),
      created_at = excluded.created_at,
      metadata_json = excluded.metadata_json
  `);
    const upsertHistoryAssetsTransaction = db.transaction((items) => {
        items.forEach((item) => {
            upsertHistoryAssetStatement.run(item.id, item.projectId ?? null, item.canvasId ?? null, item.name, item.kind, item.source, item.previewUrl ?? null, item.thumbnailUrl ?? null, item.libraryAssetId ?? null, item.blobId ?? null, item.createdAt ?? nowIso(), item.metadata ? JSON.stringify(item.metadata) : null);
        });
    });
    const upsertHistoryAssets = (items) => upsertHistoryAssetsTransaction(items);
    const deleteHistoryAssetsTransaction = db.transaction((ids, scope) => {
        let count = 0;
        ids.forEach((id) => {
            const result = scope
                ? db.prepare('DELETE FROM history_assets WHERE id = ? AND project_id = ? AND canvas_id = ?').run(id, scope.projectId, scope.canvasId)
                : db.prepare('DELETE FROM history_assets WHERE id = ?').run(id);
            count += result.changes;
        });
        return count;
    });
    const deleteHistoryAssets = (ids, scope) => ids.length === 0 ? 0 : deleteHistoryAssetsTransaction(ids, scope);
    const updateHistoryAsset = (id, scope, patch) => {
        const existing = getHistoryAsset(id, scope);
        if (!existing)
            return null;
        const nextMetadata = patch.metadata === undefined ? existing.metadata : { ...existing.metadata, ...patch.metadata };
        db.prepare(`
      UPDATE history_assets
      SET name = ?, source = ?, metadata_json = ?
      WHERE id = ? AND project_id = ? AND canvas_id = ?
    `).run(patch.name ?? existing.name, patch.source ?? existing.source, nextMetadata ? JSON.stringify(nextMetadata) : null, id, scope.projectId, scope.canvasId);
        return getHistoryAsset(id, scope);
    };
    const updateHistoryAssetThumbnail = (id, thumbnailUrl) => {
        db.prepare('UPDATE history_assets SET thumbnail_url = ? WHERE id = ?').run(thumbnailUrl, id);
    };
    const countHistoryAssetPreviewReferences = (previewUrl) => Number(db.prepare('SELECT COUNT(*) AS count FROM history_assets WHERE preview_url = ?').get(previewUrl)?.count ?? 0);
    const countHistoryAssetThumbnailReferences = (thumbnailUrl) => Number(db.prepare('SELECT COUNT(*) AS count FROM history_assets WHERE thumbnail_url = ?').get(thumbnailUrl)?.count ?? 0);
    const getHistoryAssetById = (id) => {
        const rows = selectAll(db, `${historySelect} WHERE id = ? LIMIT 1`, [id]);
        return mapHistoryAssetRows(rows)[0] ?? null;
    };
    const resolveHistoryAssetSource = (sourceUrl) => {
        let url;
        try {
            url = new URL(sourceUrl, 'http://mk.local');
        }
        catch {
            return null;
        }
        const match = url.pathname.match(/^\/api\/history-assets\/([^/]+)\/file$/);
        const projectId = url.searchParams.get('projectId')?.trim();
        const canvasId = url.searchParams.get('canvasId')?.trim();
        if (!match || !projectId || !canvasId)
            return null;
        let id;
        try {
            id = decodeURIComponent(match[1]);
        }
        catch {
            return null;
        }
        const asset = getHistoryAsset(id, { projectId, canvasId });
        const blob = asset?.blobId ? getAssetBlob(asset.blobId) : null;
        return blob && fs.existsSync(blob.sourcePath) ? fs.realpathSync(blob.sourcePath) : null;
    };
    const assetBlobSelect = `
    SELECT id, kind, mime_type AS mimeType, size_bytes AS sizeBytes,
      content_hash AS contentHash, source_path AS sourcePath,
      thumbnail_url AS thumbnailUrl, created_at AS createdAt, updated_at AS updatedAt
    FROM asset_blobs
  `;
    const mapAssetBlob = ({ thumbnailUrl, ...row }) => ({
        ...row,
        ...(thumbnailUrl ? { thumbnailUrl } : {})
    });
    const getAssetBlob = (id) => {
        const row = selectOne(db, `${assetBlobSelect} WHERE id = ?`, [id]);
        return row ? mapAssetBlob(row) : null;
    };
    const getAssetBlobByHash = (contentHash) => {
        const row = selectOne(db, `${assetBlobSelect} WHERE content_hash = ?`, [contentHash]);
        return row ? mapAssetBlob(row) : null;
    };
    const createAssetBlob = (blob) => {
        db.prepare(`
      INSERT INTO asset_blobs (
        id, kind, mime_type, size_bytes, content_hash, source_path, thumbnail_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(blob.id, blob.kind, blob.mimeType, blob.sizeBytes, blob.contentHash, blob.sourcePath, blob.thumbnailUrl ?? null, blob.createdAt, blob.updatedAt);
        return getAssetBlob(blob.id);
    };
    const updateAssetBlobThumbnail = (id, thumbnailUrl) => {
        db.prepare('UPDATE asset_blobs SET thumbnail_url = ?, updated_at = ? WHERE id = ?')
            .run(thumbnailUrl, nowIso(), id);
        return getAssetBlob(id);
    };
    const countAssetBlobReferences = (id) => {
        const library = Number(db.prepare('SELECT COUNT(*) AS count FROM library_assets WHERE blob_id = ?').get(id).count);
        const history = Number(db.prepare('SELECT COUNT(*) AS count FROM history_assets WHERE blob_id = ?').get(id).count);
        const role = selectAll(db, 'SELECT data_json AS dataJson FROM role_library')
            .reduce((count, row) => count + countJsonStringReferences(parseJson(row.dataJson, null), id), 0);
        return library + history + role;
    };
    const deleteUnreferencedAssetBlobs = (ids) => db.transaction((blobIds) => {
        const deleted = [];
        const statement = db.prepare('DELETE FROM asset_blobs WHERE id = ?');
        blobIds.forEach((id) => {
            const blob = getAssetBlob(id);
            if (!blob || countAssetBlobReferences(id) > 0)
                return;
            if (statement.run(id).changes > 0)
                deleted.push(blob);
        });
        return deleted;
    })(Array.from(new Set(ids)));
    const countJsonStringReferences = (value, target) => {
        if (typeof value === 'string')
            return value === target ? 1 : 0;
        if (Array.isArray(value)) {
            return value.reduce((count, item) => count + countJsonStringReferences(item, target), 0);
        }
        if (!value || typeof value !== 'object')
            return 0;
        return Object.values(value).reduce((count, item) => count + countJsonStringReferences(item, target), 0);
    };
    const collectJsonStrings = (value, values) => {
        if (typeof value === 'string') {
            values.add(value);
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((item) => collectJsonStrings(item, values));
            return;
        }
        if (!value || typeof value !== 'object')
            return;
        Object.values(value).forEach((item) => collectJsonStrings(item, values));
    };
    const excludeCanvasFromProjectData = (value, scope) => {
        if (!scope || !value || typeof value !== 'object' || Array.isArray(value))
            return value;
        const record = value;
        if (!Array.isArray(record.canvases))
            return value;
        return {
            ...record,
            canvases: record.canvases.filter((canvas) => (!canvas || typeof canvas !== 'object' || Array.isArray(canvas) || canvas.id !== scope.canvasId))
        };
    };
    const countHistoryAssetFileReferences = (publicUrl, excludedCanvasScope) => {
        const historyReferences = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM history_assets
      WHERE preview_url = ? OR thumbnail_url = ?
    `).get(publicUrl, publicUrl)?.count ?? 0);
        const projectReferences = selectAll(db, 'SELECT id, data_json AS dataJson FROM projects').reduce((count, project) => {
            const parsed = parseJson(project.dataJson, null);
            const data = excludedCanvasScope?.projectId === project.id
                ? excludeCanvasFromProjectData(parsed, excludedCanvasScope)
                : parsed;
            return count + countJsonStringReferences(data, publicUrl);
        }, 0);
        const roleReferences = selectAll(db, 'SELECT data_json AS dataJson FROM role_library').reduce((count, role) => count + countJsonStringReferences(parseJson(role.dataJson, null), publicUrl), 0);
        const libraryReferences = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM library_assets WHERE file_url = ? OR thumbnail_url = ?
    `).get(publicUrl, publicUrl)?.count ?? 0);
        const blobReferences = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM asset_blobs WHERE thumbnail_url = ?
    `).get(publicUrl)?.count ?? 0);
        const settingReferences = selectAll(db, 'SELECT value_json AS valueJson FROM app_settings')
            .reduce((count, setting) => count + countJsonStringReferences(parseJson(setting.valueJson, null), publicUrl), 0);
        return historyReferences + projectReferences + roleReferences + libraryReferences + blobReferences + settingReferences;
    };
    const listHistoryAssetFileReferences = (excludedCanvasScope) => {
        const references = new Set();
        selectAll(db, `
      SELECT preview_url AS previewUrl, thumbnail_url AS thumbnailUrl FROM history_assets
    `).forEach((row) => {
            if (row.previewUrl)
                references.add(row.previewUrl);
            if (row.thumbnailUrl)
                references.add(row.thumbnailUrl);
        });
        selectAll(db, 'SELECT id, data_json AS dataJson FROM projects').forEach((project) => {
            const parsed = parseJson(project.dataJson, null);
            collectJsonStrings(excludedCanvasScope?.projectId === project.id
                ? excludeCanvasFromProjectData(parsed, excludedCanvasScope)
                : parsed, references);
        });
        selectAll(db, 'SELECT data_json AS dataJson FROM role_library').forEach((role) => {
            collectJsonStrings(parseJson(role.dataJson, null), references);
        });
        selectAll(db, 'SELECT file_url AS fileUrl, thumbnail_url AS thumbnailUrl FROM library_assets').forEach((asset) => {
            references.add(asset.fileUrl);
            if (asset.thumbnailUrl)
                references.add(asset.thumbnailUrl);
        });
        selectAll(db, 'SELECT thumbnail_url AS thumbnailUrl FROM asset_blobs WHERE thumbnail_url IS NOT NULL').forEach((blob) => {
            if (blob.thumbnailUrl)
                references.add(blob.thumbnailUrl);
        });
        selectAll(db, 'SELECT value_json AS valueJson FROM app_settings').forEach((setting) => {
            collectJsonStrings(parseJson(setting.valueJson, null), references);
        });
        return references;
    };
    const listRoles = () => {
        const rows = selectAll(db, 'SELECT data_json AS dataJson FROM role_library ORDER BY datetime(updated_at) DESC');
        return rows.map((row) => parseJson(row.dataJson, null)).filter((item) => item !== null);
    };
    const getRole = (id) => {
        const row = db.prepare('SELECT data_json AS dataJson FROM role_library WHERE id = ?')
            .get(id);
        return row ? parseJson(row.dataJson, null) : null;
    };
    const listRolesPage = ({ limit, search, tagGroups, cursor }) => {
        const conditions = [];
        const parameters = [];
        if (search) {
            conditions.push(`(
        lower(coalesce(json_extract(data_json, '$.name'), '')) LIKE ?
        OR lower(coalesce(json_extract(data_json, '$.description'), '')) LIKE ?
      )`);
            const pattern = `%${search.toLocaleLowerCase()}%`;
            parameters.push(pattern, pattern);
        }
        (tagGroups ?? []).forEach((tags) => {
            if (tags.length === 0)
                return;
            const placeholders = tags.map(() => '?').join(', ');
            conditions.push(`EXISTS (
        SELECT 1 FROM json_each(role_library.data_json, '$.tags') AS role_tag
        WHERE role_tag.value IN (${placeholders})
      )`);
            parameters.push(...tags);
        });
        if (cursor) {
            conditions.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
            parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
        }
        const rows = db.prepare(`
      SELECT id, data_json AS dataJson, updated_at AS updatedAt
      FROM role_library
      ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(...parameters, limit + 1);
        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        return {
            items: pageRows
                .map((row) => parseJson(row.dataJson, null))
                .filter((item) => item !== null),
            hasMore,
            nextCursor: hasMore && pageRows.length > 0
                ? { updatedAt: pageRows.at(-1).updatedAt, id: pageRows.at(-1).id }
                : null
        };
    };
    const insertRoleStatement = db.prepare('INSERT INTO role_library (id, data_json, updated_at) VALUES (?, ?, ?)');
    const replaceRolesTransaction = db.transaction((roles) => {
        db.prepare('DELETE FROM role_library').run();
        const updatedAt = nowIso();
        roles.forEach((role) => insertRoleStatement.run(role.id, JSON.stringify(role), updatedAt));
    });
    const replaceRoles = (roles) => replaceRolesTransaction(roles);
    const upsertRole = (role) => {
        db.prepare(`
      INSERT INTO role_library (id, data_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
    `).run(role.id, JSON.stringify(role), nowIso());
    };
    const deleteRoles = (ids) => {
        const statement = db.prepare('DELETE FROM role_library WHERE id = ?');
        const transaction = db.transaction((roleIds) => roleIds.reduce((count, id) => count + statement.run(id).changes, 0));
        return ids.length > 0 ? transaction(ids) : 0;
    };
    const mapLibraryAsset = ({ tagsJson, provenanceJson, thumbnailUrl, storageMode, sourcePath, sourceSizeBytes, sourceModifiedAtMs, archivedAt, blobId, ...row }) => {
        const provenance = provenanceJson
            ? parseJson(provenanceJson, null)
            : null;
        return ({
            ...row,
            tags: parseJson(tagsJson, []).filter((tag) => typeof tag === 'string'),
            ...(provenance ? { provenance } : {}),
            ...(thumbnailUrl ? { thumbnailUrl } : {}),
            storageMode: storageMode === 'linked' ? 'linked' : 'managed',
            availability: 'ready',
            ...(sourcePath ? { sourcePath } : {}),
            ...(sourceSizeBytes !== null && sourceSizeBytes !== undefined ? { sourceSizeBytes } : {}),
            ...(sourceModifiedAtMs !== null && sourceModifiedAtMs !== undefined ? { sourceModifiedAtMs } : {}),
            ...(archivedAt ? { archivedAt } : {}),
            ...(blobId ? { blobId } : {})
        });
    };
    const libraryAssetSelect = `
    SELECT id, name, kind, tags_json AS tagsJson, file_url AS fileUrl,
      thumbnail_url AS thumbnailUrl, mime_type AS mimeType, size_bytes AS sizeBytes, content_hash AS contentHash,
      provenance_json AS provenanceJson,
      storage_mode AS storageMode, source_path AS sourcePath, source_size_bytes AS sourceSizeBytes,
      source_modified_at_ms AS sourceModifiedAtMs, archived_at AS archivedAt, blob_id AS blobId,
      created_at AS createdAt, updated_at AS updatedAt
    FROM library_assets
  `;
    const getLibraryAsset = (id) => {
        const row = selectOne(db, `${libraryAssetSelect} WHERE id = ?`, [id]);
        return row ? mapLibraryAsset(row) : null;
    };
    const getLibraryAssetByHash = (contentHash) => {
        const row = selectOne(db, `${libraryAssetSelect} WHERE content_hash = ?`, [contentHash]);
        return row ? mapLibraryAsset(row) : null;
    };
    const resolveLibraryAssetSource = (sourceUrl) => {
        let pathname;
        try {
            pathname = new URL(sourceUrl, 'http://mk.local').pathname;
        }
        catch {
            return null;
        }
        const match = pathname.match(/^\/api\/library-assets\/([^/]+)\/file$/);
        if (!match)
            return null;
        let id;
        try {
            id = decodeURIComponent(match[1]);
        }
        catch {
            return null;
        }
        const asset = getLibraryAsset(id);
        if (!asset || !asset.sourcePath || !fs.existsSync(asset.sourcePath))
            return null;
        const stat = fs.statSync(asset.sourcePath);
        if (!stat.isFile())
            return null;
        if (asset.storageMode === 'linked'
            && (stat.size !== asset.sourceSizeBytes
                || Math.trunc(stat.mtimeMs) !== Math.trunc(asset.sourceModifiedAtMs ?? -1)))
            return null;
        return fs.realpathSync(asset.sourcePath);
    };
    const visibleLibraryIdentity = `(
    provenance_json IS NULL
    OR json_extract(provenance_json, '$.origin') IN ('upload', 'linked')
    OR json_extract(provenance_json, '$.operation') IN ('publish-history', 'publish-role-image')
    OR EXISTS (
      SELECT 1 FROM library_asset_provenance AS publication
      WHERE publication.asset_id = library_assets.id
        AND json_extract(publication.provenance_json, '$.operation') IN ('publish-history', 'publish-role-image')
    )
  )`;
    const listLibraryAssetsPage = ({ limit, query, kind, tags, cursor }) => {
        const conditions = ['archived_at IS NULL', visibleLibraryIdentity];
        const parameters = [];
        if (query) {
            conditions.push('(lower(name) LIKE ? OR lower(tags_json) LIKE ?)');
            const pattern = `%${query.toLocaleLowerCase()}%`;
            parameters.push(pattern, pattern);
        }
        if (kind) {
            conditions.push('kind = ?');
            parameters.push(kind);
        }
        (tags ?? []).forEach((tag) => {
            conditions.push(`EXISTS (
        SELECT 1 FROM json_each(library_assets.tags_json) AS asset_tag WHERE asset_tag.value = ?
      )`);
            parameters.push(tag);
        });
        if (cursor) {
            conditions.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
            parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
        }
        const rows = selectAll(db, `
      ${libraryAssetSelect}
      ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `, [...parameters, limit + 1]);
        const hasMore = rows.length > limit;
        return {
            items: (hasMore ? rows.slice(0, limit) : rows).map(mapLibraryAsset),
            hasMore
        };
    };
    const countLibraryAssetsByKind = () => {
        const counts = { image: 0, video: 0, audio: 0 };
        selectAll(db, `
      SELECT kind, COUNT(*) AS count FROM library_assets
      WHERE archived_at IS NULL AND ${visibleLibraryIdentity}
      GROUP BY kind
    `).forEach((row) => { counts[row.kind] = Number(row.count); });
        return counts;
    };
    const listLibraryAssetTags = (limit = 200) => selectAll(db, `
    SELECT DISTINCT CAST(asset_tag.value AS TEXT) AS tag
    FROM library_assets, json_each(library_assets.tags_json) AS asset_tag
      WHERE archived_at IS NULL
      AND ${visibleLibraryIdentity}
      AND typeof(asset_tag.value) = 'text' AND trim(CAST(asset_tag.value AS TEXT)) <> ''
    ORDER BY tag COLLATE NOCASE ASC
    LIMIT ?
  `, [Math.max(1, Math.min(500, limit))]).map((row) => row.tag);
    const createLibraryAsset = (asset) => {
        const storageMode = asset.storageMode ?? 'managed';
        db.prepare(`
      INSERT INTO library_assets (
        id, name, kind, tags_json, file_url, thumbnail_url, mime_type, size_bytes, content_hash, provenance_json,
        storage_mode, source_path, source_size_bytes, source_modified_at_ms, blob_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(asset.id, asset.name, asset.kind, JSON.stringify(asset.tags), asset.fileUrl, asset.thumbnailUrl ?? null, asset.mimeType, asset.sizeBytes, asset.contentHash, asset.provenance ? JSON.stringify(asset.provenance) : null, storageMode, asset.sourcePath ?? null, asset.sourceSizeBytes ?? null, asset.sourceModifiedAtMs ?? null, asset.blobId ?? null, asset.createdAt, asset.updatedAt);
        if (asset.provenance) {
            db.prepare(`
        INSERT OR IGNORE INTO library_asset_provenance (asset_id, provenance_json, created_at)
        VALUES (?, ?, ?)
      `).run(asset.id, JSON.stringify(asset.provenance), nowIso());
        }
        return getLibraryAsset(asset.id);
    };
    const addLibraryAssetProvenance = (assetId, provenance) => {
        if (!getLibraryAsset(assetId))
            return 0;
        return db.prepare(`
      INSERT OR IGNORE INTO library_asset_provenance (asset_id, provenance_json, created_at)
      VALUES (?, ?, ?)
    `).run(assetId, JSON.stringify(provenance), nowIso()).changes;
    };
    const attachLibraryAssetBlob = (assetId, blobId) => {
        db.prepare('UPDATE library_assets SET blob_id = ?, updated_at = ? WHERE id = ?')
            .run(blobId, nowIso(), assetId);
        return getLibraryAsset(assetId);
    };
    const listLibraryAssetProvenance = (assetId) => selectAll(db, `
    SELECT provenance_json AS provenanceJson
    FROM library_asset_provenance
    WHERE asset_id = ?
    ORDER BY datetime(created_at) ASC, rowid ASC
  `, [assetId]).map((row) => parseJson(row.provenanceJson, null))
        .filter((item) => Boolean(item));
    const relinkLibraryAsset = (id, source) => {
        db.prepare(`
      UPDATE library_assets
      SET storage_mode = 'linked', source_path = ?, source_size_bytes = ?, source_modified_at_ms = ?, updated_at = ?
      WHERE id = ?
    `).run(source.sourcePath, source.sourceSizeBytes, source.sourceModifiedAtMs, nowIso(), id);
        return getLibraryAsset(id);
    };
    const updateLibraryAssetThumbnail = (id, thumbnailUrl) => {
        db.prepare('UPDATE library_assets SET thumbnail_url = ? WHERE id = ?').run(thumbnailUrl, id);
        return getLibraryAsset(id);
    };
    const updateLibraryAsset = (id, patch) => {
        const current = getLibraryAsset(id);
        if (!current)
            return null;
        const name = patch.name?.trim() || current.name;
        const tags = patch.tags === undefined
            ? current.tags
            : Array.from(new Set(patch.tags.map((tag) => tag.trim()).filter(Boolean))).slice(0, 32);
        db.prepare(`
      UPDATE library_assets SET name = ?, tags_json = ?, updated_at = ? WHERE id = ?
    `).run(name, JSON.stringify(tags), nowIso(), id);
        return getLibraryAsset(id);
    };
    const archiveLibraryAssets = (ids) => {
        if (ids.length === 0)
            return 0;
        const statement = db.prepare('UPDATE library_assets SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL');
        const archivedAt = nowIso();
        return db.transaction((assetIds) => assetIds.reduce((count, id) => count + statement.run(archivedAt, archivedAt, id).changes, 0))(ids);
    };
    const restoreLibraryAsset = (id) => {
        db.prepare('UPDATE library_assets SET archived_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id);
        return getLibraryAsset(id);
    };
    const deleteLibraryAssets = db.transaction((ids) => {
        const deleting = ids.flatMap((id) => {
            const asset = getLibraryAsset(id);
            return asset ? [asset] : [];
        });
        const statement = db.prepare('DELETE FROM library_assets WHERE id = ?');
        deleting.forEach((asset) => statement.run(asset.id));
        return deleting;
    });
    const listProjectCoverAssetIds = (ids) => {
        if (ids.length === 0)
            return new Set();
        const placeholders = ids.map(() => '?').join(', ');
        return new Set(selectAll(db, `
      SELECT DISTINCT cover_asset_id AS coverAssetId
      FROM projects
      WHERE cover_asset_id IN (${placeholders})
    `, ids).map((row) => row.coverAssetId));
    };
    const listReferencedLibraryAssetIds = (ids) => {
        if (ids.length === 0)
            return new Set();
        const candidates = ids.flatMap((id) => {
            const asset = getLibraryAsset(id);
            return asset ? [asset] : [];
        });
        const references = new Set();
        const collectJsonColumn = (sql, params = []) => {
            selectAll(db, sql, params).forEach((row) => {
                collectJsonStrings(parseJson(row.valueJson, null), references);
            });
        };
        selectAll(db, 'SELECT data_json AS dataJson FROM projects').forEach((row) => {
            const data = parseJson(row.dataJson, null);
            if (!data)
                return;
            const { canvases: _canvases, ...projectData } = data;
            collectJsonStrings(projectData, references);
        });
        selectAll(db, `
      SELECT DISTINCT asset_id AS assetId FROM project_node_asset_refs WHERE owner = 'library'
    `).forEach((row) => references.add(row.assetId));
        collectJsonColumn('SELECT value_json AS valueJson FROM app_settings');
        collectJsonColumn('SELECT metadata_json AS valueJson FROM history_assets WHERE metadata_json IS NOT NULL');
        collectJsonColumn('SELECT request_json AS valueJson FROM generation_jobs');
        collectJsonColumn('SELECT result_json AS valueJson FROM generation_jobs WHERE result_json IS NOT NULL');
        collectJsonColumn('SELECT metadata_json AS valueJson FROM director_motion_assets WHERE metadata_json IS NOT NULL');
        const placeholders = ids.map(() => '?').join(', ');
        selectAll(db, `
      SELECT preview_url AS previewUrl, thumbnail_url AS thumbnailUrl
      FROM history_assets WHERE blob_id IS NULL
    `).forEach((row) => {
            if (row.previewUrl)
                references.add(row.previewUrl);
            if (row.thumbnailUrl)
                references.add(row.thumbnailUrl);
        });
        selectAll(db, `
      SELECT library_asset_id AS libraryAssetId FROM history_assets
      WHERE library_asset_id IS NOT NULL AND blob_id IS NULL
    `).forEach((row) => {
            if (row.libraryAssetId)
                references.add(row.libraryAssetId);
        });
        selectAll(db, `
      SELECT cover_asset_id AS coverAssetId FROM projects WHERE cover_asset_id IS NOT NULL
    `).forEach((row) => {
            if (row.coverAssetId)
                references.add(row.coverAssetId);
        });
        return new Set(candidates
            .filter((asset) => references.has(asset.id)
            || references.has(asset.fileUrl)
            || Boolean(asset.thumbnailUrl && references.has(asset.thumbnailUrl)))
            .map((asset) => asset.id));
    };
    const collectDeletionReferenceOwners = (value, markerOwners, owners) => {
        if (typeof value === 'string') {
            markerOwners.get(value)?.forEach((id) => owners.add(id));
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((item) => collectDeletionReferenceOwners(item, markerOwners, owners));
            return;
        }
        if (!value || typeof value !== 'object')
            return;
        Object.values(value)
            .forEach((item) => collectDeletionReferenceOwners(item, markerOwners, owners));
    };
    const addDeletionReference = (references, ownerId, reference) => {
        const entries = references.get(ownerId) ?? new Map();
        const key = [reference.kind, reference.projectId, reference.canvasId, reference.nodeId, reference.label].join('\u0000');
        entries.set(key, reference);
        references.set(ownerId, entries);
    };
    const scanProjectNodeDeletionReferences = (markerOwners, references) => {
        selectAll(db, 'SELECT id, name, data_json AS dataJson FROM projects')
            .forEach((project) => {
            const data = parseJson(project.dataJson, null);
            const projectOwners = new Set();
            if (data) {
                const { canvases: _canvases, ...projectData } = data;
                collectDeletionReferenceOwners(projectData, markerOwners, projectOwners);
            }
            projectOwners.forEach((ownerId) => {
                addDeletionReference(references, ownerId, {
                    kind: 'project',
                    label: project.name,
                    detail: '项目级数据',
                    projectId: project.id
                });
            });
        });
    };
    const addIndexedNodeAssetReferences = (owner, ids, references) => {
        if (ids.length === 0)
            return;
        const valueColumn = owner === 'role' ? 'refs.role_id' : 'refs.asset_id';
        const rows = selectAll(db, `
      SELECT ${valueColumn} AS ownerId, refs.project_id AS projectId,
        projects.name AS projectName, refs.canvas_id AS canvasId, refs.node_id AS nodeId
      FROM project_node_asset_refs AS refs
      INNER JOIN projects ON projects.id = refs.project_id
      WHERE refs.owner = ? AND ${valueColumn} IN (${ids.map(() => '?').join(', ')})
    `, [owner, ...ids]);
        rows.forEach((row) => addDeletionReference(references, row.ownerId, {
            kind: 'canvas-node',
            label: `${row.projectName} / ${row.canvasId}`,
            detail: row.nodeId,
            projectId: row.projectId,
            canvasId: row.canvasId,
            nodeId: row.nodeId
        }));
    };
    const addJsonRecordDeletionReferences = ({ rows, markerOwners, references, kind, label }) => {
        rows.forEach((row) => {
            const owners = new Set();
            collectDeletionReferenceOwners(row.value, markerOwners, owners);
            owners.forEach((ownerId) => addDeletionReference(references, ownerId, {
                kind,
                label: label(row)
            }));
        });
    };
    const buildDeletionImpact = (names, references) => Array.from(names, ([id, name]) => ({
        id,
        name,
        references: Array.from(references.get(id)?.values() ?? [])
    }));
    const listLibraryAssetDeletionImpact = (ids) => {
        const assets = ids.flatMap((id) => {
            const asset = getLibraryAsset(id);
            return asset ? [asset] : [];
        });
        const names = new Map(assets.map((asset) => [asset.id, asset.name]));
        const markerOwners = new Map();
        assets.forEach((asset) => {
            [asset.id, asset.fileUrl, asset.thumbnailUrl].filter((value) => Boolean(value)).forEach((marker) => {
                const owners = markerOwners.get(marker) ?? new Set();
                owners.add(asset.id);
                markerOwners.set(marker, owners);
            });
        });
        const references = new Map();
        addIndexedNodeAssetReferences('library', assets.map((asset) => asset.id), references);
        scanProjectNodeDeletionReferences(markerOwners, references);
        selectAll(db, 'SELECT id, name, cover_asset_id AS coverAssetId FROM projects')
            .forEach((project) => markerOwners.get(project.coverAssetId ?? '')?.forEach((ownerId) => (addDeletionReference(references, ownerId, { kind: 'project-cover', label: project.name, projectId: project.id }))));
        addJsonRecordDeletionReferences({
            markerOwners,
            references,
            kind: 'history',
            rows: selectAll(db, `
        SELECT id, name, preview_url AS previewUrl, thumbnail_url AS thumbnailUrl,
          library_asset_id AS libraryAssetId, metadata_json AS metadataJson
        FROM history_assets WHERE blob_id IS NULL
      `).map((row) => ({ id: row.id, name: row.name, value: {
                    previewUrl: row.previewUrl,
                    thumbnailUrl: row.thumbnailUrl,
                    libraryAssetId: row.libraryAssetId,
                    metadata: parseJson(row.metadataJson, null)
                } })),
            label: (row) => `历史：${row.name ?? row.id}`
        });
        addJsonRecordDeletionReferences({
            markerOwners,
            references,
            kind: 'generation-job',
            rows: selectAll(db, 'SELECT id, request_json AS requestJson, result_json AS resultJson FROM generation_jobs')
                .map((row) => ({ id: row.id, value: { request: parseJson(row.requestJson, null), result: parseJson(row.resultJson, null) } })),
            label: (row) => `生成任务：${row.id}`
        });
        addJsonRecordDeletionReferences({
            markerOwners,
            references,
            kind: 'motion',
            rows: selectAll(db, 'SELECT id, name, metadata_json AS metadataJson FROM director_motion_assets')
                .map((row) => ({ id: row.id, name: row.name, value: parseJson(row.metadataJson, null) })),
            label: (row) => `动作：${row.name ?? row.id}`
        });
        addJsonRecordDeletionReferences({
            markerOwners,
            references,
            kind: 'setting',
            rows: selectAll(db, 'SELECT key AS id, value_json AS valueJson FROM app_settings')
                .map((row) => ({ id: row.id, value: parseJson(row.valueJson, null) })),
            label: (row) => `设置：${row.id}`
        });
        return buildDeletionImpact(names, references);
    };
    const listRoleDeletionImpact = (ids) => {
        const roles = ids.flatMap((id) => {
            const role = getRole(id);
            return role ? [{ id, name: typeof role.name === 'string' ? role.name : id }] : [];
        });
        const markerOwners = new Map(roles.map((role) => [role.id, new Set([role.id])]));
        const references = new Map();
        addIndexedNodeAssetReferences('role', roles.map((role) => role.id), references);
        scanProjectNodeDeletionReferences(markerOwners, references);
        return buildDeletionImpact(new Map(roles.map((role) => [role.id, role.name])), references);
    };
    const listHistoryDeletionImpact = (ids, scope) => {
        const assets = ids.flatMap((id) => {
            const asset = getHistoryAsset(id, scope);
            return asset ? [asset] : [];
        });
        const markerOwners = new Map(assets.map((asset) => [asset.id, new Set([asset.id])]));
        const references = new Map();
        addIndexedNodeAssetReferences('history', assets.map((asset) => asset.id), references);
        scanProjectNodeDeletionReferences(markerOwners, references);
        return buildDeletionImpact(new Map(assets.map((asset) => [asset.id, asset.name])), references);
    };
    const directorModelAssetSelect = `
    SELECT id, name, file_name AS fileName, extension, mime_type AS mimeType,
      byte_size AS byteSize, content_hash AS contentHash, source_path AS sourcePath,
      retained, released_at AS releasedAt, created_at AS createdAt
    FROM director_model_assets
  `;
    const getDirectorModelAsset = (id) => (selectOne(db, `${directorModelAssetSelect} WHERE id = ?`, [id]) ?? null);
    const getDirectorModelAssetByHash = (contentHash) => (selectOne(db, `${directorModelAssetSelect} WHERE content_hash = ?`, [contentHash]) ?? null);
    const createDirectorModelAsset = (asset) => {
        db.prepare(`
      INSERT INTO director_model_assets (
        id, name, file_name, extension, mime_type, byte_size, content_hash, source_path,
        retained, released_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(asset.id, asset.name, asset.fileName, asset.extension, asset.mimeType, asset.byteSize, asset.contentHash, asset.sourcePath, asset.retained ? 1 : 0, asset.releasedAt ?? null, asset.createdAt);
        return getDirectorModelAsset(asset.id);
    };
    const setDirectorModelAssetsRetained = (ids, retained) => {
        const statement = retained
            ? db.prepare('UPDATE director_model_assets SET retained = 1, released_at = NULL WHERE id = ?')
            : db.prepare('UPDATE director_model_assets SET retained = 0, released_at = COALESCE(released_at, ?) WHERE id = ?');
        const releasedAt = nowIso();
        return db.transaction((assetIds) => assetIds.reduce((updated, id) => updated + (retained ? statement.run(id) : statement.run(releasedAt, id)).changes, 0))(ids);
    };
    const listReleasedDirectorModelAssets = () => (selectAll(db, `${directorModelAssetSelect} WHERE retained = 0`));
    const listPendingDeletionDirectorModelAssets = () => (selectAll(db, `${directorModelAssetSelect} WHERE released_at IS NOT NULL`));
    const listReferencedDirectorModelAssetIds = (ids) => {
        if (ids.length === 0)
            return new Set();
        const references = new Set();
        selectAll(db, 'SELECT data_json AS valueJson FROM projects').forEach((row) => (collectJsonStrings(parseJson(row.valueJson, null), references)));
        selectAll(db, 'SELECT value_json AS valueJson FROM app_settings').forEach((row) => (collectJsonStrings(parseJson(row.valueJson, null), references)));
        return new Set(ids.filter((id) => references.has(id)));
    };
    const deleteDirectorModelAssets = db.transaction((ids) => {
        const deleting = ids.flatMap((id) => {
            const asset = getDirectorModelAsset(id);
            return asset ? [asset] : [];
        });
        const statement = db.prepare('DELETE FROM director_model_assets WHERE id = ?');
        deleting.forEach((asset) => statement.run(asset.id));
        return deleting;
    });
    const replaceProjectNodeRegistry = (projectId, data) => {
        db.prepare('DELETE FROM project_node_asset_refs WHERE project_id = ?').run(projectId);
        db.prepare('DELETE FROM project_node_positions WHERE project_id = ?').run(projectId);
        db.prepare('DELETE FROM project_canvas_nodes WHERE project_id = ?').run(projectId);
        if (!data || typeof data !== 'object' || Array.isArray(data))
            return;
        const canvases = data.canvases;
        if (!Array.isArray(canvases))
            return;
        const insertNode = db.prepare(`
      INSERT INTO project_canvas_nodes (project_id, canvas_id, node_id) VALUES (?, ?, ?)
    `);
        const insertAssetRef = db.prepare(`
      INSERT OR IGNORE INTO project_node_asset_refs (
        project_id, canvas_id, node_id, owner, asset_id, role_id, image_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        canvases.forEach((canvas) => {
            if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas))
                return;
            const canvasRecord = canvas;
            if (typeof canvasRecord.id !== 'string' || !Array.isArray(canvasRecord.nodes))
                return;
            canvasRecord.nodes.forEach((node) => {
                if (!node || typeof node !== 'object' || Array.isArray(node))
                    return;
                const nodeRecord = node;
                const nodeId = nodeRecord.id;
                if (typeof nodeId !== 'string')
                    return;
                insertNode.run(projectId, canvasRecord.id, nodeId);
                if (!nodeRecord.data || typeof nodeRecord.data !== 'object' || Array.isArray(nodeRecord.data))
                    return;
                const nodeData = nodeRecord.data;
                const referenceData = nodeData.referenceAsset && typeof nodeData.referenceAsset === 'object' && !Array.isArray(nodeData.referenceAsset)
                    ? nodeData.referenceAsset
                    : null;
                const refs = [];
                collectStructuredAssetRefs(nodeData, refs);
                const seen = new Set();
                refs.forEach((ref) => {
                    const key = ref.owner === 'role' ? `role:${ref.roleId}:${ref.imageId}` : `${ref.owner}:${ref.assetId}`;
                    if (seen.has(key))
                        return;
                    seen.add(key);
                    insertAssetRef.run(projectId, canvasRecord.id, nodeId, ref.owner, ref.owner === 'role' ? '' : ref.assetId, ref.owner === 'role' ? ref.roleId : '', ref.owner === 'role' ? ref.imageId : '');
                });
                const legacyRoleId = typeof nodeData.roleId === 'string'
                    ? nodeData.roleId
                    : typeof referenceData?.roleId === 'string'
                        ? referenceData.roleId
                        : '';
                if (legacyRoleId && !refs.some((ref) => ref.owner === 'role')) {
                    insertAssetRef.run(projectId, canvasRecord.id, nodeId, 'role', '', legacyRoleId, '');
                }
            });
        });
    };
    const mapProjectRow = (row) => {
        const data = parseJson(row.dataJson, {});
        const positionRows = selectAll(db, `
      SELECT canvas_id AS canvasId, node_id AS nodeId, x, y
      FROM project_node_positions
      WHERE project_id = ?
    `, [row.id]);
        if (positionRows.length > 0 && Array.isArray(data.canvases)) {
            const positionsByCanvas = new Map();
            positionRows.forEach(({ canvasId, nodeId, x, y }) => {
                const canvasPositions = positionsByCanvas.get(canvasId) ?? new Map();
                canvasPositions.set(nodeId, { x, y });
                positionsByCanvas.set(canvasId, canvasPositions);
            });
            data.canvases.forEach((canvas) => {
                if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas))
                    return;
                const canvasRecord = canvas;
                if (typeof canvasRecord.id !== 'string' || !Array.isArray(canvasRecord.nodes))
                    return;
                const canvasPositions = positionsByCanvas.get(canvasRecord.id);
                if (!canvasPositions)
                    return;
                canvasRecord.nodes.forEach((node) => {
                    if (!node || typeof node !== 'object' || Array.isArray(node))
                        return;
                    const nodeRecord = node;
                    if (typeof nodeRecord.id !== 'string')
                        return;
                    const position = canvasPositions.get(nodeRecord.id);
                    if (position)
                        nodeRecord.position = position;
                });
            });
        }
        return {
            id: row.id,
            name: row.name,
            data,
            coverAssetId: row.coverAssetId ?? null,
            revision: row.revision,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt
        };
    };
    const getProjectMetadata = (id) => {
        const row = selectOne(db, `
      SELECT id, name, cover_asset_id AS coverAssetId, revision,
        created_at AS createdAt, updated_at AS updatedAt
      FROM projects
      WHERE id = ?
    `, [id]);
        return row ? { ...row, data: null } : null;
    };
    const getProject = (id) => {
        const row = selectOne(db, `
      SELECT id, name, data_json AS dataJson, cover_asset_id AS coverAssetId, revision,
        created_at AS createdAt, updated_at AS updatedAt
      FROM projects
      WHERE id = ?
    `, [id]);
        return row ? mapProjectRow(row) : null;
    };
    const listProjects = () => {
        const rows = selectAll(db, `
      SELECT id, name, data_json AS dataJson, cover_asset_id AS coverAssetId, revision,
        created_at AS createdAt, updated_at AS updatedAt
      FROM projects
      ORDER BY datetime(updated_at) DESC
    `);
        return rows.map(mapProjectRow);
    };
    const listProjectSummaries = () => selectAll(db, `
    SELECT id, name, cover_asset_id AS coverAssetId, revision,
      created_at AS createdAt, updated_at AS updatedAt
    FROM projects
    ORDER BY datetime(updated_at) DESC, id DESC
  `).map((row) => ({ ...row, coverAssetId: row.coverAssetId ?? null }));
    const migrateLegacyDerivedLibraryRefs = (projectId, value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return value;
        const project = value;
        if (!Array.isArray(project.canvases))
            return value;
        const candidates = new Map(selectAll(db, `
      SELECT id, name, kind, blob_id AS blobId, thumbnail_url AS thumbnailUrl, created_at AS createdAt
      FROM library_assets
      WHERE blob_id IS NOT NULL
        AND json_extract(provenance_json, '$.origin') IN ('generated', 'derived', 'director')
        AND COALESCE(json_extract(provenance_json, '$.operation'), '') NOT IN ('publish-history', 'publish-role-image')
        AND NOT EXISTS (
          SELECT 1 FROM library_asset_provenance AS publication
          WHERE publication.asset_id = library_assets.id
            AND json_extract(publication.provenance_json, '$.operation') IN ('publish-history', 'publish-role-image')
        )
    `).map((asset) => [asset.id, asset]));
        if (candidates.size === 0)
            return value;
        const historyRefByScope = new Map();
        const ensureHistoryRef = (asset, canvasId) => {
            const key = `${canvasId}\u0000${asset.id}`;
            const existing = historyRefByScope.get(key);
            if (existing)
                return existing;
            const encodedIdentity = Buffer.from(`${projectId}\u0000${canvasId}\u0000${asset.id}`, 'utf8').toString('base64url');
            const historyId = `history-migrated-${encodedIdentity}`;
            upsertHistoryAssets([{
                    id: historyId,
                    projectId,
                    canvasId,
                    name: asset.name,
                    kind: asset.kind,
                    source: '旧派生资产迁移',
                    previewUrl: `/api/history-assets/${encodeURIComponent(historyId)}/file?${new URLSearchParams({ projectId, canvasId }).toString()}`,
                    ...(asset.thumbnailUrl ? { thumbnailUrl: asset.thumbnailUrl } : {}),
                    blobId: asset.blobId,
                    createdAt: asset.createdAt,
                    metadata: { originLibraryAssetId: asset.id, operation: 'legacy-library-migration' }
                }]);
            const ref = { owner: 'history', assetId: historyId };
            historyRefByScope.set(key, ref);
            return ref;
        };
        const rewriteValue = (input, canvasId) => {
            if (Array.isArray(input)) {
                let changed = false;
                const items = input.map((item) => {
                    const next = rewriteValue(item, canvasId);
                    if (next !== item)
                        changed = true;
                    return next;
                });
                return changed ? items : input;
            }
            if (!input || typeof input !== 'object')
                return input;
            const record = input;
            let changed = false;
            const next = { ...record };
            Object.entries(record).forEach(([key, item]) => {
                if (key === 'assetRef' || key === 'assetRefs')
                    return;
                const rewritten = rewriteValue(item, canvasId);
                if (rewritten !== item) {
                    next[key] = rewritten;
                    changed = true;
                }
            });
            if (isAssetRef(record.assetRef) && record.assetRef.owner === 'library') {
                const candidate = candidates.get(record.assetRef.assetId);
                if (candidate) {
                    const ref = ensureHistoryRef(candidate, canvasId);
                    next.assetRef = ref;
                    next.historyAssetId = ref.assetId;
                    changed = true;
                }
            }
            if (Array.isArray(record.assetRefs)) {
                const originalRefs = record.assetRefs;
                const refs = originalRefs.map((item) => {
                    if (!isAssetRef(item) || item.owner !== 'library')
                        return item;
                    const candidate = candidates.get(item.assetId);
                    return candidate ? ensureHistoryRef(candidate, canvasId) : item;
                });
                if (refs.some((item, index) => item !== originalRefs[index])) {
                    next.assetRefs = refs;
                    next.historyAssetIds = refs.flatMap((item) => isAssetRef(item) && item.owner === 'history' ? [item.assetId] : []);
                    changed = true;
                }
            }
            return changed ? next : input;
        };
        let changed = false;
        const canvases = project.canvases.map((canvas) => {
            if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas))
                return canvas;
            const record = canvas;
            if (typeof record.id !== 'string' || !Array.isArray(record.nodes))
                return canvas;
            const nodes = rewriteValue(record.nodes, record.id);
            if (nodes === record.nodes)
                return canvas;
            changed = true;
            return { ...record, nodes };
        });
        return changed ? { ...project, canvases } : value;
    };
    const projectAssetRefMigrationKey = 'project_asset_ref_identity_v1';
    if (selectOne(db, 'SELECT value FROM storage_metadata WHERE key = ?', [projectAssetRefMigrationKey])?.value !== 'complete') {
        db.transaction(() => {
            listProjects().forEach((project) => {
                const migrated = migrateProjectAssetIdentities(project.data);
                db.prepare('UPDATE projects SET data_json = ? WHERE id = ?').run(JSON.stringify(migrated), project.id);
                replaceProjectNodeRegistry(project.id, migrated);
            });
            db.prepare('INSERT INTO storage_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
                .run(projectAssetRefMigrationKey, 'complete');
        })();
    }
    const legacyDerivedLibraryMigrationKey = 'legacy_derived_library_identity_v1';
    if (selectOne(db, 'SELECT value FROM storage_metadata WHERE key = ?', [legacyDerivedLibraryMigrationKey])?.value !== 'complete') {
        db.transaction(() => {
            listProjects().forEach((project) => {
                const migrated = migrateLegacyDerivedLibraryRefs(project.id, migrateProjectAssetIdentities(project.data));
                if (migrated !== project.data) {
                    db.prepare('UPDATE projects SET data_json = ? WHERE id = ?').run(JSON.stringify(migrated), project.id);
                    replaceProjectNodeRegistry(project.id, migrated);
                }
            });
            db.prepare('INSERT INTO storage_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
                .run(legacyDerivedLibraryMigrationKey, 'complete');
        })();
    }
    const upsertProject = ({ id, name, data, revision, updatedAt }) => {
        data = migrateProjectAssetIdentities(data);
        data = migrateLegacyDerivedLibraryRefs(id, data);
        const current = getProject(id);
        const minimumNextRevision = (current?.revision ?? 0) + 1;
        const nextRevision = revision === undefined ? minimumNextRevision : Math.max(revision, minimumNextRevision);
        const timestamp = updatedAt ?? nowIso();
        run(db, `
      INSERT INTO projects (id, name, data_json, cover_asset_id, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        data_json = excluded.data_json,
        cover_asset_id = COALESCE(excluded.cover_asset_id, projects.cover_asset_id),
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `, [id, name, JSON.stringify(data), null, nextRevision, timestamp, timestamp]);
        replaceProjectNodeRegistry(id, data);
        return getProject(id);
    };
    const saveProject = db.transaction(({ id, name, data, expectedRevision }) => {
        data = migrateProjectAssetIdentities(data);
        const current = getProject(id);
        if (!current) {
            if (expectedRevision !== 0)
                return { status: 'conflict', current: null };
            data = migrateLegacyDerivedLibraryRefs(id, data);
            const updatedAt = nowIso();
            db.prepare(`
        INSERT INTO projects (id, name, data_json, cover_asset_id, revision, created_at, updated_at)
        VALUES (?, ?, ?, NULL, 1, ?, ?)
      `).run(id, name, JSON.stringify(data), updatedAt, updatedAt);
            replaceProjectNodeRegistry(id, data);
            return { status: 'saved', project: getProject(id) };
        }
        if (current.revision !== expectedRevision) {
            return { status: 'conflict', current };
        }
        data = migrateLegacyDerivedLibraryRefs(id, data);
        const nextRevision = expectedRevision + 1;
        const updatedAt = nowIso();
        const changes = db.prepare(`
      UPDATE projects
      SET name = ?, data_json = ?, revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(name, JSON.stringify(data), nextRevision, updatedAt, id, expectedRevision).changes;
        if (changes !== 1)
            return { status: 'conflict', current: getProject(id) };
        replaceProjectNodeRegistry(id, data);
        return { status: 'saved', project: getProject(id) };
    });
    const patchProjectMetadata = db.transaction(({ id, expectedRevision, name, coverAssetId }) => {
        const current = getProject(id);
        if (!current || current.revision !== expectedRevision)
            return { status: 'conflict', current };
        if (coverAssetId !== undefined && coverAssetId !== null) {
            const cover = getLibraryAsset(coverAssetId);
            if (!cover || cover.kind !== 'image')
                return { status: 'conflict', current };
        }
        const nextRevision = expectedRevision + 1;
        const updatedAt = nowIso();
        const changes = db.prepare(`
      UPDATE projects
      SET name = ?, cover_asset_id = ?, revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(name?.trim() || current.name, coverAssetId === undefined ? current.coverAssetId ?? null : coverAssetId, nextRevision, updatedAt, id, expectedRevision).changes;
        if (changes !== 1)
            return { status: 'conflict', current: getProject(id) };
        return { status: 'saved', project: getProject(id) };
    });
    const patchProjectNodePositions = db.transaction(({ id, canvasId, patches, expectedRevision }) => {
        const current = getProjectMetadata(id);
        if (!current || current.revision !== expectedRevision)
            return { status: 'conflict', current };
        const hasRegisteredNode = db.prepare(`
      SELECT 1 FROM project_canvas_nodes
      WHERE project_id = ? AND canvas_id = ? AND node_id = ?
    `);
        if (patches.some((patch) => !hasRegisteredNode.get(id, canvasId, patch.nodeId))) {
            return { status: 'conflict', current };
        }
        const nextRevision = expectedRevision + 1;
        const updatedAt = nowIso();
        const changes = db.prepare(`
      UPDATE projects
      SET revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(nextRevision, updatedAt, id, expectedRevision).changes;
        if (changes !== 1)
            return { status: 'conflict', current: getProjectMetadata(id) };
        const upsertPosition = db.prepare(`
      INSERT INTO project_node_positions (project_id, canvas_id, node_id, x, y, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, canvas_id, node_id) DO UPDATE SET
        x = excluded.x,
        y = excluded.y,
        updated_at = excluded.updated_at
    `);
        patches.forEach((patch) => {
            upsertPosition.run(id, canvasId, patch.nodeId, patch.toPosition.x, patch.toPosition.y, updatedAt);
        });
        return {
            status: 'saved',
            project: { ...current, revision: nextRevision, updatedAt }
        };
    });
    const deleteCanvasHistoryAssets = db.transaction((scope) => {
        const historyAssets = mapHistoryAssetRows(selectAll(db, `
      ${historySelect}
      WHERE project_id = ? AND canvas_id = ?
    `, [scope.projectId, scope.canvasId]));
        const projectData = getProject(scope.projectId)?.data;
        const detachedData = projectData && typeof projectData === 'object' && !Array.isArray(projectData)
            ? (projectData.canvases ?? []).find((canvas) => (canvas && typeof canvas === 'object' && !Array.isArray(canvas) && canvas.id === scope.canvasId)) ?? null
            : null;
        const deletedHistoryAssets = db.prepare(`
      DELETE FROM history_assets WHERE project_id = ? AND canvas_id = ?
    `).run(scope.projectId, scope.canvasId).changes;
        return { deletedHistoryAssets, historyAssets, detachedData };
    });
    const deleteProject = db.transaction((id) => {
        const project = getProject(id);
        const historyAssets = mapHistoryAssetRows(selectAll(db, `
      ${historySelect}
      WHERE project_id = ?
    `, [id]));
        const deletedHistoryAssets = db.prepare('DELETE FROM history_assets WHERE project_id = ?').run(id).changes;
        const clearedSettings = db.prepare(`
      DELETE FROM app_settings WHERE key = 'activeProjectId' AND value_json = ?
    `).run(JSON.stringify(id)).changes;
        const deleted = db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes;
        return {
            deleted,
            deletedHistoryAssets,
            clearedSettings,
            historyAssets,
            detachedData: project?.data ?? null
        };
    });
    const getSetting = (key, fallback) => {
        const row = selectOne(db, 'SELECT value_json AS valueJson FROM app_settings WHERE key = ?', [key]);
        return parseJson(row?.valueJson, fallback);
    };
    const setSetting = (key, value) => {
        run(db, `
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `, [key, JSON.stringify(value), nowIso()]);
    };
    const mapGenerationJob = (row) => ({
        id: row.id,
        kind: row.kind,
        providerId: row.providerId,
        providerName: row.providerName,
        ...(row.providerProfile ? { providerProfile: row.providerProfile } : {}),
        baseUrl: row.baseUrl,
        request: parseJson(row.requestJson, {}),
        status: row.status,
        ...(row.upstreamTaskId ? { upstreamTaskId: row.upstreamTaskId } : {}),
        ...(row.resultJson ? { result: parseJson(row.resultJson, { ok: false }) } : {}),
        ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
        attempts: Number(row.attempts),
        createdAt: row.createdAt,
        ...(row.startedAt ? { startedAt: row.startedAt } : {}),
        updatedAt: row.updatedAt,
        deadlineAt: row.deadlineAt
    });
    const generationJobSelect = `
    SELECT id, kind, provider_id AS providerId, provider_name AS providerName,
      provider_profile AS providerProfile, base_url AS baseUrl, request_json AS requestJson,
      status, upstream_task_id AS upstreamTaskId, result_json AS resultJson,
      error_message AS errorMessage, attempts, created_at AS createdAt,
      started_at AS startedAt, updated_at AS updatedAt, deadline_at AS deadlineAt
    FROM generation_jobs
  `;
    const createGenerationJob = (job) => {
        db.prepare(`
      INSERT INTO generation_jobs (
        id, kind, provider_id, provider_name, provider_profile, base_url, request_json,
        status, upstream_task_id, result_json, error_message, attempts, created_at,
        started_at, updated_at, deadline_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(job.id, job.kind, job.providerId, job.providerName, job.providerProfile ?? null, job.baseUrl, JSON.stringify(job.request), job.status, job.upstreamTaskId ?? null, job.result ? JSON.stringify(job.result) : null, job.errorMessage ?? null, job.attempts, job.createdAt, job.startedAt ?? null, job.updatedAt, job.deadlineAt);
    };
    const getGenerationJob = (id) => {
        const row = selectOne(db, `${generationJobSelect} WHERE id = ?`, [id]);
        return row ? mapGenerationJob(row) : null;
    };
    const updateGenerationJob = (id, patch) => {
        const current = getGenerationJob(id);
        if (!current)
            return null;
        const next = { ...current, ...patch };
        db.prepare(`
      UPDATE generation_jobs SET provider_name = ?, provider_profile = ?, base_url = ?,
        request_json = ?, status = ?, upstream_task_id = ?, result_json = ?,
        error_message = ?, attempts = ?, started_at = ?, updated_at = ?, deadline_at = ?
      WHERE id = ?
    `).run(next.providerName, next.providerProfile ?? null, next.baseUrl, JSON.stringify(next.request), next.status, next.upstreamTaskId ?? null, next.result ? JSON.stringify(next.result) : null, next.errorMessage ?? null, next.attempts, next.startedAt ?? null, next.updatedAt, next.deadlineAt, id);
        return getGenerationJob(id);
    };
    const recoverInterruptedGenerationJobs = () => db.prepare(`
    UPDATE generation_jobs
    SET status = 'retry_pending', updated_at = ?
    WHERE status = 'running'
  `).run(nowIso()).changes;
    const sweepGenerationJobs = (now, terminalBefore) => {
        const transaction = db.transaction(() => {
            const timedOut = db.prepare(`
        UPDATE generation_jobs
        SET status = 'timeout', error_message = ?, updated_at = ?
        WHERE status IN ('queued', 'running', 'retry_pending', 'provider_pending')
          AND deadline_at <= ?
      `).run('生成任务已超过设置的总等待时间', now, now).changes;
            const deleted = db.prepare(`
        DELETE FROM generation_jobs
        WHERE status IN ('completed', 'failed', 'timeout')
          AND updated_at < ?
      `).run(terminalBefore).changes;
            return { timedOut, deleted };
        });
        return transaction();
    };
    const motionAssetSelect = `
    SELECT id, project_id AS projectId, name, source_kind AS sourceKind,
      source_file AS sourceFile, soma_file AS somaFile, skeleton_file AS skeletonFile,
      ue4_file AS ue4File, duration_frames AS durationFrames, source_fps AS sourceFps,
      rig_version AS rigVersion, metadata_json AS metadataJson, created_at AS createdAt
    FROM director_motion_assets
  `;
    const mapMotionAsset = ({ metadataJson, ...row }) => ({
        ...row,
        projectId: row.projectId ?? null,
        sourceFile: row.sourceFile ?? null,
        durationFrames: Number(row.durationFrames),
        sourceFps: Number(row.sourceFps),
        ...(metadataJson ? { metadata: parseJson(metadataJson, {}) } : {})
    });
    const createMotionAsset = (asset) => {
        db.prepare(`
      INSERT INTO director_motion_assets (
        id, project_id, name, source_kind, source_file, soma_file, skeleton_file,
        ue4_file, duration_frames, source_fps, rig_version, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(asset.id, asset.projectId ?? null, asset.name, asset.sourceKind, asset.sourceFile ?? null, asset.somaFile, asset.skeletonFile, asset.ue4File, asset.durationFrames, asset.sourceFps, asset.rigVersion, asset.metadata ? JSON.stringify(asset.metadata) : null, asset.createdAt);
        return getMotionAsset(asset.id);
    };
    const getMotionAsset = (id) => {
        const row = selectOne(db, `${motionAssetSelect} WHERE id = ?`, [id]);
        return row ? mapMotionAsset(row) : null;
    };
    const listMotionAssets = (projectId) => {
        const rows = projectId
            ? selectAll(db, `${motionAssetSelect} WHERE project_id = ? ORDER BY created_at DESC, id DESC`, [projectId])
            : selectAll(db, `${motionAssetSelect} ORDER BY created_at DESC, id DESC`);
        return rows.map(mapMotionAsset);
    };
    const deleteMotionAsset = (id) => db.prepare('DELETE FROM director_motion_assets WHERE id = ?').run(id).changes;
    const getStorageDiagnostics = () => ({
        driver: 'better-sqlite3',
        journalMode,
        migrationBackupPath
    });
    const close = () => db.close();
    return {
        dbPath,
        listHistoryAssets,
        listHistoryAssetsPage,
        countHistoryAssetsByKind,
        getHistoryAsset,
        getHistoryAssetById,
        resolveHistoryAssetSource,
        upsertHistoryAssets,
        deleteHistoryAssets,
        updateHistoryAsset,
        updateHistoryAssetThumbnail,
        countHistoryAssetPreviewReferences,
        countHistoryAssetThumbnailReferences,
        getAssetBlob,
        getAssetBlobByHash,
        createAssetBlob,
        updateAssetBlobThumbnail,
        countAssetBlobReferences,
        deleteUnreferencedAssetBlobs,
        countHistoryAssetFileReferences,
        listHistoryAssetFileReferences,
        listRoles,
        getRole,
        listRolesPage,
        replaceRoles,
        upsertRole,
        deleteRoles,
        getLibraryAsset,
        getLibraryAssetByHash,
        resolveLibraryAssetSource,
        listLibraryAssetsPage,
        countLibraryAssetsByKind,
        listLibraryAssetTags,
        createLibraryAsset,
        attachLibraryAssetBlob,
        addLibraryAssetProvenance,
        listLibraryAssetProvenance,
        relinkLibraryAsset,
        updateLibraryAssetThumbnail,
        updateLibraryAsset,
        archiveLibraryAssets,
        restoreLibraryAsset,
        deleteLibraryAssets,
        listProjectCoverAssetIds,
        listReferencedLibraryAssetIds,
        listLibraryAssetDeletionImpact,
        listRoleDeletionImpact,
        listHistoryDeletionImpact,
        getDirectorModelAsset,
        getDirectorModelAssetByHash,
        createDirectorModelAsset,
        setDirectorModelAssetsRetained,
        listReleasedDirectorModelAssets,
        listPendingDeletionDirectorModelAssets,
        listReferencedDirectorModelAssetIds,
        deleteDirectorModelAssets,
        getProject,
        listProjects,
        listProjectSummaries,
        upsertProject,
        saveProject,
        patchProjectMetadata,
        patchProjectNodePositions,
        deleteCanvasHistoryAssets,
        deleteProject,
        getSetting,
        setSetting,
        createGenerationJob,
        getGenerationJob,
        updateGenerationJob,
        recoverInterruptedGenerationJobs,
        sweepGenerationJobs,
        createMotionAsset,
        getMotionAsset,
        listMotionAssets,
        deleteMotionAsset,
        getStorageDiagnostics,
        close
    };
};
