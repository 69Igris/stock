/**
 * Portfolio Rebalancing Suggestions
 *
 * Compares current vs target weights. Drift > 5% flagged.
 *
 * TODO: SEBI-compliance review — flag at compute-rebalancing.ts:50-72.
 *   The `action: "buy" | "sell" | "hold"` field is a literal portfolio
 *   recommendation derived from drift. Even though it's mechanical (drift
 *   above threshold → sell; below → buy), feeding "BUY 12000 of RELIANCE"
 *   to the synthesizer LLM consistently leaks into the report as a
 *   recommendation. Recommended rewrite: relabel `action` →
 *   `driftDirection: "over_target" | "under_target" | "in_range"` with
 *   `amount` already absolute, and let the renderer present it neutrally
 *   ("RELIANCE is 1.2% over its 10% target weight"). Not auto-fixing
 *   because downstream consumers (registry, type imports, prompts) read
 *   the `action` field and need a coordinated change.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { RebalancingResult } from "../types";

const DEFAULT_DRIFT_THRESHOLD = 0.05; // 5%

export const computeRebalancingTool: ResearchToolDef = {
  name: "compute_rebalancing",
  description:
    "Compute rebalancing needs by comparing current vs target portfolio weights",
  category: "computation",
  parameters: {
    holdings: {
      type: "array",
      description:
        "Array of { symbol, value, targetWeight? } - targetWeight defaults to equal weight",
      required: true,
    },
    driftThreshold: {
      type: "number",
      description: "Threshold for flagging drift (decimal, default 0.05)",
      default: 0.05,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const holdings = params.holdings as
      | Array<{ symbol: string; value: number; targetWeight?: number }>
      | undefined;
    const threshold =
      (params.driftThreshold as number) || DEFAULT_DRIFT_THRESHOLD;

    if (!holdings?.length) {
      return { success: false, error: "holdings array is required" };
    }

    try {
      const totalValue = holdings.reduce((sum, h) => sum + h.value, 0);
      if (totalValue <= 0) {
        return { success: false, error: "Total portfolio value must be > 0" };
      }

      // Default target: equal weight
      const equalWeight = 1 / holdings.length;

      const results: RebalancingResult["holdings"] = holdings.map((h) => {
        const currentWeight = h.value / totalValue;
        const targetWeight = h.targetWeight ?? equalWeight;
        const drift = currentWeight - targetWeight;
        const amount = drift * totalValue;

        let action: "buy" | "sell" | "hold";
        if (drift > threshold) {
          action = "sell";
        } else if (drift < -threshold) {
          action = "buy";
        } else {
          action = "hold";
        }

        return {
          symbol: h.symbol,
          currentWeight: Math.round(currentWeight * 10000) / 10000,
          targetWeight: Math.round(targetWeight * 10000) / 10000,
          drift: Math.round(drift * 10000) / 10000,
          action,
          amount: Math.round(Math.abs(amount)),
        };
      });

      const totalDrift = results.reduce((sum, r) => sum + Math.abs(r.drift), 0);
      const needsRebalancing = results.some(
        (r) => Math.abs(r.drift) > threshold,
      );

      const result: RebalancingResult = {
        holdings: results.sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift)),
        totalDrift: Math.round(totalDrift * 10000) / 10000,
        needsRebalancing,
        driftThreshold: threshold,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Rebalancing computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
