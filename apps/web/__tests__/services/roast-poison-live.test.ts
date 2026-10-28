/**
 * MONEY-620 — roast.service POISON + IDOR, on the LIVE service.
 *
 * Drives the REAL exported `getRoastStatus` / `getRunningRoasts` /
 * `getRoastHistory` / `getRecentRoastSessions` from `@usemoney/services`
 * (`packages/services/src/roast.service.ts`) — the user-facing roast status /
 * list paths the web action (`apps/web/lib/actions/roast.ts`) and the chat
 * reconcile call — through a RECORDING prisma double injected at the
 * `@usemoney/database` / `@usemoney/logger` module boundary via `require.cache`.
 * This is the proven seam from `services/holdings-poison-live.test.ts`. No inline
 * reimplementation: the SAME code that ships computes what we assert (no shadow),
 * and no live Mongo is touched (pure, exits clean).
 *
 * What this pins on the LIVE service (the service-side finite-guard /
 * consumer-safety de-shadow):
 *   1. CONSUMER-SAFETY — the worker can persist a corrupt `score` (NaN from a
 *      non-numeric model output) or out-of-range `progress`. `getRoastStatus`
 *      forwards them to the score gauge (`{score}`) and progress view
 *      (`{progress}%`) verbatim, so a NaN/Infinity/150 used to render as
 *      `NaN`, `NaN%`, `Infinity%`, `150%`. After the fix every surfaced
 *      `progress` is a finite integer [0,100] and every `score` is a finite
 *      integer [0,100] or `null`.
 *   2. NULL-PRESERVING — an in-progress roast's `score` is `null` (not yet
 *      scored) and MUST stay `null`, never a phantom 50.
 *   3. IDOR — `getRoastStatus(sessionId, userId)` issues `findFirst` with a
 *      userId-scoped WHERE (an attacker can't read a victim's status/score);
 *      `getRunningRoasts`/`getRoastHistory` scope `findMany` to the caller.
 *   4. BEHAVIOUR-PRESERVING — clean finite data yields the exact prior values.
 *   5. DB-throw sanitization — a raw Mongo error never leaks.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: packages/services/src/roast.service.ts + ./roast-logic.ts
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
        // dbLogger and any other named logger export → the silent logger.
        return SILENT_LOGGER;
      },
    }
  );
}

let activePrisma: RecordingPrisma = new RecordingPrisma();

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

// ── live service surface under test ─────────────────────────────────────────

type Result<T> =
  | { success: true; data: T; message?: string }
  | { success: false; error: string };

interface SafeStatus {
  status: string;
  progress: number;
  currentStep: string | null;
  score: number | null;
  errorMessage: string | null;
}
interface RunningItem {
  sessionId: string;
  mode: string;
  broker: string | null;
  assetType: string;
  status: string;
  progress: number;
  currentStep: string | null;
  createdAt: Date;
}
interface HistoryItem {
  id: string;
  sessionId: string;
  mode: string;
  broker: string | null;
  assetType: string;
  status: string;
  score: number | null;
  errorMessage: string | null;
  createdAt: Date;
}

interface ServicesModule {
  getRoastStatus: (
    sessionId: string,
    userId?: string
  ) => Promise<Result<SafeStatus>>;
  getRunningRoasts: (userId: string) => Promise<Result<RunningItem[]>>;
  getRoastHistory: (
    userId: string,
    page?: number,
    pageSize?: number
  ) => Promise<Result<{ items: HistoryItem[]; total: number }>>;
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
  stub(require.resolve("@usemoney/logger"), makeLoggerStub());
  // Force the services package (and its -logic siblings) to re-resolve against
  // the stubbed boundary instead of any previously-cached real modules.
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

function reset(): RecordingPrisma {
  activePrisma = new RecordingPrisma();
  return activePrisma;
}

function ok<T>(r: Result<T>): { success: true; data: T } {
  assert.equal(r.success, true, `expected success, got ${JSON.stringify(r)}`);
  return r as { success: true; data: T };
}

// A full PortfolioRoast status selection (defaults clean).
function dbStatus(
  overrides: Partial<{
    status: string;
    progress: number;
    currentStep: string | null;
    score: number | null;
    errorMessage: string | null;
  }> = {}
) {
  return {
    status: "ANALYZING_STOCKS",
    progress: 40,
    currentStep: "Analyzing stocks",
    score: null,
    errorMessage: null,
    ...overrides,
  };
}

// A running-list row selection.
function dbRunning(
  overrides: Partial<RunningItem> = {}
): RunningItem & Record<string, unknown> {
  return {
    sessionId: "sess-1",
    mode: "overall",
    broker: null,
    assetType: "all",
    status: "FETCHING_DATA",
    progress: 25,
    currentStep: "Fetching",
    createdAt: new Date("2026-06-05T10:00:00Z"),
    ...overrides,
  };
}

// A history-list row selection.
function dbHistory(
  overrides: Partial<HistoryItem> = {}
): HistoryItem & Record<string, unknown> {
  return {
    id: "h-1",
    sessionId: "sess-h-1",
    mode: "overall",
    broker: null,
    assetType: "all",
    status: "COMPLETED",
    score: 72,
    errorMessage: null,
    createdAt: new Date("2026-06-04T10:00:00Z"),
    ...overrides,
  };
}

// ── getRoastStatus: consumer-safety + IDOR ───────────────────────────────────

describe("MONEY-620 — getRoastStatus: poisoned score/progress never reach the gauge (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });
  after(() => {
    uninstallServices();
  });

  it("NaN score + Infinity progress → finite [0,100] score & 0 progress, no NaN/Infinity strings", async () => {
    prisma.queue(
      "portfolioRoast",
      "findFirst",
      dbStatus({ status: "COMPLETED", score: NaN, progress: Infinity })
    );
    const res = ok(await svc.getRoastStatus("sess-x", "owner"));
    // score: a present-but-corrupt score coerces to the neutral 50.
    assert.equal(res.data.score, 50);
    assert.ok(res.data.score === null || Number.isFinite(res.data.score));
    // progress: Infinity → 0.
    assert.equal(res.data.progress, 0);
    assert.ok(Number.isFinite(res.data.progress));
    // The strings the UI renders are never NaN/Infinity.
    assert.notEqual(`${res.data.progress}%`, "NaN%");
    assert.notEqual(`${res.data.progress}%`, "Infinity%");
    assert.notEqual(`${res.data.score}`, "NaN");
  });

  it("out-of-range progress 150 & score 250 clamp to 100", async () => {
    prisma.queue(
      "portfolioRoast",
      "findFirst",
      dbStatus({ status: "COMPLETED", progress: 150, score: 250 })
    );
    const res = ok(await svc.getRoastStatus("sess-y", "owner"));
    assert.equal(res.data.progress, 100);
    assert.equal(res.data.score, 100);
  });

  it("[CRITICAL] in-progress roast: null score STAYS null (no phantom 50)", async () => {
    prisma.queue(
      "portfolioRoast",
      "findFirst",
      dbStatus({ status: "ANALYZING_STOCKS", score: null, progress: 40 })
    );
    const res = ok(await svc.getRoastStatus("sess-prog", "owner"));
    assert.equal(res.data.score, null);
    assert.equal(res.data.progress, 40);
  });

  it("behaviour-preserving: a clean completed row keeps its exact score/progress", async () => {
    prisma.queue(
      "portfolioRoast",
      "findFirst",
      dbStatus({
        status: "COMPLETED",
        progress: 100,
        score: 72,
        currentStep: null,
      })
    );
    const res = ok(await svc.getRoastStatus("sess-ok", "owner"));
    assert.deepEqual(res.data, {
      status: "COMPLETED",
      progress: 100,
      currentStep: null,
      score: 72,
      errorMessage: null,
    });
  });

  it("[IDOR] the findFirst WHERE carries sessionId AND userId when userId is passed", async () => {
    prisma.queue("portfolioRoast", "findFirst", dbStatus());
    await svc.getRoastStatus("sess-idor", "alice");
    const args = prisma.callsFor("portfolioRoast", "findFirst")[0]!.args as {
      where: { sessionId: string; userId: string };
    };
    assert.equal(args.where.sessionId, "sess-idor");
    assert.equal(args.where.userId, "alice");
  });

  it("[IDOR] a non-owner lookup resolves as 'Roast not found' (findFirst returns null)", async () => {
    // The userId-scoped findFirst returns null for a foreign sessionId.
    const res = await svc.getRoastStatus("victim-sess", "attacker");
    assert.equal(res.success, false);
    assert.equal(
      (res as { success: false; error: string }).error,
      "Roast not found"
    );
  });

  it("error message does not leak; a raw DB error is sanitized", async () => {
    prisma.fail(
      "portfolioRoast",
      "findFirst",
      new Error("E11000 duplicate key error on internal.collection")
    );
    const res = await svc.getRoastStatus("sess-err", "owner");
    assert.equal(res.success, false);
    assert.equal(
      (res as { success: false; error: string }).error,
      "Failed to get roast status"
    );
  });
});

// ── getRunningRoasts: progress clamp + IDOR ──────────────────────────────────

describe("MONEY-620 — getRunningRoasts: corrupt progress clamped on the running list (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });
  after(() => {
    uninstallServices();
  });

  it("every row's progress is a finite integer [0,100]; no phantom score field added", async () => {
    prisma.queue("portfolioRoast", "findMany", [
      dbRunning({ sessionId: "r1", progress: NaN }),
      dbRunning({ sessionId: "r2", progress: 150 }),
      dbRunning({ sessionId: "r3", progress: -10 }),
      dbRunning({ sessionId: "r4", progress: Infinity }),
      dbRunning({ sessionId: "r5", progress: 33 }),
    ]);
    const res = ok(await svc.getRunningRoasts("owner"));
    const byId = new Map(res.data.map((r) => [r.sessionId, r]));
    assert.equal(byId.get("r1")!.progress, 0); // NaN → 0
    assert.equal(byId.get("r2")!.progress, 100); // 150 → 100
    assert.equal(byId.get("r3")!.progress, 0); // -10 → 0
    assert.equal(byId.get("r4")!.progress, 0); // Infinity → 0
    assert.equal(byId.get("r5")!.progress, 33); // preserved
    for (const r of res.data) {
      assert.ok(Number.isFinite(r.progress), `${r.sessionId} progress finite`);
      assert.notEqual(`${r.progress}%`, "NaN%");
      assert.equal("score" in r, false, "running row must not gain a score");
    }
  });

  it("[IDOR] findMany WHERE scopes to the caller userId and excludes terminal", async () => {
    prisma.queue("portfolioRoast", "findMany", []);
    await svc.getRunningRoasts("bob");
    const args = prisma.callsFor("portfolioRoast", "findMany")[0]!.args as {
      where: { userId: string; status: { notIn: string[] } };
    };
    assert.equal(args.where.userId, "bob");
    assert.deepEqual(args.where.status.notIn, ["COMPLETED", "FAILED"]);
  });

  it("behaviour-preserving: a clean running row is unchanged in value", async () => {
    const row = dbRunning({ sessionId: "clean", progress: 60 });
    prisma.queue("portfolioRoast", "findMany", [row]);
    const res = ok(await svc.getRunningRoasts("owner"));
    assert.deepEqual(res.data[0], row);
  });
});

// ── getRoastHistory: score clamp + IDOR ──────────────────────────────────────

describe("MONEY-620 — getRoastHistory: corrupt score clamped on history rows (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule;
  before(() => {
    svc = installServices();
  });
  beforeEach(() => {
    prisma = reset();
  });
  after(() => {
    uninstallServices();
  });

  it("a corrupt persisted score is clamped/neutralised; null FAILED score preserved", async () => {
    prisma.queue("portfolioRoast", "findMany", [
      dbHistory({ id: "h-nan", sessionId: "s-nan", score: NaN }),
      dbHistory({ id: "h-big", sessionId: "s-big", score: 250 }),
      dbHistory({
        id: "h-fail",
        sessionId: "s-fail",
        status: "FAILED",
        score: null,
        errorMessage: "sync failed",
      }),
      dbHistory({ id: "h-ok", sessionId: "s-ok", score: 65 }),
    ]);
    prisma.queue("portfolioRoast", "count", 4);
    const res = ok(await svc.getRoastHistory("owner", 1, 20));
    const byId = new Map(res.data.items.map((i) => [i.id, i]));
    assert.equal(byId.get("h-nan")!.score, 50); // NaN → neutral 50
    assert.equal(byId.get("h-big")!.score, 100); // 250 → 100
    assert.equal(byId.get("h-fail")!.score, null); // FAILED null preserved
    assert.equal(byId.get("h-ok")!.score, 65); // preserved
    assert.equal(res.data.total, 4);
    for (const i of res.data.items) {
      assert.ok(
        i.score === null || Number.isFinite(i.score),
        `${i.id} score finite-or-null`
      );
      // No phantom progress field on a history row.
      assert.equal("progress" in i, false);
    }
  });

  it("[IDOR] findMany + count WHERE both scope to the caller userId", async () => {
    prisma.queue("portfolioRoast", "findMany", []);
    prisma.queue("portfolioRoast", "count", 0);
    await svc.getRoastHistory("carol", 1, 20);
    const findArgs = prisma.callsFor("portfolioRoast", "findMany")[0]!.args as {
      where: { userId: string; status: { in: string[] } };
    };
    const countArgs = prisma.callsFor("portfolioRoast", "count")[0]!.args as {
      where: { userId: string };
    };
    assert.equal(findArgs.where.userId, "carol");
    assert.deepEqual(findArgs.where.status.in, ["COMPLETED", "FAILED"]);
    assert.equal(countArgs.where.userId, "carol");
  });

  it("behaviour-preserving: a clean history row is unchanged in value", async () => {
    const row = dbHistory({ id: "clean", sessionId: "clean", score: 80 });
    prisma.queue("portfolioRoast", "findMany", [row]);
    prisma.queue("portfolioRoast", "count", 1);
    const res = ok(await svc.getRoastHistory("owner", 1, 20));
    assert.deepEqual(res.data.items[0], row);
  });
});

// ── getRecentRoastSessions: progress+score clamp on the LIVE prisma path ──────

describe("MONEY-620 — getRecentRoastSessions: clamp on the LIVE prisma path (LIVE)", () => {
  let prisma: RecordingPrisma;
  let svc: ServicesModule & {
    getRecentRoastSessions: (
      userId: string
    ) => Promise<Result<Array<Record<string, unknown>>>>;
  };
  before(() => {
    svc = installServices() as typeof svc;
  });
  beforeEach(() => {
    prisma = reset();
  });
  after(() => {
    uninstallServices();
  });

  it("default finder (real prisma findMany) clamps progress & score, preserves null", async () => {
    // Drive the REAL default-finder branch: no finder injected, so the service
    // calls prisma.portfolioRoast.findMany via the stubbed boundary.
    prisma.queue("portfolioRoast", "findMany", [
      {
        sessionId: "rec-bad",
        mode: "overall",
        broker: null,
        assetType: "all",
        status: "COMPLETED",
        progress: 150,
        currentStep: null,
        score: NaN,
        createdAt: new Date("2026-06-05T11:00:00Z"),
      },
      {
        sessionId: "rec-prog",
        mode: "overall",
        broker: null,
        assetType: "all",
        status: "SCORING",
        progress: NaN,
        currentStep: "Scoring",
        score: null,
        createdAt: new Date("2026-06-05T10:30:00Z"),
      },
    ]);
    const res = ok(await svc.getRecentRoastSessions("owner"));
    const byId = new Map(res.data.map((r) => [r.sessionId as string, r]));
    assert.equal(byId.get("rec-bad")!.progress, 100); // 150 → 100
    assert.equal(byId.get("rec-bad")!.score, 50); // NaN → 50
    assert.equal(byId.get("rec-prog")!.progress, 0); // NaN → 0
    assert.equal(byId.get("rec-prog")!.score, null); // in-progress null kept
  });

  it("[IDOR] the prisma findMany WHERE scopes to the caller userId + 24h gte", async () => {
    prisma.queue("portfolioRoast", "findMany", []);
    await svc.getRecentRoastSessions("dave");
    const args = prisma.callsFor("portfolioRoast", "findMany")[0]!.args as {
      where: { userId: string; createdAt: { gte: Date } };
      take: number;
    };
    assert.equal(args.where.userId, "dave");
    assert.ok(args.where.createdAt.gte instanceof Date);
    assert.equal(args.take, 20);
  });
});
