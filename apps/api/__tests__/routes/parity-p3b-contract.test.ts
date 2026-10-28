/**
 * MONEY-1062 P3b Parity HTTP Contract Tests — API Server
 *
 * Contract coverage for the ADDITIVE parity params added in P3b (D3–D7). Each
 * divergence: the pre-existing request shape is preserved byte-for-byte, the new
 * optional params work, and bad params/combos → 400 BEFORE any upstream call.
 *
 *   D3  GET /v1/market/quotes      — `?exchange=` + unsuffixed-symbol → Yahoo map
 *   D5  GET /v1/market/mf-nav      — `?period=` window (absent = full history)
 *   D6  GET /v1/market/historical  — `?period=&interval=&startDate=&endDate=`
 *                                    (pre-existing `?range=` path unchanged)
 *   D4  GET /v1/mutualfunds        — `?search=` + `?category=` forwarded
 *   D7  GET /v1/me/composer-preferences — persona readability (VERIFY lock)
 *
 * A dedicated file (not an extension of market-discover-p3-contract) because that
 * suite locks the ORIGINAL P3 byte-identical baseline; the additive params are a
 * distinct wave and belong with the parity-pNx series (P1a/P1b/P2a/P2b → P3b).
 *
 * Same ESM stubbing seam as market-discover-p3-contract: `require.cache` seeded
 * with a `@usemoney/services` Proxy + a `@usemoney/core/market-data` Proxy +
 * a configurable `@clerk/backend` verifier, then the apps/api/src modules are
 * purged and re-required so their imports resolve to the stubs.
 * `@usemoney/core/market-data/market-hours` (getNseMarketStatus) is a PURE
 * subpath and is deliberately NOT stubbed.
 *
 * Source: apps/api/src/routes/v1/{market,mutualfunds,me}.ts
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

// ── configurable @usemoney/core/market-data ─────────────────────────────────
// These fns do NOT return ServiceResult (Map / array), so the default forwarder
// throws — every test sets the impl for what it exercises.
const coreImpls = new Map<string, (...args: unknown[]) => unknown>();
function setCore(name: string, fn: (...args: unknown[]) => unknown): void {
  coreImpls.set(name, fn);
}
const coreStub = new Proxy({} as Record<string, unknown>, {
  get(_t, prop) {
    if (typeof prop !== "string") return undefined;
    if (prop === "__esModule") return true;
    if (prop === "then") return undefined;
    if (prop === "default") return coreStub;
    return (...args: unknown[]) => {
      const impl = coreImpls.get(prop);
      if (!impl) throw new Error(`core-not-stubbed:${prop}`);
      return impl(...args);
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
  stub(require.resolve("@usemoney/core/market-data"), coreStub);
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
  coreImpls.clear();
  setService("resolveUserId", async () => "mongo_1");
});

/** Capture the symbols passed to yahooFetchQuotes; resolve none (all missing). */
function captureQuoteSymbols(): { seen: () => unknown } {
  let captured: unknown;
  setCore("yahooFetchQuotes", async (symbols: unknown) => {
    captured = symbols;
    return new Map();
  });
  return { seen: () => captured };
}

// ════════════════════════════════════════════════════════════════════════════
// D3 — GET /v1/market/quotes: `?exchange=` + unsuffixed → Yahoo mapping
// ════════════════════════════════════════════════════════════════════════════

describe("D3 Contract: GET /v1/market/quotes symbol→Yahoo mapping", () => {
  it("maps an unsuffixed symbol to `.NS` by default (exchange NSE)", async () => {
    const cap = captureQuoteSymbols();
    const res = await app.request("/v1/market/quotes?symbols=RELIANCE", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.seen(), ["RELIANCE.NS"]);
    // C3#8: `missing` echoes the client's ORIGINAL symbol — the caller sent
    // `RELIANCE` and can't correlate a mapped `RELIANCE.NS` it never sent.
    assert.deepEqual((await res.json()).data.missing, ["RELIANCE"]);
  });

  it("missing[] echoes originals per-position (mixed mapped + suffixed + index)", async () => {
    // Resolve only TCS.BO; the unsuffixed miss and the index-name miss must
    // come back EXACTLY as the client sent them.
    setCore("yahooFetchQuotes", async () => {
      return new Map([
        ["TCS.BO", { symbol: "TCS.BO", regularMarketPrice: 4000 }],
      ]);
    });
    const res = await app.request(
      `/v1/market/quotes?symbols=RELIANCE,TCS.BO,${encodeURIComponent("NIFTY 50")}`,
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    // RELIANCE (mapped → RELIANCE.NS, missed) and NIFTY 50 (mapped → ^NSEI,
    // missed) echo as sent; the resolved TCS.BO is absent from `missing`.
    assert.deepEqual(body.data.missing, ["RELIANCE", "NIFTY 50"]);
    assert.equal(body.data.quotes.length, 1);
  });

  it("maps an unsuffixed symbol to `.BO` with ?exchange=BSE", async () => {
    const cap = captureQuoteSymbols();
    const res = await app.request(
      "/v1/market/quotes?symbols=RELIANCE&exchange=BSE",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.seen(), ["RELIANCE.BO"]);
  });

  it("passes an already-suffixed symbol through UNTOUCHED (byte-identical)", async () => {
    const cap = captureQuoteSymbols();
    // Even with exchange=BSE, a `.NS` symbol is not re-mapped.
    const res = await app.request(
      "/v1/market/quotes?symbols=RELIANCE.NS,TCS.BO&exchange=BSE",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.seen(), ["RELIANCE.NS", "TCS.BO"]);
  });

  it("passes a `^`-prefixed index symbol through UNTOUCHED", async () => {
    const cap = captureQuoteSymbols();
    const res = await app.request("/v1/market/quotes?symbols=%5ENSEI", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.seen(), ["^NSEI"]);
  });

  it("maps a known index NAME to its `^SYMBOL` (INDEX_MAPPINGS)", async () => {
    const cap = captureQuoteSymbols();
    const res = await app.request(
      `/v1/market/quotes?symbols=${encodeURIComponent("NIFTY 50")}`,
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.seen(), ["^NSEI"]);
  });

  it("resolves + echoes the MAPPED (Yahoo) symbol on a hit", async () => {
    setCore("yahooFetchQuotes", async () => {
      return new Map([
        [
          "RELIANCE.NS",
          {
            symbol: "RELIANCE.NS",
            shortName: "Reliance",
            regularMarketPrice: 2500,
          },
        ],
      ]);
    });
    const res = await app.request("/v1/market/quotes?symbols=RELIANCE", {
      headers: AUTH,
    });
    const body = await res.json();
    assert.equal(body.data.quotes.length, 1);
    assert.equal(body.data.quotes[0].symbol, "RELIANCE.NS");
    assert.equal(body.data.quotes[0].price, 2500);
    assert.deepEqual(body.data.missing, []); // resolved, nothing missing
  });

  it("still 400s an empty symbols list (validation on the RAW input)", async () => {
    let called = false;
    setCore("yahooFetchQuotes", async () => {
      called = true;
      return new Map();
    });
    const res = await app.request("/v1/market/quotes?symbols=&exchange=NSE", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D5 — GET /v1/market/mf-nav: `?period=` window
// ════════════════════════════════════════════════════════════════════════════

/** Capture (schemeCode, startDate) passed to getMfNavHistory. */
function captureMfNav(): { code: () => unknown; start: () => unknown } {
  let code: unknown;
  let start: unknown;
  setCore("getMfNavHistory", async (c: unknown, s: unknown) => {
    code = c;
    start = s;
    return [{ date: "2026-07-01", nav: 12.7 }];
  });
  return { code: () => code, start: () => start };
}

describe("D5 Contract: GET /v1/market/mf-nav ?period=", () => {
  it("ABSENT period → full history (startDate undefined, unchanged)", async () => {
    const cap = captureMfNav();
    const res = await app.request("/v1/market/mf-nav?schemeCode=120503", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.equal(cap.code(), "120503");
    assert.equal(cap.start(), undefined); // no window → full history
    assert.equal((await res.json()).data.source, "mfapi.in");
  });

  it("?period=1y → getMfNavHistory receives a ~1-year-ago startDate", async () => {
    const cap = captureMfNav();
    const res = await app.request(
      "/v1/market/mf-nav?schemeCode=120503&period=1y",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const start = cap.start();
    assert.ok(start instanceof Date);
    assert.equal(start.getFullYear(), new Date().getFullYear() - 1);
  });

  it("?period=max → startDate = epoch (new Date(0)) = full history", async () => {
    const cap = captureMfNav();
    const res = await app.request(
      "/v1/market/mf-nav?schemeCode=120503&period=max",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const start = cap.start();
    assert.ok(start instanceof Date);
    assert.equal(start.getTime(), 0);
  });

  it("rejects an unknown period with 400 (never calls upstream)", async () => {
    let called = false;
    setCore("getMfNavHistory", async () => {
      called = true;
      return [];
    });
    const res = await app.request(
      "/v1/market/mf-nav?schemeCode=120503&period=13m",
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D6 — GET /v1/market/historical: additive period/interval/startDate/endDate
// ════════════════════════════════════════════════════════════════════════════

/** Capture (symbol, opts) passed to yahooFetchChart; return one bar. */
function captureChart(): {
  symbol: () => unknown;
  opts: () => { period1?: Date; period2?: Date; interval?: string } | undefined;
} {
  let symbol: unknown;
  let opts: { period1?: Date; period2?: Date; interval?: string } | undefined;
  setCore("yahooFetchChart", async (s: unknown, o: unknown) => {
    symbol = s;
    opts = o as { period1?: Date; period2?: Date; interval?: string };
    return [
      {
        date: new Date("2026-07-01T00:00:00.000Z"),
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 1000,
      },
    ];
  });
  return { symbol: () => symbol, opts: () => opts };
}

describe("D6 Contract: GET /v1/market/historical additive params", () => {
  it("pre-existing ?range= path is UNCHANGED (range wins over new params)", async () => {
    const cap = captureChart();
    // range=1mo present → RANGE_WINDOWS (interval 1d) wins; period/interval ignored.
    const res = await app.request(
      "/v1/market/historical?symbol=RELIANCE.NS&range=1mo&period=5y&interval=1wk",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(cap.opts()?.interval, "1d"); // from RANGE_WINDOWS, NOT 1wk
    assert.equal(body.data.range, "1mo");
    assert.equal(body.data.interval, "1d");
    assert.equal(body.data.period, undefined); // range path echoes `range`, not `period`
  });

  it("?period=1y&interval=1wk → period1≈1y ago, period2≈now, interval 1wk", async () => {
    const cap = captureChart();
    const res = await app.request(
      "/v1/market/historical?symbol=RELIANCE.NS&period=1y&interval=1wk",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    const opts = cap.opts();
    assert.ok(opts?.period1 instanceof Date && opts?.period2 instanceof Date);
    assert.equal(opts?.period1.getFullYear(), new Date().getFullYear() - 1);
    assert.ok(Math.abs(opts!.period2!.getTime() - Date.now()) < 60_000);
    assert.equal(opts?.interval, "1wk");
    assert.equal(body.data.period, "1y");
    assert.equal(body.data.interval, "1wk");
    assert.equal(body.data.range, undefined); // additive path echoes `period`
  });

  it("?startDate&endDate → those bounds, period echoed as 'custom'", async () => {
    const cap = captureChart();
    const res = await app.request(
      "/v1/market/historical?symbol=RELIANCE.NS&startDate=2024-01-01&endDate=2024-06-30&interval=1d",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    const opts = cap.opts();
    assert.equal(opts?.period1?.toISOString(), "2024-01-01T00:00:00.000Z");
    assert.equal(opts?.period2?.toISOString(), "2024-06-30T00:00:00.000Z");
    assert.equal(body.data.period, "custom");
  });

  it("symbol-only (no range/period) → web defaults period=1mo, interval=1d", async () => {
    const cap = captureChart();
    const res = await app.request("/v1/market/historical?symbol=RELIANCE.NS", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(cap.opts()?.interval, "1d");
    assert.equal(body.data.period, "1mo");
  });

  it("rejects an invalid interval with 400 (never calls upstream)", async () => {
    let called = false;
    setCore("yahooFetchChart", async () => {
      called = true;
      return [];
    });
    const res = await app.request(
      "/v1/market/historical?symbol=RELIANCE.NS&interval=7m",
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("rejects an invalid period with 400", async () => {
    const res = await app.request(
      "/v1/market/historical?symbol=RELIANCE.NS&period=13mo",
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
  });

  it("rejects an un-parseable date with 400 (mirrors web's date guard)", async () => {
    const res = await app.request(
      "/v1/market/historical?symbol=RELIANCE.NS&startDate=not-a-date&endDate=2024-06-30",
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal(
      (await res.json()).error.message,
      "Invalid date format. Use YYYY-MM-DD",
    );
  });

  it("rejects startDate after endDate with 400", async () => {
    const res = await app.request(
      "/v1/market/historical?symbol=RELIANCE.NS&startDate=2024-12-31&endDate=2024-01-01",
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal(
      (await res.json()).error.message,
      "startDate must be before endDate",
    );
  });

  it("rejects an intraday interval with a too-long period (bad combo → 400)", async () => {
    let called = false;
    setCore("yahooFetchChart", async () => {
      called = true;
      return [];
    });
    const res = await app.request(
      "/v1/market/historical?symbol=RELIANCE.NS&interval=5m&period=1y",
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });

  it("rejects the additive path with a missing symbol (400)", async () => {
    const res = await app.request("/v1/market/historical?period=1y", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
  });

  // ── C3#2: mode-2 applies the SAME unsuffixed-symbol mapping as /quotes ────
  it("mode-2 maps an unsuffixed symbol to `.NS` by default (bars for ?symbol=RELIANCE&period=1y)", async () => {
    const cap = captureChart();
    const res = await app.request(
      "/v1/market/historical?symbol=RELIANCE&period=1y&interval=1wk",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(cap.symbol(), "RELIANCE.NS"); // mapped upstream
    assert.equal(body.data.symbol, "RELIANCE"); // ORIGINAL echoed
    assert.equal(body.data.bars.length, 1);
  });

  it("mode-2 honours ?exchange=BSE and passes suffixed/^ symbols through untouched", async () => {
    const cap = captureChart();
    const bse = await app.request(
      "/v1/market/historical?symbol=RELIANCE&period=1y&interval=1wk&exchange=BSE",
      { headers: AUTH },
    );
    assert.equal(bse.status, 200);
    assert.equal(cap.symbol(), "RELIANCE.BO");

    const suffixed = await app.request(
      "/v1/market/historical?symbol=TCS.NS&period=1mo",
      { headers: AUTH },
    );
    assert.equal(suffixed.status, 200);
    assert.equal(cap.symbol(), "TCS.NS"); // pass-through, even sans exchange

    const index = await app.request(
      "/v1/market/historical?symbol=%5ENSEI&period=1mo",
      { headers: AUTH },
    );
    assert.equal(index.status, 200);
    assert.equal(cap.symbol(), "^NSEI");
  });

  it("mode-1 (?range=) keeps the raw symbol (byte-identical baseline — no mapping)", async () => {
    const cap = captureChart();
    const res = await app.request(
      "/v1/market/historical?symbol=RELIANCE&range=1mo&exchange=BSE",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.equal(cap.symbol(), "RELIANCE"); // NOT mapped on the range path
  });

  // ── C3#7: intraday + custom dates → forward-anchor normalisation ─────────
  it("intraday interval + custom dates → period1 = start-of-day(startDate), period2 = NOW", async () => {
    const cap = captureChart();
    const res = await app.request(
      "/v1/market/historical?symbol=RELIANCE.NS&startDate=2026-07-01&endDate=2026-07-03&interval=5m",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    const opts = cap.opts();
    assert.ok(opts?.period1 instanceof Date && opts?.period2 instanceof Date);
    // period1: snapped DOWN to 00:00:00 local of the startDate's calendar day.
    const expectedStart = new Date(new Date("2026-07-01").getTime());
    expectedStart.setHours(0, 0, 0, 0);
    assert.equal(opts!.period1!.getTime(), expectedStart.getTime());
    // period2: forced to "now" (Yahoo forward-anchor quirk), NOT the endDate.
    assert.ok(Math.abs(opts!.period2!.getTime() - Date.now()) < 60_000);
    assert.equal(body.data.period, "custom");
    assert.equal(body.data.bars.length, 1); // bars actually come back
  });

  it("NON-intraday custom dates keep the exact [startDate, endDate] bounds (unchanged)", async () => {
    const cap = captureChart();
    const res = await app.request(
      "/v1/market/historical?symbol=RELIANCE.NS&startDate=2024-01-01&endDate=2024-06-30&interval=1wk",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const opts = cap.opts();
    assert.equal(opts?.period1?.toISOString(), "2024-01-01T00:00:00.000Z");
    assert.equal(opts?.period2?.toISOString(), "2024-06-30T00:00:00.000Z");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D4 — GET /v1/mutualfunds: `?search=` + `?category=` forwarded
// ════════════════════════════════════════════════════════════════════════════

/** Capture the filters (2nd arg) passed to getMutualFunds. */
function captureMfFilters(): { filters: () => unknown } {
  let filters: unknown;
  setService("getMutualFunds", async (_u: unknown, f: unknown) => {
    filters = f;
    return {
      success: true,
      data: { funds: [{ id: "m1" }], summary: { totalInvested: 1 } },
    };
  });
  return { filters: () => filters };
}

describe("D4 Contract: GET /v1/mutualfunds filters", () => {
  it("no filters → getMutualFunds receives {} (byte-identical)", async () => {
    const cap = captureMfFilters();
    const res = await app.request("/v1/mutualfunds", { headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.filters(), {});
  });

  it("forwards ?search= and ?category= to the service", async () => {
    const cap = captureMfFilters();
    const res = await app.request(
      "/v1/mutualfunds?search=bluechip&category=Equity",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(cap.filters(), { search: "bluechip", category: "Equity" });
  });

  it("forwards category=all verbatim (service treats it as no-filter)", async () => {
    const cap = captureMfFilters();
    const res = await app.request("/v1/mutualfunds?category=all", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(cap.filters(), { category: "all" });
  });

  it("rejects an oversized search (>120 chars) with 400 (no service call)", async () => {
    let called = false;
    setService("getMutualFunds", async () => {
      called = true;
      return { success: true, data: { funds: [], summary: {} } };
    });
    const long = "a".repeat(121);
    const res = await app.request(`/v1/mutualfunds?search=${long}`, {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
    assert.equal(called, false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D7 — GET /v1/me/composer-preferences: persona readability (VERIFY lock)
// ════════════════════════════════════════════════════════════════════════════

describe("D7 Contract: GET /v1/me/composer-preferences exposes tools.persona", () => {
  it("returns the stored persona under tools.persona", async () => {
    setService("getComposerPreferences", async () => ({
      connectors: { activeBrokerIds: [] },
      sources: {},
      tools: { pinnedIndicators: [], pinnedScreenerIds: [], persona: "marks" },
      pinnedInstruments: { stocks: [], mfs: [], etfs: [] },
      recentInstruments: { stocks: [], mfs: [], etfs: [] },
      model: null,
      thinking: false,
    }));
    const res = await app.request("/v1/me/composer-preferences", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    // D7 verdict: persona IS readable here (no me.ts change required).
    assert.equal((await res.json()).data.tools.persona, "marks");
  });

  it("returns a null persona (default) as null (never omitted)", async () => {
    setService("getComposerPreferences", async () => ({
      connectors: { activeBrokerIds: [] },
      sources: {},
      tools: { pinnedIndicators: [], pinnedScreenerIds: [], persona: null },
      pinnedInstruments: { stocks: [], mfs: [], etfs: [] },
      recentInstruments: { stocks: [], mfs: [], etfs: [] },
      model: null,
      thinking: false,
    }));
    const res = await app.request("/v1/me/composer-preferences", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok("persona" in body.data.tools);
    assert.equal(body.data.tools.persona, null);
  });
});
