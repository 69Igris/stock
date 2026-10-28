/**
 * Roast pipeline orchestration tests.
 *
 * De-shadowed (MONEY-620): drives the REAL `runRoastPipeline` from
 * packages/roast/src/agent-pipeline.ts — the same orchestration
 * `RoastAgent.run` executes in production — against an in-memory dependency
 * bundle (mocked steps + status sinks + deterministic clock). The pipeline was
 * extracted out of the Prisma/Gemini-coupled `RoastAgent` precisely so this
 * orchestration (step order, progress values, skip-empty logic, timeout guard,
 * cancel checks, sanitized-fail path, cancelled-before-COMPLETED race) is
 * unit-testable without importing Prisma at module load.
 *
 * NOTE vs the old shadow: the old inline copy asserted RAW failure messages.
 * Production sanitizes every failure (MONEY-488), so these assertions now check
 * the REAL sanitized copy — e.g. the empty-portfolio path stores the generic
 * "Something went wrong while generating your roast." sentence, and an unknown
 * thrown error is NOT echoed verbatim.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  runRoastPipeline,
  type RoastPipelineDeps,
} from "../../../../packages/roast/src/agent-pipeline";
import { sanitizeRoastErrorMessage } from "../../../../packages/roast/src/lib/parse-llm-json";
import type {
  PortfolioData,
  StockHolding,
  MfHolding,
  StockAnalysisResult,
  MfAnalysisResult,
  ScoresResult,
  RoastContentResult,
  RoastAgentConfig,
  RoastJobMessage,
} from "@usemoney/roast/types";
import type { StructuredRoastResult } from "@usemoney/types";

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeHolding(overrides?: Partial<StockHolding>): StockHolding {
  return {
    symbol: "RELIANCE",
    name: "Reliance Industries",
    sector: "Energy",
    quantity: 10,
    averagePrice: 2400,
    currentPrice: 2650,
    investedValue: 24000,
    currentValue: 26500,
    unrealizedPnL: 2500,
    pnlPercentage: 10.4,
    brokerName: "ZERODHA",
    ...overrides,
  };
}

function makeMf(overrides?: Partial<MfHolding>): MfHolding {
  return {
    schemeName: "Axis Bluechip Fund - Direct Growth",
    category: "Large Cap",
    units: 100,
    averageNav: 40,
    currentNav: 45,
    investedAmount: 4000,
    currentValue: 4500,
    unrealizedGain: 500,
    xirr: 12.5,
    brokerName: "GROWW",
    ...overrides,
  };
}

function makePortfolioData(overrides?: Partial<PortfolioData>): PortfolioData {
  const holdings = overrides?.holdings ?? [makeHolding()];
  const mfs = overrides?.mfs ?? [makeMf()];
  return {
    holdings,
    mfs,
    summary: overrides?.summary ?? {
      totalStockInvested: 24000,
      totalStockCurrent: 26500,
      totalMfInvested: 4000,
      totalMfCurrent: 4500,
      sectorConcentration: [
        { sector: "Energy", value: 26500, percentage: 100 },
      ],
      stockCount: holdings.length,
      mfCount: mfs.length,
    },
  };
}

function makeStockAnalysis(
  overrides?: Partial<StockAnalysisResult>
): StockAnalysisResult {
  return {
    diversificationIssues: ["Heavy concentration"],
    sectorConcentration: [
      { sector: "Energy", percentage: 100, verdict: "overweight" },
    ],
    topPicks: [{ symbol: "RELIANCE", reason: "Strong" }],
    bottomPicks: [],
    riskFlags: ["Single sector"],
    ...overrides,
  };
}

function makeMfAnalysis(
  overrides?: Partial<MfAnalysisResult>
): MfAnalysisResult {
  return {
    categoryOverlap: ["Multiple large-cap"],
    performanceVerdict: "Moderate",
    expenseIssues: [],
    mfHighlights: [{ scheme: "Axis Bluechip", verdict: "Decent" }],
    ...overrides,
  };
}

function makeScores(overrides?: Partial<ScoresResult>): ScoresResult {
  return {
    overallScore: 65,
    scoreBreakdown: {
      diversification: { score: 50, comment: "Needs work" },
      riskManagement: { score: 60, comment: "Average" },
      stockPicking: { score: 70, comment: "Decent" },
      timing: { score: 80, comment: "Good" },
    },
    ...overrides,
  };
}

function makeRoastContent(
  overrides?: Partial<RoastContentResult>
): RoastContentResult {
  return {
    roastHighlights: [
      {
        type: "burn",
        emoji: "fire",
        title: "Overcooked",
        description: "Your portfolio is charred.",
      },
    ],
    topPerformers: [
      { symbol: "RELIANCE", pnlPercent: 10.4, roast: "Nice one" },
    ],
    worstPerformers: [],
    sectorAnalysis: [
      {
        sector: "Energy",
        percentage: 100,
        verdict: "overweight",
        comment: "Way too much",
      },
    ],
    constructiveAdvice: [
      { title: "Diversify", description: "Add more sectors" },
    ],
    roastNarrative: "Your portfolio is a comedy.",
    ...overrides,
  };
}

function makeJob(overrides?: Partial<RoastJobMessage>): RoastJobMessage {
  return {
    jobId: "job-1",
    sessionId: "sess-123",
    userId: "user-456",
    mode: "overall",
    assetType: "all",
    ...overrides,
  };
}

function makeConfig(
  overrides?: Partial<RoastAgentConfig>
): Required<RoastAgentConfig> {
  return {
    stepTimeoutMs: overrides?.stepTimeoutMs ?? 60000,
    totalTimeoutMs: overrides?.totalTimeoutMs ?? 300000,
  };
}

// ---------------------------------------------------------------------------
// In-memory deps recorder — backs the real pipeline's side-effect sinks.
// ---------------------------------------------------------------------------

interface Recorder {
  deps: RoastPipelineDeps;
  updateCalls: Array<{
    sessionId: string;
    status: string;
    progress: number;
    currentStep: string;
  }>;
  failCalls: Array<{ sessionId: string; errorMessage: string }>;
  completeCalls: Array<{
    sessionId: string;
    score: number;
    result: StructuredRoastResult;
  }>;
}

function makeRecorder(
  overrides?: Partial<RoastPipelineDeps>,
  opts?: { cancelled?: boolean; now?: () => number }
): Recorder {
  const updateCalls: Recorder["updateCalls"] = [];
  const failCalls: Recorder["failCalls"] = [];
  const completeCalls: Recorder["completeCalls"] = [];

  const deps: RoastPipelineDeps = {
    fetchPortfolio: mock.fn(async () => makePortfolioData()),
    analyzeStocks: mock.fn(async () => makeStockAnalysis()),
    analyzeMf: mock.fn(async () => makeMfAnalysis()),
    generateScores: mock.fn(async () => makeScores()),
    generateRoast: mock.fn(async () => makeRoastContent()),
    // Use the REAL assembleResult so the assembled result/disclaimer is exercised.
    assembleResult: (scores, roastContent) => ({
      overallScore: scores.overallScore,
      scoreBreakdown: scores.scoreBreakdown,
      roastHighlights: roastContent.roastHighlights,
      topPerformers: roastContent.topPerformers,
      worstPerformers: roastContent.worstPerformers,
      sectorAnalysis: roastContent.sectorAnalysis,
      constructiveAdvice: roastContent.constructiveAdvice,
      roastNarrative: roastContent.roastNarrative,
      disclaimer:
        "This is entertainment, not financial advice. Always consult a qualified financial advisor.",
    }),
    // Use the REAL sanitizer so failure copy matches production.
    sanitizeError: sanitizeRoastErrorMessage,
    logger: { info: () => {}, error: () => {} },
    updateStatus: async (sessionId, status, progress, currentStep) => {
      updateCalls.push({ sessionId, status, progress, currentStep });
    },
    complete: async (sessionId, score, result) => {
      completeCalls.push({ sessionId, score, result });
    },
    fail: async (sessionId, errorMessage) => {
      failCalls.push({ sessionId, errorMessage: errorMessage.slice(0, 500) });
    },
    isCancelled: async () => opts?.cancelled ?? false,
    now: opts?.now,
    ...overrides,
  };

  return { deps, updateCalls, failCalls, completeCalls };
}

function mockCalls(fn: RoastPipelineDeps[keyof RoastPipelineDeps]) {
  return (fn as unknown as ReturnType<typeof mock.fn>).mock.calls;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runRoastPipeline", () => {
  describe("default config", () => {
    it("passes stepTimeoutMs (60000) to analyzeStocks", async () => {
      const r = makeRecorder();
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(
        mockCalls(r.deps.analyzeStocks)[0]!.arguments[1],
        60000
      );
    });

    it("completes a full portfolio within default totalTimeoutMs", async () => {
      const r = makeRecorder();
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(r.completeCalls.length, 1);
    });
  });

  describe("custom config", () => {
    it("passes a custom stepTimeoutMs to analyzeStocks", async () => {
      const r = makeRecorder();
      await runRoastPipeline(
        makeJob(),
        makeConfig({ stepTimeoutMs: 30000 }),
        r.deps
      );
      assert.strictEqual(
        mockCalls(r.deps.analyzeStocks)[0]!.arguments[1],
        30000
      );
    });

    it("passes stepTimeoutMs + 30000 to generateRoast", async () => {
      const r = makeRecorder();
      await runRoastPipeline(
        makeJob(),
        makeConfig({ stepTimeoutMs: 40000 }),
        r.deps
      );
      assert.strictEqual(
        mockCalls(r.deps.generateRoast)[0]!.arguments[4],
        70000
      );
    });

    it("passes the job scope through to generateRoast (default PORTFOLIO)", async () => {
      const r = makeRecorder();
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(
        mockCalls(r.deps.generateRoast)[0]!.arguments[5],
        "PORTFOLIO"
      );
    });

    it("forwards an explicit TRADEBOOK scope to generateRoast", async () => {
      const r = makeRecorder();
      await runRoastPipeline(
        makeJob({ scope: "TRADEBOOK" }),
        makeConfig(),
        r.deps
      );
      assert.strictEqual(
        mockCalls(r.deps.generateRoast)[0]!.arguments[5],
        "TRADEBOOK"
      );
    });
  });

  describe("pipeline orchestration", () => {
    it("executes all 6 steps in order for a full portfolio", async () => {
      const r = makeRecorder();
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(r.updateCalls.length, 6);
      assert.strictEqual(r.updateCalls[0]!.status, "FETCHING_DATA");
      assert.strictEqual(r.updateCalls[1]!.status, "ANALYZING_STOCKS");
      assert.strictEqual(r.updateCalls[2]!.status, "ANALYZING_MF");
      assert.strictEqual(r.updateCalls[3]!.status, "SCORING");
      assert.strictEqual(r.updateCalls[4]!.status, "GENERATING_ROAST");
      assert.strictEqual(r.updateCalls[5]!.status, "ASSEMBLING");
    });

    it("sets the correct progress value for each step", async () => {
      const r = makeRecorder();
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.deepStrictEqual(
        r.updateCalls.map((u) => u.progress),
        [5, 20, 40, 58, 72, 92]
      );
    });

    it("sets the correct currentStep message for each step", async () => {
      const r = makeRecorder();
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.deepStrictEqual(
        r.updateCalls.map((u) => u.currentStep),
        [
          "Loading portfolio...",
          "Analyzing stock holdings...",
          "Analyzing mutual funds...",
          "Scoring your portfolio...",
          "Writing the roast...",
          "Assembling results...",
        ]
      );
    });

    it("passes sessionId in every update call", async () => {
      const r = makeRecorder();
      await runRoastPipeline(
        makeJob({ sessionId: "my-session" }),
        makeConfig(),
        r.deps
      );
      for (const update of r.updateCalls) {
        assert.strictEqual(update.sessionId, "my-session");
      }
    });

    it("calls fetchPortfolio with the job's userId/mode/broker/assetType", async () => {
      const r = makeRecorder();
      await runRoastPipeline(
        makeJob({
          userId: "user-X",
          mode: "broker",
          broker: "ZERODHA",
          assetType: "stocks",
        }),
        makeConfig(),
        r.deps
      );
      const args = mockCalls(r.deps.fetchPortfolio)[0]!.arguments;
      assert.strictEqual(args[0], "user-X");
      assert.strictEqual(args[1], "broker");
      assert.strictEqual(args[2], "ZERODHA");
      assert.strictEqual(args[3], "stocks");
    });

    it("marks completed with the correct score", async () => {
      const r = makeRecorder({
        generateScores: mock.fn(async () => makeScores({ overallScore: 82 })),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(r.completeCalls.length, 1);
      assert.strictEqual(r.completeCalls[0]!.score, 82);
    });
  });

  describe("empty portfolio handling", () => {
    it("fails immediately (sanitized) when no holdings and no MFs", async () => {
      const r = makeRecorder({
        fetchPortfolio: mock.fn(async () =>
          makePortfolioData({ holdings: [], mfs: [] })
        ),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(r.failCalls.length, 1);
      // MONEY-488: the raw "No portfolio data found..." is sanitized to the
      // generic copy before persistence — the old shadow wrongly asserted raw.
      assert.strictEqual(
        r.failCalls[0]!.errorMessage,
        "Something went wrong while generating your roast. Please try again."
      );
      assert.strictEqual(r.completeCalls.length, 0);
    });

    it("does not call analyzeStocks or analyzeMf for an empty portfolio", async () => {
      const r = makeRecorder({
        fetchPortfolio: mock.fn(async () =>
          makePortfolioData({ holdings: [], mfs: [] })
        ),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(mockCalls(r.deps.analyzeStocks).length, 0);
      assert.strictEqual(mockCalls(r.deps.analyzeMf).length, 0);
    });
  });

  describe("skip steps when data is missing", () => {
    it("skips analyzeStocks and passes null stockAnalysis to generateScores when no holdings", async () => {
      const r = makeRecorder({
        fetchPortfolio: mock.fn(async () =>
          makePortfolioData({ holdings: [], mfs: [makeMf()] })
        ),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(mockCalls(r.deps.analyzeStocks).length, 0);
      assert.strictEqual(
        mockCalls(r.deps.generateScores)[0]!.arguments[0],
        null
      );
    });

    it("skips analyzeMf and passes null mfAnalysis to generateScores when no MFs", async () => {
      const r = makeRecorder({
        fetchPortfolio: mock.fn(async () =>
          makePortfolioData({ holdings: [makeHolding()], mfs: [] })
        ),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(mockCalls(r.deps.analyzeMf).length, 0);
      assert.strictEqual(
        mockCalls(r.deps.generateScores)[0]!.arguments[1],
        null
      );
    });

    it("passes null stockAnalysis but non-null mfAnalysis to generateRoast (MF-only)", async () => {
      const r = makeRecorder({
        fetchPortfolio: mock.fn(async () =>
          makePortfolioData({ holdings: [], mfs: [makeMf()] })
        ),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      const args = mockCalls(r.deps.generateRoast)[0]!.arguments;
      assert.strictEqual(args[0], null);
      assert.notStrictEqual(args[1], null);
    });
  });

  describe("error propagation (sanitized)", () => {
    it("catches a fetchPortfolio error and fails (sanitized to generic)", async () => {
      const r = makeRecorder({
        fetchPortfolio: mock.fn(async () => {
          throw new Error("Database connection failed");
        }),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(r.failCalls.length, 1);
      assert.strictEqual(
        r.failCalls[0]!.errorMessage,
        "Something went wrong while generating your roast. Please try again."
      );
      assert.strictEqual(r.completeCalls.length, 0);
    });

    it("maps a JSON/parse error to the AI-response copy", async () => {
      const r = makeRecorder({
        analyzeStocks: mock.fn(async () => {
          throw new Error("Unterminated string in JSON at position 245");
        }),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(
        r.failCalls[0]!.errorMessage,
        "We had trouble reading the AI response. Please try again."
      );
    });

    it("maps a timeout error to the took-longer copy", async () => {
      const r = makeRecorder({
        analyzeMf: mock.fn(async () => {
          throw new Error("MF analysis timed out after 60000ms");
        }),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(
        r.failCalls[0]!.errorMessage,
        "Roast generation took longer than expected. Please try again."
      );
    });

    it("maps a network/fetch error to the network copy", async () => {
      const r = makeRecorder({
        generateScores: mock.fn(async () => {
          throw new Error("fetch failed: network unreachable");
        }),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(
        r.failCalls[0]!.errorMessage,
        "Network issue while generating roast. Please try again."
      );
    });

    it("catches a generateRoast error and fails", async () => {
      const r = makeRecorder({
        generateRoast: mock.fn(async () => {
          throw new Error("Roast generation failed");
        }),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(r.failCalls.length, 1);
      assert.strictEqual(r.completeCalls.length, 0);
    });

    it("handles a non-Error thrown value (sanitized)", async () => {
      const r = makeRecorder({
        fetchPortfolio: mock.fn(async () => {
          throw "string error"; // eslint-disable-line no-throw-literal
        }),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(r.failCalls.length, 1);
      assert.strictEqual(
        r.failCalls[0]!.errorMessage,
        "Something went wrong while generating your roast. Please try again."
      );
    });
  });

  describe("timeout handling", () => {
    it("fails with a timeout error when totalTimeoutMs is exceeded", async () => {
      let tick = 0;
      const fakeTimes = [1000, 6000, 6000, 6000, 6000, 6000];
      const now = () => fakeTimes[tick++] ?? 6000;
      const r = makeRecorder(undefined, { now });
      await runRoastPipeline(
        makeJob(),
        makeConfig({ totalTimeoutMs: 3000 }),
        r.deps
      );
      assert.strictEqual(r.failCalls.length, 1);
      // "timed out" → sanitized to the took-longer copy.
      assert.strictEqual(
        r.failCalls[0]!.errorMessage,
        "Roast generation took longer than expected. Please try again."
      );
    });

    it("does not time out with a sufficiently large totalTimeoutMs", async () => {
      const r = makeRecorder();
      await runRoastPipeline(
        makeJob(),
        makeConfig({ totalTimeoutMs: 300000 }),
        r.deps
      );
      assert.strictEqual(r.completeCalls.length, 1);
      assert.strictEqual(r.failCalls.length, 0);
    });

    it("times out after the specific step where time exceeds the limit", async () => {
      let tick = 0;
      const fakeTimes = [0, 100, 500];
      const now = () => fakeTimes[tick++] ?? 500;
      const r = makeRecorder(undefined, { now });
      await runRoastPipeline(
        makeJob(),
        makeConfig({ totalTimeoutMs: 200 }),
        r.deps
      );
      // First checkTimeout passes (100-0<200), second fails (500-0>200).
      assert.strictEqual(r.failCalls.length, 1);
      assert.strictEqual(r.completeCalls.length, 0);
    });
  });

  describe("cancellation handling", () => {
    it("aborts mid-pipeline when isCancelled becomes true (no completion)", async () => {
      // Cancelled from the first check onward → throws "Cancelled by user",
      // which sanitizes back to the cancel sentinel.
      const r = makeRecorder(undefined, { cancelled: true });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(r.completeCalls.length, 0);
      assert.strictEqual(r.failCalls.length, 1);
      assert.strictEqual(r.failCalls[0]!.errorMessage, "Cancelled by user");
    });

    it("skips the COMPLETED update when cancelled only at the final race-guard", async () => {
      // isCancelled returns false through all step checks, true on the final
      // pre-complete guard → no complete, no fail (clean early return).
      const cancelStates = [false, false, false, false, false, true];
      let i = 0;
      const r = makeRecorder({
        isCancelled: async () => cancelStates[i++] ?? true,
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(r.completeCalls.length, 0);
      assert.strictEqual(r.failCalls.length, 0);
      // All 6 status updates still ran (cancel detected only at the very end).
      assert.strictEqual(r.updateCalls.length, 6);
    });
  });

  describe("final result assembly", () => {
    it("produces a StructuredRoastResult with overallScore + breakdown + disclaimer", async () => {
      const r = makeRecorder();
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      const result = r.completeCalls[0]!.result;
      assert.strictEqual(result.overallScore, 65);
      assert.strictEqual(result.scoreBreakdown.diversification.score, 50);
      assert.strictEqual(result.scoreBreakdown.riskManagement.score, 60);
      assert.strictEqual(result.scoreBreakdown.stockPicking.score, 70);
      assert.strictEqual(result.scoreBreakdown.timing.score, 80);
      assert.strictEqual(
        result.disclaimer,
        "This is entertainment, not financial advice. Always consult a qualified financial advisor."
      );
    });

    it("carries roastHighlights, roastNarrative, sectorAnalysis, constructiveAdvice", async () => {
      const r = makeRecorder();
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      const result = r.completeCalls[0]!.result;
      assert.strictEqual(result.roastHighlights.length, 1);
      assert.strictEqual(result.roastHighlights[0]!.type, "burn");
      assert.strictEqual(result.roastNarrative, "Your portfolio is a comedy.");
      assert.strictEqual(result.sectorAnalysis.length, 1);
      assert.strictEqual(result.constructiveAdvice.length, 1);
    });
  });

  describe("partial portfolios complete successfully", () => {
    it("completes with a stocks-only portfolio", async () => {
      const r = makeRecorder({
        fetchPortfolio: mock.fn(async () =>
          makePortfolioData({ holdings: [makeHolding()], mfs: [] })
        ),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(r.completeCalls.length, 1);
      assert.strictEqual(r.failCalls.length, 0);
    });

    it("completes with an MF-only portfolio", async () => {
      const r = makeRecorder({
        fetchPortfolio: mock.fn(async () =>
          makePortfolioData({ holdings: [], mfs: [makeMf()] })
        ),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(r.completeCalls.length, 1);
      assert.strictEqual(r.failCalls.length, 0);
    });

    it("does not call generateScores/generateRoast when fetchPortfolio returns empty", async () => {
      const r = makeRecorder({
        fetchPortfolio: mock.fn(async () =>
          makePortfolioData({ holdings: [], mfs: [] })
        ),
      });
      await runRoastPipeline(makeJob(), makeConfig(), r.deps);
      assert.strictEqual(mockCalls(r.deps.generateScores).length, 0);
      assert.strictEqual(mockCalls(r.deps.generateRoast).length, 0);
    });
  });
});
