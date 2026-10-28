/**
 * MONEY-1204 / P14 Discover-Sections HTTP Contract Tests — API Server
 *
 * The `apps/api` mirror of the nine server actions the P14 lane shipped without
 * one. The standing rule is that every web server action has an `apps/api`
 * twin; `apps/web/lib/actions/discover-sections.ts` and
 * `mf-portfolio-section.ts` both cite that rule in their headers as the reason
 * they are thin wrappers, and the mirror is what makes the claim true.
 *
 *   GET /v1/discover/flows                        getInstitutionalFlows
 *   GET /v1/discover/positioning                  getMarketPositioning
 *   GET /v1/discover/macro                        getMacroStrip
 *   GET /v1/discover/ipos                         getIpoSections
 *   GET /v1/discover/ipos/dashboard               getIpoDashboardCard
 *   GET /v1/discover/circulars                    getCircularFeed
 *   GET /v1/discover/indices/:slug                getIndexDetail
 *   GET /v1/discover/mfs/:schemeCode/portfolio    getMfPortfolioSection
 *   GET /v1/stocks/:symbol/circulars              getCircularsForSymbol
 *
 * Each endpoint is asserted on four things:
 *   1. reachable, 200, and the PROVENANCE ENVELOPE survives intact — the route
 *      passes `ServiceResult.data` (`{ data, source, asOf, empty }`) through
 *      rather than unwrapping it. A client that cannot see `source`/`asOf`
 *      cannot tell a stale panel from a live one, which is the only reason the
 *      envelope exists.
 *   2. the service seam receives EXACTLY the args the route promises, and NO
 *      userId (all nine are global market/reference data).
 *   3. bad input → 400 BEFORE the service is called (`calls.length === 0`).
 *   4. `empty: true` is a 200, never a 404 — the house contract. The single
 *      404 in the lane is an index slug that names no index at all.
 *
 * Same ESM stubbing seam as parity-p4d-contract: `require.cache` seeded with a
 * `@usemoney/services` Proxy + a configurable `@clerk/backend` verifier, then
 * the apps/api/src modules are purged and re-required so their imports resolve
 * to the stubs.
 *
 * Source: apps/api/src/routes/v1/{discover,stocks}.ts
 *         apps/web/lib/actions/{discover-sections,mf-portfolio-section}.ts
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

beforeEach(() => {
  verifyImpl = async () => ({ sub: "clerk_default" });
  serviceImpls.clear();
  setService("resolveUserId", async () => "mongo_1");
});

/** Record every call's args for one service fn; respond with `result`. */
function captureService(name: string, result: unknown): { calls: unknown[][] } {
  const calls: unknown[][] = [];
  setService(name, async (...args: unknown[]) => {
    calls.push(args);
    return result;
  });
  return { calls };
}

/** A `ServiceResult<WithProvenance<T>>` success, as every P14 service returns. */
function envelope<T>(
  data: T,
  meta: { source?: string | null; asOf?: string | null; empty?: boolean } = {},
) {
  // `??` would be wrong here: an explicit `source: null` is a REAL value (the
  // envelope's "we do not know where this came from"), and defaulting it away
  // would make the null-provenance case untestable.
  return {
    success: true as const,
    data: {
      data,
      source: "source" in meta ? meta.source : "nse-test-feed",
      asOf: "asOf" in meta ? meta.asOf : "2026-08-14T00:00:00.000Z",
      empty: meta.empty ?? false,
    },
  };
}

/**
 * The four things every one of these routes must do with a provenance payload.
 *
 * Factored because nine hand-written copies is nine chances to assert on
 * `body.data.source` in eight of them and forget in the ninth — which is
 * exactly the drift the envelope was added to prevent.
 */
async function assertEnvelopePassthrough(
  url: string,
  serviceName: string,
  payload: unknown,
): Promise<{ calls: unknown[][] }> {
  const cap = captureService(serviceName, envelope(payload));
  const res = await app.request(url, { headers: AUTH });
  assert.equal(res.status, 200, `${url} must be reachable`);
  const body = await res.json();
  assert.equal(body.success, true);
  // The envelope, not the bare rows: `data.data` is the payload and the
  // sibling keys are the provenance the client renders.
  assert.deepEqual(body.data.data, payload);
  assert.equal(body.data.source, "nse-test-feed");
  assert.equal(body.data.asOf, "2026-08-14T00:00:00.000Z");
  assert.equal(body.data.empty, false);
  assert.equal(cap.calls.length, 1, `${serviceName} called exactly once`);
  return cap;
}

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/flows — getInstitutionalFlows
// ════════════════════════════════════════════════════════════════════════════

describe("P14 Contract: GET /v1/discover/flows", () => {
  it("is reachable and passes the provenance envelope through", async () => {
    const cap = await assertEnvelopePassthrough(
      "/v1/discover/flows",
      "getInstitutionalFlows",
      { series: [{ date: "2026-08-14", fii: -1200.5, dii: 980.25 }] },
    );
    // No args given → an empty object, NOT undefined: the action calls
    // `getInstitutionalFlows(args ?? {})`.
    assert.deepEqual(cap.calls[0]?.[0], {});
  });

  it("forwards windowSessions + segment verbatim (the service owns the clamp)", async () => {
    const cap = captureService("getInstitutionalFlows", envelope({}));
    const res = await app.request(
      "/v1/discover/flows?windowSessions=60&segment=FNO",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], { windowSessions: 60, segment: "FNO" });
  });

  it("passes NO userId — global market data", async () => {
    const cap = captureService("getInstitutionalFlows", envelope({}));
    await app.request("/v1/discover/flows", { headers: AUTH });
    assert.equal(cap.calls[0]?.length, 1);
    assert.equal(
      JSON.stringify(cap.calls[0]).includes("mongo_1"),
      false,
      "no userId may reach a global read",
    );
  });

  it("rejects an unknown ?segment with 400 (never calls the service)", async () => {
    const cap = captureService("getInstitutionalFlows", envelope({}));
    for (const bad of ["EQUITY", "cash", "'; DROP"]) {
      const res = await app.request(
        `/v1/discover/flows?segment=${encodeURIComponent(bad)}`,
        { headers: AUTH },
      );
      assert.equal(res.status, 400, `${bad} must 400`);
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(cap.calls.length, 0);
  });

  it("rejects a non-integer ?windowSessions with 400", async () => {
    const cap = captureService("getInstitutionalFlows", envelope({}));
    for (const bad of ["abc", "1.5"]) {
      const res = await app.request(
        `/v1/discover/flows?windowSessions=${bad}`,
        { headers: AUTH },
      );
      assert.equal(res.status, 400, `${bad} must 400`);
    }
    assert.equal(cap.calls.length, 0);
  });

  it("maps a service failure to 500", async () => {
    setService("getInstitutionalFlows", async () => ({
      success: false,
      error: "Failed to load institutional flows",
    }));
    const res = await app.request("/v1/discover/flows", { headers: AUTH });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });

  it("requires a Bearer token", async () => {
    const res = await app.request("/v1/discover/flows");
    assert.equal(res.status, 401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/positioning — getMarketPositioning
// ════════════════════════════════════════════════════════════════════════════

describe("P14 Contract: GET /v1/discover/positioning", () => {
  it("is reachable and passes the provenance envelope through", async () => {
    const cap = await assertEnvelopePassthrough(
      "/v1/discover/positioning",
      "getMarketPositioning",
      { legs: [], participants: ["FII", "DII", "CLIENT", "PRO"] },
    );
    assert.deepEqual(cap.calls[0]?.[0], {});
  });

  it("forwards participant + metric", async () => {
    const cap = captureService("getMarketPositioning", envelope({}));
    const res = await app.request(
      "/v1/discover/positioning?participant=DII&metric=VOLUME",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], {
      participant: "DII",
      metric: "VOLUME",
    });
  });

  it("400s an unrecognised ?metric rather than silently serving OI", async () => {
    // discover-sections.service.ts:278 coerces anything outside
    // PARTICIPANT_METRICS to "OI". Served through the route that would mean a
    // typo'd `?metric=VOL` returns open interest labelled as the caller asked
    // for, with no way to notice. The enum is the only thing that tells them.
    const cap = captureService("getMarketPositioning", envelope({}));
    for (const bad of ["VOL", "oi", "PRICE"]) {
      const res = await app.request(`/v1/discover/positioning?metric=${bad}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 400, `${bad} must 400`);
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(cap.calls.length, 0);
  });

  it("400s a participant outside the cache-key-safe charset", async () => {
    const cap = captureService("getMarketPositioning", envelope({}));
    for (const bad of ["FII:*", "a".repeat(25), "*"]) {
      const res = await app.request(
        `/v1/discover/positioning?participant=${encodeURIComponent(bad)}`,
        { headers: AUTH },
      );
      assert.equal(res.status, 400, `${bad} must 400`);
    }
    assert.equal(cap.calls.length, 0);
  });

  it("accepts a participant NSE has not published yet (list is data, not an enum)", async () => {
    const cap = captureService("getMarketPositioning", envelope({}));
    const res = await app.request(
      "/v1/discover/positioning?participant=CUSTODIAN",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], { participant: "CUSTODIAN" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/macro — getMacroStrip
// ════════════════════════════════════════════════════════════════════════════

describe("P14 Contract: GET /v1/discover/macro", () => {
  it("is reachable and passes the provenance envelope through", async () => {
    const cap = await assertEnvelopePassthrough(
      "/v1/discover/macro",
      "getMacroStrip",
      { tiles: [{ seriesId: "repo-rate", value: 6.5, period: "2026-08-01" }] },
    );
    // The action calls `getMacroStrip({})` — parameterless by design.
    assert.deepEqual(cap.calls[0]?.[0], {});
  });

  it("ignores a ?seriesIds a caller invents (the surface is not exposed)", async () => {
    const cap = captureService("getMacroStrip", envelope({}));
    const res = await app.request(
      "/v1/discover/macro?seriesIds=anything,at,all",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], {});
  });

  it("maps a service failure to 500", async () => {
    setService("getMacroStrip", async () => ({
      success: false,
      error: "Failed to load macro indicators",
    }));
    const res = await app.request("/v1/discover/macro", { headers: AUTH });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/ipos + /ipos/dashboard — getIpoSections / getIpoDashboardCard
// ════════════════════════════════════════════════════════════════════════════

describe("P14 Contract: GET /v1/discover/ipos", () => {
  it("is reachable and passes the provenance envelope through", async () => {
    const cap = await assertEnvelopePassthrough(
      "/v1/discover/ipos",
      "getIpoSections",
      { upcoming: [], current: [], recent: [] },
    );
    assert.deepEqual(cap.calls[0]?.[0], {});
  });

  it("forwards ?recentDays", async () => {
    const cap = captureService("getIpoSections", envelope({}));
    const res = await app.request("/v1/discover/ipos?recentDays=90", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], { recentDays: 90 });
  });

  it("400s a non-integer ?recentDays", async () => {
    const cap = captureService("getIpoSections", envelope({}));
    const res = await app.request("/v1/discover/ipos?recentDays=ninety", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal(cap.calls.length, 0);
  });

  it("serves an EMPTY calendar as 200 + empty:true, never a 404", async () => {
    setService("getIpoSections", async () =>
      envelope({ upcoming: [], current: [], recent: [] }, { empty: true }),
    );
    const res = await app.request("/v1/discover/ipos", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.empty, true);
  });
});

describe("P14 Contract: GET /v1/discover/ipos/dashboard", () => {
  it("resolves to the DASHBOARD service, not the sections one", async () => {
    // The static child must not be captured by anything registered for /ipos.
    const sections = captureService("getIpoSections", envelope({}));
    const cap = await assertEnvelopePassthrough(
      "/v1/discover/ipos/dashboard",
      "getIpoDashboardCard",
      {
        openCount: 2,
        closingToday: [],
        open: [],
        nextOpen: null,
        empty: false,
      },
    );
    assert.deepEqual(cap.calls[0]?.[0], {});
    assert.equal(
      sections.calls.length,
      0,
      "/ipos must not shadow /ipos/dashboard",
    );
  });

  it("forwards ?limit", async () => {
    const cap = captureService("getIpoDashboardCard", envelope({}));
    const res = await app.request("/v1/discover/ipos/dashboard?limit=5", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], { limit: 5 });
  });

  it("400s a non-integer ?limit", async () => {
    const cap = captureService("getIpoDashboardCard", envelope({}));
    const res = await app.request("/v1/discover/ipos/dashboard?limit=many", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal(cap.calls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/circulars — getCircularFeed
// ════════════════════════════════════════════════════════════════════════════

describe("P14 Contract: GET /v1/discover/circulars", () => {
  it("is reachable and passes the provenance envelope through", async () => {
    const cap = await assertEnvelopePassthrough(
      "/v1/discover/circulars",
      "getCircularFeed",
      { circulars: [], departments: [], hasMore: false },
    );
    assert.deepEqual(cap.calls[0]?.[0], {});
  });

  it("forwards department/topic/limit/skip", async () => {
    const cap = captureService("getCircularFeed", envelope({}));
    const res = await app.request(
      "/v1/discover/circulars?department=Surveillance&topic=ASM&limit=25&skip=50",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], {
      department: "Surveillance",
      topic: "ASM",
      limit: 25,
      skip: 50,
    });
  });

  it("caps ?skip at the route — the service only floors it at 0", async () => {
    // `skip` reaches BOTH a Prisma offset and the service cache key with no
    // upper bound on that side, so the ceiling has to live here.
    const cap = captureService("getCircularFeed", envelope({}));
    for (const bad of ["10001", "999999999", "-1"]) {
      const res = await app.request(`/v1/discover/circulars?skip=${bad}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 400, `skip=${bad} must 400`);
      assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    }
    assert.equal(cap.calls.length, 0);
  });

  it("400s an over-long ?department", async () => {
    const cap = captureService("getCircularFeed", envelope({}));
    const res = await app.request(
      `/v1/discover/circulars?department=${"x".repeat(65)}`,
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal(cap.calls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/indices/:slug — getIndexDetail
// ════════════════════════════════════════════════════════════════════════════

describe("P14 Contract: GET /v1/discover/indices/:slug", () => {
  it("is reachable and passes the provenance envelope through", async () => {
    const cap = await assertEnvelopePassthrough(
      "/v1/discover/indices/nifty-50",
      "getIndexDetail",
      {
        route: { indexSlug: "nifty-50", indexId: "nifty50", known: true },
        detail: {},
        constituents: {},
        membership: {},
      },
    );
    assert.deepEqual(cap.calls[0]?.[0], { slug: "nifty-50" });
  });

  it("forwards ?sessions", async () => {
    const cap = captureService("getIndexDetail", envelope({}));
    const res = await app.request(
      "/v1/discover/indices/nifty-bank?sessions=365",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], { slug: "nifty-bank", sessions: 365 });
  });

  it("serves an index with NO constituent list as 200 — that is the normal case", async () => {
    // ~90 of the indices NSE publishes closes for have no constituent list;
    // 404ing one would be wrong.
    setService("getIndexDetail", async () =>
      envelope({
        route: { indexSlug: "nifty-alpha-50", indexId: null, known: false },
        detail: { closes: [1, 2] },
        constituents: { rows: [] },
        membership: { rows: [] },
      }),
    );
    const res = await app.request("/v1/discover/indices/nifty-alpha-50", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.data.constituents.rows.length, 0);
  });

  it('maps the service\'s "Unknown index" leg to 404, not 500', async () => {
    setService("getIndexDetail", async () => ({
      success: false,
      error: "Unknown index",
    }));
    const res = await app.request("/v1/discover/indices/---", {
      headers: AUTH,
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, "NOT_FOUND");
  });

  it("maps a genuine service failure to 500", async () => {
    setService("getIndexDetail", async () => ({
      success: false,
      error: "Failed to load index detail",
    }));
    const res = await app.request("/v1/discover/indices/nifty-50", {
      headers: AUTH,
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });

  it("400s an over-long slug before any service call", async () => {
    const cap = captureService("getIndexDetail", envelope({}));
    const res = await app.request(`/v1/discover/indices/${"n".repeat(65)}`, {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal(cap.calls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/discover/mfs/:schemeCode/portfolio — getMfPortfolioSection
// ════════════════════════════════════════════════════════════════════════════

describe("P14 Contract: GET /v1/discover/mfs/:schemeCode/portfolio", () => {
  it("is reachable and passes the provenance envelope through", async () => {
    const cap = await assertEnvelopePassthrough(
      "/v1/discover/mfs/120503/portfolio",
      "getMfPortfolioSection",
      {
        lines: [{ instrumentName: "RELIANCE", percentToNav: 8.2 }],
        diff: { entered: [], exited: [] },
        totals: { totalPct: 98.4, disclosed: 42, undisclosed: 1.6 },
        unresolvedSchemes: [],
      },
    );
    assert.deepEqual(cap.calls[0]?.[0], { schemeCode: "120503" });
  });

  it("does NOT shadow the sibling /mfs/by-scheme-codes literal", async () => {
    const portfolio = captureService("getMfPortfolioSection", envelope({}));
    const cap = captureService("getMfsBySchemeCodes", {
      success: true,
      data: [],
    });
    const res = await app.request(
      "/v1/discover/mfs/by-scheme-codes?codes=120503",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.equal(cap.calls.length, 1);
    assert.equal(portfolio.calls.length, 0);
  });

  it("400s an over-long scheme code (the web action's 24-char bound)", async () => {
    const cap = captureService("getMfPortfolioSection", envelope({}));
    const res = await app.request(
      `/v1/discover/mfs/${"1".repeat(25)}/portfolio`,
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(cap.calls.length, 0);
  });

  it("serves an undisclosed fund as 200 + empty:true, never a 404", async () => {
    setService("getMfPortfolioSection", async () =>
      envelope(
        {
          lines: [],
          diff: { entered: [], exited: [] },
          totals: { totalPct: 0, disclosed: 0, undisclosed: 0 },
          unresolvedSchemes: [],
        },
        { empty: true, source: null, asOf: null },
      ),
    );
    const res = await app.request("/v1/discover/mfs/999999/portfolio", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.empty, true);
    assert.equal(body.data.source, null);
  });

  it("maps a service failure to 500", async () => {
    setService("getMfPortfolioSection", async () => ({
      success: false,
      error: "Failed to load fund portfolio",
    }));
    const res = await app.request("/v1/discover/mfs/120503/portfolio", {
      headers: AUTH,
    });
    assert.equal(res.status, 500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /v1/stocks/:symbol/circulars — getCircularsForSymbol
// ════════════════════════════════════════════════════════════════════════════

describe("P14 Contract: GET /v1/stocks/:symbol/circulars", () => {
  const PAYLOAD = {
    matches: [{ key: "NSE/2026/001::Surveillance", confidence: "company" }],
    disclaimer: "Matched by ticker mention; may include false positives.",
  };

  it("is reachable and passes the provenance envelope through", async () => {
    const cap = await assertEnvelopePassthrough(
      "/v1/stocks/RELIANCE/circulars",
      "getCircularsForSymbol",
      PAYLOAD,
    );
    // `departments` is OMITTED, not `[]` — an empty `in` filter matches nothing,
    // so the service must be left to apply its own ["Surveillance"] default.
    assert.deepEqual(cap.calls[0]?.[0], { symbol: "RELIANCE" });
  });

  it("keeps the disclaimer in the body (the client must render it)", async () => {
    captureService("getCircularsForSymbol", envelope(PAYLOAD));
    const res = await app.request("/v1/stocks/RELIANCE/circulars", {
      headers: AUTH,
    });
    assert.equal(
      (await res.json()).data.data.disclaimer,
      PAYLOAD.disclaimer,
      "the heuristic caveat travels with the payload",
    );
  });

  it("forwards a CSV ?departments plus limit + days", async () => {
    const cap = captureService("getCircularsForSymbol", envelope(PAYLOAD));
    const res = await app.request(
      "/v1/stocks/TCS/circulars?departments=Surveillance,Listing&limit=6&days=90",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], {
      symbol: "TCS",
      departments: ["Surveillance", "Listing"],
      limit: 6,
      days: 90,
    });
  });

  it("400s a bad symbol before any service call", async () => {
    const cap = captureService("getCircularsForSymbol", envelope(PAYLOAD));
    // Over the 24-char SymbolSchema bound.
    const res = await app.request(`/v1/stocks/${"A".repeat(25)}/circulars`, {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(cap.calls.length, 0);
  });

  it("400s an over-long ?departments list", async () => {
    const cap = captureService("getCircularsForSymbol", envelope(PAYLOAD));
    const res = await app.request(
      `/v1/stocks/RELIANCE/circulars?departments=${Array.from(
        { length: 13 },
        (_v, i) => `d${i}`,
      ).join(",")}`,
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal(cap.calls.length, 0);
  });

  it("400s a non-integer ?limit / ?days", async () => {
    const cap = captureService("getCircularsForSymbol", envelope(PAYLOAD));
    for (const q of ["limit=six", "days=1.5"]) {
      const res = await app.request(`/v1/stocks/RELIANCE/circulars?${q}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 400, `${q} must 400`);
    }
    assert.equal(cap.calls.length, 0);
  });

  it("does not shadow, and is not shadowed by, the sibling stock sections", async () => {
    const circulars = captureService(
      "getCircularsForSymbol",
      envelope(PAYLOAD),
    );
    const flags = captureService("getStockFlagsAndIndexes", {
      success: true,
      data: { data: { flags: [] }, source: "NSE", asOf: null, empty: true },
    });
    const res = await app.request("/v1/stocks/RELIANCE/flags", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(flags.calls.length, 1);
    assert.equal(circulars.calls.length, 0);
  });

  it("maps a service failure to 500", async () => {
    setService("getCircularsForSymbol", async () => ({
      success: false,
      error: "Failed to load circulars",
    }));
    const res = await app.request("/v1/stocks/RELIANCE/circulars", {
      headers: AUTH,
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "INTERNAL_ERROR");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Catalogue — the mirror is advertised, and the family count did NOT move
// ════════════════════════════════════════════════════════════════════════════

describe("P14 Contract: /v1/ catalogue", () => {
  it("keeps 38 families — the nine mirrors are routes inside existing ones", async () => {
    const res = await app.request("/v1", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.endpoints.length, 38);
  });

  it("advertises the new sections on their families", async () => {
    const res = await app.request("/v1", { headers: AUTH });
    const endpoints: Array<{ path: string; description: string }> = (
      await res.json()
    ).data.endpoints;
    const discover = endpoints.find((e) => e.path === "/v1/discover");
    const stocks = endpoints.find((e) => e.path === "/v1/stocks");
    for (const frag of [
      "flows",
      "positioning",
      "macro",
      "ipos",
      "circulars",
      "indices/:slug",
      "mfs/:schemeCode/portfolio",
    ]) {
      assert.ok(
        discover?.description.includes(frag),
        `/v1/discover must advertise ${frag}`,
      );
    }
    assert.ok(stocks?.description.includes("circulars"));
  });

  it("the market family advertises us/quotes and no longer claims blanket delay", async () => {
    // MONEY-1309 follow-up. This array is SERVED TO CLIENTS and read
    // "Delayed market data (quotes, OHLC, indices, MF NAV)" — a compliance
    // claim the family stopped making 480 lines below, where `us/quotes`
    // derives `delayed` per quote. The endpoint was also simply absent.
    const res = await app.request("/v1", { headers: AUTH });
    const endpoints: Array<{ path: string; description: string }> = (
      await res.json()
    ).data.endpoints;
    const market = endpoints.find((e) => e.path === "/v1/market");
    assert.ok(market, "the /v1/market family vanished from the catalogue");
    assert.ok(
      market.description.includes("us/quotes"),
      `/v1/market must advertise us/quotes; got: ${market.description}`,
    );
    assert.ok(
      /derived/i.test(market.description),
      "the catalogue must say `delayed` is DERIVED for the US route, not " +
        "leave a reader with the family-wide `delayed: true` claim",
    );
    // A 39th entry would be the other way to do this and is wrong: the list is
    // mounted FAMILIES, which is why the count above is pinned at 38.
    assert.equal(
      endpoints.filter((e) => e.path.startsWith("/v1/market")).length,
      1,
    );
  });
});
