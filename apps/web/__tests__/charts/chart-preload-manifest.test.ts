/**
 * MONEY-1383 (L2) — the TradingView preload manifest must describe files that
 * actually exist, and must be in sync with the loader it was generated from.
 *
 * WHY THIS TEST IS THE POINT OF THE WHOLE MECHANISM. The main bundle is
 * `/charting_library/bundles/library.<contenthash>.js` and the hash moves on
 * every library upgrade (`yarn sync:chart`). A stale preload href does not
 * throw, does not break the chart and does not show up in any monitor — it
 * 404s silently, prints a console line nobody reads, and the page quietly goes
 * back to paying the ~1.5s cold library download after PageGuard resolves.
 * This is what turns that into a failing build.
 *
 * Source: scripts/gen-chart-preload-manifest.ts
 *         apps/web/lib/charts/preload-manifest.json
 *         apps/web/components/charts/ChartPreloadLinks.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parsePreloadEntries } from "../../../../scripts/gen-chart-preload-manifest";
import manifest from "@/lib/charts/preload-manifest.json";
import {
  paperTerminalShowsChart,
  stockPageShowsChart,
} from "@/lib/charts/preload-gate";

const WEB_ROOT = resolve(__dirname, "../..");
const PUBLIC_DIR = resolve(WEB_ROOT, "public");
const STANDALONE = resolve(
  PUBLIC_DIR,
  "charting_library/charting_library.standalone.js"
);

function onDisk(href: string): string {
  // Every href is a public-root URL path; `public/` is the document root.
  return resolve(PUBLIC_DIR, href.replace(/^\//, ""));
}

describe("MONEY-1383 L2 — chart preload manifest", () => {
  it("is non-empty", () => {
    assert.ok(
      manifest.length > 0,
      "an empty manifest renders no links and silently disables the whole fix"
    );
  });

  it("EVERY href exists on disk", () => {
    const missing = manifest
      .map((e) => e.href)
      .filter((href) => !existsSync(onDisk(href)));
    assert.deepEqual(
      missing,
      [],
      "preload hrefs that 404: re-run `npx tsx scripts/gen-chart-preload-manifest.ts` " +
        "(or `yarn sync:chart`) after a charting-library upgrade"
    );
  });

  it("every href is a public-root path under /charting_library/", () => {
    for (const entry of manifest) {
      assert.ok(
        entry.href.startsWith("/charting_library/"),
        `unexpected href: ${entry.href}`
      );
      assert.equal(entry.as, "script");
    }
  });

  it("includes the loader AND the hashed main bundle", () => {
    const hrefs = manifest.map((e) => e.href);
    assert.ok(
      hrefs.includes("/charting_library/charting_library.standalone.js"),
      "the loader is the first thing PageGuard delays"
    );
    assert.ok(
      hrefs.some((h) => /\/bundles\/library\.[0-9a-f]+\.js$/.test(h)),
      `no hashed main bundle in ${JSON.stringify(hrefs)} — that is the 2.5 MB one`
    );
  });

  it("the loader carries NO crossOrigin; the iframe's bundles carry anonymous", () => {
    for (const entry of manifest) {
      const isLoader = entry.href.endsWith("charting_library.standalone.js");
      if (isLoader) {
        // next/script fetches this from the PARENT document with no
        // crossorigin; a mismatched preload would be a second request.
        assert.equal(
          "crossOrigin" in entry ? entry.crossOrigin : undefined,
          undefined,
          "the loader entry must not declare crossOrigin"
        );
      } else {
        // The widget's iframe writes
        // `<script defer crossorigin="anonymous" src="bundles/...">`.
        assert.equal(
          (entry as { crossOrigin?: string }).crossOrigin,
          "anonymous",
          `${entry.href} must mirror the iframe's CORS mode`
        );
      }
    }
  });

  it("is IN SYNC with the loader it was generated from", () => {
    const regenerated = parsePreloadEntries(readFileSync(STANDALONE, "utf8"));
    assert.deepEqual(
      manifest,
      regenerated,
      "preload-manifest.json is stale — regenerate it with " +
        "`npx tsx scripts/gen-chart-preload-manifest.ts`"
    );
  });

  it("refuses to guess when the loader's shape changes", () => {
    assert.throws(
      () => parsePreloadEntries("var x = 1; // no bundle list here"),
      /could not find the bundle list/,
      "a silent empty manifest would disable the fix with no signal"
    );
  });
});

// ── B1: preload only where the CLIENT will actually mount a chart ──────────
//
// The links are rendered from the SERVER page and the chart is gated in the
// CLIENT, so when the two disagree the visitor downloads every href above —
// ~480 KB brotli / 2.5 MB — for a document that never executes them, and
// Chrome prints one "preloaded but not used" warning per entry. Two pages were
// doing exactly that: /stock/[symbol] for every DEMO visitor and
// /paper-trading/terminal for every FREE user, the majority tier.

describe("MONEY-1383 L2 — the preload gate mirrors the client's chart gate", () => {
  it("stock page: a demo visitor gets NO preload", () => {
    // client.tsx: `{isDemoMode ? <"Charts disabled in demo mode"> : <chart/>}`
    assert.equal(stockPageShowsChart({ isDemo: true }), false);
  });

  it("stock page: everyone else does", () => {
    assert.equal(stockPageShowsChart({ isDemo: false }), true);
  });

  it("paper terminal: a FREE user gets NO preload", () => {
    // client.tsx: `isFreeUser = !isDemoMode && planId === "FREE"`,
    //             `{isFreeUser ? <"Charts available on Pro plan"> : <chart/>}`
    assert.equal(
      paperTerminalShowsChart({ isDemo: false, planId: "FREE" }),
      false
    );
  });

  it("paper terminal: paid tiers do", () => {
    for (const planId of ["PRO", "PREMIUM", "ULTIMATE"]) {
      assert.equal(
        paperTerminalShowsChart({ isDemo: false, planId }),
        true,
        planId
      );
    }
  });

  it("the two pages DISAGREE about a demo visitor, and both are right", () => {
    // `isFreeUser`'s first clause is `!isDemoMode`, so the terminal shows a
    // demo visitor the chart while the stock page replaces it. One shared
    // predicate would have to be wrong on one of the two pages.
    assert.equal(
      paperTerminalShowsChart({ isDemo: true, planId: "FREE" }),
      true
    );
    assert.equal(stockPageShowsChart({ isDemo: true }), false);
  });
});

describe("MONEY-1383 L2 — the gated pages render the links CONDITIONALLY", () => {
  // The pure predicates above cannot see the render site, and the reported
  // defect WAS the render site: `<ChartPreloadLinks />` sitting unconditionally
  // in a server page whose client hides the chart. This asserts the guard is
  // present — not that it is the right guard, which is what the cases above are
  // for. /etf/[symbol] is deliberately absent: its chart has no gate.
  const GATED = [
    "app/stock/[symbol]/page.tsx",
    "app/paper-trading/terminal/page.tsx",
  ];

  for (const page of GATED) {
    it(`${page} never renders <ChartPreloadLinks/> unconditionally`, () => {
      const src = readFileSync(resolve(WEB_ROOT, page), "utf8");
      const renders = src.match(/[^\n]*<ChartPreloadLinks\b[^\n]*/g) ?? [];
      assert.equal(renders.length, 1, `expected exactly one render site`);
      assert.match(
        renders[0]!,
        /preloadChart && <ChartPreloadLinks/,
        "an unguarded preload spends ~2.5 MB on a page that hides the chart"
      );
    });
  }
});
