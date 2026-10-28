/**
 * No-Dodo plan grant — MONEY-865 / MONEY-413.
 *
 * The shared seam behind (a) a fully-covered (≥100% / flat ≥ price) coupon
 * checkout that skips the Dodo payment page, and (b) an admin manual grant /
 * mark-complete. Reuses `updateSubscriptionPlan` (the same service the FREE-
 * downgrade path calls) and the idempotent `recordCouponRedemption`.
 *
 * This is intentionally NOT the Dodo webhook's full fulfillment (query-pack
 * carry-forward, proration / bonus days, Dodo billing dates) — those only apply
 * to real Dodo payments and stay in apps/web/app/api/webhooks/dodo +
 * /api/payments/callback. Unifying the webhook onto this helper is deferred: it
 * needs a Dodo sandbox to verify behaviour-preservation of the live billing
 * path, and the risk of a silent regression there is not worth taking blind.
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import { updateSubscriptionPlan } from "./subscription.service";
import { recordCouponRedemption } from "./coupon.service";
import { couponTermEnd } from "./coupon-logic";

/**
 * Idempotency claim shared in spirit with the Dodo webhook + callback: flips a
 * Payment's `appliedAt` from unset/null → now and returns true ONLY for the
 * winning caller. The `isSet: false` guard is required because, on MongoDB, a
 * field that was never written does not match `appliedAt: null`.
 */
export async function claimPaymentFulfillment(
  paymentId: string,
): Promise<boolean> {
  const claim = await prisma.payment.updateMany({
    where: {
      id: paymentId,
      OR: [{ appliedAt: null }, { appliedAt: { isSet: false } }],
    },
    data: { appliedAt: new Date() },
  });
  return claim.count === 1;
}

/**
 * Hand a won fulfillment claim back (appliedAt → null) so a Dodo retry / callback
 * replay can re-attempt after a grant write failed. Unconditional `updateMany`
 * (no `catch`) — this is the EXACT release the Dodo webhook + payments callback
 * grant paths ran inline (MONEY-594); a release failure propagates so the outer
 * route handler still surfaces a 500 (webhook → Dodo retries) / callback_failed.
 *
 * Distinct from the private `releaseClaim` used by `applyPlanGrant` (which does a
 * best-effort `.update().catch()`); the two grant families keep their original
 * release semantics rather than being unified, to preserve exact behaviour.
 */
export async function releasePaymentFulfillment(
  paymentId: string,
): Promise<void> {
  await prisma.payment.updateMany({
    where: { id: paymentId },
    data: { appliedAt: null },
  });
}

export interface PlanGrantInput {
  userId: string;
  userEmail: string;
  /** Target plan (PlanType string, e.g. "PRO" | "PREMIUM"). */
  planId: string;
  billingPeriod?: string;
  /**
   * Optional Payment row to mark fulfilled (idempotency). For a coupon ₹0 grant
   * the caller creates a synthetic Payment first and passes its id; for an admin
   * mark-complete it is the stuck PENDING payment.
   */
  paymentId?: string;
  /** Optional coupon code to record a redemption for (idempotent). */
  couponCode?: string;
  /**
   * When true, schedule an automatic downgrade to FREE at the end of the granted
   * term (`billingPeriod`: monthly → +1 month, annual → +1 year). Used for
   * coupon free-grants: there is NO Dodo subscription to renew, so the plan must
   * self-expire — the MONEY-482 `apply-scheduled-plan-changes` cron flips it to
   * FREE when `scheduledEffectiveAt` arrives. Leave false for an admin
   * manual-complete of a REAL payment (that Dodo subscription renews normally).
   */
  autoDowngradeAfterTerm?: boolean;
}

export interface PlanGrantResult {
  success: boolean;
  /** false when the idempotency claim was already taken (no-op, treated as ok). */
  applied: boolean;
  error?: string;
}

/**
 * Grant a paid plan WITHOUT a Dodo charge. Idempotent when a `paymentId` is
 * supplied (only the winning fulfillment claim proceeds); rolls the claim back
 * if the grant itself fails so a retry can re-attempt.
 */
export async function applyPlanGrant(
  input: PlanGrantInput,
): Promise<PlanGrantResult> {
  if (input.paymentId) {
    const won = await claimPaymentFulfillment(input.paymentId);
    if (!won) {
      logger.info(
        { paymentId: input.paymentId, userId: input.userId },
        "applyPlanGrant: fulfillment already applied; skipping",
      );
      return { success: true, applied: false };
    }
  }

  try {
    const grant = await updateSubscriptionPlan(
      input.userId,
      input.planId,
      false,
      input.billingPeriod,
    );
    if (!grant.success) {
      await releaseClaim(input.paymentId);
      return { success: false, applied: false, error: grant.error };
    }

    if (input.couponCode) {
      // Trusted-server redemption recording (idempotent on couponId+userId).
      // Safe here: applyPlanGrant lives in packages/services and is never
      // browser-exposed; userId comes from the authenticated caller. A failure
      // must not undo the already-granted plan, so it is logged, not thrown.
      try {
        await recordCouponRedemption(
          input.couponCode,
          input.userId,
          input.userEmail,
          input.paymentId,
        );
      } catch (err) {
        logger.error(
          { err, couponCode: input.couponCode, userId: input.userId },
          "applyPlanGrant: coupon redemption recording failed (plan still granted)",
        );
      }
    }

    // Coupon free-grant: schedule the auto-downgrade to FREE at term end. No
    // Dodo subscription exists to renew, so without this the user would keep the
    // paid plan forever. Clears nextBillingDate (nothing renews) and sets the
    // scheduled-change fields the MONEY-482 cron acts on.
    if (input.autoDowngradeAfterTerm) {
      const termEnd = couponTermEnd(input.billingPeriod, new Date());
      await prisma.subscription.update({
        where: { userId: input.userId },
        data: {
          endDate: termEnd,
          nextBillingDate: null,
          scheduledPlanId: "FREE",
          scheduledBillingPeriod: null,
          scheduledEffectiveAt: termEnd,
        },
      });
    }

    return { success: true, applied: true };
  } catch (error) {
    await releaseClaim(input.paymentId);
    logger.error(
      { error, userId: input.userId, planId: input.planId },
      "applyPlanGrant failed",
    );
    return { success: false, applied: false, error: "Failed to apply plan" };
  }
}

/** Roll back a fulfillment claim so a retry can re-attempt (best-effort). */
async function releaseClaim(paymentId?: string): Promise<void> {
  if (!paymentId) return;
  await prisma.payment
    .update({ where: { id: paymentId }, data: { appliedAt: null } })
    .catch(() => {});
}
