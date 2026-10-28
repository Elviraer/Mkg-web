import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 工作流存储路由：把「平台配置 + 工作流定义」持久化到项目数据目录的
 * workflows-store 文件夹，使工作流不依赖浏览器存储（清缓存不丢、可复制分发）。
 *
 * 存储布局（一工作流一文件，同层摆放，打开文件夹即可见全部）：
 *   data/workflows-store/config.json      { version, updatedAt, providers:[...] }  // 平台与映射配置
 *   data/workflows-store/<key>.json       { key, value }                            // key = definitionId，一个工作流一个文件
 *
 * 首次检测到旧的单文件 data/workflow-store.json 时自动拆分迁移，迁移成功后删除旧文件。
 *
 * API 契约（前端零感知，形状与单文件版一致）：
 * - GET  /api/workflow-store                  → { exists, data:{ version, updatedAt, providers, workflows:[{key,value}] } }
 * - PUT  /api/workflow-store                  → 全量快照（首次迁移上传用）
 * - PUT  /api/workflow-store/providers        → 只写 config.json（平台配置写穿）
 * - PUT  /api/workflow-store/workflows/:key   → 单个工作流文件写穿
 * - DELETE /api/workflow-store/workflows/:key → 删除单个工作流文件
 *
 * 前端配合（web/assets/generationWorkflowStore-DIMMMDsO.js / mediaResourcePool-BSSB-6I3.js）：
 * - 启动 hydration 时 GET 聚合快照，较新（updatedAt）则应用到 IndexedDB/localStorage；无快照则上传迁移；
 * - 之后每次保存/删除工作流都写穿（PUT/DELETE 单项 + PUT providers）。
 */
export function createWorkflowStoreRoutes({ dataDir }) {
    const router = Router();
    const storeDir = path.join(dataDir, 'workflows-store');
    const configPath = path.join(storeDir, 'config.json');
    const legacyPath = path.join(dataDir, 'workflow-store.json');
    const CONFIG_NAME = 'config.json';
    let writeChain = Promise.resolve();

    const readJsonFile = (p) => {
        try {
            const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (parsed && typeof parsed === 'object') return parsed;
        } catch (_) {
            // 不存在或损坏：视为空
        }
        return null;
    };

    const writeFileAtomic = (p, data) => {
        const tmp = `${p}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
        fs.renameSync(tmp, p);
    };

    const ensureDir = () => {
        fs.mkdirSync(storeDir, { recursive: true });
    };

    // key 来自 URL 参数，做字符白名单，防路径穿越
    const safeKey = (key) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(key) ? key : null);

    const workflowFilePath = (key) => path.join(storeDir, `${key}.json`);

    // config.json 不存在时返回 null（与「空 providers」区分，用于 exists 判定）
    const readConfig = () => readJsonFile(configPath);

    // 列出目录下所有工作流文件（排除 config.json 与临时文件）
    const listWorkflowFiles = () => {
        let names = [];
        try {
            names = fs.readdirSync(storeDir);
        } catch (_) {
            return [];
        }
        return names.filter((n) => n.endsWith('.json') && n !== CONFIG_NAME);
    };

    const readWorkflowFiles = () => {
        const out = [];
        for (const name of listWorkflowFiles()) {
            const parsed = readJsonFile(path.join(storeDir, name));
            if (parsed && parsed.key !== undefined && parsed.value !== undefined) {
                out.push({ key: String(parsed.key), value: parsed.value });
            }
        }
        return out;
    };

    // 目录中最新的工作流文件 mtime（用于感知外部直接编辑单个文件）
    const latestWorkflowMtimeMs = () => {
        let m = 0;
        for (const name of listWorkflowFiles()) {
            try {
                const st = fs.statSync(path.join(storeDir, name));
                if (st.mtimeMs > m) m = st.mtimeMs;
            } catch (_) {
                // 文件瞬间被删：忽略
            }
        }
        return m;
    };

    const writeConfig = (providers, updatedAt) => {
        ensureDir();
        writeFileAtomic(configPath, {
            version: 1,
            updatedAt: updatedAt || new Date().toISOString(),
            providers: Array.isArray(providers) ? providers : []
        });
        return readConfig();
    };

    const touchConfig = (providers) => writeConfig(providers);

    // 一次性迁移：旧单文件 workflow-store.json → workflows-store/config.json + <key>.json
    const migrateIfNeeded = () => {
        try {
            if (fs.existsSync(storeDir) || !fs.existsSync(legacyPath)) return;
            const legacy = readJsonFile(legacyPath);
            if (!legacy) return;
            ensureDir();
            const wfs = Array.isArray(legacy.workflows) ? legacy.workflows : [];
            let written = 0;
            for (const w of wfs) {
                if (!w || w.key === undefined) continue;
                const k = safeKey(String(w.key));
                if (!k) continue;
                writeFileAtomic(workflowFilePath(k), { key: k, value: w.value });
                written += 1;
            }
            writeConfig(Array.isArray(legacy.providers) ? legacy.providers : [], legacy.updatedAt);
            // 读回校验条数一致后才删旧文件，防止迁移不完整丢数据
            if (readWorkflowFiles().length === written) {
                fs.unlinkSync(legacyPath);
            }
        } catch (_) {
            // 迁移失败不阻塞：旧文件仍在，下次请求重试
        }
    };

    // 读-改-写串行化，避免并发写互相覆盖
    const enqueueWrite = (mutator) => new Promise((resolve) => {
        writeChain = writeChain.then(async () => {
            try {
                const r = await mutator();
                resolve(r || { ok: true });
            } catch (error) {
                resolve({ ok: false, error: String(error && error.message ? error.message : error) });
            }
        });
    });

    router.get('/workflow-store', (req, res) => {
        migrateIfNeeded();
        const config = readConfig();
        const workflows = readWorkflowFiles();
        if (!config && workflows.length === 0) return res.json({ exists: false });
        let updatedAt = config && config.updatedAt ? config.updatedAt : undefined;
        // 外部直接编辑了某个工作流文件（mtime 新于 config.updatedAt）→ 提升 updatedAt
        // 让前端 hydration 能识别并应用；同时把新时间戳持久化回 config
        const mtime = latestWorkflowMtimeMs();
        if (mtime > 0 && (!updatedAt || mtime > Date.parse(updatedAt))) {
            updatedAt = new Date(mtime).toISOString();
            const providers = (config && config.providers) || [];
            enqueueWrite(async () => {
                writeConfig(providers, updatedAt);
                return { ok: true };
            });
        }
        res.json({
            exists: true,
            data: {
                version: 1,
                updatedAt,
                providers: (config && config.providers) || [],
                workflows
            }
        });
    });

    // 全量快照（首次迁移上传用）：重写 config + 每个工作流文件，清理多余文件
    router.put('/workflow-store', (req, res) => {
        const body = req.body || {};
        enqueueWrite(async () => {
            ensureDir();
            const providers = Array.isArray(body.providers) ? body.providers : ((readConfig() || {}).providers || []);
            const wfs = Array.isArray(body.workflows) ? body.workflows : [];
            const keep = new Set();
            for (const w of wfs) {
                if (!w || w.key === undefined) continue;
                const k = safeKey(String(w.key));
                if (!k) continue;
                keep.add(k);
                writeFileAtomic(workflowFilePath(k), { key: k, value: w.value });
            }
            for (const name of listWorkflowFiles()) {
                if (!keep.has(name.slice(0, -5))) {
                    try { fs.unlinkSync(path.join(storeDir, name)); } catch (_) {}
                }
            }
            const cfg = touchConfig(providers);
            return { ok: true, updatedAt: cfg && cfg.updatedAt };
        }).then((r) => res.json(r));
    });

    // 平台配置写穿（localStorage mk_providers 的内容）——只动 config.json
    router.put('/workflow-store/providers', (req, res) => {
        const body = req.body;
        enqueueWrite(async () => {
            const providers = Array.isArray(body) ? body : ((readConfig() || {}).providers || []);
            const cfg = touchConfig(providers);
            return { ok: true, updatedAt: cfg && cfg.updatedAt };
        }).then((r) => res.json(r));
    });

    // 单条工作流定义写穿 → 独立文件（新增工作流即新增一个 json 文件）
    router.put('/workflow-store/workflows/:key', (req, res) => {
        const key = safeKey(String(req.params.key || ''));
        const value = req.body;
        if (!key || value === undefined || value === null) {
            return res.status(400).json({ ok: false, error: 'invalid payload' });
        }
        enqueueWrite(async () => {
            ensureDir();
            writeFileAtomic(workflowFilePath(key), { key, value });
            const cfg = touchConfig((readConfig() || {}).providers || []);
            return { ok: true, updatedAt: cfg && cfg.updatedAt };
        }).then((r) => res.json(r));
    });

    // 单条工作流定义删除写穿 → 删除对应文件
    router.delete('/workflow-store/workflows/:key', (req, res) => {
        const key = safeKey(String(req.params.key || ''));
        if (!key) return res.status(400).json({ ok: false, error: 'invalid key' });
        enqueueWrite(async () => {
            try { fs.unlinkSync(workflowFilePath(key)); } catch (_) {}
            const cfg = touchConfig((readConfig() || {}).providers || []);
            return { ok: true, updatedAt: cfg && cfg.updatedAt };
        }).then((r) => res.json(r));
    });

    return router;
}
