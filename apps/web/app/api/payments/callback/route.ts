import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { dodoClient } from "@usemoney/core/payments";
import { PLAN_CONFIG, resolvePlanId } from "@usemoney/core/subscription";
import { getAuthenticatedUser } from "@/lib/auth";
import { provisionPaymentCallbackGrant } from "@usemoney/services";
import { clearSubscriptionCache } from "@usemoney/core/cache";
import {
  validateCallbackParams,
  getCallbackBaseUrl,
  buildPricingErrorPath,
  buildSubscriptionPendingPath,
  SUBSCRIPTION_SUCCESS_PATH,
} from "./callback-logic";
import { dbLogger as logger } from "@usemoney/logger";

/**
 * Dodo payment redirect callback — MONEY-1062 (W1-B) thin transport.
 *
 * This route owns only the browser-return transport: param validation, loading
 * the Payment row, resolving PENDING→COMPLETED/FAILED via the Dodo
 * `payments.retrieve` poll (so localhost/dev where webhooks can't reach the
 * server still fulfils), the MONEY-587 ownership guard, plan validation, and the
 * redirect mapping. The subscription/credit GRANT — the claim-once money path
 * shared with the Svix webhook — lives in
 * packages/services/src/payment-provisioning.service.ts
 * (`provisionPaymentCallbackGrant`). The webhook remains the authoritative
 * activation path; this handler hardens the redirect return.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const paymentId = searchParams.get("paymentId");
  const planId = searchParams.get("planId");
  const baseUrl = getCallbackBaseUrl();

  const paramCheck = validateCallbackParams(paymentId, planId);
  // The `|| !paymentId || !planId` is redundant at runtime (the helper already
  // covers it) but narrows both to `string` for the rest of the handler.
  if (!paramCheck.valid || !paymentId || !planId) {
    return NextResponse.redirect(
      new URL(
        buildPricingErrorPath(paramCheck.error ?? "invalid_params"),
        baseUrl
      )
    );
  }

  try {
    // Get the payment record
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      logger.warn(
        { paymentId, reason: "payment_not_found" },
        "Payment callback rejected: payment record not found"
      );
      return NextResponse.redirect(
        new URL(buildPricingErrorPath("payment_not_found"), baseUrl)
      );
    }

    // Verify payment status.
    // First check if the webhook already updated the status in our DB.
    // If still PENDING, query Dodo's API directly to get the real status.
    // This handles localhost/dev where webhooks can't reach the server.
    let currentPayment = payment;

    if (currentPayment.status === "PENDING" && currentPayment.dodoPaymentId) {
      try {
        // Bound this browser-blocking round-trip (MONEY-1074). The redirect is
        // issued only AFTER this resolves, so the SDK defaults (~60s timeout ×
        // 2 retries) were the multi-minute "slow redirect after payment". 6s
        // single attempt covers a healthy Dodo p99; on timeout the SDK throws
        // and we fall through to the PENDING redirect below (the webhook / a
        // re-hit callback still fulfils).
        const dodoPayment = await dodoClient.payments.retrieve(
          currentPayment.dodoPaymentId,
          { timeout: 6_000, maxRetries: 0 }
        );

        if (dodoPayment.status === "succeeded") {
          // Merge — wiping checkout keys here stranded credit packs
          // (the grant reads creditPackSize off this row).
          const mergedMetadata = {
            ...((payment.metadata ?? {}) as object),
            ...JSON.parse(JSON.stringify(dodoPayment)),
          };
          await prisma.payment.update({
            where: { id: paymentId },
            data: {
              status: "COMPLETED",
              paidAt: new Date(),
              metadata: mergedMetadata,
            },
          });
          currentPayment = {
            ...currentPayment,
            status: "COMPLETED",
            paidAt: new Date(),
            // The grant below extracts dodoSubscriptionId from THIS in-memory
            // metadata — it must see exactly what the DB write just persisted,
            // not the stale pre-poll snapshot.
            metadata: mergedMetadata,
          };
        } else if (
          dodoPayment.status === "failed" ||
          dodoPayment.status === "cancelled"
        ) {
          await prisma.payment.update({
            where: { id: paymentId },
            data: {
              status: "FAILED",
              errorMessage:
                dodoPayment.status === "cancelled"
                  ? "Payment was cancelled"
                  : "Payment failed",
              metadata: {
                ...((payment.metadata ?? {}) as object),
                ...JSON.parse(JSON.stringify(dodoPayment)),
              },
            },
          });
          currentPayment = { ...currentPayment, status: "FAILED" };
        }
        // For any other status (processing, requires_customer_action, etc.)
        // fall through to the PENDING handling below.
      } catch (dodoError) {
        // Distinguish a bounded-timeout (expected under Dodo slowness — the
        // pending redirect + client poll still fulfil) from a real API error,
        // so QA/ops can tell "slow" from "broken" (MONEY-1074).
        const timedOut =
          dodoError instanceof Error &&
          /timeout|timed out|aborted/i.test(dodoError.message);
        logger.error(
          {
            error: dodoError,
            paymentId,
            dodoPaymentId: currentPayment.dodoPaymentId,
            timedOut,
          },
          timedOut
            ? "Dodo payment retrieve timed out; redirecting as pending"
            : "Failed to retrieve Dodo payment status"
        );
        // Fall through - will redirect as pending
      }
    }

    if (currentPayment.status === "FAILED") {
      logger.warn(
        { paymentId, userId: currentPayment.userId, reason: "payment_failed" },
        "Payment callback rejected: payment status is FAILED"
      );
      return NextResponse.redirect(
        new URL(buildPricingErrorPath("payment_failed"), baseUrl)
      );
    }

    if (currentPayment.status === "PENDING") {
      // Payment still not resolved - Dodo API might be slow or still processing.
      return NextResponse.redirect(
        new URL(buildSubscriptionPendingPath(paymentId), baseUrl)
      );
    }

    if (currentPayment.status !== "COMPLETED") {
      logger.warn(
        {
          paymentId,
          userId: currentPayment.userId,
          reason: "payment_not_verified",
          status: currentPayment.status,
        },
        "Payment callback rejected: payment status is not COMPLETED"
      );
      return NextResponse.redirect(
        new URL(buildPricingErrorPath("payment_not_verified"), baseUrl)
      );
    }

    // SECURITY (MONEY-587): ownership check. The activation below grants a
    // paid tier, so only the user who owns this payment may trigger it. We
    // resolve the Clerk session to its internal user id and require it to
    // match payment.userId. The webhook (Svix-verified) remains the
    // authoritative activation path; this guard hardens the redirect handler
    // without blocking the legitimate buyer's return.
    const authUser = await getAuthenticatedUser();
    if (!authUser || authUser.userId !== currentPayment.userId) {
      logger.warn(
        {
          paymentId,
          userId: currentPayment.userId,
          authUserId: authUser?.userId ?? null,
          reason: "payment_forbidden",
        },
        "Payment callback rejected: ownership mismatch (potential replay/attack)"
      );
      return NextResponse.redirect(
        new URL(buildPricingErrorPath("payment_forbidden"), baseUrl)
      );
    }

    // SECURITY (MONEY-587): derive the plan SOLELY from the persisted, paid
    // Payment record (currentPayment.planId) — NEVER from the user-controllable
    // `planId` query param. The grant service re-derives the same way; this guard
    // just rejects a paid row whose plan id does not resolve to a known plan.
    const resolvedPlanId = resolvePlanId(currentPayment.planId);
    const plan = PLAN_CONFIG[resolvedPlanId as keyof typeof PLAN_CONFIG];
    if (!plan) {
      logger.warn(
        {
          paymentId,
          userId: currentPayment.userId,
          reason: "invalid_plan",
          planId: currentPayment.planId,
          resolvedPlanId,
        },
        "Payment callback rejected: paid plan id does not resolve to a known plan"
      );
      return NextResponse.redirect(
        new URL(buildPricingErrorPath("invalid_plan"), baseUrl)
      );
    }

    // Payment is already COMPLETED (confirmed by webhook or the Dodo poll).
    // Ensure paidAt is set if the webhook didn't set it.
    if (!currentPayment.paidAt) {
      await prisma.payment.update({
        where: { id: paymentId },
        data: { paidAt: new Date() },
      });
    }

    // Apply the subscription/credit grant (claim-once, shared with the webhook).
    // A grant write failure rethrows → the outer catch redirects to
    // callback_failed and the webhook retry / a user retry re-grants.
    const outcome = await provisionPaymentCallbackGrant({
      payment: {
        id: currentPayment.id,
        userId: currentPayment.userId,
        planId: currentPayment.planId,
        planName: currentPayment.planName,
        period: currentPayment.period,
        status: currentPayment.status,
        metadata: currentPayment.metadata,
      },
    });

    if (outcome === "addon_ineligible") {
      return NextResponse.redirect(
        new URL(
          buildPricingErrorPath("addon_requires_pro_or_unlimited"),
          baseUrl
        )
      );
    }

    if (outcome === "not_completed") {
      // Should be unreachable (status was verified above) — the service
      // re-asserts it; map to the existing not-verified redirect.
      return NextResponse.redirect(
        new URL(buildPricingErrorPath("payment_not_verified"), baseUrl)
      );
    }

    // MONEY-1126: `getSubscriptionAccess` now serves a cached entitlement for
    // up to 60s. The buyer is redirected to the success page on the very next
    // line, so without an explicit drop they could pay and then be shown the
    // upgrade prompt for a minute on every gated page. Fired for BOTH outcomes:
    // "already_applied" means the WEBHOOK won the claim, so the row is upgraded
    // but this instance's cache still holds the pre-upgrade value — that is
    // exactly the case that needs clearing.
    //
    // Best-effort: a cache failure must never turn a completed payment into a
    // `callback_failed` redirect, so it is caught here rather than by the outer
    // handler. Worst case the entitlement self-heals within the 60s TTL.
    await clearSubscriptionCache(currentPayment.userId).catch((cacheError) => {
      logger.warn(
        { error: cacheError, paymentId, userId: currentPayment.userId },
        "Payment callback: subscription cache clear failed (entitlement will self-heal on TTL)"
      );
    });

    // "granted" and "already_applied" both land on the success page.
    return NextResponse.redirect(new URL(SUBSCRIPTION_SUCCESS_PATH, baseUrl));
  } catch (error) {
    logger.error({ error, paymentId }, "Payment callback error");
    return NextResponse.redirect(
      new URL(buildPricingErrorPath("callback_failed"), baseUrl)
    );
  }
}
