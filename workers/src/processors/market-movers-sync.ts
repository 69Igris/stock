/**
 * Exchange-published top movers + live index snapshot — MONEY-1198.
 *
 * ## What this job is
 *
 * The ingestion half of "Top movers — today". Discover's panel ranked
 * `latest_quotes` with NO freshness predicate and nothing bulk-refreshes that
 * table intraday (price-sync runs 23:00 IST), so it showed LAPL at ₹128.29
 * +36.48% while the stock's own page showed ₹121.88 −5.00% with PREV CLOSE
 * ₹128.29. The panel was ranking the PREVIOUS session and labelling it "today".
 *
 * NSE publishes its own ranked lists. This job fetches them, parses them with
 * the pure `parseNseMovers` / `parseNseAllIndices`, and upserts `MarketMover` +
 * `IndexLiveSnapshot`. Derivables (the Discover panel, the market-overview
 * strip, breadth) read those tables; none of them belong here.
 *
 * ## UNBACKFILLABLE — the schedule is the risk, not the parser
 *
 * `/api/live-analysis-variations` and `/api/allIndices` take NO date parameter.
 * They serve the CURRENT snapshot and nothing else: there is no window to walk,
 * no `from_date`/`to_date`, no archive page to re-scrape. A poll we do not make
 * is a snapshot that never enters the record. Same property that makes
 * `surveillance-sync` (MONEY-1189 P4.5) and `institutional-flow-sync`
 * (MONEY-1108 P8d) daily and prod-only, and it is why the SCHEDULE — not this
 * file — is the part of the feature carrying the risk.
 *
 * It is also why the raw bytes are archived. `fetchNseApiJson` files every
 * market-wide response under `feeds/NSE/api/{movers,index-live}/` via the
 * `FAMILY_BY_PREFIX` rows added by this same ticket — a hard prerequisite,
 * because without the row `archiveNseJsonResponse` files nothing while
 * reporting success.
 *
 * ## Poll safety: whole-market only, never a fan-out
 *
 * ONE request returns every bucket NSE publishes (~35 KB); a second returns all
 * 139 indices. Three requests per poll, total. Blacklisting risk in this
 * codebase has scaled with PER-SYMBOL FAN-OUT every time it has bitten — the
 * Screener 429 wall, MCX's 403, NCDEX's JS challenge were all per-symbol walks
 * — and there is no fan-out anywhere in this job. For scale: `alert-evaluator`
 * runs EVERY MINUTE and `sparkline-sync` walks ~500 symbols every 30 minutes,
 * so this is an order of magnitude cheaper than what already runs.
 *
 * Three further brakes, in order of how often they fire:
 *
 *   1. SESSION + SETTLE WINDOW ONLY. `shouldPollMovers` re-checks at runtime, so
 *      a holiday — which cron cannot know about — costs zero requests, as do
 *      weekends and pre-open.
 *
 *      This used to read "MARKET HOURS ONLY … outside the session the data
 *      cannot change, so a poll is pure risk for no information." The second
 *      half was FALSE and is corrected in MONEY-1200: probed at 16:26 IST on
 *      2026-08-14, the gainers payload carried `timestamp "14-Aug-2026
 *      16:00:00"` — thirty minutes past the close — with real closing prices.
 *      NSE settles this endpoint after the bell, and the CLOSING snapshot is
 *      the most valuable one we can hold: "today's top gainers" for anyone
 *      reading after 15:30 — most users, every evening, all weekend — IS the
 *      close. Refusing to capture it re-created, one layer along, the same
 *      staleness this whole job exists to remove.
 *   2. NO-CHANGE SKIP. The payload's own `timestamp` is the change detector
 *      (there is nothing else: verified 2026-08-14, these responses carry no
 *      ETag, no Last-Modified and no Cache-Control, so a conditional request
 *      cannot be made and a 304 is not available to us). If it has not
 *      advanced, NOTHING is written — rewriting identical rows would refresh
 *      `updatedAt` and hand readers a row that looks freshly confirmed while
 *      describing an older session.
 *   3. CIRCUIT BREAK. A refusal from NSE stops the run immediately rather than
 *      continuing to the next endpoint. `fetchNseApiJson` collapses 401/403/429,
 *      HTML challenge pages and transport errors alike to `null`, so a null IS
 *      the refusal signal available at this layer — and the correct response to
 *      a host that just refused us is to stop, not to try the next URL.
 *
 * ## WebSocket is not an option and should not be chased
 *
 * NSE publishes no public WebSocket. The only WS available to us is Zerodha
 * Kite's, which needs the PAID "Connect" app — founder-only and deliberately
 * dormant (MONEY-837), with no live quotes on the free Personal app. So it is
 * not a route for general users. Closed; do not design toward it.
 *
 * ## Idempotency
 *
 * Both tables carry a unique keyed on the SESSION DAY, not on `snapshotAt`, so
 * an intraday poll UPDATES the day's row rather than appending one row per
 * poll. `MarketMover`'s key includes `bucket` — without it the same symbol in
 * NIFTY and FOSec collides and one silently overwrites the other (35 of 85
 * symbols spanned buckets on the live 2026-08-14 response). That is the
 * MarketPositioning `metric` lesson, and it is not re-learnable cheaply.
 *
 * After each write the run PRUNES rows left behind by an earlier snapshot of
 * the same day — a symbol that drops off NSE's list must disappear from ours,
 * or the panel shows a mover the exchange no longer lists. That prune is also
 * what makes a stale row unreadable even by a consumer that forgets the
 * freshness predicate, which is exactly what went wrong to begin with.
 */

import prisma from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { fetchNseApiJson } from "@usemoney/research/data-sources/nse-filings";
import {
  parseNseMovers,
  parseNseAllIndices,
  nseMoversPath,
  shouldWriteSnapshot,
  getNseMarketStatus,
  shouldPollMovers,
  NSE_ALL_INDICES_PATH,
  type MarketMoverRow,
  type IndexSnapshotRow,
  type MoverDirection,
} from "@usemoney/core/market-data";
import {
  buildInstrumentIndex,
  resolveInstrumentId,
  type InstrumentIndex,
} from "./bhavcopy-sync-logic";

const logger = {
  info: (data: unknown, msg: string) =>
    console.log(`[market-movers-sync] ${msg}`, data),
  warn: (data: unknown, msg: string) =>
    console.warn(`[market-movers-sync] ${msg}`, data),
  error: (data: unknown, msg: string) =>
    console.error(`[market-movers-sync] ${msg}`, data),
};

export interface MarketMoversSyncResult {
  ok: boolean;
  /** True when the run stopped early because the market is closed. */
  skippedClosed: boolean;
  /** True when NSE refused us and the run circuit-broke. */
  circuitBroken: boolean;
  movers: Array<{
    direction: MoverDirection;
    fetched: boolean;
    parsed: number;
    skipped: number;
    written: number;
    pruned: number;
    resolved: number;
    /** Set when the snapshot had not advanced — a no-change poll. */
    noChange: boolean;
    snapshotAt: string | null;
    rejected: string | null;
  }>;
  indices: {
    fetched: boolean;
    parsed: number;
    skipped: number;
    written: number;
    noChange: boolean;
    snapshotAt: string | null;
    rejected: string | null;
  };
}

/** The freshest snapshot already stored for a direction on a session day. */
async function lastStoredMoverSnapshot(
  direction: MoverDirection,
  date: Date,
): Promise<Date | null> {
  const row = await prisma.marketMover.findFirst({
    where: { exchange: "NSE", direction, date },
    orderBy: { snapshotAt: "desc" },
    select: { snapshotAt: true },
  });
  return row?.snapshotAt ?? null;
}

async function writeMovers(
  rows: readonly MarketMoverRow[],
  index: InstrumentIndex,
  isinById: ReadonlyMap<string, string | null>,
): Promise<{ written: number; resolved: number; pruned: number }> {
  let written = 0;
  let resolved = 0;

  for (const row of rows) {
    // SYMBOL@EXCHANGE resolution, not ISIN-first.
    //
    // The comment here used to claim "ISIN-first", which was wrong twice over
    // (MONEY-1198): `resolveInstrumentId` checks symbol@exchange FIRST and
    // falls back to ISIN, and in any case the movers payload carries no isin
    // of its own — its fourteen fields were checked against the live response —
    // so the `isin: null` passed below makes that fallback unreachable from
    // here. The mapping is still the authority, because a symbol can be
    // reassigned to a different company after a rename (MONEY-1177).
    const instrumentId =
      resolveInstrumentId(
        { symbol: row.symbol, exchange: row.exchange, isin: null },
        index,
      ) ?? null;
    if (instrumentId !== null) resolved++;

    const payload = {
      snapshotAt: row.snapshotAt,
      instrumentId,
      // Denormalised at write time, as the schema says. It was DECLARED and
      // never written, so every row carried null while three separate comments
      // described an ISIN-durability design the code did not implement. Written
      // from the resolved instrument, so it is null exactly when the join
      // failed or the instrument genuinely has no ISIN — both of which are
      // real, readable states.
      isin: instrumentId !== null ? (isinById.get(instrumentId) ?? null) : null,
      series: row.series,
      rank: row.rank,
      open: row.open,
      high: row.high,
      low: row.low,
      ltp: row.ltp,
      prevClose: row.prevClose,
      percentChange: row.percentChange,
      adjPercentChange: row.adjPercentChange,
      rupeeChange: row.rupeeChange,
      tradedQty: row.tradedQty,
      turnover: row.turnover,
      caExDate: row.caExDate,
      caPurpose: row.caPurpose,
      source: row.source,
    };

    await prisma.marketMover.upsert({
      where: {
        exchange_direction_bucket_symbol_date: {
          exchange: row.exchange,
          direction: row.direction,
          bucket: row.bucket,
          symbol: row.symbol,
          date: row.date,
        },
      },
      create: {
        exchange: row.exchange,
        direction: row.direction,
        bucket: row.bucket,
        symbol: row.symbol,
        date: row.date,
        ...payload,
      },
      update: payload,
    });
    written++;
  }

  // Prune what this snapshot no longer lists. A symbol that fell off NSE's
  // gainers list must leave ours too — otherwise the panel keeps showing a
  // mover the exchange has stopped ranking, which is a smaller version of the
  // staleness this ticket exists to fix. Scoped to the (exchange, direction,
  // date) sets present in THIS payload, so nothing another run wrote is
  // touched.
  //
  // The threshold is the MINIMUM snapshotAt across the rows just written for
  // that scope, NOT the maximum. NSE stamps each bucket separately, and while
  // the seven normally agree to the second they are not guaranteed to: pruning
  // at the max would delete rows this very call had just written from a bucket
  // carrying a marginally earlier timestamp. Deleting our own fresh write is
  // strictly worse than briefly keeping one stale row, so the bound is the
  // conservative one.
  let pruned = 0;
  const scopes = new Map<
    string,
    { exchange: string; direction: string; date: Date; minSnapshotAt: Date }
  >();
  for (const row of rows) {
    const key = `${row.exchange}|${row.direction}|${row.date.getTime()}`;
    const held = scopes.get(key);
    if (held === undefined) {
      scopes.set(key, {
        exchange: row.exchange,
        direction: row.direction,
        date: row.date,
        minSnapshotAt: row.snapshotAt,
      });
    } else if (row.snapshotAt < held.minSnapshotAt) {
      held.minSnapshotAt = row.snapshotAt;
    }
  }
  for (const scope of scopes.values()) {
    const res = await prisma.marketMover.deleteMany({
      where: {
        exchange: scope.exchange,
        direction: scope.direction,
        date: scope.date,
        snapshotAt: { lt: scope.minSnapshotAt },
      },
    });
    pruned += res.count;
  }

  return { written, resolved, pruned };
}

async function writeIndexSnapshot(
  rows: readonly IndexSnapshotRow[],
): Promise<number> {
  let written = 0;
  for (const row of rows) {
    const payload = {
      snapshotAt: row.snapshotAt,
      indexName: row.indexName,
      category: row.category,
      last: row.last,
      open: row.open,
      high: row.high,
      low: row.low,
      previousClose: row.previousClose,
      pointsChange: row.pointsChange,
      percentChange: row.percentChange,
      yearHigh: row.yearHigh,
      yearLow: row.yearLow,
      pe: row.pe,
      pb: row.pb,
      dividendYield: row.dividendYield,
      // Breadth arrives as a float from the shared number parser but is a
      // count; Math.round rather than a cast so a malformed "14.0" cannot
      // truncate to something else silently.
      advances: row.advances === null ? null : Math.round(row.advances),
      declines: row.declines === null ? null : Math.round(row.declines),
      unchanged: row.unchanged === null ? null : Math.round(row.unchanged),
      source: row.source,
    };
    await prisma.indexLiveSnapshot.upsert({
      where: {
        indexSymbol_date: { indexSymbol: row.indexSymbol, date: row.date },
      },
      create: { indexSymbol: row.indexSymbol, date: row.date, ...payload },
      update: payload,
    });
    written++;
  }
  return written;
}

/**
 * The run's OWED-WORK pair — MONEY-1250.
 *
 * `selected` is NOT rows parsed. `shouldWriteSnapshot` gates each leg on the
 * payload timestamp strictly advancing, and this job polls every three minutes
 * against an exchange that refreshes far more slowly, so a poll that parses 20 gainers and
 * writes none because the snapshot has not moved is the MAJORITY outcome and is
 * entirely healthy. Pairing `parsed` with `written` would report
 * `selected 40, written 0` on most of the ~160 weekday polls — an alert that
 * fires all day, gets muted, and takes the real one with it.
 *
 * A leg contributes to `selected` only when the snapshot DID advance, and then
 * every parsed row is owed an upsert (`writeMovers` has no change detection: it
 * upserts each row and increments `written` unconditionally). So
 * `selected > 0 && written === 0` means the exchange published something new
 * and none of it reached the table.
 *
 * The one exception is a leg that fetched a 200 and parsed ZERO usable rows.
 * That is a total parse failure, not a quiet market — the rows NSE sent and we
 * refused ARE the work it owed — and it is counted, following the precedent in
 * `circulars-sync.ts`, which counts a total rejection and ignores a partial one.
 *
 * KNOWN GAP: a circuit break (`fetchNseApiJson` returning null on a 403 / 429 /
 * challenge page) contributes 0. Its unit is REQUESTS and this metric's unit is
 * ROWS, and reporting one as the other is the wrong-granularity defect the pair
 * exists to avoid. It is carried by `ok: false`, by `circuitBroken`, and by the
 * ERROR line at the break itself.
 */
function owedWork(result: MarketMoversSyncResult): {
  selected: number;
  written: number;
  failed: number;
} {
  let selected = 0;
  let written = 0;
  let failed = 0;
  for (const leg of [...result.movers, result.indices]) {
    written += leg.written;
    if (leg.noChange) continue;
    if (leg.parsed > 0) {
      selected += leg.parsed;
      failed += leg.parsed - leg.written;
      continue;
    }
    if (leg.fetched) {
      selected += leg.skipped;
      failed += leg.skipped;
    }
  }
  return { selected, written, failed };
}

/** Emit the outcome for a finished run. Called at every exit. */
function reportMoversOutcome(
  result: MarketMoversSyncResult,
  reason: string,
): void {
  const { selected, written, failed } = owedWork(result);
  reportJobOutcome({
    job: "market-movers-sync",
    selected,
    written,
    failed,
    // THE 403 IS NO LONGER SILENT — MONEY-1250 review.
    //
    // Excluding a circuit break from `selected`/`failed` was right on units — a
    // break is CALLS, not ROWS — but the consequence was that an NSE block
    // emitted `selected 0, written 0, failed 0`, byte-identical to a healthy
    // no-change poll. The exact silent-block shape this module exists for was
    // the one thing it could not express. It now has a counter of its own, so
    // the row counters stay pure AND the block is loud.
    transportFailures: result.circuitBroken ? 1 : 0,
    skippedReason:
      `${reason}; ok=${result.ok} advancedRows=${selected} written=${written} ` +
      `legs=[${[...result.movers.map((m) => m.direction), "INDICES"].join(",")}]`,
  });
}

export async function processMarketMoversSync(): Promise<MarketMoversSyncResult> {
  const result: MarketMoversSyncResult = {
    ok: true,
    skippedClosed: false,
    circuitBroken: false,
    movers: [],
    indices: {
      fetched: false,
      parsed: 0,
      skipped: 0,
      written: 0,
      noChange: false,
      snapshotAt: null,
      rejected: null,
    },
  };

  // Runtime gate on top of the cron window. Cloud Scheduler cannot know about
  // NSE's holiday calendar, so without this the job would poll a closed market
  // ~125 times on every exchange holiday — pure blacklist risk for data that
  // cannot have changed.
  // MONEY-1200 — the gate is `shouldPollMovers`, NOT `status.isLive`.
  //
  // Gating on `isLive` alone threw away the CLOSING snapshot: NSE keeps
  // settling the movers endpoint past 15:30 (measured 16:00 on 2026-08-14),
  // and the close is the most valuable snapshot we can hold, because "today's
  // top gainers" for anyone reading after the session IS the close. WEEKEND,
  // HOLIDAY and PRE_OPEN still make zero requests — those genuinely have no
  // session behind them to settle from.
  const status = getNseMarketStatus();
  const decision = shouldPollMovers(status);
  if (!decision.poll) {
    logger.info(
      { phase: status.phase, reason: status.reason, gate: decision.reason },
      "not polling — no session data can be settling right now",
    );
    result.skippedClosed = true;
    reportMoversOutcome(
      result,
      `not polling: ${status.phase} (${decision.reason})`,
    );
    return result;
  }

  const instruments = await prisma.instrumentMapping.findMany({
    select: { id: true, symbol: true, exchange: true, isin: true },
  });
  const index = buildInstrumentIndex(instruments);
  // id -> isin, so a resolved mover can denormalise the durable identity the
  // schema promises. buildInstrumentIndex keys the other way (symbol/isin -> id).
  const isinById = new Map(instruments.map((i) => [i.id, i.isin ?? null]));

  for (const direction of ["GAINERS", "LOSERS"] as const) {
    const path = nseMoversPath(direction);
    const payload = await fetchNseApiJson(path);

    if (payload === null) {
      // CIRCUIT BREAK. fetchNseApiJson maps a 401/403/429, an HTML challenge
      // page and a transport error alike to null, so this is the refusal
      // signal available here — and the right answer to a host that just
      // refused us is to STOP, not to fire the next two requests at it.
      logger.error(
        { path, direction },
        "fetch returned null — CIRCUIT BREAKING, no further requests this run",
      );
      result.movers.push({
        direction,
        fetched: false,
        parsed: 0,
        skipped: 0,
        written: 0,
        pruned: 0,
        resolved: 0,
        noChange: false,
        snapshotAt: null,
        rejected: null,
      });
      result.ok = false;
      result.circuitBroken = true;
      reportMoversOutcome(
        result,
        `CIRCUIT BREAK on the ${direction} fetch — NSE refused us`,
      );
      return result;
    }

    const out = parseNseMovers(payload, direction);

    if (out.rejected !== null) {
      // A structurally wrong payload — the misspelled-parameter error body, a
      // shape change. NEVER let this read as "nothing moved today": an empty
      // movers list is a claim about the market that a bad fetch has no
      // business making.
      logger.error(
        { path, direction, rejected: out.rejected },
        "payload REJECTED — not writing; check the endpoint",
      );
      result.movers.push({
        direction,
        fetched: true,
        parsed: 0,
        skipped: out.skipped,
        written: 0,
        pruned: 0,
        resolved: 0,
        noChange: false,
        snapshotAt: null,
        rejected: out.rejected,
      });
      result.ok = false;
      continue;
    }

    if (out.rows.length === 0) {
      logger.error(
        { path, direction, skipped: out.skipped },
        "parsed to ZERO rows from a 200 — not writing",
      );
      result.movers.push({
        direction,
        fetched: true,
        parsed: 0,
        skipped: out.skipped,
        written: 0,
        pruned: 0,
        resolved: 0,
        noChange: false,
        snapshotAt: null,
        rejected: null,
      });
      result.ok = false;
      continue;
    }

    // Every bucket in one payload shares a session day; take it from the rows
    // rather than from a clock.
    const snapshotAt = out.rows.reduce(
      (max, r) => (r.snapshotAt > max ? r.snapshotAt : max),
      out.rows[0]!.snapshotAt,
    );
    const day = out.rows[0]!.date;
    const lastStored = await lastStoredMoverSnapshot(direction, day);

    if (!shouldWriteSnapshot(snapshotAt, lastStored)) {
      // The exchange has not published anything new since our last poll. Not
      // an error — it is the expected outcome of polling faster than NSE
      // refreshes, and it is what makes a tight cadence cheap.
      logger.info(
        {
          direction,
          snapshotAt: snapshotAt.toISOString(),
          lastStored: lastStored?.toISOString() ?? null,
        },
        "snapshot has not advanced — NO-CHANGE, skipping the write",
      );
      result.movers.push({
        direction,
        fetched: true,
        parsed: out.rows.length,
        skipped: out.skipped,
        written: 0,
        pruned: 0,
        resolved: 0,
        noChange: true,
        snapshotAt: snapshotAt.toISOString(),
        rejected: null,
      });
      continue;
    }

    const { written, resolved, pruned } = await writeMovers(
      out.rows,
      index,
      isinById,
    );
    result.movers.push({
      direction,
      fetched: true,
      parsed: out.rows.length,
      skipped: out.skipped,
      written,
      pruned,
      resolved,
      noChange: false,
      snapshotAt: snapshotAt.toISOString(),
      rejected: null,
    });
  }

  // ── Live index snapshot ────────────────────────────────────────────
  const idxPayload = await fetchNseApiJson(NSE_ALL_INDICES_PATH);
  if (idxPayload === null) {
    logger.error(
      { path: NSE_ALL_INDICES_PATH },
      "index fetch returned null — CIRCUIT BREAKING",
    );
    result.ok = false;
    result.circuitBroken = true;
    reportMoversOutcome(
      result,
      "CIRCUIT BREAK on the allIndices fetch — NSE refused us",
    );
    return result;
  }

  const idx = parseNseAllIndices(idxPayload);
  result.indices.fetched = true;
  result.indices.rejected = idx.rejected;
  result.indices.skipped = idx.skipped;
  result.indices.parsed = idx.rows.length;

  if (
    idx.rejected !== null ||
    idx.rows.length === 0 ||
    idx.snapshotAt === null
  ) {
    logger.error(
      { rejected: idx.rejected, skipped: idx.skipped },
      "index snapshot unusable — not writing",
    );
    result.ok = false;
  } else {
    result.indices.snapshotAt = idx.snapshotAt.toISOString();
    const day = idx.rows[0]!.date;
    const lastStored = await prisma.indexLiveSnapshot
      .findFirst({
        where: { date: day },
        orderBy: { snapshotAt: "desc" },
        select: { snapshotAt: true },
      })
      .then((r) => r?.snapshotAt ?? null);

    if (!shouldWriteSnapshot(idx.snapshotAt, lastStored)) {
      logger.info(
        { snapshotAt: idx.snapshotAt.toISOString() },
        "index snapshot has not advanced — NO-CHANGE, skipping the write",
      );
      result.indices.noChange = true;
    } else {
      result.indices.written = await writeIndexSnapshot(idx.rows);
    }
  }

  logger.info(result, "done");
  reportMoversOutcome(result, "done");
  return result;
}
