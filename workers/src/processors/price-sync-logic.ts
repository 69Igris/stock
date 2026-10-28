/**
 * Price-sync processor — PURE orchestration logic (no Prisma / network).
 *
 * Side-effect-free helpers extracted out of `price-sync.ts` so they can be
 * unit-tested by importing the REAL symbol (no shadow copies) without booting a
 * Prisma client or hitting Yahoo. `price-sync.ts` imports and CALLS every export
 * here, so the production code path and the tests execute the SAME code. Mirrors
 * the worker precedent `import-logic.ts` / `pairing-logic.ts`.
 *
 * What lives here (all side-effect-free):
 *   - `resolveSyncType`            — `dateRange ? PRICE_BACKFILL : QUOTE_REFRESH`,
 *                                    the single source for the sync-log classification.
 *   - `resolveIncrementalDateRange`— the `incremental` flag → rolling dateRange
 *                                    (last N days), with the `Math.max(1, days)`
 *                                    floor so a 0/negative `incrementalDays` can't
 *                                    produce a zero/inverted window.
 *   - `transformRawQuote`          — Yahoo raw quote → normalized `YahooQuoteData`,
 *                                    including the previousClose=0 "bogus change"
 *                                    suppression and a FINITE-guarded timestamp
 *                                    (the bug fix — see below).
 *   - `shouldDelay` / `shouldLogProgress` — the every-10 rate-limit + every-100
 *                                    progress-log cadence in the backfill loop.
 *   - `selectBackfillInstruments`  — the in-memory instrument selection (explicit
 *                                    id subset, else EQUITY/INDEX/ETF), kept pure
 *                                    so the "$expr-free" filter is asserted directly.
 *
 * BUG CLASS this closes (timestamp): the previous worker built the quote
 * timestamp as `typeof t === "number" ? new Date(t * 1000) : new Date()`. A
 * non-finite `regularMarketTime` (NaN / ±Infinity — still `typeof "number"`)
 * sailed through the `typeof` gate and produced an **Invalid Date**, which then
 * (a) serializes to `null` and (b) throws on a later `.toISOString()`. We now
 * require `Number.isFinite` before trusting the epoch and fall back to "now"
 * otherwise, so a corrupt upstream time never persists an Invalid Date.
 *
 * @see workers/src/processors/price-sync.ts (caller)
 * @see apps/web/__tests__/workers/processor-price-sync.test.ts (tests the real exports)
 */

import type { YahooRawQuote, YahooQuoteData } from "@usemoney/core/market-data";

/** Sync-log `syncType` discriminator. */
export type PriceSyncType = "PRICE_BACKFILL" | "QUOTE_REFRESH";

/** Default rolling window (days) for an incremental backfill. */
export const DEFAULT_INCREMENTAL_DAYS = 30;

/** Batch size for the quote-refresh fan-out. */
export const QUOTE_REFRESH_BATCH_SIZE = 50;

/** Rate-limit cadence: pause after every Nth instrument in the backfill loop. */
export const BACKFILL_DELAY_EVERY = 10;

/** Progress-log cadence: log after every Nth instrument in the backfill loop. */
export const BACKFILL_LOG_EVERY = 100;

/**
 * Classify the sync run: a `dateRange` means a historical backfill, otherwise a
 * latest-quote refresh. Centralized so the sync-log `syncType` and the branch the
 * processor actually executes can never disagree.
 */
export function resolveSyncType(dateRange: unknown): PriceSyncType {
  return dateRange ? "PRICE_BACKFILL" : "QUOTE_REFRESH";
}

/**
 * Compute the rolling `[start, end]` window for an incremental backfill: `end` =
 * now, `start` = now minus `max(1, incrementalDays)` days. The floor guarantees
 * at least a 1-day window even if a caller passes `0` or a negative day count
 * (which would otherwise yield an empty or inverted range). Returns ISO strings
 * to match the `PriceSyncMessage.dateRange` wire shape.
 */
export function resolveIncrementalDateRange(
  incrementalDays: number = DEFAULT_INCREMENTAL_DAYS,
  now: Date = new Date(),
): { start: string; end: string } {
  const days = Number.isFinite(incrementalDays)
    ? Math.max(1, incrementalDays)
    : DEFAULT_INCREMENTAL_DAYS;
  const end = new Date(now);
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Normalize a Yahoo raw quote into the worker's `YahooQuoteData`.
 *
 * - "Bogus change" suppression: when `regularMarketPreviousClose` is 0 (or
 *   missing) yet there is a positive price (a freshly-listed / IPO instrument),
 *   Yahoo reports a nonsense +100% change — we zero `change`/`changePercent`.
 * - Finite-guarded timestamp: only a FINITE `regularMarketTime` (epoch seconds)
 *   is trusted; NaN/Infinity fall back to "now" so an Invalid Date is never
 *   produced (see file header).
 */
export function transformRawQuote(
  symbol: string,
  quote: YahooRawQuote,
): YahooQuoteData {
  const prevClose = quote.regularMarketPreviousClose ?? 0;
  const hasBogusChange = prevClose === 0 && quote.regularMarketPrice > 0;

  return {
    symbol,
    price: quote.regularMarketPrice,
    change: hasBogusChange ? 0 : (quote.regularMarketChange ?? 0),
    changePercent: hasBogusChange ? 0 : (quote.regularMarketChangePercent ?? 0),
    open: quote.regularMarketOpen ?? 0,
    high: quote.regularMarketDayHigh ?? 0,
    low: quote.regularMarketDayLow ?? 0,
    previousClose: prevClose,
    volume: quote.regularMarketVolume ?? 0,
    marketCap: quote.marketCap,
    timestamp:
      typeof quote.regularMarketTime === "number" &&
      Number.isFinite(quote.regularMarketTime)
        ? new Date(quote.regularMarketTime * 1000)
        : new Date(),
  };
}

/** True when the backfill loop should pause after the instrument at `index`. */
export function shouldDelay(index: number): boolean {
  return (index + 1) % BACKFILL_DELAY_EVERY === 0;
}

/** True when the backfill loop should log progress after the instrument at `index`. */
export function shouldLogProgress(index: number): boolean {
  return (index + 1) % BACKFILL_LOG_EVERY === 0;
}

/** The instrument fields the backfill selection reads. */
export interface BackfillInstrument {
  id: string;
  yahooSymbol: string | null;
  instrumentType?: string | null;
}

/** Instrument types eligible for a default (no explicit ids) price backfill. */
export const BACKFILL_INSTRUMENT_TYPES: readonly string[] = [
  "EQUITY",
  "INDEX",
  "ETF",
];

/**
 * Select which instruments to backfill from the full active set.
 *
 * When explicit `instrumentIds` are given, keep exactly those (membership via a
 * Set — O(n), not the quadratic `includes` the naive version used). Otherwise
 * default to the chartable types (EQUITY / INDEX / ETF). This is the in-memory
 * filter the processor runs instead of a Prisma `$expr` to avoid zombie ops.
 */
export function selectBackfillInstruments<T extends BackfillInstrument>(
  all: T[],
  instrumentIds: string[] | undefined,
): T[] {
  if (instrumentIds?.length) {
    const idSet = new Set(instrumentIds);
    return all.filter((i) => idSet.has(i.id));
  }
  return all.filter(
    (i) =>
      i.instrumentType != null &&
      BACKFILL_INSTRUMENT_TYPES.includes(i.instrumentType),
  );
}

/* -------------------------------------------------------------------------- */
/* MONEY-1238 — the sync-log STATUS, computed from real counts                 */
/* -------------------------------------------------------------------------- */

/**
 * ## The defect this closes
 *
 * The backfill branch closed its `marketDataSyncLog` row with a LITERAL:
 *
 *     data: { status: "COMPLETED", completedAt: new Date() }
 *
 * — no `recordsProcessed`, no `recordsFailed`, and no reading of anything the
 * run produced. `runHistoricalBackfill` returned `void`, so `totalInserted` and
 * `totalErrors` were summed, printed, and discarded at the function boundary.
 *
 * ## And the counts it had would have lied anyway
 *
 * `errors` cannot reach the shape that matters. `yahooFetchChart`
 * (packages/core/src/market-data/yahoo-api.ts:591) catches EVERY transport
 * error — 403, 429, timeout, DNS — logs it, and returns `[]`. It never
 * rejects, so the worker's own `try/catch` around it is unreachable, and
 * `backfillPrices` sees `bars.length === 0` and reports `{inserted: 0,
 * errors: 0}`. A Yahoo egress block therefore produced
 *
 *     "Backfill complete: 0 prices inserted, 0 errors"
 *
 * beside a spotless COMPLETED row. Identical, field for field, to a re-run of
 * an already-populated historical range — which is a genuine, healthy no-op.
 *
 * The fix is the repo's standing rule: give "couldn't determine" its own value.
 * `fetchChart`/`fetchQuotes` already accept an `onError` observer for exactly
 * this (`YahooFetchErrorOpts`, MONEY-1060), so the worker counts the swallowed
 * failures at its own boundary and the three states separate:
 *
 *     fetchFailures   the transport failed. Says NOTHING about the symbol.
 *     emptyResponses  Yahoo answered, and answered with no bars.
 *     inserted        rows that reached MongoDB.
 */
export interface BackfillTotals {
  /** Instruments the selection chose. */
  selected: number;
  /** Instruments a Yahoo call was actually issued for (selected − unfetchable). */
  attempted: number;
  /** Daily bars persisted. */
  inserted: number;
  /** Per-bar upsert failures reported by `backfillPrices`. */
  errors: number;
  /** Yahoo calls whose TRANSPORT failed — counted via `onError`. */
  fetchFailures: number;
  /** Yahoo calls that returned ZERO bars without failing. */
  emptyResponses: number;
}

/** What the run writes to `marketDataSyncLog`. */
export interface SyncLogVerdict {
  status: "COMPLETED" | "FAILED";
  /** Null only for a clean run. Persisted to `errorMessage`. */
  reason: string | null;
}

/**
 * Judge a historical backfill.
 *
 * The ordering is "worst first", so the row names the most severe thing that
 * happened rather than the last one checked.
 *
 * A re-run of an already-stored range is deliberately NOT a failure: Yahoo
 * answers with bars, `upsertDailyPrices` finds them all present, and
 * `inserted` is legitimately 0 with nothing broken. That case is the reason the
 * rule is not simply `inserted === 0 → FAILED`.
 */
export function resolveBackfillStatus(t: BackfillTotals): SyncLogVerdict {
  if (t.selected > 0 && t.attempted === 0) {
    return {
      status: "FAILED",
      reason:
        `${t.selected} instrument(s) selected and NONE was fetchable — every ` +
        `one lacked a yahooSymbol or was filtered by isUnfetchableYahooSymbol`,
    };
  }
  if (t.attempted > 0 && t.fetchFailures === t.attempted) {
    return {
      status: "FAILED",
      reason:
        `every one of ${t.attempted} Yahoo fetch(es) failed at the transport ` +
        `layer — this is the egress-block shape, not a quiet market`,
    };
  }
  if (t.attempted > 0 && t.inserted === 0 && t.emptyResponses === t.attempted) {
    return {
      status: "FAILED",
      reason:
        `Yahoo answered for all ${t.attempted} instrument(s) and returned ZERO ` +
        `bars for every one of them`,
    };
  }
  if (t.inserted === 0 && (t.fetchFailures > 0 || t.errors > 0)) {
    return {
      status: "FAILED",
      reason:
        `nothing was written: ${t.fetchFailures} fetch failure(s), ` +
        `${t.errors} upsert error(s) across ${t.attempted} instrument(s)`,
    };
  }
  if (t.fetchFailures > 0 || t.errors > 0) {
    return {
      status: "COMPLETED",
      reason:
        `partial: ${t.inserted} bar(s) written, ${t.fetchFailures} fetch ` +
        `failure(s), ${t.errors} upsert error(s)`,
    };
  }
  return { status: "COMPLETED", reason: null };
}

/** What the quote-refresh branch produced. */
export interface QuoteRefreshTotals {
  /** Quotes `refreshAllQuotes` persisted. */
  refreshed: number;
  /** Per-quote upsert failures it reported. */
  failed: number;
  /**
   * Batch fetches whose TRANSPORT failed — counted via `onError`.
   *
   * `refreshAllQuotes` has a `failed += batch.length` in the catch around
   * `fetchQuotes(...)`, and it is DEAD: `yahooFetchQuotes` wraps its chunks in
   * `Promise.allSettled` and returns a partial Map instead of rejecting
   * (yahoo-api.ts:498-521), so that catch never runs no matter what Yahoo does.
   * This counter is the live replacement.
   */
  fetchFailures: number;
}

/**
 * Judge a quote refresh.
 *
 * `refreshed === 0` IS a failure here, unlike the backfill's `inserted === 0`.
 * There is no idempotent no-op case: `latestQuote.upsert` rewrites the row on
 * every run, so a healthy refresh over a non-empty selection always increments
 * `refreshed`. Zero means the fan-out produced nothing.
 */
export function resolveQuoteRefreshStatus(
  t: QuoteRefreshTotals,
): SyncLogVerdict {
  if (t.refreshed === 0) {
    return {
      status: "FAILED",
      reason:
        `0 quotes refreshed (${t.failed} upsert failure(s), ` +
        `${t.fetchFailures} batch fetch failure(s)) — a healthy refresh ` +
        `rewrites every selected row, so zero means the fan-out produced nothing`,
    };
  }
  if (t.fetchFailures > 0 || t.failed > 0) {
    return {
      status: "COMPLETED",
      reason:
        `partial: ${t.refreshed} refreshed, ${t.failed} upsert failure(s), ` +
        `${t.fetchFailures} batch fetch failure(s)`,
    };
  }
  return { status: "COMPLETED", reason: null };
}
