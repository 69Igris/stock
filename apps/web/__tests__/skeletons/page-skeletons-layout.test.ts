/**
 * MONEY-392 round 2: structural assertions for the page skeletons that were
 * rewritten to match the current Terminal Luxe page layouts.
 *
 * Source-level grep - JSX rendering in node:test would require extra infra.
 * These tests fail when:
 *   - A skeleton still uses the old generic 5-col stat strip
 *   - A skeleton lacks responsive breakpoints
 *   - Dashboard skeleton still renders Market Pulse
 *   - Roast hero falls back to non-orange icon
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const skeletonSrc = readFileSync(
  join(ROOT, "components", "skeletons", "index.tsx"),
  "utf8"
);

function fnBody(name: string): string {
  // Extract the body of `export function {name}` until the next `export function`
  // (or end of file). Used to scope assertions to the specific skeleton.
  const start = skeletonSrc.indexOf(`export function ${name}(`);
  if (start === -1) throw new Error(`skeleton ${name} not found`);
  const after = skeletonSrc.indexOf("export function ", start + 1);
  return skeletonSrc.slice(start, after === -1 ? undefined : after);
}

describe("MONEY-392 - page skeleton layouts (round 2)", () => {
  describe("DashboardSkeleton", () => {
    const body = fnBody("DashboardSkeleton");
    it("no longer renders the Market Pulse skeleton block", () => {
      // We only check for the rendered structure (h-14 stack of three
      // bars). The "Market Pulse" string survives in a comment explaining
      // what was removed - that's intentional, future devs need the why.
      assert.equal(
        body.includes(
          'Skeleton className="h-14 w-full bg-muted/50 rounded-lg"'
        ),
        false,
        "Dashboard skeleton still draws the three Market Pulse bar placeholders"
      );
    });
  });

  describe("HoldingsSkeleton", () => {
    const body = fnBody("HoldingsSkeleton");
    it("uses the 5-stat auto-fit strip that mirrors the hydrated holdings header", () => {
      // Post-MONEY-485 the holdings hero exposes FIVE stat tiles, laid
      // out with an auto-fit `minmax(150px, 1fr)` grid (not the old
      // fixed `grid-cols-2 lg:grid-cols-4` / `lg:grid-cols-5` strip).
      assert.ok(
        body.includes("repeat(auto-fit, minmax(150px, 1fr))"),
        "HoldingsSkeleton should use the auto-fit 5-stat strip"
      );
      assert.ok(
        body.includes("{ length: 5 }"),
        "HoldingsSkeleton stat strip should render 5 tiles"
      );
    });
    it("includes a segmented 3-tab strip", () => {
      assert.ok(body.includes("rounded-[9px]"));
    });
    it("uses the playful ink-card tab strip (pf-skel-card) for the active tab", () => {
      // The playful tab bar rides on the shared `.pf-skel-card flat`
      // shimmer card (theme-aware via playful-app.css tokens) rather
      // than the old Terminal-Luxe emerald-tinted active pill.
      assert.ok(
        body.includes("pf-skel-card flat rounded-[9px]"),
        "HoldingsSkeleton tab strip should use the playful ink-card surface"
      );
    });
    it("hides at least one table column on mobile via Tailwind responsive class", () => {
      assert.ok(body.includes("hidden md:table-cell"));
    });
  });

  describe("TradebookSkeleton", () => {
    const body = fnBody("TradebookSkeleton");
    it("uses 4-stat-card grid (not the 5-card strip)", () => {
      assert.ok(body.includes("grid-cols-2 lg:grid-cols-4"));
      assert.equal(body.includes("md:grid-cols-3 lg:grid-cols-5"), false);
    });
    it("table is scrollable on narrow viewports", () => {
      assert.ok(body.includes("overflow-x-auto"));
      assert.ok(body.includes("min-w-["));
    });
  });

  describe("WatchlistSkeleton", () => {
    const body = fnBody("WatchlistSkeleton");
    it("uses a sidebar+content responsive layout", () => {
      assert.ok(body.includes("flex flex-col lg:flex-row"));
    });
    it("hides the Name column on mobile", () => {
      assert.ok(body.includes("hidden sm:table-cell"));
    });
  });

  describe("RoastSkeleton", () => {
    const body = fnBody("RoastSkeleton");
    it("renders an orange-tinted flame hero placeholder", () => {
      // Playful roast hero/CTA use the brand flame tint as an inline
      // rgba background (reads correctly on both cream + ink themes)
      // rather than the old `bg-orange-500/15 dark:bg-orange-500/25`
      // utility pair.
      assert.ok(
        body.includes("rgba(255, 107, 53, 0.12)"),
        "RoastSkeleton hero should use the brand flame rgba tint"
      );
    });
    it("includes a history grid (md:grid-cols-2)", () => {
      assert.ok(body.includes("md:grid-cols-2"));
    });
  });

  describe("FireSkeleton", () => {
    const body = fnBody("FireSkeleton");
    it("uses 4-stat-card responsive grid", () => {
      assert.ok(body.includes("grid-cols-2 lg:grid-cols-4"));
    });
    it("chart bars use responsive height tiers", () => {
      assert.ok(body.includes("h-60 sm:h-72 lg:h-80"));
    });
  });

  describe("BrokersSkeleton", () => {
    const body = fnBody("BrokersSkeleton");
    it("connected-brokers grid scales 1→2→3", () => {
      assert.ok(body.includes("grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"));
    });
    it("available-brokers grid scales 1→2→3→4", () => {
      assert.ok(
        body.includes(
          "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4"
        )
      );
    });
  });

  describe("PaperTradingSkeleton", () => {
    const body = fnBody("PaperTradingSkeleton");
    it("uses 4-stat-card grid (not 6-col strip)", () => {
      assert.ok(body.includes("grid-cols-2 lg:grid-cols-4"));
      assert.equal(body.includes("lg:grid-cols-6"), false);
    });
    it("position cards: 1→2→3 responsive", () => {
      assert.ok(body.includes("grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"));
    });
  });
});
