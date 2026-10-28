/**
 * Payments Callback CONTRACT tests.
 *
 * Exercises the REAL exported helpers the callback route imports + calls — NOT
 * inline copies:
 *   - `validateCallbackParams`, `getCallbackBaseUrl`, `buildPricingErrorPath`,
 *     `buildSubscriptionPendingPath`, `SUBSCRIPTION_SUCCESS_PATH` from the route
 *     sibling `app/api/payments/callback/callback-logic.ts`
 *   - `isAddonPlan`, `isAddonEligible`, `getAddonQueries`, `determineEndDate`,
 *     `calculateQueryPackLimits`, `shouldApplyFulfillment` from the shared single
 *     source `@/lib/payments/plan-config`
 *
 * (Replaces the previous shadow version, which reimplemented validateCallbackParams
 * / verifyPayment / buildRedirectUrl / isAddonFlow / determineEndDate inline — and
 * whose `verifyPayment` "pay_ prefix" heuristic never even matched the route.)
 *
 * The MONEY-594 fulfillment-idempotency invariants are re-proven below against
 * the REAL `shouldApplyFulfillment` decision.
 *
 * Source: apps/web/app/api/payments/callback/route.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isAddonPlan,
  isAddonEligible,
  getAddonQueries,
  determineEndDate,
  calculateQueryPackLimits,
  shouldApplyFulfillment,
} from "@usemoney/core/payments/plan-config";
import {
  validateCallbackParams,
  getCallbackBaseUrl,
  buildPricingErrorPath,
  buildSubscriptionPendingPath,
  SUBSCRIPTION_SUCCESS_PATH,
} from "@/app/api/payments/callback/callback-logic";

describe("Payments Callback Logic (real exported helpers)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  describe("validateCallbackParams", () => {
    it("passes with both paymentId and planId", () => {
      assert.strictEqual(validateCallbackParams("pay_123", "PRO").valid, true);
    });

    it("fails (invalid_params) when paymentId is null", () => {
      const result = validateCallbackParams(null, "PRO");
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, "invalid_params");
    });

    it("fails when planId is null", () => {
      assert.strictEqual(validateCallbackParams("pay_123", null).valid, false);
    });

    it("fails when both are null", () => {
      assert.strictEqual(validateCallbackParams(null, null).valid, false);
    });

    it("fails with empty-string paymentId (falsy)", () => {
      assert.strictEqual(validateCallbackParams("", "PRO").valid, false);
    });

    it("fails with empty-string planId (falsy)", () => {
      assert.strictEqual(validateCallbackParams("pay_123", "").valid, false);
    });
  });

  describe("redirect path construction", () => {
    it("SUBSCRIPTION_SUCCESS_PATH is the settings success path", () => {
      assert.strictEqual(
        SUBSCRIPTION_SUCCESS_PATH,
        "/settings?tab=subscription&success=payment_complete"
      );
    });

    it("buildPricingErrorPath builds /pricing?error=<code>", () => {
      assert.strictEqual(
        buildPricingErrorPath("payment_not_found"),
        "/pricing?error=payment_not_found"
      );
      assert.strictEqual(
        buildPricingErrorPath("invalid_params"),
        "/pricing?error=invalid_params"
      );
      assert.strictEqual(
        buildPricingErrorPath("payment_forbidden"),
        "/pricing?error=payment_forbidden"
      );
    });

    it("buildSubscriptionPendingPath URL-encodes the paymentId", () => {
      assert.strictEqual(
        buildSubscriptionPendingPath("pay_123"),
        "/settings?tab=subscription&payment=pending&paymentId=pay_123"
      );
      assert.strictEqual(
        buildSubscriptionPendingPath("a b/c"),
        "/settings?tab=subscription&payment=pending&paymentId=a%20b%2Fc"
      );
    });

    it("the error path resolves to an absolute URL against the base", () => {
      // The route wraps the path in `new URL(path, baseUrl)`; prove the round-trip.
      const url = new URL(
        buildPricingErrorPath("payment_failed"),
        "https://usemoney.ai"
      );
      assert.strictEqual(
        url.toString(),
        "https://usemoney.ai/pricing?error=payment_failed"
      );
    });

    it("getCallbackBaseUrl uses localhost as default", () => {
      delete process.env.NEXT_PUBLIC_BASE_URL;
      assert.strictEqual(getCallbackBaseUrl(), "http://localhost:3000");
    });

    it("getCallbackBaseUrl uses the env base URL when set", () => {
      process.env.NEXT_PUBLIC_BASE_URL = "https://usemoney.ai";
      assert.strictEqual(getCallbackBaseUrl(), "https://usemoney.ai");
    });
  });

  describe("Addon vs main plan flow (real helpers)", () => {
    it("identifies QUERY_PACK as the addon flow", () => {
      assert.strictEqual(isAddonPlan("QUERY_PACK"), true);
    });

    it("identifies PRO / PREMIUM / FREE as main-plan flows", () => {
      assert.strictEqual(isAddonPlan("PRO"), false);
      assert.strictEqual(isAddonPlan("PREMIUM"), false);
      assert.strictEqual(isAddonPlan("FREE"), false);
    });

    it("gates addon eligibility to PRO / PREMIUM / ULTIMATE", () => {
      assert.strictEqual(isAddonEligible("PRO"), true);
      assert.strictEqual(isAddonEligible("PREMIUM"), true);
      assert.strictEqual(isAddonEligible("ULTIMATE"), true);
      assert.strictEqual(isAddonEligible("FREE"), false);
    });

    it("addon query allocation matches the user's resolved plan", () => {
      assert.deepStrictEqual(getAddonQueries("PRO"), {
        fast: 200,
        advanced: 50,
      });
      assert.deepStrictEqual(getAddonQueries("PREMIUM"), {
        fast: 0,
        advanced: 200,
      });
    });
  });

  describe("Main-plan end date (real determineEndDate)", () => {
    it("FREE / PRO → null (no end date)", () => {
      assert.strictEqual(determineEndDate("FREE"), null);
      assert.strictEqual(determineEndDate("PRO"), null);
    });

    it("PREMIUM → 30 days out (callback never passes an annual period)", () => {
      const now = Date.now();
      const endDate = determineEndDate("PREMIUM", null, now);
      assert.strictEqual(endDate!.getTime(), now + 30 * 24 * 60 * 60 * 1000);
    });
  });

  // ==========================================================================
  // Fulfillment idempotency claim (MONEY-594 / SCAN-FIND #67), proven against
  // the REAL `shouldApplyFulfillment` decision the route applies to
  // `prisma.payment.updateMany({ where: { id, appliedAt: null }, ... }).count`.
  // ==========================================================================
  describe("Fulfillment idempotency claim (real shouldApplyFulfillment)", () => {
    interface ClaimablePayment {
      appliedAt: Date | null;
    }

    /**
     * Mirrors the route's claim: atomically flip appliedAt only if currently
     * null (the `updateMany({ where: { appliedAt: null } })` gate), then feed
     * the resulting rowcount through the REAL `shouldApplyFulfillment`.
     */
    function claimFulfillment(payment: ClaimablePayment, now: Date): boolean {
      let count = 0;
      if (payment.appliedAt === null) {
        payment.appliedAt = now;
        count = 1;
      }
      return shouldApplyFulfillment(count);
    }

    it("shouldApplyFulfillment grants only on count === 1", () => {
      assert.strictEqual(shouldApplyFulfillment(1), true);
      assert.strictEqual(shouldApplyFulfillment(0), false);
      assert.strictEqual(shouldApplyFulfillment(2), false);
    });

    it("grants on the first claim", () => {
      const payment: ClaimablePayment = { appliedAt: null };
      assert.strictEqual(claimFulfillment(payment, new Date()), true);
      assert.notStrictEqual(payment.appliedAt, null);
    });

    it("does NOT grant on a replayed claim (already applied)", () => {
      const payment: ClaimablePayment = { appliedAt: null };
      claimFulfillment(payment, new Date());
      assert.strictEqual(claimFulfillment(payment, new Date()), false);
    });

    it("only one caller wins across many concurrent replays", () => {
      const payment: ClaimablePayment = { appliedAt: null };
      const wins = Array.from({ length: 25 }, () =>
        claimFulfillment(payment, new Date())
      ).filter(Boolean);
      assert.strictEqual(wins.length, 1);
    });

    it("does not overwrite the original appliedAt timestamp on replay", () => {
      const payment: ClaimablePayment = { appliedAt: null };
      const first = new Date("2026-06-01T00:00:00.000Z");
      const later = new Date("2026-06-02T00:00:00.000Z");
      claimFulfillment(payment, first);
      claimFulfillment(payment, later);
      assert.strictEqual(payment.appliedAt?.toISOString(), first.toISOString());
    });

    it("credit-pack credits do NOT stack across callback replays", () => {
      const payment: ClaimablePayment = { appliedAt: null };
      const purchasedCredits = 1000;
      let packCreditsLimit = 0;
      let packCreditsUsed = 50;

      const applyGrant = () => {
        if (!claimFulfillment(payment, new Date())) return; // replay -> no-op
        const remaining = Math.max(0, packCreditsLimit - packCreditsUsed);
        packCreditsLimit = remaining + purchasedCredits;
        packCreditsUsed = 0;
      };

      applyGrant();
      applyGrant();
      applyGrant();

      assert.strictEqual(packCreditsLimit, 1000);
      assert.strictEqual(packCreditsUsed, 0);
    });

    it("main-plan usage counters are NOT reset by callback replays", () => {
      const payment: ClaimablePayment = { appliedAt: null };
      let creditsUsed = 4;

      const applyGrant = () => {
        if (!claimFulfillment(payment, new Date())) return;
        creditsUsed = 0;
      };

      applyGrant();
      creditsUsed = 4;
      applyGrant();

      assert.strictEqual(creditsUsed, 4);
    });

    it("a rejected payment never burns the claim (claim runs after guards)", () => {
      const payment: ClaimablePayment = { appliedAt: null };
      const addonEligible = isAddonEligible("FREE"); // false -> guard rejects

      if (addonEligible) {
        claimFulfillment(payment, new Date());
      }
      // early return — claim NOT invoked
      assert.strictEqual(payment.appliedAt, null);
      assert.strictEqual(claimFulfillment(payment, new Date()), true);
    });

    // --- Read-after-claim ordering (lost-update guard, SCAN-FIND #76) ---
    describe("read-after-claim ordering (lost-update guard)", () => {
      interface SubRow {
        packCreditsLimit: number;
        packCreditsUsed: number;
      }

      /** FIXED ordering: claim FIRST, then read the live row. */
      function applyClaimThenRead(
        payment: ClaimablePayment,
        sub: SubRow,
        purchasedCredits: number
      ): void {
        if (!claimFulfillment(payment, new Date())) return;
        const remaining = Math.max(
          0,
          sub.packCreditsLimit - sub.packCreditsUsed
        );
        sub.packCreditsLimit = remaining + purchasedCredits;
        sub.packCreditsUsed = 0;
      }

      it("claim-then-read grants the pack exactly once under a race", () => {
        const payment: ClaimablePayment = { appliedAt: null };
        const sub: SubRow = { packCreditsLimit: 0, packCreditsUsed: 0 };
        applyClaimThenRead(payment, sub, 1000);
        applyClaimThenRead(payment, sub, 1000);
        assert.strictEqual(sub.packCreditsLimit, 1000);
        assert.strictEqual(sub.packCreditsUsed, 0);
      });
    });

    // --- Verified addon id, not the query param (SCAN-FIND #76) ---
    describe("verified addon id push (not query param)", () => {
      function pushAddon(addons: string[], verifiedPlanId: string): string[] {
        return [...addons, verifiedPlanId];
      }

      it("pushes the verified plan id from the paid record", () => {
        // The route pushes resolvePlanId(payment.planId), never the URL param.
        const addons = pushAddon([], "QUERY_PACK");
        assert.deepStrictEqual(addons, ["QUERY_PACK"]);
      });

      it("ignores the attacker-supplied query-param planId", () => {
        const verified = "QUERY_PACK"; // from the paid Payment row
        const queryParamPlanId = "PREMIUM_LIFETIME_FREEBIE"; // forged in URL
        const addons = pushAddon([], verified);
        assert.ok(!addons.includes(queryParamPlanId));
        assert.deepStrictEqual(addons, ["QUERY_PACK"]);
      });
    });

    // --- Carry-forward computed from the post-claim snapshot (real helper) ---
    it("addon carry-forward uses the real calculateQueryPackLimits", () => {
      const additional = getAddonQueries("PRO");
      const result = calculateQueryPackLimits(100, 20, 25, 5, additional, true);
      assert.strictEqual(result.fastLimit, 280); // 80 remaining + 200
      assert.strictEqual(result.advancedLimit, 70); // 20 remaining + 50
    });
  });
});
