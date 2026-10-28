/**
 * Is this failure worth trying AGAIN? MONEY-1608 review.
 *
 * A retry that fires on every throw turns a PERMANENT fault into a very long
 * silence: a missing `candles/` grant is a 403 on every read, and at
 * 15 + 60 + 240 s per symbol across 23,389 symbols / 16 workers it is ~128 h
 * of waiting before anything is reported. So only failures that a later
 * attempt can plausibly get past are transient; everything else — 4xx, a
 * missing bucket, a validation error, a bug — is refused on the first try.
 *
 * Transient:
 *   - network-layer codes (reset, refused, timeout, DNS);
 *   - HTTP 408, 429 and 5xx, however the client carries the status;
 *   - the storage SDK's own "Retry limit exceeded" — it raises that ONLY after
 *     its `retryableErrorFn` accepted the error, and with `maxRetries = 0`
 *     (every upload without a precondition) it raises it on the first one;
 *   - our own upload verdicts that mean "outcome unknown": a deadline, or a
 *     write stream that closed without finishing;
 *   - Prisma's connection-level codes (P1001 unreachable, P1002 timed out,
 *     P1008 operation timed out, P1017 connection closed, P2024 pool timeout).
 *
 * The cause chain (`err.cause`) is walked, because fetch-layer errors wrap the
 * socket error that actually says what happened.
 */

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const PRISMA_TRANSIENT = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

const TRANSIENT_MESSAGE =
  /Retry (total time )?limit exceeded|timed out after \d+ms|CLOSED without finishing/;

function transientStatus(n: unknown): boolean {
  const s = typeof n === "string" && /^\d{3}$/.test(n) ? Number(n) : n;
  return (
    typeof s === "number" && (s === 408 || s === 429 || (s >= 500 && s < 600))
  );
}

export function isTransientError(err: unknown): boolean {
  for (let e = err, depth = 0; e && depth < 5; depth++) {
    if (typeof e !== "object") return false;
    const x = e as {
      code?: unknown;
      errorCode?: unknown;
      status?: unknown;
      response?: { status?: unknown };
      message?: unknown;
      cause?: unknown;
    };
    if (typeof x.code === "string" && NETWORK_CODES.has(x.code)) return true;
    if (typeof x.code === "string" && PRISMA_TRANSIENT.has(x.code)) return true;
    if (typeof x.errorCode === "string" && PRISMA_TRANSIENT.has(x.errorCode)) {
      return true;
    }
    if (transientStatus(x.code)) return true;
    if (transientStatus(x.status)) return true;
    if (transientStatus(x.response?.status)) return true;
    if (typeof x.message === "string" && TRANSIENT_MESSAGE.test(x.message)) {
      return true;
    }
    e = x.cause;
  }
  return false;
}

/**
 * The HTTP status an error carries, however the client spelled it — or null.
 * GCS `ApiError` puts it in `code`, gaxios in `status` / `response.status`.
 */
export function httpStatusOf(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const x = err as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  for (const v of [x.code, x.status, x.response?.status]) {
    const n = typeof v === "string" && /^\d{3}$/.test(v) ? Number(v) : v;
    if (typeof n === "number" && n >= 100 && n < 600) return n;
  }
  return null;
}
