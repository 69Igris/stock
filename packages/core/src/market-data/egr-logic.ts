/**
 * NSE `EG_BC{DDMMYYYY}.DAT` — Electronic Gold Receipts bhavcopy — MONEY-1204
 * (P14 / 14b.4).
 *
 * Registry family `nse-egr-bhavcopy`, `enabled: true`, 8 archived objects since
 * 2026-05.
 *
 * ## Two documented claims about this feed are false, and both change the task
 *
 * **1. It is not a 404.** Root `CLAUDE.md` says *"MWPL and EGR have ZERO
 * archived files because their registry paths 404; those are URL-DISCOVERY
 * tasks, not parse tasks."* That is true of MWPL and false of EGR — the path
 * works and the bytes are in the bucket.
 *
 * **2. It is not "a header with no rows".** `docs/reference/feed-backfill-report.md`
 * explains the 195-byte size as an empty file. The 195 bytes are ONE DATA ROW
 * and there is NO header anywhere in the file. That inverts the conclusion: 195
 * bytes is a normal EGR trading day (Electronic Gold Receipts barely trade), not
 * an empty one, and the data is real.
 *
 * ## The shape is positional, and it is NOT UDiFF
 *
 * The 14b.4 spec said to branch on shape — "UDiFF-style → `DailyPrice`, else the
 * CommodityEOD model". UDiFF is ruled out on sight: it carries a header row and
 * ~30 named columns (`TradDt,BizDt,Sgmt,…`). This file has no header at all, 17
 * comma-separated positional fields, heavy space padding and zero-padded
 * numerics. So the column meanings had to be recovered from the values, and
 * {@link EGR_COLUMNS} records exactly how much of that recovery is proof and how
 * much is inference.
 *
 * The one complete observed row, verbatim:
 *
 * ```
 * EGR 999 10 GRAM               ,GOLD10G99 ,EG,N,0153366.00,0155334.00,0155349.00,0155324.00,0155348.00,    ,           153,       23766349.00,0155349.00,0147850.00,10-AUG-2026,     110,0155348.00
 * ```
 *
 * **Fields 5–9 are PREV_CLOSE, OPEN, HIGH, LOW, CLOSE, proven by ordering.** It
 * is the only assignment under which the OHLC invariants hold:
 * `low(155324) <= open(155334) <= high(155349)` and `close(155348)` inside the
 * range. Reading them as OPEN,HIGH,LOW,CLOSE,PREV instead puts the low above the
 * high.
 *
 * **Fields 11 and 12 are QUANTITY and VALUE, proven by arithmetic.**
 * `23766349.00 / 153 = 155335.61`, which falls inside `[low, high]` — that is a
 * session VWAP. The alternative pairing is falsified, not merely less likely:
 * `23766349.00 / 110 = 216057.72`, 39% above the day's high.
 *
 * **Prices are RUPEES, not paise.** ₹155,348 per "EGR 999 10 GRAM" unit is
 * ₹15,535/gram, which is where gold sits. A paise reading would put gold at
 * ₹1,553 per 10 grams.
 *
 * **Five fields are UNKNOWN and are not given names.** Indices 9, 12, 13, 15 and
 * 16 (0-based) have plausible readings and no proof, so they are carried as
 * {@link EgrUnknownCell}s — index, raw text and numeric value — rather than
 * guessed into a field name that a writer would then persist as fact. The
 * falsification experiment is cheap and written down in {@link EGR_COLUMNS}:
 * parse a SECOND archived day and see which of them move.
 *
 * ## Recommended write target: `DailyPrice`, once an instrument exists
 *
 * This is an OHLCV row on a symbol, so it belongs on the existing price rail,
 * not in a new model. It cannot be written yet, and the blocker is NOT this
 * parser: `DailyPrice.instrumentId` requires an `InstrumentMapping`, and
 * `GOLD10G99` is in none of our instrument sources — not Kite's dump, not NSE's
 * EQUITY_L/SME_EQUITY_L masters, not BSE's scrip master. Writing it anyway would
 * re-create the MONEY-1085 defect the bhavcopy module warns about in as many
 * words: rows fetched, then dropped on the join. The unblocking move is to mint
 * the instrument from the row itself, exactly as `mintMissingTrustInstruments`
 * in `workers/src/processors/bhavcopy-sync.ts` already does for REITs and InvITs.
 *
 * A `CommodityEOD` model is NOT the answer and does not exist — the spec named
 * it, but nothing in `schema.prisma` defines it and `commodity-eod-logic.ts`
 * writes nowhere. Those MCX/NCDEX rows are contract-shaped (expiry, strike,
 * option type) and genuinely cannot share `DailyPrice`; this row is not. Solving
 * their storage is a separate, fetch-blocked ticket and should not be dragged in
 * to host a single gold receipt.
 *
 * Absence rules follow the house convention: blank / `-` / `NA` parse to `null`,
 * never `0` — the padded blank at index 9 is four spaces, and `Number("    ")`
 * is `0`. `null` from {@link parseEgrBhavcopy} means "these bytes are not this
 * report"; `rows: []` means "this IS the report and it carried nothing".
 */

import { parseDeliveryDate } from "./delivery";

// ─── Namespace ───────────────────────────────────────────────────────────────

/** `source` stamp for rows produced from this feed. */
export const EGR_SOURCE = "NSE_EGR_BHAVCOPY" as const;

/** Every data line carries exactly this many comma-separated fields. */
export const EGR_FIELD_COUNT = 17;

/**
 * What each of the 17 positional fields is, and how sure we are.
 *
 * Data rather than prose so the uncertainty travels with the code. `confidence`
 * is the honest part:
 *
 * - `proven`   — falsifiable and falsified against the real bytes (OHLC ordering,
 *                the quantity/value VWAP).
 * - `inferred` — the value is unambiguous in kind (a date, a symbol) and the
 *                position is stable, but only one file has been read.
 * - `unknown`  — no justified name. Carried raw; never written under a guess.
 *
 * The `unknown` five have a cheap experiment attached, noted per entry: read a
 * SECOND archived day (there are 8) and watch which of them track that day's
 * OHLC. Index 12 equalling the day's high and index 16 equalling the day's close
 * is either a duplicate column or a coincidence of one thin session; a second
 * file separates those in one read.
 */
export const EGR_COLUMNS: readonly {
  readonly index: number;
  readonly field: string;
  readonly confidence: "proven" | "inferred" | "unknown";
  readonly note: string;
}[] = [
  {
    index: 0,
    field: "name",
    confidence: "inferred",
    note: "`EGR 999 10 GRAM` — descriptive instrument name, space-padded to a fixed width.",
  },
  {
    index: 1,
    field: "symbol",
    confidence: "inferred",
    note: "`GOLD10G99` — trading symbol, space-padded.",
  },
  {
    index: 2,
    field: "series",
    confidence: "inferred",
    note: "`EG` — the EGR segment series. Not required for file detection: a second EGR series (e.g. a 995-purity contract) would be data, not a parse failure.",
  },
  {
    index: 3,
    field: "market",
    confidence: "inferred",
    note: "`N` — matches the SME bhavcopy's own MARKET column, which is `N` on all 40 of its rows.",
  },
  {
    index: 4,
    field: "prevClose",
    confidence: "proven",
    note: "153366.00. Ordering proof: only PREV,OPEN,HIGH,LOW,CLOSE keeps low <= open <= high with close inside.",
  },
  {
    index: 5,
    field: "open",
    confidence: "proven",
    note: "155334.00, inside [low, high].",
  },
  {
    index: 6,
    field: "high",
    confidence: "proven",
    note: "155349.00, the maximum of fields 5-9 excluding prevClose.",
  },
  {
    index: 7,
    field: "low",
    confidence: "proven",
    note: "155324.00, the minimum.",
  },
  {
    index: 8,
    field: "close",
    confidence: "proven",
    note: "155348.00, inside [low, high].",
  },
  {
    index: 9,
    field: "UNKNOWN",
    confidence: "unknown",
    note: "Four spaces on the only observed row — an empty cell, so its KIND is unknown too. Sits where the SME bhavcopy puts CORP_IND (also a single blank there). EXPERIMENT: a second day showing a letter would settle it as a corporate-action indicator.",
  },
  {
    index: 10,
    field: "tradedQty",
    confidence: "proven",
    note: "153 units. Arithmetic proof: 23766349.00/153 = 155335.61, inside [low, high] — a session VWAP. The alternative (qty=110) gives 216057.72, 39% above the high.",
  },
  {
    index: 11,
    field: "tradedValue",
    confidence: "proven",
    note: "₹23,766,349.00 turnover. Same VWAP proof. Rupees, not lakhs: value/qty must land in the price range and it does.",
  },
  {
    index: 12,
    field: "UNKNOWN",
    confidence: "unknown",
    note: "155349.00 — exactly the day's HIGH. Best candidate is a 52-week high (positionally where the SME bhavcopy puts HI_52_WK, and an all-time-high session in gold makes them coincide); a duplicated high column is equally consistent with one row. EXPERIMENT: on a second day, a 52-week high stays flat while the daily high moves.",
  },
  {
    index: 13,
    field: "UNKNOWN",
    confidence: "unknown",
    note: "147850.00 — 4.8% BELOW the day's low, so not a same-day price. Best candidate is a 52-week low (SME's LO_52_WK sits here). The narrow range is consistent with an instrument that trades on very few sessions a year.",
  },
  {
    index: 14,
    field: "date",
    confidence: "proven",
    note: "`10-AUG-2026` — DD-MON-YYYY upper, and it matches the archive key EG_BC10082026.DAT.",
  },
  {
    index: 15,
    field: "UNKNOWN",
    confidence: "unknown",
    note: "110. Falsified as a quantity (see index 10). Best candidate is the trade COUNT — 153 units over 110 trades averages 1.39 units/trade, which is plausible for a thin book. EXPERIMENT: on any day it exceeds tradedQty, it is not a trade count.",
  },
  {
    index: 16,
    field: "UNKNOWN",
    confidence: "unknown",
    note: "155348.00 — exactly the day's CLOSE. Best candidate is the settlement price, which for a deliverable spot receipt equals the close. EXPERIMENT: a day where it differs from close proves it is a distinct settlement column; a day where it tracks close forever leaves it a duplicate.",
  },
];

/** 0-based indices this module refuses to name. Derived from {@link EGR_COLUMNS}. */
export const EGR_UNKNOWN_COLUMNS: readonly number[] = EGR_COLUMNS.filter(
  (c) => c.confidence === "unknown",
).map((c) => c.index);

// ─── Row shapes ──────────────────────────────────────────────────────────────

/**
 * A field whose meaning is not established.
 *
 * Carried, not dropped and not named. `raw` keeps the published text (padding
 * and zero-padding included) so a later investigation reads what NSE wrote, and
 * `value` is the numeric reading where one exists — `null` for the blank at
 * index 9, which is the whole reason both are present.
 */
export interface EgrUnknownCell {
  /** 0-based field index in the line. */
  index: number;
  /** The cell exactly as published, untrimmed. */
  raw: string;
  /** Numeric reading, or `null` when blank/non-numeric. */
  value: number | null;
}

/** One published line of `EG_BC{DDMMYYYY}.DAT`. */
export interface EgrBhavcopyRow {
  /** Descriptive instrument name, trimmed. */
  name: string;
  /** Trading symbol, trimmed and upper-cased. */
  symbol: string;
  /** Segment series (`EG`). */
  series: string;
  /** Market-type code (`N`). */
  market: string;
  /** UTC midnight of the IST trading day, from the row's own date field. */
  date: Date;
  prevClose: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  /** Units traded. */
  tradedQty: number | null;
  /** Turnover in rupees. */
  tradedValue: number | null;
  /** The five fields this module will not name. See {@link EGR_COLUMNS}. */
  unknown: EgrUnknownCell[];
}

export interface EgrBhavcopyFile {
  /** The day this file describes — the first legible row's date. */
  tradingDate: Date | null;
  rows: EgrBhavcopyRow[];
  /** Falsification counters — why lines were dropped. */
  reasons: Record<string, number>;
}

// ─── Cell parsing ────────────────────────────────────────────────────────────

/**
 * A padded, zero-padded numeric cell → number, or `null` when absent.
 *
 * Every numeric field in this file is written like `0153366.00` or
 * `           153`. `Number` handles both leading zeros and surrounding space,
 * but it also turns `""` and `"    "` into `0` — and index 9 IS four spaces. So
 * the blank check runs first, per the house absence rule.
 */
export function parseEgrNumber(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s || s === "-" || s.toUpperCase() === "NA") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * `DD-MON-YYYY` → UTC midnight.
 *
 * Delegates to `parseDeliveryDate`, which is the same grammar already proven
 * against `sec_bhavdata_full`, rather than becoming a fourth copy of it. Two
 * copies of a date parser agree until the day one is fixed.
 */
export function parseEgrDate(raw: unknown): Date | null {
  return parseDeliveryDate(raw);
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

const COL = {
  name: 0,
  symbol: 1,
  series: 2,
  market: 3,
  prevClose: 4,
  open: 5,
  high: 6,
  low: 7,
  close: 8,
  tradedQty: 10,
  tradedValue: 11,
  date: 14,
} as const;

/**
 * Is this line a data row of this report?
 *
 * There is no header to key on, so detection is structural: exactly 17 fields, a
 * non-empty symbol, and a parseable `DD-MON-YYYY` where the date belongs. That
 * signature separates this file from every neighbouring feed — the SME bhavcopy
 * has 14 fields and a header, UDiFF has ~30 and a header, an HTML challenge page
 * has neither.
 */
function isEgrRow(cells: string[]): boolean {
  if (cells.length !== EGR_FIELD_COUNT) return false;
  if (!String(cells[COL.symbol] ?? "").trim()) return false;
  return parseEgrDate(cells[COL.date]) !== null;
}

/**
 * Parse one archived `EG_BC{DDMMYYYY}.DAT`.
 *
 * @returns `null` when the bytes are not this report — including for empty or
 * whitespace-only input. That is a deliberate call and it is the weakest point
 * of a header-less format: with no header there is nothing to affirm, so empty
 * bytes cannot be distinguished from wrong bytes and claiming "this IS the
 * report and it was empty" would be a guess. A zero-row EGR day has never been
 * observed (every archived object is at least one row); if one ever is, this
 * must change and the caller's "not this report" branch will have been wrong in
 * the meantime.
 *
 * Consequently a non-null result ALWAYS carries at least one row, and
 * `rows: []` is unreachable here. That is not a shortcut, it is what
 * headerlessness costs: "recognised the report" and "read a row" are the same
 * event when a row is the only thing there is to recognise. Contrast
 * `mwpl-logic.ts`, where a header makes `rows: []` a real and distinct state.
 * Unparseable lines are still counted in `reasons` alongside the rows that did
 * parse.
 */
export function parseEgrBhavcopy(text: string): EgrBhavcopyFile | null {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  const reasons: Record<string, number> = {};
  const bump = (k: string): void => {
    reasons[k] = (reasons[k] ?? 0) + 1;
  };

  const rows: EgrBhavcopyRow[] = [];
  let tradingDate: Date | null = null;
  let sawRow = false;

  for (const line of lines) {
    const cells = line.split(",");

    if (!isEgrRow(cells)) {
      // Counted, not fatal: a future file that grew a header or a trailer would
      // otherwise take every real row down with it.
      bump(
        cells.length !== EGR_FIELD_COUNT ? "field-count" : "unrecognised-line",
      );
      continue;
    }
    sawRow = true;

    const date = parseEgrDate(cells[COL.date])!;
    const symbol = String(cells[COL.symbol] ?? "")
      .trim()
      .toUpperCase();

    if (tradingDate === null) tradingDate = date;
    else if (tradingDate.getTime() !== date.getTime()) bump("mixed-date");

    rows.push({
      name: String(cells[COL.name] ?? "").trim(),
      symbol,
      series: String(cells[COL.series] ?? "")
        .trim()
        .toUpperCase(),
      market: String(cells[COL.market] ?? "")
        .trim()
        .toUpperCase(),
      date,
      prevClose: parseEgrNumber(cells[COL.prevClose]),
      open: parseEgrNumber(cells[COL.open]),
      high: parseEgrNumber(cells[COL.high]),
      low: parseEgrNumber(cells[COL.low]),
      close: parseEgrNumber(cells[COL.close]),
      tradedQty: parseEgrNumber(cells[COL.tradedQty]),
      tradedValue: parseEgrNumber(cells[COL.tradedValue]),
      unknown: EGR_UNKNOWN_COLUMNS.map((index) => ({
        index,
        raw: cells[index] ?? "",
        value: parseEgrNumber(cells[index]),
      })),
    });
  }

  // Not one line had this file's structure — these bytes are something else.
  if (!sawRow) return null;

  return { tradingDate, rows, reasons };
}
