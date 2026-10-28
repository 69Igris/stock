/**
 * MONEY-705 — the sparkline fan-out is batched (REAL source).
 *
 * `getSparklines` issued ONE `getCached` per symbol inside a `Promise.all`
 * (up to 100) and then up to 100 `setCached` writes — up to 200 individual
 * Redis round trips for a single request where 2 will do. It now uses
 * `cacheClient.getMany` (one `MGET`) and `cacheClient.setMany` (one pipelined
 * flush), with the key shape and TTLs untouched.
 *
 * These drive the REAL `getSparklines` through the REAL cache client, against a
 * recording fake Redis injected with `__setRedisFactoryForTests` (the seam
 * MONEY-1127 added) — so the assertions are on the actual commands that reach
 * the wire, not on a re-implementation. No socket, no timer, no network.
 *
 * The upstream Yahoo fetch is replaced through `__setSparklineFetcherForTests`,
 * which exists precisely so the WRITE side (partial-hit re-fetch + the pipelined
 * write-back) is testable offline.
 *
 * Source: packages/services/src/sparkline.service.ts
 *         packages/core/src/cache/client.ts (getMany / setMany)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  cacheClient,
  __setRedisFactoryForTests,
  resetRedisClient,
} from "@usemoney/core";
import type { Redis } from "ioredis";
import type {
  SparklineResult,
  SparklineSymbol,
  SparklineWindow,
} from "@usemoney/core";
import {
  getSparklines,
  __setSparklineFetcherForTests,
} from "../src/sparkline.service";

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
      return keys.map((k) => store.get(k) ?? null);
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
  process.env.REDIS_URL = "redis://fake-m705-spark:6379";
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

// ── Fixtures ───────────────────────────────────────────────────────

/** The exact key shape the pre-batching `getCached("market","_global",…)` used. */
function expectedKey(
  symbol: string,
  exchange: "NSE" | "BSE",
  window: SparklineWindow,
): string {
  // ":" inside the identifier is escaped to "%3A" (packages/cache/src/keys.ts).
  return `market:_global:sparkline%3A${exchange}%3A${symbol}%3A${window}:default`;
}

function result(symbol: string, exchange: "NSE" | "BSE"): SparklineResult {
  return {
    symbol,
    exchange,
    yahooSymbol: `${symbol}.${exchange === "NSE" ? "NS" : "BO"}`,
    window: "1D",
    closes: [100, 101, 102],
    lastUpdated: 1_700_000_000_000,
  } as SparklineResult;
}

/** Pre-load a symbol into the fake Redis in the client's own entry envelope. */
function seed(
  store: Map<string, string>,
  symbol: string,
  exchange: "NSE" | "BSE",
  window: SparklineWindow,
): void {
  store.set(
    expectedKey(symbol, exchange, window),
    JSON.stringify({
      data: result(symbol, exchange),
      version: "default",
      timestamp: Date.now(),
      ttl: 10 * 60,
    }),
  );
}

function symbols(count: number, prefix: string): SparklineSymbol[] {
  return Array.from({ length: count }, (_, i) => ({
    symbol: `${prefix}${i}`,
    exchange: "NSE" as const,
  }));
}

describe("MONEY-705 — sparkline cache batching", () => {
  beforeEach(async () => {
    await cacheClient.clearMemory();
  });

  afterEach(async () => {
    __setSparklineFetcherForTests(null);
    await cacheClient.clearMemory();
  });

  // ==================================================================
  // Round-trip counts — the headline claim
  // ==================================================================

  it("100 fully-cached symbols cost ONE MGET, not 100 GETs", async () => {
    const fake = installFakeRedis();
    try {
      const syms = symbols(100, "HIT");
      for (const s of syms) seed(fake.store, s.symbol, s.exchange, "1D");

      let fetchCalls = 0;
      __setSparklineFetcherForTests(async () => {
        fetchCalls += 1;
        return new Map<string, SparklineResult>();
      });

      const res = await getSparklines(syms, "1D");

      assert.equal(res.success, true);
      assert.equal(Object.keys(res.success ? res.data : {}).length, 100);
      assert.equal(fake.rec.mgets.length, 1, "exactly one MGET");
      assert.equal(fake.rec.mgets[0]?.length, 100, "one MGET covering all 100");
      assert.equal(fake.rec.gets.length, 0, "no per-symbol GET survives");
      assert.equal(fake.rec.pipelines, 0, "a full hit writes nothing");
      assert.equal(fetchCalls, 0, "a full hit never calls upstream");
    } finally {
      fake.uninstall();
    }
  });

  it("100 fully-MISSING symbols cost ONE MGET + ONE pipelined write (2 round trips, not 200)", async () => {
    const fake = installFakeRedis();
    try {
      const syms = symbols(100, "MISS");
      __setSparklineFetcherForTests(async (requested) => {
        const out = new Map<string, SparklineResult>();
        for (const s of requested) {
          out.set(`${s.symbol}|${s.exchange}`, result(s.symbol, s.exchange));
        }
        return out;
      });

      const res = await getSparklines(syms, "1D");

      assert.equal(res.success, true);
      assert.equal(Object.keys(res.success ? res.data : {}).length, 100);
      assert.equal(fake.rec.mgets.length, 1);
      assert.equal(fake.rec.gets.length, 0);
      assert.equal(fake.rec.pipelines, 1, "one pipeline, not 100 SETEX trips");
      assert.equal(
        fake.rec.setexes.length,
        100,
        "all 100 writes ride that single pipeline",
      );
    } finally {
      fake.uninstall();
    }
  });

  it("partial hits: the MGET covers everything, only the MISSES are fetched and written", async () => {
    const fake = installFakeRedis();
    try {
      const syms = symbols(10, "PART");
      // Cache the even-indexed ones only.
      for (let i = 0; i < syms.length; i += 2) {
        seed(fake.store, syms[i]!.symbol, "NSE", "1D");
      }

      let requestedSymbols: string[] = [];
      __setSparklineFetcherForTests(async (requested) => {
        requestedSymbols = requested.map((s) => s.symbol);
        const out = new Map<string, SparklineResult>();
        for (const s of requested) {
          out.set(`${s.symbol}|${s.exchange}`, result(s.symbol, s.exchange));
        }
        return out;
      });

      const res = await getSparklines(syms, "1D");

      assert.equal(res.success, true);
      assert.equal(Object.keys(res.success ? res.data : {}).length, 10);
      assert.equal(fake.rec.mgets.length, 1);
      assert.equal(fake.rec.mgets[0]?.length, 10);

      // Only the 5 odd-indexed misses went upstream…
      assert.deepEqual([...requestedSymbols].sort(), [
        "PART1",
        "PART3",
        "PART5",
        "PART7",
        "PART9",
      ]);
      // …and only those 5 were written back, in one pipeline.
      assert.equal(fake.rec.pipelines, 1);
      assert.equal(fake.rec.setexes.length, 5);
      assert.deepEqual(
        fake.rec.setexes.map((s) => s.key).sort(),
        [
          expectedKey("PART1", "NSE", "1D"),
          expectedKey("PART3", "NSE", "1D"),
          expectedKey("PART5", "NSE", "1D"),
          expectedKey("PART7", "NSE", "1D"),
          expectedKey("PART9", "NSE", "1D"),
        ].sort(),
      );
    } finally {
      fake.uninstall();
    }
  });

  it("forceRefresh skips the read entirely and still writes in ONE pipeline", async () => {
    const fake = installFakeRedis();
    try {
      const syms = symbols(20, "FORCE");
      for (const s of syms) seed(fake.store, s.symbol, s.exchange, "1D");

      __setSparklineFetcherForTests(async (requested) => {
        const out = new Map<string, SparklineResult>();
        for (const s of requested) {
          out.set(`${s.symbol}|${s.exchange}`, result(s.symbol, s.exchange));
        }
        return out;
      });

      const res = await getSparklines(syms, "1D", { forceRefresh: true });

      assert.equal(res.success, true);
      assert.equal(fake.rec.mgets.length, 0, "forceRefresh reads nothing");
      assert.equal(fake.rec.gets.length, 0);
      assert.equal(fake.rec.pipelines, 1);
      assert.equal(fake.rec.setexes.length, 20);
    } finally {
      fake.uninstall();
    }
  });

  // ==================================================================
  // Keys / TTLs are unchanged
  // ==================================================================

  describe("cache keys and TTLs are unchanged", () => {
    it("reads and writes market:_global:sparkline%3A<EX>%3A<SYM>%3A<WIN>:default", async () => {
      const fake = installFakeRedis();
      try {
        __setSparklineFetcherForTests(
          async () => new Map([["RELIANCE|NSE", result("RELIANCE", "NSE")]]),
        );

        await getSparklines([{ symbol: "RELIANCE", exchange: "NSE" }], "1D");

        assert.deepEqual(fake.rec.mgets, [
          [expectedKey("RELIANCE", "NSE", "1D")],
        ]);
        assert.deepEqual(fake.rec.setexes, [
          { key: expectedKey("RELIANCE", "NSE", "1D"), ttl: 10 * 60 },
        ]);
      } finally {
        fake.uninstall();
      }
    });

    it("keeps the per-window TTLs: 1D=600s, 1W=3600s, 1M=21600s", async () => {
      for (const [window, ttl] of [
        ["1D", 10 * 60],
        ["1W", 60 * 60],
        ["1M", 6 * 60 * 60],
      ] as Array<[SparklineWindow, number]>) {
        const fake = installFakeRedis();
        try {
          await cacheClient.clearMemory();
          __setSparklineFetcherForTests(
            async () =>
              new Map([["TCS|BSE", { ...result("TCS", "BSE"), window }]]),
          );

          await getSparklines([{ symbol: "TCS", exchange: "BSE" }], window);

          assert.deepEqual(fake.rec.mgets, [
            [expectedKey("TCS", "BSE", window)],
          ]);
          assert.deepEqual(fake.rec.setexes, [
            { key: expectedKey("TCS", "BSE", window), ttl },
          ]);
        } finally {
          fake.uninstall();
        }
      }
    });
  });

  // ==================================================================
  // Fail-open + preserved per-symbol semantics
  // ==================================================================

  describe("fail-open and per-symbol handling", () => {
    it("a throwing Redis degrades to computing — never throws", async () => {
      const fake = installFakeRedis({ throwOnEveryCommand: true });
      try {
        __setSparklineFetcherForTests(async (requested) => {
          const out = new Map<string, SparklineResult>();
          for (const s of requested) {
            out.set(`${s.symbol}|${s.exchange}`, result(s.symbol, s.exchange));
          }
          return out;
        });

        const res = await getSparklines(symbols(5, "DOWN"), "1D");
        assert.equal(res.success, true);
        assert.equal(Object.keys(res.success ? res.data : {}).length, 5);
        // It really did try both halves and swallowed both failures.
        assert.equal(fake.rec.mgets.length, 1);
        assert.equal(fake.rec.pipelines, 1);
      } finally {
        fake.uninstall();
      }
    });

    it("an empty cached series counts as a MISS (per-symbol, unchanged)", async () => {
      const fake = installFakeRedis();
      try {
        // A cached entry whose closes are all non-finite sanitises to empty.
        fake.store.set(
          expectedKey("EMPTY", "NSE", "1D"),
          JSON.stringify({
            data: { ...result("EMPTY", "NSE"), closes: [NaN, null] },
            version: "default",
            timestamp: Date.now(),
            ttl: 600,
          }),
        );

        let requested: string[] = [];
        __setSparklineFetcherForTests(async (syms) => {
          requested = syms.map((s) => s.symbol);
          return new Map([["EMPTY|NSE", result("EMPTY", "NSE")]]);
        });

        const res = await getSparklines(
          [{ symbol: "EMPTY", exchange: "NSE" }],
          "1D",
        );
        assert.equal(res.success, true);
        assert.deepEqual(requested, ["EMPTY"], "an empty series is re-fetched");
        assert.deepEqual(
          (res.success ? res.data : {})["EMPTY|NSE"]?.closes,
          [100, 101, 102],
        );
      } finally {
        fake.uninstall();
      }
    });

    it("a fetch failure still returns whatever the batch read produced", async () => {
      const fake = installFakeRedis();
      try {
        const syms = symbols(4, "MIX");
        seed(fake.store, "MIX0", "NSE", "1D");
        seed(fake.store, "MIX1", "NSE", "1D");
        __setSparklineFetcherForTests(async () => {
          throw new Error("yahoo down");
        });

        const res = await getSparklines(syms, "1D");
        assert.equal(res.success, true);
        assert.deepEqual(Object.keys(res.success ? res.data : {}).sort(), [
          "MIX0|NSE",
          "MIX1|NSE",
        ]);
        assert.equal(fake.rec.pipelines, 0, "nothing to write back");
      } finally {
        fake.uninstall();
      }
    });

    it("guards unchanged: empty input short-circuits, >100 is still rejected", async () => {
      const fake = installFakeRedis();
      try {
        const empty = await getSparklines([], "1D");
        assert.equal(empty.success, true);
        assert.equal(fake.rec.mgets.length, 0);

        const tooMany = await getSparklines(symbols(101, "BIG"), "1D");
        assert.equal(tooMany.success, false);
        assert.equal(tooMany.success ? "" : tooMany.code, "BATCH_TOO_LARGE");
        assert.equal(fake.rec.mgets.length, 0, "the guard runs before any I/O");
      } finally {
        fake.uninstall();
      }
    });
  });
});
