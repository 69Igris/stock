/**
 * Rate Sensitivity Tool Tests
 * (packages/research/src/tools/compute-rate-sensitivity.ts)
 *
 * Pure-function compute tool. All inputs (sector, repoRate, repoRateHistory,
 * stockReturns) are injected by the executor; no network/db/io, so these tests
 * are fully deterministic.
 *
 * Coverage:
 *   - Happy path: success + available + key field shapes/types
 *   - Known-value numeric assertions (sector heuristic + empirical OLS rate-beta)
 *   - Graceful degradation: available:false (NOT success:false) when neither a
 *     mapped sector nor an empirical rate/return series is supplied
 *   - Edge cases: empty/zero/negative inputs, short series, missing optional
 *     fields, alias normalization, indicator-object inputs — must not throw
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeRateSensitivityTool } from "../../../../packages/research/src/tools/compute-rate-sensitivity";

async function run(args: Record<string, unknown>) {
  return computeRateSensitivityTool.execute(args);
}

// Tight tolerance for float comparisons. The tool rounds rateBeta/rateBetaR2 to
// 3dp, so a small epsilon is safe and deterministic.
const EPS = 1e-9;

interface RateSensitivityResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  sector?: string;
  normalizedSector?: string;
  sensitivityClass?: "high" | "moderate" | "low";
  direction?: "positive" | "negative" | "neutral";
  rateBeta: number | null;
  rateBetaR2?: number | null;
  empiricalSampleSize?: number;
  currentRepoRate?: number | null;
  rateMoveImpact?: {
    hike25bps: string;
    cut25bps: string;
  };
  drivers: string[];
  flags: string[];
}

// ── 1. Happy path: shape + types ──────────────────────────────────────

test("happy path: returns success + available with well-typed fields", async () => {
  const r = await run({
    symbol: "HDFCBANK.NS",
    sector: "banking",
    repoRate: 6.5,
  });
  assert.equal(r.success, true);
  const data = r.data as RateSensitivityResult;

  assert.equal(data.available, true);
  assert.equal(data.symbol, "HDFCBANK"); // .NS suffix stripped, uppercased

  // Sector classification fields present and well-typed.
  assert.equal(typeof data.sensitivityClass, "string");
  assert.ok(
    ["high", "moderate", "low"].includes(data.sensitivityClass as string)
  );
  assert.ok(
    ["positive", "negative", "neutral"].includes(data.direction as string)
  );
  assert.equal(data.normalizedSector, "banking");
  assert.equal(data.sector, "banking");

  // Heuristic-only run: no empirical series -> rateBeta null.
  assert.equal(data.rateBeta, null);
  assert.equal(data.empiricalSampleSize, 0);

  // currentRepoRate echoed back.
  assert.equal(data.currentRepoRate, 6.5);

  // Qualitative impact narrative block.
  assert.ok(data.rateMoveImpact, "rateMoveImpact should be present");
  assert.equal(typeof data.rateMoveImpact!.hike25bps, "string");
  assert.equal(typeof data.rateMoveImpact!.cut25bps, "string");

  // drivers + flags are arrays of strings.
  assert.ok(Array.isArray(data.drivers));
  for (const d of data.drivers) assert.equal(typeof d, "string");
  assert.ok(data.drivers.length > 0); // banking driver pushed
  assert.ok(Array.isArray(data.flags));
  for (const f of data.flags) assert.equal(typeof f, "string");

  // metadata surfaced by the success path.
  assert.ok(r.metadata);
  assert.equal((r.metadata as Record<string, unknown>).empirical, false);
});

// ── 2. Known-value numeric assertion (sector + empirical OLS) ──────────

test("known values: HDFCBANK financial-services + empirical OLS rate-beta", async () => {
  const r = await run({
    symbol: "HDFCBANK",
    sector: "financial services",
    repoRate: 6.25,
    // 6 levels -> 5 changes [0.4,0.5,0.5,0.5,0.6]
    repoRateHistory: [4.0, 4.4, 4.9, 5.4, 5.9, 6.5],
    // 5 returns aligned with the 5 rate-changes (no leading-return trim)
    stockReturns: [-5, -8, -6, -10, -7],
  });
  assert.equal(r.success, true);
  const data = r.data as RateSensitivityResult;

  assert.equal(data.available, true);

  // Sector heuristic: "financial services" -> banking -> high / positive.
  assert.equal(data.normalizedSector, "banking");
  assert.equal(data.sensitivityClass, "high");
  assert.equal(data.direction, "positive");

  // currentRepoRate echoed exactly.
  assert.equal(data.currentRepoRate, 6.25);

  // Empirical OLS rate-beta: regressing returns on rate-changes => slope -10.
  assert.ok(
    typeof data.rateBeta === "number",
    "rateBeta should be a number when series supplied"
  );
  assert.ok(
    Math.abs((data.rateBeta as number) - -10) < 1e-3,
    `rateBeta ${data.rateBeta}`
  );
  // r-squared 0.135 (3dp) for this fixture.
  assert.ok(
    Math.abs((data.rateBetaR2 as number) - 0.135) < 1e-3,
    `rateBetaR2 ${data.rateBetaR2}`
  );
  assert.equal(data.empiricalSampleSize, 5);

  // Empirical beta is negative while the sector heuristic is positive ->
  // divergence flag emitted, but direction stays sector-derived (positive).
  assert.equal(data.direction, "positive");
  assert.ok(
    data.flags.some((f) => f.includes("diverges from the sector heuristic")),
    "expected divergence flag"
  );
  // Small sample (n=5 < 6) should be flagged.
  assert.ok(
    data.flags.some((f) => f.includes("small sample")),
    "expected small-sample flag"
  );
});

test("known values (clarifying): note exact rateBeta:null on the HDFCBANK heuristic-only fixture", async () => {
  // The task's case 2 pins rateBeta:null when NO empirical series is passed.
  // This is the heuristic-only variant of the same HDFCBANK fixture.
  const r = await run({
    symbol: "HDFCBANK",
    sector: "financial services",
    repoRate: 6.25,
  });
  assert.equal(r.success, true);
  const data = r.data as RateSensitivityResult;
  assert.equal(data.available, true);
  assert.equal(data.sensitivityClass, "high");
  assert.equal(data.direction, "positive");
  assert.equal(data.rateBeta, null);
  assert.equal(data.currentRepoRate, 6.25);
  // Heuristic-only path emits the "no empirical rate-beta computed" flag.
  assert.ok(
    data.flags.some((f) => f.includes("No empirical rate-beta computed")),
    "expected heuristic-only flag"
  );
});

// ── 3. Graceful degradation (success:true + available:false) ───────────

test("graceful degradation: unmapped sector + no empirical series -> available:false (not success:false)", async () => {
  const r = await run({ symbol: "FOOBAR", sector: "tobacco" });
  assert.equal(r.success, true); // success:false reserved for runtime exceptions
  const data = r.data as RateSensitivityResult;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(
    data.reason!.includes("not in the rate-sensitivity map"),
    `reason ${data.reason}`
  );
  // Symbol + raw sector echoed on the degraded path.
  assert.equal(data.symbol, "FOOBAR");
  assert.equal(data.sector, "tobacco");
  assert.equal(data.rateBeta, null);
  assert.deepEqual(data.drivers, []);
  assert.deepEqual(data.flags, []);
});

test("graceful degradation: no sector at all + no empirical series -> available:false", async () => {
  const r = await run({ symbol: "XYZ" });
  assert.equal(r.success, true);
  const data = r.data as RateSensitivityResult;
  assert.equal(data.available, false);
  assert.equal(
    data.reason,
    "No sector classification and no empirical return/rate series provided"
  );
  assert.equal(data.rateBeta, null);
});

test("graceful degradation: empty-object args -> available:false, never throws", async () => {
  const r = await run({});
  assert.equal(r.success, true);
  const data = r.data as RateSensitivityResult;
  assert.equal(data.available, false);
  assert.equal(data.rateBeta, null);
  assert.equal(data.symbol, undefined);
});

// ── 4. Edge cases (must not throw) ─────────────────────────────────────

test("edge: unmapped sector BUT empirical series present -> available:true, beta-only inference", async () => {
  // No sector mapping; sensitivity must be inferred from the empirical beta.
  // Need >= 3 rate-changes WITH variation (sxx != 0) so OLS yields a slope.
  const r = await run({
    symbol: "MISC",
    sector: "miscellaneous-unmapped",
    repoRateHistory: [4.0, 4.5, 5.5, 6.0, 7.0], // changes [0.5,1.0,0.5,1.0] (varied)
    stockReturns: [3, 6, 4, 7], // 4 returns vs 4 changes
  });
  assert.equal(r.success, true);
  const data = r.data as RateSensitivityResult;
  assert.equal(data.available, true);
  assert.ok(typeof data.rateBeta === "number");
  assert.ok(
    ["high", "moderate", "low"].includes(data.sensitivityClass as string)
  );
  assert.ok(
    data.drivers.some((d) => d.includes("Sector classification unavailable")),
    "expected beta-only driver"
  );
});

test("edge: short rate series (n<3 after diffing) -> no beta, but mapped sector keeps available:true", async () => {
  // 2 rate levels -> 1 change, regression needs >= 3 points -> beta null.
  const r = await run({
    sector: "it",
    repoRateHistory: [6.0, 6.5],
    stockReturns: [2, 3],
  });
  assert.equal(r.success, true);
  const data = r.data as RateSensitivityResult;
  assert.equal(data.available, true);
  assert.equal(data.rateBeta, null); // insufficient points
  assert.equal(data.sensitivityClass, "low"); // it -> defensive low
  assert.equal(data.direction, "neutral");
});

test("edge: zero-variation rate series (sxx=0) -> no beta, no throw", async () => {
  // All identical rates -> all rate-changes are 0 -> sxx=0 -> regression null.
  const r = await run({
    sector: "pharma",
    repoRateHistory: [6.0, 6.0, 6.0, 6.0],
    stockReturns: [1, 2, 3],
  });
  assert.equal(r.success, true);
  const data = r.data as RateSensitivityResult;
  assert.equal(data.available, true);
  assert.equal(data.rateBeta, null);
  assert.equal(data.sensitivityClass, "low"); // pharma defensive
});

test("edge: repoRate as { value } indicator object + empty arrays -> parsed, no throw", async () => {
  const r = await run({
    sector: "nbfc",
    repoRate: { value: 6.5, date: "2026-05-01" },
    repoRateHistory: [],
    stockReturns: [],
  });
  assert.equal(r.success, true);
  const data = r.data as RateSensitivityResult;
  assert.equal(data.available, true);
  assert.equal(data.currentRepoRate, 6.5); // extracted from indicator object
  assert.equal(data.rateBeta, null); // empty series
  assert.equal(data.sensitivityClass, "high"); // nbfc -> high
  assert.equal(data.direction, "negative"); // rate hike hurts nbfc
});

test("edge: negative/odd values + alias normalization + missing optional fields, finite & no throw", async () => {
  // Negative returns, varied rate changes, alias sector, no repoRate.
  const r = await run({
    sector: "real estate", // alias -> realty
    repoRateHistory: [4.0, 4.4, 4.9, 5.4, 5.9, 6.5], // varied changes (sxx != 0)
    stockReturns: [-12, -3, -8, -1, -6], // 5 returns vs 5 changes
  });
  assert.equal(r.success, true);
  const data = r.data as RateSensitivityResult;
  assert.equal(data.available, true);
  assert.equal(data.normalizedSector, "realty");
  assert.equal(data.sensitivityClass, "high");
  assert.equal(data.direction, "negative");
  assert.ok(Number.isFinite(data.rateBeta as number));
  assert.ok(Number.isFinite(data.rateBetaR2 as number));
  assert.equal(data.currentRepoRate, null); // none supplied
  assert.equal(data.empiricalSampleSize, 5);
});
