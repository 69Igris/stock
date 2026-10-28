# prod→QA incremental copy — measured, and NOT built

**MONEY-1486 · measured 2026-09-21 against prod · decision: DO NOT build it yet.**

The ticket proposed replacing `mongorestore --drop` with a high-water-mark
delta for "the append-only giants — `candles`, `us_filings`,
`us_company_facts`". A working mechanism was built, reviewed, and **withdrawn**.

This records the measurement, and the three reasons the mechanism was withdrawn,
because both halves are the useful part and neither is recoverable from an
absent feature.

## Why the change was wanted

`mongorestore --drop` drops a collection **and its indexes** and rebuilds them
LAST. For the duration of a restore the collection enforces nothing, and a run
killed at the 3600s task timeout leaves it with rows and no unique index.
Observed live 2026-09-19 by `scripts/ops/verify-db-indexes.ts`, two collections
on two polls of one run:

```
[MISSING] StockDocument       -> stock_documents        (mid [1/54])
[MISSING] ShareholdingPattern -> shareholding_patterns  (mid [4/54])
```

## THE MEASUREMENT: zero of 54 collections qualify

A false entry is a **correctness** bug, not a missed optimisation — if prod ever
rewrites a row, a `$gt` delta never sees it and QA diverges silently and
permanently. Four rules: no update/delete writer; watermark monotonic at insert
AND indexed; no backfill inserting old watermarks; no QA-side writer.

**3 of 54** have no `update`/`upsert`/`delete` writer anywhere —
`mf_nav_history`, `institutional_deals`, `us_cost_model_rows`. All three then
fail rule 2 or 3.

### `candles` — the collection the ticket was about — is MUTABLE

```
candle-repository.ts:896    updateMany   stamps hotLoadedAt ON EVERY READ
candle-repository.ts:1556   update       rewrites OHLC / source / tier on upgrade
candle-evict.ts:611         deleteMany
databento-repo.ts:292       deleteMany
```

Its 116× weekday saving (253,955 new rows against 29,366,003) is unclaimable.
`us_filings` is mutable too — 66% of a 200,000-row sample has
`updatedAt > ingestedAt`.

### Rule 3 is defeated by construction, and only `createdAt` survives it

All 29,366,003 `candles` rows were inserted within the last 30 days while `ts`
spans 2016-01-04 onward: `tiingo-us-backfill` and `databento-harvest` write
decade-old `ts` today, so a `ts` watermark goes blind to the entire harvest.
`mf_nav_history` is worse — `mf-nav-backfill` writes a scheme's ENTIRE history
at once, 184,119 rows in one day carrying `date` from 2014 to 2026.

`createdAt` is `@default(now())`, applied at INSERT, so a 2014 NAV backfilled
tonight still sorts above the mark. That is the only property that survives a
backfill.

## WHY THE MECHANISM WAS WITHDRAWN

Three findings from review, any one of which is disqualifying.

### 1. A killed delta bakes the gap in permanently

`mongorestore` inserts in **arbitrary order** (`--maintainInsertionOrder` is
off by default) and archive order is prod's natural order, not watermark order.
A restore killed at the task timeout therefore leaves a **scattered** subset
applied, with no `--drop` to roll it back. The next run reads `max(field)` from
QA — now the highest value that happened to land — and `$gt` excludes every
un-landed row below it **for ever**.

The `--drop` path self-heals on the next successful run. The delta path does
not, and the run is recorded FAILED so it looks retryable.

**Consequence for the design:** the delta bound must come from a **recorded
successful-completion marker**, not from QA's current max. That marker is
MONEY-1488. So 1486 depends on 1488 — the reverse of how they were filed.

### 2. Skipping `--drop` does not restore a lost index

`mongodump --archive` carries index metadata regardless of `--query`, so a
no-drop restore must **build** the unique index over QA's existing rows — and
fails outright if QA already holds duplicates. Which is precisely the state the
ticket set out to fix. The mechanism cannot repair the damage it was motivated
by.

### 3. Strict `$gt` with no overlap drops boundary ties

This repo already documents the identical defect and its fix: `UsNewsArticle`'s
cursor walks `crawlDate` **with a 30-minute overlap**, "because that clock is
not monotonic with our polling and a strict `>` drops a late-crawled article
permanently, leaving a gap no count can see."

The nominated candidate is the worst case. `mf-nav-backfill.ts:261` is a
`createMany`, so thousands of rows share one `@default(now())` millisecond. If
QA ends a run holding part of that batch, `$gt` excludes the remainder for ever.

## A CORRECTION THIS REVIEW FORCED

An earlier draft of this document, and the withdrawn commit, claimed MONEY-1481's
59 QA candle duplicates were caused by `--drop` removing the unique index
mid-restore. **That is wrong**, and two files already on `main` say so:

- `scripts/data/dedupe-candles.ts` — "The index was never built, so nothing ever
  refused the second write", naming two PROD writers (TIINGO_RT and DATABENTO)
  reaching M1 for one US symbol.
- `packages/core/__tests__/database/index-guard.test.ts` — "duplicates predated
  the `@@unique`, so `prisma db push` could not build it".

Never built, not dropped. And decisively: `us-eod-sync-daily` is in
`PROD_ONLY_JOBS` and `candles` is a REFERENCE_COLLECTION, so **`putCandles`
never runs against QA at all** — a dropped QA index cannot produce QA
duplicates.

That made three contradictory written accounts of one incident. This is the
fourth and it is the one checked against the other three.

## What DID ship

`@@index([createdAt])` on `MfNavHistory` — the only blocker on the only
candidate. Adding an index is reversible and costs one field.

**It is not applied anywhere yet.** `prisma db push` is the only thing that
creates Mongo indexes and it is a developer action in no deploy pipeline, so
this index exists in neither environment. Nothing will report it missing either:
`index-guard.ts` audits `uniqueConstraintsFromDmmf`, i.e. `@@unique` only, so a
plain `@@index` is outside what the repo's index auditor compares.

It is needed on **both** sides before any arming: QA for the `max()` read, prod
for the `$gt` dump. A run armed with prod unindexed COLLSCANs 13.8M documents to
find ~152k, with the only symptom being a job that is still slow after the
change meant to make it fast.

## The order this should actually be built in

**STATUS 2026-09-21: steps 1, 2 and 4 are BUILT (`fix/MONEY-1487`). 3 and 5 are
not.** What shipped, and the two places this document was imprecise:

- The record is `qa_sync_outcomes` in **QA**, `_id` = the collection name, one
  row per VISITED collection. Six states, and the one this document's own
  motivation needs is `IN_FLIGHT`: it is stamped **before** the dump and never
  overwritten, because a process killed at the task timeout cannot write "I was
  killed". The absence of an end stamp is the signal. `FAILED` and `IN_FLIGHT`
  are the two that mean "partially applied"; `mayUseAsDeltaBound` admits only a
  clean `RESTORED`, which is the precondition §1 below asks for.
- The order is least-recently-**VISITED** first. This document says the bound
  must come from a "recorded **successful**-completion marker" — true for the
  BOUND, and wrong for the ORDER. Keying the walk on success would park
  `candles` (which has failed every run since 2026-09-01, burning 25-29 min of
  a 60-min budget) at the head for ever and starve the other 53. The two keys
  are different fields for different questions, and conflating them would have
  rebuilt MONEY-1255 inside the fix for MONEY-1487.
- §4 sized the index check at "~15 lines, zero extra spawns" — accurate. It
  compares against no schema, because the image has no Prisma: the test is a
  collection that HOLDS ROWS and has only `_id_`, and `relink_required` now
  exits **3** for it, a third verdict distinct from `relink` and
  `relink-orphans-remain`.
- Cost, measured rather than assumed: mongosh cold start is **2.6 s**, so two
  writes per collection is ~4.7 min of the 3600 s task timeout. The upgrade if
  that bites is named in the script — fold the `IN_FLIGHT` write into the
  empty-guard's existing per-collection call.
- **RETRACTED — this bullet claimed a defect that does not exist.** It read:
  "`sync-prod-to-qa-sample-refusals.spawntest.ts` exceeds its 180 s file wall
  on an M-series laptop **on `main`, unmodified**", and said so on the strength
  of running the pristine files. That was measured in a git WORKTREE, which has
  no `node_modules/.bin/tsx` — so `REAL_TSX` falls back to `npx`, and the
  `before()` hook blocks on a network fetch. Swapping pristine files into the
  same broken environment reproduces the same environment, not the same code.

  Re-measured in the real checkout, where the binary exists:

  ```
  # tests 14   # pass 14   # fail 0   # cancelled 0   EXIT=0
  ```

  Worth keeping as the caution it accidentally became: a cancelled file DOES
  report `not ok` with `# fail` still 0 (MONEY-1316's header warns about
  exactly that, and MONEY-1489 now names the file). But the trigger here was a
  missing dependency in a disposable checkout, and "I verified it on pristine
  files" is not the same claim as "I verified it in a working tree".

1. **MONEY-1488** — record per-collection sync outcomes. This is the
   prerequisite, not a companion: the delta bound must be a recorded
   successful-completion marker. **BUILT.**
2. **MONEY-1487** — ordering, so the tail is reachable at all. **BUILT.**
3. **The timeout itself.** The named root cause is a run killed at
   `--task-timeout=3600`, hardcoded at `setup-sync-job.sh:221`. A 24h-timeout
   Cloud Run job already exists in this repo (`setup-databento-jobs.sh`). Moving
   the deadline, parallelising the loop, or making a restore resumable all
   address the actual failure; none of them were attempted here.
4. **An index check inside the sync.** `relink_required()` already runs an
   embedded mongosh program against QA after every restore — a `listIndexes`
   check there is ~15 lines, zero extra spawns, and covers all 54 collections,
   where the withdrawn mechanism covered zero. **BUILT.** One limitation worth
   writing down: `relink_required` only runs when a required-relation
   collection was restored, so a run that restored only US collections does not
   reach it. Accepted rather than widened — the gate is pinned by
   `sync-relink-required.test.ts` and by the "stays green when prod is empty
   everywhere" case, and the check covers all 54 whenever it does run, which is
   what matters: the run that DOES the damage is the one that was killed, so it
   can never be the one that reports it.
5. **Then, if still worth it**, the delta — with an overlap window, a recorded
   bound, and a type rule on the watermark.

## Rejected candidates

- **`institutional_deals`** (6,911 rows) — buys nothing, and `deals-backfill.ts`
  exists specifically to insert old dates: a live rule-3 hazard for that nothing.
- **`us_cost_model_rows`** (2,353 rows) — clean but worthless.
- **Every EDGAR collection** — all route through one generic
  `writers.py:501 UpdateOne(criteria, {"$set": …}, upsert=True)`, so a re-parse
  rewrites the row. Their `updatedAt > ingestedAt` counts read ZERO, which is
  **not** evidence: `@updatedAt` is a Prisma feature and these are written by
  Python, which bypasses it. `us_filing_documents` is demonstrably mutated by
  `backfill_extraction_status.py:116` while reading zero.

## A measurement caution this exercise produced

The first pass of these numbers was taken over a **weekend** and understated
every delta — `candles` read 3,184/day instead of ~253,955, and five weekday
jobs read 0. What exposed it was `mf-nav-backfill` reporting 194,508 on the same
window, because it is the one job that runs daily. **Any "rows per day" figure
for this platform must state which weekday it came from.**
