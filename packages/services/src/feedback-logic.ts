/**
 * Feedback gating + attachment rules — pure logic (no Prisma).
 *
 * Extracted from `apps/web/lib/actions/feedback.ts` + `apps/web/lib/feedback/
 * attachments.ts` so the two SECURITY-relevant decisions ship as testable pure
 * functions and are shared by the web action and the API service:
 *
 *   - the plan-based monthly submission limit ({@link checkFeedbackQuota}), and
 *   - the IDOR attachment guard ({@link filterOwnedImagePaths}) — a caller may
 *     only persist GCS paths under their own `feedback/{userId}/` prefix, so a
 *     forged path (another user's upload, or any bucket object) can never reach
 *     the DB (the thread view later mints signed URLs for stored paths).
 *
 * @see packages/services/src/feedback.service.ts
 * @see packages/services/__tests__/feedback-service.test.ts
 */

/**
 * Allow-listed feedback types — mirrors the Prisma `FeedbackType` enum. Kept as
 * a Prisma-free string-literal union here (this module never imports
 * `@prisma/client`) so the service can NARROW a route's `string` input to a
 * value assignable to `prisma.feedback.create`'s enum column without an `as`
 * cast, AND reject a forged/unknown type before the write (defence in depth —
 * the route Zod-validates too).
 */
export const FEEDBACK_TYPES = [
  "BUG",
  "FEATURE_REQUEST",
  "IMPROVEMENT",
  "QUESTION",
  "OTHER",
] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/** Narrowing guard for the feedback type (rejects unknown/garbage). */
export function isValidFeedbackType(t: unknown): t is FeedbackType {
  return (
    typeof t === "string" && (FEEDBACK_TYPES as readonly string[]).includes(t)
  );
}

/**
 * Allow-listed feedback statuses — mirrors the Prisma `FeedbackStatus` enum. Kept
 * Prisma-free (string-literal union) like {@link FEEDBACK_TYPES} so the list
 * reader can drop an unknown `?status=` filter BEFORE it reaches Prisma. Passing a
 * value outside this set into `where.status` makes Prisma throw on the enum column
 * (→ the service's catch returns a 500 for a mere bad query param).
 */
export const FEEDBACK_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "PLANNED",
  "COMPLETED",
  "DECLINED",
  "DUPLICATE",
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Narrowing guard for the feedback status (rejects unknown/garbage). */
export function isValidFeedbackStatus(s: unknown): s is FeedbackStatus {
  return (
    typeof s === "string" &&
    (FEEDBACK_STATUSES as readonly string[]).includes(s)
  );
}

/** Plan-based monthly submission limits (`-1` = unlimited). */
export const FEEDBACK_LIMITS: Record<string, number> = {
  FREE: 3,
  PRO: 10,
  PREMIUM: -1,
  ULTIMATE: -1,
};

/** Default (unknown plan) monthly limit. */
export const DEFAULT_FEEDBACK_LIMIT = 3;

/** Max attachments persisted per feedback / reply. */
export const FEEDBACK_MAX_IMAGES = 3;

/** Resolve the monthly limit for a plan (`-1` = unlimited). */
export function resolveFeedbackLimit(
  planId: string | null | undefined,
): number {
  if (!planId) return DEFAULT_FEEDBACK_LIMIT;
  return FEEDBACK_LIMITS[planId] ?? DEFAULT_FEEDBACK_LIMIT;
}

/** Outcome of the monthly-quota check. */
export interface FeedbackQuotaResult {
  allowed: boolean;
  /** `-1` = unlimited. */
  limit: number;
  used: number;
  /** User-facing reason when `allowed === false`. */
  reason?: string;
}

/**
 * Decide whether a new submission is within the plan's monthly limit. Unlimited
 * plans (`-1`) always pass. A non-finite / negative count is treated as 0.
 */
export function checkFeedbackQuota(
  planId: string | null | undefined,
  monthlyCount: number,
): FeedbackQuotaResult {
  const limit = resolveFeedbackLimit(planId);
  const used =
    Number.isFinite(monthlyCount) && monthlyCount > 0
      ? Math.floor(monthlyCount)
      : 0;

  if (limit === -1) return { allowed: true, limit, used };
  if (used >= limit) {
    return {
      allowed: false,
      limit,
      used,
      reason: `You've reached your monthly feedback limit (${limit}). Upgrade your plan for more.`,
    };
  }
  return { allowed: true, limit, used };
}

/**
 * The start of `now`'s month at 00:00 UTC — the lower bound for the monthly
 * submission count. (Vercel's server clock is UTC, matching the web action's
 * local-time `setDate(1)`.)
 */
export function monthStartUtc(now: Date = new Date()): Date {
  const t = now.getTime();
  const base = Number.isFinite(t) ? now : new Date();
  return new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1, 0, 0, 0, 0),
  );
}

/**
 * IDOR guard: keep only attachment paths the caller actually owns (their own
 * `feedback/{userId}/` uploads), drop junk / duplicates / traversal, cap the
 * count. Forged or foreign paths are silently dropped — the ticket still
 * submits. Ported verbatim from `apps/web/lib/feedback/attachments.ts`.
 */
export function filterOwnedImagePaths(
  paths: unknown,
  userId: string,
): string[] {
  if (!Array.isArray(paths) || !userId) return [];
  const prefix = `feedback/${userId}/`;
  const seen = new Set<string>();
  const owned: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string") continue;
    if (!p.startsWith(prefix)) continue;
    if (p.includes("..") || p.length > 256) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    owned.push(p);
    if (owned.length >= FEEDBACK_MAX_IMAGES) break;
  }
  return owned;
}
