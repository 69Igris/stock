/**
 * Persona Selector Tests (lib/gemini/persona-selector.ts)
 *
 * Tests for the two-phase persona selection system:
 *   - selectPersonaFast: keyword-based matching against persona trigger keywords
 *   - selectPersonaFromFlash: validates Flash-returned persona IDs
 *   - selectPersona: unified selector (Flash > keyword > default)
 *   - getBareStockOptions: persona-specific options for bare stock queries
 *
 * Pure functions extracted inline to avoid server-only import chains.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// De-shadowed (MONEY-620): assert the REAL persona-selector exports. The
// selector + persona DATA now live in modules free of the server-only
// `@/lib/chat-tools` chain, so they import cleanly here and the keyword matching
// runs against the SAME triggerKeywords production uses (a superset of the old
// inline copy — e.g. equity_research now also matches "shareholding").
import {
  selectPersonaFast,
  selectPersonaFromFlash,
  selectPersona,
  getBareStockOptions,
} from "@/lib/gemini/persona-selector";
import {
  getAllPersonaIds,
  type PersonaId,
} from "@/lib/gemini/prompt-personas-data";

const ALL_PERSONA_IDS: PersonaId[] = getAllPersonaIds();

// ── Tests ──────────────────────────────────────────────────────────────

describe("Persona Selector", () => {
  describe("selectPersonaFast()", () => {
    it("should match equity_research for 'analyse TCS'", () => {
      const result = selectPersonaFast("analyse TCS");
      assert.ok(result);
      assert.strictEqual(result.personaId, "equity_research");
      assert.strictEqual(result.source, "keyword");
    });

    it("should match equity_research for 'research RELIANCE'", () => {
      const result = selectPersonaFast("research RELIANCE");
      assert.ok(result);
      assert.strictEqual(result.personaId, "equity_research");
    });

    it("should match wealth_advisor for 'compare my mutual funds'", () => {
      const result = selectPersonaFast("compare my mutual funds");
      assert.ok(result);
      assert.strictEqual(result.personaId, "wealth_advisor");
    });

    it("should match wealth_advisor for 'SIP projection for next 10 years'", () => {
      const result = selectPersonaFast("SIP projection for next 10 years");
      assert.ok(result);
      assert.strictEqual(result.personaId, "wealth_advisor");
    });

    it("should match financial_planner for 'show my FIRE scenarios'", () => {
      const result = selectPersonaFast("show my FIRE scenarios");
      assert.ok(result);
      assert.strictEqual(result.personaId, "financial_planner");
    });

    it("should match financial_planner for 'retirement planning with NPS'", () => {
      const result = selectPersonaFast("retirement planning with NPS");
      assert.ok(result);
      assert.strictEqual(result.personaId, "financial_planner");
    });

    it("should match quant_analyst for 'find undervalued large caps'", () => {
      const result = selectPersonaFast("find undervalued large caps");
      assert.ok(result);
      assert.strictEqual(result.personaId, "quant_analyst");
    });

    it("should match quant_analyst for 'screen stocks with high ROE'", () => {
      const result = selectPersonaFast("screen stocks with high ROE");
      assert.ok(result);
      assert.strictEqual(result.personaId, "quant_analyst");
    });

    it("should match technical_analyst for 'RSI and MACD of HDFC'", () => {
      const result = selectPersonaFast("RSI and MACD of HDFC");
      assert.ok(result);
      assert.strictEqual(result.personaId, "technical_analyst");
    });

    it("should match technical_analyst for 'show support resistance levels'", () => {
      const result = selectPersonaFast("show support resistance levels");
      assert.ok(result);
      assert.strictEqual(result.personaId, "technical_analyst");
    });

    it("should match portfolio_manager for 'review my portfolio'", () => {
      const result = selectPersonaFast("review my portfolio");
      assert.ok(result);
      assert.strictEqual(result.personaId, "portfolio_manager");
    });

    it("should match portfolio_manager for 'rebalance my holdings'", () => {
      const result = selectPersonaFast("rebalance my holdings");
      assert.ok(result);
      assert.strictEqual(result.personaId, "portfolio_manager");
    });

    it("should match private_banker for 'tax saving options'", () => {
      const result = selectPersonaFast("tax saving options");
      assert.ok(result);
      assert.strictEqual(result.personaId, "private_banker");
    });

    it("should match private_banker for 'LTCG vs STCG impact'", () => {
      const result = selectPersonaFast("LTCG vs STCG impact");
      assert.ok(result);
      assert.strictEqual(result.personaId, "private_banker");
    });

    it("should match macro_strategist for 'how is the market today'", () => {
      const result = selectPersonaFast("how is the market today");
      assert.ok(result);
      assert.strictEqual(result.personaId, "macro_strategist");
    });

    it("should match macro_strategist for 'FII DII flows this week'", () => {
      const result = selectPersonaFast("FII DII flows this week");
      assert.ok(result);
      assert.strictEqual(result.personaId, "macro_strategist");
    });

    it("should match sell_side_analyst for 'compare TCS vs INFY'", () => {
      const result = selectPersonaFast("compare TCS vs INFY");
      assert.ok(result);
      assert.strictEqual(result.personaId, "sell_side_analyst");
    });

    it("should match sell_side_analyst for 'which is better TCS or WIPRO'", () => {
      const result = selectPersonaFast("which is better TCS or WIPRO");
      assert.ok(result);
      assert.strictEqual(result.personaId, "sell_side_analyst");
    });

    it("should return null for unrelated queries", () => {
      const result = selectPersonaFast("hello how are you");
      assert.strictEqual(result, null);
    });

    it("should return null for empty message", () => {
      const result = selectPersonaFast("");
      assert.strictEqual(result, null);
    });

    it("should pick persona with most keyword matches when multiple match", () => {
      // "technical analysis RSI MACD support" has 4 keywords for technical_analyst
      const result = selectPersonaFast(
        "technical analysis RSI MACD support resistance"
      );
      assert.ok(result);
      assert.strictEqual(result.personaId, "technical_analyst");
      assert.ok(result.confidence > 0.8, "High confidence for many matches");
    });

    it("confidence should increase with more keyword matches", () => {
      const single = selectPersonaFast("analyse");
      const multi = selectPersonaFast("analyse research evaluate stock");
      assert.ok(single);
      assert.ok(multi);
      assert.ok(multi.confidence > single.confidence);
    });

    it("confidence should cap at 0.95", () => {
      // Many keywords for technical_analyst
      const result = selectPersonaFast(
        "RSI MACD bollinger support resistance chart technical pattern breakout"
      );
      assert.ok(result);
      assert.ok(result.confidence <= 0.95);
    });

    it("should handle short keywords with word boundary (e.g., 'mf')", () => {
      const result = selectPersonaFast("show my mf holdings");
      assert.ok(result);
      assert.strictEqual(result.personaId, "wealth_advisor");
    });

    it("should not match short keyword 'mf' inside other words", () => {
      // "comfortable" contains "mf" but not as a word
      const result = selectPersonaFast("I am comfortable with this");
      // Should NOT match wealth_advisor for "mf" inside "comfortable"
      if (result) {
        assert.notStrictEqual(result.personaId, "wealth_advisor");
      }
    });

    it("should be case-insensitive", () => {
      const result = selectPersonaFast("ANALYSE tcs STOCK");
      assert.ok(result);
      assert.strictEqual(result.personaId, "equity_research");
    });
  });

  describe("selectPersonaFromFlash()", () => {
    it("should accept valid persona ID from Flash", () => {
      const result = selectPersonaFromFlash("equity_research");
      assert.ok(result);
      assert.strictEqual(result.personaId, "equity_research");
      assert.strictEqual(result.source, "flash");
      assert.strictEqual(result.confidence, 0.85);
    });

    it("should accept all valid persona IDs", () => {
      for (const id of ALL_PERSONA_IDS) {
        const result = selectPersonaFromFlash(id);
        assert.ok(result, `Should accept ${id}`);
        assert.strictEqual(result.personaId, id);
      }
    });

    it("should return null for undefined", () => {
      const result = selectPersonaFromFlash(undefined);
      assert.strictEqual(result, null);
    });

    it("should return null for invalid persona ID", () => {
      const result = selectPersonaFromFlash("not_a_persona");
      assert.strictEqual(result, null);
    });

    it("should return null for empty string", () => {
      const result = selectPersonaFromFlash("");
      assert.strictEqual(result, null);
    });
  });

  describe("selectPersona() - unified selector", () => {
    it("should prefer Flash persona when provided", () => {
      // Message matches equity_research, but Flash says technical_analyst
      const result = selectPersona("analyse TCS", "technical_analyst");
      assert.strictEqual(result.personaId, "technical_analyst");
      assert.strictEqual(result.source, "flash");
    });

    it("should fall back to keyword matching when no Flash persona", () => {
      const result = selectPersona("analyse TCS");
      assert.strictEqual(result.personaId, "equity_research");
      assert.strictEqual(result.source, "keyword");
    });

    it("should fall back to general_analyst when nothing matches", () => {
      const result = selectPersona("hello world");
      assert.strictEqual(result.personaId, "general_analyst");
      assert.strictEqual(result.source, "default");
      assert.strictEqual(result.confidence, 0.5);
    });

    it("should ignore invalid Flash persona and use keyword", () => {
      const result = selectPersona("analyse TCS", "invalid_id");
      assert.strictEqual(result.personaId, "equity_research");
      assert.strictEqual(result.source, "keyword");
    });

    it("should always return a valid PersonaSelection", () => {
      const queries = [
        "random gibberish xyz",
        "",
        "analyse RELIANCE",
        "show my FIRE plan",
        "compare TCS vs INFY",
      ];
      for (const q of queries) {
        const result = selectPersona(q);
        assert.ok(result.personaId, `Should have personaId for "${q}"`);
        assert.ok(result.source, `Should have source for "${q}"`);
        assert.ok(
          typeof result.confidence === "number",
          `Should have confidence for "${q}"`
        );
      }
    });
  });

  describe("getBareStockOptions()", () => {
    it("should include the stock symbol in bold", () => {
      const options = getBareStockOptions("TCS");
      assert.ok(options.includes("**TCS**"));
    });

    it("should include all 5 persona-specific options", () => {
      const options = getBareStockOptions("RELIANCE");
      assert.ok(options.includes("Equity Research"));
      assert.ok(options.includes("Deep Valuation"));
      assert.ok(options.includes("Technical Analysis"));
      assert.ok(options.includes("Peer Comparison"));
      assert.ok(options.includes("Latest News"));
    });

    it("should include freeform prompt at the end", () => {
      const options = getBareStockOptions("HDFC");
      assert.ok(options.includes("ask anything specific about HDFC"));
    });

    it("should work with different symbols", () => {
      const symbols = ["TCS", "RELIANCE", "INFY", "HDFCBANK"];
      for (const sym of symbols) {
        const options = getBareStockOptions(sym);
        assert.ok(options.includes(`**${sym}**`));
        assert.ok(options.includes(`about ${sym}`));
      }
    });
  });
});
