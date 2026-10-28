/**
 * NSE `combineoi_deleq_{DDMMYYYY}.csv` → `MwplDaily` — MONEY-1204 (P14 / 14b.2).
 *
 * Market-wide F&O open interest per underlying: how much of a stock is standing
 * open across every derivative contract written on it, published daily by NSE
 * Clearing. Registry family `nse-combine-oi-deleq`, enabled and archived since
 * 2023-04 (688 objects), and until now never parsed.
 *
 * ## The task asked for MWPL utilisation. Only the NUMERATOR exists.
 *
 * This is the finding, not a footnote. MWPL utilisation is
 * `combinedOi / mwpl * 100`, and the whole point of it is the `>= 80%` alert —
 * NSE bans fresh positions at 95%, so the ratio is a risk signal that things
 * downstream act on.
 *
 * The numerator is here. The complete, verbatim header of the real 14-Aug-2026
 * file is:
 *
 * ```
 * Date,ISIN,Scrip Name,Symbol,Notional Open Interest,Portfolio-wise Futures Equivalent Open Interest
 * ```
 *
 * Six columns. There is no position limit in them, and no other column that
 * could stand in for one.
 *
 * The denominator lives in `mwpl_cli_{DDMMYYYY}.xls`, whose registry path 404s
 * and which has **zero** archived objects (counted in the prod bucket on
 * 2026-08-16). The obvious neighbour was checked and rejected:
 * `nse-oi-cli-limit` has 1,636 archived objects and its columns are
 * `SYMBOL,CLIENT_LIMIT,EXCHANGE` — a PER-CLIENT limit, a different quantity
 * entirely. Dividing by it yields a number that looks like a utilisation, is
 * plausible in magnitude, and is wrong; the `>= 80%` flag would then fire on
 * fiction. So `MwplDaily.mwpl` and `.utilisationPct` are written NULL, and
 * {@link toMwplDailyWrite} types them as the literal `null` so no writer can
 * quietly substitute one. The day a real MWPL source lands, that type changes
 * and every call site fails to compile until it has been looked at — which is
 * the intent.
 *
 * ## A second, unresolved question the missing denominator hides
 *
 * WHICH of the two published columns is the numerator is also not settled.
 * `Notional Open Interest` is a raw share count; `Portfolio-wise Futures
 * Equivalent Open Interest` is delta-adjusted (fractional — 140455762.42 for
 * RELIANCE, which is why the model stores Float). NSE has moved MWPL monitoring
 * between those two conventions. Picking the wrong one produces a wrong
 * utilisation just as surely as a wrong denominator does, so this module
 * deliberately does not choose: both columns are parsed under their own names,
 * and {@link computeUtilisationPct} takes the numerator as an argument. Settle
 * it against NSE's circular at the same time the denominator is settled, not
 * before.
 *
 * ## Index underlyings are in this file and are not MWPL-bearing
 *
 * Nine of the 217 rows in the real file publish `NA` for both ISIN and Scrip
 * Name: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50, NIFTYFPI, FOCIT,
 * and BSE's SENSEX and BANKEX. Their open interest is real and is kept; MWPL is
 * a single-stock concept and does not apply to them at all. They carry
 * `isIndex: true` so a consumer can exclude them without re-deriving the rule
 * from a null ISIN.
 *
 * ## NSE has published this file in THREE column layouts, not one (MONEY-1204)
 *
 * The parser originally knew only the layout above, and that cost two years of
 * history: 409 of the 689 archived objects were rejected as "not this report",
 * the writer returned 0, and the dispatcher checkpointed every one of them DONE.
 * The bytes were never corrupt — the header simply changed. Read off the whole
 * prod archive (2023-04-12 → 2026-08-17) on 2026-08-18:
 *
 * | # | files | span                    | header                                  |
 * |---|-------|-------------------------|-----------------------------------------|
 * | 1 |   254 | 2023-04-12 → 2024-11-18 | 7 col, **quoted**, `Open Interest` + two `Delta Equivalent …` |
 * | 2 |   154 | 2023-11-02 → 2025-06-27 | 7 col, unquoted, same column NAMES as #1 |
 * | 3 |    64 | 2025-07-01 → 2025-09-30 | 6 col, `NotionalOpen Interest` (no space), `Portfolio-wiseFutures …` |
 * | 4 |   216 | 2025-06-30 → 2026-08-17 | 6 col, the modern header quoted at the top of this file |
 *
 * The two eras **interleave** — #1 and #2 both run through 2023-11…2024-11, and
 * #3 and #4 alternate day-to-day through 2025-07…2025-09 — so there is no
 * changeover DATE to branch on and none is used. Columns are resolved by NAME,
 * every era at once, which is why {@link resolveColumns} carries alternates
 * rather than a version switch. (#3 differs from #4 only by two missing spaces,
 * which {@link normalizeHeader} erases; it needs no rule of its own.)
 *
 * The 689th object is a GZIP stream archived under a `.csv` key (2025-01-01) and
 * is still rejected — see the note on the caller.
 *
 * ## The 7-column era's THIRD measure, and which column maps to which field
 *
 * The old layout publishes one more number than the modern one:
 *
 * ```
 * Open Interest | Delta Equivalent OI Contract wise | Delta Equivalent OI Portfolio wise
 * ```
 *
 * Mapping the middle one onto {@link CombinedOiRow.futEquivOi} would put a
 * contract-wise number in a portfolio-wise field, where no test and no reader
 * could ever detect it. So it was measured, not guessed, across the one-trading-
 * day #2→#4 boundary (2025-06-27 → 2025-06-30, 231 symbols in both files):
 *
 * ```
 * old `Open Interest`             vs new `Notional OI`            median |Δ| =  3.79%
 * old `Delta Equiv. PORTFOLIO wise` vs new `Portfolio-wise Fut.Eq.` median |Δ| =  1.58%   ← match
 * old `Delta Equiv. CONTRACT wise`  vs new `Portfolio-wise Fut.Eq.` median |Δ| = 12.83%   ← 8x worse
 * ```
 *
 * The within-file ratio signature says the same thing independently of any
 * overnight drift: portfolio-wise/OI is 0.726 in the old era against 0.696 for
 * the modern pair, while contract-wise/OI is 0.833. Contract-wise is strictly
 * the larger of the two in every row of every file. So:
 *
 * - `Open Interest`                        → {@link CombinedOiRow.notionalOi}
 * - `Delta Equivalent OI **Portfolio** wise` → {@link CombinedOiRow.futEquivOi}
 * - `Delta Equivalent OI **Contract** wise`  → {@link CombinedOiRow.contractDeltaOi}
 *
 * The third is kept under its OWN name rather than dropped. `MwplDaily` has no
 * column for it and {@link toMwplDailyWrite} discards it exactly as it discards
 * `name` and `isIndex` — but this module's whole stated position is that it does
 * not get to choose which published column is the MWPL numerator (see above), and
 * silently discarding one of the three candidates in the historical era would
 * settle that question by omission, years before anyone asks it.
 *
 * Absence rules follow the house convention: `""` / `-` / `NA` parse to `null`,
 * never `0` (`Number("")` is `0`, which here would read as "no open interest",
 * a tradeable-looking fact). `null` from {@link parseCombinedOiDeleq} means
 * "these bytes are not this report"; a non-null result with `rows: []` means
 * "this IS the report and it carried nothing". The two are never collapsed, and
 * every drop is counted in `reasons`.
 */

import { splitCsvLine } from "./csv-line";

// ─── Namespace ───────────────────────────────────────────────────────────────

/**
 * `MwplDaily.source` for every row this module produces.
 *
 * Names the FILE, not the concept. When a real MWPL denominator arrives it will
 * come from a different file, and rows carrying a real `mwpl` must be
 * distinguishable from these at a glance.
 */
export const MWPL_SOURCE = "NSE_COMBINE_OI_DELEQ" as const;

// ─── Row shapes ──────────────────────────────────────────────────────────────

/** One published line of `combineoi_deleq_{DDMMYYYY}.csv`. */
export interface CombinedOiRow {
  /** Underlying trading symbol, upper-cased. */
  symbol: string;
  /** ISIN, or `null` on index underlyings (published as the string `NA`). */
  isin: string | null;
  /** `Scrip Name` as published; `null` on index rows (also `NA`). */
  name: string | null;
  /**
   * UTC midnight of the IST trading day, read from the ROW's own `Date` cell.
   *
   * The archive key carries a date too, but the model documents the file's
   * column as the source of truth, so that is what is read here.
   */
  date: Date;
  /** `Notional Open Interest` — a raw share count. Integer in every observed row. */
  notionalOi: number | null;
  /** `Portfolio-wise Futures Equivalent Open Interest` — delta-adjusted, fractional. */
  futEquivOi: number | null;
  /**
   * `Delta Equivalent Open Interest Contract wise` — the 7-column era's THIRD
   * measure, and `null` for every file from 2025-06-30 on, which simply stopped
   * publishing it.
   *
   * Contract-wise, NOT portfolio-wise: it is strictly the larger of the two in
   * every row of every archived file, and it is `futEquivOi`'s sibling, never its
   * substitute. See the module header for the measurement that settled that.
   *
   * `MwplDaily` has no column for it, so {@link toMwplDailyWrite} drops it.
   */
  contractDeltaOi: number | null;
  /**
   * True when the underlying is an INDEX rather than a single stock.
   *
   * Derived from the file publishing `NA` for ISIN and Scrip Name together.
   * MWPL does not apply to an index, so these rows can never be utilisation
   * candidates even after a denominator source exists.
   */
  isIndex: boolean;
}

export interface CombinedOiFile {
  /**
   * The day this file describes — the first legible row `Date`.
   *
   * `null` only when no row parsed. Rows disagreeing with it are still kept
   * (each carries its own date) and counted under `mixed-date`.
   */
  tradingDate: Date | null;
  rows: CombinedOiRow[];
  /** Falsification counters — why rows were dropped, never silently. */
  reasons: Record<string, number>;
}

/**
 * The exact `MwplDaily` payload for one row.
 *
 * `mwpl` and `utilisationPct` are typed as the LITERAL `null`, not
 * `number | null`. That is the guard: a writer cannot pass a substitute
 * denominator through this helper, and widening the type is a deliberate,
 * compiler-enforced act rather than a one-line edit nobody reviews. See the
 * module header.
 */
export interface MwplDailyWrite {
  symbol: string;
  isin: string | null;
  date: Date;
  notionalOi: number | null;
  futEquivOi: number | null;
  mwpl: null;
  utilisationPct: null;
  source: string;
}

// ─── Cell parsing ────────────────────────────────────────────────────────────

/**
 * A number cell, or `null` when absent.
 *
 * `Number("")` is `0` and `Number(" ")` is `0`, so the blank check has to come
 * first — a zero open interest is a real, meaningful value and must not be
 * manufactured out of an empty cell.
 */
function num(value: unknown): number | null {
  const s = String(value ?? "").trim();
  if (!s || s === "-" || s.toUpperCase() === "NA") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** A text cell, or `null` when blank or NSE's `NA` placeholder. */
function text(value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (!s || s === "-" || s.toUpperCase() === "NA") return null;
  return s;
}

/**
 * `DD-MM-YYYY` → UTC midnight. Strict, and deliberately NOT month-first.
 *
 * This file's date token is all-numeric (`14-08-2026`), unlike the `DD-MON-YYYY`
 * used by the debt and EGR feeds on the same site, so day-vs-month cannot be
 * inferred from the token itself. It is fixed as day-first here, and a token
 * whose SECOND field exceeds 12 is rejected rather than swapped — a file that
 * silently switched to `MM-DD-YYYY` would otherwise be read as valid for the
 * ~12 days a month where both orderings parse, and wrong for the rest.
 *
 * The round-trip check is what rejects `31-02-2026`: `Date.UTC` rolls impossible
 * days over into the next month without complaint.
 *
 * ## Day-first is measured, not assumed — and the SLASH grammar stays rejected
 *
 * The whole prod archive was checked against the one piece of external ground
 * truth available, the `{DDMMYYYY}` token in each object's own key. 677 files
 * carry a dash token; **675 of them agree with their filename read day-first**,
 * across BOTH the 7-column and 6-column eras. Month-first is not a live
 * hypothesis for this feed.
 *
 * The two that disagree are worth knowing, because neither is a date format:
 *
 * - `2023-04-12` publishes `04-12-2023`. That object is a BYTE-FOR-BYTE
 *   duplicate of `2023-12-04`'s (identical 185-row body) — the archive holds one
 *   file under two keys, and the CELL is the correct one of the two. Reading the
 *   row's own date, which is what this module does, lands it on 4 Dec where it
 *   belongs and makes the write idempotent with the genuine file. It needs no
 *   special case; it is the rule working.
 * - `2024-11-18` publishes `20-11-0018` in all 185 rows — a mangled token, not a
 *   different grammar. Year 0018 fails the window check below and every row is
 *   counted `bad-date`. That day is genuinely unreadable and is refused rather
 *   than guessed at.
 *
 * ELEVEN files use slashes instead (`11/2/2023`, `4/3/2024`, `04/08/2025`,
 * `06/08/25`). They are NOT parsed, and adding them would be a mistake: every
 * one of the 11 tokens has both leading fields <= 12, so none is
 * self-disambiguating — and they **contradict each other**. `4/3/2024` can only
 * be day-first (its file is 4 March); `11/2/2023` can only be month-first (its
 * file is 2 November). No single ordering reads all eleven correctly, so a
 * day-first rule would be right ten times and silently wrong by nine months
 * once. That is strictly worse than refusing all eleven, which is what happens:
 * the token fails this regex, the rows are counted `bad-date`, and the file is
 * never checkpointed. Do not "fix" this by consulting the archive key — the
 * caller deliberately cannot see it (MONEY-1189).
 */
export function parseMwplDate(raw: unknown): Date | null {
  const s = String(raw ?? "").trim();
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (!m) return null;

  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);

  // Cheap range gate before Date.UTC, so month 00/13 never reaches it.
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1990 || year > 2100) return null;

  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
    ? d
    : null;
}

// ─── Utilisation ─────────────────────────────────────────────────────────────

/**
 * `combinedOi / mwpl * 100`, or `null` when it cannot be computed honestly.
 *
 * **Inert today by construction.** No source for `mwpl` exists (see the module
 * header), so every real call currently passes `null` and gets `null` back. The
 * arithmetic is written and tested now so that the day a denominator lands, the
 * only open question is which numerator column to feed it — not whether the
 * division rounds, guards or fails the way the rest of this repo does.
 *
 * Returns `null` when:
 * - `mwpl` is `null`/`undefined`, `0`, negative, or non-finite. Zero is the
 *   dangerous one: `x / 0` is `Infinity`, which flows into a `>= 80` comparison
 *   as `true` and would fire the ban-risk flag on every symbol.
 * - `combinedOi` is `null`/`undefined`, non-finite, or negative. Open interest
 *   cannot be negative; a negative cell is corruption, not a small utilisation.
 *
 * A `combinedOi` of exactly `0` is a real value and returns `0`, not `null`.
 *
 * The result is NOT rounded. Rounding is a presentation decision and belongs at
 * the surface that displays it, not baked into the stored number.
 */
export function computeUtilisationPct(
  combinedOi: number | null | undefined,
  mwpl: number | null | undefined,
): number | null {
  if (combinedOi === null || combinedOi === undefined) return null;
  if (mwpl === null || mwpl === undefined) return null;
  if (!Number.isFinite(combinedOi) || combinedOi < 0) return null;
  if (!Number.isFinite(mwpl) || mwpl <= 0) return null;

  const pct = (combinedOi / mwpl) * 100;
  return Number.isFinite(pct) ? pct : null;
}

// ─── Header resolution ───────────────────────────────────────────────────────

/** Header cell reduced to letters+digits, so spacing/case drift cannot break it. */
function normalizeHeader(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface ColumnMap {
  date: number;
  symbol: number;
  notionalOi: number;
  futEquivOi: number;
  /** `-1` when the file has no ISIN column. */
  isin: number;
  /** `-1` when the file has no Scrip Name column. */
  name: number;
  /** `-1` on the 6-column era, which does not publish a contract-wise measure. */
  contractDeltaOi: number;
}

/**
 * Locate the columns by NAME, never by position, across every published layout.
 *
 * Returns `null` when a REQUIRED column is missing, which the caller turns into
 * "not this report". Requiring BOTH open-interest measures is deliberate: a file
 * that dropped one would otherwise parse into rows whose missing half is
 * indistinguishable from a genuine all-null day, and this repo has been bitten
 * by exactly that class of silent half-read.
 *
 * ## Why alternates and not a version switch
 *
 * The 7-column and 6-column eras INTERLEAVE in the archive (see the module
 * header), so there is no date to branch on. Each measure therefore carries the
 * labels of both eras and the header decides, one file at a time.
 *
 * Two of these predicates are exact-match and that is load-bearing:
 *
 * - `openinterest` must be `===`, never `includes`. Both 7-column delta labels
 *   CONTAIN "openinterest" ("deltaequivalentopeninterestcontractwise"), so an
 *   `includes` would resolve the notional measure to whichever delta column came
 *   first and write a delta-adjusted number into a raw share count.
 * - The modern label is tried BEFORE the bare one, so a file publishing both
 *   would resolve to the modern column rather than to whichever sits left.
 *
 * The futures-equivalent predicate keys on "portfolio", not on "futures": the
 * modern label is `Portfolio-wise Futures Equivalent …` and the old one is
 * `Delta Equivalent … Portfolio wise`, and "portfolio" is the only token both
 * share. It is also exactly what separates the right old column from the wrong
 * one — the contract-wise sibling matches "equivalent" too, and mapping it here
 * is the silent corruption the module header measures against.
 */
function resolveColumns(headerCells: string[]): ColumnMap | null {
  const keys = headerCells.map(normalizeHeader);
  const find = (pred: (k: string) => boolean): number => keys.findIndex(pred);

  const date = find((k) => k === "date");
  const symbol = find((k) => k === "symbol");
  const isin = find((k) => k === "isin");
  const name = find((k) => k === "scripname" || k.startsWith("scrip"));

  // 6-column era: `Notional Open Interest` / `NotionalOpen Interest`.
  // 7-column era: a bare `Open Interest`.
  const modernNotional = find(
    (k) => k.includes("notional") && k.includes("openinterest"),
  );
  const notionalOi =
    modernNotional !== -1 ? modernNotional : find((k) => k === "openinterest");

  // 6-column era: `Portfolio-wise Futures Equivalent Open Interest`.
  // 7-column era: `Delta Equivalent Open Interest Portfolio wise`.
  const futEquivOi = find(
    (k) => k.includes("equivalent") && k.includes("portfolio"),
  );

  // 7-column era only. Optional — absence is the modern layout, not a fault.
  const contractDeltaOi = find(
    (k) => k.includes("equivalent") && k.includes("contract"),
  );

  if (date === -1 || symbol === -1) return null;
  if (notionalOi === -1 || futEquivOi === -1) return null;
  return {
    date,
    symbol,
    isin,
    name,
    notionalOi,
    futEquivOi,
    contractDeltaOi,
  };
}

// MONEY-1205 — this was a hand-copy of the (then module-private) splitter in
// `instruments/nse-master-logic.ts`. Both now import the one shared copy.
// No quoted field has ever been observed in THIS feed, but `Scrip Name` is free
// text and one comma inside it would shift every column to its right — the
// field-count check below is what catches the unquoted case.
// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse one archived `combineoi_deleq_{DDMMYYYY}.csv`.
 *
 * @returns `null` when the bytes are not this report at all — empty, header-less,
 * or missing a required column. A non-null result with `rows: []` means the
 * report WAS recognised and carried no legible rows, which is a different fact;
 * the caller must not collapse them.
 */
export function parseCombinedOiDeleq(csv: string): CombinedOiFile | null {
  const lines = String(csv ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  const headerCells = splitCsvLine(lines[0]!);
  const col = resolveColumns(headerCells);
  if (!col) return null;

  const reasons: Record<string, number> = {};
  const bump = (k: string): void => {
    reasons[k] = (reasons[k] ?? 0) + 1;
  };

  const rows: CombinedOiRow[] = [];
  let tradingDate: Date | null = null;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);

    // Extra cells mean an unquoted comma inside `Scrip Name`, which has already
    // shifted every column to its right. There is nothing to recover.
    if (cells.length !== headerCells.length) {
      bump("field-count");
      continue;
    }

    const symbol = String(cells[col.symbol] ?? "")
      .trim()
      .toUpperCase();
    if (!symbol) {
      bump("no-symbol");
      continue;
    }

    const date = parseMwplDate(cells[col.date]);
    if (!date) {
      bump("bad-date");
      continue;
    }

    const notionalOi = num(cells[col.notionalOi]);
    const futEquivOi = num(cells[col.futEquivOi]);
    // A row with neither measure states nothing. Dropped, and counted — the
    // silent version of this is how a whole column can go missing unnoticed.
    if (notionalOi === null && futEquivOi === null) {
      bump("no-open-interest");
      continue;
    }

    const isin = col.isin === -1 ? null : text(cells[col.isin]);
    const name = col.name === -1 ? null : text(cells[col.name]);
    // Absent on the whole 6-column era, which is a layout fact and not a drop —
    // so it is NOT counted in `reasons`, and it deliberately takes no part in
    // the "states nothing" test above: a row carrying only a contract-wise
    // number would still write two nulls into `MwplDaily`.
    const contractDeltaOi =
      col.contractDeltaOi === -1 ? null : num(cells[col.contractDeltaOi]);

    if (tradingDate === null) tradingDate = date;
    else if (tradingDate.getTime() !== date.getTime()) bump("mixed-date");

    rows.push({
      symbol,
      isin,
      name,
      date,
      notionalOi,
      futEquivOi,
      contractDeltaOi,
      // NSE prints `NA` in BOTH identity columns for an index underlying.
      // Keyed on the ISIN alone would also be true of a stock whose ISIN cell
      // was merely blank, which is a different thing.
      isIndex: isin === null && name === null,
    });
  }

  return { tradingDate, rows, reasons };
}

/**
 * A parsed row as the exact `MwplDaily` upsert payload.
 *
 * `mwpl` and `utilisationPct` are hard-coded `null` and typed as `null`. See
 * {@link MwplDailyWrite} and the module header for why that is the design and
 * not a placeholder.
 *
 * `name`, `isIndex` and `contractDeltaOi` have no column on the model and are
 * intentionally dropped here — `isIndex` is recoverable from `isin === null`.
 * `contractDeltaOi` is not recoverable from anything, and that is accepted: it
 * exists on {@link CombinedOiRow} so the 7-column era is READ completely and the
 * numerator question stays open (module header), not so that it can be stored.
 */
export function toMwplDailyWrite(
  row: CombinedOiRow,
  source: string = MWPL_SOURCE,
): MwplDailyWrite {
  return {
    symbol: row.symbol,
    isin: row.isin,
    date: row.date,
    notionalOi: row.notionalOi,
    futEquivOi: row.futEquivOi,
    mwpl: null,
    utilisationPct: null,
    source,
  };
}
