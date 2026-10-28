import { test } from "node:test";
import assert from "node:assert/strict";

import { computePositionVarTool } from "../../../../packages/research/src/tools/compute-position-var";

// MONEY-543 - compute-position-var pure-function tests.
// Single-position VaR/CVaR from an instrument's own return distribution.
// All fixtures are deterministic (no randomness).

async function run(args: Record<string, unknown>) {
  return computePositionVarTool.execute(args);
}

// Shape of the success-path data payload (mirrors PositionVarResult).
interface VarData {
  available: boolean;
  reason?: string;
  symbol?: string;
  observations?: number;
  historicalVaR95?: number;
  historicalVaR99?: number;
  parametricVaR95?: number;
  parametricVaR99?: number;
  cvar95?: number;
  meanReturn?: number;
  dailySigma?: number;
  annualizedVol?: number;
  historicalVaR95_10d?: number;
  parametricVaR95_10d?: number;
  positionValue?: number;
  var95Amount1d?: number;
  var99Amount1d?: number;
  cvar95Amount1d?: number;
  var95Amount10d?: number;
  flags?: string[];
}

/**
 * Deterministic 60-day close series that yields realistic non-trivial daily
 * returns. Alternating small up/down drift around a rising base — enough
 * observations (>= 40 returns) to clear the MIN_OBSERVATIONS gate.
 */
function buildCloses(count: number): number[] {
  const closes: number[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    // Deterministic oscillation: +1.5% on even steps, -1% on odd steps.
    const factor = i % 2 === 0 ? 1.015 : 0.99;
    price = price * factor;
    closes.push(Math.round(price * 100) / 100);
  }
  return closes;
}

// 1. Happy path — closes[] derived series, available:true, key fields/types.
test("happy path: closes series returns available:true with typed fields", async () => {
  const closes = buildCloses(61); // 61 closes -> 60 log returns
  const r = await run({ closes, symbol: "tcs", positionValue: 250000 });

  assert.equal(r.success, true);
  const data = r.data as VarData;
  assert.equal(data.available, true);
  assert.equal(data.symbol, "TCS"); // upper-cased

  assert.equal(typeof data.observations, "number");
  assert.ok((data.observations ?? 0) >= 40);

  assert.equal(typeof data.historicalVaR95, "number");
  assert.equal(typeof data.historicalVaR99, "number");
  assert.equal(typeof data.parametricVaR95, "number");
  assert.equal(typeof data.parametricVaR99, "number");
  assert.equal(typeof data.cvar95, "number");
  assert.equal(typeof data.meanReturn, "number");
  assert.equal(typeof data.dailySigma, "number");
  assert.equal(typeof data.annualizedVol, "number");
  assert.equal(typeof data.historicalVaR95_10d, "number");
  assert.equal(typeof data.parametricVaR95_10d, "number");
  assert.ok(Array.isArray(data.flags));

  // positionValue supplied -> INR amounts present.
  assert.equal(typeof data.positionValue, "number");
  assert.equal(typeof data.var95Amount1d, "number");
  assert.equal(typeof data.var99Amount1d, "number");
  assert.equal(typeof data.cvar95Amount1d, "number");
  assert.equal(typeof data.var95Amount10d, "number");

  // Losses are reported as negative percentages.
  assert.ok((data.historicalVaR95 ?? 0) <= 0);
  assert.ok((data.historicalVaR99 ?? 0) <= 0);
  assert.ok((data.dailySigma ?? -1) > 0);
});

// 2. KNOWN-VALUE numeric assertion (tight tolerances).
//    returns = [-0.04,-0.03,-0.02,-0.01] followed by 36 zeros (n=40):
//      historicalVaR95 = -2   (sorted[floor(40*0.05)=2] = -0.02)
//      historicalVaR99 = -4   (sorted[0] = -0.04)
//      cvar95          = -3   (mean of three worst: -0.04,-0.03,-0.02)
//      annualizedVol   ≈ 13.33
//      positionValue 100000 -> var95Amount1d = 2000, var95Amount10d = 6325
test("known values: fixed return distribution produces exact VaR figures", async () => {
  const returns = [-0.04, -0.03, -0.02, -0.01, ...Array<number>(36).fill(0)];
  assert.equal(returns.length, 40);

  const r = await run({ returns, positionValue: 100000, symbol: "FIX" });
  assert.equal(r.success, true);

  const data = r.data as VarData;
  assert.equal(data.available, true);
  assert.equal(data.observations, 40);

  // Percent fields (negative = loss).
  assert.ok(
    Math.abs((data.historicalVaR95 ?? NaN) - -2) < 1e-9,
    `historicalVaR95 should be -2, got ${data.historicalVaR95}`
  );
  assert.ok(
    Math.abs((data.historicalVaR99 ?? NaN) - -4) < 1e-9,
    `historicalVaR99 should be -4, got ${data.historicalVaR99}`
  );
  assert.ok(
    Math.abs((data.cvar95 ?? NaN) - -3) < 1e-9,
    `cvar95 should be -3, got ${data.cvar95}`
  );

  // annualizedVol ≈ 13.33 (percent).
  assert.ok(
    Math.abs((data.annualizedVol ?? NaN) - 13.33) < 0.01,
    `annualizedVol should be ~13.33, got ${data.annualizedVol}`
  );

  // meanReturn = -0.1 / 40 = -0.0025 (round4).
  assert.ok(
    Math.abs((data.meanReturn ?? NaN) - -0.0025) < 1e-9,
    `meanReturn should be -0.0025, got ${data.meanReturn}`
  );

  // INR amounts at the 1-day and 10-day (sqrt-time) horizons.
  assert.equal(data.positionValue, 100000);
  assert.equal(data.var95Amount1d, 2000); // 0.02 * 100000
  assert.equal(data.var99Amount1d, 4000); // 0.04 * 100000
  assert.equal(data.var95Amount10d, 6325); // 2000 * sqrt(10) ≈ 6324.5 -> round
});

// 3a. Graceful degradation — too few observations from returns[].
//     Returns success:true with available:false + reason; NOT success:false.
test("graceful: <40 returns yields available:false with reason (not success:false)", async () => {
  const returns = Array.from({ length: 10 }, () => -0.01); // 10 < 40
  const r = await run({ returns, symbol: "shrt" });

  assert.equal(r.success, true);
  const data = r.data as VarData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok((data.reason ?? "").length > 0);
  assert.ok(
    /40/.test(data.reason ?? ""),
    "reason should mention the 40 minimum"
  );
  assert.equal(data.symbol, "SHRT");
});

// 3b. Graceful degradation — too few derivable returns from closes[].
test("graceful: short closes series cannot derive 40 returns -> available:false", async () => {
  const closes = buildCloses(20); // 20 closes -> 19 returns < 40
  const r = await run({ closes });

  assert.equal(r.success, true);
  const data = r.data as VarData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
});

// 3c. Graceful degradation — no data at all (neither closes nor returns).
test("graceful: no inputs at all -> available:false, never throws", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const data = r.data as VarData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
});

// 4a. Edge case — empty arrays must not throw.
test("edge: empty arrays do not throw, return available:false", async () => {
  const r = await run({ closes: [], returns: [] });
  assert.equal(r.success, true);
  const data = r.data as VarData;
  assert.equal(data.available, false);
});

// 4b. Edge case — non-finite / non-numeric entries are filtered out.
test("edge: non-numeric and non-finite entries are sanitized", async () => {
  const returns = [
    "not-a-number",
    null,
    undefined,
    NaN,
    Infinity,
    -Infinity,
    -0.02,
    -0.01,
  ];
  // Only 2 finite values survive -> below MIN_OBSERVATIONS -> available:false.
  const r = await run({ returns });
  assert.equal(r.success, true);
  const data = r.data as VarData;
  assert.equal(data.available, false);
});

// 4c. Edge case — zero/negative closes are skipped when deriving log returns.
test("edge: zero/negative closes are skipped without throwing", async () => {
  const good = buildCloses(45); // 45 closes -> would give 44 returns
  // Inject a zero and a negative; both adjacent pairs are dropped.
  const closes = [...good, 0, -5, 110, 111];
  const r = await run({ closes });
  assert.equal(r.success, true);
  const data = r.data as VarData;
  // Still enough valid returns from the leading clean run.
  assert.equal(data.available, true);
  assert.ok((data.observations ?? 0) >= 40);
});

// 4d. Edge case — returns[] takes precedence over closes[].
test("edge: returns[] takes precedence over closes[]", async () => {
  const returns = [-0.04, -0.03, -0.02, -0.01, ...Array<number>(36).fill(0)];
  const closes = buildCloses(200); // would yield very different stats
  const r = await run({ returns, closes });
  assert.equal(r.success, true);
  const data = r.data as VarData;
  assert.equal(data.available, true);
  assert.equal(data.observations, 40); // from returns, not closes (199)
  assert.ok(Math.abs((data.historicalVaR95 ?? NaN) - -2) < 1e-9);
});

// 4e. Edge case — missing/invalid positionValue omits INR amounts (no throw).
test("edge: missing positionValue omits INR amounts", async () => {
  const returns = [-0.04, -0.03, -0.02, -0.01, ...Array<number>(36).fill(0)];
  const r = await run({ returns }); // no positionValue
  assert.equal(r.success, true);
  const data = r.data as VarData;
  assert.equal(data.available, true);
  assert.equal(data.positionValue, undefined);
  assert.equal(data.var95Amount1d, undefined);
  assert.equal(data.var95Amount10d, undefined);
});

// 4f. Edge case — zero/negative positionValue is treated as absent.
test("edge: non-positive positionValue is treated as absent", async () => {
  const returns = [-0.04, -0.03, -0.02, -0.01, ...Array<number>(36).fill(0)];
  const rZero = await run({ returns, positionValue: 0 });
  assert.equal(rZero.success, true);
  assert.equal((rZero.data as VarData).var95Amount1d, undefined);

  const rNeg = await run({ returns, positionValue: -100000 });
  assert.equal(rNeg.success, true);
  assert.equal((rNeg.data as VarData).var95Amount1d, undefined);
});

// 4g. Edge case — flat (all-zero) returns: sigma=0, no throw, available:true.
test("edge: flat all-zero returns produce zero risk metrics, no throw", async () => {
  const returns = Array<number>(50).fill(0);
  const r = await run({ returns, positionValue: 100000 });
  assert.equal(r.success, true);
  const data = r.data as VarData;
  assert.equal(data.available, true);
  assert.equal(data.observations, 50);
  assert.equal(data.dailySigma, 0);
  assert.equal(data.annualizedVol, 0);
  assert.equal(data.historicalVaR95, 0);
  assert.equal(data.var95Amount1d, 0);
});
