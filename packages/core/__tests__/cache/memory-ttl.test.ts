/**
 * L1 `memoryTtl` — MONEY-1127.
 *
 * Before this, `CacheClient` wrote L1 and L2 with the SAME `config.ttl`, so
 * both tiers expired together and the "L1 = 10s hot tier" documented in
 * CLAUDE.md / PERFORMANCE-IMPROVEMENTS.md (UseMoneyAI archive) did not exist. The new
 * optional `memoryTtl` gives L1 its own (never longer) lifetime, defaulting to
 * `ttl` so every module that has NOT opted in behaves exactly as before.
 *
 * Fully mocked and hermetic: the Redis layer is an inert fake injected through
 * `__setRedisFactoryForTests` (no sockets, RUN_REDIS_TESTS is never set) and
 * expiry is driven by `__setCacheClockForTests` (fake time, no real waits, no
 * timers to leak).
 *
 * Source: packages/core/src/cache/client.ts + packages/core/src/cache/wrapper.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type Redis from "ioredis";
import type { RedisOptions } from "ioredis";
import type { CacheConfig } from "@usemoney/cache";

import { CacheClient, __setCacheClockForTests } from "../../src/cache/client";
import {
  getRedisClient,
  resetRedisClient,
  __setRedisFactoryForTests,
} from "../../src/cache/redis";
import { DEFAULT_CACHE_CONFIGS, getCacheConfig } from "../../src/cache/wrapper";

/** Minimal inert Redis stand-in: an in-memory map, no sockets, no timers. */
class FakeRedis {
  status = "ready";
  readonly store = new Map<string, string>();
  on(): this {
    return this;
  }
  async quit(): Promise<"OK"> {
    this.status = "end";
    return "OK";
  }
  disconnect(): void {
    this.status = "end";
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async setex(key: string, _ttl: number, value: string): Promise<"OK"> {
    this.store.set(key, value);
    return "OK";
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }
}

const SECOND = 1000;

describe("L1 memoryTtl (MONEY-1127)", () => {
  let cache: CacheClient;
  let fake: FakeRedis;
  let clock: number;
  let savedUrl: string | undefined;

  beforeEach(async () => {
    savedUrl = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://fake:6379";
    resetRedisClient();
    fake = new FakeRedis();
    __setRedisFactoryForTests(
      (_url: string, _options: RedisOptions) => fake as unknown as Redis,
    );
    // Materialise the singleton so both tiers share this one fake.
    getRedisClient();

    clock = 1_000_000;
    __setCacheClockForTests(() => clock);

    cache = new CacheClient();
    await cache.clearMemory();
    cache.resetStats();
  });

  afterEach(() => {
    __setCacheClockForTests(null);
    __setRedisFactoryForTests(null);
    resetRedisClient();
    if (savedUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedUrl;
  });

  const withMemoryTtl: CacheConfig = {
    ttl: 300,
    memoryTtl: 20,
    enableMemory: true,
    enableRedis: true,
  };
  const withoutMemoryTtl: CacheConfig = {
    ttl: 300,
    enableMemory: true,
    enableRedis: true,
  };

  // =========================================================================
  // Shorter memoryTtl: L1 expires early, L2 keeps serving
  // =========================================================================

  it("serves from L1 while within memoryTtl", async () => {
    await cache.set("mt:short", { v: 1 }, withMemoryTtl);
    clock += 10 * SECOND;

    assert.deepEqual(await cache.get("mt:short", withMemoryTtl), { v: 1 });
    assert.equal(cache.getStats().memory.hits, 1);
    assert.equal(cache.getStats().redis.hits, 0, "L1 must absorb this read");
  });

  it("expires from L1 after memoryTtl while L2 still serves the value", async () => {
    await cache.set("mt:short", { v: 1 }, withMemoryTtl);

    // Past the 20s L1 lifetime but far inside the 300s L2 lifetime.
    clock += 25 * SECOND;

    assert.deepEqual(
      await cache.get("mt:short", withMemoryTtl),
      { v: 1 },
      "value must still be served — from Redis, not memory",
    );
    const stats = cache.getStats();
    assert.equal(stats.memory.hits, 0, "L1 must have expired");
    assert.equal(stats.redis.hits, 1, "L2 must have served it");
  });

  it("repopulates L1 from L2 with the L1 lifetime, not the L2 lifetime", async () => {
    await cache.set("mt:promote", { v: 1 }, withMemoryTtl);
    clock += 25 * SECOND;
    await cache.get("mt:promote", withMemoryTtl); // promotes L2 → L1

    // Immediately after promotion the entry is hot again...
    cache.resetStats();
    await cache.get("mt:promote", withMemoryTtl);
    assert.equal(cache.getStats().memory.hits, 1);

    // ...but the promoted copy still honours memoryTtl relative to the ORIGINAL
    // write, so it does not become a 300s L1 entry by the back door.
    cache.resetStats();
    clock += 30 * SECOND;
    await cache.get("mt:promote", withMemoryTtl);
    assert.equal(cache.getStats().memory.hits, 0);
    assert.equal(cache.getStats().redis.hits, 1);
  });

  it("expires from both tiers once ttl elapses", async () => {
    await cache.set("mt:both", { v: 1 }, withMemoryTtl);
    clock += 301 * SECOND;

    assert.equal(await cache.get("mt:both", withMemoryTtl), null);
  });

  // =========================================================================
  // No memoryTtl: byte-for-byte the previous behaviour
  // =========================================================================

  it("without memoryTtl, L1 still serves for the full ttl (unchanged behaviour)", async () => {
    await cache.set("mt:legacy", { v: 1 }, withoutMemoryTtl);

    // The same 25s that expired the opted-in module changes nothing here.
    clock += 25 * SECOND;
    assert.deepEqual(await cache.get("mt:legacy", withoutMemoryTtl), { v: 1 });
    assert.equal(cache.getStats().memory.hits, 1);
    assert.equal(cache.getStats().redis.hits, 0, "no extra Redis traffic");

    // Still an L1 hit near the end of the 300s window.
    cache.resetStats();
    clock += 270 * SECOND;
    assert.deepEqual(await cache.get("mt:legacy", withoutMemoryTtl), { v: 1 });
    assert.equal(cache.getStats().memory.hits, 1);
    assert.equal(cache.getStats().redis.hits, 0);
  });

  // =========================================================================
  // Guards
  // =========================================================================

  it("clamps memoryTtl to ttl — L1 may never outlive L2", async () => {
    const config: CacheConfig = {
      ttl: 60,
      memoryTtl: 600,
      enableMemory: true,
      enableRedis: true,
    };
    await cache.set("mt:clamp", { v: 1 }, config);
    clock += 61 * SECOND;
    assert.equal(await cache.get("mt:clamp", config), null);
  });

  it("falls back to ttl for a non-finite or non-positive memoryTtl", async () => {
    for (const [name, bad] of [
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["zero", 0],
      ["negative", -30],
    ] as const) {
      const config: CacheConfig = {
        ttl: 300,
        memoryTtl: bad,
        enableMemory: true,
        enableRedis: true,
      };
      const key = `mt:bad:${name}`;
      cache.resetStats();
      await cache.set(key, { v: 1 }, config);
      clock += 25 * SECOND;
      assert.deepEqual(
        await cache.get(key, config),
        { v: 1 },
        `${name} memoryTtl must degrade to ttl, not to a permanently cold L1`,
      );
      assert.equal(cache.getStats().memory.hits, 1, `${name} served from L1`);
    }
  });

  it("memoryTtl survives getCacheConfig() overrides", () => {
    const config = getCacheConfig("dashboard", { ttl: 30 });
    assert.equal(config.ttl, 30);
    assert.equal(
      config.memoryTtl,
      DEFAULT_CACHE_CONFIGS.dashboard.memoryTtl,
      "an override of ttl must not silently drop the module's memoryTtl",
    );
  });

  // =========================================================================
  // The per-module decisions themselves (documented in wrapper.ts)
  // =========================================================================

  describe("per-module policy", () => {
    it("mutation-invalidated user-scoped modules have a short L1", () => {
      // These are exactly the modules some clear*Cache() in invalidation.ts
      // names. Redis DEL is global but L1 delete is process-local, so a long L1
      // lets other warm instances serve already-invalidated data.
      const shortened = [
        "dashboard",
        "positions",
        "holdings",
        "trades",
        "mutual-funds",
        "fire",
        "user",
        "brokers",
        "chat",
        "subscription",
        "watchlist",
      ];
      for (const module of shortened) {
        const config = DEFAULT_CACHE_CONFIGS[module];
        assert.ok(config, `${module} must exist in DEFAULT_CACHE_CONFIGS`);
        const memoryTtl = config.memoryTtl;
        assert.equal(
          typeof memoryTtl,
          "number",
          `${module} must declare a memoryTtl`,
        );
        assert.ok(
          typeof memoryTtl === "number" && memoryTtl > 0 && memoryTtl <= 30,
          `${module} memoryTtl should be a short hot-tier value (got ${String(memoryTtl)})`,
        );
        assert.ok(
          typeof memoryTtl === "number" && memoryTtl < config.ttl,
          `${module} memoryTtl must be shorter than its Redis ttl`,
        );
      }
    });

    it("the big long-lived global blobs keep a long L1", () => {
      // discover / discover-mf are multi-MB universes on a 24h TTL that nothing
      // invalidates. A short L1 would add a Redis GET + multi-MB JSON.parse
      // every expiry to return byte-identical data — strictly worse.
      for (const module of ["discover", "discover-mf"]) {
        const config = DEFAULT_CACHE_CONFIGS[module];
        assert.equal(config.ttl, 24 * 60 * 60);
        assert.equal(
          config.memoryTtl,
          undefined,
          `${module} must NOT opt into a short L1`,
        );
      }
    });

    it("modules with no invalidator keep L1 == L2", () => {
      // L1 and L2 hold the identical entry with the identical expiry, so a
      // short L1 buys zero freshness and costs a GET + re-parse.
      for (const module of [
        "content",
        "instrument",
        "risk",
        "tax",
        "fund-comparison",
        "learning",
        "market",
        "mf-metadata",
      ]) {
        assert.equal(
          DEFAULT_CACHE_CONFIGS[module].memoryTtl,
          undefined,
          `${module} must not declare a memoryTtl`,
        );
      }
    });

    it("memory-disabled modules are untouched", () => {
      for (const module of ["mf-nav", "fund-composition"]) {
        assert.equal(DEFAULT_CACHE_CONFIGS[module].enableMemory, false);
        assert.equal(DEFAULT_CACHE_CONFIGS[module].memoryTtl, undefined);
      }
    });

    it("every memoryTtl in the table is shorter than its ttl", () => {
      for (const [module, config] of Object.entries(DEFAULT_CACHE_CONFIGS)) {
        if (config.memoryTtl === undefined) continue;
        assert.ok(
          config.memoryTtl < config.ttl,
          `${module}: memoryTtl (${config.memoryTtl}) must be < ttl (${config.ttl})`,
        );
        assert.ok(
          config.enableMemory,
          `${module}: memoryTtl is meaningless with enableMemory=false`,
        );
      }
    });
  });
});
