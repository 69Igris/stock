/**
 * Legacy (pre-UDiFF) NSE bhavcopy parsers — MONEY-941 (Data Engine P3 step 4).
 *
 * NSE published a different CSV for cash and derivatives before the SEBI UDiFF
 * cutover on 2024-07-08. Those files are the ONLY route to equity history back
 * to 1994 and F&O history back to 2000, so the backfill archives them and this
 * module turns them into the same normalized shapes the modern parsers produce.
 *
 * ## The ISIN column does not exist for the first four years
 *
 * The cash format is
 *
 *   SYMBOL, SERIES, OPEN, HIGH, LOW, CLOSE, LAST, PREVCLOSE,
 *   TOTTRDQTY, TOTTRDVAL, TIMESTAMP, TOTALTRADES, ISIN
 *
 * but `ISIN` only appears from roughly mid-1998. Rows before that carry no ISIN
 * at all, which matters because ISIN is the PRIMARY join key to
 * `InstrumentMapping` — MONEY-1085 exists because that key was never populated.
 * So `isin` is `null` for early rows and the consumer must fall back to
 * symbol@exchange, accepting that a symbol reused by a different company since
 * 1995 cannot be disambiguated. That is a real limitation of the source, not
 * something a parser can fix, and it is better stated than silently papered
 * over with a wrong ISIN.
 *
 * ## Never mint instruments from a price file
 *
 * These parsers deliberately return rows, not instruments. MONEY-1085's rule is
 * that unmatched rows are DROPPED with a counter rather than used to create
 * `InstrumentMapping` records: a price file has no ISIN for early years, no
 * company name, and no exchange metadata, so minting from it produces
 * instruments that later collide with the real master and are impossible to
 * reconcile.
 */

import Papa from "papaparse";
import type { BhavcopyRow } from "./bhavcopy";

// ─── Shared helpers ──────────────────────────────────────────────────

/** UTC midnight of the IST calendar day — the DailyPrice date convention. */
function tradingDateUtcMidnight(date: Date): Date {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
}

/**
 * A finite number, or null.
 *
 * These files are 30 years old and carry blanks, `-`, and occasional `NA` in
 * numeric columns. `Number("")` is 0 and `Number("-")` is NaN, and both would
 * poison a price series — a 0 close is indistinguishable from a real crash and
 * a NaN propagates through every downstream average. This repo has been bitten
 * by exactly that (the non-finite money hardening), so parsing is explicit.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s || s === "-" || s.toUpperCase() === "NA") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Equity-ish cash series. Mirrors the modern parser's filter. */
const CASH_SERIES = new Set(["EQ", "BE", "BZ", "SM", "ST", "IV", "RR"]);

// ─── Cash (old `cm{DDMMMYYYY}bhav.csv`) ──────────────────────────────

export interface LegacyParseResult {
  rows: BhavcopyRow[];
  /** Per-series tally of rows rejected by the series filter (MONEY-1085). */
  droppedBySeries: Record<string, number>;
  /** Rows with no ISIN — pre-~1998 files. They resolve by symbol only. */
  withoutIsin: number;
}

/**
 * Parse a legacy NSE cash bhavcopy into the same rows the UDiFF parser emits.
 *
 * Returning the SAME `BhavcopyRow` shape is deliberate: the backfill's writer
 * can then reuse the existing instrument-resolution and upsert path unchanged,
 * so historical rows land under exactly the same rules as nightly ones rather
 * than through a second, subtly different code path.
 */
export function parseOldNseCmBhavcopy(
  csv: string,
  date: Date,
): LegacyParseResult {
  const parsed = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toUpperCase(),
  });

  const tradingDate = tradingDateUtcMidnight(date);
  const rows: BhavcopyRow[] = [];
  const droppedBySeries: Record<string, number> = {};
  let withoutIsin = 0;

  for (const rec of parsed.data) {
    if (!rec || typeof rec !== "object") continue;

    const symbol = String(rec.SYMBOL ?? "").trim();
    if (!symbol) continue;

    const series = String(rec.SERIES ?? "")
      .trim()
      .toUpperCase();
    if (!CASH_SERIES.has(series)) {
      droppedBySeries[series || "(blank)"] =
        (droppedBySeries[series || "(blank)"] ?? 0) + 1;
      continue;
    }

    const close = num(rec.CLOSE);
    // A row without a usable close is not a price. Dropping beats writing a
    // zero that later reads as a 100% crash.
    if (close === null) continue;

    const open = num(rec.OPEN);
    const high = num(rec.HIGH);
    const low = num(rec.LOW);

    // ISIN is absent before ~mid-1998. Empty string must become null, not "",
    // or the ISIN join would match every early row against each other.
    const rawIsin = String(rec.ISIN ?? "").trim();
    const isin = rawIsin.length > 0 ? rawIsin : null;
    if (!isin) withoutIsin++;

    rows.push({
      isin,
      symbol,
      exchange: "NSE",
      open: open ?? close,
      high: high ?? close,
      low: low ?? close,
      close,
      prevClose: num(rec.PREVCLOSE),
      volume: num(rec.TOTTRDQTY) ?? 0,
      series,
      name: symbol,
      date: tradingDate,
    });
  }

  return { rows, droppedBySeries, withoutIsin };
}

// ─── Derivatives (old `fo{DDMMMYYYY}bhav.csv`) ───────────────────────

/** One EOD derivatives contract bar, matching the `DerivativeEOD` model. */
export interface LegacyDerivativeRow {
  symbol: string;
  exchange: "NSE";
  /** FUTIDX | FUTSTK | OPTIDX | OPTSTK */
  instrument: string;
  expiry: Date;
  strike: number;
  /** CE | PE | XX (future) */
  optionType: string;
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  settle: number | null;
  volume: number;
  openInt: number;
  oiChange: number;
  valueLakh: number | null;
}

/**
 * `Date.UTC` for a calendar date, rejecting anything that ROLLS OVER.
 *
 * `Date.UTC(2023, 1, 29)` is a perfectly valid 2023-03-01, so a `NaN` check
 * accepts 29-FEB-2023 and books the contract two days late; `32-JAN` becomes
 * 01-FEB the same way. For a derivatives expiry that is not a cosmetic error —
 * expiry is part of the contract's identity and its compound unique key, so a
 * rolled-over date silently creates a DIFFERENT contract that will never match
 * the real one.
 *
 * Round-tripping the components back out is the only check that catches it.
 * Shared with `bhavcopy-derivatives.ts` so both era parsers reject identically.
 */
export function strictUtcDate(
  y: number,
  month1: number,
  day: number,
): Date | null {
  const d = new Date(Date.UTC(y, month1 - 1, day));
  if (
    d.getUTCFullYear() !== y ||
    d.getUTCMonth() !== month1 - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

/** `DD-MMM-YYYY` (e.g. `29-JUN-2000`), the legacy expiry format. */
const MONTHS: Record<string, number> = {
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

export function parseLegacyExpiry(raw: unknown): Date | null {
  const s = String(raw ?? "")
    .trim()
    .toUpperCase();
  // `DD-MMM-YY` too — MONEY-1618. NSE regenerated fo14MAY2012bhav ("*Updated",
  // CRLF) with 2-digit years (`31-May-12`), so every row lost its expiry and
  // the session vanished. NSE F&O began June 2000: a 2-digit year is 20yy.
  const m = /^(\d{1,2})-([A-Z]{3})-(\d{4}|\d{2})$/.exec(s);
  if (!m) return null;
  const month = MONTHS[m[2]!];
  if (month === undefined) return null;
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return strictUtcDate(year, month + 1, Number(m[1]));
}

/**
 * Parse a legacy NSE F&O bhavcopy.
 *
 * Header: INSTRUMENT, SYMBOL, EXPIRY_DT, STRIKE_PR, OPTION_TYP, OPEN, HIGH,
 * LOW, CLOSE, SETTLE_PR, CONTRACTS, VAL_INLAKH, OPEN_INT, CHG_IN_OI, TIMESTAMP.
 *
 * Futures rows carry `STRIKE_PR` 0 and `OPTION_TYP` "XX", which is preserved
 * verbatim rather than normalised to null — the `DerivativeEOD` compound unique
 * includes both columns, and MongoDB treats nulls as distinct, so nulls would
 * let duplicate futures rows through.
 */
export function parseOldNseFoBhavcopy(
  csv: string,
  date: Date,
): { rows: LegacyDerivativeRow[]; skipped: number } {
  const parsed = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toUpperCase(),
  });

  const tradingDate = tradingDateUtcMidnight(date);
  const rows: LegacyDerivativeRow[] = [];
  let skipped = 0;

  for (const rec of parsed.data) {
    if (!rec || typeof rec !== "object") continue;

    const symbol = String(rec.SYMBOL ?? "").trim();
    const instrument = String(rec.INSTRUMENT ?? "")
      .trim()
      .toUpperCase();
    const expiry = parseLegacyExpiry(rec.EXPIRY_DT);
    const close = num(rec.CLOSE);

    // Every one of these is part of the contract's identity or its only price.
    // A row missing any of them cannot be keyed or used, so it is skipped and
    // counted rather than written with a placeholder.
    if (!symbol || !instrument || !expiry || close === null) {
      skipped++;
      continue;
    }

    const open = num(rec.OPEN);
    const high = num(rec.HIGH);
    const low = num(rec.LOW);

    rows.push({
      symbol,
      exchange: "NSE",
      instrument,
      expiry,
      strike: num(rec.STRIKE_PR) ?? 0,
      optionType:
        String(rec.OPTION_TYP ?? "")
          .trim()
          .toUpperCase() || "XX",
      date: tradingDate,
      open: open ?? close,
      high: high ?? close,
      low: low ?? close,
      close,
      settle: num(rec.SETTLE_PR),
      volume: num(rec.CONTRACTS) ?? 0,
      openInt: num(rec.OPEN_INT) ?? 0,
      oiChange: num(rec.CHG_IN_OI) ?? 0,
      valueLakh: num(rec.VAL_INLAKH),
    });
  }

  return { rows, skipped };
}
