/**
 * Financial Calculation Tests
 *
 * Tests for financial utility functions including XIRR, CAGR,
 * absolute return, P&L, and win rate calculations.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateXIRR,
  calculateCAGR,
  calculateAbsoluteReturn,
  calculatePnL,
  calculateWinRate,
} from "@usemoney/utils";

describe("Financial Calculations", () => {
  describe("calculateXIRR", () => {
    it("should calculate positive XIRR for profitable investment", () => {
      // Invested 10000, now worth 12000 after 365 days = ~20% return
      const result = calculateXIRR(10000, 12000, 365);
      assert.ok(result > 19 && result < 21, `Expected ~20%, got ${result}%`);
    });

    it("should calculate negative XIRR for losing investment", () => {
      // Invested 10000, now worth 8000 after 365 days = ~-20% return
      const result = calculateXIRR(10000, 8000, 365);
      assert.ok(result < -19 && result > -21, `Expected ~-20%, got ${result}%`);
    });

    it("should return 0 for zero invested amount", () => {
      const result = calculateXIRR(0, 1000, 365);
      assert.strictEqual(result, 0);
    });

    it("should return 0 for zero days", () => {
      const result = calculateXIRR(10000, 12000, 0);
      assert.strictEqual(result, 0);
    });

    it("should return 0 for very short periods (< 36.5 days)", () => {
      const result = calculateXIRR(10000, 12000, 30);
      assert.strictEqual(result, 0);
    });

    it("should cap return at 999%", () => {
      // Extreme growth
      const result = calculateXIRR(1000, 100000, 365);
      assert.ok(result <= 999, "Should cap at 999%");
    });

    it("should cap loss at -99%", () => {
      // Near total loss
      const result = calculateXIRR(10000, 10, 365);
      assert.ok(result >= -99, "Should cap at -99%");
    });

    it("should handle 2-year investment period", () => {
      // Invested 10000, now worth 14400 after 730 days = ~20% CAGR
      const result = calculateXIRR(10000, 14400, 730);
      assert.ok(result > 19 && result < 21, `Expected ~20%, got ${result}%`);
    });

    it("should handle negative invested amount", () => {
      const result = calculateXIRR(-1000, 1200, 365);
      assert.strictEqual(result, 0);
    });

    it("should handle break-even investment", () => {
      // Invested 10000, still worth 10000 = 0% return
      const result = calculateXIRR(10000, 10000, 365);
      assert.ok(Math.abs(result) < 0.1, `Expected ~0%, got ${result}%`);
    });
  });

  describe("calculateCAGR", () => {
    it("should calculate positive CAGR for growth", () => {
      // 10000 to 12100 in 1 year = 21% CAGR
      const result = calculateCAGR(10000, 12100, 1);
      assert.ok(result > 20 && result < 22, `Expected ~21%, got ${result}%`);
    });

    it("should calculate CAGR for multi-year period", () => {
      // 10000 to 14641 in 2 years = 21% CAGR
      const result = calculateCAGR(10000, 14641, 2);
      assert.ok(result > 20 && result < 22, `Expected ~21%, got ${result}%`);
    });

    it("should calculate negative CAGR for decline", () => {
      // 10000 to 8000 in 1 year = -20% CAGR
      const result = calculateCAGR(10000, 8000, 1);
      assert.ok(result < -19 && result > -21, `Expected ~-20%, got ${result}%`);
    });

    it("should return 0 for zero begin value", () => {
      const result = calculateCAGR(0, 10000, 1);
      assert.strictEqual(result, 0);
    });

    it("should return 0 for zero years", () => {
      const result = calculateCAGR(10000, 12000, 0);
      assert.strictEqual(result, 0);
    });

    it("should handle fractional years", () => {
      // 6 months = 0.5 years
      const result = calculateCAGR(10000, 11000, 0.5);
      assert.ok(result > 0, "Should return positive CAGR");
    });

    it("should cap at 999%", () => {
      const result = calculateCAGR(100, 100000, 1);
      assert.ok(result <= 999);
    });

    it("should cap at -99%", () => {
      const result = calculateCAGR(10000, 1, 1);
      assert.ok(result >= -99);
    });

    it("should handle break-even", () => {
      const result = calculateCAGR(10000, 10000, 1);
      assert.ok(Math.abs(result) < 0.1, `Expected ~0%, got ${result}%`);
    });
  });

  describe("calculateAbsoluteReturn", () => {
    it("should calculate positive absolute return", () => {
      // 10000 to 12000 = 20% return
      const result = calculateAbsoluteReturn(10000, 12000);
      assert.strictEqual(result, 20);
    });

    it("should calculate negative absolute return", () => {
      // 10000 to 8000 = -20% return
      const result = calculateAbsoluteReturn(10000, 8000);
      assert.strictEqual(result, -20);
    });

    it("should return 0 for zero invested", () => {
      const result = calculateAbsoluteReturn(0, 1000);
      assert.strictEqual(result, 0);
    });

    it("should handle break-even", () => {
      const result = calculateAbsoluteReturn(10000, 10000);
      assert.strictEqual(result, 0);
    });

    it("should calculate 100% return (doubling)", () => {
      const result = calculateAbsoluteReturn(10000, 20000);
      assert.strictEqual(result, 100);
    });

    it("should calculate -50% return (halving)", () => {
      const result = calculateAbsoluteReturn(10000, 5000);
      assert.strictEqual(result, -50);
    });

    it("should handle small values", () => {
      const result = calculateAbsoluteReturn(100, 150);
      assert.strictEqual(result, 50);
    });

    it("should handle large values", () => {
      const result = calculateAbsoluteReturn(10000000, 12000000);
      assert.strictEqual(result, 20);
    });
  });

  describe("calculatePnL", () => {
    it("should calculate positive P&L", () => {
      const result = calculatePnL(10000, 12000);
      assert.strictEqual(result, 2000);
    });

    it("should calculate negative P&L", () => {
      const result = calculatePnL(10000, 8000);
      assert.strictEqual(result, -2000);
    });

    it("should return 0 for break-even", () => {
      const result = calculatePnL(10000, 10000);
      assert.strictEqual(result, 0);
    });

    it("should handle zero invested", () => {
      const result = calculatePnL(0, 1000);
      assert.strictEqual(result, 1000);
    });

    it("should handle zero current", () => {
      const result = calculatePnL(10000, 0);
      assert.strictEqual(result, -10000);
    });

    it("should handle decimal values", () => {
      const result = calculatePnL(100.5, 150.75);
      assert.strictEqual(result, 50.25);
    });
  });

  describe("calculateWinRate", () => {
    it("should calculate 50% win rate", () => {
      const result = calculateWinRate(5, 5);
      assert.strictEqual(result, 50);
    });

    it("should calculate 100% win rate", () => {
      const result = calculateWinRate(10, 0);
      assert.strictEqual(result, 100);
    });

    it("should calculate 0% win rate", () => {
      const result = calculateWinRate(0, 10);
      assert.strictEqual(result, 0);
    });

    it("should return 0 when no trades", () => {
      const result = calculateWinRate(0, 0);
      assert.strictEqual(result, 0);
    });

    it("should calculate 75% win rate", () => {
      const result = calculateWinRate(75, 25);
      assert.strictEqual(result, 75);
    });

    it("should handle large numbers", () => {
      const result = calculateWinRate(750, 250);
      assert.strictEqual(result, 75);
    });

    it("should calculate fractional win rate", () => {
      const result = calculateWinRate(1, 2);
      assert.ok(
        Math.abs(result - 33.33) < 0.1,
        `Expected ~33.33%, got ${result}%`
      );
    });
  });
});
