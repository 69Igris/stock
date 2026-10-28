/**
 * Redis singleton lifecycle — MONEY-1127.
 *
 * Regression guard for the cold-start CONNECTION STORM. The pre-fix getter
 * only returned the client once `status === "ready"` and cleared its
 * `isConnecting` boolean inside the same synchronous try/finally, so for the
 * ~50-300ms of the TCP+TLS handshake every concurrent caller built a BRAND-NEW
 * ioredis client, overwrote the module variable and orphaned the previous
 * socket (never `quit()`ed) — up to MAX_CONNECTION_ATTEMPTS leaked connections
 * per cold start against a node whose ceiling is ~50.
 *
 * Fully mocked: `__setRedisFactoryForTests` swaps in an inert fake, so no test
 * here opens a TCP socket, sets RUN_REDIS_TESTS, or leaves an open handle.
 * `__setRedisClockForTests` drives the retry backoff with fake time — there are
 * no real waits and no timers to leak.
 *
 * Source: packages/core/src/cache/redis.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type Redis from "ioredis";
import type { RedisOptions } from "ioredis";

import {
  getRedisClient,
  getRedisClientAsync,
  isRedisConfigured,
  isRedisConnected,
  closeRedisConnection,
  resetRedisClient,
  __setRedisClockForTests,
  __setRedisFactoryForTests,
} from "../../src/cache/redis";
import { CacheClient, __setCacheClockForTests } from "../../src/cache/client";
import type { CacheConfig } from "@usemoney/cache";

// ---------------------------------------------------------------------------
// Fake ioredis client — inert, no sockets, no timers.
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

class FakeRedis {
  status: string;
  quitCalls = 0;
  disconnectCalls = 0;
  readonly handlers = new Map<string, Handler[]>();
  readonly store = new Map<string, string>();
  /** When set, every command rejects with this error (Redis-down simulation). */
  failWith: Error | null = null;

  constructor(
    readonly url: string,
    status = "connecting",
  ) {
    this.status = status;
  }

  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  /** Fire a lifecycle event the way ioredis would. */
  emit(event: string): void {
    for (const h of this.handlers.get(event) ?? []) h();
  }

  async quit(): Promise<"OK"> {
    this.quitCalls++;
    this.status = "end";
    return "OK";
  }

  disconnect(): void {
    this.disconnectCalls++;
    this.status = "end";
  }

  async get(key: string): Promise<string | null> {
    if (this.failWith) throw this.failWith;
    return this.store.get(key) ?? null;
  }

  async setex(key: string, _ttl: number, value: string): Promise<"OK"> {
    if (this.failWith) throw this.failWith;
    this.store.set(key, value);
    return "OK";
  }

  async set(key: string, value: string): Promise<"OK"> {
    if (this.failWith) throw this.failWith;
    this.store.set(key, value);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    if (this.failWith) throw this.failWith;
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }

  async scan(..._args: unknown[]): Promise<[string, string[]]> {
    if (this.failWith) throw this.failWith;
    return ["0", [...this.store.keys()]];
  }

  async ping(): Promise<"PONG"> {
    if (this.failWith) throw this.failWith;
    return "PONG";
  }
}

/** Records every construction so "exactly one client" is directly assertable. */
function installFactory(
  build: (url: string, index: number) => FakeRedis,
): FakeRedis[] {
  const built: FakeRedis[] = [];
  __setRedisFactoryForTests((url: string, _options: RedisOptions) => {
    const fake = build(url, built.length);
    built.push(fake);
    return fake as unknown as Redis;
  });
  return built;
}

const URL_ENV_KEYS = [
  "REDIS_URL",
  "UPSTASH_REDIS_REST_URL",
  "KV_URL",
  "REDIS_HOST",
  "REDIS_PORT",
  "REDIS_AUTH_STRING",
] as const;

describe("Redis singleton (MONEY-1127)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of URL_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    resetRedisClient();
  });

  afterEach(() => {
    resetRedisClient();
    __setRedisFactoryForTests(null);
    __setRedisClockForTests(null);
    __setCacheClockForTests(null);
    for (const key of URL_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // =========================================================================
  // 1. Single client under concurrency — THE storm regression guard
  // =========================================================================

  describe("single client under concurrency", () => {
    it("constructs exactly ONE client for N concurrent getRedisClient() calls during a slow handshake", async () => {
      process.env.REDIS_URL = "redis://fake:6379";
      // Handshake never completes: status stays "connecting" for the whole
      // test. Under the pre-fix getter (`status === "ready"` required, boolean
      // guard already cleared) this is precisely the window in which every
      // caller built its own client.
      const built = installFactory((url) => new FakeRedis(url, "connecting"));

      const results: Array<Redis | null> = [];
      for (let i = 0; i < 25; i++) {
        results.push(getRedisClient());
        // Yield so each call resumes as a separate continuation — the real
        // shape of concurrent lambda requests, not a tight sync loop.
        await Promise.resolve();
      }

      assert.equal(
        built.length,
        1,
        "exactly one ioredis client may be constructed per process",
      );
      assert.ok(
        results.every((r) => r !== null && r === results[0]),
        "every caller must receive the SAME connecting client",
      );
    });

    it("constructs exactly ONE client for N concurrent getRedisClientAsync() awaiters", async () => {
      process.env.REDIS_URL = "redis://fake:6379";
      const built = installFactory((url) => new FakeRedis(url, "connecting"));

      const clients = await Promise.all(
        Array.from({ length: 25 }, () => getRedisClientAsync()),
      );

      assert.equal(built.length, 1);
      assert.ok(clients.every((c) => c === clients[0] && c !== null));
    });

    it("keeps returning the same instance once the handshake completes", async () => {
      process.env.REDIS_URL = "redis://fake:6379";
      const built = installFactory((url) => new FakeRedis(url, "connecting"));

      const first = getRedisClient();
      assert.equal(isRedisConnected(), false, "connecting is not yet ready");

      built[0].status = "ready";
      built[0].emit("ready");

      assert.equal(getRedisClient(), first);
      assert.equal(await getRedisClientAsync(), first);
      assert.equal(built.length, 1);
      assert.equal(isRedisConnected(), true);
    });

    it("hands out a client that is still connecting (ioredis offline-queues commands)", () => {
      process.env.REDIS_URL = "redis://fake:6379";
      installFactory((url) => new FakeRedis(url, "connecting"));

      // The pre-fix getter returned null here and built a second client on the
      // next call. Returning the connecting client is what closes the window.
      assert.notEqual(getRedisClient(), null);
    });
  });

  // =========================================================================
  // 2. No orphaned clients
  // =========================================================================

  describe("no orphaned clients", () => {
    it("quits the previous client before replacing a dead one", () => {
      process.env.REDIS_URL = "redis://fake:6379";
      const built = installFactory(
        (url, i) =>
          // First client dies; the replacement is healthy.
          new FakeRedis(url, i === 0 ? "connecting" : "ready"),
      );

      const first = getRedisClient();
      assert.notEqual(first, null);

      // Connection collapses terminally.
      built[0].status = "end";

      const second = getRedisClient();
      assert.equal(built.length, 2, "a replacement client was built");
      assert.notEqual(second, first);
      assert.equal(
        built[0].quitCalls + built[0].disconnectCalls,
        1,
        "the replaced client must be quit()/disconnect()ed, never orphaned",
      );
    });

    it("leaves no undisposed client behind across a whole failure ladder", () => {
      process.env.REDIS_URL = "redis://fake:6379";
      __setRedisClockForTests(() => 0);
      const built = installFactory((url) => new FakeRedis(url, "end"));

      for (let i = 0; i < 6; i++) getRedisClient();

      const undisposed = built.filter(
        (c) => c.quitCalls + c.disconnectCalls === 0,
      );
      assert.deepEqual(
        undisposed,
        [],
        "every client that was dropped must have been closed",
      );
    });

    it("closeRedisConnection quits the client and clears the singleton", async () => {
      process.env.REDIS_URL = "redis://fake:6379";
      const built = installFactory((url) => new FakeRedis(url, "ready"));

      getRedisClient();
      await closeRedisConnection();

      assert.equal(built[0].quitCalls, 1);
      assert.equal(isRedisConnected(), false);

      // A later call builds a fresh one rather than handing back a dead ref.
      getRedisClient();
      assert.equal(built.length, 2);
    });

    it("resetRedisClient disconnects rather than orphaning the socket", () => {
      process.env.REDIS_URL = "redis://fake:6379";
      const built = installFactory((url) => new FakeRedis(url, "ready"));

      getRedisClient();
      resetRedisClient();

      assert.equal(built[0].disconnectCalls, 1);
    });
  });

  // =========================================================================
  // 3. Retry after failure — no permanent dead end
  // =========================================================================

  describe("retry after failure", () => {
    it("does not disable L2 permanently: backs off, then retries and succeeds", () => {
      process.env.REDIS_URL = "redis://fake:6379";
      let clock = 1_000_000;
      __setRedisClockForTests(() => clock);

      let healthy = false;
      const built = installFactory(
        (url) => new FakeRedis(url, healthy ? "ready" : "end"),
      );

      // Three failed constructions exhaust the attempt budget.
      assert.equal(getRedisClient(), null);
      assert.equal(getRedisClient(), null);
      assert.equal(getRedisClient(), null);
      assert.equal(built.length, 3);

      // Budget spent → cooldown armed, no further sockets while cooling down.
      assert.equal(getRedisClient(), null);
      assert.equal(getRedisClient(), null);
      assert.equal(
        built.length,
        3,
        "cooldown must stop the retry loop from spraying new sockets",
      );

      // Still inside the cooldown window.
      clock += 1_000;
      assert.equal(getRedisClient(), null);
      assert.equal(built.length, 3);

      // Cooldown elapses → a fresh attempt is allowed, and Redis is back.
      clock += 60_000;
      healthy = true;
      const revived = getRedisClient();
      assert.notEqual(
        revived,
        null,
        "L2 must recover after a transient failure - the pre-fix getter returned null forever",
      );
      assert.equal(built.length, 4);
      assert.equal(isRedisConnected(), true);
    });

    it("[regression] a socket that connects but never becomes READY does NOT clear the ladder", () => {
      // ioredis emits "connect" on socket establishment — BEFORE AUTH and the
      // ready check. So every failure where TCP succeeds and the server then
      // rejects (`max number of clients reached`, WRONGPASS, LOADING, a TLS
      // session that resets after connect) fires "connect" on EVERY attempt.
      //
      // The handler used to reset the ladder there, which meant the attempt
      // counter could never reach its limit, the cooldown was unreachable, and
      // every single request built a fresh client — one new TCP connection per
      // request against the ~50-connection node this whole file exists to
      // protect. Exactly inverted from the intent.
      process.env.REDIS_URL = "redis://fake:6379";
      let clock = 0;
      __setRedisClockForTests(() => clock);

      // Connects at the socket level, then dies before ready.
      const built = installFactory((url) => {
        const c = new FakeRedis(url, "end");
        queueMicrotask(() => c.emit("connect"));
        return c;
      });

      for (let i = 0; i < 12; i++) {
        built.forEach((c) => c.emit("connect")); // the pre-fix ladder-clearer
        getRedisClient();
        clock += 1000;
      }

      // 12 requests → 6 clients: the ladder allows MAX_CONNECTION_ATTEMPTS (3)
      // per cooldown round, and 12s of fake time covers two rounds. The number
      // that matters is that it is NOT 12 — pre-fix, "connect" cleared the
      // counter on every attempt, so the cooldown never armed and each request
      // built its own connection.
      assert.ok(
        built.length <= 6,
        `the cooldown must still arm when the handshake never completes; built ${built.length} clients`,
      );
      assert.ok(
        built.length < 12,
        "one new connection per request is the storm this file exists to prevent",
      );
    });

    it("a successful READY clears the failure ladder", () => {
      process.env.REDIS_URL = "redis://fake:6379";
      let clock = 0;
      __setRedisClockForTests(() => clock);

      let healthy = false;
      const built = installFactory(
        (url) => new FakeRedis(url, healthy ? "ready" : "end"),
      );

      getRedisClient();
      getRedisClient();
      assert.equal(built.length, 2);

      // Third attempt connects and fires ioredis' "connect" event.
      healthy = true;
      const ok = getRedisClient();
      built[2].emit("ready");
      assert.notEqual(ok, null);

      // Ladder reset: a later collapse gets a full budget again, not an
      // immediate cooldown.
      healthy = false;
      built[2].status = "end";
      clock += 10;
      getRedisClient();
      getRedisClient();
      getRedisClient();
      assert.equal(
        built.length,
        6,
        "attempt counter must restart after a successful READY",
      );
    });

    it("an unconfigured Redis never consumes the retry budget", () => {
      // No REDIS_URL at all: not-configured is not a failure.
      const built = installFactory((url) => new FakeRedis(url, "ready"));

      for (let i = 0; i < 10; i++) assert.equal(getRedisClient(), null);
      assert.equal(built.length, 0, "no client is constructed without a URL");

      // Configure it and the very first call still connects — the budget was
      // never spent by the unconfigured calls.
      process.env.REDIS_URL = "redis://fake:6379";
      assert.notEqual(getRedisClient(), null);
      assert.equal(built.length, 1);
    });

    it("supports REDIS_HOST/REDIS_PORT (Memorystore) that only the web client understood", () => {
      process.env.REDIS_HOST = "10.0.0.3";
      process.env.REDIS_PORT = "6379";
      process.env.REDIS_AUTH_STRING = "s3cr3t";
      const built = installFactory((url) => new FakeRedis(url, "ready"));

      assert.equal(isRedisConfigured(), true);
      assert.notEqual(getRedisClient(), null);
      assert.equal(built[0].url, "redis://:s3cr3t@10.0.0.3:6379");
    });
  });

  // =========================================================================
  // 4. Fail-open — a cache miss must never throw into a request path
  // =========================================================================

  describe("fail-open", () => {
    const config: CacheConfig = {
      ttl: 60,
      enableMemory: false,
      enableRedis: true,
    };

    it("returns null (caller computes) when Redis is unconfigured", async () => {
      const cache = new CacheClient();
      assert.equal(await cache.get("fo:unconfigured", config), null);
      await assert.doesNotReject(() => cache.set("fo:unconfigured", 1, config));
      await assert.doesNotReject(() => cache.delete("fo:unconfigured"));
    });

    it("returns null and does not throw when every Redis command fails", async () => {
      process.env.REDIS_URL = "redis://fake:6379";
      const built = installFactory((url) => new FakeRedis(url, "ready"));
      getRedisClient();
      built[0].failWith = new Error("ECONNRESET");

      const cache = new CacheClient();
      assert.equal(await cache.get("fo:down", config), null);
      await assert.doesNotReject(() => cache.set("fo:down", { a: 1 }, config));
      await assert.doesNotReject(() => cache.delete("fo:down"));
      assert.equal(await cache.deletePattern("fo:*"), 0);
    });

    it("acquireLock fails OPEN (returns true) with no Redis and on error", async () => {
      const cache = new CacheClient();
      assert.equal(await cache.acquireLock("fo:lock", 1000), true);
      await assert.doesNotReject(() => cache.releaseLock("fo:lock"));

      process.env.REDIS_URL = "redis://fake:6379";
      const built = installFactory((url) => new FakeRedis(url, "ready"));
      getRedisClient();
      built[0].failWith = new Error("LOADING");
      assert.equal(await cache.acquireLock("fo:lock", 1000), true);
      await assert.doesNotReject(() => cache.releaseLock("fo:lock"));
    });

    it("returns null during a connection cooldown instead of throwing", async () => {
      process.env.REDIS_URL = "redis://fake:6379";
      __setRedisClockForTests(() => 0);
      installFactory((url) => new FakeRedis(url, "end"));

      for (let i = 0; i < 5; i++) getRedisClient();
      assert.equal(getRedisClient(), null, "cooling down");

      const cache = new CacheClient();
      assert.equal(await cache.get("fo:cooldown", config), null);
      await assert.doesNotReject(() => cache.set("fo:cooldown", 1, config));
    });
  });
});
