/**
 * Is BSE's `series` column sourced well enough to reclassify from? — MONEY-1196.
 *
 * `reclassify-instruments.ts` retypes instruments AWAY from EQUITY and CLEARS
 * their sector, keying entirely on `series`. `series` defaults to the stamped
 * string "EQ" on every row, so acting while the column is mostly default would
 * type real equities as debt on no evidence. Hence a readiness gate.
 *
 * ## The gate must be INVARIANT under the operation it gates
 *
 * That is the whole lesson of MONEY-1196, and it is easy to get wrong twice.
 *
 * The first version asked "of rows still typed EQUITY, what share carry the
 * default?" — over the WHOLE universe. "EQ" is a legitimate NSE main-board
 * series, so every real NSE equity counted as unsourced forever. That was
 * diagnosed and the question was scoped to BSE, where "EQ" is never a valid
 * group and therefore always wrong.
 *
 * But the scoping fixed the wrong half. The population was still `EQUITY`-only,
 * and retyping is precisely what REMOVES a row from it: a correctly-grouped BSE
 * row becomes DEBT and leaves the denominator, while the stamped-"EQ" rows —
 * which cannot be classified at all — stay. So every successful run RAISED the
 * ratio and pushed the gate toward closed. Measured on QA either side of one
 * apply: 5,581/11,374 = 49% PASS, then 5,581/10,438 = 53% FAIL. QA passed by a
 * point, did the work, and locked itself out. Prod at 51% never passed.
 *
 * The fix is to count over ALL ACTIVE BSE rows rather than the still-undecided
 * ones. A retype moves a row between `instrumentType` values but does not
 * deactivate it, so both numerator and denominator are untouched by the apply —
 * the reading moves only when the ENRICHER writes a real group, which is the
 * thing readiness is actually about.
 *
 * ## What it deliberately does NOT do
 *
 * It does not try to exclude the structurally-unclassifiable rows. ~5,972 BSE
 * rows carry "EQ" with no ISIN and a name the master cannot corroborate, so the
 * enricher can never source them (see the corroboration rules in
 * `bse-master-logic.ts`). Dropping them from the denominator would make the
 * gate read 100% ready while half the column is still default. They are counted
 * and REPORTED instead: a number you can see is worth more than a ratio flattered
 * into agreeing with you.
 */

/** The single row shape this decision needs. */
export interface SeriesReadinessRow {
  exchange: string;
  instrumentType: string;
  series?: string | null;
  isActive?: boolean;
}

export interface SeriesReadiness {
  /** Actionable — the caller may write. */
  ready: boolean;
  /** Active BSE rows considered (the denominator). */
  population: number;
  /** Of those, how many still carry the stamped default "EQ". */
  stampedDefault: number;
  /** `stampedDefault / population`, 0 when the population is empty. */
  defaultShare: number;
  /**
   * Distinct REAL group letters seen — the stamped default is excluded.
   *
   * Counting "EQ" here would let the absence of data masquerade as diversity:
   * a column holding only {A, B, EQ} would score 3 and clear a "more than 2"
   * check on the strength of the very value the gate exists to detect.
   */
  distinctSeries: number;
  /** Why it is not ready, or null when it is. */
  reason: "no-population" | "too-few-series" | "mostly-default" | null;
}

/** BSE never issues "EQ" as a group letter, so on BSE it is always the stamp. */
const STAMPED_DEFAULT = "EQ";

/**
 * A real universe has ~14 BSE groups. Two or fewer means the column carries
 * essentially nothing, whatever the ratio says.
 */
const MIN_DISTINCT_SERIES = 2;

/** Over half the column still unsourced is not something to act on. */
const MAX_DEFAULT_SHARE = 0.5;

function normalise(series: string | null | undefined): string {
  return String(series ?? "")
    .trim()
    .toUpperCase();
}

export function judgeSeriesReadiness(
  rows: readonly SeriesReadinessRow[],
): SeriesReadiness {
  // ALL active BSE rows, both EQUITY and DEBT — see the module header. Filtering
  // to EQUITY here is the bug this function exists to prevent.
  const population = rows.filter(
    (r) => r.exchange === "BSE" && r.isActive !== false,
  );

  const distinct = new Set(
    population
      .map((r) => normalise(r.series))
      .filter((s) => Boolean(s) && s !== STAMPED_DEFAULT),
  );
  const stampedDefault = population.filter(
    (r) => normalise(r.series) === STAMPED_DEFAULT,
  ).length;
  const defaultShare =
    population.length > 0 ? stampedDefault / population.length : 0;

  const base = {
    population: population.length,
    stampedDefault,
    defaultShare,
    distinctSeries: distinct.size,
  };

  if (population.length === 0) {
    return { ...base, ready: false, reason: "no-population" };
  }
  if (distinct.size <= MIN_DISTINCT_SERIES) {
    return { ...base, ready: false, reason: "too-few-series" };
  }
  if (defaultShare > MAX_DEFAULT_SHARE) {
    return { ...base, ready: false, reason: "mostly-default" };
  }
  return { ...base, ready: true, reason: null };
}
