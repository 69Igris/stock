/**
 * MONEY-779 — compute_dcf honours a legitimate 0 override.
 *
 * The tool previously read `(params.growthRate as number) || 0.12` etc., so an
 * explicit `0` override (a perfectly valid 0% growth / 0% terminal-growth
 * assumption) was silently discarded and replaced with the hardcoded default.
 * The fix swaps the `||`-default for a `Number.isFinite()` check so 0 is kept
 * while a missing / non-numeric param still falls back to the documented
 * default.
 *
 * These tests assert the REAL exported tool `computeDcfTool.execute(args)` from
 * `packages/research/src/tools/compute-dcf.ts`. Pure compute — no IO.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeDcfTool } from "../src/tools/compute-dcf";

interface DcfData {
  intrinsicValue: number;
  currentPrice: number;
  upside: number;
  marginOfSafety: number;
  assumptions: {
    fcf: number;
    growthRate: number;
    terminalGrowthRate: number;
    discountRate: number;
    projectionYears: number;
  };
}

async function run(args: Record<string, unknown>) {
  return computeDcfTool.execute(args);
}

const base = {
  currentPrice: 100,
  freeCashFlow: 100,
  sharesOutstanding: 1000,
  discountRate: 0.1,
  projectionYears: 5,
};

describe("compute_dcf - 0 override is honoured (MONEY-779)", () => {
  it("uses growthRate=0 instead of the 0.12 default", async () => {
    const withZero = await run({
      ...base,
      growthRate: 0,
      terminalGrowthRate: 0.03,
    });
    assert.equal(withZero.success, true);
    const z = withZero.data as DcfData;
    assert.equal(z.assumptions.growthRate, 0);

    // A flat-FCF (0% growth) model is worth strictly less than the 12% default.
    const withDefault = await run({ ...base, terminalGrowthRate: 0.03 });
    const d = withDefault.data as DcfData;
    assert.equal(d.assumptions.growthRate, 0.12);
    assert.ok(
      z.intrinsicValue < d.intrinsicValue,
      `0% growth IV (${z.intrinsicValue}) should be below 12% default IV (${d.intrinsicValue})`,
    );
  });

  it("uses terminalGrowthRate=0 instead of the 0.03 default", async () => {
    const r = await run({ ...base, growthRate: 0.05, terminalGrowthRate: 0 });
    assert.equal(r.success, true);
    const data = r.data as DcfData;
    assert.equal(data.assumptions.terminalGrowthRate, 0);
  });

  it("still falls back to defaults when growth params are omitted", async () => {
    const r = await run({ ...base });
    assert.equal(r.success, true);
    const data = r.data as DcfData;
    assert.equal(data.assumptions.growthRate, 0.12);
    assert.equal(data.assumptions.terminalGrowthRate, 0.03);
  });

  it("falls back to defaults for a non-numeric (NaN) growth param", async () => {
    const r = await run({ ...base, growthRate: Number.NaN });
    assert.equal(r.success, true);
    const data = r.data as DcfData;
    assert.equal(data.assumptions.growthRate, 0.12);
  });

  it("honours an explicit wacc override and ignores discountRate when finite", async () => {
    const r = await run({
      ...base,
      discountRate: 0.1,
      wacc: 0.2,
      terminalGrowthRate: 0.03,
    });
    assert.equal(r.success, true);
    const data = r.data as DcfData;
    assert.equal(data.assumptions.discountRate, 0.2);
  });

  it("falls back to discountRate when wacc is non-finite", async () => {
    const r = await run({
      ...base,
      discountRate: 0.09,
      wacc: Number.NaN,
      terminalGrowthRate: 0.03,
    });
    assert.equal(r.success, true);
    const data = r.data as DcfData;
    assert.equal(data.assumptions.discountRate, 0.09);
  });
});
