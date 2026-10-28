/**
 * MONEY-1126 — caching a fail-OPEN entitlement gate.
 *
 * `getSubscriptionAccess` returns `DEFAULT_FREE_ACCESS` on every error path
 * (Clerk unreachable, user unresolvable, service error). Correct as a
 * per-request least-privilege default — and a trap for a cache: writing that
 * FREE would pin a paying user to FREE for the whole TTL across ~30 gated
 * pages, converting a 200ms blip into a minute of "upgrade to access".
 *
 * Same bug class as the PostHog flag cache in MONEY-1123 (commit fe25487a),
 * which had to distinguish "PostHog answered: no flags" from "PostHog did not
 * answer". Here the distinction is carried by `resolve` returning `null`.
 *
 * The two headline assertions:
 *   - a failure is served but NEVER written;
 *   - a cache HIT returns the same entitlement as a cache MISS.
 *
 * Source: apps/web/lib/subscription/access-cache.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  readThroughSubscriptionAccess,
  SUBSCRIPTION_ACCESS_CACHE_IDENTIFIER,
  SUBSCRIPTION_ACCESS_CACHE_CONFIG,
} from "@/lib/subscription/access-cache";

const USER = "6501f2b7c1a2b3d4e5f60718";

/** Stand-in for the SubscriptionAccess shape — only identity matters here. */
interface Access {
  planId: string;
  canAccessAIQueries: boolean;
}

const FREE_FALLBACK: Access = { planId: "FREE", canAccessAIQueries: true };
const REAL_PREMIUM: Access = { planId: "PREMIUM", canAccessAIQueries: true };

/** In-memory stand-in for the Redis/L1 pair, with call counters. */
function makeCache() {
  const store = new Map<string, Access>();
  const stats = { reads: 0, writes: 0, resolves: 0 };

  return {
    store,
    stats,
    read: async (userId: string) => {
      stats.reads += 1;
      return store.get(userId) ?? null;
    },
    write: async (userId: string, value: Access) => {
      stats.writes += 1;
      store.set(userId, value);
    },
    resolver(impl: (userId: string) => Promise<Access | null>) {
      return async (userId: string) => {
        stats.resolves += 1;
        return impl(userId);
      };
    },
  };
}

describe("subscription access cache: the happy path", () => {
  let cache: ReturnType<typeof makeCache>;

  beforeEach(() => {
    cache = makeCache();
  });

  it("resolves on a miss and writes the result", async () => {
    const out = await readThroughSubscriptionAccess<Access>(USER, {
      read: cache.read,
      write: cache.write,
      resolve: cache.resolver(async () => REAL_PREMIUM),
      fallback: FREE_FALLBACK,
    });

    assert.deepEqual(out, REAL_PREMIUM);
    assert.equal(cache.stats.writes, 1);
    assert.deepEqual(cache.store.get(USER), REAL_PREMIUM);
  });

  it("serves a hit without touching the database", async () => {
    cache.store.set(USER, REAL_PREMIUM);

    const out = await readThroughSubscriptionAccess<Access>(USER, {
      read: cache.read,
      write: cache.write,
      resolve: cache.resolver(async () => {
        throw new Error("must not be called on a hit");
      }),
      fallback: FREE_FALLBACK,
    });

    assert.deepEqual(out, REAL_PREMIUM);
    assert.equal(cache.stats.resolves, 0);
  });

  it("[regression] a HIT returns the same entitlement as a MISS", async () => {
    const deps = {
      read: cache.read,
      write: cache.write,
      resolve: cache.resolver(async () => REAL_PREMIUM),
      fallback: FREE_FALLBACK,
    };

    const onMiss = await readThroughSubscriptionAccess<Access>(USER, deps);
    const onHit = await readThroughSubscriptionAccess<Access>(USER, deps);

    assert.deepEqual(onHit, onMiss);
    assert.equal(cache.stats.resolves, 1, "the second read was served warm");
  });

  it("is scoped per user — one user's plan never answers for another", async () => {
    cache.store.set(USER, REAL_PREMIUM);

    const other = await readThroughSubscriptionAccess<Access>("other_user", {
      read: cache.read,
      write: cache.write,
      resolve: cache.resolver(async () => FREE_FALLBACK),
      fallback: FREE_FALLBACK,
    });

    assert.equal(other.planId, "FREE");
    assert.deepEqual(cache.store.get(USER), REAL_PREMIUM);
  });
});

describe("subscription access cache: failures are served, never stored", () => {
  let cache: ReturnType<typeof makeCache>;

  beforeEach(() => {
    cache = makeCache();
  });

  it("[security] an unresolvable entitlement returns the fallback and writes NOTHING", async () => {
    const out = await readThroughSubscriptionAccess<Access>(USER, {
      read: cache.read,
      write: cache.write,
      // `getSubscriptionAccessForUser` returned { success: false }
      resolve: cache.resolver(async () => null),
      fallback: FREE_FALLBACK,
    });

    assert.deepEqual(out, FREE_FALLBACK, "fail-open for THIS request");
    assert.equal(cache.stats.writes, 0, "the failure must not be persisted");
    assert.equal(cache.store.has(USER), false);
  });

  it("[security] a THROWN resolution returns the fallback and writes NOTHING", async () => {
    const out = await readThroughSubscriptionAccess<Access>(USER, {
      read: cache.read,
      write: cache.write,
      resolve: cache.resolver(async () => {
        throw new Error("mongo timeout");
      }),
      fallback: FREE_FALLBACK,
    });

    assert.deepEqual(out, FREE_FALLBACK);
    assert.equal(cache.stats.writes, 0);
  });

  it("[security] a paying user is NOT pinned to FREE — the next call returns the real plan", async () => {
    let attempt = 0;
    const resolve = cache.resolver(async () => {
      attempt += 1;
      return attempt === 1 ? null : REAL_PREMIUM; // blip, then healthy
    });
    const deps = {
      read: cache.read,
      write: cache.write,
      resolve,
      fallback: FREE_FALLBACK,
    };

    const duringBlip = await readThroughSubscriptionAccess<Access>(USER, deps);
    assert.equal(duringBlip.planId, "FREE");

    const afterBlip = await readThroughSubscriptionAccess<Access>(USER, deps);
    assert.equal(
      afterBlip.planId,
      "PREMIUM",
      "the very next request re-resolves; no TTL of wrong entitlement"
    );
    assert.deepEqual(cache.store.get(USER), REAL_PREMIUM);
  });

  it("[security] repeated failures never accumulate a cached FREE", async () => {
    const deps = {
      read: cache.read,
      write: cache.write,
      resolve: cache.resolver(async () => null),
      fallback: FREE_FALLBACK,
    };

    for (let i = 0; i < 4; i += 1) {
      const out = await readThroughSubscriptionAccess<Access>(USER, deps);
      assert.equal(out.planId, "FREE");
    }

    assert.equal(cache.stats.writes, 0);
    assert.equal(cache.stats.resolves, 4, "every request re-resolved");
  });
});

describe("subscription access cache: the cache layer is never load-bearing", () => {
  it("a throwing READ degrades to a miss, not to an error", async () => {
    const cache = makeCache();

    const out = await readThroughSubscriptionAccess<Access>(USER, {
      read: async () => {
        throw new Error("redis down");
      },
      write: cache.write,
      resolve: cache.resolver(async () => REAL_PREMIUM),
      fallback: FREE_FALLBACK,
    });

    assert.deepEqual(out, REAL_PREMIUM);
    assert.equal(cache.stats.resolves, 1);
  });

  it("a throwing WRITE still returns the freshly resolved entitlement", async () => {
    const cache = makeCache();

    const out = await readThroughSubscriptionAccess<Access>(USER, {
      read: cache.read,
      write: async () => {
        throw new Error("redis down");
      },
      resolve: cache.resolver(async () => REAL_PREMIUM),
      fallback: FREE_FALLBACK,
    });

    assert.deepEqual(out, REAL_PREMIUM);
  });
});

describe("subscription access cache: coordinates", () => {
  it("lives under the `subscription` module identifier that clearSubscriptionCache sweeps", () => {
    // `clearSubscriptionCache(userId)` deletes `subscription:{userId}:*`
    // (packages/core/src/cache/invalidation.ts), so any identifier under that
    // module is dropped by the existing invalidator.
    assert.equal(SUBSCRIPTION_ACCESS_CACHE_IDENTIFIER, "access");
  });

  it("[security] the TTL stays short and the L1 ceiling shorter", () => {
    // A long TTL is how a stale entitlement outlives an upgrade; a long L1 is
    // how it outlives an invalidation on OTHER warm instances (deletePattern
    // clears Redis globally but only the local memory tier).
    assert.ok(
      SUBSCRIPTION_ACCESS_CACHE_CONFIG.ttl <= 60,
      "entitlement must not be cached for more than a minute"
    );
    assert.ok(
      SUBSCRIPTION_ACCESS_CACHE_CONFIG.memoryTtl <
        SUBSCRIPTION_ACCESS_CACHE_CONFIG.ttl,
      "L1 must expire before L2 so cross-instance staleness is bounded"
    );
    assert.equal(SUBSCRIPTION_ACCESS_CACHE_CONFIG.enableRedis, true);
  });
});
