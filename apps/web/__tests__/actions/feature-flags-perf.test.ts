/**
 * MONEY-1123 — feature-flag hot-path regressions (real handlers).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE LOCKS DOWN
 * ───────────────────────────────────────────────────────────────────────────
 * 1. CACHE HIT MUST NOT CALL CLERK. `getUsFeatureFlags` used to `await
 *    currentUser()` (an HTTP round trip to Clerk, ~200ms) BEFORE looking at its
 *    cache, so even a 100% hit rate paid it. `/api/market/search` calls this on
 *    every debounced keystroke. The fix reorders it to match `getFeatureFlags`:
 *    `auth()` (signed-cookie read, ~2ms) → cache → `currentUser()` only on a
 *    MISS. This is THE regression test for the ticket.
 *
 * 2. A FAILED POSTHOG EVALUATION IS NEVER CACHED. `fetchFlagsFromPostHog` now
 *    returns `null` on timeout / network error / non-OK / missing API key,
 *    distinct from `{}` ("PostHog answered, matched nothing"). `{}` denies every
 *    gated route, and denials are cached for 5 minutes — so caching a failure
 *    would lock paying users out of gated pages after a 2s PostHog blip.
 *
 * 3. THE FAILURE PATH STILL FAILS CLOSED. MONEY-457's FORCE_DISABLED kill switch
 *    and the "gated routes default OFF" contract survive the new early return.
 *
 * 4. THE DECIDE CALL CARRIES AN ABORT SIGNAL (the 2s timeout).
 *
 * Drives the REAL exported actions through the `require.cache` seam, stubbing
 * `@clerk/nextjs/server`, `@/lib/redis/cache`, the logger and `global.fetch`
 * (the PostHog Decide boundary). No network, no Redis, no timers of our own.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/feature-flags.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

interface Harness {
  /** auth() → clerk userId (null = unauthenticated) */
  clerkUserId: string | null;
  /** currentUser() result */
  currentUser: {
    id: string;
    emailAddresses?: Array<{ emailAddress: string }>;
    fullName?: string | null;
    firstName?: string | null;
  } | null;
  /** PostHog Decide `featureFlags` payload for a SUCCESSFUL response */
  posthogFlags: Record<string, boolean | string>;
  /** force fetch() to reject with this error (network error / timeout) */
  fetchThrows?: Error;
  /** force a non-OK Decide response */
  fetchStatus?: number;
  authCalls: number;
  currentUserCalls: number;
  fetchCalls: number;
  /** every `signal` the action passed to fetch() */
  fetchSignals: unknown[];
  /** Redis writes (setCachedFlags) — must stay 0 on the failure path */
  redisWrites: number;
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorCacheEntries.has(path)) {
    priorCacheEntries.set(path, moduleCache()[path]);
  }
}

const ACTION_REL = "../../lib/actions/feature-flags";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ACTION_REL)];
}

interface FlagsResponse {
  flags: Record<string, boolean>;
  version: string;
  timestamp: number;
}
interface FeatureFlagsModule {
  getFeatureFlags: () => Promise<FlagsResponse>;
  getUsFeatureFlags: () => Promise<FlagsResponse>;
  getAppFeatureFlags: () => Promise<FlagsResponse>;
}

function freshHarness(): Harness {
  return {
    clerkUserId: "clerk_abc",
    currentUser: {
      id: "clerk_abc",
      emailAddresses: [{ emailAddress: "u@x.com" }],
      fullName: "Test User",
    },
    posthogFlags: {},
    authCalls: 0,
    currentUserCalls: 0,
    fetchCalls: 0,
    fetchSignals: [],
    redisWrites: 0,
  };
}

/**
 * Load a FRESH copy of the action module (its in-memory `flagsCache` is
 * module-scoped, so a fresh require = an empty cache) with all boundaries
 * stubbed.
 */
function loadAction(h: Harness): FeatureFlagsModule {
  const cache = moduleCache();

  const clerkPath = require.resolve("@clerk/nextjs/server");
  const redisPath = require.resolve("../../lib/redis/cache");
  const loggerPath = require.resolve("@usemoney/logger");
  const actionPath = require.resolve(ACTION_REL);

  for (const p of [clerkPath, redisPath, loggerPath]) snapshotOnce(p);

  cache[clerkPath] = {
    exports: {
      __esModule: true,
      auth: () => {
        h.authCalls += 1;
        return Promise.resolve({ userId: h.clerkUserId });
      },
      currentUser: () => {
        h.currentUserCalls += 1;
        return Promise.resolve(h.currentUser);
      },
    },
  };
  cache[redisPath] = {
    exports: {
      __esModule: true,
      // Always a Redis MISS so the in-memory cache is the one under test.
      getCachedFlags: () => Promise.resolve(null),
      setCachedFlags: () => {
        h.redisWrites += 1;
        return Promise.resolve("v-stub");
      },
      clearCachedFlags: () => Promise.resolve(),
      clearAllCachedFlags: () => Promise.resolve(),
    },
  };
  const silentLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
    child() {
      return silentLogger;
    },
  };
  cache[loggerPath] = {
    exports: {
      __esModule: true,
      featureFlagsLogger: silentLogger,
      default: silentLogger,
    },
  };

  delete cache[actionPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as FeatureFlagsModule;
}

/** An error shaped like the one `AbortSignal.timeout()` rejects with. */
function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1123 — feature-flag hot path (real handlers)", () => {
  let h: Harness;
  const realFetch = globalThis.fetch;
  const savedPhKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

  beforeEach(() => {
    h = freshHarness();
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "ph-test-key";
    globalThis.fetch = (async (
      _input: unknown,
      init?: { signal?: unknown }
    ) => {
      h.fetchCalls += 1;
      h.fetchSignals.push(init?.signal);
      if (h.fetchThrows) throw h.fetchThrows;
      const status = h.fetchStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        json: async () => ({ featureFlags: h.posthogFlags }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  });

  after(() => {
    restoreCache();
    globalThis.fetch = realFetch;
    if (savedPhKey === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    else process.env.NEXT_PUBLIC_POSTHOG_KEY = savedPhKey;
  });

  // ───────────────────────────────────────────────────────────────────────
  // 1. THE REGRESSION: cache hit must not touch Clerk's API
  // ───────────────────────────────────────────────────────────────────────
  describe("getUsFeatureFlags — cache hit does NOT call currentUser()", () => {
    it("second call is served from cache: currentUser() stays at 1, PostHog at 1", async () => {
      h.posthogFlags = { "us-stocks-listing": true };
      const action = loadAction(h);

      const first = await action.getUsFeatureFlags();
      assert.equal(first.flags["us-stocks-listing"], true);
      assert.equal(h.currentUserCalls, 1, "miss must resolve the Clerk user");
      assert.equal(h.fetchCalls, 1);

      const second = await action.getUsFeatureFlags();

      assert.equal(
        h.currentUserCalls,
        1,
        "REGRESSION (MONEY-1123): a cache HIT must not call currentUser()"
      );
      assert.equal(h.fetchCalls, 1, "a cache hit must not re-evaluate PostHog");
      assert.deepEqual(second.flags, first.flags);
      assert.equal(second.version, first.version);
    });

    it("auth() IS used on every call — it is the cheap signed-cookie read", async () => {
      const action = loadAction(h);
      await action.getUsFeatureFlags();
      await action.getUsFeatureFlags();
      assert.equal(h.authCalls, 2);
      assert.equal(h.currentUserCalls, 1);
    });

    it("unauthenticated (auth() → no userId) short-circuits before Clerk + PostHog", async () => {
      h.clerkUserId = null;
      const action = loadAction(h);
      const res = await action.getUsFeatureFlags();
      assert.equal(res.flags["us-stocks-listing"], false);
      assert.equal(
        h.currentUserCalls,
        0,
        "no Clerk HTTP call for a signed-out user"
      );
      assert.equal(h.fetchCalls, 0);
    });

    it("getFeatureFlags keeps the same property (the template it was copied from)", async () => {
      h.posthogFlags = { "page-visibility-risk": true };
      const action = loadAction(h);
      await action.getFeatureFlags();
      assert.equal(h.currentUserCalls, 1);
      const second = await action.getFeatureFlags();
      assert.equal(
        h.currentUserCalls,
        1,
        "cache hit must not call currentUser()"
      );
      assert.equal(second.flags["/risk"], true);
    });

    it("getAppFeatureFlags keeps the same property (identical copy-drift, fixed)", async () => {
      h.posthogFlags = { "generate-report": true };
      const action = loadAction(h);
      const first = await action.getAppFeatureFlags();
      assert.equal(first.flags["generate-report"], true);
      assert.equal(h.currentUserCalls, 1);
      const second = await action.getAppFeatureFlags();
      assert.equal(
        h.currentUserCalls,
        1,
        "cache hit must not call currentUser()"
      );
      assert.equal(second.flags["generate-report"], true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 2. A FAILED EVALUATION IS NEVER CACHED
  // ───────────────────────────────────────────────────────────────────────
  describe("PostHog failure is served but NOT cached", () => {
    it("getFeatureFlags: a rejected fetch returns defaults and writes NEITHER cache", async () => {
      h.fetchThrows = new Error("network down");
      const action = loadAction(h);

      const failed = await action.getFeatureFlags();
      assert.equal(
        failed.flags["/risk"],
        false,
        "gated routes deny on failure"
      );
      assert.equal(failed.flags["/holdings"], true, "shipped routes stay on");
      assert.equal(h.redisWrites, 0, "must not write the Redis cache");

      // The very next request must RE-EVALUATE (nothing was cached).
      delete h.fetchThrows;
      h.posthogFlags = { "page-visibility-risk": true };
      const recovered = await action.getFeatureFlags();

      assert.equal(
        recovered.flags["/risk"],
        true,
        "a 2s PostHog blip must not deny gated routes for the 5-minute TTL"
      );
      assert.equal(h.fetchCalls, 2, "the failure must not have been cached");
      assert.equal(
        h.redisWrites,
        1,
        "only the successful evaluation is cached"
      );
    });

    it("getFeatureFlags: an AbortSignal TIMEOUT is treated as a failure, not as '{}'", async () => {
      h.fetchThrows = timeoutError();
      const action = loadAction(h);

      const failed = await action.getFeatureFlags();
      assert.equal(failed.flags["/tax"], false);
      assert.equal(h.redisWrites, 0);

      delete h.fetchThrows;
      h.posthogFlags = { "page-visibility-tax": true };
      const recovered = await action.getFeatureFlags();
      assert.equal(recovered.flags["/tax"], true);
    });

    it("getFeatureFlags: a non-OK Decide status is a failure, not an empty evaluation", async () => {
      h.fetchStatus = 503;
      const action = loadAction(h);

      const failed = await action.getFeatureFlags();
      assert.equal(failed.flags["/learning"], false);
      assert.equal(h.redisWrites, 0);

      h.fetchStatus = 200;
      h.posthogFlags = { "page-visibility-learning": true };
      const recovered = await action.getFeatureFlags();
      assert.equal(recovered.flags["/learning"], true);
    });

    it("getFeatureFlags: a missing PostHog API key evaluates to no-flags and IS cached", async () => {
      delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
      const action = loadAction(h);

      const res = await action.getFeatureFlags();
      assert.equal(res.flags["/risk"], false, "gated routes stay closed");
      assert.equal(h.fetchCalls, 0, "no key → no network call at all");

      // An absent key cannot be cured by retrying, so unlike a timeout it is a
      // real (empty) answer and must be cached. Leaving it uncacheable would
      // make every request a miss, and every miss pays a ~200ms Clerk
      // currentUser() — reintroducing the latency MONEY-1123 exists to remove.
      assert.equal(h.redisWrites, 1, "a permanent config state is cacheable");

      await action.getFeatureFlags();
      assert.equal(h.currentUserCalls, 1, "second call is served from cache");
    });

    it("an EMPTY successful evaluation ({}) IS cached — it is a real answer", async () => {
      h.posthogFlags = {}; // PostHog answered: you match nothing.
      const action = loadAction(h);

      const first = await action.getFeatureFlags();
      assert.equal(first.flags["/risk"], false);
      assert.equal(h.redisWrites, 1);

      await action.getFeatureFlags();
      assert.equal(h.fetchCalls, 1, "an empty answer is cached like any other");
    });

    it("getUsFeatureFlags: a failure returns defaults and is NOT cached", async () => {
      h.fetchThrows = timeoutError();
      const action = loadAction(h);

      const failed = await action.getUsFeatureFlags();
      assert.equal(failed.flags["us-stocks-listing"], false);
      assert.equal(failed.flags["global-mf"], false);

      delete h.fetchThrows;
      h.posthogFlags = { "us-stocks-listing": true };
      const recovered = await action.getUsFeatureFlags();

      assert.equal(
        recovered.flags["us-stocks-listing"],
        true,
        "the failed evaluation must not have been cached"
      );
      assert.equal(h.fetchCalls, 2);
    });

    it("getAppFeatureFlags: a failure returns defaults and is NOT cached", async () => {
      h.fetchThrows = new Error("boom");
      const action = loadAction(h);

      const failed = await action.getAppFeatureFlags();
      assert.equal(failed.flags["generate-report"], false);

      delete h.fetchThrows;
      h.posthogFlags = { "generate-report": true };
      const recovered = await action.getAppFeatureFlags();
      assert.equal(recovered.flags["generate-report"], true);
      assert.equal(h.fetchCalls, 2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3. THE FAILURE PATH STILL FAILS CLOSED
  // ───────────────────────────────────────────────────────────────────────
  describe("kill switch + fail-closed on the failure path", () => {
    it("MONEY-457: '/paper-trading' stays FALSE when the evaluation fails", async () => {
      h.fetchThrows = timeoutError();
      const action = loadAction(h);
      const res = await action.getFeatureFlags();
      assert.equal(
        res.flags["/paper-trading"],
        false,
        "a force-disabled route must never open up on an error path"
      );
    });

    it("every gated route denies on failure; every shipped route stays on", async () => {
      h.fetchThrows = new Error("network down");
      const action = loadAction(h);
      const res = await action.getFeatureFlags();

      for (const gated of [
        "/paper-trading",
        "/sage-tutor",
        "/learning",
        "/risk",
        "/tax",
        "/strategies",
        "/quizzes",
        "/discover/scans",
      ]) {
        assert.equal(res.flags[gated], false, `${gated} must fail closed`);
      }
      for (const shipped of [
        "/holdings",
        "/tradebook",
        "/positions",
        "/discover",
        "/analysis",
        "/watchlist",
        "/roast",
        "/documents",
      ]) {
        assert.equal(res.flags[shipped], true, `${shipped} must stay on`);
      }
    });

    it("'/paper-trading' stays FALSE even when a SUCCESSFUL evaluation says true", async () => {
      h.posthogFlags = { "page-visibility-paper-trading": true };
      const action = loadAction(h);
      const res = await action.getFeatureFlags();
      assert.equal(res.flags["/paper-trading"], false);
    });

    it("MONEY-1138: '/discover/scans' is NOT kill-switched — the route stays open", async () => {
      // Scans is hidden from NAVIGATION only. Unlike /paper-trading it is not
      // in FORCE_DISABLED_ROUTES, because the route must remain reachable by
      // URL for whoever the `page-visibility-scans` PostHog flag targets
      // (currently deepshaswat@gmail.com). Kill-switching it would close the
      // route as well, which is the opposite of the intent.
      h.posthogFlags = { "page-visibility-scans": true };
      const action = loadAction(h);
      const res = await action.getFeatureFlags();
      assert.equal(
        res.flags["/discover/scans"],
        true,
        "the flag must still grant route access to its targeted users"
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 4. THE DECIDE CALL IS TIME-BOUNDED
  // ───────────────────────────────────────────────────────────────────────
  describe("Decide request is time-bounded", () => {
    it("passes an AbortSignal to fetch (the 2s timeout)", async () => {
      const action = loadAction(h);
      await action.getFeatureFlags();
      assert.equal(h.fetchSignals.length, 1);
      assert.ok(
        h.fetchSignals[0] instanceof AbortSignal,
        "fetch must receive an AbortSignal so a hung PostHog cannot stall the request"
      );
    });
  });
});
