/**
 * Unified Credit Service
 *
 * Single credit pool that replaces the old fast/advanced/comprehensive query system.
 * Plan credits are consumed first, then pack credits.
 * Free actions (L1, follow-ups, portfolio queries) cost 0 credits.
 */

import { prisma } from "@usemoney/database";
import {
  CREDIT_COSTS,
  resolvePlanId,
  getPlanCredits,
  type PlanId,
} from "@usemoney/core";
import { dbLogger as logger } from "@usemoney/logger";
import { captureServiceEvent } from "./analytics";
import {
  computeCreditBalance,
  decideSubscriptionHeal,
  finite,
  hasEnoughCredits,
  normalizeCost,
  planConsumeSplit,
  refundSplit,
} from "./credit-logic";
import type { ServiceResult } from "./types";

// ── Types ──────────────────────────────────────────────────────────

export interface CreditBalance {
  plan: number; // remaining plan credits
  pack: number; // remaining pack credits
  total: number; // plan + pack
  planLimit: number;
  packLimit: number;
}

export interface CreditCheckResult {
  allowed: boolean;
  remaining: number;
  cost: number;
}

export interface CreditConsumeResult {
  remaining: number;
  source: "plan" | "pack";
  creditsUsed: number;
}

export interface CreditUsageRecord {
  id: string;
  action: string;
  creditsUsed: number;
  tier: string;
  symbols: string[];
  query: string | null;
  createdAt: string;
}

// ── Auto-Create FREE Subscription ─────────────────────────────────

/**
 * Ensure a subscription exists for a user. If none exists, auto-create
 * a FREE plan with 5 credits. This prevents "No subscription found"
 * errors when consumeCredits/checkCredits is called before the user
 * has visited a page that triggers getSubscription().
 */
async function ensureSubscription(userId: string) {
  const existing = await prisma.subscription.findUnique({
    where: { userId },
  });
  if (existing) {
    // Self-heal drift (MONEY-295) — pure decision shared with the tests:
    //   #1 creditsLimit below the plan's expected credits;
    //   #2 a FREE plan stuck non-ACTIVE (no payment to lapse → stale state from
    //      a prior paid plan that locks the user out of free-tier features).
    const expectedCredits = getPlanCredits(existing.planId);
    const { needsCreditsHeal, needsStatusHeal, patch } = decideSubscriptionHeal(
      {
        planId: existing.planId,
        status: existing.status,
        creditsLimit: existing.creditsLimit,
      },
      expectedCredits,
    );

    if (needsCreditsHeal || needsStatusHeal) {
      logger.info(
        {
          userId,
          planId: existing.planId,
          creditsHeal: needsCreditsHeal
            ? { was: existing.creditsLimit, expected: expectedCredits }
            : undefined,
          statusHeal: needsStatusHeal
            ? { was: existing.status, expected: "ACTIVE" }
            : undefined,
        },
        "Auto-healing subscription state",
      );

      // Telemetry - quantify how many users were stuck in stale state
      // (esp. FREE + non-ACTIVE from MONEY-295). Fire-and-forget; gated
      // on NEXT_PUBLIC_POSTHOG_KEY so workers/CI/tests no-op cleanly.
      captureServiceEvent(userId, "subscription_self_healed", {
        planId: existing.planId,
        healCredits: needsCreditsHeal,
        healStatus: needsStatusHeal,
        statusWas: needsStatusHeal ? existing.status : undefined,
        creditsLimitWas: needsCreditsHeal ? existing.creditsLimit : undefined,
        creditsLimitExpected: needsCreditsHeal ? expectedCredits : undefined,
      });

      return prisma.subscription.update({
        where: { userId },
        data: patch,
      });
    }
    return existing;
  }

  logger.info({ userId }, "Auto-creating FREE subscription for credit check");
  return prisma.subscription.create({
    data: {
      userId,
      planId: "FREE",
      status: "ACTIVE",
      aiQueriesUsed: 0,
      aiQueriesLimit: 0,
      addons: [],
      fastQueriesUsed: 0,
      fastQueriesLimit: 0,
      advancedQueriesUsed: 0,
      advancedQueriesLimit: 0,
      creditsUsed: 0,
      creditsLimit: 5,
      packCreditsUsed: 0,
      packCreditsLimit: 0,
    },
  });
}

// ── Credit Cost Lookup ─────────────────────────────────────────────

/**
 * Get credit cost for a given action.
 * For multi-comparison, call with base action + per-stock separately.
 */
export function getCreditCost(action: string): number {
  return CREDIT_COSTS[action] ?? 0;
}

// ── Check Credits ──────────────────────────────────────────────────

/**
 * Check if user has enough credits for an action (pre-flight check).
 */
export async function checkCredits(
  userId: string,
  action: string,
): Promise<ServiceResult<CreditCheckResult>> {
  try {
    const cost = getCreditCost(action);

    // Free actions always allowed
    if (cost === 0) {
      return {
        success: true,
        data: { allowed: true, remaining: -1, cost: 0 },
      };
    }

    const sub = await ensureSubscription(userId);

    // Pure affordability check: finite-guards the cost (a non-finite cost fails
    // closed, never wrongly allows via `Infinity >= cost`) and floors each
    // pool's remaining at 0 so a `used > limit` drift row can't underflow.
    const check = hasEnoughCredits(
      {
        creditsUsed: sub.creditsUsed,
        creditsLimit: sub.creditsLimit,
        packCreditsUsed: sub.packCreditsUsed,
        packCreditsLimit: sub.packCreditsLimit,
      },
      cost,
    );

    return {
      success: true,
      data: {
        allowed: check.allowed,
        remaining: check.remaining,
        cost: check.cost,
      },
    };
  } catch (error) {
    logger.error({ userId, action, error }, "Failed to check credits");
    return { success: false, error: "Failed to check credits" };
  }
}

// ── Consume Credits ────────────────────────────────────────────────

/**
 * Consume credits for an action.
 * Plan credits are used first, then pack credits if plan is exhausted.
 * Returns remaining total credits after consumption.
 */
export async function consumeCredits(
  userId: string,
  action: string,
  metadata?: {
    sessionId?: string;
    symbols?: string[];
    query?: string;
    tier?: string;
    geminiModel?: string;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
    /**
     * MONEY-229 - when the caller has applied a model premium on top
     * of the base CREDIT_COSTS[action], it should pass the effective
     * cost here. The default (undefined) preserves the existing
     * behaviour: cost = CREDIT_COSTS[action].
     */
    costOverride?: number;
  },
): Promise<ServiceResult<CreditConsumeResult>> {
  // Resolve the effective cost. A caller-supplied `costOverride` (model
  // premium) is honoured only when it is a finite, non-negative number;
  // normalizeCost rejects NaN/±Infinity/negative so a corrupt override can
  // never reach the affordability gate or a balance `increment`.
  const overrideRaw =
    typeof metadata?.costOverride === "number"
      ? normalizeCost(metadata.costOverride)
      : null;
  const cost = overrideRaw !== null ? overrideRaw : getCreditCost(action);

  // Free actions - record usage but don't charge
  if (cost === 0) {
    // Fire-and-forget usage recording for analytics
    recordUsage(userId, action, 0, metadata).catch((err) =>
      logger.error({ err }, "Failed to record free usage"),
    );
    return {
      success: true,
      data: { remaining: -1, source: "plan", creditsUsed: 0 },
    };
  }

  try {
    // Ensure a subscription exists and surface non-ACTIVE state once up
    // front. The atomic charge below re-reads the live balance, so this is
    // only for the create/heal side effect and the status gate.
    const seeded = await ensureSubscription(userId);
    if (seeded.status !== "ACTIVE") {
      return {
        success: false,
        error: "Subscription is not active. Please renew your plan.",
      };
    }

    // ── Atomic decrement (MONEY-595, A07 double-spend) ────────────────
    //
    // The previous read-modify-write (read balance → check → write an
    // ABSOLUTE `creditsUsed` value across awaits) let two concurrent
    // requests both read the same balance, both pass the check, and both
    // write the same decremented value — so only one charge landed
    // (double-spend).
    //
    // Fix: charge via a CONDITIONAL `updateMany` whose `where` re-asserts
    // the guard at write time and whose `data` uses atomic `increment`
    // (never an absolute value). `updateMany().count === 0` means another
    // request won the race and moved the balance past the guard; we
    // re-snapshot the live balance and retry a bounded number of times so
    // a lost race never spuriously reports "insufficient" while there are
    // still credits. The `creditsLimit`/`packCreditsLimit` only change on
    // plan change / pack purchase (not on consumption), so folding them
    // into the guard threshold per-attempt is safe.
    const MAX_ATTEMPTS = 4;
    let source: "plan" | "pack" = "plan";
    let remaining = 0;
    let charged = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const sub = await prisma.subscription.findUnique({
        where: { userId },
        select: {
          creditsUsed: true,
          creditsLimit: true,
          packCreditsUsed: true,
          packCreditsLimit: true,
        },
      });
      if (!sub) {
        logger.warn({ userId, action }, "subscription missing during charge");
        return { success: false, error: "Failed to consume credits" };
      }

      // Pure split decision off the freshly-read snapshot. `null` ⇒ the
      // snapshot can't cover the cost (or the cost is non-finite) — fail
      // closed. The atomic `updateMany` writes below re-assert the guard so a
      // concurrent winner that moved the balance between this read and our
      // write is caught (count === 0 → retry).
      const split = planConsumeSplit(
        {
          creditsUsed: sub.creditsUsed,
          creditsLimit: sub.creditsLimit,
          packCreditsUsed: sub.packCreditsUsed,
          packCreditsLimit: sub.packCreditsLimit,
        },
        cost,
      );
      const planRemaining = Math.max(0, sub.creditsLimit - sub.creditsUsed);
      const packRemaining = Math.max(
        0,
        sub.packCreditsLimit - sub.packCreditsUsed,
      );

      if (split === null) {
        return {
          success: false,
          error: `Not enough credits. You need ${cost} but have ${planRemaining + packRemaining} remaining.`,
          code: "INSUFFICIENT_CREDITS",
        };
      }

      if (split.source === "plan") {
        // Plan-only consumption. Guard: creditsUsed hasn't been pushed past
        // (limit - cost) by a concurrent charge between read and write.
        const planCharge = await prisma.subscription.updateMany({
          where: {
            userId,
            creditsUsed: { lte: sub.creditsLimit - cost },
          },
          data: {
            creditsUsed: { increment: cost },
            // Dual-write to legacy fields
            fastQueriesUsed: { increment: 1 },
          },
        });
        if (planCharge.count === 0) continue; // lost race — re-snapshot
        source = "plan";
        remaining = split.remaining;
        charged = true;
        break;
      }

      // Split: max out remaining plan credits + take the rest from pack.
      // Guard on packCreditsUsed so two concurrent pack charges can't both
      // succeed, and on creditsUsed so we don't clobber a concurrent plan
      // top-up — both columns must still match the snapshot we costed from.
      const fromPack = split.fromPack;
      const packCharge = await prisma.subscription.updateMany({
        where: {
          userId,
          creditsUsed: sub.creditsUsed,
          packCreditsUsed: { lte: sub.packCreditsLimit - fromPack },
        },
        data: {
          creditsUsed: sub.creditsLimit, // max out plan credits
          packCreditsUsed: { increment: fromPack },
          // Dual-write
          fastQueriesUsed: { increment: 1 },
        },
      });
      if (packCharge.count === 0) continue; // lost race — re-snapshot
      source = "pack";
      remaining = split.remaining;
      charged = true;
      break;
    }

    if (!charged) {
      // Exhausted retries under contention without landing a charge. Fail
      // closed (never grant the action without debiting).
      logger.warn(
        { userId, action, cost },
        "Credit charge lost all retries under contention",
      );
      return {
        success: false,
        error: "Could not reserve credits right now. Please try again.",
        code: "INSUFFICIENT_CREDITS",
      };
    }

    // Record usage asynchronously
    recordUsage(userId, action, cost, metadata).catch((err) =>
      logger.error({ err }, "Failed to record credit usage"),
    );

    logger.info(
      { userId, action, cost, source, remaining },
      "Credits consumed",
    );

    return {
      success: true,
      data: { remaining, source, creditsUsed: cost },
    };
  } catch (error) {
    logger.error({ userId, action, cost, error }, "Failed to consume credits");
    return { success: false, error: "Failed to consume credits" };
  }
}

// ── Refund Credits ─────────────────────────────────────────────────

/**
 * Refund credits when an operation fails after consumption.
 * Refunds to plan credits first (reverse of consumption order).
 */
export async function refundCredits(
  userId: string,
  action: string,
  amount?: number,
): Promise<ServiceResult<{ refunded: number }>> {
  // Validate the requested amount up front. A non-finite / negative refund is
  // REJECTED (not silently coerced) so it can never reach a balance write —
  // the pre-fix code did `Math.max(0, used - NaN)` === NaN and wrote NaN into
  // `creditsUsed`, permanently corrupting the column. `amount === undefined`
  // falls back to the action's catalogue cost.
  const requested =
    amount === undefined ? getCreditCost(action) : normalizeCost(amount);
  if (requested === null) {
    logger.warn(
      { userId, action, amount },
      "Rejected refund: non-finite/negative amount",
    );
    return { success: false, error: "Invalid refund amount" };
  }
  if (requested === 0) {
    return { success: true, data: { refunded: 0 } };
  }

  try {
    const sub = await ensureSubscription(userId);

    // Clamp the refund to what each pool actually owes — a refund can NEVER
    // exceed the real outstanding debit, so an over-large `amount` (or a cost
    // larger than what was charged) can't mint free credits by driving `*Used`
    // below zero.
    const refund = refundSplit(
      { creditsUsed: sub.creditsUsed, packCreditsUsed: sub.packCreditsUsed },
      requested,
    );
    if (refund === null) {
      return { success: false, error: "Invalid refund amount" };
    }

    // Atomic, underflow-proof decrements. Guarding `creditsUsed >= toPlan`
    // (resp. pack) means a concurrent consume that moved the balance between
    // our read and write can't be clobbered into a negative/overstated value;
    // a lost guard simply refunds nothing for that pool rather than corrupting
    // it. Refund is best-effort per-pool: we report what each pool conceded.
    let refundedPlan = 0;
    let refundedPack = 0;
    if (refund.toPlan > 0) {
      const r = await prisma.subscription.updateMany({
        where: { userId, creditsUsed: { gte: refund.toPlan } },
        data: { creditsUsed: { decrement: refund.toPlan } },
      });
      if (r.count > 0) refundedPlan = refund.toPlan;
    }
    if (refund.toPack > 0) {
      const r = await prisma.subscription.updateMany({
        where: { userId, packCreditsUsed: { gte: refund.toPack } },
        data: { packCreditsUsed: { decrement: refund.toPack } },
      });
      if (r.count > 0) refundedPack = refund.toPack;
    }

    const refundAmount = refundedPlan + refundedPack;
    logger.info({ userId, action, refunded: refundAmount }, "Credits refunded");

    return { success: true, data: { refunded: refundAmount } };
  } catch (error) {
    logger.error({ userId, action, error }, "Failed to refund credits");
    return { success: false, error: "Failed to refund credits" };
  }
}

// ── Get Balance ────────────────────────────────────────────────────

/**
 * Get current credit balance for a user.
 */
export async function getCreditBalance(
  userId: string,
): Promise<ServiceResult<CreditBalance>> {
  try {
    const subscription = await prisma.subscription.findUnique({
      where: { userId },
      select: {
        planId: true,
        creditsUsed: true,
        creditsLimit: true,
        packCreditsUsed: true,
        packCreditsLimit: true,
      },
    });

    if (!subscription) {
      return {
        success: true,
        data: { plan: 5, pack: 0, total: 5, planLimit: 5, packLimit: 0 },
      };
    }

    // Use plan config as source of truth for limit (DB may be stale)
    const { getPlanCredits } =
      await import("@usemoney/core/subscription/plans");
    const planCreditsLimit = getPlanCredits(subscription.planId);
    const effectiveLimit = Math.max(
      finite(planCreditsLimit),
      finite(subscription.creditsLimit),
    );

    // Same finite-guarded, floored-at-0 math as the affordability path, so a
    // corrupt stored column surfaces a safe balance instead of `₹NaN`.
    const { plan, pack } = computeCreditBalance(
      {
        creditsUsed: subscription.creditsUsed,
        creditsLimit: subscription.creditsLimit,
        packCreditsUsed: subscription.packCreditsUsed,
        packCreditsLimit: subscription.packCreditsLimit,
      },
      effectiveLimit,
    );

    return {
      success: true,
      data: {
        plan,
        pack,
        total: plan + pack,
        planLimit: effectiveLimit,
        packLimit: subscription.packCreditsLimit,
      },
    };
  } catch (error) {
    logger.error({ userId, error }, "Failed to get credit balance");
    return { success: false, error: "Failed to get credit balance" };
  }
}

// ── Record Usage ───────────────────────────────────────────────────

/**
 * Record credit usage for metering and analytics.
 */
export async function recordUsage(
  userId: string,
  action: string,
  credits: number,
  metadata?: {
    sessionId?: string;
    symbols?: string[];
    query?: string;
    tier?: string;
    geminiModel?: string;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
  },
): Promise<void> {
  try {
    await prisma.creditUsage.create({
      data: {
        userId,
        action,
        creditsUsed: credits,
        sessionId: metadata?.sessionId ?? null,
        symbols: metadata?.symbols ?? [],
        query: metadata?.query?.slice(0, 500) ?? null, // truncate
        tier: metadata?.tier ?? (credits === 0 ? "L1" : "L2"),
        geminiModel: metadata?.geminiModel ?? null,
        inputTokens: metadata?.inputTokens ?? null,
        outputTokens: metadata?.outputTokens ?? null,
        estimatedCostUsd: metadata?.estimatedCostUsd ?? null,
      },
    });
  } catch (error) {
    // Non-critical - log but don't fail the parent operation
    logger.error({ userId, action, error }, "Failed to record credit usage");
  }
}

// ── Usage History ──────────────────────────────────────────────────

/**
 * Get credit usage history for a user (paginated).
 */
export async function getCreditUsageHistory(
  userId: string,
  options?: { skip?: number; limit?: number; action?: string },
): Promise<ServiceResult<{ items: CreditUsageRecord[]; total: number }>> {
  const skip = options?.skip ?? 0;
  const limit = Math.min(options?.limit ?? 50, 100);

  try {
    const where: Record<string, unknown> = { userId };
    if (options?.action) {
      where.action = options.action;
    }

    const [items, total] = await Promise.all([
      prisma.creditUsage.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          action: true,
          creditsUsed: true,
          tier: true,
          symbols: true,
          query: true,
          createdAt: true,
        },
      }),
      prisma.creditUsage.count({ where }),
    ]);

    return {
      success: true,
      data: {
        items: items.map((item) => ({
          ...item,
          createdAt: item.createdAt.toISOString(),
        })),
        total,
      },
    };
  } catch (error) {
    logger.error({ userId, error }, "Failed to get credit usage history");
    return { success: false, error: "Failed to get usage history" };
  }
}
