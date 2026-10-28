/**
 * GET /api/research/preview-plan/[jobId]/status - MONEY-240 A.
 *
 * Polled by the confirmation sheet when the inline LLM rewrite
 * crossed the 4 s soft-timeout and the request bounced to the
 * worker-fallback path. The worker writes the final response under
 * `research:preview-plan:job:{jobId}` once it finishes; this
 * endpoint just reads the cache.
 *
 * Returns 200 with the full PreviewPlanResponse when ready, or 202
 * with `{ pending: true }` while still processing.
 */

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { cacheClient } from "@/lib/cache/client";

const CACHE_NS = "research:preview-plan";
const CACHE_TTL_SECONDS = 120;

export async function GET(
  _req: Request,
  props: { params: Promise<{ jobId: string }> }
) {
  const params = await props.params;
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobId = params.jobId;
  if (!jobId || jobId.length > 64 || !/^[a-z0-9-]+$/i.test(jobId)) {
    return NextResponse.json({ error: "Invalid jobId" }, { status: 400 });
  }

  // MONEY-595 (A01): read ONLY from the caller's own user-namespaced key.
  // The job result was written by the route/worker under
  // `research:preview-plan:job:{ownerUserId}:{jobId}`, so reconstructing the
  // key from THIS request's authenticated userId means a jobId that belongs to
  // a different user simply misses (returns `pending`) instead of leaking their
  // rewritten brief.
  const cached = await cacheClient
    .get<unknown>(`${CACHE_NS}:job:${userId}:${jobId}`, {
      ttl: CACHE_TTL_SECONDS,
      enableMemory: true,
      enableRedis: true,
    })
    .catch(() => null);

  if (!cached) {
    return NextResponse.json(
      { pending: true, jobId },
      { status: 202, headers: { "cache-control": "no-store" } }
    );
  }

  return NextResponse.json(cached, {
    headers: { "cache-control": "no-store" },
  });
}
