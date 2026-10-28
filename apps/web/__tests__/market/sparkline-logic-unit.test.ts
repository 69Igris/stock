/**
 * MONEY-620 — sparkline-logic.ts pure unit tests (REAL exports, no shadow).
 *
 * Imports the REAL exported pure helpers from the sparkline SERVICE logic
 * module (`packages/services/src/sparkline-logic.ts`) — the min/max + scale-to-
 * viewBox normalisation for the tiny list-view trend charts. `sparkline.service`
 * CALLS `sanitizeCloses` so every series it hands out is poison-free; the
 * renderer (`apps/web/components/charts/Sparkline.tsx`) does the SAME
 * `min/max/range` math inline today and is the live bug surface these helpers
 * exist to neutralise. No inline reimplementation: the assertions run the same
 * bytes the (sanitised) production path runs.
 *
 * The module is dependency-free (zero imports), so importing it never opens a
 * DB/Redis handle — the test stays pure and exits clean (no orphan).
 *
 * Four blind spots covered:
 *   - NON-FINITE: a single NaN/Infinity bar must NOT blank the whole chart
 *     (raw `Math.min(...data)`/`Math.max(...data)` go NaN from one bad bar →
 *     every y-coord NaN); dropped before scaling.
 *   - FLAT (min===max): the legacy `range = max - min || 1` pinned a flat
 *     series to the bottom (y === height); we centre it (y === height/2).
 *   - EMPTY / SINGLE-POINT: no throw, sensible `[]` default (caller draws a
 *     placeholder), exactly as the component's `data.length < 2` branch.
 *   - CONSUMER-SAFETY: every x/y is finite — no NaN/Infinity ever reaches an
 *     SVG `points` attribute.
 *
 * Source: packages/services/src/sparkline-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  finite,
  sanitizeCloses,
  sparklineExtent,
  scaleSparklineToViewBox,
  sparklinePointsAttr,
} from "../../../../packages/services/src/sparkline-logic";

/** Assert every coordinate in a scaled series is finite + inside the box. */
function assertFiniteInBox(
  pts: { x: number; y: number }[],
  width: number,
  height: number
): void {
  for (const p of pts) {
    assert.ok(Number.isFinite(p.x), `x ${String(p.x)} must be finite`);
    assert.ok(Number.isFinite(p.y), `y ${String(p.y)} must be finite`);
    assert.ok(p.x >= 0 && p.x <= width, `x ${p.x} in [0, ${width}]`);
    assert.ok(p.y >= 0 && p.y <= height, `y ${p.y} in [0, ${height}]`);
  }
}

describe("MONEY-620 — sparkline-logic.finite", () => {
  it("passes finite, collapses null/undefined/NaN/±Infinity to fallback", () => {
    assert.equal(finite(5), 5);
    assert.equal(finite(0), 0);
    assert.equal(finite(null), 0);
    assert.equal(finite(undefined), 0);
    assert.equal(finite(NaN), 0);
    assert.equal(finite(Infinity), 0);
    assert.equal(finite(-Infinity), 0);
    assert.equal(finite(undefined, 80), 80);
  });
});

describe("MONEY-620 — sparkline-logic.sanitizeCloses", () => {
  it("preserves a clean finite series in order", () => {
    assert.deepEqual(sanitizeCloses([1, 2, 3, 2.5]), [1, 2, 3, 2.5]);
  });

  it("drops NaN / ±Infinity / null / undefined points (poison removal)", () => {
    assert.deepEqual(
      sanitizeCloses([1, NaN, 2, Infinity, 3, -Infinity, null, 4, undefined]),
      [1, 2, 3, 4]
    );
  });

  it("non-array / empty → []", () => {
    assert.deepEqual(sanitizeCloses([]), []);
    assert.deepEqual(sanitizeCloses(null), []);
    assert.deepEqual(sanitizeCloses(undefined), []);
  });
});

describe("MONEY-620 — sparkline-logic.sparklineExtent (NaN-safe min/max)", () => {
  it("returns {min,max} over finite points", () => {
    assert.deepEqual(sparklineExtent([3, 1, 4, 1, 5, 9, 2]), {
      min: 1,
      max: 9,
    });
  });

  it("a NaN point does NOT poison the extent (regression — Math.min(...,NaN)=NaN)", () => {
    // The exact bug: `Math.max(...[1, NaN, 3])` === NaN, `Math.min` === NaN.
    assert.deepEqual(sparklineExtent([1, NaN, 3]), { min: 1, max: 3 });
    assert.deepEqual(sparklineExtent([Infinity, 5, 10, -Infinity]), {
      min: 5,
      max: 10,
    });
  });

  it("empty / all-non-finite → null (caller short-circuits, no Infinity range)", () => {
    assert.equal(sparklineExtent([]), null);
    assert.equal(sparklineExtent([NaN, Infinity, -Infinity, null]), null);
  });

  it("single finite point → min === max", () => {
    assert.deepEqual(sparklineExtent([42]), { min: 42, max: 42 });
  });
});

describe("MONEY-620 — sparkline-logic.scaleSparklineToViewBox", () => {
  it("ports the component math exactly for a clean finite series (y inverted)", () => {
    // data [10,20,30], width 80, height 24 → min 10, max 30, range 20.
    // y = height - ((v-min)/range)*height
    //   v=10 → 24 - 0      = 24   (lowest sits at bottom)
    //   v=20 → 24 - 12     = 12
    //   v=30 → 24 - 24     = 0    (highest sits at top)
    const pts = scaleSparklineToViewBox([10, 20, 30], {
      width: 80,
      height: 24,
    });
    assert.equal(pts.length, 3);
    assert.deepEqual(pts[0], { x: 0, y: 24 });
    assert.deepEqual(pts[1], { x: 40, y: 12 });
    assert.deepEqual(pts[2], { x: 80, y: 0 });
    assertFiniteInBox(pts, 80, 24);
  });

  it("defaults to 80×24 when no options given", () => {
    const pts = scaleSparklineToViewBox([1, 2]);
    assert.equal(pts[0]!.x, 0);
    assert.equal(pts[1]!.x, 80);
    assertFiniteInBox(pts, 80, 24);
  });

  it("a single NaN bar does NOT blank the whole chart (regression)", () => {
    // Legacy inline: max=NaN, min=NaN, range=NaN||1=1, (v-NaN)/1=NaN for ALL
    // points → every y is NaN → invisible polyline. Here the NaN bar is dropped.
    const pts = scaleSparklineToViewBox([10, NaN, 30], {
      width: 80,
      height: 24,
    });
    // Two finite bars survive → a 2-point line, all coords finite.
    assert.equal(pts.length, 2);
    assertFiniteInBox(pts, 80, 24);
    assert.deepEqual(pts[0], { x: 0, y: 24 }); // 10 (min) at bottom
    assert.deepEqual(pts[1], { x: 80, y: 0 }); // 30 (max) at top
  });

  it("an Infinity bar does NOT flatten the line to the baseline (regression)", () => {
    // Legacy inline: max=Infinity, range=Infinity, (v-min)/Infinity → 0/NaN.
    const pts = scaleSparklineToViewBox([10, Infinity, 20, 30]);
    assert.equal(pts.length, 3); // Infinity dropped → [10,20,30]
    assertFiniteInBox(pts, 80, 24);
  });

  it("a FLAT finite series (min===max) centres at height/2, not pinned to the bottom (bug fix)", () => {
    // Legacy: range = (5-5) || 1 = 1, y = height - ((5-5)/1)*height = height
    // → flat line glued to the very bottom. We centre it.
    const pts = scaleSparklineToViewBox([5, 5, 5, 5], {
      width: 90,
      height: 24,
    });
    assert.equal(pts.length, 4);
    for (const p of pts) assert.equal(p.y, 12); // height/2
    assert.deepEqual(
      pts.map((p) => p.x),
      [0, 30, 60, 90]
    );
    assertFiniteInBox(pts, 90, 24);
  });

  it("empty / single-point → [] (caller draws the dashed placeholder, no throw)", () => {
    assert.deepEqual(scaleSparklineToViewBox([]), []);
    assert.deepEqual(scaleSparklineToViewBox([42]), []);
    // one finite + noise that sanitises down to < 2 → []
    assert.deepEqual(scaleSparklineToViewBox([42, NaN, Infinity]), []);
  });

  it("all-non-finite series → [] (no Infinity/NaN range, no throw)", () => {
    assert.deepEqual(scaleSparklineToViewBox([NaN, Infinity, -Infinity]), []);
  });

  it("guards a non-finite width/height option (cannot smear NaN across x/y)", () => {
    const pts = scaleSparklineToViewBox([1, 2, 3], {
      width: NaN,
      height: Infinity,
    });
    // width→80, height→24 defaults applied.
    assertFiniteInBox(pts, 80, 24);
    assert.equal(pts[0]!.x, 0);
    assert.equal(pts[2]!.x, 80);
  });

  it("descending series maps the (later) low to the bottom correctly", () => {
    const pts = scaleSparklineToViewBox([30, 20, 10], {
      width: 80,
      height: 24,
    });
    assert.deepEqual(pts[0], { x: 0, y: 0 }); // 30 (max) top
    assert.deepEqual(pts[2], { x: 80, y: 24 }); // 10 (min) bottom
    assertFiniteInBox(pts, 80, 24);
  });
});

describe("MONEY-620 — sparkline-logic.sparklinePointsAttr", () => {
  it("renders a compact 'x,y x,y …' string for a finite series", () => {
    assert.equal(
      sparklinePointsAttr([10, 20, 30], { width: 80, height: 24 }),
      "0.00,24.00 40.00,12.00 80.00,0.00"
    );
  });

  it("returns '' for an unrenderable (<2-point / empty / all-non-finite) series", () => {
    assert.equal(sparklinePointsAttr([]), "");
    assert.equal(sparklinePointsAttr([5]), "");
    assert.equal(sparklinePointsAttr([NaN, Infinity]), "");
  });

  it("never emits 'NaN'/'Infinity' tokens even with a poisoned input", () => {
    const attr = sparklinePointsAttr([10, NaN, 30, Infinity, 20], {
      width: 80,
      height: 24,
    });
    assert.ok(!attr.includes("NaN"), `must not contain NaN: ${attr}`);
    assert.ok(!attr.includes("Infinity"), `must not contain Infinity: ${attr}`);
    // [10,30,20] survive → 3 coordinate pairs.
    assert.equal(attr.split(" ").length, 3);
  });
});
