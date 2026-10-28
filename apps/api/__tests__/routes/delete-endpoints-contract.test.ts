/**
 * Every remaining /v1 DELETE — HTTP CONTRACT tests (MONEY-1091 follow-up,
 * MONEY-1180).
 *
 * Closes the last four DELETE gaps in one file rather than four:
 *
 *   DELETE /v1/paper/:id
 *   DELETE /v1/research/:sessionId
 *   DELETE /v1/watchlists/:id
 *   DELETE /v1/watchlists/:id/items/:itemId
 *
 * They live in three different route files, but grouping them is the point:
 * what matters about a delete is not which resource it removes, it is that
 * **every one of them is scoped to the caller** and that **a failure to delete
 * is reported honestly**. Those two invariants are identical across all four,
 * so testing them together makes a new DELETE that forgets either one visibly
 * inconsistent with its siblings instead of merely untested.
 *
 * ## The bug (MONEY-1180)
 *
 * All four routes were:
 *
 *     if (!result.success) return c.json(error(NOT_FOUND, …), 404);
 *
 * while all four services collapsed TWO different outcomes into that single
 * `success: false` — the ownership check failing (genuinely not found) and the
 * `catch` around the Prisma call (the database failed). So a transient DB error
 * on any delete answered **404**, the one status that tells a client the row
 * does not exist and retrying is pointless. The row is still there, the user
 * presses delete again, and gets the same 404.
 *
 * The services now tag those returns `NOT_FOUND` / `INTERNAL` — `code` was
 * already an optional field on `ServiceResult`, so this is additive and no
 * other caller changes. The routes map `INTERNAL` → 500 and keep 404 as the
 * default, so an un-coded failure from any other path behaves exactly as before.
 *
 * ## Ownership is the other half
 *
 * Each service scopes by `userId` (`deleteMany({where:{id, userId}})`, or a
 * `findFirst` ownership gate) — MONEY-594 and MONEY-620 fixed real IDOR bugs
 * here. The routes are asserted to pass the AUTHENTICATED caller through, never
 * anything client-supplied, because a route that passed a body/query userId
 * would re-open exactly those bugs while every service test still passed.
 *
 * Source: apps/api/src/routes/v1/{paper,research,watchlist}.ts
 *         packages/services/src/{paper,research,watchlist}.service.ts
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

/** Args the delete service was called with, or undefined if never called. */
let callArgs: unknown[] | undefined;

/**
 * The four DELETEs, described uniformly so the shared invariants can be
 * asserted by the same code for every one of them. `expectedArgs` is what the
 * route must hand the service — always the AUTHENTICATED caller first.
 *
 * Each entry carries a `call` closure rather than a `url` string, and the URL
 * literal lives INSIDE the `app.request(...)` call. That is deliberate:
 * `__tests__/meta/endpoint-contract-coverage.test.ts` measures coverage by
 * scanning for literal paths at `app.request(` call sites, so
 * `app.request(d.url, init)` would drive all four endpoints while still being
 * reported as covering none of them — and, because that scanner also reads the
 * METHOD from the text immediately after the path, a hoisted `init` object
 * would get them counted as GETs. Loosening the scanner to chase variables
 * would make it match any `/v1/...` string anywhere — including one in a
 * comment — and start over-reporting coverage, which is the failure mode it
 * exists to prevent. Keeping the literal at the call site keeps the table AND
 * an honest measurement.
 */
const DELETES = [
  {
    endpoint: "DELETE /v1/paper/:id",
    service: "deletePaperTrade",
    expectedArgs: ["mongo_1", "pp_1"],
    call: (headers?: HeadersInit) =>
      app.request("/v1/paper/pp_1", { method: "DELETE", headers }),
  },
  {
    endpoint: "DELETE /v1/research/:sessionId",
    service: "deleteResearch",
    expectedArgs: ["mongo_1", "sess_1"],
    call: (headers?: HeadersInit) =>
      app.request("/v1/research/sess_1", { method: "DELETE", headers }),
  },
  {
    endpoint: "DELETE /v1/watchlists/:id",
    service: "deleteWatchlist",
    expectedArgs: ["mongo_1", "wl_1"],
    call: (headers?: HeadersInit) =>
      app.request("/v1/watchlists/wl_1", { method: "DELETE", headers }),
  },
  {
    endpoint: "DELETE /v1/watchlists/:id/items/:itemId",
    service: "removeWatchlistItem",
    // NOTE: only the ITEM id reaches the service — the watchlist id in the
    // path is not used to scope the removal. Safe because the item lookup is
    // itself owner-scoped, but pinned here so the asymmetry is deliberate and
    // visible rather than discovered later.
    expectedArgs: ["mongo_1", "it_9"],
    call: (headers?: HeadersInit) =>
      app.request("/v1/watchlists/wl_1/items/it_9", {
        method: "DELETE",
        headers,
      }),
  },
] as const;

beforeEach(() => {
  verifyImpl = async () => ({ sub: "clerk_default" });
  serviceImpls.clear();
  callArgs = undefined;
  setService("resolveUserId", async () => "mongo_1");
});

/** Point one delete service at a given result and record its arguments. */
function arm(service: string, result: unknown): void {
  setService(service, async (...args: unknown[]) => {
    callArgs = args;
    return result;
  });
}

for (const d of DELETES) {
  describe(`Contract: ${d.endpoint} (MONEY-1091 follow-up)`, () => {
    it("deletes scoped to the AUTHENTICATED caller", async () => {
      arm(d.service, { success: true, data: undefined });
      const res = await d.call(AUTH);
      assert.equal(res.status, 200);
      // The caller comes from the verified token, never from the request body
      // or query — passing a client-supplied id here would re-open the IDOR
      // bugs MONEY-594 / MONEY-620 fixed, with every service test still green.
      assert.deepEqual(callArgs, d.expectedArgs);
    });

    it("a missing or FOREIGN id is a 404", async () => {
      arm(d.service, {
        success: false,
        error: "Not found",
        code: "NOT_FOUND",
      });
      const res = await d.call(AUTH);
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, "NOT_FOUND");
    });

    it("a DB failure is a 500, not a 404 (MONEY-1180)", async () => {
      // The whole reason this file exists. 404 tells the client to give up on
      // a row that is still there; the delete never succeeds and no retry
      // helps, because retrying a 404 is pointless by definition.
      arm(d.service, {
        success: false,
        error: "connection reset",
        code: "INTERNAL",
      });
      const res = await d.call(AUTH);
      assert.equal(res.status, 500);
      assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
    });

    it("an UN-CODED failure keeps the 404 default", async () => {
      // Back-compat: `code` is optional on ServiceResult and these services
      // have other failure paths that do not set it. Those must behave exactly
      // as they did before MONEY-1180 rather than becoming 500s.
      arm(d.service, { success: false, error: "Not found" });
      const res = await d.call(AUTH);
      assert.equal(res.status, 404);
    });

    it("requires auth — nothing is deleted for an anonymous caller", async () => {
      arm(d.service, { success: true, data: undefined });
      const res = await d.call();
      assert.equal(res.status, 401);
      assert.equal(callArgs, undefined);
    });
  });
}

describe("Contract: the DELETE family shares one shape (MONEY-1180)", () => {
  it("all four distinguish NOT_FOUND from INTERNAL identically", async () => {
    // Asserted as a set rather than per-route so a NEW delete that copies the
    // old `if (!result.success) → 404` shape stands out against its siblings.
    const statuses: Array<[string, number, number]> = [];
    for (const d of DELETES) {
      arm(d.service, { success: false, error: "x", code: "NOT_FOUND" });
      const nf = await d.call(AUTH);
      arm(d.service, { success: false, error: "x", code: "INTERNAL" });
      const err = await d.call(AUTH);
      statuses.push([d.endpoint, nf.status, err.status]);
    }
    assert.deepEqual(
      statuses,
      DELETES.map((d) => [d.endpoint, 404, 500]),
      "every /v1 DELETE must answer 404 for a missing row and 500 for a DB failure",
    );
  });
});
