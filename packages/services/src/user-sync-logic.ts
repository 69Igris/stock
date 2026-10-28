/**
 * Pure transaction body for the Clerk → DB user/subscription sync.
 *
 * Extracted out of `ensureUserAndSubscription` in `./user-sync.service.ts` so
 * the LIVE webhook path (`apps/web/app/api/webhooks/clerk/route.ts`) and the
 * unit test run the SAME find-or-create / back-fill / idempotency decision
 * logic. The service keeps ownership of opening the real `prisma.$transaction`
 * and of logging; this module is just the side-effect-free* control flow that
 * decides which `tx.*` writes happen and assembles the result.
 *
 * (*The `tx.*` calls are the transaction's effects, but they are injected via a
 * narrow structural interface, so this module imports neither Prisma nor any
 * I/O and can be exercised with a fake `tx` — no DB connection at import time,
 * no orphaned handles.)
 *
 * Previously this logic was inline in the service and asserted only indirectly:
 * the Clerk webhook e2e test STUBS `ensureUserAndSubscription` entirely, so the
 * resolution order (clerkId hit → email back-fill → create), the `needsLink`
 * short-circuit (don't re-write an unchanged row), and the Subscription
 * idempotency (never overwrite an existing sub) had no real-export coverage.
 */

import type { PlanType } from "@usemoney/database";

/** The User row shape this flow selects/returns (subset of the Prisma model). */
export interface UserSyncUserRow {
  id: string;
  email: string;
  clerkId: string | null;
  name: string | null;
  lastResendSyncAt: Date | null;
}

/** The Subscription row shape this flow selects/returns. */
export interface UserSyncSubscriptionRow {
  id: string;
  planId: PlanType;
  creditsLimit: number;
}

/**
 * Minimal structural view of the Prisma transaction client — ONLY the
 * `user`/`subscription` operations `ensureUserAndSubscription` actually calls.
 * Kept narrow (and `args`-typed loosely as the caller's own select objects) so
 * this module never imports `@usemoney/database`'s generated client.
 */
export interface UserSyncTx {
  user: {
    findUnique(args: {
      where: { clerkId: string } | { email: string };
      select: Record<string, boolean>;
    }): Promise<UserSyncUserRow | null>;
    update(args: {
      where: { id: string };
      data: { clerkId: string; name: string };
      select: Record<string, boolean>;
    }): Promise<UserSyncUserRow>;
    create(args: {
      data: { clerkId: string; email: string; name: string };
      select: Record<string, boolean>;
    }): Promise<UserSyncUserRow>;
  };
  subscription: {
    findUnique(args: {
      where: { userId: string };
      select: Record<string, boolean>;
    }): Promise<UserSyncSubscriptionRow | null>;
    create(args: {
      data: { userId: string } & Record<string, unknown>;
      select: Record<string, boolean>;
    }): Promise<UserSyncSubscriptionRow>;
  };
}

export interface UserSyncTxInput {
  clerkId: string;
  email: string;
  name: string;
}

export interface UserSyncTxResult {
  user: UserSyncUserRow;
  subscription: UserSyncSubscriptionRow;
  created: { user: boolean; subscription: boolean };
}

const USER_SELECT = {
  id: true,
  email: true,
  clerkId: true,
  name: true,
  lastResendSyncAt: true,
} as const;

const SUBSCRIPTION_SELECT = {
  id: true,
  planId: true,
  creditsLimit: true,
} as const;

/**
 * Resolve (or create) the User row, then ensure a Subscription row, inside a
 * caller-supplied transaction. Idempotent and order-stable:
 *
 *   1. clerkId match (fast path, @unique index).
 *   2. else email match → back-fill clerkId + refresh name, but ONLY when
 *      something actually changed (`needsLink`); an unchanged row is reused
 *      as-is (no needless write / updatedAt churn).
 *   3. else create a new User.
 *
 * Subscription is found by `userId`; an existing one is NEVER overwritten — we
 * only fill in a missing one with `defaultSubscription`. The per-row `created`
 * flags are returned for the caller's logging / reconciliation reporting.
 */
export async function runUserSyncTx(
  tx: UserSyncTx,
  input: UserSyncTxInput,
  defaultSubscription: Record<string, unknown>,
): Promise<UserSyncTxResult> {
  const { clerkId, email, name } = input;

  let userCreated = false;

  // 1. Fast path: clerkId hit.
  let user = await tx.user.findUnique({
    where: { clerkId },
    select: USER_SELECT,
  });

  // 2. Slow path: email match (back-fill clerkId / refresh name).
  if (!user) {
    const byEmail = await tx.user.findUnique({
      where: { email },
      select: USER_SELECT,
    });
    if (byEmail) {
      const needsLink = byEmail.clerkId !== clerkId || byEmail.name !== name;
      user = needsLink
        ? await tx.user.update({
            where: { id: byEmail.id },
            data: { clerkId, name },
            select: USER_SELECT,
          })
        : byEmail;
    }
  }

  // 3. Create new.
  if (!user) {
    user = await tx.user.create({
      data: { clerkId, email, name },
      select: USER_SELECT,
    });
    userCreated = true;
  }

  // 4. Find or create Subscription (idempotent on userId).
  let subscriptionCreated = false;
  let subscription = await tx.subscription.findUnique({
    where: { userId: user.id },
    select: SUBSCRIPTION_SELECT,
  });

  if (!subscription) {
    subscription = await tx.subscription.create({
      data: { userId: user.id, ...defaultSubscription },
      select: SUBSCRIPTION_SELECT,
    });
    subscriptionCreated = true;
  }

  return {
    user,
    subscription,
    created: { user: userCreated, subscription: subscriptionCreated },
  };
}
