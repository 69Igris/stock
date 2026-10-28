/**
 * Tick → Bar Aggregator - MONEY-123 Part B
 *
 * Takes a stream of live ticks (from a broker WebSocket) and emits
 * OHLCV bar updates at a fixed interval. Used server-side by the
 * intraday-hub to feed TradingView's `subscribeBars` via SSE.
 *
 * Bar lifecycle for a single (symbol, interval):
 *
 *   [tick 09:17:23, price=1000] → open current bar for [09:15–09:20]
 *                                  o=h=l=c=1000, v=0
 *                                  emit: {time=09:15, o,h,l,c=1000, v=0}
 *   [tick 09:17:45, price=1002] → update current bar
 *                                  h=1002, c=1002
 *                                  emit: {time=09:15, h=1002, c=1002, ...}
 *   [tick 09:20:01, price=1003] → close [09:15-09:20] bar, open new one
 *                                  last emit: close [09:15] bar at 1002
 *                                  first emit: new [09:20] bar at 1003
 *
 * The aggregator does NOT keep any bar history - it only tracks the
 * CURRENT open bar per interval. When a bar boundary is crossed, the
 * previous bar is final and gets one last emit, then a new bar starts.
 *
 * Consumers use this by creating one aggregator per (symbol, interval)
 * and subscribing to its updates. The intraday-hub holds the lifecycle
 * (creates aggregators on first subscriber, destroys on last).
 *
 * Thread safety: single-process JS event loop, no locking needed.
 */

export interface Bar {
  /** Bar start time (unix seconds) */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Cumulative volume within this bar */
  volume: number;
}

export type BarUpdateListener = (bar: Bar, isNewBar: boolean) => void;

/**
 * Canonical interval width in seconds for each supported resolution.
 * Matches the keys used by TradingView's datafeed and our UDF route.
 */
const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60,
  "3m": 3 * 60,
  "5m": 5 * 60,
  "10m": 10 * 60,
  "15m": 15 * 60,
  "30m": 30 * 60,
  "60m": 60 * 60,
  "1h": 60 * 60,
};

/**
 * Return the interval width in seconds, or null if unsupported.
 */
export function getIntervalSeconds(interval: string): number | null {
  return INTERVAL_SECONDS[interval] ?? null;
}

/**
 * Snap a unix second timestamp down to the start of the bar it belongs
 * to for the given interval. e.g. for interval=5m, bar boundaries are
 * at …:00, :05, :10, :15, …; a tick at :07 belongs to the :05 bar.
 *
 * Pure function - useful in tests.
 */
export function snapToBarStart(unixSec: number, intervalSec: number): number {
  return Math.floor(unixSec / intervalSec) * intervalSec;
}

export class TickAggregator {
  private readonly intervalSec: number;
  private currentBar: Bar | null = null;
  private listeners: Set<BarUpdateListener> = new Set();

  constructor(private readonly interval: string) {
    const sec = getIntervalSeconds(interval);
    if (sec === null) {
      throw new Error(`Unsupported interval for tick aggregator: ${interval}`);
    }
    this.intervalSec = sec;
  }

  /**
   * Subscribe to bar updates. Returns an unsubscribe function.
   *
   * New subscribers do NOT immediately receive the current bar -
   * callers that need the latest state should read it via
   * `getCurrentBar()`. This keeps the listener semantics strictly
   * "tell me about NEW changes", avoiding the classic "late subscriber
   * gets duplicate initial state" race.
   */
  onBarUpdate(listener: BarUpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Return the current open bar (the one being built up by the most
   * recent ticks). Null if no ticks have arrived yet.
   */
  getCurrentBar(): Bar | null {
    return this.currentBar;
  }

  /**
   * Ingest a tick. Updates or rotates the current bar and emits to
   * all listeners.
   *
   *   - tick inside the current bar window → update h/l/c/v, emit update
   *   - tick beyond the current bar's end  → emit final update for the
   *     old bar, start new bar, emit first update for new bar
   *
   * `volumeDelta` is the INCREMENTAL volume since the last tick for the
   * same symbol. The Zerodha WS reports cumulative day volume, so the
   * caller (in intraday-hub) computes the delta before passing it here.
   *
   * `tickTimeSec` is the tick timestamp in unix seconds. For the common
   * case where the broker doesn't send a tick time, the caller should
   * pass `Math.floor(Date.now() / 1000)`.
   */
  ingest(price: number, volumeDelta: number, tickTimeSec: number): void {
    const barStart = snapToBarStart(tickTimeSec, this.intervalSec);

    if (!this.currentBar) {
      // First tick - open the first bar.
      this.currentBar = {
        time: barStart,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: Math.max(0, volumeDelta),
      };
      this.emit(this.currentBar, true);
      return;
    }

    if (barStart === this.currentBar.time) {
      // Tick falls inside the current bar. Update h/l/c and add volume.
      if (price > this.currentBar.high) this.currentBar.high = price;
      if (price < this.currentBar.low) this.currentBar.low = price;
      this.currentBar.close = price;
      this.currentBar.volume += Math.max(0, volumeDelta);
      this.emit(this.currentBar, false);
      return;
    }

    if (barStart > this.currentBar.time) {
      // Tick crossed into a new bar window. The old bar is final - emit
      // one last update so listeners see the closing state, then open
      // the new bar at the tick's price and emit as a NEW bar.
      //
      // Note: if several bars are "skipped" (e.g. the session pauses
      // and resumes after a 30m gap on a 5m interval), we DON'T fill
      // the gap with empty bars. TV's datafeed handles gaps gracefully
      // on its own - it just shows a visual break. Inventing fake
      // empty bars would be misleading.
      this.emit(this.currentBar, false);
      this.currentBar = {
        time: barStart,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: Math.max(0, volumeDelta),
      };
      this.emit(this.currentBar, true);
      return;
    }

    // barStart < this.currentBar.time → tick is OLDER than the current
    // bar. This can happen with out-of-order ticks (rare but possible
    // during reconnects). Ignore - we don't rewrite history.
  }

  /**
   * Remove all listeners and clear state. Called by the hub when the
   * last SSE client for this (symbol, interval) disconnects.
   */
  destroy(): void {
    this.listeners.clear();
    this.currentBar = null;
  }

  private emit(bar: Bar, isNewBar: boolean): void {
    // Snapshot the listeners in case one of them unsubscribes during
    // iteration.
    const snapshot = Array.from(this.listeners);
    for (const listener of snapshot) {
      try {
        listener(bar, isNewBar);
      } catch (err) {
        // Don't let one misbehaving listener break the stream for others.
        console.error("[tick-aggregator] listener threw:", err);
      }
    }
  }
}
