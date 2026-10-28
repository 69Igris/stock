/**
 * MONEY-620 — notifications.service END-TO-END (real fns, recording prisma).
 *
 * Notifications are an IDOR-sensitive surface: every mutation must be scoped to
 * the caller's `userId` so user A can never mark/clear user B's rows. This file
 * drives the REAL exported functions and asserts the exact prisma `where`
 * clauses + the unread-count cache side-effects:
 *
 *   - getNotifications   → userId-scoped findMany, take/skip pagination, mapping
 *   - getUnreadCount     → cached count; 1-min in-memory TTL; invalidated by writes
 *   - markAsRead         → updateMany WHERE { id, userId } (BOTH — the IDOR guard)
 *   - markAllAsRead      → updateMany WHERE { userId, isRead:false }
 *   - clearAllRead       → deleteMany WHERE { userId, isRead:true } → returns count
 *   - error resilience   → getNotifications/getUnreadCount return success+empty on
 *                          DB outage (collection-missing tolerance), but writes
 *                          surface a sanitized failure.
 *
 * Seam: `notifications.service` hard-imports `prisma` from `@usemoney/database`
 * and `dbLogger` from `@usemoney/logger`. We inject a recording prisma double via
 * `require.cache` before requiring the `@usemoney/services` barrel (the proven
 * pattern from `webhooks-dodo-e2e.test.ts`). The service ALSO keeps a
 * module-scope `unreadCountCache` Map — because we require the barrel exactly
 * once and only swap the recording prisma per test, that real cache is exercised
 * across calls (we assert the second `getUnreadCount` skips the DB, and a
 * `markAsRead` busts it).
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: packages/services/src/notifications.service.ts
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
    if (method === "updateMany" || method === "deleteMany") return { count: 0 };
    if (method === "findFirst" || method === "findUnique") return null;
    return [];
  }

  readonly client: Record<
    string,
    Record<string, (args?: unknown) => Promise<unknown>>
  >;

  constructor() {
    const self = this;
    this.client = new Proxy(
      {},
      {
        get(target: Record<string, unknown>, model: string) {
          if (typeof model !== "string") return undefined;
          if (model === "then") return undefined;
          if (!(model in target)) {
            target[model] = new Proxy(
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
          }
          return target[model];
        },
      }
    ) as RecordingPrisma["client"];
  }

  callsFor(model: string, method: string): RecordedCall[] {
    return this.calls.filter((c) => c.model === model && c.method === method);
  }
}

// ── module-boundary injection (install once, swap per test) ─────────────────

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

let activePrisma = new RecordingPrisma();

const STABLE_PRISMA = new Proxy(
  {},
  {
    get(target: Record<string, unknown>, model: string) {
      if (typeof model !== "string") return undefined;
      if (model === "then") return undefined;
      if (!(model in target)) {
        target[model] = new Proxy(
          {},
          {
            get(_m, method: string) {
              return (args?: unknown) =>
                activePrisma.client[model]![method]!(args);
            },
          }
        );
      }
      return target[model];
    },
  }
);

interface NotificationsModule {
  getNotifications: (
    userId: string,
    limit?: number,
    skip?: number
  ) => Promise<
    { success: true; data: unknown[] } | { success: false; error: string }
  >;
  getUnreadCount: (
    userId: string
  ) => Promise<
    { success: true; data: number } | { success: false; error: string }
  >;
  markAsRead: (
    userId: string,
    notificationId: string
  ) => Promise<{ success: true } | { success: false; error: string }>;
  markAllAsRead: (
    userId: string
  ) => Promise<{ success: true } | { success: false; error: string }>;
  clearAllRead: (
    userId: string
  ) => Promise<
    { success: true; data: number } | { success: false; error: string }
  >;
}

let svc: NotificationsModule | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

function installServices(): NotificationsModule {
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
  // notifications.service has no @usemoney/core dep, but the barrel does — keep a
  // light no-op cache so requiring it doesn't connect to Redis/GCS.
  stub(
    require.resolve("@usemoney/core"),
    new Proxy(
      { __esModule: true },
      {
        get(_t, k: string) {
          if (k === "__esModule") return true;
          if (k === "getCached") return async () => null;
          return async () => {};
        },
      }
    )
  );
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
  svc = require("@usemoney/services") as NotificationsModule;
  return svc;
}

/** Restore the pre-stub module cache so nothing leaks to sibling test files. */
function uninstallServices(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.length = 0;
  svc = null;
}

function swapPrisma(): RecordingPrisma {
  activePrisma = new RecordingPrisma();
  return activePrisma;
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — notifications.service (real fns, recording prisma)", () => {
  let prisma: RecordingPrisma;
  let mod: NotificationsModule;

  before(() => {
    mod = installServices();
  });
  beforeEach(() => {
    prisma = swapPrisma();
  });
  // Restore the real module cache so our @usemoney/database / core / logger
  // stubs never leak into a sibling suite under the full `__tests__/**` glob.
  after(() => {
    uninstallServices();
  });

  describe("getNotifications", () => {
    it("queries userId-scoped, newest-first, with take/skip pagination", async () => {
      prisma.queue("notification", "findMany", []);
      await mod.getNotifications("user-n1", 15, 30);
      const args = prisma.callsFor("notification", "findMany")[0]!.args as {
        where: { userId: string };
        orderBy: Record<string, unknown>;
        take: number;
        skip: number;
      };
      assert.equal(args.where.userId, "user-n1");
      assert.deepEqual(args.orderBy, { createdAt: "desc" });
      assert.equal(args.take, 15);
      assert.equal(args.skip, 30);
    });

    it("defaults to limit 20 / skip 0", async () => {
      prisma.queue("notification", "findMany", []);
      await mod.getNotifications("user-n2");
      const args = prisma.callsFor("notification", "findMany")[0]!.args as {
        take: number;
        skip: number;
      };
      assert.equal(args.take, 20);
      assert.equal(args.skip, 0);
    });

    it("maps rows through (metadata + type passthrough)", async () => {
      const created = new Date("2026-06-01T08:00:00Z");
      prisma.queue("notification", "findMany", [
        {
          id: "ntf-1",
          type: "PRICE_ALERT",
          title: "TCS up 5%",
          message: "Your watched stock moved",
          metadata: { symbol: "TCS" },
          isRead: false,
          createdAt: created,
        },
      ]);
      const res = await mod.getNotifications("user-n3");
      assert.equal(res.success, true);
      const data = (res as { data: Array<Record<string, unknown>> }).data;
      assert.equal(data.length, 1);
      assert.equal(data[0]!.id, "ntf-1");
      assert.equal(data[0]!.type, "PRICE_ALERT");
      assert.deepEqual(data[0]!.metadata, { symbol: "TCS" });
    });

    it("tolerates a DB outage: returns success + empty (collection-missing)", async () => {
      prisma.fail(
        "notification",
        "findMany",
        new Error("ns not found: collection missing")
      );
      const res = await mod.getNotifications("user-n4");
      // Intentionally success:true with [] so the bell renders, but the error is
      // logged server-side (not asserted here — logger is silenced).
      assert.equal(res.success, true);
      assert.deepEqual((res as { data: unknown[] }).data, []);
    });
  });

  describe("getUnreadCount (with in-memory 1-min cache)", () => {
    it("counts only unread rows for the user, then caches the result", async () => {
      prisma.queue("notification", "count", 7);
      const res = await mod.getUnreadCount("user-uc1");
      assert.equal(res.success, true);
      assert.equal((res as { data: number }).data, 7);
      const args = prisma.callsFor("notification", "count")[0]!.args as {
        where: { userId: string; isRead: boolean };
      };
      assert.equal(args.where.userId, "user-uc1");
      assert.equal(args.where.isRead, false);
    });

    it("serves the SECOND call from cache (no second DB count)", async () => {
      prisma.queue("notification", "count", 3);
      const first = await mod.getUnreadCount("user-uc2");
      assert.equal((first as { data: number }).data, 3);
      // Second call within TTL → must NOT hit the DB again.
      const second = await mod.getUnreadCount("user-uc2");
      assert.equal((second as { data: number }).data, 3);
      assert.equal(
        prisma.callsFor("notification", "count").length,
        1,
        "unread count must be served from the in-memory cache on the 2nd call"
      );
    });

    it("tolerates a DB outage: returns success + 0", async () => {
      prisma.fail("notification", "count", new Error("connection refused"));
      const res = await mod.getUnreadCount("user-uc3");
      assert.equal(res.success, true);
      assert.equal((res as { data: number }).data, 0);
    });
  });

  describe("markAsRead — the IDOR guard", () => {
    it("scopes updateMany to BOTH the notification id AND the userId", async () => {
      prisma.queue("notification", "updateMany", { count: 1 });
      const res = await mod.markAsRead("owner-1", "ntf-42");
      assert.equal(res.success, true);
      const args = prisma.callsFor("notification", "updateMany")[0]!.args as {
        where: { id: string; userId: string };
        data: { isRead: boolean };
      };
      // CRITICAL: a bare { id } would let any user mark anyone's notification.
      assert.equal(args.where.id, "ntf-42");
      assert.equal(args.where.userId, "owner-1");
      assert.equal(args.data.isRead, true);
    });

    it("busts the unread-count cache so the next count re-queries the DB", async () => {
      // Prime the cache for this user.
      prisma.queue("notification", "count", 5);
      await mod.getUnreadCount("user-bust");
      assert.equal(prisma.callsFor("notification", "count").length, 1);

      // Mark one as read → invalidates the cached count.
      prisma.queue("notification", "updateMany", { count: 1 });
      await mod.markAsRead("user-bust", "ntf-x");

      // Next count must hit the DB again (cache was invalidated).
      prisma.queue("notification", "count", 4);
      const after = await mod.getUnreadCount("user-bust");
      assert.equal((after as { data: number }).data, 4);
      assert.equal(
        prisma.callsFor("notification", "count").length,
        2,
        "markAsRead must invalidate the unread-count cache"
      );
    });

    it("surfaces a sanitized error when the update throws", async () => {
      prisma.fail("notification", "updateMany", new Error("write conflict"));
      const res = await mod.markAsRead("user-e", "ntf-e");
      assert.equal(res.success, false);
      assert.equal(
        (res as { error: string }).error,
        "Failed to update notification"
      );
    });
  });

  describe("markAllAsRead", () => {
    it("updates only the user's UNREAD rows", async () => {
      prisma.queue("notification", "updateMany", { count: 9 });
      const res = await mod.markAllAsRead("user-all");
      assert.equal(res.success, true);
      const args = prisma.callsFor("notification", "updateMany")[0]!.args as {
        where: { userId: string; isRead: boolean };
        data: { isRead: boolean };
      };
      assert.equal(args.where.userId, "user-all");
      assert.equal(args.where.isRead, false); // only flip the unread ones
      assert.equal(args.data.isRead, true);
    });
  });

  describe("clearAllRead", () => {
    it("deletes only the user's READ rows and returns the deleted count", async () => {
      prisma.queue("notification", "deleteMany", { count: 12 });
      const res = await mod.clearAllRead("user-clear");
      assert.equal(res.success, true);
      assert.equal((res as { data: number }).data, 12);
      const args = prisma.callsFor("notification", "deleteMany")[0]!.args as {
        where: { userId: string; isRead: boolean };
      };
      // IDOR + safety: scoped to this user, and never deletes UNREAD rows.
      assert.equal(args.where.userId, "user-clear");
      assert.equal(args.where.isRead, true);
    });

    it("surfaces a sanitized error when the delete throws", async () => {
      prisma.fail("notification", "deleteMany", new Error("E11000 boom"));
      const res = await mod.clearAllRead("user-ce");
      assert.equal(res.success, false);
      assert.equal(
        (res as { error: string }).error,
        "Failed to clear notifications"
      );
    });
  });
});
