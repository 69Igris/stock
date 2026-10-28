/**
 * Fund Composition API END-TO-END test (real GET handler).
 *
 * Drives the REAL exported `GET` from
 * `app/api/market/fund-composition/route.ts` with a real `NextRequest`,
 * injecting a stub for the route's only data dependency
 * (`getCompositionFromDb` from `@usemoney/core/market-data`) and the logger via
 * the `require.cache` seam (the established pattern from
 * `webhooks-dodo-e2e.test.ts`). Asserts the actual status codes + JSON bodies
 * the route returns for each branch:
 *
 *   - missing fundType / fundId            → 400
 *   - invalid fundType                     → 400
 *   - composition not yet extracted (null) → 404
 *   - found                                → 200 { data }
 *   - data layer throws                    → 500 with a SANITIZED message
 *     (regression: the catch block must NOT echo the raw error to the client)
 *
 * (Replaces the previous SHADOW, which reimplemented the handler inline and —
 * critically — modeled only `MF | ETF` as valid, missing the route's real
 * third valid type `INDEX`. The real handler is now the source of truth.)
 *
 * Source: apps/web/app/api/market/fund-composition/route.ts
 */

import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";

// ── require.cache injection ────────────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const ROUTE_REL = "../../app/api/market/fund-composition/route";

interface RouteModule {
  GET: (req: unknown) => Promise<Response>;
}

interface CompositionCall {
  fundType: string;
  fundId: string;
}

let lastCall: CompositionCall | null = null;
let stubResult: unknown = null;
let stubThrows: Error | null = null;

function loadRoute(): RouteModule {
  const cache = moduleCache();
  const marketDataPath = require.resolve("@usemoney/core/market-data");
  const loggerPath = require.resolve("@usemoney/logger");
  const routePath = require.resolve(ROUTE_REL);

  cache[marketDataPath] = {
    exports: {
      __esModule: true,
      getCompositionFromDb: (fundType: string, fundId: string) => {
        lastCall = { fundType, fundId };
        if (stubThrows) return Promise.reject(stubThrows);
        return Promise.resolve(stubResult);
      },
    },
  };
  cache[loggerPath] = {
    exports: {
      __esModule: true,
      apiLogger: { error: () => {}, info: () => {}, warn: () => {} },
    },
  };

  delete cache[routePath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ROUTE_REL) as RouteModule;
}

function makeRequest(query: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server");
  return new NextRequest(
    `http://localhost/api/market/fund-composition${query}`
  );
}

describe("Fund Composition GET (real handler)", () => {
  let route: RouteModule;

  before(() => {
    route = loadRoute();
  });

  afterEach(() => {
    lastCall = null;
    stubResult = null;
    stubThrows = null;
  });

  describe("parameter validation (400)", () => {
    it("400 when both fundType and fundId are absent", async () => {
      const res = await route.GET(makeRequest(""));
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error?: string };
      assert.match(body.error ?? "", /required/);
      assert.equal(lastCall, null, "must not hit the data layer");
    });

    it("400 when fundId is absent", async () => {
      const res = await route.GET(makeRequest("?fundType=MF"));
      assert.equal(res.status, 400);
      assert.equal(lastCall, null);
    });

    it("400 when fundType is absent", async () => {
      const res = await route.GET(makeRequest("?fundId=119551"));
      assert.equal(res.status, 400);
      assert.equal(lastCall, null);
    });

    it("400 for an invalid fundType", async () => {
      const res = await route.GET(makeRequest("?fundType=STOCK&fundId=119551"));
      assert.equal(res.status, 400);
      const body = (await res.json()) as { error?: string };
      assert.match(body.error ?? "", /MF, ETF, or INDEX/);
      assert.equal(lastCall, null);
    });
  });

  describe("valid fund types reach the data layer", () => {
    for (const fundType of ["MF", "ETF", "INDEX"]) {
      it(`${fundType} is accepted and queried (regression: INDEX is valid)`, async () => {
        stubResult = { holdings: [] };
        const res = await route.GET(
          makeRequest(`?fundType=${fundType}&fundId=42`)
        );
        assert.equal(res.status, 200);
        assert.deepEqual(lastCall, { fundType, fundId: "42" });
      });
    }
  });

  describe("not-found (404)", () => {
    it("404 when getCompositionFromDb returns null", async () => {
      stubResult = null;
      const res = await route.GET(makeRequest("?fundType=MF&fundId=119551"));
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error?: string };
      assert.match(body.error ?? "", /not yet extracted/);
    });
  });

  describe("found (200)", () => {
    it("200 wraps the composition under { data }", async () => {
      const composition = {
        fundType: "MF",
        fundId: "119551",
        holdings: [{ name: "RELIANCE", percentage: 8.2 }],
      };
      stubResult = composition;
      const res = await route.GET(makeRequest("?fundType=MF&fundId=119551"));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { data?: unknown };
      assert.deepEqual(body.data, composition);
    });
  });

  describe("data-layer failure (500, sanitized)", () => {
    it("500 with a generic message; the raw error is NOT echoed", async () => {
      stubThrows = new Error("Mongo connection string leaked: secret@host");
      const res = await route.GET(makeRequest("?fundType=ETF&fundId=7"));
      assert.equal(res.status, 500);
      const body = (await res.json()) as { error?: string };
      assert.equal(body.error, "Failed to fetch fund composition");
      assert.doesNotMatch(body.error ?? "", /Mongo|secret|host/);
    });
  });
});
