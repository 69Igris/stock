/**
 * Dashboard Action Tests
 *
 * DE-SHADOWED (MONEY-620): this file previously declared a local
 * `calculateDashboardStats` (and inline sector/exchange/broker/monthly math)
 * whose `DashboardStats` shape did not even match the real one, then asserted
 * the copy — a shadow that could never catch a regression in the real
 * `getDashboardStatsAction` path. It now:
 *
 *   1. Exercises the REAL pure helpers from `@/lib/db/dashboard-logic` that
 *      `getDashboardStats` (which backs `getDashboardStatsAction`) calls, for
 *      the portfolio-value / P&L / win-rate / realized-P&L math.
 *   2. Asserts the REAL `demoDashboardStats` payload from `@/lib/demo/data` —
 *      the exact object `getDashboardStatsAction` returns in demo mode
 *      (`return { success: true, data: demoDashboardStats }`) — for shape and
 *      internal consistency.
 *
 * The dropped inline sector/exchange/broker/monthly blocks asserted math with
 * NO corresponding source function (`getDashboardStatsAction` returns no such
 * fields), so they were shadows of nothing and are removed rather than kept as
 * orphan copies.
 *
 * Both imported modules are Prisma-free, so the test stays pure and exits
 * cleanly (no orphan). The Prisma/Clerk-coupled action wrapper itself is a thin
 * auth-gate + delegate; its computation is fully covered via the real helpers
 * here and in `__tests__/db/dashboard.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  calculateHoldingsAggregation,
  calculateMfAggregation,
  calculatePositionsAggregation,
  calculateTotalPortfolioValue,
  calculatePnLPercentage,
  calculateWinRate,
  calculateTotalRealizedPnL,
} from "@/lib/db/dashboard-logic";
import { demoDashboardStats } from "@/lib/demo/data";

describe("Dashboard Actions", () => {
  // =========================================================================
  // Portfolio aggregation via the REAL helpers the action path uses
  // =========================================================================
  describe("getDashboardStatsAction computation (real dashboard-logic)", () => {
    it("sums total invested value across holdings", () => {
      const holdings = [
        { currentValue: 260000, investedValue: 250000 },
        { currentValue: 180000, investedValue: 175000 },
        { currentValue: 110000, investedValue: 100000 },
      ];
      const { totalInvested } = calculateHoldingsAggregation(holdings);
      assert.strictEqual(totalInvested, 525000);
    });

    it("sums total current value across holdings", () => {
      const holdings = [
        { currentValue: 260000, investedValue: 250000 },
        { currentValue: 180000, investedValue: 170000 },
        { currentValue: 110000, investedValue: 100000 },
      ];
      const { totalValue } = calculateHoldingsAggregation(holdings);
      assert.strictEqual(totalValue, 550000);
    });

    it("computes holdings total P&L (currentValue - investedValue)", () => {
      const holdings = [
        { currentValue: 110000, investedValue: 100000 },
        { currentValue: 220000, investedValue: 200000 },
      ];
      const { totalPnL } = calculateHoldingsAggregation(holdings);
      assert.strictEqual(totalPnL, 30000);
    });

    it("computes the P&L percentage string from holdings totals", () => {
      const holdings = [{ currentValue: 110000, investedValue: 100000 }];
      const agg = calculateHoldingsAggregation(holdings);
      assert.strictEqual(
        calculatePnLPercentage(agg.totalPnL, agg.totalInvested),
        "10.00"
      );
    });

    it("handles empty holdings (zeros + '0' percentage, never NaN)", () => {
      const agg = calculateHoldingsAggregation([]);
      assert.strictEqual(agg.totalValue, 0);
      assert.strictEqual(agg.totalInvested, 0);
      assert.strictEqual(agg.totalPnL, 0);
      assert.strictEqual(
        calculatePnLPercentage(agg.totalPnL, agg.totalInvested),
        "0"
      );
    });

    it("combines holdings + MF + positions into total portfolio value", () => {
      const holdings = calculateHoldingsAggregation([
        { currentValue: 550000, investedValue: 500000 },
      ]);
      const mf = calculateMfAggregation([
        { currentValue: 169622, investedAmount: 107495, investedValue: null },
      ]);
      const positions = calculatePositionsAggregation([
        { netQuantity: 100, lastPrice: 500, totalPnl: 2500 },
      ]);
      const total = calculateTotalPortfolioValue(
        holdings.totalValue,
        mf.totalValue,
        positions.totalValue
      );
      assert.strictEqual(total, 550000 + 169622 + 50000);
    });
  });

  // =========================================================================
  // Position & trade stats via the REAL helpers
  // =========================================================================
  describe("Position & trade stats (real dashboard-logic)", () => {
    it("sums unrealized/total P&L across positions", () => {
      const positions = [
        { netQuantity: 10, lastPrice: 100, totalPnl: 500 },
        { netQuantity: 10, lastPrice: 100, totalPnl: -200 },
        { netQuantity: 10, lastPrice: 100, totalPnl: 750 },
      ];
      const { totalPnL } = calculatePositionsAggregation(positions);
      assert.strictEqual(totalPnL, 1050);
    });

    it("sums realized P&L across closed trades (null treated as 0)", () => {
      const closed = [
        { realizedPnL: 5000 },
        { realizedPnL: -2000 },
        { realizedPnL: 3000 },
        { realizedPnL: null }, // open trade
      ];
      assert.strictEqual(calculateTotalRealizedPnL(closed), 6000);
    });

    it("computes win rate as a rounded integer percentage", () => {
      assert.strictEqual(calculateWinRate(3, 4), 75);
    });

    it("returns 100% / 0% win rate at the extremes", () => {
      assert.strictEqual(calculateWinRate(2, 2), 100);
      assert.strictEqual(calculateWinRate(0, 2), 0);
    });

    it("returns 0 win rate when there are no closed trades", () => {
      assert.strictEqual(calculateWinRate(0, 0), 0);
    });
  });

  // =========================================================================
  // Demo mode — assert the REAL payload the action returns
  // =========================================================================
  describe("Demo mode (real demoDashboardStats payload)", () => {
    it("has the ActionResponse<DashboardStats> shape the action returns", () => {
      assert.ok(demoDashboardStats.portfolio);
      assert.ok(demoDashboardStats.trading);
      assert.strictEqual(
        typeof demoDashboardStats.portfolio.totalValue,
        "number"
      );
      assert.strictEqual(
        typeof demoDashboardStats.portfolio.totalPnL,
        "number"
      );
      assert.strictEqual(
        typeof demoDashboardStats.portfolio.pnlPercentage,
        "string"
      );
      assert.strictEqual(
        typeof demoDashboardStats.trading.totalTrades,
        "number"
      );
      assert.strictEqual(typeof demoDashboardStats.trading.winRate, "number");
      assert.strictEqual(typeof demoDashboardStats.trading.bestTrade, "object");
      assert.strictEqual(
        typeof demoDashboardStats.trading.worstTrade,
        "object"
      );
    });

    it("carries only finite, plausible portfolio numbers", () => {
      const p = demoDashboardStats.portfolio;
      for (const v of [
        p.totalValue,
        p.totalPnL,
        p.holdingsValue,
        p.holdingsInvested,
        p.holdingsPnL,
        p.mfValue,
        p.mfInvested,
        p.mfPnL,
        p.openPositionsValue,
        p.openPositionsPnL,
      ]) {
        assert.ok(Number.isFinite(v));
      }
      assert.ok(p.totalValue > 0);
      assert.ok(p.holdingsValue > 0);
      assert.ok(Number.isFinite(Number(p.pnlPercentage)));
    });

    it("win rate is within [0, 100] and trade counts are sane", () => {
      const t = demoDashboardStats.trading;
      assert.ok(t.winRate >= 0 && t.winRate <= 100);
      assert.ok(t.totalTrades > 0);
      assert.ok(t.winners + t.losers <= t.totalTrades);
      assert.ok(t.bestTrade.pnl > 0);
      assert.ok(t.worstTrade.pnl < 0);
    });

    it("segment P&L sums to the demo total P&L", () => {
      const p = demoDashboardStats.portfolio;
      assert.strictEqual(
        p.holdingsPnL + p.mfPnL + p.openPositionsPnL,
        p.totalPnL
      );
    });

    it("segment values sum to the demo total value", () => {
      const p = demoDashboardStats.portfolio;
      assert.strictEqual(
        p.holdingsValue + p.mfValue + p.openPositionsValue,
        p.totalValue
      );
    });

    it("re-deriving the demo P&L percentage from holdings matches the stored string magnitude", () => {
      const p = demoDashboardStats.portfolio;
      const derived = Number(
        calculatePnLPercentage(p.holdingsPnL, p.holdingsInvested)
      );
      // The demo string is an illustrative round; assert it is finite and the
      // same sign/ballpark as the recomputed value (within 0.5pp).
      assert.ok(Number.isFinite(derived));
      assert.ok(Math.abs(derived - Number(p.pnlPercentage)) < 0.5);
    });
  });
});
