# MONEY-1399 — Job-absence monitors: two KINDS of row, decided by the job

Planned 2026-09-13 on Fable 5.1 from live measurement. Canonical task list lives on the
Linear ticket; this file is the doc-home copy and MUST be copied into `docs/reference/`
on the implementation branch (founder rule: every doc is available in the repo too).

## Verified premises (each one measured, not inferred)

| claim                                         | evidence                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A `selected=0` submission is a REAL datapoint | `stockbook.job.selected{job:edgar-bulk-ftd}` 2026-09-10 13:30Z → 1 non-null point, value 0.0                                  |
| A job that did not run has NO SERIES          | `resend-contact-sync` over the same window → no series                                                                        |
| `default_zero()` erases that distinction      | current query sums to 0 in both cases                                                                                         |
| Proposed query is valid                       | `POST /api/v1/monitor/validate` → VALID                                                                                       |
| Proposed query flips edgar to OK              | `default_zero(count_not_null(sum:…))` over 16d containing the 09-10 run = 1                                                   |
| Proposed query STILL FIRES on silence         | same query over 09-04..09-09 (no run) = 288 points, sum 0 → `< 1` true                                                        |
| `default_zero` is load-bearing                | bare `count_not_null(sum:…)` on the silent window → NO SERIES                                                                 |
| The monitor evaluator fills silence           | 2026-09-12: resend-contact-sync absence (default_zero) = Alert while its zero-write (no default_zero) = No Data, same silence |
| The test discards the row's 3rd field         | `monitor-agreement.test.ts:363` regex has two capture groups                                                                  |
| The recogniser would miss the new form        | `ABSENCE_QUERY_FORM` (`:435`) requires `default_zero(\s*sum:` — must widen                                                    |

## The two kinds

| kind       | query                                            | window must clear                            | why                              |
| ---------- | ------------------------------------------------ | -------------------------------------------- | -------------------------------- |
| `standing` | `default_zero(sum:selected) < 1` (today's)       | cron gap AND longest legitimate zero-stretch | zero IS the defect (MONEY-1215)  |
| `sparse`   | `default_zero(count_not_null(sum:selected)) < 1` | cron gap only                                | zero is the healthy steady state |

Checkpointing is a perfect predictor across all 25 rows (15 checkpointed → AT RISK/BROKEN; 0 of 8 re-selecting).

**The two lists below are the SHIPPED state, parsed from `ABSENCE_MONITORS` in
`scripts/ops/datadog/apply-monitors.sh`, not the plan as written.** Two rows
moved after this file was drafted and the planned 10/15 split is no longer
what disk holds:

- `etf-expense-enrichment` left the SPARSE set by being RETIRED (MONEY-1404),
  not by being reclassified. The job could never write at all —
  `fetchKuveraMetadata` returns null unless `MF_METADATA_PROVIDER` is kuvera and
  both specs set amfi — and the sparse exemption is what made a guaranteed
  no-op indistinguishable from a drained queue.
- `mf-sync` joined the STANDING set (MONEY-1403): AMFI publishes daily including
  weekends, so there is no calendar on which a zero is legitimate.

The total is 25 either way, which is why the stale 10/15 split survived a
release — it adds up. Re-derive rather than copy: the rows are
`job|window|kind|cadence`, and `packages/datadog/__tests__/monitor-agreement.test.ts`
pins the sparse set BY VALUE.

`sparse` (9), in file order: candle-evict, news-rss-sync (news-engine fixes are
deferred to its migration), tiingo-news-poll, databento-append, feed-parse,
report-archive-sync, price-backfill, resend-contact-sync, edgar-bulk-ftd.

`standing` (16), in file order: news-sync, xbrl-ratios, bhavcopy-sync,
surveillance-sync, institutional-flow-sync, bse-announcements-sync,
nse-announcements-sync, market-movers-sync, price-sync, intraday-sync,
us-eod-sync, us-instrument-master-sync, mf-sync, mf-metadata-sync,
index-constituent-sync, macro-sync.
The exchange-driven five stay standing because their zero is BOUNDED (holiday
cluster, 8d clears it) and a PERMANENT zero is a broken feed that must keep
alarming.

## Task list — see MONEY-1399 (T0–T7). Summary

T0 branch `fix/MONEY-1399` from origin/main (rebase if #418 merges first — shared docs).
T1 `monitor-job-absence-sparse.json`: query + message + rationale keys change; **name byte-identical** (upsert by name → 25 PUTs, 0 orphans).
T2 `apply-monitors.sh`: row `job|window|kind|cadence`; `read -r A_JOB A_WINDOW A_KIND A_CADENCE` (:1347); FATAL on unknown kind; pick template into `render` (:1375); reclassify 25 rows; rewrite :445-468.
T3 `monitor-agreement.test.ts`: 3-group parser (:363); widen `ABSENCE_QUERY_FORM` (:435) + add `SPARSE_QUERY_FORM`; cases (a)(b)(c)(d); 4 mutations recorded red in the PR.
T4 docs: TEST-COVERAGE.md (57 → measured), scripts/README.md (~:323-332), CLAUDE.md one paragraph, copy this file to docs/reference/.
T5 build → verify:push → commit → push → PR.
T6 post-merge: `apply-monitors.sh prod` → 25 `updated`, 0 `created`; edgar → OK; no standing row changed; `--only=verify` → only-in-code 0.
(`etf-expense` was the second job named here and is RETIRED — MONEY-1404. Its
two live monitors, 22316235 and 22317851, are ORPHANS that this script cannot
delete and `--only=verify` cannot report, because the managed tag is shared and
the orphan half runs non-exclusive. The manual DELETE is written out in
`apply-monitors.sh` beside the `document-financials-projection` row.)
T7 SIBLING ticket: deployed-spec audit of every Cloud Run job for DD_API_KEY / DD_METRICS_TRANSPORT (MONEY-1278 class, 6th recurrence).

## Not this ticket

- tracer.ts:105-107 + datadog-monitoring-plan.md:760 claim the app container has no DD_API_KEY; deployed 00146-9mp does. Doc fix.
- LLM Obs transport PROVEN (serverless-init digest exposes /evp_proxy/v1..v4; llmobs POST forwarded → 403 from intake vs agent 404). Zero data = no model call since deploy + Vercel unset.
- MONEY-1400: stock-document-embed backend refusing every chunk (281/24h) + 119 docai page-limit failures.
