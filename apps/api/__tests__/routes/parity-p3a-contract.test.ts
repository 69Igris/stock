/**
 * MONEY-1062 P3a Paper-Trading Parity HTTP Contract Tests — API Server
 *
 * Contract coverage for the ADDITIVE order/cash paper-trading surface mounted on
 * `/v1/paper` (parity divergence D2): the model the LIVE web UI uses, now exposed
 * to mobile alongside the KEPT legacy position endpoints.
 *
 *   GET  /v1/paper/portfolio   → getOrCreatePaperPortfolio(userId)
 *   POST /v1/paper/orders      → placePaperOrder(userId, body)
 *   GET  /v1/paper/orders      → getPaperOrders(userId, { limit, status })
 *   GET  /v1/paper/performance → getPaperPerformance(userId)
 *   GET  /v1/paper/dashboard   → getPaperDashboardStats(userId)
 *   POST /v1/paper/reset       → resetPaperPortfolio(userId)
 *
 * Per endpoint: happy path (service args prove the userId is the resolved Mongo
 * `_id` + the parsed body reaches the service), body/query validation → 400
 * BEFORE the service (service untouched), and the ServiceResult `code` → HTTP
 * mapping (INVALID_INPUT → 400 for the price-required / insufficient-cash
 * business rejections; INTERNAL → 500). A final case proves the LEGACY `GET
 * /v1/paper` still routes to `getPaperPortfolio` — both models coexist.
 *
 * The DEEP cash/fill math (BUY debits, SELL credits, averaging, performance
 * aggregation) is pinned on the REAL service with an injected fake prisma in
 * packages/services/__tests__/parity-p3a-paper-portfolio.service.test.ts — the
 * services barrel is STUBBED here, so those internals are not observable at this
 * (route) layer.
 *
 * Uses the SAME ESM stubbing seam as money1062-hardening-contract.test.ts.
 *
 * Source: apps/api/src/routes/v1/paper.ts + apps/api/src/middleware/{auth,request-id}.ts
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
const JSON_HEADERS = { ...AUTH, "Content-Type": "application/json" } as const;

beforeEach(() => {
  verifyImpl = async () => ({ sub: "clerk_default" });
  serviceImpls.clear();
  setService("resolveUserId", async () => "mongo_1");
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/paper/portfolio
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/paper/portfolio (P3a)", () => {
  it("get-or-creates via getOrCreatePaperPortfolio(userId) → { id, initialCapital, cash }", async () => {
    let seen: unknown[] = [];
    setService("getOrCreatePaperPortfolio", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { id: "pf_1", initialCapital: 1000000, cash: 987654 },
      };
    });
    const res = await app.request("/v1/paper/portfolio", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1"]); // scoped to the resolved Mongo id
    const body = await res.json();
    assert.equal(body.data.id, "pf_1");
    assert.equal(body.data.cash, 987654);
  });

  it("a service failure → 500", async () => {
    setService("getOrCreatePaperPortfolio", async () => ({
      success: false,
      error: "Failed to get portfolio",
      code: "INTERNAL",
    }));
    const res = await app.request("/v1/paper/portfolio", { headers: AUTH });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/paper/orders — place order (zod PlaceOrderSchema)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/paper/orders (P3a)", () => {
  it("places via placePaperOrder(userId, body) → 201 { orderId, executedPrice }", async () => {
    let seen: unknown[] = [];
    setService("placePaperOrder", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { orderId: "ord_1", executedPrice: 100 } };
    });
    const res = await app.request("/v1/paper/orders", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        symbol: "RELIANCE",
        name: "Reliance Industries",
        side: "BUY",
        quantity: 10,
        price: 100,
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(seen[0], "mongo_1"); // scoped to the resolved Mongo id
    const input = seen[1] as { symbol: string; side: string; quantity: number };
    assert.equal(input.symbol, "RELIANCE");
    assert.equal(input.side, "BUY");
    assert.equal(input.quantity, 10);
    const body = await res.json();
    assert.equal(body.data.orderId, "ord_1");
    assert.equal(body.data.executedPrice, 100);
  });

  it("insufficient cash (INVALID_INPUT) → 400 (no order envelope)", async () => {
    setService("placePaperOrder", async () => ({
      success: false,
      error: "Insufficient cash. Available: ₹1,000, Required: ₹2,000",
      code: "INVALID_INPUT",
    }));
    const res = await app.request("/v1/paper/orders", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        symbol: "RELIANCE",
        name: "Reliance Industries",
        side: "BUY",
        quantity: 100,
        price: 20000,
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "INVALID_INPUT");
    assert.match(body.error.message, /Insufficient cash/);
    assert.equal(body.data, undefined); // no order materialised
  });

  it("price-required (INVALID_INPUT) → 400", async () => {
    setService("placePaperOrder", async () => ({
      success: false,
      error: "Price is required for order execution",
      code: "INVALID_INPUT",
    }));
    const res = await app.request("/v1/paper/orders", {
      method: "POST",
      headers: JSON_HEADERS,
      // MARKET order with no price — schema allows it (price optional); the
      // SERVICE rejects (executedPrice <= 0).
      body: JSON.stringify({
        symbol: "RELIANCE",
        name: "Reliance Industries",
        side: "BUY",
        quantity: 10,
      }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "INVALID_INPUT");
  });

  it("rejects malformed JSON (400 BAD_REQUEST) and an invalid body (400 VALIDATION_ERROR) before the service", async () => {
    let called = false;
    setService("placePaperOrder", async () => {
      called = true;
      return { success: true, data: { orderId: "x", executedPrice: 1 } };
    });

    const malformed = await app.request("/v1/paper/orders", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{not json",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_REQUEST");

    for (const bad of [
      {}, // missing symbol/name/side
      { symbol: "RELIANCE", name: "R", side: "BUY" }, // missing quantity
      { symbol: "RELIANCE", name: "R", side: "HOLD", quantity: 10 }, // bad side enum
      { symbol: "RELIANCE", name: "R", side: "BUY", quantity: -10 }, // non-positive qty
      { symbol: "RELIANCE", name: "R", side: "BUY", quantity: 1.5 }, // non-int qty
      { symbol: "", name: "R", side: "BUY", quantity: 10 }, // empty symbol
    ]) {
      const res = await app.request("/v1/paper/orders", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(bad),
      });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} must 400`);
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(called, false); // service never reached for any invalid body
  });

  it("maps INTERNAL → 500", async () => {
    setService("placePaperOrder", async () => ({
      success: false,
      error: "Failed to place order",
      code: "INTERNAL",
    }));
    const res = await app.request("/v1/paper/orders", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        symbol: "RELIANCE",
        name: "Reliance Industries",
        side: "BUY",
        quantity: 10,
        price: 100,
      }),
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/paper/orders — list (scoped + ?limit clamp)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/paper/orders (P3a)", () => {
  it("lists via getPaperOrders(userId, { limit, status }) scoped to the caller", async () => {
    let seen: unknown[] = [];
    setService("getPaperOrders", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: [{ id: "ord_1", symbol: "RELIANCE" }] };
    });
    const res = await app.request("/v1/paper/orders", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seen[0], "mongo_1");
    const opts = seen[1] as { limit: number; status?: string };
    assert.equal(opts.limit, 50); // parseLimit default
    const body = await res.json();
    assert.equal(body.data[0].id, "ord_1");
  });

  it("clamps ?limit to [1, 100] and passes ?status through", async () => {
    let seen: unknown[] = [];
    setService("getPaperOrders", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: [] };
    });
    const res = await app.request(
      "/v1/paper/orders?limit=200&status=EXECUTED",
      {
        headers: AUTH,
      },
    );
    assert.equal(res.status, 200);
    const opts = seen[1] as { limit: number; status?: string };
    assert.equal(opts.limit, 100); // clamped
    assert.equal(opts.status, "EXECUTED");
  });

  it("a service failure → 500", async () => {
    setService("getPaperOrders", async () => ({
      success: false,
      error: "Failed to fetch orders",
      code: "INTERNAL",
    }));
    const res = await app.request("/v1/paper/orders", { headers: AUTH });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/paper/performance + /dashboard — shapes
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/paper/performance + /dashboard (P3a)", () => {
  it("performance returns the closed-trade summary shape", async () => {
    let seen: unknown[] = [];
    setService("getPaperPerformance", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: {
          totalTrades: 3,
          closedTrades: 2,
          winners: 1,
          losers: 1,
          winRate: 50,
          totalRealizedPnL: 300,
          totalBenchmarkPnL: 0,
          totalAlpha: 300,
          bestTrade: { symbol: "A", pnl: 500 },
          worstTrade: { symbol: "B", pnl: -200 },
        },
      };
    });
    const res = await app.request("/v1/paper/performance", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1"]);
    const body = await res.json();
    assert.equal(body.data.winRate, 50);
    assert.equal(body.data.bestTrade.symbol, "A");
  });

  it("dashboard returns the portfolio + positions + performance shape", async () => {
    let seen: unknown[] = [];
    setService("getPaperDashboardStats", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: {
          portfolio: { id: "pf_1", initialCapital: 1000000, cash: 998000 },
          positions: {
            open: 1,
            closed: 2,
            totalInvested: 1000,
            totalCurrentValue: 1200,
            totalPnl: 200,
            totalPnlPercentage: 20,
            dayPnl: 50,
          },
          performance: {
            winRate: 50,
            totalTrades: 2,
            winners: 1,
            losers: 1,
            avgWin: 500,
            avgLoss: -200,
            bestTrade: 500,
            worstTrade: -200,
          },
        },
      };
    });
    const res = await app.request("/v1/paper/dashboard", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1"]);
    const body = await res.json();
    assert.equal(body.data.portfolio.cash, 998000);
    assert.equal(body.data.positions.totalPnl, 200);
    assert.equal(body.data.performance.winRate, 50);
  });

  it("a dashboard service failure → 500", async () => {
    setService("getPaperDashboardStats", async () => ({
      success: false,
      error: "Failed to fetch dashboard stats",
      code: "INTERNAL",
    }));
    const res = await app.request("/v1/paper/dashboard", { headers: AUTH });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/paper/reset
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/paper/reset (P3a)", () => {
  it("resets via resetPaperPortfolio(userId) → 200 with the restored portfolio", async () => {
    let seen: unknown[] = [];
    setService("resetPaperPortfolio", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { id: "pf_1", initialCapital: 1000000, cash: 1000000 },
      };
    });
    const res = await app.request("/v1/paper/reset", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1"]);
    assert.equal((await res.json()).data.cash, 1000000);
  });

  it("a service failure → 500", async () => {
    setService("resetPaperPortfolio", async () => ({
      success: false,
      error: "Failed to reset portfolio",
      code: "INTERNAL",
    }));
    const res = await app.request("/v1/paper/reset", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Coexistence — the LEGACY position endpoints are untouched
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: legacy + order/cash models coexist on /v1/paper (P3a)", () => {
  it("GET /v1/paper still routes to the LEGACY getPaperPortfolio (not the new model)", async () => {
    let legacySeen: unknown[] = [];
    let newModelCalled = false;
    setService("getPaperPortfolio", async (...args: unknown[]) => {
      legacySeen = args;
      return { success: true, data: { positions: [], summary: {} } };
    });
    setService("getOrCreatePaperPortfolio", async () => {
      newModelCalled = true;
      return { success: true, data: { id: "x", initialCapital: 0, cash: 0 } };
    });
    const res = await app.request("/v1/paper", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(legacySeen, ["mongo_1"]);
    assert.equal(newModelCalled, false); // GET / is the legacy list, not /portfolio
  });
});
