"use server";

/**
 * Sector Performance Server Action
 *
 * Aggregates real change% across all equity stocks grouped by sector so the
 * Markets Overview page (MONEY-195) can render the sector heatmap with
 * proportional bars. Uses existing InstrumentMapping.sector + LatestQuote.
 *
 * No fake data: sectors with zero quoted stocks are omitted. The page is
 * expected to handle an empty-sector case gracefully.
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core";
import {
  normalizeToNseSector,
  type SectorDisplayConfig,
  getSectorDisplayConfig,
} from "@usemoney/core";
import type { ServiceResult } from "@usemoney/services";
import { aggregateSectorPerformance } from "./sector-performance-logic";
import { REAL_SECTOR_WHERE } from "@usemoney/core/market-data";

export interface SectorPerformance {
  sector: string;
  /** Count of equity stocks contributing to the aggregate. */
  count: number;
  /** Simple mean of changePercent across constituents. */
  meanChangePct: number;
  /** Volume-weighted changePercent - heavier stocks matter more. */
  weightedChangePct: number;
  /** 0–100 bar width for UI, derived from |weightedChangePct| scaled to the max in the set. */
  barWidth: number;
  /** Canonical NSE sector display config (color, icon) - safe to use in UI. */
  display: SectorDisplayConfig | null;
}

// Must match discover-market.service.ts — the same namespace/scope/key is read
// by both web and the mobile /v1/discover/sectors endpoint. Bumped to -v2 for
// the Real Estate split (MONEY-1093).
const CACHE_KEY = "sector-performance-v2";

export async function getSectorPerformanceAction(): Promise<
  ServiceResult<SectorPerformance[]>
> {
  try {
    const cached = await getCached<SectorPerformance[]>(
      "discover",
      "_global",
      CACHE_KEY
    );
    if (cached) {
      return { success: true, data: cached };
    }

    // Two flat queries instead of a relation-include `findMany`. The
    // included-relation form (`latestQuote: {...}`) on Prisma's MongoDB
    // connector turns into per-row lookups on the related collection,
    // which scaled to a 10-30s SSR time on 7k instruments. Doing the
    // two scans separately and merging in JS keeps each query as a
    // single-collection index scan.
    const [instrumentsRaw, quoteRows] = await Promise.all([
      prisma.instrumentMapping.findMany({
        where: {
          isActive: true,
          instrumentType: "EQUITY",
          sector: REAL_SECTOR_WHERE,
        },
        select: { id: true, sector: true },
      }),
      prisma.latestQuote.findMany({
        where: { changePercent: { not: null } },
        select: { instrumentId: true, changePercent: true, volume: true },
      }),
    ]);
    const quoteByInst = new Map(quoteRows.map((q) => [q.instrumentId, q]));

    // Bucketing + weighting + bar-width math lives in
    // ./sector-performance-logic.ts (pure, unit-tested). normalize/display are
    // injected so that module stays free of the heavy @usemoney/core import.
    const data: SectorPerformance[] = aggregateSectorPerformance(
      instrumentsRaw,
      quoteByInst,
      (sector) => normalizeToNseSector(sector) ?? sector,
      (sector) => getSectorDisplayConfig(sector) ?? null
    );

    await setCached("discover", "_global", CACHE_KEY, data);
    return { success: true, data };
  } catch (error) {
    console.error("getSectorPerformanceAction error:", error);
    return {
      success: false,
      error: "Failed to aggregate sector performance",
    };
  }
}
