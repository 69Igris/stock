/**
 * Price Sync Processor
 *
 * Handles the price-sync Pub/Sub job.
 * Fetches historical daily prices and latest quotes from Yahoo Finance
 * and stores them in the DailyPrice and LatestQuote tables.
 *
 * ## The sync-log row is the decider — MONEY-1238
 *
 * `marketDataSyncLog.status` is what an operator and a dashboard read to answer
 * "did last night's price run work". Both branches used to close their row with
 * a LITERAL `"COMPLETED"`, and the backfill branch wrote no counts at all
 * (`runHistoricalBackfill` returned `void`, so its two totals were summed,
 * printed and thrown away at the function boundary). Both statuses are now
 * COMPUTED from the run's real numbers by `resolveBackfillStatus` /
 * `resolveQuoteRefreshStatus`.
 *
 * ## Why the two Yahoo helpers below take an `onError` and not a `try/catch`
 *
 * They HAD a try/catch, and it was unreachable. `yahooFetchChart` and
 * `yahooFetchQuotes` each swallow every transport error internally and return
 * `[]` / a partial Map — deliberately, so a failing quote cannot crash a
 * dashboard render — which means neither ever rejects. The consequence reached
 * further than the dead catch: `refreshAllQuotes`'s own `failed += batch.length`
 * sits in a catch around `fetchQuotes(...)` and is dead for the same reason, so
 * a total Yahoo outage was reported as `0 refreshed, 0 failed`.
 *
 * `YahooFetchErrorOpts.onError` (MONEY-1060) exists for exactly this and is
 * purely observational — the fetchers behave identically with or without it. It
 * is how the worker counts what core swallows, WITHOUT changing core's
 * never-throw contract that ~20 other callers depend on.
 */

import type { PriceSyncMessage } from "@usemoney/types";
import { prisma } from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { incrementCounter } from "@usemoney/datadog";
import {
  backfillPrices,
  refreshAllQuotes,
  yahooFetchChart,
  yahooFetchQuotes,
  isUnfetchableYahooSymbol,
  type YahooQuoteData,
} from "@usemoney/core/market-data";
import {
  resolveSyncType,
  resolveIncrementalDateRange,
  transformRawQuote,
  selectBackfillInstruments,
  shouldDelay,
  shouldLogProgress,
  resolveBackfillStatus,
  resolveQuoteRefreshStatus,
  QUOTE_REFRESH_BATCH_SIZE,
  type BackfillTotals,
  type SyncLogVerdict,
} from "./price-sync-logic";

/**
 * What one run produced, returned rather than logged into the void.
 *
 * `ok` is the sync-log status as a boolean; `retriable` says whether a redriver
 * would help. The ROUTE decides what to do with them — see the note there on
 * why this particular job does not turn `!ok` into a 500.
 */
export interface PriceSyncResult {
  syncType: string;
  ok: boolean;
  reason: string | null;
  recordsProcessed: number;
  recordsFailed: number;
  /** Yahoo calls whose transport failed. The number core throws away. */
  fetchFailures: number;
}

/** Mutable per-run tally handed to the Yahoo fetchers. Never module scope. */
interface YahooErrorTally {
  fetchFailures: number;
}

/**
 * Yahoo Finance fetcher for the worker.
 *
 * `tally` is a per-RUN object, deliberately not a module-level counter: on a
 * warm Cloud Run instance a module-scope number is shared by every invocation
 * the container ever serves, which is a lifetime bug this repo has already paid
 * for once (the stock-document-sync API budget).
 */
function makeHistoricalFetcher(tally: YahooErrorTally) {
  return async function fetchYahooHistorical(
    yahooSymbol: string,
    startDate: Date,
    endDate: Date,
  ): Promise<
    Array<{
      date: Date;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      adjClose?: number;
    }>
  > {
    return yahooFetchChart(
      yahooSymbol,
      { period1: startDate, period2: endDate, interval: "1d" },
      {
        onError: (error) => {
          tally.fetchFailures++;
          console.error(
            `Failed to fetch historical data for ${yahooSymbol}:`,
            error,
          );
        },
      },
    );
  };
}

/**
 * Yahoo Finance batch quote fetcher for the worker.
 * Uses the direct REST API client from @usemoney/core.
 */
function makeBatchQuoteFetcher(tally: YahooErrorTally) {
  return async function fetchYahooBatchQuotes(
    yahooSymbols: string[],
  ): Promise<Map<string, YahooQuoteData>> {
    const results = new Map<string, YahooQuoteData>();

    if (yahooSymbols.length === 0) return results;

    const rawQuotes = await yahooFetchQuotes(yahooSymbols, {
      onError: (error) => {
        tally.fetchFailures++;
        console.error("Failed to fetch batch quotes:", error);
      },
    });

    // Normalize each raw quote via the pure `transformRawQuote` (bogus-change
    // suppression + finite-guarded timestamp) so production and the unit tests
    // run the SAME mapping (no shadow).
    //
    // WRAPPED PER QUOTE — MONEY-1236. An earlier revision removed the try/catch
    // that used to cover both the fetch and this loop. Dropping it around the
    // FETCH was correct (`yahooFetchQuotes` reports through `onError` and does
    // not reject), but it left the transform uncovered: one malformed quote
    // throwing here escaped `refreshAllQuotes` into `processPriceSync`'s catch,
    // which marks the ENTIRE `marketDataSyncLog` row FAILED and rethrows to a
    // 500 — where it previously degraded to a partial quote map.
    //
    // Per quote rather than around the loop, so one bad payload costs one
    // symbol instead of every symbol after it in the batch. Counted, because a
    // transform that throws is a real defect and must not be silent.
    rawQuotes.forEach((quote, symbol) => {
      try {
        results.set(symbol, transformRawQuote(symbol, quote));
      } catch (error) {
        tally.fetchFailures++;
        console.error(
          `Failed to normalize quote for ${symbol}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    });

    return results;
  };
}

export async function processPriceSync(
  data: PriceSyncMessage,
): Promise<PriceSyncResult> {
  const {
    instrumentIds,
    source = "YAHOO",
    incremental,
    incrementalDays = 30,
  } = data;
  let { dateRange } = data;

  // Resolve the `incremental` flag into a concrete dateRange BEFORE the sync
  // log is created, so sync-type classification is correct. This flag is the
  // payload used by the daily `price-backfill-incremental-daily` scheduler.
  // We don't clobber an explicit dateRange - scheduler presets win if both
  // are provided.
  if (!dateRange && incremental) {
    dateRange = resolveIncrementalDateRange(incrementalDays);
    console.log(
      `[price-sync] Incremental mode: computed dateRange ${dateRange.start} → ${dateRange.end} (last ${incrementalDays} days)`,
    );
  }

  console.log(
    `Processing price sync (source: ${source}, instruments: ${instrumentIds?.length ?? "ALL"}, dateRange: ${dateRange ? `${dateRange.start} → ${dateRange.end}` : "quote refresh only"})`,
  );

  const syncType = resolveSyncType(dateRange);

  // Create sync log
  const syncLog = await prisma.marketDataSyncLog.create({
    data: {
      syncType,
      source,
      status: "RUNNING",
      metadata: {
        instrumentCount: instrumentIds?.length ?? "ALL",
        dateRange: dateRange ?? null,
        incremental: incremental === true,
      },
    },
  });

  const tally: YahooErrorTally = { fetchFailures: 0 };

  /** The run's owed-work pair, filled by whichever branch executes. */
  let owed = {
    selected: 0,
    written: 0,
    failed: 0,
    transportFailures: 0,
  };

  /**
   * MONEY-1250 — TWO job ids from ONE processor.
   *
   * It serves two schedules with two different definitions of health:
   * `price-sync-daily` (quote refresh) and `price-backfill-incremental-daily`
   * (historical backfill). A quote refresh that writes nothing is broken; a
   * backfill that writes nothing is usually a correct idempotent re-run.
   * Tagging both `price-sync` would average two populations into one series and
   * the monitor would be reading a number that describes neither run.
   *
   * Written as a branch over two STRING LITERALS rather than a computed id, and
   * that is load-bearing rather than stylistic: the monitor-agreement guard in
   * `packages/datadog/__tests__/job-outcome-coverage.test.ts` extracts emit
   * sites by matching `reportJobOutcome({ job: "…" })` in the source. A
   * `job: someVariable` is invisible to it, so a monitor created for either id
   * would be reported as having no emit site — and, worse, an id that no longer
   * matched its monitor would not fail anything.
   */
  const emitOutcome = (reason: string): void => {
    if (syncType === "PRICE_BACKFILL") {
      reportJobOutcome({
        job: "price-backfill",
        ...owed,
        skippedReason: reason,
      });
    } else {
      reportJobOutcome({ job: "price-sync", ...owed, skippedReason: reason });
    }
  };

  try {
    let verdict: SyncLogVerdict;
    let recordsProcessed: number;
    let recordsFailed: number;

    if (dateRange) {
      // Backfill historical prices. The totals used to stop at this boundary —
      // the function returned `void` and the row below was closed with a
      // literal "COMPLETED" and no counts at all (MONEY-1238).
      const totals = await runHistoricalBackfill(
        instrumentIds,
        new Date(dateRange.start),
        new Date(dateRange.end),
        tally,
      );
      verdict = resolveBackfillStatus(totals);
      recordsProcessed = totals.inserted;
      recordsFailed = totals.errors + totals.fetchFailures;

      // `selected` is BARS OWED A WRITE, not instruments scanned.
      //
      // `totals.selected` is the instrument count and is in the thousands on
      // every run, including the re-run of an already-stored range that
      // `resolveBackfillStatus` deliberately refuses to call FAILED (Yahoo
      // answers with bars, `upsertDailyPrices` finds them all present,
      // `inserted` is legitimately 0 and nothing is wrong). Pairing the two
      // would page on that run nightly.
      //
      // `inserted + errors` is what `upsertDailyPrices` decided to write and
      // either did or did not; `fetchFailures` is a Yahoo call whose transport
      // died, where we were owed data and got none — the egress-block shape,
      // which must not report as idle. All three are 0 on the healthy re-run.
      //
      // KNOWN GAP, stated rather than papered over: two of
      // `resolveBackfillStatus`'s FAILED branches leave all three counters at 0
      // — "selected but NONE fetchable" (`attempted === 0`) and "Yahoo returned
      // ZERO bars for every instrument". Both are real breakages and both
      // report as idle here. They are carried by `verdict.reason`, which is
      // passed as `skippedReason` on every branch, and by the FAILED
      // `marketDataSyncLog` row. Manufacturing a `selected` for them would put
      // a 0/1 flag into a field the monitor reads as a row count.
      //
      // `fetchFailures` moved OUT of the row counters — MONEY-1250 review. It
      // counts CALLS, not rows, and three sibling jobs each had a different
      // convention for the same quantity. It now has its own metric and its own
      // warn branch in `reportJobOutcome`, so the egress-block shape is still
      // loud without a call being reported as a row.
      owed = {
        selected: totals.inserted + totals.errors,
        written: totals.inserted,
        failed: totals.errors,
        transportFailures: totals.fetchFailures,
      };
    } else {
      // Refresh latest quotes for all active instruments
      const result = await refreshAllQuotes(makeBatchQuoteFetcher(tally), {
        instrumentIds,
        batchSize: QUOTE_REFRESH_BATCH_SIZE,
      });

      console.log(
        `Quote refresh complete: ${result.refreshed} refreshed, ${result.failed} failed, ${tally.fetchFailures} batch fetch failure(s)`,
      );

      verdict = resolveQuoteRefreshStatus({
        refreshed: result.refreshed,
        failed: result.failed,
        fetchFailures: tally.fetchFailures,
      });
      recordsProcessed = result.refreshed;

      // MONEY-1469 — the WRITE-THROUGH census, emitted on its OWN counter.
      //
      // NOT folded into `owed`: `JobOutcome` has no such field, and an extra
      // key on a spread is dropped SILENTLY by TypeScript — which is the exact
      // computed-and-then-discarded shape this is meant to fix. A Redis
      // accepting nothing would otherwise report a perfectly healthy sync while
      // `/quotes` answered a miss for every symbol.
      incrementCounter("quote.write_through", result.cached, {
        job: "price-sync",
      });
      console.log(
        `[price-sync] quote write-through: ${result.cached}/${result.refreshed} reached Redis`,
      );
      // `result.failed` cannot see a transport outage — the counter in
      // refreshAllQuotes that would is unreachable (see the module header) —
      // so the observed failures are added here rather than assumed to be in it.
      recordsFailed = result.failed + tally.fetchFailures;

      // The quote branch needs no reinterpretation: `resolveQuoteRefreshStatus`
      // already states the invariant — "`latestQuote.upsert` rewrites the row on
      // every run, so a healthy refresh over a non-empty selection always
      // increments `refreshed`. Zero means the fan-out produced nothing." There
      // is no idempotent no-op here, so instruments-selected against
      // quotes-written is the truthful pair as it stands. `result.selected` is
      // the number `refreshAllQuotes` used to compute and drop (MONEY-1250); an
      // empty instrument table now reports `selected 0` and reads as idle
      // instead of as a broken fan-out.
      owed = {
        selected: result.selected,
        written: result.refreshed,
        // Same split as the backfill branch — MONEY-1250 review: `failed` is
        // quotes we could not persist, `transportFailures` is calls that never
        // answered.
        failed: result.failed,
        transportFailures: tally.fetchFailures,
      };
    }

    await prisma.marketDataSyncLog.update({
      where: { id: syncLog.id },
      data: {
        status: verdict.status,
        recordsProcessed,
        recordsFailed,
        completedAt: new Date(),
        ...(verdict.reason ? { errorMessage: verdict.reason } : {}),
      },
    });

    if (verdict.status === "FAILED") {
      console.error(`[price-sync] ${syncType} FAILED: ${verdict.reason}`);
    } else {
      console.log(
        `Price sync completed${verdict.reason ? ` — ${verdict.reason}` : ""}`,
      );
    }

    emitOutcome(
      `${syncType} ${verdict.status}: ${verdict.reason ?? "clean"}; ` +
        `recordsProcessed=${recordsProcessed} recordsFailed=${recordsFailed} ` +
        `fetchFailures=${tally.fetchFailures}`,
    );

    return {
      syncType,
      ok: verdict.status === "COMPLETED",
      reason: verdict.reason,
      recordsProcessed,
      recordsFailed,
      fetchFailures: tally.fetchFailures,
    };
  } catch (error) {
    // REPORT FIRST — MONEY-1250 review. The syncLog update used to run ahead of
    // this, and when the DATABASE is why we are in this catch — the most likely
    // reason — that update throws too and the report never executes, losing the
    // "report before rethrowing" guarantee in the incident it exists for.
    //
    // `owed` carries whatever the branch managed to fill in; on a throw before
    // either branch assigned it, that is 0/0 — honest, because nothing had been
    // decided yet.
    emitOutcome(`threw: ${error instanceof Error ? error.message : "unknown"}`);

    // Best-effort, and explicitly so: the FAILED row must not be able to
    // replace the original error with a Prisma one.
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
        "[price-sync] could not record the FAILED syncLog row:",
        logErr instanceof Error ? logErr.message : logErr,
      );
    }

    throw error;
  }
}

/**
 * Run historical price backfill for instruments.
 *
 * RETURNS its totals (MONEY-1238). It used to return `void`: `totalInserted`
 * and `totalErrors` were accumulated, printed in one console line, and dropped
 * at this boundary, so the caller closed the sync-log row with a literal
 * "COMPLETED" and no counts. A signal that cannot leave the function it is
 * computed in cannot reach anything that decides.
 */
async function runHistoricalBackfill(
  instrumentIds: string[] | undefined,
  startDate: Date,
  endDate: Date,
  tally: YahooErrorTally,
): Promise<BackfillTotals> {
  // Get instruments to backfill
  // Fetch all active instruments and filter in-memory (avoids Prisma $expr zombie ops)
  const allInsts = await prisma.instrumentMapping.findMany({
    where: { isActive: true },
    select: { id: true, yahooSymbol: true, symbol: true, instrumentType: true },
  });

  const instruments = selectBackfillInstruments(allInsts, instrumentIds);

  console.log(
    `Backfilling ${instruments.length} instruments from ${startDate.toISOString()} to ${endDate.toISOString()}`,
  );

  let totalInserted = 0;
  let totalErrors = 0;
  let attempted = 0;
  let emptyResponses = 0;

  const fetchHistorical = makeHistoricalFetcher(tally);

  for (let i = 0; i < instruments.length; i++) {
    const inst = instruments[i];
    if (
      !inst ||
      !inst.yahooSymbol ||
      isUnfetchableYahooSymbol(inst.yahooSymbol)
    )
      continue;

    attempted++;
    const failuresBefore = tally.fetchFailures;

    const { inserted, errors } = await backfillPrices(
      inst.id,
      inst.yahooSymbol,
      startDate,
      endDate,
      // Wrapped so a Yahoo answer of ZERO BARS is counted as its own state.
      // It is not the same thing as a transport failure — Yahoo answering
      // "nothing here" is deterministic and repeats, a 403 does not — and it is
      // not the same thing as a healthy no-op either, which returns bars that
      // simply already exist. Three states, three counters.
      async (symbol, from, to) => {
        const bars = await fetchHistorical(symbol, from, to);
        if (bars.length === 0 && tally.fetchFailures === failuresBefore) {
          emptyResponses++;
        }
        return bars;
      },
    );

    totalInserted += inserted;
    totalErrors += errors;

    if (shouldLogProgress(i)) {
      console.log(
        `Backfill progress: ${i + 1}/${instruments.length} instruments (${totalInserted} prices inserted)`,
      );
    }

    // Small delay to avoid rate limiting
    if (shouldDelay(i)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  console.log(
    `Backfill complete: ${totalInserted} prices inserted, ${totalErrors} errors, ` +
      `${tally.fetchFailures} fetch failure(s), ${emptyResponses} empty response(s) ` +
      `across ${attempted} of ${instruments.length} instruments`,
  );

  return {
    selected: instruments.length,
    attempted,
    inserted: totalInserted,
    errors: totalErrors,
    fetchFailures: tally.fetchFailures,
    emptyResponses,
  };
}
