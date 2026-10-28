/**
 * Chart Pattern Detection Tool
 *
 * Detects classic chart patterns (Head & Shoulders, Double Top/Bottom,
 * Triangles, Flags, Wedges, Cup & Handle, Rounding Bottom, Channels)
 * from OHLCV price data using peak/trough detection and geometric matching.
 *
 * Uses the shared chart-patterns library for all computations.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import {
  detectChartPatterns,
  findPeaksAndTroughs,
} from "../lib/chart-patterns";

export const detectChartPatternsTool: ResearchToolDef = {
  name: "detect_chart_patterns",
  description:
    "Detect classic chart patterns (Head & Shoulders, Double Top/Bottom, Triangles, Flags, Wedges, Cup & Handle, Rounding Bottom, Channels) from OHLCV price history. Returns identified patterns with confidence scores, breakout targets, and support/resistance levels.",
  category: "computation",
  parameters: {
    prices: {
      type: "array",
      description:
        "Array of closing prices sorted chronologically (oldest first). Minimum 20 data points required.",
      required: true,
    },
    highs: {
      type: "array",
      description: "Array of high prices (same length and order as prices).",
      required: true,
    },
    lows: {
      type: "array",
      description: "Array of low prices (same length and order as prices).",
      required: true,
    },
    volumes: {
      type: "array",
      description:
        "Array of trading volumes (same length and order as prices). Optional - improves confidence scoring when provided.",
    },
    sensitivity: {
      type: "number",
      description:
        "Peak/trough detection sensitivity (default 5). Lower values detect more patterns (noisier), higher values detect fewer but more significant patterns.",
      default: 5,
    },
    minConfidence: {
      type: "number",
      description:
        "Minimum confidence threshold (0-100) for returned patterns (default 40). Patterns below this score are filtered out.",
      default: 40,
    },
  },
  cacheTTL: 3600, // 1 hour - price data changes intraday
  execute: async (params): Promise<ToolOutput> => {
    const prices = params.prices as number[] | undefined;
    const highs = params.highs as number[] | undefined;
    const lows = params.lows as number[] | undefined;
    const volumes = params.volumes as number[] | undefined;
    const minConfidence = (params.minConfidence as number) ?? 40;

    // ─── Validation ─────────────────────────────────────────

    if (!prices?.length || prices.length < 20) {
      return {
        success: false,
        error:
          "At least 20 closing price data points are required for chart pattern detection",
      };
    }

    if (!highs?.length || highs.length !== prices.length) {
      return {
        success: false,
        error:
          "highs array is required and must have the same length as prices",
      };
    }

    if (!lows?.length || lows.length !== prices.length) {
      return {
        success: false,
        error: "lows array is required and must have the same length as prices",
      };
    }

    if (volumes && volumes.length !== prices.length) {
      return {
        success: false,
        error:
          "volumes array, if provided, must have the same length as prices",
      };
    }

    // ─── Detection ──────────────────────────────────────────

    try {
      const allPatterns = detectChartPatterns(prices, highs, lows, volumes);

      // Filter by minimum confidence
      const filtered = allPatterns.filter((p) => p.confidence >= minConfidence);

      // Compute summary statistics
      const bullishCount = filtered.filter((p) => p.type === "bullish").length;
      const bearishCount = filtered.filter((p) => p.type === "bearish").length;
      const neutralCount = filtered.filter((p) => p.type === "neutral").length;

      let overallBias: "bullish" | "bearish" | "neutral" = "neutral";
      if (bullishCount > bearishCount && bullishCount > neutralCount) {
        overallBias = "bullish";
      } else if (bearishCount > bullishCount && bearishCount > neutralCount) {
        overallBias = "bearish";
      }

      // Find highest-confidence pattern
      const topPattern = filtered.length > 0 ? filtered[0] : null;

      // Generate a textual summary
      const summaryParts: string[] = [];
      if (filtered.length === 0) {
        summaryParts.push(
          "No significant chart patterns detected in the current price data.",
        );
      } else {
        summaryParts.push(
          `Detected ${filtered.length} chart pattern${filtered.length === 1 ? "" : "s"}: ` +
            `${bullishCount} bullish, ${bearishCount} bearish, ${neutralCount} neutral.`,
        );
        if (topPattern) {
          summaryParts.push(
            `Strongest signal: ${topPattern.pattern} (${topPattern.confidence}% confidence, ${topPattern.type}).`,
          );
          if (topPattern.breakoutTarget) {
            summaryParts.push(`Breakout target: ${topPattern.breakoutTarget}`);
          }
        }
      }

      return {
        success: true,
        data: {
          patterns: filtered,
          summary: {
            totalDetected: filtered.length,
            bullishCount,
            bearishCount,
            neutralCount,
            overallBias,
            topPattern: topPattern
              ? {
                  name: topPattern.pattern,
                  type: topPattern.type,
                  confidence: topPattern.confidence,
                  breakoutTarget: topPattern.breakoutTarget,
                }
              : null,
            textSummary: summaryParts.join(" "),
          },
          dataPoints: prices.length,
        },
        metadata: {
          patternsChecked: [
            "Head & Shoulders",
            "Inverse Head & Shoulders",
            "Double Top",
            "Double Bottom",
            "Ascending Triangle",
            "Descending Triangle",
            "Symmetrical Triangle",
            "Bull Flag",
            "Bear Flag",
            "Rising Wedge",
            "Falling Wedge",
            "Cup & Handle",
            "Rounding Bottom",
            "Channel Up",
            "Channel Down",
          ],
          minConfidenceUsed: minConfidence,
          volumeDataProvided: !!volumes,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Chart pattern detection failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
