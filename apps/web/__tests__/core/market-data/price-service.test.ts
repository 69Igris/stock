/**
 * Price Service Tests
 *
 * Tests the REAL pure logic extracted from:
 *   packages/core/src/market-data/prices/quote-service.ts → quote-logic.ts
 *     (isFresh, DEFAULT_QUOTE_TTL_MS)
 *   packages/core/src/market-data/prices/yahoo-price-service.ts → yahoo-price-logic.ts
 *     (normalizeDate, hasGaps, toHistoricalBar)
 *
 * Both service modules import and call these, so this exercises production code
 * (no inline reimplementation, no DB/network).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isFresh,
  DEFAULT_QUOTE_TTL_MS,
} from "@usemoney/core/market-data/prices/quote-logic";
import {
  normalizeDate,
  hasGaps,
  toHistoricalBar,
  type DailyPriceRecord,
} from "@usemoney/core/market-data/prices/yahoo-price-logic";

function createMockDailyPrice(
  overrides: Partial<DailyPriceRecord> = {}
): DailyPriceRecord {
  return {
    date: new Date("2025-01-15T00:00:00Z"),
    open: 2480.0,
    high: 2520.0,
    low: 2475.0,
    close: 2500.0,
    volume: 1500000,
    adjClose: 2500.0,
    ...overrides,
  };
}

function createDatePrices(dates: string[]): Array<{ date: Date }> {
  return dates.map((d) => ({ date: new Date(d) }));
}

describe("Price Service (real source)", () => {
  // ────────────────────────────────────────────────────────────────
  // isFresh() - TTL Checking
  // ────────────────────────────────────────────────────────────────
  describe("isFresh() - TTL Checking", () => {
    it("should consider data fresh when updated just now", () => {
      assert.strictEqual(isFresh(new Date(), DEFAULT_QUOTE_TTL_MS), true);
    });

    it("should consider data fresh when updated 30 seconds ago (within 60s TTL)", () => {
      assert.strictEqual(
        isFresh(new Date(Date.now() - 30_000), DEFAULT_QUOTE_TTL_MS),
        true
      );
    });

    it("should consider data fresh at 59 seconds (just within 60s TTL)", () => {
      assert.strictEqual(
        isFresh(new Date(Date.now() - 59_000), DEFAULT_QUOTE_TTL_MS),
        true
      );
    });

    it("should consider data stale at 61 seconds (just past 60s TTL)", () => {
      assert.strictEqual(
        isFresh(new Date(Date.now() - 61_000), DEFAULT_QUOTE_TTL_MS),
        false
      );
    });

    it("should consider data stale when updated 5 minutes ago", () => {
      assert.strictEqual(
        isFresh(new Date(Date.now() - 5 * 60 * 1000), DEFAULT_QUOTE_TTL_MS),
        false
      );
    });

    it("should consider data stale when updated 1 hour ago", () => {
      assert.strictEqual(
        isFresh(new Date(Date.now() - 60 * 60 * 1000), DEFAULT_QUOTE_TTL_MS),
        false
      );
    });

    it("should handle custom TTL of 5 minutes", () => {
      const customTTL = 5 * 60 * 1000;
      assert.strictEqual(
        isFresh(new Date(Date.now() - 3 * 60 * 1000), customTTL),
        true
      );
      assert.strictEqual(
        isFresh(new Date(Date.now() - 6 * 60 * 1000), customTTL),
        false
      );
    });

    it("should handle TTL of 0 (always stale)", () => {
      // elapsed >= 0, never < 0
      assert.strictEqual(isFresh(new Date(), 0), false);
    });

    it("should handle very large TTL (always fresh for practical purposes)", () => {
      const largeTTL = 30 * 24 * 60 * 60 * 1000;
      assert.strictEqual(
        isFresh(new Date(Date.now() - 24 * 60 * 60 * 1000), largeTTL),
        true
      );
    });

    it("should handle future date (always fresh)", () => {
      assert.strictEqual(
        isFresh(new Date(Date.now() + 60_000), DEFAULT_QUOTE_TTL_MS),
        true
      );
    });

    it("should consider epoch date as stale", () => {
      assert.strictEqual(isFresh(new Date(0), DEFAULT_QUOTE_TTL_MS), false);
    });

    it("should define DEFAULT_QUOTE_TTL_MS as 60 seconds", () => {
      assert.strictEqual(DEFAULT_QUOTE_TTL_MS, 60_000);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // normalizeDate() - UTC Midnight
  // ────────────────────────────────────────────────────────────────
  describe("normalizeDate() - UTC Midnight", () => {
    it("should normalize a date to UTC midnight", () => {
      const normalized = normalizeDate(new Date("2025-01-15T14:30:45.123Z"));
      assert.strictEqual(normalized.getUTCHours(), 0);
      assert.strictEqual(normalized.getUTCMinutes(), 0);
      assert.strictEqual(normalized.getUTCSeconds(), 0);
      assert.strictEqual(normalized.getUTCMilliseconds(), 0);
    });

    it("should preserve the date portion", () => {
      const normalized = normalizeDate(new Date("2025-06-20T23:59:59.999Z"));
      assert.strictEqual(normalized.getUTCFullYear(), 2025);
      assert.strictEqual(normalized.getUTCMonth(), 5); // June
      assert.strictEqual(normalized.getUTCDate(), 20);
    });

    it("should handle a date already at midnight", () => {
      const input = new Date("2025-01-15T00:00:00.000Z");
      assert.strictEqual(normalizeDate(input).getTime(), input.getTime());
    });

    it("should not mutate the original date", () => {
      const input = new Date("2025-01-15T14:30:45.123Z");
      const originalTime = input.getTime();
      normalizeDate(input);
      assert.strictEqual(input.getTime(), originalTime);
    });

    it("should handle epoch date", () => {
      assert.strictEqual(normalizeDate(new Date(0)).getTime(), 0);
    });

    it("should normalize date at end of day", () => {
      const normalized = normalizeDate(new Date("2025-03-01T23:59:59.999Z"));
      assert.strictEqual(normalized.getUTCHours(), 0);
      assert.strictEqual(normalized.getUTCDate(), 1);
      assert.strictEqual(normalized.getUTCMonth(), 2); // March
    });

    it("should normalize date at start of day with milliseconds", () => {
      const normalized = normalizeDate(new Date("2025-01-01T00:00:00.001Z"));
      assert.strictEqual(normalized.getUTCMilliseconds(), 0);
    });

    it("should handle dates far in the past", () => {
      const normalized = normalizeDate(new Date("2000-01-01T12:00:00Z"));
      assert.strictEqual(normalized.getUTCFullYear(), 2000);
      assert.strictEqual(normalized.getUTCHours(), 0);
    });

    it("should handle dates far in the future", () => {
      const normalized = normalizeDate(new Date("2099-12-31T18:45:30Z"));
      assert.strictEqual(normalized.getUTCFullYear(), 2099);
      assert.strictEqual(normalized.getUTCMonth(), 11); // December
      assert.strictEqual(normalized.getUTCDate(), 31);
      assert.strictEqual(normalized.getUTCHours(), 0);
    });

    it("should return a new Date instance (not the same reference)", () => {
      const input = new Date("2025-01-15T00:00:00Z");
      assert.notStrictEqual(input, normalizeDate(input));
    });

    it("should handle leap year date", () => {
      const normalized = normalizeDate(new Date("2024-02-29T15:30:00Z"));
      assert.strictEqual(normalized.getUTCMonth(), 1); // February
      assert.strictEqual(normalized.getUTCDate(), 29);
      assert.strictEqual(normalized.getUTCHours(), 0);
    });

    it("should handle year boundary correctly", () => {
      const normalized = normalizeDate(new Date("2024-12-31T23:59:59.999Z"));
      assert.strictEqual(normalized.getUTCFullYear(), 2024);
      assert.strictEqual(normalized.getUTCMonth(), 11);
      assert.strictEqual(normalized.getUTCDate(), 31);
      assert.strictEqual(normalized.getUTCHours(), 0);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // hasGaps() - Gap Detection
  // ────────────────────────────────────────────────────────────────
  describe("hasGaps() - Gap Detection", () => {
    it("should return true for empty prices array", () => {
      assert.strictEqual(
        hasGaps([], new Date("2025-01-01"), new Date("2025-01-31")),
        true
      );
    });

    it("should return false for consecutive trading days (no gaps)", () => {
      const prices = createDatePrices([
        "2025-01-06T00:00:00Z",
        "2025-01-07T00:00:00Z",
        "2025-01-08T00:00:00Z",
        "2025-01-09T00:00:00Z",
        "2025-01-10T00:00:00Z",
      ]);
      assert.strictEqual(
        hasGaps(
          prices,
          new Date("2025-01-06T00:00:00Z"),
          new Date("2025-01-10T00:00:00Z")
        ),
        false
      );
    });

    it("should return false for data with weekend gaps (2 days)", () => {
      const prices = createDatePrices([
        "2025-01-06T00:00:00Z",
        "2025-01-07T00:00:00Z",
        "2025-01-08T00:00:00Z",
        "2025-01-09T00:00:00Z",
        "2025-01-10T00:00:00Z",
        "2025-01-13T00:00:00Z",
      ]);
      assert.strictEqual(
        hasGaps(
          prices,
          new Date("2025-01-06T00:00:00Z"),
          new Date("2025-01-13T00:00:00Z")
        ),
        false
      );
    });

    it("should return false for data with holiday gap (5 days, at threshold)", () => {
      const prices = createDatePrices([
        "2025-01-06T00:00:00Z",
        "2025-01-07T00:00:00Z",
        "2025-01-08T00:00:00Z",
        "2025-01-13T00:00:00Z", // 5 days gap from Jan 8
        "2025-01-14T00:00:00Z",
      ]);
      assert.strictEqual(
        hasGaps(
          prices,
          new Date("2025-01-06T00:00:00Z"),
          new Date("2025-01-14T00:00:00Z")
        ),
        false
      );
    });

    it("should return true for internal gap of 6+ days", () => {
      const prices = createDatePrices([
        "2025-01-06T00:00:00Z",
        "2025-01-07T00:00:00Z",
        "2025-01-14T00:00:00Z", // 7 days gap
        "2025-01-17T00:00:00Z",
      ]);
      assert.strictEqual(
        hasGaps(
          prices,
          new Date("2025-01-06T00:00:00Z"),
          new Date("2025-01-17T00:00:00Z")
        ),
        true
      );
    });

    it("should return true when first date is more than 5 days after start", () => {
      const prices = createDatePrices([
        "2025-01-08T00:00:00Z", // 7 days after start
        "2025-01-09T00:00:00Z",
        "2025-01-10T00:00:00Z",
        "2025-01-13T00:00:00Z",
        "2025-01-14T00:00:00Z",
        "2025-01-15T00:00:00Z",
      ]);
      assert.strictEqual(
        hasGaps(
          prices,
          new Date("2025-01-01T00:00:00Z"),
          new Date("2025-01-15T00:00:00Z")
        ),
        true
      );
    });

    it("should return true when last date is more than 5 days before end", () => {
      const prices = createDatePrices([
        "2025-01-06T00:00:00Z",
        "2025-01-07T00:00:00Z",
        "2025-01-08T00:00:00Z",
        "2025-01-09T00:00:00Z",
        "2025-01-10T00:00:00Z",
      ]);
      assert.strictEqual(
        hasGaps(
          prices,
          new Date("2025-01-06T00:00:00Z"),
          new Date("2025-01-20T00:00:00Z")
        ),
        true
      );
    });

    it("should return false when first date is exactly 5 days after start", () => {
      const prices = createDatePrices([
        "2025-01-06T00:00:00Z", // exactly 5 days after Jan 1
        "2025-01-07T00:00:00Z",
        "2025-01-08T00:00:00Z",
        "2025-01-09T00:00:00Z",
        "2025-01-10T00:00:00Z",
      ]);
      assert.strictEqual(
        hasGaps(
          prices,
          new Date("2025-01-01T00:00:00Z"),
          new Date("2025-01-10T00:00:00Z")
        ),
        false
      );
    });

    it("should return false when last date is exactly 5 days before end", () => {
      const prices = createDatePrices([
        "2025-01-06T00:00:00Z",
        "2025-01-07T00:00:00Z",
        "2025-01-08T00:00:00Z",
        "2025-01-09T00:00:00Z",
        "2025-01-10T00:00:00Z", // exactly 5 days before Jan 15
      ]);
      assert.strictEqual(
        hasGaps(
          prices,
          new Date("2025-01-06T00:00:00Z"),
          new Date("2025-01-15T00:00:00Z")
        ),
        false
      );
    });

    it("should return true for single price entry far from start", () => {
      assert.strictEqual(
        hasGaps(
          createDatePrices(["2025-01-15T00:00:00Z"]),
          new Date("2025-01-01T00:00:00Z"),
          new Date("2025-01-31T00:00:00Z")
        ),
        true
      );
    });

    it("should return false for single entry within 5 days of both boundaries", () => {
      assert.strictEqual(
        hasGaps(
          createDatePrices(["2025-01-12T00:00:00Z"]),
          new Date("2025-01-10T00:00:00Z"),
          new Date("2025-01-15T00:00:00Z")
        ),
        false
      );
    });

    it("should handle large dataset with no gaps", () => {
      const dates: string[] = [];
      for (let d = 1; d <= 31; d++) {
        dates.push(`2025-01-${d.toString().padStart(2, "0")}T00:00:00Z`);
      }
      assert.strictEqual(
        hasGaps(
          createDatePrices(dates),
          new Date("2025-01-01T00:00:00Z"),
          new Date("2025-01-31T00:00:00Z")
        ),
        false
      );
    });

    it("exactly 5.01 days internal gap should be detected", () => {
      const date1 = new Date("2025-01-01T00:00:00Z");
      const date2 = new Date(date1.getTime() + 5.01 * 24 * 60 * 60 * 1000);
      const date3 = new Date("2025-01-10T00:00:00Z");
      assert.strictEqual(
        hasGaps(
          [{ date: date1 }, { date: date2 }, { date: date3 }],
          new Date("2025-01-01T00:00:00Z"),
          new Date("2025-01-10T00:00:00Z")
        ),
        true
      );
    });

    it("exactly 5.0 days internal gap should NOT be detected", () => {
      const date1 = new Date("2025-01-01T00:00:00Z");
      const date2 = new Date(date1.getTime() + 5.0 * 24 * 60 * 60 * 1000);
      const dateEnd = new Date("2025-01-10T00:00:00Z");
      assert.strictEqual(
        hasGaps(
          [{ date: date1 }, { date: date2 }, { date: dateEnd }],
          new Date("2025-01-01T00:00:00Z"),
          new Date("2025-01-10T00:00:00Z")
        ),
        false
      );
    });

    it("two entries with same date should have no gap", () => {
      assert.strictEqual(
        hasGaps(
          [
            { date: new Date("2025-01-15T00:00:00Z") },
            { date: new Date("2025-01-15T00:00:00Z") },
          ],
          new Date("2025-01-15T00:00:00Z"),
          new Date("2025-01-15T00:00:00Z")
        ),
        false
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // toHistoricalBar() - Conversion
  // ────────────────────────────────────────────────────────────────
  describe("toHistoricalBar() - Conversion", () => {
    it("should convert a full DailyPriceRecord to HistoricalBar", () => {
      const record = createMockDailyPrice();
      const bar = toHistoricalBar(record);
      assert.strictEqual(bar.date, record.date);
      assert.strictEqual(bar.open, 2480.0);
      assert.strictEqual(bar.high, 2520.0);
      assert.strictEqual(bar.low, 2475.0);
      assert.strictEqual(bar.close, 2500.0);
      assert.strictEqual(bar.volume, 1500000);
      assert.strictEqual(bar.adjClose, 2500.0);
    });

    it("should convert null adjClose to undefined", () => {
      const bar = toHistoricalBar(createMockDailyPrice({ adjClose: null }));
      assert.strictEqual(bar.adjClose, undefined);
    });

    it("should preserve the date reference", () => {
      const date = new Date("2025-01-15T00:00:00Z");
      const bar = toHistoricalBar(createMockDailyPrice({ date }));
      assert.strictEqual(bar.date, date);
    });

    it("should handle zero values correctly", () => {
      const bar = toHistoricalBar(
        createMockDailyPrice({
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          volume: 0,
          adjClose: 0,
        })
      );
      assert.strictEqual(bar.open, 0);
      assert.strictEqual(bar.high, 0);
      assert.strictEqual(bar.low, 0);
      assert.strictEqual(bar.close, 0);
      assert.strictEqual(bar.volume, 0);
      assert.strictEqual(bar.adjClose, 0);
    });

    it("should handle very large numbers", () => {
      const bar = toHistoricalBar(
        createMockDailyPrice({
          open: 100000.5,
          high: 100500.75,
          low: 99500.25,
          close: 100250.0,
          volume: 99999999999,
        })
      );
      assert.strictEqual(bar.open, 100000.5);
      assert.strictEqual(bar.volume, 99999999999);
    });

    it("should handle decimal precision", () => {
      const bar = toHistoricalBar(
        createMockDailyPrice({ open: 2500.123456, close: 2500.654321 })
      );
      assert.strictEqual(bar.open, 2500.123456);
      assert.strictEqual(bar.close, 2500.654321);
    });

    it("should preserve all fields from a realistic record", () => {
      const bar = toHistoricalBar({
        date: new Date("2025-01-15T00:00:00Z"),
        open: 2480.05,
        high: 2521.3,
        low: 2472.1,
        close: 2505.85,
        volume: 15234567,
        adjClose: 2505.85,
      });
      assert.strictEqual(bar.open, 2480.05);
      assert.strictEqual(bar.high, 2521.3);
      assert.strictEqual(bar.low, 2472.1);
      assert.strictEqual(bar.close, 2505.85);
      assert.strictEqual(bar.volume, 15234567);
      assert.strictEqual(bar.adjClose, 2505.85);
    });
  });
});
