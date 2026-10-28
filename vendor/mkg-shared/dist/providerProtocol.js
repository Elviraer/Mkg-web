export const DOUBAO_REFERENCE_IMAGE_LIMIT = 10;
export const DOLA_REFERENCE_IMAGE_LIMIT = 9;
export const XYQ_REFERENCE_IMAGE_LIMIT = 9;
/**
 * Reference image limits declared by the native gateways. Every other protocol
 * (custom OpenAI-compatible providers and the remaining built-in providers)
 * declares its own limits, so mkg must not pre-filter their references.
 */
export const getProviderReferenceImageLimit = (protocol) => {
    if (protocol === 'doubao-gateway')
        return DOUBAO_REFERENCE_IMAGE_LIMIT;
    if (protocol === 'dola-gateway')
        return DOLA_REFERENCE_IMAGE_LIMIT;
    if (protocol === 'xyq-gateway')
        return XYQ_REFERENCE_IMAGE_LIMIT;
    return undefined;
};
const providerImageTransportProfiles = new Set([
    'openai-images',
    'json-image-edits',
    'grok2api-images',
    'generation-reference-images',
    'generation-image-urls',
    'generation-images-array',
    'generation-input-image'
]);
export const normalizeProviderImageTransportProfile = (value) => (typeof value === 'string' && providerImageTransportProfiles.has(value)
    ? value
    : undefined);
const generationEndpointPathPattern = /^\/?[a-z0-9._~!$&'()*+,;=:@%\/-]+$/i;
const generationStatusPathPattern = /^\/?[a-z0-9._~!$&'()*+,;=:@%\/-]*\{task_id\}[a-z0-9._~!$&'()*+,;=:@%\/-]*$/i;
export const normalizeProviderGenerationEndpointPath = (value, options = {}) => {
    if (typeof value !== 'string')
        return undefined;
    const path = value.trim();
    if (!path || path.length > 256 || /^https?:\/\//i.test(path) || path.includes('..')
        || /[\\?#\u0000-\u001f]/.test(path)
        || (options.taskPlaceholder
            ? !generationStatusPathPattern.test(path)
            : !generationEndpointPathPattern.test(path)))
        return undefined;
    return path;
};
export const normalizeProviderGenerationEndpoints = (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const result = {};
    for (const kind of ['image', 'video']) {
        const raw = value[kind];
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
            continue;
        const mode = raw.mode;
        if (mode !== 'sync' && mode !== 'async')
            continue;
        const submitPath = normalizeProviderGenerationEndpointPath(raw.submitPath);
        const editPath = normalizeProviderGenerationEndpointPath(raw.editPath);
        const statusPath = normalizeProviderGenerationEndpointPath(raw.statusPath, { taskPlaceholder: true });
        const cancelPath = normalizeProviderGenerationEndpointPath(raw.cancelPath, { taskPlaceholder: true });
        const cancelMethod = raw.cancelMethod === 'DELETE' ? 'DELETE' : 'POST';
        if (!submitPath || (mode === 'async' && (!statusPath || !statusPath.includes('{task_id}'))))
            continue;
        result[kind] = {
            mode,
            submitPath,
            ...(editPath ? { editPath } : {}),
            ...(statusPath ? { statusPath } : {}),
            ...(mode === 'async' && cancelPath ? { cancelPath, cancelMethod } : {})
        };
    }
    return Object.keys(result).length > 0 ? result : undefined;
};
export const imageTransportFromLegacyRequestProfile = (value) => (value === 'openai-image'
    ? 'openai-images'
    : value === 'image-reference-images'
        ? 'generation-reference-images'
        : value === 'image-input-image'
            ? 'generation-input-image'
            : value === 'image-images-array'
                ? 'generation-images-array'
                : undefined);
export const inferProviderImageTransportProfile = ({ value, providerProfile, id, name, baseUrl }) => {
    const identity = `${id ?? ''} ${name ?? ''} ${baseUrl ?? ''}`.toLowerCase();
    const isHuiquyun = identity.includes('api.bjhuiqu.net') || identity.includes('huiquyun') || identity.includes('汇取云');
    const explicit = normalizeProviderImageTransportProfile(value);
    if (isHuiquyun && (!explicit || explicit === 'json-image-edits')) {
        return 'generation-image-urls';
    }
    if (explicit)
        return explicit;
    if (providerProfile === 'grok2api')
        return 'grok2api-images';
    return undefined;
};
const isWorkflowRecord = (value) => (typeof value === 'object' && value !== null && !Array.isArray(value));
export const parseGenerationWorkflowApiFormat = (value) => {
    if (!isWorkflowRecord(value))
        throw new Error('工作流必须是 API Format JSON 对象');
    const entries = Object.entries(value);
    if (entries.length === 0)
        throw new Error('API Format JSON 中没有工作流节点');
    const nodes = entries.map(([nodeId, rawNode]) => {
        if (!nodeId.trim() || !isWorkflowRecord(rawNode))
            throw new Error(`工作流节点 ${nodeId || '(空)'} 格式无效`);
        if (!isWorkflowRecord(rawNode.inputs))
            throw new Error(`工作流节点 ${nodeId} 缺少有效的 inputs 对象`);
        const classType = typeof rawNode.class_type === 'string' ? rawNode.class_type.trim() : '';
        const meta = isWorkflowRecord(rawNode._meta) ? rawNode._meta : undefined;
        const title = typeof meta?.title === 'string' ? meta.title.trim() : '';
        const descriptor = title || classType;
        return {
            nodeId,
            label: descriptor ? `${nodeId} · ${descriptor}` : nodeId,
            inputNames: Object.keys(rawNode.inputs).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
        };
    }).sort((left, right) => left.nodeId.localeCompare(right.nodeId, undefined, { numeric: true }));
    return { apiFormat: value, nodes };
};
export const validateGenerationWorkflowDefinition = (definition) => {
    const { apiFormat, nodes } = parseGenerationWorkflowApiFormat(definition.apiFormat);
    const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
    const outputNodeId = definition.output.nodeId.trim();
    if (!outputNodeId || !nodesById.has(outputNodeId)) {
        throw new Error(outputNodeId ? `API Format 中不存在输出节点 ${outputNodeId}` : '请选择输出节点');
    }
    const seenInputs = new Set();
    const inputs = definition.inputs.map((binding) => {
        const nodeId = binding.nodeId.trim();
        const input = binding.input.trim();
        if (!nodeId || !input)
            throw new Error('每项映射都必须选择节点和输入字段');
        const node = nodesById.get(nodeId);
        if (!node)
            throw new Error(`API Format 中不存在节点 ${nodeId}`);
        if (!node.inputNames.includes(input))
            throw new Error(`节点 ${nodeId} 中不存在输入字段 ${input}`);
        const key = `${nodeId}:${input}`;
        if (seenInputs.has(key))
            throw new Error('同一节点输入字段不能重复映射');
        seenInputs.add(key);
        // `index` is a positional selector for pooled sources: media references pick
        // referenceImages/Videos/Audios[index], and `float` picks floatValues[index]
        // (the panel sends float values as a positional array). Preserve it for those
        // sources; other sources ignore index entirely.
        const usesPositionalIndex = binding.source === 'image'
            || binding.source === 'video'
            || binding.source === 'audio'
            || binding.source === 'float';
        return {
            ...binding,
            nodeId,
            input,
            ...(usesPositionalIndex
                ? { index: Math.max(0, Math.floor(binding.index ?? 0)) }
                : { index: undefined })
        };
    });
    if (definition.protocol === 'runninghub' && !definition.workflowId?.trim())
        throw new Error('请输入 workflowId');
    return {
        ...definition,
        ...(definition.protocol === 'runninghub' ? { workflowId: definition.workflowId.trim() } : {}),
        apiFormat,
        inputs,
        output: { ...definition.output, nodeId: outputNodeId }
    };
};
export const isGptImageModel = (model) => (/^gpt[-_\s]?image(?:$|[-_\s])/.test(model?.trim().toLowerCase() ?? ''));
export const resolveProviderProtocol = (source) => {
    if (source?.kind === 'doubao-gateway')
        return 'doubao-gateway';
    if (source?.kind === 'dola-gateway')
        return 'dola-gateway';
    if (source?.kind === 'xyq-gateway')
        return 'xyq-gateway';
    if (source?.kind === 'comfyui')
        return 'comfyui';
    if (source?.kind === 'runninghub')
        return 'runninghub';
    const text = `${source?.id ?? ''} ${source?.name ?? ''} ${source?.baseUrl ?? ''}`.toLowerCase();
    if (text.includes('apimart') || text.includes('api.apimart.ai'))
        return 'apimart';
    if (text.includes('zhenzhen')
        || text.includes('t8star.org')
        || text.includes('aiproxy.vip')
        || text.includes('贞贞'))
        return 'zhenzhen';
    return 'openai-compatible';
};
