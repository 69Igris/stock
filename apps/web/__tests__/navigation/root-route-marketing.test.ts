/**
 * MONEY-1130 — `/` is a PRERENDERED marketing page, not a client-side redirect
 * stub, and the "who is this visitor" decision belongs to the middleware.
 *
 * The regression this pins:
 *
 *   `app/page.tsx` rendered `app/client.tsx` — a "use client" component that
 *   waited on Clerk's `useUser().isLoaded`, then `router.replace("/dashboard")`
 *   or `router.replace("/home")`. Anonymous visitors therefore paid two full
 *   page loads before the hero painted, and Datadog RUM measured the LCP
 *   element on `/` as that stub's "Loading…" paragraph
 *   (BODY>DIV.min-h-screen>DIV.text-center>P.text-muted-foreground).
 *
 * Both halves now resolve server-side:
 *   - signed IN  → `proxy.ts` 307s to /dashboard before any page renders
 *   - signed OUT → the prerendered `app/(marketing)/page.tsx` is served as-is
 *
 * The second describe block guards the OTHER direction, which is the more
 * dangerous one: DB-backed public content pages must stay dynamic. Vercel's
 * build environment has no DATABASE_URL (proven by cea97c33 / MONEY-489,
 * "force-dynamic on DB-backed discover/help pages"), so statically prerendering
 * /docs, /glossary, /blog or /newsletter does not make them fast — it ships
 * EMPTY content pages to production.
 *
 * Source: apps/web/app/(marketing)/page.tsx, apps/web/app/(marketing)/home/page.tsx,
 *         apps/web/proxy.ts, apps/web/proxy-routes.ts, apps/web/app/robots.ts,
 *         apps/web/app/(public)/**\/page.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { PUBLIC_ROUTE_PATTERNS } from "@/proxy-routes";

const ROOT = resolve(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Strip block + line comments so prose about the old stub is never matched. */
function stripComments(src: string): string {
  // LINE comments first, then BLOCK. Order matters: a `//` comment containing
  // `/*` (e.g. a path like `tours/*`) otherwise opens a phantom block that runs
  // to the next `*/`, silently deleting the code under assertion — measured at
  // 11,192 characters in `Sidebar.tsx`. None of the files read here trips it
  // today (verified: 0 characters lost), so this is a latent fix; the ordering
  // itself is tested directly in
  // `__tests__/components/scans-hidden-from-nav.test.ts` ("[meta]").
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Return the body of the first `{ … }` block that starts at `marker`, matching
 * braces so a nested `if` does not truncate the slice (a lazy regex closes on
 * the inner `}` and silently asserts against three lines).
 */
function blockAfter(src: string, marker: RegExp): string | null {
  const at = src.match(marker);
  if (!at || at.index === undefined) return null;
  const open = src.indexOf("{", at.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

const ROOT_PAGE = "app/(marketing)/page.tsx";
const HOME_PAGE = "app/(marketing)/home/page.tsx";
const SHARED_CLIENT = "app/(marketing)/home/client.tsx";

const rootPageSrc = read(ROOT_PAGE);
const rootPageCode = stripComments(rootPageSrc);
const LANDING_METADATA_SRC = stripComments(
  read("app/(marketing)/landing-metadata.ts")
);
const proxySrc = read("proxy.ts");
const proxyCode = stripComments(proxySrc);

describe("MONEY-1130 — `/` renders the marketing landing, not a redirect stub", () => {
  it("[regression] the client-side redirect stub is deleted", () => {
    assert.equal(
      existsSync(join(ROOT, "app/client.tsx")),
      false,
      "app/client.tsx (RootPageClient) waited for clerk.js then router.replace()d — it must stay deleted"
    );
    assert.equal(
      existsSync(join(ROOT, "app/page.tsx")),
      false,
      "app/page.tsx must not come back: `/` is owned by the (marketing) route group, and two files resolving to `/` is a build error"
    );
  });

  it("`/` is served by a server component in the (marketing) group", () => {
    assert.ok(
      existsSync(join(ROOT, ROOT_PAGE)),
      `${ROOT_PAGE} must exist — it is the page for "/"`
    );
    assert.doesNotMatch(
      rootPageCode,
      /["']use client["']/,
      '"/" must stay a server component so it can be prerendered'
    );
  });

  it("[regression] `/` does not redirect from the client (or the server)", () => {
    assert.doesNotMatch(
      rootPageCode,
      /useUser|useAuth|useRouter|router\s*\.\s*(replace|push)/,
      "`/` must not resolve the session or navigate on the client — that is the two-page-load bug"
    );
    assert.doesNotMatch(
      rootPageCode,
      /\bredirect\s*\(/,
      "`/` must not server-redirect either; a redirect still costs a round trip before the hero downloads"
    );
    assert.doesNotMatch(
      rootPageCode,
      /Loading\.\.\.|Loading…|animate-spin/,
      "no loading spinner may be the first paint on `/`"
    );
  });

  it("`/` and `/home` render the SAME component — one source of truth, two URLs", () => {
    const rootImport = rootPageCode.match(
      /import\s+HomeClient\s+from\s+"([^"]+)"/
    );
    const homeImport = stripComments(read(HOME_PAGE)).match(
      /import\s+HomeClient\s+from\s+"([^"]+)"/
    );
    assert.ok(rootImport, `${ROOT_PAGE} must import HomeClient`);
    assert.ok(homeImport, `${HOME_PAGE} must import HomeClient`);

    const rootTarget = resolve(ROOT, "app/(marketing)", rootImport[1]) + ".tsx";
    const homeTarget =
      resolve(ROOT, "app/(marketing)/home", homeImport[1]) + ".tsx";

    assert.equal(
      relative(ROOT, rootTarget),
      SHARED_CLIENT,
      "`/` must render the marketing HomeClient, not a forked copy"
    );
    assert.equal(
      rootTarget,
      homeTarget,
      "`/` and `/home` must resolve to the same client component"
    );
  });
});

describe("MONEY-1130 — `/` reads no per-request state, so it stays prerendered", () => {
  it("declares no searchParams / params prop", () => {
    assert.doesNotMatch(
      rootPageCode,
      /\bsearchParams\b/,
      "reading searchParams opts `/` into dynamic rendering"
    );
    assert.doesNotMatch(rootPageCode, /\bparams\s*[:}]/, "`/` takes no params");
  });

  it("never touches cookies(), headers() or auth()", () => {
    for (const api of ["cookies", "headers", "auth", "currentUser"]) {
      assert.doesNotMatch(
        rootPageCode,
        new RegExp(`\\b${api}\\s*\\(`),
        `${api}() makes \`/\` dynamic and would serve one visitor's shell to another`
      );
    }
    assert.doesNotMatch(
      rootPageCode,
      /isDemoSession|getAuthenticatedUser|prisma\./,
      "`/` must not read the session or the database"
    );
  });

  it("is not opted out of static generation", () => {
    assert.doesNotMatch(
      rootPageCode,
      /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/,
      "`/` must remain in the prerender manifest"
    );
  });

  it("only imports next types and the shared marketing client", () => {
    // A server-side import of anything request-scoped would silently make `/`
    // dynamic even without an explicit directive.
    const imports = [...rootPageCode.matchAll(/from\s+"([^"]+)"/g)].map(
      (m) => m[1]
    );
    assert.deepEqual(
      imports.sort(),
      ["./home/client", "./landing-metadata", "next"],
      "`/` should stay a three-import file; anything else needs re-checking for request-scoped work"
    );
  });
});

describe("MONEY-1130 — the middleware owns the `/` audience decision", () => {
  it("proxy.ts resolves the session on the root path", () => {
    assert.match(
      proxyCode,
      /pathname\s*===\s*"\/"/,
      "proxy.ts must special-case the root path"
    );
    assert.match(
      proxyCode,
      /pathname\s*===\s*"\/"[\s\S]{0,400}?await\s+auth\s*\(\s*\)/,
      "the root branch must call auth() — it is the only layer that knows the session without making `/` dynamic"
    );
  });

  it("signed-in visitors are 307'd to /dashboard from the edge", () => {
    assert.match(
      proxyCode,
      /pathname\s*===\s*"\/"[\s\S]{0,600}?NextResponse\.redirect\(\s*new URL\("\/dashboard"/,
      "a signed-in request for `/` must be redirected before any page renders"
    );
  });

  it("[regression] signed-out visitors are NOT redirected to /home", () => {
    // robots.ts DISALLOWS /home and ALLOWS "/". Redirecting `/` → /home points
    // crawlers at a blocked URL, so the homepage cannot be indexed at all.
    const rootBranch = blockAfter(proxyCode, /if\s*\(\s*pathname\s*===\s*"\/"/);
    assert.ok(rootBranch, "could not isolate the root-path branch in proxy.ts");
    assert.doesNotMatch(
      rootBranch,
      /"\/home"/,
      "the root branch must fall through to the prerendered landing, not redirect to /home"
    );
    assert.match(
      rootBranch,
      /NextResponse\.next\(\)/,
      "signed-out `/` must be served, not redirected"
    );
  });

  it("`/` is public in the real proxy route list", () => {
    assert.ok(
      PUBLIC_ROUTE_PATTERNS.some((p) => new RegExp(`^${p}$`).test("/")),
      "`/` must stay in PUBLIC_ROUTE_PATTERNS or the landing page is auth-gated"
    );
  });
});

describe("MONEY-1130 — `/` is the canonical marketing URL", () => {
  it("robots.ts allows `/` and disallows /home (why `/` must not redirect)", () => {
    const robots = stripComments(read("app/robots.ts"));
    const publicPaths = robots.match(/publicPaths\s*=\s*\[([\s\S]*?)\]/);
    const privatePaths = robots.match(/privatePaths\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(publicPaths && privatePaths, "could not read robots.ts lists");
    assert.match(publicPaths[1], /"\/"/, "`/` must stay crawlable");
    assert.match(
      privatePaths[1],
      /"\/home"/,
      "/home is intentionally blocked — that is why the landing must be served at `/`"
    );
  });

  it("both `/` and `/home` use the one shared metadata object", () => {
    for (const [rel, src] of [
      [ROOT_PAGE, rootPageCode],
      [HOME_PAGE, stripComments(read(HOME_PAGE))],
    ] as const) {
      assert.match(
        src,
        /import\s*\{\s*LANDING_METADATA\s*\}\s*from\s+"\.\.?\/?[^"]*landing-metadata"/,
        `${rel} must import the shared landing metadata, not fork its own copy`
      );
      assert.match(
        src,
        /export\s+const\s+metadata\s*:\s*Metadata\s*=\s*LANDING_METADATA\s*;/,
        `${rel} must export the shared object verbatim — a spread would let the two URLs drift`
      );
    }
  });

  it("the shared metadata points canonical + og:url at `/`", () => {
    assert.match(
      LANDING_METADATA_SRC,
      /canonical:\s*CANONICAL_URL/,
      "the landing must declare `/` as canonical"
    );
    assert.match(
      LANDING_METADATA_SRC,
      /CANONICAL_URL\s*=\s*"https:\/\/usemoney\.ai\/"/,
      "the canonical target must be `/`, not /home"
    );
    assert.match(
      LANDING_METADATA_SRC,
      /url:\s*CANONICAL_URL/,
      "og:url must match the canonical"
    );
  });

  it("[regression] the shared openGraph is COMPLETE, because Next merges it shallowly", () => {
    // A page-level `openGraph` replaces the root layout's whole object. When
    // /home declared only { title, description }, the built HTML lost og:image,
    // og:url, og:site_name, og:locale and og:type — verified in
    // .next/server/app/home.html. `/` is the URL people share; it cannot ship
    // a social card with no image.
    const og = blockAfter(LANDING_METADATA_SRC, /openGraph\s*:/);
    assert.ok(og, "could not read the openGraph block");
    for (const field of ["type", "locale", "siteName", "url", "images"]) {
      assert.match(
        og,
        new RegExp(`\\b${field}\\s*:`),
        `openGraph.${field} must be restated here — it is NOT inherited from app/layout.tsx`
      );
    }
    assert.match(og, /og-website\.png/, "the OG image must survive");

    const tw = blockAfter(LANDING_METADATA_SRC, /twitter\s*:/);
    assert.ok(tw, "could not read the twitter block");
    for (const field of ["card", "site", "creator", "images"]) {
      assert.match(
        tw,
        new RegExp(`\\b${field}\\s*:`),
        `twitter.${field} must be restated here — it is NOT inherited from app/layout.tsx`
      );
    }
  });
});

/**
 * The inverse guard. Prerendering is only a win when the page has data at BUILD
 * time — and this build does not: Vercel's build environment has no
 * DATABASE_URL (cea97c33). A statically generated /docs or /glossary would be
 * shipped empty and stay empty until the next deploy.
 */
describe("MONEY-1130 — DB-backed public content pages must stay dynamic", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (entry === "page.tsx") out.push(relative(ROOT, full));
    }
    return out;
  }

  const publicPages = walk(join(ROOT, "app/(public)"));

  it("finds the public content routes it is meant to guard", () => {
    for (const expected of [
      "app/(public)/docs/page.tsx",
      "app/(public)/glossary/page.tsx",
      "app/(public)/blog/page.tsx",
      "app/(public)/newsletter/page.tsx",
    ]) {
      assert.ok(
        publicPages.includes(expected),
        `${expected} not found — the guard below would silently cover nothing`
      );
    }
  });

  it("[regression] none of them is force-static or build-time generated", () => {
    for (const rel of publicPages) {
      const code = stripComments(read(rel));
      const touchesDb =
        /prisma\./.test(code) || /Action\s*\(/.test(code) === true;
      if (!touchesDb) continue;

      assert.doesNotMatch(
        code,
        /export\s+const\s+dynamic\s*=\s*["']force-static["']/,
        `${rel} queries the database at render time; force-static would prerender it EMPTY (Vercel build has no DATABASE_URL — cea97c33)`
      );
      assert.doesNotMatch(
        code,
        /export\s+(async\s+)?function\s+generateStaticParams/,
        `${rel} queries the database at render time; generateStaticParams would prerender it EMPTY (Vercel build has no DATABASE_URL — cea97c33)`
      );
    }
  });

  it("the already-static legal pages stay free of DB + per-request reads", () => {
    // These ARE prerendered today. Keep them that way.
    for (const rel of [
      "app/(public)/privacy/page.tsx",
      "app/(public)/terms/page.tsx",
      "app/(public)/legal/page.tsx",
      "app/(public)/data-usage/page.tsx",
      "app/(public)/risk-disclosure/page.tsx",
      "app/(public)/subprocessors/page.tsx",
    ]) {
      const code = stripComments(read(rel));
      assert.doesNotMatch(
        code,
        /prisma\.|\bsearchParams\b|\bcookies\s*\(|\bheaders\s*\(|\bauth\s*\(/,
        `${rel} is prerendered — adding DB or per-request reads silently drops it out of the prerender manifest`
      );
    }
  });
});
