/**
 * Legacy (pre-UDiFF) BSE cash bhavcopy parsers — MONEY-1101 (Data Engine P7).
 *
 * BSE's cash history before the SEBI UDiFF cutover lives in two DIFFERENT zip
 * families that overlap in time and disagree on columns. Both were live-probed
 * on **2026-08-13**; every claim below is an observed response, not a guess.
 *
 * ```
 *   eq{DDMMYY}_csv.zip          14 cols, NO ISIN    2006-04-03 … 2024-07-01 ✓
 *   EQ_ISINCODE_{DDMMYY}.zip    18 cols, WITH ISIN  2017-01-03 … 2024-07-01 ✓
 * ```
 *
 * ## What "verified" means here, and the trap it avoids
 *
 * BSE does NOT 404 an absent file. It answers **200 with its Angular SPA
 * catch-all page** (a constant 13,850 bytes beginning `<!DOCTYPE html>`). That
 * is why P2's header records the pre-UDiFF era as INDETERMINATE rather than
 * absent: the P1 probe sorted HTML into neither the present nor the absent
 * bucket and published "NOT AVAILABLE", which was never established.
 *
 * It is available. The probe that settles it:
 *
 * ```
 *   EQ_ISINCODE_150323.zip  -> 200, 155,493 bytes, application/x-zip-compressed
 *                              inner EQ_ISINCODE_150323.CSV, 3,929 rows
 *   eq020107_csv.zip        -> 200, 219,745 bytes uncompressed, 2,655 rows
 * ```
 *
 * Both eras are ZIPs, so `validateFeedPayload`'s generic `.zip` rule already
 * rejects the SPA page on the `PK\x03\x04` magic — the HTML can never be
 * archived AS a bhavcopy. The explicit `BSE/cm-legacy` + `BSE/cm-isin-legacy`
 * shapes in feed-payload.ts pin that rather than leaving it to the fallback.
 *
 * ## Observed era boundaries (probe log, 2026-08-13)
 *
 * ```
 *   family          PRESENT (zip)                    ABSENT (SPA html)
 *   eq_csv          2006-04-03 2006-07-03 2007-01-02 2006-01-02
 *                   2015-01-02 2024-07-01            2024-12-02 2025-02-01 2025-07-01
 *   EQ_ISINCODE     2017-01-03 2017-07-03 2018-01-02 2016-09-01 2016-10-03 2016-12-01
 *                   2019-02-01 2020-02-01 2023-03-15 2024-09-02 2024-10-01 2024-12-01
 *                   2024-02-01 2024-04-01 2024-07-01 2025-07-01 2026-01-02
 * ```
 *
 * Neither floor is pinned to the day — the walk's own floor explorer
 * (`--explore` in feed-backfill.ts) is what closes that, exactly as it did for
 * the NSE legacy families. The registry therefore declares the LOWEST PROBED
 * PRESENT date and marks `startDateProvenance: "probed"`, so the declared floor
 * is a fact rather than an assumption; an in-range miss is a GAP, never
 * end-of-history, so a slightly-high floor costs a re-walk and never data.
 *
 * ## THREE header variants, not two — the reason detection is by NAME
 *
 * The ISIN era changes columns MID-ERA. Observed verbatim:
 *
 * ```
 *   2017-01-03  …,TDCLOINDI,ISIN_CODE,FILLER1,FILLER2,FILLER3
 *   2017-07-03  …,TDCLOINDI,ISIN_CODE,TRADING_DATE,FILLER2,FILLER3
 * ```
 *
 * Column 16 is `FILLER1` in January and `TRADING_DATE` in July of the SAME
 * year. A positional parser calibrated on either one silently mis-reads the
 * other, and a parser that hard-required `TRADING_DATE` would return zero rows
 * for every early-2017 file — the exact "silent zero-row parse" this module is
 * built to make impossible. So nothing here is positional: every field is read
 * by header name, and `TRADING_DATE` is OPTIONAL.
 *
 * ## Unrecognised shape ⇒ `null`, never `[]`
 *
 * `parseOldBseCmBhavcopy` returns **null** when the header is not one it knows,
 * and a result object (possibly with `rows: []`) when it is. The two are
 * different values on purpose. MONEY-1189 lost 37 windows because a failure and
 * an empty success were both `[]`, and a run reported `DONE … emptyChunks=0`
 * while data was missing. Here the caller MUST branch: a `null` is counted as
 * `unrecognisedFormat` and deliberately left un-checkpointed so the next run
 * retries it, while a real empty file checkpoints `ZERO` (already non-terminal).
 *
 * ## Identity: the scrip code, because there is no ticker
 *
 * These files carry `SC_CODE` (BSE's numeric scrip code) and `SC_NAME` (a
 * space-padded, truncated company name) — and **no ticker symbol at all**. The
 * modern UDiFF file's `TckrSymb` has no counterpart here. So:
 *
 *   - `scripCode` is the row's real identity and is carried explicitly.
 *   - `symbol` is set to the scrip code. That is not a fudge: BSE scrip codes
 *     are globally unique per scrip, and the BSE scrip master already supplies
 *     numeric `scrip_id`s for part of the universe, so a symbol@BSE hit on a
 *     scrip code is a CORRECT resolution and simply gives the writer a second
 *     route when the ISIN join misses.
 *   - `name` is the trimmed `SC_NAME`, for display/audit only — never a join
 *     key. Joining prices by company name across 18 years of renames is how you
 *     silently attach one company's history to another.
 *
 * Pre-2017 rows have no ISIN, so the writer resolves them scrip-code → ISIN
 * through the BSE scrip master (`loadScripToIsin` in feed-parse.ts, already
 * built for the SCBSEALL delivery leg). Unresolved rows are DROPPED and
 * COUNTED — never used to mint an `InstrumentMapping` (MONEY-1085's rule).
 *
 * ## `SC_GROUP` becomes `series`, and that is what types the instrument
 *
 * The modern BSE UDiFF parser puts `SctySrs` (the group letter) into `series`,
 * and `classifyCashInstrument` reads exactly that to decide EQUITY vs DEBT
 * (MONEY-1093). `SC_GROUP` is the same vocabulary — measured on the 2023-03-15
 * file: A(708) B(1167) X(1170) XT(322) F(234) M(105) T(69) Z(66) G(33) E(18)
 * P(13) MT(11) IF(6) MS(3) R(2) ZP(1). F and G are the corporate-debt and
 * G-sec groups the ticket calls out. Carrying the group through UNFILTERED is
 * therefore what makes these rows classify identically to the daily leg — and
 * it is why this parser does NOT drop debt: a bond has a real close, pricing it
 * is intentional, and the group letter is what tells the classifier so.
 */

import Papa from "papaparse";
import type { BhavcopyRow } from "./bhavcopy";

// ─── Row + result shapes ─────────────────────────────────────────────

/**
 * A legacy BSE cash bar. Extends the shared {@link BhavcopyRow} so the existing
 * `writeCash` path — instrument resolution, `repairCandle`, and the MONEY-1175
 * source-precedence partition — is reused verbatim rather than re-implemented
 * for history. `scripCode` is the addition: it is this era's only real
 * identity, and the writer needs it for the scrip-master ISIN join.
 */
export interface BseLegacyCashRow extends BhavcopyRow {
  /** BSE numeric scrip code, e.g. "500002". The row's true identity. */
  scripCode: string;
}

/** Which header layout a file turned out to be. */
export type BseLegacyVariant =
  /** 14 cols, no ISIN — `eq{DDMMYY}_csv.zip`, 2006 → 2024. */
  | "plain"
  /** 18 cols incl. ISIN_CODE, col 16 `FILLER1` — early 2017. */
  | "isin-filler"
  /** 18 cols incl. ISIN_CODE + TRADING_DATE — mid-2017 → 2024. */
  | "isin-dated";

export interface BseLegacyParseResult {
  rows: BseLegacyCashRow[];
  /** Which header layout was detected. Logged so era drift is visible. */
  variant: BseLegacyVariant;
  /** Per-group tally of rows dropped for an unusable close. */
  droppedByGroup: Record<string, number>;
  /** Rows with no ISIN — the whole `plain` era. They resolve by scrip code. */
  withoutIsin: number;
  /** Rows missing identity (SC_CODE) or a usable close. */
  skipped: number;
  /**
   * Rows whose own `TRADING_DATE` disagrees with the date the archive key
   * claims. Counted, and the rows are EXCLUDED — the file is the authority on
   * its columns, the KEY is the authority on which day we asked for (the same
   * rule `parseSecBhavdataFull` applies). Always 0 for variants that publish no
   * date column, which is why it is a counter and not an assertion.
   */
  dateMismatch: number;
}

// ─── Header detection ────────────────────────────────────────────────

/**
 * Columns EVERY variant must have for a row to be a price at all.
 *
 * Deliberately the minimum the parser dereferences, not the full 14 — the check
 * must never be stricter than the code it guards, or it rejects files the parse
 * would have handled (the same calibration rule as feed-payload.ts). `LAST`,
 * `NO_TRADES`, `NET_TURNOV` and `TDCLOINDI` are read opportunistically and are
 * absent from this list on purpose.
 */
const REQUIRED_COLUMNS = [
  "SC_CODE",
  "SC_GROUP",
  "OPEN",
  "HIGH",
  "LOW",
  "CLOSE",
  "NO_OF_SHRS",
] as const;

/**
 * Classify a header into a known variant, or null if it is not a BSE legacy
 * cash bhavcopy at all.
 *
 * Name-based and order-independent: BSE moved column 16 between `FILLER1` and
 * `TRADING_DATE` inside 2017 (see the module header), so position proves
 * nothing. Exported for tests and for the format-drift assertion.
 */
export function detectBseLegacyVariant(
  fields: readonly string[],
): BseLegacyVariant | null {
  const present = new Set(fields.map((f) => f.trim().toUpperCase()));
  for (const col of REQUIRED_COLUMNS) {
    if (!present.has(col)) return null;
  }
  if (!present.has("ISIN_CODE")) return "plain";
  return present.has("TRADING_DATE") ? "isin-dated" : "isin-filler";
}

// ─── Cell helpers ────────────────────────────────────────────────────

/**
 * A finite number, or null.
 *
 * These files span 2006→2024 and carry blanks and `-` in numeric columns.
 * `Number("")` is 0 and `Number("-")` is NaN; a 0 close is indistinguishable
 * from a real 100% crash and a NaN propagates through every downstream average.
 * Guarding at the parse boundary is this repo's standing rule for money.
 */
function num(value: unknown): number | null {
  const s = String(value ?? "").trim();
  if (!s || s === "-" || s.toUpperCase() === "NA") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Trim a cell — every text column in these files is space-padded. */
function text(value: unknown): string {
  return String(value ?? "").trim();
}

/** UTC midnight of the IST calendar day — the DailyPrice date convention. */
function tradingDateUtcMidnight(date: Date): Date {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
}

const MONTHS: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

/**
 * `DD-Mon-YY` (e.g. `15-Mar-23`) → UTC midnight, or null.
 *
 * TWO-digit year, so the century has to be chosen. The era this parser serves
 * is 2006→2024 and BSE published nothing here before 2006, so `YY` always means
 * `20YY`; the `< 70` pivot is the conventional guard and is unreachable in
 * practice. Rollover is rejected the same way the expiry parsers do it —
 * `Date.UTC(2023, 1, 29)` is a silently valid 2023-03-01, so only round-tripping
 * the components back out catches an impossible date.
 */
export function parseBseLegacyTradingDate(raw: unknown): Date | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const month = MONTHS[m[2]!.toUpperCase()];
  if (!month) return null;
  const day = Number(m[1]);
  const yy = Number(m[3]);
  const year = yy < 70 ? 2000 + yy : 1900 + yy;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
    ? d
    : null;
}

// ─── Parser ──────────────────────────────────────────────────────────

/**
 * Parse a legacy BSE cash bhavcopy into the shared `BhavcopyRow` shape.
 *
 * Returns **null** when the header is not a recognised BSE legacy layout. That
 * is the loud path: the caller counts it and does NOT checkpoint the file, so a
 * new/unknown BSE format surfaces as a retried, counted failure instead of a
 * day that silently parsed to nothing and was recorded DONE forever.
 *
 * `date` is the trading day the ARCHIVE KEY claims. Row dates are always
 * derived from it, never from the file, so the value is a clean UTC midnight
 * regardless of which variant produced the bytes — and it stays consistent with
 * every other family. `TRADING_DATE`, when the variant has it, is used only to
 * CROSS-CHECK; a row that disagrees is excluded and counted.
 */
export function parseOldBseCmBhavcopy(
  csv: string,
  date: Date,
): BseLegacyParseResult | null {
  const parsed = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toUpperCase(),
  });

  const variant = detectBseLegacyVariant(parsed.meta.fields ?? []);
  // Unrecognised shape. Distinct from "recognised but no rows" — see the module
  // header. Never fall through to a zero-row result.
  if (!variant) return null;

  const tradingDate = tradingDateUtcMidnight(date);
  const expectedIso = tradingDate.toISOString().slice(0, 10);

  const rows: BseLegacyCashRow[] = [];
  const droppedByGroup: Record<string, number> = {};
  let withoutIsin = 0;
  let skipped = 0;
  let dateMismatch = 0;

  for (const rec of parsed.data) {
    if (!rec || typeof rec !== "object") continue;

    const scripCode = text(rec.SC_CODE);
    // No identity, no row. The scrip code is the ONLY join key this era has.
    if (!scripCode) {
      skipped++;
      continue;
    }

    const group = text(rec.SC_GROUP).toUpperCase();

    const close = num(rec.CLOSE);
    if (close === null) {
      // Counted BY GROUP so a whole segment going unpriced is visible. A
      // suspended scrip legitimately has no close; 200 F-group rows losing
      // theirs at once would be a parser bug, and the two must be tellable
      // apart from the log line alone.
      droppedByGroup[group || "(blank)"] =
        (droppedByGroup[group || "(blank)"] ?? 0) + 1;
      skipped++;
      continue;
    }

    // Cross-check only, and only where the column exists. The archive key —
    // not the file — decides which day these rows belong to.
    if (variant === "isin-dated") {
      const own = parseBseLegacyTradingDate(rec.TRADING_DATE);
      if (own && own.toISOString().slice(0, 10) !== expectedIso) {
        dateMismatch++;
        continue;
      }
    }

    // Empty string must become null, or the ISIN join would match every
    // pre-2017 row against every other one.
    const isin = text(rec.ISIN_CODE).toUpperCase() || null;
    if (!isin) withoutIsin++;

    const open = num(rec.OPEN);
    const high = num(rec.HIGH);
    const low = num(rec.LOW);

    rows.push({
      isin,
      scripCode,
      // See the module header: no ticker exists in this era, and a scrip code
      // is a globally unique BSE identity, so this is a real second join route
      // rather than a placeholder.
      symbol: scripCode,
      exchange: "BSE",
      // A missing leg falls back to the close, matching every other parser
      // here: a bar drawn flat at its close is honest about a thin session,
      // whereas a 0 leg is a fabricated 100% wick.
      open: open ?? close,
      high: high ?? close,
      low: low ?? close,
      close,
      prevClose: num(rec.PREVCLOSE),
      volume: num(rec.NO_OF_SHRS) ?? 0,
      // The group letter, carried through unfiltered — this is what
      // `classifyCashInstrument` reads to type EQUITY vs DEBT (MONEY-1093).
      series: group,
      name: text(rec.SC_NAME),
      date: tradingDate,
    });
  }

  return { rows, variant, droppedByGroup, withoutIsin, skipped, dateMismatch };
}
