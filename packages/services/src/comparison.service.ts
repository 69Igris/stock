/**
 * Comparison Service (MONEY-553)
 *
 * CRUD operations for ComparisonSession (async deep stock/MF comparison).
 * Mirrors roast.service.ts exactly.
 *
 * NOTE: Credit reservation and Pub/Sub publishing stay in the action layer.
 *
 * IDOR-safe: every read is scoped to `userId` so a guessed sessionId from
 * another account resolves as "not found" rather than leaking comparison
 * status / progress / symbols / result (which may include portfolio hints).
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
// MONEY-1062 (P2b) — async deep-comparison START extraction. The web action
// (apps/web/lib/actions/comparison.ts:77 `startComparisonAction`) owns the
// feature gate + credit RESERVATION + Pub/Sub publish; this ADDITIVE parallel
// service lets apps/api `POST /v1/compare` reach the SAME flow (incl. the exact
// reserveCredits/refundReservationCredits legs) without the thin route inlining
// pubsub. The web action is NOT modified.
import { randomUUID } from "node:crypto";
import { hasFeatureAccess } from "@usemoney/core/subscription";
import { resolveResearchModel as defaultResolveResearchModel } from "@usemoney/core/gemini/model-registry";
import type { ComparisonJobMessage } from "@usemoney/types";
import { publishComparisonJob as defaultPublishComparisonJob } from "@usemoney/pubsub/publish";
import {
  estimateAnalysisCost as defaultEstimateAnalysisCost,
  reserveCredits as defaultReserveCredits,
  refundReservationCredits as defaultRefundReservationCredits,
  type AnalysisType,
  type CostEstimate,
} from "./credit-reservation.service";
import {
  getSubscriptionAccessForUser as defaultGetSubscriptionAccessForUser,
  type SubscriptionAccess,
} from "./subscription.service";
import { getComposerPreferences as defaultGetComposerPreferences } from "./preferences/composer-preferences";

// ── Types ──────────────────────────────────────────────────────────

/** Open-ended structured comparison report produced by the research synthesizer. */
export type ComparisonResult = Record<string, unknown>;

export type ComparisonKind = "stock" | "mf";

export interface CreateComparisonInput {
  userId: string;
  sessionId: string;
  jobId: string;
  kind: ComparisonKind;
  depth: string;
  symbols: string[];
}

export interface ComparisonStatusData {
  status: string;
  progress: number;
  currentStep: string | null;
  errorMessage: string | null;
}

export interface ComparisonFullRecord {
  id: string;
  sessionId: string;
  kind: string;
  depth: string;
  symbols: string[];
  status: string;
  progress: number;
  currentStep: string | null;
  result: ComparisonResult | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface RecentComparisonItem {
  sessionId: string;
  kind: string;
  depth: string;
  symbols: string[];
  status: string;
  progress: number;
  currentStep: string | null;
  createdAt: Date;
}

export interface UpdateComparisonStatusInput {
  status:
    | "QUEUED"
    | "PLANNING"
    | "RESEARCHING"
    | "ANALYZING"
    | "SYNTHESIZING"
    | "COMPLETED"
    | "FAILED";
  errorMessage?: string;
}

// ── Service Functions ──────────────────────────────────────────────

export async function createComparisonSession(
  data: CreateComparisonInput,
): Promise<ServiceResult<{ id: string }>> {
  try {
    const comparison = await prisma.comparisonSession.create({
      data: {
        userId: data.userId,
        sessionId: data.sessionId,
        jobId: data.jobId,
        kind: data.kind,
        depth: data.depth,
        symbols: data.symbols,
        status: "QUEUED",
        progress: 0,
      },
      select: { id: true },
    });

    return { success: true, data: { id: comparison.id } };
  } catch (error) {
    logger.error({ error, data }, "Create comparison session service error");
    return { success: false, error: "Failed to create comparison session" };
  }
}

export async function getComparisonStatus(
  sessionId: string,
  userId?: string,
): Promise<ServiceResult<ComparisonStatusData>> {
  try {
    // IDOR-safe: filter by userId when provided so a guessed sessionId from
    // another account resolves as "not found" rather than leaking status /
    // progress / errorMessage. Action-layer callers always pass userId.
    const comparison = userId
      ? await prisma.comparisonSession.findFirst({
          where: { sessionId, userId },
          select: {
            status: true,
            progress: true,
            currentStep: true,
            errorMessage: true,
          },
        })
      : await prisma.comparisonSession.findUnique({
          where: { sessionId },
          select: {
            status: true,
            progress: true,
            currentStep: true,
            errorMessage: true,
          },
        });

    if (!comparison) {
      return { success: false, error: "Comparison not found" };
    }

    return { success: true, data: comparison };
  } catch (error) {
    logger.error({ error, sessionId }, "Get comparison status service error");
    return { success: false, error: "Failed to get comparison status" };
  }
}

export async function getComparisonBySessionId(
  sessionId: string,
  userId: string,
): Promise<ServiceResult<ComparisonFullRecord>> {
  try {
    const comparison = await prisma.comparisonSession.findFirst({
      where: { sessionId, userId },
      select: {
        id: true,
        sessionId: true,
        kind: true,
        depth: true,
        symbols: true,
        status: true,
        progress: true,
        currentStep: true,
        result: true,
        errorMessage: true,
        createdAt: true,
        completedAt: true,
      },
    });

    if (!comparison) {
      return { success: false, error: "Comparison not found" };
    }

    return {
      success: true,
      data: {
        ...comparison,
        result: comparison.result as unknown as ComparisonResult | null,
      },
    };
  } catch (error) {
    logger.error(
      { error, sessionId, userId },
      "Get comparison by session service error",
    );
    return { success: false, error: "Failed to get comparison" };
  }
}

/**
 * Recent comparison sessions in the last 24h, scoped to userId.
 * Mirrors getRecentRoastSessions: 24h window, capped at 20, newest-first.
 */
export async function getRecentComparisonSessions(
  userId: string,
): Promise<ServiceResult<RecentComparisonItem[]>> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const comparisons = await prisma.comparisonSession.findMany({
      where: {
        userId,
        createdAt: { gte: since },
      },
      select: {
        sessionId: true,
        kind: true,
        depth: true,
        symbols: true,
        status: true,
        progress: true,
        currentStep: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return { success: true, data: comparisons };
  } catch (error) {
    logger.error(
      { error, userId },
      "Get recent comparison sessions service error",
    );
    return {
      success: false,
      error: "Failed to get recent comparison sessions",
    };
  }
}

export async function updateComparisonStatus(
  sessionId: string,
  userId: string,
  data: UpdateComparisonStatusInput,
): Promise<ServiceResult<void>> {
  try {
    // MONEY-599: scope the write by userId (updateMany — no unique compound
    // key) and reject a foreign sessionId via the count guard.
    const res = await prisma.comparisonSession.updateMany({
      where: { sessionId, userId },
      data,
    });
    if (res.count === 0) {
      return { success: false, error: "Comparison session not found" };
    }

    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, sessionId, data },
      "Update comparison status service error",
    );
    return { success: false, error: "Failed to update comparison status" };
  }
}

// ── Async Comparison START (MONEY-1062 P2b — apps/api parity) ───────

export type ComparisonDepth = "deep" | "comprehensive" | "advanced" | "custom";

export interface StartComparisonInput {
  kind: ComparisonKind;
  symbols: string[];
  depth: ComparisonDepth;
}

const COMPARISON_MIN_SYMBOLS = 2;
const COMPARISON_MAX_SYMBOLS = 5;

/**
 * Resolve the credit-reservation analysis type for a comparison (mirror
 * comparison.ts:65 `resolveAnalysisType`): MF → the depth-specific cost type,
 * stock → the existing `multi_comparison` type.
 */
function resolveComparisonAnalysisType(
  kind: ComparisonKind,
  depth: ComparisonDepth,
): AnalysisType {
  if (kind === "mf") {
    return `mf_comparison_${depth}` as AnalysisType;
  }
  return "multi_comparison";
}

/**
 * Injectable IO seam for {@link startComparison}. Defaults to the shared prisma
 * / pubsub / credit-reservation / same-module services; the service tests inject
 * fakes to assert the reserve → create → publish ordering and the exact
 * reservation-refund legs on the REAL function.
 */
export interface StartComparisonDeps {
  publishComparisonJob?: (msg: ComparisonJobMessage) => Promise<string>;
  getSubscriptionAccessForUser?: (
    userId: string,
  ) => Promise<ServiceResult<SubscriptionAccess>>;
  getComposerPreferences?: (
    userId: string,
  ) => Promise<{ model?: string | null }>;
  resolveResearchModel?: (planId: string, userPick?: string | null) => string;
  estimateAnalysisCost?: (
    analysisType: AnalysisType,
    symbols?: string[],
  ) => CostEstimate;
  reserveCredits?: typeof defaultReserveCredits;
  refundReservationCredits?: typeof defaultRefundReservationCredits;
  createComparisonSession?: (
    input: CreateComparisonInput,
  ) => Promise<ServiceResult<{ id: string }>>;
  updateComparisonStatus?: (
    sessionId: string,
    userId: string,
    data: UpdateComparisonStatusInput,
  ) => Promise<ServiceResult<void>>;
}

/**
 * Start an async deep stock/MF comparison (mirror apps/web/lib/actions/
 * comparison.ts:77 `startComparisonAction`). Order:
 *   1. feature gate (aiAnalysis → PRO+); fail-to-FREE on an access-read error,
 *   2. clean + validate 2..5 symbols (fail fast BEFORE reserving credits),
 *   3. reserveCredits (L3-style reservation) — the GATE,
 *   4. createComparisonSession — on failure REFUND the full reservation
 *      (refundReservationCredits(id, 0, segments)) and stop (no publish),
 *   5. publishComparisonJob — on failure REFUND the reservation + mark the
 *      session FAILED (exactly the action's legs, comparison.ts:183-215).
 */
export async function startComparison(
  userId: string,
  input: StartComparisonInput,
  deps: StartComparisonDeps = {},
): Promise<ServiceResult<{ sessionId: string }>> {
  const publish = deps.publishComparisonJob ?? defaultPublishComparisonJob;
  const getAccess =
    deps.getSubscriptionAccessForUser ?? defaultGetSubscriptionAccessForUser;
  const composerPrefsOf =
    deps.getComposerPreferences ?? defaultGetComposerPreferences;
  const resolveModel = deps.resolveResearchModel ?? defaultResolveResearchModel;
  const estimate = deps.estimateAnalysisCost ?? defaultEstimateAnalysisCost;
  const reserve = deps.reserveCredits ?? defaultReserveCredits;
  const refundReservation =
    deps.refundReservationCredits ?? defaultRefundReservationCredits;
  const createSession = deps.createComparisonSession ?? createComparisonSession;
  const updateStatus = deps.updateComparisonStatus ?? updateComparisonStatus;

  const { kind, symbols, depth } = input;

  try {
    // ── Feature gate (mirror comparison.ts:106-113) — fail-to-FREE ────
    const access = await getAccess(userId);
    const planId = access.success ? access.data.planId : "FREE";
    if (!hasFeatureAccess(planId, "aiAnalysis")) {
      return {
        success: false,
        error: "Upgrade to access deep comparison",
        code: "UPGRADE_REQUIRED",
      };
    }

    // Tier-resolved research model (mirror comparison.ts:118-121).
    const composerPrefs = await composerPrefsOf(userId);
    const model = resolveModel(planId, composerPrefs.model);

    // ── Clean + validate input BEFORE reserving credits (comparison.ts:124-143) ──
    const cleanSymbols = Array.from(
      new Set(
        (symbols || [])
          .map((s) => (typeof s === "string" ? s.trim().toUpperCase() : ""))
          .filter((s) => s.length > 0),
      ),
    );
    if (
      cleanSymbols.length < COMPARISON_MIN_SYMBOLS ||
      cleanSymbols.length > COMPARISON_MAX_SYMBOLS
    ) {
      return {
        success: false,
        error: `Select between ${COMPARISON_MIN_SYMBOLS} and ${COMPARISON_MAX_SYMBOLS} ${
          kind === "mf" ? "funds" : "stocks"
        } to compare.`,
        code: "INVALID_INPUT",
      };
    }

    const sessionId = randomUUID();
    const jobId = randomUUID();

    // ── Reserve credits — the GATE (mirror comparison.ts:149-169) ─────
    const analysisType = resolveComparisonAnalysisType(kind, depth);
    const costEstimate = estimate(analysisType, cleanSymbols);
    const reservation = await reserve(
      userId,
      costEstimate.credits,
      analysisType,
      sessionId,
    );
    if (!reservation.success) {
      return {
        success: false,
        error: reservation.error || "Not enough credits for this comparison.",
        code:
          reservation.code === "INSUFFICIENT_CREDITS"
            ? "NO_CREDITS"
            : "INTERNAL",
      };
    }
    const { reservationId } = reservation.data;

    // ── Create the session; on failure refund the reservation ─────────
    const created = await createSession({
      userId,
      sessionId,
      jobId,
      kind,
      depth,
      symbols: cleanSymbols,
    });
    if (!created.success) {
      logger.error({ sessionId }, "Start comparison: create session failed");
      // No work done → full refund of the reservation (mirror comparison.ts:183).
      await refundReservation(reservationId, 0, costEstimate.segments);
      return {
        success: false,
        error: "Failed to start comparison. Please try again.",
        code: "INTERNAL",
      };
    }

    // ── Publish; on failure refund the reservation + mark FAILED ──────
    try {
      await publish({
        jobId,
        userId,
        sessionId,
        kind,
        depth,
        symbols: cleanSymbols,
        model,
      });
    } catch (publishError) {
      logger.error(
        { error: publishError, sessionId },
        "Start comparison publish failed",
      );
      await refundReservation(reservationId, 0, costEstimate.segments);
      await updateStatus(sessionId, userId, {
        status: "FAILED",
        errorMessage: "Failed to queue comparison job",
      });
      return {
        success: false,
        error: "Failed to start comparison. Please try again.",
        code: "INTERNAL",
      };
    }

    return { success: true, data: { sessionId } };
  } catch (error) {
    logger.error({ error, userId }, "Start comparison service error");
    return {
      success: false,
      error: "Failed to start comparison",
      code: "INTERNAL",
    };
  }
}
