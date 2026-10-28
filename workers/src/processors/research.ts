/**
 * Research Processor
 *
 * Instantiates and runs the ResearchAgent for a given job.
 */

import prisma from "@usemoney/database";
import { ResearchAgent, getConfigForMode } from "@usemoney/research";
import type { ResearchJobMessage } from "@usemoney/types";
import { createNotification } from "../lib/notifications";
import {
  resolveResearchMode,
  toAgentResearchMode,
  parseEnvInt,
  computeResearchHardCeiling,
  shouldNotifyResearch,
  buildResearchCompleteNotification,
} from "./research-logic";
import { llmWorkflow } from "@usemoney/datadog/llmobs";

/**
 * Entry point for the `research-run` job. The body lives in `runResearchJob`; this wrapper
 * exists only to tag every model call underneath it with
 * `ml_app: research` (MONEY-1380).
 *
 * Tagging here rather than at the call sites works because dd-trace resolves an
 * LLM span's `ml_app` from its nearest LLMObs parent, so calls several packages
 * deep inherit it without knowing this file exists.
 */
export async function processResearch(data: ResearchJobMessage): Promise<void> {
  return llmWorkflow("research", "research-run", () => runResearchJob(data), {
    sessionId: data.sessionId,
  });
}

async function runResearchJob(data: ResearchJobMessage): Promise<void> {
  const mode = resolveResearchMode(data.mode);
  // The agent's `ResearchMode` is "fast" | "advanced"; the worker's is
  // "fast" | "deep". They genuinely differ, so the boundary is explicit rather
  // than cast — see `toAgentResearchMode` (and the divergence note on
  // `resolveResearchMode`, which is a real runtime bug left untouched by the
  // MONEY-1157 type-only pass).
  const agentMode = toAgentResearchMode(mode);
  console.log(
    `[research-processor] Starting ${mode} research for query: "${data.query}"`,
  );

  try {
    // Use mode-aware config, with env overrides
    const modeConfig = getConfigForMode(agentMode);

    const totalTimeoutMs = parseEnvInt(
      "RESEARCH_TOTAL_TIMEOUT_MS",
      modeConfig.totalTimeoutMs,
    );
    // Hard ceiling: 540s (leaves 60s buffer within Cloud Run's 600s limit)
    const hardCeilingMs = computeResearchHardCeiling(totalTimeoutMs);

    const agent = new ResearchAgent(
      {
        maxSteps: parseEnvInt("RESEARCH_MAX_STEPS", modeConfig.maxSteps),
        maxIterations: parseEnvInt(
          "RESEARCH_MAX_ITERATIONS",
          modeConfig.maxIterations,
        ),
        stepTimeoutMs: parseEnvInt(
          "RESEARCH_STEP_TIMEOUT_MS",
          modeConfig.stepTimeoutMs,
        ),
        totalTimeoutMs,
        maxConcurrency: parseEnvInt(
          "RESEARCH_MAX_CONCURRENT",
          modeConfig.maxConcurrency,
        ),
        qualityThreshold: modeConfig.qualityThreshold,
        skipValidation: modeConfig.skipValidation,
      },
      agentMode,
    );

    // Wrap agent.run with a hard timeout to prevent indefinite hangs.
    // The agent has its own internal timeout, but this is a safety net
    // in case it gets stuck (e.g., waiting on an unresponsive LLM call).
    await Promise.race([
      agent.run(data),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Processor hard timeout: ${mode} research exceeded ${hardCeilingMs / 1000}s ceiling`,
              ),
            ),
          hardCeilingMs,
        ),
      ),
    ]);

    // Check whether the agent marked the session as FAILED internally
    const session = await prisma.researchSession.findUnique({
      where: { sessionId: data.sessionId },
      select: { status: true, errorMessage: true },
    });

    if (session?.status === "FAILED") {
      const errMsg =
        session.errorMessage ?? "Agent finished with FAILED status";
      console.error("[research] agent finished FAILED", {
        sessionId: data.sessionId,
        errMsg,
      });

      // Refund credits — the agent failed internally, so (like the outer
      // catch) the user must be made whole. Mirror the same refund ladder.
      if (data.userId) {
        await refundResearchCredits(data);
      }

      // Send failure notification
      if (data.userId) {
        await createNotification({
          userId: data.userId,
          type: "RESEARCH_COMPLETE",
          title: "Research Failed",
          message: `Research on "${data.query}" encountered an error. Please try again.`,
          metadata: { sessionId: data.sessionId },
        }).catch(() => {});
      }
      return;
    }

    console.log(
      `[research-processor] Research completed for session: ${data.sessionId}`,
    );

    // MONEY-239 D - dynamic billing reconciliation.
    //
    // The web action debited the legacy flat `l2_research_*` cost
    // upfront. Now that the run is complete, compute the actual cost
    // from real token usage + duration and refund/charge the delta so
    // a cheap Quick Pulse credits the user back, while a token-heavy
    // Comprehensive on 3.0 Pro charges the difference (clamped at the
    // user's available balance to prevent negative going).
    if (data.userId) {
      try {
        await reconcileBilling(data);
      } catch (billingErr) {
        console.error(
          `[research-processor] dynamic billing failed for session ${data.sessionId}:`,
          billingErr instanceof Error ? billingErr.message : String(billingErr),
        );
      }
    }

    // Create success notification for the user
    const notifyUserId = data.userId;
    if (shouldNotifyResearch(notifyUserId)) {
      await createNotification(
        buildResearchCompleteNotification(
          notifyUserId,
          data.sessionId,
          data.query,
        ),
      );
    }
  } catch (error) {
    // Catch any unhandled error (constructor failure, unexpected throws)
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(
      `[research-processor] Unhandled error for session ${data.sessionId}:`,
      errorMsg,
    );

    // Mark session as FAILED so the user isn't left waiting
    try {
      await prisma.researchSession.update({
        where: { sessionId: data.sessionId },
        data: {
          status: "FAILED",
          errorMessage: `Processor error: ${errorMsg}`,
          progress: 0,
          currentStep: "Research failed",
          completedAt: new Date(),
        },
      });
    } catch (dbError) {
      console.error(
        "[research-processor] Failed to update session status:",
        dbError,
      );
    }

    // Refund credits on failure
    if (data.userId) {
      await refundResearchCredits(data);
    }

    // Send failure notification
    if (data.userId) {
      await createNotification({
        userId: data.userId,
        type: "RESEARCH_COMPLETE",
        title: "Research Failed",
        message: `Research on "${data.query}" encountered an error. Please try again.`,
        metadata: { sessionId: data.sessionId },
      }).catch(() => {});
    }

    // Do NOT re-throw - return normally so Pub/Sub gets 200 and doesn't retry
    // (the session is already marked FAILED, retrying won't help)
  }
}

/**
 * Refund the upfront research debit on failure. Shared by the outer
 * catch (unhandled throw) and the agent-internally-FAILED branch so a
 * session that fails *inside* the agent makes the user whole the same
 * way an unhandled throw does. Best-effort: refund errors are logged,
 * never thrown.
 */
async function refundResearchCredits(data: ResearchJobMessage): Promise<void> {
  try {
    const { refundCredits } = await import("@usemoney/services");
    const isComparison = data.symbols && data.symbols.length > 1;
    const creditAction = isComparison
      ? "l3_multi_comparison_base"
      : data.mode === "advanced"
        ? "l2_research_advanced"
        : "l2_research_fast";
    await refundCredits(data.userId, creditAction);
    // Refund per-stock credits for comparisons
    if (isComparison && data.symbols && data.symbols.length > 2) {
      await refundCredits(data.userId, "l3_multi_comparison_per_stock");
    }
    console.log(
      `[research-processor] Credits refunded for failed session ${data.sessionId}`,
    );
  } catch (refundError) {
    console.error(
      "[research-processor] Failed to refund credits:",
      refundError,
    );
  }
}

/**
 * MONEY-239 D - reconcile the legacy upfront debit against actual
 * usage. Reads tokensUsed + duration off the just-completed
 * ResearchSession, computes the dynamic credit cost, and refunds
 * (cheap run) or charges (expensive run) the delta.
 *
 * Charges are clamped at the user's available balance - we never let
 * the wallet go negative. If the actual cost exceeds available credits,
 * the user gets the run for whatever they have left and the next L2
 * call hits the standard "insufficient credits" gate.
 */
async function reconcileBilling(data: ResearchJobMessage): Promise<void> {
  const session = await prisma.researchSession.findUnique({
    where: { sessionId: data.sessionId },
    select: {
      tokensUsed: true,
      totalSteps: true,
      startedAt: true,
      completedAt: true,
      plan: true,
    },
  });
  if (!session) return;

  const { computeRunCredits, CREDIT_COSTS } = await import("@usemoney/core");
  const { RESEARCH_DEFAULT_MODEL } =
    await import("@usemoney/services/preferences");
  const { consumeCredits, refundCredits } = await import("@usemoney/services");

  // Approximate input/output split - real per-call usageMetadata
  // tracking lands in PR-5. Observed ratio in production research
  // runs: ~80% input (prompt + scratchpad), ~20% output.
  const totalTokens = session.tokensUsed ?? 0;
  const inputTokens = Math.round(totalTokens * 0.8);
  const outputTokens = Math.max(0, totalTokens - inputTokens);

  const durationSec = session.completedAt
    ? Math.round(
        (session.completedAt.getTime() - session.startedAt.getTime()) / 1000,
      )
    : 0;

  // Pull skill / task counts off the persisted plan when present.
  const planObj = (session.plan ?? null) as {
    tasks?: { length?: number }[];
    customSkills?: string[];
    preset?: string;
  } | null;
  const taskCount = Array.isArray(planObj?.tasks)
    ? planObj!.tasks.length
    : (session.totalSteps ?? 0);
  const skillCount = Array.isArray(planObj?.customSkills)
    ? planObj!.customSkills.length
    : 0;

  const modelId = data.model ?? RESEARCH_DEFAULT_MODEL;

  // MONEY-240 C - match the upfront-debit branch in
  // startResearchAction. Two cost ladders:
  //
  //   single-stock        → l2_research_fast | l2_research_advanced
  //                         (flat per action, dominant case)
  //   multi-stock peer    → l3_multi_comparison_base
  //                         + l3_multi_comparison_per_stock × (N - 1)
  //                         (PR-4 deferred this; this PR closes it)
  //
  // The reconciliation logic is shared - only the ladder + the
  // refund-target action key change.
  const isComparison = (data.symbols ?? []).length > 1;

  let legacyAction: string;
  let legacyDebit: number;

  if (isComparison) {
    const symCount = (data.symbols ?? []).length;
    const baseCost = CREDIT_COSTS["l3_multi_comparison_base"] ?? 3;
    const perStockCost = CREDIT_COSTS["l3_multi_comparison_per_stock"] ?? 2;
    legacyDebit = baseCost + perStockCost * Math.max(0, symCount - 1);
    legacyAction = "l3_multi_comparison_base";
  } else {
    legacyAction =
      data.mode === "advanced" ? "l2_research_advanced" : "l2_research_fast";
    legacyDebit =
      CREDIT_COSTS[legacyAction] ?? (data.mode === "advanced" ? 3 : 1);
  }

  // baseCredits floor: Quick Pulse = 1, Comprehensive = 10. We don't
  // have the preset-specific floor here without re-deriving from
  // skillCount, so use the legacy debit as a defensible floor - the
  // user already paid that, so reconciliation can only shift up or
  // refund down from there.
  const breakdown = computeRunCredits({
    modelId,
    inputTokens,
    outputTokens,
    durationSec,
    taskCount,
    skillCount,
    baseCredits: legacyDebit,
  });
  const actualCost = breakdown.credits;
  const delta = actualCost - legacyDebit;

  if (delta === 0) return;

  if (delta < 0) {
    // Cheap run - refund the difference. We refund against the same
    // legacy action key so the wallet ledger stays auditable.
    const refundAmount = Math.abs(delta);
    for (let i = 0; i < refundAmount; i++) {
      await refundCredits(data.userId, legacyAction);
    }
    console.log(
      `[research-processor] dynamic-credits REFUND ${refundAmount} for session ${data.sessionId} (actual=${actualCost} legacy=${legacyDebit})`,
    );
  } else {
    // Expensive run - debit the extra. consumeCredits enforces the
    // balance check, so if the user can't afford the extra we just
    // log + move on rather than blocking the result.
    const extraResult = await consumeCredits(data.userId, legacyAction, {
      symbols: data.symbols,
      query: data.query,
      tier: isComparison ? "L3" : "L2",
      geminiModel: modelId,
      costOverride: delta,
    });
    if (!extraResult.success) {
      console.warn(
        `[research-processor] dynamic-credits could not charge extra ${delta} for session ${data.sessionId}: ${extraResult.error ?? "no balance"}`,
      );
    } else {
      console.log(
        `[research-processor] dynamic-credits CHARGED extra ${delta} for session ${data.sessionId} (actual=${actualCost} legacy=${legacyDebit})`,
      );
    }
  }

  // Best-effort PostHog event for billing telemetry. Lazy import
  // because the worker doesn't keep a long-lived PostHog client.
  void emitBillingEvent({
    userId: data.userId,
    sessionId: data.sessionId,
    modelId,
    legacyDebit,
    actualCost,
    delta,
    tokensUsed: totalTokens,
    durationSec,
    taskCount,
    skillCount,
  }).catch(() => {});
}

async function emitBillingEvent(payload: {
  userId: string;
  sessionId: string;
  modelId: string;
  legacyDebit: number;
  actualCost: number;
  delta: number;
  tokensUsed: number;
  durationSec: number;
  taskCount: number;
  skillCount: number;
}): Promise<void> {
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) return;
  const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
  try {
    await fetch(`${host}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        event: "research_run_billed",
        distinct_id: payload.userId,
        properties: {
          session_id: payload.sessionId,
          model_id: payload.modelId,
          legacy_debit: payload.legacyDebit,
          actual_cost: payload.actualCost,
          delta: payload.delta,
          tokens_used: payload.tokensUsed,
          duration_sec: payload.durationSec,
          task_count: payload.taskCount,
          skill_count: payload.skillCount,
        },
        timestamp: new Date().toISOString(),
      }),
    });
  } catch {
    /* swallow - telemetry best-effort */
  }
}
