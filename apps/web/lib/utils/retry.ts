/**
 * Retry helper for transient browser network failures.
 *
 * Browser fetch() throws `TypeError: Failed to fetch` when the network drops
 * mid-request (mobile suspending tab, Wi-Fi flake, momentary CORS hiccup).
 * Next.js Server Actions surface this as an unhandled rejection that PostHog
 * captures, even when the caller has try/catch.
 *
 * This wrapper retries ONCE on `TypeError: Failed to fetch` after a short
 * backoff. We don't retry on real errors (auth failure, validation errors,
 * 5xx) - only on network-level failures.
 */

const TRANSIENT_FETCH_ERROR_PATTERNS = [
  "Failed to fetch", // Chrome/Edge
  "Load failed", // Safari
  "NetworkError", // Firefox
  "network error",
];

function isTransientFetchError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const message = err.message || "";
  return TRANSIENT_FETCH_ERROR_PATTERNS.some((pattern) =>
    message.includes(pattern)
  );
}

/**
 * Wrap a server action call with one retry on transient network failure.
 *
 * Usage:
 *   const result = await withFetchRetry(() => getDashboardStatsAction());
 *
 * - First attempt fails with `TypeError: Failed to fetch` → wait 500ms → retry once
 * - First attempt fails with anything else → re-throw immediately (don't retry real errors)
 * - Retry succeeds → return result
 * - Retry fails → re-throw the second error
 */
export async function withFetchRetry<T>(
  fn: () => Promise<T>,
  options: { delayMs?: number } = {}
): Promise<T> {
  const delayMs = options.delayMs ?? 500;

  try {
    return await fn();
  } catch (err) {
    if (!isTransientFetchError(err)) {
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return await fn();
  }
}
