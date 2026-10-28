const isRecord = (value) => (typeof value === 'object' && value !== null);
const readRecord = (value, key) => {
    if (!isRecord(value))
        return undefined;
    const field = value[key];
    return isRecord(field) ? field : undefined;
};
const readArray = (value, key) => {
    if (!isRecord(value))
        return [];
    const field = value[key];
    return Array.isArray(field) ? field : [];
};
const readString = (value, key) => {
    if (!isRecord(value))
        return undefined;
    const field = value[key];
    return typeof field === 'string' ? field : undefined;
};
const readBoolean = (value, key) => {
    if (!isRecord(value))
        return undefined;
    const field = value[key];
    return typeof field === 'boolean' ? field : undefined;
};
const readDisplayValue = (value) => {
    if (typeof value === 'number' || typeof value === 'string')
        return String(value);
    return undefined;
};
export const extractDoubaoAccounts = (data) => {
    return readArray(data, 'accounts')
        .map((account) => {
        const id = readString(account, 'id');
        if (!id)
            return null;
        const points = readDisplayValue(isRecord(account) ? account.points : undefined);
        const isActive = readString(account, 'status') === 'active';
        const isBusy = readBoolean(account, 'isBusy') === true;
        return {
            id,
            points: points ? `${points} PT` : '0 PT',
            active: isActive && !isBusy,
            status: isActive && !isBusy ? 'idle' : 'busy'
        };
    })
        .filter((account) => account !== null);
};
export const extractDolaAccounts = (data) => {
    return readArray(data, 'accounts')
        .map((account) => {
        const id = readString(account, 'id') ?? readString(account, 'accountId') ?? readString(account, 'account_id');
        if (!id)
            return null;
        const points = readDisplayValue(isRecord(account) ? account.points ?? account.dailyPoints ?? account.dailyPointLimit : undefined);
        const state = (readString(account, 'status') ?? '').toLowerCase();
        const isBusy = readBoolean(account, 'isBusy') === true || ['busy', 'processing', 'running'].includes(state);
        const isActive = state === 'active' || readBoolean(account, 'active') === true;
        return {
            id,
            points: points ? `${points} PT` : '按网关',
            active: isActive && !isBusy,
            status: isActive && !isBusy ? 'idle' : 'busy'
        };
    })
        .filter((account) => account !== null);
};
export const extractXyqAccounts = (data) => {
    const rawAccounts = readArray(data, 'data').length > 0 ? readArray(data, 'data') : readArray(data, 'accounts');
    return rawAccounts
        .map((account) => {
        const id = readString(account, 'account_id') ?? readString(account, 'id');
        if (!id)
            return null;
        const creditsSummary = readRecord(account, 'credits_summary');
        const totalAvailable = readDisplayValue(creditsSummary?.total_available);
        const health = readRecord(account, 'health');
        const schedulerState = readString(readRecord(account, 'scheduler_hint'), 'state')
            ?? readString(readRecord(readRecord(account, 'runtime'), 'scheduler_hint'), 'state');
        const runtimeIsolation = readRecord(readRecord(account, 'runtime'), 'isolation');
        const isIsolated = readBoolean(account, 'isolated') === true || readBoolean(runtimeIsolation, 'isolated') === true;
        const isAvailable = schedulerState === 'available' && !isIsolated;
        return {
            id,
            points: totalAvailable ? `${totalAvailable} PT` : (readBoolean(health, 'ok') === false ? 'Unhealthy' : 'Healthy'),
            active: isAvailable,
            status: isIsolated ? 'busy' : (schedulerState === 'available' ? 'idle' : 'busy')
        };
    })
        .filter((account) => account !== null);
};
