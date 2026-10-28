/**
 * Per-stock flag parsers — MONEY-1100 (Data Engine P4.5).
 *
 * NSE publishes one small file per "flag": which price band a stock trades in,
 * whether that band just moved, whether it is under ASM/GSM surveillance,
 * whether F&O trading in it is banned today, its 52-week extremes, a series
 * migration (EQ↔BE), a day's short-selling disclosures.
 *
 *   52wk       `CM_52_wk_High_low_{DDMMYYYY}.csv`   -> WK52_HIGH_LOW
 *   band moves `eq_band_changes_{DDMMYYYY}.csv`     -> BAND_CHANGE
 *   band list  `sec_list_{DDMMYYYY}.csv`            -> PRICE_BAND (+ SURVEILLANCE, see below)
 *   surveill.  `REG_IND{DDMMYY}.csv` / `REG1_IND…`  -> SURVEILLANCE
 *   F&O ban    `fo_secban_{DDMMYYYY}.csv`           -> FO_BAN
 *   series     `series_change.csv` (rolling)        -> SERIES_CHANGE
 *   short sell `shortselling_{DDMMYYYY}.csv`        -> SHORT_SELLING
 *
 * ## Why every parser emits rows, never a state
 *
 * Each file is a SNAPSHOT of one day. The signal is the HISTORY: "XYZ entered
 * GSM Stage I on 4-Aug and left it on 21-Aug" is the differentiating retail
 * warning; a current-state table can only ever answer "not flagged today", and
 * it silently loses the entry date the moment the flag clears. So these are
 * APPEND-ONLY row emitters — nothing here upserts, dedupes, merges or diffs
 * against yesterday. A stock carrying the same code on 40 consecutive days is
 * 40 rows on purpose: that run length IS the datum. (Which is also why the
 * StockFlag model must NOT carry a unique on (symbol,date,kind) — a unique
 * would quietly turn a 40-day ban into one row.)
 *
 * ## `value` encoding, per kind (fixed — downstream parses by `kind`)
 *
 *   WK52_HIGH_LOW  JSON `{"high":246.61,"highDate":"2025-08-19",
 *                          "low":129.61,"lowDate":"2026-03-30"}`
 *                  Prices are NSE's ADJUSTED figures (bonus/split/rights) as
 *                  published — the file's own disclaimer says so; unadjusted
 *                  extremes come from bhavcopy. Dates are ISO day strings so
 *                  the JSON stays sortable and timezone-free. Either side may
 *                  be null when NSE prints `-`.
 *   BAND_CHANGE    JSON `{"from":"10","to":"20"}` — percent band before/after.
 *                  Kept as PUBLISHED STRINGS, not numbers: the sibling
 *                  `sec_list` prints `No Band` for F&O names in the same
 *                  column family, and Number("No Band") is NaN — a silent
 *                  non-finite poison. Strings keep every value representable.
 *   PRICE_BAND     JSON `{"band":"2"}` — same string rationale.
 *   SURVEILLANCE   the code VERBATIM, e.g. `GSM STAGE - I`. Plain string, not
 *                  JSON: the map's instruction is "store code verbatim +
 *                  decode table in code", so unknown/new stage wordings are
 *                  preserved intact and decoded later by
 *                  `decodeSurveillanceCode()` rather than lost at parse time.
 *   FO_BAN         the constant `"BAN"`. The row's EXISTENCE is the signal;
 *                  the constant just keeps `value` non-empty for every kind.
 *   SERIES_CHANGE  JSON `{"from":"EQ","to":"BE"}`; the row's `series` carries
 *                  the RESULTING series (what the stock is now).
 *   SHORT_SELLING  JSON `{"qty":91}` — shares sold short, as disclosed.
 *
 * ## Which date a row gets
 *
 * Files that carry their own per-row date (series_change, shortselling) or a
 * banner date (fo_secban) are believed over `expectedDate` — the file is the
 * authority on which trading day its contents describe, and `series_change` is
 * a ROLLING file whose rows are years older than the fetch day (the archived
 * fixture, pulled in 2026, is full of 2023 changes). Stamping those with the
 * fetch day would invent history. Files with NO date column (52wk, band
 * changes, sec_list, surveillance) are stamped from `expectedDate`, which is
 * the archive key's day.
 *
 * ## Header-driven, degrade-to-skips
 *
 * NSE's wording drifts between eras and files arrive with disclaimer preambles
 * (52wk opens with a disclaimer + an "Effective for …" line before the real
 * header). Every parser therefore LOCATES its header by matching cell wording
 * case-insensitively and reads columns BY NAME. When the header cannot be
 * found — a layout change, an HTML error page served instead of a CSV, a
 * truncated file — the parser returns zero rows and counts every non-empty
 * line as skipped. It never falls back to guessing positions, because a
 * positional guess against a changed layout writes CONFIDENT WRONG ROWS into
 * an append-only table that nothing later reconciles.
 *
 * `skipped` = input lines that produced no flag row (no identity, no value,
 * unusable date), plus every non-empty line when the header is unlocatable.
 *
 * Pure functions: no network, no Prisma. The writer resolves symbols against
 * InstrumentMapping and DROPS unresolved rows with counters — never mints
 * instruments from flag files (MONEY-1085 rule).
 *
 * Layout provenance: 52wk, band changes, sec_list, fo_secban, series_change
 * and shortselling were coded against REAL archived bytes (fixtures under
 * __tests__/fixtures/). REG_IND / REG1_IND have NOT been archived yet — that
 * parser follows docs/reference/per-file-derivable-map.md §4 and is exercised
 * by synthetic fixtures; per the map's conflict rule the archived file wins,
 * so re-verify it when the family lands.
 */

import Papa from "papaparse";

// Same DD-MMM-YYYY grammar and the same rollover rejection (31-FEB) the
// delivery parsers needed. Reused rather than re-typed so the two families
// cannot drift apart on what a valid NSE date is.
import { parseDeliveryDate } from "./delivery";

// ─── Row shape ───────────────────────────────────────────────────────

export type StockFlagKind =
  | "BAND_CHANGE"
  | "PRICE_BAND"
  | "SURVEILLANCE"
  | "FO_BAN"
  | "WK52_HIGH_LOW"
  | "SERIES_CHANGE"
  | "SHORT_SELLING";

/**
 * Whether a kind describes a STANDING CONDITION or a DATED ONE-OFF.
 *
 *   STATE — `StockFlag` carries one row per day for as long as the flag holds
 *     (a 40-day F&O ban is 40 rows; that run length IS the datum, which is why
 *     the model has no unique). "Is it in force?" is a real question for these,
 *     and so is "when did it end?".
 *   POINT — row PRESENCE is itself the event; NSE publishes these only on the
 *     day the thing happened. A point event is never "in force" and can never
 *     "end", so asking either question of one produces a confident wrong answer
 *     — a BAND_CHANGE dated 21-May-2024 rendered as a standing flag that has
 *     since "ended", two years into its own past (MONEY-1205).
 */
export type StockFlagShape = "STATE" | "POINT";

export interface StockFlagKindPolicy {
  shape: StockFlagShape;
  /**
   * Whether a FLAG_TRANSITION alert watches this kind without being asked.
   * `false` means opt-in via `conditions.kinds`, never unavailable.
   */
  watchedByDefault: boolean;
  /**
   * Whether the family publishes a row for EVERY listed stock EVERY session.
   *
   * Measured, not assumed (prod, 2026-08-17): `PRICE_BAND` 3,489 rows and
   * `WK52_HIGH_LOW` 3,325 rows in one session — the whole cash universe.
   * `SHORT_SELLING` is 70–306 rows a day and is NOT whole-universe, which is
   * why it is `false` here and still excluded from the header by
   * `isHeadlineWorthy` on its own merits.
   *
   * A whole-universe kind can never be an exception: every stock carries one,
   * so a header strip that leads with it says nothing about THIS stock. It is
   * also the reason neither is `watchedByDefault` — an alert on either fires
   * every trading day forever.
   */
  wholeUniverseDaily: boolean;
}

/**
 * The ONE table describing how each `StockFlag.kind` behaves — MONEY-1205.
 *
 * `Record<StockFlagKind, …>` on purpose: the key set is CHECKED BY THE COMPILER
 * against the writer's own union above. It began life in
 * `workers/src/processors/alert-evaluator-logic.ts` as three plain string
 * arrays, and `SERIES_CHANGE` was simply absent from the default one, so an
 * EQ→BE move never fired an alert and nothing anywhere said so. The exhaustive
 * Record is what caught that; a new kind added to `StockFlagKind` now breaks
 * this build until somebody decides its disposition, which is the only
 * mechanism that scales past one reviewer's attention.
 *
 * It lives HERE, beside the union it is checked against, because three
 * different layers were each deciding shape on their own: the alert evaluator
 * (correctly), the badge builder (not at all — it stamped every kind as a
 * standing state) and the login briefing. Two of the three were wrong in the
 * same direction.
 */
export const FLAG_KIND_POLICY: Readonly<
  Record<StockFlagKind, StockFlagKindPolicy>
> = {
  SURVEILLANCE: {
    shape: "STATE",
    watchedByDefault: true,
    wholeUniverseDaily: false,
  },
  FO_BAN: { shape: "STATE", watchedByDefault: true, wholeUniverseDaily: false },
  PRICE_BAND: {
    shape: "STATE",
    watchedByDefault: true,
    wholeUniverseDaily: true,
  },
  BAND_CHANGE: {
    shape: "POINT",
    watchedByDefault: true,
    wholeUniverseDaily: false,
  },
  // A series change is published only on the day it moved, so watching it costs
  // nothing per-day — and EQ→BE puts a holder on trade-for-trade settlement
  // with no intraday and 100% margin, which is exactly what an alert is for.
  SERIES_CHANGE: {
    shape: "POINT",
    watchedByDefault: true,
    wholeUniverseDaily: false,
  },
  // The two the header must never lead with. `WK52_HIGH_LOW` is whole-universe
  // daily; `SHORT_SELLING` is not, but it is a recurring QUANTITY rather than a
  // condition — "1,06,000 shares sold short" is a datum for the F&O panel, not
  // a warning chip. Watching either by default means a notification every
  // trading day, which trains users to ignore alerts.
  WK52_HIGH_LOW: {
    shape: "STATE",
    watchedByDefault: false,
    wholeUniverseDaily: true,
  },
  SHORT_SELLING: {
    shape: "STATE",
    watchedByDefault: false,
    wholeUniverseDaily: false,
  },
};

/** Every kind in {@link FLAG_KIND_POLICY}, as a runtime array. */
export const ALL_STOCK_FLAG_KINDS = Object.keys(
  FLAG_KIND_POLICY,
) as StockFlagKind[];

/** Is `kind` one the policy table knows? Narrows an untyped column read. */
export function isStockFlagKind(kind: string): kind is StockFlagKind {
  return Object.prototype.hasOwnProperty.call(FLAG_KIND_POLICY, kind);
}

/**
 * A kind's shape, or null when it is one we have never seen.
 *
 * Null, not a defaulted `"STATE"`: `kind` is a String column precisely so a new
 * NSE family lands rather than being rejected, and guessing that an unknown
 * family is a standing state is how BAND_CHANGE got rendered as one.
 */
export function stockFlagShape(kind: string): StockFlagShape | null {
  return isStockFlagKind(kind) ? FLAG_KIND_POLICY[kind].shape : null;
}

export interface StockFlagRow {
  /** NSE trading symbol, VERBATIM (trimmed only). See the `$` note below. */
  symbol: string;
  /** Settlement series when the file names one, else null. */
  series: string | null;
  /** UTC midnight of the trading day this flag describes. */
  date: Date;
  kind: StockFlagKind;
  /** Compact JSON or a bare code — encoding is fixed per kind (module doc). */
  value: string;
  /** report-registry family id the bytes came from (STOCK_FLAG_SOURCES). */
  source: string;
  /**
   * ISIN when the source publishes one, for instrument resolution.
   *
   * Only the ASM/GSM JSON reports carry it today; the CSV families do not, and
   * leave it undefined. It is NOT stored on `StockFlag` — it exists so the
   * writer can join on the durable identity rather than a symbol string that
   * may since have been reassigned to a different company (MONEY-1177).
   */
  isin?: string | null;
}

export interface StockFlagParseResult {
  rows: StockFlagRow[];
  skipped: number;
}

/**
 * `source` values are report-registry family ids verbatim, so every stored row
 * points back at the exact archived family (and its URL builder) that produced
 * it. A test asserts each one still resolves through `familyById`.
 */
export const STOCK_FLAG_SOURCES = {
  wk52HighLow: "nse-52wk-high-low",
  bandChanges: "nse-eq-band-changes",
  secList: "nse-sec-list",
  surveillance: "nse-surveillance-reg",
  surveillanceNew: "nse-surveillance-reg1",
  seriesChange: "nse-series-change",
  shortSelling: "nse-shortselling",
  foSecBan: "nse-fo-secban",
  // MONEY-1189 — the REG_IND/REG1_IND archive paths above are known-404 (probed
  // 2026-08-08), which is why every stored SURVEILLANCE row came from
  // `nse-sec-list` and was GSM-only. ASM has its own live JSON endpoint.
  asm: "nse-asm-api",
  gsm: "nse-gsm-api",
} as const;

// ─── Shared plumbing ─────────────────────────────────────────────────

/**
 * CSV → trimmed cell grid, headerless. Parsed once as a grid (not with
 * `header: true`) because the header is not always line 1 — the 52wk file puts
 * a quoted disclaimer and an "Effective for …" line ahead of it, and Papa's
 * header mode would happily adopt the disclaimer as the column names.
 *
 * Space padding after commas is universal in NSE files (`"    246.61"`), so
 * everything trims on the way in.
 */
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

/** Header wording is compared on this normal form: `Sr. No` → `sr no`. */
function normalizeHeaderCell(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * First grid line where EVERY required pattern matches some (normalized) cell.
 * -1 when there is none — the caller then degrades to counted skips.
 */
function findHeaderIndex(
  grid: string[][],
  required: readonly RegExp[],
): number {
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i];
    if (!row) continue;
    const cells = row.map(normalizeHeaderCell);
    if (required.every((re) => cells.some((c) => re.test(c)))) return i;
  }
  return -1;
}

/** First column index matching any pattern, patterns tried in priority order. */
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

/** Bounds-safe cell read (`noUncheckedIndexedAccess`); missing → "". */
function at(row: readonly string[], index: number): string {
  if (index < 0) return "";
  return row[index] ?? "";
}

/** `-`, `NA` and blanks are ABSENCE, never a value. */
function present(raw: string): string | null {
  const s = raw.trim();
  if (!s || s === "-" || s === "--" || s.toUpperCase() === "NA") return null;
  return s;
}

/** Numeric field; absent or non-finite → null (never NaN into a row). */
function numOrNull(raw: string): number | null {
  const s = present(raw);
  if (s === null) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize any Date to UTC midnight of its own day, or null when the caller
 * handed us an Invalid Date. Guarding here keeps `new Date(NaN)` out of the
 * rows entirely — an Invalid Date reaching the writer is the non-finite-poison
 * bug class, and Prisma would happily store it.
 */
function utcDay(d: Date | null | undefined): Date | null {
  if (!(d instanceof Date)) return null;
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/** ISO day string for dates embedded inside `value` JSON. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Every non-empty line counted as skipped — the "unusable file" verdict. */
function allSkipped(grid: string[][]): StockFlagParseResult {
  return { rows: [], skipped: grid.length };
}

// Column patterns shared across files (normalized forms).
const SYMBOL_COL = [
  /^symbol$/,
  /^symbol name$/,
  /^scrip$/,
  /^symbol\b/,
] as const;
const SERIES_COL = [/^series$/, /^series name$/] as const;

// ─── 1. CM_52_wk_High_low → WK52_HIGH_LOW ────────────────────────────

/**
 * Parse `CM_52_wk_High_low_{DDMMYYYY}.csv`.
 *
 * VERIFIED against archived bytes (10-Aug-2026 correction #4): the file opens
 * with a quoted DISCLAIMER line, then `"Effective for 07-Aug-2026"`, and only
 * then the header —
 *   SYMBOL, SERIES, Adjusted_52_Week_High, 52_Week_High_Date,
 *   Adjusted_52_Week_Low, 52_Week_Low_DT
 * Note the asymmetric `_Date` vs `_DT` suffix; hence name-matching, not
 * positions. The "Effective for" line is a usable cross-check but is NOT what
 * stamps the row — `expectedDate` (the archive key) is, so a mislabeled file
 * cannot scatter rows across days.
 *
 * Rows where BOTH extremes are `-` (newly listed names, and every symbol NSE
 * suffixes with `$`) carry no signal and are counted as skipped. Symbols keep
 * their `$` suffix verbatim: mutating identity at parse time would hide the
 * suffix from the writer, which is the layer that decides how to resolve it.
 */
export function parseCm52WeekHighLow(
  csv: string,
  expectedDate: Date,
): StockFlagParseResult {
  const grid = toGrid(csv);
  const headerIdx = findHeaderIndex(grid, [/^symbol/, /52 week high/]);
  const header = headerIdx >= 0 ? grid[headerIdx] : undefined;
  const day = utcDay(expectedDate);
  // No header, or no day to stamp: the whole file is unusable, loudly.
  if (!header || !day) return allSkipped(grid);

  const cols = header.map(normalizeHeaderCell);
  const iSymbol = findColumn(cols, SYMBOL_COL);
  const iSeries = findColumn(cols, SERIES_COL);
  // `high$` cannot match "52 week high date"; `high (date|dt)$` cannot match
  // "adjusted 52 week high". Wording may drift around them and still resolve.
  const iHigh = findColumn(cols, [/high$/, /^high/]);
  const iHighDate = findColumn(cols, [/high (date|dt)$/, /high.*(date|dt)/]);
  const iLow = findColumn(cols, [/low$/, /^low/]);
  const iLowDate = findColumn(cols, [/low (date|dt)$/, /low.*(date|dt)/]);
  if (iSymbol < 0 || (iHigh < 0 && iLow < 0)) return allSkipped(grid);

  const rows: StockFlagRow[] = [];
  let skipped = 0;

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row) continue;
    const symbol = present(at(row, iSymbol));
    if (!symbol) {
      skipped++;
      continue;
    }
    const high = numOrNull(at(row, iHigh));
    const low = numOrNull(at(row, iLow));
    if (high === null && low === null) {
      // All-`-` row: NSE has no 52-week window for this security yet.
      skipped++;
      continue;
    }
    const highDate = parseDeliveryDate(at(row, iHighDate));
    const lowDate = parseDeliveryDate(at(row, iLowDate));

    rows.push({
      symbol,
      series: present(at(row, iSeries)),
      date: day,
      kind: "WK52_HIGH_LOW",
      value: JSON.stringify({
        high,
        highDate: highDate ? isoDay(highDate) : null,
        low,
        lowDate: lowDate ? isoDay(lowDate) : null,
      }),
      source: STOCK_FLAG_SOURCES.wk52HighLow,
    });
  }

  return { rows, skipped };
}

// ─── 2. eq_band_changes → BAND_CHANGE ────────────────────────────────

/**
 * Parse `eq_band_changes_{DDMMYYYY}.csv`.
 *
 * VERIFIED header (10-Aug-2026 correction #4):
 *   `Sr. No,Symbol,Series,Security Name,From,To`
 * There is NO effective-date column — the file's own date is the effective
 * date, so `expectedDate` (the archive key) stamps every row. The map's §4
 * line said the same; the correction pins it, because a parser that hunts for
 * a date column here finds "From"/"To" (band percentages) and would happily
 * parse `10` as a date in a looser implementation.
 */
export function parseEqBandChanges(
  csv: string,
  expectedDate: Date,
): StockFlagParseResult {
  const grid = toGrid(csv);
  const headerIdx = findHeaderIndex(grid, [/^symbol/, /^from$/, /^to$/]);
  const header = headerIdx >= 0 ? grid[headerIdx] : undefined;
  const day = utcDay(expectedDate);
  if (!header || !day) return allSkipped(grid);

  const cols = header.map(normalizeHeaderCell);
  const iSymbol = findColumn(cols, SYMBOL_COL);
  const iSeries = findColumn(cols, SERIES_COL);
  const iFrom = findColumn(cols, [/^from$/, /^from band$/, /^old band$/]);
  const iTo = findColumn(cols, [/^to$/, /^to band$/, /^new band$/]);
  if (iSymbol < 0 || iFrom < 0 || iTo < 0) return allSkipped(grid);

  const rows: StockFlagRow[] = [];
  let skipped = 0;

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row) continue;
    const symbol = present(at(row, iSymbol));
    const from = present(at(row, iFrom));
    const to = present(at(row, iTo));
    // A band change with no destination band is not a change we can state.
    if (!symbol || (from === null && to === null)) {
      skipped++;
      continue;
    }

    rows.push({
      symbol,
      series: present(at(row, iSeries)),
      date: day,
      kind: "BAND_CHANGE",
      value: JSON.stringify({ from, to }),
      source: STOCK_FLAG_SOURCES.bandChanges,
    });
  }

  return { rows, skipped };
}

// ─── 3. sec_list → PRICE_BAND (+ SURVEILLANCE) ───────────────────────

/**
 * Parse `sec_list_{DDMMYYYY}.csv` — the complete band list.
 *
 * ARCHIVE FINDING (not in the map): the real header is
 *   `Symbol,Series,Security Name,Band,Remarks`
 * — the map described this family as "symbol → applicable price band" and did
 * not mention `Remarks`, which in the archived file carries SURVEILLANCE stage
 * text: `"GSM STAGE - I"` on ANSALAPI and BLUECHIP, `"-"` on everything else.
 *
 * That matters more than a missing column usually would: the two dedicated
 * surveillance families (REG_IND / REG1_IND) are 404 at their registered paths
 * (report-registry, probe 2026-08-08), so this column is currently the ONLY
 * archived source of ASM/GSM stage in the engine. We therefore emit a second,
 * SURVEILLANCE row whenever `Remarks` holds anything but a `-` placeholder,
 * with the text stored VERBATIM and `source` = `nse-sec-list` so it is never
 * confused with a REG_IND-sourced row. Undecodable remarks are stored too,
 * unchanged, rather than dropped — decoding is a read-time concern
 * (`decodeSurveillanceCode`), and a code we cannot decode today is exactly the
 * one worth having kept.
 *
 * `skipped` counts INPUT ROWS that yielded nothing; a row that yields both a
 * PRICE_BAND and a SURVEILLANCE row is one row, not two.
 */
export function parseSecList(
  csv: string,
  expectedDate: Date,
): StockFlagParseResult {
  const grid = toGrid(csv);
  const headerIdx = findHeaderIndex(grid, [/^symbol/, /^band$/]);
  const header = headerIdx >= 0 ? grid[headerIdx] : undefined;
  const day = utcDay(expectedDate);
  if (!header || !day) return allSkipped(grid);

  const cols = header.map(normalizeHeaderCell);
  const iSymbol = findColumn(cols, SYMBOL_COL);
  const iSeries = findColumn(cols, SERIES_COL);
  const iBand = findColumn(cols, [/^band$/, /price band/, /^band pct$/]);
  const iRemarks = findColumn(cols, [/^remarks?$/, /remark/]);
  if (iSymbol < 0 || iBand < 0) return allSkipped(grid);

  const rows: StockFlagRow[] = [];
  let skipped = 0;

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row) continue;
    const symbol = present(at(row, iSymbol));
    const band = present(at(row, iBand));
    if (!symbol || band === null) {
      skipped++;
      continue;
    }
    const series = present(at(row, iSeries));

    rows.push({
      symbol,
      series,
      date: day,
      kind: "PRICE_BAND",
      value: JSON.stringify({ band }),
      source: STOCK_FLAG_SOURCES.secList,
    });

    const remarks = present(at(row, iRemarks));
    if (remarks !== null) {
      rows.push({
        symbol,
        series,
        date: day,
        kind: "SURVEILLANCE",
        value: remarks,
        source: STOCK_FLAG_SOURCES.secList,
      });
    }
  }

  return { rows, skipped };
}

// ─── 4. REG_IND / REG1_IND → SURVEILLANCE ────────────────────────────

/**
 * Parse a surveillance-indicator file (`REG_IND{DDMMYY}.csv`,
 * `REG1_IND{DDMMYY}.csv`).
 *
 * NOT ARCHIVE-VERIFIED. Both registry entries 404 at their registered paths
 * (probe 2026-08-08), so this follows the map §4 description only: symbol →
 * surveillance indicator code, stored verbatim, decoded in code. Everything
 * about it is deliberately conservative:
 *
 *   - The indicator column is found BY NAME among a set of plausible wordings.
 *     If none matches, the parser emits ZERO rows and counts every data line
 *     as skipped. It does NOT fall back to "the column that isn't the symbol":
 *     a positional guess against an unknown layout would append confidently
 *     wrong surveillance flags — the single most damaging wrong row in this
 *     module, since it is a warning shown to retail users.
 *   - The code is stored exactly as published. Decoding lives in
 *     `decodeSurveillanceCode()` and can be improved retroactively against
 *     rows already written.
 *
 * `source` defaults to the REG_IND family; pass `STOCK_FLAG_SOURCES.
 * surveillanceNew` for REG1_IND so the two remain distinguishable in storage.
 */
export function parseSurveillanceIndicator(
  csv: string,
  expectedDate: Date,
  source: string = STOCK_FLAG_SOURCES.surveillance,
): StockFlagParseResult {
  const grid = toGrid(csv);
  const headerIdx = findHeaderIndex(grid, [/^symbol/]);
  const header = headerIdx >= 0 ? grid[headerIdx] : undefined;
  const day = utcDay(expectedDate);
  if (!header || !day) return allSkipped(grid);

  const cols = header.map(normalizeHeaderCell);
  const iSymbol = findColumn(cols, SYMBOL_COL);
  const iSeries = findColumn(cols, SERIES_COL);

  // Identity/descriptive columns can never be the indicator, whatever they are
  // called; the indicator must positively name itself.
  const NOT_INDICATOR =
    /^(sr no|s no|serial|symbol|symbol name|series|security|security name|company|company name|isin|date|trade date)$/;
  const INDICATOR =
    /(surv|indicator|\bind$|asm|gsm|esm|stage|category|flag|remark)/;
  let iCode = -1;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (c === undefined || NOT_INDICATOR.test(c)) continue;
    if (INDICATOR.test(c)) {
      iCode = i;
      break;
    }
  }
  if (iSymbol < 0 || iCode < 0) return allSkipped(grid);

  const rows: StockFlagRow[] = [];
  let skipped = 0;

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row) continue;
    const symbol = present(at(row, iSymbol));
    const code = present(at(row, iCode));
    if (!symbol || code === null) {
      skipped++;
      continue;
    }

    rows.push({
      symbol,
      series: present(at(row, iSeries)),
      date: day,
      kind: "SURVEILLANCE",
      value: code,
      source,
    });
  }

  return { rows, skipped };
}

// ─── ASM / GSM live JSON reports (MONEY-1189) ────────────────────────

/**
 * A row as NSE serves it on `/api/reportASM` and `/api/reportGSM`.
 *
 * Both endpoints share this shape; only the timestamp field name differs
 * (`asmTime` / `gsmTime`), so both are declared optional and read in turn.
 */
export interface NseSurveillanceApiRow {
  symbol?: string;
  companyName?: string;
  isin?: string;
  series?: string | null;
  survCode?: string;
  survDesc?: string;
  asmSurvIndicator?: string;
  gsmStage?: string;
  asmTime?: string;
  gsmTime?: string;
}

/** `/api/reportASM` — NSE splits the two frameworks into named buckets. */
export interface NseAsmReport {
  longterm?: { data?: NseSurveillanceApiRow[] };
  shortterm?: { data?: NseSurveillanceApiRow[] };
}

/** `12-Aug-2026` / `12-Aug-2026 08:07:02` → UTC midnight, else null. */
const MONTHS: Readonly<Record<string, number>> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};
function parseNseListDate(raw: string | undefined): Date | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const mon = MONTHS[m[2]!.toUpperCase()];
  if (mon === undefined) return null;
  return new Date(Date.UTC(Number(m[3]), mon, Number(m[1])));
}

/**
 * Turn one ASM/GSM API row into a `StockFlagRow`.
 *
 * ## Why `value` is NSE's verbatim `survDesc`
 *
 * Not `survCode`, and not a canonical enum we mint.
 *
 * `survCode` loses the stage: `decodeSurveillanceCode("LTASM - I (13)")` is
 * null and `"GSM - VI (6)"` decodes with no stage at all, because neither
 * carries the word "Stage". `survDesc` — "Long Term Additional Surveillance
 * Measure (LTASM) - Stage I" — decodes correctly for every value both feeds
 * serve today.
 *
 * A canonical enum was the other candidate and is the wrong call here: this
 * module deliberately stores NSE's text verbatim and decodes at READ time, so
 * that a better decode table re-decodes rows written years earlier. Freezing
 * today's interpretation into the row would give that up, and the 25 stored
 * GSM spellings already collapse to 6 decodes without it.
 *
 * Rows with no symbol, or whose wording does not decode, are DROPPED and
 * counted — a surveillance flag we cannot interpret is worse than none, since
 * it renders as an unexplained warning on a real company.
 */
function toSurveillanceFlag(
  row: NseSurveillanceApiRow,
  source: string,
  fallbackDate: Date,
): StockFlagRow | null {
  const symbol = String(row.symbol ?? "").trim();
  if (!symbol) return null;

  const desc = String(row.survDesc ?? "").trim();
  if (!desc || !decodeSurveillanceCode(desc)) return null;

  const series = String(row.series ?? "").trim();
  return {
    symbol,
    series: series.length > 0 ? series : null,
    // NSE stamps the list's as-of date on every row; it is the trading day the
    // flag describes. Falling back to the caller's day keeps an archived
    // response replayable when the field is missing.
    date: parseNseListDate(row.asmTime ?? row.gsmTime) ?? fallbackDate,
    kind: "SURVEILLANCE",
    value: desc,
    source,
    isin:
      String(row.isin ?? "")
        .trim()
        .toUpperCase() || null,
  };
}

/**
 * Parse `/api/reportASM` — NSE's Additional Surveillance Measure lists.
 *
 * ASM was entirely absent before this: the archived REG_IND/REG1_IND paths
 * 404, so all 86,005 stored SURVEILLANCE rows came from `nse-sec-list` and were
 * GSM-only. ASM is the framework that flags recent, price-driven surveillance,
 * which is the retail warning the feature exists for.
 *
 * Both buckets carry the SAME `StockFlagRow.source`; long vs short term is
 * recoverable from the decoded `variant`, so it does not need a second source
 * id whose only job is duplicating what the text already says.
 */
export function parseAsmReport(
  payload: unknown,
  date: Date,
): StockFlagParseResult {
  const rows: StockFlagRow[] = [];
  let skipped = 0;

  const report = (payload ?? {}) as NseAsmReport;
  const buckets = [report.longterm?.data, report.shortterm?.data];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const raw of bucket) {
      const flag = toSurveillanceFlag(raw, STOCK_FLAG_SOURCES.asm, date);
      if (flag) rows.push(flag);
      else skipped++;
    }
  }

  return { rows, skipped };
}

/**
 * Parse `/api/reportGSM` — the Graded Surveillance Measure list (a bare array).
 *
 * Note the field NOT used: `gsmStage` looks authoritative and is not. On the
 * live feed `"IBC - Receipt & GSM 0 (62)"` carries `gsmStage: "LXII"` — Roman
 * numerals for the surveillance CODE number 62, not the stage. It coincides
 * with the stage for plain codes (`"GSM - VI (6)"` → `"VI"`), which is exactly
 * what would make a spot-check pass while every combined state came out wrong.
 */
export function parseGsmReport(
  payload: unknown,
  date: Date,
): StockFlagParseResult {
  const rows: StockFlagRow[] = [];
  let skipped = 0;

  if (!Array.isArray(payload)) return { rows, skipped };
  for (const raw of payload as NseSurveillanceApiRow[]) {
    const flag = toSurveillanceFlag(raw, STOCK_FLAG_SOURCES.gsm, date);
    if (flag) rows.push(flag);
    else skipped++;
  }

  return { rows, skipped };
}

// ─── Surveillance decode table ───────────────────────────────────────

export type SurveillanceFramework =
  | "ASM"
  | "GSM"
  | "ESM"
  | "IBC"
  | "TRADE_FOR_TRADE"
  | "PLEDGE"
  | "UNSOLICITED_SMS";

export interface SurveillanceDecode {
  framework: SurveillanceFramework;
  /** ASM only: NSE runs a short-term and a long-term framework. */
  variant: "SHORT_TERM" | "LONG_TERM" | null;
  /** 1-based stage where the framework has stages, else null. */
  stage: number | null;
  /** Display label, normalized across the wording variants. */
  label: string;
}

const ROMAN: Readonly<Record<string, number>> = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
};

const STAGE_SRC = String.raw`\bSTAGE\s*([IVX]+|\d+)\b`;

const toStage = (tok: string): number | null =>
  /^\d+$/.test(tok) ? Number(tok) : (ROMAN[tok] ?? null);

/**
 * The stage belonging to THIS framework — not merely the first stage in the
 * string.
 *
 * NSE publishes combined states, and taking the first `STAGE` token anywhere
 * mis-attributes one framework's stage to another. Live examples from
 * `/api/reportGSM`:
 *
 *   "ESM Stage I and GSM Stage 0"        → GSM Stage I    (should be 0)
 *   "LTASM Stage I and GSM Stage 0"      → GSM Stage I    (should be 0)
 *   "ASM IBC Stage I and GSM Stage 0"    → GSM Stage I    (should be 0)
 *
 * Every one of those errs the same direction — GSM 0 is the mildest stage, so
 * the bug systematically OVERSTATES how distressed a stock is, on the surface
 * whose whole job is warning retail investors. 4 of the 14 descriptions live on
 * the feed today are affected.
 *
 * NSE always writes `<framework> Stage <n>`, so the stage after the keyword
 * wins; a preceding one is the fallback for older stored wording.
 */
function stageFor(s: string, keyword: RegExp): number | null {
  const kw = new RegExp(keyword.source).exec(s);
  if (!kw) return null;

  const after = new RegExp(STAGE_SRC).exec(s.slice(kw.index + kw[0].length));
  if (after?.[1]) return toStage(after[1]);

  const before = [...s.slice(0, kw.index).matchAll(new RegExp(STAGE_SRC, "g"))];
  const last = before[before.length - 1]?.[1];
  return last ? toStage(last) : null;
}

const GSM_KW = /\bGSM\b|GRADED SURVEILLANCE/;
const ESM_KW = /\bESM\b|ENHANCED SURVEILLANCE/;
// LTASM/STASM are single tokens, so `\bASM\b` does NOT match them — they are
// listed explicitly rather than loosening the boundary, which would also match
// words merely ending in "ASM".
const ASM_KW = /\bASM\b|\bLTASM\b|\bSTASM\b|ADDITIONAL SURVEILLANCE/;

/**
 * Decode a stored surveillance code into a framework + stage.
 *
 * Deliberately a READ-TIME helper over verbatim stored text: NSE writes the
 * same stage half a dozen ways (`GSM STAGE - I`, `GSM Stage 1`,
 * `ST-ASM Stage II`, `Long Term ASM - Stage IV`), and new frameworks appear
 * without notice. Storing the decode instead of the text would freeze today's
 * table into history; this way a better table re-decodes rows written years
 * ago. Unknown wording returns null — never a guessed framework.
 */
export function decodeSurveillanceCode(raw: string): SurveillanceDecode | null {
  const s = String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  if (!s) return null;

  const roman = (n: number | null): string =>
    n === null
      ? ""
      : ` Stage ${Object.keys(ROMAN).find((k) => ROMAN[k] === n) ?? String(n)}`;

  if (GSM_KW.test(s)) {
    const stage = stageFor(s, GSM_KW);
    return {
      framework: "GSM",
      variant: null,
      stage,
      label: `GSM${roman(stage)}`,
    };
  }
  if (ESM_KW.test(s)) {
    const stage = stageFor(s, ESM_KW);
    return {
      framework: "ESM",
      variant: null,
      stage,
      label: `ESM${roman(stage)}`,
    };
  }
  if (ASM_KW.test(s)) {
    const stage = stageFor(s, ASM_KW);
    const variant = /\bST\b|\bSTASM\b|SHORT TERM/.test(s)
      ? "SHORT_TERM"
      : /\bLT\b|\bLTASM\b|LONG TERM/.test(s)
        ? "LONG_TERM"
        : null;
    const prefix =
      variant === "SHORT_TERM"
        ? "Short-term ASM"
        : variant === "LONG_TERM"
          ? "Long-term ASM"
          : "ASM";
    return {
      framework: "ASM",
      variant,
      stage,
      label: `${prefix}${roman(stage)}`,
    };
  }
  if (/\bIBC\b|INSOLVENCY/.test(s)) {
    return {
      framework: "IBC",
      variant: null,
      stage: null,
      label: "Insolvency (IBC)",
    };
  }
  if (/TRADE FOR TRADE|\bT2T\b|\bTFT\b/.test(s)) {
    return {
      framework: "TRADE_FOR_TRADE",
      variant: null,
      stage: null,
      label: "Trade-for-trade",
    };
  }
  if (/PLEDGE|ENCUMBER/.test(s)) {
    return {
      framework: "PLEDGE",
      variant: null,
      stage: null,
      label: "High promoter pledge",
    };
  }
  if (/UNSOLICITED/.test(s)) {
    return {
      framework: "UNSOLICITED_SMS",
      variant: null,
      stage: null,
      label: "Unsolicited SMS",
    };
  }
  return null;
}

// ─── 5. fo_secban → FO_BAN ───────────────────────────────────────────

/** Header-ish cells that must never be mistaken for a banned symbol. */
const HEADERISH =
  /^(sr no|s no|serial|symbol|symbol name|series|security|security name|scrip|company|company name)$/;

/**
 * Parse `fo_secban_{DDMMYYYY}.csv` — the day's F&O ban list.
 *
 * ARCHIVE FINDING (contradicts the map): §3 called this "one symbol per row
 * under a header". The archived file has NO column header at all — line 1 is a
 * banner sentence, `Securities in Ban For Trade Date 10-AUG-2026:`, and the
 * data rows are `1,BANDHANBNK` (serial + symbol). A header-driven parse finds
 * nothing here, so this one is STRUCTURAL — and structural parsing is where
 * wrong rows come from, so it accepts only the two shapes this family is known
 * to take: `serial,SYMBOL` (archived) and a bare `SYMBOL` (the map's
 * description, plausibly an older era). Everything else is a counted skip; a
 * header row is NOT mined for the cell that looks most symbol-shaped.
 *
 * The banner date WINS over `expectedDate` when present: it names the trade
 * date the ban actually applies to, which for this family is not always the
 * file's own key day (NSE publishes the ban for the NEXT session). Falling
 * back to `expectedDate` rather than rejecting the file keeps a banner-wording
 * change from silently zeroing the whole family.
 */
export function parseFoSecBan(
  csv: string,
  expectedDate: Date,
): StockFlagParseResult {
  const grid = toGrid(csv);
  const fallbackDay = utcDay(expectedDate);

  // Banner date, if the file states one.
  let bannerDay: Date | null = null;
  for (const row of grid) {
    if (!row) continue;
    const line = row.join(" ");
    const m = /trade date\s*[:\-]?\s*(\d{1,2}-[A-Za-z]{3}-\d{4})/i.exec(line);
    if (m) {
      bannerDay = utcDay(parseDeliveryDate(m[1]));
      if (bannerDay) break;
    }
  }

  const day = bannerDay ?? fallbackDay;
  if (!day) return allSkipped(grid);

  const rows: StockFlagRow[] = [];
  let skipped = 0;

  for (const row of grid) {
    if (!row) continue;
    // Any banner line is not a data row (matched loosely: the wording moves,
    // the phrase "trade date" has stayed).
    if (/trade date/i.test(row.join(" "))) continue;

    // Accept exactly the two shapes this family is known to take: `serial,
    // SYMBOL` (archived) and a bare `SYMBOL` (the map's description of the
    // older era). Anything else — a 3-column header, a footnote, an HTML line —
    // is counted, never mined for whichever cell happens to look symbol-shaped.
    const cells = row.filter((c) => c.length > 0);
    const candidate =
      cells.length === 1
        ? cells[0]
        : cells.length === 2 && /^\d+$/.test(cells[0] ?? "")
          ? cells[1]
          : undefined;
    const symbol = candidate === undefined ? null : present(candidate);
    // Reject pure serials, header words, dates (a comma-separated banner would
    // otherwise leave `10-AUG-2026` looking exactly like a symbol) and anything
    // with spaces/punctuation no NSE trading symbol carries — better a counted
    // skip than a row claiming "SECURITIES" is banned.
    if (
      !symbol ||
      /^\d+$/.test(symbol) ||
      HEADERISH.test(normalizeHeaderCell(symbol)) ||
      parseDeliveryDate(symbol) !== null ||
      !/^[A-Z0-9][A-Z0-9&*.\-$]{0,29}$/.test(symbol)
    ) {
      skipped++;
      continue;
    }

    rows.push({
      symbol,
      series: null,
      date: day,
      kind: "FO_BAN",
      value: "BAN",
      source: STOCK_FLAG_SOURCES.foSecBan,
    });
  }

  return { rows, skipped };
}

// ─── 6. series_change → SERIES_CHANGE ────────────────────────────────

/**
 * Parse `series_change.csv` (rolling).
 *
 * Archived header: `Symbol,Security,From Series,To Series,Change Date,Remarks`
 * — the map's semantic list (symbol, old series, new series, effective date)
 * holds, plus a security-name and a remarks column.
 *
 * This file is ROLLING: the archived copy fetched in 2026 is full of 2023
 * changes. `expectedDate` is therefore NOT a fallback here — a row whose own
 * Change Date will not parse is SKIPPED, because stamping it with the fetch
 * day would assert that a three-year-old EQ→BE migration happened today, and
 * nothing downstream could tell the invented date from a real one.
 *
 * The row's `series` carries the RESULTING series (what the stock is now);
 * `value` keeps both ends: `{"from":"EQ","to":"BE"}`.
 */
export function parseSeriesChange(
  csv: string,
  _expectedDate: Date,
): StockFlagParseResult {
  const grid = toGrid(csv);
  const headerIdx = findHeaderIndex(grid, [/^symbol/, /series/]);
  const header = headerIdx >= 0 ? grid[headerIdx] : undefined;
  if (!header) return allSkipped(grid);

  const cols = header.map(normalizeHeaderCell);
  const iSymbol = findColumn(cols, SYMBOL_COL);
  const iFrom = findColumn(cols, [/^from series$/, /old series/, /^from$/]);
  const iTo = findColumn(cols, [/^to series$/, /new series/, /^to$/]);
  const iDate = findColumn(cols, [
    /^change date$/,
    /effective date/,
    /(change|effective).*date/,
    /^date$/,
  ]);
  if (iSymbol < 0 || iFrom < 0 || iTo < 0 || iDate < 0) return allSkipped(grid);

  const rows: StockFlagRow[] = [];
  let skipped = 0;

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row) continue;
    const symbol = present(at(row, iSymbol));
    const from = present(at(row, iFrom));
    const to = present(at(row, iTo));
    const day = utcDay(parseDeliveryDate(at(row, iDate)));
    if (!symbol || from === null || to === null || !day) {
      skipped++;
      continue;
    }

    rows.push({
      symbol,
      series: to,
      date: day,
      kind: "SERIES_CHANGE",
      value: JSON.stringify({ from, to }),
      source: STOCK_FLAG_SOURCES.seriesChange,
    });
  }

  return { rows, skipped };
}

// ─── 7. shortselling → SHORT_SELLING ─────────────────────────────────

/**
 * Parse `shortselling_{DDMMYYYY}.csv`.
 *
 * Archived header: `"Security Name","Symbol Name","Trade Date","Quantity"` —
 * fully quoted, and the symbol column is `Symbol Name`, not `Symbol` (the map
 * only said "day's short-selling disclosures"). Security names carry trailing
 * padding (`"JM FINANCIAL LIMITED    "`) which is why everything trims.
 *
 * There is no series column, so `series` is null and the writer resolves the
 * symbol on its own. The row's Trade Date wins over `expectedDate`; unlike
 * series_change this family IS dated per file, so `expectedDate` is a safe
 * fallback when a row's date is unreadable.
 */
export function parseShortSelling(
  csv: string,
  expectedDate: Date,
): StockFlagParseResult {
  const grid = toGrid(csv);
  const headerIdx = findHeaderIndex(grid, [/symbol/, /quantity|^qty$/]);
  const header = headerIdx >= 0 ? grid[headerIdx] : undefined;
  const fallbackDay = utcDay(expectedDate);
  if (!header) return allSkipped(grid);

  const cols = header.map(normalizeHeaderCell);
  const iSymbol = findColumn(cols, [/^symbol name$/, /^symbol$/, /symbol/]);
  const iSeries = findColumn(cols, SERIES_COL);
  const iQty = findColumn(cols, [/^quantity$/, /^qty$/, /quantity/]);
  const iDate = findColumn(cols, [/^trade date$/, /^date$/, /date/]);
  if (iSymbol < 0 || iQty < 0) return allSkipped(grid);

  const rows: StockFlagRow[] = [];
  let skipped = 0;

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row) continue;
    const symbol = present(at(row, iSymbol));
    const qty = numOrNull(at(row, iQty));
    const day = utcDay(parseDeliveryDate(at(row, iDate))) ?? fallbackDay;
    if (!symbol || qty === null || !day) {
      skipped++;
      continue;
    }

    rows.push({
      symbol,
      series: present(at(row, iSeries)),
      date: day,
      kind: "SHORT_SELLING",
      value: JSON.stringify({ qty }),
      source: STOCK_FLAG_SOURCES.shortSelling,
    });
  }

  return { rows, skipped };
}
