/**
 * MONEY-620 — notifications.service IDOR + negative/edge coverage (REAL fns).
 *
 * Sibling of `__tests__/services/notifications-service-e2e.test.ts` (the
 * happy-path / cache contract). This file is the SECURITY + edge guard: it
 * drives the REAL exported service functions through a recording-prisma stub and
 * pins the bug classes from the MONEY-620 brief —
 *
 *   IDOR (highest priority): every mutation MUST be scoped to the CALLER's
 *   userId. We assert the prisma WHERE clause always carries the caller's userId
 *   for:
 *     - mark-as-read on an ALREADY-read notification  (updateMany count 0, no throw)
 *     - mark-as-read on a NONEXISTENT notification      (updateMany count 0, no throw)
 *     - mark-as-read on ANOTHER USER's notification id  (WHERE.userId = caller, NOT victim → matches 0 rows)
 *     - mark-as-read with a malformed / empty id         (still userId-scoped)
 *   plus markAllAsRead / clearAllRead never touch another user's rows.
 *
 *   Empty / no-op edges:
 *     - clear-all-read when there are NO read rows → returns 0, no throw
 *     - empty notification list → success + []
 *
 *   Pagination clamping (regression for the bug fixed in this ticket):
 *     - negative / NaN / huge skip+limit are CLAMPED before reaching Prisma
 *       (take ∈ [1,100], skip ≥ 0) — Prisma never sees a non-finite/negative take.
 *
 *   Unread count: 0 / all-read / all-unread.
 *
 * Seam: `notifications.service` hard-imports `prisma` from `@usemoney/database`
 * + `dbLogger` from `@usemoney/logger`. We inject a recording prisma double via
 * `require.cache` BEFORE requiring the `@usemoney/services` barrel (the proven
 * pattern from `webhooks-dodo-e2e.test.ts`). The service keeps a module-scope
 * `unreadCountCache` Map; we use DISTINCT userIds per case so cached state can't
 * bleed between the count assertions.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: packages/services/src/notifications.service.ts
 *         packages/services/src/notifications-pagination.ts
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

// ── module-boundary injection (install once, swap prisma per test) ──────────

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
  // The barrel pulls @usemoney/core (Redis/GCS) transitively; a light no-op keeps
  // requiring it from connecting anywhere.
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
      (key.endsWith(".service.ts") ||
        key.endsWith("/index.ts") ||
        key.endsWith("notifications-pagination.ts"))
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

describe("MONEY-620 — notifications.service IDOR + edge (real fns)", () => {
  let prisma: RecordingPrisma;
  let mod: NotificationsModule;

  before(() => {
    mod = installServices();
  });
  beforeEach(() => {
    prisma = swapPrisma();
  });
  after(() => {
    uninstallServices();
  });

  // ───────────────────────── IDOR: markAsRead ─────────────────────────
  describe("markAsRead — IDOR scoping (every mutation carries the caller's userId)", () => {
    it("ALREADY-read notification: updateMany matched 0, returns success (no throw)", async () => {
      // updateMany on an already-read row simply matches it (or 0 if already
      // read with the same data) — either way the service must not throw.
      prisma.queue("notification", "updateMany", { count: 0 });
      const res = await mod.markAsRead("owner-1", "already-read-ntf");
      assert.equal(res.success, true);
      const where = (
        prisma.callsFor("notification", "updateMany")[0]!.args as {
          where: { id: string; userId: string };
        }
      ).where;
      assert.equal(where.id, "already-read-ntf");
      assert.equal(where.userId, "owner-1");
    });

    it("NONEXISTENT notification: updateMany count 0, returns success (idempotent no-op)", async () => {
      prisma.queue("notification", "updateMany", { count: 0 });
      const res = await mod.markAsRead("owner-1", "does-not-exist");
      assert.equal(res.success, true);
      const where = (
        prisma.callsFor("notification", "updateMany")[0]!.args as {
          where: { id: string; userId: string };
        }
      ).where;
      assert.equal(where.userId, "owner-1");
    });

    it("ANOTHER USER's notification: WHERE.userId is the CALLER (attacker), never the victim", async () => {
      // The IDOR guard: attacker passes the victim's notification id. Because the
      // where clause pins userId to the AUTHENTICATED caller (attacker), the
      // updateMany can only ever match attacker-owned rows → 0 here.
      prisma.queue("notification", "updateMany", { count: 0 });
      const res = await mod.markAsRead("attacker-user", "victims-notif-id");
      assert.equal(res.success, true);
      const where = (
        prisma.callsFor("notification", "updateMany")[0]!.args as {
          where: { id: string; userId: string };
        }
      ).where;
      // CRITICAL: a bare { id } (no userId) would flip the victim's row to read.
      assert.equal(
        where.userId,
        "attacker-user",
        "mutation must be scoped to the caller, not the target row's owner"
      );
      assert.equal(where.id, "victims-notif-id");
      assert.ok(
        "userId" in where,
        "where MUST include userId (IDOR guard) — never id-only"
      );
    });

    it("MALFORMED / empty id is still userId-scoped (no unscoped fallthrough)", async () => {
      prisma.queue("notification", "updateMany", { count: 0 });
      const res = await mod.markAsRead("owner-2", "");
      assert.equal(res.success, true);
      const where = (
        prisma.callsFor("notification", "updateMany")[0]!.args as {
          where: { id: string; userId: string };
        }
      ).where;
      assert.equal(where.id, "");
      assert.equal(where.userId, "owner-2");
    });
  });

  // ──────────────── IDOR: markAllAsRead / clearAllRead ────────────────
  describe("markAllAsRead — scoped to the caller's UNREAD rows only", () => {
    it("WHERE carries the caller userId and isRead:false (never another user)", async () => {
      prisma.queue("notification", "updateMany", { count: 3 });
      const res = await mod.markAllAsRead("bulk-owner");
      assert.equal(res.success, true);
      const where = (
        prisma.callsFor("notification", "updateMany")[0]!.args as {
          where: { userId: string; isRead: boolean };
        }
      ).where;
      assert.equal(where.userId, "bulk-owner");
      assert.equal(where.isRead, false);
    });

    it("no unread rows → count 0, still success (no throw)", async () => {
      prisma.queue("notification", "updateMany", { count: 0 });
      const res = await mod.markAllAsRead("bulk-empty");
      assert.equal(res.success, true);
    });
  });

  describe("clearAllRead — scoped to the caller's READ rows only", () => {
    it("WHERE carries the caller userId and isRead:true; returns deleted count", async () => {
      prisma.queue("notification", "deleteMany", { count: 5 });
      const res = await mod.clearAllRead("clear-owner");
      assert.equal(res.success, true);
      assert.equal((res as { data: number }).data, 5);
      const where = (
        prisma.callsFor("notification", "deleteMany")[0]!.args as {
          where: { userId: string; isRead: boolean };
        }
      ).where;
      assert.equal(where.userId, "clear-owner");
      assert.equal(where.isRead, true);
    });

    it("clear-all-read when there are NONE → returns 0, no throw (no-op)", async () => {
      prisma.queue("notification", "deleteMany", { count: 0 });
      const res = await mod.clearAllRead("clear-none");
      assert.equal(res.success, true);
      assert.equal((res as { data: number }).data, 0);
      // It still issues a scoped delete (idempotent) rather than skipping.
      assert.equal(prisma.callsFor("notification", "deleteMany").length, 1);
    });
  });

  // ───────────────────── pagination clamping (regression) ─────────────────────
  describe("getNotifications — untrusted pagination is CLAMPED before Prisma", () => {
    async function takeSkipFor(limit: number, skip: number) {
      prisma.queue("notification", "findMany", []);
      await mod.getNotifications("pager", limit, skip);
      const args = prisma.callsFor("notification", "findMany")[0]!.args as {
        take: number;
        skip: number;
        where: { userId: string };
      };
      return args;
    }

    it("negative limit/skip → take defaults to 20, skip floors to 0 (Prisma never sees a negative)", async () => {
      const args = await takeSkipFor(-5, -10);
      assert.equal(args.take, 20);
      assert.equal(args.skip, 0);
      assert.ok(args.take > 0, "take must be positive for Prisma");
      assert.ok(args.skip >= 0, "skip must be non-negative for Prisma");
    });

    it("NaN limit/skip → take 20, skip 0 (the parseInt('abc') case → no 500)", async () => {
      const args = await takeSkipFor(NaN, NaN);
      assert.equal(args.take, 20);
      assert.equal(args.skip, 0);
      assert.ok(Number.isFinite(args.take) && Number.isFinite(args.skip));
    });

    it("huge limit → capped to 100 (payload/memory guard)", async () => {
      const args = await takeSkipFor(99_999_999, 0);
      assert.equal(args.take, 100);
    });

    it("still userId-scoped while clamping", async () => {
      const args = await takeSkipFor(-1, -1);
      assert.equal(args.where.userId, "pager");
    });

    it("a valid in-range page is forwarded unchanged", async () => {
      const args = await takeSkipFor(10, 40);
      assert.equal(args.take, 10);
      assert.equal(args.skip, 40);
    });
  });

  // ───────────────────── empty list + unread-count edges ─────────────────────
  describe("getNotifications — empty list", () => {
    it("no rows → success + [] (the empty-state path)", async () => {
      prisma.queue("notification", "findMany", []);
      const res = await mod.getNotifications("empty-user");
      assert.equal(res.success, true);
      assert.deepEqual((res as { data: unknown[] }).data, []);
    });
  });

  describe("getUnreadCount — 0 / all-read / all-unread", () => {
    it("zero unread → 0", async () => {
      prisma.queue("notification", "count", 0);
      const res = await mod.getUnreadCount("uc-zero");
      assert.equal((res as { data: number }).data, 0);
      const where = (
        prisma.callsFor("notification", "count")[0]!.args as {
          where: { userId: string; isRead: boolean };
        }
      ).where;
      assert.equal(where.userId, "uc-zero");
      assert.equal(where.isRead, false);
    });

    it("all rows read → unread count 0 (count query still isRead:false scoped)", async () => {
      // "all read" manifests as a 0 count on the isRead:false query.
      prisma.queue("notification", "count", 0);
      const res = await mod.getUnreadCount("uc-all-read");
      assert.equal((res as { data: number }).data, 0);
    });

    it("all rows unread → returns the full unread count", async () => {
      prisma.queue("notification", "count", 42);
      const res = await mod.getUnreadCount("uc-all-unread");
      assert.equal((res as { data: number }).data, 42);
    });
  });
});
