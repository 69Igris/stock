/**
 * Strategy-Aware Analysis Tool
 *
 * Evaluates how well a stock fits a specific built-in strategy from the
 * strategy library. For each filter/rule in the strategy, computes the
 * current value, how close it is to the threshold, and a per-rule fit score.
 * Returns overall fit, per-rule breakdown, recommendation, and gaps.
 *
 * Phase 11C: Strategy-Aware Analysis
 */

import type { ResearchToolDef, ToolOutput } from "./types";
import {
  getStrategyById,
  type BuiltInStrategy,
  type StrategyFilter,
} from "../strategies/builtin-strategies";
import {
  sma,
  computeRSI,
  computeMACD,
  computeBollingerBands,
} from "../lib/indicators";
import { insufficientInput } from "./insufficient-input";

// ─── Types ──────────────────────────────────────────────────

interface RatiosInput {
  pe?: number;
  pb?: number;
  roe?: number;
  roce?: number;
  debtToEquity?: number;
  currentRatio?: number;
  divYield?: number;
  opmf?: number;
  npmf?: number;
  gpmf?: number;
  evToEbitda?: number;
  peg?: number;
  epsGrowth?: number;
  revGrowth?: number;
  mrktCapf?: number;
  intCov?: number;
  promoterHolding?: number;
  revf?: number;
  [key: string]: number | undefined;
}

interface RuleFitResult {
  metric: string;
  threshold: string;
  actual: number | null;
  met: boolean;
  fitScore: number; // 0–100
  detail: string;
}

interface StrategyFitResult {
  symbol: string;
  strategyId: string;
  strategyName: string;
  strategyDescription: string;
  category: string;
  overallFit: number; // 0–100 weighted average
  rules: RuleFitResult[];
  recommendation: string;
  gaps: string[];
}

// ─── Metric Weight Map ──────────────────────────────────────

/**
 * Weights for different metric categories.
 * Core valuation/profitability metrics weigh more than secondary ones.
 */
const METRIC_WEIGHTS: Record<string, number> = {
  pe: 1.5,
  pb: 1.2,
  roe: 1.5,
  roce: 1.5,
  debtToEquity: 1.3,
  currentRatio: 1.0,
  divYield: 1.0,
  opmf: 1.2,
  npmf: 1.0,
  gpmf: 1.0,
  evToEbitda: 1.2,
  peg: 1.3,
  epsGrowth: 1.3,
  revGrowth: 1.2,
  mrktCapf: 0.8,
  intCov: 1.0,
  promoterHolding: 0.9,
  revf: 0.7,
  // Technical
  rsi: 1.0,
  sma_crossover: 1.0,
  price_vs_sma: 1.0,
  bollinger: 0.8,
  supertrend: 0.9,
  ichimoku: 0.9,
};

// ─── Helpers ────────────────────────────────────────────────

/**
 * Get the actual value for a metric from ratios or computed from prices.
 */
function getActualValue(
  filter: StrategyFilter,
  ratios: RatiosInput,
  prices?: number[],
  volumes?: number[],
): number | null {
  // For fundamental metrics, look up in ratios
  if (filter.source === "fundamental") {
    const val = ratios[filter.metric];
    return val !== undefined ? val : null;
  }

  // For technical metrics, compute from price data
  if (filter.source === "technical" && prices && prices.length > 0) {
    const currentPrice = prices[prices.length - 1]!;

    switch (filter.metric) {
      case "rsi":
        return computeRSI(prices, 14);

      case "sma_crossover": {
        // Returns 1 if SMA50 > SMA200, -1 otherwise
        const sma50 = sma(prices, 50);
        const sma200 = sma(prices, 200);
        return sma50 > sma200 ? 1 : -1;
      }

      case "price_vs_sma": {
        // filter.value is the SMA period (e.g., 200)
        const period = filter.value || 200;
        const smaVal = sma(prices, period);
        return currentPrice > smaVal ? 1 : -1;
      }

      case "bollinger": {
        const bb = computeBollingerBands(prices, 20, 2);
        return bb.bandwidth;
      }

      case "supertrend": {
        // Simplified: return 1 for bullish tendency, -1 for bearish
        const sma20 = sma(prices, 20);
        return currentPrice > sma20 ? 1 : -1;
      }

      case "ichimoku": {
        // Simplified: return 1 if above long-term avg
        const sma52 = sma(prices, 52);
        return currentPrice > sma52 ? 1 : -1;
      }

      default:
        return null;
    }
  }

  return null;
}

/**
 * Compute a proportional fit score for a single rule.
 *
 * - If the condition is met: returns 100.
 * - If not met: returns a proportional score based on how close the actual
 *   value is to the threshold. Closer = higher score.
 *
 * For "gt"/"gte" (greater-than): score = min(100, (actual / threshold) * 100)
 * For "lt"/"lte" (less-than):    score = min(100, (threshold / actual) * 100)
 * For "between":                 score based on distance to the range
 */
function computeRuleFitScore(
  filter: StrategyFilter,
  actual: number | null,
): { met: boolean; fitScore: number } {
  if (actual === null) {
    return { met: false, fitScore: 0 };
  }

  const { operator, value, value2 } = filter;

  switch (operator) {
    case "gt": {
      if (actual > value) return { met: true, fitScore: 100 };
      if (value === 0) return { met: false, fitScore: 0 };
      const ratio = actual / value;
      return {
        met: false,
        fitScore: Math.max(0, Math.min(99, Math.round(ratio * 100))),
      };
    }

    case "gte": {
      if (actual >= value) return { met: true, fitScore: 100 };
      if (value === 0) return { met: false, fitScore: 0 };
      const ratio = actual / value;
      return {
        met: false,
        fitScore: Math.max(0, Math.min(99, Math.round(ratio * 100))),
      };
    }

    case "lt": {
      if (actual < value) return { met: true, fitScore: 100 };
      if (actual === 0) return { met: false, fitScore: 99 };
      // The closer actual is to value (from above), the higher the score
      const ratio = value / actual;
      return {
        met: false,
        fitScore: Math.max(0, Math.min(99, Math.round(ratio * 100))),
      };
    }

    case "lte": {
      if (actual <= value) return { met: true, fitScore: 100 };
      if (actual === 0) return { met: false, fitScore: 99 };
      const ratio = value / actual;
      return {
        met: false,
        fitScore: Math.max(0, Math.min(99, Math.round(ratio * 100))),
      };
    }

    case "eq": {
      if (actual === value) return { met: true, fitScore: 100 };
      if (value === 0 && actual === 0) return { met: true, fitScore: 100 };
      const diff = Math.abs(actual - value);
      const maxDiff = Math.max(Math.abs(value), 1);
      const proximity = Math.max(0, 1 - diff / maxDiff);
      return { met: false, fitScore: Math.round(proximity * 100) };
    }

    case "between": {
      const lo = value;
      const hi = value2 ?? value;
      if (actual >= lo && actual <= hi) return { met: true, fitScore: 100 };
      // Distance from the range
      const range = hi - lo;
      if (range <= 0) return { met: false, fitScore: 0 };
      if (actual < lo) {
        const dist = lo - actual;
        const proximity = Math.max(0, 1 - dist / range);
        return { met: false, fitScore: Math.round(proximity * 100) };
      }
      // actual > hi
      const dist = actual - hi;
      const proximity = Math.max(0, 1 - dist / range);
      return { met: false, fitScore: Math.round(proximity * 100) };
    }

    default:
      return { met: false, fitScore: 0 };
  }
}

/**
 * Format threshold description for human readability
 */
function formatThreshold(filter: StrategyFilter): string {
  const opLabels: Record<string, string> = {
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
    eq: "=",
    between: "between",
  };
  const op = opLabels[filter.operator] || filter.operator;
  if (filter.operator === "between") {
    return `${op} ${filter.value} and ${filter.value2}`;
  }
  return `${op} ${filter.value}`;
}

/**
 * Generate recommendation text based on overall fit
 */
function generateRecommendation(
  overallFit: number,
  metCount: number,
  totalRules: number,
  strategyName: string,
): string {
  if (overallFit >= 90) {
    return `Excellent fit for ${strategyName}. All key criteria are met or very close. This stock aligns strongly with the strategy thesis.`;
  }
  if (overallFit >= 70) {
    return `Good fit for ${strategyName} (${metCount}/${totalRules} rules met). Most conditions are satisfied. Review the gaps below to assess if the missing criteria are dealbreakers.`;
  }
  if (overallFit >= 50) {
    return `Moderate fit for ${strategyName} (${metCount}/${totalRules} rules met). Several conditions are close but not fully met. The stock shows partial alignment - monitor for improvement.`;
  }
  if (overallFit >= 30) {
    return `Weak fit for ${strategyName} (${metCount}/${totalRules} rules met). Significant gaps exist between the stock's current metrics and strategy requirements.`;
  }
  return `Poor fit for ${strategyName} (${metCount}/${totalRules} rules met). The stock does not align with this strategy's criteria. Consider alternative strategies.`;
}

// ─── Tool Definition ────────────────────────────────────────

export const computeStrategyFitTool: ResearchToolDef = {
  name: "compute_strategy_fit",
  description:
    "Evaluate how well a stock fits a built-in investment strategy. Returns per-rule fit scores, overall fit, recommendation, and gaps.",
  category: "computation",
  parameters: {
    symbol: {
      type: "string",
      description: "Stock symbol (e.g., RELIANCE.NS)",
      required: true,
    },
    prices: {
      type: "array",
      description:
        "Historical closing prices array sorted chronologically (oldest first)",
      required: true,
    },
    ratios: {
      type: "object",
      description:
        "Object with fundamental ratios: PE, PB, ROE, ROCE, debtToEquity, currentRatio, divYield, opmf, npmf, gpmf, evToEbitda, peg, epsGrowth, revGrowth, mrktCapf, intCov, promoterHolding, revf",
      required: true,
    },
    strategy_id: {
      type: "string",
      description:
        "Built-in strategy ID (e.g., 'graham_net_net', 'economic_moat', 'garp'). Use getStrategyById to look up.",
      required: true,
    },
    volumes: {
      type: "array",
      description:
        "Volume array (same length as prices) - optional, needed for volume-based strategies",
    },
  },
  cacheTTL: 1800, // 30 minute cache

  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string | undefined;
    const prices = params.prices as number[] | undefined;
    const ratios = params.ratios as RatiosInput | undefined;
    const strategyId = params.strategy_id as string | undefined;
    const volumes = params.volumes as number[] | undefined;

    // ── Validation ────────────────────────────────────────
    if (!symbol) {
      return { success: false, error: "symbol is required" };
    }
    if (!prices || !Array.isArray(prices)) {
      return { success: false, error: "prices array is required" };
    }
    if (prices.length < 10) {
      return insufficientInput("At least 10 price data points required", {
        needed: "10 price points",
        got: prices.length,
      });
    }
    if (!ratios || typeof ratios !== "object") {
      return {
        success: false,
        error: "ratios object is required with fundamental metrics",
      };
    }
    if (!strategyId) {
      return { success: false, error: "strategy_id is required" };
    }

    // ── Load Strategy ─────────────────────────────────────
    const strategy: BuiltInStrategy | undefined = getStrategyById(strategyId);
    if (!strategy) {
      return {
        success: false,
        error: `Unknown strategy: "${strategyId}". Use a valid built-in strategy ID.`,
      };
    }

    if (strategy.filters.length === 0) {
      return {
        success: false,
        error: `Strategy "${strategy.name}" has no evaluable filters (may be Chartink-only).`,
      };
    }

    try {
      // ── Evaluate Each Filter ────────────────────────────
      const rules: RuleFitResult[] = [];
      const gaps: string[] = [];

      for (const filter of strategy.filters) {
        const actual = getActualValue(filter, ratios, prices, volumes);
        const { met, fitScore } = computeRuleFitScore(filter, actual);
        const threshold = formatThreshold(filter);

        let detail: string;
        if (actual === null) {
          detail = `${filter.metric}: data not available - cannot evaluate`;
          gaps.push(`Missing data for ${filter.metric}`);
        } else if (met) {
          detail = `${filter.metric} = ${actual} (${threshold}) - PASS`;
        } else {
          detail = `${filter.metric} = ${actual} (needs ${threshold}) - ${fitScore}% fit`;
          const gapDescription = describeGap(filter, actual);
          if (gapDescription) gaps.push(gapDescription);
        }

        rules.push({
          metric: filter.metric,
          threshold,
          actual,
          met,
          fitScore,
          detail,
        });
      }

      // ── Compute Overall Fit ─────────────────────────────
      let totalWeight = 0;
      let weightedScore = 0;

      for (const rule of rules) {
        const weight = METRIC_WEIGHTS[rule.metric] || 1.0;
        // Rules with null actual get 0 score and reduced weight
        if (rule.actual === null) {
          totalWeight += weight * 0.5; // Partial penalty for missing data
          // weightedScore += 0;
        } else {
          totalWeight += weight;
          weightedScore += rule.fitScore * weight;
        }
      }

      const overallFit =
        totalWeight > 0
          ? Math.round((weightedScore / totalWeight) * 100) / 100
          : 0;

      const metCount = rules.filter((r) => r.met).length;
      const totalRules = rules.length;

      const recommendation = generateRecommendation(
        overallFit,
        metCount,
        totalRules,
        strategy.name,
      );

      // ── Assemble Result ─────────────────────────────────
      const result: StrategyFitResult = {
        symbol,
        strategyId: strategy.id,
        strategyName: strategy.name,
        strategyDescription: strategy.description,
        category: strategy.category,
        overallFit,
        rules,
        recommendation,
        gaps,
      };

      return {
        success: true,
        data: result,
        metadata: {
          strategyId: strategy.id,
          metCount,
          totalRules,
          overallFit,
          hasGaps: gaps.length > 0,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Strategy fit analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ─── Gap Description Helper ─────────────────────────────────

function describeGap(filter: StrategyFilter, actual: number): string | null {
  const { metric, operator, value, value2 } = filter;

  switch (operator) {
    case "gt":
    case "gte": {
      const diff = Math.round((value - actual) * 100) / 100;
      return `${metric} is ${diff} below the ${value} threshold (current: ${actual})`;
    }
    case "lt":
    case "lte": {
      const diff = Math.round((actual - value) * 100) / 100;
      return `${metric} exceeds the ${value} threshold by ${diff} (current: ${actual})`;
    }
    case "between": {
      const lo = value;
      const hi = value2 ?? value;
      if (actual < lo) {
        return `${metric} is ${Math.round((lo - actual) * 100) / 100} below the range [${lo}-${hi}] (current: ${actual})`;
      }
      return `${metric} is ${Math.round((actual - hi) * 100) / 100} above the range [${lo}-${hi}] (current: ${actual})`;
    }
    default:
      return null;
  }
}
