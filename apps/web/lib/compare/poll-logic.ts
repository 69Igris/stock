/**
 * Deep-compare poll decision logic (MONEY-553 hardening).
 *
 * The `/compare/[sessionId]` page polls `getComparisonStatusAction` every 4s
 * while a `ComparisonSession` worker job is in flight. The original loop only
 * stopped on a COMPLETED/FAILED status and had NO handling for a FAILING poll:
 * a server-action REJECTION (e.g. Next.js `UnrecognizedActionError` after a
 * deploy re-hashes the action id) or a `{ success:false }` return (demo session,
 * IDOR/not-found, transient error) left the 4s interval running FOREVER —
 * manufacturing hundreds of identical exceptions from a single stale tab (the
 * PostHog uptick this fixes).
 *
 * This pure decision function makes the poll PROVABLY TERMINATING:
 *   - a terminal status (COMPLETED/FAILED) stops it;
 *   - N consecutive failed polls (returned-`false` OR thrown) stop it with a
 *     reload prompt — but a SINGLE transient blip does not (the worker may
 *     briefly 5xx);
 *   - a hard wall-clock cap stops a poll whose worker never writes a terminal
 *     status at all (a dead/stuck job that would otherwise "succeed" forever).
 *
 * Pure + exported so the termination guarantee is unit-tested without React or a
 * live server action — see `__tests__/compare/compare-poll-logic.test.ts`.
 */

/** Poll cadence for the deep-compare status check. */
export const COMPARE_POLL_INTERVAL_MS = 4000;

/** Consecutive failed polls tolerated before giving up with a reload prompt. */
export const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/**
 * Hard wall-clock cap on a single poll session. The comparison worker caps its
 * own run at ~8 min; this adds slack so a worker that dies WITHOUT writing a
 * terminal status can't keep an in-progress poll alive indefinitely.
 */
export const MAX_POLL_DURATION_MS = 12 * 60 * 1000;

/** Statuses the worker writes when the job is finished (success or failure). */
export const COMPARE_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILED",
]);

export interface ComparePollResponse {
  /**
   * Did the status action return a usable status? `false` covers BOTH a
   * `{ success:false }` return AND a thrown/rejected action call (e.g.
   * UnrecognizedActionError) — the caller maps both to `ok:false`.
   */
  ok: boolean;
  status?: string | null;
}

export interface ComparePollContext {
  /** Failed polls seen in a row so far (reset to 0 after any success). */
  consecutiveFailures: number;
  /** Milliseconds since polling began. */
  elapsedMs: number;
}

export type ComparePollAction = "continue" | "stop" | "stop-error";

export interface ComparePollDecision {
  action: ComparePollAction;
  /** Status to apply when the poll succeeded (omitted on a failed poll). */
  status?: string;
  /** Failure counter to carry forward (0 after any success). */
  consecutiveFailures: number;
  /** User-facing message when `action === "stop-error"`. */
  error?: string;
}

/**
 * Decide what the poll loop should do next. PURE — no I/O, no Date, no React.
 *
 * @param res the (mapped) status-action result; `ok:false` for a returned-false
 *            response OR a thrown action call.
 * @param ctx the running failure counter + elapsed time.
 */
export function decideComparePoll(
  res: ComparePollResponse,
  ctx: ComparePollContext
): ComparePollDecision {
  // 1) Hard wall-clock cap FIRST — a stuck worker that never writes a terminal
  //    status must not poll indefinitely, even if every poll "succeeds" with an
  //    in-progress status.
  if (ctx.elapsedMs >= MAX_POLL_DURATION_MS) {
    return {
      action: "stop-error",
      consecutiveFailures: ctx.consecutiveFailures,
      error:
        "This comparison is taking longer than expected. Please reload to check again.",
    };
  }

  // 2) Failed poll (returned-false OR thrown). Tolerate a brief blip, but give
  //    up on a sustained streak so a dead/unrecognized action can't loop forever.
  if (!res.ok || !res.status) {
    const consecutiveFailures = ctx.consecutiveFailures + 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
      return {
        action: "stop-error",
        consecutiveFailures,
        error:
          "We couldn't load the comparison status. Please reload the page.",
      };
    }
    // Keep polling; do NOT change the displayed status on a transient failure.
    return { action: "continue", consecutiveFailures };
  }

  // 3) Successful poll → reset the failure streak.
  if (COMPARE_TERMINAL_STATUSES.has(res.status)) {
    return { action: "stop", status: res.status, consecutiveFailures: 0 };
  }
  return { action: "continue", status: res.status, consecutiveFailures: 0 };
}
