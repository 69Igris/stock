/**
 * Client-side cache for the user's subscription plan id (sidebar tier chip).
 *
 * The authenticated shell renders its own `<Sidebar/>` per page (PageGuard /
 * TerminalLuxeShell / PaperTradingLayoutClient), so the sidebar re-mounts on
 * every navigation. Without a cache that re-ran `getSubscriptionAction` each
 * time and flashed the plan tag FREE→real. This module singleton keeps the
 * resolved plan for the SPA session so re-mounts read it synchronously and
 * fire at most one network call (deduped via the in-flight promise).
 *
 * MONEY-764: the in-memory singleton still paid the full round-trip on every
 * hard reload / fresh login before the chip could paint, so the plan is now
 * also persisted to localStorage and hydrated at module init — classic
 * stale-while-revalidate. The first `fetchPlanCached()` of a session that
 * serves a value it did not fetch itself kicks ONE background revalidation;
 * if the server disagrees, `setCachedPlan` re-seeds and notifies subscribers
 * (mounted sidebars already re-render on notify).
 *
 * Accepted tradeoff: the persisted value can be stale, or belong to whoever
 * was previously signed in on this browser, so the chip may briefly show that
 * plan until the background revalidation corrects it. The chip is cosmetic
 * only — every entitlement / gating decision reads the server directly and
 * stays server-authoritative.
 */

const STORAGE_KEY = "um_plan_v1";

/** Plan ids are short UPPER_SNAKE tokens — ignore anything else in storage. */
const PLAN_ID_SHAPE = /^[A-Z][A-Z0-9_]{1,31}$/;

// localStorage can throw (private mode, storage disabled, quota) — every
// access is guarded; a storage failure degrades to the session-only cache.
function readPersistedPlan(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && PLAN_ID_SHAPE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function persistPlan(plan: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, plan);
  } catch {
    // Ignore quota / private-mode failures — in-memory cache still works.
  }
}

function dropPersistedPlan(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore — worst case the next session revalidates the stale value.
  }
}

let cachedPlan: string | null = readPersistedPlan();
let inflight: Promise<string> | null = null;

// True once a `getSubscriptionAction` round-trip has been initiated this JS
// session. A value served before that (hydrated from localStorage) is treated
// as possibly stale and triggers at most one background revalidation.
let revalidatedThisSession = false;

// Bumped by `clearCachedPlan` (sign-out). A fetch started under an older
// generation must not write its result back — otherwise a slow in-flight
// request could resurrect (and re-persist) the previous user's plan.
let generation = 0;

// Live subscribers (mounted sidebars) notified when the plan is reseeded, so a
// post-upgrade `setCachedPlan` updates the tier tag immediately — without this
// the singleton was frozen for the whole SPA session and the sidebar kept
// showing the pre-upgrade plan until a full reload (MONEY-650 billing fix).
const subscribers = new Set<(plan: string) => void>();

/** Minimal slice of `@/lib/actions/subscription` this cache consumes. */
type SubscriptionActionsModule = {
  getSubscriptionAction: () => Promise<{
    data?: { planId?: string | null } | null;
  } | null>;
};

let loadSubscriptionActions: () => Promise<SubscriptionActionsModule> = () =>
  import("@/lib/actions/subscription");

/** Test seam — swap the server-action loader (the real one is server-only). */
export function __setSubscriptionLoaderForTests(
  loader: () => Promise<SubscriptionActionsModule>
): void {
  loadSubscriptionActions = loader;
}

/** Synchronous read — hydrated from localStorage, null on a first-ever visit. */
export function getCachedPlan(): string | null {
  return cachedPlan;
}

/** Seed the cache (e.g. after a successful upgrade) and notify live readers. */
export function setCachedPlan(plan: string): void {
  cachedPlan = plan;
  persistPlan(plan);
  for (const cb of subscribers) cb(plan);
}

/**
 * Subscribe to plan changes; returns an unsubscribe fn. A mounted sidebar uses
 * this to re-render the tier tag the moment the plan is reseeded after upgrade.
 */
export function subscribeCachedPlan(cb: (plan: string) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/**
 * Drop the cached AND persisted value (sign-out path) so the next
 * `fetchPlanCached` re-fetches fresh — and nothing leaks to the next user.
 */
export function clearCachedPlan(): void {
  cachedPlan = null;
  inflight = null;
  revalidatedThisSession = false;
  generation += 1;
  dropPersistedPlan();
}

/**
 * Single fetch pipeline for both modes, stored in `inflight` for dedupe.
 *
 * - foreground (no cached value): resolution becomes the cache + persists;
 *   errors fall back to "FREE" in memory only (never persisted, so a stored
 *   real plan survives a transient offline reload).
 * - background (revalidating a hydrated value): only writes when the server
 *   disagrees, via `setCachedPlan` so subscribers repaint; errors keep the
 *   currently shown value.
 */
function startFetch(opts: { background: boolean }): Promise<string> {
  const gen = generation;
  revalidatedThisSession = true;
  const p = loadSubscriptionActions()
    .then(({ getSubscriptionAction }) => getSubscriptionAction())
    .then((r) => {
      const fresh = r?.data?.planId || "FREE";
      if (gen !== generation) return fresh; // signed out mid-flight — discard
      if (opts.background) {
        if (cachedPlan !== null && fresh !== cachedPlan) setCachedPlan(fresh);
      } else {
        cachedPlan = fresh;
        persistPlan(fresh);
      }
      return fresh;
    })
    .catch(() => {
      if (gen !== generation) return "FREE";
      if (opts.background) return cachedPlan ?? "FREE";
      cachedPlan = "FREE";
      return cachedPlan;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

/**
 * Returns the plan id, fetching once per session. Subsequent calls resolve
 * from cache without a network round-trip; concurrent callers share the
 * single in-flight request. A value hydrated from localStorage resolves
 * instantly but self-heals via one background revalidation.
 */
export async function fetchPlanCached(): Promise<string> {
  if (cachedPlan) {
    // Hydrated/seeded value not confirmed by a fetch this session — serve it
    // instantly and revalidate in the background (at most once per session).
    if (!revalidatedThisSession && !inflight) {
      void startFetch({ background: true });
    }
    return cachedPlan;
  }
  if (inflight) return inflight;
  return startFetch({ background: false });
}
