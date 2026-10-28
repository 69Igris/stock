/**
 * MONEY-620 — broker-connection.service SECURITY + POISON, on the LIVE service.
 *
 * Drives the REAL exported broker-connection service functions from
 * `@usemoney/services` (`packages/services/src/broker-connection.service.ts`) —
 * the user-facing brokers-page money path (`apps/web/lib/actions/
 * broker-connection.ts` → `getBrokerConnectionsAction` /
 * `disconnectBrokerAction`) — through a RECORDING prisma double injected at the
 * `@usemoney/database` / `@usemoney/core` / `@usemoney/logger` module boundary
 * via `require.cache`. Same proven seam as `services/trades-poison-live.test.ts`
 * and `services/credit-services-security-e2e.test.ts` ($transaction array form).
 * No inline reimplementation: the SAME code that ships computes what we assert
 * (no shadow — the prior `__tests__/actions/broker-connection*.test.ts` files
 * re-declared `mapConnectionToInfo` and asserted the copy). No live Mongo /
 * Redis is touched (pure, exits clean).
 *
 * What this pins on the LIVE service (the service-side de-shadow / hardening):
 *   1. CREDENTIAL LEAK (highest priority): even when the prisma row carries
 *      `encryptedCreds`/`iv`/`authTag`/`accessToken`/`refreshToken`/`apiSecret`
 *      (a careless `select` widening / a no-`select` findUnique), the returned
 *      connection shape contains NO secret field and the serialised JSON the
 *      client/api receives has NO secret VALUE. The SELECT is also asserted to
 *      request only non-secret columns.
 *   2. IDOR: every list read is scoped to the caller userId; a single-connection
 *      read / disconnect by bare id is gated by an ownership check, so a victim's
 *      connection id cannot be read or deleted cross-user. The disconnect's
 *      cascading deleteMany WHEREs all carry the caller userId.
 *   3. INVALID-DATE: a corrupt lastSync/tokenExpiry/connectedAt must NOT throw
 *      RangeError on .toISOString() (the whole brokers page / sync-status panel
 *      used to 500 → generic "Failed to fetch …").
 *   4. STATE MACHINE: an expired (incl. Invalid-Date) token → needsReauth /
 *      not-active deterministically; an unknown/missing status never defaults to
 *      active.
 *   5. BEHAVIOUR-PRESERVING: clean healthy connections yield the exact prior
 *      ISO strings + flags, and a raw Mongo error stays sanitized.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: packages/services/src/broker-connection.service.ts + ./broker-connection-logic.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── recording prisma double ────────────────────────────────────────────────

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

class RecordingPrisma {
  readonly calls: RecordedCall[] = [];
  private readonly queues = new Map<string, unknown[]>();
  private readonly failures = new Map<string, Error>();

  queue(model: string, method: string, result: unknown): void {
    const key = `${model}.${method}`;
    const q = this.queues.get(key) ?? [];
    q.push(result);
    this.queues.set(key, q);
  }

  fail(model: string, method: string, error: Error): void {
    this.failures.set(`${model}.${method}`, error);
  }

  private next(model: string, method: string): unknown {
    const q = this.queues.get(`${model}.${method}`);
    if (q && q.length > 0) return q.shift();
    if (method === "count") return 0;
    if (method === "aggregate") return { _sum: {}, _count: 0 };
    if (method === "findFirst" || method === "findUnique") return null;
    if (method === "deleteMany" || method === "updateMany") return { count: 0 };
    if (method === "delete" || method === "update" || method === "create")
      return {};
    return [];
  }

  readonly client: Record<string, unknown>;

  constructor() {
    const self = this;
    const modelProxy = (model: string) =>
      new Proxy(
        {},
        {
          get(_m, method: string) {
            return (args?: unknown) => {
              self.calls.push({ model, method, args });
              const err = self.failures.get(`${model}.${method}`);
              if (err) return Promise.reject(err);
              return Promise.resolve(self.next(model, method));
            };
          },
        }
      );

    this.client = new Proxy(
      {},
      {
        get(target: Record<string, unknown>, prop: string) {
          if (typeof prop !== "string") return undefined;
          if (prop === "then") return undefined;
          if (prop === "$transaction") {
            // The service passes `[prisma.x.deleteMany(...), …]` (already-invoked
            // promises). Await in order and return results, mirroring Prisma's
            // batch API.
            return (ops: unknown) =>
              Array.isArray(ops) ? Promise.all(ops) : Promise.resolve(ops);
          }
          if (!(prop in target)) target[prop] = modelProxy(prop);
          return target[prop];
        },
      }
    );
  }

  callsFor(model: string, method: string): RecordedCall[] {
    return this.calls.filter((c) => c.model === model && c.method === method);
  }
}

// ── module-boundary injection ───────────────────────────────────────────────

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

let activePrisma: RecordingPrisma = new RecordingPrisma();

/** Stable prisma stub forwarding to the swappable active recorder. */
const STABLE_PRISMA = new Proxy(
  {},
  {
    get(target: Record<string, unknown>, prop: string) {
      if (typeof prop !== "string") return undefined;
      if (prop === "then") return undefined;
      if (prop === "$transaction") {
        return (ops: unknown) =>
          (
            activePrisma.client as { $transaction: (o: unknown) => unknown }
          ).$transaction(ops);
      }
      if (!(prop in target)) {
        target[prop] = new Proxy(
          {},
          {
            get(_m, method: string) {
              return (args?: unknown) =>
                (
                  activePrisma.client as Record<
                    string,
                    Record<string, (a?: unknown) => Promise<unknown>>
                  >
                )[prop]![method]!(args);
            },
          }
        );
      }
      return target[prop];
    },
  }
);

/** Records cache-clear calls so the disconnect path can be asserted. */
interface CoreCacheRecorder {
  clearCalls: Array<{ fn: string; userId: unknown }>;
}
let activeCore: CoreCacheRecorder = { clearCalls: [] };
function freshCoreRecorder(): CoreCacheRecorder {
  return { clearCalls: [] };
}

function makeCoreStub(): Record<string, unknown> {
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        // clearBrokerConnectionCache / clearBrokerSyncCache / clearTradeCache /
        // clearPositionCache — record + no-op (never touch Redis).
        return async (userId: unknown) => {
          activeCore.clearCalls.push({ fn: k as string, userId });
        };
      },
    }
  );
}

// ── service shape ────────────────────────────────────────────────────────────

interface BrokerConnectionInfo {
  id: string;
  broker: string;
  brokerUserId: string | null;
  accountName: string | null;
  status: string;
  connectedAt?: string;
  lastSync?: string;
  tokenExpiry?: string;
  isExpired: boolean;
  needsReauth: boolean;
}
interface BrokerSyncStatus {
  id: string;
  broker: string;
  brokerUserId: string | null;
  accountName: string | null;
  isActive: boolean;
  lastSync: string | null;
}
type Result<T> =
  | { success: true; data: T; message?: string }
  | { success: false; error: string; code?: string };

interface ServicesModule {
  getBrokerConnections: (
    userId: string
  ) => Promise<Result<BrokerConnectionInfo[]>>;
  getBrokerConnection: (
    userId: string,
    connectionId: string
  ) => Promise<Result<BrokerConnectionInfo>>;
  deleteBrokerConnection: (
    userId: string,
    connectionId: string
  ) => Promise<Result<void>>;
  getBrokerSyncStatus: (userId: string) => Promise<Result<BrokerSyncStatus[]>>;
  getLastSyncTime: (userId: string) => Promise<Result<string | null>>;
}

let servicesSingleton: ServicesModule | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

function installServices(): ServicesModule {
  if (servicesSingleton) return servicesSingleton;
  const cache = moduleCache();
  const stub = (path: string, exports: unknown) => {
    priorCacheEntries.push([path, cache[path]]);
    cache[path] = { exports };
  };
  stub(require.resolve("@usemoney/database"), {
    __esModule: true,
    prisma: STABLE_PRISMA,
    default: STABLE_PRISMA,
  });
  stub(require.resolve("@usemoney/core"), makeCoreStub());
  stub(require.resolve("@usemoney/logger"), makeLoggerStub());
  // Evict already-compiled service/logic/barrel modules so they re-bind to the
  // stubbed deps above.
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/packages/services/src/") &&
      (key.endsWith(".service.ts") ||
        key.endsWith("-logic.ts") ||
        key.endsWith("/index.ts"))
    ) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  servicesSingleton = require("@usemoney/services") as ServicesModule;
  return servicesSingleton;
}

function uninstallServices(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.length = 0;
  servicesSingleton = null;
}

function reset(): { prisma: RecordingPrisma; core: CoreCacheRecorder } {
  activePrisma = new RecordingPrisma();
  activeCore = freshCoreRecorder();
  return { prisma: activePrisma, core: activeCore };
}

function ok<T>(r: Result<T>): { success: true; data: T } {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return r as { success: true; data: T };
}

const SECRET_NAMES = [
  "encryptedCreds",
  "iv",
  "authTag",
  "accessToken",
  "refreshToken",
  "apiSecret",
  "apiKey",
  "userId",
] as const;

/**
 * A complete-ish Prisma BrokerConnection row INCLUDING secret fields. The
 * service `select`s only non-secret columns, but a recorder ignores `select`
 * and returns whatever we queue — so queuing a row WITH secrets proves the
 * mapper drops them even if a future `select` widening lets them through.
 */
function dbConn(
  overrides: Partial<{
    id: string;
    userId: string;
    broker: string;
    brokerUserId: string | null;
    accountName: string | null;
    status: string;
    connectedAt: Date | null;
    lastSync: Date | null;
    tokenExpiry: Date | null;
    encryptedCreds: string;
    iv: string;
    authTag: string;
    accessToken: string;
    refreshToken: string;
    apiSecret: string;
    apiKey: string;
  }> = {}
) {
  return {
    id: "conn-1",
    userId: "owner",
    broker: "ZERODHA",
    brokerUserId: "ZR1234",
    accountName: "My Zerodha",
    status: "CONNECTED",
    connectedAt: new Date("2024-01-10T08:00:00.000Z"),
    lastSync: new Date("2024-06-15T09:30:00.000Z"),
    tokenExpiry: new Date("2099-01-01T00:00:00.000Z"),
    // secrets that must never escape:
    encryptedCreds: "BASE64_AES_GCM_CIPHERTEXT",
    iv: "BASE64_IV",
    authTag: "BASE64_AUTH_TAG",
    accessToken: "kite_access_token_PLAINTEXT",
    refreshToken: "kite_refresh_token_PLAINTEXT",
    apiSecret: "ZERODHA_API_SECRET",
    apiKey: "ZERODHA_API_KEY",
    ...overrides,
  };
}

/** Assert a returned connection-ish object exposes no secret key/value. */
function assertNoSecretLeak(shape: Record<string, unknown>): void {
  const keys = Object.keys(shape);
  for (const s of SECRET_NAMES) {
    assert.equal(keys.includes(s), false, `must not expose key '${s}'`);
  }
  const json = JSON.stringify(shape);
  for (const v of [
    "PLAINTEXT",
    "CIPHERTEXT",
    "AUTH_TAG",
    "API_SECRET",
    "BASE64_IV",
    "ZERODHA_API_KEY",
  ]) {
    assert.equal(
      json.includes(v),
      false,
      `must not leak value containing '${v}'`
    );
  }
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — broker-connection.service: credential leak (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });
  after(() => {
    uninstallServices();
  });

  it("getBrokerConnections: SELECT requests only non-secret columns", async () => {
    prisma.queue("brokerConnection", "findMany", [dbConn()]);
    await svc.getBrokerConnections("owner");
    const args = prisma.callsFor("brokerConnection", "findMany")[0]!.args as {
      select: Record<string, boolean>;
    };
    // The select must NOT request encrypted creds / iv / authTag.
    for (const s of ["encryptedCreds", "iv", "authTag"]) {
      assert.notEqual(args.select[s], true, `select must not request '${s}'`);
    }
    // It DOES request the non-secret fields the UI needs.
    for (const f of ["id", "broker", "status", "lastSync", "tokenExpiry"]) {
      assert.equal(args.select[f], true);
    }
  });

  it("getBrokerConnections: returned shape never leaks a secret, even if the row carries them", async () => {
    prisma.queue("brokerConnection", "findMany", [
      dbConn({ id: "c1" }),
      dbConn({ id: "c2", broker: "UPSTOX", status: "EXPIRED" }),
    ]);
    const res = ok(await svc.getBrokerConnections("owner"));
    assert.equal(res.data.length, 2);
    for (const info of res.data)
      assertNoSecretLeak(info as unknown as Record<string, unknown>);
    // And the whole list serialises with no secret value.
    assertNoSecretLeak({ list: res.data } as unknown as Record<
      string,
      unknown
    >);
  });

  it("getBrokerConnection: returned shape never leaks the selected internal userId or any secret", async () => {
    prisma.queue(
      "brokerConnection",
      "findUnique",
      dbConn({ id: "c1", userId: "owner" })
    );
    const res = ok(await svc.getBrokerConnection("owner", "c1"));
    assertNoSecretLeak(res.data as unknown as Record<string, unknown>);
    assert.equal(
      (res.data as unknown as Record<string, unknown>).userId,
      undefined
    );
  });

  it("getBrokerSyncStatus: returned shape never leaks a secret", async () => {
    prisma.queue("brokerConnection", "findMany", [dbConn()]);
    const res = ok(await svc.getBrokerSyncStatus("owner"));
    for (const s of res.data)
      assertNoSecretLeak(s as unknown as Record<string, unknown>);
  });
});

describe("MONEY-620 — broker-connection.service: IDOR scope (LIVE)", () => {
  let prisma: RecordingPrisma;
  let core: CoreCacheRecorder;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma, core } = reset());
  });
  after(() => {
    uninstallServices();
  });

  it("getBrokerConnections: findMany WHERE is scoped to the caller userId", async () => {
    prisma.queue("brokerConnection", "findMany", []);
    await svc.getBrokerConnections("attacker-or-owner");
    const args = prisma.callsFor("brokerConnection", "findMany")[0]!.args as {
      where: { userId: string };
    };
    assert.equal(args.where.userId, "attacker-or-owner");
  });

  it("getBrokerConnection: a victim's connection id is NOT readable cross-user", async () => {
    // Row belongs to 'victim'; caller is 'attacker' → ownership check rejects.
    prisma.queue(
      "brokerConnection",
      "findUnique",
      dbConn({ id: "victim-conn", userId: "victim" })
    );
    const res = await svc.getBrokerConnection("attacker", "victim-conn");
    assert.equal(res.success, false);
    assert.equal((res as { success: false; code?: string }).code, "NOT_FOUND");
    // Crucially: no secret/details leaked in the failure.
    assertNoSecretLeak(res as unknown as Record<string, unknown>);
  });

  it("getBrokerConnection: owner CAN read their own connection", async () => {
    prisma.queue(
      "brokerConnection",
      "findUnique",
      dbConn({ id: "owned", userId: "owner" })
    );
    const res = ok(await svc.getBrokerConnection("owner", "owned"));
    assert.equal(res.data.id, "owned");
  });

  it("deleteBrokerConnection: a victim's connection id is NOT deletable cross-user (no cascade fires)", async () => {
    prisma.queue(
      "brokerConnection",
      "findUnique",
      dbConn({ id: "victim-conn", userId: "victim" })
    );
    const res = await svc.deleteBrokerConnection("attacker", "victim-conn");
    assert.equal(res.success, false);
    assert.equal((res as { success: false; code?: string }).code, "NOT_FOUND");
    // No destructive op ran for the attacker.
    assert.equal(prisma.callsFor("brokerConnection", "delete").length, 0);
    assert.equal(prisma.callsFor("trade", "deleteMany").length, 0);
    assert.equal(prisma.callsFor("holding", "deleteMany").length, 0);
    assert.equal(core.clearCalls.length, 0);
  });

  it("deleteBrokerConnection: owner delete cascades, every WHERE scoped to caller userId", async () => {
    prisma.queue(
      "brokerConnection",
      "findUnique",
      dbConn({
        id: "owned",
        userId: "owner",
        broker: "ZERODHA",
        brokerUserId: "ZR1",
      })
    );
    const res = ok(await svc.deleteBrokerConnection("owner", "owned"));
    assert.equal(res.success, true);

    // Every cascading deleteMany is scoped to the caller userId + this broker.
    for (const model of [
      "pairedTradeView",
      "mutualFund",
      "holding",
      "position",
      "order",
      "trade",
    ]) {
      const calls = prisma.callsFor(model, "deleteMany");
      assert.equal(calls.length, 1, `${model}.deleteMany should fire once`);
      const where = (
        calls[0]!.args as { where: { userId: string; broker: string } }
      ).where;
      assert.equal(
        where.userId,
        "owner",
        `${model} deleteMany scoped to owner`
      );
      assert.equal(where.broker, "ZERODHA");
    }
    // The connection itself is deleted by its id.
    const del = prisma.callsFor("brokerConnection", "delete")[0]!.args as {
      where: { id: string };
    };
    assert.equal(del.where.id, "owned");
    // Caches cleared for the owner only.
    assert.ok(core.clearCalls.length > 0);
    for (const c of core.clearCalls) assert.equal(c.userId, "owner");

    // MONEY-848: a real brokerUserId is matched EXACTLY (no null/'' OR branch).
    const tradeWhere = (
      prisma.callsFor("trade", "deleteMany")[0]!.args as {
        where: { brokerUserId?: unknown; OR?: unknown };
      }
    ).where;
    assert.equal(tradeWhere.brokerUserId, "ZR1");
    assert.equal(tradeWhere.OR, undefined);
  });

  // MONEY-848: a connection whose brokerUserId is NULL has its data rows
  // persisted under the EMPTY-STRING sentinel (effectiveBrokerUserId =
  // brokerUserId || ""). The cascade must coalesce null↔"" so those rows aren't
  // orphaned. Prisma's `in` can't hold null, so the where uses an OR over both.
  it("deleteBrokerConnection: null brokerUserId cascades with OR:[null, ''] (no orphans)", async () => {
    prisma.queue(
      "brokerConnection",
      "findUnique",
      dbConn({
        id: "owned-null",
        userId: "owner",
        broker: "ZERODHA",
        brokerUserId: null,
      })
    );
    const res = ok(await svc.deleteBrokerConnection("owner", "owned-null"));
    assert.equal(res.success, true);

    for (const model of [
      "pairedTradeView",
      "mutualFund",
      "holding",
      "position",
      "order",
      "trade",
    ]) {
      const where = (
        prisma.callsFor(model, "deleteMany")[0]!.args as {
          where: {
            userId: string;
            broker: string;
            brokerUserId?: unknown;
            OR?: Array<{ brokerUserId: string | null }>;
          };
        }
      ).where;
      assert.equal(where.userId, "owner");
      assert.equal(where.broker, "ZERODHA");
      // No bare brokerUserId:null (which would miss the ""-keyed rows).
      assert.equal(
        where.brokerUserId,
        undefined,
        `${model}: must not use a bare brokerUserId when null`
      );
      assert.deepEqual(
        where.OR,
        [{ brokerUserId: null }, { brokerUserId: "" }],
        `${model}: cascade must coalesce null↔"" so no rows orphan`
      );
    }
  });

  it("deleteBrokerConnection: empty-string brokerUserId also coalesces to OR:[null, '']", async () => {
    prisma.queue(
      "brokerConnection",
      "findUnique",
      dbConn({
        id: "owned-empty",
        userId: "owner",
        broker: "ZERODHA",
        brokerUserId: "",
      })
    );
    const res = ok(await svc.deleteBrokerConnection("owner", "owned-empty"));
    assert.equal(res.success, true);
    const where = (
      prisma.callsFor("trade", "deleteMany")[0]!.args as {
        where: { OR?: Array<{ brokerUserId: string | null }> };
      }
    ).where;
    assert.deepEqual(where.OR, [{ brokerUserId: null }, { brokerUserId: "" }]);
  });
});

describe("MONEY-620 — broker-connection.service: invalid-date never 500s (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });
  after(() => {
    uninstallServices();
  });

  const INVALID = new Date("not-a-real-date");

  it("getBrokerConnections: corrupt lastSync/tokenExpiry/connectedAt → success, omitted ISO, no throw, no 'Invalid Date'", async () => {
    prisma.queue("brokerConnection", "findMany", [
      dbConn({
        id: "ok",
        status: "CONNECTED",
        connectedAt: new Date("2024-01-10T08:00:00.000Z"),
        lastSync: new Date("2024-06-15T09:30:00.000Z"),
        tokenExpiry: new Date("2099-01-01T00:00:00.000Z"),
      }),
      dbConn({
        id: "corrupt",
        status: "CONNECTED",
        connectedAt: INVALID,
        lastSync: INVALID,
        tokenExpiry: INVALID,
      }),
    ]);

    let res!: { success: true; data: BrokerConnectionInfo[] };
    await assert.doesNotReject(async () => {
      res = ok(await svc.getBrokerConnections("owner"));
    });
    assert.equal(res.data.length, 2);

    const corrupt = res.data.find((c) => c.id === "corrupt")!;
    assert.equal(corrupt.connectedAt, undefined);
    assert.equal(corrupt.lastSync, undefined);
    assert.equal(corrupt.tokenExpiry, undefined);
    // Invalid expiry → treated as expired → reauth (fail-safe).
    assert.equal(corrupt.isExpired, true);
    assert.equal(corrupt.needsReauth, true);

    // The clean row is unaffected (behaviour preserved).
    const clean = res.data.find((c) => c.id === "ok")!;
    assert.equal(clean.lastSync, "2024-06-15T09:30:00.000Z");
    assert.equal(clean.isExpired, false);
    assert.equal(clean.needsReauth, false);

    // Whole response never serialises the literal "Invalid Date".
    assert.equal(JSON.stringify(res.data).includes("Invalid Date"), false);
  });

  it("getBrokerSyncStatus: corrupt lastSync → success (lastSync null), no throw", async () => {
    prisma.queue("brokerConnection", "findMany", [
      dbConn({ id: "corrupt", status: "CONNECTED", lastSync: INVALID }),
    ]);
    let res!: { success: true; data: BrokerSyncStatus[] };
    await assert.doesNotReject(async () => {
      res = ok(await svc.getBrokerSyncStatus("owner"));
    });
    assert.equal(res.data[0]!.lastSync, null);
  });

  it("getLastSyncTime: corrupt stored lastSync → success(null), not a 500", async () => {
    prisma.queue("brokerConnection", "findFirst", { lastSync: INVALID });
    let res!: { success: true; data: string | null };
    await assert.doesNotReject(async () => {
      res = ok(await svc.getLastSyncTime("owner"));
    });
    assert.equal(res.data, null);
  });

  it("getLastSyncTime: valid stored lastSync → ISO string (behaviour preserved)", async () => {
    prisma.queue("brokerConnection", "findFirst", {
      lastSync: new Date("2024-06-15T09:30:00.000Z"),
    });
    const res = ok(await svc.getLastSyncTime("owner"));
    assert.equal(res.data, "2024-06-15T09:30:00.000Z");
  });

  it("getLastSyncTime: no synced connection → success(null)", async () => {
    prisma.queue("brokerConnection", "findFirst", null);
    const res = ok(await svc.getLastSyncTime("owner"));
    assert.equal(res.data, null);
  });
});

describe("MONEY-620 — broker-connection.service: status state machine + empty (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });
  after(() => {
    uninstallServices();
  });

  const PAST = new Date(Date.now() - 86_400_000);
  const FUTURE = new Date(Date.now() + 86_400_000);

  it("EXPIRED status (future token) → isExpired by status reauth; CONNECTED+past token → expired", async () => {
    prisma.queue("brokerConnection", "findMany", [
      dbConn({ id: "by-status", status: "EXPIRED", tokenExpiry: FUTURE }),
      dbConn({ id: "by-token", status: "CONNECTED", tokenExpiry: PAST }),
      dbConn({ id: "healthy", status: "CONNECTED", tokenExpiry: FUTURE }),
      dbConn({ id: "unknown-status", status: "WAT", tokenExpiry: FUTURE }),
    ]);
    const res = ok(await svc.getBrokerConnections("owner"));
    const m = new Map(res.data.map((c) => [c.id, c]));

    // EXPIRED status forces reauth even though the token is in the future.
    assert.equal(m.get("by-status")!.needsReauth, true);
    assert.equal(m.get("by-status")!.isExpired, false); // token itself valid

    // Expired token forces reauth + isExpired.
    assert.equal(m.get("by-token")!.isExpired, true);
    assert.equal(m.get("by-token")!.needsReauth, true);

    // Healthy connection: no reauth.
    assert.equal(m.get("healthy")!.needsReauth, false);
    assert.equal(m.get("healthy")!.isExpired, false);

    // Unknown status with a valid token does NOT force reauth (preserved).
    assert.equal(m.get("unknown-status")!.needsReauth, false);
  });

  it("getBrokerSyncStatus: only exact CONNECTED + non-expired is active; unknown status not active", async () => {
    prisma.queue("brokerConnection", "findMany", [
      dbConn({ id: "active", status: "CONNECTED", tokenExpiry: FUTURE }),
      dbConn({ id: "expired-tok", status: "CONNECTED", tokenExpiry: PAST }),
      dbConn({ id: "status-expired", status: "EXPIRED", tokenExpiry: FUTURE }),
      dbConn({ id: "weird", status: "WAT", tokenExpiry: FUTURE }),
    ]);
    const res = ok(await svc.getBrokerSyncStatus("owner"));
    const m = new Map(res.data.map((c) => [c.id, c.isActive]));
    assert.equal(m.get("active"), true);
    assert.equal(m.get("expired-tok"), false);
    assert.equal(m.get("status-expired"), false);
    assert.equal(m.get("weird"), false); // never defaults to active
  });

  it("empty connection list → success with empty arrays (no crash)", async () => {
    prisma.queue("brokerConnection", "findMany", []);
    const a = ok(await svc.getBrokerConnections("owner"));
    assert.deepEqual(a.data, []);

    prisma.queue("brokerConnection", "findMany", []);
    const b = ok(await svc.getBrokerSyncStatus("owner"));
    assert.deepEqual(b.data, []);
  });
});

describe("MONEY-620 — broker-connection.service: error sanitization (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma } = reset());
  });
  after(() => {
    uninstallServices();
  });

  it("a raw Mongo error from findMany never leaks; returns the sanitized message", async () => {
    prisma.fail(
      "brokerConnection",
      "findMany",
      new Error("E11000 duplicate key error on internal.brokerConnection")
    );
    const res = await svc.getBrokerConnections("owner");
    assert.equal(res.success, false);
    assert.equal(
      (res as { success: false; error: string }).error,
      "Failed to fetch broker connections"
    );
    assert.equal(
      (res as { success: false; error: string }).error.includes("E11000"),
      false
    );
  });

  it("a transaction failure during delete returns the sanitized message (no half-state leaked to caller)", async () => {
    prisma.queue(
      "brokerConnection",
      "findUnique",
      dbConn({ id: "owned", userId: "owner" })
    );
    prisma.fail(
      "trade",
      "deleteMany",
      new Error("Mongo: connection reset by peer")
    );
    const res = await svc.deleteBrokerConnection("owner", "owned");
    assert.equal(res.success, false);
    assert.equal(
      (res as { success: false; error: string }).error,
      "Failed to delete broker connection"
    );
  });
});
