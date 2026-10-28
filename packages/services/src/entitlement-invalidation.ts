import { clearSubscriptionCache } from "@usemoney/core/cache";
import { dbLogger as logger } from "@usemoney/logger";

/**
 * Drop every cached entitlement for a user after a PLAN or STATUS change
 * (MONEY-1134).
 *
 * ## Why this is its own module
 *
 * The first pass at MONEY-1134 put this helper inside
 * `subscription.service.ts` and wired it to the three mutations there — then
 * the commit message announced the gap "CLOSED". It was not. A review found 17
 * further mutation sites across three other services, covering THREE of the
 * four scenarios that commit explicitly named as fixed:
 *
 *   - `subscription-grants.service.ts` — the Dodo WEBHOOK path (grant, cancel,
 *     renew, past-due, expired). 13 sites.
 *   - `scheduled-plan-changes.service.ts` — the hourly cron that applies
 *     scheduled downgrades and cancellations. 3 sites.
 *   - `payment-grant.service.ts` — 1 site.
 *
 * So a Dodo cancellation webhook still left ~30 PageGuard-ed routes serving
 * PREMIUM for the cache TTL: precisely the "a revoked user keeps access"
 * direction, which is the one that costs money rather than patience.
 *
 * Living in `subscription.service.ts` is what made that easy to miss — the
 * helper was private, so the other services could not have called it even if
 * their authors had thought to. A shared module is the fix for the class, not
 * just the instances.
 *
 * ## What it clears
 *
 * `clearSubscriptionCache(userId)` deletes `subscription:{userId}:*`, which
 * includes the read-through entitlement entry in
 * `apps/web/lib/subscription/access-cache.ts`.
 *
 * ## What deliberately does NOT call it
 *
 * Credit debits (`consumeAIQuery`, `refundAIQuery`, the reservation paths).
 * Usage counters DO appear in the cached payload, but nothing gates on the
 * cached copy — `consumeAIQuery` reads Prisma directly and debits with a
 * CONDITIONAL `updateMany` that re-asserts the quota at write time, so
 * over-spend is impossible whatever a cache says. Invalidating on every AI
 * query would negate the cache on its hottest path to freshen a display
 * counter.
 *
 * ## Best-effort by design
 *
 * The row is already written by the time this runs. Throwing here would turn a
 * successful plan change into a failed one over a cache blip; the worst case
 * of swallowing is that we are back to TTL-staleness, which is where we were.
 */
export async function invalidateEntitlement(userId: string): Promise<void> {
  try {
    await clearSubscriptionCache(userId);
  } catch (error) {
    logger.warn(
      { error, userId, action: "invalidateEntitlement" },
      "Failed to clear subscription cache after a plan change",
    );
  }
}
