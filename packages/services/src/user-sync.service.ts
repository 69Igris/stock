/**
 * User Sync Service (MONEY-144)
 *
 * Single source of truth for "Clerk user → DB User + Subscription row".
 * Consumed by:
 *   - apps/web/app/api/webhooks/clerk/route.ts on user.created / user.updated
 *   - scripts/backfill-clerk-user-sync.ts for the 227 historical users
 *   - workers/src/processors/clerk-reconcile.ts for ongoing weekly drift
 *
 * The old webhook created a User row but NEVER created a Subscription, so
 * 215/528 users had no subscription row (lazy-created on first AI use).
 * This helper writes both atomically inside a single Prisma transaction.
 */

import { prisma, type PlanType } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import type { ServiceResult } from "./types";
import { runUserSyncTx, type UserSyncTx } from "./user-sync-logic";

// ── Types ──────────────────────────────────────────────────────────

export interface ClerkUserSyncInput {
  /** Clerk user id (e.g. user_abc123) */
  clerkId: string;
  /** Primary email from Clerk */
  email: string;
  /** Display name (first + last, falls back to "Trader") */
  name: string;
}

export interface UserSyncResult {
  user: {
    id: string;
    email: string;
    clerkId: string | null;
    name: string | null;
    /**
     * Watermark for the real-time Resend contact sync (MONEY-523). `null`
     * means this user has never been synced to a Resend audience, so the
     * Clerk webhook should fire the welcome email + audience adds. Gating on
     * this durable field — instead of the transient "did the webhook create
     * the row?" flag — survives the race where a lazy `getOrCreateUser()`
     * server-action path creates the row before the webhook lands.
     */
    lastResendSyncAt: Date | null;
  };
  subscription: {
    id: string;
    planId: PlanType;
    creditsLimit: number;
  };
  /** Per-row creation flags — useful for logging + reconciliation reporting */
  created: { user: boolean; subscription: boolean };
}

// ── Constants ──────────────────────────────────────────────────────

/**
 * Default FREE subscription shape — kept identical to the lazy-create paths
 * in credit.service.ts (ensureSubscription) and subscription.service.ts
 * (getSubscription) so a user backfilled by this helper looks identical to
 * a user who hit the lazy path. Drift here will cause access-control bugs.
 */
export const DEFAULT_FREE_SUBSCRIPTION = {
  planId: "FREE" as PlanType,
  status: "ACTIVE" as const,
  aiQueriesUsed: 0,
  aiQueriesLimit: 0,
  addons: [] as string[],
  fastQueriesUsed: 0,
  fastQueriesLimit: 0,
  advancedQueriesUsed: 0,
  advancedQueriesLimit: 0,
  creditsUsed: 0,
  creditsLimit: 5,
  packCreditsUsed: 0,
  packCreditsLimit: 0,
};

/**
 * Transient transaction errors worth retrying. The Clerk `user.created` webhook
 * races the lazy `getOrCreateUser()` server action (both create the same new
 * row), which MongoDB surfaces as a write conflict — Prisma **P2034**
 * ("Transaction failed due to a write conflict or a deadlock. Please retry your
 * transaction.") or, if the create lost the race just after the find, **P2002**
 * (unique constraint). On retry the `findUnique` resolves to the now-existing
 * row, so the transaction completes idempotently. (MONEY-883)
 */
export function isRetryableSyncError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "P2034" || code === "P2002") return true;
  const msg = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    msg.includes("write conflict") || // Prisma P2034 text
    msg.includes("writeconflict") || // MongoDB's raw error label
    msg.includes("deadlock") ||
    msg.includes("please retry") ||
    msg.includes("transaction failed")
  );
}

// ── Core helper ────────────────────────────────────────────────────

/**
 * Ensure a User row AND a Subscription row exist for a Clerk identity.
 *
 * Idempotent — safe to call repeatedly with the same input. Inside a single
 * Prisma `$transaction` so partial-failure (User written, Subscription
 * skipped) can't happen.
 *
 * Resolution order for the User row:
 *   1. clerkId match (fast path, hits @unique index)
 *   2. email match — back-fills clerkId if the user pre-existed (e.g. created
 *      by a server action before the webhook landed)
 *   3. Create a new User
 *
 * Subscription is upserted by `userId` (Subscription.userId is @unique).
 * Existing rows are NEVER overwritten — we only fill in missing ones.
 */
export async function ensureUserAndSubscription(
  input: ClerkUserSyncInput,
): Promise<ServiceResult<UserSyncResult>> {
  const { clerkId, email, name } = input;

  if (!clerkId || !email) {
    return {
      success: false,
      error: "clerkId and email are required",
    };
  }

  // Retry transient write conflicts (P2034) from the webhook ↔ lazy-create race
  // (see isRetryableSyncError). The transaction body is idempotent, so a retry
  // simply finds the row the other path just created.
  const MAX_ATTEMPTS = 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await prisma.$transaction((tx) =>
        // The find-or-create / back-fill / idempotency decision flow lives in
        // ./user-sync-logic so the live path and the unit test run identical
        // logic. `tx` is structurally the UserSyncTx subset the helper needs.
        runUserSyncTx(
          tx as unknown as UserSyncTx,
          { clerkId, email, name },
          DEFAULT_FREE_SUBSCRIPTION,
        ),
      );

      logger.info(
        {
          clerkId,
          email,
          userId: result.user.id,
          userCreated: result.created.user,
          subscriptionCreated: result.created.subscription,
          attempt,
        },
        "ensureUserAndSubscription completed",
      );

      return { success: true, data: result };
    } catch (error) {
      lastError = error;
      if (isRetryableSyncError(error) && attempt < MAX_ATTEMPTS) {
        logger.warn(
          { clerkId, email, attempt },
          "ensureUserAndSubscription transient write conflict — retrying",
        );
        await new Promise((resolve) => setTimeout(resolve, 40 * attempt));
        continue;
      }
      break;
    }
  }

  logger.error(
    { error: lastError, clerkId, email },
    "ensureUserAndSubscription failed",
  );
  return {
    success: false,
    error: lastError instanceof Error ? lastError.message : "Sync failed",
  };
}

// ── Reconciliation helpers ─────────────────────────────────────────

export interface SyncDriftSummary {
  totalClerkUsers: number;
  totalDbUsers: number;
  missingUsers: number; // Clerk users with no DB row
  missingSubscriptions: number; // DB users with no Subscription row
  driftPercent: number;
}

/**
 * Count DB users that don't have a Subscription row.
 * Used by the weekly reconciliation worker + the backfill script's dry-run.
 */
export async function countMissingSubscriptions(): Promise<number> {
  // MongoDB pattern: users with no matching Subscription
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, subscription: { select: { id: true } } },
  });
  return users.filter((u) => !u.subscription).length;
}
