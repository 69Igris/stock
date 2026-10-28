# XBRL switchover — the as-run sequence (MONEY-1220 / MONEY-1234 / MONEY-1235)

The one-way door in P10, and the order in which it actually has to be opened.

This file used to be a 13-step post-merge activation checklist. It predated
everything found in the MONEY-1234/MONEY-1235 week — that the projection selected
0 of 90,188 filings, that it could never CREATE, that CREATE-suppressed filings
were being stamped as decided, and that the Cloud Run JOBS had been running a
stale image through four consecutive releases. The checklist was not wrong so
much as aimed at a system that did not exist yet. What follows is the sequence
as it must now be run, with the operational traps that cost this cycle the most
time written down FIRST, because two of them produced confident wrong answers
rather than errors.

---

## Why this is gated at all

`StockFinancials` is `@@unique([symbol, exchange, statementType, periodType,
period])` — **there is no `source` in the key**. Two sources describing one
period are ONE row. The moment the projection writer applies, the incumbent
value for that period is gone and there is nothing left to reconcile against.

The evidence has to be gathered BEFORE the first write or it cannot be gathered
at all. That is why `apply` defaults to false, why `createMissing` defaults to
false, and why arming is one deliberate act on one environment variable rather
than a code default anybody can flip.

---

## OPERATIONAL WARNINGS — read before running anything

### 1. `gcloud logging read --freshness` does NOT bound the query

**Measured this cycle, twice.** A `--freshness=10m` read returned lines written
**11 hours** earlier. A confirming `--freshness=60m` read returned an **11-hour
span**. The flag does not do what its name says here, and it fails in the
direction that produces a confident wrong conclusion rather than an empty
result.

The concrete damage: a wait-loop polling for a `[job-outcome]` line matched a
PRE-EXISTING entry the instant it started, so the manual trigger's own output
was never observed at all. The run that was actually read had executed on the
PRE-FIX revision. The reported verdict was "the fix did not work" — stated with
confidence, entirely wrong, and the logs "supported" it.

**Always put an explicit `timestamp>=` term in the filter, and always assert on
the revision.** Copy-pasteable:

```bash
# note the ISO instant — capture it BEFORE you trigger anything
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud logging read \
  "resource.type=cloud_run_revision
   AND resource.labels.service_name=\"stockbook-workers-prod\"
   AND textPayload:\"job-outcome\"
   AND timestamp>=\"$SINCE\"" \
  --limit=20 --order=asc \
  --format='table(timestamp, resource.labels.revision_name, textPayload)' \
  --account=founder@disdigital.in --project=stock-book-483718
```

Read `revision_name` on every line before believing any of them. A run on the
previous revision is not evidence about this one, and the two are
indistinguishable in `textPayload` alone. For a Cloud Run JOB the same rule
applies with `resource.type=cloud_run_job AND resource.labels.job_name="…"`,
asserting on `labels."run.googleapis.com/execution_name"` instead of the
revision.

### 2. Cloud Run JOBS pin their image at provision time

A SERVICE deploy does not move them. `gcloud run services replace` updates the
service and nothing else; a job keeps executing whatever tag it was created
with, forever, until somebody re-runs a setup script.

All four of `feed-parse-prod`, `fo-summary-prod`, `feed-backfill-prod` and
`xbrl-backfill-prod` drifted across **all four releases** of this cycle and were
re-pinned by hand every time. On 2026-08-18 `feed-parse-prod` was four days
behind: it ran nightly, exited 0, reported `SUCCEEDED_COUNT 1`, and silently
skipped four bond feed families it had never heard of — `bond_master` and
`bond_eod` sat at 0 rows (MONEY-1210 / MONEY-1205; MONEY-1189 was the same class
one ticket earlier).

`workers/cloudbuild.{prod,qa}.yaml` now carry a final step that re-pins **every
job on the workers image** after the service deploy, touching **only** `--image`.

**The list is TWELVE as of MONEY-1317, and that count is derived, not asserted.**
It read "eight" — and before that, four — and each number was a claim nobody
could fail a build on. It is now the set of entry points in
`workers/tsup.config.ts` that bundle a script, checked by
`packages/core/__tests__/ops/job-build-provenance.test.ts` against BOTH loops,
with an exemption map that is empty. Adding a tsup entry without touching the
loops now goes red.

Four were missing when that check was written, and all four were real,
provisioned Cloud Run jobs on this image: `bse-backfill`, `tiingo-us-backfill`,
`tiingo-us-corp-actions-backfill` and `tiingo-us-news-seed` (deployed state,
2026-09-02: `bse-backfill-prod`, `tiingo-us-eod-backfill-prod`,
`tiingo-us-corp-actions-backfill-prod`, `tiingo-us-news-seed-prod`). Their only
written exclusion was a test comment saying "24h+ one-shots", which does not
separate them from `feed-backfill` and `feed-repair` — also `--task-timeout=86400`,
also one-shots, also hand-provisioned, and both in the loop.

**Note one name is not its entry point.** `tiingo-us-backfill` deploys as
`tiingo-us-eod-backfill-{env}`, so the loop — which keys on `${BASE}-${_ENV}` —
carries the JOB base, not the tsup key. Keying on the entry point would emit
`tiingo-us-backfill-prod`, a job that does not exist and never will, warning
every build while the real one drifts.

`feed-repair` (MONEY-1250) and `doc-ingest-backfill` (MONEY-1314) each shipped
OUTSIDE the loop on the same reasoning — "it has no schedule, so a release
should not re-point a job nobody asked it to touch" — and no schedule is the
argument FOR inclusion. An on-demand job runs rarely enough that nobody connects
the release to the result, and `doc-ingest-backfill` is a MULTI-EXECUTION drain:
a service deploy mid-drain leaves the rest of the corpus converted by the
previous release's parser, with nothing on the rows to mark the seam.

Re-pinning does not disturb a running walk: an execution is created from the job
spec at execute time and keeps its own image, so `jobs update` lands on the NEXT
execution.

That closes the loop but does not replace the check: **`[build-provenance]` is
the only place the drift is observable.** Every one of these jobs prints that
line as its first output, naming the commit it is ACTUALLY running. It must
equal the service's `DD_VERSION`, which is the build's `$COMMIT_SHA`.

### 3. TWO arm flags, compared against the literal string `"true"`

**`XBRL_PROJECTION_APPLY` arms the StockFinancials projection. `XBRL_RATIOS_APPLY`
arms the StockRatios derivation. They are separate switches (MONEY-1286).**

They were one flag until both gates were run against prod on 2026-08-30 and
disagreed:

| Gate              | Verdict       | Evidence                                                                                                   |
| ----------------- | ------------- | ---------------------------------------------------------------------------------------------------------- |
| `xbrlratios prod` | **PASS**      | `roe` READY at 666/697 (95.6%); nothing BLOCKED                                                            |
| `xbrlrecon prod`  | **NOT READY** | `totalLiabilities` 17.2% disagreement, `totalAssets`/`totalEquity` 6.9%, `netIncome` 5.9%, vs a 5.0% floor |

The state the evidence supports — ratios on, financials off — was inexpressible
with one flag: arming what passed would have armed what failed, through a
one-way door (step 4). Splitting them is what makes the ratios half shippable on
its own evidence.

What is waiting on the other side of the ratios arm, measured: `stock_ratios`
holds 2,135 rows, all vendor (`TICKERTAPE`), frozen since 2026-03-21. **Ten of
the 26 XBRL-owned columns are 100% NULL platform-wide** — `operatingMargin`,
`grossMargin`, `ebitdaMargin`, `assetTurnover`, `earningsGrowth`,
`revenueGrowth3Y`/`5Y`, `earningsGrowth3Y`/`5Y`, `pegRatio`, `returnBasis` — and
nine more sit near 4% (`netMargin` 86 rows, `debtToEquity` 86, `currentRatio`
86). From the 108,020 filings already ingested, per-symbol derivable today:
`netMargin`/`operatingMargin` 2,466 symbols, `grossMargin` 2,426,
`ebitdaMargin` 2,417, `roe`/`roa`/`assetTurnover` 2,303, `debtToEquity` 2,292,
`roce` 2,287, `currentRatio` 2,109.

Both are compared against the literal `"true"`, never `Boolean()`.
`Boolean("false")` is `true`, so a truthiness check would arm the job in exactly
the configuration meant to keep it off — the MONEY-1214 shape where an absent
`MF_METADATA_PROVIDER` disabled a job silently for months. Both therefore ship
**present and `"false"`** in both cloudbuild specs; absent and `"false"` must
never be the same state. Both are read PER CALL off `process.env`, never
captured in a module-scope const — a module-level read freezes at import, and on
a warm Cloud Run container that turns a redeployed switch into no switch at all.

A scheduler payload can `{"apply": false}` to NARROW a run. It can never arm
one. Arming is an environment act.

### 4. Arming is a ONE-WAY DOOR

Past the flip, the first projection write for a period **destroys the value it
replaced**, because `StockFinancials` has no `source` in its unique key. The
displaced value survives only in `rawData.displacedByXbrl` — a
`DisplacementRecord` written **exactly once**, because a second displacement
would be recording the state this writer created and would overwrite the only
copy of what was there before.

That record is the entire audit trail. Do not overwrite `rawData` from anywhere
else, and do not treat a re-run as a way to "check" a displacement — it is not
idempotent in the direction that matters.

---

## The sequence

### 1. Merge the MONEY-1235 fix wave, deploy prod, and verify the JOBS moved

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run services describe stockbook-workers-prod \
  --region=asia-south1 --format='value(spec.template.spec.containers[0].image)' \
  --account=founder@disdigital.in --project=stock-book-483718
```

Note the `prod-<sha>` tag. Then confirm each job carries the SAME tag — the new
cloudbuild step should have done this automatically, but the point of the check
is that a step which silently failed looks exactly like one that worked:

```bash
for j in feed-parse-prod fo-summary-prod feed-backfill-prod xbrl-backfill-prod; do
  printf '%-22s ' "$j"
  CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run jobs describe "$j" --region=asia-south1 \
    --format='value(spec.template.spec.template.spec.containers[0].image)' \
    --account=founder@disdigital.in --project=stock-book-483718
done
```

If any disagrees, re-run the owning setup script — they are the only thing that
may write a job's env block:

```bash
./scripts/ops/setup-feed-backfill-job.sh prod   # feed-backfill, feed-parse, fo-summary
./scripts/ops/setup-xbrl-backfill-job.sh prod   # xbrl-backfill
```

**The describe output is the CLAIM. `[build-provenance]` is the EVIDENCE.** Run
one job with a no-op argument and read its first line, with an explicit
timestamp term per Warning 1.

### 2. Re-run BOTH gates on prod, and paste both ladders into MONEY-1235

```bash
./scripts/ops/run-market-data-job.sh xbrlrecon  prod   # F3 reconcile — READ-ONLY
./scripts/ops/run-market-data-job.sh xbrlratios prod   # ratios validator — READ-ONLY
```

Neither writes. `--apply` is meaningless for both and the wrapper says so; the
scripts issue only `findMany`/`findFirst`.

Paste the **full per-field ladder** from each into the ticket, not the headline.
How to read them is in [Reading the two gates](#reading-the-two-gates) below —
in particular, `INCOMPARABLE` is the verdict that shrugs, and two broken pipes
have already hidden behind it (MONEY-1234).

A non-zero exit means **"we compared nothing"**, which must never be read as
"everything matched".

### 3. Arm, with the nightly payload still ANNUAL-scoped

Only after step 2. Flip the **projection** var in `workers/cloudbuild.prod.yaml`:

```yaml
- name: XBRL_PROJECTION_APPLY
  value: "true"
```

`XBRL_RATIOS_APPLY` beside it is a SEPARATE flip on its own evidence — the
ratios gate (`xbrlratios prod`) already reads PASS while this reconcile does
not, which is precisely why MONEY-1286 split them. Flipping one does not flip
the other, and neither of them narrows or arms the other's job.

and deploy. Editing the spec rather than running `gcloud run services update`
is deliberate: line ~347 deploys with `gcloud run services replace`, which is
declarative and replaces the entire container spec — so any env var set
out-of-band is silently erased by the next build, and the only symptom would be
written counts quietly going to zero.

`scripts/ops/setup-scheduler.sh` currently ships `xbrl-projection-daily` with a
**temporary** `{"periodTypes":["ANNUAL"]}` payload. Leave it. Prod holds 71,450
QUARTERLY filings against 18,381 ANNUAL and the selection is symbol-major
(`orderBy [symbol asc, periodEnd desc]`), so the two buckets interleave: an
unscoped 500-row nightly page would be mostly quarterly rows that cannot be
written while `createMissing` is off, and the ANNUAL work this switchover gates
on would advance at a fraction of its rate, nightly, forever.

Read the first armed `[job-outcome]` line — with an explicit timestamp term:

```
[job-outcome] {"msg":"job-outcome","job":"xbrl-projection","selected":500,"written":N,"failed":0}
```

Expect `selected ≈ 500` (the default limit), `written > 0`, `failed 0`. The
signal that means something is wrong is `selected > 0 && written === 0` — the
job found work and produced nothing, which `reportJobOutcome` escalates to a
`console.warn` and always accompanies with a `skippedReason` naming which door
closed (`authority`, `unchanged`, `noInstrument`, `createSuppressed`,
`superseded`, `unreadableFacts`).

**`displaced` is NOT in that line**, and do not expect it to be. The outcome
line carries `selected` / `written` / `failed` only; the route's JSON adds
`blocked`. Displacement is verified in the data:

```js
db.stock_financials.countDocuments({
  "rawData.displacedByXbrl": { $exists: true },
});
```

On the first armed ANNUAL runs it should be non-zero — those periods had
Tickertape incumbents. On the quarterly drain it will stay flat, because every
quarterly write is a CREATE with nothing to displace.

### 4. The `createMissing` pilot — small, scoped, hand-checked

`createMissing` is a SEPARATE opt-in and stays false by default. A CREATE is by
construction a row the reconciliation never compared, and a 100%-create run is
the exact signature of a `periodLabel` join bug: the label is our derivation of
a third party's formatting, so if the derivation is wrong every period looks
like new ground and gets duplicated under a second name. That has already
happened once — `periodLabel` returned a bare `"2025"` while all 32,359 prod
rows carry `"FY 2025"`, so the join missed 100% of rows.

One run, ~20 symbols you can check by hand:

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud pubsub topics publish xbrl-projection-prod \
  --message='{"apply":true,"createMissing":true,"symbols":["TCS","INFY","..."],"limit":200}' \
  --account=founder@disdigital.in --project=stock-book-483718
```

(Publish to the TOPIC, not `scheduler jobs run` — the scheduler sends its own
stored payload and cannot carry pilot arguments.)

Then open the created rows against the filings themselves and check four
things:

- **Period labels.** ANNUAL must read `FY 2025`; QUARTERLY must read `Q2-2026`.
  Known limitation, tracked separately rather than half-fixed: the quarter INDEX
  assumes an April–March year, so the ~25 non-March filers get the wrong quarter
  number. Their annual labels are correct (MONEY-1232).
- **Units.** Everything must be ₹ crore. `toCroreDenominated` rebases each
  statement BEFORE anything downstream sees a value, because
  `planFinancialsWrite` compares against the crore-denominated incumbent and
  records what it displaced — converting later would leave three copies
  disagreeing about units.
- **`basis`.** Each row must carry `CONSOLIDATED` or `STANDALONE` and it must be
  the right one. A holding company's two filings differ by a MULTIPLE — 360ONE
  FY2025 totalAssets is 19,768 Cr consolidated against 7,332 Cr standalone — and
  this table's key holds only one of them.

  **RATIFIED POLICY (MONEY-1300, founder decision, 2026-08-31): OPTION 1 —
  CONSOLIDATED-PREFERRED, STANDALONE FALLBACK.** One row per period, `basis`
  stamped, readers show the badge. This was already the code's de-facto
  behaviour through `STANDALONE_NO_DISPLACE`; it had never been ratified, and
  the quarterly drain was about to bake it in unexamined.

  Measured on prod 2026-08-30/31, latest annual period per symbol, 2,467
  symbols:

  |                                        | symbols                                                                                      |
  | -------------------------------------- | -------------------------------------------------------------------------------------------- |
  | files BOTH consolidated and standalone | **1,786 (72%)**                                                                              |
  | standalone only                        | 664 — NSE publishes no consolidated for 403 of 419 measured, which is correct and not a hole |
  | consolidated only                      | 17                                                                                           |

  **Choosing Option 1 destroys nothing, and that is why it was chosen.**
  `XbrlFiling` is `@@unique([symbol, exchange, periodEnd, periodType, basis,
cumulative])` — `basis` IS in that key — so both filings are retained
  permanently: 63,575 STANDALONE and 44,447 CONSOLIDATED of 108,022. The
  projection picks one for `StockFinancials`; the other stays queryable. A
  sibling standalone table (Option 2) can therefore be built from the archive
  at any later date, at the same cost as building it now, so it is deferred
  until a reader actually needs standalone rather than built speculatively.

  Option 3 — putting `basis` in `StockFinancials`'s `@@unique` — stays REJECTED.
  It would make consolidated and standalone two rows for one period, which every
  reader (research tools, the Financials tab, the reconcile gate) would
  double-count while looking entirely normal.

  **The vendor rows are stamped `UNKNOWN`, never left absent.** All 32,359
  existing rows are `source: "TICKERTAPE"` and carry NO `basis` attribute at all
  — the column exists in the schema, but a Mongo `db push` creates indexes and
  not fields. `UNKNOWN` is a NAMED value so a reader can tell "vendor, basis not
  known" from "XBRL, consolidated", and so that neither `{basis: null}` nor
  `{basis: {not: null}}` is ever the query anyone reaches for. That absent-field
  trap has already cost MONEY-1050, MONEY-1234 and MONEY-1235.

  A reader must render `UNKNOWN` and ABSENT identically, and NEVER as
  "Consolidated" — presenting an unknown basis as consolidated is precisely the
  failure this policy exists to prevent.

- **`SCALE-SUSPECT` notes.** Filings whose magnitudes disagree with the
  company's own siblings by ≥31.6x on two independent fields are QUARANTINED
  (`refusedScaleSuspect`), never auto-corrected. A skipped period is visible and
  recoverable; a silently "corrected" number is neither. Expect a handful.

Do not widen the pilot until the hand check is clean.

### 5. The quarterly drain — measure ONE run before looping

`stock_financials` holds ZERO quarterly rows, so every quarterly write is a
CREATE. The population is 71,450 quarterly filings (90,188 unprojected rows
in total, measured 2026-08-21).

**Measure one `{"limit":5000}` run against the 600 s Pub/Sub ack deadline before
you loop.** 5000 is the clamp in `processXbrlProjection`. The deadline is
`ackDeadlineSeconds: 600` on `xbrl-projection-prod-push` — verified live — and
600 is Pub/Sub's MAXIMUM, so it cannot be raised. A handler that runs past it is
not merely slow: Pub/Sub redelivers mid-flight and a second copy of the same job
starts concurrently, doubling the work, with `--max-delivery-attempts=5` before
it dead-letters.

```bash
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud pubsub topics publish xbrl-projection-prod \
  --message='{"apply":true,"createMissing":true,"periodTypes":["QUARTERLY"],"limit":5000}' \
  --account=founder@disdigital.in --project=stock-book-483718
# then read the outcome with an explicit timestamp>= term (Warning 1)
```

Time it. If one run fits comfortably inside 600 s, the drain is **≈15 runs** over
the quarterly population (≈19 if you drain the whole 90,188-row unprojected set).
If it does not fit, halve the limit and double the run count — do NOT let a run
overrun.

**Do not drain at the nightly 500.** 71,450 ÷ 500 is ~143 nights, which is not a
plan; it is the table quietly not filling for five months again. Note also that
`limit` counts filings READ, not rows written: `deferredByPagination`,
`supersededSiblings` and the refusal counters all consume budget, so a run
decides fewer periods than it reads. Read the counters, not the limit.

### 6. Revert the nightly payload, verify live, close

Restore `{}` in `scripts/ops/setup-scheduler.sh` for `xbrl-projection-daily`,
delete the TEMPORARY comment block above it, re-run
`./scripts/ops/setup-scheduler.sh prod`, and confirm:

- `stock_financials` has QUARTERLY rows, and a count that MOVES the next night.
- Rows carry `source: "NSE_XBRL"`, a `basis`, and a fresh `fetchedAt`.
- `stock_ratios` rows carry a fresh `ratiosDerivedAt`; `targetPrice` and
  `recommendation` are untouched by design (sell-side analyst opinion, in no
  filing and in no price series).
- The Quarterly tab renders on prod for a symbol picked at RANDOM, not the one
  used during development.
- `packages/core/__tests__/market-data/xbrl-projection-wired.test.ts` still
  passes — it pins the payload, so reverting it is the change that makes the
  test go red until the assertion is updated with it. That is deliberate.

Then push the zero-write monitor if it is not already live:

```bash
./scripts/ops/datadog/apply-monitors.sh prod
```

`monitor-zero-write.json` alerts on `job.selected > 0 && job.written == 0`. A
monitor on "did the schedule fire" cannot see any of this class, because the
schedule always fires.

---

## Reading the two gates

### `xbrlrecon` — the F3 reconcile

`scripts/data/xbrl-reconcile.ts`. Output is a per-field ladder:

```
per-field readiness:
  revenue           READY    match 812/840, disagree 28, scale 0, sign 0, incomparable 61  — …
  netIncome         BLOCKED  match 640/840, disagree 200, scale 12, sign 3, incomparable 61 — …
VERDICT: every field is READY — the switchover is evidenced.
```

Read the ladder, not the headline. The five verdicts mean different things and
only one of them is a tolerance question:

- **`SCALE_MISMATCH`** — off by a power of ten. A UNITS bug; one occurrence
  implies a whole class of periods is wrong. Blocks outright. The 28 found this
  cycle were NOT our arithmetic — they were internally consistent per filing, in
  both directions, which is the tell for a filer's own mis-declared
  `roundingLabel`. That is what `xbrl-scale-detector.ts` now quarantines.
- **`SIGN_MISMATCH`** — opposite signs. Systematic. Blocks outright.
- **`DISAGREEMENT`** — materially different, not explained by scale or sign. The
  only verdict a rate threshold is appropriate for.
- **`INCOMPARABLE`** — one side had no value. **This is the shruggable verdict
  and it has already hidden two broken pipes** (MONEY-1234). It counts toward
  the population ON PURPOSE, so a source that mostly has no data cannot pass by
  comparing the handful it does have — the MONEY-1196 draining denominator. A
  high incomparable rate is a question to answer, never a result to accept.
- **Exit code 1** when no filings matched. "We compared nothing" must never read
  as "everything matched".

Note the coverage limit while reading it: **90.7% of winner periods have no
vendor row at all**, so a vendor comparison can only ever speak for the overlap.
The whole quarterly universe is outside it.

### `xbrlratios` — the ratios validator

`scripts/data/xbrl-ratios-validate.ts`. Gate: **≥95% of non-bank ratios within
5%**.

**It compares ANNUAL filings only, and that is load-bearing.** `StockRatios` has
no period dimension — one row per symbol — and Tickertape publishes on a TTM
basis, while `deriveRatios` deliberately does NOT annualise a quarterly filing
("multiplying a seasonal quarter by four is a forecast dressed as a
measurement"). Comparing a quarterly-derived ROE against a TTM ROE yields a
systematic ~75% disagreement on nearly every symbol — a PERIOD mismatch with
nothing to do with data quality. A naive validator reports BLOCKED for the wrong
reason, and the obvious "fix" (widen the tolerance until it passes) hides a real
scale error behind the same slack.

Symbols whose newest filing is quarterly are counted `NO_ANNUAL_FILING` and are
never folded into the rate. If most of the universe lands there, the honest
verdict is _"not enough annual coverage to judge"_ — different from _"the numbers
disagree"_, and it calls for extending the backfill, not for arming anything.

Banks/NBFCs/insurers are EXCLUDED rather than tolerated: their ratios are
DISCLOSED (GNPA/NNPA/CET1) not derived, and a bank's debt-to-equity is not
comparable to an industrial's by construction — deposits are not debt in the
sense the ratio assumes.

### If any field reads BLOCKED

**Stop.** Do not force, do not partially switch. Per-field switchover is
explicitly not offered: it produces a row whose `source` says `NSE_XBRL` while
some of its columns are the incumbent's, and a row nobody can attribute is
exactly the state MONEY-1175 sat in for months. **The unit of switchover is the
ROW.**

Write the per-field gap table into `docs/reference/xbrl-reconcile-report.md`
with reasons and what would make each field READY, and continue with the rest of
the lane. The source badge and basis toggle ship regardless and simply read the
incumbent source until the switchover happens.

---

## What is wired, and what arms it

| piece                     | topic             | schedule                           | writes                                 |
| ------------------------- | ----------------- | ---------------------------------- | -------------------------------------- |
| `xbrl-projection-daily`   | `xbrl-projection` | `45 23 * * *` (23:45 IST)          | `stock_financials`, ANNUAL + QUARTERLY |
| `xbrl-ratios-daily`       | `xbrl-ratios`     | `0 22 * * 1-5` (22:00 IST Mon–Fri) | `stock_ratios`, 26 of 28 columns       |
| `xbrl-backfill-{env}` job | —                 | **no trigger, ever**               | `xbrl_filings` only                    |

Both nightly jobs are `PROD_ONLY` — not because they scrape (they read our own
filings) but because QA receives `stock_financials` and `xbrl_filings` through
`sync-prod-to-qa.sh`, whose `mongorestore --drop` replaces whatever QA computed
for itself.

The backfill job gets no trigger because a nightly re-walk of eight years of
filings is the fastest way to get our egress throttled off nseindia.com. It is
run by hand, one FY shard at a time, **oldest first** (the projection's QoQ and
TTM derivations need the prior periods present) and **one at a time** (the
pacing is per-process, so two concurrent shards double the request rate into
exactly the throttle the stop-loss exists to avoid). `setup-xbrl-backfill-job.sh`
prints the shard list.

**Wired is not armed.** Each processor reads its OWN flag from the service env
and writes nothing unless it is exactly `"true"`: `xbrl-projection` reads
`XBRL_PROJECTION_APPLY`, `xbrl-ratios` reads `XBRL_RATIOS_APPLY` (MONEY-1286).

---

## History worth keeping

**MONEY-1115 shipped an engine with no caller.** `processXbrlProjectionWrite`,
its tests, its units fix and its authority guard all landed — and no route, no
topic, no scheduler and no Cloud Run job. The code sat on `release` for a full
release writing nothing: `stock_financials` stayed frozen on a March snapshot
(32,359 rows, **0 QUARTERLY**) and the Quarterly tab was empty platform-wide.
Nothing errored. There was simply no path from a clock to the code, and no unit
test can see that, because the writer was correct.
`packages/core/__tests__/market-data/xbrl-projection-wired.test.ts` exists to
test the PATH for exactly this reason.

**MONEY-1234 found the selector returning 0 of 90,188.** `projectedAt` is a
nullable column added by `db push`, and a Mongo push creates INDEXES, never
fields — so the attribute is ABSENT on every row until something writes it, and
Prisma's Mongo connector does not treat absent as null:

```
prisma.count()                                90,188
prisma.count({ projectedAt: null })                0
prisma.count({ projectedAt: { not: null } })       0
prisma.count({ projectedAt: { isSet: false } })  90,188
```

A filter AND its inverse both returning zero is the signature. Raw Mongo DOES
match absent with `null`, which is why a mongosh check said 90,188 while the job
selected 0 and reported success. Same class as MONEY-1050 and now `basis` in
MONEY-1235.

**MONEY-1235 found two more.** `createMissing` had no message field and no
route forwarding, so the writer's documented "separate, opt-in step" was
unreachable and every production run ever executed had it false — with zero
quarterly incumbents, that made the Quarterly tab impossible to fill however
long the job ran. And the writer stamped `projectedAt` on CREATE-SUPPRESSED
filings, because `decidedIds` was populated for a whole symbol group BEFORE any
statement was written and the create branch returned without touching
`failedIds`. Armed, that burns a page of quarterly filings per night into
stamped-never-created, and the later deliberate pilot then selects none of them
— recoverable only by a hand `$unset`.

**The competing-writer sweep (MONEY-1204 step 1) is still in force.** Five write
sites — `financial-data-sync.ts` (now retired), `db-store.ts` ×2,
`persistence.ts`, and the projection — all delegate to one
`mayOverwriteFinancials(challenger, incumbent)`, and a DISCOVERY scan
(`packages/core/__tests__/market-data/financials-write-authority.test.ts`) walks
`apps/ packages/ workers/ scripts/` so a sixth writer cannot appear unguarded.
Mutation-proven: a rogue writer planted in a tree with no existing write sites
is found, and the suite grows around it. `FINANCIALS_AUTHORITY` is
`NSE_XBRL > TICKERTAPE > SCREENER > YAHOO`, with an unknown value ranking LAST
so a new upstream can only ever fill a gap.
