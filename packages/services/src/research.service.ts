/**
 * Research Service
 *
 * CRUD operations for ResearchSession records.
 * Source: apps/web/lib/actions/research.ts
 *
 * NOTE: startResearch (Pub/Sub + instrument validation) stays in the action layer.
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
// MONEY-1062 (P2b) — async research START extraction. The web action
// (apps/web/lib/actions/research.ts:144 `startResearchAction`) owns the credit
// gating + session-create + Pub/Sub publish; this ADDITIVE parallel service lets
// apps/api `POST /v1/research` reach the SAME flow without the thin route
// inlining pubsub. The web action is NOT modified — a small amount of its credit
// math is duplicated here on purpose (the two surfaces evolve together).
import { randomUUID } from "node:crypto";
import { CREDIT_COSTS } from "@usemoney/core";
import {
  resolveResearchModel as defaultResolveResearchModel,
  getEffectiveCreditCost as defaultGetEffectiveCreditCost,
} from "@usemoney/core/gemini/model-registry";
import { publishResearchJob as defaultPublishResearchJob } from "@usemoney/pubsub/publish";
import type { ResearchJobMessage } from "@usemoney/types";
import {
  consumeCredits as defaultConsumeCredits,
  refundCredits as defaultRefundCredits,
} from "./credit.service";
import { getComposerPreferences as defaultGetComposerPreferences } from "./preferences/composer-preferences";
// MONEY-620 — pure, unit-tested derivation/clamp/guard helpers the LIVE path
// CALLS (de-shadow). See ./research-logic.ts + the test it documents.
import {
  buildTaskProgress,
  clampProgress,
  clampResearchPagination,
  deriveStuckSessions,
  displayScore,
  extractReportInsights,
  isOwnerScoped,
  safeCreatedAt,
  toSafeOptionalDate,
  type TaskProgressItem,
} from "./research-logic";

// ── Types ──────────────────────────────────────────────────────────

export type { TaskProgressItem };

export interface ResearchStatusData {
  status: string;
  progress: number;
  currentStep?: string;
  qualityScore?: number;
  query?: string;
  symbols?: string[];
  errorMessage?: string;
  skill?: string;
  totalSteps?: number;
  taskProgress?: TaskProgressItem[];
}

export interface ResearchResultData {
  sessionId: string;
  report: unknown;
  contentBlocks: unknown[];
  qualityScore?: number;
  tokensUsed: number;
  symbols: string[];
  totalSteps?: number;
  skill?: string;
  plan?: unknown;
}

export interface RecentResearchItem {
  sessionId: string;
  query: string;
  status: string;
  progress: number;
  currentStep?: string;
}

export interface RunningResearchItem {
  sessionId: string;
  query: string;
  status: string;
  progress: number;
  currentStep?: string;
  symbols: string[];
  createdAt: Date;
}

export interface ResearchHistoryItem {
  sessionId: string;
  query: string;
  status: string;
  symbols: string[];
  skill?: string;
  qualityScore?: number;
  /** Investment recommendation score (0-100) extracted from report JSON. */
  reportScore?: number;
  recommendation?: string;
  createdAt: Date;
  completedAt?: Date;
  errorMessage?: string;
}

// ── Result Summarizers ────────────────────────────────────────────
// MONEY-620: the polling task-result summarizers (size cap + compact salvage)
// + the delta-aware task-progress projection now live as EXPORTED helpers in
// ./research-logic.ts (`summarizeTaskResult`, `truncateToSize`,
// `compactSummarize`, `buildTaskProgress`) so they are asserted as the REAL
// symbols this service calls, not redefined inline by a shadow test.

// ── Service Functions ──────────────────────────────────────────────

export async function getResearchStatus(
  sessionId: string,
  completedTaskIds?: string[],
  userId?: string,
): Promise<ServiceResult<ResearchStatusData>> {
  try {
    // MONEY-286 / MONEY-620: scope the lookup to the authenticated owner so a
    // guessed sessionId from another user resolves as "not found", never as a
    // readable session. Every real caller (web action + api route) passes a
    // non-empty userId; a missing/empty userId is never a legitimate request,
    // so we FAIL CLOSED (no bare-id cross-user `findUnique` fallback).
    if (!isOwnerScoped(userId)) {
      return {
        success: false,
        error: "Research session not found",
        code: "NOT_FOUND",
      };
    }
    const session = await prisma.researchSession.findFirst({
      where: { sessionId, userId },
      select: {
        status: true,
        progress: true,
        currentStep: true,
        qualityScore: true,
        query: true,
        symbols: true,
        errorMessage: true,
        plan: true,
        skill: true,
        totalSteps: true,
      },
    });

    if (!session) {
      return {
        success: false,
        error: "Research session not found",
        code: "NOT_FOUND",
      };
    }

    // Project plan.tasks[] → wire task progress (delta-aware). MONEY-620:
    // this + the result summarizers are now the asserted exports.
    const taskProgress = buildTaskProgress(session.plan, completedTaskIds);

    return {
      success: true,
      data: {
        status: session.status,
        // Clamp to [0,100] so a corrupt worker write can't make the
        // consumer's `width: ${progress}%` bar render `NaN%`.
        progress: clampProgress(session.progress),
        currentStep: session.currentStep || undefined,
        // displayScore preserves a legitimate 0 (was dropped by `|| undefined`).
        qualityScore: displayScore(session.qualityScore),
        query: session.query,
        symbols: session.symbols,
        errorMessage: session.errorMessage || undefined,
        skill: session.skill || undefined,
        totalSteps: session.totalSteps || undefined,
        taskProgress: taskProgress.length > 0 ? taskProgress : undefined,
      },
    };
  } catch (error) {
    logger.error({ error, sessionId }, "Get research status service error");
    return {
      success: false,
      error: "Failed to get research status",
      code: "INTERNAL",
    };
  }
}

export async function getResearchResult(
  sessionId: string,
  userId?: string,
): Promise<ServiceResult<ResearchResultData>> {
  try {
    // MONEY-286 / MONEY-620: scope to the authenticated owner so a guessed
    // sessionId resolves "not found" rather than leaking another user's
    // research output (PII + portfolio context). FAIL CLOSED on a
    // missing/empty userId — no bare-id cross-user `findUnique` fallback.
    if (!isOwnerScoped(userId)) {
      return {
        success: false,
        error: "Research session not found",
        code: "NOT_FOUND",
      };
    }
    const session = await prisma.researchSession.findFirst({
      where: { sessionId, userId },
      select: {
        sessionId: true,
        status: true,
        report: true,
        contentBlocks: true,
        qualityScore: true,
        tokensUsed: true,
        symbols: true,
        totalSteps: true,
        skill: true,
        plan: true,
      },
    });

    if (!session) {
      return {
        success: false,
        error: "Research session not found",
        code: "NOT_FOUND",
      };
    }

    if (session.status !== "COMPLETED") {
      // MONEY-1183 — NOT a not-found. The session exists and is owned by the
      // caller; it simply has no result yet. Coded so the route can answer
      // 409 rather than telling a polling client the session is gone.
      return {
        success: false,
        error: `Research is still ${session.status}`,
        code: "NOT_READY",
      };
    }

    return {
      success: true,
      data: {
        sessionId: session.sessionId,
        report: session.report,
        contentBlocks: session.contentBlocks,
        // displayScore preserves a legitimate 0 (was dropped by `|| undefined`).
        qualityScore: displayScore(session.qualityScore),
        tokensUsed: session.tokensUsed,
        symbols: session.symbols,
        totalSteps: session.totalSteps || undefined,
        skill: session.skill || undefined,
        plan: session.plan || undefined,
      },
    };
  } catch (error) {
    logger.error({ error, sessionId }, "Get research result service error");
    return {
      success: false,
      error: "Failed to get research result",
      code: "INTERNAL",
    };
  }
}

export async function getRecentResearchSessions(
  userId: string,
): Promise<ServiceResult<RecentResearchItem[]>> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const sessions = await prisma.researchSession.findMany({
      where: {
        userId,
        createdAt: { gte: since },
      },
      select: {
        sessionId: true,
        query: true,
        status: true,
        progress: true,
        currentStep: true,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return {
      success: true,
      data: sessions.map((s) => ({
        sessionId: s.sessionId,
        query: s.query,
        status: s.status,
        progress: clampProgress(s.progress),
        currentStep: s.currentStep || undefined,
      })),
    };
  } catch (error) {
    logger.error(
      { error, userId },
      "Get recent research sessions service error",
    );
    return { success: false, error: "Failed to get recent research sessions" };
  }
}

export async function getRunningResearch(
  userId: string,
): Promise<ServiceResult<RunningResearchItem[]>> {
  try {
    const sessions = await prisma.researchSession.findMany({
      where: {
        userId,
        status: { notIn: ["COMPLETED", "FAILED"] },
      },
      select: {
        sessionId: true,
        query: true,
        status: true,
        progress: true,
        currentStep: true,
        symbols: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    // Auto-expire sessions stuck for more than 15 minutes. The worker's hard
    // timeout is ~9 min, so anything still "running" after 15 min is orphaned
    // (worker crashed, Pub/Sub never delivered, …). MONEY-620: the inline
    // `now - s.createdAt.getTime() > MAX_AGE` silently failed for an
    // Invalid-Date createdAt (`NaN > MAX` is false → the corrupt-dated session
    // would NEVER expire). `deriveStuckSessions` treats an unknowable age as
    // stuck (fail safe) and uses the real age otherwise.
    const { stuck, active } = deriveStuckSessions(sessions, new Date());
    const stuckSessionIds = stuck.map((s) => s.sessionId);

    if (stuckSessionIds.length > 0) {
      logger.warn(
        { userId, sessionIds: stuckSessionIds },
        "Auto-expiring stuck research sessions",
      );
      await prisma.researchSession.updateMany({
        where: { sessionId: { in: stuckSessionIds } },
        data: {
          status: "FAILED",
          errorMessage: "Research timed out. Please try again.",
          currentStep: "Timed out",
          completedAt: new Date(),
        },
      });
    }

    return {
      success: true,
      data: active.map((s) => ({
        sessionId: s.sessionId,
        query: s.query,
        status: s.status,
        progress: clampProgress(s.progress),
        currentStep: s.currentStep || undefined,
        symbols: s.symbols,
        // Never emit an Invalid Date to the consumer's relativeTime()/new Date().
        createdAt: safeCreatedAt(s.createdAt),
      })),
    };
  } catch (error) {
    logger.error({ error, userId }, "Get running research service error");
    return { success: false, error: "Failed to get running research sessions" };
  }
}

export interface ResearchHistoryPage {
  items: ResearchHistoryItem[];
  total: number;
}

export async function getResearchHistory(
  userId: string,
  page = 1,
  pageSize = 20,
): Promise<ServiceResult<ResearchHistoryPage>> {
  try {
    // MONEY-620: clamp (page, pageSize) into safe Prisma skip/take. The web
    // action defaults are sane, but params are forwarded verbatim and a NaN /
    // negative / absurd value reaches Prisma, which THROWS on a non-finite or
    // negative skip/take (→ 500) and risks OOM on a huge take.
    const { skip, take } = clampResearchPagination(page, pageSize);
    // Run count + data in parallel
    const [total, sessions] = await Promise.all([
      prisma.researchSession.count({
        where: {
          userId,
          status: { in: ["COMPLETED", "FAILED"] },
        },
      }),
      prisma.researchSession.findMany({
        where: {
          userId,
          status: { in: ["COMPLETED", "FAILED"] },
        },
        select: {
          sessionId: true,
          query: true,
          status: true,
          symbols: true,
          skill: true,
          qualityScore: true,
          report: true,
          createdAt: true,
          completedAt: true,
          errorMessage: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
    ]);

    return {
      success: true,
      data: {
        items: sessions.map((s) => {
          // recommendation + investment score from report JSON (L1–L4 shapes);
          // extractReportInsights also drops a NaN/Infinity score.
          const { recommendation, reportScore } = extractReportInsights(
            s.report,
          );

          return {
            sessionId: s.sessionId,
            query: s.query,
            status: s.status,
            symbols: s.symbols,
            skill: s.skill || undefined,
            // displayScore preserves a legitimate 0 (was dropped by `|| undefined`).
            qualityScore: displayScore(s.qualityScore),
            reportScore,
            recommendation,
            // Never emit an Invalid Date to the consumer's relativeTime().
            createdAt: safeCreatedAt(s.createdAt),
            completedAt: toSafeOptionalDate(s.completedAt),
            errorMessage: s.errorMessage || undefined,
          };
        }),
        total,
      },
    };
  } catch (error) {
    logger.error({ error, userId }, "Get research history service error");
    return { success: false, error: "Failed to get research history" };
  }
}

export async function cancelResearch(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<void>> {
  try {
    // MONEY-620: defense-in-depth IDOR gate — never mutate a session without
    // a non-empty owner id scoping the ownership check below.
    if (!isOwnerScoped(userId)) {
      return {
        success: false,
        error: "Research session not found",
        code: "NOT_FOUND",
      };
    }
    const session = await prisma.researchSession.findFirst({
      where: { sessionId, userId },
      select: { id: true, status: true },
    });

    if (!session) {
      return {
        success: false,
        error: "Research session not found",
        code: "NOT_FOUND",
      };
    }

    if (session.status === "COMPLETED" || session.status === "FAILED") {
      return { success: false, error: "Session already finished" };
    }

    await prisma.researchSession.update({
      where: { sessionId },
      data: {
        status: "FAILED",
        errorMessage: "Cancelled by user",
        completedAt: new Date(),
      },
    });

    return { success: true, data: undefined };
  } catch (error) {
    logger.error({ error, userId, sessionId }, "Cancel research service error");
    return {
      success: false,
      error: "Failed to cancel research",
      code: "INTERNAL",
    };
  }
}

export async function deleteResearch(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<void>> {
  try {
    // MONEY-620: defense-in-depth IDOR gate — a missing/empty userId must not
    // delete anything (the ownership findFirst below would match nothing, but
    // make the refusal explicit and asserted).
    if (!isOwnerScoped(userId)) {
      return {
        success: false,
        error: "Research session not found",
        code: "NOT_FOUND",
      };
    }
    // Verify the session belongs to the user
    const session = await prisma.researchSession.findFirst({
      where: { sessionId, userId },
      select: { id: true },
    });

    if (!session) {
      return {
        success: false,
        error: "Research session not found",
        code: "NOT_FOUND",
      };
    }

    // Delete associated chat history
    await prisma.chatHistory.deleteMany({
      where: {
        userId,
        pagePath: `/analysis/${sessionId}`,
      },
    });

    // Delete the research session
    await prisma.researchSession.delete({
      where: { sessionId },
    });

    return {
      success: true,
      data: undefined,
      message: "Research session deleted",
    };
  } catch (error) {
    logger.error({ error, userId, sessionId }, "Delete research service error");
    return {
      success: false,
      error: "Failed to delete research session",
      code: "INTERNAL",
    };
  }
}

// ── Async Research START (MONEY-1062 P2b — apps/api parity) ─────────
//
// Mirrors apps/web/lib/actions/research.ts:144 `startResearchAction`, scoped to
// the inputs the mobile route accepts ({ query, skill?, symbols?, mode? }). The
// deliberately-omitted extras (the dual calling convention, InstrumentMapping
// symbol validation, MF single-fund routing, institutional run-parameters, the
// Document-Vault pins) are web-composer concerns; the worker re-derives / ignores
// them, so omitting them changes the plan only for those advanced surfaces.
//
// Credit flow (mirrors research.ts:275-498, G3-safe):
//   1. compute credit action (fast / advanced / comparison) + base cost,
//   2. resolve the tier model + apply the per-model premium (research.ts:323-338),
//   3. consumeCredits — the GATE: a failure returns BEFORE any session-create or
//      publish (no orphan session, no queued job),
//   4. create the ResearchSession row,
//   5. publishResearchJob — on failure REFUND the base credit action (exactly the
//      action's leg, research.ts:485) and mark the session FAILED.

export interface StartResearchInput {
  query: string;
  skill?: string;
  symbols?: string[];
  mode?: "fast" | "advanced";
}

/**
 * Injectable IO seam. `@usemoney/services` runs its suite as ESM (no
 * `require.cache` module-mocking), so the service tests pass fakes via `deps`
 * to assert the credit-flow ordering + refund leg on the REAL function.
 * Production omits `deps` → the shared prisma / pubsub / credit implementations.
 */
export interface StartResearchDeps {
  prisma?: typeof prisma;
  publishResearchJob?: (msg: ResearchJobMessage) => Promise<string>;
  consumeCredits?: typeof defaultConsumeCredits;
  refundCredits?: typeof defaultRefundCredits;
  getComposerPreferences?: (
    userId: string,
  ) => Promise<{ model?: string | null }>;
  resolveResearchModel?: (planId: string, userPick?: string | null) => string;
  getEffectiveCreditCost?: (
    action: string,
    modelId: string,
    baseCost: number,
  ) => number;
}

export async function startResearchJob(
  userId: string,
  input: StartResearchInput,
  deps: StartResearchDeps = {},
): Promise<ServiceResult<{ sessionId: string }>> {
  const db = deps.prisma ?? prisma;
  const publish = deps.publishResearchJob ?? defaultPublishResearchJob;
  const consume = deps.consumeCredits ?? defaultConsumeCredits;
  const refund = deps.refundCredits ?? defaultRefundCredits;
  const composerPrefsOf =
    deps.getComposerPreferences ?? defaultGetComposerPreferences;
  const resolveModel = deps.resolveResearchModel ?? defaultResolveResearchModel;
  const effectiveCost =
    deps.getEffectiveCreditCost ?? defaultGetEffectiveCreditCost;

  try {
    const { query, skill, symbols, mode } = input;

    // ── Credit action + base cost (mirror research.ts:277-307) ────────
    const isComparison =
      skill === "peer-comparison" || (!!symbols && symbols.length > 1);
    let creditAction: string;
    let totalCreditCost: number;

    if (isComparison && symbols && symbols.length > 1) {
      const baseCost = CREDIT_COSTS["l3_multi_comparison_base"] ?? 3;
      const perStockCost = CREDIT_COSTS["l3_multi_comparison_per_stock"] ?? 2;
      totalCreditCost =
        baseCost + perStockCost * Math.max(0, symbols.length - 1);
      creditAction = "l3_multi_comparison_base";
    } else if (mode === "advanced") {
      creditAction = "l2_research_advanced";
      totalCreditCost = CREDIT_COSTS[creditAction] ?? 3;
    } else {
      creditAction = "l2_research_fast";
      totalCreditCost = CREDIT_COSTS[creditAction] ?? 1;
    }

    // ── Per-model credit premium (mirror research.ts:323-338) ─────────
    const composerPrefs = await composerPrefsOf(userId);
    const subscription = await db.subscription.findUnique({
      where: { userId },
      select: { planId: true },
    });
    const resolvedModelId = resolveModel(
      subscription?.planId ?? "FREE",
      composerPrefs.model,
    );
    const baseCostForAction = totalCreditCost;
    totalCreditCost = effectiveCost(
      creditAction,
      resolvedModelId,
      baseCostForAction,
    );

    // ── GATE: consume credits BEFORE any session-create / publish ─────
    const creditResult = await consume(userId, creditAction, {
      symbols,
      query,
      tier: isComparison ? "L3" : "L2",
      geminiModel: resolvedModelId,
      costOverride: totalCreditCost,
    });
    if (!creditResult.success) {
      // Insufficient credits → the route maps NO_CREDITS to 403; a genuine
      // consume error (missing/inactive subscription, DB) → INTERNAL → 500.
      return {
        success: false,
        error:
          creditResult.error ||
          `Insufficient credits. This action costs ${totalCreditCost} credits.`,
        code:
          creditResult.code === "INSUFFICIENT_CREDITS"
            ? "NO_CREDITS"
            : "INTERNAL",
      };
    }

    // Comparison per-stock top-up (mirror research.ts:369-384). The action does
    // NOT refund this extra on publish failure — only the base action — so we
    // preserve that asymmetry exactly (documented divergence-of-omission).
    if (
      isComparison &&
      symbols &&
      symbols.length > 1 &&
      totalCreditCost > (CREDIT_COSTS["l3_multi_comparison_base"] ?? 3)
    ) {
      const extraCredits =
        totalCreditCost - (CREDIT_COSTS["l3_multi_comparison_base"] ?? 3);
      if (extraCredits > 0) {
        await consume(userId, "l3_multi_comparison_per_stock", {
          symbols,
          query,
          tier: "L3",
        });
      }
    }

    const sessionId = randomUUID();
    const jobId = randomUUID();

    // ── Create the ResearchSession row (mirror research.ts:390-403) ───
    await db.researchSession.create({
      data: {
        userId,
        sessionId,
        jobId,
        query,
        skill,
        symbols: symbols || [],
        status: "PLANNING",
        progress: 0,
        scratchpad: [],
        contentBlocks: [],
      },
    });

    // ── Publish; on failure refund the base action + mark FAILED ──────
    try {
      await publish({
        jobId,
        userId,
        sessionId,
        query,
        skill,
        symbols,
        // Default to "advanced" so the synthesizer emits the full report
        // (mirror research.ts:455). Callers that want fast pass mode="fast".
        mode: mode || "advanced",
        model: resolvedModelId,
      });
    } catch (pubsubError) {
      logger.error(
        { error: pubsubError, sessionId },
        "Start research publish failed",
      );
      // Refund the base credit action (fire-and-forget, mirror research.ts:485).
      refund(userId, creditAction).catch((err) =>
        logger.error({ err }, "Start research refund failed"),
      );
      await db.researchSession.update({
        where: { sessionId },
        data: {
          status: "FAILED",
          errorMessage: "Failed to queue research job",
        },
      });
      return {
        success: false,
        error: "Failed to queue research job",
        code: "INTERNAL",
      };
    }

    return { success: true, data: { sessionId } };
  } catch (error) {
    logger.error({ error, userId }, "Start research service error");
    return {
      success: false,
      error: "Failed to start research",
      code: "INTERNAL",
    };
  }
}
