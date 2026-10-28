import fs from 'node:fs';
import path from 'node:path';
export const sweepExpiredJobDirectories = (rootDir, maxAgeMs, now = Date.now()) => {
    if (!fs.existsSync(rootDir))
        return 0;
    let deleted = 0;
    fs.readdirSync(rootDir, { withFileTypes: true }).forEach((entry) => {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'preview-uploads')
            return;
        const directory = path.join(rootDir, entry.name);
        const modifiedAt = fs.statSync(directory).mtimeMs;
        if (now - modifiedAt < maxAgeMs)
            return;
        fs.rmSync(directory, { recursive: true, force: true });
        deleted += 1;
    });
    return deleted;
};
