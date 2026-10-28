/**
 * Intraday-sync processor — PURE helpers (no Prisma / network).
 *
 * `intraday-sync.ts` used to inline both the tracked-symbol dedup and the
 * backfill-window math directly in the processor body, and the test re-declared
 * byte-for-byte copies of them ("inlined to avoid pulling Prisma into the test
 * runtime"). That made the test a SHADOW — it stayed green even if the real
 * processor's window math broke. These side-effect-free bits now live here so
 * `intraday-sync.ts` imports and CALLS them and the test asserts the REAL code.
 * Mirrors `import-logic.ts` / `mf-sync-logic.ts`.
 *
 * @see workers/src/processors/intraday-sync.ts (caller)
 * @see apps/web/__tests__/workers/intraday-sync.test.ts (tests the real exports)
 */

/** Upper bound on instruments backfilled per run (cap applied by the caller). */
export const MAX_SYMBOLS_PER_RUN = 500;

/** Default look-back window (days) when no explicit dateRange is supplied. */
export const DEFAULT_LOOKBACK_DAYS = 5;

/** A (symbol, exchange) pair as stored on Holding / WatchlistItem / PaperPosition. */
export interface SymbolExchangeTuple {
  symbol: string;
  exchange: string;
}

/**
 * Dedupe (symbol, exchange) tuples across the three tracked sources
 * (holdings → watchlists → paper positions), case-insensitively, preserving
 * first-seen insertion order and dropping rows with an empty symbol OR
 * exchange. Output symbols/exchanges are upper-cased.
 *
 * Pure: the processor passes plain arrays it has already read from Prisma.
 */
export function dedupTrackedTuples(
  holdings: SymbolExchangeTuple[],
  watchlistItems: SymbolExchangeTuple[],
  paperPositions: SymbolExchangeTuple[],
): SymbolExchangeTuple[] {
  const tupleKey = (s: string, e: string): string =>
    `${e.toUpperCase()}:${s.toUpperCase()}`;
  const tupleSet = new Set<string>();
  const tuples: SymbolExchangeTuple[] = [];
  const pushTuple = (symbol: string, exchange: string): void => {
    if (!symbol || !exchange) return;
    const key = tupleKey(symbol, exchange);
    if (tupleSet.has(key)) return;
    tupleSet.add(key);
    tuples.push({
      symbol: symbol.toUpperCase(),
      exchange: exchange.toUpperCase(),
    });
  };
  for (const row of holdings) pushTuple(row.symbol, row.exchange);
  for (const row of watchlistItems) pushTuple(row.symbol, row.exchange);
  for (const row of paperPositions) pushTuple(row.symbol, row.exchange);
  return tuples;
}

/**
 * Parse a date-ish string into a Date, falling back to `fallback` when the
 * input is missing or unparseable.
 *
 * Why this exists (BUG GUARD — MONEY-620): the processor previously did
 * `new Date(data.dateRange.start)` and then *immediately* called
 * `from.toISOString()` in a log line and in the `marketDataSyncLog.create`
 * metadata. A malformed `dateRange` from a hand-built Pub/Sub message (e.g.
 * `{ start: "not-a-date" }`) yields an Invalid Date whose `.toISOString()`
 * throws `RangeError: Invalid time value`, aborting the entire intraday
 * backfill before a single bar is fetched. Coercing to a finite fallback
 * keeps the run alive (it just backfills the default window instead of
 * crashing).
 */
export function parseDateOr(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/**
 * Compute the [from, to] backfill window.
 *
 * - An explicit `dateRange` wins; each bound is parsed defensively (see
 *   {@link parseDateOr}) so an Invalid Date can never reach `.toISOString()`.
 *   A bad `start` falls back to (now − lookback); a bad `end` falls back to now.
 * - Otherwise the window is [now − max(1, lookbackDays), now].
 *
 * Always returns two finite Dates.
 */
export function computeBackfillWindow(args: {
  dateRange?: { start: string; end: string };
  lookbackDays?: number;
  now?: Date;
}): { from: Date; to: Date } {
  const {
    dateRange,
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
    now = new Date(),
  } = args;

  const safeNow = Number.isNaN(now.getTime()) ? new Date() : now;
  const defaultFrom = new Date(safeNow);
  defaultFrom.setDate(defaultFrom.getDate() - Math.max(1, lookbackDays));

  if (dateRange) {
    return {
      from: parseDateOr(dateRange.start, defaultFrom),
      to: parseDateOr(dateRange.end, safeNow),
    };
  }

  return { from: defaultFrom, to: new Date(safeNow) };
}

/* -------------------------------------------------------------------------- */
/* MONEY-1238 — the sync-log STATUS, computed from real counts                 */
/* -------------------------------------------------------------------------- */

/**
 * ## The defect this closes
 *
 * The processor closed its `marketDataSyncLog` row with a LITERAL:
 *
 *     data: { status: "COMPLETED", recordsProcessed: totals.inserted, … }
 *
 * The counts were there — which is what made this one easy to miss — but the
 * STATUS never read them. A run that processed 500 symbols, fetched nothing,
 * inserted nothing and failed nothing wrote a row saying COMPLETED with
 * `recordsProcessed: 0, recordsFailed: 0`, and the only place the difference
 * showed was a console line nobody queries.
 *
 * ## And `totals.failed` cannot see the failure that matters
 *
 * `backfillIntradayBars` (packages/core/.../intraday-bar-service.ts:284-292)
 * catches a fetch throw and returns `{fetched: 0, inserted: 0, skipped: 0,
 * failed: 0}` — **failed: 0**. So a Yahoo egress block is reported by core as
 * "nothing to do", not as a failure, and no amount of reading `totals.failed`
 * would have caught it. The worker's own fetcher counts the swallowed errors
 * via `YahooFetchErrorOpts.onError`, and those counts arrive here as
 * `fetchFailures`.
 *
 * ## The three zero-shapes this separates
 *
 *     fetchFailures === calls   the transport failed for everything.
 *     fetched === 0             Yahoo answered and gave us no bars at all.
 *     inserted === 0, skipped>0 a healthy re-run: every bar was already stored.
 *
 * The last one is why the rule is not `inserted === 0 → FAILED`. The daily job
 * runs with a 5-day overlap on purpose, so most of what it fetches is already
 * in the table.
 */
export interface IntradayTotals {
  /** Instruments the run resolved. */
  symbols: number;
  /** Fetcher invocations issued (symbols × intervals). */
  calls: number;
  /** Invocations short-circuited because the instrument has no Yahoo symbol. */
  unmapped: number;
  /** Of those, the instrument has NO yahooSymbol at all — a mapping BREAK. */
  unmappedMissing: number;
  /**
   * Of those, the symbol exists and is KNOWN-unfetchable (BSE-only, etc.).
   *
   * A correct, permanent state — never a failure. See `resolveIntradayStatus`.
   */
  unmappedUnfetchable: number;
  /** Invocations whose TRANSPORT failed — counted via `onError`. */
  fetchFailures: number;
  /** Bars Yahoo returned. */
  fetched: number;
  /** Bars persisted. */
  inserted: number;
  /** Bars already present. */
  skipped: number;
  /** Bars whose upsert failed. */
  failed: number;
}

/** What the run writes to `marketDataSyncLog`. */
export interface IntradaySyncVerdict {
  status: "COMPLETED" | "FAILED";
  /** Null only for a clean run. Persisted to `errorMessage`. */
  reason: string | null;
}

/** Judge an intraday backfill, worst finding first. */
export function resolveIntradayStatus(t: IntradayTotals): IntradaySyncVerdict {
  if (t.symbols === 0) {
    // Not a failure: nobody holds, watches or paper-trades anything yet. It is
    // still worth saying out loud rather than writing a bare COMPLETED.
    return {
      status: "COMPLETED",
      reason: "no tracked symbols — nothing to back-fill",
    };
  }
  if (t.calls > 0 && t.unmapped === t.calls && t.unmappedUnfetchable === t.calls) {
    // NOT A FAILURE — MONEY-1236. Every tracked instrument has a yahooSymbol and
    // every one of them is known-unfetchable (BSE-only and similar). The
    // population is holdings ∪ watchlist ∪ paper positions, so a small user base
    // holding only BSE-listed names produces exactly this, permanently. Writing
    // FAILED with "an instrument-mapping break" here was a standing false alarm
    // about a healthy system, and a status nobody can ever clear is a status
    // nobody reads.
    return {
      status: "COMPLETED",
      reason:
        `all ${t.calls} fetch(es) short-circuited: every tracked instrument is ` +
        `known-unfetchable from Yahoo (BSE-only or similar). Nothing is broken — ` +
        `there is simply no intraday source for this set`,
    };
  }
  if (t.calls > 0 && t.unmapped === t.calls) {
    return {
      status: "FAILED",
      reason:
        `all ${t.calls} fetch(es) short-circuited, ${t.unmappedMissing} because ` +
        `the instrument has NO yahooSymbol at all — an instrument-mapping break, ` +
        `not a market one`,
    };
  }
  if (t.calls > 0 && t.fetchFailures === t.calls) {
    return {
      status: "FAILED",
      reason:
        `every one of ${t.calls} Yahoo fetch(es) failed at the transport ` +
        `layer — this is the egress-block shape`,
    };
  }
  if (t.calls > 0 && t.fetched === 0) {
    return {
      status: "FAILED",
      reason:
        `${t.calls} fetch(es) across ${t.symbols} symbol(s) returned ZERO bars ` +
        `in total (${t.fetchFailures} transport failure(s), ${t.unmapped} unmapped)`,
    };
  }
  if (t.inserted === 0 && (t.failed > 0 || t.fetchFailures > 0)) {
    return {
      status: "FAILED",
      reason:
        `nothing was written: ${t.failed} upsert failure(s), ` +
        `${t.fetchFailures} fetch failure(s) across ${t.calls} fetch(es)`,
    };
  }
  if (t.failed > 0 || t.fetchFailures > 0) {
    return {
      status: "COMPLETED",
      reason:
        `partial: ${t.inserted} bar(s) written, ${t.failed} upsert failure(s), ` +
        `${t.fetchFailures} fetch failure(s)`,
    };
  }
  return { status: "COMPLETED", reason: null };
}
