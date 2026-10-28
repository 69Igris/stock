/**
 * Stock Detail Formatter Tests
 *
 * Tests for the formatting utility functions used in the
 * stock detail page client component (formatNumber, formatVolume, formatMarketCap).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed: import the REAL formatters from the page's logic module
// (extracted from stock/[symbol]/client.tsx). The placeholder for nullish
// input is the em-dash "—" (U+2014), matching the page's convention — the
// old inline copy used an ASCII "-", which had drifted from source.
import {
  formatNumber,
  formatVolume,
  formatMarketCap,
  formatMarketCapCrores,
} from "@/app/stock/[symbol]/stock-format";

const DASH = "—"; // U+2014 em-dash, the real placeholder

// ── Tests ────────────────────────────────────────────────────────

describe("Stock Detail Formatters", () => {
  describe("formatNumber", () => {
    it("should format number with 2 decimal places by default", () => {
      const result = formatNumber(2500);
      assert.ok(result.includes("2,500.00") || result.includes("2500.00"));
    });

    it("should format with custom decimal places", () => {
      const result = formatNumber(2500.5, 1);
      assert.ok(result.includes("2,500.5") || result.includes("2500.5"));
    });

    it("should return dash for undefined", () => {
      assert.strictEqual(formatNumber(undefined), DASH);
    });

    it("should return dash for null", () => {
      assert.strictEqual(formatNumber(null), DASH);
    });

    it("should format zero", () => {
      const result = formatNumber(0);
      assert.ok(result.includes("0.00"));
    });

    it("should format negative numbers", () => {
      const result = formatNumber(-50.5);
      assert.ok(result.includes("50.50"));
    });

    it("should format large numbers with commas (en-IN locale)", () => {
      const result = formatNumber(1234567.89);
      // en-IN uses lakh/crore grouping: 12,34,567.89
      assert.ok(result.includes("567.89"));
    });
  });

  describe("formatVolume", () => {
    it("should return dash for undefined", () => {
      assert.strictEqual(formatVolume(undefined), DASH);
    });

    it("should return dash for null", () => {
      assert.strictEqual(formatVolume(null), DASH);
    });

    it("should return dash for 0", () => {
      assert.strictEqual(formatVolume(0), DASH);
    });

    it("should format in Crores for >= 10M", () => {
      assert.strictEqual(formatVolume(50_000_000), "5.0 Cr");
    });

    it("should format in Crores for exactly 10M", () => {
      assert.strictEqual(formatVolume(10_000_000), "1.0 Cr");
    });

    it("should format in Lakhs for >= 100K", () => {
      assert.strictEqual(formatVolume(500_000), "5.0 L");
    });

    it("should format in Lakhs for exactly 100K", () => {
      assert.strictEqual(formatVolume(100_000), "1.0 L");
    });

    it("should format in Thousands for >= 1K", () => {
      assert.strictEqual(formatVolume(5_000), "5.0 K");
    });

    it("should format in Thousands for exactly 1K", () => {
      assert.strictEqual(formatVolume(1_000), "1.0 K");
    });

    it("should return raw number for < 1K", () => {
      assert.strictEqual(formatVolume(500), "500");
    });

    it("should return raw number for 1", () => {
      assert.strictEqual(formatVolume(1), "1");
    });

    it("should format large crore values", () => {
      assert.strictEqual(formatVolume(150_000_000), "15.0 Cr");
    });
  });

  /**
   * MONEY-1148 — this block used to PIN THE BUG.
   *
   * `formatMarketCap` takes RUPEES and carried its own T/B tier ladder. Both
   * rungs were wrong, and every assertion here asserted the wrong output, two
   * of them with a comment ("B unit = 1000 Crore = 10 billion") rationalising
   * the error into a convention. That is what let it survive: the suite was
   * green, so the numbers looked reviewed.
   *
   *   - "B" divided by 1e10 while labelling billions -> Hawkins' ₹4,300 Cr
   *     (= ₹43 B) rendered "₹4 B", understated 10x.
   *   - TWO trillion rungs, `>=1e13` over 1e13 and `>=1e12` over 1e12, made the
   *     output NON-MONOTONIC: crossing ₹10 T dropped the displayed number from
   *     "₹9.90 T" to "₹1.00 T", and Reliance's ₹17.5 trillion read "₹1.75 T".
   *
   * D-b: the product renders Indian crores, not B/T. So the function now
   * converts rupees to crores and delegates to `formatMarketCapCrores` — there
   * is ONE tier ladder in the module, because the duplicate ladder is what
   * drifted. The assertions below are the REAL correct values, not the old
   * output re-pinned.
   */
  describe("formatMarketCap", () => {
    it("should return dash for undefined", () => {
      assert.strictEqual(formatMarketCap(undefined), DASH);
    });

    it("should return dash for null", () => {
      assert.strictEqual(formatMarketCap(null), DASH);
    });

    it("should return dash for 0", () => {
      assert.strictEqual(formatMarketCap(0), DASH);
    });

    it("should return dash for non-finite input", () => {
      // `!marketCap` alone never caught these; the delegate does.
      assert.strictEqual(formatMarketCap(NaN), DASH);
      assert.strictEqual(formatMarketCap(Infinity), DASH);
    });

    it("[regression] Hawkins ₹4,300 Cr is not understated 10x", () => {
      // The reported case. ₹43,00,00,00,000 = ₹4,300 Cr = ₹43 B.
      // Before MONEY-1148 this rendered "₹4 B" — off by an order of magnitude
      // AND in a unit the target user does not read market cap in.
      const result = formatMarketCap(43_000_000_000);
      assert.strictEqual(result, "₹4,300 Cr");
      assert.doesNotMatch(result, /\bB\b/, "B/T units were retired by D-b");
    });

    it("[regression] Reliance ₹17.5 lakh crore is not shown as ₹1.75 T", () => {
      const result = formatMarketCap(17_500_000_000_000);
      assert.strictEqual(result, "₹17.50 L Cr");
      assert.doesNotMatch(
        result,
        /1\.75/,
        "the old double-trillion rung divided 1e13 by 1e13 and lost a decade"
      );
    });

    it("switches to lakh-crore at ₹1,00,000 Cr", () => {
      // 1e12 rupees = 1,00,000 Cr, exactly the boundary.
      assert.strictEqual(formatMarketCap(1_000_000_000_000), "₹1.00 L Cr");
      // One rupee under the boundary stays in crores.
      assert.strictEqual(formatMarketCap(999_999_999_999), "₹1,00,000 Cr");
      assert.strictEqual(formatMarketCap(17_000_000_000_000), "₹17.00 L Cr");
      assert.strictEqual(formatMarketCap(5_000_000_000_000), "₹5.00 L Cr");
    });

    it("formats mid and small caps in plain crores", () => {
      assert.strictEqual(formatMarketCap(50_000_000_000), "₹5,000 Cr");
      assert.strictEqual(formatMarketCap(10_000_000_000), "₹1,000 Cr");
      assert.strictEqual(formatMarketCap(500_000_000), "₹50 Cr");
      assert.strictEqual(formatMarketCap(100_000_000), "₹10 Cr");
    });

    /**
     * THE assertion that would have caught the T-tier bug, and the reason it is
     * a sweep rather than a pair of literals: the defect was invisible at every
     * individual value: "₹9.90 T" and "₹1.00 T" are each a plausible string.
     * It was only visible in the RELATION between two adjacent inputs.
     */
    it("[regression] is MONOTONIC — a bigger company never renders smaller", () => {
      const magnitude = (rendered: string): number => {
        assert.notStrictEqual(rendered, DASH, "sweep fed a value that dashed");
        const m = /^₹([\d,.]+)\s*(L Cr|Cr)$/.exec(rendered);
        assert.ok(m, `unrecognised unit in "${rendered}" — new tier untested`);
        const n = Number(m[1]!.replace(/,/g, ""));
        assert.ok(Number.isFinite(n), `unparseable figure in "${rendered}"`);
        return m[2] === "L Cr" ? n * 100_000 : n;
      };

      // Dense enough to straddle every boundary, including the old 1e13 cliff.
      let prevIn = 1_000_000;
      let prevOut = magnitude(formatMarketCap(prevIn));
      for (let e = 6.02; e <= 15; e += 0.02) {
        const input = Math.pow(10, e);
        const out = magnitude(formatMarketCap(input));
        assert.ok(
          out >= prevOut,
          `NON-MONOTONIC: ${prevIn} -> ${formatMarketCap(prevIn)} but ` +
            `${input} -> ${formatMarketCap(input)} (a LARGER company rendered ` +
            `SMALLER). This is exactly the ₹10 T cliff of MONEY-1148.`
        );
        prevIn = input;
        prevOut = out;
      }
    });

    it("[regression] the ₹10 T cliff itself, as literals", () => {
      // The specific pair the old ladder inverted, pinned by value so the
      // failure message names the bug rather than an index in a sweep.
      assert.strictEqual(formatMarketCap(9_900_000_000_000), "₹9.90 L Cr");
      assert.strictEqual(formatMarketCap(10_100_000_000_000), "₹10.10 L Cr");
    });

    it("agrees with the crores formatter once the unit is converted", () => {
      // The anti-divergence guard. These are ONE ladder now; if this ever
      // fails, a second tier implementation has been reintroduced.
      for (const crores of [1, 50, 4_300, 28_023, 99_999, 100_000, 1_750_000]) {
        assert.strictEqual(
          formatMarketCap(crores * 10_000_000),
          formatMarketCapCrores(crores),
          `rupees and crores paths disagree at ${crores} Cr`
        );
      }
    });
  });

  /**
   * MONEY-1144 — the CRORES-denominated twin.
   *
   * Two DB columns are both called `marketCap` and are in different units:
   * `LatestQuote.marketCap` is rupees (Yahoo), `StockRatios.marketCap` is
   * crores (Tickertape). The Fundamentals card was passing the crores value to
   * the rupees formatter, which divided by 1e7 a second time and rendered every
   * mid-cap in the universe as a confident "₹0 Cr" — not an empty state, an
   * actual wrong number, which is why nothing looked broken.
   */
  describe("formatMarketCapCrores", () => {
    it("[regression] a mid-cap in crores does NOT collapse to ₹0", () => {
      // The reported case: Strides Pharma, ~₹14,127 Cr.
      const result = formatMarketCapCrores(14_127);
      assert.strictEqual(result, "₹14,127 Cr");
      assert.doesNotMatch(
        result,
        /₹0\b/,
        "a real mid-cap must never render as ₹0 — that is the bug this pins"
      );
    });

    it("[regression] disagrees with the rupees formatter, and must", () => {
      // If these two ever return the same string for the same input, one of
      // them has been 'unified' with the other and the unit bug is back.
      assert.notStrictEqual(
        formatMarketCapCrores(14_127),
        formatMarketCap(14_127),
        "the crores and rupees formatters interpret the same number " +
          "differently by design; identical output means the distinction was lost"
      );
    });

    it("switches to lakh-crore past 1,00,000 Cr", () => {
      // Reliance territory: ₹17.5 lakh crore.
      assert.strictEqual(formatMarketCapCrores(1_750_000), "₹17.50 L Cr");
      // Boundary.
      assert.strictEqual(formatMarketCapCrores(100_000), "₹1.00 L Cr");
      assert.strictEqual(formatMarketCapCrores(99_999), "₹99,999 Cr");
    });

    it("groups in the Indian convention, not thousands", () => {
      // en-IN: 1,23,456 — not 123,456.
      assert.strictEqual(formatMarketCapCrores(123_456 / 10), "₹12,346 Cr");
      assert.strictEqual(formatMarketCapCrores(50_000), "₹50,000 Cr");
    });

    it("returns the em-dash for nullish, zero and non-finite input", () => {
      assert.strictEqual(formatMarketCapCrores(undefined), DASH);
      assert.strictEqual(formatMarketCapCrores(null), DASH);
      assert.strictEqual(formatMarketCapCrores(0), DASH);
      assert.strictEqual(formatMarketCapCrores(NaN), DASH);
      assert.strictEqual(formatMarketCapCrores(Infinity), DASH);
    });

    it("handles a genuinely tiny micro-cap without rounding to zero text", () => {
      assert.strictEqual(formatMarketCapCrores(1), "₹1 Cr");
    });
  });
});
