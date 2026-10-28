/**
 * MONEY-846 — broker-sync.service + broker-connection.service, on the LIVE service.
 *
 * Drives the REAL exported functions from `@usemoney/services`
 * (`packages/services/src/broker-sync.service.ts` +
 * `broker-connection.service.ts`) through a RECORDING prisma double + a fake
 * broker-client factory + a swappable decryptor, all injected at the
 * `@usemoney/database` / `@usemoney/core` / `@usemoney/core/brokers` /
 * `@usemoney/security` / `@usemoney/logger` module boundary via `require.cache`.
 * Same proven seam as `services/broker-connection-poison-live.test.ts` and
 * `actions/broker-sync-action-e2e.test.ts`. No inline reimplementation: the SAME
 * code that ships computes what we assert (no shadow). No live Mongo / Redis is
 * touched (pure, exits clean). CWD must be `apps/web`.
 *
 * What this pins on the LIVE service:
 *   1. YEAR-LOOP NO-FALSE-STOP (MONEY-846 #1): syncHistoricalTradebook walks
 *      newest→oldest to the params.fromDate floor UNCONDITIONALLY. A user with a
 *      ≥2-year complete trading GAP mid-history ([data, [], [], data]) must have
 *      EVERY non-empty year fetched + persisted — including the OLDEST one past
 *      the gap (the old `consecutiveEmptyYears < 2` early-stop dropped it).
 *   2. PER-CONNECTION ERROR BOUNDARY (MONEY-846 #2): in the multi-connection
 *      syncBrokerConnections loop, a connection that throws at decrypt /
 *      createBrokerClient records a connection-level error and the loop CONTINUES
 *      — a healthy connection in the same batch still fully syncs. One bad
 *      connection never aborts the wildcard "*" scheduled batch. Plus the live
 *      shape: one healthy + one token-expired → healthy synced, expired
 *      surfaced (skipped/authFailed), only the expired flips NEEDS_REAUTH.
 *   3. DELETE-CASCADE null/"" COALESCE (the flagship MONEY-846 fix): a connection
 *      whose brokerUserId is NULL has its data rows persisted under the EMPTY
 *      STRING sentinel (effectiveBrokerUserId = brokerUserId || ""), so
 *      deleteBrokerConnection must sweep BOTH null AND "" rows for EVERY model.
 *   4. PERSIST IDEMPOTENCY: re-running persistTrades / persistHoldings over
 *      identical input yields no duplicates / no net change (documents the
 *      upsert + delete+insert keying).
 *
 * Source: packages/services/src/broker-sync.service.ts +
 *         packages/services/src/broker-connection.service.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── recording prisma double ────────────────────────────────────────────────

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

/**
 * A recording prisma whose tables are real arrays, so delete+insert / upsert
 * actually mutate state (needed to prove idempotency + the wipe-safe contract).
 * `$transaction` runs the callback against the same client (callback form) or
 * awaits the array (batch form) — mirroring Prisma's two surfaces.
 */
class RecordingPrisma {
  readonly calls: RecordedCall[] = [];
  /** model → rows (each row a plain object). */
  readonly tables = new Map<string, Array<Record<string, unknown>>>();
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

  private rowsOf(model: string): Array<Record<string, unknown>> {
    let t = this.tables.get(model);
    if (!t) {
      t = [];
      this.tables.set(model, t);
    }
    return t;
  }

  /** Match a row against a where clause (supports the OR:[…] sentinel form). */
  private matches(row: Record<string, unknown>, where: unknown): boolean {
    if (!where || typeof where !== "object") return true;
    const w = where as Record<string, unknown>;
    for (const [k, v] of Object.entries(w)) {
      if (k === "OR" && Array.isArray(v)) {
        if (!v.some((clause) => this.matches(row, clause))) return false;
        continue;
      }
      if (row[k] !== v) return false;
    }
    return true;
  }

  private exec(model: string, method: string, args?: unknown): unknown {
    this.calls.push({ model, method, args });
    const err = this.failures.get(`${model}.${method}`);
    if (err) throw err;

    const a = (args ?? {}) as Record<string, unknown>;
    const rows = this.rowsOf(model);

    switch (method) {
      case "deleteMany": {
        const before = rows.length;
        const kept = rows.filter((r) => !this.matches(r, a.where));
        const removed = before - kept.length;
        rows.length = 0;
        rows.push(...kept);
        return { count: removed };
      }
      case "createMany": {
        const data = (a.data as Array<Record<string, unknown>>) ?? [];
        rows.push(...data.map((d) => ({ ...d })));
        return { count: data.length };
      }
      case "create": {
        const data = (a.data as Record<string, unknown>) ?? {};
        rows.push({ ...data });
        return { ...data };
      }
      case "upsert": {
        // Keyed by the single compound-unique object inside `where`.
        const whereObj = (a.where as Record<string, unknown>) ?? {};
        const keyObj = Object.values(whereObj)[0] as
          | Record<string, unknown>
          | undefined;
        const found = keyObj
          ? rows.find((r) =>
              Object.entries(keyObj).every(([kk, vv]) => r[kk] === vv)
            )
          : undefined;
        if (found) {
          Object.assign(found, a.update as Record<string, unknown>);
          return { ...found };
        }
        const created = { ...(a.create as Record<string, unknown>) };
        // Stamp the compound-key fields so the row is found on the next upsert.
        if (keyObj) Object.assign(created, keyObj);
        rows.push(created);
        return { ...created };
      }
      case "delete":
        return {};
      case "update": {
        return { ...(a.data as Record<string, unknown>) };
      }
      case "findMany": {
        const queued = this.queues.get(`${model}.findMany`);
        if (queued && queued.length > 0) return queued.shift();
        return rows.filter((r) => this.matches(r, a.where));
      }
      case "findUnique":
      case "findFirst": {
        const queued = this.queues.get(`${model}.${method}`);
        if (queued && queued.length > 0) return queued.shift();
        return rows.find((r) => this.matches(r, a.where)) ?? null;
      }
      case "count":
        return rows.filter((r) => this.matches(r, a.where)).length;
      default: {
        const queued = this.queues.get(`${model}.${method}`);
        if (queued && queued.length > 0) return queued.shift();
        return null;
      }
    }
  }

  readonly client: Record<string, unknown>;

  constructor() {
    const self = this;
    const modelProxy = (model: string) =>
      new Proxy(
        {},
        {
          get(_m, method: string) {
            return (args?: unknown) =>
              Promise.resolve(self.exec(model, method, args));
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
            return (arg: unknown) => {
              if (typeof arg === "function") {
                // Callback form: run against this same client so the REAL
                // persistHoldings/persistPositions delete+createMany execute.
                return Promise.resolve(
                  (arg as (tx: unknown) => unknown)(self.client)
                );
              }
              // Array (batch) form: the delete-cascade passes already-invoked
              // promises; await them in order.
              return Promise.all(arg as unknown[]);
            };
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

  seed(model: string, rows: Array<Record<string, unknown>>): void {
    this.rowsOf(model).push(...rows.map((r) => ({ ...r })));
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

// A fake broker client. Each capability is a function the test supplies; absent
// ones default to returning []. getHistoricalTrades is given the window so a
// test can return per-window results (year0/year1/…).
interface FakeBrokerClient {
  getHoldings: () => Promise<unknown[]>;
  getPositions: () => Promise<unknown[]>;
  getTrades: () => Promise<unknown[]>;
  getMutualFunds: () => Promise<unknown[]>;
  getHistoricalTrades: (
    from: Date,
    to: Date,
    segments?: string[]
  ) => Promise<unknown[]>;
  getProfile: () => Promise<unknown>;
}

interface BrokerSeam {
  /** Built once per broker; the harness records each (broker, creds). */
  makeClient: (broker: string) => Partial<FakeBrokerClient>;
  builtClients: Array<{ broker: string }>;
  /** Per-broker decrypt behaviour; default returns a benign token. */
  decrypt: (encryptedCreds: string) => unknown;
}

let activePrisma: RecordingPrisma = new RecordingPrisma();
let activeBroker: BrokerSeam = defaultBrokerSeam();

function defaultBrokerSeam(): BrokerSeam {
  return {
    makeClient: () => ({}),
    builtClients: [],
    decrypt: () => ({ accessToken: "decrypted" }),
  };
}

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

function makeCoreStub(): Record<string, unknown> {
  // deleteBrokerConnection imports the cache-clear helpers from @usemoney/core.
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        return async () => {};
      },
    }
  );
}

function makeBrokersStub(): Record<string, unknown> {
  return {
    __esModule: true,
    createBrokerClient: (broker: string) => {
      activeBroker.builtClients.push({ broker });
      const partial = activeBroker.makeClient(broker);
      return {
        getHoldings: partial.getHoldings ?? (async () => []),
        getPositions: partial.getPositions ?? (async () => []),
        getTrades: partial.getTrades ?? (async () => []),
        getMutualFunds: partial.getMutualFunds ?? (async () => []),
        getHistoricalTrades: partial.getHistoricalTrades ?? (async () => []),
        getProfile:
          partial.getProfile ??
          (async () => {
            throw new Error("no profile");
          }),
      };
    },
  };
}

function makeSecurityStub(): Record<string, unknown> {
  return {
    __esModule: true,
    encryption: {
      decrypt: (encryptedCreds: string) => activeBroker.decrypt(encryptedCreds),
      encrypt: () => ({ encrypted: "x", iv: "y", authTag: "z" }),
    },
  };
}

interface ServicesModule {
  syncBrokerConnections: (params: {
    userId: string;
    broker?: string;
    connectionId?: string;
    dataTypes?: readonly string[];
    refreshProfile?: boolean;
  }) => Promise<{
    success: boolean;
    error?: string;
    data?: {
      synced: Record<string, number>;
      total: number;
      connectionCount: number;
      perConnection: Array<{
        broker: string;
        synced: Record<string, number>;
        authFailed: boolean;
        skipped: boolean;
        skipReason?: string;
        errors: Record<string, string>;
        connectionError?: string;
      }>;
    };
  }>;
  syncHistoricalTradebook: (params: {
    userId: string;
    broker?: string;
    connectionId?: string;
    fromDate: Date;
    toDate: Date;
    segments?: string[];
  }) => Promise<{
    success: boolean;
    error?: string;
    data?: {
      synced: number;
      connectionCount: number;
      perConnection: Array<{
        broker: string;
        brokerUserId: string | null;
        synced: number;
        skipped?: boolean;
        error?: string;
      }>;
    };
  }>;
  persistTrades: (
    userId: string,
    broker: string,
    brokerUserId: string | null | undefined,
    trades: unknown[]
  ) => Promise<void>;
  persistHoldings: (
    userId: string,
    broker: string,
    brokerUserId: string | null | undefined,
    holdings: unknown[]
  ) => Promise<void>;
  deleteBrokerConnection: (
    userId: string,
    connectionId: string
  ) => Promise<{ success: boolean; error?: string; code?: string }>;
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
  stub(require.resolve("@usemoney/core/brokers"), makeBrokersStub());
  stub(require.resolve("@usemoney/security"), makeSecurityStub());
  // MONEY-1062 (W2): broker-sync.service now imports `encryption` from the
  // `@usemoney/security/encryption` SUBPATH (not the root barrel), so the stub
  // must intercept that specifier too — otherwise the service hits the real
  // encryption singleton and throws "ENCRYPTION_KEY is required".
  stub(require.resolve("@usemoney/security/encryption"), makeSecurityStub());
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

function reset(): { prisma: RecordingPrisma; broker: BrokerSeam } {
  activePrisma = new RecordingPrisma();
  activeBroker = defaultBrokerSeam();
  return { prisma: activePrisma, broker: activeBroker };
}

function ok<T extends { success: boolean }>(r: T): T {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return r;
}

// ── fixtures ───────────────────────────────────────────────────────────────

function connRow(
  overrides: Partial<{
    id: string;
    userId: string;
    broker: string;
    brokerUserId: string | null;
    encryptedCreds: string | null;
    iv: string | null;
    authTag: string | null;
    tokenExpiry: Date | null;
    status: string;
    brokerMetadata: unknown;
  }> = {}
): Record<string, unknown> {
  return {
    id: "conn-1",
    userId: "owner",
    broker: "ZERODHA",
    brokerUserId: "ZR1",
    encryptedCreds: "ENC",
    iv: "IV",
    authTag: "TAG",
    tokenExpiry: new Date(Date.now() + 86_400_000),
    status: "CONNECTED",
    brokerMetadata: null,
    ...overrides,
  };
}

// A NormalizedTrade-shaped row (what a client's getTrades/getHistoricalTrades
// returns). persistTrades upserts it keyed by tradeId.
function trade(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tradeId: "t1",
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

// A NormalizedHolding-shaped row.
function holding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: "RELIANCE",
    tradingSymbol: "RELIANCE",
    name: "Reliance",
    isin: "INE002A01018",
    instrumentToken: 1,
    exchange: "NSE",
    quantity: 10,
    averagePrice: 2400,
    currentPrice: 2500,
    closePrice: 2480,
    investedValue: 24000,
    currentValue: 25000,
    pnl: 1000,
    pnlPercentage: 4.17,
    dayChange: 20,
    dayChangePercentage: 0.81,
    ...over,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. YEAR-LOOP — no false stop across a multi-year gap (MONEY-846 #1)
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-846 — syncHistoricalTradebook walks past empty-year gaps (LIVE)", () => {
  let prisma: RecordingPrisma;
  let broker: BrokerSeam;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma, broker } = reset());
  });
  after(() => {
    uninstallServices();
  });

  it("[data, [], [], data]: EVERY non-empty year (incl. the oldest past the gap) is fetched + persisted", async () => {
    prisma.seed("brokerConnection", [connRow({ brokerUserId: "ZR1" })]);

    // Per-window results, newest→oldest. Window 0 (most recent year) + window 3
    // (oldest, beyond a 2-year empty gap) have trades; windows 1 & 2 are empty.
    // The OLD `consecutiveEmptyYears < 2` stop would terminate after window 2 and
    // NEVER fetch window 3 — the regression this asserts against.
    const windowResults: Array<Record<string, unknown>[]> = [
      [trade({ tradeId: "y0-a" }), trade({ tradeId: "y0-b" })], // year 0: data
      [], // year 1: empty
      [], // year 2: empty (2 consecutive empties → old code stops HERE)
      [trade({ tradeId: "y3-a" })], // year 3: data (past the gap)
    ];
    let call = 0;
    const fetchedWindows: Array<{ from: string; to: string }> = [];
    broker.makeClient = () => ({
      getHistoricalTrades: async (from: Date, to: Date) => {
        fetchedWindows.push({
          from: from.toISOString(),
          to: to.toISOString(),
        });
        const res = windowResults[call] ?? [];
        call += 1;
        return res;
      },
    });

    // ~3.5y window so the year-by-year loop produces ≥4 windows.
    const toDate = new Date("2026-06-01T00:00:00Z");
    const fromDate = new Date("2022-12-01T00:00:00Z");
    const res = ok(
      await svc.syncHistoricalTradebook({
        userId: "owner",
        broker: "ZERODHA",
        fromDate,
        toDate,
      })
    );

    // The loop did NOT stop at the gap — it fetched at least the 4 windows.
    assert.ok(
      fetchedWindows.length >= 4,
      `expected ≥4 windows fetched, got ${fetchedWindows.length}`
    );
    // All three non-empty trades persisted (2 from year0 + 1 from year3).
    assert.equal(res.data!.synced, 3);

    // The oldest, post-gap trade (y3-a) actually reached the trade table.
    const tradeIds = prisma
      .callsFor("trade", "upsert")
      .map(
        (c) =>
          (c.args as { create: { brokerTradeId: string } }).create.brokerTradeId
      );
    assert.ok(
      tradeIds.includes("y3-a"),
      `the oldest post-gap trade must be persisted; got ${JSON.stringify(tradeIds)}`
    );
    assert.ok(tradeIds.includes("y0-a") && tradeIds.includes("y0-b"));
  });

  it("walks all the way to the params.fromDate floor even when EVERY year is empty (no early-exit)", async () => {
    prisma.seed("brokerConnection", [connRow()]);
    let windows = 0;
    broker.makeClient = () => ({
      getHistoricalTrades: async () => {
        windows += 1;
        return []; // always empty
      },
    });
    const toDate = new Date("2026-06-01T00:00:00Z");
    const fromDate = new Date("2023-06-01T00:00:00Z"); // ~3y → ~3 windows
    const res = ok(
      await svc.syncHistoricalTradebook({
        userId: "owner",
        broker: "ZERODHA",
        fromDate,
        toDate,
      })
    );
    assert.equal(res.data!.synced, 0);
    // Old code stopped after 2 empty windows; the fix walks the whole ~3y floor.
    assert.ok(
      windows >= 3,
      `expected the loop to reach the fromDate floor (≥3 windows), got ${windows}`
    );
  });

  it("each fetched window is bounded by the fromDate floor (no fetch older than the floor)", async () => {
    prisma.seed("brokerConnection", [connRow()]);
    const fromDate = new Date("2024-06-01T00:00:00Z");
    const toDate = new Date("2026-06-01T00:00:00Z");
    let minFrom = Infinity;
    broker.makeClient = () => ({
      getHistoricalTrades: async (from: Date) => {
        minFrom = Math.min(minFrom, from.getTime());
        return [];
      },
    });
    await svc.syncHistoricalTradebook({
      userId: "owner",
      broker: "ZERODHA",
      fromDate,
      toDate,
    });
    assert.ok(
      minFrom >= fromDate.getTime(),
      "no window may start before the fromDate floor"
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. PER-CONNECTION ERROR BOUNDARY (MONEY-846 #2)
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-846 — syncBrokerConnections per-connection isolation (LIVE)", () => {
  let prisma: RecordingPrisma;
  let broker: BrokerSeam;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    ({ prisma, broker } = reset());
  });
  after(() => {
    uninstallServices();
  });

  it("A throws on decrypt, B is healthy → B fully syncs + A returns a connectionError (batch NOT aborted)", async () => {
    // Two connections under a wildcard scheduled batch. A's ciphertext is corrupt
    // (decrypt throws BEFORE the per-type try/catch); B is fine. The loop must
    // record A's connection-level error and STILL sync B.
    prisma.seed("brokerConnection", [
      connRow({
        id: "A",
        userId: "userA",
        broker: "ZERODHA",
        brokerUserId: "AAA",
        encryptedCreds: "CORRUPT",
      }),
      connRow({
        id: "B",
        userId: "userB",
        broker: "UPSTOX",
        brokerUserId: "BBB",
        encryptedCreds: "GOOD",
      }),
    ]);
    broker.decrypt = (enc: string) => {
      if (enc === "CORRUPT") throw new Error("bad ciphertext / auth tag");
      return { accessToken: "ok" };
    };
    broker.makeClient = (b: string) =>
      b === "UPSTOX"
        ? {
            getHoldings: async () => [holding()],
            getTrades: async () => [trade()],
          }
        : {};

    const res = ok(
      await svc.syncBrokerConnections({
        userId: "*",
        dataTypes: ["holdings", "trades"],
      })
    );

    assert.equal(res.data!.connectionCount, 2);
    const byBroker = new Map(res.data!.perConnection.map((c) => [c.broker, c]));
    // A: connection-level error recorded, nothing synced, NOT a benign skip.
    const a = byBroker.get("ZERODHA")!;
    assert.ok(a.connectionError, "A must carry a connection-level error");
    assert.match(a.connectionError!, /ciphertext|auth tag/);
    assert.equal(a.skipped, false);
    // B: fully synced despite A's failure.
    const b = byBroker.get("UPSTOX")!;
    assert.equal(b.synced.holdings, 1);
    assert.equal(b.synced.trades, 1);
    assert.equal(b.connectionError, undefined);
    // Aggregate counts come from B only.
    assert.equal(res.data!.synced.holdings, 1);
    assert.equal(res.data!.synced.trades, 1);
    // B's holding actually persisted (proves the loop continued to completion).
    assert.equal(prisma.callsFor("holding", "createMany").length, 1);
    assert.equal(prisma.callsFor("trade", "upsert").length, 1);
  });

  it("the FIRST connection throwing does not stop the SECOND (order-independence)", async () => {
    prisma.seed("brokerConnection", [
      connRow({ id: "bad", broker: "ZERODHA", encryptedCreds: "CORRUPT" }),
      connRow({ id: "good", broker: "UPSTOX", encryptedCreds: "GOOD" }),
    ]);
    broker.decrypt = (enc: string) => {
      if (enc === "CORRUPT") throw new Error("decrypt fail");
      return { accessToken: "ok" };
    };
    broker.makeClient = (b: string) =>
      b === "UPSTOX" ? { getTrades: async () => [trade()] } : {};
    const res = ok(
      await svc.syncBrokerConnections({
        userId: "*",
        dataTypes: ["trades"],
      })
    );
    assert.equal(res.data!.synced.trades, 1);
    assert.equal(res.data!.perConnection.length, 2);
    assert.equal(
      res.data!.perConnection.filter((c) => c.connectionError).length,
      1
    );
  });

  // The live KP9460 + UN1836 shape: one healthy account, one whose token expired
  // overnight. The expired one is SKIPPED (classifyConnectionForSync, no decrypt)
  // and flips to NEEDS_REAUTH; the healthy one syncs. Only the expired flips.
  it("one healthy + one token-expired → healthy synced, expired skipped+authFailed, only expired flips NEEDS_REAUTH", async () => {
    prisma.seed("brokerConnection", [
      connRow({
        id: "KP9460",
        userId: "owner",
        broker: "ZERODHA",
        brokerUserId: "KP9460",
        status: "CONNECTED",
        tokenExpiry: new Date(Date.now() + 86_400_000), // future → healthy
      }),
      connRow({
        id: "UN1836",
        userId: "owner",
        broker: "UPSTOX",
        brokerUserId: "UN1836",
        status: "CONNECTED",
        tokenExpiry: new Date(Date.now() - 86_400_000), // past → expired
      }),
    ]);
    broker.makeClient = (b: string) =>
      b === "ZERODHA"
        ? {
            getHoldings: async () => [holding()],
            getTrades: async () => [trade()],
          }
        : {};

    const res = ok(
      await svc.syncBrokerConnections({
        userId: "owner",
        dataTypes: ["holdings", "trades"],
      })
    );

    const byId = new Map(res.data!.perConnection.map((c) => [c.broker, c]));
    const healthy = byId.get("ZERODHA")!;
    const expired = byId.get("UPSTOX")!;
    // Healthy synced.
    assert.equal(healthy.synced.holdings, 1);
    assert.equal(healthy.synced.trades, 1);
    assert.equal(healthy.skipped, false);
    // Expired: skipped, authFailed, reason token-expired, nothing synced.
    assert.equal(expired.skipped, true);
    assert.equal(expired.authFailed, true);
    assert.equal(expired.skipReason, "token-expired");
    assert.equal(expired.synced.holdings, undefined);

    // ONLY the expired connection's status was flipped to NEEDS_REAUTH.
    const reauthUpdates = prisma
      .callsFor("brokerConnection", "update")
      .filter(
        (c) =>
          (c.args as { data: { status?: string } }).data.status ===
          "NEEDS_REAUTH"
      );
    assert.equal(reauthUpdates.length, 1, "exactly one NEEDS_REAUTH flip");
    assert.equal(
      (reauthUpdates[0]!.args as { where: { id: string } }).where.id,
      "UN1836"
    );
    // The healthy connection only ever gets the success update (CONNECTED).
    const healthyUpdates = prisma
      .callsFor("brokerConnection", "update")
      .filter(
        (c) => (c.args as { where: { id: string } }).where.id === "KP9460"
      );
    assert.ok(healthyUpdates.length >= 1);
    for (const u of healthyUpdates) {
      assert.notEqual(
        (u.args as { data: { status?: string } }).data.status,
        "NEEDS_REAUTH"
      );
    }
  });

  it("a creds-less connection is a benign skip (no connectionError, no abort)", async () => {
    prisma.seed("brokerConnection", [
      connRow({ id: "nocreds", broker: "ZERODHA", encryptedCreds: null }),
      connRow({ id: "ok", broker: "UPSTOX", encryptedCreds: "GOOD" }),
    ]);
    broker.makeClient = (b: string) =>
      b === "UPSTOX" ? { getTrades: async () => [trade()] } : {};
    const res = ok(
      await svc.syncBrokerConnections({
        userId: "*",
        dataTypes: ["trades"],
      })
    );
    const byBroker = new Map(res.data!.perConnection.map((c) => [c.broker, c]));
    const nocreds = byBroker.get("ZERODHA")!;
    assert.equal(nocreds.skipped, true);
    assert.equal(nocreds.skipReason, "no-credentials");
    assert.equal(nocreds.connectionError, undefined); // skip ≠ error
    assert.equal(byBroker.get("UPSTOX")!.synced.trades, 1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. DELETE-CASCADE null/"" COALESCE (the flagship MONEY-846 fix)
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-846 — deleteBrokerConnection sweeps null AND '' rows (LIVE)", () => {
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

  const MODELS = [
    "pairedTradeView",
    "mutualFund",
    "holding",
    "position",
    "order",
    "trade",
  ] as const;

  it("null brokerUserId: data rows stored under the '' sentinel are ACTUALLY deleted for every model", async () => {
    // The connection has a NULL brokerUserId, but persist wrote its rows under
    // effectiveBrokerUserId = brokerUserId || "" = "". Seed each model with one
    // ""-keyed row (this connection's) + one foreign row that must survive.
    prisma.seed("brokerConnection", [
      connRow({ id: "owned-null", userId: "owner", brokerUserId: null }),
    ]);
    for (const m of MODELS) {
      prisma.seed(m, [
        { userId: "owner", broker: "ZERODHA", brokerUserId: "", tag: "mine" },
        {
          userId: "owner",
          broker: "ZERODHA",
          brokerUserId: "OTHER",
          tag: "foreign",
        },
      ]);
    }

    const res = ok(await svc.deleteBrokerConnection("owner", "owned-null"));
    assert.equal(res.success, true);

    for (const m of MODELS) {
      // The where coalesces null↔"".
      const where = (
        prisma.callsFor(m, "deleteMany")[0]!.args as {
          where: { OR?: Array<{ brokerUserId: string | null }> };
        }
      ).where;
      assert.deepEqual(
        where.OR,
        [{ brokerUserId: null }, { brokerUserId: "" }],
        `${m}: cascade must coalesce null↔""`
      );
      // And the ""-keyed row is GONE while the foreign row survives.
      const remaining = prisma.tables.get(m) ?? [];
      assert.equal(
        remaining.some((r) => r.tag === "mine"),
        false,
        `${m}: the ""-sentinel row must be deleted (no orphan)`
      );
      assert.equal(
        remaining.some((r) => r.tag === "foreign"),
        true,
        `${m}: a foreign brokerUserId row must NOT be swept`
      );
    }
    // The connection itself was deleted.
    assert.equal(prisma.callsFor("brokerConnection", "delete").length, 1);
  });

  it("a real brokerUserId is matched EXACTLY (no null/'' OR branch)", async () => {
    prisma.seed("brokerConnection", [
      connRow({ id: "owned", userId: "owner", brokerUserId: "ZR1" }),
    ]);
    for (const m of MODELS) {
      prisma.seed(m, [
        {
          userId: "owner",
          broker: "ZERODHA",
          brokerUserId: "ZR1",
          tag: "mine",
        },
        { userId: "owner", broker: "ZERODHA", brokerUserId: "", tag: "other" },
      ]);
    }
    const res = ok(await svc.deleteBrokerConnection("owner", "owned"));
    assert.equal(res.success, true);
    const where = (
      prisma.callsFor("trade", "deleteMany")[0]!.args as {
        where: { brokerUserId?: unknown; OR?: unknown };
      }
    ).where;
    assert.equal(where.brokerUserId, "ZR1");
    assert.equal(where.OR, undefined);
    // The "" row of the SAME (user,broker) is NOT swept when a real id is set.
    const remainingTrades = prisma.tables.get("trade") ?? [];
    assert.equal(
      remainingTrades.some((r) => r.tag === "other"),
      true,
      "an empty-sentinel row must survive an exact-id delete"
    );
  });

  it("empty-string brokerUserId also coalesces to OR:[null, '']", async () => {
    prisma.seed("brokerConnection", [
      connRow({ id: "owned-empty", userId: "owner", brokerUserId: "" }),
    ]);
    const res = ok(await svc.deleteBrokerConnection("owner", "owned-empty"));
    assert.equal(res.success, true);
    const where = (
      prisma.callsFor("trade", "deleteMany")[0]!.args as {
        where: { OR?: Array<{ brokerUserId: string | null }> };
      }
    ).where;
    assert.deepEqual(where.OR, [{ brokerUserId: null }, { brokerUserId: "" }]);
  });

  it("IDOR: a victim's connection is not deletable cross-user (no cascade fires)", async () => {
    prisma.seed("brokerConnection", [
      connRow({ id: "victim", userId: "victim" }),
    ]);
    const res = await svc.deleteBrokerConnection("attacker", "victim");
    assert.equal(res.success, false);
    assert.equal(res.code, "NOT_FOUND");
    assert.equal(prisma.callsFor("trade", "deleteMany").length, 0);
    assert.equal(prisma.callsFor("brokerConnection", "delete").length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. PERSIST IDEMPOTENCY
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-846 — persist idempotency (LIVE)", () => {
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

  it("persistTrades twice over identical input → no duplicate rows (upsert keyed by brokerTradeId)", async () => {
    const rows = [trade({ tradeId: "t1" }), trade({ tradeId: "t2" })];
    await svc.persistTrades("owner", "ZERODHA", "ZR1", rows);
    await svc.persistTrades("owner", "ZERODHA", "ZR1", rows);
    // 4 upsert CALLS (2 each pass) but only 2 distinct rows survive.
    assert.equal(prisma.callsFor("trade", "upsert").length, 4);
    const table = prisma.tables.get("trade") ?? [];
    assert.equal(table.length, 2, "re-running must not duplicate trades");
    const ids = table.map((r) => r.brokerTradeId).sort();
    assert.deepEqual(ids, ["t1", "t2"]);
  });

  it("persistTrades uses (userId, broker, brokerUserId, brokerTradeId); null brokerUserId → '' sentinel in the key", async () => {
    await svc.persistTrades("owner", "ZERODHA", null, [
      trade({ tradeId: "t9" }),
    ]);
    const key = (
      prisma.callsFor("trade", "upsert")[0]!.args as {
        where: {
          userId_broker_brokerUserId_brokerTradeId: {
            userId: string;
            broker: string;
            brokerUserId: string;
            brokerTradeId: string;
          };
        };
      }
    ).where.userId_broker_brokerUserId_brokerTradeId;
    assert.equal(key.userId, "owner");
    assert.equal(key.broker, "ZERODHA");
    assert.equal(key.brokerUserId, ""); // null coalesced to the "" sentinel
    assert.equal(key.brokerTradeId, "t9");
  });

  it("persistHoldings twice over identical input → table holds exactly one snapshot (atomic delete+insert)", async () => {
    const rows = [holding({ symbol: "INFY" }), holding({ symbol: "TCS" })];
    await svc.persistHoldings("owner", "ZERODHA", "ZR1", rows);
    await svc.persistHoldings("owner", "ZERODHA", "ZR1", rows);
    const table = prisma.tables.get("holding") ?? [];
    assert.equal(
      table.length,
      2,
      "delete+insert must replace, not append (no duplication on re-sync)"
    );
    // Two passes → two delete+create cycles, each scoped to this connection.
    assert.equal(prisma.callsFor("holding", "deleteMany").length, 2);
    assert.equal(prisma.callsFor("holding", "createMany").length, 2);
    const delWhere = (
      prisma.callsFor("holding", "deleteMany")[0]!.args as {
        where: { userId: string; broker: string; brokerUserId: string };
      }
    ).where;
    assert.equal(delWhere.userId, "owner");
    assert.equal(delWhere.broker, "ZERODHA");
    assert.equal(delWhere.brokerUserId, "ZR1");
  });

  it("persistHoldings([]) is a NO-OP — never wipes existing holdings (MONEY-582a skip-on-empty)", async () => {
    prisma.seed("holding", [
      {
        userId: "owner",
        broker: "ZERODHA",
        brokerUserId: "ZR1",
        symbol: "OLD",
      },
    ]);
    await svc.persistHoldings("owner", "ZERODHA", "ZR1", []);
    assert.equal(
      prisma.callsFor("holding", "deleteMany").length,
      0,
      "empty holdings must not trigger a delete"
    );
    const table = prisma.tables.get("holding") ?? [];
    assert.equal(table.length, 1, "existing holdings preserved on empty fetch");
  });
});
