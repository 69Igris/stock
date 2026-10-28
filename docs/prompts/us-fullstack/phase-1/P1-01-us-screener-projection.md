# P1-01 · `us_screener_row` + the `us-screener-project` Cloud Run job

Ticket: MONEY-1566 (+ MONEY-1568) · Branch: `feat/MONEY-1566` · Flag(s): none (a job; `US_SCREENER_APPLY` arms its writes) · Screens: none · Depends on: P0-01 · Parallel-safe with: P1-05

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.

## Goal

Build ONE Mongo row per active US listing, `us_screener_rows`, and the sharded Cloud Run job that fills it every US night. Every US screener query, the stock page's KEY RATIOS grid (P1-04), the markets page movers (P1-07) and watchlist prices (P1-08) read this row and nothing else.

## Why / measured state today (verified)

- There is no US analogue of `StockRatios` (`packages/database/prisma/schema.prisma:5039`). `UsInstrument` (`:6868`) holds identity and sync bookkeeping only (listingId, symbol, exchange, assetType, cik, permaTicker, cold/hot years).
- Fundamentals sit in `UsFundamentals.standardized Json` (`:8304`). The model is keyed `@@unique([cik10, statementType, periodType, periodEnd, accession])` and has a nullable `symbol`. Prisma cannot range-filter a Json column, so `PE < 25` is not a query.
- The join is `UsInstrument.cik`, which is nullable, to `UsFundamentals.cik10`. `packages/core/src/us-fundamentals/repository.ts:330-337` measured 7,111 of 8,307 active stocks carrying a CIK on 2026-08-29.
- Prices: `Candle` (`:7086`, `@@map("candles")`). D1 is keyed `listingId` + `ts`. `divCash` defaults to 0 and `splitFactor` to 1. Read it ONLY through `CandleRepository.getCandles` (`packages/core/src/market-data/candles/candle-repository.ts:393`, `:445`; `CandleQuery` at `:109` has `listingId`, `adjusted`, `cold`).
- Funds: `UsFundNav` (`:6977`) is keyed `@@unique([permaTicker, date])`. `workers/src/processors/us-eod-sync-logic.ts:165/:168` routes `Mutual Fund` to NAV and `Stock`/`ETF` to candles.
- Sector: `UsFiler.sic` / `sicDescription` (`:8144`, `@@index([sic])`). This is the ONLY sector-like field for US equities, and P1-07's heatmap needs it. **Delta to the ticket's shape:** add `sic` and `sicDivision` to the row.
- Mongo `db push` creates indexes, not fields. A null-matching predicate on an absent field matches nothing (MONEY-1050/1234/1235). Every coverage field is therefore a NAMED enum and is written on every row.

## Read first (verified paths)

- `scripts/jobs/tile-build-d1-us.ts`: the entry pattern. `reportBuildProvenance` goes FIRST, then `initJobTelemetry`, then `reportJobOutcome({job, selected, written, failed})`, then `await flushMetrics()`, and the exit code is the status.
- `scripts/jobs/tile-build-d1.ts:135-136` (`CLOUD_RUN_TASK_INDEX/COUNT` sharding) and `packages/core/src/ops/job-completion.ts:26` `guardCompletion` (exit 3 when the loop empties mid-run, MONEY-1608). The lake jobs wrap `main()` in it; do the same.
- `packages/core/src/market-data/databento/databento-harvest-logic.ts:27`: the arm flag read as `env["X_APPLY"] === "true"`, PER CALL, never module scope.
- `packages/core/src/ops/build-provenance.ts:332` `SETUP_SCRIPT_BY_ENTRYPOINT` + `workers/tsup.config.ts:184` (one entry per Cloud Run job; `job-build-provenance.test.ts` enforces the pair).
- `scripts/ops/setup-tile-build-job.sh`: job provisioning with `DD_API_KEY` mounted so `reportJobOutcome` emits (MONEY-1278). `scripts/ops/setup-databento-jobs.sh:363-368`: the APPLY flag is set PRESENT on the JOB env, not in a cloudbuild service spec.
- `scripts/ops/setup-scheduler.sh:1846` `setup_edgar_bulk_job_schedulers` is the generic prod-only Cloud-Run-job primary+retry trigger pair, with skip-and-delete on qa. `:2001` shows its second caller. The schedules to fit around: `:571` `us-eod-sync-daily` `0 11 * * 2-6`; `:360` tile build US `45 11 * * 2-6`; `:599` `candle-evict-daily` `0 15 * * *`.
- `scripts/ops/sync-prod-to-qa.sh:897` `REFERENCE_COLLECTIONS`. `candles`, `us_instruments`, `us_fund_nav` and `us_fundamentals` are already there.
- `packages/core/src/us-fundamentals/repository.ts` (`getStatements` `:415`) and `repository-logic.ts` (`pickPointInTime` `:152`, `padCik10` `:455`). Reuse these; do not re-walk the Json yourself.

## Build — in this order

This prompt is backend only. Service/action/route rows belong to P1-02/P1-06.

### 1. Schema + types

- In `schema.prisma`, next to `UsInstrument`, add `model UsScreenerRow` with `@@map("us_screener_rows")` and `@@unique([listingId])`. Fields follow the ticket, plus `sic String?` and `sicDivision String` (a named value; `"UNKNOWN"` when absent). Every numeric field is `Float?`. Enums are `String` with no default: `priceFill ∈ {FILLED, NO_BARS, STALE}`, `fundamentalFill ∈ {FILED, NO_CIK, NO_FILINGS, NOT_APPLICABLE}`, `fundFill ∈ {NAV, NO_PERMATICKER, NO_NAV, NOT_APPLICABLE}`, `sharesSource ∈ {DEI_OUTSTANDING, DILUTED_AVG, NONE}`.
- Indexes: `[assetType, <field>]` for every field a filter ranges or sorts on (lastClose, chg1D/1M/1Y, marketCap, peTtm, roe, netMargin, grossMargin, debtToEquity, dividendYieldTtm, pctFrom52wHigh, dollarVolume30d, ret1Y), plus `[assetType, sicDivision]` and `[symbol]`. A missing index is a 32 MB in-memory sort that THROWS.
- Create `packages/types/src/us-screener.ts` for `UsScreenerRow` as plain JSON (ISO strings) and the enum unions; export it from `packages/types/src/index.ts`. P1-02 adds the response envelope to the same file.

### 2. Pure projection logic

Create `packages/core/src/market-data/us-screener/projection-logic.ts` (no I/O):

- `projectPrice(bars, now)` returns `{lastClose, lastCloseDate, chg*, high52w, low52w, pctFrom52wHigh, avgVolume30d, dollarVolume30d, vol1y, maxDd1y, dividendYieldTtm, priceFill}`. Returns come from the ADJUSTED series; `lastClose` comes from the raw one. The dividend yield is the sum of `divCash` over 365 days divided by `lastClose`. `STALE` means the last bar is more than 5 US sessions old.
- `projectFundamentals(statements, lastClose, sharesOutstanding?)`: TTM is the sum of the last 4 QUARTERLY INCOME/CASH_FLOW periods (point-in-time via `pickPointInTime`). Balance items come from the latest BALANCE_SHEET. Every ratio is `Number.isFinite(x) ? x : null`, never NaN/Infinity. Do NOT use the repo's `finite()` helpers (`packages/services/src/*-logic.ts`): they fall back to `0`, and a 0 PE reads as data. `fcfTtm = CFO − capex` is marked derived. It also returns `fundamentalsAsOf` (filedAt) and `fundamentalsForm`.
- `projectFund(navs)` returns `{navOrClose, ret1M…ret5Y, navHistoryFrom, fundFill}`. A return whose window is longer than the history is null, never extrapolated.
- `sicToDivision(sic)` maps SEC SIC ranges to divisions (Manufacturing, Finance, …); unknown maps to `"UNKNOWN"`.
- `PROJECTION_VERSION = "us-screener-v1"`.

### 3. The job

- `scripts/jobs/us-screener-project.ts` is the entry, shaped like `tile-build-d1-us.ts`. `run()` goes inside `guardCompletion("us-screener-project", run())`.
- Shard: select ACTIVE `UsInstrument` ordered by `listingId` ASC and keep `index % CLOUD_RUN_TASK_COUNT === CLOUD_RUN_TASK_INDEX`.
- Per listing:
  - Stock/ETF bars: `getCandles({listingId, symbol, exchange, timeframe:"D1", from: now−400d, to: now, adjusted, cold: false})`. **`cold:false`**: the job must never demand-load cold shards into the hot store (that fights B6 / MONEY-1517).
  - Mutual Fund: `prisma.usFundNav` by `permaTicker`, from −5y (a job, not a request path).
  - Stock with `cik`: `getStatements` by `cik10` (never by bare symbol, because DOW is two companies), plus `UsFiler.sic`.
- Writes: an upsert by `listingId`, batched. The upsert writes EVERY field explicitly on both create AND update, with `null` included. P1-02's exclusion counts query `{field: null}`, and no Prisma predicate matches an ABSENT Mongo field. The arm is `isUsScreenerApplyArmed(env) => env["US_SCREENER_APPLY"] === "true"`, read per call. Unarmed, it computes everything and logs a PLAN (counts only).
- End of run: log a histogram of each coverage enum and `reportJobOutcome({job, selected, written, failed})`. `selected` counts every considered listing, skips included (MONEY-1215).
- A listing whose inputs are absent still gets a row. Only a thrown error counts as `failed`.
- Add the entry to `workers/tsup.config.ts` and to `SETUP_SCRIPT_BY_ENTRYPOINT`.

### 4. Ops

- `scripts/ops/setup-us-screener-job.sh {qa|prod} [--dry-run]`, cloned from `setup-tile-build-job.sh`:
  - `--tasks=4`, task timeout 2h;
  - `DD_API_KEY` secret mounted;
  - `--set-env-vars` carries `US_SCREENER_APPLY=false` **PRESENT in both envs** (absent ≠ "false", MONEY-1214).
- Scheduler: a `setup_us_screener_schedulers` that calls `setup_edgar_bulk_job_schedulers` with primary `15 12 * * 2-6` and retry `30 13 * * 2-6`, both IST. That lands after us-eod-sync (11:00) and tile-build-us (11:45) and finishes before `candle-evict-daily` (15:00). It is prod only; qa is skip-and-delete.
- Add `"us_screener_rows"` to `REFERENCE_COLLECTIONS` (QA receives rows and computes nothing).
- Update `scripts/README.md` and the root `CLAUDE.md` (a short US-screener note under Job throughput).
- **Do not add a Datadog monitor** in this PR (MONEY-1238: observe the series first). Name the absence-monitor row as a PR follow-up.

## Tests

- `packages/core/__tests__/market-data/us-screener-projection-logic.test.ts`:
  - a 10-day split fixture where adjusted 1Y return ≠ raw;
  - TTM with an amendment (point-in-time wins);
  - a zero-denominator PE returns null, not Infinity;
  - a fund with 200 NAV rows has `ret1Y` present and `ret3Y` null;
  - `sicToDivision` table;
  - `priceFill: STALE`.
- `…/us-screener-apply-flag.test.ts`: `"false"`, `"FALSE"`, `"1"` and absent all mean disarmed; only `"true"` arms. Assert the read happens per call (mutate env between two calls).
- **DOW test:** two `UsInstrument` fixtures, `DOW:NYSE:1972-…` (DELISTED) and `DOW:NYSE:2019-…` (ACTIVE). Only the ACTIVE listing is selected, fundamentals are read by that listing's `cik`, and the row's `listingId` is the 2019 one.
- Add `us-screener-project` to the provenance/metrics tests (`job-build-provenance.test.ts`, `job-metrics-path.test.ts`) through their existing tables, so they pass without special cases.
- `TEST-COVERAGE.md` updated; `yarn test:coverage-check`.

## Acceptance

- [ ] `yarn workspace @usemoney/database prisma generate` passes, and the schema's `@@index` list covers every range/sort field (asserted by a schema-reading test, not by a live `getIndexes()`).
- [ ] An UNARMED run against QA (whose `us_instruments`, `candles`, `us_fund_nav` and `us_fundamentals` are prod copies) logs the coverage histogram. Record it in the PR against the plan (≈5,138 `FILED`, ≈3,121 `NO_CIK`/`NO_FILINGS`), labelled as the QA copy. **Run the C-1 measurement** on the same QA copy: `us_instruments{assetType:"Stock",listingStatus:"ACTIVE",cik≠null}` joined to `us_fundamentals.cik10`. If it is materially below 5,138, the gap is `EDGAR_CIK_ENRICH` (MONEY-1297); say so.
- [ ] Job exits 0 unarmed (QA run above) and armed (functional test over fixtures: the upsert writes every field, `null` included); `[job-outcome]` line present; `verify:push` green; `/code-review`.

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8).

- Push the schema: `setup-infra.sh qa --only db`, then `setup-infra.sh prod --only db`; confirm `db.us_screener_rows.getIndexes()` lists every range/sort field.
- Provision the job and its schedulers: `setup-us-screener-job.sh qa`, `setup-us-screener-job.sh prod`, and the scheduler setup for prod.
- Run it UNARMED on prod once and compare the histogram and the C-1 count with the QA numbers in the PR.
- Arm it on prod (`US_SCREENER_APPLY=true` on the job env) and run once: row count == active listing count (Stock+ETF+Mutual Fund), QA receives the rows after the next sync, and ten symbols (AAPL, MSFT, NVDA, JPM, XOM, KO, SPY, QQQ, VFIAX, DOW) are hand-checked for PE and 1Y return.

## Out of scope / hand-offs

The query surface, envelope and registry (P1-02, P1-06). Moving the trailing arithmetic to BigQuery once MONEY-1513 lands US silver is a reader swap inside this job, never a second projection. US fund reference data is F4 (P1-09).
