/**
 * US quote read decisions — REAL logic test (MONEY-1309).
 *
 * Exercises the ACTUAL exported symbols from
 * `src/market-data/tiingo/tiingo-rt-read-logic.ts`. Everything there is pure, so
 * every branch below runs with no Redis, no Mongo and — the point — no Tiingo
 * token.
 *
 * The two claims worth defending, and why each is a test rather than a comment:
 *
 *   1. The venue MIRROR cannot drift. `UsExchange` is a literal union written by
 *      hand because a `ReadonlySet<string>` cannot produce one; if it drifts
 *      from `TIINGO_US_EXCHANGES`, `normalizeUsExchange` starts returning a
 *      value the type says is impossible (or refusing one the runtime accepts).
 *      `marketForExchange` already carries the note about what a second
 *      spelling of that list cost the sector taxonomy.
 *   2. PROVENANCE MATCHES THE STORE THAT ANSWERED. A live quote and an EOD close
 *      are both plausible-looking numbers; the only thing separating them is the
 *      label, so a label that says `fallback:false` over yesterday's close is
 *      the whole defect this module exists to prevent, and it is invisible in
 *      the price. Each of the four outcomes asserts its provenance explicitly.
 *
 * Source: packages/core/src/market-data/tiingo/tiingo-rt-read-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TIINGO_US_EXCHANGES } from "../../src/market-data/tiingo/tiingo-logic";
import type { RtQuotePayload } from "../../src/market-data/tiingo/tiingo-rt-keys";
import type { CandleBar } from "../../src/market-data/candles/candle-logic";
import { DEFAULT_EPHEMERAL_TTL_MS } from "../../src/market-data/tiingo/tiingo-rt-subscription-logic";
import {
  RT_EPHEMERAL_TTL_MS,
  RT_QUOTE_MAX_AGE_MS,
  RT_QUOTE_TTL_SECONDS,
  US_EXCHANGE_NAMES,
  batchQuoteSource,
  decideUsQuote,
  ephemeralExpiryScore,
  isLiveQuoteProvenance,
  isRepresentableInstant,
  isRtQuoteFresh,
  isUsExchange,
  normalizeUsExchange,
  percentChange,
  rtQuotePrice,
} from "../../src/market-data/tiingo/tiingo-rt-read-logic";

const NOW = Date.UTC(2026, 7, 31, 18, 0, 0); // 2026-08-31 18:00 UTC

function mkRt(over: Partial<RtQuotePayload> = {}): RtQuotePayload {
  return {
    symbol: "AAPL",
    bid: 199.5,
    ask: 200.5,
    last: 200,
    bidSize: 100,
    askSize: 100,
    ts: NOW - 1_000,
    src: "TIINGO_RT",
    session: "rth",
    ...over,
  };
}

function mkBar(over: Partial<CandleBar> = {}): CandleBar {
  return {
    symbol: "AAPL",
    exchange: "NASDAQ",
    timeframe: "D1",
    ts: new Date(NOW - 86_400_000),
    listingId: "AAPL:NASDAQ:1980-12-12",
    open: 190,
    high: 196,
    low: 189,
    close: 195,
    volume: 1_000_000,
    divCash: 0,
    splitFactor: 1,
    source: "TIINGO",
    ...over,
  };
}

describe("US venue vocabulary (MONEY-1309)", () => {
  it("[meta] both lists are non-empty — the pin below is not vacuous", () => {
    // Ceiling. `assert.deepEqual([], [])` passes, and an empty mirror would then
    // "match" an empty set while every guard silently answered false.
    assert.ok(US_EXCHANGE_NAMES.length >= 8, "mirror is suspiciously short");
    assert.ok(
      TIINGO_US_EXCHANGES.size >= 8,
      "runtime set is suspiciously short",
    );
  });

  it("the UsExchange union MIRRORS TIINGO_US_EXCHANGES exactly", () => {
    const mirror = [...US_EXCHANGE_NAMES].sort();
    const runtime = [...TIINGO_US_EXCHANGES].sort();
    assert.deepEqual(
      mirror,
      runtime,
      "UsExchange has drifted from TIINGO_US_EXCHANGES. Add the venue to BOTH " +
        "— the set is the runtime source of truth and the union is only a " +
        "type-level mirror of it.",
    );
  });

  it("isUsExchange accepts US venues in any casing, rejects India", () => {
    assert.equal(isUsExchange("NASDAQ"), true);
    assert.equal(isUsExchange("  nasdaq "), true);
    assert.equal(isUsExchange("nyse arca"), true);
    assert.equal(isUsExchange("NSE"), false);
    assert.equal(isUsExchange("BSE"), false);
    assert.equal(isUsExchange(""), false);
    assert.equal(isUsExchange(null), false);
    assert.equal(isUsExchange(undefined), false);
  });

  it("normalizeUsExchange canonicalises or returns null", () => {
    assert.equal(normalizeUsExchange(" nyse "), "NYSE");
    assert.equal(normalizeUsExchange("nyse arca"), "NYSE ARCA");
    assert.equal(normalizeUsExchange("NSE"), null);
    assert.equal(normalizeUsExchange("PINK"), null); // OTC is deliberately out
    assert.equal(normalizeUsExchange(null), null);
  });
});

describe("realtime freshness (MONEY-1309)", () => {
  it("is fresh strictly inside the window, stale at and beyond it", () => {
    assert.equal(isRtQuoteFresh({ ts: NOW - 1 }, NOW), true);
    assert.equal(
      isRtQuoteFresh({ ts: NOW - (RT_QUOTE_MAX_AGE_MS - 1) }, NOW),
      true,
    );
    assert.equal(isRtQuoteFresh({ ts: NOW - RT_QUOTE_MAX_AGE_MS }, NOW), false);
    assert.equal(
      isRtQuoteFresh({ ts: NOW - RT_QUOTE_MAX_AGE_MS - 1 }, NOW),
      false,
    );
  });

  it("a FUTURE timestamp counts as fresh (clock skew, not staleness)", () => {
    // Two Cloud Run instances disagree by milliseconds. Treating that as
    // staleness would blank the NEWEST quotes, which is the wrong direction.
    assert.equal(isRtQuoteFresh({ ts: NOW + 5_000 }, NOW), true);
  });

  it("a non-finite timestamp is never fresh", () => {
    assert.equal(isRtQuoteFresh({ ts: Number.NaN }, NOW), false);
  });

  it("the ephemeral score is an EXPIRY, not a written-at", () => {
    // The eviction policy drops the soonest-expiring first, which is a range
    // query on the score — so the score has to be the expiry instant.
    assert.equal(ephemeralExpiryScore(NOW), NOW + RT_EPHEMERAL_TTL_MS);
    assert.equal(ephemeralExpiryScore(NOW, 60_000), NOW + 60_000);
    assert.ok(ephemeralExpiryScore(NOW) > NOW);
  });

  it("[MONEY-1309 follow-up] the Redis TTL cannot be TIGHTER than the window", () => {
    // The two shipped as independent numbers — `EX 90` against a 15-minute
    // freshness window — so the BINDING threshold was 90 seconds, ten times
    // tighter than the one that was reasoned about and written down. That is
    // precisely the LIVE/FALLBACK flapping on thin names the window exists to
    // avoid. A key that has already expired is indistinguishable from a symbol
    // the feed never quoted, so the writer's TTL silently overrides the
    // reader's check whenever it is shorter.
    assert.ok(
      RT_QUOTE_TTL_SECONDS * 1_000 >= RT_QUOTE_MAX_AGE_MS,
      `TTL ${RT_QUOTE_TTL_SECONDS}s is shorter than the ${RT_QUOTE_MAX_AGE_MS}ms ` +
        "freshness window, so `isRtQuoteFresh` can never observe a stale quote",
    );
    // STRICTLY greater, not merely equal: with an exactly-equal TTL the key and
    // the quote's liveness expire in the same instant and whichever clock runs
    // ahead becomes the arbiter.
    assert.ok(RT_QUOTE_TTL_SECONDS * 1_000 > RT_QUOTE_MAX_AGE_MS);
  });

  it("[MONEY-1309 follow-up] the ephemeral TTL is the PLANNER's, not a second one", () => {
    // `planSubscriptions` computes eviction order from `DEFAULT_EPHEMERAL_TTL_MS`
    // while this side scored members with its own 10-minute constant: the writer
    // says a member dies at +10m and the planner reasons as if it died at +15m,
    // on the same sorted set.
    assert.equal(RT_EPHEMERAL_TTL_MS, DEFAULT_EPHEMERAL_TTL_MS);
  });

  it("a timestamp outside Date's range is not representable", () => {
    // `Number.isFinite(1e20)` is true and `new Date(1e20).toISOString()` throws
    // `RangeError`. `decideUsQuote` documents "never throws" and builds
    // `provenance.asOf` with exactly that call, on a number parsed out of a
    // Redis value another process wrote.
    assert.equal(isRepresentableInstant(NOW), true);
    assert.equal(isRepresentableInstant(0), true);
    assert.equal(isRepresentableInstant(8.64e15), true);
    assert.equal(isRepresentableInstant(8.64e15 + 1), false);
    assert.equal(isRepresentableInstant(1e20), false);
    assert.equal(isRepresentableInstant(Number.NaN), false);
    assert.equal(isRepresentableInstant(Number.POSITIVE_INFINITY), false);
    assert.equal(isRepresentableInstant("1234"), false);
  });
});

describe("isLiveQuoteProvenance — the ONE liveness rule (MONEY-1309 follow-up)", () => {
  it("[meta] it discriminates at all", () => {
    // Ceiling. A function stuck on one answer satisfies half the matrix below
    // and silently breaks the other half.
    assert.notEqual(
      isLiveQuoteProvenance({ source: "TIINGO_RT", fallback: false }),
      isLiveQuoteProvenance({ source: "TIINGO", fallback: true }),
    );
  });

  it("a live realtime quote is live", () => {
    assert.equal(
      isLiveQuoteProvenance({ source: "TIINGO_RT", fallback: false }),
      true,
    );
  });

  it("[regression] fallback:true is NOT live even on the realtime source", () => {
    // THE defect. `isLiveQuoteSource(source)` answered true here, so
    // `DelayedDataNote` rendered a green "Live quote · 05:30 am" badge IN PLACE
    // OF the exchange-delayed disclaimer, on the same header whose provenance
    // chip was showing an amber `fallback` pill.
    assert.equal(
      isLiveQuoteProvenance({ source: "TIINGO_RT", fallback: true }),
      false,
    );
  });

  it("the EOD close is never live, with or without the flag", () => {
    assert.equal(
      isLiveQuoteProvenance({ source: "TIINGO", fallback: true }),
      false,
    );
    assert.equal(
      isLiveQuoteProvenance({ source: "TIINGO", fallback: false }),
      false,
    );
  });

  it("every unknown fails CLOSED", () => {
    assert.equal(isLiveQuoteProvenance(null), false);
    assert.equal(isLiveQuoteProvenance(undefined), false);
    assert.equal(isLiveQuoteProvenance({}), false);
    assert.equal(isLiveQuoteProvenance({ fallback: false }), false);
    assert.equal(isLiveQuoteProvenance({ source: "yahoo" }), false);
    assert.equal(isLiveQuoteProvenance({ source: "zerodha" }), false);
    assert.equal(isLiveQuoteProvenance({ source: "some-future-feed" }), false);
    // Casing is not a guess.
    assert.equal(isLiveQuoteProvenance({ source: "tiingo_rt" }), false);
  });

  it("a MISSING fallback does not promote a live source", () => {
    // The envelope path passes `{ source }` alone, and must still get a true
    // answer for a genuinely live batch — `batchQuoteSource` has already
    // demoted a mixed one.
    assert.equal(isLiveQuoteProvenance({ source: "TIINGO_RT" }), true);
    assert.equal(
      isLiveQuoteProvenance({ source: "TIINGO_RT", fallback: null }),
      true,
    );
  });
});

describe("price extraction (MONEY-1309)", () => {
  it("prefers the feed's own last, falls back to the mid", () => {
    assert.equal(rtQuotePrice(mkRt({ last: 201 })), 201);
    assert.equal(rtQuotePrice(mkRt({ last: null })), 200); // (199.5 + 200.5)/2
  });

  it("is null when there is no usable number", () => {
    assert.equal(rtQuotePrice(mkRt({ last: null, bid: null })), null);
    assert.equal(rtQuotePrice(mkRt({ last: null, ask: null })), null);
    assert.equal(
      rtQuotePrice(mkRt({ last: Number.NaN, bid: null, ask: null })),
      null,
    );
  });

  it("percentChange guards the zero divide instead of emitting Infinity", () => {
    assert.equal(percentChange(110, 100), 10);
    assert.equal(percentChange(100, 0), 0);
    assert.equal(percentChange(100, Number.NaN), 0);
  });
});

describe("decideUsQuote — which store answered, and what it claims", () => {
  it("a FRESH realtime quote is TIINGO_RT and NOT a fallback", () => {
    const q = decideUsQuote({
      symbol: "AAPL",
      exchange: "NASDAQ",
      rt: mkRt(),
      bars: [mkBar({ close: 190 }), mkBar({ close: 195 })],
      nowMs: NOW,
    });
    assert.ok(q);
    assert.equal(q.price, 200);
    assert.equal(q.provenance.source, "TIINGO_RT");
    assert.equal(
      q.provenance.fallback,
      false,
      "a live quote must not be marked as a stand-in",
    );
    assert.equal(q.provenance.session, "rth");
    assert.equal(q.provenance.asOf, new Date(NOW - 1_000).toISOString());
  });

  it("the live quote measures change against the SESSION bar, not itself", () => {
    // `previousClose` comes from the bar BEFORE the latest one. A quote carries
    // no previous close of its own, so without the bars this delta would have
    // to be a fabricated zero — which reads as "unchanged" rather than as
    // "unknown".
    const q = decideUsQuote({
      symbol: "AAPL",
      exchange: "NASDAQ",
      rt: mkRt({ last: 210 }),
      bars: [mkBar({ close: 200 }), mkBar({ close: 205 })],
      nowMs: NOW,
    });
    assert.ok(q);
    assert.equal(q.previousClose, 200);
    assert.equal(q.change, 10);
    assert.equal(q.changePercent, 5);
    // The OHLC belongs to the SESSION, not to the point quote.
    assert.equal(q.open, 190);
    assert.equal(q.high, 196);
  });

  it("a STALE realtime quote falls through to the EOD close", () => {
    const q = decideUsQuote({
      symbol: "AAPL",
      exchange: "NASDAQ",
      rt: mkRt({ ts: NOW - RT_QUOTE_MAX_AGE_MS - 1, last: 999 }),
      bars: [mkBar({ close: 190 }), mkBar({ close: 195 })],
      nowMs: NOW,
    });
    assert.ok(q);
    assert.equal(q.price, 195, "the stale 999 must not be served as the price");
    assert.equal(q.provenance.source, "TIINGO");
    assert.equal(
      q.provenance.fallback,
      true,
      "the EOD close standing in for a live quote IS a fallback",
    );
  });

  it("no realtime quote at all is the EOD close, marked fallback", () => {
    const q = decideUsQuote({
      symbol: "MSFT",
      exchange: "NASDAQ",
      rt: null,
      bars: [mkBar({ close: 400 }), mkBar({ close: 410 })],
      nowMs: NOW,
    });
    assert.ok(q);
    assert.equal(q.price, 410);
    assert.equal(q.previousClose, 400);
    assert.equal(q.provenance.source, "TIINGO");
    assert.equal(q.provenance.fallback, true);
    assert.ok(q.provenance.note, "a fallback should say why in its tooltip");
  });

  it("a single bar yields a FLAT change, not a fabricated delta", () => {
    const q = decideUsQuote({
      symbol: "MSFT",
      exchange: "NASDAQ",
      rt: null,
      bars: [mkBar({ close: 400 })],
      nowMs: NOW,
    });
    assert.ok(q);
    assert.equal(q.previousClose, 400);
    assert.equal(q.change, 0);
    assert.equal(q.changePercent, 0);
  });

  it("[regression] a FRESH quote with NO bars is not a quote at all", () => {
    // THE fabrication. `decideUsQuote` is called for EVERY requested symbol
    // while `resolveUsQuotes` reads bars for only the first
    // `US_EOD_FALLBACK_MAX_SYMBOLS` (12), so symbol 13 of a 20-symbol US
    // watchlist arrived here with a live price and an empty bar list. It used
    // to take the live branch and fill the gaps from the quote price itself:
    //
    //   {price:250, change:0, changePercent:0, open:250, high:250, low:250,
    //    previousClose:250, volume:0, provenance:{fallback:false}}
    //
    // A real price beside a flat 0.00% the market never printed and a zero
    // volume the feed never sent, badged LIVE. There is no previous close to
    // measure against, so there is no quote.
    assert.equal(
      decideUsQuote({
        symbol: "AAPL",
        exchange: "NASDAQ",
        rt: mkRt({ ts: NOW - 1_000, last: 250 }),
        bars: [],
        nowMs: NOW,
      }),
      null,
    );
  });

  it("[regression] a STALE quote with no bars is not a quote either", () => {
    // This was the fourth outcome — `TIINGO_RT` + `fallback:true`, the "gap
    // window". Its justification ("`us-eod-sync` runs ~01:30 ET, so a 16:00 ET
    // close has no bar for nine hours") described a case the EOD branch
    // ALREADY handles: that branch reads a THIRTY-DAY window, so the previous
    // sessions' bars are all present and `latest` is defined. Reaching here
    // meant zero bars in thirty days — no history at all — which is not a
    // freshness state and carries the same fabricated flat session.
    assert.equal(
      decideUsQuote({
        symbol: "AAPL",
        exchange: "NASDAQ",
        rt: mkRt({ ts: NOW - 6 * 3_600_000, last: 250, session: "post" }),
        bars: [],
        nowMs: NOW,
      }),
      null,
    );
  });

  it("the post-close gap IS served — from the EOD branch, as claimed", () => {
    // The scenario the deleted branch was written for, proving the deletion
    // costs nothing: hours after the close, before the sync writes today's bar,
    // the thirty-day window still holds yesterday's.
    const q = decideUsQuote({
      symbol: "AAPL",
      exchange: "NASDAQ",
      rt: mkRt({ ts: NOW - 6 * 3_600_000, last: 250, session: "post" }),
      bars: [mkBar({ close: 190 }), mkBar({ close: 195 })],
      nowMs: NOW,
    });
    assert.ok(q, "the post-close window must still serve a price");
    assert.equal(q.price, 195);
    assert.equal(q.provenance.source, "TIINGO");
    assert.equal(q.provenance.fallback, true);
  });

  it("never throws on a finite-but-unrepresentable timestamp", () => {
    // `new Date(1e20).toISOString()` is a RangeError, and `provenance.asOf` is
    // built with exactly that call on a number parsed out of Redis. The
    // documented contract is "never throws"; a 500 on a quote poll is not a
    // fail-open.
    // Called through a named function rather than captured into a `let`.
    // `let q: ReturnType<typeof decideUsQuote> = null` narrows q to `null`, and
    // an assignment inside the `doesNotThrow` callback is not tracked by
    // control-flow analysis — so `q!` widens to `never` and every property
    // access on it is a type error. `decideUsQuote` is pure, so calling it
    // twice costs nothing and keeps the "must not throw" assertion explicit.
    const call = (): ReturnType<typeof decideUsQuote> =>
      decideUsQuote({
        symbol: "AAPL",
        exchange: "NASDAQ",
        rt: mkRt({ ts: 1e20, last: 250 }),
        bars: [mkBar({ close: 195 })],
        nowMs: NOW,
      });
    assert.doesNotThrow(call);
    // It degrades to the EOD close rather than to an error or to a quote
    // stamped with an Invalid Date.
    const q = call();
    assert.ok(q);
    assert.equal(q.provenance.source, "TIINGO");
    assert.notEqual(q.provenance.asOf, "Invalid Date");
  });

  it("neither store → null, so the symbol is simply ABSENT (fail-open)", () => {
    assert.equal(
      decideUsQuote({
        symbol: "NOPE",
        exchange: "NASDAQ",
        rt: null,
        bars: [],
        nowMs: NOW,
      }),
      null,
    );
  });

  it("an unusable realtime payload is treated as no quote at all", () => {
    const q = decideUsQuote({
      symbol: "AAPL",
      exchange: "NASDAQ",
      rt: mkRt({ last: null, bid: null, ask: null }),
      bars: [mkBar({ close: 195 })],
      nowMs: NOW,
    });
    assert.ok(q);
    assert.equal(q.provenance.source, "TIINGO");
  });
});

describe("batchQuoteSource — the pessimistic envelope label", () => {
  const live = { provenance: { source: "TIINGO_RT", fallback: false } };
  const eod = { provenance: { source: "TIINGO", fallback: true } };

  it("all live → TIINGO_RT", () => {
    assert.equal(batchQuoteSource([live, live]), "TIINGO_RT");
  });

  it("ONE fallback in the batch demotes the whole envelope", () => {
    // A single stale quote rendered under a "live" banner is the mislabelling
    // the per-quote provenance exists to prevent; the envelope must not
    // re-introduce it by reporting its luckiest member.
    assert.equal(batchQuoteSource([live, eod, live]), "TIINGO");
  });

  it("an EMPTY batch is not live — there is nothing to be live about", () => {
    assert.equal(batchQuoteSource([]), "TIINGO");
  });

  it("a quote with NO provenance (an India quote) demotes the envelope", () => {
    assert.equal(batchQuoteSource([live, {}]), "TIINGO");
  });
});
