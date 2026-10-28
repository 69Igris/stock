/**
 * Nightly investor self-learning rollup — PURE computation logic (no Prisma /
 * no I/O). MONEY-789 (B4).
 *
 * Side-effect-free helpers extracted out of `investor-rollup.ts` so they can be
 * unit-tested by importing the REAL symbol (no shadow copies) without booting a
 * Prisma client. `investor-rollup.ts` imports and CALLS these exports, so the
 * production code path and the tests execute the SAME code. Mirrors the worker
 * precedent `login-briefing-logic.ts` / `sync-logic.ts` / `import-logic.ts`.
 *
 * Four pure stages:
 *   1. `derivePortfolioBehavior` — collapse a user's holdings / positions /
 *      trades / MFs into a single {@link PortfolioBehaviorSnapshot}-shaped
 *      record (concentration, turnover, sector tilt, P&L, F&O usage).
 *   2. `driftProfile` — given the new snapshot (+ the previous one), produce a
 *      PARTIAL InvestorProfile update: confidence rises with evidence,
 *      experience promotes on sustained F&O + turnover, behavioural flags drift.
 *   3. `buildInsights` — render SEBI-safe {@link DerivedInsight}s (describe,
 *      never advise) for the rollup, concentration, sector bias, churn,
 *      risk-drift, and behaviour-flag insight types.
 *   4. `decayStaleMastery` — decay a concept's pKnown / glow when it hasn't been
 *      seen for longer than the decay threshold.
 *
 * NO `@usemoney/database` import here — keeping this dependency-free is what
 * lets the test import the real exports without a DB. The I/O seam (active-user
 * discovery, snapshot writes, profile upsert, insight delete-then-create, FIRE
 * reproject, `logAiDecision`) lives in `investor-rollup.ts`.
 *
 * @see workers/src/processors/investor-rollup.ts (caller)
 * @see apps/web/__tests__/workers/processor-investor-rollup-logic.test.ts (tests the real exports)
 */

// ─────────────────────────────────────────────────────────────────────────
// Input shapes — the subset of each Prisma model the rollup reads. Nullable
// columns are typed `number | null` because the Prisma `select` returns that;
// the pure helpers coalesce them, so the shapes must too.
// ─────────────────────────────────────────────────────────────────────────

/** Holding fields the rollup reads. */
export interface RollupHolding {
  currentValue: number | null;
  unrealizedPnL: number | null;
  sector: string | null;
}

/** Position fields the rollup reads. */
export interface RollupPosition {
  segment: string | null;
  netValue: number | null;
  unrealizedPnl: number | null;
}

/** Trade fields the rollup reads (already filtered to the trailing 30 days). */
export interface RollupTrade {
  tradeValue: number | null;
  quantity: number | null;
  price: number | null;
  realizedPnL: number | null;
}

/** Mutual-fund fields the rollup reads. */
export interface RollupMutualFund {
  currentValue: number | null;
}

/** Mirrors the Prisma `RiskAppetite` enum. */
export type RiskAppetite = "CONSERVATIVE" | "MODERATE" | "AGGRESSIVE";
/** Mirrors the Prisma `ExperienceLevel` enum. */
export type ExperienceLevel = "BEGINNER" | "INTERMEDIATE" | "ADVANCED";

/**
 * The derived portfolio-behaviour snapshot — mirrors the writable columns of
 * the `PortfolioBehaviorSnapshot` model (sans id / userId / createdAt). The
 * I/O layer spreads this straight into `prisma.portfolioBehaviorSnapshot.create`.
 */
export interface DerivedBehaviorSnapshot {
  concentrationHHI: number;
  topWeight: number;
  positionCount: number;
  tradeCount30d: number;
  turnoverRatio30d: number;
  topSector: string | null;
  topSectorWeight: number;
  sectorHHI: number;
  realizedPnl30d: number;
  unrealizedPnl: number;
  usesFno: boolean;
  portfolioValue: number;
}

/** The InvestorProfile fields `driftProfile` may touch. All optional — only changed fields are returned. */
export interface ProfileDrift {
  experienceLevel?: ExperienceLevel;
  confidence?: number;
  overtrader?: number;
  panicSeller?: number;
  fomoProne?: number;
  dividendSeeker?: number;
}

/** The current InvestorProfile state `driftProfile` reads. */
export interface ProfileState {
  riskAppetite: RiskAppetite;
  experienceLevel: ExperienceLevel;
  confidence: number;
  overtrader: number;
  panicSeller: number;
  fomoProne: number;
  dividendSeeker: number;
}

/** A single derived insight, ready for `prisma.portfolioInsight.create`. */
export interface DerivedInsight {
  type: string;
  summary: string;
  data: Record<string, unknown>;
  confidence: number;
}

/** A mastery estimate decay snapshot the I/O layer writes back. */
export interface MasteryDecayState {
  pKnown: number;
  glow: number;
  lastSeenAt: Date | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Small finite-safe helpers (mirrors the money-service `finite()` posture —
// one NaN/Infinity row must not poison a whole snapshot total).
// ─────────────────────────────────────────────────────────────────────────

/** Coalesce a nullable numeric to a FINITE value (NaN / ±Infinity / null → 0). */
function finite(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// NOTE: route through `finite()` first — `Math.min(1, Math.max(0, NaN)) === NaN`,
// so a non-finite input would otherwise leak past the clamp and poison the
// snapshot (the repo's recurring non-finite-poison class).
const clamp01 = (x: number): number => Math.min(1, Math.max(0, finite(x)));

/**
 * Neutralize a free-text label (a holding's sector) before it lands in a
 * PortfolioInsight summary. That summary flows into the chat prompt's TRUSTED
 * memory section AND into user-facing "how StockSage sees you" panels, so a
 * sector carrying newlines / markdown / role markers could forge a prompt turn.
 * Strip control + zero-width chars and structural markers, collapse whitespace,
 * and cap length. (Downstream investor `context.ts` + chat `conversation.ts` also
 * neutralize — this is defense in depth at the generation point.)
 */
function sanitizeLabel(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, " ") // control + zero-width
    .replace(/[#>*`|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .trimEnd(); // slice may cut mid-space — drop a trailing space
}

/** Herfindahl-Hirschman index Σ(wᵢ²) over a list of POSITIVE values (0..1). */
function hhi(values: readonly number[]): { hhi: number; topWeight: number } {
  const positives = values.filter((v) => v > 0);
  const total = positives.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return { hhi: 0, topWeight: 0 };
  let sumSq = 0;
  let topWeight = 0;
  for (const v of positives) {
    const w = v / total;
    sumSq += w * w;
    if (w > topWeight) topWeight = w;
  }
  return { hhi: clamp01(sumSq), topWeight: clamp01(topWeight) };
}

/**
 * Net market value of a position. We use `netValue` when present, otherwise
 * `unrealizedPnl` is irrelevant — the magnitude is what feeds concentration, so
 * an absolute value keeps shorts from cancelling longs in the HHI weighting.
 */
function positionNetValue(p: RollupPosition): number {
  return Math.abs(finite(p.netValue));
}

/** Signed rupee value of a single trade (tradeValue, else quantity × price). */
function tradeValue(t: RollupTrade): number {
  const direct = finite(t.tradeValue);
  if (direct !== 0) return direct;
  return finite(t.quantity) * finite(t.price);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. derivePortfolioBehavior — collapse raw portfolio into one snapshot.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Derive the per-user {@link DerivedBehaviorSnapshot} from the raw portfolio.
 *
 * - `portfolioValue` = Σ Holding.currentValue + Σ MF.currentValue + Σ |Position
 *   net value| (all finite-coalesced).
 * - `concentrationHHI` / `topWeight` = Herfindahl over the per-asset values
 *   above (holdings + MFs + positions), so a single dominant line dominates.
 * - `tradeCount30d` = number of trades passed in (caller filters to 30d).
 * - `turnoverRatio30d` = Σ |trade value| ÷ portfolioValue (guarded; 0 when the
 *   portfolio is empty).
 * - `topSector` / `topSectorWeight` / `sectorHHI` = Herfindahl over Holding
 *   `currentValue` grouped by `sector` (null sectors excluded from the tilt).
 * - `realizedPnl30d` = Σ Trade.realizedPnL over the window.
 * - `unrealizedPnl` = Σ Holding.unrealizedPnL + Σ Position.unrealizedPnl.
 * - `usesFno` = any Position with `segment === "FO"`.
 *
 * `now` is accepted for symmetry with the other stages (and future
 * time-weighting); the current derivation is time-agnostic given a pre-filtered
 * trade list.
 */
export function derivePortfolioBehavior(
  holdings: readonly RollupHolding[],
  positions: readonly RollupPosition[],
  trades: readonly RollupTrade[],
  mfs: readonly RollupMutualFund[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  now: Date = new Date(),
): DerivedBehaviorSnapshot {
  // Per-asset values feeding the concentration HHI (holdings + MFs + positions).
  const holdingValues = holdings.map((h) => finite(h.currentValue));
  const mfValues = mfs.map((m) => finite(m.currentValue));
  const positionValues = positions.map((p) => positionNetValue(p));
  const assetValues = [...holdingValues, ...mfValues, ...positionValues];

  const holdingsTotal = holdingValues.reduce((s, v) => s + v, 0);
  const mfTotal = mfValues.reduce((s, v) => s + v, 0);
  const positionTotal = positionValues.reduce((s, v) => s + v, 0);
  const portfolioValue = holdingsTotal + mfTotal + positionTotal;

  const { hhi: concentrationHHI, topWeight } = hhi(assetValues);

  // Sector tilt over holdings only (sector lives on Holding).
  //
  // MONEY-1093 — the DENOMINATOR is every holding, not just the classified
  // ones. Unclassified value goes into an UNKNOWN bucket that counts toward the
  // total and toward HHI, but is never offered as `topSector`.
  //
  // This used to `continue` past a null sector and then divide by the sum of
  // what remained, while the insight it feeds says "about N% of holdings". Two
  // consequences, both made worse by this ticket, which nulls the sector on
  // every bond:
  //
  //   - the percentage RISES for a user holding bonds without their portfolio
  //     changing, because the denominator shrank. A 60/40 equity/bond portfolio
  //     with all equity in one sector reported 100%, not 60%.
  //   - that inflated weight is compared against DIVIDEND_SECTOR_WEIGHT (0.4),
  //     so the insight fired for portfolios that are not actually concentrated,
  //     and `sectorHHI` was inflated the same way.
  //
  // `packages/roast/src/lib/portfolio-query.ts` already does it this way —
  // full total as the denominator, missing sector coalesced — which is why roast
  // percentages sum to 100% and these did not.
  const UNKNOWN_SECTOR = "__unknown__";
  const sectorTotals = new Map<string, number>();
  for (const h of holdings) {
    const v = finite(h.currentValue);
    if (v <= 0) continue;
    const sector = h.sector?.trim() || UNKNOWN_SECTOR;
    sectorTotals.set(sector, (sectorTotals.get(sector) ?? 0) + v);
  }
  const sectorValues = [...sectorTotals.values()];
  const { hhi: sectorHHI } = hhi(sectorValues);
  let topSector: string | null = null;
  let topSectorWeight = 0;
  const sectorTotal = sectorValues.reduce((s, v) => s + v, 0);
  if (sectorTotal > 0) {
    for (const [sector, v] of sectorTotals) {
      // UNKNOWN counts toward the denominator and HHI, but must never be
      // surfaced as the tilt — "your equity is tilted toward __unknown__" is
      // worse than saying nothing, and the whole point of including it in the
      // total is that the named sector's share is now honest.
      if (sector === UNKNOWN_SECTOR) continue;
      const w = v / sectorTotal;
      if (w > topSectorWeight) {
        topSectorWeight = w;
        topSector = sector;
      }
    }
  }

  // Trading behaviour over the (pre-filtered 30d) trade window.
  const tradeCount30d = trades.length;
  const turnover30d = trades.reduce((s, t) => s + Math.abs(tradeValue(t)), 0);
  const turnoverRatio30d = portfolioValue > 0 ? turnover30d / portfolioValue : 0;
  const realizedPnl30d = trades.reduce((s, t) => s + finite(t.realizedPnL), 0);

  // Unrealized P&L across holdings + positions.
  const unrealizedPnl =
    holdings.reduce((s, h) => s + finite(h.unrealizedPnL), 0) +
    positions.reduce((s, p) => s + finite(p.unrealizedPnl), 0);

  const usesFno = positions.some((p) => p.segment === "FO");

  return {
    concentrationHHI,
    topWeight,
    positionCount: holdings.length + positions.length + mfs.length,
    tradeCount30d,
    turnoverRatio30d,
    topSector,
    topSectorWeight: clamp01(topSectorWeight),
    sectorHHI,
    realizedPnl30d,
    unrealizedPnl,
    usesFno,
    portfolioValue,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. driftProfile — evolve the InvestorProfile from the latest snapshot.
// ─────────────────────────────────────────────────────────────────────────

/** A turnover ratio at/above this (30d) is "high churn". */
export const HIGH_TURNOVER = 0.5;
/** A top-weight at/above this is a concentration / FOMO creep signal. */
export const FOMO_TOPWEIGHT = 0.35;
/** A realized loss past this (₹) over 30d with churn ⇒ panic-seller drift. */
export const PANIC_LOSS_THRESHOLD = -1;
/** A sector tilt at/above this counts toward a dividend-seeker lean. */
export const DIVIDEND_SECTOR_WEIGHT = 0.4;
/** Trait scores drift toward their target by this fraction per run (EMA). */
const DRIFT_RATE = 0.3;
/** Confidence ceiling the nightly drift may push a profile to. */
const CONFIDENCE_CEIL = 0.95;

/** Sectors whose tilt we read as a dividend / income orientation. */
const DIVIDEND_SECTORS = new Set([
  "ENERGY",
  "UTILITIES",
  "FMCG",
  "FINANCIAL SERVICES",
  "BANKING",
]);

/** Exponentially move `current` a `DRIFT_RATE` fraction toward `target`, clamped 0..1. */
function driftToward(current: number, target: number): number {
  return clamp01(current + (clamp01(target) - clamp01(current)) * DRIFT_RATE);
}

/** Bump experience one rung up the ladder (ADVANCED is the ceiling). */
function promoteExperience(level: ExperienceLevel): ExperienceLevel {
  if (level === "BEGINNER") return "INTERMEDIATE";
  if (level === "INTERMEDIATE") return "ADVANCED";
  return "ADVANCED";
}

/** Return only the keys of `next` that differ from `prev` (a minimal PATCH). */
function changedOnly(prev: ProfileState, next: ProfileDrift): ProfileDrift {
  const out: ProfileDrift = {};
  if (next.experienceLevel && next.experienceLevel !== prev.experienceLevel)
    out.experienceLevel = next.experienceLevel;
  if (next.confidence !== undefined && next.confidence !== prev.confidence)
    out.confidence = next.confidence;
  for (const key of [
    "overtrader",
    "panicSeller",
    "fomoProne",
    "dividendSeeker",
  ] as const) {
    const v = next[key];
    if (v !== undefined && v !== prev[key]) out[key] = v;
  }
  return out;
}

/**
 * Drift the InvestorProfile from the latest snapshot.
 *
 * Returns a PARTIAL update containing ONLY the fields that actually changed
 * (so the I/O layer can `prisma.investorProfile.update` with a minimal patch,
 * and a no-change run writes nothing meaningful):
 *
 *   - `confidence` rises with evidence — each snapshot is fresh signal, so we
 *     nudge confidence up toward {@link CONFIDENCE_CEIL} by a small step that
 *     scales with how much of the portfolio is populated.
 *   - `experienceLevel` promotes one rung when there is SUSTAINED F&O usage
 *     (this run AND the previous snapshot) together with high turnover — the
 *     hallmark of an active derivatives trader.
 *   - `overtrader` ↑ with high turnover; `panicSeller` ↑ when a realized loss
 *     coincides with churn; `fomoProne` ↑ with top-weight creep;
 *     `dividendSeeker` ↑ when the sector tilt leans income/defensive.
 *
 * Trait drift is a gentle EMA toward a per-trait target so a single noisy night
 * can't flip a flag — it takes repeated nights of the same signal.
 *
 * @param prev the previous snapshot, or `null` on the first run for this user.
 */
export function driftProfile(
  profile: ProfileState,
  snapshot: DerivedBehaviorSnapshot,
  prev: DerivedBehaviorSnapshot | null,
): ProfileDrift {
  const next: ProfileDrift = {};

  // Confidence rises with evidence. A populated portfolio (any positions or
  // trades) is real signal; nudge confidence a small step toward the ceiling.
  const hasSignal =
    snapshot.positionCount > 0 ||
    snapshot.tradeCount30d > 0 ||
    snapshot.portfolioValue > 0;
  if (hasSignal && profile.confidence < CONFIDENCE_CEIL) {
    const step = 0.05 + (snapshot.tradeCount30d > 0 ? 0.05 : 0);
    next.confidence =
      Math.round(Math.min(CONFIDENCE_CEIL, profile.confidence + step) * 1000) /
      1000;
  }

  // Experience promotes on SUSTAINED F&O + high turnover (this run + last run).
  const sustainedFno = snapshot.usesFno && (prev?.usesFno ?? false);
  if (
    sustainedFno &&
    snapshot.turnoverRatio30d >= HIGH_TURNOVER &&
    profile.experienceLevel !== "ADVANCED"
  ) {
    next.experienceLevel = promoteExperience(profile.experienceLevel);
  }

  // Overtrader ↑ with high turnover (target scales with how far past the gate).
  const overtraderTarget =
    snapshot.turnoverRatio30d >= HIGH_TURNOVER
      ? clamp01(snapshot.turnoverRatio30d)
      : 0;
  next.overtrader =
    Math.round(driftToward(profile.overtrader, overtraderTarget) * 1000) / 1000;

  // Panic-seller ↑ when a realized loss over 30d coincides with churn.
  const panickedThisRun =
    snapshot.realizedPnl30d < PANIC_LOSS_THRESHOLD &&
    snapshot.turnoverRatio30d >= HIGH_TURNOVER;
  next.panicSeller =
    Math.round(
      driftToward(profile.panicSeller, panickedThisRun ? 0.8 : 0) * 1000,
    ) / 1000;

  // FOMO ↑ with top-weight creep (single dominant holding).
  const fomoTarget =
    snapshot.topWeight >= FOMO_TOPWEIGHT ? clamp01(snapshot.topWeight) : 0;
  next.fomoProne =
    Math.round(driftToward(profile.fomoProne, fomoTarget) * 1000) / 1000;

  // Dividend-seeker ↑ when the sector tilt leans income/defensive.
  const dividendLean =
    snapshot.topSector !== null &&
    DIVIDEND_SECTORS.has(snapshot.topSector.toUpperCase()) &&
    snapshot.topSectorWeight >= DIVIDEND_SECTOR_WEIGHT;
  next.dividendSeeker =
    Math.round(
      driftToward(profile.dividendSeeker, dividendLean ? 0.7 : 0) * 1000,
    ) / 1000;

  return changedOnly(profile, next);
}

// ─────────────────────────────────────────────────────────────────────────
// 3. buildInsights — SEBI-safe descriptive insights (never advise).
// ─────────────────────────────────────────────────────────────────────────

/** Aggregated research / feedback signals for the insight builder. */
export interface ResearchAggregate {
  /** Research runs in the trailing 30 days. */
  researchRuns30d?: number;
  /** Up-votes on AI results (ResultFeedback rating=UP). */
  feedbackUp?: number;
  /** Down-votes on AI results (ResultFeedback rating=DOWN). */
  feedbackDown?: number;
  /** Σ CustomStrategy.usageCount — how much the user leans on saved scans. */
  strategyUsage?: number;
  /** Latest PortfolioRoast.score (0..100), if any. */
  latestRoastScore?: number;
}

/** Format a rupee amount with Indian grouping and no fractional digits. */
function inr(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(value)).toLocaleString("en-IN")}`;
}

/** Format a 0..1 weight as a whole percent. */
function pct(weight: number): string {
  return `${Math.round(clamp01(weight) * 100)}%`;
}

/**
 * Build the SEBI-safe {@link DerivedInsight} list for one user.
 *
 * Every summary DESCRIBES the portfolio / behaviour — it never advises, implies
 * a buy/sell, or recommends an action. The I/O layer delete-then-creates one
 * `PortfolioInsight` per `type`, so the types here must be stable + distinct:
 *
 *   - `portfolio_rollup` — always emitted: the headline snapshot summary.
 *   - `concentration`    — when a single line dominates (topWeight high).
 *   - `sector_bias`      — when one sector dominates the equity tilt.
 *   - `churn`            — when 30-day turnover is high.
 *   - `risk_drift`       — when F&O is in use (a higher-risk surface).
 *   - `behaviour_flags`  — when research engagement / feedback is notable.
 *
 * @param feedback optional aggregated research/feedback signals (may be empty).
 */
export function buildInsights(
  snapshot: DerivedBehaviorSnapshot,
  feedback: ResearchAggregate = {},
): DerivedInsight[] {
  const insights: DerivedInsight[] = [];

  // (a) portfolio_rollup — always emitted.
  insights.push({
    type: "portfolio_rollup",
    summary: `Your tracked portfolio is worth ${inr(snapshot.portfolioValue)} across ${snapshot.positionCount} holdings, with ${snapshot.tradeCount30d} trade(s) in the last 30 days.`,
    data: {
      portfolioValue: snapshot.portfolioValue,
      positionCount: snapshot.positionCount,
      tradeCount30d: snapshot.tradeCount30d,
      unrealizedPnl: snapshot.unrealizedPnl,
      realizedPnl30d: snapshot.realizedPnl30d,
    },
    confidence: snapshot.portfolioValue > 0 ? 0.9 : 0.3,
  });

  // (b) concentration.
  if (snapshot.topWeight >= FOMO_TOPWEIGHT) {
    insights.push({
      type: "concentration",
      summary: `Your largest single holding is about ${pct(snapshot.topWeight)} of the portfolio (concentration index ${snapshot.concentrationHHI.toFixed(2)}).`,
      data: {
        topWeight: snapshot.topWeight,
        concentrationHHI: snapshot.concentrationHHI,
      },
      confidence: 0.8,
    });
  }

  // (c) sector_bias. The sector label is user/broker/CSV-sourced free text, so
  // neutralize it before it lands in the summary (which flows into the trusted
  // prompt memory section) — defense in depth alongside the downstream guards.
  const safeTopSector = snapshot.topSector ? sanitizeLabel(snapshot.topSector) : "";
  if (safeTopSector && snapshot.topSectorWeight >= DIVIDEND_SECTOR_WEIGHT) {
    insights.push({
      type: "sector_bias",
      summary: `Your equity is tilted toward ${safeTopSector} (about ${pct(snapshot.topSectorWeight)} of holdings).`,
      data: {
        topSector: safeTopSector,
        topSectorWeight: snapshot.topSectorWeight,
        sectorHHI: snapshot.sectorHHI,
      },
      confidence: 0.75,
    });
  }

  // (d) churn.
  if (snapshot.turnoverRatio30d >= HIGH_TURNOVER) {
    insights.push({
      type: "churn",
      summary: `Your 30-day trading turnover is about ${pct(Math.min(1, snapshot.turnoverRatio30d))} of portfolio value — an active trading cadence.`,
      data: {
        turnoverRatio30d: snapshot.turnoverRatio30d,
        tradeCount30d: snapshot.tradeCount30d,
      },
      confidence: 0.8,
    });
  }

  // (e) risk_drift — F&O is a higher-risk surface; describe, never advise.
  if (snapshot.usesFno) {
    insights.push({
      type: "risk_drift",
      summary:
        "Your portfolio includes futures & options positions, which carry higher risk than cash equity.",
      data: { usesFno: true },
      confidence: 0.7,
    });
  }

  // (f) behaviour_flags — research engagement + feedback signal.
  const runs = finite(feedback.researchRuns30d);
  const up = finite(feedback.feedbackUp);
  const down = finite(feedback.feedbackDown);
  const strategyUsage = finite(feedback.strategyUsage);
  if (runs > 0 || up > 0 || down > 0 || strategyUsage > 0) {
    insights.push({
      type: "behaviour_flags",
      summary: `You've run ${runs} research analysis(es) in the last 30 days and saved scans used ${strategyUsage} time(s).`,
      data: {
        researchRuns30d: runs,
        feedbackUp: up,
        feedbackDown: down,
        strategyUsage,
        latestRoastScore: feedback.latestRoastScore ?? null,
      },
      confidence: 0.6,
    });
  }

  return insights;
}

// ─────────────────────────────────────────────────────────────────────────
// 4. decayStaleMastery — fade concepts the user hasn't touched in a while.
// ─────────────────────────────────────────────────────────────────────────

/** Default number of idle days after which a concept's mastery starts to fade. */
export const DEFAULT_DECAY_AFTER_DAYS = 60;
/** Multiplicative decay applied to pKnown once a concept is stale. */
const DECAY_FACTOR = 0.9;
/** Floor below which we don't bother decaying further (matches the BKT prior). */
const PKNOWN_FLOOR = 0.1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Smoothstep glow from pKnown (matches `glowFromMastery` in the mastery model). */
function glowFromPKnown(p: number): number {
  const pk = clamp01(p);
  return clamp01(pk * pk * (3 - 2 * pk));
}

/**
 * Decay a single concept's mastery when it has gone stale.
 *
 * If the concept's `lastSeenAt` is older than `decayAfterDays`, fade `pKnown`
 * by {@link DECAY_FACTOR} (floored at {@link PKNOWN_FLOOR}) and recompute the
 * `glow`. A concept that's still fresh (or has never been seen, `lastSeenAt =
 * null`) is returned UNCHANGED, so the caller can skip the write.
 *
 * Returns `null` when nothing changed (fresh / no decay), so the I/O layer only
 * writes the rows that actually faded.
 */
export function decayStaleMastery(
  estimate: MasteryDecayState,
  now: Date,
  decayAfterDays: number = DEFAULT_DECAY_AFTER_DAYS,
): MasteryDecayState | null {
  if (!estimate.lastSeenAt) return null;

  const ageMs = now.getTime() - estimate.lastSeenAt.getTime();
  const ageDays = ageMs / MS_PER_DAY;
  if (ageDays <= decayAfterDays) return null;

  const current = clamp01(finite(estimate.pKnown));
  if (current <= PKNOWN_FLOOR) return null;

  const decayed = Math.max(PKNOWN_FLOOR, current * DECAY_FACTOR);
  if (decayed >= current) return null;

  return {
    pKnown: decayed,
    glow: glowFromPKnown(decayed),
    lastSeenAt: estimate.lastSeenAt,
  };
}
