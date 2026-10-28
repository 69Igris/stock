/**
 * discover-market.service pure seams — REAL exports (MONEY-1062 P4d).
 *
 * Pins the web-ported math on the code that ships:
 *   - aggregateSectorPerformance (port of apps/web sector-performance-logic.ts)
 *   - heatmapCutoffFor           (port of apps/web discover-heatmap-logic.ts)
 *   - bucketizeHeatmapSectors    (port of apps/web sector-heatmap.ts#bucketize)
 *   - aggregateSectorsForDeepDive(port of apps/web lib/sectors/aggregate.ts)
 *
 * All four are pure (no prisma/cache I/O), so they run against the real module
 * without any injection. The Prisma-bound service fns in the same file are
 * covered at the HTTP contract layer (apps/api parity-p4d-contract.test.ts).
 *
 * Source: packages/services/src/discover-market.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateSectorPerformance,
  heatmapCutoffFor,
  bucketizeHeatmapSectors,
  aggregateSectorsForDeepDive,
  type SectorQuote,
  type HeatmapStock,
} from "../src/discover-market.service";
import type { DiscoverStock } from "../src/discover.service";

// ── aggregateSectorPerformance ───────────────────────────────────────────────

const identity = (s: string) => s;
const noDisplay = () => null;

function quoteMap(
  entries: Array<[string, Partial<SectorQuote>]>,
): Map<string, SectorQuote> {
  return new Map(
    entries.map(([id, q]) => [
      id,
      { instrumentId: id, changePercent: null, volume: null, ...q },
    ]),
  );
}

describe("aggregateSectorPerformance (web sector-performance-logic port)", () => {
  it("buckets by normalized sector with volume-weighted + mean change", async () => {
    const instruments = [
      { id: "a", sector: "IT" },
      { id: "b", sector: "IT" },
      { id: "c", sector: "Banks" },
    ];
    const quotes = quoteMap([
      ["a", { changePercent: 2, volume: 300 }],
      ["b", { changePercent: -1, volume: 100 }],
      ["c", { changePercent: 0.5, volume: null }], // null volume → weight 1
    ]);
    const rows = aggregateSectorPerformance(
      instruments,
      quotes,
      identity,
      noDisplay,
    );
    assert.equal(rows.length, 2);
    const it_ = rows.find((r) => r.sector === "IT")!;
    assert.equal(it_.count, 2);
    assert.equal(it_.meanChangePct, (2 + -1) / 2);
    // (2*300 + -1*100) / 400 = 1.25
    assert.equal(it_.weightedChangePct, 1.25);
    const banks = rows.find((r) => r.sector === "Banks")!;
    assert.equal(banks.weightedChangePct, 0.5);
  });

  it("scales barWidth to the max |weighted| and sorts gainers first", async () => {
    const rows = aggregateSectorPerformance(
      [
        { id: "a", sector: "Up" },
        { id: "b", sector: "Down" },
      ],
      quoteMap([
        ["a", { changePercent: 1, volume: 1 }],
        ["b", { changePercent: -4, volume: 1 }],
      ]),
      identity,
      noDisplay,
    );
    assert.deepEqual(
      rows.map((r) => r.sector),
      ["Up", "Down"], // descending weightedChangePct
    );
    assert.equal(rows.find((r) => r.sector === "Down")!.barWidth, 100);
    assert.equal(rows.find((r) => r.sector === "Up")!.barWidth, 25);
  });

  it("skips instruments with no quote, null change, or null sector; flat set → 0 bars", async () => {
    const rows = aggregateSectorPerformance(
      [
        { id: "noquote", sector: "IT" },
        { id: "nullchange", sector: "IT" },
        { id: "nosector", sector: null },
        { id: "flat", sector: "Flat" },
      ],
      quoteMap([
        ["nullchange", { changePercent: null, volume: 5 }],
        ["nosector", { changePercent: 3, volume: 5 }],
        ["flat", { changePercent: 0, volume: 5 }],
      ]),
      identity,
      noDisplay,
    );
    // Only the "Flat" sector survives (one 0% constituent).
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.sector, "Flat");
    assert.equal(rows[0]!.barWidth, 0); // maxAbs === 0 → all bars 0
  });

  it("treats volume ≤ 0 as weight 1 (never a zero/negative weight)", async () => {
    const rows = aggregateSectorPerformance(
      [
        { id: "a", sector: "IT" },
        { id: "b", sector: "IT" },
      ],
      quoteMap([
        ["a", { changePercent: 10, volume: 0 }], // weight 1
        ["b", { changePercent: 0, volume: -5 }], // weight 1
      ]),
      identity,
      noDisplay,
    );
    assert.equal(rows[0]!.weightedChangePct, 5); // simple mean under unit weights
  });
});

// ── heatmapCutoffFor ─────────────────────────────────────────────────────────

describe("heatmapCutoffFor (web discover-heatmap-logic port)", () => {
  // Fixed instant: 2026-07-10T22:00:00Z = 2026-07-11 03:30 IST (date rolled in IST).
  const now = new Date("2026-07-10T22:00:00.000Z");

  it("1D → null (intraday uses LatestQuote.changePercent)", () => {
    assert.equal(heatmapCutoffFor("1D", now), null);
  });

  it("1W → UTC-midnight of the IST calendar day 7 days ago", () => {
    // IST day is Jul 11 → minus 7 days = Jul 4, at UTC midnight.
    assert.equal(
      heatmapCutoffFor("1W", now)!.toISOString(),
      "2026-07-04T00:00:00.000Z",
    );
  });

  it("1M → UTC-midnight of the IST day one month ago", () => {
    assert.equal(
      heatmapCutoffFor("1M", now)!.toISOString(),
      "2026-06-11T00:00:00.000Z",
    );
  });

  it("YTD → UTC-midnight of Jan 1 of the IST year", () => {
    assert.equal(
      heatmapCutoffFor("YTD", now)!.toISOString(),
      "2026-01-01T00:00:00.000Z",
    );
  });
});

// ── bucketizeHeatmapSectors ──────────────────────────────────────────────────

function heatStock(over: Partial<HeatmapStock>): HeatmapStock {
  return {
    symbol: "X",
    name: "X Ltd",
    sector: "IT",
    price: 100,
    changePct: 1,
    mcap: 1000,
    exchange: "NSE",
    ...over,
  };
}

describe("bucketizeHeatmapSectors (web sector-heatmap bucketize port)", () => {
  it("folds stocks into mcap-weighted sector buckets sorted by mcap desc", () => {
    const buckets = bucketizeHeatmapSectors(
      [
        heatStock({ symbol: "A", sector: "IT", mcap: 3000, changePct: 2 }),
        heatStock({ symbol: "B", sector: "IT", mcap: 1000, changePct: -2 }),
        heatStock({ symbol: "C", sector: "Banks", mcap: 8000, changePct: 1 }),
      ],
      6,
    );
    assert.deepEqual(
      buckets.map((b) => b.name),
      ["Banks", "IT"], // mcap desc
    );
    const it_ = buckets.find((b) => b.name === "IT")!;
    assert.equal(it_.mcap, 4000);
    assert.equal(it_.count, 2);
    // (2*3000 + -2*1000) / 4000 = 1
    assert.equal(it_.change, 1);
  });

  it("caps `top` at topN, ordered by mcap desc, and maps the display tuple", () => {
    const buckets = bucketizeHeatmapSectors(
      [
        heatStock({ symbol: "S1", mcap: 10 }),
        heatStock({ symbol: "S2", mcap: 30 }),
        heatStock({ symbol: "S3", mcap: 20 }),
      ],
      2,
    );
    assert.deepEqual(
      buckets[0]!.top.map((t) => t.symbol),
      ["S2", "S3"],
    );
    assert.deepEqual(Object.keys(buckets[0]!.top[0]!).sort(), [
      "changePct",
      "exchange",
      "name",
      "price",
      "symbol",
    ]);
  });

  it("excludes non-finite changePct from the weighted change but keeps the mcap", () => {
    const buckets = bucketizeHeatmapSectors(
      [
        heatStock({ symbol: "OK", mcap: 1000, changePct: 4 }),
        heatStock({ symbol: "NAN", mcap: 9000, changePct: NaN }),
      ],
      6,
    );
    assert.equal(buckets[0]!.mcap, 10000); // NaN row still sizes the cell
    assert.equal(buckets[0]!.change, 4); // but never poisons the weighted mean
  });

  it("drops empty-sector stocks and zero-mcap buckets", () => {
    const buckets = bucketizeHeatmapSectors(
      [
        heatStock({ symbol: "NOSEC", sector: "" }),
        heatStock({ symbol: "ZERO", sector: "Ghost", mcap: 0 }),
      ],
      6,
    );
    assert.deepEqual(buckets, []);
  });
});

// ── aggregateSectorsForDeepDive ──────────────────────────────────────────────

function discoverStock(over: Partial<DiscoverStock>): DiscoverStock {
  return {
    symbol: "X",
    name: "X Ltd",
    exchange: "NSE",
    sector: "IT",
    instrumentType: "EQUITY",
    instrumentId: "id_x",
    yahooSymbol: "X.NS",
    price: 100,
    change: 1,
    changePercent: 1,
    volume: 10,
    marketCap: 1000,
    ...over,
  };
}

describe("aggregateSectorsForDeepDive (web lib/sectors/aggregate port)", () => {
  it("computes mcap-weighted 1D change with null multi-timeframe placeholders", () => {
    const aggs = aggregateSectorsForDeepDive(
      [
        discoverStock({ symbol: "A", marketCap: 3000, changePercent: 2 }),
        discoverStock({ symbol: "B", marketCap: 1000, changePercent: -2 }),
      ],
      5,
    );
    assert.equal(aggs.length, 1);
    assert.equal(aggs[0]!.mcap, 4000);
    assert.equal(aggs[0]!.change1D, 1); // (2*3000 - 2*1000) / 4000
    assert.equal(aggs[0]!.change1W, null);
    assert.equal(aggs[0]!.change1M, null);
    assert.equal(aggs[0]!.changeYTD, null);
  });

  it("routes null/'N/A' sectors to 'Not Categorised' and drops zero-mcap buckets", () => {
    const aggs = aggregateSectorsForDeepDive(
      [
        discoverStock({ symbol: "A", sector: null, marketCap: 500 }),
        discoverStock({ symbol: "B", sector: "N/A", marketCap: 700 }),
        discoverStock({ symbol: "C", sector: "Ghost", marketCap: null }),
      ],
      5,
    );
    assert.equal(aggs.length, 1);
    assert.equal(aggs[0]!.name, "Not Categorised");
    assert.equal(aggs[0]!.mcap, 1200);
    assert.equal(aggs[0]!.count, 2);
  });

  it("sorts sectors by mcap desc and slices top constituents by mcap", () => {
    const aggs = aggregateSectorsForDeepDive(
      [
        discoverStock({ symbol: "BIG", sector: "Banks", marketCap: 9000 }),
        discoverStock({ symbol: "S1", sector: "IT", marketCap: 100 }),
        discoverStock({ symbol: "S2", sector: "IT", marketCap: 300 }),
        discoverStock({ symbol: "S3", sector: "IT", marketCap: 200 }),
      ],
      2,
    );
    assert.deepEqual(
      aggs.map((a) => a.name),
      ["Banks", "IT"],
    );
    const it_ = aggs.find((a) => a.name === "IT")!;
    assert.deepEqual(
      it_.top.map((t) => t.symbol),
      ["S2", "S3"], // top-2 by mcap
    );
  });
});
