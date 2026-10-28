/**
 * Price Sync Processor Tests (workers/src/processors/price-sync.ts) — DE-SHADOWED.
 *
 * The previous version SHADOWED the processor: it declared a local
 * `async function processPriceSync` "(mirrors processPriceSync...)" plus local
 * copies of the bogus-change transform + rate-limit math, and asserted the
 * COPIES against a hand-rolled mock-prisma. No real worker symbol was imported.
 *
 * This rewrite asserts ONLY real shipped code: the pure helpers exported from
 * `workers/src/processors/price-sync-logic.ts`, which `price-sync.ts` now CALLS —
 * `resolveSyncType` (PRICE_BACKFILL vs QUOTE_REFRESH), `resolveIncrementalDateRange`
 * (the rolling window + `Math.max(1, days)` floor), `transformRawQuote` (the
 * bogus-change suppression + the FINITE-guarded timestamp bug fix),
 * `selectBackfillInstruments` (the in-memory id/type filter), and
 * `shouldDelay` / `shouldLogProgress` (the loop cadence). The processor imports
 * Prisma + Yahoo at module load, so it can't run in a pure unit test; the
 * orchestration harness below mirrors only its sync-log call SEQUENCE, building
 * every decision via the SAME real exports.
 *
 * Regression coverage for the bug fixed alongside this de-shadow:
 *  - Non-finite timestamp: a NaN/Infinity `regularMarketTime` (still
 *    `typeof "number"`) no longer produces an Invalid Date — it falls back to now.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL worker orchestration helpers under test (no shadow). price-sync.ts CALLS these.
import {
  resolveSyncType,
  resolveIncrementalDateRange,
  transformRawQuote,
  selectBackfillInstruments,
  shouldDelay,
  shouldLogProgress,
  DEFAULT_INCREMENTAL_DAYS,
  QUOTE_REFRESH_BATCH_SIZE,
  BACKFILL_INSTRUMENT_TYPES,
} from "../../../../workers/src/processors/price-sync-logic";
import type { YahooRawQuote } from "@usemoney/core/market-data";

// ══════════════════════════════════════════════════════════════════════
// resolveSyncType (real export)
// ══════════════════════════════════════════════════════════════════════

describe("price-sync-logic.resolveSyncType (real export)", () => {
  it("classifies a dateRange as PRICE_BACKFILL", () => {
    assert.strictEqual(
      resolveSyncType({ start: "2025-01-01", end: "2025-12-31" }),
      "PRICE_BACKFILL"
    );
  });

  it("classifies no dateRange (undefined) as QUOTE_REFRESH", () => {
    assert.strictEqual(resolveSyncType(undefined), "QUOTE_REFRESH");
  });

  it("classifies null as QUOTE_REFRESH", () => {
    assert.strictEqual(resolveSyncType(null), "QUOTE_REFRESH");
  });
});

// ══════════════════════════════════════════════════════════════════════
// resolveIncrementalDateRange — rolling window + day floor (real export)
// ══════════════════════════════════════════════════════════════════════

describe("price-sync-logic.resolveIncrementalDateRange (real export)", () => {
  it("computes a window ending at 'now' and starting N days earlier", () => {
    const now = new Date("2026-06-06T00:00:00.000Z");
    const r = resolveIncrementalDateRange(30, now);
    assert.strictEqual(r.end, now.toISOString());
    assert.strictEqual(
      r.start,
      new Date("2026-05-07T00:00:00.000Z").toISOString()
    );
  });

  it("defaults to a 30-day window", () => {
    const now = new Date("2026-06-06T00:00:00.000Z");
    const r = resolveIncrementalDateRange(undefined, now);
    assert.strictEqual(
      r.start,
      new Date("2026-05-07T00:00:00.000Z").toISOString()
    );
    assert.strictEqual(DEFAULT_INCREMENTAL_DAYS, 30);
  });

  it("floors a 0-day request to a 1-day window (never empty/inverted)", () => {
    const now = new Date("2026-06-06T00:00:00.000Z");
    const r = resolveIncrementalDateRange(0, now);
    assert.strictEqual(
      r.start,
      new Date("2026-06-05T00:00:00.000Z").toISOString()
    );
    assert.ok(new Date(r.start) < new Date(r.end));
  });

  it("floors a negative-day request to a 1-day window", () => {
    const now = new Date("2026-06-06T00:00:00.000Z");
    const r = resolveIncrementalDateRange(-10, now);
    assert.strictEqual(
      r.start,
      new Date("2026-06-05T00:00:00.000Z").toISOString()
    );
    assert.ok(new Date(r.start) < new Date(r.end));
  });

  it("falls back to the default window for a non-finite day count", () => {
    const now = new Date("2026-06-06T00:00:00.000Z");
    const r = resolveIncrementalDateRange(Number.NaN, now);
    assert.strictEqual(
      r.start,
      new Date("2026-05-07T00:00:00.000Z").toISOString()
    );
  });

  it("always yields valid ISO timestamps (never Invalid Date)", () => {
    const r = resolveIncrementalDateRange(7);
    assert.ok(!Number.isNaN(Date.parse(r.start)));
    assert.ok(!Number.isNaN(Date.parse(r.end)));
  });
});

// ══════════════════════════════════════════════════════════════════════
// transformRawQuote — bogus-change + FINITE-guarded timestamp (real export)
// ══════════════════════════════════════════════════════════════════════

function rawQuote(overrides: Partial<YahooRawQuote> = {}): YahooRawQuote {
  return {
    symbol: "TEST.NS",
    regularMarketPrice: 100,
    regularMarketPreviousClose: 95,
    ...overrides,
  } as YahooRawQuote;
}

describe("price-sync-logic.transformRawQuote — bogus change (real export)", () => {
  it("zeros change when previousClose is 0 and price > 0 (fresh listing)", () => {
    const r = transformRawQuote(
      "NEW.NS",
      rawQuote({
        regularMarketPrice: 150,
        regularMarketPreviousClose: 0,
        regularMarketChange: 150,
        regularMarketChangePercent: 100,
      })
    );
    assert.strictEqual(r.change, 0);
    assert.strictEqual(r.changePercent, 0);
    assert.strictEqual(r.price, 150);
  });

  it("zeros change when previousClose is undefined and price > 0 (IPO)", () => {
    const r = transformRawQuote(
      "IPO.NS",
      rawQuote({
        regularMarketPrice: 200,
        regularMarketPreviousClose: undefined,
        regularMarketChange: 200,
        regularMarketChangePercent: 100,
      })
    );
    assert.strictEqual(r.change, 0);
    assert.strictEqual(r.changePercent, 0);
  });

  it("preserves a real change when previousClose is valid", () => {
    const r = transformRawQuote(
      "RELIANCE.NS",
      rawQuote({
        regularMarketPrice: 2550,
        regularMarketPreviousClose: 2500,
        regularMarketChange: 50,
        regularMarketChangePercent: 2.0,
      })
    );
    assert.strictEqual(r.change, 50);
    assert.strictEqual(r.changePercent, 2.0);
  });

  it("does not flag bogus when both price and previousClose are 0", () => {
    const r = transformRawQuote(
      "DEFUNCT.NS",
      rawQuote({
        regularMarketPrice: 0,
        regularMarketPreviousClose: 0,
        regularMarketChange: 0,
      })
    );
    assert.strictEqual(r.change, 0);
  });

  it("defaults open/high/low/volume to 0 when missing", () => {
    const r = transformRawQuote("TEST.NS", rawQuote());
    assert.strictEqual(r.open, 0);
    assert.strictEqual(r.high, 0);
    assert.strictEqual(r.low, 0);
    assert.strictEqual(r.volume, 0);
  });

  it("passes marketCap through, leaving it undefined when absent", () => {
    assert.strictEqual(
      transformRawQuote("REL.NS", rawQuote({ marketCap: 17_000_000_000_000 }))
        .marketCap,
      17_000_000_000_000
    );
    assert.strictEqual(
      transformRawQuote("TEST.NS", rawQuote()).marketCap,
      undefined
    );
  });
});

describe("price-sync-logic.transformRawQuote — timestamp (real export, BUG-FIX)", () => {
  it("converts a finite Unix-seconds time to a Date", () => {
    const unix = 1706787600;
    const r = transformRawQuote(
      "TEST.NS",
      rawQuote({ regularMarketTime: unix })
    );
    assert.strictEqual(r.timestamp.getTime(), unix * 1000);
  });

  it("falls back to 'now' when the time is missing", () => {
    const before = Date.now();
    const r = transformRawQuote("TEST.NS", rawQuote());
    const after = Date.now();
    assert.ok(r.timestamp.getTime() >= before);
    assert.ok(r.timestamp.getTime() <= after);
  });

  it("REGRESSION: a NaN time falls back to a VALID 'now' (never Invalid Date)", () => {
    const before = Date.now();
    const r = transformRawQuote(
      "TEST.NS",
      rawQuote({ regularMarketTime: Number.NaN })
    );
    const after = Date.now();
    assert.ok(
      !Number.isNaN(r.timestamp.getTime()),
      "timestamp must be a valid Date"
    );
    assert.ok(r.timestamp.getTime() >= before);
    assert.ok(r.timestamp.getTime() <= after);
  });

  it("REGRESSION: an Infinity time falls back to a VALID 'now'", () => {
    const r = transformRawQuote(
      "TEST.NS",
      rawQuote({ regularMarketTime: Number.POSITIVE_INFINITY })
    );
    assert.ok(!Number.isNaN(r.timestamp.getTime()));
    // And the fallback Date serializes cleanly (the old Invalid Date would throw).
    assert.doesNotThrow(() => r.timestamp.toISOString());
  });
});

// ══════════════════════════════════════════════════════════════════════
// selectBackfillInstruments — in-memory id/type filter (real export)
// ══════════════════════════════════════════════════════════════════════

const INSTS = [
  { id: "i-1", yahooSymbol: "RELIANCE.NS", instrumentType: "EQUITY" },
  { id: "i-2", yahooSymbol: "TCS.NS", instrumentType: "EQUITY" },
  { id: "i-3", yahooSymbol: "NIFTY.NS", instrumentType: "INDEX" },
  { id: "i-4", yahooSymbol: "GOLDBEES.NS", instrumentType: "ETF" },
  { id: "i-5", yahooSymbol: "INFY.NS", instrumentType: "MF" },
];

describe("price-sync-logic.selectBackfillInstruments (real export)", () => {
  it("keeps exactly the requested ids when instrumentIds is given", () => {
    const out = selectBackfillInstruments(INSTS, ["i-2", "i-4"]);
    assert.deepStrictEqual(
      out.map((i) => i.id),
      ["i-2", "i-4"]
    );
  });

  it("ignores ids not present in the active set", () => {
    const out = selectBackfillInstruments(INSTS, ["i-2", "i-999"]);
    assert.deepStrictEqual(
      out.map((i) => i.id),
      ["i-2"]
    );
  });

  it("defaults to EQUITY/INDEX/ETF (excludes MF) when no ids given", () => {
    const out = selectBackfillInstruments(INSTS, undefined);
    assert.deepStrictEqual(
      out.map((i) => i.id),
      ["i-1", "i-2", "i-3", "i-4"]
    );
    assert.deepStrictEqual(BACKFILL_INSTRUMENT_TYPES, [
      "EQUITY",
      "INDEX",
      "ETF",
    ]);
  });

  it("treats an empty instrumentIds array as 'use the type default'", () => {
    const out = selectBackfillInstruments(INSTS, []);
    assert.strictEqual(out.length, 4); // type-filtered, not zero
  });

  it("excludes instruments with a null instrumentType from the default set", () => {
    const out = selectBackfillInstruments(
      [
        { id: "a", yahooSymbol: "A.NS", instrumentType: "EQUITY" },
        { id: "b", yahooSymbol: "B.NS", instrumentType: null },
      ],
      undefined
    );
    assert.deepStrictEqual(
      out.map((i) => i.id),
      ["a"]
    );
  });

  it("returns an empty array when nothing matches", () => {
    assert.deepStrictEqual(
      selectBackfillInstruments(
        [{ id: "x", yahooSymbol: "X.NS", instrumentType: "MF" }],
        undefined
      ),
      []
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// shouldDelay / shouldLogProgress — backfill loop cadence (real exports)
// ══════════════════════════════════════════════════════════════════════

describe("price-sync-logic.shouldDelay (real export)", () => {
  it("pauses after every 10th instrument (index 9, 19)", () => {
    assert.strictEqual(shouldDelay(9), true);
    assert.strictEqual(shouldDelay(19), true);
  });

  it("does not pause at index 0, 4, or 10", () => {
    assert.strictEqual(shouldDelay(0), false);
    assert.strictEqual(shouldDelay(4), false);
    assert.strictEqual(shouldDelay(10), false);
  });
});

describe("price-sync-logic.shouldLogProgress (real export)", () => {
  it("logs after every 100th instrument (index 99, 199)", () => {
    assert.strictEqual(shouldLogProgress(99), true);
    assert.strictEqual(shouldLogProgress(199), true);
  });

  it("does not log at index 0, 49, or 100", () => {
    assert.strictEqual(shouldLogProgress(0), false);
    assert.strictEqual(shouldLogProgress(49), false);
    assert.strictEqual(shouldLogProgress(100), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Orchestration harness — mirrors the processor's sync-log call SEQUENCE
// (create RUNNING → branch → update COMPLETED/FAILED), building syncType +
// instrument selection via the SAME real exports. (The real processor boots
// Prisma + Yahoo at import.)
// ══════════════════════════════════════════════════════════════════════

interface SyncLogCall {
  method: "create" | "update";
  data: Record<string, unknown>;
}

async function runPriceSyncSequence(
  data: {
    instrumentIds?: string[];
    dateRange?: { start: string; end: string };
    source?: "YAHOO";
  },
  deps: {
    instruments: Array<{
      id: string;
      yahooSymbol: string | null;
      instrumentType?: string | null;
    }>;
    refreshAllQuotes: (opts: {
      instrumentIds?: string[];
      batchSize: number;
    }) => Promise<{ refreshed: number; failed: number }>;
    backfillPrices: (id: string, yahooSymbol: string) => Promise<void>;
  },
  // Caller-provided sink so the pushed calls (incl. the FAILED patch) stay
  // observable even when the sequence rethrows.
  calls: SyncLogCall[] = []
): Promise<SyncLogCall[]> {
  const { instrumentIds, dateRange, source = "YAHOO" } = data;

  // create RUNNING — syncType from the REAL resolveSyncType.
  calls.push({
    method: "create",
    data: { syncType: resolveSyncType(dateRange), source, status: "RUNNING" },
  });

  try {
    if (dateRange) {
      const selected = selectBackfillInstruments(
        deps.instruments,
        instrumentIds
      );
      for (const inst of selected) {
        if (!inst.yahooSymbol) continue;
        await deps.backfillPrices(inst.id, inst.yahooSymbol);
      }
      calls.push({ method: "update", data: { status: "COMPLETED" } });
    } else {
      const result = await deps.refreshAllQuotes({
        instrumentIds,
        batchSize: QUOTE_REFRESH_BATCH_SIZE,
      });
      calls.push({
        method: "update",
        data: {
          status: "COMPLETED",
          recordsProcessed: result.refreshed,
          recordsFailed: result.failed,
        },
      });
    }
  } catch (error) {
    calls.push({
      method: "update",
      data: {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      },
    });
    throw error;
  }
  return calls;
}

const okQuotes = { refreshed: 10, failed: 0 };

describe("price-sync orchestration sequence (real exports)", () => {
  it("creates a RUNNING log with QUOTE_REFRESH when no dateRange", async () => {
    const calls = await runPriceSyncSequence(
      {},
      {
        instruments: INSTS,
        refreshAllQuotes: async () => okQuotes,
        backfillPrices: async () => {},
      }
    );
    assert.strictEqual(calls[0]!.method, "create");
    assert.strictEqual(calls[0]!.data.syncType, "QUOTE_REFRESH");
    assert.strictEqual(calls[0]!.data.status, "RUNNING");
  });

  it("creates a RUNNING log with PRICE_BACKFILL when a dateRange is given", async () => {
    const calls = await runPriceSyncSequence(
      { dateRange: { start: "2025-01-01", end: "2025-12-31" } },
      {
        instruments: INSTS,
        refreshAllQuotes: async () => okQuotes,
        backfillPrices: async () => {},
      }
    );
    assert.strictEqual(calls[0]!.data.syncType, "PRICE_BACKFILL");
  });

  it("passes the QUOTE_REFRESH_BATCH_SIZE to refreshAllQuotes and records counts", async () => {
    let captured = 0;
    const calls = await runPriceSyncSequence(
      {},
      {
        instruments: INSTS,
        refreshAllQuotes: async (opts) => {
          captured = opts.batchSize;
          return { refreshed: 100, failed: 5 };
        },
        backfillPrices: async () => {},
      }
    );
    assert.strictEqual(captured, 50);
    const done = calls[calls.length - 1]!;
    assert.strictEqual(done.data.status, "COMPLETED");
    assert.strictEqual(done.data.recordsProcessed, 100);
    assert.strictEqual(done.data.recordsFailed, 5);
  });

  it("backfills only EQUITY/INDEX/ETF instruments with a yahooSymbol", async () => {
    const backfilled: string[] = [];
    await runPriceSyncSequence(
      { dateRange: { start: "2025-01-01", end: "2025-12-31" } },
      {
        instruments: [
          ...INSTS,
          { id: "i-6", yahooSymbol: null, instrumentType: "EQUITY" },
        ],
        refreshAllQuotes: async () => okQuotes,
        backfillPrices: async (id) => {
          backfilled.push(id);
        },
      }
    );
    // i-5 (MF) excluded by type, i-6 (null symbol) skipped.
    assert.deepStrictEqual(backfilled, ["i-1", "i-2", "i-3", "i-4"]);
  });

  it("backfills exactly the requested ids when instrumentIds + dateRange given", async () => {
    const backfilled: string[] = [];
    await runPriceSyncSequence(
      {
        instrumentIds: ["i-2", "i-3"],
        dateRange: { start: "2025-01-01", end: "2025-12-31" },
      },
      {
        instruments: INSTS,
        refreshAllQuotes: async () => okQuotes,
        backfillPrices: async (id) => {
          backfilled.push(id);
        },
      }
    );
    assert.deepStrictEqual(backfilled, ["i-2", "i-3"]);
  });

  it("completes (no backfill) on an empty instrument set", async () => {
    let backfillCount = 0;
    const calls = await runPriceSyncSequence(
      { dateRange: { start: "2025-01-01", end: "2025-12-31" } },
      {
        instruments: [],
        refreshAllQuotes: async () => okQuotes,
        backfillPrices: async () => {
          backfillCount++;
        },
      }
    );
    assert.strictEqual(backfillCount, 0);
    assert.strictEqual(calls[calls.length - 1]!.data.status, "COMPLETED");
  });

  it("marks the log FAILED + captures the message on a quote-refresh error", async () => {
    const calls: SyncLogCall[] = [];
    await assert.rejects(
      () =>
        runPriceSyncSequence(
          {},
          {
            instruments: INSTS,
            refreshAllQuotes: async () => {
              throw new Error("Yahoo API rate limited");
            },
            backfillPrices: async () => {},
          },
          calls
        ),
      { message: "Yahoo API rate limited" }
    );

    const failed = calls[calls.length - 1]!;
    assert.strictEqual(failed.data.status, "FAILED");
    assert.strictEqual(failed.data.errorMessage, "Yahoo API rate limited");
  });

  it("captures 'Unknown error' for a non-Error throw", async () => {
    const calls: SyncLogCall[] = [];
    await assert.rejects(() =>
      runPriceSyncSequence(
        {},
        {
          instruments: INSTS,
          refreshAllQuotes: async () => {
            // eslint-disable-next-line no-throw-literal
            throw "string error";
          },
          backfillPrices: async () => {},
        },
        calls
      )
    );

    const failed = calls[calls.length - 1]!;
    assert.strictEqual(failed.data.status, "FAILED");
    assert.strictEqual(failed.data.errorMessage, "Unknown error");
  });
});
