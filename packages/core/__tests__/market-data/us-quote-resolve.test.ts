/**
 * `resolveUsQuotes` — the EOD fan-out cap, measured (MONEY-1309 follow-up).
 *
 * ## Why this file exists at all
 *
 * `US_EOD_FALLBACK_MAX_SYMBOLS` appeared in NO test. It could not: the function
 * reads Redis through `getRedisClient()` (which has a seam) and Mongo through
 * the `candleRepository` module singleton (which had none), so exercising the
 * cap meant a live database. A constant that bounds a request path, with a
 * comment describing behaviour it did not have, and nothing able to look.
 *
 * What the comment claimed — "symbols past the cap are simply absent from the
 * payload" — was true only when Redis answered NOTHING. The cap truncates the
 * BAR read; the decision loop still ran for every requested symbol. So a symbol
 * past it arrived with a fresh realtime quote and an EMPTY bar list, took the
 * live branch, and was served:
 *
 *   {price: 250, change: 0, changePercent: 0, open: 250, high: 250, low: 250,
 *    previousClose: 250, volume: 0, provenance: {fallback: false}}
 *
 * a real price beside a flat 0.00% the market never printed, badged LIVE. Both
 * routes admit 50 symbols, so a 20-symbol US watchlist hit it on eight.
 *
 * ## What is faked, and what is deliberately real
 *
 * Redis and the bar read are injected — `__setRedisFactoryForTests` (the same
 * harness `us-quote-interest.test.ts` and `cache-batch-ops.test.ts` drive) and
 * `__setUsEodBarsReaderForTests`. `decideUsQuote`, `normalizeUsExchange` and the
 * cap itself run for real: they are the three decisions under test, and faking
 * any of them would replace the subject with the test's own opinion.
 *
 * The bar reader RECORDS which symbols it was asked for, because "the cap held"
 * and "the cap was never reached" produce the same quote map, and only the call
 * log separates them.
 *
 * Source: packages/core/src/market-data/tiingo/tiingo-rt-read.ts
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Redis } from "ioredis";

import {
  __setRedisFactoryForTests,
  resetRedisClient,
} from "../../src/cache/redis";
import { rtQuoteKey } from "../../src/market-data/tiingo/tiingo-rt-keys";
import type { RtQuotePayload } from "../../src/market-data/tiingo/tiingo-rt-keys";
import type { CandleBar } from "../../src/market-data/candles/candle-logic";
import {
  US_EOD_FALLBACK_MAX_SYMBOLS,
  __setUsEodBarsReaderForTests,
  resolveUsQuotes,
} from "../../src/market-data/tiingo/tiingo-rt-read";

const NOW = new Date(Date.UTC(2026, 7, 31, 18, 0, 0));

function mkRt(symbol: string, over: Partial<RtQuotePayload> = {}): string {
  return JSON.stringify({
    symbol,
    bid: 249.5,
    ask: 250.5,
    last: 250,
    bidSize: 100,
    askSize: 100,
    ts: NOW.getTime() - 1_000,
    src: "TIINGO_RT",
    session: "rth",
    ...over,
  });
}

function mkBar(symbol: string, close: number, dayOffset: number): CandleBar {
  return {
    symbol,
    exchange: "NASDAQ",
    timeframe: "D1",
    ts: new Date(NOW.getTime() - dayOffset * 86_400_000),
    listingId: `${symbol}:NASDAQ:1980-12-12`,
    open: close - 1,
    high: close + 2,
    low: close - 3,
    close,
    volume: 1_000_000,
    divCash: 0,
    splitFactor: 1,
    source: "TIINGO",
  };
}

/** A Redis whose `mget` answers from a fixed key -> JSON map. */
function installRedis(values: Map<string, string>): () => void {
  const client = {
    status: "ready",
    on() {
      return client;
    },
    async mget(...keys: string[]) {
      return keys.map((k) => values.get(k) ?? null);
    },
    async zadd() {
      return 1;
    },
    async zremrangebyscore() {
      return 0;
    },
    async quit() {
      return "OK";
    },
    disconnect() {},
  };
  const previousUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://fake-m1309-resolve:6379";
  __setRedisFactoryForTests(() => client as unknown as Redis);
  resetRedisClient();
  return () => {
    resetRedisClient();
    __setRedisFactoryForTests(null);
    if (previousUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousUrl;
  };
}

/** A bar reader that records every symbol it is asked for. */
function installBars(bars: Map<string, CandleBar[]>): {
  asked: string[];
  uninstall: () => void;
} {
  const asked: string[] = [];
  __setUsEodBarsReaderForTests(async (symbol) => {
    asked.push(symbol);
    return bars.get(symbol) ?? [];
  });
  return { asked, uninstall: () => __setUsEodBarsReaderForTests(null) };
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

/** N symbols with a fresh realtime quote each, and bars for every one. */
function scenario(count: number): { symbols: string[]; asked: string[] } {
  const symbols = Array.from({ length: count }, (_, i) => `SYM${i + 1}`);
  const quotes = new Map(symbols.map((s) => [rtQuoteKey(s), mkRt(s)]));
  const bars = new Map(
    symbols.map((s) => [s, [mkBar(s, 190, 2), mkBar(s, 195, 1)]]),
  );
  cleanup.push(installRedis(quotes));
  const barHarness = installBars(bars);
  cleanup.push(barHarness.uninstall);
  return { symbols, asked: barHarness.asked };
}

describe("resolveUsQuotes — the EOD fan-out cap (MONEY-1309 follow-up)", () => {
  it("[meta] the seams are reached — a small batch resolves for real", async () => {
    // Ceiling. Every assertion below is about what is MISSING from the result,
    // and a harness that never reached the code would satisfy all of them.
    const { symbols, asked } = scenario(3);
    const { quotes, unresolved } = await resolveUsQuotes(symbols, "NASDAQ", {
      now: NOW,
    });

    assert.equal(quotes.size, 3);
    assert.deepEqual(unresolved, []);
    assert.deepEqual(asked.sort(), ["SYM1", "SYM2", "SYM3"]);
    const q = quotes.get("SYM1");
    assert.ok(q);
    assert.equal(q.price, 250);
    assert.equal(q.provenance.source, "TIINGO_RT");
    assert.equal(q.provenance.fallback, false);
    // The change is measured against a real bar, not against itself.
    assert.equal(q.previousClose, 190);
    assert.notEqual(q.changePercent, 0);
  });

  it("[meta] the cap is smaller than the routes' 50-symbol admission", () => {
    // The whole defect lives in that gap. If the cap ever reaches 50 this file
    // stops testing anything, so fail loudly rather than pass vacuously.
    assert.ok(
      US_EOD_FALLBACK_MAX_SYMBOLS < 50,
      "the cap is no longer below the route admission limit — re-derive this suite",
    );
  });

  it("[regression] a symbol past the cap is UNRESOLVED, never a fabricated 0.00%", async () => {
    const count = US_EOD_FALLBACK_MAX_SYMBOLS + 8;
    const { symbols, asked } = scenario(count);

    const { quotes, unresolved } = await resolveUsQuotes(symbols, "NASDAQ", {
      now: NOW,
    });

    // The bar read really was truncated — otherwise the rest proves nothing.
    assert.equal(asked.length, US_EOD_FALLBACK_MAX_SYMBOLS);

    const surplus = symbols.slice(US_EOD_FALLBACK_MAX_SYMBOLS);
    assert.equal(surplus.length, 8);
    for (const symbol of surplus) {
      assert.equal(
        quotes.has(symbol),
        false,
        `${symbol} was served past the fan-out cap. It has a fresh realtime ` +
          "price and NO bar, so its change, OHLC and volume would all be the " +
          "quote price echoed back — a flat 0.00% badged live.",
      );
    }
    assert.deepEqual(
      unresolved,
      surplus,
      "truncation must surface in the field every caller already reports " +
        "(apps/api `missing`, apps/web `unresolved`); the old `skippedEod` was " +
        "destructured away at every call site in the repo",
    );
    assert.equal(quotes.size, US_EOD_FALLBACK_MAX_SYMBOLS);
  });

  it("the symbols WITHIN the cap are unaffected by the truncation", async () => {
    const { symbols } = scenario(US_EOD_FALLBACK_MAX_SYMBOLS + 8);
    const { quotes } = await resolveUsQuotes(symbols, "NASDAQ", { now: NOW });

    for (const symbol of symbols.slice(0, US_EOD_FALLBACK_MAX_SYMBOLS)) {
      const q = quotes.get(symbol);
      assert.ok(q, `${symbol} is inside the cap and must resolve`);
      assert.equal(q.provenance.fallback, false);
      assert.equal(q.previousClose, 190);
    }
  });

  it("a non-US venue resolves nothing and reads no store", async () => {
    const { symbols, asked } = scenario(2);
    const { quotes, unresolved } = await resolveUsQuotes(symbols, "NSE", {
      now: NOW,
    });
    assert.equal(quotes.size, 0);
    assert.deepEqual(unresolved, symbols);
    assert.deepEqual(asked, [], "a non-US venue must not fan out to Mongo");
  });

  it("a symbol with a realtime quote but NO history is unresolved, not flat", async () => {
    // The same fabrication reached from the other direction: inside the cap,
    // but the thirty-day window is genuinely empty (a newly listed ticker).
    const quotes = new Map([[rtQuoteKey("NEWCO"), mkRt("NEWCO")]]);
    cleanup.push(installRedis(quotes));
    const bars = installBars(new Map());
    cleanup.push(bars.uninstall);

    const result = await resolveUsQuotes(["NEWCO"], "NASDAQ", { now: NOW });
    assert.deepEqual(
      bars.asked,
      ["NEWCO"],
      "the bar read must have been tried",
    );
    assert.equal(result.quotes.size, 0);
    assert.deepEqual(result.unresolved, ["NEWCO"]);
  });
});
