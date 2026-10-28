/**
 * Sector aggregation - pure functions for the /discover/sectors heatmap.
 *
 * Takes a flat list of DiscoverStock[] and groups by sector, computing
 * total mcap and a market-cap-weighted average change. Used by the
 * Sectors heatmap to size cells (mcap) + colour (change %).
 *
 * Multi-timeframe (1W/1M/YTD) returns are placeholders today - they
 * require historical price aggregation per instrument that isn't yet
 * wired through the discover feed. The aggregator returns nullable
 * fields for those so the UI can render "needs backend" hints when
 * absent.
 */

import type { DiscoverStock } from "@usemoney/services";

export interface SectorAggregate {
  /** Display name from DiscoverStock.sector. "Not Categorised" when null. */
  name: string;
  /** Sum of marketCap across constituents. Stocks without mcap are skipped. */
  mcap: number;
  /** Number of stocks that contributed to this sector. */
  count: number;
  /** Mcap-weighted average 1D change percent. Null when no stock has both
      mcap and changePercent. */
  change1D: number | null;
  /** Backend-pending - wire when historical-returns aggregator lands. */
  change1W: number | null;
  change1M: number | null;
  changeYTD: number | null;
  /** Top N constituents sorted by mcap desc, mapped to display tuple. */
  top: Array<{
    symbol: string;
    name: string;
    exchange: string;
    price: number;
    changePercent: number;
  }>;
}

/**
 * Group stocks by sector and compute aggregates.
 *
 * @param stocks Discover stock list (already filtered to live instruments)
 * @param topN  How many constituents to return per sector (default 5)
 * @returns Array sorted by mcap descending; sectors with zero mcap are dropped
 */
export function aggregateSectors(
  stocks: DiscoverStock[],
  topN = 5
): SectorAggregate[] {
  const buckets = new Map<string, DiscoverStock[]>();
  for (const s of stocks) {
    const key = s.sector && s.sector !== "N/A" ? s.sector : "Not Categorised";
    const list = buckets.get(key);
    if (list) {
      list.push(s);
    } else {
      buckets.set(key, [s]);
    }
  }

  const aggregates: SectorAggregate[] = [];
  const entries = Array.from(buckets.entries());
  for (const [name, group] of entries) {
    let totalMcap = 0;
    let weightedChangeNum = 0;
    let weightedChangeDenom = 0;
    for (const s of group) {
      if (typeof s.marketCap === "number" && s.marketCap > 0) {
        totalMcap += s.marketCap;
        if (
          typeof s.changePercent === "number" &&
          !Number.isNaN(s.changePercent)
        ) {
          weightedChangeNum += s.changePercent * s.marketCap;
          weightedChangeDenom += s.marketCap;
        }
      }
    }
    if (totalMcap === 0) continue;

    const top = [...group]
      .filter((s) => typeof s.marketCap === "number" && s.marketCap > 0)
      .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
      .slice(0, topN)
      .map((s) => ({
        symbol: s.symbol,
        name: s.name,
        exchange: s.exchange,
        price: s.price,
        changePercent: s.changePercent,
      }));

    aggregates.push({
      name,
      mcap: totalMcap,
      count: group.length,
      change1D:
        weightedChangeDenom > 0
          ? weightedChangeNum / weightedChangeDenom
          : null,
      // Multi-timeframe placeholders - wire when historical aggregator lands
      change1W: null,
      change1M: null,
      changeYTD: null,
      top,
    });
  }

  aggregates.sort((a, b) => b.mcap - a.mcap);
  return aggregates;
}

/**
 * Heatmap colour ramp matching design Sectors.jsx heatColor() - used by both
 * the treemap cells and the legend swatches.
 */
export function heatColor(change: number | null): {
  bg: string;
  fg: string;
} {
  if (change === null || Number.isNaN(change)) {
    return { bg: "rgba(255,255,255,.04)", fg: "var(--text-dim)" };
  }
  if (change >= 5) return { bg: "rgba(52,211,153,.45)", fg: "#fff" };
  if (change >= 2) return { bg: "rgba(52,211,153,.28)", fg: "#fff" };
  if (change >= 0.5) return { bg: "rgba(52,211,153,.16)", fg: "#a7f3d0" };
  if (change >= -0.5)
    return { bg: "rgba(255,255,255,.04)", fg: "var(--text-dim)" };
  if (change >= -2) return { bg: "rgba(248,113,113,.16)", fg: "#fecaca" };
  if (change >= -5) return { bg: "rgba(248,113,113,.32)", fg: "#fff" };
  return { bg: "rgba(248,113,113,.5)", fg: "#fff" };
}
