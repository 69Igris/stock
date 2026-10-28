/**
 * Debt EOD prices — pure parser (MONEY-1204, Data Engine P14 / 14b.1).
 *
 *   NSE `cbm_trd{YYYYMMDD}.csv` → BondEOD, segment `CBM` (`nse-cbm-trades`)
 *
 * This is the price series that gives the ~12k DEBT rows in `InstrumentMapping`
 * something to show: the cash bhavcopy does not carry bonds at all, which is
 * why a bond page is empty today. 554 rows on 14-Aug-2026.
 *
 * Pure: bytes in, typed rows out. No Prisma, no network, no clock. The
 * assertions in the test file are against a fixture cut BY WHOLE ROWS from the
 * prod archive, not a guessed layout.
 *
 * ## The two traps, both confirmed in the archived bytes
 *
 * 1. **Every ISIN carries a TRAILING SPACE** — `"INE261F08EO7 "`, all 554 rows.
 *    `BondMaster.isin` (wdmlist, the corporate report) has none. Joined
 *    un-normalised, this file matches NOTHING, and "no master row for any bond
 *    that traded today" is indistinguishable from "no bond traded today". Every
 *    ISIN goes through {@link normalizeBondIsin} — the SAME normaliser the
 *    master parsers use, delegating to the same `normalizeMasterIsin` the cash
 *    master and bhavcopy join on. Two normalisers that disagree is the drift
 *    class this repo keeps getting bitten by.
 *
 * 2. **The weighted-average-price header has a DOUBLE SPACE** —
 *    `"Weighted Average Price  (Rs.)"` — which the registry note flags with
 *    "do not normalise it away". It is matched on alphanumerics only
 *    (`headerKey` in deals.ts), so the doubled space, the `(Rs.)` and any
 *    future re-spacing all collapse to `weightedaveragepricers` and resolve.
 *    Matching on the raw string instead would drop the VWAP column silently —
 *    a null WAP on every row, with the row itself looking healthy.
 *
 * ## Dates come from the ROW, never from the archive key
 *
 * `BondEOD.date` is read from the file's own `Trade Date` column. The key and
 * the column agree on an ordinary night and diverge on a replay, a late
 * publication or a re-walk — the MONEY-1189 wrong-granularity trap. A row whose
 * own date will not parse is SKIPPED, never back-filled from anything: the date
 * is part of the unique key, so guessing it mints a phantom print that can
 * never be deduped against the real one.
 *
 * ## Absence
 *
 * `""` / `-` / `NA` → null, never 0 (`Number("")` is 0). Note this file DOES
 * publish genuine zeros — `IN0020250059` prints `0.00` lacs last-trade value
 * against a real 97.5396 price — so a blanket "0 means missing" rule would be
 * wrong HERE, which is exactly why the zero-filler rule in bond-master-logic.ts
 * is scoped to the master files' last-traded price, where an empty trade date
 * corroborates it row by row.
 */

import {
  bondCell,
  bondNum,
  bump,
  isBlankRow,
  normalizeBondIsin,
  toBondMatrix,
} from "./bond-master-logic";
import { locateHeader, type ColumnSpec } from "./deals";
import { parseDeliveryDate } from "./delivery";

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Which segment's file a row came from. IN THE UNIQUE KEY on `BondEOD`: the
 * same ISIN can print on the same day in both segments at different prices,
 * and collapsing them makes the stored row order-dependent (MONEY-1201's SLB
 * lesson, where 84.2% of open interest vanished to a last-write-wins upsert).
 */
export type BondSegment = "CBM" | "WDM";

/** The registry family id that produced an EOD row. */
export type BondEodSource = "nse-cbm-trades" | "nse-wdm-daily";

/** One traded debt instrument on one day, in `BondEOD`'s field names. */
export interface BondEodRow {
  /** Normalised join key — trailing space stripped, upper-cased. */
  isin: string;
  /** The row's OWN trade date (UTC midnight), never the archive key's day. */
  date: Date;
  segment: BondSegment;
  lastPrice: number | null;
  lastYtm: number | null;
  /** Volume-weighted average price — the double-space column. */
  wapPrice: number | null;
  wtdYtm: number | null;
  /** Rs in LACS, the file's own unit, UNCONVERTED (the name carries it). */
  lastTradeValueLacs: number | null;
  totalTradeValueLacs: number | null;
  source: BondEodSource;
}

export interface BondEodFile {
  rows: BondEodRow[];
  /**
   * Non-blank rows below the header that produced NO row. Blank filler rows
   * are counted under `reasons.blankRow` instead — they are not lost records.
   */
  skipped: number;
  /** Falsification counters. Every drop is named; nothing drops silently. */
  reasons: Record<string, number>;
}

// ─── Column spellings ────────────────────────────────────────────────

/**
 * `cbm_trd{YYYYMMDD}.csv`, header verified against the archived 14-Aug-2026
 * file (the double space after `Price` is real):
 *
 *   Trade Date,ISIN,Last Trade Price (in Rs.),Last Trade Value (Rs. in lacs),
 *   Total Trade Value (Rs. in lacs),
 *   Last Trade Yield (YTM) (Annualized) (%),Weighted Average Price  (Rs.),
 *   Weighted Average Yield (YTM) (%)
 *
 * Keys are alphanumerics-only, so `"Weighted Average Price  (Rs.)"` and
 * `"Weighted Average Price (Rs.)"` are the same key. The shorter
 * `weightedaverageprice` spelling is accepted too — that is what the corporate
 * bond report calls the same quantity, so a future CBM file that drops the
 * `(Rs.)` suffix still resolves instead of silently nulling the VWAP.
 */
const CBM_COLUMNS: ColumnSpec = {
  date: ["tradedate"],
  isin: ["isin"],
  lastPrice: ["lasttradepriceinrs", "lasttradeprice"],
  lastTradeValueLacs: ["lasttradevaluersinlacs", "lasttradevaluersinlakhs"],
  totalTradeValueLacs: ["totaltradevaluersinlacs", "totaltradevaluersinlakhs"],
  lastYtm: ["lasttradeyieldytmannualized", "lasttradeyield"],
  wapPrice: ["weightedaveragepricers", "weightedaverageprice"],
  wtdYtm: ["weightedaverageyieldytm", "weightedaverageyield"],
};

/**
 * Identity + the one mandatory price, the same bar `parseSecBhavdataFull` sets:
 * a debt EOD row with no price is not worth storing. The four remaining value
 * columns are deliberately NOT required — losing a whole day of debt prices
 * because NSE renamed a yield column would be far worse than storing null for
 * it, and a column that stops resolving shows up as a null on every row.
 */
const CBM_REQUIRED = ["date", "isin", "lastPrice"] as const;

// ─── Parser ──────────────────────────────────────────────────────────

/**
 * Parse one `cbm_trd` file.
 *
 * @returns null when the bytes carry no CBM header — an HTML error page, a
 *          truncated download, or a layout NSE re-spelled. `rows: []` with a
 *          header found is the different, valid outcome: a session in which
 *          no corporate bond traded. Collapsing the two is how a 404 page gets
 *          ingested as a quiet zero-row success.
 */
export function parseCbmTrades(csv: string): BondEodFile | null {
  const matrix = toBondMatrix(csv);
  const header = locateHeader(matrix, CBM_COLUMNS, CBM_REQUIRED);
  if (!header) return null;

  const reasons: Record<string, number> = {};
  const rows: BondEodRow[] = [];
  const seen = new Set<string>();
  const days = new Set<string>();
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
    const date = parseDeliveryDate(bondCell(row, header.cols, "date"));
    if (!isin || !date) {
      skipped++;
      bump(reasons, !isin ? "noIsin" : "unparseableTradeDate");
      continue;
    }

    const isoDay = date.toISOString().slice(0, 10);
    const key = `${isin}|${isoDay}`;
    if (seen.has(key)) {
      // @@unique([isin, date, segment]) on BondEOD. Two rows for one key would
      // become a last-write-wins upsert — an order-dependent price. First
      // occurrence wins and the collision is counted, never hidden.
      skipped++;
      bump(reasons, "duplicateIsinDate");
      continue;
    }
    seen.add(key);
    days.add(isoDay);

    rows.push({
      isin,
      date,
      segment: "CBM",
      lastPrice: bondNum(bondCell(row, header.cols, "lastPrice")),
      lastYtm: bondNum(bondCell(row, header.cols, "lastYtm")),
      wapPrice: bondNum(bondCell(row, header.cols, "wapPrice")),
      wtdYtm: bondNum(bondCell(row, header.cols, "wtdYtm")),
      lastTradeValueLacs: bondNum(
        bondCell(row, header.cols, "lastTradeValueLacs"),
      ),
      totalTradeValueLacs: bondNum(
        bondCell(row, header.cols, "totalTradeValueLacs"),
      ),
      source: "nse-cbm-trades",
    });
  }

  // One `cbm_trd` file is one session. More than one distinct day in it means
  // the family stopped being same-day-addressable (or the archive served the
  // wrong object), which the writer must see BEFORE it stamps a date on
  // anything. Counter only — every row still keeps its own date.
  if (days.size > 1) reasons.multipleTradeDates = days.size;

  return { rows, skipped, reasons };
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* WDM daily trades — the OTHER half of BondEOD.segment (MONEY-1210)          */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * `BondEOD.segment` has always been `"CBM" | "WDM"`, and only CBM had a parser:
 * `bond_eod` held nothing but corporate-bond rows while the wholesale-debt half
 * of the schema sat unused. `nse-wdm-daily` is that half.
 *
 * ## Three things about this feed that the CBM path does not have to deal with
 *
 * **1. It is a MULTI-MEMBER zip.** `dly{DDMMYYYY}.zip` (17-Aug-2026) contains
 * six members in this local-header order:
 *
 *     trd1708_sett.csv   the settled trades   <- what we parse
 *     trd1708.xls        the same, as XLS
 *     add20260817.csv    issues added today
 *     mat20260817.csv    issues matured today
 *     dmr1708.docx       the daily market report
 *     Legend.doc         column legend
 *
 * `decodeFeedText` -> `unzipSingleEntry` returns the FIRST local entry, which
 * is the trades CSV. That is a dependency on member ordering, and it is left as
 * one deliberately: if NSE ever reorders, the decoder hands us the `.xls`, its
 * bytes carry no WDM header, `parseWdmTrades` returns `null`, and the writer
 * raises `UnreadableFeedFile` — NOT checkpointed, retried, and visible. The
 * failure mode of the fragile assumption is loud, so hardening it into member
 * selection would buy nothing today and add a second zip reader to maintain.
 *
 * **2. It carries NO ISIN.** Every other bond file joins on ISIN; this one
 * identifies an instrument by `Security` + `Issue Name` (`CG2032` + `6.54%`).
 * `Security` ALONE is not enough — measured on `wdmlist_17082026.csv`, 1,352 of
 * 2,488 distinct securities repeat, which is the same fact `BondMaster.symbol`
 * already documents ("BOB appears four times ... four different ISINs"). The
 * PAIR is what resolves: 10,666 distinct pairs across 10,673 master rows, and
 * all 21 trades in the 17-Aug file resolved to exactly one ISIN each. The seven
 * pairs that map to two ISINs are REFUSED by {@link resolveWdmTrades}, never
 * guessed — see its doc.
 *
 * **3. Its money column is in CRORES, not lacs.** The header says
 * `Traded Value (Rs.Cr.)` while the field it feeds is `totalTradeValueLacs`,
 * whose name carries its unit by contract. One crore is one hundred lacs, so
 * the value is multiplied by 100 on the way in. Storing 150.00 (crores) in a
 * lacs-named column would understate every WDM trade by 100x while looking
 * entirely reasonable next to CBM rows — the unit class of bug this repo keeps
 * finding (statement figures divided by 1e7 despite already being in crores).
 */

/** One WDM trade BEFORE its ISIN is known — the parser cannot resolve it. */
export interface WdmTradeRow {
  /** `Security`, e.g. `CG2032`. NOT unique on its own. */
  symbol: string;
  /** `Issue Name`, e.g. `6.54%` or `310826`. The disambiguator. */
  issueName: string;
  /** The row's OWN trade date (UTC midnight). */
  date: Date;
  lastPrice: number | null;
  wapPrice: number | null;
  wtdYtm: number | null;
  /** Already converted from the file's CRORES into LACS (x100). */
  totalTradeValueLacs: number | null;
}

export interface WdmTradesFile {
  rows: WdmTradeRow[];
  skipped: number;
  reasons: Record<string, number>;
}

/**
 * `trd{DDMM}_sett.csv`, header verified against the archived 17-Aug-2026 file:
 *
 *   Trade date,Sectype,Security,Issue Name,Settl Days,Trade Type,No.of Trades,
 *   Traded Value (Rs.Cr.),Low Price/Rate,High Price/Rate,
 *   Last Traded Price/Rate,Value Weighted Average Price/Rate,Weighted YTM
 *
 * `Low Price/Rate` and `High Price/Rate` are parsed by nobody — `BondEOD` has
 * no columns for them. Adding them would be a schema change, not a parse fix.
 */
const WDM_TRADE_COLUMNS: ColumnSpec = {
  date: ["tradedate"],
  symbol: ["security"],
  issueName: ["issuename"],
  lastPrice: ["lasttradedpricerate", "lasttradedprice"],
  wapPrice: ["valueweightedaveragepricerate", "valueweightedaverageprice"],
  wtdYtm: ["weightedytm"],
  tradedValueCrores: ["tradedvaluerscr", "tradedvalue"],
};

/**
 * Identity plus the one mandatory price, the same bar `parseCbmTrades` sets.
 * `issueName` is REQUIRED even though it is only a disambiguator: without it a
 * row cannot be resolved to an ISIN at all, so admitting it would just move the
 * drop from here to the resolver and lose the reason.
 */
const WDM_TRADE_REQUIRED = [
  "date",
  "symbol",
  "issueName",
  "lastPrice",
] as const;

/**
 * Parse one `trd*_sett.csv`.
 *
 * @returns null when the bytes carry no WDM trades header — a wrong zip member,
 *          an HTML error page, or a layout NSE re-spelled. `rows: []` with a
 *          header found is the different, valid outcome: a session in which no
 *          wholesale-debt instrument traded. Collapsing the two is how a 404
 *          page becomes a quiet zero-row success.
 */
export function parseWdmTrades(csv: string): WdmTradesFile | null {
  const matrix = toBondMatrix(csv);
  const header = locateHeader(matrix, WDM_TRADE_COLUMNS, WDM_TRADE_REQUIRED);
  if (!header) return null;

  const reasons: Record<string, number> = {};
  const rows: WdmTradeRow[] = [];
  const seen = new Set<string>();
  const days = new Set<string>();
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

    const symbol = bondCell(row, header.cols, "symbol").trim().toUpperCase();
    const issueName = bondCell(row, header.cols, "issueName").trim();
    const date = parseDeliveryDate(bondCell(row, header.cols, "date"));

    if (!symbol || !issueName || !date) {
      skipped++;
      bump(
        reasons,
        !date ? "unparseableTradeDate" : !symbol ? "noSymbol" : "noIssueName",
      );
      continue;
    }

    const isoDay = date.toISOString().slice(0, 10);
    // Dedupe on the RESOLUTION key, not on the eventual ISIN — two rows for one
    // (symbol, issue, day) would collapse to one last-write-wins upsert once
    // resolved, and the collision has to be counted where it is still visible.
    const key = `${symbol}|${issueName}|${isoDay}`;
    if (seen.has(key)) {
      skipped++;
      bump(reasons, "duplicateSymbolIssueDate");
      continue;
    }
    seen.add(key);
    days.add(isoDay);

    // CRORES -> LACS. See the header note; the field name carries the unit.
    const crores = bondNum(bondCell(row, header.cols, "tradedValueCrores"));

    rows.push({
      symbol,
      issueName,
      date,
      lastPrice: bondNum(bondCell(row, header.cols, "lastPrice")),
      wapPrice: bondNum(bondCell(row, header.cols, "wapPrice")),
      wtdYtm: bondNum(bondCell(row, header.cols, "wtdYtm")),
      totalTradeValueLacs: crores === null ? null : crores * 100,
    });
  }

  if (days.size > 1) reasons.multipleTradeDates = days.size;

  return { rows, skipped, reasons };
}

/** A `BondMaster` row reduced to what the WDM join needs. */
export interface WdmMasterKey {
  isin: string;
  symbol: string;
  issueName: string | null;
}

export interface WdmResolution {
  rows: BondEodRow[];
  /** Named drops. `ambiguousPair` and `noMasterMatch` are the two that matter. */
  reasons: Record<string, number>;
}

/**
 * Resolve parsed WDM trades to ISINs against `BondMaster`.
 *
 * Kept separate from {@link parseWdmTrades} and pure, so the join is testable
 * without a database — the same split `writeBondEod` already uses, where the
 * parser knows the file and the writer knows the DB.
 *
 * ## Ambiguity is refused, not guessed
 *
 * Seven `(symbol, issueName)` pairs in the 17-Aug master map to two ISINs each
 * (`RECL27`/`7.38%` -> `INE020B07GV8` + `INE020B07GX4`). Picking either would
 * file a real price against a possibly-wrong instrument, and nothing downstream
 * could tell. Those rows are dropped and counted under `ambiguousPair`. A
 * dropped price is a gap; a misattributed price is a lie, and the gap is
 * recoverable.
 *
 * `noMasterMatch` is the other named drop: a security that traded but is not in
 * `wdmlist`. Unlike `writeBondEod`'s `noMasterRow` — which is a COVERAGE PROBE
 * that still writes the row, because a price with no master row is still a
 * price — this one MUST drop, because without the master there is no ISIN and
 * `BondEOD` has no other key to write under.
 */
export function resolveWdmTrades(
  trades: readonly WdmTradeRow[],
  masters: readonly WdmMasterKey[],
): WdmResolution {
  const reasons: Record<string, number> = {};

  // (symbol, issueName) -> the ISINs claiming it. A Set, so a pair repeated
  // with the SAME isin (a duplicated master row) stays unambiguous.
  const byPair = new Map<string, Set<string>>();
  for (const m of masters) {
    if (!m.issueName) continue;
    const key = `${m.symbol.trim().toUpperCase()}|${m.issueName.trim()}`;
    const set = byPair.get(key) ?? new Set<string>();
    set.add(m.isin);
    byPair.set(key, set);
  }

  const rows: BondEodRow[] = [];
  for (const t of trades) {
    const isins = byPair.get(`${t.symbol}|${t.issueName}`);
    if (!isins || isins.size === 0) {
      bump(reasons, "noMasterMatch");
      continue;
    }
    if (isins.size > 1) {
      bump(reasons, "ambiguousPair");
      continue;
    }
    const isin = [...isins][0];
    if (!isin) {
      bump(reasons, "noMasterMatch");
      continue;
    }
    rows.push({
      isin,
      date: t.date,
      segment: "WDM",
      lastPrice: t.lastPrice,
      // The WDM settled-trades file publishes neither a last-trade yield nor a
      // last-trade value — only the weighted ones and the day's total. Null is
      // the honest value; a copy of wtdYtm would invent a distinct measure.
      lastYtm: null,
      wapPrice: t.wapPrice,
      wtdYtm: t.wtdYtm,
      lastTradeValueLacs: null,
      totalTradeValueLacs: t.totalTradeValueLacs,
      source: "nse-wdm-daily",
    });
  }

  return { rows, reasons };
}
