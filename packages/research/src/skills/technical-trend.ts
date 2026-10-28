/**
 * Technical Trend Skill - Price action, trend strength & volume profile
 *
 * Triggers: "technical analysis of TCS", "trend strength for RELIANCE",
 *   "volume profile of HDFC", "chart analysis (technical)", "RSI / MACD /
 *   moving average read on INFY"
 * Output: trend regime + strength (slope/R²/ADX/SMA stack), volume-by-price
 *   profile (POC, value area, accumulation/distribution), and momentum /
 *   moving-average technicals.
 *
 * SEBI: observation-only. Emits scores / regimes / flags — never a
 *   buy/sell/hold verdict or price target (UseMoney is not a registered
 *   Research Analyst).
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const technicalTrendSkill: ResearchSkill = {
  name: "technical-trend",
  description:
    "Technical & trend analysis from price history - trend strength (slope/R²/ADX/SMA stack), volume profile (POC/value area), and momentum technicals (RSI/MACD/moving averages). Observation-only, no buy/sell/hold verdict.",
  triggers: [
    // "technical analysis of X", "technical setup", "technical trend"
    /\b(technical)\s*(analysis|setup|trend|read|view|outlook)\b/i,
    // "trend analysis", "trend strength", "price trend", "trend direction"
    /\b(trend)\s*(analysis|strength|direction|setup|regime)\b/i,
    /\b(price|momentum)\s*(trend|action)\b/i,
    // "volume profile", "volume by price", "point of control / value area"
    /\b(volume\s*profile|volume[-\s]?by[-\s]?price|point\s*of\s*control|value\s*area)\b/i,
    // explicitly technical "chart analysis" (vs chart-pattern-detection skill)
    /\b(chart)\s*(analysis|read|technicals?)\b/i,
    // momentum indicator reads: RSI / MACD / moving average(s) / SMA / EMA
    /\b(rsi|macd|moving\s*average(s)?|\bsma\b|\bema\b|adx|bollinger|stochastic)\b/i,
  ],
  requiredParams: ["symbol"],
  optionalParams: ["exchange"],
  buildPlan: (params): ResearchPlan => {
    const symbol = resolveSymbol(
      params.symbol as string,
      (params.exchange as string) || "NSE",
    );

    const tasks = [
      // Phase 1: Data fetch (parallel, no deps)
      fetchTask("history", "fetch_price_history", { symbol, period: "1y" }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),

      // Phase 2: Technical computations (all read from fetch_price_history.prices[])
      computeTask("technicals", "compute_technical_analysis", {}, ["history"]),
      computeTask("volume_profile", "compute_volume_profile", {}, ["history"]),
      computeTask("trend_strength", "compute_trend_strength", {}, ["history"]),

      // Phase 3: Synthesis
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Technical & trend analysis of ${params.symbol}`,
        },
        ["history", "price", "technicals", "volume_profile", "trend_strength"],
      ),
    ];

    return {
      query:
        (params.query as string) ||
        `Technical & trend analysis of ${params.symbol}`,
      skill: "technical-trend",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
