/**
 * Chart Data Transformation Tests
 *
 * Tests for the HistoricalBar→ChartBar transformation logic
 * used in useHistoricalData.ts:
 * - Date to Unix timestamp (seconds) conversion
 * - Date range extraction from data array
 * - OHLCV field mapping
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed: import the REAL transforms extracted from useHistoricalData.ts
// (the hook calls them via useMemo). toChartData now drops non-finite Unix
// times so an Invalid Date can't poison the lightweight-charts series.
import { toChartData, getDateRange } from "@/hooks/useHistoricalData-logic";
import type { HistoricalBar } from "@/hooks/useHistoricalData";

// ── Helpers ──────────────────────────────────────────────────────

function makeBar(dateStr: string, price: number, volume = 1000): HistoricalBar {
  return {
    date: new Date(dateStr),
    open: price,
    high: price + 10,
    low: price - 5,
    close: price + 2,
    volume,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("Chart Data Transformation", () => {
  describe("toChartData (Date → Unix timestamp)", () => {
    it("should convert Date to Unix seconds", () => {
      const bar: HistoricalBar = {
        date: new Date("2025-01-15T00:00:00Z"),
        open: 100,
        high: 110,
        low: 95,
        close: 105,
        volume: 50000,
      };

      const [chartBar] = toChartData([bar]);
      // 2025-01-15T00:00:00Z in Unix seconds
      const expectedTimestamp = Math.floor(
        new Date("2025-01-15T00:00:00Z").getTime() / 1000
      );
      assert.strictEqual(chartBar.time, expectedTimestamp);
    });

    it("should truncate milliseconds (floor)", () => {
      const bar: HistoricalBar = {
        date: new Date("2025-06-15T12:30:45.999Z"),
        open: 100,
        high: 110,
        low: 95,
        close: 105,
        volume: 50000,
      };

      const [chartBar] = toChartData([bar]);
      const expectedTimestamp = Math.floor(
        new Date("2025-06-15T12:30:45.999Z").getTime() / 1000
      );
      assert.strictEqual(chartBar.time, expectedTimestamp);
    });

    it("should map OHLC fields correctly", () => {
      const bar: HistoricalBar = {
        date: new Date("2025-01-15"),
        open: 2534.75,
        high: 2567.9,
        low: 2520.15,
        close: 2555.6,
        volume: 15_000_000,
      };

      const [chartBar] = toChartData([bar]);
      assert.strictEqual(chartBar.open, 2534.75);
      assert.strictEqual(chartBar.high, 2567.9);
      assert.strictEqual(chartBar.low, 2520.15);
      assert.strictEqual(chartBar.close, 2555.6);
    });

    it("should include volume in chart bar", () => {
      const bar: HistoricalBar = {
        date: new Date("2025-01-15"),
        open: 100,
        high: 110,
        low: 95,
        close: 105,
        volume: 5_000_000,
      };

      const [chartBar] = toChartData([bar]);
      assert.strictEqual(chartBar.volume, 5_000_000);
    });

    it("should drop adjClose (not included in ChartBar)", () => {
      const bar: HistoricalBar = {
        date: new Date("2025-01-15"),
        open: 100,
        high: 110,
        low: 95,
        close: 105,
        volume: 50000,
        adjClose: 104.5,
      };

      const [chartBar] = toChartData([bar]);
      assert.strictEqual("adjClose" in chartBar, false);
    });

    it("should handle multiple bars in order", () => {
      const bars = [
        makeBar("2025-01-13", 100),
        makeBar("2025-01-14", 102),
        makeBar("2025-01-15", 105),
      ];

      const chartBars = toChartData(bars);
      assert.strictEqual(chartBars.length, 3);
      assert.ok(chartBars[0].time < chartBars[1].time);
      assert.ok(chartBars[1].time < chartBars[2].time);
    });

    it("should return empty array for empty input", () => {
      const chartBars = toChartData([]);
      assert.strictEqual(chartBars.length, 0);
    });

    it("should handle epoch date", () => {
      const bar: HistoricalBar = {
        date: new Date(0),
        open: 100,
        high: 110,
        low: 95,
        close: 105,
        volume: 50000,
      };

      const [chartBar] = toChartData([bar]);
      assert.strictEqual(chartBar.time, 0);
    });

    it("should DROP bars with an Invalid Date (non-finite time guard)", () => {
      // Regression: Math.floor(NaN/1000) = NaN. A NaN time poisons the
      // lightweight-charts series (requires finite, increasing times), so
      // toChartData must skip such bars rather than emit { time: NaN }.
      const good = makeBar("2025-01-15T00:00:00Z", 100);
      const bad: HistoricalBar = {
        date: new Date("not-a-date"), // Invalid Date → getTime() = NaN
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
      };

      const chartBars = toChartData([good, bad]);
      assert.strictEqual(
        chartBars.length,
        1,
        "Invalid-Date bar must be dropped"
      );
      assert.ok(
        Number.isFinite(chartBars[0].time as number),
        "remaining bar must have a finite time"
      );
      for (const b of chartBars) {
        assert.ok(
          Number.isFinite(b.time as number),
          "no emitted bar may have a NaN/Infinity time"
        );
      }
    });

    it("should handle IST market open time correctly", () => {
      // NSE opens at 9:15 AM IST = 3:45 AM UTC
      const bar: HistoricalBar = {
        date: new Date("2025-01-15T03:45:00Z"),
        open: 100,
        high: 110,
        low: 95,
        close: 105,
        volume: 50000,
      };

      const [chartBar] = toChartData([bar]);
      const expected = Math.floor(
        new Date("2025-01-15T03:45:00Z").getTime() / 1000
      );
      assert.strictEqual(chartBar.time, expected);
    });

    it("should produce monotonically increasing timestamps for daily data", () => {
      const bars = [
        makeBar("2025-01-06", 100),
        makeBar("2025-01-07", 101),
        makeBar("2025-01-08", 102),
        makeBar("2025-01-09", 103),
        makeBar("2025-01-10", 104),
      ];

      const chartBars = toChartData(bars);
      for (let i = 1; i < chartBars.length; i++) {
        assert.ok(
          chartBars[i].time > chartBars[i - 1].time,
          `Bar ${i} should have greater timestamp than bar ${i - 1}`
        );
      }
    });

    it("should have ~86400s (1 day) between daily bars", () => {
      const bars = [
        makeBar("2025-01-15T00:00:00Z", 100),
        makeBar("2025-01-16T00:00:00Z", 102),
      ];

      const chartBars = toChartData(bars);
      // lightweight-charts' `Time` is `UTCTimestamp | BusinessDay | string`;
      // toChartData must emit the numeric UTCTimestamp branch for arithmetic
      // to be meaningful, so assert that before subtracting.
      const t0 = chartBars[0]?.time;
      const t1 = chartBars[1]?.time;
      assert.ok(
        typeof t0 === "number" && typeof t1 === "number",
        "daily bars must carry numeric UTC timestamps"
      );
      assert.strictEqual(t1 - t0, 86400);
    });
  });

  describe("getDateRange", () => {
    it("should return null for empty data", () => {
      const range = getDateRange([]);
      assert.strictEqual(range.start, null);
      assert.strictEqual(range.end, null);
    });

    it("should return first and last dates", () => {
      const bars = [
        makeBar("2025-01-06", 100),
        makeBar("2025-01-07", 101),
        makeBar("2025-01-08", 102),
      ];

      const range = getDateRange(bars);
      assert.strictEqual(range.start!.toISOString().slice(0, 10), "2025-01-06");
      assert.strictEqual(range.end!.toISOString().slice(0, 10), "2025-01-08");
    });

    it("should handle single entry (start equals end)", () => {
      const bars = [makeBar("2025-01-15", 100)];
      const range = getDateRange(bars);
      assert.strictEqual(range.start, range.end);
    });

    it("should reference the actual Date objects from data", () => {
      const bars = [makeBar("2025-01-06", 100), makeBar("2025-01-10", 104)];

      const range = getDateRange(bars);
      assert.strictEqual(range.start, bars[0].date);
      assert.strictEqual(range.end, bars[1].date);
    });

    it("should handle multi-month range", () => {
      const bars = [
        makeBar("2024-06-01", 100),
        makeBar("2024-07-01", 110),
        makeBar("2024-08-01", 120),
        makeBar("2024-09-01", 115),
        makeBar("2024-10-01", 125),
        makeBar("2024-11-01", 130),
        makeBar("2024-12-01", 135),
        makeBar("2025-01-01", 140),
      ];

      const range = getDateRange(bars);
      assert.strictEqual(range.start!.getUTCFullYear(), 2024);
      assert.strictEqual(range.end!.getUTCFullYear(), 2025);
    });
  });
});
