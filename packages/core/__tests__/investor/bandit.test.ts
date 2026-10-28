/**
 * Outcome bandit — pure math checks (MONEY-791, B6).
 *
 * Pins the dependency-free bandit core: the informed Beta prior
 * (`armFromWinRate`), the posterior mean (`betaMean`), variant selection
 * (`selectVariant` — deterministic argmax without an rng, and deterministic
 * epsilon-greedy / Thompson WITH an injected fixed rng), and the pure win-rate
 * aggregation a caller computes from `ResultFeedback` rows
 * (`computeVariantWinRates`). No I/O, no `Math.random` — randomness is injected.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VARIANT_ID,
  EXPLANATION_VARIANTS,
  MAX_PSEUDO_OBSERVATIONS,
  armFromWinRate,
  betaMean,
  computeVariantWinRates,
  priorsFromWinRates,
  sampleBeta,
  selectVariant,
  type BetaArm,
  type OutcomeRow,
  type Rng,
} from "../../src/investor/bandit";

/** A fixed, cycling RNG so any rng-driven path is fully deterministic. */
function fixedRng(values: number[]): Rng {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe("EXPLANATION_VARIANTS", () => {
  it("exposes the concise/detailed/visual framings with the default present", () => {
    const ids = EXPLANATION_VARIANTS.map((v) => v.id);
    assert.deepEqual(ids, ["concise", "detailed", "visual"]);
    assert.ok(
      ids.includes(DEFAULT_VARIANT_ID),
      "default variant is a real arm",
    );
  });
});

describe("armFromWinRate — informed Beta prior", () => {
  it("recovers the uniform Beta(1,1) when there are no impressions", () => {
    const arm = armFromWinRate(0, 0);
    assert.equal(arm.alpha, 1);
    assert.equal(arm.beta, 1);
  });

  it("Beta(1 + w·n, 1 + (1−w)·n) — 7/10 wins ⇒ (8, 4)", () => {
    const arm = armFromWinRate(7, 10);
    assert.equal(arm.alpha, 1 + 0.7 * 10);
    assert.equal(arm.beta, 1 + 0.3 * 10);
    assert.equal(arm.alpha, 8);
    assert.equal(arm.beta, 4);
  });

  it("a higher win-rate yields a higher posterior mean", () => {
    const lo = betaMean(armFromWinRate(2, 10));
    const hi = betaMean(armFromWinRate(8, 10));
    assert.ok(hi > lo, `expected ${hi} > ${lo}`);
  });

  it("more impressions concentrate the prior toward the win-rate", () => {
    const thin = armFromWinRate(8, 10); // mean pulled toward 0.5 by the +1s
    const thick = armFromWinRate(80, 100); // wins capped by impressions, n capped
    // Both encode 80% but the thicker evidence sits closer to 0.8.
    assert.ok(
      Math.abs(betaMean(thick) - 0.8) <= Math.abs(betaMean(thin) - 0.8),
    );
  });

  it("caps pseudo-observations so one arm can't dominate forever", () => {
    const arm = armFromWinRate(10_000, 10_000);
    // n is capped at MAX_PSEUDO_OBSERVATIONS; win-rate is 1 so alpha = 1 + n.
    assert.equal(arm.alpha, 1 + MAX_PSEUDO_OBSERVATIONS);
    assert.equal(arm.beta, 1);
  });

  it("clamps a malformed win-rate (>impressions / NaN) into [0,1]", () => {
    const over = armFromWinRate(20, 10); // ratio 2 → clamp to 1
    assert.equal(over.alpha, 1 + 10);
    assert.equal(over.beta, 1);
    const nan = armFromWinRate(Number.NaN, 10);
    assert.ok(Number.isFinite(nan.alpha) && Number.isFinite(nan.beta));
  });
});

describe("betaMean", () => {
  it("Beta(1,1) mean is 0.5", () => {
    assert.equal(betaMean({ alpha: 1, beta: 1 }), 0.5);
  });

  it("Beta(8,4) mean is 2/3", () => {
    assert.ok(Math.abs(betaMean({ alpha: 8, beta: 4 }) - 2 / 3) < 1e-9);
  });

  it("degenerate (0,0) falls back to 0.5", () => {
    assert.equal(betaMean({ alpha: 0, beta: 0 }), 0.5);
  });
});

describe("computeVariantWinRates — pure aggregation", () => {
  it("buckets UP/DOWN by variantId and computes win-rate", () => {
    const rows: OutcomeRow[] = [
      { variantId: "concise", outcome: "UP" },
      { variantId: "concise", outcome: "UP" },
      { variantId: "concise", outcome: "DOWN" },
      { variantId: "detailed", outcome: "UP" },
      { variantId: "detailed", outcome: "DOWN" },
    ];
    const wr = computeVariantWinRates(rows);
    assert.deepEqual(wr.concise, {
      wins: 2,
      impressions: 3,
      winRate: 2 / 3,
    });
    assert.deepEqual(wr.detailed, { wins: 1, impressions: 2, winRate: 0.5 });
  });

  it("ignores rows with a missing / empty variantId", () => {
    const rows = [
      { variantId: "", outcome: "UP" },
      { variantId: "visual", outcome: "UP" },
    ] as OutcomeRow[];
    const wr = computeVariantWinRates(rows);
    assert.equal(wr[""], undefined);
    assert.deepEqual(wr.visual, { wins: 1, impressions: 1, winRate: 1 });
  });

  it("returns an empty map for no rows", () => {
    // The map is a null-prototype object now (prototype-pollution guard), so
    // assert emptiness by its keys rather than deep-equality with a {} literal.
    assert.deepEqual(Object.keys(computeVariantWinRates([])), []);
  });

  it("does NOT pollute Object.prototype via a malicious variantId (MONEY-779 scan)", () => {
    const wr = computeVariantWinRates([
      { variantId: "__proto__", outcome: "UP" },
      { variantId: "constructor", outcome: "DOWN" },
    ] as OutcomeRow[]);
    // Bucketed as plain OWN keys on the null-prototype map…
    assert.equal(wr["__proto__"]!.wins, 1);
    assert.equal(wr["constructor"]!.impressions, 1);
    // …with NO write leaking onto the real Object.prototype.
    assert.equal(({} as Record<string, unknown>).wins, undefined);
    assert.equal(
      Object.prototype.hasOwnProperty.call(Object.prototype, "wins"),
      false,
    );
  });
});

describe("selectVariant — deterministic argmax (no rng)", () => {
  it("picks the highest posterior-mean arm", () => {
    const priors: Record<string, BetaArm> = {
      concise: armFromWinRate(2, 10), // low
      detailed: armFromWinRate(9, 10), // high
      visual: armFromWinRate(5, 10), // mid
    };
    assert.equal(selectVariant(EXPLANATION_VARIANTS, priors), "detailed");
  });

  it("is stable / reproducible across calls", () => {
    const priors = priorsFromWinRates(
      computeVariantWinRates([
        { variantId: "visual", outcome: "UP" },
        { variantId: "visual", outcome: "UP" },
        { variantId: "concise", outcome: "DOWN" },
      ]),
    );
    const a = selectVariant(EXPLANATION_VARIANTS, priors);
    const b = selectVariant(EXPLANATION_VARIANTS, priors);
    assert.equal(a, b);
    assert.equal(a, "visual");
  });

  it("falls back to the default when given no variants", () => {
    assert.equal(selectVariant([], {}), DEFAULT_VARIANT_ID);
  });

  it("treats an un-prior'd variant as Beta(1,1) (mean 0.5) — still explorable", () => {
    // Only 'concise' has a (weak) prior below 0.5; the other two default to 0.5,
    // so the first 0.5-mean arm in list order ('detailed') wins.
    const priors: Record<string, BetaArm> = { concise: armFromWinRate(1, 10) };
    assert.equal(selectVariant(EXPLANATION_VARIANTS, priors), "detailed");
  });
});

describe("selectVariant — epsilon-greedy with injected rng", () => {
  const priors: Record<string, BetaArm> = {
    concise: armFromWinRate(1, 10),
    detailed: armFromWinRate(9, 10), // best mean
    visual: armFromWinRate(5, 10),
  };

  it("EXPLOITS the best arm when rng() ≥ epsilon", () => {
    // First rng() drives the explore/exploit coin: 0.9 ≥ 0.1 ⇒ exploit.
    const id = selectVariant(EXPLANATION_VARIANTS, priors, {
      rng: fixedRng([0.9]),
      strategy: "epsilon-greedy",
      epsilon: 0.1,
    });
    assert.equal(id, "detailed");
  });

  it("EXPLORES a random arm when rng() < epsilon", () => {
    // coin = 0.05 < 0.1 ⇒ explore; second rng = 0.0 ⇒ index 0 = 'concise'.
    const id = selectVariant(EXPLANATION_VARIANTS, priors, {
      rng: fixedRng([0.05, 0.0]),
      strategy: "epsilon-greedy",
      epsilon: 0.1,
    });
    assert.equal(id, "concise");
  });

  it("EXPLORE index lands on the last arm when rng → ~1", () => {
    const id = selectVariant(EXPLANATION_VARIANTS, priors, {
      rng: fixedRng([0.0, 0.99]),
      strategy: "epsilon-greedy",
      epsilon: 1, // always explore
    });
    assert.equal(id, "visual"); // floor(0.99 * 3) = 2 → 'visual'
  });
});

describe("selectVariant — Thompson with injected rng", () => {
  it("is deterministic given a fixed rng and returns a real variant id", () => {
    const priors: Record<string, BetaArm> = {
      concise: armFromWinRate(2, 20),
      detailed: armFromWinRate(18, 20),
      visual: armFromWinRate(10, 20),
    };
    const rng = fixedRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    const a = selectVariant(EXPLANATION_VARIANTS, priors, {
      rng,
      strategy: "thompson",
    });
    const rng2 = fixedRng([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    const b = selectVariant(EXPLANATION_VARIANTS, priors, {
      rng: rng2,
      strategy: "thompson",
    });
    assert.equal(a, b, "same rng ⇒ same pick");
    assert.ok(
      EXPLANATION_VARIANTS.some((v) => v.id === a),
      "picks a real variant",
    );
  });
});

describe("sampleBeta — bounded, deterministic", () => {
  it("returns a value in [0,1] given a fixed rng", () => {
    const rng = fixedRng([0.3, 0.7, 0.2, 0.9, 0.4, 0.6]);
    const x = sampleBeta({ alpha: 5, beta: 2 }, rng);
    assert.ok(x >= 0 && x <= 1, `expected [0,1], got ${x}`);
  });
});

describe("priorsFromWinRates", () => {
  it("maps each variant's win-rate into an informed Beta arm", () => {
    const priors = priorsFromWinRates({
      concise: { wins: 7, impressions: 10, winRate: 0.7 },
    });
    assert.deepEqual(priors.concise, { alpha: 8, beta: 4 });
  });
});

describe("armFromWinRate — hostile impressions are NaN-safe", () => {
  it("NaN / ±Infinity / negative impressions collapse to the uniform prior", () => {
    for (const imp of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -10,
    ]) {
      const arm = armFromWinRate(5, imp);
      assert.ok(
        Number.isFinite(arm.alpha) && Number.isFinite(arm.beta),
        `non-finite arm for impressions=${imp}`,
      );
      assert.deepEqual(arm, { alpha: 1, beta: 1 }, `impressions=${imp}`);
    }
  });

  it("betaMean is always finite for an arm built from any (wins, impressions)", () => {
    for (const [w, n] of [
      [Number.NaN, 10],
      [10, Number.NaN],
      [-5, 10],
      [10, -5],
      [1e9, 1e9],
    ] as Array<[number, number]>) {
      const m = betaMean(armFromWinRate(w, n));
      assert.ok(
        Number.isFinite(m) && m >= 0 && m <= 1,
        `m=${m} for (${w},${n})`,
      );
    }
  });
});

describe("betaMean — correctness vs closed form", () => {
  it("matches α/(α+β) across a sweep", () => {
    for (const [a, b] of [
      [1, 1],
      [2, 8],
      [9, 1],
      [41, 1],
      [3.5, 6.5],
    ] as Array<[number, number]>) {
      assert.ok(
        Math.abs(betaMean({ alpha: a, beta: b }) - a / (a + b)) < 1e-12,
      );
    }
  });
});

describe("selectVariant — determinism + hostile-arm safety", () => {
  function fixed(values: number[]): Rng {
    let i = 0;
    return () => values[i++ % values.length]!;
  }

  it("is fully deterministic under a fixed rng (epsilon-greedy)", () => {
    const priors: Record<string, BetaArm> = {
      concise: armFromWinRate(1, 10),
      detailed: armFromWinRate(9, 10),
      visual: armFromWinRate(5, 10),
    };
    const seq = [0.05, 0.7, 0.9, 0.2, 0.05, 0.99];
    const run = () =>
      Array.from({ length: 6 }, () =>
        selectVariant(EXPLANATION_VARIANTS, priors, {
          rng: fixed(seq),
          strategy: "epsilon-greedy",
          epsilon: 0.1,
        }),
      );
    assert.deepEqual(run(), run(), "same seed ⇒ identical sequence");
  });

  it("never throws and returns a real variant when an arm prior is NaN", () => {
    const priors: Record<string, BetaArm> = {
      concise: { alpha: Number.NaN, beta: Number.NaN },
      detailed: { alpha: 1, beta: 1 },
      visual: { alpha: 1, beta: 1 },
    };
    const ids = EXPLANATION_VARIANTS.map((v) => v.id);
    const argmax = selectVariant(EXPLANATION_VARIANTS, priors);
    assert.ok(ids.includes(argmax), `argmax not a real variant: ${argmax}`);
    const thompson = selectVariant(EXPLANATION_VARIANTS, priors, {
      rng: fixed([0.3, 0.6, 0.1, 0.9, 0.5, 0.2]),
      strategy: "thompson",
    });
    assert.ok(
      ids.includes(thompson),
      `thompson not a real variant: ${thompson}`,
    );
  });

  it("a pathological rng (always 0) cannot hang sampleBeta and stays in [0,1]", () => {
    const x = sampleBeta({ alpha: 0.5, beta: 3 }, () => 0);
    assert.ok(x >= 0 && x <= 1, `sampleBeta out of band: ${x}`);
  });
});
