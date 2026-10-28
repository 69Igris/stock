/**
 * Resolve-once-per-page-load cache — MONEY-1126.
 *
 * Several client components key a server round trip on `pathname`, so the check
 * re-fires on EVERY client-side navigation even though the answer cannot have
 * changed: `SessionGuard` (ghosted-session detection), `TermsGate` (terms
 * acceptance), the sidebar's credits/renewal strip. On an SPA that is one
 * server action per page change, per component, forever.
 *
 * This gives them a shared "ask once, reuse the answer" seam with three
 * properties that make it safe to put in front of a gate:
 *
 * 1. **Only qualifying answers are remembered.** The caller supplies
 *    `shouldRemember`, and every gate here passes the NON-blocking answer only.
 *    A blocking answer (terms not accepted, session ghosted) is never cached,
 *    so a blocked user is re-checked exactly as often as before. The gate can
 *    become less chatty; it cannot become more permissive.
 *
 * 2. **A rejection is never remembered.** It propagates to the caller and
 *    leaves the slot empty, so the next navigation retries. Caching a transient
 *    failure is the bug class already fixed for the PostHog flag cache
 *    (MONEY-1123, commit fe25487a) — a two-second blip must not pin a decision
 *    for the rest of the session.
 *
 * 3. **Single-slot, keyed by user id, memory only.** Never localStorage, never
 *    sessionStorage. A second account signing in on the same browser reads a
 *    miss (different key) and any reload starts from empty — the failure mode
 *    that makes `lib/subscription/plan-cache.ts` explicitly cosmetic-only
 *    cannot occur here. One slot also means it cannot grow.
 */
export interface OncePerUserCache<T> {
  /** Synchronous read of an already-accepted answer for `userId`. */
  peek(userId: string): T | undefined;
  /**
   * Accepted answer, the in-flight request for the same user, or a fresh call.
   * Rejections propagate — callers must handle them and must NOT treat a
   * rejection as an answer.
   */
  get(userId: string, resolve: () => Promise<T>): Promise<T>;
  /** Drop everything (sign-out, tests). */
  clear(): void;
}

export function createOncePerUserCache<T>(options: {
  /** Return true only for answers that are safe to reuse for the session. */
  shouldRemember: (value: T) => boolean;
}): OncePerUserCache<T> {
  let settled: { userId: string; value: T } | null = null;
  let inflight: { userId: string; promise: Promise<T> } | null = null;

  return {
    peek(userId) {
      return settled !== null && settled.userId === userId
        ? settled.value
        : undefined;
    },

    get(userId, resolve) {
      if (settled !== null && settled.userId === userId) {
        return Promise.resolve(settled.value);
      }
      if (inflight !== null && inflight.userId === userId) {
        return inflight.promise;
      }

      const promise = resolve().then(
        (value) => {
          if (inflight !== null && inflight.promise === promise) {
            inflight = null;
          }
          if (options.shouldRemember(value)) settled = { userId, value };
          return value;
        },
        (error: unknown) => {
          if (inflight !== null && inflight.promise === promise) {
            inflight = null;
          }
          // Deliberately not remembered — the next navigation retries.
          throw error;
        }
      );

      inflight = { userId, promise };
      return promise;
    },

    clear() {
      settled = null;
      inflight = null;
    },
  };
}
