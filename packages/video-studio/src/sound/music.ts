/** Resolve a music track key to a file in MUSIC_DIR (or accept an absolute path). */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function resolveMusic(track: string): string {
  if (isAbsolute(track) && existsSync(track)) return track;
  if (existsSync(track)) return track;
  const dir = process.env.MUSIC_DIR ?? "./assets/music";
  for (const ext of [".mp3", ".m4a", ".wav", ".aac", ".ogg"]) {
    const p = join(dir, `${track}${ext}`);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `Music track "${track}" not found. Add a file at ${join(dir, track)}.mp3 (use royalty-free / licensed audio you own).`,
  );
}
