/**
 * /api/research/preview-plan - MONEY-239 B.
 *
 * Returns a deterministic estimate of what a research run will cost
 * BEFORE it starts, so the confirmation sheet can render task count
 * + credit cost + duration as the user toggles skills / models.
 *
 * Architecture choice (per the architecture review documented in the
 * Linear ticket): this endpoint uses cache-first deterministic
 * estimation - NO synchronous Vertex Pro call from Vercel. The query
 * rewrite preview just echoes the user's input verbatim for now;
 * the LLM rewrite ships in PR-5 with the worker-fallback path.
 *
 * Why deterministic-only first?
 *   - 100 % cache hit rate after the first call per skill combination
 *   - Sub-30ms response on cache miss (no LLM round-trip)
 *   - Survives Vercel concurrency spikes
 *   - Cost: surfaced credit estimate may differ from final billing by
 *     ±2 credits as token usage variance kicks in. That's acceptable
 *     - the panel says "est." and the actual debit comes from the
 *     worker-side computeRunCredits at completion.
 *
 * On cache miss the response time is bounded by `estimateRunCredits`,
 * which is pure math - no I/O. Cache is mostly to dampen the same
 * user toggling skills repeatedly inside the panel.
 */

import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import {
  RESEARCH_PRESETS,
  RESEARCH_PRESET_DEFS,
  RESEARCH_SKILL_IDS,
  RESEARCH_DEFAULT_MODEL,
  resolveEffectiveSkills,
  type ResearchPresetId,
  type ResearchSkillId,
} from "@usemoney/services/preferences";
import {
  estimateRunCredits,
  getGeminiModel,
  generateWithTimeout,
} from "@usemoney/core";
import { auth } from "@clerk/nextjs/server";
import { cacheClient } from "@/lib/cache/client";
import { apiLogger as logger } from "@usemoney/logger";
import { publishResearchPreviewPlanJob } from "@usemoney/pubsub/publish";
import { apiRateLimiter } from "@usemoney/security/rate-limit";
import { llmWorkflow } from "@usemoney/datadog/llmobs";

const PreviewPlanRequest = z.object({
  query: z.string().trim().min(1).max(1000),
  symbols: z.array(z.string()).optional(),
  preset: z.enum(RESEARCH_PRESETS).optional(),
  customSkills: z.array(z.enum(RESEARCH_SKILL_IDS)).optional(),
  extraSkills: z.array(z.enum(RESEARCH_SKILL_IDS)).optional(),
  removedSkills: z.array(z.enum(RESEARCH_SKILL_IDS)).optional(),
  model: z.string().optional(),
});

type PreviewPlanRequestInput = z.infer<typeof PreviewPlanRequest>;

export interface PreviewPlanResponse {
  rewrittenQuery: string;
  /**
   * The skill set the run will execute, after preset + extras − removed
   * resolution (and v1 alias expansion). Matches what the planner will see.
   */
  effectiveSkills: string[];
  estimatedTasks: {
    /** Heuristic split - reflects the planner's typical task graph. */
    data: number;
    compute: number;
    synthesis: number;
    total: number;
  };
  estimatedCredits: number;
  estimatedRupees: number;
  estimatedSecondsRange: { min: number; max: number };
  /** The model that will be used (preset suggestion or user's override). */
  modelId: string;
  /** Quoted cost-tier label for UI display ("Free", "Pro", etc.). */
  modelTierLabel: string;
  /** Echoed back so the client can validate request roundtrip. */
  echo: {
    preset?: ResearchPresetId;
    skillCount: number;
    cacheHit: boolean;
    /** True when LLM rewrite landed inline; false on timeout / fallback. */
    rewriteSucceeded?: boolean;
  };
}

/**
 * Worker-fallback response. Returned when the LLM rewrite would
 * exceed the inline budget - client polls
 * /api/research/preview-plan/[jobId]/status until ready.
 */
export interface PreviewPlanPendingResponse {
  pending: true;
  jobId: string;
  /** Sub-second placeholder estimates so the panel can render
   *  immediately while the worker computes the rewritten query. */
  preliminary: PreviewPlanResponse;
}

const CACHE_TTL_SECONDS = 30;
const CACHE_NS = "research:preview-plan";

/**
 * Per-job result cache key for the worker-fallback rewrite.
 *
 * MONEY-595 (A01): the key is namespaced by the OWNING userId. The jobId is a
 * UUID returned to the browser, but jobIds are not secrets and the status
 * endpoint validated only `userId != null` (any authenticated user), so a
 * leaked/guessed jobId would let one user poll another user's rewritten brief.
 * Folding the owner's userId into the key means the status endpoint — which
 * reconstructs the key from its OWN authenticated userId — can only ever read
 * results that belong to the caller.
 */
function jobCacheKey(userId: string, jobId: string): string {
  return `${CACHE_NS}:job:${userId}:${jobId}`;
}

function modelTierLabel(modelId: string): string {
  if (modelId.includes("flash-lite")) return "Free · cheapest";
  if (modelId.includes("flash")) return "Free · fast";
  if (modelId.includes("3.1-pro")) return "Pro · richest";
  if (modelId.includes("3.0-pro")) return "Pro · deeper";
  if (modelId.includes("2.5-pro")) return "Pro · default";
  return "Custom";
}

/**
 * Estimate the data/compute/synthesis split of the planner's task graph
 * given the active skill set. Heuristic - derived from observed plans
 * on RELIANCE deep runs:
 *
 *   data tasks    ≈ 4 + (skills × 0.7), capped at 14
 *   compute tasks ≈ skills × 1.3, capped at 16
 *   synthesis     = 1
 */
function estimateTaskSplit(skillCount: number): {
  data: number;
  compute: number;
  synthesis: number;
  total: number;
} {
  const data = Math.min(14, Math.round(4 + skillCount * 0.7));
  const compute = Math.min(16, Math.round(skillCount * 1.3));
  const synthesis = 1;
  return { data, compute, synthesis, total: data + compute + synthesis };
}

/**
 * MONEY-240 B - LLM query rewrite via Gemini Flash.
 *
 * Turns "analyse reliance" into "Build a thesis on Reliance -
 * peer-relative valuation, DCF, recent catalysts, and earnings
 * trajectory." so the user can see (and edit) what the planner is
 * about to send to the synth model BEFORE money is spent.
 *
 * Wrapped in a hard 6 s timeout - anything slower escapes to the
 * worker-fallback path (see MONEY-240 A). On any error/timeout
 * we return the verbatim query so the panel always has SOMETHING
 * to display.
 */
const REWRITE_TIMEOUT_MS = 6000;

async function rewriteQueryWithLlm(
  query: string,
  effectiveSkills: ResearchSkillId[]
): Promise<{ rewritten: string; succeeded: boolean }> {
  if (!query.trim()) {
    return { rewritten: query, succeeded: false };
  }
  try {
    const model = getGeminiModel("fast");
    const skillList = effectiveSkills.length
      ? effectiveSkills.join(", ")
      : "general analysis";
    const prompt = `You are formatting a research brief for a stock analysis agent. The user typed: "${query}". The agent will run with these skills: ${skillList}.

Rewrite the user's input as ONE concise sentence that names the symbol(s), mentions the most relevant 2-3 skills as analytical lenses, and reads like an analyst's brief. Do NOT add new facts. Do NOT include disclaimers. Output ONLY the rewritten sentence - no quotes, no preamble, no markdown.`;

    const response = await generateWithTimeout(
      model,
      prompt,
      REWRITE_TIMEOUT_MS
    );
    const cleaned = response.trim().replace(/^["']|["']$/g, "");
    if (!cleaned || cleaned.length > 600) {
      // Reject pathological responses (empty / runaway) - fall back.
      return { rewritten: query, succeeded: false };
    }
    return { rewritten: cleaned, succeeded: true };
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "[preview-plan] LLM rewrite failed - falling back to verbatim"
    );
    return { rewritten: query, succeeded: false };
  }
}

function bodyHash(body: PreviewPlanRequestInput): string {
  // Sort skill arrays so the cache key is stable regardless of UI order.
  const sortedExtras = [...(body.extraSkills ?? [])].sort().join(",");
  const sortedRemoved = [...(body.removedSkills ?? [])].sort().join(",");
  const sortedCustom = [...(body.customSkills ?? [])].sort().join(",");
  const sortedSymbols = [...(body.symbols ?? [])].sort().join(",");
  return [
    body.query.trim().toLowerCase(),
    body.preset ?? "",
    body.model ?? "",
    sortedExtras,
    sortedRemoved,
    sortedCustom,
    sortedSymbols,
  ].join("|");
}

/**
 * Entry point. The body lives in `handlePreviewPlanPost`; this wrapper tags every model call
 * underneath it with `ml_app: research` (MONEY-1380). Auto-instrumented LLM
 * spans inherit it from this workflow parent, so calls made deep inside
 * packages this file never imports are attributed correctly.
 */
export async function POST(req: Request): Promise<Response> {
  return llmWorkflow("research", "preview-plan", () =>
    handlePreviewPlanPost(req)
  );
}

async function handlePreviewPlanPost(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Per-user rate limit (MONEY-595 hardening): on a cache miss this fires an
  // inline Gemini Flash rewrite (and may publish a worker job), so it is an
  // authed-but-expensive AI path. 30/min/user comfortably covers a user
  // toggling skills in the panel while capping scripted abuse. The cache
  // short-circuit below still absorbs most repeat toggles for free.
  const rateLimitResult = await apiRateLimiter.check(30, userId);
  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Please try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(rateLimitResult.reset / 1000)),
        },
      }
    );
  }

  let body: PreviewPlanRequestInput;
  try {
    const raw = await req.json();
    body = PreviewPlanRequest.parse(raw);
  } catch (parseErr) {
    return NextResponse.json(
      {
        error: "Invalid request body",
        detail:
          parseErr instanceof z.ZodError ? parseErr.issues : String(parseErr),
      },
      { status: 400 }
    );
  }

  const cacheKey = `${CACHE_NS}:${bodyHash(body)}`;
  const cacheConfig = {
    ttl: CACHE_TTL_SECONDS,
    enableMemory: true,
    enableRedis: true,
  };

  // Cache lookup - short-circuit if the same skill combination was
  // requested in the last 30 s.
  try {
    const hit = await cacheClient.get<PreviewPlanResponse>(
      cacheKey,
      cacheConfig
    );
    if (hit) {
      return NextResponse.json({
        ...hit,
        echo: { ...hit.echo, cacheHit: true },
      });
    }
  } catch (cacheErr) {
    // Soft-fail - a Redis blip should never block the panel from
    // rendering. We just compute fresh.
    logger.warn(
      { error: String(cacheErr) },
      "[preview-plan] cache lookup failed - computing fresh"
    );
  }

  // ─── Compute fresh ──────────────────────────────────────────────
  const effectiveSkills = resolveEffectiveSkills({
    preset: body.preset,
    extraSkills: body.extraSkills,
    removedSkills: body.removedSkills,
    customOnlySkills: body.customSkills,
  });

  const presetDef = body.preset ? RESEARCH_PRESET_DEFS[body.preset] : null;
  const baseCredits = presetDef?.baseCredits ?? 1;
  const modelId =
    body.model ?? presetDef?.suggestedModel ?? RESEARCH_DEFAULT_MODEL;

  const taskSplit = estimateTaskSplit(effectiveSkills.length);
  const creditEstimate = estimateRunCredits({
    modelId,
    taskCount: taskSplit.total,
    skillCount: effectiveSkills.length,
    baseCredits,
  });

  // Seconds range - preset gives a curated range; for custom skill sets
  // we extrapolate from skill count (each skill ≈ 8 s + 30 s baseline).
  const estimatedSecondsRange = presetDef?.estimatedSeconds ?? {
    min: Math.max(30, 30 + effectiveSkills.length * 6),
    max: Math.max(60, 60 + effectiveSkills.length * 12),
  };

  // MONEY-240 B - LLM rewrite via Gemini Flash with a 6 s timeout.
  // If the rewrite would block longer (cold model start, transient
  // Vertex slowness), we don't want to hold the request - see the
  // worker-fallback branch below in MONEY-240 A.
  let rewritten = body.query.trim();
  let rewriteSucceeded = false;
  let rewriteCrossedSoft = false;

  // Hard race against the 6s LLM call. If the LLM doesn't return in
  // 4s we treat the request as worker-fallback eligible - return a
  // preliminary response NOW with a jobId, kick off the worker job,
  // and the client polls for the final rewrite. The 4s soft threshold
  // is deliberately tighter than the 6s hard ceiling so we err toward
  // the worker path under any contention.
  const SOFT_TIMEOUT_MS = 4000;
  let llmPromise: Promise<{ rewritten: string; succeeded: boolean }> | null =
    null;

  try {
    llmPromise = rewriteQueryWithLlm(body.query.trim(), effectiveSkills);
    const raceResult = await Promise.race([
      llmPromise.then((r) => ({ kind: "llm" as const, ...r })),
      new Promise<{ kind: "soft-timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "soft-timeout" }), SOFT_TIMEOUT_MS)
      ),
    ]);
    if (raceResult.kind === "llm") {
      rewritten = raceResult.rewritten;
      rewriteSucceeded = raceResult.succeeded;
    } else {
      rewriteCrossedSoft = true;
    }
  } catch {
    // rewriteQueryWithLlm already swallows + logs - defensive only.
  }

  const response: PreviewPlanResponse = {
    rewrittenQuery: rewritten,
    effectiveSkills,
    estimatedTasks: taskSplit,
    estimatedCredits: creditEstimate.credits,
    estimatedRupees: creditEstimate.rupees,
    estimatedSecondsRange,
    modelId,
    modelTierLabel: modelTierLabel(modelId),
    echo: {
      preset: body.preset,
      skillCount: effectiveSkills.length,
      cacheHit: false,
      rewriteSucceeded,
    },
  };

  // MONEY-240 A - worker-fallback when LLM crossed the soft timer.
  // Publish the job, return a `pending` response so the client renders
  // the panel immediately with deterministic estimates (no LLM brief
  // yet), then polls /api/research/preview-plan/[jobId]/status until
  // the worker writes the final rewrite to Redis.
  if (rewriteCrossedSoft) {
    const jobId = uuidv4();
    void (async () => {
      try {
        await publishResearchPreviewPlanJob({
          jobId,
          userId,
          query: body.query.trim(),
          symbols: body.symbols,
          preset: body.preset,
          customSkills: body.customSkills,
          extraSkills: body.extraSkills,
          removedSkills: body.removedSkills,
          model: modelId,
          // Echo the deterministic part of the response so the worker
          // doesn't have to recompute; it just needs to add the
          // LLM-rewritten brief.
          deterministic: response as unknown as Record<string, unknown>,
        });
      } catch (publishErr) {
        logger.warn(
          { error: String(publishErr), jobId },
          "[preview-plan] worker-fallback publish failed - client will see verbatim brief"
        );
      }
      // Continue waiting on the in-flight LLM in the background. If
      // it eventually returns, write the result to the per-job Redis
      // key the status endpoint reads.
      try {
        if (llmPromise) {
          const final = await llmPromise;
          if (final.succeeded) {
            // User-namespaced job key (MONEY-595 A01) — see jobCacheKey().
            await cacheClient.set(
              jobCacheKey(userId, jobId),
              {
                ...response,
                rewrittenQuery: final.rewritten,
                echo: { ...response.echo, rewriteSucceeded: true },
              },
              { ttl: 120, enableMemory: true, enableRedis: true }
            );
          }
        }
      } catch {
        /* best-effort - worker has its own LLM call too */
      }
    })();

    const pending: PreviewPlanPendingResponse = {
      pending: true,
      jobId,
      preliminary: response,
    };
    return NextResponse.json(pending, { status: 202 });
  }

  // Store the response - only the cacheHit flag should differ on a
  // future hit, so we serialise the response as-is and flip the flag
  // on read.
  try {
    await cacheClient.set(cacheKey, response, cacheConfig);
  } catch (cacheErr) {
    logger.warn(
      { error: String(cacheErr) },
      "[preview-plan] cache write failed - response served regardless"
    );
  }

  return NextResponse.json(response);
}
