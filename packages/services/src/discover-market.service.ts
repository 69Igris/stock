/**
 * Discover Market Service (MONEY-1062 P4d — apps/api mobile parity)
 *
 * Additive discover functions extracted from apps/web server actions that were
 * Prisma-local (or only reachable through a web-local pure helper), so apps/api
 * gets byte-faithful parity WITHOUT importing next/prisma from a route handler.
 * Kept in a NEW file (not appended to the 42KB discover.service) so no existing
 * export is touched; index.ts adds one `export *` line.
 *
 * Web-action → service map:
 *   getSectorPerformance      ← apps/web/lib/actions/discover-sectors.ts:40   (getSectorPerformanceAction)
 *   getDiscoverHeatmap        ← apps/web/lib/actions/discover-heatmap.ts  (getHeatmapDataAction)
 *   getSectorDeepDive         ← was apps/web/lib/actions/sectors.ts (deleted in
 *                                 MONEY-1092 with the orphaned [sector] route;
 *                                 this port is now the only copy)
 *   getETFs                   ← apps/web/lib/actions/discover-indices.ts:142  (getETFsAction)
 *   getInstrumentsBySymbols   ← apps/web/lib/actions/discover-indices.ts:49   (getInstrumentsBySymbolsAction)
 *
 * The pure seams the web actions delegate to live web-side
 * (sector-performance-logic.ts, discover-heatmap-logic.ts, lib/sectors/aggregate.ts)
 * and can't be imported from a shared package, so they are ported VERBATIM here
 * (exported so the LIVE path + regression tests run the SAME finite-/date-guarded
 * math). All discover reads are GLOBAL market data — no userId scoping.
 */

import { prisma } from "@usemoney/database";
import {
  getCached,
  setCached,
  normalizeToNseSector,
  getSectorDisplayConfig,
  getNseMarketStatus,
  type SectorDisplayConfig,
} from "@usemoney/core";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import { getDiscoverData, type DiscoverStock } from "./discover.service";
import {
  FUND_INSTRUMENT_TYPES,
  INDIA_DISCOVER_EXCHANGES,
  REAL_SECTOR_WHERE,
  hasRealSector,
  getMfNavHistoryWithCoverage,
} from "@usemoney/core/market-data";
import {
  computeNavDerivatives,
  type NavDerivatives,
} from "./mutualfunds-logic";

// ════════════════════════════════════════════════════════════════════════════
// Ported pure helpers (exported for the service regression tests)
// ════════════════════════════════════════════════════════════════════════════

// ── Port of apps/web/lib/actions/sector-performance-logic.ts ────────────────
/** Minimal instrument row the aggregator reads. */
export interface SectorInstrument {
  id: string;
  sector: string | null;
}
/** Minimal quote row the aggregator reads. */
export interface SectorQuote {
  instrumentId: string;
  changePercent: number | null;
  volume: number | null;
}
/** One aggregated sector row, parameterised over the display-config type. */
export interface SectorPerformanceRow<TDisplay> {
  sector: string;
  count: number;
  meanChangePct: number;
  weightedChangePct: number;
  barWidth: number;
  display: TDisplay | null;
}

/**
 * Aggregate change% across equity stocks grouped by (normalized) sector:
 *   - mean = simple arithmetic mean of constituents' changePercent
 *   - weighted = volume-weighted mean (volume ≤ 0 / null → weight 1)
 *   - barWidth = |weighted| / maxAbs(weighted) × 100 (0 on an all-flat set)
 *   - sorted by weightedChangePct descending (gainers first)
 * Verbatim port of apps/web/lib/actions/sector-performance-logic.ts.
 */
export function aggregateSectorPerformance<TDisplay>(
  instruments: SectorInstrument[],
  quoteByInst: Map<string, SectorQuote>,
  normalize: (sector: string) => string,
  getDisplay: (sector: string) => TDisplay | null,
): SectorPerformanceRow<TDisplay>[] {
  const buckets = new Map<
    string,
    {
      changePcts: number[];
      weighted: Array<{ change: number; weight: number }>;
    }
  >();

  for (const inst of instruments) {
    const q = quoteByInst.get(inst.id);
    if (!q || q.changePercent == null || !inst.sector) continue;
    const canonical = normalize(inst.sector);
    if (!buckets.has(canonical)) {
      buckets.set(canonical, { changePcts: [], weighted: [] });
    }
    const bucket = buckets.get(canonical)!;
    bucket.changePcts.push(q.changePercent);
    const weight = q.volume && q.volume > 0 ? q.volume : 1;
    bucket.weighted.push({ change: q.changePercent, weight });
  }

  const rows: Array<Omit<SectorPerformanceRow<TDisplay>, "barWidth">> = [];
  for (const [sector, bucket] of Array.from(buckets.entries())) {
    if (bucket.changePcts.length === 0) continue;

    const meanChangePct =
      bucket.changePcts.reduce((s, v) => s + v, 0) / bucket.changePcts.length;
    const totalWeight = bucket.weighted.reduce((s, w) => s + w.weight, 0);
    const weightedSum = bucket.weighted.reduce(
      (s, w) => s + w.change * w.weight,
      0,
    );
    const weightedChangePct = totalWeight > 0 ? weightedSum / totalWeight : 0;

    rows.push({
      sector,
      count: bucket.changePcts.length,
      meanChangePct,
      weightedChangePct,
      display: getDisplay(sector),
    });
  }

  const maxAbs = rows.reduce(
    (m, r) => Math.max(m, Math.abs(r.weightedChangePct)),
    0,
  );
  return rows
    .map((r) => ({
      ...r,
      barWidth:
        maxAbs > 0
          ? Math.min(100, (Math.abs(r.weightedChangePct) / maxAbs) * 100)
          : 0,
    }))
    .sort((a, b) => b.weightedChangePct - a.weightedChangePct);
}

// ── Port of apps/web/lib/actions/discover-heatmap-logic.ts ──────────────────
export type HeatmapTimeframe = "1D" | "1W" | "1M" | "YTD";
/** IST is UTC+5:30. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Compute the DailyPrice cutoff instant for a heatmap timeframe. Returns null
 * for "1D" (no historical diff). Verbatim port of
 * apps/web/lib/actions/discover-heatmap-logic.ts#heatmapCutoffFor.
 */
export function heatmapCutoffFor(
  timeframe: HeatmapTimeframe,
  now: Date = new Date(),
): Date | null {
  if (timeframe === "1D") return null;

  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const c = new Date(ist);
  if (timeframe === "1W") c.setUTCDate(c.getUTCDate() - 7);
  else if (timeframe === "1M") c.setUTCMonth(c.getUTCMonth() - 1);
  else if (timeframe === "YTD") {
    c.setUTCMonth(0);
    c.setUTCDate(1);
  }

  return new Date(
    Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate()),
  );
}

// ── Port of apps/web/lib/sectors/aggregate.ts#aggregateSectors ──────────────
export interface SectorAggregate {
  name: string;
  mcap: number;
  count: number;
  change1D: number | null;
  change1W: number | null;
  change1M: number | null;
  changeYTD: number | null;
  top: Array<{
    symbol: string;
    name: string;
    exchange: string;
    price: number;
    changePercent: number;
  }>;
}

/**
 * Group DiscoverStock[] by sector → mcap + mcap-weighted 1D change + top-N.
 * Verbatim port of apps/web/lib/sectors/aggregate.ts#aggregateSectors (renamed
 * to avoid an `export *` collision-of-intent; the web `heatColor` UI helper is
 * intentionally NOT ported).
 */
export function aggregateSectorsForDeepDive(
  stocks: DiscoverStock[],
  topN = 5,
): SectorAggregate[] {
  const buckets = new Map<string, DiscoverStock[]>();
  for (const s of stocks) {
    // Deliberately INCLUDES unclassified stocks, unlike the heatmap and the
    // sector-performance list — this is a deep-dive breakdown where "what is
    // not categorised" is itself an answer. It just must not masquerade as a
    // sector, hence the explicit label. `hasRealSector` replaces the inline
    // "N/A" comparison so a rename of SECTOR_SKIPPED cannot desync it
    // (MONEY-1152).
    const key = hasRealSector(s.sector) ? s.sector : "Not Categorised";
    const list = buckets.get(key);
    if (list) list.push(s);
    else buckets.set(key, [s]);
  }

  const aggregates: SectorAggregate[] = [];
  for (const [name, group] of Array.from(buckets.entries())) {
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
      change1W: null,
      change1M: null,
      changeYTD: null,
      top,
    });
  }

  aggregates.sort((a, b) => b.mcap - a.mcap);
  return aggregates;
}

// ════════════════════════════════════════════════════════════════════════════
// Public types
// ════════════════════════════════════════════════════════════════════════════

export interface SectorPerformance {
  sector: string;
  count: number;
  meanChangePct: number;
  weightedChangePct: number;
  barWidth: number;
  display: SectorDisplayConfig | null;
}

export type HeatmapScope = "all" | "nifty50" | "nifty500";

export interface HeatmapStock {
  symbol: string;
  name: string;
  sector: string;
  price: number;
  changePct: number;
  mcap: number;
  exchange: string;
}

export interface HeatmapData {
  stocks: HeatmapStock[];
  coverage: { totalScope: number; withQuote: number; withSector: number };
  asOf: string;
}

export interface SectorDeepDiveData {
  sector: string;
  aggregate: SectorAggregate;
  constituents: Array<{
    symbol: string;
    name: string;
    exchange: string;
    price: number;
    change: number;
    changePercent: number;
    marketCap: number | null;
    volume: number | null;
  }>;
  events: Array<Record<string, unknown>>;
  news: Array<Record<string, unknown>>;
  vsBenchmarkBps: number | null;
}

export interface ETFData {
  symbol: string;
  name: string;
  exchange: string;
  yahooSymbol: string;
  /**
   * MONEY-1205 — nullable. These three used to be plain numbers because an ETF
   * with no `latest_quote` row was DROPPED from the list entirely (`.filter`
   * on the quote map), so 34 of prod's 544 fund instruments were invisible on
   * the ETF surface with no indication that anything was missing. A listed fund
   * with an unknown price is still a listed fund; a null says so, an omission
   * does not. `volume` was already nullable in this payload.
   */
  price: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  returns1Y: number | null;
  returns3Y: number | null;
  returns5Y: number | null;
  aum: number | null;
}

export interface DiscoverIndexData {
  symbol: string;
  name: string;
  exchange: string;
  yahooSymbol: string;
  price: number;
  change: number;
  changePercent: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Service functions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Sector-performance heatmap rows. Port of getSectorPerformanceAction
 * (apps/web/lib/actions/discover-sectors.ts:40). Two flat single-collection
 * scans + a JS merge (a relation-include findMany is N+1 on Prisma's Mongo
 * connector). Global.
 */
export async function getSectorPerformance(): Promise<
  ServiceResult<SectorPerformance[]>
> {
  try {
    const cached = await getCached<SectorPerformance[]>(
      "discover",
      "_global",
      // v2: bumped for the Real Estate sector split (MONEY-1093). This is the
      // key that serves the MOBILE sector list — the one carrying colour and
      // icon — and it was missed the first time: only the equity-universe key
      // was bumped. This namespace has a 24h TTL and no `deleteCached`, so
      // without the bump mobile keeps the pre-remediation buckets for a day
      // while web (60/300s) refreshes in minutes, reading as "mobile is broken".
      "sector-performance-v2",
    );
    if (cached) return { success: true, data: cached };

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

    const data: SectorPerformance[] = aggregateSectorPerformance(
      instrumentsRaw,
      quoteByInst,
      (sector) => normalizeToNseSector(sector) ?? sector,
      (sector) => getSectorDisplayConfig(sector) ?? null,
    );

    await setCached("discover", "_global", "sector-performance-v2", data);
    return { success: true, data };
  } catch (error) {
    logger.error({ error }, "getSectorPerformance service error");
    return { success: false, error: "Failed to aggregate sector performance" };
  }
}

/** Top-N marketcap thresholds for proxy index scopes (port of SCOPE_LIMITS). */
const SCOPE_LIMITS: Record<HeatmapScope, number> = {
  all: 2000,
  nifty500: 500,
  nifty50: 50,
};

/** Port of discover-heatmap.ts FETCH_TIMEOUT_MS. */
const HEATMAP_FETCH_TIMEOUT_MS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * TradingView-style treemap heatmap (flat NSE-equity list). Port of
 * getHeatmapDataAction (apps/web/lib/actions/discover-heatmap.ts) — the
 * action the /discover/markets page uses (and which the sector-heatmap wrapper
 * is derived from). Global; `scope`/`timeframe` validated + cached per key.
 */
export async function getDiscoverHeatmap(args: {
  scope: HeatmapScope;
  timeframe?: HeatmapTimeframe;
}): Promise<ServiceResult<HeatmapData>> {
  const { scope, timeframe = "1D" } = args;
  if (scope !== "all" && scope !== "nifty50" && scope !== "nifty500") {
    return { success: false, error: "Invalid scope" };
  }
  if (
    timeframe !== "1D" &&
    timeframe !== "1W" &&
    timeframe !== "1M" &&
    timeframe !== "YTD"
  ) {
    return { success: false, error: "Invalid timeframe" };
  }

  const status = getNseMarketStatus();
  const cacheKey = `heatmap:${scope}:${timeframe}`;
  const cached = await getCached<HeatmapData>("discover", "_global", cacheKey);
  if (cached) return { success: true, data: cached };

  const limit = SCOPE_LIMITS[scope];
  const fetchTake = Math.min(3000, Math.ceil(limit * 1.5));

  try {
    const cutoff: Date | null = heatmapCutoffFor(timeframe);

    const quoteRows = await withTimeout(
      prisma.latestQuote.findMany({
        where: {
          marketCap: { not: null, gt: 0 },
          changePercent: { not: null },
        },
        select: {
          instrumentId: true,
          price: true,
          changePercent: true,
          marketCap: true,
          timestamp: true,
        },
        orderBy: { marketCap: "desc" },
        take: fetchTake,
      }),
      HEATMAP_FETCH_TIMEOUT_MS,
      "heatmap fetch",
    );

    const ids = quoteRows.map((q) => q.instrumentId);
    const instruments = ids.length
      ? await withTimeout(
          prisma.instrumentMapping.findMany({
            where: {
              id: { in: ids },
              isActive: true,
              instrumentType: "EQUITY",
              exchange: "NSE",
              sector: REAL_SECTOR_WHERE,
            },
            select: {
              id: true,
              symbol: true,
              name: true,
              sector: true,
              exchange: true,
            },
          }),
          HEATMAP_FETCH_TIMEOUT_MS,
          "heatmap instruments fetch",
        )
      : [];
    const instrumentById = new Map(instruments.map((i) => [i.id, i]));

    const quotes = quoteRows
      .map((q) => {
        const inst = instrumentById.get(q.instrumentId);
        if (!inst) return null;
        return { ...q, instrument: inst };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const cutoffCloseByInstrument = new Map<string, number>();
    if (cutoff && quotes.length > 0) {
      const cutoffIds = quotes.map((q) => q.instrumentId);
      try {
        const upper = new Date(cutoff.getTime() + DAY_MS);
        const dailyRows = await withTimeout(
          prisma.dailyPrice.findMany({
            where: {
              instrumentId: { in: cutoffIds },
              date: { gte: cutoff, lt: upper },
            },
            select: { instrumentId: true, close: true },
          }),
          HEATMAP_FETCH_TIMEOUT_MS,
          "heatmap cutoff fetch",
        );
        for (const r of dailyRows) {
          if (Number.isFinite(r.close) && r.close > 0) {
            cutoffCloseByInstrument.set(r.instrumentId, r.close);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { timeframe, msg },
          "getDiscoverHeatmap cutoff lookup failed",
        );
      }
    }

    let withQuote = 0;
    let withSector = 0;
    let mostRecentQuoteAt = 0;
    const transformed: HeatmapStock[] = [];

    for (const q of quotes) {
      const inst = q.instrument;
      if (!inst || !hasRealSector(inst.sector)) continue; // MONEY-1152: `!inst.sector`
      // let the "N/A" tombstone through, and normalizeToNseSector passes it
      // straight out — so the treemap grew an "N/A" tile built from 7,822 of
      // the 10,111 NSE instruments, dwarfing every real sector.
      withSector += 1;
      if (
        !Number.isFinite(q.price) ||
        q.changePercent == null ||
        !Number.isFinite(q.changePercent) ||
        !q.marketCap ||
        !Number.isFinite(q.marketCap)
      ) {
        continue;
      }
      withQuote += 1;
      const ts = q.timestamp ? q.timestamp.getTime() : 0;
      if (ts > mostRecentQuoteAt) mostRecentQuoteAt = ts;
      const sector =
        normalizeToNseSector(inst.sector) ?? inst.sector ?? "Other";

      let changePct = q.changePercent;
      if (timeframe !== "1D") {
        const cutoffClose = cutoffCloseByInstrument.get(q.instrumentId);
        if (cutoffClose && cutoffClose > 0 && Number.isFinite(q.price)) {
          changePct = ((q.price - cutoffClose) / cutoffClose) * 100;
        }
      }

      transformed.push({
        symbol: inst.symbol,
        name: inst.name,
        sector,
        price: q.price,
        changePct,
        mcap: q.marketCap,
        exchange: inst.exchange,
      });
      if (transformed.length >= limit) break;
    }

    const data: HeatmapData = {
      stocks: transformed,
      coverage: {
        totalScope: quotes.length,
        withSector,
        withQuote,
      },
      asOf:
        mostRecentQuoteAt > 0
          ? new Date(mostRecentQuoteAt).toISOString()
          : new Date().toISOString(),
    };

    const ttlSeconds = status.isLive ? 60 : 300;
    await setCached("discover", "_global", cacheKey, data, undefined, {
      ttl: ttlSeconds,
    });

    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ scope, message }, "getDiscoverHeatmap failed");
    return { success: false, error: "Failed to load market heatmap" };
  }
}

// ── Sector-aggregated heatmap (port of apps/web/lib/actions/sector-heatmap.ts) ─

export interface SectorHeatmapBucket {
  name: string;
  mcap: number;
  change: number;
  count: number;
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
}

/** Verbatim port of sector-heatmap.ts#bucketize (exported for tests). */
export function bucketizeHeatmapSectors(
  stocks: HeatmapStock[],
  topN: number,
): SectorHeatmapBucket[] {
  const buckets = new Map<string, HeatmapStock[]>();
  for (const s of stocks) {
    if (!s.sector) continue;
    const list = buckets.get(s.sector);
    if (list) list.push(s);
    else buckets.set(s.sector, [s]);
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

/**
 * Sector-aggregated heatmap per timeframe — the /discover/sectors page's shape.
 * Port of getSectorHeatmapAction (apps/web/lib/actions/sector-heatmap.ts):
 * folds the base treemap feed (scope "all") into per-sector mcap-weighted
 * buckets with top constituents. Global.
 */
export async function getSectorHeatmap(args: {
  timeframe?: HeatmapTimeframe;
  topConstituents?: number;
}): Promise<ServiceResult<SectorHeatmapResponse>> {
  const { timeframe = "1D", topConstituents = 6 } = args;
  const res = await getDiscoverHeatmap({ scope: "all", timeframe });
  if (!res.success || !res.data) {
    return {
      success: false,
      error: res.success ? "No heatmap data" : res.error,
    };
  }
  return {
    success: true,
    data: {
      timeframe,
      asOf: res.data.asOf,
      buckets: bucketizeHeatmapSectors(res.data.stocks, topConstituents),
    },
  };
}

const NORMALIZE_SLUG = (s: string) =>
  s.trim().toLowerCase().replace(/\s+/g, "-");

/**
 * Resolve a sector slug (case-insensitive, hyphen-tolerant) → canonical display
 * name. Local port of the deleted apps/web/lib/actions/sectors.ts#resolveSector
 * (MONEY-1092; kept
 * non-exported — `resolveSector` is already exported by holdings-logic).
 */
function resolveSectorSlug(
  stocks: DiscoverStock[],
  sectorSlug: string,
): string | null {
  const slug = NORMALIZE_SLUG(sectorSlug);
  for (const s of stocks) {
    if (s.sector && NORMALIZE_SLUG(s.sector) === slug) return s.sector;
  }
  if (slug === "not-categorised") return "Not Categorised";
  return null;
}

/**
 * Sector deep-dive bundle for the /discover/sectors/:sector page. Port of
 * getSectorDeepDiveAction (the deleted apps/web/lib/actions/sectors.ts — the action the
 * [sector] ROUTE page uses). Reuses the existing getDiscoverData service, so
 * this is NOT a Prisma-direct read. A missing/empty sector returns
 * `code: "NOT_FOUND"` (additive over the web action's bare success:false) so the
 * route can 404. Global.
 */
export async function getSectorDeepDive(
  sectorSlug: string,
): Promise<ServiceResult<SectorDeepDiveData>> {
  try {
    const discover = await getDiscoverData();
    if (!discover?.success || !discover.data) {
      return { success: false, error: "Discover data unavailable" };
    }

    const all = discover.data.allStocks ?? [];
    const sectorName = resolveSectorSlug(all, sectorSlug);
    if (!sectorName) {
      return { success: false, error: "Sector not found", code: "NOT_FOUND" };
    }

    // MONEY-1092 - `exchange === "NSE"` is load-bearing, not tidiness.
    // `allStocks` spans NSE **and** BSE, and a dual-listed company has one
    // row per exchange sharing a sector. Without this filter both rows land
    // in the same bucket and the company is counted TWICE in `totalMcap` and
    // in every weighted average — measured at 278 duplicated symbols for
    // Financial Services on prod.
    //
    // The web panel (apps/web/lib/actions/sector-deep-dive.ts) was fixed
    // first; this is its mobile sibling, reached via GET /v1/discover/
    // sectors/:sector. Propagated deliberately: this repo's MONEY-1082
    // postmortem names "sibling-path completeness" as a recurring failure
    // mode — a local fix that never reached the other call sites.
    const sectorStocks = all.filter((s) => {
      if (s.exchange !== "NSE") return false;
      if (sectorName === "Not Categorised") {
        return !s.sector || s.sector === "N/A";
      }
      return s.sector === sectorName;
    });

    if (sectorStocks.length === 0) {
      return {
        success: false,
        error: "Sector has no listed constituents",
        code: "NOT_FOUND",
      };
    }

    const aggregates = aggregateSectorsForDeepDive(
      sectorStocks,
      sectorStocks.length,
    );
    const aggregate = aggregates[0];
    if (!aggregate) {
      return { success: false, error: "Sector aggregation failed" };
    }

    const constituents = sectorStocks
      .filter((s) => typeof s.marketCap === "number" && s.marketCap > 0)
      .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
      .map((s) => ({
        symbol: s.symbol,
        name: s.name,
        exchange: s.exchange,
        price: s.price,
        change: s.change,
        changePercent: s.changePercent,
        marketCap: s.marketCap ?? null,
        volume: s.volume ?? null,
      }));

    // MONEY-1092 - BOTH operands of the subtraction below must share a
    // universe. Adding the NSE filter to `sectorStocks` alone left this half
    // on the unfiltered NSE+BSE set, so `sectorChange - marketChange`
    // subtracted a dual-listing-inflated benchmark from a de-duplicated
    // sector figure — each half locally correct, the difference meaningless.
    // Half-applying a filter across a comparison is worse than not applying
    // it, because the result still looks plausible.
    const marketAgg = aggregateSectorsForDeepDive(
      all.filter((s) => s.exchange === "NSE"),
      1,
    )[0];
    const marketChange = marketAgg?.change1D ?? null;
    const sectorChange = aggregate.change1D;
    const vsBenchmarkBps =
      sectorChange !== null && marketChange !== null
        ? Math.round((sectorChange - marketChange) * 100)
        : null;

    return {
      success: true,
      data: {
        sector: sectorName,
        aggregate,
        constituents,
        events: [],
        news: [],
        vsBenchmarkBps,
      },
    };
  } catch (error) {
    logger.error({ error, sectorSlug }, "getSectorDeepDive service error");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Hard ceiling on the fund universe one call will read.
 *
 * NOT a page size — `limit` is applied after sorting, because "top 20 by
 * change" is only correct when the sort saw the whole universe. This is the
 * guard that stops a silent full-collection read if `FUND_INSTRUMENT_TYPES`
 * ever grows: prod holds 544 active ETF/REIT/INVIT rows today, so nothing is
 * truncated at this bound, and if that ever changes the sort is wrong long
 * before the bound is the reason.
 */
const FUND_UNIVERSE_CAP = 2000;

/** Minimal instrument row `getETFs` reads. */
export interface EtfInstrumentRow {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  yahooSymbol: string;
  isin: string | null;
}
/** Minimal quote row `getETFs` reads. */
export interface EtfQuoteRow {
  instrumentId: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
}
/** Minimal master row `getETFs` reads. */
export interface EtfMasterRow {
  isinGrowth: string | null;
  isinDividend: string | null;
  returns1Y: number | null;
  returns3Y: number | null;
  returns5Y: number | null;
  aum: number | null;
}

/**
 * The reads `getETFs` performs, injectable.
 *
 * Method syntax is load-bearing (bivariant checking) so the real Prisma
 * delegates satisfy these loose argument types. `@usemoney/services` runs its
 * suite as ESM with no `require.cache` module-mocking, so a port is the ONLY
 * way to assert what query this function actually issues — which is the whole
 * point of the MONEY-1205 fix here.
 */
export interface EtfListPorts {
  instrumentMapping: {
    findMany(args: Record<string, unknown>): Promise<EtfInstrumentRow[]>;
  };
  latestQuote: {
    findMany(args: Record<string, unknown>): Promise<EtfQuoteRow[]>;
  };
  mutualFundMaster: {
    findMany(args: Record<string, unknown>): Promise<EtfMasterRow[]>;
  };
}

export interface EtfListDeps {
  db?: EtfListPorts;
  getCached?: typeof getCached;
  setCached?: typeof setCached;
}

/**
 * ETFs with live prices (+ MF-master 1Y/3Y/5Y/AUM enrichment by ISIN). Port of
 * getETFsAction (apps/web/lib/actions/discover-indices.ts:142). Global.
 *
 * ## MONEY-1205 — what was wrong here
 *
 * 1. The MF-master read had **no `where` at all**: it pulled all ~14,000 scheme
 *    rows out of Mongo and then filtered them in JS against the ETF ISIN set,
 *    to keep ~307. The predicate was always expressible as a query.
 * 2. `limit` was accepted, folded into the CACHE KEY, and never applied to
 *    anything — so `getETFs({ limit: 20 })` returned every ETF that had a
 *    quote (510 in prod) under a cache entry that claims to hold 20.
 * 3. An ETF with no `latest_quote` row was silently dropped (see `ETFData`).
 */
export async function getETFs(
  options?: {
    limit?: number;
    sortBy?: "symbol" | "changePercent" | "volume";
  },
  deps: EtfListDeps = {},
): Promise<ServiceResult<ETFData[]>> {
  const { limit = 30, sortBy = "symbol" } = options ?? {};
  const db = deps.db ?? (prisma as unknown as EtfListPorts);
  const readCache = deps.getCached ?? getCached;
  const writeCache = deps.setCached ?? setCached;

  try {
    const filters = { limit, sortBy };
    const cached = await readCache<ETFData[]>(
      "discover",
      "_global",
      "etfs",
      filters,
    );
    if (cached) return { success: true, data: cached };

    const instruments = await db.instrumentMapping.findMany({
      // MONEY-1085 follow-up: include REIT/INVIT — exchange-traded trusts
      // belong on the funds surface alongside ETFs.
      where: {
        isActive: true,
        // MONEY-1263 — scope to Indian venues. `instrument_mappings` is now
        // SHARED with the US master (~7,600 active US ETFs against India's
        // ~541), and without a venue clause this surface fills with US names.
        // Scoped by EXCHANGE, not `market`: that attribute is ABSENT on every
        // pre-existing India row, so `{market: "IN"}` matches ZERO.
        exchange: { in: [...INDIA_DISCOVER_EXCHANGES] },
        instrumentType: { in: [...FUND_INSTRUMENT_TYPES] },
      },
      select: {
        id: true,
        symbol: true,
        name: true,
        exchange: true,
        yahooSymbol: true,
        isin: true,
      },
      orderBy: sortBy === "symbol" ? { symbol: "asc" } : undefined,
      take: FUND_UNIVERSE_CAP,
    });

    const etfIds = instruments.map((i) => i.id);
    const quotes = await db.latestQuote.findMany({
      where: { instrumentId: { in: etfIds }, previousClose: { gt: 0 } },
    });
    const quoteMap = new Map(quotes.map((q) => [q.instrumentId, q]));

    const isins = instruments.map((i) => i.isin).filter(Boolean) as string[];
    // Bounded by the ISIN set we are actually enriching. The `select` already
    // narrowed the COLUMNS; only the `where` narrows the ROWS, and without it
    // this read was the whole `mutual_fund_masters` collection on every ETF
    // list view that missed the cache.
    const mfData =
      isins.length > 0
        ? await db.mutualFundMaster.findMany({
            where: {
              OR: [
                { isinGrowth: { in: isins } },
                { isinDividend: { in: isins } },
              ],
            },
            select: {
              isinGrowth: true,
              isinDividend: true,
              returns1Y: true,
              returns3Y: true,
              returns5Y: true,
              aum: true,
            },
          })
        : [];
    const returnsMap = new Map<
      string,
      {
        returns1Y: number | null;
        returns3Y: number | null;
        returns5Y: number | null;
        aum: number | null;
      }
    >();
    for (const mf of mfData) {
      const data = {
        returns1Y: mf.returns1Y,
        returns3Y: mf.returns3Y,
        returns5Y: mf.returns5Y,
        aum: mf.aum,
      };
      if (mf.isinGrowth) returnsMap.set(mf.isinGrowth, data);
      if (mf.isinDividend) returnsMap.set(mf.isinDividend, data);
    }

    // No `.filter(quoteMap.has)`: a quote-less fund keeps its row and reports a
    // null price. See the `ETFData` note.
    const etfs: ETFData[] = instruments.map((inst) => {
      const q = quoteMap.get(inst.id);
      const returns = inst.isin ? returnsMap.get(inst.isin) : undefined;
      return {
        symbol: inst.symbol,
        name: inst.name,
        exchange: inst.exchange,
        yahooSymbol: inst.yahooSymbol,
        price: q?.price ?? null,
        change: q?.change ?? null,
        changePercent: q?.changePercent ?? null,
        volume: q?.volume ?? null,
        returns1Y: returns?.returns1Y ?? null,
        returns3Y: returns?.returns3Y ?? null,
        returns5Y: returns?.returns5Y ?? null,
        aum: returns?.aum ?? null,
      };
    });

    // An unknown value sorts LAST in every mode rather than as a zero, which
    // would park quote-less funds in the middle of a change-sorted list.
    //
    // The sentinel is -1, NOT -Infinity: this ranks by |change|, and
    // `Math.abs(-Infinity)` is `+Infinity`, which would sort every quote-less
    // fund to the TOP of "biggest movers". Since `Math.abs` is never negative,
    // -1 is unreachable by a real reading.
    if (sortBy === "changePercent") {
      const rank = (v: number | null) => (v == null ? -1 : Math.abs(v));
      etfs.sort((a, b) => rank(b.changePercent) - rank(a.changePercent));
    } else if (sortBy === "volume") {
      etfs.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));
    }

    // `limit` finally means something. Applied AFTER the sort so "top N by
    // change" is the top of the universe, not the top of an arbitrary prefix.
    const page = etfs.slice(0, limit);
    await writeCache("discover", "_global", "etfs", page, filters);
    return { success: true, data: page };
  } catch (error) {
    logger.error({ error }, "getETFs service error");
    return { success: false, error: "Failed to load ETFs" };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Fund NAV derivatives — MONEY-1205
// ════════════════════════════════════════════════════════════════════════════

/** Returns + 52-week NAV range for one AMFI scheme, plus WHY a field is null. */
export interface FundNavDerivativesData {
  derivatives: NavDerivatives;
  /** ISO date of the first stored observation — the "since" in "since inception". */
  firstNavDate: string | null;
  /** ISO date of the latest stored observation. */
  lastNavDate: string | null;
  /** Rows stored for this scheme across ALL time. */
  storedRows: number;
  /** True when there is too little history to derive from; a backfill was queued. */
  cold: boolean;
}

export interface FundNavDerivativesDeps {
  readNavHistory?: typeof getMfNavHistoryWithCoverage;
  getCached?: typeof getCached;
  setCached?: typeof setCached;
}

/**
 * The server-side NAV derivation both fund pages consume.
 *
 * ## Why it is a service and not a `useMemo`
 *
 * This math lived in a React `useMemo` in `app/mf/[schemeCode]/client.tsx`, so
 * `/etf/[symbol]` — which renders the same fund — could not reach it and
 * hard-passed `navHigh={null} navLow={null} returnsInception={null}` instead.
 * The client copy also had no minimum-points floor, meaning two stray
 * observations could print a confident-looking 5-year CAGR, and no way to tell
 * "no history stored yet" apart from "not old enough", so both rendered a bare
 * "-". `computeNavDerivatives` answers all three and reports `dataPoints` /
 * `coverageYears` so the caller can say WHICH null it is looking at.
 *
 * The read is cold-safe by construction: `getMfNavHistoryWithCoverage` returns
 * whatever is stored and PUBLISHES a backfill job, never blocking a render on a
 * network fetch.
 */
export async function getFundNavDerivatives(
  args: { schemeCode: string },
  deps: FundNavDerivativesDeps = {},
): Promise<ServiceResult<FundNavDerivativesData>> {
  const schemeCode = String(args.schemeCode ?? "").trim();
  if (!schemeCode || schemeCode.length > 24) {
    return { success: false, error: "Invalid scheme code" };
  }

  const read = deps.readNavHistory ?? getMfNavHistoryWithCoverage;
  const readCache = deps.getCached ?? getCached;
  const writeCache = deps.setCached ?? setCached;
  const cacheKey = `fund-nav-derivatives:${schemeCode}`;

  try {
    const cached = await readCache<FundNavDerivativesData>(
      "discover",
      "_global",
      cacheKey,
    );
    if (cached) return { success: true, data: cached };

    const { points, coverage } = await read(schemeCode);
    const derivatives = computeNavDerivatives(points);
    const data: FundNavDerivativesData = {
      derivatives,
      firstNavDate: points.length > 0 ? points[0]!.date : null,
      lastNavDate: points.length > 0 ? points[points.length - 1]!.date : null,
      storedRows: coverage.storedRows,
      cold: coverage.cold,
    };

    // Never cache "we have nothing". A cold read has just QUEUED the backfill
    // that fixes it, and a 6-hour entry would hide the result of that job for
    // 6 hours — turning a transient gap into a shift-long one.
    if (derivatives.dataPoints > 0) {
      await writeCache("discover", "_global", cacheKey, data, undefined, {
        ttl: 6 * 60 * 60,
      });
    }
    return { success: true, data };
  } catch (error) {
    logger.error({ error, schemeCode }, "getFundNavDerivatives service error");
    return { success: false, error: "Failed to load NAV history" };
  }
}

/**
 * ETF / INDEX instruments by symbol (or yahooSymbol) with live prices. Port of
 * getInstrumentsBySymbolsAction (apps/web/lib/actions/discover-indices.ts:49).
 * Empty input or >50 symbols → empty list (the web action's own bound). Global.
 */
export async function getInstrumentsBySymbols(
  symbols: string[],
  instrumentType: "ETF" | "INDEX",
  yahooSymbols?: string[],
): Promise<ServiceResult<Array<ETFData | DiscoverIndexData>>> {
  if ((!symbols.length && !yahooSymbols?.length) || symbols.length > 50) {
    return { success: true, data: [] };
  }

  try {
    const orConditions: Record<string, unknown>[] = [];
    if (symbols.length > 0) orConditions.push({ symbol: { in: symbols } });
    if (yahooSymbols && yahooSymbols.length > 0) {
      orConditions.push({ yahooSymbol: { in: yahooSymbols } });
    }

    const instruments = await prisma.instrumentMapping.findMany({
      where: { OR: orConditions, isActive: true, instrumentType },
      select: {
        id: true,
        symbol: true,
        name: true,
        exchange: true,
        yahooSymbol: true,
      },
    });

    const instIds = instruments.map((i) => i.id);
    const quotes = await prisma.latestQuote.findMany({
      where: { instrumentId: { in: instIds }, previousClose: { gt: 0 } },
    });
    const quoteMap = new Map(quotes.map((q) => [q.instrumentId, q]));

    const results = instruments
      .filter((inst) => quoteMap.has(inst.id))
      .map((inst) => {
        const q = quoteMap.get(inst.id)!;
        return {
          symbol: inst.symbol,
          name: inst.name,
          exchange: inst.exchange,
          yahooSymbol: inst.yahooSymbol,
          price: q.price,
          change: q.change ?? 0,
          changePercent: q.changePercent ?? 0,
          ...(instrumentType === "ETF"
            ? {
                volume: q.volume ?? null,
                returns1Y: null,
                returns3Y: null,
                returns5Y: null,
                aum: null,
              }
            : {}),
        };
      });

    return { success: true, data: results };
  } catch (error) {
    logger.error(
      { error, instrumentType },
      "getInstrumentsBySymbols service error",
    );
    return { success: false, error: `Failed to load ${instrumentType} data` };
  }
}
