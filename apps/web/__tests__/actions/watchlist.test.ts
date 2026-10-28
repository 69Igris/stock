/**
 * MONEY-620 — watchlist.service CRUD functional + edge coverage (REAL fns).
 *
 * DE-SHADOWED (was a shadow): the prior revision re-declared the whole feature
 * inline — `calculateNextSortOrder`, `verifyOwnership`, `isDuplicate`,
 * `generateReorderUpdates`, `mapWatchlistData`, `hasNameConflict`,
 * `resolveWatchlistType`, `calculateBatchSortOrders`, … — and asserted those
 * COPIES. It imported nothing from source, so the real
 * `packages/services/src/watchlist.service.ts` could regress (wrong sort-order
 * base, missing dedup, dropped name-conflict guard) while the suite stayed
 * green. This file drives the REAL exported service functions from
 * `@usemoney/services` through a recording-prisma stub and asserts the actual
 * behaviour + Prisma query shapes that ship.
 *
 * The IDOR / cross-user ownership contract lives in the sibling
 * `__tests__/security/watchlist-reorder-idor.test.ts`. This file covers the
 * functional + edge surface:
 *   - getWatchlists: cache-hit short-circuit, cache-miss → userId-scoped
 *     findMany + correct ordering + itemCount mapping, EMPTY list, cache-set.
 *   - createWatchlist: name-uniqueness guard (duplicate name rejected, no
 *     create), type DEFAULT → "STOCK", explicit "MF" preserved, cache bust.
 *   - addWatchlistItem: next sortOrder = (max ?? -1) + 1 — boundary at 0 (empty)
 *     and at an existing max; duplicate symbol add is an UPSERT (idempotent, no
 *     throw, no second row); cache bust.
 *   - batchAddWatchlistItems: sequential sortOrders from the next base; empty
 *     items → addedCount 0; addedCount echoes items.length.
 *   - updateWatchlist: rename conflict guard (id { not } self-scoped); partial
 *     update only sends provided fields.
 *   - error path: a thrown Prisma error is sanitized to a friendly ServiceResult
 *     (never leaks), not re-thrown.
 *
 * Seam: identical to the IDOR sibling — inject recording/no-op doubles for
 * `@usemoney/database`, `@usemoney/logger`, `@usemoney/core` via `require.cache`
 * before requiring the `@usemoney/services` barrel. `$transaction([...])`
 * resolves like Prisma so the real batch loop executes.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: packages/services/src/watchlist.service.ts
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

  queue(model: string, method: string, result: unknown): void {
    const key = `${model}.${method}`;
    const q = this.queues.get(key) ?? [];
    q.push(result);
    this.queues.set(key, q);
  }

  fail(model: string, method: string, error: Error): void {
    this.queue(model, method, { __throw: error });
  }

  private next(model: string, method: string): unknown {
    const q = this.queues.get(`${model}.${method}`);
    if (q && q.length > 0) {
      const v = q.shift();
      if (v && typeof v === "object" && "__throw" in v) {
        throw (v as { __throw: Error }).__throw;
      }
      return v;
    }
    if (method === "count") return 0;
    if (method === "updateMany" || method === "deleteMany") return { count: 0 };
    if (method === "findFirst" || method === "findUnique") return null;
    if (method === "create" || method === "update" || method === "upsert")
      return {};
    return [];
  }

  readonly client: Record<string, unknown>;

  constructor() {
    const self = this;
    const model = (name: string) =>
      new Proxy(
        {},
        {
          get(_m, method: string) {
            return (args?: unknown) => {
              self.calls.push({ model: name, method, args });
              try {
                return Promise.resolve(self.next(name, method));
              } catch (e) {
                return Promise.reject(e);
              }
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
            return (arg: unknown) => {
              if (typeof arg === "function") {
                return Promise.resolve(
                  (arg as (tx: unknown) => unknown)(self.client)
                );
              }
              return Promise.all(arg as unknown[]);
            };
          }
          if (!(prop in target)) target[prop] = model(prop);
          return target[prop];
        },
      }
    ) as Record<string, unknown>;
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

// Records cache writes so we can assert the watchlist cache is set/cleared.
interface CacheEvent {
  op: "get" | "set" | "clear";
  ns?: string;
  userId?: string;
  key?: string;
}
let cacheEvents: CacheEvent[] = [];
let cacheHit: unknown = null; // what getCached returns this test

function makeCoreStub(): Record<string, unknown> {
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getCached")
          return async (ns: string, userId: string, key: string) => {
            cacheEvents.push({ op: "get", ns, userId, key });
            return cacheHit;
          };
        if (k === "setCached")
          return async (ns: string, userId: string, key: string) => {
            cacheEvents.push({ op: "set", ns, userId, key });
          };
        if (k === "clearWatchlistCache")
          return async (userId: string) => {
            cacheEvents.push({ op: "clear", userId });
          };
        return async () => undefined;
      },
    }
  );
}

let activePrisma = new RecordingPrisma();
const STABLE_PRISMA = new Proxy(
  {},
  {
    get(target: Record<string, unknown>, prop: string) {
      if (typeof prop !== "string") return undefined;
      if (prop === "then") return undefined;
      return (activePrisma.client as Record<string, unknown>)[prop];
    },
  }
);

interface WatchlistRow {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  type: string;
  isDefault: boolean;
  order: number;
  updatedAt: Date;
  items: Array<{
    id: string;
    symbol: string;
    exchange: string;
    instrumentId: string | null;
    sortOrder: number;
    addedAt: Date;
  }>;
}

interface WatchlistModule {
  getWatchlists: (
    userId: string
  ) => Promise<
    { success: true; data: WatchlistRow[] } | { success: false; error: string }
  >;
  createWatchlist: (
    userId: string,
    data: {
      name: string;
      description?: string;
      color?: string;
      icon?: string;
      type?: "STOCK" | "MF";
    }
  ) => Promise<
    | { success: true; data: { type: string; id: string } }
    | { success: false; error: string }
  >;
  updateWatchlist: (
    userId: string,
    watchlistId: string,
    data: { name?: string; color?: string | null }
  ) => Promise<{ success: boolean; error?: string }>;
  addWatchlistItem: (
    userId: string,
    data: {
      watchlistId: string;
      symbol: string;
      exchange: string;
      instrumentId?: string;
    }
  ) => Promise<{ success: boolean; error?: string }>;
  batchAddWatchlistItems: (
    userId: string,
    data: {
      watchlistId: string;
      items: Array<{ symbol: string; exchange: string; instrumentId?: string }>;
    }
  ) => Promise<
    | { success: true; data: { addedCount: number } }
    | { success: false; error: string }
  >;
}

let svc: WatchlistModule | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

function installServices(): WatchlistModule {
  if (svc) return svc;
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
  stub(require.resolve("@usemoney/logger"), makeLoggerStub());
  stub(require.resolve("@usemoney/core"), makeCoreStub());
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/packages/services/src/") &&
      (key.endsWith(".service.ts") || key.endsWith("/index.ts"))
    ) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  svc = require("@usemoney/services") as WatchlistModule;
  return svc;
}

function uninstallServices(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.length = 0;
  svc = null;
}

function resetState(): RecordingPrisma {
  activePrisma = new RecordingPrisma();
  cacheEvents = [];
  cacheHit = null;
  return activePrisma;
}

function makeRow(over: Partial<WatchlistRow> = {}): WatchlistRow {
  return {
    id: "wl-1",
    name: "My Watchlist",
    description: null,
    color: null,
    icon: null,
    type: "STOCK",
    isDefault: false,
    order: 0,
    updatedAt: new Date("2026-06-01"),
    items: [],
    ...over,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — watchlist.service CRUD (real fns)", () => {
  let prisma: RecordingPrisma;
  let mod: WatchlistModule;

  before(() => {
    mod = installServices();
  });
  beforeEach(() => {
    prisma = resetState();
  });
  after(() => {
    uninstallServices();
  });

  // ───────────────────────────── getWatchlists ─────────────────────────────
  describe("getWatchlists", () => {
    it("cache HIT short-circuits: returns cached data, no DB read, no cache set", async () => {
      cacheHit = [makeRow({ id: "cached-wl", items: [] })];
      const res = await mod.getWatchlists("u1");
      assert.equal(res.success, true);
      assert.equal((res as { data: WatchlistRow[] }).data[0]!.id, "cached-wl");
      assert.equal(
        prisma.callsFor("watchList", "findMany").length,
        0,
        "a cache hit must not hit Prisma"
      );
      assert.equal(
        cacheEvents.filter((e) => e.op === "set").length,
        0,
        "a cache hit must not re-set the cache"
      );
    });

    it("cache MISS → userId-scoped findMany, correct include+ordering, then cache set", async () => {
      cacheHit = null;
      prisma.queue("watchList", "findMany", [
        makeRow({
          id: "wl-1",
          items: [
            {
              id: "i1",
              symbol: "RELIANCE",
              exchange: "NSE",
              instrumentId: null,
              sortOrder: 0,
              addedAt: new Date("2026-01-01"),
            },
            {
              id: "i2",
              symbol: "TCS",
              exchange: "NSE",
              instrumentId: null,
              sortOrder: 1,
              addedAt: new Date("2026-01-02"),
            },
          ],
        }),
      ]);
      const res = await mod.getWatchlists("u1");
      assert.equal(res.success, true);
      const data = (res as { data: WatchlistRow[] }).data;
      assert.equal(data[0]!.id, "wl-1");
      // itemCount mapping
      assert.equal(
        (data[0] as unknown as { itemCount: number }).itemCount,
        2,
        "itemCount must equal items.length"
      );

      const args = prisma.callsFor("watchList", "findMany")[0]!.args as {
        where: { userId: string };
        include: { items: { orderBy: { sortOrder: string } } };
        orderBy: Array<Record<string, string>>;
      };
      assert.equal(
        args.where.userId,
        "u1",
        "list must be scoped to the caller"
      );
      assert.equal(args.include.items.orderBy.sortOrder, "asc");
      // ordering: isDefault desc, order asc, createdAt asc
      assert.deepEqual(args.orderBy, [
        { isDefault: "desc" },
        { order: "asc" },
        { createdAt: "asc" },
      ]);
      assert.equal(
        cacheEvents.filter((e) => e.op === "set").length,
        1,
        "a cache miss must populate the cache"
      );
    });

    it("EMPTY list → success + [] (empty-state path)", async () => {
      cacheHit = null;
      prisma.queue("watchList", "findMany", []);
      const res = await mod.getWatchlists("u-empty");
      assert.equal(res.success, true);
      assert.deepEqual((res as { data: WatchlistRow[] }).data, []);
    });

    it("DB throws → sanitized failure ServiceResult (never leaks, never re-throws)", async () => {
      cacheHit = null;
      prisma.fail(
        "watchList",
        "findMany",
        new Error("ECONNREFUSED mongo:27017")
      );
      const res = await mod.getWatchlists("u-err");
      assert.equal(res.success, false);
      assert.equal(
        (res as { error: string }).error,
        "Failed to load watchlists"
      );
      assert.ok(
        !(res as { error: string }).error.includes("ECONNREFUSED"),
        "raw DB error must not leak to the caller"
      );
    });
  });

  // ───────────────────────────── createWatchlist ─────────────────────────────
  describe("createWatchlist", () => {
    it("duplicate NAME is rejected (name-uniqueness guard) — no create runs", async () => {
      prisma.queue("watchList", "findFirst", {
        id: "existing",
        name: "Tech",
      });
      const res = await mod.createWatchlist("u1", { name: "Tech" });
      assert.equal(res.success, false);
      assert.equal(
        (res as { error: string }).error,
        "A watchlist with this name already exists"
      );
      // the conflict check is scoped to { userId, name }
      const check = prisma.callsFor("watchList", "findFirst")[0]!.args as {
        where: { userId: string; name: string };
      };
      assert.equal(check.where.userId, "u1");
      assert.equal(check.where.name, "Tech");
      assert.equal(
        prisma.callsFor("watchList", "create").length,
        0,
        "no create may run on a name conflict"
      );
    });

    it("type DEFAULTS to STOCK when omitted; create carries userId + type", async () => {
      prisma.queue("watchList", "findFirst", null); // no conflict
      prisma.queue(
        "watchList",
        "create",
        makeRow({ id: "new", type: "STOCK" })
      );
      const res = await mod.createWatchlist("u1", { name: "Fresh" });
      assert.equal(res.success, true);
      assert.equal((res as { data: { type: string } }).data.type, "STOCK");
      const created = prisma.callsFor("watchList", "create")[0]!.args as {
        data: { userId: string; name: string; type: string };
      };
      assert.equal(created.data.userId, "u1");
      assert.equal(created.data.name, "Fresh");
      assert.equal(
        created.data.type,
        "STOCK",
        "type must default to STOCK (data.type ?? 'STOCK')"
      );
    });

    it("explicit MF type is preserved through create", async () => {
      prisma.queue("watchList", "findFirst", null);
      prisma.queue("watchList", "create", makeRow({ id: "mf", type: "MF" }));
      const res = await mod.createWatchlist("u1", {
        name: "Funds",
        type: "MF",
      });
      assert.equal(res.success, true);
      const created = prisma.callsFor("watchList", "create")[0]!.args as {
        data: { type: string };
      };
      assert.equal(created.data.type, "MF");
    });

    it("a successful create busts the watchlist cache for the user", async () => {
      prisma.queue("watchList", "findFirst", null);
      prisma.queue("watchList", "create", makeRow({ id: "c" }));
      await mod.createWatchlist("u-cache", { name: "X" });
      const cleared = cacheEvents.find(
        (e) => e.op === "clear" && e.userId === "u-cache"
      );
      assert.ok(cleared, "create must clearWatchlistCache(userId)");
    });

    // MONEY-1062: an absent name used to reach `findFirst({ where: { userId,
    // name: undefined } })` — Prisma DROPS an undefined where-value, so the
    // uniqueness probe matched ANY of the user's watchlists (bogus "already
    // exists", or a NULL/blank-named row on an empty account). The guard now
    // rejects up front with INVALID_INPUT and must issue NO queries at all.
    it("MONEY-1062: an undefined name is rejected with INVALID_INPUT — no findFirst with undefined name, no create", async () => {
      const res = await mod.createWatchlist("u1", {
        name: undefined as unknown as string,
      });
      assert.equal(res.success, false);
      assert.equal(
        (res as { success: false; error: string; code?: string }).code,
        "INVALID_INPUT"
      );
      assert.equal(
        (res as { error: string }).error,
        "Watchlist name is required"
      );
      assert.equal(
        prisma.callsFor("watchList", "findFirst").length,
        0,
        "the uniqueness probe must NOT run with an undefined name (it would match ANY row)"
      );
      assert.equal(
        prisma.callsFor("watchList", "create").length,
        0,
        "no create may run without a real name"
      );
    });

    it("MONEY-1062: an empty / whitespace-only name is rejected with INVALID_INPUT (no queries)", async () => {
      for (const bad of ["", "   "]) {
        const res = await mod.createWatchlist("u1", { name: bad });
        assert.equal(
          res.success,
          false,
          `name ${JSON.stringify(bad)} must reject`
        );
        assert.equal(
          (res as { success: false; code?: string }).code,
          "INVALID_INPUT"
        );
      }
      assert.equal(prisma.callsFor("watchList", "findFirst").length, 0);
      assert.equal(prisma.callsFor("watchList", "create").length, 0);
    });
  });

  // ───────────────────────────── addWatchlistItem ─────────────────────────────
  describe("addWatchlistItem — next sort order boundary + duplicate dedup", () => {
    it("EMPTY watchlist → first item gets sortOrder 0 ((-1)+1 boundary)", async () => {
      prisma.queue("watchList", "findFirst", { id: "wl-1", userId: "u1" });
      prisma.queue("watchlistItem", "findFirst", null); // no existing items
      const res = await mod.addWatchlistItem("u1", {
        watchlistId: "wl-1",
        symbol: "RELIANCE",
        exchange: "NSE",
      });
      assert.equal(res.success, true);
      const up = prisma.callsFor("watchlistItem", "upsert")[0]!.args as {
        create: { sortOrder: number };
      };
      assert.equal(
        up.create.sortOrder,
        0,
        "first item base is (lastItem?.sortOrder ?? -1) + 1 = 0"
      );
    });

    it("existing max sortOrder 4 → new item gets 5 (max+1)", async () => {
      prisma.queue("watchList", "findFirst", { id: "wl-1", userId: "u1" });
      prisma.queue("watchlistItem", "findFirst", { sortOrder: 4 });
      await mod.addWatchlistItem("u1", {
        watchlistId: "wl-1",
        symbol: "TCS",
        exchange: "NSE",
      });
      const up = prisma.callsFor("watchlistItem", "upsert")[0]!.args as {
        create: { sortOrder: number };
      };
      assert.equal(up.create.sortOrder, 5);
      // and it queried the max via orderBy sortOrder desc
      const maxQ = prisma.callsFor("watchlistItem", "findFirst")[0]!.args as {
        where: { watchlistId: string };
        orderBy: { sortOrder: string };
      };
      assert.equal(maxQ.where.watchlistId, "wl-1");
      assert.equal(maxQ.orderBy.sortOrder, "desc");
    });

    it("DUPLICATE symbol add is an idempotent UPSERT (update:{} no-op) — no throw, no second row", async () => {
      prisma.queue("watchList", "findFirst", { id: "wl-1", userId: "u1" });
      prisma.queue("watchlistItem", "findFirst", { sortOrder: 0 });
      const res = await mod.addWatchlistItem("u1", {
        watchlistId: "wl-1",
        symbol: "RELIANCE",
        exchange: "NSE",
      });
      assert.equal(res.success, true);
      const up = prisma.callsFor("watchlistItem", "upsert")[0]!.args as {
        where: { watchlistId_symbol_exchange: unknown };
        update: Record<string, unknown>;
      };
      // dedup is enforced by the composite unique key + an empty update payload:
      assert.ok(
        up.where.watchlistId_symbol_exchange,
        "dedup relies on the (watchlistId, symbol, exchange) composite key"
      );
      assert.deepEqual(
        up.update,
        {},
        "duplicate add must be a no-op update (idempotent), not a new insert"
      );
    });
  });

  // ─────────────────────────── batchAddWatchlistItems ───────────────────────────
  describe("batchAddWatchlistItems — sequential sort orders + counts", () => {
    it("assigns sequential sortOrders from the next base (base 3 → 3,4,5)", async () => {
      prisma.queue("watchList", "findFirst", { id: "wl-1", userId: "u1" });
      prisma.queue("watchlistItem", "findFirst", { sortOrder: 2 }); // base = 3
      const res = await mod.batchAddWatchlistItems("u1", {
        watchlistId: "wl-1",
        items: [
          { symbol: "A", exchange: "NSE" },
          { symbol: "B", exchange: "NSE" },
          { symbol: "C", exchange: "NSE" },
        ],
      });
      assert.equal(res.success, true);
      assert.equal(
        (res as { data: { addedCount: number } }).data.addedCount,
        3
      );
      const upserts = prisma.callsFor("watchlistItem", "upsert");
      assert.equal(upserts.length, 3);
      const orders = upserts.map(
        (u) => (u.args as { create: { sortOrder: number } }).create.sortOrder
      );
      assert.deepEqual(orders, [3, 4, 5]);
    });

    it("base is 0 for an empty watchlist (findFirst → null)", async () => {
      prisma.queue("watchList", "findFirst", { id: "wl-1", userId: "u1" });
      prisma.queue("watchlistItem", "findFirst", null);
      await mod.batchAddWatchlistItems("u1", {
        watchlistId: "wl-1",
        items: [
          { symbol: "A", exchange: "NSE" },
          { symbol: "B", exchange: "NSE" },
        ],
      });
      const orders = prisma
        .callsFor("watchlistItem", "upsert")
        .map(
          (u) => (u.args as { create: { sortOrder: number } }).create.sortOrder
        );
      assert.deepEqual(orders, [0, 1]);
    });

    it("EMPTY items → addedCount 0, no upsert, no max query (short-circuit)", async () => {
      prisma.queue("watchList", "findFirst", { id: "wl-1", userId: "u1" });
      const res = await mod.batchAddWatchlistItems("u1", {
        watchlistId: "wl-1",
        items: [],
      });
      assert.equal(res.success, true);
      assert.equal(
        (res as { data: { addedCount: number } }).data.addedCount,
        0
      );
      assert.equal(prisma.callsFor("watchlistItem", "upsert").length, 0);
      assert.equal(
        prisma.callsFor("watchlistItem", "findFirst").length,
        0,
        "empty batch must short-circuit before the max-sortOrder query"
      );
    });
  });

  // ───────────────────────────── updateWatchlist ─────────────────────────────
  describe("updateWatchlist — rename conflict + partial fields", () => {
    it("rename to an EXISTING name (other row) is rejected; conflict query excludes self via id { not }", async () => {
      // 1st findFirst = ownership gate (own it); 2nd = conflict check (a clash).
      prisma.queue("watchList", "findFirst", {
        id: "wl-1",
        userId: "u1",
        name: "Old",
      });
      prisma.queue("watchList", "findFirst", { id: "other", name: "Taken" });
      const res = await mod.updateWatchlist("u1", "wl-1", { name: "Taken" });
      assert.equal(res.success, false);
      assert.equal(
        (res as { error: string }).error,
        "A watchlist with this name already exists"
      );
      const conflict = prisma.callsFor("watchList", "findFirst")[1]!.args as {
        where: { userId: string; name: string; id: { not: string } };
      };
      assert.equal(conflict.where.userId, "u1");
      assert.equal(conflict.where.name, "Taken");
      assert.equal(
        conflict.where.id.not,
        "wl-1",
        "conflict check must exclude the row being renamed (id { not })"
      );
      assert.equal(prisma.callsFor("watchList", "update").length, 0);
    });

    it("partial update only sends the provided fields (color set, name untouched)", async () => {
      prisma.queue("watchList", "findFirst", {
        id: "wl-1",
        userId: "u1",
        name: "Keep",
      });
      const res = await mod.updateWatchlist("u1", "wl-1", { color: "#00ff00" });
      assert.equal(res.success, true);
      const upd = prisma.callsFor("watchList", "update")[0]!.args as {
        where: { id: string };
        data: Record<string, unknown>;
      };
      assert.equal(upd.where.id, "wl-1");
      assert.equal(upd.data.color, "#00ff00");
      assert.ok(
        !("name" in upd.data),
        "an undefined field must be omitted from the update payload"
      );
    });

    it("renaming to the SAME current name skips the conflict query (early equality)", async () => {
      prisma.queue("watchList", "findFirst", {
        id: "wl-1",
        userId: "u1",
        name: "Same",
      });
      const res = await mod.updateWatchlist("u1", "wl-1", { name: "Same" });
      assert.equal(res.success, true);
      // only the ownership gate ran — no second (conflict) findFirst.
      assert.equal(
        prisma.callsFor("watchList", "findFirst").length,
        1,
        "no conflict check when the name is unchanged"
      );
      assert.equal(prisma.callsFor("watchList", "update").length, 1);
    });
  });
});
