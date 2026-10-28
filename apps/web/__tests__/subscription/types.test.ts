/**
 * Subscription Types & Feature Access Tests (MONEY-620) — DE-SHADOWED.
 *
 * The previous version reimplemented PLANS, FEATURE_ACCESS, ANNUAL_DISCOUNT,
 * canAccessFeature, getDefaultSubscription (and a DODO_PLAN_CONFIG copy) INLINE
 * and asserted the COPIES — a shadow. Its inline PLANS had also drifted from the
 * real source (e.g. ULTIMATE price 1999 vs the real 0; PREMIUM originalPrice
 * 1899 vs 1899-but-mislabeled), so it could pass while the real `PLANS` map
 * regressed.
 *
 * This rewrite imports and asserts the REAL exports from the source module
 * `apps/web/lib/subscription/types.ts` (a pure constants/functions module — no
 * Prisma / server-only deps, safe to import directly). The Dodo `PLAN_CONFIG`
 * half of the old shadow mirrored a NON-exported internal of `lib/payments/dodo.ts`
 * and is covered by the Dodo webhook e2e + payments error-handling tests, so it
 * is dropped here rather than re-shadowed.
 *
 * Source: apps/web/lib/subscription/types.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PLANS,
  FEATURE_ACCESS,
  ANNUAL_DISCOUNT,
  PREMIUM_ANNUAL_PRICE,
  PREMIUM_ANNUAL_ORIGINAL_PRICE,
  canAccessFeature,
  getDefaultSubscription,
  type PlanType,
} from "../../lib/subscription/types";

describe("Subscription Types & Feature Access (real exports)", () => {
  // ── PLANS constant ───────────────────────────────────────────────

  describe("PLANS constant", () => {
    it("has all five plan types", () => {
      for (const id of [
        "FREE",
        "PRO",
        "QUERY_PACK",
        "PREMIUM",
        "ULTIMATE",
      ] as const) {
        assert.ok(PLANS[id], `PLANS should have ${id}`);
        assert.equal(PLANS[id].id, id);
      }
    });

    it("FREE: price 0, no AI queries, empty period, non-empty features incl. FIRE Calculator", () => {
      const free = PLANS.FREE;
      assert.equal(free.price, 0);
      assert.equal(free.aiQueries, 0);
      assert.equal(free.fastQueries, 0);
      assert.equal(free.advancedQueries, 0);
      assert.equal(free.period, "");
      assert.ok(free.features.length > 0);
      assert.ok(free.features.includes("FIRE Calculator"));
      assert.equal(free.originalPrice, undefined);
    });

    it("PRO: price 999 < originalPrice 3999, one-time, 20 fast / 5 advanced, limited-time", () => {
      const pro = PLANS.PRO;
      assert.equal(pro.price, 999);
      assert.equal(pro.originalPrice, 3999);
      assert.ok(pro.price < pro.originalPrice!);
      assert.equal(pro.period, "one-time");
      assert.equal(pro.fastQueries, 20);
      assert.equal(pro.advancedQueries, 5);
      assert.equal(pro.isLimitedTime, true);
    });

    it("PREMIUM: monthly, unlimited fast (-1), 200 advanced, Priority Support feature", () => {
      const prem = PLANS.PREMIUM;
      assert.equal(prem.period, "monthly");
      assert.equal(prem.aiQueries, -1);
      assert.equal(prem.fastQueries, -1);
      assert.equal(prem.advancedQueries, 200);
      assert.ok(prem.features.includes("Priority Support"));
    });

    it("QUERY_PACK: price 199 one-time, 200 fast / 50 advanced", () => {
      const qp = PLANS.QUERY_PACK;
      assert.equal(qp.price, 199);
      assert.equal(qp.period, "one-time");
      assert.equal(qp.fastQueries, 200);
      assert.equal(qp.advancedQueries, 50);
    });

    it("ULTIMATE: monthly, fully unlimited queries (-1 across the board)", () => {
      const ult = PLANS.ULTIMATE;
      assert.equal(ult.period, "monthly");
      assert.equal(ult.aiQueries, -1);
      assert.equal(ult.fastQueries, -1);
      assert.equal(ult.advancedQueries, -1);
    });
  });

  // ── Annual pricing constants ─────────────────────────────────────

  describe("annual pricing constants", () => {
    it("ANNUAL_DISCOUNT is a fraction in (0,1)", () => {
      assert.ok(ANNUAL_DISCOUNT > 0 && ANNUAL_DISCOUNT < 1);
      assert.equal(ANNUAL_DISCOUNT, 0.47);
    });

    it("PREMIUM annual price < original annual price", () => {
      assert.equal(PREMIUM_ANNUAL_PRICE, 9999);
      assert.equal(PREMIUM_ANNUAL_ORIGINAL_PRICE, 18999);
      assert.ok(PREMIUM_ANNUAL_PRICE < PREMIUM_ANNUAL_ORIGINAL_PRICE);
    });
  });

  // ── FEATURE_ACCESS + canAccessFeature ────────────────────────────

  describe("FEATURE_ACCESS / canAccessFeature (real)", () => {
    it("the four universal features are available to every plan", () => {
      const universal = [
        "manual-tradebook",
        "fire-calculator",
        "paper-trading",
        "broker-sync",
      ];
      const plans: PlanType[] = ["FREE", "PRO", "PREMIUM", "ULTIMATE"];
      for (const f of universal) {
        for (const p of plans) {
          assert.equal(canAccessFeature(f, p), true, `${p} should access ${f}`);
        }
      }
    });

    it("FREE is denied paid features", () => {
      assert.equal(canAccessFeature("holdings-sync", "FREE"), false);
      assert.equal(canAccessFeature("positions-sync", "FREE"), false);
      assert.equal(canAccessFeature("ai-queries", "FREE"), false);
      assert.equal(canAccessFeature("discovery", "FREE"), false);
    });

    it("ai-queries includes QUERY_PACK + PRO; ai-strategies/learning are premium-tier only", () => {
      assert.ok(FEATURE_ACCESS["ai-queries"].includes("QUERY_PACK"));
      assert.ok(FEATURE_ACCESS["ai-queries"].includes("PRO"));
      assert.deepEqual(FEATURE_ACCESS["ai-strategies"], [
        "PREMIUM",
        "ULTIMATE",
      ]);
      assert.deepEqual(FEATURE_ACCESS["ai-learning"], ["PREMIUM", "ULTIMATE"]);
    });

    it("PRO accesses discovery + ai-queries but NOT ai-strategies", () => {
      assert.equal(canAccessFeature("discovery", "PRO"), true);
      assert.equal(canAccessFeature("ai-queries", "PRO"), true);
      assert.equal(canAccessFeature("ai-strategies", "PRO"), false);
    });

    it("PREMIUM accesses the premium-tier features", () => {
      assert.equal(canAccessFeature("ai-strategies", "PREMIUM"), true);
      assert.equal(canAccessFeature("ai-learning", "PREMIUM"), true);
      assert.equal(canAccessFeature("ai-analysis", "PREMIUM"), true);
    });

    it("unknown / empty feature -> false (fail closed)", () => {
      assert.equal(canAccessFeature("nonexistent", "PRO"), false);
      assert.equal(canAccessFeature("", "PRO"), false);
    });
  });

  // ── getDefaultSubscription ───────────────────────────────────────

  describe("getDefaultSubscription (real)", () => {
    it("returns a FREE/active subscription with zeroed usage and empty addons", () => {
      const sub = getDefaultSubscription();
      assert.equal(sub.planId, "FREE");
      assert.equal(sub.status, "active");
      assert.equal(sub.aiQueriesUsed, 0);
      assert.equal(sub.aiQueriesLimit, 0);
      assert.deepEqual(sub.addons, []);
      assert.equal(sub.endDate, undefined);
    });

    it("startDate is a valid ISO string", () => {
      const sub = getDefaultSubscription();
      assert.equal(typeof sub.startDate, "string");
      assert.ok(!Number.isNaN(Date.parse(sub.startDate)));
    });

    it("returns a fresh object each call (no shared mutable state)", () => {
      const a = getDefaultSubscription();
      const b = getDefaultSubscription();
      assert.notStrictEqual(a, b);
      assert.notStrictEqual(a.addons, b.addons);
    });
  });
});
