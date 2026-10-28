# Content Studio (Image + Reel generation)

AI content + video generation built into `apps/content`. Two surfaces:

- **🖼️ Image Studio** — `gemini-3-pro-image-preview` ("Nano Banana Pro") → on-brand, SEBI-safe images saved to GCS. **Synchronous** (a route; images return in seconds).
- **🎬 Reel Studio** — a UI over the `@usemoney/video-studio` Timeline DSL: edit by prompt or direct tools, then **render asynchronously** (Veo + voiceover + ffmpeg) in the Cloud Run worker.

> SEBI: education-only. Image prompts strip tickers/prices/returns/advice; reels carry per-scene disclaimers + product disclosure. Same guardrails as the rest of the sprint.

## Architecture

```
apps/content (Next.js)                         workers (Cloud Run)
  /studio/image ─POST /api/ai/generate-image──▶ Nano Banana Pro ─▶ GCS  (sync)
  /studio/reel  ─POST /api/studio/edit────────▶ video-studio ops/director (pure, sync)
                ─POST /api/studio/render───────▶ Pub/Sub topic studio-render
                                                      │
                                                      ▼
                                        /jobs/studio-render (Hono route)
                                          → processStudioRender()
                                          → video-studio composeTimeline (Veo+TTS+ffmpeg)
                                          → upload MP4 to GCS, write JobStatus to Redis
                ◀─GET /api/studio/status?jobId──  Redis JobStatus  (poll)
```

One Zod contract for both sides: `@usemoney/video-studio/jobs` (`RenderJob`, `JobStatus`, `RENDER_TOPIC`, `jobStatusKey`).

## What was built (this round)

| Path                                                | Purpose                                              | Status                            |
| --------------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| `app/api/ai/generate-image/nano-banana.ts`          | Prompt builder (brand+SEBI) + `generateBrandImage()` | ✅ built + unit-tested            |
| `app/api/ai/generate-image/route.ts`                | Real image gen → GCS (text suggestion fallback)      | ✅ wired                          |
| `__tests__/api/nano-banana.test.ts`                 | Prompt/guardrail tests (5 cases)                     | ✅ passing                        |
| `packages/video-studio/src/jobs.ts`                 | Shared `RenderJob` / `JobStatus` contract            | ✅ type-checked                   |
| `app/api/studio/edit/route.ts`                      | `apply_edits` + `edit_timeline` (offline-first)      | ✅ type-checked                   |
| `app/api/studio/render/route.ts`                    | Enqueue render job → Pub/Sub + Redis seed            | ✅ type-checked                   |
| `app/api/studio/status/route.ts`                    | Poll job status (user-scoped)                        | ✅ type-checked                   |
| `workers/src/processors/studio-render.ts`           | Render job → compose → GCS → status                  | ✅ type-checked                   |
| `workers/src/routes/studio-render.ts` (+ index reg) | Pub/Sub push handler                                 | ✅ type-checked                   |
| `app/(content)/studio/{,image,reel}/page.tsx`       | Studio UI (image + reel editor)                      | ✅ built (run to verify visually) |
| `workers/scripts/setup-pubsub.sh`                   | `studio-render` topic + push sub                     | ✅ added                          |

## Models (verify ids for your project/region)

- **Image:** `GEMINI_IMAGE_MODEL` (default `gemini-3-pro-image-preview`). Nano Banana Pro shipped on the **Gemini API** first — confirm Vertex availability or use a Gemini API key.
- **Video:** `VEO_MODEL` (default `veo-3.0-generate-001`; you've been on `veo-3.0-fast-generate-001`; `veo-3.1-generate-001` also exists).

## To run / deploy

1. **Install** the new workspace deps: `yarn install` (links `@usemoney/video-studio` + `@usemoney/storage` into `apps/content` and `workers`).
2. **Env — apps/content:** `GCP_PROJECT_ID` (+ Vertex SA) or `GOOGLE_GENAI_API_KEY`; `REDIS_URL`; `STUDIO_RENDER_TOPIC` (or `PUBSUB_ENV`); GCS bucket env (per `@usemoney/storage`). Pub/Sub publisher IAM for the app SA.
3. **Env — worker:** `VIDEO_STUDIO_OUT=/tmp/video-out`, `VEO_MODEL`, TTS voices, `MUSIC_DIR`, Vertex SA, `REDIS_URL`.
4. **Worker image** must include **ffmpeg** + a **Playwright Chromium** (add to the worker Dockerfile) and allow `*.googleapis.com` egress.
5. **Pub/Sub:** `./workers/scripts/setup-pubsub.sh <env>` (creates `studio-render-<env>` + push sub → `/jobs/studio-render`).
6. **Nav:** add Studio links to `apps/content/components/sidebar` (pages are already routable at `/studio`).

## Remaining work (suggested Linear tickets — MONEY)

- [ ] Worker Dockerfile: bundle ffmpeg + Playwright Chromium; set `VIDEO_STUDIO_OUT`, fonts, `MUSIC_DIR`.
- [ ] Sidebar nav entry + Studio in the app shell.
- [ ] GCS public/CDN config for `studio/images` + `studio/videos` (or signed URLs).
- [ ] Scene-frame previews in Reel Studio (worker `render_scene_frame` → PNG, or a preview job).
- [ ] Persist generations to a library (DB model) + attach to posts/calendar.
- [ ] Rate limiting + cost guardrails (Veo/4K image spend).
- [ ] Tests: route handlers (enqueue/status) + worker processor (mocked compose/upload).
