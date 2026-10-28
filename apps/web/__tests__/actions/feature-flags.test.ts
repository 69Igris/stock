/**
 * MONEY-620 — feature-flag server actions END-TO-END (real handlers).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a SHADOW: it re-declared `generateFlagVersion`,
 * `generateCacheKey`, the boolean-coercion logic and a `FEATURE_FLAG_KEYS` map
 * (with a STALE shape — it listed "/documents" as gated, which the real source
 * does NOT) — then asserted the COPIES. It imported NOTHING from
 * `lib/actions/feature-flags.ts`. So the compliance-critical behaviours never
 * ran on the shipping code: the MONEY-457 FORCE_DISABLED kill-switch for
 * "/paper-trading", the "deny on undefined flag" default, the unauthenticated
 * default flags, the shipped-routes-always-on guarantee, and the PostHog
 * boolean/string coercion.
 *
 * This rewrite drives the REAL exported `getFeatureFlags`, `getUsFeatureFlags`,
 * `getAppFeatureFlags` through the `require.cache` seam. `@/lib/types/feature-
 * flags` is kept REAL (pure constants), so ALWAYS_ON_ROUTES / route shapes are
 * the genuine ones. We stub `@clerk/nextjs/server`, `@/lib/redis/cache`, the
 * logger, and `global.fetch` (the PostHog Decide boundary). Assertions target
 * the action's OWN logic:
 *   - unauthenticated → default flags (shipped ON, gated OFF), kill-switch applied.
 *   - "/paper-trading" is ALWAYS false even when PostHog returns true (MONEY-457).
 *   - a gated flag absent from PostHog → DENIED (false).
 *   - a gated flag string "true"/"" → coerced correctly.
 *   - shipped routes (e.g. "/roast", "/holdings") are true regardless of PostHog.
 *   - a thrown PostHog fetch / cache → safe default flags (never throws).
 *   - US + App flags: default-false on unauth, string/boolean coercion, error default.
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
  /** PostHog Decide `featureFlags` payload */
  posthogFlags: Record<string, boolean | string>;
  /** force fetch() to reject */
  fetchThrows?: Error;
  /** force getCachedFlags to reject */
  redisThrows?: Error;
  fetchCalls: number;
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
    fetchCalls: 0,
  };
}

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
      auth: () => Promise.resolve({ userId: h.clerkUserId }),
      currentUser: () => Promise.resolve(h.currentUser),
    },
  };
  cache[redisPath] = {
    exports: {
      __esModule: true,
      getCachedFlags: () => {
        if (h.redisThrows) return Promise.reject(h.redisThrows);
        return Promise.resolve(null); // always a cache miss → forces evaluation
      },
      setCachedFlags: () => Promise.resolve("v-stub"),
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

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — feature-flags actions (real handlers, mocked PostHog/cache)", () => {
  let h: Harness;
  const realFetch = globalThis.fetch;
  const savedPhKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

  beforeEach(() => {
    h = freshHarness();
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "ph-test-key";
    // Install a fetch double the action's PostHog Decide call hits.
    globalThis.fetch = (async () => {
      h.fetchCalls += 1;
      if (h.fetchThrows) throw h.fetchThrows;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ featureFlags: h.posthogFlags }),
      } as unknown as Response;
    }) as typeof fetch;
  });
  after(() => {
    restoreCache();
    globalThis.fetch = realFetch;
    if (savedPhKey === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    else process.env.NEXT_PUBLIC_POSTHOG_KEY = savedPhKey;
  });

  describe("getFeatureFlags", () => {
    it("unauthenticated → default flags (shipped ON, gated OFF), no PostHog call", async () => {
      h.clerkUserId = null;
      const action = loadAction(h);
      const res = await action.getFeatureFlags();
      assert.equal(res.flags["/holdings"], true);
      assert.equal(res.flags["/roast"], true);
      assert.equal(res.flags["/risk"], false);
      assert.equal(res.flags["/paper-trading"], false);
      assert.equal(h.fetchCalls, 0);
      assert.equal(typeof res.version, "string");
    });

    it("MONEY-457: '/paper-trading' stays FALSE even when PostHog returns true (kill-switch)", async () => {
      h.posthogFlags = {
        "page-visibility-paper-trading": true,
        "page-visibility-risk": true,
      };
      const action = loadAction(h);
      const res = await action.getFeatureFlags();
      assert.equal(
        res.flags["/paper-trading"],
        false,
        "force-disabled route must never be true"
      );
      // a non-killed gated route still honours PostHog.
      assert.equal(res.flags["/risk"], true);
    });

    it("a gated flag absent from PostHog → DENIED (false)", async () => {
      h.posthogFlags = {}; // tax flag not present
      const action = loadAction(h);
      const res = await action.getFeatureFlags();
      assert.equal(res.flags["/tax"], false);
      assert.equal(res.flags["/quizzes"], false);
    });

    it("a gated flag as the string 'false'/'off' → false; non-empty string → true", async () => {
      h.posthogFlags = {
        "page-visibility-tax": "false",
        "page-visibility-risk": "variant-a",
        "page-visibility-learning": "off",
      };
      const action = loadAction(h);
      const res = await action.getFeatureFlags();
      assert.equal(res.flags["/tax"], false);
      assert.equal(res.flags["/learning"], false);
      assert.equal(res.flags["/risk"], true);
    });

    it("shipped routes are always true regardless of PostHog", async () => {
      h.posthogFlags = {}; // PostHog says nothing
      const action = loadAction(h);
      const res = await action.getFeatureFlags();
      for (const route of [
        "/holdings",
        "/tradebook",
        "/positions",
        "/discover",
        "/analysis",
        "/watchlist",
        "/roast",
        "/documents",
      ]) {
        assert.equal(res.flags[route], true, `${route} must be shipped-on`);
      }
    });

    it("a thrown PostHog fetch → safe default flags (never throws)", async () => {
      h.fetchThrows = new Error("network down");
      const action = loadAction(h);
      const res = await action.getFeatureFlags();
      // evaluateFeatureFlags swallows the fetch error → empty posthog → gated denied.
      assert.equal(res.flags["/risk"], false);
      assert.equal(res.flags["/holdings"], true);
      assert.equal(res.flags["/paper-trading"], false);
    });

    it("a thrown Redis cache read → safe default flags (top-level catch)", async () => {
      h.redisThrows = new Error("redis down");
      const action = loadAction(h);
      const res = await action.getFeatureFlags();
      assert.equal(res.flags["/holdings"], true);
      assert.equal(res.flags["/paper-trading"], false);
    });
  });

  describe("getUsFeatureFlags", () => {
    it("unauthenticated (no currentUser) → all US flags default false", async () => {
      h.currentUser = null;
      const action = loadAction(h);
      const res = await action.getUsFeatureFlags();
      assert.equal(res.flags["us-stocks-listing"], false);
      assert.equal(res.flags["global-mf"], false);
      assert.equal(h.fetchCalls, 0);
    });

    it("targeted user: PostHog true / non-empty string → enabled; absent → false", async () => {
      h.posthogFlags = {
        "us-stocks-listing": true,
        "global-mf": "on",
      };
      const action = loadAction(h);
      const res = await action.getUsFeatureFlags();
      assert.equal(res.flags["us-stocks-listing"], true);
      assert.equal(res.flags["global-mf"], true);
      assert.equal(res.flags["us-broker-ib"], false);
    });

    it("a thrown fetch → all US flags default false (never throws)", async () => {
      h.fetchThrows = new Error("boom");
      const action = loadAction(h);
      const res = await action.getUsFeatureFlags();
      assert.equal(res.flags["us-stocks-listing"], false);
    });
  });

  describe("getAppFeatureFlags", () => {
    it("unauthenticated → all app flags default false", async () => {
      h.currentUser = null;
      const action = loadAction(h);
      const res = await action.getAppFeatureFlags();
      assert.equal(res.flags["generate-report"], false);
      assert.equal(h.fetchCalls, 0);
    });

    it("targeted user: 'generate-report' true is honoured; others stay false", async () => {
      h.posthogFlags = { "generate-report": true };
      const action = loadAction(h);
      const res = await action.getAppFeatureFlags();
      assert.equal(res.flags["generate-report"], true);
      assert.equal(res.flags["terminal-luxe-news"], false);
    });
  });
});
