/**
 * Minute-bar aggregation for the Tiingo equity-realtime feed — PURE.
 *
 * ## Why not `workers/src/connect/tick-aggregator.ts`
 *
 * That one rotates a bar only when the NEXT tick arrives past the boundary
 * (`ingest` compares `barStart` to the open bar and emits on mismatch). For a
 * chart being watched live that is fine. For a WRITER it is not: a symbol that
 * goes quiet at 15:59 never closes its 15:59 bar, so the last minute of every
 * thin symbol is silently lost — and the loss is invisible, because nothing
 * errored and no counter moved. This aggregator closes on a CLOCK
 * (`closeDue(now)`), so silence still produces a bar.
 *
 * ## These are QUOTE bars, and that is not a detail
 *
 * The level-4 payload is top-of-book: spread, sizes, bid, mid, ask. There is no
 * trade price and NO TRADE VOLUME — measured across 118 captured frames, every
 * one is a quote and none is a print. So:
 *
 *   - OHLC is built from the MID, the feed's best single price.
 *   - `volume` is written as 0 because `Candle.volume` is required, and 0 here
 *     means "this feed does not report volume", NOT "nothing traded".
 *
 * That is why these bars carry `source: "TIINGO_RT"` and why the repository
 * refuses to mix sources inside one symbol-day. A quote-derived bar sitting
 * beside a trade-derived EOD bar in one series would put a real volume next to
 * a structural zero and produce a volume chart that lies. The guard is not
 * tidiness; it keeps this feed's honest limitation from becoming a wrong number.
 *
 * ## Late ticks
 *
 * The feed timestamps at the venue and frames arrive out of order by a few
 * hundred milliseconds, so a tick BELONGING to minute M can arrive while we are
 * already in M+1. `LATE_TOLERANCE_MS` holds bar M open a little past its
 * boundary so those ticks land in the minute they happened rather than the
 * minute they arrived. Beyond the tolerance a late tick is DROPPED and COUNTED:
 * re-opening a bar that has already been written would restate history a reader
 * may have seen, and a counter showing the tolerance is too small is better
 * than a silent restatement.
 */

/** Bars stay open this long past their boundary to absorb out-of-order ticks. */
export const LATE_TOLERANCE_MS = 2_000;

export const MINUTE_MS = 60_000;

export interface RtTick {
  symbol: string;
  /** Venue timestamp, epoch ms. */
  tsMs: number;
  /** The mid. `null` for an incomplete frame; such ticks are ignored. */
  mid: number | null;
}

export interface MinuteBar {
  symbol: string;
  /** Bar OPEN, UTC, minute-aligned. */
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Ticks that contributed. A one-tick bar is real, but worth being able to see. */
  ticks: number;
}

export interface AggregatorCounters {
  /** Ticks carrying no usable mid. */
  droppedNoPrice: number;
  /** Ticks for a minute already flushed, i.e. beyond the tolerance. */
  droppedLate: number;
  /** Ticks accepted into a bar. */
  accepted: number;
  /** Bars emitted. */
  closed: number;
}

export function minuteStart(tsMs: number): number {
  return Math.floor(tsMs / MINUTE_MS) * MINUTE_MS;
}

/**
 * Accumulates ticks into minute bars and closes them on a clock.
 *
 * Deliberately holds NO timer and calls no `Date.now()`. The caller drives it,
 * which is what makes every case below testable without waiting a real minute,
 * and keeps the module free of handles that would otherwise leak in the test
 * runner (the orphan-test class this repo already has a rule about).
 */
export class MinuteBarAggregator {
  private readonly open = new Map<string, MinuteBar>();
  /** Highest minute already flushed per symbol, so a late tick can be refused. */
  private readonly flushed = new Map<string, number>();

  readonly counters: AggregatorCounters = {
    droppedNoPrice: 0,
    droppedLate: 0,
    accepted: 0,
    closed: 0,
  };

  ingest(tick: RtTick): void {
    const price = tick.mid;
    if (price === null || !Number.isFinite(price)) {
      this.counters.droppedNoPrice++;
      return;
    }
    const bucket = minuteStart(tick.tsMs);
    const lastFlushed = this.flushed.get(tick.symbol);
    if (lastFlushed !== undefined && bucket <= lastFlushed) {
      this.counters.droppedLate++;
      return;
    }
    // NUL separator, written as the ESCAPE and never as a raw byte.
    //
    // The separator itself is the house convention — `candle-logic.ts` keys its
    // shards the same way — because a symbol can contain a dash or a dot and a
    // printable separator eventually collides. What must never reach the file is
    // the raw 0x00: it is invisible in a diff, in a review and in most editors,
    // and this repo already lost time to one in `resector-noncanonical.ts`.
    // A source-hygiene tripwire greps for it, and it caught this line.
    const key = `${tick.symbol}\u0000${bucket}`;
    const existing = this.open.get(key);
    if (existing === undefined) {
      this.open.set(key, {
        symbol: tick.symbol,
        tsMs: bucket,
        open: price,
        high: price,
        low: price,
        close: price,
        ticks: 1,
      });
    } else {
      if (price > existing.high) existing.high = price;
      if (price < existing.low) existing.low = price;
      // CLOSE is last-by-ARRIVAL inside the tolerance window. Ordering by venue
      // timestamp would be more correct in principle, but the feed is
      // near-ordered and a per-symbol sort buffer costs more than the sub-second
      // inversion it would fix.
      existing.close = price;
      existing.ticks++;
    }
    this.counters.accepted++;
  }

  /**
   * Emit every bar whose minute ended more than the tolerance ago.
   *
   * EMPTY MINUTES PRODUCE NO BAR. A minute in which a symbol was silent is an
   * absence of information, not a flat bar — inventing one would fabricate a
   * price for a minute nobody quoted, and no reader downstream could tell the
   * difference.
   */
  closeDue(nowMs: number): MinuteBar[] {
    const out: MinuteBar[] = [];
    for (const [key, bar] of this.open) {
      if (nowMs < bar.tsMs + MINUTE_MS + LATE_TOLERANCE_MS) continue;
      out.push({ ...bar });
      this.open.delete(key);
      const prev = this.flushed.get(bar.symbol);
      if (prev === undefined || bar.tsMs > prev)
        this.flushed.set(bar.symbol, bar.tsMs);
    }
    this.counters.closed += out.length;
    return sortBars(out);
  }

  /** Bars still accumulating. For a health endpoint, never for writing. */
  openCount(): number {
    return this.open.size;
  }

  /**
   * Close everything regardless of the clock — SHUTDOWN ONLY.
   *
   * A leader stepping down or a pod draining must not take its open minute with
   * it. Counterpart to the `finally` flushes on the EDGAR side: work already
   * paid for must not be discarded because the process is ending.
   */
  drain(): MinuteBar[] {
    const out = [...this.open.values()].map((b) => ({ ...b }));
    this.open.clear();
    for (const b of out) {
      const prev = this.flushed.get(b.symbol);
      if (prev === undefined || b.tsMs > prev)
        this.flushed.set(b.symbol, b.tsMs);
    }
    this.counters.closed += out.length;
    return sortBars(out);
  }
}

/**
 * Deterministic order: symbol, then time.
 *
 * Two runs over the same ticks must produce the same batch, or the
 * diff-then-write path in `CandleRepository` sees phantom churn and a re-run
 * stops being idempotent.
 */
function sortBars(bars: MinuteBar[]): MinuteBar[] {
  return bars.sort((a, b) =>
    a.symbol === b.symbol ? a.tsMs - b.tsMs : a.symbol < b.symbol ? -1 : 1,
  );
}
