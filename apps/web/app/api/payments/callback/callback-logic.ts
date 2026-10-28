/**
 * Pure, side-effect-free helpers for the payments callback route.
 *
 * Split out of `route.ts` so they can be unit-tested against the REAL exported
 * symbols. `route.ts` imports Prisma, `@usemoney/core`, `@/lib/auth` and
 * `next/server`, none of which load in a plain `node --test` process — hence
 * this sibling `*-logic.ts`. The route imports these and calls them; the test
 * asserts them directly.
 *
 * Plan / addon / end-date / idempotency helpers live in the shared single
 * source `@usemoney/core/payments/plan-config`; this file holds only the
 * callback-specific param validation and redirect-path builders.
 *
 * @see apps/web/__tests__/api/payments-callback.test.ts
 */

/**
 * The two required query params on the Dodo return URL. Missing either → the
 * route redirects to `/pricing?error=invalid_params`. (Note: empty strings are
 * falsy, so they fail this gate too.)
 */
export function validateCallbackParams(
  paymentId: string | null,
  planId: string | null
): { valid: boolean; error?: string } {
  if (!paymentId || !planId) {
    return { valid: false, error: "invalid_params" };
  }
  return { valid: true };
}

/** Base URL for the callback redirects (env, else localhost). */
export function getCallbackBaseUrl(): string {
  return process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
}

/**
 * `/pricing?error=<code>` — the failure redirect path used for every rejection
 * branch (invalid_params, payment_not_found, payment_failed,
 * payment_not_verified, payment_forbidden, invalid_plan, callback_failed, …).
 */
export function buildPricingErrorPath(error: string): string {
  return `/pricing?error=${error}`;
}

/** The settings success path the callback lands on after a granted/already-granted fulfillment. */
export const SUBSCRIPTION_SUCCESS_PATH =
  "/settings?tab=subscription&success=payment_complete";

/**
 * `/settings?...&payment=pending&paymentId=<id>` — used when the payment is
 * still PENDING after the Dodo status check. The paymentId is URL-encoded.
 */
export function buildSubscriptionPendingPath(paymentId: string): string {
  return (
    "/settings?tab=subscription&payment=pending&paymentId=" +
    encodeURIComponent(paymentId)
  );
}
