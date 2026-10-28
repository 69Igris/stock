/**
 * Forward Scenario Analysis Tool
 *
 * Combines Monte Carlo simulation with historical analog pattern matching
 * to produce forward-looking price scenarios. Returns bull/base/bear targets,
 * confidence intervals, historical analogs, and a MANDATORY SEBI-safe disclaimer.
 *
 * Phase 11B: Forward Scenario Analysis
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import {
  runMonteCarloSimulation,
  type MonteCarloResult,
} from "../lib/monte-carlo";
import {
  findHistoricalAnalogs,
  type HistoricalAnalog,
} from "../lib/pattern-match";
import { insufficientInput } from "./insufficient-input";

// ─── Types ──────────────────────────────────────────────────

interface ForwardScenarioResult {
  symbol: string;
  currentPrice: number;
  daysForward: number;
  monteCarlo: MonteCarloResult;
  historicalAnalogs: HistoricalAnalog[];
  analogSummary: {
    avgSubsequentReturn: number;
    medianSubsequentReturn: number;
    matchCount: number;
    bestAnalogReturn: number;
    worstAnalogReturn: number;
  } | null;
  combined: {
    bullTarget: number;
    baseTarget: number;
    bearTarget: number;
    confidence: string;
  };
  disclaimer: string;
}

// ─── Constants ──────────────────────────────────────────────

const DISCLAIMER_TEXT =
  "DISCLAIMER: These projections are based on historical data and statistical models. " +
  "Past performance does not guarantee future results. This is not investment advice. " +
  "Please consult a SEBI-registered advisor before making investment decisions.";

// ─── Helper: Compute Daily Returns ──────────────────────────

function computeDailyReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1]! > 0) {
      returns.push((prices[i]! - prices[i - 1]!) / prices[i - 1]!);
    }
  }
  return returns;
}

// ─── Tool Definition ────────────────────────────────────────

export const computeForwardScenariosTool: ResearchToolDef = {
  name: "compute_forward_scenarios",
  description:
    "Run Monte Carlo simulation + historical pattern matching for forward price scenarios with bull/base/bear targets",
  category: "computation",
  parameters: {
    prices: {
      type: "array",
      description:
        "Historical closing prices array sorted chronologically (oldest first). Minimum 60 data points recommended.",
      required: true,
    },
    current_price: {
      type: "number",
      description: "Current stock price",
      required: true,
    },
    symbol: {
      type: "string",
      description: "Stock symbol (e.g., RELIANCE.NS)",
      required: true,
    },
    days_forward: {
      type: "number",
      description:
        "Number of trading days to project forward (default 252 = 1 year)",
      default: 252,
    },
  },
  cacheTTL: 3600, // 1 hour cache

  execute: async (params): Promise<ToolOutput> => {
    const prices = params.prices as number[] | undefined;
    const currentPrice = params.current_price as number | undefined;
    const symbol = params.symbol as string | undefined;
    const daysForward = (params.days_forward as number) || 252;

    // ── Validation ────────────────────────────────────────
    if (!prices || !Array.isArray(prices)) {
      return { success: false, error: "prices array is required" };
    }
    if (prices.length < 30) {
      // MONEY-1274 (#30) — thin input, not a failure. See insufficient-input.ts.
      return insufficientInput(
        "At least 30 historical price data points are required",
        {
          needed: "30 price points",
          got: Array.isArray(prices) ? prices.length : 0,
        },
      );
    }

    if (!currentPrice || currentPrice <= 0) {
      return {
        success: false,
        error: "current_price must be a positive number",
      };
    }

    if (!symbol) {
      return {
        success: false,
        error: "symbol is required",
      };
    }

    try {
      // ── Step 1: Compute daily returns ────────────────────
      const dailyReturns = computeDailyReturns(prices);

      if (dailyReturns.length < 20) {
        return insufficientInput(
          "Insufficient price data to compute meaningful returns (need 20+ data points)",
        );
      }

      // ── Step 2: Run Monte Carlo simulation ───────────────
      const monteCarlo = runMonteCarloSimulation(
        currentPrice,
        dailyReturns,
        daysForward,
        10_000,
      );

      // ── Step 3: Find historical analogs ──────────────────
      const lookbackWindow = Math.min(60, Math.floor(prices.length / 4));
      const searchWindow = Math.max(
        lookbackWindow * 2,
        prices.length - lookbackWindow * 2,
      );

      const historicalAnalogs = findHistoricalAnalogs(
        prices,
        lookbackWindow,
        searchWindow,
        5,
      );

      // ── Step 4: Summarize analog results ─────────────────
      let analogSummary: ForwardScenarioResult["analogSummary"] = null;

      if (historicalAnalogs.length > 0) {
        const returns = historicalAnalogs.map((a) => a.subsequentReturn);
        const sorted = [...returns].sort((a, b) => a - b);
        const avgReturn =
          Math.round(
            (returns.reduce((s, r) => s + r, 0) / returns.length) * 100,
          ) / 100;
        const medianReturn =
          sorted.length % 2 === 0
            ? Math.round(
                ((sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) /
                  2) *
                  100,
              ) / 100
            : sorted[Math.floor(sorted.length / 2)]!;

        analogSummary = {
          avgSubsequentReturn: avgReturn,
          medianSubsequentReturn: medianReturn,
          matchCount: historicalAnalogs.length,
          bestAnalogReturn: sorted[sorted.length - 1]!,
          worstAnalogReturn: sorted[0]!,
        };
      }

      // ── Step 5: Combine Monte Carlo + Analogs ────────────
      // If we have analog data, blend it (70% MC, 30% analog) for combined targets
      const mc = monteCarlo.scenarios;
      let bullTarget = mc.bull.targetPrice;
      let baseTarget = mc.base.targetPrice;
      let bearTarget = mc.bear.targetPrice;
      let confidence = "Monte Carlo simulation only";

      if (analogSummary && historicalAnalogs.length >= 3) {
        // Weight: 70% Monte Carlo, 30% historical analog
        const analogBull =
          currentPrice * (1 + analogSummary.bestAnalogReturn / 100);
        const analogBase =
          currentPrice * (1 + analogSummary.avgSubsequentReturn / 100);
        const analogBear =
          currentPrice * (1 + analogSummary.worstAnalogReturn / 100);

        bullTarget =
          Math.round((0.7 * mc.bull.targetPrice + 0.3 * analogBull) * 100) /
          100;
        baseTarget =
          Math.round((0.7 * mc.base.targetPrice + 0.3 * analogBase) * 100) /
          100;
        bearTarget =
          Math.round((0.7 * mc.bear.targetPrice + 0.3 * analogBear) * 100) /
          100;
        confidence = `Blended: 70% Monte Carlo (${monteCarlo.simulations.toLocaleString()} sims) + 30% Historical Analogs (${historicalAnalogs.length} matches)`;
      }

      // ── Step 6: Assemble result ──────────────────────────
      const result: ForwardScenarioResult = {
        symbol,
        currentPrice,
        daysForward,
        monteCarlo,
        historicalAnalogs,
        analogSummary,
        combined: {
          bullTarget,
          baseTarget,
          bearTarget,
          confidence,
        },
        disclaimer: DISCLAIMER_TEXT,
      };

      return {
        success: true,
        data: result,
        metadata: {
          simulations: monteCarlo.simulations,
          analogMatches: historicalAnalogs.length,
          daysForward,
          dataPoints: prices.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Forward scenario analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
