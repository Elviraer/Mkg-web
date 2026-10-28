export const isRecord = (value) => (typeof value === 'object' && value !== null);
export const readField = (value, key) => (isRecord(value) ? value[key] : undefined);
export const readString = (value, key) => {
    const field = readField(value, key);
    return typeof field === 'string' ? field : undefined;
};
export const readBoolean = (value, key) => {
    const field = readField(value, key);
    return typeof field === 'boolean' ? field : undefined;
};
export const readNumber = (value, key) => {
    const field = readField(value, key);
    if (typeof field === 'number' && Number.isFinite(field))
        return field;
    if (typeof field === 'string' && field.trim()) {
        const parsed = Number(field);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
};
export const readErrorMessage = (data, fallback) => {
    const error = readField(data, 'error');
    return readString(error, 'message') ?? readString(data, 'message') ?? (typeof error === 'string' ? error : fallback);
};
export const getErrorMessage = (err, fallback = '请求失败') => (err instanceof Error ? err.message : fallback);
