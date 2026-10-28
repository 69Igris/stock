/**
 * Dynamic credit billing for research runs (MONEY-219).
 *
 * The legacy model was a flat per-action cost (l2_research_advanced = 3
 * credits regardless of skills/tokens/time). That misaligns price and
 * cost - a 4-skill thesis run on 2.5 Pro burns ~3× the tokens of a
 * Quick Pulse, but both billed identically. The redesigned billing
 * derives credits from actual usage:
 *
 *   1. Compute the rupee cost of the LLM call (token usage × model price)
 *   2. Add a duration premium (long-running compute is expensive in our
 *      worker hours, not just LLM tokens)
 *   3. Add a complexity premium (each active skill bumps the floor a bit
 *      to amortise our prompt + RAG context costs)
 *   4. Floor at the preset's baseCredits so users always pay at least
 *      what the picker advertised
 *
 * The function is pure - pass in metrics, get credits back. Telemetry +
 * Prisma persistence stay in the caller.
 *
 * Anchor:  1 credit ≈ ₹4 (matches the 1000-credit pack at ₹3,999).
 */

import { calculateCost, convertToINR } from "../gemini/pricing";

/** Rupees per credit at our reference pack price. */
export const RUPEES_PER_CREDIT = 4;

export interface RunCostInputs {
  modelId: string;
  /** Token usage actually consumed by the run. Pre-run estimates use predicted values. */
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock seconds the run took (or estimated). */
  durationSec: number;
  /** Number of executed tasks (data + compute + synthesis). */
  taskCount: number;
  /** Number of active skills (after preset + extra − removed). */
  skillCount: number;
  /** Optional floor (preset.baseCredits). Defaults to 1. */
  baseCredits?: number;
  /** Optional ceiling - useful so a runaway plan can't exhaust the wallet. */
  maxCredits?: number;
}

export interface RunCostBreakdown {
  /** Final integer credits to debit. */
  credits: number;
  /** Rupee equivalent at the reference pack price. */
  rupees: number;
  /** Component contributions for telemetry / display. */
  components: {
    tokenCredits: number;
    durationCredits: number;
    complexityCredits: number;
    floor: number;
    cap?: number;
  };
}

/**
 * The token-cost component. Converts the LLM bill to credits via the
 * rupee anchor.
 */
function creditsFromTokens(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const usd = calculateCost(modelId, inputTokens, outputTokens);
  const inr = convertToINR(usd);
  return inr / RUPEES_PER_CREDIT;
}

/**
 * The duration premium. Each minute of wall-clock past the first
 * 30 seconds adds a small credit charge - this captures worker hours
 * + Pub/Sub + Redis without us having to instrument every component.
 *
 *   sec ≤ 30  → 0
 *   sec ≤ 90  → 0.5
 *   sec ≤ 180 → 1.0
 *   sec > 180 → +0.25 per additional 60 seconds
 */
function creditsFromDuration(durationSec: number): number {
  if (durationSec <= 30) return 0;
  if (durationSec <= 90) return 0.5;
  if (durationSec <= 180) return 1;
  const extra = Math.ceil((durationSec - 180) / 60);
  return 1 + extra * 0.25;
}

/**
 * The complexity premium. Each active skill costs a flat 0.25 credits
 * to cover our prompt + RAG context overhead (the prompt grows by
 * roughly 600 tokens per skill once we include the skill-specific
 * tool descriptions + few-shot examples). Capped at 4 credits so a
 * Comprehensive run doesn't spiral.
 */
function creditsFromComplexity(skillCount: number, taskCount: number): number {
  const skillComponent = Math.min(4, skillCount * 0.25);
  // Tasks past the 12-task baseline add 0.05 credits each - keeps
  // Quick Pulse at zero complexity charge while penalising mega-runs.
  const taskComponent = Math.max(0, (taskCount - 12) * 0.05);
  return skillComponent + taskComponent;
}

/**
 * Sanitize a numeric usage input to a finite, non-negative value.
 *
 * A bare `Math.max(0, x)` does NOT neutralise `NaN` (`Math.max(0, NaN)` is
 * `NaN`) or `Infinity`. An unsanitised `NaN`/`Infinity` token count flows
 * through `calculateCost` → `creditsFromTokens` → `Math.ceil(...)` and yields a
 * `NaN`/`Infinity` *credit debit*, which corrupts the user's wallet. Clamp any
 * non-finite usage metric to 0 so the run falls back to the preset floor.
 */
function finiteNonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Compute the credit cost for a research run.
 *
 *   credits = ceil(max(baseCredits, tokenCredits + durationCredits + complexityCredits))
 */
export function computeRunCredits(input: RunCostInputs): RunCostBreakdown {
  const tokenCredits = creditsFromTokens(
    input.modelId,
    finiteNonNeg(input.inputTokens),
    finiteNonNeg(input.outputTokens),
  );
  const durationCredits = creditsFromDuration(finiteNonNeg(input.durationSec));
  const complexityCredits = creditsFromComplexity(
    finiteNonNeg(input.skillCount),
    finiteNonNeg(input.taskCount),
  );
  // A non-finite `baseCredits` would poison the floor (and therefore the
  // debit). Fall back to the 1-credit minimum when it is NaN/Infinity.
  const floor = Math.max(
    1,
    Number.isFinite(input.baseCredits) ? (input.baseCredits as number) : 1,
  );

  const raw = tokenCredits + durationCredits + complexityCredits;
  let credits = Math.ceil(Math.max(floor, raw));
  // Only apply the ceiling when it is a finite number; a NaN/Infinity cap must
  // never become the debited amount.
  if (input.maxCredits != null && Number.isFinite(input.maxCredits)) {
    credits = Math.min(credits, input.maxCredits);
  }

  return {
    credits,
    rupees: credits * RUPEES_PER_CREDIT,
    components: {
      tokenCredits: round2(tokenCredits),
      durationCredits: round2(durationCredits),
      complexityCredits: round2(complexityCredits),
      floor,
      cap: input.maxCredits,
    },
  };
}

/**
 * Pre-run estimate - fed by the planner's task list + a token forecast
 * derived from `taskCount × averageTokensPerTask`. The forecast is
 * intentionally conservative (a 1.3× multiplier on the planner's
 * predicted tokens) so the confirmation panel slightly overstates cost
 * rather than the user being surprised by an over-charge after the
 * fact.
 *
 * The actual debit at run completion uses real token counts via
 * `computeRunCredits`. Both feed `RunCostBreakdown` so the UI can
 * render the same breakdown.
 */
export function estimateRunCredits(input: {
  modelId: string;
  taskCount: number;
  skillCount: number;
  baseCredits: number;
  /** Optional forecast tokens; defaults to a per-task average. */
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedDurationSec?: number;
  maxCredits?: number;
}): RunCostBreakdown {
  // Per-task averages observed in production (RELIANCE deep run, 2.5 Pro):
  //   ~1100 input tokens per task (system + few-shot + scratchpad)
  //   ~280  output tokens per task (one tool call + JSON args)
  const PER_TASK_INPUT = 1100;
  const PER_TASK_OUTPUT = 280;
  const FORECAST_MULTIPLIER = 1.3;

  const inputTokens =
    input.estimatedInputTokens ??
    Math.ceil(input.taskCount * PER_TASK_INPUT * FORECAST_MULTIPLIER);
  const outputTokens =
    input.estimatedOutputTokens ??
    Math.ceil(input.taskCount * PER_TASK_OUTPUT * FORECAST_MULTIPLIER);

  // Approx 8s per task on Pro models, capped at ~5min.
  const durationSec =
    input.estimatedDurationSec ?? Math.min(300, input.taskCount * 8);

  return computeRunCredits({
    modelId: input.modelId,
    inputTokens,
    outputTokens,
    durationSec,
    taskCount: input.taskCount,
    skillCount: input.skillCount,
    baseCredits: input.baseCredits,
    maxCredits: input.maxCredits,
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
