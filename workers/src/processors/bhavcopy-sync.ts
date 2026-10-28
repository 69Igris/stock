/**
 * Bhavcopy Sync Processor — free EOD price seed from BSE + NSE (MONEY-851).
 *
 * Replaces the per-symbol Yahoo EOD loop in `price-sync` for the daily close.
 * Instead of one chart request per instrument, this fetches the two free,
 * no-auth end-of-day "bhavcopy" files (BSE plain CSV, NSE ZIP→CSV — both SEBI
 * UDiFF) and seeds `DailyPrice.close` (+ OHLC) for the WHOLE listed universe in
 * two HTTP calls. Rows are joined to `InstrumentMapping` by symbol+exchange,
 * falling back to ISIN (see `resolveInstrumentId`).
 *
 * Behaviour:
 *   - Target day: the message `date` (YYYY-MM-DD) or the most recent NSE
 *     trading day (`resolveTargetDay`). The scheduler fires post-EOD.
 *   - Per-source isolated: a BSE failure can't abort the NSE leg and vice
 *     versa (each is wrapped in its own try/catch and recorded separately).
 *   - 404 (weekend / holiday / pre-EOD) is NOT an error — the fetcher returns
 *     `[]` and the day no-ops.
 *   - Optional `includeIndices`: also pull the NSE all-indices close file (only
 *     logged for now — there is no index-quote price model to write to yet;
 *     see "owed" note below).
 *   - Optional backfill: `backfillFrom..backfillTo` walks each trading day,
 *     paced ~1 req/sec per source to stay polite to the exchange hosts.
 *
 * The upsert mirrors `yahoo-price-service.upsertDailyPrices`: bulk `createMany`
 * the immutable past + per-row `upsert` for the target day (whose close is the
 * one that can be re-seeded). `source` is recorded as "BHAVCOPY" on the
 * DailyPrice rows so the row's provenance is auditable alongside YAHOO/ZERODHA.
 */

import { prisma } from "@usemoney/database";
import type { BhavcopySyncMessage } from "@usemoney/types/pubsub";
import {
  toIstDateKey,
  fetchBseBhavcopy,
  fetchNseBhavcopy,
  fetchNseIndicesClose,
  type BhavcopyRow,
  NSE_TRUST_SERIES,
} from "@usemoney/core/market-data";
import {
  toBhavcopyDateToken,
  diffFeedArchiveCounters,
  getFeedArchiveStore,
  judgeReplayHealth,
  readFeedArchiveCounters,
  resolveFeedArchiveMode,
  type FeedArchiveMode,
} from "@usemoney/core/market-data";
import { metrics } from "@usemoney/datadog/metrics";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import {
  resolveTargetDay,
  resolveBackfillDays,
  resolveExchanges,
  buildInstrumentIndex,
  planMetadataBackfill,
  DEFAULT_INSTRUMENT_TYPE,
  buildTypeWriteData,
  resolveInstrumentId,
  symbolExchangeKey,
  isinExchangeKey,
  selectTrustsToMint,
  toIndexSlug,
  type BhavcopyExchange,
  type InstrumentIndex,
  isHistoricalRun,
} from "./bhavcopy-sync-logic";

/** DailyPrice provenance tag for bhavcopy-sourced rows. */
const SOURCE = "BHAVCOPY";

/** Polite pacing between exchange requests during a backfill (~1 req/sec). */
const BACKFILL_REQUEST_DELAY_MS = 1000;

const log = {
  info: (...a: unknown[]) => console.log("[bhavcopy-sync]", ...a),
  warn: (...a: unknown[]) => console.warn("[bhavcopy-sync]", ...a),
  error: (...a: unknown[]) => console.error("[bhavcopy-sync]", ...a),
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Say out loud whether this run actually replayed — MONEY-1194.
 *
 * QA ran `FEED_ARCHIVE_MODE=replay` against a working prod→QA mirror and still
 * scraped NSE + BSE for 100% of the daily bhavcopy, every weekday, for weeks:
 * the schedule made QA ask for day D's object ~3h45m before the mirror copied
 * it, so both reads missed and both fell back to the exchange. Nothing failed —
 * the fallback is the designed behaviour, the prices were right, and
 * `MarketDataSyncLog.source` says "BHAVCOPY" whichever way the bytes arrived.
 * The counters that told the true story were printed in the summary line below
 * and NOTHING asserted on them.
 *
 * So this is the assertion. The decision is pure and tested
 * (`judgeReplayHealth`); this shell only routes it to a log level and a metric.
 * The metric is the alertable half: `feed.archive.replay.degraded` should be
 * flat zero on a healthy QA, so a monitor on "> 0 in the last 24h" catches a
 * re-broken schedule the day it breaks rather than at the next audit.
 *
 * NEVER THROWS. It is called on the success path — where a throw would convert
 * a finished run into a FAILED sync log — and inside the catch, where a throw
 * would replace the real error with an observability one. An observability
 * helper must not be able to break the job it observes.
 */
function reportReplayHealth(fa: {
  mode: FeedArchiveMode;
  replayHits: number;
  replayMisses: number;
  replayRejected: number;
}): void {
  try {
    const verdict = judgeReplayHealth({
      mode: fa.mode,
      // Not derivable from the counters: replay + no store means the replay
      // branch never runs, so every counter stays 0 and the run looks idle.
      storeRegistered: getFeedArchiveStore() !== null,
      counters: fa,
    });

    if (verdict.message) {
      if (verdict.level === "warn") log.warn(verdict.message);
      else log.info(verdict.message);
    }

    if (verdict.degraded) {
      metrics.increment("feed.archive.replay.degraded", 1, {
        job: "bhavcopy-sync",
        reason: verdict.reason,
      });
    }
  } catch (err) {
    log.warn("replay-health report failed (ignored):", err);
  }
}

export async function processBhavcopySync(
  data: BhavcopySyncMessage,
): Promise<void> {
  const exchanges = resolveExchanges(data.exchanges);
  const backfillDays = resolveBackfillDays(data.backfillFrom, data.backfillTo);
  const isBackfill = backfillDays.length > 0;

  const days = isBackfill ? backfillDays : [resolveTargetDay(data.date)];

  // Whether a given day is HISTORICAL, derived from the day itself rather than
  // from which message field was populated.
  //
  // The previous version keyed the destructive-write guards off `isBackfill`,
  // i.e. off `backfillFrom`/`backfillTo` — and NOTHING in this repo publishes
  // those fields. The scheduler sends `{"includeIndices":true}`; the documented
  // manual knob is `date`, which `resolveTargetDay` honours verbatim with no
  // recency bound. So `{"date":"2019-04-01"}` — "re-seed that day's closes" —
  // had `isBackfill === false` and a 2019 settlement series decided today's
  // `instrumentType` and cleared `sector`/`industry`, unattended and with no
  // rollback file. The guard was on the axis nobody can invoke while the axis
  // operators actually use was wide open.
  //
  // Compared against the AUTO-resolved target, not against today: on a Monday
  // (or after a holiday) the nightly run legitimately processes Friday's file,
  // and a naive `day < today` would wrongly call that historical and skip the
  // classification the job exists to do.
  const autoDay = resolveTargetDay(undefined);
  const autoKey = toIstDateKey(autoDay);
  const isHistoricalDay = (day: Date): boolean =>
    isHistoricalRun(autoKey, toIstDateKey(day));

  log.info(
    `Starting (exchanges: ${exchanges.join("+")}, ${
      isBackfill
        ? `backfill ${backfillDays.length} days ${data.backfillFrom}..${data.backfillTo}`
        : `day ${toBhavcopyDateToken(days[0]!)}`
    }, indices: ${data.includeIndices === true})`,
  );

  /** Run shape, kept so the terminal update can re-state it rather than
   *  overwrite it (the COMPLETED update used to drop exchanges/days). */
  const runMetadata = {
    exchanges,
    days: days.map(toBhavcopyDateToken),
    backfill: isBackfill,
    includeIndices: data.includeIndices === true,
  };

  const syncLog = await prisma.marketDataSyncLog.create({
    data: {
      syncType: "PRICE_BACKFILL",
      source: SOURCE,
      status: "RUNNING",
      metadata: runMetadata,
    },
  });

  /**
   * MONEY-1157 — where the day's bytes came from.
   *
   * `source` is "BHAVCOPY" whether the file was replayed from the GCS archive
   * or scraped from the exchange, so nothing in the database could tell those
   * apart: a QA that silently stopped replaying, or a prod that silently
   * stopped archiving, would present as "everything COMPLETED, counts normal".
   * Snapshot-and-diff rather than reset, because another job can be running in
   * the same worker process and a reset would steal its counts.
   */
  const feedArchiveBefore = readFeedArchiveCounters();
  const feedArchiveDelta = () => ({
    mode: resolveFeedArchiveMode(),
    ...diffFeedArchiveCounters(feedArchiveBefore, readFeedArchiveCounters()),
  });

  let totalUpserted = 0;
  let totalFailed = 0;
  /**
   * Rows READ out of the exchange files, summed across every exchange/day —
   * MONEY-1238. This is the run's SELECTED count: the bhavcopy row is the unit
   * of work, and `upserted` is already the count of rows persisted. Without it
   * there is no denominator anywhere, so "the file was empty" and "we read
   * 7,400 rows and matched none of them to an instrument" are the same number.
   */
  let totalFetched = 0;
  /**
   * Metadata-backfill counts, accumulated across every exchange/day in the run
   * so they can be PERSISTED on the sync log rather than existing only in a log
   * line. `plannedX` vs `xWritten` is the diagnostic pair: planned > 0 with
   * written === 0 means the strict WHEREs rejected everything, which is a
   * failure that used to look identical to convergence.
   */
  const metadataTotals = {
    seriesWritten: 0,
    isinWritten: 0,
    typeWritten: 0,
  };

  try {
    // Build the instrument lookup ONCE for the whole run (the universe doesn't
    // change between days within a single backfill).
    const index = await loadInstrumentIndex();
    log.info(
      `Instrument index: ${index.byIsinExchange.size} ISINs, ${index.bySymbolExchange.size} symbol@exchange keys`,
    );

    for (let d = 0; d < days.length; d++) {
      const day = days[d]!;
      const token = toBhavcopyDateToken(day);

      for (let e = 0; e < exchanges.length; e++) {
        const exchange = exchanges[e]!;
        try {
          const { upserted, failed, fetched, metadata } =
            await ingestExchangeDay(exchange, day, index, isHistoricalDay(day));
          totalFetched += fetched;
          totalUpserted += upserted;
          totalFailed += failed;
          if (metadata) {
            metadataTotals.seriesWritten += metadata.seriesWritten;
            metadataTotals.isinWritten += metadata.isinWritten;
            metadataTotals.typeWritten += metadata.typeWritten;
          }
          log.info(
            `${exchange} ${token}: fetched ${fetched}, upserted ${upserted}, unmatched/failed ${failed}`,
          );
        } catch (err) {
          // Per-source isolation: record but keep going to the other exchange /
          // the next day. Counts as the whole-source failing for this day.
          totalFailed += 1;
          log.error(`${exchange} ${token} failed:`, err);
        }

        // Pace between exchange requests during a multi-day backfill.
        if (
          isBackfill &&
          !(d === days.length - 1 && e === exchanges.length - 1)
        ) {
          await sleep(BACKFILL_REQUEST_DELAY_MS);
        }
      }

      // Indices are NSE-only and a daily concern; pull once per day if asked.
      if (data.includeIndices) {
        try {
          await ingestIndicesDay(day);
        } catch (err) {
          log.warn(`indices ${token} failed:`, err);
        }
      }
    }

    await prisma.marketDataSyncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "COMPLETED",
        recordsProcessed: totalUpserted,
        recordsFailed: totalFailed,
        completedAt: new Date(),
        // The metadata half's counts, persisted. Without them the row said
        // COMPLETED with price counts only, so a permanently dead
        // classification backfill was indistinguishable from a converged one in
        // the one place an operator would look days later.
        metadata: {
          ...runMetadata,
          ...metadataTotals,
          feedArchive: feedArchiveDelta(),
        },
      },
    });
    const fa = feedArchiveDelta();
    log.info(
      `Done: ${totalUpserted} prices upserted, ${totalFailed} failed ` +
        `(feed archive mode=${fa.mode} replayHits=${fa.replayHits} ` +
        `replayMisses=${fa.replayMisses} replayRejected=${fa.replayRejected} ` +
        `archived=${fa.archived} skipped=${fa.archiveSkipped} ` +
        `failed=${fa.archiveFailed} timedOut=${fa.archiveTimedOut})`,
    );
    reportReplayHealth(fa);
    reportBhavcopyOutcome(totalFetched, totalUpserted, totalFailed, fa);
  } catch (err) {
    await prisma.marketDataSyncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "FAILED",
        recordsProcessed: totalUpserted,
        recordsFailed: totalFailed,
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : "Unknown error",
        // Recorded on the failure path TOO: "did QA replay or scrape?" is at
        // its most interesting on the run that failed.
        metadata: {
          ...runMetadata,
          ...metadataTotals,
          feedArchive: feedArchiveDelta(),
        },
      },
    });
    // Judged on the failure path too, for the same reason the delta is
    // persisted here: "did QA replay or scrape?" is at its most interesting on
    // the run that failed, and the throw below only tells the operator that
    // SOMETHING broke.
    reportReplayHealth(feedArchiveDelta());
    // Reported on the failure path TOO. A run that threw mid-way has still
    // usually written SOME prices, and the number that matters to the zero-write
    // monitor is what actually landed — not whether the process ended tidily.
    // Skipping it here would make the crashed run the one run that emits no
    // metric, which `notify_no_data` then reads as "the job did not run".
    reportBhavcopyOutcome(
      totalFetched,
      totalUpserted,
      totalFailed,
      feedArchiveDelta(),
      err instanceof Error ? err.message : "unknown error",
    );
    throw err;
  }
}

/**
 * One job-outcome per bhavcopy run — MONEY-1238.
 *
 * `bhavcopy-sync` was monitored for the zero-write class and emitted no metric
 * at all, so its monitor was in NO DATA from creation. Both numbers are ROWS
 * and they come from the same pipeline, so the pair is directly comparable:
 * `fetched` is what the exchange files contained, `upserted` is what reached
 * `DailyPrice`.
 *
 * The feed-archive counters ride in `skippedReason` because they name the most
 * likely cause of a zero-write night on QA: `replayMisses` with `replayHits: 0`
 * is the mirror not having landed yet (MONEY-1194), which looks exactly like an
 * exchange holiday from the price counts alone.
 *
 * NEVER THROWS, for the same reason `reportReplayHealth` does not: it is called
 * on the success path, where a throw would turn a finished run into a failed
 * one, and inside the catch, where a throw would replace the real error with an
 * observability one.
 */
function reportBhavcopyOutcome(
  fetched: number,
  upserted: number,
  failed: number,
  fa: {
    mode: FeedArchiveMode;
    replayHits: number;
    replayMisses: number;
    replayRejected: number;
  },
  error?: string,
): void {
  try {
    const measurements =
      `fetched=${fetched} upserted=${upserted} failed=${failed} ` +
      `archiveMode=${fa.mode} replayHits=${fa.replayHits} ` +
      `replayMisses=${fa.replayMisses} replayRejected=${fa.replayRejected}` +
      (error ? ` threw=${error}` : "");

    reportJobOutcome({
      job: "bhavcopy-sync",
      selected: fetched,
      written: upserted,
      failed,
      skippedReason:
        fetched > 0 && upserted === 0
          ? `read ${fetched} bhavcopy row(s) and persisted none: ${measurements}`
          : measurements,
    });
  } catch (err) {
    log.warn("job-outcome report failed (ignored):", err);
  }
}

/**
 * Counts written by the opportunistic instrument-metadata backfill
 * (MONEY-1093), threaded up so they reach the MarketDataSyncLog row.
 */
interface MetadataBackfillCounts {
  seriesWritten: number;
  isinWritten: number;
  typeWritten: number;
}

/** Load all active instruments and build the ISIN + symbol@exchange index. */
async function loadInstrumentIndex(): Promise<InstrumentIndex> {
  const instruments = await prisma.instrumentMapping.findMany({
    where: { isActive: true },
    select: { id: true, isin: true, symbol: true, exchange: true },
  });
  return buildInstrumentIndex(instruments);
}

/**
 * Fetch + parse + upsert one exchange's bhavcopy for one day.
 * A non-trading day (404) yields `fetched: 0` and is a clean no-op.
 */
async function ingestExchangeDay(
  exchange: BhavcopyExchange,
  day: Date,
  index: InstrumentIndex,
  /** Historical re-seed — see `upsertBhavcopyRows`. */
  isBackfill: boolean,
): Promise<{
  fetched: number;
  upserted: number;
  failed: number;
  /**
   * Metadata-backfill counts, threaded up so they reach the sync log.
   *
   * OPTIONAL, not `| null` (MONEY-1157): the no-rows early return below genuinely
   * omits the key, and `null` is what the caller's `.catch` substitutes when the
   * backfill throws. The declaration used to require it, which `tsc` flagged
   * (TS2741) while `tsup`/esbuild — which never type-checks — shipped the correct
   * runtime. The consumer tests `if (metadata)`, so absent and null are already
   * indistinguishable; adding `metadata: null` to the early returns instead would
   * have been a needless runtime change.
   */
  metadata?: MetadataBackfillCounts | null;
}> {
  const rows =
    exchange === "BSE"
      ? await fetchBseBhavcopy(day)
      : await fetchNseBhavcopy(day);

  if (rows.length === 0) return { fetched: 0, upserted: 0, failed: 0 };

  // MONEY-1085 follow-up: create any missing REIT/InvIT instrument BEFORE the
  // join, so their prices land on the same pass rather than a day later.
  await mintMissingTrustInstruments(rows, index);

  const { upserted, failed, metadata } = await upsertBhavcopyRows(
    rows,
    day,
    index,
    isBackfill,
  );
  return { fetched: rows.length, upserted, failed, metadata };
}

/**
 * Create NSE InstrumentMapping rows for exchange-traded trusts (series RR /
 * IV) that we don't already have, and add them to the in-memory index.
 *
 * ## Why minting from a price feed is justified HERE and nowhere else
 *
 * Instruments should come from an instrument master, not a price file — a
 * price feed knows nothing about lot size, tick size or segment, and minting
 * from one generally would let a bad parse invent junk instruments.
 *
 * REITs and InvITs are the one case with no alternative:
 *   - NSE publishes no REIT/InvIT master CSV (EQUITY_L / SME_EQUITY_L are
 *     equity-only), and
 *   - Zerodha's dump carries only their BSE listing.
 * So the bhavcopy row is the ONLY NSE-side record we ever receive, and it
 * carries everything we need: symbol, ISIN and the registered name.
 *
 * Scoping is deliberately narrow — {@link NSE_TRUST_SERIES} is exactly two
 * series on one exchange. A row of any other series is never minted, so a
 * future parser regression can't quietly populate the universe from prices.
 *
 * Idempotent: keyed on the `symbol_exchange` unique index, and rows already in
 * the index are skipped. Never throws — a mint failure must not cost us the
 * ~7,400 prices the rest of the run is about to write.
 */
async function mintMissingTrustInstruments(
  rows: BhavcopyRow[],
  index: InstrumentIndex,
): Promise<void> {
  const candidates = selectTrustsToMint(rows, index, NSE_TRUST_SERIES);
  if (candidates.length === 0) return;

  let minted = 0;
  for (const row of candidates) {
    const instrumentType = NSE_TRUST_SERIES[row.series]!;
    try {
      const created = await prisma.instrumentMapping.upsert({
        where: {
          symbol_exchange: { symbol: row.symbol, exchange: row.exchange },
        },
        create: {
          symbol: row.symbol,
          exchange: row.exchange,
          name: row.name || row.symbol,
          instrumentType,
          series: row.series,
          ...(row.isin ? { isin: row.isin } : {}),
          yahooSymbol: `${row.symbol}.NS`,
          isActive: true,
          lastSyncedAt: new Date(),
        },
        // Only ever correct the classification on an existing row; never
        // overwrite a real instrument-master record from a price file.
        //
        // Reactivation is now GUARDED — see the updateMany below. The index is
        // built from active rows only, so an INACTIVE row is invisible to
        // `selectTrustsToMint` and always looks like a mint candidate; an
        // unguarded `isActive: true` here therefore resurrected AND retyped a
        // deliberately deactivated listing, on the authority of a price file.
        // This update only ever refreshes the sync timestamp.
        update: { lastSyncedAt: new Date() },
        select: { id: true },
      });

      // Classification and reactivation, applied ONLY to a row that is already
      // active. A trust that traded today is demonstrably live, but "it traded"
      // is not authority to undo a deliberate deactivation — that decision
      // belongs to the instrument master, not the price feed. A genuinely
      // dormant-then-relisted security needs a human or the master sync.
      const reactivated = await prisma.instrumentMapping.updateMany({
        where: { id: created.id, isActive: true },
        data: { instrumentType, lastSyncedAt: new Date() },
      });
      if (reactivated.count === 0) {
        log.warn(
          `${instrumentType} ${row.symbol}@${row.exchange} traded but its row is ` +
            `INACTIVE — not reactivating from a price file. Left for the ` +
            `instrument master.`,
        );
      }

      index.bySymbolExchange.set(
        symbolExchangeKey(row.symbol, row.exchange),
        created.id,
      );
      if (row.isin) {
        index.byIsinExchange.set(
          isinExchangeKey(row.isin, row.exchange),
          created.id,
        );
      }
      minted++;
    } catch (err) {
      log.warn(
        `Could not mint ${instrumentType} ${row.symbol}@${row.exchange}:`,
        err,
      );
    }
  }

  if (minted > 0) {
    log.info(
      `Minted ${minted} NSE trust instrument(s) from the bhavcopy (REIT/InvIT — no master source exists)`,
    );
  }
}

/**
 * Upsert bhavcopy close prices into DailyPrice.
 *
 * Performance mirrors `yahoo-price-service.upsertDailyPrices`: the bhavcopy
 * `date` is a single immutable trading day, so we
 *   1. resolve each row to an instrumentId (drop unmatched),
 *   2. findMany existing DailyPrice rows for that (instrumentId set, date) in
 *      one query,
 *   3. createMany the missing rows in one query,
 *   4. upsert the rows that already existed (a re-run for the same day refreshes
 *      the close — e.g. a corrected bhavcopy).
 * That's ~3 round-trips regardless of row count, instead of N upserts.
 */
async function upsertBhavcopyRows(
  rows: BhavcopyRow[],
  day: Date,
  index: InstrumentIndex,
  /**
   * True when this day came from an operator-supplied `backfillFrom..backfillTo`
   * range rather than the scheduled daily run.
   *
   * A historical file must NOT drive the retype. `instrumentType` is CURRENT
   * state, and a re-seed of last year's closes would otherwise decide it from
   * last year's series — unattended, with no dry run and no rollback file, on a
   * job an operator invokes for an unrelated reason ("re-seed prices"). Series
   * ISIN is still backfilled — it is an immutable fact about the instrument,
   * not a judgement about what it currently IS.
   *
   * `series` is NOT. An earlier version of this comment said "Series and ISIN
   * are still backfilled", which the code below contradicts: the series write is
   * `isBackfill ? [] : plan.seriesGroups`, and deliberately so — a re-seed of
   * last year's closes carries last year's series, and writing that over the
   * current value would feed a stale classification straight into the retype.
   * The comment mattered because an operator running a targeted re-seed
   * SPECIFICALLY to improve series coverage would have got nothing, and been
   * told otherwise.
   */
  isBackfill: boolean,
): Promise<{
  upserted: number;
  failed: number;
  /** See `ingestExchangeDay` — optional because the early returns omit it. */
  metadata?: MetadataBackfillCounts | null;
}> {
  // The DailyPrice.date is the bhavcopy trading date (UTC midnight) — every row
  // in a file shares it, so take it from the parsed row (already UTC-midnight).
  const date = rows[0]!.date;

  // Resolve rows → instrumentId, dropping unmatched (not in our universe yet).
  const resolved: Array<{ instrumentId: string; row: BhavcopyRow }> = [];
  let unmatched = 0;
  for (const row of rows) {
    const instrumentId = resolveInstrumentId(row, index);
    if (!instrumentId) {
      unmatched++;
      continue;
    }
    resolved.push({ instrumentId, row });
  }

  if (resolved.length === 0) return { upserted: 0, failed: unmatched };

  // MONEY-1093 - persist the exchange's own series/group and ISIN onto the
  // instrument. Both fields arrive in every bhavcopy row and were used only
  // to mint REIT/InvIT rows; on the existing universe `series` was uniformly
  // the stamped default "EQ" and `isin` was populated on ZERO of 22,090 rows.
  // Those two fields are what tell EQUITY from DEBT, so without them 11,795
  // debt instruments sat in the equity universe. Best-effort: a metadata
  // write must never fail the price seed this job exists for.
  // Dedupe by instrumentId (two listings can resolve to the same id only via a
  // data anomaly; keep the first to avoid a createMany unique-key clash).
  const byInstrument = new Map<string, BhavcopyRow>();
  for (const { instrumentId, row } of resolved) {
    if (!byInstrument.has(instrumentId)) byInstrument.set(instrumentId, row);
  }
  const instrumentIds = [...byInstrument.keys()];

  let upserted = 0;
  let failed = unmatched;

  try {
    // Which of these instruments already have a row for this date?
    const existing = await prisma.dailyPrice.findMany({
      where: { instrumentId: { in: instrumentIds }, date },
      select: { instrumentId: true },
    });
    const existingIds = new Set(existing.map((r) => r.instrumentId));

    const missing = instrumentIds.filter((id) => !existingIds.has(id));
    const present = instrumentIds.filter((id) => existingIds.has(id));

    if (missing.length > 0) {
      const result = await prisma.dailyPrice.createMany({
        data: missing.map((id) =>
          toDailyPriceCreate(id, byInstrument.get(id)!),
        ),
      });
      upserted += result.count;
    }

    // Re-seed the close for rows that already existed (corrected bhavcopy).
    for (const id of present) {
      const row = byInstrument.get(id)!;
      try {
        await prisma.dailyPrice.update({
          where: { instrumentId_date: { instrumentId: id, date } },
          data: {
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: Math.trunc(row.volume),
            source: SOURCE,
          },
        });
        upserted++;
      } catch (err) {
        log.warn(`update failed for instrument ${id}:`, err);
        failed++;
      }
    }
  } catch (err) {
    log.error("bhavcopy bulk upsert failed:", err);
    failed += instrumentIds.length;
  }

  // Metadata LAST, and that ordering is load-bearing.
  //
  // This used to run before the price write, which contradicted its own
  // contract ("a metadata write must never fail the price seed this job exists
  // for"). It could not FAIL the seed — the `.catch` covers that — but it could
  // STARVE it: on the first post-deploy run the ISIN half issues one write per
  // instrument, so a Cloud Run timeout part-way through meant that day's prices
  // never landed at all, and Pub/Sub then retried the same shape. Prices are the
  // job's purpose; metadata is opportunistic and can wait for tomorrow.
  // Counts are CAPTURED and returned so they can reach the sync log. They used
  // to exist only in a log line, so `recordsProcessed` on the
  // MarketDataSyncLog row was price counts alone — nothing in the DATABASE
  // could distinguish "the classification backfill has been dead for weeks"
  // from "the universe converged".
  const metadata = await backfillInstrumentMetadata(
    resolved,
    index,
    isBackfill,
  ).catch((error) => {
    log.warn("instrument metadata backfill failed (prices unaffected):", error);
    return null;
  });

  return { upserted, failed, metadata };
}

/** Map a resolved bhavcopy row to a DailyPrice.createMany record. */
function toDailyPriceCreate(instrumentId: string, row: BhavcopyRow) {
  return {
    instrumentId,
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    // DailyPrice.volume is an Int; bhavcopy volume is shares (whole) but guard.
    volume: Math.trunc(row.volume),
    source: SOURCE,
  };
}

/**
 * Fetch the NSE all-indices close for a day.
 *
 * NOTE (owed): there is no per-index quote/price model to persist these to
 * today (index levels aren't InstrumentMapping rows with DailyPrice history in
 * the general case). For now this only fetches + logs the count so the seam is
 * wired and the scheduler can pass `includeIndices`. When an index-history
 * model lands, write the rows here. Best-effort — a failure never aborts the
 * price seed.
 */
async function ingestIndicesDay(day: Date): Promise<void> {
  const indices = await fetchNseIndicesClose(day);
  if (indices.length === 0) {
    log.info(`indices ${toBhavcopyDateToken(day)}: none published`);
    return;
  }

  // MONEY-1085 follow-up: these used to be fetched and thrown away every
  // trading day ("no index-history model yet"), leaving us with no index
  // history to benchmark a portfolio against. NSE only serves a limited
  // window, so every day discarded was unrecoverable.
  let upserted = 0;
  let failed = 0;
  for (const row of indices) {
    const indexSlug = toIndexSlug(row.name);
    // A blank/garbage name yields an empty slug — skip rather than write a
    // row that can never be looked up.
    if (!indexSlug) {
      failed++;
      continue;
    }
    try {
      await prisma.indexClose.upsert({
        where: { indexSlug_date: { indexSlug, date: row.date } },
        create: {
          indexSlug,
          name: row.name,
          date: row.date,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          prevClose: row.prevClose,
          // MONEY-1100 P4.2 — without these here, the daily job would keep
          // writing OHLC-only rows and the valuation columns would exist only
          // where the backfill reached: history rich, today permanently null.
          pe: row.pe,
          pb: row.pb,
          divYield: row.divYield,
          volume: row.volume,
          turnoverCr: row.turnoverCr,
        },
        // Re-running a day refreshes the close (NSE does republish corrected
        // files); the slug + date stay the identity.
        update: {
          name: row.name,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          prevClose: row.prevClose,
          pe: row.pe,
          pb: row.pb,
          divYield: row.divYield,
          volume: row.volume,
          turnoverCr: row.turnoverCr,
        },
      });
      upserted++;
    } catch (err) {
      failed++;
      log.warn(`index ${indexSlug} ${toBhavcopyDateToken(day)} failed:`, err);
    }
  }

  log.info(
    `indices ${toBhavcopyDateToken(day)}: fetched ${indices.length}, upserted ${upserted}, failed ${failed}`,
  );
}

/**
 * Persist `series` and `isin` onto InstrumentMapping from the day's resolved
 * bhavcopy rows (MONEY-1093).
 *
 * Bounded by construction: one read for current values, one `updateMany` per
 * DISTINCT series (~14 on a real day, not one per row), and individual writes
 * only for instruments that have no ISIN yet — a set that shrinks toward zero
 * after the first few runs. The decision of what to write is the pure
 * `planMetadataBackfill`, so the interesting logic is unit-tested and this
 * function is only I/O.
 *
 * ## Return type (MONEY-1157)
 *
 * Declared `Promise<void>` while the body has always ended in
 * `return { seriesWritten, isinWritten, typeWritten }`, and those counts DO
 * reach the caller: `upsertBhavcopyRows` awaits them and `processBhavcopySync`
 * folds them into `metadataTotals`, which is persisted on the
 * MarketDataSyncLog row — the whole point of returning them. `tsc` reported
 * both halves (TS2322 at the `return` and at the assignment); `tsup`/esbuild
 * does not type-check, so the declaration was simply wrong about working code.
 * `undefined` is in the union because the `ids.length === 0` guard below
 * bare-`return`s (unreachable from the only caller, which early-returns when
 * `resolved` is empty, but kept honest rather than papered over).
 */
async function backfillInstrumentMetadata(
  resolved: Array<{ instrumentId: string; row: BhavcopyRow }>,
  index: InstrumentIndex,
  /** Historical re-seed: write ISIN only — never series, never a retype. */
  isBackfill = false,
): Promise<MetadataBackfillCounts | undefined> {
  const ids = [...new Set(resolved.map((r) => r.instrumentId))];
  if (ids.length === 0) return;

  const stored = await prisma.instrumentMapping.findMany({
    where: { id: { in: ids } },
    // `segmentCode` is SELECTED, not omitted: `ClassifyInput` requires it, and
    // an omitted segment does not abstain — it returns EQUITY for an index row.
    select: {
      id: true,
      series: true,
      isin: true,
      instrumentType: true,
      segmentCode: true,
    },
  });

  const plan = planMetadataBackfill(
    resolved.map((r) => ({
      instrumentId: r.instrumentId,
      series: r.row.series,
      isin: r.row.isin,
      // Classification inputs — both exchanges: NSE decides on the
      // two-character series, BSE on the group letter.
      symbol: r.row.symbol,
      name: r.row.name,
      exchange: r.row.exchange,
    })),
    stored,
  );

  // Chunked: `deactivateStaleInstruments` chunks at 200 for the same reason
  // (Prisma + a large `$in`), and a single failure should not lose the batch.
  const ID_CHUNK = 200;
  let seriesWritten = 0;
  let isinWritten = 0;
  let typeWritten = 0;
  if (isBackfill && plan.seriesGroups.size > 0) {
    log.info(
      `metadata backfill: skipping ${plan.seriesGroups.size} series group(s) — ` +
        `a historical file must not overwrite the CURRENT settlement series, ` +
        `which is the input to the repair script's destructive decision`,
    );
  }

  for (const [series, groupIds] of isBackfill ? [] : plan.seriesGroups) {
    for (let i = 0; i < groupIds.length; i += ID_CHUNK) {
      const res = await prisma.instrumentMapping.updateMany({
        where: { id: { in: groupIds.slice(i, i + ID_CHUNK) } },
        data: { series },
      });
      seriesWritten += res.count;
    }
  }

  // Exchange per instrument, for the index keys below.
  const exchangeById = new Map(
    resolved.map((r) => [r.instrumentId, r.row.exchange]),
  );

  // Bounded concurrency, mirroring `UPSERT_CONCURRENCY = 10` in
  // instrument-sync.ts. These are necessarily one write per row (each value is
  // unique), and the FIRST run after deploy faces every row that has no ISIN
  // yet — order 7,400 on the NSE leg. Sequentially that is 7,400 round trips
  // inside a job whose Pub/Sub ack deadline is 600s, and an overrun means
  // Pub/Sub redelivers while this run is still going.
  const WRITE_CONCURRENCY = 10;
  for (let w = 0; w < plan.isinUpdates.length; w += WRITE_CONCURRENCY) {
    const slice = plan.isinUpdates.slice(w, w + WRITE_CONCURRENCY);
    await Promise.all(slice.map((u) => writeIsin(u.id, u.isin)));
  }

  /** One guarded ISIN write, including its index publication. */
  async function writeIsin(id: string, isin: string): Promise<void> {
    // Individually, because each value is unique. Guarded on `isin: null` in
    // the WHERE as well as in the plan so a concurrent writer cannot lose a
    // race and have us overwrite an ISIN that just landed.
    const res = await prisma.instrumentMapping.updateMany({
      // `isSet: false` as well as null/"" — a legacy document that never had the
      // field is matched by none of the others under Prisma+Mongo (the
      // MONEY-1050 gotcha), and the miss is silent: the count comes back 0 and
      // the in-run index never learns the ISIN.
      where: {
        id,
        OR: [{ isin: null }, { isin: "" }, { isin: { isSet: false } }],
      },
      data: { isin },
    });

    // Publish the new key to the in-run index, exactly as
    // `mintMissingTrustInstruments` does after an insert. The index is built
    // ONCE per run but a run can cover several days, so without this an ISIN
    // written while processing day 1 is invisible to day 2's ISIN-fallback
    // resolution. Symbol matching usually covers for it — but a symbol RENAMED
    // between those days is the exact case ISIN fallback exists to catch, and
    // missing it mints a duplicate instrument.
    //
    // Only on a real write (count > 0): if the guarded WHERE matched nothing, a
    // concurrent writer won, and its value — not ours — is what is stored.
    const exchange = exchangeById.get(id);
    if (res.count > 0 && exchange) {
      index.byIsinExchange.set(isinExchangeKey(isin, exchange), id);
    }
    if (res.count > 0) isinWritten++;
  }

  if (isBackfill && plan.typeGroups.size > 0) {
    log.info(
      `metadata backfill: skipping ${plan.typeGroups.size} instrumentType ` +
        `group(s) — this is a historical re-seed, and a past file must not ` +
        `decide an instrument's CURRENT type (or clear its sector)`,
    );
  }

  for (const [instrumentType, ids] of isBackfill ? [] : plan.typeGroups) {
    let typed = 0;
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      // The `instrumentType` guard is repeated in the WHERE, not just in the
      // plan. Between the read and this write the audited repair script (or a
      // positive ETF identification from the instrument sync) may have set a
      // real value, and this must never win that race — a row is only ever
      // moved OFF the stamped default, never off a deliberate classification.
      // Clearing the sector is part of the DEBT decision, not a separate one.
      //
      // A sector on a row we have just proven is a bond ("0795GOI32" labelled
      // "Financial Services") is definitionally noise, and it is NOT harmless:
      // the holdings page joins InstrumentMapping.sector at READ time with no
      // instrumentType filter, so a user holding that bond sees it counted in
      // their sector concentration and risk numbers. Clearing it here closes
      // the loop right after the bhavcopy sync instead of waiting for someone
      // to run the repair script per environment.
      //
      // ETF is deliberately excluded: an ETF legitimately HAS a sector.
      //
      // The honest cost: this is an unattended destructive write with no
      // rollback file, so a false-positive DEBT loses its sector permanently
      // (a retyped row is excluded from re-enrichment). That population should
      // be ~0 — the classifier abstains rather than guesses and types only from
      // the exchange's own series — but it is not provably 0. Accepted
      // knowingly; `reclassify-instruments.ts` remains the audited path for the
      // existing backlog and writes a rollback snapshot.
      const res = await prisma.instrumentMapping.updateMany({
        where: { id: { in: chunk }, instrumentType: DEFAULT_INSTRUMENT_TYPE },
        data: buildTypeWriteData(instrumentType),
      });
      typed += res.count;
    }
    if (typed > 0) {
      // ACTUAL writes, not the plan size. A shortfall does NOT necessarily mean
      // a concurrent reclassification: the plan guard is lenient (it trims and
      // defaults a missing value) while this WHERE is strict exact-equality, so
      // a stored " EQUITY", a case variant, or a legacy document missing the
      // field is planned and then silently rejected here. Blaming a race would
      // misdiagnose the commonest cause.
      log.info(
        `metadata backfill: typed ${typed} rows as ${instrumentType} ` +
          `(of ${ids.length} planned; the rest no longer carried the stamped ` +
          `default — reclassified concurrently, or stored in a form the strict ` +
          `WHERE does not match)`,
      );
    }
    typeWritten += typed;
  }

  // Logged UNCONDITIONALLY, including all-zero.
  //
  // Every line here used to sit behind a `> 0` guard, so a run that wrote
  // nothing emitted nothing at all — and that silence covered both the benign
  // converged state AND every failure: an exchange format change that empties
  // `series`, a `keepSeries` change, or a stored " EQUITY"/case-variant/legacy
  // row that the lenient plan accepts and the strict WHERE then rejects.
  // Meanwhile the sync log is stamped COMPLETED with price counts only, so
  // "this backfill has been dead for three weeks" and "the universe has
  // converged" were indistinguishable in the logs AND in the database. A
  // zero-count success is this repo's stated red flag.
  const plannedSeries = [...plan.seriesGroups.values()].reduce(
    (n, g) => n + g.length,
    0,
  );
  const plannedTypes = [...plan.typeGroups.values()].reduce(
    (n, g) => n + g.length,
    0,
  );
  const wroteNothing =
    seriesWritten === 0 && isinWritten === 0 && typeWritten === 0;
  const plannedNothing =
    plannedSeries === 0 && plan.isinUpdates.length === 0 && plannedTypes === 0;

  log.info(
    `metadata backfilled: ${seriesWritten} series, ${isinWritten} ISINs, ` +
      `${typeWritten} instrumentType (planned: ` +
      `${plannedSeries}/${plan.isinUpdates.length}/${plannedTypes})` +
      (wroteNothing && plannedNothing
        ? " — nothing to do; the universe has converged"
        : wroteNothing
          ? " — PLANNED WRITES WERE ALL REJECTED: every row moved off the " +
            "stamped default between plan and write, or is stored in a form " +
            "the strict WHERE does not match"
          : ""),
  );

  return { seriesWritten, isinWritten, typeWritten };
}
