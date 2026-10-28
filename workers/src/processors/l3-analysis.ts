/**
 * L3 Comprehensive Analysis Processor
 *
 * Processes a single segment of an L3 analysis session:
 * 1. Loads the AnalysisSession and segment config
 * 2. Runs the ResearchAgent with the segment's skill
 * 3. Stores intermediate results in Redis
 * 4. Chains to the next segment (or synthesizes for the final one)
 * 5. On failure, refunds credits and marks session as FAILED
 */

import { prisma, Prisma } from "@usemoney/database";
import type { L3AnalysisMessage } from "@usemoney/types";
import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types";
import {
  ResearchAgent,
  getConfigForMode,
  getResearchModel,
} from "@usemoney/research";
import { generateWithTimeout } from "@usemoney/core/gemini";
import { commitCredits, refundReservationCredits } from "@usemoney/services";
import { createNotification } from "../lib/notifications";
import { getPubSubClient } from "@usemoney/pubsub/client";
import { computeSegmentProgress } from "./l3-analysis-logic";
import { randomUUID } from "crypto";
import { llmWorkflow } from "@usemoney/datadog/llmobs";

/** Max time per segment (8 minutes, leaving buffer for Cloud Run's 10min limit) */
const SEGMENT_TIMEOUT_MS = 480_000;

interface SegmentConfig {
  id: string;
  name: string;
  skill: string;
  status: string;
  progress: number;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * Synthesize the completed L3/L4 segments into a plain-English executive summary
 * of the data (MONEY-259). Informational only — the prompt forbids any
 * buy/sell/hold/target language (SEBI). Returns the summary text.
 */
async function synthesizeSegments(
  query: string,
  symbols: string[],
  segments: Array<{ segmentName?: string; report?: unknown }>,
  modelId: string | undefined,
): Promise<string> {
  const parts = segments
    .filter((s) => s.report)
    .map(
      (s) =>
        `## ${s.segmentName ?? "Segment"}\n${
          typeof s.report === "string" ? s.report : JSON.stringify(s.report)
        }`,
    )
    .join("\n\n");

  if (!parts.trim()) {
    return "Executive summary unavailable — no completed segments to synthesize.";
  }

  const prompt = [
    "You are writing the EXECUTIVE SUMMARY of a comprehensive equity research report.",
    `Subject: ${symbols.join(", ") || query}.`,
    "Below are the completed analysis segments. Synthesize them into a concise,",
    "plain-English executive summary of WHAT THE DATA SHOWS — the key facts,",
    "strengths, risks and notable figures across the segments.",
    "",
    "STRICT RULES:",
    "- Informational only. NO recommendations: never say buy/sell/hold, never give a",
    "  price target, never advise an action. Describe the data, not a verdict.",
    "- 4–7 short paragraphs / bullet groups. Cite concrete numbers from the segments.",
    "- Do NOT invent any figure that is not present in the segments below.",
    "- Plain English a retail investor can follow.",
    "",
    "SEGMENTS:",
    parts,
  ].join("\n");

  // MONEY-619 (Phase 3): synthesize the executive summary on the tier model
  // (was hard-coded "fast"/2.5-flash, so a paid comprehensive run's premium
  // bought nothing for the synthesis). getResearchModel degrades unknown /
  // env-gated ids to the advanced default.
  const model = getResearchModel(modelId);
  const text = await generateWithTimeout(model, prompt, 60_000, 1);
  return text.trim();
}

/**
 * Entry point for the `l3-segment` job (MONEY-1380).
 *
 * The cleanup cron is handled HERE, outside the workflow span, on purpose: the
 * scheduler sends `{"cleanup":true}` on every tick, that path makes no model
 * call, and wrapping it would plant an empty `analysis` workflow in LLM
 * Observability on a schedule — noise that looks like real traffic in every
 * per-feature count.
 */
export async function processL3Segment(
  data: L3AnalysisMessage & { cleanup?: boolean },
): Promise<void> {
  // Handle cleanup cron messages (scheduler sends {"cleanup":true})
  if ((data as unknown as Record<string, unknown>).cleanup) {
    await cleanupExpiredReservations();
    return;
  }

  return llmWorkflow("analysis", "l3-segment", () => runL3Segment(data), {
    sessionId: data.sessionId,
  });
}

async function runL3Segment(
  data: L3AnalysisMessage & { cleanup?: boolean },
): Promise<void> {
  const { sessionId, segmentIndex, reservationId, userId, jobId } = data;

  // Guard against malformed messages (e.g., missing sessionId)
  if (!sessionId) {
    console.error("[l3-analysis] Received message without sessionId, skipping");
    return;
  }

  try {
    // 1. Load AnalysisSession
    const session = await prisma.analysisSession.findUnique({
      where: { sessionId },
    });

    if (!session) {
      console.error(`[l3-analysis] Session ${sessionId} not found`);
      return;
    }

    // MONEY-619 (Phase 3): the tier-resolved research model for this whole
    // comprehensive run. Persisted on the session at creation so every
    // chained segment + the executive synthesis use the same model; the
    // message's `data.model` is a fast-path fallback for older rows. Unknown
    // / env-gated ids degrade to the advanced default downstream.
    const segmentModel =
      (session as { model?: string | null }).model ?? data.model ?? undefined;

    // 2. Idempotency check: if segment already completed, skip
    const segments = session.segments as unknown as SegmentConfig[];
    const currentSeg = segments[segmentIndex];
    if (!currentSeg) {
      console.error(
        `[l3-analysis] Segment ${segmentIndex} not found in session ${sessionId}`,
      );
      return;
    }
    if (currentSeg.status === "completed") {
      console.log(
        `[l3-analysis] Segment ${segmentIndex} already completed, skipping`,
      );
      return;
    }

    // 3. Check cancellation
    if (session.status === "CANCELLED") {
      console.log(`[l3-analysis] Session ${sessionId} was cancelled`);
      return;
    }

    // 4. Update session: mark segment as running
    currentSeg.status = "running";
    currentSeg.startedAt = new Date().toISOString();
    // Guarded against a 0 / non-finite totalSegments writing "NaN" to
    // AnalysisSession.progress (see computeSegmentProgress).
    const progressPercent = computeSegmentProgress(
      segmentIndex,
      session.totalSegments,
    );

    await prisma.analysisSession.update({
      where: { sessionId },
      data: {
        currentSegment: segmentIndex,
        status: "SEGMENT_RUNNING",
        progress: progressPercent,
        segments: segments as unknown as Prisma.InputJsonValue[],
      },
    });

    // 5. Run ResearchAgent for this segment
    const isSynthesis = currentSeg.skill === "synthesis";
    let segmentResult: unknown = null;

    if (!isSynthesis) {
      // Create a temporary research session for this segment
      const segSessionId = `l3-seg-${sessionId}-${segmentIndex}`;

      await prisma.researchSession.create({
        data: {
          userId,
          sessionId: segSessionId,
          query: `${currentSeg.name}: ${session.query}`,
          status: "PLANNING",
          progress: 0,
          symbols: session.symbols,
          skill: currentSeg.skill,
        },
      });

      try {
        const agent = new ResearchAgent(
          {
            ...getConfigForMode("advanced"),
            stepTimeoutMs: Math.floor(SEGMENT_TIMEOUT_MS / 3),
            totalTimeoutMs: SEGMENT_TIMEOUT_MS,
          },
          "advanced",
        );

        await agent.run({
          jobId: `${jobId}-seg`,
          userId,
          sessionId: segSessionId,
          query: `${currentSeg.name}: ${session.query}`,
          skill: currentSeg.skill,
          symbols: session.symbols,
          mode: "advanced",
          // MONEY-619: run the segment's research on the tier model.
          model: segmentModel,
        });

        // Read the result from the research session
        const researchResult = await prisma.researchSession.findUnique({
          where: { sessionId: segSessionId },
          select: { report: true, contentBlocks: true, status: true },
        });

        segmentResult = {
          segmentId: currentSeg.id,
          segmentName: currentSeg.name,
          report: researchResult?.report,
          contentBlocks: researchResult?.contentBlocks,
          status: researchResult?.status,
        };
      } catch (error) {
        console.error(
          `[l3-analysis] Segment ${segmentIndex} (${currentSeg.name}) agent failed:`,
          error,
        );
        segmentResult = {
          segmentId: currentSeg.id,
          segmentName: currentSeg.name,
          report: null,
          error: error instanceof Error ? error.message : String(error),
          status: "FAILED",
        };
      }
    } else {
      // Synthesis (MONEY-259): gather all prior segment reports and produce a
      // plain-English executive summary of the data — no recommendations. This
      // was a no-op, which left the "comprehensive" tier with no verdict.
      const priorBlocks = (session.contentBlocks as unknown[]).filter(
        (b): b is { segmentName?: string; report?: unknown } =>
          !!b &&
          typeof b === "object" &&
          "report" in b &&
          !!(b as { report?: unknown }).report,
      );
      let synthesisReport: string;
      try {
        synthesisReport = await synthesizeSegments(
          session.query,
          session.symbols,
          priorBlocks,
          segmentModel,
        );
      } catch (error) {
        console.error("[l3-analysis] synthesis failed:", error);
        synthesisReport =
          "Executive summary could not be generated; see the individual segments above for the full analysis.";
      }
      segmentResult = {
        segmentId: currentSeg.id,
        segmentName: currentSeg.name,
        isSynthesis: true,
        report: synthesisReport,
      };
    }

    // 6. Update segment as completed
    currentSeg.status = "completed";
    currentSeg.completedAt = new Date().toISOString();
    currentSeg.progress = 100;

    // Store segment result in contentBlocks
    const updatedBlocks = [
      ...(session.contentBlocks as unknown[]),
      segmentResult,
    ];
    const newProgress = Math.round(
      ((segmentIndex + 1) / session.totalSegments) * 100,
    );

    await prisma.analysisSession.update({
      where: { sessionId },
      data: {
        segments: segments as unknown as Prisma.InputJsonValue[],
        contentBlocks: updatedBlocks as unknown as Prisma.InputJsonValue[],
        progress: newProgress,
      },
    });

    // 7. Chain to next segment or finalize
    if (segmentIndex < session.totalSegments - 1) {
      // Publish next segment via workers' Pub/Sub client
      const pubsub = getPubSubClient();
      const topic = pubsub.topic(getTopicName(PUBSUB_TOPICS.L3_ANALYSIS));
      await topic.publishMessage({
        json: {
          jobId: `l3-seg-${segmentIndex + 1}-${randomUUID()}`,
          userId,
          sessionId,
          reservationId,
          segmentIndex: segmentIndex + 1,
          // MONEY-619: carry the tier model forward on the chain message.
          model: segmentModel,
        },
      });
    } else {
      // Final segment: mark as completed
      await prisma.analysisSession.update({
        where: { sessionId },
        data: {
          status: "COMPLETED",
          progress: 100,
          completedAt: new Date(),
          creditsUsed: session.creditsReserved,
          report: {
            segments: updatedBlocks,
            completedAt: new Date().toISOString(),
          } as unknown as Prisma.InputJsonValue,
        },
      });

      // Commit credits
      if (reservationId) await commitCredits(reservationId);

      // Create success notification
      await createNotification({
        userId,
        type: "ANALYSIS_COMPLETE",
        title: "Comprehensive Analysis Complete",
        message: `Your analysis of ${session.symbols.join(", ")} is ready to view.`,
        metadata: {
          sessionId,
          link: `/analysis/${sessionId}`,
        },
      });

      console.log(`[l3-analysis] Session ${sessionId} COMPLETED`);
    }
  } catch (error) {
    console.error(
      `[l3-analysis] Fatal error in segment ${segmentIndex} for session ${sessionId}:`,
      error,
    );

    // Mark session as failed
    try {
      await prisma.analysisSession.update({
        where: { sessionId },
        data: {
          status: "FAILED",
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
        },
      });

      // Refund credits - look up totalSegments from DB since session may not be in scope
      if (reservationId) {
        const failedSession = await prisma.analysisSession.findUnique({
          where: { sessionId },
          select: { totalSegments: true },
        });
        await refundReservationCredits(
          reservationId,
          segmentIndex,
          failedSession?.totalSegments ?? 6,
        );
      }

      // Create failure notification
      await createNotification({
        userId,
        type: "ANALYSIS_FAILED",
        title: "Analysis Failed",
        message:
          "Your comprehensive analysis encountered an error. Credits have been partially refunded.",
        metadata: { sessionId },
      });
    } catch (cleanupError) {
      console.error(
        "[l3-analysis] Cleanup after failure also failed:",
        cleanupError,
      );
    }
  }
}

/**
 * Cleanup expired credit reservations.
 * Called every 15 min via Cloud Scheduler → {"cleanup":true}.
 * Finds QUEUED/IN_PROGRESS sessions older than 30 min and marks them FAILED.
 */
async function cleanupExpiredReservations(): Promise<void> {
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);

  const stale = await prisma.analysisSession.findMany({
    where: {
      status: { in: ["QUEUED", "SEGMENT_RUNNING"] },
      createdAt: { lt: thirtyMinAgo },
    },
    select: {
      sessionId: true,
      userId: true,
      reservationId: true,
      creditsReserved: true,
      currentSegment: true,
      totalSegments: true,
    },
  });

  if (stale.length === 0) {
    console.log("[l3-analysis] Cleanup: no stale sessions");
    return;
  }

  console.log(`[l3-analysis] Cleanup: found ${stale.length} stale sessions`);

  for (const session of stale) {
    try {
      await prisma.analysisSession.update({
        where: { sessionId: session.sessionId },
        data: {
          status: "FAILED",
          errorMessage: "Session timed out (no progress for 30 minutes)",
        },
      });

      if (session.reservationId) {
        await refundReservationCredits(
          session.reservationId,
          session.currentSegment,
          session.totalSegments,
        );
      }

      console.log(
        `[l3-analysis] Cleanup: marked ${session.sessionId} as FAILED, refunded credits`,
      );
    } catch (err) {
      console.error(
        `[l3-analysis] Cleanup failed for ${session.sessionId}:`,
        err,
      );
    }
  }
}
