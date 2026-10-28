/**
 * Which trading days still need F&O summarising — MONEY-1189.
 *
 * ## The bug this replaces
 *
 * `fo-summary --backfill` selected its targets as `eodDates − summaryDates`, a
 * set difference at **DAY** granularity. A day that already carried ANY summary
 * row was "done".
 *
 * That is false whenever a day is partially summarised, and on prod it was
 * false for two years: `2026-06-02` held 27 summary rows — all BSE — against
 * 39,529 `DerivativeEOD` rows covering 219 underlyings. The day looked complete
 * to the backfill and its entire NSE side was never derived. Roughly 108k
 * summary rows across 2024-07-08 → 2026-08-06 went missing this way, and every
 * re-run confirmed the gap did not exist.
 *
 * It is the same shape as MONEY-1175: **a completeness check at the wrong
 * granularity, reporting success.** The unit of work is (day, underlying), so
 * the completeness check has to be too.
 *
 * ## Why the expected set is exactly computable
 *
 * `summarizeDay` writes one row per retained group, unconditionally — there is
 * no path where a retained underlying silently yields nothing. So the expected
 * summary keys for a day ARE its retained EOD keys, and anything missing is a
 * real gap rather than a modelling guess.
 *
 * The one filter that must be mirrored is the pre-2018 stock-F&O retention rule
 * (founder decision 2026-08-11): before the cutoff, `*STK` underlyings are
 * dropped at both the parse writer and the summariser. Without mirroring it,
 * every pre-2018 day would look permanently incomplete and the backfill would
 * churn over 5,000 days forever, re-deriving nothing.
 */

/** `symbol|exchange`, matching fo-summary's `groupKey`. */
export type UnderlyingKey = string;

/** One EOD underlying observed on a day. */
export interface EodUnderlying {
  key: UnderlyingKey;
  /** True for `FUTSTK` / `OPTSTK` — subject to the pre-2018 retention rule. */
  isStock: boolean;
}

/**
 * The underlyings a day is EXPECTED to have summaries for.
 *
 * Mirrors `summarizeDay`'s retention filter: before `stockCutoffMs`, stock
 * derivatives are not retained, so they must not be expected either.
 */
export function retainedUnderlyings(
  dateMs: number,
  observed: Iterable<EodUnderlying>,
  stockCutoffMs: number,
): Set<UnderlyingKey> {
  const out = new Set<UnderlyingKey>();
  const keepStocks = dateMs >= stockCutoffMs;
  for (const u of observed) {
    if (!keepStocks && u.isStock) continue;
    out.add(u.key);
  }
  return out;
}

export interface IncompleteDay {
  dateMs: number;
  expected: number;
  present: number;
  /** Underlyings with EOD rows but no summary row. */
  missing: UnderlyingKey[];
}

/**
 * Days whose summaries do not cover every retained EOD underlying.
 *
 * A day with zero summary rows and a day with only its BSE half are both
 * incomplete — the previous implementation could only see the first.
 *
 * Ascending by date, because the summariser walks days in order and reuses the
 * previous day's rows as the prev-day chain.
 */
export function selectIncompleteDays(
  expectedByDay: ReadonlyMap<number, ReadonlySet<UnderlyingKey>>,
  presentByDay: ReadonlyMap<number, ReadonlySet<UnderlyingKey>>,
): IncompleteDay[] {
  const out: IncompleteDay[] = [];

  for (const [dateMs, expected] of expectedByDay) {
    const present = presentByDay.get(dateMs);
    const missing: UnderlyingKey[] = [];
    for (const key of expected) {
      if (!present?.has(key)) missing.push(key);
    }
    if (missing.length > 0) {
      out.push({
        dateMs,
        expected: expected.size,
        present: present?.size ?? 0,
        missing: missing.sort(),
      });
    }
  }

  out.sort((a, b) => a.dateMs - b.dateMs);
  return out;
}

/**
 * Days the NIGHTLY run should attempt.
 *
 * The nightly used to target exactly `eodDates[last]`, which made a single
 * missed night permanent: nothing ever revisited it, and the only mechanism
 * that could — `--backfill` — was blinded by the day-granularity bug above.
 *
 * That is not hypothetical. On 2026-08-11 the summariser ran at 18:00Z while
 * that day's 34,815 EOD rows were not written until 19:27Z, 87 minutes later;
 * the day has zero summaries and no scheduled run would ever have fixed it.
 *
 * So the nightly now sweeps a short trailing window and picks up whatever is
 * incomplete in it. The window is deliberately small — this is a self-healing
 * margin for late data and missed runs, not a backfill. Anything older is
 * `--backfill`'s job.
 */
export function selectNightlyTargets(
  incomplete: readonly IncompleteDay[],
  latestEodMs: number,
  windowDays: number,
): IncompleteDay[] {
  const floor = latestEodMs - windowDays * 86_400_000;
  return incomplete.filter((d) => d.dateMs >= floor);
}
