/**
 * Catch-all API route (`/api/[[...path]]`) CONTRACT test.
 *
 * Exercises the REAL exported symbols the catch-all handlers call, instead of
 * inline copies:
 *   - path parsing + PATCH allowlists + POST validation + win-rate + tags +
 *     demo trade filter from `@/app/api/[[...path]]/route-logic`,
 *   - realized-P&L from `@/lib/db/trades-logic` (`calculateTradeRealizedPnL`
 *     for POST /trades, `calculateClosePositionPnL` for /positions/close) —
 *     the SAME shared FIFO/realized-P&L helpers the route now reuses, so no
 *     duplicate P&L math exists.
 *
 * (Replaces the previous shadow version, which reimplemented `filterTrades`,
 * the allowlists, `validateTradeInput`, `calculateRealizedPnL`,
 * `calculateWinRate`, `parseTags`, and a now-stale header-based `isDemoMode`
 * inline and asserted the copies. The real route derives demo mode from the
 * HMAC `sb_demo` cookie via `isDemoSession()`, not an `x-demo-mode` header, so
 * the shadow's demo-mode helper is dropped.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseApiPath,
  splitPathParts,
  parseSkip,
  parseLimit,
  filterTrades,
  validateTradeInput,
  calculateWinRate,
  parseTags,
  sanitizeUpdateBody,
  TRADE_UPDATABLE_FIELDS,
  HOLDING_UPDATABLE_FIELDS,
  MF_UPDATABLE_FIELDS,
  type FilterableTrade,
} from "@/app/api/[[...path]]/route-logic";
import {
  calculateTradeRealizedPnL,
  calculateClosePositionPnL,
} from "@/lib/db/trades-logic";

function trade(overrides: Partial<FilterableTrade> = {}): FilterableTrade {
  return {
    symbol: "RELIANCE",
    segment: "EQUITY",
    tradeType: "BUY",
    brokerName: "zerodha",
    tradeDate: new Date("2024-12-15"),
    ...overrides,
  };
}

describe("Catch-all route logic", () => {
  describe("Path parsing", () => {
    it("strips the /api/ prefix", () => {
      assert.strictEqual(parseApiPath("/api/trades"), "trades");
    });

    it("strips /api/ from a nested path", () => {
      assert.strictEqual(
        parseApiPath("/api/dashboard/stats"),
        "dashboard/stats"
      );
    });

    it("handles /api/ only", () => {
      assert.strictEqual(parseApiPath("/api/"), "");
    });

    it("splits a path into parts", () => {
      assert.deepStrictEqual(splitPathParts("/api/trades/123"), [
        "",
        "api",
        "trades",
        "123",
      ]);
    });

    it("exposes resource at index 2 and id at index 3", () => {
      const parts = splitPathParts("/api/trades/abc123");
      assert.strictEqual(parts[2], "trades");
      assert.strictEqual(parts[3], "abc123");
    });

    it("has an undefined id when absent", () => {
      const parts = splitPathParts("/api/trades");
      assert.strictEqual(parts[2], "trades");
      assert.strictEqual(parts[3], undefined);
    });
  });

  describe("Query param parsing", () => {
    it("defaults skip to 0", () => {
      assert.strictEqual(parseSkip(null), 0);
    });

    it("defaults limit to 20", () => {
      assert.strictEqual(parseLimit(null), 20);
    });

    it("parses skip from a string", () => {
      assert.strictEqual(parseSkip("10"), 10);
    });

    it("parses limit from a string", () => {
      assert.strictEqual(parseLimit("50"), 50);
    });

    it("treats an empty skip string as 0", () => {
      assert.strictEqual(parseSkip(""), 0);
    });

    it("treats an empty limit string as 20", () => {
      assert.strictEqual(parseLimit(""), 20);
    });
  });

  describe("PATCH allowlists (mass-assignment prevention)", () => {
    it("allows valid trade fields through", () => {
      const body = {
        symbol: "TCS",
        price: 3500,
        quantity: 10,
        notes: "Updated",
      };
      assert.deepStrictEqual(
        sanitizeUpdateBody(body, TRADE_UPDATABLE_FIELDS),
        body
      );
    });

    it("strips userId from trade updates", () => {
      const sanitized = sanitizeUpdateBody(
        { userId: "hacker_user", price: 3500 },
        TRADE_UPDATABLE_FIELDS
      );
      assert.strictEqual(sanitized.userId, undefined);
      assert.strictEqual(sanitized.price, 3500);
    });

    it("strips id / createdAt / updatedAt from trade updates", () => {
      const sanitized = sanitizeUpdateBody(
        {
          id: "fake",
          createdAt: new Date(),
          updatedAt: new Date(),
          price: 100,
        },
        TRADE_UPDATABLE_FIELDS
      );
      assert.strictEqual(sanitized.id, undefined);
      assert.strictEqual(sanitized.createdAt, undefined);
      assert.strictEqual(sanitized.updatedAt, undefined);
      assert.strictEqual(sanitized.price, 100);
    });

    it("allows holding updatable fields", () => {
      const body = { quantity: 100, averagePrice: 500, notes: "Test" };
      assert.deepStrictEqual(
        sanitizeUpdateBody(body, HOLDING_UPDATABLE_FIELDS),
        body
      );
    });

    it("strips symbol/userId from holding updates", () => {
      const sanitized = sanitizeUpdateBody(
        { symbol: "HACK", userId: "hacker", quantity: 100 },
        HOLDING_UPDATABLE_FIELDS
      );
      assert.strictEqual(sanitized.symbol, undefined);
      assert.strictEqual(sanitized.userId, undefined);
      assert.strictEqual(sanitized.quantity, 100);
    });

    it("only allows notes and tags for MF updates", () => {
      const sanitized = sanitizeUpdateBody(
        { notes: "Updated", tags: ["growth"], investedAmount: 9999999 },
        MF_UPDATABLE_FIELDS
      );
      assert.strictEqual(sanitized.notes, "Updated");
      assert.deepStrictEqual(sanitized.tags, ["growth"]);
      assert.strictEqual(sanitized.investedAmount, undefined);
    });

    it("returns {} when the body has only disallowed keys", () => {
      assert.deepStrictEqual(
        sanitizeUpdateBody(
          { userId: "hack", id: "fake", email: "evil" },
          TRADE_UPDATABLE_FIELDS
        ),
        {}
      );
    });

    it("returns {} for an empty body", () => {
      assert.deepStrictEqual(
        sanitizeUpdateBody({}, TRADE_UPDATABLE_FIELDS),
        {}
      );
    });
  });

  describe("POST trade input validation", () => {
    it("accepts a valid trade", () => {
      assert.strictEqual(
        validateTradeInput({ symbol: "TCS", quantity: 10, price: 3500 }).valid,
        true
      );
    });

    it("rejects a missing symbol", () => {
      const result = validateTradeInput({ quantity: 10, price: 3500 });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, "symbol is required");
    });

    it("rejects a non-string symbol", () => {
      const result = validateTradeInput({
        symbol: 123,
        quantity: 10,
        price: 1,
      });
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, "symbol is required");
    });

    it("rejects a missing/zero/negative/NaN quantity", () => {
      assert.strictEqual(
        validateTradeInput({ symbol: "TCS", price: 1 }).error,
        "valid quantity is required"
      );
      assert.strictEqual(
        validateTradeInput({ symbol: "TCS", quantity: 0, price: 1 }).valid,
        false
      );
      assert.strictEqual(
        validateTradeInput({ symbol: "TCS", quantity: -5, price: 1 }).valid,
        false
      );
      assert.strictEqual(
        validateTradeInput({ symbol: "TCS", quantity: "abc", price: 1 }).valid,
        false
      );
    });

    it("rejects a missing/zero/negative price", () => {
      assert.strictEqual(
        validateTradeInput({ symbol: "TCS", quantity: 10 }).error,
        "valid price is required"
      );
      assert.strictEqual(
        validateTradeInput({ symbol: "TCS", quantity: 10, price: 0 }).valid,
        false
      );
      assert.strictEqual(
        validateTradeInput({ symbol: "TCS", quantity: 10, price: -100 }).valid,
        false
      );
    });

    it("accepts string numbers for quantity and price", () => {
      assert.strictEqual(
        validateTradeInput({ symbol: "TCS", quantity: "10", price: "3500" })
          .valid,
        true
      );
    });
  });

  describe("Trade filtering (demo path)", () => {
    const trades: FilterableTrade[] = [
      trade({
        symbol: "RELIANCE",
        brokerName: "zerodha",
        segment: "EQUITY",
        tradeType: "BUY",
        tradeDate: new Date("2024-12-15"),
      }),
      trade({
        symbol: "TCS",
        brokerName: "groww",
        segment: "EQUITY",
        tradeType: "SELL",
        tradeDate: new Date("2024-12-16"),
      }),
      trade({
        symbol: "NIFTY25JAN",
        brokerName: "zerodha",
        segment: "FUTURES",
        tradeType: "BUY",
        tradeDate: new Date("2024-12-18"),
      }),
      trade({
        symbol: "INFY",
        brokerName: "dhan",
        segment: "EQUITY",
        tradeType: "BUY",
        tradeDate: new Date("2024-12-20"),
      }),
    ];

    it("returns all trades with no filters", () => {
      assert.strictEqual(filterTrades(trades, {}).length, 4);
    });

    it("filters by symbol (case-insensitive)", () => {
      const result = filterTrades(trades, { symbol: "reliance" });
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].symbol, "RELIANCE");
    });

    it("filters by partial symbol match", () => {
      assert.strictEqual(filterTrades(trades, { symbol: "NIFTY" }).length, 1);
    });

    it("filters by broker", () => {
      assert.strictEqual(filterTrades(trades, { broker: "zerodha" }).length, 2);
    });

    it("skips broker filter when broker is 'all'", () => {
      assert.strictEqual(filterTrades(trades, { broker: "all" }).length, 4);
    });

    it("filters by segment", () => {
      assert.strictEqual(
        filterTrades(trades, { segment: "FUTURES" }).length,
        1
      );
    });

    it("skips segment filter when segment is 'all'", () => {
      assert.strictEqual(filterTrades(trades, { segment: "all" }).length, 4);
    });

    it("filters by tradeType", () => {
      const result = filterTrades(trades, { tradeType: "SELL" });
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].symbol, "TCS");
    });

    it("filters by fromDate", () => {
      assert.strictEqual(
        filterTrades(trades, { fromDate: "2024-12-17" }).length,
        2
      );
    });

    it("filters by toDate (inclusive end-of-day)", () => {
      assert.strictEqual(
        filterTrades(trades, { toDate: "2024-12-16" }).length,
        2
      );
    });

    it("filters by date range", () => {
      assert.strictEqual(
        filterTrades(trades, { fromDate: "2024-12-16", toDate: "2024-12-18" })
          .length,
        2
      );
    });

    it("combines multiple filters", () => {
      assert.strictEqual(
        filterTrades(trades, { broker: "zerodha", tradeType: "BUY" }).length,
        2
      );
    });

    it("returns empty when no matches", () => {
      assert.strictEqual(
        filterTrades(trades, { symbol: "NONEXISTENT" }).length,
        0
      );
    });
  });

  describe("Realized P&L (reused @/lib/db/trades-logic helpers)", () => {
    it("POST /trades: LONG profit, brokerage subtracted", () => {
      // (120-100)*50 - 20 = 980
      assert.strictEqual(
        calculateTradeRealizedPnL("LONG", 100, 120, 50, 20),
        980
      );
    });

    it("POST /trades: SHORT profit (entry > exit)", () => {
      // (120-100)*50 - 20 = 980
      assert.strictEqual(
        calculateTradeRealizedPnL("SHORT", 120, 100, 50, 20),
        980
      );
    });

    it("POST /trades: losing LONG is negative", () => {
      // (100-120)*50 - 20 = -1020
      assert.strictEqual(
        calculateTradeRealizedPnL("LONG", 120, 100, 50, 20),
        -1020
      );
    });

    it("POST /trades: losing SHORT is negative", () => {
      // (120-140)*50 - 20 = -1020  (entry 120, exit 140)
      assert.strictEqual(
        calculateTradeRealizedPnL("SHORT", 120, 140, 50, 20),
        -1020
      );
    });

    it("POST /trades: handles zero brokerage", () => {
      assert.strictEqual(
        calculateTradeRealizedPnL("LONG", 100, 110, 10, 0),
        100
      );
    });

    it("/positions/close: LONG profits when exit > entry, minus brokerage", () => {
      // (120-100)*50 - 20 = 980
      assert.strictEqual(
        calculateClosePositionPnL("LONG", 100, 120, 50, 20),
        980
      );
    });

    it("/positions/close: SHORT profits when entry > exit", () => {
      // (100-120)*50 ... SHORT: (entry-exit)*qty = (120-100)*50 - 20 = 980
      assert.strictEqual(
        calculateClosePositionPnL("SHORT", 120, 100, 50, 20),
        980
      );
    });
  });

  describe("Win rate", () => {
    it("computes 100%", () => {
      assert.strictEqual(calculateWinRate(10, 10), 100);
    });

    it("computes 0%", () => {
      assert.strictEqual(calculateWinRate(0, 10), 0);
    });

    it("computes 50%", () => {
      assert.strictEqual(calculateWinRate(5, 10), 50);
    });

    it("returns 0 for 0 closed trades (no divide-by-zero)", () => {
      assert.strictEqual(calculateWinRate(0, 0), 0);
    });

    it("rounds to the nearest integer", () => {
      assert.strictEqual(calculateWinRate(1, 3), 33);
    });

    it("handles large numbers", () => {
      assert.strictEqual(calculateWinRate(750, 1000), 75);
    });
  });

  describe("Tag parsing", () => {
    it("parses comma-separated tags", () => {
      assert.deepStrictEqual(parseTags("growth,value,momentum"), [
        "growth",
        "value",
        "momentum",
      ]);
    });

    it("trims whitespace", () => {
      assert.deepStrictEqual(parseTags(" growth , value "), [
        "growth",
        "value",
      ]);
    });

    it("filters empty tags", () => {
      assert.deepStrictEqual(parseTags("growth,,value,"), ["growth", "value"]);
    });

    it("returns [] for undefined", () => {
      assert.deepStrictEqual(parseTags(undefined), []);
    });

    it("returns [] for an empty string", () => {
      assert.deepStrictEqual(parseTags(""), []);
    });
  });
});
