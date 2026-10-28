/**
 * Financial Deep Dive Skill - Balance sheet & cash flow quality
 *
 * Triggers: "financial statement analysis", "balance sheet quality", "cash flow deep dive"
 * Output: 5-year trend analysis, accounting quality scores (Beneish M-Score, Altman Z-Score), red flags
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const financialDeepDiveSkill: ResearchSkill = {
  name: "financial-deep-dive",
  description:
    "Deep analysis of financial statements - 5-year trends, accounting quality, cash flow quality, red flags",
  triggers: [
    /\b(financial\s*statement|balance\s*sheet)\s*(analysis|quality|deep\s*dive|review)\b/i,
    /\b(cash\s*flow|cashflow)\s*(quality|analysis|deep\s*dive)\b/i,
    /\b(accounting|financial)\s*(quality|health|integrity)\b/i,
    /\b(beneish|altman|m.score|z.score)\b/i,
    /\b(red\s*flag|manipulation|fraud\s*detection|forensic)\b.*\b(account|financial)\b/i,
    /\b(account|financial)\b.*\b(red\s*flag|manipulation|fraud\s*detection|forensic)\b/i,
  ],
  requiredParams: ["symbol"],
  optionalParams: ["exchange"],
  buildPlan: (params): ResearchPlan => {
    const symbol = resolveSymbol(
      params.symbol as string,
      (params.exchange as string) || "NSE",
    );

    const tasks = [
      // Phase 1: Data fetch (all financial statements)
      fetchTask("financials", "fetch_income_statement", { symbol }),
      fetchTask("balance", "fetch_balance_sheet", { symbol }),
      fetchTask("cashflow", "fetch_cash_flow", { symbol }),
      fetchTask("ratios", "fetch_key_ratios", { symbol }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),
      fetchTask("profile", "fetch_company_profile", { symbol }),

      // Phase 2: Quality computations
      computeTask("cashflow_quality", "compute_cash_flow_quality", {}, [
        "cashflow",
        "financials",
        "price",
      ]),
      computeTask("earnings_quality", "compute_earnings_quality", {}, [
        "financials",
        "cashflow",
        "balance",
      ]),
      computeTask("accounting_quality", "compute_accounting_quality", {}, [
        "financials",
        "balance",
        "cashflow",
        "price",
      ]),
      computeTask("health", "compute_health_score", {}, ["ratios", "profile"]),
      computeTask("growth", "compute_growth_metrics", {}, ["financials"]),

      // MONEY-613: forensic + working-capital depth. These tools were built +
      // input-bound but no L3/L4 segment ever invoked them, so their data never
      // reached the report (the skill's own doc promised Altman/forensic scores
      // it never produced). Now wired into the financials deep-dive.
      computeTask("piotroski", "compute_piotroski", {}, [
        "financials",
        "balance",
        "cashflow",
      ]),
      computeTask("altman_z", "compute_altman_z", {}, [
        "financials",
        "balance",
      ]),
      computeTask("beneish_m", "compute_beneish_m", {}, [
        "financials",
        "balance",
        "cashflow",
      ]),
      computeTask("working_capital", "compute_working_capital_drag", {}, [
        "financials",
        "balance",
      ]),
      computeTask("fcf_yield", "compute_fcf_yield", {}, [
        "financials",
        "balance",
        "cashflow",
        "price",
      ]),
      computeTask("capex_intensity", "compute_capex_intensity", {}, [
        "financials",
        "cashflow",
      ]),

      // Phase 3: Synthesis
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query: params.query || `Financial deep dive of ${params.symbol}`,
        },
        [
          "financials",
          "balance",
          "cashflow",
          "ratios",
          "price",
          "profile",
          "cashflow_quality",
          "earnings_quality",
          "accounting_quality",
          "health",
          "growth",
          "piotroski",
          "altman_z",
          "beneish_m",
          "working_capital",
          "fcf_yield",
          "capex_intensity",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) || `Financial deep dive of ${params.symbol}`,
      skill: "financial-deep-dive",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
