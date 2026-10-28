/**
 * Cash Flow Quality Skill - Cash generation, capex burden & free-cash-flow economics
 *
 * Triggers: "cash flow quality", "capex intensity", "fcf yield", "free cash flow yield",
 *           "working capital", "cash conversion"
 * Output: cash conversion vs reported earnings, capex intensity trend, FCF yield,
 *         working-capital drag on operating cash flow. Observation-only (SEBI).
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const cashFlowQualitySkill: ResearchSkill = {
  name: "cash-flow-quality",
  description:
    "Cash-flow quality assessment - cash conversion vs earnings, capex intensity, free-cash-flow yield, and working-capital drag on operating cash flow",
  triggers: [
    // "cash flow quality" / "quality of cash flow" / "cash flow generation quality"
    /\b(cash\s*flow|cashflow)\b.*\b(quality|generation\s*quality)\b/i,
    /\bquality\s+of\s+(cash\s*flow|cashflow)\b/i,
    // "capex intensity" / "capital expenditure intensity"
    /\b(capex|capital\s*expenditure)\s*(intensity|burden|trend)\b/i,
    // "fcf yield" / "free cash flow yield"
    /\b(fcf|free\s*cash\s*flow)\s*yield\b/i,
    /\bfree\s*cash\s*flow\b.*\byield\b/i,
    // "working capital" (drag / cycle / changes / efficiency)
    /\bworking\s*capital\b/i,
    // "cash conversion" / "cash conversion cycle" / "cash conversion ratio"
    /\bcash\s*conversion\b/i,
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
      fetchTask("cashflow", "fetch_cash_flow", { symbol }),
      fetchTask("financials", "fetch_income_statement", { symbol }),
      fetchTask("balance", "fetch_balance_sheet", { symbol }),
      fetchTask("ratios", "fetch_key_ratios", { symbol }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),

      // Phase 2: Cash-flow quality computations (wired to the fetches each needs)
      computeTask("cashflow_quality", "compute_cash_flow_quality", {}, [
        "cashflow",
        "financials",
        "price",
      ]),
      computeTask("capex_intensity", "compute_capex_intensity", {}, [
        "cashflow",
        "financials",
      ]),
      computeTask("fcf_yield", "compute_fcf_yield", {}, [
        "cashflow",
        "financials",
        "price",
        "balance",
      ]),
      computeTask("working_capital_drag", "compute_working_capital_drag", {}, [
        "balance",
        "financials",
      ]),

      // Phase 3: Synthesis (depends on ALL prior task ids)
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) ||
            `Cash flow quality of ${params.symbol}`,
        },
        [
          "cashflow",
          "financials",
          "balance",
          "ratios",
          "price",
          "cashflow_quality",
          "capex_intensity",
          "fcf_yield",
          "working_capital_drag",
        ],
      ),
    ];

    return {
      query:
        (params.query as string) || `Cash flow quality of ${params.symbol}`,
      skill: "cash-flow-quality",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
