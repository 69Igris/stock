/**
 * MONEY-393 §30 - lib/market/symbol-mapper.ts source coverage push
 * (57% → 90%+).
 *
 * Existing tests:
 *   - symbol-mapper.test.ts (63 cases): synchronous helpers
 *   - symbol-mapper-cache.test.ts (40 cases): inline cache reimplementation
 *
 * Gap: the async DB-backed paths (toYahooSymbolAsync, findInstrument,
 * searchInstruments) and the real in-source cache. None of them are
 * exercised by the existing files because they require prisma.
 *
 * Strategy: inject a fake @usemoney/database into require.cache before
 * importing symbol-mapper. Each test gets a fresh module load so the
 * in-source cache singleton doesn't leak state.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Fake Prisma ──────────────────────────────────────────────────

interface FindUniqueArgs {
  where: Record<string, unknown>;
  select?: Record<string, unknown>;
}

interface FindManyArgs {
  where: Record<string, unknown>;
  select?: Record<string, unknown>;
  take?: number;
  orderBy?: Record<string, unknown>;
}

interface InstrumentRow {
  id: string;
  symbol: string;
  exchange: string;
  yahooSymbol: string;
  name: string;
  instrumentType: string;
  sector: string | null;
  isActive: boolean;
  /** MONEY-1177 — former tickers. The double must mirror the real schema. */
  previousSymbols: string[];
}

interface FakePrisma {
  instrumentMapping: {
    findUnique: (args: FindUniqueArgs) => Promise<unknown>;
    findMany: (args: FindManyArgs) => Promise<unknown[]>;
  };
  _data: InstrumentRow[];
  _failNext: boolean;
  _findManyCalls: FindManyArgs[];
  _findUniqueCalls: FindUniqueArgs[];
}

function makeFakePrisma(data: InstrumentRow[]): FakePrisma {
  const state: FakePrisma = {
    instrumentMapping: null as never,
    _data: data,
    _failNext: false,
    _findManyCalls: [],
    _findUniqueCalls: [],
  };
  state.instrumentMapping = {
    async findUnique(args: FindUniqueArgs) {
      state._findUniqueCalls.push(args);
      if (state._failNext) {
        state._failNext = false;
        throw new Error("simulated prisma error");
      }
      const w = args.where as Record<string, unknown>;
      // Two shapes: { symbol_exchange: { symbol, exchange } } or { yahooSymbol }
      if (w.symbol_exchange) {
        const se = w.symbol_exchange as { symbol: string; exchange: string };
        const found = state._data.find(
          (r) => r.symbol === se.symbol && r.exchange === se.exchange
        );
        if (!found) return null;
        return projectSelect(found, args.select);
      }
      if (w.yahooSymbol) {
        const found = state._data.find((r) => r.yahooSymbol === w.yahooSymbol);
        if (!found) return null;
        return projectSelect(found, args.select);
      }
      return null;
    },
    async findMany(args: FindManyArgs) {
      state._findManyCalls.push(args);
      if (state._failNext) {
        state._failNext = false;
        throw new Error("simulated prisma error");
      }
      const w = args.where as Record<string, unknown>;
      let rows = state._data.filter((r) => r.isActive);
      if (w.exchange) rows = rows.filter((r) => r.exchange === w.exchange);
      if (w.id) {
        const idCond = w.id as { notIn?: string[] };
        if (Array.isArray(idCond.notIn))
          rows = rows.filter((r) => !idCond.notIn!.includes(r.id));
      }
      if (Array.isArray(w.OR)) {
        const ors = w.OR as Array<Record<string, unknown>>;
        rows = rows.filter((r) =>
          ors.some((cond) => {
            if (cond.symbol) {
              const c = cond.symbol as {
                startsWith?: string;
                contains?: string;
              };
              if (c.startsWith && r.symbol.startsWith(c.startsWith))
                return true;
              if (c.contains && r.symbol.includes(c.contains.toUpperCase()))
                return true;
            }
            if (cond.name) {
              const c = cond.name as {
                startsWith?: string;
                contains?: string;
              };
              if (
                c.startsWith &&
                r.name.toLowerCase().startsWith(c.startsWith.toLowerCase())
              )
                return true;
              if (
                c.contains &&
                r.name.toLowerCase().includes(c.contains.toLowerCase())
              )
                return true;
            }
            return false;
          })
        );
      }
      const take = args.take ?? rows.length;
      return rows.slice(0, take).map((r) => projectSelect(r, args.select));
    },
  };
  return state;
}

function projectSelect(
  row: InstrumentRow,
  select?: Record<string, unknown>
): Record<string, unknown> {
  if (!select) return row as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (v) out[k] = (row as unknown as Record<string, unknown>)[k];
  }
  return out;
}

// ── Module loader ────────────────────────────────────────────────

type SM = typeof import("../../lib/market/symbol-mapper");

function loadSymbolMapperWithPrisma(prismaStub: FakePrisma): SM {
  const dbPath = require.resolve("@usemoney/database");
  const smPath = require.resolve("../../lib/market/symbol-mapper");
  const cache = (require as unknown as { cache: Record<string, unknown> })
    .cache;
  delete cache[dbPath];
  delete cache[smPath];
  cache[dbPath] = {
    exports: { prisma: prismaStub },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../lib/market/symbol-mapper") as SM;
}

function makeRow(partial: Partial<InstrumentRow>): InstrumentRow {
  return {
    id: "id-default",
    symbol: "ABC",
    exchange: "NSE",
    yahooSymbol: "ABC.NS",
    name: "ABC Corp",
    instrumentType: "EQUITY",
    sector: null,
    isActive: true,
    previousSymbols: [],
    ...partial,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("MONEY-393 §30 - symbol-mapper.ts DB-backed paths", () => {
  // ── toYahooSymbolAsync ──

  it("[toYahooSymbolAsync] returns mapped INDEX_MAPPINGS hit without touching DB", async () => {
    const stub = makeFakePrisma([]);
    const sm = loadSymbolMapperWithPrisma(stub);
    const result = await sm.toYahooSymbolAsync("NIFTY 50");
    assert.equal(result, "^NSEI");
    assert.equal(
      stub._findUniqueCalls.length,
      0,
      "must not touch DB on hardcoded hit"
    );
  });

  it("[toYahooSymbolAsync] passes through already-Yahoo symbols (.NS, .BO, ^)", async () => {
    const stub = makeFakePrisma([]);
    const sm = loadSymbolMapperWithPrisma(stub);
    assert.equal(await sm.toYahooSymbolAsync("FOO.NS"), "FOO.NS");
    assert.equal(await sm.toYahooSymbolAsync("FOO.BO"), "FOO.BO");
    assert.equal(await sm.toYahooSymbolAsync("^IDX"), "^IDX");
    assert.equal(stub._findUniqueCalls.length, 0);
  });

  it("[toYahooSymbolAsync] hits DB on cache miss and returns the mapped symbol", async () => {
    const stub = makeFakePrisma([
      makeRow({
        symbol: "INFY",
        exchange: "NSE",
        yahooSymbol: "INFY.NS",
        name: "Infosys",
      }),
    ]);
    const sm = loadSymbolMapperWithPrisma(stub);
    const result = await sm.toYahooSymbolAsync("infy", "NSE");
    assert.equal(result, "INFY.NS");
    assert.equal(stub._findUniqueCalls.length, 1);
    // Second call should hit in-memory cache (no new DB call).
    const result2 = await sm.toYahooSymbolAsync("infy", "NSE");
    assert.equal(result2, "INFY.NS");
    assert.equal(
      stub._findUniqueCalls.length,
      1,
      "cache should suppress 2nd lookup"
    );
  });

  it("[toYahooSymbolAsync] falls back to NSE convention when DB miss", async () => {
    const stub = makeFakePrisma([]);
    const sm = loadSymbolMapperWithPrisma(stub);
    const result = await sm.toYahooSymbolAsync("FOOBAR", "NSE");
    assert.equal(result, "FOOBAR.NS");
  });

  it("[toYahooSymbolAsync] falls back to BSE convention when DB miss", async () => {
    const stub = makeFakePrisma([]);
    const sm = loadSymbolMapperWithPrisma(stub);
    const result = await sm.toYahooSymbolAsync("FOOBAR", "BSE");
    assert.equal(result, "FOOBAR.BO");
  });

  it("[toYahooSymbolAsync] catches DB errors and falls back to convention", async () => {
    const stub = makeFakePrisma([]);
    stub._failNext = true;
    const sm = loadSymbolMapperWithPrisma(stub);
    const result = await sm.toYahooSymbolAsync("FOOBAR", "NSE");
    assert.equal(result, "FOOBAR.NS", "DB error → convention fallback");
  });

  // ── toYahooSymbolsAsync ──

  it("[toYahooSymbolsAsync] resolves each entry independently", async () => {
    const stub = makeFakePrisma([
      makeRow({ symbol: "TCS", yahooSymbol: "TCS.NS", name: "TCS" }),
    ]);
    const sm = loadSymbolMapperWithPrisma(stub);
    const result = await sm.toYahooSymbolsAsync(["TCS", "INFY"], "NSE");
    assert.deepEqual(result, ["TCS.NS", "INFY.NS"]);
  });

  // ── findInstrument ──

  it("[findInstrument] returns the full record when DB has it", async () => {
    const stub = makeFakePrisma([
      makeRow({
        id: "i1",
        symbol: "RELIANCE",
        exchange: "NSE",
        yahooSymbol: "RELIANCE.NS",
        name: "Reliance",
      }),
    ]);
    const sm = loadSymbolMapperWithPrisma(stub);
    const out = await sm.findInstrument("reliance", "NSE");
    assert.ok(out);
    assert.equal(out!.id, "i1");
    assert.equal(out!.yahooSymbol, "RELIANCE.NS");
  });

  it("[findInstrument] returns null for an unknown symbol", async () => {
    const stub = makeFakePrisma([]);
    const sm = loadSymbolMapperWithPrisma(stub);
    const out = await sm.findInstrument("UNKNOWN", "NSE");
    assert.equal(out, null);
  });

  it("[findInstrument] swallows DB errors and returns null", async () => {
    const stub = makeFakePrisma([]);
    stub._failNext = true;
    const sm = loadSymbolMapperWithPrisma(stub);
    const out = await sm.findInstrument("RELIANCE", "NSE");
    assert.equal(out, null);
  });

  // ── searchInstruments ──

  it("[searchInstruments] returns prefix matches and respects limit", async () => {
    const stub = makeFakePrisma([
      makeRow({
        id: "1",
        symbol: "TATAMOTORS",
        name: "Tata Motors",
        yahooSymbol: "TATAMOTORS.NS",
      }),
      makeRow({
        id: "2",
        symbol: "TATASTEEL",
        name: "Tata Steel",
        yahooSymbol: "TATASTEEL.NS",
      }),
      makeRow({
        id: "3",
        symbol: "INFY",
        name: "Infosys",
        yahooSymbol: "INFY.NS",
      }),
    ]);
    const sm = loadSymbolMapperWithPrisma(stub);
    const results = await sm.searchInstruments("TATA", { limit: 10 });
    assert.equal(results.length, 2);
    assert.ok(results[0]!.symbol.startsWith("TATA"));
    assert.ok(results[1]!.symbol.startsWith("TATA"));
  });

  it("[searchInstruments] broadens to contains when prefix returns < limit", async () => {
    const stub = makeFakePrisma([
      makeRow({
        id: "1",
        symbol: "TATASTEEL",
        name: "Tata Steel",
        yahooSymbol: "TATASTEEL.NS",
      }),
      makeRow({
        id: "2",
        symbol: "RELIANCE",
        name: "Reliance",
        yahooSymbol: "RELIANCE.NS",
      }),
    ]);
    const sm = loadSymbolMapperWithPrisma(stub);
    const results = await sm.searchInstruments("TATA", { limit: 10 });
    // Prefix match returns TATASTEEL only (1 row < limit 10) - triggers
    // the "broaden to contains" branch (no additional contains match in
    // this dataset, but the second findMany must have been called).
    assert.ok(results.length >= 1);
    assert.equal(
      stub._findManyCalls.length,
      2,
      "must have called findMany twice (prefix + contains)"
    );
  });

  it("[searchInstruments] filters by exchange when provided", async () => {
    const stub = makeFakePrisma([
      makeRow({
        id: "1",
        symbol: "FOO",
        exchange: "NSE",
        yahooSymbol: "FOO.NS",
        name: "Foo",
      }),
      makeRow({
        id: "2",
        symbol: "FOO",
        exchange: "BSE",
        yahooSymbol: "FOO.BO",
        name: "Foo",
      }),
    ]);
    const sm = loadSymbolMapperWithPrisma(stub);
    const nseOnly = await sm.searchInstruments("FOO", { exchange: "NSE" });
    assert.ok(
      nseOnly.every((r) => r.exchange === "NSE"),
      "must filter out BSE entries"
    );
  });

  it("[searchInstruments] sorts: symbol-prefix > NSE > name-prefix", async () => {
    const stub = makeFakePrisma([
      makeRow({
        id: "1",
        symbol: "ABCBSE",
        exchange: "BSE",
        yahooSymbol: "ABCBSE.BO",
        name: "abcbse",
      }),
      makeRow({
        id: "2",
        symbol: "ABCNSE",
        exchange: "NSE",
        yahooSymbol: "ABCNSE.NS",
        name: "abcnse",
      }),
    ]);
    const sm = loadSymbolMapperWithPrisma(stub);
    const results = await sm.searchInstruments("ABC");
    // Both are symbol-prefix matches → NSE before BSE.
    assert.equal(results[0]!.symbol, "ABCNSE");
    assert.equal(results[1]!.symbol, "ABCBSE");
  });

  it("[searchInstruments] returns [] on DB error", async () => {
    const stub = makeFakePrisma([]);
    stub._failNext = true;
    const sm = loadSymbolMapperWithPrisma(stub);
    const results = await sm.searchInstruments("X");
    assert.deepEqual(results, []);
  });

  // ── Cache TTL eviction ──

  it("[cache] expired entries are evicted on next read", async () => {
    const stub = makeFakePrisma([
      makeRow({ symbol: "TEST", yahooSymbol: "TEST.NS", name: "Test" }),
    ]);
    const sm = loadSymbolMapperWithPrisma(stub);

    // Fast-forward time: stub Date.now temporarily.
    const realNow = Date.now;
    try {
      let fakeTime = realNow();
      Date.now = () => fakeTime;
      await sm.toYahooSymbolAsync("TEST", "NSE");
      assert.equal(stub._findUniqueCalls.length, 1);
      // Advance > 60s
      fakeTime += 61 * 1000;
      await sm.toYahooSymbolAsync("TEST", "NSE");
      assert.equal(
        stub._findUniqueCalls.length,
        2,
        "expired cache → 2nd DB hit"
      );
    } finally {
      Date.now = realNow;
    }
  });
});
