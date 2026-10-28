/**
 * The v1-vs-v2 parity gate — MONEY-1499 (B8), executing B0 §6.
 *
 * The cases that matter are the ones where a LOOSER gate would have passed:
 * an empty run, a v2 that returns fewer rows, and a latency comparison with
 * nothing on one side.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LATENCY_TOLERANCE,
  PARITY_MAX_MISSING_PER_QUERY,
  PARITY_MIN_OVERLAP,
  perQueryFloor,
  judgeParity,
  overlapAt,
  percentile,
  type QueryResult,
} from "../../src/ops/embeddings-parity-logic";

const ids = (n: number, from = 0): string[] =>
  Array.from({ length: n }, (_, i) => `d${i + from}`);

function results(
  n: number,
  mut: (i: number) => Partial<QueryResult> = () => ({}),
): QueryResult[] {
  return Array.from({ length: n }, (_, i) => ({
    query: `q${i}`,
    v1: ids(6),
    v2: ids(6),
    v1Ms: 100,
    v2Ms: 90,
    ...mut(i),
  }));
}

describe("overlapAt", () => {
  it("is 1 for identical top-K and 0 for disjoint", () => {
    assert.equal(overlapAt(6, ids(6), ids(6)), 1);
    assert.equal(overlapAt(6, ids(6), ids(6, 100)), 0);
  });

  it("ignores ORDER within the top-K — int8 shuffles near-ties by a place", () => {
    assert.equal(overlapAt(6, ids(6), [...ids(6)].reverse()), 1);
  });

  it("divides by K, so a SHORTER v2 is penalised", () => {
    // Dividing by the smaller set would score a collapsed v2 that returns one
    // row v1 also had as PERFECT parity.
    assert.equal(overlapAt(6, ids(6), ["d0"]), 1 / 6);
  });

  it("only looks at the top K of each side", () => {
    assert.equal(overlapAt(2, ids(6), ["d4", "d5", "d0", "d1"]), 0);
  });

  it("returns 0 for a non-positive K rather than dividing by zero", () => {
    assert.equal(overlapAt(0, ids(6), ids(6)), 0);
  });
});

describe("percentile", () => {
  it("is nearest-rank", () => {
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
    assert.equal(percentile([7], 0.95), 7);
  });

  it("is NaN on an empty set, never 0 — 0 would read as instant", () => {
    assert.ok(Number.isNaN(percentile([], 0.95)));
  });
});

describe("judgeParity", () => {
  it("passes a clean run", () => {
    const v = judgeParity(results(50), { k: 6, minQueries: 50 });
    assert.equal(v.pass, true, v.reasons.join("; "));
    assert.equal(v.meanOverlap, 1);
    assert.ok(
      v.latencyRatio < 1,
      "v2 is expected to be FASTER, not merely tolerable",
    );
  });

  it("REFUSES an empty run instead of passing it", () => {
    const v = judgeParity([], { k: 6, minQueries: 50 });
    assert.equal(v.pass, false);
    assert.match(v.reasons.join(" "), /must never read as a pass/);
  });

  it("refuses a run that is short of the fixed query set", () => {
    const v = judgeParity(results(49), { k: 6, minQueries: 50 });
    assert.equal(v.pass, false);
    assert.match(v.reasons.join(" "), /49 of 50/);
  });

  it("fails below the 0.9 mean-overlap floor and NAMES the queries", () => {
    // Half the queries return a completely different top-6.
    const v = judgeParity(
      results(50, (i) => (i % 2 === 0 ? { v2: ids(6, 900) } : {})),
      { k: 6, minQueries: 50 },
    );
    assert.equal(v.pass, false);
    assert.ok(v.meanOverlap < PARITY_MIN_OVERLAP);
    assert.equal(v.belowThreshold.length, 25);
    assert.equal(v.worstOverlap, 0);
  });

  /**
   * MONEY-1499 review, F4 — the case the mean rung CANNOT catch.
   *
   * 45 queries at 1.0 and 5 at 0.0 is a mean of exactly 0.900, and the mean
   * rung reads `< 0.9`, so it does not fire. Before F4, `belowThreshold` was
   * computed, printed, and never entered the verdict: this run PASSED with
   * five research queries returning an entirely different document set.
   */
  it("REGRESSION: fails a TAIL that an exactly-0.900 mean conceals", () => {
    const v = judgeParity(
      results(50, (i) => (i < 5 ? { v2: ids(6, 900) } : {})),
      { k: 6, minQueries: 50 },
    );
    assert.equal(
      v.meanOverlap,
      PARITY_MIN_OVERLAP,
      "the mean rung must NOT be what fires here",
    );
    assert.equal(v.pass, false);
    assert.equal(v.belowThreshold.length, 5);
    assert.match(v.reasons.join(" "), /5 of 50 queries lost more than 1/);
    // The reason names the offenders — a count alone cannot be triaged.
    assert.match(v.reasons.join(" "), /q0 \| q1 \| q2 \| q3 \| q4/);
  });

  /**
   * THE OTHER HALF, and it is what keeps the mean rung from being dead code.
   *
   * Every query loses exactly one of six — inside the per-query floor, so that
   * rung stays silent — and the mean is 0.833, which only the mean rung can
   * see. The review found the mean rung was unreachable once the per-query
   * rung reused the same threshold; these two cases pin one rung each.
   */
  it("REGRESSION: the MEAN rung fires when no single query breaches the floor", () => {
    const v = judgeParity(
      results(50, () => ({ v2: [...ids(5), "d900"] })),
      { k: 6, minQueries: 50 },
    );
    assert.equal(
      v.belowThreshold.length,
      0,
      "the per-query rung must NOT be what fires here",
    );
    assert.equal(v.pass, false);
    assert.match(
      v.reasons.join(" "),
      /mean top-6 overlap 0\.833 is below 0\.9/,
    );
  });

  /**
   * MONEY-1499 review — 0.9 IS NOT EXPRESSIBLE ON A 6-POINT GRID.
   *
   * `overlapAt` returns hit/k, so at the shipped topK 6 the achievable values
   * are {0, .167, .333, .5, .667, .833, 1}. Reusing PARITY_MIN_OVERLAP as the
   * per-query floor made 1.0 the ONLY passing value — the gate demanded a
   * byte-identical top-6 on all fifty queries, which `overlapAt`'s own
   * docblock says will not happen ("int8 ... shuffle by a place or two on
   * near-ties"), and which re-running could not fix.
   */
  it("REGRESSION: one displaced document out of six PASSES the per-query rung", () => {
    const v = judgeParity(
      results(50, (i) => (i === 0 ? { v2: [...ids(5), "d900"] } : {})),
      { k: 6, minQueries: 50 },
    );
    assert.equal(v.worstOverlap, 5 / 6);
    assert.equal(v.belowThreshold.length, 0);
    assert.equal(v.pass, true, v.reasons.join("; "));
  });

  it("two displaced documents out of six do NOT", () => {
    const v = judgeParity(
      results(50, (i) => (i === 0 ? { v2: [...ids(4), "d900", "d901"] } : {})),
      { k: 6, minQueries: 50 },
    );
    assert.equal(v.worstOverlap, 4 / 6);
    assert.equal(v.belowThreshold.length, 1);
    assert.equal(v.pass, false);
  });

  it("the per-query floor is stated in DOCUMENTS and lands on the grid", () => {
    // The property the constant exists for: whatever k is, the floor is a
    // value `hit / k` can actually take, so it can never be unsatisfiable.
    for (const k of [1, 3, 6, 10, 12]) {
      const floor = perQueryFloor(k);
      assert.equal(floor, (k - PARITY_MAX_MISSING_PER_QUERY) / k);
      assert.ok(
        Number.isInteger(floor * k),
        `floor ${floor} is not reachable at k=${k}`,
      );
    }
    assert.equal(perQueryFloor(0), 0);
  });

  it("truncates the named queries rather than printing fifty", () => {
    const v = judgeParity(
      results(50, () => ({ v2: ids(6, 900) })),
      { k: 6, minQueries: 50 },
    );
    assert.equal(v.belowThreshold.length, 50);
    assert.match(v.reasons.join(" "), /q4 …/);
  });

  it("fails a real latency regression but tolerates ordinary variance", () => {
    const tolerable = judgeParity(
      results(50, () => ({ v2Ms: 105 })),
      {
        k: 6,
        minQueries: 50,
      },
    );
    assert.equal(tolerable.pass, true, tolerable.reasons.join("; "));

    const regressed = judgeParity(
      results(50, () => ({ v2Ms: 300 })),
      {
        k: 6,
        minQueries: 50,
      },
    );
    assert.equal(regressed.pass, false);
    assert.match(regressed.reasons.join(" "), /inside a chat turn/);
    assert.ok(regressed.latencyRatio > LATENCY_TOLERANCE);
  });

  it("refuses rather than passes when v1 latency is unmeasurable", () => {
    // A ratio against zero is Infinity or NaN; either way it must not be a
    // silent pass, because "no baseline" is exactly when a regression hides.
    const v = judgeParity(
      results(50, () => ({ v1Ms: 0 })),
      { k: 6, minQueries: 50 },
    );
    assert.equal(v.pass, false);
    assert.match(v.reasons.join(" "), /unmeasured/);
  });
});
