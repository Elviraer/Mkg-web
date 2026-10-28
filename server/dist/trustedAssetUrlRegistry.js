export const createTrustedAssetUrlRegistry = ({ ttlMs = 60 * 60 * 1000, now = Date.now, } = {}) => {
    const entries = new Map();
    const normalizeUrl = (value) => {
        try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
        }
        catch {
            return null;
        }
    };
    const sweep = () => {
        const currentTime = now();
        for (const [url, entry] of entries) {
            if (entry.expiresAt <= currentTime)
                entries.delete(url);
        }
    };
    return {
        register(urls, policy) {
            sweep();
            const expiresAt = now() + ttlMs;
            urls.forEach((value) => {
                const url = normalizeUrl(value);
                if (!url)
                    return;
                const trustedOrigins = new Set(policy.trustedOrigins ?? []);
                trustedOrigins.add(new URL(url).origin);
                entries.set(url, {
                    expiresAt,
                    policy: { ...policy, trustedOrigins: [...trustedOrigins] }
                });
            });
        },
        resolve(value) {
            sweep();
            const url = normalizeUrl(value);
            return url ? entries.get(url)?.policy : undefined;
        },
        sweep,
    };
};
