/**
 * MONEY-1060 (RC3/RC4 + review fixes 1/3/6/10) — fetch_stock_price tiers.
 *
 * The tool resolves Yahoo → Tickertape → DB (`DailyPrice`+`StockRatios`) →
 * Gemini search-grounded scalars. These tests import the REAL exported
 * orchestrators (`assemblePrices`, `fetchLivePrices`) and the REAL
 * `fetchDbPriceFallback` / `needsSearchQuote` (with INJECTED fakes — no DB, no
 * network, no LLM):
 *
 *   - RC3: the DB tier serves the last synced close for live misses;
 *   - fix 1 (RC4 wiring): production `yahooFetchQuotes` NEVER throws — outages
 *     ride its `onError` observer; the swallow-shaped fakes here (empty map +
 *     onError call) exercise the REAL plumbing;
 *   - fix 3 (gap vs outage): a total miss WITH a captured live error →
 *     success:false + metadata.sourceError; a total miss with NO error →
 *     the quiet pre-PR `success:true, data:{}` (unfetchable symbols must not
 *     render as red FAILED tiles);
 *   - fix 6: an alt-exchange retry hit is aliased back under the REQUESTED key
 *     (no stray .BO key; no stale DB overlay under the .NS key);
 *   - fix 10: the search tier fires for total misses and >7-day-stale DB rows,
 *     tagged source:"search".
 *
 * Source under test: packages/research/src/tools/fetch-stock-price.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assemblePrices,
  fetchDbPriceFallback,
  fetchLivePrices,
  fetchStockPriceTool,
  needsSearchQuote,
  SEARCH_TIER_MAX_DB_AGE_MS,
  type PriceFallbackDb,
} from "../src/tools/fetch-stock-price";
import type { YahooRawQuote } from "@usemoney/core/market-data";

// ── fake injectable Prisma client ───────────────────────────────────────────

interface FakeDbOpts {
  instrument?: { id: string } | null;
  dailyRows?: Array<{
    close: number;
    open?: number | null;
    high?: number | null;
    low?: number | null;
    volume?: number | null;
    date: Date;
  }>;
  ratios?: { marketCap: number | null; pe: number | null } | null;
  throwOnInstrument?: boolean;
}

function fakeDb(opts: FakeDbOpts = {}): PriceFallbackDb {
  const instrument =
    opts.instrument === undefined ? { id: "inst-1" } : opts.instrument;
  return {
    instrumentMapping: {
      findFirst: async () => {
        if (opts.throwOnInstrument) throw new Error("db down");
        return instrument;
      },
    },
    dailyPrice: {
      findMany: async () => opts.dailyRows ?? [],
    },
    stockRatios: {
      findUnique: async () => opts.ratios ?? null,
    },
  };
}

const TODAY = new Date("2026-07-06T00:00:00.000Z");
const YESTERDAY = new Date("2026-07-05T00:00:00.000Z");

describe("fetchDbPriceFallback — DailyPrice + StockRatios (injected db)", () => {
  it("returns the last close, prior-close change, and marketCap/PE", async () => {
    const row = await fetchDbPriceFallback(
      "TCS.NS",
      fakeDb({
        dailyRows: [
          {
            close: 4000,
            open: 3950,
            high: 4020,
            low: 3940,
            volume: 1000,
            date: TODAY,
          },
          {
            close: 3900,
            open: 3880,
            high: 3920,
            low: 3870,
            volume: 900,
            date: YESTERDAY,
          },
        ],
        ratios: { marketCap: 1450000, pe: 30 },
      }),
    );
    assert.ok(row);
    assert.equal(row!.price, 4000);
    assert.equal(row!.previousClose, 3900);
    assert.equal(row!.change, 100);
    assert.equal(row!.marketCap, 1450000);
    assert.equal(row!.pe, 30);
    assert.equal(row!.source, "db");
    assert.equal(row!.stale, true);
    assert.equal(row!.asOf, TODAY.toISOString());
  });

  it("returns null when the symbol is not in InstrumentMapping", async () => {
    const row = await fetchDbPriceFallback(
      "NOPE.NS",
      fakeDb({ instrument: null }),
    );
    assert.equal(row, null);
  });

  it("serves a marketCap-only row when there is no price history", async () => {
    const row = await fetchDbPriceFallback(
      "TCS.NS",
      fakeDb({ dailyRows: [], ratios: { marketCap: 1450000, pe: null } }),
    );
    assert.ok(row);
    assert.equal(row!.price, undefined);
    assert.equal(row!.marketCap, 1450000);
    assert.equal(row!.source, "db");
  });

  it("returns null when there is neither a price nor a marketCap", async () => {
    const row = await fetchDbPriceFallback(
      "TCS.NS",
      fakeDb({ dailyRows: [], ratios: null }),
    );
    assert.equal(row, null);
  });

  it("never throws — a DB error resolves to null", async () => {
    const row = await fetchDbPriceFallback(
      "TCS.NS",
      fakeDb({ throwOnInstrument: true }),
    );
    assert.equal(row, null);
  });
});

describe("assemblePrices — live + DB merge and RC4", () => {
  const liveOk = (map: Record<string, unknown>) => async () => ({
    result: { ...map },
  });
  const liveThrew = (message: string) => async () => ({
    result: {},
    error: message,
  });
  const liveEmpty = async () => ({ result: {} });

  it("returns live data and does NOT hit the DB when live resolves everything", async () => {
    let dbCalls = 0;
    const out = await assemblePrices(
      ["TCS.NS"],
      liveOk({ "TCS.NS": { symbol: "TCS.NS", price: 4000 } }),
      async () => {
        dbCalls++;
        return null;
      },
    );
    assert.equal(out.success, true);
    assert.equal(
      (out.data as Record<string, { price: number }>)["TCS.NS"]!.price,
      4000,
    );
    assert.equal(out.metadata, undefined);
    assert.equal(dbCalls, 0);
  });

  it("RC3: live threw → DB fills the symbol; success:true with sourceError + fallback", async () => {
    const out = await assemblePrices(
      ["TCS.NS"],
      liveThrew("Yahoo 429"),
      async (sym) => ({ symbol: sym, price: 3950, source: "db" }),
    );
    assert.equal(out.success, true);
    assert.equal(
      (out.data as Record<string, { source: string }>)["TCS.NS"]!.source,
      "db",
    );
    assert.match(String(out.metadata?.sourceError), /Yahoo 429/);
    assert.equal(out.metadata?.fallback, true);
  });

  it("RC4/fix 3: live errored and DB empty → success:false WITH metadata.sourceError (real outage)", async () => {
    const out = await assemblePrices(
      ["TCS.NS"],
      liveThrew("Yahoo 429"),
      async () => null,
    );
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /Yahoo 429/);
    assert.match(String(out.metadata?.sourceError), /Yahoo 429/);
  });

  it("fix 3 (gap vs outage): live empty with NO error + DB empty → quiet success:true with {}", async () => {
    // Legitimately-unfetchable symbols (bonds, BE-series, unmapped MF codes)
    // produce a total miss WITHOUT any live error. That is a genuine data gap
    // — the pre-PR quiet empty-success — NOT a red FAILED tile.
    const out = await assemblePrices(["TCS.NS"], liveEmpty, async () => null);
    assert.equal(out.success, true, "a genuine gap must not fail the task");
    assert.deepEqual(out.data, {});
    assert.equal(out.metadata, undefined);
  });

  it("merges a partial live hit with a DB fill for the missing symbol", async () => {
    const out = await assemblePrices(
      ["TCS.NS", "INFY.NS"],
      liveOk({ "TCS.NS": { symbol: "TCS.NS", price: 4000 } }),
      async (sym) =>
        sym === "INFY.NS" ? { symbol: sym, price: 1500, source: "db" } : null,
    );
    assert.equal(out.success, true);
    const data = out.data as Record<string, { price: number }>;
    assert.equal(data["TCS.NS"]!.price, 4000);
    assert.equal(data["INFY.NS"]!.price, 1500);
    // No live source threw → no sourceError.
    assert.equal(out.metadata, undefined);
  });
});

// ── fetchLivePrices — REAL onError wiring + alt-exchange aliasing (fixes 1/6) ──

function yq(symbol: string, price: number): YahooRawQuote {
  return { symbol, regularMarketPrice: price };
}

describe("fetchLivePrices — swallow-path onError wiring (fix 1)", () => {
  it("production shape: quotes fetcher returns an EMPTY map + reports via onError → error surfaced", async () => {
    // The REAL yahooFetchQuotes swallows failed chunks (Promise.allSettled)
    // and never throws — the onError observer is the only outage signal.
    const out = await fetchLivePrices(
      ["TCS.NS"],
      async (_syms, opts) => {
        opts?.onError?.(new Error("Yahoo 429 rate limited"), "fetchQuotes");
        return new Map();
      },
      async () => null, // tickertape also empty
    );
    assert.deepEqual(out.result, {});
    assert.match(out.error ?? "", /Yahoo 429 rate limited/);
  });

  it("healthy fetch → rows keyed by symbol, no error, tickertape untouched", async () => {
    let ttCalls = 0;
    const out = await fetchLivePrices(
      ["TCS.NS"],
      async () => new Map([["TCS.NS", yq("TCS.NS", 4000)]]),
      async () => {
        ttCalls++;
        return null;
      },
    );
    const row = out.result["TCS.NS"] as Record<string, unknown>;
    assert.equal(row.price, 4000);
    assert.equal(row.symbol, "TCS.NS");
    assert.equal(row.requestedSymbol, undefined, "no alias on a direct hit");
    assert.equal(out.error, undefined);
    assert.equal(ttCalls, 0);
  });

  it("Yahoo empty (no error) → Tickertape fills the row (source:'tickertape')", async () => {
    const out = await fetchLivePrices(
      ["TCS.NS"],
      async () => new Map(),
      async (sym) => ({ name: "TCS", price: 3999, symbol: sym }),
    );
    const row = out.result["TCS.NS"] as Record<string, unknown>;
    assert.equal(row.price, 3999);
    assert.equal(row.source, "tickertape");
    assert.equal(out.error, undefined);
  });
});

describe("fetchLivePrices — alt-exchange aliasing (fix 6)", () => {
  it("a .NS→.BO retry hit is keyed under the REQUESTED .NS key (no stray .BO key)", async () => {
    const batches: string[][] = [];
    let ttCalls = 0;
    const out = await fetchLivePrices(
      ["BIHSPONG.NS"],
      async (syms) => {
        batches.push([...syms]);
        if (syms.includes("BIHSPONG.NS")) return new Map(); // primary miss
        return new Map([["BIHSPONG.BO", yq("BIHSPONG.BO", 104.5)]]);
      },
      async () => {
        ttCalls++;
        return null;
      },
    );

    assert.deepEqual(batches, [["BIHSPONG.NS"], ["BIHSPONG.BO"]]);

    const row = out.result["BIHSPONG.NS"] as Record<string, unknown>;
    assert.ok(row, "the fresh quote must land under the REQUESTED key");
    assert.equal(row.price, 104.5);
    assert.equal(row.symbol, "BIHSPONG.BO", "quote keeps the actual exchange");
    assert.equal(row.requestedSymbol, "BIHSPONG.NS");
    assert.equal(
      "BIHSPONG.BO" in out.result,
      false,
      "the unrequested alt key must NOT be added separately",
    );
    assert.equal(
      ttCalls,
      0,
      "an aliased hit means the symbol is no longer missing — no Tickertape retry",
    );
  });

  it("a direct hit is never overwritten by an alias for another symbol", async () => {
    const out = await fetchLivePrices(
      ["TCS.NS", "BIHSPONG.NS"],
      async (syms) => {
        if (syms.includes("TCS.NS")) {
          return new Map([["TCS.NS", yq("TCS.NS", 4000)]]); // BIHSPONG missed
        }
        return new Map([["BIHSPONG.BO", yq("BIHSPONG.BO", 104.5)]]);
      },
      async () => null,
    );
    assert.equal((out.result["TCS.NS"] as Record<string, unknown>).price, 4000);
    assert.equal(
      (out.result["BIHSPONG.NS"] as Record<string, unknown>).price,
      104.5,
    );
    assert.equal(Object.keys(out.result).length, 2);
  });
});

// ── search-grounded final tier (fix 10) ──────────────────────────────────────

describe("needsSearchQuote — eligibility for the search tier", () => {
  const NOW = Date.parse("2026-07-07T00:00:00.000Z");
  const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

  it("no row at all → eligible", () => {
    assert.equal(needsSearchQuote(undefined, NOW), true);
  });

  it("live rows (yahoo/tickertape) → never eligible", () => {
    assert.equal(needsSearchQuote({ price: 4000 }, NOW), false);
    assert.equal(
      needsSearchQuote({ price: 4000, source: "tickertape" }, NOW),
      false,
    );
  });

  it("fresh DB row (asOf within 7 days) → not eligible", () => {
    assert.equal(
      needsSearchQuote({ source: "db", price: 4000, asOf: daysAgo(2) }, NOW),
      false,
    );
  });

  it("stale DB row (asOf older than 7 days) → eligible", () => {
    assert.equal(
      needsSearchQuote({ source: "db", price: 4000, asOf: daysAgo(10) }, NOW),
      true,
    );
    // Boundary: exactly 7 days is NOT staler than 7 days.
    assert.equal(
      needsSearchQuote({ source: "db", price: 4000, asOf: daysAgo(7) }, NOW),
      false,
    );
    assert.equal(SEARCH_TIER_MAX_DB_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  });

  it("DB row missing a usable price or asOf → eligible", () => {
    assert.equal(needsSearchQuote({ source: "db", marketCap: 100 }, NOW), true);
    assert.equal(
      needsSearchQuote({ source: "db", price: 4000, asOf: "garbage" }, NOW),
      true,
    );
  });
});

describe("assemblePrices — search tier (fix 10)", () => {
  const liveEmpty = async () => ({ result: {} as Record<string, unknown> });

  it("total miss + search hit → success:true with a source:'search' row", async () => {
    let lastKnownSeen: number | undefined = -1;
    const out = await assemblePrices(
      ["TCS.NS"],
      liveEmpty,
      async () => null,
      async (sym, lastKnownClose) => {
        lastKnownSeen = lastKnownClose;
        return {
          symbol: sym,
          price: 4012.5,
          asOf: "2026-07-06",
          source: "search",
        };
      },
    );
    assert.equal(out.success, true);
    const row = (out.data as Record<string, Record<string, unknown>>)[
      "TCS.NS"
    ]!;
    assert.equal(row.price, 4012.5);
    assert.equal(row.source, "search");
    assert.equal(
      lastKnownSeen,
      undefined,
      "no DB row → no lastKnownClose bound",
    );
  });

  it("stale (>7d) DB row → search refreshes the price; DB marketCap/PE scalars are kept", async () => {
    const staleAsOf = new Date(Date.now() - 10 * 86_400_000).toISOString();
    let lastKnownSeen: number | undefined;
    const out = await assemblePrices(
      ["TCS.NS"],
      liveEmpty,
      async (sym) => ({
        symbol: sym,
        price: 3900,
        marketCap: 1_450_000,
        pe: 30,
        asOf: staleAsOf,
        source: "db",
        stale: true,
      }),
      async (sym, lastKnownClose) => {
        lastKnownSeen = lastKnownClose;
        return {
          symbol: sym,
          price: 4005,
          asOf: "2026-07-06",
          source: "search",
        };
      },
    );
    assert.equal(out.success, true);
    const row = (out.data as Record<string, Record<string, unknown>>)[
      "TCS.NS"
    ]!;
    assert.equal(row.price, 4005);
    assert.equal(row.source, "search");
    assert.equal(row.asOf, "2026-07-06");
    assert.equal(row.marketCap, 1_450_000, "slow-moving DB marketCap kept");
    assert.equal(row.pe, 30, "slow-moving DB PE kept");
    assert.equal(
      lastKnownSeen,
      3900,
      "the stale close is passed as the hallucination bound",
    );
  });

  it("fresh DB row → the search tier is NOT consulted", async () => {
    const freshAsOf = new Date(Date.now() - 1 * 86_400_000).toISOString();
    let searchCalls = 0;
    const out = await assemblePrices(
      ["TCS.NS"],
      liveEmpty,
      async (sym) => ({
        symbol: sym,
        price: 3950,
        asOf: freshAsOf,
        source: "db",
        stale: true,
      }),
      async () => {
        searchCalls++;
        return null;
      },
    );
    assert.equal(searchCalls, 0);
    assert.equal(
      (out.data as Record<string, Record<string, unknown>>)["TCS.NS"]!.price,
      3950,
    );
  });

  it("live row → the search tier is NOT consulted", async () => {
    let searchCalls = 0;
    await assemblePrices(
      ["TCS.NS"],
      async () => ({
        result: { "TCS.NS": { symbol: "TCS.NS", price: 4000 } },
      }),
      async () => null,
      async () => {
        searchCalls++;
        return null;
      },
    );
    assert.equal(searchCalls, 0);
  });

  it("search returns null → fix-3 semantics unchanged (quiet gap / loud outage)", async () => {
    const gap = await assemblePrices(
      ["TCS.NS"],
      liveEmpty,
      async () => null,
      async () => null,
    );
    assert.equal(gap.success, true);
    assert.deepEqual(gap.data, {});

    const outage = await assemblePrices(
      ["TCS.NS"],
      async () => ({ result: {}, error: "Yahoo 429" }),
      async () => null,
      async () => null,
    );
    assert.equal(outage.success, false);
    assert.match(String(outage.metadata?.sourceError), /Yahoo 429/);
  });
});

describe("fetch_stock_price tool — schema unchanged", () => {
  it("requires a non-empty symbols array", async () => {
    const out = await fetchStockPriceTool.execute({ symbols: [] });
    assert.equal(out.success, false);
    assert.match(out.error ?? "", /symbols array is required/);
  });
});
