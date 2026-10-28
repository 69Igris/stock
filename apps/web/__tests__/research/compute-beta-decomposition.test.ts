import { test } from "node:test";
import assert from "node:assert/strict";

import { computeBetaDecompositionTool } from "../../../../packages/research/src/tools/compute-beta-decomposition";

// MONEY-543 - compute_beta_decomposition pure-function tests.
// The tool decomposes market beta vs a benchmark into systematic/idiosyncratic
// vol, bull/bear regime betas, up/down capture, and a rolling beta trend.

async function run(args: Record<string, unknown>) {
  return computeBetaDecompositionTool.execute(args);
}

interface BetaData {
  available: boolean;
  reason?: string;
  symbol?: string;
  observations?: number;
  beta?: number;
  correlation?: number;
  r2?: number;
  stockAnnualizedVol?: number;
  benchmarkAnnualizedVol?: number;
  systematicVol?: number;
  idiosyncraticVol?: number;
  bullBeta?: number | null;
  bearBeta?: number | null;
  downsideAsymmetry?: number | null;
  upCapture?: number | null;
  downCapture?: number | null;
  rollingBetaRecent?: number | null;
  betaTrend?: "rising" | "falling" | "stable";
  sensitivity?: "defensive" | "market" | "aggressive";
  observationsText?: string[];
}

// --- shared deterministic fixtures -----------------------------------------

// 21 paired observations: benchmark alternates ±1% starting positive ->
// 11 up-days, 10 down-days (both >= the 10-day regime minimum).
const ALT_BENCH = Array.from({ length: 21 }, (_, i) =>
  i % 2 === 0 ? 0.01 : -0.01
);
// Stock = exactly 2x benchmark -> perfect linear relationship.
const ALT_STOCK_2X = ALT_BENCH.map((b) => b * 2);

// 1. Happy path: representative (non-degenerate) inputs.
test("happy path: available with all key fields and correct types", async () => {
  // A modestly noisy stock that tracks the benchmark but not perfectly.
  const bench = Array.from(
    { length: 80 },
    (_, i) => Math.sin(i / 3) * 0.012 + Math.cos(i / 7) * 0.004
  );
  const stock = bench.map((b, i) => b * 1.3 + (i % 2 === 0 ? 0.002 : -0.0015));

  const r = await run({
    symbol: "INFY",
    stockReturns: stock,
    benchmarkReturns: bench,
  });

  assert.equal(r.success, true);
  const d = r.data as BetaData;
  assert.equal(d.available, true);
  assert.equal(d.symbol, "INFY");

  // Numeric core fields present + finite numbers.
  for (const k of [
    "observations",
    "beta",
    "correlation",
    "r2",
    "stockAnnualizedVol",
    "benchmarkAnnualizedVol",
    "systematicVol",
    "idiosyncraticVol",
  ] as const) {
    assert.equal(typeof d[k], "number", `${k} should be a number`);
    assert.ok(Number.isFinite(d[k] as number), `${k} should be finite`);
  }

  assert.equal(d.observations, 80);
  // r2 is a correlation^2 so it must be within [0, 1].
  assert.ok((d.r2 as number) >= 0 && (d.r2 as number) <= 1);
  // correlation within [-1, 1].
  assert.ok((d.correlation as number) >= -1 && (d.correlation as number) <= 1);

  // Categorical fields.
  assert.ok(["defensive", "market", "aggressive"].includes(d.sensitivity!));
  assert.ok(["rising", "falling", "stable"].includes(d.betaTrend!));

  // observationsText is a non-empty string array.
  assert.ok(Array.isArray(d.observationsText));
  assert.ok((d.observationsText as string[]).length > 0);
  for (const line of d.observationsText as string[]) {
    assert.equal(typeof line, "string");
  }

  // Regime betas: either a finite number or explicitly null.
  for (const k of ["bullBeta", "bearBeta", "downsideAsymmetry"] as const) {
    const v = d[k];
    assert.ok(v === null || typeof v === "number", `${k} number-or-null`);
  }
});

// 2. KNOWN-VALUE assertion: stock = 2x benchmark over 21 paired obs.
test("known values: stock = 2x benchmark yields beta 2, correlation 1, r2 1", async () => {
  const r = await run({
    symbol: "TCS",
    stockReturns: ALT_STOCK_2X,
    benchmarkReturns: ALT_BENCH,
  });

  assert.equal(r.success, true);
  const d = r.data as BetaData;
  assert.equal(d.available, true);
  assert.equal(d.observations, 21);

  const TOL = 1e-6;
  assert.ok(Math.abs((d.beta as number) - 2) < TOL, `beta ${d.beta}`);
  assert.ok(
    Math.abs((d.correlation as number) - 1) < TOL,
    `correlation ${d.correlation}`
  );
  assert.ok(Math.abs((d.r2 as number) - 1) < TOL, `r2 ${d.r2}`);

  // Perfect fit -> no stock-specific (idiosyncratic) risk.
  assert.ok(
    Math.abs(d.idiosyncraticVol as number) < TOL,
    `idiosyncraticVol ${d.idiosyncraticVol}`
  );
  // With r2 == 1, systematic vol equals the full stock annualized vol.
  assert.ok(
    Math.abs((d.systematicVol as number) - (d.stockAnnualizedVol as number)) <
      TOL,
    `systematicVol ${d.systematicVol} vs stockVol ${d.stockAnnualizedVol}`
  );

  // 11 up-days, 10 down-days -> both regimes computed, both = 2.0, no skew.
  assert.equal(d.bullBeta, 2);
  assert.equal(d.bearBeta, 2);
  assert.equal(d.downsideAsymmetry, 0);

  // beta 2.0 > 1.15 threshold.
  assert.equal(d.sensitivity, "aggressive");
});

// 3a. Graceful degradation: benchmark series missing entirely.
test("graceful: no benchmark series -> available false, success true", async () => {
  const r = await run({
    symbol: "HDFC",
    stockReturns: Array.from({ length: 30 }, () => 0.01),
    // no benchmarkReturns / benchmarkCloses
  });
  assert.equal(r.success, true);
  const d = r.data as BetaData;
  assert.equal(d.available, false);
  assert.equal(d.reason, "no benchmark series");
  assert.equal(d.symbol, "HDFC");
  assert.equal(typeof d.reason, "string");
});

// 3b. Graceful degradation: stock series missing entirely.
test("graceful: no stock return series -> available false, success true", async () => {
  const r = await run({
    symbol: "WIPRO",
    benchmarkReturns: Array.from({ length: 30 }, () => 0.005),
    // no stockReturns / stockCloses
  });
  assert.equal(r.success, true);
  const d = r.data as BetaData;
  assert.equal(d.available, false);
  assert.equal(d.reason, "no stock return series");
  assert.equal(d.symbol, "WIPRO");
});

// 3c. Graceful degradation: fewer than 20 paired observations.
test("graceful: <20 paired observations -> available false with count in reason", async () => {
  const r = await run({
    symbol: "ITC",
    stockReturns: Array.from({ length: 12 }, (_, i) => (i % 2 ? 0.01 : -0.01)),
    benchmarkReturns: Array.from({ length: 12 }, (_, i) =>
      i % 2 ? 0.01 : -0.01
    ),
  });
  assert.equal(r.success, true);
  const d = r.data as BetaData;
  assert.equal(d.available, false);
  // n = min(12, 12) = 12.
  assert.equal(d.reason, "only 12 paired observations (need 20)");
});

// 3d. Pairing uses the shorter series length when arrays differ.
test("graceful: paired count is the shorter series; <20 short side gates", async () => {
  const r = await run({
    symbol: "SBIN",
    stockReturns: Array.from({ length: 5 }, () => 0.01),
    benchmarkReturns: Array.from({ length: 50 }, () => 0.01),
  });
  assert.equal(r.success, true);
  const d = r.data as BetaData;
  assert.equal(d.available, false);
  assert.equal(d.reason, "only 5 paired observations (need 20)");
});

// 4a. Edge: closes are accepted and converted to returns (no explicit returns).
test("edge: derives returns from closes when returns absent", async () => {
  // 22 closes -> 21 returns each side; reuse the 2x relationship via prices.
  // Build benchmark closes that produce alternating ±1% returns, stock closes 2x-ish.
  // Simpler: feed enough monotone-ish closes to clear the 20-obs gate.
  const benchCloses = Array.from({ length: 30 }, (_, i) => 100 + i);
  const stockCloses = Array.from({ length: 30 }, (_, i) => 200 + i * 2);
  const r = await run({
    symbol: "RELI",
    stockCloses,
    benchmarkCloses: benchCloses,
  });
  assert.equal(r.success, true);
  const d = r.data as BetaData;
  assert.equal(d.available, true);
  // 30 closes -> 29 returns.
  assert.equal(d.observations, 29);
  assert.ok(Number.isFinite(d.beta as number));
});

// 4b. Edge: empty arrays everywhere must not throw; degrades gracefully.
test("edge: all-empty inputs degrade without throwing", async () => {
  const r = await run({
    stockReturns: [],
    benchmarkReturns: [],
    stockCloses: [],
    benchmarkCloses: [],
  });
  assert.equal(r.success, true);
  const d = r.data as BetaData;
  assert.equal(d.available, false);
  // benchmark is checked first.
  assert.equal(d.reason, "no benchmark series");
});

// 4c. Edge: missing optional symbol -> symbol omitted, still computes.
test("edge: missing symbol field still computes (symbol undefined)", async () => {
  const r = await run({
    stockReturns: ALT_STOCK_2X,
    benchmarkReturns: ALT_BENCH,
  });
  assert.equal(r.success, true);
  const d = r.data as BetaData;
  assert.equal(d.available, true);
  assert.equal(d.symbol, undefined);
  assert.ok(Math.abs((d.beta as number) - 2) < 1e-6);
});

// 4d. Edge: zero-variance benchmark -> beta 0 (varB == 0 guard), no throw.
test("edge: flat (zero-variance) benchmark -> beta 0, defensive, no throw", async () => {
  const r = await run({
    symbol: "FLAT",
    stockReturns: Array.from({ length: 25 }, (_, i) => (i % 2 ? 0.01 : -0.01)),
    benchmarkReturns: Array.from({ length: 25 }, () => 0.0), // constant
  });
  assert.equal(r.success, true);
  const d = r.data as BetaData;
  assert.equal(d.available, true);
  // varB == 0 -> beta falls back to 0.
  assert.equal(d.beta, 0);
  // correlation falls back to 0 when a std is 0.
  assert.equal(d.correlation, 0);
  assert.equal(d.r2, 0);
  // beta 0 < 0.85 -> defensive.
  assert.equal(d.sensitivity, "defensive");
});

// 4e. Edge: negative-beta inverse relationship is handled.
test("edge: inverse stock (-1x benchmark) -> negative beta, correlation -1", async () => {
  const bench = Array.from({ length: 30 }, (_, i) => Math.sin(i / 3) * 0.01);
  const stock = bench.map((b) => -b);
  const r = await run({
    symbol: "INV",
    stockReturns: stock,
    benchmarkReturns: bench,
  });
  assert.equal(r.success, true);
  const d = r.data as BetaData;
  assert.equal(d.available, true);
  assert.ok((d.beta as number) < -0.9, `beta ${d.beta}`);
  assert.ok(
    Math.abs((d.correlation as number) - -1) < 1e-6,
    `correlation ${d.correlation}`
  );
  // r2 = correlation^2 is still ~1.
  assert.ok(Math.abs((d.r2 as number) - 1) < 1e-6);
});

// 4f. Edge: non-numeric junk in arrays is coerced/dropped, never throws.
test("edge: non-numeric entries are dropped without throwing", async () => {
  const bench: unknown[] = Array.from({ length: 25 }, (_, i) =>
    i % 2 ? 0.01 : -0.01
  );
  const stock: unknown[] = bench.map((b) => (b as number) * 2);
  // Inject junk values (NaN / strings / null) that must be filtered out.
  stock[0] = "not-a-number";
  stock[1] = null;
  bench[2] = NaN;
  const r = await run({
    symbol: "JUNK",
    stockReturns: stock,
    benchmarkReturns: bench,
  });
  assert.equal(r.success, true);
  const d = r.data as BetaData;
  // After dropping junk both sides still clear the 20-obs gate.
  assert.equal(d.available, true);
  assert.ok(Number.isFinite(d.beta as number));
});
