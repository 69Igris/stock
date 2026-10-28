/**
 * MONEY-1074 — dashboard TODAY / TOTAL RETURN + MF NAV patch (REAL exports).
 *
 * Drives the shipped pure helpers directly (no shadow):
 *   - calculatePortfolioPnLPercentage: MF now counts toward TOTAL RETURN (the
 *     QA "MF portfolio shows 0%" regression).
 *   - calculateTodaysChange: TODAY = holdings dayChange + realized (the QA
 *     "no change in return after the day ended" regression).
 *   - buildMfNavPatch: the per-row NAV-propagation decision (skip-not-zero +
 *     idempotent fixpoint) the nightly job applies.
 *
 * Source: packages/services/src/dashboard-logic.ts + mutualfunds-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  calculatePortfolioPnLPercentage,
  calculateTodaysChange,
} from "../src/dashboard-logic";
import { buildMfNavPatch } from "../src/mutualfunds-logic";

describe("calculatePortfolioPnLPercentage (MONEY-1074)", () => {
  it("counts MF gains for an MF-only portfolio (the QA 0% regression)", () => {
    // No holdings, ₹2000 MF gain on ₹10000 invested → 20%.
    assert.strictEqual(
      calculatePortfolioPnLPercentage(0, 0, 2000, 10000),
      "20.00",
    );
  });

  it("matches the old holdings-only result when there is no MF", () => {
    assert.strictEqual(
      calculatePortfolioPnLPercentage(1000, 10000, 0, 0),
      "10.00",
    );
  });

  it("blends holdings + MF over the combined invested base", () => {
    // (1000 + 500) / (10000 + 5000) = 1500/15000 = 10%.
    assert.strictEqual(
      calculatePortfolioPnLPercentage(1000, 10000, 500, 5000),
      "10.00",
    );
  });

  it("returns '0' (never 'NaN') when combined invested is not positive", () => {
    assert.strictEqual(calculatePortfolioPnLPercentage(500, 0, 0, 0), "0");
    assert.strictEqual(calculatePortfolioPnLPercentage(500, -100, 0, -50), "0");
  });

  it("finite-guards each arg so a corrupt MF row can't poison the ratio", () => {
    // Infinity mfPnL + NaN mfInvested collapse to 0 → holdings-only 10%.
    const pct = calculatePortfolioPnLPercentage(1000, 10000, Infinity, NaN);
    assert.strictEqual(pct, "10.00");
    assert.strictEqual(pct.includes("NaN"), false);
  });
});

describe("calculateTodaysChange (MONEY-1074)", () => {
  it("sums holdings dayChange + today's realized P&L", () => {
    const holdings = [{ dayChange: 120 }, { dayChange: -30 }];
    assert.strictEqual(calculateTodaysChange(holdings, 50), 140); // 120-30+50
  });

  it("treats null/undefined/NaN/Infinity dayChange as 0", () => {
    const holdings = [
      { dayChange: null },
      { dayChange: undefined },
      { dayChange: NaN },
      { dayChange: Infinity },
      { dayChange: 25 },
    ];
    assert.strictEqual(calculateTodaysChange(holdings, 0), 25);
  });

  it("is 0 for an empty book with no realized (never NaN)", () => {
    const v = calculateTodaysChange([], 0);
    assert.strictEqual(v, 0);
    assert.strictEqual(Number.isFinite(v), true);
  });

  it("finite-guards a non-finite realized component", () => {
    assert.strictEqual(calculateTodaysChange([{ dayChange: 10 }], NaN), 10);
  });
});

describe("buildMfNavPatch (MONEY-1074)", () => {
  const fund = {
    units: 100,
    investedAmount: 10000,
    investedValue: null,
    currentNav: 100, // stale: currentValue 10000
    currentValue: 10000,
  };
  const navDate = new Date("2026-07-18T00:00:00Z");

  it("produces a patch when the master NAV moved", () => {
    const patch = buildMfNavPatch(fund, 120, navDate);
    assert.notStrictEqual(patch, null);
    assert.strictEqual(patch!.currentNav, 120);
    assert.strictEqual(patch!.currentValue, 12000); // 100 * 120
    assert.strictEqual(patch!.unrealizedGain, 2000); // 12000 - 10000
    assert.strictEqual(patch!.lastNavDate, navDate);
  });

  it("SKIPS (never zeroes) on a missing / non-positive / non-finite master NAV", () => {
    for (const bad of [null, undefined, 0, -1, NaN, Infinity]) {
      assert.strictEqual(
        buildMfNavPatch(fund, bad as number | null, navDate),
        null,
        `nav ${String(bad)} should skip`,
      );
    }
  });

  it("SKIPS when units are non-finite", () => {
    assert.strictEqual(
      buildMfNavPatch({ ...fund, units: NaN }, 120, navDate),
      null,
    );
  });

  it("is an idempotent FIXPOINT: re-applying a fresh row is a no-op", () => {
    const first = buildMfNavPatch(fund, 120, navDate);
    assert.notStrictEqual(first, null);
    // Row now reflects the patch; a second run at the same NAV must skip.
    const propagated = {
      ...fund,
      currentNav: first!.currentNav,
      currentValue: first!.currentValue,
    };
    assert.strictEqual(buildMfNavPatch(propagated, 120, navDate), null);
  });

  it("uses the investedAmount||investedValue||0 fallback chain", () => {
    // investedAmount 0 falls through to investedValue 8000.
    const f = {
      units: 100,
      investedAmount: 0,
      investedValue: 8000,
      currentNav: 50,
      currentValue: 5000,
    };
    const patch = buildMfNavPatch(f, 120, navDate);
    assert.strictEqual(patch!.unrealizedGain, 4000); // 12000 - 8000
  });
});
