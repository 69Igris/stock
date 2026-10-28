/**
 * MONEY-620 — documents.service END-TO-END (real fns, recording prisma).
 *
 * UserDocuments are ACCESS CONTROL for a user's private files: every read AND
 * mutation must be scoped to the caller's `userId` so user A can never read or
 * delete user B's document by id. This file drives the REAL exported service
 * functions and asserts the exact prisma `where` clauses (the IDOR guard) and
 * the pagination/error behavior:
 *
 *   - getDocuments   → userId + isDeleted findMany, clamped take/skip, total count
 *   - getDocument    → findFirst WHERE { id, userId, isDeleted:false } (IDOR scope)
 *   - deleteDocument → updateMany WHERE { id, userId, isDeleted:false } (IDOR — the
 *                      MUTATION itself is scoped, never a bare { id }); count 0 ⇒
 *                      "not found" (no existence oracle for another user's id)
 *   - generateReport → creates a userId-stamped report row
 *   - error paths    → sanitized failures, "not found" on miss
 *
 * Seam: `documents.service` hard-imports `prisma` from `@usemoney/database` and
 * `dbLogger` from `@usemoney/logger`. We inject a recording prisma double via
 * `require.cache` before requiring the `@usemoney/services` barrel (the proven
 * pattern from `notifications-service-e2e.test.ts`). The barrel also touches
 * `@usemoney/core` (content.service caching) — stubbed to a no-op so requiring it
 * never connects to Redis/GCS.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: packages/services/src/documents.service.ts
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
    if (method === "create" || method === "update") return { id: "generated" };
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

interface DocumentsModule {
  getDocuments: (
    userId: string,
    filters?: {
      category?: string;
      sourceType?: string;
      search?: string;
      skip?: number;
      limit?: number;
    }
  ) => Promise<
    | { success: true; data: { documents: unknown[]; total: number } }
    | { success: false; error: string }
  >;
  getDocument: (
    userId: string,
    id: string
  ) => Promise<
    | { success: true; data: Record<string, unknown> }
    | { success: false; error: string }
  >;
  deleteDocument: (
    userId: string,
    id: string
  ) => Promise<{ success: true } | { success: false; error: string }>;
  generateReport: (
    userId: string,
    type: string,
    params?: { fy?: string }
  ) => Promise<
    | { success: true; data: { documentId: string } }
    | { success: false; error: string }
  >;
}

let svc: DocumentsModule | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

function installServices(): DocumentsModule {
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
  // The barrel pulls @usemoney/core (content.service caching). No-op it so
  // requiring @usemoney/services doesn't connect to Redis/GCS.
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
  svc = require("@usemoney/services") as DocumentsModule;
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

function swapPrisma(): RecordingPrisma {
  activePrisma = new RecordingPrisma();
  return activePrisma;
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-620 — documents.service (real fns, recording prisma)", () => {
  let prisma: RecordingPrisma;
  let mod: DocumentsModule;

  before(() => {
    mod = installServices();
  });
  beforeEach(() => {
    prisma = swapPrisma();
  });
  after(() => {
    uninstallServices();
  });

  describe("getDocuments — userId-scoped list + pagination clamp", () => {
    it("scopes findMany + count to { userId, isDeleted:false }, newest-first", async () => {
      prisma.queue("userDocument", "findMany", []);
      prisma.queue("userDocument", "count", 0);
      await mod.getDocuments("user-d1", { skip: 5, limit: 25 });

      const find = prisma.callsFor("userDocument", "findMany")[0]!.args as {
        where: { userId: string; isDeleted: boolean };
        orderBy: Record<string, unknown>;
        take: number;
        skip: number;
      };
      assert.equal(find.where.userId, "user-d1");
      assert.equal(find.where.isDeleted, false);
      assert.deepEqual(find.orderBy, { createdAt: "desc" });
      assert.equal(find.take, 25);
      assert.equal(find.skip, 5);

      const count = prisma.callsFor("userDocument", "count")[0]!.args as {
        where: { userId: string; isDeleted: boolean };
      };
      assert.equal(count.where.userId, "user-d1");
      assert.equal(count.where.isDeleted, false);
    });

    it("CLAMPS a NaN/negative skip|limit → no Prisma 500 (apps/api ?limit=abc guard)", async () => {
      prisma.queue("userDocument", "findMany", []);
      prisma.queue("userDocument", "count", 0);
      await mod.getDocuments("user-d2", {
        skip: -10 as number,
        limit: NaN as number,
      });
      const find = prisma.callsFor("userDocument", "findMany")[0]!.args as {
        take: number;
        skip: number;
      };
      assert.ok(Number.isInteger(find.take) && find.take >= 1, "take is safe");
      assert.equal(find.take, 20, "NaN limit → DEFAULT 20");
      assert.equal(find.skip, 0, "negative skip → 0");
    });

    it("caps an absurd limit to 100", async () => {
      prisma.queue("userDocument", "findMany", []);
      prisma.queue("userDocument", "count", 0);
      await mod.getDocuments("user-d3", { limit: 99_999_999 });
      const find = prisma.callsFor("userDocument", "findMany")[0]!.args as {
        take: number;
      };
      assert.equal(find.take, 100);
    });

    it("applies category/sourceType filters and a case-insensitive search OR", async () => {
      prisma.queue("userDocument", "findMany", []);
      prisma.queue("userDocument", "count", 0);
      await mod.getDocuments("user-d4", {
        category: "TAX_REPORT",
        sourceType: "GENERATED",
        search: "2024",
      });
      const where = prisma.callsFor("userDocument", "findMany")[0]!.args as {
        where: { category: string; sourceType: string; OR: unknown };
      };
      assert.equal(where.where.category, "TAX_REPORT");
      assert.equal(where.where.sourceType, "GENERATED");
      assert.deepEqual(where.where.OR, [
        { title: { contains: "2024", mode: "insensitive" } },
        { fileName: { contains: "2024", mode: "insensitive" } },
      ]);
    });

    it("returns { documents, total } and surfaces a sanitized error on DB failure", async () => {
      prisma.queue("userDocument", "findMany", [
        { id: "doc-1", title: "A", processingStatus: "READY" },
      ]);
      prisma.queue("userDocument", "count", 1);
      const ok = await mod.getDocuments("user-d5");
      assert.equal(ok.success, true);
      assert.equal((ok as { data: { total: number } }).data.total, 1);

      const prisma2 = swapPrisma();
      prisma2.fail("userDocument", "findMany", new Error("conn reset"));
      const bad = await mod.getDocuments("user-d5b");
      assert.equal(bad.success, false);
      assert.equal(
        (bad as { error: string }).error,
        "Failed to list documents"
      );
    });
  });

  describe("getDocument — IDOR scope on read", () => {
    it("findFirst WHERE carries BOTH the id AND the caller userId (+ isDeleted:false)", async () => {
      prisma.queue("userDocument", "findFirst", {
        id: "doc-9",
        title: "Mine",
        storagePath: "documents/user-r1/x.pdf",
        metadata: null,
        processingStatus: "READY",
      });
      const res = await mod.getDocument("user-r1", "doc-9");
      assert.equal(res.success, true);
      const args = prisma.callsFor("userDocument", "findFirst")[0]!.args as {
        where: { id: string; userId: string; isDeleted: boolean };
      };
      // CRITICAL: a findFirst by bare { id } would let user B read user A's doc.
      assert.equal(args.where.id, "doc-9");
      assert.equal(args.where.userId, "user-r1");
      assert.equal(args.where.isDeleted, false);
    });

    it("returns 'Document not found' when the scoped lookup misses (another user's id)", async () => {
      prisma.queue("userDocument", "findFirst", null);
      const res = await mod.getDocument("attacker", "victims-doc-id");
      assert.equal(res.success, false);
      assert.equal((res as { error: string }).error, "Document not found");
      // It DID query with the attacker's userId — so a victim's row can't match.
      const args = prisma.callsFor("userDocument", "findFirst")[0]!.args as {
        where: { userId: string };
      };
      assert.equal(args.where.userId, "attacker");
    });
  });

  describe("deleteDocument — IDOR scope on the MUTATION (the bug fix)", () => {
    it("soft-deletes via updateMany WHERE { id, userId, isDeleted:false } — NOT a bare { id }", async () => {
      prisma.queue("userDocument", "updateMany", { count: 1 });
      const res = await mod.deleteDocument("owner-1", "doc-7");
      assert.equal(res.success, true);

      const upd = prisma.callsFor("userDocument", "updateMany")[0]!.args as {
        where: { id: string; userId: string; isDeleted: boolean };
        data: { isDeleted: boolean };
      };
      // The whole point: the WHERE that performs the write is scoped to the user.
      assert.equal(upd.where.id, "doc-7");
      assert.equal(upd.where.userId, "owner-1");
      assert.equal(upd.where.isDeleted, false);
      assert.equal(upd.data.isDeleted, true);

      // And there must be NO bare-id update() anywhere (the old IDOR path).
      assert.equal(
        prisma.callsFor("userDocument", "update").length,
        0,
        "must not use a bare-id update() — that was the IDOR"
      );
    });

    it("count 0 (not owned / already gone) → 'Document not found', no existence oracle", async () => {
      // Attacker targets a victim's doc id; their userId scopes the updateMany,
      // so it affects 0 rows → reported as not found (indistinguishable from a
      // truly missing id; no info leak about other users' documents).
      prisma.queue("userDocument", "updateMany", { count: 0 });
      const res = await mod.deleteDocument("attacker", "victims-doc-id");
      assert.equal(res.success, false);
      assert.equal((res as { error: string }).error, "Document not found");
      const upd = prisma.callsFor("userDocument", "updateMany")[0]!.args as {
        where: { userId: string };
      };
      assert.equal(upd.where.userId, "attacker");
    });

    it("surfaces a sanitized error when the delete throws", async () => {
      prisma.fail("userDocument", "updateMany", new Error("write conflict"));
      const res = await mod.deleteDocument("user-e", "doc-e");
      assert.equal(res.success, false);
      assert.equal(
        (res as { error: string }).error,
        "Failed to delete document"
      );
    });
  });

  describe("generateReport — userId-stamped report row", () => {
    it("creates a GENERATED/REPORT doc stamped with the caller userId", async () => {
      prisma.queue("userDocument", "create", { id: "rep-1" });
      const res = await mod.generateReport("user-g1", "tax", { fy: "2024-25" });
      assert.equal(res.success, true);
      assert.equal(
        (res as { data: { documentId: string } }).data.documentId,
        "rep-1"
      );
      const args = prisma.callsFor("userDocument", "create")[0]!.args as {
        data: {
          userId: string;
          sourceType: string;
          documentType: string;
          category: string;
          processingStatus: string;
        };
      };
      assert.equal(args.data.userId, "user-g1");
      assert.equal(args.data.sourceType, "GENERATED");
      assert.equal(args.data.documentType, "REPORT");
      assert.equal(args.data.category, "TAX_REPORT");
      assert.equal(args.data.processingStatus, "PENDING");
    });

    it("maps an unknown report type to category OTHER (no crash)", async () => {
      prisma.queue("userDocument", "create", { id: "rep-2" });
      const res = await mod.generateReport("user-g2", "mystery");
      assert.equal(res.success, true);
      const args = prisma.callsFor("userDocument", "create")[0]!.args as {
        data: { category: string };
      };
      assert.equal(args.data.category, "OTHER");
    });

    it("surfaces a sanitized error when create throws", async () => {
      prisma.fail("userDocument", "create", new Error("E11000 dup"));
      const res = await mod.generateReport("user-g3", "risk");
      assert.equal(res.success, false);
      assert.equal(
        (res as { error: string }).error,
        "Failed to generate report"
      );
    });
  });
});
