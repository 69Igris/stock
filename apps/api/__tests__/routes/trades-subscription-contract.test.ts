/**
 * POST /v1/trades + the subscription reads — HTTP CONTRACT tests
 * (MONEY-1091 follow-up, MONEY-1181).
 *
 * Closes the last WRITE gap and the two money-path read gaps:
 *
 *   POST /v1/trades
 *   GET  /v1/subscription
 *   GET  /v1/subscription/payments
 *
 * ## The bug (MONEY-1181)
 *
 * `POST /v1/trades` mapped every service failure to **400 VALIDATION_ERROR**,
 * which it can never be. The body is validated against `TradeFormSchema`
 * immediately before the call, and `createTrade` has exactly ONE failure path —
 * the `catch` around the Prisma write. So `success: false` is always a DB
 * error, and the route answered "Invalid trade".
 *
 * That is worse than a wrong number. 4xx means "your request was bad, fix it
 * and try again"; the client stops retrying and asks the user to correct trade
 * data that was never wrong, while the real cause — the database — goes
 * unreported and unalerted, since 400s are ordinary traffic. Third instance of
 * this class on the branch, after MONEY-1178 (404 for a DB error) and
 * MONEY-1180 (the same on every DELETE). Now a 500.
 *
 * The 400 path that IS real — a body that fails the schema — is asserted
 * separately, so the fix cannot be mistaken for "trades never 400".
 *
 * ## Why the subscription reads are here
 *
 * They are money endpoints, and they sit next to `GET /v1/subscription/access`,
 * which deliberately does the OPPOSITE thing: it fails-to-FREE with a 200 so a
 * transient DB error cannot lock a user out of the app. That posture is correct
 * for an entitlement GATE and wrong for these two — a paying user asking what
 * plan they are on must never be quietly told "FREE" because a query failed,
 * and a payment history must never render as "no payments" for the same reason.
 * Silence is indistinguishable from "you have nothing", which on a billing
 * screen is the one answer that must never be guessed. Pinned in both
 * directions.
 *
 * Source: apps/api/src/routes/v1/trades.ts (POST /)
 *         apps/api/src/routes/v1/subscription.ts (GET /, GET /payments)
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
type ModuleCache = Record<string, { exports: unknown } | undefined>;
const cache = (require as unknown as { cache: ModuleCache }).cache;

let verifyImpl: (token: string) => Promise<{ sub?: string }>;
const clerkStub = {
  __esModule: true,
  verifyToken: (token: string) => verifyImpl(token),
};

const serviceImpls = new Map<string, (...args: unknown[]) => unknown>();
function setService(name: string, fn: (...args: unknown[]) => unknown): void {
  serviceImpls.set(name, fn);
}
/** subscription.ts imports this VALUE at load, so the Proxy must return it. */
const FREE_ACCESS_FIXTURE = {
  planId: "FREE",
  status: "none",
  canAccessAIQueries: false,
} as const;
const servicesStub = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    if (typeof prop !== "string") return undefined;
    if (prop === "__esModule") return true;
    if (prop === "then") return undefined;
    if (prop === "default") return servicesStub;
    if (prop === "DEFAULT_FREE_ACCESS") return FREE_ACCESS_FIXTURE;
    return (...args: unknown[]) => {
      const impl = serviceImpls.get(prop);
      return impl
        ? impl(...args)
        : Promise.resolve({ success: false, error: `not-stubbed:${prop}` });
    };
  },
});

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
  stub(require.resolve("@usemoney/services/preferences"), servicesStub);
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

/**
 * A body that passes TradeFormSchema. Note `quantity`/`price` are STRINGS the
 * schema coerces — sending numbers would fail validation, which is exactly the
 * kind of contract a mobile client needs pinned.
 */
const TRADE = {
  tradeDate: "2026-08-12",
  symbol: "reliance",
  quantity: "10",
  price: "1425.50",
} as const;

let createCalls: unknown[][] = [];

beforeEach(() => {
  verifyImpl = async () => ({ sub: "clerk_default" });
  serviceImpls.clear();
  createCalls = [];
  setService("resolveUserId", async () => "mongo_1");
  setService("createTrade", async (...args: unknown[]) => {
    createCalls.push(args);
    return { success: true, data: { id: "t_1" } };
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/trades
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/trades (MONEY-1091 follow-up)", () => {
  it("creates for the caller and answers 201 with the coerced body", async () => {
    const res = await app.request("/v1/trades", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(TRADE),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).data.id, "t_1");

    assert.equal(createCalls.length, 1);
    const [userId, data] = createCalls[0]! as [string, Record<string, unknown>];
    assert.equal(userId, "mongo_1");
    // The schema upper-cases the symbol and coerces the numeric strings; the
    // SERVICE sees the transformed values, not the raw body.
    assert.equal(data.symbol, "RELIANCE");
    assert.equal(data.quantity, 10);
    assert.equal(data.price, 1425.5);
    // Defaults are applied rather than left undefined.
    assert.equal(data.exchange, "NSE");
    assert.equal(data.tradeType, "BUY");
  });

  it("a DB failure is a 500, NOT a 400 (MONEY-1181)", async () => {
    // `createTrade` has exactly one failure path — the catch around the Prisma
    // write — so this can only ever be a server error. Calling it
    // VALIDATION_ERROR told the user to fix input that was already valid.
    setService("createTrade", async (...args: unknown[]) => {
      createCalls.push(args);
      return { success: false, error: "Failed to create trade" };
    });
    const res = await app.request("/v1/trades", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(TRADE),
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
    // It still reached the service — this is not a validation short-circuit.
    assert.equal(createCalls.length, 1);
  });

  it("a body that fails the schema is STILL a 400, before the service", async () => {
    // The other half of MONEY-1181: the fix must not be read as "trades never
    // 400". A genuinely invalid body is a client error and must stay one.
    const res = await app.request("/v1/trades", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...TRADE, quantity: "-5" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(createCalls.length, 0);
  });

  it("malformed JSON is a 400 BAD_REQUEST, distinct from a schema failure", async () => {
    const res = await app.request("/v1/trades", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{bad",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "BAD_REQUEST");
    assert.equal(createCalls.length, 0);
  });

  it("requires auth", async () => {
    const res = await app.request("/v1/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TRADE),
    });
    assert.equal(res.status, 401);
    assert.equal(createCalls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/subscription  +  GET /v1/subscription/payments
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: subscription reads (MONEY-1091 follow-up)", () => {
  it("GET /v1/subscription returns the caller's plan", async () => {
    let seen: unknown;
    setService("getSubscription", async (userId: unknown) => {
      seen = userId;
      return { success: true, data: { planId: "PRO", status: "active" } };
    });
    const res = await app.request("/v1/subscription", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seen, "mongo_1");
    assert.equal((await res.json()).data.planId, "PRO");
  });

  it("GET /v1/subscription FAILS LOUD — it must never degrade to FREE", async () => {
    // The sibling /subscription/access deliberately fails-to-FREE with a 200 so
    // a DB blip cannot lock a user out. That is right for an entitlement GATE
    // and wrong here: telling a paying user they are on FREE because a query
    // failed is a billing-grade lie, and a 200 gives the client no way to tell.
    setService("getSubscription", async () => ({
      success: false,
      error: "connection reset",
    }));
    const res = await app.request("/v1/subscription", { headers: AUTH });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.ok(
      !JSON.stringify(body).includes("FREE"),
      "a failed subscription read must not answer with a FREE plan",
    );
  });

  it("GET /v1/subscription/payments returns the caller's history", async () => {
    let seen: unknown;
    setService("getPaymentHistory", async (userId: unknown) => {
      seen = userId;
      return {
        success: true,
        data: [{ id: "pay_1", amount: 49900, status: "succeeded" }],
      };
    });
    const res = await app.request("/v1/subscription/payments", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(seen, "mongo_1");
    assert.equal((await res.json()).data[0].id, "pay_1");
  });

  it("no payments is a successful empty list; a failure is a 500", async () => {
    // These must not collapse into each other. "You have no payments" and "we
    // could not read your payments" look identical on a billing screen if the
    // failure returns 200 with [].
    setService("getPaymentHistory", async () => ({ success: true, data: [] }));
    const empty = await app.request("/v1/subscription/payments", {
      headers: AUTH,
    });
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).data, []);

    setService("getPaymentHistory", async () => ({
      success: false,
      error: "connection reset",
    }));
    const broken = await app.request("/v1/subscription/payments", {
      headers: AUTH,
    });
    assert.equal(broken.status, 500);
    assert.equal((await broken.json()).error.code, "INTERNAL_ERROR");
  });

  it("`/payments` resolves to the history route, not the plan route", async () => {
    let planCalled = false;
    setService("getSubscription", async () => {
      planCalled = true;
      return { success: true, data: { planId: "PRO" } };
    });
    setService("getPaymentHistory", async () => ({ success: true, data: [] }));
    const res = await app.request("/v1/subscription/payments", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(planCalled, false);
  });

  it("both subscription reads require auth", async () => {
    let called = false;
    setService("getSubscription", async () => {
      called = true;
      return { success: true, data: {} };
    });
    setService("getPaymentHistory", async () => {
      called = true;
      return { success: true, data: [] };
    });
    assert.equal((await app.request("/v1/subscription")).status, 401);
    assert.equal((await app.request("/v1/subscription/payments")).status, 401);
    assert.equal(called, false);
  });
});
