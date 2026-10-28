/**
 * MONEY-392: Documents skeleton must not render "Tax Reports" / "Risk Reports"
 * filter pills, since those entries were hidden from nav post-MONEY-387. Any
 * loading shell that still draws them causes a visual flash on every page load.
 *
 * Source-level grep - JSX rendering inside node:test would require extra infra.
 *
 * Post-MONEY-485 (playful redesign): the per-page skeletons no longer render
 * literal text labels — every placeholder is a width-sized shimmer `Bar`
 * (`.pf-skel`). The DocumentsSkeleton filter row is therefore a fixed-width
 * pill strip with NO text. The "must not include Tax/Risk Reports" guarantee
 * still holds (and is now structurally impossible to violate), and the
 * remaining-pills check asserts the placeholder strip the playful skeleton
 * actually draws.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKELETON_PATH = join(
  __dirname,
  "..",
  "..",
  "components",
  "skeletons",
  "index.tsx"
);
const skeletonSource = readFileSync(SKELETON_PATH, "utf8");

describe("MONEY-392 - skeletons/index.tsx", () => {
  describe("DocumentsSkeleton filter pills", () => {
    it("does not include 'Tax Reports' as a filter pill label", () => {
      assert.equal(
        skeletonSource.includes('"Tax Reports"'),
        false,
        "DocumentsSkeleton still lists 'Tax Reports' - remove it to prevent skeleton flash"
      );
    });

    it("does not include 'Risk Reports' as a filter pill label", () => {
      assert.equal(
        skeletonSource.includes('"Risk Reports"'),
        false,
        "DocumentsSkeleton still lists 'Risk Reports' - remove it to prevent skeleton flash"
      );
    });

    it("renders the placeholder filter-pill strip (playful: width-bars, no labels)", () => {
      // The playful DocumentsSkeleton draws its filter row as a
      // `flex flex-wrap` strip of fixed-width shimmer Bars — one of
      // which is the search-width pill `[40, 130, 110, 70]`. No text
      // labels are rendered in the skeleton stage at all.
      const body = skeletonSource.slice(
        skeletonSource.indexOf("export function DocumentsSkeleton(")
      );
      assert.ok(
        body.includes("[40, 130, 110, 70]"),
        "DocumentsSkeleton should render its 4 fixed-width filter-pill placeholders"
      );
      assert.ok(
        body.includes("flex flex-wrap gap-1.5"),
        "DocumentsSkeleton filter pills should sit in a flex-wrap strip"
      );
    });
  });

  describe("TaxSkeleton and RiskSkeleton page-level skeletons", () => {
    it("keeps TaxSkeleton exported (route still URL-accessible)", () => {
      assert.match(skeletonSource, /export function TaxSkeleton\(/);
    });

    it("keeps RiskSkeleton exported (route still URL-accessible)", () => {
      assert.match(skeletonSource, /export function RiskSkeleton\(/);
    });
  });

  describe("Terminal Luxe palette - no dark-only accent colors", () => {
    const FORBIDDEN_DARK_ONLY = [
      "bg-blue-900/50",
      "bg-emerald-900/50",
      "bg-emerald-900/30",
      "bg-orange-900/30",
    ];

    for (const cls of FORBIDDEN_DARK_ONLY) {
      it(`does not use dark-only class \`${cls}\``, () => {
        assert.equal(
          skeletonSource.includes(cls),
          false,
          `${cls} renders badly on light theme. Use \`bg-{color}-500/15 dark:bg-{color}-500/25\` instead.`
        );
      });
    }
  });
});
