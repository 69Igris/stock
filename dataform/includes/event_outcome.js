/**
 * `gold.event_return_outcome`, in SQL. MONEY-1596 (data-platform C5a).
 *
 * "What happened after events like this" — the returns that followed every
 * `lake_silver.instrument_event`, measured on the ADJUSTED bars so a split
 * inside the window is not a return.
 *
 * Like `adjustment.js`, the SQL lives here as exported functions rather than as
 * prose in a .sqlx, because
 * `packages/core/__tests__/market-data/event-outcome-sql.test.ts` EXECUTES it in
 * `node:sqlite` against fixtures. SQL pasted into a .sqlx is SQL nothing can
 * test.
 *
 * ## POINT-IN-TIME IS THE WHOLE POINT
 *
 * An event is dated by its `observed_at` — when WE first saw it (create-only
 * since MONEY-1531; the SEC backfill carries the claim's `detectedAt`). Never
 * `published_at` (the source's clock) and never `ingested_at` (our write
 * clock): lake-layout.md §6.
 *
 * The OBSERVED DATE is the calendar day of `observed_at` ON THE VENUE'S CLOCK:
 *
 *   US   America/New_York — the same ET calendar day `usMarketDateKey`
 *        (packages/core/src/market-data/us-market-hours.ts) gives every lake
 *        session, so an event and a bar are dated by one rule.
 *   IN   Asia/Kolkata — the IST day, the day NSE/BSE date their sessions by.
 *
 * NOT the UTC day, and the difference is not cosmetic. An 8-K accepted at
 * 21:30 ET on a Monday is 01:30Z TUESDAY: dated in UTC, Tuesday's bar becomes
 * its "base" — a close printed a whole session AFTER the filing — and the
 * Wednesday bar its "day 1". The UTC rule quietly moves the reaction into the
 * baseline.
 *
 * The rule, stated once and asserted by `pointInTimeViolationsSql`:
 *
 *   BASE bar     the listing's LAST bar with session_date <= observed_date
 *   AFTER bars   the next 1 / 5 / 20 bars of that listing — so every one has
 *                session_date > observed_date, by construction
 *
 * AN EVENT OBSERVED AFTER THE CLOSE is handled by that rule without a special
 * case: seen at 16:45 ET (or 20:30 IST) on day D, its observed date is D, its
 * base is D's close — the last price the market set WITHOUT the news — and
 * D+1 is its day 1. `gap_open_pct` is exactly the overnight reaction.
 *
 * THE PRICE OF STRICTNESS, written down rather than discovered. An event seen
 * BEFORE the open, or DURING the session, on day D also has D as its base, so
 * the part of the reaction D's own session absorbed is not in any `ret_*`. A
 * pre-market 8-K 2.02 therefore measures the drift AFTER the first reaction
 * day, not the reaction. That is the conservative side of the line: counting
 * D as "after" would, for every intraday event, attribute the morning's
 * pre-event trading to the event, and the spec's rule is that no outcome may
 * use a bar dated on or before `observed_at`. An intraday-bar version of this
 * model is how that day comes back; daily bars cannot tell 09:31 from 15:59.
 *
 * ## ONE ROW PER EVENT, INCLUDING THE ONES THAT CANNOT BE MEASURED
 *
 * `window_status` says which:
 *
 *   NO_LISTING   listing_id is NULL (a CIK with no listing, until C3's linker
 *                appends a re-linked row). COUNTED, never silently dropped.
 *   NO_BARS      no bar on or before the observed date (a listing the lake has
 *                no prices for, or an event older than its history).
 *   STALE_BARS   the base, or day 1, sits more than STALE_GAP_DAYS calendar
 *                days from the observed date — a suspended or delisted line.
 *                Its returns are NULLED: a "1-day" return spanning a
 *                three-month suspension is a plausible, wrong number.
 *   OPEN         measured, but fewer than 20 sessions have printed yet.
 *   COMPLETE     all 20 after-sessions exist. The 20-day window has closed.
 *
 * ## WHICH ROW OF AN EVENT
 *
 * Silver is append-only: an enrichment appends a row with the SAME
 * `(event_id, observed_at)`, a C3 re-link appends one carrying a listing_id.
 * The documented reader contract (008_silver_instrument_event.sql) is the
 * latest `(observed_at, ingested_at)` per event_id, and it is followed here —
 * which also means that if two rows ever disagree about `observed_at`, the
 * LATER clock wins: the conservative side for point-in-time.
 *
 * ## THE BENCHMARK
 *
 * Abnormal return is market-adjusted: the listing's return minus the
 * benchmark's over the SAME two dates. US: SPY's ADJUSTED close from
 * `adjusted_bar_d1` (a total-return series). India: the NIFTY 50 close from
 * silver `index_eod` — a PRICE index, while the stock side is dividend-
 * adjusted, so an Indian abnormal return carries the index's dividend yield as
 * a bias of roughly 1.3%/252 per session (~0.1% over 20). Measured, small,
 * stated; a NIFTY TRI series in index_eod would remove it.
 *
 * A benchmark with no bar on one of the two dates yields a NULL abnormal
 * return, never a return against the nearest day.
 *
 * ## THE DIALECT
 *
 * The common subset `adjustment.js` documents, plus THREE BigQuery built-ins
 * SQLite does not have: `DATE(timestamp, time_zone)`, `UNIX_DATE(date)` and
 * `STDDEV_SAMP`. The test registers each as a SQLite function with BigQuery's
 * semantics (NULL in, NULL out; STDDEV_SAMP NULL below two values), so the
 * text under test is the text Dataform deploys — no second copy.
 */

/** The clock an event's observed date is read on, per market. */
const MARKET_TIMEZONES = Object.freeze({
  US: "America/New_York",
  IN: "Asia/Kolkata",
});

/**
 * The market each abnormal return is measured against.
 *
 * SPY's id is the one `lake_silver.listing` carries (measured on prod
 * 2026-09-23: `SPY:NYSE:1993-01-29`, ACTIVE). `nifty-50` is `toIndexSlug`'s
 * spelling of "Nifty 50", measured in prod `index_eod` the same day — NOT
 * `nifty50-*`, which are the leveraged, inverse and USD variants.
 */
const BENCHMARKS = Object.freeze({
  US: Object.freeze({ id: "SPY:NYSE:1993-01-29" }),
  IN: Object.freeze({ id: "nifty-50", exchange: "NSE" }),
});

/** Sessions in the long window. Also the "before" volatility window. */
const WINDOW_SESSIONS = 20;

/**
 * A base or day-1 bar further than this many CALENDAR days from the observed
 * date marks the row STALE_BARS. Seven clears every weekend plus the longest
 * scheduled closure either venue has (Diwali, Christmas-to-New-Year) and still
 * catches a suspension.
 */
const STALE_GAP_DAYS = 7;

/**
 * How long a non-COMPLETE outcome keeps being re-measured, in calendar days
 * from its observed date. A 20-session window closes in about 28 days; 60
 * leaves a month for late bars. Past it, an OPEN row (a listing delisted
 * inside its window) or a NO_BARS row (news on a listing the lake has no
 * prices for) stops costing a re-read every run — it would otherwise be
 * re-measured for ever. A bar backfill older than this is healed by the full
 * refresh the backfill runbook already calls for.
 */
const REMEASURE_DAYS = 60;

/** The venue-local calendar day of a timestamp, per market. */
function observedDateSql(marketColumn, timestampColumn) {
  return `CASE ${marketColumn}
      WHEN 'US' THEN DATE(${timestampColumn}, '${MARKET_TIMEZONES.US}')
      WHEN 'IN' THEN DATE(${timestampColumn}, '${MARKET_TIMEZONES.IN}')
    END`;
}

/**
 * The incremental candidate predicate, over `instrument_event` rows aliased
 * `c`. BigQuery-only (it reads the model's own table), so the SQLite test does
 * not execute it; the model runs with `TRUE` there and on a full refresh.
 *
 * An event is re-measured when EITHER
 *
 *   - a silver row for it was written since the last run (a new event, a C3
 *     re-link, an enrichment) — two hours of overlap, the sink's own
 *     SINK_OVERLAP_MS, because `computed_at` and `ingested_at` are two
 *     clocks on two machines; or
 *   - its stored outcome is not COMPLETE and it was observed within the last
 *     REMEASURE_DAYS. That is "rebuilt for events whose 20-day window has just
 *     closed": an OPEN row is re-measured every run, the run on which its 20th
 *     session lands turns it COMPLETE, and from then on it is frozen. It also
 *     heals NO_BARS and STALE_BARS rows when bars land a little late. The
 *     bound is what stops a row that can NEVER complete (a listing delisted
 *     inside its window) being re-read on every run for ever.
 *
 * A late corporate action INSIDE a completed window is the one thing this
 * does not re-read — the factor is identical for both ends of a window unless
 * the ex-date falls inside it. A full refresh is the remedy, and is cheap.
 *
 * THE COALESCE IS LOAD-BEARING. A table that exists with zero rows (QA's
 * first build, over a silver table that was still empty) makes the watermark
 * `MAX(computed_at)` NULL, `ingested_at > NULL` is never true, and the second
 * branch has no rows to name — so the model would select nothing on every
 * run for ever, reporting success each time.
 *
 * @param {string} self the model's own table, `self()` in the .sqlx.
 */
function incrementalCandidatesSql(self) {
  return `c.ingested_at > COALESCE(
      (SELECT TIMESTAMP_SUB(MAX(computed_at), INTERVAL 2 HOUR) FROM ${self}),
      TIMESTAMP '1970-01-01 00:00:00+00'
    )
    OR c.event_id IN (
      SELECT event_id FROM ${self}
      WHERE window_status <> 'COMPLETE'
        AND observed_date >= DATE_SUB(CURRENT_DATE(), INTERVAL ${REMEASURE_DAYS} DAY)
    )`;
}

/**
 * The full SELECT behind `lake_gold.event_return_outcome`.
 *
 * @param {object} tables
 * @param {string} tables.events     `lake_silver.instrument_event`
 * @param {string} tables.bars       `lake_gold.adjusted_bar_d1`
 * @param {string} tables.indexEod   `lake_silver.index_eod`
 * @param {string} [tables.candidates] predicate over `instrument_event` rows
 *   aliased `c`; `TRUE` measures every event (full refresh, and the test).
 * @returns {string} one SELECT statement, no trailing semicolon.
 */
function eventReturnOutcomeSql({
  events,
  bars,
  indexEod,
  candidates = "TRUE",
}) {
  const last = WINDOW_SESSIONS;
  return `WITH event_rows AS (
  SELECT
    e.event_id, e.market, e.listing_id, e.event_type, e.observed_at,
    ROW_NUMBER() OVER (
      PARTITION BY e.event_id
      ORDER BY e.observed_at DESC, e.ingested_at DESC
    ) AS row_rank
  FROM ${events} e
  WHERE e.event_id IN (SELECT c.event_id FROM ${events} c WHERE ${candidates})
),
ev AS (
  SELECT
    event_id, market, listing_id, event_type, observed_at,
    ${observedDateSql("market", "observed_at")} AS observed_date
  FROM event_rows
  WHERE row_rank = 1
),
-- Every bar of every listing an event names, numbered in SESSIONS. Windows
-- are counted in the listing's own sessions (ROWS, not calendar days), the
-- convention rolling_stats.sqlx states for the same reason.
bars AS (
  SELECT
    market, listing_id, session_date, adj_open, adj_close,
    adjustment_policy_version,
    ROW_NUMBER() OVER (
      PARTITION BY market, listing_id ORDER BY session_date
    ) AS seq
  FROM ${bars}
  WHERE listing_id IN (
    SELECT listing_id FROM ev WHERE listing_id IS NOT NULL
  )
),
returns AS (
  SELECT
    market, listing_id, session_date, seq, adj_open, adj_close,
    adjustment_policy_version,
    CASE
      WHEN LAG(adj_close) OVER by_session > 0 AND adj_close > 0
        THEN LN(CAST(adj_close AS FLOAT64)
                / CAST(LAG(adj_close) OVER by_session AS FLOAT64))
    END AS log_return
  FROM bars
  WINDOW by_session AS (PARTITION BY market, listing_id ORDER BY seq)
),
-- The BASE, as an as-of join without a range join: events are interleaved
-- into their listing's bar stream, ordered AFTER a bar of the same date, and
-- each takes the running maximum session number. So the base is the last bar
-- with session_date <= observed_date, and a bar dated ON the observed date is
-- the base, never an after-bar.
asof_stream AS (
  SELECT
    market, listing_id, session_date AS on_date, 0 AS is_event, seq,
    CAST(NULL AS STRING) AS event_id
  FROM bars
  UNION ALL
  SELECT
    market, listing_id, observed_date, 1, CAST(NULL AS INT64), event_id
  FROM ev
  WHERE listing_id IS NOT NULL
),
asof AS (
  SELECT
    event_id,
    MAX(seq) OVER (
      PARTITION BY market, listing_id
      ORDER BY on_date, is_event
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS base_seq
  FROM asof_stream
),
base AS (
  SELECT event_id, base_seq FROM asof WHERE event_id IS NOT NULL
),
-- The ${2 * last} sessions around each base, folded to one row: ${last} returns
-- ending AT the base (before) and the ${last} after it.
win AS (
  SELECT
    ev.event_id,
    MAX(CASE WHEN r.seq = b.base_seq THEN r.session_date END) AS base_session_date,
    MAX(CASE WHEN r.seq = b.base_seq THEN r.adj_close END) AS base_close,
    MAX(CASE WHEN r.seq = b.base_seq + 1 THEN r.session_date END) AS session_date_1d,
    MAX(CASE WHEN r.seq = b.base_seq + 1 THEN r.adj_open END) AS open_1d,
    MAX(CASE WHEN r.seq = b.base_seq + 1 THEN r.adj_close END) AS close_1d,
    MAX(CASE WHEN r.seq = b.base_seq + 5 THEN r.session_date END) AS session_date_5d,
    MAX(CASE WHEN r.seq = b.base_seq + 5 THEN r.adj_close END) AS close_5d,
    MAX(CASE WHEN r.seq = b.base_seq + ${last} THEN r.session_date END) AS session_date_20d,
    MAX(CASE WHEN r.seq = b.base_seq + ${last} THEN r.adj_close END) AS close_20d,
    MAX(CASE WHEN r.seq > b.base_seq THEN r.session_date END) AS last_after_session_date,
    SUM(CASE WHEN r.seq > b.base_seq THEN 1 ELSE 0 END) AS after_sessions,
    STDDEV_SAMP(CASE WHEN r.seq <= b.base_seq THEN r.log_return END) AS vol_20d_before,
    STDDEV_SAMP(CASE WHEN r.seq > b.base_seq THEN r.log_return END) AS vol_20d_after,
    MAX(r.adjustment_policy_version) AS adjustment_policy_version
  FROM ev
  JOIN base b ON b.event_id = ev.event_id
  JOIN returns r
    ON r.market = ev.market
   AND r.listing_id = ev.listing_id
   AND r.seq BETWEEN b.base_seq - ${last - 1} AND b.base_seq + ${last}
  GROUP BY ev.event_id
),
benchmark AS (
  SELECT market, session_date, CAST(adj_close AS FLOAT64) AS level
  FROM ${bars}
  WHERE market = 'US' AND listing_id = '${BENCHMARKS.US.id}'
  UNION ALL
  SELECT market, session_date, level
  FROM (
    SELECT
      market, session_date, CAST(close AS FLOAT64) AS level,
      ROW_NUMBER() OVER (
        PARTITION BY market, session_date ORDER BY ingested_at DESC
      ) AS row_rank
    FROM ${indexEod}
    WHERE market = 'IN'
      AND index_slug = '${BENCHMARKS.IN.id}'
      AND exchange = '${BENCHMARKS.IN.exchange}'
  ) nifty
  WHERE row_rank = 1
),
measured AS (
  SELECT
    ev.event_id, ev.market, ev.listing_id, ev.event_type, ev.observed_at,
    ev.observed_date,
    w.base_session_date, w.session_date_1d, w.session_date_5d,
    w.session_date_20d, w.last_after_session_date,
    COALESCE(w.after_sessions, 0) AS after_sessions,
    w.vol_20d_before, w.vol_20d_after, w.adjustment_policy_version,
    CASE
      WHEN ev.listing_id IS NULL THEN 'NO_LISTING'
      WHEN w.base_session_date IS NULL THEN 'NO_BARS'
      WHEN UNIX_DATE(ev.observed_date) - UNIX_DATE(w.base_session_date) > ${STALE_GAP_DAYS}
        OR UNIX_DATE(w.session_date_1d) - UNIX_DATE(ev.observed_date) > ${STALE_GAP_DAYS}
        THEN 'STALE_BARS'
      WHEN w.after_sessions >= ${last} THEN 'COMPLETE'
      ELSE 'OPEN'
    END AS window_status,
    CASE WHEN w.base_close > 0
      THEN CAST(w.close_1d AS FLOAT64) / CAST(w.base_close AS FLOAT64) - 1 END AS ret_1d,
    CASE WHEN w.base_close > 0
      THEN CAST(w.close_5d AS FLOAT64) / CAST(w.base_close AS FLOAT64) - 1 END AS ret_5d,
    CASE WHEN w.base_close > 0
      THEN CAST(w.close_20d AS FLOAT64) / CAST(w.base_close AS FLOAT64) - 1 END AS ret_20d,
    CASE WHEN w.base_close > 0
      THEN 100 * (CAST(w.open_1d AS FLOAT64) / CAST(w.base_close AS FLOAT64) - 1) END AS gap_open_pct,
    CASE WHEN m0.level > 0 THEN m1.level / m0.level - 1 END AS bench_ret_1d,
    CASE WHEN m0.level > 0 THEN m5.level / m0.level - 1 END AS bench_ret_5d,
    CASE WHEN m0.level > 0 THEN m20.level / m0.level - 1 END AS bench_ret_20d
  FROM ev
  LEFT JOIN win w ON w.event_id = ev.event_id
  LEFT JOIN benchmark m0
    ON m0.market = ev.market AND m0.session_date = w.base_session_date
  LEFT JOIN benchmark m1
    ON m1.market = ev.market AND m1.session_date = w.session_date_1d
  LEFT JOIN benchmark m5
    ON m5.market = ev.market AND m5.session_date = w.session_date_5d
  LEFT JOIN benchmark m20
    ON m20.market = ev.market AND m20.session_date = w.session_date_20d
)
SELECT
  event_id,
  market,
  listing_id,
  event_type,
  observed_at,
  observed_date,
  window_status,
  base_session_date,
  session_date_1d,
  session_date_5d,
  session_date_20d,
  last_after_session_date,
  after_sessions,
  CASE WHEN window_status IN ('OPEN', 'COMPLETE') THEN ret_1d END AS ret_1d,
  CASE WHEN window_status IN ('OPEN', 'COMPLETE') THEN ret_5d END AS ret_5d,
  CASE WHEN window_status IN ('OPEN', 'COMPLETE') THEN ret_20d END AS ret_20d,
  CASE WHEN window_status IN ('OPEN', 'COMPLETE') THEN ret_1d - bench_ret_1d END AS abn_ret_1d,
  CASE WHEN window_status IN ('OPEN', 'COMPLETE') THEN ret_5d - bench_ret_5d END AS abn_ret_5d,
  CASE WHEN window_status IN ('OPEN', 'COMPLETE') THEN ret_20d - bench_ret_20d END AS abn_ret_20d,
  CASE WHEN window_status IN ('OPEN', 'COMPLETE') THEN vol_20d_before END AS vol_20d_before,
  CASE WHEN window_status IN ('OPEN', 'COMPLETE') THEN vol_20d_after END AS vol_20d_after,
  CASE WHEN window_status IN ('OPEN', 'COMPLETE') THEN gap_open_pct END AS gap_open_pct,
  CASE market
    WHEN 'US' THEN '${BENCHMARKS.US.id}'
    WHEN 'IN' THEN '${BENCHMARKS.IN.id}'
  END AS benchmark_id,
  adjustment_policy_version,
  CURRENT_TIMESTAMP AS computed_at
FROM measured`;
}

/**
 * Every outcome that used a bar it was not entitled to. Zero rows is a pass.
 *
 * It judges the MODEL'S OUTPUT against the silver clock, with the venue day
 * recomputed HERE from `observed_at` — deliberately not through
 * `observedDateSql`, so a model whose date rule drifted (to UTC, say) is
 * caught by a second spelling instead of agreeing with itself. The time zones
 * are the one shared input, because they are the policy.
 *
 * Universally quantified, so it passes vacuously on an empty table (QA today)
 * and needs no env gate — unlike the existential
 * `assert_india_split_is_adjusted`.
 *
 * @param {string} outcomes `lake_gold.event_return_outcome`
 * @param {string} events   `lake_silver.instrument_event`
 * @returns {string} one SELECT statement, no trailing semicolon.
 */
function pointInTimeViolationsSql(outcomes, events) {
  return `WITH judged AS (
  SELECT
    o.event_id, o.market, o.observed_at, o.observed_date, o.window_status,
    o.base_session_date, o.session_date_1d, o.session_date_5d,
    o.session_date_20d, o.last_after_session_date,
    CASE o.market
      WHEN 'US' THEN DATE(o.observed_at, '${MARKET_TIMEZONES.US}')
      WHEN 'IN' THEN DATE(o.observed_at, '${MARKET_TIMEZONES.IN}')
    END AS venue_date
  FROM ${outcomes} o
),
silver_clock AS (
  SELECT event_id, MAX(observed_at) AS silver_observed_at
  FROM ${events}
  GROUP BY event_id
)
SELECT
  j.event_id,
  j.market,
  j.observed_at,
  j.observed_date,
  j.venue_date,
  s.silver_observed_at,
  j.base_session_date,
  j.session_date_1d,
  j.session_date_5d,
  j.session_date_20d,
  j.last_after_session_date,
  CASE
    WHEN j.venue_date IS NULL
      THEN 'no venue clock for this market'
    WHEN j.observed_date IS NULL OR j.observed_date <> j.venue_date
      THEN 'observed_date is not the venue-local day of observed_at'
    WHEN s.silver_observed_at IS NOT NULL AND j.observed_at < s.silver_observed_at
      THEN 'the outcome is dated EARLIER than silver observed the event'
    WHEN j.base_session_date > j.venue_date
      THEN 'the base bar is dated after the observation'
    ELSE 'an after-bar is dated on or before the observed date'
  END AS failure
FROM judged j
LEFT JOIN silver_clock s ON s.event_id = j.event_id
WHERE j.venue_date IS NULL
   OR j.observed_date IS NULL
   OR j.observed_date <> j.venue_date
   OR (s.silver_observed_at IS NOT NULL AND j.observed_at < s.silver_observed_at)
   OR j.base_session_date > j.venue_date
   OR j.session_date_1d <= j.venue_date
   OR j.session_date_5d <= j.venue_date
   OR j.session_date_20d <= j.venue_date
   OR j.last_after_session_date <= j.venue_date`;
}

module.exports = {
  MARKET_TIMEZONES,
  BENCHMARKS,
  WINDOW_SESSIONS,
  STALE_GAP_DAYS,
  REMEASURE_DAYS,
  incrementalCandidatesSql,
  eventReturnOutcomeSql,
  pointInTimeViolationsSql,
};
