# Doc-ingest runbook — MONEY-1314

The order below is not a suggestion. Two steps are one-way doors and three
gates exist to stop the drain before it spends money on a wrong answer.

Every command is `--dry-run` by default. `--apply` must be passed explicitly
and is FORWARDED rather than swallowed — a prior job in this repo read 41,924
rows, wrote nothing and exited 0 because a wrapper ate the flag, so every run
prints its own apply state in the summary line.

gcloud is per-command in this repo:

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud … \
  --account=founder@disdigital.in --project=stock-book-483718
```

---

## 0. Preconditions

| Check                                                   | Why it is a precondition                                                                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the branch is merged and `stockbook-workers` redeployed | Cloud Run JOBS pin their image at PROVISION time; the setup script resolves the image from the LIVE service, so provisioning before the deploy pins the old one |
| `doc-ingest-backfill` is in `workers/tsup.config.ts`    | without it the job dies instantly with "Cannot find module /app/dist/doc-ingest-backfill.js". The setup script REFUSES to provision rather than warn            |
| `DOC_PARSE_MODEL=gemini-3.7-flash` live on the service  | absent, the lane silently runs `gemini-3.5-flash` at 4x the batch rate with a log line as the only symptom                                                      |
| the four parse crons are GONE from the live scheduler   | measured, not assumed — see step 1                                                                                                                              |

### 0a. Push the schema FIRST

Seven new `stock_documents` fields and one compound index
(`@@index([convertStatus, fetchedAt])`). Mongo creates a field on write, but
NOT an index — without the push, `buildConvertQuery` does a COLLSCAN over
79,884 rows on every page of the backfill.

```bash
./scripts/ops/setup-infra.sh prod --only db
./scripts/ops/setup-infra.sh qa   --only db
```

Use `setup-infra.sh`, not a bare `prisma db push`: the prod->QA sync runs
`mongorestore --drop`, which makes QA's indexes PROD's for every synced
collection, and the QA-DIRECT set is exempt from that. Pushing per environment
through the script is what keeps the two consistent.

⚠️ **A `db push` creates INDEXES, never FIELDS.** All ~79,884 pre-existing rows
carry no `convertStatus` attribute at all, so `{ convertStatus: "PENDING" }`
matches ZERO of them and `@default` does not help — it applies only to rows
Prisma itself creates. Every selector over these fields carries an
`{ isSet: false }` arm for that reason
(`workers/src/processors/doc-ingest-selectors-logic.ts`), and
`doc-ingest-isset-arms.test.ts` asserts they are still there. If a backfill run
reports `selected: 0` against a corpus you know is full, that arm is the first
thing to check — the class has caused MONEY-1050, 1205, 1234 and 1236.

### 0b. Provision the job

```bash
./scripts/ops/setup-doc-ingest-backfill-job.sh prod   # 8Gi, 2 vCPU, 4 tasks
```

---

## 0c. MANUAL — delete the orphaned `stock-document-parse` monitor

⚠️ **`apply-monitors.sh` has no DELETE path.** Its loop is strictly
create-or-update: an `EXISTING_ID` lookup, then PUT when found and POST when
not. There is no prune step for a job dropped from `MONITORED_JOBS`, so
removing the row from that array does NOT remove the monitor from Datadog.

The `stock-document-parse` monitor has existed since MONEY-1255 and this branch
deletes all four of its crons in the same deploy. The `job:stock-document-parse`
series therefore stops emitting; the template ships `notify_no_data: true` with
`no_data_timeframe = window x 3 = 6,480 min`, so **~4.5 days after the deploy it
pages the founder and never recovers.** Re-running `apply-monitors.sh` cannot
clear it.

```bash
# find it
curl -s -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  "https://api.datadoghq.com/api/v1/monitor/search?query=stock-document-parse" \
  | jq -r '.monitors[] | "\(.id)  \(.name)"'

# then, per id
curl -s -X DELETE -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  "https://api.datadoghq.com/api/v1/monitor/<id>"
```

Do this for BOTH environments. It is listed as a manual step rather than
automated because a prune loop that mis-parses `MONITORED_JOBS` deletes every
monitor the founder has, and that failure is worse than the one it prevents —
`apply-monitors.sh` already fails closed on a similar parse for
`PROD_ONLY_JOBS`, but a delete has no such safe direction.

## 1. GATE — confirm the parse crons actually retired

`OLD_SCHEDULER_PREFIXES` deletes `${NAME}-${ENV}` by EXACT name. Removing a
`SCHEDULER_DEFS` row alone does nothing to a live job.

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud scheduler jobs list \
  --location=asia-south1 --account=founder@disdigital.in \
  --project=stock-book-483718 | grep stock-document
```

**Expected after `setup-scheduler.sh prod` and `qa`:** no
`stock-document-parse-*` rows in either env. `stock-document-sync-*` and
`stock-document-extract-daily` remain — different lanes, untouched.

⚠️ The parse ROUTE stays deployed on purpose. The old lane self-chains up to 20
links, so messages may be in flight for ~3h20m after the last cron. Do not
delete the route until `stock-document-parse` stops appearing in the logs.

---

## 2. `scan-convert` — the sidecars

309.8 GB of GCS reads across 72,650 objects. Egress inside the project is free;
time is the constraint. The `scannedPageCount` stamp IS the cursor, so a
re-run resumes with an index seek rather than re-reading finished work.

```bash
# a small real run first — 200 documents, writes nothing
… jobs execute doc-ingest-backfill-prod --args="scan-convert,--limit=200"
# then for real
… jobs execute doc-ingest-backfill-prod --args="scan-convert,--apply,--budget-sec=82800"
```

**Read from the summary:** `selected` beside `remaining`. Those two are what
separate "the queue is drained" from "the selector is broken" — both otherwise
print zero.

**FOUR TASKS RUN IN PARALLEL — MONEY-1339.** The job is provisioned
`--tasks=4 --parallelism=4`, and each task shards the corpus by the FIRST
CHARACTER of `symbol`, dealt round-robin (`buildShardWhere`). Cloud Run sets
`CLOUD_RUN_TASK_INDEX` / `CLOUD_RUN_TASK_COUNT` on every task and the job reads
them itself — which is the only way this is expressible, because
`gcloud run jobs execute` passes ONE argument list to every task.

Four tasks x four documents in flight = up to 16 conversions at once. Measured
serial rate is 1.6 s/document (13,570 in a 6 h run), so the remaining ~48,000
documents drop from ~21 h to roughly 1.5-3 h.

A SHARDED RUN DOES NOT SELF-CHAIN, deliberately: the chain posts one
`jobs:run` with a container override and an override carries no task index, so
each task's follow-up would re-run the whole fan-out. Give the tasks a budget
that lets them finish inside the 24 h task timeout (`--budget-sec=82800`)
instead. `--tasks=1` restores the old chaining behaviour.

**THE SIDECARS ALSO FEED THE RAG-TEXT LANE NOW — MONEY-1347.**
`stock-document-extract` reads `${gcsPath}.md` directly when the conversion
produced a complete one, so a document converted here costs that lane zero
Document AI calls and zero pdf-parse. Its outcome line carries
`viaSidecar / viaDocumentAi / viaPdfParse / noText / notAttempted`, which sum
to `selected`. `docaiDegraded` is reported BESIDE that partition, not inside
it — it counts CALLS, and a degraded call is already counted by whatever
produced the text instead.

**Read `remaining` PER TASK.** Four summary lines are printed, one per shard,
and each names its own `shard=i/4`. One task finishing while another still has
work is normal — the shards are not perfectly balanced.

**Expected split**, measured on prod 2026-09-05 across the whole archive. The
~63% / ~32% / ~5% this used to print came from a 30-document sample (n=19 on the
eligible docTypes) and was superseded twice; it is gone rather than annotated,
because a reader who stops at the code block has to get the right number.

```
CONVERTED                          32,893
never selected (attribute ABSENT)  39,291
PENDING (arrived since 09-01)       8,801
SCANNED_ONLY                        1,196   -> the vision lane
FAILED                                155
-> UNCONVERTED                     48,092
```

**There is no useful `CONVERTED`-share threshold, and the one that used to be
here could never fire.** It read "a CONVERTED share far below 60% means the
converter is degrading", sized against the ~63% sample; the real share of
_attempted_ documents is ~83%, so the check sat 23 points below the value it was
watching and no degradation short of total collapse would have tripped it. An
alarm that cannot fire is worse than none, because it is read as evidence.

Judge the converter on `doc-convert-decision.md` §4 and on the per-shard
`remaining` counts instead, and read the paragraph below for why a HIGH
`CONVERTED` share is not the good news it looks like.

> **`CONVERTED` IS NOT "READABLE" — MONEY-1334.** `assessExtraction` marks a
> document CONVERTED when
> `textPageCount > 0` — ONE text page — and **28,134 of the 32,893 (85.5%)
> contain image pages the sidecar never renders**. BONLON FY2025's sidecar
> spans pages 1-156 with 92-135 absent: 45 pages, exactly its
> `scannedPageCount`, and exactly the financial statements.
>
> So a high CONVERTED share does not mean the corpus is readable, which is the
> second reason no share threshold belongs above: the quantity is not measuring
> what a reader assumes it measures. The number that
> matters is `sidecarPageIncomplete` in the batch-build tally — documents routed
> to vision because too much of the page set produced no text. Expect roughly
> **15%** at the shipped 20% threshold (5,003 of 32,893); a number far from that
> means the threshold needs re-deriving, not that the drain is broken.

---

## 3. GATE — the 200-document pilot

**This is the step that decides whether the drain runs at all.**

```bash
… --args="batch-build,--pilot-from-parsed=200,--pilot-max-per-symbol=2,--out=gs://…/pilot.jsonl"
… --args="batch-submit,--file=gs://…/pilot.jsonl,--apply"
# when the batch reports SUCCEEDED:
… --args="batch-ingest,--batch-job=<name>,--compare,--report=gs://…/pilot-report.json"
```

**Read `symbols=` in the run note.** The documents are dealt across companies,
at most two each, because the 2026-09-02 pilot drew 25 from SIX and its rates
were a property of those six (MONEY-1344). A 200-document pilot should report
~100 symbols; far fewer means the extract population itself is concentrated and
the pilot cannot speak for the corpus.

`--pilot-from-parsed` selects documents that ALREADY have a successful parse,
so the pilot's answers can be compared against a known baseline.

`--compare` writes a report INSTEAD of upserting, and `--compare --apply` is an
argument error — an upsert destroys the baseline the comparison is measured
against.

**Judge on:** agreement rate against the incumbent extracts, the
FAILED_VALIDATION rate, and `cachedTokens`. A steady zero for `cachedTokens`
across 200 documents means implicit caching never engaged and the drain will
cost ~2.4x the estimate — the requests succeed identically either way, so this
is the only place that number is visible before the bill.

Do not proceed on a pilot that disagrees materially with the incumbent. The
question to answer first is which one is right.

---

## 4. The bake-off (optional, same pilot set)

Re-run step 3's `batch-build`/`submit`/`ingest --compare` with
`--model=gemini-2.5-flash` and compare the two reports. `--disable-thinking`
is the third arm: measured, `thinkingBudget: 0` removes thinking entirely and
cuts total tokens 32%, but thinking may be carrying accuracy on dense
statements. That is why it is not the default — the pilot decides, not a guess.

---

## 5. The drain

**THE DRAIN IS WAVES — MONEY-1345.** ~50,800 documents do not fit one
submission, so `batch-build` writes `out-000.jsonl`, `out-001.jsonl`, … at
`--max-lines` (20,000) and `--max-bytes` (900 MB) and prints a MANIFEST line
carrying the exact `--files=` argument for the next step. Submit the wave with
`batch-submit --files=a,b,c`: it goes sequentially and STOPS at the first
failure, naming the files it did not submit — an enqueued-token refusal applies
to the next file too, and continuing would spend the wave against the same
wall. `batch-ingest --batch-jobs=j1,j2` does the reverse and does NOT stop:
each job's results are already paid for, and one unreadable job must not strand
the rest.

⚠️ **Re-read the vendor's live per-job limits before the tail waves** and set
`--max-lines` / `--max-bytes` from them. The shipped defaults are a starting
point, not a measurement — this repo's own EOD parser swapped open and close
for two years because a shape was taken from documentation rather than probed.

```bash
… --args="batch-build,--apply"
… --args="batch-submit,--file=…,--apply"
… --args="batch-ingest,--batch-job=<name>,--apply"
```

Wave size follows the account's enqueued-token allowance, which is discovered
by submission rather than from a published table.

**Budget:** measured at **$426** against a founder ceiling of **$1,000** —
input $192, output $200, and $35 of markdown calls wasted on documents that
then fail over to vision. Output is 47% of spend.

⚠️ The batch rate is PROMOTIONAL and input doubles on **1 Jan 2027**. That is a
reason to finish promptly, not to re-plan.

---

## 6. `sweep`

Re-runs `FAILED_BATCH` and `FAILED_VALIDATION` rows through the ONLINE path,
where `decideIngestLane` picks markdown or vision per document. A gate failure
earns exactly ONE vision retry; a second is terminal, because a deterministic
failure marked retryable puts the same document into every later pass forever.

**It also re-opens STALE IN-FLIGHT CLAIMS — MONEY-1341.** `BATCHED` and
`PROCESSING` are claims, not answers, and nothing checked whether the claimant
still existed. Measured 2026-09-05: 22 rows stamped BATCHED by the two
compare-mode pilot batches (`--compare` grades a batch and deliberately writes
nothing, so it never releases the status `batch-submit` stamped on the way in)
and 2 stamped PROCESSING since 09-01. No query selected either.

Both are admitted once stale, on DIFFERENT fuses because the claims differ: a
batch legitimately runs for many hours (there is no SLA) so 48h, while a
PROCESSING document is one online call inside a 600s ack deadline so 6h. The
age term is the whole guard — without it the sweep would re-run every document
a batch is CURRENTLY carrying, paying twice and letting the batch's own ingest
overwrite the sweep's answer with the older one.

**A NON-INR document is UNSUPPORTED and is NOT swept — MONEY-1348.** Every
figure here is normalised to crore and the table has no currency column, so
vision would read the same dollars at ~3x the input tokens. Expect
`nonInrCurrency: 0` on this corpus (`stock_documents` is 100% NSE/BSE,
measured); a non-zero count means a document arrived from somewhere new and is
worth looking at rather than fixing.

**A rejection now names its RULE.** `validationReasons` is a column
(MONEY-1340), so `db.document_financial_extracts.count({status:
"FAILED_VALIDATION", validationReasons: "UNKNOWN_SCALE"})` answers directly
instead of needing an aggregation over nested JSON. Run
`scripts/data/backfill-extract-validation-columns.ts` once per environment to
fill the pre-existing rows; it calls no model.

---

## 7. ONE-WAY DOOR — arming realtime

`DOC_INGEST_REALTIME="true"` makes the five `stock_documents` writers announce
every new PDF. Do this only after the drain, or the realtime lane and the
backfill compete for the same rows.

**In the same change**, add the freshness monitor. It is deliberately absent
today: a monitor on a disarmed lane is guaranteed NO DATA, and a monitor that
has never been green is a monitor somebody mutes. The emit site already exists
(`reportJobOutcome({ job: "stock-document-ingest" })`, on every exit path
including not-found), so the row is a one-line addition to `MONITORED_JOBS`.

QA has **no writer** for `document_financial_extracts` until this is armed
there, and the collection cannot be mirrored — `instrumentId` is a REQUIRED
relation to QA-DIRECT `instrument_mappings`, so copied rows would dangle and
throw. This is recorded as a tracked gap in `prod-only-sync-coverage.test.ts`,
not as an exemption.

---

## What is NOT in scope here

`DOC_FINANCIALS_APPLY` — the projection of these readings into
`stock_financials` — stays off. That table's unique key has no `source`, so the
first write ERASES the incumbent and there is nothing left to reconcile
against. This lane writes only `document_financial_extracts`, whose key carries
`documentId` and `basis` and whose rows are reproducible by re-running the same
(model, prompt) pair.
