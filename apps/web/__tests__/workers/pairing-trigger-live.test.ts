/**
 * MONEY-840 — the worker re-triggers FIFO pairing IN-PROCESS after a successful
 * sync / import, on the REAL processor code.
 *
 * Drives the REAL `processSync` (workers/src/processors/sync.ts) and
 * `processImport` (workers/src/processors/import.ts) through a require.cache
 * module-boundary seam (the same technique as services/trades-poison-live.test):
 * the heavy deps (@usemoney/database, @usemoney/core, @usemoney/services,
 * @usemoney/datadog, @usemoney/email, ../lib/notifications) and crucially
 * `./pairing` are stubbed, so we can observe the in-process `processPairing`
 * call and force it to throw. No live Mongo / Redis / Pub/Sub is touched.
 *
 * What this pins (the MONEY-840 re-wire):
 *   1. processSync calls processPairing({ jobId, userId }) ONCE on success.
 *   2. processSync passes ONLY { jobId, userId } (signature unchanged — another
 *      agent enriches processPairing internally with corp-actions).
 *   3. A pairing FAILURE does NOT fail the already-succeeded sync (job COMPLETED).
 *   4. processSync SKIPS pairing for the wildcard userId "*".
 *   5. processImport calls processPairing({ jobId, userId }) once after a
 *      successful import (imported > 0), and a pairing failure doesn't fail it.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: workers/src/processors/sync.ts + workers/src/processors/import.ts
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

  private next(model: string, method: string): unknown {
    const q = this.queues.get(`${model}.${method}`);
    if (q && q.length > 0) return q.shift();
    if (method === "count") return 0;
    if (method === "aggregate") return { _sum: {}, _count: 0 };
    if (method === "findFirst" || method === "findUnique") return null;
    if (
      method === "create" ||
      method === "update" ||
      method === "upsert" ||
      method === "updateMany" ||
      method === "deleteMany" ||
      method === "createMany"
    )
      return {};
    return [];
  }

  readonly client: Record<
    string,
    Record<string, (args?: unknown) => Promise<unknown>>
  > & { $transaction: (ops: unknown[]) => Promise<unknown[]> };

  constructor() {
    const self = this;
    const base = new Proxy(
      {},
      {
        get(target: Record<string, unknown>, model: string) {
          if (typeof model !== "string") return undefined;
          if (model === "$transaction") {
            return (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]);
          }
          if (model === "then") return undefined;
          if (!(model in target)) {
            target[model] = new Proxy(
              {},
              {
                get(_m, method: string) {
                  return (args?: unknown) => {
                    self.calls.push({ model, method, args });
                    return Promise.resolve(self.next(model, method));
                  };
                },
              }
            );
          }
          return target[model];
        },
      }
    );
    this.client = base as RecordingPrisma["client"];
  }

  callsFor(model: string, method: string): RecordedCall[] {
    return this.calls.filter((c) => c.model === model && c.method === method);
  }
}

// ── pairing spy ──────────────────────────────────────────────────────────────

interface PairingSpy {
  calls: Array<{ jobId: string; userId: string; extraKeys: string[] }>;
  shouldThrow: boolean;
}
let pairingSpy: PairingSpy = { calls: [], shouldThrow: false };
let fanoutSpy = { published: 0 };

// ── module-boundary injection ───────────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

let activePrisma: RecordingPrisma = new RecordingPrisma();

const STABLE_PRISMA = new Proxy(
  {},
  {
    get(target: Record<string, unknown>, key: string) {
      if (typeof key !== "string") return undefined;
      if (key === "then") return undefined;
      if (key === "$transaction") {
        return (ops: unknown[]) => activePrisma.client.$transaction(ops);
      }
      if (!(key in target)) {
        target[key] = new Proxy(
          {},
          {
            get(_m, method: string) {
              return (args?: unknown) =>
                activePrisma.client[key]![method]!(args);
            },
          }
        );
      }
      return target[key];
    },
  }
);

const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];
function stub(path: string, exports: unknown): void {
  const cache = moduleCache();
  priorCacheEntries.push([path, cache[path]]);
  cache[path] = { exports };
}

function pairingStub(): Record<string, unknown> {
  return {
    __esModule: true,
    processPairing: async (data: { jobId: string; userId: string }) => {
      const { jobId, userId, ...rest } = data as Record<string, unknown> & {
        jobId: string;
        userId: string;
      };
      pairingSpy.calls.push({
        jobId,
        userId,
        extraKeys: Object.keys(rest),
      });
      if (pairingSpy.shouldThrow) throw new Error("pairing boom");
    },
  };
}

function noopNamed(...names: string[]): Record<string, unknown> {
  const obj: Record<string, unknown> = { __esModule: true };
  for (const n of names) obj[n] = async () => undefined;
  return obj;
}

// ── resolved worker paths ─────────────────────────────────────────────────────

const WORKER = "../../../../workers/src/processors";
function workerPath(rel: string): string {
  return require.resolve(`${WORKER}/${rel}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// processImport
// ─────────────────────────────────────────────────────────────────────────────

interface ImportModule {
  processImport: (data: Record<string, unknown>) => Promise<void>;
}
let importSingleton: ImportModule | null = null;

function installImport(): ImportModule {
  if (importSingleton) return importSingleton;
  stub(require.resolve("@usemoney/database"), {
    __esModule: true,
    prisma: STABLE_PRISMA,
    default: STABLE_PRISMA,
  });
  stub(require.resolve("@usemoney/core"), noopNamed("clearTradeCache"));
  // Controlled parse: one valid trade row, no XLSX, no formula sanitization fuss.
  stub(require.resolve("@usemoney/core/import"), {
    __esModule: true,
    parseCSVContent: () => ({ rows: [["row1"]], headers: [] }),
    parseXLSXContent: () => ({ rows: [["row1"]], headers: [] }),
    parseCSVRow: () => ({
      error: null,
      data: {
        symbol: "RELIANCE",
        exchange: "NSE",
        segment: "CASH",
        tradeType: "BUY",
        quantity: 10,
        price: 100,
        tradeDate: new Date("2024-06-01T00:00:00Z"),
      },
    }),
    getColumnMapping: () => ({}),
    // MONEY-1074: the worker now resolves the effective format via this shared
    // helper; the pairing-trigger test doesn't exercise detection, so echo the
    // requested format (defaulting to generic).
    resolveEffectiveBrokerFormat: (fmt: string) => fmt || "generic",
    generateDuplicateHash: () => "hash-1",
    sanitizeFormulaInjection: (s: string) => s,
    safeFetch: async () => ({
      response: { ok: true, statusText: "OK" },
      buffer: Buffer.from(""),
    }),
  });
  stub(workerPath("../lib/notifications"), noopNamed("createNotification"));
  stub(workerPath("pairing"), pairingStub());
  // Force a fresh load of the processor module (and its sibling import-logic).
  const cache = moduleCache();
  for (const key of Object.keys(cache)) {
    if (
      key.includes("/workers/src/processors/import") ||
      key.endsWith("/workers/src/processors/import-logic.ts")
    ) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  importSingleton = require(workerPath("import.ts")) as ImportModule;
  return importSingleton;
}

function uninstall(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.length = 0;
  importSingleton = null;
  syncSingleton = null;
}

function resetState(): RecordingPrisma {
  activePrisma = new RecordingPrisma();
  pairingSpy = { calls: [], shouldThrow: false };
  fanoutSpy = { published: 0 };
  return activePrisma;
}

/** The status the processor stamped on the BackgroundJob via updateMany. */
function jobStatusUpdates(prisma: RecordingPrisma): string[] {
  return prisma
    .callsFor("backgroundJob", "updateMany")
    .map(
      (c) => (c.args as { data?: { status?: string } }).data?.status ?? "(none)"
    );
}

describe("MONEY-840 — processImport re-triggers pairing in-process (LIVE)", () => {
  let prisma: RecordingPrisma;
  let mod: ImportModule;
  before(() => {
    mod = installImport();
  });
  beforeEach(() => {
    prisma = resetState();
  });
  after(() => {
    uninstall();
  });

  const job = () => ({
    jobId: "imp-1",
    userId: "u-1",
    brokerFormat: "zerodha",
    fileType: "csv" as const,
    content: "x",
  });

  it("calls processPairing({ jobId, userId }) once after a successful import (imported > 0)", async () => {
    await mod.processImport(job());
    assert.equal(pairingSpy.calls.length, 1);
    assert.equal(pairingSpy.calls[0]!.userId, "u-1");
    // Signature unchanged: ONLY jobId + userId are passed.
    assert.equal(pairingSpy.calls[0]!.extraKeys.length, 0);
    assert.ok(pairingSpy.calls[0]!.jobId.length > 0);
    // The job still completed.
    assert.ok(jobStatusUpdates(prisma).includes("COMPLETED"));
  });

  it("a pairing FAILURE does NOT fail the already-succeeded import (job COMPLETED, no throw)", async () => {
    pairingSpy.shouldThrow = true;
    await assert.doesNotReject(() => mod.processImport(job()));
    const statuses = jobStatusUpdates(prisma);
    assert.ok(statuses.includes("COMPLETED"));
    assert.ok(!statuses.includes("FAILED"));
  });

  it("does NOT pair when nothing was imported (all-duplicate import)", async () => {
    // A pre-existing duplicate makes the dup-check return a row → skipped, not
    // imported → imported === 0 → no re-pair.
    prisma.queue("trade", "findFirst", { id: "dup" });
    await mod.processImport(job());
    assert.equal(pairingSpy.calls.length, 0);
    assert.ok(jobStatusUpdates(prisma).includes("COMPLETED"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processSync
// ─────────────────────────────────────────────────────────────────────────────

interface SyncModule {
  processSync: (data: Record<string, unknown>) => Promise<void>;
}
let syncSingleton: SyncModule | null = null;

function installSync(): SyncModule {
  if (syncSingleton) return syncSingleton;
  stub(require.resolve("@usemoney/database"), {
    __esModule: true,
    prisma: STABLE_PRISMA,
    default: STABLE_PRISMA,
  });
  stub(
    require.resolve("@usemoney/core"),
    noopNamed("clearBrokerSyncCache", "clearBrokerConnectionCache")
  );
  stub(require.resolve("@usemoney/services"), {
    __esModule: true,
    syncBrokerConnections: async () => ({
      success: true,
      data: { synced: 5, total: 5, perConnection: [] },
    }),
    syncHistoricalTradebook: async () => ({
      success: true,
      data: { synced: 0, perConnection: [] },
    }),
    buildSyncEmailCounts: () => ({
      holdings: 0,
      positions: 0,
      trades: 0,
      mutualFunds: 0,
    }),
    historicalConnectionsWithErrors: () => [],
  });
  stub(require.resolve("@usemoney/datadog"), {
    __esModule: true,
    metrics: { increment: () => {}, gauge: () => {}, distribution: () => {} },
  });
  stub(
    require.resolve("@usemoney/email"),
    noopNamed(
      "sendEmail",
      "getEffectivePreferences",
      "shouldSendEmail",
      "buildUnsubscribeUrl"
    )
  );
  stub(require.resolve("@usemoney/email/templates"), {
    __esModule: true,
    HistoricalSyncCompleteEmail: () => null,
    SyncCompleteEmail: () => null,
  });
  stub(workerPath("../lib/notifications"), noopNamed("createNotification"));
  stub(workerPath("pairing"), pairingStub());
  // MONEY-1062 (W0): the worker-local ../lib/pubsub-client was deleted and
  // workers/src/processors/sync.ts now imports getPubSubClient from the
  // @usemoney/pubsub/client SUBPATH. Stub THAT specifier — otherwise the wildcard
  // fan-out path (sync.ts:448) builds a real GCP PubSub client and the test hangs
  // (cancelledByParent) instead of observing the fan-out.
  stub(require.resolve("@usemoney/pubsub/client"), {
    __esModule: true,
    getPubSubClient: () => ({
      topic: () => ({
        publishMessage: async () => {
          fanoutSpy.published++;
          return "stub-msg-id";
        },
      }),
    }),
  });
  const cache = moduleCache();
  for (const key of Object.keys(cache)) {
    if (
      key.endsWith("/workers/src/processors/sync.ts") ||
      key.endsWith("/workers/src/processors/sync-logic.ts")
    ) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  syncSingleton = require(workerPath("sync.ts")) as SyncModule;
  return syncSingleton;
}

describe("MONEY-840 — processSync re-triggers pairing in-process (LIVE)", () => {
  let prisma: RecordingPrisma;
  let mod: SyncModule;
  before(() => {
    mod = installSync();
  });
  beforeEach(() => {
    prisma = resetState();
  });
  after(() => {
    uninstall();
  });

  it("calls processPairing({ jobId, userId }) once on a successful user sync, signature unchanged", async () => {
    await mod.processSync({
      jobId: "sync-1",
      userId: "u-1",
      broker: "ZERODHA",
    });
    assert.equal(pairingSpy.calls.length, 1);
    assert.equal(pairingSpy.calls[0]!.userId, "u-1");
    assert.equal(pairingSpy.calls[0]!.extraKeys.length, 0); // ONLY jobId + userId
    assert.ok(jobStatusUpdates(prisma).includes("COMPLETED"));
  });

  it("a pairing FAILURE does NOT fail the already-succeeded sync (job COMPLETED, no throw)", async () => {
    pairingSpy.shouldThrow = true;
    await assert.doesNotReject(() =>
      mod.processSync({ jobId: "sync-2", userId: "u-1", broker: "ZERODHA" })
    );
    const statuses = jobStatusUpdates(prisma);
    assert.ok(statuses.includes("COMPLETED"));
    assert.ok(!statuses.includes("FAILED"));
  });

  it("FANS OUT (no direct sync/pairing) for the wildcard scheduled sync", async () => {
    await mod.processSync({ jobId: "sync-3", userId: "*", isScheduled: true });
    assert.equal(pairingSpy.calls.length, 0); // fan-out returns before pairing
    assert.ok(fanoutSpy.published > 1); // published shard messages instead
  });

  it("re-pairs bucket users with needsRepairing trades on a sharded scheduled sync", async () => {
    // A shard leaf ({syncBucket:N}) syncs many users; pair each whose trades
    // changed (needsRepairing) — userId stays "*" so the per-user trigger skips.
    prisma.queue("brokerConnection", "findMany", [
      { userId: "u-1" },
      { userId: "u-2" },
    ]);
    prisma.queue("trade", "findMany", [{ userId: "u-1" }]); // only u-1 changed
    await mod.processSync({
      jobId: "sync-4",
      userId: "*",
      isScheduled: true,
      syncBucket: 3,
    });
    assert.equal(pairingSpy.calls.length, 1);
    assert.equal(pairingSpy.calls[0]!.userId, "u-1");
  });
});
