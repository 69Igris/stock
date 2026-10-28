/**
 * Discover Service
 *
 * Stock/MF/Index discovery with live market data.
 * Source: apps/web/lib/actions/discover.ts, discover-mf.ts, discover-indices.ts
 */

import { prisma, Prisma } from "@usemoney/database";
import { getAllSectorNames, getCached, setCached } from "@usemoney/core";
import { singleFlight } from "@usemoney/core/cache/stale-while-error";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import {
  buildSectorFacets,
  dedupeDualListings,
  finite,
  istDayKey,
  decideMoversSource,
  MAX_ABS_CHANGE_PERCENT,
  rankGainers,
  rankLosers,
  sortStocksBySector,
} from "./discover-logic";
import {
  FUND_INSTRUMENT_TYPES,
  INDIA_DISCOVER_EXCHANGES,
  getNseMarketStatus,
  REAL_SECTOR_WHERE,
} from "@usemoney/core/market-data";
import {
  SEARCH_INDEX,
  isAtlasSearchEnabled,
  reportSearchFailure,
} from "@usemoney/core/search/atlas-gate";

/**
 * Map a nullable-numeric quote field to `number | null`, neutralising a stored
 * `NaN`/`±Infinity` (a corrupt sync row) to `null` while preserving a real
 * `null`. Used for `volume`/`marketCap` so a non-finite value never reaches a
 * `.toLocaleString()` in the UI nor flips a sort. (`finite()` would force these
 * to `0`, which would mis-read as "0 volume"; `null` reads honestly as "—".)
 */
function nullableFinite(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

// ── Shared quote/instrument shaping (MONEY-1092) ───────────────────────
//
// The universe path and the movers path MUST apply the same filter chain and
// the same finite-guards, otherwise the movers list would silently admit rows
// (mutual-fund-shaped names, quote-less/liquidity-less scrips) that the
// Discover grid rejects. Both were inline in `getAllStocksData` before the
// movers query was split out; they live here now so they cannot drift.

/** The `InstrumentMapping` columns a `DiscoverStock` is built from. */
interface DiscoverInstrumentFields {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  instrumentType: string;
  yahooSymbol: string;
  /** MONEY-1198 — durable identity for collapsing NSE/BSE dual listings. */
  isin: string | null;
}

/** The `LatestQuote` columns a `DiscoverStock` is built from. */
interface DiscoverQuoteFields {
  price: number;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  marketCap: number | null;
}

/** Projection for every `LatestQuote` read that produces a `DiscoverStock`. */
const DISCOVER_QUOTE_SELECT = {
  instrumentId: true,
  price: true,
  change: true,
  changePercent: true,
  volume: true,
  marketCap: true,
  // MONEY-1198 — WHICH SESSION this quote belongs to. Without it the movers
  // ranking cannot tell today's move from yesterday's, and ranked them together.
  timestamp: true,
} as const;

/** Projection for every `InstrumentMapping` read that produces a `DiscoverStock`. */
const DISCOVER_INSTRUMENT_SELECT = {
  id: true,
  symbol: true,
  name: true,
  exchange: true,
  sector: true,
  instrumentType: true,
  yahooSymbol: true,
  // MONEY-1198 — the durable identity, needed to collapse a company's NSE and
  // BSE listings into one mover. Symbol alone is the fallback, not the key.
  isin: true,
} as const;

/**
 * `InstrumentMapping` carries mutual-fund rows tagged as EQUITY; they are
 * identified by name because nothing else distinguishes them. Kept verbatim
 * from the original inline filter.
 */
function isDiscoverableEquityName(name: string): boolean {
  const n = name.toUpperCase();
  return !(
    n.includes("MUTUAL FUND") ||
    n.includes("MF -") ||
    n.includes("MUTUAL FD")
  );
}

/**
 * A row is only discoverable if it has SOME market footprint - volume or a
 * market cap. Drops the long tail of never-traded / non-tradable listings.
 * (`nullableFinite` has already neutralised NaN/Infinity to `null`, so a
 * plain truthiness test is the honest one - a real 0 is also "no footprint".)
 */
function hasMarketFootprint(stock: DiscoverStock): boolean {
  return Boolean(stock.volume) || Boolean(stock.marketCap);
}

/**
 * finite()-guard the display numbers: `?? 0` only caught null, so a stored
 * NaN/Infinity changePercent (÷0 on a 0 previousClose upstream) leaked
 * straight into the ranked list and the rendered chip ("NaN%").
 */
function toDiscoverStock(
  inst: DiscoverInstrumentFields,
  q: DiscoverQuoteFields,
): DiscoverStock {
  return {
    symbol: inst.symbol,
    name: inst.name,
    exchange: inst.exchange,
    sector: inst.sector,
    instrumentType: inst.instrumentType,
    instrumentId: inst.id,
    yahooSymbol: inst.yahooSymbol,
    // MONEY-1198 — durable identity, used to collapse dual listings.
    isin: inst.isin ?? null,
    price: finite(q.price),
    change: finite(q.change),
    changePercent: finite(q.changePercent),
    volume: nullableFinite(q.volume),
    marketCap: nullableFinite(q.marketCap),
  };
}

// ── Atlas Search helpers (only fires on Atlas; falls back to Prisma) ───
//
// MongoDB Atlas Search indexes used:
//   - "instrument_search" on instrument_mappings  (stocks + ETFs)
//   - "mf_search"          on mutual_fund_masters (MFs)
// Index definitions live in /docs/atlas-search-setup.md.
//
// The wider app already wires these through apps/web/lib/market/atlas-search.ts
// for autocomplete + search endpoints. The popover's rich-search service was
// bypassing them - this brings parity so the picker uses fuzzy match,
// prefix match, and Atlas relevance scoring instead of `contains`.
//
// MONEY-1128 - this file used to keep its OWN `isAtlasEnvironment` sniff, its
// OWN 5-minute `atlasUnavailableUntil` latch and its OWN error classifier, so
// apps/web falling back on `instrument_search` left THIS service still hammering
// the same failing index (and vice versa). Both now route through the single
// gate in `@usemoney/core/search/atlas-gate`, which also stops a timeout from
// latching and reports every transition.

const SUBSYSTEM = {
  INSTRUMENTS: "services.discover.instruments",
  MUTUAL_FUNDS: "services.discover.mutual-funds",
} as const;

interface AtlasInstHit {
  symbol: string;
  name: string;
  exchange: string;
  yahooSymbol: string;
  instrumentType: string;
  sector?: string | null;
  industry?: string | null;
  analysisCount?: number;
  score: number;
}
interface AtlasMfHit {
  schemeCode: string;
  schemeName: string;
  amcName: string;
  category: string;
  nav: number;
  aum?: number;
  riskLevel?: string;
  returns1Y?: number;
  returns3Y?: number;
  returns5Y?: number;
  score: number;
}
interface RawAggregateResult {
  cursor?: { firstBatch?: Record<string, unknown>[] };
}

async function atlasSearchInstruments(
  query: string,
  types: string[],
  limit: number,
): Promise<AtlasInstHit[] | null> {
  if (!isAtlasSearchEnabled(SEARCH_INDEX.INSTRUMENTS, SUBSYSTEM.INSTRUMENTS)) {
    return null;
  }
  const pipeline = [
    {
      $search: {
        index: SEARCH_INDEX.INSTRUMENTS,
        compound: {
          must: [
            {
              compound: {
                should: [
                  {
                    autocomplete: {
                      query,
                      path: "symbol",
                      fuzzy: { maxEdits: 1, prefixLength: 1 },
                    },
                  },
                  {
                    autocomplete: {
                      query,
                      path: "name",
                      fuzzy: { maxEdits: 1, prefixLength: 2 },
                    },
                  },
                  {
                    text: {
                      query,
                      path: ["symbol", "name"],
                      fuzzy: { maxEdits: 1, prefixLength: 2 },
                    },
                  },
                ],
                minimumShouldMatch: 1,
              },
            },
          ],
          filter: [
            { equals: { path: "isActive", value: true } },
            { in: { path: "instrumentType", value: types } },
          ],
        },
      },
    },
    { $limit: limit },
    {
      $project: {
        symbol: 1,
        name: 1,
        exchange: 1,
        yahooSymbol: 1,
        instrumentType: 1,
        sector: 1,
        industry: 1,
        analysisCount: 1,
        score: { $meta: "searchScore" },
      },
    },
  ];

  try {
    const res = (await prisma.$runCommandRaw({
      aggregate: "instrument_mappings",
      pipeline: pipeline as unknown as Prisma.InputJsonValue,
      cursor: {},
    })) as RawAggregateResult;
    return (res?.cursor?.firstBatch ?? []) as unknown as AtlasInstHit[];
  } catch (e) {
    const action = reportSearchFailure({
      index: SEARCH_INDEX.INSTRUMENTS,
      subsystem: SUBSYSTEM.INSTRUMENTS,
      error: e,
    });
    if (action === "fallback") return null;
    throw e;
  }
}

async function atlasSearchMfs(
  query: string,
  limit: number,
): Promise<AtlasMfHit[] | null> {
  if (
    !isAtlasSearchEnabled(SEARCH_INDEX.MUTUAL_FUNDS, SUBSYSTEM.MUTUAL_FUNDS)
  ) {
    return null;
  }
  const pipeline = [
    {
      $search: {
        index: SEARCH_INDEX.MUTUAL_FUNDS,
        compound: {
          must: [
            {
              compound: {
                should: [
                  {
                    autocomplete: {
                      query,
                      path: "schemeName",
                      fuzzy: { maxEdits: 1, prefixLength: 2 },
                    },
                  },
                  {
                    autocomplete: {
                      query,
                      path: "amcName",
                      fuzzy: { maxEdits: 1, prefixLength: 2 },
                    },
                  },
                  {
                    text: {
                      query,
                      path: ["schemeName", "amcName", "schemeCode", "category"],
                      fuzzy: { maxEdits: 1, prefixLength: 2 },
                    },
                  },
                ],
                minimumShouldMatch: 1,
              },
            },
          ],
          filter: [{ equals: { path: "isActive", value: true } }],
        },
      },
    },
    { $limit: limit },
    {
      $project: {
        schemeCode: 1,
        schemeName: 1,
        amcName: 1,
        category: 1,
        nav: 1,
        aum: 1,
        riskLevel: 1,
        returns1Y: 1,
        returns3Y: 1,
        returns5Y: 1,
        score: { $meta: "searchScore" },
      },
    },
  ];

  try {
    const res = (await prisma.$runCommandRaw({
      aggregate: "mutual_fund_masters",
      pipeline: pipeline as unknown as Prisma.InputJsonValue,
      cursor: {},
    })) as RawAggregateResult;
    return (res?.cursor?.firstBatch ?? []) as unknown as AtlasMfHit[];
  } catch (e) {
    const action = reportSearchFailure({
      index: SEARCH_INDEX.MUTUAL_FUNDS,
      subsystem: SUBSYSTEM.MUTUAL_FUNDS,
      error: e,
    });
    if (action === "fallback") return null;
    throw e;
  }
}

// ── Types ──────────────────────────────────────────────────────────

export interface DiscoverStock {
  symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  instrumentType: string;
  instrumentId: string;
  yahooSymbol: string;
  /**
   * MONEY-1198 — the durable identity, used to collapse a company's NSE and BSE
   * listings into one mover. Nullable because not every instrument carries one,
   * and a missing ISIN must fall back to symbol rather than group every
   * ISIN-less row together.
   */
  isin: string | null;
  price: number;
  change: number;
  changePercent: number;
  volume: number | null;
  marketCap: number | null;
}

export interface DiscoverData {
  topGainers: DiscoverStock[];
  topLosers: DiscoverStock[];
  allStocks: DiscoverStock[];
  sectors: Array<{ name: string; count: number }>;
}

/**
 * The headline half of `DiscoverData` — everything EXCEPT `allStocks`.
 *
 * MONEY-1131 — `/discover/markets` reads only `topGainers`/`topLosers` and
 * `/discover/screener` reads only `sectors` + the universe SIZE, yet both were
 * calling `getDiscoverData()`, whose universe entry is a ~7,400-row blob. On a
 * cold lambda that is a multi-MB Redis GET plus a multi-MB `JSON.parse` to read
 * two fields. This shape is what those two callers actually need; the full
 * universe stays available (unchanged) via `getDiscoverData` for the surfaces
 * that genuinely enumerate it — `/discover`, paper-trading's picker, the sector
 * deep-dive and the screener's `instrumentsFirstPath`.
 */
export interface DiscoverSummary {
  topGainers: DiscoverStock[];
  topLosers: DiscoverStock[];
  sectors: Array<{ name: string; count: number }>;
  /** `allStocks.length` — the displayable universe size, NOT a row payload. */
  stockCount: number;
  /**
   * MONEY-1157 — `true` when the universe scan FAILED and `sectors` /
   * `stockCount` are the empty fallback rather than a measurement.
   *
   * `success: true` with all-zero counts is otherwise byte-identical to a
   * genuinely thin environment, which is how a caught DB error reached
   * `/discover/screener` as "every sector has 0 stocks" — a length-14,
   * all-zero array that passed the page's `length > 0` guard and then had all
   * 14 chips filtered away by `count > 0`. Absent/false means the numbers were
   * actually measured. Callers must not infer this from the counts.
   */
  degraded?: true;
}

export interface DiscoverMutualFund {
  schemeCode: string;
  schemeName: string;
  amcName: string | null;
  category: string | null;
  plan: string | null;
  nav: number;
  returns1Y: number | null;
  returns3Y: number | null;
  returns5Y: number | null;
  riskLevel: string | null;
  aum: number | null;
}

export interface MfDiscoverData {
  allFunds: DiscoverMutualFund[];
  categories: Array<{ name: string; count: number }>;
  amcList: string[];
}

// ── Service Functions ──────────────────────────────────────────────

/**
 * The Discover dataset: the (slow-moving) equity universe plus the
 * (fast-moving) top gainers / losers.
 *
 * MONEY-1092 - these used to be ONE cache entry written on the `discover`
 * namespace's DEFAULT TTL of **24 hours**, so `/discover/markets` could render
 * a full day-old Top Movers table right next to a heatmap that refreshes every
 * 60s. Nothing shortens that: a repo-wide grep finds no `deleteCached`/
 * invalidation for the `discover` namespace anywhere in `workers/src` (the
 * worker invalidations are all user-scoped: sync, import, pairing), so the 24h
 * TTL was the ONLY thing that ever refreshed movers.
 *
 * They are now two entries with two lifetimes:
 *
 *   - **universe** (`main-v3`, still 24h). `allStocks` is the WHOLE tradable
 *     universe - the screener (`screener.service#instrumentsFirstPath`), the
 *     sector deep-dive (`sectors.ts#getSectorDeepDiveAction`,
 *     `discover-market.service#getSectorDeepDive`) and the paper-trading
 *     picker all read it - so it cannot be capped, which means it stays a
 *     full-collection read and therefore must stay on a long TTL.
 *
 *   - **movers** (`movers-v1`, 60s live / 300s closed, matching
 *     `discover-heatmap.ts`). Safe at that rate ONLY because it is an ordered
 *     top-N served by `@@index([changePercent])`, NOT the universe scan. This
 *     ordering is load-bearing: putting the old scan on a 60s TTL would have
 *     multiplied it ~1400x/day and recreated the very outage this ticket
 *     exists to fix.
 *
 * The key is bumped on any shape or content change so stale entries are
 * bypassed on deploy instead of lingering for 24h — v2 when the movers split
 * out of this payload, v3 for the Real Estate sector split (MONEY-1093). Same
 * trick as `getMfDiscoverData`, which carries its OWN `main-v2` in the separate
 * `discover-mf` namespace — that one is unrelated and deliberately untouched.
 */
export async function getDiscoverData(): Promise<ServiceResult<DiscoverData>> {
  try {
    // Sequential, NOT Promise.all: the movers fallback below needs the
    // universe in hand, and in the steady state both steps are a cache read.
    const universe = await getCachedUniverse();
    const movers = await getCachedMovers();

    if (
      movers &&
      (movers.topGainers.length > 0 || movers.topLosers.length > 0)
    ) {
      return { success: true, data: { ...universe, ...movers } };
    }

    // Degrade, never dead-end. If the bounded movers query threw or produced
    // nothing at all on BOTH sides (empty quote table / DB blip), rank from
    // the universe we already hold - exactly the pre-MONEY-1092 behaviour.
    // Whole-result, not per-side: a legitimately empty losers list on a strong
    // up day must NOT be back-filled from a 24h-old snapshot.
    return {
      success: true,
      data: {
        ...universe,
        topGainers: rankGainers(universe.allStocks, MOVERS_LIMIT),
        topLosers: rankLosers(universe.allStocks, MOVERS_LIMIT),
      },
    };
  } catch (error) {
    logger.error({ error }, "Discover data service error");
    return { success: false, error: "Failed to load discover data" };
  }
}

/**
 * `getDiscoverData` minus the universe payload (MONEY-1131).
 *
 * Same numbers, a fraction of the bytes: `sectors` + `stockCount` come from a
 * SMALL companion cache entry (`summary-v1`) written next to the universe, and
 * the movers come from the same short-TTL `movers-v1` entry `getDiscoverData`
 * uses — so a caller that never renders a stock row never touches the ~7,400-row
 * blob.
 *
 * The degraded path is deliberately identical to `getDiscoverData`'s: if the
 * bounded movers query produced nothing at all, rank from the universe. That
 * DOES pay the big read — but only in the same outage window where
 * `getDiscoverData` would have, and it keeps Top Movers alive rather than
 * dead-ending.
 */
export async function getDiscoverSummary(
  deps: DiscoverSummaryPorts = {},
): Promise<ServiceResult<DiscoverSummary>> {
  const ports = withSummaryDefaults(deps);
  try {
    const summary = await getCachedUniverseSummary(ports);
    const movers = await ports.getMovers();

    if (
      movers &&
      (movers.topGainers.length > 0 || movers.topLosers.length > 0)
    ) {
      return { success: true, data: { ...summary, ...movers } };
    }

    const universe = await ports.getUniverse();
    return {
      success: true,
      data: {
        sectors: universe.sectors,
        stockCount: universe.allStocks.length,
        topGainers: rankGainers(universe.allStocks, MOVERS_LIMIT),
        topLosers: rankLosers(universe.allStocks, MOVERS_LIMIT),
        // This branch builds a fresh literal rather than spreading `summary`,
        // so the sentinel has to be carried explicitly — omitting it here is
        // exactly how a flag added to one path silently skips another.
        ...(universe.degraded ? { degraded: true as const } : {}),
      },
    };
  } catch (error) {
    logger.error({ error }, "Discover summary service error");
    return { success: false, error: "Failed to load discover summary" };
  }
}

export async function getStocksBySector(
  sector: string,
  options: {
    limit?: number;
    sortBy?: "name" | "changePercent" | "marketCap";
  } = {},
): Promise<ServiceResult<DiscoverStock[]>> {
  const { limit = 20, sortBy = "name" } = options;

  try {
    const filters = { sector, limit, sortBy };
    const cached = await getCached<DiscoverStock[]>(
      "discover",
      "_global",
      "sector-v2",
      filters,
    );
    if (cached) return { success: true, data: cached };

    const stocks = await fetchStocksBySector(sector, limit, sortBy);
    await setCached("discover", "_global", "sector-v2", stocks, filters);
    return { success: true, data: stocks };
  } catch (error) {
    logger.error({ error, sector }, "Stocks by sector service error");
    return { success: false, error: "Failed to load sector stocks" };
  }
}

export async function getMfDiscoverData(): Promise<
  ServiceResult<MfDiscoverData>
> {
  try {
    // `main-v2` bumps the cache key so stale entries from the previous
    // shape (every category hardcoded to count 50 — the old
    // PER_CATEGORY_LIMIT sample cap) are bypassed immediately on deploy
    // instead of lingering until the Redis TTL expires.
    const cached = await getCached<MfDiscoverData>(
      "discover-mf",
      "_global",
      "main-v2",
    );
    if (cached) return { success: true, data: cached };

    const data = await getAllDirectFundsData();
    await setCached("discover-mf", "_global", "main-v2", data);
    return { success: true, data };
  } catch (error) {
    logger.error({ error }, "MF discover data service error");
    return { success: false, error: "Failed to load mutual fund data" };
  }
}

export async function getMfsByCategory(
  category: string,
  options: {
    plan?: string;
    amcName?: string;
    search?: string;
    sortBy?: string;
    limit?: number;
  } = {},
): Promise<ServiceResult<DiscoverMutualFund[]>> {
  const { limit = 50, sortBy = "nav", plan, amcName, search } = options;

  try {
    const filters = { category, plan, amcName, search, sortBy, limit };
    const cached = await getCached<DiscoverMutualFund[]>(
      "discover-mf",
      "_global",
      "category",
      filters,
    );
    if (cached) return { success: true, data: cached };

    const where: Record<string, unknown> = {
      isActive: true,
      category: category === "all" ? undefined : category,
    };
    if (plan) where.plan = plan;
    if (amcName) where.amcName = amcName;
    if (search) where.schemeName = { contains: search, mode: "insensitive" };
    // Remove undefined keys
    Object.keys(where).forEach(
      (k) => where[k] === undefined && delete where[k],
    );

    const funds = await prisma.mutualFundMaster.findMany({
      where,
      take: limit,
      select: {
        schemeCode: true,
        schemeName: true,
        amcName: true,
        category: true,
        plan: true,
        nav: true,
        returns1Y: true,
        returns3Y: true,
        returns5Y: true,
        riskLevel: true,
        aum: true,
      },
    });

    const mapped = funds.map(mapFund);
    await setCached("discover-mf", "_global", "category", mapped, filters);
    return { success: true, data: mapped };
  } catch (error) {
    logger.error({ error, category }, "MF by category service error");
    return { success: false, error: "Failed to load category funds" };
  }
}

export async function getMfsBySchemeCodes(
  schemeCodes: string[],
): Promise<ServiceResult<DiscoverMutualFund[]>> {
  try {
    if (schemeCodes.length === 0) return { success: true, data: [] };
    const codes = schemeCodes.slice(0, 50);

    const query = prisma.mutualFundMaster.findMany({
      where: { schemeCode: { in: codes } },
      select: {
        schemeCode: true,
        schemeName: true,
        amcName: true,
        category: true,
        plan: true,
        nav: true,
        returns1Y: true,
        returns3Y: true,
        returns5Y: true,
        riskLevel: true,
        aum: true,
      },
    });

    // Protect against hung MongoDB connections (Atlas cold starts)
    const funds = await Promise.race([
      query,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("MongoDB query timed out after 8s")),
          8_000,
        ),
      ),
    ]);

    return { success: true, data: funds.map(mapFund) };
  } catch (error) {
    logger.error({ error }, "MFs by scheme codes service error");
    return { success: false, error: "Failed to fetch mutual funds" };
  }
}

export async function getIndices(): Promise<
  ServiceResult<
    Array<{
      symbol: string;
      name: string;
      exchange: string;
      yahooSymbol: string;
      price: number;
      change: number;
      changePercent: number;
    }>
  >
> {
  try {
    const cached = await getCached("discover", "_global", "indices");
    if (cached)
      return {
        success: true,
        data: cached as Array<{
          symbol: string;
          name: string;
          exchange: string;
          yahooSymbol: string;
          price: number;
          change: number;
          changePercent: number;
        }>,
      };

    const instruments = await prisma.instrumentMapping.findMany({
      where: { isActive: true, instrumentType: "INDEX" },
      select: {
        id: true,
        symbol: true,
        name: true,
        exchange: true,
        yahooSymbol: true,
      },
    });

    // MONEY-1092 - this was a bare `findMany({})`: it pulled EVERY latest
    // quote in the collection (equities, ETFs, the lot) only to keep the few
    // dozen index rows. Filter in the DB instead - `instrumentId` is
    // `@unique` on LatestQuote, so the `$in` is an index lookup over a tiny
    // id list, and the projection stops us shipping columns we never read.
    const instIds = instruments.map((i) => i.id);
    const quotes = instIds.length
      ? await prisma.latestQuote.findMany({
          where: { instrumentId: { in: instIds } },
          select: {
            instrumentId: true,
            price: true,
            change: true,
            changePercent: true,
          },
        })
      : [];
    const quoteMap = new Map(quotes.map((q) => [q.instrumentId, q]));

    const indices = instruments
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
        };
      });

    await setCached("discover", "_global", "indices", indices);
    return { success: true, data: indices };
  } catch (error) {
    logger.error({ error }, "Indices service error");
    return { success: false, error: "Failed to fetch indices" };
  }
}

// ── Internal Helpers ───────────────────────────────────────────────

function mapFund(f: Record<string, unknown>): DiscoverMutualFund {
  return {
    schemeCode: f.schemeCode as string,
    schemeName: f.schemeName as string,
    amcName: (f.amcName as string) ?? null,
    category: (f.category as string) ?? null,
    plan: (f.plan as string) ?? null,
    nav: (f.nav as number) ?? 0,
    returns1Y: (f.returns1Y as number) ?? null,
    returns3Y: (f.returns3Y as number) ?? null,
    returns5Y: (f.returns5Y as number) ?? null,
    riskLevel: (f.riskLevel as string) ?? null,
    aum: (f.aum as number) ?? null,
  };
}

// ── Universe + movers (MONEY-1092) ─────────────────────────────────────

/** Cache identifier for the 24h equity-universe entry. */
// Bumped v2 -> v3 for the Real Estate sector split (MONEY-1093). This namespace
// has a 24h TTL and no `deleteCached`, so without a key change the mobile
// endpoint `/v1/discover/sectors/real-estate` would keep resolving against the
// pre-remediation universe and return NOT_FOUND for up to a day after the
// re-sector script runs, while web (60/300s TTLs) already showed the tile.
const UNIVERSE_CACHE_KEY = "main-v3";
/** Cache identifier for the short-TTL top gainers/losers entry. */
// v2 (MONEY-1198): the entry now carries `asOfIstDay` and its rows are
// session-constrained + dual-listing-collapsed. A v1 entry has neither, so it
// must be bypassed on deploy rather than served for its remaining TTL — the
// whole point of the fix is that a caller can tell WHICH session it is holding.
// v2 -> v3: the payload is now derived snapshot-first (MONEY-1204 / D1), so a
// cached v2 entry would keep serving the quote-ranked shape after deploy. The
// bump rule for this key is standing -- change how movers are derived, bump it.
const MOVERS_CACHE_KEY = "movers-v3";

/**
 * NSE publishes seven lists per direction; `allSec` is the whole-market one and
 * the only one comparable to ranking the full quote universe. Reading all seven
 * would count a stock once per list it appears in.
 */
const MOVERS_SNAPSHOT_BUCKET = "allSec";
/**
 * Cache identifier for the SMALL companion of the universe entry (MONEY-1131):
 * the sector counts and the universe SIZE, without the rows.
 *
 * Deliberately a NEW key rather than a bump of `UNIVERSE_CACHE_KEY`. Bumping
 * `main-v3` would invalidate the 24h universe entry on deploy and make the very
 * first request after every deploy pay the full-collection scan — a worse
 * outcome than the parse this ticket is removing. Additive means the existing
 * universe entry keeps serving `/discover` untouched, and the summary simply
 * warms on its first miss.
 */
const SUMMARY_CACHE_KEY = "summary-v1";

/** Rows per movers list. Matches the previous `rankGainers(allStocks, 10)`. */
const MOVERS_LIMIT = 10;

/**
 * How many quote rows the ordered top-N pulls per side before the
 * equity / name / footprint filters run in JS.
 *
 * MONEY-1092 - the filters that decide whether a mover is *listable* live on
 * `InstrumentMapping` (instrumentType, exchange, name), a different collection
 * from the one we order by. Prisma's MongoDB connector turns a relation
 * predicate into a JS-side join, which is precisely the shape that has timed
 * out on this page before - so we overfetch the ordered head and filter after
 * the join instead. 300 is ~30x the list size: within the ±50% band the head
 * of the index is essentially all equities (indices and ETFs rarely move more
 * than a few percent), so this has enormous headroom, and if it somehow does
 * not, `getDiscoverData` falls back to ranking the universe.
 */
const MOVERS_FETCH_TAKE = 300;

/** Fresh-TTL while NSE is open, in seconds. Matches the heatmap. */
const MOVERS_TTL_LIVE_SECONDS = 60;
/** Fresh-TTL once NSE has closed, in seconds. Matches the heatmap. */
const MOVERS_TTL_CLOSED_SECONDS = 300;

/** The slow-moving half of `DiscoverData` (24h TTL). */
export interface DiscoverUniverse {
  allStocks: DiscoverStock[];
  sectors: Array<{ name: string; count: number }>;
  /** MONEY-1157 — set ONLY on `getUniverseData`'s catch path. See
   *  {@link DiscoverSummary.degraded}. */
  degraded?: true;
}

/** The fast-moving half of `DiscoverData` (60s live / 300s closed). */
interface DiscoverMovers {
  topGainers: DiscoverStock[];
  topLosers: DiscoverStock[];
  /**
   * The IST calendar day (`YYYY-MM-DD`) these movers actually belong to, or
   * null when it could not be established (MONEY-1198).
   *
   * NOT decoration and NOT the same thing as "today": it is read from the
   * newest quote timestamp in the data, so a surface can render "at close,
   * 13 Aug" instead of asserting "today" over the previous session — which is
   * exactly what shipped a +36.48% gainer that was down 5.00% on the day.
   *
   * `null` is a distinct third state meaning "could not determine", never
   * silently coerced to today.
   */
  asOfIstDay: string | null;
}

/** The row-free half of the universe entry — see `SUMMARY_CACHE_KEY`. */
interface DiscoverUniverseSummary {
  sectors: Array<{ name: string; count: number }>;
  stockCount: number;
  /** MONEY-1157 — see {@link DiscoverSummary.degraded}. */
  degraded?: true;
}

/**
 * The payload `getUniverseData` falls back to when its scan throws
 * (MONEY-1157).
 *
 * A named factory rather than an inline literal so the "what does a degraded
 * universe look like" contract has exactly ONE definition: the catch path
 * returns this, and the regression tests assert against this, so a fixture
 * cannot quietly drift away from what production actually emits.
 */
export function degradedUniverseFallback(): DiscoverUniverse {
  return { allStocks: [], sectors: buildSectorFacets([]), degraded: true };
}

function summariseUniverse(u: DiscoverUniverse): DiscoverUniverseSummary {
  return {
    sectors: u.sectors,
    stockCount: u.allStocks.length,
    // Propagated, not recomputed: the summary is what the screener page reads,
    // and dropping the flag here would put the payload right back to being
    // indistinguishable from a genuinely empty market.
    ...(u.degraded ? { degraded: true as const } : {}),
  };
}

/**
 * MONEY-1131 — single-flighted. The universe entry is the most expensive read
 * in this file (full `instrument_mappings` + full `latest_quotes`), and it has
 * NO invalidation, so every expiry is a cold stampede across whatever SSR
 * requests happen to be in flight. Same guard the movers path already carries,
 * for the same reason — this one just fires 24h apart instead of every minute.
 */
async function getCachedUniverse(): Promise<DiscoverUniverse> {
  const cached = await getCached<DiscoverUniverse>(
    "discover",
    "_global",
    UNIVERSE_CACHE_KEY,
  );
  if (cached) return cached;

  return singleFlight(`discover:universe:${UNIVERSE_CACHE_KEY}`, async () => {
    // Re-read inside the flight: the winner of a race may have populated it
    // while we were queueing behind them.
    const again = await getCached<DiscoverUniverse>(
      "discover",
      "_global",
      UNIVERSE_CACHE_KEY,
    );
    if (again) return again;

    const data = await getUniverseData();
    // MONEY-1157 — NEVER cache the failure fallback. `getUniverseData` swallows
    // a DB/quote outage into an empty universe with all-zero facets, and this
    // entry has a 24h TTL: writing it would turn a transient blip into a day of
    // an empty screener and empty sector chips, with nothing in the logs after
    // the first minute to say why. `degraded` is the determinacy signal — the
    // decision keys on "did we actually resolve the universe", never on the
    // value (a genuinely empty environment IS cacheable and is not degraded).
    if (!data.degraded) {
      await setCached("discover", "_global", UNIVERSE_CACHE_KEY, data);
      // Written in the SAME step as the universe so the two entries can only
      // disagree if one is evicted early — never because they were derived from
      // different scans.
      await setCached(
        "discover",
        "_global",
        SUMMARY_CACHE_KEY,
        summariseUniverse(data),
      );
    }
    return data;
  });
}

/**
 * IO seam for the summary path (MONEY-1131). This package's suite runs as ESM —
 * no `require.cache` module-mocking — so the ports are injectable, matching
 * `ScreenerServiceDeps` next door. Production always takes the defaults.
 */
export interface DiscoverSummaryPorts {
  /** Reads the SMALL summary entry. */
  readSummary?: () => Promise<DiscoverUniverseSummary | null>;
  /** Writes the SMALL summary entry. */
  writeSummary?: (value: DiscoverUniverseSummary) => Promise<void>;
  /** The expensive one — the whole ~7,400-row universe. */
  getUniverse?: () => Promise<DiscoverUniverse>;
  getMovers?: () => Promise<DiscoverMovers | null>;
}

type ResolvedSummaryPorts = Required<DiscoverSummaryPorts>;

function withSummaryDefaults(deps: DiscoverSummaryPorts): ResolvedSummaryPorts {
  return {
    readSummary:
      deps.readSummary ??
      (() =>
        getCached<DiscoverUniverseSummary>(
          "discover",
          "_global",
          SUMMARY_CACHE_KEY,
        )),
    writeSummary:
      deps.writeSummary ??
      ((value) => setCached("discover", "_global", SUMMARY_CACHE_KEY, value)),
    getUniverse: deps.getUniverse ?? getCachedUniverse,
    getMovers: deps.getMovers ?? getCachedMovers,
  };
}

/**
 * The small entry `getDiscoverSummary` serves from. A miss falls through to the
 * universe (the one expensive read this exists to avoid) — at most once per
 * summary TTL, and `getCachedUniverse` writes the summary on its way past, so a
 * cold pair costs exactly one scan, not two.
 */
async function getCachedUniverseSummary(
  ports: ResolvedSummaryPorts,
): Promise<DiscoverUniverseSummary> {
  const cached = await ports.readSummary();
  if (cached) return cached;

  return singleFlight(`discover:summary:${SUMMARY_CACHE_KEY}`, async () => {
    const again = await ports.readSummary();
    if (again) return again;

    const summary = summariseUniverse(await ports.getUniverse());
    // Same determinacy rule as `getCachedUniverse`: a degraded universe is a
    // "couldn't determine", not an answer, so it never becomes the cached one.
    if (!summary.degraded) await ports.writeSummary(summary);
    return summary;
  });
}

/**
 * Per-call TTL override rather than a change to the `discover` namespace
 * default: that namespace is shared with genuinely reference-grade data
 * (the instrument rich-search, the sector lists), which has no business being
 * recomputed every minute. Only movers are market-clocked.
 */
async function getCachedMovers(): Promise<DiscoverMovers | null> {
  const ttlOverride = {
    ttl: getNseMarketStatus().isLive
      ? MOVERS_TTL_LIVE_SECONDS
      : MOVERS_TTL_CLOSED_SECONDS,
  };

  try {
    // MONEY-1092 - single-flight is load-bearing precisely BECAUSE the TTL
    // dropped from 24h to 60s. A key that expires once a day makes a
    // thundering herd a once-a-day curiosity; a key that expires every
    // minute during market hours makes it a standing pattern, and every
    // concurrent SSR request on the expired key would otherwise run its own
    // three queries. The queries are bounded and index-served, so this is
    // cheap insurance rather than a rescue - but it is the same failure
    // shape that took the heatmap down, so it gets the same guard.
    return await singleFlight(
      `discover:movers:${MOVERS_CACHE_KEY}`,
      async () => {
        const cached = await getCached<DiscoverMovers>(
          "discover",
          "_global",
          MOVERS_CACHE_KEY,
          undefined,
          ttlOverride,
        );
        if (cached) return cached;

        const movers = await fetchTopMovers();
        await setCached(
          "discover",
          "_global",
          MOVERS_CACHE_KEY,
          movers,
          undefined,
          ttlOverride,
        );
        return movers;
      },
    );
  } catch (error) {
    // Never fail the whole Discover payload for the movers half - the caller
    // falls back to ranking the universe it already holds.
    logger.error({ error }, "top movers fetch failed - ranking universe");
    return null;
  }
}

/**
 * Top gainers / losers as an ORDERED TOP-N, not a scan.
 *
 * MONEY-1092 - these were derived in JS from `allStocks`, i.e. from a
 * full-collection read of `latest_quotes`. That was tolerable at one run a day
 * and is not tolerable at one run a minute, which is what the movers freshness
 * requirement implies. So the ranking moves into the database:
 *
 *   - `orderBy: { changePercent }` is served by `@@index([changePercent])` on
 *     LatestQuote. A single-field index walks in BOTH directions, so `desc`
 *     (gainers) and `asc` (losers) each stream straight off the index and stop
 *     at `take` - no blocking in-memory SORT stage. Sorting on an UNINDEXED
 *     field is the exact defect this ticket is about; do not "improve" this
 *     ordering onto a column that has no index.
 *   - The ±`MAX_ABS_CHANGE_PERCENT` bound is not decoration: it is the SAME
 *     inclusive band `rankGainers`/`rankLosers` apply via
 *     `isWithinGainerLoserBand`, pushed down into the index range. Sharing the
 *     constant means the DB range and the JS guard cannot drift apart. It also
 *     keeps the head of the index clean - a stored `Infinity` changePercent
 *     (÷0 on a zero previousClose upstream) sorts first otherwise and would
 *     eat overfetch slots before the JS guard discards it.
 *
 * The JS ranking is still `rankGainers`/`rankLosers`, so the NaN-/Infinity-
 * safety and the deterministic symbol tiebreak are unchanged, and the output
 * is identical to the old scan-and-rank for the same data.
 */
/**
 * Read the PRECOMPUTED movers snapshot — MONEY-1204 (P14 / 14d.4, decision D1).
 *
 * `market_movers` is written every 3 minutes during market hours by
 * `market-movers-sync`, straight from NSE's own `/api/live-analysis-variations`,
 * already ISIN-deduped and already ranked by the exchange. Until this change it
 * had exactly ONE reader in the whole repo — the writer's own dedupe
 * `findFirst` — while the panel ranked `latest_quotes` itself.
 *
 * Two details of this table are easy to get wrong and both are load-bearing:
 *
 *  - **`direction` is which ENDPOINT served the row, never the sign of a percent
 *    field.** NSE ranks on a corporate-action-adjusted figure, so a row in the
 *    gainers list can carry a negative raw `percentChange` (FEDERALBNK on
 *    14-Aug-2026: −0.01, listed as a GAINER). Filtering by sign here would drop
 *    rows the exchange itself calls gainers.
 *  - **`bucket` is part of the identity, not decoration.** NSE publishes seven
 *    lists per direction; `allSec` is the whole-market one, which is the only
 *    one comparable to what the quote-ranking path produces. Reading all seven
 *    would multiply-count a stock that appears in NIFTY *and* FOSec *and*
 *    allSec.
 */
async function fetchMoversFromSnapshot(): Promise<{
  movers: DiscoverMovers;
  snapshotAt: Date | null;
}> {
  const latest = await prisma.marketMover.findFirst({
    where: { bucket: MOVERS_SNAPSHOT_BUCKET },
    orderBy: { snapshotAt: "desc" },
    select: { snapshotAt: true, date: true },
  });
  if (!latest) {
    return {
      movers: { topGainers: [], topLosers: [], asOfIstDay: null },
      snapshotAt: null,
    };
  }

  // Pin to the newest SESSION, not the newest instant: a 3-minute cadence means
  // the freshest row and the rest of its list are minutes apart, and taking
  // only rows sharing the exact `snapshotAt` would return a partial list.
  const rows = await prisma.marketMover.findMany({
    where: { bucket: MOVERS_SNAPSHOT_BUCKET, date: latest.date },
    orderBy: [{ snapshotAt: "desc" }, { rank: "asc" }],
    take: MOVERS_FETCH_TAKE * 2,
    select: {
      symbol: true,
      direction: true,
      instrumentId: true,
      isin: true,
      rank: true,
      ltp: true,
      prevClose: true,
      percentChange: true,
      rupeeChange: true,
      tradedQty: true,
      snapshotAt: true,
    },
  });
  if (rows.length === 0) {
    return {
      movers: { topGainers: [], topLosers: [], asOfIstDay: null },
      snapshotAt: null,
    };
  }

  // Keep only the newest reading per (direction, symbol): a session holds many
  // 3-minute snapshots and the same symbol recurs in each. Rows arrive newest
  // first, so first-seen wins.
  const freshest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.direction}|${r.symbol}`;
    if (!freshest.has(key)) freshest.set(key, r);
  }
  const unique = [...freshest.values()];

  const instrumentIds = [
    ...new Set(
      unique.map((r) => r.instrumentId).filter((id): id is string => !!id),
    ),
  ];
  const instruments = instrumentIds.length
    ? await prisma.instrumentMapping.findMany({
        where: {
          id: { in: instrumentIds },
          isActive: true,
          instrumentType: "EQUITY",
          exchange: { in: ["NSE", "BSE"] },
        },
        select: DISCOVER_INSTRUMENT_SELECT,
      })
    : [];
  const instrumentById = new Map(instruments.map((i) => [i.id, i]));

  // `market_movers` carries no market cap, and `hasMarketFootprint` accepts a
  // row on `volume || marketCap`. `tradedQty` is nullable on that table, so
  // without this join every mover NSE published without a quantity would be
  // silently dropped -- a filter that removes rows for a reason unrelated to
  // the thing being filtered for. One bounded $in over ids we already hold,
  // index-served, reading a single column.
  const caps = instrumentIds.length
    ? await prisma.latestQuote.findMany({
        where: { instrumentId: { in: instrumentIds } },
        select: { instrumentId: true, marketCap: true },
      })
    : [];
  const marketCapById = new Map(caps.map((c) => [c.instrumentId, c.marketCap]));

  const toStocks = (direction: string): DiscoverStock[] => {
    const stocks = unique
      .filter((r) => r.direction === direction)
      .map((r) => {
        const inst = r.instrumentId
          ? instrumentById.get(r.instrumentId)
          : undefined;
        // A row whose instrument no longer resolves is DROPPED, not minted --
        // the same rule the price feeds follow. Rendering a mover we cannot
        // link to is a dead-end row on a panel whose whole job is navigation.
        if (!inst || !isDiscoverableEquityName(inst.name)) return null;
        // Mapped explicitly onto DiscoverQuoteFields rather than cast: the two
        // sources name the same quantities differently (ltp/rupeeChange/
        // percentChange/tradedQty vs price/change/changePercent/volume), and a
        // cast would let a future column rename compile while producing nulls.
        // marketCap is NOT on this table -- it comes from the instrument join,
        // and `hasMarketFootprint` below is what decides whether that is
        // survivable, exactly as on the quote path.
        const quote: DiscoverQuoteFields = {
          price: r.ltp,
          change: r.rupeeChange,
          changePercent: r.percentChange,
          volume: r.tradedQty,
          marketCap: marketCapById.get(inst.id) ?? null,
        };
        return toDiscoverStock(inst, quote);
      })
      .filter((x): x is DiscoverStock => x !== null && hasMarketFootprint(x));
    return dedupeDualListings(stocks);
  };

  const newest = unique.reduce<Date | null>(
    (max, r) => (!max || r.snapshotAt > max ? r.snapshotAt : max),
    null,
  );

  return {
    movers: {
      // NSE already ranked these; `rank asc` preserved that order above. The
      // local rankers are still applied so the two paths cannot disagree on
      // tie-breaking or on the NaN/Infinity guards.
      topGainers: rankGainers(toStocks("GAINERS"), MOVERS_LIMIT),
      topLosers: rankLosers(toStocks("LOSERS"), MOVERS_LIMIT),
      asOfIstDay: newest ? istDayKey(newest) : null,
    },
    snapshotAt: newest,
  };
}

/**
 * Movers, snapshot-first — MONEY-1204 (P14 / 14d.4, D1).
 *
 * Precedence, and it is deliberate:
 *   1. `market_movers` (PRIMARY) — the exchange's own ranked list.
 *   2. `latest_quotes` ranking (FALLBACK) — only when the snapshot is EMPTY or
 *      belongs to an EARLIER session than the quotes do.
 *
 * The fallback is kept rather than deleted because removing it trades one
 * silent-staleness failure for a total-blank one. But it is now the exception,
 * and the decision is made on the two sources' OWN session days
 * (`decideMoversSource`), never on the wall clock -- judging by clock would need
 * a trading-calendar lookup to be right on holidays and would flap to the
 * fallback every Sunday, precisely when neither source has anything newer.
 *
 * The path that served is LOGGED on every derivation, because "which source is
 * this number from?" is the first question any movers bug raises and it must be
 * answerable from one line.
 */
async function fetchTopMovers(): Promise<DiscoverMovers> {
  const snapshot = await fetchMoversFromSnapshot().catch((error) => {
    // A snapshot failure must not take the panel down -- the fallback exists.
    logger.error(
      { error },
      "movers snapshot read failed - using quote ranking",
    );
    return null;
  });

  const quotes = await fetchMoversFromQuotes();
  const referenceAt = quotes.asOfIstDay
    ? new Date(`${quotes.asOfIstDay}T00:00:00.000Z`)
    : null;

  const decision = decideMoversSource({
    snapshotAt: snapshot?.snapshotAt ?? null,
    referenceAt,
  });

  logger.info(
    {
      source: decision.source,
      reason: decision.reason,
      snapshotDay: decision.snapshotDay,
      referenceDay: decision.referenceDay,
      gainers:
        decision.source === "snapshot"
          ? (snapshot?.movers.topGainers.length ?? 0)
          : quotes.topGainers.length,
    },
    "discover movers served",
  );

  if (decision.source === "snapshot" && snapshot) {
    // A snapshot that survives the freshness test but yields no renderable rows
    // (every instrument unresolved) is not an answer -- fall through.
    if (
      snapshot.movers.topGainers.length > 0 ||
      snapshot.movers.topLosers.length > 0
    ) {
      return snapshot.movers;
    }
    logger.warn(
      { snapshotDay: decision.snapshotDay },
      "movers snapshot was current but rendered no rows - using quote ranking",
    );
  }
  return quotes;
}

async function fetchMoversFromQuotes(): Promise<DiscoverMovers> {
  const [gainerQuotes, loserQuotes] = await Promise.all([
    prisma.latestQuote.findMany({
      where: { changePercent: { gt: 0, lte: MAX_ABS_CHANGE_PERCENT } },
      orderBy: { changePercent: "desc" },
      take: MOVERS_FETCH_TAKE,
      select: DISCOVER_QUOTE_SELECT,
    }),
    prisma.latestQuote.findMany({
      where: { changePercent: { lt: 0, gte: -MAX_ABS_CHANGE_PERCENT } },
      orderBy: { changePercent: "asc" },
      take: MOVERS_FETCH_TAKE,
      select: DISCOVER_QUOTE_SELECT,
    }),
  ]);

  const instrumentIds = [
    ...new Set([...gainerQuotes, ...loserQuotes].map((q) => q.instrumentId)),
  ];
  if (instrumentIds.length === 0)
    return { topGainers: [], topLosers: [], asOfIstDay: null };

  // Bounded join (<= 2 * MOVERS_FETCH_TAKE ids, well inside Mongo's ~10k `$in`
  // soft cap) carrying the SAME universe predicates the Discover grid uses, so
  // a mover can never be a row the grid itself would reject.
  const instruments = await prisma.instrumentMapping.findMany({
    where: {
      id: { in: instrumentIds },
      isActive: true,
      instrumentType: "EQUITY",
      exchange: { in: ["NSE", "BSE"] },
    },
    select: DISCOVER_INSTRUMENT_SELECT,
  });
  const instrumentById = new Map(instruments.map((i) => [i.id, i]));

  // MONEY-1198 — WHICH SESSION are we ranking?
  //
  // The bug: this ranked every row in `latest_quotes` regardless of age, and
  // nothing bulk-refreshes that table intraday (price-sync runs 23:00 IST). So
  // at 11:47 IST the whole table was still the PREVIOUS session's close, and the
  // panel presented it under the heading "today". LAPL showed Rs 128.29 +36.48%
  // while the stock was actually at Rs 121.88, DOWN 5.00%, with Rs 128.29 as its
  // PREVIOUS CLOSE. Every number was internally consistent and none was today's.
  //
  // Note the 60s `MOVERS_TTL_LIVE_SECONDS` did not help and could not: it
  // governs how often the movers CACHE re-derives, not how old the underlying
  // rows are. A fresh cache over a stale table is still stale.
  //
  // The session is taken from the DATA (the newest quote timestamp), not from
  // the clock. Deriving it from `now` would need a trading-calendar lookup to be
  // right on holidays and before the open, and would report "today" on a day the
  // pipeline never ran — asserting freshness we do not have. Future-stamped rows
  // are excluded first so one bad row cannot define the session and filter out
  // every good one.
  const nowMs = Date.now();
  const candidates = [...gainerQuotes, ...loserQuotes].filter(
    (q) => q.timestamp instanceof Date && q.timestamp.getTime() <= nowMs,
  );
  const newest = candidates.reduce<Date | null>(
    (max, q) => (!max || q.timestamp > max ? q.timestamp : max),
    null,
  );
  const session = newest ? istDayKey(newest) : null;

  const toStocks = (
    rows: ReadonlyArray<(typeof gainerQuotes)[number]>,
  ): DiscoverStock[] => {
    const oneSession = session
      ? rows.filter(
          (q) =>
            q.timestamp instanceof Date &&
            q.timestamp.getTime() <= nowMs &&
            istDayKey(q.timestamp) === session,
        )
      : rows;

    const stocks = oneSession
      .map((q) => {
        const inst = instrumentById.get(q.instrumentId);
        if (!inst || !isDiscoverableEquityName(inst.name)) return null;
        return toDiscoverStock(inst, q);
      })
      .filter((s): s is DiscoverStock => s !== null && hasMarketFootprint(s));

    // Collapse a company's NSE and BSE legs BEFORE `take`, so a dual listing
    // cannot consume two of the ten slots. Applied here rather than after
    // ranking because slicing first would already have spent the slots.
    return dedupeDualListings(stocks);
  };

  return {
    topGainers: rankGainers(toStocks(gainerQuotes), MOVERS_LIMIT),
    topLosers: rankLosers(toStocks(loserQuotes), MOVERS_LIMIT),
    // Carried so the surface can say WHICH session it is showing instead of
    // always claiming "today". A panel that cannot tell the difference is how
    // this bug reached a user.
    asOfIstDay: session,
  };
}

async function getUniverseData(): Promise<DiscoverUniverse> {
  try {
    const instruments = await prisma.instrumentMapping.findMany({
      where: {
        isActive: true,
        instrumentType: "EQUITY",
        exchange: { in: ["NSE", "BSE"] },
      },
      select: DISCOVER_INSTRUMENT_SELECT,
    });

    // MONEY-1092 - deliberately still a full read of `latest_quotes`, and
    // deliberately NOT given a `take`. `allStocks` IS the tradable universe:
    // the screener, the sector deep-dive and the paper-trading picker all
    // enumerate it, so any cap here would silently narrow those surfaces. The
    // containment is the 24h TTL (this never runs on the movers cadence) plus
    // the projection below, which stops us shipping open/high/low/
    // previousClose/timestamp/source for every row just to read six columns.
    //
    // MONEY-704 re-examined this and left it alone ON PURPOSE — it is the ONE
    // legitimate exception in this file, and the reasoning is NOT the bogus
    // "`in` compiles to `$expr`" claim that was deleted from
    // `packages/core/src/market-data/prices/quote-service.ts` and
    // `apps/web/lib/market/yahoo-client.ts`. Here the id list IS essentially
    // the collection: `latest_quotes` only ever holds EQUITY/INDEX/ETF rows
    // (see `refreshAllQuotes`), so `instrumentIdSet` covers the large majority
    // of it. Chunking that into ~12 × 500-id `$in` queries would trade one
    // sequential scan for ~6,000 index seeks across 12 round trips and return
    // the same rows. Everywhere else in this file the id list is BOUNDED
    // (a few dozen) and the `$in` is the right shape — copy those, not this.
    const instrumentIdSet = new Set(instruments.map((i) => i.id));
    const allQuotes = await prisma.latestQuote.findMany({
      select: DISCOVER_QUOTE_SELECT,
    });
    const quotes = allQuotes.filter((q) => instrumentIdSet.has(q.instrumentId));
    const quoteMap = new Map(quotes.map((q) => [q.instrumentId, q]));

    const allStocks: DiscoverStock[] = instruments
      .filter(
        (inst) => quoteMap.has(inst.id) && isDiscoverableEquityName(inst.name),
      )
      .map((inst) => toDiscoverStock(inst, quoteMap.get(inst.id)!))
      .filter(hasMarketFootprint);

    // Count only instruments that survived the `allStocks` filter chain
    // - i.e. EQUITY rows on NSE/BSE that have a LatestQuote and aren't
    // mutual-fund-shaped strings in the InstrumentMapping. Counting the
    // raw `instruments` array bloated "Not Categorised" with delisted /
    // never-traded / non-tradable rows that no user can actually screen
    // for (image #75 - 14,996 mismatch reported by user).
    //
    // MONEY-1157 — the counting itself lives in `buildSectorFacets` now. It
    // used to key on the RAW sector while emitting only canonical names, so
    // ~285 prod rows (Other 228, Construction 40, Media & Entertainment 9,
    // Textiles 8) were counted into a bucket nothing ever read back.
    const sectors = buildSectorFacets(allStocks);

    return { allStocks, sectors };
  } catch (error) {
    // Empty market fallback — log so a DB/quote outage isn't mistaken for
    // "no stocks to discover". MONEY-1092: this no longer blanks the movers
    // too — they are fetched independently, so a universe-scan failure now
    // leaves Top Movers on `/discover/markets` intact.
    //
    // MONEY-1157 — `degraded` is the SENTINEL that makes this branch
    // distinguishable downstream. The shape is otherwise byte-identical to a
    // genuinely empty market (a non-empty, all-zero facet array), so every
    // caller that looked at the payload alone — the screener page's
    // `sectors.length > 0` guard in particular — treated a DB outage as
    // authoritative "no stocks in any sector". Inferring it from the counts is
    // not enough either: a cold environment legitimately has all-zero counts.
    logger.error({ error }, "stock discover data fetch failed");
    return degradedUniverseFallback();
  }
}

async function getAllDirectFundsData(): Promise<MfDiscoverData> {
  // The Category + AMC filter dropdowns must populate in EVERY environment.
  // DO NOT gate this on navDate / lastSyncedAt: dev & QA MF data carry stale
  // NAVs, so a freshness window returns zero rows there and the dropdowns
  // render empty (the prod-vs-dev divergence that zeroed the MF screener
  // filters — see feedback_screener_data_gates). Gate on `isActive` only.
  // And derive the option lists via cheap `distinct` aggregations instead of
  // scanning + mapping all ~14k rows — the unbounded scan + per-row map was
  // what blew the page-level `withTimeout` and produced the empty lists.
  const ACTIVE = { isActive: true } as const;

  const [catRows, amcRows, sampleFunds] = await Promise.all([
    // Real per-category fund counts. `category` is indexed
    // (@@index([category])) so a grouped count is cheap and lets the
    // Category dropdown show the TRUE number of active funds in each
    // bucket — never the previous hardcoded sample cap (PER_CATEGORY_LIMIT
    // = 50) that made every category read "50".
    prisma.mutualFundMaster.groupBy({
      by: ["category"],
      where: ACTIVE,
      _count: { _all: true },
    }),
    prisma.mutualFundMaster.findMany({
      where: ACTIVE,
      select: { amcName: true },
      distinct: ["amcName"],
    }),
    // Bounded browse sample (top funds by AUM). The screener results table
    // runs its own query; this only seeds the initial grid, so a cap keeps it
    // fast and timeout-proof.
    prisma.mutualFundMaster.findMany({
      where: ACTIVE,
      select: {
        schemeCode: true,
        schemeName: true,
        amcName: true,
        category: true,
        plan: true,
        nav: true,
        returns1Y: true,
        returns3Y: true,
        returns5Y: true,
        riskLevel: true,
        aum: true,
      },
      orderBy: { aum: "desc" },
      take: 500,
    }),
  ]);

  const categories = catRows
    .map((r) => ({ name: r.category, count: r._count._all }))
    .filter((c): c is { name: string; count: number } => Boolean(c.name))
    // Largest buckets first (matches the Discover page's "top categories"
    // ordering); ties broken alphabetically for a stable list.
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const amcList = amcRows
    .map((r) => r.amcName)
    .filter((a): a is string => Boolean(a))
    .sort((a, b) => a.localeCompare(b));

  const allFunds = sampleFunds.map((f) =>
    mapFund(f as unknown as Record<string, unknown>),
  );

  return { allFunds, categories, amcList };
}

/** The sentinel written to `sector` when enrichment cannot resolve a symbol. */
const SECTOR_SKIPPED = "N/A";
/** The label the UI shows for that sentinel. */
const UNCATEGORISED_DISPLAY = "Not Categorised";

const slugifySector = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Translate whatever the caller passed into the value actually STORED in
 * `InstrumentMapping.sector`.
 *
 * Two distinct failures made this necessary, both of which rendered an empty
 * screen that looked like a data gap rather than a bug:
 *
 *   - `/v1/discover/sectors/:sector/stocks` passes a SLUG ("real-estate"), and
 *     this query did raw equality on it. Its sibling
 *     `/v1/discover/sectors/:sector` resolves slugs properly, so the two routes
 *     disagreed about what `:sector` means: the deep-dive worked and the stocks
 *     list returned HTTP 200 with `[]`.
 *   - "Not Categorised" is a DISPLAY label; the stored sentinel is "N/A". So
 *     clicking that heatmap tile always queried a value that exists on zero
 *     rows.
 *
 * Resolution order keeps the common case at one query: an exact stored value is
 * used as-is, and only a miss pays for the `distinct` lookup.
 */
async function resolveStoredSector(input: string): Promise<string | null> {
  const raw = input.trim();
  if (!raw) return null;

  const wanted = slugifySector(raw);
  if (
    raw === UNCATEGORISED_DISPLAY ||
    wanted === slugifySector(UNCATEGORISED_DISPLAY)
  ) {
    // NOTE: this returns the sentinel only. The uncategorised BUCKET is
    // `!sector || "N/A"` (see the aggregators), so a null-sector row is not
    // reachable through this single-value resolver — `/…/not-categorised/stocks`
    // therefore under-reports relative to the tile. Fixing it properly needs the
    // caller to accept a predicate rather than a string, which is a wider change
    // than this resolver; recorded rather than left implicit.
    return SECTOR_SKIPPED;
  }

  // Canonical names first — no query at all.
  //
  // This used to be an unbounded `distinct` over every active equity row, behind
  // a PUBLIC route parameter. Prisma implements `distinct` in the query engine,
  // so it reads every matching document, and the caller's cache key contains the
  // raw string — meaning a varying `:sector` gave one full-collection read per
  // request plus unbounded Redis keys at a 24h TTL. The canonical set answers
  // almost every real slug for free.
  for (const name of getAllSectorNames()) {
    if (slugifySector(name) === wanted) return name;
  }

  // Only a NON-canonical bucket ("Other", "Construction", "Media & Entertainment"
  // — real prod values) reaches a query, and it is bounded.
  const distinct = await prisma.instrumentMapping.findMany({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      sector: REAL_SECTOR_WHERE,
    },
    select: { sector: true },
    distinct: ["sector"],
    take: 200,
  });
  for (const d of distinct) {
    if (d.sector && slugifySector(d.sector) === wanted) return d.sector;
  }
  return null;
}

async function fetchStocksBySector(
  sector: string,
  limit: number,
  sortBy: "name" | "changePercent" | "marketCap",
): Promise<DiscoverStock[]> {
  try {
    // Try the caller's value AS-IS first, so the common case costs exactly what
    // it always did — one query, same shape. Only a MISS pays for slug
    // resolution. (Resolving up-front added a query to every call and changed
    // the query order, which is also what the query-shape tests pin.)
    let instruments = await prisma.instrumentMapping.findMany({
      where: {
        isActive: true,
        sector,
        instrumentType: "EQUITY",
      },
      select: DISCOVER_INSTRUMENT_SELECT,
      ...(sortBy === "name" ? { orderBy: { symbol: "asc" as const } } : {}),
    });

    if (instruments.length === 0) {
      // The caller passed a SLUG ("real-estate") or the display label for the
      // sentinel bucket ("Not Categorised", stored as "N/A"). Both used to
      // return HTTP 200 with [] — an empty screen that reads as a data gap
      // rather than a bug — while the sibling deep-dive route resolved slugs
      // properly. Resolve and retry once.
      const stored = await resolveStoredSector(sector);
      if (stored && stored !== sector) {
        instruments = await prisma.instrumentMapping.findMany({
          where: { isActive: true, sector: stored, instrumentType: "EQUITY" },
          select: DISCOVER_INSTRUMENT_SELECT,
          ...(sortBy === "name" ? { orderBy: { symbol: "asc" as const } } : {}),
        });
      }
    }

    // MONEY-1092 - this was a bare `findMany({})` too: a full read of every
    // latest quote in the collection, discarded in JS down to one sector's
    // few hundred instruments. `instrumentId` is `@unique`, so the `$in` is an
    // index lookup. The `previousClose > 0` gate stays in JS so the predicate
    // shape (and therefore the index the planner picks) is unchanged - a null
    // previousClose still fails `(q.previousClose ?? 0) > 0` exactly as before.
    const sectorInstIds = instruments.map((i) => i.id);
    const sectorQuotes = sectorInstIds.length
      ? await prisma.latestQuote.findMany({
          where: { instrumentId: { in: sectorInstIds } },
          select: { ...DISCOVER_QUOTE_SELECT, previousClose: true },
        })
      : [];
    const quoteMap = new Map(
      sectorQuotes
        .filter((q) => (q.previousClose ?? 0) > 0)
        .map((q) => [q.instrumentId, q]),
    );

    // Same finite-guard as the universe path (shared `toDiscoverStock`): a
    // stored NaN/Infinity must not reach the rendered chip nor flip the sort.
    let results = instruments
      .filter((inst) => quoteMap.has(inst.id))
      .map((inst) => toDiscoverStock(inst, quoteMap.get(inst.id)!));

    // NaN-/Infinity-safe, deterministic sector sort (a corrupt `changePercent`
    // or `marketCap` can no longer flip the order-unstable raw comparator into
    // crowning a corrupt row — see ./discover-logic.ts#sortStocksBySector).
    results = sortStocksBySector(results, sortBy);

    return results.slice(0, limit);
  } catch (error) {
    // Empty fallback — log so a DB/quote outage isn't mistaken for an
    // empty sector.
    logger.error({ error, sector }, "sector fetch failed");
    return [];
  }
}

// ── Rich search for the chat composer popover (MONEY-219 step 3) ───────

/**
 * Live-search for stocks / mutual funds / ETFs with the per-kind metadata
 * the InstrumentsView popover needs. The picker today shipped with mock
 * rows because `searchInstrumentsAction` only returns symbol + name +
 * price; this service joins the latest-quote (for price/change/marketCap),
 * sector + instrumentType (for the sector/mcap chips), and for MFs the
 * AMFI master row (for AUM / category / 1Y/3Y/5Y returns).
 *
 * Used only by the popover. Hot path is debounced client-side; service
 * caches under "discover:rich-search:{kind}:{q}".
 */

export interface RichSearchStockResult {
  symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  instrumentType: string;
  yahooSymbol: string;
  price: number;
  change: number;
  changePercent: number;
  marketCap: number | null;
  // ETF-specific (filled when instrumentType = ETF)
  benchmark: string | null;
  liquidity: "High" | "Medium" | "Low" | null;
}

export interface RichSearchMfResult {
  schemeCode: string;
  schemeName: string;
  amcName: string | null;
  category: string | null;
  nav: number;
  changePercent: number; // approximated from 1Y annualised return for the picker tag
  aum: number | null;
  rating: number | null; // 1-5 from CRISIL bucket
  returns1Y: number | null;
}

export interface RichSearchResult {
  stocks: RichSearchStockResult[];
  mfs: RichSearchMfResult[];
  etfs: RichSearchStockResult[];
}

const RICH_LIQUIDITY_CUTOFFS = {
  high: 5_000_000,
  medium: 1_000_000,
};

function mapRiskToRating(risk: string | null | undefined): number | null {
  if (!risk) return null;
  const map: Record<string, number> = {
    Low: 5,
    "Moderately Low": 4,
    Moderate: 3,
    "Moderately High": 2,
    High: 2,
    "Very High": 1,
  };
  return map[risk] ?? null;
}

function mapVolumeToLiquidity(
  volume: number | null,
): "High" | "Medium" | "Low" | null {
  if (volume === null) return null;
  if (volume > RICH_LIQUIDITY_CUTOFFS.high) return "High";
  if (volume > RICH_LIQUIDITY_CUTOFFS.medium) return "Medium";
  return "Low";
}

// Curated "popular" anchor list. Used as a tier-1 ranking signal so that
// a search like "h" surfaces HDFCBANK / HINDUNILVR before lesser-known
// peers, and so the empty-query "popular" view leads with names users
// actually recognise. Position in this array is the priority - earlier
// entries rank higher.
const POPULAR_STOCK_LIST: string[] = [
  "RELIANCE",
  "TCS",
  "HDFCBANK",
  "ICICIBANK",
  "BHARTIARTL",
  "INFY",
  "SBIN",
  "ITC",
  "LT",
  "HINDUNILVR",
  "KOTAKBANK",
  "AXISBANK",
  "BAJFINANCE",
  "ASIANPAINT",
  "MARUTI",
  "HCLTECH",
  "WIPRO",
  "ADANIENT",
  "TATAMOTORS",
  "TATASTEEL",
  "ONGC",
  "SUNPHARMA",
  "ULTRACEMCO",
  "TITAN",
  "POWERGRID",
  "NTPC",
  "M&M",
  "JSWSTEEL",
  "NESTLEIND",
  "COALINDIA",
];
const POPULAR_RANK = new Map(POPULAR_STOCK_LIST.map((s, i) => [s, i]));

// Tier-3 relevance scoring for the search path. Lower is better - exact
// match beats prefix beats substring beats name-only. Used inside the
// composite sort so a query like "rel" still puts RELIANCE above stocks
// whose name happens to contain "rel" as a substring.
function relevanceScore(symbol: string, name: string, q: string): number {
  if (!q) return 0;
  const sUp = symbol.toUpperCase();
  const nUp = name.toUpperCase();
  const qUp = q.toUpperCase();
  if (sUp === qUp) return 0;
  if (sUp.startsWith(qUp)) return 1;
  if (sUp.includes(qUp)) return 2;
  if (nUp.startsWith(qUp)) return 3;
  if (nUp.includes(qUp)) return 4;
  return 5;
}

/**
 * Rich instrument search across Stocks / MFs / ETFs. Each kind has its
 * own query so empty kinds don't pay for unrelated I/O.
 *
 * Ordering signals (composite, in priority order):
 *   1. **List** - curated POPULAR_STOCK_LIST rank
 *   2. **analysisCount** - how often the stock has been researched in-app
 *   3. **Relevance** - only meaningful for non-empty queries (exact >
 *      prefix > contains)
 *   4. **MCap** - final tiebreaker so larger-cap names lead within a tier
 */
export async function richSearchInstruments(opts: {
  query: string;
  kind: "stocks" | "mfs" | "etfs";
  limit?: number;
}): Promise<ServiceResult<RichSearchResult>> {
  const { query, kind, limit = 12 } = opts;
  const trimmed = query.trim();
  const empty: RichSearchResult = { stocks: [], mfs: [], etfs: [] };

  try {
    const cached = await getCached<RichSearchResult>(
      "discover",
      "_global",
      "rich-search-v6",
      { q: trimmed, kind, limit },
    );
    if (cached) return { success: true, data: cached };

    if (kind === "stocks" || kind === "etfs") {
      // MONEY-1085 follow-up: the funds side is ETF **plus the exchange-traded
      // trusts** (REIT/INVIT). Hard-coding "ETF" here would drop them from both
      // lists — they are no longer EQUITY either.
      const wantedTypes =
        kind === "stocks" ? ["EQUITY"] : [...FUND_INSTRUMENT_TYPES];

      // Empty-query path: "Popular" = highest market-cap rows, taken from
      // LatestQuote (which holds marketCap), then joined back to
      // InstrumentMapping for symbol/name/sector/exchange. analysisCount
      // is unreliable in this DB (mostly 0), and the InstrumentMapping
      // table also carries a long tail of T-Bills / SDLs / GoI bonds
      // tagged as EQUITY - we drop those by requiring price > 0.
      //
      // Search path: keep the InstrumentMapping query so contains-match on
      // symbol/name still works, then enrich with the quote.
      // Carrier shape from the candidate-source step. We always carry the
      // instrument `id` so the price-enrichment step can join LatestQuote
      // without a second InstrumentMapping lookup - that redundant query
      // was hanging on EC2 Mongo (QA) where Atlas Search isn't available
      // and there's no $search short-circuit.
      type Candidate = {
        id: string;
        symbol: string;
        name: string;
        exchange: string;
        sector: string | null;
        instrumentType: string;
        yahooSymbol: string;
        industry: string | null;
        analysisCount: number;
        atlasScore: number; // 0 when sourced from Prisma
      };
      let candidates: Candidate[] = [];

      const baseSelect = {
        id: true,
        symbol: true,
        name: true,
        exchange: true,
        sector: true,
        instrumentType: true,
        yahooSymbol: true,
        industry: true,
        analysisCount: true,
      } as const;

      if (trimmed) {
        // SEARCH PATH - Atlas Search first when on Atlas (Prod), Prisma
        // `contains` everywhere else (QA = EC2 Mongo). Atlas already gates
        // itself via the shared search gate, so this is a single-line dispatch.
        //
        // MONEY-1205 — the Atlas query is UPPERCASED; the Prisma fallback below
        // keeps `trimmed` raw. That asymmetry is deliberate and load-bearing.
        //
        // In the `instrument_search` index `symbol` is mapped TWICE: as an
        // edgeGram `autocomplete` field and as a `string` with
        // `lucene.keyword` (docs/setup/atlas-search-setup.md). `lucene.keyword`
        // emits the whole field as ONE unmodified token, so the `text` leg over
        // `["symbol","name"]` only matches an exactly-cased symbol. A
        // lower-cased query silently forfeits that scoring contribution and the
        // exact match sinks below prefix-sharing neighbours — measured on prod,
        // "sbin" ranked SBIN 5th behind SBINMID150/SBINEQWETF while "SBIN"
        // ranked it 1st. Nothing errors; the right row is just not at the top,
        // or past the caller's limit entirely.
        //
        // The Prisma fallback is genuinely case-insensitive (`mode:
        // "insensitive"` on both symbol and name), so it must NOT be
        // uppercased — `previousSymbols` does its own `.toUpperCase()` where it
        // needs one. Same normalisation as the two web routes.
        //
        // `atlasSearchMfs` is deliberately NOT given this treatment: the MF
        // index maps `schemeName`/`amcName` with `lucene.standard`, which
        // lower-cases at index time, and its only keyword field is the numeric
        // `schemeCode`. There is no casing bug there to fix.
        const atlasHits = await atlasSearchInstruments(
          trimmed.toUpperCase(),
          wantedTypes,
          limit * 4,
        );
        if (atlasHits && atlasHits.length > 0) {
          // Need the instrument IDs (Atlas projection skips _id by default
          // here) - one targeted findMany on the matched symbols, capped to
          // the Atlas hit count so it's a small, fast query.
          const symbols = atlasHits.map((h) => h.symbol);
          const insts = await prisma.instrumentMapping.findMany({
            where: {
              symbol: { in: symbols },
              // MONEY-1263 — Indian venues only. `instrument_mappings` is
              // now shared with the US master (~15,600 active US equities,
              // ~7,600 ETFs), and this surface has no other venue clause.
              // Scoped by EXCHANGE because `market` is ABSENT on every
              // pre-existing India row, so `{market:"IN"}` matches ZERO.
              exchange: { in: [...INDIA_DISCOVER_EXCHANGES] },
              instrumentType: { in: wantedTypes },
              isActive: true,
            },
            select: baseSelect,
          });
          const byKey = new Map(
            insts.map((i) => [`${i.symbol}::${i.exchange}`, i]),
          );
          candidates = atlasHits
            .map((h) => {
              const i = byKey.get(`${h.symbol}::${h.exchange}`);
              if (!i) return null;
              return {
                id: i.id,
                symbol: i.symbol,
                name: i.name,
                exchange: i.exchange,
                sector: i.sector,
                instrumentType: i.instrumentType,
                yahooSymbol: i.yahooSymbol,
                industry: i.industry,
                analysisCount: i.analysisCount ?? 0,
                atlasScore: h.score,
              };
            })
            .filter((c): c is Candidate => c !== null);
        } else {
          const insts = await prisma.instrumentMapping.findMany({
            where: {
              isActive: true,
              // MONEY-1263 — Indian venues only. `instrument_mappings` is
              // now shared with the US master (~15,600 active US equities,
              // ~7,600 ETFs), and this surface has no other venue clause.
              // Scoped by EXCHANGE because `market` is ABSENT on every
              // pre-existing India row, so `{market:"IN"}` matches ZERO.
              exchange: { in: [...INDIA_DISCOVER_EXCHANGES] },
              instrumentType: { in: wantedTypes },
              OR: [
                { symbol: { contains: trimmed, mode: "insensitive" } },
                { name: { contains: trimmed, mode: "insensitive" } },
                // MONEY-1177 — a retired ticker still finds its company
                // (ZOMATO -> ETERNAL). Exact element match, mirroring the
                // indexed `previousSymbols` lookup; users type the whole old
                // ticker, not a prefix of it.
                { previousSymbols: { has: trimmed.toUpperCase() } },
              ],
            },
            select: baseSelect,
            orderBy: { analysisCount: "desc" },
            take: limit * 4,
          });
          candidates = insts.map((i) => ({
            id: i.id,
            symbol: i.symbol,
            name: i.name,
            exchange: i.exchange,
            sector: i.sector,
            instrumentType: i.instrumentType,
            yahooSymbol: i.yahooSymbol,
            industry: i.industry,
            analysisCount: i.analysisCount ?? 0,
            atlasScore: 0,
          }));
        }
      } else {
        // POPULAR PATH (empty query). Anchor on POPULAR_STOCK_LIST first
        // (~30 symbols → tiny query), then back-fill with analysisCount-
        // ordered rows so we still have `limit` candidates if the list
        // doesn't fully resolve in this DB. NO unbounded findMany - that's
        // what was hanging on EC2.
        const anchorList =
          kind === "stocks"
            ? POPULAR_STOCK_LIST
            : []; /* ETFs have no curated list yet */

        const anchored = anchorList.length
          ? await prisma.instrumentMapping.findMany({
              where: {
                symbol: { in: anchorList },
                isActive: true,
                // MONEY-1263 — Indian venues only. `instrument_mappings` is
                // now shared with the US master (~15,600 active US equities,
                // ~7,600 ETFs), and this surface has no other venue clause.
                // Scoped by EXCHANGE because `market` is ABSENT on every
                // pre-existing India row, so `{market:"IN"}` matches ZERO.
                exchange: { in: [...INDIA_DISCOVER_EXCHANGES] },
                instrumentType: { in: wantedTypes },
              },
              select: baseSelect,
            })
          : [];

        // Back-fill: top-N by analysisCount that aren't already anchored.
        // This is bounded by `take`, so it's fast on EC2 too.
        const anchoredIds = new Set(anchored.map((i) => i.id));
        const backfill = await prisma.instrumentMapping.findMany({
          where: {
            isActive: true,
            // MONEY-1263 — Indian venues only. `instrument_mappings` is
            // now shared with the US master (~15,600 active US equities,
            // ~7,600 ETFs), and this surface has no other venue clause.
            // Scoped by EXCHANGE because `market` is ABSENT on every
            // pre-existing India row, so `{market:"IN"}` matches ZERO.
            exchange: { in: [...INDIA_DISCOVER_EXCHANGES] },
            instrumentType: { in: wantedTypes },
            id: { notIn: Array.from(anchoredIds) },
          },
          select: baseSelect,
          orderBy: { analysisCount: "desc" },
          take: limit * 3,
        });

        candidates = [...anchored, ...backfill].map((i) => ({
          id: i.id,
          symbol: i.symbol,
          name: i.name,
          exchange: i.exchange,
          sector: i.sector,
          instrumentType: i.instrumentType,
          yahooSymbol: i.yahooSymbol,
          industry: i.industry,
          analysisCount: i.analysisCount ?? 0,
          atlasScore: 0,
        }));
      }

      // Enrich with LatestQuote in one bounded findMany (candidates is at
      // most a few dozen rows now). Drop bonds (price <= 0). Apply the
      // composite sort: list rank → analysisCount → relevance → MCap.
      const candidateIds = candidates.map((c) => c.id);
      const quotes = candidateIds.length
        ? await prisma.latestQuote.findMany({
            where: { instrumentId: { in: candidateIds } },
          })
        : [];
      const quoteByInstId = new Map(quotes.map((q) => [q.instrumentId, q]));

      const enriched: Array<RichSearchStockResult & { _rank: number[] }> =
        candidates
          .map((c) => {
            const q = quoteByInstId.get(c.id);
            if (!q || q.price <= 0) return null;
            const listRank = POPULAR_RANK.has(c.symbol)
              ? POPULAR_RANK.get(c.symbol)!
              : Number.MAX_SAFE_INTEGER;
            const rank = [
              listRank, // 1. curated list position (asc)
              -c.analysisCount, // 2. -analysisCount (high counts lead)
              trimmed
                ? -c.atlasScore || relevanceScore(c.symbol, c.name, trimmed)
                : 0, // 3. relevance (search only)
              -(q.marketCap ?? 0), // 4. -MCap tiebreaker
            ];
            return {
              symbol: c.symbol,
              name: c.name,
              exchange: c.exchange,
              sector: c.sector,
              instrumentType: c.instrumentType,
              yahooSymbol: c.yahooSymbol,
              price: q.price,
              change: q.change ?? 0,
              changePercent: q.changePercent ?? 0,
              marketCap: q.marketCap ?? null,
              benchmark: c.industry,
              liquidity: mapVolumeToLiquidity(q.volume ?? null),
              _rank: rank,
            };
          })
          .filter(
            (r): r is RichSearchStockResult & { _rank: number[] } => r !== null,
          );

      enriched.sort((a, b) => {
        for (let i = 0; i < a._rank.length; i++) {
          const ar = a._rank[i] ?? 0;
          const br = b._rank[i] ?? 0;
          if (ar !== br) return ar - br;
        }
        return a.symbol.localeCompare(b.symbol);
      });

      // Dedup by (symbol, exchange). InstrumentMapping has occasional
      // duplicate rows for the same listing (legacy isActive entries that
      // weren't tombstoned), and the Atlas hit-list can also re-issue a
      // symbol when fuzzy matching across multiple `path` clauses scores
      // it twice. Keep the first occurrence (which is already best-ranked
      // by the sort above).
      const seen = new Set<string>();
      const rows: RichSearchStockResult[] = [];
      for (const e of enriched) {
        const key = `${e.symbol}::${e.exchange}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { _rank: _, ...rest } = e;
        rows.push(rest);
        if (rows.length >= limit) break;
      }

      const result: RichSearchResult = {
        stocks: kind === "stocks" ? rows : [],
        mfs: [],
        etfs: kind === "etfs" ? rows : [],
      };
      await setCached("discover", "_global", "rich-search-v6", result, {
        q: trimmed,
        kind,
        limit,
      });
      return { success: true, data: result };
    }

    // Mutual funds - Atlas Search first (fuzzy + autocomplete on schemeName
    // / amcName / category / schemeCode), fall back to Prisma `contains`
    // when Atlas is unavailable. Empty-query path skips Atlas (it needs
    // a query) and orders by AUM directly.
    type MfCarrier = {
      schemeCode: string;
      schemeName: string;
      amcName: string | null;
      category: string | null;
      nav: number;
      aum: number | null;
      riskLevel: string | null;
      returns1Y: number | null;
      returns3Y: number | null;
      returns5Y: number | null;
    };
    let funds: MfCarrier[] = [];

    if (trimmed) {
      const atlasHits = await atlasSearchMfs(trimmed, limit * 2);
      if (atlasHits && atlasHits.length > 0) {
        funds = atlasHits.map((h) => ({
          schemeCode: h.schemeCode,
          schemeName: h.schemeName,
          amcName: h.amcName ?? null,
          category: h.category ?? null,
          nav: h.nav,
          aum: h.aum ?? null,
          riskLevel: h.riskLevel ?? null,
          returns1Y: h.returns1Y ?? null,
          returns3Y: h.returns3Y ?? null,
          returns5Y: h.returns5Y ?? null,
        }));
      } else {
        funds = await prisma.mutualFundMaster.findMany({
          where: {
            isActive: true,
            OR: [
              { schemeName: { contains: trimmed, mode: "insensitive" } },
              { amcName: { contains: trimmed, mode: "insensitive" } },
              { schemeCode: { equals: trimmed } },
            ],
          },
          select: {
            schemeCode: true,
            schemeName: true,
            amcName: true,
            category: true,
            nav: true,
            aum: true,
            riskLevel: true,
            returns1Y: true,
            returns3Y: true,
            returns5Y: true,
          },
          take: limit * 2,
        });
      }
    } else {
      funds = await prisma.mutualFundMaster.findMany({
        where: { isActive: true },
        select: {
          schemeCode: true,
          schemeName: true,
          amcName: true,
          category: true,
          nav: true,
          aum: true,
          riskLevel: true,
          returns1Y: true,
          returns3Y: true,
          returns5Y: true,
        },
        orderBy: { aum: "desc" },
        take: limit,
      });
    }

    // Final ordering: AUM desc (popular = biggest funds). Atlas hits keep
    // their relevance order naturally, but we still re-sort by AUM as a
    // tiebreaker so two equally-relevant funds favour the larger one.
    funds.sort((a, b) => (b.aum ?? 0) - (a.aum ?? 0));

    // Dedup by schemeCode (AMFI guarantees uniqueness, but Atlas can
    // double-emit a hit when fuzzy matching across name + amc + category).
    const seenMf = new Set<string>();
    funds = funds.filter((f) => {
      if (seenMf.has(f.schemeCode)) return false;
      seenMf.add(f.schemeCode);
      return true;
    });
    funds = funds.slice(0, limit);

    const mfRows: RichSearchMfResult[] = funds.map((f) => ({
      schemeCode: f.schemeCode,
      schemeName: f.schemeName,
      amcName: f.amcName,
      category: f.category,
      nav: f.nav,
      // Approximate today-change from a 12m → 1d annualisation. The chip
      // is "vibes"-grade; the real returns columns drive the rest.
      changePercent: f.returns1Y ? f.returns1Y / 252 : 0,
      aum: f.aum,
      rating: mapRiskToRating(f.riskLevel),
      returns1Y: f.returns1Y,
    }));

    const result: RichSearchResult = {
      stocks: [],
      mfs: mfRows,
      etfs: [],
    };
    await setCached("discover", "_global", "rich-search-v6", result, {
      q: trimmed,
      kind,
      limit,
    });
    return { success: true, data: result };
  } catch (error) {
    logger.error(
      { error, kind, query: trimmed },
      "richSearchInstruments error",
    );
    return { success: true, data: empty };
  }
}
