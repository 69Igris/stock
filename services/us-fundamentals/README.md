# us-fundamentals

US company fundamentals from SEC EDGAR — MONEY-979.

A Python 3.12 / FastAPI service on Cloud Run. It is the ONLY thing in this
monorepo that talks to `sec.gov`, and it exists as a separate service rather
than a route family on `stockbook-workers` for one reason: `edgartools` is the
best SEC parser available and it is Python.

## Quick start

```bash
cd services/us-fundamentals
python3.12 -m venv .venv
.venv/bin/pip install -e ".[dev]"

.venv/bin/python -m pytest -q          # the suite
.venv/bin/ruff check . && .venv/bin/ruff format --check .

# Run it. /health needs nothing configured and reports what is missing.
.venv/bin/uvicorn app.main:app --port 8080 --reload
curl -s localhost:8080/health | python3 -m json.tool
```

`/jobs/*` is behind the OIDC gate. Locally, set `APP_ENV=development` and
`ENABLE_PULL_SUBSCRIBER=true` to skip it — those are the ONLY two values that
do, and both are required (see `app/auth_logic.py`).

```bash
APP_ENV=development ENABLE_PULL_SUBSCRIBER=true .venv/bin/uvicorn app.main:app --port 8080
curl -s -XPOST localhost:8080/jobs/edgar-detect -H 'content-type: application/json' -d '{}'
```

A body with no `message.messageId` skips the dedupe entirely, which is what
makes a hand-rolled `curl` behave sanely.

## Shape

```
app/
  main.py            FastAPI app: /health + the seven /jobs/* routes
  settings.py        every env read, PER CALL, as a function
  auth_logic.py      PURE OIDC skip decision + the middleware FACTORY
  auth.py            google-auth verifier + JSONResponse
  dedupe_logic.py    PURE claim/steal/release decisions (shared collection
                     and shared semantics with the TypeScript workers)
  dedupe.py          pymongo shell + the request middleware
  envelope.py        Pub/Sub push envelope decode
  logging_setup.py   JSON lines + credential redaction
  db.py              one process-wide MongoClient
  store/
    collections.py   the ELEVEN Mongo collection names (parsed by a TS test)
    outcome.py       DogStatsD job counters, names shared with the workers
  sec/               SEC client, shared Redis limiter, archive codec  (T3)
  jobs/              the seven push handlers                          (T6/T7/T9)
  bulk/              the four Cloud Run job entry points              (T5/T8)
```

`*_logic.py` modules have NO I/O, no clock and no network, so a test can drive
the REAL implementation. A test that re-declares the logic inline is a shadow
test and is worse than no test — it stays green when the real code is deleted.

## Routes

| Route                               | Topic                    | What                                                           |
| ----------------------------------- | ------------------------ | -------------------------------------------------------------- |
| `GET /health`                       | —                        | Mongo, Redis, edgartools, flags                                |
| `POST /jobs/edgar-detect`           | `edgar-detect`           | minutely getcurrent walk; `{"mode":"efts"}` = hourly reconcile |
| `POST /jobs/edgar-parse-ownership`  | `edgar-parse-ownership`  | Forms 3/4/5                                                    |
| `POST /jobs/edgar-parse-13f`        | `edgar-parse-13f`        | 13F-HR + amendments                                            |
| `POST /jobs/edgar-parse-13dg`       | `edgar-parse-13dg`       | Schedules 13D/13G                                              |
| `POST /jobs/edgar-parse-8k`         | `edgar-parse-8k`         | 8-K items + exhibits                                           |
| `POST /jobs/edgar-parse-financials` | `edgar-parse-financials` | 10-K/10-Q/20-F/40-F                                            |
| `POST /jobs/edgar-evict`            | `edgar-evict`            | 13F hot -> cold shard                                          |

**The route path MUST equal the topic base name.** `workers/scripts/setup-pubsub.sh`
builds the endpoint as `${US_FUNDAMENTALS_URL}/jobs/${BASE_TOPIC}`, so a route
named anything else answers 404 to every delivery — which Pub/Sub retries five
times and then dead-letters, silently.

A route whose handler module does not exist yet answers **501** with the module
name. Not 500 (indistinguishable from a crash) and not 404 (dead-letters).

## Environment

| Variable                 | Prod                             | QA           | Notes                                                               |
| ------------------------ | -------------------------------- | ------------ | ------------------------------------------------------------------- |
| `APP_ENV` / `NODE_ENV`   | `production`                     | `qa`         | drives the OIDC gate and the `env:` tag                             |
| `PUBSUB_ENV`             | `prod`                           | `qa`         | topic suffix                                                        |
| `CLOUD_RUN_URL`          | service URL                      | service URL  | the OIDC AUDIENCE. Unset -> 500, never a skip                       |
| `GCP_PROJECT_ID`         | `stock-book-483718`              | same         |                                                                     |
| `GCP_STORAGE_BUCKET`     | `stockbook-content-prod`         | `-qa`        | archive root (`edgar/...`)                                          |
| `SEC_EGRESS`             | `archive`                        | `off`        | QA RAISES on any network attempt                                    |
| `EDGAR_IDENTITY`         | `UseMoney deepshaswat@gmail.com` | same         | sent VERBATIM as User-Agent                                         |
| `SEC_RATE_LIMIT_PER_SEC` | `9`                              | `9`          | one below SEC's documented 10                                       |
| `EDGAR_LOCAL_DATA_DIR`   | `/tmp/edgar`                     | same         | edgartools mkdirs AT IMPORT; Cloud Run FS is read-only outside /tmp |
| `EDGAR_DETECT`           | `off`                            | `off`        | literal `"on"` arms it                                              |
| `EDGAR_PARSE_APPLY`      | `false`                          | `false`      | literal `"true"` arms writes                                        |
| `EDGAR_EVICT_APPLY`      | `false`                          | `false`      | literal `"true"` arms DELETES                                       |
| `DATABASE_URL`           | secret `_PROD`                   | secret `_QA` |                                                                     |
| `REDIS_URL`              | secret `_PROD`                   | secret `_QA` | the SHARED limiter; not optional                                    |
| `OPENFIGI_API_KEY`       | secret `_PROD`                   | secret `_QA` | CUSIP resolution; absent degrades                                   |
| `DD_API_KEY`             | secret `_PROD`                   | secret `_QA` |                                                                     |

All three `EDGAR_*` flags ship **present and off**. Absent and explicitly-off
must not be the same state — absent is exactly how `MF_METADATA_PROVIDER`
disabled its job silently for months. Each is compared against a LITERAL string,
never `bool()`: `bool("false")` is `True`, which would arm the one configuration
meant to keep the job off. `/health` reports `absent` / `empty` / the literal
value so an operator can tell the two apart.

## Deploy

```bash
# Everything, in order, for one environment: db -> pubsub -> scheduler ->
# BOTH service deploys -> the EDGAR push subscriptions (which need the URL the
# deploy mints, so they are a SECOND pubsub pass and not the first one).
./scripts/ops/setup-infra.sh prod

# …or the pieces, in this order:
gcloud builds submit --config=services/us-fundamentals/cloudbuild.prod.yaml
EDGAR_PUSH_REQUIRED=1 ./workers/scripts/setup-pubsub.sh prod
./scripts/ops/setup-scheduler.sh prod                       # prod-only rows
./scripts/ops/setup-us-fundamentals-jobs.sh prod --dry-run  # the five jobs
```

**Order matters, and the reason is an audience.** `setup-pubsub.sh` uses the
deployed service URL as BOTH the push endpoint and the OIDC token audience, and
`app/auth.py` verifies every push token against `CLOUD_RUN_URL`. Run it before
the service exists and it creates ZERO `edgar-*-push` subscriptions — it refuses
rather than inventing a URL, because a guessed audience 401s every delivery for
the life of the subscription. It reports that loudly and exits 0 so a cold
environment can still be bootstrapped; the run AFTER the deploy is the one that
creates them, and `EDGAR_PUSH_REQUIRED=1` makes absence an error there.

Do not skip that second pass: a topic with no subscription drops messages
silently — no DLQ, no error, no metric — while `edgar-detect-minutely-prod`
publishes 1,440 times a day. `setup-infra.sh` runs it as step 5 for you.

`setup-scheduler.sh` refuses to create a `:run` trigger for a Cloud Run job that
does not exist, rather than manufacturing a scheduler that POSTs a 404 every
afternoon while listing as ENABLED.

The five backfill jobs are provisioned on **prod only**: their work is fetching
sec.gov and QA runs `SEC_EGRESS=off`, so QA copies would be inert. The QA
cloudbuild's re-pin step therefore reports them as `absent` instead of warning.

## Scripts

None of these run on a schedule. Every writer is DRY-RUN BY DEFAULT and takes
`--apply`; the two read-only ones have no `--apply` because there is nothing for
one to do.

| Script                          | Writes?         | What it is for                                                                                                                                                                                                                |
| ------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backfill_extraction_status.py` | `--apply`       | Decides `extractionStatus` on rows written before MONEY-1351, when the column was PENDING on 100% of them by the original design. ONCE PER ENV.                                                                               |
| `enqueue_indexed_financials.py` | `--apply`       | Publishes already-INDEXED XBRL financials filings to the parse topic. Nothing else enqueues an INDEXED filing — only live detection publishes — so ~430 filers with unparsed filings are unreachable without it (MONEY-1352). |
| `report_collisions.py`          | never           | Prints what `standardized._collisions` has been recording: two filed tags mapped onto one standard concept, where the parser recorded the clash rather than choosing (MONEY-1354).                                            |
| `purge_image_documents.py`      | `--apply`       | Deletes the `GRAPHIC` attachment rows MONEY-1324 stopped writing. ONCE PER ENV.                                                                                                                                               |
| `bench_parse_memory.py`         | never           | Measures what one parse actually costs, because Cloud Run enforces its limit with SIGKILL and the surviving evidence is a 137 exit that reads as a crash rather than as "the limit is too low" (MONEY-979 T20).               |
| `capture_fixtures.py`           | writes fixtures | Re-captures the SEC fixture corpus. **RUN BY HAND, RARELY** — every byte came from a real sec.gov request against a shared 10 req/s company-wide budget.                                                                      |
| `gen_standard_tags.py`          | writes TS       | Regenerates `packages/core/src/us-fundamentals/edgartools-standard-tags.ts` from edgartools' 3.7 MB `gaap_mappings.json`, which upstream regenerates on every release.                                                        |

`backfill_extraction_status.py` and `purge_image_documents.py` both clear what
an OLDER parser wrote, so re-running either against a clean env is a no-op
rather than a second pass.

`SEC_EGRESS=off` on QA, so anything reaching sec.gov (`capture_fixtures.py`, and
`enqueue_indexed_financials.py` if it ever grew a fetch) is a prod-only action.

## Testing

```bash
.venv/bin/python -m pytest -q                  # everything
.venv/bin/python -m pytest -q -m "not slow"    # the CI lane
.venv/bin/python -m pytest -q -m redis         # needs a REAL Redis
```

`redis`-marked tests cannot use a fake: the shared limiter's whole property is
CROSS-PROCESS, and a fake has no cross-process semantics, so a faked test would
assert the opposite of what is under test.

Every guard here has been mutation-verified — break the source, watch the test
go red, restore. An assertion never observed failing is not evidence.
