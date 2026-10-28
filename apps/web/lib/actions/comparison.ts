"use server";

/**
 * Deep Comparison Server Actions (MONEY-553)
 *
 * Starts, polls, and reads results for async deep stock/MF comparison.
 * Mirrors apps/web/lib/actions/roast.ts:
 *   create session → reserve credits → publish → return sessionId.
 *
 * Credit cost (via @usemoney/services credit-reservation):
 *   - MF comparison  → `mf_comparison_${depth}` (MONEY-552 cost types)
 *   - stock comparison → `multi_comparison`
 *
 * IDOR-safe: status/result reads are scoped to the authenticated userId.
 * SEBI-safe: the underlying skills emit observations/scores/flags only.
 */

import { getAuthenticatedUser } from "@/lib/auth";
import { hasFeatureAccess } from "@usemoney/core/subscription";
import { getSubscriptionAccess } from "@/lib/subscription/access";
import { publishComparisonJob } from "@usemoney/pubsub/publish";
import { resolveResearchModel } from "@usemoney/core/gemini/model-registry";
import {
  estimateAnalysisCost,
  reserveCredits,
  refundReservationCredits,
  createComparisonSession as createComparisonSessionService,
  getComparisonStatus as getComparisonStatusService,
  getComparisonBySessionId as getComparisonBySessionIdService,
  updateComparisonStatus as updateComparisonStatusService,
  preferences as preferencesService,
  type AnalysisType,
  type ComparisonKind,
  type ComparisonResult,
} from "@usemoney/services";
import { isDemoSession } from "@/lib/demo/session";

// Re-export service types for consumers.
export type {
  CreateComparisonInput,
  ComparisonStatusData,
  ComparisonFullRecord,
  RecentComparisonItem,
  UpdateComparisonStatusInput,
  ComparisonKind,
  ComparisonResult,
} from "@usemoney/services";

export type ComparisonDepth = "deep" | "comprehensive" | "advanced" | "custom";

export type ComparisonErrorType =
  | "UNAUTHORIZED"
  | "UPGRADE_REQUIRED"
  | "INVALID_INPUT"
  | "NO_CREDITS"
  | "GENERAL";

const MIN_SYMBOLS = 2;
const MAX_SYMBOLS = 5;

/**
 * Resolve the credit-reservation analysis type for a comparison.
 * MF → depth-specific cost type; stock → the existing multi_comparison type.
 */
function resolveAnalysisType(
  kind: ComparisonKind,
  depth: ComparisonDepth
): AnalysisType {
  if (kind === "mf") {
    return `mf_comparison_${depth}` as AnalysisType;
  }
  return "multi_comparison";
}

// ── Start Comparison ───────────────────────────────────────────────

export async function startComparisonAction(
  kind: ComparisonKind,
  symbols: string[],
  depth: ComparisonDepth
): Promise<{
  success: boolean;
  sessionId?: string;
  error?: string;
  errorType?: ComparisonErrorType;
}> {
  if (await isDemoSession()) {
    return {
      success: false,
      error: "Demo mode: Sign up for a free account to use this feature!",
      errorType: "GENERAL",
    };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return {
        success: false,
        error: "Unauthorized",
        errorType: "UNAUTHORIZED",
      };
    }

    // Feature gate — deep comparison is a premium AI analysis surface (PRO+).
    const access = await getSubscriptionAccess();
    if (!hasFeatureAccess(access.planId, "aiAnalysis")) {
      return {
        success: false,
        error: "Upgrade to access deep comparison",
        errorType: "UPGRADE_REQUIRED",
      };
    }

    // MONEY-619 (Phase 3): tier-resolved research model for this comparison —
    // PRO/PREMIUM run on gemini-3.1-pro-preview, else degrade to the
    // advanced default inside the worker. Honors an explicit Pro-tier pick.
    const composerPrefs = await preferencesService.getComposerPreferences(
      authUser.userId
    );
    const model = resolveResearchModel(access.planId, composerPrefs.model);

    // Validate input (fail fast, before reserving credits).
    const cleanSymbols = Array.from(
      new Set(
        (symbols || [])
          .map((s) => (typeof s === "string" ? s.trim().toUpperCase() : ""))
          .filter((s) => s.length > 0)
      )
    );

    if (
      cleanSymbols.length < MIN_SYMBOLS ||
      cleanSymbols.length > MAX_SYMBOLS
    ) {
      return {
        success: false,
        error: `Select between ${MIN_SYMBOLS} and ${MAX_SYMBOLS} ${
          kind === "mf" ? "funds" : "stocks"
        } to compare.`,
        errorType: "INVALID_INPUT",
      };
    }

    const sessionId = crypto.randomUUID();
    const jobId = crypto.randomUUID();

    // Estimate cost + reserve credits (L3-style reservation).
    const analysisType = resolveAnalysisType(kind, depth);
    const estimate = estimateAnalysisCost(analysisType, cleanSymbols);

    const reservation = await reserveCredits(
      authUser.userId,
      estimate.credits,
      analysisType,
      sessionId
    );
    if (!reservation.success) {
      return {
        success: false,
        error: reservation.error || "Not enough credits for this comparison.",
        errorType:
          reservation.code === "INSUFFICIENT_CREDITS"
            ? "NO_CREDITS"
            : "GENERAL",
      };
    }

    const { reservationId } = reservation.data;

    // Create the QUEUED ComparisonSession via the service.
    const created = await createComparisonSessionService({
      userId: authUser.userId,
      sessionId,
      jobId,
      kind,
      depth,
      symbols: cleanSymbols,
    });
    if (!created.success) {
      console.error("[comparison] createSession failed", { sessionId });
      // Roll back the reservation (no work done → full refund).
      await refundReservationCredits(reservationId, 0, estimate.segments);
      return {
        success: false,
        error: "Failed to start comparison. Please try again.",
        errorType: "GENERAL",
      };
    }

    // Publish to the comparison-analysis topic.
    try {
      await publishComparisonJob({
        jobId,
        userId: authUser.userId,
        sessionId,
        kind,
        depth,
        symbols: cleanSymbols,
        model,
      });
    } catch (publishError) {
      console.error("[comparison] Failed to publish job:", publishError);
      // Refund reservation and mark the session FAILED.
      await refundReservationCredits(reservationId, 0, estimate.segments);
      await updateComparisonStatusService(sessionId, authUser.userId, {
        status: "FAILED",
        errorMessage: "Failed to queue comparison job",
      });
      return {
        success: false,
        error: "Failed to start comparison. Please try again.",
        errorType: "GENERAL",
      };
    }

    return { success: true, sessionId };
  } catch (error) {
    console.error("[comparison] Failed to start comparison:", error);
    return {
      success: false,
      error: "Failed to start comparison",
      errorType: "GENERAL",
    };
  }
}

// ── Get Comparison Status ──────────────────────────────────────────

export async function getComparisonStatusAction(sessionId: string): Promise<{
  success: boolean;
  data?: {
    status: string;
    progress: number;
    currentStep: string | null;
    errorMessage: string | null;
  };
  error?: string;
}> {
  // Demo sessions get a benign "not found" — never query the real DB.
  if (await isDemoSession()) {
    return { success: false, error: "Comparison not found" };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }

    // IDOR-safe: scope the lookup to the authenticated user.
    const result = await getComparisonStatusService(sessionId, authUser.userId);
    if (!result?.success) {
      return {
        success: false,
        error: result?.error || "Comparison not found",
      };
    }
    return { success: true, data: result.data };
  } catch (error) {
    console.error("[comparison] Failed to get status:", error);
    return { success: false, error: "Failed to get comparison status" };
  }
}

// ── Get Comparison Result ──────────────────────────────────────────

export async function getComparisonResultAction(sessionId: string): Promise<{
  success: boolean;
  data?: {
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
  };
  error?: string;
}> {
  if (await isDemoSession()) {
    return { success: false, error: "Comparison not found" };
  }

  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Unauthorized" };
    }

    // IDOR-safe: scope the lookup to the authenticated user.
    const result = await getComparisonBySessionIdService(
      sessionId,
      authUser.userId
    );
    if (!result?.success) {
      return {
        success: false,
        error: result?.error || "Comparison not found",
      };
    }
    return { success: true, data: result.data };
  } catch (error) {
    console.error("[comparison] Failed to get result:", error);
    return { success: false, error: "Failed to get comparison result" };
  }
}
