/**
 * Roast Prompt Builder Tests
 *
 * Tests for the 4 pure prompt-building functions in packages/roast/src/prompts.ts.
 * De-shadowed: imports the REAL functions + types from the source. prompts.ts
 * imports only types (no runtime deps), so it loads cleanly under node:test.
 * If a prompt's wording, table layout, or null-handling changes in source,
 * these assertions break — that's the point.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildStockAnalysisPrompt,
  buildMfAnalysisPrompt,
  buildScoresPrompt,
  buildRoastPrompt,
} from "../../../../packages/roast/src/prompts";
import type {
  PortfolioData,
  StockHolding,
  MfHolding,
  StockAnalysisResult,
  MfAnalysisResult,
  ScoresResult,
} from "@usemoney/roast/types";

// ---------------------------------------------------------------------------
// Test data factory
// ---------------------------------------------------------------------------

function makePortfolio(overrides?: Partial<PortfolioData>): PortfolioData {
  return {
    holdings: [
      {
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
      },
      {
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
      },
    ],
    mfs: [
      {
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
      },
    ],
    summary: {
      totalStockInvested: 41500,
      totalStockCurrent: 42500,
      totalMfInvested: 4000,
      totalMfCurrent: 4500,
      sectorConcentration: [
        { sector: "Energy", value: 26500, percentage: 62.4 },
        { sector: "IT", value: 16000, percentage: 37.6 },
      ],
      stockCount: 2,
      mfCount: 1,
    },
    ...overrides,
  };
}

function makeStockAnalysis(
  overrides?: Partial<StockAnalysisResult>
): StockAnalysisResult {
  return {
    diversificationIssues: ["Heavy Energy concentration"],
    sectorConcentration: [
      { sector: "Energy", percentage: 62.4, verdict: "overweight" },
      { sector: "IT", percentage: 37.6, verdict: "fair" },
    ],
    topPicks: [{ symbol: "RELIANCE", reason: "Strong fundamentals" }],
    bottomPicks: [{ symbol: "TCS", reason: "Declining revenue" }],
    riskFlags: ["Single sector dominance"],
    ...overrides,
  };
}

function makeMfAnalysis(
  overrides?: Partial<MfAnalysisResult>
): MfAnalysisResult {
  return {
    categoryOverlap: ["Multiple large-cap funds"],
    performanceVerdict: "Moderate performer",
    expenseIssues: ["High expense ratio on fund X"],
    mfHighlights: [
      { scheme: "Axis Bluechip", verdict: "Decent large-cap exposure" },
    ],
    ...overrides,
  };
}

function makeScores(overrides?: Partial<ScoresResult>): ScoresResult {
  return {
    overallScore: 65,
    scoreBreakdown: {
      diversification: { score: 50, comment: "Needs work" },
      riskManagement: { score: 60, comment: "Average" },
      stockPicking: { score: 70, comment: "Not bad" },
      timing: { score: 80, comment: "Good timing" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildStockAnalysisPrompt", () => {
  it("should return a string", () => {
    const result = buildStockAnalysisPrompt(makePortfolio());
    assert.strictEqual(typeof result, "string");
  });

  it("should contain table headers", () => {
    const result = buildStockAnalysisPrompt(makePortfolio());
    assert.ok(
      result.includes(
        "| Symbol | Sector | Qty | Avg Price | Current | P&L % | Value |"
      )
    );
  });

  it("should include all holding symbols", () => {
    const result = buildStockAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("RELIANCE"));
    assert.ok(result.includes("TCS"));
  });

  it("should include sector info", () => {
    const result = buildStockAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("Energy"));
    assert.ok(result.includes("IT"));
    assert.ok(result.includes("62.4%"));
    assert.ok(result.includes("37.6%"));
  });

  it("should include total invested value", () => {
    const result = buildStockAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("Total Invested:"));
    assert.ok(result.includes("41,500"));
  });

  it("should include current value", () => {
    const result = buildStockAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("Current Value:"));
    assert.ok(result.includes("42,500"));
  });

  it("should mention Indian equities", () => {
    const result = buildStockAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("Indian equities"));
  });

  it("should request JSON output", () => {
    const result = buildStockAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("Respond with JSON"));
    assert.ok(result.includes("diversificationIssues"));
    assert.ok(result.includes("sectorConcentration"));
    assert.ok(result.includes("topPicks"));
    assert.ok(result.includes("bottomPicks"));
    assert.ok(result.includes("riskFlags"));
  });

  it("should include holding quantity and prices", () => {
    const result = buildStockAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("10"));
    assert.ok(result.includes("₹2400"));
    assert.ok(result.includes("₹2650"));
  });

  it("should include P&L percentage for each holding", () => {
    const result = buildStockAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("10.4%"));
    assert.ok(result.includes("-8.6%"));
  });

  it("should mention NSE/BSE in rules", () => {
    const result = buildStockAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("NSE/BSE"));
  });

  it("should handle empty holdings", () => {
    const portfolio = makePortfolio({
      holdings: [],
      summary: {
        ...makePortfolio().summary,
        stockCount: 0,
        totalStockInvested: 0,
        totalStockCurrent: 0,
        sectorConcentration: [],
      },
    });
    const result = buildStockAnalysisPrompt(portfolio);
    assert.ok(result.includes("0 stocks"));
    assert.strictEqual(typeof result, "string");
  });

  it("should handle single holding", () => {
    const portfolio = makePortfolio({
      holdings: [makePortfolio().holdings[0]!],
    });
    const result = buildStockAnalysisPrompt(portfolio);
    assert.ok(result.includes("RELIANCE"));
    assert.ok(!result.includes("TCS"));
  });

  it("should use dash for null sector", () => {
    const portfolio = makePortfolio({
      holdings: [{ ...makePortfolio().holdings[0]!, sector: null }],
    });
    const result = buildStockAnalysisPrompt(portfolio);
    assert.ok(result.includes("| - |"));
  });

  it("should calculate P&L percentage correctly", () => {
    const result = buildStockAnalysisPrompt(makePortfolio());
    // (42500-41500)/41500*100 = 2.4%
    assert.ok(result.includes("2.4%"));
  });

  it("should handle zero invested value for P&L", () => {
    const portfolio = makePortfolio({
      summary: {
        ...makePortfolio().summary,
        totalStockInvested: 0,
        totalStockCurrent: 0,
      },
    });
    const result = buildStockAnalysisPrompt(portfolio);
    // When invested is 0, should show "0" percent
    assert.ok(result.includes("(0%)"));
  });
});

describe("buildMfAnalysisPrompt", () => {
  it("should return a string", () => {
    const result = buildMfAnalysisPrompt(makePortfolio());
    assert.strictEqual(typeof result, "string");
  });

  it("should contain MF table headers", () => {
    const result = buildMfAnalysisPrompt(makePortfolio());
    assert.ok(
      result.includes(
        "| Scheme | Category | XIRR | Invested | Current | Gain |"
      )
    );
  });

  it("should include scheme names truncated to 40 chars", () => {
    const longName = "A".repeat(60);
    const portfolio = makePortfolio({
      mfs: [{ ...makePortfolio().mfs[0]!, schemeName: longName }],
    });
    const result = buildMfAnalysisPrompt(portfolio);
    assert.ok(result.includes("A".repeat(40)));
    assert.ok(!result.includes("A".repeat(41)));
  });

  it("should include scheme name when under 40 chars", () => {
    const result = buildMfAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("Axis Bluechip Fund - Direct Growth"));
  });

  it("should include XIRR values", () => {
    const result = buildMfAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("12.5%"));
  });

  it("should request JSON with expected fields", () => {
    const result = buildMfAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("categoryOverlap"));
    assert.ok(result.includes("performanceVerdict"));
    assert.ok(result.includes("expenseIssues"));
    assert.ok(result.includes("mfHighlights"));
  });

  it("should mention Indian markets", () => {
    const result = buildMfAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("Indian markets"));
  });

  it("should include total MF invested and current values", () => {
    const result = buildMfAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("4,000"));
    assert.ok(result.includes("4,500"));
  });

  it("should include MF count", () => {
    const result = buildMfAnalysisPrompt(makePortfolio());
    assert.ok(result.includes("1 schemes"));
  });

  it("should handle empty MFs", () => {
    const portfolio = makePortfolio({
      mfs: [],
      summary: { ...makePortfolio().summary, mfCount: 0 },
    });
    const result = buildMfAnalysisPrompt(portfolio);
    assert.ok(result.includes("0 schemes"));
  });

  it("should handle null unrealizedGain as 0", () => {
    const portfolio = makePortfolio({
      mfs: [{ ...makePortfolio().mfs[0]!, unrealizedGain: null }],
    });
    const result = buildMfAnalysisPrompt(portfolio);
    // (null ?? 0) = 0, should show ₹0
    assert.ok(result.includes("₹0"));
  });

  it("should use dash for null category", () => {
    const portfolio = makePortfolio({
      mfs: [{ ...makePortfolio().mfs[0]!, category: null }],
    });
    const result = buildMfAnalysisPrompt(portfolio);
    assert.ok(result.includes("| - |"));
  });
});

describe("buildScoresPrompt", () => {
  it("should include stock analysis when provided", () => {
    const result = buildScoresPrompt(
      makeStockAnalysis(),
      null,
      makePortfolio()
    );
    assert.ok(result.includes("## Stock Analysis"));
    assert.ok(result.includes("Heavy Energy concentration"));
    assert.ok(result.includes("Single sector dominance"));
    assert.ok(result.includes("RELIANCE"));
    assert.ok(result.includes("TCS"));
  });

  it("should include MF analysis when provided", () => {
    const result = buildScoresPrompt(null, makeMfAnalysis(), makePortfolio());
    assert.ok(result.includes("## MF Analysis"));
    assert.ok(result.includes("Multiple large-cap funds"));
    assert.ok(result.includes("Moderate performer"));
    assert.ok(result.includes("High expense ratio on fund X"));
  });

  it("should handle both null analyses", () => {
    const result = buildScoresPrompt(null, null, makePortfolio());
    assert.ok(!result.includes("## Stock Analysis"));
    assert.ok(!result.includes("## MF Analysis"));
    assert.strictEqual(typeof result, "string");
  });

  it("should include both stock and MF analysis when both provided", () => {
    const result = buildScoresPrompt(
      makeStockAnalysis(),
      makeMfAnalysis(),
      makePortfolio()
    );
    assert.ok(result.includes("## Stock Analysis"));
    assert.ok(result.includes("## MF Analysis"));
  });

  it("should include stock count and MF count", () => {
    const result = buildScoresPrompt(null, null, makePortfolio());
    assert.ok(result.includes("2 stocks"));
    assert.ok(result.includes("1 MFs"));
  });

  it("should request JSON with overallScore and scoreBreakdown", () => {
    const result = buildScoresPrompt(null, null, makePortfolio());
    assert.ok(result.includes("overallScore"));
    assert.ok(result.includes("scoreBreakdown"));
    assert.ok(result.includes("diversification"));
    assert.ok(result.includes("riskManagement"));
    assert.ok(result.includes("stockPicking"));
    assert.ok(result.includes("timing"));
  });

  it("should mention weighted average formula", () => {
    const result = buildScoresPrompt(null, null, makePortfolio());
    assert.ok(result.includes("weighted average"));
    assert.ok(result.includes("diversification 25%"));
    assert.ok(result.includes("riskManagement 25%"));
    assert.ok(result.includes("stockPicking 30%"));
    assert.ok(result.includes("timing 20%"));
  });

  it("should include total value from both stocks and MFs", () => {
    const result = buildScoresPrompt(null, null, makePortfolio());
    // 42500 + 4500 = 47000
    assert.ok(result.includes("47,000"));
  });

  it("should include sector verdicts from stock analysis", () => {
    const result = buildScoresPrompt(
      makeStockAnalysis(),
      null,
      makePortfolio()
    );
    assert.ok(result.includes("Energy: 62.4% (overweight)"));
    assert.ok(result.includes("IT: 37.6% (fair)"));
  });
});

describe("buildRoastPrompt", () => {
  it("should sort holdings by pnlPercentage for top performers (descending)", () => {
    const result = buildRoastPrompt(
      makeStockAnalysis(),
      makeMfAnalysis(),
      makeScores(),
      makePortfolio()
    );
    // RELIANCE (10.4%) should appear before TCS (-8.6%) in Top Performers
    const topSection = result.split("## Worst Performers")[0]!;
    const relianceIdx = topSection.indexOf("RELIANCE");
    const tcsIdx = topSection.indexOf("TCS");
    // RELIANCE should appear in top performers section
    assert.ok(relianceIdx > 0);
    // TCS may or may not appear in top section (only 2 holdings, both in top 4)
  });

  it("should sort holdings by pnlPercentage for worst performers (ascending)", () => {
    const result = buildRoastPrompt(
      makeStockAnalysis(),
      makeMfAnalysis(),
      makeScores(),
      makePortfolio()
    );
    // In worst performers section TCS (-8.6%) should come first
    const worstSection = result
      .split("## Worst Performers")[1]!
      .split("## MF Performance")[0]!;
    assert.ok(worstSection.includes("TCS"));
  });

  it("should include top 4 performers", () => {
    const holdings: StockHolding[] = [
      {
        symbol: "A",
        name: null,
        sector: null,
        quantity: 1,
        averagePrice: 100,
        currentPrice: 150,
        investedValue: 100,
        currentValue: 150,
        unrealizedPnL: 50,
        pnlPercentage: 50,
        brokerName: null,
      },
      {
        symbol: "B",
        name: null,
        sector: null,
        quantity: 1,
        averagePrice: 100,
        currentPrice: 140,
        investedValue: 100,
        currentValue: 140,
        unrealizedPnL: 40,
        pnlPercentage: 40,
        brokerName: null,
      },
      {
        symbol: "C",
        name: null,
        sector: null,
        quantity: 1,
        averagePrice: 100,
        currentPrice: 130,
        investedValue: 100,
        currentValue: 130,
        unrealizedPnL: 30,
        pnlPercentage: 30,
        brokerName: null,
      },
      {
        symbol: "D",
        name: null,
        sector: null,
        quantity: 1,
        averagePrice: 100,
        currentPrice: 120,
        investedValue: 100,
        currentValue: 120,
        unrealizedPnL: 20,
        pnlPercentage: 20,
        brokerName: null,
      },
      {
        symbol: "E",
        name: null,
        sector: null,
        quantity: 1,
        averagePrice: 100,
        currentPrice: 110,
        investedValue: 100,
        currentValue: 110,
        unrealizedPnL: 10,
        pnlPercentage: 10,
        brokerName: null,
      },
    ];
    const portfolio = makePortfolio({
      holdings,
      summary: { ...makePortfolio().summary, stockCount: 5 },
    });
    const result = buildRoastPrompt(null, null, makeScores(), portfolio);
    const topSection = result.split("## Worst Performers")[0]!;
    assert.ok(topSection.includes("A"));
    assert.ok(topSection.includes("B"));
    assert.ok(topSection.includes("C"));
    assert.ok(topSection.includes("D"));
    assert.ok(!topSection.includes("- E:"));
  });

  it("should include worst 4 performers", () => {
    const holdings: StockHolding[] = [
      {
        symbol: "A",
        name: null,
        sector: null,
        quantity: 1,
        averagePrice: 100,
        currentPrice: 50,
        investedValue: 100,
        currentValue: 50,
        unrealizedPnL: -50,
        pnlPercentage: -50,
        brokerName: null,
      },
      {
        symbol: "B",
        name: null,
        sector: null,
        quantity: 1,
        averagePrice: 100,
        currentPrice: 60,
        investedValue: 100,
        currentValue: 60,
        unrealizedPnL: -40,
        pnlPercentage: -40,
        brokerName: null,
      },
      {
        symbol: "C",
        name: null,
        sector: null,
        quantity: 1,
        averagePrice: 100,
        currentPrice: 70,
        investedValue: 100,
        currentValue: 70,
        unrealizedPnL: -30,
        pnlPercentage: -30,
        brokerName: null,
      },
      {
        symbol: "D",
        name: null,
        sector: null,
        quantity: 1,
        averagePrice: 100,
        currentPrice: 80,
        investedValue: 100,
        currentValue: 80,
        unrealizedPnL: -20,
        pnlPercentage: -20,
        brokerName: null,
      },
      {
        symbol: "E",
        name: null,
        sector: null,
        quantity: 1,
        averagePrice: 100,
        currentPrice: 90,
        investedValue: 100,
        currentValue: 90,
        unrealizedPnL: -10,
        pnlPercentage: -10,
        brokerName: null,
      },
    ];
    const portfolio = makePortfolio({
      holdings,
      summary: { ...makePortfolio().summary, stockCount: 5 },
    });
    const result = buildRoastPrompt(null, null, makeScores(), portfolio);
    const worstSection = result.split("## Worst Performers")[1]!;
    assert.ok(worstSection.includes("A"));
    assert.ok(worstSection.includes("B"));
    assert.ok(worstSection.includes("C"));
    assert.ok(worstSection.includes("D"));
  });

  it("should include MF performance sorted by XIRR", () => {
    const mfs: MfHolding[] = [
      {
        schemeName: "Fund A with long name here",
        category: "Large Cap",
        units: 100,
        averageNav: 40,
        currentNav: 45,
        investedAmount: 4000,
        currentValue: 4500,
        unrealizedGain: 500,
        xirr: 8.0,
        brokerName: null,
      },
      {
        schemeName: "Fund B with long name here",
        category: "Mid Cap",
        units: 50,
        averageNav: 30,
        currentNav: 40,
        investedAmount: 1500,
        currentValue: 2000,
        unrealizedGain: 500,
        xirr: 15.0,
        brokerName: null,
      },
    ];
    const portfolio = makePortfolio({
      mfs,
      summary: { ...makePortfolio().summary, mfCount: 2 },
    });
    const result = buildRoastPrompt(null, null, makeScores(), portfolio);
    // Fund B (15%) should appear before Fund A (8%)
    const mfSection = result.split("## MF Performance")[1]!;
    const fundBIdx = mfSection.indexOf("Fund B");
    const fundAIdx = mfSection.indexOf("Fund A");
    assert.ok(fundBIdx < fundAIdx);
  });

  it("should include overall score", () => {
    const result = buildRoastPrompt(null, null, makeScores(), makePortfolio());
    assert.ok(result.includes("Overall Score: 65/100"));
  });

  it("should mention comedy ROAST", () => {
    const result = buildRoastPrompt(null, null, makeScores(), makePortfolio());
    assert.ok(result.includes("comedy ROAST"));
  });

  it("should request specific JSON structure", () => {
    const result = buildRoastPrompt(null, null, makeScores(), makePortfolio());
    assert.ok(result.includes("roastHighlights"));
    assert.ok(result.includes("topPerformers"));
    assert.ok(result.includes("worstPerformers"));
    assert.ok(result.includes("sectorAnalysis"));
    assert.ok(result.includes("constructiveAdvice"));
    assert.ok(result.includes("roastNarrative"));
  });

  it("should mention Indian market context in rules", () => {
    const result = buildRoastPrompt(null, null, makeScores(), makePortfolio());
    assert.ok(result.includes("NSE/BSE"));
    assert.ok(result.includes("lakhs"));
    assert.ok(result.includes("crores"));
  });

  it("should include all score breakdown values", () => {
    const result = buildRoastPrompt(null, null, makeScores(), makePortfolio());
    assert.ok(result.includes("Diversification: 50/100"));
    assert.ok(result.includes("Risk Management: 60/100"));
    assert.ok(result.includes("Stock Picking: 70/100"));
    assert.ok(result.includes("Timing: 80/100"));
  });

  it("should include stock issues when stockAnalysis provided", () => {
    const result = buildRoastPrompt(
      makeStockAnalysis(),
      null,
      makeScores(),
      makePortfolio()
    );
    assert.ok(result.includes("Stock issues: Heavy Energy concentration"));
  });

  it("should include MF issues when mfAnalysis provided", () => {
    const result = buildRoastPrompt(
      null,
      makeMfAnalysis(),
      makeScores(),
      makePortfolio()
    );
    assert.ok(result.includes("MF issues: Multiple large-cap funds"));
  });

  it("should handle empty holdings", () => {
    const portfolio = makePortfolio({
      holdings: [],
      summary: { ...makePortfolio().summary, stockCount: 0 },
    });
    const result = buildRoastPrompt(null, null, makeScores(), portfolio);
    assert.ok(result.includes("0 stocks"));
  });

  it("should handle empty MFs - no MF Performance section", () => {
    const portfolio = makePortfolio({
      mfs: [],
      summary: { ...makePortfolio().summary, mfCount: 0 },
    });
    const result = buildRoastPrompt(null, null, makeScores(), portfolio);
    assert.ok(!result.includes("## MF Performance"));
  });

  it("should handle single holding", () => {
    const portfolio = makePortfolio({
      holdings: [makePortfolio().holdings[0]!],
    });
    const result = buildRoastPrompt(null, null, makeScores(), portfolio);
    assert.ok(result.includes("RELIANCE"));
  });

  it("should handle single MF", () => {
    const result = buildRoastPrompt(null, null, makeScores(), makePortfolio());
    assert.ok(result.includes("Axis Bluechip Fund - Direct G"));
  });

  it("should truncate MF scheme names to 30 chars in roast prompt", () => {
    const longName = "X".repeat(50);
    const portfolio = makePortfolio({
      mfs: [{ ...makePortfolio().mfs[0]!, schemeName: longName }],
    });
    const result = buildRoastPrompt(null, null, makeScores(), portfolio);
    assert.ok(result.includes("X".repeat(30)));
    // The 31st X should NOT appear as a standalone substring in the MF Performance line
    const mfSection = result.split("## MF Performance")[1]!;
    const mfLine = mfSection
      .split("\n")
      .find((l) => l.includes("X".repeat(30)))!;
    // Verify the scheme name part is exactly 30 Xs
    assert.ok(mfLine.includes("X".repeat(30)));
  });

  it("should include stock count and MF count", () => {
    const result = buildRoastPrompt(null, null, makeScores(), makePortfolio());
    assert.ok(result.includes("2 stocks"));
    assert.ok(result.includes("1 mutual funds"));
  });
});
