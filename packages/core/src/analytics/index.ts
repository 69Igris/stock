import { prisma, type Prisma } from "@usemoney/database";

/**
 * AI DECISION LOGGER (MONEY-786) — the audit/telemetry plumbing for every
 * autonomous AI decision the platform makes (research runs, portfolio roasts,
 * chat replies, nudges, scans, rebalance insights).
 *
 * Every decision flows through {@link logAiDecision}, which:
 *   (a) persists a durable `AIGenerationLog` row via @usemoney/database (gated
 *       on `process.env.DATABASE_URL`), AND
 *   (b) fires a PostHog server event `ai_decision` (via raw `fetch`, gated on
 *       `POSTHOG_API_KEY`) for real-time dashboards.
 *
 * This helper NEVER throws — both sinks are best-effort and failures are
 * swallowed with a `console.warn`, so logging can never break a user request.
 *
 * SERVER-ONLY: this module touches Prisma. Import it from the
 * `@usemoney/core/analytics` subpath only — never the `@usemoney/core` root
 * barrel (which pulls node-only brokers/payments and breaks client bundles).
 */

/** Decision categories — mirrors the `AiDecisionType` Prisma enum. */
export type AiDecisionType =
  | "RESEARCH_RUN"
  | "ROAST"
  | "CHAT_REPLY"
  | "NUDGE"
  | "SCAN"
  | "REBALANCE_INSIGHT";

/** Model provider — mirrors the `AiDecisionProvider` Prisma enum. */
export type AiDecisionProvider = "GOOGLE" | "ANTHROPIC";

/** Token / latency / cost telemetry for a single decision. */
export interface AiDecisionUsage {
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  costUsd?: number;
}

/** Input to {@link logAiDecision}. */
export interface AiDecisionLogInput {
  decisionType: AiDecisionType;
  /** Defaults to `GOOGLE` when omitted. */
  provider?: AiDecisionProvider;
  model: string;
  userId?: string;
  input: unknown;
  output: unknown;
  rationale: string;
  outcome?: string;
  sessionId?: string;
  qualityScore?: number;
  metadata?: Record<string, unknown>;
  usage?: AiDecisionUsage;
  /** Latency override; falls back to `usage.latencyMs`. */
  latencyMs?: number;
}

/**
 * Ensure a value is safe to store in a Prisma `Json` column / send to PostHog.
 *
 * Exported so other server modules that persist a caller-supplied JSON blob
 * (e.g. the per-result feedback action's `metadata`) reuse this ONE
 * normalisation rather than inlining a divergent copy — single source of truth.
 */
export function toJsonSafe(value: unknown): Prisma.InputJsonValue {
  // Round-trip through JSON to strip non-serializable values (functions,
  // BigInt, circular refs, Dates -> ISO strings). Fall back to a wrapper.
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  } catch {
    return { unserializable: String(value) } as Prisma.InputJsonValue;
  }
}

/**
 * Log a single autonomous AI decision. Resolves even when the DB and/or PostHog
 * are unconfigured or erroring; check `console.warn` output for degraded sinks.
 */
export async function logAiDecision(input: AiDecisionLogInput): Promise<void> {
  const provider = input.provider ?? "GOOGLE";
  const latencyMs = input.latencyMs ?? input.usage?.latencyMs;

  // (a) Durable audit row — only attempt when a database is configured.
  if (process.env.DATABASE_URL) {
    try {
      await prisma.aIGenerationLog.create({
        data: {
          userId: input.userId,
          decisionType: input.decisionType,
          provider,
          model: input.model,
          input: toJsonSafe(input.input),
          output: toJsonSafe(input.output),
          rationale: input.rationale,
          inputTokens: input.usage?.inputTokens,
          outputTokens: input.usage?.outputTokens,
          latencyMs,
          costUsd: input.usage?.costUsd,
          qualityScore: input.qualityScore,
          outcome: input.outcome,
          sessionId: input.sessionId,
          metadata: input.metadata ? toJsonSafe(input.metadata) : undefined,
        },
      });
    } catch (err) {
      console.warn("UseMoney: logAiDecision DB write failed", err);
    }
  }

  // (b) Real-time PostHog event via raw fetch. Mirrors the worker's
  // `emitBillingEvent` capture shape (workers/src/processors/research.ts).
  const apiKey = process.env.POSTHOG_API_KEY;
  if (apiKey) {
    const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
    // PRIVACY: we deliberately send ONLY bounded telemetry to the third-party
    // analytics vendor — never the prompt `input`/`output`, holdings, or tokens.
    // `metadata` is caller-controlled (`Record<string, unknown>`), so it is
    // round-tripped through `toJsonSafe` (same as the DB sink) to drop
    // non-serializable values (which would otherwise throw inside the body
    // `JSON.stringify` below) and normalize its shape before it leaves us.
    const safeMetadata = input.metadata ? toJsonSafe(input.metadata) : {};
    try {
      await fetch(`${host}/capture/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          event: "ai_decision",
          distinct_id: input.userId ?? "system",
          properties: {
            decisionType: input.decisionType,
            provider,
            model: input.model,
            outcome: input.outcome,
            inputTokens: input.usage?.inputTokens,
            outputTokens: input.usage?.outputTokens,
            latencyMs,
            costUsd: input.usage?.costUsd,
            qualityScore: input.qualityScore,
            sessionId: input.sessionId,
            ...(safeMetadata as Record<string, unknown>),
          },
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (err) {
      console.warn("UseMoney: logAiDecision PostHog capture failed", err);
    }
  }
}
