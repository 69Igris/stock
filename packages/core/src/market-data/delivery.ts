/**
 * Delivery-data parsers — MONEY-1100 (Data Engine P4.1).
 *
 * Two sources, one purpose: how much of a day's traded volume was actually
 * DELIVERED (took ownership) versus intraday churn. Delivery % history is the
 * accumulation/distribution signal — the single highest-value field the engine
 * fetches today and discards.
 *
 *   NSE  `sec_bhavdata_full_{DDMMYYYY}.csv`   (~Oct-2019 →)
 *   BSE  `SCBSEALL{DDMM}.zip` → inner .TXT    (2007 →)
 *
 * Both layouts were verified against REPAIRED archived files on 10-Aug-2026
 * (docs/reference/per-file-derivable-map.md, "archived file wins" rule):
 * fixtures under __tests__/fixtures/ are cut from those exact files.
 *
 * ## The `-` decision (recorded per the map's instruction)
 *
 * NSE prints `-` for DELIV_QTY / DELIV_PER on trade-for-trade series (BE/BZ),
 * where delivery is 100% BY CONSTRUCTION — every trade settles with delivery.
 * We store **null**, not 100 and not 0:
 *
 *   - 0 would be actively wrong (it means "no delivery", the opposite).
 *   - 100 would fabricate a reported number that NSE deliberately does not
 *     report, making synthetic values indistinguishable from measured ones
 *     downstream. A screen for "delivery% > 90 sustained" must not be fed by
 *     rows we invented.
 *
 * Consumers that want the by-construction semantics can coalesce
 * `deliveryPct ?? (series in T2T ? 100 : null)` explicitly, with the decision
 * visible at the point of use.
 *
 * Pure functions: no network, no Prisma. The writer joins symbols/scrip codes
 * to InstrumentMapping and DROPS unresolved rows with counters — never mints
 * instruments from price files (MONEY-1085 rule).
 */

import Papa from "papaparse";

// ─── NSE sec_bhavdata_full ───────────────────────────────────────────

export interface DeliveryRow {
  symbol: string;
  series: string;
  /** Trading date parsed from the row's own DATE1, UTC midnight. */
  date: Date;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  last: number | null;
  close: number;
  /** True session VWAP as reported (AVG_PRICE), not derived. */
  avgPrice: number | null;
  volume: number;
  /** TURNOVER_LACS converted to rupees. */
  turnover: number | null;
  trades: number | null;
  /** null = not reported (`-`), NOT zero. See module doc. */
  deliveryQty: number | null;
  deliveryPct: number | null;
}

export interface DeliveryParseResult {
  rows: DeliveryRow[];
  /** Rows dropped for missing identity/close, or a DATE1 that failed to parse. */
  skipped: number;
  /** Rows whose DATE1 disagrees with the file's expected date (kept out). */
  dateMismatch: number;
  /**
   * The distinct DATE1 values (`YYYY-MM-DD`, sorted) of those rows. MONEY-1612:
   * a count cannot tell a stale copy of the PREVIOUS session from the only
   * copy of a weekend session filed under the next weekday's key.
   */
  mismatchedDates: string[];
}

const RUPEES_PER_LAKH = 100_000;

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

/** `DD-MMM-YYYY` (e.g. `07-Aug-2026`) → UTC midnight, rollover-rejecting. */
export function parseDeliveryDate(raw: unknown): Date | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const month = MONTHS[m[2]!.toUpperCase()];
  if (!month) return null;
  const day = Number(m[1]);
  const year = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  // Reject rollover (31-FEB etc.) — the same trap both expiry parsers had.
  return d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
    ? d
    : null;
}

/**
 * `-` and blanks are ABSENCE, never a value. Space padding is universal in
 * this file (even the header), so everything trims first.
 */
function num(value: unknown): number | null {
  const s = String(value ?? "").trim();
  if (!s || s === "-" || s.toUpperCase() === "NA") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse one day's `sec_bhavdata_full` CSV.
 *
 * `expectedDate` is the date the archive key claims; a row whose own DATE1
 * disagrees is counted in `dateMismatch` and excluded rather than stored under
 * the wrong day — the file is the authority on its columns, but the KEY is the
 * authority on which day we asked for.
 */
export function parseSecBhavdataFull(
  csv: string,
  expectedDate: Date,
): DeliveryParseResult {
  const parsed = Papa.parse<Record<string, unknown>>(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const expectedIso = expectedDate.toISOString().slice(0, 10);
  const rows: DeliveryRow[] = [];
  let skipped = 0;
  let dateMismatch = 0;
  const mismatched = new Set<string>();

  for (const rec of parsed.data) {
    if (!rec || typeof rec !== "object") continue;

    const symbol = String(rec.SYMBOL ?? "").trim();
    const series = String(rec.SERIES ?? "").trim();
    const date = parseDeliveryDate(rec.DATE1);
    const close = num(rec.CLOSE_PRICE);

    // Identity + the one mandatory price. A row missing any is unusable.
    if (!symbol || !series || !date || close === null) {
      skipped++;
      continue;
    }
    const iso = date.toISOString().slice(0, 10);
    if (iso !== expectedIso) {
      dateMismatch++;
      mismatched.add(iso);
      continue;
    }

    const turnoverLakh = num(rec.TURNOVER_LACS);

    rows.push({
      symbol,
      series,
      date,
      prevClose: num(rec.PREV_CLOSE),
      open: num(rec.OPEN_PRICE),
      high: num(rec.HIGH_PRICE),
      low: num(rec.LOW_PRICE),
      last: num(rec.LAST_PRICE),
      close,
      avgPrice: num(rec.AVG_PRICE),
      volume: num(rec.TTL_TRD_QNTY) ?? 0,
      turnover: turnoverLakh === null ? null : turnoverLakh * RUPEES_PER_LAKH,
      trades: num(rec.NO_OF_TRADES),
      deliveryQty: num(rec.DELIV_QTY),
      deliveryPct: num(rec.DELIV_PER),
    });
  }

  return {
    rows,
    skipped,
    dateMismatch,
    mismatchedDates: [...mismatched].sort(),
  };
}

// ─── BSE SCBSEALL gross delivery ─────────────────────────────────────

export interface BseDeliveryRow {
  /** BSE numeric scrip code — join via InstrumentMapping/scrip master, never by name. */
  scripCode: string;
  date: Date;
  deliveryQty: number;
  /** Rupees. */
  deliveryVal: number;
  volume: number;
  /** Rupees. */
  turnover: number;
  deliveryPct: number | null;
}

export interface BseDeliveryParseResult {
  rows: BseDeliveryRow[];
  skipped: number;
  dateMismatch: number;
}

/**
 * Parse the pipe-delimited inner .TXT of `SCBSEALL{DDMM}.zip`.
 *
 * Verified layout (10-Aug-2026, live file):
 *   DATE|SCRIP CODE|DELIVERY QTY|DELIVERY VAL|DAY'S VOLUME|DAY'S TURNOVER|DELV. PER.
 * Numerics are zero-padded fixed-width; there is NO scrip-name column.
 */
export function parseScbseallGrossDelivery(
  text: string,
  expectedDate: Date,
): BseDeliveryParseResult {
  const rows: BseDeliveryRow[] = [];
  let skipped = 0;
  let dateMismatch = 0;

  const y = expectedDate.getUTCFullYear();
  const mo = String(expectedDate.getUTCMonth() + 1).padStart(2, "0");
  const da = String(expectedDate.getUTCDate()).padStart(2, "0");
  const expectedDdmmyyyy = `${da}${mo}${y}`;

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("DATE|")) continue; // header / blanks

    const parts = t.split("|");
    if (parts.length !== 7) {
      skipped++;
      continue;
    }

    const [date, scripCode, delQty, delVal, vol, turnover, delPer] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    if (date.trim() !== expectedDdmmyyyy) {
      dateMismatch++;
      continue;
    }

    // Number() strips the zero padding; anything non-numeric is a bad row.
    const q = Number(delQty);
    const v = Number(vol);
    if (!scripCode.trim() || !Number.isFinite(q) || !Number.isFinite(v)) {
      skipped++;
      continue;
    }

    const pct = Number(delPer);
    rows.push({
      scripCode: scripCode.trim(),
      date: new Date(Date.UTC(y, expectedDate.getUTCMonth(), Number(da))),
      deliveryQty: q,
      deliveryVal: Number(delVal) || 0,
      volume: v,
      turnover: Number(turnover) || 0,
      deliveryPct: Number.isFinite(pct) ? pct : null,
    });
  }

  return { rows, skipped, dateMismatch };
}

// ─── Series collapse (writer helper) ─────────────────────────────────

/**
 * Preference order when several SERIES rows of one symbol resolve to the SAME
 * instrument on the same day. EQ is the primary listing and carries the
 * delivery signal; BE/BZ are the trade-for-trade shadows of the same security
 * during surveillance migrations; SM/ST are the SME board's pair.
 */
const SERIES_PREFERENCE = ["EQ", "BE", "BZ", "SM", "ST"] as const;

/**
 * Collapse per-instrument duplicates by series preference — MONEY-1100 P4.1.
 *
 * Found in production, not imagined: `sec_bhavdata_full` prints one row PER
 * SERIES, and symbol-based resolution maps them all onto one InstrumentMapping.
 * Two payload entries sharing (instrumentId, date) make `createMany` throw on
 * the compound unique, and ONE such symbol costs the WHOLE file — 1,643 of
 * 1,777 files failed exactly this way on the first run.
 *
 * Deterministic: highest preference wins; unknown series rank below all known
 * ones; ties break on series string so a re-run collapses identically.
 */
export function collapseBySeriesPreference<T extends { series: string }>(
  entries: ReadonlyArray<{ instrumentId: string; row: T }>,
): { kept: Array<{ instrumentId: string; row: T }>; collapsed: number } {
  const rank = (s: string): number => {
    const i = (SERIES_PREFERENCE as readonly string[]).indexOf(s);
    return i === -1 ? SERIES_PREFERENCE.length : i;
  };

  const best = new Map<string, { instrumentId: string; row: T }>();
  let collapsed = 0;
  for (const e of entries) {
    const cur = best.get(e.instrumentId);
    if (!cur) {
      best.set(e.instrumentId, e);
      continue;
    }
    collapsed++;
    const a = rank(e.row.series);
    const b = rank(cur.row.series);
    if (a < b || (a === b && e.row.series < cur.row.series)) {
      best.set(e.instrumentId, e);
    }
  }
  return { kept: [...best.values()], collapsed };
}
