/**
 * MONEY-1204 / P14 Stock-Sections HTTP Contract Tests — API Server
 *
 * The `apps/api` mirror of the nine data-engine sections lane 14c added to the
 * stock page. They landed on this branch as nine `mountStockSection(...)` calls
 * (`src/routes/v1/stocks.ts`) with NO test file: `tsc` proves the handler
 * compiles, not that the route is reachable, not that its params parse, and not
 * that the provenance envelope survives to the wire.
 *
 *   GET /v1/stocks/:symbol/flags                 getStockFlagsAndIndexes
 *   GET /v1/stocks/:symbol/delivery              getStockDeliveryTrend
 *   GET /v1/stocks/:symbol/derivatives           getStockDerivatives
 *   GET /v1/stocks/:symbol/shareholding-pattern  getStockShareholdingSection
 *   GET /v1/stocks/:symbol/insider-activity      getStockInsiderSection
 *   GET /v1/stocks/:symbol/deals                 getStockDealsSection
 *   GET /v1/stocks/:symbol/filings               getStockFilingsTimeline
 *   GET /v1/stocks/:symbol/financials-source     getStockFinancialsSource
 *   GET /v1/stocks/:symbol/funds-holding         getStockFundsHolding
 *
 * The tenth section on this family (`/:symbol/circulars`) has its own handler
 * and is covered by `parity-p14-discover-sections-contract.test.ts`; it appears
 * here only as a neighbour in the route-ordering assertions.
 *
 * WHAT EACH SECTION IS ASSERTED ON
 *   1. REACHABLE — resolves to its OWN handler and answers 200. Nine routes
 *      sharing one generic helper all compile whether or not they were mounted;
 *      only a request proves the mount.
 *   2. THE ENVELOPE SURVIVES — the body is EXACTLY
 *      `{ success: true, data: { data, source, asOf, empty } }`. A handler that
 *      re-wraps (`data.data.data`) or unwraps one level (`data` = the rows,
 *      provenance gone) still type-checks, because both shapes are objects.
 *      The whole-body `deepEqual` is what makes that invisible failure visible.
 *   3. `empty: true` IS A 200 — "the exchange has not published this" is a
 *      successful answer to a valid question, and the `WithProvenance` envelope
 *      exists precisely to carry that distinction instead of a 404.
 *   4. BAD INPUT 400s BEFORE THE SERVICE — asserted as `calls.length === 0`,
 *      not merely as a status code. A route that validates AFTER the read has
 *      already paid for the read.
 *   5. ROUTE ORDERING — every section is requested with all eighteen sibling
 *      services stubbed, and EXACTLY ONE must fire. Registration order decides
 *      this in a real Hono build (the sibling suite proves it for
 *      `/mfs/by-scheme-codes` vs `/mfs/:schemeCode/portfolio`), and two of the
 *      nine are literal PREFIX EXTENSIONS of an older, EARLIER-registered route
 *      — `shareholding` ⊂ `shareholding-pattern`, `financials` ⊂
 *      `financials-source` — which is the live hazard here.
 *
 * Same ESM stubbing seam as `parity-p4d-contract` / the P14 discover suite:
 * `require.cache` seeded with a `@usemoney/services` Proxy + a configurable
 * `@clerk/backend` verifier, then the apps/api/src modules are purged and
 * re-required so their imports resolve to the stubs.
 *
 * Source: apps/api/src/routes/v1/stocks.ts (mountStockSection + the nine mounts)
 *         apps/web/lib/actions/stock-sections-{market,ownership,docs}.ts
 *         packages/services/src/stock-sections-{market,ownership,docs}.service.ts
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

/**
 * The two Hono methods the harness drives, typed narrowly.
 *
 * The sibling suites reach these through an index signature; spelling them out
 * keeps the file clean under `noUncheckedIndexedAccess` without changing the
 * seam — same `require.cache` stubbing, same real app assembly.
 */
interface HonoLike extends Harness {
  use: (path: string, handler: unknown) => unknown;
  route: (path: string, sub: unknown) => unknown;
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

  const { Hono } = require("hono") as { Hono: new () => HonoLike };
  const { authMiddleware } = require("../../src/middleware/auth.ts") as {
    authMiddleware: unknown;
  };
  const { requestIdMiddleware } =
    require("../../src/middleware/request-id.ts") as {
      requestIdMiddleware: unknown;
    };
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

// ── typed views over the wire format ────────────────────────────────────────

/** The `{ source, asOf, empty, data }` shape `withProvenance` produces. */
interface Envelope {
  data: unknown;
  source: string | null;
  asOf: string | null;
  empty: boolean;
  fallback?: boolean;
  note?: string;
}

interface ApiBody {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
  meta?: unknown;
}

async function readBody(res: Response): Promise<ApiBody> {
  return (await res.json()) as ApiBody;
}

/** Record every call's args for one service fn; respond with `result`. */
function captureService(name: string, result: unknown): { calls: unknown[][] } {
  const calls: unknown[][] = [];
  setService(name, async (...args: unknown[]) => {
    calls.push(args);
    return result;
  });
  return { calls };
}

/** A `ServiceResult<WithProvenance<T>>` success, as all nine services return. */
function envelope(
  data: unknown,
  meta: Partial<Omit<Envelope, "data">> = {},
): { success: true; data: Envelope } {
  // `??` would be wrong for source/asOf: an explicit `null` is a REAL value
  // (the envelope's "we do not know"), and defaulting it away would make the
  // null-provenance case untestable.
  const env: Envelope = {
    data,
    source: "source" in meta ? (meta.source ?? null) : "NSE_TEST_FEED",
    asOf: "asOf" in meta ? (meta.asOf ?? null) : "2026-08-14T00:00:00.000Z",
    empty: meta.empty ?? false,
  };
  if (meta.fallback !== undefined) env.fallback = meta.fallback;
  if (meta.note !== undefined) env.note = meta.note;
  return { success: true, data: env };
}

// ── the nine sections under test ────────────────────────────────────────────

interface Section {
  /** URL segment after `/v1/stocks/:symbol/`. */
  path: string;
  /** The `@usemoney/services` export the route must call. */
  service: string;
  /** Realistic payload, so the envelope assertion is not a tautology on `{}`. */
  payload: Record<string, unknown>;
}

const SECTIONS: readonly Section[] = [
  {
    path: "flags",
    service: "getStockFlagsAndIndexes",
    payload: {
      flags: [{ kind: "ASM", value: "Stage 1", date: "2026-08-14" }],
      indexes: [{ indexName: "NIFTY 50", lastSeen: "2026-08-14" }],
    },
  },
  {
    path: "delivery",
    service: "getStockDeliveryTrend",
    payload: {
      latestPct: 43.21,
      mean20: 38.9,
      contributingSessions: 18,
      series: [{ date: "2026-08-14", deliveryPct: 43.21 }],
    },
  },
  {
    path: "derivatives",
    service: "getStockDerivatives",
    payload: {
      isFno: true,
      summary: { oi: 123456, oiChangePct: -2.4 },
      slb: null,
      slbDate: null,
      mwpl: null,
      ban: null,
    },
  },
  {
    path: "shareholding-pattern",
    service: "getStockShareholdingSection",
    payload: {
      quarters: [{ quarter: "2026-06", promoter: 50.11, public: 49.89 }],
      pledgeTrend: [{ quarter: "2026-06", pledgedPct: 0 }],
    },
  },
  {
    path: "insider-activity",
    service: "getStockInsiderSection",
    payload: {
      months: [{ month: "2026-07", events: [] }],
      net90d: { boughtValue: 0, soldValue: 0 },
    },
  },
  {
    path: "deals",
    service: "getStockDealsSection",
    payload: { bulk: [], block: [], repeatCounterparties: [] },
  },
  {
    path: "filings",
    service: "getStockFilingsTimeline",
    payload: {
      nextEvent: null,
      documents: [{ title: "Q1 FY27 results", indexedAt: "2026-08-01" }],
    },
  },
  {
    path: "financials-source",
    service: "getStockFinancialsSource",
    payload: { source: "NSE_XBRL", filings: [], basis: "STANDALONE" },
  },
  {
    path: "funds-holding",
    service: "getStockFundsHolding",
    payload: { schemes: [], asOfMonth: "2026-07" },
  },
] as const;

/** The eight legacy stock-detail tabs that share the `/v1/stocks` family. */
const LEGACY: readonly { path: string; service: string }[] = [
  { path: "financials", service: "getStockFinancials" },
  { path: "peers", service: "getStockPeers" },
  { path: "news", service: "getStockTabNews" },
  { path: "returns", service: "getStockReturns" },
  { path: "shareholding", service: "getShareholding" },
  { path: "ratios", service: "getStockRatios" },
  { path: "technicals", service: "getStockTechnicals" },
  { path: "corporate-actions", service: "getCorporateActions" },
] as const;

/** Every service `/v1/stocks` can reach — the nine, the eight, and circulars. */
const ALL_STOCK_SERVICES: readonly string[] = [
  ...SECTIONS.map((s) => s.service),
  ...LEGACY.map((s) => s.service),
  "getCircularsForSymbol",
];

/**
 * Stub EVERY stock service and record which ones fire.
 *
 * This is the route-ordering instrument: after one request, exactly one name
 * must appear. It catches shadowing in BOTH directions at once — a section
 * swallowed by an earlier route (wrong name fires) and a section that swallows
 * a sibling (the sibling's own request lands here instead).
 */
function captureAllStockServices(result: unknown): { fired: string[] } {
  const fired: string[] = [];
  for (const name of ALL_STOCK_SERVICES) {
    setService(name, async () => {
      fired.push(name);
      return result;
    });
  }
  return { fired };
}

const OK = envelope({ probe: true });

// ════════════════════════════════════════════════════════════════════════════
// Per-section contract — the nine mounted by `mountStockSection`
// ════════════════════════════════════════════════════════════════════════════

for (const section of SECTIONS) {
  const url = `/v1/stocks/RELIANCE/${section.path}`;

  describe(`P14 Stock Section: GET /v1/stocks/:symbol/${section.path}`, () => {
    it("is reachable and answers 200 from its OWN service", async () => {
      const cap = captureService(section.service, envelope(section.payload));
      const res = await app.request(url, { headers: AUTH });
      assert.equal(res.status, 200, `${url} must be mounted and reachable`);
      assert.equal(
        cap.calls.length,
        1,
        `${section.service} must be called exactly once`,
      );
    });

    it("passes the provenance envelope through UNWRAPPED — byte-for-byte", async () => {
      const env = envelope(section.payload);
      captureService(section.service, env);
      const res = await app.request(url, { headers: AUTH });
      const body = await readBody(res);
      // Whole-body equality, deliberately. `body.data` must BE the service's
      // envelope: not the rows with provenance stripped, and not the envelope
      // nested one level deeper. Both of those are objects and both compile.
      assert.deepEqual(body, { success: true, data: env.data });
      const data = body.data as Envelope;
      assert.deepEqual(data.data, section.payload, "payload under `data.data`");
      assert.equal(data.source, "NSE_TEST_FEED", "`source` reaches the client");
      assert.equal(data.asOf, "2026-08-14T00:00:00.000Z", "`asOf` survives");
      assert.equal(data.empty, false);
      assert.equal(
        (data.data as Record<string, unknown>).data,
        undefined,
        "no double-wrap",
      );
    });

    it("carries a NULL source/asOf through rather than inventing one", async () => {
      // A section that has rows but no dated provenance is a real state; the
      // client renders "source unknown", which it cannot do if the key is
      // dropped on the way out.
      captureService(
        section.service,
        envelope(section.payload, { source: null, asOf: null }),
      );
      const body = await readBody(await app.request(url, { headers: AUTH }));
      const data = body.data as Envelope;
      assert.equal(data.source, null);
      assert.equal(data.asOf, null);
      assert.ok(
        "source" in data && "asOf" in data,
        "keys are present, as null",
      );
    });

    it("calls the service with EXACTLY { symbol, exchange } and NO userId", async () => {
      const cap = captureService(section.service, OK);
      await app.request(url, { headers: AUTH });
      assert.equal(cap.calls[0]?.length, 1, "one argument object");
      assert.deepEqual(cap.calls[0]?.[0], {
        symbol: "RELIANCE",
        exchange: "NSE",
      });
      assert.equal(
        JSON.stringify(cap.calls[0]).includes("mongo_1"),
        false,
        "global market data must not be scoped by userId",
      );
    });

    it("forwards ?exchange=BSE", async () => {
      const cap = captureService(section.service, OK);
      const res = await app.request(`${url}?exchange=BSE`, { headers: AUTH });
      assert.equal(res.status, 200);
      assert.deepEqual(cap.calls[0]?.[0], {
        symbol: "RELIANCE",
        exchange: "BSE",
      });
    });

    it("serves `empty: true` as a 200, NEVER a 404", async () => {
      // "NSE has published nothing for this symbol" is a successful answer to a
      // valid question. This is the distinction the whole envelope exists for:
      // the client branches on `empty`, and a 404 would make it unreachable.
      captureService(
        section.service,
        envelope({}, { empty: true, source: null, asOf: null }),
      );
      const res = await app.request(url, { headers: AUTH });
      assert.equal(
        res.status,
        200,
        "an empty section is not a missing section",
      );
      const body = await readBody(res);
      assert.equal(body.success, true);
      const data = body.data as Envelope;
      assert.equal(data.empty, true);
      assert.deepEqual(data.data, {}, "the empty payload still ships");
    });

    it("400s a ?exchange outside the enum BEFORE the service is called", async () => {
      const cap = captureService(section.service, OK);
      // Past the enum, and past its casing: `nse` is not `NSE`. An empty
      // `?exchange=` is rejected too rather than silently defaulting to NSE —
      // the same strictness the eight legacy handlers apply.
      for (const bad of ["NYSE", "nse", "NSE ", "", "'; DROP", "NSE,BSE"]) {
        const res = await app.request(
          `${url}?exchange=${encodeURIComponent(bad)}`,
          { headers: AUTH },
        );
        assert.equal(
          res.status,
          400,
          `exchange=${JSON.stringify(bad)} must 400`,
        );
        const body = await readBody(res);
        assert.equal(body.error?.code, "VALIDATION_ERROR");
      }
      assert.equal(cap.calls.length, 0, "no read may be paid for on bad input");
    });

    it("400s an unusable :symbol BEFORE the service is called", async () => {
      const cap = captureService(section.service, OK);
      for (const bad of ["A".repeat(25), "%20%20", "%09"]) {
        const res = await app.request(`/v1/stocks/${bad}/${section.path}`, {
          headers: AUTH,
        });
        assert.equal(res.status, 400, `symbol ${bad} must 400`);
        assert.equal((await readBody(res)).error?.code, "VALIDATION_ERROR");
      }
      assert.equal(cap.calls.length, 0);
    });

    it("maps a service failure to 500 with the service's own message", async () => {
      setService(section.service, async () => ({
        success: false,
        error: `Failed to load ${section.path}`,
      }));
      const res = await app.request(url, { headers: AUTH });
      assert.equal(res.status, 500);
      const body = await readBody(res);
      assert.equal(body.error?.code, "INTERNAL_ERROR");
      assert.equal(body.error?.message, `Failed to load ${section.path}`);
    });

    it("swallows a THROWN service error into a 500 that leaks nothing", async () => {
      setService(section.service, async () => {
        throw new Error(
          "MongoServerError: E11000 duplicate key on stockbook.stock_flags",
        );
      });
      const res = await app.request(url, { headers: AUTH });
      assert.equal(res.status, 500);
      const raw = JSON.stringify(await readBody(res));
      assert.equal(
        /MongoServerError|E11000|stockbook\./.test(raw),
        false,
        "a raw DB message must never reach the wire",
      );
    });

    it("requires a Bearer token, and the service is never reached without one", async () => {
      const cap = captureService(section.service, OK);
      const res = await app.request(url);
      assert.equal(res.status, 401);
      assert.equal(cap.calls.length, 0, "unauthenticated must not read");
    });

    it("401s a verified token with no DB user, without reading", async () => {
      const cap = captureService(section.service, OK);
      setService("resolveUserId", async () => null);
      const res = await app.request(url, { headers: AUTH });
      assert.equal(res.status, 401);
      assert.equal(cap.calls.length, 0);
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Route ordering — nine literals under one `/:symbol/` param
// ════════════════════════════════════════════════════════════════════════════

describe("P14 Stock Sections: route ordering", () => {
  it("each section resolves to its OWN handler with all eighteen siblings mounted", async () => {
    for (const section of SECTIONS) {
      serviceImpls.clear();
      setService("resolveUserId", async () => "mongo_1");
      const probe = captureAllStockServices(OK);
      const res = await app.request(`/v1/stocks/RELIANCE/${section.path}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 200, `${section.path} must be reachable`);
      assert.deepEqual(
        probe.fired,
        [section.service],
        `${section.path} must resolve to ${section.service} and nothing else`,
      );
    }
  });

  it("does not shadow any of the eight legacy tabs", async () => {
    for (const legacy of LEGACY) {
      serviceImpls.clear();
      setService("resolveUserId", async () => "mongo_1");
      const probe = captureAllStockServices({ success: true, data: [] });
      const res = await app.request(`/v1/stocks/RELIANCE/${legacy.path}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 200, `${legacy.path} must still be reachable`);
      assert.deepEqual(
        probe.fired,
        [legacy.service],
        `${legacy.path} must still resolve to ${legacy.service}`,
      );
    }
  });

  it("`shareholding` and `shareholding-pattern` are two endpoints, not a prefix match", async () => {
    // The live hazard: `/:symbol/shareholding` is registered EARLIER (the
    // legacy Tickertape tab) and its literal is a strict prefix of the new
    // one. They read different tables whose `quarter` strings do not even
    // join, so a prefix match would serve the wrong data with a 200.
    const legacyCap = captureService("getShareholding", {
      success: true,
      data: { shareholding: [{ quarter: "Q3-2024" }] },
    });
    const sectionCap = captureService(
      "getStockShareholdingSection",
      envelope({ quarters: [{ quarter: "2026-06" }] }),
    );

    const a = await app.request("/v1/stocks/RELIANCE/shareholding", {
      headers: AUTH,
    });
    assert.equal(a.status, 200);
    assert.equal(legacyCap.calls.length, 1);
    assert.equal(
      sectionCap.calls.length,
      0,
      "the new route must not swallow it",
    );

    const b = await app.request("/v1/stocks/RELIANCE/shareholding-pattern", {
      headers: AUTH,
    });
    assert.equal(b.status, 200);
    assert.equal(sectionCap.calls.length, 1);
    assert.equal(
      legacyCap.calls.length,
      1,
      "the legacy route must not swallow it",
    );
    const body = await readBody(b);
    assert.deepEqual((body.data as Envelope).data, {
      quarters: [{ quarter: "2026-06" }],
    });
  });

  it("`financials` and `financials-source` are two endpoints, not a prefix match", async () => {
    const legacyCap = captureService("getStockFinancials", {
      success: true,
      data: { income: [] },
    });
    const sectionCap = captureService(
      "getStockFinancialsSource",
      envelope({ source: "NSE_XBRL" }),
    );

    const a = await app.request("/v1/stocks/TCS/financials", { headers: AUTH });
    assert.equal(a.status, 200);
    assert.equal(legacyCap.calls.length, 1);
    assert.equal(sectionCap.calls.length, 0);

    const b = await app.request("/v1/stocks/TCS/financials-source", {
      headers: AUTH,
    });
    assert.equal(b.status, 200);
    assert.equal(sectionCap.calls.length, 1);
    assert.equal(legacyCap.calls.length, 1);
  });

  it("`delivery` and `derivatives` do not collide on their shared prefix", async () => {
    const delivery = captureService(
      "getStockDeliveryTrend",
      envelope({ d: 1 }),
    );
    const derivatives = captureService(
      "getStockDerivatives",
      envelope({ d: 2 }),
    );

    const a = await readBody(
      await app.request("/v1/stocks/RELIANCE/delivery", { headers: AUTH }),
    );
    assert.deepEqual((a.data as Envelope).data, { d: 1 });

    const b = await readBody(
      await app.request("/v1/stocks/RELIANCE/derivatives", { headers: AUTH }),
    );
    assert.deepEqual((b.data as Envelope).data, { d: 2 });
    assert.equal(delivery.calls.length, 1);
    assert.equal(derivatives.calls.length, 1);
  });

  it("does not shadow the sibling `/:symbol/circulars` handler", async () => {
    const probe = captureAllStockServices(envelope({ matches: [] }));
    const res = await app.request("/v1/stocks/RELIANCE/circulars", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(probe.fired, ["getCircularsForSymbol"]);
  });

  it("an unknown section 404s and reads nothing", async () => {
    const probe = captureAllStockServices(OK);
    for (const unknown of ["flag", "flagss", "delivery-trend", "nope"]) {
      const res = await app.request(`/v1/stocks/RELIANCE/${unknown}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 404, `${unknown} must not resolve`);
    }
    assert.deepEqual(probe.fired, []);
  });

  it("a deeper path under a section 404s rather than falling back to it", async () => {
    const probe = captureAllStockServices(OK);
    for (const deeper of [
      "flags/history",
      "deals/bulk",
      "filings/1/download",
    ]) {
      const res = await app.request(`/v1/stocks/RELIANCE/${deeper}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 404, `${deeper} must not resolve`);
    }
    assert.deepEqual(probe.fired, []);
  });

  it("section names are case-sensitive", async () => {
    const probe = captureAllStockServices(OK);
    for (const cased of ["FLAGS", "Deals", "Funds-Holding"]) {
      const res = await app.request(`/v1/stocks/RELIANCE/${cased}`, {
        headers: AUTH,
      });
      assert.equal(res.status, 404, `${cased} must not resolve`);
    }
    assert.deepEqual(probe.fired, []);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Input bounds — the symbol bound, and the params the routes do NOT take
// ════════════════════════════════════════════════════════════════════════════

describe("P14 Stock Sections: input bounds", () => {
  it("accepts a symbol at exactly the 24-char bound and rejects 25", async () => {
    const cap = captureService("getStockDealsSection", OK);
    const ok = await app.request(`/v1/stocks/${"A".repeat(24)}/deals`, {
      headers: AUTH,
    });
    assert.equal(ok.status, 200, "24 chars is inside the bound");
    assert.equal(cap.calls.length, 1);

    const tooLong = await app.request(`/v1/stocks/${"A".repeat(25)}/deals`, {
      headers: AUTH,
    });
    assert.equal(tooLong.status, 400, "25 chars is over it");
    assert.equal(cap.calls.length, 1, "the rejected request read nothing");
  });

  it("trims the symbol before the length check and before the read", async () => {
    const cap = captureService("getStockFilingsTimeline", OK);
    const res = await app.request("/v1/stocks/%20RELIANCE%20/filings", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], {
      symbol: "RELIANCE",
      exchange: "NSE",
    });
  });

  it("passes a real symbol containing `&` and `-` through unmangled", async () => {
    const cap = captureService("getStockDeliveryTrend", OK);
    await app.request("/v1/stocks/M%26M/delivery", { headers: AUTH });
    assert.deepEqual(cap.calls[0]?.[0], { symbol: "M&M", exchange: "NSE" });

    const cap2 = captureService("getStockDerivatives", OK);
    await app.request("/v1/stocks/BAJAJ-AUTO/derivatives", { headers: AUTH });
    assert.deepEqual(cap2.calls[0]?.[0], {
      symbol: "BAJAJ-AUTO",
      exchange: "NSE",
    });
  });

  it("ignores query params the section does not expose, and never 400s on them", async () => {
    // House contract (same as `/v1/discover/macro` ignoring an invented
    // `?seriesIds`): an unexposed param is dropped, not an error.
    const cap = captureService("getStockDealsSection", OK);
    const res = await app.request(
      "/v1/stocks/RELIANCE/deals?limit=50&days=90&sessions=750&cursor=abc",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.calls[0]?.[0], {
      symbol: "RELIANCE",
      exchange: "NSE",
    });
  });

  it("never smuggles an unbounded ?rowsPerKind into the flags read", async () => {
    // PARITY GAP, reported not fixed: the web action `getStockFlagsAction`
    // takes `rowsPerKind` (the history-popover depth, service-clamped to
    // [1,200]); `mountStockSection` parses only `(symbol, exchange)`, so a
    // mobile client cannot ask for it at all and always gets the default.
    //
    // The assertion is written to permit that gap being CLOSED (forwarding the
    // param is the fix) while forbidding the way it would be closed wrongly —
    // an unvalidated `?rowsPerKind` reaching the service, where it lands in
    // both a Prisma `take` and the cache key `stock-flags:sym:ex:rows`.
    const cap = captureService("getStockFlagsAndIndexes", OK);
    const res = await app.request(
      "/v1/stocks/RELIANCE/flags?rowsPerKind=999999",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const args = cap.calls[0]?.[0] as Record<string, unknown> | undefined;
    const forwarded = args?.rowsPerKind;
    if (forwarded !== undefined) {
      assert.equal(typeof forwarded, "number", "rowsPerKind must be a number");
      const n = forwarded as number;
      assert.ok(
        Number.isInteger(n) && n >= 1 && n <= 200,
        `rowsPerKind must stay inside the service's [1,200] clamp, got ${n}`,
      );
    }
  });

  it("puts X-Request-Id on both the 200 and the 400", async () => {
    captureService("getStockFundsHolding", OK);
    const ok = await app.request("/v1/stocks/RELIANCE/funds-holding", {
      headers: AUTH,
    });
    assert.equal(ok.status, 200);
    assert.ok(ok.headers.get("X-Request-Id"), "200 carries the correlation id");

    const bad = await app.request(
      "/v1/stocks/RELIANCE/funds-holding?exchange=NYSE",
      { headers: AUTH },
    );
    assert.equal(bad.status, 400);
    assert.ok(bad.headers.get("X-Request-Id"), "400 carries it too");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Symbol handling — what a hostile `:symbol` can and cannot do
// ════════════════════════════════════════════════════════════════════════════

describe("P14 Stock Sections: hostile symbols", () => {
  it("a percent-encoded path separator cannot re-route the request", async () => {
    // `%2F` decodes INSIDE the param, so `RELIANCE%2F..%2F..%2Fdeals` must
    // still land on `flags` with one opaque symbol — it must not traverse to
    // another section, another family, or off `/v1` entirely.
    const probe = captureAllStockServices(OK);
    const res = await app.request(
      "/v1/stocks/RELIANCE%2F..%2F..%2Fdeals/flags",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(
      probe.fired,
      ["getStockFlagsAndIndexes"],
      "traversal in the param must not select a different handler",
    );
  });

  it("forwards a traversal-shaped symbol as ONE bounded opaque string", async () => {
    // FINDING (reported, not fixed): `SymbolSchema` bounds length only, so
    // `/`, `..` and control characters reach the service verbatim. That is
    // survivable here — the value is used as a Prisma equality operand and a
    // cache-key segment, never as a path or a shell word, and the web action
    // passes its route param equally verbatim, so this is NOT web-vs-mobile
    // drift. What IS asserted is the containment that holds: the junk arrives
    // as a single argument, inside the length bound, with the exchange
    // untouched — it cannot smuggle a second field or a longer string.
    const cap = captureService("getStockDeliveryTrend", OK);
    const res = await app.request("/v1/stocks/%2E%2E%2F%2E%2E/delivery", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const args = cap.calls[0]?.[0] as Record<string, unknown>;
    assert.equal(cap.calls[0]?.length, 1, "one argument, no extras");
    assert.deepEqual(Object.keys(args).sort(), ["exchange", "symbol"]);
    assert.equal(args.exchange, "NSE");
    assert.equal(typeof args.symbol, "string");
    assert.ok((args.symbol as string).length <= 24, "still inside the bound");
  });

  it("does not reflect a hostile symbol back in the 400 message", async () => {
    // The 400 body carries zod `issues`, which name the FIELD, not the value.
    // A reflected value is how a validation error becomes an injection vector
    // for whatever renders it.
    const cap = captureService("getStockDealsSection", OK);
    const marker = "<script>alert(1)</script>";
    const res = await app.request(
      `/v1/stocks/${encodeURIComponent(marker + "x".repeat(30))}/deals`,
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    const raw = JSON.stringify(await readBody(res));
    assert.equal(raw.includes("<script>"), false, "the value is not echoed");
    assert.equal(cap.calls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Catalogue — a section a client cannot discover may as well not be mounted
// ════════════════════════════════════════════════════════════════════════════

describe("P14 Stock Sections: /v1 catalogue", () => {
  it("advertises all nine sections on the /v1/stocks family", async () => {
    const res = await app.request("/v1", { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await readBody(res);
    const endpoints = (
      body.data as { endpoints: { path: string; description: string }[] }
    ).endpoints;
    const stocks = endpoints.find((e) => e.path === "/v1/stocks");
    assert.ok(stocks, "/v1/stocks must be catalogued");
    for (const section of SECTIONS) {
      assert.ok(
        stocks.description.includes(section.path),
        `/v1/stocks must advertise ${section.path}`,
      );
    }
  });
});
