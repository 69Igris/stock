-- Silver: India F&O EOD, delivery, and index closes. MONEY-1497 (B2-IN).
--
-- `{{DATASET}}` is this file's OWN layer, taken from the basename — `006_SILVER_…`
-- means lake_silver_{env}. `layerOf()` in scripts/ops/lake-apply-ddl.ts THROWS on
-- an unrecognised prefix rather than defaulting, because the default is what
-- created a silver table in the bronze dataset once already.
--
-- ## THE TWO TABLES THIS FILE DOES *NOT* CREATE
--
-- `price_bar_d1` and `corporate_action` already exist, from
-- `002_silver_price_bars.sql`. B2-IN writes market='IN' rows INTO them. `market`
-- is a COLUMN and a cluster key, never a second dataset — so there is nothing to
-- redefine here, and redefining it would be the worse kind of no-op: `CREATE
-- TABLE IF NOT EXISTS` reports success against the table that is already there,
-- so a divergent second definition of the same table applies cleanly and
-- silently does nothing.
--
-- ## `derivatives_eod_in` IS URGENT RATHER THAN LATER
--
-- Mongo's `derivative_eod` is 24.0 GiB — 7.9 GiB of data behind 16.1 GiB of
-- indexes, the four largest indexes in the database, against an M40 whose RAM is
-- 16 GB (docs/reference/atlas-heatmap-2026-09.md). It is parsed from the same
-- archived F&O UDiFF files `feed-parse` already reads, so the lake copy costs a
-- second sink rather than a second source.
--
-- ## WHY THE NAME CARRIES `_in` WHEN `price_bar_d1` DOES NOT
--
-- Not a market split — the `market` column is here too, and a future
-- `derivatives_eod_us` would be merged into this table rather than sitting
-- beside it. The suffix is inherited from the B2-IN brief and kept because
-- renaming a table after rows land costs a copy; what matters is that `market`
-- exists so the merge is a rename and not a redesign.
--
-- ## NUMERIC, NEVER FLOAT64, for every price, settle and ratio
--
-- BigQuery FLOAT64 is IEEE-754 binary: 0.1 + 0.2 != 0.3 and a settle of 1234.55
-- does not round-trip. Invisible on a chart; compounding in a backtest.
--
-- ## INT64 FOR EVERY COUNT, and it arrives as a decimal STRING
--
-- Open interest and traded quantity are counts. Over the JSON load path an INT64
-- is written as a STRING — a JS number loses precision above 2^53 and a `bigint`
-- does not survive `JSON.stringify` at all, it THROWS. `volumeToInt64String` in
-- price-bar-logic.ts is the one encoder; india-sink-logic.ts reuses it rather
-- than restating the rule.

-- ─────────────────────────────────────────────────────────────────────────
-- derivatives_eod_in — one row per contract per session
-- ─────────────────────────────────────────────────────────────────────────
--
-- THE CONTRACT KEY IS FIVE COLUMNS: underlying, instrument_type, expiry_date,
-- strike_price, option_type. Two of them are NULL for a future, and that is the
-- point — a futures row and an option row on the same underlying and expiry are
-- different contracts, and only `option_type` separates a call from a put at the
-- same strike.
--
-- CLUSTER BY underlying, expiry_date — NOT the `market, listing_id, source` that
-- lake-layout.md §4 mandates for every partitioned table, and this is a
-- deliberate, stated departure rather than an oversight:
--
--   * `market` has exactly one value in this table. A cluster key whose column
--     is constant prunes nothing, and BigQuery prunes only on a PREFIX of the
--     key — so leading with it would disable pruning for every query.
--   * `listing_id` does not exist for a derivative. B3's `listing` table holds
--     cash securities; a contract is not one. The column would be NULL on every
--     row, which is the same defect one column over.
--
-- `underlying` then `expiry_date` is the access pattern: every F&O query names
-- an underlying, and the second filter is nearly always a single expiry (basis,
-- term structure, rollover, PCR, max-pain all slice that way).
CREATE TABLE IF NOT EXISTS `{{DATASET}}.derivatives_eod_in` (
  market            STRING    NOT NULL OPTIONS(description = "IN. A column, so a future derivatives_eod_us is a MERGE and not a redesign."),
  underlying        STRING    NOT NULL OPTIONS(description = "TckrSymb / the legacy SYMBOL — NIFTY, RELIANCE. Not a listing_id: a contract is not a listing."),
  exchange          STRING    NOT NULL OPTIONS(description = "NSE | BSE"),
  instrument_type   STRING    NOT NULL OPTIONS(description = "FUTIDX | FUTSTK | OPTIDX | OPTSTK — part of the contract key"),
  expiry_date       DATE      NOT NULL,
  strike_price      NUMERIC(18, 6)     OPTIONS(description = "NULL for a future. NULL is the VALUE here, not a gap."),
  option_type       STRING             OPTIONS(description = "CE | PE; NULL for a future. The only thing separating a call from a put at one strike."),
  session_date      DATE      NOT NULL OPTIONS(description = "the venue's trading day"),

  open              NUMERIC(18, 6),
  high              NUMERIC(18, 6),
  low               NUMERIC(18, 6),
  close             NUMERIC(18, 6),
  settle_price      NUMERIC(18, 6)     OPTIONS(description = "SttlmPric. Blank on illiquid strikes in UDiFF; FOSett_prce is the authoritative fallback."),
  open_interest     INT64              OPTIONS(description = "OpnIntrst, in contracts"),
  change_in_oi      INT64              OPTIONS(description = "ChngInOpnIntrst. SIGNED — may legitimately be negative."),
  contracts_traded  INT64              OPTIONS(description = "TtlTradgVol / the legacy CONTRACTS column"),
  value_lakh        NUMERIC(18, 6)     OPTIONS(description = "TtlTrfVal / 100,000 — LAKH, the unit both parsers already emit. NUMERIC because it is money, and NOT rescaled to rupees: the rescale belongs to a reader that states its unit, not to a store that silently changes one."),

  source            STRING    NOT NULL OPTIONS(description = "BHAVCOPY | BHAVCOPY_HIST — the authority rank from price-source-authority.ts"),

  source_object_uri STRING    NOT NULL,
  source_record_key STRING    NOT NULL,
  parser_version    STRING    NOT NULL,
  pipeline_run_id   STRING    NOT NULL,
  observed_at       TIMESTAMP NOT NULL OPTIONS(description = "when the SOURCE asserted it — the archived file's own date"),
  ingested_at       TIMESTAMP NOT NULL
)
PARTITION BY DATE_TRUNC(session_date, MONTH)
CLUSTER BY underlying, expiry_date
OPTIONS(description = "India F&O EOD. One row per (underlying, instrument_type, expiry, strike, option_type, session_date). Replaces the read path onto Mongo derivative_eod, which is 24.0 GiB with 16.1 GiB of indexes.");

-- ─────────────────────────────────────────────────────────────────────────
-- delivery_daily — deliverable quantity, from TWO files with different shapes
-- ─────────────────────────────────────────────────────────────────────────
--
-- `sec_bhavdata_full` (~Oct-2019 onward) carries SYMBOL, SERIES and delivery in
-- one row. `MTO_{DDMMYYYY}.DAT` (~Apr-2003 onward) is the only delivery source
-- before that, and its record-type-20 rows carry NO SERIES COLUMN AT ALL
-- (per-file-derivable-map.md correction 2, verified against the repaired
-- archive).
--
-- SO `series` IS NULLABLE AND NULL MEANS "THE FILE DID NOT SAY", never "no
-- series". Defaulting it to 'EQ' would be a fabricated value that every later
-- series filter would silently trust — and it would be wrong for exactly the
-- BE/BZ trade-for-trade rows whose delivery is 100% by construction, which is
-- the population a delivery analysis most needs to exclude.
--
-- `delivery_pct` is likewise NULL, not 0, where the file prints `-`. Zero
-- delivery and unreported delivery are different facts and a mean over them
-- differs by the whole column.
CREATE TABLE IF NOT EXISTS `{{DATASET}}.delivery_daily` (
  market            STRING    NOT NULL,
  -- Described by the ALTER after this statement, and only there. See it.
  listing_id        STRING    NOT NULL,
  symbol            STRING    NOT NULL,
  exchange          STRING    NOT NULL,
  isin              STRING             OPTIONS(description = "NULL on every MTO row and on pre-ISIN legacy rows — absence of an ISIN is not absence of a security"),
  series            STRING             OPTIONS(description = "NULL means THE FILE DID NOT SAY. MTO carries no SERIES column; defaulting to EQ would fabricate the one value a delivery screen must exclude."),
  session_date      DATE      NOT NULL,

  traded_qty        INT64,
  deliverable_qty   INT64,
  delivery_pct      NUMERIC(9, 4)      OPTIONS(description = "NULL where the file printed `-`. Zero delivery and unreported delivery are different facts."),

  source            STRING    NOT NULL,
  resolution_method STRING             OPTIONS(description = "how listing_id was resolved — EXACT_ISIN | SYMBOL_VENUE_CURRENT | …, the vocabulary in identity-logic.ts"),

  source_object_uri STRING    NOT NULL,
  source_record_key STRING    NOT NULL,
  parser_version    STRING    NOT NULL,
  pipeline_run_id   STRING    NOT NULL,
  observed_at       TIMESTAMP NOT NULL,
  ingested_at       TIMESTAMP NOT NULL
)
PARTITION BY DATE_TRUNC(session_date, MONTH)
CLUSTER BY market, listing_id, source
OPTIONS(description = "Daily delivery. Two sources with different shapes: sec_bhavdata_full carries SERIES, MTO does not.");

-- The one-spelling description, as an ALTER so it reaches the table prod
-- already holds — `002_silver_price_bars.sql` gives the reasoning for
-- price_bar_d1's identical statement (MONEY-1522). This column said
-- "{symbol}:{exchange} — the same spelling price_bar_d1 uses", and both halves
-- stopped being true together; the rows move with parser version
-- `in-delivery-v2`.
ALTER TABLE `{{DATASET}}.delivery_daily`
  ALTER COLUMN listing_id SET OPTIONS(description = "{symbol}:{exchange}:unknown — buildListingId(symbol, exchange, null), the same id price_bar_d1 and silver.listing carry. Built two ways and disagreeing by one character, it splits one security in two.");

-- ─────────────────────────────────────────────────────────────────────────
-- index_eod — all thirteen columns of ind_close_all, not the four we store now
-- ─────────────────────────────────────────────────────────────────────────
--
-- The engine's `IndexClose` keeps OHLC. P/E, P/B, Div Yield, Volume and Turnover
-- are FETCHED AND DISCARDED every single day (per-file-derivable-map.md §2), and
-- they are the columns a valuation screen is actually built from. They are here
-- because the bytes are already archived: recovering them later is a reparse,
-- and this table is the reason a reparse is possible at all.
--
-- KEYED ON `index_slug`, NOT ON THE PRINTED NAME. NSE's index name is
-- cosmetically unstable ("Nifty 50" / "NIFTY 50" / "Nifty50"), so the slug from
-- `toIndexSlug` is the join key and the raw name is kept alongside it as
-- evidence of what the file actually said.
--
-- EVERY MEASURE IS NULLABLE. `Nifty50 Dividend Points` prints `-` for O/H/L,
-- volume, turnover, P/E, P/B and div yield while carrying a real close, so a row
-- is legitimately almost entirely null. A NOT NULL on any measure would reject a
-- valid row.
CREATE TABLE IF NOT EXISTS `{{DATASET}}.index_eod` (
  market            STRING    NOT NULL,
  index_slug        STRING    NOT NULL OPTIONS(description = "toIndexSlug(name) — the stable key. The printed name drifts cosmetically."),
  index_name        STRING             OPTIONS(description = "verbatim from the file, as evidence of what it said on that date"),
  exchange          STRING    NOT NULL OPTIONS(description = "NSE | BSE"),
  session_date      DATE      NOT NULL OPTIONS(description = "`Index Date`, which NSE writes DD-MM-YYYY — not DD-MMM-YYYY"),

  open              NUMERIC(18, 6),
  high              NUMERIC(18, 6),
  low               NUMERIC(18, 6),
  close             NUMERIC(18, 6),
  prev_close        NUMERIC(18, 6)     OPTIONS(description = "the file's `Points Change` and `Change(%)` are DERIVABLE from this and `close`, so only the fact is stored. NSE writes sub-1 decimals with a leading dot (`.97`, `-.22`), which is a PARSER concern, not a column."),
  volume            INT64,
  turnover_cr       NUMERIC(18, 6)     OPTIONS(description = "Turnover (Rs. Cr.) — the file's own unit, kept rather than rescaled"),
  pe_ratio          NUMERIC(18, 6)     OPTIONS(description = "fetched and DISCARDED daily today"),
  pb_ratio          NUMERIC(18, 6)     OPTIONS(description = "fetched and DISCARDED daily today"),
  div_yield         NUMERIC(18, 6)     OPTIONS(description = "fetched and DISCARDED daily today"),

  source            STRING    NOT NULL,

  source_object_uri STRING    NOT NULL,
  source_record_key STRING    NOT NULL,
  parser_version    STRING    NOT NULL,
  pipeline_run_id   STRING    NOT NULL,
  observed_at       TIMESTAMP NOT NULL,
  ingested_at       TIMESTAMP NOT NULL
)
PARTITION BY DATE_TRUNC(session_date, MONTH)
CLUSTER BY market, index_slug, source
OPTIONS(description = "India index closes, all 13 ind_close_all columns. Every measure nullable: a dividend-points row prints `-` for all but the close.");

-- ─────────────────────────────────────────────────────────────────────────
-- price_bar_d1 gains `isin` — a MIGRATION, not a redefinition
-- ─────────────────────────────────────────────────────────────────────────
--
-- This is the applier's documented second form: `CREATE TABLE IF NOT EXISTS` in
-- an earlier file, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in a later one.
-- `006_` sorts after `002_`, and filename order IS migration order.
--
-- ## WHY THE COLUMN HAS TO BE HERE
--
-- ISIN is the durable identity of an Indian security, and the exchange files
-- carry it on the row. `003_silver_identity.sql` already keys India off it.
-- Without this column the bhavcopy replay parses an ISIN out of the bytes and
-- then throws it away, and every later identity repair — a rename, a reused
-- ticker, a dual listing — becomes a full thirty-year REPARSE instead of a
-- query.
--
-- It is NULL for US rows (Tiingo's master carries none) and NULL for pre-ISIN
-- legacy India rows, which is a far larger slice of history than folklore
-- suggests: `cm14NOV2006bhav.csv` still ends at `TIMESTAMP,` with no ISIN
-- column at all. `resolution_method` is what distinguishes the two cases —
-- EXACT_ISIN when the row carried one, SYMBOL_VENUE_DATED when it did not.
--
-- NOT in the cluster key. lake-layout.md §4 fixes that at
-- `market, listing_id, source`, BigQuery prunes only on a prefix, and a column
-- that is NULL for every US row would prune nothing for half the table.
ALTER TABLE `{{DATASET}}.price_bar_d1`
  ADD COLUMN IF NOT EXISTS isin STRING
  OPTIONS(description = "the durable Indian identity, verbatim from the exchange file. NULL for US rows and for pre-ISIN legacy India rows — `resolution_method` says which.");
