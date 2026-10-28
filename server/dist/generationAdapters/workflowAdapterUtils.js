import { validateGenerationWorkflowDefinition } from '@ftv/shared';
export const requireWorkflow = (context, protocol) => {
    const workflow = context.workflow;
    if (!workflow || workflow.protocol !== protocol)
        throw new Error(`当前模型缺少 ${protocol} 工作流配置`);
    if (workflow.output.kind !== context.kind)
        throw new Error('工作流输出类型与当前节点类型不匹配');
    return validateGenerationWorkflowDefinition(workflow);
};
const resolutionTarget = (value) => {
    const raw = String(value ?? '').trim().toUpperCase();
    if (!raw)
        return { size: 1024, edge: 'long' };
    const withUnit = raw.match(/^(\d+(?:\.\d+)?)\s*([KM])?$/);
    if (withUnit) {
        const size = Number.parseFloat(withUnit[1]);
        if (!Number.isFinite(size) || size <= 0)
            return { size: 1024, edge: 'long' };
        if (withUnit[2] === 'M')
            return { size: size * 1024 * 1024, edge: 'long' };
        if (withUnit[2] === 'K')
            return { size: size * 1024, edge: 'long' };
        return { size, edge: 'long' };
    }
    // 720P / 1080P follow the video convention: the number is the vertical/short side.
    const vertical = raw.match(/^(\d{2,5})P$/);
    if (vertical)
        return { size: Number.parseInt(vertical[1], 10), edge: 'short' };
    return { size: 1024, edge: 'long' };
};
export const readBindingValue = (context, binding, mediaValues = {}) => {
    const index = binding.index ?? 0;
    if (binding.source === 'prompt')
        return context.cleanPrompt;
    if (binding.source === 'image' || binding.source === 'video' || binding.source === 'audio') {
        return mediaValues[binding.source]?.[index] ?? context.references[`${binding.source}Refs`][index];
    }
    if (binding.source === 'width' || binding.source === 'height') {
        const explicitSize = binding.source === 'width' ? context.customWidth : context.customHeight;
        if (typeof explicitSize === 'number' && Number.isFinite(explicitSize) && explicitSize >= 64) {
            return Math.min(16384, Math.max(64, Math.round(explicitSize)));
        }
        const [ratioWidth = 16, ratioHeight = 9] = String(context.ratio ?? '16:9').split(':').map(Number);
        const { size, edge } = resolutionTarget(context.resolution);
        const scale = size / (edge === 'short' ? Math.min(ratioWidth, ratioHeight) : Math.max(ratioWidth, ratioHeight));
        return Math.max(64, Math.round((binding.source === 'width' ? ratioWidth : ratioHeight) * scale / 8) * 8);
    }
    if (binding.source === 'duration')
        return context.duration;
    if (binding.source === 'frames')
        return context.duration ? Math.round(context.duration * 24) : undefined;
    if (binding.source === 'seed') {
        if (typeof context.seed === 'number' && Number.isFinite(context.seed))
            return Math.min(2147483646, Math.max(0, Math.round(context.seed)));
        return Math.floor(Math.random() * 2147483647);
    }
    if (binding.source === 'batch')
        return context.batchSize ?? 1;
    if (binding.source === 'float') {
        // Float parameters are user-authored constants. `binding.value` holds the literal configured in
        // the workflow mapping; `index` selects one entry when several mappings share the same source.
        const list = Array.isArray(context.floatValues) ? context.floatValues : undefined;
        const pooled = Number.isFinite(index) && index > 0 ? list?.[index] : undefined;
        const raw = pooled ?? binding.value ?? list?.[0];
        if (raw === undefined || raw === null || raw === '')
            return undefined;
        const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).trim());
        if (!Number.isFinite(parsed))
            return undefined;
        return Math.min(1e12, Math.max(-1e12, parsed));
    }
    return undefined;
};
export const collectAutoDimensionBindings = (workflow) => {
    const apiFormat = workflow?.apiFormat ?? {};
    const declared = new Set((workflow?.inputs ?? []).map((binding) => binding.source));
    if (declared.has('width') && declared.has('height'))
        return [];
    const found = {};
    const visited = new Set();
    const queue = [workflow?.output?.nodeId].filter((id) => typeof id === 'string');
    while (queue.length) {
        const nodeId = queue.shift();
        if (!nodeId || visited.has(nodeId))
            continue;
        visited.add(nodeId);
        const node = apiFormat[nodeId];
        if (!node || typeof node !== 'object')
            continue;
        const inputs = node.inputs;
        if (!inputs || typeof inputs !== 'object')
            continue;
        for (const kind of ['width', 'height']) {
            if (found[kind] || declared.has(kind))
                continue;
            if (Object.prototype.hasOwnProperty.call(inputs, kind))
                found[kind] = { nodeId, input: kind, source: kind, required: false, index: undefined, auto: true };
        }
        for (const value of Object.values(inputs)) {
            if (Array.isArray(value) && typeof value[0] === 'string')
                queue.push(value[0]);
        }
    }
    return ['width', 'height'].filter((kind) => found[kind]).map((kind) => found[kind]);
};
export const resolveAutoDimensionBindings = (context, workflow) => collectAutoDimensionBindings(workflow)
    .map((binding) => ({ binding, value: readBindingValue(context, binding) }))
    .filter((resolved) => resolved.value !== undefined);
export const validateWorkflowBindings = (context, workflow, mediaValues) => workflow.inputs.map((binding) => ({ binding, value: readBindingValue(context, binding, mediaValues) })).map((resolved) => {
    if (resolved.binding.required && (resolved.value === undefined || resolved.value === null || resolved.value === '')) {
        throw new Error(`工作流缺少必填输入: ${resolved.binding.source}${(resolved.binding.index ?? 0) + 1}`);
    }
    return resolved;
});
const mediaKinds = new Set(['image', 'video', 'audio']);
export const uploadBoundWorkflowMedia = async (context, workflow, upload) => {
    validateWorkflowBindings(context, workflow);
    const uniqueBindings = new Map();
    workflow.inputs.forEach((binding) => {
        if (!mediaKinds.has(binding.source))
            return;
        const kind = binding.source;
        const index = binding.index ?? 0;
        uniqueBindings.set(`${kind}:${index}`, { kind, index });
    });
    const result = {};
    for (const { kind, index } of uniqueBindings.values()) {
        const rawKey = `raw${kind[0].toUpperCase()}${kind.slice(1)}Refs`;
        const source = context.references[rawKey][index] ?? context.references[`${kind}Refs`][index];
        if (!source)
            continue;
        const file = await context.references.toReferenceBlob(source);
        if (!file)
            throw new Error(`工作流无法读取已映射媒体: ${kind}${index + 1}`);
        const value = await upload({ kind, index, file });
        (result[kind] ?? (result[kind] = {}))[index] = value;
    }
    return result;
};
export const persistWorkflowOutputs = async (context, urls, kind, downloadHeaders) => {
    if (!context.persistGeneratedMedia)
        return { previewUrls: urls, historyAssetIds: [] };
    const previewUrls = [];
    const historyAssetIds = [];
    for (const [index, url] of urls.entries()) {
        const response = await fetch(url, {
            ...(downloadHeaders && Object.keys(downloadHeaders).length > 0 ? { headers: downloadHeaders } : {}),
            ...(context.signal ? { signal: context.signal } : {})
        });
        if (!response.ok)
            throw new Error(`工作流输出下载失败: HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') ?? (kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0)
            throw new Error('工作流输出为空文件');
        const normalizedType = contentType.split(';', 1)[0].trim().toLowerCase();
        if (normalizedType === 'text/html' || normalizedType === 'application/json' || normalizedType.startsWith('text/')) {
            throw new Error('工作流输出不是媒体文件');
        }
        const result = await context.persistGeneratedMedia({
            bytes,
            contentType,
            fileName: `workflow-${Date.now()}-${index + 1}.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3'}`,
            kind,
            projectId: context.projectId,
            canvasId: context.canvasId
        });
        previewUrls.push(result.previewUrl);
        if (result.historyAssetId)
            historyAssetIds.push(result.historyAssetId);
    }
    return { previewUrls, historyAssetIds };
};
