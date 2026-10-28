/**
 * Recent-roast list-item shaping — real-source tests (MONEY-543).
 *
 * NOTE: the previous version of this file asserted a hand-rolled `MockContext`
 * re-implementation of `getRecentRoastSessionsAction`. That action DOES NOT
 * EXIST in the source (apps/web/lib/actions/roast.ts has no such export). The
 * real reconcile path runs through the SERVICE `getRecentRoastSessions`
 * (packages/services/src/roast.service.ts), and the data-integrity contract
 * EVERY recent / running / history roast row passes through is the pure
 * `sanitizeRoastListItem` (+ `clampNullableScore` / `clampProgress`) in
 * packages/services/src/roast-logic.ts.
 *
 * This file imports those REAL exports and asserts the actual non-finite /
 * null-preserving contract — the genuine guard that stops an in-progress roast
 * from rendering a phantom score, or a corrupt row from rendering "NaN%". No
 * inline re-implementation, no fictional action.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeRoastListItem,
  clampNullableScore,
  clampProgress,
  DEFAULT_ROAST_SCORE,
} from "../../../../packages/services/src/roast-logic";

// The shape of a "recent roast" row (mode/broker/status descriptive fields
// flow through untouched; progress + score are the guarded numerics).
interface RecentRoastRow {
  sessionId: string;
  mode: string;
  broker: string | null;
  assetType: string;
  status: string;
  progress?: number | null;
  currentStep: string | null;
  score?: number | null;
  createdAt: Date;
}

function row(overrides: Partial<RecentRoastRow> = {}): RecentRoastRow {
  return {
    sessionId: "roast-001",
    mode: "overall",
    broker: null,
    assetType: "all",
    status: "COMPLETED",
    progress: 100,
    currentStep: null,
    score: 72,
    createdAt: new Date("2026-05-29T10:00:00Z"),
    ...overrides,
  };
}

describe("MONEY-543 — recent roast list-item shaping (real source)", () => {
  // ── sanitizeRoastListItem on the recent-roast shape ─────────────────

  describe("sanitizeRoastListItem", () => {
    it("passes a clean finite row through unchanged", () => {
      const r = row({ progress: 60, score: 80 });
      const out = sanitizeRoastListItem(r);
      assert.strictEqual(out.progress, 60);
      assert.strictEqual(out.score, 80);
      // Descriptive fields untouched.
      assert.strictEqual(out.sessionId, "roast-001");
      assert.strictEqual(out.mode, "overall");
      assert.strictEqual(out.createdAt, r.createdAt);
    });

    it("preserves a null score for an in-progress roast (no phantom 50)", () => {
      const out = sanitizeRoastListItem(
        row({ status: "ANALYZING_MF", progress: 60, score: null })
      );
      assert.strictEqual(out.score, null);
      assert.strictEqual(out.progress, 60);
    });

    it("clamps a NaN progress to 0 (never NaN%)", () => {
      const out = sanitizeRoastListItem(row({ progress: NaN, score: 72 }));
      assert.strictEqual(out.progress, 0);
      assert.strictEqual(out.score, 72);
    });

    it("clamps an out-of-range progress to [0,100]", () => {
      assert.strictEqual(
        sanitizeRoastListItem(row({ progress: 150 })).progress,
        100
      );
      assert.strictEqual(
        sanitizeRoastListItem(row({ progress: -5 })).progress,
        0
      );
    });

    it("rewrites a present-but-corrupt score to the neutral fallback", () => {
      const out = sanitizeRoastListItem(row({ score: Infinity }));
      assert.strictEqual(out.score, DEFAULT_ROAST_SCORE);
    });

    it("does NOT add a phantom score when the row omits the key", () => {
      // Running-list shape: has progress, no score key at all.
      const runningRow = {
        sessionId: "r-2",
        mode: "broker",
        broker: "ZERODHA",
        assetType: "stocks",
        status: "PLANNING",
        progress: 10,
        currentStep: "Fetching",
        createdAt: new Date("2026-05-29T10:00:00Z"),
      };
      const out = sanitizeRoastListItem(runningRow);
      assert.strictEqual("score" in out, false);
      assert.strictEqual(out.progress, 10);
    });

    it("does NOT add a phantom progress when the row omits the key", () => {
      // History-list shape: has score, no progress key.
      const historyRow = {
        sessionId: "r-3",
        mode: "overall",
        broker: null,
        assetType: "all",
        status: "COMPLETED",
        score: 64,
        currentStep: null,
        createdAt: new Date("2026-05-29T10:00:00Z"),
      };
      const out = sanitizeRoastListItem(historyRow);
      assert.strictEqual("progress" in out, false);
      assert.strictEqual(out.score, 64);
    });
  });

  // ── The underlying guards, directly ─────────────────────────────────

  describe("clampNullableScore (status/list score column)", () => {
    it("preserves null (not scored yet)", () => {
      assert.strictEqual(clampNullableScore(null), null);
      assert.strictEqual(clampNullableScore(undefined), null);
    });

    it("keeps a real 0 score", () => {
      assert.strictEqual(clampNullableScore(0), 0);
    });

    it("maps a present NaN/±Infinity to the neutral fallback", () => {
      assert.strictEqual(clampNullableScore(NaN), DEFAULT_ROAST_SCORE);
      assert.strictEqual(clampNullableScore(Infinity), DEFAULT_ROAST_SCORE);
    });

    it("rounds + clamps an out-of-range score", () => {
      assert.strictEqual(clampNullableScore(150), 100);
      assert.strictEqual(clampNullableScore(-10), 0);
      assert.strictEqual(clampNullableScore(72.6), 73);
    });
  });

  describe("clampProgress (list progress column)", () => {
    it("null/NaN/±Infinity → 0", () => {
      assert.strictEqual(clampProgress(null), 0);
      assert.strictEqual(clampProgress(NaN), 0);
      assert.strictEqual(clampProgress(Infinity), 0);
    });

    it("keeps an in-range integer and clamps the rest", () => {
      assert.strictEqual(clampProgress(55), 55);
      assert.strictEqual(clampProgress(150), 100);
      assert.strictEqual(clampProgress(-3), 0);
    });
  });
});
