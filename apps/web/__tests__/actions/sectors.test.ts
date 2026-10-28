import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregateSectors, heatColor } from "../../lib/sectors/aggregate";

// MONEY-298 - Sector deep-dive aggregate behavior tests. These cover
// the contract the deep-dive page relies on without spinning up the
// server-action wrapper (which pulls in Prisma + Clerk).

test("aggregateSectors groups by sector and weights by mcap", () => {
  const stocks = [
    {
      symbol: "RELIANCE",
      name: "Reliance",
      exchange: "NSE",
      sector: "Energy",
      instrumentType: "EQUITY",
      instrumentId: "",
      yahooSymbol: "RELIANCE.NS",
      price: 2890,
      change: 45,
      changePercent: 1.5,
      volume: 1_000_000,
      marketCap: 19_000_000_000_000,
    },
    {
      symbol: "TCS",
      name: "Tata Consultancy",
      exchange: "NSE",
      sector: "Information Technology",
      instrumentType: "EQUITY",
      instrumentId: "",
      yahooSymbol: "TCS.NS",
      price: 3500,
      change: -10,
      changePercent: -0.5,
      volume: 500_000,
      marketCap: 12_000_000_000_000,
    },
    {
      symbol: "INFY",
      name: "Infosys",
      exchange: "NSE",
      sector: "Information Technology",
      instrumentType: "EQUITY",
      instrumentId: "",
      yahooSymbol: "INFY.NS",
      price: 1800,
      change: 18,
      changePercent: 1,
      volume: 800_000,
      marketCap: 6_000_000_000_000,
    },
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = aggregateSectors(stocks as any, 3);
  assert.equal(result.length, 2, "two distinct sectors aggregated");

  const it = result.find((s) => s.name === "Information Technology");
  assert.ok(it, "IT sector aggregated");
  assert.equal(it.count, 2);
  // weighted: (-0.5*12 + 1*6) / 18 = 0 / 18 = 0
  assert.ok(Math.abs((it.change1D ?? 0) - 0) < 0.0001);
});

test("aggregateSectors drops zero-mcap buckets", () => {
  const stocks = [
    {
      symbol: "ZERO",
      name: "Z",
      exchange: "NSE",
      sector: "Microcap",
      instrumentType: "EQUITY",
      instrumentId: "",
      yahooSymbol: "Z.NS",
      price: 1,
      change: 0,
      changePercent: 0,
      volume: 0,
      marketCap: 0,
    },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = aggregateSectors(stocks as any);
  assert.equal(result.length, 0);
});

test("heatColor ramps green for positive change, red for negative", () => {
  assert.equal(heatColor(6).bg, "rgba(52,211,153,.45)");
  assert.equal(heatColor(-6).bg, "rgba(248,113,113,.5)");
  assert.equal(heatColor(0).fg, "var(--text-dim)");
  assert.equal(heatColor(null).fg, "var(--text-dim)");
});

test("heatColor produces distinct colours for +0.5 vs -0.5 boundary", () => {
  const pos = heatColor(0.6);
  const neg = heatColor(-0.6);
  const flat = heatColor(0.3);
  assert.notEqual(pos.bg, neg.bg);
  assert.notEqual(pos.bg, flat.bg);
  assert.notEqual(neg.bg, flat.bg);
});
