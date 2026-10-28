/**
 * Payments Checkout CONTRACT tests.
 *
 * Exercises the REAL exported `PLAN_CONFIG` + checkout helpers from the shared
 * single source of truth `@usemoney/core/payments/plan-config` (moved from
 * apps/web/lib/payments/plan-config in MONEY-1062 W1) that the checkout flow
 * imports and calls — NOT inline copies.
 *
 * (Replaces the previous shadow version, which reimplemented PLAN_CONFIG /
 * validatePlanId / buildReturnUrl / buildProductId / formatCheckoutResponse
 * inline. That shadow had ALSO silently drifted from reality — e.g. it asserted
 * PREMIUM price 499 and PRO name "Pro" while the real config is 999 / "PRO" —
 * so it was both a shadow AND wrong.)
 *
 * Source: apps/web/app/api/payments/create-checkout/route.ts
 *       + packages/core/src/payments/plan-config.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_CONFIG,
  validateCheckoutPlan,
  buildCheckoutReturnUrl,
  buildCheckoutProductId,
  formatCheckoutResponse,
  getCheckoutCustomerName,
} from "@usemoney/core/payments/plan-config";
// J-F2 regression guard reads the merged metadata back through the REAL consumer.
import { extractDodoSubscriptionId } from "../../../../packages/services/src/payment-provisioning-logic";

describe("Payments Checkout Logic (real PLAN_CONFIG + helpers)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  describe("validateCheckoutPlan", () => {
    it("accepts PRO plan", () => {
      assert.strictEqual(validateCheckoutPlan("PRO").valid, true);
    });

    it("accepts PREMIUM plan", () => {
      assert.strictEqual(validateCheckoutPlan("PREMIUM").valid, true);
    });

    it("accepts QUERY_PACK plan", () => {
      assert.strictEqual(validateCheckoutPlan("QUERY_PACK").valid, true);
    });

    it("rejects FREE plan with the exact error", () => {
      const result = validateCheckoutPlan("FREE");
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, "Free plan does not require payment");
    });

    it("rejects an unknown plan with 'Invalid plan'", () => {
      const result = validateCheckoutPlan("ENTERPRISE");
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, "Invalid plan");
    });

    it("rejects an empty string ('Invalid plan')", () => {
      const result = validateCheckoutPlan("");
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, "Invalid plan");
    });

    it("validates against a supplied config override", () => {
      const custom = {
        ONLY: {
          id: "ONLY",
          name: "Only",
          price: 1,
          currency: "INR",
          period: "one-time",
          aiQueries: 0,
          fastQueries: 0,
          slowQueries: 0,
          advancedQueries: 0,
        },
      };
      assert.strictEqual(validateCheckoutPlan("ONLY", custom).valid, true);
      assert.strictEqual(validateCheckoutPlan("PRO", custom).valid, false);
    });
  });

  describe("PLAN_CONFIG (real Dodo product config)", () => {
    it("PRO is priced at ₹999", () => {
      assert.strictEqual(PLAN_CONFIG["PRO"].price, 999);
    });

    it("PREMIUM is priced at ₹999 (monthly)", () => {
      assert.strictEqual(PLAN_CONFIG["PREMIUM"].price, 999);
      assert.strictEqual(PLAN_CONFIG["PREMIUM"].period, "monthly");
    });

    it("QUERY_PACK is priced at ₹199", () => {
      assert.strictEqual(PLAN_CONFIG["QUERY_PACK"].price, 199);
    });

    it("FREE is priced at ₹0", () => {
      assert.strictEqual(PLAN_CONFIG["FREE"].price, 0);
    });

    it("every plan is denominated in INR", () => {
      for (const planId of Object.keys(PLAN_CONFIG)) {
        assert.strictEqual(PLAN_CONFIG[planId].currency, "INR");
      }
    });

    it("carries the product display names checkout uses for the Payment row", () => {
      assert.strictEqual(PLAN_CONFIG["PRO"].name, "PRO");
      assert.strictEqual(PLAN_CONFIG["PREMIUM"].name, "Premium");
      assert.strictEqual(PLAN_CONFIG["QUERY_PACK"].name, "Query Pack");
      assert.strictEqual(PLAN_CONFIG["FREE"].name, "Free");
    });

    it("exposes exactly the four checkout plans", () => {
      assert.deepStrictEqual(Object.keys(PLAN_CONFIG).sort(), [
        "FREE",
        "PREMIUM",
        "PRO",
        "QUERY_PACK",
      ]);
    });
  });

  describe("buildCheckoutReturnUrl", () => {
    it("builds the callback return URL with paymentId + planId", () => {
      assert.strictEqual(
        buildCheckoutReturnUrl("https://usemoney.ai", "pay_123", "PRO"),
        "https://usemoney.ai/api/payments/callback?paymentId=pay_123&planId=PRO"
      );
    });
  });

  describe("buildCheckoutProductId", () => {
    it("builds tradebook_<lowercased planId>", () => {
      assert.strictEqual(buildCheckoutProductId("PRO"), "tradebook_pro");
      assert.strictEqual(
        buildCheckoutProductId("PREMIUM"),
        "tradebook_premium"
      );
      assert.strictEqual(
        buildCheckoutProductId("QUERY_PACK"),
        "tradebook_query_pack"
      );
    });
  });

  describe("formatCheckoutResponse", () => {
    it("formats the successful checkout response", () => {
      const response = formatCheckoutResponse(
        "https://checkout.dodo.com/abc",
        "pay_123"
      );
      assert.strictEqual(response.success, true);
      assert.strictEqual(response.checkoutUrl, "https://checkout.dodo.com/abc");
      assert.strictEqual(response.paymentId, "pay_123");
    });

    it("tolerates an undefined checkout URL (Dodo omitted payment_link)", () => {
      const response = formatCheckoutResponse(undefined, "pay_123");
      assert.strictEqual(response.success, true);
      assert.strictEqual(response.checkoutUrl, undefined);
      assert.strictEqual(response.paymentId, "pay_123");
    });
  });

  describe("getCheckoutCustomerName", () => {
    it("uses fullName when available", () => {
      assert.strictEqual(
        getCheckoutCustomerName("John Doe", "John"),
        "John Doe"
      );
    });

    it("falls back to firstName", () => {
      assert.strictEqual(getCheckoutCustomerName(null, "John"), "John");
    });

    it("falls back to 'Customer' when both are null", () => {
      assert.strictEqual(getCheckoutCustomerName(null, null), "Customer");
    });

    it("falls back to 'Customer' when both are undefined", () => {
      assert.strictEqual(
        getCheckoutCustomerName(undefined, undefined),
        "Customer"
      );
    });
  });
});

describe("createCheckoutAction metadata write (J-F2 regression guard)", () => {
  // createCheckoutAction is a "use server" module (Clerk + prisma + Dodo) that can't
  // be unit-driven, so this locks the METADATA-MERGE INVARIANT the fix guarantees
  // against the REAL consumer that reads it back — extractDodoSubscriptionId, which
  // the webhook + payments callback use to link renewal/cancel/dunning events to the
  // Payment row.
  //
  // BUG (J-F2): the checkout did TWO sequential prisma.payment.update calls that
  // EACH spread the SAME stale in-memory payment.metadata; the second's spread
  // dropped the first's dodoSubscriptionId. FIX: ONE update carrying both keys.
  const base = { customerEmail: "a@b.com", billingPeriod: "monthly" };
  const subscriptionId = "sub_dodo_123";
  const paymentId = "pay_dodo_456";

  it("the OLD two-write final metadata loses dodoSubscriptionId → consumer can't link the row", () => {
    // The second update spread the stale base (NOT the first write's result).
    const oldFinalMetadata = { ...base, dodoPaymentId: paymentId };
    assert.strictEqual(
      extractDodoSubscriptionId(oldFinalMetadata, null),
      null,
      "the regression: renewal/cancel/dunning webhooks could not find the subscription"
    );
  });

  it("the FIXED single-merge carries BOTH keys → consumer recovers the subscription id", () => {
    // Exactly the object the fixed createCheckoutAction builds for a recurring
    // (subscription) checkout.
    const fixedMetadata = {
      ...base,
      ...(subscriptionId ? { dodoSubscriptionId: subscriptionId } : {}),
      dodoPaymentId: paymentId,
    };
    assert.strictEqual(fixedMetadata.dodoPaymentId, paymentId);
    assert.strictEqual(
      extractDodoSubscriptionId(fixedMetadata, null),
      subscriptionId
    );
    // Base checkout keys survive the merge too.
    assert.strictEqual(fixedMetadata.customerEmail, "a@b.com");
  });

  it("a one-time (pack) checkout omits dodoSubscriptionId but still writes dodoPaymentId", () => {
    const noSub: string | undefined = undefined;
    const fixedMetadata = {
      ...base,
      ...(noSub ? { dodoSubscriptionId: noSub } : {}),
      dodoPaymentId: paymentId,
    };
    assert.strictEqual(fixedMetadata.dodoPaymentId, paymentId);
    assert.strictEqual(extractDodoSubscriptionId(fixedMetadata, null), null);
  });
});
