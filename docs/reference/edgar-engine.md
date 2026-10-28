# US fundamentals engine — SEC EDGAR (MONEY-979)

Design, operating limits and runbook for `services/us-fundamentals/`.

Every number below was MEASURED, on the date given, against the live source —
not read off a documentation page. Where a documented figure and a measured one
disagree, both are recorded and the code follows the measurement.

---

## 1. What this is, and why it is a separate service

Branch 2 of the US data pipeline. Branch 1 (MONEY-980) put US **prices** on
Tiingo; this puts US **fundamentals, filings and ownership** on SEC EDGAR.

It is a **Python** service because the parsing library is Python. `edgartools`
maps 2,923 XBRL tags onto ~95 standard concepts and parses Forms 3/4/5, 13F,
13D/G and 8-K exhibits; hand-rolling XBRL is the one thing prompt 07 explicitly
forbids. It is a **separate deployable** rather than a package because it shares
no runtime with the TypeScript workers — the seam between them is MongoDB and
Pub/Sub, never an import, and a test enforces that (§8).

`services/` is the home for a deployable that is not a Yarn workspace. It is
language-neutral: `workers` is TypeScript and top-level for the same reason
(one deployable, not a library), and a future Rust service goes in
`services/<name>/` with its own Dockerfile and cloudbuild spec. Nothing about
the directory encodes a language; the Dockerfile does. `apps/*` and `packages/*`
are literal Yarn **workspace globs** — a directory there must have a
`package.json`, or `yarn install`, Turbo's task graph and
`scripts/gen-test-coverage.ts` all break on it.

---

## 2. Legitimacy — every byte through a documented interface

This engine is deliberately **not** shaped like the NSE/BSE scrapers. SEC
publishes these as public interfaces and states that its content is free to
reuse; we identify ourselves and stay well inside the published limit.

**Sources, and only these:**

| Source                 | URL                                                                        |
| ---------------------- | -------------------------------------------------------------------------- |
| Bulk facts             | `www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip`             |
| Bulk submissions       | `www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip`          |
| Per-company JSON       | `data.sec.gov/submissions/…`, `data.sec.gov/api/xbrl/companyfacts/…`       |
| Full submission bundle | `www.sec.gov/Archives/edgar/data/{cik}/{acc}/{acc}.txt`                    |
| Live feed              | `www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&output=atom`           |
| Full-text search       | `efts.sec.gov/LATEST/search-index`                                         |
| Daily index            | `www.sec.gov/Archives/edgar/daily-index/{yyyy}/QTR{n}/form.{yyyymmdd}.idx` |
| Ticker maps            | `www.sec.gov/files/company_tickers*.json`                                  |
| Fails-to-deliver       | `www.sec.gov/data/foiadocsfailsdatahtm` (CUSIP↔SYMBOL)                     |

**Fair access** (measured 2026-08-29 from
`sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data`):

- Stated limit: _"Current max request rate: 10 requests/second."_
- Required: a declaring `User-Agent`. SEC's own template is `Name email`.
  Ours is `EDGAR_IDENTITY`, sent verbatim.
- On violation: _"further requests from the IP address(es) may be limited for a
  brief period… once the rate of requests has dropped below the threshold for
  10 minutes, the user may resume."_
- **There is no 429 and no documented `Retry-After`.** An undeclared or
  rate-violating client gets a **403 with a body** — `Undeclared Automated
Tool` or a rate-threshold page. **Classify on BODY TEXT, never on status.**

**Our budget is 9 req/s, shared across every process, and fail-closed.** See §4.

We send no cookies, no `Origin`, no `Referer`, and nothing that impersonates a
browser. This is identification, which SEC asks for — not evasion.

---

## 3. Measured facts the code depends on

Verified 2026-08-29 unless noted. Each one changes a line of code.

1. **`companyfacts.zip` is 1,407,685,214 B; `submissions.zip` is
   1,560,992,008 B.** Both serve `accept-ranges: bytes`. Too large for a
   600 s Pub/Sub handler and too large for Cloud Run's tmpfs (which is RAM), so
   the bulk legs are Cloud Run **jobs** that stream to GCS and then range-read.
2. **Publish time is not 3:00 a.m. ET.** The docs say
   _"republished nightly at approximately 3:00 a.m. ET"_; measured
   `Last-Modified` was **23:49 / 23:57 ET**. Never pin a clock — compare
   `Last-Modified`/ETag and treat "unchanged" as the named outcome
   `NOT_YET_PUBLISHED`, not a failure.
3. **`getcurrent` returns one entry per filer ROLE, not per filing.** A
   `count=100` page held **100 entries = 49 distinct accessions** (46
   Reporting, 33 Issuer, 16 Subject, 5 Filed-by). Dedupe on the accession in
   `<id>`. `type=` is ignored server-side on a single page. There is no
   `rel="next"`.
4. **After-hours those 100 entries spanned ~2 hours**; at the 16:00–18:00 ET
   peak they span minutes. A detection run must be willing to walk many pages.
5. **EFTS `q` is optional** — with no query the server filters `sequence=1`, so
   one hit per filing. `_source` carries `adsh`, `ciks` (an **array**), `form`,
   `root_forms`, `file_type`, `file_date`, `items`, `period_ending`. **There is
   no `form_type` field.** 10,000-hit window; `from` steps of 100.
6. **13F values changed unit by FILING DATE.** Release 34-95148: whole dollars
   for reports **filed on or after 2023-01-03**, thousands before. A 2023-filed
   amendment of a 2022 quarter is in dollars while the original was in
   thousands. Keying on the period would be wrong for exactly those rows.
7. **13D/G form strings changed spelling** with the 2024-12-18 XML mandate:
   `SCHEDULE 13D` / `SCHEDULE 13G/A` now, `SC 13D` / `SC 13G` historically. A
   classifier that knows one spelling drops half the history. Structured data
   exists only post-mandate; before it, identities only.
8. **Form 4 has 20 XML transaction codes.** `K` is not one of them — EDGAR
   appends it when `<equitySwapInvolved>` is true, so it is a FLAG. `V` is not
   one either — it is `<transactionTimeliness>` E/L/blank. Tables cap at 30
   rows, so one economic event can span filings. `natureOfOwnership` is
   mandatory when ownership is `I` and forbidden when `D`.
9. **Daily index files are never corrected.** Post-acceptance deletions appear
   only in the Saturday full-index rebuild — hence the weekly `WITHDRAWN` pass.
10. **Revenue and OCF are fallback chains, not concepts.** `SalesRevenueNet`
    was deprecated 2018-01-31; `RevenueFromContractWithCustomerExcludingAssessedTax`
    dominates from FY2018; `Revenues` remains the sanctioned total for banks and
    insurers. For cash flow, `…OperatingActivitiesContinuingOperations` is
    misused often enough that SEC issued a data-quality reminder (2021-05-25).
    Which chain fired is stored in `standardized._fallbacks`.
11. **`companyfacts` holds no extension concepts and no dimensional facts** —
    non-custom taxonomies, entity-wide only. Segments exist ONLY in the
    per-filing XBRL, so the bulk file can never be the sole source of a
    statement.

### edgartools 5.53.0 — what it does not do

| Claim                       | Reality                                                                                                    | Our answer                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| "distributed rate limiting" | `httpclient.py:205-221` builds a per-process `InMemoryBucket`                                              | We inject a Redis bucket (§4)                |
| retries on 429              | Never. `httprequests.py:834` raises; `Retry-After` is parsed into the exception only                       | Our client backs off                         |
| offline mode                | None. `EDGAR_ALLOW_NETWORK_FALLBACK` gates ONE XBRL-instance fallback; a local-storage miss always fetches | `SEC_EGRESS=off` raises before any socket    |
| keeps `frame`               | The entity parser drops it                                                                                 | We parse the raw companyfacts JSON ourselves |
| knows every Form 4 code     | Its table lacks `K` and `L`                                                                                | We use SEC's own `TransCodeList`             |

**The version is pinned and tripwired.** `tests/test_edgartools_pin.py` asserts
both the version and the sha256 of `concept_mappings.json`: a silent upgrade
silently changes reported numbers.

---

## 4. The shared 9 req/s budget

`edgar.httpclient.HTTP_MGR` is looked up at CALL time (`http_client()`), and no
module captures it at import — verified by grep across the package. So:

```python
edgar.httpclient.HTTP_MGR.rate_limiter = Limiter(
    RedisBucket.init([Rate(9, Duration.SECOND)], redis_client, "sec:ratelimit")
)
edgar.httpclient.HTTP_MGR.close()   # drop the already-built httpx client
```

Our own `SecClient` acquires from the SAME `Limiter`, so library traffic and our
traffic share one bucket across every instance and every job.

**Fail-closed is the whole point.** If Redis is unreachable — at install or at
acquire — we raise `LimiterUnavailable` and stop. We never fall back to an
in-memory bucket, because N instances × 9 req/s is precisely how an IP gets
blocked, and the fallback would be invisible until the block arrived.

`RedisBucket` timestamps with local `time_ns()`, so cross-instance clock skew
matters; Cloud Run is NTP-synced.

**Only prod talks to SEC.** Cloud Run has shared egress IPs and SEC limits per
IP, so two environments would spend one budget and get both blocked. QA runs
`SEC_EGRESS=off` — every client method raises before opening a socket — and
receives ROWS through `sync-prod-to-qa`.

ROWS, not BYTES, and the distinction is load-bearing. QA does **not** read
prod's `edgar/` archive: `app/sec/archive.py` resolves one bucket from
`GCP_STORAGE_BUCKET` (`stockbook-content-qa` there), and `sync-prod-to-qa.sh`
mirrors only the `feeds/` and `stocks/` prefixes — `edgar/` sits outside both on
purpose, because raw filings grow ~330 GB/yr and that mirror rsyncs twice daily.
So an archive miss on QA RAISES with nothing behind it, which makes the five
Cloud Run jobs prod-only in practice. QA's one byte-level path is
`scripts/ops/edgar-qa-synthetic-filing.sh`: it uploads a committed fixture
bundle to the QA bucket at the exact key `SecClient.fetch_bundle` reads first,
publishes one message, and asserts the row landed with zero network attempts.
A byte-level replay tier for `edgar/` has not been built and would be its own
ticket, with that 330 GB/yr to argue.

---

## 5. Storage

**GCS, `edgar/` prefix** — deliberately OUTSIDE `feeds/`, whose entire prefix
the prod→QA mirror rsyncs twice daily; raw filings grow ~330 GB/yr.

```
edgar/bulk/{feed}/{YYYY-MM-DD}/{file}.zip   lifecycle: delete @ 30 d (superseded nightly)
edgar/filings/{cik10}/{accession}/submission.txt   permanent; -> Nearline @ 30 d
edgar/text/{cik10}/{accession}/{seq}.txt           extracted exhibit text (re-derivable)
edgar/facts/{cik10}/{taxonomy}                     gz-JSONL: EVERY fact incl. `frame`
edgar/13f/{manager}/{period}                       gz-JSONL: evicted holdings
```

Those two lifecycle rules are PROVISIONED, not aspirational:
`scripts/ops/gcs-lifecycle.json` declares them and
`scripts/ops/setup-gcs-lifecycle.sh {qa|prod|all}` applies them (`--dry-run`
first). It has to MERGE rather than set, because a lifecycle policy belongs to
the BUCKET and `--lifecycle-file` replaces the whole thing — `stockbook-content-
{env}` also holds `feeds/`, `candles/`, the learning content and the RAG corpus,
so a naive apply would delete every rule any of those ever acquires, silently,
over the following 30 days. The script reads the live policy first and REFUSES
if that read fails; a policy built from an assumed-empty baseline is
indistinguishable from success. Every rule is `matchesPrefix`-scoped, and
`edgar-infra-coverage.test.ts` fails on one that is not.

MONEY-1309 widened that scope from the literal `edgar/` to an explicit
ALLOW-LIST (`ALLOW_PREFIXES` in the script), because a second prefix moved into
the same policy file — `feeds/TIINGO/ws/`, the raw Tiingo websocket ticks,
deleted at 30 days. Two things follow for anyone editing the EDGAR rules:

- The policy file was RENAMED `gcs-lifecycle-edgar.json` -> `gcs-lifecycle.json`.
  It is no longer edgar-only.
- A SECOND, independent refusal now guards it. `PROTECTED_ROOTS` rejects any
  Delete rule whose prefix would SWEEP a protected root, tested as
  `root.startsWith(prefix)`. `edgar/filings/` is on that list, which closes a
  hole this section never covered: a rule with prefix `edgar/` passes the
  allow-list, is not caught by the older "edgar/filings must never be deleted"
  assertion (that one looks for a prefix STARTING WITH `edgar/filings/`), and
  would delete the permanent archive.

Shards use the codec in
`packages/core/src/market-data/candles/candle-logic.ts:579-760` — gzip(JSONL),
sorted, no trailing newline, format sniffed from magic bytes, key carries no
extension so parquet can replace it later. A GCS put REPLACES, so every writer
reads-merges-writes.

**Mongo** holds the request-path subset: 11 models, all declared in
`schema.prisma` (the block at the end). Prisma is the schema of record even
though no TypeScript writer exists — a collection with two independent notions
of its own shape is how MONEY-1234/1235 happened. The Python models mirror the
field names and a test compares them (§8).

**13F tiering**: hot = the two most recent report periods; older quarters are
archived, **re-read**, and only the rows the re-read proves present are deleted.
Never delete on a write's return code.

**Amounts are USD**, in a `currency` column. No FX in this engine; dual
denomination is MONEY-982.

---

## 6. Detection, and the latency roadmap

Filings are found four ways, deliberately overlapping:

|                   | Cadence      | Latency    | Role                      |
| ----------------- | ------------ | ---------- | ------------------------- |
| `getcurrent` Atom | 1 min        | p95 ≈ 90 s | primary                   |
| EFTS              | hourly       | ~1 h       | reconcile                 |
| `submissions.zip` | nightly      | ~1 d       | authoritative ledger      |
| full-index        | weekly (Sat) | ~1 w       | corrections / `WITHDRAWN` |

Every parser is a pure `parse_and_store(accession, bundle_bytes)` behind a
dispatch seam, so the SOURCE of detection is swappable without touching a
parser:

- **now** — Scheduler → Pub/Sub push, p95 ≈ 90 s.
- **MONEY-1271, < 1 s** — an always-on poller (`minScale = maxScale = 1`, CPU
  always allocated) polling `getcurrent` at ~1 s and parsing small forms
  in-process. This is the POLLING FLOOR: SEC's submissions API is itself
  _"less than a second"_, so no poll beats it.
- **MONEY-1272, < 100 ms** — the SEC **Public Dissemination Service**, which
  PUSHES each accepted submission over SFTP/SCP to a subscriber host, 6 a.m.–
  10 p.m. ET, under a paid Maximus subscription (fee unpublished; contact
  `PDSBusiness@maximus.com`). Cloud Run cannot receive SFTP, so this needs a
  static-IP VM. Everything downstream is unchanged.

The Scheduler path stays deployed as the fallback at every stage.

---

## 7. Operating limits

- **Pub/Sub push has a 600 s ack deadline** — exceeded, Pub/Sub REDELIVERS
  while the first copy still runs. Handlers hold `RUN_TIME_BUDGET_MS = 420_000`
  checked BETWEEN items, so the true wall is `budget + one worst item`, and
  self-chain up to `MAX_CHAIN_DEPTH`.
- **Bulk work is a JOB, not a handler** — the zips alone exceed the deadline.
- **First-run backfills are SEQUENTIAL**, because the 9 req/s is shared and
  parallel jobs only contend:

  | Step             | Volume        | Wall clock                              |
  | ---------------- | ------------- | --------------------------------------- |
  | submissions      | 1.5 GiB       | ~30 m                                   |
  | companyfacts     | 1.3 GiB       | ~45 m                                   |
  | statements, 6 FY | ~150k filings | ~4.6 h                                  |
  | 13F, 5 y         | ~175k         | ~5.4 h                                  |
  | 13D/G, 5 y       | ~125k         | ~3.9 h                                  |
  | Form 4, 5 y      | ~1.4M         | ~43 h (chained across 24 h task limits) |

- **Re-run to go deeper**: `--from-fy/--to-fy` for statements (7–10, then
  2009+), `--from-date` for ownership. Everything is checkpointed per
  (cik, fy) or per day, and a DONE checkpoint skips BEFORE the fetch.

---

## 8. What the tests enforce

- **No SEC egress from web/api** — source grep + dependency check in both apps;
  `data.sec.gov`, `efts.sec.gov` and `api.openfigi.com` in `FEED_HOSTS`.
- **Exactly one `import edgar`** in the tree.
- **Schema parity** — Prisma models vs the Python writers' field names.
- **Sync coverage** — `prod-only-sync-coverage.test.ts` reads the service's
  `app/store/collections.py` (kept a literal dict for exactly this) and fails
  when a collection is neither synced nor exempt. It previously scanned only
  `workers/src/processors`, so a Python writer was invisible to it.
- **Fair access** — a load test runs 4 processes through the real client against
  a fake SEC server sharing one Redis bucket and asserts no 1-second window
  exceeds 9 requests; the mutation (per-process in-memory buckets) must go red.
- **The version tripwire** described in §3.

---

## 9. CUSIP → ticker

No official SEC file maps CUSIP to ticker, and 13F reports positions by CUSIP
alone. Resolution is layered, three primary/in-house tiers before any vendor:

1. **`SEC_13DG`** — a 13D/G cover page publishes CUSIP and subject CIK together.
2. **`TIINGO_FIGI`** — the 13F `figi` column (added by EDGAR Release 22.4.1,
   Jan 2023) equals `UsInstrument.openFIGIComposite`. Verified: AAPL
   `BBG000B9XRY4`, BRK-B `BBG000DWG505`. 6,633 ACTIVE rows carry it today.
3. **`SEC_FTD`** — SEC's Fails-to-Deliver files pair CUSIP with SYMBOL directly,
   but only for securities with an open fail, so coverage is partial and
   rolling.
4. **`OPENFIGI`** — Bloomberg's mapping API. Free, no paid tier. With a key:
   **25 requests per 6 seconds, 100 jobs per request**. The FIGI identifiers are
   a **public-domain dedication**, storable and redistributable, no attribution
   clause. Key in Secret Manager as `OPENFIGI_API_KEY_{QA,PROD}`. OpenFIGI
   spells share classes with a slash (`BRK/B`) — normalise to a dash.

`us_cusip_map.source` records which tier answered. Unresolved CUSIPs are ROWS,
with an attempt count, retried weekly — an unresolved CUSIP that is not recorded
is one the sweep retries forever.

---

## 10. Runbook

### First deploy

```
scripts/ops/setup-cloudbuild-triggers.sh all --dry-run     # then for real
scripts/ops/setup-infra.sh qa                 # then prod
scripts/ops/setup-us-fundamentals-jobs.sh prod --dry-run   # then for real
scripts/ops/setup-gcs-lifecycle.sh all --dry-run           # then for real
scripts/ops/datadog/apply-monitors.sh prod --dry-run       # then for real
```

`setup-infra.sh <env>` is ONE command for five ordered steps — db push, Pub/Sub,
Scheduler, BOTH service deploys, and then the EDGAR push subscriptions again.
That last step is not decoration, and the ladder used to be written without it:

**The deploy must come before the EDGAR push subscriptions, and only the deploy
can satisfy them.** The seven `edgar-*-{env}-push` subscriptions need the Cloud
Run URL of `us-fundamentals-{env}` as BOTH their push endpoint and their OIDC
audience (`app/auth.py` verifies every push token against `CLOUD_RUN_URL`), and
that URL does not exist until the service is deployed. Run
`workers/scripts/setup-pubsub.sh` on a cold environment and it creates ZERO of
them — it refuses rather than guessing an audience, because a guessed audience
401s every delivery for the life of the subscription. It says so loudly and
exits 0 so the ladder can continue; step 5 then re-runs it with
`EDGAR_PUSH_REQUIRED=1`, where absence is a hard error.

**Why it matters that this is not left to the operator:** a topic with no
subscription DROPS messages silently — no DLQ, no error, no metric — while
`edgar-detect-minutely-{env}` publishes 1,440 times a day. There is nothing to
notice. Confirm rather than assume:

```
# expect 7 rows, and every audience equal to the service's URL
gcloud pubsub subscriptions list \
  --format='value(name,pushConfig.oidcToken.audience)' | grep edgar-
gcloud run services describe us-fundamentals-<env> \
  --region=asia-south1 --format='value(status.url)'
```

Three values must be identical: that described URL, the service's own
`CLOUD_RUN_URL` env var (what `app/auth.py` verifies push tokens against), and
every subscription's audience. One character of disagreement 401s every
delivery, exhausts five attempts and dead-letters — which reads, from the DLQ,
as a job that keeps crashing.

If you run the scripts individually instead, the order is:
`setup-cloudbuild-triggers.sh` -> merge -> deploy ->
`EDGAR_PUSH_REQUIRED=1 workers/scripts/setup-pubsub.sh <env>` ->
`setup-scheduler.sh` -> `setup-us-fundamentals-jobs.sh`.

Order matters in three places and nowhere else:

1. **TRIGGERS before the merge**, or the merge builds nothing and the deploy has
   to be run by hand (`setup-infra.sh <env> --only us-fundamentals`, the manual
   equivalent, which deploys that service and then re-runs the EDGAR push step).
2. **DEPLOY before the EDGAR push subscriptions**, per above. `setup-infra.sh`
   does both halves; by hand it is two invocations of the same script.
3. **JOBS after the first build**, because `gcloud run jobs deploy` needs an
   image that exists. After that first provisioning each release re-pins them
   from the cloudbuild spec, so it is a once-per-environment step, not a
   per-release one.

`setup-scheduler.sh` will decline to create the two bulk triggers until those
jobs exist and will say so; that is the existence gate, not a failure.

The five Cloud Run jobs are provisioned on **prod only**. Their work is fetching
sec.gov and QA runs `SEC_EGRESS=off`, so QA copies would be inert — the QA
cloudbuild's re-pin step reports them as `absent` rather than warning about
them.

### The ingest path ships ARMED — what that changes

`EDGAR_DETECT="on"` and `EDGAR_PARSE_APPLY="true"` in `cloudbuild.prod.yaml`.
Detection and parsing begin on deploy; there is no separate arming step for
them. This matches how the Tiingo US backbone shipped (MONEY-980) — live
schedules, no apply flag at all — and it is deliberate: a feature behind an off
switch is a feature nothing exercises, whose monitors have no series to watch
and whose first real run happens weeks later against code nobody has seen work.

QA ships both off, forced by `SEC_EGRESS=off`: SEC's fair-access limit is per IP
and Cloud Run shares egress addresses, so an armed detector there would raise on
all 1,440 runs a day. QA receives prod's parsed `us_*` rows through the
collection sync instead.

The flags are still **present** in both specs. Absent and explicitly-set must
not be the same state — that is how `MF_METADATA_PROVIDER` disabled a job
silently for months (MONEY-1214). `INTENDED_FLAG_STATE` in
`tests/test_deploy_contract.py` pins both directions, so a silent disarm of prod
fails as loudly as an accidental arming.

**Ordering that still matters**, because it is about DATA, not flags:

```
edgar-bulk-submissions -> edgar-bulk-companyfacts   (the filer universe first)
-> xbrl backfill 6 FY -> 13F 5 y -> 13D/G 5 y -> Form 4 5 y
```

Detection only sees filings from the moment it starts; the backfills are what
give the tables history. Run them in that order and watch
`stockbook.edgar.detect_latency_seconds.95percentile` and the zero-write monitor
between each.

`EDGAR_EVICT_APPLY` stays **off** and is the one flag still needing a deliberate
decision — see §11. It arms DELETES into a cold tier nothing currently reads.

### Preconditions, which arming does not create

Flipping a value in the spec does nothing until: the service is deployed, the
seven `edgar-*-push` subscriptions exist (`setup-infra.sh <env>` — step 5 runs
after the deploy for exactly this reason), the five Cloud Run jobs are
provisioned, and the runtime SA `stockbook-api@` holds `objectAdmin` on the
content bucket. `setup-us-fundamentals-jobs.sh` grants that last one before
deploying and fails loudly if it cannot — but it has never been run against real
infrastructure, so until it has, treat "the archive writes" as unproven. Its
failure mode is a 403 raised AFTER the SEC request has already been spent.

### When SEC blocks us

The body says which. `Undeclared Automated Tool` → our `EDGAR_IDENTITY` was
rejected or dropped: fix the identity, do not retry. A rate-threshold body →
stop for 10 minutes, then resume; check whether a second environment has
`SEC_EGRESS` armed, because that is the only way to exceed a shared 9 req/s.

### Reading a job's outcome — the query matters more than you would think

Every job reports one line, from a `finally`, and it is **structured JSON**:

```bash
gcloud logging read \
  'resource.type="cloud_run_job" AND jsonPayload.message:"[job-outcome]" AND timestamp>="2026-09-05T00:00:00Z"' \
  --project=stock-book-483718 --limit=20 --format=json | jq -r '.[].jsonPayload.message'
```

```
[job-outcome] {"job": "edgar-bulk-companyfacts", "selected": 131, "written": 15715, "skippedReason": "COMPLETED"}
[job-outcome] {"job": "edgar-bulk-companyfacts", "selected": 0, "written": 0, "skippedReason": "NOT_YET_PUBLISHED"}
```

A run that did substantial work and a run that correctly skipped everything are
distinguishable there, without opening the database.

**Do not read `textPayload`.** `install_logging()` puts a `JsonFormatter` on the
root handler, so every line this service emits is a `jsonPayload`; the ONLY
`textPayload` in a job execution is Cloud Run's own `Container called exit(0).`.
So `--format='value(textPayload)'` — and `gcloud logging read`'s default output,
which surfaces the audit entries first — return eight empty strings and that one
line, for a run whose outcome was recorded perfectly.

MONEY-1331 was filed on exactly that reading ("a 1,663-row run and a 0-row run
are byte-identical") and its premise was a query artefact rather than a defect.
Written down because the wrong query is the obvious one, and because "the logs
say nothing" is a conclusion worth being slow to reach.

The DogStatsD warnings alongside those lines were real, and were a different
defect — the jobs had no sidecar, fixed in MONEY-1278 by posting counters over
HTTP instead.

### When the numbers look wrong

Reparse from our own archive — `edgar/filings/{cik10}/{accession}/` holds the
bytes, so a mapping fix or a library upgrade costs no SEC requests. Bump
`mappingVersion` so the reparse is identifiable, and remember that
`us_fundamentals` keeps history: the old rows are still there, marked
`isLatest: false`.

### Re-deriving SEC events — `{"mode":"event-backfill"}` (MONEY-1532)

The detect loop emits one `InstrumentEvent` per filing it CLAIMS, fail-soft, and
the claim is consumed whether or not the emit lands. So an events outage leaves
every `us_filings` row in place and every event missing, and no re-run of the
walk will re-claim them. MONEY-1520's outage lost all of them: prod held ZERO
`SEC_EDGAR` events against 2,184 claims with `detectedAt >= 2026-09-22`.

This mode rebuilds them from the rows. It opens no socket to sec.gov and needs
no `EDGAR_IDENTITY`; it reads `us_filings` and publishes through the same
`_emit_events` / `build_requests` as the live path.

- **What it selects:** every row with `detectedAt` in `[since, now)`. Only a
  detector's claim writes `detectedAt`, and the live path emits every claim
  (every form, every status), so that is exactly the live population. Rows the
  `submissions.zip` ledger created carry no `detectedAt` and never had an event.
- **How it reads 18.8M rows cheaply:** an `_id` range padded by
  `CLAIM_ID_SLACK`, hinted to `_id_` (there is no `detectedAt` index). Measured
  2026-09-23: 2,323 keys for 2,184 rows, 5 ms.
- **`observedAt` is the row's `detectedAt`**, carried in the message. A
  backfilled filing must not arrive dated today.
- **`since`** is ISO-8601 (naive = UTC), inclusive, at most
  `EVENT_BACKFILL_MAX_AGE_DAYS` (90 — MONEY-1521's sink-stamped retention; an
  unsunk row never expires) old; absent = the last 89 days, one day INSIDE the
  bound (`EVENT_BACKFILL_RESUME_GRACE_DAYS`) so a run's own `resumeFrom` is still
  accepted as `since` for a day after the floor moves. Anything else is refused
  as `event-backfill-window-refused`, never clamped.
- **Idempotent.** The event id is `sha1(source NUL accession)` and `observedAt`
  is the insert-only `detectedAt`, so a repeat run rewrites the same values.
  MONEY-1531 makes `observedAt` create-only in `publishEvents` besides.

**Order, per environment:**

1. Deploy the workers (the consumer must honour `observedAt`, or every
   backfilled event is stamped with the envelope's `publishTime` — today).
2. `./workers/scripts/setup-pubsub.sh {env}`, then confirm BOTH
   `us-filing-events-{env}` AND `us-filing-events-{env}-push` exist. A topic with
   no subscription ACCEPTS a publish and discards it, so step 4 would report
   every event sent and deliver none.
3. Deploy us-fundamentals (the mode does not exist before this).
4. Publish once:

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud pubsub topics publish edgar-detect-prod \
  --account=founder@disdigital.in --project=stock-book-483718 \
  --message='{"mode":"event-backfill","since":"2026-09-22T00:00:00Z"}'
```

5. Read the outcome:

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud logging read \
  'resource.labels.service_name="us-fundamentals-prod" AND jsonPayload.message:"[detect] event-backfill"' \
  --account=founder@disdigital.in --project=stock-book-483718 --limit=5 --freshness=1h \
  --format='value(timestamp,jsonPayload.message)'
```

`stop=None` with `sent == selected` is done. `stop=budget-spent` or
`stop=publish-failed` prints `resumeFrom=<ISO>`: publish again with that as
`since`. On the workers, `[internal-events] … observedAtFromPayload=N` must
equal `received` — anything less means the consumer is falling back to
`publishTime`.

**QA is a named skip, by design.** QA ships `EDGAR_DETECT=off` and runs none of
the `edgar-detect-*` schedules, so it never emitted a live SEC event and has
none to re-derive. The mode is gated by the same flag as every other mode of the
route.

---

## 11. Known open items

Found by the round-2 review of the fix round and deliberately NOT fixed there —
each needs its own change, and burying them in a review transcript is how they
get rediscovered a quarter later.

### The 13F cold tier is registered but unreachable

`setUsColdStore` now has a real caller (`workers/src/index.ts`), and the GCS
adapter is correct. But the only reader of a cold shard is `getManagerHoldings`,
and **that has zero callers anywhere** — no research tool, no route, no script.
The user-reachable 13F read is `getTopHolders` (issuer-side), which queries
`us_13f_holdings` directly and has no cold branch.

So the moment `EDGAR_EVICT_APPLY` is armed, a historical-period query returns
`NO_ROWS_FOR_QUERY` — rendered to the model as "this period is not yet ingested"
— while the shard sits unread in GCS. **Do not arm the evictor before a
manager-side tool exists.** The wiring is a new `fetch_us_13f_manager` tool in
`packages/research/src/tools/` plus a `this.register(...)` line; the reader is
already written and tested.

`getManagerHoldings` also still carries the old silent 500-row cap
(`take: US_MAX_LIMIT`, no `+1` probe, never sets `degraded`), which the sibling
path's own doctrine condemns. Fix it when the tool lands, not before — a cap on
a function nothing calls is not worth a migration.

### The 13F read should aggregate in the DATABASE

`getTopHolders` reads up to 32,001 rows per period and aggregates them in
process. Grouping by `(managerCik10, cusip, putCall, sharesType)` server-side
would return POSITIONS, removing the ~3.5x row multiplier from the memory budget
entirely and making the ceiling honest in its own units. The obstacle is the
amendment rule — newest accession supersedes WHOLESALE, it does not sum — which
has to be carried into the pipeline rather than lost in a `$group`.

### A re-parsed 13F cannot be re-evicted

`tier` is insert-only, correctly: the evictor deletes a filing's holdings and
sets COLD, and a re-parse writing the model default `HOT` back would send
readers to rows that are gone. But a re-parse that RESTORES those holdings
leaves `tier` at COLD, so `evict_logic`'s `{"tier": {"$ne": "COLD"}}` never
selects it again — the rows stay hot forever while `coldPath` points at a shard
that no longer matches. Latent: nothing evicts today. The fix belongs to the
evictor, or to a deliberate re-promotion at parse time.

### The OIDC gate checks the audience, not the caller

`verify_oauth2_token(token, request, audience=...)` accepts any Google-signed ID
token minted for that audience; any service account in any GCP project can mint
one. The gate never checks `email` against the push SA or `email_verified`,
which is what Google's push-authentication guidance asks for. What stops it
today is Cloud Run's edge — `ingress: internal` plus `run.invoker` scoped to
`$SA_EMAIL` — so it becomes live only with a second misconfiguration this diff
does not create and does not assert against. It is a faithful port of
`workers/src/index-auth-logic.ts`, so not a regression; a brand-new service is
the cheapest place to add the claim check.

### The bucket grant is codified but unverified

`setup-us-fundamentals-jobs.sh` now grants `roles/storage.objectAdmin` on the
content bucket to the runtime SA before deploying, and fails loudly if it
cannot. Nobody has run it against real infrastructure. Until someone does, treat
"the archive writes" as unproven — the failure mode is a 403 raised INSIDE
`SecClient.fetch_bundle`, after the SEC request has already been spent.
