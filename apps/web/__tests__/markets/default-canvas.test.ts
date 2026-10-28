/**
 * /discover/markets opens on the STOCKS canvas — except when the URL names a
 * sector.
 *
 * Two things are pinned here, and the second is the one that breaks quietly:
 *
 *  1. The default canvas is `stocks`. The page is read for which NAMES moved;
 *     the sector rollup is the summary of that, one click away.
 *
 *  2. `?sector=<slug>` still opens the SECTORS canvas. `/discover/sectors` and
 *     `/discover/sectors/[sector]` are redirects to this route carrying that
 *     param (MONEY-1092), so it is an explicit request for the sector view.
 *     `SectorsHeatmap` is mounted behind the canvas ternary, so a blanket
 *     `"stocks"` default would unmount the drill-down those links asked for
 *     while the URL still advertised it — a URL/UI divergence of exactly the
 *     kind MONEY-1082 was about, reached through a default instead of a stray
 *     history write. Nothing else in the suite would catch it: the page still
 *     renders, just not the view the link requested.
 *
 * Source-level assertions (no DOM runtime in this suite), matching the
 * convention in __tests__/screener/results-skeleton-theme.test.ts.
 *
 * Source: apps/web/app/discover/markets/client.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "app/discover/markets/client.tsx"), "utf8");

/** The `canvas` useState initialiser, whitespace-normalised. */
function canvasInitialiser(): string {
  const match = src.match(
    /const \[canvas, setCanvas\] = useState<[^>]+>\(([\s\S]*?)\);/
  );
  assert.ok(match, "could not locate the `canvas` useState declaration");
  return match[1].replace(/\s+/g, " ").trim();
}

describe("/discover/markets — default canvas", () => {
  it("defaults to the stocks canvas", () => {
    const init = canvasInitialiser();
    assert.match(
      init,
      /"stocks"/,
      "the stocks canvas must be the default the initialiser falls back to"
    );
  });

  it("is not a bare `useState('sectors')` any more", () => {
    assert.doesNotMatch(
      src,
      /useState<"sectors"\s*\|\s*"stocks">\(\s*"sectors"\s*\)/,
      "a bare sectors default is the behaviour this test exists to prevent"
    );
  });

  it("[regression] a ?sector= URL still opens the sectors canvas", () => {
    const init = canvasInitialiser();
    assert.match(
      init,
      /searchParams\s*\?\.\s*get\(\s*"sector"\s*\)/,
      "the initialiser must consult the `sector` param — /discover/sectors " +
        "redirects here with it and expects the sector view"
    );
    assert.match(
      init,
      /\?\s*"sectors"\s*:\s*"stocks"/,
      "a sector param selects `sectors`; everything else selects `stocks`"
    );
  });

  it("seeds the canvas once rather than syncing it from the URL", () => {
    // Lazy initialiser, not a value — the URL is a bookmark here, not the
    // source of truth (same rule as `selectedSectorSlug` directly above it).
    assert.match(
      src,
      /const \[canvas, setCanvas\] = useState<[^>]+>\(\s*\(\)\s*=>/,
      "canvas must use a lazy initialiser so the URL is read at mount only"
    );
  });

  it("the caption still follows the canvas", () => {
    // Quoting a stock count while the tiles are sectors (or vice versa)
    // describes the other view — the caption is derived, and must stay so.
    assert.match(src, /canvas === "sectors"\s*\?/);
  });
});
