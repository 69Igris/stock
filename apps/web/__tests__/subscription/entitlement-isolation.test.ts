/**
 * MONEY-1126 — the entitlement path and the cosmetic plan cache must not meet.
 *
 * `lib/subscription/plan-cache.ts` persists a plan id to localStorage and says
 * so in its own header: the stored value "can be stale, or belong to whoever was
 * previously signed in on this browser", and it is "cosmetic only — every
 * entitlement / gating decision reads the server directly". If `PageGuard` or
 * `useSubscriptionAccess` ever read it, a previous PREMIUM user's leftover
 * `um_plan_v1` would unlock ~30 gated pages for the next FREE user on that
 * browser — and localStorage is user-writable, so it would also be trivially
 * self-granted.
 *
 * This ticket routed MORE callers through that cache (Fix 2), which is exactly
 * when the boundary needs a test. These are source-level assertions because the
 * boundary is an IMPORT boundary — the thing to prevent is the wire existing at
 * all, which is a property of the file, not of a render. Same rationale as
 * `__tests__/hooks/hooks-shape.test.ts`.
 *
 * Sources: apps/web/components/PageGuard.tsx, hooks/useSubscriptionAccess.ts,
 *          lib/subscription/{access,access-cache,plan-cache}.ts,
 *          components/Sidebar.tsx, components/walkthrough/WalkthroughProvider.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(WEB, rel), "utf8");
}

/**
 * Source with comments removed. These assertions are about WIRES, not prose —
 * a comment saying "this used to call getSubscriptionAction" must not read as
 * a call. The `[^:"'`]` guard keeps `https://` from being eaten.
 *
 * LINE comments are stripped BEFORE block comments, and the order is
 * load-bearing. Reversed (as this was), a `//` comment containing `/*` opens a
 * phantom block that runs to the next `*` + `/` far below: measured, that
 * deleted 11,192 characters of `Sidebar.tsx` — one of the four files this
 * suite reads — silently removing whole components from the text being
 * searched. For an ENTITLEMENT test that is the worst possible direction to
 * fail in: every "this file must not read the persisted plan" assertion looks
 * satisfied because the code was eaten, not because the wire is absent.
 */
function code(rel: string): string {
  return read(rel)
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every identifier that would mean "this file reads the persisted plan". */
const PLAN_CACHE_TELLS = [
  /subscription\/plan-cache/,
  /getCachedPlan/,
  /fetchPlanCached/,
  /subscribeCachedPlan/,
  /setCachedPlan/,
  /um_plan_v1/,
];

/** Files on the entitlement path — none of them may consult the plan cache. */
const ENTITLEMENT_FILES = [
  "components/PageGuard.tsx",
  "hooks/useSubscriptionAccess.ts",
  "lib/subscription/access.ts",
  "lib/subscription/access-cache.ts",
  "app/api/subscription/access/route.ts",
];

describe("entitlement isolation: gating never reads the cosmetic plan cache", () => {
  for (const file of ENTITLEMENT_FILES) {
    it(`[security] ${file} does not touch plan-cache`, () => {
      const src = code(file);
      for (const tell of PLAN_CACHE_TELLS) {
        assert.doesNotMatch(
          src,
          tell,
          `${file} must not read the localStorage-backed plan cache (${tell})`
        );
      }
    });
  }

  it("[security] PageGuard and useSubscriptionAccess read no browser storage at all", () => {
    for (const file of [
      "components/PageGuard.tsx",
      "hooks/useSubscriptionAccess.ts",
    ]) {
      const src = code(file);
      assert.doesNotMatch(
        src,
        /localStorage/,
        `${file} must not use localStorage`
      );
      assert.doesNotMatch(
        src,
        /sessionStorage/,
        `${file} must not use sessionStorage`
      );
    }
  });

  it("[security] PageGuard's plan comes from useSubscriptionAccess, nowhere else", () => {
    const src = code("components/PageGuard.tsx");
    assert.match(
      src,
      /useSubscriptionAccess\s*\}?\s*from\s*"@\/hooks\/useSubscriptionAccess"/
    );
    assert.match(src, /const\s*\{\s*planId[\s\S]{0,80}useSubscriptionAccess\(/);
  });

  it("[security] useSubscriptionAccess asks the server on every mount", () => {
    const src = code("hooks/useSubscriptionAccess.ts");
    assert.match(src, /fetch\(\s*"\/api\/subscription\/access"\s*\)/);
  });

  it("[security] the access route resolves through the server-authoritative module", () => {
    const src = code("app/api/subscription/access/route.ts");
    assert.match(
      src,
      /import\s*\{\s*getSubscriptionAccess\s*\}\s*from\s*"@\/lib\/subscription\/access"/
    );
    // Per-user body: never cacheable by a shared/browser cache.
    assert.match(src, /Cache-Control[\s\S]{0,40}no-store/);
    assert.match(src, /dynamic\s*=\s*"force-dynamic"/);
  });

  it("[security] the server-side access cache is keyed by the internal user id", () => {
    const src = code("lib/subscription/access.ts");
    // resolveUserId(clerkUserId) -> userId, and the cache is read/written under
    // that id, not the Clerk id and not a global key.
    assert.match(
      src,
      /const\s+userId\s*=\s*await\s+resolveUserId\(clerkUserId\)/
    );
    assert.match(
      src,
      /readThroughSubscriptionAccess<SubscriptionAccess>\(\s*userId/
    );
  });

  it("[security] the server-side access cache is not a browser cache", () => {
    const src = code("lib/subscription/access-cache.ts");
    assert.doesNotMatch(src, /localStorage|sessionStorage|window\./);
  });

  it("[regression] plan-cache still declares itself cosmetic-only", () => {
    // If this header is ever softened, the boundary above loses its rationale.
    const src = read("lib/subscription/plan-cache.ts");
    assert.match(src, /cosmetic/i);
    assert.match(src, /server-authoritative/i);
  });
});

describe("cosmetic consolidation: one flight serves the sidebar and the walkthrough", () => {
  it("WalkthroughProvider no longer calls getSubscriptionAction directly", () => {
    const src = code("components/walkthrough/WalkthroughProvider.tsx");
    assert.doesNotMatch(
      src,
      /getSubscriptionAction/,
      "the tour's plan lookup must share the sidebar's single flight"
    );
    assert.match(src, /subscription\/plan-cache/);
    assert.match(src, /fetchPlanCached\(\)/);
  });

  it("WalkthroughProvider's plan is cosmetic — it gates a tour, not a feature", () => {
    const src = code("components/walkthrough/WalkthroughProvider.tsx");
    assert.doesNotMatch(
      src,
      /lib\/subscription\/access/,
      "the walkthrough must not be on the entitlement path either"
    );
    assert.match(src, /planIdRef\.current\s*=/);
  });

  it("the sidebar's tier chip reads the shared cache, not a fresh action", () => {
    const src = code("components/Sidebar.tsx");
    assert.match(src, /fetchPlanCached\(\)\.then\(setPlanId\)/);
    assert.match(src, /subscribeCachedPlan\(setPlanId\)/);
  });

  it("[regression] the sidebar makes at most ONE subscription round trip per page load", () => {
    const src = code("components/Sidebar.tsx");

    const invocations = src.match(/getSubscriptionAction\(\)/g) ?? [];
    assert.equal(
      invocations.length,
      1,
      "only the credits/renewal fetch may call the action, and only once"
    );

    // …and that one call is behind the once-per-page-load cache, so a
    // navigation (which re-mounts the whole sidebar) does not repeat it.
    assert.match(src, /createOncePerUserCache/);
    assert.match(
      src,
      /subDetailsCache\s*\n?\s*\.get\(\s*user\.id\s*,\s*fetchSubDetails\s*\)/
    );
  });

  it("[security] the sidebar's account numbers are never persisted", () => {
    const src = code("components/Sidebar.tsx");
    assert.doesNotMatch(
      src,
      /localStorage\.setItem|sessionStorage/,
      "credits + renewal date must stay in memory, keyed by user id"
    );
  });
});
