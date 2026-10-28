/**
 * Read-through cache policy for subscription entitlement — MONEY-1126.
 *
 * `PageGuard` blanks ~30 routes behind `useSubscriptionAccess`, which hits
 * `/api/subscription/access` on mount; that route is `force-dynamic` and did a
 * fresh Clerk resolve + Mongo read on every single request. This puts a short
 * user-scoped cache in front of the resolution.
 *
 * ## The one rule: never cache a failure
 *
 * `getSubscriptionAccess` fails OPEN to `DEFAULT_FREE_ACCESS` on every error
 * path — Clerk unreachable, user unresolvable, service error. That is the right
 * least-privilege default for a single request, but it is a TRAP for a cache: a
 * naive read-through would write that FREE into Redis and pin a paying user to
 * FREE for the whole TTL, turning a 200ms blip into a minute of "upgrade to
 * access" prompts across ~30 pages. Same bug class as the PostHog flag cache in
 * MONEY-1123 (commit fe25487a), which had to learn to distinguish "PostHog said
 * no flags" from "PostHog did not answer".
 *
 * So `resolve` returns `null` for "could not answer" and the caller's
 * least-privilege `fallback` is served for THAT REQUEST ONLY, uncached. Only a
 * genuine resolution is ever written.
 *
 * Cache-layer failures are equally non-fatal: a read that throws is a miss, a
 * write that throws is dropped. Redis being down degrades to today's behaviour
 * (a DB read per request), never to a wrong entitlement.
 *
 * Injected dependencies keep this pure and testable — the real wiring lives in
 * `./access.ts`, which is a `"use server"` module and cannot be imported into a
 * unit test.
 */
export interface SubscriptionAccessCacheDeps<T> {
  /** Cache read. Resolve `null` on miss; throwing is treated as a miss. */
  read: (userId: string) => Promise<T | null>;
  /** Cache write. Best-effort — a rejection is swallowed. */
  write: (userId: string, value: T) => Promise<void>;
  /**
   * Authoritative resolution. MUST resolve `null` (not a fallback value) when
   * the answer could not be determined, so the failure is never persisted.
   */
  resolve: (userId: string) => Promise<T | null>;
  /** Least-privilege value served when `resolve` cannot answer. Never cached. */
  fallback: T;
}

export async function readThroughSubscriptionAccess<T>(
  userId: string,
  deps: SubscriptionAccessCacheDeps<T>
): Promise<T> {
  const cached = await deps.read(userId).catch(() => null);
  if (cached !== null && cached !== undefined) return cached;

  const resolved = await deps.resolve(userId).catch(() => null);
  if (resolved === null || resolved === undefined) {
    // Failure path: serve the least-privilege default for this request and
    // leave the cache untouched, so the very next request re-resolves.
    return deps.fallback;
  }

  await deps.write(userId, resolved).catch(() => {});
  return resolved;
}

/**
 * Cache coordinates. The module is `subscription` on purpose: the existing
 * `clearSubscriptionCache(userId)` invalidator in `@usemoney/core/cache` deletes
 * `subscription:{userId}:*`, so this entry is dropped by the same call that
 * already drops the rest of a user's subscription cache — no new invalidation
 * surface to keep in sync.
 */
export const SUBSCRIPTION_ACCESS_CACHE_IDENTIFIER = "access";

/**
 * MONEY-1134 — invalidation now covers the four scenarios that matter.
 *
 * Worth recording how this went, because the first attempt was worse than the
 * gap it replaced. `clearSubscriptionCache` was originally called from ONE
 * place (the payment callback). The first fix wired three mutations in
 * `subscription.service.ts` and then flipped this note to "CLOSED" — while 17
 * further mutation sites across three OTHER services remained uninvalidated,
 * covering three of the four scenarios that same commit named as fixed. A
 * false "CLOSED" is worse than an honest KNOWN GAP: nobody re-checks it.
 *
 * Now invalidated, via the shared `@usemoney/services`
 * `invalidateEntitlement`:
 *   - `subscription.service.ts` — updateSubscriptionPlan, cancelSubscription,
 *     downgradeWithGracePeriod
 *   - `subscription-grants.service.ts` — the Dodo WEBHOOK path: grant (webhook
 *     + callback), cancellation, renewal, past-due, expired
 *   - `scheduled-plan-changes.service.ts` — all three apply sites in the hourly
 *     cron (cancel, plan change, downgrade)
 *
 * The direction that mattered most was revocation: without it a cancelled,
 * past-due or expired user kept PREMIUM across ~30 PageGuard-ed routes for the
 * TTL.
 *
 * Credit debits deliberately do NOT invalidate — see the note on that helper.
 * Usage counters appear in the cached payload, but nothing gates on the cached
 * copy (`consumeAIQuery` reads Prisma directly and debits with a conditional
 * `updateMany`), so invalidating on the hottest path to freshen a display
 * counter would negate the cache for no safety gain.
 */

/**
 * 60s, with a 10s L1 ceiling.
 *
 * `deletePattern` issues a global Redis `DEL` but only clears the L1 of the
 * process that ran it, so every other warm Vercel instance would keep serving
 * an invalidated entitlement for the rest of `ttl` (see the `memoryTtl` note in
 * `@usemoney/core/cache`). Entitlement is exactly the wrong thing to be stale
 * about after an upgrade, so L1 is capped at 10s — the burst of reads inside one
 * page load is still absorbed, and a cross-instance stale window is bounded to
 * seconds rather than a minute.
 *
 * Set explicitly rather than inherited from `DEFAULT_CACHE_CONFIGS.subscription`
 * (5 min) — a plan should not go stale for five minutes, and this must not move
 * if that shared default is retuned for some other consumer.
 */
export const SUBSCRIPTION_ACCESS_CACHE_CONFIG = {
  ttl: 60,
  memoryTtl: 10,
  enableMemory: true,
  enableRedis: true,
} as const;
