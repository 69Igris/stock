/**
 * Pending-payment poll decision logic (MONEY-1074).
 *
 * After returning from Dodo checkout on the `?payment=pending` path (the Dodo
 * poll at the callback route hadn't resolved yet), the settings page used to
 * call `refreshPendingPaymentsAction` exactly ONCE and then give up with a
 * "still processing, check billing tab" toast — so a payment that Dodo confirmed
 * a few seconds later left the user staring at their OLD plan.
 *
 * This pure decision function drives a PROVABLY-TERMINATING bounded poll:
 *   - a terminal payment status (COMPLETED / FAILED) stops it immediately;
 *   - a hard attempt cap stops a poll whose payment never resolves (Dodo slow /
 *     abandoned) — checked FIRST so it always dominates;
 *   - N consecutive failed polls (returned-`false` OR thrown action) stop it,
 *     but a single transient blip does not.
 *
 * Pure + exported so the termination guarantee is unit-tested without React or a
 * live server action — see `__tests__/subscription/pending-payment-poll-logic.test.ts`.
 * Mirrors `apps/web/lib/compare/poll-logic.ts`.
 */

/** Poll cadence between pending-payment refreshes. */
export const PENDING_PAYMENT_POLL_INTERVAL_MS = 3000;

/** Hard cap on attempts. 3s × 10 ≈ 30s — long enough for a lagging webhook,
 *  short enough that the user isn't left hanging. */
export const MAX_PENDING_PAYMENT_POLL_ATTEMPTS = 10;

/** Consecutive failed polls tolerated before giving up. */
export const MAX_CONSECUTIVE_PENDING_POLL_FAILURES = 3;

/** Statuses that end the poll (the payment reached a final state). */
export const PENDING_PAYMENT_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "FAILED",
]);

export interface PendingPollResponse {
  /**
   * Did the refresh + history read yield a usable payment status? `false`
   * covers BOTH a `{ success:false }`/missing-row return AND a thrown action
   * call — the caller maps both to `ok:false`.
   */
  ok: boolean;
  status?: string | null;
}

export interface PendingPollContext {
  /** 1-based attempt number that produced `res` (the first poll is attempt 1). */
  attempt: number;
  /** Failed polls seen in a row so far (reset to 0 after any successful read). */
  consecutiveFailures: number;
}

export type PendingPollAction =
  | "continue"
  | "stop-completed"
  | "stop-failed"
  | "stop-exhausted"
  | "stop-error";

export interface PendingPollDecision {
  action: PendingPollAction;
  /** Failure counter to carry forward (0 after any successful read). */
  consecutiveFailures: number;
}

/**
 * Decide what the pending-payment poll should do next. PURE — no I/O, no Date,
 * no React, no timers.
 *
 * @param res the mapped refresh result; `ok:false` for a returned-false response
 *            OR a thrown action call.
 * @param ctx the 1-based attempt number + running failure counter.
 */
export function decidePendingPaymentPoll(
  res: PendingPollResponse,
  ctx: PendingPollContext
): PendingPollDecision {
  // 1) Hard attempt cap FIRST — a payment that never resolves (Dodo slow /
  //    abandoned) must not poll forever, even if every read "succeeds" with a
  //    non-terminal status.
  if (ctx.attempt >= MAX_PENDING_PAYMENT_POLL_ATTEMPTS) {
    return {
      action: "stop-exhausted",
      consecutiveFailures: ctx.consecutiveFailures,
    };
  }

  // 2) Failed poll (returned-false OR thrown). Tolerate a brief blip, but give
  //    up on a sustained streak so a dead/unrecognized action can't loop forever.
  if (!res.ok || !res.status) {
    const consecutiveFailures = ctx.consecutiveFailures + 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_PENDING_POLL_FAILURES) {
      return { action: "stop-error", consecutiveFailures };
    }
    return { action: "continue", consecutiveFailures };
  }

  // 3) Successful read → reset the failure streak; stop on a terminal status.
  if (res.status === "COMPLETED") {
    return { action: "stop-completed", consecutiveFailures: 0 };
  }
  if (res.status === "FAILED") {
    return { action: "stop-failed", consecutiveFailures: 0 };
  }
  return { action: "continue", consecutiveFailures: 0 };
}
