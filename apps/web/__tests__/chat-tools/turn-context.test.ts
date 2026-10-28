/**
 * Turn Context Tests (lib/chat-tools/turn-context.ts)
 *
 * Tests for the Conversation Memory Layer:
 *   - getConvStateKey: Redis key generation (chatId vs userId:pagePath)
 *   - detectFollowUpFast: regex follow-up resolution ("yes", "tell me more", "no")
 *   - mergeScreenerParams: filter merge, carry-forward index/strategy
 *   - formatStateForPrompt: prompt text formatting for Flash/Gemini
 *   - buildFollowUpRules: static follow-up rules string
 *   - loadPriorTurnContext fallback: conversationHistory extraction when Redis is unavailable
 *
 * Pure functions reimplemented inline because the source module has
 * side-effecting imports (Redis client, logger) that aren't available
 * in the unit test environment.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed (MONEY-620): import & assert the REAL exports from the source
// module. `getConvStateKey` and `extractStateFromHistory` were promoted to
// exports (and are called by loadPriorTurnContext / saveTurnContext, so they
// are not dead). `extractStateFromHistory` is the real fallback path
// loadPriorTurnContext runs when Redis is unavailable.
import {
  getConvStateKey,
  detectFollowUpFast,
  mergeScreenerParams,
  formatStateForPrompt,
  buildFollowUpRules,
  extractStateFromHistory,
  type ConversationState,
} from "@/lib/chat-tools/turn-context";
import type { TurnMeta } from "@usemoney/types";

// `extractStateFromHistory` is the de-shadowed replacement for the old inline
// `extractFromHistory` copy.
const extractFromHistory = extractStateFromHistory;

// ─────────────────────────────────────────────────────────────────────────────
// Factory helpers
// ─────────────────────────────────────────────────────────────────────────────

function createState(
  overrides: Partial<ConversationState> & { lastTurnMeta: TurnMeta }
): ConversationState {
  return {
    activeSymbols: [],
    turnCount: 1,
    lastUpdated: Date.now(),
    ...overrides,
  };
}

function createScreenerState(
  overrides: Partial<ConversationState> = {}
): ConversationState {
  return createState({
    lastTurnMeta: {
      intent: "screener",
      tier: "L2",
      tool: "run_screener",
      persona: "quant_analyst",
      toolParams: { query: "RSI < 30 in Nifty 50" },
      screenerState: {
        query: "RSI < 30 in Nifty 50",
        filters: [{ field: "rsi_14", operator: "lt", value: 30 }],
        indexFilter: "nifty_50",
        resultCount: 12,
      },
    },
    activePersona: "quant_analyst",
    activeSymbols: ["TCS", "INFY", "RELIANCE"],
    activeScreenerState: {
      query: "RSI < 30 in Nifty 50",
      filters: [{ field: "rsi_14", operator: "lt", value: 30 }],
      indexFilter: "nifty_50",
      resultCount: 12,
    },
    ...overrides,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("Turn Context - Conversation Memory Layer", () => {
  // ── getConvStateKey ─────────────────────────────────────────────────────

  describe("getConvStateKey", () => {
    it("should use chatId when provided", () => {
      const key = getConvStateKey("user123", "chat456", "/dashboard");
      assert.strictEqual(key, "conv-state:chat456");
    });

    it("should use userId:pagePath when no chatId", () => {
      const key = getConvStateKey("user123", undefined, "/dashboard");
      assert.strictEqual(key, "conv-state:user123:/dashboard");
    });

    it("should use 'default' when no chatId and no pagePath", () => {
      const key = getConvStateKey("user123", undefined, undefined);
      assert.strictEqual(key, "conv-state:user123:default");
    });

    it("should prefer chatId over pagePath", () => {
      const key = getConvStateKey("user123", "chat789", "/holdings");
      assert.strictEqual(key, "conv-state:chat789");
    });

    it("should handle empty chatId as falsy (fall through to userId)", () => {
      const key = getConvStateKey("user123", "", "/dashboard");
      assert.strictEqual(key, "conv-state:user123:/dashboard");
    });
  });

  // ── detectFollowUpFast ──────────────────────────────────────────────────

  describe("detectFollowUpFast", () => {
    describe("returns null when no prior state", () => {
      it("should return null for null priorState", () => {
        assert.strictEqual(detectFollowUpFast("yes", null), null);
      });

      it("should return null when lastTurnMeta has no tool", () => {
        const state = createState({
          lastTurnMeta: { intent: "general_chat" },
        });
        assert.strictEqual(detectFollowUpFast("yes", state), null);
      });

      it("should return null when lastTurnMeta.tool is undefined", () => {
        const state = createState({
          lastTurnMeta: { intent: "screener", tool: undefined },
        });
        assert.strictEqual(detectFollowUpFast("yes", state), null);
      });
    });

    describe("affirmative patterns (re-trigger last tool)", () => {
      const screenerState = createScreenerState();

      const affirmatives = [
        "yes",
        "ok",
        "okay",
        "sure",
        "go ahead",
        "do it",
        "proceed",
        "yep",
        "yeah",
        "Yes!",
        "OK.",
        "  yes  ",
        "YEAH",
      ];

      affirmatives.forEach((msg) => {
        it(`should match "${msg}" as affirmative`, () => {
          const result = detectFollowUpFast(msg, screenerState);
          assert.ok(result, `Expected match for "${msg}"`);
          assert.strictEqual(result.tool, "run_screener");
          assert.strictEqual(result.intent, "screener");
          assert.strictEqual(result.tier, "L2");
          assert.strictEqual(result.persona, "quant_analyst");
          assert.strictEqual(result.escalateTier, undefined);
        });
      });

      it("should carry forward toolParams from prior state", () => {
        const result = detectFollowUpFast("yes", screenerState);
        assert.ok(result);
        assert.deepStrictEqual(result.params, {
          query: "RSI < 30 in Nifty 50",
        });
      });

      it("should use 'follow_up' intent when lastMeta.intent is undefined", () => {
        const state = createState({
          lastTurnMeta: { tool: "get_holdings", toolParams: {} },
        });
        const result = detectFollowUpFast("yes", state);
        assert.ok(result);
        assert.strictEqual(result.intent, "follow_up");
      });

      it("should fall back to activePersona when lastMeta.persona is undefined", () => {
        const state = createState({
          lastTurnMeta: { tool: "run_screener", toolParams: {} },
          activePersona: "quant_analyst",
        });
        const result = detectFollowUpFast("ok", state);
        assert.ok(result);
        assert.strictEqual(result.persona, "quant_analyst");
      });

      it("should NOT match multi-word sentences containing 'yes'", () => {
        const result = detectFollowUpFast(
          "yes I want to see more stocks",
          screenerState
        );
        assert.strictEqual(result, null);
      });
    });

    describe("deepen patterns (escalate tier)", () => {
      const researchState = createState({
        lastTurnMeta: {
          intent: "quick_research",
          tier: "L2",
          tool: "run_research",
          persona: "equity_research",
          toolParams: { symbols: ["TCS"], mode: "fast" },
        },
      });

      const deepenPhrases = [
        "tell me more",
        "expand",
        "elaborate",
        "more details",
        "more detail",
        "explain further",
        "go deeper",
        "deep dive",
        "dig deeper",
        "Tell me more!",
        "EXPAND.",
        "  elaborate  ",
      ];

      deepenPhrases.forEach((msg) => {
        it(`should match "${msg}" as deepen with escalateTier`, () => {
          const result = detectFollowUpFast(msg, researchState);
          assert.ok(result, `Expected match for "${msg}"`);
          assert.strictEqual(result.tool, "run_research");
          assert.strictEqual(result.escalateTier, true);
          assert.strictEqual(result.tier, "L2");
        });
      });

      it("should carry forward params on deepen", () => {
        const result = detectFollowUpFast("tell me more", researchState);
        assert.ok(result);
        assert.deepStrictEqual(result.params, {
          symbols: ["TCS"],
          mode: "fast",
        });
      });
    });

    describe("rejection patterns (returns null)", () => {
      const state = createScreenerState();

      const rejections = [
        "no",
        "nope",
        "different",
        "something else",
        "never mind",
        "No.",
        "NOPE!",
      ];

      rejections.forEach((msg) => {
        it(`should return null for rejection "${msg}"`, () => {
          assert.strictEqual(detectFollowUpFast(msg, state), null);
        });
      });
    });

    describe("non-matching patterns (returns null)", () => {
      const state = createScreenerState();

      const nonMatches = [
        "analyse TCS",
        "show me stocks with ROE > 20%",
        "what is PE ratio?",
        "compare TCS vs INFY",
        "yes I want to see more stocks",
        "please tell me more about the market",
        "",
      ];

      nonMatches.forEach((msg) => {
        it(`should return null for "${msg || "(empty)"}"`, () => {
          assert.strictEqual(detectFollowUpFast(msg, state), null);
        });
      });
    });
  });

  // ── mergeScreenerParams ─────────────────────────────────────────────────

  describe("mergeScreenerParams", () => {
    const priorScreener: NonNullable<TurnMeta["screenerState"]> = {
      query: "RSI < 30 in Nifty 50",
      strategy: "value_investing",
      filters: [
        { field: "rsi_14", operator: "lt", value: 30 },
        { field: "pe_ratio", operator: "lt", value: 20 },
      ],
      indexFilter: "nifty_50",
      resultCount: 12,
    };

    it("should carry forward indexFilter when not specified in new params", () => {
      const result = mergeScreenerParams(priorScreener, {
        query: "add ROE > 20",
      });
      assert.strictEqual(result.indexFilter, "nifty_50");
    });

    it("should NOT carry forward indexFilter when new params specify it", () => {
      const result = mergeScreenerParams(priorScreener, {
        query: "ROE > 20 in Nifty 100",
        indexFilter: "nifty_100",
      });
      assert.strictEqual(result.indexFilter, "nifty_100");
    });

    it("should carry forward strategy when not specified in new params", () => {
      const result = mergeScreenerParams(priorScreener, { query: "tighten" });
      assert.strictEqual(result.strategy, "value_investing");
    });

    it("should NOT carry forward strategy when new params specify it", () => {
      const result = mergeScreenerParams(priorScreener, {
        strategy: "momentum",
      });
      assert.strictEqual(result.strategy, "momentum");
    });

    it("should merge filters - new overrides same field, prior fills gaps", () => {
      const result = mergeScreenerParams(priorScreener, {
        query: "tighten RSI and add ROE",
        filters: [
          { field: "rsi_14", operator: "lt", value: 25 }, // overrides prior rsi_14
          { field: "roe", operator: "gt", value: 20 }, // new filter
        ],
      });
      const filters = result.filters as Array<{
        field: string;
        operator: string;
        value: unknown;
      }>;
      assert.strictEqual(filters.length, 3); // rsi(new) + roe(new) + pe(carried)
      assert.strictEqual(filters[0]!.field, "rsi_14");
      assert.strictEqual(filters[0]!.value, 25); // overridden
      assert.strictEqual(filters[1]!.field, "roe");
      assert.strictEqual(filters[2]!.field, "pe_ratio"); // carried from prior
    });

    it("should carry ALL prior filters when no new filters", () => {
      const result = mergeScreenerParams(priorScreener, { query: "same" });
      const filters = result.filters as Array<{
        field: string;
        operator: string;
        value: unknown;
      }>;
      assert.strictEqual(filters.length, 2); // both carried
      assert.strictEqual(filters[0]!.field, "rsi_14");
      assert.strictEqual(filters[1]!.field, "pe_ratio");
    });

    it("should handle prior state with no filters", () => {
      const emptyPrior: NonNullable<TurnMeta["screenerState"]> = {
        query: "some query",
      };
      const result = mergeScreenerParams(emptyPrior, {
        filters: [{ field: "roe", operator: "gt", value: 15 }],
      });
      const filters = result.filters as Array<{
        field: string;
        operator: string;
        value: unknown;
      }>;
      assert.strictEqual(filters.length, 1);
      assert.strictEqual(filters[0]!.field, "roe");
    });

    it("should not mutate the input newParams object", () => {
      const newParams = { query: "test" };
      const frozen = { ...newParams };
      mergeScreenerParams(priorScreener, newParams);
      assert.deepStrictEqual(newParams, frozen);
    });
  });

  // ── formatStateForPrompt ────────────────────────────────────────────────

  describe("formatStateForPrompt", () => {
    it("should include tool, intent, persona, symbols", () => {
      const state = createScreenerState();
      const output = formatStateForPrompt(state);
      assert.ok(output.includes("- Last tool: run_screener"));
      assert.ok(output.includes("- Last intent: screener"));
      assert.ok(output.includes("- Active persona: quant_analyst"));
      assert.ok(output.includes("- Stocks discussed: TCS, INFY, RELIANCE"));
    });

    it("should include screener state with result count", () => {
      const state = createScreenerState();
      const output = formatStateForPrompt(state);
      assert.ok(
        output.includes(
          '- Active screener: "RSI < 30 in Nifty 50" (12 results)'
        )
      );
    });

    it("should include filters JSON", () => {
      const state = createScreenerState();
      const output = formatStateForPrompt(state);
      assert.ok(output.includes("- Filters:"));
      assert.ok(output.includes('"rsi_14"'));
    });

    it("should include index filter", () => {
      const state = createScreenerState();
      const output = formatStateForPrompt(state);
      assert.ok(output.includes("- Index filter: nifty_50"));
    });

    it("should handle minimal state (only tool)", () => {
      const state = createState({
        lastTurnMeta: { tool: "get_holdings" },
      });
      const output = formatStateForPrompt(state);
      assert.strictEqual(output, "- Last tool: get_holdings");
    });

    it("should return empty string when no fields are set", () => {
      const state = createState({
        lastTurnMeta: {},
      });
      const output = formatStateForPrompt(state);
      assert.strictEqual(output, "");
    });

    it("should omit result count when undefined", () => {
      const state = createState({
        lastTurnMeta: { tool: "run_screener" },
        activeScreenerState: {
          query: "oversold stocks",
        },
      });
      const output = formatStateForPrompt(state);
      assert.ok(output.includes('- Active screener: "oversold stocks"'));
      assert.ok(!output.includes("results)"));
    });

    it("should omit filters line when no filters", () => {
      const state = createState({
        lastTurnMeta: { tool: "run_screener" },
        activeScreenerState: {
          query: "oversold stocks",
          filters: [],
        },
      });
      const output = formatStateForPrompt(state);
      assert.ok(!output.includes("- Filters:"));
    });
  });

  // ── buildFollowUpRules ──────────────────────────────────────────────────

  describe("buildFollowUpRules", () => {
    it("should return a non-empty string", () => {
      const rules = buildFollowUpRules();
      assert.ok(rules.length > 0);
    });

    it("should contain key patterns", () => {
      const rules = buildFollowUpRules();
      assert.ok(rules.includes('"yes"'));
      assert.ok(rules.includes('"tell me more"'));
      assert.ok(rules.includes('"no"'));
      assert.ok(rules.includes("activeSymbols"));
      assert.ok(rules.includes("L1→L2→L3"));
    });

    it("should start with FOLLOW-UP RULES header", () => {
      const rules = buildFollowUpRules();
      assert.ok(rules.startsWith("FOLLOW-UP RULES"));
    });
  });

  // ── extractFromHistory (loadPriorTurnContext fallback) ──────────────────

  describe("extractFromHistory (loadPriorTurnContext fallback logic)", () => {
    it("should extract turnMeta from last assistant message", () => {
      const history = [
        { role: "user", content: "RSI < 30 in Nifty 50" },
        {
          role: "assistant",
          content: "Here are 12 stocks...",
          turnMeta: {
            intent: "screener",
            tier: "L2" as const,
            tool: "run_screener",
            persona: "quant_analyst",
            symbols: ["TCS", "INFY"],
          },
        },
        { role: "user", content: "yes" },
      ];
      const state = extractFromHistory(history);
      assert.ok(state);
      assert.strictEqual(state.lastTurnMeta.tool, "run_screener");
      assert.strictEqual(state.activePersona, "quant_analyst");
      assert.deepStrictEqual(state.activeSymbols, ["TCS", "INFY"]);
      assert.strictEqual(state.turnCount, 2); // 2 user messages
    });

    it("should prefer the LAST assistant message with turnMeta", () => {
      const history = [
        {
          role: "assistant",
          content: "Old response",
          turnMeta: { tool: "get_holdings", intent: "portfolio" },
        },
        { role: "user", content: "now screen stocks" },
        {
          role: "assistant",
          content: "New response",
          turnMeta: { tool: "run_screener", intent: "screener" },
        },
      ];
      const state = extractFromHistory(history);
      assert.ok(state);
      assert.strictEqual(state.lastTurnMeta.tool, "run_screener");
    });

    it("should return null when no messages", () => {
      assert.strictEqual(extractFromHistory([]), null);
    });

    it("should return null when no assistant messages have turnMeta", () => {
      const history = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ];
      assert.strictEqual(extractFromHistory(history), null);
    });

    it("should skip user messages even if they have turnMeta", () => {
      const history = [
        {
          role: "user",
          content: "hello",
          turnMeta: { tool: "get_holdings" },
        },
        { role: "assistant", content: "hi" },
      ];
      assert.strictEqual(extractFromHistory(history), null);
    });

    it("should handle empty symbols in turnMeta", () => {
      const history = [
        {
          role: "assistant",
          content: "result",
          turnMeta: { tool: "get_portfolio_summary", intent: "portfolio" },
        },
      ];
      const state = extractFromHistory(history);
      assert.ok(state);
      assert.deepStrictEqual(state.activeSymbols, []);
    });

    it("should propagate screenerState from turnMeta", () => {
      const screenerMeta: TurnMeta = {
        tool: "run_screener",
        screenerState: {
          query: "high ROE stocks",
          filters: [{ field: "roe", operator: "gt", value: 25 }],
          resultCount: 8,
        },
      };
      const history = [
        { role: "assistant", content: "results", turnMeta: screenerMeta },
      ];
      const state = extractFromHistory(history);
      assert.ok(state);
      assert.ok(state.activeScreenerState);
      assert.strictEqual(state.activeScreenerState.resultCount, 8);
      assert.strictEqual(state.activeScreenerState.filters!.length, 1);
    });
  });

  // ── Tier escalation integration ─────────────────────────────────────────

  describe("tier escalation (detectFollowUpFast + caller logic)", () => {
    it("should escalate L1 → L2 when deepen matched", () => {
      const state = createState({
        lastTurnMeta: { tool: "get_financial_data", tier: "L1" },
      });
      const result = detectFollowUpFast("tell me more", state);
      assert.ok(result);
      assert.strictEqual(result.escalateTier, true);
      assert.strictEqual(result.tier, "L1"); // raw tier - caller escalates

      // Simulate caller escalation logic (from route.ts)
      let resolvedTier: "L1" | "L2" | "L3" | undefined = result.tier;
      if (result.escalateTier && resolvedTier) {
        if (resolvedTier === "L1") resolvedTier = "L2";
        else if (resolvedTier === "L2") resolvedTier = "L3";
      }
      assert.strictEqual(resolvedTier, "L2");
    });

    it("should escalate L2 → L3 when deepen matched", () => {
      const state = createState({
        lastTurnMeta: { tool: "run_research", tier: "L2" },
      });
      const result = detectFollowUpFast("go deeper", state);
      assert.ok(result);
      let resolvedTier = result.tier;
      if (result.escalateTier && resolvedTier) {
        if (resolvedTier === "L1") resolvedTier = "L2";
        else if (resolvedTier === "L2") resolvedTier = "L3";
      }
      assert.strictEqual(resolvedTier, "L3");
    });

    it("should cap at L3 (no L4)", () => {
      const state = createState({
        lastTurnMeta: { tool: "run_research", tier: "L3" },
      });
      const result = detectFollowUpFast("tell me more", state);
      assert.ok(result);
      let resolvedTier = result.tier;
      if (result.escalateTier && resolvedTier) {
        if (resolvedTier === "L1") resolvedTier = "L2";
        else if (resolvedTier === "L2") resolvedTier = "L3";
      }
      assert.strictEqual(resolvedTier, "L3"); // stays at L3
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle state with empty activeSymbols", () => {
      const state = createState({
        lastTurnMeta: { tool: "get_holdings" },
        activeSymbols: [],
      });
      const output = formatStateForPrompt(state);
      assert.ok(!output.includes("Stocks discussed"));
    });

    it("should handle mergeScreenerParams with empty everything", () => {
      const result = mergeScreenerParams({ query: "q" }, {});
      assert.deepStrictEqual(result, {});
    });

    it("should handle detectFollowUpFast with empty params in prior", () => {
      const state = createState({
        lastTurnMeta: { tool: "run_screener" },
      });
      const result = detectFollowUpFast("yes", state);
      assert.ok(result);
      assert.deepStrictEqual(result.params, {});
    });

    it("mergeScreenerParams should handle overlapping filter fields correctly", () => {
      const prior: NonNullable<TurnMeta["screenerState"]> = {
        query: "test",
        filters: [
          { field: "pe_ratio", operator: "lt", value: 20 },
          { field: "roe", operator: "gt", value: 15 },
          { field: "debt_equity", operator: "lt", value: 1 },
        ],
      };
      const result = mergeScreenerParams(prior, {
        filters: [{ field: "roe", operator: "gt", value: 25 }], // override roe
      });
      const filters = result.filters as Array<{
        field: string;
        operator: string;
        value: unknown;
      }>;
      assert.strictEqual(filters.length, 3); // roe(new) + pe(carried) + debt(carried)
      assert.strictEqual(filters[0]!.field, "roe");
      assert.strictEqual(filters[0]!.value, 25);
      assert.strictEqual(filters[1]!.field, "pe_ratio");
      assert.strictEqual(filters[2]!.field, "debt_equity");
    });
  });
});
