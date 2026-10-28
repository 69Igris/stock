/**
 * Dividend Income Skill - Dividend yield, safety & sustainability
 *
 * Triggers: "dividend analysis", "dividend yield/safety/sustainability",
 *           "payout ratio / dividend coverage", "income investing"
 * Output: dividend yield & history, payout/coverage ratios, FCF-backed
 *         sustainability read, and a dividend discount model (DDM) value.
 *
 * SEBI: observation-only. No buy/sell/hold recommendations are produced;
 * the synthesizer reports dividend facts and ratios, not advice.
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const dividendIncomeSkill: ResearchSkill = {
  name: "dividend-income",
  description:
    "Dividend income analysis - yield & history, payout ratio and FCF coverage, dividend safety/sustainability, and a dividend discount model (DDM) value for income investors",
  triggers: [
    // dividend + (analysis | yield | income | safety | sustainability | ...)
    /\bdividend\s*(analysis|yield|income|safety|sustainab\w*|growth|history|track\s*record)\b/i,
    // "is the dividend safe", "safe dividend", "sustainable dividend"
    /\b(safe|safety|sustainab\w*|secure)\b.*\bdividend\b/i,
    /\bdividend\b.*\b(safe|safety|sustainab\w*|secure)\b/i,
    // payout ratio OR dividend coverage / cover
    /\bpayout\s*(ratio|coverage|cover)\b/i,
    /\bdividend\s*(coverage|cover)\b/i,
    // income investing intent
    /\bincome\s*(investing|investor|portfolio|stock|stocks)\b/i,
    // explicit income-strategy phrasing
    /\b(dividend\s*discount\s*model|ddm)\b/i,
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
      fetchTask("ratios", "fetch_key_ratios", { symbol }),
      fetchTask("cashflow", "fetch_cash_flow", { symbol }),
      fetchTask("financials", "fetch_income_statement", { symbol }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),

      // Phase 2: Dividend computations
      // DDM needs forward yield/growth inputs (ratios) + current price.
      computeTask("ddm", "compute_ddm", {}, ["ratios", "price"]),
      // Dividend analysis: yield, history, growth (ratios) vs FCF (cashflow) & price.
      computeTask("dividend_analysis", "compute_dividend_analysis", {}, [
        "ratios",
        "cashflow",
        "price",
      ]),
      // Payout coverage: payout ratio (ratios/financials) vs FCF backing (cashflow), priced.
      computeTask("payout_coverage", "compute_payout_coverage", {}, [
        "cashflow",
        "financials",
        "ratios",
        "price",
      ]),

      // Phase 3: Synthesis (depends on ALL prior task ids)
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Dividend income analysis of ${params.symbol}`,
        },
        [
          "ratios",
          "cashflow",
          "financials",
          "price",
          "ddm",
          "dividend_analysis",
          "payout_coverage",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) ||
        `Dividend income analysis of ${params.symbol}`,
      skill: "dividend-income",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
