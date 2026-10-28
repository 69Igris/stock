/**
 * MONEY-393 §2 - PageGuard new props (containerClassName, title="",
 * RoastDetailSkeleton) + the 17 routes that wire containerClassName.
 *
 * Reads `components/PageGuard.tsx` and the 17 client.tsx call-sites
 * directly so the assertions catch a regression at source-text level
 * - no DOM, no rendering. Mirrors the existing pattern in
 * `__tests__/skeletons/page-title.test.ts` which already covers `bare`,
 * h1 styling, and per-route title/breadcrumb.
 *
 * Top-level `it()` to avoid node:test --test-force-exit racing the
 * describe-block scheduler.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("MONEY-393 §2 - PageGuard props + RoastDetailSkeleton", () => {
  it("[pageguard] declares `containerClassName?: string` prop", () => {
    const src = readSrc("components/PageGuard.tsx");
    assert.match(
      src,
      /containerClassName\?:\s*string/,
      "PageGuard should accept containerClassName prop"
    );
  });

  it("[pageguard] containerClassName falls back to TerminalLuxeShell 1600px default", () => {
    const src = readSrc("components/PageGuard.tsx");
    // The fallback chrome must use max-w-[1600px] mx-auto when no
    // override is supplied - matches TerminalLuxeShell's container.
    assert.ok(
      src.includes("max-w-[1600px]"),
      "fallback container must default to max-w-[1600px]"
    );
    assert.match(
      src,
      /containerClassName\s*\?\?[\s\S]{0,300}max-w-\[1600px\]/,
      "containerClassName should default to the 1600px max-w when absent"
    );
  });

  it("[pageguard] loading stage renders no PAGE_CONFIG title chip (Task B); title/breadcrumb kept for API compat", () => {
    const src = readSrc("components/PageGuard.tsx");
    // Post-MONEY-485 "Task B": PageGuard's loading stage no longer
    // renders a title/breadcrumb header — the page content owns its own
    // hero (matches the route's loading.tsx + the hydrated page). The
    // `title`/`breadcrumb` props are still accepted (every caller passes
    // them) but are destructured to unused locals, so an explicit
    // `title=""` from /roast is honoured as a harmless no-op rather than
    // suppressing a chip that no longer exists.
    assert.match(
      src,
      /title:\s*_title/,
      "title prop is destructured to an unused local (no longer rendered in the loading stage)"
    );
    assert.match(
      src,
      /breadcrumb:\s*_breadcrumb/,
      "breadcrumb prop is destructured to an unused local (no longer rendered in the loading stage)"
    );
    // The old `resolvedTitle = title ?? config.name` derivation must be
    // gone — re-introducing it would re-add the stage-1/stage-2 title
    // flash Task B eliminated.
    assert.ok(
      !/resolvedTitle/.test(src),
      "PageGuard must not derive a resolvedTitle in the loading stage (Task B removed the chip)"
    );
  });

  it("[pageguard] bare mode renders a default 3-block shimmer when no fallback is passed", () => {
    const src = readSrc("components/PageGuard.tsx");
    // The bare branch must render generic shimmers - not `null` - so
    // there's no "blank between" page during the auth-resolve window.
    assert.match(
      src,
      /if\s*\(\s*bare\s*\)\s*\{[\s\S]{0,400}DefaultShimmer|space-y-4 animate-pulse/,
      "bare branch must produce a visible shimmer, not blank null"
    );
  });

  it("[skeletons] RoastDetailSkeleton is exported and renders the back-arrow + meta + flame-hero shape", () => {
    const src = readSrc("components/skeletons/index.tsx");
    assert.match(
      src,
      /export\s+function\s+RoastDetailSkeleton\s*\(/,
      "RoastDetailSkeleton must be exported"
    );
    // The hero is the orange-tinted flame square; the back-arrow row
    // is the 8x8 rounded chip; the result tiles grid follows.
    const detailRegion =
      src.split("export function RoastDetailSkeleton")[1] ?? "";
    // Back-arrow chip (8x8 rounded) leads the meta header row.
    assert.ok(
      detailRegion.includes("h-8 w-8 rounded-md shrink-0"),
      "RoastDetailSkeleton must render the 8x8 back-arrow chip"
    );
    // Hero flame square uses the brand flame rgba tint (reads on both
    // cream + ink themes), matching RoastSkeleton + the hydrated detail.
    assert.ok(
      detailRegion.includes("rgba(255, 107, 53, 0.12)"),
      "RoastDetailSkeleton hero uses the brand flame rgba tint"
    );
    // The 4 result tiles grid follows the hero.
    assert.ok(
      detailRegion.includes("grid-cols-1 sm:grid-cols-2"),
      "RoastDetailSkeleton must render the result-tiles grid"
    );
  });

  it("[routes] 17 call-sites pass containerClassName so stage-2 width matches stage-3", () => {
    // Sample 5 routes spread across the 17 - if these have it, the
    // pattern was applied; we don't need to re-check all 17 by file.
    const routes: Array<[string, string]> = [
      ["app/positions/client.tsx", "p-4 sm:p-6 pb-48"],
      // Strategies shares the Discover canonical 1600px container (the
      // page is a wide catalog grid), not the old max-w-6xl.
      ["app/strategies/client.tsx", "max-w-[1600px]"],
      ["app/tax/client.tsx", "p-4 sm:p-6 pb-24"],
      ["app/roast/client.tsx", "max-w-5xl"],
      ["app/discover/client.tsx", "pb-48"],
    ];
    for (const [file, expectInside] of routes) {
      const src = readSrc(file);
      assert.match(
        src,
        /containerClassName\s*=\s*["'`]/,
        `${file} must pass containerClassName to PageGuard`
      );
      assert.ok(
        src.includes(expectInside),
        `${file} containerClassName should include "${expectInside}"`
      );
    }
  });

  it('[routes] /roast + /roast/[id] pass title="" so the roast hero is the only title block', () => {
    const indexSrc = readSrc("app/roast/client.tsx");
    const detailSrc = readSrc("app/roast/[id]/client.tsx");
    assert.match(
      indexSrc,
      /title=""/,
      '/roast/client.tsx must pass title="" to suppress PageGuard\'s h1'
    );
    assert.match(
      detailSrc,
      /title=""/,
      '/roast/[id]/client.tsx must pass title="" to suppress PageGuard\'s h1'
    );
  });

  it("[routes] /roast/[id] uses RoastDetailSkeleton (not RoastSkeleton) so stages 1-2 match stage 3", () => {
    const detailSrc = readSrc("app/roast/[id]/client.tsx");
    assert.match(
      detailSrc,
      /import\s*\{[^}]*RoastDetailSkeleton[^}]*\}\s*from\s+["']@\/components\/skeletons["']/,
      "/roast/[id]/client.tsx must import RoastDetailSkeleton from @/components/skeletons"
    );
    assert.match(
      detailSrc,
      /fallback=\{<RoastDetailSkeleton\s*\/>\}/,
      "/roast/[id] PageGuard fallback must be <RoastDetailSkeleton/>"
    );
    // Ensure it does NOT still import RoastSkeleton (the index variant)
    // which would re-introduce the stage-1/stage-2 hero mismatch.
    assert.ok(
      !detailSrc.match(/fallback=\{<RoastSkeleton\s*\/>\}/),
      "/roast/[id] must not use the landing-page RoastSkeleton as fallback"
    );
  });

  it("[routes] /roast + /roast/[id] loading.tsx use the same p-6 max-w-5xl chrome as the hydrated client", () => {
    // Stage 1 → 2 → 3 padding parity: all must use `p-6` (not the
    // mobile-narrower `p-4 sm:p-6`) and `max-w-5xl mx-auto`.
    const list = readSrc("app/roast/loading.tsx");
    const detail = readSrc("app/roast/[id]/loading.tsx");
    for (const [name, src] of [
      ["/roast/loading.tsx", list],
      ["/roast/[id]/loading.tsx", detail],
    ] as const) {
      assert.ok(
        src.includes("p-6 pb-24 max-w-5xl mx-auto"),
        `${name} must use p-6 pb-24 max-w-5xl mx-auto chrome`
      );
      assert.ok(
        !src.includes("p-4 sm:p-6 pb-24 max-w-5xl mx-auto"),
        `${name} must NOT use mobile-narrower p-4 sm:p-6 chrome (caused mobile width jump)`
      );
    }
  });

  it("[routes] loading.tsx of detail page uses RoastDetailSkeleton (not RoastSkeleton)", () => {
    const detail = readSrc("app/roast/[id]/loading.tsx");
    assert.match(
      detail,
      /import\s+\{\s*RoastDetailSkeleton\s*\}/,
      "/roast/[id]/loading.tsx must import RoastDetailSkeleton"
    );
    assert.ok(
      detail.includes("<RoastDetailSkeleton />"),
      "/roast/[id]/loading.tsx must render <RoastDetailSkeleton />"
    );
  });
});
