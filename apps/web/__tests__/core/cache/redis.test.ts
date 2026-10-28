/**
 * Redis Client Tests
 *
 * Exercises the REAL Redis client helpers exported from
 * packages/core/src/cache/redis.ts (via `@usemoney/core/cache`):
 * `isRedisConfigured`, `getRedisClient`, `isRedisConnected`,
 * `closeRedisConnection`, `resetRedisClient`. No inline reimplementation.
 *
 * Hermetic by construction: these tests NEVER set a real `REDIS_URL` that would
 * make `getRedisClient()` open an `ioredis` socket (that would leave an open
 * handle and trip the orphan guard). They drive the REAL module-level singleton
 * along its NO-URL paths — `getRedisClient()` returns null without connecting,
 * repeated calls stay null, and `resetRedisClient()` / `closeRedisConnection()`
 * are safe no-ops with no client. `isRedisConfigured()` is pure env-reads, so
 * its REDIS_URL / UPSTASH_REDIS_REST_URL / KV_URL resolution is asserted
 * directly.
 *
 * MONEY-1127 note: "unconfigured" is no longer treated as a failed connection
 * ATTEMPT — it does not consume the retry budget, because there is nothing to
 * retry. The attempt budget, its exponential cooldown, the single-client
 * concurrency guarantee and the dispose-before-replace rule are exercised
 * against an injected fake client (no sockets) in
 * `packages/core/__tests__/cache/redis-singleton.test.ts`.
 *
 * The live-connection paths the old shadow faked with a mock RedisClientManager
 * (TLS detection, ready-singleton reuse, simulated disconnect/reconnect) require
 * a real Redis and are covered by the gated `test:cache:redis` suite — they are
 * intentionally NOT re-faked here (faking them would re-introduce the shadow).
 *
 * Source: packages/core/src/cache/redis.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  isRedisConfigured,
  getRedisClient,
  isRedisConnected,
  closeRedisConnection,
  resetRedisClient,
} from "@usemoney/core/cache";

const URL_ENV_KEYS = ["REDIS_URL", "UPSTASH_REDIS_REST_URL", "KV_URL"] as const;

describe("Redis Client (real @usemoney/core exports)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of URL_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    resetRedisClient();
  });

  afterEach(async () => {
    await closeRedisConnection();
    resetRedisClient();
    for (const key of URL_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // ==========================================================================
  // isRedisConfigured — env resolution (pure, no connection)
  // ==========================================================================

  describe("isRedisConfigured", () => {
    it("should return false when no Redis URL env var is set", () => {
      assert.strictEqual(isRedisConfigured(), false);
    });

    it("should return true when REDIS_URL is set", () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      assert.strictEqual(isRedisConfigured(), true);
    });

    it("should return true when only UPSTASH_REDIS_REST_URL is set", () => {
      process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
      assert.strictEqual(isRedisConfigured(), true);
    });

    it("should return true when only KV_URL is set", () => {
      process.env.KV_URL = "redis://kv.example";
      assert.strictEqual(isRedisConfigured(), true);
    });

    it("should remain true when REDIS_URL coexists with the fallbacks", () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
      process.env.KV_URL = "redis://kv.example";
      assert.strictEqual(isRedisConfigured(), true);
    });

    it("should return false once all URL env vars are cleared", () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      assert.strictEqual(isRedisConfigured(), true);
      delete process.env.REDIS_URL;
      assert.strictEqual(isRedisConfigured(), false);
    });
  });

  // ==========================================================================
  // getRedisClient — no-URL path (pure, never opens a socket)
  // ==========================================================================

  describe("getRedisClient (unconfigured)", () => {
    it("should return null when Redis is not configured", () => {
      assert.strictEqual(getRedisClient(), null);
    });

    it("should keep returning null across repeated calls without a URL", () => {
      assert.strictEqual(getRedisClient(), null);
      assert.strictEqual(getRedisClient(), null);
      assert.strictEqual(getRedisClient(), null);
    });
  });

  // ==========================================================================
  // Repeated unconfigured calls — no socket, no state accumulation (no URL)
  // ==========================================================================

  describe("repeated unconfigured calls", () => {
    it("should keep returning null however many times it is called", () => {
      // With no URL nothing is constructed and nothing is retried: MONEY-1127
      // treats "unconfigured" as a configuration state, not a failed attempt,
      // so it never consumes the retry budget or arms a cooldown.
      for (let i = 0; i < 8; i++) {
        assert.strictEqual(getRedisClient(), null);
      }
    });

    it("should still return null after resetRedisClient()", () => {
      getRedisClient();
      getRedisClient();
      getRedisClient();
      resetRedisClient();
      // State cleared — getRedisClient runs the init path again (null, no URL).
      assert.strictEqual(getRedisClient(), null);
    });
  });

  // ==========================================================================
  // isRedisConnected — no client
  // ==========================================================================

  describe("isRedisConnected", () => {
    it("should report disconnected when no client exists", () => {
      assert.strictEqual(isRedisConnected(), false);
    });

    it("should report disconnected after an unconfigured getRedisClient()", () => {
      getRedisClient();
      assert.strictEqual(isRedisConnected(), false);
    });
  });

  // ==========================================================================
  // closeRedisConnection / resetRedisClient — safe no-ops without a client
  // ==========================================================================

  describe("closeRedisConnection / resetRedisClient", () => {
    it("closeRedisConnection should not throw when there is no client", async () => {
      await closeRedisConnection();
      assert.ok(true);
    });

    it("resetRedisClient should not throw and should leave us disconnected", () => {
      resetRedisClient();
      assert.strictEqual(isRedisConnected(), false);
    });

    it("resetRedisClient should clear connection state so getRedisClient runs init again", () => {
      getRedisClient();
      getRedisClient();
      getRedisClient();
      getRedisClient();
      resetRedisClient();
      assert.strictEqual(getRedisClient(), null); // init path runs again, still null
      assert.strictEqual(isRedisConnected(), false);
    });
  });
});
