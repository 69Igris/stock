/**
 * Deterministic timeline edits — the "direct edit tools".
 *
 * Pure functions, no LLM, no network: they run **offline** anywhere (your Mac,
 * the sandbox, CI). Each op selects a scene by id, 1-based index, or the keywords
 * "first" | "last" | "all", mutates a *clone* of the Timeline, and the result is
 * re-parsed through the Zod schema so `applyOps` always returns a valid Timeline
 * (or throws with a clear message).
 *
 * This is the substrate under both editors:
 *   - apply_edits / edit-cli structured ops  -> applyOps (here)         [offline]
 *   - edit_timeline natural language         -> parse.ts -> applyOps    [offline]
 *                                            -> Gemini fallback         [online]
 */
import { z } from "zod";
import {
  AspectRatio,
  BrandTheme,
  Motion,
  MusicSpec,
  Timeline,
  VoiceLang,
  Voiceover,
} from "../types.js";

/** How an op points at scene(s): id, 1-based index, or first/last/all. */
export const SceneRef = z.union([z.string(), z.number().int().positive()]);
export type SceneRef = z.infer<typeof SceneRef>;

export const EditOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_duration"),
    scene: SceneRef,
    seconds: z.number(),
  }),
  z.object({
    op: z.literal("add_duration"),
    scene: SceneRef,
    deltaSec: z.number(),
  }),
  z.object({
    op: z.literal("scale_duration"),
    factor: z.number().positive(),
    scene: SceneRef.optional(),
  }),
  z.object({ op: z.literal("remove_scene"), scene: SceneRef }),
  z.object({
    op: z.literal("move_scene"),
    scene: SceneRef,
    toIndex: z.number().int().positive(),
  }),
  z.object({
    op: z.literal("set_music"),
    track: z.string(),
    gainDb: z.number().optional(),
    duck: z.boolean().optional(),
  }),
  z.object({ op: z.literal("remove_music") }),
  z.object({
    op: z.literal("set_voiceover"),
    scene: SceneRef,
    text: z.string(),
    lang: VoiceLang.optional(),
  }),
  z.object({
    op: z.literal("set_voiceover_lang"),
    lang: VoiceLang,
    scene: SceneRef.optional(),
  }),
  z.object({ op: z.literal("remove_voiceover"), scene: SceneRef.optional() }),
  z.object({ op: z.literal("remove_audio") }), // music + all voiceover -> silent
  z.object({
    op: z.literal("set_captions"),
    enabled: z.boolean(),
    fromVoiceover: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("set_disclaimer"),
    value: z.boolean(),
    scene: SceneRef.optional(),
  }),
  z.object({
    op: z.literal("set_headline"),
    scene: SceneRef,
    text: z.string(),
  }),
  z.object({ op: z.literal("set_subtext"), scene: SceneRef, text: z.string() }),
  z.object({ op: z.literal("set_motion"), scene: SceneRef, motion: Motion }),
  z.object({ op: z.literal("set_aspect"), aspect: AspectRatio }),
  z.object({ op: z.literal("set_theme"), theme: BrandTheme }),
  z.object({ op: z.literal("set_title"), title: z.string() }),
]);
export type EditOp = z.infer<typeof EditOp>;

const DUR_MIN = 0.8;
const DUR_MAX = 60;
const clampDur = (n: number) =>
  Math.round(Math.min(DUR_MAX, Math.max(DUR_MIN, n)) * 100) / 100;

/** Resolve a SceneRef to 0-based indices. Throws if a named/indexed ref misses. */
export function resolveScenes(tl: Timeline, ref?: SceneRef): number[] {
  const all = tl.scenes.map((_, i) => i);
  if (ref === undefined || ref === "all") return all;
  if (typeof ref === "number") {
    const i = ref - 1; // 1-based
    if (i < 0 || i >= tl.scenes.length)
      throw new Error(
        `scene index ${ref} out of range (1..${tl.scenes.length})`,
      );
    return [i];
  }
  const key = ref.trim().toLowerCase();
  if (key === "first") return [0];
  if (key === "last") return [tl.scenes.length - 1];
  const byId = tl.scenes.findIndex((s) => s.id.toLowerCase() === key);
  if (byId >= 0) return [byId];
  const n = Number(key);
  if (Number.isInteger(n) && n >= 1 && n <= tl.scenes.length) return [n - 1];
  throw new Error(
    `no scene matches "${ref}" (ids: ${tl.scenes.map((s) => s.id).join(", ")})`,
  );
}

function applyOne(tl: Timeline, op: EditOp): void {
  switch (op.op) {
    case "set_duration":
      for (const i of resolveScenes(tl, op.scene))
        tl.scenes[i]!.durationSec = clampDur(op.seconds);
      break;
    case "add_duration":
      for (const i of resolveScenes(tl, op.scene))
        tl.scenes[i]!.durationSec = clampDur(
          tl.scenes[i]!.durationSec + op.deltaSec,
        );
      break;
    case "scale_duration":
      for (const i of resolveScenes(tl, op.scene))
        tl.scenes[i]!.durationSec = clampDur(
          tl.scenes[i]!.durationSec * op.factor,
        );
      break;
    case "remove_scene": {
      const [i] = resolveScenes(tl, op.scene);
      if (tl.scenes.length <= 1)
        throw new Error("cannot remove the only scene");
      tl.scenes.splice(i!, 1);
      break;
    }
    case "move_scene": {
      const [from] = resolveScenes(tl, op.scene);
      const [moved] = tl.scenes.splice(from!, 1);
      const to = Math.min(Math.max(op.toIndex - 1, 0), tl.scenes.length);
      tl.scenes.splice(to, 0, moved!);
      break;
    }
    case "set_music":
      tl.music = MusicSpec.parse({
        track: op.track,
        gainDb: op.gainDb ?? tl.music?.gainDb,
        duckUnderVoiceover: op.duck ?? tl.music?.duckUnderVoiceover,
      });
      break;
    case "remove_music":
      tl.music = undefined;
      break;
    case "set_voiceover":
      for (const i of resolveScenes(tl, op.scene)) {
        tl.scenes[i]!.voiceover = Voiceover.parse({
          text: op.text,
          lang: op.lang ?? tl.scenes[i]!.voiceover?.lang ?? "hi-IN",
        });
      }
      break;
    case "set_voiceover_lang":
      for (const i of resolveScenes(tl, op.scene)) {
        const vo = tl.scenes[i]!.voiceover;
        if (vo) vo.lang = op.lang;
      }
      break;
    case "remove_voiceover":
      for (const i of resolveScenes(tl, op.scene))
        tl.scenes[i]!.voiceover = undefined;
      break;
    case "remove_audio":
      tl.music = undefined;
      for (const s of tl.scenes) s.voiceover = undefined;
      break;
    case "set_captions":
      tl.captions = {
        enabled: op.enabled,
        fromVoiceover: op.fromVoiceover ?? tl.captions.fromVoiceover,
      };
      break;
    case "set_disclaimer":
      for (const i of resolveScenes(tl, op.scene))
        tl.scenes[i]!.disclaimer = op.value;
      break;
    case "set_headline":
      for (const i of resolveScenes(tl, op.scene))
        tl.scenes[i]!.headline = op.text;
      break;
    case "set_subtext":
      for (const i of resolveScenes(tl, op.scene))
        tl.scenes[i]!.subtext = op.text;
      break;
    case "set_motion":
      for (const i of resolveScenes(tl, op.scene))
        tl.scenes[i]!.motion = op.motion;
      break;
    case "set_aspect":
      tl.aspect = op.aspect;
      break;
    case "set_theme":
      tl.brandTheme = op.theme;
      break;
    case "set_title":
      tl.title = op.title;
      break;
    default: {
      const _exhaustive: never = op;
      throw new Error(`unknown op: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Apply structured edits in order and return a fresh, validated Timeline.
 * The input is never mutated.
 */
export function applyOps(input: Timeline, ops: EditOp[]): Timeline {
  const tl = Timeline.parse(structuredClone(input)); // detach + validate input
  for (const op of ops) applyOne(tl, EditOp.parse(op));
  return Timeline.parse(tl); // re-validate output
}
