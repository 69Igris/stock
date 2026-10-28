/**
 * MONEY-1062 P4b Parity HTTP Contract Tests — API Server
 *
 * Contract coverage for the NEW News & Events + Result-Feedback routes ported in
 * P4b. Drives the REAL Hono middleware + route handlers via `app.request(...)`:
 * routing, Zod validation (400 BEFORE any service call), code→status mapping
 * (INVALID_INPUT→400 / INTERNAL→500), and userId (ownership) forwarding.
 *
 * Same ESM stubbing seam as parity-p3b-contract: `require.cache` seeded with a
 * `@usemoney/services` Proxy (stable forwarder → per-test impls) + a configurable
 * `@clerk/backend` verifier, then the apps/api/src modules are purged + re-
 * required so their imports resolve to the stub. `@usemoney/validation` is NOT
 * stubbed — the routes validate against the REAL canonical
 * `SubmitResultFeedbackSchema`.
 *
 * These two families are NOT mounted in src/routes/v1/index.ts by this task
 * (that aggregator is owned separately), so the harness mounts the two route
 * modules DIRECTLY under /v1 — exactly as the aggregator will:
 *     v1Routes.route("/news", newsRoutes);
 *     v1Routes.route("/result-feedback", resultFeedbackRoutes);
 *
 * Source: apps/api/src/routes/v1/{news,result-feedback}.ts
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
  const newsRoutes = (
    require("../../src/routes/v1/news.ts") as { default: unknown }
  ).default;
  const resultFeedbackRoutes = (
    require("../../src/routes/v1/result-feedback.ts") as { default: unknown }
  ).default;

  const instance = new Hono();
  instance.use("*", requestIdMiddleware);
  instance.use("/v1/*", authMiddleware);
  instance.route("/v1/news", newsRoutes);
  instance.route("/v1/result-feedback", resultFeedbackRoutes);
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
// Auth (shared invariant)
// ════════════════════════════════════════════════════════════════════════════

describe("P4b Contract: auth", () => {
  it("401s a news request with no Authorization header", async () => {
    const res = await app.request("/v1/news/feed");
    assert.equal(res.status, 401);
  });

  it("401s a result-feedback request with no Authorization header", async () => {
    const res = await app.request("/v1/result-feedback?surface=CHAT&refIds=a");
    assert.equal(res.status, 401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/news/feed
// ════════════════════════════════════════════════════════════════════════════

describe("P4b Contract: GET /v1/news/feed", () => {
  it("forwards the resolved userId + default filter/limit undefined", async () => {
    let seenUser: unknown;
    let seenOpts: unknown;
    setService("getNewsFeed", async (userId: unknown, opts: unknown) => {
      seenUser = userId;
      seenOpts = opts;
      return { success: true, data: { articles: [{ id: "n1", link: "l1" }] } };
    });
    const res = await app.request("/v1/news/feed", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seenUser, "mongo_1"); // ownership = resolved Mongo _id
    assert.deepEqual(seenOpts, { filter: undefined, limit: undefined });
    assert.equal((await res.json()).data.articles.length, 1);
  });

  it("forwards an explicit filter + limit", async () => {
    let seenOpts: unknown;
    setService("getNewsFeed", async (_u: unknown, opts: unknown) => {
      seenOpts = opts;
      return { success: true, data: { articles: [] } };
    });
    const res = await app.request("/v1/news/feed?filter=earnings&limit=5", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seenOpts, { filter: "earnings", limit: 5 });
  });

  it("passes a large limit THROUGH (route doesn't reject; service clamps)", async () => {
    let seenOpts: { limit?: number } | undefined;
    setService("getNewsFeed", async (_u: unknown, opts: unknown) => {
      seenOpts = opts as { limit?: number };
      return { success: true, data: { articles: [] } };
    });
    const res = await app.request("/v1/news/feed?limit=999", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seenOpts?.limit, 999); // forwarded raw; getNewsFeed does min(…,50)
  });

  it("rejects an unknown filter with 400 (never calls the service)", async () => {
    let called = false;
    setService("getNewsFeed", async () => {
      called = true;
      return { success: true, data: { articles: [] } };
    });
    const res = await app.request("/v1/news/feed?filter=bogus", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("rejects a non-numeric limit with 400", async () => {
    const res = await app.request("/v1/news/feed?limit=abc", { headers: AUTH });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
  });

  it("rejects a zero/negative limit with 400 (min 1)", async () => {
    const res = await app.request("/v1/news/feed?limit=0", { headers: AUTH });
    assert.equal(res.status, 400);
  });

  it("maps a defensive service failure to 500", async () => {
    setService("getNewsFeed", async () => ({
      success: false,
      error: "boom",
    }));
    const res = await app.request("/v1/news/feed", { headers: AUTH });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/news/stock/:symbol
// ════════════════════════════════════════════════════════════════════════════

describe("P4b Contract: GET /v1/news/stock/:symbol", () => {
  it("forwards the symbol + default limit 8 (global, no userId)", async () => {
    const seen: unknown[] = [];
    setService("getStockNews", async (...args: unknown[]) => {
      seen.push(...args);
      return { success: true, data: { articles: [{ id: "s1", link: "sl1" }] } };
    });
    const res = await app.request("/v1/news/stock/RELIANCE.NS", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(seen[0], "RELIANCE.NS");
    assert.equal(seen[1], 8); // default limit
    assert.equal((await res.json()).data.articles.length, 1);
  });

  it("forwards an explicit limit", async () => {
    let seenLimit: unknown;
    setService("getStockNews", async (_s: unknown, limit: unknown) => {
      seenLimit = limit;
      return { success: true, data: { articles: [] } };
    });
    const res = await app.request("/v1/news/stock/TCS?limit=5", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(seenLimit, 5);
  });

  it("rejects a limit over 50 with 400 (bounds the take)", async () => {
    let called = false;
    setService("getStockNews", async () => {
      called = true;
      return { success: true, data: { articles: [] } };
    });
    const res = await app.request("/v1/news/stock/TCS?limit=99", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  it("the static /feed segment is NOT captured as a :symbol", async () => {
    let feedCalled = false;
    let stockCalled = false;
    setService("getNewsFeed", async () => {
      feedCalled = true;
      return { success: true, data: { articles: [] } };
    });
    setService("getStockNews", async () => {
      stockCalled = true;
      return { success: true, data: { articles: [] } };
    });
    await app.request("/v1/news/feed", { headers: AUTH });
    assert.equal(feedCalled, true);
    assert.equal(stockCalled, false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/news/pulse · /events · /daily-brief
// ════════════════════════════════════════════════════════════════════════════

describe("P4b Contract: GET /v1/news/pulse", () => {
  it("no ?symbols → getMarketPulseNews(userId, undefined)", async () => {
    const seen: unknown[] = [];
    setService("getMarketPulseNews", async (...args: unknown[]) => {
      seen.push(...args);
      return { success: true, data: { articles: [] } };
    });
    const res = await app.request("/v1/news/pulse", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seen[0], "mongo_1");
    assert.equal(seen[1], undefined);
  });

  it("?symbols=RELIANCE,TCS → forwards the parsed array", async () => {
    let seenSymbols: unknown;
    setService("getMarketPulseNews", async (_u: unknown, sy: unknown) => {
      seenSymbols = sy;
      return { success: true, data: { articles: [] } };
    });
    const res = await app.request("/v1/news/pulse?symbols=RELIANCE,%20TCS", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seenSymbols, ["RELIANCE", "TCS"]); // trimmed
  });
});

describe("P4b Contract: GET /v1/news/events", () => {
  it("calls getUpcomingEvents(userId) and returns events", async () => {
    let seenUser: unknown;
    setService("getUpcomingEvents", async (userId: unknown) => {
      seenUser = userId;
      return { success: true, data: { events: [{ date: "2026-07-12" }] } };
    });
    const res = await app.request("/v1/news/events", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seenUser, "mongo_1");
    assert.equal((await res.json()).data.events.length, 1);
  });
});

describe("P4b Contract: GET /v1/news/daily-brief", () => {
  it("calls getDailyBrief(userId); a null brief is returned as null", async () => {
    let seenUser: unknown;
    setService("getDailyBrief", async (userId: unknown) => {
      seenUser = userId;
      return { success: true, data: { brief: null } };
    });
    const res = await app.request("/v1/news/daily-brief", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seenUser, "mongo_1");
    const body = await res.json();
    assert.ok("brief" in body.data);
    assert.equal(body.data.brief, null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/result-feedback
// ════════════════════════════════════════════════════════════════════════════

describe("P4b Contract: POST /v1/result-feedback", () => {
  it("validates + forwards the parsed payload with the resolved userId", async () => {
    let seenUser: unknown;
    let seenInput: Record<string, unknown> | undefined;
    setService(
      "submitResultFeedback",
      async (userId: unknown, input: unknown) => {
        seenUser = userId;
        seenInput = input as Record<string, unknown>;
        return { success: true, data: { rating: "UP", comment: null } };
      },
    );
    const res = await app.request("/v1/result-feedback", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        surface: "CHAT",
        refId: "msg-1",
        rating: "UP",
        variantId: "arm_a1",
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(seenUser, "mongo_1");
    assert.equal(seenInput?.surface, "CHAT");
    assert.equal(seenInput?.refId, "msg-1");
    assert.equal(seenInput?.variantId, "arm_a1");
    assert.deepEqual(await res.json(), {
      success: true,
      data: { rating: "UP", comment: null },
    });
  });

  it("collapses a whitespace-only comment to undefined (schema transform)", async () => {
    let seenComment: unknown = "sentinel";
    setService("submitResultFeedback", async (_u: unknown, input: unknown) => {
      seenComment = (input as { comment?: unknown }).comment;
      return { success: true, data: { rating: "DOWN", comment: null } };
    });
    const res = await app.request("/v1/result-feedback", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        surface: "CHAT",
        refId: "msg-1",
        rating: "DOWN",
        comment: "   ",
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(seenComment, undefined);
  });

  it("400s malformed JSON (BAD_REQUEST) before any service call", async () => {
    let called = false;
    setService("submitResultFeedback", async () => {
      called = true;
      return { success: true, data: { rating: "UP", comment: null } };
    });
    const res = await app.request("/v1/result-feedback", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "BAD_REQUEST");
    assert.equal(called, false);
  });

  it("400s a missing rating (VALIDATION_ERROR)", async () => {
    let called = false;
    setService("submitResultFeedback", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/result-feedback", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ surface: "CHAT", refId: "msg-1" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("400s an unknown surface", async () => {
    const res = await app.request("/v1/result-feedback", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ surface: "MAIL", refId: "m", rating: "UP" }),
    });
    assert.equal(res.status, 400);
  });

  it("400s a variantId with illegal characters (regex guard)", async () => {
    const res = await app.request("/v1/result-feedback", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        surface: "CHAT",
        refId: "m",
        rating: "UP",
        variantId: "../etc/passwd",
      }),
    });
    assert.equal(res.status, 400);
  });

  it("maps a service write failure to 500", async () => {
    setService("submitResultFeedback", async () => ({
      success: false,
      error: "Could not save your feedback",
    }));
    const res = await app.request("/v1/result-feedback", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ surface: "CHAT", refId: "m", rating: "UP" }),
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /v1/result-feedback
// ════════════════════════════════════════════════════════════════════════════

describe("P4b Contract: DELETE /v1/result-feedback", () => {
  it("forwards (userId, surface, refId) and returns { cleared }", async () => {
    const seen: unknown[] = [];
    setService("clearResultFeedback", async (...args: unknown[]) => {
      seen.push(...args);
      return { success: true, data: { cleared: true } };
    });
    const res = await app.request(
      "/v1/result-feedback?surface=RESEARCH&refId=sess-9",
      { method: "DELETE", headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(seen.slice(0, 3), ["mongo_1", "RESEARCH", "sess-9"]);
    assert.deepEqual((await res.json()).data, { cleared: true });
  });

  it("400s a missing refId (never calls the service)", async () => {
    let called = false;
    setService("clearResultFeedback", async () => {
      called = true;
      return { success: true, data: { cleared: true } };
    });
    const res = await app.request("/v1/result-feedback?surface=CHAT", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  it("400s an unknown surface", async () => {
    const res = await app.request("/v1/result-feedback?surface=SMS&refId=x", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(res.status, 400);
  });

  it("maps the service INVALID_INPUT code to 400", async () => {
    setService("clearResultFeedback", async () => ({
      success: false,
      error: "refId is required",
      code: "INVALID_INPUT",
    }));
    const res = await app.request("/v1/result-feedback?surface=CHAT&refId=x", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
  });

  it("maps a generic service failure to 500", async () => {
    setService("clearResultFeedback", async () => ({
      success: false,
      error: "Could not clear your feedback",
    }));
    const res = await app.request("/v1/result-feedback?surface=CHAT&refId=x", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/result-feedback
// ════════════════════════════════════════════════════════════════════════════

describe("P4b Contract: GET /v1/result-feedback", () => {
  it("forwards (userId, surface, refIds[]) and returns the map", async () => {
    const seen: unknown[] = [];
    setService("getResultFeedback", async (...args: unknown[]) => {
      seen.push(...args);
      return {
        success: true,
        data: { a: { rating: "UP", comment: null } },
      };
    });
    const res = await app.request(
      "/v1/result-feedback?surface=CHAT&refIds=a,%20b,c",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.equal(seen[0], "mongo_1");
    assert.equal(seen[1], "CHAT");
    assert.deepEqual(seen[2], ["a", "b", "c"]); // trimmed
    assert.deepEqual((await res.json()).data, {
      a: { rating: "UP", comment: null },
    });
  });

  it("absent ?refIds → forwards [] (service returns {})", async () => {
    let seenRefIds: unknown = "sentinel";
    setService("getResultFeedback", async (..._a: unknown[]) => {
      seenRefIds = _a[2];
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/result-feedback?surface=CHAT", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seenRefIds, []);
    assert.deepEqual((await res.json()).data, {});
  });

  it("400s a missing surface", async () => {
    let called = false;
    setService("getResultFeedback", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/result-feedback?refIds=a", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });
});
