/**
 * Dodo Payments Webhook Edge Case CONTRACT tests.
 *
 * Exercises the REAL exported helpers the route imports + calls — NOT inline
 * copies:
 *   - `sanitizePaymentError`, `extractDodoSubscriptionId` from the route sibling
 *     `app/api/webhooks/dodo/dodo-webhook-logic.ts`
 *   - `resolvePlanId`, `getAddonQueries`, `isAddonEligible`,
 *     `calculateQueryPackLimits`, `determineEndDate`, `determineRenewalEndDate`,
 *     `determineQueryPackEndDate`, `getReadablePlanName` from the shared single
 *     source `@/lib/payments/plan-config`.
 *
 * (Replaces the previous shadow version, which reimplemented every one of these
 * inline and asserted the copy.)
 *
 * Source: apps/web/app/api/webhooks/dodo/route.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePlanId,
  getAddonQueries,
  isAddonEligible,
  calculatePackCreditLimit,
  calculateQueryPackLimits,
  determineEndDate,
  determineRenewalEndDate,
  determineQueryPackEndDate,
  extractCreditPackSize,
  getReadablePlanName,
} from "@usemoney/core/payments/plan-config";
import {
  sanitizePaymentError,
  extractDodoSubscriptionId,
} from "@/app/api/webhooks/dodo/dodo-webhook-logic";

const GENERIC =
  "Your payment could not be processed. Please try again or use a different payment method.";

describe("Dodo Webhook Edge Cases (real exported helpers)", () => {
  // =========================================================================
  // QUERY_PACK eligibility (real resolvePlanId + isAddonEligible)
  // =========================================================================
  describe("handlePaymentCompleted - QUERY_PACK eligibility", () => {
    it("rejects QUERY_PACK for a FREE user", () => {
      assert.strictEqual(isAddonEligible(resolvePlanId("FREE")), false);
    });

    it("rejects QUERY_PACK for an unknown/garbage plan", () => {
      assert.strictEqual(isAddonEligible(resolvePlanId("GARBAGE_PLAN")), false);
    });

    it("rejects QUERY_PACK for a QUERY_PACK user (no stacking)", () => {
      assert.strictEqual(isAddonEligible(resolvePlanId("QUERY_PACK")), false);
    });

    it("accepts QUERY_PACK for PRO / PREMIUM / ULTIMATE users", () => {
      assert.strictEqual(isAddonEligible(resolvePlanId("PRO")), true);
      assert.strictEqual(isAddonEligible(resolvePlanId("PREMIUM")), true);
      assert.strictEqual(isAddonEligible(resolvePlanId("ULTIMATE")), true);
    });

    it("accepts legacy AI_UNLIMITED (resolves to PREMIUM)", () => {
      assert.strictEqual(resolvePlanId("AI_UNLIMITED"), "PREMIUM");
      assert.strictEqual(isAddonEligible(resolvePlanId("AI_UNLIMITED")), true);
    });
  });

  // =========================================================================
  // Addon carry-forward (real calculateQueryPackLimits)
  // =========================================================================
  describe("handlePaymentCompleted - addon carry-forward", () => {
    it("does NOT carry forward when subscription is CANCELLED", () => {
      const result = calculateQueryPackLimits(
        100,
        30,
        50,
        10,
        { fast: 200, advanced: 50 },
        false
      );
      assert.strictEqual(result.fastLimit, 200);
      assert.strictEqual(result.advancedLimit, 50);
    });

    it("treats null fastQueriesLimit as 0", () => {
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

    it("treats null used as 0, keeping all limit as remaining", () => {
      const result = calculateQueryPackLimits(
        100,
        null,
        50,
        null,
        { fast: 200, advanced: 50 },
        true
      );
      assert.strictEqual(result.fastLimit, 300);
      assert.strictEqual(result.advancedLimit, 100);
    });

    it("handles null limit with non-null used (over-usage → 0 remaining)", () => {
      const result = calculateQueryPackLimits(
        null,
        50,
        null,
        25,
        { fast: 200, advanced: 50 },
        true
      );
      assert.strictEqual(result.fastLimit, 200);
      assert.strictEqual(result.advancedLimit, 50);
    });
  });

  // =========================================================================
  // Query-pack end date (real determineQueryPackEndDate)
  // =========================================================================
  describe("handlePaymentCompleted - query-pack end date", () => {
    it("uses the subscription endDate when ACTIVE with an endDate", () => {
      const futureDate = new Date("2026-12-31");
      const result = determineQueryPackEndDate("ACTIVE", futureDate);
      assert.strictEqual(result.getTime(), futureDate.getTime());
    });

    it("falls back to 30 days when CANCELLED with no endDate", () => {
      const now = Date.now();
      const result = determineQueryPackEndDate("CANCELLED", null, now);
      assert.strictEqual(result.getTime(), now + 30 * 24 * 60 * 60 * 1000);
    });

    it("falls back to 30 days when CANCELLED even if an endDate is set", () => {
      const now = Date.now();
      const result = determineQueryPackEndDate(
        "CANCELLED",
        new Date("2026-12-31"),
        now
      );
      assert.strictEqual(result.getTime(), now + 30 * 24 * 60 * 60 * 1000);
    });
  });

  // =========================================================================
  // dodoSubscriptionId extraction (real extractDodoSubscriptionId)
  // =========================================================================
  describe("handlePaymentCompleted - dodoSubscriptionId extraction", () => {
    it("extracts from payment metadata when present", () => {
      assert.strictEqual(
        extractDodoSubscriptionId(
          { dodoSubscriptionId: "sub_123" },
          { subscription_id: "sub_456" }
        ),
        "sub_123"
      );
    });

    it("falls back to webhook data subscription_id", () => {
      assert.strictEqual(
        extractDodoSubscriptionId({}, { subscription_id: "sub_456" }),
        "sub_456"
      );
    });

    it("returns null when both sources are empty", () => {
      assert.strictEqual(extractDodoSubscriptionId({}, {}), null);
    });

    it("handles null payment metadata", () => {
      assert.strictEqual(
        extractDodoSubscriptionId(null, { subscription_id: "sub_789" }),
        "sub_789"
      );
    });

    it("handles null metadata AND no webhook subscription_id", () => {
      assert.strictEqual(extractDodoSubscriptionId(null, {}), null);
    });

    it("handles an undefined webhook body", () => {
      assert.strictEqual(extractDodoSubscriptionId(null, undefined), null);
    });

    it("prefers payment metadata over webhook data", () => {
      assert.strictEqual(
        extractDodoSubscriptionId(
          { dodoSubscriptionId: "from_meta" },
          { subscription_id: "from_webhook" }
        ),
        "from_meta"
      );
    });
  });

  // =========================================================================
  // Unknown plan handling (real resolvePlanId)
  // =========================================================================
  describe("handlePaymentCompleted - unknown plan type", () => {
    it("resolves an unknown plan to itself (no addon)", () => {
      const resolved = resolvePlanId("UNKNOWN_PLAN");
      assert.strictEqual(resolved, "UNKNOWN_PLAN");
      assert.strictEqual(resolved === "QUERY_PACK", false);
    });

    it("resolves legacy AI_ADDON to QUERY_PACK", () => {
      assert.strictEqual(resolvePlanId("AI_ADDON"), "QUERY_PACK");
    });
  });

  // =========================================================================
  // Main-plan end date (real determineEndDate)
  // =========================================================================
  describe("handlePaymentCompleted - annual vs monthly endDate", () => {
    it("sets a 365-day endDate for an annual period", () => {
      const now = Date.now();
      const endDate = determineEndDate("PREMIUM", "annual", now);
      assert.strictEqual(endDate!.getTime(), now + 365 * 24 * 60 * 60 * 1000);
    });

    it("sets a 30-day endDate for a monthly period", () => {
      const now = Date.now();
      const endDate = determineEndDate("PREMIUM", "monthly", now);
      assert.strictEqual(endDate!.getTime(), now + 30 * 24 * 60 * 60 * 1000);
    });

    it("defaults to a 30-day endDate when period is null", () => {
      const now = Date.now();
      const endDate = determineEndDate("PREMIUM", null, now);
      assert.strictEqual(endDate!.getTime(), now + 30 * 24 * 60 * 60 * 1000);
    });

    it("returns null for FREE regardless of period", () => {
      assert.strictEqual(determineEndDate("FREE", "monthly"), null);
      assert.strictEqual(determineEndDate("FREE", "annual"), null);
      assert.strictEqual(determineEndDate("FREE", null), null);
    });

    it("returns null for PRO (one-time purchase)", () => {
      assert.strictEqual(determineEndDate("PRO", "monthly"), null);
      assert.strictEqual(determineEndDate("PRO", null), null);
    });
  });

  // =========================================================================
  // sanitizePaymentError - extensive edge cases (real helper)
  // =========================================================================
  describe("handlePaymentFailed - sanitizePaymentError", () => {
    it("returns the generic message for null", () => {
      assert.strictEqual(sanitizePaymentError(null), GENERIC);
    });

    it("returns the generic message for undefined", () => {
      assert.strictEqual(sanitizePaymentError(undefined), GENERIC);
    });

    it("returns the generic message for a number", () => {
      assert.strictEqual(sanitizePaymentError(42), GENERIC);
    });

    it("returns the generic message for an empty string", () => {
      assert.strictEqual(sanitizePaymentError(""), GENERIC);
    });

    it("matches 'insufficient' (case insensitive) → declined message", () => {
      const result = sanitizePaymentError(
        "INSUFFICIENT funds in account XYZ-123"
      );
      assert.ok(result.includes("declined"));
    });

    it("matches 'declined'", () => {
      assert.ok(
        sanitizePaymentError("Transaction Declined by bank").includes(
          "declined"
        )
      );
    });

    it("matches 'expired'", () => {
      assert.ok(
        sanitizePaymentError("Card expired on 2024-01-01").includes("expired")
      );
    });

    it("matches 'cancelled' (British spelling)", () => {
      assert.ok(
        sanitizePaymentError("User cancelled the transaction").includes(
          "cancelled"
        )
      );
    });

    it("matches 'canceled' (American spelling)", () => {
      assert.ok(
        sanitizePaymentError("Payment canceled by gateway").includes(
          "cancelled"
        )
      );
    });

    it("matches 'timeout'", () => {
      assert.ok(
        sanitizePaymentError("Gateway connection timeout").includes("timed out")
      );
    });

    it("matches 'timed out'", () => {
      assert.ok(
        sanitizePaymentError("The request timed out after 30s").includes(
          "timed out"
        )
      );
    });

    it("returns the generic message for an unrecognized error (no internal leakage)", () => {
      assert.strictEqual(
        sanitizePaymentError(
          "Internal server error at /api/v1/charge, stack: Error: ..."
        ),
        GENERIC
      );
    });

    it("treats whitespace-only as a string with no keyword match", () => {
      assert.strictEqual(sanitizePaymentError("   "), GENERIC);
    });

    it("matches a keyword embedded in a very long message", () => {
      const longMsg = "A".repeat(10000) + " insufficient " + "B".repeat(10000);
      assert.ok(sanitizePaymentError(longMsg).includes("declined"));
    });

    it("applies keyword precedence (insufficient before expired)", () => {
      assert.ok(
        sanitizePaymentError("insufficient funds and card expired").includes(
          "declined"
        )
      );
    });

    it("handles an object error gracefully", () => {
      assert.strictEqual(
        sanitizePaymentError({ message: "error" } as unknown as string),
        GENERIC
      );
    });

    it("handles an array error gracefully", () => {
      assert.strictEqual(
        sanitizePaymentError(["error"] as unknown as string),
        GENERIC
      );
    });

    it("handles a boolean error gracefully", () => {
      assert.strictEqual(sanitizePaymentError(false), GENERIC);
    });
  });

  // =========================================================================
  // Renewal end date (real determineRenewalEndDate)
  // =========================================================================
  describe("handleSubscriptionRenewed - determineRenewalEndDate", () => {
    it("defaults to a 30-day endDate when billingPeriod is null", () => {
      const now = Date.now();
      assert.strictEqual(
        determineRenewalEndDate(null, now).getTime(),
        now + 30 * 24 * 60 * 60 * 1000
      );
    });

    it("uses a 365-day endDate for an annual billingPeriod", () => {
      const now = Date.now();
      assert.strictEqual(
        determineRenewalEndDate("annual", now).getTime(),
        now + 365 * 24 * 60 * 60 * 1000
      );
    });

    it("uses a 30-day endDate for a monthly billingPeriod", () => {
      const now = Date.now();
      assert.strictEqual(
        determineRenewalEndDate("monthly", now).getTime(),
        now + 30 * 24 * 60 * 60 * 1000
      );
    });

    it("treats an unknown billingPeriod like monthly (30 days)", () => {
      const now = Date.now();
      assert.strictEqual(
        determineRenewalEndDate("quarterly", now).getTime(),
        now + 30 * 24 * 60 * 60 * 1000
      );
    });
  });

  // =========================================================================
  // getReadablePlanName edge cases (real helper)
  // =========================================================================
  describe("getReadablePlanName - edge cases", () => {
    it("PREMIUM → Premium", () => {
      assert.strictEqual(getReadablePlanName("PREMIUM"), "Premium");
    });

    it("PRO → Pro", () => {
      assert.strictEqual(getReadablePlanName("PRO"), "Pro");
    });

    it("ULTIMATE → raw (no special mapping)", () => {
      assert.strictEqual(getReadablePlanName("ULTIMATE"), "ULTIMATE");
    });

    it("FREE → raw", () => {
      assert.strictEqual(getReadablePlanName("FREE"), "FREE");
    });

    it("QUERY_PACK → raw", () => {
      assert.strictEqual(getReadablePlanName("QUERY_PACK"), "QUERY_PACK");
    });
  });

  // =========================================================================
  // Addon query allocation (real getAddonQueries)
  // =========================================================================
  describe("getAddonQueries - resolved-plan based", () => {
    it("PRO → 200 fast + 50 advanced", () => {
      assert.deepStrictEqual(getAddonQueries("PRO"), {
        fast: 200,
        advanced: 50,
      });
    });

    it("PREMIUM / ULTIMATE → 0 fast + 200 advanced", () => {
      assert.deepStrictEqual(getAddonQueries("PREMIUM"), {
        fast: 0,
        advanced: 200,
      });
      assert.deepStrictEqual(getAddonQueries("ULTIMATE"), {
        fast: 0,
        advanced: 200,
      });
    });

    it("legacy AI_UNLIMITED → 0 fast + 200 advanced (resolves to PREMIUM)", () => {
      assert.deepStrictEqual(getAddonQueries("AI_UNLIMITED"), {
        fast: 0,
        advanced: 200,
      });
    });

    it("FREE / unknown → 0/0", () => {
      assert.deepStrictEqual(getAddonQueries("FREE"), { fast: 0, advanced: 0 });
      assert.deepStrictEqual(getAddonQueries("WHATEVER"), {
        fast: 0,
        advanced: 0,
      });
    });
  });

  // =========================================================================
  // Credit-pack grant (real extractCreditPackSize + calculatePackCreditLimit)
  // — the unified-ledger half of the addon branch. Regression: the webhook
  // used to grant only the legacy queryPack* counters, so when it beat the
  // redirect callback to the appliedAt claim the pack-credit grant was lost
  // ("invoice Paid, credits never added").
  // =========================================================================
  describe("handlePaymentCompleted - credit-pack grant", () => {
    it("reads creditPackSize from checkout metadata first", () => {
      assert.strictEqual(
        extractCreditPackSize(
          { creditPackSize: 50, originalPlanId: "CREDIT_PACK_1000" },
          "Credit Pack (9999 credits)"
        ),
        50
      );
    });

    it("falls back to originalPlanId when creditPackSize is absent", () => {
      assert.strictEqual(
        extractCreditPackSize(
          { originalPlanId: "CREDIT_PACK_100" },
          "Credit Pack (9999 credits)"
        ),
        100
      );
    });

    it("falls back to planName for older Payment rows", () => {
      assert.strictEqual(
        extractCreditPackSize({}, "Credit Pack (1000 credits)"),
        1000
      );
      assert.strictEqual(
        extractCreditPackSize(null, "credit pack (50 CREDITS)"),
        50
      );
    });

    it("ignores a zero/invalid creditPackSize and keeps falling back", () => {
      assert.strictEqual(
        extractCreditPackSize(
          { creditPackSize: 0, originalPlanId: "CREDIT_PACK_50" },
          null
        ),
        50
      );
    });

    it("legacy QUERY_PACK purchase (no markers) → 0 pack credits", () => {
      assert.strictEqual(extractCreditPackSize({}, "QUERY_PACK"), 0);
      assert.strictEqual(extractCreditPackSize(null, null), 0);
    });

    it("QA repro: ACTIVE sub with 2000/0 pack credits + 50-pack → 2050", () => {
      assert.strictEqual(calculatePackCreditLimit(2000, 0, 50, true), 2050);
    });

    it("carries forward only the UNUSED pack balance when ACTIVE", () => {
      assert.strictEqual(calculatePackCreditLimit(2000, 80, 50, true), 1970);
    });

    it("starts fresh when the subscription is not ACTIVE", () => {
      assert.strictEqual(calculatePackCreditLimit(2000, 80, 50, false), 50);
    });

    it("treats null limits/usage as 0 and floors over-use at 0", () => {
      assert.strictEqual(calculatePackCreditLimit(null, null, 50, true), 50);
      assert.strictEqual(calculatePackCreditLimit(100, 250, 50, true), 50);
    });
  });
});
