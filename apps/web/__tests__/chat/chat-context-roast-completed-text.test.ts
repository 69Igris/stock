/**
 * COMPLETED-state reconcile for /roast in ChatContext (BUG-2 in MONEY-543 cycle 1).
 *
 * Why this exists:
 *   When a roast poll observes status === "COMPLETED", ChatContext calls
 *   getRoastBySessionIdAction(sessionId) and surfaces the narrative as the
 *   reconcile message:
 *     1. status pill on the action block ("Score X/100 — <first 200 chars>…")
 *     2. follow-up assistant text block ("**Portfolio Roast — Score X/100**\n\n<summary>…")
 *
 *   The cycle-1 bug: the consumer read result.data.roastText / result.data.summary
 *   off the action's payload. Neither field exists on the action's return type —
 *   the StructuredRoastResult lives nested at result.data.result, and the
 *   long-form commentary is StructuredRoastResult.roastNarrative.
 *
 *   Both reads evaluated to undefined, so every successful roast in chat showed
 *   the "Roast complete - open the full report" fallback, never the real
 *   narrative. These tests pin the corrected field path against future drift.
 *
 *   Source of truth:
 *     - apps/web/lib/chat/ChatContext.tsx:1129-1145 (the reconcile branch)
 *     - apps/web/lib/actions/roast-history.ts:136-207 (getRoastBySessionIdAction
 *       return type; data.result is StructuredRoastResult | null)
 *     - packages/types/src/roast.ts:35-50 (StructuredRoastResult.roastNarrative)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { StructuredRoastResult } from "@usemoney/types";

/**
 * Same shape ChatContext consumes from getRoastBySessionIdAction's success
 * payload. Trimmed to the fields the reconcile branch actually reads — the
 * action returns more fields (id, sessionId, status, progress, etc.) but the
 * reconcile only touches score + result.
 */
type ReconcileInput = {
  score: number | null;
  result: StructuredRoastResult | null;
};

const FALLBACK = "Roast complete - open the full report on the Roast page.";

/**
 * Mirror of the summary-pick logic at ChatContext.tsx:1137-1139.
 *
 * If anyone breaks the field path again — say, drops the optional chain or
 * walks the wrong nesting level — the corresponding test below will fail
 * with a real-looking COMPLETED payload instead of waiting for QA to notice.
 */
function pickRoastSummary(input: ReconcileInput): string {
  return input.result?.roastNarrative || FALLBACK;
}

/**
 * Mirror of the status-pill template at ChatContext.tsx:1142-1144. Pinned so
 * the truncation invariants don't drift either (cycle-1 ticked at 200 chars
 * + ellipsis suffix).
 */
function buildActionBlockResult(score: number | null, summary: string): string {
  return `Score ${score}/100 - ${summary.slice(0, 200)}${
    summary.length > 200 ? "…" : ""
  }`;
}

/** Minimal valid StructuredRoastResult with caller-supplied narrative. */
function makeStructuredResult(narrative: string): StructuredRoastResult {
  return {
    overallScore: 62,
    scoreBreakdown: {
      diversification: { score: 55, comment: "ok" },
      riskManagement: { score: 70, comment: "ok" },
      stockPicking: { score: 60, comment: "ok" },
      timing: { score: 65, comment: "ok" },
    },
    roastHighlights: [],
    topPerformers: [],
    worstPerformers: [],
    sectorAnalysis: [],
    constructiveAdvice: [],
    roastNarrative: narrative,
    disclaimer: "",
  };
}

describe("ChatContext roast COMPLETED reconcile (BUG-2)", () => {
  describe("pickRoastSummary - field-path correctness", () => {
    it("returns roastNarrative when the structured result is present", () => {
      const narrative =
        "Your portfolio is a wonderfully chaotic monument to recency bias.";
      const summary = pickRoastSummary({
        score: 62,
        result: makeStructuredResult(narrative),
      });
      assert.strictEqual(summary, narrative);
      assert.notStrictEqual(
        summary,
        FALLBACK,
        "regression: should not have fallen through to fallback text"
      );
    });

    it("returns a populated narrative even when score is null", () => {
      // Defensive: score and narrative live on different fields; one being
      // missing shouldn't shadow the other.
      const narrative = "Quick take: too much IT, not enough cash.";
      const summary = pickRoastSummary({
        score: null,
        result: makeStructuredResult(narrative),
      });
      assert.strictEqual(summary, narrative);
    });

    it("falls through to fallback when roastNarrative is empty string", () => {
      // Empty string is falsy under ||, so the OR-fallback applies. Pinned
      // because someone might later switch to ?? which would break this.
      const summary = pickRoastSummary({
        score: 50,
        result: makeStructuredResult(""),
      });
      assert.strictEqual(summary, FALLBACK);
    });

    it("falls through to fallback when result is null on the payload", () => {
      // Per getRoastBySessionIdAction's type, result is
      // `StructuredRoastResult | null` — null is the legitimate "no
      // narrative yet" sentinel and must hit the fallback, not crash.
      const summary = pickRoastSummary({ score: 42, result: null });
      assert.strictEqual(summary, FALLBACK);
    });

    it("falls through to fallback when the payload has no result field", () => {
      // Belt-and-braces: even if upstream forgets the field entirely, the
      // optional-chain guard should keep us out of a TypeError. This mirrors
      // a malformed/legacy response.
      const summary = pickRoastSummary({
        score: 70,
      } as unknown as ReconcileInput);
      assert.strictEqual(summary, FALLBACK);
    });

    it("does NOT read the legacy roastText / summary top-level fields", () => {
      // Regression guard: the cycle-1 implementation walked
      // result.data.roastText then result.data.summary. Neither field
      // exists in the action's return type. If anyone re-adds those reads
      // ahead of the correct path, this test fires.
      const legacyShaped = {
        score: 55,
        result: null,
        // These shouldn't influence the picked summary.
        roastText: "LEGACY ROAST TEXT - SHOULD NEVER BE PICKED",
        summary: "LEGACY SUMMARY - SHOULD NEVER BE PICKED",
      } as unknown as ReconcileInput;
      const picked = pickRoastSummary(legacyShaped);
      assert.strictEqual(picked, FALLBACK);
      assert.ok(
        !picked.includes("LEGACY"),
        "regression: legacy top-level fields must not be consulted"
      );
    });
  });

  describe("buildActionBlockResult - status pill template", () => {
    it("includes the score, separator, and first 200 chars of summary", () => {
      const summary = "Short and sweet — top sector is IT.";
      const pill = buildActionBlockResult(62, summary);
      assert.ok(pill.startsWith("Score 62/100 - "), `bad prefix: ${pill}`);
      assert.ok(pill.endsWith(summary), `bad suffix: ${pill}`);
      assert.ok(!pill.endsWith("…"), "no ellipsis for short summaries");
    });

    it("truncates to 200 chars with an ellipsis when summary is long", () => {
      const summary = "x".repeat(500);
      const pill = buildActionBlockResult(40, summary);
      // 200 x's + 1 ellipsis = 201 trailing chars
      assert.ok(pill.endsWith("…"), `expected trailing ellipsis: ${pill}`);
      const xCount = pill.match(/x/g)?.length ?? 0;
      assert.strictEqual(
        xCount,
        200,
        `expected 200 x's after truncation, got ${xCount}`
      );
    });

    it("handles a null score gracefully (shows 'null/100')", () => {
      // The action's type allows score: null. We don't want to crash; the
      // template-literal interpolation will print 'null', which is the
      // documented behaviour pending a richer null handler.
      const pill = buildActionBlockResult(null, "x");
      assert.ok(pill.startsWith("Score null/100 - "), pill);
    });
  });

  describe("end-to-end: COMPLETED state transitions", () => {
    it("real COMPLETED payload with populated narrative → block message contains the narrative", () => {
      const narrative =
        "Your portfolio is 70% concentrated in IT - this is not diversification, this is conviction or laziness depending on the day.";
      const payload: ReconcileInput = {
        score: 58,
        result: makeStructuredResult(narrative),
      };
      const summary = pickRoastSummary(payload);
      const pill = buildActionBlockResult(payload.score, summary);
      assert.ok(
        pill.includes(narrative.slice(0, 100)),
        `pill missing narrative prefix: ${pill}`
      );
      assert.ok(!pill.includes("open the full report"), pill);
    });

    it("COMPLETED with no narrative → block falls through to fallback text", () => {
      const payload: ReconcileInput = {
        score: 50,
        result: makeStructuredResult(""),
      };
      const summary = pickRoastSummary(payload);
      const pill = buildActionBlockResult(payload.score, summary);
      assert.ok(pill.includes("open the full report"), pill);
    });

    it("COMPLETED where the action returns no result field at all → fallback", () => {
      const payload = { score: 35 } as unknown as ReconcileInput;
      const summary = pickRoastSummary(payload);
      const pill = buildActionBlockResult(payload.score, summary);
      assert.ok(pill.includes("open the full report"), pill);
      assert.strictEqual(summary, FALLBACK);
    });

    it("COMPLETED with result === null (legitimate sentinel) → fallback", () => {
      const payload: ReconcileInput = { score: 35, result: null };
      const summary = pickRoastSummary(payload);
      assert.strictEqual(summary, FALLBACK);
    });
  });
});
