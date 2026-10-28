/**
 * MONEY-620 — trades-logic.ts pure unit tests (REAL exports, no shadow).
 *
 * Imports the REAL exported pure helpers from the trades SERVICE logic module
 * (`packages/services/src/trades-logic.ts`) — the exact code that
 * `packages/services/src/trades.service.ts` (the user-facing tradebook path:
 * `apps/web/lib/actions/trades.ts` → `getTradesService`) CALLS. No inline
 * reimplementation: the production reduce/clamp/pairing and the assertions run
 * the same bytes.
 *
 * The module is Prisma-free (only imports `./mappings`), so importing it never
 * opens a DB/Redis handle — the test stays pure and exits clean (no orphan).
 *
 * Covers the four blind spots for this surface:
 *   - PAGINATION clamp: NaN / negative / absurd / float limit|skip → safe
 *     Prisma take/skip bounds (the notifications-style 500 fix).
 *   - NON-FINITE: NaN/Infinity price/quantity never poison tradeValue, an
 *     average, a realized P&L, or the stats totals.
 *   - INVALID DATE: a corrupt tradeDate never throws on .toISOString() in the
 *     pairing group-key, and the sort comparator never mis-orders.
 *   - win-rate divide-by-zero (0 closed) and IDOR-scoped where-clause shape.
 *
 * Source: packages/services/src/trades-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  finite,
  clampPagination,
  DEFAULT_TRADE_LIMIT,
  MAX_TRADE_LIMIT,
  tradeValue,
  resolveTradeValue,
  sanitizeNullableMoney,
  safeISODateKey,
  compareTradeDateDesc,
  buildTradeWhereClause,
  buildPairedViewWhereClause,
  buildPairedStatusMap,
  buildRealizedPnLByTradeMap,
  assembleTradeStats,
  calculateTradeRealizedPnL,
  calculateClosePositionPnL,
  type PairedViewRow,
} from "../../../../packages/services/src/trades-logic";

// ── small fixture (MONEY-840: persisted PairedTradeView row) ──────────────────

function view(overrides: Partial<PairedViewRow> = {}): PairedViewRow {
  return {
    sourceTradeIds: [],
    entryTradeId: null,
    exitTradeId: null,
    status: "OPEN",
    realizedPnL: null,
    ...overrides,
  };
}

// =============================================================================
// finite()
// =============================================================================

describe("trades-logic finite()", () => {
  it("passes finite numbers through unchanged", () => {
    assert.equal(finite(0), 0);
    assert.equal(finite(-1234.56), -1234.56);
    assert.equal(finite(42), 42);
  });

  it("collapses NaN / ±Infinity / null / undefined to the fallback (default 0)", () => {
    assert.equal(finite(NaN), 0);
    assert.equal(finite(Infinity), 0);
    assert.equal(finite(-Infinity), 0);
    assert.equal(finite(null), 0);
    assert.equal(finite(undefined), 0);
    assert.equal(finite(NaN, 7), 7);
  });
});

// =============================================================================
// clampPagination() — the Prisma "Expected Int" 500 guard
// =============================================================================

describe("trades-logic clampPagination()", () => {
  it("passes a normal (limit, skip) through (floored to ints)", () => {
    assert.deepEqual(clampPagination(25, 40), { take: 25, skip: 40 });
    assert.deepEqual(clampPagination(10.9, 5.9), { take: 10, skip: 5 });
  });

  it("defaults limit and skip when omitted", () => {
    assert.deepEqual(clampPagination(), {
      take: DEFAULT_TRADE_LIMIT,
      skip: 0,
    });
  });

  it("`?limit=abc` → parseInt NaN → DEFAULT_TRADE_LIMIT, never NaN take", () => {
    // The exact api parseInt failure mode: parseInt("abc",10) === NaN.
    const nan = parseInt("abc", 10);
    assert.ok(Number.isNaN(nan));
    const { take, skip } = clampPagination(nan, nan);
    assert.equal(take, DEFAULT_TRADE_LIMIT);
    assert.equal(skip, 0);
    assert.ok(Number.isInteger(take) && Number.isInteger(skip));
  });

  it("negative limit (-5) → default; negative skip → 0", () => {
    assert.deepEqual(clampPagination(-5, -100), {
      take: DEFAULT_TRADE_LIMIT,
      skip: 0,
    });
  });

  it("zero limit → default (not an empty page)", () => {
    assert.equal(clampPagination(0, 0).take, DEFAULT_TRADE_LIMIT);
  });

  it("absurd limit (99999999) → capped to MAX_TRADE_LIMIT", () => {
    assert.equal(clampPagination(99999999, 0).take, MAX_TRADE_LIMIT);
    assert.equal(MAX_TRADE_LIMIT, 100);
  });

  it("Infinity / -Infinity limit and skip never produce a non-finite bound", () => {
    const a = clampPagination(Infinity, Infinity);
    assert.equal(a.take, DEFAULT_TRADE_LIMIT);
    assert.equal(a.skip, 0);
    const b = clampPagination(-Infinity, -Infinity);
    assert.equal(b.take, DEFAULT_TRADE_LIMIT);
    assert.equal(b.skip, 0);
  });

  it("non-number inputs (string/null/object) collapse to safe defaults", () => {
    assert.deepEqual(clampPagination("50" as unknown, "10" as unknown), {
      take: DEFAULT_TRADE_LIMIT,
      skip: 0,
    });
    assert.deepEqual(clampPagination(null, {} as unknown), {
      take: DEFAULT_TRADE_LIMIT,
      skip: 0,
    });
  });

  it("a large but in-range skip is preserved (deep pagination still works)", () => {
    assert.deepEqual(clampPagination(50, 500000), { take: 50, skip: 500000 });
  });
});

// =============================================================================
// tradeValue() / resolveTradeValue()
// =============================================================================

describe("trades-logic tradeValue()", () => {
  it("multiplies quantity × price", () => {
    assert.equal(tradeValue(10, 100), 1000);
    assert.equal(tradeValue(3, 2500.5), 7501.5);
  });

  it("a NaN/Infinity factor never yields a non-finite product", () => {
    assert.equal(tradeValue(NaN, 100), 0);
    assert.equal(tradeValue(10, Infinity), 0);
    assert.equal(tradeValue(Infinity, -Infinity), 0);
    assert.equal(tradeValue(null, 100), 0);
    // consumer safety: result is always .toFixed-able
    assert.notEqual(tradeValue(NaN, NaN).toFixed(2), "NaN");
  });
});

describe("trades-logic resolveTradeValue()", () => {
  it("prefers a stored finite value", () => {
    assert.equal(resolveTradeValue(2500, 1, 9999), 2500);
    assert.equal(resolveTradeValue(0, 5, 100), 0);
  });

  it("derives qty×price when the stored value is missing or non-finite", () => {
    assert.equal(resolveTradeValue(null, 5, 100), 500);
    assert.equal(resolveTradeValue(undefined, 5, 100), 500);
    assert.equal(resolveTradeValue(NaN, 5, 100), 500);
    assert.equal(resolveTradeValue(Infinity, 5, 100), 500);
  });

  it("returns a finite number even when BOTH stored and derived are corrupt", () => {
    const v = resolveTradeValue(NaN, NaN, Infinity);
    assert.ok(Number.isFinite(v));
    assert.equal(v, 0);
  });
});

describe("trades-logic sanitizeNullableMoney()", () => {
  it("preserves null/undefined as null (legitimate '—')", () => {
    assert.equal(sanitizeNullableMoney(null), null);
    assert.equal(sanitizeNullableMoney(undefined), null);
  });

  it("keeps finite values including 0 and negatives", () => {
    assert.equal(sanitizeNullableMoney(0), 0);
    assert.equal(sanitizeNullableMoney(-2643.75), -2643.75);
    assert.equal(sanitizeNullableMoney(10000), 10000);
  });

  it("collapses NaN/±Infinity to null (never leaks to .toFixed)", () => {
    // This is the exact OPEN/one-sided-spread leak fixed in the service mapper:
    // a corrupt stored realizedPnL/exitPrice must degrade to "—", not "Infinity".
    assert.equal(sanitizeNullableMoney(NaN), null);
    assert.equal(sanitizeNullableMoney(Infinity), null);
    assert.equal(sanitizeNullableMoney(-Infinity), null);
  });
});

// =============================================================================
// safeISODateKey() / compareTradeDateDesc()
// =============================================================================

describe("trades-logic safeISODateKey()", () => {
  it("returns the YYYY-MM-DD slice for a valid date", () => {
    assert.equal(
      safeISODateKey(new Date("2024-06-01T10:00:00Z")),
      "2024-06-01"
    );
    assert.equal(safeISODateKey("2024-12-31T23:59:59Z"), "2024-12-31");
  });

  it("returns null (never throws RangeError) for an Invalid Date", () => {
    assert.doesNotThrow(() => safeISODateKey(new Date("not-a-date")));
    assert.equal(safeISODateKey(new Date("not-a-date")), null);
    assert.equal(safeISODateKey("garbage"), null);
    assert.equal(safeISODateKey(NaN), null);
  });
});

describe("trades-logic compareTradeDateDesc()", () => {
  it("orders valid dates newest-first", () => {
    const rows = [
      { tradeDate: new Date("2024-01-01") },
      { tradeDate: new Date("2024-06-01") },
      { tradeDate: new Date("2024-03-01") },
    ];
    rows.sort(compareTradeDateDesc);
    assert.deepEqual(
      rows.map((r) => (r.tradeDate as Date).toISOString().slice(0, 10)),
      ["2024-06-01", "2024-03-01", "2024-01-01"]
    );
  });

  it("sinks Invalid-Date rows to the end and never throws / mis-orders", () => {
    const rows = [
      { tradeDate: new Date("bad") },
      { tradeDate: new Date("2024-06-01") },
      { tradeDate: new Date("2024-01-01") },
    ];
    assert.doesNotThrow(() => rows.sort(compareTradeDateDesc));
    // valid dates first (newest→oldest), invalid last
    assert.equal(
      (rows[0]!.tradeDate as Date).toISOString().slice(0, 10),
      "2024-06-01"
    );
    assert.equal(
      (rows[1]!.tradeDate as Date).toISOString().slice(0, 10),
      "2024-01-01"
    );
    assert.ok(Number.isNaN((rows[2]!.tradeDate as Date).getTime()));
  });

  it("two Invalid Dates compare equal (stable)", () => {
    assert.equal(
      compareTradeDateDesc(
        { tradeDate: new Date("x") },
        { tradeDate: new Date("y") }
      ),
      0
    );
  });
});

// =============================================================================
// MONEY-840: persisted-pairing read mapping (replaces the old read-time
// pairTrades) — buildPairedStatusMap + buildRealizedPnLByTradeMap
// =============================================================================

describe("trades-logic buildPairedStatusMap()", () => {
  it("a CLOSED view marks its entry, exit and source ids CLOSED", () => {
    const map = buildPairedStatusMap([
      view({
        sourceTradeIds: ["b1", "s1"],
        entryTradeId: "b1",
        exitTradeId: "s1",
        status: "CLOSED",
      }),
    ]);
    assert.equal(map.get("b1"), "CLOSED");
    assert.equal(map.get("s1"), "CLOSED");
  });

  it("a multi-day lot (entry far from exit) still maps both ids — no date keying", () => {
    // The whole point of the cutover: the persisted view links the buy + sell
    // regardless of how many days apart, so both read CLOSED.
    const map = buildPairedStatusMap([
      view({
        sourceTradeIds: ["jan-buy", "dec-sell"],
        entryTradeId: "jan-buy",
        exitTradeId: "dec-sell",
        status: "CLOSED",
      }),
    ]);
    assert.equal(map.get("jan-buy"), "CLOSED");
    assert.equal(map.get("dec-sell"), "CLOSED");
  });

  it("CLOSED outranks PARTIAL outranks OPEN when a trade sits in several lots", () => {
    const map = buildPairedStatusMap([
      view({ sourceTradeIds: ["t"], status: "OPEN" }),
      view({ sourceTradeIds: ["t"], status: "PARTIAL" }),
      view({ sourceTradeIds: ["t"], exitTradeId: "t", status: "CLOSED" }),
    ]);
    assert.equal(map.get("t"), "CLOSED");

    const map2 = buildPairedStatusMap([
      view({ sourceTradeIds: ["t"], status: "OPEN" }),
      view({ sourceTradeIds: ["t"], status: "PARTIAL" }),
    ]);
    assert.equal(map2.get("t"), "PARTIAL");
  });

  it("an unknown view status is treated as OPEN (never spuriously CLOSED)", () => {
    const map = buildPairedStatusMap([
      view({ sourceTradeIds: ["t"], status: "WEIRD" }),
    ]);
    assert.equal(map.get("t"), "OPEN");
  });

  it("a trade in no view is absent from the map (caller defaults it to OPEN)", () => {
    const map = buildPairedStatusMap([
      view({ sourceTradeIds: ["other"], status: "CLOSED" }),
    ]);
    assert.equal(map.has("t"), false);
  });

  it("empty input → empty map (no throw)", () => {
    assert.equal(buildPairedStatusMap([]).size, 0);
  });
});

describe("trades-logic buildRealizedPnLByTradeMap()", () => {
  it("attributes a CLOSED lot's realizedPnL to its exit (SELL) id", () => {
    const map = buildRealizedPnLByTradeMap([
      view({
        entryTradeId: "b1",
        exitTradeId: "s1",
        status: "CLOSED",
        realizedPnL: 700,
      }),
    ]);
    assert.equal(map.get("s1"), 700);
    assert.equal(map.has("b1"), false); // not attributed to the buy
  });

  it("a SELL that closes two lots accumulates both realised P&Ls", () => {
    const map = buildRealizedPnLByTradeMap([
      view({ exitTradeId: "s1", status: "CLOSED", realizedPnL: 100 }),
      view({ exitTradeId: "s1", status: "CLOSED", realizedPnL: 200 }),
    ]);
    assert.equal(map.get("s1"), 300);
  });

  it("OPEN views (no realised component) are skipped", () => {
    const map = buildRealizedPnLByTradeMap([
      view({ entryTradeId: "b1", status: "OPEN", realizedPnL: null }),
    ]);
    assert.equal(map.size, 0);
  });

  it("a view with no exitTradeId is skipped (nothing to attribute to)", () => {
    const map = buildRealizedPnLByTradeMap([
      view({
        entryTradeId: "b1",
        exitTradeId: null,
        status: "CLOSED",
        realizedPnL: 50,
      }),
    ]);
    assert.equal(map.size, 0);
  });

  it("a non-finite stored realizedPnL collapses to a finite contribution (no NaN/Infinity)", () => {
    const map = buildRealizedPnLByTradeMap([
      view({
        exitTradeId: "s1",
        status: "CLOSED",
        realizedPnL: Number.POSITIVE_INFINITY,
      }),
    ]);
    const v = map.get("s1")!;
    assert.ok(Number.isFinite(v));
    assert.equal(v, 0);
  });

  it("empty input → empty map (no throw)", () => {
    assert.equal(buildRealizedPnLByTradeMap([]).size, 0);
  });
});

describe("trades-logic buildPairedViewWhereClause()", () => {
  it("always scopes to the caller userId (IDOR) and maps symbol/segment", () => {
    const where = buildPairedViewWhereClause("user-1", {
      symbol: "rel",
      segment: "equity",
    });
    assert.equal(where.userId, "user-1");
    assert.deepEqual(where.symbol, { contains: "rel", mode: "insensitive" });
    assert.ok(Array.isArray((where.segment as { in: string[] }).in));
  });

  it("manual maps to broker:null (the view has no brokerName column)", () => {
    const where = buildPairedViewWhereClause("u", { broker: "manual" });
    assert.equal(where.broker, null);
    assert.equal("brokerName" in where, false);
  });

  it("a BROKER:brokerUserId value splits into two equality filters", () => {
    const where = buildPairedViewWhereClause("u", { broker: "ZERODHA:ZH1" });
    assert.equal(where.broker, "ZERODHA");
    assert.equal(where.brokerUserId, "ZH1");
  });

  it("'all' disables the broker/segment filters", () => {
    const where = buildPairedViewWhereClause("u", {
      broker: "all",
      segment: "all",
    });
    assert.equal("broker" in where, false);
    assert.equal("segment" in where, false);
  });

  it("date window is applied to entryDate (not tradeDate)", () => {
    const where = buildPairedViewWhereClause("u", {
      fromDate: "2024-04-01",
      toDate: "2025-03-31",
    });
    assert.ok(where.entryDate);
    const ed = where.entryDate as { gte: Date; lte: Date };
    assert.ok(ed.gte instanceof Date);
    assert.ok(ed.lte instanceof Date);
    assert.equal("tradeDate" in where, false);
  });

  it("tradeType / productType are intentionally NOT applied to a paired lot", () => {
    const where = buildPairedViewWhereClause("u", {
      tradeType: "BUY",
      productType: "CNC",
    });
    assert.equal("tradeType" in where, false);
    assert.equal("productType" in where, false);
  });
});

// =============================================================================
// buildTradeWhereClause() — IDOR scope + filters + no injection
// =============================================================================

describe("trades-logic buildTradeWhereClause()", () => {
  it("always scopes to the caller userId (IDOR) — userId never widened", () => {
    const where = buildTradeWhereClause("user-1", {
      symbol: "rel",
      broker: "ZERODHA",
    });
    assert.equal(where.userId, "user-1");
    // a filter value cannot replace/remove the userId scope
    const where2 = buildTradeWhereClause("victim", {
      broker: "attacker:other-user-id",
    });
    assert.equal(where2.userId, "victim");
  });

  it("symbol → case-insensitive contains operator (not interpolated)", () => {
    const where = buildTradeWhereClause("u", { symbol: "RELI" });
    assert.deepEqual(where.symbol, { contains: "RELI", mode: "insensitive" });
  });

  it("broker: manual → brokerName; BROKER:userId split; plain; empty userId", () => {
    assert.equal(
      buildTradeWhereClause("u", { broker: "manual" }).brokerName,
      "manual"
    );
    const split = buildTradeWhereClause("u", { broker: "ZERODHA:ZD1" });
    assert.equal(split.broker, "ZERODHA");
    assert.equal(split.brokerUserId, "ZD1");
    assert.equal(
      buildTradeWhereClause("u", { broker: "UPSTOX" }).broker,
      "UPSTOX"
    );
    const empty = buildTradeWhereClause("u", { broker: "UPSTOX:" });
    assert.equal(empty.broker, "UPSTOX");
    assert.equal(empty.brokerUserId, undefined);
  });

  it("segment maps to the IN list; tradeType is equality; 'all' disables both", () => {
    // MONEY-847: FO bucket also covers the FUTURES/OPTIONS stored segment values
    // (TradeFormSchema enum) so the F&O dropdown choice matches them too.
    assert.deepEqual(buildTradeWhereClause("u", { segment: "FO" }).segment, {
      in: ["FO", "NFO", "BFO", "NRML", "FUTURES", "OPTIONS"],
    });
    assert.equal(
      buildTradeWhereClause("u", { tradeType: "SELL" }).tradeType,
      "SELL"
    );
    const all = buildTradeWhereClause("u", {
      segment: "all",
      tradeType: "all",
      broker: "all",
    });
    assert.equal(all.segment, undefined);
    assert.equal(all.tradeType, undefined);
    assert.equal(all.broker, undefined);
  });

  it("date range → IST-anchored gte / end-of-day lte INSTANTS; absent when neither bound given", () => {
    // MONEY-846: assert the exact UTC INSTANT, NOT local `getHours()`. The old
    // assertion (`td.lte.getHours() === 23`) was MISLEADING — it was green on the
    // IST CI box AND on a UTC box (LOCAL `setHours(23,…)` yields hour 23 in any
    // zone), so it could never catch the prod bug where the lte instant was
    // +5:30h off. Date-only bounds are now interpreted as IST day edges:
    //   fromDate 2024-01-01 → 1-Jan 00:00 IST = 2023-12-31T18:30:00.000Z
    //   toDate   2024-12-31 → 31-Dec 23:59:59.999 IST = 2024-12-31T18:29:59.999Z
    const where = buildTradeWhereClause("u", {
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });
    const td = where.tradeDate as Record<string, Date>;
    assert.ok(td.gte instanceof Date);
    assert.equal(td.gte.toISOString(), "2023-12-31T18:30:00.000Z");
    assert.equal(td.lte.toISOString(), "2024-12-31T18:29:59.999Z");
    assert.equal(buildTradeWhereClause("u", {}).tradeDate, undefined);
  });

  it("a FULL ISO instant bound (FY dropdown) passes through verbatim, not re-anchored", () => {
    // The FY dropdown now emits `fyWindowUtc` instants. istDayBound must detect
    // the `T` and use them as-is (NOT add another +5:30 shift).
    const where = buildTradeWhereClause("u", {
      fromDate: "2025-03-31T18:30:00.000Z",
      toDate: "2026-03-31T18:29:59.999Z",
    });
    const td = where.tradeDate as Record<string, Date>;
    assert.equal(td.gte.toISOString(), "2025-03-31T18:30:00.000Z");
    assert.equal(td.lte.toISOString(), "2026-03-31T18:29:59.999Z");
  });

  it("no filters → exactly { userId }", () => {
    assert.deepEqual(buildTradeWhereClause("u", {}), { userId: "u" });
  });
});

// =============================================================================
// assembleTradeStats() — divide-by-zero + finite + non-negative counts
// =============================================================================

describe("trades-logic assembleTradeStats()", () => {
  it("computes win rate, winners, losers, closedCount, totalPnL for a normal set", () => {
    const s = assembleTradeStats(6000, 3, 4, 10);
    assert.equal(s.totalPnL, 6000);
    assert.equal(s.winRate, 75); // round(3/4*100)
    assert.equal(s.winners, 3);
    assert.equal(s.losers, 1);
    // MONEY-846: closedCount is now returned (was computed by the service but
    // dropped, so the client win-rate sub-line `stats.closedCount` vanished).
    assert.equal(s.closedCount, 4);
    assert.equal(s.totalTrades, 10);
  });

  it("0 closed trades → winRate 0 (no divide-by-zero NaN), closedCount 0", () => {
    const s = assembleTradeStats(0, 0, 0, 5);
    assert.equal(s.winRate, 0);
    assert.ok(Number.isFinite(s.winRate));
    assert.equal(s.winners, 0);
    assert.equal(s.losers, 0);
    assert.equal(s.closedCount, 0);
    assert.equal(s.totalTrades, 5);
  });

  it("null/NaN aggregate inputs never make a stat NaN", () => {
    const s = assembleTradeStats(null, undefined, NaN, Infinity);
    assert.equal(s.totalPnL, 0);
    assert.equal(s.winRate, 0);
    assert.equal(s.winners, 0);
    assert.equal(s.losers, 0);
    assert.equal(s.closedCount, 0);
    assert.equal(s.totalTrades, 0);
    for (const n of [
      s.totalPnL,
      s.winRate,
      s.winners,
      s.losers,
      s.closedCount,
      s.totalTrades,
    ]) {
      assert.ok(Number.isFinite(n));
    }
  });

  it("winners are clamped to closed so losers can never go negative", () => {
    // corrupt aggregates where winnerCount > closedCount
    const s = assembleTradeStats(100, 9, 3, 3);
    assert.equal(s.winners, 3);
    assert.equal(s.losers, 0);
    assert.equal(s.closedCount, 3);
    assert.ok(s.losers >= 0);
    // winners + losers must always reconcile to closedCount.
    assert.equal(s.winners + s.losers, s.closedCount);
  });

  it("negative Infinity P&L sum collapses to 0 (no '-Infinity' headline)", () => {
    assert.equal(assembleTradeStats(-Infinity, 1, 2, 2).totalPnL, 0);
  });
});

// =============================================================================
// calculateTradeRealizedPnL() / calculateClosePositionPnL()
// =============================================================================

describe("trades-logic single-trade P&L", () => {
  it("createTrade P&L: LONG (rise) and SHORT (fall), brokerage subtracted", () => {
    assert.equal(calculateTradeRealizedPnL("LONG", 2500, 2600, 100, 20), 9980);
    assert.equal(calculateTradeRealizedPnL("SHORT", 2600, 2500, 100, 20), 9980);
    assert.equal(
      calculateTradeRealizedPnL("LONG", 2600, 2500, 100, 20),
      -10020
    );
    assert.equal(calculateTradeRealizedPnL("LONG", 100, 100, 10, 20), -20);
  });

  it("closePosition P&L: LONG (rise) and SHORT (fall), brokerage subtracted", () => {
    assert.equal(calculateClosePositionPnL("LONG", 2500, 2600, 100, 20), 9980);
    assert.equal(calculateClosePositionPnL("SHORT", 2600, 2500, 100, 20), 9980);
    assert.equal(calculateClosePositionPnL("LONG", 2600, 2500, 50, 10), -5010);
    assert.equal(calculateClosePositionPnL("LONG", 100, 100, 100, 50), -50);
  });

  it("a corrupt price/quantity/brokerage never persists a non-finite P&L (toFixed-safe)", () => {
    const a = calculateTradeRealizedPnL("LONG", NaN, 2600, 100, 20);
    assert.ok(Number.isFinite(a));
    assert.notEqual(a.toFixed(2), "NaN");
    const b = calculateClosePositionPnL("SHORT", 2600, Infinity, 100, 20);
    assert.ok(Number.isFinite(b));
    const c = calculateClosePositionPnL("LONG", 100, 110, 10, NaN);
    assert.equal(c, 100); // brokerage NaN → 0, (110-100)*10
  });
});

/**
 * MONEY-1257 — the TRADES tile's split must sum to its own headline.
 *
 * The tile rendered the server `total` (every trade matching the filter) above
 * buys/sells the CLIENT derived from `trades`, which is one page. At
 * PAGE_SIZE=100 a user with 125 trades saw:
 *
 *     TRADES  125
 *     20 buys · 0 sells
 *
 * Two different populations presented as one fact. The "0 sells" is what makes
 * it actively misleading rather than merely odd — it reads as "you have never
 * sold anything", a claim about the user's trading history.
 *
 * `assembleTradeStats` now carries the counts, sourced server-side from the
 * SAME `where` as `totalTrades`.
 */
describe("assembleTradeStats — buy/sell split (MONEY-1257)", () => {
  it("[regression] the split sums to totalTrades", () => {
    const s = assembleTradeStats(0, 0, 0, 125, 80, 45);
    assert.equal(s.buyCount, 80);
    assert.equal(s.sellCount, 45);
    assert.equal(s.buyCount + s.sellCount, s.totalTrades);
  });

  it("omitted counts read as 0, not as a wrong split", () => {
    // Callers predating this (and any cached payload) pass nothing. Zero
    // renders "0 buys · 0 sells", which is visibly unpopulated rather than
    // confidently wrong.
    const s = assembleTradeStats(0, 0, 0, 125);
    assert.equal(s.buyCount, 0);
    assert.equal(s.sellCount, 0);
  });

  it("clamps like every other count here", () => {
    // These are counts, never measurements: a negative or non-finite value
    // must not reach the tile as "-3 buys".
    const s = assembleTradeStats(0, 0, 0, 10, -5, Number.NaN);
    assert.equal(s.buyCount, 0);
    assert.equal(s.sellCount, 0);

    const t = assembleTradeStats(0, 0, 0, 10, 3.7, 2.2);
    assert.equal(t.buyCount, 3);
    assert.equal(t.sellCount, 2);
  });

  it("a sells-only account is representable", () => {
    // The mirror of the reported symptom — the split must not assume BUYs.
    const s = assembleTradeStats(0, 0, 0, 4, 0, 4);
    assert.equal(s.buyCount, 0);
    assert.equal(s.sellCount, 4);
  });
});
