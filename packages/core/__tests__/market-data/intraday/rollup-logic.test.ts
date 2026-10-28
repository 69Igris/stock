/**
 * Intraday roll-up — MONEY-1470 (A5).
 *
 * The identity `5 x 1m === 1 x 5m` is the whole contract: 5m/15m/60m are
 * DERIVED on read, so if the roll-up is wrong every timeframe button above 1m
 * is wrong, and a candle chart gives no hint of it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BUFFER_SESSIONS,
  BASE_INTERVAL,
  MixedBasisError,
  derivableIntervals,
  bufferCapacity,
  decodeBar,
  decodeBuffer,
  encodeBar,
  BUCKET_PHASE_SECONDS,
  BUFFER_TTL_SECONDS,
  intradayKey,
  preferredBasis,
  reportedBasis,
  selectBasisPerSession,
  simulateRankTrim,
  simulateZAdd,
  toBufferMembers,
  rollUp,
  rollUpWithBasis,
  selectBasis,
  type BasisBar,
  type IntradayBar,
} from "../../../src/market-data/intraday/rollup-logic";

/** Minute bars from `startSec`, one per minute. */
const minutes = (n: number, startSec = 1_700_000_000): IntradayBar[] =>
  Array.from({ length: n }, (_, i): IntradayBar => {
    const t = startSec + i * 60;
    return [t, 100 + i, 105 + i, 95 + i, 101 + i, 10 * (i + 1)];
  });

describe("5 x 1m === 1 x 5m", () => {
  it("open is the FIRST, close is the LAST, high/low span, volume sums", () => {
    // Aligned start so the five bars fall in one bucket.
    const base = Math.floor(1_700_000_000 / 300) * 300;
    const bars = minutes(5, base);
    const [rolled] = rollUp(bars, "5m");
    assert.ok(rolled);
    assert.equal(rolled![0], base, "bucket starts on the interval boundary");
    assert.equal(rolled![1], bars[0]![1], "open = first bar's open");
    assert.equal(rolled![4], bars[4]![4], "close = last bar's close");
    assert.equal(rolled![2], Math.max(...bars.map((b) => b[2])));
    assert.equal(rolled![3], Math.min(...bars.map((b) => b[3])));
    assert.equal(
      rolled![5],
      bars.reduce((s, b) => s + b[5], 0),
      "volume sums",
    );
  });

  it("buckets align to the EPOCH, not to the first bar", () => {
    // Otherwise two readers of the same series disagree whenever one starts a
    // minute earlier — the classic chart whose candles shift when you pan.
    const base = Math.floor(1_700_000_000 / 300) * 300;
    const fromSecond = rollUp(minutes(4, base + 60), "5m");
    assert.equal(fromSecond[0]![0], base, "still the same bucket boundary");
  });

  it("a GAP produces no bar — never an invented flat one", () => {
    // A minute with no trade has no input. Fabricating a flat bar shows a real
    // price that never happened.
    const base = Math.floor(1_700_000_000 / 300) * 300;
    const bars = [...minutes(2, base), ...minutes(2, base + 20 * 60)];
    const rolled = rollUp(bars, "5m");
    assert.equal(rolled.length, 2, "two populated buckets, nothing in between");
    assert.equal(rolled[1]![0] - rolled[0]![0], 20 * 60);
  });

  it("a bucket with ONE bar is legitimate and is emitted", () => {
    const base = Math.floor(1_700_000_000 / 900) * 900;
    assert.equal(rollUp(minutes(1, base), "15m").length, 1);
  });

  it("unsorted input still produces ascending buckets", () => {
    const base = Math.floor(1_700_000_000 / 300) * 300;
    const shuffled = [...minutes(10, base)].reverse();
    const rolled = rollUp(shuffled, "5m");
    assert.deepEqual(
      [...rolled.map((b) => b[0])].sort((a, b) => a - b),
      rolled.map((b) => b[0]),
    );
  });

  it("1m is a pass-through", () => {
    const bars = minutes(3);
    assert.deepEqual(rollUp(bars, "1m"), bars);
  });
});

describe("the BASIS is part of the bar", () => {
  const q = (n: number): BasisBar[] =>
    minutes(n).map((bar) => ({ bar, basis: "quote_mid" as const }));
  const t = (n: number): BasisBar[] =>
    minutes(n).map((bar) => ({ bar, basis: "trade" as const }));

  it("REFUSES to roll up a mixed series", () => {
    // quote_mid carries a structural volume of 0 (the Tiingo RT feed has no
    // trades at all); trade carries real volume. A combined bar's volume would
    // mean two different things at once, undetectably.
    assert.throws(
      () => rollUpWithBasis([...q(2), ...t(2)], "5m"),
      MixedBasisError,
    );
  });

  it("a single-basis series rolls up and reports its basis", () => {
    const r = rollUpWithBasis(q(5), "5m");
    assert.equal(r.basis, "quote_mid");
    assert.ok(r.bars.length >= 1);
  });

  it("trade is PREFERRED when a buffer holds both", () => {
    // Same direction as the price-source authority table: DATABENTO 55 over
    // TIINGO_RT 20 — trade-derived with real volume beats a mid price.
    assert.equal(preferredBasis([...q(1), ...t(1)]), "trade");
    assert.equal(preferredBasis(q(1)), "quote_mid");
    assert.equal(preferredBasis([]), null);
  });

  it("selectBasis makes a mixed buffer servable", () => {
    const mixed = [...q(2), ...t(3)];
    assert.equal(selectBasis(mixed, "trade").length, 3);
    assert.doesNotThrow(() =>
      rollUpWithBasis(selectBasis(mixed, "trade"), "5m"),
    );
  });
});

describe("encoding survives a round trip and refuses junk", () => {
  it("round-trips including the basis", () => {
    const entry: BasisBar = {
      bar: [1_700_000_000, 1, 2, 0.5, 1.5, 100],
      basis: "trade",
    };
    assert.deepEqual(decodeBar(encodeBar(entry)), entry);
  });

  it("refuses a malformed line rather than yielding a zero price", () => {
    // `Number("")` is 0, and a silent zero in an OHLC field is a candle that
    // renders perfectly and is wrong.
    for (const bad of [
      "",
      "1,2,3",
      "a,b,c,d,e,f,trade",
      "1,2,3,4,5,6",
      "1,2,3,4,5,6,bogus",
    ]) {
      assert.equal(decodeBar(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
  });

  it("one corrupt entry costs one bar, not the session", () => {
    const good = [
      encodeBar({ bar: [1_700_000_060, 1, 2, 0.5, 1.5, 10], basis: "trade" }),
      encodeBar({ bar: [1_700_000_000, 1, 2, 0.5, 1.5, 10], basis: "trade" }),
    ];
    const { bars, dropped } = decodeBuffer([...good, "garbage"]);
    assert.equal(bars.length, 2);
    assert.equal(dropped, 1);
    assert.ok(bars[0]!.bar[0] < bars[1]!.bar[0], "returned ascending");
  });
});

describe("keys and capacity", () => {
  it("the key carries the market's BASE interval, which is not the same interval", () => {
    // US is 1m; India is 5m, and that is a SOURCE fact. `intraday-sync` fetches
    // Yahoo, whose 1m retention is SEVEN days against 60 for 5m — a 45-session
    // 1m India buffer cannot be filled from the source we have.
    assert.equal(
      intradayKey("US", "AAPL:NASDAQ:1980-12-12"),
      "ib:US:AAPL:NASDAQ:1980-12-12:1m",
    );
    assert.equal(intradayKey("IN", "reliance:nse"), "ib:IN:RELIANCE:NSE:5m");
    assert.equal(BASE_INTERVAL.US, "1m");
    assert.equal(BASE_INTERVAL.IN, "5m");
  });

  it("a 5m base can serve 5/15/60 and REFUSES 1m", () => {
    // THE BUG THIS EXISTS FOR: `rollUp` returned its input unchanged whenever
    // the target was 1m. Asking a 5m India buffer for 1m therefore returned
    // FIVE-MINUTE bars labelled as one-minute — each plots at a real minute
    // with an OHLC describing four minutes it does not claim, and no downstream
    // check could catch it.
    assert.deepEqual(derivableIntervals("5m"), ["5m", "15m", "60m"]);
    assert.deepEqual(derivableIntervals("1m"), ["1m", "5m", "15m", "60m"]);

    const fiveMin: IntradayBar[] = [[300, 10, 12, 9, 11, 100]];
    assert.throws(
      () => rollUp(fiveMin, "1m", "5m"),
      /not a whole multiple|rolling DOWN/i,
      "1m from a 5m buffer must be refused, not passed through",
    );
    assert.equal(
      rollUp(fiveMin, "5m", "5m").length,
      1,
      "the base itself passes through",
    );
    assert.equal(rollUp(fiveMin, "15m", "5m").length, 1, "and 15m aggregates");
  });

  it("the refusal fires on an EMPTY buffer too", () => {
    // Otherwise a wrong interval ships green and fails on the first symbol that
    // happens to have data — the not-measured-is-not-passed shape again.
    assert.throws(
      () => rollUpWithBasis([], "1m", "5m"),
      /IntervalNotDerivable|whole multiple/i,
    );
  });

  it("capacity is 45 SESSIONS, and a session differs per market", () => {
    // Trimmed by COUNT because that is what Redis enforces atomically on write;
    // an age trim needs a reader to decide what "45 sessions ago" means on a
    // calendar with holidays, and getting that wrong silently shortens charts.
    assert.equal(BUFFER_SESSIONS, 45);
    // BARS, not minutes — the counts are asserted in full in "capacity is
    // counted in BARS" below. US's base is 1m so the two coincide; India's 5m
    // base is what the old formula got wrong by 5x.
    assert.equal(bufferCapacity("US"), 960 * 45, "04:00-20:00 ET at a 1m base");
    assert.equal(
      bufferCapacity("IN"),
      (375 / 5) * 45,
      "09:15-15:30 IST at a 5m base",
    );
    assert.ok(bufferCapacity("US") > bufferCapacity("IN"));
  });
});

describe("the buffer is ordered by TIME, not by insertion", () => {
  const bar = (
    t: number,
    v = 0,
    basis: "trade" | "quote_mid" = "trade",
  ): BasisBar => ({
    bar: [t, 1, 1, 1, 1, v],
    basis,
  });

  it("the newest bar is first however it was written", () => {
    // THE DEFECT CLASS THIS REPLACES. As a LIST, position only APPROXIMATED
    // time, and three separate bugs followed: `LPUSH` lands its arguments
    // reversed (so reversing first put the OLDEST at the head), two writers
    // have opposite recency, and a re-fetch duplicated. Scored by the bar's own
    // timestamp, position IS time.
    const held = simulateZAdd(
      [],
      toBufferMembers([bar(100), bar(300), bar(200)]),
    );
    assert.deepEqual(
      held.map((m) => m.score),
      [300, 200, 100],
    );
  });

  it("an OLD session written LATER does not land above a newer one", () => {
    // `candle-sink` appends session D live; `databento-append` runs hours later
    // and writes session D-1 (its vendor embargo is T+1, so it can never have
    // today). As a list those 960 older bars landed at the HEAD, and a
    // `LRANGE 0 n` window was entirely D-1 while today sat invisible below.
    const today = simulateZAdd([], toBufferMembers([bar(5000), bar(5060)]));
    const afterBackfill = simulateZAdd(
      today,
      toBufferMembers([bar(100), bar(160)]),
    );
    assert.deepEqual(
      afterBackfill.map((m) => m.score),
      [5060, 5000, 160, 100],
      "today must stay at the head",
    );
  });

  it("the rank trim evicts the OLDEST, not the newest", () => {
    let held = simulateZAdd([], []);
    for (const t of [100, 200, 300, 400, 500]) {
      held = simulateRankTrim(simulateZAdd(held, toBufferMembers([bar(t)])), 3);
    }
    assert.deepEqual(
      held.map((m) => m.score),
      [500, 400, 300],
    );
  });

  it("re-adding an IDENTICAL bar is an update, not a second copy", () => {
    // `intraday-sync` re-fetches a 5-day overlap nightly. Mongo absorbs it
    // through an upsert; an unconditional list push did not, so every India
    // timestamp accumulated ~5 copies — `rollUp` sums `v` across them, so every
    // derived volume inflated ~5x with a plausible OHLC, and a count-based cap
    // held ~9 distinct sessions instead of 45.
    const once = simulateZAdd(
      [],
      toBufferMembers([bar(100, 500), bar(200, 600)]),
    );
    const twice = simulateZAdd(
      once,
      toBufferMembers([bar(100, 500), bar(200, 600)]),
    );
    assert.equal(twice.length, 2, "a nightly overlap must not grow the buffer");
  });
});

describe("one basis per SESSION, never one per response", () => {
  const sessionOf = (ts: number) => String(Math.floor(ts / 86_400));
  const at = (t: number, basis: "trade" | "quote_mid"): BasisBar => ({
    bar: [t, 1, 1, 1, 1, basis === "trade" ? 10 : 0],
    basis,
  });

  it("a Databento session does not delete TODAY's live bars", () => {
    // THE BUG THIS EXISTS FOR. Choosing one basis for the whole window meant
    // the first night the append landed, `trade` won for ever: 100% of today's
    // `quote_mid` bars were dropped, the slice returned [], and the route
    // answered `no_data`. The live US intraday chart flat-lined for the entire
    // current session, every day, with `dropped` at 0 so nothing logged — it
    // looked exactly like the socket dying.
    const yesterday = [at(100, "trade"), at(200, "trade")];
    const today = [at(86_500, "quote_mid"), at(86_600, "quote_mid")];
    const { bars, bases } = selectBasisPerSession(
      [...yesterday, ...today],
      sessionOf,
    );
    assert.equal(bars.length, 4, "both sessions survive");
    assert.deepEqual(bases.sort(), ["quote_mid", "trade"]);
  });

  it("WITHIN one session, trade still displaces quote_mid", () => {
    // Databento REPLACES a session wholesale, so once it has landed, that
    // session's quote_mid bars are the weaker measurement and must go.
    const mixed = [at(100, "quote_mid"), at(100, "trade"), at(200, "trade")];
    const { bars } = selectBasisPerSession(mixed, sessionOf);
    assert.equal(bars.length, 2);
    assert.ok(bars.every((b) => b.basis === "trade"));
  });

  it("duplicate timestamps within a session collapse to one bar", () => {
    // A sorted set dedupes identical MEMBERS; a re-fetch whose OHLCV differs by
    // a rounding is a different member at the same score, and `rollUp` would
    // sum both volumes into a doubled bar.
    const dupes = [
      at(100, "trade"),
      { bar: [100, 1, 1, 1, 1, 11] as const, basis: "trade" as const },
    ];
    assert.equal(selectBasisPerSession(dupes, sessionOf).bars.length, 1);
  });

  it("the REPORTED basis is the newest session's — what the viewer is seeing", () => {
    const bars = [at(100, "trade"), at(86_500, "quote_mid")];
    assert.equal(reportedBasis(bars), "quote_mid");
    assert.equal(reportedBasis([]), null);
  });
});

describe("buckets align to the VENUE's open, not the UTC epoch", () => {
  it("India's 60m candle starts 09:15 IST, not 08:30", () => {
    // 09:15 IST is 03:45 UTC, so an epoch-aligned hourly bucket starts 03:00
    // UTC = 08:30 IST — every hourly candle stamped 08:30, 09:30, 10:30 instead
    // of the Indian convention, with the first "hour" holding three 5-minute
    // bars while presenting as a full one.
    const open = Date.UTC(2026, 8, 16, 3, 45) / 1000; // 09:15 IST
    const bars: IntradayBar[] = [0, 5, 10, 15, 20].map((m) => [
      open + m * 60,
      10,
      10,
      10,
      10,
      1,
    ]);
    const hourly = rollUp(bars, "60m", "5m", BUCKET_PHASE_SECONDS.IN);
    assert.equal(hourly.length, 1);
    assert.equal(hourly[0]![0], open, "the bucket starts AT the open");

    const epochAligned = rollUp(bars, "60m", "5m", 0);
    assert.notEqual(
      epochAligned[0]![0],
      open,
      "which is what the bug produced",
    );
  });

  it("15m survives epoch alignment by coincidence — which is why it hid", () => {
    const open = Date.UTC(2026, 8, 16, 3, 45) / 1000;
    const bars: IntradayBar[] = [0, 5, 10].map((m) => [
      open + m * 60,
      10,
      10,
      10,
      10,
      1,
    ]);
    assert.equal(
      rollUp(bars, "15m", "5m", BUCKET_PHASE_SECONDS.IN)[0]![0],
      rollUp(bars, "15m", "5m", 0)[0]![0],
      "09:15 IST is a whole number of 15-minute periods from the epoch",
    );
  });

  it("US needs no phase", () => {
    assert.equal(BUCKET_PHASE_SECONDS.US, 0);
  });
});

describe("capacity is counted in BARS", () => {
  it("45 sessions of the market's BASE interval, not 45 sessions of minutes", () => {
    // This returned MINUTES, correct only for a 1-minute base. India's base is
    // 5m, so `375 * 45` was 16,875 FIVE-minute bars = 225 sessions: five times
    // the Redis per listing, an `X-Buffer-Oldest` floor wrong by 5x, and one
    // request allowed to read 16,875 entries.
    assert.equal(bufferCapacity("US"), 960 * 45, "US base is 1m");
    assert.equal(bufferCapacity("IN"), (375 / 5) * 45, "India base is 5m");
    assert.equal(bufferCapacity("IN"), 3_375);
  });

  it("the buffer has a TTL, because nothing else bounds the KEYSPACE", () => {
    // A rank trim bounds a key's LENGTH. The realtime subscription set churns
    // by design, so without a TTL every symbol that ever entered it leaves a
    // full-size immortal key — on the shared Redis that also holds the socket's
    // FAIL-CLOSED leader lock.
    assert.ok(
      BUFFER_TTL_SECONDS > BUFFER_SESSIONS * 24 * 3600,
      "past the window",
    );
  });
});
