/**
 * MONEY-620 — index/ETF discovery server actions END-TO-END (real handlers).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a SHADOW: it re-declared the synthetic-quote filter,
 * the ETF sort comparators and the previousClose>0 gate, then asserted the
 * COPIES, importing NOTHING from `lib/actions/discover-indices.ts`. So the real
 * action logic never ran on the shipping code: the input caps
 * (`getInstrumentsBySymbolsAction` returns [] for empty input OR >50 symbols),
 * the `previousClose > 0` LatestQuote join filter (instruments without a live
 * quote are dropped), the ETF→MF returns enrichment join, the cache-first ETF
 * path, and the sort-by-absolute-changePercent / sort-by-volume ordering.
 *
 * This rewrite drives the REAL exported `getInstrumentsBySymbolsAction`,
 * `getETFsAction`, `getIndicesAction` through the `require.cache` seam (stubbing
 * `@usemoney/database`, the `getCached`/`setCached` cache, and the
 * `@usemoney/services` getIndices boundary). Assertions target the action's OWN
 * logic, not the service internals:
 *   - getInstrumentsBySymbolsAction: empty input → []; >50 symbols → [] (cap);
 *     only instruments WITH a quote survive the join; the OR query carries
 *     symbol+yahooSymbol conditions; ETF rows include the volume/returns fields.
 *   - getETFsAction: cache HIT → returns cached, no DB; on miss it joins quotes,
 *     enriches returns by ISIN, sorts by abs(changePercent) / volume, then writes
 *     the cache.
 *   - getIndicesAction: thin pass-through of the service result (no transform).
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/discover-indices.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

interface PrismaFindCall {
  model: string;
  method: string;
  args: unknown;
}

interface Quote {
  instrumentId: string;
  price: number;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  previousClose: number;
}

interface Harness {
  instruments: Array<{
    id: string;
    symbol: string;
    name: string;
    exchange: string;
    yahooSymbol: string;
    isin?: string | null;
  }>;
  quotes: Quote[];
  mfMasters: Array<Record<string, unknown>>;
  cacheHit: unknown;
  indicesServiceResult: unknown;
  prismaCalls: PrismaFindCall[];
  setCalls: number;
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorCacheEntries.has(path)) {
    priorCacheEntries.set(path, moduleCache()[path]);
  }
}

const ACTION_REL = "../../lib/actions/discover-indices";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ACTION_REL)];
}

interface DiscoverIndicesModule {
  getInstrumentsBySymbolsAction: (
    symbols: string[],
    instrumentType: "ETF" | "INDEX",
    yahooSymbols?: string[]
  ) => Promise<{
    success: boolean;
    data?: Array<Record<string, unknown>>;
    error?: string;
  }>;
  getETFsAction: (o?: {
    limit?: number;
    sortBy?: "symbol" | "changePercent" | "volume";
  }) => Promise<{
    success: boolean;
    data?: Array<Record<string, unknown>>;
    error?: string;
  }>;
  getIndicesAction: () => Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
  }>;
}

function freshHarness(): Harness {
  return {
    instruments: [],
    quotes: [],
    mfMasters: [],
    cacheHit: null,
    indicesServiceResult: { success: true, data: [{ symbol: "NIFTY" }] },
    prismaCalls: [],
    setCalls: 0,
  };
}

function loadAction(h: Harness): DiscoverIndicesModule {
  const cache = moduleCache();

  const dbPath = require.resolve("@usemoney/database");
  const corePath = require.resolve("@usemoney/core");
  const servicesPath = require.resolve("@usemoney/services");
  const actionPath = require.resolve(ACTION_REL);

  for (const p of [dbPath, corePath, servicesPath]) snapshotOnce(p);

  cache[dbPath] = {
    exports: {
      __esModule: true,
      prisma: {
        instrumentMapping: {
          findMany: (args: unknown) => {
            h.prismaCalls.push({
              model: "instrumentMapping",
              method: "findMany",
              args,
            });
            return Promise.resolve(h.instruments);
          },
        },
        latestQuote: {
          findMany: (args: unknown) => {
            h.prismaCalls.push({
              model: "latestQuote",
              method: "findMany",
              args,
            });
            // The action filters previousClose>0 in the WHERE; our double
            // already returns only the quotes the test declares.
            return Promise.resolve(h.quotes);
          },
        },
        mutualFundMaster: {
          findMany: (args: unknown) => {
            h.prismaCalls.push({
              model: "mutualFundMaster",
              method: "findMany",
              args,
            });
            return Promise.resolve(h.mfMasters);
          },
        },
      },
    },
  };
  cache[corePath] = {
    exports: {
      __esModule: true,
      getCached: () => Promise.resolve(h.cacheHit),
      setCached: () => {
        h.setCalls += 1;
        return Promise.resolve();
      },
    },
  };
  cache[servicesPath] = {
    exports: {
      __esModule: true,
      getIndices: () => Promise.resolve(h.indicesServiceResult),
    },
  };

  delete cache[actionPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as DiscoverIndicesModule;
}

function quote(over: Partial<Quote> & { instrumentId: string }): Quote {
  return {
    price: 100,
    change: 1,
    changePercent: 1,
    volume: 1000,
    previousClose: 99,
    ...over,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — discover-indices actions (real handlers, mocked I/O)", () => {
  let h: Harness;
  beforeEach(() => {
    h = freshHarness();
  });
  after(() => {
    restoreCache();
  });

  describe("getInstrumentsBySymbolsAction (input caps + quote join)", () => {
    it("empty symbols & no yahooSymbols → [] without any DB query", async () => {
      const action = loadAction(h);
      const res = await action.getInstrumentsBySymbolsAction([], "INDEX");
      assert.equal(res.success, true);
      assert.deepEqual(res.data, []);
      assert.equal(h.prismaCalls.length, 0);
    });

    it(">50 symbols → [] (pagination cap), no DB query", async () => {
      const big = Array.from({ length: 51 }, (_, i) => `SYM${i}`);
      const action = loadAction(h);
      const res = await action.getInstrumentsBySymbolsAction(big, "INDEX");
      assert.equal(res.success, true);
      assert.deepEqual(res.data, []);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("only instruments WITH a live quote survive the join", async () => {
      h.instruments = [
        {
          id: "i1",
          symbol: "NIFTY",
          name: "Nifty 50",
          exchange: "NSE",
          yahooSymbol: "^NSEI",
        },
        {
          id: "i2",
          symbol: "DEAD",
          name: "No Quote",
          exchange: "NSE",
          yahooSymbol: "DEAD",
        },
      ];
      h.quotes = [quote({ instrumentId: "i1", price: 22000 })];
      const action = loadAction(h);
      const res = await action.getInstrumentsBySymbolsAction(
        ["NIFTY", "DEAD"],
        "INDEX"
      );
      assert.equal(res.success, true);
      assert.equal(
        res.data!.length,
        1,
        "instrument without a quote is dropped"
      );
      assert.equal(res.data![0]!.symbol, "NIFTY");
      assert.equal(res.data![0]!.price, 22000);
    });

    it("the OR query carries both symbol and yahooSymbol conditions", async () => {
      h.instruments = [];
      const action = loadAction(h);
      await action.getInstrumentsBySymbolsAction(["NIFTY"], "INDEX", ["^NSEI"]);
      const find = h.prismaCalls.find((c) => c.model === "instrumentMapping");
      const where = (
        find!.args as { where: { OR: unknown[]; instrumentType: string } }
      ).where;
      assert.equal(where.instrumentType, "INDEX");
      assert.equal(where.OR.length, 2, "symbol + yahooSymbol OR conditions");
    });

    it("ETF rows include the volume/returns fields", async () => {
      h.instruments = [
        {
          id: "e1",
          symbol: "NIFTYBEES",
          name: "Nippon ETF",
          exchange: "NSE",
          yahooSymbol: "NIFTYBEES.NS",
        },
      ];
      h.quotes = [quote({ instrumentId: "e1", volume: 5000 })];
      const action = loadAction(h);
      const res = await action.getInstrumentsBySymbolsAction(
        ["NIFTYBEES"],
        "ETF"
      );
      assert.equal(res.success, true);
      const row = res.data![0]!;
      assert.equal(row.volume, 5000);
      assert.ok("returns1Y" in row);
      assert.ok("aum" in row);
    });
  });

  describe("getETFsAction (cache-first + sort)", () => {
    it("cache HIT → returns cached, no DB read", async () => {
      h.cacheHit = [{ symbol: "CACHED", price: 1 }];
      const action = loadAction(h);
      const res = await action.getETFsAction();
      assert.equal(res.success, true);
      assert.equal(res.data![0]!.symbol, "CACHED");
      assert.equal(h.prismaCalls.length, 0);
    });

    it("on miss: only quoted ETFs survive, then the cache is written", async () => {
      h.instruments = [
        {
          id: "e1",
          symbol: "A",
          name: "A",
          exchange: "NSE",
          yahooSymbol: "A.NS",
          isin: null,
        },
        {
          id: "e2",
          symbol: "B",
          name: "B",
          exchange: "NSE",
          yahooSymbol: "B.NS",
          isin: null,
        },
      ];
      h.quotes = [quote({ instrumentId: "e1" })]; // only A has a quote
      const action = loadAction(h);
      const res = await action.getETFsAction();
      assert.equal(res.success, true);
      assert.equal(res.data!.length, 1);
      assert.equal(res.data![0]!.symbol, "A");
      assert.equal(h.setCalls, 1, "result cached on miss");
    });

    it("sortBy changePercent orders by absolute value (descending)", async () => {
      h.instruments = [
        {
          id: "e1",
          symbol: "UP",
          name: "UP",
          exchange: "NSE",
          yahooSymbol: "UP.NS",
          isin: null,
        },
        {
          id: "e2",
          symbol: "DOWN",
          name: "DOWN",
          exchange: "NSE",
          yahooSymbol: "DOWN.NS",
          isin: null,
        },
        {
          id: "e3",
          symbol: "FLAT",
          name: "FLAT",
          exchange: "NSE",
          yahooSymbol: "FLAT.NS",
          isin: null,
        },
      ];
      h.quotes = [
        quote({ instrumentId: "e1", changePercent: 3 }),
        quote({ instrumentId: "e2", changePercent: -8 }),
        quote({ instrumentId: "e3", changePercent: 1 }),
      ];
      const action = loadAction(h);
      const res = await action.getETFsAction({ sortBy: "changePercent" });
      assert.equal(res.success, true);
      // |−8| > |3| > |1|
      assert.deepEqual(
        res.data!.map((e) => e.symbol),
        ["DOWN", "UP", "FLAT"]
      );
    });

    it("sortBy volume orders by volume (descending, null→0)", async () => {
      h.instruments = [
        {
          id: "e1",
          symbol: "LOW",
          name: "LOW",
          exchange: "NSE",
          yahooSymbol: "LOW.NS",
          isin: null,
        },
        {
          id: "e2",
          symbol: "HIGH",
          name: "HIGH",
          exchange: "NSE",
          yahooSymbol: "HIGH.NS",
          isin: null,
        },
      ];
      h.quotes = [
        quote({ instrumentId: "e1", volume: 100 }),
        quote({ instrumentId: "e2", volume: 9000 }),
      ];
      const action = loadAction(h);
      const res = await action.getETFsAction({ sortBy: "volume" });
      assert.deepEqual(
        res.data!.map((e) => e.symbol),
        ["HIGH", "LOW"]
      );
    });
  });

  describe("getIndicesAction (thin service pass-through)", () => {
    it("returns the service result unchanged", async () => {
      h.indicesServiceResult = {
        success: true,
        data: [{ symbol: "NIFTY", price: 22000 }],
      };
      const action = loadAction(h);
      const res = await action.getIndicesAction();
      assert.deepEqual(res, h.indicesServiceResult);
    });

    it("propagates a service failure verbatim", async () => {
      h.indicesServiceResult = { success: false, error: "service down" };
      const action = loadAction(h);
      const res = await action.getIndicesAction();
      assert.equal(res.success, false);
      assert.equal(res.error, "service down");
    });
  });
});
