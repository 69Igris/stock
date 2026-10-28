-- universe_top_by(metric, market, as_of, n) — MONEY-1597 (C5b), MONEY-1606.
--
-- The n securities in one market with the highest @metric on their last
-- session in the week before @as_of. @row_limit is n + 1: the extra row is how
-- the tool knows the list was cut. The cross-sectional question — "which
-- names are most extended above their 200-day", "which are most volatile" —
-- that no per-symbol tool can answer.
--
-- @metric IS A BOUND STRING, NEVER A COLUMN NAME. It selects a branch of the
-- CASE below; an unknown value selects none, and the tool refuses it against
-- UNIVERSE_METRICS before a query is ever built. Nothing a caller sends is
-- interpolated into this text.
--
-- @min_sessions comes from the same allow-list: a 200-day SMA over twelve
-- sessions is a number (rolling_stats.sqlx says so), and a recent IPO would
-- otherwise top every "above its 200-day" list. @fresh_since is @as_of less a
-- week, computed by the tool: a listing with no session since then is not
-- ranked on a stale close.
--
-- ONE ROW PER SECURITY, NOT PER LISTING — MONEY-1606. One security listed on
-- NSE and BSE is two listings with near-identical numbers, and ranking both
-- hands the top of every Indian list to the same names twice. Listings are
-- grouped by their FULL ISIN, NSE kept, BSE only where NSE has no value (no
-- metric, a stale close, too short a window). NOT by ticker: FOCUS is Focus
-- Lighting on NSE and Focus Business Solution on BSE, two companies.
--
-- AND NOT BY THE MONEY-1543 ISSUER CODE (chars 3-7), which this first shipped
-- with. That code is the right key for attributing a corporate action across a
-- split's re-issued serial, and the wrong one for ranking, because an issuer
-- has many SECURITIES. Measured on prod over the latest week of India bars
-- (9,465 listings): grouped by issuer, 162 groups merged 1,406 distinct
-- securities — every ETF of one AMC under its INF code, NCDs and bonds under
-- the equity's code, with a digit-leading bond symbol able to win the group.
-- "Equity-shaped ISINs only" (kind E, type 01) still merged one: GATECH
-- (INE224E01028) with GATECHDVR (INE224E01036), a DVR issued under an E..01
-- serial. The full ISIN merges NONE and still folds 2,738 NSE/BSE twins. A
-- listing with no usable ISIN (every US row) stays its own group.
--
-- An EMPTY ranking (no listing in the market with a fresh session — US today,
-- before MONEY-1513's bars) is refused by the tool by name, never cached as
-- "nothing qualifies".
--
-- Written without QUALIFY or INTERVAL so the test suite can EXECUTE it.
-- Named parameters only.
WITH latest AS (
  SELECT
    market, listing_id, symbol, exchange, session_date, isin,
    adj_close, sma_50, sma_200, high_52w, low_52w,
    avg_volume_20, realised_vol_30d, sessions_in_window
  FROM (
    SELECT
      r.market, r.listing_id, r.symbol, r.exchange, r.session_date, r.isin,
      r.adj_close, r.sma_50, r.sma_200, r.high_52w, r.low_52w,
      r.avg_volume_20, r.realised_vol_30d, r.sessions_in_window,
      ROW_NUMBER() OVER (
        PARTITION BY r.listing_id ORDER BY r.session_date DESC
      ) AS listing_rank
    FROM {{gold}}.rolling_stats AS r
    WHERE r.market = @market
      AND r.session_date <= PARSE_DATE('%Y-%m-%d', @as_of)
      AND r.session_date >= PARSE_DATE('%Y-%m-%d', @fresh_since)
  ) AS ranked
  WHERE listing_rank = 1
),
scored AS (
  SELECT
    market, listing_id, symbol, exchange, session_date, adj_close,
    sessions_in_window,
    CASE
      WHEN REGEXP_CONTAINS(isin, '^[A-Z]{2}[A-Z0-9]{9}[0-9]$') THEN isin
    END AS isin,
    CASE @metric
      WHEN 'realised_vol_30d' THEN realised_vol_30d
      WHEN 'avg_volume_20' THEN avg_volume_20
      WHEN 'pct_above_sma_50' THEN SAFE_DIVIDE(adj_close, sma_50) - 1
      WHEN 'pct_above_sma_200' THEN SAFE_DIVIDE(adj_close, sma_200) - 1
      WHEN 'pct_below_52w_high' THEN 1 - SAFE_DIVIDE(adj_close, high_52w)
      WHEN 'pct_above_52w_low' THEN SAFE_DIVIDE(adj_close, low_52w) - 1
    END AS metric_value
  FROM latest
  WHERE sessions_in_window >= @min_sessions
),
one_per_issuer AS (
  SELECT
    market, listing_id, symbol, exchange, session_date, adj_close,
    sessions_in_window, isin, metric_value,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(isin, listing_id)
      ORDER BY CASE exchange WHEN 'NSE' THEN 0 ELSE 1 END, listing_id
    ) AS issuer_rank
  FROM scored
  WHERE metric_value IS NOT NULL
)
SELECT
  @metric AS metric,
  metric_value,
  market,
  listing_id,
  symbol,
  exchange,
  isin,
  session_date,
  CASE market WHEN 'US' THEN 'USD' WHEN 'IN' THEN 'INR' END AS currency,
  adj_close,
  sessions_in_window
FROM one_per_issuer
WHERE issuer_rank = 1
ORDER BY metric_value DESC, listing_id
LIMIT @row_limit
