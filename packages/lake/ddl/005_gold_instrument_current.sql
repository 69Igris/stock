-- gold: one row per active listing. MONEY-1498 (data-platform B3).
--
-- Separate file because the applier routes PER FILE, not per statement:
-- `{{DATASET}}` is this file's own layer, taken from the basename, so
-- `005_GOLD_…` targets lake_gold_{env}. `{{SILVER}}` names the source tables in
-- 003_silver_identity.sql, which is the one thing a gold projection cannot
-- avoid needing — a gold object is a view over silver almost by definition.
--
-- ## A VIEW, NOT A TABLE, AND NOT A MATERIALIZED VIEW
--
-- "One row per active listing" is exactly `WHERE valid_to IS NULL`. A table
-- would be a COPY of that, which needs a job to keep current and can therefore
-- be stale — and a stale identity projection is the failure this whole ticket
-- is about, rebuilt one layer up in gold. A view cannot drift.
--
-- Materializing it is a one-word change if a read path ever measures the scan
-- as too slow. Nothing is waiting on it today: `listing` is tens of thousands
-- of rows, and §8 of lake-layout.md forbids the web request path from querying
-- BigQuery at all, so no user page-load is behind this.
--
-- ## `sector` COMES FROM `InstrumentMapping` AND IS NOT VERSIONED
--
-- The spec asks for sector here. It rides on the `listing` row as ENRICHMENT —
-- written in place by identity-sync, never versioned (see IDENTITY_FIELDS in
-- identity-logic.ts). Versioning it would open a new row per symbol per weekly
-- sector correction and bury the handful of real renames under thousands of
-- them. It is NULL for US rows, which have no sector source yet; NULL means
-- "not known", never "none", and a reader must not treat it as a category.
--
-- ## `listed_since` IS THE LISTING'S FIRST `valid_from`, NOT THE OPEN ROW'S
--
-- MONEY-1602. Since MONEY-1544 a delisted listing's OPEN row is its DELISTED
-- version, which starts the day after its last session — so the open row's
-- `valid_from` is a delisting date, and reading it as `listed_since` said Dow
-- Chemical listed in 2017. It is the MIN over every version of the listing:
-- the source's listing date (US) or first bar (India).
--
-- Applied by `ops/lake-apply-ddl.ts` on every run like everything else here;
-- `CREATE OR REPLACE VIEW` makes a re-run replace the view with itself.
CREATE OR REPLACE VIEW `{{DATASET}}.instrument_current` AS
SELECT
  l.listing_id,
  l.market,
  l.venue,
  l.symbol,
  l.isin,
  l.name,
  l.asset_type,
  l.currency,
  l.status,
  f.listed_since,
  l.perma_ticker,
  l.cik10,
  l.cusip,
  l.sector,
  l.industry,
  l.source,
  l.observed_at,
  l.ingested_at
FROM `{{SILVER}}.listing` l
JOIN (
  SELECT listing_id, MIN(valid_from) AS listed_since
  FROM `{{SILVER}}.listing`
  GROUP BY listing_id
) f USING (listing_id)
WHERE l.valid_to IS NULL;
