/**
 * MONEY-1062 Hardening HTTP Contract Tests — API Server
 *
 * Contract coverage for the fix-wave routes NO other suite drives: paper
 * trading (zod-gated bodies), FIRE scenarios (data:null → 404 vs failure →
 * 500 — previously inverted), the trades list envelope + ?broker guard +
 * code-based delete/update mapping, and the code-based status mapping on
 * subscription cancel / research cancel / broker disconnect (service sets
 * `code: "NOT_FOUND" | "INTERNAL"`, the route maps 404/500; a code-less
 * failure keeps its endpoint-specific legacy status).
 *
 * Uses the SAME ESM stubbing seam as v1-contract.test.ts: a CJS `require`
 * seeded with a `@usemoney/services` Proxy (stable forwarder → per-test impls)
 * and a configurable `@clerk/backend` verifier, then the apps/api/src modules
 * are purged and re-required so their `import … from "@usemoney/services"`
 * resolves to the stub.
 *
 * Source: apps/api/src/routes/v1/{paper,fire,trades,subscription,research,brokers}.ts
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
// POST /v1/paper — CreatePaperTradeSchema (raw JSON used to reach the service)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/paper body validation (MONEY-1062)", () => {
  it("rejects an empty {} body with 400 VALIDATION_ERROR (service untouched)", async () => {
    let called = false;
    setService("createPaperTrade", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/paper", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("rejects a STRING quantity/averagePrice (typed number required)", async () => {
    let called = false;
    setService("createPaperTrade", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/paper", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        symbol: "RELIANCE",
        quantity: "10",
        averagePrice: "2500",
        investedValue: 25000,
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  it("rejects a negative quantity / averagePrice (positive required)", async () => {
    let called = false;
    setService("createPaperTrade", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/paper", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        symbol: "RELIANCE",
        quantity: -10,
        averagePrice: 2500,
        investedValue: 25000,
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  it("rejects a non-finite money field (1e999 parses to Infinity) with 400", async () => {
    let called = false;
    setService("createPaperTrade", async () => {
      called = true;
      return { success: true, data: {} };
    });
    // JSON.parse("1e999") === Infinity — the raw-JSON hole the zod gate closes.
    const res = await app.request("/v1/paper", {
      method: "POST",
      headers: JSON_HEADERS,
      body: '{"symbol":"RELIANCE","quantity":10,"averagePrice":2500,"investedValue":1e999}',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("a valid buy body reaches the service and returns 201", async () => {
    let seen: unknown[] = [];
    setService("createPaperTrade", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { id: "pp_1", symbol: "RELIANCE" } };
    });
    const res = await app.request("/v1/paper", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        symbol: "RELIANCE",
        quantity: 10,
        averagePrice: 2500,
        investedValue: 25000,
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(seen[0], "mongo_1"); // scoped to the resolved Mongo id
    assert.equal((seen[1] as { symbol: string }).symbol, "RELIANCE");
    assert.equal((await res.json()).data.id, "pp_1");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/paper/:id/close — ClosePaperTradeSchema (exitPrice positive finite)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/paper/:id/close validation (MONEY-1062)", () => {
  it("rejects a missing exitPrice with 400 (used to coerce → CLOSED at ₹0)", async () => {
    let called = false;
    setService("closePaperTrade", async () => {
      called = true;
      return { success: true, data: { pnl: 0 } };
    });
    const res = await app.request("/v1/paper/pp_1/close", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("rejects a STRING exitPrice with 400", async () => {
    let called = false;
    setService("closePaperTrade", async () => {
      called = true;
      return { success: true, data: { pnl: 0 } };
    });
    const res = await app.request("/v1/paper/pp_1/close", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ exitPrice: "2600" }),
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  it("rejects a negative / zero exitPrice with 400", async () => {
    let called = false;
    setService("closePaperTrade", async () => {
      called = true;
      return { success: true, data: { pnl: 0 } };
    });
    for (const bad of [-5, 0]) {
      const res = await app.request("/v1/paper/pp_1/close", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ exitPrice: bad }),
      });
      assert.equal(res.status, 400, `exitPrice ${bad} must 400`);
    }
    assert.equal(called, false);
  });

  it("rejects a non-finite exitPrice (1e999 → Infinity) with 400", async () => {
    let called = false;
    setService("closePaperTrade", async () => {
      called = true;
      return { success: true, data: { pnl: 0 } };
    });
    const res = await app.request("/v1/paper/pp_1/close", {
      method: "POST",
      headers: JSON_HEADERS,
      body: '{"exitPrice":1e999}',
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  it("a valid exitPrice closes via the service (200) with (userId, positionId, exitPrice)", async () => {
    let seen: unknown[] = [];
    setService("closePaperTrade", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { pnl: 1000 } };
    });
    const res = await app.request("/v1/paper/pp_1/close", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ exitPrice: 2600 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "pp_1", 2600]);
    assert.equal((await res.json()).data.pnl, 1000);
  });

  it("a service-side rejection (e.g. INVALID_INPUT / not found) maps to 400", async () => {
    setService("closePaperTrade", async () => ({
      success: false,
      error: "Position not found or already closed",
    }));
    const res = await app.request("/v1/paper/ghost/close", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ exitPrice: 100 }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/fire/:id — data:null → 404, failure → 500 (previously INVERTED)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/fire/:id (MONEY-1062: 404/500 un-inverted)", () => {
  it("a successful read of a MISSING/foreign scenario (data: null) → 404", async () => {
    setService("getFireScenario", async () => ({
      success: true,
      data: null,
    }));
    const res = await app.request("/v1/fire/ghost", { headers: AUTH });
    // Previously this 200'd with data:null.
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  });

  it("a DB failure ({ success:false }) → 500 (retryable, NOT a 404)", async () => {
    setService("getFireScenario", async () => ({
      success: false,
      error: "Failed to fetch FIRE scenario",
    }));
    const res = await app.request("/v1/fire/f1", { headers: AUTH });
    // Previously this 404'd, masking DB outages as "not found".
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });

  it("an owned scenario returns 200 scoped to the caller", async () => {
    let seen: unknown[] = [];
    setService("getFireScenario", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { id: "f1", name: "Retire at 45" } };
    });
    const res = await app.request("/v1/fire/f1", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "f1"]);
    assert.equal((await res.json()).data.name, "Retire at 45");
  });
});

describe("Contract: DELETE /v1/fire/:id status mapping (MONEY-1062)", () => {
  it("maps code INTERNAL → 500; a code-less failure stays the not-found 404", async () => {
    setService("deleteFireScenario", async () => ({
      success: false,
      error: "Failed to delete scenario",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/fire/f1", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(internal.status, 500);

    setService("deleteFireScenario", async () => ({
      success: false,
      error: "Scenario not found",
    }));
    const missing = await app.request("/v1/fire/ghost", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(missing.status, 404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/trades — paginate() envelope + ?broker guard (MONEY-1062)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/trades list envelope (MONEY-1062)", () => {
  it("returns the offset-paginated envelope: meta.total/page/limit + data keeps { trades, stats }", async () => {
    setService("getTrades", async () => ({
      success: true,
      data: {
        trades: [{ id: "t1" }, { id: "t2" }],
        total: 7,
        stats: { realizedPnL: 123.45 },
      },
    }));
    const res = await app.request("/v1/trades?page=2&limit=2", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // envelope meta (was missing before — clients could not page)
    assert.equal(body.meta.total, 7);
    assert.equal(body.meta.page, 2);
    assert.equal(body.meta.limit, 2);
    assert.equal(body.meta.hasMore, true); // 2*2 < 7
    // data keeps the { trades, stats } shape (stats strip not lost to a bare array)
    assert.deepEqual(
      body.data.trades.map((t: { id: string }) => t.id),
      ["t1", "t2"],
    );
    assert.equal(body.data.stats.realizedPnL, 123.45);
  });

  it("hasMore false on the last page; defaults page=1 limit=50", async () => {
    let seenFilters: { skip?: number; limit?: number } | undefined;
    setService("getTrades", async (_u: unknown, filters: unknown) => {
      seenFilters = filters as { skip?: number; limit?: number };
      return {
        success: true,
        data: { trades: [{ id: "t1" }], total: 1, stats: {} },
      };
    });
    const res = await app.request("/v1/trades", { headers: AUTH });
    const body = await res.json();
    assert.equal(body.meta.page, 1);
    assert.equal(body.meta.limit, 50);
    assert.equal(body.meta.hasMore, false);
    // pagination forwarded into the service filter (skip = (page-1)*limit)
    assert.equal(seenFilters?.skip, 0);
    assert.equal(seenFilters?.limit, 50);
  });

  it("rejects a garbage ?broker with 400 before the service (Prisma enum guard)", async () => {
    let called = false;
    setService("getTrades", async () => {
      called = true;
      return { success: true, data: { trades: [], total: 0, stats: {} } };
    });
    const res = await app.request("/v1/trades?broker=EVIL_BROKER", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("a VALID ?broker still reaches the service verbatim", async () => {
    let seenBroker: unknown;
    setService("getTrades", async (_u: unknown, filters: unknown) => {
      seenBroker = (filters as { broker?: string }).broker;
      return { success: true, data: { trades: [], total: 0, stats: {} } };
    });
    const res = await app.request("/v1/trades?broker=UPSTOX", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(seenBroker, "UPSTOX");
  });
});

describe("Contract: /v1/trades mutation status mapping (MONEY-1062)", () => {
  it("DELETE maps code NOT_FOUND → 404 (missing/foreign trade)", async () => {
    setService("deleteTrade", async () => ({
      success: false,
      error: "Trade not found",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/trades/ghost", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  });

  it("DELETE maps code INTERNAL → 500; the broker-synced refusal (no code) stays 400", async () => {
    setService("deleteTrade", async () => ({
      success: false,
      error: "Failed to delete trade",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/trades/t1", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(internal.status, 500);
    assert.equal((await internal.json()).error.code, "INTERNAL_ERROR");

    setService("deleteTrade", async () => ({
      success: false,
      error: "Only manual trades can be deleted",
    }));
    const refusal = await app.request("/v1/trades/t2", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(refusal.status, 400);
    assert.equal((await refusal.json()).error.code, "VALIDATION_ERROR");
  });

  it("PUT maps code INTERNAL → 500; a code-less failure stays 400", async () => {
    setService("updateTrade", async () => ({
      success: false,
      error: "Failed to update trade",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/trades/t1", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ notes: "x" }),
    });
    assert.equal(internal.status, 500);

    setService("updateTrade", async () => ({
      success: false,
      error: "Only manual trades can be edited",
    }));
    const refusal = await app.request("/v1/trades/t1", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ notes: "x" }),
    });
    assert.equal(refusal.status, 400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/subscription/cancel — code mapping (MONEY-1062)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/subscription/cancel status mapping (MONEY-1062)", () => {
  it("maps code NOT_FOUND (no active subscription) → 404, not a 500", async () => {
    setService("cancelSubscription", async () => ({
      success: false,
      error: "No active subscription",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/subscription/cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  });

  it("a code-less failure stays a 500 (pre-wave service contract preserved)", async () => {
    setService("cancelSubscription", async () => ({
      success: false,
      error: "Failed to cancel subscription",
    }));
    const res = await app.request("/v1/subscription/cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });

  it("cancels scoped to the caller on success", async () => {
    let seen: unknown;
    setService("cancelSubscription", async (userId: unknown) => {
      seen = userId;
      return { success: true, data: undefined };
    });
    const res = await app.request("/v1/subscription/cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(seen, "mongo_1");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/research/:sessionId/cancel — code mapping (MONEY-1062)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/research/:sessionId/cancel status mapping (MONEY-1062)", () => {
  it("maps code NOT_FOUND (missing/foreign session) → 404", async () => {
    setService("cancelResearch", async () => ({
      success: false,
      error: "Research session not found",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/research/ghost/cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  });

  it("maps code INTERNAL → 500; an 'already finished' conflict (no code) stays 400", async () => {
    setService("cancelResearch", async () => ({
      success: false,
      error: "Failed to cancel research",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/research/s1/cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(internal.status, 500);

    setService("cancelResearch", async () => ({
      success: false,
      error: "Research already completed",
    }));
    const conflict = await app.request("/v1/research/s1/cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(conflict.status, 400);
    assert.equal((await conflict.json()).error.code, "VALIDATION_ERROR");
  });

  it("cancels via the service scoped (userId, sessionId) on success", async () => {
    let seen: unknown[] = [];
    setService("cancelResearch", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: undefined };
    });
    const res = await app.request("/v1/research/s9/cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "s9"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /v1/brokers/:id — code mapping (MONEY-1062)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: DELETE /v1/brokers/:id status mapping (MONEY-1062)", () => {
  it("maps code NOT_FOUND (missing/foreign connection) → 404", async () => {
    setService("deleteBrokerConnection", async () => ({
      success: false,
      error: "Broker connection not found",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/brokers/ghost", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  });

  it("maps code INTERNAL → 500; a code-less failure stays 400", async () => {
    setService("deleteBrokerConnection", async () => ({
      success: false,
      error: "Failed to disconnect broker",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/brokers/b1", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(internal.status, 500);
    assert.equal((await internal.json()).error.code, "INTERNAL_ERROR");

    setService("deleteBrokerConnection", async () => ({
      success: false,
      error: "Disconnect blocked",
    }));
    const other = await app.request("/v1/brokers/b1", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(other.status, 400);
  });

  it("disconnects scoped to the caller on success", async () => {
    let seen: unknown[] = [];
    setService("deleteBrokerConnection", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: undefined };
    });
    const res = await app.request("/v1/brokers/b7", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "b7"]);
  });
});
