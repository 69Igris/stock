/**
 * Every app route must keep the sidebar visible while it loads (MONEY-1256).
 *
 * The sidebar is rendered PER PAGE, not by the root layout. That is deliberate
 * and measured: `Sidebar.tsx` records that one mount fires 19 middleware
 * invocations at 550–1300 ms TTFB apiece, so hoisting it to the root layout
 * made cold loads dramatically worse.
 *
 * The consequence is easy to forget when adding a route: with no `loading.tsx`
 * and no sidebar-bearing ancestor layout, NOTHING renders while the server
 * responds — the sidebar disappears and the page sits blank under the root
 * layout's topbar. Thirteen routes had shipped that way.
 *
 * This walks the real `app/` tree rather than asserting a list, because a list
 * is exactly what fails to notice the next route someone adds.
 *
 * Excluded, correctly: `(marketing)` and `(public)` groups (logged-out pages
 * have no sidebar), and pure redirect routes, which render no chrome by design.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(__dirname, "..", "..", "app");

/** Route groups whose pages are logged-out and legitimately sidebar-free. */
const SIDEBARLESS_GROUPS = ["(marketing)", "(public)"];

/**
 * Routes that render no chrome ON PURPOSE. Kept explicit and short so an
 * addition here is a visible decision rather than a silent exemption.
 */
const CHROME_EXEMPT = new Set([
  "/discover/sectors", // redirect → /discover/markets (MONEY-1092)
  "/discover/sectors/[sector]", // same redirect
  "/launch", // post-login redirect router
  "/welcome", // onboarding wizard, own full-screen chrome
  "/sso-callback",
  "/debug-posthog",
  "/forgot-password",
  "/sign-in/[[...sign-in]]",
  "/sign-up/[[...sign-up]]",
]);

/**
 * Markers that mean "this file puts the sidebar chrome on screen".
 *
 * `<Sidebar[\s/>]` and NOT a bare `<Sidebar`: the loose form also matches
 * `<SidebarProvider>`, which the ROOT layout renders. With that, the ancestor
 * walk below hit app/layout.tsx and returned true for every route, so this
 * check was structurally incapable of failing — it passed a mutation that
 * deleted a loading.tsx outright. A guard that cannot fail is worse than none,
 * because it reads as coverage.
 */
const CHROME_RE =
  /<Sidebar[\s/>]|PageLoadingWrapper|PageSkeletonShell|PageGuard/;

function hasChrome(file: string): boolean {
  return existsSync(file) && CHROME_RE.test(readFileSync(file, "utf8"));
}

/** Walk `app/`, yielding { route, dir } for every page.tsx. */
function collectPages(
  dir = APP_DIR,
  route = "",
  out: { route: string; dir: string }[] = []
): { route: string; dir: string }[] {
  if (!existsSync(dir)) return out;
  if (existsSync(join(dir, "page.tsx"))) out.push({ route: route || "/", dir });
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name === "api" || e.name.startsWith("_")) continue;
    const isGroup = /^\(.+\)$/.test(e.name);
    collectPages(
      join(dir, e.name),
      isGroup ? route : `${route}/${e.name}`,
      out
    );
  }
  return out;
}

/** True when this route sits inside a logged-out route group. */
function inSidebarlessGroup(dir: string): boolean {
  return SIDEBARLESS_GROUPS.some((g) => dir.includes(`/${g}`));
}

/** Walk up from a route dir looking for a layout that renders the sidebar. */
function ancestorLayoutHasSidebar(dir: string): boolean {
  let cur = dir;
  while (cur.startsWith(APP_DIR)) {
    if (hasChrome(join(cur, "layout.tsx"))) return true;
    if (cur === APP_DIR) break;
    cur = join(cur, "..");
  }
  return false;
}

describe("app routes keep the sidebar during load (MONEY-1256)", () => {
  const pages = collectPages().filter((p) => !inSidebarlessGroup(p.dir));

  it("the walk finds a realistic number of routes", () => {
    // Guards the test itself: a broken walk would vacuously pass everything.
    assert.ok(
      pages.length > 25,
      `only ${pages.length} routes found — the walk is probably broken`
    );
  });

  it("[regression] no route renders a blank page while loading", () => {
    const offenders: string[] = [];
    for (const { route, dir } of pages) {
      if (CHROME_EXEMPT.has(route)) continue;
      // Covered if the route has its own loading state with chrome, OR an
      // ancestor layout that renders the sidebar (layouts persist through a
      // nested loading boundary, so those routes never go blank).
      if (hasChrome(join(dir, "loading.tsx"))) continue;
      if (ancestorLayoutHasSidebar(dir)) continue;
      offenders.push(route);
    }
    assert.deepEqual(
      offenders,
      [],
      `these routes render NO sidebar while loading — add a loading.tsx using PageLoadingWrapper:\n  ${offenders.join("\n  ")}`
    );
  });

  it("every exemption still exists as a route", () => {
    // Stops the exemption list rotting into a place where stale entries hide
    // real gaps.
    const all = new Set(collectPages().map((p) => p.route));
    for (const route of CHROME_EXEMPT) {
      assert.ok(all.has(route), `exempt route ${route} no longer exists`);
    }
  });
});
