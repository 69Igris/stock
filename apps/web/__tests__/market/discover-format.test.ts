/**
 * MONEY-1255 — the discover grid's compact market-cap ladder.
 *
 * This was the THIRD copy of the same two defects (after the stock page's
 * `formatMarketCap` and the peers table's `fmtMcap`), and the one a sibling
 * sweep found rather than a bug report — which is the point of sweeping: these
 * travel in packs.
 *
 *   1. The `B` rung divided by 1e10 while labelling "B" → every B-figure ten
 *      times low. Hawkins Cookers' ₹4,300 Cr printed `₹4B`.
 *   2. Two `T` rungs with different divisors → the ladder was NON-MONOTONIC.
 *      Crossing ₹10 trillion made the number DROP from `₹9.9T` to `₹1.0T`.
 *
 * The monotonicity sweep below is the assertion that matters. A table of
 * expected literals only catches the values someone thought to write down; a
 * defect planted in a band nobody sampled survives it. Monotonicity is a
 * property of the WHOLE ladder and cannot be satisfied by a broken rung.
 *
 * Source: apps/web/app/discover/discover-format.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatMarketCap, formatVolume } from "@/app/discover/discover-format";

/** Parse "₹43B" / "₹17.5T" / "₹4300Cr" back into rupees. */
function toRupees(rendered: string): number {
  const m = rendered.match(/^₹([\d.]+)(T|B|Cr)$/);
  assert.ok(m, `unparseable render: ${rendered}`);
  const n = Number(m[1]);
  if (m[2] === "T") return n * 1e12;
  if (m[2] === "B") return n * 1e9;
  return n * 1e7;
}

describe("discover formatMarketCap", () => {
  it("renders real Indian market caps at the right magnitude", () => {
    // Hawkins Cookers: ~₹4,300 crore. This is the case that printed "₹4B".
    assert.strictEqual(formatMarketCap(43e9), "₹43B");
    // Reliance: ₹17.5 lakh crore. This printed "₹1.8T".
    assert.strictEqual(formatMarketCap(17.5e12), "₹17.5T");
    // A small cap stays in crores.
    assert.strictEqual(formatMarketCap(5e9), "₹500Cr");
  });

  it("is MONOTONIC across the whole range — the T-tier class", () => {
    // Dense enough to land inside every rung and straddle every boundary,
    // including bands no literal above asserts.
    const samples: number[] = [];
    for (let e = 6; e <= 14; e += 1) {
      for (const m of [1, 1.5, 2, 3, 5, 7, 9, 9.9, 9.99]) {
        samples.push(m * 10 ** e);
      }
    }
    samples.sort((a, b) => a - b);

    let prevInput = -Infinity;
    let prevShown = -Infinity;
    for (const input of samples) {
      const shown = toRupees(formatMarketCap(input));
      if (input > prevInput) {
        assert.ok(
          shown >= prevShown,
          `NON-MONOTONIC: ${input} renders ${formatMarketCap(input)} ` +
            `(=${shown}) but the smaller ${prevInput} rendered ` +
            `${formatMarketCap(prevInput)} (=${prevShown})`
        );
      }
      prevInput = input;
      prevShown = shown;
    }
  });

  it("renders within 10% of the true value at every sample", () => {
    // Monotonicity alone would tolerate a ladder that is uniformly 10x low.
    // This pins the MAGNITUDE; together they pin the ladder.
    for (let e = 8; e <= 14; e += 1) {
      for (const m of [1, 2.5, 6, 9.9]) {
        const input = m * 10 ** e;
        const shown = toRupees(formatMarketCap(input));
        const relErr = Math.abs(shown - input) / input;
        assert.ok(
          relErr < 0.1,
          `${input} renders ${formatMarketCap(input)} (=${shown}), ` +
            `off by ${(relErr * 100).toFixed(1)}%`
        );
      }
    }
  });

  it("crosses the ₹10 trillion cliff without dropping", () => {
    assert.strictEqual(formatMarketCap(9.9e12), "₹9.9T");
    assert.strictEqual(formatMarketCap(10.1e12), "₹10.1T");
  });

  it("returns a dash for absent and non-finite values, never a number", () => {
    for (const bad of [null, undefined, 0, NaN, Infinity, -Infinity]) {
      assert.strictEqual(
        formatMarketCap(bad as number | null),
        "-",
        `${String(bad)} must render as a dash`
      );
    }
  });
});

describe("discover formatVolume", () => {
  it("renders Indian volume units", () => {
    assert.strictEqual(formatVolume(15_000_000), "1.5Cr");
    assert.strictEqual(formatVolume(250_000), "2.5L");
    assert.strictEqual(formatVolume(4_010), "4.0K");
    assert.strictEqual(formatVolume(412), "412");
  });

  it("returns a dash for absent and non-finite values", () => {
    for (const bad of [null, undefined, 0, NaN, Infinity]) {
      assert.strictEqual(formatVolume(bad as number | null), "-");
    }
  });
});
