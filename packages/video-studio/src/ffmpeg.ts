/** Thin ffmpeg/ffprobe wrappers (spawn the system binaries). */
import { spawn } from "node:child_process";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

export function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...args,
    ]);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`)),
    );
  });
}

export function ffprobeDuration(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", reject);
    p.on("close", () => {
      const n = parseFloat(out.trim());
      Number.isFinite(n)
        ? resolve(n)
        : reject(new Error(`ffprobe could not read duration of ${path}`));
    });
  });
}

/** Escape text for ffmpeg drawtext. */
export function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "’")
    .replace(/%/g, "\\%");
}
