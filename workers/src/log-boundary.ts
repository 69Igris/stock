/**
 * Process-wide console redaction — MONEY-1209.
 *
 * ## Why a global wrapper and not 156 edited call sites
 *
 * `workers/src` has ~459 `console.log` / `console.warn` / `console.error` calls
 * (~156 of them `console.error`), and the leak needs only ONE of them to print a
 * ky/got/axios error: those errors carry the credentialed request on their own
 * enumerable properties, so `console.error("[job] failed:", err)` publishes the
 * live NSE session cookie to Cloud Logging, where it is retained and indexed.
 *
 * `workers/src/index.ts:169` already has a `logError` helper, but it is wired to
 * exactly one consumer — the OIDC gate in `index-auth-logic.ts` — so hardening
 * it would have covered 1 of 459 sites while looking like a fix. Editing all 459
 * fixes today's leak and none of tomorrow's: the next processor to be written
 * types `console.error(err)` out of habit and reopens it. A boundary at the
 * transport is the only version of this that stays true.
 *
 * ## Boundary, not policy
 *
 * This module deliberately owns no rules. What counts as a credential lives in
 * `@usemoney/utils/log-redaction`, which is where `apps/web`, `apps/api` and the
 * pino serializers in `@usemoney/logger` read it from too — one definition, so a
 * newly discovered cookie name is added once rather than in four places that
 * drift.
 *
 * ## No kill switch, on purpose
 *
 * Most toggles in this repo exist because the guarded behaviour can fail closed
 * and take a job with it. This one cannot: `redactSensitive` is total — every
 * recursive edge is inside a try/catch that degrades a single node to
 * "[unserializable]" — so the worst case is a less readable log line, never a
 * lost one and never a thrown handler. An env flag here would only be a way to
 * turn the leak back on and forget.
 */

import { redactSensitive } from "@usemoney/utils/log-redaction";

/** The console methods every worker call site actually uses. */
const WRAPPED_METHODS = ["log", "warn", "error"] as const;
type WrappedMethod = (typeof WRAPPED_METHODS)[number];

type ConsoleFn = (...args: unknown[]) => void;

/**
 * `Symbol.for` rather than a module-level `let`.
 *
 * The worker bundle is one ESM module graph, but this file is also imported by
 * tests and by `tsx` in dev, where a module can be evaluated more than once. A
 * module-scoped flag is per-COPY and would let a second copy wrap the already
 * wrapped console — harmless for output (the redaction is idempotent) but it
 * makes the restore path ambiguous, and an unrestorable console is a bad thing
 * to own in a test process.
 */
const STATE_KEY = Symbol.for("usemoney.log-redaction.state");

interface BoundaryState {
  /** The console functions as they were before we wrapped them. */
  originals: Partial<Record<WrappedMethod, ConsoleFn>>;
}

type StatefulGlobal = typeof globalThis & {
  [STATE_KEY]?: BoundaryState;
};

function getState(): BoundaryState | undefined {
  return (globalThis as StatefulGlobal)[STATE_KEY];
}

/**
 * Route every `console.log` / `console.warn` / `console.error` argument through
 * {@link redactSensitive} before it reaches the real console.
 *
 * Idempotent: a second call is a no-op and leaves the same function objects on
 * `console`, so double-installing cannot double-wrap or lose the originals.
 *
 * Install it as the FIRST statement of the entry point. Anything that logs
 * before this runs — a module-level side effect, a failed import, the tracer's
 * own boot output — logs unredacted, and "the request that failed at startup" is
 * precisely the shape that carries headers.
 */
/**
 * Called with every redacted console line, if one is registered.
 *
 * This exists because attaching a stream to pino reaches almost nothing here.
 * `workers/src` has ~573 `console.*` calls against 3 `getLogger()` uses, all
 * thirteen job scripts define their own `console.log` shim rather than take a
 * logger, and `reportJobOutcome` — the single line the whole log-monitoring
 * story is built on — is a `console.log`. So the console IS the log surface,
 * and this boundary is the only place that sees all of it.
 *
 * It runs AFTER redaction, deliberately: whatever is forwarded off the box has
 * already been through `redactSensitive`.
 */
type ConsoleForwarder = (level: WrappedMethod, args: unknown[]) => void;

let forwarder: ConsoleForwarder | undefined;

/**
 * Register (or clear, with `undefined`) the sink that receives console lines.
 *
 * Kept separate from `installLogRedaction()` so the redaction boundary stays
 * usable on its own — it is a security control and must not depend on whether
 * anything is shipping logs.
 */
export function setConsoleForwarder(fn: ConsoleForwarder | undefined): void {
  forwarder = fn;
}

export function installLogRedaction(): void {
  if (getState()) return;

  const originals: Partial<Record<WrappedMethod, ConsoleFn>> = {};
  const target = console as unknown as Record<WrappedMethod, ConsoleFn>;

  for (const method of WRAPPED_METHODS) {
    const original = target[method];
    if (typeof original !== "function") continue;
    originals[method] = original;
    target[method] = (...args: unknown[]): void => {
      // `redactSensitive` cannot throw, so no try/catch here would ever fire —
      // but `original.apply` can (a closed stream on shutdown, EPIPE), and a
      // console call that throws would take down the job it was only reporting
      // on. Swallowing is correct at a logging boundary.
      try {
        original.apply(
          console,
          args.map((arg) => redactSensitive(arg)),
        );
      } catch {
        /* the log line is already lost; do not lose the job with it */
      }

      // Forward AFTER the console write, and never let it affect the job. A
      // sink that throws or blocks must not be able to break the thing it is
      // only observing — the same rule the redaction wrapper above follows.
      if (forwarder) {
        try {
          forwarder(
            method,
            args.map((arg) => redactSensitive(arg)),
          );
        } catch {
          /* a broken sink must never cost a console line, let alone a job */
        }
      }
    };
  }

  (globalThis as StatefulGlobal)[STATE_KEY] = { originals };
}

/**
 * Restore the console methods captured by {@link installLogRedaction}.
 *
 * Exists for tests: a test that stubs `console.error` needs to install over its
 * own stub and then hand the real one back, and a global that survives the
 * module registry has to be resettable or the next test file inherits it.
 * Production never calls this.
 */
export function uninstallLogRedaction(): void {
  const state = getState();
  if (!state) return;

  const target = console as unknown as Record<WrappedMethod, ConsoleFn>;
  for (const method of WRAPPED_METHODS) {
    const original = state.originals[method];
    if (original) target[method] = original;
  }
  delete (globalThis as StatefulGlobal)[STATE_KEY];
}

/** Whether the console is currently wrapped. Exported for tests and health checks. */
export function isLogRedactionInstalled(): boolean {
  return getState() !== undefined;
}
