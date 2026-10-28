/**
 * MONEY-1062 P1b Mobile-Parity HTTP Contract Tests — API Server
 *
 * Contract coverage for the parity-wave endpoints added in P1b: roast
 * running/status/cancel/delete, learning enroll + glossary, the notifications
 * unread-count, watchlist update/reorder/batch-add, mutual-fund create/delete,
 * document delete, chat-history archive/unarchive/rename, the market
 * fund-composition read, and discover by-scheme-codes + mf-compare.
 *
 * Per endpoint: happy path (service args prove userId scoping to the resolved
 * Mongo _id), body/query validation → 400 before the service, and the
 * ServiceResult `code` mapping (NOT_FOUND → 404, INTERNAL → 500; the
 * endpoint-specific legacy status for code-less failures).
 *
 * Uses the SAME ESM stubbing seam as money1062-hardening-contract.test.ts: a
 * CJS `require` seeded with a `@usemoney/services` Proxy (stable forwarder →
 * per-test impls) and a configurable `@clerk/backend` verifier, then the
 * apps/api/src modules are purged and re-required so their
 * `import … from "@usemoney/services"` resolves to the stub.
 *
 * Source: apps/api/src/routes/v1/{roast,learning,notifications,watchlist,
 *         mutualfunds,documents,chat-history,market,discover}.ts
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
  setService("resolveUserId", async () => "mongo_1");
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/roast/running — running roasts, /running registered before /:sessionId
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/roast/running (P1b)", () => {
  it("returns the caller's running roasts (scoped) — NOT captured by /:sessionId", async () => {
    let seen: unknown[] = [];
    let bySessionCalled = false;
    setService("getRunningRoasts", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: [{ sessionId: "s1", status: "SCORING", progress: 60 }],
      };
    });
    setService("getRoastBySessionId", async () => {
      bySessionCalled = true;
      return { success: false, error: "Roast not found" };
    });

    const res = await app.request("/v1/roast/running", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1"]);
    // Route-order guard: the literal /running must never resolve as a sessionId.
    assert.equal(bySessionCalled, false);
    assert.equal((await res.json()).data[0].sessionId, "s1");
  });

  it("a service failure → 500", async () => {
    setService("getRunningRoasts", async () => ({
      success: false,
      error: "Failed to get running roasts",
    }));
    const res = await app.request("/v1/roast/running", { headers: AUTH });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/roast/:sessionId/status — (sessionId, userId) arg order + code map
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/roast/:sessionId/status (P1b)", () => {
  it("polls scoped — getRoastStatus(sessionId, userId), sessionId FIRST", async () => {
    let seen: unknown[] = [];
    setService("getRoastStatus", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { status: "SCORING", progress: 60, score: null },
      };
    });
    const res = await app.request("/v1/roast/s9/status", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["s9", "mongo_1"]);
    assert.equal((await res.json()).data.progress, 60);
  });

  it("a missing/foreign session (code-less failure) → 404; code INTERNAL → 500", async () => {
    setService("getRoastStatus", async () => ({
      success: false,
      error: "Roast not found",
    }));
    const missing = await app.request("/v1/roast/ghost/status", {
      headers: AUTH,
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    setService("getRoastStatus", async () => ({
      success: false,
      error: "Failed to get roast status",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/roast/s1/status", {
      headers: AUTH,
    });
    assert.equal(internal.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/roast/:sessionId/cancel
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/roast/:sessionId/cancel (P1b)", () => {
  it("cancels via cancelRoast(userId, sessionId) on success", async () => {
    let seen: unknown[] = [];
    setService("cancelRoast", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: undefined };
    });
    const res = await app.request("/v1/roast/s3/cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "s3"]);
  });

  it("no running roast (code-less) → 404; code INTERNAL → 500", async () => {
    setService("cancelRoast", async () => ({
      success: false,
      error: "Running roast not found",
    }));
    const missing = await app.request("/v1/roast/ghost/cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(missing.status, 404);

    setService("cancelRoast", async () => ({
      success: false,
      error: "Failed to cancel roast",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/roast/s3/cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(internal.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /v1/roast/:id
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: DELETE /v1/roast/:id (P1b)", () => {
  it("deletes via deleteRoast(userId, id) on success", async () => {
    let seen: unknown[] = [];
    setService("deleteRoast", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: undefined };
    });
    const res = await app.request("/v1/roast/r7", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "r7"]);
  });

  it("a missing/foreign roast (code-less) → 404", async () => {
    setService("deleteRoast", async () => ({
      success: false,
      error: "Roast not found",
    }));
    const res = await app.request("/v1/roast/ghost", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/learning/enroll — {courseId} zod-gated
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/learning/enroll (P1b)", () => {
  // A valid Mongo ObjectId shape (24 hex chars) — courseId is shape-gated
  // (C2#5-route), so tests use a real-looking id, not "c1".
  const COURSE_ID = "64b7f0c2a1d2e3f4a5b6c7d8";

  it("rejects malformed JSON (400 BAD_REQUEST) and {} (400 VALIDATION_ERROR) before the service", async () => {
    let called = false;
    setService("enrollInCourse", async () => {
      called = true;
      return { success: true, data: {} };
    });

    const malformed = await app.request("/v1/learning/enroll", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{not json",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_REQUEST");

    const empty = await app.request("/v1/learning/enroll", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("rejects a non-ObjectId courseId with 400 (service untouched) — C2#5", async () => {
    let called = false;
    setService("enrollInCourse", async () => {
      called = true;
      return { success: true, data: {} };
    });
    for (const bad of [
      "c1", // too short
      "not-a-mongo-object-id!!!", // 24 chars but not hex
      "64b7f0c2a1d2e3f4a5b6c7d", // 23 hex chars
      "64b7f0c2a1d2e3f4a5b6c7d8a", // 25 hex chars
    ]) {
      const res = await app.request("/v1/learning/enroll", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ courseId: bad }),
      });
      assert.equal(res.status, 400, `${bad} must 400`);
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(called, false);
  });

  it("enrolls via enrollInCourse(userId, courseId) on success (uppercase hex accepted)", async () => {
    let seen: unknown[] = [];
    setService("enrollInCourse", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { id: "e1", courseId: COURSE_ID } };
    });
    const res = await app.request("/v1/learning/enroll", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ courseId: COURSE_ID }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", COURSE_ID]);
    assert.equal((await res.json()).data.id, "e1");

    // Case-insensitive hex (the regex carries /i) — mixed case still enrolls.
    const upper = await app.request("/v1/learning/enroll", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ courseId: COURSE_ID.toUpperCase() }),
    });
    assert.equal(upper.status, 200);
  });

  it("maps a service NOT_FOUND (missing course) → 404; code-less DB error → 500", async () => {
    // The service-side course-existence check (parallel wave) emits
    // code NOT_FOUND — the route maps it to 404…
    setService("enrollInCourse", async () => ({
      success: false,
      error: "Course not found",
      code: "NOT_FOUND",
    }));
    const missing = await app.request("/v1/learning/enroll", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ courseId: COURSE_ID }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    // …and degrades to the old 500 for today's code-less catch failure.
    setService("enrollInCourse", async () => ({
      success: false,
      error: "Failed to enroll in course",
    }));
    const res = await app.request("/v1/learning/enroll", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ courseId: COURSE_ID }),
    });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/learning/glossary
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/learning/glossary (P1b)", () => {
  it("forwards ?search + clamped pagination — getGlossaryTerms(search, { skip, limit })", async () => {
    let seen: unknown[] = [];
    setService("getGlossaryTerms", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: [{ term: "SIP" }] };
    });
    const res = await app.request(
      "/v1/learning/glossary?search=sip&page=2&limit=10",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.equal(seen[0], "sip");
    assert.deepEqual(seen[1], { skip: 10, limit: 10 });
    assert.equal((await res.json()).data[0].term, "SIP");
  });

  it("a service failure → 500", async () => {
    setService("getGlossaryTerms", async () => ({
      success: false,
      error: "Failed to fetch glossary terms",
    }));
    const res = await app.request("/v1/learning/glossary", { headers: AUTH });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/notifications/unread-count
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/notifications/unread-count (P1b)", () => {
  it("returns { count } scoped to the caller", async () => {
    let seen: unknown[] = [];
    setService("getUnreadCount", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: 7 };
    });
    const res = await app.request("/v1/notifications/unread-count", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1"]);
    assert.equal((await res.json()).data.count, 7);
  });

  it("a service failure → 500", async () => {
    setService("getUnreadCount", async () => ({
      success: false,
      error: "Failed",
    }));
    const res = await app.request("/v1/notifications/unread-count", {
      headers: AUTH,
    });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /v1/watchlists/:id — partial update, ≥1 field, code-less status map
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: PATCH /v1/watchlists/:id (P1b)", () => {
  it("rejects an empty {} (no updatable field) and an over-long name with 400", async () => {
    let called = false;
    setService("updateWatchlist", async () => {
      called = true;
      return { success: true, data: undefined };
    });

    const empty = await app.request("/v1/watchlists/w1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, "VALIDATION_ERROR");

    const longName = await app.request("/v1/watchlists/w1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "x".repeat(101) }),
    });
    assert.equal(longName.status, 400);
    assert.equal(called, false);
  });

  it("updates via updateWatchlist(userId, watchlistId, data) on success", async () => {
    let seen: unknown[] = [];
    setService("updateWatchlist", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: undefined };
    });
    const res = await app.request("/v1/watchlists/w1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Momentum", description: null }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen[0], "mongo_1");
    assert.equal(seen[1], "w1");
    assert.equal((seen[2] as { name: string }).name, "Momentum");
    assert.equal((seen[2] as { description: null }).description, null);
  });

  it("'Watchlist not found' → 404; a rename name-conflict → 400; code INTERNAL → 500", async () => {
    setService("updateWatchlist", async () => ({
      success: false,
      error: "Watchlist not found",
    }));
    const missing = await app.request("/v1/watchlists/ghost", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "X" }),
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    setService("updateWatchlist", async () => ({
      success: false,
      error: "A watchlist with this name already exists",
    }));
    const conflict = await app.request("/v1/watchlists/w1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Taken" }),
    });
    assert.equal(conflict.status, 400);
    assert.equal((await conflict.json()).error.code, "VALIDATION_ERROR");

    setService("updateWatchlist", async () => ({
      success: false,
      error: "Failed to update watchlist",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/watchlists/w1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "X" }),
    });
    assert.equal(internal.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/watchlists/:id/reorder
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/watchlists/:id/reorder (P1b)", () => {
  it("rejects a missing/empty itemIds array with 400 (service untouched)", async () => {
    let called = false;
    setService("reorderWatchlistItems", async () => {
      called = true;
      return { success: true, data: undefined };
    });
    for (const body of [{}, { itemIds: [] }, { itemIds: "a,b" }]) {
      const res = await app.request("/v1/watchlists/w1/reorder", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `${JSON.stringify(body)} must 400`);
    }
    assert.equal(called, false);
  });

  it("reorders via reorderWatchlistItems(userId, { watchlistId, itemIds })", async () => {
    let seen: unknown[] = [];
    setService("reorderWatchlistItems", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: undefined };
    });
    const res = await app.request("/v1/watchlists/w1/reorder", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ itemIds: ["i2", "i1"] }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen[0], "mongo_1");
    assert.deepEqual(seen[1], { watchlistId: "w1", itemIds: ["i2", "i1"] });
  });

  it("a foreign/missing watchlist → 404", async () => {
    setService("reorderWatchlistItems", async () => ({
      success: false,
      error: "Watchlist not found",
    }));
    const res = await app.request("/v1/watchlists/ghost/reorder", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ itemIds: ["i1"] }),
    });
    assert.equal(res.status, 404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/watchlists/:id/items/batch — exchange default + 100-item cap
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/watchlists/:id/items/batch (P1b)", () => {
  it("rejects empty items, a missing symbol, and >100 items with 400", async () => {
    let called = false;
    setService("batchAddWatchlistItems", async () => {
      called = true;
      return { success: true, data: { addedCount: 0 } };
    });
    const over = Array.from({ length: 101 }, (_, i) => ({ symbol: `S${i}` }));
    for (const body of [
      { items: [] },
      { items: [{ exchange: "NSE" }] },
      { items: over },
    ]) {
      const res = await app.request("/v1/watchlists/w1/items/batch", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
    }
    assert.equal(called, false);
  });

  it("batch-adds with exchange defaulted to NSE → 201 { addedCount }", async () => {
    let seen: unknown[] = [];
    setService("batchAddWatchlistItems", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { addedCount: 2 } };
    });
    const res = await app.request("/v1/watchlists/w1/items/batch", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        items: [{ symbol: "TCS" }, { symbol: "INFY", exchange: "BSE" }],
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(seen[0], "mongo_1");
    const payload = seen[1] as {
      watchlistId: string;
      items: Array<{ symbol: string; exchange: string }>;
    };
    assert.equal(payload.watchlistId, "w1");
    assert.equal(payload.items[0]!.exchange, "NSE"); // defaulted
    assert.equal(payload.items[1]!.exchange, "BSE"); // caller value kept
    assert.equal((await res.json()).data.addedCount, 2);
  });

  it("a foreign/missing watchlist → 404", async () => {
    setService("batchAddWatchlistItems", async () => ({
      success: false,
      error: "Watchlist not found",
    }));
    const res = await app.request("/v1/watchlists/ghost/items/batch", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ items: [{ symbol: "TCS" }] }),
    });
    assert.equal(res.status, 404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/mutualfunds — MutualFundFormSchema (the web action's exact schema)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/mutualfunds (P1b)", () => {
  it("rejects {}, STRING units, and a non-finite averageNav (1e999) with 400", async () => {
    let called = false;
    setService("createMutualFund", async () => {
      called = true;
      return { success: true, data: {} };
    });

    const empty = await app.request("/v1/mutualfunds", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, "VALIDATION_ERROR");

    const stringUnits = await app.request("/v1/mutualfunds", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        schemeName: "Parag Parikh Flexi Cap",
        units: "100",
        averageNav: 60,
      }),
    });
    assert.equal(stringUnits.status, 400);

    // JSON.parse("1e999") === Infinity — the .finite() guard closes it.
    const nonFinite = await app.request("/v1/mutualfunds", {
      method: "POST",
      headers: JSON_HEADERS,
      body: '{"schemeName":"PPFC","units":100,"averageNav":1e999}',
    });
    assert.equal(nonFinite.status, 400);
    assert.equal(called, false);
  });

  it("creates via createMutualFund(userId, parsed) with the schema defaults → 201", async () => {
    let seen: unknown[] = [];
    setService("createMutualFund", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { id: "mf_1", schemeName: "PPFC" } };
    });
    const res = await app.request("/v1/mutualfunds", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        schemeName: "PPFC",
        units: 100,
        averageNav: 60.5,
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(seen[0], "mongo_1");
    const data = seen[1] as {
      schemeName: string;
      units: number;
      category: string;
      brokerName: string;
      sipActive: boolean;
    };
    assert.equal(data.schemeName, "PPFC");
    assert.equal(data.units, 100);
    // The web action's schema defaults survive the REST path too.
    assert.equal(data.category, "Equity");
    assert.equal(data.brokerName, "manual");
    assert.equal(data.sipActive, false);
    assert.equal((await res.json()).data.id, "mf_1");
  });

  it("a service failure (DB error, code-less) → 500", async () => {
    setService("createMutualFund", async () => ({
      success: false,
      error: "Failed to create mutual fund",
    }));
    const res = await app.request("/v1/mutualfunds", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ schemeName: "PPFC", units: 1, averageNav: 1 }),
    });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /v1/mutualfunds/:id — manual-only delete, not-found vs refusal
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: DELETE /v1/mutualfunds/:id (P1b)", () => {
  it("deletes via deleteMutualFund(userId, fundId) on success", async () => {
    let seen: unknown[] = [];
    setService("deleteMutualFund", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: undefined };
    });
    const res = await app.request("/v1/mutualfunds/mf_9", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "mf_9"]);
  });

  it("missing/foreign fund → 404 (both service not-found legs); broker-synced refusal → 400", async () => {
    setService("deleteMutualFund", async () => ({
      success: false,
      error: "Mutual fund not found",
    }));
    const missing = await app.request("/v1/mutualfunds/ghost", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(missing.status, 404);

    setService("deleteMutualFund", async () => ({
      success: false,
      error: "Mutual fund not found or already deleted",
    }));
    const raced = await app.request("/v1/mutualfunds/mf_1", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(raced.status, 404);

    setService("deleteMutualFund", async () => ({
      success: false,
      error:
        "Cannot delete broker-synced mutual funds. Only manual entries can be deleted.",
    }));
    const refusal = await app.request("/v1/mutualfunds/mf_2", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(refusal.status, 400);
    assert.equal((await refusal.json()).error.code, "VALIDATION_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /v1/documents/:id — IDOR-safe soft delete
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: DELETE /v1/documents/:id (P1b)", () => {
  it("soft-deletes via deleteDocument(userId, id) on success", async () => {
    let seen: unknown[] = [];
    setService("deleteDocument", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: undefined, message: "Document deleted" };
    });
    const res = await app.request("/v1/documents/d4", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "d4"]);
  });

  it("missing/foreign/already-deleted (code-less) → 404; code INTERNAL → 500", async () => {
    setService("deleteDocument", async () => ({
      success: false,
      error: "Document not found",
    }));
    const missing = await app.request("/v1/documents/ghost", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    setService("deleteDocument", async () => ({
      success: false,
      error: "Failed to delete document",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/documents/d4", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(internal.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /v1/chat-history/:id/archive + /:id/unarchive + rename
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: PATCH /v1/chat-history/:id/archive|unarchive (P1b)", () => {
  it("archives via archiveChatHistory(userId, chatId) — rename NOT invoked", async () => {
    let seen: unknown[] = [];
    let renameCalled = false;
    setService("archiveChatHistory", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: undefined };
    });
    setService("renameChatHistory", async () => {
      renameCalled = true;
      return { success: true, data: undefined };
    });
    const res = await app.request("/v1/chat-history/c1/archive", {
      method: "PATCH",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "c1"]);
    // /:id/archive must never fall through to the single-segment rename route.
    assert.equal(renameCalled, false);
  });

  it("unarchives via unarchiveChatHistory(userId, chatId)", async () => {
    let seen: unknown[] = [];
    setService("unarchiveChatHistory", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: undefined };
    });
    const res = await app.request("/v1/chat-history/c2/unarchive", {
      method: "PATCH",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "c2"]);
  });

  it("a foreign/missing chat → 404 on both", async () => {
    setService("archiveChatHistory", async () => ({
      success: false,
      error: "Chat history not found",
    }));
    setService("unarchiveChatHistory", async () => ({
      success: false,
      error: "Chat history not found",
    }));
    const a = await app.request("/v1/chat-history/ghost/archive", {
      method: "PATCH",
      headers: AUTH,
    });
    assert.equal(a.status, 404);
    const u = await app.request("/v1/chat-history/ghost/unarchive", {
      method: "PATCH",
      headers: AUTH,
    });
    assert.equal(u.status, 404);
  });
});

describe("Contract: PATCH /v1/chat-history/:id rename (P1b)", () => {
  it("rejects {} and a >200-char title with 400 (service untouched)", async () => {
    let called = false;
    setService("renameChatHistory", async () => {
      called = true;
      return { success: true, data: undefined };
    });

    const empty = await app.request("/v1/chat-history/c1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, "VALIDATION_ERROR");

    const long = await app.request("/v1/chat-history/c1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "x".repeat(201) }),
    });
    assert.equal(long.status, 400);
    assert.equal(called, false);
  });

  it("renames via renameChatHistory(userId, chatId, title)", async () => {
    let seen: unknown[] = [];
    setService("renameChatHistory", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: undefined };
    });
    const res = await app.request("/v1/chat-history/c1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "Retirement plan chat" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "c1", "Retirement plan chat"]);
  });

  it("a foreign/missing chat → 404", async () => {
    setService("renameChatHistory", async () => ({
      success: false,
      error: "Chat history not found",
    }));
    const res = await app.request("/v1/chat-history/ghost", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: "X" }),
    });
    assert.equal(res.status, 404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/market/fund-composition — read path only (no extract trigger)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/market/fund-composition (P1b)", () => {
  it("rejects missing params and a bad fundType with 400 (service untouched)", async () => {
    let called = false;
    setService("getFundComposition", async () => {
      called = true;
      return { success: true, data: null };
    });

    const missing = await app.request("/v1/market/fund-composition", {
      headers: AUTH,
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, "VALIDATION_ERROR");

    const badType = await app.request(
      "/v1/market/fund-composition?fundType=STOCK&fundId=X",
      { headers: AUTH },
    );
    assert.equal(badType.status, 400);
    assert.equal(called, false);
  });

  it("reads via getFundComposition(fundType, fundId) — global, no userId", async () => {
    let seen: unknown[] = [];
    setService("getFundComposition", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { fundType: "MF", holdings: [], coveragePercent: 0 },
      };
    });
    const res = await app.request(
      "/v1/market/fund-composition?fundType=MF&fundId=119551",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["MF", "119551"]);
    assert.equal((await res.json()).data.fundType, "MF");
  });

  it("not-yet-extracted (data: null) → 404; service failure → 500", async () => {
    setService("getFundComposition", async () => ({
      success: true,
      data: null,
    }));
    const missing = await app.request(
      "/v1/market/fund-composition?fundType=MF&fundId=1",
      { headers: AUTH },
    );
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    setService("getFundComposition", async () => ({
      success: false,
      error: "Failed to load composition data",
    }));
    const failed = await app.request(
      "/v1/market/fund-composition?fundType=MF&fundId=1",
      { headers: AUTH },
    );
    assert.equal(failed.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/mfs/by-scheme-codes — bounded batch lookup
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/discover/mfs/by-scheme-codes (P1b)", () => {
  it("rejects missing, non-numeric, and >50 codes with 400 (service untouched)", async () => {
    let called = false;
    setService("getMfsBySchemeCodes", async () => {
      called = true;
      return { success: true, data: [] };
    });

    const missing = await app.request("/v1/discover/mfs/by-scheme-codes", {
      headers: AUTH,
    });
    assert.equal(missing.status, 400);

    const alpha = await app.request(
      "/v1/discover/mfs/by-scheme-codes?codes=abc",
      { headers: AUTH },
    );
    assert.equal(alpha.status, 400);

    const over = Array.from({ length: 51 }, (_, i) => `${i + 1}`).join(",");
    const tooMany = await app.request(
      `/v1/discover/mfs/by-scheme-codes?codes=${over}`,
      { headers: AUTH },
    );
    assert.equal(tooMany.status, 400);
    assert.equal(called, false);
  });

  it("fetches via getMfsBySchemeCodes(codes) — the literal path is not captured by /mfs", async () => {
    let seen: unknown[] = [];
    let categoryCalled = false;
    setService("getMfsBySchemeCodes", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: [{ schemeCode: "120503" }] };
    });
    setService("getMfDiscoverData", async () => {
      categoryCalled = true;
      return { success: true, data: {} };
    });
    const res = await app.request(
      "/v1/discover/mfs/by-scheme-codes?codes=120503,119551",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [["120503", "119551"]]);
    assert.equal(categoryCalled, false);
    assert.equal((await res.json()).data[0].schemeCode, "120503");
  });

  it("a service failure → 500", async () => {
    setService("getMfsBySchemeCodes", async () => ({
      success: false,
      error: "Failed to fetch mutual funds",
    }));
    const res = await app.request(
      "/v1/discover/mfs/by-scheme-codes?codes=120503",
      { headers: AUTH },
    );
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/mf-compare — 2-5 TYPE:id pairs → getComparisonData
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/discover/mf-compare (P1b)", () => {
  it("rejects missing funds, 1 entry, 6 entries, and a bad type with 400", async () => {
    let called = false;
    setService("getComparisonData", async () => {
      called = true;
      return { success: true, data: {} };
    });

    for (const qs of [
      "", // missing
      "?funds=MF:120503", // only 1
      `?funds=${Array.from({ length: 6 }, (_, i) => `MF:${i + 1}`).join(",")}`, // 6
      "?funds=MF:120503,CRYPTO:BTC", // bad type
      "?funds=MF:120503,ETF:", // empty id
    ]) {
      const res = await app.request(`/v1/discover/mf-compare${qs}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 400, `"${qs}" must 400`);
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(called, false);
  });

  it("compares via getComparisonData([{type,id},…]) mapped from TYPE:id pairs", async () => {
    let seen: unknown[] = [];
    setService("getComparisonData", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: {
          funds: [],
          navHistory: {},
          compositions: {},
          normalizedSeries: [],
        },
      };
    });
    const res = await app.request(
      "/v1/discover/mf-compare?funds=MF:120503,ETF:NIFTYBEES,STOCK:RELIANCE",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [
      [
        { type: "MF", id: "120503" },
        { type: "ETF", id: "NIFTYBEES" },
        { type: "STOCK", id: "RELIANCE" },
      ],
    ]);
    assert.ok(Array.isArray((await res.json()).data.normalizedSeries));
  });

  it("a service failure → 500", async () => {
    setService("getComparisonData", async () => ({
      success: false,
      error: "Failed to fetch comparison data",
    }));
    const res = await app.request("/v1/discover/mf-compare?funds=MF:1,MF:2", {
      headers: AUTH,
    });
    assert.equal(res.status, 500);
  });
});
