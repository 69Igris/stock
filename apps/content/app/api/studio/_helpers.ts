/**
 * Studio API helpers — Redis job status + Pub/Sub enqueue.
 *
 * Enqueue side of the render pipeline: publish a RenderJob to the studio-render
 * topic and seed a `queued` JobStatus in Redis; the worker updates it and the
 * status route reads it back. Shares the Zod contract in @usemoney/video-studio/jobs.
 */
import Redis from "ioredis";
import { getPubSubClient } from "@usemoney/pubsub/client";
import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types/pubsub";
import {
  type RenderJob,
  type JobStatus,
  jobStatusKey,
} from "@usemoney/video-studio/jobs";

const STATUS_TTL_SEC = 60 * 60 * 24;

let redis: Redis | null = null;
export function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  redis = new Redis(url, { maxRetriesPerRequest: 3 });
  return redis;
}

/**
 * Topic name for the studio render pipeline.
 *
 * Resolves via the SHARED env-suffix logic (`getTopicName`) so an unset
 * PUBSUB_ENV falls back to `-qa` OUTSIDE production — matching every other
 * publisher and `workers/scripts/setup-pubsub.sh`. Previously this hand-built
 * `studio-render-${PUBSUB_ENV ?? "prod"}`, so a local/dev content run with
 * PUBSUB_ENV unset published render jobs to the PROD topic (MONEY-1062).
 * `STUDIO_RENDER_TOPIC` still overrides the whole name for ops / one-off use.
 */
export function renderTopic(): string {
  return (
    process.env.STUDIO_RENDER_TOPIC ?? getTopicName(PUBSUB_TOPICS.STUDIO_RENDER)
  );
}

export async function seedStatus(job: RenderJob): Promise<void> {
  const client = getRedis();
  if (!client) return;
  const status: JobStatus = {
    jobId: job.jobId,
    userId: job.userId,
    type: job.type,
    state: "queued",
    progress: 0,
    updatedAt: new Date().toISOString(),
  };
  await client.set(
    jobStatusKey(job.jobId),
    JSON.stringify(status),
    "EX",
    STATUS_TTL_SEC,
  );
}

export async function publishRenderJob(job: RenderJob): Promise<string> {
  const data = Buffer.from(JSON.stringify(job));
  return getPubSubClient().topic(renderTopic()).publishMessage({ data });
}

export async function readStatus(jobId: string): Promise<JobStatus | null> {
  const client = getRedis();
  if (!client) return null;
  const raw = await client.get(jobStatusKey(jobId));
  return raw ? (JSON.parse(raw) as JobStatus) : null;
}
