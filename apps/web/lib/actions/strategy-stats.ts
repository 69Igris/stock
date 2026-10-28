"use server";

/**
 * Strategy stats action - MONEY-406.
 *
 * Reads the worker-computed `strategies:stats:all` Redis blob and
 * returns per-strategy stats keyed by strategy id. The Strategies
 * Browse page renders these on the card grid (1Y return / backtest
 * CAGR / users count / equity-curve sparkline).
 *
 * Today this returns the static catalog values until the
 * `workers/src/processors/strategy-stats-sync.ts` lands and starts
 * populating the Redis key on a weekly cron (Sun 8 PM IST). The cache
 * key + shape is committed now so the UI can flip from static to
 * live without further code changes.
 */

import { getCached } from "@usemoney/core";
import type { ActionResponse } from "@usemoney/validation";

export interface StrategyStats {
  /** Annualized 1Y return as a string e.g. "+24.8%" */
  return1Y: string;
  /** Backtest CAGR + period e.g. "18.4% CAGR · 5y" */
  backtest: string;
  /** Popularity count (active subscribers / users with this strategy) */
  users: number;
  /** Normalised equity curve (last 12 points, 50-anchored) */
  curve: number[];
  /** When the worker last computed these stats (ISO) */
  computedAt: string | null;
}

export type StrategyStatsMap = Record<string, StrategyStats>;

const REDIS_KEY = "strategies:stats:all";
const CACHE_NAMESPACE = "strategies" as const;

export async function getStrategiesStatsAction(): Promise<
  ActionResponse<StrategyStatsMap>
> {
  try {
    // Worker writes Redis under `strategies:stats:all`; getCached
    // returns null when the key is unset - we degrade to an empty map
    // and let the UI fall back to the static catalog values.
    const cached = await getCached<StrategyStatsMap>(
      CACHE_NAMESPACE,
      "global",
      REDIS_KEY
    );
    return { success: true, data: cached ?? {} };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
