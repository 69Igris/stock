# Databento harvest — the as-run sequence (MONEY-1373)

One month of Databento Standard, spent once, in a fixed order — and the traps
that make a wrong order expensive rather than merely slow.

> **Corrected 2026-09-07 (MONEY-1373 D2).** An audit of this file against the
> source found 23 defects, two of which were recipes that exit 0 having done
> nothing. Where a step was wrong, the old wording is named in the past tense
> so an operator who followed it knows what happened to them. Every claim
> below carries a `file:line`, a measured number with its date, or a named
> vendor error code.

---

## Why this is gated at all

Databento is the source of **backtest-grade** US intraday truth: consolidated,
**TRADE-derived** bars carrying **real volume**. Tiingo stays the source of
everything a user watches — its `equity/intraday` feed is TOP-OF-BOOK, its bars
are built from the MID, and its `Candle.volume` is written `0` meaning "this
feed does not report volume". Those are two different things and this harvest
does not replace one with the other.

The plan is **one $199 Standard month**: subscribe, batch-export the included
historical windows, cancel. After that the daily append runs on **usage-based**
pricing at roughly **$8–10/month**.

That shape is what makes the order load-bearing. Everything the harvest does not
download inside the subscribed month reverts to usage pricing, and a TB-scale
entry bought at usage prices is not a rounding error — it is another purchase.
There is no partial credit and no re-opening the window later at the included
price.

Two further one-way properties:

- **Batch files expire 30 days after SUBMISSION**, not after completion, not
  after download. A job submitted on day 1 and forgotten is gone on day 31 and
  the only way back to those bytes is to buy the range again.
- **`cost_usd` on the submit response is NULL until the job is processed**
  (`schema.prisma:7222`). The only price available BEFORE spending anything is
  `metadata.get_cost`, which is free. Quote first, always.

---

## OPERATIONAL WARNINGS — read before running anything

### 1. `gcloud logging read --freshness` does NOT bound the query

**Measured twice in this repo.** A `--freshness=10m` read returned lines written
**11 hours** earlier. The flag fails in the direction that produces a confident
wrong conclusion rather than an empty result: a wait-loop polling for an outcome
line matches a PRE-EXISTING entry the instant it starts, so the run you just
triggered is never observed at all, and the run you actually read executed on the
previous revision.

**Always put an explicit `timestamp>=` term in the filter.** Capture the instant
BEFORE you trigger anything:

```bash
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud logging read \
  "resource.type=cloud_run_job
   AND resource.labels.job_name=\"databento-harvest-prod\"
   AND timestamp>=\"$SINCE\"" \
  --limit=50 --order=asc \
  --format='table(timestamp, labels."run.googleapis.com/execution_name", textPayload)' \
  --account=founder@disdigital.in --project=stock-book-483718
```

Read the execution name on every line before believing any of them.

### 2. Cloud Run JOBS pin their image at PROVISION time

A workers deploy of the **service** does not move them. A job keeps executing
whatever image tag it was created with until something re-pins it, and there
are exactly two such things:

- **A RELEASE re-pins both.** `databento-harvest` and `databento-append` are in
  the `for BASE in …` loop in both cloudbuild specs
  (`workers/cloudbuild.prod.yaml:696`, `workers/cloudbuild.qa.yaml:699`), which
  dispatches to `setup-databento-jobs.sh` (`:729` / `:732`).
- **Re-running `./scripts/ops/setup-databento-jobs.sh {qa|prod}` by hand.**

**A job provisioned BETWEEN releases is stale until one of those happens.** That
is the case this warning exists for; the steady state is covered.

This file used to say "re-run setup after every workers deploy" **because
re-running it used to DISARM the jobs** — `--set-env-vars` replaces the whole
block, so every re-run reset both flags to `"false"` while this document told
you to re-run it. Arm the append, ship a release, follow the instruction, and
the append was silently a permanent dry run. **That is fixed**: the script now
reads the LIVE arm off the deployed job and carries it forward
(`setup-databento-jobs.sh:267–300`), printing `carrying forward the LIVE arm
state` when it does. `--disarm` resets **BOTH** flags to `false` deliberately.

Do not trust the `describe` output as evidence either: each job prints a
`[build-provenance]` line naming the commit it is ACTUALLY running as its
**first output** (`databento-harvest.ts:1084`). That line is the evidence; the
describe is the claim.

### 3. `gcloud run jobs execute --args` splits on COMMAS

`--args=--apply,--entry=ohlcv-1m-baseline` is TWO arguments, which is what we
want. But any argument that itself contains a comma is silently torn in half.
Change the delimiter with the alternate-delimiter escape:

```bash
--args=^:^--apply:--entry=ohlcv-1h-master:--step=quote
```

`^:^` makes `:` the separator for that flag, so a comma inside any one argument
survives.

**This warning used to demonstrate the escape with `--symbols=AAPL,MSFT`. The
harvest has no `--symbols` flag** — its valued flags are `entry`, `step`,
`shard`, `max-wait-min` and `chunk` (`databento-harvest.ts:201–206`), and the
shared parser treats an unknown flag as **fatal**, printing `Unknown flag
"--symbols"` and exiting 1 before any work (`packages/core/src/ops/cli-args.ts:117`,
`:207`). So the example was a command that cannot run. **No argument this job
accepts contains a comma today**, which makes the escape PRECAUTIONARY rather
than routine — the mechanics are real and worth knowing, the example was not.

The same wrong `--symbols` example stood in the setup script's own banner and
has been corrected there too (`setup-databento-jobs.sh:510–518`).

`run-market-data-job.sh` refuses a comma-bearing argument outright and prints
the `^:^` form rather than mangling it (`run-market-data-job.sh:471`).

### 4. `--update-env-vars` MERGES; `--set-env-vars` REPLACES

`--set-env-vars` replaces the **entire plain env block** on the job. On these
two jobs that block is exactly (`setup-databento-jobs.sh:345`):

```
GCP_STORAGE_BUCKET, GCP_PROJECT_ID, DD_ENV, DD_TRACE_ENABLED,
DATABENTO_ENV, DATABENTO_HARVEST_APPLY, DATABENTO_APPEND_APPLY,
DATABENTO_MONTHLY_BUDGET_USD
```

**This warning used to name `DATABASE_URL`, `REDIS_URL` and
`DATABENTO_API_KEY` as the casualties. None of the three is in that block.**
`DATABASE_URL`, `DATABENTO_API_KEY`, `DD_API_KEY` and
`GCP_SERVICE_ACCOUNT_KEY_BASE64` are mounted with `--set-secrets`
(`setup-databento-jobs.sh:355`) and are untouched by `--set-env-vars`;
`REDIS_URL` is not on either job at all. Naming the wrong casualties made the
warning easy to dismiss, and what it actually drops is worse in a quieter way:
lose `GCP_STORAGE_BUCKET` and the archive layer treats it as a soft failure, so
an armed run downloads metered bytes into nowhere and reports SUCCESS; lose
`DATABENTO_ENV` and the ledger stamps `env` from `NODE_ENV`, which the image
bakes to `production` in both environments; lose `DATABENTO_MONTHLY_BUDGET_USD`
and the ceiling silently reverts to the $25 default.

**Every arming command in this document uses `--update-env-vars`. Never
substitute the other one.**

### 5. `cost_usd` is null until the job is processed

The ledger row stores `costUsdQuoted` from `metadata.get_cost` (taken BEFORE
submission) and fills `costUsd` only when the vendor reports it. When the two
disagree by more than a cent the budget guard emits a **`QUOTE DRIFT`** warning
naming the entry and job id (`databento-harvest.ts:395–402`). A drift warning
during the subscribed month means an entry you believed was included was not —
stop and re-quote before submitting the next one.

### 6. Files expire 30 days after SUBMISSION

Not after completion. The expiry instant is stored on the row (`tsExpiration`)
rather than inferred, and any row within **2 days** of it
(`EXPIRY_WARNING_DAYS`, `databento-harvest-logic.ts:205`) is reported at ERROR
level and counted. A job left at `DONE` past its window is a re-purchase.

The count reaches you two ways: `expiring=N` on the harvest's own summary line
(`databento-harvest.ts:1253`) and the `stockbook.databento.expiring_jobs`
counter.

---

## 0. THE SUPPORT GATE

Five questions gated this harvest. **Three are now answered and two remain
open** — and only ONE of the two is genuinely support-only. This section used to
say "two of these can only be answered by Databento" and list all five as
outstanding; (b), (d) and (e) are MEASUREMENTS, free ones, and treating them as
support questions parked them behind an email that never had to be sent.

### (a) Inclusion — ANSWERED

**An included window quotes $0.00.** `metadata.get_cost` "respects any discounts
provided by flat rate plans" (`databento-client.ts:325`), so a zero quote under
the live Standard subscription IS the confirmation that the window is covered —
and it is more reliable than any billing page. Measured 2026-09-07: the
subscription is LIVE and an included window quotes $0.00.

**STILL OPEN, and support-only:** any **per-month EXPORT CEILING**. Inclusion of
a window says nothing about how much of it may be exported inside one billing
month. Ask:

```
Our order is roughly: EQUS.MINI ohlcv-1m for ~510 symbols (2023-03-28 -> today),
ohlcv-1h for every Stock+ETF in our master (8 requests of <=2,000 symbols, same
range), ohlcv-1s for ~510 symbols (same range, archive only), bbo-1m for ~510
symbols (12 months), tbbo for 50 symbols (12 months), definition + statistics.
Total billed size ~1-1.5 TB, dominated by ohlcv-1s. Is there any per-job or
per-month export ceiling we should know about?

answer:
```

### (b) A consolidated dataset before 2023-03-28 — OPEN, and FREE to measure

`EQUS.MINI` history begins **2023-03-28** (`EQUS_MINI_HISTORY_FLOOR`,
`databento-logic.ts:80`, enforced by the manifest schema at
`databento-manifest-logic.ts:103`). The MONEY-1373 plan originally said "8 years
of OHLCV"; that is true of the **plan tier's included window** and FALSE of
**this dataset**.

`EQUS.ALL` is the only credible consolidated candidate and its range is
UNVERIFIED. **This is not a support question.** `metadata.get_dataset_range` is
free and the probe takes a `--dataset=`:

```bash
./scripts/ops/run-market-data-job.sh dbprobe qa \
  --dataset=EQUS.ALL --out=/tmp/equs-all.json
```

Without `--apply` the probe reads the range, resolves symbology, quotes, and
exits (`databento-probe.ts:254–258`). Nothing is submitted and nothing is spent.
The wrapper supplies the key, the QA database and the QA bucket
(`run-market-data-job.sh:684–703`) and forwards every other argument verbatim.

### (c) Cancel-anytime, and download-after-cancel — OPEN, support-only

This is the one that decides whether step 8 is safe. Ask:

```
Is Standard monthly and cancel-anytime? If we cancel after the harvest month, do
already-submitted batch jobs remain downloadable for their full 30 days?

answer:
```

### (d) The T+1 embargo — HALF ANSWERED, and one NEW question

**The range end sits at UTC MIDNIGHT and is EXCLUSIVE.** Measured
`2026-09-05T00:00:00Z` with Friday 2026-09-04 fully published
(`databento-append-logic.ts:104–116`). Two consequences the code now depends on:

- **Every request `end` must be `<=` the range end** or the vendor answers
  **422 `data_end_after_available_end`**. The harvest reads the range once per
  run and clamps every window to it (`databento-harvest.ts:1184`,
  `databento-manifest-logic.ts:184–188`), and logs `vendorRangeEnd=` on its
  first summary line (`databento-harvest.ts:1187`).
- **Our ET session end is 4–5 hours PAST the vendor's UTC-midnight end for the
  newest session**, so an availability test that compares the session END
  against the range end judges every newest published session unavailable. The
  append tests the **regular close (16:00 ET)** instead
  (`databento-append-logic.ts:104–122`); before that fix it would have lagged
  one session behind the vendor forever, reporting `NOT_YET_PUBLISHED`.

**STILL OPEN — the release CLOCK.** ~09:00 UTC is a 2023 roadmap comment and has
never been measured against the current API. It is measurable for free: run the
probe on a **weekday after 09:00 UTC** and read `embargoLagHours` from the
findings (`databento-probe.ts:205–208`). **2026-09-07 was Labor Day**, so a
measurement taken that day says nothing.

**NEW AND OPEN — the WINTER question.** Under EST the vendor's UTC midnight is
19:00 ET. Does a session's 19:00–20:00 ET post-market hour ship with THAT
session or the NEXT one? The regular-close test above is the conservative choice
that holds in both DST regimes, so nothing is broken either way — but the answer
decides whether the final post-market hour of a winter session arrives a day
late. Record it here when the first November append runs.

### (e) raw_symbol notation for preferreds, warrants and units — OPEN, and measurable

Share classes are Nasdaq-style (`BRK.B`) and we convert from our dash form
(`toDatabentoSymbol`, `databento-logic.ts:169`). Preferreds, warrants and units
are unconfirmed. `symbology.resolve`'s `not_found` list is the useful half of the
response and the probe takes a `--symbol=`:

```bash
./scripts/ops/run-market-data-job.sh dbprobe qa --symbol=BRK-B --out=/tmp/sym.json
```

**`end_date` is EXCLUSIVE at the vendor and must be strictly AFTER
`start_date`** — the same day for both is a **422
`data_date_range_start_on_or_after_end`**, measured on the first live call. The
probe adds one day (`databento-probe.ts:216–221`); a hand-rolled call must do the
same.

---

## 1. What is being bought — the manifest

`scripts/data/databento-manifest.json`, **version 1**, `updatedAt` 2026-09-06.
The baseline is **503 S&P constituents** plus 4 benchmarks, generated from
SSGA's own SPY holdings workbook (**as of 03-Sep-2026**) by
`scripts/data/refresh-databento-manifest.ts`, converted from the vendor's dot
form (`BRK.B`) to our master's dash form (`BRK-B`). It is a real generated list,
not a hand-typed one; regenerate it rather than editing it.

**The manifest ships INSIDE the job image.** Both jobs import it as a bundled
JSON module (`databento-harvest.ts:103`) rather than reading it from
`process.cwd()`. That is the right ownership — a job runs the manifest it was
BUILT with — and it means **editing the file changes nothing until a deploy and
a job re-pin** (Warning 2). It was previously read from disk at
`process.cwd() + "scripts/data/databento-manifest.json"`, which in the runtime
image is `/app/workers/scripts/...`; the runtime stage copies no `scripts/`
directory (`workers/Dockerfile:94–101`), so every containerised execution died
with ENOENT before quoting anything.

Seven entries, executed in `order`:

| #   | entry                   | schema       | population                                                         | range               | disposition                                      |
| --- | ----------------------- | ------------ | ------------------------------------------------------------------ | ------------------- | ------------------------------------------------ |
| 1   | `ohlcv-1m-baseline`     | `ohlcv-1m`   | 503 baseline + SPY/QQQ/DIA/IWM                                     | floor → latest      | **LOADED** into `candles` as `M1`                |
| 2   | `ohlcv-1h-master`       | `ohlcv-1h`   | every Stock+ETF in `us_instruments` (~14k, chunked ≤2,000/request) | floor → latest      | **LOADED** as `H1`                               |
| 3   | `bbo-1m-baseline`       | `bbo-1m`     | baseline + benchmarks                                              | trailing 12 mo      | ARCHIVE ONLY — feeds the cost model              |
| 4   | `definition-baseline`   | `definition` | baseline + benchmarks                                              | floor → latest      | ARCHIVE ONLY                                     |
| 5   | `statistics-benchmarks` | `statistics` | SPY/QQQ/DIA/IWM only                                               | 2025-08-01 → latest | ARCHIVE ONLY — an INSPECTION SLICE, see below    |
| 6   | `tbbo-top50`            | `tbbo`       | top 50 by weight                                                   | trailing 12 mo      | ARCHIVE ONLY — largest after #7                  |
| 7   | `ohlcv-1s-baseline`     | `ohlcv-1s`   | baseline + benchmarks                                              | floor → latest      | ARCHIVE ONLY (founder decision) — submitted LAST |

`MASTER` is not a symbol list in the file — it is a sentinel resolved at run
time from `us_instruments` (Stock+ETF; ACTIVE, or DELISTED with
`listingEndDate >= historyFloor`) and chunked at
`DATABENTO_MAX_SYMBOLS_PER_REQUEST = 2000` (`databento-logic.ts:138`), which is
**8 requests**. That chunk size is the vendor's documented per-request symbol
ceiling and has nothing to do with URL length: `metadata.get_cost` is a POST
form (`databento-client.ts:329–364`), exactly as `batch.submit_job` is sent.

> It was a GET with the symbols in the query string, and the vendor's front door
> **414s above ~8 KB of URL** — measured live 2026-09-07, 1,000 symbols (7.3 KB)
> pass and 1,500 (10.8 KB) fail. A 2,000-symbol chunk is ~14 KB, so
> `ohlcv-1h-master` could not be QUOTED and therefore could not be bought at
> all. Any byte- or URL-length-based chunking advice you remember from an
> earlier version of this file is obsolete.

**Only entries 1–3 carry `append: true`.** The nightly append keeps those three
current and never touches 4–7, which are one-time buys.

**Sizing — these are ESTIMATES, and are labelled as such because nothing has
been billed yet:**

| entry               | estimated billed size    |
| ------------------- | ------------------------ |
| `ohlcv-1m-baseline` | 10–24 GB over ~3.4 years |
| `ohlcv-1h-master`   | ~11 GB (upper bound)     |
| `bbo-1m-baseline`   | ~8 GB (12 months)        |
| `tbbo-top50`        | ~20–30 GB compressed     |
| `ohlcv-1s-baseline` | **0.7–1.3 TB**           |

The total is dominated by entry 7. That is the entire reason it is submitted
last: everything the plan is actually FOR is already downloaded before the
largest, least-read entry starts consuming the month.

---

## 2. Prerequisites (founder)

gcloud is per-command in this repo:

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud … \
  --account=founder@disdigital.in --project=stock-book-483718
```

### 2a. Databento account and key

The account exists and the key is minted. **This section used to say the $125
signup credits "are spent by the QA dry run and the probe" — that figure was
never verified and both halves of the claim are wrong.**

- **A dry run spends nothing.** `withDatabentoBudget` returns
  `{status: "dry-run"}` BEFORE `createQuotedJob` and before `submitBatchJob`
  (`databento-budget.ts:318–320`), so a disarmed or `--apply`-less run reaches
  only `metadata.get_cost` and `metadata.get_dataset_range`, which are free.
- **Only `dbprobe --apply` spends**, and it refuses above **$0.05**
  (`PROBE_MAX_USD`, `databento-harvest-logic.ts:71`) — a refusal, not a trim.

### 2b. The key in Secret Manager — ROTATION, not creation

**Both secrets already exist.** Verified 2026-09-07:

| secret                   | created (UTC)       | versions   |
| ------------------------ | ------------------- | ---------- |
| `DATABENTO_API_KEY_PROD` | 2026-09-07T16:56:13 | 1, enabled |
| `DATABENTO_API_KEY_QA`   | 2026-09-07T16:56:04 | 1, enabled |

Both grant `roles/secretmanager.secretAccessor` to
`stockbook-api@stock-book-483718.iam.gserviceaccount.com`, which is the
`--service-account` on both jobs (`setup-databento-jobs.sh:131`). Nothing to
create and nothing to grant.

A rotation is a new VERSION, never a recreate:

```bash
# 1. add the new version
printf '%s' 'db-NEWKEY' | \
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud secrets versions add DATABENTO_API_KEY_PROD \
  --data-file=- --account=founder@disdigital.in --project=stock-book-483718

# 2. disable the old one, so a job still holding it fails LOUDLY
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud secrets versions disable 1 \
  --secret=DATABENTO_API_KEY_PROD \
  --account=founder@disdigital.in --project=stock-book-483718
```

The jobs mount the reference as `:latest`
(`--set-secrets=…DATABENTO_API_KEY=${DATABENTO_SECRET}:latest`,
`setup-databento-jobs.sh:355`), which Cloud Run resolves when a task starts —
so the next execution should pick the new version up on its own. **UNVERIFIED
on these two jobs**: it has not been measured here. If an execution still fails
to authenticate after a rotation, re-run `setup-databento-jobs.sh {env}`, which
re-deploys the job and re-resolves the reference (and now preserves the arm
state, Warning 2).

### 2c. Schema FIRST, then the jobs

**Order matters, and this section used to have it backwards** — it ran the jobs
script before `--only db`.

```bash
# 1. the schema, BEFORE anything can execute
./scripts/ops/setup-infra.sh qa   --only db   # DatabentoBatchJob + the two cost-model models
./scripts/ops/setup-infra.sh prod --only db

# 2. the lifecycle rules
./scripts/ops/setup-gcs-lifecycle.sh all      # databento/ → NEARLINE at 30d, never Delete

# 3. the jobs — LAST, because they resolve their image from the live service
./scripts/ops/setup-databento-jobs.sh qa
./scripts/ops/setup-databento-jobs.sh prod
```

`db push` is what creates
`@@unique([purpose, entryId, schema, symbolsHash, start, end])`
(`schema.prisma:7257`) — the STRUCTURAL half of "a window is never bought
twice". Without that index the budget guard's idempotent lookup still runs, but
nothing stops two rows for one window; provisioning a job before the index
exists leaves it one `gcloud run jobs execute` away from spending against a
ledger that cannot refuse a duplicate.

**Provision the jobs AFTER the workers image is deployed** (Warning 2) — the
setup script resolves the image from the live service
(`setup-databento-jobs.sh:232–245`) and fails closed on an empty result rather
than silently keeping a stale pin.

**Use `setup-infra.sh --only db`, not a bare `prisma db push`**: the prod→QA
sync runs `mongorestore --drop`, which makes QA's indexes PROD's for every
synced collection, and pushing per environment through the script is what keeps
the two consistent. `databento_batch_jobs` is in the sync set.

---

## 3. QA dry run

Nothing here spends: both jobs ship disarmed and a dry run never reaches
`batch.submit_job`.

```bash
./scripts/ops/run-market-data-job.sh dbharvest qa
```

This dispatches to the Cloud Run job `databento-harvest-qa` and **waits**
(`run-market-data-job.sh:395`, `:616`). Read four things off it:

1. **`[build-provenance]` on the first line** — the commit the job is actually
   running (Warning 2).
2. **`vendorRangeEnd=`** on the `env=… step=all apply=false (DRY RUN)` line
   (`databento-harvest.ts:1187`). It is the vendor's exclusive end, at UTC
   midnight; every window this run quotes is clamped to it.
3. **Every manifest entry produced a quote.** A missing one is a
   symbol-resolution failure, not a cheap entry.
4. **`monthSpentUsd=0.00`** on the summary line, and — the important one —

```js
// EXPECT ZERO ROWS.
db.databento_batch_jobs.countDocuments({ env: "qa" });
```

**Expect exactly zero. ANY row means QA was armed.** This section used to say a
QA dry run "leaves rows in `QUOTED`" and to check that none reads `SUBMITTED`;
that was wrong in a way that inverted the test. A dry run writes **no row at
all** — the guard returns before `createQuotedJob` (`databento-budget.ts:318`)
— so a `QUOTED` row is not the expected state, it is evidence that
`DATABENTO_HARVEST_APPLY=true` reached a QA job.

`env` is stamped from `DATABENTO_ENV`, which `setup-databento-jobs.sh:345` sets
per environment (`resolveDatabentoEnv`, `databento-client.ts:151`). Both jobs
previously derived it from `NODE_ENV`, which `workers/Dockerfile:107` bakes to
`production` in BOTH images — so every QA execution stamped its rows
`env: "prod"`, putting QA's ledger in prod's budget scope. Any pre-existing row
in `databento_batch_jobs` with `env: "prod"` that you cannot account for may be
a QA run from before that fix.

### The founder probe

The probe walks ONE symbol-day end to end — range, symbology, quote, submit,
poll, download, checksum — and writes a findings JSON that answers section 0.
Its spend confirmation is **TTY-gated with no `--yes`**
(`databento-probe.ts:145–152`): a non-interactive stdin exits 1 rather than
proceeding, so a cron or a CI step cannot answer it. Running it through the
wrapper from your own terminal keeps the TTY and is fine; running it from
anything without one is refused.

**The wrapper is the right way to run it now.** It was not, and the two reasons
are worth knowing because both failed quietly:

- **It exported no `DATABENTO_API_KEY`**, so `dbprobe` died at its first request
  with `DATABENTO_API_KEY is not set` — after the operator had already waited on
  a Secret Manager round trip. It now fetches
  `DATABENTO_API_KEY_{QA,PROD}` for this job only and never echoes it
  (`run-market-data-job.sh:684–695`).
- **`REGION_BUCKET` was one constant, `stockbook-content-prod`, used for every
  environment.** So `dbprobe qa --apply` wrote its ledger row to the **QA
  database** and archived the bytes it bought into the **PROD bucket** —
  silently and successfully. The bucket now follows the env
  (`bucket_for_env`, `run-market-data-job.sh:211–222`, applied at `:700`), and
  `DATABENTO_ENV` is exported alongside it (`:702`) so the ledger row is
  stamped with the environment that ran it.

```bash
./scripts/ops/run-market-data-job.sh dbprobe qa                     # FREE
./scripts/ops/run-market-data-job.sh dbprobe qa --apply --out=/tmp/db-probe.json
```

Run it **from a terminal**: the confirmation prompt is TTY-gated and a
non-interactive stdin exits 1 rather than proceeding.

The direct invocation, if you want to name the bucket and the database
yourself:

```bash
export DATABENTO_API_KEY="$(CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud secrets versions access latest \
  --secret=DATABENTO_API_KEY_QA \
  --account=founder@disdigital.in --project=stock-book-483718)"
export DATABENTO_ENV=qa
export GCP_STORAGE_BUCKET=stockbook-content-qa
export GCP_PROJECT_ID=stock-book-483718
export DATABASE_URL="$(CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud secrets versions access latest \
  --secret=DATABASE_URL_QA \
  --account=founder@disdigital.in --project=stock-book-483718)"

# FREE: range + symbology + quote, then exit.
node --import tsx scripts/data/databento-probe.ts --out=/tmp/db-probe.json

# SPENDS, capped at $0.05, from a terminal only.
node --import tsx scripts/data/databento-probe.ts --apply --out=/tmp/db-probe.json
```

Then paste `/tmp/db-probe.json` into section 0 — `embargoLagHours`,
`datasetRange`, `symbology.notFound`, `quoteUsd`, `timeToDoneSeconds`.

Two notes on the flags:

- **`--load` NO LONGER EXISTS.** It was declared as a bare flag and read by no
  line in the file — accepted, reported as success, and doing nothing, which is
  the shape that makes an operator believe a step ran. It was removed in the
  same change that wrote this section, so `--load` now exits 1 as an unknown
  flag. The probe measures; loading is the harvest's job and has its own arm.
- The probe submits **through the ledger** with `purpose: "PROBE"`
  (`databento-probe.ts:296`), so its spend counts against the same monthly
  budget as the harvest and a second probe of the same window is reused rather
  than re-bought.

---

## 4. THE $0.00 GATE

**This section used to say "subscribe to Standard, then re-run the dry run".
The subscription is LIVE** (2026-09-07, section 0a). What survives — and what
matters every time the key or the plan changes — is the GATE.

Re-run the dry run and read the quotes:

```bash
./scripts/ops/run-market-data-job.sh dbharvest qa
```

**The included windows must quote ~$0.00.**

**If they do not, STOP.** Do not arm anything and do not submit. A non-zero
quote on an included window means the window is not covered by the plan
attached to **this key**, the month will not cover the harvest, and every entry
submitted past this point bills at usage rates against a plan you are already
paying for. Re-open the support thread with the quote in hand.

A quote of exactly $0.00 on the included entries is also the only confirmation
worth having that the subscription is live and attached to this key —
`metadata.get_cost` "respects any discounts provided by flat rate plans"
(`databento-client.ts:325`), and no billing page proves that about a key.

---

## 5. Arm, and execute ONE ENTRY PER EXECUTION, in manifest order

### 5a. Arm the harvest flag

`DATABENTO_HARVEST_APPLY` and `DATABENTO_APPEND_APPLY` ship **PRESENT and
`"false"` on the Cloud Run JOBS** — not in the cloudbuild service specs, because
**a job does not inherit the service env block**. Absent and `"false"` must never
be the same state.

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs update databento-harvest-prod \
  --region=asia-south1 \
  --update-env-vars=DATABENTO_HARVEST_APPLY=true \
  --account=founder@disdigital.in --project=stock-book-483718
```

`--update-env-vars`, per Warning 4. `--set-env-vars` here removes
`GCP_STORAGE_BUCKET` and the rest of the plain block.

`--apply` on the command line ASKS; the env flag ARMS. Both are required. An
`--apply` without the arm continues **as a dry run** and prints `ARM MISSING`
(`databento-harvest.ts:1107–1114`) — the operator still gets the quote report,
which is the useful half, and nothing is bought.

### 5b. Execute, one entry at a time, in order

One entry per execution. Not because the job cannot chain, but because each
submission is money and a per-entry execution is the only granularity at which a
wrong one can be stopped before the next. A bare `--apply` with no `--entry=`
exits 1 before any request, printing the entry ids
(`databento-harvest.ts:1122–1131`).

**The entry ids come from the DEPLOYED image, not from your working tree** — the
manifest is bundled (section 1). `jq -r '.entries[].id'
scripts/data/databento-manifest.json` tells you what the NEXT deploy will carry.

```bash
R="--region=asia-south1 --account=founder@disdigital.in --project=stock-book-483718"

# 1 — LOADED as M1.   est. 10–24 GB
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-harvest-prod $R \
  --args=--apply,--entry=ohlcv-1m-baseline

# 2 — LOADED as H1.   est. ~11 GB  (8 chunks of ≤2,000 symbols)
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-harvest-prod $R \
  --args=--apply,--entry=ohlcv-1h-master

# 3 — archive only.   est. ~8 GB
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-harvest-prod $R \
  --args=--apply,--entry=bbo-1m-baseline

# 4 — archive only.   small
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-harvest-prod $R \
  --args=--apply,--entry=definition-baseline

# 5 — archive only.   ~3 GiB. AN INSPECTION SLICE, NOT THE WHOLE SCHEMA.
#     As originally specified (baseline+benchmarks, 2024-07-01 →) this entry
#     measures 13,270,557,774 records and 790.99 GiB — 92% of the entire
#     harvest. See "What `statistics` actually costs" below before widening.
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-harvest-prod $R \
  --args=--apply,--entry=statistics-benchmarks

# 6 — archive only.   est. 20–30 GB compressed
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-harvest-prod $R \
  --args=--apply,--entry=tbbo-top50
```

**`ohlcv-1s-baseline` goes LAST, and only once every other entry reads
`DOWNLOADED` or `LOADED` in the inventory (step 6).** It is 0.7–1.3 TB, it is
archive-only by founder decision, and no strategy reads it yet. Submitting it
early puts the entries the harvest actually exists for behind a TB-scale download
inside a fixed month.

```bash
# 7 — LAST. est. 0.7–1.3 TB
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-harvest-prod $R \
  --args=--apply,--entry=ohlcv-1s-baseline
```

The other flags the harvest accepts (`databento-harvest.ts:201–206`):

| flag              | default | what it does                                                                                |
| ----------------- | ------- | ------------------------------------------------------------------------------------------- |
| `--step=`         | `all`   | one of `quote poll download load coverage all` — run one stage in isolation                 |
| `--max-wait-min=` | `600`   | how long `stepPoll` waits. Reaching it is NOT a failure; the next run resumes               |
| `--chunk=N`       | all     | 1-based: quote/submit only the Nth chunk of a chunked entry                                 |
| `--shard=i/n`     | none    | manual override of the Cloud Run task shard. **Refused with `--step=all`** — see section 10 |

There is **no `--from` / `--to`**. See section 7.

### 5c. Watch

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs executions list \
  --job=databento-harvest-prod --region=asia-south1 --limit=10 \
  --account=founder@disdigital.in --project=stock-book-483718
```

and the logs, with an explicit timestamp term (Warning 1):

```bash
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# … execute …
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud logging read \
  "resource.type=cloud_run_job
   AND resource.labels.job_name=\"databento-harvest-prod\"
   AND timestamp>=\"$SINCE\"" \
  --limit=100 --order=asc \
  --format='table(timestamp, labels."run.googleapis.com/execution_name", textPayload)' \
  --account=founder@disdigital.in --project=stock-book-483718
```

First line of every execution is `[build-provenance]`. Check it matches the
deployed commit before reading anything below it.

---

## 6. Verify

### 6a. The inventory

```js
// all seven entries, and where each one got to
db.databento_batch_jobs.aggregate([
  { $match: { env: "prod", purpose: "HARVEST" } },
  { $group: { _id: { entryId: "$entryId", state: "$state" }, n: { $sum: 1 } } },
  { $sort: { "_id.entryId": 1 } },
]);
```

Every row must read **`LOADED`** (entries 1 and 2) or **`DOWNLOADED`** (entries
3–7). The full vocabulary (`schema.prisma:7224`):

| state        | means                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------- |
| `QUOTED`     | the row was created and the process died BEFORE `batch.submit_job` returned. No vendor job exists. |
| `SUBMITTED`  | the vendor has it, queued                                                                          |
| `PROCESSING` | the vendor is materialising it                                                                     |
| `DONE`       | files exist at the vendor, un-fetched — **an expiry clock is running**                             |
| `DOWNLOADED` | every file archived and checksum-verified                                                          |
| `LOADED`     | every data file also streamed into `candles`                                                       |
| `EXPIRED`    | the vendor no longer serves the files. Only remedy: buy the range again                            |
| `FAILED`     | the submit threw; the row is marked so the next run can retry the window                           |

**`FAILED`, `EXPIRED` and `QUOTED` are the three REBUYABLE states**
(`isRebuyableState`, `databento-budget.ts:275`) — a row in any of them is
re-quoted and re-submitted by the next run rather than reused. Everything else
is treated as already bought. `QUOTED` had to be added to that list: without it
a crash between the row insert and the submit left a permanent wedge that
reported `already bought (job pending, state QUOTED)` forever, with no counter
moving.

### 6b. Coverage is a LOG LINE, not an artefact

**This section used to say per-job coverage JSONs are written under
`databento/{dataset}/{schema}/coverage/`. No such artefact exists and never
did.** An operator following that instruction finds an empty prefix and cannot
tell it from a job that has not run.

`--step=coverage` reads the `candles` collection and LOGS a summary plus the
worst ten symbols (`databento-harvest.ts:1022–1033`):

```
<entry> coverage <from>..<to> tf=M1: N symbol(s), K incomplete
  <SYM>: present/expected (pct%) missing N: 2024-01-03,2024-01-04, …
```

Three properties that decide how to read it:

- **Entries 1–2 only.** It runs only for loadable schemas
  (`databento-harvest.ts:1225`), so entries 3–7 produce no coverage line at
  all — that is by design, not a gap.
- **It is a dry run and needs NO arm** — the coverage step is outside the
  `apply` guard, and LEADER-ONLY, so an N-task execution does not report the
  same numbers N times (`databento-harvest.ts:1221`).
- **The denominator is the entry's own symbol set**, not the aggregation, so a
  symbol whose every bar was quarantined is 0% covered rather than absent.

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-harvest-prod \
  --region=asia-south1 --args=--entry=ohlcv-1m-baseline,--step=coverage --wait \
  --account=founder@disdigital.in --project=stock-book-483718
```

A count says how much arrived; the coverage line says which **sessions** are
missing, which is the question a backtest asks.

### 6c. Read `expiring=` on the summary line

The harvest's second summary line ends `pending=N expiring=N`
(`databento-harvest.ts:1253`), and every expiring row is also printed at ERROR
level naming the entry, the job id, the expiry instant and how many files are
still unverified.

**Any non-zero value names a job whose 30-day window is closing with bytes still
un-downloaded.** That is the one failure in this runbook that cannot be repaired
without spending money again.

**`stepExpiry` runs on EVERY execution, armed or not** — `if (leader) await
stepExpiry(now)` (`databento-harvest.ts:1240`). It was gated behind `apply`,
which meant the only thing watching a 30-day clock was a run that was actively
spending; once the buy finished, nothing watched it at all, and this job has no
cron by design. It is a read plus a counter, so a disarmed check-up run costs
nothing and — more importantly — emits a **ZERO** point, which is what makes the
series exist. NO DATA and "healthy" look identical in Datadog (MONEY-1278).

So `expiring=` is a legitimate thing to read off a DRY RUN:

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-harvest-prod \
  --region=asia-south1 --args=--step=quote --wait \
  --account=founder@disdigital.in --project=stock-book-483718
```

### 6d. Two spot checks — data, not counters

```js
// one Mongo session of AAPL M1 bars, with the source stamped
db.candles
  .find({ symbol: "AAPL", timeframe: "M1", source: "DATABENTO" })
  .sort({ ts: 1 })
  .limit(5);
```

Check the bars carry a **real, non-zero volume** — that is the property this
whole purchase is for, and the property a Tiingo-derived bar structurally cannot
have.

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud storage ls \
  gs://stockbook-content-prod/candles/US/M1/AAPL/ \
  --account=founder@disdigital.in --project=stock-book-483718
```

One cold shard listed means the load reached GCS and not only Mongo. (This read
`gsutil ls`. Every current ops script in this repo uses `gcloud storage` —
`sync-prod-to-qa.sh:1567` says so in as many words — and `gsutil` survives only
in the older setup docs.)

---

## 7. Optional — BBO months 13–24

Usage-based, **~$35 estimated**. Not part of the included window and not part of
the subscribed month; it extends the cost model's sample backwards.

**This step used to be a single command with `--from=` and `--to=`. The harvest
has no window override.** `--from` and `--to` are not in its flag set
(`databento-harvest.ts:201–206`) and the shared parser is fatal on an unknown
flag, so that command printed `Unknown flag "--from"` and exited 1
(`cli-args.ts:117`, `:207`) — before quoting, so nothing was bought and nothing
was lost except the belief that the step had run.

A window is a property of a MANIFEST ENTRY, so an extra window is an extra
entry. The manifest's `start` accepts an explicit `YYYY-MM-DD` and so does `end`
(`databento-manifest-logic.ts:38–47`).

**1. Add the entry** to `scripts/data/databento-manifest.json`:

```json
{
  "id": "bbo-1m-baseline-y2",
  "schema": "bbo-1m",
  "symbolSets": ["BASELINE", "BENCHMARKS"],
  "start": "2024-09-08",
  "end": "2025-09-08",
  "load": false,
  "splitSymbols": false,
  "splitDuration": "day",
  "append": false,
  "order": 8,
  "consumer": "cost-model",
  "note": "Months 13-24 of BBO for the cost model. Usage-priced, outside the included window."
}
```

`order` and `id` must both be unique across the manifest — the schema refuses
otherwise (`databento-manifest-logic.ts:89–99`). `append: false` keeps the
nightly job out of it. `load: false` is required for `bbo-1m`, which is not a
loadable schema (`databento-manifest-logic.ts:66–72`).

**2. Deploy and re-pin.** The manifest ships in the image (section 1), so the
entry does not exist for the job until the workers image carrying it is deployed
AND the job is re-pinned to it — a release does both, or
`./scripts/ops/setup-databento-jobs.sh prod` by hand (Warning 2). Confirm with
the `[build-provenance]` line on the next execution.

**3. Raise the ceiling, run the entry, lower the ceiling.** The monthly budget
guard defaults to **$25** (`DEFAULT_DATABENTO_MONTHLY_BUDGET_USD`,
`databento-budget.ts:56`; read per call), and it REFUSES rather than trimming:

```bash
R="--region=asia-south1 --account=founder@disdigital.in --project=stock-book-483718"

# raise
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs update databento-harvest-prod $R \
  --update-env-vars=DATABENTO_MONTHLY_BUDGET_USD=60

CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-harvest-prod $R \
  --args=--apply,--entry=bbo-1m-baseline-y2

# lower it back — IMMEDIATELY
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs update databento-harvest-prod $R \
  --update-env-vars=DATABENTO_MONTHLY_BUDGET_USD=25
```

Lowering it back is part of the step, not a tidy-up. A raised ceiling left in
place is a guard that no longer guards, and its only symptom is a larger invoice
a month later.

---

## 8. Before the renewal date — CANCEL

The plan is ONE month. The renewal is the deadline the whole order exists to fit
inside.

Checklist, in order:

1. **Every inventory row reads `DOWNLOADED` or `LOADED`** (step 6a). Not `DONE`,
   not `PROCESSING`. Anything unfinished must finish before the subscription
   lapses.
2. **Cancel Standard** in the Databento console.
3. **Disarm the harvest flag:**

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs update databento-harvest-prod \
  --region=asia-south1 \
  --update-env-vars=DATABENTO_HARVEST_APPLY=false \
  --account=founder@disdigital.in --project=stock-book-483718
```

There is also a script form:

```bash
./scripts/ops/setup-databento-jobs.sh prod --disarm
```

**`--disarm` resets BOTH flags** — harvest and append — to `false`
(`setup-databento-jobs.sh:267–300`). That is what you want HERE, before step 9,
and it is exactly what you do NOT want afterwards: once the append is armed
(section 9), `--disarm` silently turns the nightly job into a permanent dry run
that reports SUCCEEDED. Use the one-liner above once the append is live.

Disarming after cancelling, not before, is deliberate: a harvest execution run
after the plan lapses submits at **usage** prices, and the job cannot tell the
difference — the quote can, which is why the flag comes down rather than being
left to a human remembering the date.

Support-gate answer (c) governs what happens to jobs submitted but not yet
downloaded at cancellation. **It is still unanswered** (section 0c). Until it
comes back, treat the conservative reading as binding: every job must be fully
DOWNLOADED before step 2, not merely submitted.

---

## 9. Arm the daily append

Only after step 8. The append is the steady state: usage-based, ~$8–10/month.

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs update databento-append-prod \
  --region=asia-south1 \
  --update-env-vars=DATABENTO_APPEND_APPLY=true \
  --account=founder@disdigital.in --project=stock-book-483718

./scripts/ops/setup-scheduler.sh prod       # 15:00 IST, retry 18:00 IST, Tue–Sat
```

Both triggers are `0 15 * * 2-6` and `0 18 * * 2-6`
(`setup-scheduler.sh:312`, `:315`) and both are PROD-ONLY: QA receives `candles`
and `databento_batch_jobs` by copy and must never spend against the vendor
(`setup-scheduler.sh:1858`). The harvest gets **no trigger at all** — a cron
would be a standing authorisation to spend.

Then one **manual** execution, watched to completion, before trusting the
schedule:

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-append-prod \
  --region=asia-south1 --wait \
  --account=founder@disdigital.in --project=stock-book-483718
```

**That command works because the append's DEPLOYED DEFAULT is `--args=--apply`**
(`setup-databento-jobs.sh:428`) — Cloud Scheduler POSTs `<job>:run` with no
body, so without it an armed append would have been a permanent dry run with no
`ARM MISSING` warning either. **Any `--args=` you pass REPLACES that default**,
so a parameterised run must include `--apply` itself:

```bash
# WRONG — drops the default and runs as a dry run
--args=--entry=ohlcv-1m-baseline
# RIGHT
--args=--apply,--entry=ohlcv-1m-baseline
```

### What the first armed run should say

The append resumes **per manifest ENTRY**, not per schema — two entries can share
a schema and differ in symbol set, and a shared high-water mark would have one
entry's progress silence the other's.

**Expect `UP_TO_DATE`, or a one-session append.** This section used to say "if it
re-fetches from the floor, stop it"; that outcome is not reachable. An entry with
no high-water mark produces the named skip **`NO_HWM_RUN_HARVEST_FIRST`** and
appends nothing (`databento-append-logic.ts:39–45`), so there is no runaway to
catch — there is a skip to read.

The four reasons, all exiting 0:

| reason                     | means                                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NO_HWM_RUN_HARVEST_FIRST` | the harvest never LOADED this entry. A human decides — do not "fix" with `--from`                                                                           |
| `UP_TO_DATE`               | the healthy steady state; the 18:00 retry after a good 15:00 run reports this and spends nothing                                                            |
| `NOT_YET_PUBLISHED`        | the session exists on the calendar, the vendor has not released it. Come back later                                                                         |
| `POLL_TIMEOUT`             | the only one that follows a SPEND — submitted, not settled within `--max-wait-min` (default 45). The retry resumes from the inventory; nothing is re-bought |

**Only the first three reach the `[job-outcome]` line.** `skippedReason` is
populated only when `sessionsPlanned === 0`
(`databento-append.ts:975–978`) — reporting a skip beside real work would make a
partially-skipped run look like a fully-skipped one. `POLL_TIMEOUT` is set
_after_ the sessions were planned and submitted, so under the old
`sessionsPlanned === 0` gate it could never satisfy that condition. **FIXED in
the same change that wrote this section**: the gate is now `rowsWritten === 0`,
so a run that submitted, waited out `--max-wait-min` and wrote nothing reports
`skippedReason=POLL_TIMEOUT` on its outcome — while a run that landed real work
alongside one timed-out entry still reports no reason at all. The log line
(`<entry>: no job settled within --max-wait-min=…`) carries it either way.

`--from=YYYY-MM-DD` is REFUSED on an entry that already holds sessions
(`databento-append.ts:334–346`) rather than quietly ignored. It is for an entry
with no mark at all.

### The Datadog monitors

**These no longer wait on anything.** `DD_APP_KEY_PROD` exists (created
2026-09-06) and `apply-monitors.sh prod` works today; the caveat this section
carried about MONEY-1229 is obsolete. The script does not read the secrets
itself, deliberately — export them first, so a laptop and a CI runner take the
same path:

```bash
export DD_API_KEY="$(CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud secrets versions access latest \
  --secret=DD_API_KEY_PROD --account=founder@disdigital.in --project=stock-book-483718)"
export DD_APP_KEY="$(CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud secrets versions access latest \
  --secret=DD_APP_KEY_PROD --account=founder@disdigital.in --project=stock-book-483718)"

./scripts/ops/datadog/apply-monitors.sh prod --dry-run
./scripts/ops/datadog/apply-monitors.sh prod
```

Three of them cover this job: a zero-write monitor and a job-absence monitor on
`databento-append` (7d and 96h windows, sized for Tue–Sat with the Sat→Tue gap),
and the `stockbook.databento.displaced_d1` tripwire whose healthy reading is a
permanent ZERO (`apply-monitors.sh:424`, `:832`, `:526`).

---

## 9b. Re-buying an entry that was bought in the WRONG SPLIT SHAPE

MEASURED 2026-09-08 on the first real harvest, and the reason this section
exists. `ohlcv-1m-baseline` was submitted with `split_symbols=false,
split_duration=day` — the vendor confirmed receiving exactly that — because the
harvest built its request without the manifest's `splitSymbols` /
`splitDuration`. The manifest said `true` / `"year"` and reached nothing.

It is not cosmetic. The loader is sized for one file being ONE SYMBOL-YEAR:
`DEFAULT_MAX_BUFFERED_ROWS_PER_SYMBOL` is 120,000 because a symbol-year of M1
is 98,280 rows, so the buffer flushes once and writes ONE cold shard. Daily
files carrying every symbol flush 507 buffers per file into shards that grow
all year:

|                                  | daily files (wrong) | symbol-year files (right) |
| -------------------------------- | ------------------- | ------------------------- |
| `ohlcv-1m-baseline` shard writes | 439,569             | 2,028                     |
| `ohlcv-1h-master` shard writes   | 12,185,685          | 56,220                    |

Observed: 92 s for the first file, 358 s by file 124, rising ~2.1 s per file —
an extrapolated 78 h against the job's 24 h task cap.

**The ledger cannot tell the two apart.** The unique key is
`(purpose, entryId, schema, symbolsHash, start, end)`; the split shape is not
in it, and a `DOWNLOADED` row is not in `isRebuyableState`. So the wrongly
shaped job would be REUSED forever. Correcting it is deliberate, and it is a
hand step precisely because an automatic re-buy on a shape mismatch is a
machine that spends money when a manifest field changes.

### The recipe

1. **Confirm the shape actually differs**, from the vendor rather than from the
   manifest:

   ```bash
   # states=done; find the job id on the ledger row first
   curl -s -u "$DATABENTO_API_KEY:" \
     'https://hist.databento.com/v0/batch.list_jobs?states=done' \
     | jq '.[] | select(.id=="<jobId>") | {split_symbols, split_duration}'
   ```

2. **DELETE the ledger row.** Not `state: FAILED` — that leaves the old job's
   `files[]` in place and `stepDownload` would re-fetch the wrong objects.

   ```js
   db.databento_batch_jobs.deleteOne({
     env: "prod",
     purpose: "HARVEST",
     entryId: "ohlcv-1m-baseline",
   });
   ```

3. **Leave the archived bytes.** They are paid for, the lifecycle never deletes
   under `databento/`, and the new job writes under a DIFFERENT `{jobId}/`
   prefix, so nothing collides. Re-buying the same window quotes **$0.00** — it
   is the same window inside the same subscription.

4. **Re-run the entry.** `stepQuote` finds no row, quotes, and submits with the
   corrected split.

5. **Rows already loaded are not a problem.** The new load rewrites the same
   sessions from the same `source: DATABENTO`, which `decideSessionWrite`
   answers "same source" — an overwrite, not a displacement. A part-year cold
   shard written by the old load is replaced by the complete symbol-year shard.

### Deciding `year` against `none`

Both give ONE shard write per symbol-year, because the loader flushes on a year
change as well as at end of stream. They differ only in file count:

| `split_duration` | `ohlcv-1m-baseline` files | `ohlcv-1h-master` files |
| ---------------- | ------------------------- | ----------------------- |
| `"year"`         | 2,028                     | 56,220                  |
| `"none"`         | 507                       | 14,055                  |

`"none"` is a quarter of the downloads for the same shard writes.

**The manifest ships `"year"`, and the reason is the LOAD ORDER rather than the
shard cost.** `stepLoad` sorts newest-first off the session date in the vendor's
filename, because a harvest is a backfill of years that can be interrupted and
the recent end is the half worth having. A `"none"` file spans the entire
history and carries no date to sort on, so every file ties and an interrupted
run survives holding an arbitrary slice. Since `stepDownload` became a
bounded-concurrency pool the file count is no longer the binding constraint —
56,220 files at 8 in flight is ~2.9 h — so there is nothing left to buy with
that trade.

## 9c. What `statistics` actually costs

Measured 2026-09-08 with `metadata.get_record_count` and
`metadata.get_billable_size` (both free, neither submits anything):

| specification                                  | records        | billable   |
| ---------------------------------------------- | -------------- | ---------- |
| baseline + benchmarks, 2024-07-01 → (as filed) | 13,270,557,774 | 790.99 GiB |
| TOP50, trailing 12 mo                          | 2,810,692,777  | 167.53 GiB |
| AAPL alone, one month                          | 13,055,834     |            |
| **benchmarks only, one month (what ships)**    | ~52,000,000    | ~3 GiB     |

The entry described itself as "halts, auctions and session statistics" and was
the smallest line in the manifest. It is 92% of the whole harvest — larger than
every other entry combined — and it has `load: false` and no `consumer`.

Narrowing the symbol set does not rescue it: the volume is concentrated in
exactly the busiest names, so TOP50 over twelve months is still 167 GiB. At
~2.2 million records per symbol per trading day this is not a halt-and-auction
feed under any reading, so the schema is not the thing the note described.

The manifest therefore ships an inspection slice — four benchmark ETFs, one
recent month. Download it, look at what the rows actually are, then widen
deliberately with the table above in hand. Widening is one manifest edit.

## 10. Rollback, and why a bad load is not a re-purchase

Disarm the relevant flag and stop:

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs update databento-harvest-prod \
  --region=asia-south1 --update-env-vars=DATABENTO_HARVEST_APPLY=false \
  --account=founder@disdigital.in --project=stock-book-483718
```

**The archive is NEVER deleted.** `databento/**` carries a Nearline transition at
30 days and **no Delete rule at all**, and `databento/` is on
`setup-gcs-lifecycle.sh`'s `PROTECTED_ROOTS` as a second, independent refusal on
top of the allow-list.

That is the property the entire archive-first design exists for: **a bad load is
re-run from the archived bytes, not re-bought.** No vendor request, no
subscription needed, no second purchase.

### Re-loading an entry — FOUR steps, and two of them are not optional

**This step used to be "disarm, then re-run `--step=load`". Both halves were
wrong, and the result was a command that exits 0 having loaded nothing.**

- A **disarmed** run is a dry run. `stepLoad` is behind `if (apply && …)`
  (`databento-harvest.ts:1217`), so it never executes; the run prints
  `ARM MISSING`, writes nothing, and exits 0.
- `stepLoad` selects rows in **`["DOWNLOADED", "DONE"]`**
  (`databento-harvest.ts:752`). A row that already loaded is in `LOADED` and is
  not selected at all.
- **And flipping the row state back is still not enough.** The per-file filter
  skips any record with `loadedAt` already set (`databento-harvest.ts:771`), so
  a row moved to `DOWNLOADED` with its files still stamped yields
  `pending.length === 0` and `continue`s — silently. `loadedAt` is written per
  file by `stampFileLoaded` (`databento-repo.ts:718–722`).

```bash
# 1. RE-ARM. A disarmed run cannot load.
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs update databento-harvest-prod \
  --region=asia-south1 --update-env-vars=DATABENTO_HARVEST_APPLY=true \
  --account=founder@disdigital.in --project=stock-book-483718
```

```js
// 2. Reopen the rows AND clear the per-file load stamps.
db.databento_batch_jobs.updateMany(
  {
    env: "prod",
    purpose: "HARVEST",
    entryId: "ohlcv-1m-baseline",
    state: "LOADED",
  },
  {
    $set: { state: "DOWNLOADED" },
    $unset: { "files.$[].loadedAt": "" },
  },
);
```

`DOWNLOADED` and not `DONE`: `stepDownload` selects `state: "DONE"` only
(`databento-harvest.ts:606`), so nothing is re-fetched from the vendor and every
`files[].verified` flag survives. The `$unset` is what makes the re-load
actually happen.

```bash
# 3. Load, from the archive. No vendor request.
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-harvest-prod \
  --region=asia-south1 --args=--apply,--entry=ohlcv-1m-baseline,--step=load --wait \
  --account=founder@disdigital.in --project=stock-book-483718

# 4. DISARM again.
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs update databento-harvest-prod \
  --region=asia-south1 --update-env-vars=DATABENTO_HARVEST_APPLY=false \
  --account=founder@disdigital.in --project=stock-book-483718
```

The job stamps each file atomically and re-reads the row afterwards, so it
returns to `LOADED` on its own once every data file is loaded
(`advanceJobStateIfComplete`, `databento-repo.ts:764–804`).

### Sharding a re-load

`--step=load` is the ONLY partitionable stage — the unit is a FILE, and
`shardOwns` hashes the filename (`databento-harvest-logic.ts:182`). Cloud Run
sets `CLOUD_RUN_TASK_INDEX` / `CLOUD_RUN_TASK_COUNT`, which `resolveShard` reads
(`databento-harvest-logic.ts:117–169`), so `--tasks=N` on the execution shards
the load:

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-harvest-prod \
  --region=asia-south1 --tasks=4 \
  --args=--apply,--entry=ohlcv-1m-baseline,--step=load \
  --account=founder@disdigital.in --project=stock-book-483718
```

**`--tasks=N` is REFUSED with `--step=all`** — the job throws before any request
(`databento-harvest.ts:1173–1180`):

```
sharding applies to --step=load only; run the download on one task, then the
load on N. With --step=all the non-leader tasks reach the load before the
leader has downloaded anything and exit 0 having done nothing.
```

Quote, poll and download are LEADER-ONLY by construction, so under
`--tasks=4 --step=all` tasks 1–3 skip straight to `stepLoad`, find nothing
downloaded yet, and report a clean empty success. That is the difference between
"the sharding did nothing" and "the sharding looked like it worked". Remember
the memory ceiling is PER SLOT as well: four tasks each sized against the whole
4Gi container reproduce the OOM the sizing exists to prevent. Pass `--tasks`
only with `--step=load`.

### `ohlcv-1h-master` takes TWO executions, and `--step` does not chain

**`--step` runs ONE stage, not a prefix.** `wants()` is
`STEP === "all" || STEP === step` (`databento-harvest.ts:358–360`), so
`--step=download` runs `stepDownload` and nothing else — it does **not** quote,
submit or poll first. There is no spelling that means "everything up to the
download", and making `wants()` a prefix would be worse than the gap it closes:
`--step=download` would then reach `stepQuote`, which SUBMITS, so a step named
after a fetch would spend money; and `--step=load --tasks=4` would let the
non-leader tasks run ahead of a download that had not happened, which is
precisely the failure the `--step=all` sharding guard exists to refuse.

So exec A is `--step=all` — the same thing the bare section 5b line does — and
exec B is the sharded load:

```bash
R="--region=asia-south1 --account=founder@disdigital.in --project=stock-book-483718"

# exec A — quote+submit, poll, download. ONE task. It will go on to load
# serially; that is fine and it is not wasted work (see below).
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-harvest-prod $R \
  --args=--apply,--entry=ohlcv-1h-master,--step=all --wait

# exec B — the load, sharded four ways.
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs execute databento-harvest-prod $R \
  --args=--apply,--entry=ohlcv-1h-master,--step=load --tasks=4 --wait
```

**Why two executions rather than one.** For this entry the stages add up to more
than the 24 h task cap: submit, then a poll that waits up to `--max-wait-min=600`
(10 h), then 56,220 files at 8 in flight ≈ **2.9 h** of download, then a load
measured at **~8 h**. One `--step=all` execution can therefore be killed by the
cap part-way through the load. **And `--tasks` cannot rescue it in the same
execution** — `--tasks=N` with `--step=all` throws before any request
(`databento-harvest.ts:1173–1180`), because quote, poll and download are
leader-only, so tasks 1–3 would reach `stepLoad` before anything was downloaded
and exit 0 having done nothing.

Nothing exec A does is thrown away. Every file is stamped `verified` as it lands
and `loadedAt` as it loads (`stampFileVerified` / `stampFileLoaded`), so exec B
picks up exactly the remainder — whether exec A finished the download and was
cancelled by hand, or the cap killed it mid-load. **Watch for the
`files considered=… downloaded=…` line**; once it stops moving the download is
done and exec A can be cancelled rather than left to grind through the load on
one task:

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs executions cancel <execution> $R
```

If the entry has **already** been submitted and polled to `DONE` on an earlier
execution, exec A can be narrowed to `--step=download` — that is the one case
where the isolated step is the right one, because the stages it skips have
already run.

### Why the bytes are kept

Every entry is downloaded and verified **before** it is parsed, and the raw file
is kept afterwards, precisely so that a parser found wrong six months from now
costs a re-run instead of another $199 month that may no longer include the same
window.

Deleting anything under `databento/` converts every future re-derivation into a
re-purchase. There is no operational reason to do it and the lifecycle refuses it
twice.
