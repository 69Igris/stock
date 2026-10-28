/**
 * Yahoo Price Service - Pure Function Tests
 *
 * Tests for the pure utility functions in yahoo-price-service.ts:
 * - hasGaps: detects gaps in price data (5-day threshold)
 * - normalizeDate: normalizes dates to UTC midnight
 * - toHistoricalBar: converts DB record to HistoricalBar (adjClose null→undefined)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Inline types (mirrors yahoo-price-service.ts) ────────────────

interface HistoricalBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose?: number;
}

// ── Inline functions (mirrors yahoo-price-service.ts) ────────────

function hasGaps(
  prices: Array<{ date: Date }>,
  start: Date,
  end: Date
): boolean {
  if (prices.length === 0) return true;

  const first = prices[0];
  const last = prices[prices.length - 1];
  if (!first || !last) return true;

  const firstDate = first.date;
  const lastDate = last.date;

  const daysDiff = (d1: Date, d2: Date) =>
    Math.abs(d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24);

  // If the first available date is more than 5 days after the requested start
  if (daysDiff(firstDate, start) > 5) return true;

  // If the last available date is more than 5 days before the requested end
  if (daysDiff(lastDate, end) > 5) return true;

  // Check for internal gaps (more than 5 days between consecutive entries)
  for (let i = 1; i < prices.length; i++) {
    const current = prices[i];
    const previous = prices[i - 1];
    if (!current || !previous) continue;
    if (daysDiff(current.date, previous.date) > 5) {
      return true;
    }
  }

  return false;
}

function normalizeDate(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function toHistoricalBar(record: {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose: number | null;
}): HistoricalBar {
  return {
    date: record.date,
    open: record.open,
    high: record.high,
    low: record.low,
    close: record.close,
    volume: record.volume,
    adjClose: record.adjClose ?? undefined,
  };
}

// ── Helpers ──────────────────────────────────────────────────────

/** Create a Date for YYYY-MM-DD at UTC midnight */
function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** Generate an array of price entries for consecutive weekdays */
function generateDailyPrices(
  startDate: Date,
  count: number
): Array<{ date: Date }> {
  const prices: Array<{ date: Date }> = [];
  const current = new Date(startDate);
  let added = 0;
  while (added < count) {
    const dayOfWeek = current.getUTCDay();
    // Skip weekends (0=Sun, 6=Sat)
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      prices.push({ date: new Date(current) });
      added++;
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return prices;
}

// ── Tests ────────────────────────────────────────────────────────

describe("Yahoo Price Service - Pure Functions", () => {
  describe("hasGaps", () => {
    it("should return true for empty prices array", () => {
      const start = utcDate(2025, 1, 1);
      const end = utcDate(2025, 1, 31);
      assert.strictEqual(hasGaps([], start, end), true);
    });

    it("should return false when data covers the full range (no gaps)", () => {
      const start = utcDate(2025, 1, 6); // Monday
      const end = utcDate(2025, 1, 10); // Friday
      const prices = generateDailyPrices(start, 5); // Mon-Fri

      assert.strictEqual(hasGaps(prices, start, end), false);
    });

    it("should return true when first date is >5 days after start", () => {
      const start = utcDate(2025, 1, 1); // Wednesday
      // First data point is Jan 8 - 7 days after start
      const prices = [{ date: utcDate(2025, 1, 8) }];
      const end = utcDate(2025, 1, 8);

      assert.strictEqual(hasGaps(prices, start, end), true);
    });

    it("should return false when first date is within 5 days of start", () => {
      const start = utcDate(2025, 1, 1); // Wednesday
      // First data point is Jan 4 - 3 days after start (weekend gap is fine)
      const prices = [
        { date: utcDate(2025, 1, 4) },
        { date: utcDate(2025, 1, 5) },
        { date: utcDate(2025, 1, 6) },
      ];
      const end = utcDate(2025, 1, 6);

      assert.strictEqual(hasGaps(prices, start, end), false);
    });

    it("should return true when last date is >5 days before end", () => {
      const start = utcDate(2025, 1, 6);
      const end = utcDate(2025, 1, 20);
      // Last data point is Jan 10 - 10 days before end
      const prices = generateDailyPrices(utcDate(2025, 1, 6), 5);

      assert.strictEqual(hasGaps(prices, start, end), true);
    });

    it("should return false when last date is within 5 days of end", () => {
      const start = utcDate(2025, 1, 6);
      const end = utcDate(2025, 1, 12); // Sunday
      // Last data point is Jan 10 (Friday) - 2 days before end
      const prices = generateDailyPrices(utcDate(2025, 1, 6), 5);

      assert.strictEqual(hasGaps(prices, start, end), false);
    });

    it("should return true when there is an internal gap >5 days", () => {
      const start = utcDate(2025, 1, 6);
      const end = utcDate(2025, 1, 24);
      // Gap of 8 days between Jan 10 and Jan 20
      const prices = [
        { date: utcDate(2025, 1, 6) },
        { date: utcDate(2025, 1, 7) },
        { date: utcDate(2025, 1, 8) },
        { date: utcDate(2025, 1, 9) },
        { date: utcDate(2025, 1, 10) },
        // Missing Jan 13-17 (weekdays)
        { date: utcDate(2025, 1, 20) },
        { date: utcDate(2025, 1, 21) },
        { date: utcDate(2025, 1, 22) },
        { date: utcDate(2025, 1, 23) },
        { date: utcDate(2025, 1, 24) },
      ];

      assert.strictEqual(hasGaps(prices, start, end), true);
    });

    it("should return false when internal gaps are <=5 days (weekend)", () => {
      const start = utcDate(2025, 1, 6);
      const end = utcDate(2025, 1, 13);
      // Friday Jan 10 to Monday Jan 13 - 3 days gap (weekend)
      const prices = [
        { date: utcDate(2025, 1, 6) },
        { date: utcDate(2025, 1, 7) },
        { date: utcDate(2025, 1, 8) },
        { date: utcDate(2025, 1, 9) },
        { date: utcDate(2025, 1, 10) },
        { date: utcDate(2025, 1, 13) },
      ];

      assert.strictEqual(hasGaps(prices, start, end), false);
    });

    it("should handle exactly 5 days gap (no gap detected)", () => {
      const start = utcDate(2025, 1, 6);
      const end = utcDate(2025, 1, 16);
      // Exactly 5 days between Jan 6 and Jan 11
      const prices = [
        { date: utcDate(2025, 1, 6) },
        { date: utcDate(2025, 1, 11) },
        { date: utcDate(2025, 1, 16) },
      ];

      assert.strictEqual(hasGaps(prices, start, end), false);
    });

    it("should detect gap just over 5 days (5.1 days)", () => {
      const start = utcDate(2025, 1, 6);
      const end = utcDate(2025, 1, 17);
      // 6 days gap between entries
      const prices = [
        { date: utcDate(2025, 1, 6) },
        { date: utcDate(2025, 1, 12) }, // 6 days gap
        { date: utcDate(2025, 1, 17) },
      ];

      assert.strictEqual(hasGaps(prices, start, end), true);
    });

    it("should return true for single entry far from range", () => {
      const start = utcDate(2025, 1, 1);
      const end = utcDate(2025, 1, 31);
      const prices = [{ date: utcDate(2025, 1, 15) }];

      // firstDate (Jan 15) is 14 days after start → gap
      assert.strictEqual(hasGaps(prices, start, end), true);
    });

    it("should return false for single entry within range", () => {
      const start = utcDate(2025, 1, 6);
      const end = utcDate(2025, 1, 10);
      const prices = [{ date: utcDate(2025, 1, 8) }];

      // firstDate 2 days from start, lastDate 2 days from end
      assert.strictEqual(hasGaps(prices, start, end), false);
    });

    it("should handle holiday gap (3-day weekend - no gap)", () => {
      const start = utcDate(2025, 1, 2);
      const end = utcDate(2025, 1, 7);
      // Thu Jan 2, then Mon Jan 6 (Fri Jan 3 is holiday)
      // 4 days gap which is ≤ 5
      const prices = [
        { date: utcDate(2025, 1, 2) },
        { date: utcDate(2025, 1, 6) },
        { date: utcDate(2025, 1, 7) },
      ];

      assert.strictEqual(hasGaps(prices, start, end), false);
    });
  });

  describe("normalizeDate", () => {
    it("should set UTC hours to midnight", () => {
      const date = new Date("2025-06-15T14:30:45.123Z");
      const result = normalizeDate(date);

      assert.strictEqual(result.getUTCHours(), 0);
      assert.strictEqual(result.getUTCMinutes(), 0);
      assert.strictEqual(result.getUTCSeconds(), 0);
      assert.strictEqual(result.getUTCMilliseconds(), 0);
    });

    it("should preserve the date part", () => {
      const date = new Date("2025-06-15T14:30:45.123Z");
      const result = normalizeDate(date);

      assert.strictEqual(result.getUTCFullYear(), 2025);
      assert.strictEqual(result.getUTCMonth(), 5); // June = 5 (0-indexed)
      assert.strictEqual(result.getUTCDate(), 15);
    });

    it("should not mutate the original date", () => {
      const date = new Date("2025-06-15T14:30:45.123Z");
      const originalTime = date.getTime();
      normalizeDate(date);

      assert.strictEqual(date.getTime(), originalTime);
    });

    it("should handle already-normalized dates (idempotent)", () => {
      const date = new Date("2025-06-15T00:00:00.000Z");
      const result = normalizeDate(date);

      assert.strictEqual(result.getTime(), date.getTime());
    });

    it("should handle end-of-day times", () => {
      const date = new Date("2025-06-15T23:59:59.999Z");
      const result = normalizeDate(date);

      assert.strictEqual(result.getUTCHours(), 0);
      assert.strictEqual(result.getUTCDate(), 15);
    });

    it("should handle IST times (UTC+5:30) correctly", () => {
      // 2025-06-15 01:00:00 IST = 2025-06-14 19:30:00 UTC
      const date = new Date("2025-06-14T19:30:00.000Z");
      const result = normalizeDate(date);

      assert.strictEqual(result.getUTCFullYear(), 2025);
      assert.strictEqual(result.getUTCMonth(), 5);
      assert.strictEqual(result.getUTCDate(), 14);
      assert.strictEqual(result.getUTCHours(), 0);
    });
  });

  describe("toHistoricalBar", () => {
    it("should convert DB record with adjClose to HistoricalBar", () => {
      const record = {
        date: new Date("2025-01-15"),
        open: 100,
        high: 110,
        low: 95,
        close: 105,
        volume: 1000000,
        adjClose: 104.5,
      };

      const result = toHistoricalBar(record);

      assert.strictEqual(result.date, record.date);
      assert.strictEqual(result.open, 100);
      assert.strictEqual(result.high, 110);
      assert.strictEqual(result.low, 95);
      assert.strictEqual(result.close, 105);
      assert.strictEqual(result.volume, 1000000);
      assert.strictEqual(result.adjClose, 104.5);
    });

    it("should convert null adjClose to undefined", () => {
      const record = {
        date: new Date("2025-01-15"),
        open: 100,
        high: 110,
        low: 95,
        close: 105,
        volume: 1000000,
        adjClose: null,
      };

      const result = toHistoricalBar(record);

      assert.strictEqual(result.adjClose, undefined);
    });

    it("should convert adjClose of 0 to 0 (not undefined)", () => {
      const record = {
        date: new Date("2025-01-15"),
        open: 100,
        high: 110,
        low: 95,
        close: 105,
        volume: 1000000,
        adjClose: 0,
      };

      const result = toHistoricalBar(record);

      assert.strictEqual(result.adjClose, 0);
    });

    it("should preserve all numeric fields exactly", () => {
      const record = {
        date: new Date("2025-03-20"),
        open: 2534.75,
        high: 2567.9,
        low: 2520.15,
        close: 2555.6,
        volume: 15_432_789,
        adjClose: 2550.25,
      };

      const result = toHistoricalBar(record);

      assert.strictEqual(result.open, 2534.75);
      assert.strictEqual(result.high, 2567.9);
      assert.strictEqual(result.low, 2520.15);
      assert.strictEqual(result.close, 2555.6);
      assert.strictEqual(result.volume, 15_432_789);
      assert.strictEqual(result.adjClose, 2550.25);
    });

    it("should handle zero volume", () => {
      const record = {
        date: new Date("2025-01-15"),
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 0,
        adjClose: null,
      };

      const result = toHistoricalBar(record);
      assert.strictEqual(result.volume, 0);
    });
  });
});
