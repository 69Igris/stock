/**
 * Discover Page Tests
 *
 * Tests for discovery logic extracted from:
 *   apps/web/lib/actions/discover.ts
 *
 * Covers:
 * - Top gainers derivation (positive change, exclude spikes > 50%)
 * - Top losers derivation (negative change, exclude crashes > -50%)
 * - Stock filtering (must have volume or marketCap)
 * - Sector counts computation
 * - Sorting by changePercent, marketCap, name
 * - Pagination/limit logic
 * - Data transformation from instruments + quotes
 * - Default options resolution
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// DE-SHADOWED (MONEY-620): the gainers/losers derivation + the sector sort
// comparators now import the REAL exported helpers from the service logic
// module — the exact code `packages/services/src/discover.service.ts` CALLS.
// (The previous inline copies "mirrored getAllStocksData" and asserted the
// copy while the live order-unstable NaN sort shipped.) The remaining inline
// helpers below (filterValidStocks / computeSectorCounts / resolveSectorOptions)
// are trivial assembly utilities outside the extracted ranking surface.
import {
  rankGainers as deriveTopGainers,
  rankLosers as deriveTopLosers,
  sortStocksBySector,
} from "../../../../packages/services/src/discover-logic";

/** Sort by |abs| %change desc — thin wrapper over the real sector sort. */
function sortByChangePercent(stocks: DiscoverStock[]): DiscoverStock[] {
  return sortStocksBySector(stocks, "changePercent");
}
/** Sort by marketCap desc — thin wrapper over the real sector sort. */
function sortByMarketCap(stocks: DiscoverStock[]): DiscoverStock[] {
  return sortStocksBySector(stocks, "marketCap");
}

// --- Mock Types ---

interface DiscoverStock {
  symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  instrumentType: string;
  instrumentId: string;
  yahooSymbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number | null;
  marketCap: number | null;
}

// --- Inline assembly helpers (outside the extracted ranking surface) ---

/**
 * Filter stocks that have either volume or marketCap.
 * Mirrors the filter in getAllStocksData().
 */
function filterValidStocks(stocks: DiscoverStock[]): DiscoverStock[] {
  return stocks.filter((s) => s.volume || s.marketCap);
}

/**
 * Compute sector counts from instruments.
 * Mirrors the sector count logic in getAllStocksData().
 */
function computeSectorCounts(
  instruments: Array<{ sector: string | null }>
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const inst of instruments) {
    if (inst.sector) {
      counts.set(inst.sector, (counts.get(inst.sector) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Resolve default options for getStocksBySectorAction.
 */
function resolveSectorOptions(options: {
  limit?: number;
  sortBy?: "name" | "changePercent" | "marketCap";
}): { limit: number; sortBy: "name" | "changePercent" | "marketCap" } {
  return {
    limit: options.limit ?? 20,
    sortBy: options.sortBy ?? "name",
  };
}

// --- Mock Data Generators ---

function makeStock(overrides: Partial<DiscoverStock> = {}): DiscoverStock {
  return {
    symbol: "TEST",
    name: "Test Stock",
    exchange: "NSE",
    sector: "Technology",
    instrumentType: "EQUITY",
    instrumentId: "inst-1",
    yahooSymbol: "TEST.NS",
    price: 100,
    change: 0,
    changePercent: 0,
    volume: 1000,
    marketCap: 100_000_000,
    ...overrides,
  };
}

// --- Tests ---

describe("Discover Actions", () => {
  // -- Top Gainers --

  describe("deriveTopGainers", () => {
    it("should include only stocks with positive changePercent", () => {
      const stocks = [
        makeStock({ symbol: "UP", changePercent: 5, change: 5 }),
        makeStock({ symbol: "DOWN", changePercent: -3, change: -3 }),
        makeStock({ symbol: "FLAT", changePercent: 0, change: 0 }),
      ];
      const gainers = deriveTopGainers(stocks);
      assert.strictEqual(gainers.length, 1);
      assert.strictEqual(gainers[0].symbol, "UP");
    });

    it("should exclude spikes over 50%", () => {
      const stocks = [
        makeStock({ symbol: "NORMAL", changePercent: 10, change: 10 }),
        makeStock({ symbol: "SPIKE", changePercent: 55, change: 55 }),
        makeStock({ symbol: "BORDER", changePercent: 50, change: 50 }),
      ];
      const gainers = deriveTopGainers(stocks);
      assert.strictEqual(gainers.length, 2);
      assert.ok(gainers.every((g) => g.changePercent <= 50));
    });

    it("should sort by changePercent descending", () => {
      const stocks = [
        makeStock({ symbol: "LOW", changePercent: 2, change: 2 }),
        makeStock({ symbol: "HIGH", changePercent: 15, change: 15 }),
        makeStock({ symbol: "MID", changePercent: 8, change: 8 }),
      ];
      const gainers = deriveTopGainers(stocks);
      assert.strictEqual(gainers[0].symbol, "HIGH");
      assert.strictEqual(gainers[1].symbol, "MID");
      assert.strictEqual(gainers[2].symbol, "LOW");
    });

    it("should limit to specified count", () => {
      const stocks = Array.from({ length: 20 }, (_, i) =>
        makeStock({
          symbol: `S${i}`,
          changePercent: i + 1,
          change: i + 1,
        })
      );
      const gainers = deriveTopGainers(stocks, 5);
      assert.strictEqual(gainers.length, 5);
    });

    it("should exclude stocks with change=0 even if changePercent > 0", () => {
      const stocks = [
        makeStock({ symbol: "ZERO", changePercent: 5, change: 0 }),
      ];
      const gainers = deriveTopGainers(stocks);
      assert.strictEqual(gainers.length, 0);
    });

    it("should return empty for no qualifying stocks", () => {
      const stocks = [
        makeStock({ symbol: "A", changePercent: -2, change: -2 }),
      ];
      assert.strictEqual(deriveTopGainers(stocks).length, 0);
    });

    it("should handle empty input", () => {
      assert.strictEqual(deriveTopGainers([]).length, 0);
    });
  });

  // -- Top Losers --

  describe("deriveTopLosers", () => {
    it("should include only stocks with negative changePercent", () => {
      const stocks = [
        makeStock({ symbol: "UP", changePercent: 5, change: 5 }),
        makeStock({ symbol: "DOWN", changePercent: -3, change: -3 }),
      ];
      const losers = deriveTopLosers(stocks);
      assert.strictEqual(losers.length, 1);
      assert.strictEqual(losers[0].symbol, "DOWN");
    });

    it("should exclude crashes beyond -50%", () => {
      const stocks = [
        makeStock({ symbol: "NORMAL", changePercent: -10, change: -10 }),
        makeStock({ symbol: "CRASH", changePercent: -55, change: -55 }),
        makeStock({ symbol: "BORDER", changePercent: -50, change: -50 }),
      ];
      const losers = deriveTopLosers(stocks);
      assert.strictEqual(losers.length, 2);
      assert.ok(losers.every((l) => l.changePercent >= -50));
    });

    it("should sort by changePercent ascending (biggest loss first)", () => {
      const stocks = [
        makeStock({ symbol: "SMALL", changePercent: -1, change: -1 }),
        makeStock({ symbol: "BIG", changePercent: -15, change: -15 }),
        makeStock({ symbol: "MED", changePercent: -7, change: -7 }),
      ];
      const losers = deriveTopLosers(stocks);
      assert.strictEqual(losers[0].symbol, "BIG");
      assert.strictEqual(losers[1].symbol, "MED");
      assert.strictEqual(losers[2].symbol, "SMALL");
    });

    it("should handle empty input", () => {
      assert.strictEqual(deriveTopLosers([]).length, 0);
    });
  });

  // -- Valid Stock Filtering --

  describe("filterValidStocks", () => {
    it("should include stocks with volume", () => {
      const stocks = [
        makeStock({ symbol: "VOL", volume: 1000, marketCap: null }),
      ];
      assert.strictEqual(filterValidStocks(stocks).length, 1);
    });

    it("should include stocks with marketCap", () => {
      const stocks = [
        makeStock({ symbol: "CAP", volume: null, marketCap: 1000000 }),
      ];
      assert.strictEqual(filterValidStocks(stocks).length, 1);
    });

    it("should exclude stocks with neither volume nor marketCap", () => {
      const stocks = [
        makeStock({ symbol: "EMPTY", volume: null, marketCap: null }),
      ];
      assert.strictEqual(filterValidStocks(stocks).length, 0);
    });

    it("should exclude stocks with volume=0 and marketCap=null", () => {
      const stocks = [
        makeStock({ symbol: "ZERO", volume: 0, marketCap: null }),
      ];
      assert.strictEqual(filterValidStocks(stocks).length, 0);
    });

    it("should handle empty input", () => {
      assert.strictEqual(filterValidStocks([]).length, 0);
    });
  });

  // -- Sector Counts --

  describe("computeSectorCounts", () => {
    it("should count instruments per sector", () => {
      const instruments = [
        { sector: "IT" },
        { sector: "IT" },
        { sector: "Banking" },
      ];
      const counts = computeSectorCounts(instruments);
      assert.strictEqual(counts.get("IT"), 2);
      assert.strictEqual(counts.get("Banking"), 1);
    });

    it("should skip instruments with null sector", () => {
      const instruments = [{ sector: null }, { sector: "IT" }];
      const counts = computeSectorCounts(instruments);
      assert.strictEqual(counts.size, 1);
      assert.strictEqual(counts.get("IT"), 1);
    });

    it("should handle empty input", () => {
      const counts = computeSectorCounts([]);
      assert.strictEqual(counts.size, 0);
    });
  });

  // -- Sort by changePercent --

  describe("sortByChangePercent", () => {
    it("should sort by absolute changePercent descending", () => {
      const stocks = [
        makeStock({ symbol: "A", changePercent: 2 }),
        makeStock({ symbol: "B", changePercent: -5 }),
        makeStock({ symbol: "C", changePercent: 3 }),
      ];
      const sorted = sortByChangePercent(stocks);
      assert.strictEqual(sorted[0].symbol, "B");
      assert.strictEqual(sorted[1].symbol, "C");
      assert.strictEqual(sorted[2].symbol, "A");
    });

    it("should not mutate original array", () => {
      const stocks = [
        makeStock({ symbol: "A", changePercent: 1 }),
        makeStock({ symbol: "B", changePercent: 5 }),
      ];
      const original = stocks.map((s) => s.symbol);
      sortByChangePercent(stocks);
      assert.deepStrictEqual(
        stocks.map((s) => s.symbol),
        original
      );
    });
  });

  // -- Sort by marketCap --

  describe("sortByMarketCap", () => {
    it("should sort by marketCap descending", () => {
      const stocks = [
        makeStock({ symbol: "SMALL", marketCap: 1000 }),
        makeStock({ symbol: "BIG", marketCap: 1000000 }),
      ];
      const sorted = sortByMarketCap(stocks);
      assert.strictEqual(sorted[0].symbol, "BIG");
    });

    it("should treat null marketCap as 0", () => {
      const stocks = [
        makeStock({ symbol: "NULL", marketCap: null }),
        makeStock({ symbol: "HAS", marketCap: 100 }),
      ];
      const sorted = sortByMarketCap(stocks);
      assert.strictEqual(sorted[0].symbol, "HAS");
    });
  });

  // -- Options Resolution --

  describe("resolveSectorOptions", () => {
    it("should default limit to 20 and sortBy to name", () => {
      const opts = resolveSectorOptions({});
      assert.strictEqual(opts.limit, 20);
      assert.strictEqual(opts.sortBy, "name");
    });

    it("should override limit", () => {
      const opts = resolveSectorOptions({ limit: 50 });
      assert.strictEqual(opts.limit, 50);
    });

    it("should override sortBy", () => {
      const opts = resolveSectorOptions({ sortBy: "marketCap" });
      assert.strictEqual(opts.sortBy, "marketCap");
    });
  });
});
