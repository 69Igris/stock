/**
 * Fund Composition — real-source tests.
 *
 * NOTE: the previous version re-implemented `toActionData` + a
 * `determineGetFlow` / `buildGetResponse` flow inline. None of that exists in
 * the action anymore: `apps/web/lib/actions/fund-composition.ts` is now a thin
 * wrapper over `@usemoney/services`, and ALL the composition math
 * (weights, coverage, sort, div-by-zero / non-finite guards) lives in
 * `packages/services/src/fund-composition-logic.ts` — the LIVE path the
 * service derives its cached `FundCompositionData` from.
 *
 * This file imports those REAL exports and asserts the actual non-finite /
 * div-by-zero / wrong-order-sort contract (the bug class that turns one
 * corrupt holding into a "NaN%" badge / Infinity pie slice / a NaN-ranked #1
 * holding). No inline re-implementation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  finite,
  round2,
  totalFundValue,
  weightFromValue,
  weightsFromValues,
  sanitizeAndSortHoldings,
  topNHoldings,
  coveragePercent,
  reconcilesTo100,
  normalizeWeightsTo100,
  type CompositionHolding,
  type ValuedHolding,
} from "../../../../packages/services/src/fund-composition-logic";

function holding(
  overrides: Partial<CompositionHolding> = {}
): CompositionHolding {
  return {
    holdingName: "Reliance Industries Ltd",
    holdingSymbol: "RELIANCE",
    isin: "INE002A01018",
    holdingType: "EQUITY",
    sector: "Energy",
    industry: "Refineries",
    marketCap: "Large Cap",
    weightPercent: 10,
    ...overrides,
  };
}

describe("Fund Composition (real source)", () => {
  // ── finite / round2 ─────────────────────────────────────────────────

  describe("finite", () => {
    it("passes a finite number through", () => {
      assert.strictEqual(finite(12.5), 12.5);
      assert.strictEqual(finite(0), 0);
    });

    it("collapses null/undefined/NaN/±Infinity to the fallback", () => {
      assert.strictEqual(finite(null), 0);
      assert.strictEqual(finite(undefined), 0);
      assert.strictEqual(finite(NaN), 0);
      assert.strictEqual(finite(Infinity), 0);
      assert.strictEqual(finite(-Infinity), 0);
      assert.strictEqual(finite(NaN, 5), 5);
    });
  });

  describe("round2", () => {
    it("rounds to 2 dp and neutralizes non-finite", () => {
      assert.strictEqual(round2(33.3333), 33.33);
      assert.strictEqual(round2(NaN), 0);
    });
  });

  // ── totalFundValue: poison-proof denominator ────────────────────────

  describe("totalFundValue", () => {
    it("sums finite values", () => {
      const hs: ValuedHolding[] = [
        { key: "A", value: 100 },
        { key: "B", value: 250 },
      ];
      assert.strictEqual(totalFundValue(hs), 350);
    });

    it("neutralizes a single NaN/Infinity addend (no poisoned total)", () => {
      const hs: ValuedHolding[] = [
        { key: "A", value: 100 },
        { key: "B", value: NaN },
        { key: "C", value: Infinity },
      ];
      assert.strictEqual(totalFundValue(hs), 100);
    });

    it("returns 0 for a non-array", () => {
      assert.strictEqual(totalFundValue(null as unknown as ValuedHolding[]), 0);
    });
  });

  // ── weightFromValue: the div-by-zero guard ──────────────────────────

  describe("weightFromValue", () => {
    it("computes value / total * 100", () => {
      assert.strictEqual(weightFromValue(25, 100), 25);
    });

    it("returns 0 when total is 0 (div-by-zero → no Infinity)", () => {
      assert.strictEqual(weightFromValue(25, 0), 0);
    });

    it("returns 0 when total is non-finite", () => {
      assert.strictEqual(weightFromValue(25, NaN), 0);
      assert.strictEqual(weightFromValue(25, Infinity), 0);
    });

    it("returns 0 when the value itself is non-finite", () => {
      assert.strictEqual(weightFromValue(NaN, 100), 0);
    });
  });

  describe("weightsFromValues", () => {
    it("derives finite weights against a single computed total", () => {
      const hs: ValuedHolding[] = [
        { key: "A", value: 30 },
        { key: "B", value: 70 },
      ];
      const out = weightsFromValues(hs);
      assert.deepStrictEqual(out, [
        { key: "A", weightPercent: 30 },
        { key: "B", weightPercent: 70 },
      ]);
    });

    it("an all-zero fund produces all-zero weights (never NaN)", () => {
      const hs: ValuedHolding[] = [
        { key: "A", value: 0 },
        { key: "B", value: 0 },
      ];
      const out = weightsFromValues(hs);
      assert.ok(out.every((h) => h.weightPercent === 0));
    });
  });

  // ── sanitizeAndSortHoldings: wrong-order sort guard ─────────────────

  describe("sanitizeAndSortHoldings", () => {
    it("sorts by weight DESC", () => {
      const out = sanitizeAndSortHoldings([
        holding({ holdingName: "Small", weightPercent: 5 }),
        holding({ holdingName: "Big", weightPercent: 40 }),
        holding({ holdingName: "Mid", weightPercent: 20 }),
      ]);
      assert.deepStrictEqual(
        out.map((h) => h.holdingName),
        ["Big", "Mid", "Small"]
      );
    });

    it("ranks a NaN/Infinity weight LAST, not as the #1 holding", () => {
      const out = sanitizeAndSortHoldings([
        holding({ holdingName: "Corrupt", weightPercent: NaN }),
        holding({ holdingName: "Real", weightPercent: 30 }),
      ]);
      assert.strictEqual(out[0]!.holdingName, "Real");
      assert.strictEqual(out[0]!.weightPercent, 30);
      // The corrupt weight was neutralized to 0 and ranked last.
      assert.strictEqual(out[1]!.holdingName, "Corrupt");
      assert.strictEqual(out[1]!.weightPercent, 0);
    });

    it("breaks weight ties by holdingName ascending (deterministic)", () => {
      const out = sanitizeAndSortHoldings([
        holding({ holdingName: "Zeta", weightPercent: 10 }),
        holding({ holdingName: "Alpha", weightPercent: 10 }),
      ]);
      assert.deepStrictEqual(
        out.map((h) => h.holdingName),
        ["Alpha", "Zeta"]
      );
    });
  });

  describe("topNHoldings", () => {
    it("returns the top N by weight", () => {
      const hs = [
        holding({ holdingName: "A", weightPercent: 5 }),
        holding({ holdingName: "B", weightPercent: 40 }),
        holding({ holdingName: "C", weightPercent: 20 }),
      ];
      const out = topNHoldings(hs, 2);
      assert.deepStrictEqual(
        out.map((h) => h.holdingName),
        ["B", "C"]
      );
    });

    it("returns [] for a non-positive / non-finite n", () => {
      const hs = [holding()];
      assert.strictEqual(topNHoldings(hs, 0).length, 0);
      assert.strictEqual(topNHoldings(hs, NaN).length, 0);
    });
  });

  // ── coverage + reconciliation ───────────────────────────────────────

  describe("coveragePercent", () => {
    it("sums weights finite-safely", () => {
      const hs = [
        holding({ weightPercent: 30 }),
        holding({ weightPercent: 45.5 }),
      ];
      assert.strictEqual(coveragePercent(hs), 75.5);
    });

    it("one corrupt weight does not poison the coverage total", () => {
      const hs = [
        holding({ weightPercent: 60 }),
        holding({ weightPercent: Infinity }),
      ];
      assert.strictEqual(coveragePercent(hs), 60);
    });
  });

  describe("reconcilesTo100", () => {
    it("is true within the default tolerance", () => {
      assert.strictEqual(reconcilesTo100(99.7), true);
      assert.strictEqual(reconcilesTo100(100.4), true);
    });

    it("is false outside tolerance and for non-finite totals", () => {
      assert.strictEqual(reconcilesTo100(80), false);
      assert.strictEqual(reconcilesTo100(NaN), false);
      assert.strictEqual(reconcilesTo100(Infinity), false);
    });
  });

  describe("normalizeWeightsTo100", () => {
    it("rescales slices to sum to 100", () => {
      const out = normalizeWeightsTo100([{ weight: 30 }, { weight: 10 }]);
      const sum = out.reduce((s, x) => s + x.weight, 0);
      assert.ok(Math.abs(sum - 100) < 1e-9);
    });

    it("an all-zero input returns all-zero (no ÷0 NaN/Infinity)", () => {
      const out = normalizeWeightsTo100([{ weight: 0 }, { weight: 0 }]);
      assert.ok(out.every((s) => s.weight === 0));
    });
  });
});
