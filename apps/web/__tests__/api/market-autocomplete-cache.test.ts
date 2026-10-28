/**
 * MONEY-1123 — /api/market/autocomplete caching (real GET handler).
 *
 * The route is `force-dynamic` and was hit on EVERY 180ms-debounced keystroke of
 * the news SymbolPicker, reaching Atlas/Prisma each time. It now shares the same
 * `"market" / "_global"` cache the sibling `/api/market/search` route uses.
 *
 * Drives the REAL exported `GET` with a real `NextRequest`, injecting stubs for
 * Clerk, the cache (`@usemoney/core`), Atlas Search and the Prisma contains
 * fallback through the `require.cache` seam (the established pattern from
 * `fund-composition-route.test.ts`). No network, no Redis, no Prisma.
 *
 * Asserts:
 *   - a MISS populates the cache and a HIT skips the underlying search entirely
 *   - the key spans query + limit + types, and is case-insensitive (both
 *     backends are, so "rel" and "REL" may share one entry)
 *   - the cached payload is global-safe (nothing user-scoped in it)
 *   - the Atlas → contains fallback ordering is unchanged, and each source is
 *     cached under its own payload
 *   - 401-when-unauthenticated is unchanged and never touches the cache
 *   - NO `Cache-Control: public` header — this route is auth-gated, so a shared
 *     -cache directive would risk the CDN serving one user's response to another
 *
 * Source: apps/web/app/api/market/autocomplete/route.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorCacheEntries.has(path)) {
    priorCacheEntries.set(path, moduleCache()[path]);
  }
}

const ROUTE_REL = "../../app/api/market/autocomplete/route";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ROUTE_REL)];
}

interface AtlasRow {
  symbol: string;
  name: string;
  type: string;
  exchange: string;
}

interface CacheCall {
  module: string;
  scope: string;
  kind: string;
  filters: unknown;
}

interface Harness {
  userId: string | null;
  /** null = Atlas unavailable → contains fallback */
  atlasRows: AtlasRow[] | null;
  atlasThrows?: Error;
  containsRows: Array<{
    symbol: string;
    name: string;
    instrumentType: string;
    exchange: string;
  }>;
  atlasCalls: number;
  containsCalls: number;
  getCalls: CacheCall[];
  setCalls: Array<CacheCall & { value: unknown }>;
  store: Map<string, unknown>;
}

interface RouteModule {
  GET: (req: unknown) => Promise<Response>;
}

function freshHarness(): Harness {
  return {
    userId: "user_1",
    atlasRows: [
      {
        symbol: "RELIANCE",
        name: "Reliance Industries",
        type: "EQUITY",
        exchange: "NSE",
      },
    ],
    containsRows: [
      {
        symbol: "RELINFRA",
        name: "Reliance Infrastructure",
        instrumentType: "EQUITY",
        exchange: "NSE",
      },
    ],
    atlasCalls: 0,
    containsCalls: 0,
    getCalls: [],
    setCalls: [],
    store: new Map(),
  };
}

function keyOf(c: CacheCall): string {
  return JSON.stringify([c.module, c.scope, c.kind, c.filters]);
}

function loadRoute(h: Harness): RouteModule {
  const cache = moduleCache();

  const clerkPath = require.resolve("@clerk/nextjs/server");
  const corePath = require.resolve("@usemoney/core");
  const atlasPath = require.resolve("../../lib/market/atlas-search");
  const mapperPath = require.resolve("../../lib/market/symbol-mapper");
  const loggerPath = require.resolve("@usemoney/logger");
  const routePath = require.resolve(ROUTE_REL);

  for (const p of [clerkPath, corePath, atlasPath, mapperPath, loggerPath]) {
    snapshotOnce(p);
  }

  cache[clerkPath] = {
    exports: {
      __esModule: true,
      auth: () => Promise.resolve({ userId: h.userId }),
    },
  };

  cache[corePath] = {
    exports: {
      __esModule: true,
      getCached: (
        module: string,
        scope: string,
        kind: string,
        filters: unknown
      ) => {
        const call = { module, scope, kind, filters };
        h.getCalls.push(call);
        return Promise.resolve(h.store.get(keyOf(call)) ?? null);
      },
      setCached: (
        module: string,
        scope: string,
        kind: string,
        value: unknown,
        filters: unknown
      ) => {
        const call = { module, scope, kind, filters };
        h.setCalls.push({ ...call, value });
        h.store.set(keyOf(call), value);
        return Promise.resolve();
      },
    },
  };

  cache[atlasPath] = {
    exports: {
      __esModule: true,
      autocompleteInstruments: () => {
        h.atlasCalls += 1;
        if (h.atlasThrows) return Promise.reject(h.atlasThrows);
        return Promise.resolve(h.atlasRows);
      },
    },
  };

  cache[mapperPath] = {
    exports: {
      __esModule: true,
      searchInstruments: () => {
        h.containsCalls += 1;
        return Promise.resolve(h.containsRows);
      },
    },
  };

  cache[loggerPath] = {
    exports: {
      __esModule: true,
      apiLogger: {
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
      },
    },
  };

  delete cache[routePath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ROUTE_REL) as RouteModule;
}

function makeRequest(query: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server");
  return new NextRequest(`http://localhost/api/market/autocomplete${query}`);
}

interface AutocompleteBody {
  success?: boolean;
  results?: AtlasRow[];
  count?: number;
  source?: string;
  error?: string;
}

describe("MONEY-1123 — market autocomplete caching (real GET)", () => {
  let h: Harness;
  let route: RouteModule;

  beforeEach(() => {
    h = freshHarness();
    route = loadRoute(h);
  });

  after(() => {
    restoreCache();
  });

  describe("cache miss → populate", () => {
    it("a miss runs Atlas and writes the payload to the market/_global cache", async () => {
      const res = await route.GET(makeRequest("?q=rel"));
      assert.equal(res.status, 200);

      const body = (await res.json()) as AutocompleteBody;
      assert.equal(body.source, "atlas");
      assert.equal(body.results?.length, 1);
      assert.equal(body.results?.[0]?.symbol, "RELIANCE");

      assert.equal(h.atlasCalls, 1);
      assert.equal(h.getCalls.length, 1, "the cache must be consulted first");
      assert.equal(h.setCalls.length, 1, "a miss must populate the cache");

      const write = h.setCalls[0]!;
      assert.equal(write.module, "market");
      assert.equal(
        write.scope,
        "_global",
        "results are query-scoped, not user-scoped"
      );
      assert.equal(write.kind, "autocomplete");
      assert.deepEqual(write.value, body, "the cached payload is the response");
    });

    it("the cache key spans the normalized query, limit and types", async () => {
      await route.GET(makeRequest("?q=rel&limit=5&types=EQUITY,ETF"));
      assert.deepEqual(h.getCalls[0]?.filters, {
        query: "REL",
        limit: 5,
        types: "EQUITY,ETF",
      });
    });

    it("no types param → an empty types component (not undefined)", async () => {
      await route.GET(makeRequest("?q=rel"));
      assert.deepEqual(h.getCalls[0]?.filters, {
        query: "REL",
        limit: 8,
        types: "",
      });
    });

    it("the cached payload carries nothing user-scoped (safe to share globally)", async () => {
      await route.GET(makeRequest("?q=rel"));
      const value = h.setCalls[0]?.value as AutocompleteBody;
      assert.deepEqual(Object.keys(value).sort(), [
        "count",
        "results",
        "source",
        "success",
      ]);
      for (const row of value.results ?? []) {
        assert.deepEqual(Object.keys(row).sort(), [
          "exchange",
          "name",
          "symbol",
          "type",
        ]);
      }
    });
  });

  describe("cache hit → skip the search", () => {
    it("a second identical request never reaches Atlas", async () => {
      const first = await route.GET(makeRequest("?q=rel"));
      const firstBody = (await first.json()) as AutocompleteBody;
      assert.equal(h.atlasCalls, 1);

      const second = await route.GET(makeRequest("?q=rel"));
      const secondBody = (await second.json()) as AutocompleteBody;

      assert.equal(second.status, 200);
      assert.equal(
        h.atlasCalls,
        1,
        "REGRESSION: a cache hit must not query Atlas"
      );
      assert.equal(h.containsCalls, 0);
      assert.equal(h.setCalls.length, 1, "a hit must not re-write the cache");
      assert.deepEqual(secondBody, firstBody);
    });

    it("'rel' and 'REL' share one entry (both backends are case-insensitive)", async () => {
      await route.GET(makeRequest("?q=rel"));
      await route.GET(makeRequest("?q=REL"));
      assert.equal(h.atlasCalls, 1);
    });

    it("a different limit is a different key (miss)", async () => {
      await route.GET(makeRequest("?q=rel"));
      await route.GET(makeRequest("?q=rel&limit=3"));
      assert.equal(h.atlasCalls, 2);
    });

    it("a different types filter is a different key (miss)", async () => {
      await route.GET(makeRequest("?q=rel&types=EQUITY"));
      await route.GET(makeRequest("?q=rel&types=ETF"));
      assert.equal(h.atlasCalls, 2);
    });

    it("a longer query is a different key — typing still fetches once per prefix", async () => {
      await route.GET(makeRequest("?q=rel"));
      await route.GET(makeRequest("?q=reli"));
      await route.GET(makeRequest("?q=rel")); // backspace → served from cache
      assert.equal(h.atlasCalls, 2);
    });
  });

  describe("unchanged behaviour", () => {
    it("401 when unauthenticated, and the cache is never touched", async () => {
      h.userId = null;
      const res = await route.GET(makeRequest("?q=rel"));
      assert.equal(res.status, 401);
      const body = (await res.json()) as AutocompleteBody;
      assert.equal(body.error, "Authentication required");
      assert.equal(h.getCalls.length, 0);
      assert.equal(h.setCalls.length, 0);
      assert.equal(h.atlasCalls, 0);
    });

    it("an empty query returns the empty envelope without consulting the cache", async () => {
      const res = await route.GET(makeRequest(""));
      assert.equal(res.status, 200);
      const body = (await res.json()) as AutocompleteBody;
      assert.equal(body.source, "empty");
      assert.deepEqual(body.results, []);
      assert.equal(h.getCalls.length, 0);
      assert.equal(h.setCalls.length, 0);
      assert.equal(h.atlasCalls, 0);
    });

    it("Atlas unavailable (null) falls back to contains, and that payload is cached", async () => {
      h.atlasRows = null;
      const res = await route.GET(makeRequest("?q=rel"));
      const body = (await res.json()) as AutocompleteBody;

      assert.equal(body.source, "contains");
      assert.equal(body.results?.[0]?.symbol, "RELINFRA");
      assert.equal(body.results?.[0]?.type, "EQUITY", "instrumentType → type");
      assert.equal(h.atlasCalls, 1, "Atlas is still tried FIRST");
      assert.equal(h.containsCalls, 1);
      assert.equal(h.setCalls.length, 1);

      await route.GET(makeRequest("?q=rel"));
      assert.equal(h.containsCalls, 1, "the fallback payload is cached too");
    });

    it("a thrown search still returns 500 with a generic message", async () => {
      h.atlasThrows = new Error("mongo down: secret@host");
      const res = await route.GET(makeRequest("?q=rel"));
      assert.equal(res.status, 500);
      const body = (await res.json()) as AutocompleteBody;
      assert.equal(body.error, "Failed to autocomplete");
      assert.equal(h.setCalls.length, 0, "a failure must not be cached");
    });
  });

  describe("HTTP caching headers", () => {
    it("does NOT set a shared-cache Cache-Control header (route is auth-gated)", async () => {
      const res = await route.GET(makeRequest("?q=rel"));
      const cc = res.headers.get("cache-control") ?? "";
      assert.doesNotMatch(
        cc,
        /public|s-maxage/,
        "a shared-cache directive on an authenticated route risks cross-user caching at the edge"
      );
    });
  });
});
