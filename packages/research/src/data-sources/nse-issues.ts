/**
 * NSE issues / annual-reports / integrated-filings — the I/O half.
 *
 * MONEY-1098 (P5.5 + P5.6 + integrated filings). Five cookie-gated
 * `www.nseindia.com/api/*` readers:
 *
 *   - {@link fetchAnnualReports}      `/api/annual-reports?index=equities&symbol=`
 *   - {@link fetchUpcomingIpos}       `/api/all-upcoming-issues?category=ipo`
 *   - {@link fetchCurrentIpos}        `/api/ipo-current-issue`
 *   - {@link fetchPastIssues}         `/api/public-past-issues`
 *   - {@link fetchIntegratedFilings}  `/api/integrated-filing-results?index=equities&from_date=&to_date=`
 *
 * ## Why this file exists instead of a call into `nse-filings.ts`
 *
 * `nse-filings.ts` is owned elsewhere in this wave, so its cookie handshake is
 * COPIED here rather than imported. The copy is deliberate and temporary; the
 * hand-off note in the final report asks for the two handshakes to be unified
 * behind one client after the wave lands. The subtleties that MUST survive that
 * unification are called out at {@link getSession}: Akamai answers the first
 * request with a 403 that STILL SETS the cookies you need, so the retry is
 * load-bearing, and a cookieless request comes back as an HTML challenge page
 * carrying HTTP 200 — status alone never decides success.
 *
 * ## Injectable `fetchImpl`
 *
 * Every function takes `{ fetchImpl }`. Not for mocking convenience: it is what
 * lets the URL construction, the envelope handling and the challenge-page
 * detection be tested WITHOUT touching NSE. No test in this repo may make a
 * live NSE call, and a data source that can only be exercised live is a data
 * source whose parsing is never exercised at all.
 *
 * No function throws — these run inside scheduled Pub/Sub jobs where one flaky
 * leg must not abort the run. Most return `[]` on any failure.
 * {@link fetchIntegratedFilings} is the exception: it returns `null` when the
 * FETCH failed and `[]` when NSE answered with an empty window, because its
 * caller logs those two as different diagnoses and collapsing them reported an
 * NSE timeout as probable parser shape-drift (MONEY-1189).
 *
 * @see packages/research/src/data-sources/issues-logic.ts (the pure parsers)
 * @see workers/src/processors/annual-reports-sync.ts (leg A + leg B caller)
 * @see workers/src/processors/ipo-sync.ts (IPO caller)
 */

import {
  parseAnnualReports,
  parseIpoIssues,
  parseIntegratedFilings,
  formatNseQueryDate,
  normalizeIssueSymbol,
  type NseAnnualReport,
  type IpoIssue,
  type IntegratedFiling,
} from "./issues-logic";
import { archiveNseJsonResponse } from "./nse-json-archive";

const logger = {
  info: (...args: unknown[]) => console.log("[nse-issues]", ...args),
  warn: (...args: unknown[]) => console.warn("[nse-issues]", ...args),
};

export const NSE_BASE = "https://www.nseindia.com";
const API_TIMEOUT_MS = 15_000;
const SESSION_TTL_MS = 5 * 60 * 1000;

const NSE_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: `${NSE_BASE}/`,
};

// ── Injection seam ───────────────────────────────────────────────────────

export interface NseRequestInit {
  headers?: Record<string, string>;
  redirect?: "manual" | "follow";
  signal?: AbortSignal;
}

/**
 * The slice of `Response` this module reads. Narrow on purpose: a fake in a
 * test should not have to implement `blob()`, `formData()` and friends to be a
 * valid stand-in.
 */
export interface NseResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type NseFetchImpl = (
  url: string,
  init?: NseRequestInit,
) => Promise<NseResponseLike>;

export interface NseIssuesOptions {
  /** Defaults to the global `fetch`. */
  fetchImpl?: NseFetchImpl;
  /** Pre-obtained cookie, to skip the handshake (batch callers). */
  cookie?: string;
}

/** `globalThis.fetch` satisfies {@link NseFetchImpl} structurally. */
const defaultFetch: NseFetchImpl = (url, init) => fetch(url, init);

// ── Session ──────────────────────────────────────────────────────────────

let sessionCookie: string | null = null;
let sessionExpiry = 0;

/**
 * Split a `set-cookie` header into `name=value` pairs.
 *
 * The split pattern is `", "` FOLLOWED BY a cookie name — not a bare comma.
 * `Expires=Mon, 29 Mar 2027 …` contains a comma, and splitting on it shreds
 * every cookie in the header.
 */
export function extractCookies(setCookie: string): string[] {
  const cookies: string[] = [];
  for (const part of setCookie.split(/,\s*(?=[a-zA-Z_][a-zA-Z0-9_]*=)/)) {
    const nameValue = part.trim().split(";")[0];
    if (nameValue && nameValue.includes("=")) cookies.push(nameValue);
  }
  return cookies;
}

/**
 * Obtain (and cache) an NSE session cookie.
 *
 * Three attempts, because Akamai routinely 403s the first hit while still
 * setting the challenge cookies the subsequent API call needs — so a 403 with
 * cookies is PROGRESS, not a failure, and returning early on `!ok` would make
 * every API call cookieless.
 *
 * CACHE SCOPE: the module-level cache is used ONLY for the default (real)
 * fetch. An injected `fetchImpl` always performs its own handshake and never
 * reads or writes the cache — otherwise one test's fake cookie would be handed
 * to the next caller in the same process (and, in a worker that both tests and
 * runs, to NSE itself).
 */
async function getSession(fetchImpl: NseFetchImpl): Promise<string> {
  const isDefault = fetchImpl === defaultFetch;
  if (isDefault && sessionCookie && Date.now() < sessionExpiry) {
    return sessionCookie;
  }

  let obtained = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetchImpl(NSE_BASE, {
        headers: { ...NSE_HEADERS },
        redirect: "manual",
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      const setCookieHeader = resp.headers.get("set-cookie");
      if (setCookieHeader) {
        const parts = extractCookies(setCookieHeader);
        if (parts.length > 0) {
          obtained = parts.join("; ");
          if (isDefault) {
            sessionCookie = obtained;
            sessionExpiry = Date.now() + SESSION_TTL_MS;
          }
          if (resp.ok) return obtained;
          // 403 + cookies = Akamai challenge; retry WITH them.
          if (resp.status === 403 && attempt < 2) {
            await sleep(2000 * (attempt + 1));
            continue;
          }
          return obtained;
        }
      }
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    } catch (err) {
      if (attempt < 2) {
        await sleep(2000 * (attempt + 1));
      } else {
        logger.warn(
          "Failed to get NSE session after 3 attempts:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  return obtained || (isDefault ? (sessionCookie ?? "") : "");
}

/**
 * GET a cookie-gated NSE JSON endpoint. Returns `null` on ANY failure.
 *
 * The HTML check is not defensive padding: NSE answers a throttled or
 * cookieless request with a challenge PAGE carrying HTTP 200, so `resp.ok`
 * alone would hand `JSON.parse` a document and turn a rate-limit into a crash
 * inside a scheduled job.
 */
export async function fetchNseIssuesJson<T = unknown>(
  path: string,
  options?: NseIssuesOptions,
): Promise<T | null> {
  const fetchImpl = options?.fetchImpl ?? defaultFetch;
  try {
    const cookie = options?.cookie ?? (await getSession(fetchImpl));
    const resp = await fetchImpl(`${NSE_BASE}${path}`, {
      headers: { ...NSE_HEADERS, Cookie: cookie },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!resp.ok) {
      logger.warn(`NSE ${path} → HTTP ${resp.status}`);
      return null;
    }
    const text = await resp.text();
    if (!text.trim() || text.trimStart().startsWith("<")) {
      logger.warn(`NSE ${path} → challenge/HTML body (${text.length} bytes)`);
      return null;
    }
    const parsed = JSON.parse(text) as T;
    // P5.7: market-wide responses (issue lists, integrated filings) also land
    // in the feed archive — per-symbol paths (annual-reports) are skipped.
    await archiveNseJsonResponse(path, text);
    return parsed;
  } catch (err) {
    logger.warn(
      `NSE issues fetch failed for ${path}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ── Annual reports (P5.5) ────────────────────────────────────────────────

/**
 * Annual reports for ONE symbol.
 *
 * `index=equities` mirrors every other per-symbol NSE corporate endpoint. The
 * response envelope is not assumed — {@link parseAnnualReports} accepts a bare
 * array and a `{data:[…]}` wrapper, because guessing wrong yields `[]`, which
 * is indistinguishable from "this company filed nothing".
 */
export async function fetchAnnualReports(
  symbol: string,
  options?: NseIssuesOptions,
): Promise<NseAnnualReport[]> {
  const clean = normalizeIssueSymbol(symbol);
  if (!clean) return [];
  const resp = await fetchNseIssuesJson(
    `/api/annual-reports?index=equities&symbol=${encodeURIComponent(clean)}`,
    options,
  );
  if (resp === null) return [];
  return parseAnnualReports(clean, resp);
}

// ── IPO issues (P5.6) ────────────────────────────────────────────────────

/**
 * Forthcoming issues. `category=ipo` excludes rights issues / debt / SGB rows
 * that share the endpoint — without it the IPO table would fill with
 * instruments that have no `issueStart` and get dropped at the upsert.
 */
export async function fetchUpcomingIpos(
  options?: NseIssuesOptions & { now?: Date },
): Promise<IpoIssue[]> {
  const resp = await fetchNseIssuesJson(
    "/api/all-upcoming-issues?category=ipo",
    options,
  );
  if (resp === null) return [];
  return parseIpoIssues(resp, "upcoming", options?.now ?? new Date());
}

/** Issues currently open for bidding — the only same-day-accurate source. */
export async function fetchCurrentIpos(
  options?: NseIssuesOptions & { now?: Date },
): Promise<IpoIssue[]> {
  const resp = await fetchNseIssuesJson("/api/ipo-current-issue", options);
  if (resp === null) return [];
  return parseIpoIssues(resp, "current", options?.now ?? new Date());
}

/** Closed / listed issues — usually the only carrier of `listingDate`. */
export async function fetchPastIssues(
  options?: NseIssuesOptions & { now?: Date },
): Promise<IpoIssue[]> {
  const resp = await fetchNseIssuesJson("/api/public-past-issues", options);
  if (resp === null) return [];
  return parseIpoIssues(resp, "past", options?.now ?? new Date());
}

// ── Integrated filings ───────────────────────────────────────────────────

/**
 * SEBI integrated filings for a DATE WINDOW across the whole equities segment.
 *
 * This is the one endpoint here with a CONFIRMED param set: MONEY-1097 P1
 * probed `?index=equities&from_date=08-07-2026&to_date=07-08-2026` and got
 * 200 / 15,066 bytes of `{"data":[…]}` (see
 * `docs/reference/exchange-archive-probe.json`). It is a market-wide window
 * query — one call covers every listed company — which is why it rides the
 * daily job as a second leg instead of fanning out per symbol.
 *
 * Dates are formatted as NSE's `DD-MM-YYYY` **in IST**: the window is a trading
 * calendar window, and formatting a 00:30-IST instant in UTC would ask for the
 * previous day and silently lose a day of filings at each end.
 */
export async function fetchIntegratedFilings(
  from: Date | string,
  to: Date | string,
  options?: NseIssuesOptions,
): Promise<IntegratedFiling[] | null> {
  const fromStr = typeof from === "string" ? from : formatNseQueryDate(from);
  const toStr = typeof to === "string" ? to : formatNseQueryDate(to);
  const resp = await fetchNseIssuesJson(
    `/api/integrated-filing-results?index=equities&from_date=${encodeURIComponent(fromStr)}&to_date=${encodeURIComponent(toStr)}`,
    options,
  );
  // NULL means the FETCH failed (non-2xx, HTML challenge, timeout); `[]` means
  // NSE answered and the window is genuinely empty. Collapsing both to `[]` —
  // which this did — made a transport failure indistinguishable from "no
  // filings this week", and the caller's log then reported shape drift for what
  // was really an NSE timeout. Observed on 2026-08-12: leg B logged "filings=0
  // … or the response shape changed" while the archive recorded no object at
  // all, which only happens when the response never arrived.
  if (resp === null) return null;
  return parseIntegratedFilings(resp);
}

/** Resolve an NSE attachment path to an absolute URL. */
export function buildNseAttachmentUrl(path: string): string {
  return path.startsWith("http") ? path : `${NSE_BASE}${path}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
