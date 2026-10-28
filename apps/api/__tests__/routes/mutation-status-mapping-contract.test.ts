/**
 * Chat-history, alert and strategy mutations — status mapping CONTRACT
 * (MONEY-1183, first two slices of the audit).
 *
 * Eight handlers that answered 404 for a database failure:
 *
 *   DELETE /v1/chat-history/:id
 *   PATCH  /v1/chat-history/:id
 *   PATCH  /v1/chat-history/:id/archive
 *   PATCH  /v1/chat-history/:id/unarchive
 *   DELETE /v1/alerts/:id
 *   PATCH  /v1/alerts/:id
 *   DELETE /v1/strategies/:id
 *   PATCH  /v1/strategies/:id
 *
 * Same defect as MONEY-1178 / MONEY-1180 / MONEY-1181: a service collapses "no
 * such row" and "the database failed" into one `success: false`, and the route
 * picks a client-error status for both. 404 tells the caller the row is gone
 * and retrying is pointless, so a transient blip is terminal — the chat stays
 * undeleted, the alert stays, and nothing alerts, because 404s are ordinary
 * traffic while 5xx is what monitoring watches.
 *
 * ## FOUR of the eight needed NO service change
 *
 * Worth stating plainly, because it is the more interesting half. All four
 * chat-history services — `deleteChatHistory`, `archiveChatHistory`,
 * `unarchiveChatHistory` and `renameChatHistory` — ALREADY returned
 * `code: "INTERNAL"` from their catch blocks, added by MONEY-1062 with a
 * comment reading "code so routes map a DB blip to 500, not 404". The services
 * had done their part; not one route ever read the field.
 *
 * A fix that lands on one side of a seam looks complete in review, passes every
 * service test, and changes nothing in production. That is exactly why the
 * MONEY-1182 guard checks the ROUTE rather than trusting the service — and why
 * `serviceAlreadyCoded` is carried in the table below and asserted, rather than
 * left as a comment.
 *
 * The alert and strategy services did need tagging; `code` is optional on
 * `ServiceResult`, so that is additive and no other caller changes.
 *
 * ## Shape
 *
 * Driven from one table, like `delete-endpoints-contract.test.ts` (MONEY-1180),
 * because the invariant is identical across all eight and a new mutation that
 * copies the old shape should stand out against its siblings. The URL AND
 * `method` literals live inside each `app.request(...)` call deliberately — the
 * coverage guard reads the path from the literal at the call site and the
 * method from the text right after it, so hoisting either would drive these
 * endpoints while reporting them as uncovered.
 *
 * NOTE for whoever merges this alongside `test/MONEY-1091`: that branch adds
 * `delete-endpoints-contract.test.ts` with the same table shape for a different
 * five endpoints, and its MONEY-1182 guard lists all eight of these in
 * KNOWN_BLIND. When both land, those entries must be removed or the guard's
 * stale-entry case fails — which is the guard working. Worth consolidating the
 * two tables into one mutation-status table afterwards.
 *
 * Source: apps/api/src/routes/v1/{chat-history,alerts,strategies}.ts
 *         packages/services/src/{chat-history,alerts,strategies}.service.ts
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

/** Args the service was called with, or undefined if it was never reached. */
let callArgs: unknown[] | undefined;

const MUTATIONS = [
  {
    endpoint: "DELETE /v1/chat-history/:id",
    service: "deleteChatHistory",
    expectedArgs: ["mongo_1", "ch_1"],
    serviceAlreadyCoded: true,
    call: (headers?: HeadersInit) =>
      app.request("/v1/chat-history/ch_1", { method: "DELETE", headers }),
  },
  {
    endpoint: "PATCH /v1/chat-history/:id/archive",
    service: "archiveChatHistory",
    expectedArgs: ["mongo_1", "ch_1"],
    serviceAlreadyCoded: true,
    call: (headers?: HeadersInit) =>
      app.request("/v1/chat-history/ch_1/archive", {
        method: "PATCH",
        headers,
      }),
  },
  {
    endpoint: "PATCH /v1/chat-history/:id/unarchive",
    service: "unarchiveChatHistory",
    expectedArgs: ["mongo_1", "ch_1"],
    serviceAlreadyCoded: true,
    call: (headers?: HeadersInit) =>
      app.request("/v1/chat-history/ch_1/unarchive", {
        method: "PATCH",
        headers,
      }),
  },
  {
    endpoint: "DELETE /v1/alerts/:id",
    service: "deleteAlert",
    expectedArgs: ["mongo_1", "al_1"],
    serviceAlreadyCoded: false,
    call: (headers?: HeadersInit) =>
      app.request("/v1/alerts/al_1", { method: "DELETE", headers }),
  },
  {
    endpoint: "DELETE /v1/strategies/:id",
    service: "deleteStrategy",
    expectedArgs: ["mongo_1", "st_1"],
    serviceAlreadyCoded: false,
    call: (headers?: HeadersInit) =>
      app.request("/v1/strategies/st_1", { method: "DELETE", headers }),
  },
  // ── the PATCH siblings (MONEY-1183, second slice) ────────────────────────
  // Bodies are supplied because these validate before reaching the service;
  // the mapping under test is the one AFTER validation passes.
  {
    endpoint: "PATCH /v1/chat-history/:id",
    service: "renameChatHistory",
    expectedArgs: ["mongo_1", "ch_1", "Renamed"],
    serviceAlreadyCoded: true,
    call: (headers?: HeadersInit) =>
      app.request("/v1/chat-history/ch_1", {
        method: "PATCH",
        headers: { ...(headers ?? {}), "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Renamed" }),
      }),
  },
  {
    endpoint: "PATCH /v1/alerts/:id",
    service: "updateAlert",
    expectedArgs: null,
    serviceAlreadyCoded: false,
    call: (headers?: HeadersInit) =>
      app.request("/v1/alerts/al_1", {
        method: "PATCH",
        headers: { ...(headers ?? {}), "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      }),
  },
  {
    endpoint: "PATCH /v1/strategies/:id",
    service: "updateStrategy",
    expectedArgs: null,
    serviceAlreadyCoded: false,
    call: (headers?: HeadersInit) =>
      app.request("/v1/strategies/st_1", {
        method: "PATCH",
        headers: { ...(headers ?? {}), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      }),
  },
  // ── writes with a THREE-way mapping (MONEY-1183, third slice) ────────────
  // These differ from the eight above: they have a genuine client-error path
  // too (a blank watchlist name, a non-positive exit price), so the fix is not
  // "stop returning 4xx" — it is to stop DB failures sharing that branch. Each
  // route keeps its own previous status as the un-coded default, so nothing
  // that was correct changes.
  {
    endpoint: "POST /v1/paper",
    service: "createPaperTrade",
    expectedArgs: null,
    serviceAlreadyCoded: false,
    uncodedStatus: 400,
    successStatus: 201,
    call: (headers?: HeadersInit) =>
      app.request("/v1/paper", {
        method: "POST",
        headers: { ...(headers ?? {}), "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: "TCS",
          exchange: "NSE",
          positionType: "LONG",
          quantity: 10,
          averagePrice: 3500,
          investedValue: 35000,
        }),
      }),
  },
  {
    endpoint: "POST /v1/watchlists",
    service: "createWatchlist",
    expectedArgs: null,
    serviceAlreadyCoded: false,
    uncodedStatus: 400,
    successStatus: 201,
    call: (headers?: HeadersInit) =>
      app.request("/v1/watchlists", {
        method: "POST",
        headers: { ...(headers ?? {}), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Momentum" }),
      }),
  },
  {
    endpoint: "POST /v1/learning/progress",
    service: "updateLessonProgress",
    expectedArgs: null,
    serviceAlreadyCoded: false,
    uncodedStatus: 404,
    call: (headers?: HeadersInit) =>
      app.request("/v1/learning/progress", {
        method: "POST",
        headers: { ...(headers ?? {}), "Content-Type": "application/json" },
        body: JSON.stringify({
          enrollmentId: "e_1",
          lessonId: "l_1",
          completed: true,
        }),
      }),
  },
  // ── the reads (MONEY-1183, final slice) ──────────────────────────────────
  // A read cannot lose data, but a 404 for a DB blip still tells the client the
  // resource is gone and to stop retrying — the polling case below is the one
  // where that actively costs the user their result.
  {
    endpoint: "GET /v1/brokers/:id",
    service: "getBrokerConnection",
    expectedArgs: ["mongo_1", "bc_1"],
    serviceAlreadyCoded: true,
    successStatus: 200,
    call: (headers?: HeadersInit) =>
      app.request("/v1/brokers/bc_1", { method: "GET", headers }),
  },
  {
    endpoint: "GET /v1/research/:sessionId/status",
    service: "getResearchStatus",
    expectedArgs: null,
    // getResearchStatus(sessionId, _, userId) — the caller is the THIRD arg.
    userIdArgIndex: 2,
    serviceAlreadyCoded: false,
    successStatus: 200,
    call: (headers?: HeadersInit) =>
      app.request("/v1/research/sess_1/status", { method: "GET", headers }),
  },
  {
    endpoint: "GET /v1/research/:sessionId/result",
    service: "getResearchResult",
    expectedArgs: null,
    // getResearchResult(sessionId, userId) — the caller is the SECOND arg.
    userIdArgIndex: 1,
    serviceAlreadyCoded: false,
    successStatus: 200,
    call: (headers?: HeadersInit) =>
      app.request("/v1/research/sess_1/result", { method: "GET", headers }),
  },
] as const;

beforeEach(() => {
  verifyImpl = async () => ({ sub: "clerk_default" });
  serviceImpls.clear();
  callArgs = undefined;
  setService("resolveUserId", async () => "mongo_1");
});

function arm(service: string, result: unknown): void {
  setService(service, async (...args: unknown[]) => {
    callArgs = args;
    return result;
  });
}

for (const m of MUTATIONS) {
  describe(`Contract: ${m.endpoint} (MONEY-1183)`, () => {
    it("succeeds scoped to the AUTHENTICATED caller", async () => {
      arm(m.service, { success: true, data: { id: "x" } });
      const res = await m.call(AUTH);
      // 201 on the creates, not 200 — mobile clients branch on it, so it is
      // asserted per-endpoint rather than assumed.
      assert.equal(res.status, "successStatus" in m ? m.successStatus : 200);
      // `expectedArgs: null` where the argument shape is an update payload
      // rather than the point of this file — the caller scoping is still
      // asserted, since a wrong userId would not be "mongo_1".
      if (m.expectedArgs) assert.deepEqual(callArgs, m.expectedArgs);
      else {
        // Not every service takes the caller first — the research ones put the
        // session id there. The scoping assertion is the point, so the position
        // is declared per endpoint rather than assumed.
        const idx = "userIdArgIndex" in m ? m.userIdArgIndex : 0;
        assert.equal((callArgs ?? [])[idx], "mongo_1");
      }
    });

    it("a missing or FOREIGN row is a 404", async () => {
      arm(m.service, { success: false, error: "Not found", code: "NOT_FOUND" });
      const res = await m.call(AUTH);
      // Routes that never had a not-found path keep their own default; the
      // point of this case is that NOT_FOUND is never reported as a 500.
      const expected = "uncodedStatus" in m ? m.uncodedStatus : 404;
      assert.equal(res.status, expected);
    });

    it("a DB failure is a 500, not a 404", async () => {
      // The defect. 404 tells the client the row is gone, so it stops retrying
      // something that would have worked on the next attempt.
      arm(m.service, {
        success: false,
        error: "connection reset",
        code: "INTERNAL",
      });
      const res = await m.call(AUTH);
      assert.equal(res.status, 500);
      assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
    });

    it("an UN-CODED failure keeps this route's previous default", async () => {
      // `code` is optional on ServiceResult and these services have other
      // failure paths without it — a duplicate watchlist name, a blank field.
      // Those must behave EXACTLY as before, which is why the default is
      // per-route rather than a single value.
      arm(m.service, { success: false, error: "Nope" });
      const expected = "uncodedStatus" in m ? m.uncodedStatus : 404;
      assert.equal((await m.call(AUTH)).status, expected);
    });

    it("requires auth — the service is never reached", async () => {
      arm(m.service, { success: true, data: { id: "x" } });
      const res = await m.call();
      assert.equal(res.status, 401);
      assert.equal(callArgs, undefined);
    });
  });
}

describe("Contract: the mutations share one shape (MONEY-1183)", () => {
  it("all of them map NOT_FOUND and INTERNAL identically", async () => {
    const rows: Array<[string, number, number]> = [];
    // Only the two-way handlers: the three-way ones keep a route-specific
    // un-coded default (400 for paper/watchlist, 404 for learning), which is
    // asserted per-endpoint above instead.
    for (const m of MUTATIONS.filter((x) => !("uncodedStatus" in x))) {
      arm(m.service, { success: false, error: "x", code: "NOT_FOUND" });
      const nf = await m.call(AUTH);
      arm(m.service, { success: false, error: "x", code: "INTERNAL" });
      const err = await m.call(AUTH);
      rows.push([m.endpoint, nf.status, err.status]);
    }
    assert.deepEqual(
      rows,
      MUTATIONS.filter((x) => !("uncodedStatus" in x)).map((m) => [
        m.endpoint,
        404,
        500,
      ]),
      "every mutation must answer 404 for a missing row and 500 for a DB failure",
    );
  });

  it("[regression] five services were already coded — the ROUTES were the gap", async () => {
    // Recorded as a test because it is the lesson, not a footnote: MONEY-1062
    // added `code: "INTERNAL"` to these three services with a comment saying
    // routes should map it to 500, and no route ever read it. The fix looked
    // done for months. Anything asserting only the service would still pass.
    const alreadyCoded = MUTATIONS.filter((m) => m.serviceAlreadyCoded);
    // Five now: all four chat-history services plus getBrokerConnection, which
    // has carried code "NOT_FOUND" all along while its route discarded it.
    assert.equal(alreadyCoded.length, 5);
    for (const m of alreadyCoded) {
      arm(m.service, { success: false, error: "blip", code: "INTERNAL" });
      assert.equal(
        (await m.call(AUTH)).status,
        500,
        `${m.endpoint} — the service has always reported INTERNAL here; the ` +
          `route must act on it`,
      );
    }
  });
});

describe("Contract: research result — NOT READY is not NOT FOUND (MONEY-1183)", () => {
  it("a still-running session answers 409, not 404", async () => {
    // The session EXISTS and belongs to the caller; it simply has no result
    // yet. 404 told a polling client the research had vanished, so it stopped
    // polling a run that was about to finish — the user lost a result they had
    // already paid credits for. 409 means "exists, not in a state to serve
    // this", which is what a poller needs to keep going.
    setService("getResearchResult", async () => ({
      success: false,
      error: "Research is still RUNNING",
      code: "NOT_READY",
    }));
    const res = await app.request("/v1/research/sess_1/result", {
      method: "GET",
      headers: AUTH,
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "CONFLICT");
  });

  it("a genuinely missing session is still a 404", async () => {
    // The distinction only matters if the other side still works.
    setService("getResearchResult", async () => ({
      success: false,
      error: "Research session not found",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/research/ghost/result", {
      method: "GET",
      headers: AUTH,
    });
    assert.equal(res.status, 404);
  });
});
