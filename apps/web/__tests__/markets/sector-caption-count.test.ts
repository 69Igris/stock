/**
 * MONEY-1126 — the sectors caption must count what is ON SCREEN.
 *
 * The caption under "Where the money's flowing" read
 * `${initialSectorBuckets.length} sectors`. That is the SSR prop, and
 * `app/discover/markets/page.tsx` wraps `getSectorHeatmapAction` in a 6s
 * `withTimeout` — so on any slow render the prop is `[]` and the caption
 * announced "0 sectors" above a fully-painted grid of thirteen. It never
 * corrected itself either: the prop is fixed for the life of the mount, while
 * the buckets that actually render are fetched client-side.
 *
 * Nothing else in the suite would catch it. The page renders, the grid
 * renders, only the label lies.
 *
 * Source-level assertions (no DOM runtime in this suite), matching the
 * convention in __tests__/markets/default-canvas.test.ts.
 *
 * Sources: apps/web/app/discover/markets/client.tsx
 *          apps/web/app/discover/sectors/SectorsHeatmap.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const client = readFileSync(
  join(ROOT, "app/discover/markets/client.tsx"),
  "utf8"
);
const heatmap = readFileSync(
  join(ROOT, "app/discover/sectors/SectorsHeatmap.tsx"),
  "utf8"
);

/** The `<span className="meta">…</span>` caption block. */
function caption(): string {
  const start = client.indexOf('<span className="meta">');
  assert.ok(start > 0, "could not locate the caption span");
  const end = client.indexOf("</span>", start);
  assert.ok(end > start);
  return client.slice(start, end);
}

describe("MONEY-1126 — sectors caption counts what rendered", () => {
  describe("client.tsx caption", () => {
    it("no longer derives the sector count from the SSR prop", () => {
      assert.doesNotMatch(
        caption(),
        /initialSectorBuckets\.length\} sectors/,
        "the SSR prop is `[]` whenever page.tsx's 6s withTimeout fires — " +
          "counting it is what printed '0 sectors' over a full grid"
      );
      assert.doesNotMatch(
        client,
        /\$\{initialSectorBuckets\.length\} sectors/,
        "no interpolation of the SSR length into a 'sectors' label anywhere"
      );
    });

    it("renders the LIVE count reported by the heatmap", () => {
      assert.match(
        caption(),
        /\$\{liveSectorCount\} sectors/,
        "the caption must interpolate the count the component reported"
      );
    });

    it("omits the count while it is unknown rather than printing 0", () => {
      const c = caption();
      assert.match(
        c,
        /liveSectorCount !== null\s*\?/,
        "a null count means 'not known yet' and must take the countless branch"
      );
      const fallback = c.slice(c.indexOf("liveSectorCount !== null"));
      assert.match(
        fallback,
        /:\s*"sized by mcap · coloured by change"/,
        "the unknown branch must drop the number entirely — a rendered '0 " +
          "sectors' during load is the same lie in a different costume"
      );
      assert.doesNotMatch(
        fallback,
        /"0 sectors/,
        "never hardcode a zero into the caption"
      );
    });

    it("still falls back to the SSR value before the first client result", () => {
      // A successful server render should label the very first paint; only a
      // TIMED-OUT one (length 0) starts as unknown.
      assert.match(
        client,
        /const \[liveSectorCount, setLiveSectorCount\] = useState<number \| null>\(\s*\(\)\s*=>\s*initialSectorBuckets\.length > 0 \? initialSectorBuckets\.length : null\s*\)/,
        "seed from the SSR prop when it has data, else null"
      );
    });

    it("wires the reporter into SectorsHeatmap with a stable identity", () => {
      // Passing the raw setter (stable across renders) keeps the child's
      // reporting effect from re-firing on every parent render — an inline
      // arrow would make the dep change every time.
      assert.match(
        client,
        /onBucketCountChange=\{setLiveSectorCount\}/,
        "pass the useState setter itself, not a fresh closure"
      );
    });

    it("[regression] the caption still follows the canvas", () => {
      // Quoting a sector count while the tiles are stocks (or vice versa)
      // describes the other view — the pre-existing rule this change sits on.
      assert.match(caption(), /canvas === "sectors"\s*\?/);
      assert.match(caption(), /stocks · grouped by sector/);
    });
  });

  describe("SectorsHeatmap reporting", () => {
    it("declares the callback as `number | null`", () => {
      assert.match(
        heatmap,
        /onBucketCountChange\?: \(count: number \| null\) => void;/,
        "null is a distinct state from 0 — 'unknown' vs 'resolved empty'"
      );
    });

    it("reports the rendered bucket count, not the prop", () => {
      const effect = heatmap.slice(
        heatmap.indexOf("if (!onBucketCountChange) return;")
      );
      assert.match(
        effect.slice(0, 400),
        /onBucketCountChange\(buckets\.length\)/,
        "report the live `buckets` state — that is what is on screen"
      );
    });

    it("reports null while loading and 0 only once settled", () => {
      const effect = heatmap.slice(
        heatmap.indexOf("if (!onBucketCountChange) return;")
      );
      assert.match(
        effect.slice(0, 900),
        /onBucketCountChange\(loading \? null : 0\)/,
        "an in-flight fetch is 'unknown'; a settled empty result is a real 0"
      );
    });

    it("re-reports whenever the count or the loading state changes", () => {
      assert.match(
        heatmap,
        /\}, \[buckets\.length, loading, onBucketCountChange\]\);/,
        "depend on `buckets.length` (a number) rather than the array, so a " +
          "re-fetch returning the same size does not re-notify"
      );
    });
  });
});
