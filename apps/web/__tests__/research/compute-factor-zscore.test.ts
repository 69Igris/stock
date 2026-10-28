/**
 * Cross-Sectional Factor Z-Score Tool Tests
 * (packages/research/src/tools/compute-factor-zscore.ts)
 *
 * Pure compute tool — no network/db/io. Tests exercise the public
 * `computeFactorZscoreTool.execute(args)` contract:
 *   1. Happy path → success:true, data.available:true, key fields + types.
 *   2. Known-value numeric assertion (tight float tolerances).
 *   3. Graceful degradation → success:true + data.available:false + reason.
 *   4. Edge cases (empty/zero/negative/short series/missing optionals) — no throw.
 *
 * All inputs are deterministic; no reliance on randomness.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeFactorZscoreTool } from "../../../../packages/research/src/tools/compute-factor-zscore";

// ── Shape helpers ──────────────────────────────────────────────────

interface FactorZscore {
  factor: string;
  subjectValue: number | null;
  peerMean: number;
  peerStdev: number;
  zScore: number | null;
  higherIsBetter: boolean;
  percentileRank: number | null;
  peerCount: number;
}

interface FactorZscoreData {
  available: boolean;
  reason?: string;
  symbol: string;
  factors: FactorZscore[];
  peerCount: number;
  topQuartileFactors: string[];
  bottomQuartileFactors: string[];
  observations: string[];
}

async function run(args: Record<string, unknown>) {
  return computeFactorZscoreTool.execute(args);
}

const APPROX = 1e-4;
function near(actual: number, expected: number, tol = APPROX): boolean {
  return Math.abs(actual - expected) <= tol;
}

// ── 1. Tool metadata sanity ────────────────────────────────────────

test("tool exposes expected metadata", () => {
  assert.equal(computeFactorZscoreTool.name, "compute_factor_zscore");
  assert.equal(computeFactorZscoreTool.category, "computation");
  assert.equal(typeof computeFactorZscoreTool.execute, "function");
  // subjectFactors and peers are both hard-required params.
  assert.equal(
    computeFactorZscoreTool.parameters.subjectFactors?.required,
    true
  );
  assert.equal(computeFactorZscoreTool.parameters.peers?.required, true);
});

// ── 2. Happy path: success + available + field presence/types ──────

test("happy path: representative inputs → success + available with typed fields", async () => {
  const out = await run({
    symbol: "RELIANCE",
    subjectFactors: {
      roe: 22,
      netMargin: 18,
      pe: 24,
      debtEquity: 0.4,
      revenueGrowth: 15,
    },
    peers: [
      { roe: 14, netMargin: 12, pe: 30, debtEquity: 0.9, revenueGrowth: 8 },
      { roe: 16, netMargin: 10, pe: 28, debtEquity: 0.7, revenueGrowth: 11 },
      { roe: 12, netMargin: 14, pe: 35, debtEquity: 1.2, revenueGrowth: 6 },
      { roe: 18, netMargin: 9, pe: 26, debtEquity: 0.6, revenueGrowth: 9 },
    ],
  });

  assert.equal(out.success, true);
  assert.ok(out.data, "data must be present");
  const data = out.data as FactorZscoreData;

  assert.equal(data.available, true);
  assert.equal(data.symbol, "RELIANCE");

  // Arrays present.
  assert.ok(Array.isArray(data.factors));
  assert.ok(data.factors.length > 0, "should compute at least one factor");
  assert.ok(Array.isArray(data.topQuartileFactors));
  assert.ok(Array.isArray(data.bottomQuartileFactors));
  assert.ok(Array.isArray(data.observations));

  // peerCount is the max usable peer count across factors.
  assert.equal(typeof data.peerCount, "number");
  assert.equal(data.peerCount, 4);

  // Per-factor field presence + types.
  for (const f of data.factors) {
    assert.equal(typeof f.factor, "string");
    assert.ok(f.subjectValue === null || typeof f.subjectValue === "number");
    assert.equal(typeof f.peerMean, "number");
    assert.equal(typeof f.peerStdev, "number");
    assert.ok(f.zScore === null || typeof f.zScore === "number");
    assert.equal(typeof f.higherIsBetter, "boolean");
    assert.ok(
      f.percentileRank === null || typeof f.percentileRank === "number"
    );
    assert.equal(typeof f.peerCount, "number");
    assert.ok(f.peerCount >= 3, "each emitted factor needs >=3 peers");
  }

  // Orientation registry honored: pe / debtEquity are lower-is-better.
  const pe = data.factors.find((f) => f.factor === "pe");
  const de = data.factors.find((f) => f.factor === "debtEquity");
  assert.ok(pe, "pe factor should be present");
  assert.ok(de, "debtEquity factor should be present");
  assert.equal(pe!.higherIsBetter, false);
  assert.equal(de!.higherIsBetter, false);

  // roe is higher-is-better and subject (22) leads → top quartile.
  const roe = data.factors.find((f) => f.factor === "roe");
  assert.ok(roe, "roe factor should be present");
  assert.equal(roe!.higherIsBetter, true);
});

// ── 3. Known-value numeric assertion (tight float tolerance) ───────

test("known-value: roe cross-section z and percentile match hand math", async () => {
  // Cross-section roe = [20, 10, 15, 5]
  //   mean = 50 / 4 = 12.5
  //   sample variance (n-1=3) = (56.25 + 6.25 + 6.25 + 56.25) / 3 = 41.6667
  //   sample stdev = sqrt(41.6667) ≈ 6.45497
  //   roe higher-is-better → z = (20 - 12.5) / 6.45497 ≈ 1.1619 → round(2) = 1.16
  //   subject beats all 3 peers → percentileRank = 100 → top quartile.
  const out = await run({
    symbol: "ACME.NS",
    subjectFactors: { roe: 20 },
    peers: [{ roe: 10 }, { roe: 15 }, { roe: 5 }],
  });

  assert.equal(out.success, true);
  const data = out.data as FactorZscoreData;

  assert.equal(data.available, true);
  // ".NS" suffix stripped, uppercased.
  assert.equal(data.symbol, "ACME");
  assert.equal(data.peerCount, 3);
  assert.equal(data.factors.length, 1);

  const roe = data.factors[0]!;
  assert.equal(roe.factor, "roe");
  assert.equal(roe.higherIsBetter, true);
  assert.equal(roe.peerCount, 3);
  assert.equal(roe.subjectValue, 20);

  assert.ok(near(roe.peerMean, 12.5), `peerMean ${roe.peerMean} != 12.5`);
  assert.ok(
    near(roe.peerStdev, 6.455, 1e-3),
    `peerStdev ${roe.peerStdev} != ~6.455`
  );
  assert.ok(roe.zScore !== null, "zScore should be computed");
  assert.ok(near(roe.zScore!, 1.16, 0.01), `zScore ${roe.zScore} != ~1.16`);

  assert.equal(roe.percentileRank, 100);
  assert.deepEqual(data.topQuartileFactors, ["roe"]);
  assert.deepEqual(data.bottomQuartileFactors, []);
  assert.ok(
    data.observations.some((o) => o.includes("roe")),
    "observation should mention roe"
  );
});

test("known-value: lower-is-better orientation flips z sign", async () => {
  // pe cross-section = [10, 20, 30, 40], mean = 25.
  // pe is lower-is-better; subject 10 is cheapest → positive z (ahead of peers),
  // and subject beats all 3 peers (lower pe) → percentileRank = 100.
  const out = await run({
    symbol: "CHEAP",
    subjectFactors: { pe: 10 },
    peers: [{ pe: 20 }, { pe: 30 }, { pe: 40 }],
  });

  const data = out.data as FactorZscoreData;
  assert.equal(out.success, true);
  assert.equal(data.available, true);

  const pe = data.factors.find((f) => f.factor === "pe")!;
  assert.equal(pe.higherIsBetter, false);
  assert.ok(near(pe.peerMean, 25), `peerMean ${pe.peerMean} != 25`);
  // Cheapest pe → orientation-adjusted z is POSITIVE (ahead of peers).
  assert.ok(pe.zScore !== null && pe.zScore! > 0, "cheap pe → positive z");
  assert.equal(pe.percentileRank, 100);
  assert.deepEqual(data.topQuartileFactors, ["pe"]);
});

test("known-value: bottom-quartile subject lands in bottomQuartileFactors", async () => {
  // roe subject 4 is the worst vs peers [10,15,20] → beats 0 → percentile 0.
  const out = await run({
    symbol: "LAGGARD",
    subjectFactors: { roe: 4 },
    peers: [{ roe: 10 }, { roe: 15 }, { roe: 20 }],
  });

  const data = out.data as FactorZscoreData;
  assert.equal(out.success, true);
  assert.equal(data.available, true);

  const roe = data.factors.find((f) => f.factor === "roe")!;
  assert.equal(roe.percentileRank, 0);
  assert.ok(roe.zScore !== null && roe.zScore! < 0, "laggard → negative z");
  assert.deepEqual(data.bottomQuartileFactors, ["roe"]);
  assert.deepEqual(data.topQuartileFactors, []);
});

// ── 4. Graceful degradation (success:true, available:false) ────────

test("graceful: fewer than 3 peers with usable metrics → available:false", async () => {
  const out = await run({
    symbol: "THIN",
    subjectFactors: { roe: 18, netMargin: 12 },
    peers: [
      { roe: 10, netMargin: 8 },
      { roe: 12, netMargin: 9 },
    ],
  });

  assert.equal(
    out.success,
    true,
    "still success — honest degrade, not failure"
  );
  const data = out.data as FactorZscoreData;

  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(data.reason!.length > 0, "reason must be a non-empty string");
  assert.equal(data.symbol, "THIN");
  assert.deepEqual(data.factors, []);
  assert.equal(data.peerCount, 2);
  assert.deepEqual(data.topQuartileFactors, []);
  assert.deepEqual(data.bottomQuartileFactors, []);
  assert.deepEqual(data.observations, []);
});

test("graceful: >=3 peers but no single factor clears the cross-section bar → available:false", async () => {
  // 3 peers carry usable data overall, but each peer covers a DIFFERENT factor,
  // so no single factor has >=3 peers. Subject also shares each factor.
  const out = await run({
    symbol: "SPARSE",
    subjectFactors: { roe: 20, netMargin: 15, pe: 22 },
    peers: [{ roe: 10 }, { netMargin: 8 }, { pe: 30 }],
  });

  assert.equal(out.success, true);
  const data = out.data as FactorZscoreData;

  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(data.reason!.length > 0);
  assert.equal(data.symbol, "SPARSE");
  assert.deepEqual(data.factors, []);
  // 3 peers carried *some* usable metric → peerCount reflects that.
  assert.equal(data.peerCount, 3);
  assert.deepEqual(data.topQuartileFactors, []);
  assert.deepEqual(data.bottomQuartileFactors, []);
  assert.deepEqual(data.observations, []);
});

test("graceful: zero-filled peer columns are treated as no-data and degrade honestly", async () => {
  // Peers zero-fill roe → extractPeerMetrics drops 0 values → 0 usable peers.
  const out = await run({
    symbol: "ZEROFILL",
    subjectFactors: { roe: 18 },
    peers: [{ roe: 0 }, { roe: 0 }, { roe: 0 }, { roe: 0 }],
  });

  assert.equal(out.success, true);
  const data = out.data as FactorZscoreData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.equal(data.peerCount, 0);
  assert.deepEqual(data.factors, []);
});

// ── 5. Edge cases — must not throw ─────────────────────────────────

test("edge: empty subjectFactors and empty peers → available:false, no throw", async () => {
  const out = await run({ symbol: "EMPTY", subjectFactors: {}, peers: [] });
  assert.equal(out.success, true);
  const data = out.data as FactorZscoreData;
  assert.equal(data.available, false);
  assert.equal(data.peerCount, 0);
  assert.deepEqual(data.factors, []);
});

test("edge: missing optional symbol + negative values do not throw", async () => {
  // No symbol provided (optional) → resolves to "".
  // Negative roe values are valid finite numbers and must be processed.
  const out = await run({
    subjectFactors: { roe: -5 },
    peers: [{ roe: -10 }, { roe: -15 }, { roe: -2 }],
  });

  assert.equal(out.success, true);
  const data = out.data as FactorZscoreData;
  assert.equal(data.symbol, "");
  assert.equal(data.available, true);
  const roe = data.factors.find((f) => f.factor === "roe")!;
  assert.equal(roe.peerCount, 3);
  // mean of cross-section [-5,-10,-15,-2] = -8; subject -5 is above mean.
  assert.ok(near(roe.peerMean, -8), `peerMean ${roe.peerMean} != -8`);
  assert.ok(roe.zScore !== null && roe.zScore! > 0, "−5 above −8 mean → +z");
});

test("edge: zero-dispersion cross-section → zScore null but factor still emitted", async () => {
  // Subject + all peers identical → sigma 0 → zScore null (no fabricated z).
  // All ties → percentileRank = 50 (ties count half).
  const out = await run({
    symbol: "FLAT",
    subjectFactors: { roe: 12 },
    peers: [{ roe: 12 }, { roe: 12 }, { roe: 12 }],
  });

  assert.equal(out.success, true);
  const data = out.data as FactorZscoreData;
  assert.equal(data.available, true);
  const roe = data.factors.find((f) => f.factor === "roe")!;
  assert.equal(roe.peerStdev, 0);
  assert.equal(roe.zScore, null);
  assert.equal(roe.percentileRank, 50);
  // 50th pct is neither top (>=75) nor bottom (<=25) quartile.
  assert.deepEqual(data.topQuartileFactors, []);
  assert.deepEqual(data.bottomQuartileFactors, []);
});

test("edge: malformed non-object subjectFactors / non-array peers do not throw", async () => {
  // subjectFactors as a string and peers as a non-array → extractors return
  // empty / [] respectively; tool degrades rather than crashing.
  const out = await run({
    symbol: "BAD",
    subjectFactors: "not-an-object" as unknown as Record<string, unknown>,
    peers: "not-an-array" as unknown as unknown[],
  });

  assert.equal(out.success, true);
  const data = out.data as FactorZscoreData;
  assert.equal(data.available, false);
  assert.equal(data.peerCount, 0);
  assert.deepEqual(data.factors, []);
});

test("edge: aliases + string-with-percent values resolve to canonical numeric factors", async () => {
  // "return_on_equity" → roe alias; "12%" string parsed to 12.
  const out = await run({
    symbol: "ALIAS",
    subjectFactors: { return_on_equity: "25%" },
    peers: [
      { return_on_equity: "10%" },
      { return_on_equity: "15%" },
      { return_on_equity: "5%" },
    ],
  });

  assert.equal(out.success, true);
  const data = out.data as FactorZscoreData;
  assert.equal(data.available, true);
  const roe = data.factors.find((f) => f.factor === "roe")!;
  assert.ok(roe, "alias should canonicalize to roe");
  assert.equal(roe.subjectValue, 25);
  assert.equal(roe.peerCount, 3);
  assert.equal(roe.percentileRank, 100);
});
