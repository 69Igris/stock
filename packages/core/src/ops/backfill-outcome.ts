/**
 * Did a backfill run succeed enough to report success?
 *
 * ## Why this is a shared function and not three `if`s
 *
 * The three Tiingo backfills each set `process.exitCode = 1` on a
 * circuit-breaker stop and on nothing else. A night where the upstream answers
 * 500 to EVERY request therefore records tens of thousands of `ERROR`
 * checkpoints and exits **0** — Cloud Run reports SUCCEEDED, `--max-retries=0`
 * means nothing retries, and nobody looks. The data is recoverable (an `ERROR`
 * checkpoint is not terminal, so a re-run retries it); the SIGNAL is what is
 * lost, and the exit code is what `gcloud run jobs execute --wait` and the
 * execution list read.
 *
 * Stated once because it is one rule. Three copies of a threshold drift, and a
 * threshold that differs per script is a threshold nobody can reason about.
 *
 * ## Why not simply "any error fails the run"
 *
 * A walk over 72,685 symbols meets transient errors as a matter of course. A
 * rule that fails the run on a single one makes every run red, and a signal
 * that is always on is a signal people learn to ignore — which is the same
 * outcome as having none, arrived at more expensively.
 *
 * So the two conditions below are the ones that are UNAMBIGUOUS rather than
 * merely bad:
 *
 *   1. Work was attempted and NOTHING succeeded. There is no reading of that
 *      which is a healthy run.
 *   2. More than half of what was attempted failed. Not a tuned threshold — a
 *      statement that the run is more broken than working.
 *
 * A circuit-breaker stop is also non-zero, which the scripts already did: it
 * processed and checkpointed some items, so it is not "nothing happened", but a
 * wrapper reading only the exit code must not read "rate-limited after 3 of 250
 * days" as success.
 */
export interface BackfillOutcomeInput {
  /** A circuit-breaker halted the walk (rate limit, auth, feed shape, 404 streak). */
  stopped?: string | boolean | null;
  /** Items the run actually tried to process. Excludes checkpoint skips. */
  attempted: number;
  /** Items that produced their intended result. */
  succeeded: number;
  /** Items that failed for any reason. */
  failed: number;
}

export interface BackfillOutcome {
  exitCode: 0 | 1;
  /** Operator-facing reason. Empty when the run was healthy. */
  reason: string;
}

/** Fraction of attempted work that may fail before the run is called failed. */
export const BACKFILL_FAILURE_RATIO = 0.5;

export function judgeBackfillOutcome(
  input: BackfillOutcomeInput,
): BackfillOutcome {
  const { stopped, attempted, succeeded, failed } = input;

  if (stopped) {
    return {
      exitCode: 1,
      reason:
        typeof stopped === "string"
          ? `stopped: ${stopped}`
          : "stopped by a circuit breaker",
    };
  }

  // Guard the arithmetic before it can produce a verdict. A negative or
  // non-finite counter means the caller's tally is broken, and a broken tally
  // must not be able to certify a run as healthy — that is the failure this
  // whole module exists to prevent, one level up.
  if (
    !Number.isFinite(attempted) ||
    !Number.isFinite(succeeded) ||
    !Number.isFinite(failed) ||
    attempted < 0 ||
    succeeded < 0 ||
    failed < 0
  ) {
    return {
      exitCode: 1,
      reason: "incoherent counters — cannot certify this run",
    };
  }

  if (attempted === 0) {
    // Nothing to do is a real, healthy outcome: every item was already
    // checkpointed. It is NOT the same as "attempted and all failed".
    return { exitCode: 0, reason: "" };
  }

  if (succeeded === 0) {
    return {
      exitCode: 1,
      reason: `attempted ${attempted} and NOTHING succeeded`,
    };
  }

  if (failed > attempted * BACKFILL_FAILURE_RATIO) {
    return {
      exitCode: 1,
      reason: `${failed} of ${attempted} attempted items failed (over ${BACKFILL_FAILURE_RATIO * 100}%)`,
    };
  }

  return { exitCode: 0, reason: "" };
}
