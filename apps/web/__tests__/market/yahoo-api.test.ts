/**
 * Yahoo Finance REST API Tests
 *
 * Tests for data parsing and transformation logic in the Yahoo Finance
 * REST API client. Tests the chart bar parser, quote filtering,
 * and search result extraction without making HTTP calls.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { YahooRawQuote } from "@usemoney/core/market-data";

// De-shadowed: import the REAL response parsers from yahoo-api-logic
// (the envelope parsers that yahoo-api.ts's fetchChart/fetchSearch/
// fetchQuoteSummary now call). `filterValidQuotes` is the real name for
// what this test calls `filterQuotes`.
import {
  parseChartResponse,
  filterValidQuotes as filterQuotes,
  parseSearchResponse,
  parseQuoteSummaryResponse,
} from "@usemoney/core/market-data/yahoo-api-logic";

// ── Tests ───────────────────────────────────────────────────────

describe("Yahoo Finance API - Data Parsing", () => {
  describe("Chart Response Parser", () => {
    it("should parse valid chart response with complete data", () => {
      const json = {
        chart: {
          result: [
            {
              timestamp: [1705286400, 1705372800, 1705459200],
              indicators: {
                quote: [
                  {
                    open: [100, 105, 103],
                    high: [108, 110, 107],
                    low: [98, 102, 100],
                    close: [105, 103, 106],
                    volume: [50000, 60000, 55000],
                  },
                ],
              },
            },
          ],
        },
      };

      const bars = parseChartResponse(json);
      assert.strictEqual(bars.length, 3);

      assert.strictEqual(bars[0].open, 100);
      assert.strictEqual(bars[0].high, 108);
      assert.strictEqual(bars[0].low, 98);
      assert.strictEqual(bars[0].close, 105);
      assert.strictEqual(bars[0].volume, 50000);
      assert.ok(bars[0].date instanceof Date);
      assert.strictEqual(bars[0].date.getTime(), 1705286400 * 1000);
    });

    it("should skip bars with null open", () => {
      const json = {
        chart: {
          result: [
            {
              timestamp: [1705286400, 1705372800],
              indicators: {
                quote: [
                  {
                    open: [null, 105],
                    high: [108, 110],
                    low: [98, 102],
                    close: [105, 103],
                    volume: [50000, 60000],
                  },
                ],
              },
            },
          ],
        },
      };

      const bars = parseChartResponse(json);
      assert.strictEqual(bars.length, 1);
      assert.strictEqual(bars[0].open, 105);
    });

    it("should skip bars with null close", () => {
      const json = {
        chart: {
          result: [
            {
              timestamp: [1705286400, 1705372800],
              indicators: {
                quote: [
                  {
                    open: [100, 105],
                    high: [108, 110],
                    low: [98, 102],
                    close: [null, 103],
                    volume: [50000, 60000],
                  },
                ],
              },
            },
          ],
        },
      };

      const bars = parseChartResponse(json);
      assert.strictEqual(bars.length, 1);
      assert.strictEqual(bars[0].close, 103);
    });

    it("should use open as fallback for null high/low", () => {
      const json = {
        chart: {
          result: [
            {
              timestamp: [1705286400],
              indicators: {
                quote: [
                  {
                    open: [100],
                    high: [null],
                    low: [null],
                    close: [105],
                    volume: [50000],
                  },
                ],
              },
            },
          ],
        },
      };

      const bars = parseChartResponse(json);
      assert.strictEqual(bars.length, 1);
      assert.strictEqual(bars[0].high, 100); // falls back to open
      assert.strictEqual(bars[0].low, 100); // falls back to open
    });

    it("should default volume to 0 when null", () => {
      const json = {
        chart: {
          result: [
            {
              timestamp: [1705286400],
              indicators: {
                quote: [
                  {
                    open: [100],
                    high: [108],
                    low: [98],
                    close: [105],
                    volume: [null],
                  },
                ],
              },
            },
          ],
        },
      };

      const bars = parseChartResponse(json);
      assert.strictEqual(bars[0].volume, 0);
    });

    it("should return empty array for chart error response", () => {
      const json = {
        chart: {
          error: { code: "Not Found", description: "No data found" },
        },
      };

      const bars = parseChartResponse(json);
      assert.strictEqual(bars.length, 0);
    });

    it("should return empty array for missing timestamps", () => {
      const json = {
        chart: {
          result: [
            {
              indicators: {
                quote: [
                  {
                    open: [100],
                    close: [105],
                  },
                ],
              },
            },
          ],
        },
      };

      const bars = parseChartResponse(json);
      assert.strictEqual(bars.length, 0);
    });

    it("should return empty array for missing quote indicators", () => {
      const json = {
        chart: {
          result: [
            {
              timestamp: [1705286400],
              indicators: {},
            },
          ],
        },
      };

      const bars = parseChartResponse(json);
      assert.strictEqual(bars.length, 0);
    });

    it("should return empty array for null/undefined json", () => {
      assert.strictEqual(parseChartResponse({}).length, 0);
      assert.strictEqual(
        parseChartResponse({ chart: undefined } as unknown as Parameters<
          typeof parseChartResponse
        >[0]).length,
        0
      );
    });

    it("should return empty array when result array is empty", () => {
      const json = { chart: { result: [] } };
      const bars = parseChartResponse(json);
      assert.strictEqual(bars.length, 0);
    });
  });

  describe("Quote Filtering", () => {
    it("should accept valid quotes with symbol and price", () => {
      const quotes: YahooRawQuote[] = [
        { symbol: "RELIANCE.NS", regularMarketPrice: 2500 },
        { symbol: "TCS.NS", regularMarketPrice: 3500 },
      ];

      const result = filterQuotes(quotes);
      assert.strictEqual(result.size, 2);
      assert.ok(result.has("RELIANCE.NS"));
      assert.ok(result.has("TCS.NS"));
    });

    it("should skip quotes with missing symbol", () => {
      const quotes: YahooRawQuote[] = [
        { symbol: "", regularMarketPrice: 2500 },
        { symbol: "TCS.NS", regularMarketPrice: 3500 },
      ];

      const result = filterQuotes(quotes);
      assert.strictEqual(result.size, 1);
      assert.ok(result.has("TCS.NS"));
    });

    it("should skip quotes with null regularMarketPrice", () => {
      const quotes = [
        {
          symbol: "RELIANCE.NS",
          regularMarketPrice: null as unknown as number,
        },
        { symbol: "TCS.NS", regularMarketPrice: 3500 },
      ];

      const result = filterQuotes(quotes as YahooRawQuote[]);
      assert.strictEqual(result.size, 1);
      assert.ok(result.has("TCS.NS"));
    });

    it("should accept quotes with price of 0", () => {
      const quotes: YahooRawQuote[] = [
        { symbol: "TEST.NS", regularMarketPrice: 0 },
      ];

      const result = filterQuotes(quotes);
      assert.strictEqual(result.size, 1);
    });

    it("should handle empty array", () => {
      const result = filterQuotes([]);
      assert.strictEqual(result.size, 0);
    });

    it("should preserve all quote fields", () => {
      const quotes: YahooRawQuote[] = [
        {
          symbol: "RELIANCE.NS",
          shortName: "Reliance Industries",
          longName: "Reliance Industries Limited",
          regularMarketPrice: 2500,
          regularMarketChange: 50,
          regularMarketChangePercent: 2.04,
          regularMarketOpen: 2480,
          regularMarketDayHigh: 2520,
          regularMarketDayLow: 2470,
          regularMarketPreviousClose: 2450,
          regularMarketVolume: 5000000,
          marketCap: 17_000_000_000_000,
          trailingPE: 28.5,
          fiftyTwoWeekHigh: 3000,
          fiftyTwoWeekLow: 2200,
        },
      ];

      const result = filterQuotes(quotes);
      const q = result.get("RELIANCE.NS")!;
      assert.strictEqual(q.shortName, "Reliance Industries");
      assert.strictEqual(q.regularMarketChange, 50);
      assert.strictEqual(q.marketCap, 17_000_000_000_000);
      assert.strictEqual(q.fiftyTwoWeekHigh, 3000);
    });

    it("should skip quotes where both symbol and price are missing", () => {
      const quotes = [
        { symbol: "", regularMarketPrice: null as unknown as number },
      ];

      const result = filterQuotes(quotes as YahooRawQuote[]);
      assert.strictEqual(result.size, 0);
    });
  });

  describe("Search Response Parser", () => {
    it("should parse search results", () => {
      const json = {
        quotes: [
          {
            symbol: "RELIANCE.NS",
            shortname: "Reliance Ind",
            longname: "Reliance Industries Limited",
            exchange: "NSI",
            quoteType: "EQUITY",
          },
          {
            symbol: "RELIANCE.BO",
            shortname: "Reliance Ind",
            exchange: "BSE",
            quoteType: "EQUITY",
          },
        ],
      };

      const results = parseSearchResponse(json);
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].symbol, "RELIANCE.NS");
      assert.strictEqual(results[1].symbol, "RELIANCE.BO");
    });

    it("should return empty array for missing quotes", () => {
      const results = parseSearchResponse({});
      assert.strictEqual(results.length, 0);
    });

    it("should return empty array for null quotes", () => {
      const results = parseSearchResponse({ quotes: undefined });
      assert.strictEqual(results.length, 0);
    });

    it("should handle empty quotes array", () => {
      const results = parseSearchResponse({ quotes: [] });
      assert.strictEqual(results.length, 0);
    });
  });

  describe("QuoteSummary Response Parser", () => {
    it("should extract first result from quoteSummary", () => {
      const json = {
        quoteSummary: {
          result: [
            {
              assetProfile: {
                sector: "Technology",
                industry: "Software - Infrastructure",
              },
            },
          ],
        },
      };

      const result = parseQuoteSummaryResponse(json);
      assert.ok(result);
      const profile = result.assetProfile as {
        sector: string;
        industry: string;
      };
      assert.strictEqual(profile.sector, "Technology");
      assert.strictEqual(profile.industry, "Software - Infrastructure");
    });

    it("should return null for missing quoteSummary", () => {
      const result = parseQuoteSummaryResponse({});
      assert.strictEqual(result, null);
    });

    it("should return null for empty result array", () => {
      const result = parseQuoteSummaryResponse({
        quoteSummary: { result: [] },
      });
      assert.strictEqual(result, null);
    });

    it("should return null for missing result", () => {
      const result = parseQuoteSummaryResponse({
        quoteSummary: { result: undefined },
      });
      assert.strictEqual(result, null);
    });
  });

  describe("URL Construction", () => {
    /**
     * Mirrors crumb URL append logic from yahooFetch
     */
    function appendCrumb(url: string, crumb: string): string {
      const separator = url.includes("?") ? "&" : "?";
      return `${url}${separator}crumb=${encodeURIComponent(crumb)}`;
    }

    it("should append crumb with ? for URL without query params", () => {
      const url = appendCrumb(
        "https://query2.finance.yahoo.com/v7/finance/quote",
        "abc123"
      );
      assert.strictEqual(
        url,
        "https://query2.finance.yahoo.com/v7/finance/quote?crumb=abc123"
      );
    });

    it("should append crumb with & for URL with existing query params", () => {
      const url = appendCrumb(
        "https://query2.finance.yahoo.com/v7/finance/quote?symbols=RELIANCE.NS",
        "abc123"
      );
      assert.ok(url.includes("&crumb=abc123"));
    });

    it("should encode special characters in crumb", () => {
      const url = appendCrumb(
        "https://query2.finance.yahoo.com/v7/finance/quote",
        "abc/123+xyz"
      );
      assert.ok(url.includes("crumb=abc%2F123%2Bxyz"));
    });
  });

  describe("Chart Timestamp Conversion", () => {
    it("should convert Unix seconds to Date objects", () => {
      const unixSeconds = 1705276800; // 2024-01-15T00:00:00Z
      const date = new Date(unixSeconds * 1000);
      assert.strictEqual(date.toISOString(), "2024-01-15T00:00:00.000Z");
    });

    it("should handle period1/period2 conversion from Date to Unix", () => {
      const date = new Date("2024-01-15T00:00:00Z");
      const unix = Math.floor(date.getTime() / 1000);
      assert.strictEqual(unix, 1705276800);
    });
  });
});
