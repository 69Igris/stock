/**
 * Intraday Bar Service - Fetch-and-Store Pattern (MONEY-123 Part A)
 *
 * Sibling to yahoo-price-service.ts. Where that module caches daily OHLCV
 * into the DailyPrice collection, this one caches sub-daily bars
 * (1m/5m/15m/30m/60m) into IntradayBar. It exists because both Zerodha
 * and Yahoo's live intraday endpoints cap each response at ~3 trading
 * days regardless of the requested window - see the long comment block
 * in `apps/web/lib/market/historical-fetcher.ts` for the empirical
 * evidence and forum references.
 *
 * Architecture:
 *
 *   [Post-market worker]                    [Web request (chart)]
 *   intraday-sync processor                 UDF /history route
 *          │                                       │
 *          ▼                                       ▼
 *   backfillIntradayBars()                  getIntradayBars()
 *          │                                       │
 *          ▼                                       ▼
 *   upstream fetch ───► upsertIntradayBars ◄── DB read only
 *   (Zerodha + Yahoo)                            (no upstream)
 *          │                                       │
 *          └──────────────► IntradayBar ◄──────────┘
 *
 * The worker writes; the web request reads. The web path NEVER hits an
 * upstream API from inside this service - it's strictly a DB cache. If
 * the DB has no bars for a requested window, the caller (UDF history
 * route) falls through to the live fetcher `fetchHistoricalBars` in the
 * web app, which handles its own Zerodha/Yahoo fan-out.
 *
 * This separation keeps the worker's upstream concerns (which need
 * system-level broker credentials) out of the per-request hot path.
 */

import { prisma } from "@usemoney/database";
import type { PublicPriceSource } from "@usemoney/types";
import type { HistoricalBar } from "./yahoo-price-service";
// MONEY-1470 (A5) — the intraday ring buffer the chart reads.
import { appendBars } from "../intraday/intraday-store";
import { BASE_INTERVAL, type BasisBar } from "../intraday/rollup-logic";

/**
 * Supported intraday interval labels. Matches the interval keys used by
 * historical-fetcher.ts and TradingView's resolution → interval mapping.
 */
export type IntradayInterval = "1m" | "5m" | "15m" | "30m" | "60m";

export const INTRADAY_INTERVALS: readonly IntradayInterval[] = [
  "1m",
  "5m",
  "15m",
  "30m",
  "60m",
] as const;

/**
 * Injected fetcher for an intraday interval. Receives the symbol's
 * yahoo/zerodha identifier + interval + window, returns aggregated
 * OHLCV bars. The web app's `fetchHistoricalBars` wrapper is what
 * callers typically pass in - it handles Zerodha-first, Yahoo-fallback,
 * timezone normalization, and the per-upstream quirks.
 *
 * The signature is intentionally generic (no direct Zerodha/Yahoo
 * dependency) so this module stays inside packages/core where it can
 * be tested without the web app's Next.js runtime.
 */
export type IntradayFetcher = (args: {
  instrumentId: string;
  interval: IntradayInterval;
  from: Date;
  to: Date;
}) => Promise<HistoricalBar[]>;

// ============== DB READ ==============

/**
 * Read cached intraday bars for an instrument+interval+window from the
 * IntradayBar collection. Pure DB read - no upstream calls.
 *
 * Returns an empty array if nothing is cached. The caller decides whether
 * to fall through to a live fetch.
 */
export async function getIntradayBars(
  instrumentId: string,
  interval: IntradayInterval,
  from: Date,
  to: Date,
): Promise<HistoricalBar[]> {
  const rows = await prisma.intradayBar.findMany({
    where: {
      instrumentId,
      interval,
      time: { gte: from, lte: to },
    },
    orderBy: { time: "asc" },
  });
  return rows.map(toHistoricalBar);
}

/**
 * Return the earliest and latest cached bar timestamps for an
 * (instrument, interval) pair. Used by the UDF history route to
 * decide whether to return `no_data` with `nextTime` pointing at the
 * earliest cached bar (for backward-scroll termination).
 */
export async function getCachedIntradayCoverage(
  instrumentId: string,
  interval: IntradayInterval,
): Promise<{ earliest: Date | null; latest: Date | null }> {
  const [first, last] = await Promise.all([
    prisma.intradayBar.findFirst({
      where: { instrumentId, interval },
      orderBy: { time: "asc" },
      select: { time: true },
    }),
    prisma.intradayBar.findFirst({
      where: { instrumentId, interval },
      orderBy: { time: "desc" },
      select: { time: true },
    }),
  ]);
  return {
    earliest: first?.time ?? null,
    latest: last?.time ?? null,
  };
}

// ============== SOURCE GUARD (MONEY-566) ==============

/**
 * Sources whose bars may be persisted to the SHARED IntradayBar / DailyPrice
 * caches. These tables are cross-user caches — the UDF history route reads them
 * back and serves them to ANY user (including no-broker / demo). Per the Zerodha
 * market-data commitment, broker-sourced (per-access-token) data must NEVER land
 * in a shared cache. Only public providers belong here. Extend this as new FREE
 * providers are added (e.g. "ALPHAVANTAGE", "STOOQ"); a broker source (ZERODHA)
 * must never be added.
 *
 * The type itself is the single source of truth in `@usemoney/types` (shared
 * with the Pub/Sub sync-message types); re-exported here for the guard below.
 */
export type { PublicPriceSource };

const PUBLIC_PRICE_SOURCES: ReadonlySet<string> = new Set<PublicPriceSource>([
  "YAHOO",
]);

/**
 * Throw if `source` is not a public provider. This is the structural guard that
 * makes "a Zerodha (or any broker) bar in a shared cache" impossible — even when
 * a dynamically-typed value (e.g. a Pub/Sub `PriceSyncMessage.source` field
 * typed `"YAHOO" | "ZERODHA"`) is routed into a write path. Loud by design: a
 * violation is a programmer error, not a silently-dropped row.
 */
export function assertPublicPriceSource(
  source: string,
): asserts source is PublicPriceSource {
  if (!PUBLIC_PRICE_SOURCES.has(source.toUpperCase())) {
    throw new Error(
      `[market-data] refusing to persist source="${source}" to a shared price ` +
        `cache: only public sources (${Array.from(PUBLIC_PRICE_SOURCES).join(
          ", ",
        )}) may be written to a cross-user cache (MONEY-566 Zerodha compliance).`,
    );
  }
}

// ============== DB WRITE ==============

/**
 * Bulk-insert intraday bars into IntradayBar.
 *
 * Uses the same performance pattern proven in MONEY-121 for DailyPrice:
 *
 *   1. findMany existing (instrumentId, interval, time) triples in the
 *      range being written → O(1) round-trip
 *   2. createMany only the new bars → O(1) round-trip
 *   3. Update today's most recent bar separately so intraday re-runs
 *      refresh the in-progress bar (NOT done here - the worker runs
 *      post-market, so all bars are immutable at ingest time)
 *
 * The naive "upsert in a loop" pattern is O(N) round-trips and was the
 * root cause of the 10s timeout bug in yahoo-price-service before the
 * MONEY-121 fix. This module inherits the same pattern intentionally.
 *
 * Returns counts for observability. "skipped" == already existed, "failed"
 * == bulk insert threw (whole batch lost, logged by caller).
 */
export async function upsertIntradayBars(
  instrumentId: string,
  interval: IntradayInterval,
  bars: HistoricalBar[],
  source: PublicPriceSource = "YAHOO",
): Promise<{ inserted: number; skipped: number; failed: number }> {
  // MONEY-566: structural guard — never persist a non-public (broker) source to
  // the shared IntradayBar cache. Runs even for dynamically-typed callers.
  assertPublicPriceSource(source);

  if (bars.length === 0) {
    return { inserted: 0, skipped: 0, failed: 0 };
  }

  // Find the min/max time so we can bound the diff query to an
  // efficient index scan on [instrumentId, interval, time].
  const times = bars.map((b) => b.date.getTime());
  const minTime = new Date(Math.min(...times));
  const maxTime = new Date(Math.max(...times));

  try {
    const existing = await prisma.intradayBar.findMany({
      where: {
        instrumentId,
        interval,
        time: { gte: minTime, lte: maxTime },
      },
      select: { time: true },
    });
    const existingKeys = new Set(existing.map((r) => r.time.getTime()));

    const missing = bars.filter((b) => !existingKeys.has(b.date.getTime()));

    if (missing.length === 0) {
      return { inserted: 0, skipped: bars.length, failed: 0 };
    }

    const result = await prisma.intradayBar.createMany({
      data: missing.map((bar) => ({
        instrumentId,
        interval,
        time: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        source,
      })),
    });

    return {
      inserted: result.count,
      skipped: bars.length - missing.length,
      failed: 0,
    };
  } catch (error) {
    console.error(
      `[intraday-bar-service] bulk insert failed for ${instrumentId} ${interval}:`,
      error,
    );
    return { inserted: 0, skipped: 0, failed: bars.length };
  }
}

// ============== BACKFILL ==============

/**
 * Backfill intraday bars for one (instrument, interval) over a date
 * range. Called by the `intraday-sync` worker for each tracked symbol
 * on the daily post-market schedule.
 *
 * Flow:
 *   1. Ask the injected fetcher for bars in [from, to]
 *   2. Bulk-insert the result into IntradayBar
 *   3. Return counts for the worker's aggregate summary
 *
 * The fetcher is expected to handle upstream selection, timezone
 * normalization, and any retry/backoff logic. This module only owns
 * the DB side.
 */
export async function backfillIntradayBars(args: {
  instrumentId: string;
  interval: IntradayInterval;
  from: Date;
  to: Date;
  fetch: IntradayFetcher;
  source?: PublicPriceSource;
}): Promise<{
  fetched: number;
  inserted: number;
  skipped: number;
  failed: number;
  /** Bars mirrored into the intraday ring buffer. MONEY-1470. */
  buffered: number;
}> {
  const { instrumentId, interval, from, to, fetch, source = "YAHOO" } = args;

  let bars: HistoricalBar[] = [];
  try {
    bars = await fetch({ instrumentId, interval, from, to });
  } catch (error) {
    console.error(
      `[intraday-bar-service] fetch failed for ${instrumentId} ${interval}:`,
      error,
    );
    return { fetched: 0, inserted: 0, skipped: 0, failed: 0, buffered: 0 };
  }

  if (bars.length === 0) {
    return { fetched: 0, inserted: 0, skipped: 0, failed: 0, buffered: 0 };
  }

  const upsertResult = await upsertIntradayBars(
    instrumentId,
    interval,
    bars,
    source,
  );

  // MONEY-1470 (A5) — mirror the BASE interval into the intraday ring buffer.
  //
  // Only the base: 15m and 60m are DERIVED on read by `rollUp`, and storing
  // them as well would be one series that can disagree with itself — the whole
  // reason the buffer stores one interval rather than four.
  //
  // India's base is 5m, not 1m, and that is a SOURCE fact rather than a
  // preference: Yahoo retains 1m for SEVEN days against 60 for 5m, so a
  // 45-session 1m buffer cannot be filled from the feed this job has.
  const buffered = await mirrorToIntradayBuffer(instrumentId, interval, bars);

  return {
    fetched: bars.length,
    inserted: upsertResult.inserted,
    skipped: upsertResult.skipped,
    failed: upsertResult.failed,
    buffered,
  };
}

/**
 * `instrumentId` -> `SYMBOL:EXCHANGE`, memoised for the life of the process.
 *
 * A run covers up to 500 symbols x 3 intervals. Without this the mirror would
 * add a Mongo round trip per call to a job that already runs against a 600 s
 * Pub/Sub ack deadline — and a handler that overruns it is REDELIVERED, which
 * starts a second copy concurrently rather than merely finishing late.
 *
 * Instrument symbols do not change inside a run, and the cache dies with the
 * process, so a rename is picked up on the next one.
 */
const listingIdCache = new Map<string, string | null>();

async function mirrorToIntradayBuffer(
  instrumentId: string,
  interval: IntradayInterval,
  bars: readonly HistoricalBar[],
): Promise<number> {
  if (interval !== BASE_INTERVAL.IN) return 0;

  let listingId = listingIdCache.get(instrumentId);
  if (listingId === undefined) {
    try {
      const row = await prisma.instrumentMapping.findUnique({
        where: { id: instrumentId },
        select: { symbol: true, exchange: true },
      });
      listingId = row ? `${row.symbol}:${row.exchange}` : null;
      // Cached only on a DETERMINATE answer. A THROW is "we could not find
      // out", and memoising that pinned the symbol to null for the life of a
      // warm container — one Mongo blip silently stopping the mirror for that
      // listing until the next deploy. "Never cache a fail-open default": key
      // the cache on determinacy, not on the value.
      listingIdCache.set(instrumentId, listingId);
    } catch {
      return 0;
    }
  }
  // A bar we cannot key is NOT written under a guess. A wrong listing id does
  // not fail — it files another company's prices under this symbol's chart.
  if (!listingId) return 0;

  const entries: BasisBar[] = bars.map((b) => ({
    // Unix SECONDS, the same tuple the D1 tiles use.
    bar: [
      Math.floor(b.date.getTime() / 1000),
      b.open,
      b.high,
      b.low,
      b.close,
      b.volume ?? 0,
    ],
    // `trade` — Yahoo's India intraday bars are built from prints and carry
    // real volume, unlike the US realtime feed's top-of-book mid.
    basis: "trade",
  }));
  return (await appendBars("IN", listingId, entries)) ? entries.length : 0;
}

// ============== HOUSEKEEPING ==============

/**
 * Delete intraday bars older than `cutoff` for a given instrument.
 * Used by the 90-day rolling retention job (not yet scheduled - hook
 * point for when storage pressure matters).
 *
 * Intentionally accepts an instrumentId so it can be called per-symbol
 * from a worker loop; deleting across the whole collection in one shot
 * would hold a long write lock on MongoDB.
 */
export async function pruneIntradayBarsOlderThan(
  instrumentId: string,
  cutoff: Date,
): Promise<{ deleted: number }> {
  const result = await prisma.intradayBar.deleteMany({
    where: {
      instrumentId,
      time: { lt: cutoff },
    },
  });
  return { deleted: result.count };
}

// ============== HELPERS ==============

function toHistoricalBar(row: {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}): HistoricalBar {
  return {
    date: row.time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  };
}
