/**
 * Portfolio Roast Action — real-source tests.
 *
 * NOTE: the previous version of this file asserted two FICTIONAL functions —
 * `parseRoastResponse(...)` and a `buildRoastPrompt(params, holdings, mfs)`
 * signature — that exist NOWHERE in production. The roast action
 * (apps/web/lib/actions/roast.ts) is a Pub/Sub delegator; the real roast
 * pipeline lives in `packages/roast`:
 *   - JSON parsing of LLM output → `parseLLMJson<T>` (parse-llm-json.ts)
 *   - prompt construction        → `buildRoastPrompt(stockAnalysis, mfAnalysis,
 *                                   scores, portfolio, scope)` (prompts.ts)
 * both already covered by __tests__/roast/parse-llm-json.test.ts and
 * __tests__/roast/prompts.test.ts.
 *
 * This file now (a) exercises the REAL `parseLLMJson` resilience contract the
 * roast worker relies on, and (b) pins the REAL demo fixtures that the action's
 * demo branch (`getRoastResultAction` / `getRoastHistoryAction`) actually
 * serves — `demoRoastDetail` / `demoRoastHistory` from lib/demo/data.ts.
 * No inline re-implementation of any production unit.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { parseLLMJson } from "../../../../packages/roast/src/lib/parse-llm-json";
import { demoRoastDetail, demoRoastHistory } from "@/lib/demo/data";
import type { StructuredRoastResult } from "@usemoney/types";

// The demo branch of getRoastResultAction returns demoRoastDetail.result,
// which must conform to StructuredRoastResult (the shape the roast UI renders).
const demoRoastResult = demoRoastDetail.result as StructuredRoastResult;

describe("Portfolio Roast (real source)", () => {
  // ── parseLLMJson: the genuine LLM-output parser the worker uses ──────

  describe("parseLLMJson (real roast JSON parser)", () => {
    const fallback: StructuredRoastResult = demoRoastResult;

    it("parses a valid JSON object directly", () => {
      const payload = { overallScore: 72, foo: "bar" };
      const parsed = parseLLMJson<{ overallScore: number; foo: string }>(
        JSON.stringify(payload),
        { overallScore: 0, foo: "" },
        "test"
      );
      assert.strictEqual(parsed.overallScore, 72);
      assert.strictEqual(parsed.foo, "bar");
    });

    it("parses JSON wrapped in a ```json code fence", () => {
      const payload = { overallScore: 85 };
      const parsed = parseLLMJson<{ overallScore: number }>(
        "```json\n" + JSON.stringify(payload) + "\n```",
        { overallScore: 0 },
        "test"
      );
      assert.strictEqual(parsed.overallScore, 85);
    });

    it("parses JSON wrapped in a bare ``` code fence", () => {
      const payload = { overallScore: 60 };
      const parsed = parseLLMJson<{ overallScore: number }>(
        "```\n" + JSON.stringify(payload) + "\n```",
        { overallScore: 0 },
        "test"
      );
      assert.strictEqual(parsed.overallScore, 60);
    });

    it("extracts JSON embedded in surrounding prose (greedy match)", () => {
      const payload = { overallScore: 88 };
      const parsed = parseLLMJson<{ overallScore: number }>(
        "Here is the roast: " + JSON.stringify(payload) + " hope you enjoyed",
        { overallScore: 0 },
        "test"
      );
      assert.strictEqual(parsed.overallScore, 88);
    });

    it("returns the fallback for completely non-JSON input", () => {
      const parsed = parseLLMJson<StructuredRoastResult>(
        "This is not JSON at all",
        fallback,
        "test"
      );
      assert.strictEqual(parsed, fallback);
    });

    it("returns the fallback for empty / null / undefined input", () => {
      assert.strictEqual(parseLLMJson("", fallback, "t"), fallback);
      assert.strictEqual(parseLLMJson(null, fallback, "t"), fallback);
      assert.strictEqual(parseLLMJson(undefined, fallback, "t"), fallback);
    });

    it("never throws on malformed JSON (returns fallback)", () => {
      const parsed = parseLLMJson<StructuredRoastResult>(
        "{overallScore: not_a_number}",
        fallback,
        "test"
      );
      assert.strictEqual(parsed, fallback);
    });

    it("recovers a truncated (unterminated) JSON object via bracket-balance", () => {
      // Token-budget cutoff: the closing brace + string are missing.
      const truncated = '{"overallScore": 50, "roastNarrative": "It cuts off';
      const parsed = parseLLMJson<{ overallScore: number }>(
        truncated,
        { overallScore: -1 },
        "test"
      );
      // Bracket-balance recovery should salvage the parseable prefix.
      assert.strictEqual(parsed.overallScore, 50);
    });
  });

  // ── Demo fixture contract (what getRoastResultAction serves in demo) ──

  describe("demoRoastDetail.result (StructuredRoastResult shape)", () => {
    it("has overallScore within 0-100", () => {
      assert.ok(demoRoastResult.overallScore >= 0);
      assert.ok(demoRoastResult.overallScore <= 100);
      assert.strictEqual(demoRoastResult.overallScore, 72);
    });

    it("has all 4 score breakdown categories with valid scores + comments", () => {
      const { scoreBreakdown } = demoRoastResult;
      const categories = [
        "diversification",
        "riskManagement",
        "stockPicking",
        "timing",
      ] as const;
      for (const cat of categories) {
        assert.ok(scoreBreakdown[cat], `Missing category: ${cat}`);
        assert.ok(
          scoreBreakdown[cat].score >= 0 && scoreBreakdown[cat].score <= 100
        );
        assert.ok(scoreBreakdown[cat].comment.length > 0);
      }
    });

    it("has roast highlights with valid types and both burns + praises", () => {
      assert.ok(demoRoastResult.roastHighlights.length > 0);
      for (const h of demoRoastResult.roastHighlights) {
        assert.ok(
          h.type === "burn" || h.type === "praise",
          `Invalid highlight type: ${h.type}`
        );
        assert.ok(h.title.length > 0);
        assert.ok(h.description.length > 0);
        assert.ok(h.emoji.length > 0);
      }
      const burns = demoRoastResult.roastHighlights.filter(
        (h) => h.type === "burn"
      );
      const praises = demoRoastResult.roastHighlights.filter(
        (h) => h.type === "praise"
      );
      assert.ok(burns.length > 0, "Should have at least one burn");
      assert.ok(praises.length > 0, "Should have at least one praise");
    });

    it("has sector analysis with valid verdicts summing to 100%", () => {
      assert.ok(demoRoastResult.sectorAnalysis.length > 0);
      const validVerdicts = ["overweight", "underweight", "fair"];
      for (const s of demoRoastResult.sectorAnalysis) {
        assert.ok(
          validVerdicts.includes(s.verdict),
          `Invalid verdict: ${s.verdict}`
        );
        assert.ok(
          s.percentage > 0,
          `Percentage must be positive for ${s.sector}`
        );
        assert.ok(s.sector.length > 0);
      }
      const totalPct = demoRoastResult.sectorAnalysis.reduce(
        (sum, s) => sum + s.percentage,
        0
      );
      assert.strictEqual(totalPct, 100);
    });

    it("has consistent performer P&L signs + non-empty advice/narrative", () => {
      for (const p of demoRoastResult.topPerformers) {
        assert.ok(
          p.pnlPercent > 0,
          `Top performer ${p.symbol} should have positive P&L`
        );
        assert.ok(p.symbol.length > 0);
      }
      for (const p of demoRoastResult.worstPerformers) {
        assert.ok(
          p.pnlPercent < 0,
          `Worst performer ${p.symbol} should have negative P&L`
        );
      }
      assert.ok(demoRoastResult.constructiveAdvice.length > 0);
      for (const a of demoRoastResult.constructiveAdvice) {
        assert.ok(a.title.length > 0);
        assert.ok(a.description.length > 0);
      }
      assert.ok(demoRoastResult.roastNarrative.length > 0);
      assert.ok(demoRoastResult.disclaimer.length > 0);
    });
  });

  describe("demoRoastHistory (what getRoastHistoryAction serves in demo)", () => {
    it("is a non-empty list of COMPLETED roasts with bounded scores", () => {
      assert.ok(demoRoastHistory.length > 0);
      for (const r of demoRoastHistory) {
        assert.strictEqual(r.status, "COMPLETED");
        assert.ok(r.score >= 0 && r.score <= 100);
        assert.ok(r.sessionId.length > 0);
      }
    });

    it("detail sessionId corresponds to a history entry", () => {
      const ids = demoRoastHistory.map((r) => r.sessionId);
      assert.ok(ids.includes(demoRoastDetail.sessionId));
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// startRoastAction — failed session INSERT must not charge or publish
// (MONEY-1062 Fix 4) via the require.cache seam
// ════════════════════════════════════════════════════════════════════
//
// The bug: startRoastAction DISCARDED the createRoastSession ServiceResult. On a
// failed session INSERT it still consumed a roast credit and published the job →
// the user was charged for a roast whose session row never existed, so status
// polling returns "Roast not found" forever. The fix checks the result and
// returns the action's normal error shape BEFORE consumeRoastCredit / publish.
//
// Drives the REAL action (apps/web/lib/actions/roast.ts) with stubbed boundaries:
// @/lib/auth (React cache() at load), @/lib/demo/session, @/lib/subscription/access
// (PREMIUM → portfolioRoast entitled — hasFeatureAccess stays REAL),
// @usemoney/database (recording prisma), @usemoney/pubsub/publish (records jobs)
// and @usemoney/services (configurable createRoastSession + recorders).

type RoastActionModule = typeof import("../../lib/actions/roast");

interface RoastHarness {
  createSessionSuccess: boolean;
  createSessionCalls: unknown[];
  /** subscription.update calls = the ONLY signal consumeRoastCredit ran. */
  subUpdateArgs: unknown[];
  publishedJobs: unknown[];
  updateRoastStatusCalls: unknown[];
}

const ROAST_ACTION_REL = "../../lib/actions/roast";

function roastCacheMap(): Record<string, unknown> {
  return (require as unknown as { cache: Record<string, unknown> }).cache;
}

function newRoastHarness(over: Partial<RoastHarness> = {}): RoastHarness {
  return {
    createSessionSuccess: true,
    createSessionCalls: [],
    subUpdateArgs: [],
    publishedJobs: [],
    updateRoastStatusCalls: [],
    ...over,
  };
}

function loadRoastAction(h: RoastHarness): RoastActionModule {
  const cache = roastCacheMap();
  const resolve = (p: string) => require.resolve(p);

  cache[resolve("@/lib/auth")] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: async () => ({ userId: "u1" }),
    },
  };
  cache[resolve("@/lib/demo/session")] = {
    exports: { __esModule: true, isDemoSession: async () => false },
  };
  // PREMIUM plan → hasFeatureAccess(PREMIUM, "portfolioRoast") is REAL → allowed.
  cache[resolve("@/lib/subscription/access")] = {
    exports: {
      __esModule: true,
      getSubscriptionAccess: async () => ({ planId: "PREMIUM" }),
    },
  };
  cache[resolve("@usemoney/database")] = {
    exports: {
      __esModule: true,
      prisma: {
        subscription: {
          // canUseRoastAction reads the sub; freeRoastsUsed=0 → free roast
          // allowed and NO reset update (resetAt null → reset branch skipped),
          // so the ONLY possible subscription.update is consumeRoastCredit.
          findUnique: async () => ({
            planId: "PREMIUM",
            freeRoastsUsedThisMonth: 0,
            freeRoastsResetAt: null,
            advancedQueriesUsed: 0,
            advancedQueriesLimit: 0,
          }),
          update: async (args: unknown) => {
            h.subUpdateArgs.push(args);
            return {};
          },
        },
        brokerConnection: {
          // mode "overall" → findMany for stale-session warnings; none connected.
          findMany: async () => [],
        },
      },
    },
  };
  cache[resolve("@usemoney/pubsub/publish")] = {
    exports: {
      __esModule: true,
      publishRoastJob: async (job: unknown) => {
        h.publishedJobs.push(job);
      },
    },
  };
  cache[resolve("@usemoney/services")] = {
    exports: {
      __esModule: true,
      createRoastSession: async (data: unknown) => {
        h.createSessionCalls.push(data);
        return h.createSessionSuccess
          ? { success: true, data: { id: "roast-row-1" } }
          : { success: false, error: "insert failed" };
      },
      getRoastStatus: async () => ({
        success: false,
        error: "Roast not found",
      }),
      getRunningRoasts: async () => ({ success: true, data: [] }),
      updateRoastStatus: async (...args: unknown[]) => {
        h.updateRoastStatusCalls.push(args);
        return { success: true, data: {} };
      },
    },
  };

  delete cache[resolve(ROAST_ACTION_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ROAST_ACTION_REL) as RoastActionModule;
}

function clearRoastActionSeam(): void {
  const cache = roastCacheMap();
  for (const p of [
    ROAST_ACTION_REL,
    "@/lib/auth",
    "@/lib/demo/session",
    "@/lib/subscription/access",
    "@usemoney/database",
    "@usemoney/pubsub/publish",
    "@usemoney/services",
  ]) {
    try {
      delete cache[require.resolve(p)];
    } catch {
      // ignore modules that never resolved
    }
  }
}

describe("startRoastAction — failed createRoastSession must not charge or publish (MONEY-1062 Fix 4)", () => {
  afterEach(clearRoastActionSeam);

  it("createRoastSession failure → GENERAL error, NO credit consumed, NO job published, status untouched", async () => {
    const h = newRoastHarness({ createSessionSuccess: false });
    const mod = loadRoastAction(h);
    const res = await mod.startRoastAction({
      mode: "overall",
      assetType: "all",
    });

    // Returns the action's normal error shape (mirrors the publish-failure leg).
    assert.equal(res.success, false);
    assert.equal(res.errorType, "GENERAL");
    assert.match(res.error ?? "", /Failed to start roast/);

    // The session INSERT was attempted...
    assert.equal(h.createSessionCalls.length, 1);
    // ...but the credit was NOT consumed (consumeRoastCredit → subscription.update)
    assert.equal(h.subUpdateArgs.length, 0);
    // ...NO job was published...
    assert.equal(h.publishedJobs.length, 0);
    // ...and status was never flipped to FAILED (that leg is publish-only).
    assert.equal(h.updateRoastStatusCalls.length, 0);
  });

  it("[control] createRoastSession success → credit IS consumed and the job IS published", async () => {
    const h = newRoastHarness({ createSessionSuccess: true });
    const mod = loadRoastAction(h);
    const res = await mod.startRoastAction({
      mode: "overall",
      assetType: "all",
    });

    assert.equal(res.success, true);
    assert.ok(res.sessionId && res.sessionId.length > 0);
    assert.equal(h.createSessionCalls.length, 1);
    // free roast consumed → exactly one subscription.update (the increment).
    assert.equal(h.subUpdateArgs.length, 1);
    // and exactly one roast job published.
    assert.equal(h.publishedJobs.length, 1);
  });
});
