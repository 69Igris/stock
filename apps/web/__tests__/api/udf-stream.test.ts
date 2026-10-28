/**
 * UDF Stream Route — decommission contract (MONEY-566 P0c), END-TO-END.
 *
 * The live Zerodha WebSocket push stream is DECOMMISSIONED: it used to fan a
 * shared broker socket out to every SSE subscriber, leaking one user's ticks
 * into other users' charts (violates the Zerodha per-user data commitment), and
 * a per-user socket can't scale past Kite's 3-WS-per-API-key cap. The route is
 * now a small stub:
 *   - 401 if the request is unauthenticated;
 *   - 409 (a 4xx) otherwise, so the client EventSource fires `onerror`, closes,
 *     and TradingView falls back to per-user /history polling (compliant after
 *     P0a). The body carries reason "compliance:zerodha-per-user".
 *
 * This drives the REAL exported `GET` from
 * `app/api/market/udf/stream/route.ts`, mocking only `@clerk/nextjs/server`'s
 * `auth` via the `require.cache` seam. (Replaces the previous version, which
 * mirrored the handler's 401/409 decision inline as `streamRouteResponse` — the
 * real handler is now the source of truth, so it can't silently start returning
 * a 200 SSE that re-opens the shared WS.)
 *
 * Source: apps/web/app/api/market/udf/stream/route.ts
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const ROUTE_REL = "../../app/api/market/udf/stream/route";

interface RouteModule {
  GET: (req: unknown) => Promise<Response>;
}

function loadRoute(userId: string | null): RouteModule {
  const cache = moduleCache();
  const clerkPath = require.resolve("@clerk/nextjs/server");
  cache[clerkPath] = {
    exports: {
      __esModule: true,
      auth: () => Promise.resolve({ userId }),
    },
  };
  delete cache[require.resolve(ROUTE_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ROUTE_REL) as RouteModule;
}

function makeRequest(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server");
  return new NextRequest(
    "http://localhost/api/market/udf/stream?symbol=NSE:TCS&resolution=5"
  );
}

describe("UDF Stream Route — decommission contract (real GET)", () => {
  afterEach(() => {
    // Reset the mocked clerk module so a later suite re-requiring it isn't
    // poisoned by our stub.
    const cache = moduleCache();
    delete cache[require.resolve("@clerk/nextjs/server")];
  });

  it("returns 401 for an unauthenticated request", async () => {
    const route = loadRoute(null);
    const res = await route.GET(makeRequest());
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "authentication required");
  });

  it("returns 409 (never a 200 SSE) for an authenticated request", async () => {
    const route = loadRoute("user-1");
    const res = await route.GET(makeRequest());
    assert.equal(res.status, 409);
  });

  it("409 is a 4xx → client closes EventSource and polls /history", async () => {
    const route = loadRoute("user-1");
    const res = await route.GET(makeRequest());
    assert.ok(
      res.status >= 400 && res.status < 500,
      "must be a 4xx to trigger the client's onerror -> polling fallback"
    );
  });

  it("carries the per-user compliance reason code", async () => {
    const route = loadRoute("user-1");
    const res = await route.GET(makeRequest());
    const body = (await res.json()) as { error?: string; reason?: string };
    assert.equal(body.reason, "compliance:zerodha-per-user");
    assert.match(body.error ?? "", /history polling/);
  });

  it("never returns 200 — no shared Zerodha WS is ever opened", async () => {
    for (const uid of [null, "user-1", "user-2"]) {
      const route = loadRoute(uid);
      const res = await route.GET(makeRequest());
      assert.notEqual(res.status, 200);
    }
  });
});
