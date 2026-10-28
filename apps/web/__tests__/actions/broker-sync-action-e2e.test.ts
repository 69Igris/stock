/**
 * MONEY-620 — syncBrokerDataAction END-TO-END (real orchestration handler).
 *
 * `syncBrokerDataAction` (lib/actions/broker-connection.ts) is the broker-sync
 * orchestrator: resolve user → load the connection (userId-scoped) → decrypt →
 * build a broker client → per-type fetch+persist with FAILURE ISOLATION → stamp
 * lastSync + write a SyncLog → bust caches → revalidate the four portfolio pages.
 * It is heavily coupled, but drivable end-to-end by injecting its boundaries; we
 * do so to pin the behaviors that matter most:
 *
 *   - demo gate FIRST (no auth/DB).
 *   - auth gate ("Authentication required") when the user can't be resolved.
 *   - "Broker not connected" when no connection row (or no encryptedCreds).
 *   - IDOR: when a `connectionId` is supplied the connection lookup is scoped to
 *     { id, userId, broker } — never just { id } — so user A can't sync user B's
 *     connection by id.
 *   - per-type sync counts land in `synced` from the broker client's row counts.
 *   - FAILURE ISOLATION: if one type's fetch throws, the others STILL sync and
 *     the action STILL returns success (a single bad endpoint must not abort the
 *     whole sync) — and a broker-failure is recorded for the failed type.
 *   - success side-effects: brokerConnection.update({ lastSync }), syncLog.create
 *     (status SUCCESS, recordsFetched = sum), and revalidatePath × 4.
 *
 * Seam: inject stubs for `@clerk/nextjs/server` (auth/currentUser), `@/lib/prisma`
 * (recording double whose `$transaction` runs the callback against itself, so the
 * REAL in-file `sync*ToDb` helpers execute), `@usemoney/security` (decrypt),
 * `@/lib/brokers/clients` (a fake `createBrokerClient`), `@usemoney/core` (cache
 * no-ops + label helpers), `@/lib/posthog`, `@/lib/gemini/indexer`,
 * `@usemoney/email` (+ templates), `@/lib/pairing/service`, `next/cache`
 * (revalidate recorder) and the logger — all via `require.cache` before requiring
 * a FRESH action module. `@usemoney/utils/error-sanitization` stays REAL.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: apps/web/lib/actions/broker-connection.ts (syncBrokerDataAction)
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── recording prisma double ────────────────────────────────────────────────

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

interface Connection {
  id: string;
  userId: string;
  broker: string;
  brokerUserId: string | null;
  encryptedCreds: string | null;
  iv: string | null;
  authTag: string | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  clerkId: string | null;
  emailPreferences: unknown;
  // MONEY-837: the free-tier trial gate selects createdAt; optional so the
  // happy-path fixtures (no trial concern) don't have to set it.
  createdAt?: Date;
}

class RecordingPrisma {
  readonly calls: RecordedCall[] = [];
  user: UserRow | null;
  connection: Connection | null;

  constructor(user: UserRow | null, connection: Connection | null) {
    this.user = user;
    this.connection = connection;
  }

  private rec(model: string, method: string, args: unknown): void {
    this.calls.push({ model, method, args });
  }

  callsFor(model: string, method: string): RecordedCall[] {
    return this.calls.filter((c) => c.model === model && c.method === method);
  }

  // The object handed to the action as `prisma`. Only the methods the sync path
  // touches are implemented; everything else is a benign recorder.
  get client(): Record<string, unknown> {
    const self = this;
    const model = (name: string) => ({
      findUnique: (args: { where: Record<string, unknown> }) => {
        self.rec(name, "findUnique", args);
        if (name === "user") return Promise.resolve(self.user);
        return Promise.resolve(null);
      },
      findFirst: (args: { where: Record<string, unknown> }) => {
        self.rec(name, "findFirst", args);
        if (name === "brokerConnection")
          return Promise.resolve(self.connection);
        if (name === "deletedUserAudit") return Promise.resolve(null);
        return Promise.resolve(null);
      },
      // MONEY-837: the shared broker-sync service resolves connections via
      // findMany (wildcard-safe), so the orchestration now goes through here.
      findMany: (args: { where: Record<string, unknown> }) => {
        self.rec(name, "findMany", args);
        if (name === "brokerConnection")
          return Promise.resolve(self.connection ? [self.connection] : []);
        return Promise.resolve([]);
      },
      update: (args: unknown) => {
        self.rec(name, "update", args);
        if (name === "user") return Promise.resolve(self.user);
        return Promise.resolve({});
      },
      create: (args: unknown) => {
        self.rec(name, "create", args);
        if (name === "user") return Promise.resolve(self.user);
        return Promise.resolve({});
      },
      deleteMany: (args: unknown) => {
        self.rec(name, "deleteMany", args);
        return Promise.resolve({ count: 0 });
      },
      createMany: (args: unknown) => {
        self.rec(name, "createMany", args);
        return Promise.resolve({ count: 0 });
      },
      updateMany: (args: unknown) => {
        self.rec(name, "updateMany", args);
        return Promise.resolve({ count: 0 });
      },
      upsert: (args: unknown) => {
        self.rec(name, "upsert", args);
        return Promise.resolve({});
      },
      count: (args: unknown) => {
        self.rec(name, "count", args);
        return Promise.resolve(0);
      },
    });

    const handler: ProxyHandler<Record<string, unknown>> = {
      get(target, prop: string) {
        if (prop === "$transaction") {
          // Run the callback against this same client so the REAL in-file
          // sync*ToDb helpers execute their delete+createMany under "tx".
          return (arg: unknown) => {
            if (typeof arg === "function") {
              return Promise.resolve(
                (arg as (tx: unknown) => unknown)(self.client)
              );
            }
            return Promise.all(arg as unknown[]);
          };
        }
        if (typeof prop !== "string") return undefined;
        if (!(prop in target)) target[prop] = model(prop);
        return target[prop];
      },
    };
    return new Proxy({}, handler);
  }
}

// ── boundary injection ──────────────────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const SILENT_LOGGER = {
  debug() {},
  error() {},
  info() {},
  warn() {},
  trace() {},
  fatal() {},
  child() {
    return SILENT_LOGGER;
  },
};
function makeLoggerStub(): Record<string, unknown> {
  const factory = () => SILENT_LOGGER;
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getLogger" || k === "default" || k === "createModuleLoggers")
          return factory;
        if (k === "initLogger" || k === "flushLogs")
          return async () => undefined;
        return SILENT_LOGGER;
      },
    }
  );
}

interface FakeClientRows {
  holdings?: unknown[] | (() => never);
  positions?: unknown[] | (() => never);
  trades?: unknown[] | (() => never);
  mutualFunds?: unknown[] | (() => never);
  historicalTrades?: unknown[] | (() => never);
}

interface Harness {
  revalidated: string[];
  prisma: RecordingPrisma;
  authUserId: string | null;
  authEmail: string | null;
  rows: FakeClientRows;
  failures: Array<{ operation: string }>;
  clientBuilt: boolean;
  /** MONEY-839: trade-pairing jobs the action PUBLISHED (worker-only pairing). */
  pairingJobs: Array<{ userId: string }>;
  /** MONEY-839: broker-sync jobs the action PUBLISHED (worker-only sync). */
  syncJobs: Array<Record<string, unknown>>;
}

interface SyncActionModule {
  syncBrokerDataAction: (
    broker: string,
    syncTypes?: ("holdings" | "positions" | "trades" | "mutualFunds")[],
    connectionId?: string,
    opts?: {
      historicalPending?: boolean;
      isInitialConnect?: boolean;
      syncEmail?: boolean;
    }
  ) => Promise<{
    success: boolean;
    jobId?: string;
    synced?: Record<string, number>;
    error?: string;
  }>;
  syncHistoricalTradesAction: (
    broker: string,
    fromDate?: string,
    toDate?: string,
    connectionId?: string
  ) => Promise<{ success: boolean; synced?: number; error?: string }>;
  /** MONEY-840: re-pair → publishes a trade-pairing job to the worker. */
  triggerRepairingAction: () => Promise<{
    success: boolean;
    paired?: number;
    error?: string;
  }>;
}

const ACTION_REL = "../../lib/actions/broker-connection";

function arrOrThrow(v: unknown[] | (() => never) | undefined): unknown[] {
  if (typeof v === "function") (v as () => never)();
  return (v as unknown[]) ?? [];
}

function loadAction(h: Harness): SyncActionModule {
  const cache = moduleCache();
  const resolve = (p: string) => require.resolve(p);

  // Clerk auth used by getOrCreateUser().
  cache[resolve("@clerk/nextjs/server")] = {
    exports: {
      __esModule: true,
      auth: () => Promise.resolve({ userId: h.authUserId }),
      currentUser: () =>
        Promise.resolve(
          h.authUserId && h.authEmail
            ? {
                emailAddresses: [{ emailAddress: h.authEmail }],
                fullName: "Sync Tester",
                firstName: "Sync",
              }
            : null
        ),
    },
  };

  cache[resolve("@/lib/prisma")] = {
    exports: {
      __esModule: true,
      prisma: h.prisma.client,
      default: h.prisma.client,
    },
  };

  // MONEY-837: the orchestration moved into @usemoney/services
  // syncBrokerConnections, which imports prisma from @usemoney/database — point
  // it at the SAME recording double so the full web-SA → service → I/O path is
  // driven end-to-end through one recorder.
  cache[resolve("@usemoney/database")] = {
    exports: {
      __esModule: true,
      prisma: h.prisma.client,
      default: h.prisma.client,
    },
  };

  // The action imports `getAuthenticatedUser` from `@/lib/auth`, which calls
  // React `cache()` at module load (undefined outside the Next runtime). Stub
  // the module so requiring the action doesn't blow up. syncBrokerDataAction
  // itself uses getOrCreateUser() (Clerk-backed above), not this export.
  cache[resolve("@/lib/auth")] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: () =>
        Promise.resolve(
          h.authUserId ? { userId: h.prisma.user?.id ?? "u" } : null
        ),
    },
  };

  cache[resolve("@usemoney/security")] = {
    exports: {
      __esModule: true,
      encryption: {
        decrypt: () => ({ accessToken: "decrypted-token" }),
        encrypt: () => ({ encrypted: "x", iv: "y", authTag: "z" }),
      },
    },
  };
  // MONEY-1062 (W2-B): broker-sync.service now imports encryption from the
  // /encryption subpath — alias it to the same decrypt/encrypt stub.
  cache[resolve("@usemoney/security/encryption")] =
    cache[resolve("@usemoney/security")];

  // Fake broker client — createBrokerClient(broker, creds) → object with the
  // four fetch methods. Records that a client was built. (No getProfile: the
  // service's opt-in profile refresh then throws and is swallowed, so the only
  // brokerConnection.update is the lastSync stamp.) The web SA still imports
  // createBrokerClient from this shim (connectWithApiKeyAction); the SERVICE
  // imports it from @usemoney/core/brokers — both point at the same fake.
  const fakeCreateBrokerClient = () => {
    h.clientBuilt = true;
    return {
      getHoldings: () => Promise.resolve(arrOrThrow(h.rows.holdings)),
      getPositions: () => Promise.resolve(arrOrThrow(h.rows.positions)),
      getTrades: () => Promise.resolve(arrOrThrow(h.rows.trades)),
      getMutualFunds: () => Promise.resolve(arrOrThrow(h.rows.mutualFunds)),
      getHistoricalTrades: () =>
        Promise.resolve(arrOrThrow(h.rows.historicalTrades)),
      lastHoldingsMeta: undefined,
    };
  };
  cache[resolve("@/lib/brokers/clients")] = {
    exports: {
      __esModule: true,
      createBrokerClient: fakeCreateBrokerClient,
      ZerodhaClient: class {},
    },
  };
  cache[resolve("@usemoney/core/brokers")] = {
    exports: {
      __esModule: true,
      createBrokerClient: fakeCreateBrokerClient,
    },
  };

  // @usemoney/core: cache helpers no-op; label helpers passthrough; config
  // helpers return benign values. A Proxy covers every named export the action
  // (and its in-file helpers) might read.
  cache[resolve("@usemoney/core")] = {
    exports: new Proxy(
      { __esModule: true },
      {
        get(_t, k: string) {
          if (k === "__esModule") return true;
          if (k === "getBrokerConfig")
            return () => ({ name: "Broker", oauthUrl: "" });
          if (k === "getBrokerEnvKeys") return () => ({});
          if (k === "getCached") return async () => null;
          if (k === "getSegmentLabel" || k === "getProductTypeLabel")
            return (x: string) => x;
          return async () => {};
        },
      }
    ),
  };

  cache[resolve("@/lib/posthog")] = {
    exports: {
      __esModule: true,
      default: () => ({ capture() {}, shutdown: async () => {} }),
    },
  };
  cache[resolve("@/lib/gemini/indexer")] = {
    exports: {
      __esModule: true,
      indexUserHoldings: async () => {},
      indexUserTrades: async () => {},
    },
  };
  cache[resolve("@/lib/brokers/failure-log")] = {
    exports: {
      __esModule: true,
      recordBrokerFailure: (a: { operation: string }) => {
        h.failures.push({ operation: a.operation });
      },
    },
  };
  cache[resolve("@/lib/db/notifications")] = {
    exports: { __esModule: true, createNotification: async () => {} },
  };
  cache[resolve("@/lib/pairing/service")] = {
    exports: { __esModule: true, pairUserTrades: async () => ({}) },
  };
  cache[resolve("@usemoney/email")] = {
    exports: {
      __esModule: true,
      sendEmail: () => Promise.resolve({ success: true }),
      getEffectivePreferences: () => ({}),
      shouldSendEmail: () => false, // keep the email branch OFF
      buildUnsubscribeUrl: () => "https://usemoney.ai/unsub",
      moveContactToSegment: async () => {},
    },
  };
  cache[resolve("@usemoney/email/templates")] = {
    exports: {
      __esModule: true,
      SyncCompleteEmail: () => null,
      BrokerConnectedEmail: () => null,
    },
  };
  cache[resolve("@/lib/demo/session")] = {
    exports: {
      __esModule: true,
      isDemoSession: () => Promise.resolve(h.isDemo ?? false),
      COOKIE_NAME: "sb_demo",
    },
  } as { exports: unknown };
  cache[resolve("@/lib/demo/data")] = {
    exports: { __esModule: true, demoBrokerConnections: [] },
  };
  cache[resolve("next/cache")] = {
    exports: {
      __esModule: true,
      revalidatePath: (p: string) => {
        h.revalidated.push(p);
      },
      revalidateTag: () => {},
    },
  };
  cache[resolve("@usemoney/logger")] = { exports: makeLoggerStub() };

  // MONEY-839: pairing is worker-only — the actions PUBLISH a pairing job. Seam
  // the publisher so the test records the jobs instead of hitting Pub/Sub.
  cache[resolve("@usemoney/pubsub/publish")] = {
    exports: {
      __esModule: true,
      publishPairingJob: (d: { userId: string }) => {
        if (h.failPairingPublish) {
          return Promise.reject(new Error("pubsub publish refused"));
        }
        h.pairingJobs.push(d);
        return Promise.resolve();
      },
      publishSyncJob: (d: Record<string, unknown>) => {
        h.syncJobs.push(d);
        return Promise.resolve();
      },
    },
  };

  // MONEY-837: the orchestration now lives in @usemoney/services
  // broker-sync.service. Purge the services layer from the module cache so it
  // RE-REQUIRES fresh and binds to the mocked @usemoney/database +
  // @usemoney/core/brokers above (otherwise it keeps a previously-cached copy
  // wired to the real prisma/client and the recorder never sees the calls).
  for (const key of Object.keys(cache)) {
    if (
      key.includes("packages/services/src/index.") ||
      key.includes("packages/services/src/broker-sync.service")
    ) {
      delete cache[key];
    }
  }

  // MONEY-1062 (W2-B): getOrCreateUser now delegates to getOrCreateDbUser
  // (@/lib/db/user), which keeps a module-level 5-min user cache — purge it so it
  // re-binds to the mocked prisma and can't leak a resolved user across tests.
  delete cache[resolve("@/lib/db/user")];
  delete cache[resolve(ACTION_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as SyncActionModule;
}

// Augment Harness with the optional demo flag used above.
interface Harness {
  isDemo?: boolean;
  /** MONEY-840: force publishPairingJob to reject (error-path coverage). */
  failPairingPublish?: boolean;
}

function makeUser(): UserRow {
  return {
    id: "user-sync-1",
    email: "sync@example.com",
    name: "Sync Tester",
    clerkId: "clerk_abc",
    emailPreferences: null,
  };
}

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    userId: "user-sync-1",
    broker: "ZERODHA",
    brokerUserId: "ZUID",
    encryptedCreds: "ENC",
    iv: "IV",
    authTag: "TAG",
    ...overrides,
  };
}

function baseHarness(): Harness {
  return {
    revalidated: [],
    prisma: new RecordingPrisma(makeUser(), makeConnection()),
    authUserId: "clerk_abc",
    authEmail: "sync@example.com",
    rows: {},
    failures: [],
    clientBuilt: false,
    pairingJobs: [],
    syncJobs: [],
  };
}

// A holding row shaped enough for syncHoldingsToDb's mapper.
function holdingRow(symbol: string): Record<string, unknown> {
  return {
    symbol,
    tradingSymbol: symbol,
    name: symbol,
    isin: `IN${symbol}`,
    instrumentToken: 1,
    exchange: "NSE",
    quantity: 10,
    averagePrice: 100,
    currentPrice: 110,
    closePrice: 108,
    investedValue: 1000,
    currentValue: 1100,
    pnl: 100,
    pnlPercentage: 10,
    dayChange: 2,
    dayChangePercentage: 1,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — syncBrokerDataAction (real orchestration, mocked I/O)", () => {
  let h: Harness;

  beforeEach(() => {
    h = baseHarness();
  });

  describe("gates", () => {
    it("demo session is refused before any auth/DB work", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.syncBrokerDataAction("ZERODHA");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.prisma.calls.length, 0);
      assert.equal(h.clientBuilt, false);
    });

    it("returns 'Authentication required' when the user can't be resolved", async () => {
      h.authUserId = null;
      const action = loadAction(h);
      const res = await action.syncBrokerDataAction("ZERODHA");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Authentication required/);
      assert.equal(h.clientBuilt, false);
    });

    it("skips a connection whose encryptedCreds is null (success, nothing synced, no client)", async () => {
      h.prisma = new RecordingPrisma(
        makeUser(),
        makeConnection({ encryptedCreds: null })
      );
      const action = loadAction(h);
      const res = await action.syncBrokerDataAction("ZERODHA");
      // MONEY-837: the shared service SKIPS a creds-less connection (no-credentials)
      // rather than erroring — a broken connection must not abort a multi-broker
      // sync. The run succeeds with an empty synced set and no client built.
      assert.equal(res.success, true);
      assert.equal(h.clientBuilt, false);
      assert.equal(res.synced?.holdings, undefined);
    });

    it("blocks sync for a FREE user whose 30-day trial has expired (MONEY-837)", async () => {
      // FREE plan + signup > 30 days ago → broker sync is gated. The gate runs
      // BEFORE any credential decrypt / client build.
      h.prisma = new RecordingPrisma(
        { ...makeUser(), createdAt: new Date("2020-01-01T00:00:00Z") },
        makeConnection()
      );
      const action = loadAction(h);
      const res = await action.syncBrokerDataAction("ZERODHA");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /trial|[Uu]pgrade/);
      assert.equal(h.clientBuilt, false);
    });
  });

  describe("worker-only publish (MONEY-839)", () => {
    it("publishes one BROKER_SYNC job (dataTypes scoped) + a pollable tracking row; no inline sync, no pairing", async () => {
      const action = loadAction(h);
      const res = await action.syncBrokerDataAction("ZERODHA", [
        "holdings",
        "trades",
      ]);
      assert.equal(res.success, true);
      // The action no longer syncs inline — it builds no client and does not run
      // the orchestration directly (that is the worker's job now).
      assert.equal(h.clientBuilt, false);
      // Exactly one broker-sync job is published for the worker to run.
      assert.equal(h.syncJobs.length, 1);
      const job = h.syncJobs[0]!;
      assert.equal(job.userId, "user-sync-1");
      assert.equal(job.broker, "ZERODHA");
      assert.deepEqual(job.dataTypes, ["holdings", "trades"]);
      // A plain manual sync requests no historical backfill / email.
      assert.equal(job.historicalDays, undefined);
      assert.equal(job.historicalEmail, undefined);
      // A BackgroundJob row is pre-created so the tradebook loader can poll it.
      const created = h.prisma.callsFor("backgroundJob", "create");
      assert.equal(created.length, 1);
      assert.equal(
        (created[0]!.args as { data: { jobType: string } }).data.jobType,
        "BROKER_SYNC"
      );
      // NO pairing (moved to MONEY-840).
      assert.equal(h.pairingJobs.length, 0);
    });

    it("a connect sync (historicalPending + isInitialConnect) requests the backfill + the worker email", async () => {
      const action = loadAction(h);
      const res = await action.syncBrokerDataAction(
        "ZERODHA",
        ["holdings", "trades"],
        undefined,
        { historicalPending: true, isInitialConnect: true }
      );
      assert.equal(res.success, true);
      assert.equal(h.syncJobs.length, 1);
      const job = h.syncJobs[0]!;
      assert.ok(
        typeof job.historicalDays === "number" &&
          (job.historicalDays as number) > 0,
        "historicalPending → a positive historicalDays window"
      );
      assert.equal(job.historicalEmail, true);
    });

    // MONEY-848: syncEmail flag plumbing — only the brokers-page manual Sync
    // sets it; the silent refresh callers must leave it unset so the worker
    // doesn't email on a routine background refresh.
    it("syncEmail opt → published job carries syncEmail:true + returns a jobId", async () => {
      const action = loadAction(h);
      const res = await action.syncBrokerDataAction(
        "ZERODHA",
        ["holdings", "positions", "trades", "mutualFunds"],
        undefined,
        { syncEmail: true }
      );
      assert.equal(res.success, true);
      // jobId is returned so the brokers page can poll for the real counts.
      assert.equal(typeof res.jobId, "string");
      assert.ok((res.jobId as string).length > 0);
      assert.equal(h.syncJobs.length, 1);
      const job = h.syncJobs[0]!;
      assert.equal(job.syncEmail, true);
      // syncEmail is independent of the historical backfill email.
      assert.equal(job.historicalEmail, undefined);
      assert.equal(job.historicalDays, undefined);
      // the published jobId matches the one the action returns (pollable).
      assert.equal(job.jobId, res.jobId);
    });

    it("default sync (no opts) omits syncEmail entirely — silent refresh stays quiet", async () => {
      const action = loadAction(h);
      const res = await action.syncBrokerDataAction("ZERODHA", ["holdings"]);
      assert.equal(res.success, true);
      assert.equal(h.syncJobs.length, 1);
      const job = h.syncJobs[0]!;
      // crucially NOT present (not syncEmail:false) so the worker's
      // `if (syncEmail && …)` gate is never entered for a background refresh.
      assert.equal(job.syncEmail, undefined);
      assert.ok(!("syncEmail" in job));
    });
  });

  // MONEY-839: these exercised the INLINE orchestration (syncBrokerConnections)
  // via the web action. Sync is worker-only now, so the action just publishes —
  // the orchestration is unchanged but runs on the worker. Skipped here pending
  // a direct worker/service test (re-home: MONEY-840). Not deleted so the
  // assertions are preserved for that re-home.
  describe.skip("success path + side-effects — orchestration moved to the worker (re-home: MONEY-840)", () => {
    it("counts each synced type and writes lastSync + SyncLog + revalidates 4 pages", async () => {
      h.rows = {
        holdings: [holdingRow("INFY"), holdingRow("TCS")], // 2
        positions: [], // empty (legit squared-off) → count 0
        trades: [{ symbol: "INFY", tradeType: "BUY", quantity: 1, price: 1 }], // 1
      };
      const action = loadAction(h);
      const res = await action.syncBrokerDataAction("ZERODHA", [
        "holdings",
        "positions",
        "trades",
      ]);

      assert.equal(res.success, true);
      assert.equal(res.synced?.holdings, 2);
      assert.equal(res.synced?.positions, 0);
      assert.equal(res.synced?.trades, 1);

      // lastSync stamp.
      const upd = h.prisma.callsFor("brokerConnection", "update")[0];
      assert.ok(upd, "expected brokerConnection.update for lastSync");
      const updArgs = upd!.args as {
        where: { id: string };
        data: { lastSync: Date };
      };
      assert.equal(updArgs.where.id, "conn-1");
      assert.ok(updArgs.data.lastSync instanceof Date);

      // SyncLog: SUCCESS + recordsFetched = 2 + 0 + 1 = 3.
      const log = h.prisma.callsFor("syncLog", "create")[0];
      assert.ok(log, "expected syncLog.create");
      const logData = (log!.args as { data: Record<string, unknown> }).data;
      assert.equal(logData.status, "SUCCESS");
      assert.equal(logData.recordsFetched, 3);
      assert.equal(logData.userId, "user-sync-1");

      // Revalidates exactly the four portfolio pages.
      assert.deepEqual(h.revalidated.sort(), [
        "/dashboard",
        "/holdings",
        "/positions",
        "/tradebook",
      ]);
    });

    it("a fresh client is built from the decrypted creds", async () => {
      h.rows = { holdings: [holdingRow("INFY")] };
      const action = loadAction(h);
      await action.syncBrokerDataAction("ZERODHA", ["holdings"]);
      assert.equal(h.clientBuilt, true);
    });

    it("a successful sync restores status CONNECTED + clears errorMessage (MONEY-837 sticky-reauth fix)", async () => {
      // The bug: a connection that ever hit a 403/expiry stayed NEEDS_REAUTH
      // forever — even right after a successful re-auth+sync. Success must clear it.
      h.rows = { holdings: [holdingRow("INFY")] };
      const action = loadAction(h);
      await action.syncBrokerDataAction("ZERODHA", ["holdings"]);
      const upd = h.prisma.callsFor("brokerConnection", "update")[0];
      assert.ok(upd, "expected the success update");
      const data = (upd!.args as { data: Record<string, unknown> }).data;
      assert.equal(data.status, "CONNECTED");
      assert.equal(data.errorMessage, null);
      assert.ok(data.lastSync instanceof Date);
    });
  });

  // MONEY-839: orchestration (syncBrokerConnections) moved to the worker — see
  // the note above. Skipped pending a direct worker/service test (MONEY-840).
  describe.skip("per-type FAILURE ISOLATION — orchestration moved to the worker (re-home: MONEY-840)", () => {
    it("a holdings fetch failure does not abort positions/trades; action still succeeds", async () => {
      h.rows = {
        holdings: () => {
          throw new Error("Zerodha holdings 500");
        },
        positions: [],
        trades: [{ symbol: "INFY", tradeType: "BUY", quantity: 1, price: 1 }],
      };
      const action = loadAction(h);
      const res = await action.syncBrokerDataAction("ZERODHA", [
        "holdings",
        "positions",
        "trades",
      ]);

      // The whole sync still succeeds despite one bad endpoint.
      assert.equal(res.success, true);
      // Holdings count is absent (its branch threw before setting it)...
      assert.equal(res.synced?.holdings, undefined);
      // ...but trades still synced.
      assert.equal(res.synced?.trades, 1);
      // A broker failure was recorded for the failed holdings op.
      assert.equal(
        h.failures.some((f) => f.operation === "sync_holdings"),
        true
      );
      // SyncLog still written (recordsFetched counts only what synced = 1).
      const log = h.prisma.callsFor("syncLog", "create")[0];
      assert.equal(
        (log!.args as { data: { recordsFetched: number } }).data.recordsFetched,
        1
      );
      // And the pages are still revalidated (the success tail ran).
      assert.equal(h.revalidated.length, 4);
    });

    it("only the requested syncTypes are fetched (positions-only)", async () => {
      h.rows = {
        holdings: () => {
          throw new Error("should not be called");
        },
        positions: [],
      };
      const action = loadAction(h);
      const res = await action.syncBrokerDataAction("ZERODHA", ["positions"]);
      assert.equal(res.success, true);
      assert.equal(res.synced?.positions, 0);
      assert.equal(res.synced?.holdings, undefined);
      // holdings getter (which would throw) was never invoked → no failure logged.
      assert.equal(h.failures.length, 0);
    });

    it("a 403 AFTER a type already succeeded is a scope gap, NOT a dead session (MONEY-837)", async () => {
      // holdings succeed first (proves the token works), then MF 403s — e.g. the
      // Kite "MF holdings" scope not yet enabled. The connection must STAY healthy
      // (CONNECTED), not get churned into NEEDS_REAUTH by one un-entitled endpoint.
      h.rows = {
        holdings: [holdingRow("INFY")],
        mutualFunds: () => {
          throw new Error("ZERODHA API Error: 403 - Forbidden");
        },
      };
      const action = loadAction(h);
      const res = await action.syncBrokerDataAction("ZERODHA", [
        "holdings",
        "mutualFunds",
      ]);
      assert.equal(res.success, true);
      assert.equal(res.synced?.holdings, 1);
      const updates = h.prisma.callsFor("brokerConnection", "update");
      const markedReauth = updates.some(
        (u) =>
          (u.args as { data: { status?: string } }).data.status ===
          "NEEDS_REAUTH"
      );
      assert.equal(
        markedReauth,
        false,
        "MF scope-403 must not mark NEEDS_REAUTH"
      );
      const restoredConnected = updates.some(
        (u) =>
          (u.args as { data: { status?: string } }).data.status === "CONNECTED"
      );
      assert.equal(
        restoredConnected,
        true,
        "success update still restores CONNECTED"
      );
      // The MF failure is still recorded for telemetry.
      assert.equal(
        h.failures.some((f) => f.operation === "sync_mutualFunds"),
        true
      );
    });

    it("a 403 on the FIRST type (no prior success) IS a dead session → marks NEEDS_REAUTH + short-circuits (MONEY-837)", async () => {
      h.rows = {
        holdings: () => {
          throw new Error("ZERODHA API Error: 403 - Forbidden");
        },
        positions: [],
      };
      const action = loadAction(h);
      await action.syncBrokerDataAction("ZERODHA", ["holdings", "positions"]);
      // authFailed short-circuits the remaining types → positions never fetched.
      const markedReauth = h.prisma
        .callsFor("brokerConnection", "update")
        .some(
          (u) =>
            (u.args as { data: { status?: string } }).data.status ===
            "NEEDS_REAUTH"
        );
      assert.equal(
        markedReauth,
        true,
        "a 403 with no prior success = dead session"
      );
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// MONEY-839 — syncHistoricalTradesAction END-TO-END (real orchestration).
//
// Drives the REAL syncHistoricalTradesAction → syncHistoricalTradebook (shared
// @usemoney/services, re-bound to the mocked prisma + @usemoney/core/brokers via
// the same seam) through the fake client's getHistoricalTrades. Pins: the demo /
// connect / no-connection gates, the backfill → persistTrades → synced count,
// and that pairing is PUBLISHED (worker-only), not run inline.
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-839 — syncHistoricalTradesAction (worker-only pairing)", () => {
  let h: Harness;
  beforeEach(() => {
    h = baseHarness();
  });

  // A NormalizedTrade-shaped row the fake getHistoricalTrades returns (it stands
  // in for the client's already-normalized output, so persistTrades upserts it).
  function histTrade(over: Record<string, unknown> = {}) {
    return {
      tradeId: "h1",
      orderId: "o1",
      symbol: "TCS",
      tradingSymbol: "TCS",
      isin: "INE467B01029",
      exchange: "NSE",
      segment: "EQ",
      transactionType: "BUY",
      productType: "CNC",
      orderType: "MARKET",
      quantity: 5,
      price: 100,
      value: 500,
      tradeTime: new Date("2026-01-10"),
      ...over,
    };
  }

  it("demo session is refused before any work", async () => {
    h.isDemo = true;
    const mod = loadAction(h);
    const res = await mod.syncHistoricalTradesAction("ZERODHA");
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /Demo mode/);
    assert.equal(h.clientBuilt, false);
    assert.equal(h.pairingJobs.length, 0);
  });

  it("ZERODHA_CONNECT is refused (token-capture only)", async () => {
    const mod = loadAction(h);
    const res = await mod.syncHistoricalTradesAction("ZERODHA_CONNECT");
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /Connect app does not sync/);
  });

  it("no matching connection → 'Broker not connected'", async () => {
    h.prisma = new RecordingPrisma(makeUser(), null);
    const mod = loadAction(h);
    const res = await mod.syncHistoricalTradesAction("ZERODHA");
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /Broker not connected/);
    assert.equal(h.pairingJobs.length, 0);
  });

  it("happy path: getHistoricalTrades → persistTrades upserts → synced count (no pairing — MONEY-840)", async () => {
    h.rows.historicalTrades = [histTrade(), histTrade({ tradeId: "h2" })];
    const mod = loadAction(h);
    const res = await mod.syncHistoricalTradesAction(
      "ZERODHA",
      "2026-01-01",
      "2026-01-31"
    );
    assert.equal(res.success, true);
    assert.equal(res.synced, 2);
    assert.equal(h.clientBuilt, true);
    // persisted via the worker-shared persistTrades (upsert by brokerTradeId)
    assert.equal(h.prisma.callsFor("trade", "upsert").length, 2);
    // MONEY-839: pairing removed (moved to MONEY-840) — no pairing job published.
    assert.equal(h.pairingJobs.length, 0);
  });

  it("empty history → synced 0, success, and NO pairing job (nothing to pair)", async () => {
    h.rows.historicalTrades = [];
    const mod = loadAction(h);
    const res = await mod.syncHistoricalTradesAction("ZERODHA");
    assert.equal(res.success, true);
    assert.equal(res.synced, 0);
    assert.equal(h.prisma.callsFor("trade", "upsert").length, 0);
    assert.equal(h.pairingJobs.length, 0);
  });
});

describe("MONEY-840 — triggerRepairingAction (publishes a pairing job)", () => {
  let h: Harness;
  beforeEach(() => {
    h = baseHarness();
  });

  it("demo session is refused before any work", async () => {
    h.isDemo = true;
    const mod = loadAction(h);
    const res = await mod.triggerRepairingAction();
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /Demo mode/);
    assert.equal(h.pairingJobs.length, 0);
  });

  it("publishes a trade-pairing job scoped to the caller userId (worker re-pair)", async () => {
    const mod = loadAction(h);
    const res = await mod.triggerRepairingAction();
    assert.equal(res.success, true);
    // MONEY-840: pairing is back ON — exactly one pairing job published.
    assert.equal(h.pairingJobs.length, 1);
    assert.equal(h.pairingJobs[0]!.userId, h.prisma.user?.id);
    // and the worker job row is pre-created so it's pollable.
    const created = h.prisma.callsFor("backgroundJob", "create");
    assert.equal(created.length, 1);
    assert.equal(
      (created[0]!.args as { data: { jobType: string } }).data.jobType,
      "TRADE_PAIRING"
    );
  });

  it("a failed publish fails closed (success:false) and publishes no job", async () => {
    const mod = loadAction(h);
    h.failPairingPublish = true;
    const res = await mod.triggerRepairingAction();
    // The publish threw → the action returns failure (the getSafeErrorMessage
    // helper passes a benign generic message through, sanitizing only recognized
    // DB/credential patterns — same convention as syncBrokerDataAction). The
    // contract here: it fails CLOSED and never records a job.
    assert.equal(res.success, false);
    assert.ok((res.error ?? "").length > 0);
    assert.equal(h.pairingJobs.length, 0);
  });
});
