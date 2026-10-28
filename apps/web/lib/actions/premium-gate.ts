import { getSubscription as getSubscriptionService } from "@usemoney/services";
import { hasFeatureAccess, type Feature } from "@usemoney/core/subscription";

/**
 * Server-side tier enforcement for premium server actions (MONEY-1142).
 *
 * ## Why this exists
 *
 * Until this file, the paywall for `/risk`, `/tax`, `/documents`, `/strategies`
 * and `/quizzes` lived ENTIRELY in the client `PageGuard`. The actions behind
 * those pages checked authentication and nothing else, and a server action is
 * directly invocable regardless of what the client chose to render — so
 * anything that got past the client gate got real premium data.
 *
 * That was not theoretical. `useFeatureFlags` read a `localStorage` demo flag
 * with no user gate, and `computeGuardDecision`'s demo branch returns NO_GATE
 * for every non-kill-switch route, skipping the plan check below it. A
 * signed-in FREE user setting `tradebook_demo_mode=true` in devtools opened
 * `/risk` and got their real risk analysis. MONEY-1137 closed that entry
 * point; this closes the hole it walked through.
 *
 * Keep the client gate — it is the right UX, and it is what renders the
 * upgrade prompt. It just must not be the only one.
 *
 * ## Why `getSubscription` and not the subscription-ACCESS view
 *
 * Copied deliberately from `lib/actions/learning.ts`, which learned this the
 * hard way: `hasFeatureAccess` resolves legacy plan ids (e.g. "AI_UNLIMITED" →
 * PREMIUM) itself, but the access view collapses an id absent from
 * `PLAN_CONFIG` to FREE — which would wrongly re-lock a paying user on a
 * legacy plan. Only the raw `planId` gates identically to `apps/api`.
 *
 * ## Fail-closed, and why that is safe here
 *
 * A failed subscription read yields no planId, and no planId denies access.
 * The alternative — failing OPEN on an infrastructure blip — hands premium
 * analysis to whoever asks during the blip, which is the exact failure this
 * file exists to prevent. The user-visible cost is an upgrade prompt shown to
 * a paying user during an outage; they retry and it resolves. Note this is
 * also why the result must never be cached: see
 * `lib/subscription/access-cache.ts`, where "couldn't determine" is a
 * DISTINCT, uncacheable value.
 */

/** Denial shape shared by both `ActionResponse` and `ServiceResult` callers. */
export interface FeatureDenied {
  success: false;
  error: string;
}

/**
 * Returns `null` when the user MAY use `feature`, or a ready-to-return denial
 * when they may not.
 *
 * Usage — the guard goes AFTER the demo short-circuit and AFTER auth, because
 * demo sessions serve canned data (no real user data is exposed) and an
 * unauthenticated caller should get "Authentication required", not an upgrade
 * prompt:
 *
 *   if (await isDemoSession()) return { success: true, data: demoX };
 *   const authUser = await getAuthenticatedUser();
 *   if (!authUser) return { success: false, error: "Authentication required" };
 *   const denied = await requireFeature(authUser.userId, "riskAnalysis");
 *   if (denied) return denied;
 */
export async function requireFeature(
  userId: string,
  feature: Feature
): Promise<FeatureDenied | null> {
  let planId: string | null = null;
  try {
    const sub = await getSubscriptionService(userId);
    planId = sub.success ? sub.data.planId : null;
  } catch {
    // Fail closed — see the note above.
    planId = null;
  }

  if (planId && hasFeatureAccess(planId, feature)) return null;

  // `error` is a HUMAN-READABLE message, not a machine token.
  //
  // Review finding: this returned the bare string "UPGRADE_REQUIRED", and
  // `app/risk/client.tsx:118` does `throw new Error(result.error)` — so a
  // denied user saw the raw token as a toast. `ActionResponse` has no `code`
  // field, and every other upgrade denial in the repo (roast.ts,
  // comparison.ts) already returns prose here, so matching that convention is
  // both correct and consistent.
  //
  // `UPGRADE_REQUIRED` remains exported below for callers that want to branch,
  // and is what the /v1 surface sends as a real `code` (it has an envelope
  // that can carry one).
  return {
    success: false,
    error: UPGRADE_REQUIRED_MESSAGE,
  };
}

/** What a denied user actually reads. */
export const UPGRADE_REQUIRED_MESSAGE =
  "This feature is available on a paid plan. Upgrade to continue.";

/**
 * Machine-readable denial reason.
 *
 * Deliberately NOT what goes in `ActionResponse.error` — that field is rendered
 * to the user (see the note on `requireFeature`). This exists for callers that
 * want to branch on the reason, and mirrors the `SUBSCRIPTION_REQUIRED` code
 * the `/v1` surface returns in its error envelope.
 */
export const UPGRADE_REQUIRED = "UPGRADE_REQUIRED";
