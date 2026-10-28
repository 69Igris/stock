/**
 * Intraday Bar Service - Pure Function Tests (MONEY-123 Part A)
 *
 * Tests for the diff/transform helpers in
 * packages/core/src/market-data/prices/intraday-bar-service.ts.
 *
 * The Prisma-touching functions (`getIntradayBars`, `upsertIntradayBars`,
 * `backfillIntradayBars`) are exercised by integration tests with a
 * real test database. These tests cover the pure logic that decides
 * which bars to insert vs skip given an existing-set, and the
 * HistoricalBar ↔ IntradayBar shape conversions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ============== INLINED FROM intraday-bar-service.ts ==============

interface HistoricalBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose?: number;
}

// SOURCE: intraday-bar-service.ts → upsertIntradayBars dedup logic
// (extracted from the function body so we can test it without Prisma)
function diffMissingBars(
  bars: HistoricalBar[],
  existingTimes: Set<number>
): HistoricalBar[] {
  return bars.filter((b) => !existingTimes.has(b.date.getTime()));
}

// SOURCE: intraday-bar-service.ts → upsertIntradayBars min/max range
function computeBarTimeRange(bars: HistoricalBar[]): {
  minTime: Date;
  maxTime: Date;
} | null {
  if (bars.length === 0) return null;
  const times = bars.map((b) => b.date.getTime());
  return {
    minTime: new Date(Math.min(...times)),
    maxTime: new Date(Math.max(...times)),
  };
}

// SOURCE: intraday-bar-service.ts → toHistoricalBar
function toHistoricalBar(row: {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}): HistoricalBar {
  return {
    date: row.time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  };
}

// ============== TEST HELPERS ==============

function makeBar(
  isoTime: string,
  prices: { o: number; h: number; l: number; c: number; v?: number }
): HistoricalBar {
  return {
    date: new Date(isoTime),
    open: prices.o,
    high: prices.h,
    low: prices.l,
    close: prices.c,
    volume: prices.v ?? 0,
  };
}

// ============== diffMissingBars ==============

describe("diffMissingBars", () => {
  it("returns all bars when nothing exists", () => {
    const input = [
      makeBar("2026-04-08T09:15:00Z", { o: 1000, h: 1010, l: 999, c: 1005 }),
      makeBar("2026-04-08T09:20:00Z", { o: 1005, h: 1015, l: 1003, c: 1012 }),
    ];
    const missing = diffMissingBars(input, new Set());
    assert.equal(missing.length, 2);
  });

  it("returns empty when every bar already exists", () => {
    const input = [
      makeBar("2026-04-08T09:15:00Z", { o: 1, h: 1, l: 1, c: 1 }),
      makeBar("2026-04-08T09:20:00Z", { o: 1, h: 1, l: 1, c: 1 }),
    ];
    const existing = new Set(input.map((b) => b.date.getTime()));
    const missing = diffMissingBars(input, existing);
    assert.equal(missing.length, 0);
  });

  it("returns only the bars not in the existing set", () => {
    const t1 = "2026-04-08T09:15:00.000Z";
    const t2 = "2026-04-08T09:20:00.000Z";
    const t3 = "2026-04-08T09:25:00.000Z";
    const input = [
      makeBar(t1, { o: 1, h: 1, l: 1, c: 1 }),
      makeBar(t2, { o: 1, h: 1, l: 1, c: 1 }),
      makeBar(t3, { o: 1, h: 1, l: 1, c: 1 }),
    ];
    const existing = new Set([new Date(t2).getTime()]);
    const missing = diffMissingBars(input, existing);
    assert.equal(missing.length, 2);
    assert.equal(missing[0]!.date.toISOString(), t1);
    assert.equal(missing[1]!.date.toISOString(), t3);
  });

  it("preserves bar payload (open/high/low/close/volume) on returned subset", () => {
    const input = [
      makeBar("2026-04-08T09:15:00Z", {
        o: 1000,
        h: 1010,
        l: 999,
        c: 1005,
        v: 50,
      }),
    ];
    const missing = diffMissingBars(input, new Set());
    assert.deepEqual(
      {
        o: missing[0]!.open,
        h: missing[0]!.high,
        l: missing[0]!.low,
        c: missing[0]!.close,
        v: missing[0]!.volume,
      },
      { o: 1000, h: 1010, l: 999, c: 1005, v: 50 }
    );
  });
});

// ============== computeBarTimeRange ==============

describe("computeBarTimeRange", () => {
  it("returns null for empty input", () => {
    assert.equal(computeBarTimeRange([]), null);
  });

  it("returns identical min and max for a single bar", () => {
    const bars = [makeBar("2026-04-08T09:15:00Z", { o: 1, h: 1, l: 1, c: 1 })];
    const range = computeBarTimeRange(bars);
    assert.notEqual(range, null);
    assert.equal(range!.minTime.getTime(), range!.maxTime.getTime());
  });

  it("computes correct min and max from a sorted batch", () => {
    const bars = [
      makeBar("2026-04-08T09:15:00Z", { o: 1, h: 1, l: 1, c: 1 }),
      makeBar("2026-04-08T09:20:00Z", { o: 1, h: 1, l: 1, c: 1 }),
      makeBar("2026-04-08T09:25:00Z", { o: 1, h: 1, l: 1, c: 1 }),
    ];
    const range = computeBarTimeRange(bars)!;
    assert.equal(range.minTime.toISOString(), "2026-04-08T09:15:00.000Z");
    assert.equal(range.maxTime.toISOString(), "2026-04-08T09:25:00.000Z");
  });

  it("computes correct min and max from an UNSORTED batch", () => {
    const bars = [
      makeBar("2026-04-08T09:25:00Z", { o: 1, h: 1, l: 1, c: 1 }),
      makeBar("2026-04-08T09:15:00Z", { o: 1, h: 1, l: 1, c: 1 }),
      makeBar("2026-04-08T09:20:00Z", { o: 1, h: 1, l: 1, c: 1 }),
    ];
    const range = computeBarTimeRange(bars)!;
    assert.equal(range.minTime.toISOString(), "2026-04-08T09:15:00.000Z");
    assert.equal(range.maxTime.toISOString(), "2026-04-08T09:25:00.000Z");
  });
});

// ============== toHistoricalBar ==============

describe("toHistoricalBar", () => {
  it("maps IntradayBar row → HistoricalBar (renames time → date)", () => {
    const row = {
      time: new Date("2026-04-08T09:15:00Z"),
      open: 1000,
      high: 1010,
      low: 999,
      close: 1005,
      volume: 50,
    };
    const bar = toHistoricalBar(row);
    assert.equal(bar.date.getTime(), row.time.getTime());
    assert.equal(bar.open, 1000);
    assert.equal(bar.high, 1010);
    assert.equal(bar.low, 999);
    assert.equal(bar.close, 1005);
    assert.equal(bar.volume, 50);
  });

  it("does not include adjClose (intraday bars don't have it)", () => {
    const row = {
      time: new Date("2026-04-08T09:15:00Z"),
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 0,
    };
    const bar = toHistoricalBar(row);
    assert.equal(bar.adjClose, undefined);
  });
});

// ============== INTEGRATION ASSERTIONS (logic invariants) ==============

describe("upsertIntradayBars logic invariants", () => {
  it("a fresh batch produces N inserts and 0 skips", () => {
    const bars = [
      makeBar("2026-04-08T09:15:00Z", { o: 1, h: 1, l: 1, c: 1 }),
      makeBar("2026-04-08T09:20:00Z", { o: 1, h: 1, l: 1, c: 1 }),
    ];
    const existing = new Set<number>();
    const missing = diffMissingBars(bars, existing);
    assert.equal(missing.length, 2);
    assert.equal(bars.length - missing.length, 0); // skipped
  });

  it("a batch where everything already exists produces 0 inserts and N skips", () => {
    const bars = [
      makeBar("2026-04-08T09:15:00Z", { o: 1, h: 1, l: 1, c: 1 }),
      makeBar("2026-04-08T09:20:00Z", { o: 1, h: 1, l: 1, c: 1 }),
    ];
    const existing = new Set(bars.map((b) => b.date.getTime()));
    const missing = diffMissingBars(bars, existing);
    assert.equal(missing.length, 0);
    assert.equal(bars.length - missing.length, 2); // skipped
  });

  it("partial overlap counts inserts + skips correctly", () => {
    const bars = [
      makeBar("2026-04-08T09:15:00Z", { o: 1, h: 1, l: 1, c: 1 }),
      makeBar("2026-04-08T09:20:00Z", { o: 1, h: 1, l: 1, c: 1 }),
      makeBar("2026-04-08T09:25:00Z", { o: 1, h: 1, l: 1, c: 1 }),
      makeBar("2026-04-08T09:30:00Z", { o: 1, h: 1, l: 1, c: 1 }),
    ];
    const existing = new Set([
      new Date("2026-04-08T09:20:00Z").getTime(),
      new Date("2026-04-08T09:25:00Z").getTime(),
    ]);
    const missing = diffMissingBars(bars, existing);
    assert.equal(missing.length, 2); // 09:15 + 09:30
    assert.equal(bars.length - missing.length, 2); // skipped: 09:20 + 09:25
  });
});

// ====== Shared-cache source guard (MONEY-566 Zerodha compliance) ======
//
// IntradayBar / DailyPrice are cross-user caches (the UDF history route reads
// them back and serves them to any user). assertPublicPriceSource is the
// structural guard at the write chokepoint: a broker source (ZERODHA) must
// never be persisted to a shared cache. Inlined from intraday-bar-service.ts.

describe("assertPublicPriceSource (shared-cache source guard)", () => {
  const PUBLIC_PRICE_SOURCES = new Set(["YAHOO"]);
  function assertPublicPriceSource(source: string): void {
    if (!PUBLIC_PRICE_SOURCES.has(source.toUpperCase())) {
      throw new Error(
        `refusing to persist source="${source}" to a shared price cache`
      );
    }
  }

  it("allows the public source YAHOO (case-insensitive)", () => {
    assert.doesNotThrow(() => assertPublicPriceSource("YAHOO"));
    assert.doesNotThrow(() => assertPublicPriceSource("yahoo"));
  });

  it("THROWS on ZERODHA — a broker source must never enter a shared cache", () => {
    assert.throws(
      () => assertPublicPriceSource("ZERODHA"),
      /refusing to persist/
    );
    assert.throws(
      () => assertPublicPriceSource("zerodha"),
      /refusing to persist/
    );
  });

  it("THROWS on any other non-public source (other brokers, junk)", () => {
    for (const s of ["UPSTOX", "FYERS", "ANGEL", "broker", "ZERODHA "]) {
      assert.throws(() => assertPublicPriceSource(s), /refusing to persist/);
    }
  });
});
