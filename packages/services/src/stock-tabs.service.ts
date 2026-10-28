/**
 * Stock-tabs Service (MONEY-1062 P4a — mobile parity)
 *
 * Global stock-detail tab data (financials / peers / news / returns /
 * shareholding / ratios / technicals) for apps/api `/v1/stocks/:symbol/*`.
 * NEW service file — the web drove this through "use server" actions in
 * apps/web/lib/actions/stock-tabs.ts; those aren't importable cross-package, so
 * the read logic (same prisma queries, same `discover` cache keys + TTLs) is
 * ported here FAITHFULLY. The pure bucketing / return-window / finite-coercion
 * seams live in the sibling ./stock-tabs-logic.
 *
 * Source (web actions, read-only source of truth):
 *   getStockFinancialsAction  apps/web/lib/actions/stock-tabs.ts:112
 *   getStockPeersAction       :184
 *   getStockNewsAction        :239
 *   getStockReturnsAction     :293
 *   getShareholdingAction     :363
 *   getStockRatiosAction      :458
 *   getStockTechnicalsAction  :581
 *
 * GLOBAL — market/reference data, NO userId scoping (mirrors market.ts /
 * discover.ts). The `_global` cache scope + "discover" module + per-tab cache
 * keys/TTLs are byte-identical to the web actions.
 *
 * ACTION QUIRKS preserved verbatim:
 *   - No-instrument / no-row → `success:true` with empty/null data (NOT an
 *     error) so the client renders its own empty state.
 *   - Shareholding SWALLOWS fetch errors → `success:true, { shareholding: [] }`.
 *   - Symbols are queried VERBATIM (the web actions do NOT uppercase); the
 *     caller passes the canonical symbol, exactly as the web route param does.
 *   - financials/peers/returns/shareholding read `if (cached)`; ratios/technicals
 *     read `if (cached !== undefined && cached !== null)` — each kept as-is.
 *
 * IO seam: every function takes an optional `deps` (prisma / cache / market
 * status / the two dynamic-imported collaborators) so the service tests inject
 * fakes and assert the exact query + cache key/TTL on the REAL code path.
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core/cache";
import { getNseMarketStatus } from "@usemoney/core/market-data/market-hours";
import type {
  OHLCV,
  TechnicalIndicators,
} from "@usemoney/core/market-data/technical-indicators";
import type { ServiceResult } from "./types";
import {
  numOrNull,
  splitFinancialsByStatement,
  findCloseIndexAtOrBefore,
  pctReturnTo,
} from "./stock-tabs-logic";

// ── Cache policy (verbatim from stock-tabs.ts:41) ────────────────────────────
const TABS_CACHE_NS = "discover" as const;
const CACHE_SCOPE = "_global" as const;

// ── Shared wire types (ported from stock-tabs.ts) ────────────────────────────

export interface StockFinancialRow {
  /**
   * Which source produced this row — MONEY-1204 / 14c.8.
   *
   * OPTIONAL on purpose, and the cache key is bumped below for the same
   * reason: every warm cache entry predates this column, so a required
   * field would be a compile-time promise the cache cannot keep for the
   * first 1-6 hours after deploy.
   */
  source?: string;
  period: string;
  /**
   * UTC end-of-period when the source supplied one — MONEY-1235. OPTIONAL for
   * the same reason `source` is (warm cache entries predate it), and it was
   * already being SELECTED and shipped before it was declared here.
   *
   * It is the SORTABLE key: `period` is a free-text label ("FY 2025", "TTM",
   * "Q1-2027") and ordering on it is lexicographic.
   */
  periodEnd?: string | Date | null;
  /**
   * When THIS row was last refreshed — MONEY-1235. Rows in one statement no
   * longer share a clock: the nightly XBRL projection refreshes real reporting
   * periods but structurally never emits a `"TTM"` label, so stored TTM rows
   * keep Tickertape values and a frozen stamp for good.
   */
  fetchedAt?: string | Date | null;
  periodType: "ANNUAL" | "QUARTERLY";
  statementType: "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";
  /**
   * CONSOLIDATED | STANDALONE — whose accounts this period's figures are
   * (MONEY-1300).
   *
   * An Indian company files the SAME period twice under SEBI/Ind AS and for a
   * holding company the two differ by a MULTIPLE: 360ONE FY2025 `totalAssets`
   * is 19,768 Cr consolidated against 7,332 Cr standalone. Measured on prod
   * 2026-08-31, 1,786 of 2,467 symbols with an annual period (72%) file BOTH.
   * `StockFinancials` deliberately keeps ONE row per period — `basis` is not in
   * its `@@unique` — so the figure is correct but unattributable without this.
   *
   * OPTIONAL, and ABSENT is a real state rather than an oversight: on MongoDB a
   * `db push` creates indexes and never fields, so the attribute is MISSING on
   * the ~32,359 rows the XBRL projection has not yet rewritten. Absent and the
   * literal "UNKNOWN" a vendor row carries must render IDENTICALLY, and never
   * as "Consolidated" — see `normalizeStockFinancialsBasis`. The cache key is
   * bumped alongside, for the same reason `source` bumped it: every warm entry
   * predates the field.
   *
   * Typed `string`, not the three-value union: the column is `String?` and
   * nothing constrains what a future writer stores, so the union would be a
   * compile-time promise the database does not make. Normalisation happens at
   * the render boundary, once.
   */
  basis?: string | null;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  ebitda: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  totalDebt: number | null;
  operatingCashFlow: number | null;
  capitalExpenditure: number | null;
  freeCashFlow: number | null;
}

export interface StockFinancialsData {
  income: StockFinancialRow[];
  balance: StockFinancialRow[];
  cashflow: StockFinancialRow[];
}

export interface StockPeerRow {
  symbol: string;
  name: string;
  /**
   * CRORES — copied un-scaled from `StockRatios.marketCap` by
   * `peers-sync.service.ts`. NOT rupees: `LatestQuote.marketCap` is the rupees
   * column and the two are 1e7 apart, so a consumer that guesses renders a real
   * mid-cap as "₹0 Cr" — a confident wrong number, not an empty state
   * (MONEY-1144, and again on the peers table itself in MONEY-1255).
   */
  marketCap: number | null;
  pe: number | null;
  roe: number | null;
  changePercent: number | null;
}

export interface StockNewsItem {
  title: string;
  link: string;
  pubDate: string | null;
  source: string;
  snippet: string | null;
  sentiment: "POSITIVE" | "NEGATIVE" | "NEUTRAL" | null;
}

/** 1D / 1W / 1M / 3M / 6M / 1Y / 3Y / 5Y. */
export type ReturnsPeriod =
  | "1D"
  | "1W"
  | "1M"
  | "3M"
  | "6M"
  | "1Y"
  | "3Y"
  | "5Y";

export type StockReturns = Partial<Record<ReturnsPeriod, number | null>>;

export interface ShareholdingPoint {
  quarter: string;
  promoter: number;
  fii: number;
  dii: number;
  public: number;
}

/**
 * The row shape `fetchShareholdingChain` yields (TickertapeShareholding /
 * ScreenerShareholding both have exactly these fields).
 *
 * MONEY-1205 — the holdings are `| null` because an ABSENT holding is not a
 * zero holding. The Tickertape mapper used to write `?? 0`, so this type was
 * accurate about what it received and wrong about what was true; now that the
 * mapper reports absence honestly, the type has to carry it. Core's
 * `TickertapeShareholdingRow` has always accepted `number | null`, so the
 * normalisation layer downstream needs no change.
 */
export interface ShareholdingChainRow {
  quarter: string;
  promoter: number | null;
  fii: number | null;
  dii: number | null;
  public: number | null;
}

export interface StockRatiosData {
  // Valuation
  pe: number | null;
  pb: number | null;
  evToEbitda: number | null;
  pegRatio: number | null;
  // Profitability
  roe: number | null;
  roa: number | null;
  roce: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  // Growth
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  revenueGrowth3Y: number | null;
  earningsGrowth3Y: number | null;
  revenueGrowth5Y: number | null;
  earningsGrowth5Y: number | null;
  // Leverage
  debtToEquity: number | null;
  currentRatio: number | null;
  interestCoverage: number | null;
  // Market
  beta: number | null;
  dividendYield: number | null;
  marketCap: number | null;
  enterpriseValue: number | null;
  // Analyst (third-party DATA, not advice)
  targetPrice: number | null;
  recommendation: string | null;
  // Provenance
  source: string;
  /**
   * THE ANALYST CLOCK — MONEY-1235. When the row was last FETCHED from an
   * upstream, which for every symbol means when Tickertape last answered. NOT
   * "when these ratios were computed": `xbrl-ratios-daily` derives 26 of the
   * model's 28 columns nightly and stamps `ratiosDerivedAt` instead, leaving
   * this alone on purpose — `targetPrice` and `recommendation` are sell-side
   * opinion nothing writes any more, and this is their honest age.
   */
  fetchedAt: string | null;
  /**
   * THE DERIVED CLOCK — MONEY-1235. When `xbrl-ratios` last recomputed the 23
   * columns it owns. Optional because warm cache entries predate it.
   */
  ratiosDerivedAt?: string | null;
  /**
   * `max(fetchedAt, ratiosDerivedAt)` — the age of the ratios a client actually
   * renders, computed server-side so web and mobile cannot disagree about it.
   */
  dataAsOf?: string | null;
}

export interface StockTechnicalsData {
  price: number | null;
  rsi14: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  price52WeekHigh: number | null;
  price52WeekLow: number | null;
  distanceFrom52WeekHigh: number | null;
  distanceFrom52WeekLow: number | null;
  goldenCross: boolean | null;
  deathCross: boolean | null;
  /** Newest close date used for the compute (ISO), for an "as of" label. */
  asOf: string | null;
  /** Number of daily closes the compute ran over (transparency). */
  sampleSize: number;
}

// ── IO seam ──────────────────────────────────────────────────────────────────

/**
 * Injectable collaborators. Defaults are the shared prisma / cache utils / the
 * pure NSE market-phase detector, plus lazy wrappers around the two dynamic
 * imports the web actions used (`@usemoney/research#fetchShareholdingChain`,
 * `@usemoney/core/market-data/technical-indicators#computeIndicators`). The
 * service tests inject fakes so the DB query + cache key/TTL are asserted
 * hermetically (no Redis, no network).
 */
export interface StockTabsDeps {
  prisma?: typeof prisma;
  getCached?: typeof getCached;
  setCached?: typeof setCached;
  getNseMarketStatus?: () => { isLive: boolean };
  fetchShareholdingChain?: (
    symbol: string,
  ) => Promise<ShareholdingChainRow[] | null | undefined>;
  computeIndicators?: (
    candles: OHLCV[],
  ) => TechnicalIndicators | Promise<TechnicalIndicators>;
}

async function defaultFetchShareholdingChain(
  symbol: string,
): Promise<ShareholdingChainRow[] | null | undefined> {
  const { fetchShareholdingChain } = await import("@usemoney/research");
  return fetchShareholdingChain(symbol);
}

async function defaultComputeIndicators(
  candles: OHLCV[],
): Promise<TechnicalIndicators> {
  const { computeIndicators } =
    await import("@usemoney/core/market-data/technical-indicators");
  return computeIndicators(candles);
}

interface ResolvedDeps {
  db: typeof prisma;
  readCache: typeof getCached;
  writeCache: typeof setCached;
  ttl: (live: number, closed: number) => number;
  fetchShareholdingChain: (
    symbol: string,
  ) => Promise<ShareholdingChainRow[] | null | undefined>;
  computeIndicators: (
    candles: OHLCV[],
  ) => TechnicalIndicators | Promise<TechnicalIndicators>;
}

function resolve(deps: StockTabsDeps): ResolvedDeps {
  const marketStatus = deps.getNseMarketStatus ?? getNseMarketStatus;
  return {
    db: deps.prisma ?? prisma,
    readCache: deps.getCached ?? getCached,
    writeCache: deps.setCached ?? setCached,
    // `liveOrClosed` (stock-tabs.ts:42): live TTL while the NSE session is open,
    // longer TTL once closed. Evaluated per write so a mid-session close rolls it.
    ttl: (live, closed) => (marketStatus().isLive ? live : closed),
    fetchShareholdingChain:
      deps.fetchShareholdingChain ?? defaultFetchShareholdingChain,
    computeIndicators: deps.computeIndicators ?? defaultComputeIndicators,
  };
}

/** `(symbol, exchange)` → active InstrumentMapping id (verbatim, stock-tabs.ts:99). */
async function instrumentIdFor(
  db: typeof prisma,
  symbol: string,
  exchange: string,
): Promise<string | null> {
  const row = await db.instrumentMapping.findFirst({
    where: { symbol, exchange, isActive: true },
    select: { id: true },
  });
  return row?.id ?? null;
}

// ── Period ordering for the /v1 payload — MONEY-1235 ─────────────────────────
//
// This bucket used to ship in DB order — `orderBy: { period: "desc" }` — under
// a comment saying "let the client sort". The WEB client does: the tab re-sorts
// every bucket with `sortByPeriodDesc`
// (apps/web/components/stock/StockFinancialsTab.tsx). The MOBILE client
// consuming `GET /v1/stocks/:symbol/financials?periodType=QUARTERLY` is a
// different codebase in a different repo, and if it renders array order it gets
// a LEXICOGRAPHIC one — which puts `"Q4-2026"` above `"Q1-2027"`, i.e. the
// newest quarter of a symbol that has entered FY2027 sorts below every quarter
// of FY2026. Prod has 71,450 quarterly filings and ZERO quarterly
// `stock_financials` rows today, so this order arrives with the first rows the
// XBRL projection ever writes; nothing existing regresses, and nothing existing
// would have caught it either.
//
// Sorting here is a NO-OP for web (it re-sorts anyway) and the fix for mobile.
//
// ## Why these three are a deliberate PORT rather than an import
//
// The contract this must satisfy is "match what the web tab renders", and the
// web tab's comparator lives in a `"use client"` .tsx inside apps/web plus
// `apps/web/lib/actions/stock-detail-logic.ts` — neither importable from a
// package. `packages/research/src/data-sources/db-store-logic.ts` has a similar
// sorter and IS importable, but its contract is prompt ordering (TTM last,
// labels resolved to dates), so binding the mobile payload to it would let a
// future prompt-ordering change silently reorder the app. The parallel-copy
// convention is already established here: `stock-tabs-logic.ts` exists twice,
// once per side, for exactly this reason.

/** Parsed `(year, quarter)` sort key. Port of `parsePeriodKey` (apps/web). */
export function parseFinancialPeriodKey(period: string): {
  year: number | null;
  quarter: number | null;
} {
  const s = typeof period === "string" ? period.trim() : "";
  if (!s) return { year: null, quarter: null };
  const qMatch = s.match(/Q\s*([1-4])\b/i);
  const quarter = qMatch ? Number(qMatch[1]) : null;
  const fourDigit = s.match(/(\d{4})/);
  let year: number | null = null;
  if (fourDigit) {
    year = Number(fourDigit[1]);
  } else {
    const twoDigit = s.match(/(\d{2})\b/);
    if (twoDigit) year = 2000 + Number(twoDigit[1]);
  }
  return { year, quarter };
}

/**
 * Newest-first label comparator. Port of `comparePeriodsDesc` (apps/web).
 *
 * An unparseable year sorts LAST — which is how `"TTM"` (no digits at all) ends
 * up behind every real period rather than being guessed into place.
 */
export function compareFinancialPeriodsDesc(a: string, b: string): number {
  const ka = parseFinancialPeriodKey(a);
  const kb = parseFinancialPeriodKey(b);
  if (ka.year === null && kb.year === null) return b.localeCompare(a);
  if (ka.year === null) return 1;
  if (kb.year === null) return -1;
  if (ka.year !== kb.year) return kb.year - ka.year;
  const qa = ka.quarter ?? 0;
  const qb = kb.quarter ?? 0;
  if (qa !== qb) return qb - qa;
  return b.localeCompare(a);
}

/**
 * Newest-first COPY of one statement bucket. Port of `sortByPeriodDesc`.
 *
 * Ordered on `periodEnd` when the row carries one, falling back to the label
 * comparator when it does not. A row WITH a real end date outranks one without:
 * an undated row cannot be placed, and guessing its position is the bug.
 *
 * Sorted in CODE rather than by adding `orderBy: { periodEnd: "desc" }` to the
 * query: `periodEnd` is nullable and every legacy Tickertape row predates it,
 * and on Mongo a MISSING field sorts in a fixed position rather than being
 * excluded — so the DB would place undated rows confidently and wrongly.
 */
export function sortFinancialRowsNewestFirst<
  T extends { period: string; periodEnd?: string | Date | null },
>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const ea = a.periodEnd ? new Date(a.periodEnd).getTime() : NaN;
    const eb = b.periodEnd ? new Date(b.periodEnd).getTime() : NaN;
    const va = Number.isFinite(ea);
    const vb = Number.isFinite(eb);
    if (va && vb && ea !== eb) return eb - ea;
    if (va !== vb) return va ? -1 : 1;
    return compareFinancialPeriodsDesc(a.period, b.period);
  });
}

// ── Financials (port of getStockFinancialsAction) ────────────────────────────

export async function getStockFinancials(
  args: {
    symbol: string;
    exchange: string;
    periodType?: "ANNUAL" | "QUARTERLY";
  },
  deps: StockTabsDeps = {},
): Promise<ServiceResult<StockFinancialsData>> {
  const { db, readCache, writeCache, ttl } = resolve(deps);
  // ANNUAL, not QUARTERLY (MONEY-1207). The web tab has always overridden the
  // default to ANNUAL locally, so this value was only ever reached by callers
  // that omit it — i.e. `apps/api`, which therefore served an empty payload on
  // every unqualified request: QUARTERLY has 0 rows platform-wide because the
  // quarterly fetcher maps five keys that do not exist in Tickertape's interim
  // payload. Defaulting to the period the product actually shows removes a
  // silent empty result that looked like "this company files nothing".
  const periodType = args.periodType ?? "ANNUAL";
  // -v3: `periodEnd` joins the payload. Every warm entry predates it, and the
  // TTM column ordering depends on it, so a stale entry would sort wrongly
  // rather than merely miss a field.
  // -v4 (MONEY-1235): `fetchedAt` joins it, AND the buckets are now sorted
  // newest-first server-side. A warm -v3 entry is in the old lexicographic DB
  // order, so serving one would hand a mobile client `"Q4-2026"` ahead of
  // `"Q1-2027"` for the 1-6 hours the TTL runs — a wrong order, not a missing
  // field, which is what makes this a bump rather than a graceful degrade.
  // -v5 (MONEY-1300): `basis` joins the payload. A warm -v4 entry carries no
  // basis on any row, so every column of it would render "Basis not stated"
  // for the 1-6 hours the TTL runs — which is a LIE in the opposite direction
  // from the usual cache-staleness one: the data is there, we just would not be
  // serving it. Bumping makes the new column trustworthy on the first request.
  const cacheKey = `stock-financials-v5:${args.symbol}:${args.exchange}:${periodType}`;
  const cached = await readCache<StockFinancialsData>(
    TABS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    // MONEY-1145 — keyed on (symbol, exchange), the model's declared
    // `@@unique`, not on the mutable `instrumentId`. Measured on the dev DB,
    // the instrumentId form matched 0 of 32,359 rows because re-seeding
    // `instrument_mappings` re-mints ObjectIds and orphans every dependent
    // row. Mirrors the web action in `apps/web/lib/actions/stock-tabs.ts` —
    // see the long note there for the full reasoning. Kept in sync per the
    // standing rule that apps/api must not drift from the server actions.
    //
    // See stock-tabs.ts — `period` is a free-form upstream string, so
    // `orderBy:{period:"desc"}` is only a deterministic DB-side tiebreaker; we
    // fetch ALL rows for (symbol, exchange, periodType) and re-sort each bucket
    // below with `sortFinancialRowsNewestFirst`. MONEY-1235 removed the "let
    // the client sort" half of this: the web client does, the mobile client is
    // a different repo, and lexicographic order is wrong for quarterly labels.
    const rows = await db.stockFinancials.findMany({
      where: { symbol: args.symbol, exchange: args.exchange, periodType },
      orderBy: { period: "desc" },
      take: 150,
      select: {
        period: true,
        // The SORTABLE key. `period` is a free-text LABEL ("FY 2025", "TTM")
        // and TTM has no year at all, so a label sort files the freshest
        // figure in the OLDEST column. Tickertape sends `endDate` on every
        // row including TTM.
        periodEnd: true,
        // Per-ROW freshness — MONEY-1235. Rows in one statement run on
        // different clocks: the nightly XBRL projection refreshes the reporting
        // periods and can never touch the TTM row (`periodLabel()` structurally
        // never emits "TTM"), so ~2,123 of them are frozen on Tickertape values.
        fetchedAt: true,
        periodType: true,
        statementType: true,
        source: true,
        // Whose accounts the period is — MONEY-1300. A hardcoded `select` that
        // omits a column makes "we never asked" print as "the row has no
        // value", which is a defect class this repo has paid for before; the
        // figure then renders with no way to tell a group total from the
        // parent alone.
        basis: true,
        revenue: true,
        grossProfit: true,
        operatingIncome: true,
        netIncome: true,
        ebitda: true,
        totalAssets: true,
        totalLiabilities: true,
        totalEquity: true,
        totalDebt: true,
        operatingCashFlow: true,
        capitalExpenditure: true,
        freeCashFlow: true,
      },
    });
    const split = splitFinancialsByStatement(
      rows as unknown as StockFinancialRow[],
    );
    // MONEY-1235 — order the buckets HERE, not at the client. See the note
    // above `sortFinancialRowsNewestFirst`. Each bucket is sorted separately
    // because they are three independent statements, not one interleaved list.
    const data: StockFinancialsData = {
      income: sortFinancialRowsNewestFirst(split.income),
      balance: sortFinancialRowsNewestFirst(split.balance),
      cashflow: sortFinancialRowsNewestFirst(split.cashflow),
    };
    await writeCache(TABS_CACHE_NS, CACHE_SCOPE, cacheKey, data, undefined, {
      ttl: ttl(60 * 60, 6 * 60 * 60),
    });
    return { success: true, data };
  } catch (error) {
    console.error("getStockFinancials error:", error);
    return { success: false, error: "Failed to load financials" };
  }
}

// ── Peers (port of getStockPeersAction) ──────────────────────────────────────

export async function getStockPeers(
  args: { symbol: string; exchange: string },
  deps: StockTabsDeps = {},
): Promise<ServiceResult<StockPeerRow[]>> {
  const { db, readCache, writeCache, ttl } = resolve(deps);
  const cacheKey = `stock-peers:${args.symbol}:${args.exchange}`;
  const cached = await readCache<StockPeerRow[]>(
    TABS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    // MONEY-1145 — natural key, mirroring the web action. `stock_peers` also
    // stores a SENTINEL instrumentId ("0000...") when the writer cannot
    // resolve the instrument, so an instrumentId-keyed read could never match
    // those rows at all.
    const row = await db.stockPeers.findFirst({
      where: { symbol: args.symbol, exchange: args.exchange },
      select: { peers: true },
    });
    if (!row || !Array.isArray(row.peers)) {
      return { success: true, data: [] };
    }
    // Each entry shape varies by source — defensively coerce (stock-tabs.ts:207).
    const peers: StockPeerRow[] = (
      row.peers as unknown as Array<Record<string, unknown>>
    )
      .map((p) => {
        const symbol = String(p.symbol ?? p.ticker ?? "");
        if (!symbol) return null;
        const name = String(p.name ?? p.fullName ?? symbol);
        const marketCap = numOrNull(p.marketCap ?? p.mcap);
        const pe = numOrNull(p.pe ?? p.priceToEarnings);
        const roe = numOrNull(p.roe ?? p.returnOnEquity);
        const changePercent = numOrNull(p.changePercent ?? p.changePct);
        return { symbol, name, marketCap, pe, roe, changePercent };
      })
      .filter(Boolean) as StockPeerRow[];
    const trimmed = peers.slice(0, 12);
    await writeCache(TABS_CACHE_NS, CACHE_SCOPE, cacheKey, trimmed, undefined, {
      ttl: 6 * 60 * 60,
    });
    return { success: true, data: trimmed };
  } catch (error) {
    console.error("getStockPeers error:", error);
    return { success: false, error: "Failed to load peers" };
  }
}

// ── News (port of getStockNewsAction) ────────────────────────────────────────
// NOTE: exported as `getStockTabNews` (not `getStockNews`) — the concurrent P4b
// `news.service` already exports a DIFFERENT `getStockNews` (the News-&-Events
// RSS feed, news.ts:66). Same barrel, so the stock-detail-tab port takes a
// distinct name. Behaviour is a faithful port of stock-tabs.ts:239.

export async function getStockTabNews(
  args: { symbol: string; limit?: number },
  deps: StockTabsDeps = {},
): Promise<ServiceResult<StockNewsItem[]>> {
  const { db, readCache, writeCache, ttl } = resolve(deps);
  // Clamp verbatim (stock-tabs.ts:244): [1, 50], default 12.
  const limit = Math.min(50, Math.max(1, args.limit ?? 12));
  const cacheKey = `stock-news:${args.symbol}:${limit}`;
  const cached = await readCache<StockNewsItem[]>(
    TABS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    const rows = await db.stockNews.findMany({
      where: { symbol: args.symbol },
      orderBy: { pubDate: "desc" },
      take: limit,
      select: {
        title: true,
        link: true,
        pubDate: true,
        source: true,
        snippet: true,
        sentiment: true,
      },
    });
    const items: StockNewsItem[] = rows.map((r) => ({
      title: r.title,
      link: r.link,
      pubDate: r.pubDate ? r.pubDate.toISOString() : null,
      source: r.source,
      snippet: r.snippet,
      sentiment:
        r.sentiment === "POSITIVE" ||
        r.sentiment === "NEGATIVE" ||
        r.sentiment === "NEUTRAL"
          ? r.sentiment
          : null,
    }));
    await writeCache(TABS_CACHE_NS, CACHE_SCOPE, cacheKey, items, undefined, {
      ttl: ttl(5 * 60, 15 * 60),
    });
    return { success: true, data: items };
  } catch (error) {
    console.error("getStockNews error:", error);
    return { success: false, error: "Failed to load news" };
  }
}

// ── Returns (port of getStockReturnsAction) ──────────────────────────────────

export async function getStockReturns(
  args: { symbol: string; exchange: string },
  deps: StockTabsDeps = {},
): Promise<ServiceResult<StockReturns>> {
  const { db, readCache, writeCache, ttl } = resolve(deps);
  const cacheKey = `stock-returns:${args.symbol}:${args.exchange}`;
  const cached = await readCache<StockReturns>(
    TABS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    const instrumentId = await instrumentIdFor(db, args.symbol, args.exchange);
    if (!instrumentId) return { success: true, data: {} };

    // Most recent 5+ years of daily closes, desc so known offsets index directly.
    const closes = await db.dailyPrice.findMany({
      where: { instrumentId },
      orderBy: { date: "desc" },
      take: 1500,
      select: { date: true, close: true },
    });
    if (closes.length < 2) return { success: true, data: {} };

    const ret: StockReturns = {};
    const pctTo = (idx: number) => pctReturnTo(closes, idx);
    const findIndexAtOrBefore = (days: number) =>
      findCloseIndexAtOrBefore(closes, days);

    // 1D = previous trading day's close (stock-tabs.ts:327).
    ret["1D"] = pctTo(1);
    ret["1W"] = pctTo(findIndexAtOrBefore(7));
    ret["1M"] = pctTo(findIndexAtOrBefore(30));
    ret["3M"] = pctTo(findIndexAtOrBefore(91));
    ret["6M"] = pctTo(findIndexAtOrBefore(182));
    ret["1Y"] = pctTo(findIndexAtOrBefore(365));
    ret["3Y"] = pctTo(findIndexAtOrBefore(365 * 3));
    ret["5Y"] = pctTo(findIndexAtOrBefore(365 * 5));

    await writeCache(TABS_CACHE_NS, CACHE_SCOPE, cacheKey, ret, undefined, {
      ttl: ttl(30 * 60, 6 * 60 * 60),
    });
    return { success: true, data: ret };
  } catch (error) {
    console.error("getStockReturns error:", error);
    return { success: false, error: "Failed to compute returns" };
  }
}

// ── Shareholding (port of getShareholdingAction) ─────────────────────────────

export async function getShareholding(
  args: { symbol: string; exchange: string },
  deps: StockTabsDeps = {},
): Promise<ServiceResult<{ shareholding: ShareholdingPoint[] }>> {
  const { readCache, writeCache, ttl, fetchShareholdingChain } = resolve(deps);
  const cacheKey = `stock-shareholding:${args.symbol}:${args.exchange}`;
  const cached = await readCache<ShareholdingPoint[]>(
    TABS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  if (cached) return { success: true, data: { shareholding: cached } };

  try {
    const rows = await fetchShareholdingChain(args.symbol);
    const shareholding: ShareholdingPoint[] = (rows ?? []).map(
      (r): ShareholdingPoint => ({
        quarter: r.quarter,
        // `?? 0` is deliberate at the RENDER boundary and mirrors
        // `apps/web/lib/actions/stock-tabs.ts` exactly: ShareholdingPoint feeds
        // a number-typed stacked bar. It does invent a figure — a null promoter
        // holding is "not reported", not "0%" — and that is tracked on
        // MONEY-1146, because widening ShareholdingPoint to nullable touches the
        // chart component.
        //
        // MONEY-1205 note: the coercion is now confined to THIS boundary. The
        // Tickertape mapper no longer fabricates zeros upstream, so
        // `fetchShareholdingChain` can return null and fall through to Screener
        // instead of winning the chain with a zero-filled array. What is left
        // here is a rendering compromise over data that is honest by the time it
        // arrives — not a silent claim invented at the source.
        promoter: r.promoter ?? 0,
        fii: r.fii ?? 0,
        dii: r.dii ?? 0,
        public: r.public ?? 0,
      }),
    );
    if (shareholding.length > 0) {
      await writeCache(
        TABS_CACHE_NS,
        CACHE_SCOPE,
        cacheKey,
        shareholding,
        undefined,
        { ttl: ttl(60 * 60, 6 * 60 * 60) },
      );
    }
    return { success: true, data: { shareholding } };
  } catch (error) {
    // MONEY-1146 — this used to swallow the failure and return
    // `{ success: true, shareholding: [] }`, deliberately mirroring the web
    // action's quirk for parity. That quirk is now fixed on web, so the
    // mirror follows: a fetch failure is reported as a failure, and only a
    // genuinely empty upstream result returns success with an empty list.
    //
    // The distinction is the whole point — the two were indistinguishable, so
    // a permanently-broken scrape looked exactly like an uncovered symbol and
    // nothing surfaced it.
    //
    // NOT ported: the DB-first read + persist that the web action now does.
    // This service takes its collaborators through `deps` and has no `db`
    // handle on this path; wiring one is a larger change, tracked on
    // MONEY-1146. Until then apps/api still scrapes per request — but it at
    // least tells the caller when that scrape fails.
    console.error("getShareholding error:", error);
    return {
      success: false,
      error: "Couldn't load shareholding data right now. Please try again.",
    };
  }
}

// ── Fundamental ratios (port of getStockRatiosAction) ────────────────────────

/**
 * The later of two nullable timestamps, as ISO — MONEY-1235.
 *
 * Duplicated (identically, with the same comment) in
 * `apps/web/lib/actions/stock-tabs.ts`, whose `"use server"` boundary forbids a
 * non-action export and cannot be imported from a package either way.
 *
 * Invalid dates are treated as ABSENT rather than coerced: `new Date("").
 * getTime()` is NaN and `Math.max(NaN, x)` is NaN, so one unusable column would
 * otherwise wipe out a perfectly good one.
 */
export function latestOfTwo(
  a: Date | null | undefined,
  b: Date | null | undefined,
): string | null {
  const ta =
    a instanceof Date && Number.isFinite(a.getTime()) ? a.getTime() : null;
  const tb =
    b instanceof Date && Number.isFinite(b.getTime()) ? b.getTime() : null;
  if (ta === null && tb === null) return null;
  return new Date(Math.max(ta ?? -Infinity, tb ?? -Infinity)).toISOString();
}

export async function getStockRatios(
  args: { symbol: string; exchange: string },
  deps: StockTabsDeps = {},
): Promise<ServiceResult<StockRatiosData | null>> {
  const { db, readCache, writeCache, ttl } = resolve(deps);
  // -v2 (MONEY-1235): `ratiosDerivedAt` + `dataAsOf` join the payload. A warm
  // entry written before this deploy carries neither, so `dataAsOf` would read
  // as the frozen `fetchedAt` and report day-fresh ratios as months old — a
  // wrong answer rather than a missing one, which is the bar for a bump.
  const cacheKey = `stock-ratios-v2:${args.symbol}:${args.exchange}`;
  const cached = await readCache<StockRatiosData | null>(
    TABS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  // QUIRK (stock-tabs.ts:468): a cached `null` is treated as a MISS (re-reads).
  if (cached !== undefined && cached !== null) {
    return { success: true, data: cached };
  }

  try {
    const row = await db.stockRatios.findFirst({
      where: { symbol: args.symbol, exchange: args.exchange },
      select: {
        pe: true,
        pb: true,
        evToEbitda: true,
        pegRatio: true,
        roe: true,
        roa: true,
        roce: true,
        grossMargin: true,
        operatingMargin: true,
        netMargin: true,
        revenueGrowth: true,
        earningsGrowth: true,
        revenueGrowth3Y: true,
        earningsGrowth3Y: true,
        revenueGrowth5Y: true,
        earningsGrowth5Y: true,
        debtToEquity: true,
        currentRatio: true,
        interestCoverage: true,
        beta: true,
        dividendYield: true,
        marketCap: true,
        enterpriseValue: true,
        targetPrice: true,
        recommendation: true,
        source: true,
        fetchedAt: true,
        // MONEY-1235 — the second of the two clocks this row runs on. See the
        // type's doc: `fetchedAt` is the analyst-column age, `ratiosDerivedAt`
        // is when the 23 derived columns were last recomputed.
        ratiosDerivedAt: true,
      },
    });
    if (!row) return { success: true, data: null };

    const data: StockRatiosData = {
      pe: numOrNull(row.pe),
      pb: numOrNull(row.pb),
      evToEbitda: numOrNull(row.evToEbitda),
      pegRatio: numOrNull(row.pegRatio),
      roe: numOrNull(row.roe),
      roa: numOrNull(row.roa),
      roce: numOrNull(row.roce),
      grossMargin: numOrNull(row.grossMargin),
      operatingMargin: numOrNull(row.operatingMargin),
      netMargin: numOrNull(row.netMargin),
      revenueGrowth: numOrNull(row.revenueGrowth),
      earningsGrowth: numOrNull(row.earningsGrowth),
      revenueGrowth3Y: numOrNull(row.revenueGrowth3Y),
      earningsGrowth3Y: numOrNull(row.earningsGrowth3Y),
      revenueGrowth5Y: numOrNull(row.revenueGrowth5Y),
      earningsGrowth5Y: numOrNull(row.earningsGrowth5Y),
      debtToEquity: numOrNull(row.debtToEquity),
      currentRatio: numOrNull(row.currentRatio),
      interestCoverage: numOrNull(row.interestCoverage),
      beta: numOrNull(row.beta),
      dividendYield: numOrNull(row.dividendYield),
      marketCap: numOrNull(row.marketCap),
      enterpriseValue: numOrNull(row.enterpriseValue),
      targetPrice: numOrNull(row.targetPrice),
      recommendation: row.recommendation ?? null,
      source: row.source ?? "TICKERTAPE",
      fetchedAt: row.fetchedAt ? row.fetchedAt.toISOString() : null,
      ratiosDerivedAt: row.ratiosDerivedAt
        ? row.ratiosDerivedAt.toISOString()
        : null,
      // MONEY-1235 — `max` of the two clocks, computed once here so every
      // reader agrees on one answer instead of each picking a column.
      dataAsOf: latestOfTwo(row.fetchedAt, row.ratiosDerivedAt),
    };
    await writeCache(TABS_CACHE_NS, CACHE_SCOPE, cacheKey, data, undefined, {
      ttl: ttl(60 * 60, 6 * 60 * 60),
    });
    return { success: true, data };
  } catch (error) {
    console.error("getStockRatios error:", error);
    return { success: false, error: "Failed to load fundamentals" };
  }
}

// ── Technicals (port of getStockTechnicalsAction) ────────────────────────────

export async function getStockTechnicals(
  args: { symbol: string; exchange: string },
  deps: StockTabsDeps = {},
): Promise<ServiceResult<StockTechnicalsData | null>> {
  const { db, readCache, writeCache, ttl, computeIndicators } = resolve(deps);
  const cacheKey = `stock-technicals:${args.symbol}:${args.exchange}`;
  const cached = await readCache<StockTechnicalsData | null>(
    TABS_CACHE_NS,
    CACHE_SCOPE,
    cacheKey,
  );
  // QUIRK (stock-tabs.ts:591): a cached `null` is treated as a MISS (re-reads).
  if (cached !== undefined && cached !== null) {
    return { success: true, data: cached };
  }

  try {
    const instrumentId = await instrumentIdFor(db, args.symbol, args.exchange);
    if (!instrumentId) return { success: true, data: null };

    // Need ~200+ closes for SMA200; pull generous, desc, then reverse to oldest.
    const closesDesc = await db.dailyPrice.findMany({
      where: { instrumentId },
      orderBy: { date: "desc" },
      take: 400,
      select: {
        date: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
      },
    });
    if (closesDesc.length < 30) return { success: true, data: null };

    const candles: OHLCV[] = [...closesDesc].reverse().map((r) => ({
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
    const ind = await computeIndicators(candles);
    const newest = closesDesc[0]!;

    const data: StockTechnicalsData = {
      price: numOrNull(newest.close),
      rsi14: numOrNull(ind.rsi14),
      sma20: numOrNull(ind.sma20),
      sma50: numOrNull(ind.sma50),
      sma200: numOrNull(ind.sma200),
      macd: numOrNull(ind.macd),
      macdSignal: numOrNull(ind.macdSignal),
      macdHistogram: numOrNull(ind.macdHistogram),
      price52WeekHigh: numOrNull(ind.price52WeekHigh),
      price52WeekLow: numOrNull(ind.price52WeekLow),
      distanceFrom52WeekHigh: numOrNull(ind.distanceFrom52WeekHigh),
      distanceFrom52WeekLow: numOrNull(ind.distanceFrom52WeekLow),
      goldenCross: ind.goldenCross ?? null,
      deathCross: ind.deathCross ?? null,
      asOf: newest.date ? newest.date.toISOString() : null,
      sampleSize: candles.length,
    };
    await writeCache(TABS_CACHE_NS, CACHE_SCOPE, cacheKey, data, undefined, {
      ttl: ttl(30 * 60, 6 * 60 * 60),
    });
    return { success: true, data };
  } catch (error) {
    console.error("getStockTechnicals error:", error);
    return { success: false, error: "Failed to compute technicals" };
  }
}
