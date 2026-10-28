/**
 * Strategy Analysis Skill
 *
 * Handles queries about trading strategies, technical indicator evaluation,
 * and stock screening by technical criteria.
 *
 * Triggers:
 * - "Which NIFTY stocks show golden cross?"
 * - "Scan for RSI oversold stocks"
 * - "Apply RSI and MACD to Reliance"
 * - "Does TCS match momentum strategy?"
 * - "Find stocks where RSI < 30 and price below SMA200"
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import {
  extractSymbolsFromQuery,
  resolveSymbol,
} from "../data-sources/symbol-resolver";

// NIFTY 50 components (default scan universe)
const NIFTY50 = [
  "RELIANCE.NS",
  "TCS.NS",
  "HDFCBANK.NS",
  "INFY.NS",
  "ICICIBANK.NS",
  "HINDUNILVR.NS",
  "SBIN.NS",
  "BHARTIARTL.NS",
  "ITC.NS",
  "KOTAKBANK.NS",
  "LT.NS",
  "AXISBANK.NS",
  "ASIANPAINT.NS",
  "MARUTI.NS",
  "HCLTECH.NS",
  "SUNPHARMA.NS",
  "TATAMOTORS.NS",
  "BAJFINANCE.NS",
  "TITAN.NS",
  "WIPRO.NS",
  "ULTRACEMCO.NS",
  "NESTLEIND.NS",
  "NTPC.NS",
  "POWERGRID.NS",
  "TATASTEEL.NS",
  "ADANIENT.NS",
  "ADANIPORTS.NS",
  "ONGC.NS",
  "COALINDIA.NS",
  "JSWSTEEL.NS",
  "M&M.NS",
  "BAJAJFINSV.NS",
  "TECHM.NS",
  "INDUSINDBK.NS",
  "HINDALCO.NS",
  "DIVISLAB.NS",
  "DRREDDY.NS",
  "CIPLA.NS",
  "GRASIM.NS",
  "APOLLOHOSP.NS",
  "EICHERMOT.NS",
  "SBILIFE.NS",
  "BPCL.NS",
  "BRITANNIA.NS",
  "TATACONSUM.NS",
  "HDFCLIFE.NS",
  "HEROMOTOCO.NS",
  "BAJAJ-AUTO.NS",
  "SHRIRAMFIN.NS",
  "TRENT.NS",
];

/**
 * Detect if the query is a scanning query (multiple stocks) vs single-stock evaluation.
 */
function isScanQuery(query: string): boolean {
  const q = query.toLowerCase();
  return (
    /\b(which|find|scan|screen|filter|list|show\s+me)\b.*\b(stock|share|nifty|market)\b/.test(
      q,
    ) ||
    /\bnifty\s*(50|100|200|midcap|smallcap)?\b/.test(q) ||
    /\b(stocks?|shares?)\s+(that|where|with|matching|showing)\b/.test(q)
  );
}

export const strategyAnalysisSkill: ResearchSkill = {
  name: "strategy-analysis",
  description:
    "Evaluate trading strategies against stocks or scan for strategy matches",
  triggers: [
    /\b(strateg|screen|scan|filter)\b.*\b(stock|share|nifty|market)\b/i,
    /\b(golden\s*cross|death\s*cross|rsi\s*(oversold|overbought)|macd\s*(bullish|bearish)|bollinger\s*squeeze)\b/i,
    /\bwhich\s+(stocks?|shares?)\s+(match|meet|fit|satisfy|show)\b/i,
    /\b(apply|run|test|check|evaluate)\s+(indicator|strategy)\b/i,
    /\b(run|test|check|evaluate)\s+.*(strateg)/i,
    /\b(momentum|trend\s*follow|mean\s*reversion|swing\s*trade|breakout)\s*(strateg|scan|screen)/i,
  ],
  requiredParams: ["query"],
  optionalParams: ["symbols", "strategy"],
  buildPlan: (params): ResearchPlan => {
    const query = (params.query as string) || "";
    const symbols = extractSymbolsFromQuery(query).map((s) => resolveSymbol(s));
    const scan = isScanQuery(query);

    if (scan) {
      // Scanning mode: use scan_strategy_multi on NIFTY50 (or user-specified symbols)
      const scanSymbols = symbols.length > 0 ? symbols : NIFTY50;

      const tasks = [
        computeTask(
          "scan",
          "scan_strategy_multi",
          {
            symbols: scanSymbols,
            strategy: params.strategy || {}, // Will be populated by LLM planner if skill is bypassed
            timeframe: "1y",
            limit: 20,
          },
          [],
        ),
        synthesisTask("report", "synthesize_report", { query }, ["scan"]),
      ];

      return {
        query,
        skill: "strategy-analysis",
        symbols: scanSymbols.slice(0, 5), // Show first 5 in metadata
        tasks,
        estimatedSteps: tasks.length,
        complexity: "moderate",
      };
    }

    // Single-stock evaluation: fetch history → evaluate → optionally add fundamentals
    const symbol = symbols[0] || "RELIANCE.NS";

    const tasks = [
      fetchTask("history", "fetch_price_history", {
        symbol,
        period: "1y",
      }),
      fetchTask("profile", "fetch_company_profile", { symbol }),
      fetchTask("ratios", "fetch_key_ratios", { symbol }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),
      computeTask("technicals", "compute_technical_analysis", {}, ["history"]),
      // MONEY-613: surface the built-but-unwired price-based quant tools so the
      // L4 "Technical + patterns" segment carries trend / volatility / drawdown /
      // volume-profile depth (all bind from the 1y price history above).
      computeTask("trend_strength", "compute_trend_strength", {}, ["history"]),
      computeTask("volatility_regime", "compute_volatility_regime", {}, [
        "history",
      ]),
      computeTask("drawdown_profile", "compute_drawdown_profile", {}, [
        "history",
      ]),
      computeTask("volume_profile", "compute_volume_profile", {}, ["history"]),
      computeTask(
        "strategy_eval",
        "evaluate_strategy",
        {
          symbol,
          strategy: params.strategy || {},
        },
        ["history"],
      ),
      synthesisTask("report", "synthesize_report", { query }, [
        "history",
        "profile",
        "ratios",
        "price",
        "technicals",
        "trend_strength",
        "volatility_regime",
        "drawdown_profile",
        "volume_profile",
        "strategy_eval",
      ]),
    ];

    return {
      query,
      skill: "strategy-analysis",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "moderate",
    };
  },
};
