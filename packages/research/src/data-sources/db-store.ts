/**
 * DB-First Data Access Layer
 *
 * Implements the getOrFetch pattern:
 * 1. Check MongoDB first
 * 2. If missing or stale → fetch from external API
 * 3. Persist result to MongoDB
 * 4. Return data
 *
 * This ensures all market data is persistent and available for
 * the screener engine, RAG pipeline, and future backtesting.
 */

import prisma from "@usemoney/database";
import { isStale } from "@usemoney/core/market-data/staleness";
import {
  mayOverwriteFinancials,
  dedupeShareholdingByQuarter,
} from "@usemoney/core/market-data";
// MONEY-1300 — the shared basis vocabulary. Subpath, not the barrel.
import { normalizeStockFinancialsBasis } from "@usemoney/core/market-data/financials-basis";
// MONEY-1220: `./tickertape-client` is no longer imported here AT ALL. Every
// read path in this file now serves what a nightly job stored, so there is
// nothing left to fetch — and an import that is merely unused is one edit away
// from being used again. The mapper helpers below stay: they still decode rows
// that Tickertape wrote before the switchover, and the research agent's
// on-demand tools still call them.
import {
  groupFinancials,
  mapTickertapeStatementRow,
  tickertapeStatementColumns,
  // MONEY-1235 — ordering / provenance / the frozen TTM row. All pure, all in
  // the sibling logic module so they can be executed by a test; this file
  // imports Prisma at module scope and cannot be loaded under node:test.
  sortFinancialsNewestFirst,
  pickNewestPeriodicRow,
  authorityMaxSource,
  describeStaleTtm,
  annotateStaleTtmRows,
  latestRatiosTimestamp,
  type StaleTtmNotice,
  type TickertapeFinancialColumn,
  type TickertapeStatementType,
} from "./db-store-logic";
import type { FinancialStatement } from "../types";

const logger = {
  info: (...args: unknown[]) => console.log("[db-store]", ...args),
  warn: (...args: unknown[]) => console.warn("[db-store]", ...args),
  error: (...args: unknown[]) => console.error("[db-store]", ...args),
};

// ── Helpers ──────────────────────────────────────────────────────────

async function resolveInstrument(symbol: string, exchange?: string) {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const ex = exchange || "NSE";

  return prisma.instrumentMapping.findFirst({
    where: { symbol: clean, exchange: ex, isActive: true },
  });
}

// ── Financials ───────────────────────────────────────────────────────

export interface FinancialsResult {
  income: Record<string, unknown>[];
  balanceSheet: Record<string, unknown>[];
  cashFlow: Record<string, unknown>[];
  /**
   * The BEST source present across the returned rows, not the source of any one
   * of them — MONEY-1235. See `authorityMaxSource`. Per-period provenance is
   * still on every row (`groupFinancials` spreads the row's own columns).
   */
  source: string;
  fromCache: boolean;
  /**
   * Set when a frozen `TTM` row is riding along with rows that are still being
   * refreshed — MONEY-1235. `null` means either "no TTM row" or "cannot tell",
   * which are deliberately NOT distinguished here: neither is a claim that the
   * TTM figure is current, and only a positive finding is actionable.
   */
  staleTtm: StaleTtmNotice | null;
}

/**
 * Get financials for a stock. DB first, Tickertape on miss/stale.
 */
/**
 * Financials for a stock. **Our own tables, always** — MONEY-1220.
 *
 * ## What changed and why
 *
 * This used to read the DB first and fall through to Tickertape on a miss or on
 * staleness. Tickertape now returns 403 to our Cloud Run egress — it has
 * blocked us, which is permanent and silent rather than transient — so that
 * fallback could only ever fail, and it failed on the REQUEST path: a user
 * asking the research agent about a stock waited for a doomed HTTP round trip.
 *
 * The staleness branch is the interesting one. It used to mean "the DB copy is
 * old, go and refresh it". It now means nothing actionable, because the writer
 * that keeps this table fresh is `xbrl-projection`, a nightly job reading our
 * own archived NSE filings — not something a request can trigger. So a stale
 * row is returned AS IS and labelled, which is strictly better than the
 * alternative on offer: a stale real number beats a failed fetch, and beats a
 * silently-empty answer even more.
 *
 * Screener stays as the only external fallback, and only when the DB has
 * NOTHING at all — it is alive, it is already used by `stock-document-sync`,
 * and it is HTML-parsed rather than an API someone can revoke.
 *
 * There is deliberately no Tickertape branch left. See
 * `packages/core/__tests__/market-data/tickertape-retired.test.ts` for the
 * scheduled half of the same removal.
 */
export async function getOrFetchFinancials(
  symbol: string,
  exchange?: string,
  periodType: "ANNUAL" | "QUARTERLY" = "ANNUAL",
): Promise<FinancialsResult | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const ex = exchange || "NSE";
  const stalenessKey =
    periodType === "ANNUAL" ? "financials_annual" : "financials_quarterly";

  const existing = await prisma.stockFinancials.findMany({
    where: { symbol: clean, exchange: ex, periodType },
    // A DETERMINISTIC TIEBREAK, not the authoritative order — MONEY-1235.
    //
    // `period` is a free-text label, so this is a lexicographic sort:
    // `"Q4-2026"` lands above `"Q1-2027"` (the NEWER quarter) and `"TTM"` lands
    // above every `"FY 20xx"` because `"T" > "F"`. Both are corrected by
    // `sortFinancialsNewestFirst` below, which orders on the real `periodEnd`.
    //
    // It is deliberately NOT changed to `orderBy: { periodEnd: "desc" }`:
    // `periodEnd` is nullable and ~32,359 legacy rows predate it, and on Mongo a
    // MISSING field sorts in a fixed position rather than being excluded — so
    // the DB would place every undated row confidently and wrongly, which is
    // precisely the failure mode being removed. Sorting in code keeps
    // "undated" a case the reader can see.
    orderBy: { period: "desc" },
  });

  if (existing.length > 0) {
    const ordered = sortFinancialsNewestFirst(existing);

    // The newest REAL reporting period. The TTM row is excluded on purpose: it
    // is frozen (see below), so its `fetchedAt` reports when Tickertape stopped
    // rather than whether these filings are current. `?? ordered[0]!` covers
    // the degenerate all-TTM case, where something is better than throwing.
    const newest = pickNewestPeriodicRow(ordered) ?? ordered[0]!;

    // Provenance from the BEST row, not the first one. Before MONEY-1235 this
    // read `existing[0]!.source` under a lexicographic sort, so one frozen
    // `TICKERTAPE` TTM row made the whole payload announce itself as Tickertape
    // even when every FY row beside it was fresh `NSE_XBRL`.
    const source = authorityMaxSource(ordered);

    // ~2,123 `period:"TTM"` rows sit under `periodType:"ANNUAL"` and
    // `periodLabel()` structurally never emits "TTM", so the XBRL projection
    // can never displace them — they keep Tickertape values and a frozen
    // `fetchedAt` for good. Re-badge the label with its as-of date so the model
    // reads the age off the column heading instead of taking a five-month-old
    // aggregate for a current one. Interim measure: deriving a real TTM from
    // the quarterly rows is a later phase, after the quarterly drain.
    const staleTtm = describeStaleTtm(ordered);
    const rows = staleTtm ? annotateStaleTtmRows(ordered, staleTtm) : ordered;

    const grouped = groupFinancials(rows);
    if (isStale(newest.fetchedAt, stalenessKey)) {
      // Reported, not hidden. A caller that wants to distinguish "current" from
      // "the best we have" reads `source`, which carries the row's real
      // provenance (NSE_XBRL once the projection has run over this symbol,
      // TICKERTAPE for a period only the old writer ever covered).
      logger.info(
        { symbol: clean, periodType, source, newestPeriod: newest.period },
        "financials are stale; serving the stored copy — the refresher is the " +
          "nightly xbrl-projection job, not this request",
      );
    }
    if (staleTtm) {
      logger.info(
        { symbol: clean, periodType, ...staleTtm },
        "TTM row is frozen relative to the periodic rows beside it; the " +
          "column is badged with its as-of date rather than hidden",
      );
    }
    return { ...grouped, source, fromCache: true, staleTtm };
  }

  // Nothing stored for this symbol and period.
  //
  // Deliberately NO external fetch-and-persist here. Writing a Screener-derived
  // row into `StockFinancials` would have to clear `mayOverwriteFinancials`, and
  // more importantly the table has no `source` in its unique key — so a
  // request-time write from the weakest source in FINANCIALS_AUTHORITY could
  // occupy a period that the nightly XBRL projection would then have to
  // displace. A read path should not be able to do that.
  //
  // `null` here is honest and temporary: `xbrl-projection` fills the table from
  // our archived filings, and the backfill fills the history. Callers that want
  // a best-effort external READ (never persisted) use `fetchFinancialsChain`,
  // which keeps Screener for exactly that purpose.
  logger.info(
    { symbol: clean, exchange: ex, periodType },
    "no stored financials — xbrl-projection has not covered this symbol yet",
  );
  return null;
}

// ── DB-first typed statements (MONEY-614) ────────────────────────────

/**
 * The numeric fields the fetch tools / compute tools read.
 *
 * ## Why this used to return nothing, ever — MONEY-1205
 *
 * The comment that stood here claimed "the synced Tickertape rawData uses these
 * exact camelCase keys (financial-data-sync reads row.revenue / row.netIncome /
 * row.ebitda), so this is a safe key passthrough". Both halves were false, and
 * they were false in a mutually-confirming way: `financial-data-sync` really did
 * read `row.revenue`, and it really did get `undefined` — the passthrough was
 * validated against another module's bug rather than against the data.
 *
 * `rawData` is Tickertape's row VERBATIM: `incTrev`, `incNinc`, `balTota`,
 * `cafCfoa`. There is no `revenue` key in it. `groupFinancials` spreads that
 * rawData and prepends `period`, so every row reaching `rowToStatement` had
 * exactly one readable field — the period — and `hasFigures` then dropped it
 * for having no figures. `toTypedStatementRows` returned `[]` for every symbol,
 * `getDbFirstStatements` saw `0 + 0 + 0` and returned null, and all three
 * fetch tools fell through to a live Yahoo call. **The DB-first cache has never
 * hit since it shipped**, which is invisible from the outside: the tools
 * succeed, just slowly and against a rate-limited upstream.
 *
 * The fix is to stop guessing at spread rawData. `rowToStatement` now takes the
 * `StockFinancials` ROW and reads the TYPED COLUMNS, which is the only place
 * these names are real — with `mapTickertapeStatementRow` over `rawData` as a
 * fallback so the 32,359 rows whose columns are still null (written by the seed
 * before this ticket, and pending
 * `scripts/data/backfill-financials-from-rawdata.ts`) resolve too.
 */
const STATEMENT_NUMERIC_FIELDS = [
  "revenue",
  "costOfRevenue",
  "grossProfit",
  "operatingIncome",
  "netIncome",
  "ebitda",
  "totalAssets",
  "totalLiabilities",
  "totalEquity",
  "totalDebt",
  "totalCash",
  "currentAssets",
  "currentLiabilities",
  "inventory",
  "receivables",
  "payables",
  "retainedEarnings",
  "propertyPlantEquipment",
  "sga",
  "depreciation",
  "operatingCashFlow",
  "capitalExpenditure",
  "freeCashFlow",
] as const;

/**
 * The row this reader accepts.
 *
 * Deliberately `Record<string, unknown>` rather than a narrow interface: it is
 * fed BOTH real `StockFinancials` rows (typed columns + `rawData`) and the
 * grouped objects `groupFinancials` produces, and every field below is read
 * defensively anyway. A narrower type here would only be enforced at the one
 * call site that already type-checks, while silently excluding the other.
 */
export type StoredFinancialsRow = Record<string, unknown>;

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * One `StockFinancials` row → the typed `FinancialStatement` the tools read.
 *
 * Typed columns win; `rawData` re-mapped through the shared Tickertape mapper
 * fills whatever they leave empty. The order matters — a column is what the row
 * actually asserts (and may have been written by NSE_XBRL, not Tickertape),
 * while `rawData` is only ever the last source's payload.
 */
export function rowToStatement(row: StoredFinancialsRow): FinancialStatement {
  const out: Record<string, unknown> = { period: String(row.period ?? "") };

  // `periodEnd` is the sortable key; `period` is a free-text label ("TTM" has
  // no year at all). Prefer the real date, fall back to the label so the field
  // is never empty for a caller that just renders it.
  const rawEnd = row.periodEnd;
  const endDate =
    rawEnd instanceof Date && Number.isFinite(rawEnd.getTime())
      ? rawEnd.toISOString()
      : typeof rawEnd === "string" && rawEnd.trim()
        ? rawEnd
        : String(out.period ?? "");
  out.endDate = endDate;

  // MONEY-1300 — whose accounts this period is, carried onto every statement
  // the three fetch tools return.
  //
  // The row already HAS it: `getOrFetchFinancials` runs a `findMany` with no
  // `select:`, so Prisma returns the whole document and `groupFinancials`
  // spreads the row's own columns. What was missing is this line — the mapper's
  // allowlist copied `period`, `endDate` and the numeric columns and dropped
  // everything else, so `basis` was read from the database and then thrown away
  // one function later. A tool answering "360ONE's FY2025 total assets are
  // 19,768 Cr" could not say whether that was the group or the parent alone.
  //
  // Normalised, never defaulted: absent (~32,359 pre-projection rows) and
  // "UNKNOWN" (vendor rows) both resolve to UNKNOWN. Not filtered anywhere —
  // `basis` is provenance for readers, and a `basis: null` Prisma filter
  // matches no absent field on Mongo and returns zero rows.
  out.basis = normalizeStockFinancialsBasis(row.basis);

  for (const f of STATEMENT_NUMERIC_FIELDS) {
    const v = finite(row[f]);
    if (v !== undefined) out[f] = v;
  }

  // Fallback for rows whose typed columns were never populated.
  const raw = row.rawData;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const mapped = mapTickertapeStatementRow(
      row.statementType as TickertapeStatementType,
      raw as Record<string, unknown>,
      row.periodType === "QUARTERLY" ? "QUARTERLY" : "ANNUAL",
    );
    if (mapped) {
      const columns = tickertapeStatementColumns(mapped);
      for (const [column, value] of Object.entries(columns) as Array<
        [TickertapeFinancialColumn | "periodEnd", unknown]
      >) {
        if (column === "periodEnd") continue;
        if (out[column] !== undefined) continue;
        const v = finite(value);
        if (v !== undefined) out[column] = v;
      }
      if (
        (!out.endDate || out.endDate === out.period) &&
        mapped.periodEnd !== undefined
      ) {
        out.endDate = mapped.periodEnd.toISOString();
      }
    }
  }

  return out as unknown as FinancialStatement;
}

/** A statement row is "real" only if it carries at least one numeric figure
 *  (guards against the period-only empty rows a failed scrape can produce). */
function hasFigures(s: FinancialStatement): boolean {
  return STATEMENT_NUMERIC_FIELDS.some(
    (f) => typeof (s as unknown as Record<string, unknown>)[f] === "number",
  );
}

/** Map stored `StockFinancials` rows to typed `FinancialStatement`, dropping
 *  period-only empty rows. Exported for testing against the real row shape. */
export function toTypedStatementRows(
  rows: Array<StoredFinancialsRow>,
): FinancialStatement[] {
  return rows.map(rowToStatement).filter(hasFigures);
}

export interface DbFirstStatements {
  income: FinancialStatement[];
  balanceSheet: FinancialStatement[];
  cashFlow: FinancialStatement[];
  source: string;
  /**
   * MONEY-1235 — threaded through so a caller can surface the frozen TTM row's
   * age structurally. The label itself is already re-badged (`TTM (as of
   * 2026-03-12)`), which is what actually reaches a prompt; this is for callers
   * that want the date without parsing it back out of a string.
   */
  staleTtm: StaleTtmNotice | null;
}

/**
 * DB-first typed financial statements (MONEY-614). Reads the synced
 * StockFinancials (DB → Tickertape on miss, via getOrFetchFinancials) and maps
 * the rawData to typed FinancialStatement rows. Returns null when nothing real
 * is available so the caller can fall back to its live source — never throws.
 */
export async function getDbFirstStatements(
  symbol: string,
  exchange?: string,
  periodType: "ANNUAL" | "QUARTERLY" = "ANNUAL",
): Promise<DbFirstStatements | null> {
  try {
    const res = await getOrFetchFinancials(symbol, exchange, periodType);
    if (!res) return null;
    const income = toTypedStatementRows(res.income);
    const balanceSheet = toTypedStatementRows(res.balanceSheet);
    const cashFlow = toTypedStatementRows(res.cashFlow);
    if (income.length + balanceSheet.length + cashFlow.length === 0) {
      return null;
    }
    return {
      income,
      balanceSheet,
      cashFlow,
      source: res.source,
      staleTtm: res.staleTtm,
    };
  } catch {
    return null;
  }
}

// ── Ratios ───────────────────────────────────────────────────────────

export async function getOrFetchRatios(
  symbol: string,
  exchange?: string,
): Promise<Record<string, unknown> | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const ex = exchange || "NSE";

  const existing = await prisma.stockRatios.findUnique({
    where: { symbol_exchange: { symbol: clean, exchange: ex } },
  });

  // MONEY-1220. This used to fall through to `fetchTickertapeStockRatios` on a
  // stale row and upsert the result. Both halves are now wrong:
  //
  //  - The FETCH is doomed. `api.tickertape.in` returns 403 to our Cloud Run
  //    egress and 200 from a laptop, so the branch that looks fine in dev is
  //    the one that never runs in prod.
  //  - The WRITE is worse than useless. `xbrl-ratios-daily` now derives 26 of
  //    this table's 28 columns for every NSE filer from our own filings and
  //    close history, and `StockRatios` is @@unique([symbol, exchange]) — ONE
  //    row per symbol, no period dimension — so a request-time upsert replaces
  //    the symbol's ENTIRE ratio set with a weaker source's view of it.
  //
  // So "stale" is no longer a reason to go anywhere: the refresher is a nightly
  // job, not this request. A stale real number beats a failed fetch, and beats a
  // silent empty by more. `targetPrice` and `recommendation` are the two columns
  // nothing writes any more — analyst opinion, not derivable from primary data —
  // and they keep whatever Tickertape last left there rather than being cleared.
  if (existing) {
    // MONEY-1235 — freshness is `max(fetchedAt, ratiosDerivedAt)`, not
    // `fetchedAt`.
    //
    // `xbrl-ratios-daily` stamps `ratiosDerivedAt` on every nightly derivation
    // and deliberately leaves `fetchedAt` alone, because `fetchedAt` is still
    // the honest age of the two columns that job does not own — `targetPrice`
    // and `recommendation` are sell-side analyst opinion that nothing writes any
    // more, and back-dating them because a margin was recomputed would be a lie
    // about the number a reader is most likely to act on.
    //
    // Reading `fetchedAt` alone against a 24-hour threshold therefore made this
    // branch fire for EVERY symbol on EVERY AI ratios read, nightly, about
    // numbers derived hours earlier. Fixing it in the READER rather than the
    // writer is the deliberate half of the decision.
    const asOf = latestRatiosTimestamp(existing);
    if (isStale(asOf, "ratios")) {
      logger.info(
        {
          symbol: clean,
          exchange: ex,
          source: existing.source,
          fetchedAt: existing.fetchedAt,
          ratiosDerivedAt: existing.ratiosDerivedAt,
        },
        "ratios are stale; serving the stored copy — the refresher is the " +
          "nightly xbrl-ratios job, not this request",
      );
    }
    return existing as unknown as Record<string, unknown>;
  }

  logger.info(
    { symbol: clean, exchange: ex },
    "no stored ratios — xbrl-ratios has not covered this symbol yet",
  );
  return null;
}

// ── Peers ────────────────────────────────────────────────────────────

export async function getOrFetchPeers(
  symbol: string,
  exchange?: string,
): Promise<Record<string, unknown>[] | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const ex = exchange || "NSE";

  const existing = await prisma.stockPeers.findUnique({
    where: { symbol_exchange: { symbol: clean, exchange: ex } },
  });

  // MONEY-1220, same removal as `getOrFetchRatios` above and one extra reason.
  //
  // This used to fetch peers from Tickertape on a stale row and upsert them.
  // `peers-sync-daily` (23:15 IST, MONEY-1145) already rebuilds `stock_peers`
  // for the whole universe from our OWN instruments, ratios and quotes — no
  // third-party scrape, no rate limit — so the fallback was competing with a
  // better source over a doomed request: `api.tickertape.in` 403s our Cloud Run
  // egress.
  //
  // The extra reason: the create branch fell back to
  // `instrumentId: "000000000000000000000000"` when no instrument resolved. That
  // is a sentinel pointing at nothing, and `StockPeers.instrument` is a REQUIRED
  // relation — Prisma does not return null for a dangling required relation, it
  // THROWS, and the throw kills the whole query. One such row blanks every
  // result the caller asked for. That is MONEY-1216's failure mode, manufactured
  // on purpose at request time.
  if (existing) {
    if (isStale(existing.fetchedAt, "peers")) {
      logger.info(
        { symbol: clean, exchange: ex, source: existing.source },
        "peers are stale; serving the stored copy — the refresher is the " +
          "nightly peers-sync job, not this request",
      );
    }
    return existing.peers as Record<string, unknown>[];
  }

  logger.info(
    { symbol: clean, exchange: ex },
    "no stored peers — peers-sync has not covered this symbol yet",
  );
  return null;
}

// ── News ─────────────────────────────────────────────

/** One `stock_news` row as this module returns it. */
export interface StoredNewsArticle {
  title: string;
  link: string;
  pubDate: Date | null;
  source: string;
  snippet: string | null;
  /** Read by the freshness gate; the rows are full `stock_news` documents. */
  fetchedAt: Date;
}

/**
 * What a news refresh actually PERSISTED — MONEY-1238.
 *
 * ## Why a count and not a boolean
 *
 * `getOrFetchNews` cannot fail. `news-client.fetchNews` catches its own errors
 * and returns `[]` on a non-2xx (a Google News 403 against our egress included),
 * the per-article upsert swallows constraint errors, and the outer `catch` here
 * returns whatever was already in the table. Every one of those paths returns a
 * perfectly ordinary array of articles — the ones already stored — so the caller
 * could not tell "we wrote 10 rows" from "we wrote nothing and handed you the
 * same four-month-old rows back".
 *
 * `news-sync` reported `written: processed` off exactly that, so a totally dark
 * upstream produced `job.written = 50` and a green monitor over a frozen table.
 * These counters are the number the job is supposed to report.
 *
 * `servedFresh` and `fetchFailed` are kept SEPARATE from `created`/`updated`
 * because they are different zeros: a Pub/Sub redelivery inside the 30-minute
 * freshness window legitimately writes nothing, while a 403 illegitimately
 * writes nothing, and a monitor that cannot tell them apart is a monitor that
 * gets muted.
 */
export interface NewsRefreshCounts {
  /** Rows inserted into `stock_news`. */
  created: number;
  /** Existing rows re-written (snippet + `fetchedAt`). */
  updated: number;
  /** Upserts that threw and therefore persisted nothing. */
  failed: number;
  /** Articles the upstream returned. 0 = the upstream gave us nothing. */
  fetched: number;
  /** The stored copy was inside the freshness window, so no fetch was tried. */
  servedFresh: boolean;
  /** The fetch/persist block threw; the stored copy was returned unchanged. */
  fetchFailed: boolean;
}

export interface NewsRefreshResult extends NewsRefreshCounts {
  articles: StoredNewsArticle[];
}

/** The Prisma surface `refreshNews` touches, so a test can hand in a fake. */
type NewsDb = Pick<typeof prisma, "stockNews" | "instrumentMapping">;

/** `fetchNews`'s shape, injectable so tests never open a socket. */
type NewsFetcher = (
  query: string,
  maxArticles: number,
) => Promise<
  Array<{
    title: string;
    link: string;
    pubDate?: string | null;
    source?: string | null;
    snippet?: string | null;
  }>
>;

/**
 * Refresh `stock_news` for one symbol and report what actually landed.
 *
 * Same behaviour as {@link getOrFetchNews} (which is now a thin wrapper) plus
 * the counters. The created/updated split costs ONE extra query per symbol — a
 * single `findMany` over the links we are about to upsert — not one per article:
 * Prisma's `upsert` returns the row but never says which branch it took.
 */
export async function refreshNews(
  symbol: string,
  limit = 10,
  deps: { prisma?: NewsDb; fetchNews?: NewsFetcher } = {},
): Promise<NewsRefreshResult> {
  const db = deps.prisma ?? prisma;
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const zero = { created: 0, updated: 0, failed: 0, fetched: 0 };

  // Check DB for recent news
  const existing = (await db.stockNews.findMany({
    where: { symbol: clean },
    orderBy: { fetchedAt: "desc" },
    take: limit,
  })) as StoredNewsArticle[];

  // If we have recent news (< 30 min), return from DB
  if (existing.length > 0 && !isStale(existing[0]!.fetchedAt, "news")) {
    return {
      ...zero,
      servedFresh: true,
      fetchFailed: false,
      articles: existing,
    };
  }

  // Fetch fresh news
  let created = 0;
  let updated = 0;
  let failed = 0;
  let fetched = 0;
  try {
    const fetchNews =
      deps.fetchNews ?? (await import("./news-client")).fetchNews;
    const articles = await fetchNews(clean, limit);
    fetched = articles?.length ?? 0;

    if (articles && articles.length > 0) {
      const instrument = await db.instrumentMapping.findFirst({
        where: { symbol: clean, exchange: "NSE", isActive: true },
      });

      // Which of these links we ALREADY hold, in one query. Without it every
      // upsert is indistinguishable from every other and "created" is a guess.
      const links = articles.map((a) => a.link);
      const priorLinks = new Set(
        (
          (await db.stockNews.findMany({
            where: { symbol: clean, link: { in: links } },
            select: { link: true },
          })) as Array<{ link: string }>
        ).map((r) => r.link),
      );

      // Upsert each article
      for (const article of articles) {
        try {
          await db.stockNews.upsert({
            where: {
              symbol_link: { symbol: clean, link: article.link },
            },
            update: {
              snippet: article.snippet || null,
              fetchedAt: new Date(),
            },
            create: instrument
              ? {
                  instrument: { connect: { id: instrument.id } },
                  symbol: clean,
                  title: article.title,
                  link: article.link,
                  pubDate: article.pubDate ? new Date(article.pubDate) : null,
                  source: "GOOGLE_NEWS",
                  snippet: article.snippet || null,
                }
              : {
                  symbol: clean,
                  title: article.title,
                  link: article.link,
                  pubDate: article.pubDate ? new Date(article.pubDate) : null,
                  source: "GOOGLE_NEWS",
                  snippet: article.snippet || null,
                },
          });
          if (priorLinks.has(article.link)) updated++;
          else created++;
        } catch {
          // Duplicate or constraint error - persisted nothing, and that is the
          // whole point of counting it rather than swallowing it silently.
          failed++;
        }
      }
    }

    // Return from DB (includes both old and new)
    const articlesOut = (await db.stockNews.findMany({
      where: { symbol: clean },
      orderBy: { fetchedAt: "desc" },
      take: limit,
    })) as StoredNewsArticle[];
    return {
      created,
      updated,
      failed,
      fetched,
      servedFresh: false,
      fetchFailed: false,
      articles: articlesOut,
    };
  } catch (err) {
    logger.error(`Failed to fetch news for ${clean}:`, err);
    return {
      created,
      updated,
      failed,
      fetched,
      servedFresh: false,
      fetchFailed: true,
      articles: existing,
    };
  }
}

/**
 * Back-compat wrapper: the articles only.
 *
 * Every caller that just wants headlines keeps working unchanged. Anything that
 * needs to know whether the refresh WROTE anything must call
 * {@link refreshNews} — this signature structurally cannot tell you.
 */
export async function getOrFetchNews(
  symbol: string,
  limit = 10,
  deps: { prisma?: NewsDb; fetchNews?: NewsFetcher } = {},
): Promise<StoredNewsArticle[]> {
  return (await refreshNews(symbol, limit, deps)).articles;
}

// ── Profile ──────────────────────────────────────────────────────────

export async function getOrFetchProfile(
  symbol: string,
  exchange?: string,
): Promise<Record<string, unknown> | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const ex = exchange || "NSE";

  const existing = await prisma.stockProfile.findUnique({
    where: { symbol_exchange: { symbol: clean, exchange: ex } },
  });

  if (existing && !isStale(existing.fetchedAt, "profile")) {
    return existing as unknown as Record<string, unknown>;
  }

  // Profile comes from Yahoo Finance via quoteSummary with summaryProfile module
  try {
    const { yahooFetchQuoteSummary } =
      await import("@usemoney/core/market-data");
    const summary = await yahooFetchQuoteSummary(`${clean}.NS`, [
      "summaryProfile",
      "price",
    ]);
    if (!summary) return existing as unknown as Record<string, unknown>;

    const instrument = await resolveInstrument(clean, ex);
    const profileModule = (summary as Record<string, unknown>)
      .summaryProfile as Record<string, unknown> | undefined;
    const priceModule = (summary as Record<string, unknown>).price as
      | Record<string, unknown>
      | undefined;
    const profileData = { ...profileModule, ...priceModule } as Record<
      string,
      unknown
    >;

    if (!instrument) {
      // No instrument row to attach to. See the note on `create` below: writing
      // a placeholder id here is worse than not caching at all.
      logger.warn(
        { symbol: clean, exchange: ex },
        "profile fetched but NOT cached — no instrument_mappings row to attach " +
          "to, and StockProfile.instrument is a required relation",
      );
      return profileData;
    }

    const upserted = await prisma.stockProfile.upsert({
      where: { symbol_exchange: { symbol: clean, exchange: ex } },
      update: {
        name: (profileData.longName as string) || clean,
        sector: profileData.sector as string | null,
        industry: profileData.industry as string | null,
        description: profileData.longBusinessSummary as string | null,
        website: profileData.website as string | null,
        employees: profileData.fullTimeEmployees as number | null,
        marketCap: profileData.marketCap as number | null,
        fetchedAt: new Date(),
        source: "YAHOO",
      },
      // MONEY-1220. The `: {}` branch here used to write
      // `instrumentId: "000000000000000000000000"` — a well-formed ObjectId that
      // points at nothing. `StockProfile.instrument` is a REQUIRED relation, and
      // Prisma does not return null for a dangling required relation: it THROWS,
      // and the throw kills the WHOLE query, so one such row takes out every
      // result the caller asked for. That is MONEY-1216's failure mode, which
      // blanked every fundamental column in QA's screener with no visible error
      // — except manufactured here at request time, on prod, by a read.
      //
      // A profile we cannot attach is simply not persisted. The fetched data is
      // still returned to this caller, so nothing user-visible is lost; only the
      // cache write is skipped, and it is skipped for a symbol that has no
      // instrument row to cache against.
      create: {
        instrument: { connect: { id: instrument.id } },
        symbol: clean,
        exchange: ex,
        name: (profileData.longName as string) || clean,
        sector: profileData.sector as string | null,
        industry: profileData.industry as string | null,
        description: profileData.longBusinessSummary as string | null,
        website: profileData.website as string | null,
        employees: profileData.fullTimeEmployees as number | null,
        marketCap: profileData.marketCap as number | null,
        source: "YAHOO",
      },
    });

    return upserted as unknown as Record<string, unknown>;
  } catch (err) {
    logger.error(`Failed to fetch profile for ${clean}:`, err);
    return existing as unknown as Record<string, unknown>;
  }
}

// ── Shareholding ─────────────────────────────────────────────────────

/**
 * Rows whose `quarter` is the canonical `YYYY-MM` the NSE parser emits when it
 * could date the period. `normalizeQuarter()` keeps an unparseable label
 * verbatim and upper-cased ("Q1FY26"), and letters sort AHEAD of digits in a
 * lexicographic DESC — so one undatable label would displace a real quarter out
 * of a `take: 8`.
 */
const CANONICAL_QUARTER = /^\d{4}-\d{2}$/;

export async function getOrFetchShareholding(
  symbol: string,
  exchange?: string,
): Promise<
  Array<{
    quarter: string;
    promoter: number | null;
    fii: number | null;
    dii: number | null;
    public: number | null;
    /** Which provider actually answered — see the precedence note below. */
    source?: string;
  }>
> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const ex = exchange || "NSE";

  // ── (a) NSE FIRST — MONEY-1204 (P14 / 14c.4) ──────────────────────
  //
  // `ShareholdingPattern` (`shareholding_patterns`) is the exchange's own
  // filing; `StockShareholding` (`stock_shareholding`) is a Tickertape/screener
  // copy. They describe the same quarters, they DISAGREE, and their `quarter`
  // strings do not join (`2026-03` vs `Q3-2024`), so there is no merge to do —
  // only a precedence to pick.
  //
  // The stock page's ownership section picks NSE first
  // (`getStockShareholdingSection`, packages/services). This function is what
  // the research agent reads. If the two chose differently, StockSage would
  // quote one promoter holding while the page beside it showed another, with
  // nothing on screen to say which was which. Same order, both places.
  //
  // Filtered on `symbol` alone — but NOT because the row is symbol-unique.
  //
  // This comment used to claim "`@@unique([symbol, quarter])` carries NO
  // exchange, and every row defaults `exchange` to NSE". MONEY-1207 changed
  // both halves: `exchange` is IN the unique key, and the BSE provider writes
  // real BSE rows. The symbol-only predicate is still right (an `exchange`
  // predicate returns nothing for a quarter only the other exchange filed) but
  // it now returns the same quarter ONCE PER EXCHANGE, so the rows have to be
  // deduped before they are ranked — see below.
  //
  // `take` is in ROWS and a quarter can occupy two of them, hence 16 -> 32:
  // the old window held only ~8 distinct quarters for a dual-listed symbol.
  const nseRows = await prisma.shareholdingPattern.findMany({
    where: { symbol: clean },
    orderBy: { quarter: "desc" },
    take: 32,
    select: {
      quarter: true,
      exchange: true,
      promoterPct: true,
      fiiPct: true,
      diiPct: true,
      publicPct: true,
      pledgedPct: true,
    },
  });

  // Datable labels first, then newest-first within each group.
  //
  // Deduped BEFORE the sort, with no `preferExchange`: the research agent has
  // no viewed exchange, and the header note above requires this function and
  // `getStockShareholdingSection` to choose identically. The shared declared
  // authority (NSE first) is what keeps that promise — StockSage quoting BSE's
  // filing while the page beside it showed NSE's is exactly the divergence the
  // note exists to prevent.
  const orderedNse = dedupeShareholdingByQuarter(nseRows).sort((a, b) => {
    const ac = CANONICAL_QUARTER.test(a.quarter) ? 1 : 0;
    const bc = CANONICAL_QUARTER.test(b.quarter) ? 1 : 0;
    if (ac !== bc) return bc - ac;
    return a.quarter < b.quarter ? 1 : a.quarter > b.quarter ? -1 : 0;
  });

  // An all-null row carries no information. Counting it as "NSE has data" would
  // suppress a populated fallback and hand the agent an empty answer under a
  // confident NSE label. (The parser rejects these at write time; this is the
  // belt to that braces.)
  const usableNse = orderedNse.filter(
    (r) =>
      r.promoterPct !== null ||
      r.fiiPct !== null ||
      r.diiPct !== null ||
      r.publicPct !== null ||
      r.pledgedPct !== null,
  );

  if (usableNse.length > 0) {
    // Percentages pass through UNCOERCED: null means NOT REPORTED, and `?? 0`
    // here is how an undisclosed promoter pledge becomes a fabricated
    // all-clear in a research answer.
    return usableNse.slice(0, 8).map((r) => ({
      quarter: r.quarter,
      promoter: r.promoterPct,
      fii: r.fiiPct,
      dii: r.diiPct,
      public: r.publicPct,
      source: "NSE_SHP",
    }));
  }

  // ── (b) Tickertape / screener fallback (unchanged below) ──────────
  //
  // KNOWN, NOT FIXED HERE (MONEY-1204 14c.4 finding, kept out of scope on
  // purpose): the upsert further down writes `source: "SCREENER"` in its
  // `create:` branch but does NOT set `source` in its `update:` branch. A row
  // first written by the Tickertape sync and later refreshed from Screener
  // therefore keeps a `TICKERTAPE` label over Screener values — the same latent
  // provenance-lie class as MONEY-1198. The one-line fix is adding
  // `source: "SCREENER"` to the `update:` object; it is deliberately not folded
  // into this precedence change.
  const existing = await prisma.stockShareholding.findMany({
    where: { symbol: clean, exchange: ex },
    orderBy: { quarter: "desc" },
    take: 8, // Last 8 quarters
  });

  if (existing.length > 0 && !isStale(existing[0]!.fetchedAt, "shareholding")) {
    return existing;
  }

  // Shareholding comes from Screener.in (extracted from financials endpoint)
  try {
    const { fetchScreenerFinancials } = await import("./screener-client");
    const financials = await fetchScreenerFinancials(clean);
    if (!financials) return existing;

    // Extract shareholding from screener financials (promoter, FII, DII, public)
    const shData = financials as unknown as Record<string, unknown>;
    const promoter = shData.promoterHolding as number | undefined;
    const fii = shData.fiiHolding as number | undefined;
    const dii = shData.diiHolding as number | undefined;
    const pubHolding = shData.publicHolding as number | undefined;

    // If no shareholding data, return existing
    if (promoter == null && fii == null && dii == null) return existing;

    // Construct as array with current quarter
    const now = new Date();
    const q = `Q${Math.ceil((now.getMonth() + 1) / 3)}-${now.getFullYear()}`;
    const data = [
      {
        quarter: q,
        promoter,
        fii,
        dii,
        public: pubHolding,
        pledgedPercent: null,
      },
    ];
    if (data.length === 0) return existing;

    const instrument = await resolveInstrument(clean, ex);
    if (!instrument) {
      // Nothing to attach the rows to. See the note on `create` below —
      // persisting them against a placeholder id manufactures the exact orphan
      // that `repair-instrument-links.ts` exists to clean up. The fetched
      // shareholding is still returned; only the cache write is skipped.
      logger.warn(
        { symbol: clean, exchange: ex, quarters: data.length },
        "shareholding fetched but NOT cached — no instrument_mappings row, and " +
          "StockShareholding.instrument is a required relation",
      );
      return existing;
    }

    for (const row of data) {
      const item = row as Record<string, unknown>;
      const quarter = item.quarter as string;
      if (!quarter) continue;

      try {
        await prisma.stockShareholding.upsert({
          where: {
            symbol_exchange_quarter: {
              symbol: clean,
              exchange: ex,
              quarter,
            },
          },
          update: {
            promoter: item.promoter as number | null,
            fii: item.fii as number | null,
            dii: item.dii as number | null,
            public: item.public as number | null,
            pledgedPercent: item.pledgedPercent as number | null,
            rawData: JSON.parse(JSON.stringify(item)),
            fetchedAt: new Date(),
          },
          // MONEY-1220 — same removal as StockProfile above, and this one is
          // the collection `sync-prod-to-qa` re-links (`stock_shareholding` is
          // in `repair-instrument-links.ts`). Writing a placeholder ObjectId
          // here creates exactly the orphan that repair exists to clean up, at
          // request time, in the environment the repair never runs against.
          create: {
            instrument: { connect: { id: instrument.id } },
            symbol: clean,
            exchange: ex,
            quarter,
            promoter: item.promoter as number | null,
            fii: item.fii as number | null,
            dii: item.dii as number | null,
            public: item.public as number | null,
            pledgedPercent: item.pledgedPercent as number | null,
            rawData: JSON.parse(JSON.stringify(item)),
            source: "SCREENER",
          },
        });
      } catch {
        // Skip constraint errors
      }
    }

    return prisma.stockShareholding.findMany({
      where: { symbol: clean, exchange: ex },
      orderBy: { quarter: "desc" },
      take: 8,
    });
  } catch (err) {
    logger.error(`Failed to fetch shareholding for ${clean}:`, err);
    return existing;
  }
}

// ── Analysis Count Tracking ──────────────────────────────────────────

/**
 * Increment analysis count for an instrument (used for sync tier prioritization)
 */
export async function trackAnalysis(symbol: string, exchange?: string) {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const ex = exchange || "NSE";

  try {
    await prisma.instrumentMapping.updateMany({
      where: { symbol: clean, exchange: ex },
      data: {
        lastAnalyzedAt: new Date(),
        analysisCount: { increment: 1 },
      },
    });
  } catch {
    // Non-critical - don't fail the analysis
  }
}
