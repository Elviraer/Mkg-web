import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
const hashFile = (filePath) => new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
});
export const deduplicateUploadedFile = async (filePath, targetDir) => {
    const digest = await hashFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const fileName = `${digest}${extension}`;
    const targetPath = path.join(targetDir, fileName);
    if (path.resolve(filePath) === path.resolve(targetPath)) {
        return { fileName, filePath: targetPath, contentHash: digest, deduplicated: true };
    }
    const deduplicated = fs.existsSync(targetPath);
    if (deduplicated) {
        await fs.promises.rm(filePath, { force: true });
    }
    else {
        await fs.promises.rename(filePath, targetPath);
    }
    return { fileName, filePath: targetPath, contentHash: digest, deduplicated };
};
export const deduplicateUploadedVideo = (filePath, uploadsDir) => (deduplicateUploadedFile(filePath, uploadsDir));
