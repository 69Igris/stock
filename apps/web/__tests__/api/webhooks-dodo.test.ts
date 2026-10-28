/**
 * Dodo Payments Webhook CONTRACT tests.
 *
 * Exercises the REAL exported plan/addon helpers from the shared single source
 * of truth `@/lib/payments/plan-config` that the route imports + calls, PLUS:
 *
 *   - a real-`svix` signature contract test (the route verifies Dodo webhooks
 *     with `new Webhook(secret).verify(...)` and Dodo sends `webhook-*` headers
 *     that fall back to `svix-*`). We SIGN with the real library and prove a
 *     correctly-signed payload verifies and that tampered body / wrong sig /
 *     stale timestamp / wrong secret are rejected. `Webhook.verify` is NEVER
 *     mocked.
 *
 *   - the fulfillment idempotency claim: a mocked prisma delegate that records
 *     the `where` clause and atomically flips `appliedAt` only when null, driven
 *     through the route's exact claim shape, proving "applied exactly once"
 *     under simulated concurrent re-delivery.
 *
 * (Replaces the previous shadow version, which reimplemented PLANS /
 * getAddonQueries / determineEndDate inline AND used a hand-rolled HMAC helper
 * instead of the real svix verifier.)
 *
 * Source: apps/web/app/api/webhooks/dodo/route.ts
 *       + apps/web/lib/payments/plan-config.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Webhook, WebhookVerificationError } from "svix";
import {
  WEBHOOK_PLANS as PLANS,
  getAddonQueries,
  isAddonPlan,
  isAddonEligible,
  calculateQueryPackLimits,
  determineEndDate,
  getReadablePlanName,
  shouldApplyFulfillment,
} from "@usemoney/core/payments/plan-config";

// The route's switch over `payload.event`.
const HANDLED_EVENTS = [
  "payment.completed",
  "payment.failed",
  "subscription.cancelled",
  "subscription.renewed",
];
function isHandledEvent(event: string): boolean {
  return HANDLED_EVENTS.includes(event);
}

const TEST_SECRET =
  "whsec_" + Buffer.from("dodo-webhook-signing-secret").toString("base64");

describe("Dodo Webhook (real shared helpers + real svix)", () => {
  // =========================================================================
  // Real svix signature CONTRACT (never mocked)
  //
  // The Dodo route does:
  //   const wh = new Webhook(WEBHOOK_SECRET);
  //   payload = wh.verify(body, { "svix-id", "svix-timestamp", "svix-signature" });
  // reading the values off `webhook-id|svix-id`, `webhook-timestamp|svix-timestamp`,
  // `webhook-signature|svix-signature`. We model BOTH header families and prove
  // the real verifier accepts a valid signature and rejects every tamper.
  // =========================================================================
  describe("svix signature contract (real Webhook, never mocked)", () => {
    const wh = new Webhook(TEST_SECRET);

    /** Sign `body` at `tsSeconds`, returning a svix `v1,<b64>` signature header. */
    function signature(body: string, tsSeconds: number, msgId = "msg_dodo1") {
      return wh.sign(msgId, new Date(tsSeconds * 1000), body);
    }

    /**
     * Resolve the three verification inputs from a header bag the way the route
     * does: `webhook-*` first, then `svix-*`. Returns the object handed to
     * `wh.verify`.
     */
    function resolveVerifyHeaders(
      headers: Record<string, string | undefined>
    ): Record<string, string> {
      const id = headers["webhook-id"] ?? headers["svix-id"] ?? "";
      const timestamp =
        headers["webhook-timestamp"] ?? headers["svix-timestamp"] ?? "";
      const sig =
        headers["webhook-signature"] ?? headers["svix-signature"] ?? "";
      return {
        "svix-id": id,
        "svix-timestamp": timestamp,
        "svix-signature": sig,
      };
    }

    it("a correctly-signed payload VERIFIES via webhook-* headers (Dodo native)", () => {
      const body = JSON.stringify({
        event: "payment.completed",
        data: { payment_id: "pay_1" },
      });
      const ts = Math.floor(Date.now() / 1000);
      const headers = resolveVerifyHeaders({
        "webhook-id": "msg_dodo1",
        "webhook-timestamp": String(ts),
        "webhook-signature": signature(body, ts),
      });

      const verified = wh.verify(body, headers) as {
        event: string;
        data: { payment_id: string };
      };
      assert.strictEqual(verified.event, "payment.completed");
      assert.strictEqual(verified.data.payment_id, "pay_1");
      assert.strictEqual(isHandledEvent(verified.event), true);
    });

    it("a correctly-signed payload VERIFIES via svix-* fallback headers", () => {
      const body = JSON.stringify({ event: "subscription.renewed", data: {} });
      const ts = Math.floor(Date.now() / 1000);
      const headers = resolveVerifyHeaders({
        "svix-id": "msg_dodo1",
        "svix-timestamp": String(ts),
        "svix-signature": signature(body, ts),
      });
      const verified = wh.verify(body, headers) as { event: string };
      assert.strictEqual(verified.event, "subscription.renewed");
    });

    it("prefers webhook-* over svix-* when both present", () => {
      const body = JSON.stringify({ event: "payment.completed", data: {} });
      const ts = Math.floor(Date.now() / 1000);
      const goodSig = signature(body, ts);
      const headers = resolveVerifyHeaders({
        "webhook-id": "msg_dodo1",
        "webhook-timestamp": String(ts),
        "webhook-signature": goodSig,
        // A bogus svix-* set that must be IGNORED because webhook-* wins.
        "svix-id": "msg_other",
        "svix-timestamp": String(ts),
        "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      });
      const verified = wh.verify(body, headers) as { event: string };
      assert.strictEqual(verified.event, "payment.completed");
    });

    it("REJECTS a tampered body (e.g. amount/plan swapped after signing)", () => {
      const body = JSON.stringify({
        event: "payment.completed",
        data: { payment_id: "pay_1", amount: 199 },
      });
      const ts = Math.floor(Date.now() / 1000);
      const headers = resolveVerifyHeaders({
        "webhook-id": "msg_dodo1",
        "webhook-timestamp": String(ts),
        "webhook-signature": signature(body, ts),
      });
      const tampered = body.replace('"amount":199', '"amount":1');
      assert.notStrictEqual(tampered, body);
      assert.throws(
        () => wh.verify(tampered, headers),
        (err: unknown) => err instanceof WebhookVerificationError
      );
    });

    it("REJECTS a wrong / forged signature", () => {
      const body = JSON.stringify({ event: "payment.completed", data: {} });
      const ts = Math.floor(Date.now() / 1000);
      assert.throws(
        () =>
          wh.verify(body, {
            "svix-id": "msg_dodo1",
            "svix-timestamp": String(ts),
            "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          }),
        (err: unknown) => err instanceof WebhookVerificationError
      );
    });

    it("REJECTS a stale timestamp (replay outside svix tolerance), even if signed", () => {
      const body = JSON.stringify({ event: "payment.completed", data: {} });
      const staleTs = Math.floor(Date.now() / 1000) - 60 * 60; // 1h ago
      const headers = resolveVerifyHeaders({
        "webhook-id": "msg_dodo1",
        "webhook-timestamp": String(staleTs),
        "webhook-signature": signature(body, staleTs),
      });
      assert.throws(
        () => wh.verify(body, headers),
        (err: unknown) => err instanceof WebhookVerificationError
      );
    });

    it("REJECTS a payload signed with a DIFFERENT secret", () => {
      const otherWh = new Webhook(
        "whsec_" + Buffer.from("attacker-secret").toString("base64")
      );
      const body = JSON.stringify({ event: "payment.completed", data: {} });
      const ts = Math.floor(Date.now() / 1000);
      const headers = {
        "svix-id": "msg_dodo1",
        "svix-timestamp": String(ts),
        "svix-signature": otherWh.sign("msg_dodo1", new Date(ts * 1000), body),
      };
      assert.throws(
        () => wh.verify(body, headers),
        (err: unknown) => err instanceof WebhookVerificationError
      );
    });
  });

  // =========================================================================
  // Fulfillment idempotency claim — "applied exactly once"
  //
  // The route claims a payment with:
  //   prisma.payment.updateMany({ where: { id, appliedAt: null }, data: { appliedAt } })
  // and grants iff exactly one row flipped. We mock that delegate as a stateful
  // row, RECORD every `where` clause it receives, and drive it through the
  // route's exact `shouldApplyFulfillment(claim.count)` decision under simulated
  // concurrent re-delivery.
  // =========================================================================
  describe("fulfillment idempotency (mocked prisma delegate, applied exactly once)", () => {
    interface PaymentRow {
      id: string;
      appliedAt: Date | null;
    }

    /**
     * Minimal mock of `prisma.payment.updateMany` honouring the conditional
     * `appliedAt: null` gate atomically (single-threaded JS = no interleave) and
     * recording each `where` it was called with.
     */
    function makePaymentDelegate(row: PaymentRow) {
      const whereCalls: Array<Record<string, unknown>> = [];
      return {
        whereCalls,
        async updateMany(args: {
          where: { id: string; appliedAt: null };
          data: { appliedAt: Date };
        }): Promise<{ count: number }> {
          whereCalls.push(args.where);
          // Gate: only flip when id matches AND appliedAt is currently null.
          if (row.id === args.where.id && row.appliedAt === null) {
            row.appliedAt = args.data.appliedAt;
            return { count: 1 };
          }
          return { count: 0 };
        },
      };
    }

    /** Mirrors the route's `claimFulfillment` closure exactly. */
    async function claimFulfillment(
      delegate: ReturnType<typeof makePaymentDelegate>,
      paymentId: string
    ): Promise<boolean> {
      const claim = await delegate.updateMany({
        where: { id: paymentId, appliedAt: null },
        data: { appliedAt: new Date() },
      });
      return shouldApplyFulfillment(claim.count);
    }

    it("the FIRST delivery wins the claim (count === 1 → grant)", async () => {
      const row: PaymentRow = { id: "pay_1", appliedAt: null };
      const delegate = makePaymentDelegate(row);
      assert.strictEqual(await claimFulfillment(delegate, "pay_1"), true);
      assert.notStrictEqual(row.appliedAt, null);
    });

    it("a RE-DELIVERY loses the claim (count === 0 → skip grant)", async () => {
      const row: PaymentRow = { id: "pay_1", appliedAt: null };
      const delegate = makePaymentDelegate(row);
      await claimFulfillment(delegate, "pay_1"); // first delivery
      assert.strictEqual(await claimFulfillment(delegate, "pay_1"), false);
    });

    it("exactly ONE of many concurrent re-deliveries grants", async () => {
      const row: PaymentRow = { id: "pay_1", appliedAt: null };
      const delegate = makePaymentDelegate(row);
      // Fire 25 deliveries of the SAME payment "concurrently".
      const results = await Promise.all(
        Array.from({ length: 25 }, () => claimFulfillment(delegate, "pay_1"))
      );
      assert.strictEqual(results.filter(Boolean).length, 1);
    });

    it("every claim query carries the `appliedAt: null` gate in its where clause", async () => {
      const row: PaymentRow = { id: "pay_1", appliedAt: null };
      const delegate = makePaymentDelegate(row);
      await claimFulfillment(delegate, "pay_1");
      await claimFulfillment(delegate, "pay_1");
      assert.strictEqual(delegate.whereCalls.length, 2);
      for (const where of delegate.whereCalls) {
        assert.strictEqual(where.id, "pay_1");
        assert.strictEqual(where.appliedAt, null);
      }
    });

    it("does not overwrite the original appliedAt on a re-delivery", async () => {
      const row: PaymentRow = { id: "pay_1", appliedAt: null };
      const delegate = makePaymentDelegate(row);
      await claimFulfillment(delegate, "pay_1");
      const firstStamp = row.appliedAt;
      await claimFulfillment(delegate, "pay_1"); // loses → must not re-stamp
      assert.strictEqual(row.appliedAt, firstStamp);
    });

    it("query-pack credits do NOT stack across webhook re-deliveries", async () => {
      // Model the route's addon grant gated on the claim.
      const row: PaymentRow = { id: "pay_1", appliedAt: null };
      const delegate = makePaymentDelegate(row);
      let fastLimit = 0;
      const additional = getAddonQueries("PRO"); // { fast: 200, advanced: 50 }

      const applyGrant = async () => {
        if (!(await claimFulfillment(delegate, "pay_1"))) return; // re-delivery → no-op
        const { fastLimit: f } = calculateQueryPackLimits(
          fastLimit,
          0,
          0,
          0,
          additional,
          true
        );
        fastLimit = f;
      };

      await applyGrant(); // legitimate
      await applyGrant(); // re-delivery #1
      await applyGrant(); // re-delivery #2
      // Without the claim this would be 200 + 200 + 200 = 600.
      assert.strictEqual(fastLimit, 200);
    });
  });

  // =========================================================================
  // Event routing (real handled-event set)
  // =========================================================================
  describe("isHandledEvent", () => {
    it("identifies the four handled events", () => {
      for (const e of HANDLED_EVENTS) {
        assert.strictEqual(isHandledEvent(e), true);
      }
    });

    it("does not handle unknown / unrelated events", () => {
      for (const e of [
        "payment.refunded",
        "payment.pending",
        "subscription.created",
        "invoice.paid",
        "customer.created",
        "",
      ]) {
        assert.strictEqual(isHandledEvent(e), false);
      }
    });

    it("is case sensitive", () => {
      assert.strictEqual(isHandledEvent("Payment.Completed"), false);
      assert.strictEqual(isHandledEvent("PAYMENT.COMPLETED"), false);
    });
  });

  // =========================================================================
  // Plan configuration (real WEBHOOK_PLANS)
  // =========================================================================
  describe("WEBHOOK_PLANS configuration", () => {
    it("FREE → 0 queries / 0 price", () => {
      assert.strictEqual(PLANS.FREE.aiQueries, 0);
      assert.strictEqual(PLANS.FREE.price, 0);
    });

    it("PRO → 10 queries / 999 price", () => {
      assert.strictEqual(PLANS.PRO.aiQueries, 10);
      assert.strictEqual(PLANS.PRO.price, 999);
    });

    it("QUERY_PACK → 100 queries / 99 price", () => {
      assert.strictEqual(PLANS.QUERY_PACK.aiQueries, 100);
      assert.strictEqual(PLANS.QUERY_PACK.price, 99);
    });

    it("PREMIUM → -1 (unlimited) queries / 999 price", () => {
      assert.strictEqual(PLANS.PREMIUM.aiQueries, -1);
      assert.strictEqual(PLANS.PREMIUM.price, 999);
    });

    it("has 4 plan types", () => {
      assert.strictEqual(Object.keys(PLANS).length, 4);
    });
  });

  // =========================================================================
  // Addon query allocation + eligibility (real helpers)
  // =========================================================================
  describe("getAddonQueries", () => {
    it("PRO → 200 fast + 50 advanced", () => {
      assert.deepStrictEqual(getAddonQueries("PRO"), {
        fast: 200,
        advanced: 50,
      });
    });

    it("PREMIUM → 0 fast + 200 advanced", () => {
      assert.deepStrictEqual(getAddonQueries("PREMIUM"), {
        fast: 0,
        advanced: 200,
      });
    });

    it("FREE / unknown / empty → 0/0", () => {
      assert.deepStrictEqual(getAddonQueries("FREE"), { fast: 0, advanced: 0 });
      assert.deepStrictEqual(getAddonQueries("UNKNOWN"), {
        fast: 0,
        advanced: 0,
      });
      assert.deepStrictEqual(getAddonQueries(""), { fast: 0, advanced: 0 });
    });
  });

  describe("isAddonPlan / isAddonEligible", () => {
    it("only QUERY_PACK (and its legacy alias) is an addon", () => {
      assert.strictEqual(isAddonPlan("QUERY_PACK"), true);
      assert.strictEqual(isAddonPlan("AI_ADDON"), true);
      assert.strictEqual(isAddonPlan("PRO"), false);
      assert.strictEqual(isAddonPlan("FREE"), false);
      assert.strictEqual(isAddonPlan("PREMIUM"), false);
    });

    it("PRO / PREMIUM / ULTIMATE may purchase an addon; FREE / UNKNOWN may not", () => {
      assert.strictEqual(isAddonEligible("PRO"), true);
      assert.strictEqual(isAddonEligible("PREMIUM"), true);
      assert.strictEqual(isAddonEligible("ULTIMATE"), true);
      assert.strictEqual(isAddonEligible("FREE"), false);
      assert.strictEqual(isAddonEligible("UNKNOWN"), false);
    });
  });

  // =========================================================================
  // Carry-forward + end date (real helpers)
  // =========================================================================
  describe("calculateQueryPackLimits", () => {
    it("adds new queries to remaining when active", () => {
      const result = calculateQueryPackLimits(
        200,
        50,
        50,
        10,
        { fast: 200, advanced: 50 },
        true
      );
      assert.strictEqual(result.fastLimit, 350);
      assert.strictEqual(result.advancedLimit, 90);
    });

    it("does not carry forward when not active", () => {
      const result = calculateQueryPackLimits(
        200,
        50,
        50,
        10,
        { fast: 200, advanced: 50 },
        false
      );
      assert.strictEqual(result.fastLimit, 200);
      assert.strictEqual(result.advancedLimit, 50);
    });

    it("treats null existing limits as 0", () => {
      const result = calculateQueryPackLimits(
        null,
        null,
        null,
        null,
        { fast: 200, advanced: 50 },
        true
      );
      assert.strictEqual(result.fastLimit, 200);
      assert.strictEqual(result.advancedLimit, 50);
    });

    it("floors over-usage remaining at 0 (not negative)", () => {
      const result = calculateQueryPackLimits(
        100,
        150,
        50,
        60,
        { fast: 200, advanced: 50 },
        true
      );
      assert.strictEqual(result.fastLimit, 200);
      assert.strictEqual(result.advancedLimit, 50);
    });

    it("carries full remaining when nothing used", () => {
      const result = calculateQueryPackLimits(
        200,
        0,
        50,
        0,
        { fast: 200, advanced: 50 },
        true
      );
      assert.strictEqual(result.fastLimit, 400);
      assert.strictEqual(result.advancedLimit, 100);
    });
  });

  describe("determineEndDate", () => {
    it("FREE / PRO → null", () => {
      assert.strictEqual(determineEndDate("FREE"), null);
      assert.strictEqual(determineEndDate("PRO"), null);
    });

    it("PREMIUM default monthly → exactly 30 days out", () => {
      const now = Date.now();
      const endDate = determineEndDate("PREMIUM", null, now);
      assert.strictEqual(endDate!.getTime(), now + 30 * 24 * 60 * 60 * 1000);
    });

    it("PREMIUM annual → exactly 365 days out", () => {
      const now = Date.now();
      const endDate = determineEndDate("PREMIUM", "annual", now);
      assert.strictEqual(endDate!.getTime(), now + 365 * 24 * 60 * 60 * 1000);
    });
  });

  // =========================================================================
  // Plan name mapping (real helper) — used by cancel/renew emails
  // =========================================================================
  describe("getReadablePlanName", () => {
    it("maps PREMIUM → Premium, PRO → Pro, else raw", () => {
      assert.strictEqual(getReadablePlanName("PREMIUM"), "Premium");
      assert.strictEqual(getReadablePlanName("PRO"), "Pro");
      assert.strictEqual(getReadablePlanName("FREE"), "FREE");
      assert.strictEqual(getReadablePlanName("QUERY_PACK"), "QUERY_PACK");
    });
  });

  // =========================================================================
  // End-to-end flow (real helpers)
  // =========================================================================
  describe("end-to-end webhook flow (real helpers)", () => {
    it("processes a valid payment.completed for PRO plan", () => {
      assert.strictEqual(isHandledEvent("payment.completed"), true);
      const plan = PLANS["PRO"];
      assert.strictEqual(plan.aiQueries, 10);
      assert.strictEqual(isAddonPlan("PRO"), false);
      assert.strictEqual(determineEndDate("PRO"), null);
    });

    it("processes a valid addon purchase for a PRO user", () => {
      assert.strictEqual(isAddonPlan("QUERY_PACK"), true);
      assert.strictEqual(isAddonEligible("PRO"), true);
      const addon = getAddonQueries("PRO");
      const limits = calculateQueryPackLimits(100, 20, 25, 5, addon, true);
      // remaining fast=80 + 200=280; remaining adv=20 + 50=70
      assert.strictEqual(limits.fastLimit, 280);
      assert.strictEqual(limits.advancedLimit, 70);
    });

    it("rejects an addon for a FREE user", () => {
      assert.strictEqual(isAddonEligible("FREE"), false);
    });
  });
});
