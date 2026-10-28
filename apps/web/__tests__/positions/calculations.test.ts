/**
 * Positions Service Calculation Tests
 *
 * DE-SHADOWED (MONEY-620): this file previously re-declared `convertPosition`
 * and `calculateSummary` INLINE under "// Helper functions that mirror the logic
 * in positions.ts" and asserted the COPIES — a classic shadow test (green while
 * the real code could be broken). It now imports and asserts the REAL exported
 * pure helpers from `packages/services/src/positions-logic` — exactly the module
 * the LIVE `positions.service` calls. No logic is re-declared here.
 *
 * The two thin local adapters below (`convertPosition` / `summaryOf`) are NOT
 * shadows: they only SHAPE inputs and DELEGATE to the real exports
 * (`classifyPositionDirection`, `tradeTypeForQuantity`, `absQuantity`,
 * `summarizeOpenPositions`) — they contain no business math of their own.
 *
 * Note on `totalInvested`: this suite's original notion of "invested" was
 * Σ|netQuantity * averagePrice| (cost basis), which is what the real
 * `positionCostBasis` computes and what we feed `summarizeOpenPositions` as each
 * row's `tradeValue`, so every historical expected value is preserved while now
 * executing real code. (The live service's summary sums |netValue| instead; that
 * path is covered against the real service in `positions-service.test.ts`.)
 *
 * Source: packages/services/src/positions-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyPositionDirection,
  tradeTypeForQuantity,
  absQuantity,
  positionCostBasis,
  summarizeOpenPositions,
  type PositionSummaryInput,
  type PositionSummaryTotals,
} from "../../../../packages/services/src/positions-logic";

interface DbPosition {
  id: string;
  netQuantity: number;
  averagePrice: number;
  lastPrice: number;
  unrealizedPnl: number;
  netValue: number;
  positionType: string; // DAY or NET (from DB)
}

interface Position {
  id: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  positionType: "LONG" | "SHORT"; // calculated by the real export
  tradeType: "BUY" | "SELL"; // calculated by the real export
}

/**
 * Adapter only — SHAPES a DB row into the UI shape by DELEGATING every
 * classification to the real `positions-logic` exports. Contains no math.
 */
function convertPosition(pos: DbPosition): Position {
  return {
    id: pos.id,
    quantity: absQuantity(pos.netQuantity),
    entryPrice: pos.averagePrice,
    currentPrice: pos.lastPrice,
    unrealizedPnL: pos.unrealizedPnl,
    positionType: classifyPositionDirection(pos.netQuantity),
    tradeType: tradeTypeForQuantity(pos.netQuantity),
  };
}

/**
 * Adapter only — builds the real `summarizeOpenPositions` inputs from DB rows
 * (excluding flats, as the live `netQuantity: { not: 0 }` query does) and uses
 * the real `positionCostBasis` (Σ|qty*avg|) as each row's invested `tradeValue`,
 * matching this suite's historical "invested" definition. Delegates the actual
 * aggregation to the real export.
 */
function summaryOf(dbPositions: DbPosition[]): PositionSummaryTotals {
  const inputs: PositionSummaryInput[] = dbPositions
    .filter((p) => p.netQuantity !== 0)
    .map((p) => ({
      netQuantity: p.netQuantity,
      // cost basis = |avg * qty| (netValue forced unusable so the helper uses
      // the avg*qty fallback) → reproduces the original Σ|qty*entryPrice|.
      tradeValue: positionCostBasis(0, p.averagePrice, p.netQuantity),
      unrealizedPnL: p.unrealizedPnl,
      lastPrice: p.lastPrice,
    }));
  return summarizeOpenPositions(inputs);
}

describe("Positions Calculations (real positions-logic exports)", () => {
  describe("Position Type Determination", () => {
    it("should identify LONG position when netQuantity > 0", () => {
      const dbPos: DbPosition = {
        id: "p1",
        netQuantity: 10,
        averagePrice: 100,
        lastPrice: 110,
        unrealizedPnl: 100,
        netValue: 1100,
        positionType: "NET",
      };

      const position = convertPosition(dbPos);

      assert.strictEqual(position.positionType, "LONG");
      assert.strictEqual(position.tradeType, "BUY");
      assert.strictEqual(position.quantity, 10);
    });

    it("should identify SHORT position when netQuantity < 0", () => {
      const dbPos: DbPosition = {
        id: "p1",
        netQuantity: -10,
        averagePrice: 100,
        lastPrice: 90,
        unrealizedPnl: 100,
        netValue: -900,
        positionType: "NET",
      };

      const position = convertPosition(dbPos);

      assert.strictEqual(position.positionType, "SHORT");
      assert.strictEqual(position.tradeType, "SELL");
      assert.strictEqual(position.quantity, 10); // absolute value
    });

    it("should handle DAY position type from DB as LONG when positive", () => {
      const dbPos: DbPosition = {
        id: "p1",
        netQuantity: 5,
        averagePrice: 200,
        lastPrice: 210,
        unrealizedPnl: 50,
        netValue: 1050,
        positionType: "DAY",
      };

      const position = convertPosition(dbPos);

      assert.strictEqual(position.positionType, "LONG");
    });

    it("should convert negative quantity to positive for display", () => {
      const dbPos: DbPosition = {
        id: "p1",
        netQuantity: -15,
        averagePrice: 100,
        lastPrice: 95,
        unrealizedPnl: 75,
        netValue: -1425,
        positionType: "NET",
      };

      const position = convertPosition(dbPos);

      assert.strictEqual(position.quantity, 15);
    });
  });

  describe("Position Summary Calculations", () => {
    it("should count Long and Short positions correctly", () => {
      const dbPositions: DbPosition[] = [
        {
          id: "p1",
          netQuantity: 10,
          averagePrice: 100,
          lastPrice: 110,
          unrealizedPnl: 100,
          netValue: 1100,
          positionType: "NET",
        },
        {
          id: "p2",
          netQuantity: 5,
          averagePrice: 200,
          lastPrice: 220,
          unrealizedPnl: 100,
          netValue: 1100,
          positionType: "NET",
        },
        {
          id: "p3",
          netQuantity: -8,
          averagePrice: 150,
          lastPrice: 140,
          unrealizedPnl: 80,
          netValue: -1120,
          positionType: "NET",
        },
      ];

      const summary = summaryOf(dbPositions);

      assert.strictEqual(summary.totalPositions, 3);
      assert.strictEqual(summary.longPositions, 2);
      assert.strictEqual(summary.shortPositions, 1);
    });

    it("should exclude flat positions (netQuantity = 0) from counts", () => {
      const dbPositions: DbPosition[] = [
        {
          id: "p1",
          netQuantity: 10,
          averagePrice: 100,
          lastPrice: 110,
          unrealizedPnl: 100,
          netValue: 1100,
          positionType: "NET",
        },
        {
          id: "p2",
          netQuantity: 0,
          averagePrice: 200,
          lastPrice: 200,
          unrealizedPnl: 0,
          netValue: 0,
          positionType: "NET",
        },
        {
          id: "p3",
          netQuantity: -5,
          averagePrice: 150,
          lastPrice: 140,
          unrealizedPnl: 50,
          netValue: -700,
          positionType: "NET",
        },
        {
          id: "p4",
          netQuantity: 0,
          averagePrice: 300,
          lastPrice: 300,
          unrealizedPnl: 0,
          netValue: 0,
          positionType: "NET",
        },
      ];

      const summary = summaryOf(dbPositions);

      assert.strictEqual(summary.totalPositions, 2);
      assert.strictEqual(summary.longPositions, 1);
      assert.strictEqual(summary.shortPositions, 1);
    });

    it("should calculate total invested correctly", () => {
      const dbPositions: DbPosition[] = [
        {
          id: "p1",
          netQuantity: 10,
          averagePrice: 100,
          lastPrice: 110,
          unrealizedPnl: 100,
          netValue: 1100,
          positionType: "NET",
        },
        {
          id: "p2",
          netQuantity: 5,
          averagePrice: 200,
          lastPrice: 210,
          unrealizedPnl: 50,
          netValue: 1050,
          positionType: "NET",
        },
      ];

      const summary = summaryOf(dbPositions);

      // (10 * 100) + (5 * 200) = 1000 + 1000 = 2000
      assert.strictEqual(summary.totalInvested, 2000);
    });

    it("should use absolute value of netQuantity for invested calculation", () => {
      const dbPositions: DbPosition[] = [
        {
          id: "p1",
          netQuantity: -10,
          averagePrice: 100,
          lastPrice: 90,
          unrealizedPnl: 100,
          netValue: -900,
          positionType: "NET",
        },
      ];

      const summary = summaryOf(dbPositions);

      // |−10| * 100 = 1000
      assert.strictEqual(summary.totalInvested, 1000);
    });

    it("should sum unrealized P&L correctly", () => {
      const dbPositions: DbPosition[] = [
        {
          id: "p1",
          netQuantity: 10,
          averagePrice: 100,
          lastPrice: 110,
          unrealizedPnl: 100,
          netValue: 1100,
          positionType: "NET",
        },
        {
          id: "p2",
          netQuantity: 5,
          averagePrice: 200,
          lastPrice: 190,
          unrealizedPnl: -50,
          netValue: 950,
          positionType: "NET",
        },
      ];

      const summary = summaryOf(dbPositions);

      assert.strictEqual(summary.unrealizedPnL, 50); // 100 + (-50) = 50
    });

    it("should return zeros for empty positions array", () => {
      const summary = summaryOf([]);

      assert.strictEqual(summary.totalPositions, 0);
      assert.strictEqual(summary.longPositions, 0);
      assert.strictEqual(summary.shortPositions, 0);
      assert.strictEqual(summary.totalInvested, 0);
      assert.strictEqual(summary.unrealizedPnL, 0);
    });

    it("should return zeros when all positions are flat", () => {
      const dbPositions: DbPosition[] = [
        {
          id: "p1",
          netQuantity: 0,
          averagePrice: 100,
          lastPrice: 100,
          unrealizedPnl: 0,
          netValue: 0,
          positionType: "NET",
        },
        {
          id: "p2",
          netQuantity: 0,
          averagePrice: 200,
          lastPrice: 200,
          unrealizedPnl: 0,
          netValue: 0,
          positionType: "NET",
        },
      ];

      const summary = summaryOf(dbPositions);

      assert.strictEqual(summary.totalPositions, 0);
      assert.strictEqual(summary.longPositions, 0);
      assert.strictEqual(summary.shortPositions, 0);
    });
  });

  describe("Edge Cases", () => {
    it("should handle very small quantities", () => {
      const dbPos: DbPosition = {
        id: "p1",
        netQuantity: 0.001,
        averagePrice: 100,
        lastPrice: 110,
        unrealizedPnl: 0.01,
        netValue: 0.11,
        positionType: "NET",
      };

      const position = convertPosition(dbPos);

      assert.strictEqual(position.positionType, "LONG");
      assert.strictEqual(position.quantity, 0.001);
    });

    it("should handle very large quantities", () => {
      const dbPos: DbPosition = {
        id: "p1",
        netQuantity: 1000000,
        averagePrice: 1500,
        lastPrice: 1550,
        unrealizedPnl: 50000000,
        netValue: 1550000000,
        positionType: "NET",
      };

      const position = convertPosition(dbPos);

      assert.strictEqual(position.positionType, "LONG");
      assert.strictEqual(position.quantity, 1000000);
    });

    it("should handle negative prices gracefully", () => {
      // This shouldn't happen in practice but test defensive coding
      const dbPos: DbPosition = {
        id: "p1",
        netQuantity: 10,
        averagePrice: 100,
        lastPrice: -50, // Invalid but test handling
        unrealizedPnl: -1500,
        netValue: -500,
        positionType: "NET",
      };

      const position = convertPosition(dbPos);

      assert.strictEqual(position.positionType, "LONG");
      assert.strictEqual(position.currentPrice, -50);
    });

    it("should correctly identify all LONG positions", () => {
      const dbPositions: DbPosition[] = [
        {
          id: "p1",
          netQuantity: 10,
          averagePrice: 100,
          lastPrice: 110,
          unrealizedPnl: 100,
          netValue: 1100,
          positionType: "NET",
        },
        {
          id: "p2",
          netQuantity: 20,
          averagePrice: 200,
          lastPrice: 210,
          unrealizedPnl: 200,
          netValue: 4200,
          positionType: "DAY",
        },
        {
          id: "p3",
          netQuantity: 5,
          averagePrice: 300,
          lastPrice: 290,
          unrealizedPnl: -50,
          netValue: 1450,
          positionType: "NET",
        },
      ];

      const summary = summaryOf(dbPositions);

      assert.strictEqual(summary.longPositions, 3);
      assert.strictEqual(summary.shortPositions, 0);
    });

    it("should correctly identify all SHORT positions", () => {
      const dbPositions: DbPosition[] = [
        {
          id: "p1",
          netQuantity: -10,
          averagePrice: 100,
          lastPrice: 90,
          unrealizedPnl: 100,
          netValue: -900,
          positionType: "NET",
        },
        {
          id: "p2",
          netQuantity: -20,
          averagePrice: 200,
          lastPrice: 210,
          unrealizedPnl: -200,
          netValue: -4200,
          positionType: "DAY",
        },
      ];

      const summary = summaryOf(dbPositions);

      assert.strictEqual(summary.longPositions, 0);
      assert.strictEqual(summary.shortPositions, 2);
    });

    // NEW: the original "negative prices" case hinted at defensive coding but the
    // shadow never guarded non-finite inputs. Pin the real export's poison guard:
    // a NaN/Infinity-bearing row must not poison the aggregate it feeds.
    it("a NaN/Infinity row never makes the real summary non-finite", () => {
      const dbPositions: DbPosition[] = [
        {
          id: "ok",
          netQuantity: 10,
          averagePrice: 100,
          lastPrice: 110,
          unrealizedPnl: 100,
          netValue: 1100,
          positionType: "NET",
        },
        {
          id: "poison",
          netQuantity: Number.NaN,
          averagePrice: Number.POSITIVE_INFINITY,
          lastPrice: Number.NaN,
          unrealizedPnl: Number.POSITIVE_INFINITY,
          netValue: Number.POSITIVE_INFINITY,
          positionType: "NET",
        },
      ];

      const summary = summaryOf(dbPositions);

      assert.ok(Number.isFinite(summary.totalInvested));
      assert.ok(Number.isFinite(summary.unrealizedPnL));
      assert.ok(Number.isFinite(summary.marketValue));
      assert.ok(Number.isFinite(summary.returnPct));
      // Only the clean row counts toward invested (1000) & pnl (100).
      assert.strictEqual(summary.totalInvested, 1000);
      assert.strictEqual(summary.unrealizedPnL, 100);
      // A NaN netQuantity is neither long nor short.
      assert.strictEqual(summary.longPositions, 1);
      assert.strictEqual(summary.shortPositions, 0);
    });
  });
});
