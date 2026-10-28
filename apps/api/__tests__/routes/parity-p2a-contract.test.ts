/**
 * MONEY-1062 P2a Async-Trigger Parity HTTP Contract Tests — API Server
 *
 * Contract coverage for the async sync/import TRIGGER routes: broker day-data
 * sync (POST /v1/brokers/:id/sync), fan-out sync (POST /v1/brokers/sync-all),
 * historical backfill (POST /v1/brokers/:id/sync-historical), and the imports
 * family (POST /v1/imports async enqueue + GET/:batchId/retry/DELETE). Each
 * trigger's `publishSyncJob` / `publishImportJob` is a ROUTE-layer seam (exactly
 * like me.ts owns publishAccountDeletionJob), so this suite stubs
 * `@usemoney/pubsub/publish` and asserts the published message shape AND that a
 * failed gate NEVER publishes (G3: check the ServiceResult before the side effect).
 *
 * Uses the SAME ESM stubbing seam as money1062-hardening-contract.test.ts: a CJS
 * `require` seeded with a `@usemoney/services` Proxy (stable forwarder → per-test
 * impls) + a configurable `@clerk/backend` verifier, plus a `@usemoney/pubsub/publish`
 * recorder. The services Proxy special-cases the `DEFAULT_SYNC_DATA_TYPES` VALUE
 * export brokers.ts spreads at module load. imports.ts is NOT mounted by
 * v1/index.ts (the orchestrator wires it), so the harness mounts it directly at
 * /v1/imports.
 *
 * Source: apps/api/src/routes/v1/{brokers,imports}.ts
 *         apps/api/src/middleware/{auth,request-id}.ts
 *         packages/services/src/{broker-sync,trade-import}.service.ts (triggers)
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
// brokers.ts spreads this VALUE export at module load — must be an iterable array.
const DEFAULT_SYNC_DATA_TYPES = [
  "holdings",
  "positions",
  "trades",
  "mutualFunds",
] as const;
const servicesStub = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    if (typeof prop !== "string") return undefined;
    if (prop === "__esModule") return true;
    if (prop === "then") return undefined;
    if (prop === "default") return servicesStub;
    if (prop === "DEFAULT_SYNC_DATA_TYPES") return DEFAULT_SYNC_DATA_TYPES;
    return (...args: unknown[]) => {
      const impl = serviceImpls.get(prop);
      return impl
        ? impl(...args)
        : Promise.resolve({ success: false, error: `not-stubbed:${prop}` });
    };
  },
});

// ── @usemoney/pubsub/publish recorder ───────────────────────────────────────
let publishSyncImpl: (msg: Record<string, unknown>) => Promise<string>;
let publishImportImpl: (msg: Record<string, unknown>) => Promise<string>;
const publishedSync: Array<Record<string, unknown>> = [];
const publishedImport: Array<Record<string, unknown>> = [];
const publishStub = {
  __esModule: true,
  publishSyncJob: (msg: Record<string, unknown>) => {
    publishedSync.push(msg);
    return publishSyncImpl(msg);
  },
  publishImportJob: (msg: Record<string, unknown>) => {
    publishedImport.push(msg);
    return publishImportImpl(msg);
  },
};

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
  stub(require.resolve("@usemoney/pubsub/publish"), publishStub);
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
  // imports.ts is NOT mounted by v1/index.ts (the orchestrator wires it) — mount
  // it directly so this suite can drive it without touching index.ts.
  const importsRoutes = (
    require("../../src/routes/v1/imports.ts") as { default: unknown }
  ).default;

  const instance = new Hono();
  instance.use("*", requestIdMiddleware);
  instance.use("/v1/*", authMiddleware);
  instance.route("/v1", v1Routes);
  instance.route("/v1/imports", importsRoutes);
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
  publishSyncImpl = async () => "msg_sync_1";
  publishImportImpl = async () => "msg_import_1";
  publishedSync.length = 0;
  publishedImport.length = 0;
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/brokers/:id/sync — day-data sync trigger
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/brokers/:id/sync (P2a)", () => {
  it("verifies via the service (userId, connectionId), publishes the SyncJobMessage, returns 202 { jobId }", async () => {
    let seen: unknown[] = [];
    setService("startBrokerSync", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { jobId: "job_sync_1", broker: "ZERODHA" },
      };
    });
    const res = await app.request("/v1/brokers/conn_1/sync", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).data.jobId, "job_sync_1");
    // scoped to the resolved Mongo id + the path connectionId
    assert.deepEqual(seen, ["mongo_1", "conn_1"]);
    // published message mirrors syncBrokerDataAction's publishSyncJob shape
    assert.equal(publishedSync.length, 1);
    assert.deepEqual(publishedSync[0], {
      jobId: "job_sync_1",
      userId: "mongo_1",
      broker: "ZERODHA",
      brokerConnectionId: "conn_1",
      dataTypes: ["holdings", "positions", "trades", "mutualFunds"],
    });
  });

  it("a missing/foreign connection (code NOT_FOUND) → 404 and NEVER publishes", async () => {
    setService("startBrokerSync", async () => ({
      success: false,
      error: "Broker connection not found",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/brokers/ghost/sync", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
    assert.equal(publishedSync.length, 0);
  });

  it("a code-less gate failure (ZERODHA_CONNECT / inactive) → 400, no publish; code INTERNAL → 500", async () => {
    setService("startBrokerSync", async () => ({
      success: false,
      error: "Connect app does not sync data.",
    }));
    const gate = await app.request("/v1/brokers/c1/sync", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(gate.status, 400);
    assert.equal((await gate.json()).error.code, "VALIDATION_ERROR");
    assert.equal(publishedSync.length, 0);

    setService("startBrokerSync", async () => ({
      success: false,
      error: "Failed to start broker sync",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/brokers/c1/sync", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(internal.status, 500);
    assert.equal(publishedSync.length, 0);
  });

  it("a Pub/Sub publish failure surfaces as a retryable 500 (row already tracked)", async () => {
    setService("startBrokerSync", async () => ({
      success: true,
      data: { jobId: "job_sync_9", broker: "UPSTOX" },
    }));
    publishSyncImpl = async () => {
      throw new Error("pubsub down");
    };
    const res = await app.request("/v1/brokers/c1/sync", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/brokers/sync-all — fan-out sync trigger
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/brokers/sync-all (P2a)", () => {
  it("publishes one SyncJobMessage per connection and reports each (202)", async () => {
    let seen: unknown;
    setService("startAllBrokerSyncs", async (userId: unknown) => {
      seen = userId;
      return {
        success: true,
        data: {
          jobs: [
            { jobId: "j1", broker: "ZERODHA", connectionId: "c1" },
            { jobId: "j2", broker: "UPSTOX", connectionId: "c2" },
          ],
        },
      };
    });
    const res = await app.request("/v1/brokers/sync-all", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 202);
    assert.equal(seen, "mongo_1");
    const body = await res.json();
    assert.equal(body.data.jobs.length, 2);
    assert.equal(body.data.jobs[0].success, true);
    assert.equal(body.data.jobs[1].jobId, "j2");
    // one publish per connection, each carrying its own connectionId
    assert.equal(publishedSync.length, 2);
    assert.deepEqual(publishedSync[0], {
      jobId: "j1",
      userId: "mongo_1",
      broker: "ZERODHA",
      brokerConnectionId: "c1",
      dataTypes: ["holdings", "positions", "trades", "mutualFunds"],
    });
    assert.equal(publishedSync[1].brokerConnectionId, "c2");
  });

  it("zero connections → an empty jobs list, no publish (mirrors web results: [])", async () => {
    setService("startAllBrokerSyncs", async () => ({
      success: true,
      data: { jobs: [] },
    }));
    const res = await app.request("/v1/brokers/sync-all", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 202);
    assert.deepEqual((await res.json()).data.jobs, []);
    assert.equal(publishedSync.length, 0);
  });

  it("a per-connection publish failure is reported without sinking the batch", async () => {
    setService("startAllBrokerSyncs", async () => ({
      success: true,
      data: {
        jobs: [
          { jobId: "j1", broker: "ZERODHA", connectionId: "c1" },
          { jobId: "j2", broker: "UPSTOX", connectionId: "c2" },
        ],
      },
    }));
    let n = 0;
    publishSyncImpl = async () => {
      n += 1;
      if (n === 2) throw new Error("pubsub blip");
      return "ok";
    };
    const res = await app.request("/v1/brokers/sync-all", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 202);
    const jobs = (await res.json()).data.jobs;
    assert.equal(jobs[0].success, true);
    assert.equal(jobs[1].success, false);
    assert.equal(jobs[1].error, "Failed to publish sync job");
  });

  it("a service failure → 500, no publish", async () => {
    setService("startAllBrokerSyncs", async () => ({
      success: false,
      error: "Failed to start broker syncs",
      code: "INTERNAL",
    }));
    const res = await app.request("/v1/brokers/sync-all", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 500);
    assert.equal(publishedSync.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/brokers/:id/sync-historical — async backfill trigger
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/brokers/:id/sync-historical (P2a)", () => {
  it("forwards { days } to the service and publishes a message carrying historicalDays (202)", async () => {
    let seen: unknown[] = [];
    setService("startHistoricalSync", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { jobId: "jh1", broker: "ZERODHA", historicalDays: 365 },
      };
    });
    const res = await app.request("/v1/brokers/conn_1/sync-historical", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ days: 365 }),
    });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).data.jobId, "jh1");
    assert.deepEqual(seen, ["mongo_1", "conn_1", { days: 365 }]);
    assert.equal(publishedSync.length, 1);
    assert.deepEqual(publishedSync[0], {
      jobId: "jh1",
      userId: "mongo_1",
      broker: "ZERODHA",
      brokerConnectionId: "conn_1",
      dataTypes: ["holdings", "positions", "trades", "mutualFunds"],
      historicalDays: 365,
    });
  });

  it("an empty {} body is allowed → days undefined (service resolves the default)", async () => {
    let seen: unknown[] = [];
    setService("startHistoricalSync", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { jobId: "jh2", broker: "ZERODHA", historicalDays: 3650 },
      };
    });
    const res = await app.request("/v1/brokers/conn_1/sync-historical", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 202);
    assert.deepEqual(seen, ["mongo_1", "conn_1", { days: undefined }]);
    assert.equal(
      (publishedSync[0] as { historicalDays: number }).historicalDays,
      3650,
    );
  });

  it("a present-but-invalid days (negative / non-int) → 400 before the service", async () => {
    let called = false;
    setService("startHistoricalSync", async () => {
      called = true;
      return {
        success: true,
        data: { jobId: "x", broker: "ZERODHA", historicalDays: 1 },
      };
    });
    for (const bad of [-5, 0, "abc"]) {
      const res = await app.request("/v1/brokers/conn_1/sync-historical", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ days: bad }),
      });
      assert.equal(res.status, 400, `days ${String(bad)} must 400`);
    }
    assert.equal(called, false);
    assert.equal(publishedSync.length, 0);
  });

  it("a missing/foreign connection (NOT_FOUND) → 404, no publish", async () => {
    setService("startHistoricalSync", async () => ({
      success: false,
      error: "Broker connection not found",
      code: "NOT_FOUND",
    }));
    const res = await app.request("/v1/brokers/ghost/sync-historical", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ days: 30 }),
    });
    assert.equal(res.status, 404);
    assert.equal(publishedSync.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/imports — async import enqueue
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/imports (P2a)", () => {
  it("creates the job row + publishes the ImportJobMessage (inline content) → 202 { jobId }", async () => {
    let seen: unknown[] = [];
    setService("startTradeImport", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { jobId: "imp1" } };
    });
    const res = await app.request("/v1/imports", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        csvText: "sym,qty\nRELIANCE,10",
        broker: "zerodha",
        fileName: "trades.csv",
      }),
    });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).data.jobId, "imp1");
    // service gets the row metadata (content length, not the content)
    assert.equal(seen[0], "mongo_1");
    assert.deepEqual(seen[1], {
      brokerFormat: "zerodha",
      fileType: "csv",
      fileName: "trades.csv",
      contentLength: "sym,qty\nRELIANCE,10".length,
      brokerConnectionId: undefined,
      linkToManual: undefined,
    });
    // published message carries the inline CSV for the worker
    assert.equal(publishedImport.length, 1);
    assert.deepEqual(publishedImport[0], {
      jobId: "imp1",
      userId: "mongo_1",
      content: "sym,qty\nRELIANCE,10",
      brokerFormat: "zerodha",
      fileType: "csv",
      fileName: "trades.csv",
    });
  });

  it("defaults brokerFormat → 'generic' and fileType → 'csv' when omitted", async () => {
    setService("startTradeImport", async () => ({
      success: true,
      data: { jobId: "imp2" },
    }));
    const res = await app.request("/v1/imports", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ csvText: "a,b" }),
    });
    assert.equal(res.status, 202);
    assert.equal(publishedImport[0].brokerFormat, "generic");
    assert.equal(publishedImport[0].fileType, "csv");
  });

  it("rejects malformed JSON (400 BAD_REQUEST) and a missing csvText (400 VALIDATION) before the service", async () => {
    let called = false;
    setService("startTradeImport", async () => {
      called = true;
      return { success: true, data: { jobId: "x" } };
    });

    const malformed = await app.request("/v1/imports", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{bad",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_REQUEST");

    const missing = await app.request("/v1/imports", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ broker: "zerodha" }),
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, "VALIDATION_ERROR");

    assert.equal(called, false);
    assert.equal(publishedImport.length, 0);
  });

  it("rejects an oversized csvText (> ~5MB) with 400, no publish", async () => {
    let called = false;
    setService("startTradeImport", async () => {
      called = true;
      return { success: true, data: { jobId: "x" } };
    });
    const res = await app.request("/v1/imports", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ csvText: "x".repeat(5_000_001) }),
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
    assert.equal(publishedImport.length, 0);
  });

  it("a job-row create failure (INTERNAL) → 500 and NEVER publishes (G3)", async () => {
    setService("startTradeImport", async () => ({
      success: false,
      error: "Failed to start trade import",
      code: "INTERNAL",
    }));
    const res = await app.request("/v1/imports", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ csvText: "a,b" }),
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
    assert.equal(publishedImport.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/imports (+ /:batchId) — history & detail
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/imports history (P2a)", () => {
  it("returns the history scoped to the caller, forwarding a clamped ?limit", async () => {
    let seen: unknown[] = [];
    setService("getImportHistory", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: [{ batchId: "b1", tradeCount: 3 }] };
    });
    const res = await app.request("/v1/imports?limit=10", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal(seen[0], "mongo_1");
    assert.deepEqual(seen[1], { limit: 10 });
    assert.equal((await res.json()).data[0].batchId, "b1");
  });

  it("a DB failure → 500 (list has no not-found path)", async () => {
    setService("getImportHistory", async () => ({
      success: false,
      error: "Failed to fetch import history",
    }));
    const res = await app.request("/v1/imports", { headers: AUTH });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});

describe("Contract: GET /v1/imports/:batchId detail (P2a)", () => {
  it("returns the detail scoped to (userId, batchId)", async () => {
    let seen: unknown[] = [];
    setService("getImportById", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { batchId: "b1", totalRows: 100 } };
    });
    const res = await app.request("/v1/imports/b1", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "b1"]);
    assert.equal((await res.json()).data.totalRows, 100);
  });

  it("a missing/foreign log → 404; code INTERNAL → 500", async () => {
    setService("getImportById", async () => ({
      success: false,
      error: "Import log not found",
    }));
    const missing = await app.request("/v1/imports/ghost", { headers: AUTH });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    setService("getImportById", async () => ({
      success: false,
      error: "boom",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/imports/b1", { headers: AUTH });
    assert.equal(internal.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/imports/:batchId/retry — retry failed rows
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/imports/:batchId/retry (P2a)", () => {
  it("retries scoped to the caller and returns the counts (200)", async () => {
    let seen: unknown[] = [];
    setService("retryImport", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { retried: 3, succeeded: 2, failed: 1 } };
    });
    const res = await app.request("/v1/imports/b1/retry", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "b1"]);
    const body = await res.json();
    assert.equal(body.data.succeeded, 2);
    assert.equal(body.data.failed, 1);
    // /:batchId/retry resolves to the retry handler, not the list route
    assert.equal(publishedImport.length, 0);
  });

  it("missing log → 404; nothing-to-retry (code-less) → 400; INTERNAL → 500", async () => {
    setService("retryImport", async () => ({
      success: false,
      error: "Import log not found",
      code: "NOT_FOUND",
    }));
    const missing = await app.request("/v1/imports/ghost/retry", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(missing.status, 404);

    setService("retryImport", async () => ({
      success: false,
      error: "No failed rows to retry",
    }));
    const nothing = await app.request("/v1/imports/b1/retry", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(nothing.status, 400);
    assert.equal((await nothing.json()).error.code, "VALIDATION_ERROR");

    setService("retryImport", async () => ({
      success: false,
      error: "Retry failed",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/imports/b1/retry", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(internal.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE /v1/imports/:batchId — delete a batch
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: DELETE /v1/imports/:batchId (P2a)", () => {
  it("deletes scoped to (userId, batchId) and returns the deleted count", async () => {
    let seen: unknown[] = [];
    setService("deleteImport", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { deleted: 4 } };
    });
    const res = await app.request("/v1/imports/b1", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "b1"]);
    assert.equal((await res.json()).data.deleted, 4);
  });

  it("the synced-block refusal (code-less) → 400; a code INTERNAL → 500", async () => {
    setService("deleteImport", async () => ({
      success: false,
      error: "Cannot delete - contains synced broker trades",
    }));
    const blocked = await app.request("/v1/imports/b1", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(blocked.status, 400);
    assert.equal((await blocked.json()).error.code, "VALIDATION_ERROR");

    setService("deleteImport", async () => ({
      success: false,
      error: "Failed to delete import batch",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/imports/b1", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(internal.status, 500);
  });
});
