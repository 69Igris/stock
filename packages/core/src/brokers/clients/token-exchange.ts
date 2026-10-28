/**
 * Shared guards for broker OAuth token exchange — MONEY-1158.
 *
 * ## The defect
 *
 * `static exchangeToken()` in four of the broker clients read `access_token`
 * off the parsed response with no presence check:
 *
 *   | client                  | on a 200 with `access_token` absent      |
 *   | ----------------------- | ---------------------------------------- |
 *   | `upstox.ts`             | stored `accessToken: undefined`          |
 *   | `interactive-brokers.ts`| stored `accessToken: undefined`          |
 *   | `fyers.ts`              | stored `accessToken: undefined`          |
 *   | `zerodha.ts`            | TypeError if the `data` envelope is gone |
 *
 * An `undefined` token is then encrypted and persisted as a `BrokerConnection`,
 * so the connection LOOKS established and every later sync fails against a
 * credential that was never real. The Zerodha case at least threw loudly; the
 * other three failed silently, which is worse — the user sees a connected
 * broker and a stream of unexplained sync errors.
 *
 * A 200 carrying an error envelope instead of a token is a normal failure mode
 * for OAuth endpoints under rate limiting or a revoked app. It is the same
 * class this repo already fights elsewhere: MONEY-840's 429 circuit-breakers
 * for NSE/BSE, and MONEY-1157's feed-archive payload guard.
 *
 * ## Why the type fix did not close it
 *
 * The four clients were changed to declare `access_token` NON-optional, which
 * only states what the code already unconditionally assumed — it adds no
 * runtime check. Closing it needs a control-flow change, which is this module.
 *
 * ## Scope
 *
 * `hdfc.ts` and `icici.ts` already guard correctly and are deliberately left
 * alone. Their messages are load-bearing in existing logs, and rewriting a
 * working guard on a live credential path buys nothing. New clients should use
 * the helpers here.
 */

/**
 * Which half of the exchange failed.
 *
 * The distinction exists so a `BrokerIntegrationFailure` row is triageable
 * without re-reading the message: `transport` means we never got a usable
 * answer (network, 4xx/5xx) and is often retryable; `payload` means the
 * provider answered 200 and simply did not give us a token, which is an app
 * credential / rate-limit / revocation problem and retrying rarely helps.
 */
export type BrokerTokenFailureKind = "transport" | "payload";

/** A broker OAuth token exchange that did not yield a usable access token. */
export class BrokerTokenExchangeError extends Error {
  /** Broker slug, e.g. "Upstox" — used for log grouping. */
  readonly broker: string;
  readonly kind: BrokerTokenFailureKind;
  /** HTTP status, when the failure was transport-shaped. */
  readonly status?: number;
  /** The provider's own error text, when it supplied one. */
  readonly upstreamMessage?: string;

  constructor(
    broker: string,
    kind: BrokerTokenFailureKind,
    message: string,
    options: { status?: number; upstreamMessage?: string } = {},
  ) {
    super(message);
    this.name = "BrokerTokenExchangeError";
    this.broker = broker;
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.upstreamMessage !== undefined) {
      this.upstreamMessage = options.upstreamMessage;
    }
  }
}

/**
 * The provider answered non-2xx — we never got as far as a payload.
 *
 * `message` is passed in rather than composed here, and that is the important
 * part of this signature. Broker error messages in this repo are LOAD-BEARING
 * STRINGS: `mapKnownBrokerError` matches `"zerodha: the user is not enabled"`
 * to render a specific support card, and `classifyBrokerError` derives
 * `errorClass` / `recoveryAction` by substring — so a generic
 * `"<Broker> token exchange failed: HTTP <n>"` wrapper would silently break the
 * Zerodha card AND, because it contains the word "token", reclassify every 5xx
 * as AUTH_EXPIRED with a "reauth" recovery action.
 *
 * So the classification this ticket asked for lives in the TYPED fields
 * (`kind`, `status`, `upstreamMessage`) and each call site keeps the exact
 * message it produced before. Adding structure must not change strings other
 * code reads.
 */
export function brokerTransportFailure(
  broker: string,
  status: number,
  message: string,
  upstreamMessage?: string,
): BrokerTokenExchangeError {
  const detail = upstreamMessage?.trim();
  return new BrokerTokenExchangeError(broker, "transport", message, {
    status,
    ...(detail ? { upstreamMessage: detail } : {}),
  });
}

/**
 * Narrow a possibly-absent access token to `string`, or throw.
 *
 * This is the guard the four unguarded clients were missing. It returns the
 * token so call sites read `accessToken: requireAccessToken(...)` and CANNOT
 * forget to use the checked value — a separate `if (!token) throw` leaves the
 * unchecked variable in scope, which is how the original bug reads.
 *
 * Rejects the empty string as well as null/undefined: an empty token is
 * encryptable and persistable exactly like `undefined`, and produces the same
 * silently-broken connection.
 */
export function requireAccessToken(
  broker: string,
  token: unknown,
  upstreamMessage?: string,
): string {
  if (typeof token === "string" && token.length > 0) return token;
  throw new BrokerTokenExchangeError(
    broker,
    "payload",
    upstreamMessage
      ? `${broker} returned no access token: ${upstreamMessage}`
      : `${broker} returned a success response with no access token. The app ` +
          `credentials may be revoked, or the request was rate-limited.`,
    { ...(upstreamMessage ? { upstreamMessage } : {}) },
  );
}

/**
 * Narrow a required non-token field (e.g. Kite's `user_id`) to `string`.
 *
 * Same rationale as {@link requireAccessToken}: a connection persisted with an
 * `undefined` broker user id looks established and fails every later sync.
 */
export function requireTokenField(
  broker: string,
  field: string,
  value: unknown,
): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new BrokerTokenExchangeError(
    broker,
    "payload",
    `${broker} returned a success response with no ${field}.`,
  );
}
