/**
 * Payment-provisioning PURE-SEAM contract tests — MONEY-1062 (W1-B).
 *
 * `packages/services` runs its test suite as ESM (`"type": "module"`), where the
 * `require.cache` prisma-injection pattern is unavailable. So the pure, Prisma-
 * free seams are asserted HERE, and the prisma-touching grant behaviour (claim-
 * once, grant-shape parity, lifecycle, callback outcomes, the dispatcher) is
 * contract-tested from the CJS side in
 * apps/web/__tests__/api/payment-provisioning-service.test.ts — the same
 * split the repo already uses for other `@usemoney/services` prisma code
 * (subscription-billing-anchor-heal.test.ts).
 *
 * Source: packages/services/src/payment-provisioning-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapWebhookEvent,
  sanitizePaymentError,
  extractDodoSubscriptionId,
  coerceFiniteAmount,
} from "../src/payment-provisioning-logic";

describe("mapWebhookEvent — envelope→action dispatch table", () => {
  it("maps every currently-handled event to its action (incl. legacy alias)", () => {
    assert.equal(mapWebhookEvent("payment.succeeded"), "payment_completed");
    // legacy alias must resolve to the SAME action (replay safety)
    assert.equal(mapWebhookEvent("payment.completed"), "payment_completed");
    assert.equal(mapWebhookEvent("payment.failed"), "payment_failed");
    assert.equal(
      mapWebhookEvent("subscription.cancelled"),
      "subscription_cancelled",
    );
    assert.equal(
      mapWebhookEvent("subscription.renewed"),
      "subscription_renewed",
    );
    assert.equal(
      mapWebhookEvent("subscription.active"),
      "subscription_activated",
    );
    // both dunning events share the past-due action
    assert.equal(
      mapWebhookEvent("subscription.on_hold"),
      "subscription_past_due",
    );
    assert.equal(
      mapWebhookEvent("subscription.failed"),
      "subscription_past_due",
    );
    assert.equal(
      mapWebhookEvent("subscription.expired"),
      "subscription_expired",
    );
    assert.equal(mapWebhookEvent("refund.succeeded"), "refund_succeeded");
  });

  it("unknown / empty / undefined / wrong-case → unhandled", () => {
    for (const e of [
      "payment.refunded",
      "invoice.paid",
      "customer.created",
      "PAYMENT.SUCCEEDED",
      "Payment.Succeeded",
      "",
      undefined,
    ]) {
      assert.equal(mapWebhookEvent(e), "unhandled");
    }
  });
});

describe("sanitizePaymentError (moved from dodo-webhook-logic)", () => {
  const GENERIC =
    "Your payment could not be processed. Please try again or use a different payment method.";
  it("maps keywords with precedence and falls back to generic", () => {
    assert.ok(sanitizePaymentError("INSUFFICIENT funds").includes("declined"));
    assert.ok(sanitizePaymentError("card declined").includes("declined"));
    assert.ok(sanitizePaymentError("card expired").includes("expired"));
    assert.ok(sanitizePaymentError("user cancelled").includes("cancelled"));
    assert.ok(sanitizePaymentError("payment canceled").includes("cancelled"));
    assert.ok(sanitizePaymentError("timed out").includes("timed out"));
    // precedence: insufficient before expired
    assert.ok(
      sanitizePaymentError("insufficient funds, card expired").includes(
        "declined",
      ),
    );
    assert.equal(sanitizePaymentError(null), GENERIC);
    assert.equal(sanitizePaymentError(undefined), GENERIC);
    assert.equal(sanitizePaymentError(42 as unknown as string), GENERIC);
    assert.equal(sanitizePaymentError(""), GENERIC);
    assert.equal(sanitizePaymentError("   "), GENERIC);
    // never leak internal detail on an unrecognised error
    assert.equal(
      sanitizePaymentError("Error at /api/charge, stack: ..."),
      GENERIC,
    );
  });
});

describe("extractDodoSubscriptionId (moved from dodo-webhook-logic)", () => {
  it("prefers metadata, falls back to webhook body, else null", () => {
    assert.equal(
      extractDodoSubscriptionId(
        { dodoSubscriptionId: "sub_meta" },
        { subscription_id: "sub_body" },
      ),
      "sub_meta",
    );
    assert.equal(
      extractDodoSubscriptionId({}, { subscription_id: "sub_body" }),
      "sub_body",
    );
    assert.equal(extractDodoSubscriptionId({}, {}), null);
    assert.equal(
      extractDodoSubscriptionId(null, { subscription_id: "s" }),
      "s",
    );
    assert.equal(extractDodoSubscriptionId(null, undefined), null);
  });

  it("recovers subscription_id from merged metadata (callback path, both args)", () => {
    // The callback route has no webhook body; it passes the Payment metadata as
    // BOTH args. When the webhook / Dodo poll already merged its `subscription_id`
    // into that metadata (but no explicit `dodoSubscriptionId` key was stashed at
    // checkout), the fallback must still recover it — else the new subscription
    // row is written with a NULL linkage and renewal/cancel webhooks can't find it.
    const merged = { subscription_id: "sub_merged", foo: "bar" };
    assert.equal(extractDodoSubscriptionId(merged, merged), "sub_merged");
  });
});

describe("coerceFiniteAmount — Dodo money coercion (NaN guard)", () => {
  it("passes finite numbers and numeric strings through", () => {
    assert.equal(coerceFiniteAmount(1234), 1234);
    assert.equal(coerceFiniteAmount(0), 0);
    assert.equal(coerceFiniteAmount(-50), -50);
    assert.equal(coerceFiniteAmount("199.5"), 199.5);
    assert.equal(coerceFiniteAmount("0"), 0);
  });

  it("[J-F3] trimmed-empty strings coerce to null, NOT 0 (replay-preservation holds)", () => {
    // Number("") and Number("   ") are BOTH 0. Returning 0 would defeat the
    // caller's `?? payment.X` fallback — a redelivered event with an empty amount
    // would clobber a stored amount with 0, and receipts would render 0.
    assert.equal(coerceFiniteAmount(""), null);
    assert.equal(coerceFiniteAmount("   "), null);
    assert.equal(coerceFiniteAmount("\t\n "), null);
    // A real "0"/0 is still a valid zero amount and must NOT become null.
    assert.equal(coerceFiniteAmount("0"), 0);
    assert.equal(coerceFiniteAmount(0), 0);
  });

  it("maps null / undefined / non-finite input to null (never NaN)", () => {
    // A malformed Dodo amount must NOT persist NaN into a money column or render
    // "₹NaN" in the receipt email — it collapses to null so the caller falls back.
    assert.equal(coerceFiniteAmount(null), null);
    assert.equal(coerceFiniteAmount(undefined), null);
    assert.equal(coerceFiniteAmount("abc"), null);
    assert.equal(coerceFiniteAmount("12.3.4"), null);
    assert.equal(coerceFiniteAmount(Infinity), null);
    assert.equal(coerceFiniteAmount(-Infinity), null);
    assert.equal(coerceFiniteAmount(NaN), null);
  });
});
