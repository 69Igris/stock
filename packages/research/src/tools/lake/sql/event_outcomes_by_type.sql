-- event_outcomes_by_type(event_type, market, since) — MONEY-1597 (C5b).
--
-- What happened, on average, after every event of one type in one market
-- since @since. One row.
--
-- The events that could NOT be measured are counted, by reason, beside the
-- ones that were — an average over 40 measured events out of 4,000 is a
-- different claim from one over 4,000, and nothing else in the row says so.
-- ret_* and abn_ret_* are FRACTIONS (0.02 = +2%); gap_open_pct is PERCENT.
-- Returns are NULL outside OPEN/COMPLETE, so every aggregate below reads only
-- measured windows; n_* says how many.
--
-- Named parameters only.
SELECT
  @event_type AS event_type,
  @market AS market,
  PARSE_DATE('%Y-%m-%d', @since) AS since,
  COUNT(*) AS events,
  COUNTIF(window_status = 'COMPLETE') AS events_window_complete,
  COUNTIF(window_status = 'OPEN') AS events_window_open,
  COUNTIF(window_status = 'NO_LISTING') AS events_without_listing,
  COUNTIF(window_status = 'NO_BARS') AS events_without_bars,
  COUNTIF(window_status = 'STALE_BARS') AS events_with_stale_bars,
  COUNT(ret_1d) AS n_1d,
  AVG(ret_1d) AS mean_ret_1d,
  AVG(abn_ret_1d) AS mean_abn_ret_1d,
  APPROX_QUANTILES(abn_ret_1d, 2)[SAFE_OFFSET(1)] AS median_abn_ret_1d,
  SAFE_DIVIDE(COUNTIF(abn_ret_1d > 0), COUNT(abn_ret_1d)) AS share_abn_ret_1d_positive,
  COUNT(ret_5d) AS n_5d,
  AVG(ret_5d) AS mean_ret_5d,
  AVG(abn_ret_5d) AS mean_abn_ret_5d,
  APPROX_QUANTILES(abn_ret_5d, 2)[SAFE_OFFSET(1)] AS median_abn_ret_5d,
  SAFE_DIVIDE(COUNTIF(abn_ret_5d > 0), COUNT(abn_ret_5d)) AS share_abn_ret_5d_positive,
  COUNT(ret_20d) AS n_20d,
  AVG(ret_20d) AS mean_ret_20d,
  AVG(abn_ret_20d) AS mean_abn_ret_20d,
  APPROX_QUANTILES(abn_ret_20d, 2)[SAFE_OFFSET(1)] AS median_abn_ret_20d,
  SAFE_DIVIDE(COUNTIF(abn_ret_20d > 0), COUNT(abn_ret_20d)) AS share_abn_ret_20d_positive,
  AVG(gap_open_pct) AS mean_gap_open_pct,
  AVG(SAFE_DIVIDE(vol_20d_after, vol_20d_before)) AS mean_vol_ratio_after_to_before
FROM {{gold}}.event_return_outcome
WHERE event_type = @event_type
  AND market = @market
  AND observed_date >= PARSE_DATE('%Y-%m-%d', @since)
