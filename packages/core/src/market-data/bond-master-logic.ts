/**
 * Debt security master — pure parsers (MONEY-1204, Data Engine P14 / 14b.1).
 *
 *   NSE `wdmlist_{DDMMYYYY}.csv`            → BondMaster (`nse-wdm-list`)
 *   NSE `Corporate_bond_report_{DD-Mon-YYYY}.csv`
 *                                           → BondMaster (`nse-corporate-bond-report`)
 *
 * Two files, one table. They do not overlap in what they cover — wdmlist is the
 * wholesale-debt universe (G-Secs, SDLs, PSU paper; 10,678 rows on 14-Aug-2026)
 * and the corporate bond report is the CBM security master (3,717 rows) — and
 * only the corporate report carries `Issuer`, `Face Value` and `Credit Rating`.
 * They agree on exactly one key: ISIN. See the `BondMaster` docblock in
 * schema.prisma for why the key is ISIN and not symbol.
 *
 * Pure: bytes in, typed rows out. No Prisma, no network, no clock. Everything
 * below is asserted against fixtures cut BY WHOLE ROWS from the prod archive
 * (`packages/core/__tests__/fixtures/nse-debt/`), not from a guessed layout —
 * MONEY-1201's synthetic SLB fixture passed green while wrong on three of four
 * columns because it encoded the same misunderstanding as its parser.
 *
 * ## The traps, and why each is a silent-wrong-answer rather than a crash
 *
 * 1. **The corporate report's header is NOT row 0 — it is row 6.** Five
 *    preamble rows come first: two banners, a `Details report for :- …` line,
 *    then two rows of bare commas. (The registry note says "two banner rows";
 *    the archived bytes say five — verified 2026-08-16.) A row-0 reader takes
 *    `,,,National Stock Exchange Of India Limited,,,` as the header and then
 *    reports all 3,717 real rows as malformed. The header is therefore FOUND,
 *    by {@link locateHeader} — the same scanner deals.ts uses, not a second
 *    copy of it.
 *
 * 2. **`Details report for :- 14-Aug-2026` is the file's own as-of date** and it
 *    beats the archive key (house rule; MONEY-1189's wrong-granularity trap is
 *    what happens when a parser trusts the key over the bytes). wdmlist has NO
 *    date anywhere in its bytes — see {@link BondMasterFile.asOf}.
 *
 * 3. **An empty `Maturity Date` is a FACT, not a gap.** Perpetual instruments
 *    (BOB / SBI / Canara Tier-1) genuinely never redeem and print an empty
 *    cell — 26 of the 54 fixture rows. Defaulting it to any date invents a
 *    redemption that will never happen; `maturityDate` stays null.
 *
 * 4. **`0` in the last-traded-price column is NSE's "never traded" filler, not
 *    a price.** In the archived bytes the correlation is exact: 34 of 60
 *    wdmlist rows and 31 of 54 corporate rows have an EMPTY last-traded date
 *    and print `0` / `0.0000`; every row that does name a trade date prints a
 *    real price. Stored as 0 it becomes a bond that trades at zero rupees, and
 *    every downstream average, chart and screener silently swallows it. The
 *    price is kept only when the file also names the day it traded — see
 *    {@link resolveLastTraded} for the three counters that make the drops
 *    visible.
 *
 * 5. **The coupon lives inside `ISSUE_NAME`** (`"8.33%"`, `"8.785%"`, `"8%"`),
 *    not in a column of its own. An unreadable coupon is null; an explicit
 *    `0%` is 0. Those are different facts and `Number("")` — which is 0 —
 *    collapses them into a real-looking zero-coupon bond.
 *
 * 6. **The two masters are told apart by their ISIN header spelling.** wdmlist
 *    writes `ISIN NO.`, the corporate report writes `ISIN`, and only the
 *    corporate report has `Issuer`. Those are the discriminators in
 *    {@link WDM_REQUIRED} / {@link CORP_REQUIRED}: loosen either alias list and
 *    each parser starts accepting the other family's bytes and quietly emits a
 *    half-empty master instead of returning "not this report".
 *
 * ## The absence contract (house rule, and the whole point of the module)
 *
 * `""`, `-` and `NA` are ABSENCE → `null`, never 0. `null` returned from a
 * top-level parser means "these bytes are not this report"; `rows: []` means
 * "this IS the report and it carried nothing". Those are different incidents
 * and collapsing them is how a 404 page gets ingested as a quiet zero-row
 * success. Every dropped row increments a named counter in `reasons` so the
 * first run that meets a shape change says where it went wrong instead of
 * silently shrinking.
 */

import Papa from "papaparse";

// The header SCANNER is shared with deals.ts on purpose. Both families open
// with a preamble, both need "find the row that looks like this file's header,
// or say this is not the file"; a second copy is a second thing to fix when
// NSE re-spells a column. `headerKey` matching is alphanumerics-only, which is
// also what absorbs the double space in the CBM header (see bond-eod-logic.ts).
import { locateHeader, type ColumnSpec } from "./deals";

// NSE prints every debt date as `DD-Mon-YYYY` (`07-Jun-2006`, `14-Aug-2026`) —
// the same convention, and the same 31-FEB rollover trap, as the delivery
// feed's DATE1. Reusing the P4.1 parser keeps a fix to that trap in one place.
import { parseDeliveryDate } from "./delivery";

// The ONE ISIN normaliser. See normalizeBondIsin.
import { normalizeMasterIsin } from "./instruments/nse-master-logic";

// ─── Types ───────────────────────────────────────────────────────────

/** The registry family id that produced a master row. */
export type BondMasterSource = "nse-wdm-list" | "nse-corporate-bond-report";

/**
 * One debt instrument, in `BondMaster`'s field names so the writer is a
 * straight mapping. `asOf` is deliberately NOT here — it is a property of the
 * FILE, not of the instrument, and lives on {@link BondMasterFile}.
 */
export interface BondMasterRow {
  /** Normalised join key: trimmed, upper-cased, >= 12 chars. */
  isin: string;
  /** Exchange short name (`CG2036`, `AXBK32`). NOT unique across the table. */
  symbol: string;
  /** `GS` | `SG` | `PT` | `AT` | … stored VERBATIM, decoded only at render. */
  secType: string;
  /** Corporate report only — wdmlist has no Issuer column at all. */
  issuer: string | null;
  /** The coupon-bearing label NSE puts the rate in (`"8.33%"`). */
  issueName: string | null;
  issueDesc: string | null;
  /** Corporate report only, and blank in every archived row so far. */
  creditRating: string | null;
  /** Annual coupon in PERCENT (7.88 = 7.88%). null ≠ 0 — see trap 5. */
  coupon: number | null;
  couponFrequency: string | null;
  /** Corporate report only. `100.00` → 100. */
  faceValue: number | null;
  issueDate: Date | null;
  /** null is MEANINGFUL: perpetual paper never matures (trap 3). */
  maturityDate: Date | null;
  nextCouponDate: Date | null;
  /** null when the file names no trade day — and then price is null too. */
  lastTradedDate: Date | null;
  /** Never 0: NSE's zero is a filler, not a price (trap 4). */
  lastTradedPrice: number | null;
  status: string | null;
  /** The registry family id these bytes came from. */
  source: BondMasterSource;
}

export interface BondMasterFile {
  /**
   * The file's OWN as-of date, read from its bytes — never from the archive
   * key (MONEY-1189).
   *
   * ALWAYS null for `wdmlist`: that family prints no date in any column, and
   * its day exists only in the object key (`wdmlist_14082026.csv`). The writer
   * must stamp `BondMaster.asOf` from the key when this is null; returning the
   * key's date from a byte parser would be a lie about where the fact came
   * from. The corporate report DOES carry one (`Details report for :- …`) and
   * it wins over the key.
   */
  asOf: Date | null;
  rows: BondMasterRow[];
  /**
   * Non-blank rows below the header that produced NO row. Blank filler rows
   * are counted under `reasons.blankRow` instead — they are not lost records.
   */
  skipped: number;
  /** Falsification counters. Every drop is named; nothing drops silently. */
  reasons: Record<string, number>;
}

// ─── Shared plumbing (also consumed by bond-eod-logic.ts) ────────────

/**
 * Parse CSV text into a raw matrix. `skipEmptyLines: true` (not `"greedy"`) is
 * deliberate: greedy would also drop the corporate report's two bare-comma
 * preamble rows, which would move the header row's index and make "the header
 * is at row 6 of the real file" untestable.
 */
export function toBondMatrix(csv: string): string[][] {
  const parsed = Papa.parse<string[]>(String(csv ?? ""), {
    header: false,
    skipEmptyLines: true,
  });
  return parsed.data.filter((r): r is string[] => Array.isArray(r));
}

/** Read a cell by logical field name; "" when the column is absent. */
export function bondCell(
  row: readonly string[],
  cols: Readonly<Record<string, number>>,
  field: string,
): string {
  const idx = cols[field];
  if (idx === undefined) return "";
  return (row[idx] ?? "").trim();
}

/** `""` / `-` / `NA` are ABSENCE, never a value. */
export function bondText(value: string): string | null {
  const s = value.trim();
  if (!s || s === "-" || s.toUpperCase() === "NA") return null;
  return s;
}

/**
 * Numeric cell → finite number, or null.
 *
 * `Number("")` is 0 and `Number("-")` is NaN; both must be null. Commas are
 * stripped because NSE quotes grouped amounts in some eras (`"1,50,000"` —
 * Indian lakh grouping, never a decimal separator).
 */
export function bondNum(value: string): number | null {
  const s = value.trim().replace(/,/g, "");
  if (!s || s === "-" || s.toUpperCase() === "NA") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Increment a named falsification counter. */
export function bump(reasons: Record<string, number>, key: string): void {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

/** True when every cell in the row is blank — filler, not a lost record. */
export function isBlankRow(row: readonly string[]): boolean {
  return row.every((c) => (c ?? "").trim() === "");
}

/**
 * The ONE ISIN normaliser for the debt feeds.
 *
 * Delegates to `normalizeMasterIsin` (instruments/nse-master-logic.ts) rather
 * than re-implementing `.trim().toUpperCase()` + the 12-char floor. That
 * function is already the shared spelling for the cash master and the bhavcopy
 * join, and two ISIN normalisers that disagree is exactly the drift this repo
 * keeps getting bitten by: `cbm_trd` prints `"INE261F08EO7 "` with a TRAILING
 * SPACE while wdmlist prints `"INE261F08EO7"`, so an un-normalised — or
 * differently-normalised — join matches nothing, which looks identical to
 * "this bond does not trade".
 *
 * It exists as its own name only so bond call-sites read in bond terms. Keep it
 * a delegation; a fork here is the bug.
 */
export function normalizeBondIsin(raw: unknown): string | null {
  return normalizeMasterIsin(
    raw === null || raw === undefined ? undefined : String(raw),
  );
}

/**
 * `"8.33%"` → 8.33. `"8%"` → 8. `"0%"` → 0. Anything else → null.
 *
 * NSE stores the coupon in the ISSUE_NAME column; there is no coupon column.
 * A label that does not resolve to a percentage (a floating-rate benchmark, a
 * blank, a strip label) is NULL and never 0 — a zero-coupon bond and a coupon
 * we failed to read are different facts, and only one of them is tradeable
 * information (`BondMaster.coupon` docblock).
 */
export function parseCouponPercent(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*%$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Last traded date + price, with NSE's zero filler removed (trap 4).
 *
 * Three named outcomes, all of which null the price:
 *   `untradedFillerZero`     no date + `0`      — the normal state of a
 *                            never-traded line; ~57% of the archived rows.
 *   `priceWithoutTradeDate`  no date + non-zero — a real-looking price with no
 *                            day to hang it on. Never observed; if it starts
 *                            firing the file changed shape.
 *   `zeroPriceWithTradeDate` date + `0`         — a trade at ₹0. Never
 *                            observed; would be a genuine data error.
 */
export function resolveLastTraded(
  dateCell: string,
  priceCell: string,
  reasons: Record<string, number>,
): { lastTradedDate: Date | null; lastTradedPrice: number | null } {
  const lastTradedDate = parseDeliveryDate(dateCell);
  const price = bondNum(priceCell);

  if (lastTradedDate === null) {
    if (price !== null) {
      bump(
        reasons,
        price === 0 ? "untradedFillerZero" : "priceWithoutTradeDate",
      );
    }
    return { lastTradedDate: null, lastTradedPrice: null };
  }
  if (price === 0) {
    bump(reasons, "zeroPriceWithTradeDate");
    return { lastTradedDate, lastTradedPrice: null };
  }
  return { lastTradedDate, lastTradedPrice: price };
}

// ─── wdmlist — the wholesale debt master ─────────────────────────────

/**
 * `wdmlist_{DDMMYYYY}.csv`, header verified against the archived 14-Aug-2026
 * file:
 *
 *   SECTYPE,SECURITY,ISSUE_NAME,ISSUE_DESC,ISSUE_DATE,MAT_DATE,Last IP Dt,
 *   Next IP Dt,Cpn Freq,Last Traded Date,Last Traded Price (in Rs.),
 *   ISIN NO.,STATUS
 *
 * `isinno` is listed alone on purpose — it is what separates this family from
 * the corporate report, whose column is plain `ISIN` (trap 6).
 */
const WDM_COLUMNS: ColumnSpec = {
  secType: ["sectype"],
  symbol: ["security"],
  issueName: ["issuename"],
  issueDesc: ["issuedesc"],
  issueDate: ["issuedate"],
  maturityDate: ["matdate"],
  nextCouponDate: ["nextipdt"],
  couponFrequency: ["cpnfreq"],
  lastTradedDate: ["lasttradeddate"],
  lastTradedPrice: ["lasttradedpriceinrs"],
  isin: ["isinno"],
  status: ["status"],
};

/** Identity + the join key. Descriptive columns may come and go. */
const WDM_REQUIRED = ["secType", "symbol", "isin"] as const;

/**
 * Parse one `wdmlist` file.
 *
 * @returns null when the bytes carry no wdmlist header — an HTML error page, a
 *          truncated download, the corporate report handed to the wrong
 *          parser, or a layout NSE re-spelled. `rows: []` with a header found
 *          is the different, valid outcome: the report published nothing.
 */
export function parseWdmList(csv: string): BondMasterFile | null {
  const matrix = toBondMatrix(csv);
  const header = locateHeader(matrix, WDM_COLUMNS, WDM_REQUIRED);
  if (!header) return null;

  const reasons: Record<string, number> = {};
  const rows: BondMasterRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  const width = (matrix[header.index] ?? []).length;

  for (let i = header.index + 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row) continue;
    if (isBlankRow(row)) {
      bump(reasons, "blankRow");
      continue;
    }
    if (row.length !== width) bump(reasons, "columnCountMismatch");

    const isin = normalizeBondIsin(bondCell(row, header.cols, "isin"));
    const symbol = bondCell(row, header.cols, "symbol");
    const secType = bondCell(row, header.cols, "secType");
    if (!isin || !symbol || !secType) {
      skipped++;
      bump(reasons, !isin ? "noIsin" : !symbol ? "noSymbol" : "noSecType");
      continue;
    }
    if (seen.has(isin)) {
      // BondMaster.isin is @unique. Keeping both rows would hand the writer a
      // last-write-wins upsert, i.e. an order-dependent master (MONEY-1201).
      // First occurrence wins and the collision is counted, never hidden.
      skipped++;
      bump(reasons, "duplicateIsin");
      continue;
    }
    seen.add(isin);

    const issueName = bondText(bondCell(row, header.cols, "issueName"));
    const coupon = parseCouponPercent(bondCell(row, header.cols, "issueName"));
    if (issueName !== null && coupon === null) bump(reasons, "couponUnparsed");

    const { lastTradedDate, lastTradedPrice } = resolveLastTraded(
      bondCell(row, header.cols, "lastTradedDate"),
      bondCell(row, header.cols, "lastTradedPrice"),
      reasons,
    );

    const maturityDate = parseDeliveryDate(
      bondCell(row, header.cols, "maturityDate"),
    );
    // Perpetual paper: the empty cell IS the fact (trap 3). Counted so the
    // share of perpetuals is visible, never defaulted.
    if (maturityDate === null) bump(reasons, "noMaturityDate");

    rows.push({
      isin,
      symbol,
      secType,
      issuer: null,
      issueName,
      issueDesc: bondText(bondCell(row, header.cols, "issueDesc")),
      creditRating: null,
      coupon,
      couponFrequency: bondText(bondCell(row, header.cols, "couponFrequency")),
      faceValue: null,
      issueDate: parseDeliveryDate(bondCell(row, header.cols, "issueDate")),
      maturityDate,
      nextCouponDate: parseDeliveryDate(
        bondCell(row, header.cols, "nextCouponDate"),
      ),
      lastTradedDate,
      lastTradedPrice,
      status: bondText(bondCell(row, header.cols, "status")),
      source: "nse-wdm-list",
    });
  }

  // wdmlist prints no date in any column — the day is in the object key only.
  return { asOf: null, rows, skipped, reasons };
}

// ─── Corporate bond report — the CBM security master ─────────────────

/**
 * `Corporate_bond_report_{DD-Mon-YYYY}.csv`, header verified against the
 * archived 14-Aug-2026 file (25 columns, row index 5):
 *
 *   Sectype,Security,Issue Name,Issue Desc,Issuer,Face Value,Credit Rating,
 *   Issue Date,Maturity Date,Record Date,Step up Coupons,Coupon Frequency,
 *   Next Coupon Date,Day Count Convention,Floating Benchmark,
 *   Spread over the Benchmark,Last Trade Date,Last trade price,
 *   Last Trade Value (Rs.in Lakhs),Last Trade Yield,Weighted Average Price,
 *   Weighted Average Yield,Traded Value (Rs. In Crores),ISIN,Status
 *
 * The trade columns are NOT read here. This file is a MASTER; its per-day
 * prices belong to `nse-cbm-trades` → BondEOD, which carries yields and both
 * trade values as well. Reading them into BondMaster too would give the same
 * fact two homes that drift apart.
 */
const CORP_COLUMNS: ColumnSpec = {
  secType: ["sectype"],
  symbol: ["security"],
  issueName: ["issuename"],
  issueDesc: ["issuedesc"],
  issuer: ["issuer"],
  faceValue: ["facevalue"],
  creditRating: ["creditrating"],
  issueDate: ["issuedate"],
  maturityDate: ["maturitydate"],
  couponFrequency: ["couponfrequency"],
  nextCouponDate: ["nextcoupondate"],
  lastTradedDate: ["lasttradedate"],
  lastTradedPrice: ["lasttradeprice"],
  isin: ["isin"],
  status: ["status"],
};

/**
 * `issuer` is required as well as identity: it is the column wdmlist does NOT
 * have, so requiring it stops a wdmlist file from parsing as a corporate
 * report (trap 6).
 */
const CORP_REQUIRED = ["secType", "symbol", "isin", "issuer"] as const;

/** `Details report for :- 14-Aug-2026` → the file's own trading day. */
const CORP_ASOF_RE =
  /details\s+report\s+for\s*:?\s*-?\s*(\d{1,2}-[A-Za-z]{3}-\d{4})/i;

/**
 * Read the as-of date out of the preamble ABOVE the header.
 *
 * Scoped to the preamble on purpose: a data cell that happens to contain the
 * phrase must not be able to redate the whole file.
 */
export function corporateBondReportAsOf(
  matrix: readonly (readonly string[])[],
  headerIndex: number,
): Date | null {
  for (let i = 0; i < headerIndex && i < matrix.length; i++) {
    for (const cell of matrix[i] ?? []) {
      const m = CORP_ASOF_RE.exec(String(cell ?? ""));
      if (m) {
        const d = parseDeliveryDate(m[1]);
        if (d) return d;
      }
    }
  }
  return null;
}

/**
 * Parse one `Corporate_bond_report` file.
 *
 * @returns null when the bytes carry no corporate-report header (see
 *          {@link parseWdmList} for the same contract).
 */
export function parseCorporateBondReport(csv: string): BondMasterFile | null {
  const matrix = toBondMatrix(csv);
  const header = locateHeader(matrix, CORP_COLUMNS, CORP_REQUIRED);
  if (!header) return null;

  const reasons: Record<string, number> = {};
  const rows: BondMasterRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  const asOf = corporateBondReportAsOf(matrix, header.index);
  if (asOf === null) bump(reasons, "noAsOfBanner");

  const width = (matrix[header.index] ?? []).length;

  for (let i = header.index + 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row) continue;
    if (isBlankRow(row)) {
      bump(reasons, "blankRow");
      continue;
    }
    if (row.length !== width) bump(reasons, "columnCountMismatch");

    const isin = normalizeBondIsin(bondCell(row, header.cols, "isin"));
    const symbol = bondCell(row, header.cols, "symbol");
    const secType = bondCell(row, header.cols, "secType");
    if (!isin || !symbol || !secType) {
      skipped++;
      bump(reasons, !isin ? "noIsin" : !symbol ? "noSymbol" : "noSecType");
      continue;
    }
    if (seen.has(isin)) {
      skipped++;
      bump(reasons, "duplicateIsin");
      continue;
    }
    seen.add(isin);

    const issueName = bondText(bondCell(row, header.cols, "issueName"));
    const coupon = parseCouponPercent(bondCell(row, header.cols, "issueName"));
    if (issueName !== null && coupon === null) bump(reasons, "couponUnparsed");

    const { lastTradedDate, lastTradedPrice } = resolveLastTraded(
      bondCell(row, header.cols, "lastTradedDate"),
      bondCell(row, header.cols, "lastTradedPrice"),
      reasons,
    );

    const maturityDate = parseDeliveryDate(
      bondCell(row, header.cols, "maturityDate"),
    );
    // Perpetual paper: the empty cell IS the fact (trap 3). Counted so the
    // share of perpetuals is visible, never defaulted.
    if (maturityDate === null) bump(reasons, "noMaturityDate");

    rows.push({
      isin,
      symbol,
      secType,
      issuer: bondText(bondCell(row, header.cols, "issuer")),
      issueName,
      issueDesc: bondText(bondCell(row, header.cols, "issueDesc")),
      creditRating: bondText(bondCell(row, header.cols, "creditRating")),
      coupon,
      couponFrequency: bondText(bondCell(row, header.cols, "couponFrequency")),
      faceValue: bondNum(bondCell(row, header.cols, "faceValue")),
      issueDate: parseDeliveryDate(bondCell(row, header.cols, "issueDate")),
      maturityDate,
      nextCouponDate: parseDeliveryDate(
        bondCell(row, header.cols, "nextCouponDate"),
      ),
      lastTradedDate,
      lastTradedPrice,
      status: bondText(bondCell(row, header.cols, "status")),
      source: "nse-corporate-bond-report",
    });
  }

  return { asOf, rows, skipped, reasons };
}
