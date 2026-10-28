/**
 * Yahoo Client Helper Tests
 *
 * De-shadowed: imports the REAL helpers from lib/market/yahoo-client-logic.ts
 * (extracted from yahoo-client.ts, which imports them) instead of inlining
 * extractSymbol / extractExchange / mapExchange / rawQuoteToQuoteData /
 * getPeriodStartDate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { YahooRawQuote } from "@usemoney/core/market-data";

import {
  extractSymbol,
  extractExchange,
  mapExchange,
  rawQuoteToQuoteData,
  getPeriodStartDate,
  type Period,
} from "@/lib/market/yahoo-client-logic";

// ── Tests ───────────────────────────────────────────────────────

describe("Yahoo Client Helpers", () => {
  describe("extractSymbol", () => {
    it("should extract symbol from NSE Yahoo format", () => {
      assert.strictEqual(extractSymbol("RELIANCE.NS"), "RELIANCE");
    });

    it("should extract symbol from BSE Yahoo format", () => {
      assert.strictEqual(extractSymbol("RELIANCE.BO"), "RELIANCE");
    });

    it("should preserve index symbols starting with ^", () => {
      assert.strictEqual(extractSymbol("^NSEI"), "^NSEI");
      assert.strictEqual(extractSymbol("^BSESN"), "^BSESN");
      assert.strictEqual(extractSymbol("^NSEBANK"), "^NSEBANK");
    });

    it("should return plain symbol unchanged", () => {
      assert.strictEqual(extractSymbol("RELIANCE"), "RELIANCE");
    });

    it("should handle symbols with hyphens", () => {
      assert.strictEqual(extractSymbol("HDFC-BE.NS"), "HDFC-BE");
    });

    it("should handle symbols with special characters", () => {
      assert.strictEqual(extractSymbol("M&M.NS"), "M&M");
    });

    it("should not strip .NS/.BO from middle of symbol", () => {
      // Edge case: .NS only stripped at end
      assert.strictEqual(extractSymbol("NS.NS"), "NS");
    });
  });

  describe("extractExchange", () => {
    it("should return NSE for .NS suffix", () => {
      assert.strictEqual(extractExchange("RELIANCE.NS"), "NSE");
    });

    it("should return BSE for .BO suffix", () => {
      assert.strictEqual(extractExchange("RELIANCE.BO"), "BSE");
    });

    it("should return NSE for NIFTY index", () => {
      assert.strictEqual(extractExchange("^NSEI"), "NSE");
    });

    it("should return NSE for BANK NIFTY index", () => {
      assert.strictEqual(extractExchange("^NSEBANK"), "NSE");
    });

    it("should return BSE for SENSEX index", () => {
      assert.strictEqual(extractExchange("^BSESN"), "BSE");
    });

    it("should default to NSE for unknown symbols", () => {
      assert.strictEqual(extractExchange("RELIANCE"), "NSE");
      assert.strictEqual(extractExchange("^UNKNOWN"), "NSE");
    });
  });

  describe("mapExchange", () => {
    it("should map NSI to NSE", () => {
      assert.strictEqual(mapExchange("NSI"), "NSE");
    });

    it("should map NSE to NSE", () => {
      assert.strictEqual(mapExchange("NSE"), "NSE");
    });

    it("should map BSE to BSE", () => {
      assert.strictEqual(mapExchange("BSE"), "BSE");
    });

    it("should map BOM to BSE", () => {
      assert.strictEqual(mapExchange("BOM"), "BSE");
    });

    it("should return unknown exchange code as-is", () => {
      assert.strictEqual(mapExchange("NYSE"), "NYSE");
      assert.strictEqual(mapExchange("NASDAQ"), "NASDAQ");
    });

    it("should handle empty string", () => {
      assert.strictEqual(mapExchange(""), "");
    });
  });

  describe("rawQuoteToQuoteData", () => {
    it("should transform a complete Yahoo quote", () => {
      const raw: YahooRawQuote = {
        symbol: "RELIANCE.NS",
        shortName: "Reliance Ind",
        longName: "Reliance Industries Limited",
        regularMarketPrice: 2500,
        regularMarketChange: 50,
        regularMarketChangePercent: 2.04,
        regularMarketOpen: 2480,
        regularMarketDayHigh: 2520,
        regularMarketDayLow: 2470,
        regularMarketPreviousClose: 2450,
        regularMarketVolume: 5000000,
        regularMarketTime: 1705372800,
        marketCap: 17_000_000_000_000,
        trailingPE: 28.5,
        epsTrailingTwelveMonths: 87.72,
        fiftyTwoWeekHigh: 3000,
        fiftyTwoWeekLow: 2200,
      };

      const result = rawQuoteToQuoteData("RELIANCE.NS", raw);

      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.exchange, "NSE");
      assert.strictEqual(result.name, "Reliance Ind");
      assert.strictEqual(result.price, 2500);
      assert.strictEqual(result.change, 50);
      assert.strictEqual(result.changePercent, 2.04);
      assert.strictEqual(result.open, 2480);
      assert.strictEqual(result.high, 2520);
      assert.strictEqual(result.low, 2470);
      assert.strictEqual(result.previousClose, 2450);
      assert.strictEqual(result.volume, 5000000);
      assert.strictEqual(result.marketCap, 17_000_000_000_000);
      assert.strictEqual(result.pe, 28.5);
      assert.strictEqual(result.eps, 87.72);
      assert.strictEqual(result.week52High, 3000);
      assert.strictEqual(result.week52Low, 2200);
    });

    it("should use shortName over longName", () => {
      const raw: YahooRawQuote = {
        symbol: "TCS.NS",
        shortName: "TCS Ltd",
        longName: "Tata Consultancy Services Limited",
        regularMarketPrice: 3500,
      };

      const result = rawQuoteToQuoteData("TCS.NS", raw);
      assert.strictEqual(result.name, "TCS Ltd");
    });

    it("should fall back to longName when shortName is missing", () => {
      const raw: YahooRawQuote = {
        symbol: "TCS.NS",
        longName: "Tata Consultancy Services Limited",
        regularMarketPrice: 3500,
      };

      const result = rawQuoteToQuoteData("TCS.NS", raw);
      assert.strictEqual(result.name, "Tata Consultancy Services Limited");
    });

    it("should fall back to yahooSymbol when both names are missing", () => {
      const raw: YahooRawQuote = {
        symbol: "TCS.NS",
        regularMarketPrice: 3500,
      };

      const result = rawQuoteToQuoteData("TCS.NS", raw);
      assert.strictEqual(result.name, "TCS.NS");
    });

    it("should zero out change when previousClose is 0 (bogus change)", () => {
      const raw: YahooRawQuote = {
        symbol: "TEST.NS",
        regularMarketPrice: 100,
        regularMarketChange: 100,
        regularMarketChangePercent: 100,
        regularMarketPreviousClose: 0,
      };

      const result = rawQuoteToQuoteData("TEST.NS", raw);
      assert.strictEqual(result.change, 0);
      assert.strictEqual(result.changePercent, 0);
    });

    it("should allow negative change when previousClose > 0", () => {
      const raw: YahooRawQuote = {
        symbol: "TEST.NS",
        regularMarketPrice: 90,
        regularMarketChange: -10,
        regularMarketChangePercent: -10,
        regularMarketPreviousClose: 100,
      };

      const result = rawQuoteToQuoteData("TEST.NS", raw);
      assert.strictEqual(result.change, -10);
      assert.strictEqual(result.changePercent, -10);
    });

    it("should default missing optional fields to 0", () => {
      const raw: YahooRawQuote = {
        symbol: "TEST.NS",
        regularMarketPrice: 100,
      };

      const result = rawQuoteToQuoteData("TEST.NS", raw);
      assert.strictEqual(result.change, 0);
      assert.strictEqual(result.changePercent, 0);
      assert.strictEqual(result.open, 0);
      assert.strictEqual(result.high, 0);
      assert.strictEqual(result.low, 0);
      assert.strictEqual(result.previousClose, 0);
      assert.strictEqual(result.volume, 0);
    });

    it("should convert regularMarketTime to Date", () => {
      const timestamp = 1705372800; // 2024-01-16T00:00:00Z
      const raw: YahooRawQuote = {
        symbol: "TEST.NS",
        regularMarketPrice: 100,
        regularMarketTime: timestamp,
      };

      const result = rawQuoteToQuoteData("TEST.NS", raw);
      assert.strictEqual(result.timestamp.getTime(), timestamp * 1000);
    });

    it("should use current date when regularMarketTime is missing", () => {
      const raw: YahooRawQuote = {
        symbol: "TEST.NS",
        regularMarketPrice: 100,
      };

      const before = Date.now();
      const result = rawQuoteToQuoteData("TEST.NS", raw);
      const after = Date.now();

      assert.ok(result.timestamp.getTime() >= before);
      assert.ok(result.timestamp.getTime() <= after);
    });

    it("should handle BSE symbol correctly", () => {
      const raw: YahooRawQuote = {
        symbol: "RELIANCE.BO",
        regularMarketPrice: 2500,
      };

      const result = rawQuoteToQuoteData("RELIANCE.BO", raw);
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.exchange, "BSE");
    });

    it("should handle index symbol correctly", () => {
      const raw: YahooRawQuote = {
        symbol: "^NSEI",
        regularMarketPrice: 22000,
      };

      const result = rawQuoteToQuoteData("^NSEI", raw);
      assert.strictEqual(result.symbol, "^NSEI");
      assert.strictEqual(result.exchange, "NSE");
    });
  });

  describe("getPeriodStartDate", () => {
    it("should return 1 day ago for '1d'", () => {
      const now = new Date();
      const result = getPeriodStartDate("1d");
      const expected = new Date(now);
      expected.setDate(now.getDate() - 1);

      // Allow 1s tolerance for test execution time
      assert.ok(
        Math.abs(result.getTime() - expected.getTime()) < 1000,
        "1d period should be ~1 day ago"
      );
    });

    it("should return 5 days ago for '5d'", () => {
      const now = new Date();
      const result = getPeriodStartDate("5d");
      const diffMs = now.getTime() - result.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      assert.ok(diffDays >= 4.9 && diffDays <= 5.1);
    });

    it("should return ~1 month ago for '1mo'", () => {
      const now = new Date();
      const result = getPeriodStartDate("1mo");
      const diffMs = now.getTime() - result.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      assert.ok(diffDays >= 28 && diffDays <= 31);
    });

    it("should return ~3 months ago for '3mo'", () => {
      const now = new Date();
      const result = getPeriodStartDate("3mo");
      const diffMs = now.getTime() - result.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      assert.ok(diffDays >= 88 && diffDays <= 93);
    });

    it("should return ~6 months ago for '6mo'", () => {
      const now = new Date();
      const result = getPeriodStartDate("6mo");
      const diffMs = now.getTime() - result.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      assert.ok(diffDays >= 180 && diffDays <= 186);
    });

    it("should return ~1 year ago for '1y'", () => {
      const now = new Date();
      const result = getPeriodStartDate("1y");
      const diffMs = now.getTime() - result.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      assert.ok(diffDays >= 364 && diffDays <= 367);
    });

    it("should return ~2 years ago for '2y'", () => {
      const now = new Date();
      const result = getPeriodStartDate("2y");
      assert.strictEqual(result.getFullYear(), now.getFullYear() - 2);
    });

    it("should return ~5 years ago for '5y'", () => {
      const now = new Date();
      const result = getPeriodStartDate("5y");
      assert.strictEqual(result.getFullYear(), now.getFullYear() - 5);
    });

    it("should return ~10 years ago for '10y'", () => {
      const now = new Date();
      const result = getPeriodStartDate("10y");
      assert.strictEqual(result.getFullYear(), now.getFullYear() - 10);
    });

    it("should return January 1 of current year for 'ytd'", () => {
      const result = getPeriodStartDate("ytd");
      assert.strictEqual(result.getMonth(), 0); // January
      assert.strictEqual(result.getDate(), 1);
      assert.strictEqual(result.getFullYear(), new Date().getFullYear());
    });

    it("should return 1970 for 'max'", () => {
      const result = getPeriodStartDate("max");
      assert.strictEqual(result.getFullYear(), 1970);
    });

    it("should return Date object for all periods", () => {
      const periods: Period[] = [
        "1d",
        "5d",
        "1mo",
        "3mo",
        "6mo",
        "1y",
        "2y",
        "5y",
        "10y",
        "ytd",
        "max",
      ];
      for (const period of periods) {
        const result = getPeriodStartDate(period);
        assert.ok(result instanceof Date, `${period} should return a Date`);
        assert.ok(
          !isNaN(result.getTime()),
          `${period} should return a valid Date`
        );
      }
    });

    it("should return dates in the past (before now)", () => {
      const now = new Date();
      const periods: Period[] = [
        "1d",
        "5d",
        "1mo",
        "3mo",
        "6mo",
        "1y",
        "2y",
        "5y",
        "10y",
        "ytd",
        "max",
      ];
      for (const period of periods) {
        const result = getPeriodStartDate(period);
        assert.ok(result < now, `${period} should return a date before now`);
      }
    });
  });
});
