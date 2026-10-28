/**
 * @usemoney/roast - Roast pipeline orchestration (pure, dependency-injected).
 *
 * This is the heart of {@link RoastAgent.run} extracted into a pure function so
 * it can be unit-tested without importing Prisma, the Gemini-backed step
 * modules, or the logger at module load. `RoastAgent.run` calls
 * {@link runRoastPipeline} wiring the real Prisma/step/logger dependencies; the
 * test wires mocked sinks + deterministic `nowFn`. Both execute the SAME
 * orchestration code — the 6-step sequence, per-step status/progress updates,
 * total-timeout guard, cooperative cancel checks, the cancelled-before-COMPLETED
 * race guard, and the sanitized-fail path.
 *
 * Steps:
 *   1. FETCHING_DATA    - portfolio query, no LLM
 *   2. ANALYZING_STOCKS - skipped when no holdings
 *   3. ANALYZING_MF     - skipped when no MFs
 *   4. SCORING
 *   5. GENERATING_ROAST - gets stepTimeoutMs + 30s and the narrative scope
 *   6. ASSEMBLING       - pure computation, no LLM
 */

import type { StructuredRoastResult } from "@usemoney/types";
import type {
  PortfolioData,
  StockAnalysisResult,
  MfAnalysisResult,
  ScoresResult,
  RoastContentResult,
  RoastAgentConfig,
  RoastJobMessage,
} from "./types";

/** Progress/step metadata for each pipeline phase, in execution order. */
export const ROAST_PIPELINE_STEPS = [
  { status: "FETCHING_DATA", progress: 5, currentStep: "Loading portfolio..." },
  {
    status: "ANALYZING_STOCKS",
    progress: 20,
    currentStep: "Analyzing stock holdings...",
  },
  {
    status: "ANALYZING_MF",
    progress: 40,
    currentStep: "Analyzing mutual funds...",
  },
  { status: "SCORING", progress: 58, currentStep: "Scoring your portfolio..." },
  {
    status: "GENERATING_ROAST",
    progress: 72,
    currentStep: "Writing the roast...",
  },
  { status: "ASSEMBLING", progress: 92, currentStep: "Assembling results..." },
] as const;

/** The status string each pipeline step reports. */
export type RoastPipelineStatus =
  (typeof ROAST_PIPELINE_STEPS)[number]["status"];

/**
 * Minimal logger surface the pipeline needs. Matches the shape of the shared
 * pino-style `geminiLogger` (object-first signature) without depending on it.
 */
export interface RoastPipelineLogger {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

/**
 * All side-effecting collaborators the pipeline needs. The production wiring
 * (in {@link RoastAgent.run}) backs `updateStatus`/`complete`/`fail`/`isCancelled`
 * with Prisma; tests back them with in-memory recorders.
 */
export interface RoastPipelineDeps {
  fetchPortfolio: (
    userId: string,
    mode: "overall" | "broker",
    broker: string | undefined,
    assetType: "stocks" | "mf" | "all",
    brokerUserId?: string,
    scope?: "PORTFOLIO" | "TRADEBOOK",
    dateFrom?: string,
    dateTo?: string,
    symbols?: string[],
  ) => Promise<PortfolioData>;
  analyzeStocks: (
    portfolio: PortfolioData,
    timeoutMs: number,
  ) => Promise<StockAnalysisResult>;
  analyzeMf: (
    portfolio: PortfolioData,
    timeoutMs: number,
  ) => Promise<MfAnalysisResult>;
  generateScores: (
    stockAnalysis: StockAnalysisResult | null,
    mfAnalysis: MfAnalysisResult | null,
    portfolio: PortfolioData,
    timeoutMs: number,
  ) => Promise<ScoresResult>;
  generateRoast: (
    stockAnalysis: StockAnalysisResult | null,
    mfAnalysis: MfAnalysisResult | null,
    scores: ScoresResult,
    portfolio: PortfolioData,
    timeoutMs: number,
    scope: "PORTFOLIO" | "TRADEBOOK",
  ) => Promise<RoastContentResult>;
  assembleResult: (
    scores: ScoresResult,
    roastContent: RoastContentResult,
    portfolio: PortfolioData,
  ) => StructuredRoastResult;
  /** Persist a step status/progress/currentStep transition. */
  updateStatus: (
    sessionId: string,
    status: RoastPipelineStatus,
    progress: number,
    currentStep: string,
  ) => Promise<void>;
  /** Mark the roast COMPLETED with its final score + result payload. */
  complete: (
    sessionId: string,
    score: number,
    result: StructuredRoastResult,
  ) => Promise<void>;
  /**
   * Mark the roast FAILED. `errorMessage` is the RAW message; the pipeline has
   * already passed it through `sanitizeError` before calling this, so this
   * collaborator only persists/truncates.
   */
  fail: (sessionId: string, errorMessage: string) => Promise<void>;
  /** True when the session was cancelled by the user (FAILED + sentinel). */
  isCancelled: (sessionId: string) => Promise<boolean>;
  /** Turn a raw technical error into stable user-facing copy. */
  sanitizeError: (raw: string) => string;
  logger: RoastPipelineLogger;
  /** Injectable clock for deterministic timeout tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Run the full roast pipeline. Never throws — every failure path routes to
 * `deps.fail` (with sanitized copy). Returns nothing; observable effects are
 * the `updateStatus`/`complete`/`fail` calls.
 */
export async function runRoastPipeline(
  job: RoastJobMessage,
  config: Required<RoastAgentConfig>,
  deps: RoastPipelineDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const startTime = now();

  const checkTimeout = (): void => {
    if (now() - startTime > config.totalTimeoutMs) {
      throw new Error(
        `Roast pipeline timed out after ${config.totalTimeoutMs}ms`,
      );
    }
  };

  const failCancelledIfNeeded = async (): Promise<boolean> => {
    if (await deps.isCancelled(job.sessionId)) {
      throw new Error("Cancelled by user");
    }
    return false;
  };

  deps.logger.info(
    { sessionId: job.sessionId, mode: job.mode },
    "RoastAgent starting",
  );

  try {
    // Step 1: Fetch portfolio data
    await deps.updateStatus(
      job.sessionId,
      "FETCHING_DATA",
      5,
      "Loading portfolio...",
    );
    const portfolio = await deps.fetchPortfolio(
      job.userId,
      job.mode,
      job.broker,
      job.assetType,
      job.brokerUserId,
      job.scope,
      job.dateFrom,
      job.dateTo,
      job.symbols,
    );

    // MONEY-837: a TRADEBOOK roast can have trades but no current holdings —
    // only bail when there is genuinely nothing (no holdings, MFs, AND trades).
    if (
      !portfolio.holdings.length &&
      !portfolio.mfs.length &&
      !portfolio.trades?.length
    ) {
      return await failWith(
        deps,
        job.sessionId,
        "No portfolio data found. Connect a broker and sync your data first.",
      );
    }

    checkTimeout();
    await failCancelledIfNeeded();

    // Step 2: Analyze stocks (skip if no holdings)
    await deps.updateStatus(
      job.sessionId,
      "ANALYZING_STOCKS",
      20,
      "Analyzing stock holdings...",
    );
    const stockAnalysis =
      portfolio.holdings.length > 0
        ? await deps.analyzeStocks(portfolio, config.stepTimeoutMs)
        : null;

    checkTimeout();
    await failCancelledIfNeeded();

    // Step 3: Analyze mutual funds (skip if no MFs)
    await deps.updateStatus(
      job.sessionId,
      "ANALYZING_MF",
      40,
      "Analyzing mutual funds...",
    );
    const mfAnalysis =
      portfolio.mfs.length > 0
        ? await deps.analyzeMf(portfolio, config.stepTimeoutMs)
        : null;

    checkTimeout();
    await failCancelledIfNeeded();

    // Step 4: Generate scores
    await deps.updateStatus(
      job.sessionId,
      "SCORING",
      58,
      "Scoring your portfolio...",
    );
    const scores = await deps.generateScores(
      stockAnalysis,
      mfAnalysis,
      portfolio,
      config.stepTimeoutMs,
    );

    checkTimeout();
    await failCancelledIfNeeded();

    // Step 5: Generate roast content
    await deps.updateStatus(
      job.sessionId,
      "GENERATING_ROAST",
      72,
      "Writing the roast...",
    );
    const roastContent = await deps.generateRoast(
      stockAnalysis,
      mfAnalysis,
      scores,
      portfolio,
      config.stepTimeoutMs + 30000,
      job.scope ?? "PORTFOLIO",
    );

    checkTimeout();
    await failCancelledIfNeeded();

    // Step 6: Assemble final result
    await deps.updateStatus(
      job.sessionId,
      "ASSEMBLING",
      92,
      "Assembling results...",
    );
    const result = deps.assembleResult(scores, roastContent, portfolio);

    // Check if cancelled before marking completed (last-moment race guard).
    if (await deps.isCancelled(job.sessionId)) {
      deps.logger.info(
        { sessionId: job.sessionId },
        "Roast was cancelled by user - skipping COMPLETED update",
      );
      return;
    }

    await deps.complete(job.sessionId, result.overallScore, result);

    deps.logger.info(
      {
        sessionId: job.sessionId,
        score: result.overallScore,
        elapsedMs: now() - startTime,
      },
      "RoastAgent completed successfully",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    deps.logger.error(
      {
        sessionId: job.sessionId,
        error: msg,
        stack,
        errorName: error instanceof Error ? error.constructor.name : undefined,
      },
      "RoastAgent failed",
    );
    await failWith(deps, job.sessionId, msg);
  }
}

/** Sanitize then persist a failure. Centralizes the MONEY-488 sanitize gate. */
async function failWith(
  deps: RoastPipelineDeps,
  sessionId: string,
  rawMessage: string,
): Promise<void> {
  await deps.fail(sessionId, deps.sanitizeError(rawMessage));
}
