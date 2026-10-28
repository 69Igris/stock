"use server";

/**
 * L3 Comprehensive Analysis Server Actions
 *
 * Handles starting, polling, and cancelling comprehensive analyses.
 */

import { getAuthenticatedUser } from "@/lib/auth";
import type { ActionResponse } from "@usemoney/validation";
import { prisma } from "@usemoney/database";
import { randomUUID } from "crypto";
import {
  estimateAnalysisCost,
  consumeCredits,
  refundCredits,
  preferences as preferencesService,
  type AnalysisType,
} from "@usemoney/services";
import { resolveResearchModel } from "@usemoney/core/gemini/model-registry";
import { publishL3AnalysisJob } from "@usemoney/pubsub/publish";

// ── Types ──────────────────────────────────────────────────────────

interface AnalysisStartResult {
  sessionId: string;
  estimatedMinutes: number;
  creditsReserved: number;
  totalSegments: number;
}

interface AnalysisStatusResult {
  status: string;
  progress: number;
  currentSegment: number;
  totalSegments: number;
  segments: unknown[];
  errorMessage?: string;
}

interface AnalysisResultData {
  sessionId: string;
  report: unknown;
  contentBlocks: unknown[];
  symbols: string[];
  creditsUsed: number;
  completedAt?: string;
}

// ── Segment Definitions ────────────────────────────────────────────

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

// L4 Full Research - 12 segments (Phase 11A)
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
    // MONEY-613: dedicated skill that fetches promoter holding/pledging +
    // related-party + corp actions and runs compute_governance_flags (was
    // stock-analysis, which never produced a governance signal).
    skill: "shareholding-analysis",
  },
  {
    id: "risk",
    name: "Risk Assessment (VaR, Drawdown, Beta)",
    // MONEY-613: single-stock risk skill (was portfolio-risk-analysis, which is
    // holdings-scoped and produced irrelevant output for a single subject stock).
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

// ── Start Comprehensive Analysis ───────────────────────────────────

export async function startComprehensiveAnalysisAction(data: {
  analysisType: string;
  symbols?: string[];
  query: string;
}): Promise<ActionResponse<AnalysisStartResult>> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const analysisType = data.analysisType as AnalysisType;

  // Check for existing running analysis (1 concurrent per user)
  const running = await prisma.analysisSession.count({
    where: {
      userId: authUser.userId,
      status: { in: ["QUEUED", "SEGMENT_RUNNING", "SYNTHESIZING"] },
    },
  });

  if (running > 0) {
    return {
      success: false,
      error:
        "You already have a comprehensive analysis in progress. Please wait for it to complete.",
    };
  }

  // MONEY-619 (Phase 3) - resolve the tier-appropriate research model from
  // the user's real plan + composer pick. Persisted on the AnalysisSession
  // (below) so every chained segment + the executive synthesis re-read it,
  // and forwarded on the first job message. FREE → gemini-2.5-pro; PRO/PREMIUM
  // → the tier Pro model (gemini-3.1-pro-preview, else degrades to
  // gemini-2.5-pro). Unknown ids fall back inside the worker.
  const composerPrefs = await preferencesService.getComposerPreferences(
    authUser.userId
  );
  const subscription = await prisma.subscription.findUnique({
    where: { userId: authUser.userId },
    select: { planId: true },
  });
  const model = resolveResearchModel(
    subscription?.planId ?? "FREE",
    composerPrefs.model
  );

  // Estimate cost
  const estimate = estimateAnalysisCost(analysisType, data.symbols);

  // Consume credits from unified credit pool (same as chat)
  const creditResult = await consumeCredits(
    authUser.userId,
    "l3_comprehensive",
    {
      query: `L3 ${analysisType} analysis: ${(data.symbols || []).join(", ")}`,
      tier: "L3",
      symbols: data.symbols,
    }
  );
  if (!creditResult.success) {
    return {
      success: false,
      error:
        creditResult.error ||
        `Not enough credits. You need ${estimate.credits} but have 0 remaining.`,
    };
  }

  const isL4 = analysisType === "l4_comprehensive";
  const sessionId = `${isL4 ? "l4" : "l3"}-${randomUUID()}`;

  // Build segment list based on analysis type
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

  // Create AnalysisSession
  await prisma.analysisSession.create({
    data: {
      userId: authUser.userId,
      sessionId,
      analysisType,
      query: data.query,
      symbols: data.symbols || [],
      // MONEY-619: persist the tier model so every segment + synthesis re-read it.
      model,
      segments,
      currentSegment: 0,
      totalSegments: segments.length,
      creditsReserved: estimate.credits,
      status: "QUEUED",
      progress: 0,
    },
  });

  // Publish first segment to L3 analysis topic
  try {
    await publishL3AnalysisJob({
      jobId: `l3-seg-0-${randomUUID()}`,
      userId: authUser.userId,
      sessionId,
      segmentIndex: 0,
      model,
    });
  } catch (error) {
    // If publish fails, mark session as failed and refund
    await prisma.analysisSession.update({
      where: { sessionId },
      data: {
        status: "FAILED",
        errorMessage: "Failed to start analysis pipeline",
      },
    });
    await refundCredits(authUser.userId, "l3_comprehensive");
    return {
      success: false,
      error: "Failed to start analysis. Credits have been refunded.",
    };
  }

  return {
    success: true,
    data: {
      sessionId,
      estimatedMinutes: estimate.estimatedMinutes,
      creditsReserved: estimate.credits,
      totalSegments: segments.length,
    },
  };
}

// ── Get Analysis Status ────────────────────────────────────────────

export async function getAnalysisStatusAction(
  sessionId: string
): Promise<ActionResponse<AnalysisStatusResult>> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const session = await prisma.analysisSession.findUnique({
    where: { sessionId },
    select: {
      userId: true,
      status: true,
      progress: true,
      currentSegment: true,
      totalSegments: true,
      segments: true,
      errorMessage: true,
    },
  });

  if (!session || session.userId !== authUser.userId) {
    return { success: false, error: "Analysis session not found" };
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
}

// ── Get Analysis Result ────────────────────────────────────────────

export async function getAnalysisResultAction(
  sessionId: string
): Promise<ActionResponse<AnalysisResultData>> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const session = await prisma.analysisSession.findUnique({
    where: { sessionId },
  });

  if (!session || session.userId !== authUser.userId) {
    return { success: false, error: "Analysis session not found" };
  }

  if (session.status !== "COMPLETED") {
    return {
      success: false,
      error: `Analysis is not complete yet. Current status: ${session.status}`,
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
}

// ── Cancel Analysis ────────────────────────────────────────────────

export async function cancelAnalysisAction(
  sessionId: string
): Promise<ActionResponse<{ refunded: number }>> {
  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const session = await prisma.analysisSession.findUnique({
    where: { sessionId },
  });

  if (!session || session.userId !== authUser.userId) {
    return { success: false, error: "Analysis session not found" };
  }

  if (session.status === "COMPLETED" || session.status === "CANCELLED") {
    return {
      success: false,
      error: `Cannot cancel analysis in ${session.status} status`,
    };
  }

  // Mark as cancelled
  await prisma.analysisSession.update({
    where: { sessionId },
    data: { status: "CANCELLED" },
  });

  // Refund credits via unified system
  const refundResult = await refundCredits(authUser.userId, "l3_comprehensive");
  const refunded = refundResult.success ? 1 : 0;

  return { success: true, data: { refunded } };
}
