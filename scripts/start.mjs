import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

process.env.PORT ??= "4080";
process.env.MK_SERVER_HOST ??= "127.0.0.1";
process.env.MK_WEB_DIST_DIR ??= join(root, "web");
process.env.MK_DATA_DIR ??= join(root, "data");
process.env.MK_UPLOADS_DIR ??= join(root, "uploads");

const ffmpegCandidates = [
  join(root, "runtime", "ffmpeg", "bin"),
  join(root, "ffmpeg-9.0.1-essentials_build", "bin"),
];
const ffmpegBin = ffmpegCandidates.find((candidate) => existsSync(join(candidate, "ffmpeg.exe")));
if (ffmpegBin) {
  process.env.MK_FFMPEG_PATH ??= join(ffmpegBin, "ffmpeg.exe");
  process.env.MK_FFPROBE_PATH ??= join(ffmpegBin, "ffprobe.exe");
}

await import(pathToFileURL(join(root, "server", "dist", "index.js")).href);
