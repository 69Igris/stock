-- Silver: intraday TRADE bars, and the spread cost derived from quotes.
-- MONEY-1505 (data-platform B5).
--
-- Applied by scripts/ops/lake-apply-ddl.ts. `{{DATASET}}` is substituted with
-- lake_silver_{env} — the LAYER comes from this filename (`007_silver_…`), and
-- the applier THROWS rather than defaulting if it cannot read one.
--
-- ## WHY THESE ARE NOT `price_bar_d1` WITH A `timeframe` COLUMN
--
-- The same reason `price_bar_d1` will not hold a Databento bar at all:
-- Databento OHLCV is TRADE-DERIVED with real volume, and Tiingo's daily bar is
-- an adjusted, corporate-action-aware series. Folding them into one table puts
-- a structural `volume: 0` (a quote-derived feed that does not report volume)
-- beside a real zero (nothing traded) and changes what OHLC MEANS partway down
-- a column, with nothing on the rows to reveal it.
--
-- That is the one-source rule (MONEY-1309 `mayWriteIntoDay`, MONEY-1373), and
-- it is named after the PROPERTY rather than after a vendor. Here it is
-- expressed as separate TABLES, which is stronger than a guard: there is no
-- write path that could mix them.
--
-- ## M1 IS PARTITIONED BY DAY, H1 BY MONTH
--
-- lake-layout.md §4. M1 is ~43M rows a year across 507 symbols, so a MONTH
-- partition would be ~3.6M rows scanned for a one-session question. H1 is
-- ~9.7M rows a year across 12,331 symbols and a daily partition would be
-- ~39,000 rows — small enough that per-partition metadata starts to dominate.
--
-- `session_date` IS THE ET SESSION DATE, NEVER THE UTC DAY. The US session runs
-- 04:00-20:00 ET, so under EST the post-market tail is the NEXT UTC day and
-- also the same UTC day as the FOLLOWING session's pre-market: a UTC key spans
-- two sessions, and whichever writer lands there first locks the other out of
-- both. `usMarketDateKey` computes it and nothing else may.
--
-- ## NUMERIC, NOT FLOAT64
--
-- Same rule as 002. BigQuery FLOAT64 is IEEE-754 binary, so a close of 1234.55
-- does not round-trip. A chart off by 1e-13 is invisible; a backtest that
-- compounds it is not.
--
-- ## HISTORY FLOORS AT 2023-03-28
--
-- EQUS.MINI's inception. A query for an earlier session returns EMPTY, which is
-- indistinguishable from a market holiday and from a broken query — so the
-- LOADER refuses to ask for one (`EQUS_MINI_HISTORY_FLOOR`), and this comment
-- is here so a reader of the table does not diagnose the absence as data loss.
--
-- ## WHAT THE DATA IS, STATED ONCE
--
-- `EQUS.MINI` is a single ANONYMIZED consolidated publisher (`EQUS.MINI.EQUS`,
-- publisher id 95). Its bars are trade-derived and carry real volume, but it is
-- a VENUE BLEND — a subset of the SIP, not the SIP itself. Do not describe it
-- as "the tape": a backtest sized against it is sized against a subset, and
-- that difference never shows up as an error.

-- ── trade_bar_m1 ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `{{DATASET}}.trade_bar_m1` (
  market               STRING    NOT NULL OPTIONS(description = "US — a COLUMN, never a second dataset. Leads the cluster key because BigQuery prunes on a PREFIX"),
  listing_id           STRING    NOT NULL OPTIONS(description = "{symbol}:{exchange}:{listingStart} — resolved BY DATE, because 2,196 US tickers are recycled (DOW is two companies)"),
  symbol               STRING    NOT NULL,
  exchange             STRING    NOT NULL,
  source_instrument_id INT64              OPTIONS(description = "the vendor's instrument_id. PROVENANCE, never the join key: an id alone cannot separate two occupants of one ticker"),
  publisher_id         INT64              OPTIONS(description = "95 = EQUS.MINI.EQUS today. Kept so a future SIP purchase is distinguishable from this venue blend"),
  ts                   TIMESTAMP NOT NULL OPTIONS(description = "bar OPEN, UTC. Databento stamps the START of the interval; a popular downstream library re-stamps to the CLOSE by default"),
  session_date         DATE      NOT NULL OPTIONS(description = "the ET SESSION date from usMarketDateKey, never a UTC slice — see the header"),
  open                 NUMERIC(18, 6),
  high                 NUMERIC(18, 6),
  low                  NUMERIC(18, 6),
  close                NUMERIC(18, 6),
  volume               INT64              OPTIONS(description = "REAL volume — this feed is trade-derived. 0 means nothing traded, unlike the quote-derived TIINGO_RT bars, which is why those are not in this table"),
  source               STRING    NOT NULL OPTIONS(description = "DATABENTO. NOT NULL and clustered: it is what disambiguates a volume of 0"),

  -- The six mandatory silver columns. lake-layout.md §5: "not optional and not
  -- added later". Without source_object_uri and parser_version a wrong number
  -- cannot be traced to the bytes and the code that produced it, and the only
  -- available repair is to rebuild everything.
  source_object_uri    STRING    NOT NULL,
  source_record_key    STRING    NOT NULL OPTIONS(description = "{symbol}|{ts_event} — which record WITHIN the vendor file"),
  parser_version       STRING    NOT NULL,
  pipeline_run_id      STRING    NOT NULL,
  observed_at          TIMESTAMP NOT NULL OPTIONS(description = "when the SOURCE asserted it — the vendor file's acquisition time"),
  ingested_at          TIMESTAMP NOT NULL OPTIONS(description = "when WE wrote it")
)
PARTITION BY session_date
CLUSTER BY market, listing_id, source
OPTIONS(description = "Databento 1-minute trade bars. One row per (listing_id, ts). History floors at 2023-03-28.");

-- ── trade_bar_h1 ──────────────────────────────────────────────────────────
--
-- Same shape, MONTH partition. A separate TABLE rather than a `timeframe`
-- column on one table, because the partition granularity is the difference:
-- one table cannot be partitioned two ways, and picking either grain makes the
-- other timeframe's queries scan 20x what they need.
CREATE TABLE IF NOT EXISTS `{{DATASET}}.trade_bar_h1` (
  market               STRING    NOT NULL,
  listing_id           STRING    NOT NULL,
  symbol               STRING    NOT NULL,
  exchange             STRING    NOT NULL,
  source_instrument_id INT64,
  publisher_id         INT64,
  ts                   TIMESTAMP NOT NULL OPTIONS(description = "bar OPEN, UTC"),
  session_date         DATE      NOT NULL OPTIONS(description = "the ET SESSION date, never a UTC slice"),
  open                 NUMERIC(18, 6),
  high                 NUMERIC(18, 6),
  low                  NUMERIC(18, 6),
  close                NUMERIC(18, 6),
  volume               INT64,
  source               STRING    NOT NULL,
  source_object_uri    STRING    NOT NULL,
  source_record_key    STRING    NOT NULL,
  parser_version       STRING    NOT NULL,
  pipeline_run_id      STRING    NOT NULL,
  observed_at          TIMESTAMP NOT NULL,
  ingested_at          TIMESTAMP NOT NULL
)
PARTITION BY DATE_TRUNC(session_date, MONTH)
CLUSTER BY market, listing_id, source
OPTIONS(description = "Databento 1-hour trade bars, 12,331 symbols. One row per (listing_id, ts).");

-- ── spread_cost_daily ─────────────────────────────────────────────────────
--
-- What it cost to cross the spread, per listing per session.
--
-- ## THE QUOTED AND EFFECTIVE COLUMNS COME FROM DIFFERENT SCHEMAS AND MUST NOT
-- ## BE COMPUTED FROM ONE ANOTHER
--
-- `bbo-1m` is TIME-UNIFORM: one record a minute per symbol whether or not
-- anything traded. It is the QUOTED spread, and it is the only thing
-- `median_spread_bps` / `p90_spread_bps` may be built from.
--
-- `tbbo` is ACTIVITY-WEIGHTED: one record per trade, so a busy minute
-- contributes hundreds and a quiet one none. It is the EFFECTIVE spread and
-- NOTHING ELSE. Folding a tbbo row's QUOTE into the quoted statistic would
-- re-weight it toward the moments people were trading — which is when spreads
-- are tightest — producing a number that looks like a quoted spread, sits in a
-- column named for one, is biased low, and carries nothing to say so.
--
-- ## A TRADE-ONLY ROW IS NOT WRITTEN
--
-- The model is costed on the QUOTED spread; effective is a supplement to it. A
-- (listing, session) with tbbo samples and no bbo samples yields NO ROW, rather
-- than a row whose quoted columns are NULL — because `tbbo-top50` is a strict
-- subset of the bbo baseline, so such a row means the bbo file for that session
-- was missing, which is a gap to fix and not a measurement.
--
-- ## PARTITIONED BY MONTH THOUGH THE GRAIN IS DAILY
--
-- ~500 listings x ~250 sessions is ~125,000 rows a year. A DAY partition would
-- be ~500 rows, where BigQuery's per-partition metadata costs more than the
-- data.
CREATE TABLE IF NOT EXISTS `{{DATASET}}.spread_cost_daily` (
  market                 STRING    NOT NULL,
  listing_id             STRING    NOT NULL,
  symbol                 STRING    NOT NULL,
  session_date           DATE      NOT NULL OPTIONS(description = "the ET SESSION date"),
  median_spread_bps      NUMERIC(18, 6) NOT NULL OPTIONS(description = "QUOTED, from bbo-1m only. Nearest-rank, so it is a spread that actually occurred"),
  p90_spread_bps         NUMERIC(18, 6) NOT NULL OPTIONS(description = "QUOTED, from bbo-1m only"),
  quote_sample_count     INT64     NOT NULL OPTIONS(description = "how many usable quotes produced the two above — 1.2 bps from 4 quotes is not 1.2 bps from 900"),
  effective_spread_bps   NUMERIC(18, 6)   OPTIONS(description = "from tbbo ONLY, and NULL where no tbbo file covers this listing-session. Doubled half-spread, so it is on the same scale as the quoted number"),
  effective_sample_count INT64            OPTIONS(description = "NULL when effective_spread_bps is NULL. A tbbo stream must never move quote_sample_count"),
  source                 STRING    NOT NULL OPTIONS(description = "DATABENTO"),
  source_object_uri      STRING    NOT NULL OPTIONS(description = "the LAST bbo object folded into this row; the full set is in the partition_load claim"),
  source_record_key      STRING    NOT NULL OPTIONS(description = "{listing_id}|{session_date}"),
  parser_version         STRING    NOT NULL,
  pipeline_run_id        STRING    NOT NULL,
  observed_at            TIMESTAMP NOT NULL,
  ingested_at            TIMESTAMP NOT NULL
)
PARTITION BY DATE_TRUNC(session_date, MONTH)
CLUSTER BY market, listing_id, source
OPTIONS(description = "Quoted (bbo-1m) and effective (tbbo) spread per listing-session. A row requires a quoted sample; effective may be NULL.");
