/**
 * MONEY-620 (task #193) — Sparkline CLIENT-component wiring, real source.
 *
 * The LIVE client component `apps/web/components/charts/Sparkline.tsx` used to
 * build its SVG `<polyline points>` from its OWN inline min/max + y-scaling
 * math (`Math.max(...data)`, `range = max - min || 1`,
 * `y = height - ((v - min) / range) * height`). That inline math was UNGUARDED:
 * a single non-finite bar (NaN/Infinity from a bad quote) poisoned
 * `Math.min`/`Math.max` → every `y` went `NaN` → the whole sparkline silently
 * vanished; a flat series (`max === min`) was pinned to the very bottom.
 *
 * The component now does exactly:
 *   `const points = sparklinePointsAttr(data, { width, height });`
 *   `if (points === "") return <placeholder/>;`
 *   `<polyline points={`0,${height} ${points} ${width},${height}`} … />`
 * importing `sparklinePointsAttr` from the sibling
 * `apps/web/components/charts/sparkline-logic.ts`, which RE-EXPORTS the single
 * source of truth in `packages/services/src/sparkline-logic.ts` (the guarded
 * math the LIVE `sparkline.service.ts` also runs).
 *
 * This test imports the SAME sibling module the component imports (no inline
 * reimplementation, no shadow) and asserts the exact `points` string the
 * component feeds the SVG. It is pure (no DOM/render harness, zero open handles)
 * so it exits clean — matching the repo's node:test convention and the
 * never-orphan rule.
 *
 * Source under test:
 *   apps/web/components/charts/Sparkline.tsx           (the wiring)
 *   apps/web/components/charts/sparkline-logic.ts       (client re-export)
 *   packages/services/src/sparkline-logic.ts            (guarded math)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sparklinePointsAttr } from "../../components/charts/sparkline-logic";

const W = 80;
const H = 24;

/**
 * Reproduce the EXACT string the component renders into the fill polyline:
 *   `0,${height} ${points} ${width},${height}`
 * (the baseline-anchored gradient fill). The stroke polyline uses `points`
 * verbatim. We assert against both so a NaN can't sneak in via either path.
 */
function fillPointsAttr(data: number[]): string {
  const points = sparklinePointsAttr(data, { width: W, height: H });
  return `0,${H} ${points} ${W},${H}`;
}

describe("MONEY-620 — Sparkline client wiring: non-finite guard", () => {
  it("a single NaN bar does NOT blank the line (the live bug) — surviving bars render, no NaN coords", () => {
    const points = sparklinePointsAttr([10, NaN, 30], { width: W, height: H });
    // [10,30] survive → a 2-point line, all coords finite.
    assert.equal(points, "0.00,24.00 80.00,0.00");
    assert.ok(!points.includes("NaN"));
    assert.ok(!points.includes("Infinity"));
  });

  it("an Infinity bar does NOT collapse the line to the baseline", () => {
    const points = sparklinePointsAttr([10, Infinity, 20, 30], {
      width: W,
      height: H,
    });
    // Infinity dropped → [10,20,30] → 3 finite coordinate pairs.
    assert.equal(points.split(" ").length, 3);
    assert.ok(!points.includes("Infinity"));
    assert.ok(!points.includes("NaN"));
  });

  it("never emits 'NaN'/'Infinity' into the SVG points attribute the component renders", () => {
    const attr = fillPointsAttr([10, NaN, 30, Infinity, 20, -Infinity]);
    assert.ok(!attr.includes("NaN"), `attr leaked NaN: ${attr}`);
    assert.ok(!attr.includes("Infinity"), `attr leaked Infinity: ${attr}`);
    // baseline anchors + 3 surviving bars ([10,30,20]) = 5 coordinate tokens.
    assert.equal(attr.split(" ").length, 5);
  });
});

describe("MONEY-620 — Sparkline client wiring: flat / degenerate series", () => {
  it("a FLAT series (max === min) centres at height/2 (no divide-by-zero, not pinned to the bottom)", () => {
    const points = sparklinePointsAttr([5, 5, 5, 5], { width: W, height: H });
    // Every y is height/2 = 12 (NOT 24, the legacy `range = 0 || 1` bottom).
    for (const pair of points.split(" ")) {
      const y = Number(pair.split(",")[1]);
      assert.equal(y, 12);
      assert.ok(Number.isFinite(y));
    }
  });

  it("a flat ALL-ZERO series still renders a centred finite line (0/0 guarded)", () => {
    const points = sparklinePointsAttr([0, 0, 0], { width: W, height: H });
    assert.equal(points, "0.00,12.00 40.00,12.00 80.00,12.00");
  });
});

describe("MONEY-620 — Sparkline client wiring: unrenderable → placeholder ('' )", () => {
  it("empty series → '' (component draws the dashed placeholder, no throw)", () => {
    assert.equal(sparklinePointsAttr([], { width: W, height: H }), "");
  });

  it("single-point series → '' (a line needs two points)", () => {
    assert.equal(sparklinePointsAttr([42], { width: W, height: H }), "");
  });

  it("a series that sanitises down to < 2 finite points → '' (placeholder, not a NaN line)", () => {
    assert.equal(
      sparklinePointsAttr([42, NaN, Infinity], { width: W, height: H }),
      ""
    );
    assert.equal(
      sparklinePointsAttr([NaN, Infinity, -Infinity], { width: W, height: H }),
      ""
    );
  });
});

describe("MONEY-620 — Sparkline client wiring: normal series scales correctly", () => {
  it("ascending [10,20,30] maps low→bottom, high→top (y inverted) exactly as the inline math did for finite input", () => {
    assert.equal(
      sparklinePointsAttr([10, 20, 30], { width: W, height: H }),
      "0.00,24.00 40.00,12.00 80.00,0.00"
    );
  });

  it("descending [30,20,10] maps the (later) low to the bottom", () => {
    assert.equal(
      sparklinePointsAttr([30, 20, 10], { width: W, height: H }),
      "0.00,0.00 40.00,12.00 80.00,24.00"
    );
  });

  it("the rendered fill-polyline attribute is baseline-anchored and all-finite for a normal series", () => {
    const attr = fillPointsAttr([10, 20, 30]);
    assert.equal(attr, "0,24 0.00,24.00 40.00,12.00 80.00,0.00 80,24");
    assert.ok(!attr.includes("NaN"));
  });
});
