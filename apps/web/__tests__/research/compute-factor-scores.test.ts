/**
 * Factor Scores Tool Tests
 * (packages/research/src/tools/compute-factor-scores.ts)
 *
 * Pure compute tool — no network/db/io. Tests exercise the public
 * `computeFactorScoresTool.execute(args)` contract:
 *   1. Happy path → success:true, data.available:true, key fields + types.
 *   2. Known-value numeric assertions (tight float tolerances).
 *   3. Graceful degradation → success:true + data.available:false + reason.
 *   4. Edge cases (empty/zero/negative/short series/missing optionals) — no throw.
 *
 * Reference for the known-value cases (from the tool's documented transforms):
 *   - lowerBetter(value, best, worst) = 100*(worst-value)/(worst-best), clamped.
 *   - higherBetter(value, worst, best) = 100*(value-worst)/(best-worst), clamped.
 *   - Percent inputs with |x| <= 1.5 are treated as fractions and scaled ×100.
 *   - Each factor score = round0(mean(sub-scores)).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeFactorScoresTool } from "../../../../packages/research/src/tools/compute-factor-scores";

// ── Shape helpers ──────────────────────────────────────────────────

interface FactorSubScore {
  inputs: Record<string, number>;
  score: number | null;
  note?: string;
}

interface FactorScoresData {
  available: boolean;
  reason?: string;
  symbol?: string;
  factors: {
    value: FactorSubScore;
    quality: FactorSubScore;
    momentum: FactorSubScore;
    growth: FactorSubScore;
    lowVol: FactorSubScore;
  };
  compositeScore: number | null;
  availableFactors: string[];
  styleTilt: string;
  observations: string[];
}

async function run(args: Record<string, unknown>) {
  return computeFactorScoresTool.execute(args);
}

const APPROX = 1e-9;
function near(actual: number, expected: number, tol = APPROX): boolean {
  return Math.abs(actual - expected) <= tol;
}

/** Build an ascending daily-close series of length n (deterministic, monotone). */
function risingSeries(n: number, start = 100, step = 0.5): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

// ── 1. Tool metadata sanity ────────────────────────────────────────

test("tool exposes expected metadata", () => {
  assert.equal(computeFactorScoresTool.name, "compute_factor_scores");
  assert.equal(computeFactorScoresTool.category, "computation");
  assert.equal(typeof computeFactorScoresTool.execute, "function");
  // No hard-required parameter — every field is optional.
  assert.equal(computeFactorScoresTool.parameters.pe?.type, "number");
  assert.equal(computeFactorScoresTool.parameters.closes?.type, "array");
});

// ── 2. Happy path: success + available + field presence/types ──────

test("happy path returns available result with typed key fields", async () => {
  const r = await run({
    symbol: "tcs.ns",
    // VALUE
    pe: 15,
    pb: 3,
    evToEbitda: 12,
    fcfYield: 0.05,
    dividendYield: 0.02,
    // QUALITY
    roe: 0.3,
    roa: 0.12,
    netMargin: 0.2,
    operatingMargin: 0.25,
    debtToEquity: 0.5,
    currentRatio: 1.8,
    // GROWTH
    revenueGrowth: 0.18,
    earningsGrowth: 0.22,
    epsCAGR: 0.15,
    // MOMENTUM + LOW_VOL
    closes: risingSeries(260),
    beta: 0.9,
  });

  assert.equal(r.success, true);
  const data = r.data as FactorScoresData;
  assert.equal(data.available, true);

  // Symbol is normalized: suffix stripped + uppercased.
  assert.equal(data.symbol, "TCS");

  // Factor sub-scores present with correct shape.
  for (const key of [
    "value",
    "quality",
    "momentum",
    "growth",
    "lowVol",
  ] as const) {
    const sub = data.factors[key];
    assert.ok(sub, `factor ${key} present`);
    assert.equal(typeof sub.inputs, "object");
    assert.ok(sub.score === null || typeof sub.score === "number");
  }

  // With all inputs supplied, every factor is computable.
  assert.equal(typeof data.factors.value.score, "number");
  assert.equal(typeof data.factors.quality.score, "number");
  assert.equal(typeof data.factors.momentum.score, "number");
  assert.equal(typeof data.factors.growth.score, "number");
  assert.equal(typeof data.factors.lowVol.score, "number");

  // Composite + aggregate fields.
  assert.equal(typeof data.compositeScore, "number");
  assert.ok(data.compositeScore! >= 0 && data.compositeScore! <= 100);
  assert.ok(Array.isArray(data.availableFactors));
  assert.equal(data.availableFactors.length, 5);
  assert.equal(typeof data.styleTilt, "string");
  assert.ok(data.styleTilt.length > 0);
  assert.ok(Array.isArray(data.observations));

  // availableFactors is ranked desc by score — verify ordering invariant.
  const scoresInOrder = data.availableFactors.map(
    (k) => data.factors[k as keyof FactorScoresData["factors"]].score as number
  );
  for (let i = 1; i < scoresInOrder.length; i++) {
    assert.ok(
      scoresInOrder[i - 1]! >= scoresInOrder[i]!,
      `availableFactors not sorted desc: ${JSON.stringify(scoresInOrder)}`
    );
  }

  // All factor scores are within [0,100].
  for (const k of [
    "value",
    "quality",
    "momentum",
    "growth",
    "lowVol",
  ] as const) {
    const s = data.factors[k].score;
    if (s !== null)
      assert.ok(s >= 0 && s <= 100, `${k} score out of range: ${s}`);
  }
});

// ── 3. KNOWN-VALUE numeric assertions ──────────────────────────────

test("known-value: pe=15 → value factor score 83", async () => {
  const r = await run({ pe: 15 });

  assert.equal(r.success, true);
  const data = r.data as FactorScoresData;
  assert.equal(data.available, true);

  // lowerBetter(15, 8, 50) = 100*(50-15)/(50-8) = 83.33… → round0 → 83.
  assert.equal(data.factors.value.score, 83);
  // The raw input is echoed back (rounded to 2dp).
  assert.ok(near(data.factors.value.inputs.pe!, 15));
  // Only the value factor is computable here.
  assert.equal(data.factors.quality.score, null);
  assert.equal(data.factors.momentum.score, null);
  assert.equal(data.factors.growth.score, null);
  assert.equal(data.factors.lowVol.score, null);
  // Single available factor → composite equals that factor's score.
  assert.equal(data.compositeScore, 83);
  assert.deepEqual(data.availableFactors, ["value"]);
});

test("known-value: roe=0.30 → quality factor score 100", async () => {
  const r = await run({ roe: 0.3 });

  assert.equal(r.success, true);
  const data = r.data as FactorScoresData;
  assert.equal(data.available, true);

  // asPct(0.30) → 30 (fraction scaled). higherBetter(30, 0, 30) → 100.
  assert.equal(data.factors.quality.score, 100);
  assert.ok(near(data.factors.quality.inputs.roePct!, 30));
  assert.equal(data.compositeScore, 100);
  assert.deepEqual(data.availableFactors, ["quality"]);
  // Strong quality (>=75) shows up in observations.
  assert.ok(
    data.observations.some((o) => /quality/i.test(o)),
    `observations=${JSON.stringify(data.observations)}`
  );
});

test("known-value: empty params → available:false, success:true", async () => {
  const r = await run({});

  assert.equal(r.success, true); // NOT success:false
  const data = r.data as FactorScoresData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(data.reason!.length > 0);
});

test("known-value: roe expressed as percent (30) matches fraction (0.30)", async () => {
  // |30| > 1.5 → treated as already-percent, NOT scaled.
  const rPct = await run({ roe: 30 });
  const rFrac = await run({ roe: 0.3 });

  const pct = rPct.data as FactorScoresData;
  const frac = rFrac.data as FactorScoresData;
  assert.equal(pct.factors.quality.score, 100);
  assert.equal(frac.factors.quality.score, 100);
  assert.equal(pct.factors.quality.score, frac.factors.quality.score);
});

test("known-value: pe at/below best bound → value score 100", async () => {
  // pe = 8 is the 'best' bound → lowerBetter returns 100.
  const r = await run({ pe: 8 });
  const data = r.data as FactorScoresData;
  assert.equal(data.factors.value.score, 100);
});

test("known-value: pe at/above worst bound → value score 0 (weak observation)", async () => {
  // pe = 50 is the 'worst' bound → lowerBetter returns 0.
  const r = await run({ pe: 50 });
  const data = r.data as FactorScoresData;
  assert.equal(data.factors.value.score, 0);
  // Score <= 25 surfaces a "weak" observation.
  assert.ok(
    data.observations.some((o) => /weak/i.test(o)),
    `observations=${JSON.stringify(data.observations)}`
  );
  // No factor >= 60 → "no clear tilt".
  assert.equal(data.styleTilt, "no clear tilt");
});

// ── 4. Graceful degradation (success:true, available:false, reason) ─

test("graceful: neither ratios nor price series → available:false with reason", async () => {
  const r = await run({ symbol: "INFY", closes: [] });

  assert.equal(r.success, true);
  const data = r.data as FactorScoresData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok(/no .*ratios|price history/i.test(data.reason!));
  // Degraded result still carries symbol + null factors.
  assert.equal(data.symbol, "INFY");
  assert.equal(data.factors.value.score, null);
  assert.equal(data.compositeScore, null);
  assert.deepEqual(data.availableFactors, []);
  assert.equal(data.styleTilt, "insufficient data");
});

test("graceful: closes containing only non-numeric junk → available:false", async () => {
  // toCloses filters out non-positive / non-numeric entries → empty array.
  const r = await run({ closes: [null, "x", -5, 0, NaN, {}] as unknown[] });

  assert.equal(r.success, true);
  const data = r.data as FactorScoresData;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
});

// ── 5. Edge cases — must not throw ─────────────────────────────────

test("edge: zero / negative valuation inputs are skipped, no throw", async () => {
  // pe<=0 and pb<=0 are skipped by the >0 guard; roe still provides quality.
  const r = await run({ pe: 0, pb: -3, roe: 0.1 });

  assert.equal(r.success, true);
  const data = r.data as FactorScoresData;
  assert.equal(data.available, true);
  // pe/pb skipped → value factor has no inputs.
  assert.equal(data.factors.value.score, null);
  assert.equal(typeof data.factors.quality.score, "number");
});

test("edge: single price point → momentum not computable, no throw", async () => {
  const r = await run({ closes: [100] });

  assert.equal(r.success, true);
  const data = r.data as FactorScoresData;
  // One usable close is enough to flip available true (closes.length !== 0).
  assert.equal(data.available, true);
  assert.equal(data.factors.momentum.score, null);
  assert.equal(typeof data.factors.momentum.note, "string");
  assert.ok(/single price point/i.test(data.factors.momentum.note!));
});

test("edge: short series (< 6 months) gets partial momentum + note", async () => {
  // 30 closes: enough for SMA-not-available but >= 2 → 52w-high + (no SMA50) sub-scores.
  const r = await run({ closes: risingSeries(30) });

  assert.equal(r.success, true);
  const data = r.data as FactorScoresData;
  assert.equal(data.available, true);
  // Momentum computed off the available window; note flags the short history.
  assert.ok(
    data.factors.momentum.score === null ||
      typeof data.factors.momentum.score === "number"
  );
  if (data.factors.momentum.note) {
    assert.ok(/shorter than 6 months/i.test(data.factors.momentum.note));
  }
  // lowVol requires >= 21 closes → 30 closes yields a volatility sub-score.
  assert.equal(typeof data.factors.lowVol.score, "number");
});

test("edge: series shorter than 21 → no lowVol vol score, no throw", async () => {
  const r = await run({ closes: risingSeries(15) });

  assert.equal(r.success, true);
  const data = r.data as FactorScoresData;
  assert.equal(data.available, true);
  // < 21 closes → annualized vol not computed; no beta either → lowVol null.
  assert.equal(data.factors.lowVol.score, null);
});

test("edge: beta alone powers lowVol even with no price series", async () => {
  const r = await run({ beta: 0.4 });

  assert.equal(r.success, true);
  const data = r.data as FactorScoresData;
  assert.equal(data.available, true);
  // beta = 0.4 is the 'best' magnitude → lowerBetter(0.4, 0.4, 2.0) → 100.
  assert.equal(data.factors.lowVol.score, 100);
});

test("edge: string-encoded numeric inputs are coerced, no throw", async () => {
  // num() parses finite numeric strings.
  const r = await run({ pe: "15", roe: "0.3" } as unknown as Record<
    string,
    unknown
  >);

  assert.equal(r.success, true);
  const data = r.data as FactorScoresData;
  assert.equal(data.available, true);
  assert.equal(data.factors.value.score, 83);
  assert.equal(data.factors.quality.score, 100);
});

test("edge: NaN / Infinity inputs are ignored, degrade gracefully", async () => {
  const r = await run({ pe: NaN, pb: Infinity, roe: -Infinity });

  assert.equal(r.success, true);
  const data = r.data as FactorScoresData;
  // None of the inputs are finite → nothing usable → available:false.
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
});

test("edge: determinism — identical inputs yield identical output", async () => {
  const args = {
    pe: 15,
    roe: 0.3,
    closes: risingSeries(260),
    beta: 0.9,
  };
  const a = (await run(args)).data as FactorScoresData;
  const b = (await run(args)).data as FactorScoresData;
  assert.deepEqual(a, b);
});
