/**
 * Roast Steps Tests
 *
 * Tests for the 5 step files in packages/roast/src/steps/:
 *   1. fetch-portfolio  - DB query, data transformation, summary computation
 *   2. analyze-stocks   - LLM call mocking, response parsing, fallback defaults
 *   3. analyze-mf       - LLM call mocking, category overlap, expense analysis
 *   4. generate-scores  - Score aggregation, clamping, missing data handling
 *   5. generate-roast   - Roast content generation, fallback defaults
 *
 * Score logic (MONEY-620) and fetch-portfolio logic (MONEY-838) are imported
 * from the REAL source — see the score-utils and portfolio-query imports below.
 * The remaining LLM-parse steps still mirror their source inline. Mocks LLM with
 * mock.fn().
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
// MONEY-620 de-shadow: the score-shaping logic (clamp + assembly) is imported
// from the REAL source (packages/roast/src/lib/score-utils.ts) rather than
// re-declared inline. generate-scores.ts calls `assembleScores` on its
// parsed LLM payload, and parses that payload with the resilient
// `parseLLMJson` (which NEVER throws), so the unit-level equivalent below
// routes through the same two real symbols. The previous inline `parseScores`
// shadow used `Math.round(v || 50)` (wrongly coercing a real 0 → 50) and a
// bare throwing `JSON.parse` — both diverged from production.
import { assembleScores } from "../../../../packages/roast/src/lib/score-utils";
import { parseLLMJson } from "../../../../packages/roast/src/lib/parse-llm-json";
// MONEY-838 de-shadow: fetch-portfolio's where-builders, trade-subset gate, and
// summary/stats math are imported from the REAL source (portfolio-query.ts)
// rather than re-declared inline. The previous inline `fetchPortfolio` shadow
// filtered on `brokerName` (the bug fixed in eab5942f) and never exercised the
// `broker` enum, brokerUserId scoping, trade loading, or computeTradeStats.
import {
  buildPortfolioWhere,
  buildTradeWhere,
  wantTrades,
  computeTradeStats,
  computePortfolioSummary,
} from "../../../../packages/roast/src/lib/portfolio-query";
import type { TradeRow } from "../../../../packages/roast/src/types";

// ---------------------------------------------------------------------------
// Inline type definitions (mirrors packages/roast/src/types.ts)
// ---------------------------------------------------------------------------

interface StockHolding {
  symbol: string;
  name: string | null;
  sector: string | null;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  investedValue: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
  brokerName: string | null;
}

interface MfHolding {
  schemeName: string;
  category: string | null;
  units: number;
  averageNav: number;
  currentNav: number;
  investedAmount: number;
  currentValue: number;
  unrealizedGain: number | null;
  xirr: number;
  brokerName: string | null;
}

// MONEY-838: PortfolioData / PortfolioSummary were inline shadow types for the
// removed local fetchPortfolio. The real PortfolioSummary now comes from
// computePortfolioSummary (portfolio-query.ts), asserted below.

interface StockAnalysisResult {
  diversificationIssues: string[];
  sectorConcentration: Array<{
    sector: string;
    percentage: number;
    verdict: string;
  }>;
  topPicks: Array<{ symbol: string; reason: string }>;
  bottomPicks: Array<{ symbol: string; reason: string }>;
  riskFlags: string[];
}

interface MfAnalysisResult {
  categoryOverlap: string[];
  performanceVerdict: string;
  expenseIssues: string[];
  mfHighlights: Array<{ scheme: string; verdict: string }>;
}

interface ScoresResult {
  overallScore: number;
  scoreBreakdown: {
    diversification: { score: number; comment: string };
    riskManagement: { score: number; comment: string };
    stockPicking: { score: number; comment: string };
    timing: { score: number; comment: string };
  };
}

interface RoastContentResult {
  roastHighlights: Array<{
    type: "burn" | "praise";
    emoji: string;
    title: string;
    description: string;
  }>;
  topPerformers: Array<{ symbol: string; pnlPercent: number; roast: string }>;
  worstPerformers: Array<{
    symbol: string;
    pnlPercent: number;
    roast: string;
  }>;
  sectorAnalysis: Array<{
    sector: string;
    percentage: number;
    verdict: "overweight" | "underweight" | "fair";
    comment: string;
  }>;
  constructiveAdvice: Array<{ title: string; description: string }>;
  roastNarrative: string;
}

// ---------------------------------------------------------------------------
// Re-implemented functions (exact logic from source files)
// ---------------------------------------------------------------------------

// MONEY-838 de-shadow: the inline `fetchPortfolio` reimplementation (which
// filtered on the wrong `brokerName` field and never exercised the broker enum,
// brokerUserId, trades, or computeTradeStats) is GONE. Its pure logic now lives
// in portfolio-query.ts and is asserted directly below via the real exports.

// analyze-stocks logic (extract from LLM response)
function parseStockAnalysis(text: string): StockAnalysisResult {
  if (!text) {
    throw new Error("No response from Gemini for stock analysis");
  }
  const parsed = JSON.parse(text) as StockAnalysisResult;
  return {
    diversificationIssues: parsed.diversificationIssues || [],
    sectorConcentration: parsed.sectorConcentration || [],
    topPicks: parsed.topPicks || [],
    bottomPicks: parsed.bottomPicks || [],
    riskFlags: parsed.riskFlags || [],
  };
}

// analyze-mf logic (extract from LLM response)
function parseMfAnalysis(text: string): MfAnalysisResult {
  if (!text) {
    throw new Error("No response from Gemini for MF analysis");
  }
  const parsed = JSON.parse(text) as MfAnalysisResult;
  return {
    categoryOverlap: parsed.categoryOverlap || [],
    performanceVerdict: parsed.performanceVerdict || "Unable to assess",
    expenseIssues: parsed.expenseIssues || [],
    mfHighlights: parsed.mfHighlights || [],
  };
}

// generate-scores logic — DE-SHADOWED (MONEY-620).
//
// Routes through the REAL `parseLLMJson` + `assembleScores` from source, the
// exact two symbols `steps/generate-scores.ts` uses. We keep the empty-text
// guard to mirror generateScores's own `if (!text) throw`, but for non-empty
// input we use the resilient parser (which returns {} on malformed JSON →
// neutral 50s) instead of a bare throwing JSON.parse.
function parseScores(text: string): ScoresResult {
  if (!text) {
    throw new Error("No response from Gemini for score generation");
  }
  const parsed = parseLLMJson<Partial<ScoresResult>>(text, {}, "test-scores");
  return assembleScores(parsed);
}

// generate-roast logic (extract from LLM response)
function parseRoastContent(text: string): RoastContentResult {
  if (!text) {
    throw new Error("No response from Gemini for roast generation");
  }
  const parsed = JSON.parse(text) as RoastContentResult;
  return {
    roastHighlights: parsed.roastHighlights || [],
    topPerformers: parsed.topPerformers || [],
    worstPerformers: parsed.worstPerformers || [],
    sectorAnalysis: parsed.sectorAnalysis || [],
    constructiveAdvice: parsed.constructiveAdvice || [],
    roastNarrative:
      parsed.roastNarrative ||
      "The AI couldn't generate a narrative this time.",
  };
}

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeHolding(overrides?: Partial<StockHolding>): StockHolding {
  return {
    symbol: "RELIANCE",
    name: "Reliance Industries",
    sector: "Energy",
    quantity: 10,
    averagePrice: 2400,
    currentPrice: 2650,
    investedValue: 24000,
    currentValue: 26500,
    unrealizedPnL: 2500,
    pnlPercentage: 10.4,
    brokerName: "ZERODHA",
    ...overrides,
  };
}

function makeHolding2(overrides?: Partial<StockHolding>): StockHolding {
  return {
    symbol: "TCS",
    name: "Tata Consultancy",
    sector: "IT",
    quantity: 5,
    averagePrice: 3500,
    currentPrice: 3200,
    investedValue: 17500,
    currentValue: 16000,
    unrealizedPnL: -1500,
    pnlPercentage: -8.6,
    brokerName: "GROWW",
    ...overrides,
  };
}

function makeMf(overrides?: Partial<MfHolding>): MfHolding {
  return {
    schemeName: "Axis Bluechip Fund - Direct Growth",
    category: "Large Cap",
    units: 100,
    averageNav: 40,
    currentNav: 45,
    investedAmount: 4000,
    currentValue: 4500,
    unrealizedGain: 500,
    xirr: 12.5,
    brokerName: "GROWW",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests - Step 1: fetchPortfolio
// ---------------------------------------------------------------------------

// makeTrade — a single TradeRow (the shape computeTradeStats consumes).
function makeTrade(overrides?: Partial<TradeRow>): TradeRow {
  return {
    symbol: "RELIANCE",
    tradeType: "BUY",
    quantity: 10,
    price: 2400,
    tradeValue: 24000,
    realizedPnL: null,
    tradeDate: new Date("2026-01-15"),
    ...overrides,
  };
}

describe("portfolio-query: buildPortfolioWhere (real source)", () => {
  it("overall mode → only userId (no broker/account scoping)", () => {
    const { holdingsWhere, mfWhere } = buildPortfolioWhere({
      userId: "user1",
      mode: "overall",
    });
    assert.deepStrictEqual(holdingsWhere, { userId: "user1" });
    assert.deepStrictEqual(mfWhere, { userId: "user1" });
  });

  it("broker mode filters on the `broker` ENUM — NOT `brokerName` (the eab5942f fix)", () => {
    const { holdingsWhere, mfWhere } = buildPortfolioWhere({
      userId: "user1",
      mode: "broker",
      broker: "ZERODHA",
    });
    assert.strictEqual(holdingsWhere.broker, "ZERODHA");
    assert.strictEqual(mfWhere.broker, "ZERODHA");
    // Regression guard for the original "no portfolio data" bug: the sync never
    // writes `brokerName` on holdings/MFs, so it must NOT appear in the where.
    assert.strictEqual("brokerName" in holdingsWhere, false);
    assert.strictEqual("brokerName" in mfWhere, false);
  });

  it("broker mode without a broker stays unscoped", () => {
    const { holdingsWhere } = buildPortfolioWhere({
      userId: "user1",
      mode: "broker",
    });
    assert.deepStrictEqual(holdingsWhere, { userId: "user1" });
  });

  it("brokerUserId narrows to a specific account (multi-login brokers)", () => {
    const { holdingsWhere, mfWhere } = buildPortfolioWhere({
      userId: "user1",
      mode: "broker",
      broker: "ZERODHA",
      brokerUserId: "ZR123",
    });
    assert.strictEqual(holdingsWhere.brokerUserId, "ZR123");
    assert.strictEqual(mfWhere.brokerUserId, "ZR123");
  });

  it("brokerUserId is ignored in overall mode", () => {
    const { holdingsWhere } = buildPortfolioWhere({
      userId: "user1",
      mode: "overall",
      brokerUserId: "ZR123",
    });
    assert.strictEqual("brokerUserId" in holdingsWhere, false);
  });

  it("a symbol subset narrows holdings only (MFs have no stock symbol)", () => {
    const { holdingsWhere, mfWhere } = buildPortfolioWhere({
      userId: "user1",
      mode: "overall",
      symbols: ["RELIANCE", "TCS"],
    });
    assert.deepStrictEqual(holdingsWhere.symbol, { in: ["RELIANCE", "TCS"] });
    assert.strictEqual("symbol" in mfWhere, false);
  });

  it("an empty symbol array does NOT add a symbol filter", () => {
    const { holdingsWhere } = buildPortfolioWhere({
      userId: "user1",
      mode: "overall",
      symbols: [],
    });
    assert.strictEqual("symbol" in holdingsWhere, false);
  });
});

describe("portfolio-query: wantTrades (real source)", () => {
  it("PORTFOLIO scope with no filters → false", () => {
    assert.strictEqual(wantTrades({ scope: "PORTFOLIO" }), false);
  });

  it("TRADEBOOK scope → true", () => {
    assert.strictEqual(wantTrades({ scope: "TRADEBOOK" }), true);
  });

  it("a date bound forces trades even in PORTFOLIO scope", () => {
    assert.strictEqual(
      wantTrades({ scope: "PORTFOLIO", dateFrom: "2026-01-01" }),
      true
    );
    assert.strictEqual(
      wantTrades({ scope: "PORTFOLIO", dateTo: "2026-01-31" }),
      true
    );
  });

  it("a symbol subset forces trades", () => {
    assert.strictEqual(
      wantTrades({ scope: "PORTFOLIO", symbols: ["TCS"] }),
      true
    );
  });

  it("an empty symbol array does NOT force trades", () => {
    assert.strictEqual(wantTrades({ scope: "PORTFOLIO", symbols: [] }), false);
  });
});

describe("portfolio-query: buildTradeWhere (real source)", () => {
  it("scopes to broker enum + account when given", () => {
    const w = buildTradeWhere({
      userId: "user1",
      mode: "broker",
      broker: "ZERODHA",
      brokerUserId: "ZR123",
    });
    assert.strictEqual(w.userId, "user1");
    assert.strictEqual(w.broker, "ZERODHA");
    assert.strictEqual(w.brokerUserId, "ZR123");
  });

  it("a symbol subset filters trades", () => {
    const w = buildTradeWhere({
      userId: "user1",
      mode: "overall",
      symbols: ["TCS"],
    });
    assert.deepStrictEqual(w.symbol, { in: ["TCS"] });
  });

  it("dateFrom/dateTo become a tradeDate gte/lte range", () => {
    const w = buildTradeWhere({
      userId: "user1",
      mode: "overall",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
    const range = w.tradeDate as { gte?: Date; lte?: Date };
    assert.ok(range.gte instanceof Date);
    assert.ok(range.lte instanceof Date);
    assert.strictEqual(
      range.gte!.toISOString(),
      new Date("2026-01-01").toISOString()
    );
    assert.strictEqual(
      range.lte!.toISOString(),
      new Date("2026-01-31").toISOString()
    );
  });

  it("only dateFrom → gte with no lte", () => {
    const w = buildTradeWhere({
      userId: "user1",
      mode: "overall",
      dateFrom: "2026-01-01",
    });
    const range = w.tradeDate as { gte?: Date; lte?: Date };
    assert.ok(range.gte instanceof Date);
    assert.strictEqual("lte" in range, false);
  });

  it("no date bounds → no tradeDate filter", () => {
    const w = buildTradeWhere({ userId: "user1", mode: "overall" });
    assert.strictEqual("tradeDate" in w, false);
  });
});

describe("portfolio-query: computePortfolioSummary (real source)", () => {
  it("totalStockInvested / totalStockCurrent sum holdings", () => {
    const r = computePortfolioSummary([makeHolding(), makeHolding2()], []);
    assert.strictEqual(r.totalStockInvested, 24000 + 17500);
    assert.strictEqual(r.totalStockCurrent, 26500 + 16000);
  });

  it("totalMfInvested / totalMfCurrent sum MFs", () => {
    const mf1 = makeMf({ investedAmount: 4000, currentValue: 4500 });
    const mf2 = makeMf({ investedAmount: 6000, currentValue: 7200 });
    const r = computePortfolioSummary([], [mf1, mf2]);
    assert.strictEqual(r.totalMfInvested, 10000);
    assert.strictEqual(r.totalMfCurrent, 11700);
  });

  it("stockCount / mfCount", () => {
    const r = computePortfolioSummary(
      [makeHolding(), makeHolding2()],
      [makeMf()]
    );
    assert.strictEqual(r.stockCount, 2);
    assert.strictEqual(r.mfCount, 1);
  });

  it("sector concentration percentages, sorted by value desc", () => {
    const r = computePortfolioSummary([makeHolding(), makeHolding2()], []);
    const totalCurrent = 26500 + 16000;
    assert.strictEqual(r.sectorConcentration.length, 2);
    assert.strictEqual(r.sectorConcentration[0]!.sector, "Energy");
    assert.ok(
      Math.abs(
        r.sectorConcentration[0]!.percentage - (26500 / totalCurrent) * 100
      ) < 0.01
    );
    assert.strictEqual(r.sectorConcentration[1]!.sector, "IT");
  });

  it("null sectors group as 'Unknown'", () => {
    const r = computePortfolioSummary(
      [
        makeHolding({ sector: null, currentValue: 5000 }),
        makeHolding2({ sector: null, currentValue: 3000 }),
      ],
      []
    );
    assert.strictEqual(r.sectorConcentration.length, 1);
    assert.strictEqual(r.sectorConcentration[0]!.sector, "Unknown");
    assert.strictEqual(r.sectorConcentration[0]!.value, 8000);
  });

  it("empty portfolio → zeroed totals, no sectors", () => {
    const r = computePortfolioSummary([], []);
    assert.strictEqual(r.sectorConcentration.length, 0);
    assert.strictEqual(r.totalStockInvested, 0);
    assert.strictEqual(r.totalStockCurrent, 0);
    assert.strictEqual(r.stockCount, 0);
    assert.strictEqual(r.mfCount, 0);
  });
});

describe("portfolio-query: computeTradeStats (real source, NEW coverage)", () => {
  it("counts buys/sells and distinct symbols", () => {
    const stats = computeTradeStats([
      makeTrade({ symbol: "RELIANCE", tradeType: "BUY" }),
      makeTrade({ symbol: "RELIANCE", tradeType: "SELL" }),
      makeTrade({ symbol: "TCS", tradeType: "BUY" }),
    ]);
    assert.strictEqual(stats.totalTrades, 3);
    assert.strictEqual(stats.buys, 2);
    assert.strictEqual(stats.sells, 1);
    assert.strictEqual(stats.distinctSymbols, 2);
  });

  it("sums turnover and skips non-finite tradeValue", () => {
    const stats = computeTradeStats([
      makeTrade({ tradeValue: 1000 }),
      makeTrade({ tradeValue: Number.NaN }),
      makeTrade({ tradeValue: 2000 }),
    ]);
    assert.strictEqual(stats.turnover, 3000);
  });

  it("realised P&L sums; counts winners vs losers (0 is neither)", () => {
    const stats = computeTradeStats([
      makeTrade({ realizedPnL: 500 }),
      makeTrade({ realizedPnL: -200 }),
      makeTrade({ realizedPnL: 0 }),
      makeTrade({ realizedPnL: null }),
    ]);
    assert.strictEqual(stats.realizedPnL, 300);
    assert.strictEqual(stats.winningTrades, 1);
    assert.strictEqual(stats.losingTrades, 1);
  });

  it("topSymbols ranks by trade count, capped at 5", () => {
    const trades = [
      ...Array.from({ length: 3 }, () => makeTrade({ symbol: "AAA" })),
      ...Array.from({ length: 2 }, () => makeTrade({ symbol: "BBB" })),
      makeTrade({ symbol: "CCC" }),
      makeTrade({ symbol: "DDD" }),
      makeTrade({ symbol: "EEE" }),
      makeTrade({ symbol: "FFF" }),
    ];
    const stats = computeTradeStats(trades);
    assert.strictEqual(stats.topSymbols.length, 5);
    assert.strictEqual(stats.topSymbols[0]!.symbol, "AAA");
    assert.strictEqual(stats.topSymbols[0]!.trades, 3);
    assert.strictEqual(stats.topSymbols[1]!.symbol, "BBB");
  });

  it("tracks first/last trade dates across the window", () => {
    const stats = computeTradeStats([
      makeTrade({ tradeDate: new Date("2026-01-15") }),
      makeTrade({ tradeDate: new Date("2026-01-02") }),
      makeTrade({ tradeDate: new Date("2026-01-28") }),
    ]);
    assert.strictEqual(
      stats.firstTrade!.toISOString(),
      new Date("2026-01-02").toISOString()
    );
    assert.strictEqual(
      stats.lastTrade!.toISOString(),
      new Date("2026-01-28").toISOString()
    );
  });

  it("empty trades → zeroed stats, null dates", () => {
    const stats = computeTradeStats([]);
    assert.strictEqual(stats.totalTrades, 0);
    assert.strictEqual(stats.turnover, 0);
    assert.strictEqual(stats.distinctSymbols, 0);
    assert.strictEqual(stats.firstTrade, null);
    assert.strictEqual(stats.lastTrade, null);
    assert.deepStrictEqual(stats.topSymbols, []);
  });
});

// ---------------------------------------------------------------------------
// Tests - Step 2: analyzeStocks (parseStockAnalysis)
// ---------------------------------------------------------------------------

describe("analyzeStocks - parseStockAnalysis", () => {
  it("should parse a complete JSON response", () => {
    const json = JSON.stringify({
      diversificationIssues: ["Too much Energy"],
      sectorConcentration: [
        { sector: "Energy", percentage: 60, verdict: "overweight" },
      ],
      topPicks: [{ symbol: "RELIANCE", reason: "Strong" }],
      bottomPicks: [{ symbol: "TCS", reason: "Weak" }],
      riskFlags: ["Concentration risk"],
    });
    const result = parseStockAnalysis(json);

    assert.deepStrictEqual(result.diversificationIssues, ["Too much Energy"]);
    assert.strictEqual(result.sectorConcentration.length, 1);
    assert.strictEqual(result.topPicks[0]!.symbol, "RELIANCE");
    assert.strictEqual(result.bottomPicks[0]!.symbol, "TCS");
    assert.deepStrictEqual(result.riskFlags, ["Concentration risk"]);
  });

  it("should default missing diversificationIssues to empty array", () => {
    const json = JSON.stringify({
      sectorConcentration: [],
      topPicks: [],
      bottomPicks: [],
      riskFlags: [],
    });
    const result = parseStockAnalysis(json);
    assert.deepStrictEqual(result.diversificationIssues, []);
  });

  it("should default missing sectorConcentration to empty array", () => {
    const json = JSON.stringify({
      diversificationIssues: [],
      topPicks: [],
      bottomPicks: [],
      riskFlags: [],
    });
    const result = parseStockAnalysis(json);
    assert.deepStrictEqual(result.sectorConcentration, []);
  });

  it("should default missing topPicks to empty array", () => {
    const json = JSON.stringify({
      diversificationIssues: [],
      sectorConcentration: [],
      bottomPicks: [],
      riskFlags: [],
    });
    const result = parseStockAnalysis(json);
    assert.deepStrictEqual(result.topPicks, []);
  });

  it("should default missing bottomPicks to empty array", () => {
    const json = JSON.stringify({
      diversificationIssues: [],
      sectorConcentration: [],
      topPicks: [],
      riskFlags: [],
    });
    const result = parseStockAnalysis(json);
    assert.deepStrictEqual(result.bottomPicks, []);
  });

  it("should default missing riskFlags to empty array", () => {
    const json = JSON.stringify({
      diversificationIssues: [],
      sectorConcentration: [],
      topPicks: [],
      bottomPicks: [],
    });
    const result = parseStockAnalysis(json);
    assert.deepStrictEqual(result.riskFlags, []);
  });

  it("should default all missing fields to empty arrays", () => {
    const result = parseStockAnalysis("{}");
    assert.deepStrictEqual(result.diversificationIssues, []);
    assert.deepStrictEqual(result.sectorConcentration, []);
    assert.deepStrictEqual(result.topPicks, []);
    assert.deepStrictEqual(result.bottomPicks, []);
    assert.deepStrictEqual(result.riskFlags, []);
  });

  it("should throw on empty string", () => {
    assert.throws(() => parseStockAnalysis(""), {
      message: "No response from Gemini for stock analysis",
    });
  });

  it("should throw on invalid JSON", () => {
    assert.throws(() => parseStockAnalysis("not json"));
  });

  it("should handle multiple diversification issues", () => {
    const json = JSON.stringify({
      diversificationIssues: ["Issue 1", "Issue 2", "Issue 3"],
    });
    const result = parseStockAnalysis(json);
    assert.strictEqual(result.diversificationIssues.length, 3);
  });

  it("should preserve sector concentration verdicts", () => {
    const json = JSON.stringify({
      sectorConcentration: [
        { sector: "Energy", percentage: 60, verdict: "overweight" },
        { sector: "IT", percentage: 30, verdict: "fair" },
        { sector: "Pharma", percentage: 10, verdict: "underweight" },
      ],
    });
    const result = parseStockAnalysis(json);
    assert.strictEqual(result.sectorConcentration[0]!.verdict, "overweight");
    assert.strictEqual(result.sectorConcentration[1]!.verdict, "fair");
    assert.strictEqual(result.sectorConcentration[2]!.verdict, "underweight");
  });
});

// ---------------------------------------------------------------------------
// Tests - Step 3: analyzeMf (parseMfAnalysis)
// ---------------------------------------------------------------------------

describe("analyzeMf - parseMfAnalysis", () => {
  it("should parse a complete JSON response", () => {
    const json = JSON.stringify({
      categoryOverlap: ["Multiple large-cap funds"],
      performanceVerdict: "Good performer",
      expenseIssues: ["High expense ratio"],
      mfHighlights: [{ scheme: "Axis Bluechip", verdict: "Solid" }],
    });
    const result = parseMfAnalysis(json);

    assert.deepStrictEqual(result.categoryOverlap, [
      "Multiple large-cap funds",
    ]);
    assert.strictEqual(result.performanceVerdict, "Good performer");
    assert.deepStrictEqual(result.expenseIssues, ["High expense ratio"]);
    assert.strictEqual(result.mfHighlights[0]!.scheme, "Axis Bluechip");
  });

  it("should default missing categoryOverlap to empty array", () => {
    const json = JSON.stringify({ performanceVerdict: "OK" });
    const result = parseMfAnalysis(json);
    assert.deepStrictEqual(result.categoryOverlap, []);
  });

  it("should default missing performanceVerdict to 'Unable to assess'", () => {
    const json = JSON.stringify({});
    const result = parseMfAnalysis(json);
    assert.strictEqual(result.performanceVerdict, "Unable to assess");
  });

  it("should default missing expenseIssues to empty array", () => {
    const json = JSON.stringify({ performanceVerdict: "OK" });
    const result = parseMfAnalysis(json);
    assert.deepStrictEqual(result.expenseIssues, []);
  });

  it("should default missing mfHighlights to empty array", () => {
    const json = JSON.stringify({ performanceVerdict: "OK" });
    const result = parseMfAnalysis(json);
    assert.deepStrictEqual(result.mfHighlights, []);
  });

  it("should default all missing fields", () => {
    const result = parseMfAnalysis("{}");
    assert.deepStrictEqual(result.categoryOverlap, []);
    assert.strictEqual(result.performanceVerdict, "Unable to assess");
    assert.deepStrictEqual(result.expenseIssues, []);
    assert.deepStrictEqual(result.mfHighlights, []);
  });

  it("should throw on empty string", () => {
    assert.throws(() => parseMfAnalysis(""), {
      message: "No response from Gemini for MF analysis",
    });
  });

  it("should throw on invalid JSON", () => {
    assert.throws(() => parseMfAnalysis("{invalid}"));
  });

  it("should handle multiple category overlaps", () => {
    const json = JSON.stringify({
      categoryOverlap: [
        "Multiple large-cap funds",
        "Overlapping mid-cap exposure",
      ],
    });
    const result = parseMfAnalysis(json);
    assert.strictEqual(result.categoryOverlap.length, 2);
  });

  it("should preserve multiple expense issues", () => {
    const json = JSON.stringify({
      expenseIssues: ["High TER on Fund A", "High TER on Fund B"],
    });
    const result = parseMfAnalysis(json);
    assert.strictEqual(result.expenseIssues.length, 2);
    assert.strictEqual(result.expenseIssues[0], "High TER on Fund A");
  });
});

// ---------------------------------------------------------------------------
// Tests - Step 4: generateScores (parseScores)
// ---------------------------------------------------------------------------

describe("generateScores - parseScores", () => {
  it("should parse a complete valid response", () => {
    const json = JSON.stringify({
      overallScore: 72,
      scoreBreakdown: {
        diversification: { score: 60, comment: "Needs improvement" },
        riskManagement: { score: 75, comment: "Good risk management" },
        stockPicking: { score: 80, comment: "Strong picks" },
        timing: { score: 65, comment: "Average timing" },
      },
    });
    const result = parseScores(json);

    assert.strictEqual(result.overallScore, 72);
    assert.strictEqual(result.scoreBreakdown.diversification.score, 60);
    assert.strictEqual(
      result.scoreBreakdown.diversification.comment,
      "Needs improvement"
    );
    assert.strictEqual(result.scoreBreakdown.riskManagement.score, 75);
    assert.strictEqual(result.scoreBreakdown.stockPicking.score, 80);
    assert.strictEqual(result.scoreBreakdown.timing.score, 65);
  });

  describe("clamping", () => {
    it("should clamp scores above 100 to 100", () => {
      const json = JSON.stringify({
        overallScore: 150,
        scoreBreakdown: {
          diversification: { score: 200, comment: "Test" },
          riskManagement: { score: 100, comment: "Test" },
          stockPicking: { score: 100, comment: "Test" },
          timing: { score: 100, comment: "Test" },
        },
      });
      const result = parseScores(json);
      assert.strictEqual(result.overallScore, 100);
      assert.strictEqual(result.scoreBreakdown.diversification.score, 100);
    });

    it("should clamp scores below 0 to 0", () => {
      const json = JSON.stringify({
        overallScore: -10,
        scoreBreakdown: {
          diversification: { score: -50, comment: "Test" },
          riskManagement: { score: 0, comment: "Test" },
          stockPicking: { score: 0, comment: "Test" },
          timing: { score: 0, comment: "Test" },
        },
      });
      const result = parseScores(json);
      assert.strictEqual(result.overallScore, 0);
      assert.strictEqual(result.scoreBreakdown.diversification.score, 0);
    });

    it("should round fractional scores", () => {
      const json = JSON.stringify({
        overallScore: 72.7,
        scoreBreakdown: {
          diversification: { score: 60.4, comment: "Test" },
          riskManagement: { score: 75.5, comment: "Test" },
          stockPicking: { score: 80.9, comment: "Test" },
          timing: { score: 65.1, comment: "Test" },
        },
      });
      const result = parseScores(json);
      assert.strictEqual(result.overallScore, 73);
      assert.strictEqual(result.scoreBreakdown.diversification.score, 60);
      assert.strictEqual(result.scoreBreakdown.riskManagement.score, 76);
      assert.strictEqual(result.scoreBreakdown.stockPicking.score, 81);
      assert.strictEqual(result.scoreBreakdown.timing.score, 65);
    });

    it("MONEY-620: keeps an explicit overallScore of 0 as 0 (real `?? 50`, not `|| 50`)", () => {
      // The OLD inline shadow used `Math.round(v || 50)`, which coerced a
      // legitimate 0 → 50 and this very test asserted that wrong value. The
      // real source uses `?? 50`, so an explicit 0 is preserved. A
      // zero-invested portfolio that genuinely scores 0 must NOT silently
      // display 50.
      const json = JSON.stringify({
        overallScore: 0,
        scoreBreakdown: {
          diversification: { score: 50, comment: "Test" },
          riskManagement: { score: 50, comment: "Test" },
          stockPicking: { score: 50, comment: "Test" },
          timing: { score: 50, comment: "Test" },
        },
      });
      const result = parseScores(json);
      assert.strictEqual(result.overallScore, 0);
    });

    it("MONEY-620: keeps a breakdown score of exactly 0 as 0 (not coerced to 50)", () => {
      const json = JSON.stringify({
        overallScore: 1,
        scoreBreakdown: {
          diversification: { score: 0, comment: "Test" },
          riskManagement: { score: 50, comment: "Test" },
          stockPicking: { score: 50, comment: "Test" },
          timing: { score: 50, comment: "Test" },
        },
      });
      const result = parseScores(json);
      assert.strictEqual(result.scoreBreakdown.diversification.score, 0);
    });

    it("should handle boundary score of exactly 100", () => {
      const json = JSON.stringify({
        overallScore: 100,
        scoreBreakdown: {
          diversification: { score: 100, comment: "Test" },
          riskManagement: { score: 100, comment: "Test" },
          stockPicking: { score: 100, comment: "Test" },
          timing: { score: 100, comment: "Test" },
        },
      });
      const result = parseScores(json);
      assert.strictEqual(result.overallScore, 100);
      assert.strictEqual(result.scoreBreakdown.diversification.score, 100);
    });
  });

  describe("missing data handling", () => {
    it("should default missing scoreBreakdown fields to score 50 comment N/A", () => {
      const json = JSON.stringify({
        overallScore: 60,
        scoreBreakdown: {},
      });
      const result = parseScores(json);
      assert.strictEqual(result.scoreBreakdown.diversification.score, 50);
      assert.strictEqual(result.scoreBreakdown.diversification.comment, "N/A");
      assert.strictEqual(result.scoreBreakdown.riskManagement.score, 50);
      assert.strictEqual(result.scoreBreakdown.riskManagement.comment, "N/A");
      assert.strictEqual(result.scoreBreakdown.stockPicking.score, 50);
      assert.strictEqual(result.scoreBreakdown.stockPicking.comment, "N/A");
      assert.strictEqual(result.scoreBreakdown.timing.score, 50);
      assert.strictEqual(result.scoreBreakdown.timing.comment, "N/A");
    });

    it("should default missing scoreBreakdown entirely", () => {
      const json = JSON.stringify({
        overallScore: 60,
      });
      const result = parseScores(json);
      // scoreBreakdown is undefined, so diversification is undefined, score is undefined
      // clamp(undefined) = Math.round(undefined || 50) = Math.round(50) = 50
      assert.strictEqual(result.scoreBreakdown.diversification.score, 50);
      assert.strictEqual(result.scoreBreakdown.diversification.comment, "N/A");
    });

    it("should default missing comments to N/A", () => {
      const json = JSON.stringify({
        overallScore: 60,
        scoreBreakdown: {
          diversification: { score: 60 },
          riskManagement: { score: 70 },
          stockPicking: { score: 80 },
          timing: { score: 90 },
        },
      });
      const result = parseScores(json);
      assert.strictEqual(result.scoreBreakdown.diversification.comment, "N/A");
      assert.strictEqual(result.scoreBreakdown.riskManagement.comment, "N/A");
      assert.strictEqual(result.scoreBreakdown.stockPicking.comment, "N/A");
      assert.strictEqual(result.scoreBreakdown.timing.comment, "N/A");
    });

    it("should throw on empty string (mirrors generateScores empty-text guard)", () => {
      assert.throws(() => parseScores(""), {
        message: "No response from Gemini for score generation",
      });
    });

    it("MONEY-620: does NOT throw on invalid JSON — resilient parse degrades to neutral 50s", () => {
      // The OLD shadow did a bare `JSON.parse` and asserted a throw, but the
      // real generateScores uses `parseLLMJson` which NEVER throws (it returns
      // {} on unrecoverable input). So a malformed model response yields a
      // neutral score card, not a failed roast.
      const result = parseScores("not json at all");
      assert.strictEqual(result.overallScore, 50);
      assert.strictEqual(result.scoreBreakdown.diversification.score, 50);
      assert.strictEqual(result.scoreBreakdown.diversification.comment, "N/A");
      assert.strictEqual(result.scoreBreakdown.timing.score, 50);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests - Step 5: generateRoast (parseRoastContent)
// ---------------------------------------------------------------------------

describe("generateRoast - parseRoastContent", () => {
  it("should parse a complete JSON response", () => {
    const json = JSON.stringify({
      roastHighlights: [
        {
          type: "burn",
          emoji: "fire",
          title: "Overcooked",
          description: "Your portfolio is well-done.",
        },
      ],
      topPerformers: [
        { symbol: "RELIANCE", pnlPercent: 10, roast: "Nice one" },
      ],
      worstPerformers: [{ symbol: "TCS", pnlPercent: -8, roast: "Ouch" }],
      sectorAnalysis: [
        {
          sector: "Energy",
          percentage: 60,
          verdict: "overweight",
          comment: "Too much",
        },
      ],
      constructiveAdvice: [
        { title: "Diversify", description: "Add more sectors" },
      ],
      roastNarrative: "Your portfolio is a comedy show.",
    });
    const result = parseRoastContent(json);

    assert.strictEqual(result.roastHighlights.length, 1);
    assert.strictEqual(result.roastHighlights[0]!.type, "burn");
    assert.strictEqual(result.topPerformers[0]!.symbol, "RELIANCE");
    assert.strictEqual(result.worstPerformers[0]!.symbol, "TCS");
    assert.strictEqual(result.sectorAnalysis[0]!.verdict, "overweight");
    assert.strictEqual(result.constructiveAdvice[0]!.title, "Diversify");
    assert.strictEqual(
      result.roastNarrative,
      "Your portfolio is a comedy show."
    );
  });

  it("should default missing roastHighlights to empty array", () => {
    const result = parseRoastContent(
      JSON.stringify({ roastNarrative: "test" })
    );
    assert.deepStrictEqual(result.roastHighlights, []);
  });

  it("should default missing topPerformers to empty array", () => {
    const result = parseRoastContent(
      JSON.stringify({ roastNarrative: "test" })
    );
    assert.deepStrictEqual(result.topPerformers, []);
  });

  it("should default missing worstPerformers to empty array", () => {
    const result = parseRoastContent(
      JSON.stringify({ roastNarrative: "test" })
    );
    assert.deepStrictEqual(result.worstPerformers, []);
  });

  it("should default missing sectorAnalysis to empty array", () => {
    const result = parseRoastContent(
      JSON.stringify({ roastNarrative: "test" })
    );
    assert.deepStrictEqual(result.sectorAnalysis, []);
  });

  it("should default missing constructiveAdvice to empty array", () => {
    const result = parseRoastContent(
      JSON.stringify({ roastNarrative: "test" })
    );
    assert.deepStrictEqual(result.constructiveAdvice, []);
  });

  it("should default missing roastNarrative to fallback message", () => {
    const result = parseRoastContent("{}");
    assert.strictEqual(
      result.roastNarrative,
      "The AI couldn't generate a narrative this time."
    );
  });

  it("should default all missing fields", () => {
    const result = parseRoastContent("{}");
    assert.deepStrictEqual(result.roastHighlights, []);
    assert.deepStrictEqual(result.topPerformers, []);
    assert.deepStrictEqual(result.worstPerformers, []);
    assert.deepStrictEqual(result.sectorAnalysis, []);
    assert.deepStrictEqual(result.constructiveAdvice, []);
    assert.strictEqual(
      result.roastNarrative,
      "The AI couldn't generate a narrative this time."
    );
  });

  it("should throw on empty string", () => {
    assert.throws(() => parseRoastContent(""), {
      message: "No response from Gemini for roast generation",
    });
  });

  it("should throw on invalid JSON", () => {
    assert.throws(() => parseRoastContent("{bad}"));
  });

  it("should preserve roastNarrative when provided", () => {
    const narrative = "This is a custom narrative about your portfolio.";
    const result = parseRoastContent(
      JSON.stringify({ roastNarrative: narrative })
    );
    assert.strictEqual(result.roastNarrative, narrative);
  });

  it("should handle multiple roast highlights of mixed types", () => {
    const json = JSON.stringify({
      roastHighlights: [
        {
          type: "burn",
          emoji: "fire",
          title: "Bad",
          description: "Very bad",
        },
        {
          type: "praise",
          emoji: "star",
          title: "Good",
          description: "Very good",
        },
        {
          type: "burn",
          emoji: "skull",
          title: "Terrible",
          description: "Very terrible",
        },
      ],
    });
    const result = parseRoastContent(json);
    assert.strictEqual(result.roastHighlights.length, 3);
    assert.strictEqual(result.roastHighlights[0]!.type, "burn");
    assert.strictEqual(result.roastHighlights[1]!.type, "praise");
    assert.strictEqual(result.roastHighlights[2]!.type, "burn");
  });
});
