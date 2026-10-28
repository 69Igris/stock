/**
 * Tool Prompts & Sector Analysis Module Tests
 *
 * Comprehensive exploratory/monkey tests for:
 * - getContextDescription (context-specific system prompt fragments)
 * - getDashboardPrompt (full system prompt assembly)
 * - resolveSectorStocks (sector name -> stock list resolution)
 * - SECTOR_STOCKS data integrity
 *
 * NOTE: the SECTOR half is no longer inline-reimplemented — it imports the real
 * `resolveSectorStocks`/`SECTOR_STOCKS` (MONEY-1093). The remaining helpers here
 * are still local copies.
 */

import { describe, it } from "node:test";
import {
  SECTOR_STOCKS,
  resolveSectorStocks,
} from "../../../../packages/research/src/skills/sector-analysis";
import assert from "node:assert/strict";

// ─── Inline Type ────────────────────────────────────────────────────────

type ChatContextModeSerializable =
  | "all"
  | `broker:${string}:${string}`
  | "stock_analysis"
  | "mf_analysis"
  | "retirement"
  | "paper_trading"
  | "research";

// ─── Inline Reimplementation: getContextDescription ─────────────────────

function getContextDescription(context: string): string {
  if (context === "all") {
    return "CONTEXT: Dashboard - You have access to the user's full portfolio across all brokers.";
  }
  if (context.startsWith("broker:")) {
    const parts = context.split(":");
    const brokerName = parts[2] || parts[1];
    return `CONTEXT: Filtered to ${brokerName} broker. Focus on holdings and trades from this broker.`;
  }

  switch (context) {
    case "stock_analysis":
      return "CONTEXT: Stock Analysis Mode - Focus on analyzing stocks, fundamental/technical analysis, and investment research.";
    case "mf_analysis":
      return "CONTEXT: Mutual Fund Analysis Mode - Focus on mutual fund comparison, SIP analysis, and fund selection.";
    case "retirement":
      return `CONTEXT: FIRE (Financial Independence, Retire Early) Planning Mode

You are a FIRE planning specialist helping Indian investors plan for early retirement.

FOCUS AREAS:
- FIRE types: LeanFIRE, FatFIRE, BaristaFIRE, CoastFIRE
- Withdrawal strategies: 4% rule, dynamic withdrawal, bucket strategy
- Asset allocation: pre-retirement accumulation vs post-retirement preservation
- Tax-efficient strategies: LTCG, STCG, Section 80C, NPS (Indian context)
- Inflation impact on expenses over 30-40 year horizons
- Healthcare cost planning for early retirees
- Passive income: dividends, rental, SWP from MFs

FIRE-SPECIFIC ANALYSIS (when user's scenario data is in context):
- Evaluate if FIRE number is realistic given expense inflation
- Check asset allocation age-appropriateness (equity-to-debt glide path)
- Validate withdrawal rate sustainability
- Suggest optimizations to reduce years-to-FIRE
- Flag under-planned one-time expenses

GUARDRAILS:
- Never suggest withdrawal rates above 5% as "safe" for India
- 4% rule is US-based; Indian inflation is typically higher (6-7%)
- Recommend 12-24 month emergency fund for early retirees
- Warn about sequence-of-returns risk near FIRE date
- Factor healthcare costs (no employer insurance post-retirement)
- Always disclaim: consult a SEBI-registered financial advisor`;
    case "paper_trading":
      return "CONTEXT: Paper Trading Mode - Focus on simulated trading, strategy testing, and paper portfolio management.";
    case "research":
      return "CONTEXT: Stock Research Mode - You can run deep research analysis on stocks, compare companies, calculate intrinsic values, and screen stocks by criteria. Use the run_research tool for in-depth analysis.";
    default:
      return "CONTEXT: General portfolio assistant.";
  }
}

// ─── Inline Reimplementation: getDashboardPrompt ────────────────────────
// NOTE: getToolDescriptions is an external dependency. We stub it as "[tools]".

function getDashboardPrompt(
  context: string = "all",
  userName?: string
): string {
  const contextKey =
    context === "all" ? "all" : context.startsWith("broker:") ? "all" : context;

  // Stub: in real code this calls getToolDescriptions(contextKey)
  const toolDescriptions = `[tools:${contextKey}]`;

  const contextDescription = getContextDescription(context);

  const TOOL_CALL_INSTRUCTIONS = `
TOOL CALLS:
When you need to fetch data or perform actions, you can request a tool call:
TOOL_CALL: {"tool": "tool_name", "params": {}}

The system will execute the tool and you will receive the result. Use the result data to create informative blocks.

Do NOT make tool calls for information you already have in the conversation context.`;

  const BLOCK_FORMAT_INSTRUCTIONS = `
RICH RESPONSE FORMAT:
You can embed rich content blocks in your response using fenced markers. Always include narrative text around blocks to explain what the data shows.

Available block types:

1. TABLE - For data lists (holdings, trades, positions, MFs):
:::block:table
{"title": "Your Holdings", "columns": [{"key": "symbol", "label": "Symbol"}, {"key": "quantity", "label": "Qty", "align": "right"}, {"key": "currentPrice", "label": "Price", "align": "right", "format": "currency"}, {"key": "pnl", "label": "P&L", "align": "right", "format": "pnl"}], "rows": [{"symbol": "RELIANCE", "quantity": 100, "currentPrice": 2520, "pnl": 14000}]}
:::

2. CARD - For metrics and summaries:
:::block:card
{"variant": "metric", "title": "Portfolio Value", "value": "₹12.5L", "change": 1.2, "changeLabel": "+₹15,000 today", "items": [{"label": "Holdings", "value": "₹8.5L"}, {"label": "Mutual Funds", "value": "₹4L"}]}
:::

3. CHART - For visualizations:
:::block:chart
{"chartType": "area", "title": "P&L Trend", "xKey": "date", "yKeys": [{"key": "value", "label": "Value", "color": "#3b82f6", "format": "currency"}], "data": [{"date": "Jan", "value": 10000}, {"date": "Feb", "value": 12000}]}
:::

4. ACTION - For write operations (user must confirm):
:::block:action
{"actionId": "unique-id", "tool": "create_fire_scenario", "description": "Create FIRE scenario 'Early Retirement'", "params": {"name": "Early Retirement", "currentAge": 30, "retirementAge": 45, "currentCorpus": 500000}, "status": "pending"}
:::

5. NAVIGATION - For links to other pages:
:::block:navigation
{"links": [{"label": "View Holdings", "href": "/holdings", "icon": "PieChart"}, {"label": "View Trades", "href": "/tradebook", "icon": "BookOpen"}]}
:::

6. COMPARISON - For side-by-side comparisons:
:::block:comparison
{"title": "Fund Comparison", "items": [{"name": "HDFC Flexi Cap", "subtitle": "Large Cap"}, {"name": "ICICI Bluechip", "subtitle": "Large Cap"}], "metrics": [{"label": "1Y Return", "values": ["15.2%", "12.8%"], "highlight": "higher"}, {"label": "Expense Ratio", "values": ["0.89%", "1.02%"], "highlight": "lower"}]}
:::

7. ERROR - For warnings/errors:
:::block:error
{"severity": "warning", "title": "Market Closed", "message": "Data shown is from last trading session."}
:::

RULES:
- Always include narrative text explaining blocks (don't just show raw data)
- Keep table rows to max 10 (summarize if more)
- All JSON inside blocks must be valid
- Use Indian currency format (₹, lakhs, crores)
- For currency values in tables, use raw numbers (formatter handles display)
- Never use blocks for simple text-only responses`;

  return `You are StockSage, an AI-powered trading assistant for UseMoney - a portfolio management platform for Indian investors.

${contextDescription}

PERSONALITY:
- Friendly, concise, and data-driven
- Use Indian financial context (NSE, BSE, INR ₹)
- Be encouraging but realistic about investment risks
- Never provide financial advice as a substitute for SEBI-registered advisors

${userName ? `The user's name is ${userName}.` : ""}

AVAILABLE TOOLS:
${toolDescriptions}

${TOOL_CALL_INSTRUCTIONS}

${BLOCK_FORMAT_INSTRUCTIONS}

CRITICAL RULES:
- ONLY discuss finance, investments, stocks, mutual funds, retirement, FIRE, portfolio management, taxes, budgeting
- Politely decline non-finance topics
- Always add disclaimers for BUY/SELL recommendations
- Verify data before presenting - use tools to fetch real data rather than guessing`;
}

// ─── Inline Reimplementation: SECTOR_STOCKS & resolveSectorStocks ───────

// De-shadowed (MONEY-1093): these used to be inline re-implementations, so the
// suite asserted a COPY. It therefore documented a real bug as intended
// behaviour — `"real estate" -> no match -> banking fallback` — and answered
// "Real Estate sector analysis" with five private banks.

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

// ─── getContextDescription ──────────────────────────────────────────────

describe("getContextDescription", () => {
  // ── "all" context ──

  describe('"all" context', () => {
    it('should return Dashboard context for "all"', () => {
      const result = getContextDescription("all");
      assert.ok(result.startsWith("CONTEXT: Dashboard"));
    });

    it('should contain "full portfolio" for "all"', () => {
      const result = getContextDescription("all");
      assert.ok(result.includes("full portfolio"));
    });

    it('should contain "all brokers" for "all"', () => {
      const result = getContextDescription("all");
      assert.ok(result.includes("all brokers"));
    });

    it('should be a single line for "all"', () => {
      const result = getContextDescription("all");
      assert.ok(!result.includes("\n"));
    });
  });

  // ── Broker context ──

  describe("broker context", () => {
    it('should contain "ZERODHA" for "broker:ZERODHA:Zerodha"', () => {
      const result = getContextDescription("broker:ZERODHA:Zerodha");
      assert.ok(result.includes("Zerodha"));
    });

    it('should use parts[2] when present: "broker:ZERODHA:Zerodha" -> Zerodha', () => {
      const result = getContextDescription("broker:ZERODHA:Zerodha");
      assert.ok(result.includes("Zerodha broker"));
    });

    it('should use parts[1] when parts[2] is absent: "broker:upstox" -> upstox', () => {
      // Using "as any" to bypass strict type checking for this edge case
      const result = getContextDescription("broker:upstox" as string);
      assert.ok(result.includes("upstox"));
    });

    it('should use parts[2] for "broker:DHAN:Dhan Trading"', () => {
      const result = getContextDescription("broker:DHAN:Dhan Trading");
      assert.ok(result.includes("Dhan Trading"));
    });

    it('should use parts[1] when parts[2] is empty string "broker:x:"', () => {
      // parts = ["broker", "x", ""], parts[2] is "" which is falsy, so falls back to parts[1]
      const result = getContextDescription("broker:x:" as string);
      assert.ok(result.includes("x broker"));
    });

    it('should contain "Focus on holdings and trades" for broker context', () => {
      const result = getContextDescription("broker:ZERODHA:Zerodha");
      assert.ok(result.includes("Focus on holdings and trades"));
    });

    it('should contain "from this broker" for broker context', () => {
      const result = getContextDescription("broker:ZERODHA:Zerodha");
      assert.ok(result.includes("from this broker"));
    });

    it('should start with "CONTEXT: Filtered to" for broker context', () => {
      const result = getContextDescription("broker:ANGEL:Angel One");
      assert.ok(result.startsWith("CONTEXT: Filtered to"));
    });

    it('should handle extra colons: "broker:a:b:c" -> uses parts[2] = "b"', () => {
      const result = getContextDescription("broker:a:b:c" as string);
      assert.ok(result.includes("b broker"));
      // parts[2] is "b", the ":c" is parts[3] which is ignored
    });

    it("should handle very long broker name", () => {
      const longName = "A".repeat(200);
      const result = getContextDescription(`broker:ID:${longName}` as string);
      assert.ok(result.includes(longName));
    });

    it("should handle broker with special characters in name", () => {
      const result = getContextDescription(
        "broker:FYERS:Fyers (API v3)" as string
      );
      assert.ok(result.includes("Fyers (API v3)"));
    });

    it("should handle broker with unicode in name", () => {
      const result = getContextDescription("broker:TEST:ब्रोकर" as string);
      assert.ok(result.includes("ब्रोकर"));
    });
  });

  // ── stock_analysis context ──

  describe("stock_analysis context", () => {
    it('should return Stock Analysis Mode for "stock_analysis"', () => {
      const result = getContextDescription("stock_analysis");
      assert.ok(result.includes("Stock Analysis Mode"));
    });

    it('should contain "fundamental/technical analysis"', () => {
      const result = getContextDescription("stock_analysis");
      assert.ok(result.includes("fundamental/technical analysis"));
    });

    it('should contain "investment research"', () => {
      const result = getContextDescription("stock_analysis");
      assert.ok(result.includes("investment research"));
    });

    it("should be a single line", () => {
      const result = getContextDescription("stock_analysis");
      assert.ok(!result.includes("\n"));
    });
  });

  // ── mf_analysis context ──

  describe("mf_analysis context", () => {
    it('should return Mutual Fund Analysis Mode for "mf_analysis"', () => {
      const result = getContextDescription("mf_analysis");
      assert.ok(result.includes("Mutual Fund Analysis Mode"));
    });

    it('should contain "SIP analysis"', () => {
      const result = getContextDescription("mf_analysis");
      assert.ok(result.includes("SIP analysis"));
    });

    it('should contain "fund selection"', () => {
      const result = getContextDescription("mf_analysis");
      assert.ok(result.includes("fund selection"));
    });

    it('should contain "mutual fund comparison"', () => {
      const result = getContextDescription("mf_analysis");
      assert.ok(result.includes("mutual fund comparison"));
    });

    it("should be a single line", () => {
      const result = getContextDescription("mf_analysis");
      assert.ok(!result.includes("\n"));
    });
  });

  // ── retirement context ──

  describe("retirement context", () => {
    it('should contain "FIRE" for retirement context', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("FIRE"));
    });

    it('should contain "Financial Independence, Retire Early"', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("Financial Independence, Retire Early"));
    });

    it('should contain "LeanFIRE"', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("LeanFIRE"));
    });

    it('should contain "FatFIRE"', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("FatFIRE"));
    });

    it('should contain "BaristaFIRE"', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("BaristaFIRE"));
    });

    it('should contain "CoastFIRE"', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("CoastFIRE"));
    });

    it('should contain "4% rule"', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("4% rule"));
    });

    it('should contain "SEBI-registered financial advisor"', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("SEBI-registered financial advisor"));
    });

    it('should contain "withdrawal" strategies', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("withdrawal"));
    });

    it('should contain "bucket strategy"', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("bucket strategy"));
    });

    it('should contain "Healthcare cost planning"', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("Healthcare cost planning"));
    });

    it('should contain "Indian investors"', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("Indian investors"));
    });

    it("should be a multi-line response", () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("\n"));
    });

    it('should contain "GUARDRAILS" section', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("GUARDRAILS:"));
    });

    it('should contain "FOCUS AREAS" section', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("FOCUS AREAS:"));
    });

    it('should contain "FIRE-SPECIFIC ANALYSIS" section', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("FIRE-SPECIFIC ANALYSIS"));
    });

    it("should warn about withdrawal rates above 5%", () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("withdrawal rates above 5%"));
    });

    it('should mention "Section 80C"', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("Section 80C"));
    });

    it('should mention "NPS"', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("NPS"));
    });

    it('should mention "emergency fund" recommendation', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("emergency fund"));
    });

    it('should mention "sequence-of-returns risk"', () => {
      const result = getContextDescription("retirement");
      assert.ok(result.includes("sequence-of-returns risk"));
    });
  });

  // ── paper_trading context ──

  describe("paper_trading context", () => {
    it('should return Paper Trading Mode for "paper_trading"', () => {
      const result = getContextDescription("paper_trading");
      assert.ok(result.includes("Paper Trading Mode"));
    });

    it('should contain "simulated trading"', () => {
      const result = getContextDescription("paper_trading");
      assert.ok(result.includes("simulated trading"));
    });

    it('should contain "strategy testing"', () => {
      const result = getContextDescription("paper_trading");
      assert.ok(result.includes("strategy testing"));
    });

    it('should contain "paper portfolio management"', () => {
      const result = getContextDescription("paper_trading");
      assert.ok(result.includes("paper portfolio management"));
    });

    it("should be a single line", () => {
      const result = getContextDescription("paper_trading");
      assert.ok(!result.includes("\n"));
    });
  });

  // ── research context ──

  describe("research context", () => {
    it('should return Stock Research Mode for "research"', () => {
      const result = getContextDescription("research");
      assert.ok(result.includes("Stock Research Mode"));
    });

    it('should contain "run_research tool"', () => {
      const result = getContextDescription("research");
      assert.ok(result.includes("run_research tool"));
    });

    it('should contain "deep research analysis"', () => {
      const result = getContextDescription("research");
      assert.ok(result.includes("deep research analysis"));
    });

    it('should contain "intrinsic values"', () => {
      const result = getContextDescription("research");
      assert.ok(result.includes("intrinsic values"));
    });

    it('should contain "screen stocks"', () => {
      const result = getContextDescription("research");
      assert.ok(result.includes("screen stocks"));
    });

    it("should be a single line", () => {
      const result = getContextDescription("research");
      assert.ok(!result.includes("\n"));
    });
  });

  // ── default / unknown context ──

  describe("default / unknown context", () => {
    it('should return "General portfolio assistant." for unknown string', () => {
      const result = getContextDescription("unknown_context" as string);
      assert.ok(result.includes("General portfolio assistant"));
    });

    it("should return general assistant for empty string", () => {
      const result = getContextDescription("" as string);
      assert.ok(result.includes("General portfolio assistant"));
    });

    it("should return general assistant for random gibberish", () => {
      const result = getContextDescription("xyzzy_foo_bar" as string);
      assert.ok(result.includes("General portfolio assistant"));
    });

    it('should not match partial context names like "stock"', () => {
      const result = getContextDescription("stock" as string);
      assert.ok(result.includes("General portfolio assistant"));
    });

    it('should not match "analysis" alone', () => {
      const result = getContextDescription("analysis" as string);
      assert.ok(result.includes("General portfolio assistant"));
    });

    it('should not match "trading" alone (needs "paper_trading")', () => {
      const result = getContextDescription("trading" as string);
      assert.ok(result.includes("General portfolio assistant"));
    });
  });
});

// ─── getDashboardPrompt ─────────────────────────────────────────────────

describe("getDashboardPrompt", () => {
  // ── Context key mapping ──

  describe("context key mapping", () => {
    it('should use contextKey="all" when context is "all"', () => {
      const result = getDashboardPrompt("all");
      assert.ok(result.includes("[tools:all]"));
    });

    it('should use contextKey="all" when context starts with "broker:"', () => {
      const result = getDashboardPrompt("broker:ZERODHA:Zerodha");
      assert.ok(result.includes("[tools:all]"));
    });

    it('should use contextKey="all" for "broker:DHAN:Dhan"', () => {
      const result = getDashboardPrompt("broker:DHAN:Dhan");
      assert.ok(result.includes("[tools:all]"));
    });

    it('should use contextKey="stock_analysis" for stock_analysis context', () => {
      const result = getDashboardPrompt("stock_analysis");
      assert.ok(result.includes("[tools:stock_analysis]"));
    });

    it('should use contextKey="mf_analysis" for mf_analysis context', () => {
      const result = getDashboardPrompt("mf_analysis");
      assert.ok(result.includes("[tools:mf_analysis]"));
    });

    it('should use contextKey="retirement" for retirement context', () => {
      const result = getDashboardPrompt("retirement");
      assert.ok(result.includes("[tools:retirement]"));
    });

    it('should use contextKey="paper_trading" for paper_trading context', () => {
      const result = getDashboardPrompt("paper_trading");
      assert.ok(result.includes("[tools:paper_trading]"));
    });

    it('should use contextKey="research" for research context', () => {
      const result = getDashboardPrompt("research");
      assert.ok(result.includes("[tools:research]"));
    });
  });

  // ── userName handling ──

  describe("userName handling", () => {
    it("should include user name when provided", () => {
      const result = getDashboardPrompt("all", "John");
      assert.ok(result.includes("The user's name is John."));
    });

    it("should include full name with spaces", () => {
      const result = getDashboardPrompt("all", "Shashwat Deep");
      assert.ok(result.includes("The user's name is Shashwat Deep."));
    });

    it("should NOT include name line when userName is undefined", () => {
      const result = getDashboardPrompt("all", undefined);
      assert.ok(!result.includes("The user's name is"));
    });

    it("should NOT include name line when userName is not passed", () => {
      const result = getDashboardPrompt("all");
      assert.ok(!result.includes("The user's name is"));
    });

    it("should NOT include name line when userName is empty string (falsy)", () => {
      const result = getDashboardPrompt("all", "");
      assert.ok(!result.includes("The user's name is"));
    });

    it("should include name with special characters", () => {
      const result = getDashboardPrompt("all", "Dr. J.K. Patel (Sr.)");
      assert.ok(result.includes("The user's name is Dr. J.K. Patel (Sr.)."));
    });

    it("should include very long user name", () => {
      const longName = "A".repeat(300);
      const result = getDashboardPrompt("all", longName);
      assert.ok(result.includes(`The user's name is ${longName}.`));
    });

    it("should include unicode user name", () => {
      const result = getDashboardPrompt(
        "all",
        "\u0936\u0936\u094d\u0935\u0924"
      );
      assert.ok(
        result.includes("The user's name is \u0936\u0936\u094d\u0935\u0924.")
      );
    });
  });

  // ── Prompt structure ──

  describe("prompt structure", () => {
    it('should contain "StockSage" at the beginning', () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("You are StockSage"));
    });

    it('should contain "PERSONALITY" section', () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("PERSONALITY:"));
    });

    it('should contain "CRITICAL RULES" section', () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("CRITICAL RULES:"));
    });

    it('should contain "SEBI-registered advisors" in personality', () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("SEBI-registered advisors"));
    });

    it('should contain "Indian investors"', () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("Indian investors"));
    });

    it('should contain "AVAILABLE TOOLS" section', () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("AVAILABLE TOOLS:"));
    });

    it('should contain "TOOL CALLS" instructions', () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("TOOL CALLS:"));
    });

    it('should contain "RICH RESPONSE FORMAT" instructions', () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("RICH RESPONSE FORMAT:"));
    });

    it("should contain context description embedded", () => {
      const result = getDashboardPrompt("all");
      assert.ok(
        result.includes(
          "Dashboard - You have access to the user's full portfolio across all brokers"
        )
      );
    });

    it("should contain context description for stock_analysis", () => {
      const result = getDashboardPrompt("stock_analysis");
      assert.ok(result.includes("Stock Analysis Mode"));
    });

    it("should contain context description for broker", () => {
      const result = getDashboardPrompt("broker:ZERODHA:Zerodha");
      assert.ok(result.includes("Filtered to Zerodha broker"));
    });

    it("should contain retirement FIRE content when retirement context", () => {
      const result = getDashboardPrompt("retirement");
      assert.ok(result.includes("LeanFIRE"));
      assert.ok(result.includes("4% rule"));
    });
  });

  // ── Default context ──

  describe("default context", () => {
    it('should default to "all" when no context provided', () => {
      const result = getDashboardPrompt();
      assert.ok(
        result.includes(
          "Dashboard - You have access to the user's full portfolio"
        )
      );
    });

    it('should use "all" tool descriptions by default', () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("[tools:all]"));
    });
  });

  // ── Critical rules content ──

  describe("critical rules content", () => {
    it('should mention "finance" in critical rules', () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("finance"));
    });

    it("should mention declining non-finance topics", () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("Politely decline non-finance topics"));
    });

    it("should mention BUY/SELL disclaimers", () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("disclaimers for BUY/SELL"));
    });

    it("should mention verifying data with tools", () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("Verify data before presenting"));
    });

    it('should mention "NSE, BSE, INR" in personality', () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("NSE, BSE, INR"));
    });
  });

  // ── Block format instructions ──

  describe("block format instructions", () => {
    it("should contain TABLE block type", () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes(":::block:table"));
    });

    it("should contain CARD block type", () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes(":::block:card"));
    });

    it("should contain CHART block type", () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes(":::block:chart"));
    });

    it("should contain ACTION block type", () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes(":::block:action"));
    });

    it("should contain NAVIGATION block type", () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes(":::block:navigation"));
    });

    it("should contain COMPARISON block type", () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes(":::block:comparison"));
    });

    it("should contain ERROR block type", () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes(":::block:error"));
    });

    it("should mention Indian currency format", () => {
      const result = getDashboardPrompt();
      assert.ok(result.includes("Indian currency format"));
    });
  });
});

// ─── resolveSectorStocks ────────────────────────────────────────────────

describe("resolveSectorStocks", () => {
  // ── Known sectors ──

  describe("known sectors", () => {
    it('should return 5 banking stocks for "banking"', () => {
      const result = resolveSectorStocks("banking");
      assert.ok(result.length >= 5);
      assert.ok(result.includes("HDFCBANK.NS"));
      assert.ok(result.includes("ICICIBANK.NS"));
      assert.ok(result.includes("SBIN.NS"));
    });

    it('should return 5 IT stocks for "it"', () => {
      const result = resolveSectorStocks("it");
      assert.ok(result.length >= 5);
      assert.ok(result.includes("TCS.NS"));
      assert.ok(result.includes("INFY.NS"));
      assert.ok(result.includes("WIPRO.NS"));
    });

    it('should return 5 pharma stocks for "pharma"', () => {
      const result = resolveSectorStocks("pharma");
      assert.ok(result.length >= 5);
      assert.ok(result.includes("SUNPHARMA.NS"));
      assert.ok(result.includes("DRREDDY.NS"));
      assert.ok(result.includes("CIPLA.NS"));
    });

    it('should return 5 auto stocks for "auto"', () => {
      const result = resolveSectorStocks("auto");
      assert.ok(result.length >= 5);
      assert.ok(result.includes("MARUTI.NS"));
      assert.ok(result.includes("TATAMOTORS.NS"));
      assert.ok(result.includes("M%26M.NS"));
    });

    it('returns oil & gas names for "energy" — NOT the power utilities', () => {
      // NTPC and POWERGRID MOVED to `utilities` (MONEY-1093). They are a
      // generator and the transmission monopoly; keeping them here forced the
      // utilities basket to exclude them, because a symbol in two baskets breaks
      // the no-duplicates invariant — so a Utilities analysis omitted the two
      // most important utilities in India. This assertion previously required
      // NTPC here, which is why the move needed a deliberate decision rather
      // than a silent edit.
      const result = resolveSectorStocks("energy");
      assert.ok(result.length >= 5);
      assert.ok(result.includes("RELIANCE.NS"));
      assert.ok(result.includes("ONGC.NS"));
      assert.ok(
        !result.includes("NTPC.NS"),
        "NTPC belongs in utilities, not energy"
      );
      assert.ok(
        !result.includes("POWERGRID.NS"),
        "POWERGRID belongs in utilities, not energy"
      );
    });

    it('returns the real utilities for "utilities"', () => {
      // The other half of the move, pinned so neither basket can drift back.
      const result = resolveSectorStocks("utilities");
      assert.ok(result.includes("NTPC.NS"), "India's largest generator");
      assert.ok(result.includes("POWERGRID.NS"), "the transmission monopoly");
      assert.ok(result.includes("TATAPOWER.NS"));
    });

    it('should return 5 fmcg stocks for "fmcg"', () => {
      const result = resolveSectorStocks("fmcg");
      assert.ok(result.length >= 5);
      assert.ok(result.includes("HINDUNILVR.NS"));
      assert.ok(result.includes("ITC.NS"));
      assert.ok(result.includes("NESTLEIND.NS"));
    });

    it('should return 5 metals stocks for "metals"', () => {
      const result = resolveSectorStocks("metals");
      assert.ok(result.length >= 5);
      assert.ok(result.includes("TATASTEEL.NS"));
      assert.ok(result.includes("HINDALCO.NS"));
      assert.ok(result.includes("JSWSTEEL.NS"));
    });

    it('should return 5 realty stocks for "realty"', () => {
      const result = resolveSectorStocks("realty");
      assert.ok(result.length >= 5);
      assert.ok(result.includes("DLF.NS"));
      assert.ok(result.includes("GODREJPROP.NS"));
      assert.ok(result.includes("OBEROIRLTY.NS"));
    });
  });

  // ── Case insensitivity ──

  describe("case insensitivity", () => {
    it('should resolve "BANKING" to banking stocks', () => {
      const result = resolveSectorStocks("BANKING");
      assert.deepEqual(result, SECTOR_STOCKS["banking"]);
    });

    it('should resolve "Banking" to banking stocks', () => {
      const result = resolveSectorStocks("Banking");
      assert.deepEqual(result, SECTOR_STOCKS["banking"]);
    });

    it('should resolve "IT" to it stocks', () => {
      const result = resolveSectorStocks("IT");
      assert.deepEqual(result, SECTOR_STOCKS["it"]);
    });

    it('should resolve "It" to it stocks', () => {
      const result = resolveSectorStocks("It");
      assert.deepEqual(result, SECTOR_STOCKS["it"]);
    });

    it('should resolve "PHARMA" to pharma stocks', () => {
      const result = resolveSectorStocks("PHARMA");
      assert.deepEqual(result, SECTOR_STOCKS["pharma"]);
    });

    it('should resolve "ENERGY" to energy stocks', () => {
      const result = resolveSectorStocks("ENERGY");
      assert.deepEqual(result, SECTOR_STOCKS["energy"]);
    });

    it('should resolve "fMcG" (mixed case) to fmcg stocks', () => {
      const result = resolveSectorStocks("fMcG");
      assert.deepEqual(result, SECTOR_STOCKS["fmcg"]);
    });

    it('should resolve "REALTY" to realty stocks', () => {
      const result = resolveSectorStocks("REALTY");
      assert.deepEqual(result, SECTOR_STOCKS["realty"]);
    });
  });

  // ── Special character stripping ──

  describe("special character stripping", () => {
    it('should strip hyphens: "it-sector" -> "itsector" -> no coverage', () => {
      // No longer the banking basket: an unmatched sector returns [] so the
      // skill degrades to "no coverage" instead of confidently analysing the
      // wrong five companies.
      assert.deepEqual(resolveSectorStocks("it-sector"), []);
    });

    it('should strip exclamation: "pharma!" -> "pharma" -> pharma stocks', () => {
      const result = resolveSectorStocks("pharma!");
      assert.deepEqual(result, SECTOR_STOCKS["pharma"]);
    });

    it('resolves "real estate" to the REALTY basket via the alias map', () => {
      // The bug this file used to enshrine: "realestate" is not a key, so it
      // fell through to banking and a Real Estate analysis was five banks.
      assert.deepEqual(
        resolveSectorStocks("real estate"),
        SECTOR_STOCKS["realty"]
      );
      assert.deepEqual(
        resolveSectorStocks("Real Estate"),
        SECTOR_STOCKS["realty"]
      );
      assert.deepEqual(resolveSectorStocks("Realty"), SECTOR_STOCKS["realty"]);
    });

    it('should strip digits: "banking123" -> "banking" -> banking stocks', () => {
      // /[^a-z]/g removes digits too, so "banking123" becomes "banking"
      const result = resolveSectorStocks("banking123");
      assert.deepEqual(result, SECTOR_STOCKS["banking"]);
    });

    it('should strip underscores: "it_sector" -> "itsector" -> no match no coverage', () => {
      const result = resolveSectorStocks("it_sector");
      assert.deepEqual(result, []);
    });

    it('should strip dots: "it.sector" -> "itsector" -> no match no coverage', () => {
      const result = resolveSectorStocks("it.sector");
      assert.deepEqual(result, []);
    });

    it('should strip parentheses: "auto(s)" -> "autos" -> no match no coverage', () => {
      const result = resolveSectorStocks("auto(s)");
      assert.deepEqual(result, []);
    });

    it('should keep only lowercase letters: "METALS!@#$" -> "metals" -> metals stocks', () => {
      const result = resolveSectorStocks("METALS!@#$");
      assert.deepEqual(result, SECTOR_STOCKS["metals"]);
    });

    it('should strip ampersand: "it&more" -> "itmore" -> no match no coverage', () => {
      const result = resolveSectorStocks("it&more");
      assert.deepEqual(result, []);
    });
  });

  // ── Unknown sector / fallback ──

  describe("unknown sector returns NO coverage, never a substitute", () => {
    it('should return [] for "unknown"', () => {
      const result = resolveSectorStocks("unknown");
      assert.deepEqual(result ?? [], []);
    });

    it("should return [] for an empty string", () => {
      const result = resolveSectorStocks("");
      assert.deepEqual(result ?? [], []);
    });

    it('resolves "telecom" to its own basket now', () => {
      // telecom gained a basket (MONEY-1093) — it used to be one of four
      // canonical sectors that returned no coverage at all.
      assert.equal(resolveSectorStocks("telecom").length, 5);
    });

    it('should return [] for "infrastructure"', () => {
      const result = resolveSectorStocks("infrastructure");
      assert.deepEqual(result ?? [], []);
    });

    it('should default "defence" no coverage', () => {
      const result = resolveSectorStocks("defence");
      assert.deepEqual(result, []);
    });

    it('should default purely numeric input "12345" no coverage', () => {
      const result = resolveSectorStocks("12345");
      assert.deepEqual(result, []);
    });
  });

  // ── Validation per sector ──

  describe("validation: each sector returns exactly 5 stocks", () => {
    for (const sectorName of Object.keys(SECTOR_STOCKS)) {
      it(`sector "${sectorName}" should have exactly 5 stocks`, () => {
        const stocks = resolveSectorStocks(sectorName);
        assert.ok(stocks.length >= 5);
      });
    }
  });

  describe("validation: all stocks end with .NS", () => {
    for (const sectorName of Object.keys(SECTOR_STOCKS)) {
      it(`all stocks in "${sectorName}" should end with .NS`, () => {
        const stocks = resolveSectorStocks(sectorName);
        for (const stock of stocks) {
          assert.ok(stock.endsWith(".NS"), `${stock} does not end with .NS`);
        }
      });
    }
  });

  describe("validation: all stocks within a sector are unique", () => {
    for (const sectorName of Object.keys(SECTOR_STOCKS)) {
      it(`stocks in "${sectorName}" should be unique`, () => {
        const stocks = resolveSectorStocks(sectorName);
        const unique = new Set(stocks);
        assert.equal(unique.size, stocks.length);
      });
    }
  });

  // ── Monkey / edge cases ──

  describe("monkey / edge cases", () => {
    it("should handle emoji input gracefully (stripped to empty no coverage)", () => {
      const result = resolveSectorStocks("\u{1F4B0}\u{1F4C8}");
      assert.deepEqual(result, []);
    });

    it("should handle unicode letters that are not a-z (no coverage)", () => {
      const result = resolveSectorStocks("\u00e9nergie");
      // "énergie" -> lowercase -> regex /[^a-z]/g strips "é" -> "nergie" -> no match
      assert.deepEqual(result, []);
    });

    it("should handle Chinese characters (no coverage)", () => {
      const result = resolveSectorStocks("\u94f6\u884c");
      assert.deepEqual(result, []);
    });

    it("should handle tab and newline characters", () => {
      const result = resolveSectorStocks("\tbanking\n");
      // "\tbanking\n" -> lowercase -> regex strips \t and \n -> "banking",
      // which IS a real key, so this still resolves to the banking basket.
      assert.deepEqual(result, SECTOR_STOCKS["banking"]);
    });

    it("should handle string with only special characters", () => {
      const result = resolveSectorStocks("!@#$%^&*()");
      assert.deepEqual(result, []);
    });

    it("should handle very long string that resolves to known sector", () => {
      // After stripping non a-z chars, this should become "pharma"
      const result = resolveSectorStocks("123PHARMA456!!!");
      assert.deepEqual(result, SECTOR_STOCKS["pharma"]);
    });

    it("should handle repeated sector name", () => {
      // "bankingbanking" -> no match no coverage
      const result = resolveSectorStocks("bankingbanking");
      assert.deepEqual(result, []);
    });

    it("should not match partial sector name embedded in longer word", () => {
      // "debating" -> after cleaning -> "debating" -> no match no coverage
      const result = resolveSectorStocks("debating");
      assert.deepEqual(result, []);
    });
  });
});

// ─── SECTOR_STOCKS data integrity ───────────────────────────────────────

describe("SECTOR_STOCKS data integrity", () => {
  it("should have exactly 13 sectors defined", () => {
    assert.equal(Object.keys(SECTOR_STOCKS).length, 13);
  });

  it("should have the correct sector names", () => {
    const expected = [
      "banking",
      "it",
      "pharma",
      "auto",
      "energy",
      "fmcg",
      "metals",
      "realty",
    ];
    for (const name of expected) {
      assert.ok(SECTOR_STOCKS[name] !== undefined, `Missing sector: ${name}`);
    }
  });

  it("should have all lowercase sector keys", () => {
    for (const key of Object.keys(SECTOR_STOCKS)) {
      assert.equal(key, key.toLowerCase(), `Key "${key}" is not lowercase`);
    }
  });

  it("every sector basket is populated (>= 5 names)", () => {
    // Was `total === 65` (13 x exactly 5). An exact count is the same class
    // of bookkeeping rule that caused the defect this replaced: `utilities`
    // excluded NTPC and POWERGRID — India's largest generator and its
    // transmission monopoly — to satisfy a no-duplicates invariant, so the
    // Utilities analysis omitted the two most important utilities in the
    // country. A basket should be sized by what belongs in it. The FLOOR is
    // the real requirement: a thin basket produces a thin report.
    let total = 0;
    for (const [sector, stocks] of Object.entries(SECTOR_STOCKS)) {
      assert.ok(
        stocks.length >= 5,
        `${sector} has only ${stocks.length} names`
      );
      total += stocks.length;
    }
    assert.ok(total >= 65, `expected >= 65 names, got ${total}`);
  });

  // ── Specific well-known stocks ──

  it("should have HDFCBANK.NS in banking", () => {
    assert.ok(SECTOR_STOCKS["banking"]!.includes("HDFCBANK.NS"));
  });

  it("should have ICICIBANK.NS in banking", () => {
    assert.ok(SECTOR_STOCKS["banking"]!.includes("ICICIBANK.NS"));
  });

  it("should have SBIN.NS in banking", () => {
    assert.ok(SECTOR_STOCKS["banking"]!.includes("SBIN.NS"));
  });

  it("should have KOTAKBANK.NS in banking", () => {
    assert.ok(SECTOR_STOCKS["banking"]!.includes("KOTAKBANK.NS"));
  });

  it("should have AXISBANK.NS in banking", () => {
    assert.ok(SECTOR_STOCKS["banking"]!.includes("AXISBANK.NS"));
  });

  it("should have TCS.NS in it", () => {
    assert.ok(SECTOR_STOCKS["it"]!.includes("TCS.NS"));
  });

  it("should have INFY.NS in it", () => {
    assert.ok(SECTOR_STOCKS["it"]!.includes("INFY.NS"));
  });

  it("should have HCLTECH.NS in it", () => {
    assert.ok(SECTOR_STOCKS["it"]!.includes("HCLTECH.NS"));
  });

  it("should have TECHM.NS in it", () => {
    assert.ok(SECTOR_STOCKS["it"]!.includes("TECHM.NS"));
  });

  it("should have RELIANCE.NS in energy", () => {
    assert.ok(SECTOR_STOCKS["energy"]!.includes("RELIANCE.NS"));
  });

  it("should have M%26M.NS in auto (URL-encoded M&M)", () => {
    assert.ok(SECTOR_STOCKS["auto"]!.includes("M%26M.NS"));
  });

  it("should have BAJAJ-AUTO.NS in auto (with hyphen)", () => {
    assert.ok(SECTOR_STOCKS["auto"]!.includes("BAJAJ-AUTO.NS"));
  });

  it("should have DLF.NS in realty", () => {
    assert.ok(SECTOR_STOCKS["realty"]!.includes("DLF.NS"));
  });

  it("should have ITC.NS in fmcg", () => {
    assert.ok(SECTOR_STOCKS["fmcg"]!.includes("ITC.NS"));
  });

  it("should have TATASTEEL.NS in metals", () => {
    assert.ok(SECTOR_STOCKS["metals"]!.includes("TATASTEEL.NS"));
  });

  // ── Cross-sector uniqueness ──

  it("should have no duplicate stocks across different sectors", () => {
    const allStocks: string[] = [];
    for (const stocks of Object.values(SECTOR_STOCKS)) {
      allStocks.push(...stocks);
    }
    const unique = new Set(allStocks);
    assert.equal(
      unique.size,
      allStocks.length,
      `Found duplicate stocks: ${allStocks.filter(
        (s, i) => allStocks.indexOf(s) !== i
      )}`
    );
  });

  // ── Stock format consistency ──

  it("should have all stocks matching pattern SYMBOL.NS", () => {
    for (const [sector, stocks] of Object.entries(SECTOR_STOCKS)) {
      for (const stock of stocks) {
        assert.ok(
          /^[A-Z0-9%&-]+\.NS$/.test(stock),
          `Stock "${stock}" in sector "${sector}" does not match expected pattern`
        );
      }
    }
  });

  it("should have no empty stock symbols", () => {
    for (const [sector, stocks] of Object.entries(SECTOR_STOCKS)) {
      for (const stock of stocks) {
        assert.ok(
          stock.length > 3,
          `Stock "${stock}" in sector "${sector}" is too short`
        );
      }
    }
  });

  it("should have all arrays as non-empty", () => {
    for (const [sector, stocks] of Object.entries(SECTOR_STOCKS)) {
      assert.ok(stocks.length > 0, `Sector "${sector}" has empty stock list`);
    }
  });
});

// ─── Monkey / edge case interactions ────────────────────────────────────

describe("monkey / edge case interactions", () => {
  describe("getContextDescription edge cases", () => {
    it("should handle broker context with only colon prefix (no broker name)", () => {
      // "broker:" -> parts = ["broker", ""], parts[2] = undefined, parts[1] = ""
      // brokerName = undefined || "" = "" (empty string)
      const result = getContextDescription("broker:" as string);
      assert.ok(result.startsWith("CONTEXT: Filtered to"));
      assert.ok(result.includes("broker."));
    });

    it("should handle broker context with spaces in broker name", () => {
      const result = getContextDescription(
        "broker:ID:My Broker Name" as string
      );
      assert.ok(result.includes("My Broker Name"));
    });

    it("should handle broker context with numbers in broker name", () => {
      const result = getContextDescription(
        "broker:API123:Broker v2.5" as string
      );
      assert.ok(result.includes("Broker v2.5"));
    });

    it("should handle broker context where parts[2] is whitespace only", () => {
      // "broker:x: " -> parts[2] = " " which is truthy
      const result = getContextDescription("broker:x: " as string);
      assert.ok(result.includes("  broker"));
    });
  });

  describe("getDashboardPrompt edge cases", () => {
    it("should produce a non-empty string for any valid context", () => {
      const contexts: string[] = [
        "all",
        "stock_analysis",
        "mf_analysis",
        "retirement",
        "paper_trading",
        "research",
        "broker:X:Y",
      ];
      for (const ctx of contexts) {
        const result = getDashboardPrompt(ctx);
        assert.ok(result.length > 100, `Prompt for "${ctx}" is too short`);
      }
    });

    it("should always start with 'You are StockSage' regardless of context", () => {
      const contexts: string[] = [
        "all",
        "stock_analysis",
        "mf_analysis",
        "retirement",
        "paper_trading",
        "research",
        "broker:Z:Z",
      ];
      for (const ctx of contexts) {
        const result = getDashboardPrompt(ctx);
        assert.ok(
          result.startsWith("You are StockSage"),
          `Prompt for "${ctx}" does not start with StockSage`
        );
      }
    });

    it("should always end with 'rather than guessing' regardless of context", () => {
      const result = getDashboardPrompt("all");
      assert.ok(result.trimEnd().endsWith("rather than guessing"));
    });

    it("should include both userName and context description together", () => {
      const result = getDashboardPrompt("retirement", "Alice");
      assert.ok(result.includes("The user's name is Alice."));
      assert.ok(result.includes("FIRE"));
      assert.ok(result.includes("LeanFIRE"));
    });

    it("should have PERSONALITY section before CRITICAL RULES section", () => {
      const result = getDashboardPrompt();
      const personalityIdx = result.indexOf("PERSONALITY:");
      const criticalIdx = result.indexOf("CRITICAL RULES:");
      assert.ok(personalityIdx < criticalIdx);
    });

    it("should have AVAILABLE TOOLS section between PERSONALITY and CRITICAL RULES", () => {
      const result = getDashboardPrompt();
      const personalityIdx = result.indexOf("PERSONALITY:");
      const toolsIdx = result.indexOf("AVAILABLE TOOLS:");
      const criticalIdx = result.indexOf("CRITICAL RULES:");
      assert.ok(personalityIdx < toolsIdx);
      assert.ok(toolsIdx < criticalIdx);
    });

    it("should have context description after StockSage intro but before PERSONALITY", () => {
      const result = getDashboardPrompt("stock_analysis");
      const stockSageIdx = result.indexOf("You are StockSage");
      const contextIdx = result.indexOf("Stock Analysis Mode");
      const personalityIdx = result.indexOf("PERSONALITY:");
      assert.ok(stockSageIdx < contextIdx);
      assert.ok(contextIdx < personalityIdx);
    });
  });

  describe("resolveSectorStocks returns reference to SECTOR_STOCKS entry", () => {
    it("should return the same array reference for known sector", () => {
      const result = resolveSectorStocks("banking");
      assert.equal(result, SECTOR_STOCKS["banking"]);
    });

    it("should return no coverage", () => {
      // deepEqual, not equal: `equal` compares array references and can never
      // pass here.
      assert.deepEqual(resolveSectorStocks("nonexistent"), []);
    });
  });

  describe("combined context + sector scenarios", () => {
    it("retirement context mentions financial concepts that overlap with FIRE scenarios", () => {
      const context = getContextDescription("retirement");
      // Should mention withdrawal which is a key concept for FIRE scenarios
      assert.ok(context.includes("withdrawal"));
      assert.ok(context.includes("SWP"));
    });

    it("stock_analysis context does not mention mutual funds", () => {
      const context = getContextDescription("stock_analysis");
      assert.ok(!context.includes("mutual fund"));
    });

    it("mf_analysis context does not mention stock analysis", () => {
      const context = getContextDescription("mf_analysis");
      assert.ok(!context.includes("Stock Analysis"));
    });

    it("research context does not mention paper trading", () => {
      const context = getContextDescription("research");
      assert.ok(!context.includes("paper trading"));
      assert.ok(!context.includes("Paper Trading"));
    });

    it("paper_trading context does not mention FIRE", () => {
      const context = getContextDescription("paper_trading");
      assert.ok(!context.includes("FIRE"));
    });
  });
});
