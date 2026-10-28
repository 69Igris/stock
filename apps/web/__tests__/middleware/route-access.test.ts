// P0 Route Access Tests
//
// De-shadowed (MONEY-620): previously this file inlined hand-maintained copies
// of the proxy public routes, Sidebar PUBLIC_SHELL_ROUTES and TermsGate
// EXCLUDED_PATHS and asserted the copies agreed. It now imports the REAL arrays:
//   - PUBLIC_ROUTE_PATTERNS        from @/proxy-routes        (proxy.ts)
//   - PUBLIC_SHELL_ROUTES          from @/lib/route-lists     (Sidebar.tsx)
//   - TERMS_GATE_EXCLUDED_PATHS    from @/lib/route-lists     (TermsGate.tsx)
// so a divergence in production fails the test instead of a stale copy passing.
//
// WHY THIS EXISTS: Adding /data-usage without adding it to proxy's public list
// silently blocked unauthenticated access. This test catches that class of bug.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLIC_ROUTE_PATTERNS } from "@/proxy-routes";
import {
  PUBLIC_SHELL_ROUTES,
  TERMS_GATE_EXCLUDED_PATHS,
} from "@/lib/route-lists";

// The proxy list uses Clerk glob patterns (e.g. "/sign-in(.*)", "/data-usage").
// Match a concrete pathname the way the middleware does (anchored regex; the
// only regex token in these strings is the intended "(.*)").
function proxyAllowsPublic(pathname: string): boolean {
  return PUBLIC_ROUTE_PATTERNS.some((p) => new RegExp(`^${p}$`).test(pathname));
}

// Sidebar/TermsGate match by exact-or-prefix (see isPublicShellRoute /
// isExcludedPath in the source).
function listMatches(list: string[], pathname: string): boolean {
  return list.some((r) => pathname === r || pathname.startsWith(r + "/"));
}

// Legal pages that must be reachable without auth (terms-acceptance modal).
const LEGAL_PAGES = [
  "/terms",
  "/privacy",
  "/data-usage",
  "/legal",
  "/subprocessors",
];

// App pages that MUST require auth.
const AUTH_REQUIRED_PAGES = [
  "/dashboard",
  "/holdings",
  "/positions",
  "/tradebook",
  "/brokers",
  "/settings",
  "/watchlist",
  "/paper-trading",
  "/fire",
  "/roast",
  "/risk",
  "/tax",
];

describe("Route access - public pages in middleware", () => {
  it("all legal pages are public in proxy (isPublicRoute)", () => {
    for (const page of LEGAL_PAGES) {
      assert.ok(
        proxyAllowsPublic(page),
        `${page} is NOT matched by proxy public routes - unauthenticated users will be blocked!`
      );
    }
  });

  it("all legal pages are in Sidebar PUBLIC_SHELL_ROUTES (no sidebar/ticker)", () => {
    for (const page of LEGAL_PAGES) {
      assert.ok(
        listMatches(PUBLIC_SHELL_ROUTES, page),
        `${page} is NOT in Sidebar PUBLIC_SHELL_ROUTES - sidebar and ticker will show on a public page!`
      );
    }
  });

  it("all legal pages are in TermsGate excluded paths (no terms modal)", () => {
    for (const page of LEGAL_PAGES) {
      assert.ok(
        listMatches(TERMS_GATE_EXCLUDED_PATHS, page),
        `${page} is NOT in TermsGate EXCLUDED_PATHS - terms modal will block reading legal docs!`
      );
    }
  });
});

describe("Route access - auth-required pages NOT in public routes", () => {
  it("dashboard/app pages are NOT public in proxy", () => {
    for (const page of AUTH_REQUIRED_PAGES) {
      assert.ok(
        !proxyAllowsPublic(page),
        `${page} is matched by proxy public routes - auth bypass!`
      );
    }
  });

  it("dashboard/app pages are NOT in TermsGate excluded paths", () => {
    for (const page of AUTH_REQUIRED_PAGES) {
      assert.ok(
        !listMatches(TERMS_GATE_EXCLUDED_PATHS, page),
        `${page} is in TermsGate EXCLUDED_PATHS - terms modal won't show on an app page!`
      );
    }
  });

  it("dashboard/app pages are NOT in Sidebar PUBLIC_SHELL_ROUTES", () => {
    for (const page of AUTH_REQUIRED_PAGES) {
      assert.ok(
        !listMatches(PUBLIC_SHELL_ROUTES, page),
        `${page} is in Sidebar PUBLIC_SHELL_ROUTES - app shell will be hidden on an authenticated page!`
      );
    }
  });
});

describe("Route access - consistency across all three lists", () => {
  it("every Sidebar public route is also public in proxy", () => {
    for (const route of PUBLIC_SHELL_ROUTES) {
      // "/" is handled specially in the proxy (logged-in redirect), but the
      // matcher still treats it as public.
      assert.ok(
        proxyAllowsPublic(route),
        `${route} is in Sidebar PUBLIC_SHELL_ROUTES but NOT public in proxy - sidebar hides but auth blocks!`
      );
    }
  });

  it("/data-usage is public in ALL three lists (the bug this test was created to catch)", () => {
    assert.ok(proxyAllowsPublic("/data-usage"), "proxy");
    assert.ok(listMatches(PUBLIC_SHELL_ROUTES, "/data-usage"), "sidebar");
    assert.ok(
      listMatches(TERMS_GATE_EXCLUDED_PATHS, "/data-usage"),
      "terms gate"
    );
  });
});

// The middleware matcher (proxy.ts `config.matcher`) is a layer ABOVE
// isPublicRoute: it decides whether the middleware runs on a request AT ALL.
// Next.js statically analyzes that matcher, so it MUST be an inline literal in
// proxy.ts (an imported identifier fails the build) — we therefore read the
// literal straight from source rather than import it. Zero drift: this tests
// the REAL matcher, and also fails if it is ever turned back into a non-literal.
function proxyMatcherPatterns(): string[] {
  const src = readFileSync(new URL("../../proxy.ts", import.meta.url), "utf8");
  const block = src.match(/matcher:\s*\[([\s\S]*?)\n\s*\]/);
  assert.ok(block, "could not find the `matcher: [ ... ]` literal in proxy.ts");
  // Extract each "..." pattern and unescape the JS-literal backslashes (\\ -> \).
  const patterns = [...block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1].replace(/\\\\/g, "\\")
  );
  assert.ok(
    patterns.length >= 2,
    "proxy.ts matcher must be an inline literal with >=2 patterns (Next.js rejects imported identifiers)"
  );
  return patterns;
}

const PROXY_MATCHER = proxyMatcherPatterns();

// A concrete path runs through the middleware iff it matches ANY matcher
// pattern (anchored the same way Next compiles them).
function middlewareRunsOn(pathname: string): boolean {
  return PROXY_MATCHER.some((p) => new RegExp(`^${p}$`).test(pathname));
}

describe("Middleware matcher - crawler metadata files bypass the auth gate", () => {
  // WHY THIS EXISTS: /sitemap.xml, /robots.txt and /llms.txt all 307-redirected
  // to /sign-in in production because the matcher's static-extension skip-list
  // omitted `xml` and `txt`, so the middleware ran on them and gated them as
  // non-public — crawlers got an HTML login page instead of the file.
  const CRAWLER_FILES = ["/sitemap.xml", "/robots.txt", "/llms.txt"];

  it("sitemap/robots/llms are NOT processed by the middleware (no /sign-in redirect)", () => {
    for (const f of CRAWLER_FILES) {
      assert.ok(
        !middlewareRunsOn(f),
        `${f} is matched by config.matcher - the middleware will 307 it to /sign-in and crawlers can't read it!`
      );
    }
  });

  it("app pages ARE still processed by the middleware (auth intact)", () => {
    for (const page of ["/dashboard", "/holdings", "/settings"]) {
      assert.ok(
        middlewareRunsOn(page),
        `${page} must run through the middleware`
      );
    }
  });

  it("API routes with .xml/.txt still run through the middleware (no auth hole)", () => {
    // The `/(api|trpc)(.*)` pattern catches every /api path regardless of
    // extension, so skipping .xml/.txt statics can't be abused to reach a
    // gated API endpoint without auth.
    assert.ok(middlewareRunsOn("/api/export/data.xml"), "/api/export/data.xml");
    assert.ok(
      middlewareRunsOn("/api/report/notes.txt"),
      "/api/report/notes.txt"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MONEY-1139 — demo-visible product pages must be in APP_ROUTE_PATTERNS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Absence from `APP_ROUTE_PATTERNS` is not "unprotected" — it is the OPPOSITE.
 * `proxy.ts` treats an app-pattern route as "Clerk session OR a valid signed
 * demo cookie", and everything else falls to a catch-all that requires a real
 * Clerk session with NO demo branch.
 *
 * So a demo-visible product page that is missing from the list does not leak;
 * it BOUNCES a demo visitor to /sign-in mid-session. `/etf/[symbol]` shipped
 * that way while its siblings `/stock` and `/mf` were always listed, which is
 * why it read as a one-off rather than a pattern.
 *
 * The second case is the general guard: it walks `app/` and fails on any new
 * top-level page route that is in neither list, with an explicit allowlist for
 * the ones where auth-only is CORRECT. That keeps the next omission loud.
 */
describe("MONEY-1139 — product pages are reachable in demo", () => {
  const appPatternsSrc = readFileSync(
    new URL("../../proxy-routes.ts", import.meta.url),
    "utf8"
  );

  it("[regression] /etf is an app route, like /stock and /mf", () => {
    for (const route of ["/stock", "/mf", "/etf"]) {
      assert.match(
        appPatternsSrc,
        new RegExp(`"\\${route}\\(\\.\\*\\)"`),
        `${route} must be in APP_ROUTE_PATTERNS — otherwise the catch-all ` +
          `requires a Clerk session and demo visitors are bounced to /sign-in`
      );
    }
  });

  it("[completeness] every top-level page route is classified", () => {
    // Routes where "requires a real session, no demo path" is the INTENDED
    // behaviour. Each is post-auth or internal, not a browsable product page.
    const AUTH_ONLY_BY_DESIGN = new Set([
      "launch", // post-login redirect router
      "welcome", // post-signup onboarding
      "invite", // referral acceptance, needs an identity
      "debug-posthog", // internal diagnostics
    ]);

    const appDir = fileURLToPath(new URL("../../app", import.meta.url));

    const unclassified: string[] = [];

    /**
     * Route groups are URL-TRANSPARENT: `app/(public)/unsubscribe/page.tsx`
     * serves `/unsubscribe`, not `/(public)/unsubscribe`. So we must not treat
     * the group as a path segment — but we must still walk INTO it.
     *
     * The first version of this guard did `if (name.startsWith("(")) continue`,
     * skipping the group and everything under it. That is the right call for the
     * segment and the wrong one for the contents, and it blinded the check
     * exactly where public pages live: `(public)/unsubscribe` was missing from
     * PUBLIC_ROUTE_PATTERNS and this case passed anyway. A completeness guard
     * with a hole over one whole subtree reads as coverage it does not have.
     */
    function walk(dir: string, insideGroup: boolean): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (name === "api") continue;
        if (name.startsWith("(") && name.endsWith(")")) {
          walk(join(dir, name), true); // transparent segment — recurse, don't name
          continue;
        }
        // Only TOP-LEVEL routes are classified; the pattern lists use `(.*)`
        // suffixes, so `/settings/billing` is covered by `/settings(.*)`.
        if (insideGroup === false && dir !== appDir) continue;
        if (name.startsWith("[") || name.startsWith("_")) continue;
        if (AUTH_ONLY_BY_DESIGN.has(name)) continue;

        const child = join(dir, name);
        const rendersPage =
          existsSync(join(child, "page.tsx")) ||
          readdirSync(child, { withFileTypes: true }).some(
            (c) =>
              c.isDirectory() && existsSync(join(child, c.name, "page.tsx"))
          );
        if (!rendersPage) continue;

        const listed =
          appPatternsSrc.includes(`"/${name}(`) ||
          appPatternsSrc.includes(`"/${name}"`);
        if (!listed) unclassified.push(`/${name}`);
      }
    }
    walk(appDir, false);

    assert.deepEqual(
      unclassified,
      [],
      "these page routes are in neither pattern list, so the catch-all will " +
        "require a Clerk session and bounce demo visitors. Add them to " +
        "APP_ROUTE_PATTERNS (browsable) or to AUTH_ONLY_BY_DESIGN above " +
        "(post-auth/internal), but do not leave them unclassified"
    );
  });
});
