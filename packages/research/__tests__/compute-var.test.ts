/**
 * VaR tool — negative / edge / insufficient-data coverage.
 *
 * De-shadow guarantee: imports and executes the REAL exported `computeVarTool`
 * and asserts ITS output. The expected numeric constants below were derived by
 * running the real tool on fixed fixtures (not by reimplementing the formula
 * here), then pinned so a regression in the source flips the assertion.
 *
 * Source under test: packages/research/src/tools/compute-var.ts
 *
 * Real bug found & fixed in source while writing these: a single non-finite
 * return leaked NaN (serialized `null`) into the parametric VaR block. Input
 * is now rejected; asserted below.
 *
 * Note on percentile indexing: for n=20, idx95 = floor(20*0.05) = 1, so
 * historical.var95 is the 2nd-worst observation and var99 (idx99 = 0) is the
 * single worst. The tests pin the tool's ACTUAL indexing, not an idealized VaR.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { computeVarTool } from "../src/tools/compute-var";
import type { VaRResult } from "../src/types";

/**
 * MONEY-806: compute_var now reads params.varConfig.confidence (95|99) and
 * promotes the chosen percentile as the primary VaR via selected* fields,
 * while keeping var95/var99 for compatibility. The result is a superset of
 * VaRResult — assert the extra fields against the real tool output.
 */
interface SelectedVaRResult extends VaRResult {
  selectedConfidence: 95 | 99;
  selectedVar: number;
  selectedParametricVar: number;
  selectedVarAmount: number;
}

function returnsOf(n: number, value: number): number[] {
  return Array(n).fill(value);
}

async function ok(
  portfolioReturns: number[],
  portfolioValue: number,
  period?: string,
): Promise<VaRResult> {
  const out = await computeVarTool.execute({
    portfolioReturns,
    portfolioValue,
    ...(period ? { period } : {}),
  });
  assert.equal(out.success, true, out.error);
  return out.data as VaRResult;
}

function assertAllFinite(d: VaRResult): void {
  for (const n of [
    d.historical.var95,
    d.historical.var99,
    d.historical.cvar95,
    d.parametric.var95,
    d.parametric.var99,
    d.parametric.mean,
    d.parametric.stdDev,
    d.var95Amount,
    d.portfolioValue,
  ]) {
    assert.ok(Number.isFinite(n), `non-finite ${n} in ${JSON.stringify(d)}`);
  }
}

describe("computeVarTool — input validation / insufficient data", () => {
  // MONEY-1274 (MONEY-1155 #30) — these asserted `success: false`, which is
  // what made a THIN INPUT read as a FAILED COMPUTATION: the executor marks a
  // success:false task failed and the synthesiser lists it under "FAILED /
  // UNAVAILABLE SOURCES", so a run that merely fetched too little data was
  // reported as the analysis engine breaking. The tool did not fail — it
  // correctly declined to compute from too few points. Contract is now
  // `success: true` + `available: false` + reason, matching the compute tools
  // that already did this. See src/tools/insufficient-input.ts.
  test("empty returns → unavailable", async () => {
    const out = await computeVarTool.execute({
      portfolioReturns: [],
      portfolioValue: 1000,
    });
    assert.equal(out.success, true);
    const d = out.data as Record<string, unknown>;
    assert.equal(d.available, false);
    assert.match(String(d.reason), /At least 20 daily returns/);
    assert.equal(d.var95, undefined, "must not invent a VaR");
  });

  test("fewer than 20 returns → unavailable (boundary at 19)", async () => {
    const out = await computeVarTool.execute({
      portfolioReturns: returnsOf(19, 0.01),
      portfolioValue: 1000,
    });
    assert.equal(out.success, true);
    const d = out.data as Record<string, unknown>;
    assert.equal(d.available, false);
    assert.match(String(d.reason), /At least 20 daily returns/);
  });

  test("exactly 20 returns → success (boundary)", async () => {
    const d = await ok(returnsOf(20, 0.001), 1000);
    assertAllFinite(d);
  });

  test("undefined returns → unavailable", async () => {
    const out = await computeVarTool.execute({ portfolioValue: 1000 });
    assert.equal(out.success, true);
    const d = out.data as Record<string, unknown>;
    assert.equal(d.available, false);
  });

  test("zero portfolio value → failure", async () => {
    const out = await computeVarTool.execute({
      portfolioReturns: returnsOf(20, 0.01),
      portfolioValue: 0,
    });
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /portfolioValue must be > 0/);
  });

  test("negative portfolio value → failure", async () => {
    const out = await computeVarTool.execute({
      portfolioReturns: returnsOf(20, 0.01),
      portfolioValue: -5000,
    });
    assert.equal(out.success, false);
  });
});

describe("computeVarTool — non-finite returns are rejected (no NaN leak)", () => {
  // BUG (FIXED): a single NaN return used to make parametric.{mean,stdDev,
  // var95,var99} NaN (serialized `null`). Input is now rejected.
  test("a NaN return → failure, not a corrupt result", async () => {
    const ret = returnsOf(20, 0.01);
    ret[5] = NaN;
    const out = await computeVarTool.execute({
      portfolioReturns: ret,
      portfolioValue: 1000,
    });
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /finite numbers/);
  });

  test("a +Infinity return → failure", async () => {
    const ret = returnsOf(20, 0.01);
    ret[0] = Infinity;
    const out = await computeVarTool.execute({
      portfolioReturns: ret,
      portfolioValue: 1000,
    });
    assert.equal(out.success, false);
  });

  test("a -Infinity return → failure", async () => {
    const ret = returnsOf(20, 0.01);
    ret[19] = -Infinity;
    const out = await computeVarTool.execute({
      portfolioReturns: ret,
      portfolioValue: 1000,
    });
    assert.equal(out.success, false);
  });
});

describe("computeVarTool — computed values (pinned to real tool output)", () => {
  // 20 returns: index 0 = -0.05 (worst), the other 19 = +0.01.
  const knownReturns = [-0.05, ...returnsOf(19, 0.01)];

  test("historical/parametric/CVaR match the real tool", async () => {
    const d = await ok(knownReturns, 100000, "1-day");
    // idx95 = floor(20*0.05)=1 → sorted[1] = 0.01 ; idx99 = 0 → -0.05
    assert.equal(d.historical.var95, 0.01);
    assert.equal(d.historical.var99, -0.05);
    // CVaR95 = mean of tail [0..idx95] = (-0.05 + 0.01)/2 = -0.02
    assert.equal(d.historical.cvar95, -0.02);
    // Parametric: mean 0.007, stdDev 0.0134 → var95 = mean - 1.645σ
    assert.equal(d.parametric.mean, 0.007);
    assert.equal(d.parametric.stdDev, 0.0134);
    assert.equal(d.parametric.var95, -0.0151);
    assert.equal(d.parametric.var99, -0.0242);
    // var95Amount = round(|histVar95| * value) = round(0.01 * 100000)
    assert.equal(d.var95Amount, 1000);
    assert.equal(d.portfolioValue, 100000);
    assertAllFinite(d);
  });

  test("10-day period scales by sqrt(10)", async () => {
    const d1 = await ok(knownReturns, 100000, "1-day");
    const d10 = await ok(knownReturns, 100000, "10-day");
    // historical var99 (-0.05) scaled by sqrt(10), rounded to 4 dp
    const expected =
      Math.round(d1.historical.var99 * Math.sqrt(10) * 10000) / 10000;
    assert.equal(d10.historical.var99, expected);
    assert.equal(d10.period, "10-day");
  });

  test("default period is 1-day when omitted", async () => {
    const d = await ok(knownReturns, 100000);
    assert.equal(d.period, "1-day");
  });

  test("all-zero returns → zero parametric VaR, zero amount, all finite", async () => {
    const d = await ok(returnsOf(25, 0), 50000);
    assert.equal(d.parametric.mean, 0);
    assert.equal(d.parametric.stdDev, 0);
    assert.equal(d.parametric.var95, 0);
    assert.equal(d.var95Amount, 0);
    assertAllFinite(d);
  });

  test("large book + large negative tail stays finite", async () => {
    const ret = [-0.4, ...returnsOf(24, 0.02)];
    const d = await ok(ret, 1_000_000_000, "1-day");
    assertAllFinite(d);
    assert.ok(d.var95Amount >= 0); // amount is an absolute magnitude
  });
});

describe("computeVarTool — MONEY-806 varConfig.confidence selection", () => {
  // 20 returns: index 0 = -0.05 (worst), the other 19 = +0.01.
  const knownReturns = [-0.05, ...returnsOf(19, 0.01)];

  async function selected(confidence?: 95 | 99): Promise<SelectedVaRResult> {
    const out = await computeVarTool.execute({
      portfolioReturns: knownReturns,
      portfolioValue: 100000,
      ...(confidence ? { varConfig: { confidence } } : {}),
    });
    assert.equal(out.success, true, out.error);
    return out.data as SelectedVaRResult;
  }

  test("absent varConfig → defaults to 95 (today's headline unchanged)", async () => {
    const d = await selected();
    assert.equal(d.selectedConfidence, 95);
    // selected* mirror the historical/parametric var95 block.
    assert.equal(d.selectedVar, d.historical.var95);
    assert.equal(d.selectedParametricVar, d.parametric.var95);
    // selectedVarAmount equals var95Amount when 95 is selected.
    assert.equal(d.selectedVarAmount, d.var95Amount);
    // back-compat: both percentiles still present.
    assert.equal(d.historical.var95, 0.01);
    assert.equal(d.historical.var99, -0.05);
  });

  test("confidence 95 → primary VaR is the 95% percentile", async () => {
    const d = await selected(95);
    assert.equal(d.selectedConfidence, 95);
    assert.equal(d.selectedVar, d.historical.var95);
    assert.equal(d.selectedParametricVar, d.parametric.var95);
    assert.equal(d.selectedVarAmount, Math.round(Math.abs(0.01) * 100000));
  });

  test("confidence 99 → primary VaR switches to the 99% percentile", async () => {
    const d = await selected(99);
    assert.equal(d.selectedConfidence, 99);
    // var99 = -0.05 (the worst observation) is now primary.
    assert.equal(d.selectedVar, d.historical.var99);
    assert.equal(d.selectedVar, -0.05);
    assert.equal(d.selectedParametricVar, d.parametric.var99);
    // amount uses |var99| → larger than the var95 amount.
    assert.equal(d.selectedVarAmount, Math.round(Math.abs(-0.05) * 100000));
    assert.ok(d.selectedVarAmount > d.var95Amount);
    // both percentiles still returned for compatibility.
    assert.equal(d.historical.var95, 0.01);
    assert.equal(d.historical.var99, -0.05);
  });

  test("invalid confidence (e.g. 90) falls back to 95", async () => {
    const out = await computeVarTool.execute({
      portfolioReturns: knownReturns,
      portfolioValue: 100000,
      varConfig: { confidence: 90 as unknown as 95 },
    });
    assert.equal(out.success, true);
    const d = out.data as SelectedVaRResult;
    assert.equal(d.selectedConfidence, 95);
  });
});
