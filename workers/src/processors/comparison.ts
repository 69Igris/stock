/**
 * Comparison Processor (MONEY-553)
 *
 * Runs a deep stock/MF comparison for a ComparisonSession:
 * 1. Loads the ComparisonSession (idempotency + cancellation guard)
 * 2. Runs the ResearchAgent with the comparison skill:
 *      kind === "mf"    → "mf-comparison"
 *      kind === "stock" → "multi-comparison"
 *    via a temporary ResearchSession (mirrors l3-analysis.ts)
 * 3. Streams progress into the ComparisonSession
 * 4. Writes the final structured result + COMPLETED (or FAILED + errorMessage)
 *
 * SEBI-safe: the underlying skills emit observations / scores / flags only —
 * never a buy/sell winner.
 *
 * Returns 200 to Pub/Sub on failure (handled internally) to prevent infinite
 * retries — same contract as roast.ts / l3-analysis.ts.
 */

import { prisma } from "@usemoney/database";
import type { ComparisonJobMessage } from "@usemoney/types";
import { ResearchAgent, getConfigForMode } from "@usemoney/research";
import { createNotification } from "../lib/notifications";
import { llmWorkflow } from "@usemoney/datadog/llmobs";

/** Max time for a comparison run (8 minutes, leaving buffer for Cloud Run's 10min limit). */
const COMPARISON_TIMEOUT_MS = 480_000;

/** Scrub a technical error before it lands in the DB / renders to the user. */
function sanitizeComparisonError(raw: string): string {
  if (!raw) return "An error occurred during the comparison. Please try again.";
  if (raw.includes("not listed on")) return raw;
  if (raw.includes("only supports")) return raw;
  if (/prisma|mongodb|database|connection|ECONN|getaddrinfo/i.test(raw))
    return "A temporary service error occurred. Please try again.";
  if (/api.*key|unauthorized|forbidden|401|403/i.test(raw))
    return "A service configuration error occurred. Please try again later.";
  if (/rate.?limit|429|too many requests|quota/i.test(raw))
    return "Service is temporarily busy. Please try again in a few minutes.";
  if (/gemini|vertex|google.*ai|model.*error/i.test(raw))
    return "AI analysis service encountered an error. Please try again.";
  if (/timeout|ETIMEDOUT|deadline/i.test(raw))
    return "Comparison took too long to complete. Please try again.";
  if (raw.length < 150 && !/error|exception|stack|trace|at\s/i.test(raw))
    return raw;
  return "Something went wrong during the comparison. Please try again.";
}

/**
 * Entry point for the `comparison-run` job. The body lives in `runComparisonJob`; this wrapper
 * exists only to tag every model call underneath it with
 * `ml_app: research` (MONEY-1380).
 *
 * Tagging here rather than at the call sites works because dd-trace resolves an
 * LLM span's `ml_app` from its nearest LLMObs parent, so calls several packages
 * deep inherit it without knowing this file exists.
 */
export async function processComparison(
  data: ComparisonJobMessage,
): Promise<void> {
  return llmWorkflow(
    "research",
    "comparison-run",
    () => runComparisonJob(data),
    { sessionId: data.sessionId },
  );
}

async function runComparisonJob(data: ComparisonJobMessage): Promise<void> {
  const { sessionId, userId, jobId, kind, depth, symbols, exchange, model } =
    data;

  // Guard against malformed messages.
  if (!sessionId) {
    console.error("[comparison] Received message without sessionId, skipping");
    return;
  }

  console.log(
    `[comparison] Starting ${kind} comparison (depth=${depth}) for session: ${sessionId}`,
  );

  try {
    // 1. Load the ComparisonSession.
    const session = await prisma.comparisonSession.findUnique({
      where: { sessionId },
      select: { status: true },
    });

    if (!session) {
      console.error(`[comparison] Session ${sessionId} not found`);
      return;
    }

    // 2. Idempotency / cancellation guard: skip stale re-deliveries.
    if (session.status === "COMPLETED" || session.status === "FAILED") {
      console.warn(
        `[comparison] Session ${sessionId} already ${session.status} - skipping re-delivery`,
      );
      return;
    }

    // 3. Mark PLANNING.
    await prisma.comparisonSession.update({
      where: { sessionId },
      data: {
        status: "PLANNING",
        progress: 5,
        currentStep: "Building comparison plan...",
      },
    });

    // 4. Select the comparison skill from `kind`.
    const skill = kind === "mf" ? "mf-comparison" : "multi-comparison";

    // The skills read `depth` from the query label; encode it so the depth
    // intent is preserved in the synthesized report header. The skill itself
    // defaults to a sensible enrichment level when depth is absent.
    const query =
      kind === "mf"
        ? `[MUTUAL_FUND] Compare funds ${symbols.join(" vs ")} (depth: ${depth})`
        : `Compare ${symbols.join(" vs ")} (depth: ${depth})`;

    // 5. Run the ResearchAgent against a temporary ResearchSession
    //    (mirrors l3-analysis.ts — the agent reads/writes a ResearchSession).
    const researchSessionId = `cmp-${sessionId}`;

    await prisma.researchSession.upsert({
      where: { sessionId: researchSessionId },
      update: {
        status: "PLANNING",
        progress: 0,
        query,
        symbols,
        skill,
      },
      create: {
        userId,
        sessionId: researchSessionId,
        query,
        status: "PLANNING",
        progress: 0,
        symbols,
        skill,
      },
    });

    await prisma.comparisonSession.update({
      where: { sessionId },
      data: {
        status: "RESEARCHING",
        progress: 15,
        currentStep: `Analyzing ${symbols.length} ${
          kind === "mf" ? "funds" : "stocks"
        }...`,
      },
    });

    const agent = new ResearchAgent(
      {
        ...getConfigForMode("advanced"),
        stepTimeoutMs: Math.floor(COMPARISON_TIMEOUT_MS / 3),
        totalTimeoutMs: COMPARISON_TIMEOUT_MS,
      },
      "advanced",
    );

    await agent.run({
      jobId: `${jobId}-cmp`,
      userId,
      sessionId: researchSessionId,
      query,
      skill,
      symbols,
      mode: "advanced",
      model,
    });

    // 6. Read the agent's output back.
    const research = await prisma.researchSession.findUnique({
      where: { sessionId: researchSessionId },
      select: {
        report: true,
        contentBlocks: true,
        status: true,
        errorMessage: true,
      },
    });

    if (research?.status === "FAILED") {
      const errMsg = sanitizeComparisonError(
        research.errorMessage || "Comparison analysis failed",
      );
      await prisma.comparisonSession.update({
        where: { sessionId },
        data: {
          status: "FAILED",
          errorMessage: errMsg,
          completedAt: new Date(),
        },
      });

      await createNotification({
        userId,
        type: "ANALYSIS_FAILED",
        title: "Comparison Failed",
        message: "Your comparison encountered an error. Please try again.",
        metadata: { sessionId },
      }).catch(() => {});

      console.error("[comparison] research agent FAILED", {
        sessionId,
        errMsg: research?.errorMessage ?? errMsg,
      });
      return;
    }

    // 7. Mark SYNTHESIZING then COMPLETED with the structured result.
    await prisma.comparisonSession.update({
      where: { sessionId },
      data: {
        status: "SYNTHESIZING",
        progress: 90,
        currentStep: "Assembling comparison...",
      },
    });

    await prisma.comparisonSession.update({
      where: { sessionId },
      data: {
        status: "COMPLETED",
        progress: 100,
        currentStep: null,
        result: {
          kind,
          depth,
          symbols,
          report: research?.report ?? null,
          contentBlocks: research?.contentBlocks ?? [],
          completedAt: new Date().toISOString(),
        },
        completedAt: new Date(),
      },
    });

    await createNotification({
      userId,
      type: "ANALYSIS_COMPLETE",
      title: "Comparison Complete",
      message: `Your comparison of ${symbols.join(", ")} is ready to view.`,
      metadata: {
        sessionId,
        link: `/compare/${sessionId}`,
      },
    });

    console.log(`[comparison] Session ${sessionId} COMPLETED`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(
      `[comparison] Unhandled error for session ${sessionId}:`,
      errorMsg,
    );

    const userFacing = sanitizeComparisonError(errorMsg);

    try {
      await prisma.comparisonSession.update({
        where: { sessionId },
        data: {
          status: "FAILED",
          errorMessage: userFacing,
          completedAt: new Date(),
        },
      });
    } catch (dbError) {
      console.error("[comparison] Failed to update session status:", dbError);
    }

    if (userId) {
      await createNotification({
        userId,
        type: "ANALYSIS_FAILED",
        title: "Comparison Failed",
        message: "Your comparison encountered an error. Please try again.",
        metadata: { sessionId },
      }).catch(() => {});
    }

    // Don't re-throw - the route returns 200 to Pub/Sub to prevent retries.
    void exchange; // reserved for future stock-exchange routing
  }
}
