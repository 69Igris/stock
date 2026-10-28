/**
 * Investor profile + concept-mastery seams (MONEY-787, B2).
 *
 * Two layers:
 *
 *   1. PURE functions (no I/O): `updateConceptMastery` (a thin, named wrapper
 *      over `applyUpdate`) and `seedProfile` (derive a behavioural profile from
 *      raw signals). These are unit-tested directly.
 *
 *   2. DB seams (import `prisma`): `applyConceptSignal` and
 *      `ensureSeededProfile`. These load-or-init a row, run the pure logic, and
 *      upsert. They are what B3/B4 (the nudge + chat-personalisation layers)
 *      will call.
 *
 * Only THIS module imports `@usemoney/database`; `mastery.ts`, `concepts.ts`
 * and `types.ts` stay dependency-free.
 */

import { prisma } from "@usemoney/database";
import { applyUpdate, initialEstimate, type BktParams } from "./mastery";
import type {
  ExperienceLevel,
  InvestorProfileSeed,
  MasteryEstimate,
  MasteryLevel,
  MasteryUpdateInput,
  SeedSignals,
} from "./types";

/**
 * PURE: advance a concept's mastery estimate by one observed signal. A named,
 * domain-meaningful wrapper over {@link applyUpdate} so call sites read well.
 */
export function updateConceptMastery(
  current: MasteryEstimate,
  signal: MasteryUpdateInput,
  params: Partial<BktParams> = {},
): MasteryEstimate {
  return applyUpdate(current, signal, params);
}

/**
 * PURE: derive an investor profile seed from raw behavioural signals.
 *
 * Heuristics (deliberately conservative — `confidence` stays low until we have
 * real signal):
 *   - High FIRE withdrawal rate + a long horizon ⇒ AGGRESSIVE.
 *   - A conservative safe-withdrawal-rate (≤ 3.5%) ⇒ CONSERVATIVE.
 *   - F&O usage ⇒ bumps risk toward AGGRESSIVE and experience up a notch.
 *   - High top-holding concentration ⇒ risk propensity (we don't downgrade
 *     appetite here, but it surfaces via the trait scores).
 *   - High 30-day trade count ⇒ `overtrader` propensity.
 *   - Anything we can't infer falls back to MODERATE / BEGINNER / 0.1.
 */
export function seedProfile(signals: SeedSignals): InvestorProfileSeed {
  const seed: InvestorProfileSeed = {
    riskAppetite: "MODERATE",
    experienceLevel: "BEGINNER",
    confidence: 0.1,
    panicSeller: 0,
    overtrader: 0,
    fomoProne: 0,
    dividendSeeker: 0,
    seededFrom: signals,
  };

  // Each present signal lifts our confidence in the derived profile.
  let evidence = 0;

  const swr = signals.fireWithdrawalRate;
  const horizon = signals.fireHorizonYears;
  if (typeof swr === "number" && Number.isFinite(swr)) {
    evidence += 1;
    if (swr <= 3.5) {
      seed.riskAppetite = "CONSERVATIVE";
    } else if (
      swr >= 5 &&
      typeof horizon === "number" &&
      Number.isFinite(horizon) &&
      horizon >= 20
    ) {
      // Drawing down aggressively over a long horizon ⇒ high risk tolerance.
      seed.riskAppetite = "AGGRESSIVE";
    }
  }
  if (typeof horizon === "number" && Number.isFinite(horizon)) {
    evidence += 1;
  }

  if (signals.usesFno) {
    evidence += 1;
    // F&O usage pushes risk up and signals more experience.
    seed.riskAppetite = "AGGRESSIVE";
    seed.experienceLevel = promoteExperience(seed.experienceLevel);
  }

  const concentration = signals.topHoldingConcentration;
  if (typeof concentration === "number" && Number.isFinite(concentration)) {
    evidence += 1;
    // A single dominant holding is a concentration-risk + FOMO propensity.
    if (concentration >= 0.4) {
      seed.fomoProne = clampTrait(concentration);
      seed.panicSeller = clampTrait(concentration * 0.5);
    }
  }

  const trades = signals.tradeCount30d;
  if (typeof trades === "number" && Number.isFinite(trades) && trades >= 0) {
    evidence += 1;
    // Map trade frequency to an overtrading propensity (~50 trades/mo ⇒ 1.0).
    seed.overtrader = clampTrait(trades / 50);
    // A busy trader is more experienced — promote one rung from wherever the
    // experience level currently sits (so F&O + heavy trading ⇒ ADVANCED).
    if (trades >= 30) {
      seed.experienceLevel = promoteExperience(seed.experienceLevel);
    }
  }

  // Confidence: base 0.1, +0.15 per distinct signal, capped at 0.85.
  seed.confidence = Math.min(0.85, 0.1 + evidence * 0.15);

  return seed;
}

const clampTrait = (x: number): number => Math.min(1, Math.max(0, x));

/** Bump experience one rung up the ladder (ADVANCED is the ceiling). */
function promoteExperience(level: ExperienceLevel): ExperienceLevel {
  if (level === "BEGINNER") return "INTERMEDIATE";
  if (level === "INTERMEDIATE") return "ADVANCED";
  return "ADVANCED";
}

// ─────────────────────────────────────────────────────────────────────────
// DB seams — these import prisma. Everything above is pure.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Load-or-init a user's mastery for `signal.conceptId`, apply the signal, and
 * upsert the result. Returns the updated estimate.
 *
 * This is the entry point B3/B4 call whenever the user demonstrates (or merely
 * is exposed to) a concept.
 */
export async function applyConceptSignal(
  userId: string,
  signal: MasteryUpdateInput,
  params: Partial<BktParams> = {},
): Promise<MasteryEstimate> {
  const existing = await prisma.conceptMastery.findUnique({
    where: { userId_conceptId: { userId, conceptId: signal.conceptId } },
  });

  const current: MasteryEstimate = existing
    ? {
        conceptId: existing.conceptId,
        theta: existing.theta,
        pKnown: existing.pKnown,
        // The DB enum mirrors our MasteryLevel union value-for-value.
        level: existing.level as MasteryLevel,
        glow: existing.glow,
        attempts: existing.attempts,
        lastSeenAt: existing.lastSeenAt ?? undefined,
      }
    : initialEstimate(signal.conceptId, params);

  const next = updateConceptMastery(current, signal, params);

  await prisma.conceptMastery.upsert({
    where: { userId_conceptId: { userId, conceptId: signal.conceptId } },
    create: {
      userId,
      conceptId: next.conceptId,
      theta: next.theta,
      pKnown: next.pKnown,
      level: next.level,
      glow: next.glow,
      attempts: next.attempts,
      lastSeenAt: next.lastSeenAt,
    },
    update: {
      theta: next.theta,
      pKnown: next.pKnown,
      level: next.level,
      glow: next.glow,
      attempts: next.attempts,
      lastSeenAt: next.lastSeenAt,
    },
  });

  return next;
}

/**
 * Ensure a user has an `InvestorProfile`, seeding it from `signals` the first
 * time. Will NOT clobber an existing profile whose confidence is already at or
 * above the freshly-derived seed's confidence (so a richer, later-evolved
 * profile is never overwritten by a thin re-seed). Returns the live profile id.
 */
export async function ensureSeededProfile(
  userId: string,
  signals: SeedSignals = {},
): Promise<string> {
  const existing = await prisma.investorProfile.findUnique({
    where: { userId },
    select: { id: true, confidence: true },
  });

  const seed = seedProfile(signals);

  if (!existing) {
    const created = await prisma.investorProfile.create({
      data: {
        userId,
        riskAppetite: seed.riskAppetite,
        experienceLevel: seed.experienceLevel,
        confidence: seed.confidence,
        seededFrom: seed.seededFrom as object,
        panicSeller: seed.panicSeller,
        overtrader: seed.overtrader,
        fomoProne: seed.fomoProne,
        dividendSeeker: seed.dividendSeeker,
      },
      select: { id: true },
    });
    return created.id;
  }

  // Don't clobber a higher- (or equal-) confidence profile.
  if (existing.confidence >= seed.confidence) {
    return existing.id;
  }

  const updated = await prisma.investorProfile.update({
    where: { userId },
    data: {
      riskAppetite: seed.riskAppetite,
      experienceLevel: seed.experienceLevel,
      confidence: seed.confidence,
      seededFrom: seed.seededFrom as object,
      panicSeller: seed.panicSeller,
      overtrader: seed.overtrader,
      fomoProne: seed.fomoProne,
      dividendSeeker: seed.dividendSeeker,
    },
    select: { id: true },
  });
  return updated.id;
}
