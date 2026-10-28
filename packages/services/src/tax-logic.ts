/**
 * Tax report — PURE logic (no Prisma / cache / I/O).
 *
 * Extracted from `tax.service.ts` so the user-facing tax money path can be
 * unit-tested against the REAL exported symbols (de-shadow of
 * `apps/web/__tests__/actions/tax.test.ts`, which previously re-implemented this
 * logic inline and asserted the copy). The service imports and CALLS every
 * function here — the production path and the tests execute the same code.
 *
 * What lives here:
 *   - Financial-year math   (`getCurrentFY`, `parseFYDates`).
 *   - The PairedTradeView → tax-input row mapping (`mapPairedTradeRow`), which
 *     is the step that used to crash the WHOLE report with
 *     `RangeError: Invalid time value` whenever a single stored trade carried an
 *     unparseable `entryDate`/`exitDate`, and which used to let a NaN/Infinity
 *     price leak into the gain.
 *   - The Holding → tax-harvesting-input mapping (`mapHoldingForHarvesting`),
 *     same Invalid-Date crash vector on `createdAt`.
 *
 * The capital-gains tax CLASSIFICATION + arithmetic (STCG/LTCG by holding
 * period, the ₹1.25L s112A exemption, loss set-off, per-bucket + total tax)
 * lives in `@usemoney/research`'s `computeCapitalGainsTaxTool` and is de-shadowed
 * separately in `packages/research/__tests__/compute-capital-gains-tax.test.ts`.
 * The service composes the two; this module owns only the data-shaping the
 * service does on either side of that tool, plus the FY window the DB query and
 * the tool both key off.
 *
 * FINANCIAL-YEAR BOUNDARY (MONEY-620 fix): the Indian FY runs Apr 1 → Mar 31 in
 * IST (UTC+5:30), so the FY window MUST be expressed as the IST calendar bounds
 * converted to UTC instants — NOT a naive UTC `Apr 1 00:00Z → Mar 31 23:59Z`.
 * `fyWindowUtc` below is the single source of truth for those instants; both the
 * service's Prisma `exitDate` filter (which queries the full stored timestamp)
 * and the research capital-gains tool's FY filter (which, for the production
 * path, filters the SAME stored timestamp carried through as `sellTimestamp`)
 * key off identical bounds, so a trade at e.g. Apr 1 02:00 IST (= Mar 31 20:30
 * UTC) is no longer misfiled into the prior FY. `@usemoney/research` cannot
 * import this module (it sits BELOW services in the dep graph), so the tool
 * replicates this exact arithmetic and a cross-package test asserts the two
 * windows are bit-for-bit equal at the boundary.
 */

/**
 * The tax-input trade shape consumed downstream by
 * `computeCapitalGainsTaxTool`.
 *
 * `buyDate`/`sellDate` are `YYYY-MM-DD` (UTC date portion) — still used for the
 * holding-period (`daysBetween`) classification and for display, so their
 * semantics are UNCHANGED.
 *
 * `sellTimestamp` (MONEY-620) is the FULL ISO instant of the exit (the same
 * `exitDate` the service's Prisma window filtered). The tool prefers it for the
 * FY-window filter so the tool and the DB pre-filter classify the EXACT same
 * instant into the EXACT same IST FY — eliminating the UTC-vs-IST boundary
 * desync that could silently zero a seam trade's tax.
 */
export interface PairedTradeForFY {
  symbol: string;
  buyDate: string;
  sellDate: string;
  /** Full ISO instant of the exit (`exitDate.toISOString()`); FY-filter key. */
  sellTimestamp: string;
  buyValue: number;
  sellValue: number;
  segment: string;
}

/** The harvesting-input shape consumed by `computeTaxHarvestingTool`. */
export interface HoldingForHarvesting {
  symbol: string;
  currentValue: number;
  costBasis: number;
  buyDate: string;
}

/**
 * Minimal structural view of a `PairedTradeView` row as selected by the
 * service. Kept local (not a Prisma type) so this module stays I/O-free and the
 * tests can hand-roll rows.
 */
export interface RawPairedTradeRow {
  symbol: string;
  entryDate: Date | null | undefined;
  exitDate: Date | null | undefined;
  entryPrice: number | null | undefined;
  exitPrice: number | null | undefined;
  quantity: number | null | undefined;
  segment: string;
}

/** Minimal structural view of a `Holding` row used for harvesting. */
export interface RawHoldingRow {
  symbol: string;
  quantity: number | null | undefined;
  averagePrice: number | null | undefined;
  currentPrice: number | null | undefined;
  createdAt: Date | null | undefined;
}

/**
 * Coerce a possibly-non-finite money/quantity value to a finite number.
 *
 * A single `NaN`/`±Infinity`/`null` price or quantity coming off a corrupt sync
 * must NOT poison `buyValue`/`sellValue` (which would cascade into the gain, the
 * per-bucket totals and the headline tax, rendering as a corrupt `null`/`NaN`
 * figure on the user's filing). Non-finite → 0.
 */
export function finite(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/**
 * Return the `YYYY-MM-DD` (UTC) portion of a Date, or `null` when the Date is
 * missing or invalid.
 *
 * This is the guard that stops the report-wide crash: `new Date("garbage")` is
 * a `Date` object whose `.getTime()` is `NaN`, and calling `.toISOString()` on
 * it throws `RangeError: Invalid time value`. One such trade (or holding) used
 * to take down the ENTIRE tax report. A `null` here lets the caller skip /
 * substitute the row instead of throwing.
 */
export function safeISODate(date: Date | null | undefined): string | null {
  if (!(date instanceof Date)) return null;
  const t = date.getTime();
  if (!Number.isFinite(t)) return null;
  return date.toISOString().split("T")[0]!;
}

/**
 * Current Indian financial year in `"YYYY-YY"` form (FY runs Apr 1 → Mar 31).
 *
 * `now` is injectable so the boundary (Mar 31 vs Apr 1) is testable without
 * faking the system clock. NOTE: this uses LOCAL month/year (matching the
 * original service behaviour); on the server (UTC) that is effectively UTC.
 */
export function getCurrentFY(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed: 0=Jan … 3=Apr
  const fyStartYear = month >= 3 ? year : year - 1;
  const fyEndYear = fyStartYear + 1;
  return `${fyStartYear}-${String(fyEndYear).slice(-2)}`;
}

/**
 * India Standard Time offset from UTC, in milliseconds (UTC+5:30). IST has no
 * DST, so this is a fixed constant for all dates.
 */
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // 5h30m

/**
 * Extract the FY start year from an FY label (`"2024-25"` or `"2024-2025"`).
 * Throws `RangeError` on a malformed label so the caller can sanitize it.
 */
function fyStartYear(fy: string): number {
  const [startYear] = fy.split("-");
  const startYearNum = parseInt(startYear!, 10);
  if (!Number.isFinite(startYearNum)) {
    throw new RangeError(`Invalid financial year: ${JSON.stringify(fy)}`);
  }
  return startYearNum;
}

/**
 * The precise UTC instant bounds of an Indian Financial Year, anchored to IST.
 *
 * SINGLE SOURCE OF TRUTH for the FY window (MONEY-620). The Indian FY runs
 * Apr 1 00:00:00.000 IST → Mar 31 23:59:59.999 IST. Because the DB stores trade
 * timestamps as UTC instants, the window must be those IST wall-clock bounds
 * converted to UTC by subtracting the +5:30 offset:
 *
 *   FY "2024-25":
 *     gte = 2024-04-01T00:00:00.000 IST = 2024-03-31T18:30:00.000Z
 *     lte = 2025-03-31T23:59:59.999 IST = 2025-03-31T18:29:59.999Z
 *
 * Both bounds are INCLUSIVE (gte/lte). A trade at Apr 1 02:00 IST
 * (= Mar 31 20:30 UTC) now correctly lands in the FY that begins that Apr 1,
 * instead of the prior FY (the UTC-keyed bug).
 *
 * Implementation note: we build the IST wall-clock midnight as a UTC instant
 * (`Date.UTC(y, 3, 1)`), then subtract the IST offset to get the true UTC
 * instant of that IST moment. This is exact and DST-free.
 *
 * Throws `RangeError` on a malformed FY string — the caller
 * (`getPairedTradesForFY`) runs inside try/catch and turns that into a
 * sanitized failure rather than a leak.
 */
export function fyWindowUtc(fy: string): { gte: Date; lte: Date } {
  const y = fyStartYear(fy);
  // IST wall-clock Apr 1 00:00:00.000 of year `y`, as a UTC instant.
  const gte = new Date(Date.UTC(y, 3, 1, 0, 0, 0, 0) - IST_OFFSET_MS);
  // IST wall-clock Mar 31 23:59:59.999 of year `y+1`, as a UTC instant.
  const lte = new Date(Date.UTC(y + 1, 2, 31, 23, 59, 59, 999) - IST_OFFSET_MS);
  return { gte, lte };
}

/**
 * Parse an FY string (`"2025-26"`) to its UTC date window.
 *
 * Thin alias of `fyWindowUtc` keeping the historical `{ start, end }` field
 * names for existing call sites. The bounds are now the IST-correct instants
 * (MONEY-620): `start` = Apr 1 00:00 IST (UTC-1:8:30 earlier), `end` = Mar 31
 * 23:59:59.999 IST. The service's Prisma `exitDate` filter keys off these, so
 * the DB pre-filter is IST-accurate at the seam.
 *
 * Throws `RangeError` on a malformed FY string (e.g. `parseInt` → NaN).
 */
export function parseFYDates(fy: string): { start: Date; end: Date } {
  const { gte, lte } = fyWindowUtc(fy);
  return { start: gte, end: lte };
}

/**
 * Map one raw `PairedTradeView` row to the tax-input trade shape.
 *
 * Returns `null` when the row cannot be reliably dated (unparseable/missing
 * `entryDate` or `exitDate`) so the caller drops it instead of (a) crashing the
 * whole report on `.toISOString()` or (b) feeding the tool an undated trade that
 * could be silently misclassified STCG↔LTCG. Money fields are sanitized with
 * `finite` so a corrupt price never yields a `NaN` value.
 */
export function mapPairedTradeRow(
  row: RawPairedTradeRow,
): PairedTradeForFY | null {
  const buyDate = safeISODate(row.entryDate);
  const sellDate = safeISODate(row.exitDate);
  if (buyDate === null || sellDate === null) return null;

  // `sellDate !== null` proves `row.exitDate` is a valid Date, so `.toISOString()`
  // cannot throw. This full instant (MONEY-620) is the FY-window filter key the
  // tool prefers over the date-only `sellDate`, so the tool classifies the SAME
  // instant the service's Prisma `exitDate` window already filtered.
  const sellTimestamp = (row.exitDate as Date).toISOString();

  const quantity = finite(row.quantity);
  return {
    symbol: row.symbol,
    buyDate,
    sellDate,
    sellTimestamp,
    buyValue: finite(row.entryPrice) * quantity,
    sellValue: finite(row.exitPrice) * quantity,
    segment: row.segment,
  };
}

/**
 * Map a list of raw paired-trade rows, dropping any that cannot be dated.
 * Pure convenience wrapper used by the service.
 */
export function mapPairedTradesForFY(
  rows: RawPairedTradeRow[],
): PairedTradeForFY[] {
  const out: PairedTradeForFY[] = [];
  for (const row of rows) {
    const mapped = mapPairedTradeRow(row);
    if (mapped !== null) out.push(mapped);
  }
  return out;
}

/**
 * Map one raw `Holding` row to the tax-harvesting-input shape.
 *
 * `currentValue` falls back to cost when `currentPrice` is absent (mirrors the
 * original service). `buyDate` uses the holding's `createdAt`, falling back to
 * `fallbackTodayISO` when `createdAt` is missing OR unparseable — the latter is
 * the Invalid-Date crash fix (an Invalid `createdAt` used to throw
 * `RangeError` and take down the whole report). Money fields are `finite`-guarded.
 */
export function mapHoldingForHarvesting(
  row: RawHoldingRow,
  fallbackTodayISO: string,
): HoldingForHarvesting {
  const quantity = finite(row.quantity);
  const averagePrice = finite(row.averagePrice);
  // currentPrice falls back to averagePrice when null/0/non-finite (matches the
  // original `h.currentPrice || h.averagePrice`).
  const currentPriceRaw = finite(row.currentPrice);
  const currentPrice = currentPriceRaw || averagePrice;
  const buyDate = safeISODate(row.createdAt) ?? fallbackTodayISO;
  return {
    symbol: row.symbol,
    currentValue: currentPrice * quantity,
    costBasis: averagePrice * quantity,
    buyDate,
  };
}

/** Map a list of raw holdings to harvesting inputs (pure wrapper). */
export function mapHoldingsForHarvesting(
  rows: RawHoldingRow[],
  fallbackTodayISO: string,
): HoldingForHarvesting[] {
  return rows.map((row) => mapHoldingForHarvesting(row, fallbackTodayISO));
}
