/**
 * Quote store rules — MONEY-1469 (A4).
 *
 * `/api/market/quote` is p50 1.28 s because a cold read falls through to Yahoo.
 * These rules decide what a reader serves instead, and each failure is quiet:
 *
 *   a second key scheme  -> the socket holder writes one store and the reader
 *                           reads another; every quote is a miss and the route
 *                           falls back to Yahoo exactly as before
 *   dropping stale       -> the symbol vanishes from a watchlist, which reads
 *                           as "no such instrument", not "market closed"
 *   one staleness number -> a daily close is stale 10s after it is written, or
 *                           a dead socket serves a two-day-old price as fresh
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  QUOTE_TTL_SECONDS,
  SOURCE_CADENCE_MS,
  STALE_CADENCE_MULTIPLE,
  assembleBatch,
  decodeQuote,
  encodeQuote,
  isStale,
  quoteKey,
  serveQuote,
  type StoredQuote,
} from "../../../src/market-data/quotes/quote-logic";
// The REAL socket payload builder. Imported deliberately: this test exists to
// fail when that shape moves, which a hand-typed fixture could never do.
import { toQuotePayload } from "../../../src/market-data/tiingo/tiingo-rt-sink-logic";

const NOW = 1_800_000_000_000;
const q = (over: Partial<StoredQuote> = {}): StoredQuote => ({
  price: 100,
  change: 1,
  changePct: 1,
  ts: NOW,
  source: "TIINGO_RT",
  ...over,
});

describe("the US key is the one that ALREADY EXISTS", () => {
  it("US reuses rt:us:quote:<SYMBOL>", () => {
    // The socket holder already writes this key and two web routes read it. A
    // new scheme would strand every live quote behind a rename, and the reader
    // would miss every key while looking perfectly correct.
    assert.equal(quoteKey("US", "AAPL:NASDAQ:1980-12-12"), "rt:us:quote:AAPL");
    assert.equal(quoteKey("US", "aapl"), "rt:us:quote:AAPL");
  });

  it("India gets the same scheme in its own namespace", () => {
    // India has NO realtime quote key today — that absence is why its reads
    // fall through to Yahoo, and it is the actual subject of A4.
    assert.equal(quoteKey("IN", "RELIANCE:NSE"), "rt:in:quote:RELIANCE:NSE");
  });
});

describe("staleness is PER SOURCE", () => {
  it("a realtime quote goes stale in MINUTES, matching its own reader", () => {
    // NOT seconds. The socket publishes on QUOTE CHANGE, so a thin name
    // legitimately goes minutes without one — and `RT_QUOTE_MAX_AGE_MS`, the
    // reader of this very key, documents 15 minutes at length and explains why
    // a tight window makes thin names flap between LIVE and FALLBACK on
    // consecutive polls. A 5-second cadence put a SECOND, ten-times-tighter
    // threshold on one key.
    assert.equal(
      SOURCE_CADENCE_MS.TIINGO_RT * STALE_CADENCE_MULTIPLE,
      15 * 60_000,
      "the derived threshold must reproduce RT_QUOTE_MAX_AGE_MS",
    );
    assert.equal(
      isStale(q({ ts: NOW - 60_000 }), NOW),
      false,
      "a quiet minute is not stale",
    );
    assert.equal(
      isStale(q({ ts: NOW - 20 * 60_000 }), NOW),
      true,
      "twenty minutes of silence in a session IS a dead socket",
    );
  });

  it("a YAHOO quote is stale against its WRITER's cadence, not Yahoo's delay", () => {
    // The 15-minute figure everyone reaches for is the exchange DELAY, a
    // property of the PRICE. The cadence is how often a quote is WRITTEN, and
    // the writer is `price-sync-daily` at 23:00 IST on weekdays. At 15 minutes
    // every India quote read `stale: true` for ~23.5 hours a day and all
    // weekend — so `stockbook.quote.stale` equalled `hit` on a perfectly
    // healthy store and could never be alerted on.
    assert.equal(
      isStale(q({ ts: NOW - 6 * 3600_000, source: "YAHOO" }), NOW),
      false,
    );
    assert.equal(
      isStale(q({ ts: NOW - 72 * 3600_000, source: "YAHOO" }), NOW),
      true,
    );
  });

  it("a DAILY source is not stale an hour later", () => {
    // The trap a single threshold creates: bhavcopy writes once a day, so a
    // 10-second rule would mark every close stale immediately after writing it.
    const close = q({ ts: NOW - 3600_000, source: "BHAVCOPY" });
    assert.equal(isStale(close, NOW), false);
    const twoDays = q({ ts: NOW - 50 * 3600_000, source: "BHAVCOPY" });
    assert.equal(isStale(twoDays, NOW), true);
  });

  it("the cadences come from the real schedules, and the multiple is 2", () => {
    assert.equal(STALE_CADENCE_MULTIPLE, 2);
    assert.ok(SOURCE_CADENCE_MS.TIINGO_RT < SOURCE_CADENCE_MS.YAHOO);
    // YAHOO and BHAVCOPY are both written ONCE A DAY by their own crons
    // (price-sync 23:00 IST, bhavcopy-sync 21:00 IST), so they share a cadence
    // — asserting one is strictly tighter than the other invented a difference
    // the schedules do not have.
    assert.equal(SOURCE_CADENCE_MS.YAHOO, SOURCE_CADENCE_MS.BHAVCOPY);
    // An unrecognised source must not be called stale merely for being
    // unrecognised, so UNKNOWN is the most generous cadence.
    assert.ok(SOURCE_CADENCE_MS.UNKNOWN >= SOURCE_CADENCE_MS.BHAVCOPY);
  });
});

describe("stale is SERVED, never dropped", () => {
  it("a stale quote comes back with the flag set", () => {
    const served = serveQuote(q({ ts: NOW - 86_400_000 }), NOW);
    assert.equal(served.stale, true);
    assert.equal(served.price, 100, "the last known price is still served");
    assert.ok(served.ageMs > 0);
  });

  it("a FUTURE timestamp is age zero, not negative", () => {
    // Clock skew between writer and reader must not make a quote look
    // infinitely fresh, nor produce a negative age a later Math.max hides.
    const served = serveQuote(q({ ts: NOW + 60_000 }), NOW);
    assert.equal(served.ageMs, 0);
  });
});

describe("the codec reads the bytes that are ACTUALLY in Redis", () => {
  it("decodes what the LIVE US socket writes — built by the real function", () => {
    // THE JOIN TEST, and the one that caught this module being wrong.
    //
    // The first cut of this store used HSET/HGETALL and REQUIRED price/change/
    // changePct. Both were wrong against the key it claimed to share:
    // `main.ts:256` does `SET rt:us:quote:<SYM> <json> EX 960`, so a hash
    // command there is WRONGTYPE, and the payload carries `last`, not `price`,
    // and no change at all. Thirteen tests passed anyway, because every one of
    // them round-tripped THIS module's own encoder.
    //
    // So the fixture is BUILT BY `toQuotePayload` rather than hand-typed: if
    // the socket's payload shape ever moves, this fails instead of the reader
    // silently missing every US symbol.
    const payload = toQuotePayload(
      {
        ticker: "aapl",
        ts: new Date("2026-09-16T14:30:00.000Z"),
        bid: 189.9,
        ask: 190.1,
        mid: 190,
        bidSize: 100,
        askSize: 200,
        spread: 0.00105,
        service: "equity/intraday",
      },
      "rth",
    );

    const q = decodeQuote(JSON.stringify(payload));
    assert.ok(q, "the live US payload must decode");
    assert.equal(q.price, 190, "`last` is the mid, and it is the price");
    assert.equal(q.source, "TIINGO_RT", "`src` carries provenance");
    assert.equal(q.ts, Date.parse("2026-09-16T14:30:00.000Z"));
    // NOT zero. The socket publishes top-of-book and has no previous close, so
    // a change of 0 would render as a flat market rather than as "unknown".
    assert.equal(q.change, undefined);
    assert.equal(q.changePct, undefined);
  });

  it("a ONE-SIDED book is a miss, never a price of zero", () => {
    // `last: null` is a real state on a thin name — genuinely no mid. A
    // coerced 0 renders, sorts and charts perfectly while being wrong.
    const payload = toQuotePayload(
      {
        ticker: "thin",
        ts: new Date("2026-09-16T14:30:00.000Z"),
        bid: 1,
        ask: null,
        mid: null,
        bidSize: 1,
        askSize: null,
        spread: null,
        service: "equity/intraday",
      },
      "rth",
    );
    assert.equal(decodeQuote(JSON.stringify(payload)), null);
  });

  it("round-trips our own India shape, omitting absent optionals", () => {
    const q: StoredQuote = {
      price: 2814.5,
      change: 12.25,
      changePct: 0.437,
      prevClose: 2802.25,
      ts: 1_726_500_000_000,
      source: "BHAVCOPY",
    };
    const encoded = encodeQuote(q);
    assert.ok(!encoded.includes("volume"), "an absent optional is OMITTED");
    assert.ok(!encoded.includes("null"), "and is never written as null");
    assert.deepEqual(decodeQuote(encoded), q);
  });

  it("refuses garbage rather than inventing a number", () => {
    // Every one of these would otherwise become a price of 0 through Number()
    // or a spread of undefineds through a bare cast.
    assert.equal(decodeQuote(null), null);
    assert.equal(decodeQuote(""), null);
    assert.equal(decodeQuote("not json"), null);
    assert.equal(decodeQuote("[1,2,3]"), null, "an array is not a quote");
    assert.equal(decodeQuote('{"price":190}'), null, "no ts");
    assert.equal(decodeQuote('{"ts":1}'), null, "no price");
    assert.equal(
      decodeQuote('{"price":"190","ts":1}'),
      null,
      "a STRING price is refused — Number('190') would have accepted it",
    );
  });

  it("an unrecognised source falls back to UNKNOWN, not to a tight cadence", () => {
    const q = decodeQuote('{"price":1,"ts":1,"source":"SOME_NEW_FEED"}');
    assert.equal(q?.source, "UNKNOWN");
    // UNKNOWN's cadence is the MOST generous (7 days): a source we do not
    // recognise must not be called stale merely for being unrecognised.
    assert.ok(SOURCE_CADENCE_MS.UNKNOWN > SOURCE_CADENCE_MS.YAHOO);
  });
});

describe("a batch miss is PER SYMBOL", () => {
  it("one unknown ticker costs only itself, and is NAMED", () => {
    const found = new Map<string, StoredQuote | null>([
      ["AAPL", q()],
      ["MSFT", q({ ts: NOW - 86_400_000 })],
      ["NOPE", null],
    ]);
    const r = assembleBatch(["AAPL", "MSFT", "NOPE"], found, NOW);
    assert.equal(r.hits, 2);
    assert.equal(r.misses, 1);
    assert.equal(r.stale, 1, "the stale one is a HIT, and counted separately");
    assert.deepEqual(
      r.missing,
      ["NOPE"],
      "named, so the caller can fall back per symbol",
    );
    assert.ok(r.quotes.MSFT?.stale, "still served");
    assert.equal(r.quotes.NOPE, undefined);
  });

  it("an empty request is not a hit", () => {
    const r = assembleBatch([], new Map(), NOW);
    assert.equal(r.hits, 0);
    assert.equal(r.misses, 0);
  });
});
