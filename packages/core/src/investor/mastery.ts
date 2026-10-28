/**
 * Mastery model — the dual-engine estimator at the heart of the investor's
 * self-learning loop (MONEY-787, B2). Bayesian Knowledge Tracing (BKT) tracks
 * P(concept is known); Item Response Theory (1PL/3PL) tracks a continuous
 * ability `theta`. Together they decide how confidently the AI can explain a
 * concept to the user, and how brightly the concept "glows" in the UI.
 *
 * Ported from orvi `packages/adaptive/src/mastery.ts`. Adapted for the
 * investing domain: keyed on a taxonomy concept slug (NOT a topic ObjectId),
 * with `SignalDifficulty` / `SignalOutcome` replacing orvi's quiz-centric
 * `Difficulty` / `AttemptResult`, and a generic `assistLevel` in place of the
 * hint-count penalty.
 *
 * Everything here is a PURE function — no I/O, no DB import. The DB seams live
 * in `./profile.ts`.
 */

import type {
  MasteryEstimate,
  MasteryLevel,
  MasteryUpdateInput,
} from "./types";

/**
 * The difficulty of a concept signal, on the same five-step scale the rest of
 * the investing surface uses. Maps to an IRT item difficulty `b` (logit).
 */
export type SignalDifficulty =
  | "TRIVIAL"
  | "EASY"
  | "MODERATE"
  | "HARD"
  | "EXPERT";

/**
 * The observed outcome of a single concept interaction.
 *
 * - `CORRECT`   — full positive evidence (answered/applied correctly).
 * - `PARTIAL`   — weak positive (got it half right) — treated as half-credit.
 * - `INCORRECT` — negative evidence.
 * - `NEUTRAL`   — mild exposure only (the user merely *saw* the concept, e.g.
 *   it appeared in a research report). A tiny positive learning nudge with no
 *   correctness signal, but it still counts as an attempt + bumps lastSeenAt.
 */
export type SignalOutcome = "CORRECT" | "PARTIAL" | "INCORRECT" | "NEUTRAL";

/** Tunable BKT parameters. Defaults are sane investing-tutor starting points. */
export interface BktParams {
  /** P(L0) — prior probability the concept is already known at first contact. */
  pInit: number;
  /** P(T) — probability of transitioning unknown→known after one opportunity. */
  pLearn: number;
  /** P(S) — probability of slipping (knew it, answered wrong). */
  pSlip: number;
  /** P(G) — probability of guessing (didn't know it, answered right). */
  pGuess: number;
}

export const DEFAULT_BKT_PARAMS: BktParams = {
  pInit: 0.1,
  pLearn: 0.15,
  pSlip: 0.1,
  pGuess: 0.2,
};

/** Tunable IRT parameters for the ability nudge. */
export interface IrtItem {
  /** Item difficulty `b` on the same logit scale as `theta` (harder → larger). */
  difficulty: number;
  /** Discrimination `a` (1PL ⇒ 1). Higher means a sharper item. */
  discrimination?: number;
  /** Pseudo-guess lower asymptote `c` (3PL). 0 ⇒ pure 1PL/2PL. */
  guess?: number;
}

/** Mastery-level bucket thresholds on P(known). */
export const MASTERY_THRESHOLDS = {
  LEARNING: 0.2,
  PRACTICING: 0.5,
  PROFICIENT: 0.75,
  MASTERED: 0.9,
} as const;

/**
 * Clamp into [0,1]. NaN / non-finite inputs collapse to 0 (NOT NaN) so a single
 * hostile or corrupt value (a NaN prior loaded from the DB, an Infinity nudge)
 * can never poison the BKT/IRT state and get persisted forward — `Math.min/max`
 * alone leaks NaN (`Math.min(1, Math.max(0, NaN)) === NaN`).
 */
export const clamp01 = (x: number): number => {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
};

/**
 * One BKT posterior update.
 *
 * Step 1 (evidence): P(L | obs) via Bayes using slip/guess.
 * Step 2 (learning):  P(L_next) = P(L|obs) + (1 - P(L|obs)) * pLearn.
 *
 * @param prior   P(known) before this observation, in [0,1].
 * @param correct whether the observed attempt was correct.
 * @returns the updated P(known) in [0,1].
 */
export function updateBKT(
  prior: number,
  correct: boolean,
  params: Partial<BktParams> = {},
): number {
  const { pLearn, pSlip, pGuess } = { ...DEFAULT_BKT_PARAMS, ...params };
  const pL = clamp01(prior);

  // P(L | evidence) — conditional on the observed correctness.
  let pLGivenObs: number;
  if (correct) {
    const num = pL * (1 - pSlip);
    const den = pL * (1 - pSlip) + (1 - pL) * pGuess;
    pLGivenObs = den > 0 ? num / den : pL;
  } else {
    const num = pL * pSlip;
    const den = pL * pSlip + (1 - pL) * (1 - pGuess);
    pLGivenObs = den > 0 ? num / den : pL;
  }

  // P(L_next) — account for the chance of learning on this opportunity.
  const pLNext = pLGivenObs + (1 - pLGivenObs) * pLearn;
  return clamp01(pLNext);
}

/**
 * 1PL/3PL ability nudge. Moves `theta` toward or away from the item difficulty
 * by the surprise of the observation: a correct answer on a hard item lifts
 * ability more than a correct answer on an easy one (and symmetrically for
 * errors).
 *
 * This is a lightweight online gradient step, not a full MLE/EAP re-estimation.
 *
 * @returns the nudged ability estimate, clamped to a sane logit band (±4).
 */
export function updateIRT(
  theta: number,
  item: IrtItem,
  correct: boolean,
): number {
  // Defend against a hostile / corrupt prior theta. A NaN here would survive
  // the `Math.min(4, Math.max(-4, NaN))` clamp below (it returns NaN), poison
  // the estimate, and get persisted; an ±Infinity must collapse to the band.
  const theta0 = Number.isFinite(theta) ? Math.min(4, Math.max(-4, theta)) : 0;
  const a = Number.isFinite(item.discrimination)
    ? (item.discrimination as number)
    : 1;
  const c = clamp01(item.guess ?? 0);
  const b = Number.isFinite(item.difficulty) ? item.difficulty : 0;

  // 3PL probability of a correct response given current theta.
  const z = a * (theta0 - b);
  const logistic = 1 / (1 + Math.exp(-z));
  const pCorrect = clamp01(c + (1 - c) * logistic);

  // Online step: learning-rate * discrimination * (observed - expected).
  const learningRate = 0.5;
  const observed = correct ? 1 : 0;
  const delta = learningRate * a * (observed - pCorrect);

  // Keep ability in a sane logit band (~ -4..4). `theta0 + delta` is finite by
  // construction (all inputs finite), but clamp defensively regardless.
  const next = theta0 + delta;
  return Number.isFinite(next) ? Math.min(4, Math.max(-4, next)) : 0;
}

/** Bucket a P(known) into a {@link MasteryLevel}. */
export function masteryLevelFromPKnown(p: number): MasteryLevel {
  const pk = clamp01(p);
  if (pk < MASTERY_THRESHOLDS.LEARNING) return "NEW";
  if (pk < MASTERY_THRESHOLDS.PRACTICING) return "LEARNING";
  if (pk < MASTERY_THRESHOLDS.PROFICIENT) return "PRACTICING";
  if (pk < MASTERY_THRESHOLDS.MASTERED) return "PROFICIENT";
  return "MASTERED";
}

/**
 * Brightness of the concept's glow, in [0,1]. A gentle ease-in curve so early
 * progress is visibly rewarding while the final stretch to mastery still
 * meaningfully brightens the glow. Smoothstep: p²(3 − 2p).
 */
export function glowFromMastery(p: number): number {
  const pk = clamp01(p);
  return clamp01(pk * pk * (3 - 2 * pk));
}

/** Map a {@link SignalDifficulty} to an IRT item difficulty `b` on the logit scale. */
export function difficultyToIrtB(difficulty: SignalDifficulty): number {
  switch (difficulty) {
    case "TRIVIAL":
      return -1.5;
    case "EASY":
      return -0.75;
    case "MODERATE":
      return 0;
    case "HARD":
      return 0.75;
    case "EXPERT":
      return 1.5;
    default:
      return 0;
  }
}

/**
 * Translate a {@link SignalOutcome} into a BKT/IRT correctness signal.
 *
 * `PARTIAL` counts as a weak positive so the learner still gains some credit.
 * `INCORRECT` and `NEUTRAL` count as not-correct (NEUTRAL is handled specially
 * upstream so it never *penalises* — see {@link applyUpdate}).
 */
export function isCorrectOutcome(outcome: SignalOutcome): boolean {
  return outcome === "CORRECT" || outcome === "PARTIAL";
}

/**
 * Pure mastery transition: given the current estimate and one observed
 * interaction, produce the next estimate. No I/O — safe to call anywhere.
 *
 * NEUTRAL (mild exposure) is special-cased: rather than running the full
 * evidence update (which would push P(known) down because it isn't a
 * "correct" observation), it applies only a tiny optimistic learning nudge,
 * leaves theta untouched, and still records the attempt + lastSeenAt.
 */
export function applyUpdate(
  estimate: MasteryEstimate,
  input: MasteryUpdateInput,
  params: Partial<BktParams> = {},
): MasteryEstimate {
  const now = new Date();

  if (input.outcome === "NEUTRAL") {
    // Mild exposure: a small positive learn step, no correctness evidence,
    // no theta movement.
    const pLearn = params.pLearn ?? DEFAULT_BKT_PARAMS.pLearn;
    const exposureGain = pLearn * 0.25; // gentle — just "saw it once"
    const pKnown = clamp01(
      estimate.pKnown + (1 - estimate.pKnown) * exposureGain,
    );
    return {
      ...estimate,
      pKnown,
      level: masteryLevelFromPKnown(pKnown),
      glow: glowFromMastery(pKnown),
      attempts: estimate.attempts + 1,
      lastSeenAt: now,
    };
  }

  const correct = isCorrectOutcome(input.outcome);

  // Penalise heavy assistance by softening a "correct": more help ⇒ closer to
  // guess. We model this by nudging the effective BKT guess upward.
  const assistPenalty = clamp01(Math.min(0.3, input.assistLevel));
  const effectiveParams: Partial<BktParams> = {
    ...params,
    pGuess: clamp01(
      (params.pGuess ?? DEFAULT_BKT_PARAMS.pGuess) + assistPenalty,
    ),
  };

  // PARTIAL is a weak positive: give half the BKT learning lift of a CORRECT
  // by blending the prior with the full-correct posterior.
  let pKnown: number;
  if (input.outcome === "PARTIAL") {
    const full = updateBKT(estimate.pKnown, true, effectiveParams);
    pKnown = clamp01(estimate.pKnown + (full - estimate.pKnown) * 0.5);
  } else {
    pKnown = updateBKT(estimate.pKnown, correct, effectiveParams);
  }

  const item: IrtItem = { difficulty: difficultyToIrtB(input.difficulty) };
  const theta = updateIRT(estimate.theta, item, correct);

  return {
    ...estimate,
    theta,
    pKnown,
    level: masteryLevelFromPKnown(pKnown),
    glow: glowFromMastery(pKnown),
    attempts: estimate.attempts + 1,
    lastSeenAt: now,
  };
}

/** A fresh, "NEW" estimate for a concept the user has not yet touched. */
export function initialEstimate(
  conceptId: string,
  params: Partial<BktParams> = {},
): MasteryEstimate {
  const pKnown = clamp01(params.pInit ?? DEFAULT_BKT_PARAMS.pInit);
  return {
    conceptId,
    theta: 0,
    pKnown,
    level: masteryLevelFromPKnown(pKnown),
    glow: glowFromMastery(pKnown),
    attempts: 0,
  };
}
