/**
 * Demo Data Consistency Tests
 *
 * Exercises the REAL centralized demo data exported from
 * apps/web/lib/demo/data.ts — `demoDashboardStats`, `demoHoldings`,
 * `demoPositions`, `demoTrades`, `demoMutualFunds`, `demoPaperPositions` — not
 * an inline copy. These are the exact objects the demo flow serves, so a drift
 * in the real data (e.g. a P&L that no longer adds up, a broken broker-ID, an
 * emptied dataset) now fails this suite instead of passing against a stale
 * mirror.
 *
 * Validates:
 * - Dashboard totals add up (holdings + MF + positions)
 * - Holdings structure: required fields, positive values, valid sectors
 * - Broker IDs consistent across holdings/positions/trades
 * - Symbol consistency: holdings symbols appear in trades
 * - P&L math: currentValue = quantity * currentPrice
 * - Positions: valid direction, positive prices
 * - Trades: valid tradeType, dates, quantities
 * - Mutual fund data: valid schemeCode, nav, units
 * - No empty arrays in any demo dataset
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  demoDashboardStats,
  demoHoldings,
  demoPositions,
  demoTrades,
  demoMutualFunds,
  demoPaperPositions,
} from "@/lib/demo/data";

// ============== TEST EXPECTATIONS (allowed value sets) ==============

// Valid broker IDs used across the demo data
const VALID_BROKER_IDS = ["AB1234", "ZH1234", "GR5678", "DH9012"];
const VALID_BROKERS = ["ZERODHA", "GROWW", "DHAN"];
const VALID_SECTORS = [
  "Energy",
  "IT",
  "Banking",
  "Automobile",
  "Pharma",
  "FMCG",
  "Metals",
  "Telecom",
  "Other",
];

// ============== TESTS ==============

describe("Demo Data Consistency", () => {
  // ── Dashboard Stats ──────────────────────────────────────────

  describe("Dashboard totals", () => {
    it("totalValue = holdingsValue + mfValue + openPositionsValue", () => {
      const { holdingsValue, mfValue, openPositionsValue, totalValue } =
        demoDashboardStats.portfolio;
      assert.strictEqual(
        totalValue,
        holdingsValue + mfValue + openPositionsValue
      );
    });

    it("totalPnL = holdingsPnL + mfPnL + openPositionsPnL", () => {
      const { holdingsPnL, mfPnL, openPositionsPnL, totalPnL } =
        demoDashboardStats.portfolio;
      assert.strictEqual(totalPnL, holdingsPnL + mfPnL + openPositionsPnL);
    });

    it("pnlPercentage should be a valid numeric string", () => {
      const pct = parseFloat(demoDashboardStats.portfolio.pnlPercentage);
      assert.ok(!isNaN(pct));
      assert.ok(pct > 0);
    });

    it("holdingsValue should be positive", () => {
      assert.ok(demoDashboardStats.portfolio.holdingsValue > 0);
    });

    it("mfValue should be positive", () => {
      assert.ok(demoDashboardStats.portfolio.mfValue > 0);
    });

    it("openPositionsValue should be positive", () => {
      assert.ok(demoDashboardStats.portfolio.openPositionsValue > 0);
    });

    it("holdingsInvested should be less than holdingsValue (positive PnL)", () => {
      const { holdingsInvested, holdingsValue } = demoDashboardStats.portfolio;
      assert.ok(holdingsInvested < holdingsValue);
    });

    it("holdingsPnL = holdingsValue - holdingsInvested", () => {
      const { holdingsValue, holdingsInvested, holdingsPnL } =
        demoDashboardStats.portfolio;
      assert.strictEqual(holdingsPnL, holdingsValue - holdingsInvested);
    });

    it("mfPnL = mfValue - mfInvested", () => {
      const { mfValue, mfInvested, mfPnL } = demoDashboardStats.portfolio;
      assert.strictEqual(mfPnL, mfValue - mfInvested);
    });
  });

  describe("Trading stats", () => {
    it("totalTrades should match demo trades count", () => {
      assert.strictEqual(
        demoDashboardStats.trading.totalTrades,
        demoTrades.length
      );
    });

    it("winRate should be between 0 and 100", () => {
      assert.ok(demoDashboardStats.trading.winRate >= 0);
      assert.ok(demoDashboardStats.trading.winRate <= 100);
    });

    it("winners + losers should equal closed trades count", () => {
      const { winners, losers } = demoDashboardStats.trading;
      const closedTrades = demoTrades.filter(
        (t) => t.status === "CLOSED"
      ).length;
      assert.strictEqual(winners + losers, closedTrades);
    });

    it("bestTrade should have positive P&L", () => {
      assert.ok(demoDashboardStats.trading.bestTrade.pnl > 0);
    });

    it("worstTrade should have negative P&L", () => {
      assert.ok(demoDashboardStats.trading.worstTrade.pnl < 0);
    });

    it("bestTrade symbol should exist in trades", () => {
      const symbols = demoTrades.map((t) => t.symbol);
      assert.ok(symbols.includes(demoDashboardStats.trading.bestTrade.symbol));
    });

    it("worstTrade symbol should exist in trades", () => {
      const symbols = demoTrades.map((t) => t.symbol);
      assert.ok(symbols.includes(demoDashboardStats.trading.worstTrade.symbol));
    });
  });

  // ── Holdings Structure ───────────────────────────────────────

  describe("Holdings structure", () => {
    it("should have at least 1 holding", () => {
      assert.ok(demoHoldings.length > 0);
    });

    it("should have 6 holdings", () => {
      assert.strictEqual(demoHoldings.length, 6);
    });

    it("each holding should have required fields", () => {
      for (const h of demoHoldings) {
        assert.ok(h.id, `Missing id for ${h.symbol}`);
        assert.ok(h.symbol, `Missing symbol`);
        assert.ok(h.name, `Missing name for ${h.symbol}`);
        assert.ok(h.sector, `Missing sector for ${h.symbol}`);
        assert.ok(h.exchange, `Missing exchange for ${h.symbol}`);
        assert.ok(h.broker, `Missing broker for ${h.symbol}`);
        assert.ok(h.brokerUserId, `Missing brokerUserId for ${h.symbol}`);
      }
    });

    it("each holding should have positive quantity", () => {
      for (const h of demoHoldings) {
        assert.ok(h.quantity > 0, `${h.symbol} quantity should be > 0`);
      }
    });

    it("each holding should have positive avgPrice", () => {
      for (const h of demoHoldings) {
        assert.ok(h.averagePrice > 0, `${h.symbol} averagePrice should be > 0`);
      }
    });

    it("each holding should have positive currentPrice", () => {
      for (const h of demoHoldings) {
        assert.ok(h.currentPrice > 0, `${h.symbol} currentPrice should be > 0`);
      }
    });

    it("each holding should have valid sector", () => {
      for (const h of demoHoldings) {
        assert.ok(
          VALID_SECTORS.includes(h.sector),
          `${h.symbol} has invalid sector: ${h.sector}`
        );
      }
    });

    it("each holding should have valid broker", () => {
      for (const h of demoHoldings) {
        assert.ok(
          VALID_BROKERS.includes(h.broker),
          `${h.symbol} has invalid broker: ${h.broker}`
        );
      }
    });

    it("holding IDs should be unique", () => {
      const ids = new Set(demoHoldings.map((h) => h.id));
      assert.strictEqual(ids.size, demoHoldings.length);
    });

    it("holding symbols should be unique", () => {
      const symbols = new Set(demoHoldings.map((h) => h.symbol));
      assert.strictEqual(symbols.size, demoHoldings.length);
    });
  });

  // ── P&L Math ─────────────────────────────────────────────────

  describe("Holdings P&L math", () => {
    it("investedValue = quantity * averagePrice (within rounding)", () => {
      for (const h of demoHoldings) {
        const expected = h.quantity * h.averagePrice;
        assert.ok(
          Math.abs(h.investedValue - expected) < 0.01,
          `${h.symbol}: ${h.investedValue} !== ${expected}`
        );
      }
    });

    it("currentValue = quantity * currentPrice (within rounding)", () => {
      for (const h of demoHoldings) {
        const expected = h.quantity * h.currentPrice;
        assert.ok(
          Math.abs(h.currentValue - expected) < 0.01,
          `${h.symbol}: ${h.currentValue} !== ${expected}`
        );
      }
    });

    it("unrealizedPnL = currentValue - investedValue", () => {
      for (const h of demoHoldings) {
        const expected = h.currentValue - h.investedValue;
        assert.ok(
          Math.abs(h.unrealizedPnL - expected) < 0.01,
          `${h.symbol}: ${h.unrealizedPnL} !== ${expected}`
        );
      }
    });

    it("pnlPercentage = (unrealizedPnL / investedValue) * 100 (within 0.1)", () => {
      for (const h of demoHoldings) {
        const expected = (h.unrealizedPnL / h.investedValue) * 100;
        assert.ok(
          Math.abs(h.pnlPercentage - expected) < 0.1,
          `${h.symbol}: ${h.pnlPercentage} !== ${expected.toFixed(2)}`
        );
      }
    });
  });

  // ── Broker ID Consistency ────────────────────────────────────

  describe("Broker ID consistency", () => {
    it("all holdings broker IDs should be valid", () => {
      for (const h of demoHoldings) {
        assert.ok(
          VALID_BROKER_IDS.includes(h.brokerUserId),
          `${h.symbol} has unknown brokerUserId: ${h.brokerUserId}`
        );
      }
    });

    it("all trades broker IDs should be valid", () => {
      for (const t of demoTrades) {
        assert.ok(
          VALID_BROKER_IDS.includes(t.brokerUserId),
          `${t.symbol} has unknown brokerUserId: ${t.brokerUserId}`
        );
      }
    });

    it("all positions broker IDs should be valid", () => {
      for (const p of demoPositions) {
        assert.ok(
          VALID_BROKER_IDS.includes(p.brokerUserId),
          `${p.symbol} has unknown brokerUserId: ${p.brokerUserId}`
        );
      }
    });

    it("all MF broker IDs should be valid", () => {
      for (const mf of demoMutualFunds) {
        assert.ok(
          VALID_BROKER_IDS.includes(mf.brokerUserId),
          `${mf.schemeName} has unknown brokerUserId: ${mf.brokerUserId}`
        );
      }
    });

    it("ZERODHA holdings use AB1234 broker ID", () => {
      const zerodhaHoldings = demoHoldings.filter(
        (h) => h.broker === "ZERODHA"
      );
      for (const h of zerodhaHoldings) {
        assert.strictEqual(h.brokerUserId, "AB1234");
      }
    });

    it("GROWW holdings use GR5678 broker ID", () => {
      const growwHoldings = demoHoldings.filter((h) => h.broker === "GROWW");
      for (const h of growwHoldings) {
        assert.strictEqual(h.brokerUserId, "GR5678");
      }
    });

    it("DHAN holdings use DH9012 broker ID", () => {
      const dhanHoldings = demoHoldings.filter((h) => h.broker === "DHAN");
      for (const h of dhanHoldings) {
        assert.strictEqual(h.brokerUserId, "DH9012");
      }
    });
  });

  // ── Symbol Consistency ───────────────────────────────────────

  describe("Symbol consistency across datasets", () => {
    it("most holdings symbols should appear in trades", () => {
      const tradeSymbols = new Set(demoTrades.map((t) => t.symbol));
      const holdingSymbols = demoHoldings.map((h) => h.symbol);
      const overlap = holdingSymbols.filter((s) => tradeSymbols.has(s));
      // At least 50% overlap expected
      assert.ok(overlap.length >= holdingSymbols.length * 0.5);
    });

    it("position symbols should exist in holdings", () => {
      const holdingSymbols = new Set(demoHoldings.map((h) => h.symbol));
      for (const p of demoPositions) {
        assert.ok(
          holdingSymbols.has(p.symbol),
          `Position symbol ${p.symbol} not in holdings`
        );
      }
    });
  });

  // ── Positions ────────────────────────────────────────────────

  describe("Positions structure", () => {
    it("should have at least 1 position", () => {
      assert.ok(demoPositions.length > 0);
    });

    it("each position should have valid direction", () => {
      for (const p of demoPositions) {
        assert.ok(
          ["LONG", "SHORT"].includes(p.positionType),
          `${p.symbol} has invalid positionType: ${p.positionType}`
        );
      }
    });

    it("each position should have positive entryPrice", () => {
      for (const p of demoPositions) {
        assert.ok(p.entryPrice > 0, `${p.symbol} entryPrice should be > 0`);
      }
    });

    it("each position should have positive quantity", () => {
      for (const p of demoPositions) {
        assert.ok(p.quantity > 0, `${p.symbol} quantity should be > 0`);
      }
    });

    it("each position should have OPEN status", () => {
      for (const p of demoPositions) {
        assert.strictEqual(p.status, "OPEN");
      }
    });

    it("LONG position should have BUY tradeType", () => {
      const longs = demoPositions.filter((p) => p.positionType === "LONG");
      for (const p of longs) {
        assert.strictEqual(
          p.tradeType,
          "BUY",
          `${p.symbol} LONG should be BUY`
        );
      }
    });

    it("SHORT position should have SELL tradeType", () => {
      const shorts = demoPositions.filter((p) => p.positionType === "SHORT");
      for (const p of shorts) {
        assert.strictEqual(
          p.tradeType,
          "SELL",
          `${p.symbol} SHORT should be SELL`
        );
      }
    });
  });

  // ── Trades ───────────────────────────────────────────────────

  describe("Trades structure", () => {
    it("should have 7 trades", () => {
      assert.strictEqual(demoTrades.length, 7);
    });

    it("each trade should have valid tradeType", () => {
      for (const t of demoTrades) {
        assert.ok(
          ["BUY", "SELL"].includes(t.tradeType),
          `${t.symbol} has invalid tradeType: ${t.tradeType}`
        );
      }
    });

    it("each trade should have positive quantity", () => {
      for (const t of demoTrades) {
        assert.ok(t.quantity > 0, `${t.symbol} quantity should be > 0`);
      }
    });

    it("each trade should have positive price", () => {
      for (const t of demoTrades) {
        assert.ok(t.price > 0, `${t.symbol} price should be > 0`);
      }
    });

    it("each trade should have valid date", () => {
      for (const t of demoTrades) {
        assert.ok(
          t.tradeDate instanceof Date,
          `${t.symbol} tradeDate should be a Date`
        );
        assert.ok(
          !isNaN(t.tradeDate.getTime()),
          `${t.symbol} tradeDate should be valid`
        );
      }
    });

    it("trade IDs should be unique", () => {
      const ids = new Set(demoTrades.map((t) => t.id));
      assert.strictEqual(ids.size, demoTrades.length);
    });

    it("CLOSED trades should have exitPrice and realizedPnL", () => {
      const closed = demoTrades.filter((t) => t.status === "CLOSED");
      for (const t of closed) {
        assert.ok(
          t.exitPrice !== null,
          `${t.symbol} closed trade should have exitPrice`
        );
        assert.ok(
          t.realizedPnL !== null,
          `${t.symbol} closed trade should have realizedPnL`
        );
      }
    });

    it("OPEN trades should have null exitPrice and realizedPnL", () => {
      const open = demoTrades.filter((t) => t.status === "OPEN");
      for (const t of open) {
        assert.strictEqual(
          t.exitPrice,
          null,
          `${t.symbol} open trade should have null exitPrice`
        );
        assert.strictEqual(
          t.realizedPnL,
          null,
          `${t.symbol} open trade should have null realizedPnL`
        );
      }
    });

    it("realized PnL math should be correct for closed trades (minus brokerage)", () => {
      // Demo trades include brokerage of 20 per trade in P&L calculation
      const BROKERAGE = 20;
      const closed = demoTrades.filter(
        (t) => t.status === "CLOSED" && t.realizedPnL !== null
      );
      for (const t of closed) {
        if (t.exitPrice !== null) {
          const grossPnL = (t.exitPrice - t.price) * t.quantity;
          const expectedPnL = grossPnL - BROKERAGE;
          assert.ok(
            Math.abs((t.realizedPnL as number) - expectedPnL) < 1,
            `${t.symbol}: ${t.realizedPnL} !== ${expectedPnL} (gross: ${grossPnL} - brokerage: ${BROKERAGE})`
          );
        }
      }
    });
  });

  // ── Mutual Funds ─────────────────────────────────────────────

  describe("Mutual Funds structure", () => {
    it("should have at least 1 mutual fund", () => {
      assert.ok(demoMutualFunds.length > 0);
    });

    it("should have 3 mutual funds", () => {
      assert.strictEqual(demoMutualFunds.length, 3);
    });

    it("each MF should have schemeCode", () => {
      for (const mf of demoMutualFunds) {
        assert.ok(mf.schemeCode, `${mf.schemeName} missing schemeCode`);
      }
    });

    it("each MF should have positive nav", () => {
      for (const mf of demoMutualFunds) {
        assert.ok(mf.currentNav > 0, `${mf.schemeName} nav should be > 0`);
      }
    });

    it("each MF should have positive units", () => {
      for (const mf of demoMutualFunds) {
        assert.ok(mf.units > 0, `${mf.schemeName} units should be > 0`);
      }
    });

    it("each MF should have positive investedAmount", () => {
      for (const mf of demoMutualFunds) {
        assert.ok(
          mf.investedAmount > 0,
          `${mf.schemeName} investedAmount should be > 0`
        );
      }
    });

    it("MF unrealizedGain = currentValue - investedAmount (within rounding)", () => {
      for (const mf of demoMutualFunds) {
        const expected = mf.currentValue - mf.investedAmount;
        assert.ok(
          Math.abs(mf.unrealizedGain - expected) < 0.01,
          `${mf.schemeName}: ${mf.unrealizedGain} !== ${expected}`
        );
      }
    });

    it("MF scheme codes should be unique", () => {
      const codes = new Set(demoMutualFunds.map((mf) => mf.schemeCode));
      assert.strictEqual(codes.size, demoMutualFunds.length);
    });

    it("MF xirr should be positive (profitable demo)", () => {
      for (const mf of demoMutualFunds) {
        assert.ok(mf.xirr > 0, `${mf.schemeName} xirr should be > 0`);
      }
    });
  });

  // ── Paper Trading ────────────────────────────────────────────

  describe("Paper Trading positions", () => {
    it("should have at least 1 paper position", () => {
      assert.ok(demoPaperPositions.length > 0);
    });

    it("each paper position should have positive quantity", () => {
      for (const p of demoPaperPositions) {
        assert.ok(p.quantity > 0, `${p.symbol} quantity should be > 0`);
      }
    });

    it("each paper position should have positive averagePrice", () => {
      for (const p of demoPaperPositions) {
        assert.ok(p.averagePrice > 0, `${p.symbol} averagePrice should be > 0`);
      }
    });

    it("paper position IDs should be unique", () => {
      const ids = new Set(demoPaperPositions.map((p) => p.id));
      assert.strictEqual(ids.size, demoPaperPositions.length);
    });
  });

  // ── No Empty Arrays ──────────────────────────────────────────

  describe("No empty arrays", () => {
    it("demoHoldings should not be empty", () => {
      assert.ok(demoHoldings.length > 0);
    });

    it("demoPositions should not be empty", () => {
      assert.ok(demoPositions.length > 0);
    });

    it("demoTrades should not be empty", () => {
      assert.ok(demoTrades.length > 0);
    });

    it("demoMutualFunds should not be empty", () => {
      assert.ok(demoMutualFunds.length > 0);
    });

    it("demoPaperPositions should not be empty", () => {
      assert.ok(demoPaperPositions.length > 0);
    });
  });
});
