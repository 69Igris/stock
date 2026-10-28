/**
 * NSE instrument-master parsing (pure) — MONEY-1085.
 *
 * ## Why this exists
 *
 * The Zerodha Kite `/instruments` dump is our only instrument source, and it
 * omits NSE's SME (Emerge) and book-entry series, and carries no ISIN column at
 * all (`zerodha-instruments-logic.ts` hardcodes `isin: undefined` with a
 * "will be enriched separately" comment — there was no such enrichment).
 *
 * The consequence was measured in production: the daily bhavcopy ingest fetched
 * ~3,181 NSE rows and could only resolve ~2,415 of them, silently dropping ~766
 * closing prices EVERY trading day. Those 766 were exactly the series Kite
 * doesn't list — SM 324, BE 278, ST 125, BZ 39.
 *
 * NSE publishes the missing universe itself, in two public CSVs that also carry
 * the ISIN. This module parses them.
 *
 * ## The trap: the two files disagree on header style
 *
 * `EQUITY_L.csv` uses spaces AND pads with a leading space:
 *   `SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE`
 *
 * `SME_EQUITY_L.csv` uses underscores and ends with a trailing comma (so every
 * row has an empty 8th column):
 *   `SYMBOL,NAME_OF_COMPANY,SERIES,DATE_OF_LISTING,PAID_UP_VALUE,ISIN_NUMBER,FACE_VALUE,`
 *
 * Note `MARKET LOT` exists only in the main-board file. `normalizeMasterHeader`
 * collapses both conventions to one key so a single row mapper handles both;
 * writing two parsers would guarantee they drift.
 */

// MONEY-1205 — this splitter used to live HERE, module-private, which is
// exactly why `mwpl-logic.ts` grew a hand-copy and `zerodha-instruments-logic.ts`
// used a bare `split(",")` instead. It now has one home.
import { splitCsvLine } from "../csv-line";

/** A row from an NSE instrument-master CSV, already validated. */
export interface NseMasterRow {
  /** NSE trading symbol, upper-cased (e.g. RELIANCE). */
  symbol: string;
  /** Company name as published. */
  name: string;
  /** Settlement series: EQ / BE / BZ / SM / ST. */
  series: string;
  /** ISIN, or null when the cell is blank or malformed. */
  isin: string | null;
  /** Market lot (main board only; SME file has no such column). */
  marketLot: number | null;
}

/**
 * Series we take from the master files.
 *
 * Kept deliberately identical to `keepSeries`'s NSE allowlist in
 * `packages/core/src/market-data/bhavcopy.ts`. If the price feed keeps a series
 * the universe doesn't, that series silently drops again — which is the exact
 * bug this module fixes. `no-universe-series-drift.test.ts` pins the two lists
 * together so a future edit to one fails until the other matches.
 */
export const NSE_MASTER_SERIES = new Set(["EQ", "BE", "BZ", "SM", "ST"]);

/**
 * Collapse a header cell to a comparison key: upper-case, and strip every
 * space and underscore. `" ISIN NUMBER"` and `"ISIN_NUMBER"` both become
 * `"ISINNUMBER"`, which is what lets one mapper read both files.
 */
export function normalizeMasterHeader(header: string): string {
  return header.replace(/[\s_]+/g, "").toUpperCase();
}

/**
 * Trim an ISIN cell to a clean value or null.
 *
 * Mirrors `normalizeIsin` in `bhavcopy.ts` on purpose: the bhavcopy row's ISIN
 * and the master row's ISIN have to normalise identically or the join we are
 * building here won't match. ISINs are 12 chars (2-letter country + 9 alnum +
 * check digit); be lenient on length but reject blanks and `-` placeholders.
 */
export function normalizeMasterIsin(value: string | undefined): string | null {
  const s = String(value ?? "")
    .trim()
    .toUpperCase();
  return s.length >= 12 ? s : null;
}

/** Parse an integer cell, or null when absent/non-numeric. */
function parseIntOrNull(value: string | undefined): number | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse either NSE master CSV into validated rows.
 *
 * Rows are dropped when they have no symbol, or a series outside
 * {@link NSE_MASTER_SERIES} (the SME file carries a stray `SZ` row, and the
 * main board can carry suspended series we don't price). A row with a blank
 * ISIN is KEPT with `isin: null` — the symbol is still worth having in the
 * universe, and symbol@exchange is the primary join anyway.
 *
 * Tolerates CRLF, a trailing comma in the header, and blank trailing lines.
 * Returns `[]` for empty or header-only input rather than throwing.
 */
export function parseNseMasterCsv(csv: string): NseMasterRow[] {
  const lines = String(csv ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]!).map(normalizeMasterHeader);
  const col = (name: string) => headers.indexOf(name);

  const iSymbol = col("SYMBOL");
  const iName = col("NAMEOFCOMPANY");
  const iSeries = col("SERIES");
  const iIsin = col("ISINNUMBER");
  const iLot = col("MARKETLOT"); // main board only; -1 on the SME file

  // Without a symbol and a series column this isn't a master file at all.
  if (iSymbol === -1 || iSeries === -1) return [];

  const rows: NseMasterRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);

    const symbol = String(cells[iSymbol] ?? "")
      .trim()
      .toUpperCase();
    if (!symbol) continue;

    const series = String(cells[iSeries] ?? "")
      .trim()
      .toUpperCase();
    if (!NSE_MASTER_SERIES.has(series)) continue;

    rows.push({
      symbol,
      name: String(cells[iName] ?? "").trim() || symbol,
      series,
      isin: normalizeMasterIsin(iIsin === -1 ? undefined : cells[iIsin]),
      marketLot: iLot === -1 ? null : parseIntOrNull(cells[iLot]),
    });
  }

  return rows;
}

/**
 * Merge the main-board and SME row sets, first-wins on symbol.
 *
 * A symbol migrating from Emerge to the main board can appear in both files
 * during the transition; the main-board entry is the current truth, so pass it
 * first. Deduping here rather than relying on the upsert keeps the logged
 * counts honest.
 */
export function mergeNseMasterRows(...sets: NseMasterRow[][]): NseMasterRow[] {
  const bySymbol = new Map<string, NseMasterRow>();
  for (const set of sets) {
    for (const row of set) {
      if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, row);
    }
  }
  return [...bySymbol.values()];
}
