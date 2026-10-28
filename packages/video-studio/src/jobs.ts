/**
 * Render job contract — shared by the enqueuer (apps/content) and the consumer
 * (workers). One Zod source of truth so the Pub/Sub message + the Redis status
 * record can't drift between the two sides.
 *
 *   app  → publish RenderJob to PubSub topic RENDER_TOPIC + seed JobStatus(queued) in Redis
 *   worker → run it (video-studio compose / Veo) → update JobStatus → upload to GCS
 *   app  → poll JobStatus by jobId (scoped to userId)
 */
import { z } from "zod";
import { AspectRatio, Timeline } from "./types.js";

export const RENDER_TOPIC = "studio-render";
/** Redis key for a job's status record. */
export const jobStatusKey = (jobId: string) => `studio:render:${jobId}`;

export const RenderJob = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("render-reel"),
    jobId: z.string(),
    userId: z.string(),
    timeline: Timeline,
    outName: z.string().optional(),
  }),
  z.object({
    type: z.literal("veo-clip"),
    jobId: z.string(),
    userId: z.string(),
    prompt: z.string(),
    aspect: AspectRatio.default("9:16"),
    durationSec: z.number().default(6),
    outName: z.string().optional(),
  }),
]);
export type RenderJob = z.infer<typeof RenderJob>;

export const JobState = z.enum(["queued", "running", "done", "error"]);
export type JobState = z.infer<typeof JobState>;

export const JobStatus = z.object({
  jobId: z.string(),
  userId: z.string(),
  type: z.string(),
  state: JobState,
  progress: z.number().min(0).max(100).default(0),
  message: z.string().optional(),
  resultUrl: z.string().optional(),
  updatedAt: z.string(),
});
export type JobStatus = z.infer<typeof JobStatus>;
