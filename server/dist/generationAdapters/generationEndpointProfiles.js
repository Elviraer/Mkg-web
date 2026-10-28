import { normalizeProviderGenerationEndpoints } from '@mkg/shared';
export const resolveGenerationEndpoint = ({ kind, protocol, configured }) => {
    if (kind !== 'image' && kind !== 'video')
        return undefined;
    const explicit = normalizeProviderGenerationEndpoints(configured)?.[kind];
    if (explicit)
        return explicit;
    return undefined;
};
export const generationEndpointUrl = (baseUrl, path) => {
    const normalized = path.trim();
    if (normalized.startsWith('/') || /^v1\//i.test(normalized))
        return new URL(`/${normalized.replace(/^\/+/, '')}`, baseUrl).toString();
    const base = baseUrl.replace(/\/+$/, '');
    return base.endsWith('/v1') ? `${base}/${normalized}` : `${base}/v1/${normalized}`;
};
export const generationStatusEndpointUrl = (baseUrl, path, taskId) => (generationEndpointUrl(baseUrl, path.split('{task_id}').join(encodeURIComponent(taskId))));
/** Reject a provider response that contradicts an explicitly configured sync contract. */
export const assertGenerationSubmissionMode = ({ endpoint, kind, previewUrls, taskId, status }) => {
    // A provider response that already carries generation resources is a finished sync result even
    // when the gateway also echoes an `id`/`task_id` field, so only an acknowledgement without any
    // resource can contradict a sync endpoint.
    if (previewUrls.length > 0)
        return;
    if (endpoint?.mode === 'sync' && (Boolean(taskId) || status === 'queued' || status === 'processing')) {
        throw new Error(`${kind === 'image' ? '图片' : '视频'}端点已配置为同步，但供应商返回了异步任务响应`);
    }
};
