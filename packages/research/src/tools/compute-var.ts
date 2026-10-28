/**
 * Value at Risk (VaR) Computation
 *
 * Historical VaR: Sort returns, pick percentile.
 * Parametric VaR: mean - z×σ.
 * CVaR (Expected Shortfall): Average beyond VaR.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { VaRResult } from "../types";
import { insufficientInput } from "./insufficient-input";

// Standard normal z-scores
const Z_95 = 1.645;
const Z_99 = 2.326;

/**
 * MONEY-806: VaR result augmented with the confidence the user actually
 * selected (`varConfig.confidence`). The base `VaRResult` always carries BOTH
 * var95 + var99 (back-compat), but the chosen percentile is surfaced here as
 * the PRIMARY VaR so the synthesizer / UI lead with the level the user picked.
 * `selectedConfidence` is the percentile (95 | 99); `selectedVar*` mirror the
 * historical block at that level. Absent `varConfig` → defaults to 95 (today's
 * behaviour: var95Amount stays the headline number).
 */
interface SelectedVaRResult extends VaRResult {
  selectedConfidence: 95 | 99;
  /** Historical VaR (return, negative = loss) at the selected confidence. */
  selectedVar: number;
  /** Parametric VaR (return) at the selected confidence. */
  selectedParametricVar: number;
  /** INR amount at risk at the selected confidence (1-day or scaled period). */
  selectedVarAmount: number;
}

/** Read 95 | 99 from params.varConfig.confidence; default 95 when absent/invalid. */
function selectedConfidence(params: Record<string, unknown>): 95 | 99 {
  const cfg = params.varConfig as { confidence?: unknown } | undefined;
  return cfg?.confidence === 99 ? 99 : 95;
}

export const computeVarTool: ResearchToolDef = {
  name: "compute_var",
  description:
    "Calculate Value at Risk (VaR) and Conditional VaR for the portfolio",
  category: "computation",
  parameters: {
    portfolioReturns: {
      type: "array",
      description: "Array of daily portfolio returns (decimals)",
      required: true,
    },
    portfolioValue: {
      type: "number",
      description: "Current total portfolio value in INR",
      required: true,
    },
    period: {
      type: "string",
      description: "'1-day' or '10-day'",
      default: "1-day",
    },
    varConfig: {
      type: "object",
      description:
        "MONEY-806 (C1c) - user-selected VaR config { confidence: 95|99, horizonDays: 1|10 }. confidence promotes the chosen percentile as the primary VaR (both var95/var99 still returned). Absent → 95 (today's headline). The agent maps horizonDays → period upstream.",
      required: false,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const returns = params.portfolioReturns as number[] | undefined;
    const portfolioValue = params.portfolioValue as number;
    const period = (params.period as string) || "1-day";
    // MONEY-806: the confidence the user selected (95 | 99). Drives which
    // percentile is surfaced as the primary VaR; both levels remain in the
    // payload for compatibility. Default 95 (today's headline) when unset.
    const confidence = selectedConfidence(params);

    if (!returns?.length || returns.length < 20) {
      return insufficientInput(
        "At least 20 daily returns required for VaR calculation",
      );
    }

    // A single non-finite return (NaN / ±Infinity) poisons the parametric
    // block (mean / stdDev → NaN, serialized as `null`) and gives a meaningless
    // VaR. Reject malformed input outright rather than emitting a corrupt
    // risk number.
    if (!returns.every((r) => Number.isFinite(r))) {
      return {
        success: false,
        error: "portfolioReturns must contain only finite numbers",
      };
    }

    if (!portfolioValue || portfolioValue <= 0) {
      return { success: false, error: "portfolioValue must be > 0" };
    }

    try {
      const sorted = [...returns].sort((a, b) => a - b);
      const n = sorted.length;

      // Period scaling factor (square root of time)
      const scaleFactor = period === "10-day" ? Math.sqrt(10) : 1;

      // Historical VaR
      const idx95 = Math.floor(n * 0.05);
      const idx99 = Math.floor(n * 0.01);

      const histVar95 = (sorted[idx95] ?? 0) * scaleFactor;
      const histVar99 = (sorted[idx99] ?? 0) * scaleFactor;

      // CVaR (Expected Shortfall): average of returns below VaR
      const tailReturns = sorted.slice(0, idx95 + 1);
      const cvar95 =
        tailReturns.length > 0
          ? (tailReturns.reduce((s, r) => s + r, 0) / tailReturns.length) *
            scaleFactor
          : histVar95;

      // Parametric VaR
      const mean = returns.reduce((s, r) => s + r, 0) / n;
      const variance =
        returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (n - 1);
      const stdDev = Math.sqrt(variance);

      const paramVar95 = (mean - Z_95 * stdDev) * scaleFactor;
      const paramVar99 = (mean - Z_99 * stdDev) * scaleFactor;

      const histVar95Rounded = Math.round(histVar95 * 10000) / 10000;
      const histVar99Rounded = Math.round(histVar99 * 10000) / 10000;
      const paramVar95Rounded = Math.round(paramVar95 * 10000) / 10000;
      const paramVar99Rounded = Math.round(paramVar99 * 10000) / 10000;

      // MONEY-806: pick the percentile the user selected as the PRIMARY VaR.
      // Both var95/var99 remain above for compatibility; this just promotes one.
      const selectedHistVar =
        confidence === 99 ? histVar99Rounded : histVar95Rounded;
      const selectedParamVar =
        confidence === 99 ? paramVar99Rounded : paramVar95Rounded;
      const selectedVarAmount = Math.round(
        Math.abs(selectedHistVar) * portfolioValue,
      );

      const result: SelectedVaRResult = {
        historical: {
          var95: histVar95Rounded,
          var99: histVar99Rounded,
          cvar95: Math.round(cvar95 * 10000) / 10000,
        },
        parametric: {
          var95: paramVar95Rounded,
          var99: paramVar99Rounded,
          mean: Math.round(mean * 10000) / 10000,
          stdDev: Math.round(stdDev * 10000) / 10000,
        },
        portfolioValue,
        var95Amount: Math.round(Math.abs(histVar95) * portfolioValue),
        period,
        selectedConfidence: confidence,
        selectedVar: selectedHistVar,
        selectedParametricVar: selectedParamVar,
        selectedVarAmount,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `VaR computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
