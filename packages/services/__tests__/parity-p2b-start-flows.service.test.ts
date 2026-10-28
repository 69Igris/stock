/**
 * MONEY-1062 P2b async-START credit-flow tests (REAL service fns, injected seams).
 *
 * `@usemoney/services` runs its suite as ESM (no `require.cache` module-mocking),
 * so the pubsub / credit / prisma collaborators are injected via each start
 * function's `deps` seam. This pins the G3 invariants on the code that SHIPS:
 *   - an early GATE failure (feature / credit / input / broker) consumes NO
 *     credit and publishes NO job,
 *   - roast: createRoastSession is CHECKED and a failure returns BEFORE the
 *     credit is consumed (the MONEY-1062 fix) — create precedes consume,
 *   - the credit consume/reserve precedes the publish,
 *   - a publish failure runs the EXACT refund leg the web action runs
 *     (research → refundCredits; roast → refundRoastCredit + FAILED; comparison
 *     → refundReservationCredits + FAILED; analysis → FAILED + refundCredits).
 *
 * Source: packages/services/src/{research,roast,comparison,analysis}.service.ts
 * Mirrors: apps/web/lib/actions/{research,roast,comparison,analysis}.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  startResearchJob,
  type StartResearchDeps,
} from "../src/research.service";
import {
  startRoast,
  canUseRoast,
  type StartRoastDeps,
} from "../src/roast.service";
import {
  startComparison,
  type StartComparisonDeps,
} from "../src/comparison.service";
import {
  startComprehensiveAnalysis,
  getAnalysisStatus,
  getAnalysisResult,
  cancelAnalysis,
  type StartAnalysisDeps,
  type AnalysisReadDeps,
  type CancelAnalysisDeps,
} from "../src/analysis.service";

type Rec = Record<string, unknown>;
const ok = <T>(data: T) => ({ success: true as const, data });

// ══════════════════════════════════════════════════════════════════════════
// RESEARCH — consume (GATE) → create → publish; refund on publish failure
// ══════════════════════════════════════════════════════════════════════════

interface ResearchOpts {
  planId?: string;
  consumeResult?: unknown;
  publishThrows?: boolean;
}
function researchDeps(opts: ResearchOpts = {}) {
  const order: string[] = [];
  const calls = {
    consume: [] as unknown[][],
    refund: [] as unknown[][],
    create: [] as Rec[],
    update: [] as Rec[],
    publish: [] as Rec[],
  };
  const deps = {
    prisma: {
      subscription: {
        findUnique: async () => ({ planId: opts.planId ?? "FREE" }),
      },
      researchSession: {
        create: async (a: Rec) => {
          order.push("create");
          calls.create.push(a);
          return {};
        },
        update: async (a: Rec) => {
          order.push("update");
          calls.update.push(a);
          return {};
        },
      },
    },
    getComposerPreferences: async () => ({}),
    resolveResearchModel: () => "test-model",
    getEffectiveCreditCost: (_a: string, _m: string, base: number) => base,
    consumeCredits: async (...a: unknown[]) => {
      order.push("consume");
      calls.consume.push(a);
      return (
        opts.consumeResult ??
        ok({ remaining: 1, source: "plan", creditsUsed: 1 })
      );
    },
    refundCredits: async (...a: unknown[]) => {
      order.push("refund");
      calls.refund.push(a);
      return ok({ refunded: 1 });
    },
    publishResearchJob: async (m: Rec) => {
      order.push("publish");
      calls.publish.push(m);
      if (opts.publishThrows) throw new Error("pubsub down");
      return "mid";
    },
  } as unknown as StartResearchDeps;
  return { deps, order, calls };
}

describe("startResearchJob — credit flow (G3)", () => {
  it("fast run: consume(l2_research_fast) → create → publish, in order", async () => {
    const { deps, order, calls } = researchDeps();
    const res = await startResearchJob("u1", { query: "Analyse TCS" }, deps);
    assert.equal(res.success, true);
    assert.deepEqual(order, ["consume", "create", "publish"]);
    assert.equal(calls.consume[0]![1], "l2_research_fast");
    assert.equal(calls.consume[0]![0], "u1");
    if (res.success) assert.ok(res.data.sessionId);
  });

  it("advanced mode consumes l2_research_advanced", async () => {
    const { deps, calls } = researchDeps();
    await startResearchJob("u1", { query: "x", mode: "advanced" }, deps);
    assert.equal(calls.consume[0]![1], "l2_research_advanced");
  });

  it("comparison (>1 symbol) consumes base + per-stock top-up", async () => {
    const { deps, calls } = researchDeps();
    await startResearchJob(
      "u1",
      { query: "x", symbols: ["A", "B", "C"] },
      deps,
    );
    assert.equal(calls.consume[0]![1], "l3_multi_comparison_base");
    assert.equal(calls.consume[1]![1], "l3_multi_comparison_per_stock");
  });

  it("GATE: insufficient credits → NO create, NO publish, code NO_CREDITS", async () => {
    const { deps, order, calls } = researchDeps({
      consumeResult: {
        success: false,
        error: "Not enough credits.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
    const res = await startResearchJob("u1", { query: "x" }, deps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "NO_CREDITS");
    assert.deepEqual(order, ["consume"]); // stopped at the gate
    assert.equal(calls.create.length, 0);
    assert.equal(calls.publish.length, 0);
  });

  it("publish failure → REFUND(base action) + session FAILED, code INTERNAL", async () => {
    const { deps, order, calls } = researchDeps({ publishThrows: true });
    const res = await startResearchJob("u1", { query: "x" }, deps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "INTERNAL");
    assert.ok(order.indexOf("create") < order.indexOf("publish"));
    assert.deepEqual(calls.refund[0], ["u1", "l2_research_fast"]);
    assert.equal((calls.update[0]!.data as Rec).status, "FAILED");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ROAST — feature gate → broker → credit → CREATE (checked) → consume → publish
// ══════════════════════════════════════════════════════════════════════════

interface RoastOpts {
  planId?: string;
  connections?: Rec[];
  canUseResult?: unknown;
  createResult?: unknown;
  publishThrows?: boolean;
}
function roastDeps(opts: RoastOpts = {}) {
  const order: string[] = [];
  const calls = {
    canUse: [] as unknown[][],
    createSession: [] as unknown[][],
    consume: [] as unknown[][],
    refund: [] as unknown[][],
    updateStatus: [] as unknown[][],
    publish: [] as Rec[],
  };
  const deps = {
    prisma: {
      brokerConnection: {
        findMany: async () => opts.connections ?? [],
      },
    },
    getSubscriptionAccessForUser: async () =>
      ok({ planId: opts.planId ?? "PRO" }),
    canUseRoast: async (...a: unknown[]) => {
      order.push("canUse");
      calls.canUse.push(a);
      return opts.canUseResult ?? ok({ allowed: true, isFreeRoast: true });
    },
    createRoastSession: async (...a: unknown[]) => {
      order.push("createSession");
      calls.createSession.push(a);
      return opts.createResult ?? ok({ id: "roast_1" });
    },
    updateRoastStatus: async (...a: unknown[]) => {
      order.push("updateStatus");
      calls.updateStatus.push(a);
      return ok(undefined);
    },
    consumeRoastCredit: async (...a: unknown[]) => {
      order.push("consume");
      calls.consume.push(a);
    },
    refundRoastCredit: async (...a: unknown[]) => {
      order.push("refund");
      calls.refund.push(a);
    },
    publishRoastJob: async (m: Rec) => {
      order.push("publish");
      calls.publish.push(m);
      if (opts.publishThrows) throw new Error("pubsub down");
      return "mid";
    },
  } as unknown as StartRoastDeps;
  return { deps, order, calls };
}
const overallInput = { mode: "overall" as const, assetType: "all" as const };

describe("startRoast — credit flow (G3: create BEFORE consume)", () => {
  it("happy path: createSession precedes consume precedes publish", async () => {
    const { deps, order } = roastDeps();
    const res = await startRoast("u1", overallInput, deps);
    assert.equal(res.success, true);
    assert.ok(order.indexOf("createSession") < order.indexOf("consume"));
    assert.ok(order.indexOf("consume") < order.indexOf("publish"));
  });

  it("feature gate (FREE) → UPGRADE_REQUIRED, NO create / consume / publish", async () => {
    const { deps, calls } = roastDeps({ planId: "FREE" });
    const res = await startRoast("u1", overallInput, deps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "UPGRADE_REQUIRED");
    assert.equal(calls.createSession.length, 0);
    assert.equal(calls.consume.length, 0);
    assert.equal(calls.publish.length, 0);
  });

  it("no roast credits → NO_CREDITS, NO create / consume / publish", async () => {
    const { deps, calls } = roastDeps({
      canUseResult: ok({
        allowed: false,
        isFreeRoast: false,
        message: "Free monthly roast used.",
      }),
    });
    const res = await startRoast("u1", overallInput, deps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "NO_CREDITS");
    assert.equal(calls.createSession.length, 0);
    assert.equal(calls.consume.length, 0);
    assert.equal(calls.publish.length, 0);
  });

  it("createRoastSession failure → returns BEFORE consuming (the G3 fix)", async () => {
    const { deps, calls } = roastDeps({
      createResult: { success: false, error: "insert failed" },
    });
    const res = await startRoast("u1", overallInput, deps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "INTERNAL");
    assert.equal(calls.createSession.length, 1);
    assert.equal(calls.consume.length, 0); // never charged
    assert.equal(calls.publish.length, 0);
  });

  it("publish failure → refundRoastCredit + session FAILED", async () => {
    const { deps, calls } = roastDeps({ publishThrows: true });
    const res = await startRoast("u1", overallInput, deps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "INTERNAL");
    assert.deepEqual(calls.refund[0], ["u1", true]); // (userId, isFreeRoast)
    assert.equal((calls.updateStatus[0]![2] as Rec).status, "FAILED");
  });

  it("broker mode NOT_CONNECTED (no connections) short-circuits before create", async () => {
    const { deps, calls } = roastDeps({ connections: [] });
    const res = await startRoast(
      "u1",
      { mode: "broker", broker: "ZERODHA", assetType: "stocks" },
      deps,
    );
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "NOT_CONNECTED");
    assert.equal(calls.createSession.length, 0);
    assert.equal(calls.consume.length, 0);
  });

  it("broker mode NEEDS_REAUTH (expired connection)", async () => {
    const { deps } = roastDeps({
      connections: [
        { status: "EXPIRED", tokenExpiry: null, lastSync: new Date() },
      ],
    });
    const res = await startRoast(
      "u1",
      { mode: "broker", broker: "ZERODHA", assetType: "stocks" },
      deps,
    );
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "NEEDS_REAUTH");
  });

  it("broker mode NEVER_SYNCED (connected but no lastSync)", async () => {
    const { deps } = roastDeps({
      connections: [
        {
          status: "CONNECTED",
          tokenExpiry: new Date(Date.now() + 3.6e6),
          lastSync: null,
        },
      ],
    });
    const res = await startRoast(
      "u1",
      { mode: "broker", broker: "ZERODHA", assetType: "stocks" },
      deps,
    );
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "NEVER_SYNCED");
  });
});

// ── canUseRoast (real fn, injected prisma) ──────────────────────────────────

function subFake(row: Rec | null) {
  const updates: Rec[] = [];
  const prisma = {
    subscription: {
      findUnique: async () => row,
      update: async (a: Rec) => {
        updates.push(a);
        return {};
      },
    },
  } as unknown as { prisma?: unknown };
  return { deps: { prisma } as { prisma?: never }, updates };
}

describe("canUseRoast — eligibility (real fn)", () => {
  it("free monthly roast available for everyone (freeRoastsUsed = 0)", async () => {
    const { deps } = subFake({ planId: "FREE", freeRoastsUsedThisMonth: 0 });
    const res = await canUseRoast("u1", deps as { prisma?: never });
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.allowed, true);
      assert.equal(res.data.isFreeRoast, true);
    }
  });

  it("FREE with the free roast used → not allowed", async () => {
    const { deps } = subFake({
      planId: "FREE",
      freeRoastsUsedThisMonth: 1,
      freeRoastsResetAt: new Date(Date.now() + 8.64e7),
    });
    const res = await canUseRoast("u1", deps as { prisma?: never });
    if (res.success) assert.equal(res.data.allowed, false);
  });

  it("PRO burns advanced credits: remaining reported", async () => {
    const { deps } = subFake({
      planId: "PRO",
      freeRoastsUsedThisMonth: 1,
      advancedQueriesUsed: 2,
      advancedQueriesLimit: 10,
    });
    const res = await canUseRoast("u1", deps as { prisma?: never });
    if (res.success) {
      assert.equal(res.data.allowed, true);
      assert.equal(res.data.remainingCredits, 8);
    }
  });

  it("PRO exhausted → not allowed", async () => {
    const { deps } = subFake({
      planId: "PRO",
      freeRoastsUsedThisMonth: 1,
      advancedQueriesUsed: 10,
      advancedQueriesLimit: 10,
    });
    const res = await canUseRoast("u1", deps as { prisma?: never });
    if (res.success) assert.equal(res.data.allowed, false);
  });

  it("stale monthly counter is reset in place, then the free roast is granted", async () => {
    const { deps, updates } = subFake({
      planId: "FREE",
      freeRoastsUsedThisMonth: 1,
      freeRoastsResetAt: new Date(Date.now() - 8.64e7), // in the past
    });
    const res = await canUseRoast("u1", deps as { prisma?: never });
    assert.equal(updates.length, 1); // counter reset written
    assert.equal((updates[0]!.data as Rec).freeRoastsUsedThisMonth, 0);
    if (res.success) assert.equal(res.data.isFreeRoast, true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// COMPARISON — feature → validate → RESERVE (gate) → create → publish
// ══════════════════════════════════════════════════════════════════════════

interface CompareOpts {
  planId?: string;
  reserveResult?: unknown;
  createResult?: unknown;
  publishThrows?: boolean;
}
function compareDeps(opts: CompareOpts = {}) {
  const order: string[] = [];
  const calls = {
    reserve: [] as unknown[][],
    refundReservation: [] as unknown[][],
    createSession: [] as unknown[][],
    updateStatus: [] as unknown[][],
    publish: [] as Rec[],
  };
  const deps = {
    getSubscriptionAccessForUser: async () =>
      ok({ planId: opts.planId ?? "PRO" }),
    getComposerPreferences: async () => ({}),
    resolveResearchModel: () => "test-model",
    estimateAnalysisCost: () => ({
      credits: 40,
      estimatedMinutes: 25,
      segments: 12,
    }),
    reserveCredits: async (...a: unknown[]) => {
      order.push("reserve");
      calls.reserve.push(a);
      return (
        opts.reserveResult ??
        ok({
          reservationId: "res_1",
          creditsReserved: 40,
          expiresAt: new Date(),
        })
      );
    },
    refundReservationCredits: async (...a: unknown[]) => {
      order.push("refundReservation");
      calls.refundReservation.push(a);
      return ok({ refunded: 40 });
    },
    createComparisonSession: async (...a: unknown[]) => {
      order.push("createSession");
      calls.createSession.push(a);
      return opts.createResult ?? ok({ id: "cmp_1" });
    },
    updateComparisonStatus: async (...a: unknown[]) => {
      order.push("updateStatus");
      calls.updateStatus.push(a);
      return ok(undefined);
    },
    publishComparisonJob: async (m: Rec) => {
      order.push("publish");
      calls.publish.push(m);
      if (opts.publishThrows) throw new Error("pubsub down");
      return "mid";
    },
  } as unknown as StartComparisonDeps;
  return { deps, order, calls };
}
const cmpInput = {
  kind: "mf" as const,
  symbols: ["A", "B"],
  depth: "deep" as const,
};

describe("startComparison — reservation flow (G3)", () => {
  it("happy path: reserve → createSession → publish, in order", async () => {
    const { deps, order } = compareDeps();
    const res = await startComparison("u1", cmpInput, deps);
    assert.equal(res.success, true);
    assert.deepEqual(order, ["reserve", "createSession", "publish"]);
  });

  it("feature gate (FREE) → UPGRADE_REQUIRED, NO reserve", async () => {
    const { deps, calls } = compareDeps({ planId: "FREE" });
    const res = await startComparison("u1", cmpInput, deps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "UPGRADE_REQUIRED");
    assert.equal(calls.reserve.length, 0);
  });

  it("invalid input (dedup below 2) → INVALID_INPUT, NO reserve", async () => {
    const { deps, calls } = compareDeps();
    const res = await startComparison(
      "u1",
      { kind: "mf", symbols: ["AAA", "aaa"], depth: "deep" },
      deps,
    );
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "INVALID_INPUT");
    assert.equal(calls.reserve.length, 0);
  });

  it("GATE: reservation insufficient → NO_CREDITS, NO create, NO publish", async () => {
    const { deps, calls } = compareDeps({
      reserveResult: {
        success: false,
        error: "Insufficient comprehensive credits.",
        code: "INSUFFICIENT_CREDITS",
      },
    });
    const res = await startComparison("u1", cmpInput, deps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "NO_CREDITS");
    assert.equal(calls.createSession.length, 0);
    assert.equal(calls.publish.length, 0);
  });

  it("createSession failure → REFUND reservation (id, 0, segments), NO publish", async () => {
    const { deps, calls } = compareDeps({
      createResult: { success: false, error: "insert failed" },
    });
    const res = await startComparison("u1", cmpInput, deps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "INTERNAL");
    assert.deepEqual(calls.refundReservation[0], ["res_1", 0, 12]);
    assert.equal(calls.publish.length, 0);
  });

  it("publish failure → REFUND reservation + session FAILED", async () => {
    const { deps, calls } = compareDeps({ publishThrows: true });
    const res = await startComparison("u1", cmpInput, deps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "INTERNAL");
    assert.deepEqual(calls.refundReservation[0], ["res_1", 0, 12]);
    assert.equal((calls.updateStatus[0]![2] as Rec).status, "FAILED");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// ANALYSIS — concurrent guard → consume (gate) → create → publish; cancel/reads
// ══════════════════════════════════════════════════════════════════════════

interface AnalysisOpts {
  running?: number;
  planId?: string;
  consumeResult?: unknown;
  publishThrows?: boolean;
}
function analysisDeps(opts: AnalysisOpts = {}) {
  const order: string[] = [];
  const calls = {
    consume: [] as unknown[][],
    refund: [] as unknown[][],
    create: [] as Rec[],
    update: [] as Rec[],
    publish: [] as Rec[],
  };
  const deps = {
    prisma: {
      analysisSession: {
        count: async () => opts.running ?? 0,
        create: async (a: Rec) => {
          order.push("create");
          calls.create.push(a);
          return {};
        },
        update: async (a: Rec) => {
          order.push("update");
          calls.update.push(a);
          return {};
        },
      },
      subscription: {
        findUnique: async () => ({ planId: opts.planId ?? "FREE" }),
      },
    },
    getComposerPreferences: async () => ({}),
    resolveResearchModel: () => "test-model",
    estimateAnalysisCost: () => ({
      credits: 10,
      estimatedMinutes: 15,
      segments: 6,
    }),
    consumeCredits: async (...a: unknown[]) => {
      order.push("consume");
      calls.consume.push(a);
      return (
        opts.consumeResult ??
        ok({ remaining: -1, source: "plan", creditsUsed: 0 })
      );
    },
    refundCredits: async (...a: unknown[]) => {
      order.push("refund");
      calls.refund.push(a);
      return ok({ refunded: 1 });
    },
    publishL3AnalysisJob: async (m: Rec) => {
      order.push("publish");
      calls.publish.push(m);
      if (opts.publishThrows) throw new Error("pubsub down");
      return "mid";
    },
  } as unknown as StartAnalysisDeps;
  return { deps, order, calls };
}
const l3Input = {
  analysisType: "comprehensive_stock",
  query: "Deep dive TCS",
  symbols: ["TCS"],
};

describe("startComprehensiveAnalysis — credit flow (G3)", () => {
  it("happy path: consume → create → publish; l3- sessionId + 6 segments", async () => {
    const { deps, order } = analysisDeps();
    const res = await startComprehensiveAnalysis("u1", l3Input, deps);
    assert.equal(res.success, true);
    assert.deepEqual(order, ["consume", "create", "publish"]);
    if (res.success) {
      assert.ok(res.data.sessionId.startsWith("l3-"));
      assert.equal(res.data.totalSegments, 6);
      assert.equal(res.data.creditsReserved, 10);
    }
  });

  it("l4_comprehensive → l4- sessionId + 12 segments", async () => {
    const { deps } = analysisDeps();
    const res = await startComprehensiveAnalysis(
      "u1",
      { analysisType: "l4_comprehensive", query: "x" },
      deps,
    );
    if (res.success) {
      assert.ok(res.data.sessionId.startsWith("l4-"));
      assert.equal(res.data.totalSegments, 12);
    }
  });

  it("one-concurrent guard: a running analysis → CONFLICT, nothing consumed/created/published", async () => {
    const { deps, calls } = analysisDeps({ running: 1 });
    const res = await startComprehensiveAnalysis("u1", l3Input, deps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "CONFLICT");
    assert.equal(calls.consume.length, 0);
    assert.equal(calls.create.length, 0);
    assert.equal(calls.publish.length, 0);
  });

  it("publish failure → session FAILED + refundCredits(l3_comprehensive)", async () => {
    const { deps, calls } = analysisDeps({ publishThrows: true });
    const res = await startComprehensiveAnalysis("u1", l3Input, deps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "INTERNAL");
    assert.equal((calls.update[0]!.data as Rec).status, "FAILED");
    assert.deepEqual(calls.refund[0], ["u1", "l3_comprehensive"]);
  });
});

// ── Analysis reads + cancel (real fns, injected prisma) ─────────────────────

function analysisRowFake(row: Rec | null) {
  const updates: Rec[] = [];
  const prisma = {
    analysisSession: {
      findFirst: async () => row,
      update: async (a: Rec) => {
        updates.push(a);
        return {};
      },
    },
  };
  return { prisma, updates };
}

describe("getAnalysisStatus / getAnalysisResult (real fns)", () => {
  it("status: missing/foreign session → NOT_FOUND", async () => {
    const { prisma } = analysisRowFake(null);
    const res = await getAnalysisStatus("u1", "ghost", {
      prisma,
    } as unknown as AnalysisReadDeps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "NOT_FOUND");
  });

  it("status: owned session → projected status view", async () => {
    const { prisma } = analysisRowFake({
      status: "SEGMENT_RUNNING",
      progress: 33,
      currentSegment: 2,
      totalSegments: 6,
      segments: [],
      errorMessage: null,
    });
    const res = await getAnalysisStatus("u1", "s1", {
      prisma,
    } as unknown as AnalysisReadDeps);
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.progress, 33);
  });

  it("result: exists but not COMPLETED → CONFLICT (keep polling)", async () => {
    const { prisma } = analysisRowFake({ status: "SEGMENT_RUNNING" });
    const res = await getAnalysisResult("u1", "s1", {
      prisma,
    } as unknown as AnalysisReadDeps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "CONFLICT");
  });

  it("result: COMPLETED → returns report payload", async () => {
    const { prisma } = analysisRowFake({
      sessionId: "s1",
      status: "COMPLETED",
      report: { ok: true },
      contentBlocks: [],
      symbols: ["TCS"],
      creditsUsed: 10,
      completedAt: new Date(),
    });
    const res = await getAnalysisResult("u1", "s1", {
      prisma,
    } as unknown as AnalysisReadDeps);
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.creditsUsed, 10);
  });
});

describe("cancelAnalysis (real fn)", () => {
  it("running session → CANCELLED + refund → { refunded: 1 }", async () => {
    const { prisma, updates } = analysisRowFake({ status: "SEGMENT_RUNNING" });
    let refunded: unknown[] = [];
    const res = await cancelAnalysis("u1", "s1", {
      prisma,
      refundCredits: async (...a: unknown[]) => {
        refunded = a;
        return ok({ refunded: 1 });
      },
    } as unknown as CancelAnalysisDeps);
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.refunded, 1);
    assert.equal((updates[0]!.data as Rec).status, "CANCELLED");
    assert.deepEqual(refunded, ["u1", "l3_comprehensive"]);
  });

  it("already COMPLETED → CONFLICT (no refund)", async () => {
    const { prisma } = analysisRowFake({ status: "COMPLETED" });
    let refundCalled = false;
    const res = await cancelAnalysis("u1", "s1", {
      prisma,
      refundCredits: async () => {
        refundCalled = true;
        return ok({ refunded: 0 });
      },
    } as unknown as CancelAnalysisDeps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "CONFLICT");
    assert.equal(refundCalled, false);
  });

  it("missing/foreign session → NOT_FOUND", async () => {
    const { prisma } = analysisRowFake(null);
    const res = await cancelAnalysis("u1", "ghost", {
      prisma,
    } as unknown as CancelAnalysisDeps);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "NOT_FOUND");
  });
});
