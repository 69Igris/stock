/**
 * Intraday Sync Processor - MONEY-123 Part A
 *
 * Post-market job that pre-populates the IntradayBar collection with
 * sub-daily OHLCV bars (default intervals: 5m, 15m, 60m) for the
 * "tracked symbols" set. The web app's UDF history route reads from
 * IntradayBar first, so users get multi-week backward-scroll on
 * intraday charts without each request triggering a live upstream hit.
 *
 * Why this matters:
 *   Both Zerodha's Kite Connect historical endpoint and Yahoo's
 *   v8/finance/chart endpoint silently cap intraday responses at
 *   ~3 trading days regardless of the requested window. A chart
 *   that needs 60 days of 5m history can't be served from live
 *   upstream alone - you have to pre-fetch and store. This worker
 *   IS the pre-fetch.
 *
 * Tracked symbols set (computed per-run, not cached):
 *   1. Every InstrumentMapping referenced by a Holding
 *   2. Every InstrumentMapping referenced by a WatchlistItem
 *   3. Every InstrumentMapping referenced by a PaperPosition
 *   4. Deduplicated by instrumentId, capped at 500
 *
 * Source:
 *   Yahoo Finance via @usemoney/core's `yahooFetchChart`. Zerodha
 *   would need system-level credentials with daily-refreshed access
 *   tokens, which we don't have plumbing for in the worker context
 *   yet - punted to a follow-up optimization. Yahoo's retention
 *   (60 days for 5m/15m/30m, 7 days for 1m, 730 days for 60m) is
 *   enough for our 90-day rolling window except for 1m.
 *
 * Retention:
 *   The ingestion itself is append-only. A separate housekeeping job
 *   (not yet scheduled - placeholder in `pruneIntradayBarsOlderThan`)
 *   will delete rows older than 90 days. For now, the table grows.
 */

import type { IntradaySyncMessage } from "@usemoney/types";
import { prisma } from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import {
  backfillIntradayBars,
  yahooFetchChart,
  isUnfetchableYahooSymbol,
  type IntradayInterval,
  type IntradayFetcher,
} from "@usemoney/core/market-data";
import {
  dedupTrackedTuples,
  computeBackfillWindow,
  resolveIntradayStatus,
  DEFAULT_LOOKBACK_DAYS,
  MAX_SYMBOLS_PER_RUN,
} from "./intraday-sync-logic";

// ============== CONSTANTS ==============

const DEFAULT_INTERVALS: IntradayInterval[] = ["5m", "15m", "60m"];

/**
 * Yahoo-side interval labels differ slightly from our canonical labels.
 * Yahoo uses "60m" for hourly, we use "60m" too, so the map is mostly
 * identity - but kept explicit so it's obvious at the upstream boundary.
 */
const YAHOO_INTERVAL_MAP: Record<IntradayInterval, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "60m": "60m",
};

// ============== FETCHER ==============

/**
 * Per-RUN tally of what the fetcher's two silent exits did — MONEY-1238.
 *
 * Deliberately built per invocation and passed in, never a module-level
 * counter: on a warm Cloud Run instance module scope is shared by every
 * request the container ever serves, which turns a per-run number into a
 * lifetime one.
 */
interface IntradayFetchTally {
  /** Calls that short-circuited because the instrument has no Yahoo symbol. */
  unmapped: number;
  /**
   * Of those, the instrument has NO yahooSymbol at all — MONEY-1236.
   *
   * A real mapping break, and the only half of `unmapped` worth a FAILED status.
   */
  unmappedMissing: number;
  /**
   * Of those, the symbol exists and is KNOWN-unfetchable (BSE-only, etc.).
   *
   * Correct and permanent. See `resolveIntradayStatus` for why collapsing the
   * two produced a standing false alarm.
   */
  unmappedUnfetchable: number;
  /** Calls whose TRANSPORT failed. Core reports these as `failed: 0`. */
  fetchFailures: number;
}

/**
 * Wraps `yahooFetchChart` as an IntradayFetcher that the intraday-bar
 * service can call. Looks up the instrument's yahooSymbol from the DB
 * on each call - cheap because the worker already has `prisma` wired.
 *
 * Instruments flagged as `isUnfetchableYahooSymbol` (e.g. BSE-only
 * stocks with no Yahoo ticker mapping) short-circuit to an empty
 * response so the backfill reports "no bars" rather than throwing.
 *
 * Both of those exits — the short-circuit and a swallowed Yahoo error — used to
 * be indistinguishable from "this symbol genuinely had no bars in the window",
 * and `backfillIntradayBars` reports a fetch throw as `failed: 0`, so neither
 * was visible anywhere downstream. They are counted here instead, at the one
 * boundary that can tell them apart.
 */
function makeYahooIntradayFetcher(tally: IntradayFetchTally): IntradayFetcher {
  return async ({ instrumentId, interval, from, to }) => {
    const instrument = await prisma.instrumentMapping.findUnique({
      where: { id: instrumentId },
      select: { yahooSymbol: true },
    });
    if (
      !instrument?.yahooSymbol ||
      isUnfetchableYahooSymbol(instrument.yahooSymbol)
    ) {
      tally.unmapped++;
      // SPLIT BY CAUSE — MONEY-1236. These two are not the same finding:
      //
      //   no yahooSymbol at all  -> the mapping is BROKEN. Fixable, and FAILED.
      //   a known-unfetchable one -> BSE-only and similar. Correct, permanent,
      //                              and nothing is wrong with the run.
      //
      // Collapsed into one counter, a tracked set made entirely of BSE-only
      // instruments wrote `status: FAILED` with the message "an
      // instrument-mapping break" on every single run — a permanent false alarm
      // about a healthy system.
      if (!instrument?.yahooSymbol) tally.unmappedMissing++;
      else tally.unmappedUnfetchable++;
      return [];
    }
    return yahooFetchChart(
      instrument.yahooSymbol,
      {
        period1: from,
        period2: to,
        interval: YAHOO_INTERVAL_MAP[interval],
      },
      {
        onError: (error) => {
          tally.fetchFailures++;
          console.error(
            `[intraday-sync] Yahoo fetch failed for ${instrument.yahooSymbol} ${interval}:`,
            error,
          );
        },
      },
    );
  };
}

// ============== SYMBOL SET RESOLUTION ==============

/**
 * Resolve the set of InstrumentMapping IDs the worker should backfill
 * on this run. Combines three sources:
 *
 *   - Holdings: anything any user holds (highest priority)
 *   - Watchlists: anything any user has explicitly tracked
 *   - Paper positions: anything any user is paper-trading
 *
 * Implementation notes:
 *   - Holding and PaperPosition only store (symbol, exchange); they
 *     don't have an `instrumentId` FK. So we collect the (symbol,
 *     exchange) tuples from all three sources, then do a single
 *     `InstrumentMapping.findMany` to resolve them to IDs.
 *   - WatchlistItem DOES store an optional instrumentId, but for
 *     consistency and to avoid nullable-handling edge cases we use
 *     its (symbol, exchange) pair too.
 *   - Final dedup is by InstrumentMapping.id.
 */
async function resolveTrackedSymbolIds(): Promise<string[]> {
  const [holdings, watchlistItems, paperPositions] = await Promise.all([
    prisma.holding.findMany({
      select: { symbol: true, exchange: true },
      distinct: ["symbol", "exchange"],
    }),
    prisma.watchlistItem.findMany({
      select: { symbol: true, exchange: true },
      distinct: ["symbol", "exchange"],
    }),
    prisma.paperPosition.findMany({
      select: { symbol: true, exchange: true },
      distinct: ["symbol", "exchange"],
    }),
  ]);

  // Dedupe (symbol, exchange) tuples across the three sources.
  const tuples = dedupTrackedTuples(holdings, watchlistItems, paperPositions);

  if (tuples.length === 0) return [];

  // Resolve to InstrumentMapping IDs in one query. We use findMany with
  // an OR of compound conditions rather than `in` on a synthetic key,
  // because Prisma's MongoDB provider doesn't support compound `in`
  // filters on non-index fields.
  const mappings = await prisma.instrumentMapping.findMany({
    where: {
      isActive: true,
      OR: tuples.map((t) => ({
        symbol: t.symbol,
        exchange: t.exchange,
      })),
    },
    select: { id: true },
    take: MAX_SYMBOLS_PER_RUN,
  });

  // Final dedup by ID (findMany can technically return duplicates if
  // the composite unique wasn't hit - belt and suspenders).
  const idSet = new Set<string>();
  for (const m of mappings) idSet.add(m.id);
  return Array.from(idSet);
}

// ============== MAIN PROCESSOR ==============

/** What one run produced. Returned so the route can report it (MONEY-1238). */
export interface IntradaySyncResult {
  ok: boolean;
  reason: string | null;
  symbols: number;
  calls: number;
  inserted: number;
  failed: number;
  unmapped: number;
  /** Of those, invocations whose instrument has NO yahooSymbol — a real break. */
  unmappedMissing: number;
  /** Of those, instruments with a KNOWN-unfetchable symbol (BSE-only, etc.). */
  unmappedUnfetchable: number;
  fetchFailures: number;
}

export async function processIntradaySync(
  data: IntradaySyncMessage,
): Promise<IntradaySyncResult> {
  const {
    intervals = DEFAULT_INTERVALS,
    lookbackDays = DEFAULT_LOOKBACK_DAYS,
    source = "YAHOO",
  } = data;

  // Compute the backfill window. An explicit dateRange wins; otherwise
  // the scheduler passes a lookback (typically 5 days for safety
  // overlap on the daily post-market run). computeBackfillWindow parses
  // each bound defensively so a malformed dateRange can't yield an Invalid
  // Date whose .toISOString() (called in the log line + sync-log metadata
  // immediately below) would throw RangeError and abort the whole backfill.
  const { from, to } = computeBackfillWindow({
    dateRange: data.dateRange,
    lookbackDays,
  });

  // Resolve symbol set.
  const instrumentIds = data.instrumentIds?.length
    ? data.instrumentIds.slice(0, MAX_SYMBOLS_PER_RUN)
    : await resolveTrackedSymbolIds();

  console.log(
    `[intraday-sync] Starting: ${instrumentIds.length} symbols × ${intervals.length} intervals, window ${from.toISOString()} → ${to.toISOString()}, source=${source}`,
  );

  const syncLog = await prisma.marketDataSyncLog.create({
    data: {
      syncType: "INTRADAY_BACKFILL",
      source,
      status: "RUNNING",
      metadata: {
        symbolCount: instrumentIds.length,
        intervals,
        dateRange: { start: from.toISOString(), end: to.toISOString() },
        lookbackDays: data.dateRange ? null : lookbackDays,
      },
    },
  });

  const totals = {
    fetched: 0,
    inserted: 0,
    skipped: 0,
    failed: 0,
    symbolsProcessed: 0,
    // MONEY-1470 — bars mirrored into the intraday ring buffer. Computed by
    // `backfillIntradayBars` and then dropped at this boundary is the
    // MONEY-1250 shape: a Redis accepting NOTHING would report a perfectly
    // healthy sync while every intraday chart answered `no_data`.
    buffered: 0,
  };

  const tally: IntradayFetchTally = {
    unmapped: 0,
    unmappedMissing: 0,
    unmappedUnfetchable: 0,
    fetchFailures: 0,
  };
  const fetcher = makeYahooIntradayFetcher(tally);
  let calls = 0;

  try {
    // Sequential per-symbol loop. We could parallelize within a small
    // concurrency pool, but Yahoo rate-limits aggressively and the
    // worker runs post-market with no latency pressure, so sequential
    // is cheap + safe.
    for (let i = 0; i < instrumentIds.length; i++) {
      const instrumentId = instrumentIds[i]!;

      for (const interval of intervals) {
        calls++;
        const result = await backfillIntradayBars({
          instrumentId,
          interval,
          from,
          to,
          fetch: fetcher,
          source: "YAHOO",
        });

        totals.fetched += result.fetched;
        totals.inserted += result.inserted;
        totals.buffered += result.buffered;
        totals.skipped += result.skipped;
        totals.failed += result.failed;
      }

      totals.symbolsProcessed++;

      // Light rate-limit courtesy: sleep 200ms every 10 symbols. With
      // 3 intervals × 10 symbols = 30 Yahoo calls per burst, this keeps
      // us well under Yahoo's unofficial ~2 req/s threshold.
      if ((i + 1) % 10 === 0) {
        if ((i + 1) % 100 === 0) {
          console.log(
            `[intraday-sync] Progress: ${i + 1}/${instrumentIds.length} symbols (inserted=${totals.inserted})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    // MONEY-1238 — the status is COMPUTED, not a literal. It used to be
    // `status: "COMPLETED"` sitting one line above the very counts that could
    // have decided it, so a run that fetched nothing and wrote nothing closed
    // its row identically to a healthy one.
    const verdict = resolveIntradayStatus({
      symbols: instrumentIds.length,
      calls,
      unmapped: tally.unmapped,
      unmappedMissing: tally.unmappedMissing,
      unmappedUnfetchable: tally.unmappedUnfetchable,
      fetchFailures: tally.fetchFailures,
      fetched: totals.fetched,
      inserted: totals.inserted,
      skipped: totals.skipped,
      failed: totals.failed,
    });

    await prisma.marketDataSyncLog.update({
      where: { id: syncLog.id },
      data: {
        status: verdict.status,
        // `totals.failed` cannot see a transport outage — core reports a fetch
        // throw as `failed: 0` — so the observed failures are added here.
        recordsProcessed: totals.inserted,
        recordsFailed: totals.failed + tally.fetchFailures,
        completedAt: new Date(),
        ...(verdict.reason ? { errorMessage: verdict.reason } : {}),
        metadata: {
          ...(((syncLog.metadata as Record<string, unknown>) ?? {}) as object),
          totals,
          calls,
          unmapped: tally.unmapped,
          unmappedMissing: tally.unmappedMissing,
          unmappedUnfetchable: tally.unmappedUnfetchable,
          fetchFailures: tally.fetchFailures,
        },
      },
    });

    const summary =
      `symbols=${totals.symbolsProcessed}, calls=${calls}, ` +
      `fetched=${totals.fetched}, inserted=${totals.inserted}, ` +
      `skipped=${totals.skipped}, failed=${totals.failed}, ` +
      `buffered=${totals.buffered}, ` +
      `unmapped=${tally.unmapped}, fetchFailures=${tally.fetchFailures}`;
    if (verdict.status === "FAILED") {
      console.error(`[intraday-sync] FAILED: ${verdict.reason} — ${summary}`);
    } else {
      console.log(
        `[intraday-sync] Completed: ${summary}` +
          (verdict.reason ? ` — ${verdict.reason}` : ""),
      );
    }

    // MONEY-1250 — `selected` is BARS OWED A WRITE, not bars fetched.
    //
    // The daily job runs with a 5-day overlap on purpose
    // (DEFAULT_LOOKBACK_DAYS), and `upsertIntradayBars` diffs the window
    // against what is already stored and feeds `createMany` only the `missing`
    // slice. So most of what a healthy run fetches is already in the table and
    // `inserted` is legitimately 0 while `fetched` and `symbols` are in the
    // thousands. Pairing either of those with `inserted` would report
    // "selected 40,000, wrote 0" on every ordinary weekday — the same
    // permanently-firing alarm `resolveIntradayStatus` refuses to raise, and
    // for the same reason.
    //
    // `inserted + failed + fetchFailures` is the owed-work count. `inserted`
    // and `failed` are the two halves of core's `missing` set; `fetchFailures`
    // is a Yahoo call whose transport died, where we cannot know what it would
    // have carried but do know we were owed data and got none — the egress-block
    // shape, which must not report as idle. All three are 0 on the healthy
    // idempotent re-run, so it reports `selected 0` and cannot page.
    //
    // Caveat, written down rather than discovered later: on core's upsert catch
    // path `failed` is `bars.length`, the whole batch rather than the missing
    // slice, so `selected` over-states there. It is still ZERO exactly when
    // nothing was new and nothing broke, which is the property the monitor needs.
    reportJobOutcome({
      job: "intraday-sync",
      // CALLS are no longer folded into the row counters — MONEY-1250. A fetch that
      // never answered produced no bars, so counting one as a selected ROW
      // is the wrong-granularity defect this pair exists to avoid. They are
      // reported in `transportFailures`, which has its own metric and its own
      // warn branch, so a total upstream block stays loud.
      selected: totals.inserted + totals.failed,
      written: totals.inserted,
      failed: totals.failed,
      transportFailures: tally.fetchFailures,
      skippedReason: `${verdict.reason ?? "ok"}; ${summary}`,
    });

    return {
      ok: verdict.status === "COMPLETED",
      reason: verdict.reason,
      symbols: instrumentIds.length,
      calls,
      inserted: totals.inserted,
      failed: totals.failed,
      unmapped: tally.unmapped,
      unmappedMissing: tally.unmappedMissing,
      unmappedUnfetchable: tally.unmappedUnfetchable,
      fetchFailures: tally.fetchFailures,
    };
  } catch (error) {
    // REPORT FIRST — MONEY-1250 review. This used to run the syncLog update
    // ahead of the report, and when the DATABASE is why we are in this catch —
    // the most likely reason — that update throws too, the report never
    // executes, and the "report before rethrowing" guarantee is lost in exactly
    // the incident it was written for. `reportJobOutcome` never throws.
    reportJobOutcome({
      job: "intraday-sync",
      selected: totals.inserted + totals.failed,
      written: totals.inserted,
      failed: totals.failed,
      transportFailures: tally.fetchFailures,
      skippedReason: `threw: ${error instanceof Error ? error.message : "unknown"}`,
    });
    // Best-effort, and explicitly so: the FAILED row is useful but it must not
    // be able to replace the original error with a Prisma one.
    try {
      await prisma.marketDataSyncLog.update({
        where: { id: syncLog.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        },
      });
    } catch (logErr) {
      console.error(
        "[intraday-sync] could not record the FAILED syncLog row:",
        logErr instanceof Error ? logErr.message : logErr,
      );
    }
    throw error;
  }
}
