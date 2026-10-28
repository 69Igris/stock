/**
 * Credit Reservation Service
 *
 * Manages credit reservation, commitment, and refund lifecycle for L3 comprehensive analysis.
 * Uses Redis-based locking to prevent race conditions on concurrent reservations.
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import { randomUUID } from "crypto";
import {
  canCommitReservation,
  canRefundReservation,
  checkReservationRequest,
  computeComprehensiveAvailable,
  computeReservationExpiry,
  computeReservationRefund,
  finite,
} from "./credit-logic";
import type { ServiceResult } from "./types";

// ── Types ──────────────────────────────────────────────────────────

export type AnalysisType =
  | "comprehensive_stock"
  | "multi_comparison"
  | "portfolio_optimization"
  | "portfolio_roast"
  | "l4_comprehensive"
  | "mf_analysis"
  | "mf_comparison_deep"
  | "mf_comparison_comprehensive"
  | "mf_comparison_advanced"
  | "mf_comparison_custom";

export interface CostEstimate {
  credits: number;
  estimatedMinutes: number;
  segments: number;
}

/**
 * Optional cost modifiers for analyses whose price scales beyond the raw
 * fund/symbol count. MF-comparison depths (MONEY-552) bill on:
 *   - the number of underlying portfolio constituents actually analyzed
 *   - the number of comparison parameters requested
 *   - (custom depth only) the model tier — "pro" carries a multiplier
 */
export interface AnalysisCostOptions {
  /** Number of underlying portfolio constituents (stocks) analyzed across the funds. */
  underlyingStocks?: number;
  /** Number of comparison parameters / dimensions requested. */
  params?: number;
  /** Model tier driving the analysis. "pro" applies a multiplier (custom depth only). */
  modelTier?: "flash" | "pro";
}

export interface ReservationData {
  reservationId: string;
  creditsReserved: number;
  expiresAt: Date;
}

// ── Cost Estimation ────────────────────────────────────────────────

interface AnalysisCostConfig {
  baseCredits: number;
  /** Per additional fund/symbol beyond the first. */
  perStockCredit: number;
  segments: number;
  estimatedMinutes: number;
  /** Per underlying portfolio constituent analyzed (MF-comparison depths). */
  perUnderlyingCredit?: number;
  /** Per comparison parameter / dimension (MF-comparison depths). */
  perParamCredit?: number;
  /**
   * Hard ceiling on total billed credits. The estimate is clamped to this
   * value no matter how many funds / underlyings / params are requested.
   * MF-comparison caps (MONEY-552):
   *   deep → 50, comprehensive → 75, advanced → 100, custom → 100 (depth default).
   */
  hardCap?: number;
  /** Multiplier applied when modelTier === "pro" (custom depth only). */
  proModelMultiplier?: number;
}

const ANALYSIS_COSTS: Record<AnalysisType, AnalysisCostConfig> = {
  comprehensive_stock: {
    baseCredits: 5,
    perStockCredit: 0,
    segments: 6,
    estimatedMinutes: 15,
  },
  multi_comparison: {
    // Bumped to L4-comprehensive depth per user direction (2026-05-08):
    // every stock in the comparison gets the full L4 segment bundle, so
    // base + per-stock both reflect the per-symbol comprehensive cost.
    // 5 stocks = 8 + 8×4 = 40 credits, 12 segments per stock + synthesis.
    baseCredits: 8,
    perStockCredit: 8,
    segments: 12,
    estimatedMinutes: 25,
  },
  portfolio_optimization: {
    baseCredits: 5,
    perStockCredit: 0,
    segments: 4,
    estimatedMinutes: 10,
  },
  portfolio_roast: {
    baseCredits: 3,
    perStockCredit: 0,
    segments: 3,
    estimatedMinutes: 8,
  },
  l4_comprehensive: {
    baseCredits: 8,
    perStockCredit: 0,
    segments: 12,
    estimatedMinutes: 25,
  },
  // ── Single-fund StockSage deep dive (MONEY-446) ──────────────────
  // One mutual fund analysed in depth (overview + holdings + peers +
  // risk-adjusted compute + synthesis). Cost scales with the number of
  // underlying portfolio constituents actually analysed, then clamps to
  // a HARD CAP of 30 — heavier than a single stock (5) yet well below
  // the multi-fund comparison caps (50/75/100). `funds` is always 1, so
  // perStockCredit stays 0; the underlying-constituent term carries the
  // scaling.
  mf_analysis: {
    baseCredits: 6,
    perStockCredit: 0,
    perUnderlyingCredit: 0.5, // per underlying constituent analysed
    segments: 6,
    estimatedMinutes: 8,
    hardCap: 30,
  },
  // ── MF Comparison Depths (MONEY-552) ─────────────────────────────
  // Cost scales with: number of funds, number of underlying portfolio
  // constituents analyzed, and number of comparison parameters. Each
  // depth is clamped to a hard cap so deep dives can never run away.
  mf_comparison_deep: {
    baseCredits: 10,
    perStockCredit: 6, // per additional fund
    perUnderlyingCredit: 0.5, // per underlying constituent
    perParamCredit: 1, // per comparison parameter
    segments: 6,
    estimatedMinutes: 12,
    hardCap: 50,
  },
  mf_comparison_comprehensive: {
    baseCredits: 15,
    perStockCredit: 8,
    perUnderlyingCredit: 0.75,
    perParamCredit: 1.5,
    segments: 9,
    estimatedMinutes: 18,
    hardCap: 75,
  },
  mf_comparison_advanced: {
    baseCredits: 20,
    perStockCredit: 10,
    perUnderlyingCredit: 1,
    perParamCredit: 2,
    segments: 12,
    estimatedMinutes: 25,
    hardCap: 100,
  },
  mf_comparison_custom: {
    baseCredits: 20,
    perStockCredit: 10,
    perUnderlyingCredit: 1,
    perParamCredit: 2,
    segments: 12,
    estimatedMinutes: 30,
    // Default cap mirrors the deepest (advanced) depth.
    hardCap: 100,
    proModelMultiplier: 1.5,
  },
};

const MF_COMPARISON_TYPES: ReadonlySet<AnalysisType> = new Set<AnalysisType>([
  "mf_comparison_deep",
  "mf_comparison_comprehensive",
  "mf_comparison_advanced",
  "mf_comparison_custom",
]);

/**
 * Analysis types whose cost scales with the number of underlying portfolio
 * constituents analysed and is clamped to a hard cap. Single-fund StockSage
 * (`mf_analysis`, MONEY-446) joins the multi-fund comparison depths here; the
 * comparison-only extras (param credits + pro multiplier) remain gated behind
 * MF_COMPARISON_TYPES below.
 */
const UNDERLYING_SCALED_TYPES: ReadonlySet<AnalysisType> =
  new Set<AnalysisType>(["mf_analysis", ...MF_COMPARISON_TYPES]);

/**
 * Estimate the cost of an analysis in credits.
 *
 * For most analysis types the cost is `base + perStock × (funds − 1)`.
 *
 * MF-comparison depths (MONEY-552) additionally scale with the number of
 * underlying portfolio constituents analyzed and the number of comparison
 * parameters, then clamp to a HARD CAP so a deep dive can never run away:
 *
 *   mf_comparison_deep          → cap  50
 *   mf_comparison_comprehensive → cap  75
 *   mf_comparison_advanced      → cap 100
 *   mf_comparison_custom        → cap 100 (the deepest depth's default cap)
 *
 * Formula (clamped):
 *   min(cap, base
 *            + perFund        × (funds − 1)
 *            + perUnderlying  × underlyingStocks
 *            + perParam       × params
 *       ) × (modelTier === "pro" ? proModelMultiplier : 1)   // custom only
 *
 * The optional `opts` argument is additive — existing two-arg callers keep
 * their previous behaviour unchanged.
 */
export function estimateAnalysisCost(
  analysisType: AnalysisType,
  symbols?: string[],
  opts?: AnalysisCostOptions,
): CostEstimate {
  const config = ANALYSIS_COSTS[analysisType];
  const stockCount = symbols?.length ?? 1;
  const funds = Math.max(1, stockCount);

  // finite-guard the scaling inputs: a NaN/Infinity `underlyingStocks`/`params`
  // would poison `credits` (then flow into the reservation as the amount to
  // debit). `Math.max(0, NaN)` is NaN, so guard BEFORE the floor.
  const underlyingStocks = Math.max(0, finite(opts?.underlyingStocks ?? 0));
  const params = Math.max(0, finite(opts?.params ?? 0));

  let credits =
    config.baseCredits + config.perStockCredit * Math.max(0, funds - 1);

  if (UNDERLYING_SCALED_TYPES.has(analysisType)) {
    credits += (config.perUnderlyingCredit ?? 0) * underlyingStocks;

    // Comparison-only extras: per-parameter credits + the custom-depth pro
    // multiplier. Single-fund mf_analysis bills purely on constituents.
    if (MF_COMPARISON_TYPES.has(analysisType)) {
      credits += (config.perParamCredit ?? 0) * params;

      // Pro model multiplier — custom depth only.
      if (
        analysisType === "mf_comparison_custom" &&
        opts?.modelTier === "pro" &&
        config.proModelMultiplier
      ) {
        credits *= config.proModelMultiplier;
      }
    }

    // Clamp to the hard cap, then round up to a whole credit.
    const cap = config.hardCap ?? credits;
    credits = Math.ceil(Math.min(cap, credits));
  }

  const segments =
    analysisType === "multi_comparison"
      ? funds + 1 // one per stock + synthesis
      : config.segments;

  return {
    credits,
    estimatedMinutes: config.estimatedMinutes,
    segments,
  };
}

// ── Reserve Credits ────────────────────────────────────────────────

/**
 * Reserve credits for a comprehensive analysis.
 * Atomically checks availability, decrements available credits, and creates a reservation record.
 * Reservation expires after 30 minutes if not committed.
 */
export async function reserveCredits(
  userId: string,
  credits: number,
  analysisType: AnalysisType,
  sessionId?: string,
): Promise<ServiceResult<ReservationData>> {
  const reservationId = `res-${randomUUID()}`;

  try {
    // Fetch subscription
    const subscription = await prisma.subscription.findUnique({
      where: { userId },
      select: {
        comprehensiveCreditsUsed: true,
        comprehensiveCreditsLimit: true,
        planId: true,
      },
    });

    if (!subscription) {
      return { success: false, error: "No subscription found" };
    }

    // Validate the request: a non-finite / negative / zero `credits` is
    // rejected. A NEGATIVE `credits` previously slipped through `available <
    // credits` (false) and then `increment: credits` DECREMENTED used — minting
    // free comprehensive credits AND creating a reservation that could later be
    // committed/refunded. `checkReservationRequest` normalises + bounds it.
    const check = checkReservationRequest(
      {
        comprehensiveCreditsUsed: subscription.comprehensiveCreditsUsed,
        comprehensiveCreditsLimit: subscription.comprehensiveCreditsLimit,
      },
      credits,
    );
    if (!check.ok) {
      if (check.reason === "invalid_amount") {
        return { success: false, error: "Invalid credit amount" };
      }
      return {
        success: false,
        error: `Insufficient comprehensive credits. Available: ${check.available}, Required: ${check.credits}`,
        code: "INSUFFICIENT_CREDITS",
      };
    }
    const reserveCost = check.credits; // normalised positive integer

    const expiresAt = computeReservationExpiry();

    // ── Atomic reservation debit (check-then-write double-spend fix) ──
    //
    // The previous flow checked availability OUTSIDE the transaction, then did
    // an unconditional `increment` INSIDE it. Two concurrent reservations both
    // read the same `available`, both passed the check, and both incremented —
    // overshooting the limit (negative available / over-spend). Fix: a
    // CONDITIONAL `updateMany` whose `where` re-asserts the guard at write time
    // (`comprehensiveCreditsUsed <= limit - cost`). `count === 0` ⇒ a
    // concurrent reservation won the race and moved used past the guard, so we
    // reject as insufficient rather than overshoot.
    const debit = await prisma.subscription.updateMany({
      where: {
        userId,
        comprehensiveCreditsUsed: {
          lte: subscription.comprehensiveCreditsLimit - reserveCost,
        },
      },
      data: { comprehensiveCreditsUsed: { increment: reserveCost } },
    });
    if (debit.count === 0) {
      return {
        success: false,
        error: `Insufficient comprehensive credits. Available: ${check.available}, Required: ${reserveCost}`,
        code: "INSUFFICIENT_CREDITS",
      };
    }

    try {
      await prisma.creditReservation.create({
        data: {
          userId,
          reservationId,
          creditsReserved: reserveCost,
          analysisType,
          sessionId,
          status: "RESERVED",
          expiresAt,
        },
      });
    } catch (createErr) {
      // The debit landed but the reservation record failed to persist — undo
      // the debit so we never strand the user's credits with no reservation to
      // refund them. Guarded decrement so a concurrent change can't underflow.
      await prisma.subscription
        .updateMany({
          where: {
            userId,
            comprehensiveCreditsUsed: { gte: reserveCost },
          },
          data: { comprehensiveCreditsUsed: { decrement: reserveCost } },
        })
        .catch(() => {});
      throw createErr;
    }

    logger.info(
      { userId, reservationId, credits: reserveCost, analysisType },
      "Credits reserved",
    );

    return {
      success: true,
      data: { reservationId, creditsReserved: reserveCost, expiresAt },
    };
  } catch (error) {
    logger.error({ userId, credits, error }, "Failed to reserve credits");
    return {
      success: false,
      error: "Failed to reserve credits. Please try again.",
    };
  }
}

// ── Commit Credits ─────────────────────────────────────────────────

/**
 * Mark a reservation as committed (analysis completed successfully).
 */
export async function commitCredits(
  reservationId: string,
): Promise<ServiceResult<{ committed: number }>> {
  try {
    const reservation = await prisma.creditReservation.findUnique({
      where: { reservationId },
    });

    if (!reservation) {
      return { success: false, error: "Reservation not found" };
    }

    // Only a still-open (RESERVED/ACTIVE) reservation may commit — a COMMITTED
    // one must not commit twice; a REFUNDED/EXPIRED one is terminal.
    if (!canCommitReservation(reservation.status)) {
      return {
        success: false,
        error: `Cannot commit reservation in ${reservation.status} status`,
      };
    }

    // Atomic state transition: guard on the still-open status so two concurrent
    // commits (or a commit racing a refund) can't both win. `count === 0` ⇒
    // someone else already moved it out of the open state.
    const committed = await prisma.creditReservation.updateMany({
      where: {
        reservationId,
        status: { in: ["RESERVED", "ACTIVE"] },
      },
      data: {
        status: "COMMITTED",
        creditsUsed: reservation.creditsReserved,
      },
    });
    if (committed.count === 0) {
      return {
        success: false,
        error: "Reservation already settled",
      };
    }

    logger.info(
      { reservationId, committed: reservation.creditsReserved },
      "Credits committed",
    );

    return {
      success: true,
      data: { committed: reservation.creditsReserved },
    };
  } catch (error) {
    logger.error({ reservationId, error }, "Failed to commit credits");
    return { success: false, error: "Failed to commit credits" };
  }
}

// ── Refund Credits ─────────────────────────────────────────────────

/**
 * Refund unused credits when an analysis fails or is cancelled partway through.
 * Refund amount is proportional to remaining segments.
 */
export async function refundReservationCredits(
  reservationId: string,
  completedSegments: number,
  totalSegments: number,
): Promise<ServiceResult<{ refunded: number }>> {
  try {
    const reservation = await prisma.creditReservation.findUnique({
      where: { reservationId },
    });

    if (!reservation) {
      return { success: false, error: "Reservation not found" };
    }

    // A COMMITTED reservation is terminal — refunding it would mint free
    // credits (the "committed-then-released" exploit). A REFUNDED one must not
    // refund twice.
    if (!canRefundReservation(reservation.status)) {
      return {
        success: false,
        error: `Cannot refund reservation in ${reservation.status} status`,
      };
    }

    // Proportional refund, clamped to [0, creditsReserved]. The live formula
    // let a NEGATIVE `completedSegments` (or a non-finite count) drive the
    // completion ratio < 0, so `(1 − ratio) > 1` and the refund EXCEEDED what
    // was reserved — decrementing `comprehensiveCreditsUsed` below this
    // reservation's contribution = free credits. `computeReservationRefund`
    // finite-guards `creditsReserved`, clamps the ratio to [0, 1], and bounds
    // the result.
    const creditsToRefund = computeReservationRefund(
      reservation.creditsReserved,
      completedSegments,
      totalSegments,
    );

    if (creditsToRefund <= 0) {
      // Completed enough to not warrant a refund - just commit
      return commitCredits(reservationId).then((r) =>
        r.success ? { success: true as const, data: { refunded: 0 } } : r,
      );
    }

    // State-guarded refund. The reservation status flip is the LOCK: a
    // conditional `updateMany` (refundable → REFUNDED) atomically claims the
    // refund, so two concurrent refunds — or a refund racing a commit — can't
    // both win. We decrement the user's used credits ONLY when we won the flip
    // (`count === 1`); otherwise we never touch the balance, so a lost race is
    // a clean no-op (no unbalanced decrement, no double refund).
    const claim = await prisma.creditReservation.updateMany({
      where: {
        reservationId,
        status: { notIn: ["REFUNDED", "COMMITTED"] },
      },
      data: {
        status: "REFUNDED",
        creditsRefunded: creditsToRefund,
        creditsUsed: reservation.creditsReserved - creditsToRefund,
      },
    });
    if (claim.count === 0) {
      logger.warn({ reservationId }, "Refund lost race to concurrent settle");
      return { success: false, error: "Reservation already settled" };
    }

    // We own the refund — return the credits. Guarded decrement so it can never
    // drive `comprehensiveCreditsUsed` below 0 (a corrupt/over-counted row).
    await prisma.subscription.updateMany({
      where: {
        userId: reservation.userId,
        comprehensiveCreditsUsed: { gte: creditsToRefund },
      },
      data: {
        comprehensiveCreditsUsed: { decrement: creditsToRefund },
      },
    });

    logger.info(
      {
        reservationId,
        refunded: creditsToRefund,
        completedSegments,
        totalSegments,
      },
      "Credits refunded",
    );

    return { success: true, data: { refunded: creditsToRefund } };
  } catch (error) {
    logger.error({ reservationId, error }, "Failed to refund credits");
    return { success: false, error: "Failed to refund credits" };
  }
}

// ── Check Availability ─────────────────────────────────────────────

/**
 * Check if a user has enough comprehensive credits for an analysis.
 */
export async function checkCreditAvailability(
  userId: string,
  creditsNeeded: number,
): Promise<ServiceResult<{ available: number; sufficient: boolean }>> {
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { userId },
      select: {
        comprehensiveCreditsUsed: true,
        comprehensiveCreditsLimit: true,
      },
    });

    if (!subscription) {
      return { success: true, data: { available: 0, sufficient: false } };
    }

    // Finite-guarded, floored-at-0 available so a corrupt stored column can't
    // surface a NaN/negative available. A non-finite `creditsNeeded` makes the
    // `available >= needed` comparison false (fails closed), which is correct —
    // an invalid request is never "sufficient".
    const available = computeComprehensiveAvailable(subscription);

    return {
      success: true,
      data: { available, sufficient: available >= creditsNeeded },
    };
  } catch (error) {
    logger.error({ userId, error }, "Failed to check credit availability");
    return { success: false, error: "Failed to check credits" };
  }
}

// ── Cleanup Expired ────────────────────────────────────────────────

/**
 * Clean up expired reservations and refund credits.
 * Should be called periodically (e.g., via Cloud Scheduler every 15 min).
 */
export async function cleanupExpiredReservations(): Promise<
  ServiceResult<{ cleaned: number }>
> {
  try {
    const expired = await prisma.creditReservation.findMany({
      where: {
        status: "RESERVED",
        expiresAt: { lt: new Date() },
      },
    });

    let cleaned = 0;
    for (const reservation of expired) {
      await prisma.$transaction([
        prisma.subscription.update({
          where: { userId: reservation.userId },
          data: {
            comprehensiveCreditsUsed: {
              decrement: reservation.creditsReserved,
            },
          },
        }),
        prisma.creditReservation.update({
          where: { id: reservation.id },
          data: {
            status: "EXPIRED",
            creditsRefunded: reservation.creditsReserved,
          },
        }),
      ]);
      cleaned++;
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, "Cleaned up expired credit reservations");
    }

    return { success: true, data: { cleaned } };
  } catch (error) {
    logger.error({ error }, "Failed to cleanup expired reservations");
    return { success: false, error: "Cleanup failed" };
  }
}
