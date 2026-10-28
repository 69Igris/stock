/**
 * Attach Datadog logging to a Cloud Run JOB — MONEY-1375.
 *
 * ## Why every job needed this
 *
 * `initLogger()` is what attaches the Datadog multistream to pino. Measured
 * 2026-09-06: exactly ONE entry point in the repo called it —
 * `workers/src/index.ts`. Neither `tiingo-realtime` (a long-running service) nor
 * ANY of the thirteen job scripts did, so every one of them logged to stdout and
 * nowhere else. Cloud Logging looked perfect; Datadog had never received a line
 * from them, and the log monitors sat in NO DATA — indistinguishable from a job
 * with nothing to say.
 *
 * That is the second half of the same defect. The first was that the transport
 * module was never bundled at all (a computed import specifier esbuild could not
 * see); fixing that made the stream *loadable*, and this makes it *attached*.
 * Either one alone still ships nothing.
 *
 * ## Why the flush is a safety net rather than the mechanism
 *
 * The transport flushes on a 5-second interval which is `unref`'d — it does not
 * hold the process open, but it DOES fire while the loop is alive for other
 * reasons, which for a job doing hours of I/O is essentially always. So the
 * steady state is already covered; what the exit hook protects is the last
 * sub-5-second window, which is exactly where a job's outcome line lands.
 *
 * ponytail: `beforeExit` does not fire when something calls `process.exit()`
 * outright, and eight of the thirteen jobs have at least one such path. Those
 * are abort paths (a stop-loss, an unhandled rejection), and they lose the final
 * window — the same as today, so this is a ceiling and not a regression. Closing
 * it means replacing those calls with `process.exitCode`, which is a change to
 * each job's control flow and belongs in its own ticket.
 */

import { initLogger, flushLogs, getLogger } from "@usemoney/logger";
import { flushMetrics } from "@usemoney/datadog/metrics";
import { installLogRedaction, setConsoleForwarder } from "../log-boundary";

/**
 * How long a signal handler will wait for the flush before exiting anyway.
 * Cloud Run's grace period is ~10s, so this stays well inside it.
 */
const SIGNAL_FLUSH_TIMEOUT_MS = 2000;

/**
 * Route `console.*` into the Datadog stream. Call AFTER `initLogger()`.
 *
 * Exported because the long-running SERVICES need it too, and that was missed
 * the first time: `workers/src/index.ts` and `realtime/main.ts` both attached
 * the stream and neither forwarded anything into it, so the service kept
 * shipping nothing while ten job types ran through it. Measured in prod after
 * the deploy — 10 jobs reported metrics in two hours and `service:stockbook-workers`
 * had zero logs.
 *
 * Idempotent in effect: `setConsoleForwarder` replaces whatever was registered,
 * and `installLogRedaction` no-ops if already installed.
 */
export function forwardConsoleToDatadog(): void {
  installLogRedaction();

  const log = getLogger();
  setConsoleForwarder((level, args) => {
    const message = args
      .map((a) =>
        typeof a === "string"
          ? a
          : a instanceof Error
            ? (a.stack ?? a.message)
            : safeStringify(a),
      )
      .join(" ");
    // pino writes to process.stdout directly rather than through console, so
    // this cannot recurse back into the wrapper that called it.
    if (level === "error") log.error(message);
    else if (level === "warn") log.warn(message);
    else log.info(message);
  });
}

/** Never let an un-serialisable argument cost a log line. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Guards the EXIT path only.
 *
 * `beforeExit` can fire more than once, and it plus a signal can race, so the
 * shutdown flush must not run twice over the same buffer. It must NOT guard
 * explicit calls: a `flushed` flag shared with {@link flushJobTelemetry} made
 * every call after the first a silent no-op, so a job that flushed mid-run then
 * shipped nothing at exit. Caught by the delivery test, not by review.
 */
let exitFlushStarted = false;

async function flushTelemetry(): Promise<void> {
  // Never let telemetry failure change a job's outcome — but do not swallow it
  // into nothing either; the transport itself reports on stderr when it cannot
  // load, which is the case this whole ticket was about.
  await flushLogs().catch(() => undefined);
  await flushMetrics().catch(() => undefined);
}

/** The exit-path flush: at most once, however many times a hook fires. */
async function flushOnExit(): Promise<void> {
  if (exitFlushStarted) return;
  exitFlushStarted = true;
  await flushTelemetry();
}

/**
 * Call once, as early as possible, before anything logs.
 *
 * Idempotent: `initLogger()` guards on a global, so a second call is a no-op
 * rather than a second multistream.
 */
export async function initJobTelemetry(): Promise<void> {
  await initLogger();

  // ATTACHING THE STREAM IS NOT ENOUGH, and the first version of this stopped
  // there. `initLogger()` puts the Datadog transport on the pino root logger —
  // but almost nothing in these processes writes to pino. `workers/src` has
  // ~573 `console.*` calls against 3 `getLogger()` uses; every job script
  // defines its own `console.log` shim (`tiingo-us-backfill.ts` even explains
  // why: `getLogger()` is keyed to a fixed module union with no entry for a
  // script); and `reportJobOutcome` — the one line the log monitors are built
  // around — is a `console.log` in `job-outcome.ts`.
  //
  // So the console is the log surface, and the redaction boundary is the only
  // place that sees all of it. Installing it here also closes a gap that had
  // nothing to do with Datadog: it was installed by exactly two files, so none
  // of the thirteen jobs was redacting console output at all.
  forwardConsoleToDatadog();

  // `beforeExit` fires when the loop drains, which is how these jobs end — they
  // set `process.exitCode` and return rather than calling `process.exit()`.
  process.on("beforeExit", () => {
    void flushOnExit();
  });

  // Cloud Run sends SIGTERM when it reclaims a task. Flush, then EXIT —
  // explicitly, with the conventional 128+signal code.
  //
  // The exit is not optional and the first version of this omitted it. Adding a
  // listener for SIGTERM or SIGINT REPLACES Node's default disposition, so a
  // handler that does not exit leaves the process running: verified by probe,
  // a node process with a no-op SIGTERM listener survived the signal and had to
  // be SIGKILLed. None of the thirteen jobs had a signal handler before this
  // helper, so that would have turned prompt termination into a hang until
  // Cloud Run's grace period expired — across every job at once, and only ever
  // visible on a reclaimed task.
  //
  // The flush is bounded for the same reason: a hung transport must not be able
  // to hold the process past the grace period either. Losing the last window is
  // the acceptable outcome here; refusing to die is not.
  for (const [sig, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    process.on(sig, () => {
      const bounded = Promise.race([
        flushOnExit(),
        new Promise<void>((resolve) => {
          // Deliberately NOT unref'd. An unref'd timer lets the loop drain
          // while the flush is still in flight, so the process can exit with
          // the job's own code instead of the signal's. Two seconds is bounded
          // anyway — holding the loop for at most that is the point.
          setTimeout(resolve, SIGNAL_FLUSH_TIMEOUT_MS);
        }),
      ]);
      void bounded.finally(() => process.exit(code));
    });
  }
}

/** Flush explicitly, for a job that wants the guarantee before it returns. */
export async function flushJobTelemetry(): Promise<void> {
  // Always flushes. Unlike the exit path this is not guarded — a job may call
  // it as often as it likes, and each call must actually ship.
  await flushTelemetry();
}
