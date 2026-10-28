/**
 * Evaluate Strategy Tool
 *
 * Evaluates a user-defined trading strategy against a stock using technical indicators.
 * Accepts closing prices and an array of strategy rules, computes each indicator,
 * and returns whether the strategy conditions are met.
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import {
  evaluateRule,
  type StrategyDefinition,
  type SignalResult,
} from "../lib/indicators";

// ─── Tool Definition ───────────────────────────────────────

export const evaluateStrategyTool: ResearchToolDef = {
  name: "evaluate_strategy",
  description:
    "Evaluate a trading strategy against a stock using technical indicators",
  category: "computation",
  parameters: {
    symbol: {
      type: "string",
      description: "Stock symbol (e.g., RELIANCE.NS)",
      required: true,
    },
    prices: {
      type: "array",
      description: "Closing prices array sorted chronologically (oldest first)",
      required: true,
    },
    volumes: {
      type: "array",
      description: "Volume array (same length as prices)",
    },
    strategy: {
      type: "object",
      description: "Strategy definition with name and rules array",
      required: true,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    const prices = params.prices as number[] | undefined;
    const volumes = params.volumes as number[] | undefined;
    const strategy = params.strategy as StrategyDefinition | undefined;

    if (!symbol || !prices?.length || !strategy?.rules?.length) {
      return {
        success: false,
        error: "symbol, prices, and strategy (with rules) are required",
      };
    }

    if (prices.length < 30) {
      return {
        success: false,
        error: "At least 30 price data points required",
      };
    }

    try {
      const signals: SignalResult[] = [];

      for (const rule of strategy.rules) {
        signals.push(evaluateRule(rule, prices, volumes));
      }

      const metCount = signals.filter((s) => s.met).length;
      const totalRules = signals.length;
      const score = Math.round((metCount / totalRules) * 100);
      const match = metCount === totalRules;

      let riskLevel: "low" | "medium" | "high" = "medium";
      if (score >= 80) riskLevel = "low";
      else if (score <= 40) riskLevel = "high";

      let recommendation: string;
      if (match) {
        recommendation =
          "Strategy conditions MET - potential entry point. Verify with volume and market context.";
      } else if (score >= 60) {
        recommendation = `${metCount}/${totalRules} conditions met - partial match. Monitor for remaining signals.`;
      } else {
        recommendation = `Only ${metCount}/${totalRules} conditions met - strategy NOT triggered.`;
      }

      return {
        success: true,
        data: {
          symbol,
          strategyName: strategy.name,
          match,
          score,
          signals,
          recommendation,
          riskLevel,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Strategy evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
