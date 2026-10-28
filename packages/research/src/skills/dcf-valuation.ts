/**
 * DCF Valuation Skill - Intrinsic value calculation
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const dcfValuationSkill: ResearchSkill = {
  name: "dcf-valuation",
  description: "Calculate intrinsic value using DCF model",
  triggers: [
    /\b(dcf|intrinsic\s*value|fair\s*value|valuation)\b/i,
    /\b(what.*worth|true\s*value|undervalued|overvalued)\b/i,
  ],
  requiredParams: ["symbol"],
  buildPlan: (params): ResearchPlan => {
    const symbol = resolveSymbol(params.symbol as string);

    const tasks = [
      fetchTask("profile", "fetch_company_profile", { symbol }),
      fetchTask("cashflow", "fetch_cash_flow", { symbol }),
      fetchTask("financials", "fetch_income_statement", { symbol }),
      fetchTask("ratios", "fetch_key_ratios", { symbol }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),
      fetchTask("earnings", "fetch_earnings", { symbol }),
      // `financials` is required so the executor can plumb netIncome
      // through as the third-tier FCF fallback (compute-dcf.ts L82-83) when
      // upstream cash-flow returns empty annual data for shorter histories.
      computeTask("dcf", "compute_dcf", {}, [
        "cashflow",
        "financials",
        "price",
        "ratios",
      ]),
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) || `DCF valuation of ${params.symbol}`,
        },
        [
          "profile",
          "cashflow",
          "financials",
          "ratios",
          "price",
          "earnings",
          "dcf",
        ],
      ),
    ];

    return {
      query: (params.query as string) || `DCF valuation of ${params.symbol}`,
      skill: "dcf-valuation",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "moderate",
    };
  },
};
