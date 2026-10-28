/**
 * MONEY-620 — Research service pure-logic edge cases (REAL exported logic).
 *
 * DE-SHADOW: the previous version of this file reimplemented every service
 * function (getResearchStatus/Result/History, cancel/delete) against a
 * `MockDB` and asserted the COPY — its own header said "All external
 * dependencies are reimplemented inline." A shadow like that is green even
 * when the real service is wrong (it cannot see a producer-side bug), and it
 * actively asserted the `qualityScore: 0 → undefined` defect as "expected".
 *
 * This file now imports and asserts the ACTUAL exported helpers that
 * `packages/services/src/research.service.ts` CALLS, straight from their pure
 * source (`research-logic.ts`) — no inline copy, no Prisma at import time, so
 * the suite stays pure and exits clean. These helpers ARE the live derivation
 * the service runs between its DB read and its `ServiceResult` return:
 *   - getResearchStatus      → buildTaskProgress + clampProgress + displayScore
 *   - getResearchResult      → displayScore
 *   - getRecentResearch/...  → clampProgress
 *   - getRunningResearch     → deriveStuckSessions + clampProgress + safeCreatedAt
 *   - getResearchHistory     → clampResearchPagination + extractReportInsights
 *                              + displayScore + safeCreatedAt/toSafeOptionalDate
 *
 * Bugs fixed + regression-guarded here (failing input in each `it`):
 *   1. qualityScore/reportScore of 0 was dropped to `undefined` by `0 ||
 *      undefined` → now preserved (displayScore / extractReportInsights).
 *   2. progress NaN / negative / >100 reached the consumer's `width:
 *      ${progress}%` bar → now clamped to [0,100] (clampProgress).
 *   3. history (page,pageSize) NaN/neg/huge reached prisma.findMany skip/take
 *      → Prisma THROWS (500) / OOM → now clamped (clampResearchPagination).
 *   4. an Invalid-Date createdAt let a genuinely-stuck session DODGE the
 *      15-min auto-expire (`NaN > MAX` is false) and reach the consumer as an
 *      un-renderable Date → deriveStuckSessions treats it as stuck;
 *      safeCreatedAt/toSafeOptionalDate never emit an Invalid Date.
 *
 * Source: packages/services/src/research-logic.ts
 *         (called by packages/services/src/research.service.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  clampProgress,
  displayScore,
  clampResearchPagination,
  DEFAULT_RESEARCH_PAGE_SIZE,
  MAX_RESEARCH_PAGE_SIZE,
  isOwnerScoped,
  isValidDate,
  toSafeOptionalDate,
  safeCreatedAt,
  deriveStuckSessions,
  STUCK_SESSION_MAX_AGE_MS,
  extractReportInsights,
  MAX_RESULT_JSON_SIZE,
  SKIP_SUMMARY_TOOLS,
  truncateToSize,
  compactSummarize,
  summarizeTaskResult,
  buildTaskProgress,
} from "../../../../packages/services/src/research-logic";

// ─────────────────────────────────────────────────────────────────────
// displayScore — qualityScore / reportScore display (0-preserving)
// ─────────────────────────────────────────────────────────────────────

describe("MONEY-620 displayScore (qualityScore/reportScore)", () => {
  it("preserves a legitimate 0 (THE bug: `0 || undefined` dropped it)", () => {
    // Pre-fix the service did `session.qualityScore || undefined`, so a real
    // worst-case score of 0 vanished. 0 is a meaningful score → must survive.
    assert.equal(displayScore(0), 0);
  });

  it("preserves a normal mid-range score", () => {
    assert.equal(displayScore(85), 85);
  });

  it("preserves 1 and 100 (boundaries)", () => {
    assert.equal(displayScore(1), 1);
    assert.equal(displayScore(100), 100);
  });

  it("preserves a fractional score (Float column)", () => {
    assert.equal(displayScore(72.5), 72.5);
  });

  it("preserves a negative score verbatim (finite is honoured, not clamped)", () => {
    // displayScore only drops non-finite; clamping is clampProgress's job.
    assert.equal(displayScore(-3), -3);
  });

  it("null → undefined", () => {
    assert.equal(displayScore(null), undefined);
  });

  it("undefined → undefined", () => {
    assert.equal(displayScore(undefined), undefined);
  });

  it("NaN → undefined (would poison a downstream .toFixed/axis)", () => {
    assert.equal(displayScore(NaN), undefined);
  });

  it("+Infinity / -Infinity → undefined", () => {
    assert.equal(displayScore(Infinity), undefined);
    assert.equal(displayScore(-Infinity), undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────
// clampProgress — [0,100] render-safe percentage
// ─────────────────────────────────────────────────────────────────────

describe("MONEY-620 clampProgress", () => {
  it("passes a normal in-range progress through", () => {
    assert.equal(clampProgress(42), 42);
  });

  it("keeps the 0 and 100 boundaries", () => {
    assert.equal(clampProgress(0), 0);
    assert.equal(clampProgress(100), 100);
  });

  it("NaN → 0 (THE bug: `Math.min(100, NaN)` is NaN → `width: NaN%`)", () => {
    assert.equal(clampProgress(NaN), 0);
  });

  it("negative → 0 (never a negative bar width)", () => {
    assert.equal(clampProgress(-5), 0);
    assert.equal(clampProgress(-99999), 0);
  });

  it(">100 → 100 (corrupt over-progress write)", () => {
    assert.equal(clampProgress(101), 100);
    assert.equal(clampProgress(100000), 100);
  });

  it("+Infinity → 100, -Infinity → 0", () => {
    assert.equal(clampProgress(Infinity), 100);
    assert.equal(clampProgress(-Infinity), 0);
  });

  it("truncates a fractional progress toward zero", () => {
    assert.equal(clampProgress(33.9), 33);
    assert.equal(clampProgress(0.9), 0);
  });

  it("non-number (string/null/undefined/object) → 0", () => {
    assert.equal(clampProgress("50" as unknown), 0);
    assert.equal(clampProgress(null), 0);
    assert.equal(clampProgress(undefined), 0);
    assert.equal(clampProgress({} as unknown), 0);
  });

  it("totality: every adversarial input yields an integer in [0,100]", () => {
    const inputs: unknown[] = [
      NaN,
      Infinity,
      -Infinity,
      -1,
      101,
      "x",
      null,
      undefined,
      {},
      [],
      1.5,
      Number.MAX_SAFE_INTEGER,
    ];
    for (const v of inputs) {
      const p = clampProgress(v);
      assert.ok(
        Number.isInteger(p) && p >= 0 && p <= 100,
        `progress in [0,100] for ${String(v)}`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// clampResearchPagination — the history 500-guard
// ─────────────────────────────────────────────────────────────────────

describe("MONEY-620 clampResearchPagination (history skip/take)", () => {
  it("constants: DEFAULT 20, MAX 100", () => {
    assert.equal(DEFAULT_RESEARCH_PAGE_SIZE, 20);
    assert.equal(MAX_RESEARCH_PAGE_SIZE, 100);
  });

  it("page 1 / default size → skip 0, take 20", () => {
    assert.deepEqual(clampResearchPagination(1, 20), { skip: 0, take: 20 });
  });

  it("computes skip = (page-1)*pageSize for a normal request", () => {
    assert.deepEqual(clampResearchPagination(3, 20), { skip: 40, take: 20 });
  });

  it("defaults to page 1 / DEFAULT size with no args", () => {
    assert.deepEqual(clampResearchPagination(), {
      skip: 0,
      take: DEFAULT_RESEARCH_PAGE_SIZE,
    });
  });

  it("caps an over-MAX pageSize to MAX (OOM/payload guard)", () => {
    assert.equal(
      clampResearchPagination(1, 1_000_000_000).take,
      MAX_RESEARCH_PAGE_SIZE
    );
  });

  it("NaN pageSize (parseInt('abc')) → DEFAULT take, never a NaN take to Prisma", () => {
    const { take, skip } = clampResearchPagination(2, NaN);
    assert.equal(take, DEFAULT_RESEARCH_PAGE_SIZE);
    assert.equal(skip, DEFAULT_RESEARCH_PAGE_SIZE); // (2-1)*20
  });

  it("zero / negative pageSize → DEFAULT (never a take of 0)", () => {
    assert.equal(
      clampResearchPagination(1, 0).take,
      DEFAULT_RESEARCH_PAGE_SIZE
    );
    assert.equal(
      clampResearchPagination(1, -10).take,
      DEFAULT_RESEARCH_PAGE_SIZE
    );
  });

  it("negative page → page 1 (skip 0), never a NEGATIVE skip to Prisma", () => {
    // THE bug class: skip=(page-1)*size with page=-5,size=20 → skip=-120 →
    // prisma THROWS `Invalid value … Expected Int`.
    assert.equal(clampResearchPagination(-5, 20).skip, 0);
  });

  it("page 0 → page 1 (skip 0)", () => {
    assert.equal(clampResearchPagination(0, 20).skip, 0);
  });

  it("NaN / Infinity page → page 1 (skip 0)", () => {
    assert.equal(clampResearchPagination(NaN, 20).skip, 0);
    assert.equal(clampResearchPagination(Infinity, 20).skip, 0);
    assert.equal(clampResearchPagination(-Infinity, 20).skip, 0);
  });

  it("non-number page/pageSize → page 1 / DEFAULT size", () => {
    assert.deepEqual(clampResearchPagination("2" as unknown, "30" as unknown), {
      skip: 0,
      take: DEFAULT_RESEARCH_PAGE_SIZE,
    });
    assert.deepEqual(clampResearchPagination(null, undefined), {
      skip: 0,
      take: DEFAULT_RESEARCH_PAGE_SIZE,
    });
  });

  it("truncates fractional page/pageSize toward zero", () => {
    // page 2.9 → 2, size 25.9 → 25 → skip = (2-1)*25 = 25
    assert.deepEqual(clampResearchPagination(2.9, 25.9), {
      skip: 25,
      take: 25,
    });
  });

  it("totality: skip ≥ 0 integer and take in [1,MAX] for every adversarial pair", () => {
    const pairs: Array<[unknown, unknown]> = [
      [NaN, NaN],
      [-Infinity, -Infinity],
      [Infinity, Infinity],
      [-1, -1],
      [0, 0],
      ["x", "y"],
      [null, undefined],
      [{}, []],
      [1.5, 2.5],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ];
    for (const [p, sz] of pairs) {
      const { skip, take } = clampResearchPagination(p, sz);
      assert.ok(
        Number.isInteger(skip) && skip >= 0,
        `skip ≥ 0 int for (${String(p)},${String(sz)})`
      );
      assert.ok(
        Number.isInteger(take) && take >= 1 && take <= MAX_RESEARCH_PAGE_SIZE,
        `take in [1,MAX] for (${String(p)},${String(sz)})`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// isOwnerScoped — IDOR fail-closed gate
// ─────────────────────────────────────────────────────────────────────

describe("MONEY-620 isOwnerScoped (IDOR gate)", () => {
  it("a real non-empty Clerk/Mongo userId scopes the lookup", () => {
    assert.equal(isOwnerScoped("user_2abc"), true);
    assert.equal(isOwnerScoped("65f0c0ffee0000000000abcd"), true);
  });

  it("empty string → false (no bare cross-user findUnique fallback)", () => {
    // THE IDOR hardening: pre-fix an empty/absent userId fell through to
    // `findUnique({sessionId})` — readable across users. Now it fails closed.
    assert.equal(isOwnerScoped(""), false);
  });

  it("null / undefined → false (fail closed)", () => {
    assert.equal(isOwnerScoped(null), false);
    assert.equal(isOwnerScoped(undefined), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Invalid-Date guards — never emit an un-renderable Date to consumers
// ─────────────────────────────────────────────────────────────────────

describe("MONEY-620 date guards (createdAt/completedAt)", () => {
  const valid = new Date("2026-03-14T10:00:00Z");
  const invalid = new Date("not-a-date");

  it("isValidDate: true only for a finite Date", () => {
    assert.equal(isValidDate(valid), true);
    assert.equal(isValidDate(invalid), false);
    assert.equal(isValidDate(null), false);
    assert.equal(isValidDate(undefined), false);
  });

  it("toSafeOptionalDate: valid passes through; invalid/null → undefined", () => {
    assert.equal(toSafeOptionalDate(valid), valid);
    assert.equal(toSafeOptionalDate(invalid), undefined);
    assert.equal(toSafeOptionalDate(null), undefined);
    assert.equal(toSafeOptionalDate(undefined), undefined);
  });

  it("safeCreatedAt: valid passes through", () => {
    assert.equal(safeCreatedAt(valid), valid);
  });

  it("safeCreatedAt: invalid/null → the injected fallback (never an Invalid Date)", () => {
    const fb = new Date("2026-01-01T00:00:00Z");
    assert.equal(safeCreatedAt(invalid, fb), fb);
    assert.equal(safeCreatedAt(null, fb), fb);
    // the returned value is always renderable
    assert.ok(isValidDate(safeCreatedAt(invalid, fb)));
  });

  it("safeCreatedAt: default fallback is a valid current Date", () => {
    assert.ok(isValidDate(safeCreatedAt(invalid)));
  });
});

// ─────────────────────────────────────────────────────────────────────
// deriveStuckSessions — auto-expire >15min (Invalid-Date safe)
// ─────────────────────────────────────────────────────────────────────

describe("MONEY-620 deriveStuckSessions (auto-expire)", () => {
  const now = new Date("2026-03-14T12:00:00Z");
  const nowMs = now.getTime();
  const fresh = new Date(nowMs - 60_000); // 1 min ago
  const old = new Date(nowMs - STUCK_SESSION_MAX_AGE_MS - 1); // > 15 min ago
  const exactly = new Date(nowMs - STUCK_SESSION_MAX_AGE_MS); // exactly 15 min

  it("constant: 15 minutes", () => {
    assert.equal(STUCK_SESSION_MAX_AGE_MS, 15 * 60 * 1000);
  });

  it("a fresh session stays active", () => {
    const { stuck, active } = deriveStuckSessions(
      [{ sessionId: "a", createdAt: fresh }],
      now
    );
    assert.deepEqual(
      stuck.map((s) => s.sessionId),
      []
    );
    assert.deepEqual(
      active.map((s) => s.sessionId),
      ["a"]
    );
  });

  it("a >15min session is stuck", () => {
    const { stuck, active } = deriveStuckSessions(
      [{ sessionId: "b", createdAt: old }],
      now
    );
    assert.deepEqual(
      stuck.map((s) => s.sessionId),
      ["b"]
    );
    assert.deepEqual(active, []);
  });

  it("exactly 15min is NOT stuck (strictly greater-than boundary preserved)", () => {
    const { stuck } = deriveStuckSessions(
      [{ sessionId: "c", createdAt: exactly }],
      now
    );
    assert.deepEqual(stuck, []);
  });

  it("an Invalid-Date createdAt is treated as STUCK (THE bug: `NaN > MAX` was false → never expired)", () => {
    const { stuck, active } = deriveStuckSessions(
      [{ sessionId: "corrupt", createdAt: new Date("garbage") }],
      now
    );
    assert.deepEqual(
      stuck.map((s) => s.sessionId),
      ["corrupt"]
    );
    assert.deepEqual(active, []);
  });

  it("null/undefined createdAt is treated as stuck (fail safe)", () => {
    const { stuck } = deriveStuckSessions(
      [
        { sessionId: "n", createdAt: null },
        { sessionId: "u", createdAt: undefined },
      ],
      now
    );
    assert.deepEqual(stuck.map((s) => s.sessionId).sort(), ["n", "u"]);
  });

  it("partitions a mixed batch correctly", () => {
    const { stuck, active } = deriveStuckSessions(
      [
        { sessionId: "fresh", createdAt: fresh },
        { sessionId: "old", createdAt: old },
        { sessionId: "bad", createdAt: new Date("x") },
      ],
      now
    );
    assert.deepEqual(
      active.map((s) => s.sessionId),
      ["fresh"]
    );
    assert.deepEqual(stuck.map((s) => s.sessionId).sort(), ["bad", "old"]);
  });

  it("empty list → empty partitions", () => {
    const { stuck, active } = deriveStuckSessions([], now);
    assert.deepEqual(stuck, []);
    assert.deepEqual(active, []);
  });
});

// ─────────────────────────────────────────────────────────────────────
// extractReportInsights — recommendation + score from report JSON
// ─────────────────────────────────────────────────────────────────────

describe("MONEY-620 extractReportInsights", () => {
  it("extracts top-level recommendation + score", () => {
    assert.deepEqual(
      extractReportInsights({ recommendation: "BUY", score: 80 }),
      {
        recommendation: "BUY",
        reportScore: 80,
      }
    );
  });

  it("extracts from nested content.{recommendation,score}", () => {
    assert.deepEqual(
      extractReportInsights({
        content: { recommendation: "STRONG BUY", score: 90 },
      }),
      { recommendation: "STRONG BUY", reportScore: 90 }
    );
  });

  it("top-level wins over nested", () => {
    const out = extractReportInsights({
      recommendation: "SELL",
      score: 30,
      content: { recommendation: "BUY", score: 95 },
    });
    assert.equal(out.recommendation, "SELL");
    assert.equal(out.reportScore, 30);
  });

  it("preserves a reportScore of 0 (THE bug: `0` was kept here but dropped by `qualityScore || undefined` — confirm extract keeps it)", () => {
    assert.equal(extractReportInsights({ score: 0 }).reportScore, 0);
    assert.equal(
      extractReportInsights({ content: { score: 0 } }).reportScore,
      0
    );
  });

  it("drops a NaN/Infinity score (corrupt report → no poison to UI .toFixed)", () => {
    assert.equal(extractReportInsights({ score: NaN }).reportScore, undefined);
    assert.equal(
      extractReportInsights({ score: Infinity }).reportScore,
      undefined
    );
    assert.equal(
      extractReportInsights({ content: { score: NaN } }).reportScore,
      undefined
    );
  });

  it("content that is not an object → no nested extraction", () => {
    assert.deepEqual(extractReportInsights({ content: "just a string" }), {});
  });

  it("content.recommendation that is not a string → undefined", () => {
    assert.equal(
      extractReportInsights({ content: { recommendation: 42 } }).recommendation,
      undefined
    );
  });

  it("non-object reports (null/undefined/string/number/array) → empty insights", () => {
    assert.deepEqual(extractReportInsights(null), {});
    assert.deepEqual(extractReportInsights(undefined), {});
    assert.deepEqual(extractReportInsights("report"), {});
    assert.deepEqual(extractReportInsights(123), {});
    assert.deepEqual(extractReportInsights([1, 2, 3]), {});
  });

  it("a report with only a score (L3/L4 segments shape) yields score, no rec", () => {
    const out = extractReportInsights({ segments: [{ a: 1 }], score: 77 });
    assert.equal(out.reportScore, 77);
    assert.equal(out.recommendation, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────
// summarizeTaskResult / truncateToSize / compactSummarize
// ─────────────────────────────────────────────────────────────────────

describe("MONEY-620 task-result summarizers", () => {
  it("SKIP_SUMMARY_TOOLS holds the 3 report-delivered tools", () => {
    assert.ok(SKIP_SUMMARY_TOOLS.has("synthesize_report"));
    assert.ok(SKIP_SUMMARY_TOOLS.has("compare_stocks"));
    assert.ok(SKIP_SUMMARY_TOOLS.has("generate_summary"));
  });

  it("summarizeTaskResult: null/empty result → null", () => {
    assert.equal(summarizeTaskResult("get_quote", null), null);
    assert.equal(summarizeTaskResult("get_quote", undefined), null);
    assert.equal(summarizeTaskResult("get_quote", ""), null);
    assert.equal(summarizeTaskResult("get_quote", 0), null);
  });

  it("summarizeTaskResult: a skip-tool result → null (delivered as full report)", () => {
    assert.equal(
      summarizeTaskResult("synthesize_report", { big: "report" }),
      null
    );
  });

  it("summarizeTaskResult: a small normal result passes through unchanged", () => {
    const r = { rsi: 55, trend: "up", ratios: { pe: 22 } };
    assert.deepEqual(summarizeTaskResult("get_technicals", r), r);
  });

  it("truncateToSize: small payload is returned as-is", () => {
    const r = { a: 1, b: [1, 2, 3] };
    assert.equal(truncateToSize(r), r);
  });

  it("truncateToSize: undefined input → null (JSON.stringify(undefined) guard)", () => {
    assert.equal(truncateToSize(undefined), null);
  });

  it("truncateToSize: an oversized array is sliced to fit the cap", () => {
    // Each row ~ tens of bytes; 5000 rows blows the 50KB cap. Result must be a
    // shorter array whose JSON ≤ cap, preserving order.
    const big = Array.from({ length: 5000 }, (_, i) => ({ i, v: i * 2 }));
    const out = truncateToSize(big);
    assert.ok(Array.isArray(out), "still an array");
    assert.ok((out as unknown[]).length < big.length, "was sliced");
    assert.ok(
      JSON.stringify(out).length <= MAX_RESULT_JSON_SIZE,
      "fits the cap"
    );
    assert.deepEqual(
      (out as Array<{ i: number }>)[0],
      { i: 0, v: 0 },
      "order preserved"
    );
  });

  it("truncateToSize: an oversized object salvages a compact subset (not null)", () => {
    // A wide object: small high-signal primitives + one giant array branch.
    const obj: Record<string, unknown> = {
      rsi: 55,
      trend: "up",
      huge: Array.from({ length: 5000 }, (_, i) => ({
        i,
        blob: "x".repeat(20),
      })),
    };
    const out = truncateToSize(obj);
    assert.ok(out && typeof out === "object", "salvaged an object, not null");
    const o = out as Record<string, unknown>;
    assert.equal(o.rsi, 55, "kept the cheap primitive");
    assert.equal(o.trend, "up");
    assert.ok(JSON.stringify(out).length <= MAX_RESULT_JSON_SIZE, "within cap");
  });

  it("compactSummarize: drops an oversized prose string but keeps primitives", () => {
    const out = compactSummarize({
      score: 7,
      label: "ok",
      prose: "y".repeat(5000), // > MAX_PRIMITIVE_LEN 2000 → dropped
    });
    const o = out as Record<string, unknown>;
    assert.equal(o.score, 7);
    assert.equal(o.label, "ok");
    assert.equal(o.prose, undefined, "oversized string dropped");
  });

  it("compactSummarize: an object of only oversized strings → null", () => {
    assert.equal(
      compactSummarize({ a: "z".repeat(5000), b: "w".repeat(5000) }),
      null
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildTaskProgress — plan.tasks[] → wire items (delta-aware)
// ─────────────────────────────────────────────────────────────────────

describe("MONEY-620 buildTaskProgress", () => {
  const plan = {
    tasks: [
      {
        id: "t1",
        tool: "get_quote",
        type: "fetch",
        status: "completed",
        durationMs: 1200,
        result: { price: 100 },
      },
      { id: "t2", tool: "get_news", type: "fetch", status: "running" },
    ],
  };

  it("projects each task to the wire shape", () => {
    const out = buildTaskProgress(plan, []);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.id, "t1");
    assert.equal(out[0]!.tool, "get_quote");
    assert.equal(out[0]!.type, "fetch");
    assert.equal(out[0]!.status, "completed");
    assert.equal(out[0]!.durationMs, 1200);
  });

  it("attaches resultSummary for a completed task NOT already received", () => {
    const out = buildTaskProgress(plan, []);
    assert.deepEqual(out[0]!.resultSummary, { price: 100 });
  });

  it("omits resultSummary for a completed task the client already has (delta delivery)", () => {
    const out = buildTaskProgress(plan, ["t1"]);
    assert.equal(out[0]!.resultSummary, undefined);
  });

  it("omits resultSummary for a non-completed task", () => {
    const out = buildTaskProgress(plan, []);
    assert.equal(out[1]!.resultSummary, undefined);
  });

  it("a missing / malformed plan → [] (no throw)", () => {
    assert.deepEqual(buildTaskProgress(null, []), []);
    assert.deepEqual(buildTaskProgress(undefined, []), []);
    assert.deepEqual(buildTaskProgress({}, []), []);
    assert.deepEqual(buildTaskProgress({ tasks: "nope" }, []), []);
    assert.deepEqual(buildTaskProgress("string-plan", []), []);
  });

  it("zero/invalid durationMs → undefined (not 0)", () => {
    const out = buildTaskProgress(
      {
        tasks: [
          { id: "x", tool: "t", type: "f", status: "running", durationMs: 0 },
        ],
      },
      []
    );
    assert.equal(out[0]!.durationMs, undefined);
    const out2 = buildTaskProgress(
      {
        tasks: [
          { id: "y", tool: "t", type: "f", status: "running", durationMs: NaN },
        ],
      },
      []
    );
    assert.equal(out2[0]!.durationMs, undefined);
  });

  it("a completed task whose tool is a SKIP tool → resultSummary null", () => {
    const out = buildTaskProgress(
      {
        tasks: [
          {
            id: "s",
            tool: "synthesize_report",
            type: "synth",
            status: "completed",
            result: { r: 1 },
          },
        ],
      },
      []
    );
    assert.equal(out[0]!.resultSummary, null);
  });

  it("undefined completedTaskIds is treated as 'none received'", () => {
    const out = buildTaskProgress(plan);
    assert.deepEqual(out[0]!.resultSummary, { price: 100 });
  });
});
