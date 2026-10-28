/**
 * Earnings Surprise Analysis
 *
 * Compares actual EPS vs consensus estimate for recent quarters.
 * Detects patterns: consistent beats, recent miss, deteriorating trend.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import { insufficientInput } from "./insufficient-input";

export interface EarningsSurpriseEntry {
  quarter: string;
  actual: number;
  estimate: number;
  surprisePercent: number;
  beat: boolean;
}

export interface EarningsSurpriseResult {
  surprises: EarningsSurpriseEntry[];
  pattern:
    | "consistent_beat"
    | "consistent_miss"
    | "mixed"
    | "improving"
    | "deteriorating";
  trend: "positive" | "negative" | "neutral";
  avgSurprisePercent: number;
  beatRate: number;
  flags: string[];
}

export const computeEarningsSurpriseTool: ResearchToolDef = {
  name: "compute_earnings_surprise",
  description:
    "Analyze earnings surprises - actual vs estimate, beat/miss patterns, trend detection",
  category: "computation",
  parameters: {
    earningsHistory: {
      type: "array",
      description:
        "Array of { quarter: string, actual: number, estimate: number } objects, newest first",
      required: true,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const earningsHistory = params.earningsHistory as Array<{
      quarter?: string;
      actual?: number;
      estimate?: number;
      epsActual?: number;
      epsEstimate?: number;
      date?: string;
      period?: string;
    }>;

    if (!earningsHistory || !Array.isArray(earningsHistory)) {
      return { success: false, error: "earningsHistory array is required" };
    }
    if (earningsHistory.length === 0) {
      return insufficientInput(
        "earningsHistory array is required with at least 1 entry",
        { needed: "1 entry", got: 0 },
      );
    }

    try {
      const flags: string[] = [];

      // Normalize entries
      const surprises: EarningsSurpriseEntry[] = earningsHistory
        .slice(0, 8) // Max 8 quarters
        .map((e, i) => {
          const actual = (e.actual ?? e.epsActual ?? 0) as number;
          const estimate = (e.estimate ?? e.epsEstimate ?? 0) as number;
          const quarter = (e.quarter ??
            e.period ??
            e.date ??
            `Q${i + 1}`) as string;
          const surprisePercent =
            estimate !== 0
              ? Math.round(((actual - estimate) / Math.abs(estimate)) * 10000) /
                100
              : 0;

          return {
            quarter,
            actual,
            estimate,
            surprisePercent,
            beat: actual >= estimate,
          };
        })
        .filter((e) => e.actual !== 0 || e.estimate !== 0);

      if (surprises.length === 0) {
        return {
          success: false,
          error: "No valid earnings data found in history",
        };
      }

      // Beat rate
      const beats = surprises.filter((s) => s.beat).length;
      const beatRate = Math.round((beats / surprises.length) * 100) / 100;

      // Average surprise
      const avgSurprisePercent =
        surprises.length > 0
          ? Math.round(
              (surprises.reduce((sum, s) => sum + s.surprisePercent, 0) /
                surprises.length) *
                100,
            ) / 100
          : 0;

      // Detect pattern
      let pattern: EarningsSurpriseResult["pattern"] = "mixed";
      if (beatRate >= 0.75) {
        pattern = "consistent_beat";
      } else if (beatRate <= 0.25) {
        pattern = "consistent_miss";
      } else if (surprises.length >= 4) {
        // Check trend: are recent quarters better or worse?
        const recentHalf = surprises.slice(0, Math.floor(surprises.length / 2));
        const olderHalf = surprises.slice(Math.floor(surprises.length / 2));
        const recentAvg =
          recentHalf.reduce((s, e) => s + e.surprisePercent, 0) /
          recentHalf.length;
        const olderAvg =
          olderHalf.reduce((s, e) => s + e.surprisePercent, 0) /
          olderHalf.length;

        if (recentAvg > olderAvg + 2) {
          pattern = "improving";
        } else if (recentAvg < olderAvg - 2) {
          pattern = "deteriorating";
        }
      }

      // Detect trend
      let trend: EarningsSurpriseResult["trend"] = "neutral";
      if (avgSurprisePercent > 3) {
        trend = "positive";
      } else if (avgSurprisePercent < -3) {
        trend = "negative";
      }

      // Generate flags
      if (pattern === "consistent_beat") {
        flags.push(
          `Consistently beats estimates (${(beatRate * 100).toFixed(0)}% beat rate) - strong execution and/or conservative guidance`,
        );
      }
      if (pattern === "consistent_miss") {
        flags.push(
          `Consistently misses estimates (${(beatRate * 100).toFixed(0)}% beat rate) - execution challenges or overoptimistic guidance`,
        );
      }
      if (pattern === "deteriorating") {
        flags.push(
          "Recent earnings surprises deteriorating - monitor for execution slippage",
        );
      }
      if (surprises.length >= 2 && !surprises[0]!.beat && !surprises[1]!.beat) {
        flags.push(
          "Missed estimates in last 2 consecutive quarters - potential headwinds",
        );
      }

      const result: EarningsSurpriseResult = {
        surprises,
        pattern,
        trend,
        avgSurprisePercent,
        beatRate,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Earnings surprise analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
