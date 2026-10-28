/**
 * MONEY-1062 P4a Stock-Detail Parity HTTP Contract Tests — API Server
 *
 * Contract coverage for the NEW GLOBAL stock-detail surface mounted on
 * `/v1/stocks/:symbol/*` (mobile has no stock detail beyond quotes/candles):
 *
 *   GET /v1/stocks/:symbol/financials        → getStockFinancials({symbol,exchange,periodType})
 *   GET /v1/stocks/:symbol/peers             → getStockPeers({symbol,exchange})
 *   GET /v1/stocks/:symbol/news              → getStockTabNews({symbol,limit})
 *   GET /v1/stocks/:symbol/returns           → getStockReturns({symbol,exchange})
 *   GET /v1/stocks/:symbol/shareholding      → getShareholding({symbol,exchange})
 *   GET /v1/stocks/:symbol/ratios            → getStockRatios({symbol,exchange})
 *   GET /v1/stocks/:symbol/technicals        → getStockTechnicals({symbol,exchange})
 *   GET /v1/stocks/:symbol/corporate-actions → getCorporateActions({symbol,exchange})  [EXISTING service]
 *
 * Per endpoint: happy path (the service gets the parsed args — symbol VERBATIM,
 * exchange default NSE — and NO userId, proving the surface is global), param
 * validation → 400 BEFORE the service (service untouched), and the web action's
 * not-found semantics (empty `[]`/`{}`/`{shareholding:[]}` or `null` → 200
 * passthrough, NOT a 404). A service failure → 500.
 *
 * The stock-tabs services are STUBBED here (the `@usemoney/services` Proxy), so
 * the DEEP query + cache key/TTL fidelity is pinned separately on the REAL code
 * with an injected fake prisma in
 * packages/services/__tests__/parity-p4a-stock-tabs.service.test.ts.
 *
 * MOUNT: the routes aggregator (src/routes/v1/index.ts) is intentionally NOT
 * modified by this wave, so this harness mounts `stocksRoutes` DIRECTLY at
 * `/v1/stocks` (behind the real auth + request-id middleware). Same ESM stubbing
 * seam as parity-p3a-contract.test.ts.
 *
 * Source: apps/api/src/routes/v1/stocks.ts + apps/api/src/middleware/{auth,request-id}.ts
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
  const stocksRoutes = (
    require("../../src/routes/v1/stocks.ts") as { default: unknown }
  ).default;

  const instance = new Hono();
  instance.use("*", requestIdMiddleware);
  instance.use("/v1/*", authMiddleware);
  // Aggregator not modified by this wave — mount the stocks module directly.
  instance.route("/v1/stocks", stocksRoutes);
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
  setService("resolveUserId", async () => "mongo_1");
});

/** Capture the args a stubbed service was called with; return a fixed result. */
function capture(
  name: string,
  result: unknown,
): { seen: () => unknown[]; called: () => boolean } {
  let seen: unknown[] = [];
  let called = false;
  setService(name, (...args: unknown[]) => {
    seen = args;
    called = true;
    return result;
  });
  return { seen: () => seen, called: () => called };
}

// ════════════════════════════════════════════════════════════════════════════
// Financials
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/stocks/:symbol/financials (P4a)", () => {
  it("calls getStockFinancials({symbol,exchange,periodType}) — verbatim symbol, default NSE, NO userId", async () => {
    const cap = capture("getStockFinancials", {
      success: true,
      data: { income: [{ period: "Q1" }], balance: [], cashflow: [] },
    });
    const res = await app.request("/v1/stocks/RELIANCE/financials", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const args = cap.seen()[0] as {
      symbol: string;
      exchange: string;
      periodType?: string;
    };
    assert.equal(args.symbol, "RELIANCE");
    assert.equal(args.exchange, "NSE"); // schema default
    assert.equal(cap.seen()[1], undefined); // no deps / no userId — global
    const body = await res.json();
    assert.equal(body.data.income[0].period, "Q1");
  });

  it("forwards ?exchange=BSE and ?periodType=ANNUAL", async () => {
    const cap = capture("getStockFinancials", {
      success: true,
      data: { income: [], balance: [], cashflow: [] },
    });
    const res = await app.request(
      "/v1/stocks/TCS/financials?exchange=BSE&periodType=ANNUAL",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const args = cap.seen()[0] as {
      symbol: string;
      exchange: string;
      periodType?: string;
    };
    assert.equal(args.exchange, "BSE");
    assert.equal(args.periodType, "ANNUAL");
  });

  it("no-instrument empty buckets pass through as 200 (not a 404)", async () => {
    capture("getStockFinancials", {
      success: true,
      data: { income: [], balance: [], cashflow: [] },
    });
    const res = await app.request("/v1/stocks/NOPE/financials", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, { income: [], balance: [], cashflow: [] });
  });

  it("rejects an invalid ?periodType with 400 (service untouched)", async () => {
    const cap = capture("getStockFinancials", { success: true, data: {} });
    const res = await app.request(
      "/v1/stocks/RELIANCE/financials?periodType=WEEKLY",
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(cap.called(), false);
  });

  it("rejects an oversized symbol (>24) with 400", async () => {
    const cap = capture("getStockFinancials", { success: true, data: {} });
    const res = await app.request(`/v1/stocks/${"A".repeat(25)}/financials`, {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal(cap.called(), false);
  });

  it("maps a service failure to 500", async () => {
    capture("getStockFinancials", {
      success: false,
      error: "Failed to load financials",
    });
    const res = await app.request("/v1/stocks/RELIANCE/financials", {
      headers: AUTH,
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });

  it("requires a Bearer token (401 without auth)", async () => {
    const res = await app.request("/v1/stocks/RELIANCE/financials");
    assert.equal(res.status, 401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Peers
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/stocks/:symbol/peers (P4a)", () => {
  it("calls getStockPeers({symbol,exchange}) and returns the peer array", async () => {
    const cap = capture("getStockPeers", {
      success: true,
      data: [
        {
          symbol: "TCS",
          name: "TCS",
          marketCap: 1,
          pe: 2,
          roe: 3,
          changePercent: 4,
        },
      ],
    });
    const res = await app.request("/v1/stocks/INFY/peers", { headers: AUTH });
    assert.equal(res.status, 200);
    const args = cap.seen()[0] as { symbol: string; exchange: string };
    assert.equal(args.symbol, "INFY");
    assert.equal(args.exchange, "NSE");
    assert.equal(cap.seen()[1], undefined);
    assert.equal((await res.json()).data[0].symbol, "TCS");
  });

  it("empty peers pass through as 200", async () => {
    capture("getStockPeers", { success: true, data: [] });
    const res = await app.request("/v1/stocks/INFY/peers", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, []);
  });

  it("rejects a bad ?exchange with 400", async () => {
    const cap = capture("getStockPeers", { success: true, data: [] });
    const res = await app.request("/v1/stocks/INFY/peers?exchange=MCX", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal(cap.called(), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// News (symbol + limit; NO exchange)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/stocks/:symbol/news (P4a)", () => {
  it("calls getStockTabNews({symbol,limit}) — limit forwarded, service clamps", async () => {
    const cap = capture("getStockTabNews", {
      success: true,
      data: [
        {
          title: "T",
          link: "l",
          pubDate: null,
          source: "s",
          snippet: null,
          sentiment: null,
        },
      ],
    });
    const res = await app.request("/v1/stocks/RELIANCE/news?limit=5", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const args = cap.seen()[0] as { symbol: string; limit?: number };
    assert.equal(args.symbol, "RELIANCE");
    assert.equal(args.limit, 5);
    assert.equal((await res.json()).data[0].title, "T");
  });

  it("absent ?limit → limit undefined (service applies its default)", async () => {
    const cap = capture("getStockTabNews", { success: true, data: [] });
    const res = await app.request("/v1/stocks/RELIANCE/news", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const args = cap.seen()[0] as { symbol: string; limit?: number };
    assert.equal(args.limit, undefined);
  });

  it("forwards an over-max ?limit verbatim (the service clamps, not the route)", async () => {
    const cap = capture("getStockTabNews", { success: true, data: [] });
    const res = await app.request("/v1/stocks/RELIANCE/news?limit=200", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal((cap.seen()[0] as { limit?: number }).limit, 200);
  });

  it("rejects a non-integer ?limit with 400", async () => {
    const cap = capture("getStockTabNews", { success: true, data: [] });
    for (const bad of ["abc", "1.5"]) {
      const res = await app.request(`/v1/stocks/RELIANCE/news?limit=${bad}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 400, `limit=${bad} must 400`);
    }
    assert.equal(cap.called(), false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Returns
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/stocks/:symbol/returns (P4a)", () => {
  it("calls getStockReturns({symbol,exchange}) and returns the returns map", async () => {
    const cap = capture("getStockReturns", {
      success: true,
      data: { "1D": 0.5, "1Y": 12.3 },
    });
    const res = await app.request("/v1/stocks/RELIANCE/returns", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal((cap.seen()[0] as { symbol: string }).symbol, "RELIANCE");
    assert.equal((await res.json()).data["1Y"], 12.3);
  });

  it("empty returns ({}) pass through as 200 (insufficient history)", async () => {
    capture("getStockReturns", { success: true, data: {} });
    const res = await app.request("/v1/stocks/RELIANCE/returns", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, {});
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Shareholding
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/stocks/:symbol/shareholding (P4a)", () => {
  it("calls getShareholding({symbol,exchange}) → { shareholding: [...] }", async () => {
    const cap = capture("getShareholding", {
      success: true,
      data: {
        shareholding: [
          { quarter: "Q1", promoter: 50, fii: 20, dii: 15, public: 15 },
        ],
      },
    });
    const res = await app.request("/v1/stocks/RELIANCE/shareholding", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal((cap.seen()[0] as { symbol: string }).symbol, "RELIANCE");
    const body = await res.json();
    assert.equal(body.data.shareholding[0].promoter, 50);
  });

  it("empty shareholding passes through as 200 (fetch miss/swallow)", async () => {
    capture("getShareholding", { success: true, data: { shareholding: [] } });
    const res = await app.request("/v1/stocks/RELIANCE/shareholding", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, { shareholding: [] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Ratios (null → 200 passthrough)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/stocks/:symbol/ratios (P4a)", () => {
  it("calls getStockRatios({symbol,exchange}) and returns the ratios snapshot", async () => {
    const cap = capture("getStockRatios", {
      success: true,
      data: { pe: 25, source: "TICKERTAPE", fetchedAt: null },
    });
    const res = await app.request("/v1/stocks/RELIANCE/ratios?exchange=BSE", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const args = cap.seen()[0] as { symbol: string; exchange: string };
    assert.equal(args.exchange, "BSE");
    assert.equal((await res.json()).data.pe, 25);
  });

  it("a missing StockRatios row (data:null) is a 200 passthrough, NOT a 404", async () => {
    capture("getStockRatios", { success: true, data: null });
    const res = await app.request("/v1/stocks/RELIANCE/ratios", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data, null);
  });

  it("maps a service failure to 500", async () => {
    capture("getStockRatios", {
      success: false,
      error: "Failed to load fundamentals",
    });
    const res = await app.request("/v1/stocks/RELIANCE/ratios", {
      headers: AUTH,
    });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Technicals (null → 200 passthrough)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/stocks/:symbol/technicals (P4a)", () => {
  it("calls getStockTechnicals({symbol,exchange}) and returns the snapshot", async () => {
    const cap = capture("getStockTechnicals", {
      success: true,
      data: { price: 2500, rsi14: 55, sampleSize: 300, asOf: null },
    });
    const res = await app.request("/v1/stocks/RELIANCE/technicals", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal((cap.seen()[0] as { symbol: string }).symbol, "RELIANCE");
    assert.equal((await res.json()).data.sampleSize, 300);
  });

  it("insufficient-history (data:null) is a 200 passthrough, NOT a 404", async () => {
    capture("getStockTechnicals", { success: true, data: null });
    const res = await app.request("/v1/stocks/RELIANCE/technicals", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data, null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Corporate actions — EXISTING getCorporateActions service
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/stocks/:symbol/corporate-actions (P4a)", () => {
  it("calls getCorporateActions({symbol,exchange}) → { actions: [...] }", async () => {
    const cap = capture("getCorporateActions", {
      success: true,
      data: [{ symbol: "RELIANCE", type: "DIVIDEND", exDate: "2024-01-01" }],
    });
    const res = await app.request(
      "/v1/stocks/RELIANCE/corporate-actions?exchange=NSE",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const args = cap.seen()[0] as { symbol: string; exchange: string };
    assert.equal(args.symbol, "RELIANCE");
    assert.equal(args.exchange, "NSE");
    assert.equal(cap.seen()[1], undefined); // global — no userId
    const body = await res.json();
    assert.equal(body.data.actions[0].type, "DIVIDEND");
  });

  it("passes the symbol VERBATIM (the service uppercases internally)", async () => {
    const cap = capture("getCorporateActions", { success: true, data: [] });
    const res = await app.request("/v1/stocks/reliance/corporate-actions", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    // The ROUTE does not uppercase; getCorporateActions does that itself.
    assert.equal((cap.seen()[0] as { symbol: string }).symbol, "reliance");
  });

  it("empty corporate actions pass through as { actions: [] } (200)", async () => {
    capture("getCorporateActions", { success: true, data: [] });
    const res = await app.request("/v1/stocks/RELIANCE/corporate-actions", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, { actions: [] });
  });

  it("maps a service failure to 500", async () => {
    capture("getCorporateActions", {
      success: false,
      error: "Failed to load corporate actions",
    });
    const res = await app.request("/v1/stocks/RELIANCE/corporate-actions", {
      headers: AUTH,
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });

  it("rejects a bad ?exchange with 400 (service untouched)", async () => {
    const cap = capture("getCorporateActions", { success: true, data: [] });
    const res = await app.request(
      "/v1/stocks/RELIANCE/corporate-actions?exchange=xyz",
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal(cap.called(), false);
  });
});
