/**
 * Market Data Hooks Tests
 *
 * Unit tests for market data hooks logic (without React rendering).
 * Tests the calculation and transformation logic used in hooks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed: import the REAL P&L math from useLivePositions-logic (the hook
// calls these). The extraction added finite guards so a 0 entryPrice yields
// 0% rather than an Infinity/NaN pnlPercentage that would poison the total.
import {
  calculatePositionPnL,
  calculateTotalPnL,
  calculateTotalDayPnL,
} from "@/hooks/useLivePositions-logic";
import type { Position, LivePosition } from "@/hooks/useLivePositions";

describe("Market Data Hooks Logic", () => {
  describe("Position P&L Calculation", () => {
    describe("BUY positions", () => {
      it("should calculate positive P&L when price goes up", () => {
        const position: Position = {
          id: "1",
          symbol: "RELIANCE",
          quantity: 10,
          entryPrice: 2500,
          currentPrice: 2500,
          action: "BUY",
        };

        const result = calculatePositionPnL(position, 2600);
        assert.strictEqual(result.pnl, 1000); // (2600 - 2500) * 10 * 1
        assert.strictEqual(result.pnlPercentage, 4); // ((2600 - 2500) / 2500) * 100 * 1
      });

      it("should calculate negative P&L when price goes down", () => {
        const position: Position = {
          id: "1",
          symbol: "RELIANCE",
          quantity: 10,
          entryPrice: 2500,
          currentPrice: 2500,
          action: "BUY",
        };

        const result = calculatePositionPnL(position, 2400);
        assert.strictEqual(result.pnl, -1000); // (2400 - 2500) * 10 * 1
        assert.strictEqual(result.pnlPercentage, -4); // ((2400 - 2500) / 2500) * 100 * 1
      });

      it("should calculate zero P&L when price unchanged", () => {
        const position: Position = {
          id: "1",
          symbol: "RELIANCE",
          quantity: 10,
          entryPrice: 2500,
          currentPrice: 2500,
          action: "BUY",
        };

        const result = calculatePositionPnL(position, 2500);
        assert.strictEqual(result.pnl, 0);
        assert.strictEqual(result.pnlPercentage, 0);
      });
    });

    describe("SELL positions", () => {
      it("should calculate positive P&L when price goes down", () => {
        const position: Position = {
          id: "1",
          symbol: "RELIANCE",
          quantity: 10,
          entryPrice: 2500,
          currentPrice: 2500,
          action: "SELL",
        };

        const result = calculatePositionPnL(position, 2400);
        // SELL profits when price drops: (2400 - 2500) * 10 * -1 = 1000
        assert.strictEqual(result.pnl, 1000);
      });

      it("should calculate negative P&L when price goes up", () => {
        const position: Position = {
          id: "1",
          symbol: "RELIANCE",
          quantity: 10,
          entryPrice: 2500,
          currentPrice: 2500,
          action: "SELL",
        };

        const result = calculatePositionPnL(position, 2600);
        // SELL loses when price rises: (2600 - 2500) * 10 * -1 = -1000
        assert.strictEqual(result.pnl, -1000);
      });
    });

    describe("non-finite guards (regression)", () => {
      it("should yield 0% (not Infinity) when entryPrice is 0", () => {
        // Regression: ((currentPrice - 0) / 0) = Infinity. An Infinity
        // pnlPercentage renders as a broken value and poisons aggregates,
        // so calculatePositionPnL must guard the division.
        const position: Position = {
          id: "1",
          symbol: "NEWLISTING",
          quantity: 10,
          entryPrice: 0,
          currentPrice: 0,
          action: "BUY",
        };

        const result = calculatePositionPnL(position, 150);
        assert.strictEqual(result.pnlPercentage, 0);
        assert.ok(
          Number.isFinite(result.pnlPercentage),
          "pnlPercentage must be finite"
        );
        assert.ok(Number.isFinite(result.pnl), "pnl must be finite");
      });

      it("should never let a poisoned row NaN the total P&L", () => {
        const zeroEntry: Position = {
          id: "1",
          symbol: "ZERO",
          quantity: 5,
          entryPrice: 0,
          currentPrice: 0,
          action: "BUY",
        };
        const normal: Position = {
          id: "2",
          symbol: "RELIANCE",
          quantity: 10,
          entryPrice: 2500,
          currentPrice: 2500,
          action: "BUY",
        };

        const rows = [
          calculatePositionPnL(zeroEntry, 100),
          calculatePositionPnL(normal, 2600),
        ];
        const total = calculateTotalPnL(rows);
        assert.ok(Number.isFinite(total), "total P&L must be finite");
        // normal row contributes (2600-2500)*10 = 1000; zero-entry row is
        // a finite 500 ((100-0)*5). Both finite → total is their sum.
        assert.strictEqual(total, 1500);
      });
    });

    describe("Day change calculation", () => {
      it("should calculate day change for BUY position", () => {
        const position: Position = {
          id: "1",
          symbol: "RELIANCE",
          quantity: 10,
          entryPrice: 2500,
          currentPrice: 2500,
          action: "BUY",
        };

        const quote = { change: 50, changePercent: 2 };
        const result = calculatePositionPnL(position, 2600, quote);

        // Day change: 50 * 10 * 1 = 500
        assert.strictEqual(result.dayChange, 500);
        assert.strictEqual(result.dayChangePercent, 2);
      });

      it("should calculate day change for SELL position", () => {
        const position: Position = {
          id: "1",
          symbol: "RELIANCE",
          quantity: 10,
          entryPrice: 2500,
          currentPrice: 2500,
          action: "SELL",
        };

        const quote = { change: 50, changePercent: 2 };
        const result = calculatePositionPnL(position, 2600, quote);

        // Day change: 50 * 10 * -1 = -500 (SELL loses on price increase)
        assert.strictEqual(result.dayChange, -500);
        assert.strictEqual(result.dayChangePercent, 2);
      });

      it("should handle missing quote data", () => {
        const position: Position = {
          id: "1",
          symbol: "RELIANCE",
          quantity: 10,
          entryPrice: 2500,
          currentPrice: 2500,
          action: "BUY",
        };

        const result = calculatePositionPnL(position, 2600);
        assert.strictEqual(result.dayChange, 0);
        assert.strictEqual(result.dayChangePercent, 0);
      });
    });

    describe("Large quantity positions", () => {
      it("should handle large quantities correctly", () => {
        const position: Position = {
          id: "1",
          symbol: "RELIANCE",
          quantity: 1000,
          entryPrice: 2500,
          currentPrice: 2500,
          action: "BUY",
        };

        const result = calculatePositionPnL(position, 2550);
        assert.strictEqual(result.pnl, 50000); // 50 * 1000
      });

      it("should handle fractional price changes", () => {
        const position: Position = {
          id: "1",
          symbol: "RELIANCE",
          quantity: 100,
          entryPrice: 2500.5,
          currentPrice: 2500.5,
          action: "BUY",
        };

        const result = calculatePositionPnL(position, 2501.5);
        assert.strictEqual(result.pnl, 100); // 1 * 100
      });
    });
  });

  describe("Total P&L Calculation", () => {
    it("should sum positive P&Ls", () => {
      const positions: LivePosition[] = [
        {
          id: "1",
          symbol: "RELIANCE",
          quantity: 10,
          entryPrice: 2500,
          currentPrice: 2600,
          action: "BUY",
          pnl: 1000,
          pnlPercentage: 4,
          dayChange: 500,
          dayChangePercent: 2,
        },
        {
          id: "2",
          symbol: "TCS",
          quantity: 5,
          entryPrice: 3500,
          currentPrice: 3600,
          action: "BUY",
          pnl: 500,
          pnlPercentage: 2.86,
          dayChange: 250,
          dayChangePercent: 1.5,
        },
      ];

      const total = calculateTotalPnL(positions);
      assert.strictEqual(total, 1500);
    });

    it("should sum mixed P&Ls correctly", () => {
      const positions: LivePosition[] = [
        {
          id: "1",
          symbol: "RELIANCE",
          quantity: 10,
          entryPrice: 2500,
          currentPrice: 2600,
          action: "BUY",
          pnl: 1000,
          pnlPercentage: 4,
          dayChange: 500,
          dayChangePercent: 2,
        },
        {
          id: "2",
          symbol: "TCS",
          quantity: 5,
          entryPrice: 3500,
          currentPrice: 3400,
          action: "BUY",
          pnl: -500,
          pnlPercentage: -2.86,
          dayChange: -250,
          dayChangePercent: -1.5,
        },
      ];

      const total = calculateTotalPnL(positions);
      assert.strictEqual(total, 500);
    });

    it("should return 0 for empty positions", () => {
      const total = calculateTotalPnL([]);
      assert.strictEqual(total, 0);
    });
  });

  describe("Total Day P&L Calculation", () => {
    it("should sum day changes", () => {
      const positions: LivePosition[] = [
        {
          id: "1",
          symbol: "RELIANCE",
          quantity: 10,
          entryPrice: 2500,
          currentPrice: 2600,
          action: "BUY",
          pnl: 1000,
          pnlPercentage: 4,
          dayChange: 500,
          dayChangePercent: 2,
        },
        {
          id: "2",
          symbol: "TCS",
          quantity: 5,
          entryPrice: 3500,
          currentPrice: 3600,
          action: "BUY",
          pnl: 500,
          pnlPercentage: 2.86,
          dayChange: 250,
          dayChangePercent: 1.5,
        },
      ];

      const total = calculateTotalDayPnL(positions);
      assert.strictEqual(total, 750);
    });

    it("should handle negative day changes", () => {
      const positions: LivePosition[] = [
        {
          id: "1",
          symbol: "RELIANCE",
          quantity: 10,
          entryPrice: 2500,
          currentPrice: 2400,
          action: "BUY",
          pnl: -1000,
          pnlPercentage: -4,
          dayChange: -500,
          dayChangePercent: -2,
        },
      ];

      const total = calculateTotalDayPnL(positions);
      assert.strictEqual(total, -500);
    });
  });

  describe("Symbol extraction", () => {
    it("should extract unique symbols from positions", () => {
      const positions: Position[] = [
        {
          id: "1",
          symbol: "RELIANCE",
          quantity: 10,
          entryPrice: 2500,
          currentPrice: 2500,
          action: "BUY",
        },
        {
          id: "2",
          symbol: "TCS",
          quantity: 5,
          entryPrice: 3500,
          currentPrice: 3500,
          action: "BUY",
        },
        {
          id: "3",
          symbol: "RELIANCE",
          quantity: 20,
          entryPrice: 2550,
          currentPrice: 2550,
          action: "BUY",
        },
      ];

      const symbols = Array.from(new Set(positions.map((p) => p.symbol)));
      assert.deepStrictEqual(symbols.sort(), ["RELIANCE", "TCS"]);
    });

    it("should handle empty positions array", () => {
      const positions: Position[] = [];
      const symbols = Array.from(new Set(positions.map((p) => p.symbol)));
      assert.deepStrictEqual(symbols, []);
    });
  });
});

describe("Chart Data Transformation", () => {
  // Types from useHistoricalData
  interface HistoricalBar {
    date: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }

  interface ChartBar {
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
  }

  // Helper function that mirrors hook logic
  function transformToChartData(bars: HistoricalBar[]): ChartBar[] {
    return bars.map((bar) => ({
      time: bar.date.toISOString().split("T")[0],
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    }));
  }

  it("should transform historical bars to chart format", () => {
    const bars: HistoricalBar[] = [
      {
        date: new Date("2024-01-15"),
        open: 2500,
        high: 2550,
        low: 2480,
        close: 2530,
        volume: 1000000,
      },
    ];

    const result = transformToChartData(bars);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].time, "2024-01-15");
    assert.strictEqual(result[0].open, 2500);
    assert.strictEqual(result[0].high, 2550);
    assert.strictEqual(result[0].low, 2480);
    assert.strictEqual(result[0].close, 2530);
  });

  it("should handle multiple bars", () => {
    const bars: HistoricalBar[] = [
      {
        date: new Date("2024-01-15"),
        open: 2500,
        high: 2550,
        low: 2480,
        close: 2530,
        volume: 1000000,
      },
      {
        date: new Date("2024-01-16"),
        open: 2530,
        high: 2580,
        low: 2520,
        close: 2570,
        volume: 1200000,
      },
    ];

    const result = transformToChartData(bars);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].time, "2024-01-15");
    assert.strictEqual(result[1].time, "2024-01-16");
  });

  it("should handle empty bars array", () => {
    const result = transformToChartData([]);
    assert.deepStrictEqual(result, []);
  });

  it("should exclude volume from chart data", () => {
    const bars: HistoricalBar[] = [
      {
        date: new Date("2024-01-15"),
        open: 2500,
        high: 2550,
        low: 2480,
        close: 2530,
        volume: 1000000,
      },
    ];

    const result = transformToChartData(bars);
    assert.ok(!("volume" in result[0]));
  });
});

describe("Market Hours Check", () => {
  // Helper function to check if market is open
  function isMarketOpen(now: Date = new Date()): boolean {
    const day = now.getDay();
    // Market closed on weekends
    if (day === 0 || day === 6) return false;

    const hours = now.getHours();
    const minutes = now.getMinutes();
    const timeInMinutes = hours * 60 + minutes;

    // NSE market hours: 9:15 AM to 3:30 PM IST
    const marketOpen = 9 * 60 + 15; // 555 minutes
    const marketClose = 15 * 60 + 30; // 930 minutes

    return timeInMinutes >= marketOpen && timeInMinutes <= marketClose;
  }

  it("should return false on Saturday", () => {
    // Saturday, January 20, 2024, 10:00 AM
    const saturday = new Date("2024-01-20T10:00:00+05:30");
    assert.strictEqual(isMarketOpen(saturday), false);
  });

  it("should return false on Sunday", () => {
    // Sunday, January 21, 2024, 10:00 AM
    const sunday = new Date("2024-01-21T10:00:00+05:30");
    assert.strictEqual(isMarketOpen(sunday), false);
  });

  it("should return false before market open on weekday", () => {
    // Monday, January 22, 2024, 8:00 AM
    const earlyMorning = new Date("2024-01-22T08:00:00");
    assert.strictEqual(isMarketOpen(earlyMorning), false);
  });

  it("should return true during market hours on weekday", () => {
    // Monday, January 22, 2024, 11:00 AM
    const midday = new Date("2024-01-22T11:00:00");
    assert.strictEqual(isMarketOpen(midday), true);
  });

  it("should return false after market close on weekday", () => {
    // Monday, January 22, 2024, 4:00 PM
    const afternoon = new Date("2024-01-22T16:00:00");
    assert.strictEqual(isMarketOpen(afternoon), false);
  });

  it("should return true at market open time", () => {
    // Monday, January 22, 2024, 9:15 AM
    const marketOpen = new Date("2024-01-22T09:15:00");
    assert.strictEqual(isMarketOpen(marketOpen), true);
  });

  it("should return true at market close time", () => {
    // Monday, January 22, 2024, 3:30 PM
    const marketClose = new Date("2024-01-22T15:30:00");
    assert.strictEqual(isMarketOpen(marketClose), true);
  });
});
