import fs from 'node:fs';
import path from 'node:path';
export const isLoopbackAddress = (value) => {
    if (!value)
        return false;
    const normalized = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
    return normalized === '::1' || normalized === '127.0.0.1';
};
export const isAuthorizedDesktopRequest = ({ configuredToken, requestToken, remoteAddress, }) => Boolean(configuredToken
    && requestToken
    && requestToken === configuredToken
    && isLoopbackAddress(remoteAddress));
export const writeDesktopReadyFile = (filePath, payload) => {
    const resolvedPath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const temporaryPath = `${resolvedPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(payload), 'utf8');
    fs.renameSync(temporaryPath, resolvedPath);
};
