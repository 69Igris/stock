/**
 * Research & Roast Processor Edge Case Tests
 * Source: workers/src/processors/research.ts, workers/src/processors/roast.ts
 *
 * Tests edge cases in processResearch and processRoast:
 *   Research:
 *   - Invalid config values (NaN timeout, 0 max steps)
 *   - Session not found (deleted during processing)
 *   - Notification failure swallowed (fire-and-forget via .catch)
 *   - Empty query string
 *   - Cancelled session between check and notification
 *
 *   Roast:
 *   - NaN environment variable parsing
 *   - Session update failure in catch block
 *   - Very long error message stored without truncation
 *   - Zero timeout
 *   - userId null/undefined -> notification skipped
 *
 * All external dependencies are inlined/mocked in-place.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ── Inline types ────────────────────────────────────────────────────

interface ResearchJobMessage {
  jobId: string;
  sessionId: string;
  query: string;
  userId?: string;
  symbols?: string[];
  mode?: "fast" | "advanced";
}

interface RoastJobMessage {
  jobId: string;
  userId: string;
  sessionId: string;
  mode: "overall" | "broker";
  broker?: string;
  assetType: "stocks" | "mf" | "all";
}

interface ResearchConfig {
  maxSteps: number;
  maxIterations: number;
  stepTimeoutMs: number;
  totalTimeoutMs: number;
  maxConcurrency: number;
  qualityThreshold: number;
  skipValidation: boolean;
}

interface NotificationInput {
  userId: string;
  type: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

// ── Research mock infrastructure ────────────────────────────────────

const FAST_CONFIG: ResearchConfig = {
  maxSteps: 5,
  maxIterations: 2,
  stepTimeoutMs: 30000,
  totalTimeoutMs: 120000,
  maxConcurrency: 3,
  qualityThreshold: 0.6,
  skipValidation: true,
};

function getConfigForMode(mode: string): ResearchConfig {
  return mode === "advanced"
    ? {
        maxSteps: 15,
        maxIterations: 5,
        stepTimeoutMs: 60000,
        totalTimeoutMs: 300000,
        maxConcurrency: 5,
        qualityThreshold: 0.8,
        skipValidation: false,
      }
    : FAST_CONFIG;
}

// Pure function extracted from research.ts
function parseEnvInt(
  envKey: string,
  fallback: number,
  envMap: Record<string, string> = {}
): number {
  const envVal = envMap[envKey];
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    return isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
}

function buildAnalysisLink(sessionId: string, symbols?: string[]): string {
  const symbol = symbols?.[0]?.replace(/\.(NS|BO)$/, "") || "";
  return `/analysis?sessionId=${sessionId}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ""}`;
}

// ── Research processor (mirrors workers/src/processors/research.ts) ──

interface ResearchDeps {
  envMap?: Record<string, string>;
  runAgent: (
    config: Record<string, unknown>,
    mode: string,
    data: ResearchJobMessage
  ) => Promise<void>;
  findSession: (sessionId: string) => Promise<{ status: string } | null>;
  updateSession: (
    sessionId: string,
    data: Record<string, unknown>
  ) => Promise<void>;
  createNotification: (notif: NotificationInput) => Promise<void>;
}

let researchAgentConfigs: Array<{
  config: Record<string, unknown>;
  mode: string;
}> = [];
let researchNotificationCalls: NotificationInput[] = [];
let researchSessionUpdates: Array<{
  sessionId: string;
  data: Record<string, unknown>;
}> = [];

async function processResearch(
  data: ResearchJobMessage,
  deps: ResearchDeps
): Promise<void> {
  const mode = data.mode || "fast";
  const modeConfig = getConfigForMode(mode);
  const envMap = deps.envMap ?? {};

  const config = {
    maxSteps: parseEnvInt("RESEARCH_MAX_STEPS", modeConfig.maxSteps, envMap),
    maxIterations: parseEnvInt(
      "RESEARCH_MAX_ITERATIONS",
      modeConfig.maxIterations,
      envMap
    ),
    stepTimeoutMs: parseEnvInt(
      "RESEARCH_STEP_TIMEOUT_MS",
      modeConfig.stepTimeoutMs,
      envMap
    ),
    totalTimeoutMs: parseEnvInt(
      "RESEARCH_TOTAL_TIMEOUT_MS",
      modeConfig.totalTimeoutMs,
      envMap
    ),
    maxConcurrency: parseEnvInt(
      "RESEARCH_MAX_CONCURRENT",
      modeConfig.maxConcurrency,
      envMap
    ),
    qualityThreshold: modeConfig.qualityThreshold,
    skipValidation: modeConfig.skipValidation,
  };

  researchAgentConfigs.push({ config, mode });

  try {
    await deps.runAgent(config, mode, data);

    // Check session status after agent completes
    const session = await deps.findSession(data.sessionId);

    if (session?.status === "FAILED") {
      // Send failure notification (fire-and-forget)
      if (data.userId) {
        await deps
          .createNotification({
            userId: data.userId,
            type: "RESEARCH_COMPLETE",
            title: "Research Failed",
            message: `Research on "${data.query}" encountered an error. Please try again.`,
            metadata: { sessionId: data.sessionId },
          })
          .catch(() => {});
      }
      return;
    }

    // Send success notification
    if (data.userId) {
      const analysisLink = buildAnalysisLink(data.sessionId, data.symbols);
      await deps.createNotification({
        userId: data.userId,
        type: "RESEARCH_COMPLETE",
        title: "Research Complete",
        message: `Research on "${data.query}" is ready to view.`,
        metadata: { sessionId: data.sessionId, link: analysisLink },
      });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Mark session as FAILED
    try {
      await deps.updateSession(data.sessionId, {
        status: "FAILED",
        errorMessage: `Processor error: ${errorMsg}`,
        progress: 0,
        currentStep: "Research failed",
        completedAt: new Date(),
      });
    } catch (_dbError) {
      // swallow DB error
    }

    // Send failure notification (fire-and-forget)
    if (data.userId) {
      await deps
        .createNotification({
          userId: data.userId,
          type: "RESEARCH_COMPLETE",
          title: "Research Failed",
          message: `Research on "${data.query}" encountered an error. Please try again.`,
          metadata: { sessionId: data.sessionId },
        })
        .catch(() => {});
    }

    // Do NOT re-throw - return normally so Pub/Sub acks
  }
}

// ── Roast types and processor ───────────────────────────────────────

// Inline env parsing logic from roast.ts
function parseStepTimeout(envValue: string | undefined): number {
  return parseInt(envValue || "60000", 10);
}

function parseTotalTimeout(envValue: string | undefined): number {
  return parseInt(envValue || "300000", 10);
}

function shouldCreateNotification(data: RoastJobMessage): boolean {
  return !!data.userId;
}

function buildRoastNotification(data: RoastJobMessage): NotificationInput {
  return {
    userId: data.userId,
    type: "ROAST_COMPLETE",
    title: "Portfolio Roast Complete",
    message: "Your portfolio roast is ready to view!",
    metadata: {
      sessionId: data.sessionId,
      link: `/roast/${data.sessionId}`,
    },
  };
}

interface RoastDeps {
  createAgent: (opts: { stepTimeoutMs: number; totalTimeoutMs: number }) => {
    run: (data: RoastJobMessage) => Promise<void>;
  };
  findSession: (sessionId: string) => Promise<{ status: string } | null>;
  updateSession: (
    sessionId: string,
    data: Record<string, unknown>
  ) => Promise<void>;
  createNotification: (input: NotificationInput) => Promise<void>;
  env: {
    ROAST_STEP_TIMEOUT_MS?: string;
    ROAST_TOTAL_TIMEOUT_MS?: string;
  };
}

let roastAgentRunCalls: RoastJobMessage[] = [];
let roastCapturedOpts: Array<{
  stepTimeoutMs: number;
  totalTimeoutMs: number;
}> = [];
let roastNotificationCalls: NotificationInput[] = [];
let roastSessionUpdates: Array<{
  sessionId: string;
  data: Record<string, unknown>;
}> = [];

async function processRoast(
  data: RoastJobMessage,
  deps: RoastDeps
): Promise<void> {
  try {
    const agent = deps.createAgent({
      stepTimeoutMs: parseStepTimeout(deps.env.ROAST_STEP_TIMEOUT_MS),
      totalTimeoutMs: parseTotalTimeout(deps.env.ROAST_TOTAL_TIMEOUT_MS),
    });

    await agent.run(data);

    // Check session status
    const session = await deps.findSession(data.sessionId);

    if (session?.status === "FAILED") {
      if (data.userId) {
        await deps
          .createNotification({
            userId: data.userId,
            type: "ROAST_COMPLETE",
            title: "Portfolio Roast Failed",
            message:
              "Your portfolio roast encountered an error. Please try again.",
            metadata: { sessionId: data.sessionId },
          })
          .catch(() => {});
      }
      return;
    }

    // Success notification
    if (shouldCreateNotification(data)) {
      await deps.createNotification(buildRoastNotification(data));
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Mark session as FAILED
    try {
      await deps.updateSession(data.sessionId, {
        status: "FAILED",
        errorMessage: `Processor error: ${errorMsg}`,
        completedAt: new Date(),
      });
    } catch (_dbError) {
      // swallow DB error
    }

    // Failure notification (fire-and-forget)
    if (data.userId) {
      await deps
        .createNotification({
          userId: data.userId,
          type: "ROAST_COMPLETE",
          title: "Portfolio Roast Failed",
          message:
            "Your portfolio roast encountered an error. Please try again.",
          metadata: { sessionId: data.sessionId },
        })
        .catch(() => {});
    }

    // Don't re-throw
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function makeResearchMessage(
  overrides: Partial<ResearchJobMessage> = {}
): ResearchJobMessage {
  return {
    jobId: "job-001",
    sessionId: "sess-001",
    query: "Analyze RELIANCE",
    ...overrides,
  };
}

function makeResearchDeps(overrides: Partial<ResearchDeps> = {}): ResearchDeps {
  return {
    envMap: {},
    runAgent: async () => {},
    findSession: async () => ({ status: "COMPLETED" }),
    updateSession: async (sessionId, data) => {
      researchSessionUpdates.push({ sessionId, data });
    },
    createNotification: async (notif) => {
      researchNotificationCalls.push(notif);
    },
    ...overrides,
  };
}

function makeRoastMessage(
  overrides: Partial<RoastJobMessage> = {}
): RoastJobMessage {
  return {
    jobId: "job-001",
    userId: "user-123",
    sessionId: "session-abc",
    mode: "overall",
    assetType: "all",
    ...overrides,
  };
}

function makeRoastDeps(overrides: Partial<RoastDeps> = {}): RoastDeps {
  return {
    createAgent: (opts) => {
      roastCapturedOpts.push(opts);
      return {
        run: async (data) => {
          roastAgentRunCalls.push(data);
        },
      };
    },
    findSession: async () => ({ status: "COMPLETED" }),
    updateSession: async (sessionId, data) => {
      roastSessionUpdates.push({ sessionId, data });
    },
    createNotification: async (input) => {
      roastNotificationCalls.push(input);
    },
    env: {},
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Workers - Research & Roast Processor Edge Cases", () => {
  beforeEach(() => {
    researchAgentConfigs = [];
    researchNotificationCalls = [];
    researchSessionUpdates = [];
    roastAgentRunCalls = [];
    roastCapturedOpts = [];
    roastNotificationCalls = [];
    roastSessionUpdates = [];
  });

  // ═══════════════════════════════════════════════════════════════════
  // RESEARCH EDGE CASES
  // ═══════════════════════════════════════════════════════════════════

  describe("Research: invalid config values", () => {
    it("should fall back to default when RESEARCH_STEP_TIMEOUT_MS is NaN", async () => {
      await processResearch(
        makeResearchMessage(),
        makeResearchDeps({
          envMap: { RESEARCH_STEP_TIMEOUT_MS: "not-a-number" },
        })
      );

      const config = researchAgentConfigs[0]!.config as Record<string, number>;
      assert.strictEqual(config.stepTimeoutMs, FAST_CONFIG.stepTimeoutMs);
    });

    it("should fall back to default when RESEARCH_MAX_STEPS is NaN", async () => {
      await processResearch(
        makeResearchMessage(),
        makeResearchDeps({ envMap: { RESEARCH_MAX_STEPS: "abc" } })
      );

      const config = researchAgentConfigs[0]!.config as Record<string, number>;
      assert.strictEqual(config.maxSteps, FAST_CONFIG.maxSteps);
    });

    it("should accept 0 as a valid RESEARCH_MAX_STEPS value", async () => {
      await processResearch(
        makeResearchMessage(),
        makeResearchDeps({ envMap: { RESEARCH_MAX_STEPS: "0" } })
      );

      const config = researchAgentConfigs[0]!.config as Record<string, number>;
      assert.strictEqual(config.maxSteps, 0);
    });

    it("should return fallback for empty string env value", () => {
      const result = parseEnvInt("MISSING", 42, { MISSING: "" });
      assert.strictEqual(result, 42);
    });
  });

  describe("Research: session not found (deleted during processing)", () => {
    it("should send success notification when session is null (not found)", async () => {
      await processResearch(
        makeResearchMessage({ userId: "u-1" }),
        makeResearchDeps({ findSession: async () => null })
      );

      // null !== FAILED, so code proceeds to success notification
      assert.strictEqual(researchNotificationCalls.length, 1);
      assert.strictEqual(
        researchNotificationCalls[0]!.title,
        "Research Complete"
      );
    });

    it("should not mark session as failed when it's deleted (null)", async () => {
      await processResearch(
        makeResearchMessage({ userId: "u-1" }),
        makeResearchDeps({ findSession: async () => null })
      );

      assert.strictEqual(researchSessionUpdates.length, 0);
    });
  });

  describe("Research: notification failure swallowed", () => {
    it("should not throw when failure notification .catch() swallows error", async () => {
      const throwingNotification = async () => {
        throw new Error("Notification service down");
      };

      // When agent throws, failure notification is sent with .catch(() => {})
      await processResearch(
        makeResearchMessage({ userId: "u-1" }),
        makeResearchDeps({
          runAgent: async () => {
            throw new Error("Agent crashed");
          },
          createNotification: throwingNotification,
        })
      );

      // Should not throw - processor returns normally
      assert.ok(true, "processResearch returned without throwing");
    });

    it("should not throw when FAILED-session notification .catch() swallows error", async () => {
      await processResearch(
        makeResearchMessage({ userId: "u-1" }),
        makeResearchDeps({
          findSession: async () => ({ status: "FAILED" }),
          createNotification: async () => {
            throw new Error("Notification broken");
          },
        })
      );

      assert.ok(true, "processResearch returned without throwing");
    });
  });

  describe("Research: empty query string", () => {
    it("should pass empty query through to agent and notification", async () => {
      await processResearch(
        makeResearchMessage({ userId: "u-1", query: "" }),
        makeResearchDeps()
      );

      assert.strictEqual(researchNotificationCalls.length, 1);
      assert.ok(
        researchNotificationCalls[0]!.message.includes('""'),
        "Notification message should contain the empty query in quotes"
      );
    });

    it("should still run agent with empty query string", async () => {
      const runAgentFn = mock.fn(async () => {});
      await processResearch(
        makeResearchMessage({ query: "" }),
        makeResearchDeps({ runAgent: runAgentFn })
      );

      assert.strictEqual(runAgentFn.mock.callCount(), 1);
    });
  });

  describe("Research: cancelled session between check and notification", () => {
    it("should send success notification even if session status is CANCELLED", async () => {
      // CANCELLED is not === "FAILED", so success path is taken
      await processResearch(
        makeResearchMessage({ userId: "u-1" }),
        makeResearchDeps({
          findSession: async () => ({ status: "CANCELLED" }),
        })
      );

      assert.strictEqual(researchNotificationCalls.length, 1);
      assert.strictEqual(
        researchNotificationCalls[0]!.title,
        "Research Complete"
      );
    });

    it("should only treat FAILED status as a failure", async () => {
      // Only status === "FAILED" triggers failure notification in the post-agent check
      for (const status of [
        "COMPLETED",
        "CANCELLED",
        "PROCESSING",
        "PENDING",
      ]) {
        researchNotificationCalls = [];
        await processResearch(
          makeResearchMessage({ userId: "u-1" }),
          makeResearchDeps({
            findSession: async () => ({ status }),
          })
        );
        assert.strictEqual(
          researchNotificationCalls[0]!.title,
          "Research Complete",
          `Status '${status}' should trigger success notification`
        );
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // ROAST EDGE CASES
  // ═══════════════════════════════════════════════════════════════════

  describe("Roast: NaN environment variable parsing", () => {
    it("should produce NaN when ROAST_STEP_TIMEOUT_MS is completely invalid", () => {
      // parseInt("not-a-number" || "60000") => parseInt("not-a-number") => NaN
      const result = parseStepTimeout("not-a-number");
      assert.strictEqual(Number.isNaN(result), true);
    });

    it("should produce NaN when ROAST_TOTAL_TIMEOUT_MS is completely invalid", () => {
      const result = parseTotalTimeout("xyz");
      assert.strictEqual(Number.isNaN(result), true);
    });

    it("should pass NaN timeout to agent when env var is invalid", async () => {
      await processRoast(
        makeRoastMessage(),
        makeRoastDeps({
          env: { ROAST_STEP_TIMEOUT_MS: "abc" },
        })
      );

      assert.strictEqual(roastCapturedOpts.length, 1);
      assert.strictEqual(
        Number.isNaN(roastCapturedOpts[0]!.stepTimeoutMs),
        true
      );
    });

    it("should parse leading digits from mixed strings (parseInt behavior)", () => {
      const result = parseStepTimeout("45abc");
      assert.strictEqual(result, 45);
    });
  });

  describe("Roast: session update failure in catch block", () => {
    it("should not throw when session update fails in the catch handler", async () => {
      await processRoast(
        makeRoastMessage(),
        makeRoastDeps({
          createAgent: () => ({
            run: async () => {
              throw new Error("Agent exploded");
            },
          }),
          updateSession: async () => {
            throw new Error("DB connection lost");
          },
        })
      );

      // Should not throw - catch handler swallows DB error
      assert.ok(true, "processRoast returned without throwing");
    });

    it("should still send failure notification even when session update fails", async () => {
      await processRoast(
        makeRoastMessage({ userId: "u-1" }),
        makeRoastDeps({
          createAgent: () => ({
            run: async () => {
              throw new Error("Agent exploded");
            },
          }),
          updateSession: async () => {
            throw new Error("DB down");
          },
        })
      );

      assert.strictEqual(roastNotificationCalls.length, 1);
      assert.strictEqual(
        roastNotificationCalls[0]!.title,
        "Portfolio Roast Failed"
      );
    });
  });

  describe("Roast: very long error message stored without truncation", () => {
    it("should store full error message regardless of length", async () => {
      const longMessage = "X".repeat(10000);

      await processRoast(
        makeRoastMessage(),
        makeRoastDeps({
          createAgent: () => ({
            run: async () => {
              throw new Error(longMessage);
            },
          }),
        })
      );

      assert.strictEqual(roastSessionUpdates.length, 1);
      const stored = roastSessionUpdates[0]!.data.errorMessage as string;
      assert.strictEqual(stored, `Processor error: ${longMessage}`);
      assert.strictEqual(stored.length, 10000 + "Processor error: ".length);
    });

    it("should prefix error message with 'Processor error: '", async () => {
      await processRoast(
        makeRoastMessage(),
        makeRoastDeps({
          createAgent: () => ({
            run: async () => {
              throw new Error("some failure");
            },
          }),
        })
      );

      const stored = roastSessionUpdates[0]!.data.errorMessage as string;
      assert.ok(stored.startsWith("Processor error: "));
    });
  });

  describe("Roast: zero timeout", () => {
    it("should accept 0 as a valid step timeout", () => {
      const result = parseStepTimeout("0");
      assert.strictEqual(result, 0);
    });

    it("should accept 0 as a valid total timeout", () => {
      const result = parseTotalTimeout("0");
      assert.strictEqual(result, 0);
    });

    it("should pass zero timeouts to agent when env vars are '0'", async () => {
      await processRoast(
        makeRoastMessage(),
        makeRoastDeps({
          env: {
            ROAST_STEP_TIMEOUT_MS: "0",
            ROAST_TOTAL_TIMEOUT_MS: "0",
          },
        })
      );

      assert.strictEqual(roastCapturedOpts[0]!.stepTimeoutMs, 0);
      assert.strictEqual(roastCapturedOpts[0]!.totalTimeoutMs, 0);
    });
  });

  describe("Roast: userId null/undefined -> notification skipped", () => {
    it("should skip notification when userId is empty string", async () => {
      await processRoast(makeRoastMessage({ userId: "" }), makeRoastDeps());

      assert.strictEqual(roastNotificationCalls.length, 0);
    });

    it("should create notification when userId is present", async () => {
      await processRoast(
        makeRoastMessage({ userId: "user-42" }),
        makeRoastDeps()
      );

      assert.strictEqual(roastNotificationCalls.length, 1);
      assert.strictEqual(roastNotificationCalls[0]!.userId, "user-42");
    });

    it("should skip failure notification when userId is empty on agent error", async () => {
      await processRoast(
        makeRoastMessage({ userId: "" }),
        makeRoastDeps({
          createAgent: () => ({
            run: async () => {
              throw new Error("Crash");
            },
          }),
        })
      );

      assert.strictEqual(roastNotificationCalls.length, 0);
    });

    it("should still update session on error even without userId", async () => {
      await processRoast(
        makeRoastMessage({ userId: "" }),
        makeRoastDeps({
          createAgent: () => ({
            run: async () => {
              throw new Error("Crash");
            },
          }),
        })
      );

      assert.strictEqual(roastSessionUpdates.length, 1);
      assert.strictEqual(roastSessionUpdates[0]!.data.status, "FAILED");
    });
  });
});
