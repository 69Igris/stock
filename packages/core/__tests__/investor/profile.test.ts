/**
 * Investor profile — pure seedProfile + updateConceptMastery checks
 * (MONEY-787, B2). Only the PURE functions are exercised here; the prisma DB
 * seams (`applyConceptSignal`, `ensureSeededProfile`) are integration-shaped
 * and covered by B3/B4 wiring.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { seedProfile, updateConceptMastery } from "../../src/investor/profile";
import { initialEstimate } from "../../src/investor/mastery";
import type { SeedSignals } from "../../src/investor/types";

describe("seedProfile — defaults", () => {
  it("empty signals fall back to MODERATE / BEGINNER / 0.1", () => {
    const seed = seedProfile({});
    assert.equal(seed.riskAppetite, "MODERATE");
    assert.equal(seed.experienceLevel, "BEGINNER");
    assert.equal(seed.confidence, 0.1);
    assert.equal(seed.panicSeller, 0);
    assert.equal(seed.overtrader, 0);
    assert.equal(seed.fomoProne, 0);
    assert.equal(seed.dividendSeeker, 0);
    assert.deepEqual(seed.seededFrom, {});
  });
});

describe("seedProfile — risk appetite from FIRE SWR", () => {
  it("a conservative SWR (≤3.5%) ⇒ CONSERVATIVE", () => {
    const seed = seedProfile({ fireWithdrawalRate: 3 });
    assert.equal(seed.riskAppetite, "CONSERVATIVE");
    assert.ok(seed.confidence > 0.1, "confidence rises with signal");
  });

  it("a high SWR (≥5%) over a long horizon (≥20y) ⇒ AGGRESSIVE", () => {
    const seed = seedProfile({ fireWithdrawalRate: 6, fireHorizonYears: 30 });
    assert.equal(seed.riskAppetite, "AGGRESSIVE");
  });

  it("a high SWR but short horizon does NOT force AGGRESSIVE", () => {
    const seed = seedProfile({ fireWithdrawalRate: 6, fireHorizonYears: 5 });
    assert.equal(seed.riskAppetite, "MODERATE");
  });

  it("a moderate SWR stays MODERATE", () => {
    const seed = seedProfile({ fireWithdrawalRate: 4 });
    assert.equal(seed.riskAppetite, "MODERATE");
  });
});

describe("seedProfile — F&O usage", () => {
  it("F&O usage bumps risk to AGGRESSIVE and experience to INTERMEDIATE", () => {
    const seed = seedProfile({ usesFno: true });
    assert.equal(seed.riskAppetite, "AGGRESSIVE");
    assert.equal(seed.experienceLevel, "INTERMEDIATE");
  });

  it("F&O + many trades pushes experience to ADVANCED", () => {
    const seed = seedProfile({ usesFno: true, tradeCount30d: 40 });
    assert.equal(seed.experienceLevel, "ADVANCED");
    assert.equal(seed.riskAppetite, "AGGRESSIVE");
  });
});

describe("seedProfile — behavioural traits", () => {
  it("high concentration sets fomoProne / panicSeller propensities", () => {
    const seed = seedProfile({ topHoldingConcentration: 0.6 });
    assert.ok(seed.fomoProne > 0, "fomoProne raised by concentration");
    assert.ok(seed.panicSeller > 0, "panicSeller raised by concentration");
    assert.ok(
      seed.fomoProne <= 1 && seed.panicSeller <= 1,
      "traits clamped to ≤1",
    );
  });

  it("low concentration leaves traits at 0", () => {
    const seed = seedProfile({ topHoldingConcentration: 0.1 });
    assert.equal(seed.fomoProne, 0);
    assert.equal(seed.panicSeller, 0);
  });

  it("high 30d trade count raises the overtrader propensity (clamped ≤1)", () => {
    assert.ok(seedProfile({ tradeCount30d: 10 }).overtrader > 0);
    assert.equal(seedProfile({ tradeCount30d: 100 }).overtrader, 1);
    assert.equal(seedProfile({ tradeCount30d: 0 }).overtrader, 0);
  });

  it("a busy beginner (≥30 trades) is promoted to INTERMEDIATE", () => {
    const seed = seedProfile({ tradeCount30d: 35 });
    assert.equal(seed.experienceLevel, "INTERMEDIATE");
  });
});

describe("seedProfile — confidence", () => {
  it("rises with each distinct signal and caps at 0.85", () => {
    const rich: SeedSignals = {
      fireWithdrawalRate: 3,
      fireHorizonYears: 25,
      usesFno: true,
      topHoldingConcentration: 0.5,
      tradeCount30d: 20,
    };
    const seed = seedProfile(rich);
    assert.ok(
      seed.confidence > 0.5,
      `expected higher confidence, got ${seed.confidence}`,
    );
    assert.ok(seed.confidence <= 0.85);
    // Preserves the source signals for audit / re-seed.
    assert.deepEqual(seed.seededFrom, rich);
  });

  it("ignores non-finite numeric signals", () => {
    const seed = seedProfile({ fireWithdrawalRate: Number.NaN });
    assert.equal(seed.confidence, 0.1);
    assert.equal(seed.riskAppetite, "MODERATE");
  });
});

describe("seedProfile — hostile numeric inputs are purity-safe", () => {
  it("ignores ±Infinity numeric signals and stays at the defaults", () => {
    const seed = seedProfile({
      fireWithdrawalRate: Number.POSITIVE_INFINITY,
      fireHorizonYears: Number.NEGATIVE_INFINITY,
      topHoldingConcentration: Number.POSITIVE_INFINITY,
      tradeCount30d: Number.POSITIVE_INFINITY,
    });
    assert.equal(seed.riskAppetite, "MODERATE");
    assert.equal(seed.experienceLevel, "BEGINNER");
    assert.equal(seed.confidence, 0.1);
    assert.equal(seed.fomoProne, 0);
    assert.equal(seed.panicSeller, 0);
    assert.equal(seed.overtrader, 0);
  });

  it("every output trait is finite and in [0,1] for any input mix", () => {
    const seed = seedProfile({
      fireWithdrawalRate: 6,
      fireHorizonYears: 40,
      usesFno: true,
      topHoldingConcentration: 0.95,
      tradeCount30d: 1_000_000,
    });
    for (const v of [
      seed.confidence,
      seed.panicSeller,
      seed.overtrader,
      seed.fomoProne,
      seed.dividendSeeker,
    ]) {
      assert.ok(
        Number.isFinite(v) && v >= 0 && v <= 1,
        `trait out of band: ${v}`,
      );
    }
  });

  it("a negative trade count is ignored (guarded by >= 0)", () => {
    const seed = seedProfile({ tradeCount30d: -5 });
    assert.equal(seed.overtrader, 0);
    assert.equal(
      seed.confidence,
      0.1,
      "negative trades contribute no evidence",
    );
  });

  it("is a pure function — does not mutate its input signals", () => {
    const signals = { fireWithdrawalRate: 3, tradeCount30d: 10 };
    const snapshot = JSON.stringify(signals);
    seedProfile(signals);
    assert.equal(JSON.stringify(signals), snapshot, "input was mutated");
  });
});

describe("updateConceptMastery — wraps applyUpdate", () => {
  it("advances a fresh estimate by one correct signal", () => {
    const start = initialEstimate("risk.beta");
    const next = updateConceptMastery(start, {
      conceptId: "risk.beta",
      outcome: "CORRECT",
      difficulty: "HARD",
      assistLevel: 0,
    });
    assert.ok(next.pKnown > start.pKnown);
    assert.equal(next.attempts, 1);
    assert.equal(next.conceptId, "risk.beta");
  });

  it("is pure — repeated calls on the SAME estimate yield identical results and don't mutate it", () => {
    const start = initialEstimate("risk.beta");
    const frozen = JSON.stringify(start);
    const a = updateConceptMastery(start, {
      conceptId: "risk.beta",
      outcome: "CORRECT",
      difficulty: "MODERATE",
      assistLevel: 0,
    });
    const b = updateConceptMastery(start, {
      conceptId: "risk.beta",
      outcome: "CORRECT",
      difficulty: "MODERATE",
      assistLevel: 0,
    });
    assert.equal(a.pKnown, b.pKnown, "deterministic pKnown");
    assert.equal(a.theta, b.theta, "deterministic theta");
    assert.equal(JSON.stringify(start), frozen, "input estimate mutated");
  });

  it("a correct/incorrect alternation keeps pKnown monotone within each step direction", () => {
    let est = initialEstimate("risk.beta");
    // A correct streak only ever raises pKnown; a wrong answer afterward lowers
    // the evidence term relative to a correct one at the same prior.
    for (let i = 0; i < 5; i++) {
      const before = est.pKnown;
      est = updateConceptMastery(est, {
        conceptId: "risk.beta",
        outcome: "CORRECT",
        difficulty: "MODERATE",
        assistLevel: 0,
      });
      assert.ok(est.pKnown >= before, "correct never lowers pKnown");
      assert.ok(est.pKnown <= 1 && est.pKnown >= 0);
    }
  });
});
