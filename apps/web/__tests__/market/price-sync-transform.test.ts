/**
 * Price Sync Transformation Tests
 *
 * Tests the Yahoo quote-to-YahooQuoteData transformation logic
 * in the price sync processor, including bogus change detection
 * when previousClose=0.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Inline types (mirrors price-sync.ts / yahoo-api.ts) ─────────

interface YahooRawQuote {
  symbol: string;
  shortName?: string;
  longName?: string;
  regularMarketPrice: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketPreviousClose?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number;
  marketCap?: number;
}

interface YahooQuoteData {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number;
  marketCap?: number;
  timestamp: Date;
}

// ── Inline transformation (mirrors fetchYahooBatchQuotes logic) ──

function transformRawQuote(
  symbol: string,
  quote: YahooRawQuote
): YahooQuoteData {
  const prevClose = quote.regularMarketPreviousClose ?? 0;
  const hasBogusChange = prevClose === 0 && quote.regularMarketPrice > 0;

  return {
    symbol,
    price: quote.regularMarketPrice,
    change: hasBogusChange ? 0 : (quote.regularMarketChange ?? 0),
    changePercent: hasBogusChange ? 0 : (quote.regularMarketChangePercent ?? 0),
    open: quote.regularMarketOpen ?? 0,
    high: quote.regularMarketDayHigh ?? 0,
    low: quote.regularMarketDayLow ?? 0,
    previousClose: prevClose,
    volume: quote.regularMarketVolume ?? 0,
    marketCap: quote.marketCap,
    timestamp:
      typeof quote.regularMarketTime === "number"
        ? new Date(quote.regularMarketTime * 1000)
        : new Date(),
  };
}

/**
 * Mirrors the filtering + transformation in fetchYahooBatchQuotes.
 */
function transformBatchQuotes(
  rawQuotes: Map<string, YahooRawQuote>
): Map<string, YahooQuoteData> {
  const results = new Map<string, YahooQuoteData>();

  rawQuotes.forEach((quote, symbol) => {
    results.set(symbol, transformRawQuote(symbol, quote));
  });

  return results;
}

// ── Tests ────────────────────────────────────────────────────────

describe("Price Sync - Quote Transformation", () => {
  describe("Bogus Change Detection", () => {
    it("should zero out change when previousClose is 0 and price > 0", () => {
      const quote: YahooRawQuote = {
        symbol: "NEWSTOCK.NS",
        regularMarketPrice: 150,
        regularMarketPreviousClose: 0,
        regularMarketChange: 150,
        regularMarketChangePercent: 100,
      };

      const result = transformRawQuote("NEWSTOCK.NS", quote);
      assert.strictEqual(result.change, 0);
      assert.strictEqual(result.changePercent, 0);
      assert.strictEqual(result.price, 150);
      assert.strictEqual(result.previousClose, 0);
    });

    it("should zero out change when previousClose is missing (undefined)", () => {
      const quote: YahooRawQuote = {
        symbol: "NEWIPO.NS",
        regularMarketPrice: 200,
        // no regularMarketPreviousClose
        regularMarketChange: 200,
        regularMarketChangePercent: 100,
      };

      const result = transformRawQuote("NEWIPO.NS", quote);
      assert.strictEqual(result.change, 0);
      assert.strictEqual(result.changePercent, 0);
    });

    it("should preserve change when previousClose is valid", () => {
      const quote: YahooRawQuote = {
        symbol: "RELIANCE.NS",
        regularMarketPrice: 2550,
        regularMarketPreviousClose: 2500,
        regularMarketChange: 50,
        regularMarketChangePercent: 2.0,
      };

      const result = transformRawQuote("RELIANCE.NS", quote);
      assert.strictEqual(result.change, 50);
      assert.strictEqual(result.changePercent, 2.0);
    });

    it("should preserve negative change when previousClose is valid", () => {
      const quote: YahooRawQuote = {
        symbol: "TCS.NS",
        regularMarketPrice: 3400,
        regularMarketPreviousClose: 3500,
        regularMarketChange: -100,
        regularMarketChangePercent: -2.86,
      };

      const result = transformRawQuote("TCS.NS", quote);
      assert.strictEqual(result.change, -100);
      assert.strictEqual(result.changePercent, -2.86);
    });

    it("should not flag bogus change when both price and previousClose are 0", () => {
      const quote: YahooRawQuote = {
        symbol: "DEFUNCT.NS",
        regularMarketPrice: 0,
        regularMarketPreviousClose: 0,
        regularMarketChange: 0,
        regularMarketChangePercent: 0,
      };

      const result = transformRawQuote("DEFUNCT.NS", quote);
      // hasBogusChange = prevClose === 0 && price > 0 → false (price is 0)
      assert.strictEqual(result.change, 0);
      assert.strictEqual(result.changePercent, 0);
    });
  });

  describe("Field Defaults", () => {
    it("should default open to 0 when missing", () => {
      const quote: YahooRawQuote = {
        symbol: "TEST.NS",
        regularMarketPrice: 100,
        regularMarketPreviousClose: 95,
      };

      const result = transformRawQuote("TEST.NS", quote);
      assert.strictEqual(result.open, 0);
    });

    it("should default high to 0 when missing", () => {
      const quote: YahooRawQuote = {
        symbol: "TEST.NS",
        regularMarketPrice: 100,
        regularMarketPreviousClose: 95,
      };

      const result = transformRawQuote("TEST.NS", quote);
      assert.strictEqual(result.high, 0);
    });

    it("should default low to 0 when missing", () => {
      const quote: YahooRawQuote = {
        symbol: "TEST.NS",
        regularMarketPrice: 100,
        regularMarketPreviousClose: 95,
      };

      const result = transformRawQuote("TEST.NS", quote);
      assert.strictEqual(result.low, 0);
    });

    it("should default volume to 0 when missing", () => {
      const quote: YahooRawQuote = {
        symbol: "TEST.NS",
        regularMarketPrice: 100,
        regularMarketPreviousClose: 95,
      };

      const result = transformRawQuote("TEST.NS", quote);
      assert.strictEqual(result.volume, 0);
    });

    it("should default change to 0 when missing", () => {
      const quote: YahooRawQuote = {
        symbol: "TEST.NS",
        regularMarketPrice: 100,
        regularMarketPreviousClose: 95,
      };

      const result = transformRawQuote("TEST.NS", quote);
      assert.strictEqual(result.change, 0);
    });

    it("should default changePercent to 0 when missing", () => {
      const quote: YahooRawQuote = {
        symbol: "TEST.NS",
        regularMarketPrice: 100,
        regularMarketPreviousClose: 95,
      };

      const result = transformRawQuote("TEST.NS", quote);
      assert.strictEqual(result.changePercent, 0);
    });

    it("should pass through marketCap when present", () => {
      const quote: YahooRawQuote = {
        symbol: "RELIANCE.NS",
        regularMarketPrice: 2500,
        regularMarketPreviousClose: 2450,
        marketCap: 17_000_000_000_000,
      };

      const result = transformRawQuote("RELIANCE.NS", quote);
      assert.strictEqual(result.marketCap, 17_000_000_000_000);
    });

    it("should leave marketCap undefined when missing", () => {
      const quote: YahooRawQuote = {
        symbol: "TEST.NS",
        regularMarketPrice: 100,
        regularMarketPreviousClose: 95,
      };

      const result = transformRawQuote("TEST.NS", quote);
      assert.strictEqual(result.marketCap, undefined);
    });
  });

  describe("Timestamp Conversion", () => {
    it("should convert Unix seconds to Date", () => {
      const unixTime = 1706787600; // some Unix timestamp
      const quote: YahooRawQuote = {
        symbol: "TEST.NS",
        regularMarketPrice: 100,
        regularMarketPreviousClose: 95,
        regularMarketTime: unixTime,
      };

      const result = transformRawQuote("TEST.NS", quote);
      assert.strictEqual(result.timestamp.getTime(), unixTime * 1000);
    });

    it("should use current time when regularMarketTime is missing", () => {
      const before = Date.now();
      const quote: YahooRawQuote = {
        symbol: "TEST.NS",
        regularMarketPrice: 100,
        regularMarketPreviousClose: 95,
      };

      const result = transformRawQuote("TEST.NS", quote);
      const after = Date.now();

      assert.ok(result.timestamp.getTime() >= before);
      assert.ok(result.timestamp.getTime() <= after);
    });
  });

  describe("Complete Quote Transformation", () => {
    it("should map all fields correctly from a full quote", () => {
      const quote: YahooRawQuote = {
        symbol: "INFY.NS",
        regularMarketPrice: 1500,
        regularMarketChange: 25,
        regularMarketChangePercent: 1.69,
        regularMarketOpen: 1480,
        regularMarketDayHigh: 1510,
        regularMarketDayLow: 1475,
        regularMarketPreviousClose: 1475,
        regularMarketVolume: 5_000_000,
        regularMarketTime: 1706787600,
        marketCap: 6_200_000_000_000,
      };

      const result = transformRawQuote("INFY.NS", quote);

      assert.strictEqual(result.symbol, "INFY.NS");
      assert.strictEqual(result.price, 1500);
      assert.strictEqual(result.change, 25);
      assert.strictEqual(result.changePercent, 1.69);
      assert.strictEqual(result.open, 1480);
      assert.strictEqual(result.high, 1510);
      assert.strictEqual(result.low, 1475);
      assert.strictEqual(result.previousClose, 1475);
      assert.strictEqual(result.volume, 5_000_000);
      assert.strictEqual(result.marketCap, 6_200_000_000_000);
      assert.strictEqual(result.timestamp.getTime(), 1706787600 * 1000);
    });
  });

  describe("Batch Transformation", () => {
    it("should transform multiple quotes", () => {
      const rawQuotes = new Map<string, YahooRawQuote>();
      rawQuotes.set("RELIANCE.NS", {
        symbol: "RELIANCE.NS",
        regularMarketPrice: 2500,
        regularMarketPreviousClose: 2450,
        regularMarketChange: 50,
        regularMarketChangePercent: 2.04,
      });
      rawQuotes.set("TCS.NS", {
        symbol: "TCS.NS",
        regularMarketPrice: 3500,
        regularMarketPreviousClose: 3400,
        regularMarketChange: 100,
        regularMarketChangePercent: 2.94,
      });

      const results = transformBatchQuotes(rawQuotes);

      assert.strictEqual(results.size, 2);
      assert.ok(results.has("RELIANCE.NS"));
      assert.ok(results.has("TCS.NS"));
      assert.strictEqual(results.get("RELIANCE.NS")!.price, 2500);
      assert.strictEqual(results.get("TCS.NS")!.price, 3500);
    });

    it("should handle empty map", () => {
      const results = transformBatchQuotes(new Map());
      assert.strictEqual(results.size, 0);
    });

    it("should apply bogus change detection across batch", () => {
      const rawQuotes = new Map<string, YahooRawQuote>();
      rawQuotes.set("GOOD.NS", {
        symbol: "GOOD.NS",
        regularMarketPrice: 100,
        regularMarketPreviousClose: 95,
        regularMarketChange: 5,
        regularMarketChangePercent: 5.26,
      });
      rawQuotes.set("BOGUS.NS", {
        symbol: "BOGUS.NS",
        regularMarketPrice: 100,
        regularMarketPreviousClose: 0,
        regularMarketChange: 100,
        regularMarketChangePercent: 100,
      });

      const results = transformBatchQuotes(rawQuotes);

      // Good quote preserves change
      assert.strictEqual(results.get("GOOD.NS")!.change, 5);
      assert.strictEqual(results.get("GOOD.NS")!.changePercent, 5.26);

      // Bogus quote has change zeroed
      assert.strictEqual(results.get("BOGUS.NS")!.change, 0);
      assert.strictEqual(results.get("BOGUS.NS")!.changePercent, 0);
      assert.strictEqual(results.get("BOGUS.NS")!.price, 100); // price preserved
    });
  });
});
