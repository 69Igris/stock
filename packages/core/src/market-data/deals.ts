/**
 * Institutional deals + SLB open positions — MONEY-1100 (Data Engine P4.6).
 *
 *   NSE  `bulk.csv`               → InstitutionalDeal (dealType BULK)
 *   NSE  `block.csv`              → InstitutionalDeal (dealType BLOCK)
 *   NSE  `slb_openpos_{DDMMYYYY}` → SlbPosition
 *
 * Bulk/block are the only free feed that names WHO traded: a row is a
 * disclosed, named-counterparty print above the disclosure threshold. That is
 * what makes repeat-buyer detection and "who is accumulating this" possible at
 * all (feeds MONEY-1117), and it is why the dedupe rule below is strict about
 * never collapsing two distinct prints.
 *
 * Pure functions: no network, no Prisma. The writer joins `symbol`@`exchange`
 * to InstrumentMapping and DROPS unresolved rows with counters — never mints
 * instruments from a report file (MONEY-1085 rule), exactly as the delivery
 * writers in scripts/jobs/feed-parse.ts do.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ## Why `expectedDate` does NOT filter deal rows (the P4.1 rule INVERTED)
 * ─────────────────────────────────────────────────────────────────────
 *
 * `parseSecBhavdataFull` (delivery.ts) EXCLUDES rows whose own date disagrees
 * with `expectedDate`, because its family is date-addressable: the archive key
 * IS the trade date, so a disagreeing row is a corrupt file.
 *
 * Deals are the opposite family and the same rule would silently delete real
 * prints. `bulk.csv` / `block.csv` are single UNDATED rolling files that
 * upstream overwrites in place, which report-registry.ts states outright:
 *
 *     "ROLLING: one undated file upstream, so the dated archive key is the
 *      FETCH day, not the trade date of its rows."
 *     (report-registry.ts, `nse-bulk-deals`; `rolling: true`,
 *      `backfillable: false`)
 *
 * So `expectedDate` for these families is WHEN WE FETCHED. Filtering rows by it
 * would discard every print the snapshot is carrying from an earlier session —
 * i.e. most of the file on any Monday.
 *
 * The archived bytes corroborate it. Both fixtures were cut in the same pass,
 * and they do not agree with each other:
 *
 *     bulk_deals.sample.csv   every row 07-AUG-2026  (Friday)
 *     block_deals.sample.csv  every row 10-AUG-2026  (Monday)
 *
 * One `expectedDate` cannot be right for both. Filtering on it would parse one
 * of the two to ZERO rows while reporting success — the exact zero-signal shape
 * this subsystem keeps having to design against (MONEY-1169).
 *
 * Therefore: **every row's own Date column wins and every row is kept.**
 * `dateMismatch` is an OBSERVABILITY COUNTER ONLY, never a filter. On a rolling
 * family a non-zero count is NORMAL (it is the snapshot's lag); it turns into a
 * signal when it is the whole file for many days running, which means the
 * rolling window stopped moving and we are re-ingesting stale bytes.
 *
 * A row whose own Date will not parse is SKIPPED, never back-filled from
 * `expectedDate`: the trade date is part of the identity key below, so guessing
 * it would mint a phantom deal that can never be deduped against the real one.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ## The unique key is ALL FIELDS (non-negotiable — map §5)
 * ─────────────────────────────────────────────────────────────────────
 *
 * The same client can legitimately print the same symbol on the same side of
 * the same stock twice in one day at different prices — two separate deals,
 * both disclosed. Any key narrower than "all fields" (say symbol+client+date+
 * side) would silently swallow the second one and under-report accumulation by
 * exactly the institutions we most want to track.
 *
 * `exactDealKey` is that key, and dedupe means EXACT-DUPLICATE ONLY: identical
 * bytes in every column, which is a re-fetch artifact of the rolling snapshot
 * (the same print appears in today's file and yesterday's), not a second deal.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ## `dealType` comes from the FAMILY, never from the bytes
 * ─────────────────────────────────────────────────────────────────────
 *
 * bulk.csv and block.csv are shape-identical — same columns, same order, no
 * field anywhere that says which one you are holding. The only thing that
 * distinguishes them is the URL it came from, so the caller passes it and the
 * wiring table (family id → dealType) lives at the call site in feed-parse.ts.
 * There is nothing to sniff, and any future attempt to infer it from content is
 * guessing.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ## SLB open positions: REAL BYTES AS OF 2026-08-14 (MONEY-1200)
 * ─────────────────────────────────────────────────────────────────────
 *
 * This block used to say "SYNTHETIC UNTIL ARCHIVED — the registry's URL probed
 * 404 on 2026-08-08". The 404 was real; the conclusion drawn from it was not.
 * The path was simply wrong by one underscore. NSE's own report index
 * (`/api/daily-reports?key=SLBS`, which the drift guard has been polling since
 * MONEY-1097) names the file verbatim:
 *
 *     fileKey  SLBS-OPEN-POSITION
 *     filePath https://nsearchives.nseindia.com/archives/slbs/open_pos/
 *                                                            ^^^^^^^^
 *     file     slb_openpos_{DDMMYYYY}.csv
 *
 * The registry had `/archives/slbs/openpos/`. Fetched live 2026-08-14: 200,
 * `text/csv`, 11,577 bytes for 13-Aug-2026. So the family is now enabled and
 * `packages/core/__tests__/fixtures/slb_openpos.sample.csv` is REAL, cut from
 * that response by whole rows only.
 *
 * ### The real header — and why the parser reported zero against it
 *
 *     Sr no,Security,Series,Outstanding Quantity at the end of the day
 *
 * Byte-identical on every day sampled from 02-Jan-2020 to 14-Aug-2026, so one
 * alias set covers the whole backfill range. Note what it is NOT: the symbol
 * column is `Security`, not `Symbol`, and the quantity column is
 * `Outstanding Quantity at the end of the day`, not `Open Position`. Neither
 * spelling was in `SLB_COLUMNS`, so `locateHeader` matched nothing and the
 * parser returned `rows: [], skipped: N`. That is the header-driven degrade
 * working exactly as designed — a loud zero, not a positional misread — and it
 * is the reason there is nothing to un-poison now that the real names are in.
 *
 * There is no Date column and no Expiry column. `expectedDate` (the filename's
 * day) is therefore the row date for every row, which is sound because
 * `slb_openpos_{DDMMYYYY}.csv` is genuinely date-addressable: probed back to
 * 02-Jul-2012, and a Saturday (16-Aug-2026) / an exchange holiday
 * (15-Aug-2026) both 404, so absence stays distinguishable from a bad path.
 *
 * ### ONE ROW PER (SECURITY, SERIES) — the schema unique COLLIDES
 *
 * The file is NOT one row per security. 13-Aug-2026 carries 605 data rows for
 * 331 distinct symbols; 116 symbols appear more than once and CDSL appears 9
 * times. `Series` is the SLB month ladder (X1=Jan … X9=Sep, XO=Oct, XN=Nov,
 * XD=Dec), so a security holds open positions across several expiries at once.
 *
 * That is precisely the case `SlbPosition`'s "VERIFY ON FIRST ARCHIVE" comment
 * asked about, and the answer is the bad one: `@@unique([symbol, date])`
 * collides, and `writeSlb`'s `upsert({ where: { symbol_date } })` in
 * `scripts/jobs/feed-parse.ts` resolves the collision LAST-WRITE-WINS rather
 * than by summing. Measured on the real file: 238,395,729 shares of open
 * interest would be stored as 37,607,169 — **84.2% of the borrow demand
 * silently discarded**, with a success count of 331 to report it.
 *
 * So the parser stays FAITHFUL — one row out per row in, `series` preserved —
 * because aggregating here would bury the maturity structure inside the layer
 * least able to explain it. `SlbParseResult.multiSeriesSymbols` exists to make
 * the collision a number the writer can assert on instead of a surprise.
 * BEFORE `feed-parse` is pointed at this family, one of these must happen:
 *
 *   (a) widen the unique to `[symbol, date, series]` (keeps the ladder), or
 *   (b) have the WRITER sum openQty across series per symbol (keeps the
 *       schema, loses the ladder).
 *
 * (a) is the better trade — the ladder is signal a short-interest proxy wants —
 * but either is correct and neither is this file's call to make.
 *
 * Whichever is chosen, purge the family's parse checkpoints in the same change
 * (MONEY-1175's lesson: a writer fixed behind a DONE checkpoint never re-runs).
 */

import Papa from "papaparse";

// The deal Date column uses NSE's `DD-MMM-YYYY` (`07-AUG-2026`), the same
// convention — and the same 31-FEB rollover trap — as `sec_bhavdata_full`'s
// DATE1. Reusing the P4.1 parser rather than writing a second one keeps a fix
// to that trap landing in one place.
import { parseDeliveryDate } from "./delivery";

// ─── Shared: header-driven column resolution ─────────────────────────

/**
 * Header cells are matched on alphanumerics only, so every cosmetic difference
 * NSE ships between eras collapses to one key:
 *
 *   "Trade Price / Wght. Avg. Price"  ─┐
 *   "Trade Price/Wght.Avg.Price"      ─┼→ "tradepricewghtavgprice"
 *   "TRADE PRICE / WGHT AVG PRICE"    ─┘
 *
 * Punctuation and spacing in these headers drift constantly; the words do not.
 */
function headerKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Logical field name → accepted header spellings (already `headerKey`-ed).
 *
 * Exported with {@link locateHeader} for the debt parsers (MONEY-1204):
 * `Corporate_bond_report` opens with five preamble rows and needs the same
 * "find the header or say this is not the file" scan. A second copy of it is a
 * second place to fix when NSE re-spells a column.
 */
export type ColumnSpec = Readonly<Record<string, readonly string[]>>;

interface HeaderMatch {
  /** Index of the header row within the parsed matrix. */
  index: number;
  /** Logical field → column index. Optional fields may be absent. */
  cols: Readonly<Record<string, number>>;
}

/**
 * Scan for the row that looks like this family's header.
 *
 * Scanning rather than assuming row 0 because several NSE families open with a
 * disclaimer preamble (the map records this for `CM_52_wk_High_low`), and a
 * parser that trusts row 0 reads the disclaimer AS the header and then reports
 * every real row as malformed.
 *
 * Returns null when no row carries all `required` fields — the deliberate
 * degrade path: the caller counts every data row as skipped instead of reading
 * a drifted layout positionally.
 */
export function locateHeader(
  matrix: readonly (readonly string[])[],
  spec: ColumnSpec,
  required: readonly string[],
): HeaderMatch | null {
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row) continue;

    const cols: Record<string, number> = {};
    for (let c = 0; c < row.length; c++) {
      const key = headerKey(row[c] ?? "");
      if (!key) continue;
      for (const [logical, aliases] of Object.entries(spec)) {
        // First column wins: a duplicated header column must not silently
        // re-point a resolved field at a later, different column.
        if (cols[logical] === undefined && aliases.includes(key)) {
          cols[logical] = c;
        }
      }
    }

    if (required.every((f) => cols[f] !== undefined)) return { index: i, cols };
  }
  return null;
}

/** Read a cell by logical field name; "" when the column is absent. */
function cell(
  row: readonly string[],
  cols: Readonly<Record<string, number>>,
  field: string,
): string {
  const idx = cols[field];
  if (idx === undefined) return "";
  return (row[idx] ?? "").trim();
}

/**
 * `-`, blanks and `NA` are ABSENCE, never a value — the same convention
 * delivery.ts records for `DELIV_QTY`. NSE prints `-` in Remarks on the
 * overwhelming majority of deal rows.
 */
function text(value: string): string | null {
  const s = value.trim();
  if (!s || s === "-" || s.toUpperCase() === "NA") return null;
  return s;
}

/**
 * Numeric cell → finite number, or null.
 *
 * Commas are stripped because NSE quotes grouped quantities in some eras
 * (`"5,23,452"` — Indian lakh grouping, never a decimal separator). Papa
 * unquotes the field; without the strip, `Number("5,23,452")` is NaN and a real
 * multi-crore print is dropped as malformed.
 */
function num(value: string): number | null {
  const s = value.trim().replace(/,/g, "");
  if (!s || s === "-" || s.toUpperCase() === "NA") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse a CSV into a raw matrix. Papa does not throw on string input. */
function toMatrix(csv: string): string[][] {
  const parsed = Papa.parse<string[]>(csv, {
    header: false,
    skipEmptyLines: true,
  });
  // `data` is typed loosely by Papa; anything that is not a row of cells is
  // dropped here rather than defended against at every read site.
  return parsed.data.filter((r): r is string[] => Array.isArray(r));
}

/** ISO calendar day, the form the dedupe key and every writer index use. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ─── Institutional deals (bulk / block) ──────────────────────────────

export type InstitutionalDealType = "BULK" | "BLOCK";

export interface InstitutionalDealRow {
  /** The row's OWN trade date (UTC midnight), not the fetch day. */
  date: Date;
  symbol: string;
  /** As published. Descriptive, but part of the all-fields identity key. */
  securityName: string;
  /** The disclosed counterparty — the whole reason this feed is valuable. */
  clientName: string;
  buySell: "BUY" | "SELL";
  qty: number;
  /** `Trade Price / Wght. Avg. Price` — a VWAP when the deal filled in parts. */
  avgPrice: number;
  /** From the FAMILY (bulk.csv vs block.csv), never sniffed from the bytes. */
  dealType: InstitutionalDealType;
  /**
   * Constant "NSE": both families are NSE archive paths
   * (`/content/equities/bulk.csv`, `/content/equities/block.csv`). BSE
   * publishes its own bulk/block deals through a different endpoint that is a
   * separate registry family — do not "generalize" this field by inferring an
   * exchange from a symbol.
   */
  exchange: "NSE";
  /** null when `-` OR when the file has no Remarks column at all (block.csv). */
  remarks: string | null;
}

export interface InstitutionalDealParseResult {
  rows: InstitutionalDealRow[];
  /** Rows dropped: no header, missing identity, unparseable date/qty/price. */
  skipped: number;
  /**
   * Rows whose own date differs from `expectedDate`. COUNTER ONLY — these rows
   * ARE included in `rows`. See the module header: on a rolling snapshot the
   * archive key is the fetch day, so a mismatch is lag, not corruption.
   */
  dateMismatch: number;
}

/**
 * Column spellings. `Date`…`Remarks` are the published layout (map §5) and the
 * archived headers; the `bd*` aliases are NSE's `historicalOR` JSON field names
 * for the same columns, accepted here so a future CSV-ified history dump from
 * that endpoint resolves without a second parser.
 */
const DEAL_COLUMNS: ColumnSpec = {
  date: ["date", "dealdate", "bddtdate"],
  symbol: ["symbol", "bdsymbol"],
  securityName: ["securityname", "bdscripname", "scripname", "securitynm"],
  clientName: ["clientname", "bdclientname"],
  buySell: ["buysell", "bdbuysell", "buysellflag"],
  qty: ["quantitytraded", "bdqtytrd", "quantity", "qtytraded"],
  avgPrice: [
    "tradepricewghtavgprice",
    "bdtpwatp",
    "tradeprice",
    "wghtavgprice",
    "weightedaverageprice",
  ],
  remarks: ["remarks", "bdremarks"],
};

/**
 * Identity fields only. `securityName` and `remarks` are DELIBERATELY not
 * required: they are descriptive, and losing a whole day of institutional
 * prints because NSE renamed "Security Name" to "Scrip Name" would be a far
 * worse outcome than storing "" for a column that no longer exists.
 */
const DEAL_REQUIRED = [
  "date",
  "symbol",
  "clientName",
  "buySell",
  "qty",
  "avgPrice",
] as const;

/**
 * `BUY`/`SELL`, tolerating the `Buy`/`B` spellings older archives use.
 * Anything else is not a side and the row is skipped — never defaulted, since
 * guessing the direction of an institutional print inverts the signal.
 */
function normalizeSide(raw: string): "BUY" | "SELL" | null {
  const s = raw.trim().toUpperCase();
  if (s.startsWith("B")) return "BUY";
  if (s.startsWith("S")) return "SELL";
  return null;
}

/**
 * Parse one bulk/block deals snapshot.
 *
 * @param csv          File bytes as text.
 * @param dealType     BULK or BLOCK — from the family id; the bytes cannot say.
 * @param expectedDate The archive key's date = the FETCH day for these rolling
 *                     families. Used ONLY to count `dateMismatch`; it never
 *                     filters and never supplies a missing row date.
 */
export function parseBulkBlockDeals(
  csv: string,
  dealType: InstitutionalDealType,
  expectedDate: Date,
): InstitutionalDealParseResult {
  const matrix = toMatrix(csv);
  const rows: InstitutionalDealRow[] = [];
  let skipped = 0;
  let dateMismatch = 0;

  const header = locateHeader(matrix, DEAL_COLUMNS, DEAL_REQUIRED);
  if (!header) {
    // Layout drift, an HTML error page, or a truncated download. Every line is
    // reported as a skip so the caller sees a loud non-zero instead of a quiet
    // "0 rows, nothing wrong".
    return { rows, skipped: matrix.length, dateMismatch };
  }

  const expectedIso = isoDay(expectedDate);

  // Rows BEFORE the header (a disclaimer preamble) are not records and are not
  // counted as skips — nothing was lost.
  for (let i = header.index + 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row) continue;

    const symbol = cell(row, header.cols, "symbol");
    const clientName = cell(row, header.cols, "clientName");
    const date = parseDeliveryDate(cell(row, header.cols, "date"));
    const side = normalizeSide(cell(row, header.cols, "buySell"));
    const qty = num(cell(row, header.cols, "qty"));
    const avgPrice = num(cell(row, header.cols, "avgPrice"));

    // Identity + the two numbers that make it a deal. `qty`/`avgPrice` must be
    // strictly positive: a zero-quantity or zero-price "deal" is not a print,
    // and letting one through would poison every downstream size/VWAP
    // aggregate while looking like real data.
    if (
      !symbol ||
      !clientName ||
      !date ||
      !side ||
      qty === null ||
      qty <= 0 ||
      avgPrice === null ||
      avgPrice <= 0
    ) {
      skipped++;
      continue;
    }

    if (isoDay(date) !== expectedIso) dateMismatch++; // counted, NOT filtered

    rows.push({
      date,
      symbol,
      securityName: cell(row, header.cols, "securityName"),
      clientName,
      buySell: side,
      qty,
      avgPrice,
      dealType,
      exchange: "NSE",
      remarks: text(cell(row, header.cols, "remarks")),
    });
  }

  return { rows, skipped, dateMismatch };
}

// ─── The all-fields dedupe key ───────────────────────────────────────

const KEY_SEP = "|";

/**
 * Escape before joining. A naive `[a, b].join("|")` is not injective: a client
 * name containing the separator merges into the neighbouring field, so
 *
 *   securityName "Y|ACME", clientName "X"   →  "…|Y|ACME|X|…"
 *   securityName "Y",      clientName "ACME|X" →  "…|Y|ACME|X|…"
 *
 * collide, and one of two genuinely different institutional prints is dropped
 * as a "duplicate". Client names are free-text vendor strings we do not
 * control, so the key must be escaped, not merely delimited.
 */
function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * The unique key for an institutional deal: ALL business fields (map §5).
 *
 * Deliberately NOT narrower. The same client printing the same symbol twice in
 * a day at different prices is two disclosed deals, and both must survive —
 * so the price and quantity are part of the identity, not just attributes of
 * it. Only a byte-identical repeat (the rolling snapshot serving yesterday's
 * print again) collapses.
 *
 * Numbers enter the key as their PARSED values, so `795.00` and `795` are the
 * same key — correct, they are the same price — while `795` and `795.5` differ.
 *
 * The writer uses this both to drop exact duplicates within a file and — hashed
 * — as the stored `dedupeKey` column (see the InstitutionalDeal model). The
 * alternative, a literal 10-field `@@unique` over free-text `clientName` /
 * `securityName` / `remarks`, is not size-CAPPED on Atlas (MongoDB removed the
 * 1024-byte index-key limit in 4.2), but it is variable-width and free-text, so
 * it is both the largest index in the collection and useless as a query prefix
 * — and it would put a Float (`avgPrice`) inside a uniqueness constraint. One
 * fixed-width derived key sidesteps all three, and keeps the normalisation
 * rules in a function that can be unit- and mutation-tested. Hash at the write
 * site, not here: this returns the key's MEANING, and hashing is storage.
 */
export function exactDealKey(row: InstitutionalDealRow): string {
  return [
    row.dealType,
    row.exchange,
    isoDay(row.date),
    row.symbol,
    row.securityName,
    row.clientName,
    row.buySell,
    String(row.qty),
    String(row.avgPrice),
    row.remarks ?? "",
  ]
    .map(esc)
    .join(KEY_SEP);
}

/**
 * Separator for the `(symbol, epoch)` SLB tally key below.
 *
 * A NUL, because it cannot occur in a symbol and so needs no `esc()` pass — a
 * DIFFERENT constant from `KEY_SEP` above, whose `"|"` is injective only
 * because every field is escaped before the join.
 *
 * Written as the ESCAPE `\u0000`, never as a literal NUL byte. git classifies a
 * blob as BINARY on finding a NUL in its first 8000 bytes and then shows no
 * diff at all. This file only escaped that fate because its NUL sat at offset
 * 28,696 — one shortening edit above it away from silently becoming
 * unreviewable. Pinned by the package-wide scan in
 * `packages/core/__tests__/screener/market-fields-reader.test.ts`.
 */
const NUL_SEP = "\u0000";

// ─── SLB open positions ──────────────────────────────────────────────
//
// SYNTHETIC LAYOUT — see the module header. Verified against nothing; the
// family 404'd on probe. Header-driven so drift degrades to counted skips.

export interface SlbPositionRow {
  /** The row's own date when the file carries one, else the file's date. */
  date: Date;
  symbol: string;
  /** null when the file has no Series column. */
  series: string | null;
  /**
   * Open lending position in SHARES — the borrow-demand number. This is the
   * closest thing NSE publishes to single-stock short interest, which
   * packages/research/src/tools/fetch-short-interest.ts currently reports as
   * unavailable for India.
   */
  openQty: number;
  /**
   * ALWAYS null for `slb_openpos_{DDMMYYYY}.csv` as NSE publishes it today: the
   * file has four columns and none of them is an expiry.
   *
   * The expiry ladder is still there, encoded in `series` (X1=Jan … X9=Sep,
   * XO=Oct, XN=Nov, XD=Dec). It is deliberately NOT decoded into a date here,
   * because the code carries the month and not the year, and the year is not
   * recoverable from the row. The SLB bhavcopy for the same day proves it:
   * on 13-Aug-2026 series `X9` expires 01-SEP-**2026** while `X8` expires
   * 03-AUG-**2027** — a 12-month ladder that has already rolled past the
   * current month. The same file also shows series `S1` and `X9` sharing one
   * expiry (01-SEP-2026), so series is not even injective into expiry.
   * Deriving a date from the code would be a guess wearing a Date's clothes.
   */
  expiryDate: Date | null;
  /** Rupee value of the open position, when published. */
  openValue: number | null;
}

export interface SlbParseResult {
  rows: SlbPositionRow[];
  /** Rows dropped: no header row matched, missing symbol, bad quantity/date. */
  skipped: number;
  /**
   * How many symbols occupy MORE THAN ONE row in this file — i.e. how many
   * would collide under `SlbPosition`'s `@@unique([symbol, date])`.
   *
   * This is not a diagnostic nicety. NSE breaks open interest out per series,
   * so on a normal day this is ~116 of 331 symbols and a writer that upserts
   * on `symbol_date` silently keeps whichever row it saw last — 84.2% of the
   * open interest discarded on the day this was measured, while reporting
   * success. Any writer for this family MUST either widen its key by `series`
   * or aggregate on purpose; asserting this counter is zero is not an option,
   * because a nonzero value is the NORMAL state of the feed.
   */
  multiSeriesSymbols: number;
  /**
   * True when NO row in the file matched this family's header spec — the
   * `locateHeader` degrade, not a quiet day.
   *
   * ## Why a flag and not "infer it from `skipped`" (MONEY-1238)
   *
   * The degrade already sets `skipped = matrix.length`, so in principle a
   * caller could infer it. In practice nobody can: `skipped` ALSO counts rows
   * dropped one at a time for a bad quantity or an unparseable date, so
   * `skipped === matrix.length` is reachable both ways, and an EMPTY file
   * (a holiday, a truncated fetch) degrades to `skipped: 0` — identical to a
   * clean parse of a file with no positions.
   *
   * Those three outcomes need three different responses and this feed serves
   * them all through one shape. The two sibling families in
   * `scripts/jobs/feed-parse.ts` already print `UNRECOGNISED-FORMAT n` on
   * exactly this condition, and they can only do so because their parsers
   * return `null` for it — a signal this one cannot send without changing its
   * return type out from under its caller.
   *
   * NOTE FOR THE CALLER: `SlbTally` in `scripts/jobs/feed-parse.ts` is
   * `{ parsed, upserted }` and drops every field on this interface except
   * `rows`, so a header change currently reports "parsed 0 positions, upserted
   * 0" — byte-identical to a market holiday. This flag exists so that becomes
   * a one-line fix rather than a redesign.
   */
  unrecognisedFormat: boolean;
}

const SLB_COLUMNS: ColumnSpec = {
  date: ["date", "tradedate", "asondate", "positiondate"],
  symbol: [
    // The live header (unchanged 2020→2026) calls it `Security`. The other
    // spellings are kept: they cost nothing and this parser is also the
    // landing pad for a future NSE relabel.
    "security",
    "symbol",
    "securitysymbol",
    "scripsymbol",
  ],
  series: [
    "series",
    // MONEY-1483. NSE labelled this column `Scrip Name ` for exactly NINE
    // trading days — 25-04-2016 to 05-05-2016 — and then reverted to `Series`.
    // The DATA is identical either side of the rename (`1,ABIRLANUVO,06,100`,
    // the SLB month ladder); only the label moved.
    //
    // With one accepted spelling those nine files could not be parsed, and the
    // failure did not look like a header problem: `header.cols.series` came
    // back undefined, `text("")` produced null, the rows were emitted, and
    // `SlbPosition`'s `symbol_date_series` unique key rejected the null String
    // in the WRITER. So it surfaced as a Prisma validation error rather than at
    // any refusal site, and `feed-parse-prod` has exited 1 every night since,
    // correctly refusing to report success over ten files it could not read.
    //
    // The cohort is CLOSED at nine: the archive runs 01-04-2016 to today and
    // only that window is mislabelled.
    "scripname",
  ],
  openQty: [
    // Live header, verbatim: "Outstanding Quantity at the end of the day".
    "outstandingquantityattheendoftheday",
    "outstandingquantity",
    "openposition",
    "openpositions",
    "openqty",
    "openquantity",
    "openinterest",
    "quantity",
  ],
  expiryDate: ["expirydate", "expiry", "expirydt", "contractmonth"],
  openValue: ["openvalue", "value", "positionvalue"],
};

/** Symbol + the one number the family exists for. Everything else is optional. */
const SLB_REQUIRED = ["symbol", "openQty"] as const;

/**
 * Parse one SLB open-positions file.
 *
 * `expectedDate` is the FILENAME's date and is authoritative here, unlike the
 * deals families: `slb_openpos_{DDMMYYYY}.csv` is date-addressable, so asking
 * for a day returns THAT day. It is used as the row date whenever the file
 * carries no date column of its own; when it does carry one, the file wins
 * (the map's conflict rule), and a date column present-but-unparseable skips
 * the row rather than silently filing it under the filename's day.
 */
export function parseSlbOpenPositions(
  csv: string,
  expectedDate: Date,
): SlbParseResult {
  const matrix = toMatrix(csv);
  const rows: SlbPositionRow[] = [];
  let skipped = 0;

  const header = locateHeader(matrix, SLB_COLUMNS, SLB_REQUIRED);
  if (!header) {
    return {
      rows,
      skipped: matrix.length,
      multiSeriesSymbols: 0,
      unrecognisedFormat: true,
    };
  }

  const hasDateColumn = header.cols.date !== undefined;

  for (let i = header.index + 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row) continue;

    const symbol = cell(row, header.cols, "symbol");
    const openQty = num(cell(row, header.cols, "openQty"));

    // openQty of 0 is kept: "this security has no borrow demand today" is a
    // real, publishable fact and is not the same as an absent row.
    if (!symbol || openQty === null || openQty < 0) {
      skipped++;
      continue;
    }

    let date = expectedDate;
    if (hasDateColumn) {
      const own = parseDeliveryDate(cell(row, header.cols, "date"));
      if (!own) {
        skipped++;
        continue;
      }
      date = own;
    }

    rows.push({
      date,
      symbol,
      series: text(cell(row, header.cols, "series")),
      openQty,
      expiryDate: parseDeliveryDate(cell(row, header.cols, "expiryDate")),
      openValue: num(cell(row, header.cols, "openValue")),
    });
  }

  // Counted on (symbol, date) because that IS `SlbPosition`'s unique. Counting
  // bare symbols would over-report on a hypothetical multi-day file, and
  // counting (symbol, date, series) would always be zero and mean nothing.
  const perKey = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.symbol}${NUL_SEP}${r.date.getTime()}`;
    perKey.set(key, (perKey.get(key) ?? 0) + 1);
  }
  let multiSeriesSymbols = 0;
  for (const n of perKey.values()) if (n > 1) multiSeriesSymbols++;

  return { rows, skipped, multiSeriesSymbols, unrecognisedFormat: false };
}
