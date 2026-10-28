/**
 * MONEY-620 — Discover sorting / ranking / circuit-limit tests (REAL exports).
 *
 * DE-SHADOWED. This file previously declared `sortByChangePercent`,
 * `sortByMarketCap`, `isWithinCircuitLimits` etc. INLINE ("mirrors discover.ts")
 * and asserted the copies — a textbook shadow: the copy was correct while the
 * LIVE `getAllStocksData` / `fetchStocksBySector` sort shipped the
 * order-unstable `Array.sort(... NaN ...)` comparator (a corrupt `changePercent`
 * could land at the top of the gainers list / sector sort — the same
 * "wrong-winner" class as ./comparison-logic.ts).
 *
 * Now it imports and asserts the REAL exported helpers from the service logic
 * module (`packages/services/src/discover-logic.ts`) — the exact code
 * `packages/services/src/discover.service.ts` CALLS for its gainers/losers
 * ranking (`rankGainers`/`rankLosers`) and its sector sort
 * (`sortStocksBySector`). No inline reimplementation: production and assertions
 * run the same bytes.
 *
 * The module is Prisma-free, so importing it never opens a DB/Redis handle —
 * the test stays pure and exits clean (no orphan).
 *
 * Source: packages/services/src/discover-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  finite,
  isWithinCircuitLimits,
  isWithinGainerLoserBand,
  MAX_ABS_CHANGE_PERCENT,
  changePercentFromCloses,
  formatChangePercent,
  compareByChangePercentAbsDesc,
  compareByMarketCapDesc,
  sortStocksBySector,
  rankGainers,
  rankLosers,
} from "../../../../packages/services/src/discover-logic";

// ── fixtures (the real DiscoverStock-ish shape the service ranks) ─────────

interface Stock {
  symbol: string;
  changePercent: number;
  change: number;
  marketCap: number | null;
}

function makeStock(overrides: Partial<Stock> = {}): Stock {
  return {
    symbol: "TEST",
    changePercent: 0,
    change: 1,
    marketCap: 100_000_000,
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("MONEY-620 — discover-logic.finite", () => {
  it("passes finite numbers through, collapses null/undefined/NaN/±Infinity to fallback", () => {
    assert.equal(finite(5), 5);
    assert.equal(finite(-2.5), -2.5);
    assert.equal(finite(0), 0);
    assert.equal(finite(null), 0);
    assert.equal(finite(undefined), 0);
    assert.equal(finite(NaN), 0);
    assert.equal(finite(Infinity), 0);
    assert.equal(finite(-Infinity), 0);
    assert.equal(finite(NaN, -1), -1);
  });
});

describe("MONEY-620 — discover-logic.isWithinCircuitLimits", () => {
  it("admits the believable band (-50, 50) exclusive", () => {
    assert.equal(isWithinCircuitLimits(0), true);
    assert.equal(isWithinCircuitLimits(5), true);
    assert.equal(isWithinCircuitLimits(-10), true);
    assert.equal(isWithinCircuitLimits(49.9), true);
    assert.equal(isWithinCircuitLimits(-49.9), true);
  });

  it("rejects the bounds and beyond (bogus spikes/crashes)", () => {
    assert.equal(isWithinCircuitLimits(MAX_ABS_CHANGE_PERCENT), false);
    assert.equal(isWithinCircuitLimits(50), false);
    assert.equal(isWithinCircuitLimits(-50), false);
    assert.equal(isWithinCircuitLimits(100), false);
    assert.equal(isWithinCircuitLimits(-100), false);
  });

  it("rejects non-finite changePercent (never admitted to gainers/losers)", () => {
    assert.equal(isWithinCircuitLimits(NaN), false);
    assert.equal(isWithinCircuitLimits(Infinity), false);
    assert.equal(isWithinCircuitLimits(-Infinity), false);
  });
});

describe("MONEY-620 — discover-logic.isWithinGainerLoserBand (INCLUSIVE ±50)", () => {
  it("INCLUDES the ±50 boundary (behaviour-preserving vs the legacy getAllStocksData <=50/>=-50)", () => {
    // The gainers/losers band differs from the sort band: it admits exactly ±50.
    assert.equal(isWithinGainerLoserBand(50), true);
    assert.equal(isWithinGainerLoserBand(-50), true);
    assert.equal(isWithinCircuitLimits(50), false); // the OTHER (exclusive) band rejects 50
    assert.equal(isWithinGainerLoserBand(49.99), true);
    assert.equal(isWithinGainerLoserBand(0), true);
  });

  it("rejects beyond ±50 and any non-finite", () => {
    assert.equal(isWithinGainerLoserBand(50.01), false);
    assert.equal(isWithinGainerLoserBand(-50.01), false);
    assert.equal(isWithinGainerLoserBand(NaN), false);
    assert.equal(isWithinGainerLoserBand(Infinity), false);
    assert.equal(isWithinGainerLoserBand(-Infinity), false);
  });
});

describe("MONEY-620 — discover-logic.changePercentFromCloses (div-by-zero guard)", () => {
  it("computes (price - prevClose)/prevClose*100 for finite inputs", () => {
    assert.equal(changePercentFromCloses(110, 100), 10);
    assert.equal(changePercentFromCloses(90, 100), -10);
    assert.equal(changePercentFromCloses(100, 100), 0);
  });

  it("returns null on a ZERO previousClose (the ÷0 → Infinity/NaN sort-poison source)", () => {
    assert.equal(changePercentFromCloses(110, 0), null);
    assert.equal(changePercentFromCloses(0, 0), null);
  });

  it("returns null on a non-finite previousClose or price (never NaN/Infinity)", () => {
    assert.equal(changePercentFromCloses(110, null), null);
    assert.equal(changePercentFromCloses(110, NaN), null);
    assert.equal(changePercentFromCloses(110, Infinity), null);
    assert.equal(changePercentFromCloses(NaN, 100), null);
    assert.equal(changePercentFromCloses(Infinity, 100), null);
    assert.equal(changePercentFromCloses(undefined, undefined), null);
  });
});

describe("MONEY-620 — discover-logic.formatChangePercent (no 'NaN%' to the chip)", () => {
  it("formats signed, fixed-2, with %", () => {
    assert.equal(formatChangePercent(12.345), "+12.35%");
    assert.equal(formatChangePercent(-3.2), "-3.20%");
    assert.equal(formatChangePercent(0), "+0.00%");
  });

  it("renders the dash placeholder for non-finite (never literal 'NaN%'/'Infinity%')", () => {
    assert.equal(formatChangePercent(NaN), "—");
    assert.equal(formatChangePercent(Infinity), "—");
    assert.equal(formatChangePercent(null), "—");
    assert.equal(formatChangePercent(undefined), "—");
  });
});

describe("MONEY-620 — discover-logic.compareByChangePercentAbsDesc (NaN-safe)", () => {
  it("orders by absolute %change, largest mover first", () => {
    const stocks = [
      makeStock({ symbol: "A", changePercent: 1.5 }),
      makeStock({ symbol: "B", changePercent: -5.0 }),
      makeStock({ symbol: "C", changePercent: 3.2 }),
      makeStock({ symbol: "D", changePercent: -2.0 }),
    ];
    const sorted = [...stocks].sort(compareByChangePercentAbsDesc);
    assert.deepEqual(
      sorted.map((s) => s.symbol),
      ["B", "C", "D", "A"]
    );
  });

  it("a NaN/Infinity changePercent sorts to magnitude 0 (LAST), never the headline mover", () => {
    // BUG REGRESSION: raw `Math.abs(b.cp) - Math.abs(a.cp)` with a NaN yields a
    // NaN comparator → order-unstable; the corrupt row could surface first.
    const stocks = [
      makeStock({ symbol: "NAN", changePercent: NaN }),
      makeStock({ symbol: "BIG", changePercent: 8 }),
      makeStock({ symbol: "INF", changePercent: Infinity }),
      makeStock({ symbol: "SMALL", changePercent: 1 }),
    ];
    const sorted = [...stocks].sort(compareByChangePercentAbsDesc);
    // BIG (8) leads; the two non-finite rows fall to magnitude 0 (the bottom).
    assert.equal(sorted[0]!.symbol, "BIG");
    assert.equal(sorted[1]!.symbol, "SMALL");
    const tail = sorted
      .slice(2)
      .map((s) => s.symbol)
      .sort();
    assert.deepEqual(tail, ["INF", "NAN"]);
  });
});

describe("MONEY-620 — discover-logic.compareByMarketCapDesc (NaN-safe)", () => {
  it("orders by market cap descending, null/NaN treated as 0", () => {
    const stocks = [
      makeStock({ symbol: "NULL", marketCap: null }),
      makeStock({ symbol: "MEGA", marketCap: 17e12 }),
      makeStock({ symbol: "NAN", marketCap: NaN }),
      makeStock({ symbol: "MID", marketCap: 5e10 }),
    ];
    const sorted = [...stocks].sort(compareByMarketCapDesc);
    assert.equal(sorted[0]!.symbol, "MEGA");
    assert.equal(sorted[1]!.symbol, "MID");
    // NULL and NAN both collapse to 0 → trail (order between them unspecified here).
    const tail = sorted
      .slice(2)
      .map((s) => s.symbol)
      .sort();
    assert.deepEqual(tail, ["NAN", "NULL"]);
  });
});

describe("MONEY-620 — discover-logic.sortStocksBySector (deterministic + NaN-safe)", () => {
  it("changePercent: |abs| desc with stable symbol tiebreak", () => {
    const stocks = [
      makeStock({ symbol: "POS", changePercent: 5.0 }),
      makeStock({ symbol: "NEG", changePercent: -5.0 }),
    ];
    const sorted = sortStocksBySector(stocks, "changePercent");
    // Equal magnitude → symbol asc: NEG before POS, deterministically.
    assert.deepEqual(
      sorted.map((s) => s.symbol),
      ["NEG", "POS"]
    );
  });

  it("changePercent: a NaN row never jumps the headline slot (regression)", () => {
    const stocks = [
      makeStock({ symbol: "CORRUPT", changePercent: NaN, marketCap: 9e12 }),
      makeStock({ symbol: "REAL", changePercent: 4 }),
    ];
    const sorted = sortStocksBySector(stocks, "changePercent");
    assert.equal(sorted[0]!.symbol, "REAL");
    assert.equal(sorted[1]!.symbol, "CORRUPT");
  });

  it("marketCap: desc with symbol tiebreak; null/NaN trail", () => {
    const stocks = [
      makeStock({ symbol: "SMALL", marketCap: 5e8 }),
      makeStock({ symbol: "MEGA", marketCap: 17e12 }),
      makeStock({ symbol: "NO", marketCap: null }),
    ];
    const sorted = sortStocksBySector(stocks, "marketCap");
    assert.deepEqual(
      sorted.map((s) => s.symbol),
      ["MEGA", "SMALL", "NO"]
    );
  });

  it("name: preserves input order (the DB already ordered by symbol asc)", () => {
    const stocks = [
      makeStock({ symbol: "Z" }),
      makeStock({ symbol: "A" }),
      makeStock({ symbol: "M" }),
    ];
    const sorted = sortStocksBySector(stocks, "name");
    assert.deepEqual(
      sorted.map((s) => s.symbol),
      ["Z", "A", "M"]
    );
  });

  it("does not mutate the input array", () => {
    const stocks = [
      makeStock({ symbol: "A", changePercent: 1 }),
      makeStock({ symbol: "B", changePercent: 9 }),
    ];
    const before = stocks.map((s) => s.symbol);
    sortStocksBySector(stocks, "changePercent");
    assert.deepEqual(
      stocks.map((s) => s.symbol),
      before
    );
  });

  it("empty input → empty output", () => {
    assert.deepEqual(sortStocksBySector([], "changePercent"), []);
    assert.deepEqual(sortStocksBySector([], "marketCap"), []);
  });
});

describe("MONEY-620 — discover-logic.rankGainers", () => {
  it("keeps positive, circuit-bounded, change!=0 rows, sorts by %change desc, limits", () => {
    const stocks = [
      makeStock({ symbol: "UP1", changePercent: 5, change: 5 }),
      makeStock({ symbol: "UP2", changePercent: 12, change: 12 }),
      makeStock({ symbol: "DOWN", changePercent: -3, change: -3 }),
      makeStock({ symbol: "FLAT", changePercent: 2, change: 0 }), // change 0 → dropped
      makeStock({ symbol: "SPIKE", changePercent: 80, change: 80 }), // > 50 → dropped
    ];
    const gainers = rankGainers(stocks, 10);
    assert.deepEqual(
      gainers.map((s) => s.symbol),
      ["UP2", "UP1"]
    );
  });

  it("INCLUDES a row at exactly +50 (behaviour-preserving vs legacy <=50); excludes 50.01", () => {
    const stocks = [
      makeStock({ symbol: "BORDER", changePercent: 50, change: 50 }),
      makeStock({ symbol: "OVER", changePercent: 50.01, change: 50.01 }),
      makeStock({ symbol: "NORMAL", changePercent: 10, change: 10 }),
    ];
    const gainers = rankGainers(stocks, 10);
    assert.deepEqual(
      gainers.map((s) => s.symbol),
      ["BORDER", "NORMAL"] // 50 kept (sorted first), 50.01 dropped
    );
  });

  it("a NaN/Infinity changePercent is NEVER a top gainer (regression — div-by-zero prevClose)", () => {
    const stocks = [
      makeStock({ symbol: "NAN", changePercent: NaN, change: 999 }),
      makeStock({ symbol: "INF", changePercent: Infinity, change: 999 }),
      makeStock({ symbol: "REAL", changePercent: 3, change: 3 }),
    ];
    const gainers = rankGainers(stocks, 10);
    assert.deepEqual(
      gainers.map((s) => s.symbol),
      ["REAL"]
    );
  });

  it("respects the limit (top-N) and breaks ties by symbol", () => {
    const stocks = [
      makeStock({ symbol: "C", changePercent: 5, change: 5 }),
      makeStock({ symbol: "A", changePercent: 5, change: 5 }),
      makeStock({ symbol: "B", changePercent: 5, change: 5 }),
    ];
    const gainers = rankGainers(stocks, 2);
    assert.deepEqual(
      gainers.map((s) => s.symbol),
      ["A", "B"] // tie on 5 → symbol asc, then top-2
    );
  });

  it("fewer than N gainers returns just the available ones; empty → []", () => {
    const stocks = [makeStock({ symbol: "ONE", changePercent: 4, change: 4 })];
    assert.equal(rankGainers(stocks, 10).length, 1);
    assert.deepEqual(rankGainers([], 10), []);
  });
});

describe("MONEY-620 — discover-logic.rankLosers", () => {
  it("keeps negative, circuit-bounded, change!=0 rows, sorts by %change asc (most-negative first)", () => {
    const stocks = [
      makeStock({ symbol: "D1", changePercent: -5, change: -5 }),
      makeStock({ symbol: "D2", changePercent: -12, change: -12 }),
      makeStock({ symbol: "UP", changePercent: 3, change: 3 }),
      makeStock({ symbol: "CRASH", changePercent: -80, change: -80 }), // < -50 → dropped
    ];
    const losers = rankLosers(stocks, 10);
    assert.deepEqual(
      losers.map((s) => s.symbol),
      ["D2", "D1"]
    );
  });

  it("a NaN/-Infinity changePercent is NEVER crowned the worst loser (regression)", () => {
    const stocks = [
      makeStock({ symbol: "NEGINF", changePercent: -Infinity, change: -999 }),
      makeStock({ symbol: "NAN", changePercent: NaN, change: -999 }),
      makeStock({ symbol: "REAL", changePercent: -4, change: -4 }),
    ];
    const losers = rankLosers(stocks, 10);
    assert.deepEqual(
      losers.map((s) => s.symbol),
      ["REAL"]
    );
  });
});
