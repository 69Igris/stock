/**
 * MONEY-620 — roast SERVICE pure-logic unit tests.
 *
 * Asserts the REAL exported helpers from
 * `packages/services/src/roast-logic.ts` (imported via a relative path — the
 * module is pure, no Prisma / network / AI at import, so a direct import is
 * safe; the same precedent as `roast/score-utils.test.ts` importing the roast
 * package's pure lib). NO shadow: the SERVICE calls these SAME functions on the
 * Prisma rows it returns (see `roast-poison-live.test.ts`), so production and
 * these tests execute identical code.
 *
 * Focus = the four blind spots the roast SERVICE exposed by forwarding raw DB
 * `score`/`progress` to the gauge / progress view:
 *   - non-finite / out-of-[0,100] scores must NOT reach the gauge as NaN nor
 *     escape the colour/label band;
 *   - grade/band boundaries are off-by-one-correct (exactly 80 → "great");
 *   - empty / all-non-finite sub-scores never divide-by-zero to NaN;
 *   - progress div-by-zero (0 total steps) and >100 overshoot are bounded;
 *   - an Invalid-Date / unknown-status row derives a lifecycle WITHOUT throwing
 *     on `.toISOString()` and presents a terminal/stuck signal sanely.
 *
 * Source: packages/services/src/roast-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  finite,
  clampScore,
  clampNullableScore,
  clampProgress,
  deriveProgressFromSteps,
  deriveRoastGrade,
  averageSubScores,
  deriveRoastLifecycle,
  sanitizeRoastStatusData,
  sanitizeRoastListItem,
  DEFAULT_ROAST_SCORE,
  ROAST_STUCK_THRESHOLD_MS,
  TERMINAL_ROAST_STATUSES,
  type RawRoastStatus,
} from "../../../../packages/services/src/roast-logic";

// ---------------------------------------------------------------------------
// finite()
// ---------------------------------------------------------------------------

describe("roast-logic.finite", () => {
  it("passes finite numbers through unchanged (incl. 0 and negatives)", () => {
    assert.equal(finite(0), 0);
    assert.equal(finite(42.5), 42.5);
    assert.equal(finite(-13), -13);
  });

  it("collapses null / undefined / NaN / ±Infinity to the fallback", () => {
    assert.equal(finite(null), 0);
    assert.equal(finite(undefined), 0);
    assert.equal(finite(NaN), 0);
    assert.equal(finite(Infinity), 0);
    assert.equal(finite(-Infinity), 0);
  });

  it("honours a custom fallback", () => {
    assert.equal(finite(NaN, 7), 7);
    assert.equal(finite(null, -1), -1);
  });
});

// ---------------------------------------------------------------------------
// clampScore — the always-present overallScore contract (mirrors score-utils)
// ---------------------------------------------------------------------------

describe("roast-logic.clampScore", () => {
  it("rounds fractional finite scores to the nearest int", () => {
    assert.equal(clampScore(72.4), 72);
    assert.equal(clampScore(72.5), 73);
    assert.equal(clampScore(0.49), 0);
  });

  it("preserves a legitimate 0 (uses ?? not ||)", () => {
    // The drift bug score-utils warns about: `0 || 50` => 50 (wrong).
    assert.equal(clampScore(0), 0);
  });

  it("defaults null / undefined to 50", () => {
    assert.equal(clampScore(null), DEFAULT_ROAST_SCORE);
    assert.equal(clampScore(undefined), 50);
  });

  it("[BUG GUARD] NaN / ±Infinity never escape as NaN — they default to 50", () => {
    assert.equal(clampScore(NaN), 50);
    assert.equal(clampScore(Infinity), 50);
    assert.equal(clampScore(-Infinity), 50);
    assert.ok(Number.isFinite(clampScore(NaN)));
  });

  it("clamps out-of-[0,100] to the nearest bound", () => {
    assert.equal(clampScore(150), 100);
    assert.equal(clampScore(101), 100);
    assert.equal(clampScore(-50), 0);
    assert.equal(clampScore(-0.6), 0);
  });

  it("keeps the inclusive bounds 0 and 100", () => {
    assert.equal(clampScore(0), 0);
    assert.equal(clampScore(100), 100);
  });
});

// ---------------------------------------------------------------------------
// clampNullableScore — the status/list score contract (null is meaningful)
// ---------------------------------------------------------------------------

describe("roast-logic.clampNullableScore", () => {
  it("[CRITICAL] PRESERVES null/undefined as null (in-progress, NOT 50)", () => {
    // The key divergence from clampScore: an in-progress roast has no score
    // yet; it must NOT show a phantom 50.
    assert.equal(clampNullableScore(null), null);
    assert.equal(clampNullableScore(undefined), null);
  });

  it("preserves a legitimate 0 score (not null, not 50)", () => {
    assert.equal(clampNullableScore(0), 0);
  });

  it("[BUG GUARD] a PRESENT but non-finite score coerces to 50, never NaN/Infinity", () => {
    assert.equal(clampNullableScore(NaN), 50);
    assert.equal(clampNullableScore(Infinity), 50);
    assert.equal(clampNullableScore(-Infinity), 50);
  });

  it("rounds + clamps a present out-of-range score", () => {
    assert.equal(clampNullableScore(150), 100);
    assert.equal(clampNullableScore(-20), 0);
    assert.equal(clampNullableScore(72.6), 73);
  });

  it("passes a finite in-range score straight through (behaviour-preserving)", () => {
    assert.equal(clampNullableScore(65), 65);
    assert.equal(clampNullableScore(100), 100);
  });
});

// ---------------------------------------------------------------------------
// clampProgress — the progress-% contract
// ---------------------------------------------------------------------------

describe("roast-logic.clampProgress", () => {
  it("passes finite in-range progress through (rounded to int)", () => {
    assert.equal(clampProgress(0), 0);
    assert.equal(clampProgress(40), 40);
    assert.equal(clampProgress(100), 100);
    assert.equal(clampProgress(33.6), 34);
  });

  it("[BUG GUARD] null / undefined / NaN / ±Infinity → 0 (never NaN%/Infinity%)", () => {
    assert.equal(clampProgress(null), 0);
    assert.equal(clampProgress(undefined), 0);
    assert.equal(clampProgress(NaN), 0);
    assert.equal(clampProgress(Infinity), 0);
    assert.equal(clampProgress(-Infinity), 0);
  });

  it("[BUG GUARD] >100 overshoot clamps to 100; <0 clamps to 0 (never 150%/-30%)", () => {
    assert.equal(clampProgress(150), 100);
    assert.equal(clampProgress(101), 100);
    assert.equal(clampProgress(-30), 0);
  });
});

// ---------------------------------------------------------------------------
// deriveProgressFromSteps — div-by-zero-safe
// ---------------------------------------------------------------------------

describe("roast-logic.deriveProgressFromSteps", () => {
  it("[BUG GUARD] 0 total steps → 0, NEVER 0/0 = NaN", () => {
    assert.equal(deriveProgressFromSteps(0, 0), 0);
    assert.equal(deriveProgressFromSteps(3, 0), 0);
    assert.ok(Number.isFinite(deriveProgressFromSteps(0, 0)));
  });

  it("computes a normal step ratio as a clamped integer percent", () => {
    assert.equal(deriveProgressFromSteps(0, 8), 0);
    assert.equal(deriveProgressFromSteps(4, 8), 50);
    assert.equal(deriveProgressFromSteps(8, 8), 100);
    assert.equal(deriveProgressFromSteps(1, 3), 33); // 33.33 → 33
  });

  it("[BUG GUARD] completed > total overshoot clamps to 100 (double-incremented counter)", () => {
    assert.equal(deriveProgressFromSteps(10, 8), 100);
  });

  it("[BUG GUARD] negative / non-finite counts collapse to a finite 0..100", () => {
    assert.equal(deriveProgressFromSteps(-1, 8), 0);
    assert.equal(deriveProgressFromSteps(NaN, 8), 0);
    assert.equal(deriveProgressFromSteps(4, NaN), 0);
    // A non-finite `completed` is untrustworthy → finite() collapses it to 0,
    // so the derived progress is 0 (NOT 100): we never trust an Infinity count
    // to mean "complete".
    assert.equal(deriveProgressFromSteps(Infinity, 8), 0);
    assert.equal(deriveProgressFromSteps(null, null), 0);
  });
});

// ---------------------------------------------------------------------------
// deriveRoastGrade — boundary-correct band/letter mapping
// ---------------------------------------------------------------------------

describe("roast-logic.deriveRoastGrade", () => {
  it("[BOUNDARY] exact band edges land lower-inclusive (off-by-one guard)", () => {
    // Mirrors the gauge's `< threshold` ladder exactly.
    assert.equal(deriveRoastGrade(0).band, "disaster");
    assert.equal(deriveRoastGrade(29).band, "disaster");
    assert.equal(deriveRoastGrade(30).band, "yikes"); // exactly 30
    assert.equal(deriveRoastGrade(40).band, "rough"); // exactly 40
    assert.equal(deriveRoastGrade(50).band, "meh"); // exactly 50
    assert.equal(deriveRoastGrade(60).band, "decent"); // exactly 60
    assert.equal(deriveRoastGrade(70).band, "solid"); // exactly 70
    assert.equal(deriveRoastGrade(80).band, "great"); // exactly 80 → great, NOT solid
    assert.equal(deriveRoastGrade(90).band, "legend"); // exactly 90
    assert.equal(deriveRoastGrade(100).band, "legend");
  });

  it("maps each band to its letter grade", () => {
    assert.equal(deriveRoastGrade(10).letter, "F"); // disaster
    assert.equal(deriveRoastGrade(35).letter, "F"); // yikes
    assert.equal(deriveRoastGrade(45).letter, "D"); // rough
    assert.equal(deriveRoastGrade(55).letter, "C"); // meh
    assert.equal(deriveRoastGrade(65).letter, "C"); // decent
    assert.equal(deriveRoastGrade(75).letter, "B"); // solid
    assert.equal(deriveRoastGrade(85).letter, "B"); // great
    assert.equal(deriveRoastGrade(95).letter, "A"); // legend
  });

  it("returns the clamped score actually used for the mapping", () => {
    assert.equal(deriveRoastGrade(72.6).score, 73);
    assert.equal(deriveRoastGrade(150).score, 100);
    assert.equal(deriveRoastGrade(-5).score, 0);
  });

  it("[BUG GUARD] NaN / Infinity / out-of-range never fall through to an undefined band", () => {
    // A naive ladder with no clamp would leave `band` undefined for NaN
    // (every `<` comparison is false). The clamp forces a real band.
    // NON-FINITE (NaN/±Infinity) → the neutral DEFAULT 50 → "meh"/"C" (the
    // clampScore contract treats ±Infinity as "no usable score", NOT as 100/0).
    const g = deriveRoastGrade(NaN);
    assert.equal(g.band, "meh");
    assert.equal(g.letter, "C");
    assert.equal(g.score, 50);
    assert.equal(deriveRoastGrade(Infinity).band, "meh"); // non-finite → 50
    assert.equal(deriveRoastGrade(-Infinity).band, "meh"); // non-finite → 50
    // FINITE but out-of-range DOES clamp to the bound.
    assert.equal(deriveRoastGrade(999).band, "legend"); // clamps to 100
    assert.equal(deriveRoastGrade(-5).band, "disaster"); // clamps to 0
    assert.equal(deriveRoastGrade(null).band, "meh"); // null → 50
  });
});

// ---------------------------------------------------------------------------
// averageSubScores — div-by-zero & non-finite immune
// ---------------------------------------------------------------------------

describe("roast-logic.averageSubScores", () => {
  it("averages finite sub-scores and clamps to an int", () => {
    assert.equal(averageSubScores([50, 60, 70, 80]), 65);
    assert.equal(averageSubScores([100, 0]), 50);
    assert.equal(averageSubScores([33, 34]), 34); // 33.5 → 34
  });

  it("[BUG GUARD] empty array → 50, NEVER 0/0 = NaN", () => {
    assert.equal(averageSubScores([]), DEFAULT_ROAST_SCORE);
    assert.ok(Number.isFinite(averageSubScores([])));
  });

  it("[BUG GUARD] a single NaN/Infinity member does not poison the average", () => {
    // 50 & 70 are the only finite members → average 60, NaN/Infinity ignored.
    assert.equal(averageSubScores([50, NaN, 70]), 60);
    assert.equal(averageSubScores([50, Infinity, 70]), 60);
    assert.equal(averageSubScores([50, -Infinity, 70, null, undefined]), 60);
  });

  it("[BUG GUARD] all-non-finite / all-null array → 50 (no division by an empty divisor)", () => {
    assert.equal(averageSubScores([NaN, Infinity, null, undefined]), 50);
  });

  it("clamps an out-of-range average to [0,100]", () => {
    assert.equal(averageSubScores([200, 200]), 100);
    assert.equal(averageSubScores([-50, -50]), 0);
  });
});

// ---------------------------------------------------------------------------
// deriveRoastLifecycle — Invalid-Date / unknown-status safe
// ---------------------------------------------------------------------------

describe("roast-logic.deriveRoastLifecycle", () => {
  const NOW = new Date("2026-06-05T12:00:00Z").getTime();

  it("marks COMPLETED / FAILED terminal", () => {
    assert.equal(
      deriveRoastLifecycle("COMPLETED", new Date(NOW), NOW).isTerminal,
      true
    );
    assert.equal(
      deriveRoastLifecycle("FAILED", new Date(NOW), NOW).isTerminal,
      true
    );
  });

  it("marks an in-flight status non-terminal", () => {
    const lc = deriveRoastLifecycle("ANALYZING_STOCKS", new Date(NOW), NOW);
    assert.equal(lc.isTerminal, false);
    assert.equal(lc.status, "ANALYZING_STOCKS");
  });

  it("[BUG GUARD] Invalid-Date createdAt → ageMs null, no throw on derivation", () => {
    // The dashboard 500'd by calling `.toISOString()` on such a value; here it
    // degrades to age-unknown and must never throw.
    assert.doesNotThrow(() => {
      const lc = deriveRoastLifecycle(
        "FETCHING_DATA",
        new Date("not-a-real-date"),
        NOW
      );
      assert.equal(lc.ageMs, null);
      assert.equal(lc.isStuck, false); // unknown age => never falsely "stuck"
    });
  });

  it("[BUG GUARD] null / undefined createdAt → ageMs null, not stuck, no throw", () => {
    assert.doesNotThrow(() => {
      assert.equal(deriveRoastLifecycle("QUEUED", null, NOW).ageMs, null);
      assert.equal(
        deriveRoastLifecycle("QUEUED", undefined, NOW).isStuck,
        false
      );
    });
  });

  it("[BUG GUARD] empty / whitespace / unknown status → normalised to FAILED (no eternal spinner)", () => {
    assert.equal(deriveRoastLifecycle("", new Date(NOW), NOW).status, "FAILED");
    assert.equal(
      deriveRoastLifecycle("   ", new Date(NOW), NOW).status,
      "FAILED"
    );
    assert.equal(
      deriveRoastLifecycle(null, new Date(NOW), NOW).status,
      "FAILED"
    );
    assert.equal(
      deriveRoastLifecycle(undefined, new Date(NOW), NOW).isTerminal,
      true
    );
  });

  it("flags a long-running non-terminal roast as stuck past the threshold", () => {
    const created = new Date(NOW - ROAST_STUCK_THRESHOLD_MS - 1000);
    const lc = deriveRoastLifecycle("ANALYZING_MF", created, NOW);
    assert.equal(lc.isStuck, true);
    assert.ok(lc.ageMs! > ROAST_STUCK_THRESHOLD_MS);
  });

  it("does NOT flag a fresh non-terminal roast as stuck", () => {
    const created = new Date(NOW - 60 * 1000); // 1 min old
    assert.equal(deriveRoastLifecycle("SCORING", created, NOW).isStuck, false);
  });

  it("does NOT flag a stale-but-TERMINAL roast as stuck", () => {
    const created = new Date(NOW - 5 * ROAST_STUCK_THRESHOLD_MS);
    assert.equal(
      deriveRoastLifecycle("COMPLETED", created, NOW).isStuck,
      false
    );
  });

  it("[BUG GUARD] clock-skew future createdAt (negative age) is not stuck", () => {
    const created = new Date(NOW + 10 * 60 * 1000); // 10 min in the future
    const lc = deriveRoastLifecycle("QUEUED", created, NOW);
    assert.ok(lc.ageMs! < 0);
    assert.equal(lc.isStuck, false);
  });

  it("trims a padded status", () => {
    assert.equal(
      deriveRoastLifecycle("  COMPLETED  ", new Date(NOW), NOW).status,
      "COMPLETED"
    );
  });

  it("TERMINAL_ROAST_STATUSES is exactly [COMPLETED, FAILED]", () => {
    assert.deepEqual([...TERMINAL_ROAST_STATUSES], ["COMPLETED", "FAILED"]);
  });
});

// ---------------------------------------------------------------------------
// sanitizeRoastStatusData — the getRoastStatus consumer-safety shaper
// ---------------------------------------------------------------------------

describe("roast-logic.sanitizeRoastStatusData", () => {
  function raw(overrides: Partial<RawRoastStatus> = {}): RawRoastStatus {
    return {
      status: "ANALYZING_STOCKS",
      progress: 40,
      currentStep: "Analyzing stocks",
      score: null,
      errorMessage: null,
      ...overrides,
    };
  }

  it("passes a clean in-progress row through (behaviour-preserving)", () => {
    assert.deepEqual(sanitizeRoastStatusData(raw()), {
      status: "ANALYZING_STOCKS",
      progress: 40,
      currentStep: "Analyzing stocks",
      score: null,
      errorMessage: null,
    });
  });

  it("passes a clean completed row through with its score", () => {
    const out = sanitizeRoastStatusData(
      raw({ status: "COMPLETED", progress: 100, score: 72, currentStep: null })
    );
    assert.equal(out.score, 72);
    assert.equal(out.progress, 100);
  });

  it("[BUG GUARD] NaN score → null-safe 50, NaN progress → 0 (never reaches gauge raw)", () => {
    const out = sanitizeRoastStatusData(
      raw({ status: "COMPLETED", progress: NaN, score: NaN })
    );
    assert.equal(out.score, 50);
    assert.equal(out.progress, 0);
    assert.ok(Number.isFinite(out.progress));
    assert.ok(out.score === null || Number.isFinite(out.score));
  });

  it("[BUG GUARD] out-of-range progress 150 & score 200 clamp to 100", () => {
    const out = sanitizeRoastStatusData(
      raw({ status: "COMPLETED", progress: 150, score: 200 })
    );
    assert.equal(out.progress, 100);
    assert.equal(out.score, 100);
  });

  it("[CRITICAL] in-progress null score STAYS null (no phantom 50)", () => {
    const out = sanitizeRoastStatusData(raw({ score: null, progress: 25 }));
    assert.equal(out.score, null);
  });

  it("[BUG GUARD] Infinity progress → 0, -Infinity score → 50", () => {
    const out = sanitizeRoastStatusData(
      raw({ progress: Infinity, score: -Infinity })
    );
    assert.equal(out.progress, 0);
    assert.equal(out.score, 50);
  });

  it("the rendered `${progress}%` / `${score}` strings are never NaN/Infinity", () => {
    const out = sanitizeRoastStatusData(
      raw({ progress: NaN, score: Infinity, status: "COMPLETED" })
    );
    assert.notEqual(`${out.progress}%`, "NaN%");
    assert.notEqual(`${out.progress}%`, "Infinity%");
    assert.notEqual(`${out.score}`, "NaN");
    assert.notEqual(`${out.score}`, "Infinity");
  });

  it("preserves status / currentStep / errorMessage verbatim", () => {
    const out = sanitizeRoastStatusData(
      raw({
        status: "FAILED",
        currentStep: null,
        errorMessage: "sync token expired",
      })
    );
    assert.equal(out.status, "FAILED");
    assert.equal(out.currentStep, null);
    assert.equal(out.errorMessage, "sync token expired");
  });
});

// ---------------------------------------------------------------------------
// sanitizeRoastListItem — running / recent / history row shaper
// ---------------------------------------------------------------------------

describe("roast-logic.sanitizeRoastListItem", () => {
  it("running row (progress only): clamps progress, adds NO phantom score", () => {
    const out = sanitizeRoastListItem({
      sessionId: "s1",
      mode: "overall",
      progress: 150,
    });
    assert.equal(out.progress, 100);
    assert.equal("score" in out, false, "must not invent a score field");
    assert.equal(out.sessionId, "s1");
    assert.equal(out.mode, "overall");
  });

  it("history row (score only): clamps score, adds NO phantom progress", () => {
    const out = sanitizeRoastListItem({
      id: "h1",
      sessionId: "s2",
      score: NaN,
    });
    assert.equal(out.score, 50);
    assert.equal("progress" in out, false, "must not invent a progress field");
    assert.equal(out.id, "h1");
  });

  it("recent row (both): clamps progress, PRESERVES null score for in-progress", () => {
    const inProgress = sanitizeRoastListItem({
      sessionId: "s3",
      progress: 10,
      score: null,
    });
    assert.equal(inProgress.progress, 10);
    assert.equal(inProgress.score, null);

    const done = sanitizeRoastListItem({
      sessionId: "s4",
      progress: 100,
      score: 65,
    });
    assert.equal(done.score, 65);
  });

  it("[BUG GUARD] both corrupt: NaN progress → 0, Infinity score → 50", () => {
    const out = sanitizeRoastListItem({
      sessionId: "s5",
      progress: NaN,
      score: Infinity,
    });
    assert.equal(out.progress, 0);
    assert.equal(out.score, 50);
  });

  it("behaviour-preserving: finite in-range row is unchanged in value", () => {
    const row = {
      sessionId: "s6",
      mode: "broker",
      broker: "ZERODHA",
      assetType: "stocks",
      status: "COMPLETED",
      progress: 100,
      currentStep: null,
      score: 80,
      createdAt: new Date("2026-06-05T10:00:00Z"),
    };
    assert.deepEqual(sanitizeRoastListItem(row), row);
  });

  it("does not mutate the input row (returns a copy)", () => {
    const row = { sessionId: "s7", progress: 999, score: NaN };
    const out = sanitizeRoastListItem(row);
    assert.equal(row.progress, 999, "input untouched");
    assert.ok(Number.isNaN(row.score), "input untouched");
    assert.equal(out.progress, 100);
    assert.equal(out.score, 50);
  });
});
