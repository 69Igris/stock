# XBRL financials backfill — operator guide & report

> MONEY-1114 (Data Engine P10 **F2**). Sibling of
> [`xbrl-reconcile-report.md`](./xbrl-reconcile-report.md) (F3, the projection
> gate) and [`feed-backfill-report.md`](./feed-backfill-report.md) (the P3 walk
> this job is modelled on).
>
> **Status: BUILT, NOT RUN.** Every section marked _PENDING_ below is waiting on
> a founder-executed run. Nothing in this document is estimated into a table
> that looks measured — the numbers that ARE here were measured against the live
> NSE API and prod on **2026-08-19** and each one says so.

---

## 1. What F2 had to fix before a backfill was even possible

`xbrl_filings` on prod held **2,152 rows, 100% `periodType: "QUARTERLY"`,
100% `cumulative: false`**, spanning 2025-03-31 → 2026-06-30. Not a partial
backfill — a structurally impossible one. Four defects, none of which produced
an error, a counter or a log line.

### 1.1 Annual filings were never REQUESTED

`xbrl-sync.ts` hardcoded `?period=Quarterly&` on the legacy index. The parameter
is **required** and takes **exactly two values**. Measured over
01-05-2019 → 31-05-2019, `index=equities`:

| `period=`        | records   | with a real `.xml` |
| ---------------- | --------- | ------------------ |
| `Quarterly`      | 1,467     | 1,440 (98.2%)      |
| `Annual`         | **1,539** | 1,512 (98.2%)      |
| `Half-Yearly`    | 0         | —                  |
| `Others`         | 0         | —                  |
| _param omitted_  | **0**     | —                  |
| `Zzzz` (invalid) | **3,012** | —                  |

Three traps, all live:

- **Omitting the parameter returns an empty array, not the union.** The obvious
  "drop the filter" yields a clean HTTP 200 with zero records, which reads as a
  quiet month.
- **An unrecognised value returns the union of everything.** 3,012 = 1,467 +
  1,539 + 6. Verified by set arithmetic on `seqNumber+symbol+period+consolidated`,
  not by counting: every quarterly and annual record appears in the `Zzzz`
  response, and the 6 extra are records whose `period` column is JSON `null` and
  which no valid filter can reach. **So a typo'd `period` silently DOUBLES the
  result set, and "fixing" the typo later silently halves it.**
- `Half-Yearly` / `Others` return `[]` in November too (the month a half-yearly
  filer would file). The column only ever holds `Quarterly`, `Annual` or `null`.

The **modern** `/api/integrated-filing-results` index has no period vocabulary
at all: `period=Annual`, `period=Quarterly`, `period=Zzzz` and no parameter
returned byte-identical 228,934-byte bodies for 01-06-2025 → 30-06-2025. There,
the period is a property of the document, which is now where it comes from for
both eras.

### 1.2 The legacy index does not paginate, and the walk assumed it did

`size` and `page` are accepted and **ignored**. `page=1`, `page=2`, `page=3` and
no paging parameters returned byte-identical 1,119,778-byte bodies holding the
same 1,467 `seqNumber`s in the same order.

The collector paged "until a short page". 1,467 is never < 500, so it
re-requested the identical body until its 40-page cap: **40 index round trips and
a 40x-inflated entry list, per month, per period.** Invisible in the nightly job
(2026 windows are integrated-era only) and squarely on the backfill, every one of
whose 2018-2024 months is legacy.

### 1.3 A nine-month year-to-date column was stored as six months

`inferPeriodType` was `>=300 → ANNUAL, >=150 → HALF_YEARLY, else QUARTERLY`. A
ladder with no gaps cannot say "I do not recognise this", so it mislabelled
three real shapes silently:

| real span               | old label     | now              |
| ----------------------- | ------------- | ---------------- |
| 274d April–December YTD | `HALF_YEARLY` | `NINE_MONTH`     |
| ~425d transition year   | `ANNUAL`      | refused, counted |
| 40d stub period         | `QUARTERLY`   | refused, counted |

`days` is start-inclusive / end-exclusive, so **a full financial year is 364-366
days, not 365** (2018-04-01 → 2019-03-31 = 364). `classifyFilingPeriod` now owns
the bands and returns `null` outside them; `XbrlSyncResult.unclassifiedPeriod`
counts the refusals.

### 1.4 The nightly truncation warning was a false alarm

Every prod run printed
`INDEX MAY BE TRUNCATED — the coverage below is a FLOOR, not a count`.

`totalCount` describes the **query**; `listed` describes the **page**. The walk
pages until a SHORT page, so the comparison was always made on the last one —
where a short page is the healthy end of a complete walk. Measured on the live
nightly window (12-08-2026 → 19-08-2026): `totalCount` 1,446 at `size` 500, i.e.
pages of 500 / 500 / 446, and the final page reported "totalCount=1446 but
returned 446" on a fully collected result.

`detectTruncation` now takes `collected` — records gathered across every page of
the query. A warning that fires on every healthy run is worse than none, because
the run where the index really is capped looks identical.

---

## 2. The annual row is INSIDE the quarterly document

A March-quarter filing declares two undimensioned periods: the quarter (`OneD`)
and the financial year (`FourD`). The parser's primary rule takes the shortest
candidate sharing the latest end date — the quarter, correctly — and the year's
figures were parsed, ranked and discarded.

> **Correction to the F2 plan.** `XbrlFinancials.otherPeriods` carries
> `{start, end, days, contextRef, source}` — **dates only, no values**. The
> stored `XbrlFiling.facts` blob therefore contains no annual figures, and a
> database-side projection over the 2,152 existing rows is impossible. It would
> have been a pass that reported success over rows it could not fill.

Measured on RELIANCE Q4-FY19 consolidated
(`INDAS_43586_97155_19042019114014_WEB.xml`):

| context | period                  | days | `RevenueFromOperations` |
| ------- | ----------------------- | ---- | ----------------------- |
| `OneD`  | 2019-01-01 → 2019-03-31 | 89   | 1,416,340,000,000       |
| `FourD` | 2018-04-01 → 2019-03-31 | 364  | **5,810,200,000,000**   |

₹5,81,020 crore is Reliance's published FY2019 consolidated revenue.

`parseXbrlDocument(xml, { periodContextRef })` (MONEY-1114, additive) reads a
chosen period. It selects by **contextRef string, never by index** — document
order is not a contract — and **refuses** an unmatched contextRef rather than
falling back to the primary, because returning the quarter's numbers under an
`ANNUAL` label would be a wrong figure that looks right in a table whose unique
key would then make it the incumbent.

`storeAnnualCompanion` writes the second row at ingest, from the same bytes, at
zero network cost.

### The same document is listed under BOTH periods

1,379 of 1,491 annual `.xml` URLs in May-2019 are also quarterly URLs. So an
index entry from the Annual page carries `periodType: "ANNUAL"` while the
document it points at is a quarter. **The document now wins unconditionally**
(same principle as `basis`), and entries are deduplicated on `symbol|xbrlUrl`
before anything is downloaded.

The 112 annual-only URLs are not different documents — SESHAPAPER's
"annual-only" filing declares the same `OneD` + `FourD` pair. They are filings
NSE listed under one period and not the other, and they are the reason the
Annual leg must be fetched rather than inferred.

### `cumulative`: our word and NSE's diverge, deliberately

NSE flags **every** annual record `"Cumulative"` (1,539 of 1,539 in May-2019),
meaning "accumulated from the start of the financial year". We store `false`,
because a complete financial year **is** the period its row claims to cover, and
our flag's job is to warn that a row covers _less_ than its `periodType` implies.

This is not cosmetic: `cumulative` is in the unique key
`(symbol, exchange, periodEnd, periodType, basis, cumulative)`. Two writers
disagreeing about it do not conflict — they produce **two annual rows per
company-year** differing in a boolean, and every consumer picks one arbitrarily.
`classifyFilingPeriod` is the single place that decides, and both write legs call
it.

---

## 3. THE BALANCE-SHEET ERA BOUNDARY — read this before planning ratios

**Legacy `in-bse-fin` filings carry no balance sheet at all.** Not "only in the
annual column" — the tags are absent from the entire document, on every context.
RELIANCE Q4-FY19 has zero `TotalAssets` / `TotalEquity` / `Borrowings*` /
`CashAndCashEquivalents` elements; `balanceSheetDate` and `balanceSheetSource`
are both `null`. Only `ReserveExcludingRevaluationReserves` and
`PaidUpValueOfEquityShareCapital` exist.

**Integrated `in-capmkt` filings do carry one.** NAGAFERT Q4-FY25 resolves
`totalAssets`, `totalEquity`, `totalLiabilities`, `currentAssets`,
`borrowingsCurrent`, `inventories`, `tradeReceivables`,
`cashAndCashEquivalents` and more, at instant 2025-03-31.

Consequence, and it does not go away with more backfill:

| era                      | P&L | balance sheet          |
| ------------------------ | --- | ---------------------- |
| 2018-2024 (`in-bse-fin`) | yes | **structurally none**  |
| 2025+ (`in-capmkt`)      | yes | Q2 and Q4 filings only |

Every equity- or debt-based ratio — ROCE, D/E, P/B, interest coverage, asset
turnover — is therefore **unavailable for 2018-2024 from XBRL at any backfill
depth**. The producer should be gated on the era rather than emitting nulls that
read as "we failed to compute".

The Q2/Q4-only restriction in the integrated era is SEBI's half-yearly balance
sheet mandate, and prod confirms it exactly:

| `periodEnd` | rows  | rows with `totalAssets` |
| ----------- | ----- | ----------------------- |
| 2025-03-31  | 3     | 3                       |
| 2025-06-30  | 2     | 0                       |
| 2025-09-30  | 3     | 3                       |
| 2026-03-31  | 17    | 17                      |
| 2026-06-30  | 2,127 | 6                       |

(Prod, 2026-08-19. Q1/Q3 filings have none; Q2/Q4 have them all.)

The integrated documents declare `OneI` and **no** `FourI`, so the annual row's
balance sheet resolves by date-matching the same 2025-03-31 instant, recorded as
`balanceSheetSource: "date"` rather than `"column"`. That is correct — a
year-end balance sheet does not depend on which duration column it sits beside —
and the weaker provenance is stored rather than hidden.

### How the bands compose with F3's projection gate

Verified by running `classifyFilingPeriod` into `judgeProjectionEligibility`
(`xbrl-projection.ts`) for each real span:

| span | stored as                | `judgeProjectionEligibility`          |
| ---- | ------------------------ | ------------------------------------- |
| 90d  | `QUARTERLY` / cum=false  | **ELIGIBLE**                          |
| 182d | `HALF_YEARLY` / cum=true | refused `HALF_YEARLY_HAS_NO_BUCKET`   |
| 274d | `NINE_MONTH` / cum=true  | refused `CUMULATIVE_IS_NOT_A_QUARTER` |
| 364d | `ANNUAL` / cum=false     | **ELIGIBLE**                          |
| 425d | refused before storage   | never reaches it                      |

Two things to note. The 364d row being ELIGIBLE **is the unblock** — annual
figures now reach `StockFinancials`. And the 274d row is caught by
`CUMULATIVE_IS_NOT_A_QUARTER` rather than by a nine-month-specific reason,
because `cumulative: true` on that band is what the gate keys on. That coupling
is load-bearing: flipping `NINE_MONTH` to `cumulative: false` would leave only
the span check between a nine-month figure and a quarter cell.

---

## 4. Expected volumes — what a run should produce

Measured live 2026-08-19, four months per year, whole-month windows,
`index=equities`. `xml` = records whose `xbrl` ends in `.xml` (the rest are the
`/corporate/xbrl/-` stub, which is normal history, not an error).

| month   | Quarterly listed | Q xml | Annual listed | A xml | distinct symbols |
| ------- | ---------------- | ----- | ------------- | ----- | ---------------- |
| 2018-02 | 1,854            | **0** | 19            | **0** | 944              |
| 2018-05 | 600              | 534   | 715           | 643   | 357              |
| 2018-08 | 2,019            | 1,343 | 62            | 38    | 1,435            |
| 2018-11 | 1,688            | 1,629 | 4             | 2     | 1,264            |
| 2019-02 | 1,665            | 1,607 | 18            | 18    | 1,232            |
| 2019-05 | 1,467            | 1,440 | 1,539         | 1,512 | 1,181            |
| 2019-08 | 2,147            | 1,465 | 47            | 16    | 1,174            |
| 2019-11 | 1,889            | 1,863 | 9             | 8     | 1,151            |
| 2020-02 | 2,117            | 2,094 | 22            | 22    | 1,245            |
| 2020-05 | 321              | 321   | 300           | 300   | 271              |
| 2020-08 | 1,450            | 1,450 | 191           | 191   | 846              |
| 2020-11 | 2,253            | 2,253 | 24            | 24    | 1,294            |
| 2021-02 | 2,148            | 2,148 | 33            | 33    | 1,246            |
| 2021-05 | 1,050            | 1,050 | 1,012         | 1,012 | 603              |
| 2021-08 | 2,146            | 2,145 | 32            | 32    | 1,245            |
| 2021-11 | 1,943            | 1,942 | 4             | 4     | 1,137            |
| 2022-02 | 2,281            | 2,164 | 31            | 28    | 1,317            |
| 2022-05 | 2,685            | 2,681 | 2,643         | 2,641 | 1,562            |
| 2022-08 | 2,074            | 2,074 | 8             | 8     | 1,261            |
| 2022-11 | 2,484            | 2,484 | 6             | 6     | 1,439            |
| 2023-02 | 2,320            | 2,320 | 24            | 24    | 1,343            |
| 2023-05 | 2,841            | 2,840 | 2,817         | 2,815 | 1,635            |
| 2023-08 | 2,476            | 2,476 | 16            | 16    | 1,426            |
| 2023-11 | 2,504            | 2,504 | 10            | 10    | 1,442            |
| 2024-02 | 2,517            | 2,517 | 26            | 26    | 1,443            |
| 2024-05 | 3,056            | 3,051 | 3,048         | 3,043 | 1,752            |
| 2024-08 | 2,566            | 2,565 | 24            | 24    | 1,448            |
| 2024-11 | 2,401            | 2,401 | 19            | 19    | 1,353            |

What to read off it before judging any run:

- **Annuals are a MAY phenomenon.** ~3,000 in May, single or double digits in
  Feb/Aug/Nov. A February run finding 26 annual filings is correct, not broken.
  Do not treat a low annual count outside May as a gap.
- **Feb-2018 is 0% XBRL on 1,873 records.** The switch-on is mid-2018; that
  month is real history, not a failure. `--from-year` defaults to 2018 for this
  reason (Jul-2012 → Feb-2018 is 0%).
- **2018-05 (600/715) and 2018-08 (2,019 listed, 1,343 xml) are the transition.**
  Coverage climbs to 97-98% and stays there from Nov-2018.
- **2020-05 is a COVID artefact**, not a bug: SEBI extended FY2020 filing
  deadlines, so 321 quarterly / 300 annual in May and the balance arrives in
  June-August (Aug-2020 carries 191 annuals against a normal 8-30).
- Symbol counts run 1,100-1,750 per month, so **~1,400 distinct filers** is the
  denominator for a per-quarter completeness check, not the NSE-listed universe.

A full 2018-2024 walk is on the order of **200,000 downloads** across both
periods after dedupe — over a day of paced running.

---

## 5. Running it — Cloud Run job, NOT a laptop

Two agent sessions lost their runs to machine sleep on 2026-08-19. The walk
ships as a Cloud Run job with a 24 h task timeout.

```bash
# Provision (idempotent; re-run after any release that changes the job script).
./scripts/ops/setup-feed-backfill-job.sh prod
```

> **Preflight.** The job's image is resolved from the live
> `stockbook-workers-prod` service, so it must be built from a commit containing
> the `xbrl-backfill` entry in `workers/tsup.config.ts`. On an older image the
> container dies instantly with
> `Cannot find module /app/dist/xbrl-backfill.js`. Merge, let the release
> trigger rebuild, then provision.
>
> The job prints `reportBuildProvenance(log, "xbrl-backfill")` as its first
> line. Cloud Run **jobs pin their image at provision time** and a deploy of the
> service does not move them — that line is the only place the drift is
> observable.

### Smoke test first (zero NSE traffic)

`--dry-run` prints the month plan and exits without touching the index. That is
what you want before spending a day of downloads: the window arithmetic is where
an off-by-one silently skips a month.

```bash
gcloud run jobs execute xbrl-backfill-prod --region=asia-south1 \
    --args="--dry-run"
```

### The walk — SHARD BY YEAR, one execution at a time

One year is ~30,000 filings at 600 ms apiece ≈ 5 hours, comfortably inside the
24 h timeout. Seven years in one execution is not. Do not run shards in
parallel: they hit the same host and the pacing is per-process.

```bash
gcloud run jobs execute xbrl-backfill-prod --region=asia-south1 \
    --args="--from=2018-01,--to=2018-12"
gcloud run jobs execute xbrl-backfill-prod --region=asia-south1 \
    --args="--from=2019-01,--to=2019-12"
gcloud run jobs execute xbrl-backfill-prod --region=asia-south1 \
    --args="--from=2020-01,--to=2020-12"
gcloud run jobs execute xbrl-backfill-prod --region=asia-south1 \
    --args="--from=2021-01,--to=2021-12"
gcloud run jobs execute xbrl-backfill-prod --region=asia-south1 \
    --args="--from=2022-01,--to=2022-12"
gcloud run jobs execute xbrl-backfill-prod --region=asia-south1 \
    --args="--from=2023-01,--to=2023-12"
gcloud run jobs execute xbrl-backfill-prod --region=asia-south1 \
    --args="--from=2024-01,--to=2024-12"
```

`gcloud` splits `--args` on **commas**, so each comma above starts a new
argument. That is why the flags read as one per comma.

2025 onward is the integrated era and is already covered by the nightly
`xbrl-sync` worker; walk it only to fill a known gap.

**Resume is free.** A filing already in `xbrl_filings` is skipped BEFORE its
download, so a killed execution costs only the time already spent and there is
no checkpoint table to get out of sync.

### The annual companions for rows stored before F2

```bash
gcloud run jobs execute xbrl-backfill-prod --region=asia-south1 \
    --args="--annual-existing,--dry-run"       # counts, no NSE traffic
gcloud run jobs execute xbrl-backfill-prod --region=asia-south1 \
    --args="--annual-existing"
```

Expect this to be **small**: 2,127 of the 2,152 stored rows have periodEnd
2026-06-30 — a Q1 filing, whose year-to-date column IS its quarter, so it has no
annual context to recover. Only the ~20 rows at a March period-end can yield
one. The pass exists so nothing is stranded, not because it is where the annual
history comes from.

### Reading the exit code

Non-zero means the run was **INCOMPLETE**: an unreadable index window, a window
that hit a cap, or (on `--annual-existing`) a filing whose XML could not be
re-fetched. Read the log; do not re-run blind.

```bash
gcloud logging read \
  'resource.type=cloud_run_job AND resource.labels.job_name=xbrl-backfill-prod' \
  --limit=100 --freshness=1h --project=stock-book-483718
```

| Flag                  | Default   | Meaning                                                             |
| --------------------- | --------- | ------------------------------------------------------------------- |
| `--from` / `--to`     | —         | `YYYY-MM` inclusive month range. Overrides the year flags.          |
| `--from-year`         | 2018      | 2012 → Feb-2018 is 0% XBRL; walking it returns stubs.               |
| `--to-year`           | this year | —                                                                   |
| `--dry-run`           | off       | Print the plan (or, with a pass flag, count) and stop.              |
| `--annual-existing`   | off       | Derive ANNUAL companions for already-stored rows.                   |
| `--archive-existing`  | off       | Re-fetch stored rows whose archived XML is missing (MONEY-1204).    |
| `--limit=N`           | 0         | Cap the rows a pass scans. 0 = no cap.                              |
| `--window-budget-sec` | 14400     | Download budget per monthly window. Raised from the worker's 480 s. |

The two `*-existing` passes are mutually exclusive and the script refuses both
at once: they walk the same rows and both fetch from NSE.

---

## 6. Verification queries — run these AFTER a shard

_PENDING: no shard has been executed._ The queries are written now so the run is
judged against a fixed rubric rather than against whatever it produced.

### 6.1 Per-quarter counts vs expected filers

```javascript
db.xbrl_filings.aggregate([
  {
    $group: {
      _id: { end: "$periodEnd", type: "$periodType" },
      rows: { $sum: 1 },
      symbols: { $addToSet: "$symbol" },
      withBs: {
        $sum: { $cond: [{ $in: ["totalAssets", "$conceptsFound"] }, 1, 0] },
      },
    },
  },
  { $project: { rows: 1, withBs: 1, symbols: { $size: "$symbols" } } },
  { $sort: { "_id.end": 1, "_id.type": 1 } },
]);
```

Judge each row against §4:

- `QUARTERLY` symbols per quarter-end should approach the ~1,100-1,750 in the
  month column, NOT the listed-instrument universe. A filer files 2 rows
  (standalone + consolidated) or 1.
- `ANNUAL` rows should exist for **March quarter-ends only** (plus the handful of
  non-March fiscal years — SIEMENS is October-September).
- `withBs` must be **0 for every pre-2025 period-end**. A non-zero there means
  the legacy taxonomy grew a balance sheet we have not accounted for, or a
  concept is being resolved from the wrong context — investigate before trusting
  any ratio built on it.
- `NINE_MONTH` rows should be **absent** unless a filer publishes the YTD column
  as its own filing. Any `HALF_YEARLY` row with a ~274-day span is the 1.3 bug
  reappearing.

### 6.2 Per-symbol first / last / gaps

```javascript
db.xbrl_filings.aggregate([
  { $match: { periodType: "QUARTERLY", basis: "STANDALONE" } },
  {
    $group: {
      _id: "$symbol",
      first: { $min: "$periodEnd" },
      last: { $max: "$periodEnd" },
      n: { $sum: 1 },
    },
  },
  {
    $project: {
      first: 1,
      last: 1,
      n: 1,
      expected: {
        $add: [
          1,
          {
            $divide: [
              { $subtract: ["$last", "$first"] },
              1000 * 60 * 60 * 24 * 91.3,
            ],
          },
        ],
      },
    },
  },
  { $sort: { n: 1 } },
]);
```

A symbol whose `n` is materially below `expected` has holes. Expect legitimate
ones — listings, suspensions, delistings — so triage by `first`/`last` before
calling anything missing. **A missing quarter is `null`, never zero.**

### 6.3 The RELIANCE / TCS / HDFCBANK spot check, across eras

The three deliberately span the taxonomy split and the filer families
(Ind-AS large-cap, Ind-AS IT, BANKING).

```javascript
db.xbrl_filings
  .find(
    { symbol: { $in: ["RELIANCE", "TCS", "HDFCBANK"] } },
    {
      symbol: 1,
      periodType: 1,
      periodStart: 1,
      periodEnd: 1,
      basis: 1,
      cumulative: 1,
      taxonomyVersion: 1,
      filerKind: 1,
      coverage: 1,
      "facts.values.revenueFromOperations": 1,
      "facts.values.profitForPeriod": 1,
      "facts.values.totalAssets": 1,
    },
  )
  .sort({ symbol: 1, periodEnd: 1 });
```

| symbol   | era        | FY   | period type    | expected revenue                                                        | balance sheet | result    |
| -------- | ---------- | ---- | -------------- | ----------------------------------------------------------------------- | ------------- | --------- |
| RELIANCE | legacy     | 2019 | ANNUAL         | ₹5,81,020 Cr consolidated (5,810,200,000,000 in the stored rupee scale) | **absent**    | _PENDING_ |
| RELIANCE | legacy     | 2019 | QUARTERLY (Q4) | ₹1,41,634 Cr                                                            | **absent**    | _PENDING_ |
| RELIANCE | legacy     | 2022 | ANNUAL         | _PENDING_                                                               | absent        | _PENDING_ |
| RELIANCE | integrated | 2025 | ANNUAL         | _PENDING_                                                               | present       | _PENDING_ |
| TCS      | legacy     | 2019 | ANNUAL         | _PENDING_                                                               | absent        | _PENDING_ |
| TCS      | integrated | 2025 | ANNUAL         | _PENDING_                                                               | present       | _PENDING_ |
| HDFCBANK | legacy     | 2019 | ANNUAL         | _PENDING_ (`filerKind: BANK`; revenue is `InterestEarned`-led)          | absent        | _PENDING_ |
| HDFCBANK | integrated | 2025 | ANNUAL         | _PENDING_                                                               | present       | _PENDING_ |

The two RELIANCE FY2019 figures are **not pending** — they are the measured
values this ticket's tests assert against
(`packages/core/__tests__/market-data/xbrl-annual-period.test.ts`). Everything
else is filled in from a real run.

Checks that matter more than the absolute values:

1. **The annual row is not the quarter's numbers.** For any March period-end,
   the `ANNUAL` row's `revenueFromOperations` must be roughly 4x the `QUARTERLY`
   row's. Equal values mean the selector fell back to the primary — the exact
   failure `parseXbrlDocument`'s refusal exists to prevent.
2. **Exactly one ANNUAL row per (symbol, FY, basis).** Two means the two write
   legs disagreed about `cumulative`.
3. **`taxonomyVersion` flips** at the 2025 boundary (`2018-03-31`/`2020-03-31`
   → `2025-01-31`). If a 2025 filing still reports a legacy version, the era
   dispatch is wrong.
4. **`filerKind`** must be `BANK` for HDFCBANK and `GENERIC` for the other two —
   an NBFC misclassified as a bank reports fourteen RBI concepts it can never
   have as MISSING (MONEY-1200).

### 6.4 Run-level counters to record

From each execution's final `TOTALS` line:

| counter               | meaning                                         | expectation                                                            |
| --------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `listed`              | index records seen, both periods, before dedupe | ≈ §4 sums                                                              |
| `stub`                | `/corporate/xbrl/-` records                     | ~2-3% from 2019; ~100% pre-2018                                        |
| `written`             | primary rows                                    | _PENDING_                                                              |
| `+N annual`           | companion rows                                  | _PENDING_; concentrated in May                                         |
| `unclassified-period` | spans matching no band                          | **investigate any non-zero**                                           |
| `unknown-taxonomy`    | namespaces the parser cannot read               | 0 expected; each one is a table entry                                  |
| `non-financial`       | governance filings                              | ~6% is healthy                                                         |
| `fetch-failed`        | transport failures                              | small; NSE prunes, so a persistent failure may mean the filing is gone |

---

## 7. Known gaps and deliberate non-goals

- **Pre-2018 is not walked.** Jul-2012 → Feb-2018 is 0% real XBRL; every record
  is the stub URL. Walking it costs requests and returns nothing, and inflates
  the `stubbed` counter into looking like a fault.
- **Balance-sheet history cannot be backfilled.** §3. This is a property of the
  legacy taxonomy, not of our coverage.
- **The `period: null` records are unreachable.** Six of 3,012 in May-2019. They
  are only returned by sending an _invalid_ `period` value, which relies on an
  undocumented quirk of NSE's filter; if that quirk ever changes, a job built on
  it returns nothing while reporting success. Not worth six records.
- **`--annual-existing` costs one NSE fetch per row.** `getFeedAsset` under
  `FEED_ARCHIVE_MODE=archive` (prod) always goes to the exchange; only `replay`
  reads the archive back. Hence opt-in, paced, and `--dry-run`-first.
- **Half-yearly and nine-month rows are supported but not sought.** No index
  filter produces them; they arrive only when a filer's document declares that
  span as its primary period.
