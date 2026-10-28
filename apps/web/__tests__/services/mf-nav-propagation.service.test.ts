/**
 * MONEY-1074 — MF NAV propagation SERVICE orchestration (real source).
 *
 * The per-row decision `buildMfNavPatch` is unit-tested in the services package;
 * THIS drives the actual `propagateMfNavToUserFunds` (required directly, not via
 * the barrel) against a recording Prisma double to lock the ORCHESTRATION:
 * keyset cursor drains + terminates, only changed rows are written, a per-row
 * update failure never aborts the batch, and the scanned/updated/skipped counts
 * are correct.
 *
 * Seam: the service hard-imports `prisma` from `@usemoney/database` and a logger
 * from `@usemoney/logger`; we inject doubles via `require.cache` BEFORE requiring
 * the service file, so no real DB/Redis is touched.
 */

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

type Row = Record<string, unknown>;

class FakePrisma {
  pages: Row[][] = [];
  private pageIdx = 0;
  masters: Row[] = [];
  updateCalls: Array<{ where: { id: string }; data: Row }> = [];
  failIds = new Set<string>();

  reset() {
    this.pages = [];
    this.pageIdx = 0;
    this.masters = [];
    this.updateCalls = [];
    this.failIds = new Set();
  }

  readonly client = {
    mutualFund: {
      findMany: async (): Promise<Row[]> => {
        const page = this.pages[this.pageIdx] ?? [];
        this.pageIdx += 1;
        return page;
      },
      update: async (args: {
        where: { id: string };
        data: Row;
      }): Promise<Row> => {
        this.updateCalls.push(args);
        if (this.failIds.has(args.where.id)) throw new Error("update boom");
        return { id: args.where.id };
      },
    },
    mutualFundMaster: {
      findMany: async (): Promise<Row[]> => this.masters,
    },
  };
}

const fake = new FakePrisma();

// Forward property reads to the (stable) fake client.
const STABLE_PRISMA = new Proxy(
  {},
  {
    get(_t, prop: string) {
      if (prop === "then") return undefined;
      return (fake.client as Record<string, unknown>)[prop];
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

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

interface Svc {
  propagateMfNavToUserFunds: (batchSize?: number) => Promise<{
    success: boolean;
    data?: { scanned: number; updated: number; skipped: number };
    error?: string;
  }>;
}

let svc: Svc;

before(() => {
  const cache = moduleCache();
  const stub = (path: string, exports: unknown) => {
    cache[path] = { exports };
  };
  stub(require.resolve("@usemoney/database"), {
    __esModule: true,
    prisma: STABLE_PRISMA,
    default: STABLE_PRISMA,
  });
  stub(require.resolve("@usemoney/logger"), {
    __esModule: true,
    dbLogger: SILENT_LOGGER,
    default: SILENT_LOGGER,
  });
  // Require the service FILE directly (not the @usemoney/services barrel) so we
  // don't drag in the rest of the package.
  svc =
    require("../../../../packages/services/src/mf-nav-propagation.service") as Svc;
});

beforeEach(() => fake.reset());

const navDate = new Date("2026-07-18T00:00:00Z");
const movableFund = (id: string, schemeCode: string): Row => ({
  id,
  schemeCode,
  isin: null,
  units: 100,
  investedAmount: 10000,
  investedValue: null,
  currentNav: 100, // stale → master nav 120 moves it
  currentValue: 10000,
});

describe("propagateMfNavToUserFunds (MONEY-1074)", () => {
  it("updates only rows whose master NAV moved; skips the rest", async () => {
    fake.pages = [[movableFund("a", "S1"), movableFund("b", "S2")]];
    fake.masters = [
      {
        schemeCode: "S1",
        isinGrowth: null,
        isinDividend: null,
        nav: 120,
        navDate,
      },
      // no master for S2 → skip (never zeroed)
    ];

    const res = await svc.propagateMfNavToUserFunds();
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(res.data, { scanned: 2, updated: 1, skipped: 1 });

    assert.strictEqual(fake.updateCalls.length, 1);
    const w = fake.updateCalls[0]!;
    assert.strictEqual(w.where.id, "a");
    assert.strictEqual(w.data.currentNav, 120);
    assert.strictEqual(w.data.currentValue, 12000);
    assert.strictEqual(w.data.unrealizedGain, 2000);
  });

  it("drains a multi-page cursor and TERMINATES on the empty page", async () => {
    // batchSize 2, two full pages then an empty page → break.
    fake.pages = [
      [movableFund("a", "S1"), movableFund("b", "S1")],
      [movableFund("c", "S1"), movableFund("d", "S1")],
      [],
    ];
    fake.masters = [
      {
        schemeCode: "S1",
        isinGrowth: null,
        isinDividend: null,
        nav: 120,
        navDate,
      },
    ];

    const res = await svc.propagateMfNavToUserFunds(2);
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(res.data, { scanned: 4, updated: 4, skipped: 0 });
    assert.strictEqual(fake.updateCalls.length, 4);
  });

  it("isolates a per-row update failure (batch continues, still success)", async () => {
    fake.pages = [[movableFund("a", "S1"), movableFund("b", "S1")]];
    fake.masters = [
      {
        schemeCode: "S1",
        isinGrowth: null,
        isinDividend: null,
        nav: 120,
        navDate,
      },
    ];
    fake.failIds = new Set(["a"]); // update for 'a' throws

    const res = await svc.propagateMfNavToUserFunds();
    assert.strictEqual(res.success, true);
    // 'a' failed → counted skipped; 'b' succeeded.
    assert.deepStrictEqual(res.data, { scanned: 2, updated: 1, skipped: 1 });
    assert.strictEqual(fake.updateCalls.length, 2);
  });

  it("returns success with zero counts when there are no MF rows", async () => {
    fake.pages = [[]];
    const res = await svc.propagateMfNavToUserFunds();
    assert.deepStrictEqual(res.data, { scanned: 0, updated: 0, skipped: 0 });
    assert.strictEqual(fake.updateCalls.length, 0);
  });
});
