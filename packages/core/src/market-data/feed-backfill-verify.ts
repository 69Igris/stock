/**
 * Backfill verification — MONEY-941 (Data Engine P3 step 5).
 *
 * Pure predicates that answer "did the backfill actually get the history it
 * claims?". They are separated from the job so the answer can be recomputed
 * from checkpoints at any time, not just at the end of a run that may have been
 * interrupted three times.
 *
 * ## Why counting matters more than spot-checking
 *
 * A backfill fails in a way that looks like success: it completes, the log says
 * "done", and a year is simply thinner than it should be because a throttle
 * window turned 40 days into MISSING. Nothing downstream notices — a chart with
 * 210 days instead of 250 just looks like a chart. Comparing the per-year count
 * against the number of trading days a year actually has is the only cheap
 * check that catches it.
 *
 * ## STATUS — MONEY-1238 decision: KEEP AND WIRE, do not delete
 *
 * This module has ZERO production callers. Only `index.ts` re-exports it and
 * only its own test file calls it, which means the failure its header describes
 * has never once been checked on a real backfill — the module is an instance of
 * the very class it was written to catch.
 *
 * It was audited for deletion and kept, on evidence rather than sentiment:
 *
 *   - `compareParity` is the ONLY reason the Jan–Jul 2024 era overlap exists.
 *     `report-registry.ts` archives both `nse-cm-legacy` and the UDiFF file for
 *     those days on purpose ("the overlap is what makes a real parity check
 *     possible, since the same trading days are available in two independent
 *     formats"). Deleting the comparator strands bytes we deliberately paid to
 *     store and leaves a 30-year-old parser with nothing to check against
 *     except itself.
 *   - `coverageByYear` answers the question the driver cannot: the walk
 *     checkpoints every (family, date), so the thin-year test is a pure
 *     aggregation over rows that already exist. No new fetch, no new table.
 *
 * The call site is `scripts/jobs/feed-backfill.ts`, which already imports from
 * `@usemoney/core/market-data`, already summarises per family
 * (`summarizeFamily`, ~:388/:417) and already owns an exit path
 * (`process.exitCode = 1`, ~:396/:436). Wiring is: roll the family's
 * checkpoints through `coverageByYear`, log each verdict, and treat
 * `SUSPICIOUS`/`EMPTY` the way a failed range is already treated. That file is
 * outside this batch's edit scope, so the decision is recorded here rather
 * than half-applied.
 */

/**
 * NSE trades roughly 245-252 days a year: 365 minus ~104 weekend days minus
 * 12-18 exchange holidays. The band is deliberately wide because we have no
 * historical holiday calendar (`nse-holidays.ts` covers FY26-27 only), and a
 * narrow band would flag normal years.
 */
export const MIN_EXPECTED_TRADING_DAYS = 240;
export const MAX_EXPECTED_TRADING_DAYS = 252;

export interface YearCoverage {
  year: number;
  archived: number;
  missing: number;
  /** archived / (archived + missing), 0-1. */
  ratio: number;
  verdict: "OK" | "THIN" | "SUSPICIOUS" | "EMPTY";
  note: string;
}

/**
 * Grade one year's coverage.
 *
 * `THIN` rather than `FAIL` for a slightly-short year, because a genuinely
 * sparse year is possible in the 1990s — the archive has holes and we cannot
 * distinguish an exchange holiday from a missing file. The verdict is a
 * prompt to look, not a claim of breakage.
 */
export function gradeYear(
  year: number,
  archived: number,
  missing: number,
): YearCoverage {
  const total = archived + missing;
  const ratio = total === 0 ? 0 : archived / total;

  if (archived === 0) {
    return {
      year,
      archived,
      missing,
      ratio,
      verdict: "EMPTY",
      note: `no files at all for ${year} — either the year predates this feed or the walk never reached it`,
    };
  }
  if (archived < MIN_EXPECTED_TRADING_DAYS * 0.5) {
    return {
      year,
      archived,
      missing,
      ratio,
      verdict: "SUSPICIOUS",
      note: `${archived} files vs ~${MIN_EXPECTED_TRADING_DAYS}+ expected — likely a throttled or interrupted walk, re-run this year`,
    };
  }
  if (archived < MIN_EXPECTED_TRADING_DAYS) {
    return {
      year,
      archived,
      missing,
      ratio,
      verdict: "THIN",
      note: `${archived} files vs ${MIN_EXPECTED_TRADING_DAYS}-${MAX_EXPECTED_TRADING_DAYS} expected — plausible for a sparse early year, worth a glance`,
    };
  }
  return {
    year,
    archived,
    missing,
    ratio,
    verdict: "OK",
    note: `${archived} files, within the expected ${MIN_EXPECTED_TRADING_DAYS}-${MAX_EXPECTED_TRADING_DAYS} band`,
  };
}

/** Roll per-day checkpoints up into per-year coverage. */
export function coverageByYear(
  rows: ReadonlyArray<{ date: Date; status: string }>,
): YearCoverage[] {
  const buckets = new Map<number, { archived: number; missing: number }>();
  for (const r of rows) {
    const y = new Date(
      r.date.getTime() + 5.5 * 60 * 60 * 1000,
    ).getUTCFullYear();
    const b = buckets.get(y) ?? { archived: 0, missing: 0 };
    if (r.status === "DONE") b.archived++;
    else if (r.status === "MISSING") b.missing++;
    buckets.set(y, b);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, b]) => gradeYear(year, b.archived, b.missing));
}

// ─── Era parity ──────────────────────────────────────────────────────

/** Tolerance for comparing a legacy close against its UDiFF twin. */
export const PARITY_TOLERANCE = 0.01;

export interface ParityResult {
  symbol: string;
  legacy: number;
  udiff: number;
  matches: boolean;
  diff: number;
}

/**
 * Compare a legacy close against the UDiFF close for the same symbol and day.
 *
 * This is the check the Jan–Jul 2024 era overlap exists to make possible: the
 * same trading days are published in two independent formats, so agreement is
 * real evidence that both parsers are correct. Without the overlap there is
 * nothing to compare a 30-year-old parser against except itself.
 *
 * Compared with a tolerance rather than exactly because the two formats round
 * differently in the last paisa; a mismatch beyond a paisa is a parser bug, not
 * rounding.
 *
 * ## Compared in PAISE, not rupees
 *
 * The obvious `Math.abs(a - b) <= 0.01` is wrong, and wrong in the direction
 * that manufactures false alarms: `2845.61 - 2845.60` is `0.010000000000218`
 * in binary floating point, so an exact one-paisa rounding difference — the
 * single most common and most benign case — fails the check. Scaling to integer
 * paise removes the representation error entirely rather than trying to
 * out-fudge it with an epsilon.
 */
export function compareParity(
  symbol: string,
  legacy: number,
  udiff: number,
  tolerance = PARITY_TOLERANCE,
): ParityResult {
  const paise = (v: number): number => Math.round(v * 100);
  const diffPaise = Math.abs(paise(legacy) - paise(udiff));
  const diff = diffPaise / 100;
  return {
    symbol,
    legacy,
    udiff,
    diff,
    matches: diffPaise <= Math.round(tolerance * 100),
  };
}

/** Summarise a parity batch. `mismatches` is what needs eyes. */
export function summarizeParity(results: readonly ParityResult[]): {
  checked: number;
  matched: number;
  mismatches: ParityResult[];
} {
  const mismatches = results.filter((r) => !r.matches);
  return {
    checked: results.length,
    matched: results.length - mismatches.length,
    mismatches,
  };
}
