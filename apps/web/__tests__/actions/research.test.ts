/**
 * Research Server Actions — real-source tests.
 *
 * NOTE: the previous version of this file re-implemented
 * `startResearchAction` / `getResearchStatusAction` / `getResearchResultAction`
 * inline against a hand-rolled `MockDB` / `MockPubSub`. That fiction mirrored
 * NONE of production: the real `startResearchAction`
 * (apps/web/lib/actions/research.ts) does credit consumption, symbol
 * validation and model resolution, and the status/result actions are thin
 * IDOR-scoped delegators to `@usemoney/services`.
 *
 * The deterministic, security-critical units those actions actually surface
 * live in `packages/services/src/research-logic.ts`:
 *   - clampProgress           progress → renderable [0,100] (NaN/∞-safe)
 *   - displayScore            quality/recommendation score (keeps 0, drops NaN/∞)
 *   - clampResearchPagination history page/pageSize → safe Prisma skip/take
 *                             (the 500-on-?page=-1 guard)
 *   - isOwnerScoped           IDOR gate — refuse an unscoped sessionId lookup
 *   - safeCreatedAt           Invalid-Date guard on the required createdAt
 * This file imports those REAL exports, plus the REAL demo fixtures the demo
 * branch serves. No inline re-implementation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  clampProgress,
  displayScore,
  clampResearchPagination,
  isOwnerScoped,
  safeCreatedAt,
  DEFAULT_RESEARCH_PAGE_SIZE,
  MAX_RESEARCH_PAGE_SIZE,
} from "../../../../packages/services/src/research-logic";
import {
  demoResearchHistory,
  demoResearchDetail,
  demoResearchDetail2,
} from "@/lib/demo/data";

describe("Research Server Actions (real source)", () => {
  // ── clampProgress: the renderable-progress guard ────────────────────

  describe("clampProgress", () => {
    it("passes a normal in-range integer through", () => {
      assert.strictEqual(clampProgress(65), 65);
    });

    it("keeps 0 and 100 at the bounds", () => {
      assert.strictEqual(clampProgress(0), 0);
      assert.strictEqual(clampProgress(100), 100);
    });

    it("truncates floats toward zero", () => {
      assert.strictEqual(clampProgress(42.9), 42);
    });

    it("clamps a negative to 0", () => {
      assert.strictEqual(clampProgress(-5), 0);
    });

    it("clamps over-100 to 100", () => {
      assert.strictEqual(clampProgress(150), 100);
    });

    it("maps NaN to 0 (no NaN% width)", () => {
      assert.strictEqual(clampProgress(NaN), 0);
    });

    it("maps +Infinity to 100 and -Infinity to 0", () => {
      assert.strictEqual(clampProgress(Infinity), 100);
      assert.strictEqual(clampProgress(-Infinity), 0);
    });

    it("maps a non-number to 0", () => {
      assert.strictEqual(clampProgress("80" as unknown), 0);
      assert.strictEqual(clampProgress(null), 0);
      assert.strictEqual(clampProgress(undefined), 0);
    });
  });

  // ── displayScore: keep a real 0, drop poison ────────────────────────

  describe("displayScore", () => {
    it("returns a real numeric score including 0", () => {
      assert.strictEqual(displayScore(0), 0);
      assert.strictEqual(displayScore(85), 85);
      assert.strictEqual(displayScore(9.2), 9.2);
    });

    it("returns undefined for null / undefined", () => {
      assert.strictEqual(displayScore(null), undefined);
      assert.strictEqual(displayScore(undefined), undefined);
    });

    it("returns undefined for NaN / ±Infinity (poison guard)", () => {
      assert.strictEqual(displayScore(NaN), undefined);
      assert.strictEqual(displayScore(Infinity), undefined);
      assert.strictEqual(displayScore(-Infinity), undefined);
    });
  });

  // ── clampResearchPagination: the history 500-guard ──────────────────

  describe("clampResearchPagination", () => {
    it("uses defaults when nothing is supplied", () => {
      const { skip, take } = clampResearchPagination();
      assert.strictEqual(skip, 0);
      assert.strictEqual(take, DEFAULT_RESEARCH_PAGE_SIZE);
    });

    it("computes skip = (page-1) * pageSize", () => {
      const { skip, take } = clampResearchPagination(3, 20);
      assert.strictEqual(skip, 40);
      assert.strictEqual(take, 20);
    });

    it("caps pageSize at MAX_RESEARCH_PAGE_SIZE", () => {
      const { take } = clampResearchPagination(1, 1e9);
      assert.strictEqual(take, MAX_RESEARCH_PAGE_SIZE);
    });

    it("floors page < 1 to 1 (skip never negative)", () => {
      const { skip } = clampResearchPagination(-1, 20);
      assert.strictEqual(skip, 0);
    });

    it("treats NaN page / pageSize as defaults (no 500 from ?page=abc)", () => {
      const { skip, take } = clampResearchPagination(NaN, NaN);
      assert.strictEqual(skip, 0);
      assert.strictEqual(take, DEFAULT_RESEARCH_PAGE_SIZE);
    });

    it("truncates float page/pageSize", () => {
      const { skip, take } = clampResearchPagination(2.9, 10.5);
      assert.strictEqual(take, 10);
      assert.strictEqual(skip, 10); // (2-1) * 10
    });
  });

  // ── isOwnerScoped: the IDOR gate ────────────────────────────────────

  describe("isOwnerScoped (IDOR gate)", () => {
    it("is true for a non-empty userId", () => {
      assert.strictEqual(isOwnerScoped("user-123"), true);
    });

    it("is false for empty / null / undefined (refuse unscoped lookup)", () => {
      assert.strictEqual(isOwnerScoped(""), false);
      assert.strictEqual(isOwnerScoped(null), false);
      assert.strictEqual(isOwnerScoped(undefined), false);
    });
  });

  // ── safeCreatedAt: the Invalid-Date guard ───────────────────────────

  describe("safeCreatedAt", () => {
    it("returns a valid Date unchanged", () => {
      const d = new Date("2026-05-29T10:00:00Z");
      assert.strictEqual(safeCreatedAt(d).getTime(), d.getTime());
    });

    it("falls back for an Invalid Date / null", () => {
      const fb = new Date("2026-01-01T00:00:00Z");
      assert.strictEqual(
        safeCreatedAt(new Date("garbage"), fb).getTime(),
        fb.getTime()
      );
      assert.strictEqual(safeCreatedAt(null, fb).getTime(), fb.getTime());
    });
  });

  // ── Demo fixtures: what the demo branch actually serves ─────────────

  describe("demoResearchHistory (getResearchHistoryAction demo)", () => {
    it("has the expected count and shape", () => {
      assert.strictEqual(demoResearchHistory.length, 2);
      for (const item of demoResearchHistory) {
        assert.ok(typeof item.sessionId === "string");
        assert.ok(typeof item.query === "string");
        assert.strictEqual(item.status, "COMPLETED");
        assert.ok(Array.isArray(item.symbols));
        assert.ok(typeof item.qualityScore === "number");
        assert.ok(typeof item.report.score === "number");
        assert.ok(typeof item.report.recommendation === "string");
      }
    });

    it("quality + report scores are renderable through displayScore", () => {
      for (const item of demoResearchHistory) {
        assert.strictEqual(displayScore(item.qualityScore), item.qualityScore);
        assert.ok(item.qualityScore >= 0 && item.qualityScore <= 100);
        assert.ok(item.report.score >= 0 && item.report.score <= 100);
      }
    });

    it("createdAt survives the safeCreatedAt guard", () => {
      for (const item of demoResearchHistory) {
        // Real fixture dates must already be valid.
        assert.strictEqual(
          safeCreatedAt(item.createdAt).getTime(),
          item.createdAt.getTime()
        );
      }
    });
  });

  describe("demoResearchDetail (getResearchResultAction demo)", () => {
    it("detail sessionId matches a history entry", () => {
      const ids = demoResearchHistory.map((i) => i.sessionId);
      assert.ok(ids.includes(demoResearchDetail.sessionId));
    });

    it("has a structured report object", () => {
      assert.ok(typeof demoResearchDetail.sessionId === "string");
      assert.ok(typeof demoResearchDetail.report === "object");
      assert.ok(typeof demoResearchDetail.report.score === "number");
      assert.ok(typeof demoResearchDetail.report.recommendation === "string");
    });

    it("second demo detail (demo-research-2) is independently shaped", () => {
      assert.ok(typeof demoResearchDetail2.sessionId === "string");
      assert.notStrictEqual(
        demoResearchDetail2.sessionId,
        demoResearchDetail.sessionId
      );
      assert.ok(typeof demoResearchDetail2.report === "object");
    });
  });
});
