/**
 * Zerodha Client Tests
 *
 * Tests for interval mapping, date clamping, date formatting,
 * and data transformation logic in the Zerodha market data client.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ZERODHA_INTERVAL_MAP,
  isZerodhaInterval,
} from "../../src/connect/zerodha-client";

// ── Inline private helpers for testing ──────────────────────────

/**
 * Mirrors ZERODHA_MAX_DAYS from zerodha-client.ts
 */
const ZERODHA_MAX_DAYS: Record<string, number> = {
  minute: 60,
  "3minute": 100,
  "5minute": 100,
  "10minute": 100,
  "15minute": 100,
  "30minute": 100,
  "60minute": 400,
  day: 2000,
};

/**
 * Mirrors formatDate from zerodha-client.ts
 */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

/**
 * Mirrors the date clamping logic from getZerodhaHistorical
 */
function clampFromDate(
  interval: string,
  from: Date,
  to: Date,
): { clampedFrom: Date; wasClamped: boolean } {
  const zerodhaInterval = ZERODHA_INTERVAL_MAP[interval];
  if (!zerodhaInterval) {
    return { clampedFrom: from, wasClamped: false };
  }

  const maxDays = ZERODHA_MAX_DAYS[zerodhaInterval] ?? 2000;
  const earliestAllowed = new Date(to);
  earliestAllowed.setDate(earliestAllowed.getDate() - maxDays);

  const wasClamped = from < earliestAllowed;
  const clampedFrom = wasClamped ? earliestAllowed : from;

  return { clampedFrom, wasClamped };
}

/**
 * Mirrors candle-to-HistoricalBar transformation
 */
function transformCandles(
  candles: Array<[string, number, number, number, number, number]>,
) {
  return candles.map(([timestamp, open, high, low, close, volume]) => ({
    date: new Date(timestamp),
    open,
    high,
    low,
    close,
    volume,
  }));
}

// ── Tests ───────────────────────────────────────────────────────

describe("Zerodha Client", () => {
  describe("ZERODHA_INTERVAL_MAP", () => {
    it("should map 1m to minute", () => {
      assert.strictEqual(ZERODHA_INTERVAL_MAP["1m"], "minute");
    });

    it("should map 3m to 3minute", () => {
      assert.strictEqual(ZERODHA_INTERVAL_MAP["3m"], "3minute");
    });

    it("should map 5m to 5minute", () => {
      assert.strictEqual(ZERODHA_INTERVAL_MAP["5m"], "5minute");
    });

    it("should map 10m to 10minute", () => {
      assert.strictEqual(ZERODHA_INTERVAL_MAP["10m"], "10minute");
    });

    it("should map 15m to 15minute", () => {
      assert.strictEqual(ZERODHA_INTERVAL_MAP["15m"], "15minute");
    });

    it("should map 30m to 30minute", () => {
      assert.strictEqual(ZERODHA_INTERVAL_MAP["30m"], "30minute");
    });

    it("should map 60m to 60minute", () => {
      assert.strictEqual(ZERODHA_INTERVAL_MAP["60m"], "60minute");
    });

    it("should map 1h to 60minute (alias)", () => {
      assert.strictEqual(ZERODHA_INTERVAL_MAP["1h"], "60minute");
    });

    it("should map 1d to day", () => {
      assert.strictEqual(ZERODHA_INTERVAL_MAP["1d"], "day");
    });

    it("should not have mapping for 2m (Yahoo-exclusive)", () => {
      assert.strictEqual(ZERODHA_INTERVAL_MAP["2m"], undefined);
    });

    it("should not have mapping for 90m (Yahoo-exclusive)", () => {
      assert.strictEqual(ZERODHA_INTERVAL_MAP["90m"], undefined);
    });

    it("should not have mapping for 1wk", () => {
      assert.strictEqual(ZERODHA_INTERVAL_MAP["1wk"], undefined);
    });

    it("should not have mapping for 1mo", () => {
      assert.strictEqual(ZERODHA_INTERVAL_MAP["1mo"], undefined);
    });
  });

  describe("isZerodhaInterval", () => {
    it("should return true for supported intervals", () => {
      assert.strictEqual(isZerodhaInterval("1m"), true);
      assert.strictEqual(isZerodhaInterval("3m"), true);
      assert.strictEqual(isZerodhaInterval("5m"), true);
      assert.strictEqual(isZerodhaInterval("10m"), true);
      assert.strictEqual(isZerodhaInterval("15m"), true);
      assert.strictEqual(isZerodhaInterval("30m"), true);
      assert.strictEqual(isZerodhaInterval("60m"), true);
      assert.strictEqual(isZerodhaInterval("1h"), true);
      assert.strictEqual(isZerodhaInterval("1d"), true);
    });

    it("should return false for Yahoo-exclusive intervals", () => {
      assert.strictEqual(isZerodhaInterval("2m"), false);
      assert.strictEqual(isZerodhaInterval("90m"), false);
      assert.strictEqual(isZerodhaInterval("1wk"), false);
      assert.strictEqual(isZerodhaInterval("1mo"), false);
      assert.strictEqual(isZerodhaInterval("3mo"), false);
    });

    it("should return false for invalid intervals", () => {
      assert.strictEqual(isZerodhaInterval(""), false);
      assert.strictEqual(isZerodhaInterval("abc"), false);
      assert.strictEqual(isZerodhaInterval("7m"), false);
    });
  });

  describe("formatDate", () => {
    it("should format date as YYYY-MM-DD HH:mm:ss", () => {
      const date = new Date(2026, 0, 15, 9, 30, 0); // Jan 15, 2026 09:30:00
      assert.strictEqual(formatDate(date), "2026-01-15 09:30:00");
    });

    it("should pad single-digit months and days", () => {
      const date = new Date(2026, 1, 4, 5, 7, 3); // Feb 4, 2026 05:07:03
      assert.strictEqual(formatDate(date), "2026-02-04 05:07:03");
    });

    it("should handle midnight", () => {
      const date = new Date(2026, 5, 1, 0, 0, 0); // Jun 1, 2026 00:00:00
      assert.strictEqual(formatDate(date), "2026-06-01 00:00:00");
    });

    it("should handle end of day", () => {
      const date = new Date(2026, 11, 31, 23, 59, 59); // Dec 31, 2026 23:59:59
      assert.strictEqual(formatDate(date), "2026-12-31 23:59:59");
    });

    it("should handle double-digit months", () => {
      const date = new Date(2026, 10, 25, 14, 30, 0); // Nov 25, 2026
      assert.strictEqual(formatDate(date), "2026-11-25 14:30:00");
    });
  });

  describe("Date Clamping", () => {
    const to = new Date("2026-02-04T00:00:00Z");

    it("should not clamp when from is within daily limit (2000 days)", () => {
      const from = new Date("2021-06-01T00:00:00Z"); // ~4.7 years ago
      const result = clampFromDate("1d", from, to);
      assert.strictEqual(result.wasClamped, false);
      assert.strictEqual(result.clampedFrom.getTime(), from.getTime());
    });

    it("should clamp when from exceeds daily limit (2000 days)", () => {
      const from = new Date("1970-01-01T00:00:00Z"); // way beyond limit
      const result = clampFromDate("1d", from, to);
      assert.strictEqual(result.wasClamped, true);

      // clampedFrom should be ~2000 days before 'to'
      const diffDays = Math.round(
        (to.getTime() - result.clampedFrom.getTime()) / (1000 * 60 * 60 * 24),
      );
      assert.strictEqual(diffDays, 2000);
    });

    it("should clamp minute interval to 60 days", () => {
      const from = new Date("2025-01-01T00:00:00Z"); // >60 days before to
      const result = clampFromDate("1m", from, to);
      assert.strictEqual(result.wasClamped, true);

      const diffDays = Math.round(
        (to.getTime() - result.clampedFrom.getTime()) / (1000 * 60 * 60 * 24),
      );
      assert.strictEqual(diffDays, 60);
    });

    it("should clamp 5minute interval to 100 days", () => {
      const from = new Date("2025-01-01T00:00:00Z"); // >100 days before to
      const result = clampFromDate("5m", from, to);
      assert.strictEqual(result.wasClamped, true);

      const diffDays = Math.round(
        (to.getTime() - result.clampedFrom.getTime()) / (1000 * 60 * 60 * 24),
      );
      assert.strictEqual(diffDays, 100);
    });

    it("should clamp 60minute interval to 400 days", () => {
      const from = new Date("2024-01-01T00:00:00Z"); // >400 days before to
      const result = clampFromDate("60m", from, to);
      assert.strictEqual(result.wasClamped, true);

      const diffDays = Math.round(
        (to.getTime() - result.clampedFrom.getTime()) / (1000 * 60 * 60 * 24),
      );
      assert.strictEqual(diffDays, 400);
    });

    it("should not clamp 60m when within 400-day limit", () => {
      const from = new Date("2025-06-01T00:00:00Z"); // ~248 days
      const result = clampFromDate("60m", from, to);
      assert.strictEqual(result.wasClamped, false);
    });

    it("should return original date for unsupported interval", () => {
      const from = new Date("1970-01-01T00:00:00Z");
      const result = clampFromDate("2m", from, to);
      assert.strictEqual(result.wasClamped, false);
      assert.strictEqual(result.clampedFrom.getTime(), from.getTime());
    });

    it("should handle from equal to clamped boundary exactly", () => {
      // Exactly 2000 days before 'to'
      const from = new Date(to);
      from.setDate(from.getDate() - 2000);
      const result = clampFromDate("1d", from, to);
      assert.strictEqual(result.wasClamped, false);
    });

    it("should handle from equal to to", () => {
      const from = new Date(to);
      const result = clampFromDate("1d", from, to);
      assert.strictEqual(result.wasClamped, false);
    });
  });

  describe("Candle Transformation", () => {
    it("should transform Zerodha candles to HistoricalBar format", () => {
      const candles: Array<[string, number, number, number, number, number]> = [
        ["2026-01-15T09:15:00+05:30", 100, 105, 98, 103, 50000],
        ["2026-01-16T09:15:00+05:30", 103, 108, 101, 106, 60000],
      ];

      const bars = transformCandles(candles);

      assert.strictEqual(bars.length, 2);
      assert.strictEqual(bars[0].open, 100);
      assert.strictEqual(bars[0].high, 105);
      assert.strictEqual(bars[0].low, 98);
      assert.strictEqual(bars[0].close, 103);
      assert.strictEqual(bars[0].volume, 50000);
      assert.ok(bars[0].date instanceof Date);
    });

    it("should handle empty candle array", () => {
      const bars = transformCandles([]);
      assert.strictEqual(bars.length, 0);
    });

    it("should handle zero volume candle", () => {
      const candles: Array<[string, number, number, number, number, number]> = [
        ["2026-01-15T09:15:00+05:30", 100, 100, 100, 100, 0],
      ];

      const bars = transformCandles(candles);
      assert.strictEqual(bars[0].volume, 0);
    });

    it("should preserve date as Date object", () => {
      const timestamp = "2026-01-15T09:15:00+05:30";
      const candles: Array<[string, number, number, number, number, number]> = [
        [timestamp, 100, 105, 98, 103, 50000],
      ];

      const bars = transformCandles(candles);
      assert.ok(bars[0].date instanceof Date);
      assert.strictEqual(bars[0].date.getTime(), new Date(timestamp).getTime());
    });
  });

  describe("Quote Change Percent Calculation", () => {
    /**
     * Mirrors the change percent formula from getZerodhaQuote
     */
    function calcChangePercent(netChange: number, close: number): number {
      return close > 0 ? (netChange / close) * 100 : 0;
    }

    it("should calculate positive change percent", () => {
      const result = calcChangePercent(50, 2500);
      assert.strictEqual(result, 2); // 50/2500 * 100 = 2%
    });

    it("should calculate negative change percent", () => {
      const result = calcChangePercent(-50, 2500);
      assert.strictEqual(result, -2);
    });

    it("should return 0 when close is 0", () => {
      const result = calcChangePercent(50, 0);
      assert.strictEqual(result, 0);
    });

    it("should return 0 when no change", () => {
      const result = calcChangePercent(0, 2500);
      assert.strictEqual(result, 0);
    });
  });
});
