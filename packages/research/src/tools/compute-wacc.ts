/**
 * WACC (Weighted Average Cost of Capital) Computation
 *
 * CAPM: Ke = Rf + β × (Rm - Rf)
 * WACC = E/(E+D) × Ke + D/(E+D) × Kd × (1-t)
 *
 * India defaults: Rf = 7.2% (10Y G-Sec), Rm = 12% (Nifty long-term)
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { WACCResult } from "../types";

const DEFAULT_RISK_FREE_RATE = 0.072; // 10-year G-Sec yield
const DEFAULT_MARKET_RETURN = 0.12; // Nifty 50 long-term return
const DEFAULT_TAX_RATE = 0.2508; // 25.168% effective corporate tax

export const computeWaccTool: ResearchToolDef = {
  name: "compute_wacc",
  description:
    "Calculate WACC using CAPM for cost of equity - replaces hardcoded 10% discount rate",
  category: "computation",
  parameters: {
    beta: {
      type: "number",
      description: "Stock beta (systematic risk)",
      required: true,
    },
    marketCap: {
      type: "number",
      description: "Market capitalization (equity value E)",
      required: true,
    },
    totalDebt: {
      type: "number",
      description: "Total debt (D)",
      default: 0,
    },
    interestExpense: {
      type: "number",
      description: "Annual interest expense (for cost of debt)",
      default: 0,
    },
    riskFreeRate: {
      type: "number",
      description: "Risk-free rate (default 7.2% - 10Y G-Sec)",
      default: 0.072,
    },
    marketReturn: {
      type: "number",
      description: "Expected market return (default 12% - Nifty long-term)",
      default: 0.12,
    },
    taxRate: {
      type: "number",
      description: "Corporate tax rate (default 25.168%)",
      default: 0.2508,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const beta = params.beta as number;
    const marketCap = params.marketCap as number;
    const totalDebt = (params.totalDebt as number) || 0;
    const interestExpense = (params.interestExpense as number) || 0;
    const rf = (params.riskFreeRate as number) || DEFAULT_RISK_FREE_RATE;
    const rm = (params.marketReturn as number) || DEFAULT_MARKET_RETURN;
    const taxRate = (params.taxRate as number) || DEFAULT_TAX_RATE;

    if (beta == null || !marketCap) {
      return {
        success: false,
        error: "beta and marketCap are required",
      };
    }

    try {
      // Cost of equity via CAPM
      const costOfEquity = rf + beta * (rm - rf);

      // Cost of debt (after tax)
      const costOfDebt =
        totalDebt > 0 ? interestExpense / totalDebt : rf + 0.02;

      // Weights
      const totalCapital = marketCap + totalDebt;
      const equityWeight = marketCap / totalCapital;
      const debtWeight = totalDebt / totalCapital;

      // WACC
      const wacc =
        equityWeight * costOfEquity + debtWeight * costOfDebt * (1 - taxRate);

      const result: WACCResult = {
        wacc: Math.round(wacc * 10000) / 10000,
        costOfEquity: Math.round(costOfEquity * 10000) / 10000,
        costOfDebt: Math.round(costOfDebt * 10000) / 10000,
        beta,
        riskFreeRate: rf,
        marketReturn: rm,
        equityWeight: Math.round(equityWeight * 10000) / 10000,
        debtWeight: Math.round(debtWeight * 10000) / 10000,
        taxRate,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `WACC computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
