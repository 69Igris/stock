/**
 * Roast Service
 *
 * CRUD operations for PortfolioRoast (async agent version).
 * Source: apps/web/lib/actions/roast.ts + apps/web/lib/db/roast.ts
 *
 * NOTE: Credit checking/consuming and Pub/Sub publishing stay in the action layer.
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { StructuredRoastResult, RoastJobMessage } from "@usemoney/types";
import type { BrokerType } from "@prisma/client";
import { hasFeatureAccess } from "@usemoney/core/subscription";
import type { ServiceResult } from "./types";
import { sanitizeRoastStatusData, sanitizeRoastListItem } from "./roast-logic";
// MONEY-1062 (P2b) — async roast START extraction. The web action
// (apps/web/lib/actions/roast.ts:194 `startRoastAction` + :61 `canUseRoastAction`)
// owns the feature gate + broker pre-flight + credit consume + Pub/Sub publish;
// this ADDITIVE parallel service lets apps/api `POST /v1/roast` reach the SAME
// flow (incl. the MONEY-1062 fix: createRoastSession is checked BEFORE the credit
// is consumed) without the thin route inlining pubsub. The web action is NOT
// modified — its credit helpers are duplicated here on purpose.
import { publishRoastJob as defaultPublishRoastJob } from "@usemoney/pubsub/publish";
import {
  getSubscriptionAccessForUser as defaultGetSubscriptionAccessForUser,
  type SubscriptionAccess,
} from "./subscription.service";
import { randomUUID } from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────

export interface CreateRoastInput {
  userId: string;
  sessionId: string;
  jobId: string;
  mode: string;
  broker?: string;
  assetType: string;
}

export interface RoastStatusData {
  status: string;
  progress: number;
  currentStep: string | null;
  score: number | null;
  errorMessage: string | null;
}

export interface RoastFullRecord {
  id: string;
  sessionId: string;
  mode: string;
  broker: string | null;
  assetType: string;
  status: string;
  progress: number;
  currentStep: string | null;
  score: number | null;
  result: StructuredRoastResult | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface RoastRunningItem {
  sessionId: string;
  mode: string;
  broker: string | null;
  assetType: string;
  status: string;
  progress: number;
  currentStep: string | null;
  createdAt: Date;
}

export interface RecentRoastItem {
  sessionId: string;
  mode: string;
  broker: string | null;
  assetType: string;
  status: string;
  progress: number;
  currentStep: string | null;
  score: number | null;
  createdAt: Date;
}

export interface RoastHistoryItem {
  id: string;
  sessionId: string;
  mode: string;
  broker: string | null;
  assetType: string;
  status: string;
  score: number | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface UpdateRoastStatusInput {
  status:
    | "QUEUED"
    | "FETCHING_DATA"
    | "ANALYZING_STOCKS"
    | "ANALYZING_MF"
    | "SCORING"
    | "GENERATING_ROAST"
    | "ASSEMBLING"
    | "COMPLETED"
    | "FAILED";
  errorMessage?: string;
}

// ── Service Functions ──────────────────────────────────────────────

export async function createRoastSession(
  data: CreateRoastInput,
): Promise<ServiceResult<{ id: string }>> {
  try {
    const roast = await prisma.portfolioRoast.create({
      data: {
        userId: data.userId,
        sessionId: data.sessionId,
        jobId: data.jobId,
        mode: data.mode,
        broker: data.broker || null,
        assetType: data.assetType,
        status: "QUEUED",
        progress: 0,
      },
      select: { id: true },
    });

    return { success: true, data: { id: roast.id } };
  } catch (error) {
    logger.error({ error, data }, "Create roast session service error");
    return { success: false, error: "Failed to create roast session" };
  }
}

export async function getRoastStatus(
  sessionId: string,
  userId?: string,
): Promise<ServiceResult<RoastStatusData>> {
  try {
    // MONEY-543 / mirrors MONEY-286: filter by userId when provided so a
    // guessed sessionId from another account resolves as "not found"
    // rather than leaking their roast status/progress/score/errorMessage
    // (which may include broker / portfolio hints). Action-layer callers
    // always pass userId; legacy callers (none today) fall through to
    // the broader findUnique.
    const roast = userId
      ? await prisma.portfolioRoast.findFirst({
          where: { sessionId, userId },
          select: {
            status: true,
            progress: true,
            currentStep: true,
            score: true,
            errorMessage: true,
          },
        })
      : await prisma.portfolioRoast.findUnique({
          where: { sessionId },
          select: {
            status: true,
            progress: true,
            currentStep: true,
            score: true,
            errorMessage: true,
          },
        });

    if (!roast) {
      return { success: false, error: "Roast not found" };
    }

    // MONEY-620: the worker pipeline can persist a corrupt `score` (a non-numeric
    // model output that coerced to NaN) or an out-of-range `progress`. The score
    // gauge renders `{score}` and the progress view renders `{progress}%`
    // verbatim, so forward a sanitized row: clamped integer progress in [0,100]
    // and a clamped-or-null score — never NaN/Infinity/150.
    return { success: true, data: sanitizeRoastStatusData(roast) };
  } catch (error) {
    logger.error({ error, sessionId }, "Get roast status service error");
    // MONEY-1062 (Round C / C1#3): code so routes map a DB blip to 500, not 404.
    return {
      success: false,
      error: "Failed to get roast status",
      code: "INTERNAL",
    };
  }
}

export async function getRoastBySessionId(
  sessionId: string,
  userId: string,
): Promise<ServiceResult<RoastFullRecord>> {
  try {
    const roast = await prisma.portfolioRoast.findFirst({
      where: { sessionId, userId },
      select: {
        id: true,
        sessionId: true,
        mode: true,
        broker: true,
        assetType: true,
        status: true,
        progress: true,
        currentStep: true,
        score: true,
        result: true,
        errorMessage: true,
        createdAt: true,
        completedAt: true,
      },
    });

    if (!roast) {
      return { success: false, error: "Roast not found" };
    }

    return {
      success: true,
      data: {
        ...roast,
        result: roast.result as unknown as StructuredRoastResult | null,
      },
    };
  } catch (error) {
    logger.error(
      { error, sessionId, userId },
      "Get roast by session service error",
    );
    return { success: false, error: "Failed to get roast", code: "INTERNAL" };
  }
}

export async function getRunningRoasts(
  userId: string,
): Promise<ServiceResult<RoastRunningItem[]>> {
  try {
    const roasts = await prisma.portfolioRoast.findMany({
      where: {
        userId,
        status: { notIn: ["COMPLETED", "FAILED"] },
      },
      select: {
        sessionId: true,
        mode: true,
        broker: true,
        assetType: true,
        status: true,
        progress: true,
        currentStep: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // MONEY-620: clamp each row's `progress` so a corrupt non-finite / >100
    // value can't reach the running-list UI as `NaN%` / `150%`.
    return { success: true, data: roasts.map(sanitizeRoastListItem) };
  } catch (error) {
    logger.error({ error, userId }, "Get running roasts service error");
    return { success: false, error: "Failed to get running roasts" };
  }
}

/** The 24h recent-roast window, in milliseconds. */
export const RECENT_ROAST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Newest-first cap for the recent-roast reconcile list. */
export const RECENT_ROAST_TAKE = 20;

/**
 * The exact `prisma.portfolioRoast.findMany` args the recent-roast query
 * uses. Extracted as a precise (non-`any`) shape so the IDOR-critical
 * `where` clause (userId-scope + 24h `gte`) and the order/cap are
 * unit-assertable without a live DB.
 */
export interface RecentRoastSessionsQuery {
  where: { userId: string; createdAt: { gte: Date } };
  select: {
    sessionId: true;
    mode: true;
    broker: true;
    assetType: true;
    status: true;
    progress: true;
    currentStep: true;
    score: true;
    createdAt: true;
  };
  orderBy: { createdAt: "desc" };
  take: number;
}

/**
 * Pure builder for the recent-roast query. SECURITY (MONEY-543 IDOR guard):
 * the `where` MUST always scope by `userId` AND bound `createdAt` to the 24h
 * window so a caller can only ever see their own recent sessions. Newest-first
 * (`createdAt desc`), capped at {@link RECENT_ROAST_TAKE}.
 */
export function buildRecentRoastSessionsQuery(
  userId: string,
  since: Date,
): RecentRoastSessionsQuery {
  return {
    where: {
      userId,
      createdAt: { gte: since },
    },
    select: {
      sessionId: true,
      mode: true,
      broker: true,
      assetType: true,
      status: true,
      progress: true,
      currentStep: true,
      score: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: RECENT_ROAST_TAKE,
  };
}

/**
 * The DB seam {@link getRecentRoastSessions} calls. Defaults to the real
 * Prisma `findMany`; tests inject an in-memory implementation that honors the
 * same `{ where, orderBy, take }` contract so the REAL service body (24h
 * window math, query build, try/catch, ServiceResult shaping) is exercised
 * without a live database.
 */
export type RecentRoastSessionsFinder = (
  query: RecentRoastSessionsQuery,
) => Promise<RecentRoastItem[]>;

const defaultRecentRoastSessionsFinder: RecentRoastSessionsFinder = (query) =>
  prisma.portfolioRoast.findMany(query);

/**
 * MONEY-543: recent roast sessions in the last 24h, scoped to userId.
 * Used by the chat `getRecentRoastSessionsAction` to reconcile
 * `start_roast` ActionBlocks on chat reload (mirrors the research-side
 * `getRecentResearchSessions` reconciliation pattern). 24h window, capped
 * at 20, ordered newest-first.
 *
 * `finder` is injectable for deterministic tests; production callers pass
 * only `userId` and get the real Prisma query.
 */
export async function getRecentRoastSessions(
  userId: string,
  finder: RecentRoastSessionsFinder = defaultRecentRoastSessionsFinder,
): Promise<ServiceResult<RecentRoastItem[]>> {
  try {
    const since = new Date(Date.now() - RECENT_ROAST_WINDOW_MS);
    const roasts = await finder(buildRecentRoastSessionsQuery(userId, since));
    // MONEY-620: clamp each row's `progress` and `score` for the chat-reconcile
    // UI. `score` STAYS null for an in-progress roast (clampNullableScore
    // preserves null); only a present-but-non-finite/out-of-range score is
    // coerced. Behaviour-preserving for the finite, in-range values the
    // reconcile path normally returns.
    return { success: true, data: roasts.map(sanitizeRoastListItem) };
  } catch (error) {
    logger.error({ error, userId }, "Get recent roast sessions service error");
    return { success: false, error: "Failed to get recent roast sessions" };
  }
}

export async function getRoastHistory(
  userId: string,
  page = 1,
  pageSize = 20,
): Promise<ServiceResult<{ items: RoastHistoryItem[]; total: number }>> {
  try {
    const where = {
      userId,
      status: { in: ["COMPLETED", "FAILED"] as ("COMPLETED" | "FAILED")[] },
    };
    const [items, total] = await Promise.all([
      prisma.portfolioRoast.findMany({
        where,
        select: {
          id: true,
          sessionId: true,
          mode: true,
          broker: true,
          assetType: true,
          status: true,
          score: true,
          errorMessage: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.portfolioRoast.count({ where }),
    ]);

    // MONEY-620: clamp each history row's `score` so a corrupt persisted value
    // can't reach the history UI / `.toLocaleString()` as NaN. (History rows
    // carry no `progress` field — sanitizeRoastListItem leaves the shape intact
    // and only rewrites the keys that exist.)
    return {
      success: true,
      data: { items: items.map(sanitizeRoastListItem), total },
    };
  } catch (error) {
    logger.error({ error, userId }, "Get roast history service error");
    return { success: false, error: "Failed to get roast history" };
  }
}

export async function cancelRoast(
  userId: string,
  sessionId: string,
): Promise<ServiceResult<void>> {
  try {
    const roast = await prisma.portfolioRoast.findFirst({
      where: { sessionId, userId, status: { notIn: ["COMPLETED", "FAILED"] } },
      select: { id: true },
    });

    if (!roast) {
      return { success: false, error: "Running roast not found" };
    }

    await prisma.portfolioRoast.update({
      where: { id: roast.id },
      data: {
        status: "FAILED",
        errorMessage: "Cancelled by user",
        completedAt: new Date(),
      },
    });

    return { success: true, data: undefined };
  } catch (error) {
    logger.error({ error, userId, sessionId }, "Cancel roast service error");
    // MONEY-1062 (Round C / C1#3): code so routes map a DB blip to 500, not 404.
    return {
      success: false,
      error: "Failed to cancel roast",
      code: "INTERNAL",
    };
  }
}

export async function deleteRoast(
  userId: string,
  id: string,
): Promise<ServiceResult<void>> {
  try {
    const roast = await prisma.portfolioRoast.findFirst({
      where: { id, userId },
      select: { id: true },
    });

    if (!roast) {
      return { success: false, error: "Roast not found" };
    }

    await prisma.portfolioRoast.delete({ where: { id } });
    return {
      success: true,
      data: undefined,
      message: "Roast deleted successfully",
    };
  } catch (error) {
    logger.error({ error, userId, id }, "Delete roast service error");
    // MONEY-1062 (Round C / C1#3): code so routes map a DB blip to 500, not 404.
    return {
      success: false,
      error: "Failed to delete roast",
      code: "INTERNAL",
    };
  }
}

export async function updateRoastStatus(
  sessionId: string,
  userId: string,
  data: UpdateRoastStatusInput,
): Promise<ServiceResult<void>> {
  try {
    // MONEY-599: scope the write by userId (updateMany — no unique compound
    // key) and reject a foreign sessionId via the count guard.
    const res = await prisma.portfolioRoast.updateMany({
      where: { sessionId, userId },
      data,
    });
    if (res.count === 0) {
      return { success: false, error: "Roast session not found" };
    }

    return { success: true, data: undefined };
  } catch (error) {
    logger.error(
      { error, sessionId, data },
      "Update roast status service error",
    );
    return { success: false, error: "Failed to update roast status" };
  }
}

// ── Async Roast START + eligibility (MONEY-1062 P2b — apps/api parity) ──

export interface CanUseRoastData {
  allowed: boolean;
  isFreeRoast: boolean;
  message?: string;
  remainingCredits?: number;
}

export interface StartRoastInput {
  mode: "overall" | "broker";
  broker?: string;
  /** MONEY-837: scope to a specific account when a broker has multiple logins. */
  brokerUserId?: string;
  /** MONEY-837: tradebook-subset scope — ISO date bounds + symbol filter. */
  dateFrom?: string;
  dateTo?: string;
  symbols?: string[];
  assetType: "stocks" | "mf" | "all";
  /** MONEY-145: narrative bias for the worker prompt. */
  scope?: "PORTFOLIO" | "TRADEBOOK";
}

/**
 * Roast-eligibility check (mirror apps/web/lib/actions/roast.ts:61
 * `canUseRoastAction`). Everyone gets 1 free roast/month; PRO burns advanced
 * query credits; PREMIUM/ULTIMATE are unlimited. A stale monthly counter is
 * reset in-place. Unlike the web action (which returns `allowed:false` on a DB
 * error), a thrown error here fails the ServiceResult so the route surfaces 500
 * rather than a misleading "not allowed".
 */
export async function canUseRoast(
  userId: string,
  deps: { prisma?: typeof prisma } = {},
): Promise<ServiceResult<CanUseRoastData>> {
  const db = deps.prisma ?? prisma;
  try {
    const sub = await db.subscription.findUnique({
      where: { userId },
      select: {
        planId: true,
        freeRoastsUsedThisMonth: true,
        freeRoastsResetAt: true,
        advancedQueriesUsed: true,
        advancedQueriesLimit: true,
      },
    });

    const planId = sub?.planId || "FREE";

    // Check/reset the monthly free-roast counter.
    let freeRoastsUsed = sub?.freeRoastsUsedThisMonth ?? 0;
    if (sub?.freeRoastsResetAt && sub.freeRoastsResetAt < new Date()) {
      freeRoastsUsed = 0;
      await db.subscription.update({
        where: { userId },
        data: { freeRoastsUsedThisMonth: 0 },
      });
    }

    // Free roast available for ALL users.
    if (freeRoastsUsed === 0) {
      return { success: true, data: { allowed: true, isFreeRoast: true } };
    }

    // Paid tiers fall back to advanced-query credits.
    if (planId === "PRO" || planId === "PREMIUM" || planId === "ULTIMATE") {
      const used = sub?.advancedQueriesUsed ?? 0;
      const limit = sub?.advancedQueriesLimit ?? 0;
      const remaining = Math.max(0, limit - used);

      if (planId === "ULTIMATE" || planId === "PREMIUM" || remaining > 0) {
        return {
          success: true,
          data: {
            allowed: true,
            isFreeRoast: false,
            remainingCredits:
              planId === "ULTIMATE" || planId === "PREMIUM"
                ? undefined
                : remaining,
          },
        };
      }

      return {
        success: true,
        data: {
          allowed: false,
          isFreeRoast: false,
          message: "No advanced credits remaining. Upgrade or wait for reset.",
        },
      };
    }

    // FREE tier with the free roast already used.
    return {
      success: true,
      data: {
        allowed: false,
        isFreeRoast: false,
        message:
          "Free monthly roast used. Upgrade to Pro for unlimited roasts.",
      },
    };
  } catch (error) {
    logger.error({ error, userId }, "canUseRoast check failed");
    return {
      success: false,
      error: "Failed to check credit availability",
      code: "INTERNAL",
    };
  }
}

/** Consume a roast credit (mirror roast.ts:144 `consumeRoastCredit`). */
async function consumeRoastCreditDefault(
  userId: string,
  isFreeRoast: boolean,
  db: typeof prisma = prisma,
): Promise<void> {
  if (isFreeRoast) {
    // Reset date = 1st of next month.
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    await db.subscription.update({
      where: { userId },
      data: {
        freeRoastsUsedThisMonth: { increment: 1 },
        freeRoastsResetAt: nextMonth,
      },
    });
  } else {
    await db.subscription.update({
      where: { userId },
      data: { advancedQueriesUsed: { increment: 1 } },
    });
  }
}

/** Refund a roast credit (mirror roast.ts:171 `refundRoastCredit`). */
async function refundRoastCreditDefault(
  userId: string,
  isFreeRoast: boolean,
  db: typeof prisma = prisma,
): Promise<void> {
  if (isFreeRoast) {
    await db.subscription.update({
      where: { userId },
      data: { freeRoastsUsedThisMonth: { decrement: 1 } },
    });
  } else {
    await db.subscription.update({
      where: { userId },
      data: { advancedQueriesUsed: { decrement: 1 } },
    });
  }
}

/**
 * Injectable IO seam for {@link startRoast}. Defaults to the shared prisma /
 * pubsub / same-module services; the service tests inject fakes to assert the
 * G3 ordering (createRoastSession checked BEFORE the credit consume BEFORE
 * publish) + the publish-failure refund leg on the REAL function.
 */
export interface StartRoastDeps {
  prisma?: typeof prisma;
  publishRoastJob?: (msg: RoastJobMessage) => Promise<string>;
  getSubscriptionAccessForUser?: (
    userId: string,
  ) => Promise<ServiceResult<SubscriptionAccess>>;
  canUseRoast?: (userId: string) => Promise<ServiceResult<CanUseRoastData>>;
  createRoastSession?: (
    input: CreateRoastInput,
  ) => Promise<ServiceResult<{ id: string }>>;
  updateRoastStatus?: (
    sessionId: string,
    userId: string,
    data: UpdateRoastStatusInput,
  ) => Promise<ServiceResult<void>>;
  consumeRoastCredit?: (userId: string, isFreeRoast: boolean) => Promise<void>;
  refundRoastCredit?: (userId: string, isFreeRoast: boolean) => Promise<void>;
}

/**
 * Start an async portfolio roast (mirror apps/web/lib/actions/roast.ts:194
 * `startRoastAction`, INCLUDING the MONEY-1062 fix). Order:
 *   1. feature gate (portfolioRoast → PRO+); fail-to-FREE on an access-read error,
 *   2. broker pre-flight (fail fast: NOT_CONNECTED / NEEDS_REAUTH / NEVER_SYNCED;
 *      overall mode only accumulates stale-broker warnings),
 *   3. credit eligibility (canUseRoast),
 *   4. createRoastSession — CHECKED BEFORE the credit is consumed so a failed
 *      INSERT never charges the user (the G3 fix),
 *   5. consume the roast credit,
 *   6. publishRoastJob — on failure REFUND the credit + mark the session FAILED
 *      (exactly the action's leg, roast.ts:347-351).
 */
export async function startRoast(
  userId: string,
  params: StartRoastInput,
  deps: StartRoastDeps = {},
): Promise<ServiceResult<{ sessionId: string; warnings?: string[] }>> {
  const db = deps.prisma ?? prisma;
  const publish = deps.publishRoastJob ?? defaultPublishRoastJob;
  const getAccess =
    deps.getSubscriptionAccessForUser ?? defaultGetSubscriptionAccessForUser;
  const canUse =
    deps.canUseRoast ?? ((uid: string) => canUseRoast(uid, { prisma: db }));
  const createSession = deps.createRoastSession ?? createRoastSession;
  const updateStatus = deps.updateRoastStatus ?? updateRoastStatus;
  const consumeCredit =
    deps.consumeRoastCredit ??
    ((uid: string, free: boolean) => consumeRoastCreditDefault(uid, free, db));
  const refundCredit =
    deps.refundRoastCredit ??
    ((uid: string, free: boolean) => refundRoastCreditDefault(uid, free, db));

  try {
    // ── Feature gate (mirror roast.ts:219-226) — fail-to-FREE on read error ──
    const access = await getAccess(userId);
    const planId = access.success ? access.data.planId : "FREE";
    if (!hasFeatureAccess(planId, "portfolioRoast")) {
      return {
        success: false,
        error: "Upgrade to access Portfolio Roast",
        code: "UPGRADE_REQUIRED",
      };
    }

    // ── Broker pre-flight (mirror roast.ts:228-287) ──────────────────
    const warnings: string[] = [];
    if (params.mode === "broker" && params.broker) {
      const connections = await db.brokerConnection.findMany({
        where: {
          userId,
          broker: params.broker as BrokerType,
          ...(params.brokerUserId ? { brokerUserId: params.brokerUserId } : {}),
        },
        select: { status: true, tokenExpiry: true, lastSync: true },
      });

      if (connections.length === 0) {
        return {
          success: false,
          error: `${params.broker} is not connected. Go to the Brokers page to connect it.`,
          code: "NOT_CONNECTED",
        };
      }

      // Safe: the `length === 0` guard above already returned NOT_CONNECTED.
      const conn = connections[0]!;
      if (
        conn.status === "EXPIRED" ||
        conn.status === "NEEDS_REAUTH" ||
        (conn.tokenExpiry && conn.tokenExpiry < new Date())
      ) {
        return {
          success: false,
          error: `Your ${params.broker} session has expired. Please reconnect your broker to get fresh data.`,
          code: "NEEDS_REAUTH",
        };
      }

      if (!conn.lastSync) {
        return {
          success: false,
          error: `Your ${params.broker} account hasn't been synced yet. Sync your data from the Brokers page first.`,
          code: "NEVER_SYNCED",
        };
      }
    } else if (params.mode === "overall") {
      const allConnections = await db.brokerConnection.findMany({
        where: { userId },
        select: { broker: true, status: true, tokenExpiry: true },
      });
      for (const conn of allConnections) {
        if (
          conn.status === "EXPIRED" ||
          conn.status === "NEEDS_REAUTH" ||
          (conn.tokenExpiry && conn.tokenExpiry < new Date())
        ) {
          warnings.push(
            `${conn.broker} session has expired - data may be stale. Reconnect for fresh data.`,
          );
        }
      }
    }

    // ── Credit eligibility (mirror roast.ts:289-297) ─────────────────
    const creditCheck = await canUse(userId);
    if (!creditCheck.success) {
      return { success: false, error: creditCheck.error, code: "INTERNAL" };
    }
    if (!creditCheck.data.allowed) {
      return {
        success: false,
        error: creditCheck.data.message || "No roast credits available",
        code: "NO_CREDITS",
      };
    }
    const isFreeRoast = creditCheck.data.isFreeRoast;

    const sessionId = randomUUID();
    const jobId = randomUUID();

    // ── Create the session BEFORE consuming a credit (the MONEY-1062 fix,
    //    roast.ts:309-324): a failed INSERT must never charge the user. ──
    const created = await createSession({
      userId,
      sessionId,
      jobId,
      mode: params.mode,
      broker: params.broker,
      assetType: params.assetType,
    });
    if (!created.success) {
      logger.error(
        { error: created.error, sessionId },
        "Start roast: create session failed",
      );
      return {
        success: false,
        error: "Failed to start roast. Please try again.",
        code: "INTERNAL",
      };
    }

    // ── Consume the credit (mirror roast.ts:327) ─────────────────────
    await consumeCredit(userId, isFreeRoast);

    // ── Publish; on failure refund + mark FAILED (mirror roast.ts:330-357) ──
    try {
      await publish({
        jobId,
        userId,
        sessionId,
        mode: params.mode,
        broker: params.broker,
        brokerUserId: params.brokerUserId,
        assetType: params.assetType,
        scope: params.scope,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        symbols: params.symbols,
      });
    } catch (publishError) {
      logger.error(
        { error: publishError, sessionId },
        "Start roast publish failed",
      );
      await refundCredit(userId, isFreeRoast);
      await updateStatus(sessionId, userId, {
        status: "FAILED",
        errorMessage: "Failed to queue roast job",
      });
      return {
        success: false,
        error: "Failed to start roast. Please try again.",
        code: "INTERNAL",
      };
    }

    return {
      success: true,
      data: {
        sessionId,
        warnings: warnings.length > 0 ? warnings : undefined,
      },
    };
  } catch (error) {
    logger.error({ error, userId }, "Start roast service error");
    return {
      success: false,
      error: "Failed to start portfolio roast",
      code: "INTERNAL",
    };
  }
}
