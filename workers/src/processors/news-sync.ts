/**
 * News Sync Processor
 *
 * Fetches and stores latest news for top-analyzed stocks.
 * Runs every 2 hours during market hours (9 AM - 4 PM IST).
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import prisma from "@usemoney/database";
import { refreshNews } from "@usemoney/research/data-sources/db-store";
import type { NewsRefreshResult } from "@usemoney/research/data-sources/db-store";
import {
  resolveNewsSyncParams,
  needsSymbolDiscovery,
  buildNewsDiscoveryWhere,
  normalizeDiscoverySymbols,
  NEWS_PER_SYMBOL,
  NEWS_DISCOVERY_EXCHANGE,
} from "./news-sync-logic";

export interface NewsSyncMessage {
  symbols?: string[];
  limit?: number;
  delayMs?: number;
}

/** The Prisma surface this job touches, so a test can hand in a fake. */
type Db = typeof prisma;

/**
 * Injectable seams — MONEY-1238. Production passes none of them; the defaults
 * ARE the production path, so the tests execute the same code the scheduler
 * does rather than a copy of it.
 */
export interface NewsSyncDeps {
  prisma?: Db;
  refreshNews?: (symbol: string, limit: number) => Promise<NewsRefreshResult>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * What the run actually did. `written` is the ONLY number that means "rows
 * reached `stock_news`" — everything else is context for why it is what it is.
 */
export interface NewsSyncResult {
  /** Symbols the job chose to work on. */
  selected: number;
  /** Rows created + rows updated. The number the monitor keys on. */
  written: number;
  created: number;
  updated: number;
  /** Upserts that threw (constraint/duplicate) and persisted nothing. */
  upsertFailed: number;
  /** Symbols whose whole pass threw. */
  failed: number;
  /** Symbols served from a copy inside the 30-minute freshness window. */
  servedFresh: number;
  /** Symbols whose fetch/persist block threw inside the data source. */
  fetchFailed: number;
  /** Symbols where the upstream returned ZERO articles without erroring. */
  emptyUpstream: number;
}

/**
 * Why a run wrote nothing, in the words that separate the three causes.
 *
 * Exported and pure so the wording is testable. `undefined` means "nothing to
 * explain" — `reportJobOutcome` only demands a reason when it found work and
 * produced none.
 *
 * The reason this exists at all: the old string claimed "every one of N symbols
 * yielded no article", which was unreachable. `written` was `processed`, and
 * `processed` incremented whenever `getOrFetchNews` did not throw — which it
 * cannot do. The branch could only be entered if EVERY symbol threw, and by
 * then the message would have been wrong about why.
 */
export function describeNewsShortfall(r: NewsSyncResult): string | undefined {
  if (r.selected === 0) return "population gate selected no symbols";
  if (r.written > 0) return undefined;
  if (r.servedFresh === r.selected) {
    return `all ${r.selected} symbols were already inside the news freshness window — nothing to write (a redelivery inside 30 minutes looks exactly like this)`;
  }
  const parts = [
    `${r.emptyUpstream} upstream-empty`,
    `${r.fetchFailed} fetch-failed`,
    `${r.servedFresh} already-fresh`,
    `${r.upsertFailed} upsert-failed`,
  ].join(", ");
  return `0 of ${r.selected} symbols produced a persisted row (${parts}) — an upstream that answers with nothing is indistinguishable from one that is blocked, so treat a run-long 0 as a blocked feed`;
}

/**
 * The populations this job discovers over, from our OWN tables — MONEY-1215,
 * widened by MONEY-1293.
 *
 * Lives in the I/O shell so the WHERE builder stays pure, the same split
 * `financial-data-sync.ts` used. Two populations, returned SEPARATELY rather
 * than pre-merged, because `buildNewsDiscoveryWhere` renders one OR arm per
 * population and a merged list cannot say which of the two went empty.
 *
 *  - **portfolio** — `Holding ∪ WatchlistItem`. Symbols a user is actually
 *    looking at, and the only population this job had until now. Measured on
 *    prod 2026-08-30: 103 distinct, 79 surviving the isActive/EQUITY/NSE
 *    narrowing. That 79 was the whole reachable universe.
 *  - **constituents** — `IndexConstituent`, refreshed weekly by
 *    `index-constituent-sync`. 3,274 rows over 17 indices on the same day,
 *    collapsing to 753 distinct symbols (749 of them active NSE equities). The
 *    union is 810 symbols / 782 selectable rows — 9.9x what the job could see
 *    before.
 *
 * Deliberately NOT `loadSyncTierSymbols` from `@usemoney/core/market-data/
 * sync-tiers`, which computes the identical pair. That function reads the
 * module-level `prisma` singleton, and this job's whole test posture (MONEY-1238)
 * is that `deps.prisma` is injectable so the tests drive the REAL processor
 * rather than a re-declared copy of it. Borrowing the singleton would take that
 * seam away to save nine lines.
 *
 * Each lookup fails INDEPENDENTLY to an empty list. That is not defensiveness:
 * `buildNewsDiscoveryWhere` omits the arm for an empty population, so a dead
 * `index_constituents` degrades this job back to the portfolio population
 * instead of selecting nothing at all — and vice versa.
 */
interface DiscoveryPopulations {
  portfolio: string[];
  constituents: string[];
}

async function loadDiscoverySymbols(db: Db): Promise<DiscoveryPopulations> {
  // `run` yields the raw symbol strings, and the `.map` lives INSIDE each
  // callback rather than here. Prisma's `groupBy` is an overload set whose
  // argument is constrained against the inferred RESULT type; pinning that
  // result to `{ symbol: string }[]` from outside makes every overload fail to
  // match. `sync-tiers.ts::loadSyncTierSymbols` has the same shape for the same
  // reason.
  const grouped = async (
    label: string,
    run: () => Promise<Array<string | null>>,
  ): Promise<Array<string | null>> => {
    try {
      return await run();
    } catch (err) {
      // Logged, never swallowed: a silently empty population is exactly the
      // failure MONEY-1215 spent months not noticing.
      console.error(
        `[news-sync] ${label} lookup failed — population degraded:`,
        err,
      );
      return [];
    }
  };

  const [holdings, watchlist, constituents] = await Promise.all([
    grouped("Holding", async () =>
      (await db.holding.groupBy({ by: ["symbol"] })).map((r) => r.symbol),
    ),
    grouped("WatchlistItem", async () =>
      (await db.watchlistItem.groupBy({ by: ["symbol"] })).map((r) => r.symbol),
    ),
    grouped("IndexConstituent", async () =>
      (await db.indexConstituent.groupBy({ by: ["symbol"] })).map(
        (r) => r.symbol,
      ),
    ),
  ]);

  return {
    portfolio: normalizeDiscoverySymbols([...holdings, ...watchlist]),
    constituents: normalizeDiscoverySymbols(constituents),
  };
}

/**
 * Stamp the rotation marker — MONEY-1215.
 *
 * Called on SUCCESS **and** on failure. Deliberate: a symbol that cannot be
 * fetched (delisted, no upstream coverage, a permanently bad id) would
 * otherwise keep its null marker, stay first under `nulls: "first"`, and occupy
 * a slot on every run forever. `financial-data-sync` has exactly that shape
 * today — 14 of every 100 rows are unresolvable symbols pinned to the head of
 * the sort — and it is worth not reproducing here.
 *
 * Best-effort: a stamp failure must not fail the run, but it is logged rather
 * than swallowed, because silent stamp loss is indistinguishable from a
 * rotation that never advances.
 */
async function stampSyncMarker(
  db: Db,
  symbol: string,
  field: "newsSyncedAt" | "filingsSyncedAt",
): Promise<void> {
  try {
    await db.instrumentMapping.updateMany({
      // MONEY-1293 — SCOPED TO THE EXCHANGE THE SELECTION IS SCOPED TO.
      //
      // This was `where: { symbol }`, and on prod that is measurable rather
      // than theoretical: 2026-08-30, `newsSyncedAt` was present on **146**
      // instrument rows — 79 NSE and 67 BSE — against 79 symbols this job has
      // ever selected. Every one of those 67 BSE rows carries a marker saying
      // its news was synced, for a fetch that ran against the NSE row.
      //
      // The sibling `stock-document-sync.ts::stampVisited` omits this arm ON
      // PURPOSE and cites THIS function as its precedent — "the unit of work
      // is the SYMBOL, so a dual-listed company's NSE and BSE rows must rotate
      // together". That reasoning is right FOR THAT JOB, whose page genuinely
      // selects both exchanges, and wrong here, where `buildNewsDiscoveryWhere`
      // pins `exchange: "NSE"`. A marker exists to retire a row from ITS OWN
      // selection queue; stamping a row this query can never return records a
      // claim no run will ever act on.
      //
      // It also does not stay harmless if the population widens. 2,477 active
      // equity symbols are listed on both exchanges and 2,467 of them are one
      // company — but **10 are not**: KIRLPNU, SEL, CORDELIA, RAJPUTANA,
      // TDPOWERSYS, FOCUS, KALYANI, GSTL, MAL and ZEAL each carry two DIFFERENT
      // ISINs across NSE and BSE, and two of those ten are already inside the
      // widened population. For those, a symbol-only stamp marks one company's
      // row as done using another company's fetch — and under `asc` rotation a
      // wrongly-stamped row does not error, it just never comes back to the
      // head of the queue.
      //
      // The exchange is IMPORTED from the same constant the WHERE uses rather
      // than retyped, so a future widening moves both or neither.
      where: { symbol, exchange: NEWS_DISCOVERY_EXCHANGE },
      data: { [field]: new Date() },
    });
  } catch (err) {
    console.warn(`[${field}] stamp failed for ${symbol}:`, err);
  }
}

export async function processNewsSync(
  data: NewsSyncMessage,
  deps: NewsSyncDeps = {},
): Promise<NewsSyncResult> {
  const db = deps.prisma ?? prisma;
  const refresh = deps.refreshNews ?? refreshNews;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const { limit, delayMs } = resolveNewsSyncParams(data);

  // `symbols` is genuinely optional: the only scheduled publisher
  // (`news-sync-market-hours` in scripts/ops/setup-scheduler.sh) sends `{}`, so
  // auto-discovery is the PRIMARY path, not a fallback. `?? []` is the honest
  // seed — `needsSymbolDiscovery` already treats `undefined` and `[]`
  // identically (`!symbols || symbols.length === 0`), so discovery still fires
  // for exactly the same inputs and the `symbols.length` reads below see exactly
  // the value they saw before. Deliberately NOT `data.symbols!`: that would have
  // asserted a property the scheduler never sends, and if discovery were ever
  // skipped the loop would throw on `undefined` instead of processing nothing.
  let symbols: string[] = data.symbols ?? [];

  if (needsSymbolDiscovery(symbols)) {
    // MONEY-1293 — portfolio AND index constituents, as two OR arms. Awaited
    // before the findMany rather than inline in the argument list so a
    // degraded population is visible in the log above the query that used it.
    const pops = await loadDiscoverySymbols(db);
    console.log(
      `[news-sync] discovery population: ${pops.portfolio.length} portfolio + ` +
        `${pops.constituents.length} index-constituent symbols`,
    );
    const instruments = await db.instrumentMapping.findMany({
      where: buildNewsDiscoveryWhere(pops.portfolio, pops.constituents),
      select: { symbol: true },
      // MONEY-1215 — stale-first, not `analysisCount: "desc"`. Over a
      // population where every row's analysisCount is 0, that was a CONSTANT
      // sort: the same arbitrary `limit` rows on every run, forever, with no
      // error. Same defect and same fix as the financial tier's ordering.
      orderBy: [{ newsSyncedAt: "asc" }, { symbol: "asc" }],
      // `asc` puts NULLs first on MongoDB, which is what we want — a
      // never-synced symbol is the most stale thing there is. Written as
      // plain `asc` rather than `{ sort, nulls }` because that form needs
      // Prisma's `orderByNulls` preview flag, which this schema does not
      // enable; `buildFinancialTierOrderBy` makes the same choice.
      take: limit,
    });
    symbols = instruments.map((i) => i.symbol);
  }

  console.log(`[news-sync] Syncing news for ${symbols.length} symbols`);

  const result: NewsSyncResult = {
    selected: symbols.length,
    written: 0,
    created: 0,
    updated: 0,
    upsertFailed: 0,
    failed: 0,
    servedFresh: 0,
    fetchFailed: 0,
    emptyUpstream: 0,
  };
  let processed = 0;

  for (const symbol of symbols) {
    try {
      // MONEY-1238 — `refreshNews`, not `getOrFetchNews`. The old call returned
      // an ARRAY OF HEADLINES and the loop counted the call itself: `processed++`
      // fired whenever it did not throw, and it cannot throw. A Google News 403
      // therefore produced `written: 50` over a table that had not moved since
      // April. What is counted now is rows.
      const r = await refresh(symbol, NEWS_PER_SYMBOL);
      result.created += r.created;
      result.updated += r.updated;
      result.upsertFailed += r.failed;
      if (r.servedFresh) result.servedFresh++;
      if (r.fetchFailed) result.fetchFailed++;
      else if (!r.servedFresh && r.fetched === 0) result.emptyUpstream++;

      await stampSyncMarker(db, symbol, "newsSyncedAt");
      processed++;

      if (processed % 10 === 0) {
        console.log(`[news-sync] Progress: ${processed}/${symbols.length}`);
      }

      await sleep(delayMs);
    } catch (err) {
      console.error(`[news-sync] Failed for ${symbol}:`, err);
      // Stamped on failure too — see stampSyncMarker. An unfetchable symbol
      // that keeps a null marker owns a slot on every future run.
      await stampSyncMarker(db, symbol, "newsSyncedAt");
      result.failed++;
    }
  }

  result.written = result.created + result.updated;

  console.log(
    `[news-sync] Complete: processed=${processed}, written=${result.written} ` +
      `(created=${result.created} updated=${result.updated}), ` +
      `fresh=${result.servedFresh}, upstreamEmpty=${result.emptyUpstream}, ` +
      `fetchFailed=${result.fetchFailed}, failed=${result.failed}`,
  );

  // MONEY-1220 — news-sync was one of the six jobs that ran clean and wrote
  // nothing (its population gate matched no rows).
  //
  // MONEY-1238 — and then it was one of THREE that reported a `written` which
  // was not a write. `written` is now rows persisted to `stock_news`, so
  // `selected > 0 && written === 0` finally means what the monitor believes it
  // means. `failed` stays "symbols whose pass threw", which is a different
  // number from `upsertFailed` and is why both are carried.
  reportJobOutcome({
    job: "news-sync",
    selected: result.selected,
    written: result.written,
    failed: result.failed,
    skippedReason: describeNewsShortfall(result),
  });

  return result;
}
