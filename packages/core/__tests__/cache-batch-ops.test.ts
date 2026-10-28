/**
 * MONEY-705 — `CacheClient.getMany` / `CacheClient.setMany` (REAL source).
 *
 * New public cache API: a batched dual-layer read backed by ONE Redis `MGET`,
 * and a batched write backed by ONE pipelined flush. They exist because callers
 * that need N keys at once (the sparkline service asks for up to 100 symbols per
 * request) were paying N round trips each way — up to 200 for a single request.
 *
 * The contract these cases pin down:
 *   - results are POSITIONALLY ALIGNED with the input keys (`null` = miss);
 *   - L1 is consulted first and only the L1 misses go into the MGET;
 *   - an L2 hit is promoted + re-stamped into L1 exactly as `get()` does;
 *   - the stored ENVELOPE is byte-compatible with `get()`/`set()`, so a mixed
 *     deploy (one instance batching, another not) reads the same entries;
 *   - everything is FAIL-OPEN: a throwing Redis, a corrupt payload, or an
 *     expired entry degrades to "miss"/"not written", never to a throw.
 *
 * A recording fake Redis is injected via `__setRedisFactoryForTests`, so the
 * exact commands are observable and no socket is ever opened.
 *
 * Source: packages/core/src/cache/client.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Redis } from "ioredis";
import { CacheClient, __setCacheClockForTests } from "../src/cache/client";
import {
  __setRedisFactoryForTests,
  resetRedisClient,
} from "../src/cache/redis";
import type { CacheConfig } from "@usemoney/cache";

const BOTH: CacheConfig = { ttl: 300, enableMemory: true, enableRedis: true };
const REDIS_ONLY: CacheConfig = {
  ttl: 300,
  enableMemory: false,
  enableRedis: true,
};
const MEMORY_ONLY: CacheConfig = {
  ttl: 300,
  enableMemory: true,
  enableRedis: false,
};

let keyCounter = 0;
/** Unique keys — the L1 LRU is module-level state shared by every case. */
function k(label: string): string {
  keyCounter += 1;
  return `m705-batch:${label}:${keyCounter}`;
}

// ── Recording fake Redis ───────────────────────────────────────────

interface Recorder {
  gets: string[];
  mgets: string[][];
  setexes: Array<{ key: string; ttl: number }>;
  pipelines: number;
}

function installFakeRedis(opts: { throwOnEveryCommand?: boolean } = {}): {
  rec: Recorder;
  store: Map<string, string>;
  uninstall: () => void;
} {
  const rec: Recorder = { gets: [], mgets: [], setexes: [], pipelines: 0 };
  const store = new Map<string, string>();
  const boom = () => {
    if (opts.throwOnEveryCommand) throw new Error("redis unavailable");
  };

  const client = {
    status: "ready",
    on() {
      return client;
    },
    async get(key: string) {
      rec.gets.push(key);
      boom();
      return store.get(key) ?? null;
    },
    async mget(...keys: string[]) {
      rec.mgets.push(keys);
      boom();
      return keys.map((key) => store.get(key) ?? null);
    },
    async setex(key: string, ttl: number, value: string) {
      rec.setexes.push({ key, ttl });
      boom();
      store.set(key, value);
      return "OK";
    },
    async set() {
      boom();
      return "OK";
    },
    async del() {
      boom();
      return 1;
    },
    pipeline() {
      rec.pipelines += 1;
      const cmds: Array<{ key: string; ttl: number; value: string }> = [];
      const chain = {
        setex(key: string, ttl: number, value: string) {
          cmds.push({ key, ttl, value });
          return chain;
        },
        async exec() {
          boom();
          for (const c of cmds) {
            rec.setexes.push({ key: c.key, ttl: c.ttl });
            store.set(c.key, c.value);
          }
          return cmds.map(() => [null, "OK"]);
        },
      };
      return chain;
    },
    async quit() {
      return "OK";
    },
    disconnect() {},
  };

  const previousUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://fake-m705-batch:6379";
  __setRedisFactoryForTests(() => client as unknown as Redis);
  resetRedisClient();

  return {
    rec,
    store,
    uninstall: () => {
      resetRedisClient();
      __setRedisFactoryForTests(null);
      if (previousUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousUrl;
    },
  };
}

/** Write an entry envelope straight into the fake store (bypassing the client). */
function seedRaw(
  store: Map<string, string>,
  key: string,
  data: unknown,
  opts: { ttl?: number; timestamp?: number } = {},
): void {
  store.set(
    key,
    JSON.stringify({
      data,
      version: "default",
      timestamp: opts.timestamp ?? Date.now(),
      ttl: opts.ttl ?? 300,
    }),
  );
}

describe("MONEY-705 — CacheClient.getMany / setMany", () => {
  let client: CacheClient;

  beforeEach(async () => {
    client = new CacheClient();
    await client.clearMemory();
    client.resetStats();
  });

  afterEach(async () => {
    __setCacheClockForTests(null);
    await client.clearMemory();
    delete process.env.CACHE_ENABLED;
  });

  // ==================================================================
  // getMany — one MGET, positionally aligned
  // ==================================================================

  describe("getMany", () => {
    it("issues ONE MGET for N keys and aligns results positionally", async () => {
      const fake = installFakeRedis();
      try {
        const keys = [k("a"), k("b"), k("c")];
        seedRaw(fake.store, keys[0]!, { v: 1 });
        seedRaw(fake.store, keys[2]!, { v: 3 });

        const out = await client.getMany<{ v: number }>(keys, REDIS_ONLY);

        assert.deepEqual(out, [{ v: 1 }, null, { v: 3 }]);
        assert.equal(fake.rec.mgets.length, 1);
        assert.deepEqual(fake.rec.mgets[0], keys);
        assert.equal(
          fake.rec.gets.length,
          0,
          "never falls back to per-key GET",
        );
      } finally {
        fake.uninstall();
      }
    });

    it("serves L1 hits without putting them in the MGET", async () => {
      const fake = installFakeRedis();
      try {
        const hot = k("hot");
        const cold = k("cold");
        await client.set(hot, { v: "l1" }, BOTH);
        seedRaw(fake.store, cold, { v: "l2" });
        fake.rec.mgets.length = 0;

        const out = await client.getMany<{ v: string }>([hot, cold], BOTH);

        assert.deepEqual(out, [{ v: "l1" }, { v: "l2" }]);
        assert.deepEqual(
          fake.rec.mgets,
          [[cold]],
          "only the L1 miss reaches Redis",
        );
      } finally {
        fake.uninstall();
      }
    });

    it("promotes L2 hits into L1, so a repeat batch needs no Redis at all", async () => {
      const fake = installFakeRedis();
      try {
        const keys = [k("p1"), k("p2")];
        for (const key of keys) seedRaw(fake.store, key, { v: key });

        const first = await client.getMany<{ v: string }>(keys, BOTH);
        assert.deepEqual(
          first.map((r) => r?.v),
          keys,
        );
        assert.equal(fake.rec.mgets.length, 1);

        const second = await client.getMany<{ v: string }>(keys, BOTH);
        assert.deepEqual(
          second.map((r) => r?.v),
          keys,
        );
        assert.equal(fake.rec.mgets.length, 1, "second batch served from L1");
      } finally {
        fake.uninstall();
      }
    });

    it("treats an EXPIRED L2 entry as a miss", async () => {
      const fake = installFakeRedis();
      try {
        const key = k("stale");
        seedRaw(
          fake.store,
          key,
          { v: 1 },
          {
            ttl: 10,
            timestamp: Date.now() - 60_000,
          },
        );

        const out = await client.getMany<{ v: number }>([key], REDIS_ONLY);
        assert.deepEqual(out, [null]);
      } finally {
        fake.uninstall();
      }
    });

    it("one corrupt payload does not fail the whole batch", async () => {
      const fake = installFakeRedis();
      try {
        const keys = [k("good"), k("corrupt"), k("good2")];
        seedRaw(fake.store, keys[0]!, { v: 1 });
        fake.store.set(keys[1]!, "{not json");
        seedRaw(fake.store, keys[2]!, { v: 3 });

        const out = await client.getMany<{ v: number }>(keys, REDIS_ONLY);
        assert.deepEqual(out, [{ v: 1 }, null, { v: 3 }]);
      } finally {
        fake.uninstall();
      }
    });

    it("fills every slot for a duplicated key", async () => {
      const fake = installFakeRedis();
      try {
        const key = k("dup");
        seedRaw(fake.store, key, { v: 7 });
        const out = await client.getMany<{ v: number }>([key, key], REDIS_ONLY);
        assert.deepEqual(out, [{ v: 7 }, { v: 7 }]);
      } finally {
        fake.uninstall();
      }
    });

    it("does no I/O for an empty key list", async () => {
      const fake = installFakeRedis();
      try {
        const out = await client.getMany([], BOTH);
        assert.deepEqual(out, []);
        assert.equal(fake.rec.mgets.length, 0);
      } finally {
        fake.uninstall();
      }
    });

    it("skips Redis entirely when enableRedis is false", async () => {
      const fake = installFakeRedis();
      try {
        const key = k("mem-only");
        seedRaw(fake.store, key, { v: 1 });
        const out = await client.getMany([key], MEMORY_ONLY);
        assert.deepEqual(out, [null]);
        assert.equal(fake.rec.mgets.length, 0);
      } finally {
        fake.uninstall();
      }
    });

    it("returns all nulls (no I/O) when CACHE_ENABLED=false", async () => {
      const fake = installFakeRedis();
      try {
        const key = k("disabled");
        seedRaw(fake.store, key, { v: 1 });
        process.env.CACHE_ENABLED = "false";
        const out = await client.getMany([key], BOTH);
        assert.deepEqual(out, [null]);
        assert.equal(fake.rec.mgets.length, 0);
      } finally {
        fake.uninstall();
      }
    });

    it("FAIL-OPEN: a throwing Redis yields misses, never a rejection", async () => {
      const fake = installFakeRedis({ throwOnEveryCommand: true });
      try {
        const keys = [k("boom1"), k("boom2")];
        const out = await client.getMany(keys, BOTH);
        assert.deepEqual(out, [null, null]);
        assert.equal(fake.rec.mgets.length, 1, "it did try");
      } finally {
        fake.uninstall();
      }
    });
  });

  // ==================================================================
  // setMany — one pipeline
  // ==================================================================

  describe("setMany", () => {
    it("writes N entries in ONE pipeline at config.ttl", async () => {
      const fake = installFakeRedis();
      try {
        const entries = Array.from({ length: 50 }, (_, i) => ({
          key: k(`w${i}`),
          data: { i },
        }));

        await client.setMany(entries, BOTH);

        assert.equal(fake.rec.pipelines, 1, "one pipeline, not 50 SETEX trips");
        assert.equal(fake.rec.setexes.length, 50);
        for (const s of fake.rec.setexes) assert.equal(s.ttl, 300);
        assert.deepEqual(
          fake.rec.setexes.map((s) => s.key),
          entries.map((e) => e.key),
        );
      } finally {
        fake.uninstall();
      }
    });

    it("also populates L1, so the follow-up read needs no Redis", async () => {
      const fake = installFakeRedis();
      try {
        const entries = [
          { key: k("l1a"), data: { v: "a" } },
          { key: k("l1b"), data: { v: "b" } },
        ];
        await client.setMany(entries, BOTH);
        fake.rec.mgets.length = 0;

        const out = await client.getMany<{ v: string }>(
          entries.map((e) => e.key),
          BOTH,
        );
        assert.deepEqual(out, [{ v: "a" }, { v: "b" }]);
        assert.equal(fake.rec.mgets.length, 0);
      } finally {
        fake.uninstall();
      }
    });

    it("does no I/O for an empty batch or when CACHE_ENABLED=false", async () => {
      const fake = installFakeRedis();
      try {
        await client.setMany([], BOTH);
        assert.equal(fake.rec.pipelines, 0);

        process.env.CACHE_ENABLED = "false";
        await client.setMany([{ key: k("off"), data: 1 }], BOTH);
        assert.equal(fake.rec.pipelines, 0);
      } finally {
        fake.uninstall();
      }
    });

    it("FAIL-OPEN: a throwing pipeline is swallowed, never rejected", async () => {
      const fake = installFakeRedis({ throwOnEveryCommand: true });
      try {
        await client.setMany([{ key: k("boomw"), data: { v: 1 } }], BOTH);
        assert.equal(fake.rec.pipelines, 1, "it did try");
      } finally {
        fake.uninstall();
      }
    });
  });

  // ==================================================================
  // Envelope compatibility — a mixed deploy must interoperate
  // ==================================================================

  describe("envelope compatibility with the single-key API", () => {
    it("getMany reads what set() wrote", async () => {
      const fake = installFakeRedis();
      try {
        const key = k("mixed1");
        await client.set(key, { v: "from-set" }, REDIS_ONLY);
        const out = await client.getMany<{ v: string }>([key], REDIS_ONLY);
        assert.deepEqual(out, [{ v: "from-set" }]);
      } finally {
        fake.uninstall();
      }
    });

    it("get() reads what setMany() wrote — same key, same TTL, same shape", async () => {
      const fake = installFakeRedis();
      try {
        const key = k("mixed2");
        await client.setMany([{ key, data: { v: "from-setMany" } }], BOTH);

        const fresh = new CacheClient();
        await fresh.clearMemory(); // force the read down to L2
        const out = await fresh.get<{ v: string }>(key, REDIS_ONLY);
        assert.deepEqual(out, { v: "from-setMany" });
        assert.deepEqual(
          fake.rec.setexes.map((s) => s.ttl),
          [300],
        );
      } finally {
        fake.uninstall();
      }
    });
  });
});
