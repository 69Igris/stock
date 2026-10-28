/**
 * Research processor — PURE helpers (no Prisma / ResearchAgent).
 *
 * `research.ts` resolved its mode, parsed env-int overrides, computed the hard
 * timeout ceiling and built the completion notification inline; the test
 * re-declared copies of all of them (plus `getConfigForMode`, `FAST_CONFIG`,
 * `DEEP_CONFIG`) and asserted the copies. That was a SHADOW — and it had DRIFTED:
 * the inline `buildAnalysisLink` produced `/analysis?sessionId=X&symbol=Y` while
 * the REAL processor links to `/analysis/{sessionId}`. These side-effect-free
 * bits now live here, the processor imports + CALLS them, and the test asserts
 * the REAL code. Mode config itself stays the real `getConfigForMode`
 * (@usemoney/research). Mirrors `roast-logic.ts`.
 *
 * @see workers/src/processors/research.ts (caller)
 * @see apps/web/__tests__/workers/research.test.ts (tests the real exports)
 */

import type { ResearchMode as AgentResearchMode } from "@usemoney/research/types";

/**
 * The WORKER's mode label. **Not** the agent's — see `toAgentResearchMode`.
 *
 * MONEY-1157: `@usemoney/research`'s canonical `ResearchMode` is
 * `"fast" | "advanced"`; this one is `"fast" | "deep"`. They are NOT the same
 * type wearing two names, so this cannot simply be replaced by an import of the
 * canonical one — `toAgentResearchMode` is the explicit, tested bridge.
 *
 * MONEY-1159: the divergence itself was never the bug — failing to accept the
 * value publishers actually send was. `resolveResearchMode` now recognises
 * `"advanced"`; the two-union boundary stays, because it is deliberate and
 * covered (`processor-boundary-contracts.test.ts`).
 */
export type ResearchMode = "fast" | "deep";

/** Cloud Run leaves a 60s buffer within its 600s limit → 540s hard ceiling. */
export const RESEARCH_HARD_CEILING_MS = 540_000;
export const RESEARCH_CEILING_BUFFER_MS = 60_000;

/**
 * Resolve the research mode, defaulting to "fast".
 *
 * ## What was broken (MONEY-1159)
 *
 * This recognised ONLY `"deep"` — and nothing in the repo has ever published
 * that. `ResearchJobMessage.mode` is `"fast" | "advanced"` (@usemoney/types),
 * and the UI style called "deep" is mapped to `"advanced"` BEFORE the job is
 * published (`apps/web/lib/chat/research-style.ts#mapStyleToMode`). So every
 * real payload — including every Comprehensive/advanced run — fell through to
 * `"fast"`.
 *
 * The consequence was not a slower run, it was a truncated one:
 *
 *   1. `modeConfig` became FAST_AGENT_CONFIG (totalTimeoutMs 120s)
 *   2. so the processor's hard ceiling was 120s + 60s buffer = **180s**
 *   3. the agent DID self-correct at `run()` time (`job.mode || this.mode` →
 *      reconfigure to ADVANCED, 480s)
 *   4. but the processor's `Promise.race` killed it at 180s regardless
 *
 * Advanced research therefore got ~a quarter of its intended budget, and the
 * failure surfaced as a generic timeout rather than a misconfiguration — so it
 * looked like slow research, not broken research.
 *
 * Fixing this ALSO fixes the ceiling, with no separate change: `"advanced"`
 * now selects ADVANCED_AGENT_CONFIG (480s), and
 * `computeResearchHardCeiling(480s)` is `min(480+60, 540) = 540s`, which no
 * longer undercuts the agent's own budget.
 *
 * `"deep"` stays accepted as a legacy alias. It costs nothing, and a message
 * already sitting in the subscription when this deploys must not resolve to a
 * different mode than it was published for.
 */
export function resolveResearchMode(mode: string | undefined): ResearchMode {
  // `"advanced"` is what publishers actually emit; `"deep"` is the legacy label.
  return mode === "advanced" || mode === "deep" ? "deep" : "fast";
}

/**
 * Translate the worker's mode label into the ResearchAgent's canonical
 * `ResearchMode` (`"fast" | "advanced"`), for `getConfigForMode` and the
 * `ResearchAgent` constructor.
 *
 * Runtime-equivalent for every payload this repo can produce: `resolveResearchMode`
 * only ever returns `"fast"` for a real `ResearchJobMessage` (see above), and
 * `"fast"` maps to itself. For a hypothetical off-contract `mode: "deep"` on the
 * wire, `getConfigForMode` is also unchanged — it is
 * `mode === "fast" ? FAST : ADVANCED`, so `"deep"` and `"advanced"` both select
 * ADVANCED_AGENT_CONFIG. The single observable difference in that unreachable
 * case is the agent's `this.mode` seed, which only feeds its own
 * `job.mode !== this.mode` re-configure check.
 */
export function toAgentResearchMode(mode: ResearchMode): AgentResearchMode {
  return mode === "fast" ? "fast" : "advanced";
}

/**
 * Parse an integer env override, falling back to `fallback`.
 * Accepts an explicit env map for testability (defaults to `process.env`).
 * A present-but-non-numeric value (NaN) collapses to the fallback.
 */
export function parseEnvInt(
  envKey: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const envVal = env[envKey];
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    return isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
}

/**
 * The processor's hard-timeout ceiling: totalTimeoutMs + buffer, capped at
 * RESEARCH_HARD_CEILING_MS (so a huge env override can't exceed Cloud Run's
 * limit). Non-finite totals collapse to the ceiling.
 */
export function computeResearchHardCeiling(totalTimeoutMs: number): number {
  if (!Number.isFinite(totalTimeoutMs)) return RESEARCH_HARD_CEILING_MS;
  return Math.min(totalTimeoutMs + RESEARCH_CEILING_BUFFER_MS, RESEARCH_HARD_CEILING_MS);
}

/**
 * Whether to create a completion notification — only when there's a userId.
 * A type guard so callers narrow `userId` to `string` for the builder.
 */
export function shouldNotifyResearch(
  userId: string | undefined | null,
): userId is string {
  return !!userId;
}

export interface ResearchNotification {
  userId: string;
  type: "RESEARCH_COMPLETE";
  title: string;
  message: string;
  metadata: { sessionId: string; link: string };
}

/**
 * Build the success-notification payload for a completed research run. The link
 * is the path `/analysis/{sessionId}` (the real route — NOT the query-string
 * form the old shadow had drifted to).
 */
export function buildResearchCompleteNotification(
  userId: string,
  sessionId: string,
  query: string,
): ResearchNotification {
  return {
    userId,
    type: "RESEARCH_COMPLETE",
    title: "Research Complete",
    message: `Research on "${query}" is ready to view.`,
    metadata: { sessionId, link: `/analysis/${sessionId}` },
  };
}
