/**
 * Fetching public exchange feed files (NSE/BSE) — MONEY-1085.
 *
 * One choke point for every raw file we pull from an exchange: the bhavcopy
 * CSV/ZIPs, the NSE all-indices close file, and the NSE instrument-master CSVs.
 *
 * Two reasons it is centralised rather than inlined per caller:
 *
 *   1. Both exchanges 403 obvious bot user agents and require a same-origin
 *      Referer, so the header set is fiddly and must not drift between callers.
 *   2. It is the seam the GCS feed archive hooks into (see `getFeedAsset` in
 *      `feed-archive.ts`), so QA and local can replay prod's archived file
 *      instead of hitting the exchange themselves.
 */

/**
 * Browser-like UA — BSE/NSE reject obvious bot/library user agents with a 403.
 */
export const EXCHANGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Per-request hard timeout (these are small files; the hosts can be slow). */
export const EXCHANGE_FETCH_TIMEOUT_MS = 30_000;

export const BSE_REFERER = "https://www.bseindia.com/";
export const NSE_REFERER = "https://www.nseindia.com/";

/** Fetch with an AbortController timeout (mirrors yahoo-api `fetchWithTimeout`). */
export function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = EXCHANGE_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Per-call transport overrides — MONEY-1204 (P0.2).
 *
 * ## Why the seam grew options instead of a second seam
 *
 * The Kite exemption in `no-feed-fetch-bypass.test.ts` wrote down the exit
 * ramp in advance: "widen the seam (optional headers + a caller-chosen 404
 * policy)". The first caller to need it is NSE's XBRL archive
 * (`workers/src/processors/xbrl-sync.ts`), which fetches
 * `nsearchives.nseindia.com/corporate/xbrl/*.xml` under a header set that was
 * verified live and is NOT the one below — a Mac Chrome UA, an XML `accept`,
 * a corporate-filings `referer`, and NOTABLY **no `Origin`**.
 *
 * The alternative was a second raw fetcher beside this one, which is exactly
 * the shape the archive guard exists to stop: a feed that fetches outside the
 * seam is archived by nobody and nothing fails.
 *
 * ## Every field is OPTIONAL and defaults to today's behaviour
 *
 * `fetchExchangeAsset(url, referer)` with no third argument builds the same
 * header object, uses the same timeout, and throws on the same statuses as it
 * did before this type existed. That is asserted directly by
 * `exchange-feed.test.ts`, because "additive" is a claim about behaviour, not
 * about the diff.
 */
export interface ExchangeFetchOptions {
  /**
   * Headers merged OVER the browser-impersonation defaults, case-insensitively.
   *
   * `null` DELETES a default header rather than blanking it. That arm is not
   * decoration: the default set injects `Origin`, the XBRL archive host is
   * known-good WITHOUT it, and "send it empty" is a third behaviour neither
   * caller asked for. A caller that must reproduce a verified request has to be
   * able to reproduce its absences too.
   *
   * The merge is case-insensitive because `{...defaults, ...override}` with
   * `User-Agent` on one side and `user-agent` on the other does not replace —
   * `fetch` lowercases both and JOINS them with ", ", producing one header
   * naming two browsers. Silent, and exactly the kind of drift that gets a
   * request 403'd on a host that only answers browsers.
   */
  headers?: Record<string, string | null>;
  /** Per-call timeout. Defaults to {@link EXCHANGE_FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Merge `override` over `base`, keyed on the LOWERCASED header name.
 *
 * Returns `base` untouched when there is nothing to merge, so the no-options
 * call path is not merely equivalent to the old one — it is the old one.
 */
export function mergeExchangeHeaders(
  base: Record<string, string>,
  override?: Record<string, string | null>,
): Record<string, string> {
  if (!override) return base;

  const merged = new Map<string, [name: string, value: string]>();
  for (const [name, value] of Object.entries(base)) {
    merged.set(name.toLowerCase(), [name, value]);
  }
  for (const [name, value] of Object.entries(override)) {
    const key = name.toLowerCase();
    if (value === null) merged.delete(key);
    else merged.set(key, [name, value]);
  }
  return Object.fromEntries([...merged.values()]);
}

/**
 * GET an exchange asset with the exchange-specific browser headers.
 *
 * Returns `null` on a 404 (file not published yet — weekend / holiday /
 * pre-EOD) so callers map a non-trading day to "no rows" instead of an error.
 * Any OTHER non-OK status (403 throttle, 5xx) throws so the per-source
 * try/catch in the worker records the failure and Pub/Sub can retry.
 *
 * ## No `onError: "null"` option, deliberately
 *
 * A caller that must never throw — `xbrl-sync`'s `fetchXml` is the only one —
 * already wraps the whole call in its own `try/catch`, which is strictly wider
 * than a status policy here could be: it also absorbs a DNS failure, an abort,
 * and anything the archive layer above could throw. Adding a policy arm that
 * every caller either ignores or duplicates would be an untested branch
 * pretending to be a feature.
 */
export async function fetchExchangeAsset(
  url: string,
  referer: string,
  opts?: ExchangeFetchOptions,
): Promise<Response | null> {
  const res = await fetchWithTimeout(
    url,
    {
      headers: mergeExchangeHeaders(
        {
          "User-Agent": EXCHANGE_USER_AGENT,
          Referer: referer,
          Origin: referer.replace(/\/$/, ""),
          Accept: "text/csv,application/zip,application/octet-stream,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        opts?.headers,
      ),
    },
    opts?.timeoutMs ?? EXCHANGE_FETCH_TIMEOUT_MS,
  );

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `Exchange fetch failed: ${res.status} ${res.statusText} (${url})`,
    );
  }
  return res;
}
