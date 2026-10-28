/**
 * Pure score-shaping helpers for the roast pipeline (MONEY-620).
 *
 * The scoring math used to live inline inside `steps/generate-scores.ts`,
 * tangled with the Gemini call, so it could only be "tested" by shadow copies
 * that re-declared the clamp logic in the test file. Those shadows drifted
 * from the source (they used `v || 50` while the source uses `v ?? 50`, which
 * disagree for a legitimate score of 0) — exactly the failure mode the
 * test-writing policy exists to prevent.
 *
 * These functions are extracted as PURE, exported symbols so:
 *   - `generate-scores.ts` calls them on the LLM-parsed object (same code path
 *     as production), and
 *   - tests import & assert the REAL implementation.
 *
 * No DB / network / AI dependency — safe to import from any test runner.
 */

import type { ScoresResult } from "../types";

/**
 * Clamp a raw score into the inclusive 0–100 band the UI renders.
 *
 *   - `undefined`/`null` → 50 (neutral default; matches the resilient-parse
 *     contract where a missing field degrades to "neutral" rather than failing
 *     the roast).
 *   - `NaN` (e.g. the model emitted a non-numeric score that coerced to NaN)
 *     → 50. Without this guard `Math.round(NaN)` stays `NaN` and propagates a
 *     `NaN` straight into the score card / DB `score` column (MONEY-620 bug).
 *   - Fractional values are rounded to the nearest integer.
 *   - Values outside [0,100] are clamped to the nearest bound.
 *
 * Returns a finite integer in [0, 100], always.
 */
export function clampScore(v: number | undefined | null): number {
  const n = v ?? 50;
  if (typeof n !== "number" || Number.isNaN(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Shape a (possibly partial / malformed) parsed LLM payload into a fully
 * populated, clamped `ScoresResult`. Every numeric score is passed through
 * {@link clampScore}; every comment falls back to "N/A".
 *
 * This is the single source of truth for the score-assembly that
 * `generate-scores.ts` returns, so the production path and the unit tests
 * execute identical logic.
 */
export function assembleScores(
  parsed: Partial<ScoresResult> | null | undefined,
): ScoresResult {
  const breakdown = parsed?.scoreBreakdown;
  return {
    overallScore: clampScore(parsed?.overallScore),
    scoreBreakdown: {
      diversification: {
        score: clampScore(breakdown?.diversification?.score),
        comment: breakdown?.diversification?.comment || "N/A",
      },
      riskManagement: {
        score: clampScore(breakdown?.riskManagement?.score),
        comment: breakdown?.riskManagement?.comment || "N/A",
      },
      stockPicking: {
        score: clampScore(breakdown?.stockPicking?.score),
        comment: breakdown?.stockPicking?.comment || "N/A",
      },
      timing: {
        score: clampScore(breakdown?.timing?.score),
        comment: breakdown?.timing?.comment || "N/A",
      },
    },
  };
}
