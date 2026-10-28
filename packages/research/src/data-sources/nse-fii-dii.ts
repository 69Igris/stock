/**
 * NSE FII/DII Flows Client
 *
 * Fetches daily FII (Foreign Institutional Investor) and DII (Domestic
 * Institutional Investor) buy/sell/net flow data from NSE India.
 *
 * Uses the same cookie-based session approach as the existing NseClient.
 */

import { cacheWrap } from "./cache";
import { archiveNseJsonResponse } from "./nse-json-archive";
// MONEY-1196 — the SAME date parser the ingestion worker uses. Reused rather
// than re-derived: a second implementation of NSE's date grammar is the drift
// this codebase keeps paying for.
import { parseNseFlowDate } from "@usemoney/core/market-data";

// ─── Types ───────────────────────────────────────────────────

export interface FIIDIIFlow {
  date: string;
  fii: { buyValue: number; sellValue: number; netValue: number };
  dii: { buyValue: number; sellValue: number; netValue: number };
}

export interface FIIDIISummary {
  flows: FIIDIIFlow[];
  fiiNetTotal: number;
  diiNetTotal: number;
  trend: "fii_buying" | "fii_selling" | "balanced";
  period: string;
}

// ─── NSE Session Management ──────────────────────────────────

const NSE_BASE = process.env.NSE_BASE_URL || "https://www.nseindia.com";
const SESSION_TTL = 300_000; // 5 minutes
const REQUEST_TIMEOUT_MS = 10_000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let cookies: string | null = null;
let cookieExpiry = 0;
let refreshPromise: Promise<void> | null = null;

async function refreshSession(): Promise<void> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${NSE_BASE}/`, {
        headers: { "User-Agent": UA },
        redirect: "manual",
      });

      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        const cookieParts: string[] = [];
        for (const part of setCookie.split(",")) {
          const trimmed = part.trim();
          const cookieValue = trimmed.split(";")[0];
          if (cookieValue && cookieValue.includes("=")) {
            cookieParts.push(cookieValue);
          }
        }
        cookies = cookieParts.join("; ");
        cookieExpiry = Date.now() + SESSION_TTL;
      }
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function ensureSession(): Promise<string> {
  if (!cookies || Date.now() >= cookieExpiry) {
    await refreshSession();
  }
  return cookies || "";
}

/**
 * Decode ONE NSE response and archive the raw bytes — MONEY-1195.
 *
 * Extracted so the first attempt and the 401/403 retry below cannot drift.
 * They previously each ended in their own `res.json()`, which is exactly the
 * shape that let three fetchers in `nse-filings.ts` archive from some paths and
 * not others (MONEY-1193): the fix there was to make ONE code path serve both
 * the request and the archive call, and the same applies to a retry.
 *
 * `.text()` rather than `.json()` on purpose. `.json()` consumes the stream and
 * hands back a parsed object, so the RAW bytes NSE served — the thing worth
 * archiving — no longer exist by the time we could store them. Decoding text
 * first also lets us apply the HTML-challenge guard the siblings use.
 *
 * Failure behaviour is deliberately unchanged: every path still returns `null`,
 * and malformed JSON still throws out to the caller's catch exactly as
 * `res.json()` did.
 */
async function decodeAndArchive<T>(
  res: Response,
  path: string,
): Promise<T | null> {
  const text = await res.text();
  // NSE answers a throttled or cookieless request with an HTML challenge page
  // carrying a 200, so status alone never decides success here. Guarding
  // BEFORE the archive is what keeps a challenge page out of the bucket — an
  // archived error page would be replayed as if it were data.
  if (!text.trim() || text.trimStart().startsWith("<")) {
    console.warn(
      "[nse-fii-dii] NSE returned a non-JSON body (challenge page?) for",
      path,
    );
    return null;
  }

  const parsed = JSON.parse(text) as T;

  // Archive only AFTER the parse succeeds, so bytes that are not valid JSON
  // never enter the archive. Awaited rather than floated: the call is
  // internally bounded by FEED_ARCHIVE_WRITE_TIMEOUT_MS and swallows every
  // error, so it cannot change what this function returns — which is the
  // "fire-and-forget" property that actually matters. A truly floating promise
  // would instead risk an unhandled rejection and an orphaned handle in tests.
  // No-op unless FEED_ARCHIVE_MODE=archive and a store is registered.
  await archiveNseJsonResponse(path, text);
  return parsed;
}

async function nseFetch<T>(path: string): Promise<T | null> {
  try {
    const sessionCookies = await ensureSession();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const res = await fetch(`${NSE_BASE}${path}`, {
      headers: {
        Cookie: sessionCookies,
        "User-Agent": UA,
        Accept: "application/json",
        Referer: `${NSE_BASE}/`,
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      // Session expired - refresh and retry once
      cookies = null;
      const newCookies = await ensureSession();

      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), REQUEST_TIMEOUT_MS);

      const retryRes = await fetch(`${NSE_BASE}${path}`, {
        headers: {
          Cookie: newCookies,
          "User-Agent": UA,
          Accept: "application/json",
          Referer: `${NSE_BASE}/`,
        },
        signal: controller2.signal,
      });

      clearTimeout(timer2);

      if (!retryRes.ok) return null;
      return await decodeAndArchive<T>(retryRes, path);
    }

    if (!res.ok) return null;
    return await decodeAndArchive<T>(res, path);
  } catch (error) {
    console.warn(
      "[nse-fii-dii] Fetch failed for",
      path,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// ─── Raw NSE Response Types ──────────────────────────────────

interface NseFIIDIIRecord {
  date?: string;
  category?: string;
  buyValue?: string | number;
  sellValue?: string | number;
  netValue?: string | number;
}

interface NseFIIDIIResponse {
  data?: NseFIIDIIRecord[];
}

// ─── Public Functions ────────────────────────────────────────

const CACHE_TTL_4H = 14_400; // 4 hours - flows are updated EOD

/**
 * Fetch FII/DII daily flow data from NSE.
 *
 * @param days - Number of recent trading days to return (default: 10)
 * @returns Array of daily FII/DII flows, or an error-bearing result
 */
export async function fetchFIIDIIFlows(
  days: number = 10,
): Promise<FIIDIISummary | null> {
  const cacheKey = `nse:fii_dii_flows:${days}`;

  return cacheWrap<FIIDIISummary>(
    cacheKey,
    async () => {
      const raw = await nseFetch<NseFIIDIIResponse>("/api/fiidiiTradeReact");

      // MONEY-1196 — accept BOTH shapes NSE serves.
      //
      // This read only `raw.data`. NSE sometimes returns a BARE ARRAY for this
      // endpoint, and in that case the old guard fell through to `return null`
      // ALWAYS — a permanently empty chat answer that reads as "no data" rather
      // than as a parse failure. The ingestion worker's parser already accepts
      // both shapes for this exact reason; this brings the read path in line.
      const records: unknown[] = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.data)
          ? raw.data
          : [];

      if (records.length === 0) {
        console.warn("[nse-fii-dii] No FII/DII data returned from NSE API");
        return null;
      }

      // NSE returns data grouped by category (FII/FPI and DII) with dates
      // Parse into our normalized format
      const dateMap = new Map<
        string,
        {
          fii: { buy: number; sell: number; net: number };
          dii: { buy: number; sell: number; net: number };
        }
      >();

      for (const record of records as NseFIIDIIRecord[]) {
        const date = record.date || "";
        const category = (record.category || "").toUpperCase();
        const buyValue = parseFloat(
          String(record.buyValue || "0").replace(/,/g, ""),
        );
        const sellValue = parseFloat(
          String(record.sellValue || "0").replace(/,/g, ""),
        );
        const netValue = parseFloat(
          String(record.netValue || "0").replace(/,/g, ""),
        );

        if (!date) continue;

        if (!dateMap.has(date)) {
          dateMap.set(date, {
            fii: { buy: 0, sell: 0, net: 0 },
            dii: { buy: 0, sell: 0, net: 0 },
          });
        }

        const entry = dateMap.get(date)!;

        if (category.includes("FII") || category.includes("FPI")) {
          entry.fii.buy += isNaN(buyValue) ? 0 : buyValue;
          entry.fii.sell += isNaN(sellValue) ? 0 : sellValue;
          entry.fii.net += isNaN(netValue) ? 0 : netValue;
        } else if (category.includes("DII")) {
          entry.dii.buy += isNaN(buyValue) ? 0 : buyValue;
          entry.dii.sell += isNaN(sellValue) ? 0 : sellValue;
          entry.dii.net += isNaN(netValue) ? 0 : netValue;
        }
      }

      // Convert to array, sort by date descending, and limit
      const flows: FIIDIIFlow[] = Array.from(dateMap.entries())
        .map(([date, entry]) => ({
          date,
          fii: {
            buyValue: Math.round(entry.fii.buy * 100) / 100,
            sellValue: Math.round(entry.fii.sell * 100) / 100,
            netValue: Math.round(entry.fii.net * 100) / 100,
          },
          dii: {
            buyValue: Math.round(entry.dii.buy * 100) / 100,
            sellValue: Math.round(entry.dii.sell * 100) / 100,
            netValue: Math.round(entry.dii.net * 100) / 100,
          },
        }))
        // MONEY-1196 — sort on the PARSED date, newest first.
        //
        // This was `b.date.localeCompare(a.date)`. NSE serves "DD-Mon-YYYY"
        // style strings, and comparing those as text orders them alphabetically
        // by day-of-month first: "02-Sep-2026" sorts BEFORE "13-Aug-2026". So
        // `.slice(0, days)` could keep the wrong rows and "latest" could name a
        // day that is not the latest — silently, because the shape and the
        // count both stay right.
        //
        // `parseNseFlowDate` is the same parser the ingestion worker uses
        // (`@usemoney/core/market-data`, Zod-validated, unit-tested). Reused
        // rather than re-derived: a second implementation of NSE's date grammar
        // is exactly the drift this codebase keeps paying for. A row whose date
        // will not parse sorts LAST rather than being dropped, so a shape change
        // degrades the ordering instead of silently shrinking the series.
        .sort((a, b) => {
          const da = parseNseFlowDate(a.date)?.getTime() ?? -Infinity;
          const db = parseNseFlowDate(b.date)?.getTime() ?? -Infinity;
          return db - da;
        })
        .slice(0, days);

      // Compute totals
      const fiiNetTotal = flows.reduce((sum, f) => sum + f.fii.netValue, 0);
      const diiNetTotal = flows.reduce((sum, f) => sum + f.dii.netValue, 0);

      // Determine trend
      let trend: FIIDIISummary["trend"] = "balanced";
      if (fiiNetTotal > 500) trend = "fii_buying";
      else if (fiiNetTotal < -500) trend = "fii_selling";

      const periodLabel =
        flows.length > 1
          ? `${flows[flows.length - 1]!.date} to ${flows[0]!.date}`
          : flows.length === 1
            ? flows[0]!.date
            : "N/A";

      return {
        flows,
        fiiNetTotal: Math.round(fiiNetTotal * 100) / 100,
        diiNetTotal: Math.round(diiNetTotal * 100) / 100,
        trend,
        period: periodLabel,
      };
    },
    CACHE_TTL_4H,
  );
}
