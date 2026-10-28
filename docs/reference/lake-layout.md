# Lake layout — the contract

> **This file is the contract.** Every later data-platform prompt cites it instead of re-deciding
> where a table lives, how it is partitioned, or which bucket a prefix belongs to. If a change
> disagrees with this document, one of the two is wrong and the disagreement is the finding.
>
> `packages/core/__tests__/ops/lake-infra-coverage.test.ts` reads **this file and
> `scripts/ops/setup-lake.sh` together** and fails when they disagree. A resource named here and
> absent from the script is a provisioning gap; a resource created by the script and absent here is
> an undocumented one. Neither produces an error at run time, which is why a test has to say so.

Region decision, 14-Sep-2026 evening (plan v2.3 §2): **one region, `asia-south1`, for the whole
data plane.** D6 — the `us-east4` split — is removed.

---

## 1. Homes

### Buckets

| Bucket                    | Region        | Holds                                                                                                           | Lifecycle                                               |
| ------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `stockbook-lake-{env}`    | `asia-south1` | `lake/stage/{table}/`, `tiles/{market}/`, `releases/{release_id}/`, `rollback/`                                 | `lake/stage/` delete @ 14 d · `rollback/` delete @ 45 d |
| `stockbook-content-{env}` | `asia-south1` | **raw unchanged**: `feeds/`, `edgar/`, `databento/`, `candles/`, `stocks/`, `content/`, `documents/`, `studio/` | owned by `setup-gcs-lifecycle.sh`                       |

**The content list is the UNION of both environments, measured 2026-09-15.** Prod's top level holds
`candles/ databento/ edgar/ feeds/ stocks/`; QA's holds `content/ documents/ feeds/ stocks/` —
`content/` is learning content written by `apps/content`, and neither it nor `documents/` appears at
prod's top level. The first version of this list was measured against prod alone while claiming to
be the whole picture. `studio/` was missing even after BOTH buckets were listed:
`workers/src/processors/studio-render.ts` writes `studio/videos/{userId}` and no video had been
rendered in either environment, so a prefix with no objects is invisible to a listing and perfectly
reachable by the next job that runs. **The list is derived from the WRITERS as well as the
objects** — `folder:` has exactly two roots repo-wide, `content/` and `studio/`. Because `bucketForPrefix` REFUSES an unknown prefix rather than defaulting,
the omission would have thrown on the first learning-content key routed.

Raw bytes never move. `stockbook-content-{env}` keeps everything it has today; the lake bucket
holds only what the lake produces. The split is by **lifetime**, not by market: staged files are
disposable, raw vendor bytes are not (`databento/` is bought once and its lifecycle has no Delete
rule at all).

### Datasets

All in `asia-south1`.

| Dataset              | Region        | Contents                                                                    | Default table expiration |
| -------------------- | ------------- | --------------------------------------------------------------------------- | ------------------------ |
| `lake_bronze_{env}`  | `asia-south1` | the ledger: `source_object`, `pipeline_run`, `partition_load`, `quarantine` | **OFF**                  |
| `lake_silver_{env}`  | `asia-south1` | parsed, typed, one row per source record                                    | **OFF**                  |
| `lake_gold_{env}`    | `asia-south1` | derived and aggregated; what readers query                                  | **OFF**                  |
| `lake_private_{env}` | `asia-south1` | consented user-keyed tables; **separate service account**                   | **OFF**                  |

**Default table expiration is OFF on all four, deliberately.** A dataset-level default silently
attaches an expiry to every table created in it afterwards, including ones created by a later
prompt whose author never read this file. A table that vanishes 60 days after creation fails no
test and raises no alert — the query simply returns nothing, which is indistinguishable from a
quiet day.

### The dataset that already exists

| Dataset          | Region        | Owner                                                        | Lake SAs           |
| ---------------- | ------------- | ------------------------------------------------------------ | ------------------ |
| `billing_export` | `asia-south1` | MONEY-1379 — Detailed Usage Cost export, read by Datadog CCM | **no grant, ever** |

Measured 2026-09-15. The S1 brief said "no BigQuery exists in the project today"; that was wrong.
It is listed here because `bq ls` shows five datasets and a reader needs to know which one is not
ours, and because it is the one dataset the lake service accounts must never be granted on — it
carries the whole project's spend, at resource granularity.

That it is already `asia-south1` is the useful part: the one-region decision has a precedent in the
only BigQuery that exists here, rather than an exception.

---

## 2. Region, and the escape hatch

Every row above reads `asia-south1`. This is a decision, not an accident, and the reasoning is in
plan v2.3 §2: a BigQuery job runs in exactly one location and every dataset it touches must be in
that location, so a second region buys residency and costs a permanent architecture of per-market
datasets, a global dataset, and nightly cross-region copies.

**If a US footprint is ever needed, it is an ADDITION, not a redesign:**

1. a new bucket (`stockbook-lake-us-{env}`, `us-east4`),
2. a `bucketForPrefix` config entry routing the US prefixes to it,
3. a BigQuery **dataset copy** for the few small tables both regions need.

Nothing in silver or gold changes shape. `bucketForPrefix`
(`packages/core/src/ops/lake-layout.ts`) exists precisely so that the decision has one place to
live — today it returns one bucket for everything, and that is the point: the seam is present and
costs nothing until it is used.

Sized before the decision, in `docs/reference/us-prefix-sizes-2026-09.md`: the US data on a daily
read path is ~3 GiB of a 977 GiB bucket.

---

## 3. Naming

- **`snake_case`**, always. BigQuery is case-sensitive in ways SQL authors do not expect.
- **Singular** table names: `price_bar_d1`, not `price_bars_d1`. A table is a relation; the row is
  the thing being named.
- **Environment is a SUFFIX on the dataset**, never on the table: `lake_silver_qa.price_bar_d1`.
  The same query then runs against either environment by changing one identifier.
- No dots, no dashes, no uppercase in a table name.

---

## 4. Partitioning and clustering

| Table family                       | Partition | Column          |
| ---------------------------------- | --------- | --------------- |
| Daily and hourly bars (`D1`, `H1`) | **MONTH** | `session_date`  |
| Minute bars (`M1`)                 | **DAY**   | `session_date`  |
| Events and news                    | **DAY**   | `observed_date` |

**Clustering, on every partitioned table: `market, listing_id, source`** — in that order.

The order is the access pattern, not alphabetical: every query filters `market` first (it is the
coarsest and it is always known), `listing_id` next, and `source` last because it is usually a
tie-break rather than a filter. BigQuery's clustering only prunes on a **prefix** of the cluster
key, so a query filtering `listing_id` alone prunes nothing — that is a property of the storage,
not a bug, and it is why `market` leads.

**ONE DECLARED EXCEPTION to the third cluster column** (MONEY-1507):
`lake_silver_{env}.instrument_event` clusters `market, listing_id, event_type`.
`source` on that table has about four values and is a filter nobody writes,
while every named consumer filters by TYPE — the alert evaluator on
(severity, event_type), the chart marks, the events tab — so `source` in the
third position would prune nothing at all. Stated here rather than left as a
disagreement between this file and a DDL, because the rule above is otherwise
unconditional. `filing_registry` in the same file is NOT partitioned (it is a
key-lookup registry, and BigQuery serves its unfiltered `COUNT(*)` from
metadata), so the rule does not reach it — the same shape `listing` takes in
`003_silver_identity.sql`.

`session_date` is an **ET session date for US rows**, never a UTC day. The US session runs
04:00–20:00 ET, so under EST the post-market tail is the next UTC day _and_ the same UTC day as the
following session's pre-market — a UTC key spans two sessions and whichever writer lands first
locks the other out of both (MONEY-1373).

**One table departs from the cluster rule, deliberately: `lake_silver_{env}.derivatives_eod_in`
clusters by `underlying, expiry_date`** (MONEY-1497). Recorded here rather than left to disagree
with the DDL, because the rule above is otherwise unconditional. Both reasons are properties of the
data, not preferences: `market` has exactly ONE value in that table, and BigQuery prunes only on a
**prefix** of the cluster key, so leading with a constant column disables pruning for every query;
and `listing_id` does not exist for a derivative at all — `listing` holds cash securities, so the
column would be NULL on every row, which is the same defect one column over. `underlying` then
`expiry_date` is the real access pattern (basis, term structure, rollover, PCR and max-pain all
slice that way).

---

## 5. Mandatory silver columns

Every table in `lake_silver_{env}` carries all six. They are not optional and they are not
"added later":

| Column              | Type        | What it answers                                        |
| ------------------- | ----------- | ------------------------------------------------------ |
| `source_object_uri` | `STRING`    | which archived object produced this row                |
| `source_record_key` | `STRING`    | which record _within_ that object                      |
| `parser_version`    | `STRING`    | which parser wrote it — so a reparse is identifiable   |
| `pipeline_run_id`   | `STRING`    | which run, joining to `lake_bronze_{env}.pipeline_run` |
| `observed_at`       | `TIMESTAMP` | when the source asserted it                            |
| `ingested_at`       | `TIMESTAMP` | when we wrote it                                       |

Without `source_object_uri` and `parser_version`, a wrong number cannot be traced to the bytes and
the code that produced it, and the only available repair is to rebuild everything. This repo has
paid that bill: `stock_financials` has no `source` in its unique key, so the first XBRL write for a
period destroyed the value it replaced and left nothing to reconcile against.

---

## 6. The four clocks

Four different times can be attached to one row, and conflating any two of them produces a table
that looks right and answers the wrong question.

| Clock                             | Meaning                               | Example of getting it wrong                               |
| --------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| **Event time**                    | when the thing happened in the market | a split applied on ingest date, not ex-date               |
| **Observed time** (`observed_at`) | when the source asserted it           | a filing's `acceptedAt` vs the period it covers           |
| **Ingest time** (`ingested_at`)   | when we wrote the row                 | using it as event time back-dates every backfill to today |
| **Query time**                    | when someone asked                    | an "as of" report that silently means "as of now"         |

Point-in-time correctness is `observed_at`, never `ingested_at`. A backtest that filters on ingest
time sees data the market could not have seen, and the error always flatters the strategy.

---

## 7. Release files

**256 MB – 1 GB per file.** Below 256 MB the per-file overhead dominates and a reader spends its
time opening objects; above 1 GB a single corrupt or slow file stalls a whole scan and cannot be
retried cheaply.

Releases are immutable and addressed by `releases/{release_id}/`. `rollback/` holds the previous
release's pointer and is deleted at 45 days — long enough to roll back through a quarter-end, short
enough not to accumulate.

Measured input to this: `CANDLE_COLD_FORMAT` (MONEY-1384) found parquet _costs_ space against
gzipped JSONL on small shards — a 252-bar D1 symbol-year is 5,809 B as JSONL and 9,776 B as
parquet. Format is chosen by read shape, not by assumption, and it is sniffed from magic bytes so a
bucket can sit half-converted.

**MONEY-1518 re-measured at M1 and the answer did not change.** Real prod objects
`candles/US/M1/AAPL/{2024,2025}`, through `encodeColdShard` itself: 123,072 rows are 1,912,970 B
gzipped JSONL against 2,364,453 B parquet (**+23.6%**), 125,527 rows +22.9%. The overhead amortises
(+68% → +23%) and never crosses zero, and the curve is not monotonic — the same bars truncated give
+93.2% at 252 rows, +7.1% at 50,000 and +25.3% at 100,000, so a row-group boundary can make a bigger
shard worse. **A release is therefore a separate artifact, not a conversion of the cold store.** It
holds the columns a backtest reads, partitioned `market=`/`year=` so a sweep prunes without opening;
the cold shards stay gzipped JSONL at every timeframe.

**Built by** `scripts/jobs/lake-release.ts` (`--env {qa|prod} [--apply|--verify <id>]`, armed by
`LAKE_RELEASE_APPLY=true`), **read by** `scripts/quant/lake.py`. The export is BigQuery's own
`EXPORT DATA ... overwrite = false` — immutability enforced server-side rather than by a
read-then-write a retried job would race — and `EXPORT DATA` rather than `bq extract` because
`gold.adjusted_bar_d1` is a view and extract jobs refuse views. `bars_d1` carries `price_factor` and
`split_factor_cum` alongside the adjusted columns, which is what lets an intraday bar be adjusted by
joining its session date: one implementation of CRSP, at every timeframe.

---

## 8. The two prohibitions

### The web request path never queries BigQuery

Not "should avoid" — never. BigQuery is a scan engine with per-query latency measured in seconds
and billing measured in bytes scanned; a request path that touches it turns a user page-load into a
variable-cost, variable-latency operation with no upper bound. Serving reads Mongo, Redis, or a
pre-built tile in GCS. `stockbook-api@` is granted **nothing** on BigQuery, which is the version of
this rule that survives someone not having read it.

### No new history defaults to Mongo

Mongo's Atlas tier is index-bound, not document-bound: 25.4 GiB of indexes against an M40's 16 GB
of RAM (`docs/reference/atlas-heatmap-2026-09.md`). Every new historical series goes to the lake
first and reaches Mongo only as a bounded hot window with a stated eviction rule. A series that
lands in Mongo "just for now" is one nobody later has a safe way to remove.

---

## 9. Bar-source precedence

Quoted verbatim from plan v2.2/v2.3, which settled it 14-Sep:

> **Bar-source precedence (settled 14-Sep, applies to every prompt that touches bars):** the
> exchange file is the truth for a closed session — India `DailyPrice` rows with
> `source: "BHAVCOPY"`, US `price_bar_d1` from Tiingo EOD. Yahoo (India) and the Tiingo websocket
> (US) exist for exactly two things: the **forming bar of the current session** while the market is
> open, and **gap fill** for a closed session the exchange path has not delivered (a failed sync,
> pre-mapping history) — written with its own `source` value, never overwriting a higher-authority
> row. The storage layer already enforces this (`mayWritePriceSource`, MONEY-1175,
> packages/core/src/market-data/prices/yahoo-price-service.ts); the chart simply never read it. No
> prompt may call Yahoo on a request path for a closed session's bars.

The enforced ranks, from `packages/core/src/market-data/price-source-authority.ts`:

| Source                      | Authority |
| --------------------------- | --------- |
| `BHAVCOPY`, `BHAVCOPY_HIST` | 100       |
| `TIINGO`                    | 60        |
| `DATABENTO`                 | 55        |
| `ZERODHA`                   | 50        |
| `TIINGO_RT`                 | 20        |
| `YAHOO`                     | 10        |
| _unknown_                   | 1         |

Unknown ranks **last**, so a new upstream can only fill a gap and never displace a known source.
`DATABENTO` sits below `TIINGO` because Tiingo's daily bar is the adjusted, corporate-action-aware
series the app renders, and far above `TIINGO_RT` because one is trade-derived with real volume and
the other is a mid-price whose `volume` is a structural zero.

---

## 10. Identity and access

| Service account              | Grants                                                                                                                 | Never                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `lake-writer-{env}@`         | `dataEditor` on bronze/silver/gold **of that env** + `jobUser`                                                         | private; the other env        |
| `lake-reader-{env}@`         | `dataViewer` on silver/gold **of that env** + `jobUser`                                                                | bronze; private; any write    |
| `lake-private-writer-{env}@` | `dataEditor` on `lake_private_{env}` only + `jobUser`                                                                  | bronze/silver/gold            |
| `lake-dataform-{env}@`       | `dataEditor` on gold + `dataViewer` on silver, that env + `jobUser`; `dataViewer` on the bronze TABLE `partition_load` | **bronze** otherwise; private |
| `stockbook-api@`             | **nothing on BigQuery**                                                                                                | everything — see §8           |

**`lake-dataform-{env}@` is separate from `lake-writer-{env}@` on purpose**
(MONEY-1506). Dataform runs SQL that arrives by merge, and `lake-writer` holds
`dataEditor` on **bronze** — the ledger that records what every loader has
already loaded. Reusing it would have cost nothing to provision and handed a bad
model in a merged `.sqlx` file the ability to drop the one table that says what
is done. Gold write, silver read, nothing else — except a READ of the one ledger
table, `partition_load`, granted TABLE-level by `setup-dataform.sh` (MONEY-1611) so
the gold job can see a silver input mid-reload and refuse to build over it.

**Service accounts are env-suffixed, and the brief's single `lake-writer@` is a deliberate
deviation.** Service accounts are project-level while the datasets are env-suffixed, so one writer
run per environment would accumulate `dataEditor` on **both** environments' datasets, and a
misconfigured QA job would then write prod. Separating the blast radius is the reason two
environments exist.

**All three carry project-level `jobUser`, and that is not a widening.** `bigquery.jobs.create` is
required to run _any_ query or load job and confers no data access on its own — so granting it only
to the writer left the reader unable to `SELECT` from the silver it can see, and the private writer
unable to run the load job that would write the dataset it owns. Both were provisioned unusable, and
it surfaces only at first real use as `Access Denied: User does not have bigquery.jobs.create
permission`. `lake-smoke` exercises the writer alone, so it certified green over two broken accounts.

`lake_private_{env}` has its own writer because consented user-keyed data must not be reachable by
the service accounts that run ordinary market-data jobs. A single writer with access to everything
makes "which job could have touched this user's rows" unanswerable.

---

## 11. Cost

A **$50/month budget alert on BigQuery SKUs**, **one per GCP project** — not per environment.

QA and prod share the single project `stock-book-483718`, and the budget filter carries no
`--filter-projects` and no environment dimension, so two budgets would measure the identical thing
and a prod overspend would fire both alerts identically. The budget is named for the project, and
`setup-lake.sh` guards it with a `billing budgets list` like every other create.

`billingbudgets.googleapis.com` was **not enabled** as of 2026-09-15 and budget creation requires
**Billing Account** permissions rather than project ones, so `setup-lake.sh` attempts it and skips
loudly with the exact command when it cannot. The step is in
`docs/ops/PRODUCTION-CHECKLIST.md`; it is not silently dropped, because a budget nobody created is
indistinguishable from a budget that never fired.

---

## 12. Dataform — silver to gold (MONEY-1506, B4)

`dataform/` at the repo root is the whole of silver→gold. Since MONEY-1611 (founder decision
2026-09-23) it is built by the **Dataform CLI in a Cloud Run job**, not by the managed Dataform
service: the CLI compiles the `dataform/` directory baked into the workers image, so gold is built
from exactly the SQL of the release the job is pinned to. No Git connection, no token.

| Resource      | Name                                    | Region        |
| ------------- | --------------------------------------- | ------------- |
| Cloud Run job | `lake-gold-{env}` (`dist/lake-gold.js`) | `asia-south1` |
| Scheduler     | `lake-gold-after-us-{env}` 06:45 IST    | `asia-south1` |
|               | `lake-gold-after-in-{env}` 20:15 IST    | `asia-south1` |

Provisioned by `scripts/ops/setup-dataform.sh {qa|prod}`; the job runs as `lake-dataform-{env}@`,
which is created and granted by `setup-lake.sh` with the other three (§10). No managed Dataform
repository was ever created.

**The location is stated TWICE and both are load-bearing.** `workflow_settings.yaml` carries
`defaultLocation: asia-south1`, and the job passes `--default-location` on every run, which
OVERRIDES it — so pinning only the file would leave the job free to run in another region. A
BigQuery job runs in exactly one location, so the failure is
`Not found: Dataset … was not found in location US`, which reads like a missing table rather than a
misplaced project. The schema, the assertion schema and `vars.env` are overridden the same way, all
three from ONE `--env` (`packages/core/src/ops/lake-gold-logic.ts`).

### Every gold model is a VIEW

`adjusted_bar_d1`, `returns_daily`, `rolling_stats`, `chart_tile_manifest`,
`coverage_price_bar_d1` — views, not incremental tables, and that is the decision this section
exists for.

The CRSP factor for a bar is the product over every bar **after** it, so one new split restates
every earlier row of that listing. An incremental table would append tomorrow's bar on the new
basis and leave a decade of history on the old one — a step discontinuity at whatever date the
split landed, on real prices, with nothing reporting an error. Computing at read time is the
property the TypeScript already has and states in its own header: a newly-announced corporate
action invalidates a cache instead of restating history.

A view has no partitions of its own but inherits the pruning of `lake_silver.price_bar_d1`
(§4). `type: "table"` is a one-word change if a read path ever **measures** the scan as too slow;
nothing is waiting on it today, and §8 forbids the web request path from querying BigQuery at all.

**What the schedules actually cost is the ASSERTIONS, not the views.** Replacing a view scans
nothing; each assertion is a query over the whole model, and there are two invocations a day. None
of them prunes a partition, because "one row per (listing, session)" and "no session in the future"
are questions about every row. Budget accordingly (§11 is $50/month for the whole project), and if
it ever bites, the lever is to scope the expensive assertions to a recent window rather than to
delete them — an assertion nobody runs is worth less than one that grades the last quarter.

### The adjustment has ONE definition, and it is executed against the TypeScript

`dataform/includes/adjustment.js` holds the CRSP SQL as a JS template.
`packages/core/__tests__/market-data/adjustment-sql-parity.test.ts` **runs** that string in
`node:sqlite` over a checked-in fixture and asserts it equals `computeAdjustedSeries` to 1e-9
(measured worst disagreement: 2.8e-16). `scripts/ops/adjustment-parity.ts {qa|prod}` runs the same
string and the same fixture through BigQuery, which is the half that needs credentials and
therefore cannot be CI.

There is one deliberate divergence, pinned by its own test: a dividend at or above the previous
close is refused in SQL (`LN` is undefined there) where the TypeScript computes a non-positive
factor and multiplies the whole history by it.

### `market` is not a Dataform var

Every model serves both markets, because `market` is a column and a cluster key and never a dataset
(§4). A market-filtered view would hold one market's rows until the other schedule overwrote it, so
what a reader saw would depend on which cron ran last. The two invocations differ only in when they
run: after the US daily load, and after India's.

### Nothing chains a tile build off Dataform

The tile builders keep the schedulers A2 gave them. The ordering constraint a Cloud Workflows chain
would exist for does not exist while every model is a view — there is no "finished" state to wait
for. `scripts/jobs/tile-build-d1.ts --market=US` reads `lake_gold_{env}.adjusted_bar_d1` and
`chart_tile_manifest` directly and stamps `built_from: "gold"`.
