/**
 * CONTRACT TEST — Yahoo Finance quote + chart wire format.
 *
 * Pins the EXTERNAL response contract of Yahoo Finance as parsed by the REAL
 * transforms in packages/core/src/market-data/yahoo-api.ts:
 *   - `fetchQuotes`  → GET /v7/finance/quote   → Map<symbol, YahooRawQuote>
 *   - `fetchChart`   → GET /v8/finance/chart/…  → ChartBar[]
 *
 * These are the live-price + OHLCV transforms behind dashboard prices, paper
 * trading, and the price-sync worker. If Yahoo's nested response shape drifts
 * (or our parsing of it does), prices silently go stale or wrong.
 *
 * This is NOT a shadow: it imports and executes the real exported `fetchQuotes`
 * / `fetchChart` and feeds them RECORDED Yahoo payloads via undici `MockAgent`.
 * It pins the contract on BOTH the happy path AND the documented edge cases the
 * transforms explicitly handle:
 *   - chart bars whose open/close are null are DROPPED;
 *   - chart high/low fall back to `open`, volume falls back to `0`;
 *   - a chart `error` object yields an empty array (no throw);
 *   - a quote row with a missing `regularMarketPrice` is SKIPPED, not emitted;
 *   - a 5xx on the data call surfaces as an empty result (fetchChart) — never
 *     an escaped network call (NetConnect is disabled) — AND the swallowed
 *     error is reported through the optional `onError` observer (MONEY-1060
 *     RC4: default behavior unchanged; the observer is the only way callers
 *     can distinguish an outage from a genuine empty response).
 *
 * Yahoo gates every data call behind a cookie+crumb handshake; `stubYahooAuth`
 * intercepts both auth hops so the real `getAuth()` path runs without network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fetchChart, fetchQuotes } from "../../src/market-data/yahoo-api";
import { installMockAgent, stubYahooAuth } from "../_contracts/mock-agent";

const YAHOO_ORIGIN = "https://query2.finance.yahoo.com";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "_contracts",
  "__fixtures__",
);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

describe("CONTRACT: Yahoo chart (GET /v8/finance/chart)", () => {
  it("normalizes a recorded chart payload into ChartBar[] and drops null open/close rows", async () => {
    const mock = installMockAgent();
    try {
      stubYahooAuth(mock);
      const chart = mock.interceptJson({
        origin: YAHOO_ORIGIN,
        // crumb is appended as a query param, so match the path prefix.
        path: /^\/v8\/finance\/chart\/RELIANCE\.NS/,
        method: "GET",
        body: loadFixture("yahoo-chart-reliance.json"),
        persist: true,
      });

      const bars = await fetchChart("RELIANCE.NS", {
        period1: new Date("2024-06-13T00:00:00Z"),
        period2: new Date("2024-06-16T00:00:00Z"),
        interval: "1d",
      });

      // Fixture has 4 timestamps: bar[2] has close=null (dropped on the
      // null-close branch) and bar[3] has open=null (dropped on the null-open
      // branch). Only the 2 fully-priced bars survive.
      assert.equal(bars.length, 2);

      // Bar 0: all fields present, passed through verbatim.
      assert.equal(bars[0]!.open, 1390.0);
      assert.equal(bars[0]!.high, 1408.0);
      assert.equal(bars[0]!.low, 1385.5);
      assert.equal(bars[0]!.close, 1402.5);
      assert.equal(bars[0]!.volume, 5123456);
      // Timestamp 1718245800s → 2024-06-13T02:30:00Z (NSE 09:00 IST open).
      assert.equal(bars[0]!.date.toISOString(), "2024-06-13T02:30:00.000Z");

      // Bar 1: present.
      assert.equal(bars[1]!.open, 1401.1);
      assert.equal(bars[1]!.close, 1405.25);
      assert.equal(bars[1]!.volume, 4987000);
      assert.equal(bars[1]!.date.toISOString(), "2024-06-14T02:30:00.000Z");

      // Neither dropped row leaks through: bar[3]'s close (1409.0) and bar[2]'s
      // open (1404.0) must be absent, and no bar may carry the dropped
      // timestamps (1718418600 = bar[2], 1718505000 = bar[3]).
      assert.equal(
        bars.some((b) => b.close === 1409.0 || b.open === 1404.0),
        false,
      );
      const survivingTs = bars.map((b) => Math.floor(b.date.getTime() / 1000));
      assert.deepEqual(survivingTs, [1718245800, 1718332200]);

      // Control for the 5xx test's attempt-count assertion: this call passes NO
      // `backoffBaseMs`, so it runs on production defaults — and a 200 must cost
      // exactly ONE request, never a retry.
      assert.equal(chart.calls.length, 1, "a 200 is not retried");
    } finally {
      await mock.close();
    }
  });

  it("falls back high/low→open and volume→0 when those fields are null but open+close exist", async () => {
    const mock = installMockAgent();
    try {
      stubYahooAuth(mock);
      // A single-bar payload where high/low/volume are null but open+close are
      // present — the transform must keep the bar and apply its fallbacks.
      mock.interceptJson({
        origin: YAHOO_ORIGIN,
        path: /^\/v8\/finance\/chart\/FALLBK\.NS/,
        method: "GET",
        body: {
          chart: {
            result: [
              {
                timestamp: [1718245800],
                indicators: {
                  quote: [
                    {
                      open: [100.5],
                      high: [null],
                      low: [null],
                      close: [101.25],
                      volume: [null],
                    },
                  ],
                },
              },
            ],
            error: null,
          },
        },
        persist: true,
      });

      const bars = await fetchChart("FALLBK.NS", {
        period1: new Date("2024-06-13T00:00:00Z"),
        period2: new Date("2024-06-14T00:00:00Z"),
      });

      assert.equal(bars.length, 1);
      assert.equal(bars[0]!.open, 100.5);
      assert.equal(bars[0]!.close, 101.25);
      // high/low default to open; volume defaults to 0.
      assert.equal(bars[0]!.high, 100.5);
      assert.equal(bars[0]!.low, 100.5);
      assert.equal(bars[0]!.volume, 0);
    } finally {
      await mock.close();
    }
  });

  it("returns [] (no throw) when the chart payload carries an error object", async () => {
    const mock = installMockAgent();
    try {
      stubYahooAuth(mock);
      mock.interceptJson({
        origin: YAHOO_ORIGIN,
        path: /^\/v8\/finance\/chart\/DELISTED\.NS/,
        method: "GET",
        body: loadFixture("yahoo-chart-error.json"),
        persist: true,
      });

      // MONEY-1060: a parsed error-object payload is a GENUINE empty (Yahoo
      // answered "no such data"), NOT a transport outage — the onError
      // observer must stay silent so callers don't misread it as "source down".
      const observed: unknown[] = [];
      const bars = await fetchChart(
        "DELISTED.NS",
        {
          period1: new Date("2024-06-13T00:00:00Z"),
          period2: new Date("2024-06-14T00:00:00Z"),
        },
        { onError: (error) => observed.push(error) },
      );

      assert.deepEqual(bars, []);
      assert.equal(observed.length, 0, "no swallow-catch → no onError");
    } finally {
      await mock.close();
    }
  });

  it("returns [] (no throw) on a 5xx data response — never escapes to the network — and reports via onError", async () => {
    const mock = installMockAgent();
    try {
      stubYahooAuth(mock);
      const chart = mock.interceptJson({
        origin: YAHOO_ORIGIN,
        path: /^\/v8\/finance\/chart\/SRVERR\.NS/,
        method: "GET",
        statusCode: 503,
        body: {},
        persist: true,
      });

      const observed: Array<{ error: unknown; context?: string }> = [];
      const bars = await fetchChart(
        "SRVERR.NS",
        {
          period1: new Date("2024-06-13T00:00:00Z"),
          period2: new Date("2024-06-14T00:00:00Z"),
        },
        {
          onError: (error, context) => observed.push({ error, context }),
          // Rescale the retry ladder, do NOT shorten it. This test drives the
          // real exponential backoff (BACKOFF_BASE_MS 1s → 2s → 4s), which cost
          // 7.0s of REAL `sleep()` — ~78% of this package's suite runtime, and
          // close enough to the 30s wall-clock `--test-timeout` that CI
          // contention could CANCEL the file (0 failures reported, nothing
          // run). `backoffBaseMs: 1` keeps every attempt, every retry decision
          // and every `sleep()` call, and pays 1+2+4ms instead of 1+2+4s.
          // The attempt-count assertion below is what stops that saving from
          // silently degrading into "it stopped retrying".
          backoffBaseMs: 1,
        },
      );

      // yahooFetch exhausts retries against the mocked 503, then fetchChart's
      // catch swallows the thrown error → empty array. MONEY-1060: the
      // swallowed error is handed to the onError observer first, so callers
      // (research tools' sourceError plumbing) can tell outage from gap.
      assert.deepEqual(bars, []);
      assert.equal(observed.length, 1);
      assert.match(
        String((observed[0]!.error as Error).message),
        /503/,
        "the swallowed transport error is observable",
      );
      assert.match(observed[0]!.context ?? "", /fetchChart:SRVERR\.NS/);

      // The retry chain itself is part of the contract: MAX_RETRIES = 3 means
      // 1 initial attempt + 3 retries = 4 requests actually put on the wire
      // before yahooFetch gives up. Asserting the mock's call count pins that
      // independently of how long the backoff waits, so a future "make it
      // faster" change cannot quietly buy speed by retrying less.
      assert.equal(
        chart.calls.length,
        4,
        "1 initial attempt + MAX_RETRIES(3) retries reached the wire",
      );
    } finally {
      await mock.close();
    }
  });
});

describe("CONTRACT: Yahoo quote (GET /v7/finance/quote)", () => {
  it("normalizes a recorded quote payload into Map<symbol, YahooRawQuote> and skips missing-price rows", async () => {
    const mock = installMockAgent();
    try {
      stubYahooAuth(mock);
      mock.interceptJson({
        origin: YAHOO_ORIGIN,
        path: /^\/v7\/finance\/quote/,
        method: "GET",
        body: loadFixture("yahoo-quote-reliance.json"),
        persist: true,
      });

      const quotes = await fetchQuotes(["RELIANCE.NS", "DELISTED.NS"]);

      // The recorded payload has 2 rows; DELISTED has no regularMarketPrice and
      // MUST be skipped, so exactly 1 entry survives, keyed by symbol.
      assert.equal(quotes.size, 1);
      assert.equal(quotes.has("DELISTED.NS"), false);

      const reliance = quotes.get("RELIANCE.NS");
      assert.ok(reliance);
      assert.equal(reliance.symbol, "RELIANCE.NS");
      assert.equal(reliance.regularMarketPrice, 1402.5);
      assert.equal(reliance.regularMarketChange, 12.3);
      assert.equal(reliance.regularMarketChangePercent, 0.885);
      assert.equal(reliance.regularMarketPreviousClose, 1390.2);
      assert.equal(reliance.regularMarketVolume, 5123456);
      assert.equal(reliance.shortName, "Reliance Industries");
      assert.equal(reliance.exchange, "NSI");
    } finally {
      await mock.close();
    }
  });

  it("returns an empty Map when Yahoo replies 200 with an empty result array", async () => {
    const mock = installMockAgent();
    try {
      stubYahooAuth(mock);
      // A valid 200 whose quoteResponse.result is empty (Yahoo's response when
      // it resolves no quotes) → an empty Map, no throw. Pins the no-rows parse
      // path without incurring the retry backoff a 5xx would.
      mock.interceptJson({
        origin: YAHOO_ORIGIN,
        path: /^\/v7\/finance\/quote/,
        method: "GET",
        body: { quoteResponse: { result: [], error: null } },
        persist: true,
      });

      const quotes = await fetchQuotes(["RELIANCE.NS"]);
      assert.equal(quotes.size, 0);
    } finally {
      await mock.close();
    }
  });
});
