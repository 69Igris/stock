-- Security identity. MONEY-1498 (data-platform B3).
--
-- `{{DATASET}}` is this file's OWN layer, taken from the filename — `003_SILVER_…`
-- means lake_silver_{env}. One file targets ONE dataset: the
-- gold projection over these tables is 005_gold_instrument_current.sql.
--
-- Same conventions as 001: no ENUM types (BigQuery has none — the vocabularies
-- are closed in packages/lake/src/identity-logic.ts and refused on write) and no
-- primary keys (BigQuery enforces none; uniqueness is by convention and by the
-- sync job's MERGE).
--
-- ## WHAT HISTORY WE ACTUALLY HAVE, PER MARKET
--
-- US: REAL. Tiingo's master carries listingStartDate/listingEndDate per row and
-- holds DELISTED rows, so `DOW` genuinely resolves to Dow Chemical for a 2017
-- as-of and Dow Inc. for a 2020 one.
--
-- INDIA: CURRENT-ONLY, and this is a limitation rather than a shape.
-- `InstrumentMapping` is OVERWRITTEN on every instrument-sync, so it asserts
-- today and nothing else. NSE publishes symbol changes, but this repo does NOT
-- archive them: `packages/core/src/market-data/report-registry.ts` holds 26
-- families (bhavcopies, index closes, deals, debt, XBRL) and NONE of them is a
-- symbolchange/namechange family — verified by grep, MONEY-1498. The only
-- history we hold is `InstrumentMapping.previousSymbols`, which carries labels
-- with NO dates attached.
--
-- So an India row seeded from a current symbol is stamped method
-- SYMBOL_VENUE_CURRENT (confidence 0.7) and a previousSymbols alias is stamped
-- SYMBOL_ALIAS_UNDATED (0.5) with NULL validity. A past `as_of` against either
-- is a guess, and the confidence and the NULL are how the table says so instead
-- of implying a history it does not have.
--
-- Registering and backfilling an NSE symbol-change family is MONEY-1499's
-- territory, not a parser fix here.
--
-- ## HOW `listing.valid_from` IS DATED — MONEY-1544 (parser identity/2)
--
-- A listing's FIRST version starts on its SOURCE's date: US, Tiingo's
-- listingStartDate (a delisted listing is ACTIVE through listingEndDate and
-- DELISTED from the day after); India, the listing's first session in
-- price_bar_d1 — the archive's first evidence it traded, not an inception
-- date, floored by the archive (NSE 1994-11-03, BSE 2024-01-01) — or, with no
-- bar, the day identity-sync first observed it. A change observed LATER is
-- dated the day identity-sync observes it. identity/1 opened every first
-- version on the run day (2026-09-22); `identity-sync --rebase-history`
-- re-dates those. No column changes, so no ALTER.
--
-- MONEY-1602: an India instrument the master no longer lists (or never did —
-- InstrumentMapping holds only what existed in 2026) is a listing from its
-- bars: ACTIVE to its last session, DELISTED from the day after; name, ISIN
-- and asset_type NULL when no master row supplies them. One with no bars is
-- counted by identity-sync and never becomes a listing.

-- ─────────────────────────────────────────────────────────────────────────
-- listing — one row per (security, validity window). SCD-2.
-- ─────────────────────────────────────────────────────────────────────────
--
-- NOT PARTITIONED, deliberately. lake-layout.md §4 mandates clustering on
-- `market, listing_id, source` for every PARTITIONED table; this one is not.
-- Partitioning by `valid_from` would scatter one security's versions across
-- decades of monthly partitions and prune nothing for the query this table
-- exists to answer ("which listing, as of D"), which filters on a RANGE that
-- spans partitions rather than on a partition key. The table is small — tens of
-- thousands of rows — so a cluster-only layout is the cheaper shape.
--
-- CLUSTER BY market, symbol: BigQuery prunes only on a PREFIX of the cluster
-- key, and every query filters market first because it is coarse and always
-- known.
CREATE TABLE IF NOT EXISTS `{{DATASET}}.listing` (
  listing_id   STRING NOT NULL OPTIONS(description = "{symbol}:{venue}:{listingStartDate} — built by buildListingId() in tiingo-logic.ts, the SAME spelling Candle.listingId uses. A listing id built two ways that disagree by one character splits one security's history into two."),
  market       STRING NOT NULL OPTIONS(description = "US | IN. A COLUMN, never a second dataset."),
  venue        STRING NOT NULL OPTIONS(description = "NYSE | NASDAQ | AMEX | NYSE ARCA | BATS | NMFQS | NSE | BSE"),
  symbol       STRING NOT NULL OPTIONS(description = "as the venue spells it: dashes not periods for US class shares (BRK-A)"),
  isin         STRING          OPTIONS(description = "the durable identity for an Indian security; NULL for most US rows"),
  name         STRING          OPTIONS(description = "NULL until the name leg reaches the row — never defaulted to the symbol, which would erase 'we do not know'"),
  asset_type   STRING          OPTIONS(description = "Stock | ETF | Mutual Fund | EQUITY | INDEX | DEBT …"),
  currency     STRING,
  valid_from   DATE   NOT NULL OPTIONS(description = "INCLUSIVE"),
  valid_to     DATE            OPTIONS(description = "EXCLUSIVE, NULL = open. Half-open [from, to) so a close-and-open on the SAME day matches exactly one row. A vendor's inclusive last-traded date is converted by endDateToValidTo()."),
  status       STRING NOT NULL OPTIONS(description = "ACTIVE | DELISTED"),
  perma_ticker STRING          OPTIONS(description = "Tiingo's durable id. ACTIVE-ONLY by construction, so it can NEVER name a delisted predecessor — enrichment, never the identity."),
  cik10        STRING          OPTIONS(description = "SEC Central Index Key, from UsFiler"),
  cusip        STRING          OPTIONS(description = "from UsCusipMap"),
  sector       STRING          OPTIONS(description = "enrichment: re-derived by a weekly pass, NOT versioned — see IDENTITY_FIELDS"),
  industry     STRING,
  source       STRING NOT NULL OPTIONS(description = "which system asserted this version"),

  source_object_uri STRING    NOT NULL,
  source_record_key STRING    NOT NULL,
  parser_version    STRING    NOT NULL,
  pipeline_run_id   STRING    NOT NULL,
  observed_at       TIMESTAMP NOT NULL OPTIONS(description = "when the SOURCE asserted it — point-in-time correctness is this, never ingested_at"),
  ingested_at       TIMESTAMP NOT NULL
)
CLUSTER BY market, symbol
OPTIONS(description = "SCD-2 security identity. A row is CLOSED (valid_to set) and a successor OPENED; identity is never updated in place. India rows are current-only — NSE symbol-change history is not archived by this repo.");

-- ─────────────────────────────────────────────────────────────────────────
-- symbol_history — which label a listing wore, and when.
-- ─────────────────────────────────────────────────────────────────────────
--
-- A TABLE rather than a view over `listing`, and the reason is the India
-- caveat above. A view could only ever project rows that have a `valid_from`,
-- and `InstrumentMapping.previousSymbols` carries labels with NO dates — the
-- ZOMATO that is now ETERNAL, the TATAMOTORS that is now TMCV + TMPV. Those are
-- real, searchable, undated facts, and dropping them because they do not fit a
-- view's shape would make the retired ticker match nothing at all (MONEY-1177).
--
-- BOTH DATES NULL means "traded under this label at some time we cannot state".
-- `resolveSymbol` ranks a dated row above an undated one, because an undated
-- alias matches every as-of by construction and would otherwise outrank the
-- real listing on its own trading days.
CREATE TABLE IF NOT EXISTS `{{DATASET}}.symbol_history` (
  listing_id STRING NOT NULL,
  symbol     STRING NOT NULL,
  venue      STRING NOT NULL,
  valid_from DATE            OPTIONS(description = "NULL = UNDATED alias (previousSymbols). Not a defect — the date is genuinely unknown."),
  valid_to   DATE            OPTIONS(description = "EXCLUSIVE, NULL = current or unknown"),

  source_object_uri STRING    NOT NULL,
  source_record_key STRING    NOT NULL,
  parser_version    STRING    NOT NULL,
  pipeline_run_id   STRING    NOT NULL,
  observed_at       TIMESTAMP NOT NULL,
  ingested_at       TIMESTAMP NOT NULL
)
CLUSTER BY symbol, venue
OPTIONS(description = "Label history. Clustered symbol-first because the query is 'what was SYM on date D' — the reverse of listing's.");

-- ─────────────────────────────────────────────────────────────────────────
-- source_instrument_map — every external key, tied to a listing.
-- ─────────────────────────────────────────────────────────────────────────
--
-- `confidence` is derived from `method` by confidenceFor(), never chosen at a
-- call site: a free-floating float lets two writers disagree about what 0.8
-- means, and the floor that decides whether a row may be a JOIN key
-- (MIN_JOIN_CONFIDENCE = 0.5) then means two different things.
--
-- FLOAT64 rather than NUMERIC: this is a score, not money. 001's `cost_usd` is
-- NUMERIC for the opposite reason.
CREATE TABLE IF NOT EXISTS `{{DATASET}}.source_instrument_map` (
  source     STRING  NOT NULL OPTIONS(description = "TIINGO | DATABENTO | SEC | NSE | BSE | KITE | UPSTOX | GROWW | ANGEL | DHAN | FYERS | ICICI | HDFC | IBKR | YAHOO"),
  source_key STRING  NOT NULL OPTIONS(description = "the source's own key, VERBATIM — a Zerodha token, 'NSE_EQ|INE002A01018', a Tiingo ticker. Never case-folded: case-folding a key whose case the vendor chose merges two vendors' distinct keys."),
  listing_id STRING  NOT NULL,
  valid_from DATE             OPTIONS(description = "NULL = undated"),
  valid_to   DATE             OPTIONS(description = "EXCLUSIVE, NULL = open"),
  confidence FLOAT64 NOT NULL OPTIONS(description = "derived from method; >= 0.5 to be usable as a join key"),
  method     STRING  NOT NULL OPTIONS(description = "VENDOR_NATIVE | EXACT_ISIN | EXACT_CIK | EXACT_PERMATICKER | SYMBOL_VENUE_DATED | SYMBOL_VENUE_CURRENT | SYMBOL_ALIAS_UNDATED | NAME_FUZZY"),

  source_object_uri STRING    NOT NULL,
  source_record_key STRING    NOT NULL,
  parser_version    STRING    NOT NULL,
  pipeline_run_id   STRING    NOT NULL,
  observed_at       TIMESTAMP NOT NULL,
  ingested_at       TIMESTAMP NOT NULL
)
CLUSTER BY source, source_key
OPTIONS(description = "External key -> listing, with a validity window and a stated method. resolveListing() in identity-logic.ts is the reader.");
