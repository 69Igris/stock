/**
 * Nightly investor self-learning rollup processor — MONEY-789 (B4).
 *
 * The I/O half of the rollup. Once a night (Cloud Scheduler → Pub/Sub) this
 * walks every ACTIVE user and, per user, derives a fresh
 * `PortfolioBehaviorSnapshot`, drifts their `InvestorProfile`, decays stale
 * `ConceptMastery`, rebuilds their `PortfolioInsight`s, and reprojects FIRE —
 * the loop that lets StockSage's memory keep learning between sessions.
 *
 * Active users = distinct userId from any of:
 *   - `UserEvent` in the last `activeWindowDays` days (B3 capture stream),
 *   - `Trade` updated in the window,
 *   - `Holding` updated in the window.
 *
 * Per-user work is BEST-EFFORT: each user runs inside its own try/catch, so one
 * user's bad data can never abort the batch. The route ACKs 200 even on a throw
 * (Pub/Sub must not retry-storm a nightly sweep).
 *
 * All pure math lives in `investor-rollup-logic.ts`; this module only does the
 * reads/writes + best-effort orchestration. It reuses the B2 `ensureSeededProfile`
 * seam and the B1 `logAiDecision` analytics surface.
 *
 * SERVER-ONLY (imports prisma + @usemoney/core seams).
 */

import { prisma, Prisma } from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import type { InvestorRollupMessage } from "@usemoney/types/pubsub";
import { ensureSeededProfile } from "@usemoney/core/investor/profile";
import { logAiDecision } from "@usemoney/core/analytics";
import {
  type DerivedBehaviorSnapshot,
  type ProfileState,
  type ResearchAggregate,
  type RollupHolding,
  type RollupMutualFund,
  type RollupPosition,
  type RollupTrade,
  buildInsights,
  decayStaleMastery,
  derivePortfolioBehavior,
  driftProfile,
} from "./investor-rollup-logic";

/** Default lookback (days) for treating a user as "active" for the rollup. */
const DEFAULT_ACTIVE_WINDOW_DAYS = 14;
/** Default idle-days threshold after which concept mastery starts to fade. */
const DEFAULT_DECAY_AFTER_DAYS = 60;
/** Trailing window (days) for trades / research aggregation. */
const ROLLUP_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Outcome of the whole rollup run, surfaced to the route + `logAiDecision`. */
export interface InvestorRollupResult {
  users: number;
  snapshots: number;
  insights: number;
  errors: number;
}

/**
 * Run the nightly investor rollup. Never throws (best-effort per user); returns
 * a summary the route logs and `logAiDecision` records.
 */
export async function processInvestorRollup(
  data: InvestorRollupMessage = {},
): Promise<InvestorRollupResult> {
  const now = data.now ? new Date(data.now) : new Date();
  const activeWindowDays = data.activeWindowDays ?? DEFAULT_ACTIVE_WINDOW_DAYS;
  const decayAfterDays = data.decayAfterDays ?? DEFAULT_DECAY_AFTER_DAYS;

  const result: InvestorRollupResult = {
    users: 0,
    snapshots: 0,
    insights: 0,
    errors: 0,
  };

  if (!process.env.DATABASE_URL) {
    console.warn("[investor-rollup] DATABASE_URL not set — skipping");
    reportJobOutcome({
      job: "investor-rollup",
      selected: 0,
      written: 0,
      skippedReason: "DATABASE_URL not set — no user was discovered",
    });
    return result;
  }

  const activeSince = new Date(now.getTime() - activeWindowDays * MS_PER_DAY);
  const windowSince = new Date(now.getTime() - ROLLUP_WINDOW_DAYS * MS_PER_DAY);

  const userIds = await discoverActiveUsers(activeSince);
  result.users = userIds.length;

  console.log(
    `[investor-rollup] ${userIds.length} active user(s) since ${activeSince.toISOString()}`,
  );

  for (const userId of userIds) {
    try {
      const counts = await rollupUser(userId, now, windowSince, decayAfterDays);
      result.snapshots += counts.snapshots;
      result.insights += counts.insights;
    } catch (err) {
      // One user's failure must NEVER abort the batch.
      result.errors += 1;
      console.warn(`[investor-rollup] user ${userId} failed`, err);
    }
  }

  // End-of-run audit row (best-effort; logAiDecision never throws).
  await logAiDecision({
    decisionType: "NUDGE",
    model: "investor-rollup",
    input: { activeWindowDays, decayAfterDays, now: now.toISOString() },
    output: result,
    rationale: "Nightly investor self-learning rollup (MONEY-789 B4)",
    outcome: "COMPLETED",
    metadata: {
      users: result.users,
      snapshots: result.snapshots,
      insights: result.insights,
      errors: result.errors,
    },
  });

  console.log(
    `[investor-rollup] done — users=${result.users} snapshots=${result.snapshots} insights=${result.insights} errors=${result.errors}`,
  );

  // MONEY-1250 — users against SNAPSHOTS, and the two are 1:1 by construction.
  //
  // This job was listed as one the zero-write monitor is the wrong signal for,
  // on the grounds that "no change since last run writes 0". That was simply
  // wrong about the code: `portfolioBehaviorSnapshot.create` in `rollupUser` is
  // UNCONDITIONAL — one new row per active user per run, identical portfolio or
  // not — so every id in `userIds` either produces exactly one snapshot or
  // lands in `result.errors`. There is no healthy zero-write state while
  // `users > 0`.
  //
  // `result.insights` is deliberately NOT the `written` half: `buildInsights`
  // always emits a `portfolio_rollup` and may add a `fire_projection`, so it is
  // >= users and its ratio to users moves for reasons that have nothing to do
  // with the pipeline being healthy. A denominator that is not 1:1 with the
  // selection is the wrong-granularity defect this repo keeps shipping
  // (MONEY-1189).
  reportJobOutcome({
    job: "investor-rollup",
    selected: result.users,
    written: result.snapshots,
    failed: result.errors,
    ...(result.snapshots < result.users
      ? {
          skippedReason:
            `${result.users - result.snapshots} of ${result.users} active ` +
            `user(s) produced no behaviour snapshot (${result.errors} threw)`,
        }
      : {}),
  });
  return result;
}

/**
 * Distinct active-user ids = UserEvent(window) ∪ Trade(updatedAt) ∪
 * Holding(updatedAt). Each source is best-effort; a failed source contributes
 * no ids rather than aborting discovery.
 */
async function discoverActiveUsers(activeSince: Date): Promise<string[]> {
  const ids = new Set<string>();

  try {
    const events = await prisma.userEvent.findMany({
      where: { createdAt: { gte: activeSince } },
      select: { userId: true },
      distinct: ["userId"],
    });
    for (const e of events) ids.add(e.userId);
  } catch (err) {
    console.warn("[investor-rollup] UserEvent discovery failed", err);
  }

  try {
    const trades = await prisma.trade.findMany({
      where: { updatedAt: { gte: activeSince } },
      select: { userId: true },
      distinct: ["userId"],
    });
    for (const t of trades) ids.add(t.userId);
  } catch (err) {
    console.warn("[investor-rollup] Trade discovery failed", err);
  }

  try {
    const holdings = await prisma.holding.findMany({
      where: { updatedAt: { gte: activeSince } },
      select: { userId: true },
      distinct: ["userId"],
    });
    for (const h of holdings) ids.add(h.userId);
  } catch (err) {
    console.warn("[investor-rollup] Holding discovery failed", err);
  }

  return [...ids];
}

/** Per-user write counts returned to the batch accumulator. */
interface UserRollupCounts {
  snapshots: number;
  insights: number;
}

/**
 * Roll up a single user: snapshot → drift profile → decay mastery → rebuild
 * insights → reproject FIRE. Throws on a hard DB error so the caller's
 * try/catch records it as one user's failure.
 */
async function rollupUser(
  userId: string,
  now: Date,
  windowSince: Date,
  decayAfterDays: number,
): Promise<UserRollupCounts> {
  const counts: UserRollupCounts = { snapshots: 0, insights: 0 };

  // 1. Read the raw portfolio (trades scoped to the 30-day window).
  const [holdingRows, positionRows, tradeRows, mfRows] = await Promise.all([
    prisma.holding.findMany({
      where: { userId },
      select: { currentValue: true, unrealizedPnL: true, sector: true },
    }),
    prisma.position.findMany({
      where: { userId },
      select: { segment: true, netValue: true, unrealizedPnl: true },
    }),
    prisma.trade.findMany({
      where: { userId, tradeDate: { gte: windowSince } },
      select: {
        tradeValue: true,
        quantity: true,
        price: true,
        realizedPnL: true,
      },
    }),
    prisma.mutualFund.findMany({
      where: { userId },
      select: { currentValue: true },
    }),
  ]);

  const holdings: RollupHolding[] = holdingRows;
  const positions: RollupPosition[] = positionRows;
  const trades: RollupTrade[] = tradeRows;
  const mfs: RollupMutualFund[] = mfRows;

  // 2. Derive + persist the behaviour snapshot.
  const snapshot = derivePortfolioBehavior(
    holdings,
    positions,
    trades,
    mfs,
    now,
  );
  await prisma.portfolioBehaviorSnapshot.create({
    data: { userId, ...snapshot },
  });
  counts.snapshots += 1;

  // 3. Previous snapshot (for sustained-signal drift).
  const prevRow = await prisma.portfolioBehaviorSnapshot.findFirst({
    where: { userId, createdAt: { lt: now } },
    orderBy: { createdAt: "desc" },
    skip: 1, // skip the one we just wrote
  });
  const prevSnapshot: DerivedBehaviorSnapshot | null = prevRow
    ? {
        concentrationHHI: prevRow.concentrationHHI,
        topWeight: prevRow.topWeight,
        positionCount: prevRow.positionCount,
        tradeCount30d: prevRow.tradeCount30d,
        turnoverRatio30d: prevRow.turnoverRatio30d,
        topSector: prevRow.topSector,
        topSectorWeight: prevRow.topSectorWeight,
        sectorHHI: prevRow.sectorHHI,
        realizedPnl30d: prevRow.realizedPnl30d,
        unrealizedPnl: prevRow.unrealizedPnl,
        usesFno: prevRow.usesFno,
        portfolioValue: prevRow.portfolioValue,
      }
    : null;

  // 4. Aggregate research / feedback signals (best-effort; empty on miss).
  const feedback = await aggregateResearchSignals(userId, windowSince);

  // 5. Ensure a profile exists (B2 seam), then drift it from the snapshot.
  await ensureSeededProfile(userId, seedSignalsFromSnap(snapshot));
  const profileRow = await prisma.investorProfile.findUnique({
    where: { userId },
    select: {
      riskAppetite: true,
      experienceLevel: true,
      confidence: true,
      overtrader: true,
      panicSeller: true,
      fomoProne: true,
      dividendSeeker: true,
    },
  });
  if (profileRow) {
    const profile: ProfileState = {
      riskAppetite: profileRow.riskAppetite as ProfileState["riskAppetite"],
      experienceLevel:
        profileRow.experienceLevel as ProfileState["experienceLevel"],
      confidence: profileRow.confidence,
      overtrader: profileRow.overtrader,
      panicSeller: profileRow.panicSeller,
      fomoProne: profileRow.fomoProne,
      dividendSeeker: profileRow.dividendSeeker,
    };
    const drift = driftProfile(profile, snapshot, prevSnapshot);
    if (Object.keys(drift).length > 0) {
      await prisma.investorProfile.update({
        where: { userId },
        data: drift,
      });
    }
  }

  // 6. Decay stale concept mastery (only write the rows that actually faded).
  await decayUserMastery(userId, now, decayAfterDays);

  // 7. Rebuild derived insights (delete-then-create per type).
  const insights = buildInsights(snapshot, feedback);
  for (const insight of insights) {
    await swapInsight(userId, insight.type, {
      userId,
      type: insight.type,
      summary: insight.summary,
      data: insight.data as Prisma.InputJsonValue,
      confidence: insight.confidence,
    });
    counts.insights += 1;
  }

  // 8. Reproject FIRE into a `fire_projection` insight.
  if (await reprojectFire(userId)) counts.insights += 1;

  return counts;
}

/**
 * Atomically swap the user's `PortfolioInsight` of one `type`: delete the old
 * row(s) and create the fresh one. MONEY-806 (3): on a replica-set Mongo the
 * delete+create run inside a single `prisma.$transaction([…])` so a reader can
 * never observe the type with zero rows mid-rebuild. Mongo `$transaction`
 * REQUIRES a replica set, so a standalone Mongo throws; we catch that and fall
 * back to the original sequential delete-then-create (functionally identical,
 * just briefly non-atomic). Throws only on a genuine write failure, which the
 * caller's per-user try/catch records as one user's failure (never-throw batch
 * posture preserved).
 */
async function swapInsight(
  userId: string,
  type: string,
  data: Prisma.PortfolioInsightUncheckedCreateInput,
): Promise<void> {
  const del = prisma.portfolioInsight.deleteMany({ where: { userId, type } });
  const create = prisma.portfolioInsight.create({ data });
  try {
    // Atomic swap — preferred when the deployment is a replica set.
    await prisma.$transaction([del, create]);
  } catch (err) {
    if (!isTransactionUnsupported(err)) throw err;
    // Standalone Mongo (no replica set) → fall back to the sequential path.
    await prisma.portfolioInsight.deleteMany({ where: { userId, type } });
    await prisma.portfolioInsight.create({ data });
  }
}

/**
 * True when a thrown error indicates the Mongo deployment can't run a multi-doc
 * transaction (standalone server, not a replica set). Matched loosely on the
 * message so we degrade on any environment that lacks transaction support
 * rather than on a brittle Prisma error code.
 */
function isTransactionUnsupported(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /transaction|replica set|replicaset|not supported|IllegalOperation/i.test(
    message,
  );
}

/**
 * Build the {@link import("@usemoney/core/investor/types").SeedSignals} bag the
 * B2 `ensureSeededProfile` seam reads, straight from the freshly-derived
 * snapshot (so the seed agrees with what the rollup just observed).
 */
function seedSignalsFromSnap(
  snapshot: DerivedBehaviorSnapshot,
): Parameters<typeof ensureSeededProfile>[1] {
  return {
    usesFno: snapshot.usesFno,
    topHoldingConcentration: snapshot.topWeight,
    tradeCount30d: snapshot.tradeCount30d,
  };
}

/**
 * Aggregate the research/feedback signals the `behaviour_flags` insight reads.
 * Each read is best-effort; a failed source degrades that field to 0/undefined
 * rather than aborting the user's rollup.
 */
async function aggregateResearchSignals(
  userId: string,
  windowSince: Date,
): Promise<ResearchAggregate> {
  const agg: ResearchAggregate = {};

  try {
    agg.researchRuns30d = await prisma.researchSession.count({
      where: { userId, createdAt: { gte: windowSince } },
    });
  } catch (err) {
    console.warn("[investor-rollup] researchSession count failed", err);
  }

  try {
    const [up, down] = await Promise.all([
      prisma.resultFeedback.count({ where: { userId, rating: "UP" } }),
      prisma.resultFeedback.count({ where: { userId, rating: "DOWN" } }),
    ]);
    agg.feedbackUp = up;
    agg.feedbackDown = down;
  } catch (err) {
    console.warn("[investor-rollup] resultFeedback count failed", err);
  }

  try {
    const strategies = await prisma.customStrategy.findMany({
      where: { userId },
      select: { usageCount: true },
    });
    agg.strategyUsage = strategies.reduce(
      (sum, s) => sum + (s.usageCount ?? 0),
      0,
    );
  } catch (err) {
    console.warn("[investor-rollup] customStrategy usage failed", err);
  }

  try {
    const roast = await prisma.portfolioRoast.findFirst({
      where: { userId, score: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { score: true },
    });
    if (roast?.score != null) agg.latestRoastScore = roast.score;
  } catch (err) {
    console.warn("[investor-rollup] portfolioRoast score failed", err);
  }

  return agg;
}

/**
 * Decay every stale `ConceptMastery` row for the user. Reads the rows, runs the
 * pure `decayStaleMastery` over each, and writes back only the ones that faded.
 */
async function decayUserMastery(
  userId: string,
  now: Date,
  decayAfterDays: number,
): Promise<void> {
  const rows = await prisma.conceptMastery.findMany({
    where: { userId, lastSeenAt: { not: null } },
    select: { id: true, pKnown: true, glow: true, lastSeenAt: true },
  });

  for (const row of rows) {
    const decayed = decayStaleMastery(
      { pKnown: row.pKnown, glow: row.glow, lastSeenAt: row.lastSeenAt },
      now,
      decayAfterDays,
    );
    if (!decayed) continue;
    await prisma.conceptMastery.update({
      where: { id: row.id },
      data: { pKnown: decayed.pKnown, glow: decayed.glow },
    });
  }
}

/**
 * Reproject the user's default FIRE scenario into a single `fire_projection`
 * `PortfolioInsight` (delete-then-create). Reads the persisted `yearsToFire` /
 * `fireNumber` / `currentCorpus` and the planning horizon; `onTrack` is true
 * when the projected years-to-FIRE fits inside the retirement horizon. SEBI-safe
 * (it describes the projection, never advises). Returns whether an insight was
 * written.
 */
async function reprojectFire(userId: string): Promise<boolean> {
  let fire: {
    currentAge: number;
    retirementAge: number;
    currentCorpus: number;
    fireNumber: number | null;
    yearsToFire: number | null;
  } | null = null;
  try {
    fire = await prisma.fireScenario.findFirst({
      where: { userId },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
      select: {
        currentAge: true,
        retirementAge: true,
        currentCorpus: true,
        fireNumber: true,
        yearsToFire: true,
      },
    });
  } catch (err) {
    console.warn("[investor-rollup] FIRE read failed", err);
    return false;
  }
  if (!fire) return false;

  const horizonYears =
    Number.isFinite(fire.retirementAge) && Number.isFinite(fire.currentAge)
      ? fire.retirementAge - fire.currentAge
      : null;
  const yearsToFire =
    typeof fire.yearsToFire === "number" && Number.isFinite(fire.yearsToFire)
      ? fire.yearsToFire
      : null;
  const onTrack =
    yearsToFire != null && horizonYears != null
      ? yearsToFire <= horizonYears
      : null;

  const summary =
    yearsToFire != null
      ? `Your FIRE plan projects financial independence in about ${yearsToFire} year(s)${
          onTrack === true
            ? " — within your target retirement horizon."
            : onTrack === false
              ? " — beyond your current target retirement horizon."
              : "."
        }`
      : "Your FIRE plan is set up but does not yet have a projected timeline.";

  try {
    await swapInsight(userId, "fire_projection", {
      userId,
      type: "fire_projection",
      summary,
      data: {
        yearsToFire,
        horizonYears,
        onTrack,
        fireNumber: fire.fireNumber,
        currentCorpus: fire.currentCorpus,
      } as Prisma.InputJsonValue,
      confidence: yearsToFire != null ? 0.7 : 0.3,
    });
    return true;
  } catch (err) {
    console.warn("[investor-rollup] FIRE projection write failed", err);
    return false;
  }
}
