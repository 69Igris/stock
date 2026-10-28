/**
 * Roast processor — PURE helpers (no Prisma / network / RoastAgent).
 *
 * `roast.ts` parses its env-driven timeouts, decides whether to notify, and
 * builds the success-notification payload inline; the test re-declared a whole
 * `processRoast` copy + the env-parse + notification builders and asserted the
 * copies (a shadow). Those side-effect-free bits now live here and the processor
 * imports + CALLS them. Mirrors `mf-sync-logic.ts`.
 *
 * @see workers/src/processors/roast.ts (caller)
 * @see apps/web/__tests__/workers/processor-roast.test.ts (tests the real exports)
 */

export const DEFAULT_ROAST_STEP_TIMEOUT_MS = 60_000;
export const DEFAULT_ROAST_TOTAL_TIMEOUT_MS = 300_000;

/** Minimal RoastAgent options shape produced from env. */
export interface RoastTimeouts {
  stepTimeoutMs: number;
  totalTimeoutMs: number;
}

/**
 * Parse a millisecond env value, falling back to `fallback`.
 *
 * BUG GUARD (MONEY-620): the live code did
 * `parseInt(process.env.ROAST_STEP_TIMEOUT_MS || "60000", 10)`. The `|| "60000"`
 * only catches an empty/undefined var — a MISconfigured value like
 * `ROAST_STEP_TIMEOUT_MS="abc"` parses to NaN, and a NaN timeout makes the
 * RoastAgent's `setTimeout(..., NaN)` fire immediately (treated as 0ms), so
 * every roast would instantly "time out". We also reject non-positive values
 * (0 / negative would do the same). Anything not a finite positive integer
 * collapses to the safe default.
 */
export function parseTimeoutMs(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === "") return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve the RoastAgent timeouts from an env-like object. */
export function resolveRoastTimeouts(env: {
  ROAST_STEP_TIMEOUT_MS?: string;
  ROAST_TOTAL_TIMEOUT_MS?: string;
}): RoastTimeouts {
  return {
    stepTimeoutMs: parseTimeoutMs(
      env.ROAST_STEP_TIMEOUT_MS,
      DEFAULT_ROAST_STEP_TIMEOUT_MS,
    ),
    totalTimeoutMs: parseTimeoutMs(
      env.ROAST_TOTAL_TIMEOUT_MS,
      DEFAULT_ROAST_TOTAL_TIMEOUT_MS,
    ),
  };
}

/** A notification payload (subset of createNotification's input). */
export interface RoastNotification {
  userId: string;
  type: "ROAST_COMPLETE";
  title: string;
  message: string;
  metadata: { sessionId: string; link: string };
}

/** Whether to create a completion notification — only when there's a userId. */
export function shouldNotifyRoast(userId: string | undefined | null): boolean {
  return !!userId;
}

/** Build the success-notification payload for a completed roast. */
export function buildRoastCompleteNotification(
  userId: string,
  sessionId: string,
): RoastNotification {
  return {
    userId,
    type: "ROAST_COMPLETE",
    title: "Portfolio Roast Complete",
    message: "Your portfolio roast is ready to view!",
    metadata: { sessionId, link: `/roast/${sessionId}` },
  };
}
