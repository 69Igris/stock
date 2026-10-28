"use server";

/**
 * Sector-aggregated heatmap per timeframe.
 *
 * Reuses getHeatmapDataAction (which already supports 1D / 1W / 1M / YTD
 * via DailyPrice cutoffs) and folds the per-stock rows into per-sector
 * aggregates: mcap-weighted change, total mcap, count, top constituents.
 *
 * The /discover/sectors page renders the heatmap full-width with the
 * sector detail loaded BELOW the heatmap (not pushing width), so a
 * single timeframe-switched fetch is enough - the page paints the same
 * grid on every change with new colours.
 */

import {
  getHeatmapDataAction,
  type HeatmapTimeframe,
  type HeatmapStock,
} from "./discover-heatmap";
import type { ServiceResult } from "@usemoney/services";
// Pure helper lives outside this file: a "use server" module may only export
// async functions, so exporting it from here fails the webpack build.
import { normalizeBucketName } from "@/lib/sectors/buckets";

export interface SectorHeatmapBucket {
  /** Canonical sector name. */
  name: string;
  /** Sum of market caps in INR. */
  mcap: number;
  /** Mcap-weighted change percent for the requested timeframe. */
  change: number;
  /** Stocks that contributed. */
  count: number;
  /** Top constituents (already capped) by mcap desc. */
  top: Array<{
    symbol: string;
    name: string;
    exchange: string;
    price: number;
    changePct: number;
  }>;
}

export interface SectorHeatmapResponse {
  timeframe: HeatmapTimeframe;
  asOf: string;
  buckets: SectorHeatmapBucket[];
  /** MONEY-1092 - forwarded from HeatmapData. This response used to be
   *  rebuilt field-by-field and silently DROPPED it, so a last-known-good
   *  serve reached the UI indistinguishable from live data. */
  stale?: boolean;
  /** Epoch ms the stale copy was computed. Only set alongside `stale`. */
  staleSince?: number;
}

function bucketize(
  stocks: HeatmapStock[],
  topN: number
): SectorHeatmapBucket[] {
  const buckets = new Map<string, HeatmapStock[]>();
  for (const s of stocks) {
    if (!s.sector) continue;
    // MONEY-1092 - "N/A" is the SECTOR_SKIPPED sentinel the enrichment
    // pipeline writes when Yahoo can't resolve a symbol (deliberately
    // non-null so dead symbols are never re-fetched). Four other surfaces
    // - lib/sectors/aggregate.ts, discover.service, discover-market.service
    // and screener.service - already display it as "Not Categorised"; the
    // heatmap was rendering the raw sentinel, so the same stocks appeared
    // under two different labels depending which page you were on.
    const key = normalizeBucketName(s.sector);
    const list = buckets.get(key);
    if (list) list.push(s);
    else buckets.set(key, [s]);
  }

  const out: SectorHeatmapBucket[] = [];
  for (const [name, group] of Array.from(buckets.entries())) {
    let mcap = 0;
    let wNum = 0;
    let wDen = 0;
    for (const s of group) {
      mcap += s.mcap;
      if (Number.isFinite(s.changePct)) {
        wNum += s.changePct * s.mcap;
        wDen += s.mcap;
      }
    }
    if (mcap === 0) continue;

    const top = [...group]
      .sort((a, b) => b.mcap - a.mcap)
      .slice(0, topN)
      .map((s) => ({
        symbol: s.symbol,
        name: s.name,
        exchange: s.exchange,
        price: s.price,
        changePct: s.changePct,
      }));

    out.push({
      name,
      mcap,
      change: wDen > 0 ? wNum / wDen : 0,
      count: group.length,
      top,
    });
  }
  out.sort((a, b) => b.mcap - a.mcap);
  return out;
}

export async function getSectorHeatmapAction(args: {
  timeframe?: HeatmapTimeframe;
  topConstituents?: number;
}): Promise<ServiceResult<SectorHeatmapResponse>> {
  const { timeframe = "1D", topConstituents = 6 } = args;
  const res = await getHeatmapDataAction({ scope: "all", timeframe });
  // MONEY-1092 - an EMPTY result is a success, not a failure. This used to
  // return `success: false, error: "No heatmap data"` for a query that ran
  // fine and simply had nothing to aggregate (pre-open, or a cold DB), which
  // made the UI render a red "something broke" box for a normal state. The
  // caller can now tell the two apart: `success: true` with zero buckets.
  if (!res.success) {
    return { success: false, error: res.error };
  }
  if (!res.data) {
    return {
      success: true,
      data: { timeframe, asOf: new Date().toISOString(), buckets: [] },
    };
  }
  return {
    success: true,
    data: {
      timeframe,
      asOf: res.data.asOf,
      buckets: bucketize(res.data.stocks, topConstituents),
      // Forward staleness. Dropping these was the bug: the primitive
      // correctly served a last-good copy and the UI had no way to know.
      ...(res.data.stale
        ? { stale: true, staleSince: res.data.staleSince }
        : {}),
    },
  };
}
