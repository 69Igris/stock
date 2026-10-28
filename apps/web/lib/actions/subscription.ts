"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { getOrCreateDbUser } from "@/lib/db/user";
import { v4 as uuidv4 } from "uuid";
import { PlanType as PrismaPlanType } from "@prisma/client";
import { dodoClient } from "@usemoney/core/payments";
import {
  PLAN_CONFIG,
  resolvePlanId,
  resolveCheckoutPeriod,
  resolveCheckoutAmount,
} from "@usemoney/core/subscription";
import { getDodoProductInfo } from "@usemoney/services";
// Pure checkout-retry decision logic — SINGLE SOURCE OF TRUTH (no shadows). The
// create-checkout flow below CALLS these so tests run the same code.
import {
  isCheckout404,
  canRetryWithRefreshed,
  getCheckoutFailedErrorMessage,
  getCheckoutFailedUserMessage,
  getPlanUnavailableUserMessage,
} from "@usemoney/core/payments/checkout-logic";
import { dbLogger as logger } from "@usemoney/logger";
import {
  sendEmail,
  getEffectivePreferences,
  shouldSendEmail,
  buildUnsubscribeUrl,
} from "@usemoney/email";
import {
  AiQueryLimitEmail,
  PaymentSuccessEmail,
} from "@usemoney/email/templates";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  getSubscription,
  updateSubscriptionPlan as updateSubscriptionPlanService,
  consumeAIQuery as consumeAIQueryService,
  cancelSubscription,
  downgradeWithGracePeriod,
  refundAIQuery as refundAIQueryService,
  getPaymentHistory,
  refreshPendingPayments,
  validateCouponState,
  decidePaidPlanChange,
  recordCouponRedemption,
  isFullyCovered,
  applyPlanGrant,
  couponFinalPrice,
} from "@usemoney/services";
import type { CouponDiscountShape } from "@usemoney/services";
import { getBillingFlagsAction } from "./billing-flags";
import type { SubscriptionData } from "@usemoney/services";
import React from "react";

// Re-export the SubscriptionData type for backwards compatibility
export type { SubscriptionData };

// MONEY-1062 (W2-B): the inline getOrCreateUser here had an IDENTITY BUG — it
// looked up by email and, on a fresh create, wrote { email, name } with NO
// clerkId, so a later Clerk-keyed lookup would miss and a second row could be
// minted for the same person. It also checked only PENDING/PROCESSING deletion
// states (missing LOCKED). Replaced at the callsite with the canonical
// getOrCreateDbUser (clerkId-keyed create + PENDING/PROCESSING/LOCKED guard),
// which backfills email/name from Clerk (currentUser + user-logic) itself.

// Get current subscription
export async function getSubscriptionAction(): Promise<{
  success: boolean;
  data?: SubscriptionData;
  error?: string;
}> {
  try {
    const authUser = await getAuthenticatedUser();

    if (!authUser) {
      // Return default free subscription for unauthenticated users
      return {
        success: true,
        data: {
          id: "",
          planId: "FREE",
          status: "ACTIVE",
          startDate: new Date().toISOString(),
          aiQueriesUsed: 0,
          aiQueriesLimit: 0,
          addons: [],
          fastQueriesUsed: 0,
          fastQueriesLimit: 0,
          advancedQueriesUsed: 0,
          advancedQueriesLimit: 0,
          queryPackActive: false,
          queryPackFastQueriesUsed: 0,
          queryPackFastQueriesLimit: 0,
          queryPackAdvancedQueriesUsed: 0,
          queryPackAdvancedQueriesLimit: 0,
          // Unified credits
          creditsUsed: 0,
          creditsLimit: 5,
          creditsResetAt: null,
          packCreditsUsed: 0,
          packCreditsLimit: 0,
        },
      };
    }

    const result = await getSubscription(authUser.userId);
    if (!result?.success) {
      return { success: false, error: result?.error };
    }

    return { success: true, data: result?.data };
  } catch (error) {
    logger.error(
      { error, action: "getSubscriptionAction" },
      "Get subscription error"
    );
    return { success: false, error: "Failed to fetch subscription" };
  }
}

/**
 * MONEY-865 #4: upgrade a user who ALREADY has an active paid Dodo subscription
 * by modifying that subscription IN PLACE (subscriptions.changePlan), instead of
 * opening a 2nd subscription (which Dodo rejects → "could not start checkout",
 * and would double-bill if allowed). Handles the coupon discount (flat / % /
 * 100%) via Dodo's discount_code on the prorated charge. Returns a
 * no-checkoutUrl success — PlansTab's in-app path (like a fully-covered grant)
 * shows the upgrade applied without a redirect.
 *
 * SANDBOX-VERIFY on QA Dodo test_mode before prod (params are cast `as unknown`,
 * so a wrong key is silent): (a) does changePlan charge the saved card
 * synchronously? (b) does it accept discount_code? (c) which webhook event
 * reconciles billing dates / credits? See
 * docs/architecture/MONEY-865-paid-tier-change.md.
 */
// MONEY-877: the in-place upgrade paths (changePlan) grant the plan directly, and
// Dodo's changePlan emits no webhook our code matches (see the nextBillingDate note
// below), so the payment-success email never fired on a coupon / in-place upgrade.
// Send it directly from each success point. Best-effort — never fail the upgrade.
async function sendUpgradeConfirmationEmail(input: {
  userId: string;
  email: string;
  name: string;
  planId: string;
  amount: number;
  currency: string;
}): Promise<void> {
  try {
    const prefs = await getEffectivePreferences(input.userId);
    if (!shouldSendEmail(prefs, "payment-success")) return;
    const planName = resolvePlanId(input.planId);
    await sendEmail({
      to: input.email,
      subject: `Payment Confirmed - ${planName}`,
      unsubscribeUrl: buildUnsubscribeUrl(input.email, "paymentNotifications"),
      react: React.createElement(PaymentSuccessEmail, {
        name: input.name || "there",
        planName,
        amount: String(input.amount),
        currency: input.currency,
        unsubscribeUrl: buildUnsubscribeUrl(
          input.email,
          "paymentNotifications"
        ),
      }),
      template: "payment-success",
    });
  } catch (err) {
    logger.warn(
      { err, userId: input.userId },
      "upgrade confirmation email failed (plan still changed)"
    );
  }
}

async function applyDodoUpgradeInPlace(input: {
  userId: string;
  userEmail: string;
  userName: string;
  existingDodoSubId: string;
  targetPlanId: string;
  billingPeriod: string;
  period: string;
  finalPrice: number;
  discountCode?: string;
}): Promise<{ success: boolean; paymentId?: string; error?: string }> {
  try {
    // MONEY-872 idempotency: a double-submit (double-click / retried POST) would
    // otherwise create a 2nd Payment AND fire a 2nd PRORATED charge on the saved
    // card — the appliedAt CAS is stamped only AFTER the charge, on a fresh row, so
    // it offers no protection. If an identical in-place change for this user+plan
    // is already in flight or was just applied, return it instead of re-charging.
    // The 2-minute window covers the double-submit without blocking a legitimate
    // re-upgrade later.
    const inFlight = await prisma.payment.findFirst({
      where: {
        userId: input.userId,
        planId: input.targetPlanId as PrismaPlanType,
        // MONEY-872 (F10): key on the CYCLE too, so a legitimate fast follow-up
        // change to the SAME plan but a different cycle (e.g. PREMIUM-monthly →
        // PREMIUM-annual right after the upgrade) isn't swallowed as a duplicate.
        period: input.period,
        dodoPaymentId: { startsWith: "changeplan:" },
        createdAt: { gte: new Date(Date.now() - 2 * 60 * 1000) },
      },
    });
    if (inFlight) {
      return { success: true, paymentId: inFlight.id };
    }

    let productInfo = await getDodoProductInfo(
      input.targetPlanId,
      input.billingPeriod
    );
    // MONEY-866: auto-sync on a cold miss — same as the checkout path. The
    // DodoProduct table is populated lazily, so upgrading to a never-purchased
    // target plan (e.g. PREMIUM) would otherwise fail the changePlan upgrade with
    // "could not start checkout". This was the real cause of the post-PRO upgrade
    // failure: the checkout path auto-syncs, this path didn't.
    if (!productInfo) {
      const { syncDodoProducts } = await import("@usemoney/services");
      await syncDodoProducts();
      productInfo = await getDodoProductInfo(
        input.targetPlanId,
        input.billingPeriod
      );
    }
    if (!productInfo) {
      // MONEY-1074: PREMIUM/target product missing from the active Dodo catalog
      // even after auto-sync — the silent "Pro→Premium upgrade does nothing" on
      // QA. Matching is name-based (usemoney_premium / usemoney_premium_annual,
      // product-sync-logic PRODUCT_PLAN_MAPPING), so this one log line tells ops
      // exactly what to add to the test-mode catalog.
      logger.warn(
        {
          targetPlanId: input.targetPlanId,
          billingPeriod: input.billingPeriod,
        },
        "changePlan upgrade: Dodo product missing after syncDodoProducts — check the active-mode catalog names (product-sync-logic PRODUCT_PLAN_MAPPING)"
      );
      return { success: false, error: getPlanUnavailableUserMessage() };
    }

    // Payment row for the prorated upgrade charge — fulfillment + idempotency.
    const changeId = uuidv4();
    const payment = await prisma.payment.create({
      data: {
        userId: input.userId,
        dodoPaymentId: `changeplan:${changeId}`,
        amount: input.finalPrice,
        currency: "INR",
        status: "PENDING",
        planId: input.targetPlanId as PrismaPlanType,
        planName: input.targetPlanId,
        period: input.period,
        metadata: {
          customerEmail: input.userEmail,
          customerName: input.userName,
          billingPeriod: input.billingPeriod,
          changePlanUpgrade: true,
          ...(input.discountCode ? { discountCode: input.discountCode } : {}),
        },
      },
    });

    // Modify the existing subscription in place. Typed DIRECTLY against the SDK's
    // SubscriptionChangePlanParams (NO `as unknown as` cast) so an invalid value
    // fails `tsc` instead of 422-ing in production — the old cast had hidden BOTH a
    // bad proration enum AND a `discount_code` the API doesn't accept. The SDK type
    // is product_id + proration_billing_mode + quantity + addons ONLY: Dodo's
    // changePlan has NO discount_code, so a coupon can't be applied to the prorated
    // upgrade delta here (createCheckoutAction handles coupons on upgrades).
    // `prorated_immediately` charges the mid-cycle delta now.
    await dodoClient.subscriptions.changePlan(input.existingDodoSubId, {
      product_id: productInfo.productId,
      proration_billing_mode: "prorated_immediately",
      quantity: 1,
    });

    // Reflect the new entitlement locally so the UI updates immediately.
    const grant = await updateSubscriptionPlanService(
      input.userId,
      input.targetPlanId,
      false,
      input.billingPeriod
    );
    if (!grant?.success) {
      return {
        success: false,
        error: grant?.error ?? "Failed to apply the plan change",
      };
    }

    // MONEY-872: re-base the billing anchor from Dodo. `changePlan` returns void and
    // emits NO webhook our code matches (the synthetic `changeplan:` payment id never
    // matches a real Dodo payment_id, and there is no subscription.updated handler),
    // and updateSubscriptionPlan never writes nextBillingDate — so without this the
    // row keeps the OLD plan's anchor, which is wildly wrong on a cross-cycle upgrade
    // (PRO-annual → PREMIUM-monthly would show "renews next year"). Pull the
    // authoritative next_billing_date and persist it. Best-effort: a retrieve failure
    // leaves the stale anchor rather than failing the already-completed upgrade.
    try {
      const refreshed = await dodoClient.subscriptions.retrieve(
        input.existingDodoSubId
      );
      const nbd = refreshed.next_billing_date
        ? new Date(refreshed.next_billing_date)
        : null;
      if (nbd && !Number.isNaN(nbd.getTime())) {
        await prisma.subscription.update({
          where: { userId: input.userId },
          data: { nextBillingDate: nbd },
        });
      }
    } catch (err) {
      logger.warn(
        { err, userId: input.userId, targetPlanId: input.targetPlanId },
        "changePlan: could not retrieve the new billing anchor; nextBillingDate may be stale until the next renewal"
      );
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "COMPLETED", appliedAt: new Date() },
    });

    // Record the coupon redemption (idempotent on couponId+userId).
    if (input.discountCode) {
      try {
        await recordCouponRedemption(
          input.discountCode,
          input.userId,
          input.userEmail,
          payment.id
        );
      } catch (err) {
        logger.error(
          { err, userId: input.userId },
          "changePlan upgrade: coupon redemption recording failed (plan still changed)"
        );
      }
    }

    await sendUpgradeConfirmationEmail({
      userId: input.userId,
      email: input.userEmail,
      name: input.userName,
      planId: input.targetPlanId,
      amount: payment.amount,
      currency: payment.currency,
    });

    return { success: true, paymentId: payment.id };
  } catch (error) {
    logger.error(
      { error, userId: input.userId, targetPlanId: input.targetPlanId },
      "applyDodoUpgradeInPlace failed"
    );
    return { success: false, error: getCheckoutFailedUserMessage() };
  }
}

/**
 * MONEY-862 "discount-on-upgrade": apply a validated coupon to an IN-PLACE
 * paid→paid upgrade. Dodo's `subscriptions.changePlan` has NO discount_code
 * field (SubscriptionChangePlanParams = product_id + proration_billing_mode +
 * quantity + addons), so a coupon CANNOT ride the proration on a changePlan.
 *
 * The workaround is CHARGE-FIRST-THEN-SWITCH:
 *   1. `previewChangePlan(prorated_immediately)` returns the proration TOTAL
 *      (immediate_charge.summary.total_amount, in PAISE — the smallest unit).
 *   2. Discount that total in RUPEES via couponFinalPrice, then convert back to
 *      paise and `charge(product_price=discountedPaise)` the saved card.
 *   3. ONLY after a successful charge do we `changePlan(do_not_bill)` — so a
 *      failed charge NEVER grants a free upgrade, and the do_not_bill switch
 *      doesn't double-bill the proration we already charged discounted.
 *
 * Returns `{ handled }` so createCheckoutAction can fall back to
 * applyDodoUpgradeInPlace (FULL price, coupon NOT consumed — interim B) ONLY
 * when NOTHING was charged. Once we've charged, `handled` is ALWAYS true: the
 * caller must NOT fall back (that would be a 2nd charge).
 *
 * SANDBOX-VERIFY on QA Dodo test_mode (the changePlan body's `do_not_bill` is a
 * NARROW cast — the SDK enum is prorated_immediately|full_immediately|
 * difference_immediately ONLY): (a) does `charge` settle the saved card
 * synchronously? (b) does changePlan with do_not_bill skip the proration?
 * (c) is summary.total_amount the right paise total (vs settlement_amount)?
 */
async function applyDiscountedUpgrade(input: {
  userId: string;
  userEmail: string;
  userName: string;
  existingDodoSubId: string;
  targetPlanId: string;
  billingPeriod: string;
  period: string;
  coupon: CouponDiscountShape;
  discountCode: string;
}): Promise<{
  handled: boolean;
  result: { success: boolean; paymentId?: string; error?: string };
}> {
  // Idempotency — IDENTICAL window/key to applyDodoUpgradeInPlace (a
  // double-submit must not preview+charge+switch twice). If an in-place change
  // for this user+plan+cycle is already in flight, return it instead of
  // re-charging. handled:true so the caller never falls through to a 2nd path.
  const inFlight = await prisma.payment.findFirst({
    where: {
      userId: input.userId,
      planId: input.targetPlanId as PrismaPlanType,
      period: input.period,
      dodoPaymentId: { startsWith: "changeplan:" },
      createdAt: { gte: new Date(Date.now() - 2 * 60 * 1000) },
    },
  });
  if (inFlight) {
    return { handled: true, result: { success: true, paymentId: inFlight.id } };
  }

  // Resolve the target product (auto-sync on a cold miss, like
  // applyDodoUpgradeInPlace). A null here means we can't price the switch —
  // return handled:false so the caller falls back to the full-price path.
  let productInfo = await getDodoProductInfo(
    input.targetPlanId,
    input.billingPeriod
  );
  if (!productInfo) {
    const { syncDodoProducts } = await import("@usemoney/services");
    await syncDodoProducts();
    productInfo = await getDodoProductInfo(
      input.targetPlanId,
      input.billingPeriod
    );
  }
  if (!productInfo) {
    return {
      handled: false,
      result: { success: false, error: getCheckoutFailedUserMessage() },
    };
  }

  // 1) Preview the proration. No money moves here — if the preview throws or
  // has no usable total, NOTHING was charged, so it's safe to fall back.
  let prorationPaise: number;
  try {
    const preview = await dodoClient.subscriptions.previewChangePlan(
      input.existingDodoSubId,
      {
        product_id: productInfo.productId,
        proration_billing_mode: "prorated_immediately",
        quantity: 1,
      }
    );
    // The proration TOTAL lives on immediate_charge.summary.total_amount, in
    // PAISE (smallest currency unit). See dodopayments SDK
    // SubscriptionPreviewChangePlanResponse.ImmediateCharge.Summary.
    const total = preview.immediate_charge?.summary?.total_amount;
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
      logger.warn(
        { userId: input.userId, targetPlanId: input.targetPlanId },
        "discounted upgrade: preview returned no usable proration total; falling back to full-price upgrade"
      );
      return {
        handled: false,
        result: { success: false, error: getCheckoutFailedUserMessage() },
      };
    }
    prorationPaise = total;
  } catch (err) {
    logger.warn(
      { err, userId: input.userId, targetPlanId: input.targetPlanId },
      "discounted upgrade: previewChangePlan failed; falling back to full-price upgrade"
    );
    return {
      handled: false,
      result: { success: false, error: getCheckoutFailedUserMessage() },
    };
  }

  // 2) Discount the proration in RUPEES, then back to PAISE for the charge.
  const prorationRupees = prorationPaise / 100;
  const discountedRupees = couponFinalPrice(
    prorationRupees,
    input.coupon
  ).finalPrice;
  const discountedPaise = Math.round(discountedRupees * 100);
  if (
    !Number.isFinite(prorationRupees) ||
    !Number.isFinite(discountedRupees) ||
    !Number.isFinite(discountedPaise) ||
    discountedPaise < 0
  ) {
    logger.error(
      {
        userId: input.userId,
        targetPlanId: input.targetPlanId,
        prorationPaise,
        discountedRupees,
      },
      "discounted upgrade: non-finite discounted amount; falling back to full-price upgrade"
    );
    return {
      handled: false,
      result: { success: false, error: getCheckoutFailedUserMessage() },
    };
  }

  // 3) CHARGE FIRST. Create the PENDING Payment row (fulfillment + the
  // idempotency anchor above), then charge the saved card the discounted
  // proration. From this point on a failure must NOT fall back (would
  // double-charge) — handled stays true.
  const changeId = uuidv4();
  const payment = await prisma.payment.create({
    data: {
      userId: input.userId,
      dodoPaymentId: `changeplan:${changeId}`,
      amount: discountedRupees,
      currency: "INR",
      status: "PENDING",
      planId: input.targetPlanId as PrismaPlanType,
      planName: input.targetPlanId,
      period: input.period,
      metadata: {
        customerEmail: input.userEmail,
        customerName: input.userName,
        billingPeriod: input.billingPeriod,
        changePlanUpgrade: true,
        discountCode: input.discountCode,
      },
    },
  });

  // A fully-covered (100% / flat ≥ proration) coupon leaves NOTHING to charge — skip
  // the charge entirely and go straight to the do_not_bill switch so the upgrade is
  // FREE. Charging ₹0 (or Dodo rejecting a 0-amount charge) would be wrong; this is
  // the active-sub equivalent of the no-sub fully-covered grant.
  if (discountedPaise > 0) {
    try {
      await dodoClient.subscriptions.charge(input.existingDodoSubId, {
        product_price: discountedPaise,
      });
    } catch (chargeErr) {
      // The charge failed → NOTHING switched, the user is still on the old plan.
      // Mark the row FAILED and report failure, but do NOT let the caller fall back
      // to applyDodoUpgradeInPlace (that path charges AGAIN).
      logger.error(
        {
          error: chargeErr,
          userId: input.userId,
          targetPlanId: input.targetPlanId,
        },
        "discounted upgrade: proration charge failed (nothing switched, user on old plan)"
      );
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "FAILED",
          errorMessage: getCheckoutFailedErrorMessage(),
        },
      });
      return {
        handled: true,
        result: { success: false, error: getCheckoutFailedUserMessage() },
      };
    }
  }

  // 4) Switch the plan WITHOUT billing the proration again — we already charged
  // it (discounted) above. `do_not_bill` is accepted by Dodo's API but is NOT
  // in the SDK's proration_billing_mode union (prorated_immediately |
  // full_immediately | difference_immediately). Keep product_id + quantity
  // type-checked against the SDK and only loosen the one enum value via a narrow
  // Omit-based intersection.
  type ChangePlanParams = Parameters<
    typeof dodoClient.subscriptions.changePlan
  >[1];
  const doNotBillBody: Omit<ChangePlanParams, "proration_billing_mode"> & {
    proration_billing_mode: "do_not_bill";
  } = {
    product_id: productInfo.productId,
    proration_billing_mode: "do_not_bill",
    quantity: 1,
  };
  try {
    await dodoClient.subscriptions.changePlan(
      input.existingDodoSubId,
      doNotBillBody as unknown as ChangePlanParams
    );
  } catch (switchErr) {
    // CHARGED but the plan switch failed — the user paid and is still on the old
    // plan. Needs a manual reconcile (refund or re-attempt the switch). Do NOT
    // fall back (charging a 2nd time would compound the problem).
    logger.error(
      {
        error: switchErr,
        userId: input.userId,
        targetPlanId: input.targetPlanId,
        paymentId: payment.id,
      },
      "discounted upgrade: charged but plan-switch (changePlan do_not_bill) failed; manual reconcile required"
    );
    return {
      handled: true,
      result: { success: false, error: getCheckoutFailedUserMessage() },
    };
  }

  // 5) SUCCESS. Reflect the new entitlement locally so the UI updates.
  const grant = await updateSubscriptionPlanService(
    input.userId,
    input.targetPlanId,
    false,
    input.billingPeriod
  );
  if (!grant?.success) {
    logger.error(
      {
        userId: input.userId,
        targetPlanId: input.targetPlanId,
        paymentId: payment.id,
      },
      "discounted upgrade: charged + switched on Dodo but local plan grant failed; manual reconcile"
    );
    return {
      handled: true,
      result: {
        success: false,
        error: grant?.error ?? "Failed to apply the plan change",
      },
    };
  }

  // Re-base the billing anchor from Dodo (mirrors applyDodoUpgradeInPlace).
  // changePlan returns void and emits no webhook our code matches, and
  // updateSubscriptionPlan never writes nextBillingDate — so without this the
  // row keeps the OLD plan's anchor. Best-effort: a retrieve failure leaves the
  // stale anchor rather than failing the already-completed upgrade.
  try {
    const refreshed = await dodoClient.subscriptions.retrieve(
      input.existingDodoSubId
    );
    const nbd = refreshed.next_billing_date
      ? new Date(refreshed.next_billing_date)
      : null;
    if (nbd && !Number.isNaN(nbd.getTime())) {
      await prisma.subscription.update({
        where: { userId: input.userId },
        data: { nextBillingDate: nbd },
      });
    }
  } catch (err) {
    logger.warn(
      { err, userId: input.userId, targetPlanId: input.targetPlanId },
      "discounted upgrade: could not retrieve the new billing anchor; nextBillingDate may be stale until the next renewal"
    );
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: "COMPLETED", appliedAt: new Date() },
  });

  // Consume the coupon — it WAS applied (the user paid the discounted price).
  try {
    await recordCouponRedemption(
      input.discountCode,
      input.userId,
      input.userEmail,
      payment.id
    );
  } catch (err) {
    logger.error(
      { err, userId: input.userId },
      "discounted upgrade: coupon redemption recording failed (plan still changed + charged)"
    );
  }

  await sendUpgradeConfirmationEmail({
    userId: input.userId,
    email: input.userEmail,
    name: input.userName,
    planId: input.targetPlanId,
    amount: payment.amount,
    currency: payment.currency,
  });

  return { handled: true, result: { success: true, paymentId: payment.id } };
}

// Create checkout session for plan upgrade
// NOTE: Kept in action layer because it interacts with Dodo Payments API
export async function createCheckoutAction(
  planId: string,
  billingPeriod?: "monthly" | "annual",
  discountCode?: string
): Promise<{
  success: boolean;
  checkoutUrl?: string;
  paymentId?: string;
  error?: string;
}> {
  try {
    const { userId: clerkUserId } = await auth();
    const clerkUser = await currentUser();

    if (!clerkUserId || !clerkUser?.emailAddresses?.[0]?.emailAddress) {
      return { success: false, error: "Please sign in to upgrade your plan" };
    }

    const email = clerkUser.emailAddresses[0].emailAddress;
    const name = clerkUser.fullName || clerkUser.firstName || "Customer";

    // Get or create user (canonical, clerkId-keyed; backfills email/name itself).
    const user = await getOrCreateDbUser(clerkUserId);
    if (!user) {
      // MONEY-445 - getOrCreateUser returns null when a delete-account
      // worker job is in flight for this clerkId. No new checkout for
      // a user that's mid-deletion.
      return {
        success: false,
        error: "Account is being deleted. Please contact support.",
      };
    }

    // Resolve legacy plan IDs - credit pack IDs (CREDIT_PACK_50, etc.) map to QUERY_PACK
    const resolvedPlanId = planId.startsWith("CREDIT_PACK_")
      ? "QUERY_PACK"
      : resolvePlanId(planId);
    const planConfig = PLAN_CONFIG[resolvedPlanId as keyof typeof PLAN_CONFIG];
    if (!planConfig) {
      return { success: false, error: "Invalid plan" };
    }

    // Validate credit pack purchase - requires PRO or PREMIUM plan
    // Accept both legacy QUERY_PACK and new CREDIT_PACK_* IDs
    const isCreditPack =
      resolvedPlanId === "QUERY_PACK" || planId.startsWith("CREDIT_PACK_");
    if (isCreditPack) {
      const subResult = await getSubscription(user.id);
      const userPlan =
        subResult.success && subResult.data
          ? resolvePlanId(subResult.data.planId)
          : "FREE";

      if (
        !subResult.success ||
        !subResult.data ||
        (userPlan !== "PRO" &&
          userPlan !== "PREMIUM" &&
          userPlan !== "ULTIMATE")
      ) {
        return {
          success: false,
          error:
            "AI Query Pack requires Pro or Premium plan. Please upgrade your plan first.",
        };
      }

      // Packs stack onto an ACTIVE term. A PAST_DUE/EXPIRED/CANCELLED row
      // must fix billing first — the non-ACTIVE carry-forward at
      // fulfillment starts the pack balance fresh (zeroing any unused
      // remainder), and granting onto a dunned plan invites disputes.
      if (subResult.data.status !== "ACTIVE") {
        return {
          success: false,
          error:
            "Your subscription isn't active. Renew or fix billing before buying a credit pack.",
        };
      }
    }

    // MONEY-481: PRO Monthly/Annual + Premium Annual are now generally
    // available — the PostHog feature-flag gates that previously blocked
    // non-allowlisted users have been removed. Ultimate stays gated since
    // it is not yet shipped end-to-end.
    const billingFlags = await getBillingFlagsAction();
    if (resolvedPlanId === "ULTIMATE" && !billingFlags.ultimatePlan) {
      // Generic message — Ultimate is not shipped yet; tier name redacted
      // so we never expose internal plan IDs to the UI (MONEY-481).
      return {
        success: false,
        error: "This plan is not yet available. Please try again later.",
      };
    }

    // MONEY-482: FREE = cancel. Honor the current paid term until expiry,
    // then drop to FREE. Routes through scheduleCancelAction so the user
    // keeps their paid features for the time they paid for. The legacy
    // immediate-downgrade path is preserved only for users with no
    // active paid term (already FREE) — there's nothing to schedule
    // and they should land on FREE immediately.
    if (resolvedPlanId === "FREE") {
      const existing = await prisma.subscription.findUnique({
        where: { userId: user.id },
      });
      const hasActivePaidTerm =
        existing &&
        existing.planId !== "FREE" &&
        (existing.endDate ?? existing.nextBillingDate);
      if (hasActivePaidTerm) {
        const schedule = await scheduleCancelAction();
        if (schedule.success) {
          return { success: true };
        }
        return { success: false, error: schedule.error };
      }
      // SECURITY (MONEY-587): call the service helper directly, NOT a
      // browser-exposed "use server" action. The plan mutation must never be
      // a stand-alone server action that takes an attacker-controlled
      // userId/planId. This caller is already authenticated above (user.id
      // resolved from the Clerk session) and only downgrades to FREE.
      const downgrade = await updateSubscriptionPlanService(user.id, "FREE");
      if (!downgrade?.success) {
        return {
          success: false,
          error: downgrade?.error ?? "Failed to update subscription plan",
        };
      }
      return { success: true };
    }

    // MONEY-866: PRO/PREMIUM are monthly/annual ONLY (the one-time "lifetime"
    // PRO is deprecated); credit packs are one-time. Pure + unit-tested.
    const period = resolveCheckoutPeriod(
      resolvedPlanId,
      billingPeriod,
      isCreditPack
    );

    // MONEY-865: the checkout amount is the SYNCED Dodo product price (source of
    // truth); PLAN_CONFIG is only a cold-miss fallback that NEVER reverts to the
    // legacy ₹999. Credit packs price from their own SKU. Pure + unit-tested via
    // resolveCheckoutAmount.
    let creditPackPrice: number | null = null;
    if (isCreditPack && planId.startsWith("CREDIT_PACK_")) {
      const packCredits = parseInt(planId.replace("CREDIT_PACK_", ""), 10);
      const { CREDIT_PACKS } =
        await import("@usemoney/core/subscription/plans");
      creditPackPrice =
        CREDIT_PACKS.find((p) => p.credits === packCredits)?.price ?? null;
    }
    const priced = isCreditPack
      ? null
      : await getDodoProductInfo(resolvedPlanId, billingPeriod);
    const amount = resolveCheckoutAmount({
      resolvedPlanId,
      billingPeriod,
      isCreditPack,
      dodoPrice: priced?.price ?? null,
      creditPackPrice,
    });

    // MONEY-865: validate the coupon SERVER-SIDE (it was previously forwarded to
    // Dodo unvalidated — an attacker could apply any code).
    let validatedCoupon: Awaited<
      ReturnType<typeof validateCouponState>
    > | null = null;
    if (discountCode) {
      validatedCoupon = await validateCouponState(
        discountCode,
        email,
        user.id,
        resolvedPlanId,
        billingPeriod || "monthly"
      );
      if (!validatedCoupon.valid) {
        return {
          success: false,
          error: validatedCoupon.error ?? "Invalid coupon code",
        };
      }
    }

    // MONEY-865 #4: when the user ALREADY holds an active paid Dodo subscription,
    // an upgrade must MODIFY it in place (subscriptions.changePlan) — NOT open a
    // 2nd subscription. The create-a-2nd-sub is what failed as "could not start
    // checkout" (and would double-bill if Dodo allowed it). Routed by the pure,
    // tested decidePaidPlanChange. Credit packs always go through Dodo checkout.
    if (!isCreditPack) {
      const existingSub = await prisma.subscription.findUnique({
        where: { userId: user.id },
      });
      if (
        existingSub?.dodoSubscriptionId &&
        existingSub.status === "ACTIVE" &&
        existingSub.planId !== "FREE"
      ) {
        const decision = decidePaidPlanChange({
          currentPlan: existingSub.planId,
          currentBillingPeriod: existingSub.billingPeriod,
          hasActiveDodoSub: true,
          targetPlan: resolvedPlanId,
          targetBillingPeriod: period,
          targetListPrice: amount,
          coupon: validatedCoupon?.valid ? validatedCoupon : null,
        });
        if (decision.route === "change-plan") {
          // MONEY-862 "discount-on-upgrade": a coupon can't ride Dodo's changePlan
          // (no discount_code field), so route a coupon'd upgrade through the
          // preview → charge-the-discounted-proration → do_not_bill switch path.
          // This INCLUDES a fully-covered (100%) coupon — applyDiscountedUpgrade
          // skips the charge when the discounted amount is ₹0, giving a FREE switch
          // (the no-sub grant path further down only runs when there is NO Dodo sub
          // to modify). If the path returns handled:true it has charged / switched /
          // is mid-reconcile — return it directly; a fall-through would
          // double-charge. handled:false means NOTHING was charged (preview/
          // product-sync failed) → interim B: fall back to the FULL-price upgrade
          // with the coupon NOT consumed.
          if (discountCode && validatedCoupon?.valid) {
            const discounted = await applyDiscountedUpgrade({
              userId: user.id,
              userEmail: email,
              userName: name,
              existingDodoSubId: existingSub.dodoSubscriptionId,
              targetPlanId: resolvedPlanId,
              billingPeriod: billingPeriod || "monthly",
              period,
              coupon: validatedCoupon,
              discountCode,
            });
            if (discounted.handled) {
              return discounted.result;
            }
          }
          // No coupon (or the discounted path bailed before charging): apply the
          // upgrade at the FULL list price. discountCode is dropped here so a
          // coupon is NEVER silently consumed without being applied (interim B).
          return await applyDodoUpgradeInPlace({
            userId: user.id,
            userEmail: email,
            userName: name,
            existingDodoSubId: existingSub.dodoSubscriptionId,
            targetPlanId: resolvedPlanId,
            billingPeriod: billingPeriod || "monthly",
            period,
            finalPrice: decision.listPrice,
            discountCode: undefined,
          });
        }
        if (decision.route === "scheduled-downgrade") {
          // MONEY-872 defense: an active-sub DOWNGRADE (lower tier, or annual →
          // monthly) must be SCHEDULED at term end — never sent on to a fresh Dodo
          // checkout, which would open a SECOND subscription alongside the still-
          // active one. The UI routes downgrades to scheduleDowngradeAction via the
          // preview; this guards any caller that reaches createCheckoutAction
          // directly with a downgrade.
          return {
            success: false,
            error:
              "To move to a lower plan, use the downgrade option on the plan page — it applies at the end of your current term.",
          };
        }
      }
    }

    // Coupon FULLY covers the price AND there is NO Dodo subscription to modify
    // (FREE / coupon-grant / lapsed) → skip the Dodo page and grant directly.
    if (
      discountCode &&
      validatedCoupon?.valid &&
      !isCreditPack &&
      isFullyCovered(amount, validatedCoupon)
    ) {
      const grantPaymentId = uuidv4();
      const skipPayment = await prisma.payment.create({
        data: {
          userId: user.id,
          // Synthetic, clearly-non-Dodo id (no webhook will ever match it).
          dodoPaymentId: `coupon-skip:${grantPaymentId}`,
          amount: 0,
          currency: "INR",
          status: "COMPLETED",
          planId: resolvedPlanId as PrismaPlanType,
          planName: resolvedPlanId,
          period,
          metadata: {
            customerEmail: email,
            customerName: name,
            billingPeriod: billingPeriod || "monthly",
            discountCode,
            couponSkip: true,
          },
        },
      });

      const grant = await applyPlanGrant({
        userId: user.id,
        userEmail: email,
        planId: resolvedPlanId,
        billingPeriod,
        paymentId: skipPayment.id,
        couponCode: discountCode,
        // Coupon free-grant: no Dodo subscription renews it, so schedule the
        // auto-downgrade to FREE at term end (monthly/annual).
        autoDowngradeAfterTerm: true,
      });
      if (!grant.success) {
        return {
          success: false,
          error: grant.error ?? "Couldn't apply the coupon. Please try again.",
        };
      }
      return { success: true, paymentId: skipPayment.id };
    }

    // For CREDIT_PACK_N purchases, persist the pack size on metadata so
    // the callback can credit packCreditsLimit by the exact amount. The
    // returnUrl uses `resolvedPlanId` (always "QUERY_PACK" for packs),
    // so without this the callback can't tell 50 vs 1000.
    const creditPackSize = planId.startsWith("CREDIT_PACK_")
      ? parseInt(planId.replace("CREDIT_PACK_", ""), 10) || 0
      : 0;

    // Create payment record
    const paymentId = uuidv4();
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        dodoPaymentId: paymentId,
        amount: amount,
        currency: "INR",
        status: "PENDING",
        planId: resolvedPlanId as PrismaPlanType,
        planName: planId.startsWith("CREDIT_PACK_")
          ? `Credit Pack (${planId.replace("CREDIT_PACK_", "")} credits)`
          : resolvedPlanId,
        period: period,
        metadata: {
          customerEmail: email,
          customerName: name,
          billingPeriod: billingPeriod || "monthly",
          ...(creditPackSize > 0
            ? { creditPackSize, originalPlanId: planId }
            : {}),
          ...(discountCode ? { discountCode } : {}),
        },
      },
    });

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

    // Get Dodo product info (ID + isRecurring + price) from synced products.
    // For credit packs, try specific pack product first, fall back to QUERY_PACK.
    // (getDodoProductInfo is imported statically at the top — no dynamic re-import.)
    const dodoLookupId =
      isCreditPack && planId.startsWith("CREDIT_PACK_")
        ? planId // Try CREDIT_PACK_50, CREDIT_PACK_100, etc.
        : resolvedPlanId;
    let productInfo = await getDodoProductInfo(dodoLookupId, billingPeriod);
    // No silent fallback - if specific pack product not found, auto-sync will try to find it

    // If product not found, auto-sync from Dodo and try again
    if (!productInfo) {
      logger.info(
        `Product not found for plan ${dodoLookupId}. Auto-syncing products from Dodo...`
      );
      const { syncDodoProducts } = await import("@usemoney/services");
      const syncResult = await syncDodoProducts();
      logger.info(
        `Auto-sync completed: ${syncResult.synced} products synced, ${syncResult.errors.length} errors`
      );

      // Retry with the SAME lookup id as the first attempt. Using
      // `resolvedPlanId` here silently downgraded CREDIT_PACK_N lookups to
      // the legacy ₹199 QUERY_PACK product after an auto-sync (wrong charge,
      // wrong grant).
      productInfo = await getDodoProductInfo(dodoLookupId, billingPeriod);

      if (!productInfo) {
        // MONEY-1074: target product still missing after auto-sync — surface an
        // actionable message (not the generic checkout error) and log the
        // catalog gap so ops can add the named product (test-mode on QA).
        logger.warn(
          { dodoLookupId, billingPeriod },
          "checkout: Dodo product missing after syncDodoProducts — check the active-mode catalog names (product-sync-logic PRODUCT_PLAN_MAPPING)"
        );
        return {
          success: false,
          error: getPlanUnavailableUserMessage(),
        };
      }
    }

    const { productId: dodoProductId, isRecurring } = productInfo;
    const returnUrl = `${baseUrl}/api/payments/callback?paymentId=${payment.id}&planId=${resolvedPlanId}&billingPeriod=${billingPeriod || "monthly"}`;
    const checkoutMetadata = {
      internal_payment_id: payment.id,
      plan_id: resolvedPlanId,
      user_id: user.id,
    };

    // Helper to create Dodo checkout session
    const createDodoCheckout = async (
      productId: string,
      recurring: boolean
    ): Promise<{
      paymentId: string;
      url: string | null | undefined;
      subscriptionId?: string;
    }> => {
      if (recurring) {
        logger.info(
          `Creating subscription checkout for ${resolvedPlanId} (product: ${productId})`
        );
        const subSession = await dodoClient.subscriptions.create({
          billing: {
            city: "Mumbai",
            country: "IN",
            state: "Maharashtra",
            street: "N/A",
            zipcode: "400001",
          },
          customer: { email, name },
          product_id: productId,
          quantity: 1,
          payment_link: true,
          return_url: returnUrl,
          ...(discountCode ? { discount_code: discountCode } : {}),
          metadata: checkoutMetadata,
        });
        return {
          paymentId: subSession.payment_id,
          url: subSession.payment_link,
          subscriptionId: subSession.subscription_id,
        };
      } else {
        logger.info(
          `Creating payment checkout for ${resolvedPlanId} (product: ${productId})`
        );
        const paySession = await dodoClient.payments.create({
          billing: {
            city: "Mumbai",
            country: "IN",
            state: "Maharashtra",
            street: "N/A",
            zipcode: "400001",
          },
          customer: { email, name },
          payment_link: true,
          return_url: returnUrl,
          ...(discountCode ? { discount_code: discountCode } : {}),
          metadata: checkoutMetadata,
          product_cart: [{ product_id: productId, quantity: 1 }],
        });
        return {
          paymentId: paySession.payment_id,
          url: paySession.payment_link,
        };
      }
    };

    // Try to create Dodo checkout session (with 404 retry)
    try {
      let checkoutResult: Awaited<ReturnType<typeof createDodoCheckout>>;

      try {
        checkoutResult = await createDodoCheckout(dodoProductId, isRecurring);
      } catch (firstError: unknown) {
        // If product ID is stale (404), re-sync from Dodo and retry once
        if (!isCheckout404(firstError)) throw firstError;

        logger.warn(
          `Product ${dodoProductId} returned 404. Re-syncing products from Dodo...`
        );
        const { syncDodoProducts } = await import("@usemoney/services");
        await syncDodoProducts();

        // Same-lookup retry as above: packs must refresh CREDIT_PACK_N, not
        // the legacy QUERY_PACK product.
        const refreshedInfo = await getDodoProductInfo(
          dodoLookupId,
          billingPeriod
        );
        if (!canRetryWithRefreshed(refreshedInfo, dodoProductId)) {
          // Same ID or still missing - product genuinely doesn't exist in Dodo
          throw firstError;
        }

        logger.info(
          `Retrying checkout with refreshed product ID: ${refreshedInfo.productId}`
        );
        checkoutResult = await createDodoCheckout(
          refreshedInfo.productId,
          refreshedInfo.isRecurring
        );
      }

      // MONEY-1062 (J-F2): ONE update carrying BOTH the dodoPaymentId AND (when
      // present) the dodoSubscriptionId. The previous code did TWO sequential
      // updates that EACH spread the STALE in-memory `payment.metadata` (from
      // payment.create) — so the second write's spread did not include the first's
      // `dodoSubscriptionId` and silently wiped it, breaking later renewal/cancel/
      // dunning webhooks that look the row up by that id. A single merge preserves
      // both keys (subscriptionId only when Dodo returned one).
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          dodoPaymentId: checkoutResult.paymentId,
          metadata: {
            ...(payment.metadata as object),
            ...(checkoutResult.subscriptionId
              ? { dodoSubscriptionId: checkoutResult.subscriptionId }
              : {}),
            dodoPaymentId: checkoutResult.paymentId,
          },
        },
      });

      return {
        success: true,
        checkoutUrl: checkoutResult.url ?? undefined,
        paymentId: payment.id,
      };
    } catch (dodoError: unknown) {
      logger.error(
        { error: dodoError, action: "createCheckoutAction" },
        "Dodo Payments error"
      );

      // Mark the payment as failed - store sanitized message, not raw Dodo error
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "FAILED",
          errorMessage: getCheckoutFailedErrorMessage(),
        },
      });

      return {
        success: false,
        error: getCheckoutFailedUserMessage(),
      };
    }
  } catch (error: unknown) {
    logger.error(
      { error, action: "createCheckoutAction" },
      "Create checkout error"
    );
    return {
      success: false,
      error: "Failed to create checkout session. Please try again.",
    };
  }
}

// SECURITY (MONEY-587): the previous `updateSubscriptionPlan` server action
// was removed. Because this module is "use server", every export is a
// browser-callable action, and that wrapper took attacker-controlled
// userId/planId and granted any plan with NO auth/ownership/verified-payment
// check (financial privilege escalation). Plan mutations must only happen via
// the service helper `updateSubscriptionPlanService` from a trusted,
// authenticated server-side caller (e.g. the Svix-verified Dodo webhook, or
// the authenticated downgrade path above). No client imported this wrapper.

// Use an AI query
export async function consumeAIQuery(
  queryType: "fast" | "advanced" = "fast"
): Promise<{
  success: boolean;
  remaining?: number;
  error?: string;
}> {
  try {
    const authUser = await getAuthenticatedUser();

    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const result = await consumeAIQueryService(authUser.userId, queryType);

    if (result?.success) {
      return { success: true, remaining: result?.data.remaining };
    }

    // If queries exhausted, send notification email
    if (result.code === "QUERIES_EXHAUSTED") {
      // Fetch user details for email
      const user = await prisma.user.findUnique({
        where: { id: authUser.userId },
        select: { email: true, name: true, emailPreferences: true },
      });
      const subscription = await prisma.subscription.findUnique({
        where: { userId: authUser.userId },
        select: { planId: true },
      });

      if (user) {
        const aiPrefs = getEffectivePreferences(user.emailPreferences);
        if (shouldSendEmail(aiPrefs, "ai-query-limit")) {
          const unsubUrl = buildUnsubscribeUrl(user.email, "aiInsights");
          sendEmail({
            to: user.email,
            subject: "AI Query Limit Reached - UseMoney",
            unsubscribeUrl: unsubUrl,
            react: React.createElement(AiQueryLimitEmail, {
              name: user.name || "there",
              planName: subscription?.planId || "FREE",
              unsubscribeUrl: unsubUrl,
            }),
            template: "ai-query-limit",
          });
        }
      }
    }

    return { success: false, error: result?.error };
  } catch (error) {
    logger.error({ error, action: "useAiQueryAction" }, "Use AI query error");
    return { success: false, error: "Failed to use AI query" };
  }
}

// Cancel subscription
export async function cancelSubscriptionAction(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const authUser = await getAuthenticatedUser();

    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const result = await cancelSubscription(authUser.userId);
    return {
      success: result?.success,
      error: result?.success ? undefined : result?.error,
    };
  } catch (error) {
    logger.error(
      { error, action: "cancelSubscriptionAction" },
      "Cancel subscription error"
    );
    return { success: false, error: "Failed to cancel subscription" };
  }
}

// Downgrade to free plan
export async function downgradeWithGracePeriodAction(): Promise<{
  success: boolean;
  gracePeriodEndDate?: string;
  error?: string;
}> {
  try {
    const authUser = await getAuthenticatedUser();

    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const result = await downgradeWithGracePeriod(authUser.userId);

    if (!result?.success) {
      return { success: false, error: result?.error };
    }

    return {
      success: true,
      gracePeriodEndDate: result?.data.gracePeriodEndDate,
    };
  } catch (error) {
    logger.error(
      { error, action: "downgradeWithGracePeriodAction" },
      "Downgrade with grace period error"
    );
    return { success: false, error: "Failed to downgrade subscription" };
  }
}

// Legacy function for backwards compatibility - redirects to new function
export async function downgradeToFreeAction(): Promise<{
  success: boolean;
  error?: string;
}> {
  const result = await downgradeWithGracePeriodAction();
  return {
    success: result?.success,
    error: result?.error,
  };
}

// Refund a consumed query (when API call fails)
export async function refundAIQuery(
  queryType: "fast" | "advanced" = "fast"
): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const authUser = await getAuthenticatedUser();

    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const result = await refundAIQueryService(authUser.userId, queryType);
    return {
      success: result?.success,
      error: result?.success ? undefined : result?.error,
    };
  } catch (error) {
    logger.error({ error, action: "refundAIQuery" }, "Refund query error");
    return { success: false, error: "Failed to refund query" };
  }
}

// Refresh pending payments by checking Dodo's API directly.
// NOTE: Delegates to service (which handles Dodo API calls)
export async function refreshPendingPaymentsAction(): Promise<{
  success: boolean;
  updated: number;
  error?: string;
}> {
  try {
    const authUser = await getAuthenticatedUser();

    if (!authUser) {
      return { success: false, updated: 0, error: "Not authenticated" };
    }

    const result = await refreshPendingPayments(authUser.userId);

    if (!result?.success) {
      return { success: false, updated: 0, error: result?.error };
    }

    return { success: true, updated: result?.data.updated };
  } catch (error) {
    logger.error(
      { error, action: "refreshPendingPaymentsAction" },
      "Refresh pending payments error"
    );
    return { success: false, updated: 0, error: "Failed to refresh payments" };
  }
}

// Get payment history
export async function getPaymentHistoryAction(): Promise<{
  success: boolean;
  data?: Array<{
    id: string;
    planId: string;
    planName: string;
    amount: number;
    currency: string;
    status: string;
    paidAt: string | null;
    createdAt: string;
    errorMessage: string | null;
    period: string;
    invoiceUrl: string | null;
    paymentMethod: string | null;
    paymentMethodType: string | null;
    cardLastFour: string | null;
    cardNetwork: string | null;
  }>;
  error?: string;
}> {
  try {
    const authUser = await getAuthenticatedUser();

    if (!authUser) {
      return { success: false, error: "Not authenticated" };
    }

    const result = await getPaymentHistory(authUser.userId);

    if (!result?.success) {
      return { success: false, error: result?.error };
    }

    return { success: true, data: result?.data };
  } catch (error) {
    logger.error(
      { error, action: "getPaymentHistoryAction" },
      "Get payment history error"
    );
    return { success: false, error: "Failed to fetch payment history" };
  }
}

// Pre-flight credit check for AI features (analysis, compare, research)
export async function checkAICreditsAction(
  queryType: "fast" | "advanced" = "fast"
): Promise<{
  allowed: boolean;
  reason: "ok" | "free" | "no_credits";
  planId: string;
}> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { allowed: false, reason: "free", planId: "FREE" };
    }

    const subResult = await getSubscription(authUser.userId);
    if (!subResult.success || !subResult.data) {
      return { allowed: false, reason: "free", planId: "FREE" };
    }

    const { planId } = subResult.data;

    // Free users cannot use AI features
    if (planId === "FREE") {
      return { allowed: false, reason: "free", planId };
    }

    // Check unified credits (creditsLimit/creditsUsed replaced the old fast/advanced split)
    const creditsLimit = subResult.data.creditsLimit ?? 0;
    const creditsUsed = subResult.data.creditsUsed ?? 0;
    const packCreditsLimit = subResult.data.packCreditsLimit ?? 0;
    const packCreditsUsed = subResult.data.packCreditsUsed ?? 0;

    // Unlimited credits
    if (creditsLimit === -1) {
      return { allowed: true, reason: "ok", planId };
    }

    const planRemaining = Math.max(0, creditsLimit - creditsUsed);
    const packRemaining = Math.max(0, packCreditsLimit - packCreditsUsed);
    const totalRemaining = planRemaining + packRemaining;

    if (totalRemaining > 0) {
      return { allowed: true, reason: "ok", planId };
    }

    return { allowed: false, reason: "no_credits", planId };
  } catch (error) {
    logger.error(
      { error, action: "checkAICreditsAction" },
      "AI credit pre-check failed"
    );
    return { allowed: false, reason: "free", planId: "FREE" };
  }
}

// ─────────────────────────────────────────────────────────────────────
// MONEY-482: scheduled plan changes (downgrades, cycle downgrades,
// cancellations). These three actions stamp `Subscription.scheduledPlanId`
// / `scheduledBillingPeriod` / `scheduledEffectiveAt` and let the
// /api/cron/apply-scheduled-plan-changes route flip the plan on the
// effective date. No refund is issued at any point — the current cycle
// is honored to expiry, then the plan changes.
// ─────────────────────────────────────────────────────────────────────

interface ScheduleActionResult {
  success: boolean;
  scheduledEffectiveAt?: string;
  error?: string;
}

/**
 * Schedule a cancellation. The user keeps full access until their
 * current billing period ends, then drops to FREE.
 *
 * Side effects:
 *   - Subscription.scheduledPlanId = "FREE"
 *   - Subscription.scheduledBillingPeriod = null
 *   - Subscription.scheduledEffectiveAt = endDate (or nextBillingDate)
 *   - Dodo subscription gets `cancel_at_next_billing_date: true` so
 *     auto-renewal stops; the user is not charged again.
 */
export async function scheduleCancelAction(): Promise<ScheduleActionResult> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const sub = await prisma.subscription.findUnique({
      where: { userId: authUser.userId },
    });
    if (!sub) {
      return { success: false, error: "No active subscription found" };
    }
    if (sub.planId === "FREE") {
      return { success: false, error: "You are already on the Free plan" };
    }

    // First-cycle rows fulfilled via the webhook have endDate=null and may
    // not have nextBillingDate yet. Derive the term end from startDate +
    // billing period instead of refusing the cancel (the old error pushed
    // users into the immediate-FREE path, wiping their paid term with no
    // Dodo-side cancel at all).
    const derivedEnd = sub.startDate
      ? new Date(
          sub.startDate.getTime() +
            (sub.billingPeriod === "annual" ? 365 : 30) * 24 * 60 * 60 * 1000
        )
      : null;
    const effectiveAt = sub.endDate ?? sub.nextBillingDate ?? derivedEnd;
    if (!effectiveAt) {
      return {
        success: false,
        error:
          "Could not determine your billing period end date. Please contact support.",
      };
    }

    // Tell Dodo to stop auto-renewing. If this fails, we still stamp
    // the local schedule so the cron downgrades the plan at expiry —
    // worst case Dodo charges one more cycle which we refund manually.
    if (sub.dodoSubscriptionId) {
      try {
        await dodoClient.subscriptions.update(sub.dodoSubscriptionId, {
          cancel_at_next_billing_date: true,
        });
      } catch (dodoErr) {
        logger.error(
          { error: dodoErr, action: "scheduleCancelAction" },
          "Dodo cancel_at_next_billing_date update failed (local schedule still set)"
        );
      }
    }

    await prisma.subscription.update({
      where: { userId: authUser.userId },
      data: {
        scheduledPlanId: "FREE",
        scheduledBillingPeriod: null,
        scheduledEffectiveAt: effectiveAt,
      },
    });

    return {
      success: true,
      scheduledEffectiveAt: effectiveAt.toISOString(),
    };
  } catch (error) {
    logger.error(
      { error, action: "scheduleCancelAction" },
      "Schedule cancel error"
    );
    return { success: false, error: "Failed to schedule cancellation" };
  }
}

/**
 * Schedule a tier or cycle downgrade. The user keeps their current plan
 * + cycle until expiry, then the cron flips them to the target plan.
 *
 * Examples:
 *   PREMIUM monthly → PRO monthly  (tier downgrade, same cycle)
 *   PREMIUM annual  → PRO annual   (tier downgrade, same cycle)
 *   PRO annual      → PRO monthly  (same tier, cycle downgrade)
 */
export async function scheduleDowngradeAction(
  targetPlanId: "PRO" | "PREMIUM",
  targetCycle: "monthly" | "annual"
): Promise<ScheduleActionResult> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const sub = await prisma.subscription.findUnique({
      where: { userId: authUser.userId },
    });
    if (!sub) {
      return { success: false, error: "No active subscription found" };
    }

    const effectiveAt = sub.endDate ?? sub.nextBillingDate;
    if (!effectiveAt) {
      return {
        success: false,
        error: "Could not determine your billing period end date.",
      };
    }

    // For the Dodo side: keep the current sub alive until end-of-term,
    // do NOT set cancel_at_next_billing_date. The cron job creates a
    // new Dodo subscription for the downgraded plan on `effectiveAt`.
    await prisma.subscription.update({
      where: { userId: authUser.userId },
      data: {
        scheduledPlanId: targetPlanId,
        scheduledBillingPeriod: targetCycle,
        scheduledEffectiveAt: effectiveAt,
      },
    });

    return {
      success: true,
      scheduledEffectiveAt: effectiveAt.toISOString(),
    };
  } catch (error) {
    logger.error(
      { error, action: "scheduleDowngradeAction" },
      "Schedule downgrade error"
    );
    return { success: false, error: "Failed to schedule downgrade" };
  }
}

/**
 * Clear any pending scheduled change. Used by the "Undo" affordance on
 * the Settings → Plans banner. Also re-enables Dodo auto-renew if the
 * scheduled change was a cancel.
 */
export async function unscheduleChangeAction(): Promise<ScheduleActionResult> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const sub = await prisma.subscription.findUnique({
      where: { userId: authUser.userId },
    });
    if (!sub) {
      return { success: false, error: "No active subscription found" };
    }

    if (!sub.scheduledPlanId) {
      return { success: true }; // already nothing scheduled — idempotent no-op
    }

    // SECURITY (MONEY-865 — financial loss): a coupon / trial FREE-grant has
    // scheduledPlanId="FREE" but NO dodoSubscriptionId — nothing renews it, so
    // its auto-downgrade IS the term limit of the free grant. The downgrade cron
    // keys off scheduledPlanId; clearing it here (with no subscription to bill)
    // would strand the user on the paid plan FOREVER for free. A free grant's
    // term is not user-cancellable — only a real renewing subscription can be
    // "kept". (A paid cancellation has dodoSubscriptionId and falls through to
    // the re-enable-auto-renew path below.)
    if (sub.scheduledPlanId === "FREE" && !sub.dodoSubscriptionId) {
      return {
        success: false,
        error:
          "This plan was granted by a coupon and ends at the end of its term — it can't be extended.",
      };
    }

    // If we previously told Dodo to stop renewing (cancel path), undo
    // that so the user continues to be billed after their current term.
    if (sub.scheduledPlanId === "FREE" && sub.dodoSubscriptionId) {
      try {
        await dodoClient.subscriptions.update(sub.dodoSubscriptionId, {
          cancel_at_next_billing_date: false,
        });
      } catch (dodoErr) {
        logger.error(
          { error: dodoErr, action: "unscheduleChangeAction" },
          "Failed to re-enable Dodo auto-renew (local schedule cleared anyway)"
        );
      }
    }

    await prisma.subscription.update({
      where: { userId: authUser.userId },
      data: {
        scheduledPlanId: null,
        scheduledBillingPeriod: null,
        scheduledEffectiveAt: null,
      },
    });

    return { success: true };
  } catch (error) {
    logger.error(
      { error, action: "unscheduleChangeAction" },
      "Unschedule change error"
    );
    return { success: false, error: "Failed to undo scheduled change" };
  }
}

// ─────────────────────────────────────────────────────────────────────
// MONEY-482: plan-change preview. The client calls this BEFORE opening
// the confirmation dialog so it can render concrete copy ("Switching to
// PRO Annual. Your 22 remaining monthly days will be added → 387 days
// total. Charged today: ₹1,999.").
//
// This is a read-only call. The actual state change happens on confirm
// via createCheckoutAction (immediate paths) or scheduleCancelAction /
// scheduleDowngradeAction (scheduled paths).
// ─────────────────────────────────────────────────────────────────────

interface PlanChangePreview {
  success: boolean;
  /**
   * Classifier output. The dialog branches its copy on this:
   *   - "noop": nothing to do (same plan + cycle)
   *   - "first_purchase": FREE → paid
   *   - "cycle_append": same tier, monthly → annual (immediate charge + days appended)
   *   - "cycle_downgrade": same tier, annual → monthly (scheduled at term end)
   *   - "tier_upgrade": higher tier (immediate charge + bonus days credited)
   *   - "tier_downgrade": lower tier (scheduled at term end)
   *   - "cancel": → FREE (scheduled at term end)
   */
  kind?:
    | "noop"
    | "first_purchase"
    | "cycle_append"
    | "cycle_downgrade"
    | "tier_upgrade"
    | "tier_downgrade"
    | "cancel";
  /** Days remaining on the user's current paid term. 0 if no active sub. */
  daysRemaining?: number;
  /** Bonus days credited toward the new plan (tier_upgrade / cycle_append). */
  bonusDays?: number;
  /** Total term length the user gets if they confirm (standardTerm + bonus). */
  newTermDays?: number;
  /**
   * For scheduled changes — when the change actually takes effect.
   * ISO string. null for immediate paths.
   */
  effectiveAt?: string | null;
  /** Whether confirming will charge the user today. */
  willChargeToday?: boolean;
  error?: string;
}

export async function previewPlanChangeAction(
  targetPlanId: "PRO" | "PREMIUM" | "FREE",
  targetCycle: "monthly" | "annual" | null
): Promise<PlanChangePreview> {
  try {
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    const sub = await prisma.subscription.findUnique({
      where: { userId: authUser.userId },
    });

    const currentPlanId = (sub?.planId as string | undefined) ?? "FREE";
    const currentCycle =
      (sub?.billingPeriod as "monthly" | "annual" | null | undefined) ?? null;

    // Lazily import the classifier + math helpers — avoids pulling them
    // into edge bundles that never see this action.
    const {
      classifyTransition,
      computeTierUpgradeBonusDays,
      computeCycleAppendDays,
      daysRemaining: daysRemainingFn,
      STANDARD_TERM_DAYS,
    } = await import("@usemoney/core/subscription/proration");

    const kind = classifyTransition(
      currentPlanId,
      currentCycle,
      targetPlanId,
      targetCycle
    );

    const now = new Date();
    const remaining = daysRemainingFn(
      now,
      sub?.endDate ?? sub?.nextBillingDate
    );

    if (kind === "noop") {
      return { success: true, kind, daysRemaining: remaining };
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
        kind,
        daysRemaining: remaining,
        effectiveAt,
        willChargeToday: false,
      };
    }

    if (kind === "first_purchase") {
      const term =
        targetCycle === "annual"
          ? STANDARD_TERM_DAYS.annual
          : STANDARD_TERM_DAYS.monthly;
      return {
        success: true,
        kind,
        daysRemaining: 0,
        bonusDays: 0,
        newTermDays: term,
        willChargeToday: true,
      };
    }

    if (kind === "cycle_append") {
      const r = computeCycleAppendDays(remaining);
      return {
        success: true,
        kind,
        daysRemaining: remaining,
        bonusDays: r.bonusDays,
        newTermDays: r.totalTermDays,
        willChargeToday: true,
      };
    }

    // tier_upgrade
    const fromPlan = PLAN_CONFIG[currentPlanId as keyof typeof PLAN_CONFIG];
    const toPlan = PLAN_CONFIG[targetPlanId as keyof typeof PLAN_CONFIG];
    if (!fromPlan || !toPlan || !currentCycle || !targetCycle) {
      // Fallback: treat as plain first_purchase with no bonus days.
      const term =
        targetCycle === "annual"
          ? STANDARD_TERM_DAYS.annual
          : STANDARD_TERM_DAYS.monthly;
      return {
        success: true,
        kind,
        daysRemaining: remaining,
        bonusDays: 0,
        newTermDays: term,
        willChargeToday: true,
      };
    }
    // MONEY-872: never let a missing list price (a plan/cycle without a
    // configured original price) THROW out of the preview — it bubbled to the
    // outer catch → { success: false } → "could not start checkout", which blocked
    // the upgrade. Fall back to no bonus days, mirroring the fulfillment-side
    // computeFulfillmentBonusDays.
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
      kind,
      daysRemaining: remaining,
      bonusDays: upgrade.bonusDays,
      newTermDays: upgrade.totalTermDays,
      willChargeToday: true,
    };
  } catch (error) {
    logger.error(
      { error, action: "previewPlanChangeAction" },
      "Preview plan change error"
    );
    return { success: false, error: "Failed to preview plan change" };
  }
}
