/**
 * @usemoney/roast - RoastAgent
 *
 * Main orchestrator for the multi-step portfolio roast pipeline.
 * Steps:
 *   1. FETCHING_DATA    - Prisma query, no LLM
 *   2. ANALYZING_STOCKS - Gemini 3 Pro + JSON mode
 *   3. ANALYZING_MF     - Gemini 3 Pro + JSON mode
 *   4. SCORING          - Gemini 3 Pro + JSON mode
 *   5. GENERATING_ROAST - Gemini 3 Pro + higher temp
 *   6. ASSEMBLING       - Pure computation, no LLM
 */

import { prisma } from "@usemoney/database";
import type { Prisma } from "@prisma/client";
import { geminiLogger as logger } from "@usemoney/logger";
import { logAiDecision } from "@usemoney/core/analytics";
import { captureRoastSignal } from "@usemoney/core/investor/capture";
import { fetchPortfolio } from "./steps/fetch-portfolio";
import { analyzeStocks } from "./steps/analyze-stocks";
import { analyzeMf } from "./steps/analyze-mf";
import { generateScores } from "./steps/generate-scores";
import { generateRoast } from "./steps/generate-roast";
import { assembleResult } from "./steps/assemble-result";
import { sanitizeRoastErrorMessage } from "./lib/parse-llm-json";
import { runRoastPipeline, type RoastPipelineDeps } from "./agent-pipeline";
import type { RoastAgentConfig, RoastJobMessage } from "./types";

const CANCELLED_BY_USER = "Cancelled by user";

// The roast pipeline runs entirely on Gemini 2.5 Pro (see
// steps/generate-roast.ts + steps/generate-scores.ts). Recorded on the audit
// log so reviewers know which model produced the verdict.
const ROAST_MODEL_ID = "gemini-2.5-pro";

export class RoastAgent {
  private config: Required<RoastAgentConfig>;

  constructor(config: RoastAgentConfig = {}) {
    this.config = {
      stepTimeoutMs: config.stepTimeoutMs ?? 60000,
      totalTimeoutMs: config.totalTimeoutMs ?? 300000,
    };
  }

  /**
   * Build the Prisma/Gemini-backed dependency bundle the pure pipeline runs
   * against. Kept as a method so the orchestration in `agent-pipeline.ts` is
   * unit-testable with mocked deps while production wires the real ones.
   */
  private buildDeps(job: RoastJobMessage): RoastPipelineDeps {
    return {
      fetchPortfolio,
      analyzeStocks,
      analyzeMf,
      generateScores,
      generateRoast,
      assembleResult,
      sanitizeError: sanitizeRoastErrorMessage,
      logger,
      updateStatus: async (sessionId, status, progress, currentStep) => {
        await prisma.portfolioRoast.update({
          where: { sessionId },
          data: { status, progress, currentStep },
        });
        logger.info(
          { sessionId, status, progress, currentStep },
          "Roast step update",
        );
      },
      complete: async (sessionId, score, result) => {
        await prisma.portfolioRoast.update({
          where: { sessionId },
          data: {
            status: "COMPLETED",
            progress: 100,
            currentStep: "Done!",
            score,
            result: result as unknown as Prisma.InputJsonValue,
            completedAt: new Date(),
          },
        });

        // MONEY-786: durable AI decision audit log (best-effort, never throws).
        void logAiDecision({
          decisionType: "ROAST",
          userId: job.userId,
          model: ROAST_MODEL_ID,
          provider: "GOOGLE",
          input: {
            mode: job.mode,
            assetType: job.assetType,
            broker: job.broker,
          },
          output: {
            score,
            stockCount: result.topPerformers.length,
            mfCount: result.sectorAnalysis.length,
          },
          rationale:
            result.roastNarrative?.slice(0, 500) ??
            `Portfolio roast scored ${score}`,
          qualityScore: score,
          outcome: "COMPLETED",
          sessionId,
        }).catch(() => {});

        // MONEY-788 (B3): behaviour-signal capture — nudge the roast concept
        // set + append a `roast_completed` UserEvent. Best-effort, never
        // throws. Only on the complete path (not `fail` below).
        void captureRoastSignal({
          userId: job.userId,
          sessionId,
          score,
        }).catch(() => {});
      },
      fail: async (sessionId, errorMessage) => {
        // `errorMessage` is already sanitized by the pipeline (MONEY-488); this
        // sink only persists + truncates. On a stalled-session race the update
        // can throw — swallow it (logged) so a failed roast never crashes the
        // worker.
        try {
          await prisma.portfolioRoast.update({
            where: { sessionId },
            data: {
              status: "FAILED",
              errorMessage: errorMessage.slice(0, 500),
              completedAt: new Date(),
            },
          });
        } catch (updateError) {
          logger.error(
            { sessionId, updateError },
            "Failed to update roast status to FAILED",
          );
        }

        // MONEY-786: durable AI decision audit log for the failed roast.
        void logAiDecision({
          decisionType: "ROAST",
          userId: job.userId,
          model: ROAST_MODEL_ID,
          provider: "GOOGLE",
          input: {
            mode: job.mode,
            assetType: job.assetType,
            broker: job.broker,
          },
          output: { error: errorMessage.slice(0, 500) },
          rationale: `Portfolio roast failed: ${errorMessage.slice(0, 200)}`,
          outcome: "FAILED",
          sessionId,
        }).catch(() => {});
      },
      isCancelled: async (sessionId) => {
        const session = await prisma.portfolioRoast.findUnique({
          where: { sessionId },
          select: { status: true, errorMessage: true },
        });
        return (
          session?.status === "FAILED" &&
          session.errorMessage === CANCELLED_BY_USER
        );
      },
    };
  }

  async run(job: RoastJobMessage): Promise<void> {
    await runRoastPipeline(job, this.config, this.buildDeps(job));
  }
}
