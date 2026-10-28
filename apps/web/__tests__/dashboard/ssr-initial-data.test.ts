/**
 * MONEY-1126 — the dashboard ships its data from the server, and the client
 * does not fetch it again.
 *
 * `/dashboard` shipped ZERO data from the server: `page.tsx` awaited only
 * `isDemoSession()`, then the client fired `getDashboardStatsAction` on mount —
 * behind clerk.js, because `useIDBCache` needs a Clerk `user.id` before it will
 * even look in IndexedDB. Prod RUM p75 network-settle was 14.4s.
 *
 * The regression this file guards is subtler than "did we pass initialData".
 * `useIDBCache`'s adopt-SSR-data branch was gated on `isIDBAvailable()`:
 *
 *     if (initialData && isIDBAvailable()) { …adopt…; return; }
 *     run();                                  // ← reached when IDB is missing
 *
 * so on a browser without IndexedDB (private/incognito, in-app webviews,
 * partitioned iframes) the SSR payload was ignored and the round trip happened
 * anyway — the optimisation silently switching itself off for the users least
 * able to afford it. Persisting must be a side effect of having the data, never
 * a precondition for using it.
 *
 * Structural rather than rendered: without jsdom + Testing Library (excluded
 * from this repo — see `__tests__/hooks/hooks-shape.test.ts`) the reachability
 * of `run()` is a property of the source. The assertions below read the actual
 * branch, not a paraphrase of it.
 *
 * Sources: apps/web/app/dashboard/{page,client}.tsx, apps/web/hooks/useIDBCache.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(WEB, rel), "utf8");
}

/** Comments stripped — assertions are about the code path, not the prose. */
function code(rel: string): string {
  return (
    read(rel)
      // MONEY-1143 — LINE comments BEFORE block comments. Reversed, a `//`
      // containing `/*` opens a phantom block that swallows everything to the
      // next `*/` (11,192 chars on Sidebar.tsx). These suites assert ABSENCES,
      // so swallowed text reads as a pass.
      .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
      .replace(/\/\*[\s\S]*?\*\//g, "")
  );
}

describe("useIDBCache: SSR data is adopted, IDB or no IDB", () => {
  const src = code("hooks/useIDBCache.ts");

  /** The `if (initialData) { … }` block, up to its closing brace. */
  const branch = src.match(/if \(initialData\) \{([\s\S]*?)\n {4}\}/);

  it("has an initialData branch that is NOT conditioned on IndexedDB", () => {
    assert.ok(branch, "the initialData early-return must exist");
    assert.doesNotMatch(
      src,
      /if \(initialData && isIDBAvailable\(\)\)/,
      "[regression] adopting SSR data must not require IndexedDB"
    );
  });

  it("[regression] returns from the effect, so the mount fetch is unreachable", () => {
    assert.ok(branch);
    assert.match(
      branch[1],
      /setData\(initialData\);/,
      "the SSR payload becomes the rendered data"
    );
    assert.match(branch[1], /setIsLoading\(false\);/);
    assert.match(
      branch[1],
      /return;\s*$/,
      "must return before run() — otherwise the client refetches"
    );
    assert.doesNotMatch(branch[1], /run\(\)/);
  });

  it("persists to IDB only as a best-effort side effect", () => {
    assert.ok(branch);
    // isIDBAvailable() survives INSIDE the branch, wrapping only the write.
    assert.match(
      branch[1],
      /if \(isIDBAvailable\(\)\) \{[\s\S]*?setCacheEntry\(/
    );
    // Whitespace-tolerant: prettier is free to break `.catch(() => {})` across
    // lines, and did. The property under test is that the persist call HAS a
    // catch — a failed IDB write must never break adoption of the SSR payload —
    // not how the formatter chose to lay it out.
    assert.match(
      branch[1],
      /setCacheEntry\([\s\S]*?\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/
    );
  });

  it("the fetch path still runs when there is no SSR payload", () => {
    // The branch is an early return, so `run()` is the fall-through — a cache
    // miss with no initialData behaves exactly as before.
    assert.match(src, /\n {4}run\(\);/);
  });
});

describe("/dashboard server component: warm-loads its stats", () => {
  const src = code("app/dashboard/page.tsx");

  it("resolves the dashboard stats on the server", () => {
    assert.match(src, /getDashboardStatsAction/);
    assert.match(src, /from "@\/lib\/actions\/dashboard"/);
  });

  it("bounds the server fetch with the shared, timer-clearing helper", () => {
    assert.match(src, /from "@\/lib\/utils\/with-timeout"/);
    assert.match(src, /withTimeout\(/);
    // The local copy this replaced never cleared its timeout.
    assert.doesNotMatch(src, /function withTimeout/);
  });

  it("[security] a slow or failed fetch degrades to null, never to a broken page", () => {
    assert.match(
      src,
      /getDashboardStatsAction\(\)\.catch\(\(\) => null\)/,
      "pre-catch so a post-deadline rejection cannot go unhandled"
    );
    assert.match(
      src,
      /statsResult\?\.success && statsResult\.data\s*\?\s*statsResult\.data\s*:\s*null/
    );
  });

  it("hands the payload to the client component", () => {
    assert.match(src, /initialStats=\{initialStats\}/);
  });

  it("stays dynamic — a portfolio must never be prerendered or shared", () => {
    assert.match(src, /export const dynamic = "force-dynamic"/);
  });
});

describe("/dashboard client component: consumes the SSR payload", () => {
  const src = code("app/dashboard/client.tsx");

  it("accepts initialStats and feeds it into the useIDBCache seam", () => {
    assert.match(src, /initialStats\?:\s*DashboardStats \| null;/);
    assert.match(src, /initialData:\s*initialStats,/);
  });

  it("keeps the fetcher as the fallback for a null payload", () => {
    assert.match(
      src,
      /fetcher:\s*async \(\) => \{[\s\S]*?getDashboardStatsAction\(\)/
    );
  });

  it("defaults to null so an un-migrated caller behaves as before", () => {
    assert.match(src, /initialStats = null,/);
  });
});

describe("/holdings server component: same helper, no local timer copy", () => {
  const src = code("app/holdings/page.tsx");

  it("[regression] uses the shared helper instead of the leaking local copy", () => {
    assert.doesNotMatch(
      src,
      /function withTimeout/,
      "the local copy armed three timers per render and cleared none"
    );
    assert.match(src, /from "@\/lib\/utils\/with-timeout"/);
    assert.equal((src.match(/withTimeout\(/g) ?? []).length, 3);
  });
});
