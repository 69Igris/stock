/**
 * MONEY-1357 — the realtime holder's counters, as Datadog series.
 *
 * The two guards under test are not hypotheticals. A reconnect builds a NEW
 * `TiingoSocket` with all of its counters back at zero, so `framesReceived`
 * legitimately drops several times a week; and a non-finite value reaching a
 * metrics client is the one input that yields a plausible series with no
 * relationship to reality.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RT_COUNTER_METRICS,
  RT_GAUGE_METRICS,
  computeRtMetricDeltas,
  emptyRtSnapshot,
  healthReasonTag,
  type RtCounterSnapshot,
} from "../../src/realtime/rt-metrics-logic";

const at = (over: Partial<RtCounterSnapshot>): RtCounterSnapshot => ({
  ...emptyRtSnapshot(),
  ...over,
});

const valueOf = (
  deltas: ReturnType<typeof computeRtMetricDeltas>,
  metric: string,
): number => {
  const hit = deltas.find((d) => d.metric === metric);
  assert.ok(hit, `no delta emitted for ${metric}`);
  return hit.value;
};

describe("rt metric names", () => {
  it("every name is under the rt. namespace and unique", () => {
    const names = [
      ...Object.values(RT_COUNTER_METRICS),
      ...Object.values(RT_GAUGE_METRICS),
    ];
    for (const n of names) assert.match(n, /^rt\.[a-z0-9_]+$/, n);
    assert.equal(new Set(names).size, names.length, "duplicate metric name");
  });

  it("names are BARE — the client prepends stockbook.", () => {
    // A name carrying the prefix would arrive as `stockbook.stockbook.rt.…`,
    // and the monitor querying `stockbook.rt.…` would sit in NO DATA — which
    // is exactly MONEY-1238's finding (a), one namespace over.
    for (const n of Object.values(RT_COUNTER_METRICS)) {
      assert.doesNotMatch(n, /^stockbook\./, n);
    }
  });

  it("the snapshot and the name map describe the same fields", () => {
    // A field with no name is never emitted; a name with no field throws on
    // lookup. Either way the drift is silent at runtime.
    assert.deepEqual(
      Object.keys(emptyRtSnapshot()).sort(),
      Object.keys(RT_COUNTER_METRICS).sort(),
    );
  });
});

describe("computeRtMetricDeltas", () => {
  it("reports the increase since the last emit", () => {
    const deltas = computeRtMetricDeltas(
      at({ barsClosed: 10, quotesWritten: 400 }),
      at({ barsClosed: 14, quotesWritten: 973 }),
    );
    assert.equal(valueOf(deltas, "rt.bars_closed"), 4);
    assert.equal(valueOf(deltas, "rt.quotes_written"), 573);
  });

  it("emits every counter, including the unchanged ones", () => {
    const deltas = computeRtMetricDeltas(emptyRtSnapshot(), emptyRtSnapshot());
    assert.equal(deltas.length, Object.keys(RT_COUNTER_METRICS).length);
    assert.ok(deltas.every((d) => d.value === 0));
  });

  it("a counter that RESET reads 0, never a negative", () => {
    // The socket's counters live on the instance; a reconnect replaces it and
    // they start again at zero. A negative increment would SUBTRACT from the
    // series and make the day's total smaller than the truth.
    const deltas = computeRtMetricDeltas(
      at({ framesReceived: 51_233, reconnects: 2 }),
      at({ framesReceived: 0, reconnects: 0 }),
    );
    assert.equal(valueOf(deltas, "rt.frames_received"), 0);
    assert.equal(valueOf(deltas, "rt.reconnects"), 0);
  });

  it("a reset does not disturb the counters that did NOT reset", () => {
    const deltas = computeRtMetricDeltas(
      at({ framesReceived: 900, barsClosed: 7 }),
      at({ framesReceived: 0, barsClosed: 9 }),
    );
    assert.equal(valueOf(deltas, "rt.frames_received"), 0);
    assert.equal(valueOf(deltas, "rt.bars_closed"), 2);
  });

  for (const [label, bad] of [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ] as const) {
    it(`a ${label} counter is SKIPPED, not clamped or emitted`, () => {
      const deltas = computeRtMetricDeltas(
        at({ barsClosed: 1 }),
        at({ barsClosed: bad, quotesWritten: 5 }),
      );
      assert.equal(
        deltas.find((d) => d.metric === "rt.bars_closed"),
        undefined,
        "a non-finite counter must not reach the metrics client at all",
      );
      // and the rest of the snapshot still reports
      assert.equal(valueOf(deltas, "rt.quotes_written"), 5);
    });
  }

  it("is pure — neither snapshot is mutated", () => {
    const before = at({ barsClosed: 3 });
    const after = at({ barsClosed: 8 });
    computeRtMetricDeltas(before, after);
    assert.equal(before.barsClosed, 3);
    assert.equal(after.barsClosed, 8);
  });
});

describe("healthReasonTag", () => {
  it("collapses digits so the tag cannot grow unbounded cardinality", () => {
    // The reason carries a millisecond count, and this gauge is emitted every
    // five seconds. One tag value per emit is how a metrics bill surprises you.
    assert.equal(
      healthReasonTag("no frame for 48231ms"),
      healthReasonTag("no frame for 91004ms"),
    );
  });

  it("keeps the reason legible", () => {
    assert.equal(healthReasonTag("no frame for 48231ms"), "no_frame_for_#ms");
  });

  it("produces a usable tag from unusable input", () => {
    assert.equal(healthReasonTag(""), "unknown");
    assert.equal(healthReasonTag("!!!"), "unknown");
    assert.ok(healthReasonTag("x".repeat(500)).length <= 60);
  });
});
