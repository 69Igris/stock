/**
 * Stock-tabs pure seams (MONEY-1062 P4a).
 *
 * Prisma-/network-free helpers extracted from the ported stock-tabs read logic so
 * the bucketing / return-window / finite-coercion maths is unit-tested directly
 * (the service injects a fake prisma; these run the SAME code the LIVE path does).
 *
 * FAITHFUL PORTS of the web-local seams:
 *   - splitFinancialsByStatement  ← apps/web/lib/actions/stock-tabs-logic.ts:48
 *   - findCloseIndexAtOrBefore    ← apps/web/lib/actions/stock-returns-logic.ts:17
 *   - pctReturnTo                 ← apps/web/lib/actions/stock-returns-logic.ts:35
 *   - numOrNull                   ← the `num()` coercion in apps/web/lib/actions/stock-tabs.ts:232
 * Those files are web-local (import from "./stock-tabs-logic" / "./stock-returns-logic")
 * and cannot be imported cross-package, so the pure bodies are re-derived here
 * VERBATIM. Behaviour is identical.
 */

// ── Finite coercion (port of stock-tabs.ts#num) ──────────────────────────────

/**
 * Coerce an arbitrary value to a finite number or `null`. A non-numeric,
 * `NaN`, or ±Infinity value becomes `null` so a poisoned upstream value can
 * never surface as "₹NaN" in a mobile card (MONEY-620 non-finite poison class).
 * Verbatim port of `num()` in apps/web/lib/actions/stock-tabs.ts:232.
 */
export function numOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Financials statement split (port of stock-tabs-logic.ts) ─────────────────

/** Statement discriminator on a financials row. */
export type FinancialStatementType = "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";

/** The minimum shape `splitFinancialsByStatement` reads off each row. */
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
 * DROPPED (never mis-filed). Order within each bucket is preserved from the
 * input. Verbatim port of apps/web/lib/actions/stock-tabs-logic.ts:48.
 */
export function splitFinancialsByStatement<T extends HasStatementType>(
  rows: readonly T[],
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

// ── Return windows (port of stock-returns-logic.ts) ──────────────────────────

/** A daily close row, most-recent-first (matches Prisma `orderBy: date desc`). */
export interface CloseRow {
  date: Date;
  close: number;
}

/**
 * Index of the first close at or before `targetDays` ago (relative to the
 * latest close, index 0). Returns -1 when no such row exists (or no data).
 * Verbatim port of apps/web/lib/actions/stock-returns-logic.ts:17.
 */
export function findCloseIndexAtOrBefore(
  closes: CloseRow[],
  targetDays: number,
): number {
  if (closes.length === 0) return -1;
  const latest = closes[0]!;
  const targetTime = latest.date.getTime() - targetDays * 24 * 60 * 60 * 1000;
  for (let i = 0; i < closes.length; i++) {
    if (closes[i]!.date.getTime() <= targetTime) return i;
  }
  return -1;
}

/**
 * Percent return from the close at `idx` to the latest close (index 0).
 * Returns null for an out-of-range index or a non-positive past close.
 * Verbatim port of apps/web/lib/actions/stock-returns-logic.ts:35.
 */
export function pctReturnTo(closes: CloseRow[], idx: number): number | null {
  if (idx < 0 || idx >= closes.length) return null;
  const past = closes[idx]!.close;
  if (!past || past <= 0) return null;
  const latest = closes[0]!;
  return ((latest.close - past) / past) * 100;
}
