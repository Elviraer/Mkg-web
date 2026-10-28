import fs from 'node:fs';
const readRoleImage = (value, imageId) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const image = value;
    return image.id === imageId ? image : null;
};
export const createRoleAssetSourceResolver = ({ getRole, getAssetBlob, resolveLibraryAssetSource }) => (sourceUrl) => {
    let url;
    try {
        url = new URL(sourceUrl, 'http://mk.local');
    }
    catch {
        return null;
    }
    const match = url.pathname.match(/^\/api\/roles\/([^/]+)\/images\/([^/]+)\/file$/);
    if (!match)
        return null;
    let roleId;
    let imageId;
    try {
        roleId = decodeURIComponent(match[1]);
        imageId = decodeURIComponent(match[2]);
    }
    catch {
        return null;
    }
    const role = getRole(roleId);
    const images = [
        ...(Array.isArray(role?.images) ? role.images : []),
        ...(Array.isArray(role?.retiredImages) ? role.retiredImages : [])
    ];
    const image = images.map((value) => readRoleImage(value, imageId)).find(Boolean);
    if (!image)
        return null;
    if (typeof image.blobId === 'string' && image.blobId) {
        const blob = getAssetBlob(image.blobId);
        if (blob && fs.existsSync(blob.sourcePath) && fs.statSync(blob.sourcePath).isFile()) {
            return fs.realpathSync(blob.sourcePath);
        }
    }
    if (typeof image.libraryAssetId === 'string' && image.libraryAssetId) {
        return resolveLibraryAssetSource(`/api/library-assets/${encodeURIComponent(image.libraryAssetId)}/file`);
    }
    return null;
};
