/**
 * Subscription Action Tests (MONEY-620) — DE-SHADOWED.
 *
 * The previous version reimplemented getAddonQueries, checkQueryReset,
 * calculateGracePeriodEndDate, isGracePeriodExpired, consumeQuery, refundQuery
 * and calculateAddonLimits INLINE (with a stale PLAN_CONFIG: PREMIUM annual
 * 9999, ULTIMATE 1999) and asserted the copies — a shadow.
 *
 * This rewrite:
 *   - asserts the REAL pure exports for recurring/grace/expiry math
 *     (`isRecurringPlan`, `calculateGracePeriodEndDate`, `isExpired`,
 *     `classifyExpiry`) from `subscription-logic.ts`; and
 *   - drives the REAL `consumeAIQuery` / `refundAIQuery` exported from
 *     `subscription.service.ts` against a recording prisma stub injected at the
 *     `@usemoney/database` boundary (the `demo-routes-branches.test.ts` seam),
 *     so plan-first→pack-fallback consumption, the FREE/inactive gates and the
 *     refund pool selection are exercised in the REAL code path (the
 *     query-pack `PLAN_CONFIG` limits are read from `@usemoney/core`, not a copy).
 *
 * Sources:
 *   - packages/services/src/subscription-logic.ts
 *   - packages/services/src/subscription.service.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  isRecurringPlan,
  calculateGracePeriodEndDate,
  isExpired,
  classifyExpiry,
} from "../../../../packages/services/src/subscription-logic";

// ════════════════════════════════════════════════════════════════════
// PART 1 — pure grace / recurring / expiry math (real exports)
// ════════════════════════════════════════════════════════════════════

describe("Subscription Actions: isRecurringPlan (real export)", () => {
  it("PREMIUM/ULTIMATE recur; PRO only with monthly/annual; FREE/QUERY_PACK never", () => {
    assert.equal(isRecurringPlan("PREMIUM", null), true);
    assert.equal(isRecurringPlan("ULTIMATE", "monthly"), true);
    assert.equal(isRecurringPlan("PRO", "monthly"), true);
    assert.equal(isRecurringPlan("PRO", "annual"), true);
    assert.equal(isRecurringPlan("PRO", null), false);
    assert.equal(isRecurringPlan("FREE", null), false);
    assert.equal(isRecurringPlan("QUERY_PACK", null), false);
  });
});

describe("Subscription Actions: calculateGracePeriodEndDate (real export)", () => {
  it("PRO -> +1y; PREMIUM annual -> +1y; PREMIUM monthly -> +1mo", () => {
    const start = new Date("2025-03-15T00:00:00.000Z");
    assert.equal(
      calculateGracePeriodEndDate("PRO", null, start)!.getUTCFullYear(),
      2026
    );
    assert.equal(
      calculateGracePeriodEndDate("PREMIUM", "annual", start)!.getUTCFullYear(),
      2026
    );
    assert.equal(
      calculateGracePeriodEndDate("PREMIUM", "monthly", start)!.getUTCMonth(),
      3 // April
    );
  });

  it("FREE -> null; invalid start -> null (fail closed)", () => {
    assert.equal(
      calculateGracePeriodEndDate("FREE", null, new Date("2025-01-01")),
      null
    );
    assert.equal(
      calculateGracePeriodEndDate("PREMIUM", "annual", new Date("x")),
      null
    );
  });
});

describe("Subscription Actions: grace expiry (real export)", () => {
  const now = new Date("2025-06-01T00:00:00.000Z");
  it("past endDate -> expired; future -> not; null -> not; at-boundary -> not", () => {
    assert.equal(isExpired(new Date("2025-01-01"), now), true);
    assert.equal(isExpired(new Date("2026-01-01"), now), false);
    assert.equal(isExpired(null, now), false);
    assert.equal(classifyExpiry(new Date(now.getTime()), now), "at-boundary");
    assert.equal(isExpired(new Date(now.getTime()), now), false);
  });

  it("[SECURITY] Invalid-Date endDate -> expired (not 'never expires')", () => {
    assert.equal(isExpired(new Date("garbage"), now), true);
  });
});

// ════════════════════════════════════════════════════════════════════
// PART 2 — LIVE consumeAIQuery / refundAIQuery via recording prisma seam
// ════════════════════════════════════════════════════════════════════

interface SubRow {
  id: string;
  userId: string;
  planId: string;
  status: string;
  fastQueriesUsed: number | null;
  fastQueriesLimit: number | null;
  advancedQueriesUsed: number | null;
  advancedQueriesLimit: number | null;
  queryPackActive: boolean | null;
  queryPackFastQueriesUsed: number | null;
  queryPackFastQueriesLimit: number | null;
  queryPackAdvancedQueriesUsed: number | null;
  queryPackAdvancedQueriesLimit: number | null;
}

function makeRow(over: Partial<SubRow> & { userId: string }): SubRow {
  return {
    id: `sub-${over.userId}`,
    planId: "PRO",
    status: "ACTIVE",
    fastQueriesUsed: 0,
    fastQueriesLimit: 20,
    advancedQueriesUsed: 0,
    advancedQueriesLimit: 5,
    queryPackActive: false,
    queryPackFastQueriesUsed: 0,
    queryPackFastQueriesLimit: 0,
    queryPackAdvancedQueriesUsed: 0,
    queryPackAdvancedQueriesLimit: 0,
    ...over,
  };
}

interface Recorder {
  store: Map<string, SubRow>;
  updates: Array<{ userId: string; data: Record<string, unknown> }>;
}

function makePrismaStub(rec: Recorder) {
  return {
    subscription: {
      findUnique: async (a: { where: { userId: string } }) => {
        const r = rec.store.get(a.where.userId);
        return r ? { ...r } : null;
      },
      update: async (a: {
        where: { userId: string };
        data: Record<string, unknown>;
      }) => {
        rec.updates.push({ userId: a.where.userId, data: a.data });
        const cur = rec.store.get(a.where.userId);
        if (!cur) throw new Error("no row");
        // Resolve `{ increment: n }` and plain sets the way Prisma would.
        const next = { ...cur } as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(a.data)) {
          if (v && typeof v === "object" && "increment" in v) {
            const curVal = (next[k] as number) ?? 0;
            next[k] = curVal + (v as { increment: number }).increment;
          } else {
            next[k] = v;
          }
        }
        rec.store.set(a.where.userId, next as unknown as SubRow);
        return { ...(next as unknown as SubRow) };
      },
    },
  };
}

type ServiceModule =
  typeof import("../../../../packages/services/src/subscription.service");

const dbPath = require.resolve("@usemoney/database");
const logPath = require.resolve("@usemoney/logger");
const svcPath =
  require.resolve("../../../../packages/services/src/subscription.service");

function cacheMap(): Record<string, unknown> {
  return (require as unknown as { cache: Record<string, unknown> }).cache;
}

function loadServiceWith(rec: Recorder): ServiceModule {
  const cache = cacheMap();
  delete cache[svcPath];
  delete cache[dbPath];
  delete cache[logPath];
  cache[dbPath] = {
    exports: {
      __esModule: true,
      prisma: makePrismaStub(rec),
      PlanType: {},
      Prisma: {},
    },
  };
  cache[logPath] = {
    exports: {
      __esModule: true,
      dbLogger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../../../packages/services/src/subscription.service") as ServiceModule;
}

describe("subscription.service (LIVE) — consumeAIQuery / refundAIQuery", () => {
  let rec: Recorder;
  let svc: ServiceModule;

  beforeEach(() => {
    rec = { store: new Map(), updates: [] };
    svc = loadServiceWith(rec);
  });

  afterEach(() => {
    const cache = cacheMap();
    delete cache[svcPath];
    delete cache[dbPath];
    delete cache[logPath];
  });

  it("consumes a fast query from the plan pool when available", async () => {
    rec.store.set("u", makeRow({ userId: "u", fastQueriesUsed: 5 }));
    const res = await svc.consumeAIQuery("u", "fast");
    assert.ok(res.success);
    assert.equal(res.data.remaining, 14); // PRO fast=20, used 5 -> 6 used -> 14 left
  });

  it("[gate] FREE plan cannot consume — returns upgrade error", async () => {
    rec.store.set("u", makeRow({ userId: "u", planId: "FREE" }));
    const res = await svc.consumeAIQuery("u", "fast");
    assert.equal(res.success, false);
    assert.ok(!res.success && /upgrade/i.test(res.error));
  });

  it("[gate] non-ACTIVE (CANCELLED) cannot consume — returns activate error", async () => {
    rec.store.set("u", makeRow({ userId: "u", status: "CANCELLED" }));
    const res = await svc.consumeAIQuery("u", "fast");
    assert.equal(res.success, false);
    assert.ok(!res.success && /activate/i.test(res.error));
  });

  it("PREMIUM fast queries are unlimited (Infinity remaining)", async () => {
    rec.store.set("u", makeRow({ userId: "u", planId: "PREMIUM" }));
    const res = await svc.consumeAIQuery("u", "fast");
    assert.ok(res.success);
    assert.equal(res.data.remaining, Infinity);
  });

  it("falls back to the query pack once the plan pool is exhausted", async () => {
    rec.store.set(
      "u",
      makeRow({
        userId: "u",
        fastQueriesUsed: 20, // PRO plan fast (20) exhausted
        queryPackActive: true,
        queryPackFastQueriesUsed: 5,
        queryPackFastQueriesLimit: 200,
      })
    );
    const res = await svc.consumeAIQuery("u", "fast");
    assert.ok(res.success);
    assert.equal(res.data.remaining, 194); // 200 - 6
  });

  it("returns QUERIES_EXHAUSTED when both plan and pack are spent", async () => {
    rec.store.set(
      "u",
      makeRow({
        userId: "u",
        fastQueriesUsed: 20,
        queryPackActive: true,
        queryPackFastQueriesUsed: 200,
        queryPackFastQueriesLimit: 200,
      })
    );
    const res = await svc.consumeAIQuery("u", "fast");
    assert.equal(res.success, false);
    assert.ok(!res.success && res.code === "QUERIES_EXHAUSTED");
  });

  it("advanced queries consume from the plan pool then the pack", async () => {
    rec.store.set(
      "u",
      makeRow({
        userId: "u",
        advancedQueriesUsed: 5, // PRO advanced (5) exhausted
        queryPackActive: true,
        queryPackAdvancedQueriesUsed: 10,
        queryPackAdvancedQueriesLimit: 50,
      })
    );
    const res = await svc.consumeAIQuery("u", "advanced");
    assert.ok(res.success);
    assert.equal(res.data.remaining, 39); // 50 - 11
  });

  it("refundAIQuery returns a successful ServiceResult and decrements the plan pool", async () => {
    rec.store.set("u", makeRow({ userId: "u", fastQueriesUsed: 10 }));
    const res = await svc.refundAIQuery("u", "fast");
    assert.ok(res.success);
    const wrote = rec.updates.find((u) => u.userId === "u");
    assert.ok(wrote, "a refund write should occur");
    assert.equal(wrote!.data.fastQueriesUsed, 9);
  });

  it("refundAIQuery on an untouched pool is a safe no-op success", async () => {
    rec.store.set("u", makeRow({ userId: "u", fastQueriesUsed: 0 }));
    const res = await svc.refundAIQuery("u", "fast");
    assert.ok(res.success);
    assert.equal(
      rec.updates.find((u) => u.userId === "u"),
      undefined,
      "no write when nothing to refund"
    );
  });

  it("consumeAIQuery on a missing subscription fails gracefully (no throw)", async () => {
    const res = await svc.consumeAIQuery("ghost", "fast");
    assert.equal(res.success, false);
  });
});
