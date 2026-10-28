/**
 * NSE index-constituent list parsing (MONEY-1100 P4.3).
 *
 * Source files: the eight `ind_{slug}list.csv` lists the P2 registry archives
 * DAILY under `feeds/NSE/index-constituents/{slug}/{YYYY}/{MM}/` (see
 * `nseIndexList` in report-registry.ts — undated upstream, so the dated
 * archive copies ARE the membership history).
 *
 * Real shape (verified against archived bytes, 2026-08-10 fetch):
 *
 *   Company Name,Industry,Symbol,Series,ISIN Code
 *   Adani Enterprises Ltd.,Metals & Mining,ADANIENT,EQ,INE423A01024
 *
 * Plain `\n` endings, no quoted fields in any of the eight current files —
 * but Papa handles quoting anyway, because "no quotes today" is an
 * observation, not a contract (a company named "Foo, Bar Ltd." would quote).
 * Rows are alphabetical by company name: the file carries NO rank and NO
 * weight, which is why consumers get membership only (`rank` stays null —
 * writing file order into a field documented as free-float rank would lie).
 *
 * These parsers replace the mcap-rank GUESS in the index-constituent-sync
 * worker for every index the archive covers. The guess (and the static
 * emergency lists) remain as fallbacks — see the worker for the ladder.
 */

import Papa from "papaparse";

// ─── Slug ↔ indexId mapping ──────────────────────────────────────────

/**
 * Archived registry slug → `IndexConstituent.indexId`.
 *
 * The DB ids predate the P2 registry and diverge once: the Bank Nifty rows
 * live under `banknifty` while NSE's file (and the registry slug) says
 * `niftybank`. Keep the mapping explicit rather than "obvious" so the next
 * divergence is a one-line edit, not a silent miss.
 */
export const CONSTITUENT_SLUG_TO_INDEX_ID: Readonly<Record<string, string>> = {
  nifty50: "nifty50",
  niftynext50: "niftynext50",
  nifty100: "nifty100",
  nifty500: "nifty500",
  niftybank: "banknifty",
  niftyit: "niftyit",
  niftymidcap100: "niftymidcap100",
  niftysmallcap100: "niftysmallcap100",
};

/** Inverse of {@link CONSTITUENT_SLUG_TO_INDEX_ID}. */
export const INDEX_ID_TO_CONSTITUENT_SLUG: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(CONSTITUENT_SLUG_TO_INDEX_ID).map(([slug, id]) => [
      id,
      slug,
    ]),
  );

// ─── Parsing ─────────────────────────────────────────────────────────

export interface ConstituentListRow {
  /** NSE primary symbol — the join key everything downstream uses. */
  symbol: string;
  companyName: string | null;
  industry: string | null;
  series: string | null;
  isin: string | null;
}

export interface ParsedConstituentList {
  rows: ConstituentListRow[];
  /**
   * Falsification counters (same idea as the P4 flag/deal parsers): every
   * dropped or suspicious input increments a named reason so the first real
   * run tells us where the shape assumptions were wrong instead of silently
   * shrinking an index.
   */
  reasons: Record<string, number>;
}

/** CSV → trimmed cell grid. Same rationale as stock-flags.ts `toGrid`. */
function toGrid(csv: string): string[][] {
  const parsed = Papa.parse<string[]>(csv ?? "", { skipEmptyLines: "greedy" });
  const out: string[][] = [];
  for (const row of parsed.data) {
    if (!Array.isArray(row)) continue;
    const cells = row.map((c) => String(c ?? "").trim());
    if (cells.some((c) => c.length > 0)) out.push(cells);
  }
  return out;
}

function normalizeHeaderCell(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const HEADER_REQUIRED: readonly RegExp[] = [/^symbol$/, /isin/];

const COLUMN_PATTERNS = {
  symbol: [/^symbol$/],
  companyName: [/^company name$/, /^company$/],
  industry: [/^industry$/],
  series: [/^series$/],
  isin: [/^isin code$/, /^isin$/],
} as const;

function findColumn(
  header: readonly string[],
  patterns: readonly RegExp[],
): number {
  for (const re of patterns) {
    for (let i = 0; i < header.length; i++) {
      const cell = header[i];
      if (cell !== undefined && re.test(cell)) return i;
    }
  }
  return -1;
}

/**
 * Parse one `ind_{slug}list.csv`.
 *
 * Header-resolved, not position-indexed: NSE reorders/renames columns across
 * report families often enough that positional parsing is how the P1 findings
 * died. An HTML error page (NSE serves those with HTTP 200) has no
 * symbol+isin header row, so it yields `rows: []` + `reasons.noHeader` rather
 * than garbage rows.
 */
export function parseIndexConstituentList(csv: string): ParsedConstituentList {
  const reasons: Record<string, number> = {};
  const bump = (k: string): void => {
    reasons[k] = (reasons[k] ?? 0) + 1;
  };

  const grid = toGrid(csv);
  let headerIdx = -1;
  for (let i = 0; i < grid.length; i++) {
    const cells = (grid[i] ?? []).map(normalizeHeaderCell);
    if (HEADER_REQUIRED.every((re) => cells.some((c) => re.test(c)))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    bump("noHeader");
    return { rows: [], reasons };
  }

  const header = (grid[headerIdx] ?? []).map(normalizeHeaderCell);
  const col = {
    symbol: findColumn(header, COLUMN_PATTERNS.symbol),
    companyName: findColumn(header, COLUMN_PATTERNS.companyName),
    industry: findColumn(header, COLUMN_PATTERNS.industry),
    series: findColumn(header, COLUMN_PATTERNS.series),
    isin: findColumn(header, COLUMN_PATTERNS.isin),
  };

  const rows: ConstituentListRow[] = [];
  const seen = new Set<string>();
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const cells = grid[i] ?? [];
    const symbol = (cells[col.symbol] ?? "").toUpperCase();
    if (!symbol) {
      bump("emptySymbol");
      continue;
    }
    // NSE symbols: alphanumerics plus `&` (M&M) and `-` (BAJAJ-AUTO). A cell
    // failing this is a shifted row or prose, not a listing.
    if (!/^[A-Z0-9&-]+$/.test(symbol)) {
      bump("malformedSymbol");
      continue;
    }
    if (seen.has(symbol)) {
      bump("duplicateSymbol");
      continue;
    }
    seen.add(symbol);
    const opt = (idx: number): string | null => {
      if (idx < 0) return null;
      const v = cells[idx] ?? "";
      return v.length > 0 ? v : null;
    };
    rows.push({
      symbol,
      companyName: opt(col.companyName),
      industry: opt(col.industry),
      series: opt(col.series),
      isin: opt(col.isin),
    });
  }
  return { rows, reasons };
}

// ─── Archive-key helpers ─────────────────────────────────────────────

/**
 * Latest archived copy for a slug. The archive layout
 * (`…/{YYYY}/{MM}/{YYYY-MM-DD}-ind_…`) makes lexicographic order
 * chronological, the same idiom the BSE scrip-master loader relies on.
 */
export function pickLatestConstituentKey(keys: string[]): string | null {
  const files = keys.filter((k) => !k.endsWith("/"));
  if (files.length === 0) return null;
  return files.sort().pop() ?? null;
}

/** ISO day (`YYYY-MM-DD`) from a dated archive key's basename, or null. */
export function constituentKeyDate(key: string): string | null {
  const base = key.split("/").pop() ?? "";
  const m = /^(\d{4}-\d{2}-\d{2})-/.exec(base);
  return m?.[1] ?? null;
}

// ─── Replace guard ───────────────────────────────────────────────────

/**
 * No real NSE index has fewer members than this; a "parse" below it is a
 * truncated or wrong file, never a rebalance.
 */
export const MIN_CONSTITUENTS = 5;

/**
 * Whether a parsed membership set may REPLACE the rows already in the table.
 *
 * The worker's write is delete-then-create, so a bad parse that slips through
 * doesn't shrink an index — it erases it. Rebalances move a handful of names;
 * they never halve an index. So: refuse below the absolute floor, refuse when
 * the new set is under half the existing one, allow everything else. Refusal
 * falls back to the previous strategy ladder — the table keeps its last good
 * state, which is the "never cache a fail-open default" rule applied to
 * membership.
 */
export function shouldReplaceMembership(
  parsedCount: number,
  existingCount: number,
): { replace: boolean; reason: string | null } {
  if (parsedCount < MIN_CONSTITUENTS) {
    return { replace: false, reason: "below-floor" };
  }
  if (existingCount > 0 && parsedCount < existingCount / 2) {
    return { replace: false, reason: "shrank-by-more-than-half" };
  }
  return { replace: true, reason: null };
}
