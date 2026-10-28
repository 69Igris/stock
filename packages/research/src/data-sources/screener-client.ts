/**
 * Screener.in Data Client
 *
 * Screener.in has no public API but exposes:
 * - /api/company/search/?q={query} - JSON search (no auth)
 * - /company/{SYMBOL}/consolidated/ - HTML page with 10-15 years of financials
 *
 * HTML parsing with regex (cheerio would be ideal but adds dependency).
 * 3-second delay between requests (community convention).
 * Parsed data cached in process memory (24h TTL via Redis in production).
 */

import ky from "ky";
import * as cheerio from "cheerio";
import { cacheWrap } from "./cache";

const logger = {
  warn: (...args: unknown[]) => console.warn("[screener]", ...args),
};

const BASE_URL = "https://www.screener.in";
const API_TIMEOUT_MS = 15_000;
const REQUEST_DELAY_MS = 3_000;

/** Simple delay between requests (3s per community convention) */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Search — DELETED, MONEY-1255 ───────────────────────────────────
//
// `searchScreener()` called `/api/company/search/?q=`, which screener.in's
// robots.txt disallows (`Disallow: /*?q=`, fetched 2026-08-26; `/api/` is not
// exempted and there are no `Allow:` lines). It had ZERO callers repo-wide —
// it violated the rule without buying anything.
//
// It is deleted rather than left behind a comment because a dead export is an
// invitation: the obvious way to resolve a company on screener is to search
// for it, and the next person needing that would have found this ready-made.
// The supported path is an ISIN join against BSE's own scrip master
// (`screener-resolve.ts`), which needs no search, cannot return the wrong
// company, and reaches the same page.
//
// The company PAGE fetch below stays — robots.txt allows it, and it is what
// the rest of this file has always used.

// ── Financial Data Extraction ──────────────────────────────────────

export interface ScreenerFinancialData {
  companyName: string;
  marketCap?: number;
  currentPrice?: number;
  pe?: number;
  bookValue?: number;
  dividendYield?: number;
  roce?: number;
  roe?: number;
  // Revenue and profit for multiple years
  annualRevenue: Array<{ year: string; value: number }>;
  annualProfit: Array<{ year: string; value: number }>;
  // Key ratios over time
  annualRoe: Array<{ year: string; value: number }>;
  // Shareholding pattern
  promoterHolding?: number;
  fiiHolding?: number;
  diiHolding?: number;
  publicHolding?: number;
}

/**
 * Fetch and parse financial data from Screener.in company page.
 * Returns structured data extracted from the HTML.
 * Cached in Redis for 24h (data changes quarterly).
 *
 * NOTE: This does basic regex parsing. For production-grade extraction,
 * consider adding cheerio as a dependency.
 */
export async function fetchScreenerFinancials(
  symbol: string,
): Promise<ScreenerFinancialData | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();

  return cacheWrap(
    `scr:fin:${clean}`,
    async () => {
      return fetchScreenerFinancialsUncached(clean);
    },
    365 * 86400,
  ); // 1 year TTL - historical financials rarely change
}

async function fetchScreenerFinancialsUncached(
  clean: string,
): Promise<ScreenerFinancialData | null> {
  await delay(REQUEST_DELAY_MS);

  try {
    const html = await ky
      .get(`${BASE_URL}/company/${clean}/consolidated/`, {
        timeout: API_TIMEOUT_MS,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; UseMoney/1.0; financial-research)",
          Accept: "text/html",
        },
      })
      .text();

    if (!html || html.length < 1000) {
      // Try standalone (non-consolidated)
      const standaloneHtml = await ky
        .get(`${BASE_URL}/company/${clean}/`, {
          timeout: API_TIMEOUT_MS,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; UseMoney/1.0; financial-research)",
            Accept: "text/html",
          },
        })
        .text();

      if (!standaloneHtml || standaloneHtml.length < 1000) return null;
      return parseScreenerHtml(standaloneHtml, clean);
    }

    return parseScreenerHtml(html, clean);
  } catch (error) {
    logger.warn(
      { symbol: clean, error },
      "Screener.in financials fetch failed",
    );
    return null;
  }
}

/**
 * Parse key financial data from Screener.in HTML using regex.
 */
function parseScreenerHtml(
  html: string,
  symbol: string,
): ScreenerFinancialData {
  const result: ScreenerFinancialData = {
    companyName: symbol,
    annualRevenue: [],
    annualProfit: [],
    annualRoe: [],
  };

  // Extract company name
  const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  if (nameMatch) {
    result.companyName = nameMatch[1]!.trim();
  }

  // Extract key ratios from the "ratios" section
  const ratioPatterns: Array<{
    key: keyof ScreenerFinancialData;
    pattern: RegExp;
  }> = [
    {
      key: "marketCap",
      pattern: /Market\s*Cap[^>]*>[\s\S]*?<span[^>]*>([\d,.]+)/,
    },
    {
      key: "currentPrice",
      pattern: /Current\s*Price[^>]*>[\s\S]*?<span[^>]*>([\d,.]+)/,
    },
    { key: "pe", pattern: /Stock\s*P\/E[^>]*>[\s\S]*?<span[^>]*>([\d,.]+)/ },
    {
      key: "bookValue",
      pattern: /Book\s*Value[^>]*>[\s\S]*?<span[^>]*>([\d,.]+)/,
    },
    {
      key: "dividendYield",
      pattern: /Dividend\s*Yield[^>]*>[\s\S]*?<span[^>]*>([\d,.]+)/,
    },
    { key: "roce", pattern: /ROCE[^>]*>[\s\S]*?<span[^>]*>([\d,.]+)/ },
    { key: "roe", pattern: /ROE[^>]*>[\s\S]*?<span[^>]*>([\d,.]+)/ },
  ];

  for (const { key, pattern } of ratioPatterns) {
    const match = html.match(pattern);
    if (match) {
      (result as unknown as Record<string, unknown>)[key] = parseFloat(
        match[1]!.replace(/,/g, ""),
      );
    }
  }

  // Extract shareholding pattern
  const shareholdingPatterns = [
    {
      key: "promoterHolding" as const,
      pattern: /Promoters?[^>]*>[\s\S]*?<td[^>]*>([\d.]+)\s*%/,
    },
    {
      key: "fiiHolding" as const,
      pattern: /FIIs?[^>]*>[\s\S]*?<td[^>]*>([\d.]+)\s*%/,
    },
    {
      key: "diiHolding" as const,
      pattern: /DIIs?[^>]*>[\s\S]*?<td[^>]*>([\d.]+)\s*%/,
    },
    {
      key: "publicHolding" as const,
      pattern: /Public[^>]*>[\s\S]*?<td[^>]*>([\d.]+)\s*%/,
    },
  ];

  for (const { key, pattern } of shareholdingPatterns) {
    const match = html.match(pattern);
    if (match) {
      result[key] = parseFloat(match[1]!);
    }
  }

  // Extract revenue/profit tables (simplified extraction)
  // Screener.in has tables with years as columns
  const revenueMatch = html.match(/Revenue[\s\S]*?<tr[^>]*>([\s\S]*?)<\/tr>/);
  if (revenueMatch) {
    const cells = revenueMatch[1]!.match(/<td[^>]*>([\d,.]+)<\/td>/g);
    if (cells) {
      result.annualRevenue = cells.slice(0, 10).map((cell, i) => {
        const val = cell.match(/([\d,.]+)/);
        return {
          year: `Y-${i}`,
          value: val ? parseFloat(val[1]!.replace(/,/g, "")) : 0,
        };
      });
    }
  }

  const profitMatch = html.match(/Net Profit[\s\S]*?<tr[^>]*>([\s\S]*?)<\/tr>/);
  if (profitMatch) {
    const cells = profitMatch[1]!.match(/<td[^>]*>([\d,.]+)<\/td>/g);
    if (cells) {
      result.annualProfit = cells.slice(0, 10).map((cell, i) => {
        const val = cell.match(/([\d,.]+)/);
        return {
          year: `Y-${i}`,
          value: val ? parseFloat(val[1]!.replace(/,/g, "")) : 0,
        };
      });
    }
  }

  return result;
}

// ── Quarterly Results ────────────────────────────────────────────

export interface ScreenerQuarterlyResult {
  period: string;
  revenue?: number;
  netProfit?: number;
  eps?: number;
  operatingProfit?: number;
}

export async function fetchScreenerQuarterlyResults(
  symbol: string,
): Promise<ScreenerQuarterlyResult[] | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  return cacheWrap(
    `scr:qtr:${clean}`,
    async () => {
      await delay(REQUEST_DELAY_MS);
      try {
        const html = await ky
          .get(`${BASE_URL}/company/${clean}/consolidated/`, {
            timeout: API_TIMEOUT_MS,
            headers: {
              "User-Agent":
                "Mozilla/5.0 (compatible; UseMoney/1.0; financial-research)",
              Accept: "text/html",
            },
          })
          .text();
        if (!html || html.length < 1000) return null;
        return parseQuarterlyResults(html);
      } catch {
        return null;
      }
    },
    86400,
  );
}

function parseQuarterlyResults(html: string): ScreenerQuarterlyResult[] | null {
  try {
    const $ = cheerio.load(html);
    const results: ScreenerQuarterlyResult[] = [];

    // Find the Quarterly Results section
    const section = $("section#quarters");
    if (!section.length) return null;

    const table = section.find("table").first();
    if (!table.length) return null;

    // Get column headers (quarters)
    const headers: string[] = [];
    table.find("thead th").each((_, th) => {
      headers.push($(th).text().trim());
    });

    // Parse rows
    const rowMap: Record<string, number[]> = {};
    table.find("tbody tr").each((_, tr) => {
      const cells = $(tr).find("td");
      const label = cells.first().text().trim().toLowerCase();
      const values: number[] = [];
      cells.each((i, td) => {
        if (i === 0) return;
        const val = $(td).text().trim().replace(/,/g, "");
        values.push(val ? parseFloat(val) : 0);
      });
      rowMap[label] = values;
    });

    // Build results from columns (skip first header which is the label column)
    for (let i = 0; i < headers.length - 1; i++) {
      results.push({
        period: headers[i + 1] || `Q${i + 1}`,
        revenue: rowMap["sales"]?.[i] ?? rowMap["revenue"]?.[i],
        operatingProfit: rowMap["operating profit"]?.[i],
        netProfit: rowMap["net profit"]?.[i],
        eps: rowMap["eps in rs"]?.[i] ?? rowMap["eps"]?.[i],
      });
    }

    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

// ── Shareholding Pattern ─────────────────────────────────────────

export interface ScreenerShareholding {
  promoter: number;
  fii: number;
  dii: number;
  public: number;
  quarter: string;
}

export async function fetchScreenerShareholding(
  symbol: string,
): Promise<ScreenerShareholding[] | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  return cacheWrap(
    `scr:shr:${clean}`,
    async () => {
      await delay(REQUEST_DELAY_MS);
      try {
        const html = await ky
          .get(`${BASE_URL}/company/${clean}/consolidated/`, {
            timeout: API_TIMEOUT_MS,
            headers: {
              "User-Agent":
                "Mozilla/5.0 (compatible; UseMoney/1.0; financial-research)",
              Accept: "text/html",
            },
          })
          .text();
        if (!html || html.length < 1000) return null;
        return parseShareholding(html);
      } catch {
        return null;
      }
    },
    86400,
  );
}

function parseShareholding(html: string): ScreenerShareholding[] | null {
  try {
    const $ = cheerio.load(html);
    const results: ScreenerShareholding[] = [];

    const section = $("section#shareholding");
    if (!section.length) return null;

    const table = section.find("table").first();
    if (!table.length) return null;

    const headers: string[] = [];
    table.find("thead th").each((_, th) => {
      headers.push($(th).text().trim());
    });

    const rowMap: Record<string, number[]> = {};
    table.find("tbody tr").each((_, tr) => {
      const cells = $(tr).find("td");
      const label = cells.first().text().trim().toLowerCase();
      const values: number[] = [];
      cells.each((i, td) => {
        if (i === 0) return;
        const val = $(td).text().trim().replace(/%/g, "").replace(/,/g, "");
        values.push(val ? parseFloat(val) : 0);
      });
      rowMap[label] = values;
    });

    for (let i = 0; i < headers.length - 1; i++) {
      results.push({
        quarter: headers[i + 1] || `Q${i + 1}`,
        promoter: rowMap["promoters"]?.[i] ?? 0,
        fii: rowMap["fiis"]?.[i] ?? rowMap["fii"]?.[i] ?? 0,
        dii: rowMap["diis"]?.[i] ?? rowMap["dii"]?.[i] ?? 0,
        public: rowMap["public"]?.[i] ?? rowMap["govt"]?.[i] ?? 0,
      });
    }

    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

// ── Peer Comparison ──────────────────────────────────────────────

export interface ScreenerPeer {
  name: string;
  symbol: string;
  marketCap?: number;
  price?: number;
  pe?: number;
  roe?: number;
  roce?: number;
}

export async function fetchScreenerPeers(
  symbol: string,
): Promise<ScreenerPeer[] | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  return cacheWrap(
    `scr:peers:${clean}`,
    async () => {
      await delay(REQUEST_DELAY_MS);
      try {
        const html = await ky
          .get(`${BASE_URL}/company/${clean}/consolidated/`, {
            timeout: API_TIMEOUT_MS,
            headers: {
              "User-Agent":
                "Mozilla/5.0 (compatible; UseMoney/1.0; financial-research)",
              Accept: "text/html",
            },
          })
          .text();
        if (!html || html.length < 1000) return null;
        return parsePeers(html);
      } catch {
        return null;
      }
    },
    86400,
  );
}

function parsePeers(html: string): ScreenerPeer[] | null {
  try {
    const $ = cheerio.load(html);
    const peers: ScreenerPeer[] = [];

    const section = $("section#peers");
    if (!section.length) return null;

    const table = section.find("table").first();
    if (!table.length) return null;

    table.find("tbody tr").each((_, tr) => {
      const cells = $(tr).find("td");
      const nameLink = cells.first().find("a");
      const name = nameLink.text().trim();
      const href = nameLink.attr("href") || "";
      // Extract symbol from href like "/company/RELIANCE/consolidated/"
      const symMatch = href.match(/\/company\/([^/]+)/);
      const sym = symMatch ? symMatch[1]! : name;

      const values: string[] = [];
      cells.each((i, td) => {
        if (i === 0) return;
        values.push($(td).text().trim().replace(/,/g, ""));
      });

      if (name) {
        peers.push({
          name,
          symbol: sym.toUpperCase(),
          price: values[0] ? parseFloat(values[0]) : undefined,
          marketCap: values[1] ? parseFloat(values[1]) : undefined,
          pe: values[3] ? parseFloat(values[3]) : undefined,
          roe: values[6] ? parseFloat(values[6]) : undefined,
          roce: values[7] ? parseFloat(values[7]) : undefined,
        });
      }
    });

    return peers.length > 0 ? peers : null;
  } catch {
    return null;
  }
}

// ── Documents Section (Annual Reports, Concall Transcripts, Announcements) ──

export interface ScreenerDocument {
  type:
    | "annual_report"
    | "concall_transcript"
    | "concall_ppt"
    | "concall_rec"
    | "announcement"
    | "credit_rating"
    | "ai_summary";
  title: string;
  url: string | null;
  period: string; // "FY2025", "May 2025", etc.
  source?: string; // "bse", "care", "icra", etc.
}

/**
 * Fetch documents section from Screener.in company page.
 * Returns annual reports, concall transcripts, announcements, credit ratings.
 */
export async function fetchScreenerDocuments(
  symbol: string,
): Promise<ScreenerDocument[] | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();

  try {
    await delay(REQUEST_DELAY_MS);

    // Fetch HTML directly (don't use cacheWrap - Redis may not be available in seed scripts)
    let html: string | null = null;
    try {
      const resp = await ky.get(
        `${BASE_URL}/company/${encodeURIComponent(clean)}/consolidated/`,
        { timeout: API_TIMEOUT_MS, throwHttpErrors: false },
      );
      if (resp.ok) {
        html = await resp.text();
      } else {
        logger.warn(`Screener returned ${resp.status} for ${clean}`);
        return null;
      }
    } catch (fetchErr) {
      logger.warn(
        `Screener fetch failed for ${clean}:`,
        fetchErr instanceof Error ? fetchErr.message : fetchErr,
      );
      return null;
    }

    if (!html) return null;

    const $ = cheerio.load(html);
    const docs: ScreenerDocument[] = [];

    // Annual Reports section
    $(
      "section#documents .documents-section, section.documents .sub-section, .documents .annual-reports a, .company-links a",
    ).each((_, el) => {
      // Fallback: look for links containing "annual" or "report"
    });

    // More targeted: parse the documents section structure
    // Screener uses a div-based layout with sections

    // Annual Reports
    $("a[href*='annual-reports'], a[href*='annualreport']").each((_, el) => {
      const $a = $(el);
      const href = $a.attr("href") || null;
      const text = $a.text().trim();
      if (text && href) {
        const fyMatch = text.match(/(\d{4})/);
        docs.push({
          type: "annual_report",
          title: text,
          url: href.startsWith("http") ? href : `${BASE_URL}${href}`,
          period: fyMatch ? `FY${fyMatch[1]}` : text,
          source: "bse",
        });
      }
    });

    // Concall transcripts and documents
    // Screener embeds concall links in a section with class or id containing "concall"
    $(
      "a[href*='concall'], a[href*='transcript'], a[href*='investor-call']",
    ).each((_, el) => {
      const $a = $(el);
      const href = $a.attr("href") || null;
      const text = $a.text().trim().toLowerCase();
      if (!href) return;

      const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      const periodMatch = text.match(
        /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*(\d{4})/i,
      );
      const period = periodMatch
        ? `${periodMatch[1]}-${periodMatch[2]}`
        : "unknown";

      if (text.includes("transcript")) {
        docs.push({
          type: "concall_transcript",
          title: `${clean} Concall Transcript ${period}`,
          url: fullUrl,
          period,
        });
      } else if (text.includes("ppt") || text.includes("presentation")) {
        docs.push({
          type: "concall_ppt",
          title: `${clean} Concall PPT ${period}`,
          url: fullUrl,
          period,
        });
      } else if (text.includes("summary") || text.includes("ai")) {
        docs.push({
          type: "ai_summary",
          title: `${clean} AI Summary ${period}`,
          url: fullUrl,
          period,
        });
      }
    });

    // Announcements (links in the announcements section)
    $("a[href*='bseindia'], a[href*='nseindia.com/corporate']").each(
      (_, el) => {
        const $a = $(el);
        const href = $a.attr("href") || null;
        const text = $a.text().trim();
        if (text && href && text.length > 10) {
          docs.push({
            type: "announcement",
            title: text,
            url: href,
            period: new Date().getFullYear().toString(),
          });
        }
      },
    );

    return docs.length > 0 ? docs : null;
  } catch (err) {
    logger.warn(
      `Failed to fetch Screener documents for ${clean}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
