/**
 * Writing Databento bars into the candle store, one SESSION at a time —
 * MONEY-1373.
 *
 * All I/O is injected, so this module's test needs neither Prisma nor GCS and
 * the orchestration — which is where the interesting mistakes live — is
 * exercised directly. `candle-sink.ts` uses the same arrangement and says why:
 * the pure rule already has its own tests, and what was untestable was
 * everything around it.
 *
 * ## The unit of work is a SESSION, not a bar and not a batch
 *
 * Because the rule it enforces is stated per session: one `(symbol, timeframe,
 * ET session date)` holds bars from exactly ONE source. So bars are grouped,
 * a verdict is taken per group, and the group is written or refused whole.
 *
 * ## Displacement is delete-then-write, and it needs no transaction
 *
 * `putCandles` is diff-then-create in chunks and cannot join a Prisma
 * transaction, so there is no atomic swap available. There does not need to be:
 * after the delete, the session is EMPTY, and the only writer holding a lock on
 * it is this one. A crash between the two steps leaves a session with fewer
 * bars than it should have — a gap, healed by the next idempotent run — and
 * never a session holding two sources. The inverse order would leave exactly
 * that. This is the same argument `CandleRepository.hotLoad` makes for its own
 * three-step order: choose the sequence whose every PREFIX is a state a later
 * run repairs.
 *
 * ## Sources are read across ALL exchanges, deliberately
 *
 * The realtime sink stamps `exchange` from the first ACTIVE listing it finds
 * (`candle-sink.ts`), and this loader stamps it from the symbology resolution.
 * For a dual-venue symbol those can differ. `Candle`'s unique key includes
 * `exchange`, so a session could hold a TIINGO_RT row under BATS and a
 * DATABENTO row under NASDAQ — two sources, one session, and an
 * exchange-scoped query would see neither problem. So both the read and the
 * delete are scoped by `(symbol, timeframe, ts-range)` only, which is exactly
 * what `candle-sink.ts:91-104` already does.
 */

import type { CandleBar, CandleWriteRow } from "../candles/candle-logic";
import type { ColdShardOutcome } from "../candles/candle-cold-store";
import { candleKey, resolveCandleDestination } from "../candles/candle-logic";
import { usMarketDateKey, usMarketDayBoundsUtc } from "../us-market-hours";
import { decideSessionWrite } from "./databento-day-authority";
import { DATABENTO_SOURCE } from "./databento-logic";

/* ─────────────────────────────────────────────────────────────────────────
   Seams
   ──────────────────────────────────────────────────────────────────────── */

export interface SessionWriterDeps {
  /** DISTINCT `source` values already in the session, across every exchange. */
  findExistingSources(args: {
    symbol: string;
    timeframe: string;
    startMs: number;
    endMs: number;
  }): Promise<string[]>;
  /** Remove the named sources' rows from the session. Returns rows removed. */
  deleteSessionRows(args: {
    symbol: string;
    timeframe: string;
    startMs: number;
    endMs: number;
    sources: readonly string[];
  }): Promise<number>;
  putCandles(rows: readonly CandleWriteRow[]): Promise<{
    created: number;
    upgraded: number;
    failed: number;
  }>;
  /**
   * Mirror M1 bars into the intraday ring buffer. MONEY-1470 (A5). OPTIONAL.
   *
   * A SEAM rather than a direct import, like every other write in this module:
   * the whole file is built so a test can observe what was written without a
   * Redis. Optional so the existing callers and their tests are unchanged —
   * absent means no mirroring, which is a slower chart and never a wrong bar.
   */
  appendIntradayBuffer?(args: {
    listingId: string;
    bars: readonly {
      tsSeconds: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }[];
  }): Promise<boolean>;
  readColdShard(args: {
    market: string;
    timeframe: string;
    symbol: string;
    year: number;
  }): Promise<ColdShardOutcome>;
  writeColdShard(args: {
    market: string;
    timeframe: string;
    symbol: string;
    year: number;
    bars: readonly CandleBar[];
    merge: false;
  }): Promise<unknown>;
  now(): Date;
}

export interface SessionWriteCounters {
  sessionsSeen: number;
  sessionsWritten: number;
  rowsWritten: number;
  sessionsDisplaced: number;
  rowsDeleted: number;
  sessionsRefused: number;
  /** MUST stay 0. A non-zero value means a writer reached the daily series. */
  refusedD1: number;
  sessionsSameSource: number;
  coldShardsWritten: number;
  coldRowsDisplaced: number;
  /** M1 rows mirrored into the intraday ring buffer. MONEY-1470. */
  rowsBuffered: number;
  failed: number;
}

export function emptySessionWriteCounters(): SessionWriteCounters {
  return {
    sessionsSeen: 0,
    sessionsWritten: 0,
    rowsWritten: 0,
    sessionsDisplaced: 0,
    rowsDeleted: 0,
    sessionsRefused: 0,
    refusedD1: 0,
    sessionsSameSource: 0,
    coldShardsWritten: 0,
    coldRowsDisplaced: 0,
    rowsBuffered: 0,
    failed: 0,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Grouping
   ──────────────────────────────────────────────────────────────────────── */

interface SessionGroup {
  symbol: string;
  timeframe: string;
  dateKey: string;
  startMs: number;
  endMs: number;
  rows: CandleWriteRow[];
}

/**
 * Split a symbol's rows into ET sessions.
 *
 * `usMarketDateKey` and not a UTC slice, and that is the whole point of the
 * MONEY-1373 key change: in EST the post-market runs to 20:00 ET, which is the
 * NEXT UTC day — and also the UTC day of the following session's pre-market. A
 * UTC key therefore spans the tail of one session and the head of the next, and
 * whichever writer lands there first locks the other out of both.
 */
export function groupRowsBySession(
  rows: readonly CandleWriteRow[],
): SessionGroup[] {
  const out = new Map<string, SessionGroup>();
  for (const row of rows) {
    const dateKey = usMarketDateKey(row.ts);
    const key = `${row.symbol}\u0000${row.timeframe}\u0000${dateKey}`;
    const existing = out.get(key);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    const bounds = usMarketDayBoundsUtc(dateKey);
    out.set(key, {
      symbol: row.symbol,
      timeframe: row.timeframe,
      dateKey,
      startMs: bounds.startMs,
      endMs: bounds.endMs,
      rows: [row],
    });
  }
  return [...out.values()];
}

/* ─────────────────────────────────────────────────────────────────────────
   The write
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Write one symbol's bars, session by session.
 *
 * `rows` may span sessions and years but must be ONE symbol and ONE timeframe —
 * that is what lets the cold path group by shard year without re-sorting, and
 * it is how the loader hands work over anyway.
 *
 * Never throws for a single session: a failure is counted and the remaining
 * sessions are attempted, because one unreadable shard should not cost a
 * symbol-year of bars we have already paid for.
 */
export async function writeSymbolBatch(
  rows: readonly CandleWriteRow[],
  deps: SessionWriterDeps,
  counters: SessionWriteCounters,
  options: { market?: string } = {},
): Promise<void> {
  if (rows.length === 0) return;
  const market = options.market ?? "US";
  const now = deps.now();

  const groups = groupRowsBySession(rows);
  const hot: SessionGroup[] = [];
  const cold: SessionGroup[] = [];
  for (const g of groups) {
    counters.sessionsSeen++;
    const destination = resolveCandleDestination({
      barYear: new Date(g.startMs).getUTCFullYear(),
      timeframe: g.timeframe,
      tsMs: g.startMs,
      now,
    });
    if (destination === "COLD") cold.push(g);
    else hot.push(g);
  }

  for (const group of hot) {
    try {
      await writeHotSession(group, deps, counters);
    } catch (err) {
      counters.failed += group.rows.length;
      console.warn(
        `[databento] hot session write failed for ${group.symbol} ` +
          `${group.timeframe} ${group.dateKey}: ${errText(err)}`,
      );
    }
  }

  if (cold.length > 0) {
    await writeColdSessions(cold, market, deps, counters);
  }
}

async function writeHotSession(
  group: SessionGroup,
  deps: SessionWriterDeps,
  counters: SessionWriteCounters,
): Promise<void> {
  const existing = await deps.findExistingSources({
    symbol: group.symbol,
    timeframe: group.timeframe,
    startMs: group.startMs,
    endMs: group.endMs,
  });

  const verdict = decideSessionWrite({
    incomingSource: DATABENTO_SOURCE,
    existingSources: existing,
    timeframe: group.timeframe,
  });

  if (verdict.action === "refuse") {
    counters.sessionsRefused++;
    if (verdict.d1) counters.refusedD1++;
    console.warn(
      `[databento] REFUSED ${group.symbol} ${group.timeframe} ` +
        `${group.dateKey}: ${verdict.reason}`,
    );
    return;
  }

  if (verdict.action === "displace") {
    const deleted = await deps.deleteSessionRows({
      symbol: group.symbol,
      timeframe: group.timeframe,
      startMs: group.startMs,
      endMs: group.endMs,
      sources: verdict.deleting,
    });
    counters.sessionsDisplaced++;
    counters.rowsDeleted += deleted;
    // One line per displaced session, with both counts. This is the audit
    // trail: the append quietly replaces a session every morning, and without
    // a per-session record there is nothing to reconcile a surprising chart
    // against.
    console.log(
      `[databento] DISPLACED ${group.symbol} ${group.timeframe} ` +
        `${group.dateKey}: removed ${deleted} row(s) held by ` +
        `${verdict.deleting.join(", ")}, writing ${group.rows.length}`,
    );
  } else if (verdict.reason === "same source") {
    counters.sessionsSameSource++;
  }

  const result = await deps.putCandles(group.rows);
  // What the REPOSITORY did, never the size of what it was handed. A row can
  // still be dropped for a non-finite value or lost to a chunk failure, and
  // counting the input reports a write that did not happen (MONEY-1255).
  counters.rowsWritten += result.created + result.upgraded;
  counters.failed += result.failed;
  counters.sessionsWritten++;

  // MONEY-1470 (A5) — mirror into the intraday ring buffer.
  //
  // M1 ONLY, and the HOT path only. The buffer holds 45 sessions of the base
  // interval; a harvest's cold-path years would push every one of them out and
  // leave the chart showing 2023 — a ring buffer filled from the wrong end.
  //
  // basis `trade`: EQUS.MINI bars are trade-derived with REAL volume, which is
  // the property that makes them outrank the realtime feed's quote-derived mid.
  if (
    deps.appendIntradayBuffer &&
    group.timeframe === "M1" &&
    group.rows.length > 0
  ) {
    const listingId = group.rows[0]!.listingId;
    const ok = await deps.appendIntradayBuffer({
      listingId,
      bars: group.rows.map((r) => ({
        tsSeconds: Math.floor(r.ts.getTime() / 1000),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        // `volume` is `number | bigint` — hyparquet decodes a parquet INT64
        // column as a JS bigint (CLAUDE.md, CANDLE_COLD_FORMAT). The buffer's
        // wire format is a decimal string either way, and a US session's share
        // count is nowhere near 2^53, so the narrowing is lossless here.
        volume: typeof r.volume === "bigint" ? Number(r.volume) : r.volume,
      })),
    });
    if (ok) counters.rowsBuffered += group.rows.length;
  }
}

/**
 * The cold path: whole-shard rewrites, one PUT per symbol-year.
 *
 * A GCS write REPLACES, so the shard is read, unioned and written back in full
 * with `merge: false`. `writeColdShard`'s default merge would be wrong here in
 * a way that is easy to miss: merging would resurrect exactly the bars a
 * displacement just decided to remove.
 *
 * A session can straddle two shard years — a late-December EST session runs
 * into 1 January UTC — so bars are grouped by their own UTC year rather than by
 * the session's.
 */
async function writeColdSessions(
  groups: readonly SessionGroup[],
  market: string,
  deps: SessionWriterDeps,
  counters: SessionWriteCounters,
): Promise<void> {
  const symbol = groups[0]!.symbol;
  const timeframe = groups[0]!.timeframe;
  // Counted ONCE per session across the whole function. A session straddling
  // the UTC year boundary — 18:00 ET on 31 December is UTC Dec-31, 19:30 ET is
  // UTC Jan-1 — lands in two year buckets, and counting inside the loop made
  // `sessionsWritten` exceed `sessionsSeen`, which is an impossible
  // relationship that reached the Datadog counters.
  const writtenSessions = new Set<string>();
  const displacedSessions = new Set<string>();

  // year -> the sessions whose bars touch it
  const byYear = new Map<number, SessionGroup[]>();
  for (const g of groups) {
    for (const row of g.rows) {
      const year = row.ts.getUTCFullYear();
      const bucket = byYear.get(year);
      if (bucket) {
        if (!bucket.includes(g)) bucket.push(g);
      } else byYear.set(year, [g]);
    }
  }

  for (const [year, sessions] of byYear) {
    try {
      const outcome = await deps.readColdShard({
        market,
        timeframe,
        symbol,
        year,
      });
      if (outcome.status === "failed") {
        // NEVER treated as an empty shard. `absent` and `failed` are different
        // answers, and conflating them would rewrite a year's history from
        // whatever this batch happens to hold.
        throw outcome.error instanceof Error
          ? outcome.error
          : new Error(String(outcome.error));
      }
      const existingBars: CandleBar[] =
        outcome.status === "present" ? [...outcome.bars] : [];

      const verdicts = new Map<string, ReturnType<typeof decideSessionWrite>>();
      for (const session of sessions) {
        const sources = new Set<string>();
        for (const bar of existingBars) {
          const ms = bar.ts.getTime();
          if (ms >= session.startMs && ms < session.endMs)
            sources.add(bar.source);
        }
        const verdict = decideSessionWrite({
          incomingSource: DATABENTO_SOURCE,
          existingSources: [...sources],
          timeframe: session.timeframe,
        });
        verdicts.set(session.dateKey, verdict);
        if (verdict.action === "refuse") {
          counters.sessionsRefused++;
          if (verdict.d1) counters.refusedD1++;
        } else if (verdict.action === "displace") {
          displacedSessions.add(session.dateKey);
        } else if (verdict.reason === "same source") {
          counters.sessionsSameSource++;
        }
      }

      const incoming: CandleWriteRow[] = [];
      for (const session of sessions) {
        if (verdicts.get(session.dateKey)?.action === "refuse") continue;
        for (const row of session.rows) {
          if (row.ts.getUTCFullYear() === year) incoming.push(row);
        }
      }

      const incomingKeys = new Set(incoming.map((r) => candleKey(r)));
      const kept: CandleBar[] = [];
      for (const bar of existingBars) {
        const ms = bar.ts.getTime();
        const session = sessions.find((s) => ms >= s.startMs && ms < s.endMs);
        const verdict = session ? verdicts.get(session.dateKey) : undefined;
        if (
          verdict?.action === "displace" &&
          verdict.deleting.includes(bar.source)
        ) {
          counters.coldRowsDisplaced++;
          continue;
        }
        // An incoming bar for the same natural key wins — the same precedence
        // the hot path gets from `putCandles`.
        if (incomingKeys.has(candleKey(bar))) continue;
        kept.push(bar);
      }

      const bars: CandleBar[] = [
        ...kept,
        ...incoming.map((r) => toColdBarRow(r)),
      ];

      if (shardUnchanged(existingBars, bars)) {
        // NOTHING TO WRITE, and skipping the PUT is not just a saving.
        //
        // A GCS put REPLACES the object, and the lifecycle rule that moves this
        // prefix to Nearline measures age from CREATION — `gcs-lifecycle.json`
        // states exactly this trap. So a re-load that rewrote every shard
        // byte-for-byte would silently reset the storage-class clock on the
        // whole archive and keep it in Standard forever.
        //
        // It also makes "re-run is a no-op" true in the strong sense rather
        // than only in the no-duplicate-rows sense, which matters because the
        // harvest is resumable BY DESIGN and a repeated `--step=load` is the
        // normal recovery path.
        continue;
      }

      await deps.writeColdShard({
        market,
        timeframe,
        symbol,
        year,
        bars,
        merge: false,
      });
      counters.coldShardsWritten++;
      counters.rowsWritten += incoming.length;
      for (const s of sessions) {
        if (verdicts.get(s.dateKey)?.action !== "refuse") {
          writtenSessions.add(s.dateKey);
        }
      }

      // THE MONGO HALF OF THE DISPLACEMENT, and its absence was the whole
      // defect. This path rewrote the GCS shard and never called
      // `deleteSessionRows`, so the one-source rule held inside the shard only.
      // The weaker rows stayed in Mongo, `mergeHotAndCold` gives HOT
      // PRECEDENCE, and the read then returned the quote-derived `volume: 0`
      // bars while silently discarding the trade-derived bars we paid for.
      //
      // Worse a step later: the eviction job archives those same Mongo rows
      // with `writeColdShard`'s default `merge: true`, and `mergeColdBars`
      // gives the INCOMING bar precedence on the natural key — so the weaker
      // source would overwrite the stronger one inside the shard, with no
      // authority check anywhere on that path.
      //
      // AFTER the shard write, deliberately: the bars are durable in GCS
      // before anything is removed from Mongo, so a failure here leaves
      // duplicates (visible, recoverable) rather than a hole.
      for (const session of sessions) {
        const verdict = verdicts.get(session.dateKey);
        if (verdict?.action !== "displace" || verdict.deleting.length === 0) {
          continue;
        }
        try {
          counters.rowsDeleted += await deps.deleteSessionRows({
            symbol: session.symbol,
            timeframe: session.timeframe,
            startMs: session.startMs,
            endMs: session.endMs,
            sources: verdict.deleting,
          });
        } catch (err) {
          counters.failed += session.rows.length;
          console.warn(
            `[databento] cold displacement left Mongo rows for ` +
              `${session.symbol} ${session.timeframe} ${session.dateKey}: ` +
              `${errText(err)}. The shard is correct; the hot tier still holds ` +
              "the displaced source and will shadow it on read.",
          );
        }
      }
    } catch (err) {
      const rows = sessions.reduce((n, s) => n + s.rows.length, 0);
      counters.failed += rows;
      console.warn(
        `[databento] cold shard write failed for ${market}/${timeframe}/` +
          `${symbol}/${year} (${rows} row(s)): ${errText(err)}`,
      );
    }
  }

  counters.sessionsWritten += writtenSessions.size;
  counters.sessionsDisplaced += displacedSessions.size;
}

/**
 * Would writing `next` change anything already in the shard?
 *
 * Compared by the natural key plus every value a reader can see. Not by
 * serialising both sides: `serializeColdShard` sorts and re-encodes, so a
 * string comparison would be sensitive to field ORDER and to float formatting,
 * and would report a difference where there is none.
 */
function shardUnchanged(
  existing: readonly CandleBar[],
  next: readonly CandleBar[],
): boolean {
  if (existing.length !== next.length) return false;
  const byKey = new Map(existing.map((b) => [candleKey(b), b]));
  for (const bar of next) {
    const prior = byKey.get(candleKey(bar));
    if (prior === undefined) return false;
    if (
      prior.open !== bar.open ||
      prior.high !== bar.high ||
      prior.low !== bar.low ||
      prior.close !== bar.close ||
      prior.volume !== bar.volume ||
      prior.source !== bar.source ||
      prior.listingId !== bar.listingId ||
      prior.divCash !== bar.divCash ||
      prior.splitFactor !== bar.splitFactor
    ) {
      return false;
    }
  }
  return true;
}

/** A write row as the cold shard's bar shape. */
function toColdBarRow(row: CandleWriteRow): CandleBar {
  return {
    symbol: row.symbol,
    exchange: row.exchange,
    timeframe: row.timeframe,
    ts: row.ts,
    listingId: row.listingId,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: typeof row.volume === "bigint" ? Number(row.volume) : row.volume,
    divCash: row.divCash ?? 0,
    splitFactor: row.splitFactor ?? 1,
    source: row.source ?? DATABENTO_SOURCE,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
