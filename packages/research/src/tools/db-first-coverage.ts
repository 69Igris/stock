/**
 * When may a DB-first statement tool stop and answer from `StockFinancials`?
 *
 * MONEY-1274. `fetch-income-statement`, `fetch-balance-sheet` and
 * `fetch-cash-flow` each short-circuit on the synced rows before trying Yahoo
 * (DB-first, MONEY-614). The rule they share used to be "the DB has ANNUAL
 * rows", which is not the same question as "the DB can answer what was asked".
 *
 * ## The defect this encodes against
 *
 * `stock_financials` held 32,359 rows and ZERO of `periodType: "QUARTERLY"`
 * (measured 2026-08-28 — the XBRL projection that would write them ships
 * `XBRL_PROJECTION_APPLY=false`, so it has never written a row). A
 * `quarterly: true` call therefore found annual rows, returned on their
 * strength, and never reached Yahoo's `*HistoryQuarterly` module — the one
 * source that actually carries quarterly figures.
 *
 * The caller got `success: true` with no `quarterly` key. Nothing errored, so
 * the model read it as "this company has no quarterly figures" rather than
 * "nobody asked anyone who has them" — and said so, confidently, for exactly
 * the 2,123 covered large caps users ask about most.
 *
 * ## Why one shared predicate rather than three inline conditions
 *
 * Because the three copies are what drifted in the first place. Keeping the
 * rule in one place is also what lets it be tested directly instead of through
 * three `execute` functions that need a database and a network to run.
 */

/** What the DB turned out to hold, against what the caller actually asked for. */
export interface DbFirstCoverage {
  /**
   * Is the ANNUAL half usable?
   *
   * Not simply "row count > 0" — `fetch-balance-sheet` requires the forensic
   * DETAIL (`currentAssets`) that Altman / working-capital / Piotroski need, so
   * a core-only row is present but NOT usable and must fall through to Yahoo.
   * Each caller decides what usable means for its statement; this module only
   * combines that decision with the period one.
   */
  annualUsable: boolean;
  /** How many QUARTERLY rows the DB returned for this statement. */
  quarterlyCount: number;
  /** Did the caller pass `quarterly: true`? */
  quarterlyRequested: boolean;
}

/**
 * True when the DB can answer the WHOLE question and the tool may stop here.
 *
 * The asymmetry is deliberate: an unrequested quarterly is not a gap, but a
 * requested-and-missing one is, and falling through costs a Yahoo round trip
 * where returning early costs a wrong answer.
 */
export function dbFirstSatisfiesRequest(cov: DbFirstCoverage): boolean {
  if (!cov.annualUsable) return false;
  if (!cov.quarterlyRequested) return true;
  return cov.quarterlyCount > 0;
}
