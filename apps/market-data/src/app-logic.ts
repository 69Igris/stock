/**
 * The decisions this service makes that are worth testing without a server.
 *
 * Cache headers, CORS origins and token verification are all pure functions of
 * their inputs, and all three fail in ways a running service does not report:
 * a wrong `Cache-Control` caches something private at the edge, a wrong CORS
 * origin is a browser error nobody sees server-side, and a token verifier that
 * accepts an expired token logs nothing at all.
 */

/**
 * `Cache-Control` per route. EXPLICIT on every response, never inherited.
 *
 * The whole point of this service is that a CDN can answer instead of a Vercel
 * function — `udf/config` and `udf/time` return CONSTANTS and still cost p50
 * 0.26 s today. A missing header means the CDN will not cache, the service is
 * then a slower Vercel function with an extra network hop, and nothing errors.
 *
 * PUBLIC, unlike `apps/web`. Web's config route is behind Clerk so its header
 * is `private, max-age=3600`; this service is unauthenticated for daily bars
 * and fronted by Cloud CDN. Same body, opposite caching semantics — which is
 * why `CONFIG_CACHE_CONTROL` was deliberately NOT moved into
 * `@usemoney/core` alongside the payload.
 */
export const CACHE_CONTROL = {
  /** The datafeed config changes only on deploy. */
  config: "public, max-age=3600",
  /**
   * Server time. One second, not zero: TradingView polls this to detect clock
   * skew, and `no-store` would send every poll to the origin for a value that
   * is by definition stale the moment it is sent.
   */
  time: "public, max-age=1",
  /**
   * `s-maxage` only — SHARED caches hold it for 5 minutes, browsers do not.
   * A symbol resolution changes when an instrument is renamed or delisted, and
   * a browser that cached it for five minutes would show a stale name with no
   * way to refresh short of a hard reload.
   */
  symbols: "public, s-maxage=300",
  search: "public, s-maxage=300",
  /**
   * Quotes. PRIVATE, and that word is load-bearing.
   *
   * `public` here would let the CDN hold one user's batch and hand it to the
   * next caller — harmless for a price, NOT harmless for the fact that this
   * particular account asked about these particular symbols. Five seconds is
   * the poll interval of `useLivePositions`, so a tab polling at its natural
   * rate is served from its own browser cache and the origin sees one request
   * per tab per 5s rather than one per poll.
   */
  quotes: "private, max-age=5",
  /**
   * Intraday bars. PRIVATE, because the route is token-gated — a shared cache
   * holding one user's intraday response would serve it to a caller who has no
   * token at all, which is the gate removed by a header.
   *
   * 30 s: the buffer is written as minutes CLOSE, so a shorter TTL buys nothing
   * and a longer one leaves the most recent candle visibly behind the quote.
   */
  intraday: "private, max-age=30",
  /**
   * A LICENSED response — today, US daily bars. PRIVATE, for the same reason
   * `intraday` is, and it is the header that decides whether MONEY-1477's gate
   * exists at all.
   *
   * The US lane is entitlement-gated on the `us` claim. Cloud CDN fronts this
   * origin with `--cache-mode=USE_ORIGIN_HEADERS` and NO
   * `--cache-key-include-http-header`, so the cache key is scheme + host +
   * path + query and carries NOTHING about the caller. `public, s-maxage=3600`
   * on a successful US response therefore stores it at the edge under a URL an
   * anonymous client can replay verbatim — `/udf/history?symbol=AAPL:NASDAQ:
   * 1980-12-12&resolution=1D&from=…&to=…` has no per-user component at all.
   * One founder chart load would publish an hour of Tiingo US OHLC to anyone
   * with the link, which is precisely the redistribution MONEY-1262 has not
   * bought.
   *
   * So the gate and this header are ONE mechanism. A `public` value here does
   * not weaken the check — it removes it, after the check has already passed.
   *
   * `max-age` rather than `s-maxage`: the browser that was entitled may reuse
   * its OWN copy; no shared cache may hold it. 300 s matches the token TTL, so
   * a cached response can never outlive the entitlement that fetched it.
   */
  licensed: "private, max-age=300",
  /**
   * The 501 routes must NOT be cached. A cached 501 outlives the deploy that
   * implements the endpoint — A2/A3 would ship and the edge would keep
   * answering "not implemented" until the TTL expired.
   */
  /**
   * A `no_data` DAILY response. MONEY-1475.
   *
   * NOT the CDN value. `no_data` means "we hold no bars for this window", and
   * that is exactly the state a tile write is about to change — so edge-caching
   * it for an hour makes a blank chart OUTLIVE the backfill that fixed it. A
   * newly-listed symbol whose first tile lands at 21:05 IST answers blank from
   * every POP until 22:05 plus SWR.
   *
   * It is also the state a MISCONFIGURED service produces for every symbol:
   * `readTile` returns `absent` (not `failed`) when the store is unconfigured,
   * so no error path runs and every chart on the platform goes blank — cached.
   *
   * Spelled separately from `notImplemented` despite the identical value: they
   * are different facts, and a future change to one must not silently move the
   * other.
   */
  noData: "no-store",

  notImplemented: "no-store",
  /** Health must never be cached; a cached 200 hides an unhealthy instance. */
  health: "no-store",
} as const;

/**
 * Browser origins allowed to call this service.
 *
 * An allowlist, never `*`: the intraday and US endpoints will carry a bearer
 * token from A5, and `*` with credentials is both rejected by browsers and a
 * mistake worth never making. QA is included so the QA web host can exercise
 * the QA service.
 */
export function getCorsOrigins(env: string | undefined): string[] {
  const base = ["https://usemoney.ai", "https://www.usemoney.ai"];
  const qa = ["https://qa.usemoney.ai"];
  // Local dev gets localhost, and ONLY outside production — a production
  // service that accepts `http://localhost` origins is a CSRF surface that
  // looks like a developer convenience.
  const dev = ["http://localhost:3000", "http://localhost:3001"];
  if (env === "production") return [...base];
  return [...base, ...qa, ...dev];
}

export const CORS_ALLOW_METHODS = ["GET", "OPTIONS"] as const;
/**
 * Request headers a browser may send. THE LIST IS STATIC AND IT MUST BE
 * COMPLETE — this service never echoes `Access-Control-Request-Headers`.
 *
 * ## THE OUTAGE THIS CAUSED, AND WHY NOTHING COULD SEE IT
 *
 * `Authorization` and `Content-Type` were the whole list, and that made the
 * ENTIRE SERVICE unreachable from any browser — every route, both environments.
 *
 * `apps/web` initialises Datadog RUM with
 * `allowedTracingUrls: match: /https:\/\/.*\.usemoney\.ai/` (excluding only
 * `clerk.usemoney.ai`) and `propagatorTypes: ["datadog"]`. That matches
 * `market-data{,-qa}.usemoney.ai`, so RUM injects four `x-datadog-*` headers
 * into every fetch the page makes to this origin. They are not CORS-safelisted,
 * so Chrome preflights — and the preflight answered with a list that does not
 * contain them:
 *
 *     Access to fetch at '…/udf/config' from origin 'http://localhost:3000'
 *     has been blocked by CORS policy: Request header field x-datadog-origin
 *     is not allowed by Access-Control-Allow-Headers in preflight response.
 *
 * The browser reports that as `TypeError: Failed to fetch`. TradingView's
 * vendored datafeed maps ANY `/config` failure to `null` and silently adopts a
 * hardcoded default demanding `/udf/symbol_info?group=NYSE|FOREX|AMEX`, so the
 * chart died with "This symbol doesn't exist" — a symbol-resolution message for
 * a CORS problem.
 *
 * NOTHING SERVER-SIDE COULD OBSERVE IT: the request never arrived.
 * `market-data-smoke.sh` passed 30/30 throughout, and three separate manual
 * checks were all false negatives —
 *   - `curl` neither enforces CORS nor carries RUM's headers;
 *   - an OPTIONS probe asking for `authorization` passes, because that is the
 *     one header already on the list (this endpoint answers 204 with the same
 *     list whatever you ask for, so the 204 proves nothing);
 *   - a Playwright page using `page.route` has CORS enforcement DISABLED for
 *     the whole context, so no harness built that way can ever see this class.
 *
 * Keep this in agreement with `apps/web/lib/datadog/rum-init.ts` —
 * `cors-tracing-headers.test.ts` fails when they drift. Adding a
 * `tracecontext` propagator there would also require `traceparent` and
 * `tracestate` here.
 */
export const CORS_ALLOW_HEADERS = [
  "Authorization",
  "Content-Type",
  // The four the `datadog` propagator sends. Without them the browser never
  // reaches this service at all.
  "x-datadog-origin",
  "x-datadog-trace-id",
  "x-datadog-parent-id",
  "x-datadog-sampling-priority",
] as const;
/**
 * Response headers a BROWSER is allowed to read cross-origin.
 *
 * Without `Access-Control-Expose-Headers` the browser strips every response
 * header except the CORS-safelisted handful — so `X-Bar-Basis` read back as
 * `null` on exactly the deployment it exists for. And the probe maps null to
 * "clear the badge", because a DAILY response legitimately carries no header:
 * the failure is BYTE-IDENTICAL to correct daily behaviour. Users would see
 * `quote_mid` candles with a structural zero-volume histogram and no
 * disclaimer, while it worked perfectly in local dev against the same-origin
 * legacy route.
 *
 * `apps/api/src/app.ts` already passes its own `CORS_EXPOSE_HEADERS`; this
 * service shipped without one.
 */
export const CORS_EXPOSE_HEADERS = [
  "X-Bar-Basis",
  "X-Buffer-Oldest",
  "X-Request-Id",
] as const;
export const CORS_MAX_AGE = 86_400;

/** How long a minted market-data token stays valid. */
export const TOKEN_TTL_SECONDS = 300;
/** The audience every token must carry. */
export const TOKEN_AUDIENCE = "usemoney-market-data";

export interface MarketTokenClaims {
  /** Internal Mongo user id. */
  sub: string;
  aud: string;
  /** Seconds since epoch. */
  exp: number;
  iat: number;
  /**
   * May this token read INTRADAY bars? MONEY-1470 (A5).
   *
   * OPTIONAL in the type and FAIL-CLOSED in the check: a token minted before
   * this claim existed carries no `intraday`, and `undefined` must mean NO. A
   * truthy default would have silently granted intraday to every token already
   * in flight the moment the endpoint shipped.
   *
   * The decision is made ONCE, at mint, by `mayReadIntraday` reading the user's
   * plan and the `MARKET_DATA_INTRADAY` flag. The service enforces it with one
   * HMAC and no I/O, which is the entire reason this token exists rather than a
   * Clerk session.
   */
  intraday?: boolean;
  /**
   * May this token read US market data at all? MONEY-1469/1470.
   *
   * A LICENCE boundary, and deliberately SEPARATE from `intraday`. Tiingo's
   * Commercial plan is INTERNAL USE ONLY: ingest and storage are fine, serving
   * a US price to a user is redistribution and needs the $250/mo plan
   * (MONEY-1262). `apps/web` enforces it with `currentUserMaySeeUsMarket`,
   * which defaults to the FOUNDER ALONE.
   *
   * Folding it into a plan tier would mean writing `{"tiers":["PRO"]}` into one
   * PlatformConfig row — intended to unlock INDIA intraday — shipped 45
   * sessions of Tiingo-derived US OHLC to every PRO subscriber at the same
   * instant, with no deploy and no diff. A plan tier is exactly the product
   * flag the root CLAUDE.md says is the wrong instrument for a licence.
   *
   * OPTIONAL in the type and FAIL-CLOSED in the check, for the same reason as
   * `intraday`: a token minted before this claim existed carries none.
   */
  us?: boolean;
}

/** Fail-closed: only an explicit `true` grants intraday. */
export function tokenMayReadIntraday(claims: MarketTokenClaims): boolean {
  return claims.intraday === true;
}

/** Fail-closed: only an explicit `true` grants US market data. */
export function tokenMayReadUs(claims: MarketTokenClaims): boolean {
  return claims.us === true;
}

export type TokenVerdict =
  | { ok: true; claims: MarketTokenClaims }
  | { ok: false; reason: string };

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verify an HS256 market-data token.
 *
 * Unused until A5 — the intraday and US-realtime endpoints will require it —
 * but written and tested now, because a verifier introduced alongside the first
 * endpoint that needs it is a verifier written under time pressure.
 *
 * Every rejection returns a REASON. A boolean `false` makes "expired",
 * "forged" and "wrong audience" one event in the logs, and they are three
 * different incidents.
 */
export function verifyMarketToken(
  token: string,
  secret: string,
  nowSeconds: number,
  verifyHmac: (data: string, secret: string) => Buffer,
): TokenVerdict {
  if (!secret) return { ok: false, reason: "no signing secret configured" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string; typ?: string };
  let claims: MarketTokenClaims;
  try {
    header = JSON.parse(b64urlToBuf(headerB64).toString("utf8"));
    claims = JSON.parse(b64urlToBuf(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed token" };
  }

  // ALGORITHM PINNED. Accepting the token's own `alg` is the classic JWT
  // forgery: `none` verifies anything, and `RS256` against an HMAC secret lets
  // a public key be used as the signing key.
  if (header.alg !== "HS256")
    return { ok: false, reason: `unsupported alg ${String(header.alg)}` };

  const expected = verifyHmac(`${headerB64}.${payloadB64}`, secret);
  const actual = b64urlToBuf(sigB64);
  // Length check first: `timingSafeEqual` THROWS on a length mismatch, which
  // would surface as a 500 rather than a 401 for the easiest forgery to write.
  if (expected.length !== actual.length)
    return { ok: false, reason: "bad signature" };
  if (!constantTimeEqual(expected, actual))
    return { ok: false, reason: "bad signature" };

  if (claims.aud !== TOKEN_AUDIENCE) {
    return { ok: false, reason: `wrong audience ${String(claims.aud)}` };
  }
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  // A token whose lifetime EXCEEDS the policy is refused even if unexpired: it
  // was minted by something that does not share this service's rules, and the
  // only safe reading of that is "not ours".
  if (
    typeof claims.iat !== "number" ||
    claims.exp - claims.iat > TOKEN_TTL_SECONDS
  ) {
    return { ok: false, reason: "ttl exceeds policy" };
  }
  if (!claims.sub) return { ok: false, reason: "no subject" };

  return { ok: true, claims };
}

/** Constant-time compare over equal-length buffers. */
function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * How long a readiness probe may wait on one dependency.
 *
 * 500 ms EACH, and the probe fails rather than hanging. Cloud Run's own
 * startup probe has a deadline; a readiness check that blocks on a dead Mongo
 * turns one unhealthy dependency into a service that never reports at all.
 */
export const READY_BUDGET_MS = 500;

export interface DependencyResult {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

/**
 * The HTTP status a readiness result should produce.
 *
 * 503 on ANY failure. `apps/api`'s ready route returns 200 with the dependency
 * marked `"unknown"` — deliberately not copied, because a probe whose whole job
 * is to report a dependency failure must not answer with the success code, and
 * a caller that reads only the status then cannot tell the two apart at all.
 *
 * NOTE what this does NOT do, since the reason is easy to assume: it removes
 * nothing from any rotation. Cloud Run has no readiness probe and a serverless
 * NEG has no health check — see `routes/health.ts`.
 */
export function readyStatus(deps: readonly DependencyResult[]): 200 | 503 {
  if (deps.length === 0) return 503;
  return deps.every((d) => d.ok) ? 200 : 503;
}
