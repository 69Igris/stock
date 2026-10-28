/**
 * Proxy (Middleware) Route Matching Tests
 *
 * De-shadowed (MONEY-620): previously this file inlined its own (badly drifted)
 * copy of the public/api/app route patterns. It now imports the REAL pattern
 * arrays from `@/proxy-routes` — the exact arrays `proxy.ts` feeds into Clerk's
 * `createRouteMatcher`. A faithful pure matcher anchors each pattern as
 * `^<pattern>$` (the only regex token in these strings is the intended `(.*)`),
 * mirroring how Clerk's path matcher classifies a pathname. Adding/removing a
 * route in production now flows straight into these assertions.
 *
 * Source: apps/web/proxy-routes.ts (consumed by apps/web/proxy.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PUBLIC_ROUTE_PATTERNS,
  API_ROUTE_PATTERNS,
  APP_ROUTE_PATTERNS,
} from "@/proxy-routes";

// Build a matcher from the REAL pattern strings. Clerk's createRouteMatcher
// compiles each glob to an anchored regex; for these route strings (whose only
// regex token is `(.*)`) `^<pattern>$` is faithful.
function makeMatcher(patterns: string[]): (pathname: string) => boolean {
  const regexes = patterns.map((p) => new RegExp(`^${p}$`));
  return (pathname: string) => regexes.some((re) => re.test(pathname));
}

const isPublicRoute = makeMatcher(PUBLIC_ROUTE_PATTERNS);
const isApiRoute = makeMatcher(API_ROUTE_PATTERNS);
const isAppRoute = makeMatcher(APP_ROUTE_PATTERNS);

/**
 * Reproduces the proxy.ts control flow ordering: public wins, then API (401 if
 * unauthenticated), then app (passthrough to let the page handle the demo
 * cookie), else redirect-to-signin when unauthenticated.
 */
function getRouteAction(
  pathname: string,
  isAuthenticated: boolean
): "allow" | "api-401" | "app-passthrough" | "redirect-signin" {
  if (isPublicRoute(pathname)) return "allow";
  if (isApiRoute(pathname)) return isAuthenticated ? "allow" : "api-401";
  if (isAppRoute(pathname)) return "app-passthrough";
  return isAuthenticated ? "allow" : "redirect-signin";
}

describe("Middleware Route Matching", () => {
  // -- Public Routes --

  describe("isPublicRoute", () => {
    it("should match root /", () => {
      assert.strictEqual(isPublicRoute("/"), true);
    });

    it("should match /home", () => {
      assert.strictEqual(isPublicRoute("/home"), true);
    });

    it("should match /sign-in", () => {
      assert.strictEqual(isPublicRoute("/sign-in"), true);
    });

    it("should match /sign-in/factor-one", () => {
      assert.strictEqual(isPublicRoute("/sign-in/factor-one"), true);
    });

    it("should match /sign-up", () => {
      assert.strictEqual(isPublicRoute("/sign-up"), true);
    });

    it("should match /sign-up/verify", () => {
      assert.strictEqual(isPublicRoute("/sign-up/verify"), true);
    });

    it("should match /privacy", () => {
      assert.strictEqual(isPublicRoute("/privacy"), true);
    });

    it("should match /terms", () => {
      assert.strictEqual(isPublicRoute("/terms"), true);
    });

    it("should match the legal/compliance pages added after the old shadow", () => {
      // These were MISSING from the old inline copy — proving the drift.
      assert.strictEqual(isPublicRoute("/data-usage"), true);
      assert.strictEqual(isPublicRoute("/risk-disclosure"), true);
      assert.strictEqual(isPublicRoute("/subprocessors"), true);
      assert.strictEqual(isPublicRoute("/legal"), true);
    });

    it("should match the marketing routes added after the old shadow", () => {
      assert.strictEqual(isPublicRoute("/pricing"), true);
      assert.strictEqual(isPublicRoute("/blog/post"), true);
      assert.strictEqual(isPublicRoute("/features"), true);
      assert.strictEqual(isPublicRoute("/docs/getting-started"), true);
    });

    it("should match /api/webhooks/dodo", () => {
      assert.strictEqual(isPublicRoute("/api/webhooks/dodo"), true);
    });

    it("should match /api/demo/start (public)", () => {
      assert.strictEqual(isPublicRoute("/api/demo/start"), true);
    });

    it("should match /api/market/indices (auth-aware feed)", () => {
      assert.strictEqual(isPublicRoute("/api/market/indices"), true);
    });

    it("should match /api/cron/* (Bearer-token crons; handlers fail closed via verifyCronAuth)", () => {
      assert.strictEqual(
        isPublicRoute("/api/cron/apply-scheduled-plan-changes"),
        true
      );
      assert.strictEqual(isPublicRoute("/api/cron/sync-products"), true);
    });

    it("should match /api/auth/signup-precheck (signed-out /sign-up caller; rate-limited + anti-enumeration)", () => {
      assert.strictEqual(isPublicRoute("/api/auth/signup-precheck"), true);
    });

    it("should NOT widen the wall past those two additions", () => {
      // An ordinary data API is still gated (middleware 401 when unauth).
      assert.strictEqual(isPublicRoute("/api/user-data"), false);
      // /api/auth/* is NOT broadly public — only the exact precheck path is.
      assert.strictEqual(isPublicRoute("/api/auth/whoami"), false);
    });

    it("should match /ingest/events", () => {
      assert.strictEqual(isPublicRoute("/ingest/events"), true);
    });

    it("should match /learning", () => {
      assert.strictEqual(isPublicRoute("/learning"), true);
    });

    it("should match /learning/some-course", () => {
      assert.strictEqual(isPublicRoute("/learning/some-course"), true);
    });

    it("should NOT match /dashboard", () => {
      assert.strictEqual(isPublicRoute("/dashboard"), false);
    });

    it("should NOT match /settings", () => {
      assert.strictEqual(isPublicRoute("/settings"), false);
    });
  });

  // -- API Routes --

  describe("isApiRoute", () => {
    it("should match /api", () => {
      assert.strictEqual(isApiRoute("/api"), true);
    });

    it("should match /api/trades", () => {
      assert.strictEqual(isApiRoute("/api/trades"), true);
    });

    it("should match /api/webhooks/dodo", () => {
      assert.strictEqual(isApiRoute("/api/webhooks/dodo"), true);
    });

    it("should NOT match /dashboard", () => {
      assert.strictEqual(isApiRoute("/dashboard"), false);
    });

    it("should NOT match /", () => {
      assert.strictEqual(isApiRoute("/"), false);
    });
  });

  // -- App Routes --

  describe("isAppRoute", () => {
    it("should match /dashboard", () => {
      assert.strictEqual(isAppRoute("/dashboard"), true);
    });

    it("should match /tradebook", () => {
      assert.strictEqual(isAppRoute("/tradebook"), true);
    });

    it("should match /positions", () => {
      assert.strictEqual(isAppRoute("/positions"), true);
    });

    it("should match /holdings", () => {
      assert.strictEqual(isAppRoute("/holdings"), true);
    });

    it("should match /discover", () => {
      assert.strictEqual(isAppRoute("/discover"), true);
    });

    it("should match /watchlist", () => {
      assert.strictEqual(isAppRoute("/watchlist"), true);
    });

    it("should match /paper-trading", () => {
      assert.strictEqual(isAppRoute("/paper-trading"), true);
    });

    it("should match /settings/profile", () => {
      assert.strictEqual(isAppRoute("/settings/profile"), true);
    });

    it("should match /stock/RELIANCE", () => {
      assert.strictEqual(isAppRoute("/stock/RELIANCE"), true);
    });

    it("should match /mf/some-fund", () => {
      assert.strictEqual(isAppRoute("/mf/some-fund"), true);
    });

    it("should match /compare", () => {
      assert.strictEqual(isAppRoute("/compare"), true);
    });

    it("should match the app routes added after the old shadow (calculators/notifications/roast)", () => {
      assert.strictEqual(isAppRoute("/calculators"), true);
      assert.strictEqual(isAppRoute("/notifications"), true);
      assert.strictEqual(isAppRoute("/roast"), true);
      assert.strictEqual(isAppRoute("/risk"), true);
      assert.strictEqual(isAppRoute("/tax"), true);
    });

    it("should NOT match /", () => {
      assert.strictEqual(isAppRoute("/"), false);
    });

    it("should NOT match /sign-in", () => {
      assert.strictEqual(isAppRoute("/sign-in"), false);
    });

    it("should NOT match /some-random-page", () => {
      assert.strictEqual(isAppRoute("/some-random-page"), false);
    });
  });

  // -- Route Action Determination --

  describe("getRouteAction", () => {
    it("should allow public routes regardless of auth", () => {
      assert.strictEqual(getRouteAction("/", false), "allow");
      assert.strictEqual(getRouteAction("/", true), "allow");
      assert.strictEqual(getRouteAction("/sign-in", false), "allow");
    });

    it("should return api-401 for unauthenticated API routes", () => {
      assert.strictEqual(getRouteAction("/api/trades", false), "api-401");
    });

    it("should allow authenticated API routes", () => {
      assert.strictEqual(getRouteAction("/api/trades", true), "allow");
    });

    it("should pass through app routes (authenticated or not)", () => {
      assert.strictEqual(
        getRouteAction("/dashboard", false),
        "app-passthrough"
      );
      assert.strictEqual(getRouteAction("/dashboard", true), "app-passthrough");
    });

    it("should redirect unauthenticated users on other routes", () => {
      assert.strictEqual(
        getRouteAction("/some-other-page", false),
        "redirect-signin"
      );
    });

    it("should allow authenticated users on other routes", () => {
      assert.strictEqual(getRouteAction("/some-other-page", true), "allow");
    });

    it("should prioritize public over API for webhook routes", () => {
      assert.strictEqual(getRouteAction("/api/webhooks/dodo", false), "allow");
    });

    it("should prioritize public over API for /api/demo/start", () => {
      // /api/demo(.*) is in the public list, so demo bootstrap is reachable
      // without a session.
      assert.strictEqual(getRouteAction("/api/demo/start", false), "allow");
    });

    it("should allow unauthenticated crons through to the handler (FIX 1)", () => {
      // The Bearer-token cron carries no Clerk session; the middleware must let
      // it reach the handler, which then enforces verifyCronAuth itself.
      assert.strictEqual(
        getRouteAction("/api/cron/apply-scheduled-plan-changes", false),
        "allow"
      );
      assert.strictEqual(
        getRouteAction("/api/cron/sync-products", false),
        "allow"
      );
    });

    it("should allow the signed-out signup-precheck through to the handler (FIX 2)", () => {
      assert.strictEqual(
        getRouteAction("/api/auth/signup-precheck", false),
        "allow"
      );
    });
  });

  // -- Demo Mode Verification --

  describe("Demo mode handling at the middleware level", () => {
    it("app routes are passthrough (page handles demo cookie), not middleware-allow", () => {
      // The middleware passes app routes through regardless of auth, letting the
      // page component / server action handle the HMAC demo cookie. This proves
      // the middleware itself does NOT grant access based on demo state.
      assert.strictEqual(
        getRouteAction("/dashboard", false),
        "app-passthrough"
      );
    });

    it("non-app non-public routes still redirect without auth", () => {
      assert.strictEqual(
        getRouteAction("/admin-panel", false),
        "redirect-signin"
      );
    });

    it("demo cookie must NOT bypass an auth-required API route", () => {
      // /api/trades is NOT in the public list, so an unauthenticated request
      // (even a demo one) gets a 401 from the middleware.
      assert.strictEqual(getRouteAction("/api/trades", false), "api-401");
    });

    it("all app routes passthrough regardless of auth state", () => {
      const appRoutes = [
        "/dashboard",
        "/holdings",
        "/positions",
        "/tradebook",
        "/fire",
        "/paper-trading",
        "/brokers",
        "/watchlist",
        "/settings",
      ];
      for (const route of appRoutes) {
        assert.strictEqual(
          getRouteAction(route, false),
          "app-passthrough",
          `${route} should be app-passthrough`
        );
      }
    });
  });
});
