/**
 * Mutual Funds Actions — REAL-export tests (MONEY-620 de-shadow).
 *
 * This file PREVIOUSLY re-declared the mutual-fund summary math
 * (`calculateSummary`), the filter logic (`filterMutualFunds`), the delete
 * broker-gate (`canDeleteFund`) AND the demo dataset inline, then asserted those
 * copies — a textbook shadow (it was green while the real service summed raw,
 * unguarded fields and could render "₹NaN" / "NaN%").
 *
 * It now:
 *   - imports the REAL summary aggregator `calculateMfSummary`, the REAL
 *     userId-scoped where-builder `buildMutualFundWhere`, and the REAL per-fund
 *     return-% `computeMfReturnPct` from the service-layer logic module that
 *     `packages/services/src/mutualfunds.service.ts#getMutualFunds` actually
 *     calls in production (relative path — services is ESM, this CJS suite can't
 *     hit the barrel without the recording-prisma seam used by
 *     `mutualfunds-data-e2e.test.ts`);
 *   - imports the REAL `demoMutualFunds` dataset from `@/lib/demo/data` instead
 *     of a hand-maintained copy, so a change to the demo book is reflected here.
 *
 * The delete broker-gate and the userId-scope of the real `deleteMutualFund` /
 * `getMutualFunds` service functions are exercised end-to-end (driving the LIVE
 * fns through a recording prisma) in `__tests__/services/mutualfunds-data-e2e.test.ts`.
 *
 * Source: packages/services/src/mutualfunds-logic.ts + apps/web/lib/demo/data.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  calculateMfSummary,
  buildMutualFundWhere,
  computeMfReturnPct,
} from "../../../../packages/services/src/mutualfunds-logic";
import { demoMutualFunds } from "@/lib/demo/data";

// The demo book element shape (subset we assert on).
interface DemoMf {
  id: string;
  userId: string;
  schemeName: string;
  category: string;
  units: number;
  investedAmount: number;
  currentValue: number;
  unrealizedGain: number;
  sipActive: boolean;
  sipAmount: number | null;
  sipDate: number | null;
  broker: string;
  brokerName: string;
}

const demo = demoMutualFunds as unknown as DemoMf[];

describe("Mutual Funds Actions — real exports (de-shadowed)", () => {
  // -- Demo dataset sanity (now the REAL exported demo data) --

  describe("demoMutualFunds dataset", () => {
    it("is a non-empty list all owned by the demo user", () => {
      assert.ok(demo.length >= 3);
      for (const f of demo) assert.strictEqual(f.userId, "demo");
    });

    it("has unique IDs", () => {
      const ids = new Set(demo.map((f) => f.id));
      assert.strictEqual(ids.size, demo.length);
    });

    it("every demo fund has a finite invested/current/gain (no UI '₹NaN')", () => {
      for (const f of demo) {
        assert.ok(Number.isFinite(f.investedAmount), `${f.id} investedAmount`);
        assert.ok(Number.isFinite(f.currentValue), `${f.id} currentValue`);
        assert.ok(Number.isFinite(f.unrealizedGain), `${f.id} unrealizedGain`);
      }
    });
  });

  // -- buildMutualFundWhere: the filter/scope contract the demo branch mirrors --

  describe("buildMutualFundWhere — filter + scope contract (real export)", () => {
    it("scopes to userId and adds a case-insensitive scheme contains for search", () => {
      const where = buildMutualFundWhere("demo-user", { search: "hdfc" });
      assert.strictEqual(where.userId, "demo-user");
      assert.deepStrictEqual(where.schemeName, {
        contains: "hdfc",
        mode: "insensitive",
      });
    });

    it("ignores the 'all' sentinel and an empty search (no filter)", () => {
      const where = buildMutualFundWhere("demo-user", {
        search: "",
        category: "all",
      });
      assert.strictEqual(where.schemeName, undefined);
      assert.strictEqual(where.category, undefined);
      assert.strictEqual(where.userId, "demo-user");
    });

    it("applies a concrete category filter", () => {
      assert.strictEqual(
        buildMutualFundWhere("demo-user", { category: "Flexi Cap" }).category,
        "Flexi Cap"
      );
    });
  });

  // -- calculateMfSummary: the REAL summary the service returns --

  describe("calculateMfSummary over the demo book (real export)", () => {
    it("sums invested/current/PnL across the whole demo book", () => {
      const s = calculateMfSummary(demo);
      const inv = demo.reduce((a, f) => a + f.investedAmount, 0);
      const cur = demo.reduce((a, f) => a + f.currentValue, 0);
      const pnl = demo.reduce((a, f) => a + f.unrealizedGain, 0);
      assert.ok(Math.abs(s.totalInvested - inv) < 0.01);
      assert.ok(Math.abs(s.totalCurrent - cur) < 0.01);
      assert.ok(Math.abs(s.totalPnL - pnl) < 0.01);
    });

    it("emits a parseable 2-decimal percentage string for the demo book", () => {
      const s = calculateMfSummary(demo);
      assert.ok(s.pnlPercentage.includes("."));
      assert.strictEqual(s.pnlPercentage.split(".")[1]!.length, 2);
      assert.ok(Number.isFinite(Number(s.pnlPercentage)));
    });

    it("empty book → all-zero, '0' pct (no divide-by-zero)", () => {
      assert.deepStrictEqual(calculateMfSummary([]), {
        totalInvested: 0,
        totalCurrent: 0,
        totalPnL: 0,
        pnlPercentage: "0",
      });
    });

    it("single fund → exact totals and 2dp pct", () => {
      const s = calculateMfSummary([
        { investedAmount: 10000, currentValue: 11000, unrealizedGain: 1000 },
      ]);
      assert.strictEqual(s.totalInvested, 10000);
      assert.strictEqual(s.totalPnL, 1000);
      assert.strictEqual(s.pnlPercentage, "10.00");
    });

    it("negative P&L → negative 2dp pct", () => {
      const s = calculateMfSummary([
        { investedAmount: 10000, currentValue: 9000, unrealizedGain: -1000 },
      ]);
      assert.strictEqual(s.totalPnL, -1000);
      assert.strictEqual(s.pnlPercentage, "-10.00");
    });

    it("sums correctly across a category-filtered subset", () => {
      const flexi = demo.filter((f) => f.category === "Flexi Cap");
      const s = calculateMfSummary(flexi);
      const inv = flexi.reduce((a, f) => a + f.investedAmount, 0);
      assert.ok(Math.abs(s.totalInvested - inv) < 0.01);
    });
  });

  // -- computeMfReturnPct: per-fund return % used by the holdings row --

  describe("computeMfReturnPct — per-fund return % (real export)", () => {
    it("matches gain/invested*100 for each demo fund and stays finite", () => {
      for (const f of demo) {
        const pct = computeMfReturnPct(f.unrealizedGain, f.investedAmount);
        assert.ok(Number.isFinite(pct), `${f.id} pct finite`);
        if (f.investedAmount > 0) {
          const expected = (f.unrealizedGain / f.investedAmount) * 100;
          assert.ok(Math.abs(pct - expected) < 1e-9);
        }
      }
    });

    it("clamps a zero/negative invested to 0 (no Infinity/sign-flip into the row)", () => {
      assert.strictEqual(computeMfReturnPct(500, 0), 0);
      assert.strictEqual(computeMfReturnPct(500, -100), 0);
    });
  });

  // -- SIP data (still asserted against the real demo book) --

  describe("SIP data in the demo book", () => {
    it("partitions active vs inactive SIPs, with null amount/date for inactive", () => {
      const active = demo.filter((f) => f.sipActive);
      const inactive = demo.filter((f) => !f.sipActive);
      assert.ok(active.length >= 1);
      for (const f of inactive) {
        assert.strictEqual(f.sipAmount, null);
        assert.strictEqual(f.sipDate, null);
      }
    });
  });
});
