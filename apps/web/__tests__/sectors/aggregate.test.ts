/**
 * Sector aggregator tests - covers the pure functions that power the
 * /discover/sectors heatmap. The aggregator and heatColor helpers must
 * be deterministic so the UI renders the same shape regardless of the
 * input order / null-mcap stocks / unknown sectors.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregateSectors, heatColor } from "../../lib/sectors/aggregate";
import type { DiscoverStock } from "@usemoney/services";

function stock(
  symbol: string,
  sector: string | null,
  marketCap: number | null,
  changePercent: number,
  price = 100
): DiscoverStock {
  return {
    symbol,
    name: symbol,
    exchange: "NSE",
    sector,
    instrumentType: "EQUITY",
    instrumentId: symbol,
    yahooSymbol: `${symbol}.NS`,
    // MONEY-1198 — DiscoverStock carries the durable identity used to collapse
    // dual listings. Test rows have none, and null is the honest value.
    isin: null,
    price,
    change: 0,
    changePercent,
    volume: null,
    marketCap,
  };
}

describe("aggregateSectors", () => {
  it("groups by sector and sums mcap", () => {
    const result = aggregateSectors([
      stock("RELIANCE", "Energy", 1_000_000_000, 1.5),
      stock("ONGC", "Energy", 500_000_000, -0.5),
      stock("TCS", "IT", 2_000_000_000, 0.3),
    ]);
    const energy = result.find((r) => r.name === "Energy");
    const it = result.find((r) => r.name === "IT");
    assert.ok(energy);
    assert.ok(it);
    assert.equal(energy.mcap, 1_500_000_000);
    assert.equal(it.mcap, 2_000_000_000);
    assert.equal(energy.count, 2);
    assert.equal(it.count, 1);
  });

  it("computes mcap-weighted 1D change", () => {
    const result = aggregateSectors([
      stock("A", "X", 1000, 10), // contributes 10 * 1000
      stock("B", "X", 9000, 0), // contributes 0 * 9000
    ]);
    const x = result.find((r) => r.name === "X");
    assert.ok(x);
    // weighted = 10*1000 / (1000+9000) = 1.0
    assert.equal(x.change1D, 1);
  });

  it("treats null sector + N/A as 'Not Categorised'", () => {
    const result = aggregateSectors([
      stock("A", null, 1000, 1),
      stock("B", "N/A", 1000, 1),
    ]);
    const nc = result.find((r) => r.name === "Not Categorised");
    assert.ok(nc);
    assert.equal(nc.count, 2);
  });

  it("drops sectors with zero mcap", () => {
    const result = aggregateSectors([
      stock("A", "Empty", null, 1),
      stock("B", "Real", 1000, 1),
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.name, "Real");
  });

  it("returns top-N constituents per sector sorted by mcap desc", () => {
    const result = aggregateSectors(
      [
        stock("Big", "S", 10_000, 1),
        stock("Mid", "S", 5_000, 1),
        stock("Small", "S", 1_000, 1),
      ],
      2
    );
    const s = result[0]!;
    assert.equal(s.top.length, 2);
    assert.equal(s.top[0]!.symbol, "Big");
    assert.equal(s.top[1]!.symbol, "Mid");
  });

  it("sorts aggregates by mcap desc", () => {
    const result = aggregateSectors([
      stock("A", "Small", 100, 0),
      stock("B", "Big", 10_000, 0),
      stock("C", "Mid", 1_000, 0),
    ]);
    assert.deepEqual(
      result.map((r) => r.name),
      ["Big", "Mid", "Small"]
    );
  });

  it("change1D is null when no stock has both mcap and changePercent", () => {
    const noMcap = aggregateSectors([
      stock("A", "X", null, 5), // null mcap - skipped
    ]);
    assert.equal(noMcap.length, 0);

    // Stock with mcap but NaN change: still included in mcap, but
    // weightedChangeNum stays 0 because NaN guard rejects it
    const result = aggregateSectors([stock("A", "X", 1000, NaN)]);
    assert.ok(result[0]);
    assert.equal(result[0]!.change1D, null);
  });

  it("multi-timeframe placeholders are null today", () => {
    const result = aggregateSectors([stock("A", "X", 1000, 1)]);
    assert.equal(result[0]!.change1W, null);
    assert.equal(result[0]!.change1M, null);
    assert.equal(result[0]!.changeYTD, null);
  });
});

describe("heatColor", () => {
  it("null input returns neutral white", () => {
    const c = heatColor(null);
    assert.match(c.bg, /rgba\(255,255,255/);
  });

  it("≥+5% returns deep emerald", () => {
    assert.match(heatColor(5).bg, /52,211,153,\.45/);
    assert.match(heatColor(10).bg, /52,211,153,\.45/);
  });

  it("+2% to +5% returns mid emerald", () => {
    assert.match(heatColor(3).bg, /52,211,153,\.28/);
  });

  it("+0.5% to +2% returns light emerald", () => {
    assert.match(heatColor(1).bg, /52,211,153,\.16/);
  });

  it("−0.5% to +0.5% is neutral", () => {
    assert.match(heatColor(0).bg, /255,255,255/);
    assert.match(heatColor(0.4).bg, /255,255,255/);
    assert.match(heatColor(-0.4).bg, /255,255,255/);
  });

  it("−2% to −0.5% returns light red", () => {
    assert.match(heatColor(-1).bg, /248,113,113,\.16/);
  });

  it("−5% returns mid-deep red, <−5% returns deepest red", () => {
    assert.match(heatColor(-5).bg, /248,113,113,\.32/);
    assert.match(heatColor(-10).bg, /248,113,113,\.5/);
  });

  it("NaN treated as null", () => {
    const c = heatColor(NaN);
    assert.match(c.bg, /rgba\(255,255,255/);
  });
});
