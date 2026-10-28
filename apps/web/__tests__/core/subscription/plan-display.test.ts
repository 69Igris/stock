/**
 * MONEY-865 / MONEY-866 — regression tests for the bugs that the inline glue in
 * createCheckoutAction + the Settings UI hid (no React/Dodo test harness caught
 * them). Exercises the REAL exported pure logic.
 *
 * Source: packages/core/src/subscription/plan-display.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isLifetimePlan,
  planDisplayLabel,
  resolveCheckoutPeriod,
  resolveCheckoutAmount,
} from "@usemoney/core/subscription";

describe("MONEY-866 isLifetimePlan — a paid PRO is NOT lifetime", () => {
  it("PRO annual is NOT lifetime (the reported 'PRO · Lifetime on PRO annual' bug)", () => {
    assert.equal(isLifetimePlan("PRO", "annual"), false);
  });
  it("PRO monthly is NOT lifetime", () => {
    assert.equal(isLifetimePlan("PRO", "monthly"), false);
  });
  it("PRO with NO cycle IS lifetime (legacy grandfathered)", () => {
    assert.equal(isLifetimePlan("PRO", null), true);
    assert.equal(isLifetimePlan("PRO", undefined), true);
  });
  it("PREMIUM / FREE are never lifetime", () => {
    assert.equal(isLifetimePlan("PREMIUM", "annual"), false);
    assert.equal(isLifetimePlan("PREMIUM", null), false);
    assert.equal(isLifetimePlan("FREE", null), false);
  });
});

describe("MONEY-866 planDisplayLabel", () => {
  it("PRO annual → 'PRO · Annual'", () => {
    assert.equal(planDisplayLabel("PRO", "annual"), "PRO · Annual");
  });
  it("PRO monthly → 'PRO · Monthly'", () => {
    assert.equal(planDisplayLabel("PRO", "monthly"), "PRO · Monthly");
  });
  it("PRO no-cycle → 'PRO · Lifetime' (grandfathered only)", () => {
    assert.equal(planDisplayLabel("PRO", null), "PRO · Lifetime");
  });
  it("PREMIUM → 'PREMIUM'; FREE/null → 'FREE'", () => {
    assert.equal(planDisplayLabel("PREMIUM", "annual"), "PREMIUM");
    assert.equal(planDisplayLabel("FREE", null), "FREE");
    assert.equal(planDisplayLabel(null, null), "FREE");
  });
});

describe("MONEY-866 resolveCheckoutPeriod — PRO/PREMIUM are never one-time", () => {
  it("PRO annual → annual; PRO monthly → monthly", () => {
    assert.equal(resolveCheckoutPeriod("PRO", "annual", false), "annual");
    assert.equal(resolveCheckoutPeriod("PRO", "monthly", false), "monthly");
  });
  it("PRO with NO cycle → monthly (NEVER one-time — lifetime PRO deprecated)", () => {
    assert.equal(resolveCheckoutPeriod("PRO", null, false), "monthly");
    assert.equal(resolveCheckoutPeriod("PRO", undefined, false), "monthly");
  });
  it("PREMIUM with NO cycle → monthly (never one-time)", () => {
    assert.equal(resolveCheckoutPeriod("PREMIUM", null, false), "monthly");
  });
  it("a credit pack → one-time", () => {
    assert.equal(resolveCheckoutPeriod("QUERY_PACK", null, true), "one-time");
  });
});

describe("MONEY-865 resolveCheckoutAmount — Dodo price is the source of truth, never ₹999", () => {
  it("uses the synced Dodo product price when present", () => {
    assert.equal(
      resolveCheckoutAmount({
        resolvedPlanId: "PREMIUM",
        billingPeriod: "monthly",
        isCreditPack: false,
        dodoPrice: 1499,
      }),
      1499
    );
  });
  it("PREMIUM-monthly cold-miss → ₹1,499 from PLAN_CONFIG.price, NEVER the legacy ₹999", () => {
    const amt = resolveCheckoutAmount({
      resolvedPlanId: "PREMIUM",
      billingPeriod: "monthly",
      isCreditPack: false,
      dodoPrice: null,
    });
    assert.equal(amt, 1499);
    assert.notEqual(amt, 999);
  });
  it("PRO cold-miss → ₹249 monthly / ₹1,999 annual", () => {
    assert.equal(
      resolveCheckoutAmount({
        resolvedPlanId: "PRO",
        billingPeriod: "monthly",
        isCreditPack: false,
        dodoPrice: null,
      }),
      249
    );
    assert.equal(
      resolveCheckoutAmount({
        resolvedPlanId: "PRO",
        billingPeriod: "annual",
        isCreditPack: false,
        dodoPrice: null,
      }),
      1999
    );
  });
  it("PREMIUM-annual cold-miss → PLAN_CONFIG.annualPrice", () => {
    assert.equal(
      resolveCheckoutAmount({
        resolvedPlanId: "PREMIUM",
        billingPeriod: "annual",
        isCreditPack: false,
        dodoPrice: null,
      }),
      14990
    );
  });
  it("a credit pack uses its SKU price", () => {
    assert.equal(
      resolveCheckoutAmount({
        resolvedPlanId: "QUERY_PACK",
        billingPeriod: null,
        isCreditPack: true,
        dodoPrice: null,
        creditPackPrice: 399,
      }),
      399
    );
  });
  it("a non-finite Dodo price falls back (money-safety)", () => {
    assert.equal(
      resolveCheckoutAmount({
        resolvedPlanId: "PREMIUM",
        billingPeriod: "monthly",
        isCreditPack: false,
        dodoPrice: Number.NaN,
      }),
      1499
    );
  });
});
