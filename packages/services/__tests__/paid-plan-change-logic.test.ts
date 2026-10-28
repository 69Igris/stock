/**
 * MONEY-865 Issue #4 — paid plan-change routing + discount math.
 *
 * Exercises the REAL exported `decidePaidPlanChange` / `planTier`: the route
 * decision (checkout vs change-plan vs scheduled-downgrade) and the discounted
 * price for flat / percent / 100% coupons across monthly + annual list prices.
 *
 * Source: packages/services/src/paid-plan-change-logic.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decidePaidPlanChange,
  planTier,
} from "../src/paid-plan-change-logic.ts";

describe("paid-plan-change — planTier ordering", () => {
  it("orders FREE < PRO < PREMIUM < ULTIMATE", () => {
    assert.ok(planTier("FREE") < planTier("PRO"));
    assert.ok(planTier("PRO") < planTier("PREMIUM"));
    assert.ok(planTier("PREMIUM") < planTier("ULTIMATE"));
  });

  it("unknown / null plan reads as FREE-level (0)", () => {
    assert.equal(planTier("NONSENSE"), 0);
    assert.equal(planTier(null), 0);
    assert.equal(planTier(undefined), 0);
  });
});

describe("paid-plan-change — routing", () => {
  it("no active Dodo sub → checkout (create-new), even on an upgrade", () => {
    const d = decidePaidPlanChange({
      currentPlan: "FREE",
      hasActiveDodoSub: false,
      targetPlan: "PREMIUM",
      targetListPrice: 1499,
    });
    assert.equal(d.route, "checkout");
    assert.equal(d.isUpgrade, true);
  });

  it("coupon-grant PRO (no Dodo sub) upgrading → still checkout", () => {
    const d = decidePaidPlanChange({
      currentPlan: "PRO",
      hasActiveDodoSub: false,
      targetPlan: "PREMIUM",
      targetListPrice: 1499,
    });
    assert.equal(d.route, "checkout");
  });

  it("active Dodo sub + UPGRADE → change-plan (the fix: no 2nd subscription)", () => {
    const d = decidePaidPlanChange({
      currentPlan: "PRO",
      hasActiveDodoSub: true,
      targetPlan: "PREMIUM",
      targetListPrice: 1499,
    });
    assert.equal(d.route, "change-plan");
    assert.equal(d.isUpgrade, true);
  });

  it("active Dodo sub + DOWNGRADE → scheduled-downgrade (unchanged path)", () => {
    const d = decidePaidPlanChange({
      currentPlan: "PREMIUM",
      hasActiveDodoSub: true,
      targetPlan: "PRO",
      targetListPrice: 249,
    });
    assert.equal(d.route, "scheduled-downgrade");
    assert.equal(d.isUpgrade, false);
  });

  it("same-tier cycle change (PRO monthly → PRO annual) → change-plan, NOT a 2nd sub", () => {
    const d = decidePaidPlanChange({
      currentPlan: "PRO",
      currentBillingPeriod: "monthly",
      hasActiveDodoSub: true,
      targetPlan: "PRO",
      targetBillingPeriod: "annual",
      targetListPrice: 1999,
    });
    assert.equal(d.isUpgrade, false); // same tier
    assert.equal(d.route, "change-plan"); // MONEY-866: in-place, no duplicate sub
  });

  it("same-tier cycle DOWNGRADE (PRO annual → PRO monthly) → scheduled-downgrade", () => {
    // MONEY-872: annual → monthly is a cycle DOWNGRADE — schedule at term end, do
    // NOT raise an immediate prorated charge to move to the cheaper cycle. Only the
    // cycle UPGRADE direction (monthly → annual) routes to an in-place change-plan.
    const d = decidePaidPlanChange({
      currentPlan: "PRO",
      currentBillingPeriod: "annual",
      hasActiveDodoSub: true,
      targetPlan: "PRO",
      targetBillingPeriod: "monthly",
      targetListPrice: 249,
    });
    assert.equal(d.route, "scheduled-downgrade");
  });

  it("same plan + SAME cycle (no real change) → not treated as a cycle change", () => {
    const d = decidePaidPlanChange({
      currentPlan: "PRO",
      currentBillingPeriod: "annual",
      hasActiveDodoSub: true,
      targetPlan: "PRO",
      targetBillingPeriod: "annual",
      targetListPrice: 1999,
    });
    assert.equal(d.route, "scheduled-downgrade");
  });

  it("cycle info ABSENT (old callers) → unchanged behavior (no false cycle change)", () => {
    const d = decidePaidPlanChange({
      currentPlan: "PRO",
      hasActiveDodoSub: true,
      targetPlan: "PRO",
      targetListPrice: 1999,
    });
    assert.equal(d.route, "scheduled-downgrade");
  });
});

// MONEY-872 — MONKEY-TEST: the FULL plan-change cross-product as routing INVARIANTS.
// The routing regressions (annual→monthly charged immediately; scheduled-downgrade
// falling through to a 2nd Dodo sub) slipped because the tests only checked a handful
// of hand-picked combos. This generates EVERY (current, target, cycle, sub) cell and
// asserts the invariants that MUST hold — so a mis-route fails CI, not production.
describe("MONEY-872 monkey-test — decidePaidPlanChange full cross-product invariants", () => {
  const PLANS = ["FREE", "PRO", "PREMIUM", "ULTIMATE"] as const;
  const CYCLES = ["monthly", "annual"] as const;
  const LIST: Record<string, Record<string, number>> = {
    FREE: { monthly: 0, annual: 0 },
    PRO: { monthly: 249, annual: 1999 },
    PREMIUM: { monthly: 1499, annual: 14990 },
    ULTIMATE: { monthly: 4999, annual: 49990 },
  };

  for (const currentPlan of PLANS) {
    for (const currentBillingPeriod of CYCLES) {
      for (const targetPlan of PLANS) {
        for (const targetBillingPeriod of CYCLES) {
          for (const hasActiveDodoSub of [true, false]) {
            const label = `${currentPlan}/${currentBillingPeriod} -> ${targetPlan}/${targetBillingPeriod} sub=${hasActiveDodoSub}`;
            it(label, () => {
              const d = decidePaidPlanChange({
                currentPlan,
                currentBillingPeriod,
                hasActiveDodoSub,
                targetPlan,
                targetBillingPeriod,
                targetListPrice: LIST[targetPlan][targetBillingPeriod],
              });
              const up = planTier(targetPlan) > planTier(currentPlan);
              const down = planTier(targetPlan) < planTier(currentPlan);
              const sameTier = targetPlan === currentPlan;

              // 1 — route is always one of the three valid routes.
              assert.ok(
                ["checkout", "change-plan", "scheduled-downgrade"].includes(
                  d.route,
                ),
                `${label}: invalid route ${d.route}`,
              );
              // 2 — NO active Dodo sub → ALWAYS a fresh checkout (never touch a sub
              // that doesn't exist).
              if (!hasActiveDodoSub) {
                assert.equal(
                  d.route,
                  "checkout",
                  `${label}: no-sub must checkout`,
                );
              }
              // 3 — active sub + TIER UPGRADE → change-plan in place (NEVER checkout =
              // a 2nd parallel subscription).
              if (hasActiveDodoSub && up) {
                assert.equal(
                  d.route,
                  "change-plan",
                  `${label}: upgrade must change-plan`,
                );
              }
              // 4 — active sub + TIER DOWNGRADE → scheduled at term end (NEVER
              // checkout = 2nd sub, NEVER an immediate charge).
              if (hasActiveDodoSub && down) {
                assert.equal(
                  d.route,
                  "scheduled-downgrade",
                  `${label}: downgrade must schedule`,
                );
              }
              // 5 — active sub + SAME tier, different cycle: monthly→annual is an
              // in-place change-plan; annual→monthly is a cycle DOWNGRADE that MUST be
              // scheduled (the regression: it was charged immediately).
              if (
                hasActiveDodoSub &&
                sameTier &&
                currentBillingPeriod !== targetBillingPeriod
              ) {
                const expected =
                  currentBillingPeriod === "monthly" &&
                  targetBillingPeriod === "annual"
                    ? "change-plan"
                    : "scheduled-downgrade";
                assert.equal(
                  d.route,
                  expected,
                  `${label}: same-tier cycle mis-routed`,
                );
              }
              // 6 — price is always sane: 0 ≤ finalPrice ≤ listPrice.
              assert.ok(
                d.finalPrice >= 0 && d.finalPrice <= d.listPrice,
                `${label}: finalPrice ${d.finalPrice} out of [0, ${d.listPrice}]`,
              );
            });
          }
        }
      }
    }
  }
});

// MONEY-872 — a coupon must change only the PRICE, never the ROUTE; fullyCovered is
// exact at the 100% / over-100% boundary (clamped).
describe("MONEY-872 monkey-test — coupon changes price not route", () => {
  const base = {
    currentPlan: "PRO",
    currentBillingPeriod: "monthly",
    hasActiveDodoSub: true,
    targetPlan: "PREMIUM",
    targetBillingPeriod: "monthly",
    targetListPrice: 1499,
  } as const;
  const noCoupon = decidePaidPlanChange(base);

  for (const pct of [10, 20, 50, 99, 100, 150]) {
    it(`${pct}% coupon → route stays ${noCoupon.route}, price + covered correct`, () => {
      const d = decidePaidPlanChange({
        ...base,
        coupon: { discountType: "percent", discountPercent: pct },
      });
      assert.equal(d.route, noCoupon.route); // a coupon prices; it never re-routes
      const expected = Math.max(0, 1499 * (1 - Math.min(pct, 100) / 100));
      assert.ok(
        Math.abs(d.finalPrice - expected) < 1e-6,
        `${pct}%: finalPrice ${d.finalPrice} != ${expected}`,
      );
      assert.equal(d.fullyCovered, pct >= 100);
    });
  }
});

describe("paid-plan-change — discount (flat / % / 100%) × (monthly / annual)", () => {
  const base = {
    currentPlan: "PRO",
    hasActiveDodoSub: true,
    targetPlan: "PREMIUM",
  } as const;

  it("NO coupon → finalPrice = list, monthly", () => {
    const d = decidePaidPlanChange({ ...base, targetListPrice: 1499 });
    assert.equal(d.finalPrice, 1499);
    assert.equal(d.fullyCovered, false);
  });

  it("NO coupon → finalPrice = list, annual", () => {
    const d = decidePaidPlanChange({ ...base, targetListPrice: 14999 });
    assert.equal(d.finalPrice, 14999);
  });

  it("PERCENT 20% off monthly ₹1499 → ₹1199.2", () => {
    const d = decidePaidPlanChange({
      ...base,
      targetListPrice: 1499,
      coupon: { discountType: "percent", discountPercent: 20 },
    });
    assert.ok(Math.abs(d.finalPrice - 1199.2) < 1e-6);
    assert.equal(d.fullyCovered, false);
  });

  it("PERCENT 20% off annual ₹14999 → ₹11999.2", () => {
    const d = decidePaidPlanChange({
      ...base,
      targetListPrice: 14999,
      coupon: { discountType: "percent", discountPercent: 20 },
    });
    assert.ok(Math.abs(d.finalPrice - 11999.2) < 1e-6);
  });

  it("FLAT ₹500 off monthly ₹1499 → ₹999", () => {
    const d = decidePaidPlanChange({
      ...base,
      targetListPrice: 1499,
      coupon: { discountType: "flat", discountAmount: 500 },
    });
    assert.equal(d.finalPrice, 999);
    assert.equal(d.fullyCovered, false);
  });

  it("FLAT ₹500 off annual ₹14999 → ₹14499", () => {
    const d = decidePaidPlanChange({
      ...base,
      targetListPrice: 14999,
      coupon: { discountType: "flat", discountAmount: 500 },
    });
    assert.equal(d.finalPrice, 14499);
  });

  it("PERCENT 100% → fully covered, monthly (still routes change-plan)", () => {
    const d = decidePaidPlanChange({
      ...base,
      targetListPrice: 1499,
      coupon: { discountType: "percent", discountPercent: 100 },
    });
    assert.equal(d.finalPrice, 0);
    assert.equal(d.fullyCovered, true);
    // Even free, an existing Dodo sub MUST change in place so Dodo stays in sync.
    assert.equal(d.route, "change-plan");
  });

  it("PERCENT 100% → fully covered, annual", () => {
    const d = decidePaidPlanChange({
      ...base,
      targetListPrice: 14999,
      coupon: { discountType: "percent", discountPercent: 100 },
    });
    assert.equal(d.fullyCovered, true);
  });

  it("FLAT ≥ price → fully covered, floored at 0 (never negative)", () => {
    const d = decidePaidPlanChange({
      ...base,
      targetListPrice: 1499,
      coupon: { discountType: "flat", discountAmount: 9999 },
    });
    assert.equal(d.finalPrice, 0);
    assert.equal(d.fullyCovered, true);
  });

  it("percent > 100 is clamped — no charge-up, no negative", () => {
    const d = decidePaidPlanChange({
      ...base,
      targetListPrice: 1499,
      coupon: { discountType: "percent", discountPercent: 150 },
    });
    assert.equal(d.finalPrice, 0);
    assert.equal(d.fullyCovered, true);
  });

  it("non-finite list price is sanitised to 0 (money-safety)", () => {
    const d = decidePaidPlanChange({
      ...base,
      targetListPrice: Number.NaN,
    });
    assert.equal(d.listPrice, 0);
    assert.equal(d.finalPrice, 0);
    assert.equal(d.fullyCovered, true);
  });
});
