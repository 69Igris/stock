/**
 * NSE Corporate Filings Fetcher
 *
 * Fetches corporate announcements and filings from NSE India API:
 * - Annual reports (PDF)
 * - Quarterly results (PDF)
 * - Corporate actions (dividends, splits, bonuses)
 *
 * NSE requires browser-like headers and a cookie session.
 */

import ky from "ky";
import {
  parseAnnouncements,
  parseFinancialResults,
  parseCorporateActions,
  parseBulkCorporateActions,
  filterAnnualReports,
  categorizeAnnouncements,
  type NseAnnouncementDocType,
} from "./nse-filings-logic";
import type { NSEFiling, NSECorporateAction } from "./nse-filings-types";
import { archiveNseJsonResponse } from "./nse-json-archive";

const logger = {
  info: (...args: unknown[]) => console.log("[nse-filings]", ...args),
  warn: (...args: unknown[]) => console.warn("[nse-filings]", ...args),
  error: (...args: unknown[]) => console.error("[nse-filings]", ...args),
};

const NSE_BASE = "https://www.nseindia.com";
const API_TIMEOUT_MS = 15_000;

// NSE requires cookies from the main page before API calls work
let sessionCookie: string | null = null;
let sessionExpiry = 0;

/**
 * Drop the cached NSE session so the next {@link getSession} re-handshakes.
 *
 * Exists because our 5-minute TTL is a GUESS about a lifetime only NSE knows,
 * and the two clocks drift apart in a way that is invisible from here: when
 * Akamai retires a cookie early it does not 403 the next request, it HANGS it.
 * So a stale cookie presents as a timeout, and a retry that reuses it times out
 * again — three attempts at 30/45/60s all failing on the same dead credential,
 * which is not a retry, it is the same request three times.
 *
 * Callers invalidate BEFORE a retry, never on the first attempt: a fresh
 * handshake costs an extra round trip and the overwhelming majority of requests
 * succeed on a live cookie.
 *
 * Exported for the same reason `resetNseJsonArchiveCounters` is — module-level
 * mutable state that a test (or a long-running backfill between legs) must be
 * able to clear deterministically.
 */
/**
 * Backoff between bulk-fetch retries, in ms (default 2000, multiplied by the
 * attempt number).
 *
 * Env-overridable for the same reason `CORP_ACTIONS_WINDOW_PACE_MS` is: the
 * failure path is the one worth testing, and a test that exercises three
 * attempts would otherwise sleep 6 real seconds and arm timers that outlive the
 * assertion. Never read at module load — a test sets it per-case.
 */
function retryBackoffMs(): number {
  const raw = Number(process.env.NSE_RETRY_BACKOFF_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
}

export function invalidateNseSession(): void {
  sessionCookie = null;
  sessionExpiry = 0;
}

const NSE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/",
};

/**
 * Extract cookie name=value pairs from a set-cookie header string.
 * Handles comma-separated cookies where Expires contains commas (e.g., "Mon, 29 Mar 2027").
 */
function extractCookies(setCookie: string): string[] {
  const cookies: string[] = [];
  // Split on ", " followed by a cookie name (word=) - not on commas inside Expires dates
  const parts = setCookie.split(/,\s*(?=[a-zA-Z_][a-zA-Z0-9_]*=)/);
  for (const part of parts) {
    const nameValue = part.trim().split(";")[0];
    if (nameValue && nameValue.includes("=")) {
      cookies.push(nameValue);
    }
  }
  return cookies;
}

async function getSession(): Promise<string> {
  if (sessionCookie && Date.now() < sessionExpiry) return sessionCookie;

  // Retry up to 3 times with backoff (NSE/Akamai may 403 on first attempt)
  // Even 403 responses set cookies that we need for subsequent API calls
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await ky.get(NSE_BASE, {
        timeout: API_TIMEOUT_MS,
        headers: NSE_HEADERS,
        throwHttpErrors: false,
        redirect: "manual",
      });

      const setCookieHeader = resp.headers.get("set-cookie");
      if (setCookieHeader) {
        const cookieParts = extractCookies(setCookieHeader);
        if (cookieParts.length > 0) {
          sessionCookie = cookieParts.join("; ");
          sessionExpiry = Date.now() + 5 * 60 * 1000;

          // If we got a 200, cookies are ready
          if (resp.ok) return sessionCookie;

          // On 403, Akamai set challenge cookies - retry with them
          if (resp.status === 403 && attempt < 2) {
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
            continue;
          }

          return sessionCookie;
        }
      }

      // No cookies at all - retry
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      } else {
        logger.warn(
          "Failed to get NSE session after 3 attempts:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  return sessionCookie || "";
}

/**
 * GET a cookie-gated `www.nseindia.com/api/*` endpoint and parse it as JSON.
 *
 * Exists so callers outside this file (MONEY-1097's report-archive drift guard)
 * can reach NSE's JSON API without re-implementing {@link getSession}. That
 * handshake has real subtleties — Akamai 403s the first attempt but still sets
 * the cookies you need, so the retry is load-bearing — and a second copy of it
 * would drift from this one the first time NSE changes anything.
 *
 * Returns `null` on ANY failure (non-2xx, HTML challenge page, malformed JSON),
 * because every current caller treats "couldn't read it" the same way and none
 * of them should be able to throw into a scheduled job.
 *
 * @param path Path beginning with `/api/`, including the query string.
 */
export async function fetchNseApiJson<T = unknown>(
  path: string,
): Promise<T | null> {
  try {
    const cookie = await getSession();
    const resp = await ky.get(`${NSE_BASE}${path}`, {
      timeout: API_TIMEOUT_MS,
      headers: { ...NSE_HEADERS, Cookie: cookie },
      throwHttpErrors: false,
    });
    if (!resp.ok) return null;

    const text = await resp.text();
    // NSE answers a cookieless/throttled request with an HTML challenge page
    // carrying a 200, so status alone never decides success here.
    if (!text.trim() || text.trimStart().startsWith("<")) return null;
    const parsed = JSON.parse(text) as T;
    // P5.7: market-wide responses also land in the feed archive (no-op unless
    // the archive is armed; never throws; per-symbol paths are skipped).
    await archiveNseJsonResponse(path, text);
    return parsed;
  } catch (err) {
    logger.warn(
      `NSE API fetch failed for ${path}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ── Types ────────────────────────────────────────────────────────────

export type {
  NSEFiling,
  NSECorporateAction,
  CorporateActionType,
} from "./nse-filings-types";

// ── Announcements ────────────────────────────────────────────────────

/**
 * Fetch corporate announcements for a symbol from NSE
 */
export async function fetchNSEAnnouncements(
  symbol: string,
  options?: { from?: string; to?: string },
): Promise<NSEFiling[]> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();

  try {
    const cookie = await getSession();
    // ONE path string, used for the request AND the archive. Built here rather
    // than handed to ky as `searchParams` for the reason spelled out on
    // `fetchNSECorporateActionsBulk` below: a fetcher whose URL only ever
    // exists inside ky has nothing to give `archiveNseJsonResponse`, and the
    // archive call then either never gets written or drifts from the request.
    const params = new URLSearchParams({ symbol: clean });
    if (options?.from) params.set("from_date", options.from);
    if (options?.to) params.set("to_date", options.to);
    const path = `/api/corporates-announcements?${params.toString()}`;

    const rawResp = await ky.get(`${NSE_BASE}${path}`, {
      timeout: API_TIMEOUT_MS,
      headers: { ...NSE_HEADERS, Cookie: cookie },
      throwHttpErrors: false,
    });

    if (!rawResp.ok) return [];

    const text = await rawResp.text();
    // NSE answers a cookieless/throttled request with an HTML challenge page
    // carrying a 200, so status alone never decides success — and a challenge
    // page is not a response worth archiving.
    if (!text.trim() || text.trimStart().startsWith("<")) return [];
    let resp: unknown[];
    try {
      resp = JSON.parse(text);
    } catch {
      return []; // NSE returned HTML error page
    }

    // P5.7: archived BEFORE the domain parse, and with the RAW text — the whole
    // point of the archive is to still hold what NSE served when
    // `parseAnnouncements` turns out to be wrong about it (MONEY-1189, audit
    // gap #6). Never throws, so the fetch result is unaffected either way.
    //
    // Today `nseJsonArchiveKey` SKIPS this path: it carries `symbol=`, and the
    // per-symbol fan-out is the archive's deliberate volume exclusion. That is
    // the policy's decision to make, not this call site's — routing through the
    // seam is what makes it one decision instead of a fetcher that silently
    // opted out. The counters record the skip, so "not archived" is visible
    // rather than inferred.
    await archiveNseJsonResponse(path, text);

    return parseAnnouncements(clean, resp);
  } catch (err) {
    logger.error(`Failed to fetch NSE announcements for ${clean}:`, err);
    return [];
  }
}

// ── Financial Results ────────────────────────────────────────────────

/**
 * Fetch quarterly/annual financial results from NSE
 */
export async function fetchNSEFinancialResults(
  symbol: string,
): Promise<NSEFiling[]> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();

  try {
    const cookie = await getSession();
    const path = `/api/corporates-financial-results?symbol=${encodeURIComponent(clean)}`;

    const rawResp = await ky.get(`${NSE_BASE}${path}`, {
      timeout: API_TIMEOUT_MS,
      headers: { ...NSE_HEADERS, Cookie: cookie },
      throwHttpErrors: false,
    });

    if (!rawResp.ok) return [];

    const text = await rawResp.text();
    // Challenge page carrying a 200 — not JSON, so not archivable (see
    // fetchNSEAnnouncements).
    if (!text.trim() || text.trimStart().startsWith("<")) return [];
    let resp: { results?: unknown[] };
    try {
      resp = JSON.parse(text);
    } catch {
      return []; // NSE returned HTML error page
    }

    // P5.7 — same bypass, same fix (MONEY-1189). Raw text, before the domain
    // parse; per-symbol paths are skipped inside the seam.
    await archiveNseJsonResponse(path, text);

    return parseFinancialResults(clean, resp);
  } catch (err) {
    logger.error(`Failed to fetch NSE financial results for ${clean}:`, err);
    return [];
  }
}

// ── Corporate Actions ────────────────────────────────────────────────

/**
 * Fetch corporate actions (dividends, splits, bonuses) from NSE
 */
export async function fetchNSECorporateActions(
  symbol: string,
): Promise<NSECorporateAction[]> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();

  try {
    const cookie = await getSession();
    const path = `/api/corporates-corporateActions?index=equities&symbol=${encodeURIComponent(clean)}`;

    // `.text()` rather than `.json()`: the archive stores what NSE served, and
    // a response already decoded into an object cannot produce that. HTTP
    // errors still throw (ky's default `throwHttpErrors`) into the catch below,
    // exactly as they did before — only the decode moved.
    const httpResp = await ky.get(`${NSE_BASE}${path}`, {
      timeout: API_TIMEOUT_MS,
      headers: { ...NSE_HEADERS, Cookie: cookie },
    });
    const text = await httpResp.text();

    // A challenge page carries HTTP 200. It used to reach here as a JSON.parse
    // failure and get logged by the catch; keep it visible rather than turning
    // a throttled NSE into a silent empty result.
    if (!text.trim() || text.trimStart().startsWith("<")) {
      logger.warn(
        `NSE corporate actions for ${clean}: challenge/empty body (${text.length} bytes)`,
      );
      return [];
    }

    const resp = JSON.parse(text) as unknown[];

    // P5.7 — same bypass, same fix (MONEY-1189). Raw text, before the domain
    // parse; per-symbol paths are skipped inside the seam.
    await archiveNseJsonResponse(path, text);

    return parseCorporateActions(clean, resp);
  } catch (err) {
    logger.error(`Failed to fetch NSE corporate actions for ${clean}:`, err);
    return [];
  }
}

/**
 * Format a JS `Date` as NSE's `DD-MM-YYYY` query format (e.g. `15-03-2024`).
 * Exported so the worker / tests can build the same window the API expects.
 */
export function formatNSEDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * MONEY-852 — BULK corporate actions for the WHOLE market over a date window.
 *
 * Same `corporates-corporateActions` endpoint as {@link fetchNSECorporateActions}
 * but the `symbol` param is OMITTED — NSE then returns every equity's actions
 * whose ex-date falls in `[fromDate, toDate]`. This replaces the 200-symbol
 * per-symbol fan-out in the corporate-actions-sync worker with ONE call per
 * window (the per-symbol API capped at ~200 symbols/run and paced 2.5s each;
 * the bulk window covers the entire listed universe in a single request).
 *
 * Each raw row carries its own `symbol` field, so we group by symbol and run the
 * SAME `parseCorporateActions` parser per group — the structured ratio/type/
 * face-value extraction is identical to the single-symbol path, and the merge /
 * dedupe downstream is unchanged.
 *
 * `fromDate` / `toDate` accept a `Date` or an already-formatted `DD-MM-YYYY`
 * string. Returns `[]` (never throws) on any NSE failure so a flaky bulk leg
 * can't abort the worker run.
 */
export async function fetchNSECorporateActionsBulk(
  fromDate: Date | string,
  toDate: Date | string,
): Promise<NSECorporateAction[] | null> {
  const from =
    typeof fromDate === "string" ? fromDate : formatNSEDate(fromDate);
  const to = typeof toDate === "string" ? toDate : formatNSEDate(toDate);

  const path =
    `/api/corporates-corporateActions?index=equities` +
    `&from_date=${encodeURIComponent(from)}&to_date=${encodeURIComponent(to)}`;

  // RETRIED, because a single miss here costs a YEAR of history and says
  // nothing about it (MONEY-1189).
  //
  // This used to be one attempt at a flat 15s, returning `[]` on failure — and
  // `[]` is also what a legitimately empty window returns. On the 20-year
  // backfill the 2006-08..2007-08 windows timed out, so the run reported
  // `nse=15213` unchanged across its last two chunks. That reads exactly like
  // NSE's known ~2020 history plateau, which is why it went unnoticed; the
  // dividend series simply stopped at 2008 instead of 2006.
  //
  // Deep windows are the slow ones (more rows, colder upstream cache), so the
  // timeout GROWS per attempt rather than repeating a deadline already known to
  // be too short.
  //
  // Each retry also drops the cached session first. Growing the deadline alone
  // did NOT fix it: 37 windows still failed in whole-chunk trios, and the
  // pattern tracked the preceding BSE leg's duration rather than the window's
  // size — a fast BSE leg left our 5-minute TTL unexpired, so all three
  // attempts reused a cookie NSE had already retired, while the same window
  // fetched from a fresh process answered in ~300ms.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Not on the first attempt — a live cookie is the normal case and a
      // needless handshake per window is a round trip against a rate-limited
      // host, ~40 of them on a 20-year walk.
      if (attempt > 0) invalidateNseSession();
      const cookie = await getSession();
      const httpResp = await ky.get(`${NSE_BASE}${path}`, {
        timeout: API_TIMEOUT_MS * (attempt + 2), // 30s, 45s, 60s
        headers: { ...NSE_HEADERS, Cookie: cookie },
        throwHttpErrors: false,
        // ky retries internally by default, and its retry REPLAYS the same
        // request — same cookie, same everything. Against a session NSE has
        // retired that is three guaranteed failures against a rate-limited host
        // before the loop below ever gets to re-handshake. The retry policy
        // belongs at the layer that can change something between attempts.
        retry: 0,
      });
      const text = await httpResp.text();

      // An HTML challenge page carries HTTP 200, so status never decides this.
      // It IS retryable — it means throttled, not "no such data".
      if (!text.trim() || text.trimStart().startsWith("<")) {
        if (attempt < 2) {
          await new Promise((r) =>
            setTimeout(r, retryBackoffMs() * (attempt + 1)),
          );
          continue;
        }
        logger.error(
          `NSE bulk corporate actions ${from}..${to}: challenge/empty body after 3 attempts`,
        );
        return null;
      }

      const resp = JSON.parse(text) as unknown[];

      // P5.7: this is the ONE market-wide NSE JSON leg that used to bypass the
      // archive — it built its request with `searchParams` instead of a path
      // string, so it never reached `archiveNseJsonResponse` even though
      // nse-json-archive.ts registers `corporates-corporateActions` as a family
      // and promises the 20-year windowed backfill yields one object per window.
      // Without this the entire corp-actions backfill parsed and discarded every
      // window, and a later parser bug would be unfixable against windows NSE
      // has since thinned.
      await archiveNseJsonResponse(path, text);

      return parseBulkCorporateActions(resp);
    } catch (err) {
      const last = attempt === 2;
      logger[last ? "error" : "warn"](
        `NSE bulk corporate actions ${from}..${to} attempt ${attempt + 1}/3 failed:`,
        err instanceof Error ? err.message : err,
      );
      // Still never throws — a flaky leg must not abort a scheduled run. NULL,
      // not `[]`: the caller must be able to tell "we failed to ask" from "NSE
      // answered, nothing happened in this window".
      if (last) return null;
      await new Promise((r) => setTimeout(r, retryBackoffMs() * (attempt + 1)));
    }
  }

  return null;
}

/**
 * Fetch annual reports (filters announcements for "Annual Report" keyword)
 */
export async function fetchAnnualReports(symbol: string): Promise<NSEFiling[]> {
  const announcements = await fetchNSEAnnouncements(symbol);
  return filterAnnualReports(announcements);
}

export type { NseAnnouncementDocType } from "./nse-filings-logic";

/**
 * MONEY-784 (P3b) — fetch the full NSE announcement feed and bucket each useful
 * filing into its docType (annual report / investor presentation / credit rating
 * / press release / earnings-call intimation). Noise drops out. The sync worker
 * uses this to ingest the broadened set of categories, not just annual reports.
 */
export async function fetchCategorizedAnnouncements(
  symbol: string,
): Promise<Array<{ filing: NSEFiling; docType: NseAnnouncementDocType }>> {
  const announcements = await fetchNSEAnnouncements(symbol);
  return categorizeAnnouncements(announcements);
}

// ── MONEY-1098 (P5.4) — ownership feeds ──────────────────────────────────────
//
// Shareholding patterns, insider (PIT) disclosures, SAST Reg-29 filings and
// promoter pledges. Four cookie-gated `/api/*` endpoints, three of them
// per-symbol, sharded across the week by the ownership-sync worker.
//
// These fetchers return the RAW decoded payload, not rows. Parsing lives in
// `ownership-logic.ts` (pure, unit-tested, never throws); this file stays the
// I/O seam. The split matters here more than usual because every one of the
// four response shapes is a guess — see ownership-logic's header — and a guess
// you can unit-test against a fixture is a different risk from a guess buried
// in a network call.

/**
 * Minimal response surface the fetchers need. Declared structurally so tests can
 * hand in a plain object and never open a socket.
 */
export interface NseResponseLike {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

/**
 * Injectable transport. Supplying one means "no network AT ALL" — the cookie
 * handshake is skipped along with the request, because {@link getSession} is
 * itself network I/O (three attempts with backoff sleeps) and a test that
 * injected only the API call would still hang on the warm-up.
 */
export type NseFetchImpl = (
  url: string,
  init: { headers: Record<string, string>; timeoutMs: number },
) => Promise<NseResponseLike>;

export interface NseFetchOptions {
  fetchImpl?: NseFetchImpl;
}

/**
 * The site page that OWNS each XHR, sent as the `Referer`.
 *
 * NOT cosmetic. MONEY-1097's probe run established that NSE gates several
 * `/api/*` routes on the Referer matching the page a browser would have called
 * from, and answers a mismatch with `200 {"data":[]}` — a well-formed EMPTY
 * result, not an error. The generic `https://www.nseindia.com/` Referer the
 * older fetchers in this file use is fine for the endpoints they hit, but an
 * empty ownership response would be indistinguishable from "this company filed
 * nothing", so each ownership endpoint names its own page.
 *
 * ASSUMPTION: these four page paths are inferred from NSE's corporate-filings
 * navigation, not captured from DevTools. If a feed returns a well-formed empty
 * payload for EVERY symbol in a shard, suspect the Referer (or the endpoint
 * name — `corporates-pit` turned out to be `corporates-pit-gg` in bulk mode)
 * before concluding the market filed nothing.
 */
export const NSE_OWNERSHIP_REFERERS = {
  shareholding:
    "https://www.nseindia.com/companies-listing/corporate-filings-shareholding-pattern",
  pit: "https://www.nseindia.com/companies-listing/corporate-filings-insider-trading",
  sast: "https://www.nseindia.com/companies-listing/corporate-filings-sast-reg29",
  pledge:
    "https://www.nseindia.com/companies-listing/corporate-filings-pledged-data",
} as const;

/** ky-backed default transport. Isolated so the injectable seam has one shape. */
const kyFetchImpl: NseFetchImpl = async (url, init) => {
  const resp = await ky.get(url, {
    timeout: init.timeoutMs,
    headers: init.headers,
    throwHttpErrors: false,
  });
  return {
    ok: resp.ok,
    status: resp.status,
    text: () => resp.text(),
  };
};

/**
 * GET a cookie-gated NSE JSON endpoint with a page-specific Referer.
 *
 * Same never-throw contract as {@link fetchNseApiJson} — `null` on any failure
 * (non-2xx, HTML challenge page, malformed JSON) — because these run inside a
 * scheduled fan-out where one bad symbol must not abort the job. It is a
 * separate function rather than an extra parameter on `fetchNseApiJson` so the
 * existing MONEY-1097 caller's header set is untouched.
 */
async function fetchNseOwnershipJson(
  path: string,
  referer: string,
  options?: NseFetchOptions,
): Promise<unknown | null> {
  const fetchImpl = options?.fetchImpl;
  try {
    // Injected transport ⇒ no session warm-up (see NseFetchImpl).
    const cookie = fetchImpl ? "" : await getSession();
    const headers: Record<string, string> = {
      ...NSE_HEADERS,
      Referer: referer,
      // The browser sends this on every corporate-filings XHR; NSE's Akamai
      // rules look at it, and it costs nothing to match.
      "X-Requested-With": "XMLHttpRequest",
      ...(cookie ? { Cookie: cookie } : {}),
    };

    const resp = await (fetchImpl ?? kyFetchImpl)(`${NSE_BASE}${path}`, {
      headers,
      timeoutMs: API_TIMEOUT_MS,
    });
    if (!resp.ok) return null;

    const text = await resp.text();
    // A throttled / cookieless request comes back as an HTML challenge page
    // carrying a 200, so status alone never decides success.
    if (!text.trim() || text.trimStart().startsWith("<")) return null;
    const parsed = JSON.parse(text) as unknown;
    // P5.7: market-wide responses (the pledge feed here) also land in the
    // feed archive — per-symbol paths are skipped inside.
    await archiveNseJsonResponse(path, text);
    return parsed;
  } catch (err) {
    logger.warn(
      `NSE ownership fetch failed for ${path}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Shareholding pattern master for one symbol — promoter / pledge / FII / DII /
 * public percentages per quarter.
 *
 * QUERY SHAPE: `?index=equities&symbol=X` — VERIFIED, not assumed.
 *
 * The first prod run falsified the original guess (`?symbol=X` alone) in the
 * loudest possible way: NSE answered EVERY symbol with the bare string
 * "missing index", which is not JSON, so the parse threw and all ~2,000
 * symbols failed. Probed live afterwards: without `index` the call returns
 * null; with `index=equities` it returns a 22-row array. `index` is REQUIRED
 * here, unlike on the sibling PIT / SAST endpoints, which answer identically
 * with and without it — which is exactly why the guess looked safe.
 *
 * `industry` and `period` remain omitted; they are genuine filters.
 */
export async function fetchShareholdingMaster(
  symbol: string,
  options?: NseFetchOptions,
): Promise<unknown | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  if (!clean) return null;
  return fetchNseOwnershipJson(
    `/api/corporate-share-holdings-master?index=equities&symbol=${encodeURIComponent(clean)}`,
    NSE_OWNERSHIP_REFERERS.shareholding,
    options,
  );
}

/**
 * SEBI PIT (Reg 7) insider-trading disclosures for ONE symbol.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TODO(MONEY-1098) — BULK MODE IS BLOCKED PENDING DEVTOOLS CAPTURE OF THE
 * INSIDER-TRADING PAGE XHR.
 *
 * A whole-market window call would replace ~600 requests/day with one, exactly
 * as MONEY-852 did for corporate actions. It is NOT shipped because every
 * guessed parameter set has come back well-formed and EMPTY:
 *
 *   /api/corporates-pit?index=equities&from_date=…&to_date=…
 *     → 200 {"acqNameList":[],"data":[]}   (page Referer)
 *     → 200 {"acqNameList":[],"data":[]}   (generic Referer — the A/B control)
 *
 * The Referer A/B ruled headers out, and MONEY-1097 later found the bulk route
 * is named `corporates-pit-gg` with an UNPADDED day (`9-07-2026`) — and it is
 * STILL empty. So the remaining unknown is the parameter set itself, and the
 * only way to learn it is to open
 * https://www.nseindia.com/companies-listing/corporate-filings-insider-trading
 * in DevTools and copy the request the page's own table makes.
 *
 * Until then per-symbol IS the shipped path — it works, it is just 600× the
 * requests. Do NOT block the ownership sync on the bulk upgrade; swap it in
 * behind this function when the capture lands.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function fetchInsiderTradingPit(
  symbol: string,
  options?: NseFetchOptions,
): Promise<unknown | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  if (!clean) return null;
  return fetchNseOwnershipJson(
    `/api/corporates-pit?symbol=${encodeURIComponent(clean)}`,
    NSE_OWNERSHIP_REFERERS.pit,
    options,
  );
}

/**
 * SAST Reg-29 filings for one symbol — disclosures crossing the 5% substantial-
 * acquisition thresholds. Per-symbol for the same reason as PIT: no verified
 * bulk parameter set.
 */
export async function fetchSastReg29(
  symbol: string,
  options?: NseFetchOptions,
): Promise<unknown | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  if (!clean) return null;
  return fetchNseOwnershipJson(
    `/api/corporate-sast-reg29?symbol=${encodeURIComponent(clean)}`,
    NSE_OWNERSHIP_REFERERS.sast,
    options,
  );
}

/**
 * Promoter pledge data — BULK, one call for the whole market.
 *
 * No `symbol` parameter: this endpoint backs a market-wide table, so each row
 * carries its own symbol and `parsePledgeData` attributes from the row. That is
 * why the pledge leg costs ONE request per run regardless of shard size, and
 * why it is fetched outside the paced per-symbol walk.
 */
export async function fetchPledgeData(
  options?: NseFetchOptions,
): Promise<unknown | null> {
  return fetchNseOwnershipJson(
    "/api/corporate-pledgedata",
    NSE_OWNERSHIP_REFERERS.pledge,
    options,
  );
}

// ── Paced per-symbol fan-out ─────────────────────────────────────────────────

export interface PacedRunOptions {
  /** Quiet time inside a lane between one symbol finishing and the next starting. */
  delayMs?: number;
  /**
   * Lanes running concurrently. > 1 because the arithmetic does not work
   * otherwise: a ~600-symbol shard × 3 per-symbol endpoints is ~1,800 requests,
   * and the Pub/Sub ack deadline is 600s. Sequential at the 2.5s pacing the old
   * corporate-actions fan-out used would take over an hour. Kept small anyway —
   * NSE/Akamai throttles, and a 429 costs the whole shard, not one symbol.
   */
  concurrency?: number;
  /**
   * Absolute `Date.now()` millisecond deadline. Lanes stop TAKING new symbols
   * past it; work already in flight is allowed to finish. The remainder is
   * reported as `skippedForBudget` — never silently dropped, because a budget
   * cut that does not appear in the counters looks exactly like a shard that
   * had nothing to fetch.
   */
  deadline?: number;
  /** Injectable sleep so tests never hold a real timer (orphan safety). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Called per failed symbol. The walk continues regardless. */
  onError?: (symbol: string, err: unknown) => void;
}

export interface PacedRunResult {
  processed: number;
  failed: number;
  skippedForBudget: number;
}

/** Default quiet time between per-symbol NSE calls within a lane. */
export const NSE_PER_SYMBOL_DELAY_MS = 600;
/** Default lane count. */
export const NSE_PER_SYMBOL_CONCURRENCY = 3;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Walk `symbols`, running `work` for each, paced and budget-capped.
 *
 * Exists so no caller ever writes a bare `for … await fetch` loop against NSE
 * again. A bare loop gets three things wrong every time it is rewritten: it
 * paces on the wrong side of the last item, it lets one thrown symbol abort the
 * run, and it has no relationship to the ack deadline.
 *
 * Lanes pull from ONE shared cursor rather than being handed a pre-sliced range,
 * so a slow symbol cannot leave a lane idle while another lane still has a
 * queue. Order across lanes is therefore not deterministic — which is fine,
 * every write downstream is an idempotent upsert.
 */
export async function runPacedPerSymbol(
  symbols: string[],
  work: (symbol: string) => Promise<void>,
  options?: PacedRunOptions,
): Promise<PacedRunResult> {
  const delayMs = options?.delayMs ?? NSE_PER_SYMBOL_DELAY_MS;
  const lanes = Math.max(
    1,
    Math.trunc(options?.concurrency ?? NSE_PER_SYMBOL_CONCURRENCY),
  );
  const deadline = options?.deadline ?? Number.POSITIVE_INFINITY;
  const sleep = options?.sleepImpl ?? defaultSleep;

  let cursor = 0;
  let processed = 0;
  let failed = 0;

  const runLane = async (): Promise<void> => {
    for (;;) {
      if (Date.now() > deadline) return;
      const index = cursor++;
      if (index >= symbols.length) return;
      const symbol = symbols[index]!;

      try {
        await work(symbol);
        processed++;
      } catch (err) {
        failed++;
        options?.onError?.(symbol, err);
      }

      // Pace only when there is more to do — a trailing sleep is pure latency.
      if (cursor < symbols.length && delayMs > 0) {
        await sleep(delayMs);
      }
    }
  };

  await Promise.all(Array.from({ length: lanes }, () => runLane()));

  return {
    processed,
    failed,
    skippedForBudget: Math.max(0, symbols.length - processed - failed),
  };
}
