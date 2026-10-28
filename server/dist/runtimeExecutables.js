import { spawnSync } from 'node:child_process';
/**
 * FFmpeg/FFprobe are an external prerequisite for every video/audio transform and for thumbnail
 * generation. Probing spawns a process, so callers must memoize the result instead of probing inside
 * a hot path such as `/health`, which the desktop and dev launchers poll every 100-250 ms.
 */
export const executableAvailable = (command) => {
    const result = spawnSync(command, ['-version'], { windowsHide: true, stdio: 'ignore' });
    return !result.error && result.status === 0;
};
export const probeRuntimeExecutableAvailability = (ffmpegPath, ffprobePath) => ({
    ffmpeg: executableAvailable(ffmpegPath),
    ffprobe: executableAvailable(ffprobePath),
    checkedAt: Date.now()
});
/**
 * Memoized availability with an explicit refresh. The Server never probes on a timer: a stale value
 * is only replaced when a user action asks for it (media tool "重新检测") or when a caller passes
 * `refresh`.
 */
export const createRuntimeExecutableAvailability = (ffmpegPath, ffprobePath) => {
    let cached = null;
    const read = (refresh = false) => {
        if (!cached || refresh)
            cached = probeRuntimeExecutableAvailability(ffmpegPath, ffprobePath);
        return cached;
    };
    return { read };
};
export const describeMissingRuntimeExecutables = ({ ffmpeg, ffprobe }) => {
    const missing = [ffmpeg ? null : 'FFmpeg', ffprobe ? null : 'FFprobe'].filter(Boolean);
    return missing.length > 0 ? missing.join(' 与 ') : '';
};
