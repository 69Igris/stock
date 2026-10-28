/**
 * The M1 candle write — the ORCHESTRATION, not the rules.
 *
 * `mayWriteIntoDay` and `toCandleRow` are pure and tested in core. What was
 * untestable, and therefore untested, is everything around them: that a symbol
 * with no active listing is refused rather than guessed at, that the day
 * verdicts cost one query per DAY rather than one per symbol, and that
 * `written` reports what the repository did rather than what it was handed.
 *
 * `flushTick` used to call `aggregator.closeDue(now)` — which retires those
 * minutes permanently — and then discard the result with
 * `counters.barsWritten += 0` and a comment saying the write was "not
 * implemented here yet". Every minute of every session was computed, retired
 * and dropped. These cases exist so that cannot recur silently.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RtCandleSink,
  type CandleSinkDeps,
} from "../../src/realtime/candle-sink";
import type { MinuteBar } from "@usemoney/core/market-data/tiingo/tiingo-minute-bars";
import { usMarketDayBoundsUtc } from "@usemoney/core/market-data/us-market-hours";

const MINUTE = 60_000;
/** 2026-09-01T14:30:00Z — a regular-hours minute. */
const T0 = Date.UTC(2026, 8, 1, 14, 30);

function bar(symbol: string, tsMs = T0, close = 100): MinuteBar {
  return {
    symbol,
    tsMs,
    open: close,
    high: close,
    low: close,
    close,
    ticks: 3,
  };
}

interface SourceCall {
  symbols: readonly string[];
  startMs: number;
  endMs: number;
}

interface Recorder {
  deps: CandleSinkDeps;
  listingCalls: string[][];
  /**
   * The window is recorded WHOLE — `[startMs, endMs)` — because that is what
   * the defect was about. It used to be a start plus an implicit
   * `+ 86_400_000` inside the query, and an ET day is 23 hours in March and 25
   * in November (MONEY-1373).
   */
  sourceCalls: SourceCall[];
  written: Array<readonly unknown[]>;
}

function recorder(opts?: {
  listings?: Array<{ symbol: string; exchange: string; listingId: string }>;
  existing?: Array<{ symbol: string; source: string }>;
  result?: { created: number; upgraded: number; failed: number };
}): Recorder {
  const listingCalls: string[][] = [];
  const sourceCalls: SourceCall[] = [];
  const written: Array<readonly unknown[]> = [];
  return {
    listingCalls,
    sourceCalls,
    written,
    deps: {
      findListings: async (symbols) => {
        listingCalls.push([...symbols]);
        const all = opts?.listings ?? [
          {
            symbol: "AAPL",
            exchange: "NASDAQ",
            listingId: "AAPL:NASDAQ:1980-12-12",
          },
          {
            symbol: "NVDA",
            exchange: "NASDAQ",
            listingId: "NVDA:NASDAQ:1999-01-22",
          },
        ];
        return all.filter((l) => symbols.includes(l.symbol));
      },
      findExistingSources: async ({ symbols, startMs, endMs }) => {
        sourceCalls.push({ symbols, startMs, endMs });
        return (opts?.existing ?? []).filter((e) => symbols.includes(e.symbol));
      },
      putCandles: async (rows) => {
        written.push(rows);
        return opts?.result ?? { created: rows.length, upgraded: 0, failed: 0 };
      },
    },
  };
}

describe("candle sink — bars actually reach the repository", () => {
  it("writes closed bars and counts what the REPOSITORY did", async () => {
    // Not what it was HANDED. A row can still be dropped for a non-finite value
    // or lost to a chunk failure, and counting the input would report a write
    // that did not happen.
    // The fixture MUST make the two answers differ. With created+upgraded
    // equal to the batch size, "count the result" and "count the input" are
    // indistinguishable and the assertion passes against either — which is
    // exactly what a first draft of this test did, and a mutation swapping the
    // two stayed green. Two rows handed over, ONE of them written.
    const r = recorder({ result: { created: 1, upgraded: 0, failed: 1 } });
    const sink = new RtCandleSink(undefined, r.deps);
    await sink.write([bar("AAPL"), bar("NVDA")]);

    assert.equal(r.written.length, 1, "one batched write, not one per bar");
    assert.equal(
      r.written[0]!.length,
      2,
      "both rows were handed to the repository",
    );
    assert.equal(
      sink.counters.written,
      1,
      "written must be created+upgraded (1), NOT the 2 rows we handed over",
    );
    assert.equal(sink.counters.writeFailures, 1);
  });

  it("an empty batch touches nothing", async () => {
    const r = recorder();
    const sink = new RtCandleSink(undefined, r.deps);
    await sink.write([]);
    assert.equal(r.listingCalls.length, 0);
    assert.equal(r.written.length, 0);
  });
});

describe("candle sink — a symbol with no ACTIVE listing is refused, never guessed", () => {
  it("refuses the unlisted symbol and still writes the rest", async () => {
    // A wrong `listingId` does not fail — it silently files a bar under another
    // company. `Candle` is keyed on a LISTING because a ticker is not a
    // security: Tiingo's master holds two rows for DOW on NYSE.
    const r = recorder();
    const sink = new RtCandleSink(undefined, r.deps);
    await sink.write([bar("AAPL"), bar("WHOKNOWS")]);

    assert.equal(sink.counters.refusedNoListing, 1);
    assert.equal(
      r.written[0]!.length,
      1,
      "only the resolvable symbol is written",
    );
  });

  it("a symbol that resolves to nothing is not re-queried every flush", async () => {
    // "We looked and there is no active listing" is an ANSWER. Re-asking every
    // flush would put a query on the hot path for exactly the symbols that will
    // never resolve.
    const r = recorder();
    const sink = new RtCandleSink(undefined, r.deps);
    await sink.write([bar("WHOKNOWS")]);
    await sink.write([bar("WHOKNOWS", T0 + MINUTE)]);
    assert.equal(r.listingCalls.length, 1, "the null answer must be cached");
  });

  it("forgetListings makes a newly-listed symbol resolvable again", async () => {
    // Otherwise the cache is a permanent verdict and a new listing is invisible
    // until the process restarts.
    const r = recorder();
    const sink = new RtCandleSink(undefined, r.deps);
    await sink.write([bar("WHOKNOWS")]);
    sink.forgetListings();
    await sink.write([bar("WHOKNOWS", T0 + MINUTE)]);
    assert.equal(r.listingCalls.length, 2);
  });
});

describe("candle sink — the mixed-source rule is enforced before the write", () => {
  it("refuses a symbol-day that already holds EOD bars", async () => {
    // `putCandles`' upgrade path `$set`s `source` unconditionally, so the
    // repository will happily let a realtime bar overwrite an EOD one. The rule
    // has to be applied by the writer that knows it is a second source.
    const r = recorder({ existing: [{ symbol: "AAPL", source: "TIINGO" }] });
    const sink = new RtCandleSink(undefined, r.deps);
    await sink.write([bar("AAPL"), bar("NVDA")]);

    assert.equal(sink.counters.refusedMixedSource, 1);
    assert.equal(r.written[0]!.length, 1, "only NVDA's day was empty");
  });

  it("allows a day that already holds OUR OWN source", async () => {
    const r = recorder({ existing: [{ symbol: "AAPL", source: "TIINGO_RT" }] });
    const sink = new RtCandleSink(undefined, r.deps);
    await sink.write([bar("AAPL")]);
    assert.equal(sink.counters.refusedMixedSource, 0);
    assert.equal(r.written.length, 1);
  });

  it("costs ONE query per DAY, not one per symbol", async () => {
    // The reason this matters is scale, and it is the whole point of the
    // batching: at the documented cap of 3,000 symbols, one findFirst per
    // symbol-day means three thousand queries inside a single five-second
    // flush tick, on the first flush after the opening bell.
    const r = recorder();
    const bars = Array.from({ length: 50 }, (_, i) => bar(`SYM${i}`));
    const sink = new RtCandleSink(undefined, {
      ...r.deps,
      findListings: async (symbols) =>
        symbols.map((s) => ({
          symbol: s,
          exchange: "NASDAQ",
          listingId: `${s}:NASDAQ:2000-01-01`,
        })),
    });
    await sink.write(bars);
    assert.equal(
      r.sourceCalls.length,
      1,
      `expected 1 query for 50 same-day symbols, got ${r.sourceCalls.length}`,
    );
    assert.equal(r.sourceCalls[0]!.symbols.length, 50);
  });

  it("a decided day is not re-queried on the next flush", async () => {
    const r = recorder();
    const sink = new RtCandleSink(undefined, r.deps);
    await sink.write([bar("AAPL")]);
    await sink.write([bar("AAPL", T0 + MINUTE)]);
    assert.equal(r.sourceCalls.length, 1, "the verdict must be cached per day");
    assert.equal(r.written.length, 2, "but both minutes must still be written");
  });

  it("a NEW ET SESSION is queried again", async () => {
    // The cache is keyed on symbol-SESSION. This used to step by exactly
    // 86_400_000 ms and call the result "midnight UTC", which is the same
    // assumption the day window was built on and is wrong twice a year. The
    // step here is an ET calendar day, taken from the bounds helper.
    const r = recorder();
    const sink = new RtCandleSink(undefined, r.deps);
    await sink.write([bar("AAPL", T0)]);
    const nextSession = usMarketDayBoundsUtc("2026-09-02");
    await sink.write([bar("AAPL", nextSession.startMs + 14 * 3_600_000)]);
    assert.equal(r.sourceCalls.length, 2);
  });

  // The prune is measured from the DATA, not the wall clock. It read
  // `Date.now()` for one release, and the "decided day is not re-queried" case
  // above went red on main two days after it was written, with no code
  // change: its bars are pinned to 2026-09-01, and once the calendar passed
  // 09-03 the real clock declared that day "behind us" and evicted the verdict
  // between the two writes. A replay of archived ticks hits the same thing on
  // every flush. These two cases are dated in 2030 so they discriminate on ANY
  // day: under wall-clock pruning nothing in 2030 is ever behind us, so the
  // eviction below would not happen and the third write would be served from
  // cache.
  const T_FAR = Date.UTC(2030, 0, 15, 14, 30);
  const DAY = 86_400_000;

  it("a day more than two days behind the NEWEST BAR is evicted", async () => {
    const r = recorder();
    const sink = new RtCandleSink(undefined, r.deps);
    await sink.write([bar("AAPL", T_FAR)]);
    await sink.write([bar("AAPL", T_FAR + 3 * DAY)]);
    // The first day is now three days behind the data; its verdict is gone,
    // so asking about it again costs a query.
    await sink.write([bar("AAPL", T_FAR)]);
    assert.equal(
      r.sourceCalls.length,
      3,
      "the T_FAR verdict must be pruned relative to the T_FAR+3d write",
    );
  });

  it("a day inside the two-day window behind the newest bar is kept", async () => {
    const r = recorder();
    const sink = new RtCandleSink(undefined, r.deps);
    await sink.write([bar("AAPL", T_FAR)]);
    await sink.write([bar("AAPL", T_FAR + DAY)]);
    await sink.write([bar("AAPL", T_FAR)]);
    assert.equal(r.sourceCalls.length, 2, "T_FAR is one day behind — kept");
  });
});

describe("candle sink — the day key is the ET SESSION, not the UTC day", () => {
  /**
   * MONEY-1373. The US feed day runs 04:00-20:00 ET. Under EST (UTC-5) the
   * post-market hours 19:00-19:59 ET land on UTC day D+1 — which is ALSO the
   * UTC day of the NEXT session's 04:00 ET pre-market. A UTC key therefore
   * spanned the tail of session D and the head of session D+1, and the
   * mixed-source verdict is cached and applied PER KEY: whichever writer got
   * there first locked the other out of the whole key. Both refusals are
   * silent and look correct from the side that won.
   *
   * The instants are UTC literals with the ET wall clock in the comment. 15
   * January 2026 is a Thursday, well inside EST.
   */
  const RTH_0935 = Date.UTC(2026, 0, 15, 14, 35); // 09:35 ET, session 01-15
  const POST_1930 = Date.UTC(2026, 0, 16, 0, 30); // 19:30 ET, session 01-15
  const PRE_0405 = Date.UTC(2026, 0, 16, 9, 5); //  04:05 ET, session 01-16

  it("hands the query the ET session window, not start + 86_400_000", async () => {
    const r = recorder();
    const sink = new RtCandleSink(undefined, r.deps);
    await sink.write([bar("AAPL", RTH_0935), bar("AAPL", POST_1930)]);

    assert.equal(
      r.sourceCalls.length,
      1,
      "the rth bar and the post-market spill are ONE session",
    );
    const bounds = usMarketDayBoundsUtc("2026-01-15");
    assert.equal(r.sourceCalls[0]!.startMs, bounds.startMs);
    assert.equal(r.sourceCalls[0]!.endMs, bounds.endMs);
    // ...and the window actually contains both bars, which is the property the
    // query depends on and the reason the pair is one verdict.
    assert.ok(bounds.startMs <= RTH_0935 && RTH_0935 < bounds.endMs);
    assert.ok(bounds.startMs <= POST_1930 && POST_1930 < bounds.endMs);
    assert.equal(r.written[0]!.length, 2, "both bars are written");
  });

  it("the NEXT session's 04:05 ET pre-market is a different key and a new query", async () => {
    // 04:05 ET on 01-16 shares a UTC day with the 19:30 ET spill above, so
    // under the old key it was served from the 01-15 verdict — an entire
    // session inheriting a decision made about a different one.
    const r = recorder();
    const sink = new RtCandleSink(undefined, r.deps);
    await sink.write([bar("AAPL", POST_1930)]);
    await sink.write([bar("AAPL", PRE_0405)]);

    assert.equal(r.sourceCalls.length, 2, "two sessions, two verdicts");
    assert.deepEqual(
      r.sourceCalls.map((c) => c.startMs),
      [
        usMarketDayBoundsUtc("2026-01-15").startMs,
        usMarketDayBoundsUtc("2026-01-16").startMs,
      ],
    );
  });

  it("refusing one session does not refuse the one that spilled beside it", async () => {
    // The consequence, end to end. Session 01-15 already holds trade-derived
    // bars, so its rows are refused; session 01-16 is empty and must still be
    // written. Under the UTC key the 19:30 ET spill carried the 01-16 verdict
    // and one refusal took both.
    const r = recorder({ existing: [{ symbol: "AAPL", source: "TIINGO" }] });
    const sink = new RtCandleSink(undefined, {
      ...r.deps,
      // Only session 01-15 is occupied.
      findExistingSources: async ({ symbols, startMs, endMs }) => {
        r.sourceCalls.push({ symbols, startMs, endMs });
        return startMs === usMarketDayBoundsUtc("2026-01-15").startMs
          ? [{ symbol: "AAPL", source: "TIINGO" }]
          : [];
      },
    });

    await sink.write([bar("AAPL", RTH_0935), bar("AAPL", POST_1930)]);
    assert.equal(sink.counters.refusedMixedSource, 2, "session 01-15 refused");
    assert.equal(r.written.length, 0);

    await sink.write([bar("AAPL", PRE_0405)]);
    assert.equal(sink.counters.refusedMixedSource, 2, "no new refusals");
    assert.equal(r.written.length, 1, "session 01-16 is still writable");
    assert.equal(r.written[0]!.length, 1);
  });

  it("a DST day's window is 23 or 25 hours, never a flat 86_400_000", async () => {
    // The `+ 86_400_000` this replaced overshoots by an hour in March
    // (selecting the next session's rows) and stops an hour short in November
    // (leaving a session's last hour unexamined and therefore undefended).
    const r = recorder();
    const sink = new RtCandleSink(undefined, r.deps);
    // 12:00 ET on 2026-03-08 (spring forward) and on 2026-11-01 (fall back).
    await sink.write([bar("AAPL", Date.UTC(2026, 2, 8, 16, 0))]);
    await sink.write([bar("AAPL", Date.UTC(2026, 10, 1, 16, 0))]);

    assert.equal(r.sourceCalls.length, 2);
    assert.equal(
      r.sourceCalls[0]!.endMs - r.sourceCalls[0]!.startMs,
      23 * 3_600_000,
      "2026-03-08 is 23 hours",
    );
    assert.equal(
      r.sourceCalls[1]!.endMs - r.sourceCalls[1]!.startMs,
      25 * 3_600_000,
      "2026-11-01 is 25 hours",
    );
  });
});

describe("candle sink — a failed write never takes the socket down", () => {
  it("swallows a repository throw and counts it", async () => {
    // The bars are already lost either way; killing the process would lose the
    // live feed for every subscriber too.
    const r = recorder();
    const sink = new RtCandleSink(undefined, {
      ...r.deps,
      putCandles: async () => {
        throw new Error("mongo is having a moment");
      },
    });
    await sink.write([bar("AAPL")]);
    assert.equal(sink.counters.writeFailures, 1);
    assert.equal(sink.counters.written, 0);
  });

  it("swallows a listing-lookup throw", async () => {
    const r = recorder();
    const sink = new RtCandleSink(undefined, {
      ...r.deps,
      findListings: async () => {
        throw new Error("no database today");
      },
    });
    await sink.write([bar("AAPL")]);
    assert.equal(sink.counters.writeFailures, 1);
  });
});
