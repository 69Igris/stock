/**
 * Client-side cache for the settings billing summary (MONEY-764).
 *
 * The sidebar tier chip got instant paint via `plan-cache.ts`; this is the
 * same stale-while-revalidate move for the /settings billing hero, which
 * otherwise waits a full `getSubscriptionAction` round trip on every visit
 * before the plan card stops showing FREE/"—". The settings client hydrates
 * its `subscription` state from here on mount and ALWAYS refetches in the
 * background — the fetch result overwrites both the state and this cache.
 *
 * Unlike the plan chip, the summary carries real account data (plan, renewal
 * date, credit balances), so entries are keyed by Clerk user id and a
 * mismatched id reads as a miss — a shared browser never paints the previous
 * account's numbers. Server-side gating never reads this; it is paint-only.
 */

const STORAGE_KEY = "um_billing_v1";

interface CachedEnvelope<T> {
  userId: string;
  data: T;
}

/**
 * Minimal shape guard — enough to reject junk/hand-edited storage without
 * re-validating every field (the background refetch reconciles anyway).
 */
function looksLikeSummary(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { planId?: unknown }).planId === "string" &&
    typeof (value as { status?: unknown }).status === "string"
  );
}

/** Synchronous read; null on miss, junk, storage failure, or user mismatch. */
export function getCachedBillingSummary<T>(userId: string): T | null {
  if (typeof window === "undefined" || !userId) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedEnvelope<T>;
    if (parsed?.userId !== userId || !looksLikeSummary(parsed?.data)) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

/** Write-through after a successful fetch. Storage failures degrade silently. */
export function setCachedBillingSummary<T>(userId: string, data: T): void {
  if (typeof window === "undefined" || !userId || !looksLikeSummary(data)) {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId, data }));
  } catch {
    // Quota / private mode — next visit just pays the round trip again.
  }
}

/** Drop the persisted summary (sign-out / account deletion paths). */
export function clearCachedBillingSummary(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore — the userId key already prevents cross-account paints.
  }
}
