import prisma from "@/lib/prisma";
import { currentUser } from "@clerk/nextjs/server";
import { dbLogger as logger } from "@usemoney/logger";
import { resolveFullName, extractEmail, needsNameUpdate } from "./user-logic";

export interface DbUser {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * In-memory cache for getOrCreateDbUser to avoid hitting DB on every server action.
 * Map<clerkUserId, { user, expiresAt }>
 */
const userCache = new Map<string, { user: DbUser; expiresAt: number }>();
const USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedUser(clerkUserId: string): DbUser | null {
  const entry = userCache.get(clerkUserId);
  if (entry && Date.now() < entry.expiresAt) {
    return entry.user;
  }
  if (entry) {
    userCache.delete(clerkUserId);
  }
  return null;
}

function setCachedUser(clerkUserId: string, user: DbUser): void {
  userCache.set(clerkUserId, {
    user,
    expiresAt: Date.now() + USER_CACHE_TTL_MS,
  });
}

/**
 * Get or create a user in the database based on Clerk user.
 * Uses clerkId as primary lookup, falls back to email.
 * Handles race conditions with retry on unique constraint violation.
 *
 * PERF: For existing users (99% of requests), this is 1 fast DB query.
 * currentUser() (expensive Clerk API call) is only called when creating
 * a new user or when the user isn't found by clerkId.
 */
/**
 * True if the thrown value is Clerk's 404 — i.e. the requesting browser
 * still has a valid session cookie but the underlying Clerk user is gone
 * (typical window: between server-side hard-delete and the client's
 * signOut() completing). This is expected, not an error worth logging
 * at ERROR level.
 */
function isClerkUserNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; code?: string; clerkError?: boolean };
  return (
    e.clerkError === true &&
    (e.status === 404 || e.code === "resource_not_found")
  );
}

/**
 * MONEY-445 / MONEY-144 — guard against phantom-user creation while a
 * delete-account pipeline is in flight. Refuses to materialise a User
 * row if a DeletedUserAudit exists in any in-flight state:
 *
 *   - PENDING/PROCESSING: account-deletion worker is mid-pipeline
 *   - LOCKED: account-deletion worker done; Clerk user is locked
 *     pending the 24h purge sweep
 *
 * Returning null upstream short-circuits the auto-create-on-miss path
 * that previously caused TermsGate to pop the modal post-delete.
 */
async function hasPendingDeletion(clerkUserId: string): Promise<boolean> {
  try {
    const audit = await prisma.deletedUserAudit.findFirst({
      where: {
        clerkId: clerkUserId,
        status: { in: ["PENDING", "PROCESSING", "LOCKED"] },
      },
      select: { id: true },
    });
    return audit !== null;
  } catch {
    // Don't block on the audit lookup; the worst case is we re-create a
    // phantom for one request, which the worker will clean up.
    return false;
  }
}

export async function getOrCreateDbUser(
  clerkUserId: string
): Promise<DbUser | null> {
  // Check in-memory cache first (helps within same process/warm function)
  const cached = getCachedUser(clerkUserId);
  if (cached) {
    return cached;
  }

  try {
    // 1. Fast path: find by clerkId (single indexed query, no Clerk API call)
    const existing = await prisma.user.findUnique({
      where: { clerkId: clerkUserId },
      select: USER_SELECT,
    });

    if (existing) {
      setCachedUser(clerkUserId, existing);
      return existing;
    }

    // MONEY-445 — refuse to recreate a user row while a deletion is in
    // flight. Must run BEFORE the slow path so we don't waste a Clerk
    // API call on a doomed lookup.
    if (await hasPendingDeletion(clerkUserId)) {
      logger.info(
        { clerkUserId },
        "Skipping user materialisation - deletion in progress"
      );
      return null;
    }

    // 2. Slow path (new user or legacy user): call Clerk API for user data.
    // currentUser() can throw a 404 _ClerkAPIResponseError when the
    // session cookie outlives the underlying Clerk user (post-delete
    // race). Treat that as "no user" instead of letting it bubble.
    let clerkUser;
    try {
      clerkUser = await currentUser();
    } catch (err) {
      if (isClerkUserNotFound(err)) {
        logger.info(
          { clerkUserId },
          "Clerk user 404 (likely post-delete) — resolving as anonymous"
        );
        return null;
      }
      throw err;
    }
    if (!clerkUser) return null;

    const email = extractEmail(clerkUser);
    if (!email) return null;

    const fullName = resolveFullName(clerkUser);

    // 3. Try to find by email (for users created before clerkId was set)
    let user = (await prisma.user.findUnique({
      where: { email },
      select: { ...USER_SELECT, clerkId: true } as Record<string, boolean>,
    })) as (DbUser & { clerkId?: string | null }) | null;

    if (user) {
      // Backfill clerkId and update name if needed
      const userWithClerkId = user as DbUser & { clerkId?: string | null };
      if (
        userWithClerkId.clerkId !== clerkUserId ||
        needsNameUpdate(user.name, fullName)
      ) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { clerkId: clerkUserId, name: fullName },
          select: USER_SELECT,
        });
      }
      setCachedUser(clerkUserId, user);
      return user;
    }

    // 4. Create new user with clerkId
    try {
      user = await prisma.user.create({
        data: {
          clerkId: clerkUserId,
          email,
          name: fullName,
        },
        select: USER_SELECT,
      });
      setCachedUser(clerkUserId, user);
      return user;
    } catch (createError: unknown) {
      // Race condition: another request created the user concurrently
      if (
        createError &&
        typeof createError === "object" &&
        "code" in createError &&
        (createError as { code: string }).code === "P2002"
      ) {
        // Retry lookup - the user now exists
        user =
          (await prisma.user.findUnique({
            where: { clerkId: clerkUserId },
            select: USER_SELECT,
          })) ||
          (await prisma.user.findUnique({
            where: { email },
            select: USER_SELECT,
          }));
        if (user) {
          setCachedUser(clerkUserId, user);
        }
        return user;
      }
      throw createError;
    }
  } catch (error) {
    logger.error({ error }, "Error in getOrCreateDbUser");
    return null;
  }
}

/**
 * Sync Clerk user data to database.
 * Uses clerkId for lookup, upserts by email as fallback.
 */
export async function syncClerkUserData(): Promise<DbUser | null> {
  try {
    const clerkUser = await currentUser();
    if (!clerkUser) return null;

    const email = extractEmail(clerkUser);
    if (!email) return null;

    const fullName = resolveFullName(clerkUser);

    // Try upsert by email, setting clerkId
    try {
      const user = await prisma.user.upsert({
        where: { email },
        update: {
          name: fullName,
          clerkId: clerkUser.id,
        },
        create: {
          clerkId: clerkUser.id,
          email,
          name: fullName,
        },
        select: USER_SELECT,
      });
      return user;
    } catch (upsertError: unknown) {
      // Race condition on clerkId unique constraint - user already exists
      if (
        upsertError &&
        typeof upsertError === "object" &&
        "code" in upsertError &&
        (upsertError as { code: string }).code === "P2002"
      ) {
        const user = await prisma.user.findUnique({
          where: { clerkId: clerkUser.id },
          select: USER_SELECT,
        });
        return user;
      }
      throw upsertError;
    }
  } catch (error) {
    logger.error({ error }, "Error in syncClerkUserData");
    return null;
  }
}

/**
 * Get user by ID
 */
export async function getUserById(userId: string): Promise<DbUser | null> {
  try {
    return await prisma.user.findUnique({
      where: { id: userId },
      select: USER_SELECT,
    });
  } catch (error) {
    logger.error({ error }, "Error in getUserById");
    return null;
  }
}
