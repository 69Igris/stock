/**
 * V1 query-filter guards (MONEY-1062)
 *
 * Enum/date/FY validation for the list + report endpoints (`trades`, `paired`,
 * `positions`, `tax`). A garbage `?broker` / `?status` / `?fromDate|?toDate` /
 * `?fy` used to reach a Prisma enum / DateTime column (or `fyStartYear`)
 * verbatim and throw — turning a stray query string into a 500. These pure
 * guards let the route reject such input with a 400 BEFORE the service, WITHOUT
 * changing behaviour for any value the downstream code already accepts. Dropping
 * an invalid filter silently is NOT an option: it would widen the read to ALL
 * rows (wrong data), so an invalid filter is a 400.
 *
 * @see packages/services/src/trades-logic.ts (buildTradeWhereClause /
 *      buildPairedViewWhereClause), positions.service.ts, and tax-logic.ts
 *      (fyStartYear) for the accepted broker/status/date/FY semantics these
 *      guards mirror.
 * @see apps/api/__tests__/routes/v1-filters.test.ts
 */

import type { BrokerType, PairedTradeStatus } from "@usemoney/database";

// One entry per BrokerType — a Record keyed by the enum is exhaustive at COMPILE
// time, so if schema.prisma's `enum BrokerType` gains/renames a value this fails
// to build instead of silently 400-ing the new broker. The import is type-only,
// so the Prisma client is NOT pulled into the route bundle / api test harness.
const BROKER_TYPES: Record<BrokerType, true> = {
  ZERODHA: true,
  UPSTOX: true,
  FYERS: true,
  DHAN: true,
  ANGEL_ONE: true,
  GROWW: true,
  ICICI: true,
  HDFC: true,
  INTERACTIVE_BROKERS: true,
  ZERODHA_CONNECT: true,
  MANUAL: true,
};

/**
 * Canonical BrokerType values. Materialised as an ARRAY (not queried via the
 * `in` operator on {@link BROKER_TYPES}) so membership can't false-positive on a
 * prototype key like `"constructor"`/`"toString"`.
 */
export const BROKER_TYPE_VALUES: readonly string[] = Object.keys(BROKER_TYPES);

// Exhaustive at compile time (see BROKER_TYPES rationale) — OPEN/CLOSED/PARTIAL.
const PAIRED_TRADE_STATUSES: Record<PairedTradeStatus, true> = {
  OPEN: true,
  CLOSED: true,
  PARTIAL: true,
};

/** Canonical PairedTradeView status values (OPEN/CLOSED/PARTIAL). */
export const PAIRED_TRADE_STATUS_VALUES: readonly string[] = Object.keys(
  PAIRED_TRADE_STATUSES,
);

/**
 * Is `broker` a value the trade / position / paired where-clause builders
 * accept? Absent/empty → `true` (no filter, unchanged). The builders also honour
 * the `"all"` / `"manual"` sentinels and a `"BROKER:brokerUserId"` split whose
 * BROKER portion is a real enum, so we validate that superset — every value the
 * builders handle stays valid byte-for-byte, and only a value that would hit
 * Prisma's `broker` enum validator is rejected.
 */
export function isValidBrokerFilter(broker: string | undefined): boolean {
  if (!broker || broker === "all" || broker === "manual") return true;
  const colon = broker.indexOf(":");
  const base = colon === -1 ? broker : broker.slice(0, colon);
  return BROKER_TYPE_VALUES.includes(base);
}

/**
 * Is `status` a PairedTradeView status filter the view accepts? Absent/empty or
 * `"all"` → `true` (unfiltered, unchanged); otherwise must be OPEN/CLOSED/PARTIAL.
 */
export function isValidPairedStatusFilter(status: string | undefined): boolean {
  if (!status || status === "all") return true;
  return PAIRED_TRADE_STATUS_VALUES.includes(status);
}

/**
 * Does `value` parse to a real Date? Absent/empty → `true` (no filter — the
 * services treat a falsy date as "unset"). A non-parseable string would reach
 * Prisma as an Invalid Date and throw → 500, so reject it here with a 400.
 */
export function isParseableDate(value: string | undefined): boolean {
  if (!value) return true;
  return !Number.isNaN(Date.parse(value));
}

/**
 * Is `fy` a well-formed Indian financial-year label? Absent/empty → `true` (the
 * tax service defaults to the current FY). Otherwise must be `YYYY-YY`
 * (e.g. "2024-25") or `YYYY-YYYY` (e.g. "2024-2025") — the forms `fyStartYear`
 * (tax-logic.ts) parses. A malformed label (e.g. "garbage", "FY2024-25") makes
 * `parseInt(startYear)` NaN → `fyStartYear` throws `RangeError` → 500; reject it
 * here with a 400 instead.
 */
export function isValidFinancialYear(fy: string | undefined): boolean {
  if (!fy) return true;
  return /^\d{4}-(\d{2}|\d{4})$/.test(fy);
}
