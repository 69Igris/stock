"use server";

/**
 * Stock detail tab data - Financials / Peers / News (MONEY-244 v3.1).
 *
 * Each tab is its own server action so the page only fetches the panel
 * the user is currently looking at. They all share the
 * `instrumentByKey()` resolver to find the right `InstrumentMapping`
 * row from the URL's `(symbol, exchange)` pair.
 *
 * No mock data - if a record is missing in DB the action returns
 * `success: true` with empty/null fields, and the tab renders its
 * own "no data" / loading state.
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core";
import { getNseMarketStatus } from "@usemoney/core";
import { toIstDateKey } from "@usemoney/core/market-data/nse-holidays";
import type { ServiceResult } from "@usemoney/services";
// Type-only: the VALUE (`fetchShareholdingChainDetailed`) is still imported
// dynamically inside the action, so this file stays load-light (MONEY-1146).
import type { ChainOutcome } from "@usemoney/research";
import { findCloseIndexAtOrBefore, pctReturnTo } from "./stock-returns-logic";
import {
  buildCorporateActionCreateManyPayload,
  CORP_ACTIONS_WARMUP_MAX_ROWS,
  splitFinancialsByStatement,
} from "./stock-tabs-logic";

/**
 * Caching policy for stock-tab data.
 *
 * - Financials: quarterly results change at most every 3 months; cache
 *   1h while market is live (just in case a sync runs mid-day) and 6h
 *   when closed. Symbol-scoped key.
 * - Peers: peers list is sticky (Tickertape ranks by sector); 6h.
 * - News: most volatile here - 5 min during live market, 15 min after.
 * - Returns: deterministic from DailyPrice deltas. 30 min while live
 *   (handles end-of-day close roll), 6 h when closed.
 *
 * All writes go through `setCached` with the existing 2-tier (memory +
 * Redis) wrapper, scoped under the existing `discover` cache module.
 */
const TABS_CACHE_NS = "discover" as const;
function liveOrClosed(live: number, closed: number): number {
  return getNseMarketStatus().isLive ? live : closed;
}

// ── Shared types ─────────────────────────────────────────────────

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
   * UTC end-of-period when the source supplied one. OPTIONAL for the same
   * reason `source` is: warm cache entries predate it. It is the SORTABLE key
   * — `period` is a free-text label and "TTM" carries no year, so ordering on
   * the label alone files the freshest figure in the oldest column.
   */
  periodEnd?: string | Date | null;
  /**
   * When THIS row was last refreshed — MONEY-1235. Optional for the same
   * reason `source` and `periodEnd` are (warm cache entries predate it).
   *
   * It exists because rows in one statement no longer share a clock. The XBRL
   * projection refreshes real reporting periods nightly but structurally never
   * emits a `"TTM"` label, so the ~2,123 stored TTM rows keep Tickertape values
   * and a frozen `fetchedAt` for good. Without a per-row stamp the tab cannot
   * tell a current TTM from one that stopped moving five months ago — they
   * render identically.
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

// ── Helpers ──────────────────────────────────────────────────────

async function instrumentIdFor(
  symbol: string,
  exchange: string
): Promise<string | null> {
  const row = await prisma.instrumentMapping.findFirst({
    where: { symbol, exchange, isActive: true },
    select: { id: true },
  });
  return row?.id ?? null;
}

// ── Financials ───────────────────────────────────────────────────

export async function getStockFinancialsAction(args: {
  symbol: string;
  exchange: string;
  /** "QUARTERLY" or "ANNUAL". Default ANNUAL — see the note at the default. */
  periodType?: "ANNUAL" | "QUARTERLY";
}): Promise<
  ServiceResult<{
    income: StockFinancialRow[];
    balance: StockFinancialRow[];
    cashflow: StockFinancialRow[];
  }>
> {
  // ANNUAL, not QUARTERLY (MONEY-1207). The tab overrides this locally, so the
  // default was only ever reached by callers that omit it — and QUARTERLY has 0
  // rows platform-wide, so those callers received an empty payload every time.
  // Kept identical to `packages/services/src/stock-tabs.service.ts` per the
  // standing apps/api parity rule.
  const periodType = args.periodType ?? "ANNUAL";
  // -v3: `periodEnd` joins the payload and the TTM column order depends on it.
  // -v4 (MONEY-1235): `fetchedAt` joins it, and the TTM column's "as of" badge
  // depends on it. Same reasoning as -v2 and -v3 — an entry written before this
  // deploy carries no per-row stamp, so serving one would silently drop the
  // badge on exactly the frozen row it exists to mark, for the 1-6 hours the
  // TTL runs. A bump makes the new column trustworthy immediately.
  // -v5 (MONEY-1300): `basis` joins the payload. A warm -v4 entry carries no
  // basis on any row, so every column of it would render "Basis not stated"
  // for the 1-6 hours the TTL runs — which is a LIE in the opposite direction
  // from the usual cache-staleness one: the data is there, we just would not be
  // serving it. Bumping makes the new column trustworthy on the first request.
  const cacheKey = `stock-financials-v5:${args.symbol}:${args.exchange}:${periodType}`;
  const cached = await getCached<{
    income: StockFinancialRow[];
    balance: StockFinancialRow[];
    cashflow: StockFinancialRow[];
  }>(TABS_CACHE_NS, "_global", cacheKey);
  if (cached) return { success: true, data: cached };

  try {
    // MONEY-1145 — keyed on (symbol, exchange), NOT on instrumentId.
    //
    // This read used to resolve the active InstrumentMapping and query
    // `where: { instrumentId }`. Measured against the dev DB, that made
    // 32,359 of 32,359 rows — 100% of the collection, all 2,123 symbols —
    // unreachable, so the Financials tab was empty for every stock on the
    // platform. The rows were never lost: 1,989 of those symbols have an
    // active mapping right now.
    //
    // `instrumentId` is a MUTABLE denormalised FK. Re-seeding
    // `instrument_mappings` mints new ObjectIds and silently orphans every
    // dependent row — no error, no empty-vs-missing distinction, the feature
    // just goes quiet. `dailyPrice` survives the same event only because the
    // price sync re-resolves ids daily; financials are written once, so they
    // rot from the first re-seed onward.
    //
    // `(symbol, exchange)` is the model's DECLARED natural key — it is the
    // `@@unique([symbol, exchange, statementType, periodType, period])` the
    // writer upserts on, and it is indexed (`@@index([symbol, exchange])`).
    // Reading the same key the writer writes is what makes this stable across
    // future re-seeds, rather than repairable-until-next-time.
    //
    // On the dropped `isActive: true`: it is gone deliberately, and reinstating
    // it would be a fake fix. That flag lives on `instrument_mappings`, not on
    // these rows, so it never gated financials — it gated the id LOOKUP. The
    // hazard someone reaches for it to solve is a recycled ticker (a delisted
    // company's symbol reassigned), and it does not solve that: the new
    // company's mapping IS active, while the old company's rows carry the same
    // (symbol, exchange) and still match. It would cost a query and buy nothing.
    //
    // The page above already declines to gate this — an unknown symbol renders
    // from URL params rather than 404ing — so a delisted symbol reaching here is
    // expected, and serving its real historical financials is the right answer.
    // Recycled tickers stay a known limitation: the model carries no ISIN, so
    // only `fetchedAt` staleness could separate the two companies. Add ISIN to
    // the model before attempting it; do not add a filter that looks like a fix.
    //
    // NOTE: `period` is a free-form upstream string ("Q3-2024", "FY2024", …),
    // so a DB `orderBy:{period:"desc"}` mis-orders lexicographically ('Q4-2023'
    // ahead of 'Q3-2024') and could truncate a recent period under a low `take`.
    // We instead fetch ALL rows for this (instrument, periodType) — a symbol has
    // at most a few dozen (3 statements × ~years/quarters) — and let the client
    // (`StockFinancialsTab`) sort each statement NEWEST-FIRST with the
    // period-aware comparator before taking the latest 6. `period:"desc"` here
    // is only a deterministic DB-side tiebreaker, not the authoritative order.
    const rows = await prisma.stockFinancials.findMany({
      where: { symbol: args.symbol, exchange: args.exchange, periodType },
      orderBy: { period: "desc" },
      take: 150,
      select: {
        period: true,
        // Sortable key — see the type's doc. "TTM" has no year in the label.
        periodEnd: true,
        // Per-ROW freshness — MONEY-1235. Rows in one statement run on
        // different clocks now: the nightly XBRL projection refreshes the
        // reporting periods and can never touch the TTM row.
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
    const data = splitFinancialsByStatement(rows as StockFinancialRow[]);
    await setCached(TABS_CACHE_NS, "_global", cacheKey, data, undefined, {
      ttl: liveOrClosed(60 * 60, 6 * 60 * 60),
    });
    return { success: true, data };
  } catch (error) {
    console.error("getStockFinancialsAction error:", error);
    return { success: false, error: "Failed to load financials" };
  }
}

// ── Peers ────────────────────────────────────────────────────────

export async function getStockPeersAction(args: {
  symbol: string;
  exchange: string;
}): Promise<ServiceResult<StockPeerRow[]>> {
  const cacheKey = `stock-peers:${args.symbol}:${args.exchange}`;
  const cached = await getCached<StockPeerRow[]>(
    TABS_CACHE_NS,
    "_global",
    cacheKey
  );
  if (cached) return { success: true, data: cached };

  try {
    // MONEY-1145 — same fix as financials above: read the natural key
    // `@@unique([symbol, exchange])`, which is what the writer upserts on
    // (`packages/research/src/data-sources/db-store.ts:409`), rather than the
    // mutable `instrumentId`.
    //
    // This one had a second, sharper version of the same fault: when the
    // writer cannot resolve an instrument it stores a SENTINEL
    // `instrumentId: "000000000000000000000000"` and upserts on
    // symbol_exchange anyway — so the row lands under an id that no reader
    // querying by instrumentId can ever match. Keying the read on
    // (symbol, exchange) makes both the sentinel rows and the re-seeded ones
    // visible.
    //
    // The writer this read was waiting for now EXISTS. When this comment was
    // written, `stock_peers` was empty platform-wide (0 rows measured) because
    // nothing populated it outside a StockSage research run, so fixing the key
    // was necessary but not sufficient. MONEY-1145 closed the other half:
    //
    //   packages/services/src/peers-sync.service.ts   derives peers from our
    //                                                 own instruments + ratios
    //                                                 + quotes (no scrape, no
    //                                                 third-party rate limit)
    //   workers/src/routes/peers-sync.ts              the job, mounted at
    //                                                 /jobs/peers-sync
    //   scripts/ops/setup-scheduler.sh                `peers-sync-daily`,
    //                                                 23:15 IST, BOTH envs —
    //                                                 it reads only our DB, so
    //                                                 it is not PROD_ONLY
    //
    // Scheduled after sector-enrichment and price-sync on purpose, so it reads
    // the day's classification and caps. Note peers are selected WITHIN a
    // sector, so an instrument carrying the "N/A" tombstone gets no peer set at
    // all — see MONEY-1172 on why that is currently 67% of the universe.
    const row = await prisma.stockPeers.findFirst({
      where: { symbol: args.symbol, exchange: args.exchange },
      select: { peers: true },
    });
    if (!row || !Array.isArray(row.peers)) {
      return { success: true, data: [] };
    }
    // Each entry shape varies by source - defensively coerce.
    const peers: StockPeerRow[] = (
      row.peers as unknown as Array<Record<string, unknown>>
    )
      .map((p) => {
        const symbol = String(p.symbol ?? p.ticker ?? "");
        if (!symbol) return null;
        const name = String(p.name ?? p.fullName ?? symbol);
        const marketCap = num(p.marketCap ?? p.mcap);
        const pe = num(p.pe ?? p.priceToEarnings);
        const roe = num(p.roe ?? p.returnOnEquity);
        const changePercent = num(p.changePercent ?? p.changePct);
        return { symbol, name, marketCap, pe, roe, changePercent };
      })
      .filter(Boolean) as StockPeerRow[];
    const trimmed = peers.slice(0, 12);
    await setCached(TABS_CACHE_NS, "_global", cacheKey, trimmed, undefined, {
      ttl: 6 * 60 * 60,
    });
    return { success: true, data: trimmed };
  } catch (error) {
    console.error("getStockPeersAction error:", error);
    return { success: false, error: "Failed to load peers" };
  }
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The later of two nullable timestamps, as ISO — MONEY-1235.
 *
 * NOT exported: this file is `"use server"`, so every export must be an async
 * server action. It is duplicated (with the same comment) in
 * `packages/services/src/stock-tabs.service.ts` for the same reason the whole
 * `stock-tabs-logic.ts` pair is duplicated — the `"use server"` boundary is not
 * importable from a package.
 *
 * Invalid dates are treated as ABSENT rather than coerced: `new Date("").
 * getTime()` is NaN, and `Math.max(NaN, x)` is NaN, so one unusable column
 * would otherwise wipe out a perfectly good one.
 */
function latestOfTwo(
  a: Date | null | undefined,
  b: Date | null | undefined
): string | null {
  const ta =
    a instanceof Date && Number.isFinite(a.getTime()) ? a.getTime() : null;
  const tb =
    b instanceof Date && Number.isFinite(b.getTime()) ? b.getTime() : null;
  if (ta === null && tb === null) return null;
  return new Date(Math.max(ta ?? -Infinity, tb ?? -Infinity)).toISOString();
}

// ── News ─────────────────────────────────────────────────────────

export async function getStockNewsAction(args: {
  symbol: string;
  /** Limit number of items returned. Default 12. */
  limit?: number;
}): Promise<ServiceResult<StockNewsItem[]>> {
  const limit = Math.min(50, Math.max(1, args.limit ?? 12));
  const cacheKey = `stock-news:${args.symbol}:${limit}`;
  const cached = await getCached<StockNewsItem[]>(
    TABS_CACHE_NS,
    "_global",
    cacheKey
  );
  if (cached) return { success: true, data: cached };

  try {
    // Note: limit moved to outer scope so it's used in cacheKey above.
    const rows = await prisma.stockNews.findMany({
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
    await setCached(TABS_CACHE_NS, "_global", cacheKey, items, undefined, {
      ttl: liveOrClosed(5 * 60, 15 * 60),
    });
    return { success: true, data: items };
  } catch (error) {
    console.error("getStockNewsAction error:", error);
    return { success: false, error: "Failed to load news" };
  }
}

// ── Returns (the bar chart on Summary tab) ──────────────────────

export async function getStockReturnsAction(args: {
  symbol: string;
  exchange: string;
}): Promise<ServiceResult<StockReturns>> {
  const cacheKey = `stock-returns:${args.symbol}:${args.exchange}`;
  const cached = await getCached<StockReturns>(
    TABS_CACHE_NS,
    "_global",
    cacheKey
  );
  if (cached) return { success: true, data: cached };

  try {
    const instrumentId = await instrumentIdFor(args.symbol, args.exchange);
    if (!instrumentId) return { success: true, data: {} };

    // Fetch the most recent 5+ years of daily closes, ordered desc so we
    // can pick known offsets directly. 5Y * 252 trading days = ~1260 rows.
    const closes = await prisma.dailyPrice.findMany({
      where: { instrumentId },
      orderBy: { date: "desc" },
      take: 1500,
      select: { date: true, close: true },
    });
    if (closes.length < 2) return { success: true, data: {} };

    const ret: StockReturns = {};

    // Return-window math lives in ./stock-returns-logic.ts (pure, unit-tested).
    const pctTo = (idx: number) => pctReturnTo(closes, idx);
    const findIndexAtOrBefore = (days: number) =>
      findCloseIndexAtOrBefore(closes, days);

    // 1D = next bar in the desc-sorted array (i.e. previous trading day's close).
    ret["1D"] = pctTo(1);
    ret["1W"] = pctTo(findIndexAtOrBefore(7));
    ret["1M"] = pctTo(findIndexAtOrBefore(30));
    ret["3M"] = pctTo(findIndexAtOrBefore(91));
    ret["6M"] = pctTo(findIndexAtOrBefore(182));
    ret["1Y"] = pctTo(findIndexAtOrBefore(365));
    ret["3Y"] = pctTo(findIndexAtOrBefore(365 * 3));
    ret["5Y"] = pctTo(findIndexAtOrBefore(365 * 5));

    await setCached(TABS_CACHE_NS, "_global", cacheKey, ret, undefined, {
      ttl: liveOrClosed(30 * 60, 6 * 60 * 60),
    });
    return { success: true, data: ret };
  } catch (error) {
    console.error("getStockReturnsAction error:", error);
    return { success: false, error: "Failed to compute returns" };
  }
}

// ── Shareholding pattern (MONEY-610) ─────────────────────────────

export interface ShareholdingPoint {
  quarter: string;
  promoter: number;
  fii: number;
  dii: number;
  public: number;
}

/** Wall-clock budget for the live shareholding scrape on the request path. */
const SHAREHOLDING_FETCH_BUDGET_MS = 8_000;

/**
 * How old a persisted shareholding row may be before we refetch.
 *
 * Shareholding is disclosed quarterly, so 30 days re-checks a few times per
 * filing period without hammering the vendor. The bound exists because the
 * write path is insert-only with no refresher — without it, the first
 * successful fetch is the last one that symbol ever gets.
 */
const SHAREHOLDING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Distinguishes OUR timeout from anything the source chain produced. */
class ShareholdingBudgetExceeded extends Error {
  constructor() {
    super("shareholding fetch exceeded its wall-clock budget");
    this.name = "ShareholdingBudgetExceeded";
  }
}

/** One quarter as the source chain / DB return it. */
interface ShareholdingRow {
  quarter: string;
  promoter: number | null;
  fii: number | null;
  dii: number | null;
  public: number | null;
}

/**
 * Newest quarter first, WITHOUT trusting the string's sort order.
 *
 * `quarter` is free-form upstream text ("Q3-2024", "Mar 2024", "FY2024"), so a
 * lexicographic sort orders by quarter number before year. Parse a year and a
 * quarter-ish ordinal out of it and sort on those; anything unparseable keeps
 * its original relative position rather than being thrown to one end.
 */
// NOT exported: this module is `"use server"`, where every export must be an
// async function (the build fails otherwise). Only this file uses it.
function sortQuartersNewestFirst(
  points: ShareholdingPoint[]
): ShareholdingPoint[] {
  const rank = (q: string): number => {
    const year = /(\d{4})/.exec(q);
    if (!year) return Number.NEGATIVE_INFINITY;
    const qtr = /Q([1-4])/i.exec(q);
    const month = /jan|feb|mar/i.test(q)
      ? 1
      : /apr|may|jun/i.test(q)
        ? 2
        : /jul|aug|sep/i.test(q)
          ? 3
          : /oct|nov|dec/i.test(q)
            ? 4
            : 0;
    return Number(year[1]) * 10 + (qtr ? Number(qtr[1]) : month);
  };
  return points
    .map((p, i) => ({ p, i, r: rank(p.quarter) }))
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .map((x) => x.p);
}

/**
 * Quarterly shareholding pattern (promoter / FII / DII / public).
 *
 * MONEY-1146 — three things changed here, in order of how much they mattered:
 *
 * 1. **A FAILED fetch no longer masquerades as "no data".** This used to
 *    `catch` everything and return `{ success: true, shareholding: [] }`, so a
 *    blocked scrape, a rate-limit, a vendor layout change and a genuinely
 *    uncovered symbol all rendered the identical empty panel, with nothing in
 *    the logs to tell them apart. The feature could have been dead for months
 *    without a signal — and that is exactly what "audit this" turned up.
 *    Failures now return `success: false`, which the tab ALREADY renders as a
 *    distinct error state (`StockShareholdingTab.tsx:73-77`); that branch was
 *    simply unreachable.
 *
 * 2. **The DB is consulted first.** `StockShareholding` has existed all along
 *    (`schema.prisma`, `@@unique([symbol, exchange, quarter])`) with a writer
 *    in `packages/research` that nothing ever called, while this action
 *    scraped a third party synchronously on every request. Now: read the
 *    table, fall back to the live chain only on a miss, and PERSIST what comes
 *    back — so one successful fetch immunises every later view against the
 *    vendor being down.
 *
 * 3. **The live fetch is bounded.** Same wall-clock race as
 *    `warmCorporateActions` below, so a hung vendor cannot hold the request
 *    open for the whole function timeout.
 *
 * Deliberately NOT cached on the empty/failed path — caching a
 * "couldn't determine" answer would pin the failure for the TTL and make the
 * next request lie about it.
 */
export async function getShareholdingAction(args: {
  symbol: string;
  exchange: string;
}): Promise<ServiceResult<{ shareholding: ShareholdingPoint[] }>> {
  const cacheKey = `stock-shareholding:${args.symbol}:${args.exchange}`;
  const cached = await getCached<ShareholdingPoint[]>(
    TABS_CACHE_NS,
    "_global",
    cacheKey
  );
  if (cached) return { success: true, data: { shareholding: cached } };

  const toPoint = (r: {
    quarter: string;
    promoter: number | null;
    fii: number | null;
    dii: number | null;
    public: number | null;
  }): ShareholdingPoint => ({
    quarter: r.quarter,
    // `?? 0` is deliberate at the RENDER boundary (ShareholdingPoint is a
    // number-typed stacked bar) but it does invent a figure: a null promoter
    // holding is "not reported", not "0%". Tracked on MONEY-1146 — widening
    // ShareholdingPoint to nullable touches the chart component, so it is not
    // folded into a correctness hotfix.
    promoter: r.promoter ?? 0,
    fii: r.fii ?? 0,
    dii: r.dii ?? 0,
    public: r.public ?? 0,
  });

  // (a) DB first — keyed on the natural key, same lesson as MONEY-1145.
  try {
    // NOTE: no `orderBy: { quarter: "desc" }`. `quarter` is a free-form
    // upstream string ("Q3-2024", "Mar 2024", …), so a lexicographic DESC sorts
    // by quarter NUMBER before year — `Q4-2020` outranks `Q1-2025`. The
    // financials reader 300 lines above documents this exact hazard and sorts
    // period-aware in the client; this read now does the same rather than
    // trusting the string. `StockShareholdingTab` slices the first 8 assuming
    // newest-first, so getting it wrong shows the OLDEST two years.
    const stored = await prisma.stockShareholding.findMany({
      where: { symbol: args.symbol, exchange: args.exchange },
      take: 24,
      select: {
        quarter: true,
        promoter: true,
        fii: true,
        dii: true,
        public: true,
        fetchedAt: true,
      },
    });
    // STALENESS BOUND. `stored.length > 0` alone would serve whatever landed
    // first, forever: `persistShareholding` only INSERTS missing quarters and
    // never updates, nothing schedules a refresh, and the only other writer
    // (`db-store.ts#getOrFetchShareholding`) has no callers. So a single old
    // StockSage run that wrote one synthetic quarter would pin that symbol to
    // one quarter permanently. Shareholding is filed quarterly, so a row older
    // than this is refetched rather than trusted.
    const freshest = stored.reduce<number>(
      (max, r) => Math.max(max, r.fetchedAt?.getTime() ?? 0),
      0
    );
    const isStale = Date.now() - freshest > SHAREHOLDING_MAX_AGE_MS;
    if (stored.length > 0 && !isStale) {
      const shareholding = sortQuartersNewestFirst(stored.map(toPoint));
      await setCached(
        TABS_CACHE_NS,
        "_global",
        cacheKey,
        shareholding,
        undefined,
        { ttl: liveOrClosed(60 * 60, 6 * 60 * 60) }
      );
      return { success: true, data: { shareholding } };
    }
  } catch (error) {
    // A DB failure here is not fatal — fall through to the live chain rather
    // than failing the tab. Logged so it is not silent.
    console.error("[shareholding] db read failed", {
      symbol: args.symbol,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // (b) Live chain, bounded.
  //
  // CORRECTNESS NOTE — this is where the first attempt at MONEY-1146 got it
  // backwards, and the shape of the collaborator is why.
  //
  // `fetchShareholdingChain` NEVER returns `[]` and never throws. `tryChain`
  // (packages/research/src/data-sources/data-source-chain.ts) catches every
  // exception from every source, and each client returns `null` for an empty
  // response as well as for a failure — e.g. `tickertape-client.ts`:
  // `if (!resp?.data?.length) return null`. So `null` is the ORDINARY "this
  // symbol has no shareholding coverage" answer (BSE-only, SME/Emerge, newly
  // listed), NOT a signal of failure.
  //
  // The first version raced it against a timeout that also RESOLVED `null`,
  // then treated `null` as a failure. That put a red error panel on every
  // uncovered symbol — strictly worse than the swallow it replaced, and
  // permanent, since nothing is persisted for those symbols to rescue later.
  //
  // So: the timeout REJECTS (matching `warmCorporateActions` below, which is
  // the part that actually made it a good model), and `null` from the chain
  // means "no coverage" and returns an empty, cacheable success.
  //
  // THE REMAINING HALF, now closed. `tryChain` used to swallow every source
  // error, so a blocked scrape and an uncovered symbol were indistinguishable
  // here — the earlier revision of this comment said so and deferred it.
  // `fetchShareholdingChainDetailed` (packages/research) now reports HOW the
  // chain ended: `errors` is non-empty only when a source actually threw.
  // Adding a second entry point rather than widening `tryChain` keeps the nine
  // other chain consumers untouched.
  let outcome: ChainOutcome<ShareholdingRow[]>;
  let budget: ReturnType<typeof setTimeout> | undefined;
  try {
    const { fetchShareholdingChainDetailed } =
      await import("@usemoney/research");
    outcome = await Promise.race([
      fetchShareholdingChainDetailed(args.symbol),
      new Promise<never>((_resolve, reject) => {
        budget = setTimeout(
          () => reject(new ShareholdingBudgetExceeded()),
          SHAREHOLDING_FETCH_BUDGET_MS
        );
      }),
    ]);
  } catch (error) {
    const timedOut = error instanceof ShareholdingBudgetExceeded;
    console.error("[shareholding] live fetch failed", {
      symbol: args.symbol,
      exchange: args.exchange,
      timedOut,
      budgetMs: timedOut ? SHAREHOLDING_FETCH_BUDGET_MS : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    // A timeout, or a throw the chain did not swallow (e.g. the dynamic import
    // failing). Both are genuine failures and are reported as such.
    return {
      success: false,
      error: "Couldn't load shareholding data right now. Please try again.",
    };
  } finally {
    if (budget) clearTimeout(budget);
  }

  // MONEY-1146 — the distinction the whole ticket is about. Exhausted with
  // errors means the scrape is broken and the user must be told; exhausted
  // cleanly means this symbol genuinely has no shareholding coverage (BSE-only,
  // SME/Emerge, newly listed), which is an ordinary answer the neutral empty
  // state exists for. These used to render identically.
  // A chain that answered but lost sources on the way is the DEGRADATION that
  // precedes total failure, and it used to pass silently: the branch below only
  // fires once every source is gone. So tickertape could start 403ing, the
  // fallback could cover it, and the first signal anyone got would be the day
  // the fallback broke too — one source later than MONEY-1146 meant to catch.
  if (outcome.errors.length > 0 && outcome.data !== null) {
    console.warn("[shareholding] chain degraded — served from a fallback", {
      symbol: args.symbol,
      exchange: args.exchange,
      failed: outcome.errors.map((e) => `${e.source}: ${e.message}`),
    });
  }

  if (outcome.data === null && outcome.errors.length > 0) {
    console.error("[shareholding] every source failed", {
      symbol: args.symbol,
      exchange: args.exchange,
      sources: outcome.errors.map((e) => e.source),
      errors: outcome.errors.map((e) => `${e.source}: ${e.message}`),
    });
    return {
      success: false,
      error: "Couldn't load shareholding data right now. Please try again.",
    };
  }

  // `null` with no errors ⇒ no coverage for this symbol. A real, cacheable
  // answer — and the one the tab's neutral empty state exists for.
  const shareholding: ShareholdingPoint[] = (outcome.data ?? []).map(toPoint);

  if (shareholding.length === 0) {
    return { success: true, data: { shareholding } };
  }

  await setCached(TABS_CACHE_NS, "_global", cacheKey, shareholding, undefined, {
    ttl: liveOrClosed(60 * 60, 6 * 60 * 60),
  });

  // (c) Persist, so the next view does not depend on the vendor being up.
  // Best-effort: never let a write failure break a successful read.
  void persistShareholding(args.symbol, args.exchange, shareholding).catch(
    (error) => {
      console.error("[shareholding] persist failed", {
        symbol: args.symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  );

  return { success: true, data: { shareholding } };
}

/**
 * Write fetched quarters to `StockShareholding`.
 *
 * `instrumentId` is a REQUIRED column on this model, so an unresolvable
 * instrument means we cannot persist — we return the data to the caller
 * anyway rather than failing the read. Deliberately NOT writing a sentinel id
 * the way `stock_peers` does: a fake foreign key is what made those rows
 * unreadable in the first place (MONEY-1145).
 */
async function persistShareholding(
  symbol: string,
  exchange: string,
  points: ShareholdingPoint[]
): Promise<void> {
  const instrumentId = await instrumentIdFor(symbol, exchange);
  if (!instrumentId) return;

  // Prisma's MongoDB connector does not support `skipDuplicates` on
  // `createMany`, so dedupe against what is already stored before writing —
  // the same shape `warmCorporateActions` uses below. Without this, a second
  // fetch would violate `@@unique([symbol, exchange, quarter])`.
  const existing = await prisma.stockShareholding.findMany({
    where: { symbol, exchange, quarter: { in: points.map((p) => p.quarter) } },
    select: { quarter: true },
  });
  const seen = new Set(existing.map((r) => r.quarter));
  const fresh = points.filter((p) => !seen.has(p.quarter));
  if (fresh.length === 0) return;

  await prisma.stockShareholding.createMany({
    data: fresh.map((p) => ({
      instrumentId,
      symbol,
      exchange,
      quarter: p.quarter,
      promoter: p.promoter,
      fii: p.fii,
      dii: p.dii,
      public: p.public,
      source: "TICKERTAPE",
    })),
  });
}

// ── Fundamental ratios (MONEY-796) ───────────────────────────────

/**
 * Snapshot of the daily-synced `StockRatios` row (1:1 with the instrument).
 * Grouped on the client into Valuation / Profitability / Growth / Leverage /
 * Market. Every field is nullable — the card omits missing ones rather than
 * rendering "NaN".
 *
 * `targetPrice` / `recommendation` are THIRD-PARTY analyst data surfaced as
 * DATA only (see StockAnalystSnapshot) — UseMoney never issues advice.
 */
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
   * THE ANALYST CLOCK — MONEY-1235. Do not read this as "when these ratios were
   * computed"; it is when the row was last FETCHED from an upstream, which for
   * every symbol on the platform means when Tickertape last answered.
   *
   * `xbrl-ratios-daily` derives 26 of this model's 28 columns nightly from our
   * own filings and close history and stamps `ratiosDerivedAt`, deliberately
   * leaving `fetchedAt` alone — because `targetPrice` and `recommendation` are
   * sell-side analyst opinion that nothing writes any more, and `fetchedAt` is
   * exactly the right age signal for those two. `StockAnalystSnapshot` gates on
   * it for that reason.
   */
  fetchedAt: string | null;
  /**
   * THE DERIVED CLOCK — MONEY-1235. When `xbrl-ratios` last recomputed the 23
   * columns it owns. Optional because every warm cache entry predates it.
   */
  ratiosDerivedAt?: string | null;
  /**
   * `max(fetchedAt, ratiosDerivedAt)` — the age of the ratios a card actually
   * renders. This is the one to show as "as of"; `fetchedAt` alone reports a
   * frozen March date over numbers that are hours old.
   */
  dataAsOf?: string | null;
}

/**
 * Fundamental ratios for the stock-detail Overview "Fundamentals" card.
 * Reads the daily-synced `StockRatios` row by `(symbol, exchange)` (unique).
 * Returns `null` data (not an error) when the row is missing so the card
 * renders its own empty state. 6h-when-closed / 1h-when-live cache.
 */
export async function getStockRatiosAction(
  symbol: string,
  exchange: string
): Promise<ServiceResult<StockRatiosData | null>> {
  // -v2 (MONEY-1235): `ratiosDerivedAt` + `dataAsOf` join the payload. A warm
  // entry written before this deploy carries neither, so `dataAsOf` would read
  // as the frozen `fetchedAt` and report day-fresh ratios as months old — a
  // wrong answer rather than a missing one, which is the bar for a bump.
  const cacheKey = `stock-ratios-v2:${symbol}:${exchange}`;
  const cached = await getCached<StockRatiosData | null>(
    TABS_CACHE_NS,
    "_global",
    cacheKey
  );
  if (cached !== undefined && cached !== null) {
    return { success: true, data: cached };
  }

  try {
    const row = await prisma.stockRatios.findFirst({
      where: { symbol, exchange },
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
      pe: num(row.pe),
      pb: num(row.pb),
      evToEbitda: num(row.evToEbitda),
      pegRatio: num(row.pegRatio),
      roe: num(row.roe),
      roa: num(row.roa),
      roce: num(row.roce),
      grossMargin: num(row.grossMargin),
      operatingMargin: num(row.operatingMargin),
      netMargin: num(row.netMargin),
      revenueGrowth: num(row.revenueGrowth),
      earningsGrowth: num(row.earningsGrowth),
      revenueGrowth3Y: num(row.revenueGrowth3Y),
      earningsGrowth3Y: num(row.earningsGrowth3Y),
      revenueGrowth5Y: num(row.revenueGrowth5Y),
      earningsGrowth5Y: num(row.earningsGrowth5Y),
      debtToEquity: num(row.debtToEquity),
      currentRatio: num(row.currentRatio),
      interestCoverage: num(row.interestCoverage),
      beta: num(row.beta),
      dividendYield: num(row.dividendYield),
      marketCap: num(row.marketCap),
      enterpriseValue: num(row.enterpriseValue),
      targetPrice: num(row.targetPrice),
      recommendation: row.recommendation ?? null,
      source: row.source ?? "TICKERTAPE",
      fetchedAt: row.fetchedAt ? row.fetchedAt.toISOString() : null,
      ratiosDerivedAt: row.ratiosDerivedAt
        ? row.ratiosDerivedAt.toISOString()
        : null,
      // MONEY-1235 — `max` of the two clocks, computed once here so every
      // reader (web card, `/v1`, anything downstream) agrees on one answer
      // instead of each picking a column and drifting.
      dataAsOf: latestOfTwo(row.fetchedAt, row.ratiosDerivedAt),
    };
    await setCached(TABS_CACHE_NS, "_global", cacheKey, data, undefined, {
      ttl: liveOrClosed(60 * 60, 6 * 60 * 60),
    });
    return { success: true, data };
  } catch (error) {
    console.error("getStockRatiosAction error:", error);
    return { success: false, error: "Failed to load fundamentals" };
  }
}

// ── Technicals (MONEY-796) ───────────────────────────────────────

/**
 * Computed technical snapshot for the stock-detail "Technicals" card.
 * Descriptive indicators only — RSI, SMA20/50/200 + price-vs-SMA position,
 * MACD, 52-week distance, golden/death cross. No buy/sell semantics; the
 * card frames every value as DATA (educational).
 */
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

/**
 * Technical indicators over `DailyPrice` (the same table the returns bars
 * read). Computed in-memory via the shared `computeIndicators` library so
 * the maths stays in one place (and matches the screener). Returns `null`
 * data when there isn't enough history. 30m-live / 6h-closed cache.
 */
export async function getStockTechnicalsAction(args: {
  symbol: string;
  exchange: string;
}): Promise<ServiceResult<StockTechnicalsData | null>> {
  const cacheKey = `stock-technicals:${args.symbol}:${args.exchange}`;
  const cached = await getCached<StockTechnicalsData | null>(
    TABS_CACHE_NS,
    "_global",
    cacheKey
  );
  if (cached !== undefined && cached !== null) {
    return { success: true, data: cached };
  }

  try {
    const instrumentId = await instrumentIdFor(args.symbol, args.exchange);
    if (!instrumentId) return { success: true, data: null };

    // Need ~200+ closes for SMA200; pull a generous window. Ordered desc
    // for the query, then reversed to oldest-first for computeIndicators.
    const closesDesc = await prisma.dailyPrice.findMany({
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

    const { computeIndicators } =
      await import("@usemoney/core/market-data/technical-indicators");
    const candles = [...closesDesc].reverse().map((r) => ({
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
    const ind = computeIndicators(candles);
    const newest = closesDesc[0]!;

    const data: StockTechnicalsData = {
      price: num(newest.close),
      rsi14: num(ind.rsi14),
      sma20: num(ind.sma20),
      sma50: num(ind.sma50),
      sma200: num(ind.sma200),
      macd: num(ind.macd),
      macdSignal: num(ind.macdSignal),
      macdHistogram: num(ind.macdHistogram),
      price52WeekHigh: num(ind.price52WeekHigh),
      price52WeekLow: num(ind.price52WeekLow),
      distanceFrom52WeekHigh: num(ind.distanceFrom52WeekHigh),
      distanceFrom52WeekLow: num(ind.distanceFrom52WeekLow),
      goldenCross: ind.goldenCross ?? null,
      deathCross: ind.deathCross ?? null,
      asOf: newest.date ? newest.date.toISOString() : null,
      sampleSize: candles.length,
    };
    await setCached(TABS_CACHE_NS, "_global", cacheKey, data, undefined, {
      ttl: liveOrClosed(30 * 60, 6 * 60 * 60),
    });
    return { success: true, data };
  } catch (error) {
    console.error("getStockTechnicalsAction error:", error);
    return { success: false, error: "Failed to compute technicals" };
  }
}

// ── Corporate actions (MONEY-610) ────────────────────────────────

export interface CorporateActionRow {
  /** "DIVIDEND" | "SPLIT" | "BONUS" | "RIGHTS" | … */
  actionType: string;
  exDate: string | null; // YYYY-MM-DD
  recordDate: string | null;
  details: string;
}

/**
 * Corporate actions (dividends / splits / bonuses / rights) from NSE filings.
 * Live-fetched + cached under `discover`. Returns empty (not an error) when NSE
 * has nothing or the fetch fails, so the card renders its own empty state.
 */
export async function getCorporateActionsAction(args: {
  symbol: string;
  exchange: string;
}): Promise<ServiceResult<{ actions: CorporateActionRow[] }>> {
  const cacheKey = `stock-corp-actions:${args.symbol}:${args.exchange}`;
  const cached = await getCached<CorporateActionRow[]>(
    TABS_CACHE_NS,
    "_global",
    cacheKey
  );
  if (cached) return { success: true, data: { actions: cached } };

  try {
    const { fetchNSECorporateActions } = await import("@usemoney/research");
    const raw = await fetchNSECorporateActions(args.symbol);
    // IST, not UTC — MONEY-1527. `exDate` and `recordDate` are
    // corporate-action INSTANTS, and prod stores them in two conventions
    // (18:30Z = IST midnight for 48,224 rows, 00:00Z for 10,863), so a UTC
    // slice renders the majority one calendar day early. This card sits on the
    // same page as the chart, whose glyph is now placed on the correct candle
    // — leaving this alone would have the two halves of one page disagree
    // about when the split happened.
    //
    // Still guards the invalid case: NSE sometimes returns unparseable
    // ex/record dates, and `toIstDateKey` does NOT throw on one — it renders
    // the literal "NaN-NaN-NaN", which looks like a date and is worse.
    const safeISODate = (d: Date | null | undefined): string | null =>
      d && !Number.isNaN(d.getTime()) ? toIstDateKey(d) : null;
    const actions: CorporateActionRow[] = (raw ?? []).map((a) => ({
      actionType: a.actionType,
      exDate: safeISODate(a.exDate),
      recordDate: safeISODate(a.recordDate),
      details: a.details,
    }));
    if (actions.length > 0) {
      await setCached(TABS_CACHE_NS, "_global", cacheKey, actions, undefined, {
        ttl: liveOrClosed(60 * 60, 6 * 60 * 60),
      });
    }
    return { success: true, data: { actions } };
  } catch (error) {
    console.error("getCorporateActionsAction error:", error);
    return { success: true, data: { actions: [] } };
  }
}

// ── Corporate actions & dividends — persisted history (MONEY-797 / C3b) ──────

/**
 * A persisted corporate-action row for the stock-detail history view.
 * Superset of `CorporateActionRow` with the parsed value/ratio + provenance.
 * `actionType` is the normalised taxonomy (DIVIDEND | BONUS | SPLIT | RIGHTS |
 * AGM | BUYBACK | OTHER). Descriptive only — just exchange-filing data.
 */
export interface CorporateActionHistoryRow {
  actionType: string;
  exDate: string | null; // YYYY-MM-DD
  recordDate: string | null;
  details: string;
  value: number | null;
  ratio: string | null;
  source: string | null;
}

// IST, not UTC — MONEY-1527. `exDate` and `recordDate` are corporate-action
// INSTANTS, and prod stores them in two conventions (18:30Z = IST midnight for
// 48,224 rows, 00:00Z for 10,863), so a UTC slice renders the majority one
// calendar day early. This card sits on the same page as the chart, whose
// glyph is now placed on the correct candle — leaving this alone would have
// the two halves of one page disagree about when the split happened.
//
// Still guards the invalid case: NSE sometimes returns unparseable ex/record
// dates, and `toIstDateKey` does NOT throw on one — it renders the literal
// "NaN-NaN-NaN", which is worse than a throw because it looks like a date.
const safeISODate = (d: Date | null | undefined): string | null =>
  d && !Number.isNaN(d.getTime()) ? toIstDateKey(d) : null;

/**
 * Wall-clock budget for the live NSE scrape on the request path. The scraper
 * itself does a session-cookie fetch + the corporate-actions fetch (each with
 * its own internal `ky` timeout), but this warm-up runs synchronously inside a
 * client-triggered request, so we cap the TOTAL by racing the fetch against a
 * self-clearing timeout. On timeout we treat the fetch as "no data" and serve
 * whatever is already persisted — never blocking the response on a slow/hung NSE.
 */
const CORP_ACTIONS_FETCH_BUDGET_MS = 8_000;

/**
 * Idempotent read-through warm-up: live-fetch NSE corporate actions for a
 * symbol (bounded by a wall-clock budget) and persist what the fetcher's own
 * parse produced — type, post:pre ratio, face values, dividend — the SAME
 * parse the nightly writes (MONEY-1535), into
 * `CorporateAction` in a SINGLE `createMany({ skipDuplicates: true })` keyed on
 * the `(symbol, exchange, actionType, exDate)` unique index — one round-trip
 * instead of N sequential findFirst+update/create. Best-effort — a fetch
 * failure / timeout yields `[]`, and a write failure is swallowed (the next
 * read still serves whatever persisted). Returns the rows it tried to persist so
 * the action can re-read the canonical DB shape.
 */
async function warmCorporateActions(
  symbol: string,
  exchange: string,
  instrumentId: string | null
): Promise<CorporateActionHistoryRow[]> {
  const { fetchNSECorporateActions } = await import("@usemoney/research");

  // (a) Bound the live scrape with a wall-clock budget so a slow/hung NSE can't
  // pin the request. We race the fetch against a self-clearing timeout (cleared
  // on settle so no timer leaks past the call); on timeout we never throw.
  let raw: Awaited<ReturnType<typeof fetchNSECorporateActions>>;
  let budget: ReturnType<typeof setTimeout> | undefined;
  try {
    raw = await Promise.race([
      fetchNSECorporateActions(symbol),
      new Promise<never>((_, reject) => {
        budget = setTimeout(
          () => reject(new Error("NSE corporate-actions fetch timed out")),
          CORP_ACTIONS_FETCH_BUDGET_MS
        );
      }),
    ]);
  } catch (e) {
    console.warn("warmCorporateActions fetch skipped:", e);
    return [];
  } finally {
    if (budget) clearTimeout(budget);
  }

  const records = raw ?? [];
  if (records.length === 0) return [];

  // (b) bound the rows + (c) collapse in-payload duplicates and guard every Date
  // field via the pure builder, then (d) persist only the rows not already
  // stored. MongoDB Prisma `createMany` has NO `skipDuplicates` (SQL-only), so we
  // pre-filter against the already-persisted `@@unique([symbol,exchange,
  // actionType,exDate])` keys — ONE findMany + ONE createMany instead of the
  // per-row find→update/create chatter. The unique index + the try/catch guard a
  // concurrent warm-up race.
  const data = buildCorporateActionCreateManyPayload(
    records,
    exchange,
    instrumentId,
    CORP_ACTIONS_WARMUP_MAX_ROWS
  );
  if (data.length === 0) return [];

  const corpKey = (s: unknown, a: unknown, d: unknown): string =>
    `${String(s)}|${String(a)}|${d instanceof Date ? d.getTime() : "null"}`;

  try {
    const symbols = [...new Set(data.map((r) => r.symbol))];
    const existing = await prisma.corporateAction.findMany({
      where: { symbol: { in: symbols }, exchange },
      select: { symbol: true, type: true, exDate: true },
    });
    const seen = new Set(
      existing.map((r) => corpKey(r.symbol, r.type, r.exDate))
    );
    const fresh = data.filter(
      (r) => !seen.has(corpKey(r.symbol, r.type, r.exDate))
    );
    if (fresh.length > 0) {
      await prisma.corporateAction.createMany({ data: fresh });
    }
  } catch (e) {
    // A write failure must not abort the warm-up — the subsequent read still
    // serves whatever was already persisted.
    console.warn("warmCorporateActions persist skipped:", e);
  }

  // Map main's stored shape back to the UI row (actionType / numeric value /
  // ratio-as-string), so the stock-detail history card is unchanged.
  return data.map((r) => ({
    actionType: r.type,
    exDate: safeISODate(r.exDate),
    recordDate: safeISODate(r.recordDate),
    details: r.details,
    value: r.dividendPerShare ?? r.ratio,
    ratio: r.ratio != null ? String(r.ratio) : null,
    source: r.source,
  }));
}

/**
 * Corporate-actions history (DB-first, read-through). Reads persisted
 * `CorporateAction` rows by `(symbol, exchange)`, newest ex-date first. On an
 * empty DB it warms up from the live NSE fetch (persisting what it finds) so
 * the next view is instant. Returns empty (not an error) on a total miss so the
 * card renders its own empty state. SEBI-neutral — exchange-filing data only.
 */
export async function getCorporateActionsHistoryAction(
  symbol: string,
  exchange: string
): Promise<ServiceResult<{ actions: CorporateActionHistoryRow[] }>> {
  const cacheKey = `stock-corp-actions-history:${symbol}:${exchange}`;
  const cached = await getCached<CorporateActionHistoryRow[]>(
    TABS_CACHE_NS,
    "_global",
    cacheKey
  );
  if (cached) return { success: true, data: { actions: cached } };

  try {
    const instrumentId = await instrumentIdFor(symbol, exchange);

    const read = async (): Promise<CorporateActionHistoryRow[]> => {
      const rows = await prisma.corporateAction.findMany({
        where: { symbol, exchange },
        orderBy: [{ exDate: "desc" }, { updatedAt: "desc" }],
        take: 60,
        select: {
          type: true,
          exDate: true,
          recordDate: true,
          details: true,
          ratio: true,
          dividendPerShare: true,
          source: true,
        },
      });
      return rows.map((r) => ({
        actionType: r.type,
        exDate: safeISODate(r.exDate),
        recordDate: safeISODate(r.recordDate),
        details:
          typeof r.details === "string"
            ? r.details
            : r.details == null
              ? ""
              : JSON.stringify(r.details),
        value: num(r.dividendPerShare ?? r.ratio),
        ratio: r.ratio != null ? String(r.ratio) : null,
        source: r.source,
      }));
    };

    let actions = await read();

    // Read-through warm-up: nothing persisted yet → live-fetch + persist, then
    // re-read so the response reflects the canonical (ordered) DB shape.
    if (actions.length === 0) {
      const warmed = await warmCorporateActions(symbol, exchange, instrumentId);
      if (warmed.length > 0) actions = await read();
    }

    if (actions.length > 0) {
      await setCached(TABS_CACHE_NS, "_global", cacheKey, actions, undefined, {
        ttl: liveOrClosed(60 * 60, 6 * 60 * 60),
      });
    }
    return { success: true, data: { actions } };
  } catch (error) {
    console.error("getCorporateActionsHistoryAction error:", error);
    return { success: true, data: { actions: [] } };
  }
}

// NOTE: a dividend-only convenience action was removed (MONEY-805) — it had
// zero callers. The stock-detail dividend view filters the corporate-actions
// history inline (`StockCorpActionsHistoryCard`, actionType === "DIVIDEND"),
// so there is no separate server action to keep in sync.
