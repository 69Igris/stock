/**
 * Mastery model — BKT/IRT correctness checks (MONEY-787, B2).
 *
 * These pin the pure dual-engine math: BKT monotonicity (a correct answer
 * raises P(known), a wrong one lowers it), IRT theta stays in ±4, the level
 * thresholds bucket exactly, and the glow follows the smoothstep curve.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BKT_PARAMS,
  MASTERY_THRESHOLDS,
  applyUpdate,
  clamp01,
  difficultyToIrtB,
  glowFromMastery,
  initialEstimate,
  isCorrectOutcome,
  masteryLevelFromPKnown,
  updateBKT,
  updateIRT,
  type IrtItem,
} from "../../src/investor/mastery";
import type {
  MasteryEstimate,
  MasteryUpdateInput,
} from "../../src/investor/types";

describe("clamp01", () => {
  it("clamps below 0 and above 1, passes through in-range", () => {
    assert.equal(clamp01(-0.5), 0);
    assert.equal(clamp01(1.5), 1);
    assert.equal(clamp01(0.42), 0.42);
  });
});

describe("updateBKT — monotonicity", () => {
  it("a correct observation raises P(known)", () => {
    const prior = 0.3;
    const next = updateBKT(prior, true);
    assert.ok(next > prior, `expected >${prior}, got ${next}`);
  });

  it("a wrong observation lowers the evidence term vs correct", () => {
    const prior = 0.6;
    const afterCorrect = updateBKT(prior, true);
    const afterWrong = updateBKT(prior, false);
    assert.ok(
      afterWrong < afterCorrect,
      `wrong (${afterWrong}) should be < correct (${afterCorrect})`,
    );
  });

  it("repeated correct answers converge upward toward (but never past) 1", () => {
    let p = 0.1;
    let prev = -1;
    for (let i = 0; i < 30; i++) {
      const next = updateBKT(p, true);
      assert.ok(next >= prev, "monotonic non-decreasing");
      assert.ok(next <= 1, "never exceeds 1");
      prev = next;
      p = next;
    }
    assert.ok(p > 0.95, `expected high convergence, got ${p}`);
  });

  it("stays within [0,1] for extreme priors", () => {
    for (const prior of [-1, 0, 0.5, 1, 2]) {
      assert.ok(updateBKT(prior, true) >= 0 && updateBKT(prior, true) <= 1);
      assert.ok(updateBKT(prior, false) >= 0 && updateBKT(prior, false) <= 1);
    }
  });
});

describe("updateIRT — clamp ±4 and surprise direction", () => {
  const item: IrtItem = { difficulty: 0 };

  it("a correct answer nudges theta up, a wrong one nudges it down", () => {
    assert.ok(updateIRT(0, item, true) > 0);
    assert.ok(updateIRT(0, item, false) < 0);
  });

  it("a correct answer on a HARD item lifts more than on an EASY item", () => {
    const easy: IrtItem = { difficulty: difficultyToIrtB("EASY") };
    const hard: IrtItem = { difficulty: difficultyToIrtB("HARD") };
    const liftEasy = updateIRT(0, easy, true);
    const liftHard = updateIRT(0, hard, true);
    assert.ok(
      liftHard > liftEasy,
      `hard ${liftHard} should beat easy ${liftEasy}`,
    );
  });

  it("never escapes the ±4 logit band even under a long correct streak", () => {
    let theta = 0;
    for (let i = 0; i < 200; i++)
      theta = updateIRT(theta, { difficulty: 3 }, true);
    assert.ok(theta <= 4, `theta ${theta} exceeded +4`);
    let down = 0;
    for (let i = 0; i < 200; i++)
      down = updateIRT(down, { difficulty: -3 }, false);
    assert.ok(down >= -4, `theta ${down} fell below -4`);
  });
});

describe("difficultyToIrtB", () => {
  it("maps the five-step scale to symmetric logit b values", () => {
    assert.equal(difficultyToIrtB("TRIVIAL"), -1.5);
    assert.equal(difficultyToIrtB("EASY"), -0.75);
    assert.equal(difficultyToIrtB("MODERATE"), 0);
    assert.equal(difficultyToIrtB("HARD"), 0.75);
    assert.equal(difficultyToIrtB("EXPERT"), 1.5);
  });
});

describe("masteryLevelFromPKnown — thresholds", () => {
  it("buckets at the exact threshold boundaries", () => {
    assert.equal(masteryLevelFromPKnown(0), "NEW");
    assert.equal(
      masteryLevelFromPKnown(MASTERY_THRESHOLDS.LEARNING - 0.001),
      "NEW",
    );
    assert.equal(
      masteryLevelFromPKnown(MASTERY_THRESHOLDS.LEARNING),
      "LEARNING",
    );
    assert.equal(
      masteryLevelFromPKnown(MASTERY_THRESHOLDS.PRACTICING),
      "PRACTICING",
    );
    assert.equal(
      masteryLevelFromPKnown(MASTERY_THRESHOLDS.PROFICIENT),
      "PROFICIENT",
    );
    assert.equal(
      masteryLevelFromPKnown(MASTERY_THRESHOLDS.MASTERED),
      "MASTERED",
    );
    assert.equal(masteryLevelFromPKnown(1), "MASTERED");
  });
});

describe("glowFromMastery — smoothstep p²(3-2p)", () => {
  it("matches the smoothstep formula and anchors at 0/0.5/1", () => {
    assert.equal(glowFromMastery(0), 0);
    assert.equal(glowFromMastery(1), 1);
    assert.equal(glowFromMastery(0.5), 0.5); // 0.25 * (3 - 1) = 0.5
    const p = 0.3;
    assert.ok(Math.abs(glowFromMastery(p) - p * p * (3 - 2 * p)) < 1e-12);
  });

  it("is monotonic increasing on [0,1]", () => {
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const g = glowFromMastery(p);
      assert.ok(g >= prev, `glow not monotonic at p=${p}`);
      prev = g;
    }
  });
});

describe("isCorrectOutcome", () => {
  it("CORRECT and PARTIAL are positive; INCORRECT and NEUTRAL are not", () => {
    assert.equal(isCorrectOutcome("CORRECT"), true);
    assert.equal(isCorrectOutcome("PARTIAL"), true);
    assert.equal(isCorrectOutcome("INCORRECT"), false);
    assert.equal(isCorrectOutcome("NEUTRAL"), false);
  });
});

describe("applyUpdate — transitions", () => {
  const base = (): MasteryEstimate => initialEstimate("valuation.pe-ratio");

  const sig = (outcome: MasteryUpdateInput["outcome"]): MasteryUpdateInput => ({
    conceptId: "valuation.pe-ratio",
    outcome,
    difficulty: "MODERATE",
    assistLevel: 0,
  });

  it("CORRECT raises pKnown/glow, bumps attempts, sets lastSeenAt", () => {
    const next = applyUpdate(base(), sig("CORRECT"));
    assert.ok(next.pKnown > 0.1);
    assert.ok(next.glow >= 0 && next.glow <= 1);
    assert.equal(next.attempts, 1);
    assert.ok(next.lastSeenAt instanceof Date);
    assert.equal(next.conceptId, "valuation.pe-ratio");
  });

  it("PARTIAL gains less than CORRECT but more than INCORRECT", () => {
    const partial = applyUpdate(base(), sig("PARTIAL")).pKnown;
    const correct = applyUpdate(base(), sig("CORRECT")).pKnown;
    const incorrect = applyUpdate(base(), sig("INCORRECT")).pKnown;
    assert.ok(partial < correct, "partial < correct");
    assert.ok(partial > incorrect, "partial > incorrect");
  });

  it("NEUTRAL only nudges pKnown up slightly, leaves theta untouched, counts an attempt", () => {
    const start = base();
    const next = applyUpdate(start, sig("NEUTRAL"));
    assert.equal(
      next.theta,
      start.theta,
      "theta unchanged on neutral exposure",
    );
    assert.ok(next.pKnown > start.pKnown, "tiny positive nudge");
    assert.ok(
      next.pKnown < applyUpdate(start, sig("CORRECT")).pKnown,
      "neutral nudge is smaller than a correct gain",
    );
    assert.equal(next.attempts, 1);
    assert.ok(next.lastSeenAt instanceof Date);
  });

  it("high assistLevel softens a correct (lower pKnown than no assist)", () => {
    const noAssist = applyUpdate(base(), {
      ...sig("CORRECT"),
      assistLevel: 0,
    }).pKnown;
    const heavyAssist = applyUpdate(base(), {
      ...sig("CORRECT"),
      assistLevel: 0.3,
    }).pKnown;
    assert.ok(
      heavyAssist < noAssist,
      `assist ${heavyAssist} should be < ${noAssist}`,
    );
  });
});

describe("clamp01 — non-finite hardening", () => {
  it("collapses every non-finite input (NaN, ±Infinity) to 0", () => {
    // A corrupt non-finite probability must never read as "fully known" — the
    // safe collapse is 0, not 1.
    assert.equal(clamp01(Number.NaN), 0);
    assert.equal(clamp01(Number.POSITIVE_INFINITY), 0);
    assert.equal(clamp01(Number.NEGATIVE_INFINITY), 0);
    // Sanity: the well-behaved cases are unchanged.
    assert.equal(clamp01(0), 0);
    assert.equal(clamp01(1), 1);
    assert.equal(clamp01(0.42), 0.42);
  });
});

describe("mastery math — hostile / corrupt inputs never produce NaN", () => {
  it("updateBKT clamps a NaN prior to a finite [0,1]", () => {
    const out = updateBKT(Number.NaN, true);
    assert.ok(Number.isFinite(out), `NaN prior leaked: ${out}`);
    assert.ok(out >= 0 && out <= 1);
  });

  it("updateBKT survives ±Infinity priors", () => {
    for (const p of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const correct of [true, false]) {
        const out = updateBKT(p, correct);
        assert.ok(Number.isFinite(out) && out >= 0 && out <= 1, `p=${p}`);
      }
    }
  });

  it("updateIRT clamps a NaN theta to the finite ±4 band (the min/max alone leaks NaN)", () => {
    const out = updateIRT(Number.NaN, { difficulty: 0 }, true);
    assert.ok(Number.isFinite(out), `NaN theta leaked: ${out}`);
    assert.ok(out >= -4 && out <= 4);
  });

  it("updateIRT survives ±Infinity theta and non-finite item params", () => {
    assert.ok(
      Number.isFinite(
        updateIRT(Number.POSITIVE_INFINITY, { difficulty: 0 }, true),
      ),
    );
    assert.ok(
      Number.isFinite(
        updateIRT(Number.NEGATIVE_INFINITY, { difficulty: 0 }, false),
      ),
    );
    const out = updateIRT(
      0,
      { difficulty: Number.NaN, discrimination: Number.NaN, guess: Number.NaN },
      true,
    );
    assert.ok(Number.isFinite(out) && out >= -4 && out <= 4, `out=${out}`);
  });

  it("applyUpdate on a corrupt (NaN) estimate self-heals to finite state", () => {
    const corrupt: MasteryEstimate = {
      conceptId: "risk.var",
      theta: Number.NaN,
      pKnown: Number.NaN,
      level: "NEW",
      glow: Number.NaN,
      attempts: 0,
    };
    const next = applyUpdate(corrupt, {
      conceptId: "risk.var",
      outcome: "CORRECT",
      difficulty: "MODERATE",
      assistLevel: 0,
    });
    assert.ok(
      Number.isFinite(next.pKnown) && next.pKnown >= 0 && next.pKnown <= 1,
    );
    assert.ok(
      Number.isFinite(next.theta) && next.theta >= -4 && next.theta <= 4,
    );
    assert.ok(Number.isFinite(next.glow) && next.glow >= 0 && next.glow <= 1);
  });

  it("a hostile assistLevel (NaN / huge / negative) never poisons pKnown", () => {
    const base = initialEstimate("risk.var");
    for (const assistLevel of [
      Number.NaN,
      1e9,
      -50,
      Number.POSITIVE_INFINITY,
    ]) {
      const next = applyUpdate(base, {
        conceptId: "risk.var",
        outcome: "CORRECT",
        difficulty: "HARD",
        assistLevel,
      });
      assert.ok(
        Number.isFinite(next.pKnown) && next.pKnown >= 0 && next.pKnown <= 1,
        `assistLevel=${assistLevel} ⇒ pKnown=${next.pKnown}`,
      );
    }
  });

  it("a NEUTRAL exposure on a corrupt estimate still yields finite pKnown", () => {
    const corrupt: MasteryEstimate = {
      conceptId: "asset.equity",
      theta: 0,
      pKnown: Number.NaN,
      level: "NEW",
      glow: 0,
      attempts: 0,
    };
    const next = applyUpdate(corrupt, {
      conceptId: "asset.equity",
      outcome: "NEUTRAL",
      difficulty: "EASY",
      assistLevel: 0,
    });
    assert.ok(
      Number.isFinite(next.pKnown) && next.pKnown >= 0 && next.pKnown <= 1,
    );
  });
});

describe("initialEstimate", () => {
  it("seeds a NEW estimate at the prior with zero attempts", () => {
    const est = initialEstimate("asset.equity");
    assert.equal(est.conceptId, "asset.equity");
    assert.equal(est.theta, 0);
    assert.equal(est.pKnown, DEFAULT_BKT_PARAMS.pInit);
    assert.equal(est.level, "NEW");
    assert.equal(est.attempts, 0);
    assert.equal(est.lastSeenAt, undefined);
  });

  it("respects a custom pInit", () => {
    const est = initialEstimate("asset.equity", { pInit: 0.8 });
    assert.equal(est.pKnown, 0.8);
    assert.equal(est.level, "PROFICIENT");
  });
});
