/**
 * Composite Quant Score Tool Tests
 * (packages/research/src/tools/compute-composite-quant-score.ts)
 *
 * Pure-compute tool: blends per-factor 0-100 scores (value, quality, momentum,
 * growth, lowVol) into a single composite quant score with weights, percentile,
 * dominant factor, style label, per-factor contributions and a scored card.
 *
 * Covers:
 *   - Happy path (success + available, key fields/types)
 *   - A known-value numeric assertion (composite, dominant, rating, percentile,
 *     style label) with tight float tolerances
 *   - Graceful degradation (available:false, NOT success:false) for missing /
 *     empty / upstream-degraded factor scores
 *   - Edge cases: zero, negative, partial, weight overrides, z-scores — no throws
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeCompositeQuantScoreTool } from "../../../../packages/research/src/tools/compute-composite-quant-score";

// ── Shapes used for typed assertions (mirror the tool's exported interfaces) ──

interface FactorContribution {
  factor: string;
  score: number;
  zscore: number | null;
  weight: number;
  contribution: number;
  contributionPercent: number;
}

interface ScoredCard {
  rating: string;
  score: number;
  summary: string;
}

interface CompositeResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  composite: number;
  percentile: number;
  dominantFactor: string | null;
  styleLabel: string;
  factorsUsed: string[];
  contributions: FactorContribution[];
  scoredCard: ScoredCard;
  flags: string[];
}

async function run(args: Record<string, unknown>) {
  return computeCompositeQuantScoreTool.execute(args);
}

// The five-factor input used by the known-value case.
const KNOWN_FACTORS = {
  factors: {
    value: { score: 60 },
    quality: { score: 80 },
    momentum: { score: 70 },
    growth: { score: 50 },
    lowVol: { score: 40 },
  },
};

// ── 1. Happy path ────────────────────────────────────────────────────────────

test("happy path: success + available with all key fields and types", async () => {
  const r = await run({
    factorScores: {
      scores: { value: 72, quality: 68, momentum: 55, growth: 60, lowVol: 50 },
    },
    symbol: "INFY",
  });

  assert.equal(r.success, true);
  const data = r.data as CompositeResult;

  assert.equal(data.available, true);
  assert.equal(data.symbol, "INFY");

  // Composite is a finite 0-100 number.
  assert.equal(typeof data.composite, "number");
  assert.ok(Number.isFinite(data.composite));
  assert.ok(data.composite >= 0 && data.composite <= 100);

  // Percentile is a finite 0-100 number.
  assert.equal(typeof data.percentile, "number");
  assert.ok(data.percentile >= 0 && data.percentile <= 100);

  // Dominant factor is one of the five keys.
  assert.ok(
    ["value", "quality", "momentum", "growth", "lowVol"].includes(
      data.dominantFactor as string
    )
  );

  assert.equal(typeof data.styleLabel, "string");
  assert.ok(data.styleLabel.length > 0);

  // All five factors entered the blend.
  assert.ok(Array.isArray(data.factorsUsed));
  assert.equal(data.factorsUsed.length, 5);

  assert.ok(Array.isArray(data.contributions));
  assert.equal(data.contributions.length, 5);

  // Renormalized weights of present factors sum to ~1.
  const weightSum = data.contributions.reduce((a, c) => a + c.weight, 0);
  assert.ok(
    Math.abs(weightSum - 1) < 1e-6,
    `weights should sum to ~1, got ${weightSum}`
  );

  // Scored card mirrors the composite and is observation-only typed.
  assert.equal(typeof data.scoredCard, "object");
  assert.equal(data.scoredCard.score, data.composite);
  assert.ok(
    ["Strong", "Above-Average", "Average", "Below-Average", "Weak"].includes(
      data.scoredCard.rating
    )
  );
  assert.equal(typeof data.scoredCard.summary, "string");
  assert.ok(Array.isArray(data.flags));
});

test("happy path: SEBI-compliant summary carries no buy/sell/hold language", async () => {
  const r = await run({
    factorScores: KNOWN_FACTORS,
    symbol: "HDFCBANK",
  });
  const data = r.data as CompositeResult;
  const summary = data.scoredCard.summary.toLowerCase();
  for (const banned of ["buy", "sell", "hold", "target price"]) {
    assert.ok(!summary.includes(banned), `summary must not say "${banned}"`);
  }
});

// ── 2. Known-value numeric assertion ──────────────────────────────────────────

test("known value: composite=64.5, dominant=quality, rating=Average, percentile=65, style='High-Quality Value'", async () => {
  const r = await run({
    factorScores: KNOWN_FACTORS,
    symbol: "TCS",
  });

  assert.equal(r.success, true);
  const data = r.data as CompositeResult;
  assert.equal(data.available, true);

  // composite = 60*.25 + 80*.30 + 70*.20 + 50*.15 + 40*.10 = 64.5
  assert.ok(
    Math.abs(data.composite - 64.5) < 1e-9,
    `composite should be 64.5, got ${data.composite}`
  );

  // Dominant factor = quality (contribution 80*0.30 = 24, the largest).
  assert.equal(data.dominantFactor, "quality");

  // No z-scores supplied → percentile = round(composite) = round(64.5) = 65.
  assert.equal(data.percentile, 65);

  // 45 <= 64.5 < 65 → "Average".
  assert.equal(data.scoredCard.rating, "Average");

  // Strong factors (score >= 60) ranked by contribution: quality(24), value(15),
  // momentum(14) → top adjective "High-Quality" + second noun "Value".
  assert.equal(data.styleLabel, "High-Quality Value");

  // Per-factor contributions exact (tight tolerance for floats).
  const byFactor = new Map(data.contributions.map((c) => [c.factor, c]));
  assert.ok(
    Math.abs((byFactor.get("value") as FactorContribution).contribution - 15) <
      1e-9
  );
  assert.ok(
    Math.abs(
      (byFactor.get("quality") as FactorContribution).contribution - 24
    ) < 1e-9
  );
  assert.ok(
    Math.abs(
      (byFactor.get("momentum") as FactorContribution).contribution - 14
    ) < 1e-9
  );
  assert.ok(
    Math.abs(
      (byFactor.get("growth") as FactorContribution).contribution - 7.5
    ) < 1e-9
  );
  assert.ok(
    Math.abs((byFactor.get("lowVol") as FactorContribution).contribution - 4) <
      1e-9
  );

  // Quality is the dominant contribution share (24 / 64.5 * 100).
  const qShare = (byFactor.get("quality") as FactorContribution)
    .contributionPercent;
  assert.ok(
    Math.abs(qShare - 37.21) < 0.01,
    `quality share ~37.21, got ${qShare}`
  );

  // scoredCard.score mirrors composite.
  assert.equal(data.scoredCard.score, 64.5);
});

// ── 3. Graceful degradation (success stays true, data.available false) ─────────

test("degrades (available:false) when factorScores is missing entirely", async () => {
  const r = await run({ symbol: "RELIANCE" });

  assert.equal(r.success, true);
  const data = r.data as CompositeResult;
  assert.equal(data.available, false);
  assert.equal(typeof data.reason, "string");
  assert.ok((data.reason as string).length > 0);
  assert.equal(data.dominantFactor, null);
  assert.equal(data.composite, 0);
  assert.deepEqual(data.factorsUsed, []);
});

test("degrades (available:false) when factorScores has no parseable per-factor scores", async () => {
  const r = await run({
    factorScores: { scores: { unrelated: "n/a", note: "no factors here" } },
    symbol: "WIPRO",
  });

  assert.equal(r.success, true);
  const data = r.data as CompositeResult;
  assert.equal(data.available, false);
  assert.ok((data.reason as string).length > 0);
  assert.deepEqual(data.contributions, []);
});

test("degrades (available:false) and propagates when upstream reports available:false", async () => {
  const r = await run({
    factorScores: {
      available: false,
      reason: "factor pipeline failed",
      scores: { value: 90, quality: 90 },
    },
    symbol: "SBIN",
  });

  assert.equal(r.success, true);
  const data = r.data as CompositeResult;
  assert.equal(data.available, false);
  assert.ok((data.reason as string).length > 0);
  // Honest propagation: it did NOT silently score the embedded factor values.
  assert.equal(data.composite, 0);
});

test("degrades (available:false) when factorScores is an empty object", async () => {
  const r = await run({ factorScores: {}, symbol: "ITC" });
  assert.equal(r.success, true);
  const data = r.data as CompositeResult;
  assert.equal(data.available, false);
});

// ── 4. Edge cases — must not throw, must stay well-formed ──────────────────────

test("edge: all-zero scores → composite 0, available true, no throw", async () => {
  const r = await run({
    factorScores: {
      scores: { value: 0, quality: 0, momentum: 0, growth: 0, lowVol: 0 },
    },
  });
  assert.equal(r.success, true);
  const data = r.data as CompositeResult;
  assert.equal(data.available, true);
  assert.equal(data.composite, 0);
  // composite 0 → contributionPercent guarded to 0 (no division by zero).
  for (const c of data.contributions) {
    assert.equal(c.contributionPercent, 0);
  }
  // Bottom-tier flag observed at composite < 30.
  assert.ok(data.flags.some((f) => f.toLowerCase().includes("bottom-tier")));
});

test("edge: negative scores clamp to 0, do not throw", async () => {
  const r = await run({
    factorScores: { scores: { value: -50, quality: -10 } },
  });
  assert.equal(r.success, true);
  const data = r.data as CompositeResult;
  assert.equal(data.available, true);
  assert.equal(data.composite, 0);
  for (const c of data.contributions) {
    assert.ok(c.score >= 0, `score should clamp >= 0, got ${c.score}`);
  }
});

test("edge: out-of-range high score clamps to 100", async () => {
  const r = await run({ factorScores: { scores: { quality: 500 } } });
  assert.equal(r.success, true);
  const data = r.data as CompositeResult;
  assert.equal(data.available, true);
  // Single present factor → renormalized weight 1 → composite = clamped score.
  assert.equal(data.composite, 100);
  assert.equal(data.scoredCard.rating, "Strong");
  assert.ok(data.flags.some((f) => f.toLowerCase().includes("top-decile")));
});

test("edge: partial factors renormalize weights and emit a coverage flag", async () => {
  // Only value (0.25) and momentum (0.20) present → renormalized:
  // value 0.25/0.45 = 0.5556, momentum 0.20/0.45 = 0.4444 → sum 1.
  const r = await run({
    factorScores: { scores: { value: 80, momentum: 40 } },
  });
  assert.equal(r.success, true);
  const data = r.data as CompositeResult;
  assert.equal(data.available, true);
  assert.equal(data.factorsUsed.length, 2);

  const weightSum = data.contributions.reduce((a, c) => a + c.weight, 0);
  assert.ok(Math.abs(weightSum - 1) < 1e-6, `weights sum ~1, got ${weightSum}`);

  // composite = 80*(0.25/0.45) + 40*(0.20/0.45) = 44.444... ≈ 62.22
  assert.ok(
    Math.abs(data.composite - 62.22) < 0.01,
    `composite should be ~62.22, got ${data.composite}`
  );

  // Missing-factor coverage flag present.
  assert.ok(
    data.flags.some((f) => f.toLowerCase().includes("renormalized")),
    "expected a weights-renormalized coverage flag"
  );
});

test("edge: custom weights override defaults and renormalize", async () => {
  // Equal custom weights over the two present factors → simple average.
  const r = await run({
    factorScores: { scores: { value: 40, quality: 80 } },
    weights: { value: 1, quality: 1 },
  });
  assert.equal(r.success, true);
  const data = r.data as CompositeResult;
  assert.equal(data.available, true);
  // (40 + 80) / 2 = 60
  assert.ok(
    Math.abs(data.composite - 60) < 1e-9,
    `composite should be 60, got ${data.composite}`
  );
});

test("edge: all-zero weights fall back to equal weighting", async () => {
  const r = await run({
    factorScores: { scores: { value: 30, quality: 90 } },
    weights: { value: 0, quality: 0 },
  });
  assert.equal(r.success, true);
  const data = r.data as CompositeResult;
  assert.equal(data.available, true);
  // Equal fallback: (30 + 90) / 2 = 60
  assert.ok(
    Math.abs(data.composite - 60) < 1e-9,
    `equal-weight fallback composite should be 60, got ${data.composite}`
  );
});

test("edge: z-scores supplied → percentile uses normal CDF, no missing optional throw", async () => {
  // Single factor, z = 0 → normalCdf(0) = 0.5 → percentile = round(50) = 50,
  // independent of the raw score (which would otherwise proxy the percentile).
  const r = await run({
    factorScores: { scores: { quality: 72 } },
    factorZscores: { zscores: { quality: 0 } },
  });
  assert.equal(r.success, true);
  const data = r.data as CompositeResult;
  assert.equal(data.available, true);
  assert.equal(data.percentile, 50);
  // The supplied z-score is surfaced on the contribution.
  const q = data.contributions.find((c) => c.factor === "quality");
  assert.ok(q && q.zscore === 0);
});

test("edge: non-object inputs degrade gracefully (factorScores as string, weights as array)", async () => {
  const r = await run({
    factorScores: "not-an-object",
    weights: [1, 2, 3],
    symbol: "MARUTI",
  });
  // Non-object factorScores → asRecord null → no parseable scores → degraded,
  // and a non-object weights override is ignored without throwing.
  assert.equal(r.success, true);
  const data = r.data as CompositeResult;
  assert.equal(data.available, false);
});

test("edge: genuinely malformed input returns success:false with an error string", async () => {
  // A numeric symbol cannot be `.trim()`-ed → the tool's try/catch returns a
  // sanitized failure (success:false) rather than crashing the caller.
  const r = await run({
    factorScores: KNOWN_FACTORS,
    symbol: 42 as unknown as string,
  });
  assert.equal(r.success, false);
  assert.equal(typeof r.error, "string");
  assert.ok((r.error as string).length > 0);
});
