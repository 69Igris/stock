/**
 * Yahoo Finance API Tests
 *
 * Tests the REAL pure logic extracted from
 *   packages/core/src/market-data/yahoo-api.ts
 * into
 *   packages/core/src/market-data/yahoo-api-logic.ts
 *
 * `yahoo-api.ts` imports and calls every function/constant under test, so this
 * exercises production code (no inline reimplementation, no network).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CRUMB_TTL_MS,
  FETCH_TIMEOUT_MS,
  MAX_RETRIES,
  BACKOFF_BASE_MS,
  QUOTE_BATCH_SIZE,
  YAHOO_USER_AGENT,
  createAuthCache,
  isAuthValid,
  setAuth,
  invalidateAuthCache,
  shouldRetry,
  shouldInvalidateAuth,
  calculateBackoff,
  isWithinMaxRetries,
  splitIntoBatches,
  buildQuoteUrl,
  appendCrumb,
  buildChartUrl,
  buildSearchUrl,
  buildQuoteSummaryUrl,
  isValidQuote,
  filterValidQuotes,
  parseChartBars,
} from "@usemoney/core/market-data/yahoo-api-logic";

describe("Yahoo Finance API (real source)", () => {
  // ────────────────────────────────────────────────────────────────
  // Auth TTL Logic
  // ────────────────────────────────────────────────────────────────
  describe("Auth TTL Logic", () => {
    it("should define CRUMB_TTL_MS as 20 minutes in milliseconds", () => {
      assert.strictEqual(CRUMB_TTL_MS, 20 * 60 * 1000);
      assert.strictEqual(CRUMB_TTL_MS, 1_200_000);
    });

    it("should consider empty auth cache as invalid", () => {
      const cache = createAuthCache();
      assert.strictEqual(isAuthValid(cache, Date.now()), false);
    });

    it("should consider auth valid immediately after setting", () => {
      const cache = createAuthCache();
      const now = Date.now();
      setAuth(cache, "cookie123", "crumb456", now);
      assert.strictEqual(isAuthValid(cache, now), true);
    });

    it("should consider auth valid before TTL expires", () => {
      const cache = createAuthCache();
      const now = Date.now();
      setAuth(cache, "cookie123", "crumb456", now);
      assert.strictEqual(isAuthValid(cache, now + 10 * 60 * 1000), true);
    });

    it("should consider auth valid at 19 minutes", () => {
      const cache = createAuthCache();
      const now = Date.now();
      setAuth(cache, "cookie123", "crumb456", now);
      assert.strictEqual(isAuthValid(cache, now + 19 * 60 * 1000), true);
    });

    it("should consider auth expired at exactly 20 minutes", () => {
      const cache = createAuthCache();
      const now = Date.now();
      setAuth(cache, "cookie123", "crumb456", now);
      assert.strictEqual(isAuthValid(cache, now + CRUMB_TTL_MS), false);
    });

    it("should consider auth expired beyond 20 minutes", () => {
      const cache = createAuthCache();
      const now = Date.now();
      setAuth(cache, "cookie123", "crumb456", now);
      assert.strictEqual(isAuthValid(cache, now + 25 * 60 * 1000), false);
    });

    it("should invalidate auth by clearing cookie, crumb, and expiry", () => {
      const cache = createAuthCache();
      const now = Date.now();
      setAuth(cache, "cookie123", "crumb456", now);
      assert.strictEqual(isAuthValid(cache, now), true);

      invalidateAuthCache(cache);
      assert.strictEqual(cache.cookie, null);
      assert.strictEqual(cache.crumb, null);
      assert.strictEqual(cache.expiry, 0);
      assert.strictEqual(isAuthValid(cache, now), false);
    });

    it("should handle re-setting auth after invalidation", () => {
      const cache = createAuthCache();
      const now = Date.now();
      setAuth(cache, "old-cookie", "old-crumb", now);
      invalidateAuthCache(cache);
      setAuth(cache, "new-cookie", "new-crumb", now + 1000);
      assert.strictEqual(cache.cookie, "new-cookie");
      assert.strictEqual(cache.crumb, "new-crumb");
      assert.strictEqual(isAuthValid(cache, now + 1000), true);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Retry Status Codes
  // ────────────────────────────────────────────────────────────────
  describe("Retry Status Codes", () => {
    it("should retry on 401 (Unauthorized)", () => {
      assert.strictEqual(shouldRetry(401), true);
    });

    it("should retry on 403 (Forbidden)", () => {
      assert.strictEqual(shouldRetry(403), true);
    });

    it("should retry on 429 (Too Many Requests)", () => {
      assert.strictEqual(shouldRetry(429), true);
    });

    it("should retry on 500 (Internal Server Error)", () => {
      assert.strictEqual(shouldRetry(500), true);
    });

    it("should retry on 502 (Bad Gateway)", () => {
      assert.strictEqual(shouldRetry(502), true);
    });

    it("should retry on 503 (Service Unavailable)", () => {
      assert.strictEqual(shouldRetry(503), true);
    });

    it("should retry on 504 (Gateway Timeout)", () => {
      assert.strictEqual(shouldRetry(504), true);
    });

    it("should NOT retry on 200 (OK)", () => {
      assert.strictEqual(shouldRetry(200), false);
    });

    it("should NOT retry on 400 (Bad Request)", () => {
      assert.strictEqual(shouldRetry(400), false);
    });

    it("should NOT retry on 404 (Not Found)", () => {
      assert.strictEqual(shouldRetry(404), false);
    });

    it("should NOT retry on 422 (Unprocessable Entity)", () => {
      assert.strictEqual(shouldRetry(422), false);
    });

    it("should invalidate auth on 401", () => {
      assert.strictEqual(shouldInvalidateAuth(401), true);
    });

    it("should invalidate auth on 403", () => {
      assert.strictEqual(shouldInvalidateAuth(403), true);
    });

    it("should NOT invalidate auth on 429", () => {
      assert.strictEqual(shouldInvalidateAuth(429), false);
    });

    it("should NOT invalidate auth on 500", () => {
      assert.strictEqual(shouldInvalidateAuth(500), false);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Backoff / Delay Logic
  // ────────────────────────────────────────────────────────────────
  describe("Backoff / Delay Logic", () => {
    it("should calculate 1000ms for attempt 0", () => {
      assert.strictEqual(calculateBackoff(0), 1000);
    });

    it("should calculate 2000ms for attempt 1", () => {
      assert.strictEqual(calculateBackoff(1), 2000);
    });

    it("should calculate 4000ms for attempt 2", () => {
      assert.strictEqual(calculateBackoff(2), 4000);
    });

    it("should calculate 8000ms for attempt 3", () => {
      assert.strictEqual(calculateBackoff(3), 8000);
    });

    it("should follow exponential growth pattern", () => {
      for (let i = 0; i < 5; i++) {
        assert.strictEqual(
          calculateBackoff(i),
          BACKOFF_BASE_MS * Math.pow(2, i)
        );
      }
    });

    it("should allow retries for attempts 0, 1, 2 (within MAX_RETRIES=3)", () => {
      assert.strictEqual(isWithinMaxRetries(0), true);
      assert.strictEqual(isWithinMaxRetries(1), true);
      assert.strictEqual(isWithinMaxRetries(2), true);
    });

    it("should NOT allow retry for attempt 3 (at MAX_RETRIES)", () => {
      assert.strictEqual(isWithinMaxRetries(3), false);
    });

    it("should NOT allow retry for attempt 4 (beyond MAX_RETRIES)", () => {
      assert.strictEqual(isWithinMaxRetries(4), false);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Batch Splitting (real QUOTE_BATCH_SIZE = 20 — MONEY-1124)
  // ────────────────────────────────────────────────────────────────
  describe("Batch Splitting", () => {
    it("should define QUOTE_BATCH_SIZE as 20", () => {
      // MONEY-1124: raised from 6. A 50-symbol portfolio used to cost NINE
      // Yahoo round trips (nine retry ladders, nine 429 chances); it now costs
      // three.
      //
      // Not higher: `fetchQuotes` uses Promise.allSettled, so a rejected chunk
      // drops EVERY symbol in it, and that loss is invisible to the user —
      // useLivePositions falls back to the last broker-synced price with
      // dayChange forced to 0, which renders exactly like a live quote. Batch
      // width IS the blast radius of one failed request, so it is capped well
      // below the route's 50-symbol limit on purpose.
      assert.strictEqual(QUOTE_BATCH_SIZE, 20);
      assert.ok(
        QUOTE_BATCH_SIZE <= 25,
        "batch width is the blast radius of a single chunk failure"
      );
    });

    it("should return empty array for empty input", () => {
      assert.strictEqual(splitIntoBatches([]).length, 0);
    });

    it("should return single batch for 1 symbol", () => {
      const batches = splitIntoBatches(["RELIANCE.NS"]);
      assert.strictEqual(batches.length, 1);
      assert.strictEqual(batches[0]!.length, 1);
    });

    it("should return single batch for exactly QUOTE_BATCH_SIZE symbols", () => {
      const symbols = Array.from(
        { length: QUOTE_BATCH_SIZE },
        (_, i) => `SYM${i}.NS`
      );
      const batches = splitIntoBatches(symbols);
      assert.strictEqual(batches.length, 1);
      assert.strictEqual(batches[0]!.length, QUOTE_BATCH_SIZE);
    });

    it("should return 2 batches for QUOTE_BATCH_SIZE+1 symbols", () => {
      const symbols = Array.from(
        { length: QUOTE_BATCH_SIZE + 1 },
        (_, i) => `SYM${i}.NS`
      );
      const batches = splitIntoBatches(symbols);
      assert.strictEqual(batches.length, 2);
      assert.strictEqual(batches[0]!.length, QUOTE_BATCH_SIZE);
      assert.strictEqual(batches[1]!.length, 1);
    });

    it("should split 3*QUOTE_BATCH_SIZE+2 symbols into 4 batches (full,full,full,2)", () => {
      const total = QUOTE_BATCH_SIZE * 3 + 2;
      const symbols = Array.from({ length: total }, (_, i) => `SYM${i}.NS`);
      const batches = splitIntoBatches(symbols);
      assert.strictEqual(batches.length, 4);
      assert.strictEqual(batches[0]!.length, QUOTE_BATCH_SIZE);
      assert.strictEqual(batches[1]!.length, QUOTE_BATCH_SIZE);
      assert.strictEqual(batches[2]!.length, QUOTE_BATCH_SIZE);
      assert.strictEqual(batches[3]!.length, 2);
    });

    it("keeps the route's 50-symbol cap to a handful of upstream calls", () => {
      const symbols = Array.from({ length: 50 }, (_, i) => `SYM${i}.NS`);
      const batches = splitIntoBatches(symbols);
      assert.equal(batches.length, Math.ceil(50 / QUOTE_BATCH_SIZE));
      assert.ok(batches.length <= 3, "50 symbols must not cost nine requests");
    });

    it("should preserve symbol order within batches", () => {
      const batches = splitIntoBatches(["A.NS", "B.NS", "C.NS"]);
      assert.deepStrictEqual(batches[0], ["A.NS", "B.NS", "C.NS"]);
    });

    it("should preserve symbol order across batch boundaries", () => {
      const total = QUOTE_BATCH_SIZE + 2;
      const symbols = Array.from({ length: total }, (_, i) => `SYM${i}`);
      const batches = splitIntoBatches(symbols);
      assert.strictEqual(batches[0]![0], "SYM0");
      assert.strictEqual(
        batches[0]![QUOTE_BATCH_SIZE - 1],
        `SYM${QUOTE_BATCH_SIZE - 1}`
      );
      assert.strictEqual(batches[1]![0], `SYM${QUOTE_BATCH_SIZE}`);
      assert.strictEqual(batches[1]![1], `SYM${QUOTE_BATCH_SIZE + 1}`);
    });

    it("should honor a custom batch size", () => {
      const symbols = Array.from({ length: 100 }, (_, i) => `SYM${i}`);
      const batches = splitIntoBatches(symbols, 40);
      assert.strictEqual(batches.length, 3);
      assert.strictEqual(batches[0]!.length, 40);
      assert.strictEqual(batches[2]!.length, 20);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // URL Construction
  // ────────────────────────────────────────────────────────────────
  describe("URL Construction", () => {
    it("should build quote URL with comma-separated symbols", () => {
      const url = buildQuoteUrl(["RELIANCE.NS", "TCS.NS"]);
      assert.ok(url.includes("RELIANCE.NS"));
      assert.ok(url.includes("TCS.NS"));
      assert.ok(
        url.startsWith(
          "https://query2.finance.yahoo.com/v7/finance/quote?symbols="
        )
      );
    });

    it("should encode special characters in symbols", () => {
      const url = buildQuoteUrl(["M&M.NS"]);
      assert.ok(url.includes("M%26M.NS"));
    });

    it("should append crumb with & when URL already has query params", () => {
      const url = appendCrumb(
        "https://example.com/api?symbols=RELIANCE.NS",
        "test-crumb"
      );
      assert.ok(url.includes("&crumb=test-crumb"));
    });

    it("should append crumb with ? when URL has no query params", () => {
      const url = appendCrumb("https://example.com/api", "test-crumb");
      assert.ok(url.includes("?crumb=test-crumb"));
    });

    it("should encode crumb value in URL", () => {
      const url = appendCrumb("https://example.com/api", "crumb with spaces");
      assert.ok(url.includes("crumb%20with%20spaces"));
    });

    it("should build chart URL with Unix timestamps", () => {
      const p1 = new Date("2025-01-01T00:00:00Z");
      const p2 = new Date("2025-01-31T00:00:00Z");
      const url = buildChartUrl("RELIANCE.NS", p1, p2);
      assert.ok(url.includes("period1="));
      assert.ok(url.includes("period2="));
      assert.ok(url.includes("interval=1d"));
      assert.ok(url.includes("RELIANCE.NS"));
    });

    it("should build chart URL with custom interval", () => {
      const p1 = new Date("2025-01-01T00:00:00Z");
      const p2 = new Date("2025-01-31T00:00:00Z");
      const url = buildChartUrl("TCS.NS", p1, p2, "1wk");
      assert.ok(url.includes("interval=1wk"));
    });

    it("should build search URL with encoded query", () => {
      const url = buildSearchUrl("Reliance Industries");
      assert.ok(url.includes("q=Reliance%20Industries"));
      assert.ok(url.includes("quotesCount=10"));
      assert.ok(url.includes("newsCount=0"));
    });

    it("should build search URL with custom quotesCount", () => {
      const url = buildSearchUrl("TCS", 5);
      assert.ok(url.includes("quotesCount=5"));
    });

    it("should build quote summary URL with modules", () => {
      const url = buildQuoteSummaryUrl("RELIANCE.NS", [
        "assetProfile",
        "summaryDetail",
      ]);
      assert.ok(url.includes("RELIANCE.NS"));
      assert.ok(url.includes("modules=assetProfile,summaryDetail"));
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Quote Filtering & Validation
  // ────────────────────────────────────────────────────────────────
  describe("Quote Filtering & Validation", () => {
    it("should accept a quote with valid symbol and price", () => {
      assert.strictEqual(
        isValidQuote({ symbol: "RELIANCE.NS", regularMarketPrice: 2500 }),
        true
      );
    });

    it("should accept a quote with price of 0", () => {
      assert.strictEqual(
        isValidQuote({ symbol: "RELIANCE.NS", regularMarketPrice: 0 }),
        true
      );
    });

    it("should reject a quote without symbol", () => {
      assert.strictEqual(isValidQuote({ regularMarketPrice: 2500 }), false);
    });

    it("should reject a quote with empty symbol", () => {
      assert.strictEqual(
        isValidQuote({ symbol: "", regularMarketPrice: 2500 }),
        false
      );
    });

    it("should reject a quote without price", () => {
      assert.strictEqual(isValidQuote({ symbol: "RELIANCE.NS" }), false);
    });

    it("should reject a quote with undefined price", () => {
      assert.strictEqual(
        isValidQuote({ symbol: "RELIANCE.NS", regularMarketPrice: undefined }),
        false
      );
    });

    it("should filter valid quotes from mixed array", () => {
      const filtered = filterValidQuotes([
        { symbol: "RELIANCE.NS", regularMarketPrice: 2500 },
        { symbol: "", regularMarketPrice: 100 },
        { symbol: "TCS.NS", regularMarketPrice: 3500 },
        { regularMarketPrice: 200 },
        { symbol: "INFY.NS" },
      ]);
      assert.strictEqual(filtered.size, 2);
      assert.ok(filtered.has("RELIANCE.NS"));
      assert.ok(filtered.has("TCS.NS"));
    });

    it("should return empty map for all-invalid quotes", () => {
      const filtered = filterValidQuotes([
        { symbol: "" },
        { regularMarketPrice: 100 },
      ]);
      assert.strictEqual(filtered.size, 0);
    });

    it("should return empty map for empty array", () => {
      assert.strictEqual(filterValidQuotes([]).size, 0);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Chart Bar Parsing
  // ────────────────────────────────────────────────────────────────
  describe("Chart Bar Parsing", () => {
    it("should parse valid chart data into bars", () => {
      const bars = parseChartBars([1704067200], {
        open: [100],
        high: [110],
        low: [90],
        close: [105],
        volume: [1000000],
      });
      assert.strictEqual(bars.length, 1);
      assert.strictEqual(bars[0]!.open, 100);
      assert.strictEqual(bars[0]!.high, 110);
      assert.strictEqual(bars[0]!.low, 90);
      assert.strictEqual(bars[0]!.close, 105);
      assert.strictEqual(bars[0]!.volume, 1000000);
    });

    it("should skip bars with null open", () => {
      const bars = parseChartBars([1704067200, 1704153600], {
        open: [null, 100],
        high: [null, 110],
        low: [null, 90],
        close: [null, 105],
        volume: [null, 1000000],
      });
      assert.strictEqual(bars.length, 1);
      assert.strictEqual(bars[0]!.open, 100);
    });

    it("should skip bars with null close", () => {
      const bars = parseChartBars([1704067200], {
        open: [100],
        high: [110],
        low: [90],
        close: [null],
        volume: [1000000],
      });
      assert.strictEqual(bars.length, 0);
    });

    it("should use open as fallback for null high", () => {
      const bars = parseChartBars([1704067200], {
        open: [100],
        high: [null],
        low: [90],
        close: [105],
        volume: [1000000],
      });
      assert.strictEqual(bars[0]!.high, 100);
    });

    it("should use open as fallback for null low", () => {
      const bars = parseChartBars([1704067200], {
        open: [100],
        high: [110],
        low: [null],
        close: [105],
        volume: [1000000],
      });
      assert.strictEqual(bars[0]!.low, 100);
    });

    it("should use 0 as fallback for null volume", () => {
      const bars = parseChartBars([1704067200], {
        open: [100],
        high: [110],
        low: [90],
        close: [105],
        volume: [null],
      });
      assert.strictEqual(bars[0]!.volume, 0);
    });

    it("should handle empty timestamps array", () => {
      assert.strictEqual(parseChartBars([], { open: [], close: [] }).length, 0);
    });

    it("should convert Unix timestamps to JavaScript Dates", () => {
      const timestamp = 1704067200;
      const bars = parseChartBars([timestamp], {
        open: [100],
        high: [110],
        low: [90],
        close: [105],
        volume: [1000],
      });
      assert.strictEqual(bars[0]!.date.getTime(), timestamp * 1000);
    });

    it("should parse multiple bars correctly", () => {
      const bars = parseChartBars([1704067200, 1704153600, 1704240000], {
        open: [100, 105, 110],
        high: [110, 115, 120],
        low: [90, 95, 100],
        close: [105, 110, 115],
        volume: [1000000, 2000000, 3000000],
      });
      assert.strictEqual(bars.length, 3);
      assert.strictEqual(bars[0]!.close, 105);
      assert.strictEqual(bars[1]!.close, 110);
      assert.strictEqual(bars[2]!.close, 115);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Constants & Configuration
  // ────────────────────────────────────────────────────────────────
  describe("Constants & Configuration", () => {
    it("should define FETCH_TIMEOUT_MS as 15 seconds", () => {
      assert.strictEqual(FETCH_TIMEOUT_MS, 15_000);
    });

    it("should define MAX_RETRIES as 3", () => {
      assert.strictEqual(MAX_RETRIES, 3);
    });

    it("should define BACKOFF_BASE_MS as 1000", () => {
      assert.strictEqual(BACKOFF_BASE_MS, 1000);
    });

    it("should have a Chrome-like User-Agent string", () => {
      assert.ok(YAHOO_USER_AGENT.includes("Chrome"));
      assert.ok(YAHOO_USER_AGENT.includes("Mozilla"));
      assert.ok(YAHOO_USER_AGENT.includes("Windows NT"));
    });
  });
});
