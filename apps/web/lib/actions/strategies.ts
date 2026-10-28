"use server";

/**
 * Strategies Server Actions (MONEY-197/4a)
 *
 * Surfaces the 122 built-in strategies from @usemoney/research for the
 * Strategies page UI. Stats (CAGR, Sharpe, 1Y return) are not pre-computed
 * yet - they return `null` by default, and the UI shows a "Run backtest"
 * button that triggers on-demand computation.
 *
 * This keeps the "no fake data" rule intact: we don't fabricate numbers,
 * we explicitly signal absence with null so the UI can render a placeholder.
 *
 * When portfolio-level backtesting lands (follow-up ticket), this action
 * will read from a new strategies_stats Redis entry populated by a weekly
 * worker. The shape won't change - just `stats` will be populated.
 */

import {
  BUILTIN_STRATEGIES,
  getStrategyCategories,
  type BuiltInStrategy,
  type StrategyCategory,
} from "@usemoney/research";
import type { ServiceResult } from "@usemoney/services";
import { getCached } from "@usemoney/core";

export interface StrategyStats {
  /** Compound annual growth rate, percent. */
  cagr: number;
  /** Sharpe ratio (dimensionless). */
  sharpe: number;
  /** Maximum drawdown, percent (always positive). */
  maxDrawdown: number;
  /** 1-year return, percent (may differ from CAGR if backtest > 1 year). */
  oneYearReturn: number;
  /** Backtest period - free-form string like "5y" or "Jan 2021 – Apr 2026". */
  period: string;
  /** Equity curve sample points (≤ 60 values, evenly spaced). */
  equityCurve: number[];
  /** Approximate user count across the platform. Null when tracking isn't wired. */
  users: number | null;
  /** When the stats were last refreshed. ISO string. */
  computedAt: string;
}

export interface StrategyCard {
  id: string;
  name: string;
  description: string;
  category: StrategyCategory;
  subcategory: string | null;
  tags: string[];
  attribution: string | null;
  /** Null = not yet backtested. UI shows "Run backtest" CTA. */
  stats: StrategyStats | null;
}

export interface StrategyCategoryInfo {
  category: StrategyCategory | "all";
  count: number;
  label: string;
}

/** Cache of strategy stats indexed by strategy id. Populated by the
 *  strategy-stats-sync worker (follow-up ticket). Lookup is always safe: a
 *  missing entry just means stats = null. */
async function loadStatsMap(): Promise<Map<string, StrategyStats>> {
  const cached = await getCached<Record<string, StrategyStats>>(
    "discover",
    "_global",
    "strategy-stats:all",
    undefined,
    { ttl: 24 * 60 * 60 }
  );
  if (!cached) return new Map();
  return new Map(Object.entries(cached));
}

function toCard(s: BuiltInStrategy, stats: StrategyStats | null): StrategyCard {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.category,
    subcategory: s.subcategory ?? null,
    tags: s.tags,
    attribution: s.attribution ?? null,
    stats,
  };
}

export async function getStrategyPresetsAction(options?: {
  category?: StrategyCategory;
  limit?: number;
}): Promise<ServiceResult<StrategyCard[]>> {
  try {
    const { category, limit = 60 } = options ?? {};
    const statsMap = await loadStatsMap();

    let pool: BuiltInStrategy[] = BUILTIN_STRATEGIES;
    if (category) {
      pool = pool.filter((s) => s.category === category);
    }

    // Sort: strategies with real stats first (by CAGR desc), then the rest
    // alphabetically so rendering order is deterministic.
    const cards = pool.map((s) => toCard(s, statsMap.get(s.id) ?? null));
    cards.sort((a, b) => {
      const aHas = a.stats != null;
      const bHas = b.stats != null;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (a.stats && b.stats) return b.stats.cagr - a.stats.cagr;
      return a.name.localeCompare(b.name);
    });

    return { success: true, data: cards.slice(0, limit) };
  } catch (error) {
    console.error("getStrategyPresetsAction error:", error);
    return { success: false, error: "Failed to load strategy presets" };
  }
}

export async function getStrategyCategoriesAction(): Promise<
  ServiceResult<StrategyCategoryInfo[]>
> {
  try {
    const categories = getStrategyCategories();
    const total = categories.reduce((sum, c) => sum + c.count, 0);
    const data: StrategyCategoryInfo[] = [
      { category: "all", count: total, label: "All" },
      ...categories,
    ];
    return { success: true, data };
  } catch (error) {
    console.error("getStrategyCategoriesAction error:", error);
    return { success: false, error: "Failed to load strategy categories" };
  }
}
