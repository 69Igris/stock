/**
 * Did a batch run actually finish? — MONEY-1189.
 *
 * ## The incident
 *
 * `feed-parse` processed 11 of 21 pending files, exited with code **0**,
 * printed no error, no stack trace and no end-of-family summary, and left 10
 * files un-checkpointed. Nothing downstream could tell that from a clean run:
 * the driver checked the exit code, the exit code said success.
 *
 * The most likely mechanism is a promise that never settles — Node drains the
 * event loop and exits 0 with no output when the main task is awaiting
 * something that will never resolve, which matches every observed symptom (a
 * throw would have printed a stack; a normal return would have printed the
 * summary). It has not been reproduced, so this module does not claim to know
 * the cause. It defends against the CLASS: a run that does less than it was
 * asked to and reports success anyway — the same shape as the day-granularity
 * completeness checks this ticket exists to fix.
 *
 * ## Why a separate module
 *
 * The decision has to be reachable from a `process.on("beforeExit")` handler,
 * where throwing is useless and the only lever is `process.exitCode`. Keeping
 * the DECISION pure and here means it can be unit-tested; the handler in the
 * script stays a three-line shell that cannot itself be wrong in an interesting
 * way.
 */

export interface RunProgress {
  /**
   * Set true on the last line of the run's main path.
   *
   * The load-bearing flag. It is NOT "did we process everything" — a run that
   * legitimately skips files (dry-run, nothing pending, a family with no
   * archived objects) still reaches the end and is complete. It is "did control
   * flow arrive at the end", which is exactly what a silent event-loop drain
   * fails to do.
   */
  reachedEnd: boolean;
  /** Units the run intended to process. */
  planned: number;
  /** Units it actually finished (success or counted skip — both are outcomes). */
  finished: number;
  /** Identifiers of the unfinished units, for the operator. */
  outstanding: readonly string[];
}

export interface RunCompletionVerdict {
  /** True when the run ended without reaching its own end. */
  abandoned: boolean;
  /** Operator-facing line; null when there is nothing to say. */
  message: string | null;
}

/**
 * Judge a finished process.
 *
 * Returns `abandoned: true` ONLY when control flow never reached the end. A run
 * that reached the end having processed fewer units than planned is NOT
 * abandoned — feed-parse legitimately skips unreadable files and counts them,
 * and failing those runs would train everyone to ignore the signal.
 *
 * `planned === 0` is likewise fine: "nothing to do" is a complete run, and the
 * nightly hits it on any day the archive gained nothing.
 */
export function judgeRunCompletion(p: RunProgress): RunCompletionVerdict {
  if (p.reachedEnd) return { abandoned: false, message: null };

  // Never reached the end. Even with nothing outstanding this is worth saying —
  // it means the process died somewhere it should not have been able to.
  const missing = Math.max(0, p.planned - p.finished);
  const sample = p.outstanding.slice(0, 5).join(", ");
  return {
    abandoned: true,
    message:
      `EXITED WITHOUT FINISHING: ${p.finished}/${p.planned} unit(s) done, ` +
      `${missing} never processed and no error was raised. This run must NOT ` +
      `be treated as successful.` +
      (sample
        ? ` Outstanding: ${sample}${p.outstanding.length > 5 ? ` (+${p.outstanding.length - 5} more)` : ""}`
        : ""),
  };
}

/**
 * Reject if `fn` has not settled within `ms`.
 *
 * A HARD timeout, unlike `@usemoney/utils/with-soft-timeout` — that one only
 * fires telemetry and deliberately lets the underlying operation continue,
 * which is the right call for a user-facing generation and the wrong one here:
 * the whole point is to convert a hang into a catchable error so the loop can
 * count it and move on.
 *
 * The timer is always cleared, so a fast path never leaves one armed (a test
 * that arms a 120s timer outlives its own assertions).
 */
export async function withHardTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms: ${label}`)),
      ms,
    );
  });
  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
