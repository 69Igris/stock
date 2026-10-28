/**
 * MONEY-1126 — the sectors canvas loads behind a SKELETON, not a spinner.
 *
 * Two things are pinned here:
 *
 *  1. Theme-awareness. Every fill must be a playful CSS-var token, which is
 *     defined per theme. `bg-white/[...]`, `bg-black/[...]` and hardcoded hex
 *     fills render correctly in exactly one theme and wrong in the other —
 *     the same rule `__tests__/screener/results-skeleton-theme.test.ts`
 *     already enforces on `components/screener/ResultsSkeleton.tsx`, which
 *     this component mirrors. (Note the neighbouring
 *     `components/markets/Skeletons.tsx` is NOT theme-aware — it hardcodes
 *     `#080d1a` and `rgba(255,255,255,…)` — so "copy the file next door" is
 *     the wrong instinct here and this test says so.)
 *
 *  2. Both halves of the canvas. The sectors view is a tile heatmap AND a
 *     RANKED drill-down table. A skeleton covering only the heatmap reserves
 *     the wrong height, so the page still jumps by the table's full height
 *     when data lands — the CLS the skeleton exists to remove.
 *
 * Source-level assertions (no DOM runtime in this suite).
 *
 * Sources: apps/web/app/discover/sectors/SectorsSkeleton.tsx
 *          apps/web/app/discover/sectors/SectorsHeatmap.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

/** Strip comments. The colour assertions below are about what the component
 *  RENDERS, and both files document the very literals they forbid — a raw
 *  text search would fail on the explanation instead of on the code. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const skeleton = stripComments(
  readFileSync(join(ROOT, "app/discover/sectors/SectorsSkeleton.tsx"), "utf8")
);
const heatmap = stripComments(
  readFileSync(join(ROOT, "app/discover/sectors/SectorsHeatmap.tsx"), "utf8")
);

describe("MONEY-1126 — sectors skeleton", () => {
  describe("theme-aware tokens only", () => {
    it("uses no dark-only bg-white/[...] fills", () => {
      // `dark:bg-white/...` would be intentionally theme-scoped; a bare one
      // is not.
      assert.equal(
        /[^:]bg-white\//.test(skeleton),
        false,
        "SectorsSkeleton uses a bg-white/... fill, which only reads on dark"
      );
    });

    it("uses no light-only bg-black/[...] fills", () => {
      assert.equal(
        /[^:]bg-black\//.test(skeleton),
        false,
        "SectorsSkeleton uses a bg-black/... fill, which only reads on light"
      );
    });

    it("hardcodes no colour literal at all", () => {
      // Anything that can paint a pixel must resolve through var(--…). The
      // last pattern catches a quoted colour in a style position that is not
      // a token (e.g. `background: "tomato"`), which the fixed-notation
      // checks above would miss.
      const forbidden: Array<[RegExp, string]> = [
        [/#[0-9a-fA-F]{3,8}\b/, "a hex fill"],
        [/rgba?\(/, "an rgb/rgba fill"],
        [/hsla?\(/, "an hsl fill"],
        [/oklch\(/, "an oklch fill"],
        [
          /\b(background|color)\s*[:=]\s*"(?![^"]*var\(--)[^"]*"/,
          "a non-token colour literal",
        ],
      ];
      for (const [pattern, why] of forbidden) {
        assert.equal(
          pattern.test(skeleton),
          false,
          `SectorsSkeleton uses ${why} — it must use the theme CSS-var tokens`
        );
      }
    });

    it("fills every block with a playful CSS-var token", () => {
      for (const token of ["--rule-soft", "--rule-softer", "--emerald-bg"]) {
        assert.ok(
          skeleton.includes(`var(${token})`),
          `expected the skeleton to use var(${token})`
        );
      }
      // Colours reach the blocks either inline or through the `Bar` helper's
      // `fill` prop; check every literal handed to both, INCLUDING the prop's
      // default (which is what the un-passed calls render).
      const literals =
        skeleton.match(/(?:background|fill)\s*[:=]\s*"[^"]*"/g) ?? [];
      assert.ok(
        literals.length >= 8,
        `expected the skeleton to set several fills, saw ${literals.length}`
      );
      for (const l of literals) {
        assert.match(
          l,
          /var\(--/,
          `fill "${l.trim()}" must go through a theme token`
        );
      }
      assert.match(
        skeleton,
        /fill = "var\(--rule-soft\)"/,
        "the Bar helper's default fill must itself be a token"
      );
    });

    it("sits on the same pf-card surfaces it stands in for", () => {
      assert.match(skeleton, /className="pf-card flat"/);
      assert.match(skeleton, /className="pf-card"/);
    });
  });

  describe("renders BOTH sections of the canvas", () => {
    it("renders the tile strip with the real grid template", () => {
      assert.match(skeleton, /const TILE_COUNT = 6;/);
      assert.match(
        skeleton,
        /gridTemplateColumns: "repeat\(auto-fit, minmax\(150px, 1fr\)\)"/,
        "must match the real tile strip so the reflow is a no-op"
      );
    });

    it("renders the heatmap canvas at the real minHeight", () => {
      assert.match(
        skeleton,
        /const HEATMAP_MIN_HEIGHT = 460;/,
        "460 is the `minHeight` of the live treemap container"
      );
      assert.match(skeleton, /minHeight: HEATMAP_MIN_HEIGHT/);
    });

    it("renders the RANKED drill-down table too", () => {
      assert.match(
        skeleton,
        /const TABLE_ROWS = 12;/,
        "omitting the table is the CLS: the page jumps by its full height"
      );
      assert.match(
        skeleton,
        /Array\.from\(\{ length: TABLE_ROWS \}\)/,
        "the table rows must actually render"
      );
    });

    it("lays the fake treemap out deterministically", () => {
      // Random widths would differ between the server render and hydration.
      assert.doesNotMatch(skeleton, /Math\.random/);
      assert.match(skeleton, /const CELL_WEIGHTS = \[[\d, ]+\] as const;/);
    });

    it("announces itself as busy for assistive tech", () => {
      assert.match(skeleton, /aria-busy="true"/);
      assert.match(skeleton, /aria-label="Loading sector heatmap"/);
    });
  });

  describe("SectorsHeatmap uses it", () => {
    it("renders the skeleton on the nothing-yet path", () => {
      assert.match(
        heatmap,
        /import SectorsSkeleton from ".\/SectorsSkeleton";/
      );
      assert.match(
        heatmap,
        /if \(loading && buckets\.length === 0\) \{\s*return <SectorsSkeleton \/>;\s*\}/,
        "the empty-and-loading branch must render the skeleton"
      );
    });

    it("no longer renders a bare spinner in an empty 460px box", () => {
      assert.doesNotMatch(
        heatmap,
        /minHeight: 460,\s*display: "flex",\s*alignItems: "center",\s*justifyContent: "center",/,
        "the centred-spinner-in-a-void box is what the skeleton replaces"
      );
      assert.doesNotMatch(
        heatmap,
        /className="h-6 w-6 animate-spin"/,
        "the full-box spinner is gone; only the small in-grid refetch overlay " +
          "spinner (h-5 w-5) remains"
      );
    });

    it("[regression] keeps the small overlay spinner for a refetch", () => {
      // That one sits OVER a painted grid — it is feedback, not a loading
      // screen, and replacing it with a skeleton would blank good data.
      assert.match(heatmap, /className="h-5 w-5 animate-spin"/);
    });
  });
});
