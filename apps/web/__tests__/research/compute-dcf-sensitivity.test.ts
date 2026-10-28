/**
 * DCF Sensitivity Tool Tests
 * (packages/research/src/tools/compute-dcf-sensitivity.ts)
 *
 * Pure compute tool — no network/db/io. Tests exercise the public
 * `computeDcfSensitivityTool.execute(args)` contract:
 *   1. Happy path → success:true, data.available:true, key fields + types.
 *   2. Known-value numeric assertion (tight float tolerances). The base cell
 *      reconciles with compute_dcf's multi-stage math.
 *   3. Graceful degradation → success:true + data.available:false + reason
 *      (missing FCF / missing discount axis / missing shares / undefined base).
 *   4. Edge cases (zero/negative/short/missing optionals) — no throw.
 *
 * All cases are deterministic: the tool is a pure function of its inputs with
 * no randomness, clock, or IO dependency.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDcfSensitivityTool } from "../../../../packages/research/src/tools/compute-dcf-sensitivity";

// ── Shape helpers ──────────────────────────────────────────────────

interface DcfSensitivityCell {
  discountRate: number;
  variable: number;
  intrinsicValue: number;
  upside: number;
  valid: boolean;
}

interface DcfSensitivityData {
  available: boolean;
  reason?: string;
  symbol?: string;
  intrinsicValue?: number;
  currentPrice?: number;
  upside?: number;
  marginOfSafety?: number;
  base?: {
    discountRate: number;
    terminalGrowthRate: number;
    fcfGrowthRate: number;
    fcf: number;
    projectionYears: number;
    sharesOutstanding: number;
  };
  discountRateAxis?: number[];
  terminalGrowthAxis?: number[];
  fcfGrowthAxis?: number[];
  matrixA?: DcfSensitivityCell[][];
  matrixB?: DcfSensitivityCell[][];
  fairValueRange?: { min: number; max: number };
  rangeWidthPercent?: number;
  flags?: string[];
}

async function run(args: Record<string, unknown>) {
  return computeDcfSensitivityTool.execute(args);
}

const APPROX = 1e-9;
function near(actual: number, expected: number, tol = APPROX): boolean {
  return Math.abs(actual - expected) <= tol;
}

// ── 1. Tool metadata sanity ────────────────────────────────────────

test("tool exposes expected metadata", () => {
  assert.equal(computeDcfSensitivityTool.name, "compute_dcf_sensitivity");
  assert.equal(computeDcfSensitivityTool.category, "computation");
  assert.equal(typeof computeDcfSensitivityTool.execute, "function");
  // The compute_dcf assumptions blob is the primary input channel.
  assert.ok(computeDcfSensitivityTool.parameters.dcfAssumptions);
  assert.ok(computeDcfSensitivityTool.parameters.wacc);
});

// ── 2. Happy path: success + available + field presence/types ──────

test("happy path returns available result with typed key fields", async () => {
  const r = await run({
    symbol: "tcs.ns",
    dcfAssumptions: {
      fcf: 250,
      growthRate: 0.1,
      terminalGrowthRate: 0.04,
      discountRate: 0.11,
      projectionYears: 8,
    },
    wacc: 0.11,
    currentPrice: 3000,
    sharesOutstanding: 100,
  });

  assert.equal(r.success, true);
  const data = r.data as DcfSensitivityData;
  assert.equal(data.available, true);

  // Symbol is normalized: suffix stripped + uppercased.
  assert.equal(data.symbol, "TCS");

  // Numeric headline fields present and finite numbers.
  assert.equal(typeof data.intrinsicValue, "number");
  assert.ok(Number.isFinite(data.intrinsicValue!));
  assert.equal(typeof data.currentPrice, "number");
  assert.equal(typeof data.upside, "number");
  assert.equal(typeof data.marginOfSafety, "number");
  assert.equal(typeof data.rangeWidthPercent, "number");

  // Base assumptions object echoed back.
  assert.ok(data.base);
  assert.equal(typeof data.base!.discountRate, "number");
  assert.equal(typeof data.base!.terminalGrowthRate, "number");
  assert.equal(typeof data.base!.fcfGrowthRate, "number");
  assert.equal(typeof data.base!.fcf, "number");
  assert.equal(typeof data.base!.projectionYears, "number");
  assert.equal(typeof data.base!.sharesOutstanding, "number");
  assert.equal(data.base!.projectionYears, 8);
  assert.equal(data.base!.sharesOutstanding, 100);

  // Axes are arrays.
  assert.ok(Array.isArray(data.discountRateAxis));
  assert.ok(Array.isArray(data.terminalGrowthAxis));
  assert.ok(Array.isArray(data.fcfGrowthAxis));
  assert.equal(data.terminalGrowthAxis!.length, 3);
  assert.equal(data.fcfGrowthAxis!.length, 3);

  // Matrices: rows = discount axis length, cols = 3.
  assert.ok(Array.isArray(data.matrixA));
  assert.ok(Array.isArray(data.matrixB));
  assert.equal(data.matrixA!.length, data.discountRateAxis!.length);
  assert.equal(data.matrixB!.length, data.discountRateAxis!.length);
  assert.equal(data.matrixA![0].length, data.terminalGrowthAxis!.length);
  assert.equal(data.matrixB![0].length, data.fcfGrowthAxis!.length);

  // A representative cell has the documented shape.
  const cell = data.matrixA![0][0];
  assert.equal(typeof cell.discountRate, "number");
  assert.equal(typeof cell.variable, "number");
  assert.equal(typeof cell.intrinsicValue, "number");
  assert.equal(typeof cell.upside, "number");
  assert.equal(typeof cell.valid, "boolean");

  // Fair value range + flags.
  assert.ok(data.fairValueRange);
  assert.equal(typeof data.fairValueRange!.min, "number");
  assert.equal(typeof data.fairValueRange!.max, "number");
  assert.ok(data.fairValueRange!.min <= data.fairValueRange!.max);
  assert.ok(Array.isArray(data.flags));
  assert.ok(data.flags!.length >= 1);
});

// ── 3. KNOWN-VALUE numeric assertion ───────────────────────────────
// fcf=100, g=0.12, tg=0.03, discountRate=0.10, years=10, wacc=0.10,
// currentPrice=120, shares=1000. Base cell reconciles with compute_dcf.

test("known-value: full grid reconciles with compute_dcf math", async () => {
  const r = await run({
    dcfAssumptions: {
      fcf: 100,
      growthRate: 0.12,
      terminalGrowthRate: 0.03,
      discountRate: 0.1,
      projectionYears: 10,
    },
    wacc: 0.1,
    currentPrice: 120,
    sharesOutstanding: 1000,
  });

  assert.equal(r.success, true);
  const data = r.data as DcfSensitivityData;
  assert.equal(data.available, true);

  // Base intrinsic value (multi-stage Gordon DCF / shares).
  assert.ok(
    near(data.intrinsicValue!, 2.87, 1e-9),
    `iv=${data.intrinsicValue}`
  );

  // Axes — exact (round to 5dp inside the tool; 0.1 === 0.10 numerically).
  assert.deepEqual(
    data.discountRateAxis,
    [0.085, 0.09, 0.095, 0.1, 0.105, 0.11, 0.115]
  );
  assert.deepEqual(data.terminalGrowthAxis, [0.02, 0.03, 0.04]);
  assert.deepEqual(data.fcfGrowthAxis, [0.1, 0.12, 0.14]);

  // Matrices 7 x 3.
  assert.equal(data.matrixA!.length, 7);
  assert.equal(data.matrixB!.length, 7);
  for (const row of data.matrixA!) assert.equal(row.length, 3);
  for (const row of data.matrixB!) assert.equal(row.length, 3);

  // All 42 cells valid here (wacc always > terminal growth on this grid).
  const allCells = [...data.matrixA!.flat(), ...data.matrixB!.flat()];
  assert.equal(allCells.length, 42);
  assert.ok(allCells.every((c) => c.valid));

  // Fair value range across all valid cells.
  assert.ok(
    near(data.fairValueRange!.min, 1.99, 1e-9),
    `min=${data.fairValueRange!.min}`
  );
  assert.ok(
    near(data.fairValueRange!.max, 4.4, 1e-9),
    `max=${data.fairValueRange!.max}`
  );

  // Range width (~84% of base IV).
  assert.ok(
    near(data.rangeWidthPercent!, 84, 1e-9),
    `rw=${data.rangeWidthPercent}`
  );

  // Base assumptions echoed.
  assert.ok(near(data.base!.discountRate, 0.1));
  assert.ok(near(data.base!.terminalGrowthRate, 0.03));
  assert.ok(near(data.base!.fcfGrowthRate, 0.12));
  assert.equal(data.base!.fcf, 100);
  assert.equal(data.base!.projectionYears, 10);
  assert.equal(data.base!.sharesOutstanding, 1000);

  // Flags: extremely sensitive (84% swing) + price above the whole range.
  assert.ok(
    data.flags!.some((f) => /extremely sensitive/i.test(f)),
    `flags=${JSON.stringify(data.flags)}`
  );
  assert.ok(
    data.flags!.some((f) =>
      /Current price sits above the entire DCF fair-value range/i.test(f)
    ),
    `flags=${JSON.stringify(data.flags)}`
  );
});

test("known-value: base cell of matrixA equals headline intrinsicValue", async () => {
  const r = await run({
    dcfAssumptions: {
      fcf: 100,
      growthRate: 0.12,
      terminalGrowthRate: 0.03,
      discountRate: 0.1,
      projectionYears: 10,
    },
    wacc: 0.1,
    currentPrice: 120,
    sharesOutstanding: 1000,
  });
  const data = r.data as DcfSensitivityData;
  // base WACC = 0.10 is index 3 on the discount axis; base tg = 0.03 is col 1.
  const baseRow = data.discountRateAxis!.findIndex((w) => near(w, 0.1));
  const baseCol = data.terminalGrowthAxis!.findIndex((tg) => near(tg, 0.03));
  assert.equal(baseRow, 3);
  assert.equal(baseCol, 1);
  const baseCell = data.matrixA![baseRow][baseCol];
  assert.ok(near(baseCell.intrinsicValue, data.intrinsicValue!, 1e-9));
});

// ── 4. Graceful degradation (success:true, available:false, reason) ─

test("graceful: base fcf missing → available:false with reason", async () => {
  const r = await run({
    dcfAssumptions: {
      // fcf omitted
      growthRate: 0.12,
      terminalGrowthRate: 0.03,
      discountRate: 0.1,
      projectionYears: 10,
    },
    wacc: 0.1,
    currentPrice: 120,
    sharesOutstanding: 1000,
    symbol: "infy.ns",
  });

  assert.equal(r.success, true); // NOT success:false
  const data = r.data as DcfSensitivityData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(/free cash flow/i.test(data.reason!), data.reason);
  assert.equal(data.symbol, "INFY");
});

test("graceful: neither wacc nor discountRate → available:false", async () => {
  const r = await run({
    dcfAssumptions: {
      fcf: 100,
      growthRate: 0.12,
      terminalGrowthRate: 0.03,
      // discountRate omitted
      projectionYears: 10,
    },
    // wacc omitted
    currentPrice: 120,
    sharesOutstanding: 1000,
  });

  assert.equal(r.success, true);
  const data = r.data as DcfSensitivityData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(/discount/i.test(data.reason!), data.reason);
});

test("graceful: shares missing and not derivable → available:false", async () => {
  const r = await run({
    dcfAssumptions: {
      fcf: 100,
      growthRate: 0.12,
      terminalGrowthRate: 0.03,
      discountRate: 0.1,
      projectionYears: 10,
    },
    wacc: 0.1,
    currentPrice: 120,
    // sharesOutstanding omitted, no marketCap → not derivable
  });

  assert.equal(r.success, true);
  const data = r.data as DcfSensitivityData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(/shares/i.test(data.reason!), data.reason);
});

test("graceful: base DCF undefined when wacc <= terminal growth → available:false", async () => {
  const r = await run({
    dcfAssumptions: {
      fcf: 100,
      growthRate: 0.12,
      terminalGrowthRate: 0.08, // tg >= base wacc → model undefined
      discountRate: 0.06,
      projectionYears: 10,
    },
    wacc: 0.06, // baseWacc 0.06 <= tg 0.08
    currentPrice: 120,
    sharesOutstanding: 1000,
  });

  assert.equal(r.success, true);
  const data = r.data as DcfSensitivityData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(/undefined|terminal growth/i.test(data.reason!), data.reason);
});

// ── 5. Derivation + flags ──────────────────────────────────────────

test("shares derived from marketCap / currentPrice when not supplied", async () => {
  const r = await run({
    dcfAssumptions: {
      fcf: 100,
      growthRate: 0.12,
      terminalGrowthRate: 0.03,
      discountRate: 0.1,
      projectionYears: 10,
    },
    wacc: 0.1,
    currentPrice: 120,
    marketCap: 120000, // → 1000 shares
  });

  assert.equal(r.success, true);
  const data = r.data as DcfSensitivityData;
  assert.equal(data.available, true);
  assert.equal(data.base!.sharesOutstanding, 1000); // 120000 / 120
});

test("price below the entire range emits the conservative flag", async () => {
  // Very low currentPrice → below min of fair-value range.
  const r = await run({
    dcfAssumptions: {
      fcf: 100,
      growthRate: 0.12,
      terminalGrowthRate: 0.03,
      discountRate: 0.1,
      projectionYears: 10,
    },
    wacc: 0.1,
    currentPrice: 0.5, // below min (~1.99)
    sharesOutstanding: 1000,
  });

  assert.equal(r.success, true);
  const data = r.data as DcfSensitivityData;
  assert.equal(data.available, true);
  assert.ok(
    data.flags!.some((f) =>
      /Current price sits below the entire DCF fair-value range/i.test(f)
    ),
    `flags=${JSON.stringify(data.flags)}`
  );
});

// ── 6. Edge cases — must not throw ─────────────────────────────────

test("edge: empty params object does not throw and degrades", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const data = r.data as DcfSensitivityData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
});

test("edge: zero / negative shares → available:false, no throw", async () => {
  const rZero = await run({
    dcfAssumptions: {
      fcf: 100,
      growthRate: 0.12,
      terminalGrowthRate: 0.03,
      discountRate: 0.1,
      projectionYears: 10,
    },
    wacc: 0.1,
    currentPrice: 120,
    sharesOutstanding: 0,
  });
  assert.equal(rZero.success, true);
  assert.equal((rZero.data as DcfSensitivityData).available, false);

  const rNeg = await run({
    dcfAssumptions: {
      fcf: 100,
      growthRate: 0.12,
      terminalGrowthRate: 0.03,
      discountRate: 0.1,
      projectionYears: 10,
    },
    wacc: 0.1,
    currentPrice: 120,
    sharesOutstanding: -50,
  });
  assert.equal(rNeg.success, true);
  assert.equal((rNeg.data as DcfSensitivityData).available, false);
});

test("edge: missing currentPrice → upside/margin default to 0, no throw", async () => {
  const r = await run({
    dcfAssumptions: {
      fcf: 100,
      growthRate: 0.12,
      terminalGrowthRate: 0.03,
      discountRate: 0.1,
      projectionYears: 10,
    },
    wacc: 0.1,
    // currentPrice omitted
    sharesOutstanding: 1000,
  });

  assert.equal(r.success, true);
  const data = r.data as DcfSensitivityData;
  assert.equal(data.available, true);
  assert.equal(data.upside, 0);
  // currentPrice absent → no price-vs-range flag, but sensitivity flag present.
  assert.equal(data.currentPrice, undefined);
  assert.ok(data.flags!.length >= 1);
  assert.ok(
    !data.flags!.some((f) => /Current price sits/i.test(f)),
    `flags=${JSON.stringify(data.flags)}`
  );
});

test("edge: tiny projectionYears (clamped to >=1) + low growth → stable", async () => {
  // Low growth, low terminal growth, single projection year keeps the grid
  // tightly clustered → relatively-stable flag rather than extremely-sensitive.
  const r = await run({
    dcfAssumptions: {
      fcf: 100,
      growthRate: 0.02,
      terminalGrowthRate: 0.02,
      discountRate: 0.12,
      projectionYears: 0, // Math.max(1, round(0)) → 1
    },
    wacc: 0.12,
    currentPrice: 8,
    sharesOutstanding: 100,
  });

  assert.equal(r.success, true);
  const data = r.data as DcfSensitivityData;
  assert.equal(data.available, true);
  assert.equal(data.base!.projectionYears, 1);
  assert.ok(Number.isFinite(data.intrinsicValue!));
  assert.ok(Number.isFinite(data.rangeWidthPercent!));
});

test("edge: string-numeric assumptions are coerced, not thrown", async () => {
  // num() coerces finite numeric strings.
  const r = await run({
    dcfAssumptions: {
      fcf: "100",
      growthRate: "0.12",
      terminalGrowthRate: "0.03",
      discountRate: "0.1",
      projectionYears: "10",
    },
    wacc: "0.1",
    currentPrice: "120",
    sharesOutstanding: "1000",
  });

  assert.equal(r.success, true);
  const data = r.data as DcfSensitivityData;
  assert.equal(data.available, true);
  assert.ok(
    near(data.intrinsicValue!, 2.87, 1e-9),
    `iv=${data.intrinsicValue}`
  );
});

test("edge: some grid cells invalid (low WACC near tg) records skipped flag", async () => {
  // base wacc 0.05, terminal growth 0.04. Lower discount-axis cells
  // (0.035, 0.04) fall to/under tg → invalid; the skipped-cells flag appears,
  // but the base cell (wacc 0.05 > tg 0.04) is valid so available stays true.
  const r = await run({
    dcfAssumptions: {
      fcf: 100,
      growthRate: 0.08,
      terminalGrowthRate: 0.04,
      discountRate: 0.05,
      projectionYears: 10,
    },
    wacc: 0.05,
    currentPrice: 50,
    sharesOutstanding: 1000,
  });

  assert.equal(r.success, true);
  const data = r.data as DcfSensitivityData;
  assert.equal(data.available, true);
  const allCells = [...data.matrixA!.flat(), ...data.matrixB!.flat()];
  const invalidCount = allCells.filter((c) => !c.valid).length;
  assert.ok(invalidCount > 0, "expected some invalid cells");
  assert.ok(
    data.flags!.some((f) => /grid cell\(s\) omitted/i.test(f)),
    `flags=${JSON.stringify(data.flags)}`
  );
});
