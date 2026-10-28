/**
 * MONEY-1131 — `getDiscoverSummary`: the row-free half of `getDiscoverData`.
 *
 * `@usemoney/services` runs its suite as ESM (no `require.cache` module-mocking),
 * so this drives the REAL exported service through its injectable ports.
 *
 * The defect: `/discover/markets` reads only `topGainers`/`topLosers` and
 * `/discover/screener` reads only `sectors` + the universe SIZE, yet both called
 * `getDiscoverData()`, whose universe entry is a ~7,400-row blob — a multi-MB
 * Redis GET plus a multi-MB `JSON.parse` on every cold render, to read two
 * fields. So the load-bearing assertion here is a NEGATIVE one: on the warm
 * path the universe is never touched at all.
 *
 * Source: packages/services/src/discover.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getDiscoverSummary,
  type DiscoverStock,
  type DiscoverSummaryPorts,
} from "../src/discover.service";

// ── Fixtures ────────────────────────────────────────────────────────────

function stock(symbol: string, sector: string | null, cp: number) {
  return {
    symbol,
    name: `${symbol} Ltd`,
    exchange: "NSE",
    sector,
    instrumentType: "EQUITY",
    instrumentId: `id-${symbol}`,
    yahooSymbol: `${symbol}.NS`,
    price: 100,
    change: cp,
    changePercent: cp,
    volume: 1_000,
    marketCap: 5_000,
  } satisfies DiscoverStock;
}

const UNIVERSE = {
  allStocks: [
    stock("ONGC", "Energy", 3),
    stock("TCS", "Information Technology", -2),
    stock("IOC", "Energy", 1),
    stock("MYSTERY", null, -5),
  ],
  sectors: [
    { name: "Energy", count: 2 },
    { name: "Information Technology", count: 1 },
    { name: "Not Categorised", count: 1 },
  ],
};

const MOVERS = {
  topGainers: [stock("ONGC", "Energy", 3)],
  topLosers: [stock("MYSTERY", null, -5)],
};

/** Ports wired to counters, so "was the universe read?" is observable. */
function ports(overrides: Partial<DiscoverSummaryPorts> = {}) {
  const calls = { universe: 0, movers: 0, read: 0, write: 0 };
  const store: { summary: unknown } = { summary: null };
  const base: DiscoverSummaryPorts = {
    readSummary: async () => {
      calls.read += 1;
      return store.summary as never;
    },
    writeSummary: async (v) => {
      calls.write += 1;
      store.summary = v;
    },
    getUniverse: async () => {
      calls.universe += 1;
      return UNIVERSE;
    },
    getMovers: async () => {
      calls.movers += 1;
      return MOVERS;
    },
  };
  return { calls, store, ports: { ...base, ...overrides } };
}

// ── Cases ───────────────────────────────────────────────────────────────

describe("getDiscoverSummary — never pulls the universe on the warm path", () => {
  it("a warm summary + warm movers reads ZERO universe rows", async () => {
    const { calls, ports: p } = ports({
      readSummary: async () => ({ sectors: UNIVERSE.sectors, stockCount: 4 }),
    });

    const res = await getDiscoverSummary(p);

    assert.equal(res.success, true);
    assert.equal(
      calls.universe,
      0,
      "this is the whole point of the ticket: no universe read to answer " +
        "sectors + a count",
    );
    if (res.success) {
      assert.equal(res.data.stockCount, 4);
      assert.deepEqual(res.data.sectors, UNIVERSE.sectors);
      assert.deepEqual(res.data.topGainers, MOVERS.topGainers);
      assert.deepEqual(res.data.topLosers, MOVERS.topLosers);
    }
  });

  it("the payload carries NO row list — `allStocks` must not sneak back in", async () => {
    const { ports: p } = ports({
      readSummary: async () => ({ sectors: UNIVERSE.sectors, stockCount: 4 }),
    });
    const res = await getDiscoverSummary(p);
    assert.equal(res.success, true);
    if (res.success) {
      assert.deepEqual(
        Object.keys(res.data).sort(),
        ["sectors", "stockCount", "topGainers", "topLosers"],
        "a stray allStocks here would re-create the multi-MB payload",
      );
    }
  });
});

describe("getDiscoverSummary — cold summary derives once, then memoises", () => {
  it("a cold summary reads the universe exactly once and writes the small entry", async () => {
    const { calls, store, ports: p } = ports();

    const res = await getDiscoverSummary(p);

    assert.equal(calls.universe, 1);
    assert.equal(calls.write, 1);
    assert.deepEqual(store.summary, {
      sectors: UNIVERSE.sectors,
      stockCount: UNIVERSE.allStocks.length,
    });
    assert.equal(res.success, true);
  });

  it("the derived numbers match what getDiscoverData would have reported", async () => {
    const { ports: p } = ports();
    const res = await getDiscoverSummary(p);

    assert.equal(res.success, true);
    if (res.success) {
      // `stockCount` IS `allStocks.length` and `sectors` IS the universe's —
      // the summary is a projection of the same scan, not a second source.
      assert.equal(res.data.stockCount, UNIVERSE.allStocks.length);
      assert.deepEqual(res.data.sectors, UNIVERSE.sectors);
    }
  });

  it("a second call after the write serves from the summary entry, not the universe", async () => {
    const { calls, ports: p } = ports();

    await getDiscoverSummary(p);
    const universeReadsAfterCold = calls.universe;
    await getDiscoverSummary(p);

    assert.equal(
      calls.universe,
      universeReadsAfterCold,
      "the second render must not re-read the universe",
    );
  });
});

describe("getDiscoverSummary — degradation matches getDiscoverData", () => {
  it("empty movers fall back to ranking the universe rather than dead-ending", async () => {
    const { calls, ports: p } = ports({
      readSummary: async () => ({ sectors: UNIVERSE.sectors, stockCount: 4 }),
      getMovers: async () => ({ topGainers: [], topLosers: [] }),
    });

    const res = await getDiscoverSummary(p);

    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(
        res.data.topGainers[0]?.symbol,
        "ONGC",
        "best gainer ranked out of the universe we already hold",
      );
      assert.equal(res.data.topLosers[0]?.symbol, "MYSTERY");
    }
    assert.equal(
      calls.universe,
      1,
      "the fallback DOES pay the big read — but only in the outage window " +
        "where getDiscoverData would have too",
    );
  });

  it("a null movers result (query threw) degrades the same way", async () => {
    const { ports: p } = ports({
      readSummary: async () => ({ sectors: UNIVERSE.sectors, stockCount: 4 }),
      getMovers: async () => null,
    });

    const res = await getDiscoverSummary(p);
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.topGainers.length > 0, true);
  });

  it("a throwing universe surfaces a sanitized failure, not a stack", async () => {
    const { ports: p } = ports({
      readSummary: async () => null,
      getUniverse: async () => {
        throw new Error("mongo timed out");
      },
    });

    const res = await getDiscoverSummary(p);
    assert.deepEqual(res, {
      success: false,
      error: "Failed to load discover summary",
    });
  });
});
