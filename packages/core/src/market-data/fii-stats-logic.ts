/**
 * NSE `fii_stats_{DD-Mon-YYYY}.xls` → `MarketPositioning` — MONEY-1204 (P14 / P0.1).
 *
 * FII derivatives statistics: what foreign institutional investors bought, sold
 * and still hold in each derivative segment on one trading day. Registry family
 * `nse-fii-stats`, archived since 2020-01-01 (1,636 objects verified in the prod
 * bucket on 2026-08-15), and until now never parsed — the family had an archive
 * and no `PARSERS` entry.
 *
 * ## This is NOT the file that supplies "FII rows"
 *
 * The audit that scheduled this work said `MarketPositioning` has no FII rows and
 * that the markets page depends on this parser for them. That premise is wrong and
 * acting on it would have produced silent data loss. `nse-fao-participant-oi` /
 * `-vol` already write FII — it is one of their four participants (CLIENT, DII,
 * FII, PRO) — and both families have been parsed and enabled for some time.
 *
 * What this file adds is the two things the participant files do NOT carry:
 *
 *   1. **A per-underlying breakdown.** The participant files stop at "index
 *      futures"; this one splits that into NIFTY / BANKNIFTY / FINNIFTY /
 *      MIDCPNIFTY / NIFTYFPI / NIFTYNXT50.
 *   2. **Rupee values.** The participant files publish contract COUNTS only, and
 *      the lot size is not in them, so a notional cannot be derived. This file
 *      publishes ₹ crore alongside every count.
 *
 * ## Three traps this module exists to not fall into
 *
 * **(1) The unique key collides.** `MarketPositioning` is
 * `@@unique([date, participant, bucket, metric])`. Every row here is FII, so
 * writing `metric:"OI"` with a bucket named `FUT_IDX` would land on the exact key
 * `nse-fao-participant-oi` already owns and overwrite it — no error, no conflict,
 * the participant table just quietly loses its FII half every night. So this feed
 * writes its OWN `metric` ({@link FII_STATS_METRIC}) and its OWN bucket namespace.
 *
 * **(2) The bucket namespace cannot be reused.** `POSITIONING_BUCKETS` splits
 * options into CALL and PUT. This file does not: it publishes one `INDEX OPTIONS`
 * line covering both sides, so there is no honest mapping onto `OPT_IDX_CALL` /
 * `OPT_IDX_PUT`. Widening `POSITIONING_BUCKETS` to hold a combined member is worse
 * than useless — `parseParticipantPositioning` iterates that const as a
 * twelve-leg completeness gate, so a new member would make every participant file
 * read as incomplete. Hence {@link FII_STATS_BUCKETS}, declared here, with its
 * segments deliberately ordered `IDX_FUT` where the other namespace says
 * `FUT_IDX`, so the two can never be confused at a glance or joined by accident.
 *
 * **(3) The parent rows are SUBTOTALS.** `INDEX FUTURES` is the exact sum of the
 * six `* FUTURES` lines beneath it (verified on the 2026-08-13 file: contracts
 * agree exactly, ₹ crore to within NSE's own ±0.01 rounding). Storing parents and
 * children in one flat table means anyone who sums the table double-counts every
 * index. Rather than drop half the data, the grain is made syntactically obvious:
 * a TOTAL bucket has no `:` in it, a BREAKDOWN bucket does. {@link isFiiStatsTotal}
 * is the predicate, and the parent/child arithmetic is re-checked at parse time
 * and reported as {@link FiiStatsDiscrepancy} rather than thrown — NSE disagreeing
 * with its own totals is a fact about the file, not a reason to discard it.
 *
 * Absence rules follow the house convention (see `market-positioning-logic.ts`):
 * an unreadable cell is `null`, never `0`; a row missing either traded leg is
 * dropped whole and counted; `null` from the top-level parser means "these bytes
 * are not this report", while `rows: []` means "this IS the report and it carried
 * nothing". The two are never collapsed.
 */

import * as XLSX from "xlsx";

import { parseNseFlowDate } from "./institutional-flows";
import { parseContractCount } from "./market-positioning-logic";

// ─── Namespace ───────────────────────────────────────────────────────────────

/**
 * The `metric` every row from this feed carries.
 *
 * Load-bearing: it is what keeps these rows off the
 * `(date, participant, bucket, metric)` key that `nse-fao-participant-*` owns.
 * Changing it to "OI" or "VOLUME" silently destroys the participant feed's FII
 * rows. See the module header.
 */
export const FII_STATS_METRIC = "FII_STATS" as const;

/** The participant every row describes. The file states it once, in its title. */
export const FII_STATS_PARTICIPANT = "FII" as const;

/**
 * The four TOTAL buckets — the segment rows NSE prints in bold.
 *
 * Segment order is `IDX_FUT`, not `FUT_IDX`, on purpose: `POSITIONING_BUCKETS`
 * uses the opposite order, so a reader (or a query) can never silently mix the
 * two namespaces. Breakdown buckets extend a total with `:UNDERLYING`.
 */
export const FII_STATS_BUCKETS = [
  "IDX_FUT",
  "IDX_OPT",
  "STK_FUT",
  "STK_OPT",
] as const;

export type FiiStatsBucket = (typeof FII_STATS_BUCKETS)[number];

/** Separator between a total bucket and its per-underlying breakdown. */
export const FII_STATS_BREAKDOWN_SEP = ":" as const;

/**
 * True when `bucket` is a segment TOTAL rather than a per-underlying breakdown.
 *
 * The one thing a consumer must branch on. Summing totals and breakdowns
 * together double-counts every index — this predicate is what makes that
 * impossible to do by accident.
 */
export function isFiiStatsTotal(bucket: string): boolean {
  return !bucket.includes(FII_STATS_BREAKDOWN_SEP);
}

/** The total bucket a breakdown bucket rolls up into; itself for a total. */
export function fiiStatsParentBucket(bucket: string): string {
  const i = bucket.indexOf(FII_STATS_BREAKDOWN_SEP);
  return i === -1 ? bucket : bucket.slice(0, i);
}

// ─── Row shapes ──────────────────────────────────────────────────────────────

/**
 * One published line, already mapped onto the `MarketPositioning` column names.
 *
 * `longQty`/`shortQty` are the day's BUY and SELL contract counts — this file
 * reports flow on the traded side and a single-sided stock (open interest) that
 * has no long/short split at all, which is why OI lives in its own nullable
 * fields instead of being forced into `longQty` with a fabricated `shortQty: 0`.
 */
export interface FiiStatsRow {
  /** `IDX_FUT` | `IDX_OPT:NIFTY` | … — see {@link isFiiStatsTotal}. */
  bucket: string;
  /** Underlying for a breakdown row; `null` on a segment total. */
  underlying: string | null;
  /** Contracts bought during the session. */
  longQty: number;
  /** Contracts sold during the session. */
  shortQty: number;
  /** `longQty - shortQty`. Stored rather than derived, matching the model. */
  netQty: number;
  /** ₹ crore bought. Null when the column was blank/unreadable — never 0. */
  longValue: number | null;
  /** ₹ crore sold. */
  shortValue: number | null;
  /** `longValue - shortValue`; null when either side is null. */
  netValue: number | null;
  /** Contracts still open at end of day. Single-sided: NOT a long/short split. */
  openInterestQty: number | null;
  /** ₹ crore of open interest at end of day. */
  openInterestValue: number | null;
}

/**
 * The six published columns, by the `FiiStatsRow` field each lands in.
 *
 * One union for both the checksum and {@link FiiStatsFile.unresolvedColumns},
 * so "which column" means the same thing in both and a consumer branching on it
 * is checked by the compiler.
 */
export type FiiStatsColumn =
  | "longQty"
  | "shortQty"
  | "longValue"
  | "shortValue"
  | "openInterestQty"
  | "openInterestValue";

/** A parent total that does not equal the sum of its children. */
export interface FiiStatsDiscrepancy {
  /** The TOTAL bucket whose arithmetic failed. */
  bucket: string;
  /** Which published column disagreed. */
  column: FiiStatsColumn;
  /** What NSE printed on the parent row. */
  stated: number;
  /** What its children add up to. */
  computed: number;
  /** `computed - stated`, signed on purpose. */
  delta: number;
}

export interface FiiStatsFile {
  /** UTC midnight of the IST trading day, read from the TITLE ROW only. */
  tradingDate: Date | null;
  rows: FiiStatsRow[];
  /** Parent-vs-children mismatches. Reported, never thrown. */
  discrepancies: FiiStatsDiscrepancy[];
  /** Falsification counters — why rows were dropped. */
  reasons: Record<string, number>;
  /**
   * Columns whose HEADER could not be matched — the ones we never read at all.
   *
   * Distinct from a column that was read and found blank, and the distinction
   * is the whole reason this field exists. A `null` from a resolved column is a
   * READING ("NSE printed nothing there") and a writer should store it. A
   * `null` from a column in this list is not a reading of anything; a writer
   * that persists it OVERWRITES whatever a previous, correct parse stored — and
   * a re-walk of the archive does that to every day in it.
   *
   * Only the four optional columns can appear here: a missing `longQty` or
   * `shortQty` header makes the whole file unreadable and the parser returns
   * `null` instead (see `resolveColumns`).
   *
   * `reasons` also carries one `unresolvedColumn:<name>` per entry, so a
   * counter-only consumer sees it without knowing this field exists.
   */
  unresolvedColumns: FiiStatsColumn[];
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * ₹ crore columns tolerate NSE's own rounding. The published parent differs from
 * the summed children by up to a paise-level rounding per child row; six children
 * at ±0.005 each cannot exceed ±0.03. Contract columns get NO tolerance — they
 * are integers and any difference there is a real disagreement.
 */
const VALUE_TOLERANCE_CRORE = 0.05;

/** Matches the one place the date appears: cell A1. */
const TITLE_DATE = /(\d{1,2}-[A-Za-z]{3,}-\d{4})/;

/** Everything at or below this label is prose, not data. */
const TERMINATOR = /^\s*notes?\s*:/i;

type Grid = Array<Array<string | null>>;

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function cell(grid: Grid, r: number, c: number): string {
  return String(grid[r]?.[c] ?? "").trim();
}

/**
 * Which of the six published columns each spreadsheet column is.
 *
 * The header is TWO rows and neither is sufficient alone. The upper row is a
 * spanning band (`BUY, BUY, SELL, SELL, OPEN INTEREST…, ""`) whose last cell is
 * EMPTY rather than repeated, and the lower row repeats `No. of contracts` /
 * `Amt in Crores` three times. Classifying on the lower row alone yields three
 * indistinguishable "contracts" columns; there are no cell merges to fall back
 * on. So the band is forward-filled across the blank and combined with the sub.
 */
interface ColumnMap {
  longQty: number;
  shortQty: number;
  longValue: number;
  shortValue: number;
  openInterestQty: number;
  openInterestValue: number;
}

/** What `resolveColumns` learned: the map, plus what it could NOT match. */
interface ResolvedColumns {
  cols: ColumnMap;
  /** Optional columns whose header did not match. `-1` in `cols`. */
  unresolved: FiiStatsColumn[];
}

function resolveColumns(
  grid: Grid,
  bandRow: number,
  subRow: number,
  bump: (reason: string) => void,
): ResolvedColumns | null {
  const width = Math.max(grid[bandRow]?.length ?? 0, grid[subRow]?.length ?? 0);
  const out: Partial<ColumnMap> = {};
  let band = "";

  for (let c = 1; c < width; c++) {
    const rawBand = cell(grid, bandRow, c).toUpperCase();
    if (rawBand) band = rawBand;
    const sub = cell(grid, subRow, c).toUpperCase();
    if (!sub) continue;

    const isQty = sub.includes("CONTRACT");
    const isValue = sub.includes("CROR");
    if (!isQty && !isValue) continue;

    if (band.startsWith("BUY")) {
      if (isQty) out.longQty ??= c;
      else out.longValue ??= c;
    } else if (band.startsWith("SELL")) {
      if (isQty) out.shortQty ??= c;
      else out.shortValue ??= c;
    } else if (band.includes("OPEN INTEREST")) {
      if (isQty) out.openInterestQty ??= c;
      else out.openInterestValue ??= c;
    }
  }

  // The traded legs are what every row is built from. Open interest is optional
  // in the sense that a malformed OI header costs the OI columns, not the file.
  if (out.longQty === undefined || out.shortQty === undefined) return null;

  // Every `?? -1` below is a column we will NOT READ, and it used to be the
  // quietest thing in the module: the sentinel made `at()` return null for the
  // whole file, so re-wording ONE header ("OPEN INTEREST AT THE END OF THE DAY"
  // -> "OPEN POSITIONS AT THE END OF THE DAY", which is entirely within NSE's
  // gift) produced `rows: 16, reasons: {}, discrepancies: 0` with 0 of 16 rows
  // carrying open interest. The parent-vs-children checksum cannot catch it
  // either — it skips a column whose parent value is null, so an unresolved
  // column disables its own check. Hence an explicit counter AND a typed list;
  // `mwpl-logic.ts` refuses its file outright for the same class of defect, but
  // here the traded legs resolved fine and are worth keeping.
  const unresolved: FiiStatsColumn[] = [];
  const optional = (key: FiiStatsColumn, at: number | undefined): number => {
    if (at !== undefined) return at;
    unresolved.push(key);
    bump(`unresolvedColumn:${key}`);
    return -1;
  };

  return {
    cols: {
      longQty: out.longQty,
      shortQty: out.shortQty,
      longValue: optional("longValue", out.longValue),
      shortValue: optional("shortValue", out.shortValue),
      openInterestQty: optional("openInterestQty", out.openInterestQty),
      openInterestValue: optional("openInterestValue", out.openInterestValue),
    },
    unresolved,
  };
}

/**
 * Map a published label onto a bucket.
 *
 * Deliberately rule-based rather than a fixed list of index names: NSE has added
 * underlyings before (NIFTYNXT50 and NIFTYFPI are both recent) and a hardcoded
 * list would silently drop the next one instead of carrying it through.
 */
function bucketForLabel(
  label: string,
): { bucket: string; underlying: string | null } | null {
  const up = label.toUpperCase().trim();
  if (!up) return null;

  const seg = up.endsWith(" FUTURES")
    ? { kind: "FUT" as const, head: up.slice(0, -" FUTURES".length).trim() }
    : up.endsWith(" OPTIONS")
      ? { kind: "OPT" as const, head: up.slice(0, -" OPTIONS".length).trim() }
      : null;
  if (!seg || !seg.head) return null;

  if (seg.head === "INDEX") {
    return {
      bucket: seg.kind === "FUT" ? "IDX_FUT" : "IDX_OPT",
      underlying: null,
    };
  }
  if (seg.head === "STOCK") {
    return {
      bucket: seg.kind === "FUT" ? "STK_FUT" : "STK_OPT",
      underlying: null,
    };
  }
  // Anything else named against FUTURES/OPTIONS is an index underlying; NSE
  // publishes no per-stock breakdown in this file.
  const parent = seg.kind === "FUT" ? "IDX_FUT" : "IDX_OPT";
  return {
    bucket: `${parent}${FII_STATS_BREAKDOWN_SEP}${seg.head}`,
    underlying: seg.head,
  };
}

/**
 * Parse one archived `fii_stats_*.xls`.
 *
 * @returns `null` when the bytes are not this report at all. A non-null result
 * with `rows: []` means the report was recognised and carried no legible rows —
 * a genuinely different fact, and the caller must not collapse them.
 */
export function parseFiiStatsXls(bytes: Uint8Array): FiiStatsFile | null {
  const reasons: Record<string, number> = {};
  const bump = (k: string): void => {
    reasons[k] = (reasons[k] ?? 0) + 1;
  };

  let wb: XLSX.WorkBook;
  try {
    // `cellDates:false` matches the house reader (mf-portfolio-logic.ts): Excel
    // serials are timezone-free, whereas SheetJS would build Dates in the
    // runner's LOCAL zone. This file carries no date cells today, but the trap
    // is one upstream formatting change away.
    wb = XLSX.read(toBuffer(bytes), { type: "buffer", cellDates: false });
  } catch {
    return null;
  }

  const sheetName = wb.SheetNames?.[0];
  if (!sheetName) return null;
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return null;

  const grid = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: null,
  }) as Grid;
  if (grid.length === 0) return null;

  // ── title / date ──────────────────────────────────────────────────────────
  let tradingDate: Date | null = null;
  let titleRow = -1;
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const text = cell(grid, r, 0);
    if (!/FII\s+DERIVATIVES\s+STATISTICS/i.test(text)) continue;
    titleRow = r;
    const m = TITLE_DATE.exec(text);
    if (m) tradingDate = parseNseFlowDate(m[1]);
    break;
  }
  // The title is the identity of the report. Without it these bytes are not
  // this feed, and guessing the date from the archive key is exactly the
  // wrong-granularity substitution MONEY-1189 was about.
  if (titleRow === -1) return null;
  if (tradingDate === null) bump("noTitleDate");

  // ── header rows ───────────────────────────────────────────────────────────
  let subRow = -1;
  for (let r = titleRow + 1; r < Math.min(grid.length, titleRow + 8); r++) {
    const joined = (grid[r] ?? [])
      .map((v) => String(v ?? "").toUpperCase())
      .join("|");
    if (joined.includes("CONTRACT")) {
      subRow = r;
      break;
    }
  }
  if (subRow <= 0) return null;
  const resolved = resolveColumns(grid, subRow - 1, subRow, bump);
  if (!resolved) return null;
  const cols = resolved.cols;

  // ── data rows ─────────────────────────────────────────────────────────────
  const rows: FiiStatsRow[] = [];
  const seen = new Set<string>();

  for (let r = subRow + 1; r < grid.length; r++) {
    const label = cell(grid, r, 0);
    if (TERMINATOR.test(label)) break;
    if (!label) continue;

    const mapped = bucketForLabel(label);
    if (!mapped) {
      bump("unrecognisedLabel");
      continue;
    }

    const at = (c: number): number | null =>
      c < 0 ? null : parseContractCount(grid[r]?.[c]);

    const longQty = at(cols.longQty);
    const shortQty = at(cols.shortQty);
    // Both traded legs are required: `longQty`/`shortQty` are non-nullable in
    // the model, and defaulting a missing one to 0 would publish a fabricated
    // "FII sold nothing today".
    if (longQty === null || shortQty === null) {
      bump("nonFiniteLeg");
      continue;
    }
    if (seen.has(mapped.bucket)) {
      bump("duplicateBucket");
      continue;
    }
    seen.add(mapped.bucket);

    const longValue = at(cols.longValue);
    const shortValue = at(cols.shortValue);

    rows.push({
      bucket: mapped.bucket,
      underlying: mapped.underlying,
      longQty,
      shortQty,
      netQty: longQty - shortQty,
      longValue,
      shortValue,
      netValue:
        longValue !== null && shortValue !== null
          ? longValue - shortValue
          : null,
      openInterestQty: at(cols.openInterestQty),
      openInterestValue: at(cols.openInterestValue),
    });
  }

  return {
    tradingDate,
    rows,
    discrepancies: checkFiiStatsTotals(rows),
    reasons,
    unresolvedColumns: resolved.unresolved,
  };
}

/**
 * Re-add every breakdown row and compare against its published total.
 *
 * This is the checksum that justifies storing both grains in one table. It is
 * also the only automated way to notice NSE changing the set of underlyings: a
 * new index we failed to read shows up here as a total that exceeds its parts,
 * rather than as a number that is quietly a little too small.
 */
export function checkFiiStatsTotals(
  rows: readonly FiiStatsRow[],
): FiiStatsDiscrepancy[] {
  const out: FiiStatsDiscrepancy[] = [];
  const totals = new Map<string, FiiStatsRow>();
  const children = new Map<string, FiiStatsRow[]>();

  for (const row of rows) {
    if (isFiiStatsTotal(row.bucket)) {
      totals.set(row.bucket, row);
    } else {
      const parent = fiiStatsParentBucket(row.bucket);
      const list = children.get(parent);
      if (list) list.push(row);
      else children.set(parent, [row]);
    }
  }

  const COLUMNS: ReadonlyArray<{
    key: FiiStatsColumn;
    tolerance: number;
  }> = [
    { key: "longQty", tolerance: 0 },
    { key: "shortQty", tolerance: 0 },
    { key: "longValue", tolerance: VALUE_TOLERANCE_CRORE },
    { key: "shortValue", tolerance: VALUE_TOLERANCE_CRORE },
    { key: "openInterestQty", tolerance: 0 },
    { key: "openInterestValue", tolerance: VALUE_TOLERANCE_CRORE },
  ];

  for (const [bucket, kids] of children) {
    const parent = totals.get(bucket);
    if (!parent || kids.length === 0) continue;

    for (const { key, tolerance } of COLUMNS) {
      const stated = parent[key];
      // A null parent disables this column's check — including when the column
      // was never READ at all. That silence is why an unresolved header needs
      // its own counter (`FiiStatsFile.unresolvedColumns`) and cannot be left
      // for the checksum to notice.
      if (stated === null) continue;
      // A single unreadable child makes the sum a floor, not a total — comparing
      // it would manufacture a discrepancy out of our own gap.
      if (kids.some((k) => k[key] === null)) continue;
      const computed = kids.reduce((acc, k) => acc + (k[key] as number), 0);
      const delta = computed - stated;
      if (Math.abs(delta) > tolerance) {
        out.push({ bucket, column: key, stated, computed, delta });
      }
    }
  }
  return out;
}
