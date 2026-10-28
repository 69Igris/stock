/**
 * MONEY-846 — getAvailableFYs SERVICE seam test (LIVE export, no shadow).
 *
 * Drives the REAL exported `getAvailableFYs` from `@usemoney/services`
 * (`packages/services/src/trades.service.ts`) — the Tradebook FY-dropdown data
 * path (`apps/web/lib/actions/trades.ts` → `getAvailableFYsAction` →
 * `getAvailableFYsService`) — through a recording `prisma` double injected at the
 * `@usemoney/database` / `@usemoney/core` / `@usemoney/logger` module boundary
 * via `require.cache` (the same proven seam as `trades-poison-live.test.ts`,
 * trimmed to the one `trade.aggregate` this function makes). No live Mongo/Redis
 * is touched; the SAME bytes that ship compute what we assert (no shadow).
 *
 * What this pins on the LIVE service:
 *   - the aggregate is IDOR-scoped to the caller userId;
 *   - the {_min,_max} tradeDate is mapped through `availableFinancialYears`, so
 *     every spanned Indian FY (IST boundary) comes back NEWEST first, each option
 *     carrying the IST-anchored `gte`/`lte` instants (MONEY-846);
 *   - the no-trades case (`_min`/`_max` null) returns `[]`;
 *   - a thrown aggregate is caught → a sanitized failure (no leak).
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 * Assertions check UTC INSTANTS (`.toISOString()` / ids), never local time, so
 * the file is green under BOTH `TZ=UTC` and `TZ=Asia/Kolkata`.
 *
 * Source: packages/services/src/trades.service.ts#getAvailableFYs
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── recording prisma double (only trade.aggregate is needed here) ────────────

interface AggregateArgs {
  where?: Record<string, unknown>;
  _min?: Record<string, boolean>;
  _max?: Record<string, boolean>;
}

let nextAggregate: { _min: unknown; _max: unknown } = { _min: {}, _max: {} };
let aggregateError: Error | null = null;
const aggregateCalls: AggregateArgs[] = [];

const STABLE_PRISMA = new Proxy(
  {},
  {
    get(target: Record<string, unknown>, model: string) {
      if (typeof model !== "string" || model === "then") return undefined;
      if (!(model in target)) {
        target[model] = {
          aggregate: (args: AggregateArgs) => {
            aggregateCalls.push(args);
            if (aggregateError) return Promise.reject(aggregateError);
            return Promise.resolve(nextAggregate);
          },
        };
      }
      return target[model];
    },
  }
);

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
  // `@usemoney/services` transitively loads `@usemoney/research`, which calls
  // `getLogger()` / `createModuleLoggers()` at MODULE LOAD — so those keys must
  // resolve to a FACTORY function (returning the silent logger), not the logger
  // object itself. Mirrors the proven stub in trades-poison-live.test.ts.
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

function makeCoreStub(): Record<string, unknown> {
  // getAvailableFYs touches no cache, but the service module imports these at
  // load time, so they must resolve to no-ops.
  return new Proxy(
    { __esModule: true },
    {
      get(_t, k: string) {
        if (k === "__esModule") return true;
        if (k === "getCached") return async () => null;
        return async () => undefined;
      },
    }
  );
}

// ── module-boundary injection ────────────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

interface ServicesModule {
  getAvailableFYs: (
    userId: string
  ) => Promise<
    | { success: true; data: { fys: Array<Record<string, unknown>> } }
    | { success: false; error: string }
  >;
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
  stub(require.resolve("@usemoney/logger"), makeLoggerStub());
  // Force the services package to re-evaluate against the stubs.
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

// ── tests ────────────────────────────────────────────────────────────────────

describe("getAvailableFYs (LIVE service, MONEY-846)", () => {
  let svc: ServicesModule;

  before(() => {
    svc = installServices();
  });
  after(() => {
    uninstallServices();
  });
  beforeEach(() => {
    nextAggregate = { _min: {}, _max: {} };
    aggregateError = null;
    aggregateCalls.length = 0;
  });

  it("IDOR-scopes the aggregate to the caller userId", async () => {
    nextAggregate = {
      _min: { tradeDate: new Date("2024-06-10T00:00:00Z") },
      _max: { tradeDate: new Date("2024-08-10T00:00:00Z") },
    };
    await svc.getAvailableFYs("user-42");
    assert.equal(aggregateCalls.length, 1);
    assert.deepEqual(aggregateCalls[0]!.where, { userId: "user-42" });
  });

  it("maps min→max tradeDate to every spanned FY (newest first) with IST instants", async () => {
    nextAggregate = {
      _min: { tradeDate: new Date("2024-06-10T00:00:00Z") }, // FY 2024
      _max: { tradeDate: new Date("2026-05-20T00:00:00Z") }, // FY 2026
    };
    const r = await svc.getAvailableFYs("u");
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.deepEqual(
      r.data.fys.map((f) => f.id),
      ["fy-2026", "fy-2025", "fy-2024"]
    );
    // The newest option carries the IST-anchored UTC instant window.
    const newest = r.data.fys[0]!;
    assert.equal(newest.gte, "2026-03-31T18:30:00.000Z"); // 1-Apr-2026 00:00 IST
    assert.equal(newest.lte, "2027-03-31T18:29:59.999Z"); // 31-Mar-2027 23:59:59.999 IST
  });

  it("a 1-Apr-IST-sliver max date includes that NEW FY (not mis-bucketed)", async () => {
    nextAggregate = {
      _min: { tradeDate: new Date("2025-06-01T00:00:00Z") }, // FY 2025
      // 2026-03-31T20:30:00Z == 1-Apr-2026 02:00 IST → FY 2026.
      _max: { tradeDate: new Date("2026-03-31T20:30:00Z") },
    };
    const r = await svc.getAvailableFYs("u");
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.deepEqual(
      r.data.fys.map((f) => f.id),
      ["fy-2026", "fy-2025"]
    );
  });

  it("no trades (null min/max) → empty list", async () => {
    nextAggregate = { _min: { tradeDate: null }, _max: { tradeDate: null } };
    const r = await svc.getAvailableFYs("u");
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.deepEqual(r.data.fys, []);
  });

  it("a thrown aggregate is caught → sanitized failure (no leak)", async () => {
    aggregateError = new Error("mongo: connection reset by peer");
    const r = await svc.getAvailableFYs("u");
    assert.equal(r.success, false);
    if (r.success) return;
    assert.equal(r.error, "Failed to load financial years");
  });
});
