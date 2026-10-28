/**
 * FIRE scenario CRUD — HTTP CONTRACT tests (MONEY-1091 follow-up).
 *
 * Closes three of the endpoint gaps `endpoint-contract-coverage.test.ts`
 * surfaced: `GET /v1/fire`, `POST /v1/fire` and `PUT /v1/fire/:id`. The family
 * was already "referenced" by the contract suite — via `POST /v1/fire/:id/chat`
 * — which is exactly the false comfort measuring per FAMILY produced.
 *
 * ## Why these three, ahead of the other 27
 *
 * Two of them WRITE. A regression in a read is visible on the next screen load;
 * a regression in a write is silent and irreversible, which is the same class
 * of defect the `/turn` retarget bug belonged to.
 *
 * ## The contract that actually matters here
 *
 * Create and update are THE SAME service call, discriminated only by arity:
 *
 *     POST /v1/fire       → saveFireScenario(userId, body)              // create
 *     PUT  /v1/fire/:id   → saveFireScenario(userId, body, scenarioId)  // update
 *
 * So "did the id reach the service" is not a detail — it is the whole
 * difference between inserting a scenario and overwriting an existing one.
 * Nothing in the type system distinguishes them (the third parameter is
 * optional), so it is asserted here in both directions: POST must call with
 * NO third argument even when the body itself carries an `id`, and PUT must
 * pass the PATH id, never the body's.
 *
 * The status mapping is the second half. `saveFireScenario` returns a `code`
 * and each route maps it differently, because create has no not-found path:
 *
 *              NOT_FOUND      INTERNAL     other
 *     POST     (impossible)   500          400
 *     PUT      404            500          400
 *
 * `GET /v1/fire/:id` carries a comment that its 404 and 500 were once INVERTED
 * (a DB error 404'd, a missing scenario 200'd with `data: null`). That endpoint
 * is covered elsewhere; the same inversion is pinned here for the list + update
 * paths, where nothing was watching.
 *
 * Same CJS require-cache stubbing seam as parity-p1a-contract.test.ts. No LLM
 * stub is needed — none of these three routes reach a model.
 *
 * Source: apps/api/src/routes/v1/fire.ts (GET /, POST /, PUT /:id)
 *         packages/services/src/fire.service.ts (saveFireScenario)
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

/** A plausible create/update body. */
const BODY = {
  name: "Aggressive",
  currentAge: 30,
  retirementAge: 45,
  lifeExpectancy: 85,
  currentCorpus: 2_000_000,
  monthlySavings: 80_000,
  withdrawalRate: 4,
} as const;

/** Recorded saveFireScenario calls, so ARITY is observable. */
let saveCalls: unknown[][] = [];

beforeEach(() => {
  verifyImpl = async () => ({ sub: "clerk_default" });
  serviceImpls.clear();
  saveCalls = [];
  setService("resolveUserId", async () => "mongo_1");
  setService("saveFireScenario", async (...args: unknown[]) => {
    saveCalls.push(args);
    return { success: true, data: { id: "sc_new", ...BODY } };
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/fire — list
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/fire (MONEY-1091 follow-up)", () => {
  it("lists scenarios scoped to the caller", async () => {
    let seen: unknown;
    setService("getFireScenarios", async (userId: unknown) => {
      seen = userId;
      return { success: true, data: [{ id: "sc_1", name: "Base" }] };
    });
    const res = await app.request("/v1/fire", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seen, "mongo_1");
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, "sc_1");
  });

  it("no scenarios is a successful empty list, not a 404", async () => {
    // A new user has none. 404 here would make the app's empty state
    // indistinguishable from a broken account.
    setService("getFireScenarios", async () => ({ success: true, data: [] }));
    const res = await app.request("/v1/fire", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, []);
  });

  it("a DB failure is a 500 — the list has no not-found path", async () => {
    setService("getFireScenarios", async () => ({
      success: false,
      error: "connection reset",
    }));
    const res = await app.request("/v1/fire", { headers: AUTH });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });

  it("requires auth", async () => {
    let called = false;
    setService("getFireScenarios", async () => {
      called = true;
      return { success: true, data: [] };
    });
    const res = await app.request("/v1/fire");
    assert.equal(res.status, 401);
    assert.equal(called, false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/fire — create
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/fire (MONEY-1091 follow-up)", () => {
  it("creates with NO scenarioId and answers 201", async () => {
    const res = await app.request("/v1/fire", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(BODY),
    });
    // 201, not 200 — mobile clients branch on it.
    assert.equal(res.status, 201);
    assert.equal((await res.json()).data.id, "sc_new");

    assert.equal(saveCalls.length, 1);
    const call = saveCalls[0]!;
    assert.equal(call[0], "mongo_1");
    assert.equal((call[1] as { name: string }).name, "Aggressive");
    // The arity IS the create/update switch: a third argument here would turn
    // every create into an overwrite of that id.
    assert.equal(call.length, 2);
    assert.equal(call[2], undefined);
  });

  it("an `id` in the BODY does not become the update target", async () => {
    // Only the PATH id may target a row. If the body's id leaked into the
    // third argument, `POST /v1/fire` with {id: someone_else_row} would
    // overwrite it instead of inserting.
    const res = await app.request("/v1/fire", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...BODY, id: "sc_victim" }),
    });
    assert.equal(res.status, 201);
    assert.equal(saveCalls[0]![2], undefined);
  });

  it("rejects malformed JSON (400) before touching the service", async () => {
    const res = await app.request("/v1/fire", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{bad",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "BAD_REQUEST");
    assert.equal(saveCalls.length, 0);
  });

  it("maps the service code: INTERNAL → 500, anything else → 400 (create has no 404)", async () => {
    setService("saveFireScenario", async () => ({
      success: false,
      error: "write conflict",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/fire", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(BODY),
    });
    assert.equal(internal.status, 500);
    assert.equal((await internal.json()).error.code, "INTERNAL_ERROR");

    setService("saveFireScenario", async () => ({
      success: false,
      error: "retirementAge must exceed currentAge",
      code: "VALIDATION",
    }));
    const invalid = await app.request("/v1/fire", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(BODY),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "VALIDATION_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PUT /v1/fire/:id — update
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: PUT /v1/fire/:id (MONEY-1091 follow-up)", () => {
  it("passes the PATH id as the update target, not the body's", async () => {
    const res = await app.request("/v1/fire/sc_path", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...BODY, id: "sc_other" }),
    });
    assert.equal(res.status, 200);
    assert.equal(saveCalls.length, 1);
    assert.equal(saveCalls[0]![0], "mongo_1");
    assert.equal(saveCalls[0]![2], "sc_path");
  });

  it("a missing/foreign scenario is a 404, NOT a 500 (and vice versa)", async () => {
    // These two were inverted once already on the sibling GET /:id — a DB
    // error reported as not-found tells the client to stop retrying, and a
    // not-found reported as a server error tells it to keep retrying forever.
    setService("saveFireScenario", async (...args: unknown[]) => {
      saveCalls.push(args);
      return { success: false, error: "Scenario not found", code: "NOT_FOUND" };
    });
    const missing = await app.request("/v1/fire/sc_ghost", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(BODY),
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    setService("saveFireScenario", async (...args: unknown[]) => {
      saveCalls.push(args);
      return { success: false, error: "connection reset", code: "INTERNAL" };
    });
    const broken = await app.request("/v1/fire/sc_path", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(BODY),
    });
    assert.equal(broken.status, 500);
    assert.equal((await broken.json()).error.code, "INTERNAL_ERROR");
  });

  it("a code-less service failure stays a 400", async () => {
    setService("saveFireScenario", async () => ({
      success: false,
      error: "assetClasses must sum to 100",
    }));
    const res = await app.request("/v1/fire/sc_path", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(BODY),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
  });

  it("rejects malformed JSON (400) before touching the service", async () => {
    const res = await app.request("/v1/fire/sc_path", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: "{bad",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "BAD_REQUEST");
    assert.equal(saveCalls.length, 0);
  });
});
