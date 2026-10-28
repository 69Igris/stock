#!/usr/bin/env node
/**
 * Video Studio MCP server (stdio). Tools: plan_video, edit_timeline, render_video,
 * render_scene_frame, generate_veo_clip, synthesize_voiceover, list_music.
 *
 * Run locally with your GCP creds (Veo + TTS need them). Wire into Claude/Cowork
 * via an mcpServers entry that runs:  node --import tsx src/index.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readdirSync, existsSync } from "node:fs";
import { z } from "zod";
import {
  AspectRatio,
  BrandTheme,
  Scene,
  Timeline,
  Voiceover,
} from "./types.js";
import { editTimeline, planVideo } from "./director.js";
import { applyOps, EditOp } from "./editor/ops.js";
import { composeTimeline } from "./editor/compose.js";
import { captureSceneFrame, closeBrowser } from "./render/clips.js";
import { generateVeoClip } from "./render/veo.js";
import { synthesizeVoiceover } from "./sound/tts.js";
import { join } from "node:path";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const json = (v: unknown) => ok(JSON.stringify(v, null, 2));

const server = new McpServer({ name: "video-studio", version: "0.1.0" });

server.registerTool(
  "plan_video",
  {
    description:
      "Turn a natural-language brief into an editable Timeline (the video plan). SEBI-safe by default. Returns Timeline JSON to refine, then pass to render_video.",
    inputSchema: {
      brief: z
        .string()
        .describe("Director's brief: topic, key beats, vibe, CTA."),
      aspect: AspectRatio.optional(),
      durationSec: z.number().optional(),
      theme: BrandTheme.optional(),
      title: z.string().optional(),
    },
  },
  async (a) => json(await planVideo(a.brief, a)),
);

server.registerTool(
  "edit_timeline",
  {
    description:
      "Apply a natural-language edit to a Timeline (e.g. 'make the hook 5s, swap music to corporate-lofi, remove captions, drop the last scene'). Offline-first: common structured edits apply deterministically with NO creds; freeform/creative/translation edits use Gemini if creds are present. Returns the updated Timeline.",
    inputSchema: { timeline: Timeline, instruction: z.string() },
  },
  async (a) => json(await editTimeline(a.timeline as Timeline, a.instruction)),
);

server.registerTool(
  "apply_edits",
  {
    description:
      "Apply structured, deterministic edits to a Timeline (the direct edit tools) — NO model, NO creds, runs offline. ops: set_duration|add_duration|scale_duration|remove_scene|move_scene|set_music|remove_music|set_voiceover|set_voiceover_lang|remove_voiceover|remove_audio|set_captions|set_disclaimer|set_headline|set_subtext|set_motion|set_aspect|set_theme|set_title. Scenes are addressed by id, 1-based index, or 'first'|'last'|'all'. Returns the updated Timeline.",
    inputSchema: { timeline: Timeline, edits: z.array(EditOp) },
  },
  async (a) => json(applyOps(a.timeline as Timeline, a.edits as EditOp[])),
);

server.registerTool(
  "render_video",
  {
    description:
      "Render a Timeline to a finished MP4 (scenes → clips → concat → voice+music → captions → mux). Veo/TTS scenes require GCP creds.",
    inputSchema: { timeline: Timeline, outFile: z.string().optional() },
  },
  async (a) => {
    const r = await composeTimeline(a.timeline as Timeline, {
      outFile: a.outFile,
    });
    return json(r);
  },
);

server.registerTool(
  "render_scene_frame",
  {
    description:
      "Render a single scene to a still PNG (fast brand-exact preview, no video).",
    inputSchema: {
      scene: Scene,
      aspect: AspectRatio.default("9:16"),
      theme: BrandTheme.default("cream"),
      outPath: z.string(),
    },
  },
  async (a) => {
    const tl = Timeline.parse({
      title: "preview",
      aspect: a.aspect,
      brandTheme: a.theme,
      scenes: [a.scene],
    });
    await captureSceneFrame(a.scene as Scene, tl, a.outPath);
    await closeBrowser();
    return ok(`Wrote ${a.outPath}`);
  },
);

server.registerTool(
  "generate_veo_clip",
  {
    description:
      "Generate an AI B-roll clip with Veo (Vertex). Use for abstract/illustrative shots only — never for advice-adjacent 'presenters'. Requires GCP creds.",
    inputSchema: {
      prompt: z.string(),
      aspect: AspectRatio.default("9:16"),
      durationSec: z.number().default(6),
      outPath: z.string(),
    },
  },
  async (a) => {
    const tl = Timeline.parse({
      title: "veo",
      aspect: a.aspect,
      scenes: [
        {
          id: "v",
          type: "veo",
          durationSec: a.durationSec,
          veoPrompt: a.prompt,
        },
      ],
    });
    await generateVeoClip(tl.scenes[0]!, tl, a.outPath);
    return ok(`Wrote ${a.outPath}`);
  },
);

server.registerTool(
  "synthesize_voiceover",
  {
    description:
      "Synthesize a voiceover line with Google Cloud TTS (Hindi/English). Requires GCP creds.",
    inputSchema: {
      text: z.string(),
      lang: z.enum(["hi-IN", "en-IN", "en-US"]).default("hi-IN"),
      voice: z.string().optional(),
      outPath: z.string(),
    },
  },
  async (a) =>
    ok(
      `Wrote ${await synthesizeVoiceover(Voiceover.parse({ text: a.text, lang: a.lang, voice: a.voice }), a.outPath)}`,
    ),
);

server.registerTool(
  "list_music",
  {
    description: "List royalty-free music tracks available in MUSIC_DIR.",
    inputSchema: {},
  },
  async () => {
    const dir = process.env.MUSIC_DIR ?? "./assets/music";
    if (!existsSync(dir))
      return ok(
        `No MUSIC_DIR at ${dir}. Add licensed/royalty-free audio there.`,
      );
    const tracks = readdirSync(dir).filter((f) =>
      /\.(mp3|m4a|wav|aac|ogg)$/i.test(f),
    );
    return json({ dir, tracks });
  },
);

await server.connect(new StdioServerTransport());
console.error("[video-studio] MCP server ready (stdio).");
