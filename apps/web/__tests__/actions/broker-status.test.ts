/**
 * MONEY-620 — broker market-data status server action END-TO-END (real handler).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a SHADOW: under a "// LOGIC FUNCTIONS (mirrors
 * broker-status.ts)" banner it re-declared `isConnectionActive`,
 * `determineBrokerStatus`, `hasValidCredentials`, `hasRequiredDecryptedFields`
 * and `generateReauthUrl` — then asserted the COPIES. It imported NOTHING from
 * `lib/actions/broker-status.ts`, so the real query path that actually scopes a
 * user's Zerodha connection (the `auth()` gate, the IDOR-critical
 * `user.id`-scoped `brokerConnection.findFirst`, the decrypt + needs_reauth
 * fall-through) was never exercised. The copy could be green while the real
 * action handed live credentials to the wrong caller.
 *
 * This rewrite drives the REAL exported action `getBrokerMarketDataStatus`
 * through the established `require.cache` seam, and asserts the action's OWN
 * logic:
 *   - unauth (no clerk userId) → status "none", no DB reads.
 *   - no internal user row → "none".
 *   - no Zerodha connection → "none".
 *   - CONNECTED + future tokenExpiry → "active" (NO reauthUrl leaked).
 *   - CONNECTED + past tokenExpiry → "needs_reauth" with the env-keyed reauthUrl.
 *   - IDOR: the `brokerConnection.findMany` is scoped to the RESOLVED internal
 *     user.id — never the raw clerk id — and to broker "ZERODHA".
 *
 * (MONEY-837 removed `getBrokerCredentials` — the web app no longer hands out
 * broker credentials for market data, which is now Yahoo-only — so its tests
 * were dropped here.)
 *
 * `@clerk/nextjs/server`, `@/lib/prisma`, `@usemoney/security` and
 * `@usemoney/core` (the cache) are recorded stubs so we assert exactly what the
 * action reads / forwards / decrypts / caches.
 *
 * MONEY-1124 added a 60s user-scoped cache in front of BOTH Prisma queries, so
 * the cache is stubbed with a per-test in-memory fake (a real `cacheClient`
 * would bleed state across tests via its L1 memory layer).
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/broker-status.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── recorders ───────────────────────────────────────────────────────────────

interface PrismaFindCall {
  model: string;
  method: string;
  args: unknown;
}

interface DecryptCall {
  ciphertext: string;
  iv: string;
  authTag: string;
}

interface Harness {
  clerkUserId: string | null;
  /** internal user row returned by user.findFirst (null = not found) */
  userRow: { id: string } | null;
  /** brokerConnection.findMany result for the STATUS query (mirrored as a 1-element array) */
  statusConnection: { status: string; tokenExpiry: Date | null } | null;
  /** brokerConnection.findFirst result for the CREDENTIALS query */
  credsConnection: {
    encryptedCreds: string | null;
    iv: string | null;
    authTag: string | null;
  } | null;
  /** decrypt() return (object) or, if set, a thrown error */
  decrypted: Record<string, string>;
  decryptThrows?: Error;
  zerodhaApiKeyEnv: string;
  // recordings
  prismaCalls: PrismaFindCall[];
  decryptCalls: DecryptCall[];
  /** MONEY-1124 — per-test fake for the getCached/setCached seam. */
  cacheStore: Map<string, unknown>;
  cacheGets: string[];
  cacheSets: string[];
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

const ACTION_REL = "../../lib/actions/broker-status";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ACTION_REL)];
}

function freshHarness(): Harness {
  return {
    clerkUserId: "clerk_abc",
    userRow: { id: "internal-user-1" },
    statusConnection: null,
    credsConnection: null,
    decrypted: { apiKey: "decrypted-key", accessToken: "decrypted-token" },
    zerodhaApiKeyEnv: "env-api-key",
    prismaCalls: [],
    decryptCalls: [],
    cacheStore: new Map<string, unknown>(),
    cacheGets: [],
    cacheSets: [],
  };
}

/**
 * MONEY-1124 — in-memory stand-in for `@usemoney/core`'s getCached/setCached.
 * No TTL expiry is simulated: every test either starts empty (cold cache) or
 * seeds/reuses the store deliberately, and the TTL boundary itself is covered
 * by the pure resolver tests in __tests__/actions/broker-status-cache.test.ts.
 */
function makeCoreCacheStub(h: Harness): unknown {
  const key = (module: string, userId: string, identifier: string) =>
    `${module}:${userId}:${identifier}`;
  return {
    __esModule: true,
    getCached: (module: string, userId: string, identifier: string) => {
      const k = key(module, userId, identifier);
      h.cacheGets.push(k);
      return Promise.resolve(h.cacheStore.has(k) ? h.cacheStore.get(k) : null);
    },
    setCached: (
      module: string,
      userId: string,
      identifier: string,
      data: unknown
    ) => {
      const k = key(module, userId, identifier);
      h.cacheSets.push(k);
      h.cacheStore.set(k, data);
      return Promise.resolve();
    },
  };
}

interface BrokerMarketDataStatus {
  hasBroker: boolean;
  broker: string | null;
  status: "active" | "needs_reauth" | "none";
  brokerDisplayName: string | null;
  reauthUrl: string | null;
}

interface BrokerStatusModule {
  getBrokerMarketDataStatus: () => Promise<BrokerMarketDataStatus>;
}

// A recording prisma double. user.findFirst returns userRow; brokerConnection
// .findFirst returns statusConnection on the FIRST call (status query) and
// credsConnection on the SECOND (the credentials query selects encryptedCreds).
function makeRecordingPrisma(h: Harness): unknown {
  let brokerConnFindCount = 0;
  return {
    user: {
      findFirst: (args: unknown) => {
        h.prismaCalls.push({ model: "user", method: "findFirst", args });
        return Promise.resolve(h.userRow);
      },
    },
    brokerConnection: {
      findFirst: (args: unknown) => {
        h.prismaCalls.push({
          model: "brokerConnection",
          method: "findFirst",
          args,
        });
        const select = (args as { select?: Record<string, boolean> }).select;
        // The credentials query selects encryptedCreds; the status query does not.
        if (select && "encryptedCreds" in select) {
          return Promise.resolve(h.credsConnection);
        }
        brokerConnFindCount += 1;
        return Promise.resolve(h.statusConnection);
      },
      // MONEY-837: getBrokerMarketDataStatus now evaluates ALL Zerodha
      // connections via findMany (the page banner is suppressed if ANY connection
      // is healthy), not "the newest single row". Mirror the single-connection
      // harness as a 1-element array; the multi-connection "any-healthy"
      // assertions are tracked in MONEY-838.
      findMany: (args: unknown) => {
        h.prismaCalls.push({
          model: "brokerConnection",
          method: "findMany",
          args,
        });
        return Promise.resolve(h.statusConnection ? [h.statusConnection] : []);
      },
    },
  };
}

function loadAction(h: Harness): BrokerStatusModule {
  const cache = moduleCache();

  const clerkPath = require.resolve("@clerk/nextjs/server");
  const prismaPath = require.resolve("../../lib/prisma");
  const securityPath = require.resolve("@usemoney/security");
  const corePath = require.resolve("@usemoney/core");
  const actionPath = require.resolve(ACTION_REL);

  for (const p of [clerkPath, prismaPath, securityPath, corePath]) {
    snapshotOnce(p);
  }

  cache[corePath] = { exports: makeCoreCacheStub(h) };

  cache[clerkPath] = {
    exports: {
      __esModule: true,
      auth: () => Promise.resolve({ userId: h.clerkUserId }),
    },
  };
  cache[prismaPath] = {
    exports: {
      __esModule: true,
      prisma: makeRecordingPrisma(h),
      default: makeRecordingPrisma(h),
    },
  };
  cache[securityPath] = {
    exports: {
      __esModule: true,
      encryption: {
        decrypt: (ciphertext: string, iv: string, authTag: string) => {
          h.decryptCalls.push({ ciphertext, iv, authTag });
          if (h.decryptThrows) throw h.decryptThrows;
          return h.decrypted;
        },
      },
    },
  };

  process.env.ZERODHA_API_KEY = h.zerodhaApiKeyEnv;

  delete cache[actionPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as BrokerStatusModule;
}

const future = () => new Date(Date.now() + 24 * 60 * 60 * 1000);
const past = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — broker-status actions (real handlers, mocked I/O)", () => {
  let h: Harness;
  const savedEnv = process.env.ZERODHA_API_KEY;
  beforeEach(() => {
    h = freshHarness();
  });
  after(() => {
    restoreCache();
    if (savedEnv === undefined) delete process.env.ZERODHA_API_KEY;
    else process.env.ZERODHA_API_KEY = savedEnv;
  });

  describe("getBrokerMarketDataStatus", () => {
    it("unauthenticated → 'none', no DB reads", async () => {
      h.clerkUserId = null;
      const action = loadAction(h);
      const res = await action.getBrokerMarketDataStatus();
      assert.equal(res.status, "none");
      assert.equal(res.hasBroker, false);
      assert.equal(res.reauthUrl, null);
      assert.equal(h.prismaCalls.length, 0, "no DB query without a clerk id");
    });

    it("no internal user row → 'none'", async () => {
      h.userRow = null;
      const action = loadAction(h);
      const res = await action.getBrokerMarketDataStatus();
      assert.equal(res.status, "none");
      // user lookup ran, but no broker query (short-circuit).
      assert.ok(h.prismaCalls.some((c) => c.model === "user"));
      assert.equal(
        h.prismaCalls.some((c) => c.model === "brokerConnection"),
        false
      );
    });

    it("no Zerodha connection → 'none'", async () => {
      h.statusConnection = null;
      const action = loadAction(h);
      const res = await action.getBrokerMarketDataStatus();
      assert.equal(res.status, "none");
      assert.equal(res.hasBroker, false);
    });

    it("CONNECTED + future expiry → 'active' (no reauthUrl leaked)", async () => {
      h.statusConnection = { status: "CONNECTED", tokenExpiry: future() };
      const action = loadAction(h);
      const res = await action.getBrokerMarketDataStatus();
      assert.equal(res.status, "active");
      assert.equal(res.hasBroker, true);
      assert.equal(res.broker, "ZERODHA");
      assert.equal(res.brokerDisplayName, "Zerodha");
      assert.equal(res.reauthUrl, null);
    });

    it("CONNECTED + past expiry → 'needs_reauth' with env-keyed reauthUrl", async () => {
      h.statusConnection = { status: "CONNECTED", tokenExpiry: past() };
      h.zerodhaApiKeyEnv = "env-api-key";
      const action = loadAction(h);
      const res = await action.getBrokerMarketDataStatus();
      assert.equal(res.status, "needs_reauth");
      assert.equal(res.hasBroker, true);
      assert.ok(res.reauthUrl);
      assert.ok(res.reauthUrl!.includes("env-api-key"));
      assert.ok(
        res.reauthUrl!.startsWith("https://kite.zerodha.com/connect/login")
      );
    });

    it("CONNECTED + null expiry → 'needs_reauth'", async () => {
      h.statusConnection = { status: "CONNECTED", tokenExpiry: null };
      const action = loadAction(h);
      const res = await action.getBrokerMarketDataStatus();
      assert.equal(res.status, "needs_reauth");
    });

    it("DISCONNECTED + future expiry → 'needs_reauth' (status gate, not just expiry)", async () => {
      h.statusConnection = { status: "DISCONNECTED", tokenExpiry: future() };
      const action = loadAction(h);
      const res = await action.getBrokerMarketDataStatus();
      assert.equal(res.status, "needs_reauth");
    });

    it("needs_reauth with empty env key → reauthUrl null", async () => {
      h.statusConnection = { status: "CONNECTED", tokenExpiry: past() };
      h.zerodhaApiKeyEnv = "";
      const action = loadAction(h);
      const res = await action.getBrokerMarketDataStatus();
      assert.equal(res.status, "needs_reauth");
      assert.equal(res.reauthUrl, null);
    });

    it("IDOR: broker query is scoped to the RESOLVED internal user.id + ZERODHA", async () => {
      h.statusConnection = { status: "CONNECTED", tokenExpiry: future() };
      const action = loadAction(h);
      await action.getBrokerMarketDataStatus();
      const bc = h.prismaCalls.find((c) => c.model === "brokerConnection");
      assert.ok(bc);
      const where = (bc!.args as { where: Record<string, unknown> }).where;
      assert.equal(
        where.userId,
        "internal-user-1",
        "must scope to resolved internal user.id, never the raw clerk id"
      );
      assert.notEqual(where.userId, "clerk_abc");
      assert.equal(where.broker, "ZERODHA");
    });

    // ── MONEY-1124: 60s user-scoped cache in front of BOTH queries ────────
    it("second call within the window issues NO further Prisma query", async () => {
      h.statusConnection = { status: "CONNECTED", tokenExpiry: future() };
      const action = loadAction(h);

      const first = await action.getBrokerMarketDataStatus();
      assert.equal(first.status, "active");
      const afterCold = h.prismaCalls.length;
      assert.ok(
        afterCold >= 2,
        "cold call must read user + brokerConnection (got " + afterCold + ")"
      );

      const second = await action.getBrokerMarketDataStatus();
      assert.deepEqual(second, first, "warm call returns the same status");
      assert.equal(
        h.prismaCalls.length,
        afterCold,
        "warm call must not re-query the DB"
      );
      assert.ok(h.cacheSets.length > 0, "cold call populated the cache");
    });

    it("caches under the 'brokers' module keyed by the INTERNAL user id (so clearBrokerConnectionCache sweeps it)", async () => {
      h.statusConnection = { status: "CONNECTED", tokenExpiry: future() };
      const action = loadAction(h);
      await action.getBrokerMarketDataStatus();

      assert.ok(
        h.cacheSets.some((k) => k.startsWith("brokers:internal-user-1:")),
        `expected a brokers:<internal id> key, got ${JSON.stringify(h.cacheSets)}`
      );
      assert.equal(
        h.cacheSets.some((k) => k.startsWith("brokers:clerk_abc:")),
        false,
        "must never key the broker cache on the raw clerk id"
      );
    });

    it("a missing user row is negative-cached and not re-queried", async () => {
      h.userRow = null;
      const action = loadAction(h);

      const first = await action.getBrokerMarketDataStatus();
      assert.equal(first.status, "none");
      const afterCold = h.prismaCalls.filter((c) => c.model === "user").length;
      assert.equal(afterCold, 1);

      const second = await action.getBrokerMarketDataStatus();
      assert.equal(second.status, "none");
      assert.equal(
        h.prismaCalls.filter((c) => c.model === "user").length,
        1,
        "the { id: null } negative entry must be distinguishable from a miss"
      );
    });

    it("a thrown DB error degrades to 'none' (never throws to the caller)", async () => {
      const action = loadAction(h);
      const cache = moduleCache();
      const prismaPath = require.resolve("../../lib/prisma");
      (
        cache[prismaPath]!.exports as {
          prisma: { user: { findFirst: unknown } };
        }
      ).prisma.user.findFirst = () => Promise.reject(new Error("db down"));
      const res = await action.getBrokerMarketDataStatus();
      assert.equal(res.status, "none");
      assert.equal(res.hasBroker, false);
    });
  });
});
