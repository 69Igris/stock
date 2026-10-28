/**
 * Pure checkout-with-404-retry logic (no Prisma, no `dodopayments` SDK).
 *
 * `createCheckoutAction` (apps/web/lib/actions/subscription.ts) CALLS these so
 * the 404 detection, the "is the re-synced product usable for a retry" rule and
 * the sanitized failure messages are defined once. Previously this logic was
 * inlined in the action and re-implemented a second time inside
 * `__tests__/payments/checkout-retry.test.ts` (a shadow).
 */

export interface RefreshedProductInfo {
  productId: string;
  isRecurring: boolean;
}

/**
 * True when a checkout-create error is a Dodo "stale product" 404 — message
 * contains "404" OR "does not exist". Only these trigger the re-sync + retry;
 * anything else (rate limit, gateway 500, …) is rethrown unchanged.
 */
export function isCheckout404(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes("404") || err.message.includes("does not exist"))
  );
}

/**
 * Whether a re-synced product is usable for the retry. A retry is valid ONLY
 * when the refreshed info exists AND its productId differs from the original
 * stale id — otherwise the product genuinely doesn't exist in Dodo and we must
 * fail rather than re-hit the same dead id. Typed as a guard so callers can use
 * the narrowed `refreshedInfo` after the check.
 */
export function canRetryWithRefreshed(
  refreshedInfo: RefreshedProductInfo | null,
  originalProductId: string,
): refreshedInfo is RefreshedProductInfo {
  if (!refreshedInfo) return false;
  if (refreshedInfo.productId === originalProductId) return false;
  return true;
}

/**
 * Sanitized message stored on the FAILED payment row — must NOT leak raw Dodo
 * error details (URL / status / product id / merchant id).
 */
export function getCheckoutFailedErrorMessage(): string {
  return "Payment checkout could not be created";
}

/** Sanitized, actionable user-facing error returned from the action. */
export function getCheckoutFailedUserMessage(): string {
  return "Unable to create checkout session. Please try again in a few moments.";
}

/**
 * User-facing error for the specific case where the TARGET plan's Dodo product
 * is missing from the active catalog even after an auto-sync (MONEY-1074). This
 * was the silent "Pro→Premium upgrade does nothing" on QA — the test-mode Dodo
 * catalog lacked the `usemoney_premium*` products, so `getDodoProductInfo`
 * returned null. Distinct from the generic checkout-failed message so the copy
 * reads as a temporary plan-availability issue, and paired with a server-side
 * `logger.warn` at the call sites so ops can diagnose it in one log line.
 */
export function getPlanUnavailableUserMessage(): string {
  return "This plan isn't available for checkout right now. Please try again in a few minutes — if it keeps happening, contact support.";
}
