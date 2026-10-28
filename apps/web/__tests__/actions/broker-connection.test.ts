/**
 * MONEY-620 — broker-connection wrapper actions (REAL exports, de-shadowed).
 *
 * SHADOW VERDICT (previous version): SHADOW. The old file re-declared the
 * actions' logic inline — checkTrialExpiry, validateAccountName,
 * mapConnectionToInfo, calculateTokenExpiry, supportsOAuth, getRedirectUri,
 * generateDefaultAccountName, normalizeMFName, fundNameSimilarity, plus an
 * inline copy of `demoBrokerConnections` — and asserted the COPIES. It imported
 * NOTHING from `@/lib/actions/broker-connection`; the real action code never ran,
 * so the demo-gate / auth-gate / IDOR-scoping that actually protect users were
 * entirely untested. (The pure date/string helpers it copied are private to the
 * source and not independently exported — there is nothing to import for them —
 * so they are intentionally dropped here in favour of testing the real exported
 * action surface, which is where the security-relevant logic lives.)
 *
 * DE-SHADOWED. This rewrite imports & drives the REAL exported wrapper actions,
 * injecting their boundaries (Clerk auth, prisma, demo session, subscription
 * access, the `@usemoney/services` broker functions, email, cache, logger, …) at
 * the module boundary via `require.cache` — the proven
 * `broker-sync-action-e2e.test.ts` seam — so the production code path and these
 * tests execute the SAME code. `syncBrokerDataAction` already has its own e2e
 * (`broker-sync-action-e2e.test.ts`); this file covers the OTHER actions and
 * pins their OWN logic:
 *
 *   - demo-mode SHORT-CIRCUIT FIRST (before any auth/DB) on every mutating action;
 *   - the demo READ path returns the canned demo connections (not real data);
 *   - auth gate ("Authentication required" / empty list) when no user resolves;
 *   - account-name validation (empty/whitespace/>50) on updateBrokerAccountNameAction;
 *   - IDOR: getBrokerConnectionsAction forwards the CALLER's userId to the service;
 *     getBrokerDataCountsAction scopes every count to { userId }; the connection
 *     ownership check rejects a connectionId the caller does not own;
 *   - error sanitization: a thrown DB error surfaces a safe message, never the raw
 *     error text.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: apps/web/lib/actions/broker-connection.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ── recording prisma double ────────────────────────────────────────────────

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  clerkId: string | null;
  emailPreferences: unknown;
  createdAt: Date;
}

interface ConnectionRow {
  id: string;
  userId: string;
  broker: string;
  brokerUserId: string | null;
  accountName?: string | null;
}

/**
 * A recording prisma double. `user.find*` returns the configured user (so
 * getOrCreateUser resolves), `brokerConnection.findUnique/findFirst` returns the
 * configured connection (or null), counts return 0, and an optional
 * `throwOn` model.method makes that call reject (to drive the catch/sanitize
 * path). Every call is recorded for where-clause (IDOR) assertions.
 */
class RecordingPrisma {
  readonly calls: RecordedCall[] = [];
  user: UserRow | null;
  connection: ConnectionRow | null;
  connections: ConnectionRow[];
  throwOn: string | null;
  // MONEY-837: drives prisma.brokerConnection.count for the free-tier
  // single-broker gate (getBrokerGate). Default 0 = no existing brokers.
  countResult = 0;
  // MONEY-1062 (W2-B): what deletedUserAudit.findFirst returns — non-null
  // simulates an in-flight (e.g. LOCKED) account deletion so the canonical
  // getOrCreateDbUser guard resolves the user to null.
  deletedAudit: { id: string } | null = null;

  constructor(
    user: UserRow | null,
    connection: ConnectionRow | null = null,
    connections: ConnectionRow[] = []
  ) {
    this.user = user;
    this.connection = connection;
    this.connections = connections;
    this.throwOn = null;
  }

  callsFor(model: string, method: string): RecordedCall[] {
    return this.calls.filter((c) => c.model === model && c.method === method);
  }

  private maybeThrow(model: string, method: string): void {
    if (this.throwOn === `${model}.${method}`) {
      throw new Error(
        "PrismaClientKnownRequestError: connection pool timeout (raw secret-ish detail)"
      );
    }
  }

  get client(): Record<string, unknown> {
    const self = this;
    const model = (name: string) => ({
      findUnique: (args: unknown) => {
        self.calls.push({ model: name, method: "findUnique", args });
        self.maybeThrow(name, "findUnique");
        if (name === "user") return Promise.resolve(self.user);
        if (name === "brokerConnection")
          return Promise.resolve(self.connection);
        return Promise.resolve(null);
      },
      findFirst: (args: unknown) => {
        self.calls.push({ model: name, method: "findFirst", args });
        self.maybeThrow(name, "findFirst");
        if (name === "brokerConnection")
          return Promise.resolve(self.connection);
        if (name === "deletedUserAudit")
          return Promise.resolve(self.deletedAudit);
        return Promise.resolve(null);
      },
      findMany: (args: unknown) => {
        self.calls.push({ model: name, method: "findMany", args });
        self.maybeThrow(name, "findMany");
        if (name === "brokerConnection")
          return Promise.resolve(self.connections);
        return Promise.resolve([]);
      },
      update: (args: unknown) => {
        self.calls.push({ model: name, method: "update", args });
        self.maybeThrow(name, "update");
        if (name === "user") return Promise.resolve(self.user);
        return Promise.resolve({});
      },
      create: (args: unknown) => {
        self.calls.push({ model: name, method: "create", args });
        self.maybeThrow(name, "create");
        if (name === "user") return Promise.resolve(self.user);
        return Promise.resolve({});
      },
      deleteMany: (args: unknown) => {
        self.calls.push({ model: name, method: "deleteMany", args });
        self.maybeThrow(name, "deleteMany");
        return Promise.resolve({ count: 0 });
      },
      count: (args: unknown) => {
        self.calls.push({ model: name, method: "count", args });
        self.maybeThrow(name, "count");
        return Promise.resolve(self.countResult);
      },
    });
    return new Proxy(
      {},
      {
        get(target: Record<string, unknown>, prop: string) {
          if (typeof prop !== "string") return undefined;
          if (!(prop in target)) target[prop] = model(prop);
          return target[prop];
        },
      }
    );
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

interface Harness {
  prisma: RecordingPrisma;
  authUserId: string | null;
  authEmail: string | null;
  isDemo: boolean;
  planId: string;
  // When true, getBrokerEnvKeys returns no apiKey (drives the "not available
  // yet" branch of getOAuthUrlAction).
  noApiKey: boolean;
  revalidated: string[];
  failures: Array<{ operation: string }>;
  // What the @usemoney/services broker functions should return / record.
  service: {
    getConnectionsCalledWith: string[];
    getConnectionsResult: {
      success: boolean;
      data?: unknown[];
      error?: string;
    };
    deleteCalledWith: Array<{ userId: string; connectionId: string }>;
    deleteResult: { success: boolean; error?: string };
  };
  // MONEY-837: captures storeReauthIntent calls (re-auth → specific connection).
  reauthStored: Array<{
    userId: string;
    broker: string;
    intent: { connectionId: string; expectedBrokerUserId: string };
  }>;
  oauthUrlResult: { success: boolean; url?: string; error?: string };
}

interface ActionModule {
  getOAuthUrlAction: (
    broker: string,
    connectionId?: string
  ) => Promise<{ success: boolean; url?: string; error?: string }>;
  handleOAuthCallbackAction: (
    broker: string,
    code: string,
    state?: string
  ) => Promise<{ success: boolean; error?: string }>;
  updateBrokerAccountNameAction: (
    connectionId: string,
    accountName: string
  ) => Promise<{ success: boolean; error?: string }>;
  connectWithApiKeyAction: (
    broker: string,
    clientId: string,
    accessToken: string
  ) => Promise<{ success: boolean; error?: string }>;
  getBrokerConnectionsAction: (opts?: {
    includeConnectOnly?: boolean;
  }) => Promise<{
    success: boolean;
    data?: unknown[];
    error?: string;
  }>;
  getBrokerDataCountsAction: (
    broker: string,
    connectionId?: string
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>;
  disconnectBrokerAction: (
    broker: string,
    connectionId?: string
  ) => Promise<{ success: boolean; error?: string }>;
}

const ACTION_REL = "../../lib/actions/broker-connection";

const DEMO_CONNECTIONS = [
  {
    id: "broker-1",
    broker: "ZERODHA",
    brokerUserId: "AB1234",
    status: "CONNECTED",
  },
  {
    id: "broker-2",
    broker: "GROWW",
    brokerUserId: "GR5678",
    status: "CONNECTED",
  },
  {
    id: "broker-3",
    broker: "DHAN",
    brokerUserId: "DH9012",
    status: "CONNECTED",
  },
];

function loadAction(h: Harness): ActionModule {
  const cache = moduleCache();
  const resolve = (p: string) => require.resolve(p);

  cache[resolve("@clerk/nextjs/server")] = {
    exports: {
      __esModule: true,
      auth: () => Promise.resolve({ userId: h.authUserId }),
      currentUser: () =>
        Promise.resolve(
          h.authUserId && h.authEmail
            ? {
                emailAddresses: [{ emailAddress: h.authEmail }],
                fullName: "Broker Tester",
                firstName: "Broker",
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

  // getAuthenticatedUser (React cache() at module load) — used by
  // getBrokerConnectionsAction & disconnectBrokerAction. Resolves to the
  // configured user's id (or null) so the IDOR-forwarding can be asserted.
  cache[resolve("@/lib/auth")] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: () =>
        Promise.resolve(
          h.authUserId && h.prisma.user ? { userId: h.prisma.user.id } : null
        ),
    },
  };

  cache[resolve("@/lib/demo/session")] = {
    exports: {
      __esModule: true,
      isDemoSession: () => Promise.resolve(h.isDemo),
      COOKIE_NAME: "sb_demo",
    },
  };
  cache[resolve("@/lib/demo/data")] = {
    exports: { __esModule: true, demoBrokerConnections: DEMO_CONNECTIONS },
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
  // MONEY-1062 (W2-B): broker-connection.ts now imports encryption from the
  // /encryption subpath — alias it to the same stub.
  cache[resolve("@usemoney/security/encryption")] =
    cache[resolve("@usemoney/security")];

  cache[resolve("@usemoney/core/brokers/oauth-state")] = {
    exports: {
      __esModule: true,
      generateOAuthState: async () => "csrf-state-token",
      verifyOAuthState: async () => true,
      // MONEY-837: re-auth intent (binds a re-auth to a specific connection).
      storeReauthIntent: async (
        userId: string,
        broker: string,
        intent: { connectionId: string; expectedBrokerUserId: string }
      ) => {
        h.reauthStored.push({ userId, broker, intent });
      },
      consumeReauthIntent: async () => null,
    },
  };

  // @usemoney/core — config/cache helpers. envKeys.apiKey present so the
  // getOAuthUrlAction "not configured" branch is OFF by default.
  cache[resolve("@usemoney/core")] = {
    exports: new Proxy(
      { __esModule: true },
      {
        get(_t, k: string) {
          if (k === "__esModule") return true;
          if (k === "getBrokerConfig")
            return () => ({ name: "Broker", envKeys: { apiKey: "ZK" } });
          if (k === "getBrokerEnvKeys")
            return () =>
              h.noApiKey
                ? {}
                : { apiKey: "ZK", apiSecret: "ZS", redirectUri: "" };
          if (k === "getCached") return async () => null;
          if (k === "getSegmentLabel" || k === "getProductTypeLabel")
            return (x: string) => x;
          return async () => {};
        },
      }
    ),
  };

  cache[resolve("@/lib/brokers/clients")] = {
    exports: {
      __esModule: true,
      createBrokerClient: () => ({
        getProfile: async () => ({ userId: "x" }),
        getHoldings: async () => [],
        getPositions: async () => [],
        getTrades: async () => [],
        getMutualFunds: async () => [],
      }),
      ZerodhaClient: class {},
      UpstoxClient: class {},
      FyersClient: class {},
      IciciClient: class {},
      HdfcClient: class {},
      InteractiveBrokersClient: class {},
    },
  };

  cache[resolve("@/lib/brokers/oauth-url")] = {
    exports: {
      __esModule: true,
      buildBrokerOAuthUrl: () => h.oauthUrlResult,
    },
  };

  cache[resolve("@/lib/subscription/access")] = {
    exports: {
      __esModule: true,
      getSubscriptionAccess: async () => ({ planId: h.planId }),
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
  cache[resolve("@/lib/brokers/known-errors")] = {
    exports: { __esModule: true, mapKnownBrokerError: () => null },
  };
  cache[resolve("@/lib/db/notifications")] = {
    exports: { __esModule: true, createNotification: async () => {} },
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
  cache[resolve("@/lib/pairing/service")] = {
    exports: { __esModule: true, pairUserTrades: async () => ({}) },
  };

  // The @usemoney/services broker functions used by the read/disconnect actions.
  cache[resolve("@usemoney/services")] = {
    exports: {
      __esModule: true,
      getBrokerConnections: (userId: string) => {
        h.service.getConnectionsCalledWith.push(userId);
        return Promise.resolve(h.service.getConnectionsResult);
      },
      deleteBrokerConnection: (userId: string, connectionId: string) => {
        h.service.deleteCalledWith.push({ userId, connectionId });
        return Promise.resolve(h.service.deleteResult);
      },
      getBrokerSyncStatus: async () => ({}),
      getLastSyncTime: async () => null,
      // MONEY-1062 (W2-B): the shared upsert (contract-tested in
      // @usemoney/services). This suite only drives connectWithApiKeyAction in
      // demo mode / the deletion-guard path, so it never reaches the call — a
      // benign success stub keeps the import defined.
      persistBrokerConnection: async () => ({
        success: true,
        data: {
          connection: { id: "conn-new" },
          wasReconnect: false,
          previousAccountName: null,
        },
      }),
    },
  };

  cache[resolve("@usemoney/email")] = {
    exports: {
      __esModule: true,
      sendEmail: () => Promise.resolve({ success: true }),
      getEffectivePreferences: () => ({}),
      shouldSendEmail: () => false,
      buildUnsubscribeUrl: () => "https://usemoney.ai/unsub",
      moveContactToSegment: async () => {},
    },
  };
  cache[resolve("@usemoney/email/templates")] = {
    exports: {
      __esModule: true,
      BrokerConnectedEmail: () => null,
      BrokerDisconnectedEmail: () => null,
      SyncCompleteEmail: () => null,
    },
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

  // MONEY-1062 (W2-B): getOrCreateUser now delegates to the canonical
  // getOrCreateDbUser (@/lib/db/user), which keeps a module-level 5-min user
  // cache. Purge it each load so a resolved user can't leak across tests and the
  // deletion-guard path stays deterministic.
  delete cache[resolve("@/lib/db/user")];
  delete cache[resolve(ACTION_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as ActionModule;
}

function makeUser(over: Partial<UserRow> = {}): UserRow {
  return {
    id: "user-1",
    email: "broker@example.com",
    name: "Broker Tester",
    clerkId: "clerk_abc",
    emailPreferences: null,
    createdAt: new Date(),
    ...over,
  };
}

function baseHarness(): Harness {
  return {
    prisma: new RecordingPrisma(makeUser()),
    authUserId: "clerk_abc",
    authEmail: "broker@example.com",
    isDemo: false,
    planId: "PRO",
    noApiKey: false,
    revalidated: [],
    failures: [],
    reauthStored: [],
    service: {
      getConnectionsCalledWith: [],
      getConnectionsResult: { success: true, data: [] },
      deleteCalledWith: [],
      deleteResult: { success: true },
    },
    oauthUrlResult: {
      success: true,
      url: "https://kite.zerodha.com/connect/login?api_key=ZK",
    },
  };
}

function clearActionCache(): void {
  const cache = moduleCache();
  delete cache[require.resolve(ACTION_REL)];
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("MONEY-620 — broker-connection wrapper actions (real exports, mocked I/O)", () => {
  let h: Harness;

  beforeEach(() => {
    h = baseHarness();
  });

  afterEach(() => {
    clearActionCache();
  });

  describe("demo-mode short-circuit (before any auth/DB)", () => {
    it("getOAuthUrlAction refuses in demo mode with a sign-up nudge", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.getOAuthUrlAction("ZERODHA");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.prisma.calls.length, 0, "no DB touched in demo mode");
    });

    it("handleOAuthCallbackAction refuses in demo mode before token exchange", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.handleOAuthCallbackAction(
        "ZERODHA",
        "code",
        "state"
      );
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.prisma.calls.length, 0);
    });

    it("connectWithApiKeyAction refuses in demo mode", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.connectWithApiKeyAction("DHAN", "CID", "TOKEN");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.prisma.calls.length, 0);
    });

    it("updateBrokerAccountNameAction refuses in demo mode", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.updateBrokerAccountNameAction("conn-1", "Name");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.prisma.calls.length, 0);
    });

    it("disconnectBrokerAction refuses in demo mode", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.disconnectBrokerAction("ZERODHA");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.service.deleteCalledWith.length, 0);
    });
  });

  describe("demo READ path returns canned demo data (not real)", () => {
    it("getBrokerConnectionsAction returns the demo connections, no service call", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.getBrokerConnectionsAction();
      assert.equal(res.success, true);
      assert.equal(res.data?.length, 3);
      const ids = (res.data as Array<{ id: string }>).map((c) => c.id);
      assert.deepEqual(ids, ["broker-1", "broker-2", "broker-3"]);
      // The real broker-connections SERVICE must NOT be queried in demo mode.
      assert.equal(h.service.getConnectionsCalledWith.length, 0);
      assert.equal(h.prisma.calls.length, 0);
    });
  });

  describe("auth gate", () => {
    it("getOAuthUrlAction → 'Authentication required' when no user resolves", async () => {
      h.authUserId = null;
      const action = loadAction(h);
      const res = await action.getOAuthUrlAction("ZERODHA");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Authentication required/);
    });

    it("updateBrokerAccountNameAction → 'Authentication required' with no user", async () => {
      h.authUserId = null;
      const action = loadAction(h);
      const res = await action.updateBrokerAccountNameAction("conn-1", "Name");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Authentication required/);
    });

    it("getBrokerConnectionsAction returns an EMPTY list (not an error) when unauthenticated", async () => {
      h.authUserId = null;
      const action = loadAction(h);
      const res = await action.getBrokerConnectionsAction();
      assert.equal(res.success, true);
      assert.deepEqual(res.data, []);
      assert.equal(h.service.getConnectionsCalledWith.length, 0);
    });

    it("disconnectBrokerAction → 'Authentication required' with no user", async () => {
      h.authUserId = null;
      const action = loadAction(h);
      const res = await action.disconnectBrokerAction("ZERODHA");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Authentication required/);
      assert.equal(h.service.deleteCalledWith.length, 0);
    });

    it("getBrokerDataCountsAction → 'Authentication required' with no user", async () => {
      h.authUserId = null;
      const action = loadAction(h);
      const res = await action.getBrokerDataCountsAction("ZERODHA");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Authentication required/);
    });
  });

  // MONEY-1062 (W2-B) regression: the broker path now delegates user resolution
  // to the canonical getOrCreateDbUser, which guards on PENDING/PROCESSING AND
  // LOCKED deletion states. The old inline copy checked only PENDING/PROCESSING,
  // so a LOCKED-deletion user (mid-purge) could be RESURRECTED. Assert the path
  // now resolves such a user to null (auth-required) and creates no row.
  describe("deletion guard (LOCKED) — user resolves to null, never resurrected", () => {
    it("connectWithApiKeyAction refuses a LOCKED-deletion user and creates no user row", async () => {
      // The user row is already gone; a deletion audit sits in the LOCKED state.
      h.prisma = new RecordingPrisma(null);
      h.prisma.deletedAudit = { id: "audit-locked" };
      h.authUserId = "clerk_locked_user";
      h.authEmail = "locked@example.com";
      const action = loadAction(h);
      const res = await action.connectWithApiKeyAction("DHAN", "CID", "TOKEN");

      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Authentication required/);

      // The canonical guard consulted the LOCKED state (the fix)...
      const auditCalls = h.prisma.callsFor("deletedUserAudit", "findFirst");
      assert.equal(auditCalls.length, 1, "the deletion guard must run");
      const where = (
        auditCalls[0].args as { where: { status: { in: string[] } } }
      ).where;
      assert.ok(
        where.status.in.includes("LOCKED"),
        "guard must treat LOCKED as in-flight (the old inline copy did not)"
      );

      // ...and it did NOT resurrect the user row.
      assert.equal(h.prisma.callsFor("user", "create").length, 0);
    });
  });

  describe("updateBrokerAccountNameAction — name validation (own logic)", () => {
    it("rejects an empty name", async () => {
      const action = loadAction(h);
      const res = await action.updateBrokerAccountNameAction("conn-1", "");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /cannot be empty/);
    });

    it("rejects a whitespace-only name", async () => {
      const action = loadAction(h);
      const res = await action.updateBrokerAccountNameAction("conn-1", "   ");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /cannot be empty/);
    });

    it("rejects a name over 50 characters", async () => {
      const action = loadAction(h);
      const res = await action.updateBrokerAccountNameAction(
        "conn-1",
        "a".repeat(51)
      );
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /50 characters or less/);
    });

    it("accepts a valid name and trims it before persisting", async () => {
      h.prisma = new RecordingPrisma(makeUser(), {
        id: "conn-1",
        userId: "user-1",
        broker: "ZERODHA",
        brokerUserId: "AB1234",
      });
      const action = loadAction(h);
      const res = await action.updateBrokerAccountNameAction(
        "conn-1",
        "  My Zerodha  "
      );
      assert.equal(res.success, true);
      const upd = h.prisma.callsFor("brokerConnection", "update")[0];
      assert.ok(upd, "expected a brokerConnection.update");
      const data = (upd!.args as { data: { accountName: string } }).data;
      assert.equal(data.accountName, "My Zerodha", "name must be trimmed");
    });
  });

  describe("updateBrokerAccountNameAction — ownership / IDOR", () => {
    it("rejects updating a connection the caller does not own", async () => {
      // Connection exists but belongs to a DIFFERENT user.
      h.prisma = new RecordingPrisma(makeUser({ id: "user-1" }), {
        id: "conn-x",
        userId: "someone-else",
        broker: "ZERODHA",
        brokerUserId: "AB1234",
      });
      const action = loadAction(h);
      const res = await action.updateBrokerAccountNameAction("conn-x", "Mine");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not found or unauthorized/);
      // CRITICAL: no update was issued for a non-owned connection.
      assert.equal(h.prisma.callsFor("brokerConnection", "update").length, 0);
    });

    it("rejects when the connection does not exist", async () => {
      h.prisma = new RecordingPrisma(makeUser(), null);
      const action = loadAction(h);
      const res = await action.updateBrokerAccountNameAction("missing", "Name");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not found or unauthorized/);
      assert.equal(h.prisma.callsFor("brokerConnection", "update").length, 0);
    });
  });

  describe("getBrokerConnectionsAction — IDOR (caller's userId forwarded)", () => {
    it("forwards the CALLER's userId to the service and returns its data", async () => {
      h.prisma = new RecordingPrisma(makeUser({ id: "user-777" }));
      h.service.getConnectionsResult = {
        success: true,
        data: [{ id: "c1", broker: "ZERODHA" }],
      };
      const action = loadAction(h);
      const res = await action.getBrokerConnectionsAction();
      assert.equal(res.success, true);
      assert.equal(res.data?.length, 1);
      // The service was queried for THIS user only — never a different id.
      assert.deepEqual(h.service.getConnectionsCalledWith, ["user-777"]);
    });

    it("surfaces a service failure", async () => {
      h.service.getConnectionsResult = {
        success: false,
        error: "service boom",
      };
      const action = loadAction(h);
      const res = await action.getBrokerConnectionsAction();
      assert.equal(res.success, false);
      assert.equal(res.error, "service boom");
    });
  });

  describe("getBrokerDataCountsAction — IDOR scoping", () => {
    it("scopes every count to the caller's userId (no connectionId)", async () => {
      h.prisma = new RecordingPrisma(makeUser({ id: "user-1" }));
      const action = loadAction(h);
      const res = await action.getBrokerDataCountsAction("ZERODHA");
      assert.equal(res.success, true);
      const counts = h.prisma.calls.filter((c) => c.method === "count");
      assert.ok(counts.length > 0, "expected count() queries");
      for (const c of counts) {
        const where = (c.args as { where: Record<string, unknown> }).where;
        assert.equal(
          where.userId,
          "user-1",
          `${c.model}.count must scope userId`
        );
        assert.equal(where.broker, "ZERODHA");
      }
    });

    it("rejects a connectionId that belongs to another user (ownership check)", async () => {
      h.prisma = new RecordingPrisma(makeUser({ id: "user-1" }), {
        id: "conn-y",
        userId: "intruder-target",
        broker: "ZERODHA",
        brokerUserId: "AB1234",
      });
      const action = loadAction(h);
      const res = await action.getBrokerDataCountsAction("ZERODHA", "conn-y");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Connection not found/);
      // No counts run once the ownership check fails.
      assert.equal(
        h.prisma.calls.filter((c) => c.method === "count").length,
        0
      );
    });

    it("rejects a connectionId whose broker does not match", async () => {
      h.prisma = new RecordingPrisma(makeUser({ id: "user-1" }), {
        id: "conn-z",
        userId: "user-1",
        broker: "UPSTOX", // mismatched broker
        brokerUserId: "UP1",
      });
      const action = loadAction(h);
      const res = await action.getBrokerDataCountsAction("ZERODHA", "conn-z");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Connection not found/);
    });
  });

  describe("disconnectBrokerAction — IDOR (caller scope) + delegation", () => {
    it("deletes a specific connection via the service scoped to the caller's userId", async () => {
      h.prisma = new RecordingPrisma(makeUser({ id: "user-9" }));
      const action = loadAction(h);
      const res = await action.disconnectBrokerAction("ZERODHA", "conn-1");
      assert.equal(res.success, true);
      assert.deepEqual(h.service.deleteCalledWith, [
        { userId: "user-9", connectionId: "conn-1" },
      ]);
    });

    it("bulk disconnect deletes each connection of the broker, scoped to the user", async () => {
      h.prisma = new RecordingPrisma(makeUser({ id: "user-9" }), null, [
        { id: "c1", userId: "user-9", broker: "ZERODHA", brokerUserId: "A" },
        { id: "c2", userId: "user-9", broker: "ZERODHA", brokerUserId: "B" },
      ]);
      const action = loadAction(h);
      const res = await action.disconnectBrokerAction("ZERODHA");
      assert.equal(res.success, true);
      // Each connection deleted via the (userId-scoped) service.
      assert.equal(h.service.deleteCalledWith.length, 2);
      for (const d of h.service.deleteCalledWith) {
        assert.equal(d.userId, "user-9");
      }
      // The bulk findMany was scoped to { userId, broker }.
      const find = h.prisma.callsFor("brokerConnection", "findMany")[0];
      const where = (find!.args as { where: Record<string, unknown> }).where;
      assert.equal(where.userId, "user-9");
      assert.equal(where.broker, "ZERODHA");
    });

    it("surfaces a service delete failure for a specific connection", async () => {
      h.service.deleteResult = { success: false, error: "cannot delete" };
      const action = loadAction(h);
      const res = await action.disconnectBrokerAction("ZERODHA", "conn-1");
      assert.equal(res.success, false);
      assert.equal(res.error, "cannot delete");
    });
  });

  describe("getOAuthUrlAction — config + delegation", () => {
    it("returns 'not available yet' when the broker API key is missing", async () => {
      h.noApiKey = true; // getBrokerEnvKeys() returns no apiKey
      const action = loadAction(h);
      const res = await action.getOAuthUrlAction("ZERODHA");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not available yet/);
    });

    it("returns the built OAuth URL from the helper on the happy path", async () => {
      const action = loadAction(h);
      const res = await action.getOAuthUrlAction("ZERODHA");
      assert.equal(res.success, true);
      assert.match(res.url ?? "", /kite\.zerodha\.com/);
    });
  });

  describe("getOAuthUrlAction — free-tier broker gate (MONEY-837)", () => {
    it("blocks a NEW connect for a FREE user who already has one broker", async () => {
      h.planId = "FREE";
      h.prisma.countResult = 1; // one non-Connect broker already connected
      const action = loadAction(h);
      const res = await action.getOAuthUrlAction("UPSTOX");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Free plan includes one broker|Upgrade/);
    });

    it("ALLOWS re-auth (connectionId) at the limit and binds the intent to that account", async () => {
      h.planId = "FREE";
      h.prisma.countResult = 1; // at the single-broker limit…
      // …but re-auth targets a SPECIFIC existing connection.
      h.prisma.connection = {
        id: "conn-1",
        userId: "user-1",
        broker: "ZERODHA",
        brokerUserId: "KP9460",
      };
      const action = loadAction(h);
      const res = await action.getOAuthUrlAction("ZERODHA", "conn-1");
      assert.equal(
        res.success,
        true,
        "re-auth must bypass the new-connect limit"
      );
      // The re-auth is pinned to the right account → callback can reject a
      // wrong-account login instead of silently rewriting the other connection.
      assert.equal(h.reauthStored.length, 1);
      assert.equal(h.reauthStored[0]?.intent.connectionId, "conn-1");
      assert.equal(h.reauthStored[0]?.intent.expectedBrokerUserId, "KP9460");
    });

    it("blocks all connect/re-auth for a FREE user past the 30-day trial", async () => {
      h.planId = "FREE";
      h.prisma = new RecordingPrisma(
        makeUser({ id: "user-1", createdAt: new Date("2020-01-01T00:00:00Z") })
      );
      const action = loadAction(h);
      const res = await action.getOAuthUrlAction("ZERODHA");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /trial has ended|Upgrade/);
    });

    it("never gates a PAID plan, even with several brokers connected", async () => {
      h.planId = "PRO";
      h.prisma.countResult = 5;
      const action = loadAction(h);
      const res = await action.getOAuthUrlAction("UPSTOX");
      assert.equal(res.success, true);
      assert.match(res.url ?? "", /kite\.zerodha\.com/);
    });
  });

  describe("getBrokerConnectionsAction — hides founder-only ZERODHA_CONNECT (MONEY-837)", () => {
    const MIXED = [
      {
        id: "c1",
        broker: "ZERODHA",
        brokerUserId: "AB1234",
        status: "CONNECTED",
      },
      {
        id: "c2",
        broker: "ZERODHA_CONNECT",
        brokerUserId: "KP9460",
        status: "CONNECTED",
      },
    ];

    it("default-excludes ZERODHA_CONNECT from the returned list", async () => {
      h.service.getConnectionsResult = { success: true, data: MIXED };
      const action = loadAction(h);
      const res = await action.getBrokerConnectionsAction();
      assert.equal(res.success, true);
      const brokers = (res.data as Array<{ broker: string }>).map(
        (c) => c.broker
      );
      assert.deepEqual(brokers, ["ZERODHA"]);
    });

    it("includeConnectOnly:true keeps ZERODHA_CONNECT (brokers management page)", async () => {
      h.service.getConnectionsResult = { success: true, data: MIXED };
      const action = loadAction(h);
      const res = await action.getBrokerConnectionsAction({
        includeConnectOnly: true,
      });
      assert.equal(res.success, true);
      const brokers = (res.data as Array<{ broker: string }>)
        .map((c) => c.broker)
        .sort();
      assert.deepEqual(brokers, ["ZERODHA", "ZERODHA_CONNECT"]);
    });
  });

  describe("error sanitization (raw DB error never leaks)", () => {
    it("updateBrokerAccountNameAction surfaces a SAFE message when prisma throws", async () => {
      h.prisma = new RecordingPrisma(makeUser(), {
        id: "conn-1",
        userId: "user-1",
        broker: "ZERODHA",
        brokerUserId: "AB1234",
      });
      h.prisma.throwOn = "brokerConnection.update";
      const action = loadAction(h);
      const res = await action.updateBrokerAccountNameAction("conn-1", "Name");
      assert.equal(res.success, false);
      assert.ok(res.error, "expected an error message");
      // The raw Prisma/secret detail must NOT be exposed to the user.
      assert.doesNotMatch(
        res.error!,
        /PrismaClient|connection pool|secret-ish/
      );
    });

    it("getBrokerDataCountsAction surfaces a generic message when a count throws", async () => {
      h.prisma = new RecordingPrisma(makeUser({ id: "user-1" }));
      h.prisma.throwOn = "holding.count";
      const action = loadAction(h);
      const res = await action.getBrokerDataCountsAction("ZERODHA");
      assert.equal(res.success, false);
      assert.doesNotMatch(
        res.error ?? "",
        /PrismaClient|connection pool|secret-ish/
      );
    });
  });

  describe("handleOAuthCallbackAction — trial gate (FREE) own logic", () => {
    it("rejects a FREE user whose 30-day trial has expired (no token exchange)", async () => {
      h.planId = "FREE";
      // User created 31 days ago → trial expired.
      h.prisma = new RecordingPrisma(
        makeUser({
          id: "user-1",
          createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        })
      );
      const action = loadAction(h);
      const res = await action.handleOAuthCallbackAction(
        "ZERODHA",
        "code",
        "state"
      );
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /trial has expired/i);
      // A broker failure for the trial-expired path was recorded.
      assert.equal(
        h.failures.some((f) => f.operation === "oauth_callback_trial_expired"),
        true
      );
    });
  });
});
