/**
 * Skeleton placeholder sizes must be hydration-stable.
 *
 * These skeletons render on the SERVER (app/stock/[symbol]/loading.tsx) and
 * again on the CLIENT (the PageGuard fallback), so their style values have to
 * be byte-identical. Computing them inline did not guarantee that: ECMAScript
 * leaves `Math.sin` implementation-approximated (§21.3.2), and React serialises
 * a raw number at full precision — so a last-bit disagreement between Node and
 * a browser becomes a hydration error over a decorative shimmer.
 *
 * Rounding is the actual fix. Any conforming implementation agrees far above
 * 0.01, so a 2dp string is stable regardless of who computed it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(__dirname, "..", "..", "components", "skeletons", "index.tsx"),
  "utf8"
);

/** Mirrors the module's own helper. */
function barHeights(count: number, base: number, step: number, amp: number) {
  return Array.from(
    { length: count },
    (_, i) => `${(base + Math.abs(Math.sin(i * step)) * amp).toFixed(2)}%`
  );
}

describe("skeleton bar heights — hydration safety", () => {
  it("interpolates no IMPLEMENTATION-APPROXIMATED function into a style", () => {
    // The rule is about which functions the spec pins, not about rounding
    // everything. `${60 + (i % 3) * 18}px` and `${Math.min(100, 20 + i * 4)}%`
    // are exact integer arithmetic — identical on every implementation, and
    // requiring `toFixed` on them would be noise. The hazard is §21.3.2's
    // implementation-approximated set, which `Math.sin` belongs to.
    const APPROXIMATED =
      /Math\.(sin|cos|tan|asin|acos|atan|atan2|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot|sinh|cosh|tanh)\b/;
    const offenders = SRC.split("\n").filter(
      (l) =>
        /(height|width|top|left|transform): `\$\{/.test(l) &&
        APPROXIMATED.test(l)
    );
    assert.deepEqual(
      offenders.map((l) => l.trim()),
      [],
      "route these through a rounded module-level constant instead"
    );
  });

  it("computes no bar height inline in JSX", () => {
    const jsxSin = SRC.split("\n").filter(
      (l) => l.includes("Math.sin") && l.includes("height:")
    );
    assert.deepEqual(jsxSin, [], "bar heights must come from the constants");
  });

  it("rounds to a precision no implementation can disagree below", () => {
    // 2dp leaves ~13 orders of magnitude of headroom over a double's ULP.
    assert.match(SRC, /toFixed\(2\)/);
  });

  it("sizes each constant to its loop length — an over-short array renders undefined", () => {
    for (const [name, len] of [
      ["CHART_BAR_HEIGHTS", 60],
      ["MINI_BAR_HEIGHTS", 12],
      ["WIDE_BAR_HEIGHTS", 30],
    ] as const) {
      const m = SRC.match(new RegExp(`const ${name} = barHeights\\((\\d+),`));
      assert.ok(m, `${name} not found`);
      assert.equal(
        Number(m[1]),
        len,
        `${name} must hold ${len} entries to match its map()`
      );
    }
  });

  it("preserves the original visual proportions", () => {
    // Read from the SOURCE, not recomputed here. An earlier version of this
    // test called the local `barHeights` with the values it expected and
    // compared the result to the same formula — self-consistent, and it passed
    // happily while the module's own base was mutated 20 -> 25. The parameters
    // in the file are the only thing that decides what ships.
    const declared = new Map<string, number[]>();
    for (const m of SRC.matchAll(
      /const (\w+_BAR_HEIGHTS) = barHeights\(([^)]+)\);/g
    )) {
      declared.set(
        m[1],
        m[2].split(",").map((v) => Number(v.trim()))
      );
    }

    // count, base, step, amplitude — as the original inline formulas had them.
    const EXPECTED: Record<string, [number, number, number, number]> = {
      // `${20 + Math.abs(Math.sin(i * 0.15)) * 50}%`
      CHART_BAR_HEIGHTS: [60, 20, 0.15, 50],
      // `${30 + Math.abs(Math.sin(i * 0.9)) * 55}%`
      MINI_BAR_HEIGHTS: [12, 30, 0.9, 55],
      // `${30 + Math.abs(Math.sin(i * 0.4)) * 50 + 15}%` — base folded to 45
      WIDE_BAR_HEIGHTS: [30, 45, 0.4, 50],
    };

    assert.deepEqual(
      [...declared.keys()].sort(),
      Object.keys(EXPECTED).sort(),
      "a placeholder set was added or removed without updating this test"
    );
    for (const [name, want] of Object.entries(EXPECTED)) {
      assert.deepEqual(
        declared.get(name),
        want,
        `${name} would restyle the placeholder`
      );
    }

    // And the rounded output still tracks the original formula.
    const [c, cb, cs, ca] = EXPECTED.CHART_BAR_HEIGHTS;
    const chart = barHeights(c, cb, cs, ca);
    for (let i = 0; i < c; i++) {
      assert.ok(
        Math.abs(cb + Math.abs(Math.sin(i * cs)) * ca - parseFloat(chart[i])) <
          0.005
      );
    }
  });

  it("freezes the arrays so a caller cannot mutate a shared placeholder", () => {
    assert.match(SRC, /Object\.freeze\(/);
  });
});
