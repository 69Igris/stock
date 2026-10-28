/**
 * Strategy Stats Sync Processor - MONEY-406.
 *
 * Runs each built-in strategy through @usemoney/research's strategy
 * executor over historical prices and writes the resulting stats to
 * Redis under `strategies:stats:all`. The Strategies Browse page
 * reads this via getStrategiesStatsAction (cached fallback to the
 * catalog defaults when the key is unset).
 *
 * Cron: Sun 8:00 PM IST. Topic: strategy-stats-sync.
 *
 * Stats shape (per strategy id) matches StrategyStatsMap on the web:
 *   { return1Y, backtest, users, curve, computedAt }
 *
 * Compute approach (first cut):
 *   - Walk a canonical universe (NIFTY 500) per strategy
 *   - For each: load 5y daily closes, generate signals via the
 *     strategy spec, compute equity curve + CAGR + Sharpe + max DD
 *   - users count is read from the existing Scanner.userCount field
 *     once that schema lands; until then the catalog default carries.
 *
 * Heavy compute lives in @usemoney/research's strategy executor - this
 * processor is a thin orchestrator that fans out work and persists
 * the rolled-up stats blob.
 */

import { setCached } from "@usemoney/core";
import type { StrategyStatsSyncMessage } from "@usemoney/types";

interface StrategyStats {
  return1Y: string;
  backtest: string;
  users: number;
  curve: number[];
  computedAt: string;
}

const CACHE_NAMESPACE = "strategies" as const;
const REDIS_KEY = "strategies:stats:all";
const STATS_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// Canonical built-in strategies for the first cut. Once Scanner table
// has user-defined entries, this list extends via DB query.
const BUILT_IN_STRATEGY_IDS = [
  "golden-cross",
  "12m-momentum",
  "magic-formula",
  "roic-quality",
  "rsi-mean-rev",
  "cup-and-handle",
];

/**
 * Compute stats for a single strategy. The actual signal generation +
 * portfolio backtest lives in @usemoney/research; this stub returns
 * the catalog-default values so the worker shape is correct end-to-
 * end. Wire to `runStrategyBacktest(strategyId, universe, period)`
 * from packages/research when that helper lands.
 */
async function computeStrategyStats(
  strategyId: string,
): Promise<StrategyStats | null> {
  // TODO: import { runStrategyBacktest } from "@usemoney/research/strategies"
  //       once the executor exposes a stats-only entry point.
  // Placeholder catalog values keep the action shape consistent with
  // the UI; the page degrades to its in-file catalog when the worker
  // writes the same values, so no UX regression.
  const placeholder: Record<string, StrategyStats> = {
    "golden-cross": {
      return1Y: "+24.8%",
      backtest: "18.4% CAGR · 5y",
      users: 1284,
      curve: [50, 52, 54, 56, 58, 62, 64, 68, 72, 76, 82, 88],
      computedAt: new Date().toISOString(),
    },
    "12m-momentum": {
      return1Y: "+31.4%",
      backtest: "24.1% CAGR · 5y",
      users: 970,
      curve: [50, 51, 56, 54, 60, 63, 67, 72, 76, 82, 88, 95],
      computedAt: new Date().toISOString(),
    },
    "magic-formula": {
      return1Y: "+12.2%",
      backtest: "19.8% CAGR · 10y",
      users: 2104,
      curve: [50, 48, 52, 55, 58, 60, 63, 68, 72, 76, 80, 86],
      computedAt: new Date().toISOString(),
    },
    "roic-quality": {
      return1Y: "+22.4%",
      backtest: "21.0% CAGR · 5y",
      users: 1480,
      curve: [50, 52, 54, 56, 58, 60, 63, 67, 71, 75, 80, 85],
      computedAt: new Date().toISOString(),
    },
    "rsi-mean-rev": {
      return1Y: "+8.2%",
      backtest: "14.6% CAGR · 5y",
      users: 612,
      curve: [50, 53, 51, 54, 56, 53, 56, 58, 56, 59, 61, 60],
      computedAt: new Date().toISOString(),
    },
    "cup-and-handle": {
      return1Y: "+18.6%",
      backtest: "22.8% CAGR · 5y",
      users: 412,
      curve: [50, 52, 54, 56, 58, 62, 64, 68, 72, 76, 82, 88],
      computedAt: new Date().toISOString(),
    },
  };
  return placeholder[strategyId] ?? null;
}

export async function processStrategyStatsSync(
  data: StrategyStatsSyncMessage,
): Promise<void> {
  const ids =
    data.strategyIds && data.strategyIds.length > 0
      ? data.strategyIds
      : BUILT_IN_STRATEGY_IDS;

  console.log(
    `[strategy-stats-sync] Computing stats for ${ids.length} strategies${
      data.force ? " (force)" : ""
    }`,
  );

  const stats: Record<string, StrategyStats> = {};
  for (const id of ids) {
    try {
      const s = await computeStrategyStats(id);
      if (s) stats[id] = s;
    } catch (error) {
      console.warn(
        `[strategy-stats-sync] ${id} threw:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  if (Object.keys(stats).length === 0) {
    console.warn("[strategy-stats-sync] No stats computed - skipping write");
    return;
  }

  await setCached(CACHE_NAMESPACE, "global", REDIS_KEY, stats, undefined, {
    ttl: STATS_TTL_SECONDS,
    enableMemory: false,
    enableRedis: true,
  });

  console.log(
    `[strategy-stats-sync] Wrote stats for ${Object.keys(stats).length} strategies → strategies:stats:all`,
  );
}
