/**
 * Plain TypeScript types for the investor self-learning model (MONEY-787, B2).
 *
 * Deliberately NO Zod and NO `@usemoney/database` import — keeping this module
 * dependency-free is what lets `mastery.ts` / `concepts.ts` stay pure and
 * importable from anywhere (client, worker, test) without dragging in Prisma
 * or a validation cycle. The string unions below mirror the Prisma enums
 * value-for-value (see `schema.prisma`: enum `MasteryLevel`, `RiskAppetite`,
 * `ExperienceLevel`).
 */

import type { SignalDifficulty, SignalOutcome } from "./mastery";

/**
 * Mastery bucket on the P(known) scale. Mirrors the Prisma `MasteryLevel`
 * enum value-for-value so a DB row can be cast to/from this union safely.
 */
export type MasteryLevel =
  | "NEW"
  | "LEARNING"
  | "PRACTICING"
  | "PROFICIENT"
  | "MASTERED";

/** Mirrors the Prisma `RiskAppetite` enum. */
export type RiskAppetite = "CONSERVATIVE" | "MODERATE" | "AGGRESSIVE";

/** Mirrors the Prisma `ExperienceLevel` enum. */
export type ExperienceLevel = "BEGINNER" | "INTERMEDIATE" | "ADVANCED";

/**
 * Per-concept mastery estimate. `theta` is the IRT ability estimate; `pKnown`
 * is the Bayesian Knowledge Tracing probability the user has learned the
 * concept. `glow` is a 0..1 UI brightness derived from `pKnown`.
 */
export interface MasteryEstimate {
  /** Taxonomy concept slug, e.g. "valuation.pe-ratio" (NOT an ObjectId). */
  conceptId: string;
  /** IRT ability, ~N(0,1), clamped to ±4. */
  theta: number;
  /** BKT P(known), in [0,1]. */
  pKnown: number;
  level: MasteryLevel;
  /** 0..1 brightness for the concept. */
  glow: number;
  attempts: number;
  lastSeenAt?: Date;
}

/** A single observed interaction the mastery model updates from. */
export interface MasteryUpdateInput {
  conceptId: string;
  outcome: SignalOutcome;
  difficulty: SignalDifficulty;
  /** How much assistance the user leaned on, 0..0.3 (softens a "correct"). */
  assistLevel: number;
}

/**
 * Raw behavioural signals used to seed an {@link InvestorProfileSeed}. All
 * fields optional — `seedProfile` degrades gracefully to MODERATE/BEGINNER
 * defaults when signal is missing.
 */
export interface SeedSignals {
  /** FIRE safe-withdrawal-rate (%) from the user's primary scenario. */
  fireWithdrawalRate?: number;
  /** Planning horizon in years (retirementAge − currentAge), if known. */
  fireHorizonYears?: number;
  /** Does the user trade F&O / derivatives? */
  usesFno?: boolean;
  /** Largest single-holding weight in the portfolio, 0..1. */
  topHoldingConcentration?: number;
  /** Number of trades in the trailing 30 days. */
  tradeCount30d?: number;
}

/**
 * The derived investor profile seed — the pure output of `seedProfile`,
 * ready to upsert into the `InvestorProfile` row.
 */
export interface InvestorProfileSeed {
  riskAppetite: RiskAppetite;
  experienceLevel: ExperienceLevel;
  /** 0..1 trust in this seed; rises as more signal is present. */
  confidence: number;
  /** Behavioural propensities, each a soft 0..1 score. */
  panicSeller: number;
  overtrader: number;
  fomoProne: number;
  dividendSeeker: number;
  /** The signals this seed was derived from (audit + re-seed input). */
  seededFrom: SeedSignals;
}
