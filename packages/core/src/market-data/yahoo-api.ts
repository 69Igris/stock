/**
 * Yahoo Finance REST API Client
 *
 * Direct HTTP client for Yahoo Finance APIs. Replaces yahoo-finance2 library
 * to avoid FailedYahooValidationError on incomplete data for edge-case symbols.
 *
 * Features:
 * - Cookie/crumb authentication with auto-refresh
 * - Per-symbol error handling (skip bad symbols, keep good ones)
 * - Retry with exponential backoff on 401/429/5xx
 * - Sub-batching for large quote requests
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface YahooRawQuote {
  symbol: string;
  shortName?: string;
  longName?: string;
  regularMarketPrice: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketPreviousClose?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number;
  marketCap?: number;
  trailingPE?: number;
  epsTrailingTwelveMonths?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  exchange?: string;
  quoteType?: string;
}

export interface ChartBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SearchQuote {
  symbol: string;
  shortname?: string;
  longname?: string;
  exchange?: string;
  quoteType?: string;
}

/**
 * MONEY-1060 (RC4): optional error observer for the swallow-on-error fetchers.
 *
 * `fetchQuotes` / `fetchChart` / `fetchQuoteSummary` / `withExchangeFallback`
 * intentionally swallow transport errors (a failed quote must never crash a
 * dashboard render), which made a transient Yahoo outage indistinguishable from
 * "no data exists" for callers that need to tell the two apart (the research
 * tools' `metadata.sourceError` plumbing). `onError` is invoked with the raw
 * error right before each existing swallow — purely observational; the default
 * behavior (return `[]` / `null` / partial map) is byte-identical when omitted.
 */
export interface YahooFetchErrorOpts {
  onError?: (error: unknown, context?: string) => void;
  /**
   * Override for {@link BACKOFF_BASE_MS}, the first rung of the exponential
   * retry ladder. Same shape as `yahooFetch`'s existing `maxRetries` knob:
   * omit it and production is byte-identical (1s → 2s → 4s).
   *
   * Exists so a contract test can exercise the FULL retry chain — same number
   * of attempts, same decision branches, same `sleep()` calls — without paying
   * for it in wall clock. The 5xx chart contract test below burned 7.0s of real
   * `sleep()`, ~78% of this package's suite runtime, and `--test-timeout` is 30s
   * of WALL CLOCK: under CI contention (observed test-step swings of 7m23s →
   * 12m55s on identical workloads) a 7s test is within reach of that ceiling,
   * and a test that trips it comes back CANCELLED — zero failures reported,
   * the whole file silently unrun.
   *
   * Deliberately NOT `maxRetries: 0`: shrinking the attempt count would stop
   * exercising the very chain these tests exist to pin. Scaling the clock keeps
   * every attempt and drops only the waiting.
   */
  backoffBaseMs?: number;
}

import {
  CRUMB_TTL_MS,
  FETCH_TIMEOUT_MS,
  MAX_RETRIES,
  QUOTE_FETCH_BUDGET_MS,
  BACKOFF_BASE_MS,
  QUOTE_BATCH_SIZE,
  YAHOO_USER_AGENT as UA,
  type YahooAuthCache,
  createAuthCache,
  isAuthValid,
  setAuth,
  invalidateAuthCache,
  shouldRetry,
  shouldInvalidateAuth,
  calculateBackoff,
  isWithinMaxRetries,
  splitIntoBatches,
  buildQuoteUrl,
  appendCrumb,
  buildChartUrl,
  buildSearchUrl,
  buildQuoteSummaryUrl,
  parseChartResponse,
  parseSearchResponse,
  parseQuoteSummaryResponse,
  filterValidQuotes,
} from "./yahoo-api-logic";

// ─── Cookie/Crumb Auth ──────────────────────────────────────────────

const authCache: YahooAuthCache = createAuthCache();
let refreshPromise: Promise<void> | null = null;

/** Fetch with an AbortController timeout to prevent infinite hangs. */
function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Race a promise against the remaining budget.
 *
 * REJECTS on expiry rather than resolving a sentinel — the caller must be able
 * to tell "the budget ran out" from "the call returned nothing", and conflating
 * those is exactly the defect MONEY-1146 shipped in the shareholding path.
 * The timer is cleared on both paths so a settled race never leaves a pending
 * handle holding the event loop open.
 */
async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  if (ms <= 0)
    throw new Error(`Yahoo Finance API: no budget left for ${label}`);

  // MONEY-1198 — a NON-FINITE budget means "unbounded", and must NOT become a
  // 1 ms deadline.
  //
  // `Infinity <= 0` is false, so an unbudgeted call fell straight through to
  // `setTimeout(..., Infinity)`. Node cannot represent that in a 32-bit signed
  // int, so it CLAMPS TO 1 ms and warns:
  //   TimeoutOverflowWarning: Infinity does not fit into a 32-bit signed
  //   integer. Timeout duration was set to 1.
  // Every caller that passes no `deadline` — fetchChart, fetchQuoteSummary,
  // fetchSearch — reaches here with `remaining()` = Infinity, so auth refresh
  // was racing a 1 ms timer.
  //
  // It stayed invisible because the auth cache is normally warm and the
  // handshake resolves in well under 1 ms. On a COLD or 401-invalidated cache
  // `getAuth()` makes two real network round trips, the timer wins, and the
  // rejection ("exceeded Infinityms" — the message itself was the tell) escapes
  // from an `await` that sits OUTSIDE the retry `try`. Net effect: the first
  // chart fetch after a cold start returned [] — an empty array, not an error,
  // so it read as "no data for this symbol" rather than as a failure. Same
  // silent-empty class as a feed-archive replay miss.
  //
  // NaN is folded in here deliberately: `NaN <= 0` is also false, and it would
  // clamp to 1 ms the same way. Whatever produced a NaN budget, imposing a
  // millisecond deadline is never the right reading of it.
  if (!Number.isFinite(ms)) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`Yahoo Finance API: ${label} exceeded ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function refreshAuth(): Promise<void> {
  // Dedup concurrent refresh calls
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      // Step 1: get cookie from fc.yahoo.com
      const cookieRes = await fetchWithTimeout("https://fc.yahoo.com/", {
        redirect: "manual",
        headers: { "User-Agent": UA },
      });

      const setCookie = cookieRes.headers.get("set-cookie");
      if (!setCookie) {
        throw new Error("No set-cookie header from fc.yahoo.com");
      }

      // Extract just the cookie value (first cookie in the header)
      const cookie = setCookie.split(";")[0]!;

      // Step 2: get crumb using the cookie
      const crumbRes = await fetchWithTimeout(
        "https://query2.finance.yahoo.com/v1/test/getcrumb",
        {
          headers: { Cookie: cookie, "User-Agent": UA },
        },
      );

      if (!crumbRes.ok) {
        throw new Error(`Crumb request failed: ${crumbRes.status}`);
      }

      const crumb = await crumbRes.text();
      if (!crumb || crumb.includes("<")) {
        throw new Error("Invalid crumb response");
      }

      setAuth(authCache, cookie, crumb, Date.now());
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

function invalidateAuth(): void {
  invalidateAuthCache(authCache);
}

async function getAuth(): Promise<{ cookie: string; crumb: string }> {
  if (!isAuthValid(authCache, Date.now())) {
    await refreshAuth();
  }
  return { cookie: authCache.cookie!, crumb: authCache.crumb! };
}

// ─── Retry Fetch ────────────────────────────────────────────────────

/**
 * Exponential backoff for a 0-based `attempt`, optionally rescaled.
 *
 * The CURVE always comes from `calculateBackoff` — that stays the single source
 * of the retry shape, so an override rescales the ladder rather than forking
 * it, and `backoffBaseMs === BACKOFF_BASE_MS` is exactly the default.
 *
 * A non-finite or negative override is IGNORED, not propagated: `NaN` would
 * make the `remaining() > backoff` guards false and silently turn the retry
 * chain off — the precise failure ("it got fast because it stopped retrying")
 * this seam exists to avoid.
 */
function resolveBackoff(attempt: number, backoffBaseMs?: number): number {
  const curve = calculateBackoff(attempt);
  if (
    backoffBaseMs === undefined ||
    !Number.isFinite(backoffBaseMs) ||
    backoffBaseMs < 0
  ) {
    return curve;
  }
  return curve * (backoffBaseMs / BACKOFF_BASE_MS);
}

/**
 * MONEY-1135 — a wall-clock budget for the WHOLE call, retries included.
 *
 * `fetchWithTimeout` already bounds each individual fetch (15s), which reads
 * like the problem is solved. It is not: the retry chain is SERIAL, so one
 * chunk's worst case is 4 attempts x 15s plus exponential backoff — over a
 * minute, on a request path the user is waiting on. Chunks run in parallel, so
 * the chunk count does not multiply that, but it does not shrink it either.
 *
 * The budget is a DEADLINE rather than another timeout: each attempt gets
 * `min(FETCH_TIMEOUT_MS, time remaining)`, and retries stop once the remaining
 * budget cannot fit another attempt. So a slow upstream degrades to "return
 * what we have" instead of holding the request until the platform kills it,
 * and the caller's own error path gets to run.
 */
async function yahooFetch(
  url: string,
  options?: { maxRetries?: number; deadline?: number; backoffBaseMs?: number },
): Promise<Response> {
  const retries = options?.maxRetries ?? MAX_RETRIES;
  const deadline = options?.deadline;
  const backoffBaseMs = options?.backoffBaseMs;
  /** Milliseconds left in the overall budget, or Infinity when unbudgeted. */
  const remaining = (): number =>
    deadline === undefined ? Infinity : deadline - Date.now();

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (remaining() <= 0) {
      throw new Error(
        `Yahoo Finance API: quote budget exhausted after ${attempt} attempt(s)`,
      );
    }
    // MONEY-1135 — `getAuth()` is INSIDE the budget, not outside it.
    //
    // Review finding: this sat outside, and `refreshAuth()` makes two serial
    // `fetchWithTimeout` calls at the default 15s each. Yahoo's crumb TTL is
    // ~20 min and `invalidateAuth()` fires on any 401/403, so a cold or
    // invalidated auth is routine — meaning up to 30s could burn OUTSIDE a
    // 20s budget, for a real worst case near 50s against a bug described as
    // "over a minute". A budget that excludes the dominant term is decoration.
    const authBudget = Math.max(0, remaining());
    const { cookie, crumb } = await withDeadline(
      getAuth(),
      authBudget,
      "yahoo auth refresh",
    );

    // Append crumb to URL
    const fullUrl = appendCrumb(url, crumb);

    let res: Response;
    try {
      res = await fetchWithTimeout(
        fullUrl,
        {
          headers: {
            Cookie: cookie,
            "User-Agent": UA,
            Accept: "application/json",
          },
        },
        // Never let a single attempt outlive the overall budget.
        Math.min(FETCH_TIMEOUT_MS, remaining()),
      );
    } catch (err) {
      // Catch AbortError (timeout) and network errors
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      const message = isAbort
        ? `Yahoo Finance API request timed out after ${FETCH_TIMEOUT_MS}ms`
        : `Yahoo Finance API network error: ${err instanceof Error ? err.message : String(err)}`;

      const backoff = resolveBackoff(attempt, backoffBaseMs);
      if (isWithinMaxRetries(attempt, retries) && remaining() > backoff) {
        console.warn(
          `[yahoo-api] ${message} (attempt ${attempt + 1}/${retries + 1}), retrying...`,
        );
        await sleep(backoff);
        continue;
      }

      throw new Error(message);
    }

    if (res.ok) {
      return res;
    }

    // On 401/403, invalidate auth before retrying
    if (shouldInvalidateAuth(res.status)) {
      invalidateAuth();
    }

    // Retry on 401/403/429/5xx with exponential backoff
    const statusBackoff = resolveBackoff(attempt, backoffBaseMs);
    if (
      shouldRetry(res.status) &&
      isWithinMaxRetries(attempt, retries) &&
      remaining() > statusBackoff
    ) {
      await sleep(statusBackoff);
      continue;
    }

    throw new Error(`Yahoo Finance API error: ${res.status} ${res.statusText}`);
  }

  throw new Error("Yahoo Finance API: max retries exceeded");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Exchange Fallback Utility ──────────────────────────────────────

/**
 * MONEY-1121 - strip the chat @-mention token off a ticker.
 *
 * `/quote @HDFCBANK` reached `get_financial_data` with the "@" still attached
 * and was handed to Yahoo verbatim, which answered "No data found for
 * @HDFCBANK" — the error echoed the very character that broke it. The mention
 * picker knows the real instrument; this is the belt-and-braces normalisation
 * for every path that doesn't (the model can also call the tool directly).
 */
export function normalizeTickerInput(raw: string): string {
  return raw.trim().replace(/^@+/, "").toUpperCase();
}

/** Exchange suffixes `withExchangeFallback` knows how to try. */
const INDIAN_SUFFIXES = [".NS", ".BO"] as const;

/**
 * Only a plain equity ticker may have an exchange suffix appended. Indices
 * ("^NSEI"), currency pairs ("USDINR=X") and anything already carrying a dot
 * are excluded — "^NSEI.NS" is not a symbol, and requesting it would burn two
 * pointless round-trips on every index miss.
 */
function canTakeExchangeSuffix(symbol: string): boolean {
  return /^[A-Z0-9&-]+$/.test(symbol);
}

/**
 * Safety net: if a Yahoo call with .NS fails, retry with .BO (and vice versa).
 * Used by research tools as a last resort when the DB lookup didn't produce
 * the correct exchange suffix.
 *
 * MONEY-1121: a symbol with NO suffix used to give up immediately — `altSymbol`
 * stayed null and the whole call returned null. So a bare Indian ticker
 * ("HDFCBANK", which is exactly what the chat produces once the "@" is
 * stripped) could never resolve, even though "HDFCBANK.NS" would have. The
 * bare form is still tried FIRST, so US tickers such as AAPL — which Yahoo
 * resolves unsuffixed — keep working and never get an Indian suffix stapled on.
 */
export async function withExchangeFallback<T>(
  symbol: string,
  fetchFn: (sym: string) => Promise<T | null>,
  opts?: YahooFetchErrorOpts,
): Promise<T | null> {
  // Try the original symbol first
  try {
    const result = await fetchFn(symbol);
    if (result !== null && result !== undefined) return result;
  } catch (error) {
    // Original symbol failed - fall through to alternate exchange
    opts?.onError?.(error, `withExchangeFallback:${symbol}`);
  }

  // Swap .NS ↔ .BO, or — when unsuffixed — try both in turn.
  let altSymbols: string[];
  if (symbol.endsWith(".NS")) {
    altSymbols = [symbol.replace(/\.NS$/, ".BO")];
  } else if (symbol.endsWith(".BO")) {
    altSymbols = [symbol.replace(/\.BO$/, ".NS")];
  } else if (canTakeExchangeSuffix(symbol)) {
    altSymbols = INDIAN_SUFFIXES.map((suffix) => `${symbol}${suffix}`);
  } else {
    // Index / currency / already-qualified symbol — nothing sensible to try.
    return null;
  }

  for (const altSymbol of altSymbols) {
    console.log(`[yahoo-api] Exchange fallback: ${symbol} → ${altSymbol}`);
    try {
      const result = await fetchFn(altSymbol);
      if (result !== null && result !== undefined) return result;
    } catch (error) {
      opts?.onError?.(error, `withExchangeFallback:${altSymbol}`);
    }
  }

  return null;
}

// ─── Public API: fetchQuotes ────────────────────────────────────────

export async function fetchQuotes(
  symbols: string[],
  opts?: YahooFetchErrorOpts,
): Promise<Map<string, YahooRawQuote>> {
  const { isUnfetchableYahooSymbol } = await import("./instruments/types");
  const result = new Map<string, YahooRawQuote>();

  // Pre-filter symbols that Yahoo can't resolve (bonds, BE-series, MF codes)
  const fetchable = symbols.filter((s) => !isUnfetchableYahooSymbol(s));
  if (fetchable.length === 0) return result;

  // Split into small chunks and fetch all in parallel
  const chunks = splitIntoBatches(fetchable, QUOTE_BATCH_SIZE);

  // MONEY-1135 — ONE deadline shared by every chunk, so the whole call is
  // bounded rather than each piece of it. Chunks are parallel, so they all race
  // the same clock; a chunk that burns the budget on retries fails alone and
  // the rest still return. `Promise.allSettled` below already tolerates
  // per-chunk rejection, so a budget-exhausted chunk degrades to missing
  // symbols instead of an empty response.
  const deadline = Date.now() + QUOTE_FETCH_BUDGET_MS;

  const settled = await Promise.allSettled(
    chunks.map(async (batch) => {
      const res = await yahooFetch(buildQuoteUrl(batch), {
        deadline,
        backoffBaseMs: opts?.backoffBaseMs,
      });
      const json = (await res.json()) as {
        quoteResponse?: { result?: YahooRawQuote[] };
      };
      return { batch, quotes: json?.quoteResponse?.result ?? [] };
    }),
  );

  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      console.error(`[yahoo-api] fetchQuotes chunk failed:`, outcome.reason);
      opts?.onError?.(outcome.reason, "fetchQuotes");
      continue;
    }

    for (const [symbol, quote] of filterValidQuotes(outcome.value.quotes)) {
      result.set(symbol, quote);
    }
  }

  return result;
}

// ─── Public API: fetchChart ─────────────────────────────────────────

export async function fetchChart(
  symbol: string,
  options: {
    period1: Date;
    period2: Date;
    interval?: string;
  },
  opts?: YahooFetchErrorOpts,
): Promise<ChartBar[]> {
  const { isUnfetchableYahooSymbol } = await import("./instruments/types");
  if (isUnfetchableYahooSymbol(symbol)) return [];

  const { period1, period2, interval = "1d" } = options;

  const url = buildChartUrl(symbol, period1, period2, interval);

  try {
    console.log(
      `[yahoo-api] fetchChart ${symbol} (${interval}) period ${period1.toISOString().split("T")[0]} → ${period2.toISOString().split("T")[0]}`,
    );
    const res = await yahooFetch(url, {
      backoffBaseMs: opts?.backoffBaseMs,
    });
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: (number | null)[];
              high?: (number | null)[];
              low?: (number | null)[];
              close?: (number | null)[];
              volume?: (number | null)[];
            }>;
          };
        }>;
        error?: { code?: string; description?: string };
      };
    };

    if (json?.chart?.error) {
      console.warn(
        `[yahoo-api] Chart API error for ${symbol}:`,
        json.chart.error,
      );
    }

    // parseChartResponse handles the error/missing-series guards and the
    // per-bar mapping (via parseChartBars). Empty result → no data.
    const bars = parseChartResponse(json);
    if (bars.length === 0) {
      console.warn(`[yahoo-api] No chart data in response for ${symbol}`);
    }

    console.log(
      `[yahoo-api] fetchChart ${symbol}: ${bars.length} bars returned`,
    );
    return bars;
  } catch (error) {
    console.error(`[yahoo-api] fetchChart error for ${symbol}:`, error);
    opts?.onError?.(error, `fetchChart:${symbol}`);
    return [];
  }
}

// ─── Public API: fetchSearch ────────────────────────────────────────

export async function fetchSearch(
  query: string,
  options: { quotesCount?: number } = {},
): Promise<SearchQuote[]> {
  const { quotesCount = 10 } = options;

  try {
    const res = await yahooFetch(buildSearchUrl(query, quotesCount), {
      maxRetries: 0,
    });
    const json = (await res.json()) as {
      quotes?: SearchQuote[];
    };

    return parseSearchResponse(json);
  } catch (error) {
    console.error(`[yahoo-api] fetchSearch error for "${query}":`, error);
    return [];
  }
}

// ─── Public API: fetchQuoteSummary ──────────────────────────────────

/**
 * MONEY-1238 (#7) — the three states `fetchQuoteSummary`'s `null` collapses.
 *
 * `fetchQuoteSummary` catches EVERY error and returns `null`, so "Yahoo blocked
 * our egress / timed out / 500ed" and "this ETF genuinely has no assetProfile"
 * are the SAME VALUE. That is survivable for a render (both mean "no number to
 * draw") and NOT survivable for a WRITER: sector-enrichment turned the null
 * into a permanent `"N/A"` sentinel, and its own selector then excluded the row
 * from every future run — one bad night, poisoned forever, reported as
 * `failed=0`.
 *
 * The repo rule this violated is "never cache a fail-open default — make
 * 'couldn't determine' a DISTINCT value and key on determinacy, not on the
 * value". These three kinds ARE that distinction:
 *
 *   - `ok`          — a 200 carrying `quoteSummary.result[0]`.
 *   - `empty`       — Yahoo answered, deterministically, that it has nothing.
 *                     Same answer on every retry, so a writer may record it.
 *   - `unavailable` — the transport or the HTTP status failed. Says NOTHING
 *                     about the symbol. A writer must write NOTHING and count
 *                     the attempt as FAILED so it is retried next run.
 */
export type YahooSummaryOutcome =
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "empty"; reason: YahooSummaryEmptyReason }
  | {
      kind: "unavailable";
      /** HTTP status when the failure carried one, else null (network/timeout). */
      status: number | null;
      message: string;
      error: unknown;
    };

export type YahooSummaryEmptyReason =
  /** The symbol is on the never-fetchable list — no request was made. */
  | "unfetchable-symbol"
  /** HTTP 200, but `quoteSummary.result[0]` was absent. */
  | "no-result"
  /** HTTP 404 — Yahoo has no such symbol. Deterministic, not an outage. */
  | "not-found";

/**
 * The one HTTP status that is a statement about the SYMBOL rather than about
 * the transport.
 *
 * Deliberately just 404. 401/403 are Yahoo refusing US (a stale crumb, or an
 * egress block — the failure mode that silently killed the Tickertape feed for
 * five months); 429 is a rate limit; 4xx-other is our own malformed request;
 * 5xx is theirs. Treating any of them as "this symbol has no data" is how an
 * outage gets written down as a fact.
 */
const DETERMINISTIC_EMPTY_STATUS = 404;

/**
 * Recover the HTTP status from a `yahooFetch` rejection.
 *
 * `yahooFetch` throws `Error("Yahoo Finance API error: {status} {statusText}")`
 * for a non-retryable/exhausted HTTP response and a differently-worded Error
 * for timeouts, network faults and budget exhaustion — so the status is only
 * present on the first shape. Anchored on the full prefix rather than a bare
 * `includes("404")`, which also matches a body, a symbol, or "404ms".
 *
 * Pure and exported so the classification is unit-testable without a socket.
 */
export function yahooErrorStatus(error: unknown): number | null {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  const m = /Yahoo Finance API error:\s*(\d{3})\b/.exec(msg);
  return m ? Number(m[1]) : null;
}

/**
 * `fetchQuoteSummary` with the outage/absence distinction intact.
 *
 * This is the REAL implementation; `fetchQuoteSummary` is a thin lossy adapter
 * over it (both `empty` and `unavailable` collapse back to `null`) so all ~15
 * existing callers keep their exact current behaviour, including the
 * `console.warn` and the `onError` observer. Additive by design: widening the
 * shared return type would have touched every one of them.
 */
export async function fetchQuoteSummaryOutcome(
  symbol: string,
  modules: string[],
  opts?: YahooFetchErrorOpts,
): Promise<YahooSummaryOutcome> {
  const { isUnfetchableYahooSymbol } = await import("./instruments/types");
  if (isUnfetchableYahooSymbol(symbol))
    return { kind: "empty", reason: "unfetchable-symbol" };

  try {
    const res = await yahooFetch(buildQuoteSummaryUrl(symbol, modules), {
      backoffBaseMs: opts?.backoffBaseMs,
    });
    const json = (await res.json()) as {
      quoteSummary?: {
        result?: Array<Record<string, unknown>>;
        error?: { code?: string; description?: string } | null;
      };
    };

    // A 200 CARRYING AN ERROR IS NOT AN EMPTY RESULT — MONEY-1236.
    //
    // Yahoo answers HTTP 200 with `{"quoteSummary":{"result":null,"error":{
    // "code":"Unauthorized","description":"Invalid Crumb"}}}` for a stale crumb,
    // and similarly under rate limiting. The transport succeeded, so nothing
    // throws, `parseQuoteSummaryResponse` returns null, and this used to report
    // `empty` / "no-result" — which the sector enricher records as the
    // PERMANENT `SECTOR_SKIPPED` sentinel. One rate-limit window therefore wrote
    // "this instrument has no sector, forever" across every symbol it touched,
    // and only a deliberate re-enrichment could undo it.
    //
    // `empty` must mean "Yahoo answered, and the answer is that there is
    // nothing". An error payload is the opposite: Yahoo declined to answer. That
    // is `unavailable` — retried, never cached as a fact.
    const upstreamError = json.quoteSummary?.error;
    if (upstreamError) {
      const message =
        upstreamError.description ?? upstreamError.code ?? "quoteSummary error";
      console.warn(
        `[yahoo-api] fetchQuoteSummary 200-with-error for ${symbol}: ${message}`,
      );
      opts?.onError?.(
        new Error(message),
        `fetchQuoteSummary:${symbol}:upstream-error`,
      );
      return {
        kind: "unavailable",
        status: res.status,
        message,
        error: upstreamError,
      };
    }

    const data = parseQuoteSummaryResponse(json);
    return data === null
      ? { kind: "empty", reason: "no-result" }
      : { kind: "ok", data };
  } catch (error) {
    // Some instruments (ETFs, indices) don't have certain modules - return null
    console.warn(
      `[yahoo-api] fetchQuoteSummary error for ${symbol}:`,
      error instanceof Error ? error.message : error,
    );
    opts?.onError?.(error, `fetchQuoteSummary:${symbol}`);

    const status = yahooErrorStatus(error);
    if (status === DETERMINISTIC_EMPTY_STATUS)
      return { kind: "empty", reason: "not-found" };
    return {
      kind: "unavailable",
      status,
      message: error instanceof Error ? error.message : String(error ?? ""),
      error,
    };
  }
}

export async function fetchQuoteSummary(
  symbol: string,
  modules: string[],
  opts?: YahooFetchErrorOpts,
): Promise<Record<string, unknown> | null> {
  const outcome = await fetchQuoteSummaryOutcome(symbol, modules, opts);
  return outcome.kind === "ok" ? outcome.data : null;
}
