/**
 * Analysis Service (MONEY-1062 P2b)
 *
 * L3/L4 comprehensive-analysis lifecycle (start, status, result, cancel) for the
 * async segment pipeline. NEW service file — no existing service touched the
 * `AnalysisSession` model (the web action drove Prisma directly).
 *
 * Source: apps/web/lib/actions/analysis.ts
 *   :128 startComprehensiveAnalysisAction, :268 getAnalysisStatusAction,
 *   :308 getAnalysisResultAction, :346 cancelAnalysisAction.
 *
 * Credit + publish (mirror analysis.ts, G3-safe):
 *   consumeCredits (from the unified pool, the GATE) → create the AnalysisSession
 *   → publishL3AnalysisJob(segment 0); on publish failure mark the session FAILED
 *   and refund (exactly the action's leg, analysis.ts:239-253).
 *
 * IDOR-safe: status/result/cancel scope the lookup to `{ sessionId, userId }`
 * (findFirst) so a guessed sessionId from another account resolves as "not
 * found" — tightened from the web action's findUnique-then-compare.
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import { randomUUID } from "node:crypto";
import type { L3AnalysisMessage } from "@usemoney/types";
import type { ServiceResult } from "./types";
import { resolveResearchModel as defaultResolveResearchModel } from "@usemoney/core/gemini/model-registry";
import { publishL3AnalysisJob as defaultPublishL3AnalysisJob } from "@usemoney/pubsub/publish";
import {
  estimateAnalysisCost as defaultEstimateAnalysisCost,
  type AnalysisType,
  type CostEstimate,
} from "./credit-reservation.service";
import {
  consumeCredits as defaultConsumeCredits,
  refundCredits as defaultRefundCredits,
} from "./credit.service";
import { getComposerPreferences as defaultGetComposerPreferences } from "./preferences/composer-preferences";

// ── Types ──────────────────────────────────────────────────────────

export interface StartAnalysisInput {
  analysisType: string;
  symbols?: string[];
  query: string;
}

export interface AnalysisStartResult {
  sessionId: string;
  estimatedMinutes: number;
  creditsReserved: number;
  totalSegments: number;
}

export interface AnalysisStatusView {
  status: string;
  progress: number;
  currentSegment: number;
  totalSegments: number;
  segments: unknown[];
  errorMessage?: string;
}

export interface AnalysisResultView {
  sessionId: string;
  report: unknown;
  contentBlocks: unknown[];
  symbols: string[];
  creditsUsed: number;
  completedAt?: string;
}

// ── Segment Definitions (copied from analysis.ts:52-124) ────────────

const COMPREHENSIVE_STOCK_SEGMENTS = [
  { id: "business", name: "Business Analysis", skill: "stock-analysis" },
  {
    id: "financials",
    name: "Financial Deep Dive",
    skill: "financial-deep-dive",
  },
  { id: "valuation", name: "Valuation (DCF + Comps)", skill: "dcf-valuation" },
  { id: "peers", name: "Industry & Peers", skill: "peer-comparison" },
  { id: "risk_tech", name: "Risk & Technical", skill: "strategy-analysis" },
  { id: "synthesis", name: "Executive Summary", skill: "synthesis" },
];

const L4_COMPREHENSIVE_SEGMENTS = [
  { id: "business", name: "Business Analysis", skill: "stock-analysis" },
  {
    id: "financials_10yr",
    name: "Financial Deep Dive (10Y)",
    skill: "financial-deep-dive",
  },
  {
    id: "revenue_mix",
    name: "Market Share & Revenue Mix",
    skill: "stock-analysis",
  },
  {
    id: "valuation_full",
    name: "Valuation - DCF + Comps + Reverse DCF",
    skill: "dcf-valuation",
  },
  {
    id: "peers_v2",
    name: "Peer Comparison v2 (20+ metrics)",
    skill: "peer-comparison",
  },
  {
    id: "sector_context",
    name: "Sector Context & Rotation",
    skill: "sector-deep-dive",
  },
  {
    id: "technical_patterns",
    name: "Technical + Chart/Candlestick Patterns",
    skill: "strategy-analysis",
  },
  { id: "macro", name: "Macro Environment & Impact", skill: "macro-analysis" },
  {
    id: "shareholding",
    name: "Shareholding & Institutional Activity",
    skill: "shareholding-analysis",
  },
  {
    id: "risk",
    name: "Risk Assessment (VaR, Drawdown, Beta)",
    skill: "stock-risk-analysis",
  },
  {
    id: "forward_scenarios",
    name: "Forward Scenario Analysis",
    skill: "stock-analysis",
  },
  {
    id: "synthesis_l4",
    name: "Executive Synthesis with RAG Cross-Reference",
    skill: "synthesis",
  },
];

// ── Start ──────────────────────────────────────────────────────────

/**
 * Injectable IO seam for {@link startComprehensiveAnalysis}. Defaults to the
 * shared prisma / pubsub / credit implementations; the service tests inject
 * fakes to assert the concurrent-guard, the consume → create → publish ordering,
 * and the publish-failure refund leg on the REAL function.
 */
export interface StartAnalysisDeps {
  prisma?: typeof prisma;
  publishL3AnalysisJob?: (msg: L3AnalysisMessage) => Promise<string>;
  consumeCredits?: typeof defaultConsumeCredits;
  refundCredits?: typeof defaultRefundCredits;
  getComposerPreferences?: (
    userId: string,
  ) => Promise<{ model?: string | null }>;
  resolveResearchModel?: (planId: string, userPick?: string | null) => string;
  estimateAnalysisCost?: (
    analysisType: AnalysisType,
    symbols?: string[],
  ) => CostEstimate;
}

export async function startComprehensiveAnalysis(
  userId: string,
  input: StartAnalysisInput,
  deps: StartAnalysisDeps = {},
): Promise<ServiceResult<AnalysisStartResult>> {
  const db = deps.prisma ?? prisma;
  const publish = deps.publishL3AnalysisJob ?? defaultPublishL3AnalysisJob;
  const consume = deps.consumeCredits ?? defaultConsumeCredits;
  const refund = deps.refundCredits ?? defaultRefundCredits;
  const composerPrefsOf =
    deps.getComposerPreferences ?? defaultGetComposerPreferences;
  const resolveModel = deps.resolveResearchModel ?? defaultResolveResearchModel;
  const estimate = deps.estimateAnalysisCost ?? defaultEstimateAnalysisCost;

  const analysisType = input.analysisType as AnalysisType;

  try {
    // ── One concurrent comprehensive analysis per user (analysis.ts:141-154) ──
    const running = await db.analysisSession.count({
      where: {
        userId,
        status: { in: ["QUEUED", "SEGMENT_RUNNING", "SYNTHESIZING"] },
      },
    });
    if (running > 0) {
      return {
        success: false,
        error:
          "You already have a comprehensive analysis in progress. Please wait for it to complete.",
        code: "CONFLICT",
      };
    }

    // ── Tier-resolved research model (analysis.ts:162-172) ────────────
    const composerPrefs = await composerPrefsOf(userId);
    const subscription = await db.subscription.findUnique({
      where: { userId },
      select: { planId: true },
    });
    const model = resolveModel(
      subscription?.planId ?? "FREE",
      composerPrefs.model,
    );

    const costEstimate = estimate(analysisType, input.symbols);

    // ── Consume from the unified pool — the GATE (analysis.ts:178-194) ──
    const creditResult = await consume(userId, "l3_comprehensive", {
      query: `L3 ${analysisType} analysis: ${(input.symbols || []).join(", ")}`,
      tier: "L3",
      symbols: input.symbols,
    });
    if (!creditResult.success) {
      return {
        success: false,
        error:
          creditResult.error ||
          `Not enough credits. You need ${costEstimate.credits} but have 0 remaining.`,
        code:
          creditResult.code === "INSUFFICIENT_CREDITS"
            ? "NO_CREDITS"
            : "INTERNAL",
      };
    }

    const isL4 = analysisType === "l4_comprehensive";
    const sessionId = `${isL4 ? "l4" : "l3"}-${randomUUID()}`;

    const segmentDefs = isL4
      ? L4_COMPREHENSIVE_SEGMENTS
      : COMPREHENSIVE_STOCK_SEGMENTS;
    const segments = segmentDefs.map((s) => ({
      ...s,
      status: "pending",
      progress: 0,
      startedAt: null,
      completedAt: null,
    }));

    // ── Create the AnalysisSession (analysis.ts:212-228) ──────────────
    await db.analysisSession.create({
      data: {
        userId,
        sessionId,
        analysisType,
        query: input.query,
        symbols: input.symbols || [],
        model,
        segments,
        currentSegment: 0,
        totalSegments: segments.length,
        creditsReserved: costEstimate.credits,
        status: "QUEUED",
        progress: 0,
      },
    });

    // ── Publish segment 0; on failure mark FAILED + refund (analysis.ts:231-253) ──
    try {
      await publish({
        jobId: `l3-seg-0-${randomUUID()}`,
        userId,
        sessionId,
        segmentIndex: 0,
        model,
      });
    } catch (error) {
      await db.analysisSession.update({
        where: { sessionId },
        data: {
          status: "FAILED",
          errorMessage: "Failed to start analysis pipeline",
        },
      });
      await refund(userId, "l3_comprehensive");
      return {
        success: false,
        error: "Failed to start analysis. Credits have been refunded.",
        code: "INTERNAL",
      };
    }

    return {
      success: true,
      data: {
        sessionId,
        estimatedMinutes: costEstimate.estimatedMinutes,
        creditsReserved: costEstimate.credits,
        totalSegments: segments.length,
      },
    };
  } catch (error) {
    logger.error(
      { error, userId },
      "Start comprehensive analysis service error",
    );
    return {
      success: false,
      error: "Failed to start analysis",
      code: "INTERNAL",
    };
  }
}

// ── Status ─────────────────────────────────────────────────────────

export interface AnalysisReadDeps {
  prisma?: typeof prisma;
}

export async function getAnalysisStatus(
  userId: string,
  sessionId: string,
  deps: AnalysisReadDeps = {},
): Promise<ServiceResult<AnalysisStatusView>> {
  const db = deps.prisma ?? prisma;
  try {
    // IDOR-safe: scope to the owner (tightens analysis.ts:276-291's
    // findUnique-then-compare into a single owner-scoped read).
    const session = await db.analysisSession.findFirst({
      where: { sessionId, userId },
      select: {
        status: true,
        progress: true,
        currentSegment: true,
        totalSegments: true,
        segments: true,
        errorMessage: true,
      },
    });

    if (!session) {
      return {
        success: false,
        error: "Analysis session not found",
        code: "NOT_FOUND",
      };
    }

    return {
      success: true,
      data: {
        status: session.status,
        progress: session.progress,
        currentSegment: session.currentSegment,
        totalSegments: session.totalSegments,
        segments: session.segments as unknown[],
        errorMessage: session.errorMessage ?? undefined,
      },
    };
  } catch (error) {
    logger.error({ error, sessionId }, "Get analysis status service error");
    return {
      success: false,
      error: "Failed to get analysis status",
      code: "INTERNAL",
    };
  }
}

// ── Result ─────────────────────────────────────────────────────────

export async function getAnalysisResult(
  userId: string,
  sessionId: string,
  deps: AnalysisReadDeps = {},
): Promise<ServiceResult<AnalysisResultView>> {
  const db = deps.prisma ?? prisma;
  try {
    const session = await db.analysisSession.findFirst({
      where: { sessionId, userId },
    });

    if (!session) {
      return {
        success: false,
        error: "Analysis session not found",
        code: "NOT_FOUND",
      };
    }

    if (session.status !== "COMPLETED") {
      // Exists but not ready — the client should keep polling status.
      return {
        success: false,
        error: `Analysis is not complete yet. Current status: ${session.status}`,
        code: "CONFLICT",
      };
    }

    return {
      success: true,
      data: {
        sessionId: session.sessionId,
        report: session.report,
        contentBlocks: session.contentBlocks as unknown[],
        symbols: session.symbols,
        creditsUsed: session.creditsUsed,
        completedAt: session.completedAt?.toISOString(),
      },
    };
  } catch (error) {
    logger.error({ error, sessionId }, "Get analysis result service error");
    return {
      success: false,
      error: "Failed to get analysis result",
      code: "INTERNAL",
    };
  }
}

// ── Cancel ─────────────────────────────────────────────────────────

export interface CancelAnalysisDeps {
  prisma?: typeof prisma;
  refundCredits?: typeof defaultRefundCredits;
}

export async function cancelAnalysis(
  userId: string,
  sessionId: string,
  deps: CancelAnalysisDeps = {},
): Promise<ServiceResult<{ refunded: number }>> {
  const db = deps.prisma ?? prisma;
  const refund = deps.refundCredits ?? defaultRefundCredits;
  try {
    const session = await db.analysisSession.findFirst({
      where: { sessionId, userId },
      select: { status: true },
    });

    if (!session) {
      return {
        success: false,
        error: "Analysis session not found",
        code: "NOT_FOUND",
      };
    }

    if (session.status === "COMPLETED" || session.status === "CANCELLED") {
      return {
        success: false,
        error: `Cannot cancel analysis in ${session.status} status`,
        code: "CONFLICT",
      };
    }

    // Mark cancelled (mirror analysis.ts:370-373).
    await db.analysisSession.update({
      where: { sessionId },
      data: { status: "CANCELLED" },
    });

    // Refund via the unified system (mirror analysis.ts:376-377).
    const refundResult = await refund(userId, "l3_comprehensive");
    const refunded = refundResult.success ? 1 : 0;

    return { success: true, data: { refunded } };
  } catch (error) {
    logger.error({ error, sessionId }, "Cancel analysis service error");
    return {
      success: false,
      error: "Failed to cancel analysis",
      code: "INTERNAL",
    };
  }
}
