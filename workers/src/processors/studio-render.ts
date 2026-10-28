/**
 * Studio render processor — turns a RenderJob into an MP4 on GCS.
 *
 * Reuses the video-studio compose pipeline (motion graphics + Veo + TTS + ffmpeg)
 * and reports progress into Redis so apps/content can poll job status.
 *
 * Cloud Run note: the worker container MUST have **ffmpeg** and a **Playwright
 * Chromium** available, and Vertex creds + `*.googleapis.com` egress (for Veo +
 * TTS). Renders are written under VIDEO_STUDIO_OUT (default /tmp) then uploaded.
 */
import { readFile } from "node:fs/promises";
import Redis from "ioredis";
import { uploadFile } from "@usemoney/storage";
import { prisma } from "@usemoney/database";
import {
  type RenderJob,
  type JobState,
  type JobStatus,
  jobStatusKey,
} from "@usemoney/video-studio/jobs";
import { Timeline } from "@usemoney/video-studio/types";
import { composeTimeline } from "@usemoney/video-studio/editor/compose";
import { llmWorkflow } from "@usemoney/datadog/llmobs";

const STATUS_TTL_SEC = 60 * 60 * 24; // keep job status for a day

let redis: Redis | null = null;
function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
  return redis;
}

async function setStatus(
  job: RenderJob,
  state: JobState,
  progress: number,
  message?: string,
  resultUrl?: string,
): Promise<void> {
  const client = getRedis();
  if (!client) return;
  const status: JobStatus = {
    jobId: job.jobId,
    userId: job.userId,
    type: job.type,
    state,
    progress,
    message,
    resultUrl,
    updatedAt: new Date().toISOString(),
  };
  await client.set(
    jobStatusKey(job.jobId),
    JSON.stringify(status),
    "EX",
    STATUS_TTL_SEC,
  );
}

/**
 * Entry point for the `studio-render` job. The body lives in `runStudioRender`; this wrapper
 * exists only to tag every model call underneath it with
 * `ml_app: video` (MONEY-1380).
 *
 * Tagging here rather than at the call sites works because dd-trace resolves an
 * LLM span's `ml_app` from its nearest LLMObs parent, so calls several packages
 * deep inherit it without knowing this file exists.
 */
export async function processStudioRender(job: RenderJob): Promise<void> {
  return llmWorkflow("video", "studio-render", () => runStudioRender(job), {
    sessionId: job.jobId,
  });
}

async function runStudioRender(job: RenderJob): Promise<void> {
  try {
    await setStatus(job, "running", 10, "rendering");

    const timeline: Timeline =
      job.type === "render-reel"
        ? job.timeline
        : Timeline.parse({
            title: `veo-${job.jobId}`,
            aspect: job.aspect,
            scenes: [
              {
                id: "v",
                type: "veo",
                durationSec: job.durationSec,
                veoPrompt: job.prompt,
              },
            ],
          });

    const base = job.outName ?? job.jobId;
    const result = await composeTimeline(timeline, { outFile: `${base}.mp4` });

    await setStatus(job, "running", 80, "uploading");
    const buf = await readFile(result.path);
    const uploaded = await uploadFile({
      file: buf,
      fileName: `${base}.mp4`,
      contentType: "video/mp4",
      folder: `studio/videos/${job.userId}`,
      userId: job.userId,
      isPublic: true,
      metadata: { source: "studio-render", jobType: job.type },
    });

    // Persist to the Studio library (best-effort — don't fail the job on a DB hiccup).
    await prisma.studioGeneration
      .create({
        data: {
          userId: job.userId,
          kind: "reel",
          prompt: timeline.title,
          url: uploaded.url,
          model: process.env.VEO_MODEL ?? null,
          meta: { jobId: job.jobId, jobType: job.type },
        },
      })
      .catch(() => undefined);

    await setStatus(job, "done", 100, "done", uploaded.url);
  } catch (err) {
    await setStatus(
      job,
      "error",
      100,
      err instanceof Error ? err.message : "render failed",
    );
    throw err;
  }
}
