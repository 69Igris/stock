/**
 * Dodo payment-provisioning transport — PAYMENTS domain (MONEY-1062 W1-B).
 *
 * Founder directive (mid-wave): payments and subscription are SEPARATE setups
 * with a hard boundary. This module owns the PAYMENTS side only:
 *   - webhook envelope dispatch (`provisionDodoWebhookEvent`);
 *   - Payment-row bookkeeping (COMPLETED / FAILED / REFUNDED, metadata merge,
 *     invoice / settlement / card fields);
 *   - the `Payment.appliedAt` claim-once mechanics (MONEY-594) — the shared claim
 *     that makes the webhook↔callback race apply the grant exactly once;
 *   - pre-extracting the linkage the subscription grant needs (dodoSubscriptionId,
 *     creditPackSize) off the Payment row;
 *   - transactional-notification orchestration (the injected `PaymentNotifier`)
 *     and coupon redemption.
 *
 * It CALLS INTO `subscription-grants.service.ts` (subscription domain) for every
 * Subscription-table write, passing the claim/release as callbacks so the
 * claim-once mechanics stay entirely here. It imports core plan config
 * (`extractCreditPackSize`) — one-directional payments→core — but never reaches
 * into the subscription table where a subscription-domain function exists.
 *
 * Claim-once / race / idempotency behaviour is tested against THIS module.
 *
 * @see packages/services/src/subscription-grants.service.ts (subscription writes)
 * @see packages/services/src/payment-provisioning-logic.ts (pure seams + types)
 * @see apps/web/__tests__/api/payment-provisioning-service.test.ts
 */

import { prisma, Prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import { extractCreditPackSize } from "@usemoney/core/payments/plan-config";
import { recordCouponRedemption } from "./coupon.service";
import {
  claimPaymentFulfillment,
  releasePaymentFulfillment,
} from "./payment-grant.service";
import {
  grantWebhookSubscription,
  grantCallbackSubscription,
  applyDodoCancellation,
  applyDodoRenewal,
  storeDodoActivationAnchors,
  markDodoPastDue,
  markDodoExpired,
} from "./subscription-grants.service";
import {
  coerceFiniteAmount,
  extractDodoSubscriptionId,
  mapWebhookEvent,
  sanitizePaymentError,
  type CallbackGrantOutcome,
  type DodoWebhookData,
  type PaymentNotifier,
} from "./payment-provisioning-logic";

// ---------------------------------------------------------------------------
// Webhook dispatcher — mirrors the route's `switch (event)` 1:1.
// ---------------------------------------------------------------------------

/**
 * Provision a verified Dodo webhook event. The route svix-verified the payload
 * and split it into `event` (`payload.type ?? payload.event`) and `data`
 * (`payload.data` — which a signed envelope may legitimately omit, so it is
 * guarded here rather than trusted). A `payment.succeeded` grant failure
 * propagates (→ the route 500s so Dodo retries with a fresh claim); every other
 * handler swallows its own errors and returns.
 */
export async function provisionDodoWebhookEvent(
  event: string | undefined,
  data: DodoWebhookData | null | undefined,
  notifier: PaymentNotifier,
): Promise<void> {
  logger.info({ event }, "[DODO WEBHOOK] Verified event");

  // A signed envelope without a data object would make the handlers below
  // throw on destructure → route 500s → Dodo redelivers forever. Ack it.
  if (!data || typeof data !== "object") {
    logger.error(
      { event },
      "[DODO WEBHOOK] Missing data payload — acking without action",
    );
    return;
  }

  switch (mapWebhookEvent(event)) {
    case "payment_completed":
      await provisionPaymentCompleted(data, notifier);
      break;
    case "payment_failed":
      await provisionPaymentFailed(data, notifier);
      break;
    case "subscription_cancelled":
      await provisionSubscriptionCancelled(data, notifier);
      break;
    case "subscription_renewed":
      await provisionSubscriptionRenewed(data, notifier);
      break;
    case "subscription_activated":
      await storeDodoActivationAnchors(
        data?.subscription_id,
        data?.next_billing_date ?? null,
      );
      break;
    case "subscription_past_due":
      await markDodoPastDue(data?.subscription_id, event ?? "");
      break;
    case "subscription_expired":
      await markDodoExpired(data?.subscription_id);
      break;
    case "refund_succeeded":
      await provisionRefundSucceeded(data);
      break;
    default:
      logger.info({ event }, "[DODO WEBHOOK] Unhandled event");
  }
}

// ---------------------------------------------------------------------------
// payment.succeeded — Payment bookkeeping + claim + subscription grant.
// ---------------------------------------------------------------------------

/**
 * Handle successful payment completion: stamp the Payment row COMPLETED, then
 * hand the subscription grant to the subscription domain under the shared
 * claim-once claim. Sends the success email + segment move + coupon redemption on
 * a won grant. Rethrows on a grant write failure (the subscription domain has
 * already released the claim) so the caller can 500 → retry.
 */
export async function provisionPaymentCompleted(
  data: DodoWebhookData,
  notifier: PaymentNotifier,
): Promise<void> {
  const { payment_id } = data;

  // Prisma DROPS an undefined where-value — findFirst would match an ARBITRARY
  // Payment row and complete/grant against it. Skip a payload with no id.
  if (!payment_id) {
    logger.error(
      { event: "payment.succeeded" },
      "[DODO WEBHOOK] provisionPaymentCompleted: missing payment_id — skipping",
    );
    return;
  }

  const payment = await prisma.payment.findFirst({
    where: { dodoPaymentId: payment_id },
  });
  if (!payment) {
    logger.error(
      { dodoPaymentId: payment_id },
      "[DODO WEBHOOK] Payment not found",
    );
    return;
  }

  // Payment-row bookkeeping (payments domain). Merge (not replace) so the
  // checkout-time keys the grant depends on survive this write.
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: "COMPLETED",
      paidAt: new Date(),
      metadata: {
        ...((payment.metadata ?? {}) as object),
        ...(data as Record<string, unknown>),
      } as Prisma.InputJsonValue,
      // MONEY-1062 review: every Dodo field below preserves the previously
      // stored value on a replay / out-of-order redelivery that omits it
      // (`?? payment.X`), extending the paymentMethod/dodoSubscriptionId pattern
      // to the whole row — a duplicate event must never NULL invoice / card /
      // settlement data an earlier delivery populated. Amounts additionally route
      // through coerceFiniteAmount so a malformed string can't persist NaN into a
      // money column.
      invoiceUrl: data?.invoice_url ?? payment.invoiceUrl ?? null,
      invoiceId: data?.invoice_id ?? payment.invoiceId ?? null,
      paymentMethodType:
        data?.payment_method_type ?? payment.paymentMethodType ?? null,
      cardLastFour: data?.card_last_four ?? payment.cardLastFour ?? null,
      cardNetwork: data?.card_network ?? payment.cardNetwork ?? null,
      cardType: data?.card_type ?? payment.cardType ?? null,
      paymentMethod: data?.payment_method ?? payment.paymentMethod ?? null,
      dodoSubscriptionId:
        data?.subscription_id ?? payment.dodoSubscriptionId ?? null,
      dodoCustomerId:
        data?.customer?.customer_id ?? payment.dodoCustomerId ?? null,
      settlementAmount:
        coerceFiniteAmount(data?.settlement_amount) ??
        payment.settlementAmount ??
        null,
      settlementCurrency:
        data?.settlement_currency ?? payment.settlementCurrency ?? null,
      // MONEY-877: presentment currency (what the customer was charged in).
      presentmentCurrency:
        data?.currency ?? payment.presentmentCurrency ?? null,
      taxAmount: coerceFiniteAmount(data?.tax) ?? payment.taxAmount ?? null,
      totalAmount:
        coerceFiniteAmount(data?.total_amount) ?? payment.totalAmount ?? null,
    },
  });

  // Pre-extract the subscription-grant linkage off the Payment row (payments
  // domain), so the subscription domain never touches the Payment table.
  const paymentMeta = payment.metadata as Record<string, unknown> | null;
  const dodoSubscriptionId = extractDodoSubscriptionId(paymentMeta, data);
  const creditPackSize = extractCreditPackSize(
    payment.metadata,
    payment.planName,
  );

  // The one-shot fulfillment claim (payments domain), handed to the grant.
  const claim = (): Promise<boolean> => claimPaymentFulfillment(payment.id);
  const releaseClaim = (): Promise<void> =>
    releasePaymentFulfillment(payment.id);

  const result = await grantWebhookSubscription(
    {
      userId: payment.userId,
      planId: payment.planId,
      period: payment.period,
      dodoSubscriptionId,
      nextBillingDate: data?.next_billing_date ?? null,
      creditPackSize,
    },
    claim,
    releaseClaim,
  );

  // Notify + record the coupon only on a fresh grant (claim-loss / guards
  // returned already, exactly as the inline handlers did).
  if (result !== "plan_granted" && result !== "addon_granted") {
    // Forensic correlation the old inline route logged: WHICH Payment saw its
    // grant skipped (claim lost to the callback race, or an addon guard).
    logger.info(
      { paymentId: payment.id, dodoPaymentId: payment_id, result },
      "[DODO WEBHOOK] Grant skipped (claim lost or guard)",
    );
    return;
  }

  // MONEY-1062 (J-F7): the grant above is DURABLE (the claim committed). Everything
  // below is best-effort post-grant side effects (user fetch, receipt notify,
  // segment move, coupon redemption). Wrap the WHOLE block so a transient throw here
  // does NOT propagate → route 500 → Dodo redelivery: a redelivered event would hit
  // already_applied and RETURN before re-running these, so recordCouponRedemption
  // would never fire (coupon stays reusable, usage undercounts). Log + swallow; the
  // inner coupon try/catch is preserved.
  try {
    // Single user fetch, reused by the notify AND coupon blocks below.
    const user = await prisma.user.findUnique({
      where: { id: payment.userId },
    });
    if (user) {
      // MONEY-877: the REAL charge (Dodo total_amount + presentment currency).
      // Coerce first so a malformed Dodo total never renders "₹NaN" in the receipt.
      // MONEY-1062 (J-F10 + Round C / C1#8): amount and currency move as an ATOMIC
      // pair — the Dodo (total_amount, currency) pair is used only when BOTH are
      // present; otherwise fall back to the full stored checkout pair
      // (payment.amount, payment.currency). The earlier half-pairs mislabelled the
      // receipt both ways: the INR figure under the presentment currency (total
      // missing) and the presentment total under payment.currency (currency
      // missing).
      const dodoTotal = coerceFiniteAmount(data?.total_amount);
      const dodoCurrency = data?.currency ?? null;
      const hasDodoPair = dodoTotal != null && dodoCurrency != null;
      const amount = String(hasDodoPair ? dodoTotal / 100 : payment.amount);
      const currency = hasDodoPair ? dodoCurrency : payment.currency;
      if (result === "addon_granted") {
        notifier.paymentSucceeded({
          user,
          planName: "AI Query Pack",
          amount,
          currency,
        });
      } else {
        notifier.paymentSucceeded({
          user,
          planName: payment.planName,
          amount,
          currency,
        });
        // Move from free to paid segment (awaited; the notifier logs its own error).
        await notifier.moveSegment({ user, from: "free", to: "paid" });
      }
    }

    // Record coupon redemption if a discount code was used.
    const usedDiscountCode = paymentMeta?.discountCode as string | undefined;
    if (usedDiscountCode && user) {
      try {
        await recordCouponRedemption(
          usedDiscountCode,
          payment.userId,
          user.email,
          payment.id,
        );
        logger.info(
          { discountCode: usedDiscountCode, email: user.email },
          "[DODO WEBHOOK] Coupon redemption recorded",
        );
      } catch (err) {
        logger.error(
          { error: err, discountCode: usedDiscountCode },
          "[DODO WEBHOOK] Failed to record coupon redemption",
        );
      }
    }
  } catch (sideEffectErr) {
    // The grant is durable; a side-effect failure must NOT 500 the route (a Dodo
    // redelivery would skip these steps via already_applied). Log and move on.
    logger.error(
      {
        error: sideEffectErr,
        paymentId: payment.id,
        dodoPaymentId: payment_id,
      },
      "[DODO WEBHOOK] Post-grant side effects failed (grant durable; not rethrown)",
    );
  }
}

// ---------------------------------------------------------------------------
// payment.failed (payments domain — no subscription write).
// ---------------------------------------------------------------------------

/** Handle failed payment: stamp the Payment FAILED + notify with a sanitized error. */
export async function provisionPaymentFailed(
  data: DodoWebhookData,
  notifier: PaymentNotifier,
): Promise<void> {
  const { payment_id, error_message } = data;

  // Prisma DROPS an undefined where-value — findFirst would match an ARBITRARY
  // Payment row and mark it FAILED. Skip a payload with no id.
  if (!payment_id) {
    logger.error(
      { event: "payment.failed" },
      "[DODO WEBHOOK] provisionPaymentFailed: missing payment_id — skipping",
    );
    return;
  }

  const safeErrorMessage = sanitizePaymentError(error_message);

  const payment = await prisma.payment.findFirst({
    where: { dodoPaymentId: payment_id },
  });

  if (payment) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "FAILED",
        errorMessage: error_message, // raw, for internal debugging
        // MONEY-872: MERGE, don't REPLACE — a later fail→succeed retry must keep
        // the checkout keys (creditPackSize etc.). Nest the failure event.
        metadata: {
          ...((payment.metadata as Record<string, unknown> | null) ?? {}),
          failureEvent: data,
        } as Prisma.InputJsonValue,
      },
    });
    logger.info({ dodoPaymentId: payment_id }, "[DODO WEBHOOK] Payment failed");

    const failedUser = await prisma.user.findUnique({
      where: { id: payment.userId },
    });
    if (failedUser) {
      notifier.paymentFailed({
        user: failedUser,
        planName: payment.planName,
        errorMessage: safeErrorMessage,
      });
    }
  } else {
    logger.error(
      { dodoPaymentId: payment_id },
      "[dodo] payment.failed for unknown payment id",
    );
  }
}

// ---------------------------------------------------------------------------
// refund.succeeded (payments domain — Payment bookkeeping only).
// ---------------------------------------------------------------------------

/**
 * Refund processed by Dodo. Marks the Payment REFUNDED (bookkeeping). Entitlement
 * revocation is a product decision, flagged loudly for manual review rather than
 * auto-downgrading — so this deliberately performs NO subscription write.
 */
export async function provisionRefundSucceeded(
  data: DodoWebhookData,
): Promise<void> {
  const payment_id = data?.payment_id;

  // Prisma DROPS an undefined where-value — findFirst would match an ARBITRARY
  // Payment row and mark it REFUNDED. Skip a payload with no id.
  if (!payment_id) {
    logger.error(
      { event: "refund.succeeded" },
      "[DODO WEBHOOK] provisionRefundSucceeded: missing payment_id — skipping",
    );
    return;
  }

  const payment = await prisma.payment.findFirst({
    where: { dodoPaymentId: payment_id },
  });
  if (!payment) {
    logger.error(
      { dodoPaymentId: payment_id },
      "[dodo] refund.succeeded for unknown payment id",
    );
    return;
  }
  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: "REFUNDED" },
  });
  logger.warn(
    {
      dodoPaymentId: payment_id,
      userId: payment.userId,
      planId: payment.planId,
    },
    "[DODO WEBHOOK] Payment REFUNDED — review entitlement manually",
  );
}

// ---------------------------------------------------------------------------
// subscription.cancelled / renewed — subscription write + notification.
// ---------------------------------------------------------------------------

/** subscription.cancelled: delegate the subscription write, then notify + move segment. */
export async function provisionSubscriptionCancelled(
  data: DodoWebhookData,
  notifier: PaymentNotifier,
): Promise<void> {
  const target = await applyDodoCancellation(data?.subscription_id);
  if (!target) return;
  const user = await prisma.user.findUnique({ where: { id: target.userId } });
  if (user) {
    notifier.subscriptionCancelled({ user, planName: target.planName });
    // Move paid → downgraded (NOT free) for win-back targeting.
    await notifier.moveSegment({ user, from: "paid", to: "downgraded" });
  }
}

/** subscription.renewed: delegate the subscription write, then notify. */
export async function provisionSubscriptionRenewed(
  data: DodoWebhookData,
  notifier: PaymentNotifier,
): Promise<void> {
  const target = await applyDodoRenewal(
    data?.subscription_id,
    data?.next_billing_date ?? null,
  );
  if (!target) return;
  const user = await prisma.user.findUnique({ where: { id: target.userId } });
  if (user) {
    notifier.subscriptionRenewed({ user, planName: target.planName });
  }
}

// ---------------------------------------------------------------------------
// payments/callback grant (browser redirect path).
// ---------------------------------------------------------------------------

/**
 * The paid Payment row the callback route hands the grant. The route has already
 * validated params, loaded the row, resolved PENDING→COMPLETED via the Dodo poll,
 * verified ownership, and confirmed a known plan.
 */
export interface CallbackGrantPayment {
  id: string;
  userId: string;
  planId: string;
  planName: string;
  period: string | null;
  /** Payment.status — re-asserted here (must be "COMPLETED") so this exported
   * seam never trusts the route's guards alone. */
  status: string;
  metadata: unknown;
}

/**
 * Apply the payments-callback grant (payments transport): pre-extract linkage off
 * the Payment row, run the shared claim-once claim, delegate the subscription
 * write to the subscription domain, and record the coupon for the winner. Sends
 * NO emails — the Svix webhook is the authoritative notify path. Rethrows on a
 * grant write failure (claim already released) so the route maps it to
 * `callback_failed`.
 */
export async function provisionPaymentCallbackGrant(input: {
  payment: CallbackGrantPayment;
}): Promise<CallbackGrantOutcome> {
  const currentPayment = input.payment;

  // Defence-in-depth: the route verified status before calling, but this
  // exported seam must not trust its caller — an unpaid Payment must never
  // reach the claim/grant.
  if (currentPayment.status !== "COMPLETED") {
    logger.error(
      { paymentId: currentPayment.id, status: currentPayment.status },
      "[Payment Callback] Grant refused: payment is not COMPLETED",
    );
    return "not_completed";
  }

  // FIX (MONEY-1062 review): read the Dodo subscription id from BOTH the
  // checkout-time `dodoSubscriptionId` metadata key AND the `subscription_id` the
  // webhook / Dodo poll merges into this same metadata (callback-route lines
  // 78-98 / provisionPaymentCompleted metadata merge). Passing `{}` as the 2nd
  // arg missed the latter, so a callback whose checkout never stashed
  // `dodoSubscriptionId` wrote a NULL linkage — later renewal/cancel/dunning
  // webhooks (which look up by dodoSubscriptionId) then could not find the row.
  const callbackMetadata = (currentPayment.metadata ?? null) as Record<
    string,
    unknown
  > | null;
  const dodoSubscriptionId = extractDodoSubscriptionId(
    callbackMetadata,
    callbackMetadata,
  );
  const creditPackSize = extractCreditPackSize(
    currentPayment.metadata,
    currentPayment.planName,
  );

  const claim = (): Promise<boolean> =>
    claimPaymentFulfillment(currentPayment.id);
  const releaseClaim = (): Promise<void> =>
    releasePaymentFulfillment(currentPayment.id);

  const outcome = await grantCallbackSubscription(
    {
      userId: currentPayment.userId,
      planId: currentPayment.planId,
      period: currentPayment.period,
      dodoSubscriptionId,
      creditPackSize,
    },
    claim,
    releaseClaim,
  );

  if (outcome === "already_applied") {
    // Forensic correlation (parity with the webhook path): WHICH Payment saw
    // its callback grant skipped because the claim was already consumed.
    logger.info(
      { paymentId: currentPayment.id, outcome },
      "[Payment Callback] Grant skipped (claim lost or guard)",
    );
  }

  // Record coupon redemption for the fulfillment winner (claim-losing paths
  // returned "already_applied"; ineligible returned earlier).
  if (outcome === "granted") {
    const couponMeta = (currentPayment.metadata ?? {}) as Record<
      string,
      unknown
    >;
    const usedDiscountCode = couponMeta.discountCode as string | undefined;
    if (usedDiscountCode) {
      try {
        const couponUser = await prisma.user.findUnique({
          where: { id: currentPayment.userId },
        });
        if (couponUser) {
          await recordCouponRedemption(
            usedDiscountCode,
            currentPayment.userId,
            couponUser.email,
            currentPayment.id,
          );
        }
      } catch (err) {
        logger.error(
          { error: err, discountCode: usedDiscountCode },
          "[Payment Callback] Failed to record coupon redemption",
        );
      }
    }
  }

  return outcome;
}
