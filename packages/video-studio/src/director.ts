/**
 * The director: turn a natural-language brief into a Timeline, and apply
 * prompt-based edits to an existing Timeline. Uses Gemini (Vertex) when creds
 * are present; otherwise falls back to a deterministic heuristic so the studio
 * still works offline (and in the sandbox).
 */
import { GoogleGenAI } from "@google/genai";
import {
  type AspectRatio,
  type BrandTheme,
  type Scene,
  Timeline,
} from "./types.js";
import { applyOps } from "./editor/ops.js";
import { parseInstruction } from "./editor/parse.js";

export interface PlanOpts {
  aspect?: AspectRatio;
  durationSec?: number;
  theme?: BrandTheme;
  title?: string;
}

const DSL_HELP = `Timeline JSON: { title, aspect(9:16|1:1|16:9), fps, brandTheme(cream|dark),
scenes:[{ id, type, durationSec, kicker?, headline?, subtext?, bullets?[], stat?{value,label,kicker},
data?[{label,value}], veoPrompt?, mediaPath?, motion(static|kenburns-in|kenburns-out|pan-left|pan-right|rise|pop),
transitionIn(cut|crossfade|slide|whippan|zoom), voiceover?{text,lang(hi-IN|en-IN),voice?}, disclaimer(bool) }],
music?{track,gainDb,duckUnderVoiceover}, captions{enabled,fromVoiceover}, watermark(bool) }.
Scene types: hook, point, cards, stat, quote, kinetic, dataviz, veo, screen, talkinghead, cta.
In headline/subtext use *word* for serif-italic accent and ==word== for a gold highlight.`;

export function heuristicTimeline(
  brief: string,
  opts: PlanOpts = {},
): Timeline {
  const flat = brief.replace(/\s+/g, " ").trim();
  const sentences = flat
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const title = opts.title ?? sentences[0]?.slice(0, 60) ?? "Untitled";
  const target = opts.durationSec ?? 30;
  const middles = sentences.slice(1, 7);
  const per = Math.max(2.2, Math.min(5.5, target / (2 + middles.length)));
  const scenes: Scene[] = [
    {
      id: "s0",
      type: "hook",
      durationSec: per,
      headline: sentences[0] ?? title,
      motion: "rise",
      transitionIn: "crossfade",
      disclaimer: false,
    },
    ...middles.map(
      (m, i): Scene => ({
        id: `s${i + 1}`,
        type: "point",
        durationSec: per,
        headline: m,
        motion: i % 2 ? "kenburns-in" : "rise",
        transitionIn: "crossfade",
        disclaimer: false,
      }),
    ),
    {
      id: "cta",
      type: "cta",
      durationSec: per,
      headline: "Awareness first. *Decisions later.*",
      subtext: "Follow for more",
      motion: "pop",
      transitionIn: "crossfade",
      disclaimer: false,
    },
  ];
  return Timeline.parse({
    title,
    aspect: opts.aspect ?? "9:16",
    fps: 30,
    brandTheme: opts.theme ?? "cream",
    scenes,
    captions: { enabled: true, fromVoiceover: true },
    watermark: true,
  });
}

async function gemini(): Promise<{ ai: GoogleGenAI; model: string } | null> {
  const project = process.env.GCP_PROJECT_ID;
  if (!project) return null;
  return {
    ai: new GoogleGenAI({
      vertexai: true,
      project,
      location: process.env.GCP_LOCATION ?? "us-central1",
    }),
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  };
}

export async function planVideo(
  brief: string,
  opts: PlanOpts = {},
): Promise<Timeline> {
  const g = await gemini();
  if (!g) return heuristicTimeline(brief, opts);
  try {
    const prompt = `You are a video director for UseMoney AI (Indian retail-investing, SEBI-safe: education only, no tips/calls/prices, add disclaimer:true on any finance scene, disclose the product when shown). Turn this brief into a Timeline.\n\n${DSL_HELP}\n\nConstraints: aspect=${opts.aspect ?? "9:16"}, ~${opts.durationSec ?? 30}s total, brandTheme=${opts.theme ?? "cream"}, keep headlines short, end with a cta scene. Output ONLY the JSON.\n\nBRIEF:\n${brief}`;
    const resp = await g.ai.models.generateContent({
      model: g.model,
      contents: prompt,
      config: { responseMimeType: "application/json", temperature: 0.6 },
    });
    const text = resp.text ?? "";
    return Timeline.parse(JSON.parse(text));
  } catch {
    return heuristicTimeline(brief, opts);
  }
}

/**
 * Apply a natural-language edit to a Timeline.
 *
 * Offline-first: deterministic structured edits (parse.ts → ops.ts) run with no
 * model or creds — so the common commands ("make the hook 5s", "swap the music
 * to corporate-lofi", "remove captions", "drop the last scene", "make it
 * silent") work anywhere. Anything not fully understood offline is handed to
 * Gemini (online) for freeform / creative / translation edits. With no creds
 * and an unparseable instruction, throws and points at `apply_edits`.
 */
export async function editTimeline(
  timeline: Timeline,
  instruction: string,
): Promise<Timeline> {
  // 1) Offline-first — apply only when EVERY clause was understood.
  const { ops, unmatched } = parseInstruction(instruction, timeline);
  if (ops.length > 0 && unmatched.length === 0) return applyOps(timeline, ops);

  // 2) Online — Gemini handles freeform / creative / translation edits.
  const g = await gemini();
  if (g) {
    const prompt = `Apply this edit to the Timeline JSON and return ONLY the full updated JSON. Keep it SEBI-safe.\n\n${DSL_HELP}\n\nEDIT: ${instruction}\n\nTIMELINE:\n${JSON.stringify(timeline)}`;
    const resp = await g.ai.models.generateContent({
      model: g.model,
      contents: prompt,
      config: { responseMimeType: "application/json", temperature: 0.3 },
    });
    return Timeline.parse(JSON.parse(resp.text ?? ""));
  }

  // 3) No creds and not fully parseable offline — be explicit, change nothing.
  const couldnt = unmatched.length
    ? `couldn't parse offline: "${unmatched.join('", "')}"`
    : "no recognizable edits";
  const understood = ops.length
    ? ` (understood ${ops.length} other edit(s))`
    : "";
  throw new Error(
    `editTimeline: ${couldnt}${understood}. Add GCP creds for freeform/translation edits, or use apply_edits with structured ops.`,
  );
}
