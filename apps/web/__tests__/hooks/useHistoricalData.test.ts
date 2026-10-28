/**
 * useHistoricalData Hook Logic Tests
 *
 * De-shadowed (MONEY-620): previously this file re-implemented the hook's pure
 * transforms inline and asserted the copies (plus a fabricated `generateCacheKey`
 * and a `shouldFetch` model that don't exist in the source). It now imports the
 * REAL helpers from `@/hooks/useHistoricalData-logic` — the same functions the
 * hook calls. The non-source fabrications were dropped.
 *
 * Source: apps/web/hooks/useHistoricalData-logic.ts (consumed by useHistoricalData.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { HistoricalBar } from "@/hooks/useHistoricalData";
import {
  resolveHistoricalOptions as resolveOptions,
  buildHistoricalParams,
  parseHistoricalBar,
  parseHistoricalBars,
  toChartBar,
  toChartData,
  getDateRange as calculateDateRange,
  extractHistoricalError as extractErrorMessage,
  isValidPeriod,
  isValidInterval,
  type RawApiBar,
} from "@/hooks/useHistoricalData-logic";

// Construct the URL the hook builds (`/api/market/historical?${params}`).
function buildHistoricalUrl(
  symbol: string,
  exchange: "NSE" | "BSE",
  period: Parameters<typeof buildHistoricalParams>[2],
  interval: Parameters<typeof buildHistoricalParams>[3]
): string {
  return `/api/market/historical?${buildHistoricalParams(
    symbol,
    exchange,
    period,
    interval
  )}`;
}

// ============== MOCK FACTORIES ==============

function createMockRawBar(overrides: Partial<RawApiBar> = {}): RawApiBar {
  return {
    date: "2026-02-20T00:00:00.000Z",
    open: 2450.0,
    high: 2500.0,
    low: 2430.0,
    close: 2485.5,
    volume: 8500000,
    ...overrides,
  };
}

function createMockHistoricalBar(
  overrides: Partial<HistoricalBar> = {}
): HistoricalBar {
  return {
    date: new Date("2026-02-20T00:00:00.000Z"),
    open: 2450.0,
    high: 2500.0,
    low: 2430.0,
    close: 2485.5,
    volume: 8500000,
    ...overrides,
  };
}

// ============== TESTS ==============

describe("useHistoricalData Hook Logic", () => {
  // -- Options Defaults --

  describe("Options defaults", () => {
    it("should default period to 1mo", () => {
      assert.strictEqual(resolveOptions({}).period, "1mo");
    });

    it("should default interval to 1d", () => {
      assert.strictEqual(resolveOptions({}).interval, "1d");
    });

    it("should default exchange to NSE", () => {
      assert.strictEqual(resolveOptions({}).exchange, "NSE");
    });

    it("should default refreshInterval to 0 (disabled)", () => {
      assert.strictEqual(resolveOptions({}).refreshInterval, 0);
    });

    it("should respect custom period", () => {
      assert.strictEqual(resolveOptions({ period: "1y" }).period, "1y");
    });

    it("should respect custom interval", () => {
      assert.strictEqual(resolveOptions({ interval: "1h" }).interval, "1h");
    });

    it("should handle undefined options", () => {
      const opts = resolveOptions();
      assert.strictEqual(opts.period, "1mo");
      assert.strictEqual(opts.interval, "1d");
      assert.strictEqual(opts.exchange, "NSE");
      assert.strictEqual(opts.refreshInterval, 0);
    });
  });

  // -- URL Construction --

  describe("URL construction", () => {
    it("should build correct historical API URL", () => {
      const url = buildHistoricalUrl("RELIANCE", "NSE", "1mo", "1d");
      assert.ok(url.startsWith("/api/market/historical?"));
      assert.ok(url.includes("symbol=RELIANCE"));
      assert.ok(url.includes("exchange=NSE"));
      assert.ok(url.includes("period=1mo"));
      assert.ok(url.includes("interval=1d"));
    });

    it("should encode all four parameters", () => {
      const params = buildHistoricalParams("TCS", "BSE", "1y", "1wk");
      assert.strictEqual(params.get("symbol"), "TCS");
      assert.strictEqual(params.get("exchange"), "BSE");
      assert.strictEqual(params.get("period"), "1y");
      assert.strictEqual(params.get("interval"), "1wk");
    });

    it("should handle intraday interval in URL", () => {
      const url = buildHistoricalUrl("INFY", "NSE", "1d", "5m");
      assert.ok(url.includes("interval=5m"));
      assert.ok(url.includes("period=1d"));
    });
  });

  // -- Historical Bar Parsing --

  describe("Historical bar parsing", () => {
    it("should convert date string to Date object", () => {
      const parsed = parseHistoricalBar(createMockRawBar());
      assert.ok(parsed.date instanceof Date);
      assert.strictEqual(parsed.date.toISOString(), "2026-02-20T00:00:00.000Z");
    });

    it("should preserve OHLCV values", () => {
      const parsed = parseHistoricalBar(
        createMockRawBar({
          open: 100,
          high: 110,
          low: 95,
          close: 105,
          volume: 1000000,
        })
      );
      assert.strictEqual(parsed.open, 100);
      assert.strictEqual(parsed.high, 110);
      assert.strictEqual(parsed.low, 95);
      assert.strictEqual(parsed.close, 105);
      assert.strictEqual(parsed.volume, 1000000);
    });

    it("should include adjClose when present", () => {
      const parsed = parseHistoricalBar(createMockRawBar({ adjClose: 2480.0 }));
      assert.strictEqual(parsed.adjClose, 2480.0);
    });

    it("should leave adjClose undefined when absent", () => {
      const raw = createMockRawBar();
      delete raw.adjClose;
      const parsed = parseHistoricalBar(raw);
      assert.strictEqual(parsed.adjClose, undefined);
    });

    it("should parse multiple bars correctly", () => {
      const parsed = parseHistoricalBars([
        createMockRawBar({ date: "2026-02-18T00:00:00.000Z", close: 100 }),
        createMockRawBar({ date: "2026-02-19T00:00:00.000Z", close: 105 }),
        createMockRawBar({ date: "2026-02-20T00:00:00.000Z", close: 110 }),
      ]);
      assert.strictEqual(parsed.length, 3);
      assert.strictEqual(parsed[0].close, 100);
      assert.strictEqual(parsed[2].close, 110);
    });
  });

  // -- Chart Data Conversion --

  describe("Chart data conversion (TradingView format)", () => {
    it("should convert date to Unix timestamp in seconds", () => {
      const chart = toChartBar(
        createMockHistoricalBar({
          date: new Date("2026-02-20T00:00:00.000Z"),
        })
      );
      const expectedTimestamp = Math.floor(
        new Date("2026-02-20T00:00:00.000Z").getTime() / 1000
      );
      assert.strictEqual(chart.time, expectedTimestamp);
    });

    it("should preserve OHLC values in chart bar", () => {
      const chart = toChartBar(
        createMockHistoricalBar({ open: 200, high: 220, low: 195, close: 210 })
      );
      assert.strictEqual(chart.open, 200);
      assert.strictEqual(chart.high, 220);
      assert.strictEqual(chart.low, 195);
      assert.strictEqual(chart.close, 210);
    });

    it("should include volume in chart bar", () => {
      const chart = toChartBar(createMockHistoricalBar({ volume: 5000000 }));
      assert.strictEqual(chart.volume, 5000000);
    });

    it("should convert multiple bars to chart data array", () => {
      const chartData = toChartData([
        createMockHistoricalBar({ date: new Date("2026-02-18T00:00:00.000Z") }),
        createMockHistoricalBar({ date: new Date("2026-02-19T00:00:00.000Z") }),
      ]);
      assert.strictEqual(chartData.length, 2);
      assert.ok(chartData[0].time < chartData[1].time);
    });

    it("should return empty array for empty data", () => {
      assert.strictEqual(toChartData([]).length, 0);
    });

    it("should floor timestamp (not round)", () => {
      const chart = toChartBar(
        createMockHistoricalBar({
          date: new Date("2026-02-20T12:30:45.999Z"),
        })
      );
      const expected = Math.floor(
        new Date("2026-02-20T12:30:45.999Z").getTime() / 1000
      );
      assert.strictEqual(chart.time, expected);
    });

    it("should DROP bars with an Invalid Date (non-finite Unix time)", () => {
      // Regression: lightweight-charts requires finite times — a single NaN
      // time would corrupt/throw the whole series. The real toChartData skips
      // it (this is the behaviour a shadow copy could silently lose).
      const chartData = toChartData([
        createMockHistoricalBar({ date: new Date("2026-02-18T00:00:00.000Z") }),
        createMockHistoricalBar({ date: new Date("not-a-date") }),
        createMockHistoricalBar({ date: new Date("2026-02-20T00:00:00.000Z") }),
      ]);
      assert.strictEqual(chartData.length, 2);
      for (const bar of chartData) {
        assert.ok(Number.isFinite(bar.time));
      }
    });
  });

  // -- Date Range Calculation --

  describe("Date range calculation", () => {
    it("should return null range for empty data", () => {
      const range = calculateDateRange([]);
      assert.strictEqual(range.start, null);
      assert.strictEqual(range.end, null);
    });

    it("should return same date for single bar", () => {
      const date = new Date("2026-02-20T00:00:00.000Z");
      const range = calculateDateRange([createMockHistoricalBar({ date })]);
      assert.strictEqual(range.start?.getTime(), date.getTime());
      assert.strictEqual(range.end?.getTime(), date.getTime());
    });

    it("should return first and last dates for multiple bars", () => {
      const range = calculateDateRange([
        createMockHistoricalBar({ date: new Date("2026-01-01T00:00:00.000Z") }),
        createMockHistoricalBar({ date: new Date("2026-01-15T00:00:00.000Z") }),
        createMockHistoricalBar({ date: new Date("2026-02-01T00:00:00.000Z") }),
      ]);
      assert.strictEqual(
        range.start?.toISOString(),
        "2026-01-01T00:00:00.000Z"
      );
      assert.strictEqual(range.end?.toISOString(), "2026-02-01T00:00:00.000Z");
    });
  });

  // -- Period and Interval Validation --

  describe("Period validation", () => {
    it("should accept all valid periods", () => {
      for (const p of [
        "1d",
        "5d",
        "1mo",
        "3mo",
        "6mo",
        "1y",
        "2y",
        "5y",
        "ytd",
        "max",
      ]) {
        assert.strictEqual(isValidPeriod(p), true, `${p} should be valid`);
      }
    });

    it("should reject invalid period strings", () => {
      assert.strictEqual(isValidPeriod("10y"), false);
      assert.strictEqual(isValidPeriod(""), false);
      assert.strictEqual(isValidPeriod("weekly"), false);
    });
  });

  describe("Interval validation", () => {
    it("should accept all valid intervals", () => {
      for (const i of [
        "1m",
        "3m",
        "5m",
        "10m",
        "15m",
        "30m",
        "60m",
        "1h",
        "1d",
        "1wk",
        "1mo",
      ]) {
        assert.strictEqual(isValidInterval(i), true, `${i} should be valid`);
      }
    });

    it("should reject invalid interval strings", () => {
      assert.strictEqual(isValidInterval("2h"), false);
      assert.strictEqual(isValidInterval(""), false);
      assert.strictEqual(isValidInterval("daily"), false);
    });
  });

  // -- Error Message Extraction --

  describe("Error message extraction", () => {
    it("should extract message from Error", () => {
      assert.strictEqual(
        extractErrorMessage(
          new Error("Failed to fetch historical data: Not Found")
        ),
        "Failed to fetch historical data: Not Found"
      );
    });

    it("should return 'Unknown error' for non-Error values", () => {
      assert.strictEqual(extractErrorMessage("oops"), "Unknown error");
      assert.strictEqual(extractErrorMessage(null), "Unknown error");
      assert.strictEqual(extractErrorMessage(42), "Unknown error");
    });
  });
});
