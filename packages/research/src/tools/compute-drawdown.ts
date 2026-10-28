/**
 * Drawdown Analysis
 *
 * Tracks running peak, underwater periods.
 * Computes max drawdown + recovery days.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import type { DrawdownResult } from "../types";
import { insufficientInput } from "./insufficient-input";

export const computeDrawdownTool: ResearchToolDef = {
  name: "compute_drawdown",
  description:
    "Compute max drawdown, current drawdown, and underwater periods from portfolio value series",
  category: "computation",
  parameters: {
    valueSeries: {
      type: "array",
      description:
        "Array of { date: string, value: number } sorted chronologically",
      required: true,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const series = params.valueSeries as
      | Array<{ date: string; value: number }>
      | undefined;

    if (!series?.length || series.length < 5) {
      // MONEY-1274 (#30) — thin input, not a failure. See insufficient-input.ts.
      return insufficientInput(
        "At least 5 data points are required for drawdown analysis",
        { needed: "5 data points", got: series?.length ?? 0 },
      );
    }

    try {
      let peak = series[0]!.value;
      let maxDD = 0;
      let maxDDStart = series[0]!.date;
      let maxDDEnd = series[0]!.date;
      let currentPeakDate = series[0]!.date;

      // Track underwater periods
      const underwaterPeriods: DrawdownResult["underwaterPeriods"] = [];
      let underwaterStart: string | null = null;
      let underwaterDepth = 0;

      for (let i = 0; i < series.length; i++) {
        const point = series[i]!;

        if (point.value >= peak) {
          // New peak - close any underwater period
          if (underwaterStart) {
            const startIdx = series.findIndex(
              (s) => s.date === underwaterStart,
            );
            underwaterPeriods.push({
              start: underwaterStart,
              end: point.date,
              depth: Math.round(underwaterDepth * 10000) / 10000,
              durationDays: i - startIdx,
            });
            underwaterStart = null;
            underwaterDepth = 0;
          }
          peak = point.value;
          currentPeakDate = point.date;
        } else {
          // Drawdown is a fraction of the prior peak; it is only defined for a
          // positive peak. A zero peak yields ±Infinity (0/0 → NaN) and a
          // NEGATIVE peak flips the sign (a deeper loss reads as a positive
          // "drawdown"). Portfolio values are normally > 0, so guard the
          // out-of-domain case to a finite 0 instead of leaking Infinity/NaN
          // or a sign-flipped figure.
          const dd = peak > 0 ? (point.value - peak) / peak : 0;

          if (!underwaterStart) {
            underwaterStart = currentPeakDate;
          }
          if (dd < underwaterDepth) {
            underwaterDepth = dd;
          }

          if (dd < maxDD) {
            maxDD = dd;
            maxDDStart = currentPeakDate;
            maxDDEnd = point.date;
          }
        }
      }

      // If still underwater at end
      if (underwaterStart) {
        const lastPoint = series[series.length - 1]!;
        const startIdx = series.findIndex((s) => s.date === underwaterStart);
        underwaterPeriods.push({
          start: underwaterStart,
          end: lastPoint.date,
          depth: Math.round(underwaterDepth * 10000) / 10000,
          durationDays: series.length - 1 - startIdx,
        });
      }

      // Current drawdown (same positive-peak domain guard as the loop above).
      const lastValue = series[series.length - 1]!.value;
      const currentDrawdown =
        lastValue < peak && peak > 0 ? (lastValue - peak) / peak : 0;

      // Recovery days for max drawdown
      const maxDDEndIdx = series.findIndex((s) => s.date === maxDDEnd);
      let recoveryDays: number | null = null;
      const peakAtMaxDD =
        series.find((s) => s.date === maxDDStart)?.value || peak;

      for (let i = maxDDEndIdx + 1; i < series.length; i++) {
        if (series[i]!.value >= peakAtMaxDD) {
          recoveryDays = i - maxDDEndIdx;
          break;
        }
      }

      const result: DrawdownResult = {
        maxDrawdown: Math.round(maxDD * 10000) / 10000,
        maxDrawdownStart: maxDDStart,
        maxDrawdownEnd: maxDDEnd,
        recoveryDays,
        currentDrawdown: Math.round(currentDrawdown * 10000) / 10000,
        underwaterPeriods: underwaterPeriods
          .sort((a, b) => a.depth - b.depth)
          .slice(0, 5),
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Drawdown computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
