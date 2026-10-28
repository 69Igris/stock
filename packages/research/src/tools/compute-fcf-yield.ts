/**
 * Free Cash Flow Yield Analysis
 *
 * Computes FCF yield (FCF / Market Cap), FCF yield on EV, and FCF margin.
 * Derives 3-5yr average yield + trend, and classifies the yield against the
 * ~7% Indian 10Y G-Sec risk-free rate (attractive / fair / expensive).
 *
 * PURE compute tool: reads everything from params. No network / db / io.
 * Inputs are injected by the executor from upstream fetch results.
 *
 * SEBI: emits observations / scores / flags only. No buy/sell/hold language.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

/** A single historical FCF data point used for averaging and trend. */
export interface HistoricalFcfPoint {
  /** Free cash flow for the period (may be derived). */
  fcf?: number | null;
  /** Operating cash flow for the period (fallback to derive fcf). */
  operatingCashFlow?: number | null;
  /** Capital expenditure for the period (fallback to derive fcf). */
  capitalExpenditure?: number | null;
  /** Market cap for the period; if absent, current market cap is used. */
  marketCap?: number | null;
}

export interface FcfYieldResult {
  available: boolean;
  reason?: string;
  symbol?: string;

  /** Free cash flow used for the headline calculation. */
  freeCashFlow?: number;
  /** Whether FCF was derived from OCF - |CapEx| rather than supplied directly. */
  fcfDerived?: boolean;
  marketCap?: number;
  /** Enterprise value used (supplied, computed, or fell back to marketCap). */
  enterpriseValue?: number;
  /** Whether EV fell back to market cap due to missing debt/cash. */
  evFellBackToMarketCap?: boolean;

  /** FCF / Market Cap, as a fraction (0.05 = 5%). */
  fcfYield?: number;
  /** FCF / Enterprise Value, as a fraction. */
  fcfYieldOnEV?: number;
  /** FCF / Revenue, as a fraction. */
  fcfMargin?: number;

  /** Risk-free rate used for classification, as a fraction (default 0.07). */
  riskFreeRate?: number;
  /** Yield classification relative to risk-free rate. */
  classification?: "attractive" | "fair" | "expensive";

  /** Average FCF yield across the supplied history + current period. */
  avgFcfYield?: number;
  /** Number of periods that contributed to the average. */
  periodsCovered?: number;
  /** Direction of the FCF (not yield) trend across history. */
  fcfTrend?: "improving" | "stable" | "declining" | "volatile" | "unknown";

  /** Quality / attractiveness score 0-100 (higher = more attractive yield). */
  score?: number;
  /** Observational flags (no advice language). */
  flags?: string[];
}

/** Coerce an unknown value to a finite number, else undefined. */
function toNum(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Round to a given number of decimal places. */
function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export const computeFcfYieldTool: ResearchToolDef = {
  name: "compute_fcf_yield",
  description:
    "Compute FCF yield (FCF/MktCap), FCF yield on EV, FCF margin, multi-year avg + trend, and classify vs ~7% G-Sec",
  category: "computation",
  parameters: {
    freeCashFlow: {
      type: "number",
      description:
        "Latest annual free cash flow; if absent, derived from OCF - |CapEx|",
    },
    operatingCashFlow: {
      type: "number",
      description: "Latest annual operating cash flow (to derive FCF)",
    },
    capitalExpenditure: {
      type: "number",
      description: "Latest annual capital expenditure (sign-agnostic)",
    },
    marketCap: {
      type: "number",
      description: "Current market capitalization",
      required: true,
    },
    totalDebt: {
      type: "number",
      description: "Total debt, for enterprise-value computation",
    },
    totalCash: {
      type: "number",
      description: "Cash & equivalents, for enterprise-value computation",
    },
    enterpriseValue: {
      type: "number",
      description:
        "Enterprise value; if absent, computed as marketCap + totalDebt - totalCash",
    },
    revenue: {
      type: "number",
      description: "Latest annual revenue, for FCF margin",
    },
    historicalFcf: {
      type: "array",
      description:
        "Array of prior-period objects {fcf?|operatingCashFlow?+capitalExpenditure?, marketCap?} oldest to newest",
    },
    riskFreeRate: {
      type: "number",
      description: "Risk-free rate as a fraction (default 0.07 = 7% 10Y G-Sec)",
      default: 0.07,
    },
    symbol: { type: "string", description: "Instrument symbol (for labeling)" },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const symbol =
        typeof params.symbol === "string"
          ? params.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase()
          : undefined;

      const marketCap = toNum(params.marketCap);
      const ocf = toNum(params.operatingCashFlow);
      const capex = toNum(params.capitalExpenditure);
      const fcfParam = toNum(params.freeCashFlow);
      const revenue = toNum(params.revenue);
      const totalDebt = toNum(params.totalDebt);
      const totalCash = toNum(params.totalCash);
      const evParam = toNum(params.enterpriseValue);
      const riskFreeRate = toNum(params.riskFreeRate) ?? 0.07;

      // Derive FCF: prefer supplied, else OCF - |CapEx|.
      let fcf: number | undefined = fcfParam;
      let fcfDerived = false;
      if (fcf === undefined && ocf !== undefined) {
        fcf = ocf - Math.abs(capex ?? 0);
        fcfDerived = true;
      }

      // Graceful degradation: cannot proceed without FCF or market cap.
      if (fcf === undefined) {
        return {
          success: true,
          data: {
            available: false,
            reason:
              "Free cash flow could not be derived (no freeCashFlow and no operatingCashFlow supplied)",
            symbol,
          } satisfies FcfYieldResult,
        };
      }
      if (marketCap === undefined || marketCap <= 0) {
        return {
          success: true,
          data: {
            available: false,
            reason: "Market capitalization is missing or non-positive",
            symbol,
          } satisfies FcfYieldResult,
        };
      }

      const flags: string[] = [];

      // Enterprise value: supplied, computed, or fall back to market cap.
      let enterpriseValue: number;
      let evFellBackToMarketCap = false;
      if (evParam !== undefined && evParam > 0) {
        enterpriseValue = evParam;
      } else if (totalDebt !== undefined || totalCash !== undefined) {
        enterpriseValue = marketCap + (totalDebt ?? 0) - (totalCash ?? 0);
        if (enterpriseValue <= 0) {
          enterpriseValue = marketCap;
          evFellBackToMarketCap = true;
        }
      } else {
        enterpriseValue = marketCap;
        evFellBackToMarketCap = true;
      }

      // Headline yields & margin (fractions).
      const fcfYield = round(fcf / marketCap, 4);
      const fcfYieldOnEV = round(fcf / enterpriseValue, 4);
      const fcfMargin =
        revenue !== undefined && revenue > 0
          ? round(fcf / revenue, 4)
          : undefined;

      // Classification vs risk-free rate.
      // fcf<0 or yield<2% => expensive; >= risk-free => attractive; else fair.
      let classification: FcfYieldResult["classification"];
      if (fcf < 0 || fcfYield < 0.02) {
        classification = "expensive";
      } else if (fcfYield >= riskFreeRate) {
        classification = "attractive";
      } else {
        classification = "fair";
      }

      // Build the multi-year FCF series (history oldest->newest + current).
      const rawHistory = Array.isArray(params.historicalFcf)
        ? (params.historicalFcf as unknown[])
        : [];

      const series: Array<{ fcf: number; yield: number | undefined }> = [];
      for (const entry of rawHistory) {
        if (entry === null || typeof entry !== "object") continue;
        const rec = entry as Record<string, unknown>;
        const hFcfDirect = toNum(rec.fcf);
        const hOcf = toNum(rec.operatingCashFlow);
        const hCapex = toNum(rec.capitalExpenditure);
        let hFcf: number | undefined = hFcfDirect;
        if (hFcf === undefined && hOcf !== undefined) {
          hFcf = hOcf - Math.abs(hCapex ?? 0);
        }
        if (hFcf === undefined) continue;
        const hMktCap = toNum(rec.marketCap) ?? marketCap;
        const hYield = hMktCap > 0 ? hFcf / hMktCap : undefined;
        series.push({ fcf: hFcf, yield: hYield });
      }
      // Append the current period.
      series.push({ fcf, yield: fcfYield });

      const periodsCovered = series.length;

      // Average yield across periods that have a computable yield.
      const yieldsAvailable = series
        .map((p) => p.yield)
        .filter((y): y is number => y !== undefined);
      const avgFcfYield =
        yieldsAvailable.length > 0
          ? round(
              yieldsAvailable.reduce((a, b) => a + b, 0) /
                yieldsAvailable.length,
              4,
            )
          : undefined;

      // FCF trend across the series.
      const fcfValues = series.map((p) => p.fcf);
      let fcfTrend: FcfYieldResult["fcfTrend"] = "unknown";
      if (fcfValues.length >= 3) {
        const negativeCount = fcfValues.filter((v) => v < 0).length;
        const first = fcfValues[0]!;
        const last = fcfValues[fcfValues.length - 1]!;
        // Volatility: sign flips between consecutive periods.
        let signFlips = 0;
        for (let i = 1; i < fcfValues.length; i += 1) {
          const prev = fcfValues[i - 1]!;
          const cur = fcfValues[i]!;
          if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) signFlips += 1;
        }
        if (signFlips >= 2 || (negativeCount > 0 && negativeCount < fcfValues.length)) {
          fcfTrend = "volatile";
        } else if (first !== 0 && last > first * 1.1) {
          fcfTrend = "improving";
        } else if (first !== 0 && last < first * 0.9) {
          fcfTrend = "declining";
        } else {
          fcfTrend = "stable";
        }
      }

      // Observational flags.
      if (fcf < 0) {
        flags.push(
          "Negative free cash flow in latest period - business is not self-funding from operations after CapEx",
        );
      }
      if (fcfTrend === "volatile") {
        flags.push(
          "Free cash flow is volatile across periods - low predictability of cash generation",
        );
      } else if (fcfTrend === "declining") {
        flags.push("Free cash flow has declined over the observed periods");
      }
      if (fcfMargin !== undefined && fcfMargin < 0.05 && fcf >= 0) {
        flags.push(
          `Thin FCF margin (${(fcfMargin * 100).toFixed(1)}% of revenue) - limited cash conversion`,
        );
      }
      if (classification === "expensive" && fcf >= 0) {
        flags.push(
          `FCF yield (${(fcfYield * 100).toFixed(1)}%) is below the ~${(riskFreeRate * 100).toFixed(0)}% risk-free rate`,
        );
      }
      if (evFellBackToMarketCap) {
        flags.push(
          "Enterprise value fell back to market cap (debt/cash components unavailable)",
        );
      }

      // Score 0-100: how attractive the yield is, penalized for risk.
      let score = 50;
      if (fcf < 0) {
        score -= 30;
      } else if (fcfYield >= riskFreeRate) {
        score += 25;
      } else if (fcfYield >= 0.05) {
        score += 15;
      } else if (fcfYield >= 0.02) {
        score += 5;
      } else {
        score -= 15;
      }

      if (avgFcfYield !== undefined) {
        if (avgFcfYield >= riskFreeRate) score += 10;
        else if (avgFcfYield < 0.02) score -= 5;
      }

      if (fcfTrend === "improving") score += 10;
      else if (fcfTrend === "declining") score -= 10;
      else if (fcfTrend === "volatile") score -= 15;

      if (fcfMargin !== undefined && fcfMargin >= 0.1) score += 5;

      score = Math.max(0, Math.min(100, Math.round(score)));

      const result: FcfYieldResult = {
        available: true,
        symbol,
        freeCashFlow: round(fcf, 2),
        fcfDerived,
        marketCap: round(marketCap, 2),
        enterpriseValue: round(enterpriseValue, 2),
        evFellBackToMarketCap,
        fcfYield,
        fcfYieldOnEV,
        fcfMargin,
        riskFreeRate,
        classification,
        avgFcfYield,
        periodsCovered,
        fcfTrend,
        score,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `FCF yield analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
