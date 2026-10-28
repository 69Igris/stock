/**
 * V1 HTTP Contract Tests — API Server (P1.8)
 *
 * The FIRST handler-level (HTTP) tests for apps/api. They drive the REAL Hono
 * middleware + route handlers via `app.request(...)`, asserting the wire
 * contract end-to-end: status codes, response envelopes, and the auth →
 * userId-resolution → handler flow.
 *
 * ── Stubbing seam (READ THIS before copying the pattern) ────────────────────
 * apps/api is an ESM package (`"type": "module"`). The apps/web `require.cache`
 * injection ONLY takes effect for modules loaded via CJS `require()` — an ESM
 * `import()` bypasses `require.cache` entirely (verified). So we:
 *   1. get a CJS `require` via `createRequire(import.meta.url)`,
 *   2. seed `require.cache` with stubs for `@usemoney/services` (a Proxy whose
 *      exports forward to a per-test config) and `@clerk/backend` (a
 *      configurable `verifyToken`),
 *   3. purge the `apps/api/src` modules and load the REAL middleware + routes
 *      via `require()` so their internal `import … from "@usemoney/services"`
 *      resolves to the stub.
 * The stub is a STABLE forwarder (dispatches to the live config at CALL time),
 * so a route that captured the export at load still sees per-test overrides.
 *
 * The harness mounts the middleware exactly as `app.ts` wires the /v1 stack
 * (requestId → auth → v1 routes); the tRPC mount + CORS/logger wrappers are out
 * of scope here (covered by app.test.ts / trpc.test.ts).
 *
 * Source: apps/api/src/middleware/auth.ts + request-id.ts
 *         apps/api/src/routes/v1/{index,jobs,watchlist}.ts
 *         packages/api-utils/src/{request,pagination}
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { decodeCursor } from "@usemoney/api-utils/pagination";

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
    if (prop === "then") return undefined; // never thenable
    if (prop === "default") return servicesStub;
    // Stable forwarder → dispatches to the live per-test impl.
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
  // Purge apps/api/src so the middleware + routes re-require with the stubs.
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
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => {
  // Sensible defaults; each test overrides what it exercises.
  verifyImpl = async () => ({ sub: "clerk_default" });
  serviceImpls.clear();
  setService("resolveUserId", async () => "mongo_default");
});

// ════════════════════════════════════════════════════════════════════════════
// Auth middleware (P1.1)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: auth middleware", () => {
  it("rejects a missing Authorization header with 401", async () => {
    const res = await app.request("/v1/me");
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "UNAUTHORIZED");
  });

  it("rejects an invalid/expired token with 401 (verifier throws)", async () => {
    verifyImpl = async () => {
      throw new Error("token expired");
    };
    const res = await app.request("/v1/me", { headers: AUTH });
    assert.equal(res.status, 401);
    const body = await res.json();
    // Internal verifier error must NEVER leak.
    assert.equal(body.error.message, "Invalid or expired token");
  });

  it("rejects a verified token with no matching DB user (resolveUserId → null) with 401", async () => {
    verifyImpl = async () => ({ sub: "clerk_ghost" });
    setService("resolveUserId", async () => null);
    const res = await app.request("/v1/me", { headers: AUTH });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "UNAUTHORIZED");
    assert.equal(body.error.message, "User not found");
  });

  it("resolves the Clerk subject to the Mongo _id ONCE and hands it to the handler", async () => {
    verifyImpl = async () => ({ sub: "clerk_1" });
    let resolverArg: unknown;
    setService("resolveUserId", async (clerkId: unknown) => {
      resolverArg = clerkId;
      return clerkId === "clerk_1" ? "mongo_1" : null;
    });
    let handlerUserId: unknown;
    setService("getUserProfile", async (userId: unknown) => {
      handlerUserId = userId;
      return {
        success: true,
        data: { id: userId, email: "a@b.com", name: "A" },
      };
    });
    setService("getSubscription", async () => ({ success: false, error: "x" }));

    const res = await app.request("/v1/me", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(resolverArg, "clerk_1"); // resolver called with the Clerk sub
    assert.equal(handlerUserId, "mongo_1"); // handler received the Mongo _id
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Request-id middleware (P1.3)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: X-Request-Id", () => {
  it("sets a UUID X-Request-Id header on responses (even on a 401)", async () => {
    const res = await app.request("/v1/me"); // no auth → 401, but requestId runs first
    assert.match(res.headers.get("X-Request-Id") ?? "", UUID_RE);
  });

  it("uses a distinct request id per request", async () => {
    const a = await app.request("/v1/me");
    const b = await app.request("/v1/me");
    assert.notEqual(
      a.headers.get("X-Request-Id"),
      b.headers.get("X-Request-Id"),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// /v1/me (P1.4)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/me", () => {
  it("returns the composed profile (user + subscription tier)", async () => {
    verifyImpl = async () => ({ sub: "clerk_1" });
    setService("resolveUserId", async () => "mongo_1");
    setService("getUserProfile", async () => ({
      success: true,
      data: {
        id: "mongo_1",
        email: "a@b.com",
        name: "Ada",
        preferredCurrency: "INR",
      },
    }));
    setService("getSubscription", async () => ({
      success: true,
      data: { planId: "PREMIUM", status: "ACTIVE" },
    }));

    const res = await app.request("/v1/me", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.id, "mongo_1");
    assert.equal(body.data.email, "a@b.com");
    assert.equal(body.data.preferredCurrency, "INR");
    assert.equal(body.data.plan, "PREMIUM");
    assert.equal(body.data.subscriptionStatus, "ACTIVE");
    assert.equal(body.data.clerkUserId, "clerk_1");
  });

  it("returns 404 when the profile read fails", async () => {
    setService("resolveUserId", async () => "mongo_1");
    setService("getUserProfile", async () => ({
      success: false,
      error: "User not found",
    }));
    const res = await app.request("/v1/me", { headers: AUTH });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "NOT_FOUND");
  });

  it("maps a code INTERNAL profile failure to 500, not 404 (MONEY-1062: DB error ≠ missing user)", async () => {
    setService("resolveUserId", async () => "mongo_1");
    setService("getUserProfile", async () => ({
      success: false,
      error: "Failed to fetch profile",
      code: "INTERNAL",
    }));
    const res = await app.request("/v1/me", { headers: AUTH });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, "INTERNAL_ERROR");
  });

  it("still returns the profile when the subscription read fails (best-effort)", async () => {
    setService("resolveUserId", async () => "mongo_1");
    setService("getUserProfile", async () => ({
      success: true,
      data: { id: "mongo_1", email: "a@b.com", name: "A" },
    }));
    setService("getSubscription", async () => ({ success: false, error: "x" }));
    const res = await app.request("/v1/me", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.plan, null);
    assert.equal(body.data.subscriptionStatus, null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// /v1/jobs/:jobId (P1.5)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/jobs/:jobId", () => {
  it("returns the status for a job the caller owns", async () => {
    setService("resolveUserId", async () => "mongo_1");
    let seen: unknown[] = [];
    setService("getJobStatus", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { jobId: "job_123", status: "COMPLETED", progress: 100 },
      };
    });
    const res = await app.request("/v1/jobs/job_123", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.jobId, "job_123");
    // Service scoped to (Mongo userId, jobId).
    assert.deepEqual(seen, ["mongo_1", "job_123"]);
  });

  it("returns 404 for a job that is not owned / not found (no cross-user leak)", async () => {
    setService("resolveUserId", async () => "mongo_1");
    setService("getJobStatus", async () => ({
      success: false,
      error: "Job not found",
    }));
    const res = await app.request("/v1/jobs/someone_elses_job", {
      headers: AUTH,
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "NOT_FOUND");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// safeJson malformed-body guard (P1.6)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: malformed JSON body → 400 (not 500)", () => {
  it("returns 400 BAD_REQUEST for an unparseable POST body", async () => {
    setService("resolveUserId", async () => "mongo_1");
    let serviceCalled = false;
    setService("createWatchlist", async () => {
      serviceCalled = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/watchlists", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: "{ this is not valid json ",
    });
    assert.equal(res.status, 400); // crucially NOT 500
    const body = await res.json();
    assert.equal(body.error.code, "BAD_REQUEST");
    assert.equal(serviceCalled, false); // never reached the service
  });

  it("accepts a well-formed body (201)", async () => {
    setService("resolveUserId", async () => "mongo_1");
    setService("createWatchlist", async (_uid: unknown, data: unknown) => ({
      success: true,
      data: { id: "wl_1", ...(data as object) },
    }));
    const res = await app.request("/v1/watchlists", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Tech" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.name, "Tech");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Watchlist body validation (MONEY-1062: zod-gated 400s, service untouched)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/watchlists body validation (MONEY-1062)", () => {
  const JSON_HEADERS = { ...AUTH, "Content-Type": "application/json" } as const;

  it("rejects an empty {} body with 400 VALIDATION_ERROR (name required, never reaches the service)", async () => {
    let called = false;
    setService("createWatchlist", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/watchlists", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    // Pre-gate, { name: undefined } flowed into the service's findFirst where
    // Prisma DROPS undefined → matched ANY watchlist (bogus "already exists").
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("rejects an empty / whitespace-only name with 400 (trimmed min-1)", async () => {
    let called = false;
    setService("createWatchlist", async () => {
      called = true;
      return { success: true, data: {} };
    });
    for (const bad of ["", "   "]) {
      const res = await app.request("/v1/watchlists", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: bad }),
      });
      assert.equal(res.status, 400, `name ${JSON.stringify(bad)} must 400`);
    }
    assert.equal(called, false);
  });

  it("rejects an over-long name (101 chars > max 100) with 400", async () => {
    let called = false;
    setService("createWatchlist", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/watchlists", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "x".repeat(101) }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });
});

describe("Contract: POST /v1/watchlists/:id/items validation (MONEY-1062)", () => {
  const JSON_HEADERS = { ...AUTH, "Content-Type": "application/json" } as const;

  it("rejects a missing symbol ({}) with 400 (service untouched)", async () => {
    let called = false;
    setService("addWatchlistItem", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/watchlists/wl_1/items", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("rejects an empty symbol with 400", async () => {
    let called = false;
    setService("addWatchlistItem", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/watchlists/wl_1/items", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ symbol: "" }),
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  it("a valid symbol reaches the service (201) with exchange defaulted to NSE", async () => {
    let seen: unknown;
    setService("addWatchlistItem", async (_uid: unknown, data: unknown) => {
      seen = data;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/watchlists/wl_1/items", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ symbol: "RELIANCE" }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(seen, {
      watchlistId: "wl_1",
      symbol: "RELIANCE",
      exchange: "NSE",
      instrumentId: undefined,
    });
  });

  it("maps a code NOT_FOUND add-item failure (foreign watchlist) to 404", async () => {
    setService("addWatchlistItem", async () => ({
      success: false,
      error: "Watchlist not found",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/watchlists/ghost/items", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ symbol: "TCS" }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Cursor pagination round-trip (P1.7)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: cursor pagination (GET /v1/watchlists)", () => {
  const three = [
    { id: "w1", name: "One" },
    { id: "w2", name: "Two" },
    { id: "w3", name: "Three" },
  ];

  beforeEach(() => {
    setService("resolveUserId", async () => "mongo_1");
    setService("getWatchlists", async () => ({ success: true, data: three }));
  });

  it("returns a bounded first page with an opaque nextCursor", async () => {
    const res = await app.request("/v1/watchlists?limit=2", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.items.length, 2);
    assert.deepEqual(
      body.data.items.map((w: { id: string }) => w.id),
      ["w1", "w2"],
    );
    assert.equal(typeof body.data.nextCursor, "string");
    // Opaque cursor decodes to the last item's keyset.
    assert.deepEqual(decodeCursor(body.data.nextCursor), { id: "w2" });
  });

  it("round-trips the nextCursor to the final page (nextCursor → null)", async () => {
    const page1 = await (
      await app.request("/v1/watchlists?limit=2", { headers: AUTH })
    ).json();
    const cursor = encodeURIComponent(page1.data.nextCursor);
    const res = await app.request(`/v1/watchlists?limit=2&cursor=${cursor}`, {
      headers: AUTH,
    });
    const body = await res.json();
    assert.deepEqual(
      body.data.items.map((w: { id: string }) => w.id),
      ["w3"],
    );
    assert.equal(body.data.nextCursor, null); // last page
  });

  it("treats a garbage cursor as the first page", async () => {
    const res = await app.request("/v1/watchlists?limit=2&cursor=%%%bogus", {
      headers: AUTH,
    });
    const body = await res.json();
    assert.deepEqual(
      body.data.items.map((w: { id: string }) => w.id),
      ["w1", "w2"],
    );
  });
});
