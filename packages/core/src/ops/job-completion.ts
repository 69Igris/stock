/**
 * A job's `main()` must END — resolve or reject — before its process does.
 * MONEY-1608.
 *
 * Node exits when its event loop is empty, whatever is still being awaited. A
 * promise with no socket, timer or child behind it keeps nothing alive, so
 * awaiting one ends the process with exit code 0, no error and no log line:
 * success, as far as any wrapper or scheduler can tell.
 *
 * `lake-replay-us` did exactly that on prod on 2026-09-23: 8 hours, 138,418
 * stage objects written, the final flush awaiting an upload that never
 * settled, and then `exited 0` with 0 rows loaded. MONEY-1540 was the same
 * class, through an `unref()`'d pacer.
 *
 * `beforeExit` fires precisely when the loop has emptied and Node is about to
 * exit — so "main() is still pending at `beforeExit`" is the defect itself,
 * never a race. The guard names it and makes the exit non-zero, so an empty
 * event loop can never again read as a completed run. It changes nothing on
 * the normal paths: settling detaches it, and a rejection stays the caller's
 * to report.
 */

/** The exit code the guard sets. Distinct from 1 so a log reader can tell it apart. */
export const ENDED_WITHOUT_COMPLETING_EXIT_CODE = 3;

export function guardCompletion<T>(job: string, main: Promise<T>): Promise<T> {
  const onBeforeExit = (): void => {
    // Detach first: setting an exit code schedules no work, so `beforeExit`
    // would not fire again anyway — but a listener that outlives its purpose
    // is how a later refactor makes it fire twice.
    process.removeListener("beforeExit", onBeforeExit);
    console.error(
      `ERROR ${job} ENDED WITHOUT COMPLETING — the event loop emptied while ` +
        `main() was still pending, so something it awaited can never settle ` +
        `(MONEY-1608). Treat this run as FAILED.`,
    );
    process.exitCode = ENDED_WITHOUT_COMPLETING_EXIT_CODE;
  };
  process.on("beforeExit", onBeforeExit);
  const detach = (): void => {
    process.removeListener("beforeExit", onBeforeExit);
  };
  main.then(detach, detach);
  return main;
}
