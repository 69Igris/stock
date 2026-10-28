import { test } from "node:test";
import assert from "node:assert/strict";

import { computeMonteCarloReturnsTool } from "../../../../packages/research/src/tools/compute-monte-carlo-returns";

// MONEY-543 - compute-monte-carlo-returns pure-function tests.
//
// The tool is a PURE compute tool (no network / db / io). It runs a
// Geometric-Brownian-Motion forward price simulation off a seeded mulberry32
// PRNG, so output is FULLY DETERMINISTIC for a given seed. Drift/vol are either
// derived from >=30 historical closes or accepted directly via
// annualizedReturn / annualizedVol overrides.
//
// Contract under test:
//  - genuine runtime exceptions → { success: false }
//  - graceful degradation       → { success: true, data: { available: false, reason } }
//      * currentPrice missing / non-positive
//      * sigma underivable (<30 closes AND no annualizedVol override)
//      * derived/provided annualizedVol <= 0
//  - happy path                 → { success: true, data: { available: true, ... } }
//
// The ToolOutput envelope stays success:true for every well-formed (and
// malformed-but-recoverable) input; the result self-reports availability.

async function run(args: Record<string, unknown>) {
  return computeMonteCarloReturnsTool.execute(args);
}

interface MonteCarloData {
  available: boolean;
  reason?: string;
  symbol?: string;
  currentPrice?: number;
  horizonDays?: number;
  simulations?: number;
  seed?: number;
  estimateSource?: "historical_closes" | "provided_annualized";
  annualizedReturn?: number;
  annualizedVol?: number;
  percentiles?: {
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
  };
  expectedTerminalPrice?: number;
  expectedReturn?: number;
  p5TerminalPrice?: number;
  probAboveCurrent?: number;
  probLossGt20?: number;
  probAboveTarget?: number;
  targetPrice?: number;
  observations: string[];
}

// A clean >=30-bar close series (drift/vol derived from it). A gentle repeating
// up/down ladder keeps the derived sigma positive and finite.
function syntheticCloses(n = 60): number[] {
  const out: number[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p = p * (1 + ((i % 5) - 2) * 0.005);
    out.push(p);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path — envelope success + available, key fields present + typed.
// ─────────────────────────────────────────────────────────────────────────────

test("happy path: success + available, key fields present with correct types", async () => {
  const r = await run({
    currentPrice: 100,
    annualizedReturn: 0.1,
    annualizedVol: 0.2,
    simulations: 1000,
    horizonDays: 252,
    seed: 42,
    symbol: "tcs",
  });

  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;

  assert.equal(d.available, true);
  // symbol echoed and trimmed (tool preserves case).
  assert.equal(d.symbol, "tcs");

  // run parameters echoed.
  assert.equal(d.currentPrice, 100);
  assert.equal(d.horizonDays, 252);
  assert.equal(d.simulations, 1000);
  assert.equal(d.seed, 42);
  assert.equal(d.estimateSource, "provided_annualized");

  // numeric fields with the right types.
  assert.equal(typeof d.annualizedReturn, "number");
  assert.equal(typeof d.annualizedVol, "number");
  assert.equal(typeof d.expectedTerminalPrice, "number");
  assert.equal(typeof d.expectedReturn, "number");
  assert.equal(typeof d.p5TerminalPrice, "number");
  assert.equal(typeof d.probAboveCurrent, "number");
  assert.equal(typeof d.probLossGt20, "number");

  // percentile cone present and ascending.
  assert.ok(d.percentiles, "percentiles present");
  const pc = d.percentiles!;
  for (const k of ["p5", "p25", "p50", "p75", "p95"] as const) {
    assert.equal(typeof pc[k], "number", `${k} is a number`);
  }
  assert.ok(pc.p5 <= pc.p25, "p5 <= p25");
  assert.ok(pc.p25 <= pc.p50, "p25 <= p50");
  assert.ok(pc.p50 <= pc.p75, "p50 <= p75");
  assert.ok(pc.p75 <= pc.p95, "p75 <= p95");

  // p5TerminalPrice mirrors the cone's p5.
  assert.equal(d.p5TerminalPrice, pc.p5);

  // probabilities are valid fractions in [0, 1].
  assert.ok(d.probAboveCurrent! >= 0 && d.probAboveCurrent! <= 1);
  assert.ok(d.probLossGt20! >= 0 && d.probLossGt20! <= 1);

  // observations is a non-empty array of strings, advisory-free.
  assert.ok(Array.isArray(d.observations));
  assert.ok(d.observations.length > 0);
  for (const o of d.observations) assert.equal(typeof o, "string");
  // No buy/sell/target advice language (SEBI: observations only).
  for (const o of d.observations) {
    assert.ok(
      !/\b(buy|sell|hold|target price|recommend)\b/i.test(o),
      `observation must be advice-free, got "${o}"`
    );
  }

  // targetPrice was not supplied → both target fields omitted.
  assert.equal(d.targetPrice, undefined);
  assert.equal(d.probAboveTarget, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. KNOWN-VALUE numeric assertions + determinism.
//
// With the seeded mulberry32 PRNG the canonical run is fully reproducible:
//   execute({ currentPrice: 100, annualizedReturn: 0.10, annualizedVol: 0.20,
//             simulations: 1000, horizonDays: 252, seed: 42 })
//   → p50 = 107.39, expectedTerminalPrice = 110.29,
//     probAboveCurrent = 0.655, probLossGt20 = 0.065
//
// A different seed (99) shifts p50 (108.6 here, != 107.39), proving the seed
// actually drives the draw. Degenerate vol → available:false.
// ─────────────────────────────────────────────────────────────────────────────

const CANONICAL = {
  currentPrice: 100,
  annualizedReturn: 0.1,
  annualizedVol: 0.2,
  simulations: 1000,
  horizonDays: 252,
  seed: 42,
} as const;

test("known values: seed 42 yields the documented deterministic statistics", async () => {
  const r = await run({ ...CANONICAL });
  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;
  assert.equal(d.available, true);

  // Echoed drift/vol survive the round4 the tool applies.
  assert.equal(d.annualizedReturn, 0.1);
  assert.equal(d.annualizedVol, 0.2);

  // Tight tolerances — the tool rounds p50/mean to 2dp, probs to 4dp.
  assert.ok(
    Math.abs(d.percentiles!.p50 - 107.39) < 1e-6,
    `p50 == 107.39, got ${d.percentiles!.p50}`
  );
  assert.ok(
    Math.abs(d.expectedTerminalPrice! - 110.29) < 1e-6,
    `expectedTerminalPrice == 110.29, got ${d.expectedTerminalPrice}`
  );
  assert.ok(
    Math.abs(d.probAboveCurrent! - 0.655) < 1e-6,
    `probAboveCurrent == 0.655, got ${d.probAboveCurrent}`
  );
  assert.ok(
    Math.abs(d.probLossGt20! - 0.065) < 1e-6,
    `probLossGt20 == 0.065, got ${d.probLossGt20}`
  );
});

test("known values: identical seed → byte-for-byte identical output across two runs", async () => {
  const a = await run({ ...CANONICAL });
  const b = await run({ ...CANONICAL });
  assert.equal(a.success, true);
  assert.equal(b.success, true);
  // Full structural equality proves the simulation is deterministic.
  assert.deepEqual(a.data, b.data);
});

test("known values: a different seed (99) produces a different p50", async () => {
  const seed42 = (await run({ ...CANONICAL })).data as MonteCarloData;
  const seed99 = (await run({ ...CANONICAL, seed: 99 })).data as MonteCarloData;

  assert.equal(seed42.available, true);
  assert.equal(seed99.available, true);
  // Seed 99 lands at 108.6 here — must differ from the seed-42 p50 (107.39).
  assert.notEqual(
    seed99.percentiles!.p50,
    seed42.percentiles!.p50,
    "different seed must shift the simulated p50"
  );
  // Spot-check the concrete seed-99 value the probe reported.
  assert.ok(
    Math.abs(seed99.percentiles!.p50 - 108.6) < 1e-6,
    `seed 99 p50 == 108.6, got ${seed99.percentiles!.p50}`
  );
});

test("known values: zero volatility degenerates to available:false with the exact reason", async () => {
  const r = await run({
    currentPrice: 100,
    annualizedReturn: 0.1,
    annualizedVol: 0,
    simulations: 100,
    horizonDays: 10,
  });
  // Graceful degradation — NOT a thrown exception.
  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;
  assert.equal(d.available, false);
  assert.equal(d.reason, "Volatility (sigma) underivable or non-positive");
  // Degraded payload is well-formed.
  assert.equal(d.currentPrice, 100);
  assert.deepEqual(d.observations, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Graceful degradation — available:false (NOT success:false).
// ─────────────────────────────────────────────────────────────────────────────

test("graceful degrade: missing currentPrice → available:false, reason set", async () => {
  const r = await run({ annualizedVol: 0.2 });
  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;
  assert.equal(d.available, false);
  assert.equal(d.reason, "currentPrice is missing or non-positive");
  assert.deepEqual(d.observations, []);
});

test("graceful degrade: non-positive currentPrice (0 and negative) → available:false", async () => {
  for (const currentPrice of [0, -50]) {
    const r = await run({ currentPrice, annualizedVol: 0.2 });
    assert.equal(r.success, true, `success for currentPrice=${currentPrice}`);
    const d = r.data as MonteCarloData;
    assert.equal(d.available, false, `available:false for ${currentPrice}`);
    assert.equal(typeof d.reason, "string");
  }
});

test("graceful degrade: <30 closes AND no annualizedVol override → sigma underivable", async () => {
  const r = await run({ currentPrice: 100, closes: [100, 101, 102] });
  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;
  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
  assert.ok(
    (d.reason as string).toLowerCase().includes("insufficient"),
    `reason should explain insufficient data, got "${d.reason}"`
  );
  // currentPrice still echoed on the degraded payload.
  assert.equal(d.currentPrice, 100);
});

test("graceful degrade: provided annualizedVol <= 0 (negative) → available:false", async () => {
  const r = await run({
    currentPrice: 100,
    annualizedReturn: 0.1,
    annualizedVol: -0.3,
  });
  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;
  assert.equal(d.available, false);
  assert.equal(d.reason, "Volatility (sigma) underivable or non-positive");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Edge cases — must not throw / must remain well-formed.
// ─────────────────────────────────────────────────────────────────────────────

test("edge: historical closes path derives drift/vol (estimateSource historical_closes)", async () => {
  const closes = syntheticCloses(60);
  const r = await run({
    currentPrice: closes[closes.length - 1],
    closes,
    simulations: 500,
    horizonDays: 60,
    seed: 7,
    symbol: "infy",
  });
  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;
  assert.equal(d.available, true);
  assert.equal(d.estimateSource, "historical_closes");
  assert.equal(d.symbol, "infy");
  // Derived vol must be strictly positive for the run to be available.
  assert.ok(d.annualizedVol! > 0, "derived sigma > 0");
});

test("edge: closes accepts {close:number} objects and ignores junk entries", async () => {
  // 40 object-form bars + interleaved junk that must be filtered out.
  const closes: unknown[] = [];
  let p = 100;
  for (let i = 0; i < 40; i++) {
    p = p * (1 + ((i % 4) - 1.5) * 0.004);
    closes.push({ close: p });
  }
  closes.push({ close: 0 }, { close: -1 }, { close: "x" }, null, undefined);

  const r = await run({ currentPrice: p, closes });
  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;
  assert.equal(d.available, true);
  assert.equal(d.estimateSource, "historical_closes");
});

test("edge: simulations/horizon coerced — 0 falls back to defaults, no throw", async () => {
  // The tool guards on `> 0`, so 0 (and any non-positive) reverts to defaults
  // (1000 sims, 252 days) rather than producing an empty run.
  const r = await run({
    currentPrice: 100,
    annualizedVol: 0.2,
    simulations: 0,
    horizonDays: 0,
    seed: 5,
  });
  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;
  assert.equal(d.available, true);
  assert.equal(d.simulations, 1000);
  assert.equal(d.horizonDays, 252);
});

test("edge: negative simulations/horizon also fall back to defaults", async () => {
  const r = await run({
    currentPrice: 100,
    annualizedVol: 0.2,
    simulations: -10,
    horizonDays: -5,
    seed: 5,
  });
  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;
  assert.equal(d.available, true);
  assert.equal(d.simulations, 1000);
  assert.equal(d.horizonDays, 252);
});

test("edge: huge simulations/horizon are clamped to the documented maxima", async () => {
  const r = await run({
    currentPrice: 100,
    annualizedVol: 0.2,
    simulations: 1_000_000, // > MAX_SIMULATIONS (50_000)
    horizonDays: 999_999, // > MAX_HORIZON_DAYS (252 * 10)
    seed: 1,
  });
  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;
  assert.equal(d.available, true);
  assert.equal(d.simulations, 50_000);
  assert.equal(d.horizonDays, 252 * 10);
});

test("edge: targetPrice supplied → probAboveTarget + targetPrice echoed", async () => {
  const r = await run({
    currentPrice: 100,
    annualizedReturn: 0.1,
    annualizedVol: 0.2,
    simulations: 500,
    horizonDays: 252,
    seed: 42,
    targetPrice: 120,
  });
  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;
  assert.equal(d.available, true);
  assert.equal(d.targetPrice, 120);
  assert.equal(typeof d.probAboveTarget, "number");
  assert.ok(d.probAboveTarget! >= 0 && d.probAboveTarget! <= 1);
});

test("edge: empty params object → graceful degrade (no throw, no exception envelope)", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;
  assert.equal(d.available, false);
  assert.equal(typeof d.reason, "string");
});

test("edge: empty-string symbol coalesced to undefined; minimum sims/horizon stay valid", async () => {
  const r = await run({
    currentPrice: 100,
    annualizedVol: 0.2,
    simulations: 1,
    horizonDays: 1,
    seed: 3,
    symbol: "   ",
  });
  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;
  assert.equal(d.available, true);
  assert.equal(d.symbol, undefined);
  // Minimum-but-valid run parameters survive the Math.max(1, ...) floor.
  assert.equal(d.simulations, 1);
  assert.equal(d.horizonDays, 1);
});

test("edge: string-numeric params are coerced (currentPrice / vol as strings)", async () => {
  const r = await run({
    currentPrice: "100",
    annualizedReturn: "0.1",
    annualizedVol: "0.2",
    simulations: "1000",
    horizonDays: "252",
    seed: "42",
  });
  assert.equal(r.success, true);
  const d = r.data as MonteCarloData;
  assert.equal(d.available, true);
  // Coerced strings reproduce the canonical numeric run exactly.
  assert.ok(Math.abs(d.percentiles!.p50 - 107.39) < 1e-6);
  assert.ok(Math.abs(d.expectedTerminalPrice! - 110.29) < 1e-6);
});
