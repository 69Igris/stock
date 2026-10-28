/**
 * Flash-First Routing (REAL-CONTRACT tests)
 *
 * De-shadowed (MONEY-620). This file previously reimplemented the ENTIRE chat
 * route pipeline inline — `matchDataFetch`, a fabricated `simulateFlash` LLM
 * mock, `classifyTierRegex`, `screenerSafetyNet`, and a `routeQuery` orchestrator
 * — and asserted that fiction against itself. None of those were real source
 * exports; `simulateFlash` in particular invented an LLM that no production code
 * runs, so the suite was green while exercising zero real logic.
 *
 * The two pieces that DO correspond to real, importable source are:
 *   1. the deterministic data-fetch fast-path  → `classifyIntentFast`
 *   2. the regex tier fallback                 → `classifyTier`
 *
 * The "Flash" step itself is `classifyIntentWithFlash`, which calls Gemini and
 * cannot be unit-tested without mocking the LLM — so this file pins the routing
 * DECISION the fast-path makes (data-fetch now vs defer-to-Flash) and the tier
 * the fallback assigns, using the real exports.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyIntentFast } from "@/lib/chat-tools/intent-mapper";
import { classifyTier } from "@/lib/chat-tools/tier-classifier";

/** Real fast-path tool decision (null = no fast-path → goes to Flash). */
function fastPathTool(message: string): string | null {
  return classifyIntentFast(message)?.tool ?? null;
}

describe("Flash-First Routing (real fast-path + tier)", () => {
  // ── 1. Data-fetch queries resolve instantly via the fast-path ──────────

  describe("data-fetch resolves on the fast-path (no Flash)", () => {
    const cases: Array<[string, string]> = [
      ["show my holdings", "get_holdings"],
      ["show my positions", "get_positions"],
      ["my recent trades", "get_trades"],
      ["show my mutual funds", "get_mutual_funds"],
      ["show my fire scenarios", "get_fire_scenarios"],
      ["what is my fire number", "get_fire_scenarios"],
      ["show my portfolio", "get_portfolio_summary"],
    ];
    for (const [msg, tool] of cases) {
      it(`${JSON.stringify(msg)} → ${tool}`, () => {
        assert.strictEqual(fastPathTool(msg), tool);
      });
    }
  });

  // ── 2. Deterministic guards win over the broad data-fetch patterns ─────

  describe("higher-priority guards intercept before data-fetch", () => {
    it("'roast my portfolio' → start_roast (not get_portfolio_summary)", () => {
      assert.strictEqual(fastPathTool("roast my portfolio"), "start_roast");
    });

    it("'screen for stocks under 20 pe' → run_screener", () => {
      assert.strictEqual(
        fastPathTool("screen for stocks under 20 pe"),
        "run_screener"
      );
    });

    it("'[Mentioned: @TCS] analyze' → run_research", () => {
      assert.strictEqual(
        fastPathTool("[Mentioned: @TCS] analyze this"),
        "run_research"
      );
    });
  });

  // ── 3. Analytical queries are NOT fast-pathed (defer to Flash) ─────────

  describe("analytical queries defer to Flash (fast-path null)", () => {
    const deferred = [
      "analyze TCS",
      "should I buy RELIANCE?",
      "TCS vs INFY",
      "what is the dcf of HDFC",
      "is RELIANCE undervalued?",
      "comprehensive analysis of INFY",
      "what is the PE ratio of TCS?",
    ];
    for (const msg of deferred) {
      it(`returns null for ${JSON.stringify(msg)}`, () => {
        assert.strictEqual(fastPathTool(msg), null);
      });
    }
  });

  // ── 4. Tier fallback (regex) for queries that reach it ─────────────────

  describe("regex tier fallback classifies analytical depth", () => {
    it("plain data lookup / greeting → L1", () => {
      assert.strictEqual(classifyTier("show my holdings", "/dashboard"), "L1");
      assert.strictEqual(classifyTier("hello", "/dashboard"), "L1");
    });

    it("research / should-I-buy / screener → L2", () => {
      assert.strictEqual(classifyTier("analyze TCS", "/dashboard"), "L2");
      assert.strictEqual(
        classifyTier("should I buy RELIANCE?", "/dashboard"),
        "L2"
      );
      assert.strictEqual(
        classifyTier("stocks with RSI below 30", "/dashboard"),
        "L2"
      );
    });

    it("comprehensive / 3-way compare → L3", () => {
      assert.strictEqual(
        classifyTier("comprehensive analysis of INFY", "/dashboard"),
        "L3"
      );
      assert.strictEqual(
        classifyTier("TCS vs INFY vs WIPRO", "/dashboard"),
        "L3"
      );
    });

    it("does not throw on empty/whitespace input (defaults L1)", () => {
      assert.strictEqual(classifyTier("", "/dashboard"), "L1");
      assert.strictEqual(classifyTier("   ", "/dashboard"), "L1");
    });
  });
});
