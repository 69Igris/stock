/**
 * Investment Thesis Skill - Bull/Bear case builder
 *
 * Triggers: "investment thesis", "bull case", "bear case", "catalysts"
 * Output: Structured thesis with bull/base/bear scenarios, key risks, catalysts, conviction score
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const investmentThesisSkill: ResearchSkill = {
  name: "investment-thesis",
  description:
    "Build a structured investment thesis with bull/base/bear scenarios, catalysts, risks, and conviction score",
  triggers: [
    /\b(investment\s*thesis|invest(ment|ing)\s*case)\b/i,
    /\b(bull|bear|base)\s*(case|scenario|thesis)\b/i,
    /\bcatalysts?\s*(for|of|analysis)\b/i,
    /\b(why|reason)\s*(to\s*)?(buy|sell|invest|avoid)\b/i,
    /\bconviction\s*(score|level|rating)\b/i,
    /\b(risks?\s*and\s*catalysts?|catalysts?\s*and\s*risks?)\b/i,
  ],
  requiredParams: ["symbol"],
  optionalParams: ["exchange"],
  buildPlan: (params): ResearchPlan => {
    const symbol = resolveSymbol(
      params.symbol as string,
      (params.exchange as string) || "NSE",
    );

    const tasks = [
      // Phase 1: Comprehensive data fetch
      fetchTask("profile", "fetch_company_profile", { symbol }),
      fetchTask("ratios", "fetch_key_ratios", { symbol }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),
      fetchTask("history", "fetch_price_history", { symbol, period: "2y" }),
      fetchTask("financials", "fetch_income_statement", { symbol }),
      fetchTask("cashflow", "fetch_cash_flow", { symbol }),
      fetchTask("news", "fetch_news", { symbol }),
      fetchTask("recommendations", "fetch_analyst_recommendations", { symbol }),
      fetchTask("peers", "fetch_peer_companies", { symbol }),
      fetchTask("shareholding", "fetch_shareholding_pattern", { symbol }),

      // Phase 2: Valuation & scenario analysis
      computeTask("wacc", "compute_wacc", {}, ["ratios", "price"]),
      computeTask("dcf", "compute_dcf", {}, [
        "cashflow",
        "price",
        "ratios",
        "wacc",
      ]),
      computeTask("scenarios", "compute_scenario_analysis", {}, [
        "dcf",
        "wacc",
        "price",
      ]),
      computeTask("valuation", "compute_comparative_valuation", {}, [
        "ratios",
        "peers",
        "price",
      ]),
      computeTask("growth", "compute_growth_metrics", {}, ["financials"]),
      computeTask("technicals", "compute_technical_analysis", {}, ["history"]),

      // Phase 3: Thesis synthesis (special prompt for bull/bear framework)
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query: params.query || `Investment thesis for ${params.symbol}`,
          outputFormat: "investment_thesis",
        },
        [
          "profile",
          "ratios",
          "price",
          "history",
          "financials",
          "cashflow",
          "news",
          "recommendations",
          "peers",
          "shareholding",
          "wacc",
          "dcf",
          "scenarios",
          "valuation",
          "growth",
          "technicals",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) || `Investment thesis for ${params.symbol}`,
      skill: "investment-thesis",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
