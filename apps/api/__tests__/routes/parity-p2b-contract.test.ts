/**
 * MONEY-1062 P2b Async-Trigger Parity HTTP Contract Tests — API Server
 *
 * Contract coverage for the async START endpoints added in P2b:
 *   POST /v1/research, POST /v1/roast + GET /v1/roast/can-use,
 *   POST /v1/compare + GET /v1/compare/:id/status + /result,
 *   POST /v1/analysis + GET /v1/analysis/:id/status + /result +
 *   POST /v1/analysis/:id/cancel.
 *
 * Per endpoint: happy path (202/200; service args prove userId scoping to the
 * resolved Mongo _id + the parsed body reaches the service), body/query
 * validation → 400 BEFORE the service (service untouched), and the ServiceResult
 * `code` → HTTP mapping (UPGRADE_REQUIRED / NO_CREDITS → 403, INVALID_INPUT /
 * broker-state → 400, CONFLICT → 409, NOT_FOUND → 404, INTERNAL → 500). A gating
 * failure returns the mapped status with NO `data` envelope (the route-level
 * proxy for "no session/job created").
 *
 * The DEEP credit-flow invariants (G3: NO credit consumed / NO publish on an
 * early gate failure; the publish-failure REFUND leg; the create-before-consume
 * ordering) are asserted on the REAL service functions with injected seams in
 * packages/services/__tests__/parity-p2b-start-flows.service.test.ts — the
 * services barrel is STUBBED here, so those internals are not observable at this
 * (route) layer.
 *
 * Uses the SAME ESM stubbing seam as money1062-hardening-contract.test.ts: a CJS
 * `require` seeded with a `@usemoney/services` Proxy (stable forwarder →
 * per-test impls) and a configurable `@clerk/backend` verifier, then the
 * apps/api/src modules are purged and re-required so their
 * `import … from "@usemoney/services"` resolves to the stub. compare + analysis
 * are mounted DIRECTLY (the v1 aggregator's two mount lines are wired by the
 * orchestrator, not this agent) so this suite drives them today.
 *
 * Source: apps/api/src/routes/v1/{research,roast,compare,analysis}.ts
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
  // compare + analysis are not yet in the v1 aggregator (orchestrator wires the
  // two mount lines) — mount them directly so this suite drives them today.
  const compareRoutes = (
    require("../../src/routes/v1/compare.ts") as { default: unknown }
  ).default;
  const analysisRoutes = (
    require("../../src/routes/v1/analysis.ts") as { default: unknown }
  ).default;

  const instance = new Hono();
  instance.use("*", requestIdMiddleware);
  instance.use("/v1/*", authMiddleware);
  // Specific mounts BEFORE the /v1 catch-all so /v1/compare + /v1/analysis
  // resolve to their modules.
  instance.route("/v1/compare", compareRoutes);
  instance.route("/v1/analysis", analysisRoutes);
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
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/research — start async research
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/research (P2b)", () => {
  it("starts via startResearchJob(userId, body) → 202 { sessionId }", async () => {
    let seen: unknown[] = [];
    setService("startResearchJob", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { sessionId: "rs_1" } };
    });
    const res = await app.request("/v1/research", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        query: "Analyse TCS",
        mode: "advanced",
        symbols: ["TCS"],
      }),
    });
    assert.equal(res.status, 202);
    assert.equal(seen[0], "mongo_1"); // scoped to resolved Mongo id
    const input = seen[1] as { query: string; mode: string; symbols: string[] };
    assert.equal(input.query, "Analyse TCS");
    assert.equal(input.mode, "advanced");
    assert.deepEqual(input.symbols, ["TCS"]);
    assert.equal((await res.json()).data.sessionId, "rs_1");
  });

  it("rejects malformed JSON (400 BAD_REQUEST) and an empty body (400) before the service", async () => {
    let called = false;
    setService("startResearchJob", async () => {
      called = true;
      return { success: true, data: { sessionId: "x" } };
    });

    const malformed = await app.request("/v1/research", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{not json",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "BAD_REQUEST");

    const empty = await app.request("/v1/research", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("rejects a too-long query and >20 symbols with 400 (service untouched)", async () => {
    let called = false;
    setService("startResearchJob", async () => {
      called = true;
      return { success: true, data: { sessionId: "x" } };
    });
    const longQuery = await app.request("/v1/research", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ query: "x".repeat(2001) }),
    });
    assert.equal(longQuery.status, 400);

    const tooMany = await app.request("/v1/research", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        query: "compare",
        symbols: Array.from({ length: 21 }, (_, i) => `S${i}`),
      }),
    });
    assert.equal(tooMany.status, 400);
    assert.equal(called, false);
  });

  it("maps NO_CREDITS → 403 (no session envelope) and INTERNAL → 500", async () => {
    setService("startResearchJob", async () => ({
      success: false,
      error: "Insufficient credits. This action costs 3 credits.",
      code: "NO_CREDITS",
    }));
    const noCredits = await app.request("/v1/research", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ query: "Analyse TCS", mode: "advanced" }),
    });
    assert.equal(noCredits.status, 403);
    const body = await noCredits.json();
    assert.equal(body.error.code, "FORBIDDEN");
    assert.equal(body.data, undefined); // no session/job materialised

    setService("startResearchJob", async () => ({
      success: false,
      error: "Failed to queue research job",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/research", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ query: "Analyse TCS" }),
    });
    assert.equal(internal.status, 500);
    assert.equal((await internal.json()).error.code, "INTERNAL_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/roast/can-use — eligibility pre-flight (before /:sessionId)
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: GET /v1/roast/can-use (P2b)", () => {
  it("returns eligibility scoped to the caller — NOT captured by /:sessionId", async () => {
    let seen: unknown[] = [];
    let bySessionCalled = false;
    setService("canUseRoast", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { allowed: true, isFreeRoast: true } };
    });
    setService("getRoastBySessionId", async () => {
      bySessionCalled = true;
      return { success: false, error: "Roast not found" };
    });
    const res = await app.request("/v1/roast/can-use", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1"]);
    assert.equal(bySessionCalled, false); // route-order guard
    const body = await res.json();
    assert.equal(body.data.allowed, true);
    assert.equal(body.data.isFreeRoast, true);
  });

  it("a service failure → 500", async () => {
    setService("canUseRoast", async () => ({
      success: false,
      error: "Failed to check credit availability",
      code: "INTERNAL",
    }));
    const res = await app.request("/v1/roast/can-use", { headers: AUTH });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/roast — start async roast
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/roast (P2b)", () => {
  it("starts via startRoast(userId, body) → 202 { sessionId, warnings? }", async () => {
    let seen: unknown[] = [];
    setService("startRoast", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { sessionId: "ro_1", warnings: ["ZERODHA session expired"] },
      };
    });
    const res = await app.request("/v1/roast", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ mode: "overall", assetType: "all" }),
    });
    assert.equal(res.status, 202);
    assert.equal(seen[0], "mongo_1");
    const input = seen[1] as { mode: string; assetType: string };
    assert.equal(input.mode, "overall");
    assert.equal(input.assetType, "all");
    const body = await res.json();
    assert.equal(body.data.sessionId, "ro_1");
    assert.deepEqual(body.data.warnings, ["ZERODHA session expired"]);
  });

  it("rejects a bad mode / missing assetType with 400 (service untouched)", async () => {
    let called = false;
    setService("startRoast", async () => {
      called = true;
      return { success: true, data: { sessionId: "x" } };
    });
    for (const bad of [
      {}, // missing mode + assetType
      { mode: "overall" }, // missing assetType
      { mode: "everything", assetType: "all" }, // bad mode enum
      { mode: "broker", assetType: "crypto" }, // bad assetType enum
    ]) {
      const res = await app.request("/v1/roast", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(bad),
      });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} must 400`);
    }
    assert.equal(called, false);
  });

  it("maps UPGRADE_REQUIRED / NO_CREDITS → 403 and INTERNAL → 500", async () => {
    for (const code of ["UPGRADE_REQUIRED", "NO_CREDITS"]) {
      setService("startRoast", async () => ({
        success: false,
        error: "gated",
        code,
      }));
      const res = await app.request("/v1/roast", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ mode: "overall", assetType: "all" }),
      });
      assert.equal(res.status, 403, `${code} → 403`);
      assert.equal((await res.json()).error.code, "FORBIDDEN");
    }

    setService("startRoast", async () => ({
      success: false,
      error: "Failed to start roast. Please try again.",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/roast", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ mode: "overall", assetType: "all" }),
    });
    assert.equal(internal.status, 500);
  });

  it("maps a broker-state code (NOT_CONNECTED) → 400 with errorType in details", async () => {
    setService("startRoast", async () => ({
      success: false,
      error: "ZERODHA is not connected. Go to the Brokers page to connect it.",
      code: "NOT_CONNECTED",
    }));
    const res = await app.request("/v1/roast", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        mode: "broker",
        broker: "ZERODHA",
        assetType: "stocks",
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.equal(body.error.details.errorType, "NOT_CONNECTED");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/compare — start async deep comparison
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/compare (P2b)", () => {
  it("starts via startComparison(userId, { kind, symbols, depth }) → 202 { sessionId }", async () => {
    let seen: unknown[] = [];
    setService("startComparison", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { sessionId: "cmp_1" } };
    });
    const res = await app.request("/v1/compare", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        kind: "mf",
        symbols: ["120503", "119551"],
        depth: "comprehensive",
      }),
    });
    assert.equal(res.status, 202);
    assert.equal(seen[0], "mongo_1");
    const input = seen[1] as {
      kind: string;
      symbols: string[];
      depth: string;
    };
    assert.equal(input.kind, "mf");
    assert.deepEqual(input.symbols, ["120503", "119551"]);
    assert.equal(input.depth, "comprehensive");
    assert.equal((await res.json()).data.sessionId, "cmp_1");
  });

  it("defaults depth to 'deep' when omitted", async () => {
    let seen: unknown[] = [];
    setService("startComparison", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { sessionId: "cmp_2" } };
    });
    const res = await app.request("/v1/compare", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ kind: "stock", symbols: ["TCS", "INFY"] }),
    });
    assert.equal(res.status, 202);
    assert.equal((seen[1] as { depth: string }).depth, "deep");
  });

  it("rejects <2, >5 symbols and a bad kind with 400 (service untouched)", async () => {
    let called = false;
    setService("startComparison", async () => {
      called = true;
      return { success: true, data: { sessionId: "x" } };
    });
    for (const bad of [
      { kind: "mf", symbols: ["ONE"] }, // <2
      {
        kind: "mf",
        symbols: ["A", "B", "C", "D", "E", "F"], // >5
      },
      { kind: "crypto", symbols: ["A", "B"] }, // bad kind
      { symbols: ["A", "B"] }, // missing kind
    ]) {
      const res = await app.request("/v1/compare", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(bad),
      });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} must 400`);
    }
    assert.equal(called, false);
  });

  it("maps UPGRADE_REQUIRED / NO_CREDITS → 403, INVALID_INPUT → 400, INTERNAL → 500", async () => {
    const body = JSON.stringify({ kind: "mf", symbols: ["A", "B"] });
    for (const [code, status] of [
      ["UPGRADE_REQUIRED", 403],
      ["NO_CREDITS", 403],
      ["INVALID_INPUT", 400],
      ["INTERNAL", 500],
    ] as const) {
      setService("startComparison", async () => ({
        success: false,
        error: "x",
        code,
      }));
      const res = await app.request("/v1/compare", {
        method: "POST",
        headers: JSON_HEADERS,
        body,
      });
      assert.equal(res.status, status, `${code} → ${status}`);
    }
  });
});

describe("Contract: GET /v1/compare/:sessionId/status + /result (P2b)", () => {
  it("status polls getComparisonStatus(sessionId, userId) — sessionId FIRST", async () => {
    let seen: unknown[] = [];
    setService("getComparisonStatus", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { status: "RESEARCHING", progress: 40 } };
    });
    const res = await app.request("/v1/compare/s1/status", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["s1", "mongo_1"]);
    assert.equal((await res.json()).data.progress, 40);
  });

  it("result reads getComparisonBySessionId(sessionId, userId); missing → 404", async () => {
    let seen: unknown[] = [];
    setService("getComparisonBySessionId", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { sessionId: "s1", kind: "mf", result: {} },
      };
    });
    const ok = await app.request("/v1/compare/s1/result", { headers: AUTH });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen, ["s1", "mongo_1"]);

    setService("getComparisonBySessionId", async () => ({
      success: false,
      error: "Comparison not found",
    }));
    const missing = await app.request("/v1/compare/ghost/result", {
      headers: AUTH,
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "NOT_FOUND");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /v1/analysis — start; status / result / cancel
// ════════════════════════════════════════════════════════════════════════════

describe("Contract: POST /v1/analysis (P2b)", () => {
  it("starts via startComprehensiveAnalysis(userId, body) → 202 with pipeline meta", async () => {
    let seen: unknown[] = [];
    setService("startComprehensiveAnalysis", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: {
          sessionId: "l3-abc",
          estimatedMinutes: 15,
          creditsReserved: 10,
          totalSegments: 6,
        },
      };
    });
    const res = await app.request("/v1/analysis", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        analysisType: "comprehensive_stock",
        query: "Deep dive TCS",
        symbols: ["TCS"],
      }),
    });
    assert.equal(res.status, 202);
    assert.equal(seen[0], "mongo_1");
    const input = seen[1] as { analysisType: string; query: string };
    assert.equal(input.analysisType, "comprehensive_stock");
    assert.equal(input.query, "Deep dive TCS");
    const body = await res.json();
    assert.equal(body.data.sessionId, "l3-abc");
    assert.equal(body.data.totalSegments, 6);
  });

  it("rejects a missing analysisType / query with 400 (service untouched)", async () => {
    let called = false;
    setService("startComprehensiveAnalysis", async () => {
      called = true;
      return { success: true, data: {} };
    });
    for (const bad of [
      {},
      { analysisType: "comprehensive_stock" }, // missing query
      { query: "x" }, // missing analysisType
    ]) {
      const res = await app.request("/v1/analysis", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(bad),
      });
      assert.equal(res.status, 400, `${JSON.stringify(bad)} must 400`);
    }
    assert.equal(called, false);
  });

  it("rejects an analysisType outside the ANALYSIS_COSTS catalogue with 400 (C2#2 — was a 500 TypeError deep in estimateAnalysisCost)", async () => {
    let called = false;
    setService("startComprehensiveAnalysis", async () => {
      called = true;
      return { success: true, data: {} };
    });
    for (const badType of [
      "comprehensive", // close-but-wrong key
      "stock_analysis", // free-text that used to pass the 1-60-char gate
      "COMPREHENSIVE_STOCK", // wrong case
    ]) {
      const res = await app.request("/v1/analysis", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ analysisType: badType, query: "x" }),
      });
      assert.equal(res.status, 400, `${badType} must 400`);
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(called, false);

    // Every REAL catalogue key still passes validation and reaches the service.
    for (const goodType of [
      "comprehensive_stock",
      "multi_comparison",
      "portfolio_optimization",
      "portfolio_roast",
      "l4_comprehensive",
      "mf_analysis",
      "mf_comparison_deep",
      "mf_comparison_comprehensive",
      "mf_comparison_advanced",
      "mf_comparison_custom",
    ]) {
      called = false;
      setService("startComprehensiveAnalysis", async (...args: unknown[]) => {
        called = true;
        assert.equal(
          (args[1] as { analysisType: string }).analysisType,
          goodType,
        );
        return { success: true, data: { sessionId: "s" } };
      });
      const res = await app.request("/v1/analysis", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ analysisType: goodType, query: "x" }),
      });
      assert.equal(res.status, 202, `${goodType} must start`);
      assert.equal(called, true, `${goodType} must reach the service`);
    }
  });

  it("maps CONFLICT → 409, NO_CREDITS → 403, INTERNAL → 500", async () => {
    const body = JSON.stringify({
      analysisType: "comprehensive_stock",
      query: "x",
    });
    for (const [code, status] of [
      ["CONFLICT", 409],
      ["NO_CREDITS", 403],
      ["INTERNAL", 500],
    ] as const) {
      setService("startComprehensiveAnalysis", async () => ({
        success: false,
        error: "x",
        code,
      }));
      const res = await app.request("/v1/analysis", {
        method: "POST",
        headers: JSON_HEADERS,
        body,
      });
      assert.equal(res.status, status, `${code} → ${status}`);
    }
  });
});

describe("Contract: /v1/analysis/:sessionId status/result/cancel (P2b)", () => {
  it("status polls getAnalysisStatus(userId, sessionId) — userId FIRST", async () => {
    let seen: unknown[] = [];
    setService("getAnalysisStatus", async (...args: unknown[]) => {
      seen = args;
      return {
        success: true,
        data: { status: "SEGMENT_RUNNING", progress: 33, totalSegments: 6 },
      };
    });
    const res = await app.request("/v1/analysis/l3-x/status", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ["mongo_1", "l3-x"]);
    assert.equal((await res.json()).data.progress, 33);
  });

  it("status maps NOT_FOUND → 404 and INTERNAL → 500", async () => {
    setService("getAnalysisStatus", async () => ({
      success: false,
      error: "Analysis session not found",
      code: "NOT_FOUND",
    }));
    const missing = await app.request("/v1/analysis/ghost/status", {
      headers: AUTH,
    });
    assert.equal(missing.status, 404);

    setService("getAnalysisStatus", async () => ({
      success: false,
      error: "Failed to get analysis status",
      code: "INTERNAL",
    }));
    const internal = await app.request("/v1/analysis/l3-x/status", {
      headers: AUTH,
    });
    assert.equal(internal.status, 500);
  });

  it("result maps a not-complete session (CONFLICT) → 409; missing → 404", async () => {
    setService("getAnalysisResult", async () => ({
      success: false,
      error: "Analysis is not complete yet. Current status: SEGMENT_RUNNING",
      code: "CONFLICT",
    }));
    const notReady = await app.request("/v1/analysis/l3-x/result", {
      headers: AUTH,
    });
    assert.equal(notReady.status, 409);
    assert.equal((await notReady.json()).error.code, "CONFLICT");

    setService("getAnalysisResult", async () => ({
      success: false,
      error: "Analysis session not found",
      code: "NOT_FOUND",
    }));
    const missing = await app.request("/v1/analysis/ghost/result", {
      headers: AUTH,
    });
    assert.equal(missing.status, 404);
  });

  it("cancel calls cancelAnalysis(userId, sessionId) → 200 { refunded }; already-done → 409", async () => {
    let seen: unknown[] = [];
    setService("cancelAnalysis", async (...args: unknown[]) => {
      seen = args;
      return { success: true, data: { refunded: 1 } };
    });
    const ok = await app.request("/v1/analysis/l3-x/cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen, ["mongo_1", "l3-x"]);
    assert.equal((await ok.json()).data.refunded, 1);

    setService("cancelAnalysis", async () => ({
      success: false,
      error: "Cannot cancel analysis in COMPLETED status",
      code: "CONFLICT",
    }));
    const done = await app.request("/v1/analysis/l3-y/cancel", {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(done.status, 409);
  });
});
