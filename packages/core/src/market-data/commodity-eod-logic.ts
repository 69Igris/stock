/**
 * Commodity end-of-day bhavcopies — MCX and NCDEX (MONEY-1112, Data Engine P9 C3).
 *
 * This module is the PURE half: bytes → rows. No fetch, no Prisma, no clock,
 * no `process.env`. Same split as `market-positioning-logic.ts` and
 * `institutional-flows.ts` — the worker keeps the I/O, this keeps every
 * judgement, so all of it is testable against real archived bytes.
 *
 * That split matters more here than usual: **the fetch for both exchanges is
 * currently blocked** (MCX 403s our egress, NCDEX presents a JS fingerprint
 * challenge — a separate, unresolved ticket). The parsers below are therefore
 * built and verified entirely against committed real files:
 *
 *   __tests__/fixtures/mcx/mcx-bhavcopy-{2015-08-13,2020-08-13,2024-08-08,2026-08-11}.csv
 *   __tests__/fixtures/ncdex/ncdex-bhavcopy-2026-08-12-{provisional,final}.zip
 *
 * Eleven years of MCX on purpose: the file's *shape* is stable across all four
 * (byte-identical 15-column header), but its *contents* are not, and the two
 * things that move are the two things a naive parser gets wrong. See the
 * numbered sections below.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * MCX — four things about the real files that a "reasonable" parser gets wrong
 * ═══════════════════════════════════════════════════════════════════════
 *
 * **1. The date format inverts between REQUEST and RESPONSE — but not the way
 * the bug report says.** MCX's download endpoint takes `DD/MM/YYYY`. The claim
 * under investigation was that the response prints `MM/DD/YYYY`, so a
 * round-trip silently transposes day and month. Against the real files that is
 * **refuted**: the response never prints a numeric month at all. Every row of
 * every fixture carries `"DD Mon YYYY"` with an alphabetic month —
 * `"13 Aug 2015"`, `"08 Aug 2024"`, `"11 Aug 2026"` — which is unambiguous by
 * construction and cannot be transposed.
 *
 * The underlying incident is real, though, and it is worth naming precisely
 * because it says where the danger actually lives. The 2026 fixture arrived
 * from MCX's own downloader named **"Bhavcopy Nov 8 2026.csv"** while its
 * every row says `11 Aug 2026`. MCX asked for `11/08/2026` (11 August,
 * `DD/MM`), then formatted its own *request* back into a filename as `MM/DD`
 * → month 11, day 8 → "Nov 8". So the transposition is in the REQUEST→filename
 * path, not in the response body: the CSV was right and the *label on it* was
 * wrong.
 *
 * Two consequences, both encoded here:
 *   - The trading date is read from the ROW, never from a filename or a
 *     caller-supplied date. {@link parseMcxDate} owns it.
 *   - It is parsed with an explicit month-name table, never with
 *     `new Date(string)`. Handing `"11 Aug 2026"` to the Date constructor
 *     works today by accident of V8's lenient fallback parser; that path is
 *     explicitly implementation-defined in the spec, and it is exactly the
 *     class of leniency that produced "Nov 8" in the first place. A lookup
 *     table cannot drift.
 *
 * **2. `Volume(In 000's)` is not in thousands.** The column header is a lie
 * that has survived eleven years. It holds a *lot-adjusted quantity* with its
 * measurement unit appended as text — `"11013.000 KGS  "`, `"157200.000 mmBtu"`,
 * `"0.000 UNIT "`. Multiplying it by 1,000 (which the header instructs you to
 * do) overstates every commodity volume in the system by three orders of
 * magnitude. The 2015 ALUMINI August contract is the clean proof: 11,013 lots
 * and `11013.000 KGS` — the same number, not 11.013 and not 11,013,000.
 *
 * The relationship to `Volume(Lots)` is the contract's lot size and it MOVES:
 * 2015 ALUMINI is 1× (11,013 lots → 11,013), 2020 ALUMINIUM is 5× (2,322 lots
 * → 11,610). So the two columns are genuinely independent readings and both
 * are kept. The field is named {@link McxBhavcopyRow.volumeQuantity} for what
 * it is, with {@link McxBhavcopyRow.volumeUnit} carrying the suffix, and the
 * string "000" appears nowhere near it.
 *
 * The unit vocabulary observed across the four fixtures is KGS, GRMS, BBL,
 * MT, BALES, CANDY, UNIT, MWH and **mmBtu** — note the lowercase leader on the
 * last one. A `[A-Z ]` unit pattern silently fails to match natural-gas rows
 * (it cost this author one scan to notice), which is why
 * {@link parseMcxVolumeCell} splits on whitespace rather than matching a
 * character class.
 *
 * **3. Symbols are space-padded, and the padding hides a real discontinuity.**
 * Every symbol is right-padded into a fixed width — `"ALUMINI      "`,
 * `"ALUMINIUM    "` — so an untrimmed join matches nothing. Trimming is
 * obvious. What is NOT obvious, and what was reported to this module as a
 * cross-year *rename* ("ALUMINI in 2015/2024/2026, ALUMINIUM in 2020"), is
 * that **no rename occurred**. Counted directly out of the fixtures:
 *
 *   2015-08-13   ALUMINI × 5   ALUMINIUM × 5
 *   2020-08-13   ALUMINI × 0   ALUMINIUM × 5     ← ALUMINI simply absent
 *   2024-08-08   ALUMINI × 5   ALUMINIUM × 5
 *   2026-08-11   ALUMINI × 5   ALUMINIUM × 5
 *
 * They are two different contracts that coexist — ALUMINI is the mini,
 * ALUMINIUM the full-size — and on 2020-08-13 the mini was not listed. This
 * distinction is load-bearing. Under the rename theory the correct repair is
 * an alias table folding ALUMINI into ALUMINIUM, which would **merge two live
 * contracts into one series** in the three years where both trade, silently
 * double-counting volume and open interest. Under the truth — a listing gap —
 * the correct repair is nothing at all, plus a caller that tolerates a symbol
 * vanishing for a period.
 *
 * Because "which symbols exist today" is the only signal a caller has for
 * that, {@link McxBhavcopyDay.symbols} surfaces the day's distinct trimmed
 * symbols as a first-class field rather than making every caller re-derive it.
 * Surfacing beats papering over: there is no alias table in this file.
 *
 * **4. An absent trading day is HTTP 200, not 404.** MCX answers a holiday (or
 * a not-yet-published day) with a JSON envelope — `{"IsSuccess":false,
 * "Message":"No data found."}` — served with a 200 and, depending on the
 * endpoint, a CSV content type. A parser that only knows "CSV or bust" turns
 * that into a parse failure, and a caller that retries parse failures will
 * hammer MCX every minute of every Sunday forever.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * Why `null`, `no-data`, and `rows: []` are three different answers
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Callers in this codebase have been burned repeatedly by `[]` standing for
 * both "parsed fine, nothing there" and "could not parse". Here the
 * distinction is a TYPE, not a convention:
 *
 *   `null`                       these bytes are not a bhavcopy at all — an
 *                                HTML error page, a truncated download, a
 *                                renamed column set we cannot map. Do not
 *                                trust anything else about this response.
 *   `{ status: "no-data" }`      the exchange affirmatively said there is no
 *                                data for this day. A holiday. Not an error,
 *                                and NOT worth retrying.
 *   `{ status: "ok", rows: [] }` this IS a bhavcopy and it carried no rows.
 *                                Structurally valid, substantively alarming —
 *                                a real MCX session always has contracts.
 *
 * A caller retries `null`, records `no-data` as a non-trading day, and alerts
 * on an empty `ok`. Collapsing any two of those loses a distinct action.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * Non-finite cells: dropped and counted, never zeroed
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 0 is a claim about the market. A parse failure has no standing to make it,
 * and neither does a blank cell. The rule here is split by whether the cell is
 * part of the row's identity:
 *
 *   IDENTITY (date, symbol, expiry, close) — a row missing or garbling any of
 *   these cannot be keyed or priced, so the ROW IS DROPPED and counted in
 *   {@link McxBhavcopyDay.dropped}. Reported, never silent. The count existing
 *   at all is the point: a day where 40% of rows drop must be visible without
 *   reading logs.
 *
 *   MEASURES (open/high/low, prevClose, volume, value, open interest) — a
 *   blank becomes `null`, never 0 and never a substitute value. This is a
 *   deliberate divergence from the NSE sibling `parseUdiffFoBhavcopy`, which
 *   does `open: open ?? close`. On MCX that substitution would fire on the
 *   MAJORITY of rows — 15,276 of 16,227 rows in the 2026 fixture have blank
 *   O/H/L, because on MCX a blank O/H/L means "this contract did not trade
 *   today" while `Close` still carries the settlement price forward. Filling
 *   them from close would mint a flat OHLC bar, at a real price, for 94% of a
 *   day's contracts — inventing 15,000 trades that never happened. `null` says
 *   "did not trade", which is true.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * NCDEX — byte-identical header, disjoint vocabulary
 * ═══════════════════════════════════════════════════════════════════════
 *
 * NCDEX ships a UDiFF CSV whose header is **byte-for-byte identical** to NSE's
 * F&O UDiFF header — verified, not assumed, and re-verified on every test run
 * by diffing the two committed fixtures (`fo_udiff_day.sample.csv` against the
 * NCDEX archive member). Same 34 columns, same order, same spelling, same
 * md5. All 34, including NSE's four trailing `Rsvd` columns and its
 * idiosyncratic lowercase-i `FininstrmActlXpryDt`, are present. So the COLUMN
 * mapping is 100% shared and duplicating a 34-column parser would be pure
 * waste. {@link UDIFF_COLUMNS} is that shared contract, exported so the
 * identity is machine-checked rather than asserted in a comment.
 *
 * The VOCABULARY inside those identical columns is **completely disjoint**:
 *
 *              NSE F&O                    NCDEX
 *   Sgmt       FO                         CO          (commodity)
 *   Src        NSE                        NCD
 *   FinInstrmTp IDF / IDO / STF / STO     COF / FUO
 *   SctySrs    (blank on F&O)             (always blank)
 *   ISIN       (blank on F&O)             (always blank)
 *
 * The intersection of the two instrument-code sets is EMPTY. That is the whole
 * shim, and its consequence is the dangerous part: `parseUdiffFoBhavcopy` does
 * not throw on an NCDEX file, does not return `null`, and does not warn. Its
 * `UDIFF_INSTRUMENT` lookup misses on `COF` and `FUO`, so it routes **every
 * single row** into `skippedByType` and returns `{ rows: [] }` — a
 * structurally successful parse of zero rows, indistinguishable at the call
 * site from a market holiday. A test in this module's suite pins exactly that
 * behaviour so the shim can never become silent again.
 *
 * Hence: reuse the column contract, do NOT reuse the row mapper.
 * {@link parseNcdexBhavcopy} validates against {@link UDIFF_COLUMNS} and then
 * applies NCDEX's own vocabulary. `FUO` is *options on futures* — the
 * underlying is a futures contract, not the spot commodity — which is why it
 * maps to `OPTFUT` rather than a plain `OPTCOM`, matching the vocabulary MCX
 * already publishes for the same instrument.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * NCDEX revisions: provisional and final are the same day, twice
 * ═══════════════════════════════════════════════════════════════════════
 *
 * NCDEX publishes each trading day TWICE — a provisional file in the evening
 * (fixture: 17:35) and a final one after midnight (fixture: next day 01:06).
 * Both are the same `TradDt`. A pipeline that writes both without
 * distinguishing them either double-writes or, worse, lets the earlier
 * provisional numbers win a race and stick.
 *
 * The marker is IN THE CONTENT, not just the filename: `SsnId` reads `I1` on
 * every provisional row and `F1` on every final row. That is far stronger than
 * the filename's `_P_` / `_F_` token, because it survives the file being
 * renamed, re-zipped, or archived under a caller's own key — which is exactly
 * what our feed archive does. {@link NcdexRevision} is read from `SsnId` and
 * the filename is never consulted.
 *
 * The revision is not cosmetic. Between the two 2026-08-12 fixtures, with an
 * identical 1,713-row `FinInstrmId` set: 817 rows change settlement price, 515
 * change close, 468 change underlying price, and 2 rows (RAINMUMBAI, id 81777)
 * restate volume, open interest and turnover outright. Treating the
 * provisional as final locks in 817 wrong settlement prices.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * The ZIP has two members, and the one we want is not guaranteed first
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Each NCDEX archive holds BOTH the modern UDiFF CSV and a legacy 19-column
 * `FO_DDMMYY_{PROVISIONAL,FINAL}.csv`. The existing {@link unzipSingleEntry}
 * in `bhavcopy.ts` reads only the first local file header and documents why —
 * "the NSE file is always exactly one entry". That is true of NSE and false
 * here. It happens to return the right member for both committed fixtures
 * (the UDiFF CSV is physically first in both), but that is luck about member
 * ordering, not a property of the format, and it silently returns the *legacy*
 * file the day NCDEX reorders the archive.
 *
 * {@link unzipEntries} is therefore a multi-member walker selecting BY NAME.
 * It adds no dependency — same `node:zlib` `inflateRawSync` as its sibling —
 * and it returns **Buffer**, not a UTF-8 string, because decoding before the
 * caller knows what a member is corrupts any non-text member. Decoding is the
 * caller's decision, made once it has picked its member.
 *
 * And picking the UDiFF member is not merely a preference for the newer
 * format. **The legacy member's header is not stable across revisions of the
 * same day.** Both 2026-08-12 archives carry the same 19 columns over the same
 * 1,714 lines, and NCDEX respells every one of them between the evening file
 * and the post-midnight one:
 *
 *   provisional  `"INSTRUMENT_TYPE","SYMBOL",…,"HIGH_PRCE",…,"OPEN_INTREST(IN QUANTITY)"`
 *   final        `"Instrument Type","Symbol",…,"High Price",…,"Open Interest"`
 *
 * Different casing, different word separators, and two typos (`PRCE`,
 * `INTREST`) that exist in the provisional spelling only. A header-keyed
 * parser built against either revision returns zero rows for the other, every
 * day, without erroring — both files are perfectly valid CSV. The UDiFF member
 * has no such problem: byte-identical across both revisions AND across
 * exchanges. That asymmetry is why this module reads UDiFF and ignores the
 * legacy member entirely.
 */

import Papa from "papaparse";
import { unzipEntries, type ZipEntry } from "./zip-entries";

// ─── Shared numeric / date primitives ────────────────────────────────

/**
 * A CSV cell → a finite number, or `null`.
 *
 * `null` for blanks, `-` (MCX's not-applicable marker), `NA`, and anything
 * that parses to NaN or ±Infinity. Never 0 — see the module header: 0 is a
 * claim about the market and a blank cell has no standing to make it.
 *
 * `Number("")` is 0, which is precisely the trap: the empty-string check must
 * come BEFORE the numeric coercion, not after.
 */
function finite(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === "" || s === "-" || s.toUpperCase() === "NA") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Month name → 0-based index. The whole defence against "11 Aug" → "Nov 8". */
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

/**
 * Build a UTC-midnight Date, or `null` if the components do not describe a
 * real calendar day.
 *
 * The round-trip check is not ceremony: `Date.UTC(2026, 1, 31)` silently rolls
 * to 3 March. Without the check, a garbled "31 Feb 2026" would parse
 * "successfully" into a date three days from where it claims to be — a wrong
 * answer, which is worse than no answer.
 */
function utcMidnight(
  year: number,
  monthIndex: number,
  day: number,
): Date | null {
  if (!Number.isInteger(year) || year < 1990 || year > 2100) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return null;
  }
  const d = new Date(Date.UTC(year, monthIndex, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== monthIndex ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

// ─── MCX ─────────────────────────────────────────────────────────────

/**
 * The MCX bhavcopy header, exactly as published — byte-identical across all
 * four fixtures spanning 2015 → 2026.
 *
 * Kept as data, and checked, so that "MCX changed its columns" surfaces as a
 * `null` from {@link parseMcxBhavcopy} instead of as a quietly empty day. Note
 * `Volume(In 000's)`: the name is retained here because it is what MCX
 * literally sends, and nowhere else.
 */
export const MCX_COLUMNS: readonly string[] = [
  "Date",
  "Instrument Name",
  "Symbol",
  "Expiry Date",
  "Option Type",
  "Strike Price",
  "Open",
  "High",
  "Low",
  "Close",
  "Previous Close",
  "Volume(Lots)",
  "Volume(In 000's)",
  "Value(Lacs)",
  "Open Interest(Lots)",
];

/**
 * MCX's instrument vocabulary, as observed across the four fixtures.
 *
 *   FUTCOM  commodity future        (all four years)
 *   FUTIDX  index future            (2024, 2026 — MCXBULLDEX etc.)
 *   OPTCOM  option on the commodity (2020)
 *   OPTFUT  option on the future    (2020, 2024, 2026)
 *   OPTIDX  option on an index      (2026)
 *
 * The set GREW over time: 2015 carries FUTCOM only. An unknown code is not a
 * parse failure — MCX is entitled to list a new product — but it must not be
 * silently dropped either, so it is counted in
 * {@link McxBhavcopyDay.unknownInstruments} and the row is kept with its code
 * verbatim.
 */
export const MCX_INSTRUMENTS: readonly string[] = [
  "FUTCOM",
  "FUTIDX",
  "OPTCOM",
  "OPTFUT",
  "OPTIDX",
];

/** `CE` / `PE`, or `null` for a future (MCX publishes `-`). */
export type OptionType = "CE" | "PE";

/** One contract's end-of-day bar from an MCX bhavcopy. */
export interface McxBhavcopyRow {
  /** Trading date, UTC midnight of the IST calendar day, read from the row. */
  tradingDate: Date;
  /** `FUTCOM` / `OPTFUT` / … — verbatim, including codes we do not know. */
  instrument: string;
  /** Trimmed symbol, e.g. `ALUMINI`. The join key. */
  symbol: string;
  /**
   * The symbol exactly as published, padding intact (`"ALUMINI      "`).
   * Kept because the padding width is itself a signal that MCX's export format
   * changed, and because a bug report quoting a padded symbol should be
   * greppable against what we stored.
   */
  rawSymbol: string;
  /** Contract expiry, UTC midnight. MCX publishes `DDMONYYYY` (`31AUG2026`). */
  expiry: Date;
  /** `CE` / `PE`, or `null` for futures. */
  optionType: OptionType | null;
  /**
   * Strike, or `null` for futures.
   *
   * MCX publishes a literal `0` in this column for every future. That sentinel
   * is normalised away rather than stored, so no caller can mistake it for a
   * real strike of zero — an option struck at 0 and a future are very
   * different things to a downstream P&L.
   */
  strike: number | null;
  /** `null` means the contract did not trade — NOT zero. See module header. */
  open: number | null;
  high: number | null;
  low: number | null;
  /** Close / settlement. Required: a row without it is dropped, not zeroed. */
  close: number;
  /** Previous day's close as reported. */
  prevClose: number | null;
  /** Traded volume in LOTS (`Volume(Lots)`). */
  volumeLots: number | null;
  /**
   * Traded quantity in {@link volumeUnit}, from the column MCX mislabels
   * `Volume(In 000's)`.
   *
   * **This is not in thousands.** Do not multiply by 1000. 2015 ALUMINI:
   * 11,013 lots and 11,013 here. See module header §2.
   */
  volumeQuantity: number | null;
  /** The unit suffix on that column — `KGS`, `GRMS`, `BBL`, `mmBtu`, … */
  volumeUnit: string | null;
  /** Turnover in lakh rupees (`Value(Lacs)`), as published. */
  valueLakh: number | null;
  /** Open interest in LOTS. */
  openInterestLots: number | null;
}

/** Rows the parser refused to emit, by reason. Reported, never silent. */
export interface McxDropped {
  /** `Date` cell absent or not a real calendar day. */
  badDate: number;
  /** `Symbol` blank after trimming. */
  badSymbol: number;
  /** `Expiry Date` absent or not a real calendar day. */
  badExpiry: number;
  /** `Close` blank, or not a finite number. */
  badClose: number;
}

/** A successfully parsed MCX bhavcopy. */
export interface McxBhavcopyDay {
  status: "ok";
  exchange: "MCX";
  /**
   * The day the FILE says it is, taken from the rows.
   *
   * `null` only when the file parsed but every row's date was unusable — a
   * survivable outcome the caller must cross-check against the day it asked
   * for. It is deliberately not defaulted to the request date: MCX re-serving
   * the wrong day is the exact hazard here (see module header §1), and a
   * parser that helpfully fills in the caller's assumption destroys the only
   * evidence of it.
   */
  tradingDate: Date | null;
  rows: McxBhavcopyRow[];
  /** Distinct trimmed symbols present today — see module header §3. */
  symbols: string[];
  dropped: McxDropped;
  /** Instrument codes outside {@link MCX_INSTRUMENTS}, with row counts. */
  unknownInstruments: Record<string, number>;
  /**
   * True when rows disagree about the trading date. MCX has never done this
   * in the fixtures, but a caller must be able to refuse a file that has.
   */
  mixedDates: boolean;
}

/** MCX answered "no data" for the requested day: a holiday, not an error. */
export interface CommodityNoData {
  status: "no-data";
  /** The exchange's own words, e.g. `"No data found."`. */
  message: string;
}

/** {@link parseMcxBhavcopy}'s success shapes. `null` is the third outcome. */
export type McxBhavcopyFile = McxBhavcopyDay | CommodityNoData;

/**
 * MCX's "no data" envelope: HTTP 200 with a JSON body, not a 404.
 *
 * Matched structurally rather than by string, because the message text is not
 * a contract — only `IsSuccess: false` is. A body that is valid JSON with
 * `IsSuccess === false` is an affirmative "no data for this day".
 *
 * Returns the message on a match, `null` when these bytes are not that
 * envelope (including when they are not JSON at all, which is the common case
 * — a real bhavcopy).
 */
export function parseMcxNoDataEnvelope(body: string): string | null {
  const trimmed = body.trim();
  // Cheap reject before paying for JSON.parse on a 2 MB CSV.
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.IsSuccess !== false) return null;
  const message = record.Message;
  return typeof message === "string" && message.trim() !== ""
    ? message.trim()
    : "No data found.";
}

/**
 * MCX's response date format: `DD Mon YYYY` (`"11 Aug 2026"`) → UTC midnight.
 *
 * Deliberately NOT `new Date(str)`. See module header §1: the month is matched
 * against an explicit table so no locale, engine, or lenient fallback parser
 * can turn "11 Aug" into "Nov 8".
 *
 * Returns `null` on anything else — including a numeric month. A file that
 * starts sending `11/08/2026` must fail loudly rather than be guessed at,
 * because that is the one format where the transposition is undetectable.
 */
export function parseMcxDate(cell: unknown): Date | null {
  if (cell === null || cell === undefined) return null;
  const s = String(cell).trim();
  // "13 Aug 2015" — day, alphabetic month, 4-digit year.
  const m = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/.exec(s);
  if (!m) return null;
  const [, day, month, year] = m;
  if (day === undefined || month === undefined || year === undefined) {
    return null;
  }
  const monthIndex = MONTHS[month.slice(0, 3).toUpperCase()];
  if (monthIndex === undefined) return null;
  return utcMidnight(Number(year), monthIndex, Number(day));
}

/**
 * MCX's expiry format: `DDMONYYYY` (`"31AUG2026"`) → UTC midnight.
 *
 * Also alphabetic-month, also unambiguous, also table-driven.
 */
export function parseMcxExpiry(cell: unknown): Date | null {
  if (cell === null || cell === undefined) return null;
  const s = String(cell).trim().toUpperCase();
  const m = /^(\d{1,2})([A-Z]{3})(\d{4})$/.exec(s);
  if (!m) return null;
  const [, day, month, year] = m;
  if (day === undefined || month === undefined || year === undefined) {
    return null;
  }
  const monthIndex = MONTHS[month];
  if (monthIndex === undefined) return null;
  return utcMidnight(Number(year), monthIndex, Number(day));
}

/**
 * Split the mislabelled `Volume(In 000's)` cell into quantity and unit.
 *
 * `"11013.000 KGS  "` → `{ quantity: 11013, unit: "KGS" }`
 * `"157200.000 mmBtu"` → `{ quantity: 157200, unit: "mmBtu" }`
 *
 * Splits on whitespace instead of matching a unit character class, because
 * `mmBtu` is lowercase-led and an `[A-Z ]+` pattern drops every natural-gas
 * row on the floor without saying so. The unit's case is preserved verbatim —
 * `mmBtu` is how the industry writes it and normalising it to `MMBTU` would
 * only invent a second spelling to reconcile later.
 *
 * Returns `null` for a cell that is not `<number> [unit]`. A bare number with
 * no unit is accepted with `unit: null` — the quantity is the load-bearing
 * half, and refusing it over a missing label would discard real volume.
 */
export function parseMcxVolumeCell(
  cell: unknown,
): { quantity: number; unit: string | null } | null {
  if (cell === null || cell === undefined) return null;
  const s = String(cell).trim();
  if (s === "") return null;
  const parts = s.split(/\s+/);
  const quantity = finite(parts[0]);
  if (quantity === null) return null;
  const unit = parts.length > 1 ? parts.slice(1).join(" ").trim() : "";
  return { quantity, unit: unit === "" ? null : unit };
}

/**
 * Parse an MCX bhavcopy.
 *
 * @param body the raw response — a CSV, or MCX's JSON "no data" envelope.
 * @returns `{ status: "ok", … }` for a bhavcopy (possibly with zero rows),
 *   `{ status: "no-data", … }` when MCX said the day has none, and `null`
 *   when the bytes are not an MCX bhavcopy at all. Three outcomes, three
 *   caller actions — see the module header.
 */
export function parseMcxBhavcopy(body: string): McxBhavcopyFile | null {
  if (typeof body !== "string") return null;

  // A holiday answers 200 with JSON. Check before assuming CSV.
  const noData = parseMcxNoDataEnvelope(body);
  if (noData !== null) return { status: "no-data", message: noData };

  const text = body.replace(/^﻿/, "");
  if (text.trim() === "") return null;

  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const fields = parsed.meta.fields ?? [];
  // Every declared column must be present. MCX adding a column is survivable;
  // MCX *removing* one means our mapping is guessing, so refuse the file.
  const present = new Set(fields);
  if (!MCX_COLUMNS.every((c) => present.has(c))) return null;

  const rows: McxBhavcopyRow[] = [];
  const dropped: McxDropped = {
    badDate: 0,
    badSymbol: 0,
    badExpiry: 0,
    badClose: 0,
  };
  const unknownInstruments: Record<string, number> = {};
  const symbolSet = new Set<string>();
  const dateKeys = new Set<number>();

  for (const rec of parsed.data) {
    if (!rec || typeof rec !== "object") continue;

    // ── Identity: any failure drops the row and is counted. ──
    const tradingDate = parseMcxDate(rec["Date"]);
    if (!tradingDate) {
      dropped.badDate++;
      continue;
    }
    const rawSymbol = String(rec["Symbol"] ?? "");
    const symbol = rawSymbol.trim();
    if (symbol === "") {
      dropped.badSymbol++;
      continue;
    }
    const expiry = parseMcxExpiry(rec["Expiry Date"]);
    if (!expiry) {
      dropped.badExpiry++;
      continue;
    }
    const close = finite(rec["Close"]);
    if (close === null) {
      dropped.badClose++;
      continue;
    }

    const instrument = String(rec["Instrument Name"] ?? "").trim();
    if (instrument !== "" && !MCX_INSTRUMENTS.includes(instrument)) {
      unknownInstruments[instrument] =
        (unknownInstruments[instrument] ?? 0) + 1;
    }

    const rawOptionType = String(rec["Option Type"] ?? "")
      .trim()
      .toUpperCase();
    const optionType: OptionType | null =
      rawOptionType === "CE" || rawOptionType === "PE" ? rawOptionType : null;

    // Futures carry a literal 0 strike; normalise the sentinel to null so it
    // can never be read as "struck at zero".
    const rawStrike = finite(rec["Strike Price"]);
    const strike =
      optionType === null ? null : rawStrike === 0 ? null : rawStrike;

    const volume = parseMcxVolumeCell(rec["Volume(In 000's)"]);

    rows.push({
      tradingDate,
      instrument,
      symbol,
      rawSymbol,
      expiry,
      optionType,
      strike,
      // Blank O/H/L means "did not trade". null, never 0, never close-filled.
      open: finite(rec["Open"]),
      high: finite(rec["High"]),
      low: finite(rec["Low"]),
      close,
      prevClose: finite(rec["Previous Close"]),
      volumeLots: finite(rec["Volume(Lots)"]),
      volumeQuantity: volume?.quantity ?? null,
      volumeUnit: volume?.unit ?? null,
      valueLakh: finite(rec["Value(Lacs)"]),
      openInterestLots: finite(rec["Open Interest(Lots)"]),
    });

    symbolSet.add(symbol);
    dateKeys.add(tradingDate.getTime());
  }

  const dateList = [...dateKeys].sort((a, b) => a - b);
  const earliest = dateList[0];
  return {
    status: "ok",
    exchange: "MCX",
    tradingDate: earliest === undefined ? null : new Date(earliest),
    rows,
    symbols: [...symbolSet].sort(),
    dropped,
    unknownInstruments,
    mixedDates: dateList.length > 1,
  };
}

// ─── UDiFF (shared by NSE F&O and NCDEX) ─────────────────────────────

/**
 * The UDiFF column contract — 34 columns, in order.
 *
 * Verified byte-identical between NSE's F&O bhavcopy and NCDEX's commodity
 * bhavcopy (same md5 on the header line of both committed fixtures). Exported
 * so that identity is machine-checked by a test rather than asserted in prose:
 * if either exchange ever moves, the test names which one.
 *
 * `FininstrmActlXpryDt`'s lowercase `i` is not a typo here — it is a typo in
 * the published format, faithfully reproduced by both exchanges.
 */
export const UDIFF_COLUMNS: readonly string[] = [
  "TradDt",
  "BizDt",
  "Sgmt",
  "Src",
  "FinInstrmTp",
  "FinInstrmId",
  "ISIN",
  "TckrSymb",
  "SctySrs",
  "XpryDt",
  "FininstrmActlXpryDt",
  "StrkPric",
  "OptnTp",
  "FinInstrmNm",
  "OpnPric",
  "HghPric",
  "LwPric",
  "ClsPric",
  "LastPric",
  "PrvsClsgPric",
  "UndrlygPric",
  "SttlmPric",
  "OpnIntrst",
  "ChngInOpnIntrst",
  "TtlTradgVol",
  "TtlTrfVal",
  "TtlNbOfTxsExctd",
  "SsnId",
  "NewBrdLotQty",
  "Rmks",
  "Rsvd1",
  "Rsvd2",
  "Rsvd3",
  "Rsvd4",
];

/** UDiFF's `YYYY-MM-DD` → UTC midnight. */
export function parseUdiffDate(cell: unknown): Date | null {
  if (cell === null || cell === undefined) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(cell).trim());
  if (!m) return null;
  return utcMidnight(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// ─── NCDEX ───────────────────────────────────────────────────────────

/**
 * NCDEX's `FinInstrmTp` → an instrument name, using the vocabulary MCX already
 * publishes so both exchanges land in one namespace.
 *
 * `COF` commodity future. `FUO` is an option ON A FUTURE — the underlying is
 * the futures contract, not the spot commodity — hence `OPTFUT`, matching
 * MCX's own code for the same instrument rather than inventing a synonym.
 *
 * Note there is NO overlap with NSE's `IDF`/`IDO`/`STF`/`STO`. That emptiness
 * is the entire reason `parseUdiffFoBhavcopy` cannot be reused here; see the
 * module header.
 */
export const NCDEX_INSTRUMENTS: Readonly<Record<string, string>> = {
  COF: "FUTCOM",
  FUO: "OPTFUT",
};

/**
 * Which publication of a trading day this is.
 *
 * Read from `SsnId` (`I1` → provisional, `F1` → final), never from the
 * filename — see the module header. `unknown` for any other session code:
 * NCDEX is entitled to add one, and guessing "final" would let unrevised
 * numbers become permanent.
 */
export type NcdexRevision = "provisional" | "final" | "unknown";

/** `SsnId` → {@link NcdexRevision}. */
export function ncdexRevisionFromSessionId(sessionId: unknown): NcdexRevision {
  const s = String(sessionId ?? "")
    .trim()
    .toUpperCase();
  if (s === "I1") return "provisional";
  if (s === "F1") return "final";
  return "unknown";
}

/** One contract's end-of-day bar from an NCDEX UDiFF bhavcopy. */
export interface NcdexBhavcopyRow {
  /** `TradDt`, UTC midnight. */
  tradingDate: Date;
  /** Mapped instrument (`FUTCOM` / `OPTFUT`), from `FinInstrmTp`. */
  instrument: string;
  /** The raw `FinInstrmTp` code, kept so an unmapped one is still traceable. */
  rawInstrumentType: string;
  /** `TckrSymb`, trimmed — e.g. `CASTOR`. */
  symbol: string;
  /** `FinInstrmNm` — the full contract name, e.g. `CASTOR20AUG2026`. */
  contractName: string;
  /** NCDEX's own numeric contract id (`FinInstrmId`). Stable within a day. */
  instrumentId: string;
  /** `XpryDt`, UTC midnight. */
  expiry: Date;
  optionType: OptionType | null;
  strike: number | null;
  /** `null` where the contract did not trade — NCDEX publishes 0.00 there. */
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  lastPrice: number | null;
  prevClose: number | null;
  /** `UndrlygPric` — the spot/underlying reference for the contract. */
  underlyingPrice: number | null;
  /** `SttlmPric`. The number that changes most between revisions. */
  settlePrice: number | null;
  openInterest: number | null;
  openInterestChange: number | null;
  /** `TtlTradgVol` — traded quantity. */
  volume: number | null;
  /** `TtlTrfVal` — turnover in RUPEES, as published (NOT lakhs). */
  turnoverRupees: number | null;
  tradeCount: number | null;
  /** `NewBrdLotQty` — the contract's board lot. */
  boardLotQuantity: number | null;
  /** This row's own `SsnId` reading. */
  revision: NcdexRevision;
}

/** Rows the parser refused to emit, by reason. */
export interface NcdexDropped {
  badDate: number;
  badSymbol: number;
  badExpiry: number;
  badClose: number;
  /** `FinInstrmTp` outside {@link NCDEX_INSTRUMENTS}, with per-code counts. */
  unknownInstrumentType: Record<string, number>;
}

/** A successfully parsed NCDEX bhavcopy. */
export interface NcdexBhavcopyDay {
  status: "ok";
  exchange: "NCDEX";
  tradingDate: Date | null;
  /**
   * The file-level revision, from `SsnId`.
   *
   * `unknown` when rows disagree (see {@link mixedRevisions}) or carry a
   * session code we do not recognise. A caller must not write a file it cannot
   * classify — that is how a provisional settlement price becomes permanent.
   */
  revision: NcdexRevision;
  /** True when rows disagree about the revision. Refuse such a file. */
  mixedRevisions: boolean;
  rows: NcdexBhavcopyRow[];
  symbols: string[];
  dropped: NcdexDropped;
  mixedDates: boolean;
}

/** {@link parseNcdexBhavcopy}'s success shapes. `null` is the third outcome. */
export type NcdexBhavcopyFile = NcdexBhavcopyDay | CommodityNoData;

/**
 * Parse an NCDEX commodity UDiFF bhavcopy (the archive's
 * `BhavCopy_NCD_CO_0_0_0_YYYYMMDD_{P|F}_0000.csv` member).
 *
 * @param body the decoded CSV.
 * @returns `{ status: "ok", … }`, or `null` when the bytes are not a UDiFF
 *   bhavcopy. (`no-data` is in the return type for symmetry with MCX; NCDEX
 *   has not been observed to send such an envelope, and inventing a shape for
 *   it would be a guess — so it is never produced here.)
 */
export function parseNcdexBhavcopy(body: string): NcdexBhavcopyFile | null {
  if (typeof body !== "string") return null;

  const text = body.replace(/^﻿/, "");
  if (text.trim() === "") return null;

  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const present = new Set(parsed.meta.fields ?? []);
  if (!UDIFF_COLUMNS.every((c) => present.has(c))) return null;

  const rows: NcdexBhavcopyRow[] = [];
  const dropped: NcdexDropped = {
    badDate: 0,
    badSymbol: 0,
    badExpiry: 0,
    badClose: 0,
    unknownInstrumentType: {},
  };
  const symbolSet = new Set<string>();
  const dateKeys = new Set<number>();
  const revisions = new Set<NcdexRevision>();

  for (const rec of parsed.data) {
    if (!rec || typeof rec !== "object") continue;

    const rawInstrumentType = String(rec.FinInstrmTp ?? "")
      .trim()
      .toUpperCase();
    const instrument = NCDEX_INSTRUMENTS[rawInstrumentType];
    if (!instrument) {
      // Not silently dropped: an unmapped code is named and counted, so a new
      // NCDEX product shows up as a number rather than as missing rows.
      const key = rawInstrumentType || "(blank)";
      dropped.unknownInstrumentType[key] =
        (dropped.unknownInstrumentType[key] ?? 0) + 1;
      continue;
    }

    const tradingDate = parseUdiffDate(rec.TradDt);
    if (!tradingDate) {
      dropped.badDate++;
      continue;
    }
    const symbol = String(rec.TckrSymb ?? "").trim();
    if (symbol === "") {
      dropped.badSymbol++;
      continue;
    }
    const expiry = parseUdiffDate(rec.XpryDt);
    if (!expiry) {
      dropped.badExpiry++;
      continue;
    }
    const close = finite(rec.ClsPric);
    if (close === null) {
      dropped.badClose++;
      continue;
    }

    const rawOptionType = String(rec.OptnTp ?? "")
      .trim()
      .toUpperCase();
    const optionType: OptionType | null =
      rawOptionType === "CE" || rawOptionType === "PE" ? rawOptionType : null;
    const rawStrike = finite(rec.StrkPric);
    const strike =
      optionType === null ? null : rawStrike === 0 ? null : rawStrike;

    const revision = ncdexRevisionFromSessionId(rec.SsnId);
    revisions.add(revision);

    // NCDEX publishes 0.00 for O/H/L on a contract that did not trade, and a
    // real close carried from settlement. Unlike a blank, 0.00 is a value the
    // exchange chose to send — but it is still not a price at which anything
    // changed hands, and a 0-to-close bar is as wrong here as on MCX. Only the
    // O/H/L trio is treated this way; a genuine 0 volume or 0 open interest is
    // a true statement and is preserved.
    const zeroIsNotTraded = (v: number | null): number | null =>
      v === null || v === 0 ? null : v;

    rows.push({
      tradingDate,
      instrument,
      rawInstrumentType,
      symbol,
      contractName: String(rec.FinInstrmNm ?? "").trim(),
      instrumentId: String(rec.FinInstrmId ?? "").trim(),
      expiry,
      optionType,
      strike,
      open: zeroIsNotTraded(finite(rec.OpnPric)),
      high: zeroIsNotTraded(finite(rec.HghPric)),
      low: zeroIsNotTraded(finite(rec.LwPric)),
      close,
      lastPrice: zeroIsNotTraded(finite(rec.LastPric)),
      prevClose: finite(rec.PrvsClsgPric),
      underlyingPrice: finite(rec.UndrlygPric),
      settlePrice: finite(rec.SttlmPric),
      openInterest: finite(rec.OpnIntrst),
      openInterestChange: finite(rec.ChngInOpnIntrst),
      volume: finite(rec.TtlTradgVol),
      turnoverRupees: finite(rec.TtlTrfVal),
      tradeCount: finite(rec.TtlNbOfTxsExctd),
      boardLotQuantity: finite(rec.NewBrdLotQty),
      revision,
    });

    symbolSet.add(symbol);
    dateKeys.add(tradingDate.getTime());
  }

  const dateList = [...dateKeys].sort((a, b) => a - b);
  const earliest = dateList[0];
  const revisionList = [...revisions];
  const onlyRevision = revisionList.length === 1 ? revisionList[0] : undefined;
  return {
    status: "ok",
    exchange: "NCDEX",
    tradingDate: earliest === undefined ? null : new Date(earliest),
    revision: onlyRevision ?? "unknown",
    mixedRevisions: revisionList.length > 1,
    rows,
    symbols: [...symbolSet].sort(),
    dropped,
    mixedDates: dateList.length > 1,
  };
}

// ─── ZIP ─────────────────────────────────────────────────────────────

// MONEY-1319 — the walker MOVED to `zip-entries.ts`, unchanged, because a
// second consumer with nothing to do with commodities needed it: the document
// extract lane has to open the 179 NSE ZIPs stored under `.pdf` keys. It is
// re-exported here so every existing importer — `market-data/index.ts`, the
// commodity suite, `parseNcdexArchive` below — keeps reaching it by the path it
// already uses, and so this file stays the place the NCDEX reasoning above
// lives.
export { unzipEntries, type ZipEntry };

/**
 * Pick the UDiFF member out of an NCDEX daily archive and parse it.
 *
 * Selection is BY NAME (`BhavCopy_NCD_…`), never by position: the archive also
 * holds a legacy 19-column `FO_DDMMYY_{PROVISIONAL,FINAL}.csv`, and taking
 * member #0 returns the right file today only because NCDEX happens to write
 * the UDiFF one first.
 *
 * @returns `null` when the buffer is not a ZIP, holds no UDiFF member, or that
 *   member is not a bhavcopy.
 */
export function parseNcdexArchive(buf: Buffer): NcdexBhavcopyFile | null {
  const entries = unzipEntries(buf);
  if (!entries) return null;
  const member = entries.find((e) =>
    /(^|\/)BhavCopy_NCD_.*\.csv$/i.test(e.name),
  );
  if (!member) return null;
  return parseNcdexBhavcopy(member.bytes.toString("utf-8"));
}
