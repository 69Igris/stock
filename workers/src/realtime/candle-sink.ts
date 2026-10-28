/**
 * The M1 candle write — the other half of the flush that was missing.
 *
 * `flushTick` used to call `aggregator.closeDue(now)` and then throw the result
 * away with `counters.barsWritten += 0` and a comment saying the write was "not
 * implemented here yet". That is strictly WORSE than not closing at all:
 * `closeDue` marks those minutes flushed inside the aggregator, permanently, so
 * the bars cannot be recovered by a later pass. Every minute of every session
 * was being computed, retired, and dropped.
 *
 * ## Two things a bar needs that a bar does not carry
 *
 * `Candle` is keyed on a LISTING, not a ticker, because a ticker is not a
 * security: Tiingo's master holds two rows for `DOW` on NYSE — Dow Chemical to
 * 2017 and Dow Inc. from 2019 — and concatenating them would be one series
 * describing two companies. So every row needs `listingId` and `exchange`, and
 * the tick stream carries neither. They are resolved from `UsInstrument` and
 * cached, because the alternative is a database lookup on the flush path.
 *
 * A symbol with no ACTIVE listing is REFUSED rather than guessed. A wrong
 * `listingId` does not fail — it silently files a bar under another company.
 *
 * ## The mixed-source rule is enforced HERE, not by the repository
 *
 * `putCandles`' upgrade path `$set`s `source` unconditionally, so the
 * repository will happily let a realtime bar overwrite an EOD one. That is the
 * right behaviour for a repository whose job is "write what you are given" —
 * which means the day-level rule has to be applied before the call, by the
 * writer that knows it is a second source. `mayWriteIntoDay` is that rule and
 * this module is its only caller.
 */

import { prisma } from "@usemoney/database";
import { candleRepository } from "@usemoney/core/market-data/candles/candle-repository";
import {
  usMarketDateKey,
  usMarketDayBoundsUtc,
} from "@usemoney/core/market-data/us-market-hours";
import type { MinuteBar } from "@usemoney/core/market-data/tiingo/tiingo-minute-bars";
import {
  toCandleRow,
  groupBySymbolDay,
  mayWriteIntoDay,
  RT_CANDLE_SOURCE,
  type RtCandleRow,
} from "@usemoney/core/market-data/tiingo/tiingo-rt-sink-logic";
// MONEY-1470 (A5) — the intraday ring buffer the chart reads.
import { appendBars } from "@usemoney/core/market-data/intraday/intraday-store";
import type { BasisBar } from "@usemoney/core/market-data/intraday/rollup-logic";

export interface CandleSinkCounters {
  written: number;
  refusedNoListing: number;
  refusedMixedSource: number;
  listingsResolved: number;
  writeFailures: number;
  /** Bars pushed into the intraday ring buffer. MONEY-1470. */
  buffered: number;
}

export function emptyCandleSinkCounters(): CandleSinkCounters {
  return {
    written: 0,
    buffered: 0,
    refusedNoListing: 0,
    refusedMixedSource: 0,
    listingsResolved: 0,
    writeFailures: 0,
  };
}

interface Listing {
  listingId: string;
  exchange: string;
}

/**
 * `symbol` + `timeframe` + the ET SESSION DATE (`YYYY-MM-DD`), NUL-separated —
 * the shape `sessionKey` builds and `groupBySymbolDay` emits. Never parsed
 * back into a date here beyond the trailing field the prune compares; the key
 * is built in exactly one place so the two writers cannot spell it two ways
 * (MONEY-1373).
 *
 * The separator is written as the ESCAPE (backslash-u-0000) wherever it
 * appears in source, never as a raw 0x00 byte. A raw NUL is invisible in a
 * diff and in a review, which is why this repo has a tripwire for it — and
 * this very comment described the key by CONTAINING two, which is how it was
 * caught.
 */
type DayKey = string;

/**
 * The two collaborators, behind an interface so the ORCHESTRATION is testable.
 *
 * The mixed-source rule itself is a pure function with its own tests. What was
 * untestable — and therefore untested — is everything around it: that the day
 * verdicts are resolved in one query per day rather than one per symbol, that
 * refusals are counted rather than silently dropped, and that `written` reports
 * what the REPOSITORY did rather than what it was handed. This module's sibling
 * shipped a socket that never subscribed for exactly the want of a seam.
 */
export interface CandleSinkDeps {
  findListings(symbols: readonly string[]): Promise<readonly Listing2[]>;
  /**
   * The window is a HALF-OPEN `[startMs, endMs)` handed in whole, not a start
   * plus a length. It used to be `dayStartMs` and a `+ 86_400_000` inside the
   * query, and that constant is wrong twice a year: an ET day is 23 hours in
   * March and 25 in November (MONEY-1373). `usMarketDayBoundsUtc` is the one
   * place that arithmetic lives.
   */
  findExistingSources(args: {
    symbols: readonly string[];
    timeframe: string;
    startMs: number;
    endMs: number;
  }): Promise<ReadonlyArray<{ symbol: string; source: string }>>;
  putCandles(rows: readonly RtCandleRow[]): Promise<{
    created: number;
    upgraded: number;
    failed: number;
  }>;
}

interface Listing2 extends Listing {
  symbol: string;
}

const defaultDeps: CandleSinkDeps = {
  findListings: (symbols) =>
    prisma.usInstrument.findMany({
      where: { symbol: { in: [...symbols] }, listingStatus: "ACTIVE" },
      select: { symbol: true, exchange: true, listingId: true },
    }),
  findExistingSources: ({ symbols, timeframe, startMs, endMs }) =>
    prisma.candle.findMany({
      where: {
        symbol: { in: [...symbols] },
        timeframe,
        ts: { gte: new Date(startMs), lt: new Date(endMs) },
      },
      select: { symbol: true, source: true },
      distinct: ["symbol"],
    }),
  putCandles: (rows) => candleRepository.putCandles(rows),
};

export class RtCandleSink {
  private readonly listings = new Map<string, Listing | null>();
  private readonly dayVerdict = new Map<DayKey, boolean>();

  constructor(
    readonly counters: CandleSinkCounters = emptyCandleSinkCounters(),
    private readonly deps: CandleSinkDeps = defaultDeps,
  ) {}

  /**
   * Resolve listings for symbols we have not seen.
   *
   * A `null` entry is CACHED — "we looked and there is no active listing" is an
   * answer, and re-asking every flush would put a query on the hot path for
   * exactly the symbols that will never resolve. Cleared by `forgetListings`
   * when the base set is rebuilt, so a newly-listed symbol is picked up within
   * one rebuild cycle rather than never.
   */
  private async ensureListings(symbols: readonly string[]): Promise<void> {
    const missing = symbols.filter((s) => !this.listings.has(s));
    if (missing.length === 0) return;
    const rows = await this.deps.findListings(missing);
    for (const r of rows) {
      // A symbol can list on more than one venue; first wins, deterministically
      // by the query's natural order. Both are the same company, and the bar is
      // a consolidated-feed quote that belongs to neither venue specifically.
      if (!this.listings.has(r.symbol)) {
        this.listings.set(r.symbol, {
          listingId: r.listingId,
          exchange: r.exchange,
        });
        this.counters.listingsResolved++;
      }
    }
    for (const s of missing)
      if (!this.listings.has(s)) this.listings.set(s, null);
  }

  /** Drop the listing cache so a newly-listed symbol becomes resolvable. */
  forgetListings(): void {
    this.listings.clear();
  }

  /**
   * Resolve the mixed-source verdict for every group in ONE query per day.
   *
   * The natural spelling is one `findFirst` per symbol-day, and it is the wrong
   * granularity to RUN: at the documented cap of TIINGO_RT_MAX_SYMBOLS (3,000)
   * the first flush after the opening bell would ask the database three
   * thousand separate questions inside a single five-second tick.
   *
   * Every bar in one flush shares a minute and therefore an ET session date,
   * so the whole batch collapses to one `findMany` per session. One row per
   * symbol-session is all that is needed — the rule is that a session holds
   * ONE source, so the first row's source IS the session's source.
   *
   * THE SESSION IS THE ET CALENDAR DATE, NOT THE UTC ONE — MONEY-1373. Under
   * EST the 19:00–19:59 ET post-market hour falls on the UTC day that also
   * holds the NEXT session's 04:00 ET pre-market, so a UTC key made one
   * writer's spill hour lock the other writer out of a whole session. See
   * `groupBySymbolDay`, which produces the keys read here.
   *
   * Verdicts are cached because the answer can only change when a DIFFERENT
   * writer runs, and the nightly EOD job does not run mid-session.
   */
  private async resolveDayVerdicts(
    groups: ReadonlyMap<string, RtCandleRow[]>,
  ): Promise<void> {
    // Only the groups we have not already decided about.
    const pending = [...groups].filter(([key]) => !this.dayVerdict.has(key));
    if (pending.length === 0) return;

    // ET session date -> the symbols asked about in that session
    const byDay = new Map<string, { symbols: Set<string>; keys: string[] }>();
    for (const [key, rows] of pending) {
      const first = rows[0]!;
      const dateKey = usMarketDateKey(first.ts);
      const bucket = byDay.get(dateKey) ?? { symbols: new Set(), keys: [] };
      bucket.symbols.add(first.symbol);
      bucket.keys.push(key);
      byDay.set(dateKey, bucket);
    }

    for (const [dateKey, bucket] of byDay) {
      // A half-open [start, end) from the calendar, never start + 86_400_000:
      // an ET day is 23 hours in March and 25 in November.
      const { startMs, endMs } = usMarketDayBoundsUtc(dateKey);
      const existing = await this.deps.findExistingSources({
        symbols: [...bucket.symbols],
        timeframe: "M1",
        startMs,
        endMs,
      });
      const sourceOf = new Map(existing.map((r) => [r.symbol, r.source]));

      for (const key of bucket.keys) {
        const first = groups.get(key)![0]!;
        const verdict = mayWriteIntoDay(
          RT_CANDLE_SOURCE,
          sourceOf.get(first.symbol) ?? null,
        );
        if (!verdict.allowed) {
          console.warn(
            `[tiingo-rt] ${first.symbol} ${first.timeframe}: ${verdict.reason}`,
          );
        }
        this.dayVerdict.set(key, verdict.allowed);
      }
    }
  }

  /**
   * Drop verdicts for days that are behind us.
   *
   * The cache is keyed on symbol-DAY, so a process that lives across sessions
   * accumulates one entry per symbol per day it has seen and never releases
   * them. Bounded growth beats an unbounded map in the one process that must
   * not die.
   *
   * "Behind us" is measured from the DATA — the newest bar in the batch just
   * written — and not from `Date.now()`. It read `Date.now()` for one release,
   * and that was wrong in two ways that look nothing alike:
   *
   *   - A REPLAY through this sink (the 30-day tick archive exists precisely so
   *     bars can be re-derived) carries bars whose day is always "behind" the
   *     wall clock, so every verdict was pruned on every flush and every flush
   *     re-asked the database — the per-flush query storm the cache exists to
   *     prevent, silently, with the right rows still written.
   *   - The test pinning "a decided day is not re-queried" fixes its bars to a
   *     date and lets the source read the real clock. It was green on the day
   *     it was written and went red two days later, on main, with no code
   *     change — the time-flake class in .claude/skills/fixing-bugs.
   *
   * Live, the newest closed bar sits about a minute behind the clock, so the
   * two references agree to within a minute and nothing about production
   * pruning changes.
   */
  private pruneDayVerdicts(referenceMs: number): void {
    if (!Number.isFinite(referenceMs)) return;
    // The cutoff must be spelled in the SAME calendar as the keys it is
    // compared against, or the string comparison is between two different
    // notions of "day" and is off by one for six hours a night. The keys are
    // ET session dates (MONEY-1373), so this is too.
    const cutoff = usMarketDateKey(new Date(referenceMs - 2 * 86_400_000));
    for (const key of this.dayVerdict.keys()) {
      // The day is the last NUL-separated field; see the DayKey note above.
      const day = key.slice(key.lastIndexOf("\u0000") + 1);
      if (day < cutoff) this.dayVerdict.delete(key);
    }
  }

  /**
   * Write closed bars. Never throws — a failed write must not take the socket
   * down, and the bars are already lost either way.
   */
  async write(bars: readonly MinuteBar[]): Promise<void> {
    if (bars.length === 0) return;
    try {
      await this.ensureListings([...new Set(bars.map((b) => b.symbol))]);

      const rows: RtCandleRow[] = [];
      // The DATA's clock, not the wall clock — see pruneDayVerdicts.
      let newestMs = Number.NEGATIVE_INFINITY;
      for (const b of bars) {
        if (b.tsMs > newestMs) newestMs = b.tsMs;
        const listing = this.listings.get(b.symbol) ?? null;
        const row = toCandleRow({
          symbol: b.symbol,
          tsMs: b.tsMs,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          listingId: listing?.listingId ?? null,
          exchange: listing?.exchange ?? null,
          timeframe: "M1",
        });
        if (row === null) this.counters.refusedNoListing++;
        else rows.push(row);
      }
      if (rows.length === 0) return;

      const groups = groupBySymbolDay(rows);
      await this.resolveDayVerdicts(groups);

      const allowed: RtCandleRow[] = [];
      for (const [key, group] of groups) {
        if (this.dayVerdict.get(key) === true) allowed.push(...group);
        else this.counters.refusedMixedSource += group.length;
      }
      this.pruneDayVerdicts(newestMs);
      if (allowed.length === 0) return;

      const result = await this.deps.putCandles(allowed);
      // Count what the REPOSITORY says it did, not what we handed it. A row can
      // still be dropped for a non-finite value or lost to a chunk failure, and
      // counting the input would report a write that did not happen — the
      // counted-before-the-call shape this repo has paid for before.
      this.counters.written += result.created + result.upgraded;
      this.counters.writeFailures += result.failed;

      // MONEY-1470 (A5) — the same bars into the intraday ring buffer.
      //
      // `allowed`, deliberately, NOT `rows`: the rows the mixed-source rule
      // refused are refused because that session already holds trade-derived
      // bars, and putting a quote-derived bar into the buffer beside them would
      // build exactly the mixture `mayWriteIntoDay` exists to prevent — except
      // in the store the CHART reads, where nothing downstream can detect it.
      //
      // basis is `quote_mid` because this feed carries no trades at all: every
      // one of the 236 captured frames is top-of-book, so `volume: 0` here means
      // "this feed does not report volume", never "nothing traded".
      await this.appendToBuffer(allowed);
    } catch (err) {
      this.counters.writeFailures += bars.length;
      console.error(`[tiingo-rt] candle write failed: ${String(err)}`);
    }
  }

  /**
   * Push closed minutes into the ring buffer, one list per listing.
   *
   * NEVER throws and never counts a failure against the candle write: the
   * warehouse row is the durable record and the buffer is a 45-session cache in
   * front of it. A Redis outage must cost a fast chart, not a bar.
   */
  private async appendToBuffer(rows: readonly RtCandleRow[]): Promise<void> {
    const byListing = new Map<string, BasisBar[]>();
    for (const r of rows) {
      const list = byListing.get(r.listingId) ?? [];
      list.push({
        // Unix SECONDS — the same tuple the D1 tiles use, and what UDF wants.
        bar: [
          Math.floor(r.ts.getTime() / 1000),
          r.open,
          r.high,
          r.low,
          r.close,
          r.volume,
        ],
        basis: "quote_mid",
      });
      byListing.set(r.listingId, list);
    }
    // CONCURRENT, not serial. This runs inside the per-minute flush on the
    // single-process socket holder against a 5-second flush interval, and the
    // subscription ceiling is 3,000 symbols — 3,000 sequential round trips
    // would not fit inside it, and the bars are already paid for by the time
    // we reach here.
    const outcomes = await Promise.all(
      [...byListing].map(async ([listingId, list]) => ({
        ok: await appendBars("US", listingId, list),
        n: list.length,
      })),
    );
    for (const o of outcomes) if (o.ok) this.counters.buffered += o.n;
  }
}
