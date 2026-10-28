import pino from "pino";
import type { DestinationStream } from "pino";
import type { Writable } from "node:stream";
import { pinoConfig, getLogLevel, isDevelopment } from "./config";
import type { Logger, LoggerModule } from "./types";

/**
 * HMR-safe singleton - see B7 fix in apps/web/lib/logger/index.ts for
 * the detailed rationale. Next.js dev rebuilds re-evaluate this file
 * across HMR cycles; without globalThis caching each rebuild spins up a
 * fresh pino-pretty worker thread that attaches new listeners on
 * stdout/stderr, eventually tripping MaxListenersExceededWarning.
 */
type LoggerGlobal = typeof globalThis & {
  __usemoneyPkgRootLogger?: Logger;
  __usemoneyPkgInitAttempted?: boolean;
  /**
   * The Datadog stream itself. Held because `pino.multistream()` has no
   * `flush`, so it is unreachable through the logger it is attached to.
   */
  __usemoneyPkgDatadogStream?: { flushNow?: () => Promise<void> };
  __usemoneyPkgMaxListenersBumped?: boolean;
};
const g = globalThis as LoggerGlobal;

function bumpMaxListenersOnce(): void {
  if (g.__usemoneyPkgMaxListenersBumped) return;
  // 0 = unlimited. Multistream + Datadog + dev-pretty + per-route
  // children all share stdout/stderr; a hard cap is just a footgun.
  //
  // process.stdout / stderr are undefined under the Edge runtime AND
  // when this module gets pulled into a client bundle (Next can do
  // that transitively via tree-shaking). The optional-chain on the
  // STREAM itself - not just the setMaxListeners method - keeps the
  // logger import safe in those environments.
  process.stdout?.setMaxListeners?.(0);
  process.stderr?.setMaxListeners?.(0);
  g.__usemoneyPkgMaxListenersBumped = true;
}

/**
 * Create a multistream for production that sends logs to both stdout and Datadog.
 *
 * Uses pino.multistream() instead of pino transport targets to avoid worker thread
 * module resolution issues in Docker builds where @usemoney/datadog exports raw .ts.
 *
 * Returns undefined if DD_API_KEY is not set (logs go to stdout only via default pino).
 */
async function createProductionStream(): Promise<
  DestinationStream | undefined
> {
  if (isDevelopment) return undefined;
  if (!process.env.DD_API_KEY) return undefined;

  // A LITERAL specifier, WITH webpackIgnore. Both halves are load-bearing and
  // they answer to different bundlers.
  //
  // The specifier used to be a variable, which makes the import invisible to
  // esbuild — so tsup left it as a RUNTIME `import()` and the transport was
  // never bundled into workers/dist. At runtime it resolved to
  // `packages/datadog/src/logger-transport.ts`, a raw TypeScript file Node
  // cannot load, which threw straight into `initLogger`'s catch and fell back
  // to stdout-only. Silently: `stockbook-workers` shipped ZERO log lines to
  // Datadog for the entire life of the us5 org, while `[job-outcome]` printed
  // perfectly to Cloud Logging and every log monitor sat in NO DATA
  // (MONEY-1375). The comment ten lines up warned about exactly this shape and
  // the code below it caused it.
  //
  // Measured on the built bundle: `maxBatchSize` and the transport's own
  // "Swallow network errors" string appear ZERO times in workers/dist/index.js,
  // while `@usemoney/datadog/constants` — imported literally elsewhere — is
  // bundled. Literal is what gets bundled.
  //
  // `webpackIgnore` is what stops WEBPACK following it. `@usemoney/logger` is
  // reachable from a client component — the real trace is
  // `home/client.tsx -> core/subscription -> gemini/pricing -> logger` — so
  // without it Next tries to pull `logger-transport.ts` into the BROWSER bundle
  // and dies on its `node:stream` import ("UnhandledSchemeError"). Removing the
  // comment alongside the variable broke `yarn build`, which is how this was
  // found; the comment was never the defect, the variable was.
  //
  // esbuild does not read webpack magic comments, so it still sees a literal
  // specifier and bundles the module into every worker entry. One line, two
  // bundlers, opposite instructions — which is exactly why it needs saying.
  //
  // It stays DYNAMIC so the module is only loaded when DD_API_KEY is set, which
  // keeps local dev and tests off the Datadog import entirely.
  const mod = (await import(
    /* webpackIgnore: true */ "@usemoney/datadog/logger-transport"
  )) as {
    default: (opts: { apiKey?: string; service?: string }) => Writable;
  };
  const ddStream = mod.default({
    apiKey: process.env.DD_API_KEY,
    service: process.env.DD_SERVICE,
  });
  // Held so `flushLogs()` can reach it. Going through pino cannot work:
  // `pino.multistream()` implements no `flush`, so pino's own call falls
  // straight to the callback having flushed nothing.
  g.__usemoneyPkgDatadogStream = ddStream as { flushNow?: () => Promise<void> };

  return pino.multistream([
    { stream: process.stdout, level: getLogLevel() },
    { stream: ddStream, level: getLogLevel() },
  ]);
}

/**
 * Initialize the logger with optional Datadog multistream.
 * Call this early in service startup (e.g. in the entry point) to enable
 * Datadog log forwarding. If not called, the logger falls back to stdout-only.
 */
export async function initLogger(): Promise<void> {
  if (g.__usemoneyPkgInitAttempted) return;
  g.__usemoneyPkgInitAttempted = true;

  bumpMaxListenersOnce();

  try {
    const stream = await createProductionStream();
    g.__usemoneyPkgRootLogger = stream
      ? pino(pinoConfig, stream)
      : pino(pinoConfig);
  } catch (err) {
    // Fall back to plain pino — logging must never take the process down. But
    // SAY SO. This catch swallowed a module-resolution failure for the entire
    // life of the us5 org, and the only symptom was log monitors sitting in NO
    // DATA, which is indistinguishable from a quiet service. One line on stderr
    // is the difference between "nothing was logged" and "the transport is
    // broken"; it goes to the platform's own log sink, which is by definition
    // still working when this path is reached.
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr?.write?.(
      `[logger] Datadog transport unavailable, falling back to stdout only: ${reason}\n`,
    );
    g.__usemoneyPkgRootLogger = pino(pinoConfig);
  }
}

/**
 * Initialize and get the root logger instance.
 * If initLogger() hasn't been called yet, creates a basic logger (stdout only).
 */
function getRootLogger(): Logger {
  if (!g.__usemoneyPkgRootLogger) {
    bumpMaxListenersOnce();
    g.__usemoneyPkgRootLogger = pino(pinoConfig);
  }
  return g.__usemoneyPkgRootLogger;
}

/**
 * Get a logger instance with optional module context
 *
 * @param module - Module name for categorization
 * @returns Logger instance with module context
 *
 * @example
 * ```typescript
 * import { getLogger } from '@usemoney/logger';
 *
 * const logger = getLogger('cache');
 * logger.info({ key: 'user:123' }, 'Cache hit');
 * ```
 */
export function getLogger(module?: LoggerModule): Logger {
  const root = getRootLogger();

  if (module) {
    return root.child({ module });
  }

  return root;
}

/**
 * Create pre-configured loggers for common modules
 */
export function createModuleLoggers() {
  return {
    /** Cache operations logger */
    cache: getLogger("cache"),
    /** Database operations logger */
    db: getLogger("database"),
    /** API routes logger */
    api: getLogger("api"),
    /** Authentication logger */
    auth: getLogger("auth"),
    /** Broker sync logger */
    sync: getLogger("broker-sync"),
    /** Redis operations logger */
    redis: getLogger("redis"),
    /** Payment operations logger */
    payments: getLogger("payments"),
    /** Subscription operations logger */
    subscription: getLogger("subscription"),
    /** Feature flags logger */
    featureFlags: getLogger("feature-flags"),
    /** Gemini LLM operations logger */
    gemini: getLogger("gemini"),
    /** Admin operations logger */
    admin: getLogger("admin"),
    /** Content operations logger */
    content: getLogger("content"),
  };
}

/**
 * Pre-configured loggers for common modules
 * Use these for consistency across the codebase
 */
export const cacheLogger = getLogger("cache");
export const dbLogger = getLogger("database");
export const apiLogger = getLogger("api");
export const authLogger = getLogger("auth");
export const syncLogger = getLogger("broker-sync");
export const redisLogger = getLogger("redis");
export const paymentsLogger = getLogger("payments");
export const subscriptionLogger = getLogger("subscription");
export const featureFlagsLogger = getLogger("feature-flags");
export const geminiLogger = getLogger("gemini");
export const adminLogger = getLogger("admin");
export const contentLogger = getLogger("content");

/**
 * Default export for convenience
 * Use `getLogger()` for a plain logger or `getLogger('module')` for a module logger
 */
export default getLogger;

/**
 * Flush logs before shutdown (important for production)
 * Call this in shutdown handlers
 */
export async function flushLogs(): Promise<void> {
  // THE DATADOG STREAM FIRST, and directly.
  //
  // This used to be `root.flush(cb)` alone, which is a NO-OP whenever the
  // Datadog multistream is attached: `pino.multistream()` exposes
  // write/add/flushSync/end/clone and no `flush`, so pino falls through to the
  // callback having sent nothing. Measured before this change — a job that
  // logged its outcome and returned shipped ZERO lines, and a 7-second job
  // shipped only what happened to land on the 5s interval, losing the final
  // `[job-outcome]` line. The call resolved cleanly throughout, so every
  // shutdown path reported a flush that never happened.
  const dd = g.__usemoneyPkgDatadogStream;
  if (dd?.flushNow) {
    await dd.flushNow().catch(() => undefined);
  }

  // Then pino, for the stdout side and for any transport that does implement
  // it. Harmless when the multistream is attached; correct when it is not.
  const root = g.__usemoneyPkgRootLogger;
  if (root) {
    await new Promise<void>((resolve) => {
      root.flush(() => {
        resolve();
      });
    });
  }
}

// Export types
export type {
  Logger,
  LoggerModule,
  LogLevel,
  LogContext,
  ErrorLogContext,
  PerformanceLogContext,
  CacheLogContext,
  DatabaseLogContext,
  ApiLogContext,
} from "./types";

// Export config
export { pinoConfig, currentLogLevel } from "./config";
