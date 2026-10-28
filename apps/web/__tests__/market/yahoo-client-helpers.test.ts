/**
 * Yahoo Client Helper Function Tests
 *
 * Tests for the pure utility functions in yahoo-client.ts:
 * - extractSymbol: strips .NS/.BO suffix
 * - extractExchange: determines exchange from Yahoo symbol
 * - mapExchange: maps Yahoo exchange codes to standard names
 * - getPeriodStartDate: calculates start date from period string
 * - rawQuoteToQuoteData: transforms YahooRawQuote to QuoteData
 * - INDIAN_INDICES: constant index mappings
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { YahooRawQuote } from "@usemoney/core/market-data";

// De-shadowed: import the REAL helpers + INDIAN_INDICES constant from
// lib/market/yahoo-client-logic.ts (extracted from yahoo-client.ts, which
// imports/re-exports them).
import {
  extractSymbol,
  extractExchange,
  mapExchange,
  getPeriodStartDate,
  rawQuoteToQuoteData,
  INDIAN_INDICES,
  type Period,
} from "@/lib/market/yahoo-client-logic";

// ── Tests ────────────────────────────────────────────────────────

describe("Yahoo Client Helper Functions", () => {
  describe("extractSymbol", () => {
    it("should strip .NS suffix", () => {
      assert.strictEqual(extractSymbol("RELIANCE.NS"), "RELIANCE");
    });

    it("should strip .BO suffix", () => {
      assert.strictEqual(extractSymbol("TCS.BO"), "TCS");
    });

    it("should keep index symbols as-is", () => {
      assert.strictEqual(extractSymbol("^NSEI"), "^NSEI");
    });

    it("should keep ^BSESN as-is", () => {
      assert.strictEqual(extractSymbol("^BSESN"), "^BSESN");
    });

    it("should handle symbols with hyphens", () => {
      assert.strictEqual(extractSymbol("KESORAMIND-BE.NS"), "KESORAMIND-BE");
    });

    it("should handle M&M", () => {
      assert.strictEqual(extractSymbol("M&M.NS"), "M&M");
    });

    it("should not strip .NS if it's part of the symbol name", () => {
      // Shouldn't happen in practice, but regex is anchored to end
      assert.strictEqual(extractSymbol("SOMENS"), "SOMENS");
    });

    it("should handle plain symbol without suffix", () => {
      assert.strictEqual(extractSymbol("RELIANCE"), "RELIANCE");
    });
  });

  describe("extractExchange", () => {
    it("should return NSE for .NS suffix", () => {
      assert.strictEqual(extractExchange("RELIANCE.NS"), "NSE");
    });

    it("should return BSE for .BO suffix", () => {
      assert.strictEqual(extractExchange("TCS.BO"), "BSE");
    });

    it("should return NSE for ^NSEI", () => {
      assert.strictEqual(extractExchange("^NSEI"), "NSE");
    });

    it("should return NSE for ^NSEBANK", () => {
      assert.strictEqual(extractExchange("^NSEBANK"), "NSE");
    });

    it("should return BSE for ^BSESN", () => {
      assert.strictEqual(extractExchange("^BSESN"), "BSE");
    });

    it("should default to NSE for unknown index", () => {
      assert.strictEqual(extractExchange("^CNXIT"), "NSE");
    });

    it("should default to NSE for plain symbol", () => {
      assert.strictEqual(extractExchange("RELIANCE"), "NSE");
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

    it("should return unknown exchange as-is", () => {
      assert.strictEqual(mapExchange("NASDAQ"), "NASDAQ");
    });

    it("should return empty string as-is", () => {
      assert.strictEqual(mapExchange(""), "");
    });
  });

  describe("getPeriodStartDate", () => {
    /**
     * Assert a date is `months` months before now, tolerating month-length rollover.
     *
     * `setMonth(getMonth() - 6)` on 2026-08-29 yields 2026-03-01, not February:
     * Feb 29 does not exist in a non-leap year, so JS rolls forward. The three
     * assertions below asserted an exact month index and therefore FAILED on real
     * calendar days — 2026-08-29 among them — while the function was behaving
     * exactly as `Date` specifies.
     *
     * A latent date bug that fires on a handful of days a year is worse than a
     * loud one: it reads as a regression from whatever landed that morning. So
     * assert the property the function actually has — "about `months` months
     * back" — rather than an arithmetic identity `Date` never promised.
     */
    function assertMonthsAgo(result: Date, months: number): void {
      const now = new Date();
      const naive = new Date(now);
      naive.setMonth(now.getMonth() - months);

      const elapsedDays = (now.getTime() - result.getTime()) / 86_400_000;
      const lo = months * 28 - 1;
      const hi = months * 31 + 1;
      assert.ok(
        elapsedDays >= lo && elapsedDays <= hi,
        `expected ~${months} months back (${lo}-${hi} days), got ${elapsedDays.toFixed(1)}`
      );

      // And it must be the month `Date` itself lands on, so this stays a real
      // assertion rather than a wide range that any wrong answer would satisfy.
      assert.strictEqual(
        result.getMonth(),
        naive.getMonth(),
        `month index disagrees with Date's own ${months}-month arithmetic`
      );
    }

    it("should return 1 day ago for '1d'", () => {
      const now = new Date();
      const result = getPeriodStartDate("1d");
      const expectedDay = new Date(now);
      expectedDay.setDate(now.getDate() - 1);

      assert.strictEqual(result.getDate(), expectedDay.getDate());
    });

    it("should return 5 days ago for '5d'", () => {
      const now = new Date();
      const result = getPeriodStartDate("5d");
      const diff = now.getTime() - result.getTime();
      const daysDiff = diff / (1000 * 60 * 60 * 24);

      assert.ok(daysDiff >= 4.9 && daysDiff <= 5.1);
    });

    it("should return 1 month ago for '1mo'", () => {
      const result = getPeriodStartDate("1mo");

      assertMonthsAgo(result, 1);
    });

    it("should return 3 months ago for '3mo'", () => {
      const result = getPeriodStartDate("3mo");

      assertMonthsAgo(result, 3);
    });

    it("should return 6 months ago for '6mo'", () => {
      const result = getPeriodStartDate("6mo");

      assertMonthsAgo(result, 6);
    });

    it("should return 1 year ago for '1y'", () => {
      const now = new Date();
      const result = getPeriodStartDate("1y");

      assert.strictEqual(result.getFullYear(), now.getFullYear() - 1);
    });

    it("should return 2 years ago for '2y'", () => {
      const now = new Date();
      const result = getPeriodStartDate("2y");

      assert.strictEqual(result.getFullYear(), now.getFullYear() - 2);
    });

    it("should return 5 years ago for '5y'", () => {
      const now = new Date();
      const result = getPeriodStartDate("5y");

      assert.strictEqual(result.getFullYear(), now.getFullYear() - 5);
    });

    it("should return 10 years ago for '10y'", () => {
      const now = new Date();
      const result = getPeriodStartDate("10y");

      assert.strictEqual(result.getFullYear(), now.getFullYear() - 10);
    });

    it("should return Jan 1 of current year for 'ytd'", () => {
      const result = getPeriodStartDate("ytd");

      assert.strictEqual(result.getMonth(), 0);
      assert.strictEqual(result.getDate(), 1);
      assert.strictEqual(result.getFullYear(), new Date().getFullYear());
    });

    it("should return 1970 for 'max'", () => {
      const result = getPeriodStartDate("max");

      assert.strictEqual(result.getFullYear(), 1970);
    });

    it("should return a Date object", () => {
      const result = getPeriodStartDate("1mo");
      assert.ok(result instanceof Date);
    });

    it("should return a date in the past (not future)", () => {
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
        assert.ok(
          result.getTime() <= Date.now(),
          `${period} should return a past date`
        );
      }
    });
  });

  describe("rawQuoteToQuoteData", () => {
    it("should map all fields from a complete quote", () => {
      const quote: YahooRawQuote = {
        symbol: "RELIANCE.NS",
        shortName: "Reliance Industries",
        regularMarketPrice: 2500,
        regularMarketChange: 50,
        regularMarketChangePercent: 2.04,
        regularMarketOpen: 2460,
        regularMarketDayHigh: 2510,
        regularMarketDayLow: 2450,
        regularMarketPreviousClose: 2450,
        regularMarketVolume: 10_000_000,
        regularMarketTime: 1706787600,
        marketCap: 17_000_000_000_000,
        trailingPE: 25.5,
        epsTrailingTwelveMonths: 98.04,
        fiftyTwoWeekHigh: 2800,
        fiftyTwoWeekLow: 2100,
      };

      const result = rawQuoteToQuoteData("RELIANCE.NS", quote);

      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.exchange, "NSE");
      assert.strictEqual(result.name, "Reliance Industries");
      assert.strictEqual(result.price, 2500);
      assert.strictEqual(result.change, 50);
      assert.strictEqual(result.changePercent, 2.04);
      assert.strictEqual(result.open, 2460);
      assert.strictEqual(result.high, 2510);
      assert.strictEqual(result.low, 2450);
      assert.strictEqual(result.previousClose, 2450);
      assert.strictEqual(result.volume, 10_000_000);
      assert.strictEqual(result.marketCap, 17_000_000_000_000);
      assert.strictEqual(result.pe, 25.5);
      assert.strictEqual(result.eps, 98.04);
      assert.strictEqual(result.week52High, 2800);
      assert.strictEqual(result.week52Low, 2100);
    });

    it("REGRESSION: drops a 52-week range that cannot contain the previous close (MONEY-1198)", () => {
      // Reported live on LAPL.BO, 2026-08-14. Yahoo returned a "52-week" range
      // that was in fact today's DAY range, with its HIGH sitting BELOW last
      // night's close:
      //
      //   52W HIGH   125.00   <- below prev close
      //   52W LOW    121.88   <- exactly today's open
      //   PREV CLOSE 128.29
      //
      // Read literally that says the stock did not reach, in a year, a price it
      // closed at yesterday. LAPL is recently listed, so Yahoo has almost no
      // history and its 52-week fields collapse onto the current session.
      //
      // The check is CONTAINMENT, not plausibility: a real 52-week window holds
      // every price the stock has traded at. "High and low are close together"
      // would be the wrong test — it would reject a legitimately quiet stock.
      const quote: YahooRawQuote = {
        symbol: "LAPL.BO",
        regularMarketPrice: 121.88,
        regularMarketPreviousClose: 128.29,
        regularMarketOpen: 121.88,
        regularMarketDayHigh: 125.0,
        regularMarketDayLow: 121.88,
        fiftyTwoWeekHigh: 125.0,
        fiftyTwoWeekLow: 121.88,
      };

      const result = rawQuoteToQuoteData("LAPL.BO", quote);

      // Omitted, NOT clamped or widened — widening would invent a high the
      // stock never traded at. The UI renders a missing metric as "—", which is
      // an honest "we could not establish this".
      assert.strictEqual(result.week52High, undefined);
      assert.strictEqual(result.week52Low, undefined);

      // Everything else on the quote must survive: the guard is scoped to the
      // two 52-week fields and must not blank a usable quote.
      assert.strictEqual(result.price, 121.88);
      assert.strictEqual(result.previousClose, 128.29);
      assert.strictEqual(result.symbol, "LAPL");
      assert.strictEqual(result.exchange, "BSE");
    });

    it("keeps a 52-week range that DOES contain price and previous close", () => {
      // The control for the regression above. Without this, "always return
      // undefined" would pass that test — and silently delete the metric for
      // every stock on the platform.
      const quote: YahooRawQuote = {
        symbol: "ACME.NS",
        regularMarketPrice: 150,
        regularMarketPreviousClose: 148,
        fiftyTwoWeekHigh: 200,
        fiftyTwoWeekLow: 100,
      };

      const result = rawQuoteToQuoteData("ACME.NS", quote);
      assert.strictEqual(result.week52High, 200);
      assert.strictEqual(result.week52Low, 100);
    });

    it("drops an inverted range (high < low) even when it contains the price", () => {
      // A transposed pair still 'contains' nothing coherent; ordering is part
      // of the range being real.
      const quote: YahooRawQuote = {
        symbol: "ACME.NS",
        regularMarketPrice: 150,
        regularMarketPreviousClose: 148,
        fiftyTwoWeekHigh: 100,
        fiftyTwoWeekLow: 200,
      };

      const result = rawQuoteToQuoteData("ACME.NS", quote);
      assert.strictEqual(result.week52High, undefined);
      assert.strictEqual(result.week52Low, undefined);
    });

    it("ignores a zero/absent previousClose rather than failing the range on it", () => {
      // A fresh listing reports previousClose 0 (the `hasBogusChange` case
      // directly below). Zero must not be treated as a price the window has to
      // contain, or every IPO would lose its 52-week metrics as a side effect.
      const quote: YahooRawQuote = {
        symbol: "NEWIPO.NS",
        regularMarketPrice: 200,
        regularMarketPreviousClose: 0,
        fiftyTwoWeekHigh: 250,
        fiftyTwoWeekLow: 180,
      };

      const result = rawQuoteToQuoteData("NEWIPO.NS", quote);
      assert.strictEqual(result.week52High, 250);
      assert.strictEqual(result.week52Low, 180);
    });

    it("should zero out change when previousClose is 0 (bogus change)", () => {
      const quote: YahooRawQuote = {
        symbol: "NEWIPO.NS",
        regularMarketPrice: 200,
        regularMarketPreviousClose: 0,
        regularMarketChange: 200,
        regularMarketChangePercent: 100,
      };

      const result = rawQuoteToQuoteData("NEWIPO.NS", quote);
      assert.strictEqual(result.change, 0);
      assert.strictEqual(result.changePercent, 0);
      assert.strictEqual(result.price, 200);
    });

    it("should zero out change when previousClose is undefined", () => {
      const quote: YahooRawQuote = {
        symbol: "NEWIPO.NS",
        regularMarketPrice: 200,
        regularMarketChange: 200,
        regularMarketChangePercent: 100,
      };

      const result = rawQuoteToQuoteData("NEWIPO.NS", quote);
      assert.strictEqual(result.change, 0);
      assert.strictEqual(result.changePercent, 0);
    });

    it("should use longName when shortName is missing", () => {
      const quote: YahooRawQuote = {
        symbol: "TCS.NS",
        longName: "Tata Consultancy Services Limited",
        regularMarketPrice: 3500,
        regularMarketPreviousClose: 3400,
      };

      const result = rawQuoteToQuoteData("TCS.NS", quote);
      assert.strictEqual(result.name, "Tata Consultancy Services Limited");
    });

    it("should fall back to yahooSymbol when both names missing", () => {
      const quote: YahooRawQuote = {
        symbol: "UNKNOWN.NS",
        regularMarketPrice: 100,
        regularMarketPreviousClose: 95,
      };

      const result = rawQuoteToQuoteData("UNKNOWN.NS", quote);
      assert.strictEqual(result.name, "UNKNOWN.NS");
    });

    it("should convert regularMarketTime to Date", () => {
      const unixTime = 1706787600;
      const quote: YahooRawQuote = {
        symbol: "TCS.NS",
        regularMarketPrice: 3500,
        regularMarketPreviousClose: 3400,
        regularMarketTime: unixTime,
      };

      const result = rawQuoteToQuoteData("TCS.NS", quote);
      assert.strictEqual(result.timestamp.getTime(), unixTime * 1000);
    });

    it("should use current time when regularMarketTime is missing", () => {
      const before = Date.now();
      const quote: YahooRawQuote = {
        symbol: "TCS.NS",
        regularMarketPrice: 3500,
        regularMarketPreviousClose: 3400,
      };

      const result = rawQuoteToQuoteData("TCS.NS", quote);
      const after = Date.now();

      assert.ok(result.timestamp.getTime() >= before);
      assert.ok(result.timestamp.getTime() <= after);
    });

    it("should extract BSE exchange from .BO symbol", () => {
      const quote: YahooRawQuote = {
        symbol: "RELIANCE.BO",
        regularMarketPrice: 2500,
        regularMarketPreviousClose: 2450,
      };

      const result = rawQuoteToQuoteData("RELIANCE.BO", quote);
      assert.strictEqual(result.exchange, "BSE");
      assert.strictEqual(result.symbol, "RELIANCE");
    });

    it("should handle index symbols", () => {
      const quote: YahooRawQuote = {
        symbol: "^NSEI",
        shortName: "NIFTY 50",
        regularMarketPrice: 22000,
        regularMarketPreviousClose: 21900,
        regularMarketChange: 100,
        regularMarketChangePercent: 0.46,
      };

      const result = rawQuoteToQuoteData("^NSEI", quote);
      assert.strictEqual(result.symbol, "^NSEI");
      assert.strictEqual(result.exchange, "NSE");
    });

    it("should default missing numeric fields to 0", () => {
      const quote: YahooRawQuote = {
        symbol: "SPARSE.NS",
        regularMarketPrice: 100,
        regularMarketPreviousClose: 95,
      };

      const result = rawQuoteToQuoteData("SPARSE.NS", quote);
      assert.strictEqual(result.open, 0);
      assert.strictEqual(result.high, 0);
      assert.strictEqual(result.low, 0);
      assert.strictEqual(result.volume, 0);
      assert.strictEqual(result.change, 0);
      assert.strictEqual(result.changePercent, 0);
    });

    it("should pass through optional fields as undefined when missing", () => {
      const quote: YahooRawQuote = {
        symbol: "SPARSE.NS",
        regularMarketPrice: 100,
        regularMarketPreviousClose: 95,
      };

      const result = rawQuoteToQuoteData("SPARSE.NS", quote);
      assert.strictEqual(result.marketCap, undefined);
      assert.strictEqual(result.pe, undefined);
      assert.strictEqual(result.eps, undefined);
      assert.strictEqual(result.week52High, undefined);
      assert.strictEqual(result.week52Low, undefined);
    });
  });

  describe("INDIAN_INDICES", () => {
    it("should have 6 index entries", () => {
      assert.strictEqual(Object.keys(INDIAN_INDICES).length, 6);
    });

    it("should map NIFTY_50 to ^NSEI", () => {
      assert.strictEqual(INDIAN_INDICES.NIFTY_50, "^NSEI");
    });

    it("should map NIFTY_BANK to ^NSEBANK", () => {
      assert.strictEqual(INDIAN_INDICES.NIFTY_BANK, "^NSEBANK");
    });

    it("should map SENSEX to ^BSESN", () => {
      assert.strictEqual(INDIAN_INDICES.SENSEX, "^BSESN");
    });

    it("should map NIFTY_IT to ^CNXIT", () => {
      assert.strictEqual(INDIAN_INDICES.NIFTY_IT, "^CNXIT");
    });

    it("should have all values start with ^", () => {
      for (const [key, value] of Object.entries(INDIAN_INDICES)) {
        assert.ok(value.startsWith("^"), `${key} should start with ^`);
      }
    });
  });
});
