-- rolling_stats_for(listing_id, as_of) — MONEY-1597 (C5b).
--
-- One listing's rolling statistics on the last session ON OR BEFORE @as_of:
-- SMAs, 52-week range, 20-session average volume, 30-session realised
-- volatility — gold.rolling_stats, all on the ADJUSTED series.
--
-- The listing is named as in events_for_listing (@listing_id, or @us_symbol
-- for a US ticker's ACTIVE listing). A listing with no session in the 14 days
-- before @as_of returns NO row rather than a stale one dressed as current, and
-- the tool REFUSES that empty answer by name instead of reporting it as a
-- success: an id the lake holds no bars for must never read as "no stats".
-- Prices are in the listing's own currency, which is stated per row.
--
-- Named parameters only.
SELECT
  r.market,
  r.listing_id,
  r.symbol,
  r.exchange,
  r.session_date,
  CASE r.market WHEN 'US' THEN 'USD' WHEN 'IN' THEN 'INR' END AS currency,
  r.adj_close,
  r.sma_20,
  r.sma_50,
  r.sma_200,
  r.high_52w,
  r.low_52w,
  r.avg_volume_20,
  r.realised_vol_30d,
  r.sessions_in_window,
  r.adjustment_policy_version
FROM {{gold}}.rolling_stats AS r
WHERE r.session_date <= PARSE_DATE('%Y-%m-%d', @as_of)
  AND r.session_date >= DATE_SUB(PARSE_DATE('%Y-%m-%d', @as_of), INTERVAL 14 DAY)
  AND (
    r.listing_id = @listing_id
    OR r.listing_id IN (
      SELECT listing_id
      FROM {{silver}}.listing
      WHERE market = 'US' AND status = 'ACTIVE' AND symbol = @us_symbol
    )
  )
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY r.market, r.listing_id ORDER BY r.session_date DESC
) = 1
LIMIT @row_limit
