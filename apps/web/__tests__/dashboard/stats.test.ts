/**
 * Dashboard Stats — non-finite / edge-poison regression suite.
 *
 * DE-SHADOWED (MONEY-620): this file previously declared inline copies of the
 * aggregation math ("Helper functions that mirror the calculation logic in
 * dashboard.ts ... extracted here") and asserted the copies — a classic shadow
 * that stays green while the real `getDashboardStats` path burns. It now imports
 * and exercises the REAL exported helpers from `@/lib/db/dashboard-logic`, which
 * is exactly the logic `getDashboardStats` (in `@/lib/db/dashboard`) calls.
 *
 * `dashboard-logic` is Prisma-free, so importing it never opens a DB connection
 * — the test stays pure and exits cleanly (no orphan).
 *
 * FOCUS: this is a money-AGGREGATION surface, so the bulk here is the highest
 * bug-potential class — a single non-finite (NaN/Infinity) row, a div-by-zero
 * percentage, an empty portfolio, and an Invalid Date — proving one bad row can
 * no longer poison the whole dashboard into "₹NaN". Happy-path coverage of these
 * same helpers lives in `__tests__/db/dashboard.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  finite,
  calculateHoldingsAggregation,
  calculateMfAggregation,
  calculatePositionsAggregation,
  calculateTotalPortfolioValue,
  calculatePnLPercentage,
  calculatePortfolioPnLPercentage,
  calculateTodaysChange,
  calculateWinRate,
  calculateTotalRealizedPnL,
  calculateTotalUnrealizedPnL,
  calculateTodaysPnL,
  generateDailyPnL,
  findBestTrade,
  findWorstTrade,
} from "@/lib/db/dashboard-logic";

// MONEY-1074 — mirror parity: the web copy must match the services helpers so
// the maintained mirror can't drift (a named bug class here).
describe("MONEY-1074 mirror: TODAY + MF-inclusive TOTAL RETURN", () => {
  it("calculatePortfolioPnLPercentage counts MF (QA 0% regression)", () => {
    assert.strictEqual(
      calculatePortfolioPnLPercentage(0, 0, 2000, 10000),
      "20.00"
    );
    assert.strictEqual(
      calculatePortfolioPnLPercentage(1000, 10000, 0, 0),
      "10.00"
    );
    assert.strictEqual(calculatePortfolioPnLPercentage(500, 0, 0, 0), "0");
  });

  it("calculateTodaysChange = holdings dayChange + realized, finite-guarded", () => {
    assert.strictEqual(
      calculateTodaysChange([{ dayChange: 120 }, { dayChange: -30 }], 50),
      140
    );
    assert.strictEqual(
      calculateTodaysChange(
        [{ dayChange: null }, { dayChange: NaN }, { dayChange: 25 }],
        0
      ),
      25
    );
    assert.strictEqual(calculateTodaysChange([], 0), 0);
  });
});

// How the dashboard UI actually renders the aggregates. Re-deriving the consumer
// here (NOT the source math) lets us assert "no NaN/Invalid ever reaches a
// formatter" — the real-world symptom of the poison bug. Mirrors
// components/dashboard/DashboardOverview.tsx (INR + Number(pnlPercentage)).
const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

describe("Dashboard aggregation — non-finite & edge regression (real source)", () => {
  // =========================================================================
  // finite() guard primitive
  // =========================================================================
  describe("finite()", () => {
    it("passes finite numbers through unchanged", () => {
      assert.strictEqual(finite(42), 42);
      assert.strictEqual(finite(-1234.5), -1234.5);
      assert.strictEqual(finite(0), 0);
    });

    it("collapses NaN / ±Infinity / null / undefined to the fallback (default 0)", () => {
      assert.strictEqual(finite(NaN), 0);
      assert.strictEqual(finite(Infinity), 0);
      assert.strictEqual(finite(-Infinity), 0);
      assert.strictEqual(finite(null), 0);
      assert.strictEqual(finite(undefined), 0);
    });

    it("honours a custom fallback", () => {
      assert.strictEqual(finite(NaN, -Infinity), -Infinity);
      assert.strictEqual(finite(Infinity, 99), 99);
    });
  });

  // =========================================================================
  // Holdings — one bad row must NOT poison the total (dominant bug class)
  // =========================================================================
  describe("calculateHoldingsAggregation — non-finite rows", () => {
    it("a single NaN currentValue row does NOT make totalValue NaN", () => {
      const holdings = [
        { currentValue: 100000, investedValue: 90000 },
        { currentValue: NaN, investedValue: 90000 }, // corrupt sync row
        { currentValue: 50000, investedValue: 40000 },
      ];
      const { totalValue, totalInvested, totalPnL } =
        calculateHoldingsAggregation(holdings);

      assert.ok(Number.isFinite(totalValue), "totalValue must be finite");
      assert.strictEqual(totalValue, 150000); // bad row contributes 0
      assert.strictEqual(totalInvested, 220000);
      // PnL: (100000-90000) + (0-90000) + (50000-40000) = -70000
      assert.strictEqual(totalPnL, -70000);
      // The user-visible symptom this regresses:
      assert.strictEqual(INR(totalValue), "₹1,50,000");
      assert.notStrictEqual(INR(totalValue), "₹NaN");
    });

    it("a single Infinity currentValue row does NOT make totalValue Infinity", () => {
      const holdings = [
        { currentValue: 100000, investedValue: 90000 },
        { currentValue: Infinity, investedValue: 90000 },
      ];
      const { totalValue } = calculateHoldingsAggregation(holdings);
      assert.ok(Number.isFinite(totalValue));
      assert.strictEqual(totalValue, 100000);
    });

    it("a non-finite investedValue does not poison totalInvested or totalPnL", () => {
      const holdings = [
        { currentValue: 100000, investedValue: NaN },
        { currentValue: 80000, investedValue: 70000 },
      ];
      const { totalInvested, totalPnL } =
        calculateHoldingsAggregation(holdings);
      assert.strictEqual(totalInvested, 70000);
      // (100000-0) + (80000-70000) = 110000
      assert.strictEqual(totalPnL, 110000);
    });

    it("empty holdings => all zeros, never NaN", () => {
      const r = calculateHoldingsAggregation([]);
      assert.deepStrictEqual(r, {
        totalValue: 0,
        totalInvested: 0,
        totalPnL: 0,
      });
    });

    it("very large sums stay finite (no overflow to Infinity)", () => {
      const big = 1e12;
      const holdings = Array.from({ length: 1000 }, () => ({
        currentValue: big,
        investedValue: big / 2,
      }));
      const { totalValue, totalInvested } =
        calculateHoldingsAggregation(holdings);
      assert.ok(Number.isFinite(totalValue));
      assert.strictEqual(totalValue, big * 1000);
      assert.strictEqual(totalInvested, (big / 2) * 1000);
    });
  });

  // =========================================================================
  // Mutual funds — || fallback chain preserved, Infinity still guarded
  // =========================================================================
  describe("calculateMfAggregation — non-finite rows", () => {
    it("an Infinity currentValue row does NOT poison totalValue", () => {
      const mfs = [
        { currentValue: 55000, investedAmount: 50000, investedValue: null },
        { currentValue: Infinity, investedAmount: 50000, investedValue: null },
      ];
      const { totalValue } = calculateMfAggregation(mfs);
      assert.ok(Number.isFinite(totalValue));
      assert.strictEqual(totalValue, 55000);
    });

    it("NaN currentValue is treated as 0 (falsy) — PnL stays finite", () => {
      const mfs = [
        { currentValue: NaN, investedAmount: 50000, investedValue: null },
      ];
      const { totalValue, totalPnL } = calculateMfAggregation(mfs);
      assert.strictEqual(totalValue, 0);
      assert.strictEqual(totalPnL, -50000);
    });

    it("an Infinity investedAmount does NOT poison totalInvested", () => {
      const mfs = [
        { currentValue: 60000, investedAmount: Infinity, investedValue: 55000 },
      ];
      const { totalInvested } = calculateMfAggregation(mfs);
      // Infinity is truthy so the || chain picks it — finite() then neutralises
      // it to 0 rather than letting it leak into the sum.
      assert.ok(Number.isFinite(totalInvested));
      assert.strictEqual(totalInvested, 0);
    });

    it("empty MFs => all zeros, never NaN", () => {
      assert.deepStrictEqual(calculateMfAggregation([]), {
        totalValue: 0,
        totalInvested: 0,
        totalPnL: 0,
      });
    });
  });

  // =========================================================================
  // Positions — NaN/Infinity in netQuantity*lastPrice
  // =========================================================================
  describe("calculatePositionsAggregation — non-finite rows", () => {
    it("a NaN netQuantity does NOT poison totalValue", () => {
      const positions = [
        { netQuantity: 50, lastPrice: 22000, totalPnl: 5000 },
        { netQuantity: NaN, lastPrice: 22000, totalPnl: 1000 },
      ];
      const { totalValue, totalPnL } = calculatePositionsAggregation(positions);
      assert.ok(Number.isFinite(totalValue));
      assert.strictEqual(totalValue, 1100000);
      assert.strictEqual(totalPnL, 6000);
    });

    it("an Infinity lastPrice does NOT poison totalValue", () => {
      const positions = [{ netQuantity: 10, lastPrice: Infinity, totalPnl: 0 }];
      const { totalValue } = calculatePositionsAggregation(positions);
      assert.ok(Number.isFinite(totalValue));
      assert.strictEqual(totalValue, 0);
    });

    it("an Infinity totalPnl does NOT poison totalPnL", () => {
      const positions = [
        { netQuantity: 10, lastPrice: 100, totalPnl: Infinity },
        { netQuantity: 10, lastPrice: 100, totalPnl: 500 },
      ];
      const { totalPnL } = calculatePositionsAggregation(positions);
      assert.ok(Number.isFinite(totalPnL));
      assert.strictEqual(totalPnL, 500);
    });

    it("empty positions => zeros, never NaN", () => {
      assert.deepStrictEqual(calculatePositionsAggregation([]), {
        totalValue: 0,
        totalPnL: 0,
      });
    });
  });

  // =========================================================================
  // Total portfolio value — segment-level poison must not propagate
  // =========================================================================
  describe("calculateTotalPortfolioValue — non-finite segments", () => {
    it("a NaN segment value does NOT make the grand total NaN", () => {
      const total = calculateTotalPortfolioValue(100000, NaN, 50000);
      assert.ok(Number.isFinite(total));
      assert.strictEqual(total, 150000);
      assert.strictEqual(INR(total), "₹1,50,000");
    });

    it("an Infinity segment value does NOT make the grand total Infinity", () => {
      const total = calculateTotalPortfolioValue(Infinity, 50000, 0);
      assert.ok(Number.isFinite(total));
      assert.strictEqual(total, 50000);
    });

    it("mixed segments where one is empty/zero still sums correctly", () => {
      assert.strictEqual(
        calculateTotalPortfolioValue(100000, 0, 50000),
        150000
      );
    });

    it("all-zero (empty portfolio) => 0", () => {
      assert.strictEqual(calculateTotalPortfolioValue(0, 0, 0), 0);
    });
  });

  // =========================================================================
  // P&L percentage — div-by-zero & non-finite must never yield "NaN" string
  // =========================================================================
  describe("calculatePnLPercentage — div-by-zero & non-finite", () => {
    it("invested == 0 returns '0' (no div-by-zero)", () => {
      assert.strictEqual(calculatePnLPercentage(5000, 0), "0");
    });

    it("negative invested returns '0'", () => {
      assert.strictEqual(calculatePnLPercentage(5000, -100), "0");
    });

    it("NaN P&L with positive invested returns '0' (NOT the string 'NaN')", () => {
      const pct = calculatePnLPercentage(NaN, 90000);
      assert.strictEqual(pct, "0");
      assert.notStrictEqual(pct, "NaN");
      // The consumer does Number(pnlPercentage) — must stay finite.
      assert.ok(Number.isFinite(Number(pct)));
    });

    it("Infinity P&L with positive invested returns '0'", () => {
      assert.strictEqual(calculatePnLPercentage(Infinity, 90000), "0");
    });

    it("NaN invested returns '0' (does not slip past the > 0 gate)", () => {
      assert.strictEqual(calculatePnLPercentage(5000, NaN), "0");
    });

    it("Infinity invested returns '0' (would otherwise pass the > 0 gate)", () => {
      const pct = calculatePnLPercentage(5000, Infinity);
      assert.strictEqual(pct, "0");
      assert.ok(Number.isFinite(Number(pct)));
    });

    it("still computes a correct finite percentage for valid input", () => {
      assert.strictEqual(calculatePnLPercentage(10000, 100000), "10.00");
      assert.strictEqual(calculatePnLPercentage(-5000, 100000), "-5.00");
    });
  });

  // =========================================================================
  // Win rate — div-by-zero guard
  // =========================================================================
  describe("calculateWinRate — div-by-zero", () => {
    it("returns 0 when there are no closed trades (no div-by-zero)", () => {
      assert.strictEqual(calculateWinRate(0, 0), 0);
    });

    it("computes a rounded integer for valid input", () => {
      assert.strictEqual(calculateWinRate(8, 10), 80);
      assert.strictEqual(calculateWinRate(1, 3), 33);
    });
  });

  // =========================================================================
  // Realized P&L — Infinity row guard
  // =========================================================================
  describe("calculateTotalRealizedPnL — non-finite rows", () => {
    it("an Infinity realizedPnL row does NOT poison the total", () => {
      const closed = [
        { realizedPnL: 5000 },
        { realizedPnL: Infinity },
        { realizedPnL: 3000 },
      ];
      const total = calculateTotalRealizedPnL(closed);
      assert.ok(Number.isFinite(total));
      assert.strictEqual(total, 8000);
    });

    it("null/NaN realizedPnL already collapse to 0", () => {
      const closed = [
        { realizedPnL: 1000 },
        { realizedPnL: null },
        { realizedPnL: NaN },
      ];
      assert.strictEqual(calculateTotalRealizedPnL(closed), 1000);
    });
  });

  // =========================================================================
  // Unrealized P&L — non-finite position P&L / price fallback
  // =========================================================================
  describe("calculateTotalUnrealizedPnL — non-finite inputs", () => {
    it("a non-finite position P&L does NOT poison the total", () => {
      const openTrades = [
        { symbol: "A", entryPrice: 100, quantity: 10 },
        { symbol: "B", entryPrice: 100, quantity: 10 },
      ];
      const positionPnLMap = new Map<string, number>([
        ["A", Infinity],
        ["B", 5000],
      ]);
      const result = calculateTotalUnrealizedPnL(
        openTrades,
        positionPnLMap,
        new Map()
      );
      assert.ok(Number.isFinite(result));
      assert.strictEqual(result, 5000);
    });

    it("an Infinity current price in the fallback path does NOT leak (truthy gate alone misses it)", () => {
      const openTrades = [{ symbol: "X", entryPrice: 2500, quantity: 100 }];
      const result = calculateTotalUnrealizedPnL(
        openTrades,
        new Map(),
        new Map([["X", Infinity]])
      );
      assert.ok(Number.isFinite(result));
      assert.strictEqual(result, 0);
    });

    it("empty open trades => 0", () => {
      assert.strictEqual(
        calculateTotalUnrealizedPnL([], new Map(), new Map()),
        0
      );
    });
  });

  // =========================================================================
  // Daily P&L — Invalid Date must not throw on .toISOString()
  // =========================================================================
  describe("generateDailyPnL — Invalid Date & non-finite P&L", () => {
    it("an Invalid Date tradeDate does NOT throw (would crash the dashboard)", () => {
      const trades = [
        { tradeDate: new Date("not-a-real-date"), realizedPnL: 1000 },
      ];
      let series: ReturnType<typeof generateDailyPnL> = [];
      assert.doesNotThrow(() => {
        series = generateDailyPnL(trades, 7);
      });
      assert.strictEqual(series.length, 7);
      // Corrupt-date row is skipped → every day is 0.
      series.forEach((d) => {
        assert.strictEqual(d.pnl, 0);
        assert.strictEqual(d.cumulativePnL, 0);
      });
    });

    it("a valid row alongside an Invalid Date row still aggregates the valid one", () => {
      const today = new Date();
      const todayStr = today.toISOString().split("T")[0]!;
      const trades = [
        { tradeDate: new Date("garbage"), realizedPnL: 9999 },
        { tradeDate: today, realizedPnL: 2000 },
      ];
      const series = generateDailyPnL(trades);
      const last = series[series.length - 1]!;
      assert.strictEqual(last.date, todayStr);
      assert.strictEqual(last.pnl, 2000);
      // Every emitted value is finite & a valid YYYY-MM-DD.
      series.forEach((d) => {
        assert.ok(Number.isFinite(d.pnl));
        assert.ok(Number.isFinite(d.cumulativePnL));
        assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
      });
    });

    it("an Infinity realizedPnL does NOT poison the day/cumulative totals", () => {
      const today = new Date();
      const trades = [
        { tradeDate: today, realizedPnL: Infinity },
        { tradeDate: today, realizedPnL: 1500 },
      ];
      const series = generateDailyPnL(trades);
      const last = series[series.length - 1]!;
      assert.ok(Number.isFinite(last.pnl));
      assert.strictEqual(last.pnl, 1500);
      assert.ok(Number.isFinite(last.cumulativePnL));
    });

    it("empty trades => 30 zero-valued, validly-dated points", () => {
      const series = generateDailyPnL([]);
      assert.strictEqual(series.length, 30);
      series.forEach((d) => {
        assert.strictEqual(d.pnl, 0);
        assert.strictEqual(d.cumulativePnL, 0);
        assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
      });
    });
  });

  // =========================================================================
  // Today's P&L — Infinity row guard
  // =========================================================================
  describe("calculateTodaysPnL — non-finite rows", () => {
    it("an Infinity realizedPnL today does NOT poison todaysPnL", () => {
      const today = new Date();
      const { todaysPnL, todaysTrades } = calculateTodaysPnL([
        { tradeDate: today, realizedPnL: Infinity },
        { tradeDate: today, realizedPnL: 250 },
      ]);
      assert.ok(Number.isFinite(todaysPnL));
      assert.strictEqual(todaysPnL, 250);
      assert.strictEqual(todaysTrades, 2);
    });
  });

  // =========================================================================
  // Best / worst trade — non-finite stored P&L surfaces as null
  // =========================================================================
  describe("findBestTrade / findWorstTrade — non-finite stored P&L", () => {
    it("a non-finite best P&L is surfaced as null (no NaN to a formatter)", () => {
      const best = findBestTrade([{ symbol: "X", realizedPnL: Infinity }]);
      assert.strictEqual(best?.symbol, "X");
      assert.strictEqual(best?.pnl, null);
    });

    it("ignores a NaN row when picking the best finite trade", () => {
      const best = findBestTrade([
        { symbol: "A", realizedPnL: NaN },
        { symbol: "B", realizedPnL: 3000 },
        { symbol: "C", realizedPnL: 1000 },
      ]);
      assert.strictEqual(best?.symbol, "B");
      assert.strictEqual(best?.pnl, 3000);
    });

    it("a non-finite worst P&L is surfaced as null", () => {
      const worst = findWorstTrade([{ symbol: "Z", realizedPnL: -Infinity }]);
      assert.strictEqual(worst?.symbol, "Z");
      assert.strictEqual(worst?.pnl, null);
    });

    it("empty input => null for both", () => {
      assert.strictEqual(findBestTrade([]), null);
      assert.strictEqual(findWorstTrade([]), null);
    });
  });

  // =========================================================================
  // Whole-dashboard composition under a poisoned row
  // =========================================================================
  describe("end-to-end: one corrupt row never reaches a formatter", () => {
    it("a NaN holding + Infinity MF + NaN position still produce a clean ₹ total and % string", () => {
      const holdingsAgg = calculateHoldingsAggregation([
        { currentValue: 500000, investedValue: 450000 },
        { currentValue: NaN, investedValue: 100000 },
      ]);
      const mfAgg = calculateMfAggregation([
        { currentValue: Infinity, investedAmount: 90000, investedValue: null },
        { currentValue: 100000, investedAmount: 90000, investedValue: null },
      ]);
      const posAgg = calculatePositionsAggregation([
        { netQuantity: NaN, lastPrice: 500, totalPnl: 5000 },
        { netQuantity: 100, lastPrice: 500, totalPnl: 5000 },
      ]);

      const totalValue = calculateTotalPortfolioValue(
        holdingsAgg.totalValue,
        mfAgg.totalValue,
        posAgg.totalValue
      );
      const pnlPct = calculatePnLPercentage(
        holdingsAgg.totalPnL,
        holdingsAgg.totalInvested
      );

      assert.ok(Number.isFinite(totalValue));
      // 500000 (holdings, bad row=0) + 100000 (MF, bad row=0) + 50000 (positions, bad row=0)
      assert.strictEqual(totalValue, 650000);
      assert.strictEqual(INR(totalValue), "₹6,50,000");
      assert.notStrictEqual(INR(totalValue), "₹NaN");
      // pnlPct must be a parseable finite numeric string, never "NaN".
      assert.notStrictEqual(pnlPct, "NaN");
      assert.ok(Number.isFinite(Number(pnlPct)));
    });
  });
});
