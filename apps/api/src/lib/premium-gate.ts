import { getSubscription } from "@usemoney/services";
import { hasFeatureAccess, type Feature } from "@usemoney/core/subscription";

/**
 * Server-side tier enforcement for premium `/v1` endpoints (MONEY-1142).
 *
 * ## Why this exists
 *
 * MONEY-1142 closed a client-only paywall on `apps/web` — `/risk`, `/tax`,
 * `/documents`, `/strategies`, `/quizzes` checked authentication and nothing
 * else. It did NOT cover `apps/api`, and a review caught that: `v1/risk.ts`,
 * `v1/tax.ts` and `v1/documents.ts` still did `const userId = c.get("userId")`
 * and went straight to the service.
 *
 * So a FREE user with a valid Clerk JWT could curl `/v1/risk` and receive the
 * full premium analysis — the same hole, one surface over, and reachable
 * without any client at all. That is a worse version of the original bug, since
 * there is no PageGuard even nominally in the way.
 *
 * `v1/learning.ts` already resolves a plan and returns 403 `PREMIUM_REQUIRED`,
 * so the precedent existed; this was omission, not absence of a pattern. It
 * also violated the standing rule that apps/api stays in sync with the server
 * actions.
 *
 * ## Same semantics as the web gate, deliberately
 *
 * Mirrors `apps/web/lib/actions/premium-gate.ts`: resolve the RAW planId via
 * `getSubscription` (not the access view, which collapses an unknown legacy id
 * to FREE and would re-lock a paying user), fail CLOSED on any error, and cache
 * nothing. Divergence between the two surfaces is how the original gap
 * survived, so the two should be read side by side.
 */
export async function isEntitled(
  userId: string,
  feature: Feature,
): Promise<boolean> {
  try {
    const sub = await getSubscription(userId);
    const planId = sub.success ? sub.data.planId : null;
    return Boolean(planId && hasFeatureAccess(planId, feature));
  } catch {
    // Fail closed. Failing open during a Mongo blip hands premium data to
    // whoever asks during the blip — the failure this gate exists to prevent.
    return false;
  }
}
