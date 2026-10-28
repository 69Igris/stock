/**
 * Market Historical Data — REAL logic test.
 *
 * Exercises the actual exported symbols from
 * `@/lib/market/historical-fetcher` (the shared module the historical route
 * AND the TradingView UDF history endpoint both call) — NOT inline copies.
 * Pins the period/interval taxonomy, `getPeriodStartDate` date math, the
 * intraday vs daily classification, the Yahoo-fallback gate, and the symbol /
 * date-range validators.
 *
 * (Replaces the previous shadow version, which reimplemented VALID_PERIODS /
 * VALID_INTERVALS / YAHOO_INTERVALS / getPeriodStartDate / the predicates
 * inline and asserted the copies, so a regression in the real module went
 * undetected.)
 *
 * Source: apps/web/lib/market/historical-fetcher.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VALID_PERIODS,
  VALID_INTERVALS,
  YAHOO_INTERVALS,
  INTRADAY_INTERVALS,
  INTRADAY_PERIODS,
  getPeriodStartDate,
  isValidPeriod,
  isValidInterval,
  isIntradayInterval,
  isIntradayPeriod,
  isYahooInterval,
  validateSymbol,
  validateDateRange,
} from "@/lib/market/historical-fetcher";

describe("Market Historical API Logic", () => {
  describe("VALID_PERIODS array", () => {
    it("should contain exactly 11 periods", () => {
      assert.strictEqual(VALID_PERIODS.length, 11);
    });

    it("should contain 1d", () => {
      assert.ok((VALID_PERIODS as readonly string[]).includes("1d"));
    });

    it("should contain 5d", () => {
      assert.ok((VALID_PERIODS as readonly string[]).includes("5d"));
    });

    it("should contain 1mo", () => {
      assert.ok((VALID_PERIODS as readonly string[]).includes("1mo"));
    });

    it("should contain 3mo", () => {
      assert.ok((VALID_PERIODS as readonly string[]).includes("3mo"));
    });

    it("should contain 6mo", () => {
      assert.ok((VALID_PERIODS as readonly string[]).includes("6mo"));
    });

    it("should contain 1y", () => {
      assert.ok((VALID_PERIODS as readonly string[]).includes("1y"));
    });

    it("should contain 2y", () => {
      assert.ok((VALID_PERIODS as readonly string[]).includes("2y"));
    });

    it("should contain 5y", () => {
      assert.ok((VALID_PERIODS as readonly string[]).includes("5y"));
    });

    it("should contain 10y", () => {
      assert.ok((VALID_PERIODS as readonly string[]).includes("10y"));
    });

    it("should contain ytd", () => {
      assert.ok((VALID_PERIODS as readonly string[]).includes("ytd"));
    });

    it("should contain max", () => {
      assert.ok((VALID_PERIODS as readonly string[]).includes("max"));
    });
  });

  describe("VALID_INTERVALS array", () => {
    // MONEY-837: web market data is Yahoo-only, so VALID_INTERVALS == YAHOO_INTERVALS
    // (11) — the Zerodha-exclusive 3m / 10m intervals are no longer valid.
    it("should contain exactly 11 intervals (Yahoo-only)", () => {
      assert.strictEqual(VALID_INTERVALS.length, 11);
    });

    it("should NOT contain the Zerodha-exclusive 3m (Yahoo-only)", () => {
      assert.ok(!VALID_INTERVALS.includes("3m"));
    });

    it("should NOT contain the Zerodha-exclusive 10m (Yahoo-only)", () => {
      assert.ok(!VALID_INTERVALS.includes("10m"));
    });

    it("should contain all standard intervals", () => {
      const standard = [
        "1m",
        "5m",
        "15m",
        "30m",
        "60m",
        "1h",
        "1d",
        "5d",
        "1wk",
        "1mo",
        "3mo",
      ];
      for (const i of standard) {
        assert.ok(VALID_INTERVALS.includes(i), `Missing interval: ${i}`);
      }
    });
  });

  describe("YAHOO_INTERVALS array", () => {
    it("should NOT contain 3m (Zerodha-exclusive)", () => {
      assert.ok(!(YAHOO_INTERVALS as readonly string[]).includes("3m"));
    });

    it("should NOT contain 10m (Zerodha-exclusive)", () => {
      assert.ok(!(YAHOO_INTERVALS as readonly string[]).includes("10m"));
    });

    it("should contain exactly 11 intervals", () => {
      assert.strictEqual(YAHOO_INTERVALS.length, 11);
    });

    it("should contain all non-Zerodha-exclusive intervals", () => {
      const expected = [
        "1m",
        "5m",
        "15m",
        "30m",
        "60m",
        "1h",
        "1d",
        "5d",
        "1wk",
        "1mo",
        "3mo",
      ];
      for (const i of expected) {
        assert.ok(
          (YAHOO_INTERVALS as readonly string[]).includes(i),
          `Missing Yahoo interval: ${i}`
        );
      }
    });
  });

  describe("INTRADAY_INTERVALS array", () => {
    // MONEY-837: Yahoo-only — the Zerodha-exclusive 3m / 10m dropped (5 left).
    it("should contain exactly 5 intervals (Yahoo-only)", () => {
      assert.strictEqual(INTRADAY_INTERVALS.length, 5);
    });

    it("should contain 1m, 5m, 15m, 30m, 60m", () => {
      const expected = ["1m", "5m", "15m", "30m", "60m"];
      assert.deepStrictEqual(INTRADAY_INTERVALS, expected);
    });

    it("should NOT contain 1h (hourly, not intraday classification)", () => {
      assert.ok(!INTRADAY_INTERVALS.includes("1h"));
    });

    it("should NOT contain daily intervals", () => {
      assert.ok(!INTRADAY_INTERVALS.includes("1d"));
      assert.ok(!INTRADAY_INTERVALS.includes("5d"));
      assert.ok(!INTRADAY_INTERVALS.includes("1wk"));
    });
  });

  describe("INTRADAY_PERIODS array", () => {
    it("should contain exactly 3 periods", () => {
      assert.strictEqual(INTRADAY_PERIODS.length, 3);
    });

    it("should contain 1d, 5d, 1mo", () => {
      assert.deepStrictEqual(INTRADAY_PERIODS, ["1d", "5d", "1mo"]);
    });

    it("should NOT contain long-term periods", () => {
      assert.ok(!INTRADAY_PERIODS.includes("1y"));
      assert.ok(!INTRADAY_PERIODS.includes("max"));
    });
  });

  describe("getPeriodStartDate", () => {
    it("should return 1 day ago for '1d'", () => {
      const now = new Date();
      const start = getPeriodStartDate("1d");
      const diffMs = now.getTime() - start.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      assert.ok(diffDays >= 0.99 && diffDays <= 1.01);
    });

    it("should return 5 days ago for '5d'", () => {
      const now = new Date();
      const start = getPeriodStartDate("5d");
      const diffMs = now.getTime() - start.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      assert.ok(diffDays >= 4.99 && diffDays <= 5.01);
    });

    it("should return ~1 month ago for '1mo'", () => {
      const now = new Date();
      const start = getPeriodStartDate("1mo");
      const diffDays =
        (now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
      // A calendar month back is 28-31 days; a day-tolerance absorbs JS setMonth
      // month-end rollover (e.g. on the 31st Apr-31 overflows into May), which
      // makes a getMonth() assertion flaky at month-end.
      assert.ok(diffDays >= 27 && diffDays <= 33, `1mo => ${diffDays} days`);
    });

    it("should return ~3 months ago for '3mo'", () => {
      const now = new Date();
      const start = getPeriodStartDate("3mo");
      const diffDays =
        (now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
      // 3 calendar months back is ~89-92 days; the day-tolerance absorbs JS
      // setMonth month-end rollover (e.g. on the 30th/31st Feb overflows into
      // March), which made the old getMonth() assertion fail at month-end.
      assert.ok(diffDays >= 84 && diffDays <= 96, `3mo => ${diffDays} days`);
    });

    it("should return ~6 months ago for '6mo'", () => {
      const now = new Date();
      const start = getPeriodStartDate("6mo");
      const diffDays =
        (now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
      // 6 calendar months back is ~181-184 days; the day-tolerance absorbs JS
      // setMonth month-end rollover at the 30th/31st.
      assert.ok(diffDays >= 176 && diffDays <= 190, `6mo => ${diffDays} days`);
    });

    it("should return 1 year ago for '1y'", () => {
      const now = new Date();
      const start = getPeriodStartDate("1y");
      assert.strictEqual(start.getFullYear(), now.getFullYear() - 1);
    });

    it("should return 2 years ago for '2y'", () => {
      const now = new Date();
      const start = getPeriodStartDate("2y");
      assert.strictEqual(start.getFullYear(), now.getFullYear() - 2);
    });

    it("should return 5 years ago for '5y'", () => {
      const now = new Date();
      const start = getPeriodStartDate("5y");
      assert.strictEqual(start.getFullYear(), now.getFullYear() - 5);
    });

    it("should return 10 years ago for '10y'", () => {
      const now = new Date();
      const start = getPeriodStartDate("10y");
      assert.strictEqual(start.getFullYear(), now.getFullYear() - 10);
    });

    it("should return January 1 of current year for 'ytd'", () => {
      const start = getPeriodStartDate("ytd");
      assert.strictEqual(start.getMonth(), 0); // January
      assert.strictEqual(start.getDate(), 1);
      assert.strictEqual(start.getFullYear(), new Date().getFullYear());
    });

    it("should return year 1970 for 'max'", () => {
      const start = getPeriodStartDate("max");
      assert.strictEqual(start.getFullYear(), 1970);
    });

    it("should default to 1 month ago for unknown period", () => {
      const now = new Date();
      const start = getPeriodStartDate("unknown");
      const expectedMonth = (now.getMonth() - 1 + 12) % 12;
      assert.strictEqual(start.getMonth(), expectedMonth);
    });

    it("should default to 1 month ago for empty string", () => {
      const now = new Date();
      const start = getPeriodStartDate("");
      const expectedMonth = (now.getMonth() - 1 + 12) % 12;
      assert.strictEqual(start.getMonth(), expectedMonth);
    });

    it("should return a Date object for all valid periods", () => {
      for (const period of VALID_PERIODS) {
        const result = getPeriodStartDate(period);
        assert.ok(result instanceof Date, `${period} should return a Date`);
        assert.ok(
          !isNaN(result.getTime()),
          `${period} should return valid Date`
        );
      }
    });

    it("should return a date in the past (or very near now) for all periods", () => {
      const now = new Date();
      for (const period of VALID_PERIODS) {
        const start = getPeriodStartDate(period);
        assert.ok(
          start.getTime() <= now.getTime() + 1000,
          `${period} start should be <= now`
        );
      }
    });
  });

  describe("Interval classification", () => {
    // MONEY-837: 3m / 10m are Zerodha-exclusive and no longer valid (Yahoo-only).
    it("should NOT classify 3m as intraday (Yahoo-only)", () => {
      assert.strictEqual(isIntradayInterval("3m"), false);
    });

    it("should NOT classify 10m as intraday (Yahoo-only)", () => {
      assert.strictEqual(isIntradayInterval("10m"), false);
    });

    it("should classify 1m as intraday", () => {
      assert.strictEqual(isIntradayInterval("1m"), true);
    });

    it("should classify 60m as intraday", () => {
      assert.strictEqual(isIntradayInterval("60m"), true);
    });

    it("should NOT classify 1h as intraday", () => {
      assert.strictEqual(isIntradayInterval("1h"), false);
    });

    it("should NOT classify 1d as intraday", () => {
      assert.strictEqual(isIntradayInterval("1d"), false);
    });

    it("should NOT classify 1wk as intraday", () => {
      assert.strictEqual(isIntradayInterval("1wk"), false);
    });

    it("should NOT classify 1mo as intraday", () => {
      assert.strictEqual(isIntradayInterval("1mo"), false);
    });
  });

  describe("Validation logic", () => {
    it("should reject missing symbol", () => {
      const result = validateSymbol(null);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Symbol"));
    });

    it("should reject empty symbol", () => {
      const result = validateSymbol("");
      assert.strictEqual(result.valid, false);
    });

    it("should accept valid symbol", () => {
      const result = validateSymbol("RELIANCE");
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.error, undefined);
    });

    it("should reject invalid period", () => {
      assert.strictEqual(isValidPeriod("2d"), false);
      assert.strictEqual(isValidPeriod("1w"), false);
      assert.strictEqual(isValidPeriod(""), false);
    });

    it("should accept all valid periods", () => {
      for (const p of VALID_PERIODS) {
        assert.strictEqual(isValidPeriod(p), true, `${p} should be valid`);
      }
    });

    it("should reject invalid interval", () => {
      assert.strictEqual(isValidInterval("2m"), false);
      assert.strictEqual(isValidInterval("1hr"), false);
      assert.strictEqual(isValidInterval(""), false);
    });

    it("should accept all valid intervals", () => {
      for (const i of VALID_INTERVALS) {
        assert.strictEqual(isValidInterval(i), true, `${i} should be valid`);
      }
    });

    it("should reject startDate after endDate", () => {
      const result = validateDateRange(
        new Date("2024-12-31"),
        new Date("2024-01-01")
      );
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("startDate"));
    });

    it("should accept startDate before endDate", () => {
      const result = validateDateRange(
        new Date("2024-01-01"),
        new Date("2024-12-31")
      );
      assert.strictEqual(result.valid, true);
    });

    it("should accept same start and end date", () => {
      const date = new Date("2024-06-15");
      const result = validateDateRange(date, date);
      assert.strictEqual(result.valid, true);
    });

    it("should reject invalid date formats", () => {
      const result = validateDateRange(
        new Date("not-a-date"),
        new Date("2024-01-01")
      );
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Invalid date format"));
    });
  });

  describe("Yahoo fallback logic", () => {
    it("should allow fallback for standard intervals", () => {
      assert.strictEqual(isYahooInterval("1m"), true);
      assert.strictEqual(isYahooInterval("5m"), true);
      assert.strictEqual(isYahooInterval("1d"), true);
    });

    it("should NOT allow fallback for 3m (Zerodha-exclusive)", () => {
      assert.strictEqual(isYahooInterval("3m"), false);
    });

    it("should NOT allow fallback for 10m (Zerodha-exclusive)", () => {
      assert.strictEqual(isYahooInterval("10m"), false);
    });

    it("should allow fallback for all Yahoo intervals", () => {
      for (const i of YAHOO_INTERVALS) {
        assert.strictEqual(
          isYahooInterval(i),
          true,
          `${i} should allow Yahoo fallback`
        );
      }
    });
  });

  describe("Intraday period validation", () => {
    it("should accept 1d as valid intraday period", () => {
      assert.strictEqual(isIntradayPeriod("1d"), true);
    });

    it("should accept 5d as valid intraday period", () => {
      assert.strictEqual(isIntradayPeriod("5d"), true);
    });

    it("should accept 1mo as valid intraday period", () => {
      assert.strictEqual(isIntradayPeriod("1mo"), true);
    });

    it("should reject 1y as intraday period", () => {
      assert.strictEqual(isIntradayPeriod("1y"), false);
    });

    it("should reject max as intraday period", () => {
      assert.strictEqual(isIntradayPeriod("max"), false);
    });

    it("should reject ytd as intraday period", () => {
      assert.strictEqual(isIntradayPeriod("ytd"), false);
    });
  });
});
