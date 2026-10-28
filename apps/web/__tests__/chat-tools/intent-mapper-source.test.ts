/**
 * MONEY-393 §26 - lib/chat-tools/intent-mapper.ts source coverage push
 * (43.4% → 90%+).
 *
 * Existing intent-mapper.test.ts (98 cases) is an INLINE reimplementation
 * - it doesn't import the actual source, so c8 sees 0% on the real file.
 *
 * This file imports the REAL exports and walks the branches:
 *
 * Fast path (synchronous, regex-based):
 *   - classifyIntentFast: portfolio roast, holdings/positions/trades,
 *     FIRE, MFs, broker-filtered queries, fall-through to null
 *
 * Pure helpers:
 *   - parseToolCalls: TOOL_CALL JSON parser
 *   - removeToolCallMarkers: marker stripper
 *
 * Flash path (async, LLM-backed):
 *   - classifyIntentWithFlash: with a stubbed Gemini client returning
 *     canned JSON, exercises the intent → tool dispatch table and the
 *     parameter-massaging logic per intent (deep_research, comparison,
 *     screener, news, portfolio_roast with broker detection, unclear,
 *     general_chat, error fallback)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyIntentFast,
  parseToolCalls,
  removeToolCallMarkers,
  classifyIntentWithFlash,
} from "../../lib/chat-tools/intent-mapper";

// ── classifyIntentFast ─────────────────────────────────────────

describe("MONEY-393 §26 - classifyIntentFast (real source)", () => {
  it("[fast] 'roast my portfolio' → start_roast tool", () => {
    const result = classifyIntentFast("roast my portfolio");
    assert.ok(result, "fast path must match roast intent");
    assert.equal(result!.tool, "start_roast");
    const p = result!.params as Record<string, unknown>;
    assert.equal(p.mode, "overall");
    assert.equal(p.assetType, "all");
  });

  it("[fast] roast with broker name → mode:'broker' + broker code", () => {
    const result = classifyIntentFast("roast my zerodha portfolio");
    assert.ok(result);
    const p = result!.params as Record<string, unknown>;
    assert.equal(p.mode, "broker");
    assert.equal(p.broker, "ZERODHA");
  });

  it("[fast] roast with 'mutual fund' phrase → assetType:'mf'", () => {
    const result = classifyIntentFast("roast my mutual fund portfolio");
    assert.ok(result);
    const p = result!.params as Record<string, unknown>;
    assert.equal(p.assetType, "mf");
  });

  it("[fast] roast with 'stocks' phrase → assetType:'stocks'", () => {
    const result = classifyIntentFast("roast my stocks holdings");
    assert.ok(result);
    const p = result!.params as Record<string, unknown>;
    assert.equal(p.assetType, "stocks");
  });

  it("[fast] 'rate my portfolio' → start_roast (alternate pattern)", () => {
    const result = classifyIntentFast("rate my portfolio");
    assert.ok(result);
    assert.equal(result!.tool, "start_roast");
  });

  it("[fast] 'show my holdings' → get_holdings", () => {
    const result = classifyIntentFast("show my holdings");
    assert.ok(result);
    assert.equal(result!.tool, "get_holdings");
  });

  it("[fast] 'list my positions' → get_positions", () => {
    const result = classifyIntentFast("list my positions");
    assert.ok(result);
    assert.equal(result!.tool, "get_positions");
  });

  it("[fast] 'show my recent trades' → get_trades", () => {
    const result = classifyIntentFast("show my recent trades");
    assert.ok(result);
    assert.equal(result!.tool, "get_trades");
  });

  it("[fast] broker-filtered holdings: 'zerodha holdings' → broker param", () => {
    const result = classifyIntentFast("zerodha holdings");
    assert.ok(result);
    assert.equal(result!.tool, "get_holdings");
    const p = result!.params as Record<string, unknown>;
    assert.equal(p.broker, "ZERODHA");
  });

  it("[fast] analytical queries → null (defers to Flash)", () => {
    assert.equal(
      classifyIntentFast("analyse RELIANCE"),
      null,
      "research-style → null (Flash handles)"
    );
    assert.equal(
      classifyIntentFast("compare TCS vs INFY"),
      null,
      "comparison → null"
    );
    assert.equal(
      classifyIntentFast("find stocks with PE < 15"),
      null,
      "screener → null"
    );
  });

  it("[fast] confidence is between 0.5 and 1", () => {
    const result = classifyIntentFast("show my holdings");
    assert.ok(result);
    assert.ok(result!.confidence > 0 && result!.confidence <= 1);
  });
});

// ── MONEY-587: market/screener guards win over portfolio/holdings ──
// Regression: "market overview" collapsed to get_portfolio_summary (the
// "overview" keyword) and "stocks similar to my … holdings" collapsed to
// get_holdings (the "my … holdings" keyword). These guards must fire
// BEFORE the cheap portfolio/holdings fast-paths.

describe("MONEY-587 - market/macro fast-path guard", () => {
  it("routes the full market-overview prompt to run_research (not portfolio)", () => {
    const result = classifyIntentFast(
      "Market overview - how are Nifty 50, Sensex, Bank Nifty doing today, sector heatmap, FII/DII, gainers/losers"
    );
    assert.ok(result, "market overview must match a fast-path guard");
    assert.equal(result!.tool, "run_research");
    const p = result!.params as Record<string, unknown>;
    assert.equal(p.skill, "macro-analysis");
    assert.equal(p.mode, "advanced");
    assert.ok(
      typeof p.query === "string" && (p.query as string).length > 0,
      "run_research fast-path forwards the raw query"
    );
  });

  it("'market overview' alone → run_research, not get_portfolio_summary", () => {
    const result = classifyIntentFast("market overview");
    assert.ok(result);
    assert.equal(result!.tool, "run_research");
  });

  it("'how is the market today' → run_research", () => {
    const result = classifyIntentFast("how is the market today");
    assert.ok(result);
    assert.equal(result!.tool, "run_research");
  });

  it("'top gainers and losers' → run_research", () => {
    const result = classifyIntentFast("show me top gainers and losers");
    assert.ok(result);
    assert.equal(result!.tool, "run_research");
  });

  it("'sector heatmap' → run_research", () => {
    const result = classifyIntentFast("sector heatmap");
    assert.ok(result);
    assert.equal(result!.tool, "run_research");
  });

  it("two indices listed together → run_research", () => {
    const result = classifyIntentFast("what's happening in nifty and sensex");
    assert.ok(result);
    assert.equal(result!.tool, "run_research");
  });

  it("bare 'overview' still routes to get_portfolio_summary (no regression)", () => {
    const result = classifyIntentFast("What's the overview?");
    assert.ok(result);
    assert.equal(result!.tool, "get_portfolio_summary");
  });

  it("single index vs a stock stays a comparison (defers to Flash, not market)", () => {
    // "compare 360ONE vs NIFTY50" must NOT be hijacked by the market guard;
    // a single index name alone never triggers it.
    const result = classifyIntentFast("Please compare 360ONE vs NIFTY50");
    assert.equal(result, null, "single-index comparison defers to Flash");
  });
});

describe("MONEY-587 - screener fast-path guard", () => {
  it("'Screen for stocks similar to my top holdings…' → run_screener (not holdings)", () => {
    const result = classifyIntentFast(
      "Screen for stocks similar to my top holdings - same sector and fundamentals"
    );
    assert.ok(result, "screener phrasing must match a fast-path guard");
    assert.equal(result!.tool, "run_screener");
    const p = result!.params as Record<string, unknown>;
    assert.ok(
      typeof p.query === "string" && (p.query as string).length > 0,
      "run_screener fast-path forwards the raw query for NL parsing"
    );
  });

  it("'stocks similar to my portfolio' → run_screener", () => {
    const result = classifyIntentFast("show me stocks similar to my portfolio");
    assert.ok(result);
    assert.equal(result!.tool, "run_screener");
  });

  it("'screen for undervalued largecaps' → run_screener", () => {
    const result = classifyIntentFast("screen for undervalued largecaps");
    assert.ok(result);
    assert.equal(result!.tool, "run_screener");
  });

  it("generic 'find stocks with PE < 15' still defers to Flash (no widening)", () => {
    const result = classifyIntentFast("find stocks with PE < 15");
    assert.equal(result, null, "generic find-stocks-with defers to Flash");
  });

  it("'show my holdings' still routes to get_holdings (no regression)", () => {
    const result = classifyIntentFast("show my holdings");
    assert.ok(result);
    assert.equal(result!.tool, "get_holdings");
  });
});

// ── parseToolCalls + removeToolCallMarkers ─────────────────────

describe("MONEY-393 §26 - parseToolCalls + removeToolCallMarkers", () => {
  it("[parseToolCalls] extracts a single TOOL_CALL JSON block", () => {
    const text = `Sure, let me check.
TOOL_CALL: {"tool": "get_holdings", "params": {}}
Here are your holdings.`;
    const results = parseToolCalls(text);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.tool, "get_holdings");
  });

  it("[parseToolCalls] extracts multiple TOOL_CALL blocks", () => {
    const text = `TOOL_CALL: {"tool": "get_holdings", "params": {}}
TOOL_CALL: {"tool": "get_positions", "params": {"status": "OPEN"}}`;
    const results = parseToolCalls(text);
    assert.equal(results.length, 2);
    assert.equal(results[0]!.tool, "get_holdings");
    assert.equal(results[1]!.tool, "get_positions");
    assert.equal(
      (results[1]!.params as Record<string, unknown>).status,
      "OPEN"
    );
  });

  it("[parseToolCalls] skips invalid JSON without throwing", () => {
    const text = `TOOL_CALL: {invalid json here}
TOOL_CALL: {"tool": "get_holdings", "params": {}}`;
    const results = parseToolCalls(text);
    assert.equal(
      results.length,
      1,
      "first call is invalid JSON, second parses fine"
    );
  });

  it("[parseToolCalls] handles nested params object (one level)", () => {
    const text = `TOOL_CALL: {"tool": "get_trades", "params": {"filter": "type"}}`;
    const results = parseToolCalls(text);
    assert.equal(results.length, 1);
    assert.equal(
      (results[0]!.params as Record<string, unknown>).filter,
      "type"
    );
  });

  it("[parseToolCalls] returns [] when no TOOL_CALL markers", () => {
    assert.deepEqual(parseToolCalls("plain text response"), []);
  });

  it("[parseToolCalls] skips entries without a tool field", () => {
    const text = `TOOL_CALL: {"params": {}}`;
    const results = parseToolCalls(text);
    assert.equal(results.length, 0, "entry without .tool must be skipped");
  });

  it("[parseToolCalls] confidence is 0.9 for parsed calls", () => {
    const text = `TOOL_CALL: {"tool": "x"}`;
    const results = parseToolCalls(text);
    assert.equal(results[0]!.confidence, 0.9);
  });

  it("[removeToolCallMarkers] strips a single TOOL_CALL block", () => {
    const text = `Hello!
TOOL_CALL: {"tool": "get_holdings"}
World!`;
    const cleaned = removeToolCallMarkers(text);
    assert.ok(!cleaned.includes("TOOL_CALL"));
    assert.ok(cleaned.includes("Hello!"));
    assert.ok(cleaned.includes("World!"));
  });

  it("[removeToolCallMarkers] strips multiple blocks and trims whitespace", () => {
    const text = `   TOOL_CALL: {"tool": "x"} TOOL_CALL: {"tool": "y"}   `;
    const cleaned = removeToolCallMarkers(text);
    assert.ok(!cleaned.includes("TOOL_CALL"));
  });

  it("[removeToolCallMarkers] leaves plain text untouched", () => {
    const cleaned = removeToolCallMarkers("just text, no markers");
    assert.equal(cleaned, "just text, no markers");
  });
});

// ── classifyIntentWithFlash (stubbed Gemini) ───────────────────
//
// The intent-mapper uses `await import("@/lib/gemini/client")` inside
// the function. tsx caches the resolved ESM module promise at first
// call, so swapping require.cache entries between tests does NOT
// invalidate it. Workaround: install ONE shared stub at module load
// (via require.cache before importing intent-mapper), and let each
// test mutate the stub's canned response + failure flag.

interface SharedFlashStub {
  cannedResponse: string;
  failClient: boolean;
}
const sharedStub: SharedFlashStub = {
  cannedResponse: "",
  failClient: false,
};

// Install the cache injection BEFORE the static import of intent-mapper
// at the top of the file resolves. We do that by deleting + populating
// require.cache as the first thing this module does - at the top of the
// file, before any test runs. Since Node evaluates top-level statements
// in order, the cache must be populated BEFORE the first `await import()`
// inside intent-mapper is called. Static imports at the top of THIS file
// have already run by the time these lines execute, but classifyIntent
// WithFlash only does its dynamic import when CALLED, so we still win.
(function installSharedStub() {
  const cache = (require as unknown as { cache: Record<string, unknown> })
    .cache;
  const clientPath = require.resolve("../../lib/gemini/client");
  const learnedPath = require.resolve("../../lib/chat-tools/learned-patterns");

  cache[clientPath] = {
    exports: {
      __esModule: true,
      getVertexAIClient: () => {
        if (sharedStub.failClient) {
          throw new Error("simulated vertex AI client failure");
        }
        return {
          getGenerativeModel: () => ({
            async generateContent(_prompt: string) {
              return {
                response: {
                  candidates: [
                    {
                      content: {
                        parts: [{ text: sharedStub.cannedResponse }],
                      },
                    },
                  ],
                },
              };
            },
          }),
        };
      },
    },
  };
  cache[learnedPath] = {
    exports: {
      __esModule: true,
      getLearnedExamples: async () => [],
    },
  };
})();

function setStub(response: Record<string, unknown> | string): void {
  sharedStub.cannedResponse =
    typeof response === "string" ? response : JSON.stringify(response);
  sharedStub.failClient = false;
}

function failClient(): void {
  sharedStub.failClient = true;
  sharedStub.cannedResponse = "";
}

describe("MONEY-393 §26 - classifyIntentWithFlash (stubbed Gemini)", () => {
  it("[flash] deep_research → run_research with mode:'advanced'", async () => {
    setStub({
      intent: "deep_research",
      tier: "L2",
      stocks: ["RELIANCE"],
      confidence: 0.9,
      persona: "equity_research",
    });
    const result = await classifyIntentWithFlash("deep dive on RELIANCE");
    assert.ok(result && "tool" in result);
    const r = result as {
      tool: string;
      params: Record<string, unknown>;
      tier?: string;
    };
    assert.equal(r.tool, "run_research");
    assert.equal(r.params.mode, "advanced");
    assert.deepEqual(r.params.symbols, ["RELIANCE"]);
    assert.equal(r.tier, "L2");
  });

  it("[flash] comparison → mode:'advanced' + skill:'peer-comparison'", async () => {
    setStub({
      intent: "comparison",
      tier: "L2",
      stocks: ["TCS", "INFY"],
      confidence: 0.85,
    });
    const result = await classifyIntentWithFlash("compare TCS and INFY");
    const r = result as { params: Record<string, unknown>; tool: string };
    assert.equal(r.tool, "run_research");
    assert.equal(r.params.mode, "advanced");
    assert.equal(r.params.skill, "peer-comparison");
  });

  it("[flash] screener with valid string strategy → params.strategy passed through", async () => {
    setStub({
      intent: "screener",
      tier: "L2",
      confidence: 0.9,
      screenerStrategy: "value_investing",
    });
    const result = await classifyIntentWithFlash("find undervalued stocks");
    const r = result as { params: Record<string, unknown>; tool: string };
    assert.equal(r.tool, "run_screener");
    assert.equal(r.params.strategy, "value_investing");
  });

  it("[flash] screener without strategy → no strategy in params", async () => {
    setStub({
      intent: "screener",
      tier: "L2",
      confidence: 0.9,
    });
    const result = await classifyIntentWithFlash("show me momentum stocks");
    const r = result as { params: Record<string, unknown> };
    assert.equal(r.params.strategy, undefined);
  });

  it("[flash] news → get_stock_news with params.symbol (singular)", async () => {
    setStub({
      intent: "news",
      tier: "L2",
      stocks: ["INFY"],
      confidence: 0.95,
    });
    const result = await classifyIntentWithFlash("latest news on Infosys");
    const r = result as { params: Record<string, unknown>; tool: string };
    assert.equal(r.tool, "get_stock_news");
    assert.equal(r.params.symbol, "INFY");
  });

  it("[flash] portfolio_roast with broker mention → mode:'broker' + broker code", async () => {
    setStub({
      intent: "portfolio_roast",
      tier: "L2",
      confidence: 0.9,
    });
    const result = await classifyIntentWithFlash("roast my zerodha portfolio");
    const r = result as { params: Record<string, unknown>; tool: string };
    assert.equal(r.tool, "start_roast");
    assert.equal(r.params.mode, "broker");
    assert.equal(r.params.broker, "ZERODHA");
    assert.equal(r.params.assetType, "all");
    assert.equal(r.params.symbols, undefined, "symbols stripped for roast");
  });

  it("[flash] portfolio_roast with 'sip' → assetType:'mf'", async () => {
    setStub({
      intent: "portfolio_roast",
      tier: "L2",
      confidence: 0.9,
    });
    const result = await classifyIntentWithFlash("roast my SIP portfolio");
    const r = result as { params: Record<string, unknown> };
    assert.equal(r.params.assetType, "mf");
  });

  it("[flash] unclear → returns clarification object", async () => {
    setStub({
      intent: "unclear",
      tier: "L1",
      confidence: 0.4,
      question: "Did you mean a quick overview or a deep dive?",
    });
    const result = await classifyIntentWithFlash("what should I do");
    assert.ok(result && "clarification" in result);
    const c = result as { clarification: string };
    assert.match(c.clarification, /quick overview or a deep dive/);
  });

  it("[flash] general_chat → empty tool + params.query", async () => {
    setStub({
      intent: "general_chat",
      tier: "L1",
      confidence: 0.8,
      persona: "general_analyst",
    });
    const result = await classifyIntentWithFlash("what is the market?");
    const r = result as {
      tool: string;
      params: Record<string, unknown>;
      tier?: string;
    };
    assert.equal(r.tool, "");
    assert.equal(r.params.query, "what is the market?");
    assert.equal(r.tier, "L1");
  });

  it("[flash] quick_research → mode:'fast' (default) when mode missing", async () => {
    setStub({
      intent: "quick_research",
      tier: "L2",
      stocks: ["TCS"],
      confidence: 0.9,
    });
    const result = await classifyIntentWithFlash("how is TCS doing");
    const r = result as { params: Record<string, unknown> };
    assert.equal(r.params.mode, "fast");
  });

  it("[flash] quick_research → uses provided mode override", async () => {
    setStub({
      intent: "quick_research",
      tier: "L2",
      mode: "advanced",
      stocks: ["TCS"],
      confidence: 0.9,
    });
    const result = await classifyIntentWithFlash("analyze TCS");
    const r = result as { params: Record<string, unknown> };
    assert.equal(r.params.mode, "advanced");
  });

  it("[flash] unknown intent → returns null (intentToTool miss)", async () => {
    setStub({
      intent: "totally_unknown_intent",
      tier: "L1",
      confidence: 0.5,
    });
    const result = await classifyIntentWithFlash("???");
    assert.equal(result, null, "unknown intent must be ignored (returns null)");
  });

  it("[flash] non-JSON response → returns null", async () => {
    setStub("not even close to JSON, just text from Flash");
    const result = await classifyIntentWithFlash("anything");
    assert.equal(result, null);
  });

  it("[flash] empty response from model → returns null", async () => {
    setStub("");
    const result = await classifyIntentWithFlash("anything");
    assert.equal(result, null);
  });

  it("[flash] Gemini client throws → catch returns null", async () => {
    failClient();
    const result = await classifyIntentWithFlash("anything");
    assert.equal(
      result,
      null,
      "must swallow gemini client errors and return null"
    );
  });
});
