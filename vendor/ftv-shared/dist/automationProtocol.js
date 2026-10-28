import { z } from 'zod';
export const AUTOMATION_PROTOCOL_VERSION = 1;
export const automationCommandTypes = [
    'system.status',
    'canvas.snapshot',
    'node.list',
    'node.get',
    'node.create',
    'node.update',
    'node.move',
    'node.resize',
    'node.delete',
    'asset.create',
    'edge.list',
    'edge.connect',
    'edge.disconnect',
    'generation.submit',
    'provider.list',
    'provider.validateConfig',
    'provider.create',
    'provider.models',
    'provider.accounts',
    'provider.capabilities',
    'project.list',
    'project.create',
    'project.switch',
    'project.rename',
    'project.delete',
    'project.import',
    'project.export',
    'canvas.list',
    'canvas.create',
    'canvas.switch',
    'canvas.rename',
    'canvas.delete',
    'canvas.import',
    'canvas.export',
    'history.search',
    'history.use',
    'history.update',
    'history.delete',
    'history.download',
    'role.list',
    'role.create',
    'role.update',
    'role.delete',
    'role.use',
    'generation.status',
    'generation.wait',
    'generation.cancel',
    'generation.retry',
    'generation.useResult',
    'asset.download',
    'asset.downloadMany',
    'account.assign'
];
export const automationCommandTypeSchema = z.enum(automationCommandTypes);
export const automationRiskLevels = ['read', 'reversible', 'cost', 'destructive', 'external'];
export const automationRiskLevelSchema = z.enum(automationRiskLevels);
export const automationPermissionModes = ['allow', 'approval'];
export const automationPermissionModeSchema = z.enum(automationPermissionModes);
export const automationSessionIdleTimeoutOptions = [
    30 * 60 * 1000,
    60 * 60 * 1000,
    2 * 60 * 60 * 1000,
    4 * 60 * 60 * 1000,
    8 * 60 * 60 * 1000,
];
export const defaultAutomationApprovalPolicy = {
    risks: {
        read: 'allow',
        reversible: 'allow',
        cost: 'approval',
        destructive: 'approval',
        external: 'approval',
    },
    // Provider 自动配置是受限的本地设置写入，不涉及画布结构、外部资源或付费任务。
    // 显式声明为 allow，避免未来调整 reversible 风险默认值时误把 Agent 添加供应商变成审批流。
    commands: {
        'provider.create': 'allow',
    },
    sessionIdleTimeoutMs: automationSessionIdleTimeoutOptions[0],
};
export const automationNodeKindSchema = z.enum(['text', 'image', 'video', 'director', 'doubaoAccount', 'dolaAccount', 'xyqAccount']);
export const automationPointSchema = z.object({
    x: z.number().finite(),
    y: z.number().finite()
}).strict();
export const automationAssetRefSchema = z.discriminatedUnion('owner', [
    z.object({ owner: z.literal('library'), assetId: z.string().trim().min(1) }).strict(),
    z.object({ owner: z.literal('history'), assetId: z.string().trim().min(1) }).strict(),
    z.object({
        owner: z.literal('role'),
        roleId: z.string().trim().min(1),
        imageId: z.string().trim().min(1)
    }).strict()
]);
export const automationRoleSourceRefSchema = z.discriminatedUnion('owner', [
    z.object({ owner: z.literal('library'), assetId: z.string().trim().min(1) }).strict(),
    z.object({ owner: z.literal('history'), assetId: z.string().trim().min(1) }).strict()
]);
export const automationNodeDataPatchSchema = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    subtitle: z.string().max(500).optional(),
    description: z.string().max(2000).optional(),
    prompt: z.string().max(100000).optional(),
    textOutput: z.string().max(500000).optional(),
    model: z.string().max(200).optional(),
    resolution: z.string().max(100).optional(),
    imageQuality: z.enum(['auto', 'low', 'medium', 'high', 'standard', 'hd']).optional(),
    aspectRatio: z.string().max(50).optional(),
    displayAspectRatio: z.string().max(50).optional(),
    batchSize: z.number().int().min(1).max(100).optional(),
    videoResolution: z.string().max(100).optional(),
    videoMode: z.string().max(100).optional(),
    duration: z.number().finite().positive().max(3600).optional(),
    selectedAccountId: z.string().min(1).max(200).optional()
}).strict();
const emptyPayloadSchema = z.object({}).strict();
const nodeIdPayloadSchema = z.object({ nodeId: z.string().min(1) }).strict();
const canvasRecordSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(200),
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown())
}).passthrough();
const projectDataSchema = z.object({
    projectName: z.string().min(1).max(200),
    activeCanvasId: z.string().min(1),
    canvases: z.array(canvasRecordSchema).min(1)
}).strict();
export const automationHistoryMetadataSchema = z.object({
    model: z.string().max(200).optional(),
    prompt: z.string().max(100000).optional(),
    providerId: z.string().max(100).optional(),
    nodeId: z.string().max(200).optional(),
    aspectRatio: z.string().max(50).optional(),
    resolution: z.string().max(100).optional(),
    duration: z.number().finite().nonnegative().max(3600).optional(),
    batchSize: z.number().int().min(1).max(100).optional(),
    costLabel: z.string().max(200).optional()
}).strict();
export const automationRoleImageSchema = z.object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(500),
    assetRef: automationRoleSourceRefSchema,
    slot: z.enum(['fullBody', 'faceCloseup', 'expressionGrid', 'presentationBoard']).optional()
}).strict();
const providerModelConfigSchema = z.object({
    id: z.string().trim().min(1).max(200),
    usage: z.array(z.enum(['text', 'image', 'video', 'audio'])).min(1).max(1),
    enabled: z.boolean().optional(),
    alias: z.string().trim().min(1).max(200).optional(),
    // Model-level parameter mapping. The MCP tools have always advertised these fields, so the
    // transport schema must accept them too; otherwise an Agent-written mapping is rejected before
    // any request is sent and the model is left without a usable parameter contract.
    imagePresetId: z.string().max(100).optional(),
    imageRequestEncoding: z.record(z.string(), z.unknown()).optional(),
    videoRequestEncoding: z.record(z.string(), z.unknown()).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    imageTransport: z.enum([
        'openai-images', 'json-image-edits', 'grok2api-images',
        'generation-reference-images', 'generation-image-urls',
        'generation-images-array', 'generation-input-image'
    ]).optional(),
}).strict();
const providerAutomationConfigSchema = z.object({
    providerId: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(200),
    baseUrl: z.string().trim().url().max(2048),
    docsUrl: z.string().trim().url().max(2048).optional(),
    providerProfile: z.enum(['openai-standard', 'grok2api']).optional(),
    authMode: z.enum(['bearer', 'x-api-key', 'api-key', 'none']).optional(),
    textProtocol: z.enum(['chat-completions', 'responses']).optional(),
    imageTransport: z.enum([
        'openai-images', 'json-image-edits', 'grok2api-images',
        'generation-reference-images', 'generation-image-urls',
        'generation-images-array', 'generation-input-image'
    ]).optional(),
    models: z.array(providerModelConfigSchema).max(500).optional(),
    generationEndpoints: z.record(z.string(), z.unknown()).optional(),
    mediaContracts: z.record(z.string(), z.unknown()).optional(),
}).strict();
export const automationRoleInputSchema = z.object({
    id: z.string().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(5000).default(''),
    tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
    images: z.array(automationRoleImageSchema).max(4).default([]),
    updatedAt: z.string().datetime().optional()
}).strict();
export const automationRolePatchSchema = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    tags: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
    images: z.array(automationRoleImageSchema).max(4).optional(),
    updatedAt: z.string().datetime().optional()
}).strict();
export const automationCommandPayloadSchemas = {
    'system.status': emptyPayloadSchema,
    'canvas.snapshot': emptyPayloadSchema,
    'node.list': z.object({ kinds: z.array(automationNodeKindSchema).min(1).optional() }).strict(),
    'node.get': nodeIdPayloadSchema,
    'node.create': z.object({
        kind: automationNodeKindSchema,
        position: automationPointSchema,
        title: z.string().trim().min(1).max(200).optional(),
        data: automationNodeDataPatchSchema.optional()
    }).strict(),
    'node.update': z.object({
        nodeId: z.string().min(1),
        patch: automationNodeDataPatchSchema
    }).strict(),
    'node.move': z.object({
        items: z.array(z.object({
            nodeId: z.string().min(1),
            position: automationPointSchema
        }).strict()).min(1).max(1000)
    }).strict(),
    'node.resize': z.object({
        nodeId: z.string().min(1),
        width: z.number().finite().min(80).max(10000),
        height: z.number().finite().min(60).max(10000)
    }).strict(),
    'node.delete': z.object({
        nodeIds: z.array(z.string().min(1)).min(1).max(1000)
    }).strict(),
    'asset.create': z.object({
        position: automationPointSchema,
        fileName: z.string().min(1).max(500),
        assetRef: automationAssetRefSchema,
        kind: z.enum(['image', 'video', 'audio']),
        sourceLabel: z.string().min(1).max(200).default('CLI 导入')
    }).strict(),
    'edge.list': emptyPayloadSchema,
    'edge.connect': z.object({
        sourceNodeId: z.string().min(1),
        targetNodeId: z.string().min(1)
    }).strict(),
    'edge.disconnect': z.object({
        edgeIds: z.array(z.string().min(1)).min(1).max(1000)
    }).strict(),
    'generation.submit': z.object({
        nodeId: z.string().min(1),
        providerId: z.string().min(1).max(100),
        accountId: z.string().min(1).max(200).optional()
    }).strict(),
    'provider.list': emptyPayloadSchema,
    'provider.validateConfig': z.object({ config: providerAutomationConfigSchema }).strict(),
    'provider.create': providerAutomationConfigSchema,
    'provider.models': z.object({ providerId: z.string().min(1).max(100) }).strict(),
    'provider.accounts': z.object({ providerId: z.enum(['doubao', 'dola', 'xyq']) }).strict(),
    'provider.capabilities': z.object({
        providerId: z.string().min(1).max(100),
        kind: z.enum(['image', 'video']),
        model: z.string().min(1).max(200).optional()
    }).strict(),
    'project.list': emptyPayloadSchema,
    'project.create': z.object({ name: z.string().min(1).max(200) }).strict(),
    'project.switch': z.object({ projectId: z.string().min(1) }).strict(),
    'project.rename': z.object({ projectId: z.string().min(1), name: z.string().min(1).max(200) }).strict(),
    'project.delete': z.object({ projectId: z.string().min(1) }).strict(),
    'project.import': z.object({ data: projectDataSchema }).strict(),
    'project.export': z.object({ projectId: z.string().min(1).optional() }).strict(),
    'canvas.list': emptyPayloadSchema,
    'canvas.create': z.object({ name: z.string().min(1).max(200) }).strict(),
    'canvas.switch': z.object({ canvasId: z.string().min(1) }).strict(),
    'canvas.rename': z.object({ canvasId: z.string().min(1), name: z.string().min(1).max(200) }).strict(),
    'canvas.delete': z.object({ canvasId: z.string().min(1) }).strict(),
    'canvas.import': z.object({ canvas: canvasRecordSchema }).strict(),
    'canvas.export': z.object({ canvasId: z.string().min(1).optional() }).strict(),
    'history.search': z.object({
        query: z.string().max(500).optional(),
        kinds: z.array(z.enum(['image', 'video', 'audio'])).min(1).optional(),
        providerId: z.string().max(100).optional(),
        model: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(500).default(100)
    }).strict(),
    'history.use': z.object({ assetId: z.string().min(1), position: automationPointSchema }).strict(),
    'history.update': z.object({
        assetId: z.string().min(1),
        patch: z.object({
            name: z.string().trim().min(1).max(500).optional(),
            source: z.string().trim().min(1).max(500).optional(),
            metadata: automationHistoryMetadataSchema.optional()
        }).strict()
    }).strict(),
    'history.delete': z.object({ assetIds: z.array(z.string().min(1)).min(1).max(500) }).strict(),
    'history.download': z.object({ assetIds: z.array(z.string().min(1)).min(1).max(100) }).strict(),
    'role.list': z.object({
        query: z.string().max(500).optional(),
        tags: z.array(z.string().min(1).max(100)).max(100).optional()
    }).strict(),
    'role.create': automationRoleInputSchema,
    'role.update': z.object({
        roleId: z.string().min(1),
        patch: automationRolePatchSchema
    }).strict(),
    'role.delete': z.object({ roleIds: z.array(z.string().min(1)).min(1).max(100) }).strict(),
    'role.use': z.object({ roleId: z.string().min(1), position: automationPointSchema }).strict(),
    'generation.status': nodeIdPayloadSchema,
    'generation.wait': z.object({
        nodeId: z.string().min(1),
        timeoutSeconds: z.number().int().min(1).max(120).default(30),
        pollIntervalMs: z.number().int().min(250).max(5000).default(1000)
    }).strict(),
    'generation.cancel': z.object({
        nodeId: z.string().min(1),
        providerId: z.string().min(1).max(100)
    }).strict(),
    'generation.retry': z.object({
        nodeId: z.string().min(1),
        providerId: z.string().min(1).max(100),
        accountId: z.string().min(1).max(200).optional()
    }).strict(),
    'generation.useResult': z.object({ nodeId: z.string().min(1), position: automationPointSchema.optional() }).strict(),
    'asset.download': z.object({ nodeId: z.string().min(1) }).strict(),
    'asset.downloadMany': z.object({ nodeIds: z.array(z.string().min(1)).min(1).max(100) }).strict(),
    'account.assign': z.object({
        providerId: z.enum(['doubao', 'dola', 'xyq']),
        nodeIds: z.array(z.string().min(1)).min(1).max(100),
        preferredAccountIds: z.array(z.string().min(1).max(200)).max(100).optional()
    }).strict()
};
const commandEnvelopeBase = {
    protocolVersion: z.literal(AUTOMATION_PROTOCOL_VERSION),
    commandId: z.string().uuid(),
    sessionId: z.string().min(1),
    projectId: z.string().min(1),
    canvasId: z.string().min(1),
    expectedGraphRevision: z.number().int().nonnegative().optional(),
    issuedAt: z.string().datetime().optional()
};
const automationCommandEnvelopeVariants = automationCommandTypes.map((type) => z.object({
    ...commandEnvelopeBase,
    type: z.literal(type),
    payload: automationCommandPayloadSchemas[type]
}).strict());
const automationCommandEnvelopeParser = z.discriminatedUnion('type', automationCommandEnvelopeVariants);
export const automationCommandEnvelopeSchema = automationCommandEnvelopeParser;
const defineCommand = (type, risk, description, timeoutMs = 15000) => ({ type, risk, description, timeoutMs, idempotent: true });
export const automationCommandDefinitions = {
    'system.status': defineCommand('system.status', 'read', '读取自动化服务与活动画布状态'),
    'canvas.snapshot': defineCommand('canvas.snapshot', 'read', '读取活动画布快照摘要'),
    'node.list': defineCommand('node.list', 'read', '列出活动画布节点'),
    'node.get': defineCommand('node.get', 'read', '读取单个节点详情'),
    'node.create': defineCommand('node.create', 'reversible', '创建画布节点'),
    'node.update': defineCommand('node.update', 'reversible', '更新节点业务字段'),
    'node.move': defineCommand('node.move', 'reversible', '批量移动节点'),
    'node.resize': defineCommand('node.resize', 'reversible', '调整节点尺寸'),
    'node.delete': defineCommand('node.delete', 'destructive', '删除节点及关联连线'),
    'asset.create': defineCommand('asset.create', 'reversible', '创建已上传的参考资产节点'),
    'edge.list': defineCommand('edge.list', 'read', '列出活动画布连线'),
    'edge.connect': defineCommand('edge.connect', 'reversible', '创建合法连线'),
    'edge.disconnect': defineCommand('edge.disconnect', 'reversible', '断开指定连线'),
    'generation.submit': defineCommand('generation.submit', 'cost', '确认后提交节点生成任务', 45000),
    'provider.list': defineCommand('provider.list', 'read', '列出已配置提供商，不返回凭证'),
    'provider.validateConfig': defineCommand('provider.validateConfig', 'read', '校验 Agent 生成的供应商配置，不写入本地设置'),
    'provider.create': defineCommand('provider.create', 'reversible', '创建或更新供应商配置；不接收 API Key'),
    'provider.models': defineCommand('provider.models', 'read', '读取提供商模型'),
    'provider.accounts': defineCommand('provider.accounts', 'read', '读取网关账号状态'),
    'provider.capabilities': defineCommand('provider.capabilities', 'read', '读取模型参数能力'),
    'project.list': defineCommand('project.list', 'read', '列出项目和活动项目'),
    'project.create': defineCommand('project.create', 'reversible', '创建项目'),
    'project.switch': defineCommand('project.switch', 'reversible', '切换活动项目'),
    'project.rename': defineCommand('project.rename', 'reversible', '重命名项目'),
    'project.delete': defineCommand('project.delete', 'destructive', '删除项目'),
    'project.import': defineCommand('project.import', 'external', '导入项目数据'),
    'project.export': defineCommand('project.export', 'read', '导出项目数据'),
    'canvas.list': defineCommand('canvas.list', 'read', '列出当前项目画布'),
    'canvas.create': defineCommand('canvas.create', 'reversible', '创建画布'),
    'canvas.switch': defineCommand('canvas.switch', 'reversible', '切换活动画布'),
    'canvas.rename': defineCommand('canvas.rename', 'reversible', '重命名画布'),
    'canvas.delete': defineCommand('canvas.delete', 'destructive', '删除画布'),
    'canvas.import': defineCommand('canvas.import', 'external', '导入画布数据'),
    'canvas.export': defineCommand('canvas.export', 'read', '导出画布数据'),
    'history.search': defineCommand('history.search', 'read', '搜索历史资产'),
    'history.use': defineCommand('history.use', 'reversible', '将历史资产作为参考节点加入画布'),
    'history.update': defineCommand('history.update', 'reversible', '更新历史资产公开元数据'),
    'history.delete': defineCommand('history.delete', 'destructive', '删除历史资产及本地缓存文件'),
    'history.download': defineCommand('history.download', 'read', '读取历史资产下载描述'),
    'role.list': defineCommand('role.list', 'read', '读取和搜索角色库'),
    'role.create': defineCommand('role.create', 'reversible', '创建角色库角色'),
    'role.update': defineCommand('role.update', 'reversible', '编辑角色库角色'),
    'role.delete': defineCommand('role.delete', 'destructive', '删除角色库角色'),
    'role.use': defineCommand('role.use', 'reversible', '将角色图片作为参考节点加入画布'),
    'generation.status': defineCommand('generation.status', 'read', '读取生成节点当前任务状态'),
    'generation.wait': defineCommand('generation.wait', 'read', '等待生成节点进入终态', 125000),
    'generation.cancel': defineCommand('generation.cancel', 'destructive', '取消提供商生成任务', 30000),
    'generation.retry': defineCommand('generation.retry', 'cost', '确认后重试生成任务', 45000),
    'generation.useResult': defineCommand('generation.useResult', 'reversible', '将生成结果作为下游参考节点使用'),
    'asset.download': defineCommand('asset.download', 'read', '读取节点资产下载描述'),
    'asset.downloadMany': defineCommand('asset.downloadMany', 'read', '读取多个节点资产下载描述'),
    'account.assign': defineCommand('account.assign', 'reversible', '为生成节点连接独立账号节点并分配空闲账号')
};
export const automationCommandRecordStatuses = [
    'received',
    'validating',
    'waiting_client',
    'waiting_approval',
    'running',
    'completed',
    'failed',
    'rejected',
    'cancelled',
    'expired'
];
export const automationResultStatuses = [
    'completed',
    'waiting_approval',
    'validation_error',
    'connection_rejected',
    'version_conflict',
    'canvas_unavailable',
    'not_found',
    'failed',
    'rejected',
    'cancelled',
    'timeout'
];
export const parseAutomationCommandEnvelope = (value) => automationCommandEnvelopeSchema.safeParse(value);
export function isAutomationClientMessage(value) {
    if (!value || typeof value !== 'object')
        return false;
    return typeof value.type === 'string';
}
export function isAutomationServerMessage(value) {
    if (!value || typeof value !== 'object')
        return false;
    return typeof value.type === 'string';
}
