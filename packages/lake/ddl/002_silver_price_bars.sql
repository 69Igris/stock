-- Silver: daily bars, fund NAVs, corporate actions.
-- MONEY-1496 (data-platform B2) + MONEY-1497 (B2-IN).
--
-- Applied by scripts/ops/lake-apply-ddl.ts. `{{DATASET}}` is substituted with
-- lake_silver_{env} — the LAYER comes from this filename (`002_silver_…`), and
-- the applier throws rather than defaulting if it cannot read one.
--
-- ONE TABLE, TWO MARKETS. `price_bar_d1` holds market='US' (Tiingo, B2) and
-- market='IN' (bhavcopy, B2-IN). `market` is a COLUMN and a cluster key, never
-- a second dataset — the single-region rule from lake-layout.md. A second
-- dataset would force every cross-market query into a UNION and make the
-- partition pruning per-market instead of per-month.
--
-- NUMERIC, NOT FLOAT64, for every price. BigQuery FLOAT64 is IEEE-754 binary,
-- so 0.1 + 0.2 != 0.3 and a close of 1234.55 does not round-trip. Prices are
-- decimal quantities; a chart that is off by 1e-13 is invisible, and a
-- backtest that compounds it is not.
--
-- VOLUME IS INT64 and may legitimately be 0. Two DIFFERENT zeros exist and the
-- schema cannot tell them apart, so `source` must: a quote-derived bar
-- (TIINGO_RT) carries a STRUCTURAL zero meaning "this feed does not report
-- volume", while a trade-derived bar with volume 0 means nothing traded. That
-- is why `source` is NOT NULL and is a cluster key.

-- ── price_bar_d1 ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `{{DATASET}}.price_bar_d1` (
  market            STRING    NOT NULL OPTIONS(description = "US | IN — a COLUMN, never a second dataset"),
  -- Described by the ALTER after this statement, and only there. See it.
  listing_id        STRING    NOT NULL,
  symbol            STRING    NOT NULL,
  exchange          STRING    NOT NULL,
  session_date      DATE      NOT NULL OPTIONS(description = "the VENUE's session day, never a UTC date — a US post-market bar lands on the next UTC day"),
  open              NUMERIC(18, 6),
  high              NUMERIC(18, 6),
  low               NUMERIC(18, 6),
  close             NUMERIC(18, 6),
  volume            INT64              OPTIONS(description = "0 is ambiguous without `source`: structural (quote-derived feed) vs nothing traded"),
  div_cash          NUMERIC(18, 6)     OPTIONS(description = "Tiingo rides this on the EOD row; > 0 IS a distribution on that ex-date"),
  split_factor      NUMERIC(18, 6)     OPTIONS(description = "!= 1 IS a split. Tiingo's live response has NO splitStatus field despite the docs"),
  source            STRING    NOT NULL OPTIONS(description = "BHAVCOPY | TIINGO | YAHOO | ZERODHA — the authority rank, and what disambiguates volume 0"),
  resolution_method STRING             OPTIONS(description = "how listing_id was resolved (B2-IN: pre-ISIN legacy rows resolve by symbol@exchange)"),

  -- The six mandatory silver columns. lake-layout.md §5: "not optional and not
  -- added later". Without source_object_uri and parser_version a wrong number
  -- cannot be traced back to the bytes that produced it.
  source_object_uri STRING    NOT NULL,
  source_record_key STRING    NOT NULL,
  parser_version    STRING    NOT NULL,
  pipeline_run_id   STRING    NOT NULL,
  observed_at       TIMESTAMP NOT NULL OPTIONS(description = "when the SOURCE asserted it"),
  ingested_at       TIMESTAMP NOT NULL OPTIONS(description = "when WE wrote it")
)
PARTITION BY DATE_TRUNC(session_date, MONTH)
CLUSTER BY market, listing_id, source
OPTIONS(description = "Daily bars, both markets. One row per (market, listing_id, session_date, source).");

-- ── listing_id: ONE spelling, stated ONCE — MONEY-1522 ────────────────────
--
-- This column used to document TWO spellings — "US: {symbol}:{exchange}:
-- {listingStart} … IN: {symbol}:{exchange}" — and prod wrote both. India's
-- identity table (`003_silver_identity.sql`, `listing`) was built by
-- buildListingId() as `{symbol}:{exchange}:unknown`, the bars by a second
-- function as `{symbol}:{exchange}`, and measured 2026-09-22 the two id sets
-- (23,907 and 16,898) intersected in NOTHING. Founder decision 2026-09-23:
-- three segments in every market, one builder, and India's bars are the side
-- rewritten (parser version `in-bhavcopy-v2`).
--
-- AN ALTER, NOT AN OPTIONS ON THE CREATE. `CREATE TABLE IF NOT EXISTS` never
-- touches a table that already exists, so a description written there reaches
-- a FRESH dataset only — prod's column would go on stating the retired
-- spelling in the one place a reader checks. `SET OPTIONS` is idempotent, so a
-- re-apply stays a no-op. And the text lives HERE ONLY: a copy on the CREATE
-- would be overwritten by this statement on every apply, so an edit made there
-- would silently never land.
ALTER TABLE `{{DATASET}}.price_bar_d1`
  ALTER COLUMN listing_id SET OPTIONS(description = "{symbol}:{exchange}:{listingStartDate} in EVERY market, built only by buildListingId(). India holds no listing start date, so its third segment is the literal `unknown` — the same id silver.listing carries, which is what lets identity and bars join. US: recycled tickers — see model Candle.");

-- ── fund_nav_d1 ───────────────────────────────────────────────────────────
--
-- SEPARATE from price_bar_d1 even though a fund's OHLC carries its NAV,
-- because the KEY differs: funds key on permaTicker, which is NOT derivable
-- from the master and exists only for securities that have had a corporate
-- action. Folding them into one table would put a column that is null for
-- ~49,000 rows into the cluster key.
CREATE TABLE IF NOT EXISTS `{{DATASET}}.fund_nav_d1` (
  perma_ticker      STRING    NOT NULL OPTIONS(description = "Tiingo's stable id. NOT in the master and NOT derivable — a delisted fund can never get one"),
  symbol            STRING,
  nav_date          DATE      NOT NULL,
  nav               NUMERIC(18, 6),
  source            STRING    NOT NULL,
  source_object_uri STRING    NOT NULL,
  source_record_key STRING    NOT NULL,
  parser_version    STRING    NOT NULL,
  pipeline_run_id   STRING    NOT NULL,
  observed_at       TIMESTAMP NOT NULL,
  ingested_at       TIMESTAMP NOT NULL
)
PARTITION BY DATE_TRUNC(nav_date, MONTH)
CLUSTER BY perma_ticker
OPTIONS(description = "US mutual-fund NAVs. Includes the years tiingo-us-backfill dropped as navColdDropped.");

-- ── corporate_action ──────────────────────────────────────────────────────
--
-- APPEND-ONLY. A correction is a NEW ROW with a later observed_at, never an
-- UPDATE, because the adjustment is computed at READ time from the full set:
-- rewriting history in place would silently restate every adjusted series that
-- had already been served, with nothing to show it happened.
--
-- Partitioned on published_at (when the source announced it) rather than
-- ex_date (when it takes effect), because the ingest is announcement-ordered
-- and a query asking "what arrived today" is the common one. ex_date is a
-- cluster key instead.
CREATE TABLE IF NOT EXISTS `{{DATASET}}.corporate_action` (
  market            STRING    NOT NULL,
  listing_id        STRING    NOT NULL,
  action_type       STRING    NOT NULL OPTIONS(description = "SPLIT | DIVIDEND | BONUS | RIGHTS | …"),
  ex_date           DATE,
  record_date       DATE,
  ratio             NUMERIC(18, 6)     OPTIONS(description = "split/bonus ratio"),
  cash              NUMERIC(18, 6)     OPTIONS(description = "cash per share"),
  source            STRING    NOT NULL,
  published_at      TIMESTAMP NOT NULL OPTIONS(description = "the archive OBJECT's date — when the source announced it"),
  source_object_uri STRING    NOT NULL,
  source_record_key STRING    NOT NULL,
  parser_version    STRING    NOT NULL,
  pipeline_run_id   STRING    NOT NULL,
  observed_at       TIMESTAMP NOT NULL OPTIONS(description = "archive generation time"),
  ingested_at       TIMESTAMP NOT NULL
)
PARTITION BY DATE(published_at)
CLUSTER BY market, listing_id, action_type
OPTIONS(description = "Corporate actions, append-only. A correction is a new row, never an update.");

-- ── corporate_action gains `observed_ratio` — MONEY-1528 (B) ──────────────
--
-- The adjustment could only divide a CAPITAL_ADJUSTMENT by `ratio`, which on a
-- price-derived row is the observed factor SNAPPED to the nearest plausible
-- rational (`corporate-action-detect.ts`, 3% tolerance). `actionFactor` in
-- `price-adjust.ts` prefers the OBSERVED value for every type but SPLIT and
-- BONUS, because a capital adjustment has no clean rational: the chart divided
-- IVZINNIFTY's 2026-07-31 cliff by 9.93 where gold divided it by 10, a
-- permanent level shift between what a user sees and what a backtest reads.
--
-- Measured on prod 2026-09-23: 156 of 59,224 Mongo rows carry
-- `details.observedRatio`, every one DERIVED CAPITAL_ADJUSTMENT, 154 of them
-- unequal to the snapped `ratio` (worst 2.97%). NSE, BSE and SCREENER rows keep
-- `details` as the announcement STRING, so this is NULL for them.
--
-- NUMERIC(18, 6) like `ratio`, and rounded to that scale at the row boundary
-- (MONEY-1512): it is a quotient of two closes and carries fifteen decimals.
-- An ALTER in the file that created the table, for 006's reason: CREATE TABLE
-- IF NOT EXISTS never adds a column to a table that already exists.
ALTER TABLE `{{DATASET}}.corporate_action`
  ADD COLUMN IF NOT EXISTS observed_ratio NUMERIC(18, 6)
  OPTIONS(description = "the post:pre factor MEASURED from the price series (Mongo details.observedRatio), beside `ratio`, which a DERIVED row holds snapped to the nearest plausible rational. NULL unless the price-derived detector wrote the row. actionFactor (price-adjust.ts) prefers it over `ratio` for every type but SPLIT and BONUS.");
