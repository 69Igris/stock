/**
 * Roast score-shaping helpers — negative / edge coverage (MONEY-620)
 *
 * Imports the REAL pure exports from
 * `packages/roast/src/lib/score-utils.ts` (no shadow). `generate-scores.ts`
 * calls `assembleScores` on its LLM-parsed payload, so these tests exercise
 * the exact production score-clamping path.
 *
 * Invariants pinned:
 *   - every emitted score is a finite integer in [0, 100];
 *   - NaN / negative / out-of-range / missing inputs never leak (no NaN, no
 *     value < 0 or > 100 ever reaches the score card);
 *   - the resilient "neutral 50 / comment N/A" degradation holds for empty,
 *     all-cash, single-holding and zero-invested portfolios alike (the score
 *     payload is independent of holding shape — it's the post-LLM clamp).
 *
 * Bug found + fixed (MONEY-620): the inline clamp in generate-scores.ts used
 * `Math.round(v ?? 50)` with no NaN guard, so a non-numeric model score (→ NaN)
 * propagated `NaN` into the score card and the DB `score` column. The
 * extracted `clampScore` now maps NaN → 50; pinned below.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampScore,
  assembleScores,
} from "../../../../packages/roast/src/lib/score-utils";
import type { ScoresResult } from "../../../../packages/roast/src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert n is a finite integer within the inclusive [0,100] score band. */
function assertScoreBound(n: number, label: string): void {
  assert.strictEqual(typeof n, "number", `${label}: not a number`);
  assert.ok(!Number.isNaN(n), `${label}: leaked NaN`);
  assert.ok(Number.isFinite(n), `${label}: not finite (${n})`);
  assert.ok(n >= 0 && n <= 100, `${label}: out of [0,100] (${n})`);
  assert.ok(Number.isInteger(n), `${label}: not an integer (${n})`);
}

/** Assert every score in an assembled ScoresResult is in-bounds. */
function assertAllBounds(result: ScoresResult): void {
  assertScoreBound(result.overallScore, "overallScore");
  assertScoreBound(
    result.scoreBreakdown.diversification.score,
    "diversification"
  );
  assertScoreBound(
    result.scoreBreakdown.riskManagement.score,
    "riskManagement"
  );
  assertScoreBound(result.scoreBreakdown.stockPicking.score, "stockPicking");
  assertScoreBound(result.scoreBreakdown.timing.score, "timing");
}

// ---------------------------------------------------------------------------
// clampScore — the load-bearing bound guard
// ---------------------------------------------------------------------------

describe("clampScore — bounds + NaN safety", () => {
  it("passes a normal in-range integer through unchanged", () => {
    assert.strictEqual(clampScore(72), 72);
  });

  it("clamps a value above 100 down to 100", () => {
    assert.strictEqual(clampScore(150), 100);
    assert.strictEqual(clampScore(1000), 100);
  });

  it("clamps a value below 0 up to 0", () => {
    assert.strictEqual(clampScore(-10), 0);
    assert.strictEqual(clampScore(-999), 0);
  });

  it("rounds a fractional value to the nearest integer", () => {
    assert.strictEqual(clampScore(72.7), 73);
    assert.strictEqual(clampScore(60.4), 60);
    assert.strictEqual(clampScore(0.5), 1);
    assert.strictEqual(clampScore(99.5), 100);
  });

  it("preserves a legitimate score of 0 (the ?? path, NOT ||) ", () => {
    // The shadow copies used `v || 50`, which wrongly coerces a real 0 → 50.
    // The real helper uses `?? 50`, so an explicit 0 stays 0. This is the
    // exact divergence that made the old shadow test assert wrong behaviour.
    assert.strictEqual(clampScore(0), 0);
  });

  it("preserves a legitimate score of 100", () => {
    assert.strictEqual(clampScore(100), 100);
  });

  it("maps undefined to the neutral default 50", () => {
    assert.strictEqual(clampScore(undefined), 50);
  });

  it("maps null to the neutral default 50", () => {
    assert.strictEqual(clampScore(null), 50);
  });

  it("maps NaN to 50 (no NaN leak)", () => {
    const out = clampScore(NaN);
    assert.strictEqual(out, 50);
    assert.ok(!Number.isNaN(out));
  });

  it("maps +Infinity to 100 and -Infinity to 0 (finite output guaranteed)", () => {
    assert.strictEqual(clampScore(Number.POSITIVE_INFINITY), 100);
    assert.strictEqual(clampScore(Number.NEGATIVE_INFINITY), 0);
  });

  it("never returns NaN / out-of-range for an adversarial numeric sweep", () => {
    const inputs = [
      -1e9,
      -100.6,
      -0.4,
      0,
      0.49,
      33.333,
      49.5,
      50,
      99.99,
      100,
      100.4,
      1e9,
      NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (const v of inputs) {
      assertScoreBound(clampScore(v), `clampScore(${v})`);
    }
  });
});

// ---------------------------------------------------------------------------
// assembleScores — full-payload shaping over edge portfolios
// ---------------------------------------------------------------------------

describe("assembleScores — empty / missing payloads", () => {
  it("empty object → all-neutral 50s with N/A comments (empty portfolio path)", () => {
    const r = assembleScores({});
    assertAllBounds(r);
    assert.strictEqual(r.overallScore, 50);
    assert.strictEqual(r.scoreBreakdown.diversification.score, 50);
    assert.strictEqual(r.scoreBreakdown.diversification.comment, "N/A");
    assert.strictEqual(r.scoreBreakdown.riskManagement.comment, "N/A");
    assert.strictEqual(r.scoreBreakdown.stockPicking.comment, "N/A");
    assert.strictEqual(r.scoreBreakdown.timing.comment, "N/A");
  });

  it("null payload → all-neutral 50s (resilient fallback, no throw)", () => {
    const r = assembleScores(null);
    assertAllBounds(r);
    assert.strictEqual(r.overallScore, 50);
  });

  it("undefined payload → all-neutral 50s (resilient fallback, no throw)", () => {
    const r = assembleScores(undefined);
    assertAllBounds(r);
    assert.strictEqual(r.overallScore, 50);
  });

  it("payload with overallScore only → breakdown defaults to 50/N/A", () => {
    const r = assembleScores({ overallScore: 64 });
    assertAllBounds(r);
    assert.strictEqual(r.overallScore, 64);
    assert.strictEqual(r.scoreBreakdown.timing.score, 50);
    assert.strictEqual(r.scoreBreakdown.timing.comment, "N/A");
  });

  it("payload with empty scoreBreakdown object → each category 50/N/A", () => {
    const r = assembleScores({ overallScore: 64, scoreBreakdown: {} as never });
    assertAllBounds(r);
    assert.strictEqual(r.scoreBreakdown.diversification.score, 50);
  });
});

describe("assembleScores — adversarial numeric values (no NaN, bounds hold)", () => {
  it("NaN scores across all categories degrade to 50, never leak NaN", () => {
    const r = assembleScores({
      overallScore: NaN,
      scoreBreakdown: {
        diversification: { score: NaN, comment: "x" },
        riskManagement: { score: NaN, comment: "y" },
        stockPicking: { score: NaN, comment: "z" },
        timing: { score: NaN, comment: "w" },
      },
    } as unknown as Partial<ScoresResult>);
    assertAllBounds(r);
    assert.strictEqual(r.overallScore, 50);
    assert.strictEqual(r.scoreBreakdown.diversification.score, 50);
  });

  it("negative scores clamp to 0 (100%-one-stock-concentration penalty case)", () => {
    // A pathological "everything in one stock" roast might have the model emit
    // very negative diversification/risk scores; they must floor at 0.
    const r = assembleScores({
      overallScore: -25,
      scoreBreakdown: {
        diversification: { score: -100, comment: "All eggs, one basket" },
        riskManagement: { score: -40, comment: "Undiversified" },
        stockPicking: { score: 55, comment: "ok" },
        timing: { score: 60, comment: "ok" },
      },
    });
    assertAllBounds(r);
    assert.strictEqual(r.overallScore, 0);
    assert.strictEqual(r.scoreBreakdown.diversification.score, 0);
    assert.strictEqual(r.scoreBreakdown.riskManagement.score, 0);
    assert.strictEqual(r.scoreBreakdown.stockPicking.score, 55);
  });

  it("scores above 100 clamp to 100", () => {
    const r = assembleScores({
      overallScore: 250,
      scoreBreakdown: {
        diversification: { score: 101, comment: "a" },
        riskManagement: { score: 9999, comment: "b" },
        stockPicking: { score: 100, comment: "c" },
        timing: { score: 100, comment: "d" },
      },
    });
    assertAllBounds(r);
    assert.strictEqual(r.overallScore, 100);
    assert.strictEqual(r.scoreBreakdown.diversification.score, 100);
    assert.strictEqual(r.scoreBreakdown.riskManagement.score, 100);
  });

  it("explicit zero scores stay 0 (not coerced to 50) — zero-invested portfolio", () => {
    // A portfolio with zero invested value can legitimately score 0 across the
    // board. The ?? semantics must keep those zeros (the shadow's || would
    // have wrongly shown 50s here).
    const r = assembleScores({
      overallScore: 0,
      scoreBreakdown: {
        diversification: { score: 0, comment: "Nothing invested" },
        riskManagement: { score: 0, comment: "Nothing invested" },
        stockPicking: { score: 0, comment: "Nothing invested" },
        timing: { score: 0, comment: "Nothing invested" },
      },
    });
    assertAllBounds(r);
    assert.strictEqual(r.overallScore, 0);
    assert.strictEqual(r.scoreBreakdown.timing.score, 0);
  });

  it("fractional model scores round and stay in-bounds (single-holding portfolio)", () => {
    const r = assembleScores({
      overallScore: 73.6,
      scoreBreakdown: {
        diversification: { score: 12.4, comment: "Single holding" },
        riskManagement: { score: 49.5, comment: "Concentrated" },
        stockPicking: { score: 88.9, comment: "Strong pick" },
        timing: { score: 50.5, comment: "ok" },
      },
    });
    assertAllBounds(r);
    assert.strictEqual(r.overallScore, 74);
    assert.strictEqual(r.scoreBreakdown.diversification.score, 12);
    assert.strictEqual(r.scoreBreakdown.riskManagement.score, 50);
    assert.strictEqual(r.scoreBreakdown.stockPicking.score, 89);
    assert.strictEqual(r.scoreBreakdown.timing.score, 51);
  });

  it("string / non-number score (coerced via parse) never leaks NaN", () => {
    // The model occasionally returns a stringified score; once it lands as a
    // non-number it would coerce to NaN through Math.round. Pin that the
    // helper still emits a finite in-bounds value.
    const r = assembleScores({
      overallScore: "abc" as unknown as number,
      scoreBreakdown: {
        diversification: {
          score: "high" as unknown as number,
          comment: "c",
        },
        riskManagement: { score: undefined as unknown as number, comment: "" },
        stockPicking: { score: null as unknown as number, comment: "" },
        timing: { score: 70, comment: "ok" },
      },
    });
    assertAllBounds(r);
    assert.strictEqual(r.scoreBreakdown.timing.score, 70);
  });
});

describe("assembleScores — comment fallbacks", () => {
  it("empty-string comments fall back to N/A", () => {
    const r = assembleScores({
      overallScore: 60,
      scoreBreakdown: {
        diversification: { score: 60, comment: "" },
        riskManagement: { score: 60, comment: "" },
        stockPicking: { score: 60, comment: "" },
        timing: { score: 60, comment: "" },
      },
    });
    assert.strictEqual(r.scoreBreakdown.diversification.comment, "N/A");
    assert.strictEqual(r.scoreBreakdown.timing.comment, "N/A");
  });

  it("preserves real comments verbatim", () => {
    const r = assembleScores({
      overallScore: 60,
      scoreBreakdown: {
        diversification: { score: 60, comment: "Well spread" },
        riskManagement: { score: 60, comment: "Balanced" },
        stockPicking: { score: 60, comment: "Solid" },
        timing: { score: 60, comment: "Patient" },
      },
    });
    assert.strictEqual(r.scoreBreakdown.diversification.comment, "Well spread");
    assert.strictEqual(r.scoreBreakdown.riskManagement.comment, "Balanced");
  });
});
