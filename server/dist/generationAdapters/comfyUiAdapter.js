import { randomUUID } from 'crypto';
import { persistWorkflowOutputs, requireWorkflow, resolveAutoDimensionBindings, uploadBoundWorkflowMedia, validateWorkflowBindings } from './workflowAdapterUtils.js';
const headers = (apiKey) => apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
const describeComfySubmitError = (body, status) => {
    const error = body?.error;
    if (error === undefined || error === null || error === '')
        return `ComfyUI 提交失败: HTTP ${status}`;
    if (typeof error === 'string')
        return error;
    const nodeErrors = error.extra_data?.node_errors;
    const parts = [];
    if (nodeErrors && typeof nodeErrors === 'object') {
        for (const [nodeId, info] of Object.entries(nodeErrors)) {
            const classType = info?.class_type ? ` · ${info.class_type}` : '';
            const errors = Array.isArray(info?.errors) ? info.errors : [];
            const details = errors.map((item) => {
                const message = item?.message || item?.type || '校验未通过';
                const extra = typeof item?.details === 'string' && item.details ? `（${item.details}）` : '';
                return `${message}${extra}`;
            });
            parts.push(`节点 ${nodeId}${classType}：${details.join('；') || '输入校验未通过'}`);
        }
    }
    if (parts.length === 0)
        parts.push(typeof error.message === 'string' && error.message ? error.message : JSON.stringify(error));
    return `ComfyUI 工作流提交被拒绝：${parts.join(' | ')}`;
};
const encodeTask = (promptId, outputNodeId, outputKind) => (`comfy:${Buffer.from(JSON.stringify({ promptId, outputNodeId, outputKind })).toString('base64url')}`);
const decodeTask = (taskId) => JSON.parse(Buffer.from(taskId.replace(/^comfy:/, ''), 'base64url').toString('utf8'));
export const submitComfyUiGeneration = async (context) => {
    const workflow = requireWorkflow(context, 'comfyui');
    if (!workflow.apiFormat)
        throw new Error('ComfyUI 工作流缺少 API Format JSON');
    const mediaValues = await uploadBoundWorkflowMedia(context, workflow, async ({ file }) => {
        const form = new FormData();
        form.append('image', file.blob, file.filename);
        form.append('type', 'input');
        form.append('overwrite', 'true');
        const response = await fetch(`${context.effectiveBaseUrl}/upload/image`, {
            method: 'POST',
            headers: headers(context.effectiveApiKey),
            body: form,
            ...(context.signal ? { signal: context.signal } : {})
        });
        if (!response.ok)
            throw new Error(`ComfyUI 媒体上传失败: HTTP ${response.status}`);
        const body = await response.json();
        if (!body.name)
            throw new Error('ComfyUI 媒体上传未返回文件名');
        return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
    });
    const apiFormat = structuredClone(workflow.apiFormat);
    const mediaKinds = new Set(['image', 'video', 'audio']);
    const kindLabel = { image: '图片', video: '视频', audio: '音频' };
    [...validateWorkflowBindings(context, workflow, mediaValues), ...resolveAutoDimensionBindings(context, workflow)].forEach(({ binding, value }) => {
        const node = apiFormat[binding.nodeId];
        if (!node)
            throw new Error(`ComfyUI 工作流不存在节点 ${binding.nodeId}`);
        const originalValue = workflow.apiFormat?.[binding.nodeId]?.inputs?.[binding.input];
        if (mediaKinds.has(binding.source) && Array.isArray(originalValue)) {
            const classType = node.class_type ? `（${node.class_type}）` : '';
            const source = originalValue[0] ? `原本接收上游节点 ${originalValue[0]} 的连接` : '原本是一个连线输入';
            throw new Error(`工作流映射有误：节点 ${binding.nodeId}${classType} 的输入「${binding.input}」${source}，不能直接写入${kindLabel[binding.source]}文件名。请把「${kindLabel[binding.source]}」映射到加载器节点（如 LoadImage）的 image/audio 输入上。`);
        }
        node.inputs ?? (node.inputs = {});
        if (value !== undefined)
            node.inputs[binding.input] = value;
    });
    const response = await fetch(`${context.effectiveBaseUrl}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers(context.effectiveApiKey) },
        body: JSON.stringify({ prompt: apiFormat, client_id: context.idempotencyKey ?? randomUUID() }),
        ...(context.signal ? { signal: context.signal } : {})
    });
    const body = await response.json();
    if (!response.ok || !body.prompt_id)
        throw new Error(describeComfySubmitError(body, response.status));
    return { ok: true, status: 'queued', taskId: encodeTask(body.prompt_id, workflow.output.nodeId, workflow.output.kind), message: 'ComfyUI 工作流已提交' };
};
export const queryComfyUiGenerationStatus = async (context) => {
    const task = decodeTask(context.taskId);
    const response = await fetch(`${context.effectiveBaseUrl}/history/${encodeURIComponent(task.promptId)}`, { headers: headers(context.effectiveApiKey), ...(context.signal ? { signal: context.signal } : {}) });
    if (!response.ok)
        throw new Error(`ComfyUI 状态查询失败: HTTP ${response.status}`);
    const history = await response.json();
    const record = history[task.promptId];
    if (!record)
        return { ok: true, status: 'processing', taskId: context.taskId, previewUrls: [], message: 'ComfyUI 工作流执行中' };
    if (record.status?.status_str === 'error')
        return { ok: true, status: 'failed', taskId: context.taskId, previewUrls: [], message: `ComfyUI 工作流执行失败：${record.status?.messages?.[0]?.[1]?.exception_message || record.status?.messages?.[0]?.[1]?.exception_type || '未提供详细原因'}` };
    const output = record.outputs?.[task.outputNodeId];
    const files = task.outputKind === 'image'
        ? output?.images ?? []
        : task.outputKind === 'video'
            ? output?.videos ?? output?.images ?? []
            : output?.audio ?? output?.audios ?? [];
    const urls = files.map((file) => `${context.effectiveBaseUrl}/view?${new URLSearchParams({ filename: file.filename ?? '', subfolder: file.subfolder ?? '', type: file.type ?? 'output' })}`);
    if (!record.status?.completed || urls.length === 0)
        return { ok: true, status: 'processing', taskId: context.taskId, previewUrls: [], message: 'ComfyUI 工作流执行中' };
    const persisted = await persistWorkflowOutputs(context, urls, task.outputKind, headers(context.effectiveApiKey));
    return {
        ok: true,
        status: 'completed',
        taskId: context.taskId,
        previewUrl: persisted.previewUrls[0],
        previewUrls: persisted.previewUrls,
        ...(persisted.historyAssetIds.length > 0 ? { historyAssetIds: persisted.historyAssetIds } : {}),
        message: 'ComfyUI 工作流完成'
    };
};
