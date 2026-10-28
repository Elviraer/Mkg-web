export const DIRECTOR_REMOTE_PROTOCOL_VERSION = 1;
export function isDirectorRemoteSignal(value) {
    if (!value || typeof value !== 'object')
        return false;
    return typeof value.type === 'string';
}
