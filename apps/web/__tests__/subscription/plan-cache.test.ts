/**
 * Plan cache (sidebar tier tag) — MONEY-650 billing-upgrade fix +
 * MONEY-764 localStorage persistence & background revalidation.
 *
 * MONEY-650 regression guard. BEFORE the fix, `setCachedPlan` updated the
 * module singleton but did NOT notify mounted readers, and `fetchPlanCached`
 * early-returns whenever a value is cached. So after a successful upgrade the
 * billing page read the new plan fresh from the DB, but the sidebar kept
 * serving the frozen pre-upgrade plan for the whole SPA session (until a full
 * reload) — exactly the "billing updated but plan not upgrading" symptom.
 * The reactive `subscribeCachedPlan` bridge + `clearCachedPlan` are what make
 * an upgrade reflect live; these tests lock that contract in.
 *
 * MONEY-764 adds stale-while-revalidate: the plan persists to localStorage
 * (key `um_plan_v1`) and hydrates at module init, so the chip paints
 * instantly after a hard reload; the first `fetchPlanCached()` of a session
 * that serves a value it did not fetch itself kicks exactly ONE background
 * revalidation, which re-seeds via `setCachedPlan` only when the server
 * disagrees. The module is therefore loaded LAZILY below — the
 * window/localStorage shim and the seeded key must exist before module-init
 * hydration runs (a static import would hoist above the shim).
 *
 * Source: apps/web/lib/subscription/plan-cache.ts
 */
import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";

// ── Global window + localStorage shim ───────────────────────────────────────
// Installed synchronously BEFORE the module under test is imported, so its
// module-init hydration branch sees a browser-like environment.
let storageThrows = false; // simulate private mode / quota errors
const store = new Map<string, string>();
const mockLocalStorage = {
  getItem: (k: string): string | null => {
    if (storageThrows) throw new Error("storage disabled");
    return store.get(k) ?? null;
  },
  setItem: (k: string, v: string): void => {
    if (storageThrows) throw new Error("quota exceeded");
    store.set(k, v);
  },
  removeItem: (k: string): void => {
    if (storageThrows) throw new Error("storage disabled");
    store.delete(k);
  },
  clear: (): void => store.clear(),
};

const g = globalThis as unknown as {
  window?: unknown;
  localStorage?: unknown;
};
const hadWindow = "window" in g;
const hadLocalStorage = "localStorage" in g;
const prevWindow = g.window;
const prevLocalStorage = g.localStorage;
g.window = g.window ?? {};
g.localStorage = mockLocalStorage;

after(() => {
  if (hadWindow) g.window = prevWindow;
  else delete g.window;
  if (hadLocalStorage) g.localStorage = prevLocalStorage;
  else delete g.localStorage;
});

// The persisted-plan contract (duplicated on purpose — locks the key name).
const STORAGE_KEY = "um_plan_v1";

// Seed a persisted plan BEFORE the first import — proves init hydration.
store.set(STORAGE_KEY, "PREMIUM");

type PlanCacheModule = typeof import("@/lib/subscription/plan-cache");
let pc!: PlanCacheModule;
let hydratedAtInit: string | null = null;

before(async () => {
  pc = await import("@/lib/subscription/plan-cache");
  hydratedAtInit = pc.getCachedPlan(); // captured before any beforeEach clears
});

// ── Subscription-action stub (the real loader pulls a server-only module) ───
type ActionResult = { data?: { planId?: string | null } | null } | null;

function stubSubscriptionAction(
  impl: () => Promise<ActionResult>
): () => number {
  let calls = 0;
  pc.__setSubscriptionLoaderForTests(async () => ({
    getSubscriptionAction: () => {
      calls += 1;
      return impl();
    },
  }));
  return () => calls;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let the fetch promise chain (loader → action → cache write) settle. */
const drain = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  // The cache is a module singleton; reset between tests.
  storageThrows = false;
  pc.clearCachedPlan(); // value + inflight + session flag + generation
  store.clear();
  // Tripwire: tests that fetch must install their own stub explicitly.
  pc.__setSubscriptionLoaderForTests(async () => {
    throw new Error("test did not stub the subscription loader");
  });
});

describe("plan-cache — reactive subscription cache (MONEY-650)", () => {
  it("getCachedPlan starts null and reflects setCachedPlan", () => {
    assert.equal(pc.getCachedPlan(), null);
    pc.setCachedPlan("PRO");
    assert.equal(pc.getCachedPlan(), "PRO");
  });

  it("clearCachedPlan resets to null so the next read re-fetches", () => {
    pc.setCachedPlan("PREMIUM");
    assert.equal(pc.getCachedPlan(), "PREMIUM");
    pc.clearCachedPlan();
    assert.equal(pc.getCachedPlan(), null);
  });

  it("setCachedPlan notifies every live subscriber (the upgrade signal)", () => {
    const seen: string[] = [];
    const off = pc.subscribeCachedPlan((p) => seen.push(p));
    pc.setCachedPlan("PRO");
    pc.setCachedPlan("PREMIUM");
    assert.deepEqual(seen, ["PRO", "PREMIUM"]);
    off();
  });

  it("unsubscribe stops further notifications (no leak after unmount)", () => {
    const seen: string[] = [];
    const off = pc.subscribeCachedPlan((p) => seen.push(p));
    pc.setCachedPlan("PRO");
    off();
    pc.setCachedPlan("PREMIUM");
    assert.deepEqual(seen, ["PRO"]);
  });

  it("multiple subscribers (two mounted sidebars) all update", () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = pc.subscribeCachedPlan((p) => a.push(p));
    const offB = pc.subscribeCachedPlan((p) => b.push(p));
    pc.setCachedPlan("PREMIUM");
    assert.deepEqual(a, ["PREMIUM"]);
    assert.deepEqual(b, ["PREMIUM"]);
    offA();
    offB();
  });

  it("REGRESSION: an upgrade after a FREE seed reaches a subscribed sidebar live", () => {
    // Simulate the sidebar lifecycle: seed local state from the cache on
    // mount, then subscribe for live changes.
    pc.setCachedPlan("FREE"); // first fetch resolved FREE
    let sidebarPlan = pc.getCachedPlan(); // sidebar reads synchronously on mount
    const off = pc.subscribeCachedPlan((p) => {
      sidebarPlan = p;
    });
    assert.equal(sidebarPlan, "FREE");

    // Billing page seeds the fresh plan after a successful payment.
    pc.setCachedPlan("PRO");

    // Before the fix this stayed "FREE" until a full page reload.
    assert.equal(sidebarPlan, "PRO");
    off();
  });
});

describe("plan-cache — localStorage persistence (MONEY-764)", () => {
  it("module init hydrates getCachedPlan from the persisted plan (instant chip after reload)", () => {
    // Captured in `before`, right after the very first import — the seeded
    // "PREMIUM" was readable synchronously without any network round-trip.
    assert.equal(hydratedAtInit, "PREMIUM");
  });

  it("setCachedPlan writes through to localStorage", () => {
    pc.setCachedPlan("PRO");
    assert.equal(store.get(STORAGE_KEY), "PRO");
  });

  it("fetchPlanCached resolution persists the fetched plan", async () => {
    const calls = stubSubscriptionAction(async () => ({
      data: { planId: "PREMIUM" },
    }));
    assert.equal(await pc.fetchPlanCached(), "PREMIUM");
    assert.equal(pc.getCachedPlan(), "PREMIUM");
    assert.equal(store.get(STORAGE_KEY), "PREMIUM");
    assert.equal(calls(), 1);
  });

  it("clearCachedPlan removes the persisted key (sign-out leaves nothing behind)", () => {
    pc.setCachedPlan("PRO");
    assert.equal(store.get(STORAGE_KEY), "PRO");
    pc.clearCachedPlan();
    assert.equal(store.has(STORAGE_KEY), false);
    assert.equal(pc.getCachedPlan(), null);
  });

  it("storage failures (private mode / quota) are swallowed — cache still works in memory", () => {
    storageThrows = true;
    pc.setCachedPlan("PRO"); // setItem throws — must not propagate
    assert.equal(pc.getCachedPlan(), "PRO");
    pc.clearCachedPlan(); // removeItem throws — must not propagate
    assert.equal(pc.getCachedPlan(), null);
  });
});

describe("plan-cache — background revalidation (MONEY-764)", () => {
  it("cold fetch is foreground: dedupes concurrent callers and marks the session revalidated", async () => {
    const d = deferred<ActionResult>();
    const calls = stubSubscriptionAction(() => d.promise);

    const a = pc.fetchPlanCached();
    const b = pc.fetchPlanCached(); // concurrent — shares the in-flight request
    d.resolve({ data: { planId: "PREMIUM" } });
    assert.equal(await a, "PREMIUM");
    assert.equal(await b, "PREMIUM");
    assert.equal(calls(), 1);

    // Session already validated by the foreground fetch — pure cache now.
    assert.equal(await pc.fetchPlanCached(), "PREMIUM");
    await drain();
    assert.equal(calls(), 1);
  });

  it("hydrated value serves instantly, kicks ONE revalidation; a differing plan re-seeds + notifies + persists", async () => {
    const d = deferred<ActionResult>();
    const calls = stubSubscriptionAction(() => d.promise);
    pc.setCachedPlan("FREE"); // simulate a stale hydrated value
    const seen: string[] = [];
    const off = pc.subscribeCachedPlan((p) => seen.push(p));

    // Resolves while the action is still pending — the instant path.
    assert.equal(await pc.fetchPlanCached(), "FREE");
    await drain();
    assert.equal(calls(), 1); // background revalidation in flight

    // Re-reads neither block nor duplicate the revalidation.
    assert.equal(await pc.fetchPlanCached(), "FREE");
    await drain();
    assert.equal(calls(), 1);

    d.resolve({ data: { planId: "PRO" } }); // server disagrees
    await drain();
    assert.equal(pc.getCachedPlan(), "PRO");
    assert.deepEqual(seen, ["PRO"]); // sidebar repainted via subscriber
    assert.equal(store.get(STORAGE_KEY), "PRO"); // write-through

    // Session now validated — later reads are pure cache.
    assert.equal(await pc.fetchPlanCached(), "PRO");
    await drain();
    assert.equal(calls(), 1);
    off();
  });

  it("revalidation that agrees with the cached plan stays silent (no notify, no flash)", async () => {
    const calls = stubSubscriptionAction(async () => ({
      data: { planId: "PRO" },
    }));
    pc.setCachedPlan("PRO");
    const seen: string[] = [];
    const off = pc.subscribeCachedPlan((p) => seen.push(p));

    assert.equal(await pc.fetchPlanCached(), "PRO");
    await drain();
    assert.equal(calls(), 1);
    assert.deepEqual(seen, []); // no churn for an unchanged plan
    assert.equal(pc.getCachedPlan(), "PRO");
    off();
  });

  it("revalidation failure keeps the shown value (no FREE downgrade) and is not retried", async () => {
    const calls = stubSubscriptionAction(async () => {
      throw new Error("network down");
    });
    pc.setCachedPlan("PRO");
    const seen: string[] = [];
    const off = pc.subscribeCachedPlan((p) => seen.push(p));

    assert.equal(await pc.fetchPlanCached(), "PRO");
    await drain();
    assert.equal(pc.getCachedPlan(), "PRO"); // transient error must not flash FREE
    assert.deepEqual(seen, []);

    // The session's one revalidation is spent — no retry storm.
    assert.equal(await pc.fetchPlanCached(), "PRO");
    await drain();
    assert.equal(calls(), 1);
    off();
  });

  it("foreground failure falls back to FREE in memory but never persists over a stored plan", async () => {
    const calls = stubSubscriptionAction(async () => {
      throw new Error("offline");
    });
    store.set(STORAGE_KEY, "PRO"); // a previous session's real plan on disk

    assert.equal(await pc.fetchPlanCached(), "FREE"); // in-memory fallback
    assert.equal(pc.getCachedPlan(), "FREE");
    assert.equal(store.get(STORAGE_KEY), "PRO"); // error fallback NOT persisted
    assert.equal(calls(), 1);
  });

  it("clearCachedPlan resets the session flag — a reseeded value revalidates again", async () => {
    const calls = stubSubscriptionAction(async () => ({
      data: { planId: "PRO" },
    }));
    pc.setCachedPlan("PRO");
    await pc.fetchPlanCached(); // revalidation #1
    await drain();
    assert.equal(calls(), 1);

    pc.clearCachedPlan(); // sign-out
    pc.setCachedPlan("PRO"); // next session-style seed
    await pc.fetchPlanCached(); // must revalidate again
    await drain();
    assert.equal(calls(), 2);
  });

  it("a revalidation landing after clearCachedPlan does not resurrect the stale plan", async () => {
    const d = deferred<ActionResult>();
    const calls = stubSubscriptionAction(() => d.promise);
    pc.setCachedPlan("PRO");
    assert.equal(await pc.fetchPlanCached(), "PRO"); // kicks revalidation
    await drain();
    assert.equal(calls(), 1);

    pc.clearCachedPlan(); // sign-out while the request is in flight
    d.resolve({ data: { planId: "PREMIUM" } }); // previous user's plan arrives late
    await drain();

    assert.equal(pc.getCachedPlan(), null); // not resurrected in memory
    assert.equal(store.has(STORAGE_KEY), false); // not re-persisted either
  });
});
