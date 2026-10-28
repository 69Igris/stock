/**
 * MONEY-620 — roast-history server actions END-TO-END (real handlers).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a SHADOW: it re-declared `validateRoastParams`,
 * `formatRoastHistoryEntry`, an in-memory `createMockRoastStore`, `applyLimit`
 * and an inline `demoRoastHistory` literal — then asserted the COPIES. None of
 * those helpers even exist in `roast-history.ts`; it imported NOTHING from the
 * source, so the real gates that protect a user's roast history (demo
 * short-circuit, the auth gate, the `getOrCreateDbUser` "user not found" gate,
 * the IDOR `dbUser.id`-scoped DB lookups, the not-found handling, and error
 * sanitization to a generic message) were entirely unexercised.
 *
 * This rewrite drives the REAL exported actions —
 * `getRoastHistoryAction`, `getRoastByIdAction`, `getRoastBySessionIdAction`,
 * `deleteRoastAction` — through the `require.cache` seam and asserts the
 * action's OWN logic, NOT the `lib/db/roast` internals:
 *   - demo session: history/detail return the STATIC demo payloads (no auth, no
 *     DB); delete is BLOCKED with the upsell error (no DB write).
 *   - unauth → "Unauthorized"; missing dbUser → "User not found".
 *   - IDOR: every db call is forwarded the RESOLVED dbUser.id (never the raw
 *     clerk id); a cross-user / not-found db result yields "Roast not found"
 *     and NO data leak.
 *   - a thrown db call is sanitized to a generic "Failed to …" (no internal leak).
 *
 * `@clerk/nextjs/server`, `@/lib/db/user`, `@/lib/db/roast`, `@/lib/demo/session`,
 * `@/lib/demo/data` are recorded stubs.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/roast-history.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── recorders ───────────────────────────────────────────────────────────────

interface DbCall {
  fn: string;
  args: unknown[];
}

interface Harness {
  isDemo: boolean;
  clerkUserId: string | null;
  dbUser: { id: string } | null;
  dbReturns: Record<string, unknown>;
  dbThrows: Record<string, Error>;
  dbCalls: DbCall[];
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

const ACTION_REL = "../../lib/actions/roast-history";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ACTION_REL)];
}

const DEMO_HISTORY = [
  { id: "demo-roast-1", sessionId: "demo-roast-1", score: 72 },
];
const DEMO_DETAIL = {
  id: "demo-roast-1",
  sessionId: "demo-roast-1",
  mode: "broker",
  broker: "ZERODHA",
  assetType: "stocks",
  score: 72,
  result: { overallScore: 72 },
  createdAt: new Date("2026-02-01T00:00:00Z"),
};

function freshHarness(): Harness {
  return {
    isDemo: false,
    clerkUserId: "clerk_abc",
    dbUser: { id: "internal-user-1" },
    dbReturns: {},
    dbThrows: {},
    dbCalls: [],
  };
}

interface RoastHistoryModule {
  getRoastHistoryAction: (
    page?: number,
    pageSize?: number
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>;
  getRoastByIdAction: (
    id: string
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>;
  getRoastBySessionIdAction: (
    sessionId: string
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>;
  deleteRoastAction: (
    id: string
  ) => Promise<{ success: boolean; error?: string }>;
}

function dbFn(h: Harness, name: string) {
  return (...args: unknown[]) => {
    h.dbCalls.push({ fn: name, args });
    if (h.dbThrows[name]) return Promise.reject(h.dbThrows[name]);
    return Promise.resolve(h.dbReturns[name] ?? null);
  };
}

function loadAction(h: Harness): RoastHistoryModule {
  const cache = moduleCache();

  const clerkPath = require.resolve("@clerk/nextjs/server");
  const userPath = require.resolve("../../lib/db/user");
  const roastPath = require.resolve("../../lib/db/roast");
  const sessionPath = require.resolve("../../lib/demo/session");
  const dataPath = require.resolve("../../lib/demo/data");
  const actionPath = require.resolve(ACTION_REL);

  for (const p of [clerkPath, userPath, roastPath, sessionPath, dataPath]) {
    snapshotOnce(p);
  }

  cache[clerkPath] = {
    exports: {
      __esModule: true,
      auth: () => Promise.resolve({ userId: h.clerkUserId }),
    },
  };
  cache[userPath] = {
    exports: {
      __esModule: true,
      getOrCreateDbUser: () => Promise.resolve(h.dbUser),
    },
  };
  cache[roastPath] = {
    exports: {
      __esModule: true,
      getRoastHistory: dbFn(h, "getRoastHistory"),
      getRoastById: dbFn(h, "getRoastById"),
      getRoastBySessionId: dbFn(h, "getRoastBySessionId"),
      deleteRoast: dbFn(h, "deleteRoast"),
    },
  };
  cache[sessionPath] = {
    exports: {
      __esModule: true,
      isDemoSession: () => Promise.resolve(h.isDemo),
    },
  };
  cache[dataPath] = {
    exports: {
      __esModule: true,
      demoRoastHistory: DEMO_HISTORY,
      demoRoastDetail: DEMO_DETAIL,
    },
  };

  delete cache[actionPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as RoastHistoryModule;
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — roast-history actions (real handlers, mocked I/O)", () => {
  let h: Harness;
  beforeEach(() => {
    h = freshHarness();
  });
  after(() => {
    restoreCache();
  });

  describe("getRoastHistoryAction", () => {
    it("demo session returns the STATIC demo history without auth or DB", async () => {
      h.isDemo = true;
      h.clerkUserId = null; // prove auth is not consulted on the demo path
      const action = loadAction(h);
      const res = await action.getRoastHistoryAction();
      assert.equal(res.success, true);
      const data = res.data as { items: unknown[]; total: number };
      assert.equal(data.total, DEMO_HISTORY.length);
      assert.equal(data.items.length, DEMO_HISTORY.length);
      assert.equal(h.dbCalls.length, 0);
    });

    it("unauthenticated (non-demo) → Unauthorized, no DB", async () => {
      h.clerkUserId = null;
      const action = loadAction(h);
      const res = await action.getRoastHistoryAction();
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Unauthorized/);
      assert.equal(h.dbCalls.length, 0);
    });

    it("missing dbUser → User not found, no history query", async () => {
      h.dbUser = null;
      const action = loadAction(h);
      const res = await action.getRoastHistoryAction();
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /User not found/);
      assert.equal(h.dbCalls.length, 0);
    });

    it("IDOR: forwards the resolved dbUser.id + page/pageSize to getRoastHistory", async () => {
      h.dbReturns.getRoastHistory = { items: [{ id: "r1" }], total: 1 };
      const action = loadAction(h);
      const res = await action.getRoastHistoryAction(3, 25);
      assert.equal(res.success, true);
      const call = h.dbCalls.find((c) => c.fn === "getRoastHistory");
      assert.ok(call);
      assert.deepEqual(call!.args, ["internal-user-1", 3, 25]);
      assert.notEqual(call!.args[0], "clerk_abc");
    });

    it("a thrown DB call is sanitized to a generic error (no internal leak)", async () => {
      h.dbThrows.getRoastHistory = new Error("Mongo internal at 10.0.0.9");
      const action = loadAction(h);
      const res = await action.getRoastHistoryAction();
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Failed to get roast history/);
      assert.ok(!/10\.0\.0\.9/.test(res.error ?? ""));
    });
  });

  describe("getRoastByIdAction", () => {
    it("demo: known demo id returns the static detail; unknown → not found", async () => {
      h.isDemo = true;
      h.clerkUserId = null;
      const action = loadAction(h);
      const ok = await action.getRoastByIdAction("demo-roast-1");
      assert.equal(ok.success, true);
      assert.equal((ok.data as { id: string }).id, "demo-roast-1");
      const miss = await action.getRoastByIdAction("not-a-demo-id");
      assert.equal(miss.success, false);
      assert.match(miss.error ?? "", /not found/i);
      assert.equal(h.dbCalls.length, 0);
    });

    it("IDOR: forwards (id, dbUser.id) and a not-found db result yields 'Roast not found'", async () => {
      h.dbReturns.getRoastById = null; // simulate cross-user/not-found
      const action = loadAction(h);
      const res = await action.getRoastByIdAction("roast-xyz");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not found/i);
      const call = h.dbCalls.find((c) => c.fn === "getRoastById");
      assert.deepEqual(call!.args, ["roast-xyz", "internal-user-1"]);
    });

    it("returns the row when the db finds an owned roast", async () => {
      h.dbReturns.getRoastById = { id: "roast-xyz", score: 88 };
      const action = loadAction(h);
      const res = await action.getRoastByIdAction("roast-xyz");
      assert.equal(res.success, true);
      assert.equal((res.data as { score: number }).score, 88);
    });

    it("unauthenticated → Unauthorized, no DB", async () => {
      h.clerkUserId = null;
      const action = loadAction(h);
      const res = await action.getRoastByIdAction("roast-xyz");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Unauthorized/);
      assert.equal(h.dbCalls.length, 0);
    });
  });

  describe("getRoastBySessionIdAction", () => {
    it("IDOR: forwards (sessionId, dbUser.id); not-found → 'Roast not found'", async () => {
      h.dbReturns.getRoastBySessionId = null;
      const action = loadAction(h);
      const res = await action.getRoastBySessionIdAction("sess-1");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not found/i);
      const call = h.dbCalls.find((c) => c.fn === "getRoastBySessionId");
      assert.deepEqual(call!.args, ["sess-1", "internal-user-1"]);
    });

    it("demo: known session returns COMPLETED detail; unknown → not found", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const ok = await action.getRoastBySessionIdAction("demo-roast-1");
      assert.equal(ok.success, true);
      assert.equal((ok.data as { status: string }).status, "COMPLETED");
      const miss = await action.getRoastBySessionIdAction("nope");
      assert.equal(miss.success, false);
      assert.equal(h.dbCalls.length, 0);
    });
  });

  describe("deleteRoastAction", () => {
    it("demo session is BLOCKED with the upsell error — no DB delete", async () => {
      h.isDemo = true;
      const action = loadAction(h);
      const res = await action.deleteRoastAction("roast-xyz");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Demo mode/);
      assert.equal(h.dbCalls.length, 0);
    });

    it("IDOR: forwards (id, dbUser.id); a not-found delete yields 'Roast not found'", async () => {
      h.dbReturns.deleteRoast = false; // db says nothing deleted (not owned)
      const action = loadAction(h);
      const res = await action.deleteRoastAction("someone-elses");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not found/i);
      const call = h.dbCalls.find((c) => c.fn === "deleteRoast");
      assert.deepEqual(call!.args, ["someone-elses", "internal-user-1"]);
    });

    it("a successful owned delete returns success", async () => {
      h.dbReturns.deleteRoast = true;
      const action = loadAction(h);
      const res = await action.deleteRoastAction("roast-xyz");
      assert.equal(res.success, true);
    });

    it("unauthenticated → Unauthorized, no DB", async () => {
      h.clerkUserId = null;
      const action = loadAction(h);
      const res = await action.deleteRoastAction("roast-xyz");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Unauthorized/);
      assert.equal(h.dbCalls.length, 0);
    });
  });
});
