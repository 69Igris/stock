/**
 * MONEY-705 — stampede protection on the portfolio services (REAL source).
 *
 * Before this change every portfolio read was a bare `getCached`/`setCached`
 * pair with NO coordination: on each TTL boundary all N concurrent requests
 * missed together and each ran the FULL query set (11 Mongo queries for the
 * dashboard, ~16 external Yahoo fetches for risk). `withCache`'s single-flight
 * registry existed but had zero production call sites.
 *
 * These cases drive the REAL exported service functions —
 * `getDashboardStats`, `getPortfolioReturns`, `getHoldings`, `getTrades`,
 * `getPositions`, `getPortfolioRisk`, `getTaxReport` — through the REAL
 * `@usemoney/core` cache client and the REAL `singleFlight` registry. Nothing
 * is re-implemented here.
 *
 * Two seams make that possible without a database, a network, or module
 * mocking (which this repo cannot use — see gemini-client-adapter.test.ts):
 *
 *   - `prisma.<model>` is a plain assignable property on the shared client
 *     singleton, so a counting fake can be swapped in and restored.
 *   - `__setRedisFactoryForTests` (the same seam MONEY-1127 added) injects a
 *     recording fake Redis, so the EXACT key strings the services put on the
 *     wire are observable. No socket is ever opened.
 *
 * What is asserted, in priority order:
 *   1. concurrent misses on ONE key collapse to ONE execution;
 *   2. DIFFERENT USERS ARE NEVER COLLAPSED — the failure mode here is serving
 *      user A's portfolio to user B, so it is covered per service;
 *   3. a rejected flight does not poison the next caller;
 *   4. the whole path is fail-open (no Redis, or a throwing Redis, still
 *      computes and returns);
 *   5. the cache keys are byte-identical to the deployed ones (a drift would
 *      silently orphan every entry written by the running build).
 *
 * Source: packages/services/src/{dashboard,holdings,trades,positions,risk,tax}.service.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@usemoney/database";
import {
  cacheClient,
  setCached,
  __setRedisFactoryForTests,
  resetRedisClient,
} from "@usemoney/core";
import type { Redis } from "ioredis";
import {
  getDashboardStats,
  getPortfolioReturns,
} from "../src/dashboard.service";
import { getHoldings } from "../src/holdings.service";
import { getTrades } from "../src/trades.service";
import { getPositions } from "../src/positions.service";
import { getPortfolioRisk } from "../src/risk.service";
import { getTaxReport } from "../src/tax.service";

// ── Unique ids ─────────────────────────────────────────────────────
// The L1 LRU and the single-flight registry are process-wide module state, so
// every case gets its own userId rather than relying on teardown ordering.
let uidCounter = 0;
function uid(label: string): string {
  uidCounter += 1;
  return `m705-${label}-${uidCounter}`;
}

// ── Deferred: lets N callers pile up on one in-flight execution ────
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yield enough microtask turns for N launched calls to reach the gate. */
async function settleMicrotasks(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

// ── Recording fake Redis (no socket, no timers) ────────────────────

interface RedisRecorder {
  gets: string[];
  mgets: string[][];
  setexes: Array<{ key: string; ttl: number }>;
  pipelines: number;
}

function installFakeRedis(opts: { throwOnEveryCommand?: boolean } = {}): {
  rec: RedisRecorder;
  store: Map<string, string>;
  uninstall: () => void;
} {
  const rec: RedisRecorder = {
    gets: [],
    mgets: [],
    setexes: [],
    pipelines: 0,
  };
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
  process.env.REDIS_URL = "redis://fake-m705:6379";
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

// ── Prisma fakes ───────────────────────────────────────────────────
// `prisma.<model>` is a plain property on the shared singleton, so a fake can
// be installed and restored. `saveModels`/`restore` keep cases isolated.

type AnyRecord = Record<string, unknown>;
type PrismaLike = Record<string, AnyRecord>;

const MODELS = [
  "trade",
  "holding",
  "mutualFund",
  "position",
  "pairedTradeView",
  "instrumentMapping",
] as const;

function saveModels(): Map<string, unknown> {
  const saved = new Map<string, unknown>();
  for (const m of MODELS) saved.set(m, (prisma as unknown as PrismaLike)[m]);
  return saved;
}

function restoreModels(saved: Map<string, unknown>): void {
  for (const [m, v] of saved) {
    (prisma as unknown as PrismaLike)[m] = v as AnyRecord;
  }
}

function setModel(name: string, impl: AnyRecord): void {
  (prisma as unknown as PrismaLike)[name] = impl;
}

/** userId out of a Prisma `where` (the fakes answer per-user). */
function whereUser(args: unknown): string {
  const where = (args as { where?: { userId?: string } } | undefined)?.where;
  return where?.userId ?? "";
}

/**
 * Fakes for every model `getDashboardStats` touches. `gate` (when supplied) is
 * awaited inside `trade.findMany`, which parks the whole flight so concurrent
 * callers can pile up. `runs` counts REAL executions of the body.
 */
function installDashboardFakes(opts: {
  gate?: Promise<unknown>;
  runs: { count: number };
  tradeCountByUser?: (userId: string) => number;
  onTradeFindMany?: (args: unknown) => void;
}): void {
  setModel("trade", {
    findMany: async (args: unknown) => {
      opts.runs.count += 1;
      opts.onTradeFindMany?.(args);
      if (opts.gate) await opts.gate;
      return [];
    },
    count: async (args: unknown) =>
      opts.tradeCountByUser ? opts.tradeCountByUser(whereUser(args)) : 0,
  });
  setModel("holding", { findMany: async () => [] });
  setModel("mutualFund", { findMany: async () => [] });
  setModel("position", { findMany: async () => [] });
  setModel("pairedTradeView", {
    aggregate: async () => ({ _sum: { realizedPnL: 0 }, _count: 0 }),
    count: async () => 0,
    findMany: async () => [],
    findFirst: async () => null,
  });
}

// ── Suite ──────────────────────────────────────────────────────────

describe("MONEY-705 — portfolio service stampede protection", () => {
  let savedModels: Map<string, unknown>;

  beforeEach(async () => {
    savedModels = saveModels();
    await cacheClient.clearMemory();
  });

  afterEach(async () => {
    restoreModels(savedModels);
    await cacheClient.clearMemory();
  });

  // ==================================================================
  // 1. Concurrent misses on ONE key collapse to ONE execution
  // ==================================================================

  describe("single-flight collapses concurrent misses", () => {
    it("getDashboardStats: 8 concurrent calls run the query set ONCE", async () => {
      const userId = uid("dash-collapse");
      const gate = deferred<void>();
      const runs = { count: 0 };
      installDashboardFakes({
        gate: gate.promise,
        runs,
        tradeCountByUser: () => 42,
      });

      const calls = Array.from({ length: 8 }, () => getDashboardStats(userId));
      await settleMicrotasks();
      assert.equal(
        runs.count,
        1,
        "8 concurrent misses must share ONE execution",
      );

      gate.resolve();
      const results = await Promise.all(calls);

      assert.equal(runs.count, 1);
      for (const r of results) {
        assert.equal(r.success, true);
        assert.ok(r.success && r.data);
        assert.equal(r.success && r.data.trading.totalTrades, 42);
      }
      // Every joiner resolves to the SAME value the leader produced.
      const first = results[0];
      assert.ok(first?.success);
      for (const r of results) {
        assert.ok(r.success);
        assert.deepEqual(r.data, first.success ? first.data : undefined);
      }
    });

    it("getHoldings: concurrent calls with the same filters run ONE query", async () => {
      const userId = uid("hold-collapse");
      const gate = deferred<void>();
      let runs = 0;
      setModel("holding", {
        findMany: async () => {
          runs += 1;
          await gate.promise;
          return [];
        },
      });
      setModel("instrumentMapping", { findMany: async () => [] });

      const calls = Array.from({ length: 6 }, () => getHoldings(userId, {}));
      await settleMicrotasks();
      assert.equal(runs, 1);

      gate.resolve();
      const results = await Promise.all(calls);
      assert.equal(runs, 1);
      for (const r of results) assert.equal(r.success, true);
    });

    it("getPositions: concurrent calls with the same filters run ONE query", async () => {
      const userId = uid("pos-collapse");
      const gate = deferred<void>();
      let runs = 0;
      setModel("position", {
        findMany: async () => {
          runs += 1;
          await gate.promise;
          return [];
        },
      });

      const calls = Array.from({ length: 5 }, () => getPositions(userId, {}));
      await settleMicrotasks();
      assert.equal(runs, 1);

      gate.resolve();
      const results = await Promise.all(calls);
      assert.equal(runs, 1);
      for (const r of results) assert.equal(r.success, true);
    });

    it("getTrades: concurrent calls with the same filters run ONE query set", async () => {
      const userId = uid("trades-collapse");
      const gate = deferred<void>();
      let runs = 0;
      setModel("trade", {
        findMany: async () => {
          runs += 1;
          await gate.promise;
          return [];
        },
        count: async () => 0,
      });
      setModel("pairedTradeView", {
        aggregate: async () => ({ _sum: { realizedPnL: 0 } }),
        count: async () => 0,
        findMany: async () => [],
      });

      const calls = Array.from({ length: 5 }, () => getTrades(userId, {}));
      await settleMicrotasks();
      assert.equal(runs, 1);

      gate.resolve();
      const results = await Promise.all(calls);
      assert.equal(runs, 1);
      for (const r of results) assert.equal(r.success, true);
    });

    it("getPortfolioRisk: concurrent calls run the holdings read ONCE (the ~16-fetch cold path)", async () => {
      const userId = uid("risk-collapse");
      const gate = deferred<void>();
      let runs = 0;
      // Empty holdings short-circuits BEFORE the Yahoo fan-out, so this stays a
      // pure, network-free test of the coordination itself.
      setModel("holding", {
        findMany: async () => {
          runs += 1;
          await gate.promise;
          return [];
        },
      });

      const calls = Array.from({ length: 6 }, () => getPortfolioRisk(userId));
      await settleMicrotasks();
      assert.equal(runs, 1);

      gate.resolve();
      const results = await Promise.all(calls);
      assert.equal(runs, 1);
      // The failure envelope is shared by all joiners AND is never cached.
      for (const r of results) {
        assert.equal(r.success, false);
        assert.match(String(r.success ? "" : r.error), /No holdings found/);
      }
    });

    it("getTaxReport: concurrent calls for the same FY run ONE compute", async () => {
      const userId = uid("tax-collapse");
      const gate = deferred<void>();
      let runs = 0;
      setModel("pairedTradeView", {
        findMany: async () => {
          runs += 1;
          await gate.promise;
          return [];
        },
      });
      setModel("holding", { findMany: async () => [] });

      const calls = Array.from({ length: 4 }, () =>
        getTaxReport(userId, "2025-26"),
      );
      await settleMicrotasks();
      assert.equal(runs, 1);

      gate.resolve();
      const results = await Promise.all(calls);
      assert.equal(runs, 1);
      for (const r of results) assert.equal(r.success, true);
    });

    it("getPortfolioReturns: concurrent calls run the trade read ONCE", async () => {
      const userId = uid("returns-collapse");
      const gate = deferred<void>();
      let runs = 0;
      setModel("trade", {
        findMany: async () => {
          runs += 1;
          await gate.promise;
          return [];
        },
      });
      setModel("holding", { findMany: async () => [] });
      setModel("mutualFund", { findMany: async () => [] });
      setModel("position", { findMany: async () => [] });

      const calls = Array.from({ length: 5 }, () =>
        getPortfolioReturns(userId),
      );
      await settleMicrotasks();
      assert.equal(runs, 1);

      gate.resolve();
      const results = await Promise.all(calls);
      assert.equal(runs, 1);
      for (const r of results) assert.equal(r.success, true);
    });
  });

  // ==================================================================
  // 2. DIFFERENT USERS ARE NEVER COLLAPSED  (non-negotiable)
  // ==================================================================

  describe("per-user isolation — two users are never one flight", () => {
    it("getDashboardStats: A and B each run their own query set and get their OWN data", async () => {
      const userA = uid("iso-A");
      const userB = uid("iso-B");
      const gate = deferred<void>();
      const runs = { count: 0 };
      const seenUsers: string[] = [];

      installDashboardFakes({
        gate: gate.promise,
        runs,
        // Distinct, user-identifying payloads: if the two flights were ever
        // collapsed, one user would receive the other's number here.
        tradeCountByUser: (u) => (u === userA ? 111 : 222),
        onTradeFindMany: (args) => seenUsers.push(whereUser(args)),
      });

      const [pa, pb] = [getDashboardStats(userA), getDashboardStats(userB)];
      await settleMicrotasks();
      assert.equal(runs.count, 2, "two users must NOT share one execution");

      gate.resolve();
      const [ra, rb] = await Promise.all([pa, pb]);

      assert.equal(runs.count, 2);
      assert.deepEqual([...seenUsers].sort(), [userA, userB].sort());
      assert.ok(ra.success && rb.success);
      assert.equal(ra.success && ra.data.trading.totalTrades, 111);
      assert.equal(rb.success && rb.data.trading.totalTrades, 222);
    });

    it("getHoldings: A and B get their own holdings, never each other's", async () => {
      const userA = uid("hiso-A");
      const userB = uid("hiso-B");
      const gate = deferred<void>();
      let runs = 0;

      const rowFor = (u: string) => ({
        id: `${u}-h1`,
        symbol: u === userA ? "AAAA" : "BBBB",
        name: null,
        tradingSymbol: null,
        sector: "IT",
        exchange: "NSE",
        quantity: 1,
        t1Quantity: 0,
        averagePrice: 100,
        currentPrice: 110,
        investedValue: 100,
        currentValue: 110,
        unrealizedPnL: 10,
        pnlPercentage: 10,
        broker: null,
        brokerUserId: null,
        createdAt: new Date("2025-01-01T00:00:00Z"),
        lastUpdated: new Date("2025-01-01T00:00:00Z"),
      });

      setModel("holding", {
        findMany: async (args: unknown) => {
          runs += 1;
          await gate.promise;
          return [rowFor(whereUser(args))];
        },
      });
      setModel("instrumentMapping", { findMany: async () => [] });

      const [pa, pb] = [getHoldings(userA, {}), getHoldings(userB, {})];
      await settleMicrotasks();
      assert.equal(runs, 2);

      gate.resolve();
      const [ra, rb] = await Promise.all([pa, pb]);
      assert.ok(ra.success && rb.success);
      assert.equal(ra.success && ra.data.holdings[0]?.symbol, "AAAA");
      assert.equal(rb.success && rb.data.holdings[0]?.symbol, "BBBB");
    });

    it("getTrades: the SAME user with DIFFERENT filters is not collapsed either", async () => {
      const userId = uid("filter-split");
      const gate = deferred<void>();
      const seenLimits: unknown[] = [];
      let runs = 0;

      setModel("trade", {
        findMany: async (args: unknown) => {
          runs += 1;
          seenLimits.push((args as { take?: number }).take);
          await gate.promise;
          return [];
        },
        count: async () => 0,
      });
      setModel("pairedTradeView", {
        aggregate: async () => ({ _sum: { realizedPnL: 0 } }),
        count: async () => 0,
        findMany: async () => [],
      });

      const p1 = getTrades(userId, { limit: 10 });
      const p2 = getTrades(userId, { limit: 25 });
      await settleMicrotasks();
      assert.equal(runs, 2, "different filters are different cache entries");

      gate.resolve();
      await Promise.all([p1, p2]);
      assert.deepEqual([...seenLimits].sort(), [10, 25]);
    });

    it("getTaxReport: the SAME user in DIFFERENT financial years is not collapsed", async () => {
      const userId = uid("fy-split");
      const gate = deferred<void>();
      let runs = 0;
      setModel("pairedTradeView", {
        findMany: async () => {
          runs += 1;
          await gate.promise;
          return [];
        },
      });
      setModel("holding", { findMany: async () => [] });

      const p1 = getTaxReport(userId, "2024-25");
      const p2 = getTaxReport(userId, "2025-26");
      await settleMicrotasks();
      assert.equal(runs, 2);

      gate.resolve();
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(r1.success, true);
      assert.equal(r2.success, true);
    });

    it("getPortfolioRisk: A and B each run their own analysis", async () => {
      const userA = uid("riso-A");
      const userB = uid("riso-B");
      const gate = deferred<void>();
      const seen: string[] = [];
      let runs = 0;

      setModel("holding", {
        findMany: async (args: unknown) => {
          runs += 1;
          seen.push(whereUser(args));
          await gate.promise;
          return [];
        },
      });

      const [pa, pb] = [getPortfolioRisk(userA), getPortfolioRisk(userB)];
      await settleMicrotasks();
      assert.equal(runs, 2);

      gate.resolve();
      await Promise.all([pa, pb]);
      assert.deepEqual([...seen].sort(), [userA, userB].sort());
    });
  });

  // ==================================================================
  // 3. A rejected flight must not poison subsequent callers
  // ==================================================================

  describe("a rejected flight does not poison the key", () => {
    it("getDashboardStats: the next caller RETRIES rather than inheriting the rejection", async () => {
      const userId = uid("poison-dash");
      let attempts = 0;
      setModel("trade", {
        findMany: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient mongo blip");
          return [];
        },
        count: async () => 7,
      });
      setModel("holding", { findMany: async () => [] });
      setModel("mutualFund", { findMany: async () => [] });
      setModel("position", { findMany: async () => [] });
      setModel("pairedTradeView", {
        aggregate: async () => ({ _sum: { realizedPnL: 0 }, _count: 0 }),
        count: async () => 0,
        findMany: async () => [],
        findFirst: async () => null,
      });

      const first = await getDashboardStats(userId);
      assert.equal(first.success, false);

      const second = await getDashboardStats(userId);
      assert.equal(
        attempts,
        2,
        "the failed flight must be retried, not reused",
      );
      assert.equal(second.success, true);
      assert.equal(second.success && second.data.trading.totalTrades, 7);
    });

    it("getHoldings: a rejection is not cached and the next call recomputes", async () => {
      const userId = uid("poison-hold");
      let attempts = 0;
      setModel("holding", {
        findMany: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("transient mongo blip");
          return [];
        },
      });
      setModel("instrumentMapping", { findMany: async () => [] });

      const first = await getHoldings(userId, {});
      assert.equal(first.success, false);

      const second = await getHoldings(userId, {});
      assert.equal(attempts, 2);
      assert.equal(second.success, true);
    });

    it("concurrent callers on a rejecting flight all fail, then the NEXT one succeeds", async () => {
      const userId = uid("poison-concurrent");
      const gate = deferred<void>();
      let attempts = 0;
      setModel("holding", {
        findMany: async () => {
          attempts += 1;
          if (attempts === 1) {
            await gate.promise;
            throw new Error("transient mongo blip");
          }
          return [];
        },
      });
      setModel("instrumentMapping", { findMany: async () => [] });

      const calls = Array.from({ length: 4 }, () => getHoldings(userId, {}));
      await settleMicrotasks();
      assert.equal(attempts, 1);

      // Release the gate; the fake then throws, rejecting the shared flight.
      gate.resolve();
      const results = await Promise.all(calls);
      for (const r of results) assert.equal(r.success, false);

      const after = await getHoldings(userId, {});
      assert.equal(attempts, 2);
      assert.equal(after.success, true);
    });
  });

  // ==================================================================
  // 4. Fail-open — cache infra must never stall or fail a request
  // ==================================================================

  describe("fail-open", () => {
    it("computes and returns with NO Redis configured (memory-only)", async () => {
      const userId = uid("no-redis");
      installDashboardFakes({ runs: { count: 0 }, tradeCountByUser: () => 3 });

      const result = await getDashboardStats(userId);
      assert.equal(result.success, true);
      assert.equal(result.success && result.data.trading.totalTrades, 3);
    });

    it("computes and returns when EVERY Redis command throws", async () => {
      const userId = uid("redis-down");
      const fake = installFakeRedis({ throwOnEveryCommand: true });
      try {
        installDashboardFakes({
          runs: { count: 0 },
          tradeCountByUser: () => 9,
        });
        const result = await getDashboardStats(userId);
        assert.equal(result.success, true);
        assert.equal(result.success && result.data.trading.totalTrades, 9);
        // It really did try Redis and swallowed the failure.
        assert.ok(fake.rec.gets.length >= 1);
      } finally {
        fake.uninstall();
      }
    });

    it("a throwing Redis still lets concurrent callers collapse to one execution", async () => {
      const userId = uid("redis-down-collapse");
      const fake = installFakeRedis({ throwOnEveryCommand: true });
      try {
        const gate = deferred<void>();
        const runs = { count: 0 };
        installDashboardFakes({ gate: gate.promise, runs });

        const calls = Array.from({ length: 5 }, () =>
          getDashboardStats(userId),
        );
        await settleMicrotasks();
        assert.equal(runs.count, 1);

        gate.resolve();
        const results = await Promise.all(calls);
        for (const r of results) assert.equal(r.success, true);
      } finally {
        fake.uninstall();
      }
    });
  });

  // ==================================================================
  // 5. Cache keys are byte-identical to the deployed ones
  // ==================================================================
  //
  // A key change would silently orphan every entry the running build wrote.
  // These assert the LITERAL strings that reach Redis — both the read (`GET`)
  // and, where the path can complete offline, the write (`SETEX`) — rather than
  // re-deriving them with the same helper the source uses (which would pass
  // even if both drifted together).

  describe("cache keys / TTLs are unchanged", () => {
    it("getDashboardStats reads and writes dashboard:<userId>:stats:default @ 300s", async () => {
      const userId = uid("key-dash");
      const fake = installFakeRedis();
      try {
        installDashboardFakes({ runs: { count: 0 } });
        await getDashboardStats(userId);
        assert.deepEqual(fake.rec.gets, [`dashboard:${userId}:stats:default`]);
        assert.deepEqual(fake.rec.setexes, [
          { key: `dashboard:${userId}:stats:default`, ttl: 300 },
        ]);
      } finally {
        fake.uninstall();
      }
    });

    it("getPortfolioReturns reads and writes dashboard:<userId>:returns:default @ 300s", async () => {
      const userId = uid("key-returns");
      const fake = installFakeRedis();
      try {
        setModel("trade", { findMany: async () => [] });
        setModel("holding", { findMany: async () => [] });
        setModel("mutualFund", { findMany: async () => [] });
        setModel("position", { findMany: async () => [] });

        await getPortfolioReturns(userId);
        assert.deepEqual(fake.rec.gets, [
          `dashboard:${userId}:returns:default`,
        ]);
        assert.deepEqual(fake.rec.setexes, [
          { key: `dashboard:${userId}:returns:default`, ttl: 300 },
        ]);
      } finally {
        fake.uninstall();
      }
    });

    it("getHoldings reads and writes holdings:<userId>:list:<filterHash> @ 300s", async () => {
      const userId = uid("key-hold");
      const fake = installFakeRedis();
      try {
        setModel("holding", { findMany: async () => [] });
        setModel("instrumentMapping", { findMany: async () => [] });

        // 99914b93 = the md5-8 version hash of `{}` (no filters set).
        await getHoldings(userId, {});
        assert.deepEqual(fake.rec.gets, [`holdings:${userId}:list:99914b93`]);
        assert.deepEqual(fake.rec.setexes, [
          { key: `holdings:${userId}:list:99914b93`, ttl: 300 },
        ]);
      } finally {
        fake.uninstall();
      }
    });

    it("getPositions reads and writes positions:<userId>:list:<filterHash> @ 180s", async () => {
      const userId = uid("key-pos");
      const fake = installFakeRedis();
      try {
        setModel("position", { findMany: async () => [] });
        await getPositions(userId, {});
        assert.deepEqual(fake.rec.gets, [`positions:${userId}:list:99914b93`]);
        assert.deepEqual(fake.rec.setexes, [
          { key: `positions:${userId}:list:99914b93`, ttl: 180 },
        ]);
      } finally {
        fake.uninstall();
      }
    });

    it("getTrades reads and writes trades:<userId>:list:<filterHash> @ 300s", async () => {
      const userId = uid("key-trades");
      const fake = installFakeRedis();
      try {
        setModel("trade", {
          findMany: async () => [],
          count: async () => 0,
        });
        setModel("pairedTradeView", {
          aggregate: async () => ({ _sum: { realizedPnL: 0 } }),
          count: async () => 0,
          findMany: async () => [],
        });

        // 34676081 = the md5-8 version hash of `{ limit: 50 }`.
        await getTrades(userId, { limit: 50 });
        assert.deepEqual(fake.rec.gets, [`trades:${userId}:list:34676081`]);
        assert.deepEqual(fake.rec.setexes, [
          { key: `trades:${userId}:list:34676081`, ttl: 300 },
        ]);
      } finally {
        fake.uninstall();
      }
    });

    it("getPortfolioRisk reads risk:<userId>:portfolio:default", async () => {
      const userId = uid("key-risk");
      const fake = installFakeRedis();
      try {
        setModel("holding", { findMany: async () => [] });
        await getPortfolioRisk(userId);
        assert.deepEqual(fake.rec.gets, [`risk:${userId}:portfolio:default`]);
        // "No holdings" is a FAILURE and must never be written to the cache.
        assert.deepEqual(fake.rec.setexes, []);
      } finally {
        fake.uninstall();
      }
    });

    it("getTaxReport reads and writes tax:<userId>:report%3A<fy>:default @ 600s", async () => {
      const userId = uid("key-tax");
      const fake = installFakeRedis();
      try {
        setModel("pairedTradeView", { findMany: async () => [] });
        setModel("holding", { findMany: async () => [] });

        // The ":" inside the identifier is escaped to "%3A" so it can never be
        // confused with the segment delimiter (see packages/cache/src/keys.ts).
        await getTaxReport(userId, "2025-26");
        assert.deepEqual(fake.rec.gets, [
          `tax:${userId}:report%3A2025-26:default`,
        ]);
        assert.deepEqual(fake.rec.setexes, [
          { key: `tax:${userId}:report%3A2025-26:default`, ttl: 600 },
        ]);
      } finally {
        fake.uninstall();
      }
    });

    it("a value written under the deployed key is still served after the change", async () => {
      // End-to-end proof that the read key did not move: seed through the
      // public cache API exactly as the previous build did, then assert the
      // service returns it WITHOUT touching Prisma at all.
      const userId = uid("key-compat");
      let prismaTouched = false;
      setModel("holding", {
        findMany: async () => {
          prismaTouched = true;
          return [];
        },
      });
      setModel("instrumentMapping", { findMany: async () => [] });

      const seeded = {
        holdings: [],
        summary: {
          totalInvested: 1,
          totalCurrent: 2,
          totalPnL: 1,
          pnlPercentage: "100.00",
        },
        sectorBreakdown: [],
        exchangeBreakdown: [],
      };
      await setCached("holdings", userId, "list", seeded, {});

      const result = await getHoldings(userId, {});
      assert.equal(prismaTouched, false, "a cache hit must not query Prisma");
      assert.ok(result.success);
      assert.equal(
        result.success && result.data.summary.pnlPercentage,
        "100.00",
      );
    });
  });
});
