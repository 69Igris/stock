/**
 * DCF Valuation Skill (v2) - Institutional intrinsic-value modelling
 *
 * Triggers: "dcf", "discounted cash flow", "intrinsic value", "fair value",
 *           "valuation model", "wacc"
 * Output: full discounted-cash-flow model (WACC build-up, explicit + terminal
 *         FCF, dividend-discount cross-check, valuation bands, scenario tree,
 *         sensitivity grid) with an observation-only fair-value range.
 *
 * SEBI note: observation-only. The model surfaces a range of model-implied
 * values and the assumptions behind them; it does not issue buy/sell advice.
 *
 * v2 promotes the prior tool-allowlist entry ("dcf-valuation" in
 * SKILL_TOOL_ALLOWLIST) to a first-class, trigger-matchable skill. Registered
 * centrally by the orchestrator; it replaces the legacy dcf-valuation skill.
 */

import type { ResearchPlan } from "../types";
import type { ResearchSkill } from "./types";
import { fetchTask, computeTask, synthesisTask } from "./types";
import { resolveSymbol } from "../data-sources/symbol-resolver";

export const dcfValuationSkill: ResearchSkill = {
  name: "dcf-valuation",
  description:
    "Build a full intrinsic-value model - WACC build-up, discounted cash flow, dividend-discount cross-check, valuation bands, scenario tree and sensitivity grid (observation-only fair-value range)",
  triggers: [
    // Explicit DCF / discounted-cash-flow intent
    /\b(dcf)\b/i,
    /\bdiscounted\s*cash\s*flow\b/i,
    // Intrinsic / fair value (require the value noun, not a bare "analyze")
    /\b(intrinsic|fair|true)\s*value\b/i,
    /\bintrinsic\s*worth\b/i,
    // Explicit valuation modelling intent (not a bare "valuation")
    /\bvaluation\s*(model|modelling|modeling)\b/i,
    /\b(build|run|do)\s*(a|the)?\s*(dcf|valuation\s*model)\b/i,
    // Cost of capital
    /\b(wacc|cost\s*of\s*(capital|equity))\b/i,
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
      fetchTask("ratios", "fetch_key_ratios", { symbol }),
      fetchTask("price", "fetch_stock_price", { symbols: [symbol] }),
      fetchTask("profile", "fetch_company_profile", { symbol }),
      fetchTask("balance", "fetch_balance_sheet", { symbol }),

      // Phase 2: Valuation computations
      // WACC build-up needs capital-structure ratios + current price.
      computeTask("wacc", "compute_wacc", {}, ["ratios", "price"]),
      // Core DCF: FCF history (cashflow) with net-income fallback (financials),
      // anchored on current price, ratios for normalisation, and the WACC
      // discount rate from the prior task.
      computeTask("dcf", "compute_dcf", {}, [
        "cashflow",
        "financials",
        "price",
        "ratios",
        "wacc",
      ]),
      // Dividend-discount cross-check for income-heavy names.
      computeTask("ddm", "compute_ddm", {}, ["ratios", "price"]),
      // Multiple-implied valuation bands as a sanity envelope.
      computeTask("valuation_bands", "compute_valuation_bands", {}, [
        "ratios",
        "price",
      ]),
      // Bull / base / bear tree off the base DCF + WACC.
      computeTask("scenario_analysis", "compute_scenario_analysis", {}, [
        "dcf",
        "wacc",
        "price",
      ]),
      // Two-way sensitivity grid (growth x discount rate) off the base DCF.
      computeTask("dcf_sensitivity", "compute_dcf_sensitivity", {}, [
        "dcf",
        "wacc",
        "price",
      ]),

      // Phase 3: Synthesis (depends on every prior task)
      synthesisTask(
        "report",
        "synthesize_report",
        {
          query:
            (params.query as string) || `DCF valuation of ${params.symbol}`,
        },
        [
          "cashflow",
          "financials",
          "ratios",
          "price",
          "profile",
          "balance",
          "wacc",
          "dcf",
          "ddm",
          "valuation_bands",
          "scenario_analysis",
          "dcf_sensitivity",
        ],
      ),
    ];

    return {
      query: (params.query as string) || `DCF valuation of ${params.symbol}`,
      skill: "dcf-valuation",
      symbols: [symbol],
      tasks,
      estimatedSteps: tasks.length,
      complexity: "complex",
    };
  },
};
