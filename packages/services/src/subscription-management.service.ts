/**
 * Subscription-management service — MONEY-1062 (P4e).
 *
 * The USER-INITIATED side of the MONEY-482 scheduled-plan-change surface,
 * extracted VERBATIM from `apps/web/lib/actions/subscription.ts` so apps/api's
 * `/v1/subscription/{schedule-cancel,schedule-downgrade,unschedule,
 * preview-change,ai-credits}` are thin wrappers over the SAME logic the web
 * server actions run:
 *
 *   - {@link scheduleSubscriptionCancel}    ← scheduleCancelAction
 *   - {@link scheduleSubscriptionDowngrade} ← scheduleDowngradeAction
 *   - {@link unscheduleSubscriptionChange}  ← unscheduleChangeAction
 *   - {@link previewSubscriptionChange}     ← previewPlanChangeAction (read-only)
 *   - {@link computeAiCreditsPreflight}     ← checkAICreditsAction (pure math)
 *
 * This is DISTINCT from `scheduled-plan-changes.service.ts` — that file is the
 * hourly CRON body that APPLIES a due schedule; this file is where the user
 * STAMPS one. It is also distinct from `subscription.service.ts`'s
 * `cancelSubscription` (which stamps `cancelledAt`): `scheduleCancelAction` is
 * the plan-page "downgrade to Free at term end" affordance and stamps only the
 * scheduled-* fields.
 *
 * MONEY-PATH: every Dodo call stays IN this service with the SAME swallow-and-log
 * posture as the web action (a Dodo failure never aborts the local schedule
 * stamp — worst case one extra billing cycle we refund manually). The web
 * `getAuthenticatedUser()` gate is dropped: the route's authMiddleware already
 * resolved the caller's Mongo `userId`, which every read/write is scoped to.
 *
 * Injectable IO seam (`deps`): `@usemoney/services` runs its suite as ESM, so
 * tests pass a fake `prisma` + fake `dodo` rather than module-mocking — this is
 * how the service tests assert "NO Dodo call on a gate failure".
 *
 * @see apps/web/lib/actions/subscription.ts (scheduleCancelAction et al.)
 * @see packages/services/src/scheduled-plan-changes.service.ts (the CRON twin)
 * @see packages/services/__tests__/parity-p4e-subscription-management.service.test.ts
 */

import { prisma } from "@usemoney/database";
import { paymentsLogger as logger } from "@usemoney/logger";
import { PLAN_CONFIG } from "@usemoney/core/subscription";
import { dodoClient } from "@usemoney/core/payments";
import {
  classifyTransition,
  computeTierUpgradeBonusDays,
  computeCycleAppendDays,
  daysRemaining,
  STANDARD_TERM_DAYS,
  type BillingCycle,
  type TransitionKind,
} from "@usemoney/core/subscription/proration";
import type { ServiceResult } from "./types";

/**
 * The single Dodo method these flows touch (auto-renew on/off). Typed as a
 * narrow structural interface so a fake can be injected in tests without pulling
 * the whole SDK surface.
 */
export interface DodoSubscriptionUpdater {
  subscriptions: {
    update(
      subscriptionId: string,
      body: { cancel_at_next_billing_date: boolean },
    ): Promise<unknown>;
  };
}

/** Injectable IO seam for the scheduled-change writers. */
export interface SubscriptionMgmtDeps {
  prisma?: typeof prisma;
  dodo?: DodoSubscriptionUpdater;
  now?: () => Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Resolve the injected (or real) Dodo client. */
function resolveDodo(deps: SubscriptionMgmtDeps): DodoSubscriptionUpdater {
  return deps.dodo ?? (dodoClient as unknown as DodoSubscriptionUpdater);
}

// ── Schedule cancel (→ FREE at term end) ────────────────────────────────────

export interface ScheduleChangeResult {
  scheduledEffectiveAt: string;
}

/**
 * Schedule a cancellation: keep full access until the current billing period
 * ends, then drop to FREE. Mirrors `scheduleCancelAction`:
 *   - stamps `scheduledPlanId="FREE"` / `scheduledEffectiveAt=<term end>`,
 *   - tells Dodo `cancel_at_next_billing_date:true` (swallow+log on failure —
 *     the local schedule still stands so the cron downgrades at expiry),
 *   - derives the term end from `startDate + period` when a first-cycle row has
 *     neither `endDate` nor `nextBillingDate` (never cut the paid term short).
 *
 * Gate failures return a `code` the route maps to HTTP:
 *   - no subscription → `NOT_FOUND`,
 *   - already FREE     → `ALREADY_FREE`,
 *   - no derivable term end → `NO_TERM_END`.
 */
export async function scheduleSubscriptionCancel(
  userId: string,
  deps: SubscriptionMgmtDeps = {},
): Promise<ServiceResult<ScheduleChangeResult>> {
  const db = deps.prisma ?? prisma;
  const dodo = resolveDodo(deps);
  try {
    const sub = await db.subscription.findUnique({ where: { userId } });
    if (!sub) {
      return {
        success: false,
        error: "No active subscription found",
        code: "NOT_FOUND",
      };
    }
    if (sub.planId === "FREE") {
      return {
        success: false,
        error: "You are already on the Free plan",
        code: "ALREADY_FREE",
      };
    }

    // First-cycle rows can have neither endDate nor nextBillingDate — derive the
    // term end from startDate + period rather than refusing the cancel.
    const derivedEnd = sub.startDate
      ? new Date(
          sub.startDate.getTime() +
            (sub.billingPeriod === "annual" ? 365 : 30) * MS_PER_DAY,
        )
      : null;
    const effectiveAt = sub.endDate ?? sub.nextBillingDate ?? derivedEnd;
    if (!effectiveAt) {
      return {
        success: false,
        error:
          "Could not determine your billing period end date. Please contact support.",
        code: "NO_TERM_END",
      };
    }

    // Stop Dodo auto-renew. A failure here is logged but does NOT abort — the
    // local schedule still gets stamped (mirrors the web action exactly).
    if (sub.dodoSubscriptionId) {
      try {
        await dodo.subscriptions.update(sub.dodoSubscriptionId, {
          cancel_at_next_billing_date: true,
        });
      } catch (dodoErr) {
        logger.error(
          { error: dodoErr, userId, action: "scheduleSubscriptionCancel" },
          "Dodo cancel_at_next_billing_date update failed (local schedule still set)",
        );
      }
    }

    await db.subscription.update({
      where: { userId },
      data: {
        scheduledPlanId: "FREE",
        scheduledBillingPeriod: null,
        scheduledEffectiveAt: effectiveAt,
      },
    });

    return {
      success: true,
      data: { scheduledEffectiveAt: effectiveAt.toISOString() },
    };
  } catch (error) {
    logger.error(
      { error, userId, action: "scheduleSubscriptionCancel" },
      "Schedule cancel error",
    );
    return { success: false, error: "Failed to schedule cancellation" };
  }
}

// ── Schedule tier / cycle downgrade ─────────────────────────────────────────

/**
 * Schedule a tier or cycle downgrade (PREMIUM→PRO same cycle, or
 * PRO annual→PRO monthly). The user keeps their current plan + cycle until
 * expiry, then the cron flips them. Mirrors `scheduleDowngradeAction`:
 *   - NO Dodo call (the sub stays alive to term-end; the cron creates the new
 *     Dodo sub on the effective date),
 *   - stamps `scheduledPlanId` / `scheduledBillingPeriod` / `scheduledEffectiveAt`.
 */
export async function scheduleSubscriptionDowngrade(
  userId: string,
  targetPlanId: "PRO" | "PREMIUM",
  targetCycle: "monthly" | "annual",
  deps: SubscriptionMgmtDeps = {},
): Promise<ServiceResult<ScheduleChangeResult>> {
  const db = deps.prisma ?? prisma;
  try {
    const sub = await db.subscription.findUnique({ where: { userId } });
    if (!sub) {
      return {
        success: false,
        error: "No active subscription found",
        code: "NOT_FOUND",
      };
    }

    const effectiveAt = sub.endDate ?? sub.nextBillingDate;
    if (!effectiveAt) {
      return {
        success: false,
        error: "Could not determine your billing period end date.",
        code: "NO_TERM_END",
      };
    }

    await db.subscription.update({
      where: { userId },
      data: {
        scheduledPlanId: targetPlanId,
        scheduledBillingPeriod: targetCycle,
        scheduledEffectiveAt: effectiveAt,
      },
    });

    return {
      success: true,
      data: { scheduledEffectiveAt: effectiveAt.toISOString() },
    };
  } catch (error) {
    logger.error(
      { error, userId, action: "scheduleSubscriptionDowngrade" },
      "Schedule downgrade error",
    );
    return { success: false, error: "Failed to schedule downgrade" };
  }
}

// ── Unschedule (undo a pending scheduled change) ────────────────────────────

/**
 * Clear a pending scheduled change (the "Undo" affordance). Mirrors
 * `unscheduleChangeAction`:
 *   - nothing scheduled → idempotent no-op (success),
 *   - SECURITY: a coupon/trial FREE-grant (scheduledPlanId="FREE" with NO
 *     dodoSubscriptionId) is NOT user-cancellable — clearing it would strand the
 *     user on the paid plan forever for free → `COUPON_GRANT`,
 *   - a real paid cancellation (FREE + dodoSubscriptionId) re-enables Dodo
 *     auto-renew (swallow+log on failure) before clearing the schedule.
 */
export async function unscheduleSubscriptionChange(
  userId: string,
  deps: SubscriptionMgmtDeps = {},
): Promise<ServiceResult<{ unscheduled: boolean }>> {
  const db = deps.prisma ?? prisma;
  const dodo = resolveDodo(deps);
  try {
    const sub = await db.subscription.findUnique({ where: { userId } });
    if (!sub) {
      return {
        success: false,
        error: "No active subscription found",
        code: "NOT_FOUND",
      };
    }

    if (!sub.scheduledPlanId) {
      // Already nothing scheduled — idempotent no-op.
      return { success: true, data: { unscheduled: false } };
    }

    // A coupon/trial free-grant's auto-downgrade IS the term limit of the grant
    // — not user-cancellable (would strand them on the paid plan for free).
    if (sub.scheduledPlanId === "FREE" && !sub.dodoSubscriptionId) {
      return {
        success: false,
        error:
          "This plan was granted by a coupon and ends at the end of its term — it can't be extended.",
        code: "COUPON_GRANT",
      };
    }

    // Paid cancellation: re-enable Dodo auto-renew so billing continues after
    // the current term. Swallow+log on failure (local schedule cleared anyway).
    if (sub.scheduledPlanId === "FREE" && sub.dodoSubscriptionId) {
      try {
        await dodo.subscriptions.update(sub.dodoSubscriptionId, {
          cancel_at_next_billing_date: false,
        });
      } catch (dodoErr) {
        logger.error(
          { error: dodoErr, userId, action: "unscheduleSubscriptionChange" },
          "Failed to re-enable Dodo auto-renew (local schedule cleared anyway)",
        );
      }
    }

    await db.subscription.update({
      where: { userId },
      data: {
        scheduledPlanId: null,
        scheduledBillingPeriod: null,
        scheduledEffectiveAt: null,
      },
    });

    return { success: true, data: { unscheduled: true } };
  } catch (error) {
    logger.error(
      { error, userId, action: "unscheduleSubscriptionChange" },
      "Unschedule change error",
    );
    return { success: false, error: "Failed to undo scheduled change" };
  }
}

// ── Preview a plan change (read-only) ───────────────────────────────────────

/** The classifier + math a client needs to render plan-change confirmation copy. */
export interface PlanChangePreviewData {
  kind: TransitionKind;
  daysRemaining?: number;
  bonusDays?: number;
  newTermDays?: number;
  effectiveAt?: string | null;
  willChargeToday?: boolean;
}

/**
 * Preview a requested plan change (read-only). Mirrors `previewPlanChangeAction`
 * byte-for-byte: classify the transition, then branch the returned fields on the
 * kind. No state changes; the confirm step drives the actual mutation.
 */
export async function previewSubscriptionChange(
  userId: string,
  targetPlanId: "PRO" | "PREMIUM" | "FREE",
  targetCycle: "monthly" | "annual" | null,
  deps: SubscriptionMgmtDeps = {},
): Promise<ServiceResult<PlanChangePreviewData>> {
  const db = deps.prisma ?? prisma;
  const nowFn = deps.now ?? (() => new Date());
  try {
    const sub = await db.subscription.findUnique({ where: { userId } });

    const currentPlanId = (sub?.planId as string | undefined) ?? "FREE";
    const currentCycle =
      (sub?.billingPeriod as BillingCycle | null | undefined) ?? null;

    const kind = classifyTransition(
      currentPlanId,
      currentCycle,
      targetPlanId,
      targetCycle,
    );

    const now = nowFn();
    const remaining = daysRemaining(now, sub?.endDate ?? sub?.nextBillingDate);

    if (kind === "noop") {
      return { success: true, data: { kind, daysRemaining: remaining } };
    }

    if (
      kind === "cancel" ||
      kind === "tier_downgrade" ||
      kind === "cycle_downgrade"
    ) {
      const effectiveAt =
        (sub?.endDate ?? sub?.nextBillingDate)?.toISOString() ?? null;
      return {
        success: true,
        data: {
          kind,
          daysRemaining: remaining,
          effectiveAt,
          willChargeToday: false,
        },
      };
    }

    if (kind === "first_purchase") {
      const term =
        targetCycle === "annual"
          ? STANDARD_TERM_DAYS.annual
          : STANDARD_TERM_DAYS.monthly;
      return {
        success: true,
        data: {
          kind,
          daysRemaining: 0,
          bonusDays: 0,
          newTermDays: term,
          willChargeToday: true,
        },
      };
    }

    if (kind === "cycle_append") {
      const r = computeCycleAppendDays(remaining);
      return {
        success: true,
        data: {
          kind,
          daysRemaining: remaining,
          bonusDays: r.bonusDays,
          newTermDays: r.totalTermDays,
          willChargeToday: true,
        },
      };
    }

    // tier_upgrade
    const fromPlan = PLAN_CONFIG[currentPlanId as keyof typeof PLAN_CONFIG];
    const toPlan = PLAN_CONFIG[targetPlanId as keyof typeof PLAN_CONFIG];
    if (!fromPlan || !toPlan || !currentCycle || !targetCycle) {
      const term =
        targetCycle === "annual"
          ? STANDARD_TERM_DAYS.annual
          : STANDARD_TERM_DAYS.monthly;
      return {
        success: true,
        data: {
          kind,
          daysRemaining: remaining,
          bonusDays: 0,
          newTermDays: term,
          willChargeToday: true,
        },
      };
    }

    // Never let a missing list price THROW out of the preview (mirrors the web
    // action's guard) — fall back to no bonus days.
    let upgrade: { bonusDays: number; totalTermDays: number };
    try {
      upgrade = computeTierUpgradeBonusDays({
        fromPlan,
        fromCycle: currentCycle,
        toPlan,
        toCycle: targetCycle,
        daysRemainingOnCurrent: remaining,
      });
    } catch {
      upgrade = {
        bonusDays: 0,
        totalTermDays:
          targetCycle === "annual"
            ? STANDARD_TERM_DAYS.annual
            : STANDARD_TERM_DAYS.monthly,
      };
    }
    return {
      success: true,
      data: {
        kind,
        daysRemaining: remaining,
        bonusDays: upgrade.bonusDays,
        newTermDays: upgrade.totalTermDays,
        willChargeToday: true,
      },
    };
  } catch (error) {
    logger.error(
      { error, userId, action: "previewSubscriptionChange" },
      "Preview plan change error",
    );
    return { success: false, error: "Failed to preview plan change" };
  }
}

// ── AI-credit pre-flight (pure) ─────────────────────────────────────────────

/** Minimal credit view read off a SubscriptionData for the pre-flight decision. */
export interface AiCreditsView {
  planId: string;
  creditsLimit?: number | null;
  creditsUsed?: number | null;
  packCreditsLimit?: number | null;
  packCreditsUsed?: number | null;
}

export interface AiCreditsPreflight {
  allowed: boolean;
  reason: "ok" | "free" | "no_credits";
  planId: string;
}

/**
 * Pure pre-flight credit gate for AI features. Mirrors `checkAICreditsAction`'s
 * math: FREE users are blocked; unlimited (`creditsLimit === -1`) always passes;
 * otherwise plan-remaining + pack-remaining must be > 0.
 */
export function computeAiCreditsPreflight(
  data: AiCreditsView,
): AiCreditsPreflight {
  const planId = data.planId;

  // Free users cannot use AI features.
  if (planId === "FREE") {
    return { allowed: false, reason: "free", planId };
  }

  const creditsLimit = data.creditsLimit ?? 0;
  const creditsUsed = data.creditsUsed ?? 0;
  const packCreditsLimit = data.packCreditsLimit ?? 0;
  const packCreditsUsed = data.packCreditsUsed ?? 0;

  // Unlimited credits.
  if (creditsLimit === -1) {
    return { allowed: true, reason: "ok", planId };
  }

  const planRemaining = Math.max(0, creditsLimit - creditsUsed);
  const packRemaining = Math.max(0, packCreditsLimit - packCreditsUsed);

  if (planRemaining + packRemaining > 0) {
    return { allowed: true, reason: "ok", planId };
  }

  return { allowed: false, reason: "no_credits", planId };
}
