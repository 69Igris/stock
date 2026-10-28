/**
 * Input Validator Tests (lib/chat-tools/input-validator.ts)
 *
 * Tests for the Layer 1 input validation utilities:
 *   - parseContextKey: normalize chat context mode to context key
 *   - isToolAllowedInContext: check if tool is permitted in current context
 *   - filterUnsafeContent: strip prompt-leak markers from LLM output
 *   - detectDisclaimers: detect financial recommendations and return disclaimers
 *
 * Also covers output-validator.ts functions (filterUnsafeContent, detectDisclaimers)
 * which are private in that module but tested inline here.
 *
 * Pure functions extracted inline from the source (no side-effecting imports).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed (MONEY-620): assert the REAL helpers.
// - parseContextKey / isToolAllowedInContext now live in input-validator-logic.ts
//   (input-validator.ts resolves the tool via getTool and calls the latter).
// - filterUnsafeContent / detectDisclaimers are the REAL output-validator-logic
//   exports. Importing them caught a drift: the old inline detectDisclaimers
//   copy was MISSING the allocation/rebalancing ("rebalance 30% into bonds",
//   "overweight") financial-advice branch the source added.
import {
  parseContextKey,
  isToolAllowedInContext,
  type ToolContextScope,
} from "@/lib/chat-tools/input-validator-logic";
import {
  filterUnsafeContent,
  detectDisclaimers,
} from "@/lib/chat-tools/output-validator-logic";

interface MockToolContexts extends ToolContextScope {
  name: string;
}

// ── Mock tool definitions ──────────────────────────────────────────────

const MOCK_TOOLS: Record<string, MockToolContexts> = {
  get_portfolio_summary: {
    name: "get_portfolio_summary",
    contexts: ["all", "stock_analysis", "mf_analysis"],
  },
  get_holdings: {
    name: "get_holdings",
    contexts: ["all", "stock_analysis"],
  },
  get_mutual_funds: {
    name: "get_mutual_funds",
    contexts: ["all", "mf_analysis"],
  },
  get_fire_scenarios: {
    name: "get_fire_scenarios",
    contexts: ["all", "retirement"],
  },
  get_paper_positions: {
    name: "get_paper_positions",
    contexts: ["all", "paper_trading"],
  },
  buy_paper_position: {
    name: "buy_paper_position",
    contexts: ["all", "paper_trading"],
  },
  run_research: {
    name: "run_research",
    contexts: ["all", "stock_analysis", "research"],
  },
};

function getMockTool(name: string): MockToolContexts | null {
  return MOCK_TOOLS[name] || null;
}

// ======================================================================
// Tests
// ======================================================================

describe("Input Validator", () => {
  // ── parseContextKey ──────────────────────────────────────────────

  describe("parseContextKey", () => {
    it("should return 'all' for 'all' context", () => {
      assert.strictEqual(parseContextKey("all"), "all");
    });

    it("should return 'all' for broker-specific context", () => {
      assert.strictEqual(parseContextKey("broker:ZERODHA:conn-123"), "all");
    });

    it("should return 'all' for any broker prefix", () => {
      assert.strictEqual(parseContextKey("broker:UPSTOX:abc-456"), "all");
    });

    it("should return context as-is for stock_analysis", () => {
      assert.strictEqual(parseContextKey("stock_analysis"), "stock_analysis");
    });

    it("should return context as-is for mf_analysis", () => {
      assert.strictEqual(parseContextKey("mf_analysis"), "mf_analysis");
    });

    it("should return context as-is for retirement", () => {
      assert.strictEqual(parseContextKey("retirement"), "retirement");
    });

    it("should return context as-is for paper_trading", () => {
      assert.strictEqual(parseContextKey("paper_trading"), "paper_trading");
    });

    it("should return context as-is for research", () => {
      assert.strictEqual(parseContextKey("research"), "research");
    });

    it("should treat broker: prefix with any format as 'all'", () => {
      assert.strictEqual(parseContextKey("broker:DHAN:xyz"), "all");
      assert.strictEqual(
        parseContextKey("broker:FYERS:some-long-connection-id"),
        "all"
      );
    });
  });

  // ── isToolAllowedInContext ───────────────────────────────────────

  describe("isToolAllowedInContext", () => {
    it("should return false for null tool", () => {
      assert.strictEqual(isToolAllowedInContext(null, "all"), false);
    });

    it("should allow any tool when contextKey is 'all'", () => {
      const tool = getMockTool("get_holdings");
      assert.strictEqual(isToolAllowedInContext(tool, "all"), true);
    });

    it("should allow tool when context matches", () => {
      const tool = getMockTool("get_holdings");
      assert.strictEqual(isToolAllowedInContext(tool, "stock_analysis"), true);
    });

    it("should disallow tool when context does not match", () => {
      const tool = getMockTool("get_holdings");
      assert.strictEqual(isToolAllowedInContext(tool, "retirement"), false);
    });

    it("should allow get_fire_scenarios in retirement context", () => {
      const tool = getMockTool("get_fire_scenarios");
      assert.strictEqual(isToolAllowedInContext(tool, "retirement"), true);
    });

    it("should disallow get_fire_scenarios in paper_trading context", () => {
      const tool = getMockTool("get_fire_scenarios");
      assert.strictEqual(isToolAllowedInContext(tool, "paper_trading"), false);
    });

    it("should allow buy_paper_position in paper_trading context", () => {
      const tool = getMockTool("buy_paper_position");
      assert.strictEqual(isToolAllowedInContext(tool, "paper_trading"), true);
    });

    it("should disallow buy_paper_position in mf_analysis context", () => {
      const tool = getMockTool("buy_paper_position");
      assert.strictEqual(isToolAllowedInContext(tool, "mf_analysis"), false);
    });

    it("should allow get_mutual_funds in mf_analysis context", () => {
      const tool = getMockTool("get_mutual_funds");
      assert.strictEqual(isToolAllowedInContext(tool, "mf_analysis"), true);
    });

    it("should disallow get_mutual_funds in stock_analysis context", () => {
      const tool = getMockTool("get_mutual_funds");
      assert.strictEqual(isToolAllowedInContext(tool, "stock_analysis"), false);
    });

    it("should allow run_research in research context", () => {
      const tool = getMockTool("run_research");
      assert.strictEqual(isToolAllowedInContext(tool, "research"), true);
    });

    it("should allow run_research in stock_analysis context", () => {
      const tool = getMockTool("run_research");
      assert.strictEqual(isToolAllowedInContext(tool, "stock_analysis"), true);
    });
  });

  // ── filterUnsafeContent ──────────────────────────────────────────

  describe("filterUnsafeContent", () => {
    it("should remove SYSTEM PROMPT: markers", () => {
      const cleaned = filterUnsafeContent(
        "Here is SYSTEM PROMPT: some leaked text"
      );
      assert.ok(!cleaned.includes("SYSTEM PROMPT:"));
    });

    it("should remove INSTRUCTION: markers", () => {
      const cleaned = filterUnsafeContent(
        "INSTRUCTION: do something bad. Normal text."
      );
      assert.ok(!cleaned.includes("INSTRUCTION:"));
      assert.ok(cleaned.includes("Normal text."));
    });

    it("should remove [INTERNAL] markers", () => {
      const cleaned = filterUnsafeContent(
        "This is [INTERNAL] debug info that should be hidden."
      );
      assert.ok(!cleaned.includes("[INTERNAL]"));
      assert.ok(cleaned.includes("debug info"));
    });

    it("should be case-insensitive for SYSTEM PROMPT", () => {
      assert.ok(
        !filterUnsafeContent("system prompt: leak").includes("system prompt:")
      );
      assert.ok(
        !filterUnsafeContent("System Prompt: leak").includes("System Prompt:")
      );
      assert.ok(
        !filterUnsafeContent("SYSTEM prompt: leak").includes("SYSTEM prompt:")
      );
    });

    it("should be case-insensitive for INSTRUCTION", () => {
      assert.ok(
        !filterUnsafeContent("instruction: test").includes("instruction:")
      );
      assert.ok(
        !filterUnsafeContent("Instruction: test").includes("Instruction:")
      );
    });

    it("should be case-insensitive for [INTERNAL]", () => {
      assert.ok(!filterUnsafeContent("[internal] data").includes("[internal]"));
      assert.ok(!filterUnsafeContent("[Internal] data").includes("[Internal]"));
    });

    it("should handle text with no unsafe content", () => {
      const safe = "This is a perfectly normal response about stocks.";
      assert.strictEqual(filterUnsafeContent(safe), safe);
    });

    it("should handle empty string", () => {
      assert.strictEqual(filterUnsafeContent(""), "");
    });

    it("should remove multiple occurrences", () => {
      const cleaned = filterUnsafeContent(
        "INSTRUCTION: first [INTERNAL] middle SYSTEM PROMPT: end"
      );
      assert.ok(!cleaned.includes("INSTRUCTION:"));
      assert.ok(!cleaned.includes("[INTERNAL]"));
      assert.ok(!cleaned.includes("SYSTEM PROMPT:"));
    });

    it("should handle SYSTEM  PROMPT with extra spaces", () => {
      // The regex uses \\s* so it should match any whitespace
      const cleaned = filterUnsafeContent("SYSTEM  PROMPT: leaked");
      assert.ok(!cleaned.includes("SYSTEM  PROMPT:"));
    });
  });

  // ── detectDisclaimers ────────────────────────────────────────────

  describe("detectDisclaimers", () => {
    describe("financial advice disclaimer", () => {
      it("should trigger for 'buy recommendation'", () => {
        const disclaimers = detectDisclaimers(
          "Based on analysis, my buy recommendation for RELIANCE is strong."
        );
        assert.ok(disclaimers.length > 0);
        assert.ok(disclaimers[0].includes("not financial advice"));
      });

      it("should trigger for 'sell recommendation'", () => {
        const disclaimers = detectDisclaimers(
          "My sell recommendation for this stock is based on weak fundamentals."
        );
        assert.ok(disclaimers.some((d) => d.includes("SEBI-registered")));
      });

      it("should trigger for 'recommend buy'", () => {
        const disclaimers = detectDisclaimers(
          "I recommend buy of TCS at current levels."
        );
        assert.ok(disclaimers.length > 0);
        assert.ok(disclaimers[0].includes("not financial advice"));
      });

      it("should trigger for 'suggest invest'", () => {
        const disclaimers = detectDisclaimers(
          "I suggest invest in mutual funds for long term."
        );
        assert.ok(disclaimers.length > 0);
      });

      it("should trigger for 'short advice'", () => {
        const disclaimers = detectDisclaimers(
          "The short advice is to wait for better entry."
        );
        assert.ok(disclaimers.length > 0);
      });

      it("should trigger for 'long recommendation'", () => {
        const disclaimers = detectDisclaimers(
          "A long recommendation based on fundamentals."
        );
        assert.ok(disclaimers.length > 0);
      });

      it("should NOT trigger for general discussion about stocks", () => {
        const disclaimers = detectDisclaimers(
          "RELIANCE reported strong quarterly earnings. Revenue grew 15%."
        );
        assert.strictEqual(disclaimers.length, 0);
      });

      it("should NOT trigger for portfolio display text", () => {
        const disclaimers = detectDisclaimers(
          "Here are your holdings: TCS (100 shares), INFY (50 shares)."
        );
        assert.strictEqual(disclaimers.length, 0);
      });
    });

    describe("past performance disclaimer", () => {
      it("should trigger for 'target price'", () => {
        const disclaimers = detectDisclaimers(
          "The target price for RELIANCE is 3000."
        );
        assert.ok(disclaimers.some((d) => d.includes("Past performance")));
      });

      it("should trigger for 'stop loss'", () => {
        const disclaimers = detectDisclaimers(
          "Set your stop loss at 2200 to limit downside."
        );
        assert.ok(
          disclaimers.some((d) => d.includes("investments carry risk"))
        );
      });

      it("should trigger for 'entry price'", () => {
        const disclaimers = detectDisclaimers(
          "Good entry price for this stock would be around 1500."
        );
        assert.ok(disclaimers.some((d) => d.includes("Past performance")));
      });

      it("should NOT trigger for generic price mentions", () => {
        const disclaimers = detectDisclaimers(
          "The current price of TCS is 3800. It went up 2% today."
        );
        assert.strictEqual(disclaimers.length, 0);
      });
    });

    // Regression: the allocation/rebalancing branch the original shadow lacked.
    describe("allocation / rebalancing disclaimer", () => {
      it("should trigger financial-advice for 'rebalance 30% into bonds'", () => {
        const disclaimers = detectDisclaimers("Rebalance 30% into bonds now.");
        assert.ok(
          disclaimers.some((d) => d.includes("not financial advice")),
          "bare-% rebalancing must still trigger the SEBI disclaimer"
        );
      });

      it("should trigger for the spelled-out 'allocate 40 percent'", () => {
        const disclaimers = detectDisclaimers(
          "I'd allocate 40 percent to equity."
        );
        assert.ok(disclaimers.some((d) => d.includes("SEBI-registered")));
      });

      it("should trigger for 'overweight' / 'underweight'", () => {
        assert.ok(
          detectDisclaimers("Go overweight on IT.").some((d) =>
            d.includes("not financial advice")
          )
        );
        assert.ok(
          detectDisclaimers("Stay underweight on metals.").some((d) =>
            d.includes("not financial advice")
          )
        );
      });

      it("should not double-add the advice disclaimer when buy-advice already matched", () => {
        const disclaimers = detectDisclaimers(
          "I recommend buy and shift 20% into gold."
        );
        const adviceCount = disclaimers.filter((d) =>
          d.includes("not financial advice")
        ).length;
        assert.strictEqual(adviceCount, 1);
      });
    });

    describe("combined disclaimers", () => {
      it("should return both disclaimers when both patterns match", () => {
        const disclaimers = detectDisclaimers(
          "I recommend buy of RELIANCE. Target price is 3000 with stop loss at 2500."
        );
        assert.strictEqual(disclaimers.length, 2);
        assert.ok(disclaimers.some((d) => d.includes("not financial advice")));
        assert.ok(disclaimers.some((d) => d.includes("Past performance")));
      });

      it("should return only financial advice disclaimer if no price targets", () => {
        const disclaimers = detectDisclaimers(
          "I suggest buy for long term wealth creation."
        );
        assert.strictEqual(disclaimers.length, 1);
        assert.ok(disclaimers[0].includes("not financial advice"));
      });
    });

    describe("edge cases", () => {
      it("should return empty array for empty string", () => {
        assert.deepStrictEqual(detectDisclaimers(""), []);
      });

      it("should be case-insensitive", () => {
        const disclaimers = detectDisclaimers(
          "TARGET PRICE is set at 5000 for this stock."
        );
        assert.ok(disclaimers.length > 0);
      });

      it("should handle mixed case", () => {
        const disclaimers = detectDisclaimers(
          "The Stop Loss should be around 2000."
        );
        assert.ok(disclaimers.length > 0);
      });

      it("should handle text with only unrelated financial terms", () => {
        const disclaimers = detectDisclaimers(
          "The PE ratio is 25, debt-to-equity is 0.5, and ROE is 18%."
        );
        assert.strictEqual(disclaimers.length, 0);
      });
    });
  });

  // ── Integration: parseContextKey + isToolAllowedInContext ─────────

  describe("context flow integration", () => {
    it("broker context allows all tools", () => {
      const contextKey = parseContextKey("broker:ZERODHA:conn-1");
      const tool = getMockTool("get_fire_scenarios");
      assert.strictEqual(isToolAllowedInContext(tool, contextKey), true);
    });

    it("stock_analysis context allows holdings but not paper trading", () => {
      const contextKey = parseContextKey("stock_analysis");
      assert.strictEqual(
        isToolAllowedInContext(getMockTool("get_holdings"), contextKey),
        true
      );
      assert.strictEqual(
        isToolAllowedInContext(getMockTool("buy_paper_position"), contextKey),
        false
      );
    });

    it("retirement context allows fire scenarios but not holdings", () => {
      const contextKey = parseContextKey("retirement");
      assert.strictEqual(
        isToolAllowedInContext(getMockTool("get_fire_scenarios"), contextKey),
        true
      );
      assert.strictEqual(
        isToolAllowedInContext(getMockTool("get_holdings"), contextKey),
        false
      );
    });

    it("'all' context allows every tool", () => {
      const contextKey = parseContextKey("all");
      for (const toolName of Object.keys(MOCK_TOOLS)) {
        const tool = getMockTool(toolName);
        assert.strictEqual(
          isToolAllowedInContext(tool, contextKey),
          true,
          `Expected ${toolName} to be allowed in 'all' context`
        );
      }
    });
  });
});
