/**
 * Route gating for the Lane 14d discover surfaces — MONEY-1204 (P14 / 14d.3 ·
 * 14d.5 · 14d.6).
 *
 * ## Why this file exists at all
 *
 * `apps/web/proxy-routes.ts` records THREE production outages caused by adding
 * a route and forgetting to gate it — `/etf`, `/calculators`, `/notifications`.
 * All three were TOP-LEVEL paths that matched no pattern in either list, fell
 * to the catch-all at the bottom of `proxy.ts`, and bounced every demo visitor
 * (no Clerk session) to `/sign-in` mid-session. The failure is invisible to
 * anyone testing signed-in.
 *
 * The three routes added here — `/discover/ipo`, `/discover/circulars`,
 * `/discover/indices/[slug]` — sit UNDER `/discover/`, which is already covered
 * by `"/discover(.*)"` in `APP_ROUTE_PATTERNS`, so they need no change to that
 * file. This test is what turns "should be covered" into "is covered": it
 * compiles the REAL exported arrays the same way `proxy.ts` does, rather than a
 * copy, so deleting or narrowing `/discover(.*)` fails here instead of in
 * production.
 *
 * It also pins the two things that must NOT be true of these routes: they are
 * not public (portfolio-adjacent surfaces behind the app shell), and they are
 * not left to the catch-all (which has no demo branch).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APP_ROUTE_PATTERNS,
  PUBLIC_ROUTE_PATTERNS,
  API_ROUTE_PATTERNS,
} from "@/proxy-routes";
import {
  indexDetailHref,
  toIndexRouteSlug,
} from "@/components/discover/indexRouteLink";

/**
 * Match a concrete pathname the way `createRouteMatcher` does for these
 * patterns: anchored, with `(.*)` the only regex token in play. Same helper
 * shape as `__tests__/middleware/route-access.test.ts`, so both files agree on
 * what "matched" means.
 */
function matches(patterns: string[], pathname: string): boolean {
  return patterns.some((p) => new RegExp(`^${p}$`).test(pathname));
}

/** Every concrete path the three new routes can serve. */
const NEW_DISCOVER_ROUTES = [
  "/discover/ipo",
  "/discover/circulars",
  "/discover/circulars?department=Surveillance",
  "/discover/indices/nifty-50",
  "/discover/indices/nifty-bank",
  "/discover/indices/india-vix",
  // A slug with an encoded space, which is a legitimate alias spelling.
  "/discover/indices/Bank%20Nifty",
];

/** Route directories this change adds, relative to apps/web. */
const NEW_ROUTE_DIRS = [
  "app/discover/ipo",
  "app/discover/circulars",
  "app/discover/indices/[slug]",
];

const WEB_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

describe("MONEY-1204 discover routes — proxy gating", () => {
  it("every new route is an APP route (auth OR demo cookie)", () => {
    for (const path of NEW_DISCOVER_ROUTES) {
      const pathname = path.split("?")[0] as string;
      assert.ok(
        matches(APP_ROUTE_PATTERNS, pathname),
        `${pathname} is NOT matched by APP_ROUTE_PATTERNS — it would fall to the catch-all in proxy.ts, which has no demo branch, and bounce every demo visitor to /sign-in`
      );
    }
  });

  it("they are covered by the EXISTING /discover(.*) pattern — no new entry needed", () => {
    // The load-bearing claim of this change: `/discover(.*)` already covers
    // every sub-route, so `proxy-routes.ts` is untouched. If someone narrows
    // that pattern (e.g. to `/discover` or `/discover/[a-z]+`), this fails.
    assert.ok(
      APP_ROUTE_PATTERNS.includes("/discover(.*)"),
      "APP_ROUTE_PATTERNS must contain the exact pattern '/discover(.*)'"
    );
    const withoutDiscover = APP_ROUTE_PATTERNS.filter(
      (p) => p !== "/discover(.*)"
    );
    for (const path of NEW_DISCOVER_ROUTES) {
      const pathname = path.split("?")[0] as string;
      assert.ok(
        !matches(withoutDiscover, pathname),
        `${pathname} is matched by a pattern OTHER than /discover(.*) — the coverage claim in the route files is wrong`
      );
    }
  });

  it("none of them is public — these are behind the app shell", () => {
    for (const path of NEW_DISCOVER_ROUTES) {
      const pathname = path.split("?")[0] as string;
      assert.ok(
        !matches(PUBLIC_ROUTE_PATTERNS, pathname),
        `${pathname} must NOT be public — it renders portfolio-adjacent surfaces behind Sidebar/PageGuard`
      );
    }
  });

  it("none of them is misclassified as an API route", () => {
    for (const path of NEW_DISCOVER_ROUTES) {
      const pathname = path.split("?")[0] as string;
      assert.ok(
        !matches(API_ROUTE_PATTERNS, pathname),
        `${pathname} must not match /api(.*) — an API match returns 401 JSON instead of redirecting a browser`
      );
    }
  });

  it("the sibling discover routes that already shipped stay gated", () => {
    // Guards against a "cleanup" that replaces the wildcard with an explicit
    // allow-list and misses one.
    for (const pathname of [
      "/discover",
      "/discover/markets",
      "/discover/news",
      "/discover/screener",
      "/discover/lists",
      "/discover/scans",
      "/discover/sectors",
    ]) {
      assert.ok(
        matches(APP_ROUTE_PATTERNS, pathname),
        `${pathname} lost its gating`
      );
    }
  });

  it("the route directories asserted above actually exist on disk", () => {
    // Without this the gating assertions would keep passing after the routes
    // were deleted or moved — a green test proving nothing.
    for (const dir of NEW_ROUTE_DIRS) {
      const abs = join(WEB_ROOT, dir);
      assert.ok(existsSync(abs), `${dir} does not exist`);
      assert.ok(
        existsSync(join(abs, "page.tsx")),
        `${dir}/page.tsx does not exist`
      );
    }
  });

  it("the index-card href builder produces a GATED route for every index name", () => {
    // The markets page links its index cards through `indexDetailHref`. If that
    // ever emitted a path outside /discover/ — a top-level "/indices/nifty-50",
    // say — it would be the /etf outage again: the link works signed in and
    // bounces every demo visitor to /sign-in.
    for (const name of [
      "Nifty 50",
      "NIFTY BANK",
      "Nifty Next 50",
      "India VIX",
      "Nifty BHARAT Bond Index - Apr 33",
    ]) {
      const href = indexDetailHref(name);
      assert.ok(href, `${name} produced no href`);
      assert.ok(
        matches(APP_ROUTE_PATTERNS, href),
        `${href} is not gated as an app route`
      );
    }
  });

  it("the client-side slugifier agrees with the WRITER of IndexClose.indexSlug", () => {
    // `toIndexRouteSlug` is a deliberate bundle-boundary copy of `toIndexSlug`
    // in workers/src/processors/bhavcopy-sync-logic.ts (importing the core
    // barrel into a client component would pull the whole feed pipeline into
    // the browser). These are the WRITER's own documented examples — a drift
    // here is a 404 on a real index.
    assert.equal(toIndexRouteSlug("Nifty 50"), "nifty-50");
    assert.equal(toIndexRouteSlug("NIFTY BANK"), "nifty-bank");
    assert.equal(
      toIndexRouteSlug("Nifty BHARAT Bond Index - Apr 33"),
      "nifty-bharat-bond-index-apr-33"
    );
    // An unusable name yields null rather than a link to "/discover/indices/".
    assert.equal(indexDetailHref("   "), null);
    assert.equal(indexDetailHref("---"), null);
  });

  it("no route added by this change sits outside /discover/", () => {
    // The rule the three recorded outages come from: a TOP-LEVEL route needs
    // its own pattern. If a future edit adds one here, this fails loudly and
    // points at the file to change.
    for (const dir of NEW_ROUTE_DIRS) {
      assert.ok(
        dir.startsWith("app/discover/"),
        `${dir} is outside /discover/ and MUST be added to proxy-routes.ts in the same change`
      );
    }
  });
});
