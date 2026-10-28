"use server";

/**
 * Stock Screener Server Action (MONEY-196 + MONEY-243 pagination).
 *
 * Three query paths, all returning a `PagedResult<ScreenResult>`:
 *
 * 1. **No search, no fundamental filter** → InstrumentMapping-first. NSE
 *    and BSE EQUITY rows are equally first-class - every stock with a
 *    LatestQuote shows up regardless of `StockRatios` coverage. This is
 *    the "browse the full universe" mode that matches the Discover page
 *    pattern (~7000 instruments paginated 25/page).
 *
 * 2. **No search, fundamental filter active** → StockRatios-first. The
 *    indexed `pe / roe / marketCap` fields make filtered fundamental
 *    queries fast. Stocks lacking ratios drop out - that's the right
 *    behaviour: "P/E < 25" implicitly requires a P/E.
 *
 * 3. **With search query** → InstrumentMapping-first, left-join ratios.
 *    Users find "Aarti Industries" even if its ratios aren't synced.
 *
 * The server scores ALL matching rows, applies the user's sort, then
 * slices the requested page.
 *
 * ## Caching (MONEY-1131)
 *
 * TWO tiers, both keyed on `{filters, query, sort}` — never on the page:
 *
 *   1. **Page entries** (`…:p{page}x{size}`) hold `{rows, total}` for ONE page.
 *      This is what every request reads first. Before this existed, handing
 *      back 25 rows meant a Redis GET plus a `JSON.parse` of the FULL ranked
 *      array — ~7,400 stock rows / ~14k MF rows — on every page-2 click, every
 *      sort flip and every SSR render.
 *   2. **The full ranked list** (the original key, byte-identical shape and
 *      identifier) stays as the compute-once backing store, so a page miss
 *      slices an existing array instead of re-running the DB path.
 *
 * `rows` is literally `ranked.slice(start, start + pageSize)` and `total` is
 * `ranked.length`, exactly as before — the page entry is a memo of the slice,
 * never a second source of truth.
 *
 * Resolution of tier 2 is wrapped in `singleFlight` so N concurrent misses on
 * the same key run ONE DB path instead of N.
 *
 * Pure match-score logic lives in lib/screener/match-score.ts for unit
 * testing - server-action files can't be imported by node:test.
 *
 * Design source: design-system/ui_kits/app/Discover.jsx:137-209 (PageScreener)
 */

import { prisma } from "@usemoney/database";
import type { ServiceResult } from "@usemoney/services";
import { getCached, setCached } from "@usemoney/core";
// Subpath, NOT the root barrel: several suites replace `@usemoney/core` in the
// require cache with a hand-written stub that models only `getCached`/
// `setCached`, so a root-barrel import of `singleFlight` resolves to
// `undefined` at call time in those tests.
import { singleFlight } from "@usemoney/core/cache";
import { resolveIndexFilter } from "@/lib/screener/index-constituents";
import {
  extractEtfFundHouse,
  deriveEtfCategory,
  deriveEtfAssetClass,
} from "@/lib/screener/etf-derive";

/**
 * Sector predicate + its DB-side twin (MONEY-1131 pushdown, MONEY-1157 fold).
 *
 * These were a local pair here and a byte-identical local pair in
 * `packages/services/src/screener.service.ts`, each carrying a comment saying to
 * keep the other in lockstep. They WERE in lockstep — with each other. What
 * they drifted from was the FACETS: `buildSectorFacets` learned to fold
 * `Construction` onto Industrials and `Textiles` onto Consumer Discretionary
 * via the taxonomy, while both copies of this predicate kept comparing the RAW
 * stored string. The chips then over-reported by ~285 rows on prod (Industrials
 * +40, Consumer Discretionary +8, Not Categorised +242) — counted under a chip,
 * never returned by it, and exactly so, because `instrumentsFirstPath` screens
 * the very array the counts were built from.
 *
 * One definition now, in the taxonomy that owns the fold. Subpath import, NOT
 * the `@usemoney/core` root barrel — several suites replace the barrel in the
 * require cache with a `getCached`/`setCached`-only stub (same reason
 * `singleFlight` is imported from `@usemoney/core/cache` above).
 *
 * `@usemoney/core/sector-taxonomy` documents the branches, including why the DB
 * clause must be a SUPERSET of the predicate (the JS pass below stays the
 * authority and cannot rescue rows the database never returned) and why
 * `{ sector: { isSet: false } }` is load-bearing rather than redundant with
 * `{ sector: null }`.
 */
import {
  matchesSectorFacet as sectorMatches,
  sectorFacetInstrumentWhere as sectorInstrumentFilter,
} from "@usemoney/core/sector-taxonomy";

/**
 * Resolve the screener `index` filter into a symbol allow-list.
 *
 * Lookup order:
 *
 *   1. `IndexConstituent` table - populated weekly by the
 *      `index-constituent-sync` worker (Cloud Scheduler Sunday
 *      03:00 IST). Authoritative when present.
 *   2. Static fallback - hardcoded Nifty 50 / Bank Nifty / Nifty IT
 *      arrays in `index-constituents.ts`. Used when the table is
 *      empty for that index id (cold start, before first sync).
 *   3. Mcap-rank fallback - derive Nifty 100 / 500 / Midcap 150 /
 *      Smallcap 250 from the local `StockRatios.marketCap` ordering.
 *      Approximation of NSE's free-float methodology.
 *
 * Returns null for "all" / undefined - caller skips the filter.
 */
async function resolveIndexSymbols(
  indexId: string | undefined
): Promise<readonly string[] | null> {
  if (!indexId || indexId === "all") return null;

  // Step 1: prefer DB-backed constituents.
  try {
    const dbRows = await prisma.indexConstituent.findMany({
      where: { indexId },
      orderBy: { rank: "asc" },
      select: { symbol: true },
    });
    if (dbRows.length > 0) return dbRows.map((r) => r.symbol);
  } catch {
    // Table may not exist yet on first deploy - fall through.
  }

  // Steps 2 + 3: static / sector / mcap-rank fallback in the shared resolver.
  const resolved = resolveIndexFilter(indexId);
  if (resolved.kind === "all") return null;
  if (resolved.kind === "static") return resolved.symbols ?? null;
  if (resolved.kind === "sector" && resolved.sector) {
    // Sectoral indexes resolve against the InstrumentMapping.sector
    // taxonomy (Information Technology, Healthcare, FMCG, etc.) so we
    // don't have to maintain a long static list for every sector. New
    // listings tagged into the sector inherit the index automatically.
    const tagged = await prisma.instrumentMapping.findMany({
      where: {
        sector: resolved.sector,
        isActive: true,
        instrumentType: "EQUITY",
      },
      select: { symbol: true },
    });
    return tagged.map((r) => r.symbol);
  }
  if (resolved.kind === "mcap-rank" && resolved.rank) {
    const { start, end } = resolved.rank;
    const ranked = await prisma.stockRatios.findMany({
      where: { marketCap: { not: null } },
      orderBy: { marketCap: "desc" },
      skip: Math.max(0, start - 1),
      take: Math.max(0, end - start + 1),
      select: { symbol: true },
    });
    return ranked.map((r) => r.symbol);
  }
  return null;
}
import {
  buildEtfScreenWhere,
  buildMfScreenWhere,
  computeEtfMatchScore,
  computeMatchScore,
  computeMfMatchScore,
  resolveMarketCapRange,
  type ScreenFilters,
  type MfScreenFilters,
  type EtfScreenFilters,
} from "@/lib/screener/match-score";

// ============== TYPES ==============

export type {
  ScreenFilters,
  MarketCapBucket,
  MfScreenFilters,
  EtfScreenFilters,
} from "@/lib/screener/match-score";

export interface ScreenResult {
  symbol: string;
  exchange: string;
  name: string;
  sector: string | null;
  ltp: number | null;
  changePercent: number | null;
  marketCap: number | null; // crores
  pe: number | null;
  roe: number | null; // percentage
  revenueGrowth: number | null; // YoY %
  debtToEquity: number | null;
  /** 0–100 composite match score. 100 means every filter is perfectly met. */
  matchScore: number;
}

/** Sort key passed by the client. Mirrors the SortDropdown options.
 *  Server applies the sort before pagination so page boundaries are
 *  stable across pagination clicks. */
export type StockSortKey =
  | "match"
  | "mcap-desc"
  | "mcap-asc"
  | "change-desc"
  | "change-asc"
  | "name-asc"
  | "name-desc";

/** Sort key for the funds tabs (MF + ETF share the same shape). */
export type FundSortKey =
  | "match"
  | "nav-desc"
  | "nav-asc"
  | "aum-desc"
  | "ret1y-desc"
  | "ret3y-desc"
  | "ret5y-desc";

/** Pagination opts shared across all three actions. `pageSize` defaults
 *  to 25 (matches the table density used in the design); `page` is
 *  0-indexed. `sort` defaults to "match" - the legacy behaviour. */
export interface PageOpts {
  page?: number;
  pageSize?: number;
  sort?: StockSortKey | FundSortKey;
}

/** Page envelope returned by every screener action. `total` is the
 *  matched-set size BEFORE pagination - used by the client to render
 *  "Showing 1–25 of 4,744 stocks" + the page number row. */
export interface PagedResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Default page size - matches `PAGE_SIZE` constant on the client side. */
const DEFAULT_PAGE_SIZE = 25;
/** Hard ceiling - anything above this gets clamped. Prevents accidental
 *  full-set fetches if a caller forgets pagination. */
const MAX_PAGE_SIZE = 200;

/** Cache module + scope every screener entry lives under. */
const CACHE_NS = "discover" as const;
const CACHE_SCOPE = "_global";
const CACHE_TTL_SECONDS = 5 * 60;

/**
 * Page entries expire faster than the ranked list they were sliced from, and
 * that asymmetry is deliberate.
 *
 * The two tiers are written at DIFFERENT times: the list when it is computed,
 * a page whenever someone first asks for it. So a page written late in the
 * list's life outlives it. Once the list expires and is recomputed against
 * fresher prices, surviving page entries still hold slices — and a `total` —
 * from the PREVIOUS ranking. During that overlap a user paging through results
 * can see a row twice, miss one entirely, or watch the "of N" denominator
 * change as they page. None of that was possible when a single entry with a
 * single expiry backed every page.
 *
 * A short page TTL bounds the overlap to at most this value (~60 s) instead of
 * the full 5 minutes, while keeping the win the page tier exists for: not
 * re-parsing a multi-megabyte ranked array out of Redis on every page click.
 * The list is the compute-once backing store and keeps the longer TTL, so a
 * page miss is still a cheap in-memory slice, not a database round trip.
 *
 * Eliminating the skew outright means versioning the page key by the list's
 * creation stamp; that is the right fix if this ever needs to be exact, and it
 * costs an extra read to learn the stamp.
 */
const PAGE_CACHE_TTL_SECONDS = 60;

/** One page of a ranked list, plus the matched-set size it was sliced from. */
interface CachedPage<T> {
  rows: T[];
  total: number;
}

/** Page entry key. Derived from — never replacing — the full-list key, so the
 *  two tiers can never drift onto different filter/sort identities. */
function pageKeyFor(listKey: string, page: number, pageSize: number): string {
  return `${listKey}:p${page}x${pageSize}`;
}

async function readPage<T>(
  listKey: string,
  page: number,
  pageSize: number
): Promise<CachedPage<T> | null> {
  return getCached<CachedPage<T>>(
    CACHE_NS,
    CACHE_SCOPE,
    pageKeyFor(listKey, page, pageSize),
    undefined,
    { ttl: PAGE_CACHE_TTL_SECONDS }
  );
}

async function writePage<T>(
  listKey: string,
  page: number,
  pageSize: number,
  value: CachedPage<T>
): Promise<void> {
  await setCached(
    CACHE_NS,
    CACHE_SCOPE,
    pageKeyFor(listKey, page, pageSize),
    value,
    undefined,
    { ttl: PAGE_CACHE_TTL_SECONDS }
  );
}

/**
 * Resolve the full ranked list for `listKey`: cache first, else compute once.
 *
 * `singleFlight` is keyed on the same identifier as the cache entry, so a burst
 * of concurrent misses (SSR + the client's own fetch + a second tab) collapses
 * to ONE execution of `compute` rather than N full scans.
 */
async function resolveRankedList<T>(
  flightPrefix: string,
  listKey: string,
  compute: () => Promise<T[]>
): Promise<T[]> {
  const cached = await getCached<T[]>(
    CACHE_NS,
    CACHE_SCOPE,
    listKey,
    undefined,
    { ttl: CACHE_TTL_SECONDS }
  );
  if (cached) return cached;

  return singleFlight(`${flightPrefix}:${listKey}`, async () => {
    // Re-read inside the flight — the request we queued behind may have just
    // populated it.
    const again = await getCached<T[]>(
      CACHE_NS,
      CACHE_SCOPE,
      listKey,
      undefined,
      { ttl: CACHE_TTL_SECONDS }
    );
    if (again) return again;

    const fresh = await compute();
    await setCached(CACHE_NS, CACHE_SCOPE, listKey, fresh, undefined, {
      ttl: CACHE_TTL_SECONDS,
    });
    return fresh;
  });
}

/** Slice + memoise. The returned envelope is exactly what the un-cached path
 *  produced before MONEY-1131 — the page entry only skips re-deriving it. */
async function pageFromRanked<T>(
  listKey: string,
  ranked: T[],
  page: number,
  pageSize: number
): Promise<PagedResult<T>> {
  const start = page * pageSize;
  const rows = ranked.slice(start, start + pageSize);
  const total = ranked.length;
  await writePage<T>(listKey, page, pageSize, { rows, total });
  return { rows, total, page, pageSize };
}

/** Row shape returned by `screenEtfsAction`. Mirrors the ETF results
 *  table columns (Ticker · NAV · Δ · AUM · 1Y · Exp · Asset class · Match). */
export interface EtfScreenResult {
  symbol: string;
  exchange: string;
  name: string;
  yahooSymbol: string;
  ltp: number | null;
  changePercent: number | null;
  aum: number | null;
  returns1Y: number | null;
  expenseRatio: number | null;
  assetClass: string | null;
  /** 0-100 composite match score. */
  matchScore: number;
}

/** Row shape returned by `screenMfsAction`. Mirrors the MF results table
 *  columns in the design (Scheme · AMC · NAV · 1Y/3Y/5Y · AUM · Match). */
export interface MfScreenResult {
  schemeCode: string;
  schemeName: string;
  amcName: string;
  category: string;
  plan: string | null;
  fundType: string | null;
  riskLevel: string | null;
  nav: number;
  navDate: Date;
  aum: number | null;
  returns1Y: number | null;
  returns3Y: number | null;
  returns5Y: number | null;
  expenseRatio: number | null;
  /** 0–100 composite match score. */
  matchScore: number;
}

// ============== MAIN ACTION ==============

/** Sort the ranked array in place by the requested key. Match-score
 *  ordering is the default; the rest map 1:1 with the SortDropdown. */
function applyStockSort(rows: ScreenResult[], sort: StockSortKey): void {
  switch (sort) {
    case "mcap-desc":
      rows.sort(
        (a, b) => (b.marketCap ?? -Infinity) - (a.marketCap ?? -Infinity)
      );
      break;
    case "mcap-asc":
      rows.sort(
        (a, b) => (a.marketCap ?? Infinity) - (b.marketCap ?? Infinity)
      );
      break;
    case "change-desc":
      rows.sort(
        (a, b) =>
          (b.changePercent ?? -Infinity) - (a.changePercent ?? -Infinity)
      );
      break;
    case "change-asc":
      rows.sort(
        (a, b) => (a.changePercent ?? Infinity) - (b.changePercent ?? Infinity)
      );
      break;
    case "name-asc":
      rows.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "name-desc":
      rows.sort((a, b) => b.name.localeCompare(a.name));
      break;
    case "match":
    default:
      rows.sort((a, b) => b.matchScore - a.matchScore);
      break;
  }
}

export async function screenStocksAction(
  filters: ScreenFilters = {},
  query?: string,
  paging: PageOpts = {}
): Promise<ServiceResult<PagedResult<ScreenResult>>> {
  const trimmedQuery = query?.trim() ?? "";
  const page = Math.max(0, paging.page ?? 0);
  const pageSize = Math.min(
    Math.max(1, paging.pageSize ?? DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  );
  const sort = (paging.sort as StockSortKey | undefined) ?? "match";

  try {
    // Cache identity intentionally OMITS page - the full ranked list is
    // computed once per {filters,query,sort} and every page is a slice of it.
    const cacheIdent = JSON.stringify({
      ...filters,
      q: trimmedQuery,
      sort,
    });
    const listKey = `screener:v3:${cacheIdent}`;

    // Tier 1: the 25-row page entry. The overwhelming majority of requests
    // (SSR page 0, pagination clicks, sort flips) end here, reading kilobytes
    // instead of the whole ranked universe.
    const cachedPage = await readPage<ScreenResult>(listKey, page, pageSize);
    if (cachedPage) {
      return {
        success: true,
        data: {
          rows: cachedPage.rows,
          total: cachedPage.total,
          page,
          pageSize,
        },
      };
    }

    // Tier 2: the full ranked list — cache-first, single-flighted.
    const ranked = await resolveRankedList<ScreenResult>(
      "screener:stocks",
      listKey,
      async () => {
        const fresh = trimmedQuery
          ? await searchFirstPath(filters, trimmedQuery)
          : await filterFirstPath(filters);
        applyStockSort(fresh, sort);
        return fresh;
      }
    );

    return {
      success: true,
      data: await pageFromRanked(listKey, ranked, page, pageSize),
    };
  } catch (error) {
    console.error("screenStocksAction error:", error);
    return {
      success: false,
      error: "Failed to run screener",
    };
  }
}

// ============== PATH 1: NO SEARCH - fundamental-aware dispatch ==============

/** Returns true when the user has set any filter that lives on
 *  `StockRatios` (P/E, ROE, revenue growth, D/E, market cap). When any
 *  is active we go straight to the indexed StockRatios query - it's
 *  much faster than scanning the full 7000+ instrument set. */
function hasFundamentalFilter(filters: ScreenFilters): boolean {
  return (
    filters.minPe != null ||
    filters.maxPe != null ||
    filters.minRoe != null ||
    filters.maxRoe != null ||
    filters.minRevenueGrowth != null ||
    filters.maxRevenueGrowth != null ||
    filters.minDebtToEquity != null ||
    filters.maxDebtToEquity != null ||
    filters.marketCapBucket != null ||
    filters.minMarketCap != null ||
    filters.maxMarketCap != null ||
    filters.minDividendYield != null ||
    filters.maxDividendYield != null
  );
}

async function filterFirstPath(
  filters: ScreenFilters
): Promise<ScreenResult[]> {
  // When the user has fundamental filters we *must* use the StockRatios
  // path - those filters require the data - so the indexed query is
  // both correct and fast. Otherwise, default to the full instrument
  // universe so NSE + BSE rows are equally first-class regardless of
  // ratios coverage.
  if (hasFundamentalFilter(filters)) {
    return ratiosFirstPath(filters);
  }
  return instrumentsFirstPath(filters);
}

// ── 1a. Ratios-first (fundamental filters present) ───────────────────

async function ratiosFirstPath(
  filters: ScreenFilters
): Promise<ScreenResult[]> {
  const { min: effectiveMinMcap, max: effectiveMaxMcap } =
    resolveMarketCapRange(filters);

  // Mongo filter on StockRatios - leverages existing indexes on
  // pe / roe / marketCap. Each condition is AND-combined.
  const ratioWhere: Record<string, unknown> = {};
  if (filters.minPe != null || filters.maxPe != null) {
    ratioWhere.pe = {
      ...(filters.minPe != null ? { gte: filters.minPe } : {}),
      ...(filters.maxPe != null ? { lte: filters.maxPe } : {}),
    };
  }
  if (filters.minRoe != null || filters.maxRoe != null) {
    ratioWhere.roe = {
      ...(filters.minRoe != null ? { gte: filters.minRoe } : {}),
      ...(filters.maxRoe != null ? { lte: filters.maxRoe } : {}),
    };
  }
  if (filters.minRevenueGrowth != null || filters.maxRevenueGrowth != null) {
    ratioWhere.revenueGrowth = {
      ...(filters.minRevenueGrowth != null
        ? { gte: filters.minRevenueGrowth }
        : {}),
      ...(filters.maxRevenueGrowth != null
        ? { lte: filters.maxRevenueGrowth }
        : {}),
    };
  }
  if (filters.minDebtToEquity != null || filters.maxDebtToEquity != null) {
    ratioWhere.debtToEquity = {
      ...(filters.minDebtToEquity != null
        ? { gte: filters.minDebtToEquity }
        : {}),
      ...(filters.maxDebtToEquity != null
        ? { lte: filters.maxDebtToEquity }
        : {}),
    };
  }
  if (filters.minDividendYield != null || filters.maxDividendYield != null) {
    ratioWhere.dividendYield = {
      ...(filters.minDividendYield != null
        ? { gte: filters.minDividendYield }
        : {}),
      ...(filters.maxDividendYield != null
        ? { lte: filters.maxDividendYield }
        : {}),
    };
  }
  if (effectiveMinMcap != null || effectiveMaxMcap != null) {
    ratioWhere.marketCap = {
      ...(effectiveMinMcap != null ? { gte: effectiveMinMcap } : {}),
      ...(effectiveMaxMcap != null ? { lte: effectiveMaxMcap } : {}),
    };
  }
  if (filters.exchange) {
    ratioWhere.exchange = filters.exchange;
  }

  // Index filter (UniverseSection) - applied as a `symbol IN (...)`
  // clause built from the static or market-cap-rank constituent map.
  // Returning [] short-circuits to "no rows" without hammering Mongo.
  const indexSymbols = await resolveIndexSymbols(filters.index);
  if (indexSymbols !== null) {
    if (indexSymbols.length === 0) return [];
    ratioWhere.symbol = { in: indexSymbols };
  }

  // MONEY-1131 - sector is pushed into the query instead of being applied to
  // the whole banded result set in Node. `instrument` is a REQUIRED to-one
  // relation, so `is` is the correct relation-filter form here.
  const sectorFilter = sectorInstrumentFilter(filters.sector);
  if (sectorFilter) {
    ratioWhere.instrument = { is: sectorFilter };
  }

  const ratios = await prisma.stockRatios.findMany({
    where: ratioWhere,
    orderBy: { marketCap: "desc" },
    select: {
      symbol: true,
      exchange: true,
      pe: true,
      roe: true,
      revenueGrowth: true,
      debtToEquity: true,
      marketCap: true,
      dividendYield: true,
      instrument: {
        select: {
          name: true,
          sector: true,
          latestQuote: {
            select: {
              price: true,
              changePercent: true,
            },
          },
        },
      },
    },
  });

  // `sectorMatches` remains the AUTHORITY on what the chip means, and stays a
  // final pass over the (now already narrowed) rows. Keeping it is deliberate:
  // the DB clause above can only ever be equal or LOOSER, so the visible result
  // set is provably unchanged by the pushdown — it is a transport optimisation,
  // not a semantics change. On a narrowed set this loop is free.
  const filtered = filters.sector
    ? ratios.filter((r) => sectorMatches(r.instrument?.sector, filters.sector))
    : ratios;

  return filtered.map((r) => ({
    symbol: r.symbol,
    exchange: r.exchange,
    name: r.instrument?.name ?? r.symbol,
    sector: r.instrument?.sector ?? null,
    ltp: r.instrument?.latestQuote?.price ?? null,
    changePercent: r.instrument?.latestQuote?.changePercent ?? null,
    marketCap: r.marketCap,
    pe: r.pe,
    roe: r.roe,
    revenueGrowth: r.revenueGrowth,
    debtToEquity: r.debtToEquity,
    matchScore: computeMatchScore(r, filters),
  }));
}

// ── 1b. Instruments-first (no fundamental filters - full universe) ───

/** Common shape used by both the Discover-service path and the
 *  InstrumentMapping fallback path. Only the fields the screener
 *  actually reads - keeps the union narrow and predictable. */
interface UniverseRow {
  instrumentId: string;
  symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  price: number | null;
  changePercent: number | null;
}

async function instrumentsFirstPath(
  filters: ScreenFilters
): Promise<ScreenResult[]> {
  // Primary: Discover service's `allStocks`. Mirrors the Discover page's
  // exact universe (instruments with a LatestQuote that pass MF-name
  // guards) so the screener and Discover stay aligned.
  const { getDiscoverData } = await import("@usemoney/services");
  const discover = await getDiscoverData();
  let stocks: UniverseRow[] =
    discover.success && discover.data
      ? discover.data.allStocks.map((s) => ({
          instrumentId: s.instrumentId,
          symbol: s.symbol,
          name: s.name,
          exchange: s.exchange,
          sector: s.sector ?? null,
          price: s.price,
          changePercent: s.changePercent,
        }))
      : [];

  // Fallback: dev environments often lack LatestQuote coverage, which
  // makes `allStocks` empty. In that case fall back to InstrumentMapping
  // directly so the screener still has rows to show. Joins LatestQuote
  // optionally - rows without a quote render with `null` LTP/Δ.
  if (stocks.length === 0) {
    stocks = await fallbackInstrumentUniverse();
  }

  if (filters.exchange) {
    stocks = stocks.filter((s) => s.exchange === filters.exchange);
  }
  if (filters.sector) {
    stocks = stocks.filter((s) => sectorMatches(s.sector, filters.sector));
  }
  // Index filter (parallel to the ratios-first + search-first paths).
  // Without this, picking "Nifty 50" with no fundamental filter active
  // routes through this path and silently shows the full universe
  // (image #84 - 2,608 NSE stocks instead of the 50 Nifty constituents).
  const indexSymbolsForInstUniverse = await resolveIndexSymbols(filters.index);
  if (indexSymbolsForInstUniverse !== null) {
    if (indexSymbolsForInstUniverse.length === 0) return [];
    const allow = new Set(indexSymbolsForInstUniverse);
    stocks = stocks.filter((s) => allow.has(s.symbol));
  }
  if (stocks.length === 0) return [];

  // Pull ratios for the matched instruments in a single round-trip.
  // The id list is bounded by the universe size (~7-8k) - well within
  // MongoDB's `$in` limits on both Atlas and DigitalOcean.
  const ids = stocks.map((s) => s.instrumentId);
  const ratios = await prisma.stockRatios.findMany({
    where: { instrumentId: { in: ids } },
    select: {
      instrumentId: true,
      pe: true,
      roe: true,
      revenueGrowth: true,
      debtToEquity: true,
      marketCap: true,
    },
  });
  const ratioMap = new Map(ratios.map((r) => [r.instrumentId, r]));

  return stocks.map((s) => {
    const r = ratioMap.get(s.instrumentId);
    return {
      symbol: s.symbol,
      exchange: s.exchange,
      name: s.name,
      sector: s.sector ?? null,
      ltp: s.price,
      changePercent: s.changePercent,
      marketCap: r?.marketCap ?? null,
      pe: r?.pe ?? null,
      roe: r?.roe ?? null,
      revenueGrowth: r?.revenueGrowth ?? null,
      debtToEquity: r?.debtToEquity ?? null,
      // No fundamental filters → every row is a perfect match (100).
      matchScore: 100,
    };
  });
}

/** Fallback universe builder for envs where LatestQuote is sparse.
 *  Returns `UniverseRow` directly so the caller can stay type-clean
 *  whether it came from Discover service or this fallback. */
async function fallbackInstrumentUniverse(): Promise<UniverseRow[]> {
  const instruments = await prisma.instrumentMapping.findMany({
    where: {
      isActive: true,
      instrumentType: "EQUITY",
      exchange: { in: ["NSE", "BSE"] },
    },
    select: {
      id: true,
      symbol: true,
      name: true,
      exchange: true,
      sector: true,
    },
  });

  // Filter out MF-named instruments (mirrors Discover service's guard).
  const filtered = instruments.filter((inst) => {
    const n = inst.name.toUpperCase();
    return (
      !n.includes("MUTUAL FUND") &&
      !n.includes("MF -") &&
      !n.includes("MUTUAL FD")
    );
  });

  // Best-effort LatestQuote join - if the table is empty or partial we
  // still return rows with null price.
  const quoteMap = new Map<
    string,
    { price: number; changePercent: number | null }
  >();
  try {
    const quotes = await prisma.latestQuote.findMany({
      select: {
        instrumentId: true,
        price: true,
        changePercent: true,
      },
    });
    for (const q of quotes) {
      quoteMap.set(q.instrumentId, {
        price: q.price,
        changePercent: q.changePercent,
      });
    }
  } catch {
    // ignore - quoteMap stays empty, rows render with null LTP/Δ
  }

  return filtered.map((inst) => {
    const q = quoteMap.get(inst.id);
    return {
      instrumentId: inst.id,
      symbol: inst.symbol,
      name: inst.name,
      exchange: inst.exchange,
      sector: inst.sector ?? null,
      price: q?.price ?? null,
      changePercent: q?.changePercent ?? null,
    };
  });
}

// ============== PATH 2: WITH SEARCH - InstrumentMapping-first ==============

async function searchFirstPath(
  filters: ScreenFilters,
  query: string
): Promise<ScreenResult[]> {
  const qLower = query.toLowerCase();
  const qUpper = query.toUpperCase();

  // Build InstrumentMapping WHERE - symbol startsWith OR name contains.
  // Restrict to EQUITY and honour the exchange filter if set.
  const instrumentWhere: Record<string, unknown> = {
    isActive: true,
    instrumentType: "EQUITY",
    OR: [
      { symbol: { startsWith: qUpper } },
      { name: { contains: query, mode: "insensitive" } },
    ],
  };
  if (filters.exchange) {
    instrumentWhere.exchange = filters.exchange;
  }

  // Index filter (parallel to the ratios-first path).
  const indexSymbolsForInst = await resolveIndexSymbols(filters.index);
  if (indexSymbolsForInst !== null) {
    if (indexSymbolsForInst.length === 0) return [];
    instrumentWhere.symbol = { in: indexSymbolsForInst };
  }

  const instruments = await prisma.instrumentMapping.findMany({
    where: instrumentWhere,
    // Cap candidate set at 200 - search-style UIs don't paginate past this;
    // user should narrow their query if they want more. Ordered by symbol
    // for deterministic results when ranks tie later.
    take: 2000,
    orderBy: { symbol: "asc" },
    select: {
      id: true,
      symbol: true,
      exchange: true,
      name: true,
      sector: true,
      latestQuote: {
        select: {
          price: true,
          changePercent: true,
        },
      },
    },
  });

  if (instruments.length === 0) return [];

  // Left-join ratios via instrumentId in a single follow-up query
  const instIds = instruments.map((i) => i.id);
  const ratios = await prisma.stockRatios.findMany({
    where: { instrumentId: { in: instIds } },
    select: {
      instrumentId: true,
      pe: true,
      roe: true,
      revenueGrowth: true,
      debtToEquity: true,
      marketCap: true,
      dividendYield: true,
    },
  });
  const ratioMap = new Map(ratios.map((r) => [r.instrumentId, r]));

  // Optional sector filter (post-fetch). Same null-aware match as the
  // ratios path so "Not Categorised" reaches the rows with sector NULL.
  const sectorFiltered = filters.sector
    ? instruments.filter((i) => sectorMatches(i.sector, filters.sector))
    : instruments;

  // Optional fundamental filter - drop rows that have ratios AND fail filter;
  // keep rows that have NO ratios (user searching wants them either way).
  const hasAnyFundamentalFilter =
    filters.minPe != null ||
    filters.maxPe != null ||
    filters.minRoe != null ||
    filters.maxRoe != null ||
    filters.minRevenueGrowth != null ||
    filters.maxRevenueGrowth != null ||
    filters.minDebtToEquity != null ||
    filters.maxDebtToEquity != null ||
    filters.marketCapBucket != null ||
    filters.minMarketCap != null ||
    filters.maxMarketCap != null ||
    // MONEY-779: dividend yield was supported in the ratios-first path and
    // hasFundamentalFilter() but silently dropped here, so a dividend-yield
    // filter typed alongside a search query had no effect.
    filters.minDividendYield != null ||
    filters.maxDividendYield != null;

  const { min: effectiveMinMcap, max: effectiveMaxMcap } =
    resolveMarketCapRange(filters);

  const fundamentalFiltered = hasAnyFundamentalFilter
    ? sectorFiltered.filter((inst) => {
        const r = ratioMap.get(inst.id);
        if (!r) return false; // has fundamental filter but no ratios → exclude
        if (filters.minPe != null && (r.pe == null || r.pe < filters.minPe))
          return false;
        if (filters.maxPe != null && (r.pe == null || r.pe > filters.maxPe))
          return false;
        if (filters.minRoe != null && (r.roe == null || r.roe < filters.minRoe))
          return false;
        if (filters.maxRoe != null && (r.roe == null || r.roe > filters.maxRoe))
          return false;
        if (
          filters.minRevenueGrowth != null &&
          (r.revenueGrowth == null ||
            r.revenueGrowth < filters.minRevenueGrowth)
        )
          return false;
        if (
          filters.maxRevenueGrowth != null &&
          (r.revenueGrowth == null ||
            r.revenueGrowth > filters.maxRevenueGrowth)
        )
          return false;
        if (
          filters.minDebtToEquity != null &&
          (r.debtToEquity == null || r.debtToEquity < filters.minDebtToEquity)
        )
          return false;
        if (
          filters.maxDebtToEquity != null &&
          (r.debtToEquity == null || r.debtToEquity > filters.maxDebtToEquity)
        )
          return false;
        if (
          effectiveMinMcap != null &&
          (r.marketCap == null || r.marketCap < effectiveMinMcap)
        )
          return false;
        if (
          effectiveMaxMcap != null &&
          (r.marketCap == null || r.marketCap > effectiveMaxMcap)
        )
          return false;
        if (
          filters.minDividendYield != null &&
          (r.dividendYield == null ||
            r.dividendYield < filters.minDividendYield)
        )
          return false;
        if (
          filters.maxDividendYield != null &&
          (r.dividendYield == null ||
            r.dividendYield > filters.maxDividendYield)
        )
          return false;
        return true;
      })
    : sectorFiltered;

  // Assemble results with search-rank MATCH score
  const scored: ScreenResult[] = fundamentalFiltered.map((inst) => {
    const r = ratioMap.get(inst.id);
    const symLower = inst.symbol.toLowerCase();
    const nameLower = inst.name.toLowerCase();

    // Search rank: exact symbol = 100, name startsWith = 90,
    // symbol startsWith = 85, name contains = 70. Otherwise fall back
    // to filter match score (usually 100 when user just searched).
    let matchScore: number;
    if (symLower === qLower) matchScore = 100;
    else if (nameLower.startsWith(qLower)) matchScore = 90;
    else if (symLower.startsWith(qLower)) matchScore = 85;
    else if (nameLower.includes(qLower)) matchScore = 70;
    else matchScore = r ? computeMatchScore(r, filters) : 50;

    return {
      symbol: inst.symbol,
      exchange: inst.exchange,
      name: inst.name,
      sector: inst.sector ?? null,
      ltp: inst.latestQuote?.price ?? null,
      changePercent: inst.latestQuote?.changePercent ?? null,
      marketCap: r?.marketCap ?? null,
      pe: r?.pe ?? null,
      roe: r?.roe ?? null,
      revenueGrowth: r?.revenueGrowth ?? null,
      debtToEquity: r?.debtToEquity ?? null,
      matchScore,
    };
  });

  // Caller pagination + sort applies - return all matched rows.
  return scored;
}

// ============== MUTUAL FUND SCREENER (MONEY-196) ==============

/** In-place sort by user-selected key. ETFs reuse `nav-*` for their
 *  `ltp` column so this helper handles both row shapes. */
function applyFundSort<
  T extends {
    matchScore: number;
    nav?: number | null;
    ltp?: number | null;
    aum?: number | null;
    returns1Y?: number | null;
    returns3Y?: number | null;
    returns5Y?: number | null;
    schemeName?: string;
    name?: string;
  },
>(rows: T[], sort: FundSortKey): void {
  const num = (v: number | null | undefined): number =>
    v != null && Number.isFinite(v) ? v : 0;
  switch (sort) {
    case "nav-desc":
      rows.sort((a, b) => num(b.nav ?? b.ltp) - num(a.nav ?? a.ltp));
      break;
    case "nav-asc":
      rows.sort((a, b) => num(a.nav ?? a.ltp) - num(b.nav ?? b.ltp));
      break;
    case "aum-desc":
      rows.sort((a, b) => num(b.aum) - num(a.aum));
      break;
    case "ret1y-desc":
      rows.sort((a, b) => num(b.returns1Y) - num(a.returns1Y));
      break;
    case "ret3y-desc":
      rows.sort((a, b) => num(b.returns3Y) - num(a.returns3Y));
      break;
    case "ret5y-desc":
      rows.sort((a, b) => num(b.returns5Y) - num(a.returns5Y));
      break;
    case "match":
    default:
      rows.sort((a, b) => b.matchScore - a.matchScore);
      break;
  }
}

/**
 * Screen mutual funds against the active filter set + optional text query.
 *
 * Source: `MutualFundMaster` (~14k active schemes). Single-table query -
 * no join needed since AUM/returns/expense ratio all live on the same row.
 *
 * Returns a paged envelope. Cache holds the full sorted set; pagination
 * is an in-memory slice on cache hit. 5-min TTL.
 */
export async function screenMfsAction(
  filters: MfScreenFilters = {},
  query?: string,
  paging: PageOpts = {}
): Promise<ServiceResult<PagedResult<MfScreenResult>>> {
  const trimmedQuery = query?.trim() ?? "";
  const page = Math.max(0, paging.page ?? 0);
  const pageSize = Math.min(
    Math.max(1, paging.pageSize ?? DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  );
  const sort = (paging.sort as FundSortKey | undefined) ?? "match";

  try {
    const cacheIdent = JSON.stringify({
      ...filters,
      q: trimmedQuery,
      sort,
    });
    const listKey = `screener-mf:v2:${cacheIdent}`;

    const cachedPage = await readPage<MfScreenResult>(listKey, page, pageSize);
    if (cachedPage) {
      return {
        success: true,
        data: {
          rows: cachedPage.rows,
          total: cachedPage.total,
          page,
          pageSize,
        },
      };
    }

    const ranked = await resolveRankedList<MfScreenResult>(
      "screener:mf",
      listKey,
      async () => {
        // Pure builder so the WHERE shape can be tested directly. Categorical
        // filters use indexed equality; numeric ranges use $gte/$lte; the
        // search term becomes a `schemeName OR amcName` contains-OR. Active
        // funds only.
        const where = buildMfScreenWhere(filters, trimmedQuery);

        // No `take` - the active MF universe is bounded (~14k schemes) and
        // every filter combination narrows it further. We need the full set
        // so the count badge ("Mutual Funds 13,427") and the pagination
        // total are accurate; arbitrary caps would otherwise leak as
        // "10,000 matches" on the badge.
        const candidates = await prisma.mutualFundMaster.findMany({
          where,
          orderBy: [{ aum: "desc" }],
          select: {
            schemeCode: true,
            schemeName: true,
            amcName: true,
            category: true,
            plan: true,
            fundType: true,
            riskLevel: true,
            nav: true,
            navDate: true,
            aum: true,
            returns1Y: true,
            returns3Y: true,
            returns5Y: true,
            expenseRatio: true,
          },
        });

        const fresh: MfScreenResult[] = candidates.map((c) => ({
          schemeCode: c.schemeCode,
          schemeName: c.schemeName,
          amcName: c.amcName,
          category: c.category,
          plan: c.plan,
          fundType: c.fundType,
          riskLevel: c.riskLevel,
          nav: c.nav,
          navDate: c.navDate,
          aum: c.aum,
          returns1Y: c.returns1Y,
          returns3Y: c.returns3Y,
          returns5Y: c.returns5Y,
          expenseRatio: c.expenseRatio,
          matchScore: computeMfMatchScore(c, filters),
        }));
        applyFundSort(fresh, sort);
        return fresh;
      }
    );

    return {
      success: true,
      data: await pageFromRanked(listKey, ranked, page, pageSize),
    };
  } catch (error) {
    console.error("screenMfsAction error:", error);
    return {
      success: false,
      error: "Failed to run mutual fund screener",
    };
  }
}

// ============== ETF SCREENER (MONEY-196) ==============

/**
 * Screen ETFs against the active filter set + optional text query.
 *
 * ETFs live in `InstrumentMapping` (instrumentType="ETF") and need a
 * cross-join with `MutualFundMaster` via ISIN to surface AUM, returns,
 * fundType (asset class), and expense ratio. The expense ratio side
 * will populate properly when MONEY-209 lands the enrichment worker -
 * until then, expense filters silently return null-rich rows that the
 * match-score helper safely excludes from the mean (no row penalty).
 *
 * 5 min Redis cache keyed on full {filters,query}. Pattern matches the
 * stock + MF screener for consistency.
 */
export async function screenEtfsAction(
  filters: EtfScreenFilters = {},
  query?: string,
  paging: PageOpts = {}
): Promise<ServiceResult<PagedResult<EtfScreenResult>>> {
  const trimmedQuery = query?.trim() ?? "";
  const page = Math.max(0, paging.page ?? 0);
  const pageSize = Math.min(
    Math.max(1, paging.pageSize ?? DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  );
  const sort = (paging.sort as FundSortKey | undefined) ?? "match";

  try {
    const cacheIdent = JSON.stringify({
      ...filters,
      q: trimmedQuery,
      sort,
    });
    const listKey = `screener-etf:v2:${cacheIdent}`;

    const cachedPage = await readPage<EtfScreenResult>(listKey, page, pageSize);
    if (cachedPage) {
      return {
        success: true,
        data: {
          rows: cachedPage.rows,
          total: cachedPage.total,
          page,
          pageSize,
        },
      };
    }

    const ranked = await resolveRankedList<EtfScreenResult>(
      "screener:etf",
      listKey,
      () => computeEtfRanked(filters, trimmedQuery, sort)
    );

    return {
      success: true,
      data: await pageFromRanked(listKey, ranked, page, pageSize),
    };
  } catch (error) {
    console.error("screenEtfsAction error:", error);
    return {
      success: false,
      error: "Failed to run ETF screener",
    };
  }
}

/**
 * The ETF ranked-list builder, lifted verbatim out of `screenEtfsAction` so it
 * can be handed to `resolveRankedList` (MONEY-1131). Row-for-row identical to
 * the previous inline body.
 *
 * One intentional consequence of the lift: an EMPTY result is now cached like
 * any other, where the old early-return skipped the write and re-queried on
 * every request. Same rows either way (`[]`), fewer queries.
 */
async function computeEtfRanked(
  filters: EtfScreenFilters,
  trimmedQuery: string,
  sort: FundSortKey
): Promise<EtfScreenResult[]> {
  const where = buildEtfScreenWhere(filters, trimmedQuery);
  const instruments = await prisma.instrumentMapping.findMany({
    where,
    take: 2000,
    orderBy: { symbol: "asc" },
    select: {
      id: true,
      symbol: true,
      name: true,
      exchange: true,
      yahooSymbol: true,
      isin: true,
    },
  });

  if (instruments.length === 0) return [];

  // Latest quote join - only ETFs with previousClose>0 stay (filters
  // out illiquid/delisted entries). `marketCap` is included so we
  // can fall back to (#units × price) for AUM when the MF-master
  // join isn't populated for that ETF.
  const instIds = instruments.map((i) => i.id);
  const quotes = await prisma.latestQuote.findMany({
    where: {
      instrumentId: { in: instIds },
      previousClose: { gt: 0 },
    },
    select: {
      instrumentId: true,
      price: true,
      changePercent: true,
      marketCap: true,
    },
  });
  const quoteMap = new Map(quotes.map((q) => [q.instrumentId, q]));

  // MF-master join via ISIN - picks up returns / AUM / expenseRatio /
  // fundType. The same ISIN can appear under either isinGrowth or
  // isinDividend so we index both.
  const isins = instruments.map((i) => i.isin).filter(Boolean) as string[];
  const mfRows =
    isins.length > 0
      ? await prisma.mutualFundMaster.findMany({
          where: {
            OR: [
              { isinGrowth: { in: isins } },
              { isinDividend: { in: isins } },
            ],
          },
          select: {
            isinGrowth: true,
            isinDividend: true,
            aum: true,
            returns1Y: true,
            expenseRatio: true,
            fundType: true,
          },
        })
      : [];
  const mfMap = new Map<
    string,
    {
      aum: number | null;
      returns1Y: number | null;
      expenseRatio: number | null;
      fundType: string | null;
    }
  >();
  for (const mf of mfRows) {
    const data = {
      aum: mf.aum,
      returns1Y: mf.returns1Y,
      expenseRatio: mf.expenseRatio,
      fundType: mf.fundType,
    };
    if (mf.isinGrowth) mfMap.set(mf.isinGrowth, data);
    if (mf.isinDividend) mfMap.set(mf.isinDividend, data);
  }

  // Merge + apply post-fetch filters (assetClass, theme, AUM, returns,
  // expense ratio). Filters that point at MF-side data live here because
  // the MF join can't be expressed inline in InstrumentMapping where.
  const merged: Array<{
    inst: (typeof instruments)[number];
    quote: {
      price: number;
      changePercent: number | null;
      marketCap: number | null;
    };
    mf: {
      aum: number | null;
      returns1Y: number | null;
      expenseRatio: number | null;
      fundType: string | null;
    } | null;
    /** Effective AUM - `mf.aum` when MF-master join hits, else
     *  `quote.marketCap` (AUM ≈ outstanding × NAV for ETFs). */
    effectiveAum: number | null;
  }> = [];
  for (const inst of instruments) {
    const quote = quoteMap.get(inst.id);
    if (!quote) continue;
    const mf = inst.isin ? (mfMap.get(inst.isin) ?? null) : null;
    const effectiveAum = mf?.aum ?? quote.marketCap ?? null;

    // Asset-class filter. Source-of-truth is the MutualFundMaster
    // join (`mf.fundType`), but it's null for the majority of ETFs
    // because most ETFs aren't mirrored in MF master. Fall back to
    // a name-keyword derivation (`deriveEtfAssetClass`) so picking
    // "Equity" / "Debt" / "Hybrid" actually narrows the list.
    if (filters.assetClass) {
      const effectiveClass = mf?.fundType ?? deriveEtfAssetClass(inst.name);
      if (effectiveClass !== filters.assetClass) continue;
    }

    // Theme substring (against name)
    if (filters.theme) {
      const themeLower = filters.theme.toLowerCase();
      if (!inst.name.toLowerCase().includes(themeLower)) continue;
    }

    // ETF AMC filter - name-derived (no DB column today). Match
    // against `extractEtfFundHouse(inst.name)` so the production
    // dropdowns (image #71) are honoured even though the data isn't
    // stored. Comparison is case-insensitive title-case.
    if (filters.amcName) {
      const derivedAmc = extractEtfFundHouse(inst.name);
      if (derivedAmc.toLowerCase() !== filters.amcName.toLowerCase()) continue;
    }

    // ETF Category filter - name-keyword bucket (image #72). Same
    // mechanism as AMC: derive at runtime, compare case-insensitive.
    if (filters.category) {
      const derivedCategory = deriveEtfCategory(inst.name);
      if (derivedCategory.toLowerCase() !== filters.category.toLowerCase())
        continue;
    }

    // AUM filter - uses `effectiveAum` (MF-master AUM when present,
    // else LatestQuote.marketCap, which for ETFs ≈ outstanding × NAV).
    // Only rows with no size signal at all skip the filter.
    if (
      filters.minAum != null &&
      effectiveAum != null &&
      effectiveAum < filters.minAum
    )
      continue;
    if (
      filters.maxAum != null &&
      effectiveAum != null &&
      effectiveAum > filters.maxAum
    )
      continue;

    // Returns + expense filters are lenient on missing data: ETFs
    // without an `MutualFundMaster` join keep their row instead of
    // being silently dropped. Strict-on-active was tried (drop
    // null-expense ETFs when slider active) but most ETFs in dev
    // lack the join, so any active filter zeroed the result set
    // (image #99/#101). Lenient is the safer default - when the
    // data lands the filter narrows; until then the slider is
    // effectively a soft filter (it scores rows but doesn't
    // exclude un-joined rows).
    if (
      filters.minReturns1Y != null &&
      mf?.returns1Y != null &&
      mf.returns1Y < filters.minReturns1Y
    )
      continue;
    if (
      filters.maxReturns1Y != null &&
      mf?.returns1Y != null &&
      mf.returns1Y > filters.maxReturns1Y
    )
      continue;
    if (
      filters.minExpenseRatio != null &&
      mf?.expenseRatio != null &&
      mf.expenseRatio < filters.minExpenseRatio
    )
      continue;
    if (
      filters.maxExpenseRatio != null &&
      mf?.expenseRatio != null &&
      mf.expenseRatio > filters.maxExpenseRatio
    )
      continue;

    merged.push({
      inst,
      quote: {
        price: quote.price,
        changePercent: quote.changePercent,
        marketCap: quote.marketCap ?? null,
      },
      mf,
      effectiveAum,
    });
  }

  const scored: EtfScreenResult[] = merged.map(
    ({ inst, quote, mf, effectiveAum }) => ({
      symbol: inst.symbol,
      exchange: inst.exchange,
      name: inst.name,
      yahooSymbol: inst.yahooSymbol,
      ltp: quote.price,
      changePercent: quote.changePercent,
      aum: effectiveAum,
      returns1Y: mf?.returns1Y ?? null,
      expenseRatio: mf?.expenseRatio ?? null,
      assetClass: mf?.fundType ?? deriveEtfAssetClass(inst.name),
      matchScore: computeEtfMatchScore(
        {
          exchange: inst.exchange,
          assetClass: mf?.fundType ?? deriveEtfAssetClass(inst.name),
          name: inst.name,
          aum: effectiveAum,
          returns1Y: mf?.returns1Y ?? null,
          expenseRatio: mf?.expenseRatio ?? null,
        },
        filters
      ),
    })
  );

  const ranked = scored;
  applyFundSort(ranked, sort);
  return ranked;
}

/**
 * Universe sizes for the two tabs the server no longer screens up-front
 * (MONEY-1131).
 *
 * The tab badges want "how big is this universe", which is what
 * `counts.stocks` has always been (`allStocks.length`). MF + ETF got there the
 * expensive way: by running the WHOLE screen for a tab nobody was looking at
 * and reading `.total` off it. These are answered instead by two index-served
 * `count()`s, cached for an hour — the counts move only when the nightly syncs
 * run.
 *
 * The moment a user opens either tab the client replaces this with the LIVE
 * matched total, so it is a first-paint hint, never the displayed match count.
 *
 * ACCURACY, stated precisely rather than optimistically:
 *   - MF is exact — `buildMfScreenWhere({}, "")` is the same predicate the MF
 *     screen applies.
 *   - ETF is an UPPER BOUND. `buildEtfScreenWhere({}, "")` covers the DB-side
 *     predicate, but the ETF screen additionally drops rows with no
 *     `LatestQuote`/`previousClose > 0`, and that filter runs post-fetch in
 *     Node — it cannot be expressed as a `count()`. So the badge can name more
 *     ETFs than the tab can ever list. Counting it exactly would mean running
 *     the very fetch this cache exists to avoid, which is a bad trade for a
 *     first-paint hint that the live total overwrites on open.
 */
export async function getScreenerUniverseCountsAction(): Promise<{
  mf: number;
  etf: number;
} | null> {
  const CACHE_KEY = "screener-universe-counts-v1";
  const TTL = 60 * 60;
  try {
    const cached = await getCached<{ mf: number; etf: number }>(
      CACHE_NS,
      CACHE_SCOPE,
      CACHE_KEY,
      undefined,
      { ttl: TTL }
    );
    if (cached) return cached;

    return await singleFlight(`screener:universe-counts`, async () => {
      const again = await getCached<{ mf: number; etf: number }>(
        CACHE_NS,
        CACHE_SCOPE,
        CACHE_KEY,
        undefined,
        { ttl: TTL }
      );
      if (again) return again;

      const [mf, etf] = await Promise.all([
        prisma.mutualFundMaster.count({ where: buildMfScreenWhere({}, "") }),
        prisma.instrumentMapping.count({ where: buildEtfScreenWhere({}, "") }),
      ]);
      const counts = { mf, etf };
      await setCached(CACHE_NS, CACHE_SCOPE, CACHE_KEY, counts, undefined, {
        ttl: TTL,
      });
      return counts;
    });
  } catch (error) {
    console.error("getScreenerUniverseCountsAction error:", error);
    // A badge is not worth failing a page render over — but the failure value
    // must be NULLISH. Returning `{ mf: 0, etf: 0 }` type-checks and reads as a
    // safe default while being the one shape that defeats the caller's
    // `universeCounts?.mf ?? initialMfPage.total` fallback: `0 ?? x` is `0`,
    // not `x`, so a transient DB failure rendered a confident "Mutual Funds 0"
    // instead of degrading to the page total. `null` lets `??` do its job.
    return null;
  }
}
