const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
export const isAssetRef = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const input = value;
    if (input.owner === 'library' || input.owner === 'history')
        return nonEmpty(input.assetId);
    return input.owner === 'role' && nonEmpty(input.roleId) && nonEmpty(input.imageId);
};
/** Resolves one authoritative identity while old project snapshots are being migrated. */
export const readAuthoritativeAssetRef = (fields) => {
    if (isAssetRef(fields.assetRef))
        return fields.assetRef;
    if (nonEmpty(fields.roleId) && nonEmpty(fields.roleImageId)) {
        return { owner: 'role', roleId: fields.roleId, imageId: fields.roleImageId };
    }
    if (nonEmpty(fields.historyAssetId))
        return { owner: 'history', assetId: fields.historyAssetId };
    if (nonEmpty(fields.libraryAssetId))
        return { owner: 'library', assetId: fields.libraryAssetId };
    return undefined;
};
export const assetRefKey = (ref) => ref.owner === 'role'
    ? `role:${ref.roleId}:${ref.imageId}`
    : `${ref.owner}:${ref.assetId}`;
