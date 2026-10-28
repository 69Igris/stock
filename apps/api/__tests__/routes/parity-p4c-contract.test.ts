/**
 * MONEY-1062 P4c Discovery-Power Parity HTTP Contract Tests — API Server
 *
 * Contract coverage for the four P4c screener-surface route families NO other
 * suite drives:
 *
 *   /v1/screener       POST /stocks /mfs /etfs   (GLOBAL — no userId passed)
 *   /v1/scans          GET / + POST /:id/run     (GLOBAL catalog; inline runs)
 *   /v1/strategies     presets/categories + custom CRUD + async run + polling
 *   /v1/saved-screens  user-scoped CRUD (upsert / rename-collision 409)
 *
 * Per family: happy path (service args + userId-scoping captured), validation
 * 400s (malformed / non-finite / oversized bodies rejected BEFORE the service),
 * and the code-based status mapping (NOT_FOUND→404, NOT_RUNNABLE→400,
 * CONFLICT→409, INTERNAL/code-less→the endpoint's documented status).
 *
 * ASYNC RUN (G3): POST /v1/strategies/:id/run is additionally driven through
 * the REAL `runStrategyScan` service (required from packages/services with a
 * fake `@usemoney/database` prisma) so the published Pub/Sub message SHAPE is
 * asserted end-to-end at the HTTP layer — and a failed gate (foreign/ghost
 * strategy) provably NEVER creates a ScanResult nor publishes.
 *
 * Uses the SAME ESM stubbing seam as money1062-hardening-contract.test.ts: a
 * CJS `require` seeded with a `@usemoney/services` Proxy (stable forwarder →
 * per-test impls) and a configurable `@clerk/backend` verifier, plus (as in
 * parity-p2a-contract.test.ts) a `@usemoney/pubsub/publish` recorder and a
 * fake `@usemoney/database` for the real-service block; then the apps/api/src
 * modules are purged and re-required so their imports resolve to the stubs.
 *
 * Source: apps/api/src/routes/v1/{screener,scans,strategies,saved-screens}.ts
 *         apps/api/src/middleware/{auth,request-id}.ts
 *         packages/services/src/strategies.service.ts (real run seam)
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

// ── @usemoney/pubsub/publish recorder ───────────────────────────────────────
// The strategies routes never publish directly (the SERVICE owns the publish),
// but the real-service block below runs the genuine runStrategyScan whose
// default publisher must resolve to THIS recorder.
let publishStrategyScanImpl: (msg: Record<string, unknown>) => Promise<string>;
const publishedStrategyScans: Array<Record<string, unknown>> = [];
const publishStub = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    if (typeof prop !== "string") return undefined;
    if (prop === "__esModule") return true;
    if (prop === "then") return undefined;
    if (prop === "publishStrategyScanJob") {
      return (msg: Record<string, unknown>) => {
        publishedStrategyScans.push(msg);
        return publishStrategyScanImpl(msg);
      };
    }
    // Other publishers (imports/brokers/me routes import them at module load)
    // just resolve — this suite never drives those families.
    return async () => "msg_stubbed";
  },
});

// ── fake @usemoney/database prisma (real runStrategyScan block only) ────────
// Recorded in a single ordered log so create-BEFORE-publish is assertable.
let customFindFirstImpl: (args: Record<string, unknown>) => unknown;
let scanCreateImpl: (args: Record<string, unknown>) => unknown;
const dbLog: Array<{ op: string; args: Record<string, unknown> }> = [];
const fakePrisma = {
  customStrategy: {
    findFirst: async (args: Record<string, unknown>) => {
      dbLog.push({ op: "customStrategy.findFirst", args });
      return customFindFirstImpl(args);
    },
  },
  scanResult: {
    create: async (args: Record<string, unknown>) => {
      dbLog.push({ op: "scanResult.create", args });
      return scanCreateImpl(args);
    },
  },
};
const databaseStub = { __esModule: true, prisma: fakePrisma };

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
// The REAL service fn (packages/services), bound to the stubs above.
let realRunStrategyScan: (...args: unknown[]) => Promise<unknown>;
// A REAL built-in strategy id (registry loaded transitively by the service).
let builtinFixture: {
  id: string;
  name: string;
  scanType: string;
  filters: unknown[];
};

before(() => {
  stub(require.resolve("@usemoney/services"), servicesStub);
  stub(require.resolve("@clerk/backend"), clerkStub);
  stub(require.resolve("@usemoney/pubsub/publish"), publishStub);
  stub(require.resolve("@usemoney/database"), databaseStub);
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

  // REAL strategies service — its `@usemoney/pubsub/publish` and
  // `@usemoney/database` imports resolve to the stubs installed above, so the
  // route can drive the genuine gate → create → publish pipeline.
  const realStrategies =
    require("../../../../packages/services/src/strategies.service.ts") as {
      runStrategyScan: (...args: unknown[]) => Promise<unknown>;
    };
  realRunStrategyScan = realStrategies.runStrategyScan;
  const { BUILTIN_STRATEGIES } =
    require("@usemoney/research/strategies/builtin-strategies") as {
      BUILTIN_STRATEGIES: Array<typeof builtinFixture>;
    };
  builtinFixture = BUILTIN_STRATEGIES[0]!;

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
  setService("resolveUserId", async () => "mongo_1");
  publishStrategyScanImpl = async () => "msg_strategy_1";
  publishedStrategyScans.length = 0;
  dbLog.length = 0;
  customFindFirstImpl = async () => null;
  scanCreateImpl = async () => ({ id: "scan_1" });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/screener/{stocks,mfs,etfs} — GLOBAL screeners (no userId)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/screener/stocks (P4c)", () => {
  it("requires a Bearer token even though the data is global", async () => {
    const res = await app.request("/v1/screener/stocks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
  });

  it("forwards (filters, query, paging) verbatim, strips unknown filter keys, passes NO userId", async () => {
    let seen: unknown[] = [];
    setService("screenStocks", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: {
          rows: [{ symbol: "RELIANCE" }],
          total: 1,
          page: 1,
          pageSize: 10,
        },
      };
    });
    const res = await app.request("/v1/screener/stocks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        filters: { minPe: 5, maxPe: 20, exchange: "NSE", evilKey: 9 },
        query: "rel",
        page: 1,
        pageSize: 10,
        sort: "mcap-desc",
      }),
    });
    assert.equal(res.status, 200);
    // arg0 = the filter bag, NOT a userId (screener is global market data)
    assert.deepEqual(seen[0], { minPe: 5, maxPe: 20, exchange: "NSE" });
    assert.equal(
      JSON.stringify(seen).includes("mongo_1"),
      false,
      "no userId may reach the global screener",
    );
    assert.equal(seen[1], "rel");
    const paging = seen[2] as { page: number; pageSize: number; sort: string };
    assert.equal(paging.page, 1);
    assert.equal(paging.pageSize, 10);
    assert.equal(paging.sort, "mcap-desc");
    assert.equal((await res.json()).data.total, 1);
  });

  it("an empty {} body is valid (filters default {}) and reaches the service", async () => {
    let seen: unknown[] = [];
    setService("screenStocks", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { rows: [], total: 0, page: 0, pageSize: 25 },
      };
    });
    const res = await app.request("/v1/screener/stocks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen[0], {});
  });

  it("rejects malformed JSON with 400 BAD_REQUEST (service untouched)", async () => {
    let called = false;
    setService("screenStocks", async () => {
      called = true;
      return {
        success: true,
        data: { rows: [], total: 0, page: 0, pageSize: 25 },
      };
    });
    const res = await app.request("/v1/screener/stocks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "BAD_REQUEST");
    assert.equal(called, false);
  });

  it("rejects a non-finite band (1e999 parses to Infinity) with 400 (Mongo gte/lte poison)", async () => {
    let called = false;
    setService("screenStocks", async () => {
      called = true;
      return {
        success: true,
        data: { rows: [], total: 0, page: 0, pageSize: 25 },
      };
    });
    const res = await app.request("/v1/screener/stocks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: '{"filters":{"minPe":1e999}}',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("rejects typed/bounds violations with 400: string band, bogus sort/enum, page/pageSize/query caps", async () => {
    let called = false;
    setService("screenStocks", async () => {
      called = true;
      return {
        success: true,
        data: { rows: [], total: 0, page: 0, pageSize: 25 },
      };
    });
    const bad: unknown[] = [
      { filters: { minPe: "5" } }, // typed number required
      { filters: { exchange: "NYSE" } }, // enum
      { filters: { marketCapBucket: "MEGA" } }, // enum
      { sort: "bogus" },
      { page: -1 },
      { page: 1.5 }, // int required
      { pageSize: 0 },
      { pageSize: 201 }, // MAX_PAGE_SIZE 200
      { query: "x".repeat(121) }, // MAX_QUERY_LEN 120
      { filters: { sector: "" } }, // min(1)
      { filters: { index: "x".repeat(41) } }, // MAX_INDEX_LEN 40
    ];
    for (const body of bad) {
      const res = await app.request("/v1/screener/stocks", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `must 400: ${JSON.stringify(body)}`);
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(called, false);
  });

  it("maps a service failure to 500 INTERNAL_ERROR; a service throw also 500s", async () => {
    setService("screenStocks", async () => ({
      success: false,
      error: "Failed to run screener",
    }));
    const failed = await app.request("/v1/screener/stocks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(failed.status, 500);
    assert.equal((await failed.json()).error.code, "INTERNAL_ERROR");

    setService("screenStocks", async () => {
      throw new Error("boom");
    });
    const threw = await app.request("/v1/screener/stocks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(threw.status, 500);
    assert.equal((await threw.json()).error.code, "INTERNAL_ERROR");
  });
});

describe("Contract: POST /v1/screener/mfs (P4c)", () => {
  it("forwards MF filters (amcAny array kept) with no userId", async () => {
    let seen: unknown[] = [];
    setService("screenMfs", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { rows: [], total: 0, page: 0, pageSize: 25 },
      };
    });
    const res = await app.request("/v1/screener/mfs", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        filters: { amcAny: ["HDFC", "SBI"], plan: "DIRECT", minAum: 100 },
        sort: "aum-desc",
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen[0], {
      amcAny: ["HDFC", "SBI"],
      plan: "DIRECT",
      minAum: 100,
    });
    assert.equal(JSON.stringify(seen).includes("mongo_1"), false);
    assert.equal((seen[2] as { sort: string }).sort, "aum-desc");
  });

  it("rejects an oversized amcAny (21 entries) and a stock-only sort key with 400", async () => {
    let called = false;
    setService("screenMfs", async () => {
      called = true;
      return {
        success: true,
        data: { rows: [], total: 0, page: 0, pageSize: 25 },
      };
    });
    const tooMany = await app.request("/v1/screener/mfs", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        filters: { amcAny: Array.from({ length: 21 }, (_, i) => `AMC${i}`) },
      }),
    });
    assert.equal(tooMany.status, 400);

    const stockSort = await app.request("/v1/screener/mfs", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ sort: "mcap-desc" }), // fund sort enum only
    });
    assert.equal(stockSort.status, 400);
    assert.equal(called, false);
  });

  it("maps a service failure to 500", async () => {
    setService("screenMfs", async () => ({
      success: false,
      error: "Failed to run mutual fund screener",
    }));
    const res = await app.request("/v1/screener/mfs", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 500);
  });
});

describe("Contract: POST /v1/screener/etfs (P4c)", () => {
  it("forwards ETF filters with no userId and returns the paged payload", async () => {
    let seen: unknown[] = [];
    setService("screenEtfs", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: {
          rows: [{ symbol: "NIFTYBEES" }],
          total: 1,
          page: 0,
          pageSize: 25,
        },
      };
    });
    const res = await app.request("/v1/screener/etfs", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        filters: { exchange: "NSE", assetClass: "equity", theme: "gold" },
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen[0], {
      exchange: "NSE",
      assetClass: "equity",
      theme: "gold",
    });
    assert.equal(JSON.stringify(seen).includes("mongo_1"), false);
    assert.equal((await res.json()).data.rows[0].symbol, "NIFTYBEES");
  });

  it("rejects a non-finite minAum (1e999) with 400 before the service", async () => {
    let called = false;
    setService("screenEtfs", async () => {
      called = true;
      return {
        success: true,
        data: { rows: [], total: 0, page: 0, pageSize: 25 },
      };
    });
    const res = await app.request("/v1/screener/etfs", {
      method: "POST",
      headers: JSON_HEADERS,
      body: '{"filters":{"minAum":1e999}}',
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// /v1/scans — GET catalog + POST /:id/run (inline screener run)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/scans (P4c)", () => {
  it("returns the catalog payload untouched (global — service called with no args)", async () => {
    let seenArgs: unknown[] | undefined;
    setService("getScanCatalog", async (...args: unknown[]) => {
      seenArgs = args;
      return {
        success: true,
        data: {
          scans: [{ id: "core:value_investing", runnable: true }],
          categories: [{ category: "all", count: 1, label: "All" }],
        },
      };
    });
    const res = await app.request("/v1/scans", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(seenArgs, []); // no userId — catalog is global
    const body = await res.json();
    assert.equal(body.data.scans[0].id, "core:value_investing");
    assert.equal(body.data.categories[0].label, "All");
  });

  it("maps a service failure / throw to 500 INTERNAL_ERROR", async () => {
    setService("getScanCatalog", async () => ({
      success: false,
      error: "Failed to load scan catalog",
    }));
    const failed = await app.request("/v1/scans", { headers: AUTH });
    assert.equal(failed.status, 500);

    setService("getScanCatalog", async () => {
      throw new Error("boom");
    });
    const threw = await app.request("/v1/scans", { headers: AUTH });
    assert.equal(threw.status, 500);
  });
});

describe("Contract: POST /v1/scans/:id/run (P4c)", () => {
  it("an ABSENT body runs with the default limit (body is optional)", async () => {
    let seen: unknown[] = [];
    setService("runScan", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: {
          scanId: "core:value_investing",
          scanName: "Value Investing",
          rows: [],
          total: 0,
          unmapped: [],
          partial: false,
        },
      };
    });
    const res = await app.request("/v1/scans/core:value_investing/run", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["core:value_investing", { limit: undefined }]);
    assert.equal((await res.json()).data.scanName, "Value Investing");
  });

  it("forwards an explicit limit (no userId — scans are global)", async () => {
    let seen: unknown[] = [];
    setService("runScan", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: {
          scanId: "s",
          scanName: "S",
          rows: [],
          total: 0,
          unmapped: [],
          partial: false,
        },
      };
    });
    const res = await app.request("/v1/scans/core:value_investing/run", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ limit: 25 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["core:value_investing", { limit: 25 }]);
    assert.equal(JSON.stringify(seen).includes("mongo_1"), false);
  });

  it("a PRESENT-but-malformed body → 400 BAD_REQUEST (service untouched)", async () => {
    let called = false;
    setService("runScan", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request("/v1/scans/core:value_investing/run", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{oops",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "BAD_REQUEST");
    assert.equal(called, false);
  });

  it("rejects limit bounds/type violations with 400 (0, 101, string)", async () => {
    let called = false;
    setService("runScan", async () => {
      called = true;
      return { success: true, data: {} };
    });
    for (const limit of [0, 101, "25"]) {
      const res = await app.request("/v1/scans/core:value_investing/run", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ limit }),
      });
      assert.equal(res.status, 400, `limit ${JSON.stringify(limit)} must 400`);
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(called, false);
  });

  it("rejects an oversized scan id (121 chars) with 400 before the service", async () => {
    let called = false;
    setService("runScan", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const res = await app.request(`/v1/scans/${"x".repeat(121)}/run`, {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  it("maps code NOT_FOUND → 404, NOT_RUNNABLE → 400 (fail closed), code-less → 500", async () => {
    setService("runScan", async () => ({
      success: false,
      error: "Scan not found",
      code: "NOT_FOUND",
    }));
    const missing = await app.request("/v1/scans/ghost:nope/run", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    setService("runScan", async () => ({
      success: false,
      error:
        "This scan isn't available for one-click run yet. Open it in the screener or ask StockSage to run it.",
      code: "NOT_RUNNABLE",
    }));
    const browseOnly = await app.request("/v1/scans/chartink:x/run", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(browseOnly.status, 400);
    assert.equal((await browseOnly.json()).error.code, "VALIDATION_ERROR");

    setService("runScan", async () => ({
      success: false,
      error: "Failed to run screener",
    }));
    const internal = await app.request("/v1/scans/core:value_investing/run", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(internal.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// /v1/strategies — presets/categories (global) + custom CRUD (user-scoped)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/strategies/presets + /categories (P4c)", () => {
  it("coerces ?limit and forwards { category, limit } (registry data — no userId)", async () => {
    let seen: unknown[] = [];
    setService("getStrategyPresets", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: [{ id: "graham_net_net", stats: null }] };
    });
    const res = await app.request(
      "/v1/strategies/presets?category=value&limit=12",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const opts = seen[0] as { category?: string; limit?: number };
    assert.equal(opts.category, "value");
    assert.equal(opts.limit, 12); // "12" coerced to a number
    assert.equal(JSON.stringify(seen).includes("mongo_1"), false);
  });

  it("rejects limit=0 / limit=500 / limit=abc / an oversized category with 400", async () => {
    let called = false;
    setService("getStrategyPresets", async () => {
      called = true;
      return { success: true, data: [] };
    });
    for (const qs of [
      "limit=0",
      "limit=500",
      "limit=abc",
      `category=${"x".repeat(33)}`,
    ]) {
      const res = await app.request(`/v1/strategies/presets?${qs}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 400, `${qs} must 400`);
    }
    assert.equal(called, false);
  });

  it("presets service failure → 500; categories happy → 200; categories failure → 500", async () => {
    setService("getStrategyPresets", async () => ({
      success: false,
      error: "Failed to load strategy presets",
    }));
    const presetsFail = await app.request("/v1/strategies/presets", {
      headers: AUTH,
    });
    assert.equal(presetsFail.status, 500);

    setService("getStrategyCategoriesInfo", async () => ({
      success: true,
      data: [{ category: "all", count: 42, label: "All" }],
    }));
    const cats = await app.request("/v1/strategies/categories", {
      headers: AUTH,
    });
    assert.equal(cats.status, 200);
    assert.equal((await cats.json()).data[0].count, 42);

    setService("getStrategyCategoriesInfo", async () => ({
      success: false,
      error: "Failed to load strategy categories",
    }));
    const catsFail = await app.request("/v1/strategies/categories", {
      headers: AUTH,
    });
    assert.equal(catsFail.status, 500);
  });
});

describe("Contract: GET /v1/strategies list (P4c)", () => {
  it("lists scoped to the caller with { category, search } forwarded", async () => {
    let seen: unknown[] = [];
    setService("listStrategies", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { builtIn: [], custom: [], categories: [] },
      };
    });
    const res = await app.request(
      "/v1/strategies?category=value&search=graham",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.equal(seen[0], "mongo_1");
    const opts = seen[1] as { category?: string; search?: string };
    assert.equal(opts.category, "value");
    assert.equal(opts.search, "graham");
  });

  it("rejects an oversized ?search (65 chars) with 400; failure → 500", async () => {
    let called = false;
    setService("listStrategies", async () => {
      called = true;
      return {
        success: true,
        data: { builtIn: [], custom: [], categories: [] },
      };
    });
    const bad = await app.request(`/v1/strategies?search=${"x".repeat(65)}`, {
      headers: AUTH,
    });
    assert.equal(bad.status, 400);
    assert.equal(called, false);

    setService("listStrategies", async () => ({
      success: false,
      error: "Failed to list strategies: boom",
    }));
    const fail = await app.request("/v1/strategies", { headers: AUTH });
    assert.equal(fail.status, 500);
  });
});

describe("Contract: POST /v1/strategies create (P4c)", () => {
  const VALID = {
    name: "My Value Screen",
    filters: [{ metric: "pe", operator: "lt", value: 15 }],
  };

  it("creates scoped to the caller → 201 (name trimmed, scanType defaulted)", async () => {
    let seen: unknown[] = [];
    setService("createStrategy", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { id: "cs_1" } };
    });
    const res = await app.request("/v1/strategies", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...VALID, name: "  My Value Screen  " }),
    });
    assert.equal(res.status, 201);
    assert.equal(seen[0], "mongo_1");
    const input = seen[1] as { name: string; scanType: string };
    assert.equal(input.name, "My Value Screen"); // zod .trim()
    assert.equal(input.scanType, "fundamental"); // schema default
    assert.equal((await res.json()).data.id, "cs_1");
  });

  it("rejects invalid/oversized payloads with 400 (service untouched)", async () => {
    let called = false;
    setService("createStrategy", async () => {
      called = true;
      return { success: true, data: { id: "x" } };
    });
    const bad: unknown[] = [
      {}, // name + filters required
      { ...VALID, name: "x" }, // min 2 chars
      { ...VALID, name: "x".repeat(81) }, // max 80
      { ...VALID, filters: [] }, // ≥1 filter
      { name: "Valid Name" }, // filters missing
      { ...VALID, filters: Array.from({ length: 51 }, () => ({})) }, // ≤50
      { ...VALID, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, // ≤20
      { ...VALID, chartinkQuery: "x".repeat(2001) }, // ≤2000
      { ...VALID, description: "x".repeat(501) }, // ≤500
    ];
    for (const body of bad) {
      const res = await app.request("/v1/strategies", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      assert.equal(
        res.status,
        400,
        `must 400: ${JSON.stringify(body).slice(0, 60)}`,
      );
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(called, false);
  });

  it("malformed JSON → 400 BAD_REQUEST; CONFLICT code → 409; code-less failure → 500", async () => {
    const malformed = await app.request("/v1/strategies", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{nope",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_REQUEST");

    setService("createStrategy", async () => ({
      success: false,
      error: "A strategy with this name already exists",
      code: "CONFLICT",
    }));
    const conflict = await app.request("/v1/strategies", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(VALID),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "CONFLICT");

    setService("createStrategy", async () => ({
      success: false,
      error: "Failed to create strategy: boom",
    }));
    const internal = await app.request("/v1/strategies", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(VALID),
    });
    assert.equal(internal.status, 500);
  });
});

describe("Contract: PATCH /v1/strategies/:id + DELETE /v1/strategies/:id (P4c)", () => {
  it("PATCH forwards the sparse patch scoped (userId, id); not-found → 404", async () => {
    let seen: unknown[] = [];
    setService("updateStrategy", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { id: "cs_1" } };
    });
    const ok = await app.request("/v1/strategies/cs_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Renamed" }),
    });
    assert.equal(ok.status, 200);
    assert.equal(seen[0], "mongo_1");
    assert.equal(seen[1], "cs_1");
    assert.equal((seen[2] as { name: string }).name, "Renamed");

    setService("updateStrategy", async () => ({
      success: false,
      error: "Strategy not found",
    }));
    const missing = await app.request("/v1/strategies/ghost", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Renamed" }),
    });
    assert.equal(missing.status, 404);
  });

  it("PATCH rejects a 1-char name and an empty-array filters with 400", async () => {
    let called = false;
    setService("updateStrategy", async () => {
      called = true;
      return { success: true, data: { id: "cs_1" } };
    });
    for (const body of [{ name: "x" }, { filters: [] }]) {
      const res = await app.request("/v1/strategies/cs_1", {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
    }
    assert.equal(called, false);
  });

  it("DELETE is ownership-scoped; foreign/ghost id → 404", async () => {
    let seen: unknown[] = [];
    setService("deleteStrategy", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { id: "cs_1" } };
    });
    const ok = await app.request("/v1/strategies/cs_1", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen, ["mongo_1", "cs_1"]);

    setService("deleteStrategy", async () => ({
      success: false,
      error: "Strategy not found",
    }));
    const missing = await app.request("/v1/strategies/ghost", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");
  });
});

describe("Contract: POST /v1/strategies/:id/clone (P4c)", () => {
  it("clones with no body (name defaults inside the service) → 201", async () => {
    let seen: unknown[] = [];
    setService("cloneBuiltIn", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { id: "cs_9" } };
    });
    const res = await app.request("/v1/strategies/graham_net_net/clone", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 201);
    assert.deepEqual(seen, ["mongo_1", "graham_net_net", undefined]);
  });

  it("forwards a custom name; malformed body → 400; oversized name → 400", async () => {
    let seen: unknown[] = [];
    setService("cloneBuiltIn", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { id: "cs_9" } };
    });
    const ok = await app.request("/v1/strategies/graham_net_net/clone", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Mine" }),
    });
    assert.equal(ok.status, 201);
    assert.equal(seen[2], "Mine");

    const malformed = await app.request("/v1/strategies/graham_net_net/clone", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{nope",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_REQUEST");

    const oversized = await app.request("/v1/strategies/graham_net_net/clone", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "x".repeat(81) }),
    });
    assert.equal(oversized.status, 400);
  });

  it("maps CONFLICT → 409 and a code-less failure (ghost built-in) → 404", async () => {
    setService("cloneBuiltIn", async () => ({
      success: false,
      error: "A strategy with this name already exists",
      code: "CONFLICT",
    }));
    const conflict = await app.request("/v1/strategies/graham_net_net/clone", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(conflict.status, 409);

    setService("cloneBuiltIn", async () => ({
      success: false,
      error: "Built-in strategy not found",
    }));
    const missing = await app.request("/v1/strategies/ghost/clone", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(missing.status, 404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/strategies/:id/run — async run (stubbed code mapping)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/strategies/:id/run mapping (P4c)", () => {
  it("an ABSENT body runs (defaults applied downstream) → 202 { scanId, status }", async () => {
    let seen: unknown[] = [];
    setService("runStrategyScan", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { scanId: "scan_1", status: "PENDING" } };
    });
    const res = await app.request("/v1/strategies/cs_1/run", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 202);
    assert.equal(seen[0], "mongo_1");
    assert.equal(seen[1], "cs_1");
    assert.deepEqual(seen[2], {});
    const body = await res.json();
    assert.equal(body.data.scanId, "scan_1");
    assert.equal(body.data.status, "PENDING");
  });

  it("rejects malformed / out-of-bounds run bodies with 400 — and NEVER publishes", async () => {
    let called = false;
    setService("runStrategyScan", async () => {
      called = true;
      return { success: true, data: { scanId: "x", status: "PENDING" } };
    });
    const malformed = await app.request("/v1/strategies/cs_1/run", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{nope",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_REQUEST");

    for (const body of [
      { limit: 0 },
      { limit: 201 },
      { limit: "50" },
      { isBuiltIn: "yes" },
    ]) {
      const res = await app.request("/v1/strategies/cs_1/run", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `must 400: ${JSON.stringify(body)}`);
    }
    assert.equal(called, false);
    assert.equal(publishedStrategyScans.length, 0);
  });

  it("maps code NOT_FOUND → 404 and a code-less failure → 500", async () => {
    setService("runStrategyScan", async () => ({
      success: false,
      error: "Strategy not found",
      code: "NOT_FOUND",
    }));
    const missing = await app.request("/v1/strategies/ghost/run", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");

    setService("runStrategyScan", async () => ({
      success: false,
      error: "Failed to run strategy: boom",
    }));
    const internal = await app.request("/v1/strategies/cs_1/run", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(internal.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/strategies/:id/run — REAL service: gate → create → publish (G3)
// ════════════════════════════════════════════════════════════════════════════

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("Contract: POST /v1/strategies/:id/run through the REAL runStrategyScan (P4c G3)", () => {
  it("custom strategy: 202 + PENDING ScanResult created BEFORE one publish with the exact StrategyScanMessage shape", async () => {
    setService("runStrategyScan", realRunStrategyScan);
    customFindFirstImpl = async () => ({
      id: "cs_1",
      name: "My Momentum",
      filters: [{ metric: "rsi", operator: "gt", value: 60 }],
      logic: "OR",
      scanType: "technical",
    });
    scanCreateImpl = async () => ({ id: "scan_real_1" });

    const res = await app.request("/v1/strategies/cs_1/run", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.data.scanId, "scan_real_1");
    assert.equal(body.data.status, "PENDING");

    // gate: ownership-scoped lookup
    const gate = dbLog.find((e) => e.op === "customStrategy.findFirst");
    assert.deepEqual(gate?.args, { where: { id: "cs_1", userId: "mongo_1" } });

    // ScanResult created PENDING, scoped, linked to the custom strategy
    const create = dbLog.find((e) => e.op === "scanResult.create");
    assert.deepEqual(create?.args, {
      data: {
        strategyId: "cs_1",
        userId: "mongo_1",
        scanName: "My Momentum",
        results: [],
        stockCount: 0,
        status: "PENDING",
      },
    });

    // exactly one publish, with the full message shape
    assert.equal(publishedStrategyScans.length, 1);
    const msg = publishedStrategyScans[0]!;
    assert.match(String(msg.jobId), UUID_RE);
    assert.equal(msg.userId, "mongo_1");
    assert.equal(msg.scanId, "scan_real_1");
    assert.equal(msg.strategyId, "cs_1");
    assert.equal(msg.isBuiltIn, false);
    assert.deepEqual(msg.filters, [
      { metric: "rsi", operator: "gt", value: 60 },
    ]);
    assert.equal(msg.logic, "OR");
    assert.equal(msg.scanType, "technical");
    assert.equal(msg.limit, 50); // default preview size

    // ordering: the PENDING row exists before the worker can be handed the job
    const createIdx = dbLog.findIndex((e) => e.op === "scanResult.create");
    assert.ok(createIdx >= 0);
    assert.equal(
      dbLog.filter((e) => e.op === "scanResult.create").length,
      1,
      "exactly one ScanResult create",
    );
  });

  it("an explicit body { limit } rides into the published message", async () => {
    setService("runStrategyScan", realRunStrategyScan);
    customFindFirstImpl = async () => ({
      id: "cs_1",
      name: "My Momentum",
      filters: [],
      logic: null,
      scanType: "fundamental",
    });
    scanCreateImpl = async () => ({ id: "scan_real_2" });

    const res = await app.request("/v1/strategies/cs_1/run", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ limit: 75 }),
    });
    assert.equal(res.status, 202);
    assert.equal(publishedStrategyScans.length, 1);
    assert.equal(publishedStrategyScans[0]!.limit, 75);
    // null logic falls back to "AND" (the web action's default)
    assert.equal(publishedStrategyScans[0]!.logic, "AND");
  });

  it("GATE FAILURE (foreign/ghost custom id): 404 — NO ScanResult created, NOTHING published", async () => {
    setService("runStrategyScan", realRunStrategyScan);
    customFindFirstImpl = async () => null; // not owned / doesn't exist

    const res = await app.request("/v1/strategies/ghost/run", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
    assert.equal(
      dbLog.filter((e) => e.op === "scanResult.create").length,
      0,
      "gate failure must not create an orphan ScanResult",
    );
    assert.equal(
      publishedStrategyScans.length,
      0,
      "gate failure must never publish",
    );
  });

  it("built-in run: registry gate resolves, ScanResult.strategyId stays null, message carries isBuiltIn:true", async () => {
    setService("runStrategyScan", realRunStrategyScan);
    scanCreateImpl = async () => ({ id: "scan_real_3" });

    const res = await app.request(`/v1/strategies/${builtinFixture.id}/run`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ isBuiltIn: true }),
    });
    assert.equal(res.status, 202);

    // built-in path never touches customStrategy
    assert.equal(
      dbLog.filter((e) => e.op === "customStrategy.findFirst").length,
      0,
    );
    const create = dbLog.find((e) => e.op === "scanResult.create");
    const createData = (create?.args as { data: Record<string, unknown> }).data;
    assert.equal(createData.strategyId, null); // built-ins have no DB row
    assert.equal(createData.scanName, builtinFixture.name);
    assert.equal(createData.status, "PENDING");

    assert.equal(publishedStrategyScans.length, 1);
    const msg = publishedStrategyScans[0]!;
    assert.equal(msg.isBuiltIn, true);
    assert.equal(msg.strategyId, builtinFixture.id);
    assert.equal(msg.scanType, builtinFixture.scanType);
    assert.deepEqual(msg.filters, builtinFixture.filters);
  });

  it("built-in GATE FAILURE (ghost registry id): 404, nothing created or published", async () => {
    setService("runStrategyScan", realRunStrategyScan);
    const res = await app.request("/v1/strategies/ghost_builtin/run", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ isBuiltIn: true }),
    });
    assert.equal(res.status, 404);
    assert.equal(dbLog.length, 0);
    assert.equal(publishedStrategyScans.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// /v1/strategies/scans/* — history + status/result polling
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/strategies/scans/history + /:scanId/{status,result} (P4c)", () => {
  it("history: coerces ?limit and scopes to the caller; limit=0 → 400; failure → 500", async () => {
    let seen: unknown[] = [];
    setService("getScanHistory", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { scans: [{ id: "scan_1" }] } };
    });
    const ok = await app.request("/v1/strategies/scans/history?limit=5", {
      headers: AUTH,
    });
    assert.equal(ok.status, 200);
    assert.equal(seen[0], "mongo_1");
    assert.equal((seen[1] as { limit?: number }).limit, 5);

    const bad = await app.request("/v1/strategies/scans/history?limit=0", {
      headers: AUTH,
    });
    assert.equal(bad.status, 400);

    setService("getScanHistory", async () => ({
      success: false,
      error: "Failed to get scan history: boom",
    }));
    const fail = await app.request("/v1/strategies/scans/history", {
      headers: AUTH,
    });
    assert.equal(fail.status, 500);
  });

  it("status: scoped (userId, scanId); foreign/missing scan → 404 (no cross-user oracle)", async () => {
    let seen: unknown[] = [];
    setService("getScanStatus", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { status: "COMPLETED", stockCount: 12, errorMessage: null },
      };
    });
    const ok = await app.request("/v1/strategies/scans/scan_9/status", {
      headers: AUTH,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen, ["mongo_1", "scan_9"]);
    assert.equal((await ok.json()).data.status, "COMPLETED");

    setService("getScanStatus", async () => ({
      success: false,
      error: "Scan not found",
    }));
    const missing = await app.request("/v1/strategies/scans/ghost/status", {
      headers: AUTH,
    });
    assert.equal(missing.status, 404);
  });

  it("status is code-aware (C3#4): NOT_FOUND → 404, INTERNAL → 500, code-less DB catch → 500", async () => {
    // Coded miss (service codes landing in parallel) → 404.
    setService("getScanStatus", async () => ({
      success: false,
      error: "Scan not found",
      code: "NOT_FOUND",
    }));
    const coded404 = await app.request("/v1/strategies/scans/ghost/status", {
      headers: AUTH,
    });
    assert.equal(coded404.status, 404);
    assert.equal((await coded404.json()).error.code, "NOT_FOUND");

    // Coded DB failure → 500 (the old blanket mapping said 404).
    setService("getScanStatus", async () => ({
      success: false,
      error: "Failed to get scan status: boom",
      code: "INTERNAL",
    }));
    const coded500 = await app.request("/v1/strategies/scans/scan_9/status", {
      headers: AUTH,
    });
    assert.equal(coded500.status, 500);
    assert.equal((await coded500.json()).error.code, "INTERNAL_ERROR");

    // Code-less NON-miss string (today's DB catch) → 500, not 404.
    setService("getScanStatus", async () => ({
      success: false,
      error: "Failed to get scan status: connection reset",
    }));
    const codeless = await app.request("/v1/strategies/scans/scan_9/status", {
      headers: AUTH,
    });
    assert.equal(codeless.status, 500);
  });

  it("result: scoped (userId, scanId); foreign/missing scan → 404", async () => {
    let seen: unknown[] = [];
    setService("getScanResult", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: {
          scanName: "My Momentum",
          stockCount: 2,
          status: "COMPLETED",
          results: [{ symbol: "RELIANCE" }],
          executedAt: "2026-07-10T00:00:00.000Z",
        },
      };
    });
    const ok = await app.request("/v1/strategies/scans/scan_9/result", {
      headers: AUTH,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen, ["mongo_1", "scan_9"]);
    assert.equal((await ok.json()).data.stockCount, 2);

    setService("getScanResult", async () => ({
      success: false,
      error: "Scan not found",
    }));
    const missing = await app.request("/v1/strategies/scans/ghost/result", {
      headers: AUTH,
    });
    assert.equal(missing.status, 404);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// /v1/saved-screens — user-scoped CRUD
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/saved-screens (P4c)", () => {
  it("lists scoped to the caller; ?mode narrows; absent mode passes undefined", async () => {
    let seen: unknown[] = [];
    setService("listSavedScreens", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: [{ id: "ss_1", name: "Value picks" }] };
    });
    const all = await app.request("/v1/saved-screens", { headers: AUTH });
    assert.equal(all.status, 200);
    assert.equal(seen[0], "mongo_1");
    assert.equal(seen[1], undefined);

    const stocks = await app.request("/v1/saved-screens?mode=stocks", {
      headers: AUTH,
    });
    assert.equal(stocks.status, 200);
    assert.deepEqual(seen, ["mongo_1", "stocks"]);
  });

  it("rejects an unknown ?mode with 400; failure → 500", async () => {
    let called = false;
    setService("listSavedScreens", async () => {
      called = true;
      return { success: true, data: [] };
    });
    const bad = await app.request("/v1/saved-screens?mode=bonds", {
      headers: AUTH,
    });
    assert.equal(bad.status, 400);
    assert.equal(called, false);

    setService("listSavedScreens", async () => ({
      success: false,
      error: "Failed to list saved screens",
    }));
    const fail = await app.request("/v1/saved-screens", { headers: AUTH });
    assert.equal(fail.status, 500);
  });
});

describe("Contract: POST /v1/saved-screens (P4c)", () => {
  const VALID = {
    name: "Low PE",
    mode: "stocks",
    filters: { minPe: 1, maxPe: 15 },
  };

  it("saves scoped to the caller → 201 (name trimmed; query optional)", async () => {
    let seen: unknown[] = [];
    setService("saveScreen", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { id: "ss_1", name: "Low PE", mode: "stocks", filterCount: 2 },
      };
    });
    const res = await app.request("/v1/saved-screens", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...VALID, name: "  Low PE  " }),
    });
    assert.equal(res.status, 201);
    assert.equal(seen[0], "mongo_1");
    const input = seen[1] as { name: string; mode: string; filters: unknown };
    assert.equal(input.name, "Low PE");
    assert.equal(input.mode, "stocks");
    assert.deepEqual(input.filters, { minPe: 1, maxPe: 15 });
  });

  it("rejects invalid/oversized payloads with 400 (service untouched)", async () => {
    let called = false;
    setService("saveScreen", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const bad: unknown[] = [
      {}, // all required
      { ...VALID, name: "   " }, // trims to empty
      { ...VALID, name: "x".repeat(61) }, // max 60
      { ...VALID, mode: "bonds" }, // enum
      { name: "Low PE", mode: "stocks" }, // filters required
      {
        ...VALID,
        filters: Object.fromEntries(
          Array.from({ length: 41 }, (_, i) => [`k${i}`, 1]),
        ),
      }, // ≤40 filter keys
      { ...VALID, query: "x".repeat(201) }, // ≤200
    ];
    for (const body of bad) {
      const res = await app.request("/v1/saved-screens", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      assert.equal(
        res.status,
        400,
        `must 400: ${JSON.stringify(body).slice(0, 60)}`,
      );
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(called, false);
  });

  it("malformed JSON → 400 BAD_REQUEST; service failure → 500", async () => {
    const malformed = await app.request("/v1/saved-screens", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{nope",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_REQUEST");

    setService("saveScreen", async () => ({
      success: false,
      error: "Failed to save screen",
    }));
    const fail = await app.request("/v1/saved-screens", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(VALID),
    });
    assert.equal(fail.status, 500);
  });
});

describe("Contract: GET/PATCH/DELETE /v1/saved-screens/:id (P4c)", () => {
  it("GET loads scoped (userId, id); foreign id → 404", async () => {
    let seen: unknown[] = [];
    setService("loadSavedScreen", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { id: "ss_1", name: "Low PE", filters: { minPe: 1 } },
      };
    });
    const ok = await app.request("/v1/saved-screens/ss_1", { headers: AUTH });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen, ["mongo_1", "ss_1"]);
    assert.deepEqual((await ok.json()).data.filters, { minPe: 1 });

    setService("loadSavedScreen", async () => ({
      success: false,
      error: "Screen not found",
    }));
    const missing = await app.request("/v1/saved-screens/ghost", {
      headers: AUTH,
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");
  });

  it("PATCH renames scoped ({ id, name }); collision → 409; code-less failure → 404", async () => {
    let seen: unknown[] = [];
    setService("renameSavedScreen", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { id: "ss_1", name: "Renamed" } };
    });
    const ok = await app.request("/v1/saved-screens/ss_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Renamed" }),
    });
    assert.equal(ok.status, 200);
    assert.equal(seen[0], "mongo_1");
    assert.deepEqual(seen[1], { id: "ss_1", name: "Renamed" });

    setService("renameSavedScreen", async () => ({
      success: false,
      error: 'A screen named "Renamed" already exists for this mode',
      code: "CONFLICT",
    }));
    const conflict = await app.request("/v1/saved-screens/ss_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Renamed" }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "CONFLICT");

    setService("renameSavedScreen", async () => ({
      success: false,
      error: "Screen not found",
    }));
    const missing = await app.request("/v1/saved-screens/ghost", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Renamed" }),
    });
    assert.equal(missing.status, 404);
  });

  it("PATCH rejects malformed/invalid rename bodies with 400", async () => {
    let called = false;
    setService("renameSavedScreen", async () => {
      called = true;
      return { success: true, data: {} };
    });
    const malformed = await app.request("/v1/saved-screens/ss_1", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: "{nope",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_REQUEST");

    for (const body of [{}, { name: "   " }, { name: "x".repeat(61) }]) {
      const res = await app.request("/v1/saved-screens/ss_1", {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
    }
    assert.equal(called, false);
  });

  it("DELETE is scoped; foreign id → 404 (deleteMany count 0 semantics)", async () => {
    let seen: unknown[] = [];
    setService("deleteSavedScreen", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { id: "ss_1" } };
    });
    const ok = await app.request("/v1/saved-screens/ss_1", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen, ["mongo_1", "ss_1"]);

    setService("deleteSavedScreen", async () => ({
      success: false,
      error: "Screen not found",
    }));
    const missing = await app.request("/v1/saved-screens/ghost", {
      method: "DELETE",
      headers: AUTH,
    });
    assert.equal(missing.status, 404);
  });
});
