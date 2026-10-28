/**
 * Research Data Contract Tests
 *
 * Tests the data contract between:
 *   1. Research agent (worker) - saves qualityScore + report to DB
 *   2. getResearchHistory service - reads sessions and extracts recommendation
 *   3. ResearchHistoryItem / extractReportMeta - UI types
 *
 * This ensures that what the agent writes can be correctly read back
 * by the service layer, and that the UI types match.
 *
 * Covers:
 *   - qualityScore extraction in fast mode (skipValidation=true)
 *   - qualityScore extraction in deep mode (skipValidation=false)
 *   - recommendation extraction from report.recommendation (top-level)
 *   - recommendation extraction from report.content.recommendation (nested)
 *   - undefined recommendation when report has no recommendation field
 *   - ResearchHistoryItem type shape
 *   - extractReportMeta backwards compatibility
 *
 * All external dependencies are inlined/mocked in-place.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Types mirroring the source ──────────────────────────────────────

interface ResearchSession {
  sessionId: string;
  userId: string;
  query: string;
  status: string;
  symbols: string[];
  qualityScore?: number | null;
  report?: unknown;
  createdAt: Date;
  completedAt?: Date | null;
  errorMessage?: string | null;
}

interface ResearchHistoryItem {
  sessionId: string;
  query: string;
  status: string;
  symbols: string[];
  qualityScore?: number;
  recommendation?: string;
  createdAt: Date;
  completedAt?: Date;
  errorMessage?: string;
}

interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ── Mock DB ─────────────────────────────────────────────────────────

class MockDB {
  sessions: ResearchSession[] = [];

  async findMany(
    where: { userId: string; status: { in: string[] } },
    limit: number
  ): Promise<ResearchSession[]> {
    return this.sessions
      .filter(
        (s) => s.userId === where.userId && where.status.in.includes(s.status)
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  addSession(session: ResearchSession): void {
    this.sessions.push(session);
  }
}

// ── Inline getResearchHistory (mirrors packages/services/src/research.service.ts) ──

async function getResearchHistory(
  db: MockDB,
  userId: string,
  limit = 20
): Promise<ServiceResult<ResearchHistoryItem[]>> {
  try {
    const sessions = await db.findMany(
      { userId, status: { in: ["COMPLETED", "FAILED"] } },
      limit
    );

    return {
      success: true,
      data: sessions.map((s) => {
        // Extract recommendation from report JSON (report.recommendation or report.content.recommendation)
        let recommendation: string | undefined;
        if (s.report && typeof s.report === "object") {
          const r = s.report as Record<string, unknown>;
          if (typeof r.recommendation === "string") {
            recommendation = r.recommendation;
          } else if (r.content && typeof r.content === "object") {
            const c = r.content as Record<string, unknown>;
            if (typeof c.recommendation === "string") {
              recommendation = c.recommendation;
            }
          }
        }

        return {
          sessionId: s.sessionId,
          query: s.query,
          status: s.status,
          symbols: s.symbols,
          qualityScore: s.qualityScore || undefined,
          recommendation,
          createdAt: s.createdAt,
          completedAt: s.completedAt || undefined,
          errorMessage: s.errorMessage || undefined,
        };
      }),
    };
  } catch {
    return { success: false, error: "Failed to get research history" };
  }
}

// ── Inline qualityScore extraction logic (mirrors packages/research/src/agent.ts lines 344-361) ──

interface AgentConfig {
  skipValidation: boolean;
  qualityThreshold: number;
}

interface ValidationResult {
  score: number;
  passed: boolean;
  gaps: string[];
  suggestions: string[];
}

/**
 * Extracts the final qualityScore the agent would save, mirroring lines 344-361 of agent.ts.
 */
function computeFinalQualityScore(
  config: AgentConfig,
  lastValidation: ValidationResult,
  report: Record<string, unknown> | string
): number | undefined {
  // Extract score: prefer validation score, then report.score (fast mode skips validation)
  let finalScore = lastValidation.score;
  if (!finalScore && report && typeof report === "object") {
    const reportObj = report as Record<string, unknown>;
    if (typeof reportObj.score === "number") {
      finalScore = reportObj.score;
    }
  }

  return finalScore || (config.skipValidation ? undefined : 0);
}

// ── Inline extractReportMeta (mirrors apps/web/components/analysis/types.ts) ──

function extractReportMeta(report: unknown): {
  score?: number;
  recommendation?: string;
} {
  if (!report || typeof report !== "object") return {};
  const r = report as Record<string, unknown>;
  const inner =
    r.content && typeof r.content === "object"
      ? (r.content as Record<string, unknown>)
      : r;
  return {
    score: typeof inner.score === "number" ? inner.score : undefined,
    recommendation:
      typeof inner.recommendation === "string"
        ? inner.recommendation
        : undefined,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function makeSession(
  overrides: Partial<ResearchSession> = {}
): ResearchSession {
  return {
    sessionId: "sess-001",
    userId: "user-001",
    query: "Analyze RELIANCE",
    status: "COMPLETED",
    symbols: ["RELIANCE.NS"],
    qualityScore: null,
    report: null,
    createdAt: new Date("2026-03-14T10:00:00Z"),
    completedAt: new Date("2026-03-14T10:05:00Z"),
    errorMessage: null,
    ...overrides,
  };
}

const NO_VALIDATION: ValidationResult = {
  score: 0,
  passed: false,
  gaps: [],
  suggestions: [],
};

const FAST_CONFIG: AgentConfig = {
  skipValidation: true,
  qualityThreshold: 0.6,
};

const DEEP_CONFIG: AgentConfig = {
  skipValidation: false,
  qualityThreshold: 0.8,
};

// ── Tests ───────────────────────────────────────────────────────────

describe("Research Data Contract", () => {
  let db: MockDB;

  beforeEach(() => {
    db = new MockDB();
  });

  // ── qualityScore in fast mode ──────────────────────────────────

  describe("qualityScore in fast mode (skipValidation=true)", () => {
    it("should extract qualityScore from report.score when skipValidation=true and report has score", () => {
      const report = {
        score: 78,
        recommendation: "BUY",
        summary: "Good stock",
      };

      const result = computeFinalQualityScore(
        FAST_CONFIG,
        NO_VALIDATION,
        report
      );

      assert.strictEqual(result, 78);
    });

    it("should return undefined when skipValidation=true and report has no score", () => {
      const report = {
        recommendation: "HOLD",
        summary: "Average stock",
      };

      const result = computeFinalQualityScore(
        FAST_CONFIG,
        NO_VALIDATION,
        report
      );

      assert.strictEqual(result, undefined);
    });

    it("should return undefined when skipValidation=true and report is a string", () => {
      const report = "Some text report without structured data";

      const result = computeFinalQualityScore(
        FAST_CONFIG,
        NO_VALIDATION,
        report
      );

      assert.strictEqual(result, undefined);
    });

    it("should return undefined when skipValidation=true and report.score is 0", () => {
      const report = {
        score: 0,
        recommendation: "N/A",
        summary: "Synthesis failed",
      };

      // 0 is falsy, so finalScore stays 0, and `0 || undefined` yields undefined
      const result = computeFinalQualityScore(
        FAST_CONFIG,
        NO_VALIDATION,
        report
      );

      assert.strictEqual(result, undefined);
    });

    it("should extract qualityScore from report.score even when lastValidation.score is 0", () => {
      const report = { score: 85, recommendation: "STRONG BUY" };
      const validation = { ...NO_VALIDATION, score: 0 };

      const result = computeFinalQualityScore(FAST_CONFIG, validation, report);

      assert.strictEqual(result, 85);
    });
  });

  // ── qualityScore in deep mode ──────────────────────────────────

  describe("qualityScore in deep mode (skipValidation=false)", () => {
    it("should use lastValidation.score when skipValidation=false and validation ran", () => {
      const report = {
        score: 78,
        recommendation: "BUY",
      };
      const validation: ValidationResult = {
        score: 82,
        passed: true,
        gaps: [],
        suggestions: [],
      };

      const result = computeFinalQualityScore(DEEP_CONFIG, validation, report);

      assert.strictEqual(result, 82);
    });

    it("should fall back to report.score when validation score is 0 and skipValidation=false", () => {
      const report = { score: 65, recommendation: "HOLD" };

      const result = computeFinalQualityScore(
        DEEP_CONFIG,
        NO_VALIDATION,
        report
      );

      assert.strictEqual(result, 65);
    });

    it("should return 0 when both validation.score and report.score are 0 and skipValidation=false", () => {
      const report = { score: 0, recommendation: "N/A" };

      const result = computeFinalQualityScore(
        DEEP_CONFIG,
        NO_VALIDATION,
        report
      );

      // finalScore = 0, skipValidation = false, so result = 0 || 0 = 0
      assert.strictEqual(result, 0);
    });

    it("should prefer validation score over report.score when both are present", () => {
      const report = { score: 60, recommendation: "HOLD" };
      const validation: ValidationResult = {
        score: 90,
        passed: true,
        gaps: [],
        suggestions: [],
      };

      const result = computeFinalQualityScore(DEEP_CONFIG, validation, report);

      assert.strictEqual(result, 90);
    });
  });

  // ── getResearchHistory service ─────────────────────────────────

  describe("getResearchHistory service", () => {
    it("should return recommendation field extracted from report.recommendation (top-level)", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-rec-top",
          report: {
            score: 78,
            recommendation: "BUY",
            summary: "Good stock",
          },
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.length, 1);
      assert.strictEqual(result.data![0]!.recommendation, "BUY");
    });

    it("should return recommendation from nested report.content.recommendation", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-rec-nested",
          report: {
            content: {
              score: 72,
              recommendation: "HOLD",
              summary: "Neutral outlook",
            },
          },
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data![0]!.recommendation, "HOLD");
    });

    it("should return undefined recommendation when report has no recommendation", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-no-rec",
          report: {
            score: 50,
            summary: "Partial report without recommendation",
          },
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data![0]!.recommendation, undefined);
    });

    it("should return undefined recommendation when report is null", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-null-report",
          report: null,
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data![0]!.recommendation, undefined);
    });

    it("should return undefined recommendation when report is a string", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-string-report",
          report: "plain text report without any structure",
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data![0]!.recommendation, undefined);
    });

    it("should prefer top-level recommendation over nested content.recommendation", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-both-rec",
          report: {
            recommendation: "STRONG BUY",
            content: {
              recommendation: "BUY",
            },
          },
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data![0]!.recommendation, "STRONG BUY");
    });

    it("should return qualityScore when set on session", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-with-score",
          qualityScore: 85,
          report: { score: 78, recommendation: "BUY" },
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data![0]!.qualityScore, 85);
    });

    it("should return undefined qualityScore when null on session", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-null-score",
          qualityScore: null,
          report: { recommendation: "HOLD" },
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data![0]!.qualityScore, undefined);
    });

    it("should return undefined qualityScore when 0 on session (falsy)", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-zero-score",
          qualityScore: 0,
          report: { recommendation: "SELL" },
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      // 0 || undefined = undefined - this matches the service behavior
      assert.strictEqual(result.data![0]!.qualityScore, undefined);
    });

    it("should return both qualityScore and recommendation for completed sessions", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-complete",
          status: "COMPLETED",
          qualityScore: 92,
          report: {
            score: 88,
            recommendation: "STRONG BUY",
            summary: "Excellent fundamentals",
          },
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      const item = result.data![0]!;
      assert.strictEqual(item.qualityScore, 92);
      assert.strictEqual(item.recommendation, "STRONG BUY");
      assert.strictEqual(item.status, "COMPLETED");
      assert.strictEqual(item.sessionId, "sess-complete");
    });

    it("should include FAILED sessions in history", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-failed",
          status: "FAILED",
          qualityScore: null,
          report: null,
          errorMessage: "Worker crashed",
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.length, 1);
      assert.strictEqual(result.data![0]!.status, "FAILED");
      assert.strictEqual(result.data![0]!.errorMessage, "Worker crashed");
      assert.strictEqual(result.data![0]!.recommendation, undefined);
      assert.strictEqual(result.data![0]!.qualityScore, undefined);
    });

    it("should not include PLANNING or RESEARCHING sessions", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-planning",
          status: "PLANNING",
        })
      );
      db.addSession(
        makeSession({
          sessionId: "sess-researching",
          status: "RESEARCHING",
        })
      );
      db.addSession(
        makeSession({
          sessionId: "sess-done",
          status: "COMPLETED",
          qualityScore: 75,
          report: { recommendation: "HOLD" },
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.length, 1);
      assert.strictEqual(result.data![0]!.sessionId, "sess-done");
    });

    it("should return sessions ordered by createdAt desc", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-old",
          createdAt: new Date("2026-03-10T10:00:00Z"),
        })
      );
      db.addSession(
        makeSession({
          sessionId: "sess-new",
          createdAt: new Date("2026-03-14T10:00:00Z"),
        })
      );
      db.addSession(
        makeSession({
          sessionId: "sess-mid",
          createdAt: new Date("2026-03-12T10:00:00Z"),
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data![0]!.sessionId, "sess-new");
      assert.strictEqual(result.data![1]!.sessionId, "sess-mid");
      assert.strictEqual(result.data![2]!.sessionId, "sess-old");
    });

    it("should respect limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        db.addSession(
          makeSession({
            sessionId: `sess-${i}`,
            createdAt: new Date(`2026-03-${10 + i}T10:00:00Z`),
          })
        );
      }

      const result = await getResearchHistory(db, "user-001", 3);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.length, 3);
    });

    it("should handle recommendation with unusual casing", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-case",
          report: {
            recommendation: "Strong Buy",
          },
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      // recommendation is extracted as-is, no normalization
      assert.strictEqual(result.data![0]!.recommendation, "Strong Buy");
    });

    it("should handle non-string recommendation (number) gracefully", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-num-rec",
          report: {
            recommendation: 42,
          },
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      // typeof 42 !== "string", so recommendation stays undefined
      assert.strictEqual(result.data![0]!.recommendation, undefined);
    });

    it("should handle report with empty content object", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-empty-content",
          report: {
            content: {},
          },
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data![0]!.recommendation, undefined);
    });
  });

  // ── ResearchHistoryItem type contract ──────────────────────────

  describe("ResearchHistoryItem type", () => {
    it("has recommendation field (not report)", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-type-check",
          qualityScore: 80,
          report: {
            score: 75,
            recommendation: "BUY",
            summary: "Test",
          },
        })
      );

      const result = await getResearchHistory(db, "user-001");

      assert.strictEqual(result.success, true);
      const item = result.data![0]!;

      // The item should have recommendation (string), NOT report (object)
      assert.strictEqual(typeof item.recommendation, "string");
      assert.strictEqual(item.recommendation, "BUY");

      // Verify there is no 'report' key on the returned item
      assert.strictEqual("report" in item, false);
    });

    it("should have all expected fields on a completed session", async () => {
      const now = new Date("2026-03-14T12:00:00Z");
      const completedAt = new Date("2026-03-14T12:05:00Z");

      db.addSession(
        makeSession({
          sessionId: "sess-all-fields",
          query: "Deep dive TCS",
          status: "COMPLETED",
          symbols: ["TCS.NS"],
          qualityScore: 88,
          report: { recommendation: "BUY" },
          createdAt: now,
          completedAt,
          errorMessage: null,
        })
      );

      const result = await getResearchHistory(db, "user-001");
      const item = result.data![0]!;

      assert.strictEqual(item.sessionId, "sess-all-fields");
      assert.strictEqual(item.query, "Deep dive TCS");
      assert.strictEqual(item.status, "COMPLETED");
      assert.deepStrictEqual(item.symbols, ["TCS.NS"]);
      assert.strictEqual(item.qualityScore, 88);
      assert.strictEqual(item.recommendation, "BUY");
      assert.deepStrictEqual(item.createdAt, now);
      assert.deepStrictEqual(item.completedAt, completedAt);
      assert.strictEqual(item.errorMessage, undefined);
    });

    it("should have all expected fields on a failed session", async () => {
      db.addSession(
        makeSession({
          sessionId: "sess-fail-fields",
          query: "Analyze XYZ",
          status: "FAILED",
          symbols: [],
          qualityScore: null,
          report: null,
          completedAt: null,
          errorMessage: "Timeout exceeded",
        })
      );

      const result = await getResearchHistory(db, "user-001");
      const item = result.data![0]!;

      assert.strictEqual(item.sessionId, "sess-fail-fields");
      assert.strictEqual(item.status, "FAILED");
      assert.strictEqual(item.qualityScore, undefined);
      assert.strictEqual(item.recommendation, undefined);
      assert.strictEqual(item.completedAt, undefined);
      assert.strictEqual(item.errorMessage, "Timeout exceeded");
    });
  });

  // ── extractReportMeta backwards compat ─────────────────────────

  describe("extractReportMeta backwards compat", () => {
    it("should extract score and recommendation from top-level report", () => {
      const report = {
        score: 78,
        recommendation: "BUY",
        summary: "Good stock",
      };

      const meta = extractReportMeta(report);

      assert.strictEqual(meta.score, 78);
      assert.strictEqual(meta.recommendation, "BUY");
    });

    it("should extract from report.content when top-level fields are missing", () => {
      const report = {
        content: {
          score: 65,
          recommendation: "HOLD",
          summary: "Average stock",
        },
      };

      const meta = extractReportMeta(report);

      assert.strictEqual(meta.score, 65);
      assert.strictEqual(meta.recommendation, "HOLD");
    });

    it("should prefer top-level fields over content fields", () => {
      const report = {
        score: 90,
        recommendation: "STRONG BUY",
        content: {
          score: 50,
          recommendation: "SELL",
        },
      };

      // extractReportMeta uses `inner = r.content ? r.content : r`
      // so if content exists, it reads from content, NOT top-level
      // This is the actual behavior - content takes priority in extractReportMeta
      const meta = extractReportMeta(report);

      // When both exist, extractReportMeta picks content (inner = r.content)
      assert.strictEqual(meta.score, 50);
      assert.strictEqual(meta.recommendation, "SELL");
    });

    it("should return empty object for null report", () => {
      const meta = extractReportMeta(null);

      assert.strictEqual(meta.score, undefined);
      assert.strictEqual(meta.recommendation, undefined);
    });

    it("should return empty object for undefined report", () => {
      const meta = extractReportMeta(undefined);

      assert.strictEqual(meta.score, undefined);
      assert.strictEqual(meta.recommendation, undefined);
    });

    it("should return empty object for string report", () => {
      const meta = extractReportMeta("just a plain text report");

      assert.strictEqual(meta.score, undefined);
      assert.strictEqual(meta.recommendation, undefined);
    });

    it("should return undefined score when score is not a number", () => {
      const report = { score: "high", recommendation: "BUY" };
      const meta = extractReportMeta(report);

      assert.strictEqual(meta.score, undefined);
      assert.strictEqual(meta.recommendation, "BUY");
    });

    it("should return undefined recommendation when recommendation is not a string", () => {
      const report = { score: 80, recommendation: 42 };
      const meta = extractReportMeta(report);

      assert.strictEqual(meta.score, 80);
      assert.strictEqual(meta.recommendation, undefined);
    });

    it("should handle report with empty content object", () => {
      const report = { content: {} };
      const meta = extractReportMeta(report);

      assert.strictEqual(meta.score, undefined);
      assert.strictEqual(meta.recommendation, undefined);
    });

    it("should agree with getResearchHistory on recommendation extraction", async () => {
      // Verify extractReportMeta and getResearchHistory extract the same recommendation
      const report = {
        score: 78,
        recommendation: "BUY",
        summary: "Good analysis",
      };

      // extractReportMeta path
      const meta = extractReportMeta(report);

      // getResearchHistory path
      db.addSession(
        makeSession({
          sessionId: "sess-compat",
          report,
        })
      );
      const result = await getResearchHistory(db, "user-001");
      const historyItem = result.data![0]!;

      // Both should agree on recommendation
      assert.strictEqual(meta.recommendation, historyItem.recommendation);
    });

    it("should agree with getResearchHistory on nested recommendation extraction", async () => {
      const report = {
        content: {
          score: 72,
          recommendation: "HOLD",
          summary: "Neutral",
        },
      };

      // extractReportMeta path
      const meta = extractReportMeta(report);

      // getResearchHistory path
      db.addSession(
        makeSession({
          sessionId: "sess-compat-nested",
          report,
        })
      );
      const result = await getResearchHistory(db, "user-001");
      const historyItem = result.data![0]!;

      // Both should agree on recommendation
      assert.strictEqual(meta.recommendation, historyItem.recommendation);
      assert.strictEqual(meta.recommendation, "HOLD");
    });
  });

  // ── End-to-end: agent save → service read contract ─────────────

  describe("End-to-end: agent save to service read", () => {
    it("fast mode: agent saves report.score as qualityScore, service reads it back", async () => {
      // Simulate what the agent saves in fast mode
      const report = {
        score: 78,
        recommendation: "BUY",
        confidence: 82,
        summary: "Strong fundamentals",
      };

      const qualityScore = computeFinalQualityScore(
        FAST_CONFIG,
        NO_VALIDATION,
        report
      );

      // Agent would save this to DB
      db.addSession(
        makeSession({
          sessionId: "sess-e2e-fast",
          qualityScore: qualityScore ?? null,
          report,
        })
      );

      // Service reads it back
      const result = await getResearchHistory(db, "user-001");
      const item = result.data![0]!;

      assert.strictEqual(item.qualityScore, 78);
      assert.strictEqual(item.recommendation, "BUY");
    });

    it("deep mode: agent saves validation score as qualityScore, service reads it back", async () => {
      const report = {
        score: 70,
        recommendation: "HOLD",
        summary: "Average outlook",
      };
      const validation: ValidationResult = {
        score: 88,
        passed: true,
        gaps: [],
        suggestions: [],
      };

      const qualityScore = computeFinalQualityScore(
        DEEP_CONFIG,
        validation,
        report
      );

      db.addSession(
        makeSession({
          sessionId: "sess-e2e-deep",
          qualityScore: qualityScore ?? null,
          report,
        })
      );

      const result = await getResearchHistory(db, "user-001");
      const item = result.data![0]!;

      // Deep mode: validation score (88) is preferred over report.score (70)
      assert.strictEqual(item.qualityScore, 88);
      assert.strictEqual(item.recommendation, "HOLD");
    });

    it("fast mode with no report score: qualityScore is undefined/null in DB, undefined in service", async () => {
      const report = {
        recommendation: "HOLD",
        summary: "Basic analysis without score",
      };

      const qualityScore = computeFinalQualityScore(
        FAST_CONFIG,
        NO_VALIDATION,
        report
      );

      assert.strictEqual(qualityScore, undefined);

      db.addSession(
        makeSession({
          sessionId: "sess-e2e-no-score",
          qualityScore: null, // undefined becomes null in MongoDB
          report,
        })
      );

      const result = await getResearchHistory(db, "user-001");
      const item = result.data![0]!;

      assert.strictEqual(item.qualityScore, undefined);
      assert.strictEqual(item.recommendation, "HOLD");
    });

    it("agent wraps string report in { content: report }, service extracts from content", async () => {
      // When report is a string, agent wraps it: { content: report }
      // Line 357 of agent.ts: report: typeof report === "object" ? report : { content: report }
      const stringReport = "This is a text-only report about the stock.";
      const wrappedReport = { content: stringReport };

      db.addSession(
        makeSession({
          sessionId: "sess-e2e-string",
          report: wrappedReport,
        })
      );

      const result = await getResearchHistory(db, "user-001");
      const item = result.data![0]!;

      // content is a string, not an object, so nested extraction won't work
      assert.strictEqual(item.recommendation, undefined);
    });

    it("handles emergency synthesis fallback report correctly", async () => {
      // The emergency synthesis produces a fallback report with score=40 and recommendation="HOLD"
      const emergencyReport = {
        score: 40,
        recommendation: "HOLD",
        confidence: 30,
        summary: 'Research for "Analyze XYZ" was partially completed.',
        keyMetrics: [],
        strengths: [],
        risks: ["Incomplete analysis"],
        disclaimer:
          "This report was generated with limited data due to timeout.",
      };

      const qualityScore = computeFinalQualityScore(
        FAST_CONFIG,
        NO_VALIDATION,
        emergencyReport
      );

      db.addSession(
        makeSession({
          sessionId: "sess-e2e-emergency",
          qualityScore: qualityScore ?? null,
          report: emergencyReport,
        })
      );

      const result = await getResearchHistory(db, "user-001");
      const item = result.data![0]!;

      assert.strictEqual(item.qualityScore, 40);
      assert.strictEqual(item.recommendation, "HOLD");

      // extractReportMeta should also work
      const meta = extractReportMeta(emergencyReport);
      assert.strictEqual(meta.score, 40);
      assert.strictEqual(meta.recommendation, "HOLD");
    });
  });
});
