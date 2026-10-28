/**
 * DCF (Discounted Cash Flow) Valuation Model
 *
 * Computes intrinsic value from free cash flow projections.
 * Supports WACC from compute_wacc tool as discount rate.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { DcfResult } from "../types";

export const computeDcfTool: ResearchToolDef = {
  name: "compute_dcf",
  description: "Calculate intrinsic value using DCF model from financial data",
  category: "computation",
  parameters: {
    currentPrice: {
      type: "number",
      description: "Current stock price",
      required: true,
    },
    freeCashFlow: {
      type: "number",
      description: "Latest annual free cash flow",
      required: true,
    },
    sharesOutstanding: {
      type: "number",
      description: "Total shares outstanding",
      required: true,
    },
    growthRate: {
      type: "number",
      description: "Expected FCF growth rate (decimal, e.g., 0.15 for 15%)",
      default: 0.12,
    },
    terminalGrowthRate: {
      type: "number",
      description: "Terminal growth rate (decimal)",
      default: 0.03,
    },
    discountRate: {
      type: "number",
      description: "Discount rate / WACC (decimal) - prefer computed WACC",
      default: 0.1,
    },
    projectionYears: {
      type: "number",
      description: "Years to project",
      default: 10,
    },
    wacc: {
      type: "number",
      description:
        "WACC from compute_wacc (overrides discountRate if provided)",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    // Honour a legitimate explicit override of 0 (e.g. a 0% terminal-growth
    // assumption). `Number.isFinite` keeps the documented default ONLY when the
    // param is missing / non-numeric — a `|| default` would silently discard a
    // valid 0 (MONEY-779).
    const num = (v: unknown, fallback: number): number =>
      Number.isFinite(v as number) ? (v as number) : fallback;

    const currentPrice = params.currentPrice as number;
    const fcf = params.freeCashFlow as number;
    const shares = params.sharesOutstanding as number;
    const growthRate = num(params.growthRate, 0.12);
    const terminalGrowthRate = num(params.terminalGrowthRate, 0.03);
    // Prefer computed WACC over hardcoded discount rate. A WACC of exactly 0 is
    // economically nonsensical (and would fail the discountRate > tg guard
    // below), so a falsy/non-finite WACC still falls through to discountRate.
    const discountRate = Number.isFinite(params.wacc as number)
      ? (params.wacc as number)
      : num(params.discountRate, 0.1);
    // projectionYears (unlike growthRate/WACC) has no valid 0 override — a 0-year
    // DCF is degenerate — so require a POSITIVE value, else the documented default.
    const yearsRaw = num(params.projectionYears, 10);
    const years = yearsRaw > 0 ? yearsRaw : 10;

    if (!currentPrice) {
      return { success: false, error: "currentPrice is required" };
    }

    // Estimate FCF from operating cash flow if not provided directly
    const operatingCashFlow = params.operatingCashFlow as number | undefined;
    const capitalExpenditure = params.capitalExpenditure as number | undefined;
    const netIncome = params.netIncome as number | undefined;

    let effectiveFcf = fcf;
    if (!effectiveFcf && operatingCashFlow) {
      effectiveFcf = operatingCashFlow - Math.abs(capitalExpenditure || 0);
    }
    if (!effectiveFcf && netIncome) {
      // Rough estimate: FCF ≈ 70% of net income for capital-light businesses
      effectiveFcf = netIncome * 0.7;
    }
    if (!effectiveFcf) {
      return {
        success: false,
        error:
          "freeCashFlow, operatingCashFlow, or netIncome is required for DCF",
      };
    }

    // Estimate shares from market cap and price if not provided
    let effectiveShares = shares;
    const marketCap = params.marketCap as number | undefined;
    if (!effectiveShares && marketCap && currentPrice > 0) {
      effectiveShares = marketCap / currentPrice;
    }
    if (!effectiveShares) {
      return {
        success: false,
        error: "sharesOutstanding or marketCap is required for DCF",
      };
    }

    if (discountRate <= terminalGrowthRate) {
      return {
        success: false,
        error: "Discount rate must be greater than terminal growth rate",
      };
    }

    try {
      const projections: Array<{
        year: number;
        fcf: number;
        discountedFcf: number;
      }> = [];
      let totalPV = 0;

      for (let i = 1; i <= years; i++) {
        const projectedFcf = effectiveFcf * Math.pow(1 + growthRate, i);
        const discountFactor = Math.pow(1 + discountRate, i);
        const discountedFcf = projectedFcf / discountFactor;
        totalPV += discountedFcf;

        projections.push({
          year: i,
          fcf: Math.round(projectedFcf),
          discountedFcf: Math.round(discountedFcf),
        });
      }

      // Terminal value
      const terminalFcf =
        effectiveFcf *
        Math.pow(1 + growthRate, years) *
        (1 + terminalGrowthRate);
      const terminalValue = terminalFcf / (discountRate - terminalGrowthRate);
      const discountedTerminal =
        terminalValue / Math.pow(1 + discountRate, years);
      totalPV += discountedTerminal;

      const intrinsicValue = totalPV / effectiveShares;
      const marginOfSafety =
        ((intrinsicValue - currentPrice) / intrinsicValue) * 100;
      const upside = ((intrinsicValue - currentPrice) / currentPrice) * 100;

      const result: DcfResult = {
        intrinsicValue: Math.round(intrinsicValue * 100) / 100,
        currentPrice,
        marginOfSafety: Math.round(marginOfSafety * 100) / 100,
        upside: Math.round(upside * 100) / 100,
        assumptions: {
          fcf: effectiveFcf,
          growthRate,
          terminalGrowthRate,
          discountRate,
          projectionYears: years,
        },
        projections,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `DCF computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
