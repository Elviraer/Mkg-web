import { createHash } from 'node:crypto';
const CANVAS_PERSISTENCE_VERSION_KEY = 'canvas_persistence_version';
const CANVAS_PERSISTENCE_VERSION = '1';
const CANVAS_PERSISTENCE_REPORT_KEY = 'canvas_persistence_migration_report';
const isRecord = (value) => (Boolean(value) && typeof value === 'object' && !Array.isArray(value));
const readFiniteNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const parseJson = (value, fallback) => {
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
};
const canonicalize = (value) => {
    if (Array.isArray(value))
        return value.map(canonicalize);
    if (!isRecord(value))
        return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};
const stableJson = (value) => JSON.stringify(canonicalize(value));
const patchHash = (patch) => (createHash('sha256').update(stableJson(patch)).digest('hex'));
const assertUnique = (label, ids) => {
    if (new Set(ids).size !== ids.length)
        throw new Error(`duplicate_${label}_id`);
};
const parseNode = (value) => {
    if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.position)) {
        throw new Error('invalid_canvas_node');
    }
    const x = readFiniteNumber(value.position.x);
    const y = readFiniteNumber(value.position.y);
    if (x === null || y === null)
        throw new Error(`invalid_canvas_node_position:${value.id}`);
    if (value.parentNode !== undefined && typeof value.parentNode !== 'string') {
        throw new Error(`invalid_canvas_node_parent:${value.id}`);
    }
    return value;
};
const parseEdge = (value) => {
    if (!isRecord(value)
        || typeof value.id !== 'string'
        || typeof value.source !== 'string'
        || typeof value.target !== 'string') {
        throw new Error('invalid_canvas_edge');
    }
    return value;
};
const parseCanvas = (value) => {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string')
        return null;
    const nodes = Array.isArray(value.nodes) ? value.nodes.map(parseNode) : [];
    const edges = Array.isArray(value.edges) ? value.edges.map(parseEdge) : [];
    return { ...value, id: value.id, name: value.name, nodes, edges };
};
const validatePatchShape = (patch) => {
    const nodes = patch.upsertNodes.map(parseNode);
    const edges = patch.upsertEdges.map(parseEdge);
    assertUnique('upsert_node', nodes.map(({ id }) => id));
    assertUnique('removed_node', patch.removedNodeIds);
    assertUnique('upsert_edge', edges.map(({ id }) => id));
    assertUnique('removed_edge', patch.removedEdgeIds);
    assertUnique('node_order_change', patch.nodeOrderChanges.map(({ nodeId }) => nodeId));
    const removedNodes = new Set(patch.removedNodeIds);
    const removedEdges = new Set(patch.removedEdgeIds);
    if (nodes.some(({ id }) => removedNodes.has(id)))
        throw new Error('node_upsert_remove_overlap');
    if (edges.some(({ id }) => removedEdges.has(id)))
        throw new Error('edge_upsert_remove_overlap');
    for (const change of patch.nodeOrderChanges) {
        if (typeof change.nodeId !== 'string')
            throw new Error('invalid_node_order_change');
        if (change.beforeNodeId !== null && typeof change.beforeNodeId !== 'string') {
            throw new Error('invalid_node_order_target');
        }
    }
    return { nodes, edges };
};
const applyOrderChanges = (ids, changes) => {
    const next = [...ids];
    for (const change of changes) {
        const currentIndex = next.indexOf(change.nodeId);
        if (currentIndex < 0)
            throw new Error(`node_order_source_not_found:${change.nodeId}`);
        next.splice(currentIndex, 1);
        if (change.beforeNodeId === null) {
            next.push(change.nodeId);
            continue;
        }
        const beforeIndex = next.indexOf(change.beforeNodeId);
        if (beforeIndex < 0)
            throw new Error(`node_order_target_not_found:${change.beforeNodeId}`);
        next.splice(beforeIndex, 0, change.nodeId);
    }
    return next;
};
export const installCanvasPersistenceSchema = (db) => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS canvases (
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      document_revision INTEGER NOT NULL DEFAULT 0,
      entity_revision INTEGER NOT NULL,
      PRIMARY KEY (project_id, canvas_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nodes (
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_node_id TEXT,
      position_x REAL NOT NULL,
      position_y REAL NOT NULL,
      sort_order INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      entity_revision INTEGER NOT NULL,
      PRIMARY KEY (project_id, canvas_id, node_id),
      FOREIGN KEY (project_id, canvas_id)
        REFERENCES canvases(project_id, canvas_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_canvas_order
      ON nodes(project_id, canvas_id, sort_order, node_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_canvas_parent
      ON nodes(project_id, canvas_id, parent_node_id);

    CREATE TABLE IF NOT EXISTS edges (
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      record_json TEXT NOT NULL,
      entity_revision INTEGER NOT NULL,
      PRIMARY KEY (project_id, canvas_id, edge_id),
      FOREIGN KEY (project_id, canvas_id)
        REFERENCES canvases(project_id, canvas_id) ON DELETE CASCADE,
      FOREIGN KEY (project_id, canvas_id, source_node_id)
        REFERENCES nodes(project_id, canvas_id, node_id),
      FOREIGN KEY (project_id, canvas_id, target_node_id)
        REFERENCES nodes(project_id, canvas_id, node_id)
    );

    CREATE INDEX IF NOT EXISTS idx_edges_canvas_source
      ON edges(project_id, canvas_id, source_node_id);
    CREATE INDEX IF NOT EXISTS idx_edges_canvas_target
      ON edges(project_id, canvas_id, target_node_id);

    CREATE TABLE IF NOT EXISTS applied_commands (
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      base_revision INTEGER NOT NULL,
      new_revision INTEGER NOT NULL,
      document_revision INTEGER NOT NULL,
      patch_hash TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (project_id, canvas_id, command_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);
};
export const createCanvasPatchStore = (db) => {
    const insertCanvas = db.prepare(`
    INSERT INTO canvases (
      project_id, canvas_id, name, sort_order, document_revision, entity_revision
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
    const insertNode = db.prepare(`
    INSERT INTO nodes (
      project_id, canvas_id, node_id, kind, parent_node_id, position_x, position_y,
      sort_order, record_json, entity_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const insertEdge = db.prepare(`
    INSERT INTO edges (
      project_id, canvas_id, edge_id, source_node_id, target_node_id, kind,
      record_json, entity_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const insertCanvasSnapshot = (projectId, canvas, canvasOrder, revision, report) => {
        assertUnique('snapshot_node', canvas.nodes.map(({ id }) => id));
        assertUnique('snapshot_edge', canvas.edges.map(({ id }) => id));
        insertCanvas.run(projectId, canvas.id, canvas.name, canvasOrder, revision, revision);
        const nodeIds = new Set(canvas.nodes.map(({ id }) => id));
        const nodes = canvas.nodes.map((node) => {
            if (!node.parentNode || nodeIds.has(node.parentNode))
                return node;
            report.detachedParentNodeIds.push(`${projectId}/${canvas.id}/${node.id}`);
            const detached = { ...node };
            delete detached.parentNode;
            return detached;
        });
        nodes.forEach((node, index) => {
            insertNode.run(projectId, canvas.id, node.id, typeof node.type === 'string' ? node.type : 'default', node.parentNode ?? null, node.position.x, node.position.y, index, JSON.stringify(node), revision);
        });
        const edges = canvas.edges.filter((edge) => {
            const valid = nodeIds.has(edge.source) && nodeIds.has(edge.target);
            if (!valid)
                report.droppedEdgeIds.push(`${projectId}/${canvas.id}/${edge.id}`);
            return valid;
        });
        edges.forEach((edge) => {
            insertEdge.run(projectId, canvas.id, edge.id, edge.source, edge.target, typeof edge.type === 'string' ? edge.type : 'default', JSON.stringify(edge), revision);
        });
        report.canvasesMigrated += 1;
        report.nodesMigrated += nodes.length;
        report.edgesMigrated += edges.length;
    };
    const hasEmbeddedCanvasSnapshots = () => {
        const version = db.prepare('SELECT value FROM storage_metadata WHERE key = ?')
            .get(CANVAS_PERSISTENCE_VERSION_KEY);
        if (version?.value === CANVAS_PERSISTENCE_VERSION)
            return false;
        const projects = db.prepare('SELECT data_json AS dataJson FROM projects').all();
        return projects.some(({ dataJson }) => {
            const data = parseJson(dataJson, null);
            if (!isRecord(data) || !Array.isArray(data.canvases))
                return false;
            return data.canvases.some((canvas) => (isRecord(canvas)
                && (Object.prototype.hasOwnProperty.call(canvas, 'nodes')
                    || Object.prototype.hasOwnProperty.call(canvas, 'edges'))));
        });
    };
    const migrateEmbeddedCanvasSnapshots = db.transaction(() => {
        const previousReport = db.prepare('SELECT value FROM storage_metadata WHERE key = ?')
            .get(CANVAS_PERSISTENCE_REPORT_KEY);
        const version = db.prepare('SELECT value FROM storage_metadata WHERE key = ?')
            .get(CANVAS_PERSISTENCE_VERSION_KEY);
        if (version?.value === CANVAS_PERSISTENCE_VERSION) {
            return parseJson(previousReport?.value ?? '', {
                version: 1,
                projectsRewritten: 0,
                canvasesMigrated: 0,
                canvasesPreserved: 0,
                nodesMigrated: 0,
                edgesMigrated: 0,
                detachedParentNodeIds: [],
                droppedEdgeIds: []
            });
        }
        const report = {
            version: 1,
            projectsRewritten: 0,
            canvasesMigrated: 0,
            canvasesPreserved: 0,
            nodesMigrated: 0,
            edgesMigrated: 0,
            detachedParentNodeIds: [],
            droppedEdgeIds: []
        };
        const projects = db.prepare(`
      SELECT id, name, data_json AS dataJson, revision FROM projects ORDER BY id
    `).all();
        const canvasExists = db.prepare(`
      SELECT 1 FROM canvases WHERE project_id = ? AND canvas_id = ?
    `);
        const updateCanvasMetadata = db.prepare(`
      UPDATE canvases SET name = ?, sort_order = ? WHERE project_id = ? AND canvas_id = ?
    `);
        const listNormalizedCanvases = db.prepare(`
      SELECT canvas_id AS id, name FROM canvases WHERE project_id = ? ORDER BY sort_order, canvas_id
    `);
        const updateProjectData = db.prepare('UPDATE projects SET data_json = ? WHERE id = ?');
        for (const project of projects) {
            const data = parseJson(project.dataJson, null);
            const embeddedCanvases = isRecord(data) && Array.isArray(data.canvases) ? data.canvases : [];
            const metadata = [];
            const metadataIds = new Set();
            for (const value of embeddedCanvases) {
                const canvas = parseCanvas(value);
                if (!canvas || metadataIds.has(canvas.id))
                    continue;
                const order = metadata.length;
                metadata.push({ id: canvas.id, name: canvas.name });
                metadataIds.add(canvas.id);
                if (canvasExists.get(project.id, canvas.id)) {
                    updateCanvasMetadata.run(canvas.name, order, project.id, canvas.id);
                    report.canvasesPreserved += 1;
                }
                else {
                    insertCanvasSnapshot(project.id, canvas, order, project.revision, report);
                }
            }
            const normalizedCanvases = listNormalizedCanvases.all(project.id);
            for (const canvas of normalizedCanvases) {
                if (metadataIds.has(canvas.id))
                    continue;
                metadata.push(canvas);
                metadataIds.add(canvas.id);
            }
            const requestedActiveCanvasId = isRecord(data) && typeof data.activeCanvasId === 'string'
                ? data.activeCanvasId
                : '';
            const activeCanvasId = metadataIds.has(requestedActiveCanvasId)
                ? requestedActiveCanvasId
                : metadata[0]?.id ?? '';
            const projectName = isRecord(data) && typeof data.projectName === 'string'
                ? data.projectName
                : project.name;
            const normalizedData = { projectName, canvases: metadata, activeCanvasId };
            if (project.dataJson !== JSON.stringify(normalizedData)) {
                updateProjectData.run(JSON.stringify(normalizedData), project.id);
                report.projectsRewritten += 1;
            }
        }
        const writeMetadata = db.prepare(`
      INSERT INTO storage_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
        writeMetadata.run(CANVAS_PERSISTENCE_REPORT_KEY, JSON.stringify(report));
        writeMetadata.run(CANVAS_PERSISTENCE_VERSION_KEY, CANVAS_PERSISTENCE_VERSION);
        return report;
    });
    const validateGraph = (projectId, canvasId) => {
        const missingParent = db.prepare(`
      SELECT child.node_id AS nodeId
      FROM nodes child
      LEFT JOIN nodes parent
        ON parent.project_id = child.project_id
        AND parent.canvas_id = child.canvas_id
        AND parent.node_id = child.parent_node_id
      WHERE child.project_id = ? AND child.canvas_id = ?
        AND child.parent_node_id IS NOT NULL AND parent.node_id IS NULL
      LIMIT 1
    `).get(projectId, canvasId);
        if (missingParent?.nodeId)
            throw new Error(`missing_parent:${missingParent.nodeId}`);
    };
    const applyPatchTransaction = db.transaction((input) => {
        const { projectId, canvasId, request } = input;
        const project = db.prepare('SELECT revision FROM projects WHERE id = ?').get(projectId);
        if (!project)
            throw new Error('project_not_found');
        const canvasRevision = db.prepare(`
      SELECT document_revision AS documentRevision
      FROM canvases WHERE project_id = ? AND canvas_id = ?
    `).get(projectId, canvasId);
        if (!canvasRevision)
            throw new Error('canvas_not_found');
        const hash = patchHash(request.patch);
        const applied = db.prepare(`
      SELECT base_revision AS baseRevision, new_revision AS newRevision,
        document_revision AS documentRevision, patch_hash AS patchHash
      FROM applied_commands
      WHERE project_id = ? AND canvas_id = ? AND command_id = ?
    `).get(projectId, canvasId, request.commandId);
        const noChanges = {
            projects: 0,
            canvases: 0,
            nodes: 0,
            edges: 0,
            appliedCommands: 0
        };
        if (applied) {
            if (applied.patchHash !== hash)
                throw new Error('command_id_patch_hash_mismatch');
            return {
                ok: true,
                status: 'idempotent',
                commandId: request.commandId,
                projectId,
                canvasId,
                baseRevision: applied.baseRevision,
                newRevision: applied.newRevision,
                documentRevision: applied.documentRevision,
                changedRows: noChanges
            };
        }
        if (project.revision !== request.expectedRevision) {
            return {
                ok: false,
                status: 'conflict',
                code: 'project_revision_conflict',
                currentRevision: project.revision
            };
        }
        if (canvasRevision.documentRevision !== request.documentRevisionBefore) {
            return {
                ok: false,
                status: 'conflict',
                code: 'canvas_document_revision_conflict',
                currentRevision: project.revision,
                currentDocumentRevision: canvasRevision.documentRevision
            };
        }
        if (!Number.isInteger(request.documentRevisionBefore)
            || !Number.isInteger(request.documentRevisionAfter)
            || request.documentRevisionAfter !== request.documentRevisionBefore + 1)
            throw new Error('invalid_document_revision');
        const { nodes, edges } = validatePatchShape(request.patch);
        const newRevision = request.expectedRevision + 1;
        const changedRows = { ...noChanges };
        const removeEdge = db.prepare(`
      DELETE FROM edges WHERE project_id = ? AND canvas_id = ? AND edge_id = ?
    `);
        const removeNode = db.prepare(`
      DELETE FROM nodes WHERE project_id = ? AND canvas_id = ? AND node_id = ?
    `);
        for (const edgeId of request.patch.removedEdgeIds) {
            changedRows.edges += removeEdge.run(projectId, canvasId, edgeId).changes;
        }
        for (const nodeId of request.patch.removedNodeIds) {
            changedRows.nodes += removeNode.run(projectId, canvasId, nodeId).changes;
        }
        const maxOrder = db.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) AS value
      FROM nodes WHERE project_id = ? AND canvas_id = ?
    `).get(projectId, canvasId);
        let nextOrder = Number(maxOrder.value) + 1;
        const upsertNode = db.prepare(`
      INSERT INTO nodes (
        project_id, canvas_id, node_id, kind, parent_node_id, position_x, position_y,
        sort_order, record_json, entity_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, canvas_id, node_id) DO UPDATE SET
        kind = excluded.kind,
        parent_node_id = excluded.parent_node_id,
        position_x = excluded.position_x,
        position_y = excluded.position_y,
        record_json = excluded.record_json,
        entity_revision = excluded.entity_revision
    `);
        for (const node of nodes) {
            changedRows.nodes += upsertNode.run(projectId, canvasId, node.id, typeof node.type === 'string' ? node.type : 'default', node.parentNode ?? null, node.position.x, node.position.y, nextOrder, JSON.stringify(node), newRevision).changes;
            nextOrder += 1;
        }
        if (request.patch.nodeOrderChanges.length > 0) {
            const rows = db.prepare(`
        SELECT node_id AS nodeId, sort_order AS sortOrder
        FROM nodes WHERE project_id = ? AND canvas_id = ?
        ORDER BY sort_order, node_id
      `).all(projectId, canvasId);
            const reordered = applyOrderChanges(rows.map(({ nodeId }) => nodeId), request.patch.nodeOrderChanges);
            const previousOrder = new Map(rows.map(({ nodeId, sortOrder }) => [nodeId, sortOrder]));
            const updateOrder = db.prepare(`
        UPDATE nodes SET sort_order = ?, entity_revision = ?
        WHERE project_id = ? AND canvas_id = ? AND node_id = ?
      `);
            reordered.forEach((nodeId, index) => {
                if (previousOrder.get(nodeId) === index)
                    return;
                changedRows.nodes += updateOrder.run(index, newRevision, projectId, canvasId, nodeId).changes;
            });
        }
        const upsertEdge = db.prepare(`
      INSERT INTO edges (
        project_id, canvas_id, edge_id, source_node_id, target_node_id, kind,
        record_json, entity_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, canvas_id, edge_id) DO UPDATE SET
        source_node_id = excluded.source_node_id,
        target_node_id = excluded.target_node_id,
        kind = excluded.kind,
        record_json = excluded.record_json,
        entity_revision = excluded.entity_revision
    `);
        for (const edge of edges) {
            changedRows.edges += upsertEdge.run(projectId, canvasId, edge.id, edge.source, edge.target, typeof edge.type === 'string' ? edge.type : 'default', JSON.stringify(edge), newRevision).changes;
        }
        validateGraph(projectId, canvasId);
        changedRows.canvases = db.prepare(`
      UPDATE canvases SET document_revision = ?, entity_revision = ?
      WHERE project_id = ? AND canvas_id = ?
    `).run(request.documentRevisionAfter, newRevision, projectId, canvasId).changes;
        changedRows.projects = db.prepare(`
      UPDATE projects SET revision = ?, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(newRevision, input.now, projectId, request.expectedRevision).changes;
        if (changedRows.projects !== 1)
            throw new Error('revision_compare_and_swap_failed');
        changedRows.appliedCommands = db.prepare(`
      INSERT INTO applied_commands (
        project_id, canvas_id, command_id, base_revision, new_revision,
        document_revision, patch_hash, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, canvasId, request.commandId, request.expectedRevision, newRevision, request.documentRevisionAfter, hash, input.now).changes;
        return {
            ok: true,
            status: 'applied',
            commandId: request.commandId,
            projectId,
            canvasId,
            baseRevision: request.expectedRevision,
            newRevision,
            documentRevision: request.documentRevisionAfter,
            changedRows
        };
    });
    const applyPatch = (input) => applyPatchTransaction({ ...input, now: input.now ?? new Date().toISOString() });
    const getSnapshotTransaction = db.transaction((projectId, canvasId) => {
        const project = db.prepare('SELECT revision FROM projects WHERE id = ?').get(projectId);
        if (!project)
            return null;
        const canvas = db.prepare(`
      SELECT document_revision AS documentRevision
      FROM canvases WHERE project_id = ? AND canvas_id = ?
    `).get(projectId, canvasId);
        if (!canvas)
            return null;
        const nodes = db.prepare(`
      SELECT node_id AS id, record_json AS recordJson
      FROM nodes WHERE project_id = ? AND canvas_id = ? ORDER BY sort_order, node_id
    `).all(projectId, canvasId);
        const edges = db.prepare(`
      SELECT edge_id AS id, record_json AS recordJson
      FROM edges WHERE project_id = ? AND canvas_id = ? ORDER BY edge_id
    `).all(projectId, canvasId);
        return {
            projectId,
            canvasId,
            projectRevision: project.revision,
            documentRevision: canvas.documentRevision,
            nodeIds: nodes.map(({ id }) => id),
            edgeIds: edges.map(({ id }) => id),
            nodes: nodes.map(({ recordJson }) => parseJson(recordJson, null)).filter(Boolean),
            edges: edges.map(({ recordJson }) => parseJson(recordJson, null)).filter(Boolean)
        };
    });
    const getDiagnostics = (projectId, canvasId) => ({
        canvases: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM canvases WHERE project_id = ? AND canvas_id = ?
    `).get(projectId, canvasId).count),
        nodes: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM nodes WHERE project_id = ? AND canvas_id = ?
    `).get(projectId, canvasId).count),
        edges: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM edges WHERE project_id = ? AND canvas_id = ?
    `).get(projectId, canvasId).count),
        appliedCommands: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM applied_commands WHERE project_id = ? AND canvas_id = ?
    `).get(projectId, canvasId).count)
    });
    return {
        hasEmbeddedCanvasSnapshots,
        migrateEmbeddedCanvasSnapshots: () => migrateEmbeddedCanvasSnapshots(),
        applyPatch,
        getSnapshot: (projectId, canvasId) => getSnapshotTransaction(projectId, canvasId),
        getDiagnostics
    };
};
