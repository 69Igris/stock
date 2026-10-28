/**
 * Whose accounts a `StockFinancials` figure describes — MONEY-1300.
 *
 * ## Why a reader has to say this out loud
 *
 * An Indian company files the SAME period twice under SEBI/Ind AS —
 * CONSOLIDATED (parent + subsidiaries) and STANDALONE (parent alone) — and for
 * a holding company the two differ by a MULTIPLE, not a rounding: 360ONE FY2025
 * `totalAssets` is 19,768 Cr consolidated against 7,332 Cr standalone.
 *
 * Measured on prod 2026-08-31, of 2,467 symbols carrying an annual period:
 *
 *   1,786 (72%)  file BOTH bases
 *     664        standalone only
 *      17        consolidated only
 *
 * `StockFinancials` deliberately keeps ONE row per period — `basis` is NOT in
 * its `@@unique`, because two rows per period is exactly how every reader would
 * start double-counting while looking entirely normal. Consolidated-preferred
 * with standalone fallback is the ratified selection rule, so the stored number
 * is correct but AMBIGUOUS until the basis is displayed beside it. This module
 * is the one place that decides how the column is read.
 *
 * ## The four inputs, and why UNKNOWN and ABSENT must land together
 *
 *   "CONSOLIDATED"  the projection's normal write
 *   "STANDALONE"    a period the company filed standalone only
 *   "UNKNOWN"       a vendor row, being backfilled separately
 *   ABSENT          ~32,359 pre-existing rows. On MongoDB a `db push` creates
 *                   indexes and never fields, so the attribute is MISSING
 *                   rather than null on every row the projection has not yet
 *                   rewritten (the class behind MONEY-1050 / 1234 / 1235).
 *
 * Absent and "UNKNOWN" are the same state to a reader — we do not know — and
 * both must resolve to UNKNOWN. Defaulting either to CONSOLIDATED is the exact
 * failure this exists to prevent: it would print a confident provenance over a
 * number that may be the parent alone.
 *
 * ## It is provenance, never a guard
 *
 * Nothing in this module filters. `basis` must never appear in a Prisma `where`
 * — and specifically never as `basis: null`, which on Mongo matches no absent
 * field and returns ZERO rows.
 *
 * Case-insensitive on purpose. `XbrlFiling.basis` is normalised to upper case at
 * ingest (`workers/src/processors/xbrl-sync.ts:1607`) and the projection copies
 * that value through, but the filing METADATA it is parsed from is lower case
 * ("consolidated" / "non-consolidated"), so a case-sensitive match here is one
 * writer refactor away from silently reclassifying the whole table as UNKNOWN.
 *
 * ## NOT `FinancialsBasis` in `docs-section-logic.ts`
 *
 * That type is two-valued (`CONSOLIDATED | STANDALONE`) with a CONSOLIDATED
 * default and a user-facing toggle, and it is correct for what it serves:
 * `DocumentFinancials` carries `basis` INSIDE its `@@unique`, so both bases
 * exist as separate rows and a reader can genuinely switch between them. Here
 * there is exactly one row and no toggle to offer — the third state and the
 * refusal to default are the whole point, which is why this is a separate
 * vocabulary rather than a widening of that one.
 */

/** The three states a reader can be in about a `StockFinancials` figure. */
export type StockFinancialsBasis = "CONSOLIDATED" | "STANDALONE" | "UNKNOWN";

/**
 * Any stored `basis` value → the state a reader should render.
 *
 * Absent, null, empty, and an unrecognised label all collapse to UNKNOWN. This
 * is deliberately NOT `parseBasis`'s rule in `xbrl-filing-index.ts`, which
 * resolves an unrecognised label to STANDALONE: that is a WRITER choosing the
 * conservative reading of a filing it is about to store, while this is a READER
 * describing a row it did not write. Inventing a basis for a display label
 * would put a claim on screen that no filing supports.
 */
export function normalizeStockFinancialsBasis(
  value: unknown,
): StockFinancialsBasis {
  if (typeof value !== "string") return "UNKNOWN";
  const s = value.trim().toUpperCase();
  if (s === "CONSOLIDATED") return "CONSOLIDATED";
  if (s === "STANDALONE") return "STANDALONE";
  return "UNKNOWN";
}

/**
 * A whole statement's basis, or MIXED when its periods disagree.
 *
 * MIXED is a property of the COLLECTION, not a fifth value of the column: it is
 * reachable today because the nightly projection rewrites recent periods while
 * older ones still carry whatever the vendor left, so one table can hold a
 * CONSOLIDATED FY2025 beside an UNKNOWN FY2019.
 */
export type StockFinancialsBasisSummary = StockFinancialsBasis | "MIXED";

/** Human labels. UNKNOWN says what it does not know rather than guessing. */
export const STOCK_FINANCIALS_BASIS_LABEL: Record<
  StockFinancialsBasisSummary,
  string
> = {
  CONSOLIDATED: "Consolidated",
  STANDALONE: "Standalone",
  UNKNOWN: "Basis not stated",
  MIXED: "Mixed basis",
};

/** `basis` value → the label to render. Never throws, never guesses. */
export function stockFinancialsBasisLabel(value: unknown): string {
  return STOCK_FINANCIALS_BASIS_LABEL[normalizeStockFinancialsBasis(value)];
}

/**
 * The basis across a set of rows: the shared value when they agree, MIXED when
 * they do not, UNKNOWN for an empty set.
 *
 * An empty set is UNKNOWN rather than MIXED for the same reason absent is
 * UNKNOWN — "nothing to read" is not a disagreement, and it is certainly not a
 * consolidated claim.
 */
export function summariseStockFinancialsBasis(
  rows: ReadonlyArray<{ basis?: unknown }>,
): StockFinancialsBasisSummary {
  let seen: StockFinancialsBasis | null = null;
  for (const row of rows) {
    const b = normalizeStockFinancialsBasis(row.basis);
    if (seen === null) seen = b;
    else if (seen !== b) return "MIXED";
  }
  return seen ?? "UNKNOWN";
}

/** `summariseStockFinancialsBasis`, already rendered as a label. */
export function summariseStockFinancialsBasisLabel(
  rows: ReadonlyArray<{ basis?: unknown }>,
): string {
  return STOCK_FINANCIALS_BASIS_LABEL[summariseStockFinancialsBasis(rows)];
}
