-- Events, and the SEC filing registry. MONEY-1507 (data-platform C1).
--
-- `{{DATASET}}` is this file's OWN layer, taken from the filename — `008_SILVER_`
-- means lake_silver_{env}. Same conventions as 001/003: no ENUM types (BigQuery
-- has none — the vocabularies are closed in
-- packages/core/src/events/event-types.ts and refused on write) and no primary
-- keys (BigQuery enforces none; uniqueness is by convention and by the writer).
--
-- ## APPEND-ONLY. A CORRECTION IS A NEW ROW.
--
-- Neither table is ever UPDATEd. The Mongo projection is the mutable serving
-- copy with a 30-day TTL; silver is the permanent record of what each producer
-- asserted and WHEN. An enrichment (the 8-K insight sweep's summary) appends a
-- second row with the SAME `event_id` AND THE SAME `observed_at`, carrying a
-- non-null `enriched_at`; a retraction appends a row carrying
-- `supersedes_event_id`.
--
-- The enrichment does NOT move `observed_at`, and that is deliberate: we saw
-- the filing when we saw it, and bumping the producer's clock to mark our own
-- later reading would make a point-in-time query claim the market knew about a
-- filing hours after it did. So two rows can share `(event_id, observed_at)`
-- and `ingested_at` is the tie-break — which is also why
-- `scripts/jobs/event-lake-sink.ts` keys its skip set on all THREE and windows
-- on `ingested_at` rather than on `observed_at`.
--
-- That is why `observed_at` is the partition key and not `published_at`.
-- lake-layout.md §6: point-in-time correctness is `observed_at`, never
-- `ingested_at` and never the source's own clock. A backtest asking "what did
-- the market know on D" must not see a row we only learned about on D+3, and
-- EDGAR's `filedAt` is the NEXT business day for anything accepted after the
-- 17:30/22:00 ET cut-offs — so partitioning on the source clock would file the
-- whole evening peak a day forward.
--
-- Readers wanting the CURRENT view of an event take the latest
-- `(observed_at, ingested_at)` per `event_id`, or read Mongo.

-- ─────────────────────────────────────────────────────────────────────────
-- instrument_event
-- ─────────────────────────────────────────────────────────────────────────
--
-- CLUSTER BY market, listing_id, event_type — and the third column is a
-- DELIBERATE DEPARTURE from lake-layout.md §4, which mandates
-- `market, listing_id, source` on every partitioned table. The C1 brief
-- specifies `event_type` and it is the right third key here:
--
--   `source` on this table has ~4 values and none of them is a filter anybody
--   writes. Every consumer named in C4/C5 filters by TYPE — the alert
--   evaluator on (severity, event_type), the chart marks on event_type, the
--   events tab on event_type — so `source` in the third position would prune
--   nothing at all while `event_type` prunes every real query.
--
-- BigQuery only prunes on a PREFIX of the cluster key, so the order is the
-- access pattern: `market` is coarse and always known, `listing_id` next.
-- lake-layout.md §4 carries this exception in writing.
--
-- `listing_id` is NULLABLE and that is not a defect. An event about a filer we
-- cannot yet map to a security is still a real event — a newly-listed issuer, a
-- private filer, a fund manager filing 13F — and dropping it would silently
-- shrink the corpus with nothing to measure the loss against. C3's linkers fill
-- it in later, by appending a corrected row. `confidence` says which case a row
-- is: the SEC producer writes 1.0 on an exact CIK join and 0.5 when unmapped.
CREATE TABLE IF NOT EXISTS `{{DATASET}}.instrument_event` (
  event_id      STRING NOT NULL OPTIONS(description = "sha1(source NUL source_record_key), lowercase hex — DERIVED by buildEventId(), never chosen. Four EDGAR detectors converge on one filing and every one must produce this same id."),
  market        STRING NOT NULL OPTIONS(description = "US | IN. A COLUMN, never a second dataset."),
  listing_id    STRING          OPTIONS(description = "{symbol}:{venue}:{listingStartDate} — the SAME spelling Candle.listingId and lake_silver.listing use. NULL when the filer is not (yet) mapped to a security."),
  entity_id     STRING          OPTIONS(description = "the FILER: cik10 for SEC, scrip code / ISIN for India. At least one of listing_id / entity_id is always present."),
  event_type    STRING NOT NULL OPTIONS(description = "FILING_8K | FILING_10Q | FILING_10K | FILING_13F | FILING_OTHER | INSIDER_TXN | OWNERSHIP_13D_G | NEWS | CORP_ACTION | RESULT — closed in event-types.ts"),
  severity      INT64  NOT NULL OPTIONS(description = "0 informational | 1 notable | 2 material (C4's alert floor) | 3 critical"),
  title         STRING NOT NULL,
  summary       STRING          OPTIONS(description = "NULL until an enrichment pass supplies one — never defaulted to the title, which would erase 'we have not read this yet'"),
  evidence_uri  STRING          OPTIONS(description = "where a human can verify it: the EDGAR filing index page, the article URL"),
  source        STRING NOT NULL OPTIONS(description = "SEC_EDGAR | TIINGO_NEWS | NSE | BSE …"),
  published_at  TIMESTAMP       OPTIONS(description = "the SOURCE's clock: EDGAR acceptance, the wire timestamp. NOT the partition key — see the header."),
  linker_version STRING NOT NULL OPTIONS(description = "which linker attributed this event to this listing — so a re-link is identifiable"),
  confidence    FLOAT64 NOT NULL OPTIONS(description = "0-1. FLOAT64 rather than NUMERIC because it is a score, not money — 001's cost_usd is NUMERIC for the opposite reason."),
  tags          ARRAY<STRING>   OPTIONS(description = "form:8-K, item:2.02, amendment — free-form, never a filter a query depends on"),
  supersedes_event_id STRING    OPTIONS(description = "set on a correction. The superseded row is KEPT: this table is append-only."),
  enriched_at   TIMESTAMP       OPTIONS(description = "when a later pass added the summary. NULL on first emission."),

  -- The six mandatory silver columns (lake-layout.md §5). `source_record_key`
  -- is ALSO the event's own key — the source's verbatim id for this record (an
  -- SEC accession, an article id) and half of `event_id`. One column, one
  -- meaning: a second spelling of it would be two facts that can disagree.
  source_object_uri STRING    NOT NULL,
  source_record_key STRING    NOT NULL,
  parser_version    STRING    NOT NULL,
  pipeline_run_id   STRING    NOT NULL,
  observed_at       TIMESTAMP NOT NULL OPTIONS(description = "when WE saw it. The partition key, and the only clock a point-in-time query may use."),
  ingested_at       TIMESTAMP NOT NULL
)
PARTITION BY DATE(observed_at)
CLUSTER BY market, listing_id, event_type
OPTIONS(description = "Append-only unified event stream. A correction is a NEW ROW with supersedes_event_id and an enrichment a NEW ROW with the same (event_id, observed_at) and a non-null enriched_at; readers take the latest (observed_at, ingested_at) per event_id. Mongo holds a 30-day serving copy.");

-- ─────────────────────────────────────────────────────────────────────────
-- filing_registry — one row per us_filings row
-- ─────────────────────────────────────────────────────────────────────────
--
-- B6 lever 3 is the reason this table exists. That step keeps `filedAt >=
-- today - 2y` in Mongo and deletes the rest, and its stated precondition is
-- "registry row count == Mongo count" — so this must hold EVERY filing,
-- including the ones about to be deleted, before anything is deleted.
--
-- NOT PARTITIONED, deliberately, and this is `listing`'s precedent in 003
-- rather than a new argument. lake-layout.md §4 mandates a cluster key of
-- `market, listing_id, source` on every PARTITIONED table; this one is not
-- partitioned, because every query it exists to answer is a KEY LOOKUP
-- (accession, or a filer's filings) rather than a date range, and BigQuery
-- serves an unfiltered `COUNT(*)` — which is B6's whole use — from metadata at
-- zero bytes scanned. A MONTH partition on `filed_at` would add pruning nothing
-- currently asks for.
--
-- ponytail: add `PARTITION BY DATE_TRUNC(filed_at, MONTH)` the first time a
-- reader range-scans this table. It is a rebuild, not a migration, and the
-- loader below can rebuild it from Mongo in one run.
--
-- `market` is present although every row is US today, because §4's rule is that
-- market separation is a COLUMN. Adding it later means backfilling 18.7M rows
-- to say something we already knew.
CREATE TABLE IF NOT EXISTS `{{DATASET}}.filing_registry` (
  accession  STRING NOT NULL OPTIONS(description = "dashed, `0000320193-26-000106`. SEC's own primary key for a filing and the UNIQUE one here."),
  market     STRING NOT NULL OPTIONS(description = "US for every row today. A COLUMN, never a second dataset."),
  cik10      STRING NOT NULL OPTIONS(description = "zero-padded to 10 digits, the form every EDGAR URL and bulk filename uses"),
  listing_id STRING          OPTIONS(description = "resolved from UsInstrument.cik at load time; NULL for a filer with no listing (a fund manager, a private filer, a newly-listed issuer)"),
  form       STRING NOT NULL OPTIONS(description = "as filed, including the `/A` on an amendment"),
  filed_at   DATE   NOT NULL OPTIONS(description = "the FILING DATE, a calendar day at SEC. NOT a latency clock — a filing accepted at 21:53 ET is dated the NEXT business day, so `filed_at - accepted_at` is negative most evenings."),
  accepted_at      TIMESTAMP OPTIONS(description = "the acceptance INSTANT. The only one of the two that can measure detection latency."),
  period_of_report DATE      OPTIONS(description = "the period the filing covers, when SEC states one"),
  items      ARRAY<STRING>   OPTIONS(description = "8-K item numbers as EFTS and the daily index carry them — '2.02', 'Item 2.02', '2.02 Results of Operations' are all real spellings"),
  primary_document STRING,
  is_xbrl        BOOL NOT NULL OPTIONS(description = "false, never NULL: Mongo's default is false and an absent field must not become a third state here"),
  is_inline_xbrl BOOL NOT NULL,
  size_bytes INT64,
  parse_class STRING NOT NULL OPTIONS(description = "OWNERSHIP | THIRTEENF | SCHEDULE13 | EIGHTK | FINANCIALS | OTHER — which parser owns it"),
  status     STRING NOT NULL OPTIONS(description = "DETECTED | INDEXED | ARCHIVED | PARSED | FAILED | UNSUPPORTED | NO_PARSER | WITHDRAWN. A SNAPSHOT at load time — Mongo is authoritative for the live value."),
  raw_path   STRING          OPTIONS(description = "GCS key of the archived full-submission bundle, so a reparse never costs a SEC request"),

  source_object_uri STRING    NOT NULL,
  source_record_key STRING    NOT NULL,
  parser_version    STRING    NOT NULL,
  pipeline_run_id   STRING    NOT NULL,
  observed_at       TIMESTAMP NOT NULL OPTIONS(description = "acceptedAt when SEC gave one, else filedAt at UTC midnight — when the SOURCE asserted the filing exists"),
  ingested_at       TIMESTAMP NOT NULL
)
CLUSTER BY market, cik10, form
OPTIONS(description = "One row per us_filings row. B6 lever 3's precondition is that this count equals Mongo's before anything is deleted from us_filings.");
