/**
 * MONEY-620 — broker-connection EDGE CASES (REAL exports, de-shadowed).
 *
 * SHADOW VERDICT (previous version): SHADOW. The old file re-declared the logic
 * inline — checkTrialExpiry, calculateTokenExpiry, validateAccountName,
 * generateDefaultAccountName, simulateEncrypt, mapConnectionToInfo,
 * findExistingConnection, validateApiKeyCredentials — and asserted the COPIES.
 * It imported NOTHING from `@/lib/actions/broker-connection`; several "tests"
 * even asserted a literal string against itself (e.g. the Dhan error message),
 * proving nothing about the real code. The security-critical paths (OAuth CSRF
 * state, encryption-failure-before-DB-write, API-key validation fallback,
 * duplicate-connection reconnect) ran zero real code.
 *
 * DE-SHADOWED. This rewrite imports & drives the REAL exported actions through
 * the `require.cache` module-boundary seam (the proven
 * `broker-sync-action-e2e.test.ts` pattern) and pins the edge behaviors that
 * actually protect users:
 *
 *   - [SECURITY] handleOAuthCallbackAction REJECTS a callback with NO state
 *     (MONEY-592 secure-by-default), and a state MISMATCH, recording the right
 *     broker-failure operation — before any token exchange or DB write;
 *   - the break-glass OAUTH_STATE_ALLOW_MISSING=1 lets a missing-state callback
 *     proceed (migration escape hatch) — proving the gate reads that env, not a
 *     hardcoded constant;
 *   - the default switch branch rejects an unsupported broker (GROWW) with a safe
 *     message — no token exchange attempted;
 *   - [SECURITY] when encryption.encrypt() THROWS, NO broker connection is
 *     created/updated (credentials never persisted in plaintext) and a safe
 *     error is returned;
 *   - connectWithApiKeyAction validation FALLBACK: getProfile→getHoldings→fail;
 *     when both throw, credentials are rejected and no connection is written;
 *   - duplicate/reconnect: an existing connection triggers UPDATE (reset to
 *     CONNECTED, attempts→0, errorMessage→null), a new one triggers CREATE;
 *   - the connection lookup for reconnect is scoped to { userId, broker,
 *     brokerUserId } (a different user's same-id account is never matched).
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
}

class RecordingPrisma {
  readonly calls: RecordedCall[] = [];
  user: UserRow | null;
  existingConnection: ConnectionRow | null;

  constructor(
    user: UserRow | null,
    existingConnection: ConnectionRow | null = null
  ) {
    this.user = user;
    this.existingConnection = existingConnection;
  }

  callsFor(model: string, method: string): RecordedCall[] {
    return this.calls.filter((c) => c.model === model && c.method === method);
  }

  get client(): Record<string, unknown> {
    const self = this;
    const model = (name: string) => ({
      findUnique: (args: unknown) => {
        self.calls.push({ model: name, method: "findUnique", args });
        if (name === "user") return Promise.resolve(self.user);
        return Promise.resolve(null);
      },
      findFirst: (args: unknown) => {
        self.calls.push({ model: name, method: "findFirst", args });
        if (name === "brokerConnection")
          return Promise.resolve(self.existingConnection);
        if (name === "deletedUserAudit") return Promise.resolve(null);
        return Promise.resolve(null);
      },
      update: (args: unknown) => {
        self.calls.push({ model: name, method: "update", args });
        if (name === "user") return Promise.resolve(self.user);
        return Promise.resolve({});
      },
      create: (args: unknown) => {
        self.calls.push({ model: name, method: "create", args });
        if (name === "user") return Promise.resolve(self.user);
        return Promise.resolve({});
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
  verifyStateOk: boolean;
  reauthIntent: { connectionId: string; expectedBrokerUserId: string } | null;
  encryptThrows: boolean;
  revalidated: string[];
  failures: Array<{ operation: string }>;
  // connectWithApiKeyAction client behavior.
  profileThrows: boolean;
  holdingsThrows: boolean;
  apiClientCalls: string[];
  // MONEY-1062 (W2-B): records persistBrokerConnection invocations. The upsert
  // moved to @usemoney/services (contract-tested there); here we assert the
  // action DELEGATES to it (and only after validation / gates pass).
  persistCalls: Array<{ broker: string; brokerUserId?: string | null }>;
}

interface ActionModule {
  handleOAuthCallbackAction: (
    broker: string,
    code: string,
    state?: string
  ) => Promise<{ success: boolean; error?: string }>;
  connectWithApiKeyAction: (
    broker: string,
    clientId: string,
    accessToken: string
  ) => Promise<{ success: boolean; error?: string }>;
}

const ACTION_REL = "../../lib/actions/broker-connection";

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
                fullName: "Edge Tester",
                firstName: "Edge",
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
    exports: { __esModule: true, demoBrokerConnections: [] },
  };

  cache[resolve("@usemoney/security")] = {
    exports: {
      __esModule: true,
      encryption: {
        decrypt: () => ({ accessToken: "decrypted-token" }),
        encrypt: () => {
          if (h.encryptThrows) {
            throw new Error("Encryption failed: Invalid key length");
          }
          return { encrypted: "x", iv: "y", authTag: "z" };
        },
      },
    },
  };
  // MONEY-1062 (W2-B): broker-connection.ts + persistBrokerConnection now import
  // from the /encryption subpath — alias it to the SAME stub so the encrypt gate
  // (incl. h.encryptThrows) still routes through the harness.
  cache[resolve("@usemoney/security/encryption")] =
    cache[resolve("@usemoney/security")];

  cache[resolve("@usemoney/core/brokers/oauth-state")] = {
    exports: {
      __esModule: true,
      generateOAuthState: async () => "csrf-state-token",
      verifyOAuthState: async () => h.verifyStateOk,
      // MONEY-837: the callback consumes a re-auth intent (null = a plain
      // connect/re-auth with no specific-account expectation → no rejection).
      consumeReauthIntent: async () => h.reauthIntent ?? null,
      storeReauthIntent: async () => {},
    },
  };

  cache[resolve("@usemoney/core")] = {
    exports: new Proxy(
      { __esModule: true },
      {
        get(_t, k: string) {
          if (k === "__esModule") return true;
          if (k === "getBrokerConfig")
            return () => ({ name: "Broker", envKeys: { apiKey: "ZK" } });
          if (k === "getBrokerEnvKeys")
            return () => ({ apiKey: "ZK", apiSecret: "ZS", redirectUri: "" });
          if (k === "getCached") return async () => null;
          if (k === "getSegmentLabel" || k === "getProductTypeLabel")
            return (x: string) => x;
          return async () => {};
        },
      }
    ),
  };

  // Broker clients. Static exchangeToken on ZerodhaClient (used by the ZERODHA
  // callback branch). createBrokerClient → a fake client whose getProfile /
  // getHoldings throw per the harness (for the api-key validation fallback).
  cache[resolve("@/lib/brokers/clients")] = {
    exports: {
      __esModule: true,
      createBrokerClient: () => ({
        getProfile: async () => {
          h.apiClientCalls.push("getProfile");
          if (h.profileThrows) throw new Error("Profile API not available");
          return { userId: "x" };
        },
        getHoldings: async () => {
          h.apiClientCalls.push("getHoldings");
          if (h.holdingsThrows) throw new Error("401 Unauthorized");
          return [];
        },
        getPositions: async () => [],
        getTrades: async () => [],
        getMutualFunds: async () => [],
      }),
      ZerodhaClient: class {
        static async exchangeToken() {
          return { accessToken: "ZTOKEN", userId: "ZUID" };
        }
      },
      UpstoxClient: class {
        static async exchangeToken() {
          return { accessToken: "UTOK", refreshToken: "URT", expiresIn: 3600 };
        }
      },
      FyersClient: class {
        static async exchangeToken() {
          return { accessToken: "FTOK", refreshToken: "FRT" };
        }
      },
      IciciClient: class {
        static async exchangeToken() {
          return { accessToken: "ITOK", userId: "IUID" };
        }
      },
      HdfcClient: class {
        static async exchangeToken() {
          return { accessToken: "HTOK", refreshToken: "HRT", userId: "HUID" };
        }
      },
      InteractiveBrokersClient: class {
        static async exchangeToken() {
          return {
            accessToken: "IBTOK",
            refreshToken: "IBRT",
            expiresIn: 3600,
          };
        }
      },
    },
  };

  cache[resolve("@/lib/brokers/oauth-url")] = {
    exports: {
      __esModule: true,
      buildBrokerOAuthUrl: () => ({ success: true, url: "https://x" }),
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
  cache[resolve("@usemoney/services")] = {
    exports: {
      __esModule: true,
      getBrokerConnections: async () => ({ success: true, data: [] }),
      deleteBrokerConnection: async () => ({ success: true }),
      getBrokerSyncStatus: async () => ({}),
      getLastSyncTime: async () => null,
      // MONEY-1062 (W2-B): the shared upsert. It routes the encrypt through the
      // injected deps (so the encrypt-failure path is still observable) and
      // records the call so the action's delegation can be asserted.
      persistBrokerConnection: async (
        input: {
          broker: string;
          brokerUserId?: string | null;
          credentials: object;
        },
        deps?: { encryption?: { encrypt: (d: object) => unknown } }
      ) => {
        try {
          deps?.encryption?.encrypt(input.credentials);
        } catch {
          return {
            success: false,
            error: "Failed to persist broker connection",
          };
        }
        h.persistCalls.push({
          broker: input.broker,
          brokerUserId: input.brokerUserId,
        });
        return {
          success: true,
          data: {
            connection: { id: "conn-new" },
            wasReconnect: false,
            previousAccountName: null,
          },
        };
      },
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
  // cache. Purge it each load so its cache can't leak a resolved user across
  // tests and the deletion-guard path stays deterministic.
  delete cache[resolve("@/lib/db/user")];
  delete cache[resolve(ACTION_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as ActionModule;
}

function makeUser(over: Partial<UserRow> = {}): UserRow {
  return {
    id: "user-1",
    email: "edge@example.com",
    name: "Edge Tester",
    clerkId: "clerk_abc",
    emailPreferences: null,
    createdAt: new Date(), // fresh → trial not expired
    ...over,
  };
}

function baseHarness(): Harness {
  return {
    prisma: new RecordingPrisma(makeUser()),
    authUserId: "clerk_abc",
    authEmail: "edge@example.com",
    isDemo: false,
    planId: "PRO",
    verifyStateOk: true,
    reauthIntent: null,
    encryptThrows: false,
    revalidated: [],
    failures: [],
    profileThrows: false,
    holdingsThrows: false,
    apiClientCalls: [],
    persistCalls: [],
  };
}

function clearActionCache(): void {
  const cache = moduleCache();
  delete cache[require.resolve(ACTION_REL)];
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("MONEY-620 — broker-connection edge cases (real exports, mocked I/O)", () => {
  let h: Harness;
  const savedEnv = process.env.OAUTH_STATE_ALLOW_MISSING;

  beforeEach(() => {
    h = baseHarness();
    delete process.env.OAUTH_STATE_ALLOW_MISSING;
  });

  afterEach(() => {
    clearActionCache();
    if (savedEnv === undefined) delete process.env.OAUTH_STATE_ALLOW_MISSING;
    else process.env.OAUTH_STATE_ALLOW_MISSING = savedEnv;
  });

  describe("[SECURITY] OAuth callback CSRF state gate (MONEY-592)", () => {
    it("REJECTS a callback with NO state (secure-by-default) before any token exchange / DB write", async () => {
      const action = loadAction(h);
      const res = await action.handleOAuthCallbackAction("ZERODHA", "code");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /security state missing/i);
      // No connection was created/updated.
      assert.equal(h.prisma.callsFor("brokerConnection", "create").length, 0);
      assert.equal(h.prisma.callsFor("brokerConnection", "update").length, 0);
      // The right failure op was recorded.
      assert.equal(
        h.failures.some((f) => f.operation === "oauth_callback_csrf_missing"),
        true
      );
    });

    it("REJECTS a callback whose state MISMATCHES (verifyOAuthState=false)", async () => {
      h.verifyStateOk = false;
      const action = loadAction(h);
      const res = await action.handleOAuthCallbackAction(
        "ZERODHA",
        "code",
        "bad-state"
      );
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /security state mismatch/i);
      assert.equal(h.prisma.callsFor("brokerConnection", "create").length, 0);
      assert.equal(
        h.failures.some((f) => f.operation === "oauth_callback_csrf_mismatch"),
        true
      );
    });

    it("ACCEPTS a callback with a VALID state (happy path creates a connection)", async () => {
      const action = loadAction(h);
      const res = await action.handleOAuthCallbackAction(
        "ZERODHA",
        "code",
        "good-state"
      );
      assert.equal(res.success, true);
      assert.equal(h.prisma.callsFor("brokerConnection", "create").length, 1);
    });

    it("[break-glass] OAUTH_STATE_ALLOW_MISSING=1 lets a missing-state callback proceed", async () => {
      process.env.OAUTH_STATE_ALLOW_MISSING = "1";
      const action = loadAction(h);
      const res = await action.handleOAuthCallbackAction("ZERODHA", "code");
      assert.equal(res.success, true, "escape hatch should allow the flow");
      assert.equal(h.prisma.callsFor("brokerConnection", "create").length, 1);
    });
  });

  describe("[MONEY-837] re-auth account-mismatch guard", () => {
    it("REJECTS when the logged-in account differs from the connection being re-authed", async () => {
      h.reauthIntent = { connectionId: "c1", expectedBrokerUserId: "KP9460" };
      const action = loadAction(h);
      const res = await action.handleOAuthCallbackAction(
        "ZERODHA",
        "code",
        "good-state"
      );
      assert.equal(res.success, false);
      // Zerodha exchangeToken mock returns userId "ZUID"; intent expected KP9460.
      assert.match(res.error ?? "", /signed in as ZUID/);
      assert.match(res.error ?? "", /KP9460/);
      // The OTHER account was NOT silently rewritten — no create AND no update.
      assert.equal(h.prisma.callsFor("brokerConnection", "create").length, 0);
      assert.equal(h.prisma.callsFor("brokerConnection", "update").length, 0);
    });

    it("PROCEEDS when the logged-in account matches the re-auth intent", async () => {
      h.reauthIntent = { connectionId: "c1", expectedBrokerUserId: "ZUID" };
      const action = loadAction(h);
      const res = await action.handleOAuthCallbackAction(
        "ZERODHA",
        "code",
        "good-state"
      );
      assert.equal(res.success, true);
    });
  });

  describe("OAuth callback — unsupported broker default branch", () => {
    it("rejects an unsupported broker (GROWW) with a safe message, no token exchange", async () => {
      const action = loadAction(h);
      const res = await action.handleOAuthCallbackAction(
        "GROWW",
        "code",
        "good-state"
      );
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not available for the selected broker/i);
      assert.equal(h.prisma.callsFor("brokerConnection", "create").length, 0);
    });
  });

  describe("[SECURITY] encryption failure → no plaintext persisted", () => {
    it("when encryption.encrypt() throws, NO connection is created and a safe error returns", async () => {
      h.encryptThrows = true;
      const action = loadAction(h);
      const res = await action.handleOAuthCallbackAction(
        "ZERODHA",
        "code",
        "good-state"
      );
      // The action fails GRACEFULLY (catch path), never throws past the caller.
      assert.equal(res.success, false);
      assert.ok(res.error, "expected an error");
      // CRITICAL invariant: credentials must never be stored when encryption
      // fails — no connection create/update is issued.
      assert.equal(h.prisma.callsFor("brokerConnection", "create").length, 0);
      assert.equal(h.prisma.callsFor("brokerConnection", "update").length, 0);
      // The secret-bearing material (decrypted token / encrypted blob / IV /
      // authTag) must NOT appear in the user-facing error. (The benign
      // "Invalid key length" config text is allowed through by the sanitizer by
      // design — it carries no secret value.)
      assert.doesNotMatch(res.error!, /decrypted-token|authTag|base64/i);
    });
  });

  describe("OAuth callback — duplicate / reconnect (update vs create)", () => {
    it("UPDATES an existing connection (reset CONNECTED, attempts→0, errorMessage→null)", async () => {
      h.prisma = new RecordingPrisma(makeUser({ id: "user-1" }), {
        id: "conn-existing",
        userId: "user-1",
        broker: "ZERODHA",
        brokerUserId: "ZUID",
      });
      const action = loadAction(h);
      const res = await action.handleOAuthCallbackAction(
        "ZERODHA",
        "code",
        "good-state"
      );
      assert.equal(res.success, true);
      assert.equal(h.prisma.callsFor("brokerConnection", "create").length, 0);
      const upd = h.prisma.callsFor("brokerConnection", "update")[0];
      assert.ok(upd, "expected an update for the existing connection");
      const data = (upd!.args as { data: Record<string, unknown> }).data;
      assert.equal(data.status, "CONNECTED");
      assert.equal(data.reconnectAttempts, 0);
      assert.equal(data.errorMessage, null);
    });

    it("CREATES a connection when none exists for { userId, broker, brokerUserId }", async () => {
      h.prisma = new RecordingPrisma(makeUser({ id: "user-1" }), null);
      const action = loadAction(h);
      await action.handleOAuthCallbackAction("ZERODHA", "code", "good-state");
      assert.equal(h.prisma.callsFor("brokerConnection", "create").length, 1);
      assert.equal(h.prisma.callsFor("brokerConnection", "update").length, 0);
    });

    it("the reconnect lookup is scoped to { userId, broker, brokerUserId }", async () => {
      const action = loadAction(h);
      await action.handleOAuthCallbackAction("ZERODHA", "code", "good-state");
      const find = h.prisma.callsFor("brokerConnection", "findFirst")[0];
      assert.ok(find, "expected a duplicate-check findFirst");
      const where = (find!.args as { where: Record<string, unknown> }).where;
      assert.equal(where.userId, "user-1");
      assert.equal(where.broker, "ZERODHA");
      assert.equal(where.brokerUserId, "ZUID");
    });
  });

  describe("connectWithApiKeyAction — validation fallback (getProfile → getHoldings)", () => {
    it("succeeds when getProfile succeeds; getHoldings is NOT called", async () => {
      const action = loadAction(h);
      const res = await action.connectWithApiKeyAction("DHAN", "CID", "TOKEN");
      assert.equal(res.success, true);
      assert.deepEqual(h.apiClientCalls, ["getProfile"]);
      // Delegates the encrypt→upsert to the shared persist service exactly once.
      assert.equal(h.persistCalls.length, 1);
      assert.equal(h.persistCalls[0].broker, "DHAN");
      assert.equal(h.persistCalls[0].brokerUserId, "CID");
    });

    it("falls back to getHoldings when getProfile throws, and still succeeds", async () => {
      h.profileThrows = true;
      const action = loadAction(h);
      const res = await action.connectWithApiKeyAction("DHAN", "CID", "TOKEN");
      assert.equal(res.success, true);
      assert.deepEqual(h.apiClientCalls, ["getProfile", "getHoldings"]);
    });

    it("rejects credentials when BOTH getProfile and getHoldings throw — no connection written", async () => {
      h.profileThrows = true;
      h.holdingsThrows = true;
      const action = loadAction(h);
      const res = await action.connectWithApiKeyAction("DHAN", "CID", "TOKEN");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Invalid credentials/);
      // Validation failed → the upsert is never delegated (nothing persisted).
      assert.equal(h.persistCalls.length, 0);
      assert.equal(
        h.failures.some((f) => f.operation === "apikey_validate"),
        true
      );
    });
  });

  describe("trial gate (FREE) on connectWithApiKeyAction", () => {
    it("rejects a FREE user whose 30-day trial expired, before any client/DB work", async () => {
      h.planId = "FREE";
      h.prisma = new RecordingPrisma(
        makeUser({
          id: "user-1",
          createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
        })
      );
      const action = loadAction(h);
      const res = await action.connectWithApiKeyAction("DHAN", "CID", "TOKEN");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /trial has expired/i);
      // Validation client never built; the upsert is never delegated.
      assert.equal(h.apiClientCalls.length, 0);
      assert.equal(h.persistCalls.length, 0);
    });

    it("a FREE user within the trial window proceeds normally", async () => {
      h.planId = "FREE";
      h.prisma = new RecordingPrisma(
        makeUser({
          id: "user-1",
          createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        })
      );
      const action = loadAction(h);
      const res = await action.connectWithApiKeyAction("DHAN", "CID", "TOKEN");
      assert.equal(res.success, true);
      // Trial valid → the upsert is delegated to the shared persist service.
      assert.equal(h.persistCalls.length, 1);
    });
  });
});
