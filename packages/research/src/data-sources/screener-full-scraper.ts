/**
 * Screener.in Full Page Scraper
 *
 * Extracts ALL data from a single Screener company page:
 * - Financial tables (P&L, Balance Sheet, Cash Flow, Quarterly, Ratios) → text for RAG
 * - Shareholding pattern (promoter / FII / DII / public quarterly trend) — MONEY-853
 * - Peers / comparison table (PE / ROCE / market-cap per peer) — MONEY-853
 * - Document links (Annual Reports, Concall Transcripts/AI Summaries/PPTs,
 *   Credit-Ratings, Announcements) → download URLs — MONEY-853
 * - Compounded growth metrics (Sales / Profit / Stock-CAGR / ROE per 3/5/10yr) — MONEY-853
 * - Corporate actions (splits / bonuses / dividends) — MONEY-840/844
 *
 * Single HTTP request per stock — ALL sections above come back in that ONE
 * `/company/{SLUG}/consolidated/` fetch. Rate limited at 3s between requests.
 *
 * MONEY-1255 — the parenthetical here used to read "(robots.txt allows the
 * company page; we never hit the Disallowed `?q=` search)". The first half is
 * still true and the second half is no longer: `screener-resolve.ts` queries
 * `/api/company/search/?q=…` to reach the 2,389 companies listed only on BSE,
 * which screener's own `Disallow: /*?q=` covers. The rule is quoted verbatim in
 * that module's header along with the reasoning; it is corrected rather than
 * deleted here because a stale claim of compliance is the worst of the three
 * possible states.
 */

import ky from "ky";
import * as cheerio from "cheerio";
import { normalizeActionType, parseActionSubject } from "./nse-filings-logic";
import type { CorporateActionType } from "./nse-filings-types";

const logger = {
  warn: (...args: unknown[]) => console.warn("[screener-full]", ...args),
  info: (...args: unknown[]) => console.log("[screener-full]", ...args),
};

const BASE_URL = "https://www.screener.in";
const API_TIMEOUT_MS = 20_000;
const REQUEST_DELAY_MS = 3_000;
// Screener rate-limits per IP with HTTP 429. Retry with exponential backoff
// (honouring Retry-After) before giving up; on PERSISTENT 429 throw so the
// caller can circuit-break the run instead of hammering a tarpit — the
// whole-market weekly scrape was exhausting the quota → a 429 wall → ZERO
// screener data ever reaching GCS (only Tickertape financial_statement landed).
const SCREENER_MAX_RETRIES = 4;
const SCREENER_BACKOFF_BASE_MS = 5_000;

export class ScreenerRateLimitError extends Error {
  constructor(symbol: string) {
    super(`Screener rate-limited (429) for ${symbol} after retries`);
    this.name = "ScreenerRateLimitError";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Types ──────────────────────────────────────────────────────────

export interface ScreenerFinancialTable {
  title: string;
  headers: string[]; // Period headers: ["Mar 2015", "Mar 2016", ...]
  rows: Array<{
    label: string;
    values: string[]; // Values for each period
  }>;
}

export interface ScreenerDocLink {
  type:
    | "annual_report"
    | "concall_transcript"
    | "concall_ai_summary"
    | "concall_ppt"
    | "drhp"
    // MONEY-853 — Documents section also surfaces rating-agency PDFs and the
    // exchange announcements feed; we capture the links so the worker can archive
    // them just like the other docs.
    | "credit_rating"
    | "announcement";
  period: string;
  url: string;
  title: string;
  /** Optional source hint for credit ratings: "care" / "crisil" / "icra" / "bse". */
  source?: string;
}

/**
 * One quarter's shareholding split, in percent (MONEY-853). Values mirror the
 * `#shareholding` table rows Screener renders: Promoters / FIIs / DIIs /
 * Public (+ Government when present). `null` when a row is absent for a quarter.
 */
export interface ScreenerShareholdingRow {
  /** Period header as shown, e.g. "Mar 2024". */
  quarter: string;
  promoter: number | null;
  fii: number | null;
  dii: number | null;
  public: number | null;
  government: number | null;
}

/**
 * A single peer row from the `#peers` comparison table (MONEY-853). Numeric
 * columns are best-effort: Screener's peer table column order is stable
 * (Name, CMP, P/E, Mar Cap, Div Yld, NP Qtr, Qtr Profit Var, Sales Qtr,
 * Qtr Sales Var, ROCE) but we resolve columns by HEADER text rather than a
 * fixed index so a column re-order can't silently mis-map values.
 */
export interface ScreenerPeerRow {
  name: string;
  symbol: string;
  price: number | null;
  pe: number | null;
  marketCap: number | null;
  dividendYield: number | null;
  roce: number | null;
}

/**
 * Structured compounded-growth metrics (MONEY-853). Screener renders four small
 * "ranges" tables under the chart — Compounded Sales Growth, Compounded Profit
 * Growth, Stock Price CAGR, Return on Equity — each with 3yr / 5yr / 10yr (and
 * sometimes TTM / 1yr) columns. Each map is `{ "3 Years": 18, "5 Years": 22, … }`
 * in percent. The old `parseCompoundedGrowth` only produced a loose text blob;
 * this gives downstream consumers (RAG + risk) addressable numbers.
 */
export interface ScreenerCompoundedGrowth {
  salesGrowth: Record<string, number>;
  profitGrowth: Record<string, number>;
  stockPriceCagr: Record<string, number>;
  returnOnEquity: Record<string, number>;
}

/**
 * A corporate action (split / bonus / dividend …) scraped from a Screener.in
 * company page. Normalized so it merges cleanly with the NSE source before being
 * upserted into the `CorporateAction` table (MONEY-840/844). `ratio` is the
 * post:pre share multiplier for qty-changing actions (split 1:5 → 5, bonus
 * 1:1 → 2), `null` for dividends. `exDate` is `null` when Screener only shows a
 * year/period with no parseable date — the row is still useful for the type.
 */
export interface ScreenerCorpAction {
  symbol: string;
  type: CorporateActionType;
  exDate: Date | null;
  ratio: number | null;
  oldFaceValue: number | null;
  newFaceValue: number | null;
  dividendPerShare: number | null;
  /** The raw subject/label text as shown on Screener. */
  details: string;
}

export interface ScreenerFullData {
  symbol: string;

  // Financial tables as structured data
  profitAndLoss: ScreenerFinancialTable | null;
  quarterlyResults: ScreenerFinancialTable | null;
  balanceSheet: ScreenerFinancialTable | null;
  cashFlows: ScreenerFinancialTable | null;
  ratios: ScreenerFinancialTable | null;

  // Compounded growth summary (human-readable text, folded into fullText)
  compoundedGrowth: string;

  // Compounded growth as structured numbers (Sales/Profit/Stock-CAGR/ROE per
  // 3/5/10yr) — MONEY-853. Always present; empty maps when not on the page.
  compoundedGrowthData: ScreenerCompoundedGrowth;

  // Shareholding pattern (promoter / FII / DII / public quarterly trend) — MONEY-853
  shareholding: ScreenerShareholdingRow[];

  // Peers / comparison table — MONEY-853
  peers: ScreenerPeerRow[];

  // Document download links (annual reports, concalls, credit ratings, announcements)
  documents: ScreenerDocLink[];

  // Corporate actions (splits / bonuses / dividends) — MONEY-840/844
  corporateActions: ScreenerCorpAction[];

  // Full page text (for RAG - all tables formatted as readable text)
  fullText: string;
}

// ── Main Scraper ───────────────────────────────────────────────────

/**
 * Scrape the entire Screener.in company page and extract all data.
 * Single HTTP request, parsed with cheerio.
 */
export async function scrapeScreenerFullPage(
  symbol: string,
  options?: { slug?: string | null },
): Promise<ScreenerFullData | null> {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();

  // MONEY-1255 — the PATH and the LABEL are two different things.
  //
  // Screener keys its company page by a slug that is usually our ticker for an
  // NSE-listed company and usually the BSE SCRIP CODE (`/company/511122/`) for
  // the 2,389 companies listed only on BSE. Those companies cannot be reached
  // by symbol at all, which is why every NSE-keyed producer in this repo leaves
  // them with no annual report.
  //
  // Only the URL segment moves. `clean` still labels every document, every
  // fullText heading and the returned `symbol`, so the caller's writes stay
  // keyed on OUR ticker rather than on screener's id — and with no `slug`
  // passed the URL is byte-identical to what it was before, so nothing about
  // the NSE path changes. `resolveScreenerSlug` (screener-resolve.ts) is what
  // produces a slug, and it refuses to guess one.
  const slug = options?.slug?.trim();
  const pathSegment = slug && slug.length > 0 ? slug : clean;

  try {
    await delay(REQUEST_DELAY_MS);

    // 429-aware fetch: back off (honouring Retry-After) + retry before giving up.
    const url = `${BASE_URL}/company/${encodeURIComponent(pathSegment)}/consolidated/`;
    let resp = await ky.get(url, {
      timeout: API_TIMEOUT_MS,
      throwHttpErrors: false,
    });
    for (
      let attempt = 1;
      resp.status === 429 && attempt <= SCREENER_MAX_RETRIES;
      attempt++
    ) {
      const retryAfter = Number(resp.headers.get("retry-after"));
      const backoffMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : SCREENER_BACKOFF_BASE_MS * 2 ** (attempt - 1);
      logger.warn(
        `Screener 429 for ${clean} (retry ${attempt}/${SCREENER_MAX_RETRIES}, backoff ${backoffMs}ms)`,
      );
      await delay(backoffMs);
      resp = await ky.get(url, {
        timeout: API_TIMEOUT_MS,
        throwHttpErrors: false,
      });
    }

    // Persistent 429 after retries → signal the caller to circuit-break the run.
    if (resp.status === 429) {
      throw new ScreenerRateLimitError(clean);
    }

    if (!resp.ok) {
      if (resp.status !== 404) {
        // The SEGMENT is logged beside the symbol: when they differ, a 4xx is
        // about the slug we resolved, not about the ticker, and the two are
        // indistinguishable in a log line that only prints one of them.
        logger.warn(
          `Screener returned ${resp.status} for ${clean} (/company/${pathSegment}/)`,
        );
      }
      return null;
    }

    const html = await resp.text();
    if (!html || html.length < 1000) return null;

    const $ = cheerio.load(html);

    // Extract all financial tables
    const profitAndLoss = parseFinancialTable(
      $,
      "#profit-loss",
      "Profit & Loss",
    );
    const quarterlyResults = parseFinancialTable(
      $,
      "#quarters",
      "Quarterly Results",
    );
    const balanceSheet = parseFinancialTable(
      $,
      "#balance-sheet",
      "Balance Sheet",
    );
    const cashFlows = parseFinancialTable($, "#cash-flow", "Cash Flows");
    const ratios = parseFinancialTable($, "#ratios", "Ratios");

    // Extract compounded growth — both structured numbers and a text summary.
    const compoundedGrowthData = parseCompoundedGrowth($);
    const compoundedGrowth = formatCompoundedGrowthAsText(compoundedGrowthData);

    // Extract shareholding pattern + peers (MONEY-853)
    const shareholding = parseShareholding($);
    const peers = parsePeers($);

    // Extract document links (incl. credit ratings + announcements)
    const documents = parseDocumentLinks($, clean);

    // Extract corporate actions (splits / bonuses / dividends)
    const corporateActions = parseCorporateActions($, clean);

    // Build full text for RAG
    const textParts: string[] = [
      `${clean} - Financial Data from Screener.in\n`,
    ];

    if (profitAndLoss) textParts.push(formatTableAsText(profitAndLoss));
    if (quarterlyResults) textParts.push(formatTableAsText(quarterlyResults));
    if (balanceSheet) textParts.push(formatTableAsText(balanceSheet));
    if (cashFlows) textParts.push(formatTableAsText(cashFlows));
    if (ratios) textParts.push(formatTableAsText(ratios));
    if (compoundedGrowth) textParts.push(compoundedGrowth);
    const shareholdingText = formatShareholdingAsText(shareholding);
    if (shareholdingText) textParts.push(shareholdingText);
    const peersText = formatPeersAsText(peers);
    if (peersText) textParts.push(peersText);

    const fullText = textParts.join("\n");

    return {
      symbol: clean,
      profitAndLoss,
      quarterlyResults,
      balanceSheet,
      cashFlows,
      ratios,
      compoundedGrowth,
      compoundedGrowthData,
      shareholding,
      peers,
      documents,
      corporateActions,
      fullText,
    };
  } catch (err) {
    logger.warn(
      `Failed to scrape ${clean}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ── Table Parser ───────────────────────────────────────────────────

/**
 * Parse a financial table from a Screener section.
 * Screener tables have a consistent structure:
 *   <section id="profit-loss">
 *     <table> ... </table>
 *   </section>
 */
function parseFinancialTable(
  $: cheerio.CheerioAPI,
  sectionSelector: string,
  title: string,
): ScreenerFinancialTable | null {
  const section = $(sectionSelector);
  if (section.length === 0) return null;

  const table = section.find("table").first();
  if (table.length === 0) return null;

  // Extract headers (period names)
  const headers: string[] = [];
  table.find("thead tr th, thead tr td").each((i, el) => {
    if (i === 0) return; // Skip first header (row label column)
    const text = $(el).text().trim();
    if (text) headers.push(text);
  });

  if (headers.length === 0) return null;

  // Extract data rows
  const rows: ScreenerFinancialTable["rows"] = [];
  table.find("tbody tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length === 0) return;

    const label = $(cells[0])
      .text()
      .trim()
      .replace(/\s*\+\s*$/, ""); // Remove trailing "+"
    if (!label) return;

    const values: string[] = [];
    cells.each((i, td) => {
      if (i === 0) return; // Skip label column
      values.push($(td).text().trim());
    });

    if (values.some((v) => v && v !== "")) {
      rows.push({ label, values });
    }
  });

  if (rows.length === 0) return null;

  return { title, headers, rows };
}

// ── Compounded Growth Parser ───────────────────────────────────────

/** Map a `.ranges-table` heading to the bucket it feeds in the result. */
function classifyGrowthTable(
  heading: string,
): keyof ScreenerCompoundedGrowth | null {
  const h = heading.toLowerCase();
  // Order matters: "compounded profit growth" must beat the bare "growth".
  if (/profit\s+growth/.test(h)) return "profitGrowth";
  if (/sales\s+growth/.test(h)) return "salesGrowth";
  if (/(stock\s+price|price\s+cagr|\bcagr\b)/.test(h)) return "stockPriceCagr";
  if (/return\s+on\s+equity|\broe\b/.test(h)) return "returnOnEquity";
  return null;
}

/**
 * Normalize a period label cell ("10 Years:", "5 Years", "TTM", "1 Year:") to a
 * stable key. Keeps the human label but strips the trailing colon/whitespace.
 */
function normalizeGrowthPeriod(label: string): string {
  return label.replace(/[:\s]+$/g, "").trim();
}

/** Parse a "18%" / "-4.2 %" / "12,3" cell into a finite number, else null. */
function parsePercentCell(raw: string): number | null {
  const cleaned = (raw || "")
    .replace(/%/g, "")
    .replace(/,/g, "")
    .replace(/[–—]/g, "-") // en/em dash → minus
    .trim();
  if (!cleaned || cleaned === "-") return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the four compounded-growth "ranges" tables Screener renders under the
 * P&L chart into structured numbers. Screener's markup is:
 *
 *   <table class="ranges-table">
 *     <tr><th>Compounded Sales Growth</th></tr>
 *     <tr><td>10 Years:</td><td>18%</td></tr>
 *     <tr><td>5 Years:</td><td>22%</td></tr>
 *     ...
 *   </table>
 *
 * We classify each table by its heading and read every `label → percent` row,
 * resolving by the heading + the row label (NOT a fixed index), so a missing or
 * re-ordered period can't mis-map. Always returns the four buckets (empty maps
 * when the page lacks the section), so callers never have to null-check.
 */
export function parseCompoundedGrowth(
  $: cheerio.CheerioAPI,
): ScreenerCompoundedGrowth {
  const result: ScreenerCompoundedGrowth = {
    salesGrowth: {},
    profitGrowth: {},
    stockPriceCagr: {},
    returnOnEquity: {},
  };

  $("table.ranges-table").each((_, table) => {
    const $table = $(table);
    // Heading: an explicit <th>, else the first row's text.
    const heading =
      $table.find("th").first().text().trim() ||
      $table.find("tr").first().text().trim();
    const bucket = classifyGrowthTable(heading);
    if (!bucket) return;

    $table.find("tr").each((_, tr) => {
      const cells = $(tr).find("td");
      if (cells.length < 2) return; // heading row / malformed
      const period = normalizeGrowthPeriod($(cells[0]).text());
      const value = parsePercentCell($(cells[1]!).text());
      if (period && value !== null) {
        result[bucket][period] = value;
      }
    });
  });

  return result;
}

/** Render parsed compounded-growth numbers back to the RAG text blob. */
function formatCompoundedGrowthAsText(g: ScreenerCompoundedGrowth): string {
  const sections: Array<[string, Record<string, number>]> = [
    ["Compounded Sales Growth", g.salesGrowth],
    ["Compounded Profit Growth", g.profitGrowth],
    ["Stock Price CAGR", g.stockPriceCagr],
    ["Return on Equity", g.returnOnEquity],
  ];
  const lines: string[] = [];
  for (const [title, map] of sections) {
    const entries = Object.entries(map);
    if (entries.length === 0) continue;
    lines.push(`${title}: ${entries.map(([k, v]) => `${k} ${v}%`).join(", ")}`);
  }
  if (lines.length === 0) return "";
  return "Compounded Growth:\n" + lines.join("\n");
}

// ── Shareholding Pattern Parser ────────────────────────────────────

/**
 * Parse the `#shareholding` quarterly table (promoter / FII / DII / public /
 * government) into a per-quarter trend (MONEY-853). Screener renders:
 *
 *   <section id="shareholding">
 *     <table>
 *       <thead><tr><th></th><th>Mar 2023</th><th>Mar 2024</th>…</tr></thead>
 *       <tbody>
 *         <tr><td>Promoters +</td><td>50.1%</td>…</tr>
 *         <tr><td>FIIs +</td><td>20.3%</td>…</tr>
 *         …
 *       </tbody>
 *     </table>
 *   </section>
 *
 * Rows are matched by label keyword (case-insensitive) so the order/casing of
 * Screener's rows doesn't matter; columns are aligned to the period headers.
 */
export function parseShareholding(
  $: cheerio.CheerioAPI,
): ScreenerShareholdingRow[] {
  const section = $("#shareholding");
  if (section.length === 0) return [];

  const table = section.find("table").first();
  if (table.length === 0) return [];

  // Period headers (skip the first, blank, label column).
  const headers: string[] = [];
  table.find("thead tr th, thead tr td").each((i, el) => {
    if (i === 0) return;
    const text = $(el).text().trim();
    if (text) headers.push(text);
  });
  if (headers.length === 0) return [];

  // label keyword → per-period values
  const rowMap: Record<string, Array<number | null>> = {};
  table.find("tbody tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length < 2) return;
    const label = $(cells[0])
      .text()
      .trim()
      .toLowerCase()
      .replace(/\s*\+\s*$/, ""); // strip the expand "+"
    if (!label) return;
    const values: Array<number | null> = [];
    cells.each((i, td) => {
      if (i === 0) return;
      values.push(parsePercentCell($(td).text()));
    });
    rowMap[label] = values;
  });

  const pick = (keys: string[], i: number): number | null => {
    for (const k of keys) {
      const row = rowMap[k];
      if (row && row[i] !== undefined) return row[i] ?? null;
    }
    return null;
  };

  const rows: ScreenerShareholdingRow[] = [];
  for (let i = 0; i < headers.length; i++) {
    rows.push({
      quarter: headers[i]!,
      promoter: pick(["promoters", "promoter"], i),
      fii: pick(["fiis", "fii", "foreign institutions"], i),
      dii: pick(["diis", "dii", "domestic institutions"], i),
      public: pick(["public"], i),
      government: pick(["government", "govt"], i),
    });
  }

  // Drop fully-empty trailing columns (Screener sometimes renders a stray
  // header with no data).
  return rows.filter(
    (r) =>
      r.promoter !== null ||
      r.fii !== null ||
      r.dii !== null ||
      r.public !== null ||
      r.government !== null,
  );
}

/** Render the shareholding trend to readable RAG text. */
function formatShareholdingAsText(rows: ScreenerShareholdingRow[]): string {
  if (rows.length === 0) return "";
  const lines = ["Shareholding Pattern (%):"];
  for (const r of rows) {
    const parts: string[] = [];
    if (r.promoter !== null) parts.push(`Promoters ${r.promoter}`);
    if (r.fii !== null) parts.push(`FII ${r.fii}`);
    if (r.dii !== null) parts.push(`DII ${r.dii}`);
    if (r.public !== null) parts.push(`Public ${r.public}`);
    if (r.government !== null) parts.push(`Govt ${r.government}`);
    lines.push(`${r.quarter}: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

// ── Peers / Comparison Parser ──────────────────────────────────────

/**
 * Parse the `#peers` comparison table (MONEY-853). Screener renders a sortable
 * table whose columns are (in order) S.No., Name, CMP Rs., P/E, Mar Cap Rs.Cr.,
 * Div Yld %, NP Qtr Rs.Cr., Qtr Profit Var %, Sales Qtr Rs.Cr., Qtr Sales Var %,
 * ROCE %. The last `tr` is the "Median" footer.
 *
 * We resolve numeric columns by their HEADER text (CMP / P/E / Mar Cap / Div Yld
 * / ROCE) so a column re-order doesn't mis-map values; the company name + symbol
 * come from the first link cell.
 */
export function parsePeers($: cheerio.CheerioAPI): ScreenerPeerRow[] {
  const section = $("#peers");
  if (section.length === 0) return [];

  const table = section.find("table").first();
  if (table.length === 0) return [];

  // Build a header-text → column-index map (lower-cased).
  const headerIdx: Record<string, number> = {};
  table.find("thead tr th, thead tr td").each((i, el) => {
    const text = $(el).text().trim().toLowerCase();
    if (text) headerIdx[text] = i;
  });

  const findCol = (...needles: string[]): number => {
    for (const [head, idx] of Object.entries(headerIdx)) {
      if (needles.some((n) => head.includes(n))) return idx;
    }
    return -1;
  };

  const cmpCol = findCol("cmp", "price");
  const peCol = findCol("p/e", "pe");
  const capCol = findCol("mar cap", "market cap", "mcap");
  const divCol = findCol("div yld", "dividend");
  const roceCol = findCol("roce");

  const numAt = (cells: cheerio.Cheerio<never>, col: number): number | null => {
    if (col < 0 || col >= cells.length) return null;
    const raw = $(cells[col]).text().trim().replace(/,/g, "");
    if (!raw || raw === "-") return null;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  };

  const peers: ScreenerPeerRow[] = [];
  table.find("tbody tr").each((_, tr) => {
    const cells = $(tr).find("td") as unknown as cheerio.Cheerio<never>;
    if (cells.length < 2) return;

    // Name + symbol from the first link cell (skip the S.No. column if present).
    const link = $(tr).find("td a").first();
    const name = link.text().trim();
    if (!name) return; // "Median" footer / spacer rows have no link
    if (/^median/i.test(name)) return;
    const href = link.attr("href") || "";
    const symMatch = href.match(/\/company\/([^/]+)/);
    const symbol = (symMatch ? symMatch[1]! : name).toUpperCase();

    peers.push({
      name,
      symbol,
      price: numAt(cells, cmpCol),
      pe: numAt(cells, peCol),
      marketCap: numAt(cells, capCol),
      dividendYield: numAt(cells, divCol),
      roce: numAt(cells, roceCol),
    });
  });

  return peers;
}

/** Render the peer comparison to readable RAG text. */
function formatPeersAsText(peers: ScreenerPeerRow[]): string {
  if (peers.length === 0) return "";
  const lines = ["Peer Comparison:"];
  for (const p of peers) {
    const parts: string[] = [];
    if (p.price !== null) parts.push(`CMP ${p.price}`);
    if (p.pe !== null) parts.push(`P/E ${p.pe}`);
    if (p.marketCap !== null) parts.push(`MCap ${p.marketCap}`);
    if (p.dividendYield !== null) parts.push(`DivYld ${p.dividendYield}%`);
    if (p.roce !== null) parts.push(`ROCE ${p.roce}%`);
    lines.push(`${p.name} (${p.symbol}): ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

// ── Document Links Parser ──────────────────────────────────────────

export function parseDocumentLinks(
  $: cheerio.CheerioAPI,
  symbol: string,
): ScreenerDocLink[] {
  const docs: ScreenerDocLink[] = [];

  // === Annual Reports ===
  // Links in the annual reports section - usually BSE PDF links
  // Pattern: "Financial Year 2025" with href to bseindia.com PDF
  const annualSection = $(
    "#documents, .documents, section:contains('Annual reports')",
  );

  // Find all links that look like annual reports
  $("a").each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    const text = $a.text().trim();
    if (!href) return;

    // Annual Reports - links with "Financial Year" text or BSE annual report URLs
    if (
      (text.match(/Financial Year \d{4}/i) || href.includes("AnnualReport")) &&
      (href.includes("bseindia.com") || href.includes("screener.in"))
    ) {
      const fyMatch = text.match(/\d{4}/);
      docs.push({
        type: "annual_report",
        period: fyMatch ? `FY${fyMatch[0]}` : text,
        url: href.startsWith("http") ? href : `${BASE_URL}${href}`,
        title: `${symbol} Annual Report ${fyMatch?.[0] || ""}`.trim(),
      });
    }

    // Concall Transcripts
    if (
      href.includes("/transcript") ||
      (text.toLowerCase() === "transcript" && href.includes("concall"))
    ) {
      const period = extractConcallPeriod($a, $);
      docs.push({
        type: "concall_transcript",
        period,
        url: href.startsWith("http") ? href : `${BASE_URL}${href}`,
        title: `${symbol} Concall Transcript ${period}`,
      });
    }

    // Concall AI Summary
    if (href.includes("/summary") || text.toLowerCase() === "ai summary") {
      const period = extractConcallPeriod($a, $);
      docs.push({
        type: "concall_ai_summary",
        period,
        url: href.startsWith("http") ? href : `${BASE_URL}${href}`,
        title: `${symbol} AI Summary ${period}`,
      });
    }

    // Concall PPT
    if (href.includes("/ppt") || text.toLowerCase() === "ppt") {
      const period = extractConcallPeriod($a, $);
      docs.push({
        type: "concall_ppt",
        period,
        url: href.startsWith("http") ? href : `${BASE_URL}${href}`,
        title: `${symbol} Concall PPT ${period}`,
      });
    }

    // DRHP
    if (text.toLowerCase().includes("drhp")) {
      docs.push({
        type: "drhp",
        period: "IPO",
        url: href.startsWith("http") ? href : `${BASE_URL}${href}`,
        title: `${symbol} DRHP`,
      });
    }

    // === Credit Ratings (MONEY-853) ===
    // Screener's Documents section has a "Credit ratings" subsection linking out
    // to the rating agency's PDF. Match by the screener path or the agency host.
    const agency = detectRatingAgency(href, text);
    if (agency) {
      const period = extractDocYearPeriod(text, href);
      docs.push({
        type: "credit_rating",
        period,
        url: href.startsWith("http") ? href : `${BASE_URL}${href}`,
        title:
          `${symbol} Credit Rating ${agency.toUpperCase()} ${period}`.trim(),
        source: agency,
      });
    }
  });

  // === Announcements (MONEY-853) ===
  // Scope tightly to the announcements section so we don't re-grab the
  // annual-report / concall links above. Each row links to a BSE/NSE corporate
  // filing PDF with a descriptive title.
  $(
    "#announcements a, .announcements a, section:contains('Announcements') a",
  ).each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    const text = $a.text().replace(/\s+/g, " ").trim();
    if (!href || text.length < 8) return;
    // Only outbound exchange/filing PDFs; skip in-page nav + already-typed docs.
    const isFiling =
      /bseindia\.com|nseindia\.com\/corporate|nsearchives|\.pdf(\?|$)/i.test(
        href,
      );
    if (!isFiling) return;
    if (detectRatingAgency(href, text)) return; // belongs to credit_rating
    if (/transcript|\/ppt|\/summary|annual\s*report/i.test(text)) return;
    const period = extractDocYearPeriod(text, href);
    docs.push({
      type: "announcement",
      period,
      url: href.startsWith("http") ? href : `${BASE_URL}${href}`,
      title: text.slice(0, 200),
    });
  });

  // De-dupe by (type + url): the same PDF can be reachable from two selectors.
  const seen = new Set<string>();
  return docs.filter((d) => {
    const key = `${d.type}|${d.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Known credit-rating agencies → canonical source tag, matched on href/text. */
function detectRatingAgency(href: string, text: string): string | null {
  const hay = `${href} ${text}`.toLowerCase();
  if (
    !/credit\s*-?\s*rating|\brating\b|careratings|crisil|icra|ind-ra|india ratings|indiaratings|brickwork|acuite/.test(
      hay,
    )
  ) {
    return null;
  }
  if (/careratings|\bcare\b/.test(hay)) return "care";
  if (/crisil/.test(hay)) return "crisil";
  if (/icra/.test(hay)) return "icra";
  if (/ind-ra|india\s*ratings|indiaratings/.test(hay)) return "india-ratings";
  if (/brickwork/.test(hay)) return "brickwork";
  if (/acuite/.test(hay)) return "acuite";
  // It said "credit rating" / "rating" but no recognizable agency.
  return /credit\s*-?\s*rating/.test(hay) ? "unknown" : null;
}

/**
 * Best-effort period for a document link: prefer a "Mon YYYY" / "YYYY" in the
 * link text, else in the href, else the current year. Used for credit-ratings
 * and announcements where there's no dedicated period column.
 */
function extractDocYearPeriod(text: string, href: string): string {
  const monthYear =
    text.match(
      /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{4})/i,
    ) ||
    href.match(
      /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*[-_\s](\d{4})/i,
    );
  if (monthYear) return `${monthYear[1]} ${monthYear[2]}`;
  const year = text.match(/\b(20\d{2})\b/) || href.match(/\b(20\d{2})\b/);
  if (year) return year[1]!;
  return String(new Date().getFullYear());
}

// ── Corporate Actions Parser ───────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Parse a date out of a free-text corp-action label. Screener writes ex-dates a
 * few ways: "15 Mar 2024", "Mar 2024", "2024-03-15", "15-03-2024". Returns a
 * VALID Date or `null` (never an Invalid Date — same contract as
 * `safeOptionalDate`).
 */
export function parseScreenerActionDate(text: string): Date | null {
  const t = (text || "").trim();
  if (!t) return null;

  // "15 Mar 2024" / "15 March 2024" / "Mar 2024"
  const dmy = t.match(
    /(?:(\d{1,2})\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})/i,
  );
  if (dmy) {
    const day = dmy[1] ? Number(dmy[1]) : 1;
    const month = MONTHS[dmy[2]!.toLowerCase()];
    const year = Number(dmy[3]);
    if (month !== undefined) {
      const d = new Date(Date.UTC(year, month, day));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  // ISO "2024-03-15"
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }

  // "15-03-2024" / "15/03/2024" (DD-MM-YYYY)
  const dash = t.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dash) {
    const d = new Date(
      Date.UTC(Number(dash[3]), Number(dash[2]) - 1, Number(dash[1])),
    );
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
}

/**
 * Extract corporate actions (splits / bonuses / dividends) from a Screener page.
 *
 * Screener surfaces these in two reliable spots:
 *   1. The announcements / documents list (`#documents`, `.announcements`),
 *      where rows read e.g. "Stock Split 15 Mar 2024" or "Dividend - Rs 5".
 *   2. The "Corporate actions" / "Latest announcements" feed.
 *
 * We scan candidate rows, keep those whose text normalizes to a known action
 * type, and parse each into the same structured shape as the NSE source (via the
 * shared `parseActionSubject`), de-duping on type+date+detail so the same action
 * listed in two sections isn't emitted twice.
 */
export function parseCorporateActions(
  $: cheerio.CheerioAPI,
  symbol: string,
): ScreenerCorpAction[] {
  const actions: ScreenerCorpAction[] = [];
  const seen = new Set<string>();

  // Candidate containers: announcements/documents feed + any list item or table
  // row that mentions a corp-action keyword. We deliberately cast a wide net and
  // filter by `normalizeActionType` rather than relying on a brittle selector,
  // because Screener's markup for this section changes often.
  const KEYWORD =
    /\b(split|sub-?division|bonus|dividend|buy\s*-?\s*back|buyback|demerge|de-merge|amalgamat|rights?\s+issue)\b/i;

  const candidates = $(
    "#documents li, #documents tr, .announcements li, .announcements tr, " +
      "section:contains('Corporate actions') li, " +
      "section:contains('Announcements') li, " +
      "ul.list-links li, table.data-table tr",
  );

  candidates.each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text || text.length > 240) return; // skip headers / giant blobs
    if (!KEYWORD.test(text)) return;

    const type = normalizeActionType(text);
    if (type === "OTHER") return; // keyword matched but not a real action class

    const parsed = parseActionSubject(text);
    const exDate = parseScreenerActionDate(text);

    // Dedupe key: type + ISO date (or "?") + a trimmed snippet of the label.
    const key = `${type}|${exDate ? exDate.toISOString().slice(0, 10) : "?"}|${text
      .slice(0, 60)
      .toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);

    actions.push({
      symbol,
      type,
      exDate,
      ratio: parsed.ratio,
      oldFaceValue: parsed.oldFaceValue,
      newFaceValue: parsed.newFaceValue,
      dividendPerShare: parsed.dividendPerShare,
      details: text,
    });
  });

  return actions;
}

/**
 * Extract the period (e.g., "May 2025") from a concall link's parent context.
 * Concall links are in rows like: "May 2025  [Transcript] [AI Summary] [PPT]"
 */
function extractConcallPeriod(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $a: any,
  $: cheerio.CheerioAPI,
): string {
  // Check parent/sibling text for month + year pattern
  const parent = $a.parent();
  const parentText = parent.text();
  const grandparent = parent.parent();
  const grandparentText = grandparent.text();

  const monthYear =
    parentText.match(
      /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}/i,
    ) ||
    grandparentText.match(
      /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}/i,
    );

  if (monthYear) return monthYear[0];

  // Try to extract from the href itself
  const href = $a.attr("href") || "";
  const hrefMatch = href.match(
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*[-_](\d{4})/i,
  );
  if (hrefMatch) return `${hrefMatch[1]} ${hrefMatch[2]}`;

  return "unknown";
}

// ── Table → Text Formatter ─────────────────────────────────────────

/**
 * Format a financial table as human-readable text for RAG embedding.
 */
function formatTableAsText(table: ScreenerFinancialTable): string {
  const lines: string[] = [];
  lines.push(`${table.title}:`);

  // Header row
  const maxLabelLen = Math.max(...table.rows.map((r) => r.label.length), 25);
  const headerLine =
    "".padEnd(maxLabelLen) +
    "  " +
    table.headers.map((h) => h.padStart(12)).join("");
  lines.push(headerLine);

  // Data rows
  for (const row of table.rows) {
    const valueLine =
      row.label.padEnd(maxLabelLen) +
      "  " +
      row.values.map((v) => (v || "-").padStart(12)).join("");
    lines.push(valueLine);
  }

  lines.push("");
  return lines.join("\n");
}
