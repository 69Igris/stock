/**
 * Guidance Sensitivity Tool Tests
 * (packages/research/src/tools/compute-guidance-sensitivity.ts)
 *
 * Pure-function compute tool. All inputs injected by the executor; no
 * network/db/io, so these tests are fully deterministic.
 *
 * Coverage:
 *   - Happy path: success + available + key field shapes/types
 *   - Known-value numeric assertions (base/bull/bear cells, elasticity, lever)
 *   - Graceful degradation: available:false (NOT success:false) on missing/<=0
 *     revenue or sharesOutstanding
 *   - Edge cases: zero/negative/missing optional inputs must not throw
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeGuidanceSensitivityTool } from "../../../../packages/research/src/tools/compute-guidance-sensitivity";

async function run(args: Record<string, unknown>) {
  return computeGuidanceSensitivityTool.execute(args);
}

// Tolerance for float comparisons. The tool rounds projEps/impliedValue to 2dp
// and elasticity to 4dp, so a small epsilon is safe and deterministic.
const EPS = 1e-9;

interface Cell {
  revenueGrowth: number;
  operatingMargin: number;
  projRevenue: number;
  projEbit: number;
  projNetIncome: number;
  projEps: number;
  impliedValue: number | null;
}

interface GuidanceResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  assumptions?: {
    revenue: number;
    baseGrowth: number;
    baseMargin: number;
    sharesOutstanding: number;
    pe: number | null;
    taxRate: number;
    currentPrice: number | null;
    growthAssumed: boolean;
    marginAssumed: boolean;
  };
  baseEps?: number;
  bullEps?: number;
  bearEps?: number;
  baseImpliedValue?: number | null;
  bullImpliedValue?: number | null;
  bearImpliedValue?: number | null;
  epsElasticity?: {
    perPpGrowth: number;
    perPpMargin: number;
    dominantLever: "growth" | "margin" | "balanced";
  };
  grid?: Cell[];
  flags: string[];
}

// Representative inputs reused across several cases (the known-value fixture).
const REP = {
  revenue: 1000,
  operatingMargin: 0.2,
  sharesOutstanding: 100,
  pe: 25,
  taxRate: 0.25,
  symbol: "ACME.NS",
};

// ── 1. Happy path: shape + types ──────────────────────────────────────

test("happy path: returns success + available with well-typed fields", async () => {
  const r = await run({ ...REP });
  assert.equal(r.success, true);
  const data = r.data as GuidanceResult;

  assert.equal(data.available, true);
  assert.equal(data.symbol, "ACME"); // .NS suffix stripped, uppercased

  // Anchor EPS values present and numeric.
  assert.equal(typeof data.baseEps, "number");
  assert.equal(typeof data.bullEps, "number");
  assert.equal(typeof data.bearEps, "number");

  // Assumptions block.
  assert.ok(data.assumptions, "assumptions should be present");
  assert.equal(typeof data.assumptions!.revenue, "number");
  assert.equal(typeof data.assumptions!.baseGrowth, "number");
  assert.equal(typeof data.assumptions!.baseMargin, "number");
  assert.equal(typeof data.assumptions!.sharesOutstanding, "number");
  assert.equal(data.assumptions!.pe, 25);
  assert.equal(typeof data.assumptions!.taxRate, "number");
  assert.equal(data.assumptions!.growthAssumed, true); // growth defaulted to 10%
  assert.equal(data.assumptions!.marginAssumed, false); // margin supplied

  // Elasticity block.
  assert.ok(data.epsElasticity, "epsElasticity should be present");
  assert.equal(typeof data.epsElasticity!.perPpGrowth, "number");
  assert.equal(typeof data.epsElasticity!.perPpMargin, "number");
  assert.ok(
    ["growth", "margin", "balanced"].includes(data.epsElasticity!.dominantLever)
  );

  // Grid is exactly 9 cells (3 growth x 3 margin).
  assert.ok(Array.isArray(data.grid));
  assert.equal(data.grid!.length, 9);

  // Flags is an array of strings.
  assert.ok(Array.isArray(data.flags));
  for (const f of data.flags) assert.equal(typeof f, "string");
});

// ── 2. Known-value numeric assertions ─────────────────────────────────

test("known values: base cell (rev=1000, margin=0.20, shares=100, pe=25, tax=0.25, growth default 0.10)", async () => {
  const r = await run({ ...REP });
  assert.equal(r.success, true);
  const data = r.data as GuidanceResult;

  // projRevenue=1100, projEbit=220, projNetIncome=165, baseEps=1.65, baseImpliedValue=41.25
  assert.ok(Math.abs(data.baseEps! - 1.65) < EPS, `baseEps ${data.baseEps}`);
  assert.ok(
    Math.abs((data.baseImpliedValue as number) - 41.25) < EPS,
    `baseImpliedValue ${data.baseImpliedValue}`
  );

  // Inspect the explicit base grid cell (growth 0.10, margin 0.20).
  const baseGridCell = data.grid!.find(
    (c) =>
      Math.abs(c.revenueGrowth - 0.1) < EPS &&
      Math.abs(c.operatingMargin - 0.2) < EPS
  );
  assert.ok(baseGridCell, "base grid cell should exist");
  assert.ok(Math.abs(baseGridCell!.projRevenue - 1100) < EPS);
  assert.ok(Math.abs(baseGridCell!.projEbit - 220) < EPS);
  assert.ok(Math.abs(baseGridCell!.projNetIncome - 165) < EPS);
  assert.ok(Math.abs(baseGridCell!.projEps - 1.65) < EPS);
});

test("known values: bull cell (+3pp growth=0.13, +2pp margin=0.22)", async () => {
  const r = await run({ ...REP });
  const data = r.data as GuidanceResult;

  // projRevenue=1130, projEbit=248.6, projNetIncome=186.45, bullEps=1.86, bullImpliedValue=46.61
  assert.ok(Math.abs(data.bullEps! - 1.86) < EPS, `bullEps ${data.bullEps}`);
  assert.ok(
    Math.abs((data.bullImpliedValue as number) - 46.61) < EPS,
    `bullImpliedValue ${data.bullImpliedValue}`
  );

  const bullGridCell = data.grid!.find(
    (c) =>
      Math.abs(c.revenueGrowth - 0.13) < EPS &&
      Math.abs(c.operatingMargin - 0.22) < EPS
  );
  assert.ok(bullGridCell, "bull grid cell should exist");
  assert.ok(Math.abs(bullGridCell!.projRevenue - 1130) < EPS);
  assert.ok(Math.abs(bullGridCell!.projEbit - 248.6) < EPS);
  assert.ok(Math.abs(bullGridCell!.projNetIncome - 186.45) < EPS);
});

test("known values: bear cell (-3pp growth=0.07, -2pp margin=0.18)", async () => {
  const r = await run({ ...REP });
  const data = r.data as GuidanceResult;

  // projRevenue=1070, projEbit=192.6, projNetIncome=144.45, bearEps=1.44, bearImpliedValue=36.11
  assert.ok(Math.abs(data.bearEps! - 1.44) < EPS, `bearEps ${data.bearEps}`);
  assert.ok(
    Math.abs((data.bearImpliedValue as number) - 36.11) < EPS,
    `bearImpliedValue ${data.bearImpliedValue}`
  );

  const bearGridCell = data.grid!.find(
    (c) =>
      Math.abs(c.revenueGrowth - 0.07) < EPS &&
      Math.abs(c.operatingMargin - 0.18) < EPS
  );
  assert.ok(bearGridCell, "bear grid cell should exist");
  assert.ok(Math.abs(bearGridCell!.projRevenue - 1070) < EPS);
  assert.ok(Math.abs(bearGridCell!.projEbit - 192.6) < EPS);
  assert.ok(Math.abs(bearGridCell!.projNetIncome - 144.45) < EPS);
});

test("known values: elasticity (rounded-EPS deltas) and margin dominates", async () => {
  const r = await run({ ...REP });
  const data = r.data as GuidanceResult;

  // The tool rounds each cell's projEps to 2dp INSIDE project() before the
  // elasticity subtraction. So the deltas use rounded EPS, not raw EPS:
  //   +1pp growth (0.11): raw EPS 1.665 -> rounds to 1.67 => perPpGrowth = 1.67 - 1.65 = 0.02
  //   +1pp margin (0.21): raw EPS 1.7325 -> rounds to 1.73 => perPpMargin = 1.73 - 1.65 = 0.08
  // (Underlying raw elasticity would be 0.015 / 0.0825; margin still dominates either way.)
  assert.ok(
    Math.abs(data.epsElasticity!.perPpGrowth - 0.02) < EPS,
    `perPpGrowth ${data.epsElasticity!.perPpGrowth}`
  );
  assert.ok(
    Math.abs(data.epsElasticity!.perPpMargin - 0.08) < EPS,
    `perPpMargin ${data.epsElasticity!.perPpMargin}`
  );
  // Margin delta (0.08) clearly exceeds growth delta (0.02) -> margin lever dominates.
  assert.equal(data.epsElasticity!.dominantLever, "margin");

  // Margin-dominant observation flag should be emitted (SEBI-safe wording).
  assert.ok(
    data.flags.some((f) =>
      f.includes("more sensitive to operating-margin changes")
    ),
    "expected margin-dominant flag"
  );
});

// ── 3. Graceful degradation (success:true + available:false) ───────────

test("graceful degradation: missing revenue -> available:false (not success:false)", async () => {
  const r = await run({ sharesOutstanding: 100, operatingMargin: 0.2 });
  assert.equal(r.success, true);
  const data = r.data as GuidanceResult;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.equal(data.reason, "revenue unavailable - cannot project forward EPS");
  assert.deepEqual(data.flags, []);
});

test("graceful degradation: revenue <= 0 -> available:false", async () => {
  const r = await run({ revenue: 0, sharesOutstanding: 100 });
  assert.equal(r.success, true);
  const data = r.data as GuidanceResult;
  assert.equal(data.available, false);
  assert.equal(data.reason, "revenue unavailable - cannot project forward EPS");

  const rNeg = await run({ revenue: -500, sharesOutstanding: 100 });
  assert.equal(rNeg.success, true);
  assert.equal((rNeg.data as GuidanceResult).available, false);
});

test("graceful degradation: missing/<=0 sharesOutstanding -> available:false with shares reason", async () => {
  const rMissing = await run({ revenue: 1000, operatingMargin: 0.2 });
  assert.equal(rMissing.success, true);
  const dMissing = rMissing.data as GuidanceResult;
  assert.equal(dMissing.available, false);
  assert.equal(
    dMissing.reason,
    "sharesOutstanding unavailable - cannot convert net income to EPS"
  );
  assert.deepEqual(dMissing.flags, []);

  const rZero = await run({ revenue: 1000, sharesOutstanding: 0 });
  assert.equal(rZero.success, true);
  assert.equal((rZero.data as GuidanceResult).available, false);
});

test("graceful degradation: symbol still surfaced when unavailable", async () => {
  const r = await run({ sharesOutstanding: 100, symbol: "tcs.bo" });
  assert.equal(r.success, true);
  const data = r.data as GuidanceResult;
  assert.equal(data.available, false);
  assert.equal(data.symbol, "TCS"); // suffix stripped + uppercased even on the degraded path
});

// ── 4. Edge cases (must not throw) ─────────────────────────────────────

test("edge: margin derived from operatingIncome when operatingMargin absent", async () => {
  // operatingIncome/revenue = 300/1000 = 0.30 base margin (not the 15% fallback).
  const r = await run({
    revenue: 1000,
    operatingIncome: 300,
    sharesOutstanding: 100,
  });
  assert.equal(r.success, true);
  const data = r.data as GuidanceResult;
  assert.equal(data.available, true);
  assert.equal(data.assumptions!.marginAssumed, false);
  assert.ok(Math.abs(data.assumptions!.baseMargin - 0.3) < EPS);
});

test("edge: missing margin AND operatingIncome -> 15% assumed, flagged, no throw", async () => {
  const r = await run({ revenue: 1000, sharesOutstanding: 100 });
  assert.equal(r.success, true);
  const data = r.data as GuidanceResult;
  assert.equal(data.available, true);
  assert.equal(data.assumptions!.marginAssumed, true);
  assert.ok(Math.abs(data.assumptions!.baseMargin - 0.15) < EPS);
  assert.ok(
    data.flags.some((f) => f.includes("base margin assumed at 15%")),
    "expected margin-assumed flag"
  );
});

test("edge: percent-style inputs normalized to fractions (margin=20, growth=10, pe given)", async () => {
  const r = await run({
    revenue: 1000,
    operatingMargin: 20, // percent form -> 0.20
    revenueGrowth: 10, // percent form -> 0.10
    sharesOutstanding: 100,
    pe: 25,
    taxRate: 25, // percent form -> 0.25
  });
  assert.equal(r.success, true);
  const data = r.data as GuidanceResult;
  assert.equal(data.available, true);
  // Same fixture as the known-value case, so baseEps must match 1.65.
  assert.ok(Math.abs(data.baseEps! - 1.65) < EPS, `baseEps ${data.baseEps}`);
  assert.equal(data.assumptions!.growthAssumed, false);
});

test("edge: pe absent -> implied values null and pe-omitted flag, EPS still computed", async () => {
  const r = await run({
    revenue: 1000,
    operatingMargin: 0.2,
    sharesOutstanding: 100,
  });
  assert.equal(r.success, true);
  const data = r.data as GuidanceResult;
  assert.equal(data.available, true);
  assert.equal(data.assumptions!.pe, null);
  assert.equal(data.baseImpliedValue, null);
  assert.equal(data.bullImpliedValue, null);
  assert.equal(data.bearImpliedValue, null);
  for (const cell of data.grid!) assert.equal(cell.impliedValue, null);
  assert.equal(typeof data.baseEps, "number"); // EPS grid still produced
  assert.ok(
    data.flags.some((f) => f.includes("PE multiple unavailable")),
    "expected pe-omitted flag"
  );
});

test("edge: negative base margin clamps, flags non-positive, does not throw", async () => {
  const r = await run({
    revenue: 1000,
    operatingMargin: -0.3,
    sharesOutstanding: 100,
    pe: 25,
  });
  assert.equal(r.success, true);
  const data = r.data as GuidanceResult;
  assert.equal(data.available, true);
  assert.ok(data.assumptions!.baseMargin <= 0);
  assert.ok(
    data.flags.some((f) => f.includes("Base operating margin is non-positive")),
    "expected non-positive-margin flag"
  );
  // Negative-net-income bear case should be flagged too.
  assert.ok(
    data.flags.some((f) => f.includes("negative net income")),
    "expected bear negative net-income flag"
  );
});

test("edge: extreme/odd inputs (huge pe, tiny shares, missing symbol) do not throw and stay finite", async () => {
  const r = await run({
    revenue: 1e9,
    operatingMargin: 0.5,
    revenueGrowth: 0.4,
    sharesOutstanding: 0.5,
    pe: 9999,
    taxRate: -1, // out-of-band tax -> clamped to >= 0
  });
  assert.equal(r.success, true);
  const data = r.data as GuidanceResult;
  assert.equal(data.available, true);
  assert.ok(Number.isFinite(data.baseEps!));
  assert.ok(Number.isFinite(data.bullEps!));
  assert.ok(Number.isFinite(data.bearEps!));
  assert.ok(data.assumptions!.taxRate >= 0); // clamped
  assert.equal(data.symbol, undefined); // no symbol supplied
});
