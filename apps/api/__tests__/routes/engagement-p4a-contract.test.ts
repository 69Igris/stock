/**
 * Phase C P4-A HTTP Contract Tests — engagement READ surface (MONEY-402)
 *
 * Drives the REAL Hono middleware + route handlers via `app.request(...)` for the
 * 7 read domains wired in this phase: roast, risk, tax, documents, learning,
 * credits, chat-history. Uses the SAME ESM stubbing seam as the other contract
 * suites: a CJS `require` seeded with a `@usemoney/services` Proxy (stable
 * forwarder → per-test impls) and a configurable `@clerk/backend` verifier, then
 * the apps/api/src modules are purged + re-required so their imports resolve to
 * the stub.
 *
 * Per domain: happy path, ownership/absence → 404, and (documents/learning) the
 * REFERENCE-passthrough contract (a stored storagePath/videoUrl is returned in
 * the JSON envelope — the API never proxies bytes; signed URLs are deferred).
 *
 * Source: apps/api/src/routes/v1/{roast,risk,tax,documents,learning,credits,
 *         chat-history}.ts + middleware/{auth,request-id}.ts
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

// ── roast ────────────────────────────────────────────────────────────────────

describe("Contract: GET /v1/roast", () => {
  it("returns the paginated history scoped to the caller", async () => {
    let seenUser: unknown;
    setService("getRoastHistory", async (userId: unknown) => {
      seenUser = userId;
      return { success: true, data: { items: [{ id: "r1" }], total: 1 } };
    });
    const res = await app.request("/v1/roast?page=1&limit=10", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(seenUser, "mongo_1"); // IDOR: Mongo id, not Clerk sub
    assert.deepEqual(body.data, [{ id: "r1" }]);
    assert.equal(body.meta.total, 1);
  });
});

describe("Contract: GET /v1/roast/:sessionId", () => {
  it("returns the record for an owned session", async () => {
    setService("getRoastBySessionId", async (sid: unknown, uid: unknown) => ({
      success: true,
      data: { sessionId: sid, userId: uid, score: 42 },
    }));
    const res = await app.request("/v1/roast/sess_1", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.score, 42);
  });

  it("a guessed/foreign sessionId resolves as 404 (no cross-user leak)", async () => {
    setService("getRoastBySessionId", async () => ({
      success: false,
      error: "Roast not found",
    }));
    const res = await app.request("/v1/roast/ghost", { headers: AUTH });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  });

  it("maps a code INTERNAL failure to 500, not 404 (MONEY-1062: DB error is retryable)", async () => {
    setService("getRoastBySessionId", async () => ({
      success: false,
      error: "Failed to fetch roast",
      code: "INTERNAL",
    }));
    const res = await app.request("/v1/roast/sess_db_down", { headers: AUTH });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});

// ── risk ─────────────────────────────────────────────────────────────────────

describe("Contract: GET /v1/risk", () => {
  it("returns the risk envelope on success", async () => {
    setService("getPortfolioRisk", async (uid: unknown) => ({
      success: true,
      data: { var95: 1.2, _uid: uid },
    }));
    const res = await app.request("/v1/risk", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.var95, 1.2);
    assert.equal(body.data._uid, "mongo_1");
  });

  it("maps a service failure to 500", async () => {
    setService("getPortfolioRisk", async () => ({
      success: false,
      error: "boom",
    }));
    const res = await app.request("/v1/risk", { headers: AUTH });
    assert.equal(res.status, 500);
  });
});

// ── tax ──────────────────────────────────────────────────────────────────────

describe("MONEY-1142: /v1/risk denies an unentitled plan at the HTTP boundary", () => {
  it("a FREE plan gets 403 SUBSCRIPTION_REQUIRED, and the service is NEVER called", async () => {
    // The point of the ticket: apps/web enforced the tier, apps/api did not, so
    // a FREE user with a valid Clerk JWT could curl this and receive the full
    // premium payload. Asserting the service is not reached matters as much as
    // the status — a 403 that still ran the analysis would be a data leak with
    // a polite error attached.
    let called = false;
    setService("getSubscription", async (uid: unknown) => ({
      success: true,
      data: { userId: uid, planId: "FREE" },
    }));
    setService("getPortfolioRisk", async () => {
      called = true;
      return { success: true, data: {} };
    });

    const res = await app.request("/v1/risk", { headers: AUTH });
    assert.strictEqual(res.status, 403);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.strictEqual(body.error?.code, "SUBSCRIPTION_REQUIRED");
    assert.strictEqual(called, false, "the premium service must not run");
  });

  it("an UNRESOLVABLE subscription fails CLOSED", async () => {
    // Failing open on an infra blip hands premium data to whoever asks during
    // the blip — the failure this gate exists to prevent.
    let called = false;
    setService("getSubscription", async () => ({
      success: false,
      error: "db down",
    }));
    setService("getPortfolioRisk", async () => {
      called = true;
      return { success: true, data: {} };
    });

    const res = await app.request("/v1/risk", { headers: AUTH });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(called, false);
  });
});

describe("Contract: GET /v1/tax/*", () => {
  it("forwards ?fy to the report service", async () => {
    let seenFy: unknown;
    setService("getTaxReport", async (_uid: unknown, fy: unknown) => {
      seenFy = fy;
      return { success: true, data: { fy, stcg: 100 } };
    });
    const res = await app.request("/v1/tax/report?fy=2025-26", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(seenFy, "2025-26");
    assert.equal((await res.json()).data.stcg, 100);
  });

  it("returns the paired trades for a FY", async () => {
    setService("getPairedTradesForFY", async () => ({
      success: true,
      data: [{ id: "p1" }],
    }));
    const res = await app.request("/v1/tax/trades", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, [{ id: "p1" }]);
  });

  // MONEY-1062: a malformed ?fy used to flow into tax-logic's fyStartYear,
  // where parseInt(startYear) → NaN throws RangeError → 500. Both endpoints
  // now reject it with a 400 + message BEFORE the service.
  it("rejects a malformed ?fy on /report with 400 + message (service untouched)", async () => {
    let called = false;
    setService("getTaxReport", async () => {
      called = true;
      return { success: true, data: {} };
    });
    for (const bad of ["garbage", "FY2024-25", "2024", "2024-2"]) {
      const res = await app.request(`/v1/tax/report?fy=${bad}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 400, `?fy=${bad} must 400`);
      const body = await res.json();
      assert.equal(body.error.code, "VALIDATION_ERROR");
      assert.match(body.error.message, /financial year/i);
    }
    assert.equal(called, false);
  });

  it("rejects a malformed ?fy on /trades with 400 + message (service untouched)", async () => {
    let called = false;
    setService("getPairedTradesForFY", async () => {
      called = true;
      return { success: true, data: [] };
    });
    const res = await app.request("/v1/tax/trades?fy=not-a-fy", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.match(body.error.message, /financial year/i);
    assert.equal(called, false);
  });

  it("accepts both valid FY label forms and an ABSENT fy unchanged", async () => {
    const seenFys: unknown[] = [];
    setService("getTaxReport", async (_uid: unknown, fy: unknown) => {
      seenFys.push(fy);
      return { success: true, data: {} };
    });
    // YYYY-YY, YYYY-YYYY, and absent (service defaults to the current FY).
    assert.equal(
      (await app.request("/v1/tax/report?fy=2024-25", { headers: AUTH }))
        .status,
      200,
    );
    assert.equal(
      (await app.request("/v1/tax/report?fy=2024-2025", { headers: AUTH }))
        .status,
      200,
    );
    assert.equal(
      (await app.request("/v1/tax/report", { headers: AUTH })).status,
      200,
    );
    assert.deepEqual(seenFys, ["2024-25", "2024-2025", undefined]);
  });
});

// ── documents ────────────────────────────────────────────────────────────────

describe("Contract: /v1/documents", () => {
  it("lists documents paginated and scoped to the caller", async () => {
    let seenUser: unknown;
    setService("getDocuments", async (uid: unknown) => {
      seenUser = uid;
      return { success: true, data: { documents: [{ id: "d1" }], total: 1 } };
    });
    const res = await app.request("/v1/documents?limit=10", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(seenUser, "mongo_1");
    assert.deepEqual(body.data, [{ id: "d1" }]);
    assert.equal(body.meta.total, 1);
  });

  it("detail returns the storagePath REFERENCE (never proxied bytes)", async () => {
    setService("getDocument", async (uid: unknown, id: unknown) => ({
      success: true,
      data: { id, userId: uid, storagePath: "docs/mongo_1/x.pdf", title: "X" },
    }));
    const res = await app.request("/v1/documents/d1", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.storagePath, "docs/mongo_1/x.pdf");
  });

  it("a foreign/absent document id resolves as 404", async () => {
    setService("getDocument", async () => ({
      success: false,
      error: "not found",
    }));
    const res = await app.request("/v1/documents/ghost", { headers: AUTH });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  });
});

// ── learning ─────────────────────────────────────────────────────────────────

describe("Contract: /v1/learning", () => {
  it("lists published courses", async () => {
    setService("getCourses", async () => ({
      success: true,
      data: [{ id: "c1" }],
    }));
    const res = await app.request("/v1/learning/courses", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, [{ id: "c1" }]);
  });

  it("a lesson body returns the stored videoUrl REFERENCE for an entitled plan", async () => {
    setService("getSubscription", async () => ({
      success: true,
      data: { planId: "PREMIUM", status: "ACTIVE" },
    }));
    let seenPlan: unknown;
    setService("getLessonById", async (_id: unknown, planId: unknown) => {
      seenPlan = planId;
      return { success: true, data: { id: "l1", videoUrl: "hls/l1.m3u8" } };
    });
    const res = await app.request("/v1/learning/lessons/l1", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seenPlan, "PREMIUM"); // plan threaded into the gate
    assert.equal((await res.json()).data.videoUrl, "hls/l1.m3u8");
  });

  it("fail-closed premium gate → 403 PREMIUM_REQUIRED", async () => {
    setService("getSubscription", async () => ({
      success: true,
      data: { planId: "FREE", status: "ACTIVE" },
    }));
    setService("getLessonById", async () => ({
      success: false,
      error: "premium",
      code: "PREMIUM_REQUIRED",
    }));
    const res = await app.request("/v1/learning/lessons/adv", {
      headers: AUTH,
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, "FORBIDDEN");
  });

  it("POST /progress rejects a malformed payload with 400 (never reaches the service)", async () => {
    let called = false;
    setService("updateLessonProgress", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/learning/progress", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ lessonId: "l1" }), // missing enrollmentId + completed
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("POST /progress upserts for an owned enrollment", async () => {
    let seen: unknown[] = [];
    setService("updateLessonProgress", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { completed: true } };
    });
    const res = await app.request("/v1/learning/progress", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        enrollmentId: "e1",
        lessonId: "l1",
        completed: true,
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen[0], "mongo_1"); // userId-scoped
    assert.equal(seen[1], "e1");
  });
});

// ── credits ──────────────────────────────────────────────────────────────────

describe("Contract: /v1/credits", () => {
  it("returns the balance snapshot", async () => {
    setService("getCreditBalance", async (uid: unknown) => ({
      success: true,
      data: { remaining: 5, _uid: uid },
    }));
    const res = await app.request("/v1/credits", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.remaining, 5);
    assert.equal(body.data._uid, "mongo_1");
  });

  it("usage history is paginated", async () => {
    setService("getCreditUsageHistory", async () => ({
      success: true,
      data: { items: [{ id: "u1" }], total: 1 },
    }));
    const res = await app.request("/v1/credits/usage?limit=10", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, [{ id: "u1" }]);
    assert.equal(body.meta.total, 1);
  });
});

// ── chat-history ─────────────────────────────────────────────────────────────

describe("Contract: /v1/chat-history", () => {
  it("lists sessions paginated (chats + totalCount)", async () => {
    setService("listChatHistories", async () => ({
      success: true,
      data: { chats: [{ id: "ch1" }], totalCount: 1 },
    }));
    const res = await app.request("/v1/chat-history?limit=10", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data, [{ id: "ch1" }]);
    assert.equal(body.meta.total, 1);
  });

  it("a null (foreign/absent) session id resolves as 404", async () => {
    setService("getChatHistoryById", async () => ({
      success: true,
      data: null,
    }));
    const res = await app.request("/v1/chat-history/ghost", { headers: AUTH });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  });

  it("returns an owned session's messages", async () => {
    setService("getChatHistoryById", async (uid: unknown, id: unknown) => ({
      success: true,
      data: { id, userId: uid, messages: [] },
    }));
    const res = await app.request("/v1/chat-history/ch1", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.id, "ch1");
  });

  it("DELETE a foreign/absent id resolves as 404", async () => {
    setService("deleteChatHistory", async () => ({
      success: false,
      error: "Chat history not found",
    }));
    const res = await app.request("/v1/chat-history/ghost", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(res.status, 404);
  });

  it("DELETE an owned id succeeds", async () => {
    setService("deleteChatHistory", async () => ({
      success: true,
      data: undefined,
    }));
    const res = await app.request("/v1/chat-history/ch1", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.message, "Chat history deleted");
  });
});
