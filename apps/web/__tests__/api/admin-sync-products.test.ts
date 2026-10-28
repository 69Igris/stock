/**
 * Admin Sync Products route END-TO-END test (real POST handler).
 *
 * Drives the REAL exported `POST` from
 * `app/api/admin/sync-products/route.ts` through its actual auth gate, injecting
 * stubs for `@clerk/nextjs/server` (`auth`, `clerkClient`),
 * `@usemoney/services` (`syncDodoProducts`), and the logger via the
 * `require.cache` seam (the pattern from `webhooks-dodo-e2e.test.ts`). This
 * exercises the route's real ordering — unauthenticated(401) → non-admin(403) →
 * admin(200) — and the real `checkAdminAccess` / `formatAdminSyncResponse` it
 * calls.
 *
 * (Replaces the previous SHADOW, which reimplemented `checkAuth` / `isAdmin`
 * inline. The pure gate is already unit-tested via the real `route-logic`
 * import in `admin-routes.test.ts`; THIS file adds end-to-end handler coverage:
 * that the gate is actually WIRED into POST, that a non-admin never reaches
 * syncDodoProducts, and that a thrown sync error becomes a sanitized 500.)
 *
 * Source: apps/web/app/api/admin/sync-products/route.ts
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const ROUTE_REL = "../../app/api/admin/sync-products/route";

interface RouteModule {
  POST: (req: unknown) => Promise<Response>;
}

interface ClerkStub {
  userId: string | null;
  publicMetadata: Record<string, unknown>;
}

let syncCalled = false;
let syncResult: { synced: number; errors: string[] } = {
  synced: 0,
  errors: [],
};
let syncThrows: Error | null = null;

function loadRoute(clerk: ClerkStub): RouteModule {
  const cache = moduleCache();
  const clerkPath = require.resolve("@clerk/nextjs/server");
  // The route imports the SUBPATH (MONEY-1062 review) — stub that module, not
  // the root barrel, or the spy would never be hit.
  const syncPath = require.resolve("@usemoney/services/product-sync");
  const loggerPath = require.resolve("@usemoney/logger");
  const routePath = require.resolve(ROUTE_REL);

  cache[clerkPath] = {
    exports: {
      __esModule: true,
      auth: () => Promise.resolve({ userId: clerk.userId }),
      clerkClient: () =>
        Promise.resolve({
          users: {
            getUser: () =>
              Promise.resolve({ publicMetadata: clerk.publicMetadata }),
          },
        }),
    },
  };
  cache[syncPath] = {
    exports: {
      __esModule: true,
      syncDodoProducts: () => {
        syncCalled = true;
        if (syncThrows) return Promise.reject(syncThrows);
        return Promise.resolve(syncResult);
      },
    },
  };
  cache[loggerPath] = {
    exports: {
      __esModule: true,
      paymentsLogger: { error: () => {}, info: () => {}, warn: () => {} },
    },
  };

  delete cache[routePath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ROUTE_REL) as RouteModule;
}

function makeRequest(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest } = require("next/server");
  return new NextRequest("http://localhost/api/admin/sync-products", {
    method: "POST",
  });
}

describe("Admin Sync Products POST (real handler)", () => {
  afterEach(() => {
    syncCalled = false;
    syncResult = { synced: 0, errors: [] };
    syncThrows = null;
  });

  it("401 for an unauthenticated request; sync never runs", async () => {
    const route = loadRoute({ userId: null, publicMetadata: {} });
    const res = await route.POST(makeRequest());
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "Unauthorized");
    assert.equal(syncCalled, false, "unauthenticated must not trigger a sync");
  });

  it("403 for an authenticated NON-admin; sync never runs", async () => {
    const route = loadRoute({
      userId: "user_123",
      publicMetadata: { role: "user" },
    });
    const res = await route.POST(makeRequest());
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "Forbidden");
    assert.equal(syncCalled, false, "non-admin must not trigger a sync");
  });

  it("403 when role metadata is missing entirely", async () => {
    const route = loadRoute({ userId: "user_123", publicMetadata: {} });
    const res = await route.POST(makeRequest());
    assert.equal(res.status, 403);
    assert.equal(syncCalled, false);
  });

  it("is case-sensitive: role 'Admin' is rejected (403)", async () => {
    const route = loadRoute({
      userId: "user_123",
      publicMetadata: { role: "Admin" },
    });
    const res = await route.POST(makeRequest());
    assert.equal(res.status, 403);
    assert.equal(syncCalled, false);
  });

  it("200 for an admin; runs the sync and returns its shape", async () => {
    syncResult = { synced: 7, errors: ["Product X: skipped"] };
    const route = loadRoute({
      userId: "admin_1",
      publicMetadata: { role: "admin" },
    });
    const res = await route.POST(makeRequest());
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      success?: boolean;
      synced?: number;
      errors?: string[];
      timestamp?: string;
    };
    assert.equal(body.success, true);
    assert.equal(body.synced, 7);
    assert.deepEqual(body.errors, ["Product X: skipped"]);
    assert.ok(
      body.timestamp && !Number.isNaN(Date.parse(body.timestamp)),
      "expected an ISO timestamp"
    );
    assert.equal(syncCalled, true);
  });

  it("500 (sanitized) when the sync throws; raw error is not echoed", async () => {
    syncThrows = new Error("Dodo API key invalid: sk_live_secret");
    const route = loadRoute({
      userId: "admin_1",
      publicMetadata: { role: "admin" },
    });
    const res = await route.POST(makeRequest());
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "Product sync failed");
    assert.doesNotMatch(body.error ?? "", /sk_live|secret|Dodo API key/);
  });
});
