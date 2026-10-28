/**
 * Strategy Executor - DB-First
 *
 * Executes strategies by running filters against the pre-seeded
 * StockRatios + DailyPrice tables via the Hybrid Screener Engine.
 *
 * NO external API calls (Tickertape, Chartink) for bulk scans.
 * Workers seed/sync all data on schedules. The screener engine
 * queries the DB directly - < 100ms per scan.
 *
 * Designed to run in WORKERS (compute-heavy), not the web app.
 */

import {
  runScreener,
  type ScreenerFilter,
  type ScreenerResult,
} from "@usemoney/core/screener/engine";
import type { BuiltInStrategy, StrategyFilter } from "./builtin-strategies";

// ─── Types ──────────────────────────────────────────────────

export interface StrategyExecutionResult {
  strategyId: string;
  strategyName: string;
  scanType: string;
  stockCount: number;
  stocks: StrategyMatchedStock[];
  executedAt: string;
  executionTimeMs: number;
  errors?: string[];
}

export interface StrategyMatchedStock {
  symbol: string;
  name: string;
  exchange?: string;
  price?: number;
  change?: number;
  matchedMetrics: Record<string, number | string>;
}

export interface CustomStrategyInput {
  id?: string;
  name: string;
  filters: StrategyFilter[];
  logic: "AND" | "OR";
  scanType: "fundamental" | "technical" | "combined";
  chartinkQuery?: string;
}

// ─── Filter Conversion ─────────────────────────────────────

/**
 * Convert StrategyFilter[] (research format) → ScreenerFilter[] (core engine format).
 *
 * StrategyFilter uses `metric` + `source` fields.
 * ScreenerFilter uses a single `field` field.
 * The Hybrid Screener Engine auto-routes to fundamental or technical pipeline
 * based on the field name - no explicit source routing needed.
 */
function convertToScreenerFilters(filters: StrategyFilter[]): ScreenerFilter[] {
  return filters
    .filter((f) => f.metric && f.operator && f.value !== undefined)
    .map((f) => {
      const filter: ScreenerFilter = {
        field: f.metric,
        operator:
          f.operator === "gte"
            ? "gt"
            : f.operator === "lte"
              ? "lt"
              : (f.operator as ScreenerFilter["operator"]),
        value:
          f.operator === "between" && f.value2 !== undefined
            ? [f.value, f.value2]
            : f.value,
      };
      return filter;
    });
}

/**
 * Convert ScreenerResult[] → StrategyMatchedStock[] for the response.
 */
function convertToMatchedStocks(
  results: ScreenerResult[],
  filters: StrategyFilter[],
): StrategyMatchedStock[] {
  return results.map((r) => ({
    symbol: r.symbol,
    name: r.name,
    exchange: r.exchange,
    price: r.price,
    matchedMetrics: extractMatchedMetrics(r, filters),
  }));
}

// ─── Executor ───────────────────────────────────────────────

/**
 * Execute a built-in or custom strategy.
 * Routes all scans through the Hybrid Screener Engine (pure DB queries).
 */
export async function executeStrategy(
  strategy: BuiltInStrategy | CustomStrategyInput,
  options: { limit?: number } = {},
): Promise<StrategyExecutionResult> {
  const startTime = Date.now();
  const limit = options.limit || 50;
  const errors: string[] = [];

  let stocks: StrategyMatchedStock[] = [];

  try {
    const screenerFilters = convertToScreenerFilters(strategy.filters);

    if (screenerFilters.length === 0) {
      errors.push("No valid filters to execute");
    } else {
      const results = await runScreener(screenerFilters, { limit });
      stocks = convertToMatchedStocks(results, strategy.filters);
    }
  } catch (error) {
    errors.push(
      `Execution failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    strategyId: "id" in strategy && strategy.id ? strategy.id : "custom",
    strategyName: strategy.name,
    scanType: strategy.scanType,
    stockCount: stocks.length,
    stocks,
    executedAt: new Date().toISOString(),
    executionTimeMs: Date.now() - startTime,
    errors: errors.length > 0 ? errors : undefined,
  };
}

// ─── Helpers ────────────────────────────────────────────────

function extractMatchedMetrics(
  result: ScreenerResult,
  filters: StrategyFilter[],
): Record<string, number | string> {
  const metrics: Record<string, number | string> = {};
  const resultMap = result as unknown as Record<string, unknown>;

  for (const filter of filters) {
    const val = resultMap[filter.metric];
    if (val !== undefined && val !== null) {
      metrics[filter.metric] = val as number | string;
    }
  }

  // Always include price if available
  if (result.price !== undefined && result.price !== null) {
    metrics.price = result.price;
  }

  return metrics;
}
