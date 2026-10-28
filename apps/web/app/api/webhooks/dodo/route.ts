import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import React from "react";
import {
  provisionDodoWebhookEvent,
  type DodoWebhookEnvelope,
  type PaymentNotifier,
} from "@usemoney/services";
import {
  sendEmail,
  moveContactToSegment,
  getEffectivePreferences,
  shouldSendEmail,
  buildUnsubscribeUrl,
  type Segment,
} from "@usemoney/email";
import {
  PaymentSuccessEmail,
  PaymentFailedEmail,
  SubscriptionRenewedEmail,
  SubscriptionCancelledEmail,
} from "@usemoney/email/templates";
import { dbLogger as logger } from "@usemoney/logger";

const WEBHOOK_SECRET = process.env.DODO_WEBHOOK_SECRET;

/**
 * Secure Dodo Payments webhook — MONEY-1062 (W1-B) thin transport.
 *
 * This route only: resolves the `webhook-*` / `svix-*` headers, verifies the
 * signature with `svix`, parses the envelope, and hands the event to the
 * subscription-provisioning service (`@usemoney/services`). ALL grant logic
 * (claim-once fulfillment, subscription/credit writes, dunning, refunds) lives in
 * the package so it can be contract-tested — see
 * packages/services/src/payment-provisioning.service.ts.
 *
 * The email/segment side effects the webhook fires are injected as a
 * `PaymentNotifier` built here from `@usemoney/email` (the service intentionally
 * does not depend on the email package). The Dodo envelope is
 * `{ business_id, type, timestamp, data }` with `type` the event discriminator;
 * `event` is the legacy alias kept for replay safety.
 *
 * Configure this URL in Dodo Payments Dashboard:
 * https://yourdomain.com/api/webhooks/dodo
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Get webhook headers for verification.
    // Dodo sends "webhook-*" headers; fall back to "svix-*" for backward compat.
    const svixId =
      request.headers.get("webhook-id") || request.headers.get("svix-id");
    const svixTimestamp =
      request.headers.get("webhook-timestamp") ||
      request.headers.get("svix-timestamp");
    const svixSignature =
      request.headers.get("webhook-signature") ||
      request.headers.get("svix-signature");

    if (!svixId || !svixTimestamp || !svixSignature) {
      logger.error("[DODO WEBHOOK] Missing Svix headers");
      return NextResponse.json(
        { error: "Missing webhook headers" },
        { status: 400 }
      );
    }

    if (!WEBHOOK_SECRET) {
      logger.error("[DODO WEBHOOK] DODO_WEBHOOK_SECRET not configured");
      return NextResponse.json(
        { error: "Webhook secret not configured" },
        { status: 500 }
      );
    }

    // 2. Get raw body for signature verification.
    const body = await request.text();

    // 3. Verify signature using Svix.
    const wh = new Webhook(WEBHOOK_SECRET);
    let payload: DodoWebhookEnvelope;
    try {
      payload = wh.verify(body, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      }) as DodoWebhookEnvelope;
    } catch (err) {
      logger.error(
        { error: err },
        "[DODO WEBHOOK] Signature verification failed"
      );
      return NextResponse.json(
        { error: "Invalid webhook signature" },
        { status: 401 }
      );
    }

    // A signed body that parses to a non-object (e.g. a literal `null`) would
    // throw on the destructure below → outer catch 500 → Dodo redelivers forever.
    // Ack it instead (matches the service's own missing-data guard).
    if (!payload || typeof payload !== "object") {
      logger.error(
        "[DODO WEBHOOK] Verified payload is not an object — acking without action"
      );
      return NextResponse.json({ received: true });
    }

    // 4. Dispatch the verified event to the provisioning service. A grant
    // failure after a won claim rethrows → the outer catch returns 500 so Dodo
    // retries with a fresh claim; every other handler swallows its own errors.
    const { data } = payload;
    const event: string | undefined = payload.type ?? payload.event;
    await provisionDodoWebhookEvent(event, data, webhookNotifier);

    return NextResponse.json({ received: true });
  } catch (error) {
    logger.error({ error }, "[DODO WEBHOOK] Processing error");
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}

/**
 * Preference-gated fire-and-forget send: resolve prefs → gate on `template` →
 * build the unsubscribe URL → render + send. `makeReact` receives the URL so the
 * template can embed it. Not awaited — matches the inline webhook's behaviour.
 */
function gatedSend(
  user: { email: string; name: string | null; emailPreferences: unknown },
  template: string,
  subject: string,
  makeReact: (unsubscribeUrl: string) => React.ReactElement
): void {
  const prefs = getEffectivePreferences(user.emailPreferences);
  if (!shouldSendEmail(prefs, template)) return;
  const unsubscribeUrl = buildUnsubscribeUrl(
    user.email,
    "paymentNotifications"
  );
  sendEmail({
    to: user.email,
    subject,
    unsubscribeUrl,
    react: makeReact(unsubscribeUrl),
    template,
  });
}

/**
 * The transactional-notification wiring the provisioning service invokes. Each
 * method preserves the exact preference gate + template + subject the inline
 * webhook used; email sends stay fire-and-forget, and `moveSegment` swallows +
 * logs its own failure (the weekly resend-contact-sync worker reconciles).
 */
const webhookNotifier: PaymentNotifier = {
  paymentSucceeded({ user, planName, amount, currency }) {
    gatedSend(user, "payment-success", `Payment Confirmed - ${planName}`, (u) =>
      React.createElement(PaymentSuccessEmail, {
        name: user.name || "there",
        planName,
        amount,
        currency,
        unsubscribeUrl: u,
      })
    );
  },
  paymentFailed({ user, planName, errorMessage }) {
    gatedSend(user, "payment-failed", "Payment Failed - UseMoney", (u) =>
      React.createElement(PaymentFailedEmail, {
        name: user.name || "there",
        planName,
        errorMessage,
        unsubscribeUrl: u,
      })
    );
  },
  subscriptionCancelled({ user, planName }) {
    gatedSend(
      user,
      "subscription-cancelled",
      "Subscription Cancelled - UseMoney",
      (u) =>
        React.createElement(SubscriptionCancelledEmail, {
          name: user.name || "there",
          planName,
          unsubscribeUrl: u,
        })
    );
  },
  subscriptionRenewed({ user, planName }) {
    gatedSend(
      user,
      "subscription-renewed",
      "Subscription Renewed - UseMoney",
      (u) =>
        React.createElement(SubscriptionRenewedEmail, {
          name: user.name || "there",
          planName,
          unsubscribeUrl: u,
        })
    );
  },
  async moveSegment({ user, from, to }) {
    const [firstName, ...rest] = (user.name || "").split(" ");
    try {
      await moveContactToSegment(user.email, from as Segment, to as Segment, {
        email: user.email,
        firstName: firstName || undefined,
        lastName: rest.join(" ") || undefined,
      });
    } catch (err) {
      logger.error(
        { error: err, email: user.email },
        `[Dodo Webhook] Failed to move user from ${from} to ${to} segment`
      );
      // Weekly resend-contact-sync worker will reconcile on next run
    }
  },
};
