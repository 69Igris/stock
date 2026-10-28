/**
 * The editor: turn a Timeline into a finished MP4.
 *  scenes → clips → caption overlay → concat → audio (TTS voice + ducked music) → mux.
 *
 * Captions are rendered as brand-styled PNGs (Playwright) and overlaid after motion,
 * so no libass is required and Devanagari (Hindi) shapes correctly. Graphics + concat
 * + music run anywhere (incl. sandbox). Veo + TTS need GCP creds.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { ffmpeg } from "../ffmpeg.js";
import {
  captionPng,
  captureSceneFrame,
  closeBrowser,
  mediaToClip,
  stillToClip,
} from "../render/clips.js";
import { generateVeoClip, veoDurationSeconds } from "../render/veo.js";
import { synthesizeVoiceover } from "../sound/tts.js";
import { resolveMusic } from "../sound/music.js";
import {
  DIMENSIONS,
  type RenderResult,
  type Scene,
  type Timeline,
} from "../types.js";

/**
 * Generate a Veo clip, content-addressed so re-rendering a timeline never
 * re-pays for the same prompt. Key = model|aspect|duration|prompt. Cache lives
 * under the output dir (git-ignored). Exported so callers can pre-warm it.
 */
export async function cachedVeoClip(
  scene: Scene,
  tl: Timeline,
  outDir: string,
): Promise<string> {
  const model = process.env.VEO_MODEL ?? "veo-3.0-generate-001";
  const dur = veoDurationSeconds(scene.durationSec);
  const key = createHash("sha1")
    .update([model, tl.aspect, dur, scene.veoPrompt ?? ""].join("|"))
    .digest("hex")
    .slice(0, 16);
  const cacheDir = join(outDir, ".veo-cache");
  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, `${key}.mp4`);
  if (!existsSync(cached)) await generateVeoClip(scene, tl, cached);
  return cached;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);

interface AudioSeg {
  path: string;
  offset: number;
}

export async function composeTimeline(
  tl: Timeline,
  opts: { outDir?: string; outFile?: string } = {},
): Promise<RenderResult> {
  const outDir = opts.outDir ?? process.env.VIDEO_STUDIO_OUT ?? "./.video-out";
  const { w, h } = DIMENSIONS[tl.aspect];
  const work = join(outDir, `work-${slug(tl.title)}-${Date.now()}`);
  mkdirSync(work, { recursive: true });

  const clips: string[] = [];
  const voices: AudioSeg[] = [];
  let t = 0;

  try {
    for (const [i, scene] of tl.scenes.entries()) {
      const pad = String(i).padStart(2, "0");
      let clip = join(work, `clip-${pad}.mp4`);
      if (scene.type === "veo") {
        const raw = await cachedVeoClip(scene, tl, outDir);
        await mediaToClip(raw, scene, tl, clip);
      } else if (scene.type === "screen" || scene.type === "talkinghead") {
        if (!scene.mediaPath)
          throw new Error(`scene ${scene.id} (${scene.type}) needs mediaPath`);
        await mediaToClip(scene.mediaPath, scene, tl, clip);
        if (scene.type === "talkinghead")
          voices.push({ path: scene.mediaPath, offset: t }); // keep native voice
      } else {
        const png = join(work, `frame-${i}.png`);
        await captureSceneFrame(scene, tl, png);
        await stillToClip(png, scene, tl, clip);
      }

      // Caption (= the scene's voiceover line) as a brand-styled overlay, composited
      // AFTER motion so it stays static + legible, and works for any scene type.
      if (scene.voiceover && tl.captions.enabled && tl.captions.fromVoiceover) {
        const cap = join(work, `cap-${pad}.png`);
        await captionPng(scene.voiceover.text, tl, cap);
        const capped = join(work, `clip-${pad}-cap.mp4`);
        await ffmpeg([
          "-i",
          clip,
          "-i",
          cap,
          "-filter_complex",
          "[0][1]overlay=0:0:format=auto",
          "-r",
          String(tl.fps),
          "-c:v",
          "libx264",
          "-preset",
          "medium",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          "-an",
          capped,
        ]);
        clip = capped;
      }
      clips.push(clip);

      if (scene.voiceover) {
        if (scene.voiceover.audioPath)
          voices.push({ path: scene.voiceover.audioPath, offset: t });
        else {
          const vo = join(work, `vo-${i}.mp3`);
          await synthesizeVoiceover(scene.voiceover, vo);
          voices.push({ path: vo, offset: t });
        }
      }
      t += scene.durationSec;
    }
  } finally {
    await closeBrowser();
  }
  const total = t;

  // 1) concat video (re-encode for safe, uniform output)
  const list = join(work, "list.txt");
  // The concat demuxer resolves each `file '...'` relative to the LIST file's
  // own directory, so paths must be absolute (otherwise the work dir doubles up).
  writeFileSync(
    list,
    clips.map((c) => `file '${resolve(c).replace(/'/g, "'\\''")}'`).join("\n"),
  );
  const video = join(work, "video.mp4");
  await ffmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-r",
    String(tl.fps),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    video,
  ]);

  // 2) audio (voice + ducked music)
  const audio = await buildAudio(tl, voices, total, work);

  // 3) mux video + audio (captions already overlaid per scene)
  const out = join(outDir, opts.outFile ?? `${slug(tl.title)}.mp4`);
  const args = ["-i", video];
  if (audio)
    args.push(
      "-i",
      audio,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
    );
  else args.push("-c:v", "copy");
  args.push(out);
  await ffmpeg(args);

  return {
    path: out,
    durationSec: total,
    width: w,
    height: h,
    note: `${clips.length} scenes${audio ? " + audio" : " (silent)"}`,
  };
}

async function buildAudio(
  tl: Timeline,
  voices: AudioSeg[],
  total: number,
  work: string,
): Promise<string | null> {
  const music = tl.music ? resolveMusic(tl.music.track) : null;
  if (voices.length === 0 && !music) return null;

  const inputs: string[] = [];
  const parts: string[] = [];
  const voiceLabels: string[] = [];
  voices.forEach((v, i) => {
    inputs.push("-i", v.path);
    const ms = Math.round(v.offset * 1000);
    parts.push(`[${i}:a]aresample=48000,adelay=${ms}|${ms}[v${i}]`);
    voiceLabels.push(`[v${i}]`);
  });

  let voiceOut: string | null = null;
  if (voiceLabels.length === 1) {
    parts.push(`${voiceLabels[0]}anull[voice]`);
    voiceOut = "[voice]";
  } else if (voiceLabels.length > 1) {
    parts.push(
      `${voiceLabels.join("")}amix=inputs=${voiceLabels.length}:duration=longest:normalize=0[voice]`,
    );
    voiceOut = "[voice]";
  }

  let final = "[voice]";
  if (music) {
    const mIdx = voices.length;
    inputs.push("-stream_loop", "-1", "-i", music);
    const gain = tl.music?.gainDb ?? -20;
    parts.push(`[${mIdx}:a]aresample=48000,volume=${gain}dB[mraw]`);
    if (voiceOut && (tl.music?.duckUnderVoiceover ?? true)) {
      parts.push(`[voice]asplit=2[vmain][vsc]`);
      parts.push(
        `[mraw][vsc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[mduck]`,
      );
      parts.push(
        `[vmain][mduck]amix=inputs=2:duration=longest:normalize=0[aout]`,
      );
      final = "[aout]";
    } else if (voiceOut) {
      parts.push(
        `[voice][mraw]amix=inputs=2:duration=longest:normalize=0[aout]`,
      );
      final = "[aout]";
    } else {
      parts.push(`[mraw]anull[aout]`);
      final = "[aout]";
    }
  } else {
    final = voiceOut ?? "[voice]";
  }

  const audioPath = join(work, "audio.m4a");
  await ffmpeg([
    ...inputs,
    "-filter_complex",
    parts.join(";"),
    "-map",
    final,
    "-t",
    String(total),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    audioPath,
  ]);
  return audioPath;
}
