/**
 * @usemoney/roast - LLM Prompts
 *
 * Focused prompts for each step in the roast pipeline.
 * Each prompt requests structured JSON output.
 */

import type {
  PortfolioData,
  StockAnalysisResult,
  MfAnalysisResult,
  ScoresResult,
} from "./types";

/**
 * MONEY-457: SEBI compliance directive appended to every roast prompt.
 *
 * UseMoney is not a SEBI-registered Research Analyst or Investment Adviser.
 * Roast prose is user-facing and must follow the same constraints as the
 * research / chat surfaces.
 */
const SEBI_COMPLIANCE_FOOTER = `

CRITICAL SEBI COMPLIANCE — UseMoney is NOT a SEBI-registered Research Analyst
or Investment Adviser. These rules OVERRIDE any conflicting instruction above:

- NEVER use: BUY, SELL, HOLD, STRONG_BUY, STRONG_SELL, AVOID, NEUTRAL,
  INVEST, SWITCH, PREFERRED, "target price", "price target",
  "stop loss", "buy zone", "sell zone".
- NEVER use softer recommendation phrases: "strong investment case",
  "attractive opportunity", "good entry", "potential upside of X%",
  "fair value of ₹X", "X is a better pick", "X Preferred",
  "looks promising", "worth considering", "long-term opportunity".
- The roast can be witty about diversification, concentration, sector
  allocation, expense ratios, and concentration risk — but it must NOT
  tell the user to buy, sell, or switch out of any specific stock or
  fund. Frame everything as observations.
- For "bottomPicks", "topPicks", "constructiveAdvice", and similar fields:
  describe WHAT the data shows (e.g. "ROE has fallen 4 years in a row")
  rather than WHAT TO DO (e.g. "consider selling"). Wit is OK; directive
  language is not.
- The disclaimer "This is AI-generated analysis for informational purposes
  only. Not financial advice. Consult a SEBI-registered advisor." is
  always appended by the renderer.`;

export function buildStockAnalysisPrompt(portfolio: PortfolioData): string {
  const { holdings, summary } = portfolio;

  let table =
    "| Symbol | Sector | Qty | Avg Price | Current | P&L % | Value |\n";
  table += "|--------|--------|-----|-----------|---------|-------|-------|\n";
  for (const h of holdings) {
    table += `| ${h.symbol} | ${h.sector || "-"} | ${h.quantity} | ₹${h.averagePrice.toFixed(0)} | ₹${h.currentPrice.toFixed(0)} | ${h.pnlPercentage.toFixed(1)}% | ₹${h.currentValue.toLocaleString("en-IN")} |\n`;
  }

  let sectorInfo = "";
  for (const s of summary.sectorConcentration) {
    sectorInfo += `- ${s.sector}: ₹${s.value.toLocaleString("en-IN")} (${s.percentage.toFixed(1)}%)\n`;
  }

  return `You are a financial analyst specializing in Indian equities. Analyze this stock portfolio for diversification, risk, and quality.

## Stock Holdings (${holdings.length} stocks)
Total Invested: ₹${summary.totalStockInvested.toLocaleString("en-IN")}
Current Value: ₹${summary.totalStockCurrent.toLocaleString("en-IN")}
P&L: ₹${(summary.totalStockCurrent - summary.totalStockInvested).toLocaleString("en-IN")} (${summary.totalStockInvested > 0 ? (((summary.totalStockCurrent - summary.totalStockInvested) / summary.totalStockInvested) * 100).toFixed(1) : "0"}%)

${table}

## Sector Concentration
${sectorInfo}

Respond with JSON matching this schema:
{
  "diversificationIssues": ["<issue description>", ...],
  "sectorConcentration": [{"sector": "<name>", "percentage": <number>, "verdict": "overweight"|"underweight"|"fair"}],
  "topPicks": [{"symbol": "<TICKER>", "reason": "<why it's good>"}],
  "bottomPicks": [{"symbol": "<TICKER>", "reason": "<why it's concerning>"}],
  "riskFlags": ["<risk description>", ...]
}

RULES:
- Focus on Indian market context (NSE/BSE, ₹)
- Identify sector concentration > 30% as risky
- Flag single stock > 15% of portfolio
- Identify 2-4 top and bottom picks by P&L and quality (description only — no "consider selling" / "consider buying" framing)
- Be specific and data-driven${SEBI_COMPLIANCE_FOOTER}`;
}

export function buildMfAnalysisPrompt(portfolio: PortfolioData): string {
  const { mfs, summary } = portfolio;

  let table = "| Scheme | Category | XIRR | Invested | Current | Gain |\n";
  table += "|--------|----------|------|----------|---------|------|\n";
  for (const m of mfs) {
    table += `| ${m.schemeName.slice(0, 40)} | ${m.category || "-"} | ${m.xirr.toFixed(1)}% | ₹${m.investedAmount.toLocaleString("en-IN")} | ₹${m.currentValue.toLocaleString("en-IN")} | ₹${(m.unrealizedGain ?? 0).toLocaleString("en-IN")} |\n`;
  }

  return `You are a mutual fund analyst specializing in Indian markets. Analyze this mutual fund portfolio.

## Mutual Fund Holdings (${mfs.length} schemes)
Total Invested: ₹${summary.totalMfInvested.toLocaleString("en-IN")}
Current Value: ₹${summary.totalMfCurrent.toLocaleString("en-IN")}
P&L: ₹${(summary.totalMfCurrent - summary.totalMfInvested).toLocaleString("en-IN")}

${table}

Respond with JSON matching this schema:
{
  "categoryOverlap": ["<overlap description>", ...],
  "performanceVerdict": "<overall assessment of MF portfolio performance>",
  "expenseIssues": ["<expense-related concern>", ...],
  "mfHighlights": [{"scheme": "<name>", "verdict": "<assessment>"}]
}

RULES:
- Identify category overlap (e.g. multiple large-cap funds)
- Flag underperforming schemes (XIRR < 8%)
- Note expense ratio concerns if applicable
- Highlight 3-5 notable schemes (good or bad) — observation only, no "switch out" / "consider redeeming" framing
- Use Indian market context${SEBI_COMPLIANCE_FOOTER}`;
}

export function buildScoresPrompt(
  stockAnalysis: StockAnalysisResult | null,
  mfAnalysis: MfAnalysisResult | null,
  portfolio: PortfolioData,
): string {
  const analyses: string[] = [];

  if (stockAnalysis) {
    analyses.push(`## Stock Analysis
- Diversification issues: ${stockAnalysis.diversificationIssues.join("; ")}
- Risk flags: ${stockAnalysis.riskFlags.join("; ")}
- Top picks: ${stockAnalysis.topPicks.map((p) => p.symbol).join(", ")}
- Bottom picks: ${stockAnalysis.bottomPicks.map((p) => p.symbol).join(", ")}
- Sectors: ${stockAnalysis.sectorConcentration.map((s) => `${s.sector}: ${s.percentage}% (${s.verdict})`).join(", ")}`);
  }

  if (mfAnalysis) {
    analyses.push(`## MF Analysis
- Category overlap: ${mfAnalysis.categoryOverlap.join("; ")}
- Performance: ${mfAnalysis.performanceVerdict}
- Expense issues: ${mfAnalysis.expenseIssues.join("; ")}`);
  }

  return `Based on the following portfolio analysis, generate scores for 4 categories.

Portfolio: ${portfolio.summary.stockCount} stocks, ${portfolio.summary.mfCount} MFs
Total Value: ₹${(portfolio.summary.totalStockCurrent + portfolio.summary.totalMfCurrent).toLocaleString("en-IN")}

${analyses.join("\n\n")}

Respond with JSON:
{
  "overallScore": <0-100>,
  "scoreBreakdown": {
    "diversification": {"score": <0-100>, "comment": "<1-2 sentence savage comment>"},
    "riskManagement": {"score": <0-100>, "comment": "<1-2 sentence savage comment>"},
    "stockPicking": {"score": <0-100>, "comment": "<1-2 sentence savage comment>"},
    "timing": {"score": <0-100>, "comment": "<1-2 sentence savage comment>"}
  }
}

RULES:
- overallScore = weighted average (diversification 25%, riskManagement 25%, stockPicking 30%, timing 20%)
- Comments should be brutally honest but insightful, like a comedy roast — without directing the user to buy / sell / switch any specific holding
- Base scores strictly on the analysis data${SEBI_COMPLIANCE_FOOTER}`;
}

export function buildRoastPrompt(
  stockAnalysis: StockAnalysisResult | null,
  mfAnalysis: MfAnalysisResult | null,
  scores: ScoresResult,
  portfolio: PortfolioData,
  scope: "PORTFOLIO" | "TRADEBOOK" = "PORTFOLIO",
): string {
  const topPerformers = portfolio.holdings
    .sort((a, b) => b.pnlPercentage - a.pnlPercentage)
    .slice(0, 4);
  const worstPerformers = portfolio.holdings
    .sort((a, b) => a.pnlPercentage - b.pnlPercentage)
    .slice(0, 4);

  let performerInfo = "## Top Performers\n";
  for (const p of topPerformers) {
    performerInfo += `- ${p.symbol}: ${p.pnlPercentage.toFixed(1)}%\n`;
  }
  performerInfo += "\n## Worst Performers\n";
  for (const p of worstPerformers) {
    performerInfo += `- ${p.symbol}: ${p.pnlPercentage.toFixed(1)}%\n`;
  }

  const mfPerformers = portfolio.mfs.sort((a, b) => b.xirr - a.xirr);
  if (mfPerformers.length > 0) {
    performerInfo += "\n## MF Performance\n";
    for (const m of mfPerformers.slice(0, 3)) {
      performerInfo += `- ${m.schemeName.slice(0, 30)}: XIRR ${m.xirr.toFixed(1)}%\n`;
    }
  }

  // MONEY-837: real trade behaviour for a TRADEBOOK-scoped roast.
  let tradeInfo = "";
  const ts = portfolio.tradeStats;
  if (scope === "TRADEBOOK" && ts && ts.totalTrades > 0) {
    const span =
      ts.firstTrade && ts.lastTrade
        ? `${ts.firstTrade.toISOString().slice(0, 10)} to ${ts.lastTrade
            .toISOString()
            .slice(0, 10)}`
        : "n/a";
    const decided = ts.winningTrades + ts.losingTrades;
    const winRate =
      decided > 0
        ? `${((ts.winningTrades / decided) * 100).toFixed(0)}%`
        : "n/a";
    tradeInfo =
      `\n## Trading Behaviour (the actual trades in scope)\n` +
      `- ${ts.totalTrades} trades (${ts.buys} buys, ${ts.sells} sells) across ${ts.distinctSymbols} symbols, ${span}\n` +
      `- Turnover: Rs ${Math.round(ts.turnover).toLocaleString("en-IN")}\n` +
      `- Realised P&L: Rs ${Math.round(ts.realizedPnL).toLocaleString("en-IN")} (${ts.winningTrades} winners / ${ts.losingTrades} losers, win-rate ${winRate})\n` +
      `- Most-traded: ${ts.topSymbols.map((s) => `${s.symbol} x${s.trades}`).join(", ") || "n/a"}\n`;
  }

  const scopeHeader =
    scope === "TRADEBOOK"
      ? `You are a witty, savage, but ultimately helpful financial analyst roasting someone's TRADING BEHAVIOUR (entry/exit timing, churn, realised P&L vs hold, behaviour gap, stop-loss discipline).
Bias the narrative toward HOW they traded - not just what they hold. Call out specific moves: did they sell winners too early? Add to losers? Chase momentum? Stay disciplined? Use the worst/top performers as evidence.`
      : `You are a witty, savage, but ultimately helpful financial analyst hosting a comedy ROAST of someone's portfolio.
Your tone: brutally honest, funny, sarcastic, entertaining - but with genuine financial insights underneath.`;

  return `${scopeHeader}

## Portfolio Data
- ${portfolio.summary.stockCount} stocks, ${portfolio.summary.mfCount} mutual funds
- Overall Score: ${scores.overallScore}/100
- Diversification: ${scores.scoreBreakdown.diversification.score}/100
- Risk Management: ${scores.scoreBreakdown.riskManagement.score}/100
- Stock Picking: ${scores.scoreBreakdown.stockPicking.score}/100
- Timing: ${scores.scoreBreakdown.timing.score}/100

${performerInfo}
${tradeInfo}
${stockAnalysis ? `Stock issues: ${stockAnalysis.diversificationIssues.join("; ")}` : ""}
${mfAnalysis ? `MF issues: ${mfAnalysis.categoryOverlap.join("; ")}` : ""}

Respond with JSON:
{
  "roastHighlights": [
    {"type": "burn"|"praise", "emoji": "<single emoji>", "title": "<catchy title>", "description": "<1-2 sentence roast comment>"}
  ],
  "topPerformers": [
    {"symbol": "<TICKER or SCHEME>", "pnlPercent": <number>, "roast": "<witty comment>"}
  ],
  "worstPerformers": [
    {"symbol": "<TICKER or SCHEME>", "pnlPercent": <number>, "roast": "<witty comment>"}
  ],
  "sectorAnalysis": [
    {"sector": "<name>", "percentage": <number>, "verdict": "overweight"|"underweight"|"fair", "comment": "<witty comment>"}
  ],
  "constructiveAdvice": [
    {"title": "<actionable title>", "description": "<specific advice>"}
  ],
  "roastNarrative": "<2-3 paragraph funny narrative roast tying everything together>"
}

RULES:
- roastHighlights: 4-6 items, mix of "burn" and "praise"
- topPerformers: 2-4 best by P&L%
- worstPerformers: 2-4 worst by P&L%
- sectorAnalysis: cover all major sectors present
- constructiveAdvice: 3-4 genuinely useful tips — phrase as observations / principles (e.g. "Concentration over 30% in one sector amplifies cycle risk") NOT as directives ("sell X" / "buy Y")
- roastNarrative: the HIGHLIGHT - entertaining, funny, but insightful and recommendation-free
- Use Indian market context (NSE/BSE, ₹, lakhs, crores)
- Base ALL commentary on actual data provided${SEBI_COMPLIANCE_FOOTER}`;
}
