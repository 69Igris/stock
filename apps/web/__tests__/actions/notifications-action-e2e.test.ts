/**
 * MONEY-620 — notifications server actions END-TO-END (real action handlers).
 *
 * The existing `__tests__/actions/notifications.test.ts` is a SHADOW: it never
 * imports the real action — it reimplements notification logic inline and
 * asserts the copy (exactly the failure mode `writing-tests` warns about). This
 * file drives the REAL exported actions from `lib/actions/notifications.ts` and
 * asserts their orchestration contract:
 *
 *   - demo gate FIRST: a demo session returns the static demo set / no-op
 *     mutations and NEVER calls the service or resolves the DB user.
 *   - auth gate: a signed-out (non-demo) caller gets { success:false,
 *     error:"Unauthorized" } and the service is NOT called.
 *   - delegation: an authed caller forwards the resolved internal userId (and
 *     limit/skip) to the matching `@usemoney/services` function and returns its
 *     result verbatim.
 *
 * Seam: the action imports `getAuthenticatedUser` (`@/lib/auth`, which pulls
 * React `cache()` + Clerk), `isDemoSession` (`@/lib/demo/session`),
 * `demoNotifications`/`demoUnreadNotificationCount` (`@/lib/demo/data`), and the
 * five service fns from `@usemoney/services`. We inject stubs for all of them via
 * `require.cache` BEFORE requiring the action (the proven pattern from
 * `payments-callback-e2e.test.ts` — relative-path `require.resolve` + a fresh
 * action module per scenario). The real action body (gating + delegation) runs;
 * only its boundaries are mocked.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: apps/web/lib/actions/notifications.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── service-call recorder ───────────────────────────────────────────────────

interface ServiceCall {
  fn: string;
  args: unknown[];
}

interface Harness {
  serviceCalls: ServiceCall[];
  authUser: { userId: string } | null;
  isDemo: boolean;
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const DEMO_NOTIFS = [
  {
    id: "demo-1",
    type: "INFO",
    title: "Welcome",
    message: "Hi",
    metadata: null,
    isRead: false,
    createdAt: new Date("2026-06-01T00:00:00Z"),
  },
  {
    id: "demo-2",
    type: "INFO",
    title: "Tip",
    message: "Explore",
    metadata: null,
    isRead: true,
    createdAt: new Date("2026-06-02T00:00:00Z"),
  },
  {
    id: "demo-3",
    type: "INFO",
    title: "More",
    message: "Discover",
    metadata: null,
    isRead: false,
    createdAt: new Date("2026-06-03T00:00:00Z"),
  },
];
const DEMO_UNREAD = 2;

interface NotificationsActionModule {
  getNotificationsAction: (
    limit?: number,
    skip?: number
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>;
  getUnreadCountAction: () => Promise<{
    success: boolean;
    data?: number;
    error?: string;
  }>;
  markAsReadAction: (
    id: string
  ) => Promise<{ success: boolean; error?: string }>;
  markAllAsReadAction: () => Promise<{ success: boolean; error?: string }>;
  clearAllReadAction: () => Promise<{
    success: boolean;
    data?: number;
    error?: string;
  }>;
}

const ACTION_REL = "../../lib/actions/notifications";

/**
 * Inject stubs for the action's boundaries, then load a FRESH copy of the action
 * so no module state leaks. Each service fn records its call + returns a
 * sentinel ServiceResult the action should pass straight through.
 */
function loadAction(h: Harness): NotificationsActionModule {
  const cache = moduleCache();
  const authPath = require.resolve("../../lib/auth");
  const sessionPath = require.resolve("../../lib/demo/session");
  const dataPath = require.resolve("../../lib/demo/data");
  const servicesPath = require.resolve("@usemoney/services");
  const actionPath = require.resolve(ACTION_REL);

  cache[authPath] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: () => Promise.resolve(h.authUser),
    },
  };
  cache[sessionPath] = {
    exports: {
      __esModule: true,
      isDemoSession: () => Promise.resolve(h.isDemo),
      COOKIE_NAME: "sb_demo",
    },
  };
  cache[dataPath] = {
    exports: {
      __esModule: true,
      demoNotifications: DEMO_NOTIFS,
      demoUnreadNotificationCount: DEMO_UNREAD,
    },
  };

  const svcFn =
    (name: string, ret: unknown) =>
    (...args: unknown[]) => {
      h.serviceCalls.push({ fn: name, args });
      return Promise.resolve(ret);
    };
  cache[servicesPath] = {
    exports: {
      __esModule: true,
      getNotifications: svcFn("getNotifications", {
        success: true,
        data: [{ id: "svc-ntf" }],
      }),
      getUnreadCount: svcFn("getUnreadCount", { success: true, data: 11 }),
      markAsRead: svcFn("markAsRead", { success: true, data: undefined }),
      markAllAsRead: svcFn("markAllAsRead", { success: true, data: undefined }),
      clearAllRead: svcFn("clearAllRead", { success: true, data: 4 }),
    },
  };

  delete cache[actionPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as NotificationsActionModule;
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — notifications actions (real handlers, mocked boundaries)", () => {
  let h: Harness;

  beforeEach(() => {
    h = {
      serviceCalls: [],
      authUser: { userId: "internal-user-1" },
      isDemo: false,
    };
  });

  describe("demo session short-circuits before auth + service", () => {
    it("getNotificationsAction returns the demo slice (skip/limit) without the service", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.getNotificationsAction(2, 1);
      assert.equal(res.success, true);
      // slice(skip=1, skip+limit=3) → demo-2, demo-3
      const data = res.data as Array<{ id: string }>;
      assert.deepEqual(
        data.map((d) => d.id),
        ["demo-2", "demo-3"]
      );
      assert.equal(h.serviceCalls.length, 0, "demo must not touch the service");
    });

    it("getUnreadCountAction returns the static demo count", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.getUnreadCountAction();
      assert.equal(res.success, true);
      assert.equal(res.data, DEMO_UNREAD);
      assert.equal(h.serviceCalls.length, 0);
    });

    it("markAsReadAction is a successful no-op in demo (no service write)", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.markAsReadAction("demo-1");
      assert.equal(res.success, true);
      assert.equal(h.serviceCalls.length, 0);
    });

    it("clearAllReadAction returns 0 cleared in demo (no service delete)", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.clearAllReadAction();
      assert.equal(res.success, true);
      assert.equal(res.data, 0);
      assert.equal(h.serviceCalls.length, 0);
    });
  });

  describe("auth gate (signed-out, non-demo)", () => {
    it("getNotificationsAction returns Unauthorized + skips the service", async () => {
      h.authUser = null;
      const action = loadAction(h);
      const res = await action.getNotificationsAction();
      assert.equal(res.success, false);
      assert.equal(res.error, "Unauthorized");
      assert.equal(h.serviceCalls.length, 0);
    });

    it("markAllAsReadAction returns Unauthorized + skips the service", async () => {
      h.authUser = null;
      const action = loadAction(h);
      const res = await action.markAllAsReadAction();
      assert.equal(res.success, false);
      assert.equal(res.error, "Unauthorized");
      assert.equal(h.serviceCalls.length, 0);
    });

    it("clearAllReadAction returns Unauthorized + skips the service", async () => {
      h.authUser = null;
      const action = loadAction(h);
      const res = await action.clearAllReadAction();
      assert.equal(res.success, false);
      assert.equal(res.error, "Unauthorized");
      assert.equal(h.serviceCalls.length, 0);
    });
  });

  describe("authed delegation forwards the internal userId to the service", () => {
    it("getNotificationsAction passes (userId, limit, skip) through", async () => {
      const action = loadAction(h);
      const res = await action.getNotificationsAction(25, 50);
      assert.equal(res.success, true);
      assert.deepEqual(res.data, [{ id: "svc-ntf" }]);
      const call = h.serviceCalls.find((c) => c.fn === "getNotifications");
      assert.ok(call, "expected getNotifications service call");
      assert.deepEqual(call!.args, ["internal-user-1", 25, 50]);
    });

    it("getUnreadCountAction forwards just the userId and returns the count", async () => {
      const action = loadAction(h);
      const res = await action.getUnreadCountAction();
      assert.equal(res.data, 11);
      const call = h.serviceCalls.find((c) => c.fn === "getUnreadCount");
      assert.deepEqual(call!.args, ["internal-user-1"]);
    });

    it("markAsReadAction forwards (userId, notificationId)", async () => {
      const action = loadAction(h);
      const res = await action.markAsReadAction("ntf-77");
      assert.equal(res.success, true);
      const call = h.serviceCalls.find((c) => c.fn === "markAsRead");
      assert.deepEqual(call!.args, ["internal-user-1", "ntf-77"]);
    });

    it("clearAllReadAction forwards the userId and returns the cleared count", async () => {
      const action = loadAction(h);
      const res = await action.clearAllReadAction();
      assert.equal(res.data, 4);
      const call = h.serviceCalls.find((c) => c.fn === "clearAllRead");
      assert.deepEqual(call!.args, ["internal-user-1"]);
    });
  });
});
