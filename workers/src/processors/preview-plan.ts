/**
 * Preview-plan worker - MONEY-240 A.
 *
 * Slow-path counterpart to /api/research/preview-plan. The route
 * tries to do the LLM rewrite inline inside a 4 s soft-timeout. If
 * Vertex doesn't return that fast (cold model start, transient
 * slowness), the route returns a `pending: true, jobId` to the
 * client and publishes this Pub/Sub job. The worker re-runs the
 * rewrite at its own pace (no 60 s Vercel function limit) and
 * writes the final PreviewPlanResponse under
 * `research:preview-plan:job:{jobId}` so the status endpoint can
 * serve it.
 *
 * Why a worker rather than just waiting longer in the route?
 *   - Vercel Pro tier caps function duration at 60 s; a Vertex call
 *     that's slow today could exceed that and 502 the user.
 *   - Cloud Run gives us 10 minutes - far more than the rewrite
 *     ever needs.
 *   - The worker shares a Redis cache with the route, so once
 *     written, ANY future request with the same body hash hits
 *     immediately for 30 s.
 */

import type { ResearchPreviewPlanJobMessage } from "@usemoney/types";
import { getGeminiModel, generateWithTimeout } from "@usemoney/core";
import Redis from "ioredis";
import { llmWorkflow } from "@usemoney/datadog/llmobs";

let cachedRedis: Redis | null = null;
function getRedis(): Redis | null {
  if (cachedRedis) return cachedRedis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  cachedRedis = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
  });
  cachedRedis.on("error", (err) => {
    console.warn("[preview-plan-worker] redis error:", err.message);
  });
  return cachedRedis;
}

const REWRITE_TIMEOUT_MS = 30_000; // generous - we're on Cloud Run
const RESULT_CACHE_NS = "research:preview-plan";
const RESULT_TTL_SECONDS = 120; // status endpoint reads within 2 min

/**
 * Entry point for the `preview-plan` job. The body lives in `runResearchPreviewPlan`; this wrapper
 * tags every model call underneath it with `ml_app: research` (MONEY-1380).
 */
export async function processResearchPreviewPlan(
  data: ResearchPreviewPlanJobMessage,
): Promise<{ jobId: string; rewriteSucceeded: boolean }> {
  return llmWorkflow("research", "preview-plan", () =>
    runResearchPreviewPlan(data),
  );
}

async function runResearchPreviewPlan(
  data: ResearchPreviewPlanJobMessage,
): Promise<{ jobId: string; rewriteSucceeded: boolean }> {
  const { jobId, userId, query, deterministic } = data;

  const skillSet = [
    ...(data.customSkills ?? []),
    ...(data.extraSkills ?? []),
  ].filter((s) => !(data.removedSkills ?? []).includes(s));

  let rewritten = query.trim();
  let rewriteSucceeded = false;
  try {
    const model = getGeminiModel("fast");
    const skillList = skillSet.length
      ? skillSet.join(", ")
      : "general analysis";
    const prompt = `You are formatting a research brief for a stock analysis agent. The user typed: "${query}". The agent will run with these skills: ${skillList}.

Rewrite the user's input as ONE concise sentence that names the symbol(s), mentions the most relevant 2-3 skills as analytical lenses, and reads like an analyst's brief. Do NOT add new facts. Do NOT include disclaimers. Output ONLY the rewritten sentence - no quotes, no preamble, no markdown.`;
    const response = await generateWithTimeout(
      model,
      prompt,
      REWRITE_TIMEOUT_MS,
    );
    const cleaned = response.trim().replace(/^["']|["']$/g, "");
    if (cleaned && cleaned.length <= 600) {
      rewritten = cleaned;
      rewriteSucceeded = true;
    }
  } catch (err) {
    console.warn(
      `[preview-plan-worker] rewrite failed for ${jobId} - falling back to verbatim:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Overlay the LLM rewrite on top of the deterministic estimates the
  // route already returned. Same cache key the status endpoint reads.
  const finalPayload = {
    ...deterministic,
    rewrittenQuery: rewritten,
    echo: {
      ...((deterministic.echo as Record<string, unknown> | undefined) ?? {}),
      rewriteSucceeded,
    },
  };

  // Write to Redis directly - the apps/web cacheClient on the
  // status-endpoint side reads memory + Redis, so a Redis-only
  // write here flows through to the polling browser without us
  // having to share the LRU instance across processes.
  //
  // Schema: matches what apps/web/lib/cache/client.ts persists -
  //   { data, version, timestamp, ttl }
  const redis = getRedis();
  if (redis) {
    try {
      const entry = {
        data: finalPayload,
        version: "default",
        timestamp: Date.now(),
        ttl: RESULT_TTL_SECONDS,
      };
      // MONEY-595 (A01): user-namespaced key — must match the shape the
      // status endpoint reads (`research:preview-plan:job:{userId}:{jobId}`)
      // so a leaked jobId can't surface another user's rewritten brief.
      await redis.set(
        `${RESULT_CACHE_NS}:job:${userId}:${jobId}`,
        JSON.stringify(entry),
        "EX",
        RESULT_TTL_SECONDS,
      );
      console.log(
        `[preview-plan-worker] cached job ${jobId} (rewriteSucceeded=${rewriteSucceeded})`,
      );
    } catch (cacheErr) {
      console.error(
        `[preview-plan-worker] cache write failed for ${jobId}:`,
        cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
      );
    }
  } else {
    console.warn(
      `[preview-plan-worker] no REDIS_URL - job ${jobId} result dropped`,
    );
  }

  return { jobId, rewriteSucceeded };
}
