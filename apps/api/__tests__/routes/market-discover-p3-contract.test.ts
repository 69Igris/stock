/**
 * Phase C P3 HTTP Contract Tests — Market data + Discovery (MONEY-730)
 *
 * Drives the REAL Hono middleware + route handlers via `app.request(...)` for the
 * P3 surface: /v1/market/{quotes,historical,indices,mf-nav} and
 * /v1/discover/{markets,search,mfs,sectors/:sector/stocks}.
 *
 * Extends the ESM stubbing seam from v1-contract / portfolio-p2-contract: the
 * CJS `require.cache` is seeded with a `@usemoney/services` Proxy AND a
 * `@usemoney/core/market-data` Proxy (both stable forwarders → per-test impls),
 * plus a configurable `@clerk/backend` verifier. The apps/api/src modules are
 * then purged and re-required so their `import … from "@usemoney/services"` /
 * `"@usemoney/core/market-data"` resolve to the stubs.
 *
 * NOTE: `@usemoney/core/market-data/market-hours` (getNseMarketStatus) is a PURE
 * subpath and is deliberately NOT stubbed — the quotes handler calls the real
 * (no-I/O) phase detector.
 *
 * SCOPING: market + discovery data is GLOBAL — the tests assert the underlying
 * services/core fns are called with NO userId (only the /v1 Bearer gate applies).
 *
 * Source: apps/api/src/routes/v1/{market,discover}.ts
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

// ── configurable @usemoney/core/market-data ─────────────────────────────────
// These fns do NOT return ServiceResult (Map / array), so the default forwarder
// throws — every test sets the impl for what it exercises.
const coreImpls = new Map<string, (...args: unknown[]) => unknown>();
function setCore(name: string, fn: (...args: unknown[]) => unknown): void {
  coreImpls.set(name, fn);
}
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

beforeEach(() => {
  verifyImpl = async () => ({ sub: "clerk_default" });
  serviceImpls.clear();
  coreImpls.clear();
  setService("resolveUserId", async () => "mongo_1");
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/market/quotes — batch DELAYED quotes (Yahoo), GLOBAL (no userId)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/market/quotes", () => {
  it("returns delayed quotes with a per-quote + payload delayed/source flag", async () => {
    let seenSymbols: unknown;
    setCore("yahooFetchQuotes", async (symbols: unknown) => {
      seenSymbols = symbols;
      return new Map([
        [
          "RELIANCE.NS",
          {
            symbol: "RELIANCE.NS",
            shortName: "Reliance",
            regularMarketPrice: 2500,
            regularMarketChange: 10,
            regularMarketChangePercent: 0.4,
            regularMarketTime: 1_700_000_000,
          },
        ],
      ]);
    });

    const res = await app.request(
      "/v1/market/quotes?symbols=RELIANCE.NS,TCS.NS",
      {
        headers: AUTH,
      },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    // GLOBAL: core fn received the symbols list, NOT a userId.
    assert.deepEqual(seenSymbols, ["RELIANCE.NS", "TCS.NS"]);
    assert.equal(body.data.source, "yahoo");
    assert.equal(body.data.delayed, true); // COMPLIANCE: payload-level flag
    assert.equal(body.data.quotes.length, 1);
    assert.equal(body.data.quotes[0].symbol, "RELIANCE.NS");
    assert.equal(body.data.quotes[0].price, 2500);
    assert.equal(body.data.quotes[0].delayed, true); // COMPLIANCE: per-quote flag
    assert.deepEqual(body.data.missing, ["TCS.NS"]); // requested, not resolved
    // Real (unstubbed) market-hours phase detector ran.
    assert.ok(typeof body.data.market.isLive === "boolean");
  });

  it("neutralises a non-finite upstream number to null (no ₹NaN)", async () => {
    setCore("yahooFetchQuotes", async () => {
      return new Map([
        [
          "X.NS",
          {
            symbol: "X.NS",
            regularMarketPrice: 100,
            regularMarketChangePercent: NaN, // ÷0 poison from upstream
          },
        ],
      ]);
    });
    const res = await app.request("/v1/market/quotes?symbols=X.NS", {
      headers: AUTH,
    });
    const body = await res.json();
    assert.equal(body.data.quotes[0].price, 100);
    assert.equal(body.data.quotes[0].changePercent, null); // NaN → null
  });

  it("rejects an empty symbols list with 400 (never calls upstream)", async () => {
    let called = false;
    setCore("yahooFetchQuotes", async () => {
      called = true;
      return new Map();
    });
    const res = await app.request("/v1/market/quotes?symbols=", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("rejects an oversized symbols list (>50) with 400 (bounds the fan-out)", async () => {
    let called = false;
    setCore("yahooFetchQuotes", async () => {
      called = true;
      return new Map();
    });
    const many = Array.from({ length: 51 }, (_, i) => `S${i}.NS`).join(",");
    const res = await app.request(`/v1/market/quotes?symbols=${many}`, {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("maps an upstream throw to a sanitized 500 (no internal detail leaks)", async () => {
    setCore("yahooFetchQuotes", async () => {
      throw new Error("yahoo cookie/crumb refresh failed");
    });
    const res = await app.request("/v1/market/quotes?symbols=RELIANCE.NS", {
      headers: AUTH,
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.equal(body.error.message, "Failed to fetch quotes"); // sanitized
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/market/historical — DELAYED OHLC candles, GLOBAL
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/market/historical", () => {
  it("returns OHLC bars + delayed flag; resolves range → interval + window", async () => {
    let seen: {
      symbol?: unknown;
      opts?: { period1?: Date; period2?: Date; interval?: string };
    } = {};
    setCore("yahooFetchChart", async (symbol: unknown, opts: unknown) => {
      seen = { symbol, opts: opts as { interval?: string } };
      return [
        {
          date: new Date("2026-07-01T00:00:00.000Z"),
          open: 1,
          high: 2,
          low: 0.5,
          close: 1.5,
          volume: 1000,
        },
      ];
    });

    const res = await app.request(
      "/v1/market/historical?symbol=RELIANCE.NS&range=1mo",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(seen.symbol, "RELIANCE.NS");
    assert.equal(seen.opts?.interval, "1d"); // 1mo → daily candles
    assert.ok(
      seen.opts?.period1 instanceof Date && seen.opts?.period2 instanceof Date,
    );
    assert.equal(body.data.symbol, "RELIANCE.NS");
    assert.equal(body.data.range, "1mo");
    assert.equal(body.data.interval, "1d");
    assert.equal(body.data.delayed, true);
    assert.equal(body.data.source, "yahoo");
    assert.equal(body.data.bars[0].date, "2026-07-01T00:00:00.000Z"); // Date → ISO
    assert.equal(body.data.bars[0].close, 1.5);
  });

  it("rejects an unknown range enum with 400 (never calls upstream)", async () => {
    let called = false;
    setCore("yahooFetchChart", async () => {
      called = true;
      return [];
    });
    const res = await app.request(
      "/v1/market/historical?symbol=RELIANCE.NS&range=10y",
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("rejects a missing symbol with 400", async () => {
    const res = await app.request("/v1/market/historical?range=1mo", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/market/indices — GLOBAL (no userId)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/market/indices", () => {
  it("returns indices + delayed flag and passes NO userId (global)", async () => {
    let seenArgs: unknown[] = [];
    setService("getIndices", async (...args: unknown[]) => {
      seenArgs = args;
      return {
        success: true,
        data: [{ symbol: "NIFTY 50", price: 22000, change: 100 }],
      };
    });
    const res = await app.request("/v1/market/indices", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(seenArgs.length, 0); // GLOBAL — no userId forwarded
    assert.equal(body.data.indices[0].symbol, "NIFTY 50");
    assert.equal(body.data.delayed, true);
    assert.equal(body.data.source, "yahoo");
  });

  it("maps a service failure to 500", async () => {
    setService("getIndices", async () => ({ success: false, error: "boom" }));
    const res = await app.request("/v1/market/indices", { headers: AUTH });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/market/mf-nav — GLOBAL
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/market/mf-nav", () => {
  it("returns NAV history for a valid numeric schemeCode", async () => {
    let seen: unknown;
    setCore("getMfNavHistory", async (code: unknown) => {
      seen = code;
      return [
        { date: "2026-06-30", nav: 12.5 },
        { date: "2026-07-01", nav: 12.7 },
      ];
    });
    const res = await app.request("/v1/market/mf-nav?schemeCode=120503", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(seen, "120503");
    assert.equal(body.data.schemeCode, "120503");
    assert.equal(body.data.history.length, 2);
    assert.equal(body.data.history[1].nav, 12.7);
    assert.equal(body.data.source, "mfapi.in");
    assert.equal(body.data.delayed, true);
  });

  it("rejects a non-numeric schemeCode with 400", async () => {
    let called = false;
    setCore("getMfNavHistory", async () => {
      called = true;
      return [];
    });
    const res = await app.request("/v1/market/mf-nav?schemeCode=abc", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/markets — GLOBAL (no userId)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/discover/markets", () => {
  it("returns the discover home and passes NO userId (global)", async () => {
    let seenArgs: unknown[] = [];
    setService("getDiscoverData", async (...args: unknown[]) => {
      seenArgs = args;
      return {
        success: true,
        data: {
          topGainers: [{ symbol: "A" }],
          topLosers: [],
          allStocks: [],
          sectors: [{ name: "IT", count: 5 }],
        },
      };
    });
    const res = await app.request("/v1/discover/markets", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(seenArgs.length, 0); // GLOBAL
    assert.equal(body.data.topGainers[0].symbol, "A");
    assert.deepEqual(body.data.sectors, [{ name: "IT", count: 5 }]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/search — GLOBAL; q + type + limit bounded
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/discover/search", () => {
  it("returns results and maps type=stock → kind 'stocks' (no userId)", async () => {
    let seen: {
      query?: string;
      kind?: string;
      limit?: number;
      hasUser?: boolean;
    } = {};
    setService("richSearchInstruments", async (opts: unknown) => {
      const o = opts as { query: string; kind: string; limit: number };
      seen = { query: o.query, kind: o.kind, limit: o.limit };
      // GLOBAL: the options object must not carry a userId.
      seen.hasUser = "userId" in (opts as object);
      return {
        success: true,
        data: { stocks: [{ symbol: "TCS" }], mfs: [], etfs: [] },
      };
    });
    const res = await app.request("/v1/discover/search?q=tcs&type=stock", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(seen.query, "tcs");
    assert.equal(seen.kind, "stocks");
    assert.equal(seen.hasUser, false); // GLOBAL
    assert.equal(body.data.stocks[0].symbol, "TCS");
  });

  it("maps type=mf → kind 'mfs'", async () => {
    let seenKind: unknown;
    setService("richSearchInstruments", async (opts: unknown) => {
      seenKind = (opts as { kind: string }).kind;
      return { success: true, data: { stocks: [], mfs: [], etfs: [] } };
    });
    const res = await app.request("/v1/discover/search?q=hdfc&type=mf", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(seenKind, "mfs");
  });

  it("rejects a missing q with 400 (never calls the service)", async () => {
    let called = false;
    setService("richSearchInstruments", async () => {
      called = true;
      return { success: true, data: { stocks: [], mfs: [], etfs: [] } };
    });
    const res = await app.request("/v1/discover/search", { headers: AUTH });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("rejects an oversized q (>64 chars) with 400", async () => {
    const long = "a".repeat(65);
    const res = await app.request(`/v1/discover/search?q=${long}`, {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/mfs — category-branch; GLOBAL
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/discover/mfs", () => {
  it("with ?category calls getMfsByCategory (bounded limit)", async () => {
    let seen: { cat?: unknown; opts?: { limit?: number } } = {};
    let discoverCalled = false;
    setService("getMfsByCategory", async (cat: unknown, opts: unknown) => {
      seen = { cat, opts: opts as { limit?: number } };
      return { success: true, data: [{ schemeCode: "1" }] };
    });
    setService("getMfDiscoverData", async () => {
      discoverCalled = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/discover/mfs?category=Equity&limit=10", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(seen.cat, "Equity");
    assert.equal(seen.opts?.limit, 10);
    assert.equal(discoverCalled, false);
  });

  it("without ?category calls getMfDiscoverData", async () => {
    let called = false;
    setService("getMfDiscoverData", async () => {
      called = true;
      return {
        success: true,
        data: { allFunds: [], categories: [], amcList: [] },
      };
    });
    const res = await app.request("/v1/discover/mfs", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(called, true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/sectors/:sector/stocks — GLOBAL
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/discover/sectors/:sector/stocks", () => {
  it("passes the sector param + bounded limit/sortBy to the service", async () => {
    let seen: { sector?: unknown; opts?: { limit?: number; sortBy?: string } } =
      {};
    setService("getStocksBySector", async (sector: unknown, opts: unknown) => {
      seen = { sector, opts: opts as { limit?: number; sortBy?: string } };
      return { success: true, data: [{ symbol: "TCS" }] };
    });
    const res = await app.request(
      "/v1/discover/sectors/IT/stocks?limit=5&sortBy=changePercent",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(seen.sector, "IT");
    assert.equal(seen.opts?.limit, 5);
    assert.equal(seen.opts?.sortBy, "changePercent");
    assert.equal(body.data[0].symbol, "TCS");
  });

  it("rejects an invalid sortBy with 400", async () => {
    const res = await app.request(
      "/v1/discover/sectors/IT/stocks?sortBy=bogus",
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Auth gate still applies to the (global-data) P3 routes
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: P3 routes still require a Bearer token", () => {
  it("rejects /v1/market/quotes without auth (401)", async () => {
    const res = await app.request("/v1/market/quotes?symbols=RELIANCE.NS");
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "UNAUTHORIZED");
  });

  it("rejects /v1/discover/markets without auth (401)", async () => {
    const res = await app.request("/v1/discover/markets");
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "UNAUTHORIZED");
  });
});
