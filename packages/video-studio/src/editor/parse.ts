/**
 * Offline natural-language → structured edits.
 *
 * Covers the common, unambiguous commands ("make the hook 5 seconds", "swap the
 * music to corporate-lofi", "remove captions", "drop the last scene", "make it
 * silent") deterministically, with NO model call. The Timeline is passed in so
 * scene references ("the hook", "scene 3", "the b-roll") are resolved against the
 * real scene ids — an op is only emitted when its target actually exists.
 *
 * Returns matched ops plus any clauses it didn't understand. director.editTimeline
 * uses `unmatched` to decide whether to apply offline or hand the whole
 * instruction to Gemini (freeform / translation / creative edits).
 */
import type { Timeline } from "../types.js";
import type { EditOp, SceneRef } from "./ops.js";
import { resolveScenes } from "./ops.js";

export interface ParseResult {
  ops: EditOp[];
  unmatched: string[];
}

/** Resolve a free-text scene token to a valid SceneRef, or null if it misses. */
function refOf(tl: Timeline, tokenRaw: string): SceneRef | null {
  let t = tokenRaw
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/\s+scene$/, "");
  if (!t) return null;
  // Pin positional refs to a concrete id at parse time so they don't drift when
  // multiple edits are applied in sequence ("all" stays a multi-target keyword).
  if (t === "all") return "all";
  if (t === "first") return tl.scenes[0]?.id ?? null;
  if (t === "last") return tl.scenes[tl.scenes.length - 1]?.id ?? null;
  const mIdx = t.match(/^(?:scene\s+)?(\d+)$/);
  if (mIdx) {
    const n = Number(mIdx[1]);
    return n >= 1 && n <= tl.scenes.length ? n : null;
  }
  const typeAlias: Record<string, string> = {
    intro: "hook",
    opening: "hook",
    hook: "hook",
    cta: "cta",
    "call to action": "cta",
    ending: "cta",
    outro: "cta",
    closing: "cta",
    broll: "veo",
    "b-roll": "veo",
    "b roll": "veo",
  };
  const ty = typeAlias[t];
  if (ty) {
    const i = tl.scenes.findIndex(
      (s) => s.id.toLowerCase() === t || s.type === ty,
    );
    if (i >= 0) return tl.scenes[i]!.id;
  }
  const byId = tl.scenes.findIndex((s) => s.id.toLowerCase() === t);
  if (byId >= 0) return tl.scenes[byId]!.id;
  return null;
}

const ASPECT: Record<string, "9:16" | "1:1" | "16:9"> = {
  "9:16": "9:16",
  portrait: "9:16",
  "1:1": "1:1",
  square: "1:1",
  "16:9": "16:9",
  landscape: "16:9",
};

type Matcher = (c: string, tl: Timeline) => EditOp | null;

const MATCHERS: Matcher[] = [
  // --- audio (check before generic "remove X") ---
  (c) =>
    /\b(remove|strip|drop|no)\s+(all\s+)?audio\b/.test(c) ||
    /\bmake\s+it\s+silent\b/.test(c) ||
    /\bsilent\b/.test(c) ||
    /\bmute\b/.test(c)
      ? { op: "remove_audio" }
      : null,
  (c) =>
    /\b(remove|drop|kill|no|without)\s+(the\s+)?music\b/.test(c)
      ? { op: "remove_music" }
      : null,
  (c) => {
    const m = c.match(
      /\b(?:swap|change|set|use|replace|add)\s+(?:the\s+)?music\s+(?:to|with|for)\s+([\w-]+)/,
    );
    return m ? { op: "set_music", track: m[1]! } : null;
  },
  // --- captions ---
  (c) =>
    /\b(remove|turn\s*off|disable|hide|drop|no)\s+(the\s+)?captions?\b/.test(
      c,
    ) || /\bcaptions?\s+off\b/.test(c)
      ? { op: "set_captions", enabled: false }
      : null,
  (c) =>
    /\b(add|turn\s*on|enable|show)\s+(the\s+)?captions?\b/.test(c) ||
    /\bcaptions?\s+on\b/.test(c)
      ? { op: "set_captions", enabled: true }
      : null,
  // --- voiceover removal (NOT language switch — translation needs the model) ---
  (c, tl) => {
    const m = c.match(
      /\b(remove|drop|delete|no)\s+(the\s+)?(voice\s?over|narration|vo)\b(?:\s+(?:from|on)\s+(.+))?/,
    );
    if (!m) return null;
    if (m[4]) {
      const ref = refOf(tl, m[4]);
      return ref ? { op: "remove_voiceover", scene: ref } : null;
    }
    return { op: "remove_voiceover" };
  },
  // --- duration: set to N seconds ---
  (c, tl) => {
    const m = c.match(
      /\b(?:set|make)\s+(.+?)\s+(?:to\s+|=\s*|be\s+)?(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b/,
    );
    if (!m) return null;
    const ref = refOf(tl, m[1]!);
    return ref
      ? { op: "set_duration", scene: ref, seconds: Number(m[2]) }
      : null;
  },
  // --- duration: longer / shorter (optionally "by N seconds", default 1s) ---
  (c, tl) => {
    const m = c.match(
      /\bmake\s+(.+?)\s+(longer|shorter)(?:\s+by\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?)?/,
    );
    if (!m) return null;
    const ref = refOf(tl, m[1]!);
    if (!ref) return null;
    const amt = m[3] ? Number(m[3]) : 1;
    return {
      op: "add_duration",
      scene: ref,
      deltaSec: m[2] === "longer" ? amt : -amt,
    };
  },
  // --- disclaimer ---
  (c, tl) => {
    const m = c.match(
      /\b(add|put|show)\s+(?:a\s+|the\s+)?disclaimer\b(?:\s+(?:to|on)\s+(.+))?/,
    );
    if (!m) return null;
    if (m[2]) {
      const ref = refOf(tl, m[2]);
      return ref ? { op: "set_disclaimer", value: true, scene: ref } : null;
    }
    return { op: "set_disclaimer", value: true };
  },
  (c) =>
    /\b(remove|hide|drop)\s+(the\s+)?disclaimer\b/.test(c)
      ? { op: "set_disclaimer", value: false }
      : null,
  // --- aspect / theme / title ---
  (c) => {
    if (
      !/\b(aspect|format|make it|resize|switch to|convert to|vertical|square|landscape|portrait|9:16|1:1|16:9)\b/.test(
        c,
      )
    )
      return null;
    const m = c.match(/\b(9:16|1:1|16:9|portrait|square|landscape)\b/);
    return m ? { op: "set_aspect", aspect: ASPECT[m[1]!]! } : null;
  },
  (c) => {
    const m =
      c.match(/\b(cream|dark)\s+theme\b/) ||
      c.match(/\btheme\s+(?:to\s+)?(cream|dark)\b/);
    return m ? { op: "set_theme", theme: m[1] as "cream" | "dark" } : null;
  },
  // --- remove a scene (generic; runs after the specific removers above) ---
  (c, tl) => {
    const m = c.match(/\b(remove|delete|drop|cut)\s+(.+?)(?:\s+scene)?\s*$/);
    if (!m) return null;
    const ref = refOf(tl, m[2]!);
    return ref ? { op: "remove_scene", scene: ref } : null;
  },
];

/** Split an instruction into clauses on commas / semicolons / "and" / "then". */
function clauses(instruction: string): string[] {
  return instruction
    .split(/\s*[;,]\s*|\s+\band\b\s+|\s+\bthen\b\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseInstruction(
  instruction: string,
  tl: Timeline,
): ParseResult {
  const ops: EditOp[] = [];
  const unmatched: string[] = [];
  for (const clause of clauses(instruction)) {
    const lc = clause.toLowerCase();
    let hit: EditOp | null = null;
    for (const m of MATCHERS) {
      hit = m(lc, tl);
      if (hit) break;
    }
    if (hit) {
      // sanity: ensure any scene ref still resolves before committing
      try {
        if ("scene" in hit && hit.scene !== undefined)
          resolveScenes(tl, hit.scene);
        ops.push(hit);
      } catch {
        unmatched.push(clause);
      }
    } else {
      unmatched.push(clause);
    }
  }
  return { ops, unmatched };
}
