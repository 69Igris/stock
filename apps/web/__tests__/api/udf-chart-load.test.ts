/**
 * MONEY-1383 (L3 + L4) — chart load-time fixes on the UDF routes, asserted
 * against the REAL exported `GET` handlers.
 *
 * Both fixes are about the serial budget before the first candle (measured on
 * prod via a demo session, medians of 3): /config 0.42s, /time 0.41s,
 * /symbols 0.83s warm / 2.50s cold, /history 1.05s warm.
 *
 *   L3  /config returns a module CONSTANT and carried no caching directive at
 *       all, so every chart load re-paid the round trip. Asserts the header is
 *       present AND that the body is byte-identical to `UDF_CONFIG` — a
 *       caching header that changed the payload would be a worse bug than the
 *       latency.
 *
 *   L4  /symbols issued TWO `instrumentMapping.findUnique` calls against the
 *       same `symbol_exchange` key — one in `findInstrument`, one in the route
 *       for `instrumentType` alone. The count is asserted directly, because
 *       that is the only thing that distinguishes the fix from the defect:
 *       both versions return the identical body.
 *
 * Harness: the `require.cache` injection seam used by
 * `fund-composition-route.test.ts` / `webhooks-dodo-e2e.test.ts`. The real
 * `lib/market/symbol-mapper` is deliberately NOT stubbed — it is one of the
 * two callers being counted, so replacing it would hide the very thing under
 * test.
 *
 * Source: apps/web/app/api/market/udf/config/route.ts
 *         apps/web/app/api/market/udf/symbols/route.ts
 *         apps/web/lib/market/symbol-mapper.ts
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { UDF_CONFIG } from "@/app/api/market/udf/config/config-logic";

// ── require.cache injection ────────────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const CONFIG_ROUTE_REL = "../../app/api/market/udf/config/route";
const SYMBOLS_ROUTE_REL = "../../app/api/market/udf/symbols/route";
const SYMBOL_MAPPER_REL = "../../lib/market/symbol-mapper";
const DEMO_SESSION_REL = "../../lib/demo/session";
const DEMO_DATA_REL = "../../lib/demo/data";

interface GetOnly {
  GET: (req?: unknown) => Promise<Response>;
}

interface FindUniqueArgs {
  where: Record<string, unknown>;
  select?: Record<string, unknown>;
}

interface InstrumentRow {
  id: string;
  symbol: string;
  exchange: string;
  yahooSymbol: string;
  name: string;
  instrumentType: string;
}

/** Every `instrumentMapping.findUnique` the request makes, in order. */
let instrumentLookups: FindUniqueArgs[] = [];
/** The single row the fake DB holds; null means "unknown symbol". */
let instrumentRow: InstrumentRow | null = null;

function fakePrisma() {
  return {
    __esModule: true,
    prisma: {
      instrumentMapping: {
        findUnique: (args: FindUniqueArgs) => {
          instrumentLookups.push(args);
          if (!instrumentRow) return Promise.resolve(null);
          // Project exactly the requested columns, like Prisma does — so a
          // route reading a field it never selected fails here rather than
          // silently working off an over-fetched double.
          const select = args.select ?? {};
          const row: Record<string, unknown> = {};
          for (const key of Object.keys(select)) {
            row[key] = (instrumentRow as unknown as Record<string, unknown>)[
              key
            ];
          }
          return Promise.resolve(row);
        },
      },
      mutualFundMaster: {
        findUnique: () => Promise.resolve(null),
      },
    },
  };
}

function injectSharedStubs(): void {
  const cache = moduleCache();
  cache[require.resolve("@clerk/nextjs/server")] = {
    exports: {
      __esModule: true,
      auth: () => Promise.resolve({ userId: "user_test" }),
    },
  };
  cache[require.resolve("@usemoney/logger")] = {
    exports: {
      __esModule: true,
      apiLogger: { error: () => {}, info: () => {}, warn: () => {} },
    },
  };
  cache[require.resolve(DEMO_SESSION_REL)] = {
    exports: { __esModule: true, isDemoSession: () => Promise.resolve(false) },
  };
  cache[require.resolve(DEMO_DATA_REL)] = {
    exports: { __esModule: true, isDemoChartSymbol: () => true },
  };
  cache[require.resolve("@usemoney/database")] = { exports: fakePrisma() };
}

function loadRoute(rel: string): GetOnly {
  const cache = moduleCache();
  injectSharedStubs();
  // The mapper closes over the faked prisma at import time — drop it so it is
  // re-evaluated against the stub rather than a previously loaded real client.
  delete cache[require.resolve(SYMBOL_MAPPER_REL)];
  delete cache[require.resolve(rel)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(rel) as GetOnly;
}

function makeRequest(query: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server");
  return new NextRequest(`http://localhost/api/market/udf/symbols${query}`);
}

// ============================================================================
// L3 — /config is a constant, so it must be cacheable
// ============================================================================

describe("MONEY-1383 L3 — GET /api/market/udf/config caching", () => {
  let route: GetOnly;

  before(() => {
    route = loadRoute(CONFIG_ROUTE_REL);
  });

  it("sends Cache-Control: private, max-age=3600", async () => {
    const res = await route.GET();
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("cache-control"),
      "private, max-age=3600",
      "the config response must be browser-cacheable — it cost 0.42s on every chart load"
    );
  });

  it("is `private`, never `public` — the route sits behind auth", async () => {
    const res = await route.GET();
    const cc = res.headers.get("cache-control") ?? "";
    assert.ok(
      cc.includes("private"),
      `expected a private directive, got "${cc}"`
    );
    assert.ok(
      !cc.includes("public"),
      "a shared cache must not retain a body served from an authenticated origin"
    );
  });

  it("caches a non-zero lifetime (a 0 max-age would be a no-op fix)", async () => {
    const res = await route.GET();
    const cc = res.headers.get("cache-control") ?? "";
    const m = cc.match(/max-age=(\d+)/);
    assert.ok(m, `no max-age in "${cc}"`);
    assert.ok(Number(m[1]) > 0, `max-age must be > 0, got ${m[1]}`);
  });

  it("leaves the body byte-identical to UDF_CONFIG", async () => {
    const res = await route.GET();
    const body = await res.json();
    assert.deepEqual(body, UDF_CONFIG);
  });
});

// ============================================================================
// L4 — one instrument lookup, not two
// ============================================================================

describe("MONEY-1383 L4 — GET /api/market/udf/symbols instrument lookups", () => {
  let route: GetOnly;

  before(() => {
    route = loadRoute(SYMBOLS_ROUTE_REL);
  });

  beforeEach(() => {
    instrumentLookups = [];
    instrumentRow = null;
  });

  it("resolves an equity with EXACTLY ONE instrumentMapping.findUnique", async () => {
    instrumentRow = {
      id: "inst_1",
      symbol: "TCS",
      exchange: "NSE",
      yahooSymbol: "TCS.NS",
      name: "Tata Consultancy Services",
      instrumentType: "EQUITY",
    };

    const res = await route.GET(makeRequest("?symbol=NSE:TCS"));
    assert.equal(res.status, 200);

    assert.equal(
      instrumentLookups.length,
      1,
      `expected 1 instrument lookup, got ${instrumentLookups.length}: ` +
        JSON.stringify(
          instrumentLookups.map((c) => Object.keys(c.select ?? {}))
        )
    );
  });

  it("that single lookup projects instrumentType (the column the second query used to fetch)", async () => {
    instrumentRow = {
      id: "inst_1",
      symbol: "TCS",
      exchange: "NSE",
      yahooSymbol: "TCS.NS",
      name: "Tata Consultancy Services",
      instrumentType: "EQUITY",
    };

    await route.GET(makeRequest("?symbol=NSE:TCS"));
    const select = instrumentLookups[0]?.select ?? {};
    assert.equal(
      select.instrumentType,
      true,
      "instrumentType must be projected by the one surviving lookup"
    );
    assert.equal(
      select.name,
      true,
      "the description still comes off the same row"
    );
  });

  it("still classifies an ETF from that one row", async () => {
    instrumentRow = {
      id: "inst_2",
      symbol: "NIFTYBEES",
      exchange: "NSE",
      yahooSymbol: "NIFTYBEES.NS",
      name: "Nippon India ETF Nifty 50 BeES",
      instrumentType: "ETF",
    };

    const res = await route.GET(makeRequest("?symbol=NSE:NIFTYBEES"));
    const body = (await res.json()) as { type?: string; description?: string };
    assert.equal(body.type, "etf");
    assert.equal(body.description, "Nippon India ETF Nifty 50 BeES");
    assert.equal(instrumentLookups.length, 1);
  });

  it("not-found is unchanged: a 200 error body, and no second lookup", async () => {
    instrumentRow = null;

    const res = await route.GET(makeRequest("?symbol=NSE:NOPE"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { s?: string; errmsg?: string };
    assert.equal(body.s, "error");
    assert.equal(body.errmsg, "unknown symbol: NSE:NOPE");
    assert.equal(
      instrumentLookups.length,
      1,
      "a miss must not fall through into a second query"
    );
  });
});
