/**
 * Notifications routes — HTTP CONTRACT tests (MONEY-1091 follow-up).
 *
 * Closes four endpoint gaps: `GET /v1/notifications`,
 * `PATCH /v1/notifications/:id/read`, `POST /v1/notifications/read-all` and
 * `DELETE /v1/notifications/read`. Three of the four WRITE, and one of them
 * turned out to be broken.
 *
 * ## The bug this file was written into (MONEY-1178)
 *
 * `PATCH /:id/read` mapped every service failure to **404**. That is inverted,
 * and provably so from the service:
 *
 *   `markAsRead` is a `updateMany({ where: { id, userId } })`. Prisma's
 *   `updateMany` does NOT throw when it matches nothing — it returns
 *   `{ count: 0 }`. So a missing or FOREIGN id takes the SUCCESS path, and the
 *   only way to reach `success: false` is a genuine DB exception.
 *
 * The 404 therefore never meant "no such notification". It meant "the database
 * just failed" — dressed as the one status that tells a client to stop
 * retrying. The notification stays unread, and no retry ever fixes it. Same
 * defect class as `fire.ts`'s `GET /:id`, whose comment records that its 404
 * and 500 were once swapped; it survived here because nothing drove the route.
 * Fixed to 500 in this commit, and pinned below.
 *
 * A no-op stays 200 on purpose — see the route comment. Mark-as-read is
 * idempotent, the service does not surface the matched count, and turning it
 * into a 404 would fail clients marking a notification the user cleared in
 * another session. That is a separate decision, tracked as MONEY-1179, not a
 * drive-by.
 *
 * ## Cursor pagination
 *
 * The list is OFFSET-backed behind an opaque cursor (the service takes
 * limit+skip, not a keyset id). The contract worth pinning is that the cursor
 * round-trips: the value handed out must come back as the next `skip`, or the
 * client silently re-reads page 1 forever. Asserted by feeding the returned
 * cursor into a second request and reading the skip the service receives.
 *
 * Source: apps/api/src/routes/v1/notifications.ts
 *         packages/services/src/notifications.service.ts
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

/** n notification rows, so a "full page" can be produced for any limit. */
const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `n_${i}`,
    title: `Notification ${i}`,
    isRead: false,
  }));

/** Recorded getNotifications calls: [userId, limit, skip]. */
let listCalls: unknown[][] = [];
/** Recorded write-service calls, keyed by service name. */
let writeCalls: Array<{ fn: string; args: unknown[] }> = [];

function recordWrite(name: string, result: unknown): void {
  setService(name, async (...args: unknown[]) => {
    writeCalls.push({ fn: name, args });
    return result;
  });
}

beforeEach(() => {
  verifyImpl = async () => ({ sub: "clerk_default" });
  serviceImpls.clear();
  listCalls = [];
  writeCalls = [];
  setService("resolveUserId", async () => "mongo_1");
  setService("getNotifications", async (...args: unknown[]) => {
    listCalls.push(args);
    return { success: true, data: rows(3) };
  });
  recordWrite("markAsRead", { success: true, data: undefined });
  recordWrite("markAllAsRead", { success: true, data: undefined });
  recordWrite("clearAllRead", { success: true, data: undefined });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/notifications
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/notifications (MONEY-1091 follow-up)", () => {
  it("lists scoped to the caller in the cursor-page envelope", async () => {
    const res = await app.request("/v1/notifications", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.items.length, 3);
    assert.equal(listCalls[0]![0], "mongo_1");
    // Default page size, offset 0.
    assert.equal(listCalls[0]![1], 20);
    assert.equal(listCalls[0]![2], 0);
  });

  it("a SHORT page ends pagination; a FULL page hands out a cursor", async () => {
    // 3 rows for a limit of 20 — there cannot be more, so a cursor here would
    // send the client after an empty page.
    const short = await app.request("/v1/notifications", { headers: AUTH });
    assert.equal((await short.json()).data.nextCursor, null);

    setService("getNotifications", async (...args: unknown[]) => {
      listCalls.push(args);
      return { success: true, data: rows(5) };
    });
    const full = await app.request("/v1/notifications?limit=5", {
      headers: AUTH,
    });
    assert.notEqual((await full.json()).data.nextCursor, null);
  });

  it("the cursor round-trips — the value handed out becomes the next skip", async () => {
    // If it did not, the client would silently re-read page 1 forever.
    setService("getNotifications", async (...args: unknown[]) => {
      listCalls.push(args);
      return { success: true, data: rows(5) };
    });
    const first = await app.request("/v1/notifications?limit=5", {
      headers: AUTH,
    });
    const cursor = (await first.json()).data.nextCursor as string;
    assert.ok(cursor);

    const second = await app.request(
      `/v1/notifications?limit=5&cursor=${encodeURIComponent(cursor)}`,
      { headers: AUTH },
    );
    assert.equal(second.status, 200);
    assert.equal(listCalls.length, 2);
    assert.equal(listCalls[1]![2], 5, "second page must start at skip=5");
  });

  it("a garbage cursor falls back to the first page rather than 500ing", async () => {
    const res = await app.request("/v1/notifications?cursor=not-base64", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(listCalls[0]![2], 0);
  });

  it("a DB failure is a 500", async () => {
    setService("getNotifications", async () => ({
      success: false,
      error: "connection reset",
    }));
    const res = await app.request("/v1/notifications", { headers: AUTH });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });

  it("requires auth", async () => {
    const res = await app.request("/v1/notifications");
    assert.equal(res.status, 401);
    assert.equal(listCalls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /v1/notifications/:id/read
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: PATCH /v1/notifications/:id/read (MONEY-1091 follow-up)", () => {
  it("marks read scoped to (caller, id)", async () => {
    const res = await app.request("/v1/notifications/n_7/read", {
      method: "PATCH",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(writeCalls, [
      { fn: "markAsRead", args: ["mongo_1", "n_7"] },
    ]);
  });

  it("a DB failure is a 500, NOT a 404 — the inverted mapping this file fixed", async () => {
    // `markAsRead` is a scoped updateMany: it cannot fail because a row is
    // absent (that returns count 0 and succeeds), so `success: false` is only
    // ever a DB error. Answering 404 told the client to stop retrying a
    // transient failure, and the notification stayed unread permanently.
    recordWrite("markAsRead", {
      success: false,
      error: "Failed to update notification",
    });
    const res = await app.request("/v1/notifications/n_7/read", {
      method: "PATCH",
      headers: AUTH,
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });

  it("an id that matches nothing is an idempotent 200, not an error", async () => {
    // The documented, deliberate half: the service reports success because the
    // requested end state (not unread) holds either way, and it does not
    // surface the matched count for the route to distinguish.
    const res = await app.request("/v1/notifications/n_ghost/read", {
      method: "PATCH",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(writeCalls[0]!.args[1], "n_ghost");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/notifications/read-all  +  DELETE /v1/notifications/read
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: notification bulk writes (MONEY-1091 follow-up)", () => {
  it("POST /read-all marks all read for the caller; a failure is a 500", async () => {
    const ok = await app.request("/v1/notifications/read-all", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(writeCalls, [{ fn: "markAllAsRead", args: ["mongo_1"] }]);

    recordWrite("markAllAsRead", { success: false, error: "connection reset" });
    const bad = await app.request("/v1/notifications/read-all", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(bad.status, 500);
    assert.equal((await bad.json()).error.code, "INTERNAL_ERROR");
  });

  it("DELETE /read clears read notifications; a failure is a 500", async () => {
    const ok = await app.request("/v1/notifications/read", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(writeCalls, [{ fn: "clearAllRead", args: ["mongo_1"] }]);

    recordWrite("clearAllRead", { success: false, error: "connection reset" });
    const bad = await app.request("/v1/notifications/read", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(bad.status, 500);
    assert.equal((await bad.json()).error.code, "INTERNAL_ERROR");
  });

  it("`/read` is the literal clear route, never captured as an :id", async () => {
    // DELETE /read and PATCH /:id/read are different methods so they cannot
    // shadow each other today — but this pins it, because adding a
    // `DELETE /:id` later would silently reroute the clear-all button to a
    // single-row delete of a notification called "read".
    await app.request("/v1/notifications/read", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(writeCalls.length, 1);
    assert.equal(writeCalls[0]!.fn, "clearAllRead");
    // clearAllRead takes the caller ONLY — no id was parsed out of the path.
    assert.deepEqual(writeCalls[0]!.args, ["mongo_1"]);
  });

  it("both bulk writes require auth", async () => {
    const readAll = await app.request("/v1/notifications/read-all", {
      method: "POST",
    });
    assert.equal(readAll.status, 401);
    const clear = await app.request("/v1/notifications/read", {
      method: "DELETE",
    });
    assert.equal(clear.status, 401);
    assert.deepEqual(writeCalls, []);
  });
});
