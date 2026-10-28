/**
 * Pure seams for the scheduled-plan-changes cron service (MONEY-482 / MONEY-1062).
 *
 * The hourly cron flips subscriptions whose `scheduledEffectiveAt` has arrived to
 * their scheduled target plan (FREE cancel, or a tier/cycle downgrade). This file
 * holds the decision/computation bit with no Prisma / Dodo:
 *   - `buildRebaseFields` — the entitlement rebase math applied on every flip.
 * (An `isScheduledChangeDue` predicate was removed — it was a test-only shadow
 * of the cron's Prisma `where`; the real selection is asserted against the
 * service's `findMany` args in the CJS contract test.)
 *
 * @see packages/services/src/scheduled-plan-changes.service.ts
 * @see packages/services/__tests__/scheduled-plan-changes.test.ts
 */

import { THIRTY_DAYS_MS } from "@usemoney/core/payments/plan-config";

/** 30 days in ms — re-exported from the core plan-config single source so
 * existing barrel consumers keep the symbol. */
export { THIRTY_DAYS_MS };

/** Config shapes the rebase reads from (subset of WEBHOOK_PLANS / PLAN_CONFIG). */
export interface RebaseWebhookPlan {
  aiQueries: number;
}
export interface RebaseTargetConfig {
  fastQueries?: number;
  advancedQueries?: number;
  credits?: number;
}

/** The entitlement-counter fields written to a subscription on a scheduled flip. */
export interface RebaseFields {
  aiQueriesUsed: number;
  aiQueriesLimit: number;
  aiQueriesResetAt: Date;
  fastQueriesUsed: number;
  fastQueriesLimit: number;
  advancedQueriesUsed: number;
  advancedQueriesLimit: number;
  creditsUsed: number;
  creditsLimit: number;
  creditsResetAt: Date;
}

/**
 * Re-base entitlements to the TARGET plan on every scheduled flip. The read
 * paths are heal-UP-only (they never lower limits), so without this a
 * PREMIUM→PRO downgrade kept 200 credits/month at PRO price forever. The legacy
 * `aiQueriesLimit` comes from WEBHOOK_PLANS (PRO→10); the real limits
 * (fast/advanced/credits) come from the canonical PLAN_CONFIG. Missing config →
 * 0 (credits default 5), matching the cron's `?? 0` / `?? 5`.
 *
 * `now` is injectable for deterministic tests; both reset anchors are `now + 30d`.
 */
export function buildRebaseFields(
  webhookPlan: RebaseWebhookPlan | undefined,
  targetConfig: RebaseTargetConfig | undefined,
  now: number = Date.now(),
): RebaseFields {
  const resetAt = new Date(now + THIRTY_DAYS_MS);
  return {
    aiQueriesUsed: 0,
    aiQueriesLimit: webhookPlan?.aiQueries ?? 0,
    aiQueriesResetAt: resetAt,
    fastQueriesUsed: 0,
    fastQueriesLimit: targetConfig?.fastQueries ?? 0,
    advancedQueriesUsed: 0,
    advancedQueriesLimit: targetConfig?.advancedQueries ?? 0,
    creditsUsed: 0,
    creditsLimit: targetConfig?.credits ?? 5,
    creditsResetAt: resetAt,
  };
}
