import { persistWorkflowOutputs, requireWorkflow, resolveAutoDimensionBindings, uploadBoundWorkflowMedia, validateWorkflowBindings } from './workflowAdapterUtils.js';
const authorizationHeaders = (apiKey) => ({ Authorization: `Bearer ${apiKey}` });
const encodeTask = (task) => (`runninghub:${Buffer.from(JSON.stringify(task)).toString('base64url')}`);
const decodeTask = (taskId) => {
    const payload = taskId.replace(/^runninghub:/, '');
    try {
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (typeof decoded.remoteTaskId === 'string'
            && (decoded.outputKind === 'image' || decoded.outputKind === 'video' || decoded.outputKind === 'audio')
            && typeof decoded.outputNodeId === 'string')
            return decoded;
    }
    catch {
        // Legacy P20 preview tasks used runninghub:<kind>:<remoteTaskId>.
    }
    const [outputKind = 'image', ...remoteParts] = payload.split(':');
    if ((outputKind !== 'image' && outputKind !== 'video' && outputKind !== 'audio') || remoteParts.length === 0)
        throw new Error('RunningHub 任务标识无效');
    return { outputKind, remoteTaskId: remoteParts.join(':'), outputNodeId: 'platform-output' };
};
const readRunningHubError = (body, fallback) => body.message || body.msg || fallback;
export const submitRunningHubGeneration = async (context) => {
    const workflow = requireWorkflow(context, 'runninghub');
    if (!workflow.workflowId)
        throw new Error('RunningHub 工作流缺少 workflowId');
    const mediaValues = await uploadBoundWorkflowMedia(context, workflow, async ({ file }) => {
        const form = new FormData();
        form.append('file', file.blob, file.filename);
        const response = await fetch(`${context.effectiveBaseUrl}/openapi/v2/media/upload/binary`, {
            method: 'POST',
            headers: authorizationHeaders(context.effectiveApiKey),
            body: form,
            ...(context.signal ? { signal: context.signal } : {})
        });
        const body = await response.json();
        if (!response.ok || body.code !== 0 || !body.data?.fileName) {
            throw new Error(readRunningHubError(body, `RunningHub 媒体上传失败: HTTP ${response.status}`));
        }
        return body.data.fileName;
    });
    const nodeInfoList = [...validateWorkflowBindings(context, workflow, mediaValues), ...resolveAutoDimensionBindings(context, workflow)].flatMap(({ binding, value }) => value === undefined ? [] : [{
            nodeId: binding.nodeId,
            fieldName: binding.input,
            fieldValue: String(value)
        }]);
    const response = await fetch(`${context.effectiveBaseUrl}/task/openapi/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authorizationHeaders(context.effectiveApiKey) },
        body: JSON.stringify({ apiKey: context.effectiveApiKey, workflowId: workflow.workflowId, nodeInfoList, clientTaskId: context.idempotencyKey }),
        ...(context.signal ? { signal: context.signal } : {})
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0 || !body.data?.taskId) {
        throw new Error(readRunningHubError(body, `RunningHub 提交失败: HTTP ${response.status}`));
    }
    return {
        ok: true,
        status: 'queued',
        taskId: encodeTask({ remoteTaskId: body.data.taskId, outputKind: workflow.output.kind, outputNodeId: workflow.output.nodeId }),
        message: 'RunningHub 工作流已提交'
    };
};
export const queryRunningHubGenerationStatus = async (context) => {
    const task = decodeTask(context.taskId);
    const response = await fetch(`${context.effectiveBaseUrl}/task/openapi/outputs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authorizationHeaders(context.effectiveApiKey) },
        body: JSON.stringify({ apiKey: context.effectiveApiKey, taskId: task.remoteTaskId }),
        ...(context.signal ? { signal: context.signal } : {})
    });
    const body = await response.json();
    if (!response.ok)
        throw new Error(readRunningHubError(body, `RunningHub 请求失败: HTTP ${response.status}`));
    if (body.code === 804 || body.code === 813) {
        return { ok: true, status: 'processing', taskId: context.taskId, previewUrls: [], message: 'RunningHub 工作流执行中' };
    }
    if (body.code === 805) {
        return { ok: true, status: 'failed', taskId: context.taskId, previewUrls: [], message: readRunningHubError(body, 'RunningHub 工作流执行失败') };
    }
    if (body.code !== 0)
        throw new Error(readRunningHubError(body, `RunningHub 返回错误码 ${body.code ?? 'unknown'}`));
    const outputs = Array.isArray(body.data) ? body.data : body.data?.outputs ?? [];
    const matchingOutputs = task.outputNodeId === 'platform-output'
        ? outputs
        : outputs.filter((item) => String(item.nodeId ?? '') === task.outputNodeId);
    const urls = matchingOutputs.map((item) => item.fileUrl).filter((url) => Boolean(url));
    const selected = task.outputKind === 'image' ? urls : urls.slice(0, 1);
    if (selected.length === 0) {
        return {
            ok: true,
            status: 'failed',
            taskId: context.taskId,
            previewUrls: [],
            message: `RunningHub 已完成，但输出节点 ${task.outputNodeId} 没有返回${task.outputKind === 'video' ? '视频' : task.outputKind === 'audio' ? '音频' : '图片'}`
        };
    }
    const persisted = await persistWorkflowOutputs(context, selected, task.outputKind);
    return {
        ok: true,
        status: 'completed',
        taskId: context.taskId,
        previewUrl: persisted.previewUrls[0],
        previewUrls: persisted.previewUrls,
        ...(persisted.historyAssetIds.length > 0 ? { historyAssetIds: persisted.historyAssetIds } : {}),
        message: 'RunningHub 工作流完成'
    };
};
