"use client";

/**
 * Getting a market-data token to the service. MONEY-1469/1470.
 *
 * ## WHY THIS EXISTS AT ALL
 *
 * `mintMarketDataToken()` shipped with ZERO callers, and the chart's datafeed
 * is TradingView's vendored `UDFCompatibleDatafeed`, whose internal requester is
 * constructed with no headers and exports no `Requester` we could pass one to.
 * So every intraday request reached the service with no `Authorization` header,
 * was refused `{s:"error","intraday requires a market-data token"}`, and —
 * because that is a 200 and a `console.warn` — nothing alerted. The entire A5
 * read path, the `intraday` claim, the entitlement flag and the basis badge
 * were unreachable while the writers filled Redis nightly.
 *
 * ## WHY IT WRAPS `fetch`
 *
 * It is the only seam. `TradingViewAdvancedChart` already monkey-patches that
 * bundle for the realtime overlay; this is the same seam, scoped tighter: one
 * origin, one header added, one header read, and the original `fetch` returned
 * untouched on any error.
 *
 * The wrapper also records `X-Bar-Basis`, because both jobs are about the same
 * requests and two wrappers would have to agree about ordering.
 */
import { setBarBasis } from "./bar-basis";

/**
 * The server action is imported LAZILY, inside the mint.
 *
 * A static import pulls the action's whole graph — `@/lib/auth`, which calls
 * `react.cache` — into every module that transitively reaches this one. Next
 * handles that across the "use server" boundary; `node --test` does not, and it
 * took out an unrelated formatter suite with
 * `TypeError: (0, import_react.cache) is not a function`. A dynamic import also
 * means a page that never mints never loads it.
 */
async function mint() {
  const { mintMarketDataToken } =
    await import("@/lib/actions/market-data-token");
  return mintMarketDataToken();
}

/** Re-mint this long before `exp`, so a request never races the expiry. */
const REFRESH_MARGIN_MS = 45_000;

let cached: { token: string; expiresAtMs: number } | null = null;
let inFlight: Promise<string | null> | null = null;

/**
 * When a mint LAST FAILED. A failure is not retried for this long.
 *
 * Without it, a mint that returns null — which is the NORMAL state for a signed
 * -out visitor, and the permanent state wherever `MARKET_DATA_TOKEN_SECRET` is
 * unset — re-fires on EVERY request to the service, because nothing was cached
 * to short-circuit the next call. Measured in local dev: ~15 server-action
 * POSTs to `/stock/RELIANCE` in one page load, all of them refusing in 3 ms.
 *
 * A Next.js server action is a POST to the current page, so a storm of them
 * competes with the very requests the chart is waiting on.
 */
let failedAtMs = 0;
const FAILURE_BACKOFF_MS = 60_000;

/**
 * A token, minted at most once per window and never twice concurrently.
 *
 * SINGLE-FLIGHT: the chart and the quote poller both need one, and they start
 * within milliseconds of each other on a page load. Without this each mount
 * would run a separate server action.
 *
 * Returns null for an anonymous visitor — an ordinary state, since daily bars
 * need no token at all.
 */
export async function getMarketDataToken(): Promise<string | null> {
  const now = Date.now();
  if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > now)
    return cached.token;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const minted = await mint();
      if (!minted) {
        failedAtMs = Date.now();
        // NOT cached. "We could not determine it" must not be pinned for a
        // window — an anonymous visitor who signs in would otherwise stay
        // tokenless until the TTL that was never set expired.
        return null;
      }
      cached = { token: minted.token, expiresAtMs: minted.expiresAt * 1000 };
      return minted.token;
    } catch {
      failedAtMs = Date.now();
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * The token we ALREADY hold, if any — synchronous, never awaits a mint.
 *
 * ## WHY THIS EXISTS: THE MINT WAS ON THE CRITICAL PATH OF EVERY CHART REQUEST
 *
 * `installMarketDataFetch` used to `await getMarketDataToken()` before EVERY
 * request to the service origin. That mint is a Next.js SERVER ACTION, and it
 * is not cheap: `getAuthenticatedUser` (Clerk), `getSubscriptionAccessForUser`
 * (DB), `currentUserMaySeeUsMarket` (DB) and `getConfig` (Mongo) — four round
 * trips, on a cold serverless function, before the first byte of
 * `/udf/symbols?symbol=NSE:RELIANCE` leaves the browser.
 *
 * And `/udf/symbols` and daily `/udf/history` DO NOT NEED A TOKEN. The service
 * gates INTRADAY and US only; the smoke suite asserts "daily bars still need no
 * token" on every run. So the whole chain was being paid for requests that are
 * deliberately public — and worse, anything that made that chain slow, hang or
 * reject took the chart down with it. TradingView's vendored datafeed turns ANY
 * rejected fetch into `onError("unknown_symbol")`, which renders as
 * "This symbol doesn't exist" — a symbol-resolution message for an auth
 * problem the symbol never had.
 *
 * The mint still happens; it just never blocks. A request goes out NOW with
 * whatever token is already cached, and a background mint warms the cache for
 * the next one. Intraday is the only lane that needs the token, it is reached
 * by a deliberate user action (changing resolution) long after the first
 * paint, and its refusal is already a well-formed 200 `s:"error"` that the
 * next request — carrying the now-warm token — resolves.
 */
export function cachedMarketDataToken(): string | null {
  const now = Date.now();
  if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > now)
    return cached.token;
  // Warm it for the NEXT request — but NOT if one just failed. See
  // `failedAtMs`: without this a refusing mint fires once per service request.
  if (now - failedAtMs >= FAILURE_BACKOFF_MS) {
    void getMarketDataToken().catch(() => null);
  }
  return null;
}

/** Headers for a direct `fetch` to the service. Empty when signed out. */
export async function marketDataAuthHeaders(): Promise<Record<string, string>> {
  const token = await getMarketDataToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Drop the cached token — used when a request is refused as unauthorized. */
export function clearMarketDataToken(): void {
  cached = null;
}

const INSTALLED = Symbol.for("usemoney.marketDataFetch");

/**
 * Which service routes can a token possibly change the answer to?
 *
 * `/udf/config`, `/udf/time` and `/udf/search` are PUBLIC by design — the service's own smoke asserts "daily bars still need no
 * token" — so attaching one buys nothing and coupling them to the mint costs
 * everything.
 *
 * ## WHY THIS IS THE FIX AND NOT A TIDY-UP
 *
 * The chart was blank on QA and prod, and local's console named the cause:
 *
 *     /udf/config                 (failed)
 *     /udf/symbol_info?group=NYSE
 *     /udf/symbol_info?group=FOREX
 *     /udf/symbol_info?group=AMEX
 *     Series symbol resolve error: invalid symbol
 *
 * NYSE/FOREX/AMEX is the vendored datafeed's HARDCODED default exchange list.
 * It only requests `symbol_info?group=` when `supports_group_request` is true,
 * and ours is false — so the bundle never received our config. Its
 * `_requestConfiguration()` maps ANY failure to `null` and silently adopts a
 * built-in default that demands an endpoint this origin does not serve. One
 * failed `/udf/config` therefore poisons the chart for the entire page load,
 * with no error the user or the service can see.
 *
 * `/udf/config` is a CDN-cached constant. Putting a Next.js server action —
 * Clerk, a subscription read, a Mongo `getConfig` — in front of it made a
 * public constant depend on the whole auth stack, and every hiccup in that
 * stack became "This symbol doesn't exist". The token now rides ONLY on the
 * requests that can use it, and everything else goes out untouched.
 */
export function mayCarryToken(url: string, origin: string): boolean {
  const path = url.slice(origin.length);
  return (
    path.startsWith("/quotes") ||
    path.startsWith("/udf/history") ||
    // `/udf/symbols` IS token-bearing — `symbols.ts` calls `checkMarketToken`
    // on the US branch and refuses without the `us` claim. Omitting it here
    // guaranteed the header was absent, so the US lane MONEY-1478 opened could
    // never resolve for anyone, including an entitled founder. India needs no
    // token on this route and is unaffected: an absent claim is simply absent.
    path.startsWith("/udf/symbols")
  );
}

/**
 * Wrap `fetch` once so the chart's vendored datafeed carries a token.
 *
 * Safe to call repeatedly. The wrapper is deliberately NOT removable: a second
 * chart mounting while the first unmounts would otherwise restore a `fetch` the
 * second still relies on. It is inert for every URL but the service's.
 */
export function installMarketDataFetch(serviceOrigin: string): () => void {
  if (typeof window === "undefined") return () => {};
  const w = window as unknown as Record<symbol, unknown> & {
    fetch: typeof fetch;
  };
  if (w[INSTALLED]) return () => {};

  const original = w.fetch.bind(window);
  w.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = "";
    try {
      url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
    } catch {
      return original(input, init);
    }

    // Only the service's own origin. A token attached to anything else would
    // be a credential leak to whatever host that is.
    const isService =
      serviceOrigin !== "" &&
      url.startsWith(serviceOrigin) &&
      mayCarryToken(url, serviceOrigin);
    let response: Response;
    if (isService) {
      const headers = new Headers(init?.headers ?? {});
      // NEVER awaited — see `cachedMarketDataToken`. Blocking here put a
      // four-round-trip server action in front of `/udf/symbols`, which needs
      // no token at all, and turned any auth hiccup into
      // "This symbol doesn't exist".
      const token = cachedMarketDataToken();
      if (token) headers.set("Authorization", `Bearer ${token}`);
      response = await original(input, {
        ...init,
        headers,
        credentials: "omit",
      });
      if (response.status === 401) {
        // The token was rejected — most likely expired between mint and use.
        // Drop it so the NEXT request mints a fresh one rather than replaying
        // a dead one for the rest of the session.
        clearMarketDataToken();
      }
    } else {
      response = await original(input, init);
    }

    try {
      if (url.includes("/udf/history")) {
        const header = response.headers.get("X-Bar-Basis");
        // A DAILY response carries no header, and that must CLEAR the badge
        // rather than leave an intraday one beside daily candles.
        setBarBasis(
          header === "trade" || header === "quote_mid" ? header : null
        );
      }
    } catch {
      // A probe must never fail a request it only observes.
    }
    return response;
  };
  w[INSTALLED] = true;
  return () => {};
}
