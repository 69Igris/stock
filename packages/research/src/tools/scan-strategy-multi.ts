/**
 * Scan Strategy Multi Tool
 *
 * Scans multiple stocks against a trading strategy.
 * Fetches price history internally for each symbol and runs evaluate_strategy logic.
 * Returns matches sorted by score (highest first).
 */

import { yahooFetchChart } from "@usemoney/core/market-data";
import type { ResearchToolDef, ToolOutput } from "./types";
import {
  evaluateRule,
  type StrategyRule,
  type StrategyDefinition,
  type SignalResult,
} from "../lib/indicators";

// ─── Scan-specific types ──────────────────────────────────

interface ScanMatch {
  symbol: string;
  matchScore: number;
  match: boolean;
  currentPrice: number;
  signals: SignalResult[];
  recommendation: string;
}

// ─── Fetch price history for a symbol ──────────────────────

async function fetchPrices(
  symbol: string,
  timeframe: string,
): Promise<{ closes: number[]; volumes: number[] } | null> {
  try {
    const periodMs: Record<string, number> = {
      "1m": 30 * 86_400_000,
      "3m": 90 * 86_400_000,
      "6m": 180 * 86_400_000,
      "1y": 365 * 86_400_000,
      "2y": 730 * 86_400_000,
    };
    const now = new Date();
    const ms = periodMs[timeframe] || periodMs["1y"]!;
    const period1 = new Date(now.getTime() - ms);

    const bars = await yahooFetchChart(symbol, {
      period1,
      period2: now,
      interval: "1d",
    });

    if (!bars.length || bars.length < 30) return null;

    return {
      closes: bars.map((b) => b.close),
      volumes: bars.map((b) => b.volume),
    };
  } catch {
    return null;
  }
}

// ─── Tool Definition ───────────────────────────────────────

export const scanStrategyMultiTool: ResearchToolDef = {
  name: "scan_strategy_multi",
  description:
    "Scan multiple stocks against a trading strategy to find matches. Fetches price data internally.",
  category: "computation",
  parameters: {
    symbols: {
      type: "string[]",
      description: 'Stock symbols to scan (e.g., ["RELIANCE.NS", "TCS.NS"])',
      required: true,
    },
    strategy: {
      type: "object",
      description: "Strategy definition with name and rules array",
      required: true,
    },
    timeframe: {
      type: "string",
      description: "Price history timeframe: 1m, 3m, 6m, 1y, 2y",
      default: "1y",
    },
    limit: {
      type: "number",
      description: "Max results to return",
      default: 20,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const symbols = params.symbols as string[] | undefined;
    const strategy = params.strategy as StrategyDefinition | undefined;
    const timeframe = (params.timeframe as string) || "1y";
    const limit = (params.limit as number) || 20;

    if (!symbols?.length || !strategy?.rules?.length) {
      return {
        success: false,
        error: "symbols array and strategy (with rules) are required",
      };
    }

    try {
      // Process in batches of 5 to avoid overwhelming Yahoo API
      const BATCH_SIZE = 5;
      const results: ScanMatch[] = [];
      const errors: string[] = [];

      for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map(async (symbol) => {
            const data = await fetchPrices(symbol, timeframe);
            if (!data) {
              errors.push(`${symbol}: no price data`);
              return null;
            }

            const signals: SignalResult[] = [];
            for (const rule of strategy.rules) {
              signals.push(evaluateRule(rule, data.closes, data.volumes));
            }

            const metCount = signals.filter((s) => s.met).length;
            const totalRules = signals.length;
            const score = Math.round((metCount / totalRules) * 100);
            const currentPrice = data.closes[data.closes.length - 1]!;

            let recommendation: string;
            if (metCount === totalRules) {
              recommendation = "All conditions met - entry candidate";
            } else if (score >= 60) {
              recommendation = `${metCount}/${totalRules} conditions met - partial match`;
            } else {
              recommendation = "Strategy not triggered";
            }

            return {
              symbol,
              matchScore: score,
              match: metCount === totalRules,
              currentPrice,
              signals,
              recommendation,
            } satisfies ScanMatch;
          }),
        );

        for (const r of batchResults) {
          if (r.status === "fulfilled" && r.value) {
            results.push(r.value);
          }
        }
      }

      // Sort by score descending, take top results
      results.sort((a, b) => b.matchScore - a.matchScore);
      const matches = results.filter((r) => r.matchScore > 0).slice(0, limit);
      const fullMatches = results.filter((r) => r.match);

      return {
        success: true,
        data: {
          strategyName: strategy.name,
          totalScanned: symbols.length,
          totalFetched: symbols.length - errors.length,
          matchCount: fullMatches.length,
          matches,
          errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
        },
        metadata: {
          timeframe,
          rulesCount: strategy.rules.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Strategy scan failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
