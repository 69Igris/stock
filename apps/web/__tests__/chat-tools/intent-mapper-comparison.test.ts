/**
 * Intent Mapper - Comparison / Mention Detection (REAL-CONTRACT tests)
 * (lib/chat-tools/intent-mapper.ts)
 *
 * De-shadowed (MONEY-620). This file previously inlined a large, stale copy of
 * INTENT_PATTERNS that fast-pathed "SYMBOL vs SYMBOL", "compare X and Y",
 * DCF, screener, risk and tax queries to run_research. The production fast-path
 * has since REMOVED all of those: comparison / valuation / risk / tax are now
 * understood by the Flash classifier (classifyIntentWithFlash), NOT by regex.
 * The shadow kept asserting the removed contract and stayed green — exactly the
 * failure mode the no-shadow policy exists to prevent.
 *
 * The ONLY comparison-related path that still lives in the deterministic
 * fast-path is the `[Mentioned: @SYM]` prefix the chat UI injects when the user
 * @-mentions instruments. These tests import & assert the REAL classifyIntentFast
 * for that surviving guard, and pin the deferral contract (plain "X vs Y" text
 * now returns null → handled by Flash) so a regression that re-introduces a
 * half-baked regex comparison fast-path fails here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyIntentFast,
  type IntentMatch,
} from "@/lib/chat-tools/intent-mapper";

// -- Helper ------------------------------------------------------------------

/** Assert a result is a run_research multi-symbol comparison intent. */
function assertComparison(
  result: IntentMatch | null,
  msg = ""
): asserts result is IntentMatch {
  const label = msg ? ` (${msg})` : "";
  assert.ok(result, `Expected non-null IntentMatch${label}`);
  assert.strictEqual(result.tool, "run_research", `tool${label}`);
  assert.strictEqual(
    result.params.skill,
    "peer-comparison",
    `skill should be peer-comparison${label}`
  );
  assert.strictEqual(
    result.params.mode,
    "advanced",
    `mode should be advanced${label}`
  );
}

// -- Tests -------------------------------------------------------------------

describe("Intent Mapper - [Mentioned:] comparison fast-path (real)", () => {
  // =========================================================================
  // Surviving guard: [Mentioned: @SYM ...] prefix
  // =========================================================================

  describe("multi-symbol @mention prefix → peer-comparison", () => {
    it("routes two mentions to run_research + peer-comparison + advanced", () => {
      const result = classifyIntentFast(
        "[Mentioned: @RELIANCE] [Mentioned: @IOC] compare these"
      );
      assertComparison(result, "two @mentions");
      assert.deepStrictEqual(result.params.symbols, ["RELIANCE", "IOC"]);
    });

    it("extracts all distinct symbols and dedupes repeats", () => {
      const result = classifyIntentFast(
        "[Mentioned: @TCS] [Mentioned: @INFY] [Mentioned: @TCS] which is better"
      );
      assertComparison(result, "deduped @mentions");
      assert.deepStrictEqual(result.params.symbols, ["TCS", "INFY"]);
    });

    it("uppercases symbols from lowercase mentions", () => {
      const result = classifyIntentFast(
        "[Mentioned: @reliance] [Mentioned: @ioc]"
      );
      assertComparison(result, "lowercase @mentions");
      const syms = result.params.symbols as string[];
      assert.ok(
        syms.every((s) => s === s.toUpperCase()),
        `symbols should be UPPERCASE, got ${JSON.stringify(syms)}`
      );
    });

    it("forwards the original message as the query param", () => {
      const msg = "[Mentioned: @TCS] [Mentioned: @INFY] head to head";
      const result = classifyIntentFast(msg);
      assert.ok(result);
      assert.strictEqual(result.params.query, msg);
    });

    it("always reports 0.8 confidence for fast-path matches", () => {
      const result = classifyIntentFast("[Mentioned: @TCS] [Mentioned: @INFY]");
      assert.ok(result);
      assert.strictEqual(result.confidence, 0.8);
    });
  });

  describe("single @mention → research without forced comparison", () => {
    it("routes a single mention to run_research with one symbol", () => {
      const result = classifyIntentFast("[Mentioned: @TCS] analyze this");
      assert.ok(result);
      assert.strictEqual(result.tool, "run_research");
      assert.deepStrictEqual(result.params.symbols, ["TCS"]);
    });

    it("does NOT force peer-comparison/advanced for a single symbol", () => {
      const result = classifyIntentFast("[Mentioned: @TCS] tell me more");
      assert.ok(result);
      // single symbol → no comparison skill, no forced advanced mode
      assert.strictEqual(result.params.skill, undefined);
      assert.strictEqual(result.params.mode, undefined);
    });
  });

  // =========================================================================
  // Deferral contract: plain-text comparisons are no longer fast-pathed.
  // They are routed to the Flash classifier (classifyIntentWithFlash), so the
  // fast-path MUST return null for them. Pinning this prevents a regression
  // that re-adds a brittle regex comparison fast-path (the original shadow's
  // behavior).
  // =========================================================================

  describe("plain-text comparison defers to Flash (null)", () => {
    const deferred = [
      "RELIANCE vs IOC",
      "TCS versus INFY",
      "RELIANCE vs. IOC",
      "reliance vs ioc",
      "RELIANCE compared to IOC",
      "RELIANCE compared with IOC",
      "Which is better: HDFC vs ICICI?",
      "compare TCS and INFY",
      "compare RELIANCE and IOC stocks",
      "comparison of TCS and INFY stock",
      "compare TCS with INFY",
      "compare TCS to INFY",
    ];
    for (const msg of deferred) {
      it(`returns null for ${JSON.stringify(msg)}`, () => {
        assert.strictEqual(
          classifyIntentFast(msg),
          null,
          `"${msg}" must defer to Flash (fast-path returns null)`
        );
      });
    }
  });

  describe("non-comparison research also defers to Flash (null)", () => {
    const deferred = [
      "Run a DCF on RELIANCE",
      "What is the intrinsic value of TCS?",
      "Filter companies with high ROE", // generic filter phrasing → Flash
      "Should I buy RELIANCE?",
      "deep dive into TCS",
      "Is RELIANCE a good stock?",
    ];
    for (const msg of deferred) {
      it(`returns null for ${JSON.stringify(msg)}`, () => {
        assert.strictEqual(classifyIntentFast(msg), null);
      });
    }
  });
});
