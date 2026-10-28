/**
 * Pure helpers extracted from the "use server" stock-tabs actions so they're
 * testable without Prisma / network (MONEY-806 / 807).
 *
 * The corporate-actions warm-up writer used to do N sequential
 * findFirst+update/create round-trips on the REQUEST path (triggered from a
 * client useEffect). The hot bit — turning the classified NSE records into a
 * single, de-duplicated `createMany` payload that the DB's
 * `@@unique([symbol, exchange, actionType, exDate])` index can `skipDuplicates`
 * on — lives here as a pure function so the action issues ONE round-trip and the
 * dedup/date-guard logic is unit-tested directly.
 */

// ── Financials statement split (MONEY-393 / MONEY-779) ───────────────────────
//
// The DB returns one flat `StockFinancials[]` for an (instrument, periodType);
// each row carries a `statementType` discriminator. The financials tab needs
// the rows fanned out into income / balance / cashflow buckets. Extracted here
// (pure) so `getStockFinancialsAction` issues ONE query and the bucketing is
// unit-tested directly — and an unknown/missing statementType is dropped rather
// than mis-filed into a bucket the UI would mis-render.

/** Statement discriminator on a financials row. */
export type FinancialStatementType = "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";

/** The minimum shape `splitFinancialsByStatement` reads off each row. The
 *  action passes the full `StockFinancialRow`; only `statementType` is read
 *  here (the rest is carried through verbatim, preserving DB order). */
export interface HasStatementType {
  statementType: string | null | undefined;
}

/** Income / Balance / Cashflow buckets of financials rows. */
export interface FinancialsByStatement<T> {
  income: T[];
  balance: T[];
  cashflow: T[];
}

/**
 * Fan a flat financials list into income / balance / cashflow buckets by each
 * row's `statementType`. Rows with an unknown / missing statementType are
 * DROPPED (never mis-filed) so the UI can't render, say, a cash-flow row under
 * the income table. Order within each bucket is preserved from the input (the
 * action sends the DB's `period:"desc"` tiebreaker order; the client re-sorts
 * each bucket period-aware via `comparePeriodsDesc`).
 */
export function splitFinancialsByStatement<T extends HasStatementType>(
  rows: readonly T[]
): FinancialsByStatement<T> {
  const out: FinancialsByStatement<T> = {
    income: [],
    balance: [],
    cashflow: [],
  };
  for (const r of rows) {
    if (r.statementType === "INCOME") out.income.push(r);
    else if (r.statementType === "BALANCE_SHEET") out.balance.push(r);
    else if (r.statementType === "CASH_FLOW") out.cashflow.push(r);
  }
  return out;
}

/**
 * The fields of a parsed NSE corporate action (`NSECorporateAction`, as
 * `fetchNSECorporateActions` returns it) that the warm-up persists.
 *
 * MONEY-1535 — these are the values `parseActionSubject` already derived, the
 * SAME parse the nightly writes through `nseActionToInput`, so a warm-up row
 * and a nightly row for one event cannot disagree. The warm-up used to throw
 * that parse away and re-classify each subject with `classifyCorporateAction`,
 * whose `value` is a ratio's NUMERATOR ("Bonus 1:1" -> 1, "From Rs 10 To Rs 2"
 * -> 10), and it stored that as `ratio` — the post:pre multiplier
 * `price-adjust` divides a price history by. A 1:1 bonus would have adjusted
 * nothing and a 1:5 split would have been divided by 10. Measured on prod
 * 2026-09-23 it had written none: its 20 rows are 14 AGM and 6 DIVIDEND, all
 * with correct values, because the warm-up only runs for a symbol that has no
 * stored action at all.
 */
export interface ParsedCorporateAction {
  symbol: string;
  type: string;
  exDate: Date | null;
  recordDate: Date | null;
  details: string;
  ratio: number | null;
  oldFaceValue: number | null;
  newFaceValue: number | null;
  dividendPerShare: number | null;
}

/**
 * A single `CorporateAction` create row — main's DEPLOYED schema
 * (MONEY-840/844). `type` is the taxonomy, `ratio` is the numeric split/bonus
 * post:pre ratio, `dividendPerShare` the ₹/share dividend, and `details` a raw
 * string stored into the Json column. `exDate` is REQUIRED by the schema, so the
 * builder drops any null-ex-date row.
 */
export interface CorporateActionCreateRow {
  symbol: string;
  exchange: string;
  type: string;
  exDate: Date;
  recordDate: Date | null;
  details: string;
  ratio: number | null;
  oldFaceValue: number | null;
  newFaceValue: number | null;
  dividendPerShare: number | null;
  source: string;
}

/**
 * Cap on the number of NSE rows processed per warm-up. NSE occasionally returns
 * a very long history; bounding it keeps the single `createMany` payload small
 * and the request path cheap. The newest rows come first from the parser, so we
 * keep the head.
 */
export const CORP_ACTIONS_WARMUP_MAX_ROWS = 60;

/**
 * Self-protecting Date guard for the DB write path: coerces an Invalid Date
 * (`new Date("garbage")`) — or any nullish value — to `null` before it reaches
 * Prisma. Persisting an Invalid Date can throw (RangeError) at the Mongo
 * serialisation boundary, so the writer must not trust its input.
 */
export function safeWriteDate(d: Date | null | undefined): Date | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
}

/** Key a classified row exactly as the `@@unique` index does, so in-payload
 *  duplicates (two NSE rows for the same action) collapse before the write. The
 *  nullable `exDate` is part of the key — a null ex-date is a stable bucket. */
function uniqueKeyOf(
  symbol: string,
  exchange: string,
  type: string,
  exDate: Date | null
): string {
  return [symbol, exchange, type, exDate ? exDate.getTime() : "null"].join("|");
}

/**
 * Build the de-duplicated `createMany` payload for a corporate-actions warm-up.
 *
 *   - bounds the input to `CORP_ACTIONS_WARMUP_MAX_ROWS` (newest first),
 *   - guards every Date field so an Invalid Date never reaches Prisma,
 *   - keeps each number only when finite,
 *   - collapses in-payload duplicates on the `(symbol, exchange, type, exDate)`
 *     unique tuple (first row wins),
 *   - DROPS rows with no usable ex-date (main's `CorporateAction.exDate` is
 *     required).
 *
 * The values are the parser's own — `ratio` is its post:pre multiplier — and
 * are carried, never re-derived here (see {@link ParsedCorporateAction}).
 *
 * Pure — no network, no DB. The action pre-filters against the persisted unique
 * keys, then hands the result to `prisma.corporateAction.createMany`.
 * (`_instrumentId` is retained for call-site compatibility but unused — main's
 * deployed schema has no per-instrument relation.)
 */
export function buildCorporateActionCreateManyPayload(
  records: readonly ParsedCorporateAction[],
  exchange: string,
  _instrumentId: string | null,
  maxRows: number = CORP_ACTIONS_WARMUP_MAX_ROWS
): CorporateActionCreateRow[] {
  const bounded = records.slice(0, Math.max(0, maxRows));
  const seen = new Set<string>();
  const out: CorporateActionCreateRow[] = [];
  const finite = (v: number | null): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  for (const r of bounded) {
    const exDate = safeWriteDate(r.exDate);
    // main's CorporateAction requires exDate — a dateless row can't be persisted
    // (the live card still surfaces it via getCorporateActionsAction).
    if (!exDate) continue;
    const key = uniqueKeyOf(r.symbol, exchange, r.type, exDate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      symbol: r.symbol,
      exchange,
      type: r.type,
      exDate,
      recordDate: safeWriteDate(r.recordDate),
      details: r.details,
      ratio: finite(r.ratio),
      oldFaceValue: finite(r.oldFaceValue),
      newFaceValue: finite(r.newFaceValue),
      dividendPerShare: finite(r.dividendPerShare),
      source: "NSE",
    });
  }
  return out;
}
