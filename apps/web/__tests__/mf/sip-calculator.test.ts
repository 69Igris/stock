/**
 * SIP calculator math (MONEY-245).
 *
 * The widget itself is React; the underlying formula is pure and lives in
 * `computeSipFutureValue`. We test against canonical SIP outcomes:
 *
 *   ₹10,000/mo · 10 years · 12% annual → ~₹23.0 L estimated value
 *                                        ~₹12 L invested,
 *                                        ~₹11.0 L gain
 *
 * Reference — ordinary annuity, end-of-month contributions:
 *   FV = P × ((1+r)^n − 1) / r
 *
 * MONEY-1162 dropped the trailing `× (1+r)` (annuity-due) so every SIP surface
 * matches SEBI's investor calculator, and `computeSipFutureValue` no longer
 * restates the formula at all — it delegates to `calcSip` in
 * `@usemoney/core/calc`. The final case below pins that delegation, so this
 * widget can never quietly disagree with `/calculators` again.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// Import the pure math from the CSS-free `sip-math` module. The
// `SipCalculator.tsx` component re-imports these same helpers and renders
// identically; we test the math here so node:test isn't asked to parse the
// component's `./detail-playful.css` side-effect import.
import {
  computeSipFutureValue,
  computeLumpsumFutureValue,
} from "../../components/mf/sip-math";
import { calcSip } from "@usemoney/core/calc";

function approx(actual: number, expected: number, tolerance: number) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ~${expected} (±${tolerance}), got ${actual}`
  );
}

describe("SipCalculator math", () => {
  it("₹10k · 10y · 12% → ~₹23.00 L FV / ₹12 L invested", () => {
    const r = computeSipFutureValue(10_000, 10, 12);
    assert.equal(r.invested, 1_200_000);
    approx(r.estimatedValue, 2_300_387, 5_000); // ±₹5k tolerance
    approx(r.gain, 1_100_387, 5_000);
  });

  it("₹5k · 20y · 10% → ~₹37.97 L FV / ₹12 L invested", () => {
    const r = computeSipFutureValue(5_000, 20, 10);
    assert.equal(r.invested, 1_200_000);
    approx(r.estimatedValue, 3_796_844, 5_000);
  });

  it("zero return collapses to a straight sum", () => {
    const r = computeSipFutureValue(10_000, 5, 0);
    assert.equal(r.invested, 600_000);
    assert.equal(r.estimatedValue, 600_000);
    assert.equal(r.gain, 0);
  });

  it("invested = monthly × 12 × years exactly", () => {
    const r = computeSipFutureValue(7_500, 8, 14);
    assert.equal(r.invested, 7_500 * 12 * 8);
  });

  it("estimatedValue ≥ invested when return is non-negative", () => {
    const r = computeSipFutureValue(20_000, 15, 9);
    assert.ok(r.estimatedValue >= r.invested);
    assert.ok(r.gain >= 0);
  });

  it("rounds the year input to whole months (1.5y → 18 payments)", () => {
    const a = computeSipFutureValue(10_000, 1.5, 12);
    const b = computeSipFutureValue(10_000, 18 / 12, 12);
    approx(a.estimatedValue, b.estimatedValue, 1);
  });

  // MONEY-1162 anti-drift. This module used to restate the SIP formula, so
  // /calculators and the fund/ETF detail pages could quote different numbers
  // for identical inputs — and did, the moment /calculators moved to SEBI's
  // convention. It now delegates to the shared primitive, so assert the two
  // agree EXACTLY. An approximate check here would let the copies drift again.
  it("delegates to @usemoney/core calcSip (no second source of truth)", () => {
    const cases = [
      [10_000, 10, 12],
      [5_000, 20, 10],
      [2_500, 7, 8.5],
    ] as const;

    for (const [monthly, years, rate] of cases) {
      const widget = computeSipFutureValue(monthly, years, rate);
      const core = calcSip({
        monthly,
        annualReturnPct: rate,
        durationYears: years,
      });
      assert.equal(
        widget.estimatedValue,
        core.finalValue,
        `₹${monthly}/mo · ${years}y · ${rate}% must equal calcSip exactly`
      );
      assert.equal(widget.invested, core.invested);
    }
  });
});

describe("Lumpsum future-value math (MONEY-245)", () => {
  it("₹1L · 10y · 12% → ~₹3.30 L (FV with monthly compounding)", () => {
    // FV = 100000 * (1.01)^120 ≈ 330,038
    const r = computeLumpsumFutureValue(100_000, 10, 12);
    assert.equal(r.invested, 100_000);
    approx(r.estimatedValue, 330_038, 100);
    approx(r.gain, 230_038, 100);
  });

  it("₹5L · 20y · 12% → ~₹54.46 L", () => {
    const r = computeLumpsumFutureValue(500_000, 20, 12);
    assert.equal(r.invested, 500_000);
    approx(r.estimatedValue, 5_446_543, 1_000);
  });

  it("zero return collapses to a straight pass-through", () => {
    const r = computeLumpsumFutureValue(250_000, 5, 0);
    assert.equal(r.invested, 250_000);
    assert.equal(r.estimatedValue, 250_000);
    assert.equal(r.gain, 0);
  });

  it("invested equals upfront, never multiplied by months", () => {
    const r = computeLumpsumFutureValue(123_456, 7, 9);
    assert.equal(r.invested, 123_456);
  });

  it("estimatedValue grows monotonically with annual return", () => {
    const a = computeLumpsumFutureValue(100_000, 10, 8);
    const b = computeLumpsumFutureValue(100_000, 10, 12);
    const c = computeLumpsumFutureValue(100_000, 10, 16);
    assert.ok(a.estimatedValue < b.estimatedValue);
    assert.ok(b.estimatedValue < c.estimatedValue);
  });

  it("Lumpsum FV ≥ SIP FV at the same total invested when r > 0", () => {
    // Putting 12L upfront beats 10k/mo over 10y at 12% - full term of
    // compounding from day 1.
    const lump = computeLumpsumFutureValue(1_200_000, 10, 12);
    const sip = computeSipFutureValue(10_000, 10, 12);
    assert.equal(lump.invested, sip.invested);
    assert.ok(lump.estimatedValue > sip.estimatedValue);
  });
});
