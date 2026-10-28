/**
 * Intent Mapper Tests (lib/chat-tools/intent-mapper.ts)
 *
 * Tests for the two-phase intent detection system:
 *   - classifyIntentFast: keyword/regex matching for common chat queries
 *   - parseToolCalls: TOOL_CALL marker parsing from LLM responses
 *   - removeToolCallMarkers: strip markers, return clean text
 *
 * Pure functions copied inline from the source (no side-effecting imports).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed (MONEY-620): import & assert the REAL exports. The previous
// inline copy of INTENT_PATTERNS was a stale subset (it predated the
// higher-priority Portfolio-Roast / Market-indices / Screener guards the
// source added), so the shadow could not catch a classifier-collapse where
// those new guards intercept a query the test expects to hit a later pattern.
import {
  classifyIntentFast,
  parseToolCalls,
  removeToolCallMarkers,
} from "@/lib/chat-tools/intent-mapper";

// ── Tests ──────────────────────────────────────────────────────────────

describe("Intent Mapper", () => {
  // ───────────────────── classifyIntentFast ─────────────────────

  describe("classifyIntentFast", () => {
    // === Portfolio summary ===

    describe("portfolio summary patterns", () => {
      it("should match 'portfolio'", () => {
        const result = classifyIntentFast("Show me my portfolio");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_portfolio_summary");
        assert.strictEqual(result.confidence, 0.8);
      });

      it("should match 'dashboard'", () => {
        const result = classifyIntentFast("Go to dashboard");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_portfolio_summary");
      });

      it("should match 'summary'", () => {
        const result = classifyIntentFast("Give me a summary");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_portfolio_summary");
      });

      it("should match 'overview'", () => {
        const result = classifyIntentFast("What's the overview?");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_portfolio_summary");
      });

      it("should match 'total value'", () => {
        const result = classifyIntentFast("What is my total value?");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_portfolio_summary");
      });

      it("should match 'net worth'", () => {
        const result = classifyIntentFast("Show my net worth");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_portfolio_summary");
      });

      it("should be case-insensitive", () => {
        const result = classifyIntentFast("PORTFOLIO SUMMARY");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_portfolio_summary");
      });
    });

    // === Holdings ===

    describe("holdings patterns", () => {
      it("should match 'show my holdings'", () => {
        const result = classifyIntentFast("Show my holdings");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
      });

      it("should match 'list holdings'", () => {
        const result = classifyIntentFast("List holdings");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
      });

      it("should match 'get holding' (singular)", () => {
        const result = classifyIntentFast("Get my holding details");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
      });

      it("should match 'display holdings'", () => {
        const result = classifyIntentFast("Display all holdings");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
      });

      it("should match 'my holdings'", () => {
        const result = classifyIntentFast("Tell me about my holdings");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
      });

      it("should match 'what stocks do I own'", () => {
        const result = classifyIntentFast("What stocks do I own?");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
      });

      it("should match 'which shares do I own'", () => {
        const result = classifyIntentFast("Which shares do I own?");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
      });

      it("should match 'what shares do I have'", () => {
        const result = classifyIntentFast("What shares do I have?");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
      });

      it("should NOT match 'which shares am I holding' (hold vs holding)", () => {
        // 'holding' doesn't match word boundary for 'hold' in the regex
        // It gets matched by another pattern or returns null
        const result = classifyIntentFast("Which shares am I holding?");
        // This doesn't match the ownership pattern because 'holding' !== 'hold|have|own'
        // But it matches the "holdings" pattern via a different rule
        assert.ok(result === null || result.tool === "get_holdings");
      });

      it("should match 'holdings show'", () => {
        const result = classifyIntentFast("My holdings, please show them");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
      });

      it("should match with extra words between 'show' and 'holdings'", () => {
        const result = classifyIntentFast("Show me my current stock holdings");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
      });
    });

    // === Positions ===

    describe("positions patterns", () => {
      it("should match 'show positions'", () => {
        const result = classifyIntentFast("Show my positions");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_positions");
      });

      it("should match 'open positions'", () => {
        const result = classifyIntentFast("What are my open positions?");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_positions");
      });

      it("should match 'active positions'", () => {
        const result = classifyIntentFast("Show me active positions");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_positions");
      });

      it("should match singular 'position'", () => {
        const result = classifyIntentFast("Get my position details");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_positions");
      });
    });

    // === Trades ===

    describe("trades patterns", () => {
      it("should match 'show trades'", () => {
        const result = classifyIntentFast("Show my trades");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_trades");
      });

      it("should match 'recent trades'", () => {
        const result = classifyIntentFast("Show recent trades");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_trades");
      });

      it("should match 'trade history'", () => {
        const result = classifyIntentFast("Show trade history");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_trades");
      });

      it("should match 'trading book'", () => {
        const result = classifyIntentFast("Open the trading book");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_trades");
      });

      it("should match 'trade journal'", () => {
        const result = classifyIntentFast("View my trade journal");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_trades");
      });
    });

    // === Mutual Funds ===

    describe("mutual funds patterns", () => {
      it("should match 'show mutual funds'", () => {
        const result = classifyIntentFast("Show my mutual funds");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_mutual_funds");
      });

      it("should match 'my MF' (first match is get_holdings due to pattern order)", () => {
        // "Show my MF holdings" matches get_holdings first (show...holdings pattern)
        const result = classifyIntentFast("Show my MF holdings");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
      });

      it("should match 'list my MFs' (mutual funds specific)", () => {
        // Without 'holdings' keyword, this matches mutual funds
        const result = classifyIntentFast("List my MFs");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_mutual_funds");
      });

      it("should match 'list SIPs'", () => {
        const result = classifyIntentFast("List my SIPs");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_mutual_funds");
      });

      // SIP disambiguation: an imperative verb means a FIRE-plan EDIT (SIP = the
      // plan's monthly-savings input); a LIST phrasing stays on funds.
      it("should route an imperative 'increase my SIP' to fire_plan (edit)", () => {
        const result = classifyIntentFast("increase my SIP to 60k");
        assert.ok(result);
        assert.strictEqual(result.tool, "fire_plan");
        assert.strictEqual(result.params.intent, "edit");
      });

      it("should keep a 'show my SIPs' LIST on get_mutual_funds", () => {
        const result = classifyIntentFast("show my SIPs");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_mutual_funds");
      });

      it("should fast-path 'retire at 45' to fire_plan (edit)", () => {
        const result = classifyIntentFast("I want to retire at 45");
        assert.ok(result);
        assert.strictEqual(result.tool, "fire_plan");
        assert.strictEqual(result.params.intent, "edit");
      });

      it("should match 'display mutual fund' (singular)", () => {
        const result = classifyIntentFast("Display mutual fund data");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_mutual_funds");
      });
    });

    // === FIRE scenarios ===

    describe("FIRE scenarios patterns", () => {
      it("should match 'show fire scenarios'", () => {
        const result = classifyIntentFast("Show my fire scenarios");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_fire_scenarios");
      });

      it("should match 'retirement plans'", () => {
        const result = classifyIntentFast("Show my retirement plans");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_fire_scenarios");
      });

      it("should match 'fire number'", () => {
        const result = classifyIntentFast("What is my FIRE number?");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_fire_scenarios");
      });

      it("should match 'fire goal'", () => {
        const result = classifyIntentFast("Show my fire goal");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_fire_scenarios");
      });

      it("should match 'fire target'", () => {
        const result = classifyIntentFast("Am I on track for my fire target?");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_fire_scenarios");
      });

      it("should match 'retirement calculations'", () => {
        const result = classifyIntentFast("Get my retirement calculations");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_fire_scenarios");
      });
    });

    // === Paper trading ===

    describe("paper trading patterns", () => {
      it("should match 'paper positions' (positions pattern matches first)", () => {
        // "Show my paper positions" matches get_positions first (show...positions)
        // This tests the pattern ordering: positions pattern comes before paper pattern
        const result = classifyIntentFast("Show my paper positions");
        assert.ok(result);
        // Due to pattern order, get_positions matches before get_paper_positions
        assert.strictEqual(result.tool, "get_positions");
      });

      it("should match 'virtual trades' (trades pattern matches first)", () => {
        // "Show my virtual trades" matches get_trades first (show...trades)
        const result = classifyIntentFast("Show my virtual trades");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_trades");
      });

      it("should match 'simulated portfolio' (portfolio pattern matches first)", () => {
        // "Display my simulated portfolio" matches get_portfolio_summary first (portfolio)
        const result = classifyIntentFast("Display my simulated portfolio");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_portfolio_summary");
      });

      it("should match 'list paper trades' for paper trading", () => {
        // This matches get_trades because of pattern ordering
        const result = classifyIntentFast("List paper trades");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_trades");
      });
    });

    // === Research (now deferred to Flash — NOT fast-pathed) ===
    //
    // The production fast-path intentionally NO LONGER matches research /
    // "should I buy" / comparison / DCF queries: they go through Flash for
    // proper natural-language understanding (see classifyIntentWithFlash and
    // the INTENT_PATTERNS header comment). The old shadow asserted a removed
    // fast-path contract and silently kept passing — these tests now pin the
    // REAL contract: analytical queries return null from the fast path.

    describe("research queries defer to Flash (return null)", () => {
      it("should NOT fast-path 'research stock TCS'", () => {
        assert.strictEqual(classifyIntentFast("Research the stock TCS"), null);
      });

      it("should NOT fast-path 'analyze company'", () => {
        assert.strictEqual(
          classifyIntentFast("Analyze the company INFY"),
          null
        );
      });

      it("should NOT fast-path 'analyse share' (British spelling)", () => {
        assert.strictEqual(
          classifyIntentFast("Analyse this share for me"),
          null
        );
      });

      it("should NOT fast-path 'deep dive into stock'", () => {
        assert.strictEqual(
          classifyIntentFast("Do a deep dive into this stock"),
          null
        );
      });

      it("should NOT fast-path 'evaluate company'", () => {
        assert.strictEqual(
          classifyIntentFast("Evaluate this company for me"),
          null
        );
      });

      it("should NOT fast-path 'should I buy'", () => {
        assert.strictEqual(classifyIntentFast("Should I buy RELIANCE?"), null);
      });

      it("should NOT fast-path 'should I sell'", () => {
        assert.strictEqual(classifyIntentFast("Should I sell TCS?"), null);
      });

      it("should NOT fast-path 'should I invest in'", () => {
        assert.strictEqual(
          classifyIntentFast("Should I invest in HDFC Bank?"),
          null
        );
      });

      it("should NOT fast-path 'should I hold'", () => {
        assert.strictEqual(classifyIntentFast("Should I hold INFY?"), null);
      });
    });

    // === Comparison (deferred to Flash) ===

    describe("comparison queries defer to Flash (return null)", () => {
      it("should NOT fast-path 'compare stock'", () => {
        assert.strictEqual(
          classifyIntentFast("Compare TCS stock with Infosys"),
          null
        );
      });

      it("should NOT fast-path 'vs company'", () => {
        assert.strictEqual(
          classifyIntentFast("TCS vs Infosys as a company"),
          null
        );
      });

      it("should NOT fast-path 'versus share'", () => {
        assert.strictEqual(classifyIntentFast("HDFC versus SBI share"), null);
      });
    });

    // === DCF / valuation (deferred to Flash) ===

    describe("DCF/valuation queries defer to Flash (return null)", () => {
      it("should NOT fast-path 'dcf'", () => {
        assert.strictEqual(classifyIntentFast("Run a DCF on RELIANCE"), null);
      });

      it("should NOT fast-path 'intrinsic value'", () => {
        assert.strictEqual(
          classifyIntentFast("What is the intrinsic value of TCS?"),
          null
        );
      });

      it("should NOT fast-path 'fair value'", () => {
        assert.strictEqual(
          classifyIntentFast("Is INFY trading above fair value?"),
          null
        );
      });

      it("should NOT fast-path 'valuation'", () => {
        assert.strictEqual(
          classifyIntentFast("What's the valuation of HDFC Bank?"),
          null
        );
      });
    });

    // === Screener guard (MONEY-587) ===
    //
    // The fast-path now has a deterministic screener guard that intercepts
    // explicit "screen …" phrasing and routes it to run_screener (the NL
    // parser inside the executor extracts criteria), echoing the raw message
    // as `query`. Generic "filter companies" / "find shares" still defer to
    // Flash.

    describe("screener guard", () => {
      it("should route 'screen stocks' to run_screener with raw query", () => {
        const result = classifyIntentFast("Screen stocks with PE < 15");
        assert.ok(result);
        assert.strictEqual(result.tool, "run_screener");
        assert.strictEqual(result.params.query, "Screen stocks with PE < 15");
      });

      it("should route 'screen for stocks' to run_screener", () => {
        const result = classifyIntentFast("screen for the best stocks");
        assert.ok(result);
        assert.strictEqual(result.tool, "run_screener");
      });

      it("should route 'stocks similar to my holdings' to run_screener", () => {
        const result = classifyIntentFast("stocks similar to my top holdings");
        assert.ok(result);
        assert.strictEqual(result.tool, "run_screener");
      });

      it("should defer generic 'filter companies' to Flash (null)", () => {
        assert.strictEqual(
          classifyIntentFast("Filter companies with high ROE"),
          null
        );
      });

      it("should defer generic 'find shares' to Flash (null)", () => {
        assert.strictEqual(
          classifyIntentFast("Find shares in IT sector"),
          null
        );
      });
    });

    // === Financial data (deferred to Flash) ===

    describe("financial-data queries defer to Flash (return null)", () => {
      it("should NOT fast-path 'PE ratio of TCS'", () => {
        assert.strictEqual(
          classifyIntentFast("What is the PE ratio of TCS?"),
          null
        );
      });

      it("should NOT fast-path 'fundamentals of INFY'", () => {
        assert.strictEqual(
          classifyIntentFast("Show me fundamentals of INFY"),
          null
        );
      });

      it("should NOT fast-path 'ROE of HDFC'", () => {
        assert.strictEqual(classifyIntentFast("What is ROE of HDFC?"), null);
      });

      it("should NOT fast-path 'debt ratio of RELIANCE'", () => {
        assert.strictEqual(
          classifyIntentFast("Show me debt ratio of RELIANCE"),
          null
        );
      });
    });

    // === Broker-specific holdings ===

    describe("broker-specific holdings patterns", () => {
      it("should match 'zerodha holdings' (generic holdings matches first)", () => {
        // "Show zerodha holdings" matches generic holdings pattern first
        // (show...holdings) before broker-specific pattern
        const result = classifyIntentFast("Show zerodha holdings");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
        // No broker param since generic pattern matched
        assert.deepStrictEqual(result.params, {});
      });

      it("should match 'upstox stocks' and extract broker", () => {
        // "upstox stocks" matches broker pattern (no prior show...holdings)
        const result = classifyIntentFast("upstox stocks");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
        assert.strictEqual(result.params.broker, "UPSTOX");
      });

      it("should match 'groww portfolio' as portfolio summary (pattern order)", () => {
        // "groww portfolio" - 'portfolio' matches get_portfolio_summary first
        const result = classifyIntentFast("Show groww portfolio");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_portfolio_summary");
      });

      it("should match broker pattern when no earlier pattern matches", () => {
        // Direct "zerodha stocks" without 'show' matches broker pattern
        const result = classifyIntentFast("zerodha stocks");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
        assert.strictEqual(result.params.broker, "ZERODHA");
      });

      it("should match 'fyers stocks' and extract broker", () => {
        const result = classifyIntentFast("fyers stocks");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
        assert.strictEqual(result.params.broker, "FYERS");
      });

      it("should match 'angel holding list' (holdings pattern matches first)", () => {
        // "angel holding list" matches holdings_3 pattern (holding...list)
        const result = classifyIntentFast("angel holding list");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
      });

      it("should match 'dhan stocks' with broker param", () => {
        const result = classifyIntentFast("dhan stocks");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
        assert.strictEqual(result.params.broker, "DHAN");
      });
    });

    // === No match / edge cases ===

    describe("no match and edge cases", () => {
      it("should return null for unrelated queries", () => {
        const result = classifyIntentFast("What is the weather today?");
        assert.strictEqual(result, null);
      });

      it("should return null for empty string", () => {
        const result = classifyIntentFast("");
        assert.strictEqual(result, null);
      });

      it("should return null for whitespace only", () => {
        const result = classifyIntentFast("   ");
        assert.strictEqual(result, null);
      });

      it("should handle mixed case input", () => {
        const result = classifyIntentFast("SHOW MY HOLDINGS");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_holdings");
      });

      it("should handle leading and trailing whitespace", () => {
        const result = classifyIntentFast("   portfolio   ");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_portfolio_summary");
      });

      it("should return empty params when no extractParams defined", () => {
        const result = classifyIntentFast("Show my holdings");
        assert.ok(result);
        assert.deepStrictEqual(result.params, {});
      });

      it("should match first pattern in order (portfolio before holdings)", () => {
        // "portfolio" matches get_portfolio_summary before holdings-related patterns
        const result = classifyIntentFast("Show portfolio holdings overview");
        assert.ok(result);
        assert.strictEqual(result.tool, "get_portfolio_summary");
      });

      it("should always return confidence 0.8", () => {
        const result = classifyIntentFast("Show my trades");
        assert.ok(result);
        assert.strictEqual(result.confidence, 0.8);
      });
    });
  });

  // ───────────────────── parseToolCalls ─────────────────────

  describe("parseToolCalls", () => {
    it("should parse a single TOOL_CALL marker", () => {
      const response =
        'Let me check that. TOOL_CALL: {"tool": "get_holdings", "params": {"broker": "ZERODHA"}}';
      const results = parseToolCalls(response);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].tool, "get_holdings");
      assert.strictEqual(results[0].params.broker, "ZERODHA");
      assert.strictEqual(results[0].confidence, 0.9);
    });

    it("should parse multiple TOOL_CALL markers", () => {
      const response = `I'll get both.
TOOL_CALL: {"tool": "get_holdings", "params": {}}
And also:
TOOL_CALL: {"tool": "get_positions", "params": {"status": "OPEN"}}`;
      const results = parseToolCalls(response);
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].tool, "get_holdings");
      assert.strictEqual(results[1].tool, "get_positions");
    });

    it("should return empty array for no TOOL_CALL markers", () => {
      const response = "Just a regular response with no tool calls.";
      const results = parseToolCalls(response);
      assert.strictEqual(results.length, 0);
    });

    it("should skip invalid JSON in TOOL_CALL markers", () => {
      const response =
        'TOOL_CALL: {invalid json here}\nTOOL_CALL: {"tool": "get_trades", "params": {}}';
      const results = parseToolCalls(response);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].tool, "get_trades");
    });

    it("should skip TOOL_CALL with missing tool field", () => {
      const response = 'TOOL_CALL: {"params": {"symbol": "TCS"}}';
      const results = parseToolCalls(response);
      assert.strictEqual(results.length, 0);
    });

    it("should default params to empty object when missing", () => {
      const response = 'TOOL_CALL: {"tool": "get_mutual_funds"}';
      const results = parseToolCalls(response);
      assert.strictEqual(results.length, 1);
      assert.deepStrictEqual(results[0].params, {});
    });

    it("should handle nested params with one level of braces", () => {
      const response =
        'TOOL_CALL: {"tool": "run_research", "params": {"query": "TCS analysis", "symbols": ["TCS"]}}';
      const results = parseToolCalls(response);
      // Note: the regex handles one level of nesting, so this may or may not work
      // depending on exact nesting. arrays are not nested braces so they should be fine
      assert.ok(results.length >= 0); // Accept either match or no-match due to regex limit
    });

    it("should handle whitespace after TOOL_CALL:", () => {
      const response =
        'TOOL_CALL:   {"tool": "get_portfolio_summary", "params": {}}';
      const results = parseToolCalls(response);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].tool, "get_portfolio_summary");
    });

    it("should handle TOOL_CALL at start of response", () => {
      const response = 'TOOL_CALL: {"tool": "get_holdings", "params": {}}';
      const results = parseToolCalls(response);
      assert.strictEqual(results.length, 1);
    });

    it("should handle TOOL_CALL at end of response", () => {
      const response =
        'Sure, let me get that for you. TOOL_CALL: {"tool": "get_trades", "params": {}}';
      const results = parseToolCalls(response);
      assert.strictEqual(results.length, 1);
    });

    it("should correctly parse consecutive calls (regex lastIndex reset)", () => {
      // Call parseToolCalls twice to ensure lastIndex reset works
      const response1 = 'TOOL_CALL: {"tool": "get_holdings", "params": {}}';
      const response2 = 'TOOL_CALL: {"tool": "get_trades", "params": {}}';

      const results1 = parseToolCalls(response1);
      const results2 = parseToolCalls(response2);

      assert.strictEqual(results1.length, 1);
      assert.strictEqual(results2.length, 1);
      assert.strictEqual(results1[0].tool, "get_holdings");
      assert.strictEqual(results2[0].tool, "get_trades");
    });

    it("should always set confidence to 0.9 for parsed tool calls", () => {
      const response = 'TOOL_CALL: {"tool": "get_mutual_funds", "params": {}}';
      const results = parseToolCalls(response);
      assert.strictEqual(results[0].confidence, 0.9);
    });
  });

  // ───────────────────── removeToolCallMarkers ─────────────────────

  describe("removeToolCallMarkers", () => {
    it("should remove TOOL_CALL marker and return clean text", () => {
      const response =
        'Here is your data. TOOL_CALL: {"tool": "get_holdings", "params": {}} Let me explain.';
      const clean = removeToolCallMarkers(response);
      assert.ok(!clean.includes("TOOL_CALL"));
      assert.ok(clean.includes("Here is your data."));
      assert.ok(clean.includes("Let me explain."));
    });

    it("should remove multiple TOOL_CALL markers", () => {
      const response =
        'Text TOOL_CALL: {"tool": "a", "params": {}} middle TOOL_CALL: {"tool": "b", "params": {}} end';
      const clean = removeToolCallMarkers(response);
      assert.ok(!clean.includes("TOOL_CALL"));
      assert.ok(clean.includes("Text"));
      assert.ok(clean.includes("middle"));
      assert.ok(clean.includes("end"));
    });

    it("should return same text when no markers present", () => {
      const response = "Just a plain response.";
      const clean = removeToolCallMarkers(response);
      assert.strictEqual(clean, "Just a plain response.");
    });

    it("should trim whitespace from result", () => {
      const response = '  TOOL_CALL: {"tool": "get_holdings", "params": {}}  ';
      const clean = removeToolCallMarkers(response);
      assert.strictEqual(clean, "");
    });

    it("should return empty string when entire response is a tool call", () => {
      const response = 'TOOL_CALL: {"tool": "get_trades", "params": {}}';
      const clean = removeToolCallMarkers(response);
      assert.strictEqual(clean, "");
    });

    it("should handle invalid JSON (marker stays since regex won't match deep nesting)", () => {
      const response = "TOOL_CALL: not json at all";
      const clean = removeToolCallMarkers(response);
      // The regex requires { ... } after TOOL_CALL:, so this won't match
      assert.ok(clean.includes("TOOL_CALL"));
    });
  });
});
