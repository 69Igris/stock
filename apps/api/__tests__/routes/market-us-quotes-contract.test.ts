/**
 * HTTP Contract Tests — GET /v1/market/us/quotes (MONEY-1309)
 *
 * Drives the REAL Hono middleware + route handler via `app.request(...)`, using
 * the same CJS `require.cache` stubbing seam as
 * `market-discover-p3-contract.test.ts`: `@usemoney/core/market-data/tiingo/
 * tiingo-rt-read` is replaced with a per-test impl, the apps/api modules are
 * purged and re-required, and everything else runs for real.
 *
 * ## What is deliberately NOT stubbed, and why
 *
 * `normalizeUsExchange`, `batchQuoteSource` and `usMarketSession` are PURE
 * subpaths with no I/O, so the handler exercises the real venue guard, the real
 * pessimistic batch label and the real session clock. Stubbing them would leave
 * the three decisions this endpoint actually makes untested and replace them
 * with the test's own opinion — a shadow.
 *
 * ## The claim this endpoint exists to make
 *
 * Every other price payload in `market.ts` is unconditionally `delayed: true`
 * because every one of them is Yahoo. This one is not: a US quote is either a
 * streaming quote or the previous close standing in for one, so `delayed` is
 * derived, per quote AND for the envelope. The envelope is PESSIMISTIC — one
 * fallback quote demotes the batch — because a mobile client that renders
 * `delayed:false` as a live tick must be correct for the whole payload, not for
 * its freshest member.
 *
 * Source: apps/api/src/routes/v1/market.ts
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

// ── the US licence gate (MONEY-1309) ───────────────────────────────────────
// Stubbed through the SAME require.cache seam as everything else, not through
// the module's ESM test hook: `before()` deletes and re-requires every
// `/apps/api/src/` module, so a hook mutated via an ESM import lands on a
// DIFFERENT module instance than the route ends up holding — which is exactly
// what the first attempt did, and every assertion stayed red.
let usMayServe = true;
const usAccessStub = {
  __esModule: true,
  mayServeUsMarket: async () => usMayServe,
  userEmailForUsAccess: async () =>
    usMayServe ? "deepshaswat@gmail.com" : "someone.else@example.com",
  __setUsAccessEmailResolverForTests: () => {},
};

// ── configurable @usemoney/services (only resolveUserId is reached) ─────────
const serviceImpls = new Map<string, (...args: unknown[]) => unknown>();
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

// ── configurable US quote read path ─────────────────────────────────────────
type ResolveUsQuotes = (
  symbols: readonly string[],
  exchange: string,
) => Promise<{ quotes: Map<string, unknown>; unresolved: string[] }>;

let resolveUsQuotesImpl: ResolveUsQuotes;
let seenArgs: { symbols: readonly string[]; exchange: string } | null = null;

const rtReadStub = {
  __esModule: true,
  resolveUsQuotes: (symbols: readonly string[], exchange: string) => {
    seenArgs = { symbols, exchange };
    return resolveUsQuotesImpl(symbols, exchange);
  },
  pingUsSymbolInterest: async () => false,
  US_EOD_FALLBACK_MAX_SYMBOLS: 12,
};

function mkQuote(
  symbol: string,
  price: number,
  provenance: {
    source: string;
    asOf: string;
    fallback: boolean;
    session?: string;
    note?: string;
  },
): Record<string, unknown> {
  return {
    symbol,
    exchange: "NASDAQ",
    name: symbol,
    price,
    change: 1,
    changePercent: 0.5,
    open: price - 1,
    high: price + 1,
    low: price - 2,
    previousClose: price - 1,
    volume: 1_000,
    timestamp: new Date(provenance.asOf),
    provenance,
  };
}

const LIVE = {
  source: "TIINGO_RT",
  asOf: "2026-08-31T18:00:00.000Z",
  fallback: false,
  session: "rth",
};
const EOD = {
  source: "TIINGO",
  asOf: "2026-08-29T20:00:00.000Z",
  fallback: true,
  note: "End-of-day close — no live quote for this symbol",
};
/**
 * The combination the fixtures above CANNOT distinguish — MONEY-1309 follow-up.
 *
 * `delayed` was `q.provenance.fallback || q.provenance.source !== "TIINGO_RT"`.
 * Every fixture in this file was either (RT, not-fallback) or (TIINGO,
 * fallback), so the two operands agreed on every case and DELETING `fallback ||`
 * left all 12 tests green. The apps/web disclaimer made exactly that deletion
 * and shipped it — rendering a green "Live quote" badge over a fallback price.
 *
 * A realtime source carrying `fallback:true` is the only input that separates
 * them. It reaches this route across a package boundary (a `UsQuote` shaped by
 * whichever deploy of `@usemoney/core` is installed), so the handler must be
 * right about it regardless of what today's `decideUsQuote` chooses to emit.
 */
const STALE_RT = {
  source: "TIINGO_RT",
  asOf: "2026-08-31T17:00:00.000Z",
  fallback: true,
  session: "post",
  note: "Last quote before the feed went quiet",
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
  stub(
    require.resolve("@usemoney/core/market-data/tiingo/tiingo-rt-read"),
    rtReadStub,
  );
  stub(require.resolve("@clerk/backend"), clerkStub);
  for (const key of Object.keys(cache)) {
    if (key.includes("/apps/api/src/")) {
      saved.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // AFTER the purge above, which would otherwise delete it.
  stub(require.resolve("../../src/lib/us-access.ts"), usAccessStub);

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
  serviceImpls.set("resolveUserId", async () => "mongo_1");
  seenArgs = null;
  resolveUsQuotesImpl = async () => ({ quotes: new Map(), unresolved: [] });
  // The LICENCE GATE (MONEY-1309) refuses anyone not on the US allowlist, and
  // there is no database here, so an unstubbed lookup returns null and every
  // contract assertion below would fail for a reason unrelated to what it
  // tests. Default the suite to the ALLOWED path; the refusal has its own case.
  usMayServe = true;
});

describe("Contract: GET /v1/market/us/quotes", () => {
  it("[meta] the stub is actually reached — the assertions are not vacuous", async () => {
    resolveUsQuotesImpl = async () => ({
      quotes: new Map([["AAPL", mkQuote("AAPL", 200, LIVE)]]),
      unresolved: [],
    });
    const res = await app.request("/v1/market/us/quotes?symbols=AAPL", {
      headers: AUTH,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seenArgs, { symbols: ["AAPL"], exchange: "NASDAQ" });
  });

  it("requires the Bearer gate like every other /v1 endpoint", async () => {
    const res = await app.request("/v1/market/us/quotes?symbols=AAPL");
    assert.equal(res.status, 401);
  });

  it("serves a live quote with its provenance and delayed:false", async () => {
    resolveUsQuotesImpl = async () => ({
      quotes: new Map([["AAPL", mkQuote("AAPL", 200, LIVE)]]),
      unresolved: [],
    });

    const res = await app.request(
      "/v1/market/us/quotes?symbols=AAPL&exchange=NASDAQ",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.source, "TIINGO_RT");
    assert.equal(body.data.delayed, false);
    assert.equal(body.data.quotes.length, 1);
    assert.equal(body.data.quotes[0].price, 200);
    assert.equal(body.data.quotes[0].currency, "USD");
    assert.equal(body.data.quotes[0].delayed, false);
    assert.equal(body.data.quotes[0].provenance.source, "TIINGO_RT");
    assert.equal(body.data.quotes[0].provenance.fallback, false);
    assert.equal(body.data.quotes[0].asOf, LIVE.asOf);
  });

  it("marks an EOD close as a fallback and delayed", async () => {
    resolveUsQuotesImpl = async () => ({
      quotes: new Map([["MSFT", mkQuote("MSFT", 410, EOD)]]),
      unresolved: [],
    });

    const res = await app.request("/v1/market/us/quotes?symbols=MSFT", {
      headers: AUTH,
    });
    const body = await res.json();
    assert.equal(body.data.source, "TIINGO");
    assert.equal(body.data.delayed, true);
    assert.equal(body.data.quotes[0].delayed, true);
    assert.equal(body.data.quotes[0].provenance.fallback, true);
  });

  it("[regression] a FALLBACK realtime quote is delayed, not live", async () => {
    resolveUsQuotesImpl = async () => ({
      quotes: new Map([["AAPL", mkQuote("AAPL", 200, STALE_RT)]]),
      unresolved: [],
    });
    const res = await app.request("/v1/market/us/quotes?symbols=AAPL", {
      headers: AUTH,
    });
    const body = await res.json();
    assert.equal(
      body.data.quotes[0].delayed,
      true,
      "a fallback quote on the realtime SOURCE was reported as live. That is " +
        "the operand a hand-written `fallback || source !== …` can lose, and " +
        "no other fixture in this file can see it go missing.",
    );
    assert.equal(body.data.quotes[0].provenance.fallback, true);
    // And the envelope agrees — `batchQuoteSource` reads the same predicate.
    assert.equal(body.data.source, "TIINGO");
    assert.equal(body.data.delayed, true);
  });

  it("[meta] the live fixture and the stale one differ ONLY in `fallback`", () => {
    // Ceiling for the case above: if the two fixtures also differed in
    // `source`, the assertion would pass on the source operand alone and prove
    // nothing about `fallback`.
    assert.equal(STALE_RT.source, LIVE.source);
    assert.notEqual(STALE_RT.fallback, LIVE.fallback);
  });

  it("ONE fallback demotes the whole envelope to delayed", async () => {
    // The pessimistic rule. A client rendering `delayed:false` as a live tick
    // must be right about the WHOLE payload, not about its freshest member.
    resolveUsQuotesImpl = async () => ({
      quotes: new Map([
        ["AAPL", mkQuote("AAPL", 200, LIVE)],
        ["MSFT", mkQuote("MSFT", 410, EOD)],
      ]),
      unresolved: [],
    });

    const res = await app.request("/v1/market/us/quotes?symbols=AAPL,MSFT", {
      headers: AUTH,
    });
    const body = await res.json();
    assert.equal(body.data.source, "TIINGO");
    assert.equal(body.data.delayed, true);
    // Per-quote truth survives the demotion.
    assert.equal(body.data.quotes[0].delayed, false);
    assert.equal(body.data.quotes[1].delayed, true);
  });

  it("echoes unresolved symbols in `missing`, fail-open", async () => {
    resolveUsQuotesImpl = async () => ({
      quotes: new Map([["AAPL", mkQuote("AAPL", 200, LIVE)]]),
      unresolved: ["NOPE"],
    });
    const res = await app.request("/v1/market/us/quotes?symbols=AAPL,NOPE", {
      headers: AUTH,
    });
    assert.equal(res.status, 200, "a missing symbol must not be an error");
    const body = await res.json();
    assert.deepEqual(body.data.missing, ["NOPE"]);
  });

  it("400s on a NON-US venue instead of silently defaulting", async () => {
    // Unlike `/quotes`, whose resolve is lenient (anything but BSE means NSE).
    // Here the venue selects which MARKET answers, so a silent default returns
    // the wrong market's prices — or an empty list that reads as "no data".
    const res = await app.request(
      "/v1/market/us/quotes?symbols=AAPL&exchange=NSE",
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal(seenArgs, null, "the read path ran despite an invalid venue");
  });

  it("defaults to NASDAQ when no venue is named", async () => {
    resolveUsQuotesImpl = async () => ({ quotes: new Map(), unresolved: [] });
    await app.request("/v1/market/us/quotes?symbols=AAPL", { headers: AUTH });
    assert.equal(seenArgs?.exchange, "NASDAQ");
  });

  it("an EMPTY ?exchange= is an ABSENT one, as it is on web", async () => {
    // `??` is nullish, so `""` slipped past the NASDAQ default into the venue
    // guard and 400'd — while `/api/market/quote?exchange=` on web answers 200.
    // One query string, two clients, opposite outcomes. Strictness is about an
    // UNKNOWN venue; an omitted one is the documented default in both.
    resolveUsQuotesImpl = async () => ({ quotes: new Map(), unresolved: [] });
    const res = await app.request(
      "/v1/market/us/quotes?symbols=AAPL&exchange=",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.equal(seenArgs?.exchange, "NASDAQ");
  });

  it("a whitespace-only ?exchange= is absent too, not an unknown venue", async () => {
    resolveUsQuotesImpl = async () => ({ quotes: new Map(), unresolved: [] });
    const res = await app.request(
      "/v1/market/us/quotes?symbols=AAPL&exchange=%20%20",
      { headers: AUTH },
    );
    assert.equal(res.status, 200);
    assert.equal(seenArgs?.exchange, "NASDAQ");
  });

  it("an UNKNOWN venue is still a 400 — the strictness is unchanged", async () => {
    const res = await app.request(
      "/v1/market/us/quotes?symbols=AAPL&exchange=LSE",
      { headers: AUTH },
    );
    assert.equal(res.status, 400);
    assert.equal(seenArgs, null);
  });

  it("accepts a lower-case venue and canonicalises it", async () => {
    resolveUsQuotesImpl = async () => ({ quotes: new Map(), unresolved: [] });
    await app.request(
      "/v1/market/us/quotes?symbols=AAPL&exchange=nyse%20arca",
      { headers: AUTH },
    );
    assert.equal(seenArgs?.exchange, "NYSE ARCA");
  });

  it("400s on an empty symbol list", async () => {
    const res = await app.request("/v1/market/us/quotes?symbols=", {
      headers: AUTH,
    });
    assert.equal(res.status, 400);
  });

  it("neutralises a non-finite upstream number to null (no $NaN)", async () => {
    resolveUsQuotesImpl = async () => ({
      quotes: new Map([
        [
          "AAPL",
          {
            ...mkQuote("AAPL", 200, LIVE),
            changePercent: Number.NaN,
            volume: Number.POSITIVE_INFINITY,
          },
        ],
      ]),
      unresolved: [],
    });
    const res = await app.request("/v1/market/us/quotes?symbols=AAPL", {
      headers: AUTH,
    });
    const body = await res.json();
    assert.equal(body.data.quotes[0].price, 200);
    assert.equal(body.data.quotes[0].changePercent, null);
    assert.equal(body.data.quotes[0].volume, null);
  });

  it("500s rather than leaking when the read path throws", async () => {
    resolveUsQuotesImpl = async () => {
      throw new Error("mongo down");
    };
    const res = await app.request("/v1/market/us/quotes?symbols=AAPL", {
      headers: AUTH,
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.doesNotMatch(JSON.stringify(body), /mongo down/);
  });
});

describe("the US licence gate (MONEY-1309)", () => {
  it("refuses a caller who is not on the allowlist — ABSENCE, not an error", async () => {
    // Tiingo COMMERCIAL is internal-use-only: serving a US price is
    // redistribution and needs MONEY-1262. This endpoint is the MOBILE surface
    // and was behind NOTHING — reachable by any client with a valid Bearer
    // token, with no page in the way.
    usMayServe = false;
    resolveUsQuotesImpl = async () => {
      throw new Error("the read path must not be reached for a refused caller");
    };
    const res = await app.request("/v1/market/us/quotes?symbols=AAPL,NVDA", {
      headers: AUTH,
    });
    // 200, not 403: an error would confirm to an unauthorised caller that the
    // data exists, and would need its own client branch. The shape is exactly
    // what this handler already returns for a symbol the feed has nothing for.
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      success: boolean;
      data: { quotes: unknown[]; missing: string[]; delayed: boolean };
    };
    assert.equal(body.success, true);
    assert.deepEqual(body.data.quotes, []);
    assert.deepEqual(body.data.missing, ["AAPL", "NVDA"]);
    assert.equal(
      body.data.delayed,
      true,
      "a refusal is never advertised as live",
    );
  });

  it("does not even reach the read path when refused", async () => {
    // The gate must sit BEFORE the vendor-backed read, not filter its output —
    // otherwise a refused request still costs the work it was refused.
    usMayServe = false;
    let reached = false;
    resolveUsQuotesImpl = async () => {
      reached = true;
      return { quotes: new Map(), unresolved: [] };
    };
    await app.request("/v1/market/us/quotes?symbols=AAPL", { headers: AUTH });
    assert.equal(
      reached,
      false,
      "resolveUsQuotes was called for a refused caller",
    );
  });

  it("[meta] an ALLOWED caller does reach the read path — the refusal is not vacuous", async () => {
    // The control for the two cases above. Without it, a handler that never
    // served anything at all would satisfy them both, and the gate would look
    // like it worked while doing nothing.
    let reached = false;
    resolveUsQuotesImpl = async () => {
      reached = true;
      return { quotes: new Map(), unresolved: ["AAPL"] };
    };
    await app.request("/v1/market/us/quotes?symbols=AAPL", { headers: AUTH });
    assert.equal(
      reached,
      true,
      "an allowed caller must reach resolveUsQuotes — otherwise the refusal " +
        "cases prove nothing",
    );
  });
});
