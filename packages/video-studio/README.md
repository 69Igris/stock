# @usemoney/video-studio

A **prompt-driven video studio** as an MCP server. You give a brief; it directs a
"film crew" to produce a finished video — brand-exact **motion graphics**, **Veo**
AI B-roll, **Google TTS voiceover** and **music** — then an "editor" composes it
with ffmpeg. Built on the same `@google/genai` (Vertex) stack the repo uses.
SEBI-safe by design (education-only, disclaimers, product disclosure).

## The crew (how it maps to tools)

| Role        | Tool                                                                                        | Runs                                       |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 🎬 Director | `plan_video` (brief → Timeline), `edit_timeline` (prompt edits)                             | anywhere (Gemini if creds, else heuristic) |
| 🎥 Crew     | motion graphics (brand template), `generate_veo_clip`, screen/talking-head import, data-viz | graphics anywhere · **Veo needs GCP**      |
| 🎙️ Sound    | `synthesize_voiceover` (Google TTS Hindi/EN), `list_music`                                  | **needs GCP creds** (TTS)                  |
| ✂️ Editor   | `render_video` (compose: clips → caption overlay → concat → voice+ducked music → mux)       | needs ffmpeg                               |

Everything operates on **one JSON structure — the Timeline** (`src/types.ts`), so
"make scene 3 longer, swap the music, add a Hindi voiceover to the hook" are just
edits to that JSON.

> **Bilingual by design:** on-screen headlines stay **English** (the brand fonts —
> Inter / JetBrains Mono / Instrument Serif — are Latin-only); the **Hindi** lives in
> the voiceover audio + the captions. Captions are rendered as a **brand-styled PNG
> overlay** (Playwright) composited after motion — _not_ burned via libass — so
> Devanagari shapes correctly and no special ffmpeg build is required.

## Install

```bash
# system
brew install ffmpeg      # or: apt-get install -y ffmpeg
# package (from repo root)
yarn install
yarn workspace @usemoney/video-studio exec playwright install chromium
```

Copy `.env.example` → `.env` and set your **existing** Vertex SA creds
(`GOOGLE_APPLICATION_CREDENTIALS`, `GCP_PROJECT_ID`, `GCP_LOCATION`). Drop
royalty-free/licensed audio into `MUSIC_DIR` (e.g. `assets/music/corporate-lofi.mp3`).

Set **`VIDEO_STUDIO_OUT` to a path outside the repo** so finished videos never touch
git (the `work-*/` scratch dirs and the `.veo-cache/` also live under it). Quote the
value if it contains spaces — `run-mcp.sh` sources `.env`. Example:
`VIDEO_STUDIO_OUT="/Users/you/Documents/Claude/Projects/Content Strategy/Videos"`.

> ⚠️ **Verify `VEO_MODEL`** and TTS voice names for your project/region — Google's
> model ids and voices change over time. Veo + TTS only run where the SA creds +
> `*.googleapis.com` network exist (your machine / Cloud Run) — **not** inside a
> restricted sandbox.

## Use it

**As an MCP server** (Claude Desktop / Cowork — add to `mcpServers`):

```json
{
  "mcpServers": {
    "video-studio": {
      "command": "node",
      "args": ["--import", "tsx", "packages/video-studio/src/index.ts"],
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/abs/sa-key.json",
        "GCP_PROJECT_ID": "stock-book-483718",
        "GCP_LOCATION": "us-central1"
      }
    }
  }
}
```

Then: _"plan a 30s 9:16 Reel from this thesis… → render it with a Hindi voiceover and corporate-lofi music."_

**As a CLI:**

```bash
node --import tsx packages/video-studio/src/cli.ts my-timeline.json out.mp4
```

## Tools

- `plan_video(brief, aspect?, durationSec?, theme?)` → Timeline JSON
- `edit_timeline(timeline, instruction)` → updated Timeline (Mosaic-style prompt editing — **offline-first**, Gemini fallback)
- `apply_edits(timeline, edits[])` → updated Timeline (**structured, deterministic, no creds**)
- `render_video(timeline, outFile?)` → final MP4
- `render_scene_frame(scene, aspect, theme, outPath)` → still PNG preview
- `generate_veo_clip(prompt, aspect, durationSec, outPath)` → Veo MP4
- `synthesize_voiceover(text, lang, voice?, outPath)` → MP3
- `list_music()` → tracks in `MUSIC_DIR`

## Editing — online + offline

The editor works two ways, both over the single Timeline JSON:

- **Offline (no creds, deterministic) — the "direct edit tools".** Common
  structured edits run anywhere with no model call: change durations, swap/remove
  music, set/translate-target/remove voiceover, toggle captions, reorder/drop
  scenes, edit headline/subtext, toggle the disclaimer, change aspect/theme.
  Scenes are addressed by **id**, **1-based index**, or **`first` | `last` |
  `all`**. Use `apply_edits` (structured ops) or natural language that the
  offline parser understands.
- **Online (Gemini).** Anything the offline parser doesn't fully understand —
  freeform, creative, or **translation** ("rewrite the VO in English") — falls
  through to Gemini (needs GCP creds). `edit_timeline` tries offline first, then
  Gemini; with no creds and an unparseable instruction it errors instead of
  guessing.

```bash
# natural language (offline-first; Gemini fallback if creds present)
node --import tsx src/edit-cli.ts in.json "make the hook 5s, swap the music to corporate-lofi, remove captions, drop the last scene" out.json

# structured ops (always offline, deterministic)
echo '[{"op":"remove_audio"},{"op":"set_aspect","aspect":"1:1"}]' > edits.json
node --import tsx src/edit-cli.ts in.json --ops edits.json out.json
```

`apply_edits` op set: `set_duration · add_duration · scale_duration · remove_scene · move_scene · set_music · remove_music · set_voiceover · set_voiceover_lang · remove_voiceover · remove_audio · set_captions · set_disclaimer · set_headline · set_subtext · set_motion · set_aspect · set_theme · set_title`. Tests: `yarn workspace @usemoney/video-studio test`.

## The choreographer's language (Timeline DSL)

Scene types: `hook · point · cards · stat · quote · kinetic · dataviz · veo · screen · talkinghead · cta`.
Motion: `static · kenburns-in/out · pan-left/right · rise · pop`. Transitions: `cut · crossfade · slide · whippan · zoom`.
In text, `*word*` → serif-italic accent, `==word==` → gold highlight.

```json
{
  "title": "What do you actually own?",
  "aspect": "9:16",
  "fps": 30,
  "brandTheme": "cream",
  "music": {
    "track": "corporate-lofi",
    "gainDb": -20,
    "duckUnderVoiceover": true
  },
  "scenes": [
    {
      "id": "hook",
      "type": "hook",
      "durationSec": 3.5,
      "kicker": "Portfolio blindness",
      "headline": "What do you ==actually own==?",
      "motion": "rise",
      "voiceover": {
        "text": "Quick question — what do you actually own?",
        "lang": "hi-IN"
      }
    },
    {
      "id": "stat",
      "type": "stat",
      "durationSec": 3,
      "stat": {
        "kicker": "Total equity %",
        "value": "70–80%",
        "label": "Most people guess 50%."
      },
      "motion": "kenburns-in",
      "disclaimer": true
    },
    {
      "id": "broll",
      "type": "veo",
      "durationSec": 5,
      "veoPrompt": "abstract flowing data streams merging into one calm dashboard, cream + emerald palette, premium fintech"
    },
    {
      "id": "cta",
      "type": "cta",
      "durationSec": 3,
      "headline": "Awareness first. *Decisions later.*",
      "motion": "pop"
    }
  ]
}
```

## SEBI guardrails (baked in)

Education-only; no buy/sell/tips/targets; no live prices (≥3-month lag); disclaimer
text on finance scenes; product disclosure when shown. Use Veo for **abstract
B-roll only** — never AI "presenters" for advice-adjacent content; use your own
face/voice for those (talking-head import).

## Roadmap

True per-word kinetic typography (animated frame sequences), `xfade` scene
transitions, brand intro/outro stings, auto-caption styling presets, GCS upload
of finished videos via `@usemoney/storage`.
