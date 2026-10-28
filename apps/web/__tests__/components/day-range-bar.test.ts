/**
 * DayRangeBar position math (MONEY-244).
 *
 * De-shadowed: imports the REAL dayRangePct from
 * components/stock/day-range-logic.ts — the exact function DayRangeBar renders
 * the dot position from. It clamps in-range / at-boundary / out-of-range ticks
 * and centers (0.5) for any degenerate input (missing or non-finite values, or
 * a non-positive range).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dayRangePct as pct } from "../../components/stock/day-range-logic";

describe("DayRangeBar position (MONEY-244)", () => {
  it("0% when current equals low", () => {
    assert.equal(pct(100, 200, 100), 0);
  });

  it("100% when current equals high", () => {
    assert.equal(pct(100, 200, 200), 1);
  });

  it("50% when current is the mid", () => {
    assert.equal(pct(100, 200, 150), 0.5);
  });

  it("clamps to 0 when current is below low (e.g. stale tick)", () => {
    assert.equal(pct(100, 200, 80), 0);
  });

  it("clamps to 1 when current is above high (e.g. spike tick)", () => {
    assert.equal(pct(100, 200, 220), 1);
  });

  it("falls back to 50% when low is missing", () => {
    assert.equal(pct(null, 200, 150), 0.5);
  });

  it("falls back to 50% when high is missing", () => {
    assert.equal(pct(100, null, 150), 0.5);
  });

  it("falls back to 50% when current is missing", () => {
    assert.equal(pct(100, 200, null), 0.5);
  });

  it("falls back to 50% when high <= low (degenerate range)", () => {
    assert.equal(pct(200, 100, 150), 0.5);
    assert.equal(pct(150, 150, 150), 0.5);
  });

  it("handles real-world Reliance numbers from the design", () => {
    // Image #32: low ₹1,393.10, high ₹1,437.00, current ₹1,436.00
    // Expect dot near the right edge.
    const p = pct(1393.1, 1437, 1436);
    assert.ok(p > 0.95, `expected dot ≥ 95% across, got ${p}`);
    assert.ok(p < 1, `expected dot strictly < 100% (current < high), got ${p}`);
  });

  // Non-finite regression: a NaN/Infinity tick (bad upstream quote) must not
  // produce a NaN position that crashes `(pct*100).toFixed(2)` in the style
  // calc. The real source guards with Number.isFinite; the old shadow's
  // `== null` check did NOT, so it would have returned NaN here.
  it("falls back to 50% for NaN current (bad tick), never NaN", () => {
    const p = pct(100, 200, NaN);
    assert.equal(p, 0.5);
    assert.ok(Number.isFinite(p));
  });

  it("falls back to 50% for Infinity high", () => {
    assert.equal(pct(100, Infinity, 150), 0.5);
  });

  it("falls back to 50% for undefined inputs", () => {
    assert.equal(pct(undefined, 200, 150), 0.5);
    assert.equal(pct(100, undefined, 150), 0.5);
    assert.equal(pct(100, 200, undefined), 0.5);
  });
});
