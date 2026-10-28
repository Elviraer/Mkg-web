const pathPattern = /^[a-z0-9_~!$&'()*+,;=:@%\-]+(?:\[\])?(?:\.[a-z0-9_~!$&'()*+,;=:@%\-]+(?:\[\])?)*$/i;
const fieldPaths = new Set([
    'prompt', 'model'
]);
const referenceShapes = new Set([
    'string', 'string-array', 'object-url', 'object-url-array',
    'multipart-single', 'multipart-array', 'omit'
]);
const mediaValueCasings = new Set(['preserve', 'lower', 'upper']);
const normalizePath = (value, options = {}) => {
    if (typeof value !== 'string')
        return undefined;
    const path = value.trim();
    if (!path || path.length > 160 || path.includes('..') || /[\\?#{}\u0000-\u001f]/.test(path))
        return undefined;
    if (!pathPattern.test(path))
        return undefined;
    if (!options.arrayPath && path.endsWith('[]'))
        return undefined;
    return path;
};
const normalizePathList = (value, required) => {
    if (!Array.isArray(value))
        return required ? undefined : [];
    const paths = Array.from(new Set(value.map((item) => normalizePath(item, { arrayPath: true })).filter((item) => Boolean(item)))).slice(0, 8);
    return required && paths.length === 0 ? undefined : paths;
};
export const normalizeProviderMediaGenerationContract = (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const source = value;
    if (source.requestFormat !== 'json' && source.requestFormat !== 'multipart')
        return undefined;
    if (typeof source.fields !== 'object' || source.fields === null || Array.isArray(source.fields))
        return undefined;
    const fields = {};
    for (const [key, raw] of Object.entries(source.fields)) {
        if (!fieldPaths.has(key))
            continue;
        const path = normalizePath(raw);
        if (path)
            fields[key] = path;
    }
    const valueTransforms = typeof source.valueTransforms === 'object' && source.valueTransforms !== null && !Array.isArray(source.valueTransforms)
        ? Object.fromEntries(Object.entries(source.valueTransforms).flatMap(([key, raw]) => {
            if (!fieldPaths.has(key) || typeof raw !== 'object' || raw === null || Array.isArray(raw))
                return [];
            const item = raw;
            const casing = mediaValueCasings.has(item.casing) ? item.casing : 'preserve';
            const valueMap = typeof item.valueMap === 'object' && item.valueMap !== null && !Array.isArray(item.valueMap)
                ? Object.fromEntries(Object.entries(item.valueMap).flatMap(([mapKey, mapValue]) => (typeof mapValue === 'string' && mapKey.length > 0 && mapKey.length <= 96 && mapValue.length <= 160
                    && !/[\u0000-\u001f]/.test(mapKey) && !/[\u0000-\u001f]/.test(mapValue)
                    ? [[mapKey.slice(0, 96), mapValue.slice(0, 160)]]
                    : [])).slice(0, 64))
                : undefined;
            if (casing === 'preserve' && (!valueMap || Object.keys(valueMap).length === 0))
                return [];
            return [[key, { ...(casing !== 'preserve' ? { casing } : {}), ...(valueMap && Object.keys(valueMap).length > 0 ? { valueMap } : {}) }]];
        }))
        : undefined;
    const rawReference = source.reference;
    let reference;
    if (rawReference !== undefined) {
        if (typeof rawReference !== 'object' || rawReference === null || Array.isArray(rawReference))
            return undefined;
        const ref = rawReference;
        const field = normalizePath(ref.field);
        const shape = ref.shape;
        const input = ref.input;
        if (!field || typeof shape !== 'string' || !referenceShapes.has(shape)
            || (input !== 'data-url' && input !== 'public-url' && input !== 'file-upload' && input !== 'auto'))
            return undefined;
        const maxCount = typeof ref.maxCount === 'number' && Number.isInteger(ref.maxCount) && ref.maxCount > 0
            ? Math.min(32, ref.maxCount)
            : undefined;
        reference = { field, shape: shape, input, ...(maxCount ? { maxCount } : {}) };
    }
    const references = typeof source.references === 'object' && source.references !== null && !Array.isArray(source.references)
        ? Object.fromEntries(Object.entries(source.references).flatMap(([kind, raw]) => {
            if (kind !== 'image' && kind !== 'video' && kind !== 'audio')
                return [];
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
                return [];
            const item = raw;
            const field = normalizePath(item.field);
            const shape = item.shape;
            const input = item.input;
            if (!field || typeof shape !== 'string' || !referenceShapes.has(shape)
                || (input !== 'data-url' && input !== 'public-url' && input !== 'file-upload' && input !== 'auto'))
                return [];
            const maxCount = typeof item.maxCount === 'number' && Number.isInteger(item.maxCount) && item.maxCount > 0 ? Math.min(32, item.maxCount) : undefined;
            return [[kind, { field, shape: shape, input, ...(maxCount ? { maxCount } : {}) }]];
        }))
        : undefined;
    if (!reference && !references && Object.keys(fields).length === 0)
        return undefined;
    const referenceEndpoint = source.referenceEndpoint === 'edit' || source.referenceEndpoint === 'submit'
        ? source.referenceEndpoint
        : undefined;
    if (source.response === undefined || typeof source.response !== 'object' || source.response === null || Array.isArray(source.response))
        return undefined;
    const response = source.response;
    const previewPaths = normalizePathList(response.previewPaths, true);
    if (!previewPaths)
        return undefined;
    const taskIdPath = normalizePath(response.taskIdPath);
    const statusPath = normalizePath(response.statusPath);
    const errorPaths = normalizePathList(response.errorPaths, false);
    const positionPath = normalizePath(response.positionPath);
    const statusMap = typeof response.statusMap === 'object' && response.statusMap !== null && !Array.isArray(response.statusMap)
        ? Object.fromEntries(Object.entries(response.statusMap).filter(([, value]) => (value === 'queued' || value === 'processing' || value === 'completed' || value === 'failed')))
        : undefined;
    return {
        requestFormat: source.requestFormat,
        fields,
        ...(valueTransforms && Object.keys(valueTransforms).length > 0 ? { valueTransforms } : {}),
        ...(reference ? { reference } : {}),
        ...(references ? { references } : {}),
        ...(referenceEndpoint ? { referenceEndpoint } : {}),
        response: {
            ...(taskIdPath ? { taskIdPath } : {}),
            ...(statusPath ? { statusPath } : {}),
            previewPaths,
            ...(errorPaths?.length ? { errorPaths } : {}),
            ...(positionPath ? { positionPath } : {}),
            ...(statusMap && Object.keys(statusMap).length > 0 ? { statusMap } : {})
        }
    };
};
export const normalizeProviderMediaGenerationContracts = (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const result = {};
    for (const kind of ['image', 'video', 'audio']) {
        const contract = normalizeProviderMediaGenerationContract(value[kind]);
        if (contract)
            result[kind] = contract;
    }
    return Object.keys(result).length > 0 ? result : undefined;
};
export const mediaContractFromLegacyEndpoint = (endpoints) => {
    if (!endpoints)
        return undefined;
    return undefined;
};
