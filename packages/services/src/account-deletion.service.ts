/**
 * Account Deletion Service (MONEY-391)
 *
 * Owns the full delete-account flow:
 *   1. requestDeleteOtp  — emit a 6-digit OTP to the user's email (Redis-backed)
 *   2. verifyDeleteOtp   — single-use validation of the OTP
 *   3. captureAuditSnapshot — read User + Subscription + Portfolio + Broker count
 *      to populate the DeletedUserAudit row before any data is touched
 *   4. cancelDodoSubscription — best-effort cancel via Dodo Payments API
 *   5. hardDeleteUser — atomic cascade delete (clears encrypted broker creds,
 *      writes DeletedUserAudit, deletes User → cascades to ~30 child models)
 *
 * Hard delete only — there is no soft-delete and no undo. The
 * DeletedUserAudit row is the only thing that survives, by design
 * (DPDP Act 2023 + investor-DD trust signal: prove deletion happened).
 */

import { randomInt } from "node:crypto";
import { prisma } from "@usemoney/database";
import {
  getRedisClient,
  getDodoClient,
  isDodoConfigured,
} from "@usemoney/core";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";

// ── OTP Constants ──────────────────────────────────────────────────

const OTP_TTL_SECONDS = 10 * 60; // 10 minutes
const OTP_RATE_LIMIT_TTL_SECONDS = 60 * 60; // 1 hour
const OTP_MAX_PER_HOUR = 3;
const OTP_MAX_VERIFY_ATTEMPTS = 5;

const otpKey = (userId: string) => `delete-otp:${userId}`;
const otpAttemptsKey = (userId: string) => `delete-otp-attempts:${userId}`;
const otpRateKey = (userId: string) => `delete-otp-rate:${userId}`;

// In-memory fallback when Redis is unavailable (dev/CI only — production
// always has Redis). Map<userId, { code, expiresAt, attempts }>. Cleared
// every 10 min by the TTL on each entry.
const memoryOtpStore = new Map<
  string,
  { code: string; expiresAt: number; attempts: number; rateCount: number }
>();

// ── OTP: Generate & Send ───────────────────────────────────────────

export interface RequestDeleteOtpInput {
  userId: string;
  email: string;
}

export interface RequestDeleteOtpResult {
  /** Masked email so the dialog can show "Sent to s***@gmail.com" */
  maskedEmail: string;
  /** Expiry timestamp so the dialog can show a countdown */
  expiresAt: Date;
}

/**
 * Generate a 6-digit OTP, store it in Redis (10 min TTL), return metadata
 * for the dialog. Caller is responsible for sending the email (we don't
 * import @usemoney/email here to avoid a cyclic dep — the calling server
 * action wires the email send).
 *
 * Returns the OTP via the second return value `otp` for the caller to email.
 * The function does NOT log or persist the plaintext OTP.
 */
export async function generateDeleteOtp(
  input: RequestDeleteOtpInput,
): Promise<ServiceResult<{ result: RequestDeleteOtpResult; otp: string }>> {
  try {
    // Rate limit: max 3 OTP requests per hour per user
    const rateCount = await incrRateCounter(input.userId);
    if (rateCount > OTP_MAX_PER_HOUR) {
      return {
        success: false,
        error: `Too many OTP requests. Try again in an hour.`,
      };
    }

    const code = generateSixDigitCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);

    const redis = getRedisClient();
    if (redis) {
      await redis.set(otpKey(input.userId), code, "EX", OTP_TTL_SECONDS);
      await redis.del(otpAttemptsKey(input.userId)); // reset attempts on new OTP
    } else {
      memoryOtpStore.set(input.userId, {
        code,
        expiresAt: expiresAt.getTime(),
        attempts: 0,
        rateCount,
      });
    }

    logger.info({ userId: input.userId, expiresAt }, "Delete OTP generated");

    return {
      success: true,
      data: {
        result: { maskedEmail: maskEmail(input.email), expiresAt },
        otp: code,
      },
    };
  } catch (error) {
    logger.error({ error, userId: input.userId }, "generateDeleteOtp failed");
    return {
      success: false,
      error: "Failed to generate OTP",
    };
  }
}

// ── OTP: Verify ────────────────────────────────────────────────────

/**
 * Verify the 6-digit OTP. Single-use: deletes the OTP on success so it
 * can't be replayed. Tracks failed attempts (max 5 before lockout).
 */
export async function verifyDeleteOtp(
  userId: string,
  otp: string,
): Promise<ServiceResult<true>> {
  if (!/^\d{6}$/.test(otp)) {
    return { success: false, error: "Invalid OTP format" };
  }

  try {
    const redis = getRedisClient();
    let stored: string | null = null;
    let attempts = 0;

    if (redis) {
      stored = await redis.get(otpKey(userId));
      const attemptsStr = await redis.get(otpAttemptsKey(userId));
      attempts = attemptsStr ? parseInt(attemptsStr, 10) : 0;
    } else {
      const memEntry = memoryOtpStore.get(userId);
      if (memEntry && memEntry.expiresAt > Date.now()) {
        stored = memEntry.code;
        attempts = memEntry.attempts;
      }
    }

    if (!stored) {
      return { success: false, error: "OTP expired or not found" };
    }

    if (attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
      // Burn the OTP to force re-request
      await clearOtp(userId);
      return {
        success: false,
        error: "Too many failed attempts. Request a new OTP.",
      };
    }

    if (stored !== otp) {
      await incrAttempts(userId);
      return { success: false, error: "Incorrect OTP" };
    }

    // Success — burn the OTP
    await clearOtp(userId);
    return { success: true, data: true };
  } catch (error) {
    logger.error({ error, userId }, "verifyDeleteOtp failed");
    return { success: false, error: "Failed to verify OTP" };
  }
}

async function clearOtp(userId: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.del(otpKey(userId), otpAttemptsKey(userId));
  } else {
    memoryOtpStore.delete(userId);
  }
}

async function incrAttempts(userId: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.incr(otpAttemptsKey(userId));
    await redis.expire(otpAttemptsKey(userId), OTP_TTL_SECONDS);
  } else {
    const m = memoryOtpStore.get(userId);
    if (m) m.attempts++;
  }
}

async function incrRateCounter(userId: string): Promise<number> {
  const redis = getRedisClient();
  if (redis) {
    const count = await redis.incr(otpRateKey(userId));
    if (count === 1) {
      await redis.expire(otpRateKey(userId), OTP_RATE_LIMIT_TTL_SECONDS);
    }
    return count;
  } else {
    const m = memoryOtpStore.get(userId);
    const newCount = (m?.rateCount ?? 0) + 1;
    if (m) m.rateCount = newCount;
    return newCount;
  }
}

function generateSixDigitCode(): string {
  // Cryptographically random — Math.random is not safe for OTP entropy
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain || local.length <= 2) return email;
  return `${local[0]}${"*".repeat(Math.max(1, local.length - 2))}${local[local.length - 1]}@${domain}`;
}

// ── Audit Snapshot ─────────────────────────────────────────────────

export interface UserAuditSnapshot {
  email: string;
  clerkId: string | null;
  name: string | null;
  // MONEY-445: per-type asset values for admin triage without backup restore.
  totalAssetsAtDeleteINR: number | null;
  stocksValueAtDeleteINR: number | null;
  mutualFundsValueAtDeleteINR: number | null;
  positionsValueAtDeleteINR: number | null; // F&O
  totalTradedValueAtDeleteINR: number | null; // Lifetime tradebook volume
  holdingsCount: number;
  positionsCount: number; // F&O
  tradesCount: number;
  mutualFundsCount: number;
  paperPositionsCount: number;
  brokersConnected: string[];
  hadActiveSubscription: boolean;
  planAtDelete: string | null;
  dodoSubscriptionId: string | null;
  dodoCustomerId: string | null;
  // MONEY-144: operational engagement counts. Useful for churn analysis,
  // exit-survey correlation, and investor DD ("what did your churned
  // users actually do before churning?"). Not surfaced to the user.
  chatsCreatedCount: number;
  stocksResearchedCount: number;
  comparisonsCount: number;
  strategiesCount: number;
  backtestsRunCount: number;
  roastsGeneratedCount: number;
  fireScenariosCount: number;
  documentsUploadedCount: number;
  watchlistsCount: number;
  researchCreditsSpent: number;
}

/**
 * Read everything we need to populate the DeletedUserAudit row.
 * Runs BEFORE any deletion so the data is still there to snapshot.
 *
 * `totalAssetsAtDeleteINR` is the sum of:
 *   - holding.currentValue (last priced)
 *   - position.currentValue
 *   - mutualFund.currentValue
 * Falls back to null if no broker was connected (no portfolio existed).
 */
export async function captureUserAuditSnapshot(
  userId: string,
): Promise<ServiceResult<UserAuditSnapshot>> {
  try {
    const [
      user,
      subscription,
      holdings,
      trades,
      mfs,
      paperPositions,
      brokers,
      positions,
      // MONEY-144: operational engagement counts. ResearchSession is
      // fetched as a list so we can split single-symbol vs multi-symbol
      // counts client-side (Prisma can't filter array length on MongoDB).
      chatsCount,
      researchSessions,
      strategiesCount,
      roastsCount,
      fireScenariosCount,
      documentsCount,
      watchlistsCount,
      creditUsage,
    ] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, clerkId: true, name: true },
      }),
      prisma.subscription.findUnique({
        where: { userId },
        select: {
          planId: true,
          status: true,
          dodoSubscriptionId: true,
          dodoCustomerId: true,
        },
      }),
      prisma.holding.findMany({
        where: { userId },
        select: { currentValue: true },
      }),
      // MONEY-445: pull trade price+quantity so we can compute lifetime
      // traded volume for the audit row. Stored for future analytics/admin
      // surfaces (per scope clarification).
      prisma.trade.findMany({
        where: { userId },
        select: { price: true, quantity: true },
      }),
      prisma.mutualFund.findMany({
        where: { userId },
        select: { currentValue: true },
      }),
      prisma.paperPosition.count({ where: { userId } }),
      prisma.brokerConnection.findMany({
        where: { userId },
        select: { broker: true },
      }),
      // MONEY-445: F&O positions - current value (netQuantity * lastPrice)
      // into a dedicated bucket. Position model doesn't expose a single
      // currentValue field, so we read netQuantity + lastPrice and
      // multiply below.
      prisma.position.findMany({
        where: { userId },
        select: { netQuantity: true, lastPrice: true },
      }),
      // MONEY-144: operational counts
      prisma.chatHistory.count({ where: { userId } }),
      prisma.researchSession.findMany({
        where: { userId },
        select: { symbols: true, skill: true },
      }),
      prisma.customStrategy.count({ where: { userId } }),
      prisma.portfolioRoast.count({ where: { userId } }),
      prisma.fireScenario.count({ where: { userId } }),
      prisma.userDocument.count({ where: { userId } }),
      prisma.watchList.count({ where: { userId } }),
      prisma.creditUsage.findMany({
        where: { userId },
        select: { creditsUsed: true, action: true },
      }),
    ]);

    if (!user) {
      return { success: false, error: "User not found" };
    }

    const hasPortfolio = holdings.length + mfs.length + positions.length > 0;
    const stocksValue = holdings.reduce(
      (acc, h) => acc + (h.currentValue ?? 0),
      0,
    );
    const mfsValue = mfs.reduce((acc, m) => acc + (m.currentValue ?? 0), 0);
    const positionsValue = positions.reduce(
      (acc, p) => acc + (p.netQuantity ?? 0) * (p.lastPrice ?? 0),
      0,
    );
    const totalAssetsAtDeleteINR = hasPortfolio
      ? stocksValue + mfsValue + positionsValue
      : null;
    const totalTradedValueAtDeleteINR =
      trades.length > 0
        ? trades.reduce((acc, t) => acc + (t.price ?? 0) * (t.quantity ?? 0), 0)
        : null;

    // MONEY-144: split ResearchSession into stock vs comparison counts.
    // Multi-symbol sessions are comparison reports; single-symbol are
    // stock-only. Skill 'peer-comparison' is also treated as comparison.
    const stocksResearchedCount = researchSessions.filter(
      (r) => r.symbols.length === 1 && r.skill !== "peer-comparison",
    ).length;
    const comparisonsCount = researchSessions.filter(
      (r) => r.symbols.length > 1 || r.skill === "peer-comparison",
    ).length;

    // MONEY-144: backtest credit-usage rows; "backtest" appears in
    // action strings like "strategy_backtest", "backtest_l2", etc.
    const backtestsRunCount = creditUsage.filter((c) =>
      c.action?.toLowerCase().includes("backtest"),
    ).length;

    const researchCreditsSpent = creditUsage.reduce(
      (acc, c) => acc + (c.creditsUsed ?? 0),
      0,
    );

    return {
      success: true,
      data: {
        email: user.email,
        clerkId: user.clerkId,
        name: user.name,
        totalAssetsAtDeleteINR,
        stocksValueAtDeleteINR: holdings.length > 0 ? stocksValue : null,
        mutualFundsValueAtDeleteINR: mfs.length > 0 ? mfsValue : null,
        positionsValueAtDeleteINR: positions.length > 0 ? positionsValue : null,
        totalTradedValueAtDeleteINR,
        holdingsCount: holdings.length,
        positionsCount: positions.length,
        tradesCount: trades.length,
        mutualFundsCount: mfs.length,
        paperPositionsCount: paperPositions,
        brokersConnected: brokers.map((b) => b.broker),
        hadActiveSubscription:
          !!subscription && subscription.status === "ACTIVE",
        planAtDelete: subscription?.planId ?? null,
        dodoSubscriptionId: subscription?.dodoSubscriptionId ?? null,
        dodoCustomerId: subscription?.dodoCustomerId ?? null,
        // MONEY-144: operational engagement counts
        chatsCreatedCount: chatsCount,
        stocksResearchedCount,
        comparisonsCount,
        strategiesCount,
        backtestsRunCount,
        roastsGeneratedCount: roastsCount,
        fireScenariosCount,
        documentsUploadedCount: documentsCount,
        watchlistsCount,
        researchCreditsSpent,
      },
    };
  } catch (error) {
    logger.error({ error, userId }, "captureUserAuditSnapshot failed");
    return { success: false, error: "Failed to capture audit snapshot" };
  }
}

// ── Dodo Cancel ────────────────────────────────────────────────────

export interface DodoCancelResult {
  cancelled: boolean;
  dodoCancelledAt: Date | null;
  errorMessage: string | null;
}

/**
 * Cancel the user's active Dodo subscription via the Payments API.
 * Best-effort: on failure we log + return errorMessage so the audit row
 * captures it. We do NOT block account deletion on a Dodo outage — better
 * to let support follow up than to leave the user unable to delete.
 */
export async function cancelDodoSubscription(
  dodoSubscriptionId: string | null,
): Promise<DodoCancelResult> {
  if (!dodoSubscriptionId) {
    return { cancelled: false, dodoCancelledAt: null, errorMessage: null };
  }
  if (!isDodoConfigured()) {
    return {
      cancelled: false,
      dodoCancelledAt: null,
      errorMessage: "Dodo Payments not configured",
    };
  }

  try {
    const dodo = getDodoClient();
    // Dodo SDK exposes subscription updates via `subscriptions.update`
    // (status: "cancelled"). Sending the cancel intent works without
    // referencing a specific endpoint version.
    await dodo.subscriptions.update(dodoSubscriptionId, {
      status: "cancelled",
    });
    logger.info({ dodoSubscriptionId }, "Dodo subscription cancelled");
    return {
      cancelled: true,
      dodoCancelledAt: new Date(),
      errorMessage: null,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Dodo cancel failed";
    logger.error(
      { error, dodoSubscriptionId },
      "Failed to cancel Dodo subscription",
    );
    return {
      cancelled: false,
      dodoCancelledAt: null,
      errorMessage,
    };
  }
}

// ── Queue: sync portion run inside the server action ──────────────

export interface QueueDeletionInput {
  userId: string;
  deletedBy: "user" | "admin" | "system";
  adminUserId?: string;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface QueuedDeletion {
  auditId: string;
  /** Snapshot of the user — caller publishes this to Pub/Sub for the worker. */
  snapshot: UserAuditSnapshot;
}

/**
 * Phase 1 of account deletion (runs synchronously in the server action):
 *   - captures the audit snapshot (assets value, brokers, plan, etc.)
 *   - writes a DeletedUserAudit row with status="PENDING"
 *   - returns the snapshot so the caller can publish a Pub/Sub job
 *
 * Crucially, NO destructive operations happen here. The user still exists
 * after this returns successfully — the worker picks up the job and
 * performs Dodo cancel → DB cascade → Clerk delete → email send.
 *
 * The pre-written audit row means that even if Pub/Sub publish fails or
 * the worker never runs, we have a permanent record of who requested
 * deletion and what their portfolio looked like at that moment.
 */
export async function queueAccountDeletion(
  input: QueueDeletionInput,
): Promise<ServiceResult<QueuedDeletion>> {
  const { userId, deletedBy, adminUserId, reason, ipAddress, userAgent } =
    input;

  try {
    const snapshotResult = await captureUserAuditSnapshot(userId);
    if (!snapshotResult.success) return snapshotResult;
    const snap = snapshotResult.data;

    const auditRow = await prisma.deletedUserAudit.create({
      data: {
        email: snap.email,
        clerkId: snap.clerkId,
        name: snap.name,
        totalAssetsAtDeleteINR: snap.totalAssetsAtDeleteINR,
        holdingsCount: snap.holdingsCount,
        tradesCount: snap.tradesCount,
        mutualFundsCount: snap.mutualFundsCount,
        paperPositionsCount: snap.paperPositionsCount,
        brokersConnected: snap.brokersConnected,
        hadActiveSubscription: snap.hadActiveSubscription,
        planAtDelete: snap.planAtDelete,
        dodoSubscriptionId: snap.dodoSubscriptionId,
        dodoCustomerId: snap.dodoCustomerId,
        deletedBy,
        adminUserId,
        reason,
        ipAddress,
        userAgent,
        status: "PENDING",
      },
      select: { id: true },
    });

    logger.info(
      {
        userId,
        auditId: auditRow.id,
        email: snap.email,
        deletedBy,
        totalAssetsINR: snap.totalAssetsAtDeleteINR,
        brokers: snap.brokersConnected.length,
      },
      "Account deletion queued",
    );

    return {
      success: true,
      data: { auditId: auditRow.id, snapshot: snap },
    };
  } catch (error) {
    logger.error({ error, userId, deletedBy }, "queueAccountDeletion failed");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to queue delete",
    };
  }
}

// ── Process: worker-side cleanup ───────────────────────────────────

export interface ProcessDeletionInput {
  auditId: string;
  userId: string;
  dodoSubscriptionId: string | null;
}

/**
 * Phase 2 (runs in the worker): the destructive cleanup.
 *
 * Order is load-bearing:
 *   1. Cancel Dodo subscription (best-effort, captured in audit)
 *   2. Clear encrypted broker creds FIRST inside the tx so partial
 *      cascade still leaves no plaintext key material in the DB
 *   3. User.delete cascades the ~30 child models via onDelete:Cascade
 *   4. Flip audit row to status=COMPLETED with per-step timestamps
 *
 * Returns the updated audit so the caller (worker route) can decide
 * whether to send the confirmation email. On failure the audit row is
 * flipped to status=FAILED with deletionError, and the message bounces
 * via Pub/Sub retry.
 */
export async function processAccountDeletion(
  input: ProcessDeletionInput,
): Promise<
  ServiceResult<{ cancelledDodo: boolean; dodoCancelError: string | null }>
> {
  const { auditId, userId, dodoSubscriptionId } = input;

  try {
    // 1. Dodo cancel (best-effort)
    const dodoResult = await cancelDodoSubscription(dodoSubscriptionId);

    // 2 + 3: atomic cred wipe + cascade delete
    await prisma.$transaction(
      async (tx) => {
        // MONEY-654: clear the REQUIRED, non-cascading relations first. Their
        // `user` relation is required (no SetNull), so on User.delete Prisma
        // raises a Restrict error and the whole cascade fails — leaving the user
        // un-deletable (the PortfolioRoast/etc. orphan-block). Their aggregate
        // counts are already preserved in the audit snapshot above. GstInvoice is
        // intentionally NOT cleared: its relation is OPTIONAL, so it SetNulls and
        // the tax record is retained for compliance.
        await tx.portfolioRoast.deleteMany({ where: { userId } });
        await tx.comparisonSession.deleteMany({ where: { userId } });
        await tx.customStrategy.deleteMany({ where: { userId } });
        await tx.customIndicator.deleteMany({ where: { userId } });
        await tx.scanResult.deleteMany({ where: { userId } });
        await tx.brokerConnection.deleteMany({ where: { userId } });
        await tx.user.delete({ where: { id: userId } }); // cascades the remaining ~30
      },
      // MONEY-654: a full cascade across ~30 child models can exceed Prisma's
      // 5s interactive-transaction default and abort mid-delete.
      { timeout: 30_000 },
    );

    // 4. Stamp the audit row
    await prisma.deletedUserAudit.update({
      where: { id: auditId },
      data: {
        dodoCancelledAt: dodoResult.dodoCancelledAt,
        dodoCancelError: dodoResult.errorMessage,
        dbHardDeletedAt: new Date(),
        status: "COMPLETED",
      },
    });

    logger.info(
      { userId, auditId, cancelledDodo: dodoResult.cancelled },
      "Account deletion processed",
    );

    return {
      success: true,
      data: {
        cancelledDodo: dodoResult.cancelled,
        dodoCancelError: dodoResult.errorMessage,
      },
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Process delete failed";
    // Mark audit as FAILED so admin can triage (status index covers this)
    await prisma.deletedUserAudit
      .update({
        where: { id: auditId },
        data: {
          status: "FAILED",
          deletionError: errorMessage,
          retryCount: { increment: 1 },
        },
      })
      .catch(() => {
        // Audit row itself missing — fatal, log only
        logger.error(
          { auditId, userId },
          "Could not update audit row to FAILED",
        );
      });
    logger.error({ error, userId, auditId }, "processAccountDeletion failed");
    return { success: false, error: errorMessage };
  }
}

/**
 * Stamp the audit row when the confirmation email has been delivered
 * (or attempted — Resend failures don't block the audit completing).
 */
export async function markDeletionEmailSent(auditId: string): Promise<void> {
  await prisma.deletedUserAudit
    .update({
      where: { id: auditId },
      data: { confirmationEmailSentAt: new Date() },
    })
    .catch((err) => {
      logger.warn({ err, auditId }, "Could not stamp emailSentAt");
    });
}

/**
 * Stamp the audit row when Clerk user delete succeeds (Phase 6 - the
 * 24h sweep). Different from `markClerkUserLocked` which fires in
 * Phase 1.
 */
export async function markClerkUserDeleted(auditId: string): Promise<void> {
  await prisma.deletedUserAudit
    .update({
      where: { id: auditId },
      data: { clerkUserDeletedAt: new Date() },
    })
    .catch((err) => {
      logger.warn({ err, auditId }, "Could not stamp clerkUserDeletedAt");
    });
}

/**
 * MONEY-144 Phase 1: stamp the audit row when Clerk user is LOCKED.
 * Also stores `clerkDeleteScheduledFor` (lockedAt + 24h) so the hourly
 * sweep worker can pick it up and call Clerk's deleteUser API to
 * release the email back into the signup pool.
 */
export const CLERK_DELETE_LOCK_HOURS = 24;

export async function markClerkUserLocked(auditId: string): Promise<void> {
  const now = new Date();
  const scheduledFor = new Date(
    now.getTime() + CLERK_DELETE_LOCK_HOURS * 60 * 60 * 1000,
  );
  await prisma.deletedUserAudit
    .update({
      where: { id: auditId },
      data: {
        clerkLockedAt: now,
        clerkDeleteScheduledFor: scheduledFor,
      },
    })
    .catch((err) => {
      logger.warn({ err, auditId }, "Could not stamp clerkLockedAt");
    });
}

/**
 * MONEY-144 Phase 6: called by the clerk-delete-sweep worker after a
 * successful `Clerk.users.deleteUser` call (or after a 404 -
 * already gone). Stamps clerkUserDeletedAt + flips status to COMPLETED.
 */
export async function completeDeletionAfterClerkPurge(
  auditId: string,
): Promise<void> {
  await prisma.deletedUserAudit
    .update({
      where: { id: auditId },
      data: {
        clerkUserDeletedAt: new Date(),
        status: "COMPLETED",
      },
    })
    .catch((err) => {
      logger.error(
        { err, auditId },
        "Could not stamp COMPLETED after Clerk purge",
      );
    });
}

/**
 * MONEY-144: query the hot-path index for audit rows whose 24h lock
 * window has elapsed. Used by the hourly sweep worker.
 */
export async function findClerkDeletionsReadyForPurge(options: {
  now?: Date;
  take?: number;
}): Promise<
  ServiceResult<
    Array<{
      id: string;
      clerkId: string | null;
      email: string;
      clerkLockedAt: Date | null;
    }>
  >
> {
  try {
    const now = options.now ?? new Date();
    const take = Math.max(1, Math.min(options.take ?? 100, 500));
    const ready = await prisma.deletedUserAudit.findMany({
      where: {
        status: "LOCKED",
        clerkDeleteScheduledFor: { lte: now },
      },
      select: {
        id: true,
        clerkId: true,
        email: true,
        clerkLockedAt: true,
      },
      orderBy: { clerkDeleteScheduledFor: "asc" },
      take,
    });
    return { success: true, data: ready };
  } catch (error) {
    logger.error({ error }, "findClerkDeletionsReadyForPurge failed");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Query failed",
    };
  }
}

// ── Legacy synchronous path (admin / system cleanup) ───────────────

export interface HardDeleteInput extends QueueDeletionInput {}
export interface HardDeleteResult {
  auditId: string;
  cancelledDodo: boolean;
  dodoCancelError: string | null;
}

/**
 * Synchronous hard-delete used by Clerk webhook user.deleted (legacy
 * Clerk-dashboard-initiated deletes) where there's no Pub/Sub job to
 * publish. Queues + processes in one shot.
 */
export async function hardDeleteUser(
  input: HardDeleteInput,
): Promise<ServiceResult<HardDeleteResult>> {
  const queued = await queueAccountDeletion(input);
  if (!queued.success) return queued;
  const processed = await processAccountDeletion({
    auditId: queued.data.auditId,
    userId: input.userId,
    dodoSubscriptionId: queued.data.snapshot.dodoSubscriptionId,
  });
  if (!processed.success) {
    return { success: false, error: processed.error };
  }
  return {
    success: true,
    data: {
      auditId: queued.data.auditId,
      cancelledDodo: processed.data.cancelledDodo,
      dodoCancelError: processed.data.dodoCancelError,
    },
  };
}

// ── MONEY-445 — async pipeline (worker-driven, idempotent per phase) ──
//
// The user-initiated delete flow now publishes a Pub/Sub message and
// returns immediately; the worker owns every step including the audit
// row. Each helper below is idempotent so a Pub/Sub re-delivery (after
// a transient failure) is safe.

export interface DeletionPipelineInput {
  userId: string;
  clerkId: string | null;
  email: string;
  name: string | null;
  deletedBy: "user" | "admin" | "system";
  adminUserId?: string;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Per-phase timestamps + identity. Returned by `getOrCreateInProgressAudit`
 * and re-fetched by phase helpers that need fresh snapshot data.
 */
export interface AuditPipelineRow {
  id: string;
  status: string;
  clerkUserDeletedAt: Date | null;
  snapshotCapturedAt: Date | null;
  dodoCancelledAt: Date | null;
  confirmationEmailSentAt: Date | null;
  dbHardDeletedAt: Date | null;
  dodoSubscriptionId: string | null;
  name: string | null;
  email: string;
}

const PIPELINE_AUDIT_SELECT = {
  id: true,
  status: true,
  clerkUserDeletedAt: true,
  snapshotCapturedAt: true,
  dodoCancelledAt: true,
  confirmationEmailSentAt: true,
  dbHardDeletedAt: true,
  dodoSubscriptionId: true,
  name: true,
  email: true,
} as const;

/**
 * Worker's first action: find an in-flight audit row for this user, or
 * create one. Idempotent across Pub/Sub re-deliveries because we never
 * create a second PROCESSING row for the same clerkId/email.
 */
export async function getOrCreateInProgressAudit(
  input: DeletionPipelineInput,
): Promise<ServiceResult<AuditPipelineRow>> {
  try {
    // Match by clerkId first; fall back to email for legacy users with
    // no clerkId (Clerk dashboard-initiated deletes).
    const existing = await prisma.deletedUserAudit.findFirst({
      where: {
        status: { in: ["PENDING", "PROCESSING"] },
        OR: input.clerkId
          ? [{ clerkId: input.clerkId }, { email: input.email }]
          : [{ email: input.email }],
      },
      select: PIPELINE_AUDIT_SELECT,
      orderBy: { deletedAt: "desc" },
    });
    if (existing) {
      if (existing.status === "PENDING") {
        const updated = await prisma.deletedUserAudit.update({
          where: { id: existing.id },
          data: { status: "PROCESSING" },
          select: PIPELINE_AUDIT_SELECT,
        });
        return { success: true, data: updated };
      }
      return { success: true, data: existing };
    }
    const created = await prisma.deletedUserAudit.create({
      data: {
        email: input.email,
        clerkId: input.clerkId,
        name: input.name,
        deletedBy: input.deletedBy,
        adminUserId: input.adminUserId,
        reason: input.reason,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        status: "PROCESSING",
      },
      select: PIPELINE_AUDIT_SELECT,
    });
    return { success: true, data: created };
  } catch (error) {
    logger.error(
      { error, userId: input.userId, clerkId: input.clerkId },
      "getOrCreateInProgressAudit failed",
    );
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to create audit row",
    };
  }
}

/**
 * Phase 2 helper: read fresh snapshot data, write it to the audit row,
 * stamp `snapshotCapturedAt`. Idempotent — skipped if already stamped.
 */
export async function captureSnapshotIntoAudit(
  auditId: string,
  userId: string,
): Promise<ServiceResult<{ skipped: boolean }>> {
  try {
    const audit = await prisma.deletedUserAudit.findUnique({
      where: { id: auditId },
      select: { snapshotCapturedAt: true },
    });
    if (!audit) return { success: false, error: "Audit row missing" };
    if (audit.snapshotCapturedAt)
      return { success: true, data: { skipped: true } };

    const snap = await captureUserAuditSnapshot(userId);
    if (!snap.success) {
      // User row already gone (e.g. legacy dual-delete) → mark snapshot
      // captured to unblock the rest of the pipeline.
      if (snap.error === "User not found") {
        await prisma.deletedUserAudit.update({
          where: { id: auditId },
          data: { snapshotCapturedAt: new Date() },
        });
        return { success: true, data: { skipped: true } };
      }
      return snap;
    }
    await prisma.deletedUserAudit.update({
      where: { id: auditId },
      data: {
        name: snap.data.name,
        totalAssetsAtDeleteINR: snap.data.totalAssetsAtDeleteINR,
        stocksValueAtDeleteINR: snap.data.stocksValueAtDeleteINR,
        mutualFundsValueAtDeleteINR: snap.data.mutualFundsValueAtDeleteINR,
        positionsValueAtDeleteINR: snap.data.positionsValueAtDeleteINR,
        totalTradedValueAtDeleteINR: snap.data.totalTradedValueAtDeleteINR,
        holdingsCount: snap.data.holdingsCount,
        positionsCount: snap.data.positionsCount,
        tradesCount: snap.data.tradesCount,
        mutualFundsCount: snap.data.mutualFundsCount,
        paperPositionsCount: snap.data.paperPositionsCount,
        brokersConnected: snap.data.brokersConnected,
        hadActiveSubscription: snap.data.hadActiveSubscription,
        planAtDelete: snap.data.planAtDelete,
        dodoSubscriptionId: snap.data.dodoSubscriptionId,
        dodoCustomerId: snap.data.dodoCustomerId,
        // MONEY-144: operational engagement counts
        chatsCreatedCount: snap.data.chatsCreatedCount,
        stocksResearchedCount: snap.data.stocksResearchedCount,
        comparisonsCount: snap.data.comparisonsCount,
        strategiesCount: snap.data.strategiesCount,
        backtestsRunCount: snap.data.backtestsRunCount,
        roastsGeneratedCount: snap.data.roastsGeneratedCount,
        fireScenariosCount: snap.data.fireScenariosCount,
        documentsUploadedCount: snap.data.documentsUploadedCount,
        watchlistsCount: snap.data.watchlistsCount,
        researchCreditsSpent: snap.data.researchCreditsSpent,
        snapshotCapturedAt: new Date(),
      },
    });
    return { success: true, data: { skipped: false } };
  } catch (error) {
    logger.error({ error, auditId, userId }, "captureSnapshotIntoAudit failed");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Snapshot failed",
    };
  }
}

/**
 * Phase 3 helper: cancel the Dodo subscription captured by the snapshot
 * (Phase 2 must have run already). Idempotent — skipped if already
 * stamped or if user had no paid subscription.
 */
export async function cancelDodoFromAudit(
  auditId: string,
): Promise<ServiceResult<{ skipped: boolean }>> {
  try {
    const audit = await prisma.deletedUserAudit.findUnique({
      where: { id: auditId },
      select: { dodoCancelledAt: true, dodoSubscriptionId: true },
    });
    if (!audit) return { success: false, error: "Audit row missing" };
    if (audit.dodoCancelledAt)
      return { success: true, data: { skipped: true } };
    if (!audit.dodoSubscriptionId) {
      // No paid sub to cancel — stamp now so the phase is marked done.
      await prisma.deletedUserAudit.update({
        where: { id: auditId },
        data: { dodoCancelledAt: new Date() },
      });
      return { success: true, data: { skipped: true } };
    }
    const result = await cancelDodoSubscription(audit.dodoSubscriptionId);
    await prisma.deletedUserAudit.update({
      where: { id: auditId },
      data: {
        dodoCancelledAt: result.dodoCancelledAt ?? new Date(),
        dodoCancelError: result.errorMessage,
      },
    });
    return { success: true, data: { skipped: false } };
  } catch (error) {
    logger.error({ error, auditId }, "cancelDodoFromAudit failed");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Dodo cancel failed",
    };
  }
}

/**
 * Phase 5 helper: hard-delete the User row. Cascades to all child
 * collections via Prisma onDelete: Cascade. Idempotent — skipped if
 * the user is already gone.
 */
export async function finalizeUserDelete(
  auditId: string,
  userId: string,
): Promise<ServiceResult<{ skipped: boolean }>> {
  try {
    const audit = await prisma.deletedUserAudit.findUnique({
      where: { id: auditId },
      select: { dbHardDeletedAt: true },
    });
    if (!audit) return { success: false, error: "Audit row missing" };
    if (audit.dbHardDeletedAt)
      return { success: true, data: { skipped: true } };
    try {
      // MONEY-654: clear the REQUIRED, non-cascading relations first — their
      // `user` relation is required (no SetNull), so User.delete raises a Restrict
      // error and the whole cascade fails. THIS is the orphan-block that left
      // Clerk-deleted users stuck in the DB (every deletion path — web, admin,
      // Clerk sweep — funnels through here). Counts are already in the audit
      // snapshot; GstInvoice is intentionally retained (optional → SetNull). Plain
      // (non-transactional) deletes — the worker path deliberately avoids a tx to
      // dodge Prisma's 5s cascade timeout.
      await prisma.portfolioRoast.deleteMany({ where: { userId } });
      await prisma.comparisonSession.deleteMany({ where: { userId } });
      await prisma.customStrategy.deleteMany({ where: { userId } });
      await prisma.customIndicator.deleteMany({ where: { userId } });
      await prisma.scanResult.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    } catch (err) {
      // P2025 = record to delete does not exist (already deleted)
      const code = (err as { code?: string })?.code;
      if (code !== "P2025") throw err;
    }
    // MONEY-144: status terminates at LOCKED here, NOT COMPLETED. The
    // clerk-delete-sweep worker flips to COMPLETED after the 24h lock
    // window elapses and the Clerk user is finally purged.
    await prisma.deletedUserAudit.update({
      where: { id: auditId },
      data: {
        dbHardDeletedAt: new Date(),
        status: "LOCKED",
      },
    });
    return { success: true, data: { skipped: false } };
  } catch (error) {
    logger.error({ error, auditId, userId }, "finalizeUserDelete failed");
    return {
      success: false,
      error: error instanceof Error ? error.message : "User delete failed",
    };
  }
}

/**
 * Stamp the audit FAILED + capture the error + bump retry count.
 * Worker calls this in its outer catch so admin sees the actual phase
 * that failed.
 */
export async function markDeletionFailed(
  auditId: string,
  errorMessage: string,
): Promise<void> {
  await prisma.deletedUserAudit
    .update({
      where: { id: auditId },
      data: {
        status: "FAILED",
        deletionError: errorMessage,
        retryCount: { increment: 1 },
      },
    })
    .catch((err) => {
      logger.error({ err, auditId }, "Could not mark audit FAILED");
    });
}
