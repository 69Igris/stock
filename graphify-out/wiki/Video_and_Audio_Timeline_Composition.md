# Video and Audio Timeline Composition

> 23 nodes

## Key Concepts

- **compose.ts** (28 connections) — `packages/video-studio/src/editor/compose.ts`
- **composeTimeline()** (15 connections) — `packages/video-studio/src/editor/compose.ts`
- **veo.ts** (8 connections) — `packages/video-studio/src/render/veo.ts`
- **Scene** (7 connections) — `packages/video-studio/src/types.ts`
- **ffmpeg()** (7 connections) — `packages/video-studio/src/ffmpeg.ts`
- **stillToClip()** (5 connections) — `packages/video-studio/src/render/clips.ts`
- **generateVeoClip()** (5 connections) — `packages/video-studio/src/render/veo.ts`
- **cli.ts** (5 connections) — `packages/video-studio/src/cli.ts`
- **ffmpeg.ts** (5 connections) — `packages/video-studio/src/ffmpeg.ts`
- **buildAudio()** (4 connections) — `packages/video-studio/src/editor/compose.ts`
- **cachedVeoClip()** (4 connections) — `packages/video-studio/src/editor/compose.ts`
- **closeBrowser()** (4 connections) — `packages/video-studio/src/render/clips.ts`
- **mediaToClip()** (4 connections) — `packages/video-studio/src/render/clips.ts`
- **veoDurationSeconds()** (4 connections) — `packages/video-studio/src/render/veo.ts`
- **resolveMusic()** (3 connections) — `packages/video-studio/src/sound/music.ts`
- **slug()** (2 connections) — `packages/video-studio/src/editor/compose.ts`
- **motionVf()** (2 connections) — `packages/video-studio/src/render/clips.ts`
- **music.ts** (2 connections) — `packages/video-studio/src/sound/music.ts`
- **AudioSeg** (1 connections) — `packages/video-studio/src/editor/compose.ts`
- **escapeDrawtext()** (1 connections) — `packages/video-studio/src/ffmpeg.ts`
- **ffprobeDuration()** (1 connections) — `packages/video-studio/src/ffmpeg.ts`
- **tl** (1 connections) — `packages/video-studio/src/cli.ts`
- **NOTE: Veo's API surface + model ids evolve. Verify `VEO_MODEL` and the method** (1 connections) — `packages/video-studio/src/render/veo.ts`

## Relationships

- [Video Timeline Generation](Video_Timeline_Generation.md) (15 shared connections)
- [Video Scene Rendering](Video_Scene_Rendering.md) (14 shared connections)
- [Text-to-Speech Synthesis](Text-to-Speech_Synthesis.md) (3 shared connections)
- [Video Studio Render Processing](Video_Studio_Render_Processing.md) (3 shared connections)

## Source Files

- `packages/video-studio/src/cli.ts`
- `packages/video-studio/src/editor/compose.ts`
- `packages/video-studio/src/ffmpeg.ts`
- `packages/video-studio/src/render/clips.ts`
- `packages/video-studio/src/render/veo.ts`
- `packages/video-studio/src/sound/music.ts`
- `packages/video-studio/src/types.ts`

## Audit Trail

- EXTRACTED: 77 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*