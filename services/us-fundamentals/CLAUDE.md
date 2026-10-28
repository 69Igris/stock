# us-fundamentals — service memory (MONEY-979)

The SEC EDGAR ingestion engine. Python 3.12, FastAPI, Cloud Run.
Read `README.md` first for the shape and the commands; this file holds the
decisions that are expensive to rediscover.

---

## Why this is a separate service at all

`edgartools` is the best SEC filing parser that exists and it is Python. Every
alternative was worse: re-implementing XBRL statement extraction in TypeScript,
or shelling out to Python from a Node worker (which makes a parser failure an
un-debuggable subprocess exit).

So it is a service, not a bridge. **Nothing in `apps/` or `packages/` imports
anything from here, and nothing here imports from them.** The seam is the
DATABASE: this service writes eleven `us_*` collections and
`packages/core/src/us-fundamentals/` reads them with Prisma. `apps/web` and
`apps/api` are asserted (T11) to contain no reference to `sec.gov`,
`efts.sec.gov`, `edgartools` or `openfigi`.

---

## The rules that cost a release when broken

### Env is read PER CALL, never at module scope

`app/settings.py` exposes functions, not constants. A module-level
`SEC_EGRESS = os.getenv(...)` freezes at import — which happens before any test
runs — so a test that sets the variable silently exercises the DEFAULT and
passes for the wrong reason. Same freeze bit `bse-client.ts`'s retry config.

### Flags are compared to a LITERAL string

`bool("false")` is `True`. `EDGAR_DETECT` / `EDGAR_PARSE_APPLY` /
`EDGAR_EVICT_APPLY` compare against `"on"` / `"true"` exactly.

All three ship **PRESENT** in both Cloud Build specs, because "absent" and
"deliberately set" must be distinguishable from outside — absent is how
`MF_METADATA_PROVIDER` disabled its job for months with every dashboard green.

Their VALUES are not uniform, and the table is
`INTENDED_FLAG_STATE` in `tests/test_deploy_contract.py`:

| flag                | prod       | qa      |
| ------------------- | ---------- | ------- |
| `EDGAR_DETECT`      | **`on`**   | `off`   |
| `EDGAR_PARSE_APPLY` | **`true`** | `false` |
| `EDGAR_EVICT_APPLY` | `false`    | `false` |

The ingest path ships RUNNING on prod, the way the Tiingo backbone shipped. QA
is off because it has no SEC egress at all. The evictor is off in both because
the cold tier it evicts into has no reader — see the prod spec's comment. That
test pins BOTH directions, so a silent disarm of prod fails as loudly as an
accidental arming.

`/health` reports `flag_state()` (`absent` / `empty` / the literal value)
alongside the resolved boolean, so the two are visible separately.

### Middleware order: OIDC FIRST, dedupe SECOND

Starlette runs `@app.middleware("http")` handlers in REVERSE registration order,
so `main.py` registers the dedupe first and the auth gate second in order to
make the AUTH GATE RUN FIRST.

Claiming a `messageId` for an unauthenticated request would let anyone burn the
dedupe key for a legitimate message and have every real redelivery answered
`200 duplicate: true`. A denial-of-job with no credentials required.

`tests/test_main_wiring.py` asserts this BEHAVIOURALLY — an unauthorised request
must never reach the dedupe store — rather than by reading the registration
list, because a comment about ordering cannot fail. Swapping the two blocks
turns that test red; every 401 assertion stays green.

### The OIDC decision is DENY-BY-DEFAULT

`should_skip_http_oidc` requires the env to be a KNOWN local one AND
`ENABLE_PULL_SUBSCRIBER == "true"`. An allow-list of deployed envs ("is it
production or qa?") fails OPEN on anything it does not recognise — an unset
variable, `"staging"`, a typo, an unexpanded Cloud Build substitution. That was
MONEY-288 on the TypeScript side.

The middleware is a FACTORY so the CALL SITE is testable. Extracting the
decision function alone leaves the composition untested, and the composition is
where the gate silently degrades: `if not skip` -> `if False` disables OIDC on
every route while every unit test of the decision function stays green.

### Dedupe fails OPEN, and the lease is what makes that safe

A store outage returns `RUN_UNTRACKED` and the job runs. Failing closed would
convert a Mongo blip into a total job outage. The blast radius is wildly
asymmetric, so it is not a judgement call.

The marker is LEASED (1h, > the 600s ack deadline) rather than a bare "seen"
flag, because a bare flag makes a CRASHED job permanently un-retryable. A live
lease answers **409**, never 200 — the first delivery may yet fail, and acking
would leave the job undone with Pub/Sub believing it was handled.

A duplicate key reaches us TWO ways — raised, and inside an `ok: 1` response's
`writeErrors[]`. Handling only the raise path classifies every duplicate as a
successful claim: a dedupe that never dedupes.

Collection, index names and document shape are IDENTICAL to
`workers/src/lib/pubsub-dedupe-logic.ts`. Both services share
`pubsub_message_dedupe`; changing one shape without the other splits the
namespace silently.

### `app/store/collections.py` is PARSED as text by a TypeScript test

`packages/core/__tests__/market-data/prod-only-sync-coverage.test.ts` reads it
with a regex. Keep it a plain literal dict, one `"key": "value",` per line, no
f-strings, no concatenation, no comprehension. The first computed entry makes
the TS side read a PARTIAL list and pass silently, and the missing collection is
never checked against `REFERENCE_COLLECTIONS`.
`tests/test_collections_contract.py` simulates that parse and fails if it
diverges from the imported dict.

### Counters are incremented AFTER the call they count

`report_job_outcome` only reports what it is handed, but this is the contract
every caller owes it. `stock-document-sync` incremented every per-source counter
BEFORE the call, so a source that 403s on every request still produced a
full-looking number (MONEY-1255).

Call it from a `finally`. A job that raises before reporting is invisible in
exactly the dimension this metric measures. `selected > 0 and written == 0` is
the signal that separates a healthy run from the six that ran on schedule,
returned 200 and wrote nothing for a week.

### The events emission is PUB/SUB, fail-soft, and COUNTED (MONEY-1507 / 1520)

`app/events.py` builds one message per run carrying that run's CLAIMED filings;
`app/jobs/detect.py` publishes it to `us-filing-events-{env}`, and the workers
turn it into `InstrumentEvent` rows on a push subscription at
`/jobs/us-filing-events`.

**It was an HTTP POST and it answered 404 on every call, from the day it
shipped.** `POST /internal/events` on `stockbook-workers-{env}` with an OIDC
token — correct URL, correct audience, correct IAM, and unreachable:
`stockbook-workers-{env}` carries `run.googleapis.com/ingress: internal` and
this service has **no VPC egress**, so the call left over the public internet
and Cloud Run refused it AT THE EDGE. The status code is the proof it never
arrived: `/internal/*` was gated by `jobsAuth`, which answers **401** on a
missing or invalid token and has no 404 path at all. An internal-ingress
service answers an external caller 404 precisely so it does not reveal that it
exists. `instrument_events` held 4,019 rows and not one was `SEC_EDGAR`.

Pub/Sub push is not external traffic, which is why the ~55 other job routes
reach that same service without trouble. **Do not propose VPC egress or
relaxing the workers' ingress** — both were considered and rejected on
MONEY-1520 with reasons.

**It sends FACTS, never derived values.** No event id, no event type, no
severity, no listing id — every one of those is computed on the TypeScript
side, in `packages/core/src/events/event-types.ts`. A second implementation of
a rule in a second language is a rule that has to agree forever and will not;
this service has already paid that bill once, with a reader table keyed in a
different one of edgartools' three vocabularies. Nothing about the PAYLOAD
changed when the transport did: the workers validate the same zod schema, and
the route already decoded a push envelope.

**There is NO switch and no arm flag.** But there IS something left to do, and
it is not resolved by any code in this repo: **the topic and its push
subscription must be provisioned before the first run.** Verified against live
`stock-book-483718` on 2026-09-22 — `us-filing-events-prod` and
`us-filing-events-prod-push` are the ONLY two of 65 declared topics and
subscriptions that do not exist, and `qa` is missing three. No test can detect
this: `test_deploy_contract.py` reads the SCRIPT TEXT, so it goes green the
instant the string is typed, and `edgar-detect-minutely-prod` is ENABLED at
`* * * * *`, so every run errors until the script is run.

**The order is: deploy workers → `./workers/scripts/setup-pubsub.sh {env}` →
deploy us-fundamentals.** The consumer route must exist before the subscription
points at it. `setup-pubsub.sh qa` has already been skipped for two prior
tickets, which is the empirical case against assuming someone remembers.
The old transport's only switch was `EVENTS_ENDPOINT_URL` ("the URL IS the
arm"), derived at build time by a `gcloud run services describe` that was
allowed to fail SILENTLY — unlike `CLOUD_RUN_URL`, which aborts the build. A
topic BASE name is a compile-time constant and the `-{env}` suffix comes from
`PUBSUB_ENV`, so that whole failure mode is removed rather than hardened.
`test_deploy_contract.py` fails if `EVENTS_ENDPOINT_URL` reappears in either
spec, and `settings.py` no longer reads it.

**THE SUFFIX FOLLOWS `PUBSUB_ENV`, NOT `APP_ENV`.** `resolve_pubsub_env()`
mirrors the TypeScript `getPubSubEnv()` that created the topics — `PUBSUB_ENV`,
then `NODE_ENV`, and `APP_ENV` is ignored entirely. A spec setting
`APP_ENV=production` and forgetting `PUBSUB_ENV` publishes real messages into
the **QA** topic, which downstream reads as a quiet market. `/health` reports
the RESOLVED topic for exactly this reason, and `test_main_wiring.py` asserts
both directions.

**No new IAM.** This service runs as `stockbook-api@` (the
`serviceAccountName` in both cloudbuild specs), which already holds
project-level `roles/pubsub.publisher` — granted by `setup-pubsub.sh` section 5
and by `gcp-setup.sh`'s `APP_SA_ROLES`. That is why the `edgar-parse-*` fan-out
has always worked from here.

**The ENRICHMENT is not this service's.** `us-filing-insight` (TypeScript,
workers) adds the model's one-line summary to the same event through
`enrichEvent`, a PARTIAL update of two columns. It has to be a partial one: that
sweep reads `us_filing_documents`, which carries no `acceptedAt`, so rebuilding
the event would downgrade `publishedAt` from SEC's acceptance INSTANT to the
filing DATE — the clock this file already warns runs a business day ahead. So
the request schema deliberately declares NO `summary` field: a field the route
accepts and nobody sends is `createMissing` again.

**It never raises — but it is no longer SILENT, and that distinction is the
whole of MONEY-1520.** The detect loop's product is the CLAIM, and an events
outage must not stop a walk whose Atom window rolls in minutes and whose misses
are unrecoverable. Fail-soft was never the defect. What was, is that
`[events] workers answered 404 for 3 filings` fired at ERROR every minute while
the very next line read `[job-outcome] {"selected":3,"written":3,"failed":0}` —
and `failed` is the dimension the METRIC carries, so nothing could alert on it.
`_emit_events`' failure count now folds into `stats.failed`. A filing whose
event did not land IS a failed row, in the same units `_fan_out` already counts
a failed parse publish in.

**A dropped event is RECOVERABLE, and that is what makes fail-soft safe here.**
`buildEventId(source, sourceRecordKey)` is `sha1(source + NUL + accession)`, a
pure function the event contract enforces with its own `.refine`. The accession
is SEC's primary key and is unique in `us_filings`; the filing ROW is written
every run whether or not the emit lands, and the bundle bytes sit in GCS
`edgar/` under a protected prefix. So a dropped event is re-derived from the
row onto the IDENTICAL id and `publishEvents`' upsert collapses it — which is
also why a DUPLICATE Pub/Sub delivery is free, and why no outbox, two-phase
claim or reconciliation loop is warranted.

**The re-derivation is `{"mode": "event-backfill"}` on `edgar-detect`
(MONEY-1532), and until then it did not exist** — this section, `app/events.py`
and `_emit_events` all said "a backfill re-derives it" while nothing did (first
naming `scripts/jobs/filing-registry-sync.ts`, which emits no events). The walk
can NEVER recover a dropped event itself: the claim is consumed whether or not
the emit lands, and a repeat claim is never re-emitted. The mode reads
`us_filings` and publishes through the SAME `_emit_events` / `build_requests`,
touching sec.gov zero times; the runbook is in
`docs/reference/edgar-engine.md` §10. Three things about it are load-bearing:

- **The population is `detectedAt` present, and nothing else.** Only
  `_fan_out`'s claim writes `detectedAt` (the ledger and the ownership backfill
  leave it absent; `upsert_filings` makes it insert-only), and the live path
  emits every claim — every form, every status. 21,441 of 36,459 claims since
  2026-09-01 were `OTHER`/`NO_PARSER`. A form or status filter would drop them.
- **The query rides `_id`, not `detectedAt`.** `us_filings` is 18.8M rows /
  6.5 GB with NO `detectedAt` index; the claim mints its ObjectId within
  milliseconds of stamping `detectedAt` (measured -999..+4 ms over 42,071 rows),
  so an `_id` range padded by `CLAIM_ID_SLACK` + `hint("_id_")` serves the
  window (2,323 keys for 2,184 rows, 5 ms). No index is needed; do not add one
  for this.
- **`observedAt` rides in the message** — every entry, live and backfill,
  carries `observedAt` = `detectedAt`. The workers used the envelope's
  `publishTime`, which is TODAY for a backfilled filing: it would arrive as new
  and fire every alert on it at once.

The emission runs in `handle`'s `finally`, ONE message per run, and a DUPLICATE
claim is deliberately not re-emitted — another run owns that filing.

**The publish CALL SITE lives in `app/jobs/detect.py`, not in `app/events.py`,
and that is load-bearing.** `topic-publisher-coverage.test.ts` credits a Python
topic only when a real `x.publish(...)` inside a `jobs/` module resolves to it.
That is not an accident of the scan: two earlier versions of it were satisfied
by `app/classify.py`, a MAPPING TABLE that issues no publish, so deleting the
actual fan-out left every `edgar-parse-*` topic credited and the suite green.
Keeping the loop in `events.py` would put `us-filing-events` back in exactly
that blind spot.

### Metric names are shared with the workers, deliberately

`stockbook.job.{selected,written,failed,transport_failures}` and
`stockbook.edgar.detect_latency_seconds`. A monitor must be able to span both
services with one query, and `scripts/ops/datadog/monitor-zero-write.json`
already queries these. `tests/test_outcome.py` asserts them as LITERAL strings —
deriving them from the constants under test would still pass after a rename,
which is the one event the assertion exists to catch.

Note the prefix arrangement differs from the TypeScript side: `datadog-metrics`
is initialised with a `prefix` there, so the code passes the bare name. DogStatsD
has no such setting, so `stockbook.` is written into the constant here.

### The WIRE differs between the service and the jobs, and it has to

`DD_METRICS_TRANSPORT` is `statsd` on the SERVICE and `http` on the five Cloud
Run JOBS. This is the one flag in this service whose two values are both
correct: the service runs beside a `datadog-agent` sidecar on UDP 8125, and the
jobs have no sidecar at all.

Measured while monitoring the first production backfill: the jobs still carried
`DD_SERVICE` / `DD_ENV`, so they tried to emit, and
`Error submitting packet: [Errno 111] Connection refused` is all that surfaced.
DogStatsD is fire-and-forget, so nothing failed — the counters were simply
dropped while `[job-outcome] {...}` logged perfectly. **A metric that never
arrives renders as NO DATA, not as an alert**, so the job half of EDGAR could
not be monitored in either direction, and "no data" is also what an idle,
healthy, correctly-configured job looks like (MONEY-1278).

On `http`, `report_job_outcome` POSTs the same four series to
`api.{settings.DD_SITE}/api/v1/series` with `type: "count"` — matching
DogStatsD's `increment`, so a job and the service stay summable in ONE query and
no monitor has to know which side emitted. It NO-OPS without `DD_API_KEY`
(now mounted on the jobs), which is `datadog-metrics`' contract on the
TypeScript side and why the suite needs no credentials.

`tests/test_deploy_contract.py` pins BOTH directions: a job that loses `http`
goes back to shouting into a closed port, and a service that GAINS it bypasses a
healthy sidecar and buys a billed request per emit.

### `standardized` is keyed in edgartools' TAG vocabulary — one column, one language

edgartools carries THREE vocabularies and two of them are human-readable:

| #   | source                                           | example                      |
| --- | ------------------------------------------------ | ---------------------------- |
| 1   | the raw us-gaap tag a filer used                 | `CostOfGoodsAndServicesSold` |
| 2   | `standard_tags` in `gaap_mappings.json` (3.7 MB) | `CostOfGoodsAndServicesSold` |
| 3   | `display_name` / `concept_mappings.json` (12 KB) | `Cost of Revenue`            |

**`us_fundamentals.standardized` is keyed on (2), from BOTH writers.** The
per-filing parse stores `StatementLine.standard_concept` directly. The
companyfacts fallback receives (1) from SEC and maps it through
`app/sec/standardize.py`.

This cost a CRITICAL twice over. The TypeScript reader table was written in (3)
— against a real file, genuinely verified, and the wrong one — and the two
vocabularies overlap in **exactly one string, `Revenue`**, so every US statement
rendered as revenue and nothing else. It reads as a sparse filer, not a bug.
Separately, companyfacts stored (1) raw, so half of every fallback statement was
unreadable: the whole cash-flow statement, equity and working capital.

Two guards, one per side, and they must both stay:
`packages/core/__tests__/us-fundamentals/concept-vocabulary.test.ts` asserts the
reader table is a subset of the generated 235-tag universe;
`tests/test_companyfacts_vocabulary.py` asserts the writer's keys are members of
the same universe, reading the library INDEPENDENTLY (deriving the universe from
`app/sec/standardize.py` would grade the mapper against itself).

Regenerate the universe with `scripts/gen_standard_tags.py`. `test_edgartools_pin`
hashes **both** JSON files; it hashed only `concept_mappings.json`, arguing at
length for why a hash beats a version string, while watching the file that
decides nothing.

**Collisions are resolved by upstream CONFIDENCE, never by arrival order.** The
buckets are wide — 130 us-gaap tags collapse into `Revenue`, 58 into
`CashAndMarketableSecurities`. Alphabetical-first is deterministic and
meaningless: measured, it picks `AdmissionsRevenue` over `Revenues`,
asset-backed securities over cash, and `IncomeLossAttributableToParent` over
`NetIncomeLoss` (confidence 1.0, used by 86% of filers).

### An authority order must gate the WRITE, not just the pointer

`us_fundamentals` has two writers on one unique key, and `mappingSource` is
deliberately NOT in that key — putting a discriminator in makes one period two
rows that every reader double-counts while looking entirely normal (the trap
already documented for `StockFinancials.basis`). Both writers derive from the
SAME filing, so they produce the same `accession` and collide on the whole key.

`MAPPING_SOURCE_RANK` existed, was correct, and was consulted in exactly one
place: `recompute_is_latest`, which runs AFTER the write and only chooses which
row carries a pointer. **A declared authority order the writer never reads ranks
the corpses.** The nightly companyfacts pass `$set` a 15-line view over the
44-line one with segments, and nothing was left to reconcile against.

`AuthorityGuard` enforces it at the write, in two passes, in order:

1. `UpdateOne(key, {"$setOnInsert": doc}, upsert=True)` — create when absent.
2. `UpdateOne({**key, field: {"$nin": stronger}}, {"$set": setter}, upsert=False)`.

A conditional filter CANNOT be combined with `upsert=True`: when a stronger
incumbent makes it miss, MongoDB inserts, and the insert violates the unique
index. `$nin` rather than `{field: null}` because it matches an ABSENT field, so
a legacy row ranks lowest and stays writable — the Mongo absent-vs-null trap
that has now caused MONEY-1050, 1234 and 1235.

Refusals are COUNTED (`WriteResult.suppressed`, `counters.statementsSuppressed`).
Without that, a legitimately-refused run is indistinguishable from the
silent-zero-write failure the monitor exists to catch.

**Both write paths read ONE `WritePolicy`.** `MongoRowWriter.upsert_rows` — the
per-filing parse, via dispatch — called `bulk_upsert` bare, so the
AUTHORITATIVE writer had neither the guard nor `isLatest` insert-only protection
while `upsert_fundamentals` had both. Two paths that each declare their own
protections agree only until someone edits one.

### Never print an exception object raw

`httpx` and `google-auth` both put the request into the exception, so
`logging.error("failed", exc_info=True)` prints the `Authorization` header, the
`X-OPENFIGI-APIKEY` header and any signed URL into Cloud Logging, where it is
retained and searchable.

`app/logging_setup.py` fixes this at the TRANSPORT: `install_logging()` is the
first statement of `main.py` and installs a `RedactingFilter` on the root
logger, which redacts the rendered message and DROPS tracebacks entirely
(keeping the exception TYPE name, which identifies the failure and carries
nothing secret). Use `log_error(message, err)` at call sites.

Keep it first in `main.py`. Anything that logs during import logs unredacted,
and boot-time failures are exactly the ones that still have headers attached.

---

## Measured facts — do not re-derive these

Verified 2026-08-29 unless noted.

- **edgartools 5.53.0**, MIT, py>=3.10. Pinned with `==` because a silent minor
  upgrade can change a standardised concept mapping and therefore change a
  reported revenue, with no test failing anywhere.
- `EDGAR_RATE_LIMIT_PER_SEC` defaults to **9**; the limiter is a per-process
  `pyrate_limiter` `Limiter` over an **InMemoryBucket**. There is NO distributed
  limiter — which is why T3 replaces it with a Redis bucket and why every job
  spec carries `REDIS_URL`.
- edgartools **never retries 429** and never sleeps on `Retry-After`; it raises
  `TooManyRequestsError`. It has **no offline mode**: a local-storage miss
  always falls through to the network.
- `EDGAR_IDENTITY` is sent VERBATIM as User-Agent and is **unvalidated**. SEC's
  template is `Name email`.
- SEC fair access is **10 req/s**; violation gets "limited for a brief period",
  resuming after ~10 min under the threshold. An undeclared UA gets **403** with
  body "Undeclared Automated Tool". **No 429 and no documented `Retry-After`** —
  so classify on BODY TEXT, never on status alone.
- Bulk sizes: `companyfacts.zip` **1,407,685,214 B**, `submissions.zip`
  **1,560,992,008 B**; both `accept-ranges: bytes`. Documented publish is
  "approximately 3:00 a.m. ET" but MEASURED Last-Modified is 23:49 / 23:57 ET
  the previous day — **never pin a clock, compare Last-Modified/ETag**.
- `getcurrent` Atom with `count=100` returns **100 entries = 49 filings**: one
  entry per filer ROLE (Reporting / Issuer / Subject / Filed by). Dedupe on the
  accession in `<id>`. `type=` is IGNORED server-side on a single page, and
  there is no `rel=next`.
- EFTS `search-index`: `q` is OPTIONAL. `_source` keys include `adsh`, `ciks`
  (an ARRAY), `form`, `root_forms`, `file_date` — there is **no `form_type`**.
  10,000-hit window, `from` steps of 100.
- Cloud Build caps a single arg at **10,000 characters**. Keep commentary
  OUTSIDE the `service.yaml` heredoc; a comment in there costs exactly as much
  as configuration. Current: prod 5,217 / QA 5,164 (re-measured after dropping
  the unread `GCP_SERVICE_ACCOUNT_KEY_BASE64` mount; re-measure rather than
  trusting this line — `tests/test_deploy_contract.py` asserts the cap and will
  fail before a deploy does). To re-measure:
  `python3 -c "import yaml;d=yaml.safe_load(open('cloudbuild.prod.yaml'));print(max(len(a) for s in d['steps'] for a in s.get('args',[])))"`
- **This service authenticates as its RUNTIME service account** (`stockbook-api@`)
  via plain ADC — `app/sec/archive.py` builds `storage.Client()` and nothing
  reads `GCP_SERVICE_ACCOUNT_KEY_BASE64`. That secret was mounted into the
  service and all five jobs for no functional reason and has been removed; grant
  bucket object read/write to the runtime SA. The "mounted key OUTRANKS the
  runtime SA" rule is real but belongs to the TypeScript `googleCredentials()`
  helper, not here.
- **QA has no `edgar/` byte mirror.** `sync-prod-to-qa.sh` mirrors only `feeds/`
  and `stocks/`; `edgar/` sits outside them on purpose (~330 GB/yr). QA gets
  prod's parsed `us_*` ROWS through the collection sync, and its only byte-level
  path is the fixture that `scripts/ops/edgar-qa-synthetic-filing.sh` uploads.
  The five Cloud Run jobs are therefore prod-only in practice.
- **Pub/Sub push ack deadline is 600s and is Pub/Sub's MAXIMUM.** Cloud Run's
  3600s request timeout is never the binding constraint. A handler that runs
  past it is REDELIVERED while the first copy is still running.
- **An image is never enqueued** (MONEY-1324). `us_filing_documents` held 3,054
  rows on 2026-09-01, **1,847 of them `documentType: "GRAPHIC"` and none with a
  `textPath`** — 60% of a `PENDING` queue no extractor can consume. The parser
  refuses them at the seam that decides what is stored, keyed on EDGAR's own
  TYPE (never the filename, never whether text came out — a real exhibit whose
  extraction threw looks identical from there and must still land). Refused
  rather than stored `UNSUPPORTED`: the full argument, including the reparse
  churn a stored hashless row causes, is the `app/parsers/eightk_logic.py`
  module docstring. The legacy rows go with
  `scripts/purge_image_documents.py` (dry-run by default, one run per env).
- **edgartools CANNOT read a PDF, and a PDF exhibit was a PERMANENT gap**
  (MONEY-1350). `Attachment.text()` answers `None` for any extension outside its
  text set (`attachments.py:526`), so 9 of 5,377 rows on 2026-09-05 held
  `textPath: null` that no reparse would ever have filled — 8 foreign-issuer 6-K
  exhibits (EQNR, SLF, WPM, Polestar, GORO ×2, GDS, LU) and one 8-K (TMQ).
  `edgar_adapter.pdf_text` is the fallback, over `attachment.download()`, which
  returns the uudecoded BYTES for an SGML-backed attachment and touches no
  socket. Pages are joined with a `<!-- page N -->` marker; a PDF that yields
  nothing (scanned, or unreadable) stays `text=None` and is COUNTED, so "one
  fewer exhibit" and "one exhibit had no text layer" stop being the same number.
  `pdfTextExtracted` / `pdfNoTextLayer` are reported beside — never folded into
  — `binaryMediaSkipped`, which is one leg of a three-way partition.
- **`extractionStatus` is decided at WRITE time** (MONEY-1351). It read
  `PENDING` on 100% of 5,377 prod rows while 3,296 already held text: a column
  with one value over its whole population measures nothing, and queue depth was
  unanswerable. `READY` when text was extracted, `FAILED` when it was not;
  `PENDING` survives ONLY as the row model's default, the never-processed value
  no writer stamps. Legacy rows go with `scripts/backfill_extraction_status.py`
  (dry-run default, TTY-gated `--apply`). Note its two filters spell the
  absent-vs-null trap in OPPOSITE directions on purpose: `{"$type": "string"}`
  for READY (never `{"$ne": None}`, which returns zero from both sides), and the
  inclusive `{"textPath": None}` for FAILED.
- **An INDEXED filing had no way back into a parse queue** (MONEY-1352). Rows
  reach a parser only through LIVE DETECTION, which publishes as it discovers
  and never looks back, so a filing indexed by a bulk walk or one whose publish
  failed once is parked forever. Measured 2026-09-05: 584 of 7,112 CIK-bearing
  active US stocks have no `us_fundamentals` row and ~430 of them have XBRL
  FINANCIALS filings sitting `INDEXED` — 221 10-Q, 136 20-F, 52 40-F, 10 20-F/A.
  `scripts/enqueue_indexed_financials.py` is the operator path; the selection
  rules are PURE in `app/bulk/enqueue_logic.py`. The 11 non-XBRL 10-Ks are
  deliberately NOT selected: the parser answers `UNSUPPORTED` for them, so
  publishing spends a SEC fetch to reach a verdict already in the row and
  restamps away the fact that they are still waiting.
- **`standardized._collisions` had never been read** (MONEY-1354) — present on
  4,250 CASH_FLOW and 3,553 BALANCE_SHEET `isLatest` rows on 2026-09-05.
  `scripts/report_collisions.py` reports it and writes nothing. It does NOT add
  a `standardize` rule and must not: last-wins is right because of how filers
  PRESENT statements, and a table of counts cannot show that — a rule needs a
  fixture test on a real filing. The one number to read is whether the kept
  value had the larger MAGNITUDE, because a cash-flow component is routinely
  negative where its total is positive, and comparing signed values reports
  last-wins as wrong in exactly the Apple case it is known to be right about.

---

## Dependencies are PINNED in `constraints.txt`, not just floored

`pyproject.toml` states floors — what the code NEEDS. `constraints.txt` pins the
whole transitive closure — what we SHIP — and the Dockerfile's RESOLVING install
passes it to pip (`-c constraints.txt`). The later `pip install --no-deps .` only
re-registers package metadata and needs no constraints.

Without it two builds of one commit could install different code, and
`google-auth` — the library that decides whether a Pub/Sub push token is valid —
was floating on `>=2.33` while the container holds `DATABASE_URL`, `REDIS_URL`,
`OPENFIGI_API_KEY` and `DD_API_KEY` for its environment. `yarn.lock` does this
for the TypeScript half; this is the same thing for the Python half.

Regenerate DELIBERATELY, and read the diff — a version moving there is an
upgrade that ships to production:

```bash
.venv/bin/pip freeze --exclude-editable | sort > constraints.txt   # then re-run the suite
```

`tests/test_dependency_pinning.py` asserts BOTH halves. Either alone is a false
comfort: a constraints file the build ignores is decoration, and a `-c` flag
pointing at a file missing the dependency that matters pins nothing.

## Local Python

3.12 is the target and the only version CI and the Dockerfile use. The
`.venv/` here is gitignored via the repo root's `.gitignore`; `.dockerignore`
excludes it from the build context (a full edgartools install is ~400 MB and
would otherwise be uploaded to Cloud Build on every push).

Note the module is `app/logging_setup.py`, NOT `app/logging.py` — the latter
shadows the stdlib for absolute imports on some tooling paths, and the failure
is an import error at container start whose stack trace does not name the cause.

---

_Last Updated: August 2026_
