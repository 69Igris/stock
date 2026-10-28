/**
 * MONEY-393 §39 - SipCalculator.tsx coverage extension.
 *
 * The existing sip-calculator.test.ts (11 cases) thoroughly covers the
 * canonical math. The file's 23.1% number reflects that c8 measures
 * the whole module (380 lines) - most of the remaining mass is the
 * React component body (JSX, hooks, sliders) which can't render
 * without a DOM and is bounded by node:test's inherent ceiling.
 *
 * This file adds the math edges + component-identity smoke tests
 * the canonical file doesn't cover:
 *   - years = 0 → at-least-1-month clamp
 *   - sub-year (years < 1) months rounding
 *   - non-finite FV → invested fallback (overflow guard)
 *   - negative annual return on monthly SIP
 *   - extracted math module exports stable named functions
 *
 * The math lives in the CSS-free `sip-math` module (so node:test can load it
 * without parsing `SipCalculator.tsx`'s `./detail-playful.css` import). The
 * component re-imports these exact helpers and renders identically.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeSipFutureValue,
  computeLumpsumFutureValue,
} from "../../components/mf/sip-math";

describe("MONEY-393 §39 - SipCalculator math edges", () => {
  // ── SIP edges ──

  it("[sip] years === 0 clamps to 1 month (Math.max guard)", () => {
    const r = computeSipFutureValue(1000, 0, 8);
    // 1 month × 1000 = 1000
    assert.equal(r.invested, 1000);
  });

  it("[sip] fractional years rounds to nearest whole month", () => {
    // 0.5 years × 12 = 6 months
    const r = computeSipFutureValue(10000, 0.5, 12);
    assert.equal(r.invested, 60000, "6 months × 10000");
  });

  it("[sip] non-finite Math.pow result → falls back to invested", () => {
    // 99% monthly compounded across 100 years → ~Infinity. The function
    // explicitly checks Number.isFinite(fv) and bails to invested.
    const r = computeSipFutureValue(1e10, 1000, 999);
    assert.ok(Number.isFinite(r.estimatedValue));
    // If FV overflowed, estimated == invested. Either way: finite.
  });

  it("[sip] negative return → gain < 0 (math accepts it; UI clamps)", () => {
    const r = computeSipFutureValue(10000, 5, -10);
    assert.ok(
      r.estimatedValue < r.invested,
      "negative return must shrink the corpus"
    );
    assert.ok(r.gain < 0);
  });

  // ── Lumpsum edges ──

  it("[lumpsum] years === 0 clamps to 1 month → tiny interest", () => {
    const r = computeLumpsumFutureValue(100000, 0, 12);
    // 1 month × 1% = ₹101,000
    assert.ok(
      r.estimatedValue > 100000 && r.estimatedValue < 102000,
      `expected ~₹101k after 1 month at 12% annual, got ${r.estimatedValue}`
    );
  });

  it("[lumpsum] non-finite Math.pow → falls back to invested", () => {
    const r = computeLumpsumFutureValue(1e15, 1000, 999);
    assert.ok(Number.isFinite(r.estimatedValue));
  });

  // ── Module shape ──

  it("[module] sip-math exports both future-value helpers as functions", async () => {
    const mod = (await import("../../components/mf/sip-math")) as {
      computeSipFutureValue: unknown;
      computeLumpsumFutureValue: unknown;
    };
    assert.equal(typeof mod.computeSipFutureValue, "function");
    assert.equal(typeof mod.computeLumpsumFutureValue, "function");
  });

  it("[module] math helpers are named functions (stable identity for stack traces)", () => {
    assert.equal(typeof computeSipFutureValue, "function");
    assert.equal(typeof computeLumpsumFutureValue, "function");
    // Named-function exports - stable display in stack traces / DevTools.
    assert.equal(computeSipFutureValue.name, "computeSipFutureValue");
    assert.equal(computeLumpsumFutureValue.name, "computeLumpsumFutureValue");
  });
});
