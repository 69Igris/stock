/**
 * Risk-adjusted-returns tool — negative / edge / zero-vol coverage.
 *
 * De-shadow guarantee: imports and executes the REAL exported
 * `computeRiskAdjustedReturnsTool` and asserts ITS output. Expected constants
 * were derived from the real tool on fixed fixtures, then pinned.
 *
 * Source under test:
 *   packages/research/src/tools/compute-risk-adjusted-returns.ts
 *
 * Real bug found & fixed in source: a single non-finite return leaked NaN into
 * annualized volatility / ratios. Input is now rejected; asserted below.
 *
 * Sharpe = (annRet - rf) / annVol ; Sortino uses downside deviation vs the
 * daily risk-free MAR ; Calmar = annRet / |maxDD|. Each ratio guards its
 * denominator (→ 0 when the denominator is 0).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { computeRiskAdjustedReturnsTool } from "../src/tools/compute-risk-adjusted-returns";
import type { RiskAdjustedReturnsResult } from "../src/types";

function returnsOf(n: number, value: number): number[] {
  return Array(n).fill(value);
}

async function ok(
  dailyReturns: number[],
  extra: Record<string, unknown> = {},
): Promise<RiskAdjustedReturnsResult> {
  const out = await computeRiskAdjustedReturnsTool.execute({
    dailyReturns,
    ...extra,
  });
  assert.equal(out.success, true, out.error);
  return out.data as RiskAdjustedReturnsResult;
}

function assertAllFinite(d: RiskAdjustedReturnsResult): void {
  for (const n of [
    d.annualizedReturn,
    d.annualizedVolatility,
    d.sharpeRatio,
    d.sortinoRatio,
    d.calmarRatio,
    d.riskFreeRate,
    d.maxDrawdown,
    d.downsideDeviation,
  ]) {
    assert.ok(Number.isFinite(n), `non-finite ${n} in ${JSON.stringify(d)}`);
  }
}

describe("computeRiskAdjustedReturnsTool — input validation", () => {
  // MONEY-1274 (MONEY-1155 #30) — these asserted `success: false`, which is
  // what made a THIN INPUT read as a FAILED COMPUTATION: the executor marks a
  // success:false task failed and the synthesiser lists it under "FAILED /
  // UNAVAILABLE SOURCES", so a run that merely fetched too little data was
  // reported as the analysis engine breaking. The tool did not fail — it
  // correctly declined to compute from too few points. Contract is now
  // `success: true` + `available: false` + reason, matching the compute tools
  // that already did this. See src/tools/insufficient-input.ts.
  test("empty returns → unavailable", async () => {
    const out = await computeRiskAdjustedReturnsTool.execute({
      dailyReturns: [],
    });
    assert.equal(out.success, true);
    const d = out.data as Record<string, unknown>;
    assert.equal(d.available, false);
    assert.match(String(d.reason), /At least 20 daily returns/);
  });

  test("19 returns → unavailable (boundary)", async () => {
    const out = await computeRiskAdjustedReturnsTool.execute({
      dailyReturns: returnsOf(19, 0.01),
    });
    assert.equal(out.success, true);
    const d = out.data as Record<string, unknown>;
    assert.equal(d.available, false);
  });

  test("exactly 20 returns → success (boundary)", async () => {
    const d = await ok(returnsOf(20, 0.001), { maxDrawdown: -0.05 });
    assertAllFinite(d);
  });

  test("undefined returns → unavailable", async () => {
    const out = await computeRiskAdjustedReturnsTool.execute({});
    assert.equal(out.success, true);
    const d = out.data as Record<string, unknown>;
    assert.equal(d.available, false);
  });
});

describe("computeRiskAdjustedReturnsTool — non-finite returns rejected (no NaN leak)", () => {
  // BUG (FIXED): a NaN return used to make annualizedVolatility NaN.
  test("a NaN return → failure", async () => {
    const ret = returnsOf(20, 0.01);
    ret[3] = NaN;
    const out = await computeRiskAdjustedReturnsTool.execute({
      dailyReturns: ret,
      maxDrawdown: -0.1,
    });
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /finite numbers/);
  });

  test("an Infinity return → failure", async () => {
    const ret = returnsOf(20, 0.01);
    ret[10] = Infinity;
    const out = await computeRiskAdjustedReturnsTool.execute({
      dailyReturns: ret,
      maxDrawdown: -0.1,
    });
    assert.equal(out.success, false);
  });
});

describe("computeRiskAdjustedReturnsTool — denominator guards", () => {
  test("flat (constant) returns → zero vol → Sharpe 0 (no divide-by-zero)", async () => {
    const d = await ok(returnsOf(20, 0.0), { maxDrawdown: -0.1 });
    assert.equal(d.annualizedVolatility, 0);
    assert.equal(d.sharpeRatio, 0); // annualizedVol == 0 → guarded to 0
    assertAllFinite(d);
  });

  test("maxDrawdown = 0 → Calmar 0 (no divide-by-zero)", async () => {
    const d = await ok(returnsOf(20, 0.01), { maxDrawdown: 0 });
    assert.equal(d.calmarRatio, 0);
    assertAllFinite(d);
  });

  test("maxDrawdown omitted → treated as 0 → Calmar 0", async () => {
    const d = await ok(returnsOf(20, 0.01));
    assert.equal(d.maxDrawdown, 0);
    assert.equal(d.calmarRatio, 0);
    assertAllFinite(d);
  });

  test("no downside returns → Sortino 0 (downside deviation 0)", async () => {
    // Every return far ABOVE the daily MAR (rf/252 ≈ 0.000258) → no downside.
    const d = await ok(returnsOf(20, 0.05), { maxDrawdown: -0.1 });
    assert.equal(d.downsideDeviation, 0);
    assert.equal(d.sortinoRatio, 0); // downsideDeviation == 0 → guarded to 0
    assertAllFinite(d);
  });
});

describe("computeRiskAdjustedReturnsTool — computed values (pinned to real tool)", () => {
  // 20 returns alternating +0.01 / -0.005.
  const mixed = Array.from({ length: 20 }, (_, i) => (i % 2 ? -0.005 : 0.01));

  test("ratios match the real tool for a known mixed series", async () => {
    const d = await ok(mixed, { maxDrawdown: -0.2, riskFreeRate: 0.065 });
    assert.equal(d.annualizedReturn, 0.63);
    assert.equal(d.annualizedVolatility, 0.1222);
    assert.equal(d.sharpeRatio, 4.63);
    assert.equal(d.sortinoRatio, 6.77);
    assert.equal(d.calmarRatio, 3.15);
    assert.equal(d.downsideDeviation, 0.0835);
    assert.equal(d.riskFreeRate, 0.065);
    assert.equal(d.maxDrawdown, -0.2);
    assertAllFinite(d);
  });

  test("custom riskFreeRate is honored", async () => {
    const d = await ok(mixed, { maxDrawdown: -0.2, riskFreeRate: 0.08 });
    assert.equal(d.riskFreeRate, 0.08);
  });

  test("riskFreeRate of 0 falls back to default 0.065 (|| coercion)", async () => {
    // The source uses `params.riskFreeRate || RISK_FREE_RATE`, so a literal 0
    // is replaced by the 6.5% default — pin this documented behavior.
    const d = await ok(mixed, { maxDrawdown: -0.2, riskFreeRate: 0 });
    assert.equal(d.riskFreeRate, 0.065);
  });

  test("negative maxDrawdown magnitude is used for Calmar", async () => {
    const a = await ok(mixed, { maxDrawdown: -0.1 });
    const b = await ok(mixed, { maxDrawdown: 0.1 }); // |maxDD| identical
    assert.equal(a.calmarRatio, b.calmarRatio);
  });

  test("huge returns stay finite (no overflow to Infinity)", async () => {
    const d = await ok(returnsOf(20, 5), { maxDrawdown: -0.5 }); // absurd 500%/day
    assertAllFinite(d);
  });
});
