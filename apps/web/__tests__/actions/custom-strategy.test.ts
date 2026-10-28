/**
 * MONEY-620 — custom-strategy server actions END-TO-END (real handlers).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a SHADOW: it re-implemented the create-validation
 * (name length, non-empty filter array) and asserted the COPIES, importing
 * NOTHING from `lib/actions/custom-strategy.ts`. So none of the gates that
 * protect a user's saved strategies + scans ran on the shipping code: the auth
 * gate on every action, the IDOR ownership wall (`findFirst({ where: { id,
 * userId } })`) on update/delete/run/getScanStatus/getScanResult, the unique-
 * constraint → friendly message, and the worker Pub/Sub offload carrying the
 * CALLER userId on a strategy run.
 *
 * This rewrite drives the REAL exported actions through the `require.cache` seam.
 * `@usemoney/research` is kept REAL (the pure built-in strategy registry), so
 * clone/run-built-in resolve genuine strategies. We stub `@/lib/auth`,
 * `@usemoney/database`, and `@usemoney/pubsub/publish`. Assertions target the
 * action's OWN logic:
 *   - every action: unauth → Unauthorized, no DB.
 *   - createStrategyAction: name <2 chars / empty filters rejected BEFORE create;
 *     created row carries the CALLER userId (IDOR); unique-constraint → friendly.
 *   - listStrategiesAction: the custom findMany is scoped to the caller userId;
 *     built-in list comes from the REAL registry.
 *   - update/delete/run/getScanStatus/getScanResult/getScanHistory: the
 *     ownership lookup is caller-scoped; a miss → not-found and NO mutation /
 *     NO pubsub.
 *   - runStrategyAction: a custom run creates a PENDING ScanResult and publishes
 *     a worker job under the CALLER userId + the scan id.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/custom-strategy.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

interface PrismaCall {
  model: string;
  method: string;
  args: unknown;
}
interface PublishCall {
  args: unknown;
}

interface Harness {
  user: { userId: string } | null;
  customFindFirst: Record<string, unknown> | null;
  customFindMany: Array<Record<string, unknown>>;
  scanFindFirst: Record<string, unknown> | null;
  scanFindMany: Array<Record<string, unknown>>;
  createThrows?: Error;
  prismaCalls: PrismaCall[];
  publishCalls: PublishCall[];
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

const ACTION_REL = "../../lib/actions/custom-strategy";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ACTION_REL)];
}

interface ActionResp<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
interface CustomStrategyModule {
  listStrategiesAction: (o?: {
    category?: string;
    search?: string;
  }) => Promise<ActionResp<{ builtIn: unknown[]; custom: unknown[] }>>;
  createStrategyAction: (input: unknown) => Promise<ActionResp<{ id: string }>>;
  updateStrategyAction: (
    id: string,
    input: unknown
  ) => Promise<ActionResp<{ id: string }>>;
  deleteStrategyAction: (id: string) => Promise<ActionResp<void>>;
  cloneBuiltInAction: (
    builtInId: string,
    name?: string
  ) => Promise<ActionResp<{ id: string }>>;
  runStrategyAction: (
    id: string,
    o?: { isBuiltIn?: boolean; limit?: number }
  ) => Promise<ActionResp<{ scanId: string; status: string }>>;
  getScanStatusAction: (id: string) => Promise<ActionResp<unknown>>;
  getScanResultAction: (id: string) => Promise<ActionResp<unknown>>;
  getScanHistoryAction: (o?: {
    limit?: number;
  }) => Promise<ActionResp<{ scans: unknown[] }>>;
}

function freshHarness(): Harness {
  return {
    user: { userId: "internal-user-1" },
    customFindFirst: null,
    customFindMany: [],
    scanFindFirst: null,
    scanFindMany: [],
    prismaCalls: [],
    publishCalls: [],
  };
}

function makeRecordingPrisma(h: Harness): unknown {
  const rec = (model: string, method: string, args: unknown) =>
    h.prismaCalls.push({ model, method, args });
  return {
    customStrategy: {
      findMany: (args: unknown) => {
        rec("customStrategy", "findMany", args);
        return Promise.resolve(h.customFindMany);
      },
      findFirst: (args: unknown) => {
        rec("customStrategy", "findFirst", args);
        return Promise.resolve(h.customFindFirst);
      },
      create: (args: unknown) => {
        rec("customStrategy", "create", args);
        if (h.createThrows) return Promise.reject(h.createThrows);
        return Promise.resolve({ id: "new-strategy-id" });
      },
      update: (args: unknown) => {
        rec("customStrategy", "update", args);
        return Promise.resolve({ id: "updated" });
      },
      delete: (args: unknown) => {
        rec("customStrategy", "delete", args);
        return Promise.resolve({});
      },
    },
    scanResult: {
      create: (args: unknown) => {
        rec("scanResult", "create", args);
        return Promise.resolve({ id: "scan-id-1" });
      },
      findFirst: (args: unknown) => {
        rec("scanResult", "findFirst", args);
        return Promise.resolve(h.scanFindFirst);
      },
      findMany: (args: unknown) => {
        rec("scanResult", "findMany", args);
        return Promise.resolve(h.scanFindMany);
      },
    },
  };
}

function loadAction(h: Harness): CustomStrategyModule {
  const cache = moduleCache();

  const authPath = require.resolve("../../lib/auth");
  const dbPath = require.resolve("@usemoney/database");
  const pubsubPath = require.resolve("@usemoney/pubsub/publish");
  const actionPath = require.resolve(ACTION_REL);

  for (const p of [authPath, dbPath, pubsubPath]) snapshotOnce(p);

  cache[authPath] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: () => Promise.resolve(h.user),
    },
  };
  const prismaDouble = makeRecordingPrisma(h);
  cache[dbPath] = {
    exports: {
      __esModule: true,
      prisma: prismaDouble,
      default: prismaDouble,
    },
  };
  cache[pubsubPath] = {
    exports: {
      __esModule: true,
      publishStrategyScanJob: (args: unknown) => {
        h.publishCalls.push({ args });
        return Promise.resolve("pub-msg-id");
      },
    },
  };

  delete cache[actionPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as CustomStrategyModule;
}

const validCreate = {
  name: "My RSI Scan",
  filters: [{ field: "rsi", op: "<", value: 30 }],
  scanType: "technical",
};

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — custom-strategy actions (real handlers, real registry, mocked I/O)", () => {
  let h: Harness;
  beforeEach(() => {
    h = freshHarness();
  });
  after(() => {
    restoreCache();
  });

  describe("auth gate (every action returns Unauthorized + no DB)", () => {
    it("createStrategyAction unauth", async () => {
      h.user = null;
      const action = loadAction(h);
      const res = await action.createStrategyAction(validCreate);
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Unauthorized/);
      assert.equal(h.prismaCalls.length, 0);
    });
    it("listStrategiesAction unauth", async () => {
      h.user = null;
      const action = loadAction(h);
      const res = await action.listStrategiesAction();
      assert.equal(res.success, false);
      assert.equal(h.prismaCalls.length, 0);
    });
    it("runStrategyAction unauth (no pubsub)", async () => {
      h.user = null;
      const action = loadAction(h);
      const res = await action.runStrategyAction("s1");
      assert.equal(res.success, false);
      assert.equal(h.publishCalls.length, 0);
    });
  });

  describe("createStrategyAction", () => {
    it("rejects a name under 2 chars before any DB write", async () => {
      const action = loadAction(h);
      const res = await action.createStrategyAction({
        ...validCreate,
        name: "x",
      });
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /at least 2 characters/);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("rejects an empty filters array before any DB write", async () => {
      const action = loadAction(h);
      const res = await action.createStrategyAction({
        ...validCreate,
        filters: [],
      });
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /At least one filter/);
      assert.equal(h.prismaCalls.length, 0);
    });

    it("creates the strategy under the CALLER userId (IDOR)", async () => {
      const action = loadAction(h);
      const res = await action.createStrategyAction(validCreate);
      assert.equal(res.success, true);
      assert.equal(res.data!.id, "new-strategy-id");
      const create = h.prismaCalls.find(
        (c) => c.model === "customStrategy" && c.method === "create"
      );
      const data = (create!.args as { data: Record<string, unknown> }).data;
      assert.equal(data.userId, "internal-user-1");
      assert.equal(data.name, "My RSI Scan");
    });

    it("a unique-constraint violation → friendly 'already exists'", async () => {
      h.createThrows = new Error("Unique constraint failed on the fields");
      const action = loadAction(h);
      const res = await action.createStrategyAction(validCreate);
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /already exists/);
    });
  });

  describe("listStrategiesAction", () => {
    it("custom findMany is scoped to the caller userId; built-in from the real registry", async () => {
      h.customFindMany = [];
      const action = loadAction(h);
      const res = await action.listStrategiesAction();
      assert.equal(res.success, true);
      const findMany = h.prismaCalls.find(
        (c) => c.model === "customStrategy" && c.method === "findMany"
      );
      assert.equal(
        (findMany!.args as { where: { userId: string } }).where.userId,
        "internal-user-1"
      );
      // The REAL built-in registry is non-empty.
      assert.ok(
        res.data!.builtIn.length > 0,
        "real BUILTIN_STRATEGIES present"
      );
    });
  });

  describe("updateStrategyAction (IDOR wall)", () => {
    it("a not-owned strategy → 'Strategy not found', NO update", async () => {
      h.customFindFirst = null;
      const action = loadAction(h);
      const res = await action.updateStrategyAction("someone-elses", {
        name: "Renamed",
      });
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not found/i);
      assert.equal(
        h.prismaCalls.some((c) => c.method === "update"),
        false
      );
      const find = h.prismaCalls.find((c) => c.method === "findFirst");
      const where = (find!.args as { where: Record<string, unknown> }).where;
      assert.equal(where.id, "someone-elses");
      assert.equal(where.userId, "internal-user-1");
    });

    it("an owned strategy is updated", async () => {
      h.customFindFirst = { id: "s1", userId: "internal-user-1" };
      const action = loadAction(h);
      const res = await action.updateStrategyAction("s1", { name: "Renamed" });
      assert.equal(res.success, true);
      assert.ok(h.prismaCalls.some((c) => c.method === "update"));
    });
  });

  describe("deleteStrategyAction (IDOR wall)", () => {
    it("a not-owned strategy → not found, NO delete", async () => {
      h.customFindFirst = null;
      const action = loadAction(h);
      const res = await action.deleteStrategyAction("someone-elses");
      assert.equal(res.success, false);
      assert.equal(
        h.prismaCalls.some((c) => c.method === "delete"),
        false
      );
    });

    it("an owned strategy is deleted", async () => {
      h.customFindFirst = { id: "s1" };
      const action = loadAction(h);
      const res = await action.deleteStrategyAction("s1");
      assert.equal(res.success, true);
      assert.ok(h.prismaCalls.some((c) => c.method === "delete"));
    });
  });

  describe("runStrategyAction", () => {
    it("a not-owned custom strategy → not found, NO scan, NO pubsub", async () => {
      h.customFindFirst = null;
      const action = loadAction(h);
      const res = await action.runStrategyAction("someone-elses");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not found/i);
      assert.equal(h.publishCalls.length, 0);
      assert.equal(
        h.prismaCalls.some((c) => c.model === "scanResult"),
        false
      );
    });

    it("an owned custom strategy → PENDING scan + worker job under the CALLER userId", async () => {
      h.customFindFirst = {
        id: "s1",
        userId: "internal-user-1",
        name: "My Scan",
        filters: [{ a: 1 }],
        logic: "AND",
        scanType: "technical",
      };
      const action = loadAction(h);
      const res = await action.runStrategyAction("s1", { limit: 25 });
      assert.equal(res.success, true);
      assert.equal(res.data!.status, "PENDING");
      assert.equal(res.data!.scanId, "scan-id-1");
      // ScanResult created under the caller userId.
      const scan = h.prismaCalls.find(
        (c) => c.model === "scanResult" && c.method === "create"
      );
      assert.equal(
        (scan!.args as { data: { userId: string } }).data.userId,
        "internal-user-1"
      );
      // Worker job carries the caller userId + scan id + the limit.
      assert.equal(h.publishCalls.length, 1);
      const job = h.publishCalls[0]!.args as {
        userId: string;
        scanId: string;
        limit: number;
      };
      assert.equal(job.userId, "internal-user-1");
      assert.equal(job.scanId, "scan-id-1");
      assert.equal(job.limit, 25);
    });

    it("a built-in run that doesn't resolve in the real registry → not found", async () => {
      const action = loadAction(h);
      const res = await action.runStrategyAction("not-a-real-builtin", {
        isBuiltIn: true,
      });
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not found/i);
      assert.equal(h.publishCalls.length, 0);
    });
  });

  describe("getScanStatusAction / getScanResultAction / getScanHistoryAction (IDOR)", () => {
    it("getScanStatus: a not-owned scan → not found", async () => {
      h.scanFindFirst = null;
      const action = loadAction(h);
      const res = await action.getScanStatusAction("scan-x");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not found/i);
      const find = h.prismaCalls.find(
        (c) => c.model === "scanResult" && c.method === "findFirst"
      );
      assert.equal(
        (find!.args as { where: { userId: string } }).where.userId,
        "internal-user-1"
      );
    });

    it("getScanResult: an owned scan returns its fields", async () => {
      h.scanFindFirst = {
        scanName: "My Scan",
        stockCount: 3,
        status: "COMPLETED",
        results: [{ symbol: "TCS" }],
        executedAt: new Date("2026-02-01T00:00:00Z"),
      };
      const action = loadAction(h);
      const res = await action.getScanResultAction("scan-x");
      assert.equal(res.success, true);
      assert.equal((res.data as { stockCount: number }).stockCount, 3);
    });

    it("getScanHistory: findMany is scoped to the caller userId", async () => {
      h.scanFindMany = [
        {
          id: "scan-1",
          scanName: "A",
          stockCount: 2,
          executedAt: new Date("2026-02-01T00:00:00Z"),
        },
      ];
      const action = loadAction(h);
      const res = await action.getScanHistoryAction({ limit: 10 });
      assert.equal(res.success, true);
      assert.equal(res.data!.scans.length, 1);
      const find = h.prismaCalls.find(
        (c) => c.model === "scanResult" && c.method === "findMany"
      );
      assert.equal(
        (find!.args as { where: { userId: string } }).where.userId,
        "internal-user-1"
      );
    });
  });
});
