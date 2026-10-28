/**
 * MONEY-1132 — the sidebar's prefetch budget, and the auth gate it must not buy
 * itself with.
 *
 * WHAT WENT WRONG: every `<Link>` in `sidenavConfig` prefetches on viewport
 * entry, and on a desktop screen the whole sidenav IS the viewport. All 19
 * destinations are `force-dynamic` and ship a `loading.tsx`, so Next's default
 * "partial prefetch to the nearest loading boundary" is a real server round trip
 * for each one. Every one of those requests is matched by the proxy matcher
 * (the compiled regexp in `.next/server/functions-config-manifest.json` ends in
 * `(\.json|\.rsc|\.segments\/.+\.segment\.rsc)?`, so RSC payload URLs are in
 * scope) and the proxy runs on the Node.js runtime out of a ~462 KB
 * mostly-Clerk bundle, calling `await auth()` each time. Prod RUM measured
 * 550–1300 ms TTFB per prefetch and network-settle on /dashboard past 16 s.
 *
 * The fix is a traffic-derived allowlist, and this file pins BOTH halves of it:
 *
 *   1. The eager set is exactly the eight routes chosen from 90 days of PostHog
 *      pageviews — no more (budget creep), no fewer (a silent UX regression on a
 *      route people actually use).
 *   2. The complement is exactly the eleven that were meant to lose eager
 *      prefetch. Adding a nav entry without revisiting the decision fails here
 *      rather than quietly joining the burst.
 *
 * And the non-negotiable half: dropping a route's prefetch must not drop its
 * AUTH. Every destination — eager or not — stays inside APP_ROUTE_PATTERNS, and
 * the proxy matcher keeps no prefetch-shaped hole. Skipping the middleware for
 * `Next-Router-Prefetch` requests would have been the fastest fix available and
 * is deliberately not taken: it would serve the RSC payload of every protected
 * page to anonymous clients, relying on 93 pages' individual guards. A slow
 * prefetch is cheaper than an auth bypass.
 *
 * Source: apps/web/components/Sidebar.tsx, apps/web/proxy.ts,
 *         apps/web/proxy-routes.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { APP_ROUTE_PATTERNS, PUBLIC_ROUTE_PATTERNS } from "@/proxy-routes";

const ROOT = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/**
 * Strip line + block comments. The sidebar deliberately keeps a commented-out
 * `/discover/scans` entry (MONEY-1138) and a commented-out Learning subtree, and
 * the prefetch rationale comment lists every href in a table — none of which are
 * live nav entries. Without this the href scan below would pick all of them up.
 *
 * ORDER MATTERS, and the obvious order is wrong. Doing block comments first (as
 * the neighbouring nav tests do) makes `Sidebar.tsx`'s
 * `// … (apps/web/lib/walkthrough/tours/*) target nav rows by` line open a
 * PHANTOM block comment at `/*`, which then runs to the next real `*​/` — the
 * `{/* Brand header *​/}` JSX comment 438 lines later — silently deleting
 * NavLink and CollapsibleNavItem from the text under assertion. That is a
 * passing-because-empty test, so line comments are removed first: the offending
 * `/*` disappears with the line that contains it.
 */
function stripComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const sidebarSrc = read("components/Sidebar.tsx");
const sidebarCode = stripComments(sidebarSrc);
const proxyCode = stripComments(read("proxy.ts"));

/** Body of the `NAV_PREFETCH_ALLOWLIST` Set literal, as declared in source. */
function readAllowlist(): string[] {
  const m = sidebarCode.match(
    /NAV_PREFETCH_ALLOWLIST[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/
  );
  assert.ok(m, "could not locate the NAV_PREFETCH_ALLOWLIST literal");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Every `href:` in the LIVE sidenavConfig (comments already stripped). */
function readNavHrefs(): string[] {
  const start = sidebarCode.indexOf("export const sidenavConfig");
  const end = sidebarCode.indexOf("export const bottomNavItems");
  assert.ok(
    start !== -1 && end > start,
    "could not isolate sidenavConfig in the sidebar source"
  );
  const config = sidebarCode.slice(start, end);
  return [...config.matchAll(/href:\s*"([^"]+)"/g)].map((x) => x[1]);
}

/** Match a concrete pathname the way Clerk's createRouteMatcher does. */
function matches(patterns: string[], pathname: string): boolean {
  return patterns.some((p) => new RegExp(`^${p}$`).test(pathname));
}

// The decision, restated independently of the source so the source cannot
// silently redefine it. 90-day PostHog pageviews are in the comment beside each.
const EAGER = [
  "/dashboard", // 391
  "/settings", // 94
  "/brokers", // 72
  "/stocksage", // 52
  "/holdings", // 37
  "/tradebook", // 34
  "/fire", // 31
  "/discover/screener", // 28
];

const ON_INTENT_ONLY = [
  "/analysis", // 8
  "/discover/news", // 8
  "/watchlist", // 7
  "/discover/markets", // 7
  "/documents", // 6
  "/calculators", // 3
  "/roast", // 2
  "/risk", // 2
  "/strategies", // 2
  "/notifications", // 1
  "/tax", // 0
];

describe("MONEY-1132 — the sidebar prefetch allowlist is the one that was intended", () => {
  it("contains exactly the eight high-traffic destinations", () => {
    assert.deepEqual(
      readAllowlist().slice().sort(),
      EAGER.slice().sort(),
      "the eager prefetch set drifted — re-derive it from PostHog pageviews before changing it"
    );
  });

  it("[regression] every other nav destination is left off it", () => {
    const navHrefs = readNavHrefs();
    const allow = new Set(readAllowlist());
    const notEager = navHrefs.filter((h) => !allow.has(h));
    assert.deepEqual(
      notEager.slice().sort(),
      ON_INTENT_ONLY.slice().sort(),
      "a nav entry appeared/disappeared without revisiting the prefetch budget"
    );
  });

  it("the allowlist is a subset of the live nav — no dead entries", () => {
    const navHrefs = new Set(readNavHrefs());
    for (const href of readAllowlist()) {
      assert.ok(
        navHrefs.has(href),
        `${href} is allowlisted for prefetch but is not a live nav destination`
      );
    }
  });

  it("covers the whole sidenav, so nothing is unaccounted for", () => {
    // 19 live destinations = 8 eager + 11 on-intent. If this drifts, one of the
    // two lists above is stale and the split is no longer a real decision.
    assert.equal(readNavHrefs().length, EAGER.length + ON_INTENT_ONLY.length);
  });
});

describe("MONEY-1132 — the allowlist is actually wired, not dead config", () => {
  it("NavLink derives its prefetch prop from the allowlist", () => {
    assert.match(
      sidebarCode,
      /const eager = NAV_PREFETCH_ALLOWLIST\.has\(item\.href\)/,
      "NavLink must consult the allowlist"
    );
    assert.match(
      sidebarCode,
      /prefetch=\{eager \? undefined : false\}/,
      "NavLink must pass prefetch={false} for non-allowlisted destinations"
    );
  });

  it("the collapsible parent and its sub-items are wired the same way", () => {
    assert.match(
      sidebarCode,
      /prefetch=\{eagerParent \? undefined : false\}/,
      "a collapsible parent link must honour the same budget"
    );
    const childWirings = sidebarCode.match(
      /prefetch=\{\s*NAV_PREFETCH_ALLOWLIST\.has\(child\.href\) \? undefined : false\s*\}/g
    );
    assert.equal(
      childWirings?.length,
      2,
      "both sub-item link sites (collapsed tooltip + expanded submenu) must be wired"
    );
  });

  it("[regression] the long tail still prefetches on hover/focus", () => {
    // prefetch={false} in Next 16 kills viewport AND hover prefetch
    // (`prefetchEnabled = prefetchProp !== false` gates both the observer and
    // the onMouseEnter/onTouchStart handlers). Losing hover would turn a perf
    // win into a UX regression on every click of the long tail.
    assert.match(
      sidebarCode,
      /function useNavPrefetcher\(\)/,
      "the intent-prefetch helper must exist"
    );
    assert.match(
      sidebarCode,
      /router\.prefetch\(href\)/,
      "useNavPrefetcher must actually call router.prefetch"
    );
    assert.match(
      sidebarCode,
      /if \(NAV_PREFETCH_ALLOWLIST\.has\(href\)\) return;/,
      "allowlisted routes are already prefetched by Next — intent prefetch must skip them"
    );
    const intentHandlers = sidebarCode.match(
      /onMouseEnter=\{\(\) => onIntent\(/g
    );
    const focusHandlers = sidebarCode.match(/onFocus=\{\(\) => onIntent\(/g);
    assert.equal(
      intentHandlers?.length,
      4,
      "all four nav link sites must prefetch on hover"
    );
    assert.equal(
      focusHandlers?.length,
      4,
      "keyboard users get the same treatment — onFocus must match onMouseEnter"
    );
  });

  it("the brand link keeps Next's default prefetch", () => {
    // /dashboard is the top destination and the logo is the most-clicked route
    // back to it. It must not have been swept up by a blanket disable.
    assert.doesNotMatch(
      sidebarCode,
      /href="\/dashboard"[\s\S]{0,200}?prefetch=\{false\}/,
      "the brand/logo link to /dashboard must keep prefetching"
    );
    assert.ok(
      readAllowlist().includes("/dashboard"),
      "/dashboard must stay eager"
    );
  });
});

describe("MONEY-1132 — dropping prefetch must not drop AUTH", () => {
  it("every sidenav destination is still gated by APP_ROUTE_PATTERNS", () => {
    for (const href of readNavHrefs()) {
      assert.ok(
        matches(APP_ROUTE_PATTERNS, href),
        `${href} lost its app-route match — the proxy would fall through to the catch-all`
      );
    }
  });

  it("[regression] no sidenav destination leaked into the PUBLIC list", () => {
    for (const href of readNavHrefs()) {
      assert.equal(
        matches(PUBLIC_ROUTE_PATTERNS, href),
        false,
        `${href} became a public route — that is an auth bypass, not a prefetch optimisation`
      );
    }
  });

  it("[regression] the proxy matcher has no prefetch-shaped hole", () => {
    // Excluding `Next-Router-Prefetch` / RSC requests from the matcher would
    // have removed these requests from the middleware entirely — and with them
    // the auth gate, serving protected RSC payloads to anonymous clients. This
    // is the option that was considered and rejected.
    //
    // Reading the literal is the fiddly part. The obvious
    // `/matcher:\s*\[([\s\S]*?)\]/` is WRONG: the lazy `]` stops at the first
    // one in the source, which belongs to the `[^?]` character class inside
    // the pattern string — capturing 20 characters (`"\n    "/((?!_next|[^?"`)
    // instead of the whole array. Every `includes()` below then searched a
    // fragment that cannot contain any of these tokens, so the loop passed
    // unconditionally while `assert.ok(matcher)` reported everything was fine.
    // This is the file's own "non-negotiable half" and it was guarding nothing.
    //
    // Anchoring on the closing `],` at the start of a line is what makes the
    // capture the real array; the length floor below makes a future
    // re-truncation fail loudly instead of silently.
    const matcher = proxyCode.match(/matcher:\s*\[([\s\S]*?)\n\s*\],/);
    assert.ok(matcher, "could not read the proxy matcher literal");
    assert.ok(
      matcher[1].length > 40,
      `the matcher capture is ${matcher[1].length} chars — too short to be the ` +
        `real array, so the checks below would pass vacuously: ${JSON.stringify(matcher[1])}`
    );
    assert.match(
      matcher[1],
      /_next/,
      "the captured matcher should contain the _next exclusion — if it does " +
        "not, the regex is grabbing the wrong span again"
    );
    for (const forbidden of [
      "next-router-prefetch",
      "Next-Router-Prefetch",
      "missing:",
      "has:",
      "RSC",
    ]) {
      assert.ok(
        !matcher[1].includes(forbidden),
        `the matcher must not exempt requests via "${forbidden}" — prefetches are auth-gated like any other request`
      );
    }
  });

  it("[regression] the proxy still resolves the session for protected routes", () => {
    // A cheap way to "fix" prefetch latency is to stop calling auth(). The gate
    // is the whole point of the file.
    assert.match(
      proxyCode,
      /const \{ userId \} = await auth\(\);/,
      "proxy.ts must still resolve the Clerk session"
    );
    assert.match(
      proxyCode,
      /isAppRoute\(req\)[\s\S]{0,600}?NextResponse\.redirect\(signInUrl\)/,
      "unauthenticated app-route requests must still be redirected to /sign-in"
    );
    assert.match(
      proxyCode,
      /if \(!userId\)[\s\S]{0,300}?NextResponse\.redirect\(signInUrl\)/,
      "the catch-all must still fail closed"
    );
  });

  it("[regression] MONEY-1130's root-path branch is untouched", () => {
    // The root branch was rewritten one commit ago; a prefetch change has no
    // business near it. (root-route-marketing.test.ts owns the full contract.)
    assert.match(proxyCode, /if \(pathname === "\/"\) \{/);
    assert.match(
      proxyCode,
      /pathname === "\/"[\s\S]{0,400}?await auth\(\)/,
      "the root branch must still resolve the session"
    );
    assert.match(
      proxyCode,
      /pathname === "\/"[\s\S]{0,600}?NextResponse\.redirect\(\s*new URL\("\/dashboard"/,
      "signed-in visitors to / must still be 307'd to /dashboard"
    );
  });
});
