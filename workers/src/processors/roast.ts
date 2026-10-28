/**
 * Roast Processor
 *
 * Instantiates and runs the RoastAgent for a given job.
 */

import prisma from "@usemoney/database";
import { RoastAgent, sanitizeRoastErrorMessage } from "@usemoney/roast";
import type { RoastJobMessage } from "@usemoney/types";
import { createNotification } from "../lib/notifications";
import {
  resolveRoastTimeouts,
  shouldNotifyRoast,
  buildRoastCompleteNotification,
} from "./roast-logic";
import { llmWorkflow } from "@usemoney/datadog/llmobs";

/**
 * Entry point for the `roast-run` job. The body lives in `runRoastJob`; this wrapper
 * exists only to tag every model call underneath it with
 * `ml_app: roast` (MONEY-1380).
 *
 * Tagging here rather than at the call sites works because dd-trace resolves an
 * LLM span's `ml_app` from its nearest LLMObs parent, so calls several packages
 * deep inherit it without knowing this file exists.
 */
export async function processRoast(data: RoastJobMessage): Promise<void> {
  return llmWorkflow("roast", "roast-run", () => runRoastJob(data), {
    sessionId: data.sessionId,
  });
}

async function runRoastJob(data: RoastJobMessage): Promise<void> {
  console.log(
    `[roast-processor] Starting roast for session: ${data.sessionId}`,
  );

  try {
    // Guarded against a misconfigured ROAST_*_TIMEOUT_MS parsing to NaN/0,
    // which would make the agent's setTimeout fire immediately (see
    // resolveRoastTimeouts).
    //
    // MONEY-1157: the two keys are picked out rather than handing over the whole
    // `process.env`. `resolveRoastTimeouts` declares a "weak" options type (all
    // properties optional) and `NodeJS.ProcessEnv` shares none of them by name,
    // so `tsc` rejected the call (TS2559) — `tsup`/esbuild never type-checks, so
    // it never blocked a build. Runtime is unchanged: `resolveRoastTimeouts`
    // reads exactly these two keys and nothing else, so it sees the same two
    // values it saw before. Picking them also keeps the helper's contract
    // honest — it documents precisely what env the roast agent depends on,
    // which an index signature would erase.
    const agent = new RoastAgent(
      resolveRoastTimeouts({
        ROAST_STEP_TIMEOUT_MS: process.env.ROAST_STEP_TIMEOUT_MS,
        ROAST_TOTAL_TIMEOUT_MS: process.env.ROAST_TOTAL_TIMEOUT_MS,
      }),
    );

    await agent.run(data);

    // Check whether the agent marked the session as FAILED internally
    const session = await prisma.portfolioRoast.findUnique({
      where: { sessionId: data.sessionId },
      select: { status: true },
    });

    if (session?.status === "FAILED") {
      console.warn(
        `[roast-processor] Agent completed but session is FAILED: ${data.sessionId}`,
      );
      if (data.userId) {
        await createNotification({
          userId: data.userId,
          type: "ROAST_COMPLETE",
          title: "Portfolio Roast Failed",
          message:
            "Your portfolio roast encountered an error. Please try again.",
          metadata: { sessionId: data.sessionId },
        }).catch(() => {});
      }
      return;
    }

    console.log(
      `[roast-processor] Roast completed for session: ${data.sessionId}`,
    );

    // Create success notification
    if (shouldNotifyRoast(data.userId)) {
      await createNotification(
        buildRoastCompleteNotification(data.userId, data.sessionId),
      );
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(
      `[roast-processor] Unhandled error for session ${data.sessionId}:`,
      errorMsg,
    );

    // MONEY-488: scrub the technical error before it lands in the DB —
    // it renders on the Past Roasts card and was previously surfacing raw
    // JSON parser exceptions, stack-trace fragments, fetch-failure strings,
    // etc. Same util as the agent's inner fail() path.
    const userFacing = sanitizeRoastErrorMessage(errorMsg);

    // Mark session as FAILED
    try {
      await prisma.portfolioRoast.update({
        where: { sessionId: data.sessionId },
        data: {
          status: "FAILED",
          errorMessage: userFacing,
          completedAt: new Date(),
        },
      });
    } catch (dbError) {
      console.error(
        "[roast-processor] Failed to update session status:",
        dbError,
      );
    }

    if (data.userId) {
      await createNotification({
        userId: data.userId,
        type: "ROAST_COMPLETE",
        title: "Portfolio Roast Failed",
        message: "Your portfolio roast encountered an error. Please try again.",
        metadata: { sessionId: data.sessionId },
      }).catch(() => {});
    }

    // Don't re-throw - return 200 to Pub/Sub to prevent infinite retries
  }
}
