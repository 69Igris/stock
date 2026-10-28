import pino from "pino";
import {
  REDACTED,
  SENSITIVE_KEY_PATTERN,
  redactSensitive,
} from "@usemoney/utils/log-redaction";

/**
 * Determine if we're in development mode
 */
const isDevelopment = process.env.NODE_ENV === "development";

/**
 * Get log level from environment or use defaults
 * Development: debug
 * Production: info
 */
export const getLogLevel = (): pino.Level => {
  const envLevel = process.env.LOG_LEVEL;
  if (envLevel && isValidLogLevel(envLevel)) {
    return envLevel as pino.Level;
  }
  return isDevelopment ? "debug" : "info";
};

/**
 * Validate log level
 */
function isValidLogLevel(level: string): boolean {
  const validLevels = ["trace", "debug", "info", "warn", "error", "fatal"];
  return validLevels.includes(level);
}

/**
 * Whether we're in development mode (exported for use in index.ts).
 */
export { isDevelopment };

/**
 * Build the transport configuration.
 *
 * - Development: pino-pretty to stdout
 * - Production: no transport (JSON to stdout). Datadog is handled via multistream in initLogger().
 */
function getTransport(): pino.TransportSingleOptions | undefined {
  if (isDevelopment) {
    return {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
        singleLine: false,
        messageFormat: "[{module}] {msg}",
      },
    };
  }

  return undefined;
}

/**
 * `pino.stdSerializers.err` narrowed to what it can actually handle.
 *
 * Callers pass whatever they have — `logger.error({ error: someString })` is
 * common — and the std serializer is typed for `Error`. The instanceof check
 * keeps the non-Error case honest instead of casting a lie through it; pino
 * itself does the same guard internally.
 */
function errOrPassthrough(value: unknown): unknown {
  return value instanceof Error ? pino.stdSerializers.err(value) : value;
}

/**
 * Compose any pino serializer with the log redactor.
 *
 * Generic rather than four hand-written wrappers so the redaction cannot be
 * silently omitted from one of them, and so adding a serializer later is a
 * one-word decision rather than a copy-paste that might forget.
 */
function redacting<T>(serialize: (value: T) => unknown): (value: T) => unknown {
  return (value: T) => redactSensitive(serialize(value));
}

/**
 * The four keys pino serializes, and the ONLY source of truth for that list.
 *
 * `formatters.log` below has to skip exactly these, so it reads this object
 * rather than a second hand-written list that could drift out of agreement with
 * it — a drift that would either double-walk an error or silently reopen the
 * hole `formatters.log` exists to close.
 *
 * MONEY-1209: each one is wrapped in `redactSensitive`. pino does NOT go
 * through `console`, so `workers/src/log-boundary.ts` cannot see these lines —
 * pino writes JSON straight to its own stream (stdout plus the Datadog
 * multistream). And unlike `util.inspect`, `JSON.stringify` has no depth
 * limit at all, so a pino error line publishes the ENTIRE subtree. Measured
 * output before this wrapper, from `logger.error({ error: kyErr }, "failed")`:
 *
 *   {"level":50,...,"error":{"type":"Error","message":"boom",...,
 *    "options":{"headers":{"cookie":"ak_bmsc=<live session>"}}},"msg":"failed"}
 *
 * `stdSerializers.err` is what puts it there: it copies every own enumerable
 * property off the error, which for a ky/got/axios error is `request` /
 * `options` / `config` / `response` — the credentialed request itself. The
 * wrapper runs AFTER it, on the flattened plain object, so nothing is hidden
 * from the redactor by the serializer's own reshaping.
 *
 * `req` and `res` are the same class of bug seen from the other side: pino's
 * standard HTTP serializers include `headers` verbatim, which on an inbound
 * request is the caller's `cookie` and `authorization`.
 */
const SERIALIZERS = {
  error: redacting(errOrPassthrough),
  // pino's default error key is `err`, which no config can turn off; leaving
  // it unwrapped would mean the leak simply moves one key over.
  err: redacting(errOrPassthrough),
  req: redacting(pino.stdSerializers.req),
  res: redacting(pino.stdSerializers.res),
};

/**
 * Redact a hand-built log object, leaving the serialized keys to their
 * serializers.
 *
 * This is `formatters.log`. It is the layer that actually covers a credential
 * on a line nobody serialized — `logger.info({ conn: { accessToken } })` — and
 * it replaces the sixteen `redact` wildcards that MONEY-716 shipped and
 * `a92bcc32` removed for cost. It is not a compromise for them: it is cheaper
 * AND strictly stronger. Re-measured on this branch against real pino 10.2, 5
 * interleaved rounds x 200k iterations, a realistic request-path object and a
 * no-op sink (medians). The absolute numbers run ~3x a92bcc32's because this
 * box was loaded, so the RATIOS are the reading, and they reproduce its shape:
 *
 *   baseline, no redact                       3,517 ns/line    1.00x
 *   the three concrete `redact` paths below   5,938 ns/line    1.69x
 *   + ONE `*.k` wildcard                      9,533 ns/line    2.71x
 *   + the SIX wildcards whose loss regressed 21,636 ns/line    6.15x
 *   + all sixteen MONEY-716 shipped          39,004 ns/line   11.09x
 *   + this                                    8,372 ns/line    2.38x
 *
 * So it costs LESS than a single wildcard and about a third of restoring just
 * the six, while reaching every depth, walking into arrays, and applying the
 * session-cookie STRING rule that no path-based redaction can express.
 *
 * IT MUST SKIP THE SERIALIZED KEYS, and that is measured rather than tidiness.
 * `formatters.log` runs BEFORE the per-key serializers (pino `lib/tools.js`
 * `_asJson`), so walking `req` here deep-copies a live `IncomingMessage` — and
 * `headers` is a PROTOTYPE ACCESSOR in modern Node, so `Object.keys` never sees
 * it. A real inbound request, measured both ways:
 *
 *   skipping (this):  {"req":{"method":"GET","url":"/","headers":{"cookie":
 *                      "[REDACTED]",...},"remoteAddress":"::1",...}}
 *   walking it:       {"req":{"method":"GET","url":"/"}}
 *
 * The second is not "safer". It silently deletes the diagnostics MONEY-1209's
 * `req`/`res` serializers exist to keep, and hollows out the
 * `res.headers["set-cookie"]` backstop. These keys are already redacted by
 * `SERIALIZERS`, so skipping them costs nothing and avoids walking twice.
 *
 * THE DEPTH BUDGET STAYS AT `redactSensitive`'s DEFAULT OF 6. The objection
 * that a deep diagnostic payload would start truncating platform-wide was
 * measured, not waved off: across all 1,088 object-literal logger call sites in
 * apps/, packages/ and workers/, 1,078 are FLAT and the deepest is nesting 3 —
 * so 6 has better than 2x headroom on the worst real payload. Raising it is
 * actively worse: at `Infinity` a 5,000-deep chain blows the stack and the
 * whole subtree degrades to `[unserializable]`, where a bounded depth degrades
 * to a predictable, local `[truncated]`.
 *
 * The residual ceiling, stated rather than discovered later: `NODE_BUDGET`
 * (5,000 nodes, ~150 KB of one JSON line) still truncates, and a credential
 * under a key name `SENSITIVE_KEY_PATTERN` does not know is still uncovered.
 * `email` and `phone` are deliberately outside that pattern — see the audit
 * note on `redact` below.
 */
function redactLogObject(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    out[key] = Object.hasOwn(SERIALIZERS, key)
      ? obj[key]
      : SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : redactSensitive(obj[key]);
  }
  return out;
}

/**
 * Pino configuration for development and production
 */
export const pinoConfig: pino.LoggerOptions = {
  level: getLogLevel(),

  transport: getTransport(),

  // MONEY-716, narrowed by MONEY-1229 — three CONCRETE paths, and deliberately
  // NO WILDCARDS. The depth coverage the wildcards used to provide now lives in
  // `formatters.log` (`redactLogObject` above), which is cheaper than ONE of
  // them and reaches every depth instead of exactly one; the measured table is
  // there rather than duplicated here.
  //
  // `pinoConfig` backs every logger in apps/web, apps/api and workers, so
  // whatever is in this list is paid on EVERY line the platform emits, and the
  // cost is LINEAR in the wildcard count (~+3.6 µs each on this box, 5,938 ->
  // 9,533 ns/line for the first): every `*.k` walks the object's own top-level
  // keys on every line, and once ANY wildcard exists pino swaps its stringifier
  // for every key.
  //
  // WHAT A WILDCARD BUYS FOR THAT, now that `formatters.log` is wired: nothing.
  // `*` matches EXACTLY ONE LEVEL, measured, not assumed — `*.cookie` covers
  // `{ headers: { cookie } }` and reaches NEITHER a top-level `cookie` NOR
  // `{ req: { headers: { cookie } } }`, and an array element counts as a level.
  // `redactLogObject` covers all three, so a wildcard here would be a strictly
  // weaker copy of it at 1.5x the price. A test keeps them out.
  //
  // The real incident is MONEY-1209 — a ky `HTTPError` logged raw published
  // live NSE session cookies into prod Cloud Logging, where they are retained,
  // indexed and replayable by anyone with project log access. That is the
  // SERIALIZERS' job, and they cost nothing on a line that carries no
  // `error` / `err` / `req` / `res` key.
  //
  // These three stay because they are the backstop for NARROWING one of those
  // serializers, and together they cost ~100 ns (98 and 125 across two rounds):
  // `pino.stdSerializers.res` emits `headers` only for a real `ServerResponse`,
  // so `res.headers["set-cookie"]` does not fire today at all — removing the
  // serializer would otherwise reopen the path in silence.
  //
  // ORDER, measured against pino 10.2 rather than assumed (lib/tools.js
  // `_asJson`): `formatters.log` runs FIRST, then the serializer for that key,
  // and only then is the redactor used AS the stringifier. So these paths are
  // matched against the POST-serializer shape, which is why
  // `req.headers.authorization` still names a real path after
  // `pino.stdSerializers.req` has reshaped the request.
  //
  // NEVER ADD A BARE `email` — here or to `SENSITIVE_KEY_PATTERN`. Nine call
  // sites log one at the TOP level and two of them are audit lines whose whole
  // purpose is naming who acted —
  // `packages/services/src/account-deletion.service.ts` and
  // `payment-provisioning.service.ts` — so it would turn the record into
  // "somebody deleted a user". Pinned in both directions by a test.
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
    ],
    censor: REDACTED,
  },

  // Custom formatters
  formatters: {
    // The DEEP redaction layer. See `redactLogObject` above for the
    // measurement, and for why it must not walk the serialized keys.
    log: redactLogObject,

    level: (label: string) => {
      return { level: label };
    },
    bindings: (bindings: pino.Bindings) => {
      return {
        pid: bindings.pid,
        hostname: bindings.hostname,
      };
    },
  },

  // Base fields included in every log
  base: {
    env: process.env.NODE_ENV || "development",
  },

  // ISO timestamp
  timestamp: pino.stdTimeFunctions.isoTime,

  // Serializers for `error` / `err` / `req` / `res`. Defined above, beside
  // `formatters.log`, which has to skip exactly these keys.
  serializers: SERIALIZERS,
};

/**
 * Export log level for testing/debugging
 */
export const currentLogLevel = getLogLevel();
