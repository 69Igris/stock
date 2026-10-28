-- The lake ledger. MONEY-1472 (data-platform B1).
--
-- Applied by scripts/ops/lake-apply-ddl.ts, which is idempotent: every
-- statement is CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT
-- EXISTS, or ALTER COLUMN … SET OPTIONS (a description an existing table can
-- only receive that way — see 002's listing_id, MONEY-1522), so a re-run is a
-- no-op and a new column is a migration rather than a rewrite. `{{DATASET}}` is
-- substituted with lake_bronze_{env}.
--
-- NO ENUM TYPES: BigQuery has none. States are STRING, closed in
-- packages/lake/src/ledger-logic.ts and refused on write — which is the only
-- place an unknown value can still be caught.
--
-- NO PRIMARY KEYS either: BigQuery does not enforce them. `partition_load`'s
-- five-part key is unique BY CONVENTION and enforced by the loaders' MERGE.
-- That is stated here rather than assumed, because a reader who expects the
-- database to reject a duplicate will not write the MERGE.

-- Every raw object we hold, and whether we have actually verified it.
--
-- Replaces `DatabentoBatchJob.files`, a Mongo JSON array that is not queryable,
-- does not survive a re-parse, and cannot answer "do we still have this file?".
CREATE TABLE IF NOT EXISTS `{{DATASET}}.source_object` (
  dataset          STRING  NOT NULL OPTIONS(description = "vendor dataset, e.g. EQUS.MINI"),
  source           STRING  NOT NULL OPTIONS(description = "DATABENTO | TIINGO | NSE | BSE | AMFI | SEC"),
  object_uri       STRING  NOT NULL OPTIONS(description = "gs://bucket/key — built by objectUri(), never concatenated"),
  generation       INT64            OPTIONS(description = "GCS generation; pins WHICH version of the object was read"),
  bytes            INT64            OPTIONS(description = "size at acquisition"),
  sha256           STRING           OPTIONS(description = "NULL unless the vendor manifest carried it — we do not download TBs to hash"),
  content_type     STRING,
  acquired_at      TIMESTAMP NOT NULL,
  vendor_job_id    STRING           OPTIONS(description = "Databento batch job id, Tiingo request id"),
  vendor_file_name STRING,
  cost_usd         NUMERIC          OPTIONS(description = "NUMERIC, not FLOAT64 — money must not carry binary rounding"),
  entitlement      STRING           OPTIONS(description = "the licence this was bought under; a redistribution question later"),
  state            STRING  NOT NULL OPTIONS(description = "PRESENT | VERIFIED | MISSING | EXPIRED"),
  verified_at      TIMESTAMP        OPTIONS(description = "when state last became VERIFIED — NULL means never checked, which is not the same as failing")
)
PARTITION BY DATE(acquired_at)
CLUSTER BY dataset, source, state
OPTIONS(description = "Raw object inventory. One row per (object_uri, generation).");

-- One row per execution of a lake job.
CREATE TABLE IF NOT EXISTS `{{DATASET}}.pipeline_run` (
  run_id        STRING    NOT NULL OPTIONS(description = "runId(job, startedAt) — sortable, no colons"),
  job           STRING    NOT NULL,
  git_sha       STRING             OPTIONS(description = "which code ran; a load is only reproducible with it"),
  started_at    TIMESTAMP NOT NULL,
  finished_at   TIMESTAMP          OPTIONS(description = "NULL means STILL RUNNING or killed — distinguishable from a clean finish"),
  status        STRING             OPTIONS(description = "RUNNING | SUCCESS | FAILED"),
  rows_in       INT64,
  rows_out      INT64,
  rows_rejected INT64              OPTIONS(description = "counted separately from rows_out: a load that wrote some rows is not a load that succeeded"),
  bytes_scanned INT64,
  notes         STRING
)
PARTITION BY DATE(started_at)
CLUSTER BY job, status
OPTIONS(description = "Job executions. A run with finished_at NULL and an old started_at is a crash, not a success.");

-- THE IDEMPOTENCY TABLE. Every loader asks this before doing work.
--
-- Unique BY CONVENTION on (dataset, table, partition_key, source_hash,
-- parser_version) — see the header. `source_hash` is in the key so a re-issued
-- vendor file re-loads; `parser_version` is in it so a parser FIX can re-run
-- over bytes that have not changed. Without either, a wrong row is permanent.
CREATE TABLE IF NOT EXISTS `{{DATASET}}.partition_load` (
  dataset           STRING    NOT NULL,
  `table`           STRING    NOT NULL OPTIONS(description = "backticked: TABLE is reserved in standard SQL"),
  partition_key     STRING    NOT NULL OPTIONS(description = "the loader's unit — a session date, a symbol-year"),
  source_hash       STRING    NOT NULL,
  parser_version    STRING    NOT NULL,
  run_id            STRING,
  state             STRING    NOT NULL OPTIONS(description = "LOADING | ACCEPTED | REJECTED | SUPERSEDED — only ACCEPTED skips"),
  row_count         INT64,
  expected_sessions INT64              OPTIONS(description = "what the SOURCE says should be here; 0 or NULL must never ACCEPT"),
  actual_sessions   INT64,
  loaded_at         TIMESTAMP NOT NULL OPTIONS(description = "also the LOADING lease clock — a stale claim is reclaimable")
)
PARTITION BY DATE(loaded_at)
CLUSTER BY dataset, `table`, state
OPTIONS(description = "Load idempotency. ACCEPTED is what makes a future run skip, so a partial partition must never reach it.");

-- Rows a loader refused, with enough of the input to diagnose them.
CREATE TABLE IF NOT EXISTS `{{DATASET}}.quarantine` (
  dataset       STRING    NOT NULL,
  `table`       STRING    NOT NULL,
  partition_key STRING    NOT NULL,
  run_id        STRING,
  reason        STRING    NOT NULL OPTIONS(description = "NAMED, never a boolean — 'could not parse' and 'failed the gate' need different fixes"),
  sample        JSON               OPTIONS(description = "a few offending rows; NOT the whole partition"),
  rejected_at   TIMESTAMP NOT NULL
)
PARTITION BY DATE(rejected_at)
CLUSTER BY dataset, `table`, reason
OPTIONS(description = "Refused rows. An empty quarantine and an unrun loader look identical in row counts, so read it with partition_load.");
