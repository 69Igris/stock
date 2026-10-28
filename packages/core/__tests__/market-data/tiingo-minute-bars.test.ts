/**
 * Golden tests for the realtime minute-bar aggregator.
 *
 * The cases that matter are the ones the DORMANT aggregator gets wrong: a
 * symbol that goes silent must still have its last bar written, and a tick that
 * arrives after its own minute has ended must land in the minute it HAPPENED,
 * not the one it arrived in.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MinuteBarAggregator,
  minuteStart,
  LATE_TOLERANCE_MS,
  MINUTE_MS,
} from "../../src/market-data/tiingo/tiingo-minute-bars";

/** 2026-08-31T13:58:00.000Z, an exact minute boundary. */
const T0 = Date.UTC(2026, 7, 31, 13, 58, 0, 0);

describe("PREMISE: the fixture clock is minute-aligned", () => {
  it("T0 is its own minute start", () => {
    // Without this every boundary assertion below is measuring an accident.
    assert.equal(minuteStart(T0), T0);
    assert.equal(T0 % MINUTE_MS, 0);
  });
});

describe("bar construction", () => {
  it("builds OHLC from the mids in a minute", () => {
    const agg = new MinuteBarAggregator();
    for (const [offset, mid] of [
      [0, 100],
      [10_000, 103],
      [20_000, 98],
      [50_000, 101],
    ] as const) {
      agg.ingest({ symbol: "AAPL", tsMs: T0 + offset, mid });
    }
    const bars = agg.closeDue(T0 + MINUTE_MS + LATE_TOLERANCE_MS);
    assert.equal(bars.length, 1);
    const b = bars[0]!;
    assert.equal(b.tsMs, T0, "bar is stamped at its OPEN");
    assert.equal(b.open, 100);
    assert.equal(b.high, 103);
    assert.equal(b.low, 98);
    assert.equal(b.close, 101);
    assert.equal(b.ticks, 4);
  });

  it("a single tick makes a real bar with open==high==low==close", () => {
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "MSFT", tsMs: T0 + 5_000, mid: 500 });
    const [b] = agg.closeDue(T0 + MINUTE_MS + LATE_TOLERANCE_MS);
    assert.ok(b);
    assert.deepEqual(
      [b!.open, b!.high, b!.low, b!.close],
      [500, 500, 500, 500],
    );
  });

  it("separates symbols and emits them in a deterministic order", () => {
    // A diff-then-write repository must see the same batch twice for the same
    // ticks, or a re-run stops being idempotent.
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "TSLA", tsMs: T0 + 1_000, mid: 300 });
    agg.ingest({ symbol: "AAPL", tsMs: T0 + 1_000, mid: 200 });
    agg.ingest({ symbol: "MSFT", tsMs: T0 + 1_000, mid: 400 });
    const bars = agg.closeDue(T0 + MINUTE_MS + LATE_TOLERANCE_MS);
    assert.deepEqual(
      bars.map((b) => b.symbol),
      ["AAPL", "MSFT", "TSLA"],
    );
  });
});

describe("the clock closes bars — the defect the dormant aggregator has", () => {
  it("closes a bar for a symbol that has gone SILENT", () => {
    // THE case. The old aggregator rotates only when the next tick arrives, so
    // a symbol quiet after 15:59 loses its last minute entirely and nothing
    // reports it.
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "AAPL", tsMs: T0 + 1_000, mid: 100 });
    assert.equal(agg.closeDue(T0 + 30_000).length, 0, "not due yet");
    const bars = agg.closeDue(T0 + MINUTE_MS + LATE_TOLERANCE_MS);
    assert.equal(bars.length, 1, "silence must still produce the bar");
  });

  it("holds a bar open until the tolerance has passed", () => {
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "AAPL", tsMs: T0, mid: 100 });
    assert.equal(
      agg.closeDue(T0 + MINUTE_MS).length,
      0,
      "boundary alone is too early",
    );
    assert.equal(
      agg.closeDue(T0 + MINUTE_MS + LATE_TOLERANCE_MS - 1).length,
      0,
      "one ms inside the tolerance is still too early",
    );
    assert.equal(agg.closeDue(T0 + MINUTE_MS + LATE_TOLERANCE_MS).length, 1);
  });

  it("an EMPTY minute produces NO bar", () => {
    // Absence of information, not a flat bar. Inventing one fabricates a price
    // for a minute nobody quoted, and no reader could tell.
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "AAPL", tsMs: T0, mid: 100 });
    agg.ingest({ symbol: "AAPL", tsMs: T0 + 2 * MINUTE_MS, mid: 110 });
    const bars = agg.closeDue(T0 + 3 * MINUTE_MS + LATE_TOLERANCE_MS);
    assert.deepEqual(
      bars.map((b) => b.tsMs),
      [T0, T0 + 2 * MINUTE_MS],
      "the silent middle minute must not appear",
    );
  });
});

describe("late ticks", () => {
  it("a tick arriving after its minute still lands in the minute it HAPPENED", () => {
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "AAPL", tsMs: T0 + 59_000, mid: 100 });
    // Arrives during the next minute but is stamped inside T0, and T0 has not
    // been flushed yet, so it belongs to T0.
    agg.ingest({ symbol: "AAPL", tsMs: T0 + 59_900, mid: 105 });
    const [b] = agg.closeDue(T0 + MINUTE_MS + LATE_TOLERANCE_MS);
    assert.equal(b!.high, 105, "the late tick was dropped instead of counted");
    assert.equal(b!.ticks, 2);
  });

  it("a tick for an ALREADY-FLUSHED minute is dropped and COUNTED", () => {
    // Re-opening a written bar would restate history a reader may have seen.
    // The counter is what makes a too-small tolerance visible.
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "AAPL", tsMs: T0, mid: 100 });
    agg.closeDue(T0 + MINUTE_MS + LATE_TOLERANCE_MS);
    agg.ingest({ symbol: "AAPL", tsMs: T0 + 30_000, mid: 999 });
    assert.equal(agg.counters.droppedLate, 1);
    assert.equal(
      agg.closeDue(T0 + 10 * MINUTE_MS).length,
      0,
      "no restated bar",
    );
  });

  it("flushing one symbol does not block another symbol's earlier minute", () => {
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "AAPL", tsMs: T0, mid: 100 });
    agg.closeDue(T0 + MINUTE_MS + LATE_TOLERANCE_MS);
    // MSFT has never been flushed; its T0 bar is still legitimate.
    agg.ingest({ symbol: "MSFT", tsMs: T0 + 1_000, mid: 400 });
    const bars = agg.closeDue(T0 + 2 * MINUTE_MS);
    assert.deepEqual(
      bars.map((b) => b.symbol),
      ["MSFT"],
    );
    assert.equal(agg.counters.droppedLate, 0);
  });
});

describe("unusable ticks", () => {
  it("a null or non-finite mid is dropped and counted, never stored", () => {
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "AAPL", tsMs: T0, mid: null });
    agg.ingest({ symbol: "AAPL", tsMs: T0, mid: Number.NaN });
    agg.ingest({ symbol: "AAPL", tsMs: T0, mid: Number.POSITIVE_INFINITY });
    assert.equal(agg.counters.droppedNoPrice, 3);
    assert.equal(agg.counters.accepted, 0);
    assert.equal(
      agg.closeDue(T0 + 10 * MINUTE_MS).length,
      0,
      "a bar was built from junk",
    );
  });
});

describe("drain on shutdown", () => {
  it("emits the open minute so a stepping-down leader loses nothing", () => {
    // Counterpart to the `finally` flushes on the EDGAR side: work already paid
    // for must not be discarded because the process is ending.
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "AAPL", tsMs: T0 + 1_000, mid: 100 });
    assert.equal(agg.closeDue(T0 + 5_000).length, 0, "not due on the clock");
    const drained = agg.drain();
    assert.equal(drained.length, 1);
    assert.equal(drained[0]!.tsMs, T0);
    assert.equal(agg.openCount(), 0);
  });

  it("a drained minute cannot be re-opened afterwards", () => {
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "AAPL", tsMs: T0, mid: 100 });
    agg.drain();
    agg.ingest({ symbol: "AAPL", tsMs: T0 + 10_000, mid: 200 });
    assert.equal(agg.counters.droppedLate, 1);
  });
});

/**
 * `sortBars` is a real comparator, not an accident of insertion order.
 *
 * The existing determinism case puts three DIFFERENT symbols in one minute, so
 * only the symbol arm of the comparator is exercised. The same-symbol arm was
 * untested in a way that is easy to miss: `Map` iteration is insertion-ordered
 * and V8's `Array.prototype.sort` is stable, so replacing `a.tsMs - b.tsMs`
 * with `0` produces the right answer for every case above and survives.
 *
 * Out-of-order arrival is not hypothetical here — the module's own "Late ticks"
 * section is about exactly that. When the LATER minute opens first, insertion
 * order and time order disagree, and only a real comparator fixes it. The
 * consumer is a diff-then-write repository, so a batch that comes out
 * newest-first is phantom churn on every re-run.
 */
describe("deterministic order within ONE symbol", () => {
  it("PREMISE: the later minute really is inserted first", () => {
    // If the aggregator ever stopped preserving insertion order, the test below
    // would pass without testing anything.
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "AAPL", tsMs: T0 + MINUTE_MS + 1_000, mid: 110 });
    agg.ingest({ symbol: "AAPL", tsMs: T0 + 1_000, mid: 100 });
    assert.equal(agg.openCount(), 2, "the two minutes must both be open");
  });

  it("closeDue sorts by TIME when the minutes arrived out of order", () => {
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "AAPL", tsMs: T0 + MINUTE_MS + 1_000, mid: 110 }); // M+1 first
    agg.ingest({ symbol: "AAPL", tsMs: T0 + 1_000, mid: 100 }); // M second
    const bars = agg.closeDue(T0 + 3 * MINUTE_MS);
    assert.deepEqual(
      bars.map((b) => b.tsMs),
      [T0, T0 + MINUTE_MS],
      "a same-symbol batch came out newest-first",
    );
    assert.deepEqual(
      bars.map((b) => b.open),
      [100, 110],
      "the bars were reordered but their contents were not",
    );
  });

  it("drain sorts the same way — it is the same comparator", () => {
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "AAPL", tsMs: T0 + 2 * MINUTE_MS, mid: 120 });
    agg.ingest({ symbol: "AAPL", tsMs: T0, mid: 100 });
    agg.ingest({ symbol: "AAPL", tsMs: T0 + MINUTE_MS, mid: 110 });
    assert.deepEqual(
      agg.drain().map((b) => b.tsMs),
      [T0, T0 + MINUTE_MS, T0 + 2 * MINUTE_MS],
    );
  });

  it("symbol still beats time — a later minute of AAPL precedes an earlier MSFT", () => {
    // Pins the ARM ORDER of the comparator: symbol is the major key. Swapping
    // the two arms would order by time first and interleave the symbols.
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "MSFT", tsMs: T0, mid: 400 });
    agg.ingest({ symbol: "AAPL", tsMs: T0 + MINUTE_MS, mid: 100 });
    assert.deepEqual(
      agg.drain().map((b) => `${b.symbol}@${b.tsMs - T0}`),
      ["AAPL@60000", "MSFT@0"],
    );
  });
});

describe("the closed counter counts what was actually emitted", () => {
  it("closeDue increments it by the batch size", () => {
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "AAPL", tsMs: T0, mid: 100 });
    agg.ingest({ symbol: "MSFT", tsMs: T0, mid: 400 });
    assert.equal(agg.counters.closed, 0, "nothing emitted yet");
    assert.equal(agg.closeDue(T0 + MINUTE_MS + LATE_TOLERANCE_MS).length, 2);
    assert.equal(agg.counters.closed, 2);
  });

  it("drain increments it too — a shutdown flush is not free of telemetry", () => {
    // Health-endpoint only, but a drain that emitted bars while reporting zero
    // makes a stepping-down leader look like it lost them.
    const agg = new MinuteBarAggregator();
    agg.ingest({ symbol: "AAPL", tsMs: T0, mid: 100 });
    agg.ingest({ symbol: "MSFT", tsMs: T0, mid: 400 });
    assert.equal(agg.counters.closed, 0);
    assert.equal(agg.drain().length, 2);
    assert.equal(agg.counters.closed, 2, "the shutdown flush was not counted");
  });

  it("an empty drain moves nothing", () => {
    const agg = new MinuteBarAggregator();
    assert.deepEqual(agg.drain(), []);
    assert.equal(agg.counters.closed, 0);
  });
});
