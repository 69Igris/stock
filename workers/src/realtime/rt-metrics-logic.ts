/**
 * The realtime holder's counters, as Datadog series — MONEY-1357.
 *
 * ## Why this exists
 *
 * The service keeps rich counters and, until this landed, emitted NONE of them.
 * They were readable on `/health` and nowhere else, which means the only way to
 * learn that the socket had gone quiet was to ask it — and the whole failure
 * mode of a singleton socket holder is that nobody thinks to ask.
 *
 * ## Why it is PURE, and separate from main.ts
 *
 * Two reasons, and the second is the load-bearing one:
 *
 *   1. The delta arithmetic has a real edge (a counter that went DOWN) and
 *      belongs somewhere a unit test can reach without a socket, a leader lock
 *      or a Redis.
 *   2. `RT_COUNTER_METRICS` and `RT_GAUGE_METRICS` are the NAME LIST, and the
 *      dashboard/monitor guards read it from here rather than from a literal
 *      they keep in step by hand. A widget or an alarm on a series nobody emits
 *      renders as NO DATA, which is indistinguishable from health — this
 *      package's entire history (MONEY-1238) is that one mistake in four
 *      different spellings.
 *
 * Names are BARE here. `datadog-metrics` prepends `METRIC_PREFIX`, so what
 * arrives is `stockbook.rt.bars_closed` and that is what a monitor must query.
 */

/** Every monotonic counter this service reports, flattened from three objects. */
export interface RtCounterSnapshot {
  barsClosed: number;
  candlesWritten: number;
  /** Bars pushed into the intraday ring buffer. MONEY-1470. */
  candlesBuffered: number;
  refusedMixedSource: number;
  refusedNoListing: number;
  candleWriteFailures: number;
  quotesWritten: number;
  quoteWriteFailures: number;
  framesDropped: number;
  framesReceived: number;
  reconnects: number;
  leaderTransitions: number;
  bytesRecorded: number;
}

/** Counter field -> emitted metric name (bare; the client adds `stockbook.`). */
export const RT_COUNTER_METRICS: Readonly<
  Record<keyof RtCounterSnapshot, string>
> = {
  barsClosed: "rt.bars_closed",
  candlesWritten: "rt.candles_written",
  candlesBuffered: "rt.candles_buffered",
  refusedMixedSource: "rt.refused_mixed_source",
  refusedNoListing: "rt.refused_no_listing",
  candleWriteFailures: "rt.candle_write_failures",
  quotesWritten: "rt.quotes_written",
  quoteWriteFailures: "rt.quote_write_failures",
  framesDropped: "rt.frames_dropped",
  framesReceived: "rt.frames_received",
  reconnects: "rt.reconnects",
  leaderTransitions: "rt.leader_transitions",
  bytesRecorded: "rt.bytes_recorded",
};

/**
 * Point-in-time gauges.
 *
 * `healthOk` is the one an alarm reads. It is a gauge rather than a counter
 * because the question is "is it healthy NOW", and it is emitted on every flush
 * tick so that SILENCE is itself the signal: this is the one process in the
 * estate whose death is the entire failure, so its monitor is the one place in
 * the monitor set where `notify_no_data` is deliberately TRUE.
 */
export const RT_GAUGE_METRICS = {
  healthOk: "rt.health_ok",
  leader: "rt.leader",
  subscribed: "rt.subscribed",
  openBars: "rt.open_bars",
} as const;

export function emptyRtSnapshot(): RtCounterSnapshot {
  return {
    barsClosed: 0,
    candlesWritten: 0,
    candlesBuffered: 0,
    refusedMixedSource: 0,
    refusedNoListing: 0,
    candleWriteFailures: 0,
    quotesWritten: 0,
    quoteWriteFailures: 0,
    framesDropped: 0,
    framesReceived: 0,
    reconnects: 0,
    leaderTransitions: 0,
    bytesRecorded: 0,
  };
}

export interface RtMetricDelta {
  metric: string;
  value: number;
}

/**
 * What to ADD to each counter series since the last emit.
 *
 * Two guards, both for things that happen in normal operation rather than in
 * theory:
 *
 *   - A COUNTER THAT WENT DOWN yields 0, never a negative. The socket's
 *     counters live on the `TiingoSocket` INSTANCE, and a reconnect builds a
 *     new one with all of them back at zero — so `framesReceived` legitimately
 *     drops to 0 several times a week. A negative increment would SUBTRACT from
 *     the series, quietly making the day's total smaller than the truth.
 *   - A NON-FINITE value on either side is skipped entirely rather than
 *     clamped. `NaN` reaching a metrics client is the one input that produces a
 *     plausible-looking series with no relationship to reality, and this repo
 *     has paid for that class repeatedly (the `finite()` rule in
 *     .claude/skills/fixing-bugs).
 *
 * Zero deltas ARE returned, so a caller can decide whether to emit them. The
 * caller skips them: a zero-valued `increment` is a wire round trip that adds
 * nothing, and `default_zero()` in the monitor query already covers a gap.
 */
export function computeRtMetricDeltas(
  previous: RtCounterSnapshot,
  current: RtCounterSnapshot,
): RtMetricDelta[] {
  const deltas: RtMetricDelta[] = [];
  for (const key of Object.keys(RT_COUNTER_METRICS) as Array<
    keyof RtCounterSnapshot
  >) {
    const before = previous[key];
    const after = current[key];
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    const delta = after - before;
    deltas.push({
      metric: RT_COUNTER_METRICS[key],
      value: delta > 0 ? delta : 0,
    });
  }
  return deltas;
}

/**
 * Make a health reason safe to use as a metric TAG value.
 *
 * The reason is free text from `decideHealth` and can carry a millisecond
 * count, which as a tag would mint a new tag value per emit — unbounded
 * cardinality on a series emitted every five seconds, which is how a metrics
 * bill becomes a surprise. Digits collapse to `#`, everything unusual becomes
 * `_`, and the result is truncated.
 */
export function healthReasonTag(reason: string): string {
  return (
    reason
      .replace(/\d+/g, "#")
      .replace(/[^a-zA-Z0-9_#-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "unknown"
  );
}
