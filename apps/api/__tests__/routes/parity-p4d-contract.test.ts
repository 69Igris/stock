/**
 * MONEY-1062 P4d Parity HTTP Contract Tests — API Server
 *
 * Contract coverage for the P4d parity wave:
 *   GET   /v1/market/sparklines        — batch sparklines (EXISTING sparkline.service reused)
 *   GET   /v1/discover/sectors         — sector performance bars (discover-sectors.ts:40)
 *   GET   /v1/discover/heatmap         — sector buckets (default) / flat treemap (?view=stocks)
 *   GET   /v1/discover/sectors/:sector — deep-dive (sectors.ts:104)
 *   GET   /v1/discover/etfs            — ETF list (discover-indices.ts:142)
 *   GET   /v1/discover/instruments     — ETF/INDEX enrichment (discover-indices.ts:49)
 *   POST  /v1/positions                — manual position add (positions.ts:111)
 *   GET   /v1/tax/ledgers              — F&O/intraday/dividend ledgers (tax-ledgers.ts:67)
 *   PATCH /v1/brokers/:id              — rename (broker-connection.ts:777)
 *   GET   /v1/brokers/:id/counts       — per-type row counts (broker-connection.ts:1113)
 *   GET   /v1/brokers/jobs             — in-flight sync indicator (broker-connection.ts:1331)
 *
 * Each endpoint: the service seam receives EXACTLY the args the route promises
 * (userId scoping on user data, NO userId on global market/discover reads),
 * bad input → 400 BEFORE any service call, and service failure codes map to
 * the promised statuses (NOT_FOUND → 404, VALIDATION → 400, else 500).
 *
 * Same ESM stubbing seam as parity-p3b-contract: `require.cache` seeded with a
 * `@usemoney/services` Proxy + a `@usemoney/core/market-data` Proxy + a
 * configurable `@clerk/backend` verifier, then the apps/api/src modules are
 * purged and re-required so their imports resolve to the stubs.
 *
 * Source: apps/api/src/routes/v1/{market,discover,positions,tax,brokers}.ts
 *         apps/api/src/middleware/{auth,request-id}.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type ModuleCache = Record<string, { exports: unknown } | undefined>;
const cache = (require as unknown as { cache: ModuleCache }).cache;

// ── configurable Clerk verifier ─────────────────────────────────────────────
let verifyImpl: (token: string) => Promise<{ sub?: string }>;
const clerkStub = {
  __esModule: true,
  verifyToken: (token: string) => verifyImpl(token),
};

// ── configurable @usemoney/services ─────────────────────────────────────────
const serviceImpls = new Map<string, (...args: unknown[]) => unknown>();
function setService(name: string, fn: (...args: unknown[]) => unknown): void {
  serviceImpls.set(name, fn);
}
const servicesStub = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    if (typeof prop !== "string") return undefined;
    if (prop === "__esModule") return true;
    if (prop === "then") return undefined;
    if (prop === "default") return servicesStub;
    return (...args: unknown[]) => {
      const impl = serviceImpls.get(prop);
      return impl
        ? impl(...args)
        : Promise.resolve({ success: false, error: `not-stubbed:${prop}` });
    };
  },
});

// ── configurable @usemoney/core/market-data (market.ts imports it) ──────────
const coreImpls = new Map<string, (...args: unknown[]) => unknown>();
const coreStub = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    if (typeof prop !== "string") return undefined;
    if (prop === "__esModule") return true;
    if (prop === "then") return undefined;
    if (prop === "default") return coreStub;
    return (...args: unknown[]) => {
      const impl = coreImpls.get(prop);
      if (!impl) throw new Error(`core-not-stubbed:${prop}`);
      return impl(...args);
    };
  },
});

// ── install stubs + load the REAL app pieces via require() ──────────────────
const saved: Array<[string, { exports: unknown } | undefined]> = [];
function stub(path: string, exports: unknown): void {
  saved.push([path, cache[path]]);
  cache[path] = { exports };
}

interface Harness {
  request: (input: string, init?: RequestInit) => Promise<Response>;
}
let app: Harness;

before(() => {
  stub(require.resolve("@usemoney/services"), servicesStub);
  stub(require.resolve("@usemoney/core/market-data"), coreStub);
  stub(require.resolve("@clerk/backend"), clerkStub);
  for (const key of Object.keys(cache)) {
    if (key.includes("/apps/api/src/")) {
      saved.push([key, cache[key]]);
      delete cache[key];
    }
  }

  const { Hono } = require("hono") as {
    Hono: new () => Harness & Record<string, (...a: unknown[]) => unknown>;
  };
  const { authMiddleware } = require("../../src/middleware/auth.ts");
  const { requestIdMiddleware } = require("../../src/middleware/request-id.ts");
  const v1Routes = (
    require("../../src/routes/v1/index.ts") as { default: unknown }
  ).default;

  const instance = new Hono();
  instance.use("*", requestIdMiddleware);
  instance.use("/v1/*", authMiddleware);
  instance.route("/v1", v1Routes);
  app = instance as unknown as Harness;
});

after(() => {
  for (const [path, prior] of saved) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  saved.length = 0;
});

const AUTH = { Authorization: "Bearer test-token" } as const;
const JSON_HEADERS = {
  ...AUTH,
  "Content-Type": "application/json",
} as const;

beforeEach(() => {
  verifyImpl = async () => ({ sub: "clerk_default" });
  serviceImpls.clear();
  // MONEY-1142 — /v1/risk, /v1/tax and /v1/documents are now tier-gated, and
  // the gate resolves the caller's plan through `getSubscription`. Unmodelled,
  // the services Proxy answers `{success:false}`, the gate fails CLOSED (as it
  // must) and every contract case 403s — which is the gate working, not a test
  // bug. Default the caller to an entitled plan so these suites keep asserting
  // the ROUTE contract; the gate itself is covered by
  // `__tests__/routes/premium-endpoints-gated.test.ts`.
  setService("getSubscription", async (uid: unknown) => ({
    success: true,
    data: { userId: uid, planId: "PREMIUM" },
  }));
  coreImpls.clear();
  setService("resolveUserId", async () => "mongo_1");
});

/** Record every call's args for one service fn; respond with `result`. */
function captureService(name: string, result: unknown): { calls: unknown[][] } {
  const calls: unknown[][] = [];
  setService(name, async (...args: unknown[]) => {
    calls.push(args);
    return result;
  });
  return { calls };
}

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/market/sparklines — EXISTING sparkline.service reused
// ════════════════════════════════════════════════════════════════════════════

const SPARK_OK = {
  success: true,
  data: {
    "RELIANCE|NSE": {
      symbol: "RELIANCE",
      exchange: "NSE",
      yahooSymbol: "RELIANCE.NS",
      window: "1D",
      closes: [100, 101],
      lastUpdated: 1_720_000_000_000,
    },
  },
};

describe("P4d Contract: GET /v1/market/sparklines", () => {
  it("maps CSV symbols to {symbol, exchange:NSE} pairs, default window 1D", async () => {
    const cap = captureService("getSparklines", SPARK_OK);
    const res = await app.request(
      "/v1/market/sparklines?symbols=RELIANCE,TCS",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], [
      { symbol: "RELIANCE", exchange: "NSE" },
      { symbol: "TCS", exchange: "NSE" },
    ]);
    assert.equal(cap.calls[0]?.[1], "1D");
    const body = await res.json();
    // Delayed-data compliance envelope + the service map passthrough.
    assert.equal(body.data.window, "1D");
    assert.equal(body.data.source, "yahoo");
    assert.equal(body.data.delayed, true);
    assert.equal(body.data.sparklines["RELIANCE|NSE"].closes.length, 2);
  });

  it("forwards ?window=1M and ?exchange=BSE", async () => {
    const cap = captureService("getSparklines", { success: true, data: {} });
    const res = await app.request(
      "/v1/market/sparklines?symbols=RELIANCE&window=1M&exchange=BSE",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], [
      { symbol: "RELIANCE", exchange: "BSE" },
    ]);
    assert.equal(cap.calls[0]?.[1], "1M");
    assert.equal((await res.json()).data.window, "1M");
  });

  it("rejects an unknown window with 400 (never calls the service)", async () => {
    const cap = captureService("getSparklines", SPARK_OK);
    const res = await app.request(
      "/v1/market/sparklines?symbols=RELIANCE&window=6M",
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(cap.calls.length, 0);
  });

  it("rejects an unknown ?exchange with 400 (C3#9 — the exchange feeds the service cache key)", async () => {
    const cap = captureService("getSparklines", SPARK_OK);
    for (const bad of ["FOO", "nse", "NYSE"]) {
      const res = await app.request(
        `/v1/market/sparklines?symbols=RELIANCE&exchange=${bad}`,
        { headers: AUTH },
      );
      assert.equal(res.status, 400, `${bad} must 400`);
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(cap.calls.length, 0);
  });

  it("rejects empty symbols with 400", async () => {
    const cap = captureService("getSparklines", SPARK_OK);
    const res = await app.request("/v1/market/sparklines?symbols=", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal(cap.calls.length, 0);
  });

  it("rejects >50 symbols with 400 (route cap, tighter than the service's 100)", async () => {
    const cap = captureService("getSparklines", SPARK_OK);
    const many = Array.from({ length: 51 }, (_, i) => `S${i}`).join(",");
    const res = await app.request(`/v1/market/sparklines?symbols=${many}`, {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal(cap.calls.length, 0);
  });

  it("maps a service failure to 500", async () => {
    setService("getSparklines", async () => ({
      success: false,
      error: "Too many symbols in sparkline request (max 100)",
    }));
    const res = await app.request("/v1/market/sparklines?symbols=RELIANCE", {
      headers: AUTH,
    });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/sectors — sector performance (discover-sectors.ts:40)
// ════════════════════════════════════════════════════════════════════════════

describe("P4d Contract: GET /v1/discover/sectors", () => {
  it("returns the performance rows (global — service called with NO args)", async () => {
    const rows = [
      {
        sector: "Information Technology",
        count: 3,
        meanChangePct: 1.2,
        weightedChangePct: 1.5,
        barWidth: 100,
        display: null,
      },
    ];
    const cap = captureService("getSectorPerformance", {
      success: true,
      data: rows,
    });
    const res = await app.request("/v1/discover/sectors", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0], []); // global: no userId, no filters
    assert.deepEqual((await res.json()).data, rows);
  });

  it("maps a service failure to 500", async () => {
    setService("getSectorPerformance", async () => ({
      success: false,
      error: "Failed to aggregate sector performance",
    }));
    const res = await app.request("/v1/discover/sectors", { headers: AUTH });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/heatmap — both UI-live heatmap shapes behind ?view=
// ════════════════════════════════════════════════════════════════════════════

describe("P4d Contract: GET /v1/discover/heatmap", () => {
  it("defaults to the sector-aggregated view (sector-heatmap.ts args)", async () => {
    const cap = captureService("getSectorHeatmap", {
      success: true,
      data: { timeframe: "1D", asOf: "2026-07-11T00:00:00.000Z", buckets: [] },
    });
    const flat = captureService("getDiscoverHeatmap", {
      success: true,
      data: {},
    });
    const res = await app.request("/v1/discover/heatmap", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], {
      timeframe: "1D",
      topConstituents: 6,
    });
    assert.equal(flat.calls.length, 0);
    assert.deepEqual((await res.json()).data.buckets, []);
  });

  it("forwards ?timeframe= and ?top= to the sector view", async () => {
    const cap = captureService("getSectorHeatmap", {
      success: true,
      data: { timeframe: "YTD", asOf: "x", buckets: [] },
    });
    const res = await app.request("/v1/discover/heatmap?timeframe=YTD&top=3", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], {
      timeframe: "YTD",
      topConstituents: 3,
    });
  });

  it("?view=stocks routes to the flat treemap with scope+timeframe", async () => {
    const sector = captureService("getSectorHeatmap", {
      success: true,
      data: {},
    });
    const cap = captureService("getDiscoverHeatmap", {
      success: true,
      data: { stocks: [], coverage: {}, asOf: "x" },
    });
    const res = await app.request(
      "/v1/discover/heatmap?view=stocks&scope=nifty50&timeframe=1W",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], { scope: "nifty50", timeframe: "1W" });
    assert.equal(sector.calls.length, 0);
  });

  it("rejects an unknown timeframe/view/scope with 400 (no service call)", async () => {
    const a = captureService("getSectorHeatmap", { success: true, data: {} });
    const b = captureService("getDiscoverHeatmap", { success: true, data: {} });
    for (const q of [
      "timeframe=2W",
      "view=bogus",
      "view=stocks&scope=nifty100",
      "top=0",
      "top=21",
    ]) {
      const res = await app.request(`/v1/discover/heatmap?${q}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 400, `expected 400 for ?${q}`);
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(a.calls.length + b.calls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/sectors/:sector — deep-dive (sectors.ts:104)
// ════════════════════════════════════════════════════════════════════════════

describe("P4d Contract: GET /v1/discover/sectors/:sector", () => {
  it("resolves the slug via getSectorDeepDive and passes the bundle through", async () => {
    const bundle = {
      sector: "Information Technology",
      aggregate: { name: "Information Technology", mcap: 100, count: 2 },
      constituents: [],
      events: [],
      news: [],
      vsBenchmarkBps: 12,
    };
    const cap = captureService("getSectorDeepDive", {
      success: true,
      data: bundle,
    });
    const res = await app.request(
      "/v1/discover/sectors/information-technology",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0], ["information-technology"]); // global: no userId
    assert.deepEqual((await res.json()).data, bundle);
  });

  it("maps NOT_FOUND to 404 and a code-less failure to 500", async () => {
    setService("getSectorDeepDive", async () => ({
      success: false,
      error: "Sector not found",
      code: "NOT_FOUND",
    }));
    const notFound = await app.request("/v1/discover/sectors/narnia", {
      headers: AUTH,
    });
    assert.equal(notFound.status, 404);
    assert.equal((await notFound.json()).error.code, "NOT_FOUND");

    setService("getSectorDeepDive", async () => ({
      success: false,
      error: "Discover data unavailable",
    }));
    const failed = await app.request("/v1/discover/sectors/it", {
      headers: AUTH,
    });
    assert.equal(failed.status, 500);
  });

  it("the literal /sectors path is NOT captured as a :sector", async () => {
    const perf = captureService("getSectorPerformance", {
      success: true,
      data: [],
    });
    const dive = captureService("getSectorDeepDive", {
      success: true,
      data: {},
    });
    const res = await app.request("/v1/discover/sectors", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(perf.calls.length, 1);
    assert.equal(dive.calls.length, 0);
  });

  it("the pre-existing /sectors/:sector/stocks route is untouched", async () => {
    const stocks = captureService("getStocksBySector", {
      success: true,
      data: [],
    });
    const dive = captureService("getSectorDeepDive", {
      success: true,
      data: {},
    });
    const res = await app.request("/v1/discover/sectors/Banks/stocks", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(stocks.calls.length, 1);
    assert.equal(stocks.calls[0]?.[0], "Banks");
    assert.equal(dive.calls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/etfs — ETF list (discover-indices.ts:142)
// ════════════════════════════════════════════════════════════════════════════

describe("P4d Contract: GET /v1/discover/etfs", () => {
  it("defaults to the web action's { limit: 30, sortBy: 'symbol' }", async () => {
    const cap = captureService("getETFs", { success: true, data: [] });
    const res = await app.request("/v1/discover/etfs", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], { limit: 30, sortBy: "symbol" });
  });

  it("forwards ?limit= and ?sortBy=", async () => {
    const cap = captureService("getETFs", { success: true, data: [] });
    const res = await app.request("/v1/discover/etfs?limit=5&sortBy=volume", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], { limit: 5, sortBy: "volume" });
  });

  it("rejects a bad sortBy / out-of-range limit with 400 (no service call)", async () => {
    const cap = captureService("getETFs", { success: true, data: [] });
    for (const q of ["sortBy=aum", "limit=0", "limit=101"]) {
      const res = await app.request(`/v1/discover/etfs?${q}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 400, `expected 400 for ?${q}`);
    }
    assert.equal(cap.calls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/instruments — ETF/INDEX enrichment (discover-indices.ts:49)
// ════════════════════════════════════════════════════════════════════════════

describe("P4d Contract: GET /v1/discover/instruments", () => {
  it("passes (symbols[], type, undefined) when yahooSymbols is absent", async () => {
    const cap = captureService("getInstrumentsBySymbols", {
      success: true,
      data: [{ symbol: "NIFTYBEES" }],
    });
    const res = await app.request(
      "/v1/discover/instruments?symbols=NIFTYBEES,GOLDBEES&type=ETF",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0], [
      ["NIFTYBEES", "GOLDBEES"],
      "ETF",
      undefined,
    ]);
    assert.equal((await res.json()).data[0].symbol, "NIFTYBEES");
  });

  it("passes yahooSymbols as the third arg when present", async () => {
    const cap = captureService("getInstrumentsBySymbols", {
      success: true,
      data: [],
    });
    const res = await app.request(
      "/v1/discover/instruments?symbols=&type=INDEX&yahooSymbols=%5ENSEI,%5EBSESN",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0], [[], "INDEX", ["^NSEI", "^BSESN"]]);
  });

  it("empty lists are forwarded (web semantic: service answers [])", async () => {
    const cap = captureService("getInstrumentsBySymbols", {
      success: true,
      data: [],
    });
    const res = await app.request("/v1/discover/instruments?type=ETF", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0], [[], "ETF", undefined]);
    assert.deepEqual((await res.json()).data, []);
  });

  it("rejects a missing/unknown type and >50 symbols with 400", async () => {
    const cap = captureService("getInstrumentsBySymbols", {
      success: true,
      data: [],
    });
    const many = Array.from({ length: 51 }, (_, i) => `S${i}`).join(",");
    for (const q of [
      "symbols=A", // no type
      "symbols=A&type=STOCK",
      `symbols=${many}&type=ETF`,
    ]) {
      const res = await app.request(`/v1/discover/instruments?${q}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 400, `expected 400 for ?${q}`);
    }
    assert.equal(cap.calls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/positions — manual add (positions.ts:111)
// ════════════════════════════════════════════════════════════════════════════

const MANUAL_POSITION_BODY = {
  symbol: "reliance",
  exchange: "NSE",
  segment: "EQ",
  productType: "CNC",
  positionType: "LONG",
  quantity: 10,
  entryPrice: 2500,
  currentPrice: 2550,
};

describe("P4d Contract: POST /v1/positions (manual add)", () => {
  it("creates via addManualPosition(userId, body) and returns 201 {positionId}", async () => {
    const cap = captureService("addManualPosition", {
      success: true,
      data: { positionId: "pos_1" },
    });
    const res = await app.request("/v1/positions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(MANUAL_POSITION_BODY),
    });
    assert.equal(res.status, 201);
    assert.equal(cap.calls[0]?.[0], "mongo_1"); // resolved Mongo _id scoping
    assert.deepEqual(cap.calls[0]?.[1], MANUAL_POSITION_BODY);
    assert.equal((await res.json()).data.positionId, "pos_1");
  });

  it("rejects an invalid body with 400 BEFORE the service", async () => {
    const cap = captureService("addManualPosition", {
      success: true,
      data: { positionId: "x" },
    });
    const bad: Array<Record<string, unknown>> = [
      { ...MANUAL_POSITION_BODY, quantity: undefined }, // missing
      { ...MANUAL_POSITION_BODY, quantity: -5 }, // negative
      { ...MANUAL_POSITION_BODY, entryPrice: 0 }, // non-positive
      { ...MANUAL_POSITION_BODY, quantity: "10" }, // string number
      { ...MANUAL_POSITION_BODY, positionType: "HEDGE" }, // bad enum
    ];
    for (const body of bad) {
      const res = await app.request("/v1/positions", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(cap.calls.length, 0);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await app.request("/v1/positions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "BAD_REQUEST");
  });

  it("maps a service failure to 500", async () => {
    setService("addManualPosition", async () => ({
      success: false,
      error: "Failed to add position. Please try again.",
    }));
    const res = await app.request("/v1/positions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(MANUAL_POSITION_BODY),
    });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/tax/ledgers — FY ledgers (tax-ledgers.ts:67)
// ════════════════════════════════════════════════════════════════════════════

const LEDGERS_OK = {
  success: true,
  data: {
    fno: [],
    intraday: [{ date: "2026-05-02", symbol: "TCS", pnl: 120 }],
    dividends: [],
    totals: { fnoPnl: 0, intradayPnl: 120, dividendIncome: 0 },
  },
};

describe("P4d Contract: GET /v1/tax/ledgers", () => {
  it("defaults to the current FY (fy undefined) with the caller's userId", async () => {
    const cap = captureService("getTaxLedgers", LEDGERS_OK);
    const res = await app.request("/v1/tax/ledgers", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0], ["mongo_1", undefined]);
    const body = await res.json();
    assert.equal(body.data.totals.intradayPnl, 120);
    assert.deepEqual(body.data.dividends, []); // no model yet — always empty
  });

  it("forwards a valid ?fy=", async () => {
    const cap = captureService("getTaxLedgers", LEDGERS_OK);
    const res = await app.request("/v1/tax/ledgers?fy=2024-25", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0], ["mongo_1", "2024-25"]);
  });

  it("rejects a malformed ?fy with 400 (no service call)", async () => {
    const cap = captureService("getTaxLedgers", LEDGERS_OK);
    const res = await app.request("/v1/tax/ledgers?fy=garbage", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(cap.calls.length, 0);
  });

  it("maps a service failure to 500", async () => {
    setService("getTaxLedgers", async () => ({
      success: false,
      error: "Failed to load ledgers",
    }));
    const res = await app.request("/v1/tax/ledgers", { headers: AUTH });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /v1/brokers/:id — rename (broker-connection.ts:777)
// ════════════════════════════════════════════════════════════════════════════

describe("P4d Contract: PATCH /v1/brokers/:id (rename)", () => {
  it("renames via updateBrokerAccountName(userId, id, raw name)", async () => {
    const cap = captureService("updateBrokerAccountName", {
      success: true,
      data: { accountName: "My Zerodha" },
    });
    const res = await app.request("/v1/brokers/conn_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ accountName: " My Zerodha " }),
    });
    assert.equal(res.status, 200);
    // The RAW string reaches the service — trimming is the service's job
    // (mirrors the web action's accountName.trim() placement).
    assert.deepEqual(cap.calls[0], ["mongo_1", "conn_1", " My Zerodha "]);
    assert.equal((await res.json()).data.accountName, "My Zerodha");
  });

  it("maps service codes: VALIDATION → 400, NOT_FOUND → 404, code-less → 500", async () => {
    setService("updateBrokerAccountName", async () => ({
      success: false,
      error: "Account name cannot be empty",
      code: "VALIDATION",
    }));
    const empty = await app.request("/v1/brokers/conn_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ accountName: "   " }),
    });
    assert.equal(empty.status, 400);

    setService("updateBrokerAccountName", async () => ({
      success: false,
      error: "Connection not found or unauthorized",
      code: "NOT_FOUND",
    }));
    const foreign = await app.request("/v1/brokers/other_users_conn", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ accountName: "Mine now" }),
    });
    assert.equal(foreign.status, 404);

    setService("updateBrokerAccountName", async () => ({
      success: false,
      error: "Failed to update account name",
    }));
    const failed = await app.request("/v1/brokers/conn_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ accountName: "X" }),
    });
    assert.equal(failed.status, 500);
  });

  it("rejects a non-string accountName and malformed JSON with 400 (no call)", async () => {
    const cap = captureService("updateBrokerAccountName", {
      success: true,
      data: { accountName: "x" },
    });
    const nonString = await app.request("/v1/brokers/conn_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ accountName: 123 }),
    });
    assert.equal(nonString.status, 400);

    const malformed = await app.request("/v1/brokers/conn_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: "{oops",
    });
    assert.equal(malformed.status, 400);
    assert.equal(cap.calls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/brokers/:id/counts — row counts (broker-connection.ts:1113)
// ════════════════════════════════════════════════════════════════════════════

const COUNTS_OK = {
  success: true,
  data: {
    holdings: 4,
    positions: 2,
    trades: 40,
    importedTrades: 10,
    manualTrades: 1,
    mutualFunds: 3,
    pairedTrades: 12,
    orders: 44,
  },
};

describe("P4d Contract: GET /v1/brokers/:id/counts", () => {
  it("fetches via getBrokerDataCounts(userId, connectionId)", async () => {
    const cap = captureService("getBrokerDataCounts", COUNTS_OK);
    const res = await app.request("/v1/brokers/conn_1/counts", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0], ["mongo_1", "conn_1"]);
    assert.equal((await res.json()).data.pairedTrades, 12);
  });

  it("maps NOT_FOUND (foreign/missing connection) to 404, else 500", async () => {
    setService("getBrokerDataCounts", async () => ({
      success: false,
      error: "Connection not found",
      code: "NOT_FOUND",
    }));
    const foreign = await app.request("/v1/brokers/other_conn/counts", {
      headers: AUTH,
    });
    assert.equal(foreign.status, 404);

    setService("getBrokerDataCounts", async () => ({
      success: false,
      error: "Failed to fetch data counts",
      code: "INTERNAL",
    }));
    const failed = await app.request("/v1/brokers/conn_1/counts", {
      headers: AUTH,
    });
    assert.equal(failed.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/brokers/jobs — in-flight sync indicator (broker-connection.ts:1331)
// ════════════════════════════════════════════════════════════════════════════

describe("P4d Contract: GET /v1/brokers/jobs", () => {
  it("returns the active-job indicator via getActiveBrokerJobs(userId)", async () => {
    const cap = captureService("getActiveBrokerJobs", {
      success: true,
      data: { active: true, phase: "syncing" },
    });
    const res = await app.request("/v1/brokers/jobs", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0], ["mongo_1"]);
    const body = await res.json();
    assert.equal(body.data.active, true);
    assert.equal(body.data.phase, "syncing");
  });

  it("degrades a service failure to 200 { active:false } (poller never dead-ends)", async () => {
    // Default Proxy answer (not stubbed) = { success:false } — the route's
    // defensive branch must still 200 with the inactive shape.
    const res = await app.request("/v1/brokers/jobs", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data, { active: false, phase: null });
  });

  it("the literal /jobs path is NOT captured by GET /:id", async () => {
    const jobs = captureService("getActiveBrokerJobs", {
      success: true,
      data: { active: false, phase: null },
    });
    const conn = captureService("getBrokerConnection", {
      success: true,
      data: { id: "jobs" },
    });
    const res = await app.request("/v1/brokers/jobs", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(jobs.calls.length, 1);
    assert.equal(conn.calls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Auth gate — every new endpoint sits behind the /v1 Bearer middleware
// ════════════════════════════════════════════════════════════════════════════

describe("P4d Contract: auth gate", () => {
  it("rejects tokenless requests to the new endpoints with 401", async () => {
    for (const [method, path] of [
      ["GET", "/v1/market/sparklines?symbols=RELIANCE"],
      ["GET", "/v1/discover/sectors"],
      ["GET", "/v1/discover/heatmap"],
      ["GET", "/v1/discover/etfs"],
      ["GET", "/v1/discover/instruments?type=ETF"],
      ["GET", "/v1/discover/sectors/information-technology"],
      ["POST", "/v1/positions"],
      ["GET", "/v1/tax/ledgers"],
      ["PATCH", "/v1/brokers/conn_1"],
      ["GET", "/v1/brokers/conn_1/counts"],
      ["GET", "/v1/brokers/jobs"],
    ] as const) {
      const res = await app.request(path, { method });
      assert.equal(res.status, 401, `expected 401 for ${method} ${path}`);
    }
  });
});
