/**
 * Detect Candlestick Patterns Tool
 *
 * Fetches OHLCV data for a symbol and detects 25 candlestick patterns
 * in the most recent bars. Returns pattern name, type (bullish/bearish/neutral),
 * confidence score, and description for each detected pattern.
 */

import {
  yahooFetchChart,
  withExchangeFallback,
} from "@usemoney/core/market-data";
import type { ResearchToolDef, ToolOutput } from "./types";
import { detectCandlestickPatterns } from "../lib/candlestick-patterns";

export const detectCandlestickPatternsTool: ResearchToolDef = {
  name: "detect_candlestick_patterns",
  description:
    "Detect candlestick patterns (Hammer, Doji, Engulfing, Morning Star, etc.) from recent OHLCV price data for a stock symbol",
  category: "computation",
  parameters: {
    symbol: {
      type: "string",
      description: "Stock symbol (e.g. RELIANCE.NS, TCS.NS, AAPL)",
      required: true,
    },
    lookback: {
      type: "number",
      description: "Number of recent bars to scan for patterns (default 10)",
      default: 10,
    },
    period: {
      type: "string",
      description: "Price history period: 1m, 3m, 6m (default 3m)",
      default: "3m",
    },
    interval: {
      type: "string",
      description: "Candle interval: 1d, 1wk (default 1d)",
      default: "1d",
    },
  },
  cacheTTL: 3600, // 1h - patterns don't change intraday for daily candles
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    const lookback = (params.lookback as number) || 10;
    const period = (params.period as string) || "3m";
    const interval = (params.interval as string) || "1d";

    if (!symbol) {
      return { success: false, error: "symbol is required" };
    }

    try {
      const now = new Date();
      const periodMs: Record<string, number> = {
        "1m": 30 * 24 * 60 * 60 * 1000,
        "3m": 90 * 24 * 60 * 60 * 1000,
        "6m": 180 * 24 * 60 * 60 * 1000,
      };
      const ms = periodMs[period] || periodMs["3m"]!;
      const period1 = new Date(now.getTime() - ms);

      // Fetch OHLCV data with exchange fallback for BSE/NSE symbols
      const bars =
        (await withExchangeFallback(symbol, async (s) => {
          const result = await yahooFetchChart(s, {
            period1,
            period2: now,
            interval,
          });
          return result.length > 0 ? result : null;
        })) ?? [];

      if (bars.length < 3) {
        return {
          success: false,
          error: `Insufficient price data for ${symbol} (need at least 3 bars, got ${bars.length})`,
        };
      }

      const opens = bars.map((b) => b.open);
      const highs = bars.map((b) => b.high);
      const lows = bars.map((b) => b.low);
      const closes = bars.map((b) => b.close);

      const patterns = detectCandlestickPatterns(
        opens,
        highs,
        lows,
        closes,
        lookback,
      );

      // Enrich with date information
      const enriched = patterns.map((p) => ({
        ...p,
        date: bars[p.barIndex]?.date
          ? (bars[p.barIndex]!.date as Date).toISOString().split("T")[0]
          : undefined,
      }));

      // Summary counts
      const bullishCount = patterns.filter((p) => p.type === "bullish").length;
      const bearishCount = patterns.filter((p) => p.type === "bearish").length;
      const neutralCount = patterns.filter((p) => p.type === "neutral").length;

      // Overall bias
      let bias: "bullish" | "bearish" | "neutral" = "neutral";
      if (bullishCount > bearishCount + 1) bias = "bullish";
      else if (bearishCount > bullishCount + 1) bias = "bearish";

      return {
        success: true,
        data: {
          symbol,
          interval,
          totalBars: bars.length,
          lookback,
          patterns: enriched,
          summary: {
            totalDetected: patterns.length,
            bullish: bullishCount,
            bearish: bearishCount,
            neutral: neutralCount,
            bias,
            highConfidence: patterns.filter((p) => p.confidence >= 75).length,
          },
        },
        metadata: {
          barsAnalyzed: Math.min(lookback, bars.length),
          period,
          interval,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Candlestick pattern detection failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
