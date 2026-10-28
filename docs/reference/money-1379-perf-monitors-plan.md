# MONEY-1379 close-out — performance monitors + board for Pub/Sub and the LLM workers, with the two prod failures probed

Planned 2026-09-11 on Fable 5.1 (read-only; every number below was measured
live today). **Build on Opus 5, on the EXISTING branch `fix/MONEY-1379`**
(2 commits already pushed: `68a3b0b9` BQ-transfer fix, `3bb85e93` tiingo guard).
This document is written so the implementer needs NO further research: every
file, line, constant, query, stub behaviour, assertion, command and expected
output is stated. Where a fact could go stale, the command that re-derives it
is given (§5).

> **STATUS: BUILT (2026-09-11), and the implementation DIVERGED from this plan
> in five places.** This document is the plan as written before the work; where
> it disagrees with the code, **the code and `CLAUDE.md` are authoritative**.
> Four code-review rounds drove the divergences, each one measured:
>
> 1. **The retry rule is an ALLOW-LIST of named jobs**, not "sub-hourly retries
>    once" (§A.1, and the row-9 message in §T2). Frequency says nothing about
>    what a second run costs: the sub-hourly set includes a paid Gemini sweep, a
>    metered vendor poll, a shared per-IP SEC budget and a job that sends email.
>    `alert-evaluator` is NOT on the list despite being one of the two jobs that
>    failed — its cooldown is a read-then-write, so two OVERLAPPING runs both
>    notify a user.
> 2. **The Zerodha-only broker filter applies to a SCHEDULED SHARD only**, not
>    to every call that names no broker, and the leaf has **no early return** —
>    it would have skipped per-bucket re-pairing of CSV-imported trades.
> 3. **A ratio preflights its DENOMINATOR only**, and the dead-letter row
>    preflights a sibling series: measured, `dead_letter_message_count` returns
>    NO SERIES on a quiet subscription, so preflighting it would refuse the row
>    on a healthy estate.
> 4. **Every listing is env-scoped** (`managed-by:…,env:…`). Without it a qa run
>    pruned the PRODUCTION monitors — reproduced, two DELETEs.
> 5. **Rows 5 and 6 group by `revision_name` and do NOT notify on no-data.**
>    `instance_count` carries a `state` tag (so `max:` under-reports) and a
>    `revision_name` one (so a service-level `sum:` over-reports during a
>    deploy); and an ephemeral group key plus `notify_no_data` is a page on every
>    release.

**Scope, as narrowed by the founder:** performance of (1) Pub/Sub — the queue
every worker is fed from — and (2) the Cloud Run workers that do analysis and
call models. Not sync jobs (they change with the data-warehousing project), not
config drift, not cost toggles, not GCE/GCS. **Two additions the founder asked
for on top:** probe the two Cloud Scheduler `DEADLINE_EXCEEDED` failures and
fix them if the probe is positive (§A — it is, and the fix is one flag), and
keep coded monitors and Datadog monitors in sync (§C · T4). **And one rule:**
any performance defect that needs a LARGE code change becomes a TICKET (T8) —
the embed overrun (§B) is one. The broker-sync defect (§D) was ticket-shaped
too, but the founder pulled it ONTO THIS BRANCH (2026-09-11): it is **T0-B**.

---

## 0. Facts that shaped this (all verified 2026-09-11)

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| F1  | `gcp.pubsub.subscription.oldest_unacked_message_age by {subscription_id}` returns **190 series**, including `*-pull-local` (never drained, so always old) and `*-qa-*`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Every Pub/Sub monitor scopes `subscription_id:*-prod-push`. Never `*`.                                                                                                                                                                                                                                                                                                                                                                                              |
| F2  | Cloud Run `by {service_name}` returns our 5 services; `algo-api-prod` / `algo-workers-prod` share the project and appear the moment they scale above zero.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Every Cloud Run monitor scopes by service NAME. Ownership boundary.                                                                                                                                                                                                                                                                                                                                                                                                 |
| F3  | `gcp.pubsub.subscription.push_request_count by {response_class}` — catalogue values are exactly `ack, deadline_exceeded, internal, invalid, remote_server_4xx, remote_server_5xx, unreachable`. `ack` DOES arrive (12,813 in 24 h across prod push subs), so a ratio has a real denominator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Handler-failure ratio = `(remote_server_5xx + unreachable) / all classes`. `remote_server_4xx` is EXCLUDED on purpose — it is our own dedupe middleware answering 409 `RETRY_LATER` (F13), not a failure.                                                                                                                                                                                                                                                           |
| F4  | **UNITS.** `gcp.run.request_latency.*` is **MILLISECONDS** (last-hour p95 = 93,695 ≈ 94 s; today's max 3,855,085 ≈ 64 min — above the 3,600 s request timeout because GCP reports a bucketed distribution and the p95 interpolates inside the top bucket). `gcp.pubsub.subscription.oldest_unacked_message_age` is **SECONDS** (max 705 against the 600 s ack deadline).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | The 480/540 s thresholds are written **480000 / 540000** in the latency query. Pinned by a test (T5 case 4).                                                                                                                                                                                                                                                                                                                                                        |
| F5  | Active sub-metrics (`GET /api/v1/metrics?from=`): `gcp.run.request_latency.user_execution.{avg,p95,p99,samplecount,sumsqdev}` — **no `.p50`**. `gcp.run.container.{instance_count,instance_count_with_readiness,cpu.utilizations.{avg,p95,p99},memory.utilizations.{avg,p95,p99},startup_latencies.{avg,p95,p99},max_request_concurrencies.{avg,p95,p99}}`. `gcp.run.request_count` carries tag `response_code_class`. `gcp.run.pending_queue.pending_requests`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Every widget/monitor below uses only names in that list.                                                                                                                                                                                                                                                                                                                                                                                                            |
| F6  | **Gemini quota, corrected.** `gcp.generativelanguage.quota.generate_content_paid_tier_3_requests.limit` = **9223372036854775807 (INT64_MAX = unlimited)** for both models. `…_input_token_count.limit` = **20,000,000 tokens/min**, usage max last hour 195,643 (3.7-flash) / 204,293 (3.8-flash) ≈ **1 %**. Only 9 `gcp.generativelanguage.*` series exist; no free-tier or tier-1 series.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The REQUESTS ratio monitor is DROPPED — usage/INT64_MAX can never cross a threshold, which is a monitor that is green forever (MONEY-1238's shape). The TOKEN ratio is the real ceiling and is the row that ships.                                                                                                                                                                                                                                                  |
| F7  | `gcp.pubsub.subscription.dead_letter_message_count` is live and NON-ZERO: `broker-sync-prod-push` max 29 in the last hour. `dead-letter-prod-push` ACKED **1,037 messages in 24 h**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The `> 0` monitor will fire the moment it is created. That is correct — see F14/F15. The founder must expect it.                                                                                                                                                                                                                                                                                                                                                    |
| F8  | **Cloud Scheduler, corrected.** It emits no `cloudscheduler.*` metric — but its EXECUTIONS LOG is a Cloud Logging log, and the built-in `logging.googleapis.com/log_entry_count` reaches Datadog as `gcp.logging.log_entry_count` tagged `log:cloudscheduler.googleapis.com/executions`, `severity:{info,error}`, `job_id:<job name>`. Measured: 5,050 `info` entries / 6 h on `job_id:*-prod` (one per attempt), 2 `error`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | A scheduler-failure monitor is possible TODAY with no log forwarding. Preflight on the un-sliced series (`info` arrives every minute); alert on the `severity:error` slice. §A.                                                                                                                                                                                                                                                                                     |
| F9  | `dashboards-agreement.test.ts` derives its metric inventory from OUR emitters and REFUSES others; `VENDOR_EXEMPT` (line 361) is the allow-list, with a case at ~line 621 asserting each exemption has a `why` > 40 chars, cannot swallow `stockbook.`, and IS USED by some widget. Its `METRIC_RE` (line 379) is `/(?:sum                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | avg                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | min | max | count | p\d+):([a-z0-9_.]+)\{/g`— a widget`q`must contain`<agg>:<metric>{`or it "yields zero metrics" and fails the floor at line ~613.`EXPECTED_BOARDS` (used at line 498) is a fixed list a new board must be added to. | T1 opens the door; T6's every `q` matches `METRIC_RE`; T6 appends the board name to `EXPECTED_BOARDS`. |
| F10 | `apply-service-monitors.sh` skeleton, exact anchors: `set -euo pipefail` :38, `ENV_ARG`/`--dry-run` parse :40-51, `HERE` :54, `source lib` :62, QA gate :74-77, `NOTIFY` :89, `MANAGED_TAG` :90, `dd_list_managed` :96, `ROWS=(` … `)` :98-201, `for ROW in "${ROWS[@]}"` :252 … `done` :371, `IFS='\|' read -r …` :253, envs skip :256-258, `dd_render` :355-368, `dd_upsert_monitor` :369, FAILED/accounting/exit :373-387.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | T3 is `cp` + replace those five sections.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| F11 | `lib-datadog.sh`: `dd_request METHOD URL [BODY]` sets `RESPONSE_STATUS`/`RESPONSE_BODY`, returns 1 on non-2xx (`000` when curl dies); credentials via `-K -` on stdin; `dd_list_managed TAG` → `EXISTING_JSON` (FATAL on non-array); `dd_upsert_monitor LABEL BODY` finds by exact `name` in `EXISTING_JSON` → PUT else POST, dry-run prints the body; `dd_metric_has_points QUERY [lookback]` → **0 points / 1 none / 2 did-not-run** (dry-run returns 0 without asking); `dd_render TPL VARS_JSON` JSON-parses the template, strips `_`-keys at every depth, fills `{{x}}` inside STRINGS only, throws on unknown/unsubstituted placeholders, then coerces `no_data_timeframe`, every `options.thresholds.*` string → Number, and `notify_no_data`/`require_full_window`/`include_tags`/`is_enabled` `"true"/"false"` → boolean.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Templates carry thresholds as `"{{critical}}"` STRINGS. `Number("")` is `0`, so a row with NO warning must have the `warning` key DELETED after render, not left empty (T3 step 6).                                                                                                                                                                                                                                                                                 |
| F12 | The test stub pattern (`service-monitors-agreement.test.ts:121-215`): a `curl` shell script first on `PATH` that logs `"$*"` to `$STUB_LOG`, DRAINS stdin (`cat > /dev/null` — a stub that skips this kills the credential writer with SIGPIPE and reports "curl exited 141"), routes by URL substring (`*/api/v1/monitor*` → `$STUB_LISTING_BODY`, status by `-X GET` vs write; everything else → `$STUB_PREFLIGHT_BODY`), prints `body\nstatus`. Run with `spawnSync("bash",[SCRIPT,"prod"],{env:{PATH:dir+…, DD_API_KEY:"stub-api-key", DD_APP_KEY:"stub-app-key", …}})`. A separate NO_NET stub (`exit 99`) proves `--dry-run` never reaches curl.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | T5 copies it; two additions: a per-URL "no points" body (`$STUB_EMPTY_FOR`, substring of the metric name → `{"series":[]}`), and a `-X DELETE` branch for the prune test.                                                                                                                                                                                                                                                                                           |
| F13 | **The 409s are ours.** `workers/src/lib/pubsub-dedupe.ts` (`pubsubDedupeMiddleware`, imported `index.ts:189`) claims a lease per Pub/Sub `messageId` (`DEFAULT_LEASE_MS = 60 min`, `pubsub-dedupe-logic.ts:72`) and answers a redelivery whose claim is still live with **409 `RETRY_LATER`** (NACK) and an already-finished one with **200 `SKIP_COMPLETED`**. Push subscriptions retry with `--min-retry-delay=10s --max-retry-delay=600s` and **`MAX_DELIVERY_ATTEMPTS=5`** (`workers/scripts/setup-pubsub.sh:658,684-687`), then dead-letter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | A handler that runs past 600 s is redelivered at 600 s (`deadline_exceeded`), 409'd, redelivered on backoff, 409'd … and DEAD-LETTERED after 5 attempts — roughly 20–25 min in — while the ORIGINAL is still running and will succeed. The work is not lost; the dead-letter is a false alarm. §B.                                                                                                                                                                  |
| F14 | **`broker-sync-prod-push`: 3,733 `remote_server_5xx` vs 91 `ack` in 24 h (97.6 % failure), 928 dead-letters/day.** Cause (measured): every 500 is `Sync job failed: Error: No broker connections found` (939 in 3 h). The scheduled trigger `{"userId":"*","isScheduled":true}` fans out to **64 shard leaves** (`buildShardFanoutMessages`, `workers/src/processors/sync-logic.ts:136`; `DEFAULT_SYNC_BUCKET_COUNT = 64`, `packages/types/src/pubsub.ts:449`, env-overridable `SYNC_BUCKET_COUNT`); each leaf runs `syncBrokerConnections({syncBucket:N})` which returns `{success:false, error:"No broker connections found"}` when the bucket is EMPTY (`packages/services/src/broker-sync.service.ts:753-754` and `:891-892`); `workers/src/processors/sync.ts:156` THROWS that; `workers/src/routes/sync.ts:26` answers 500 "= Pub/Sub retries"; 5 retries → dead-letter → in-app notification to the founder (`dead-letter-consumer.ts:159`, recipients `DEFAULT_DLQ_ALERT_EMAILS`, `dead-letter-consumer-logic.ts:432`). ~58 empty buckets × ~16 fan-outs/day ≈ 928.                                                                                                                                                                                                                                                                                      | An EMPTY SHARD is not an error. **Fixed on this branch — T0-B**, with the founder's constraint: **broker-sync is Zerodha-only for now — both connectors (`ZERODHA` and `ZERODHA_CONNECT`, `BrokerType` enum `packages/database/prisma/schema.prisma:3247-3257`)**. `buildConnectionWhere` has ONE runtime home, `packages/services/src/broker-sync.service.ts:120` (callers :744, :885); the copy in `workers/src/processors/sync-logic.ts:78-106` has no importer. |
| F15 | **`/jobs/stock-document-embed`: 423 requests > 600 s in 7 d** (374 on 2026-09-11 alone; 32 on 09-09, 9 on 09-08, 2 each 09-05/09-10), latencies 1,200–2,113 s, four killed at exactly 3,600 s by Cloud Run's `timeoutSeconds: 3600` (`workers/cloudbuild.prod.yaml:325`) → 504. 368 dead-letters/day from this sub (F13 mechanism). 7 d status split for the route: 3,248×200, 1,622×409, 6×429, 1×503, 4×504. During 04:00–05:00 UTC today: `instance_count` = 20 (= `maxScale`, `cloudbuild.prod.yaml:321`), `pending_requests` = 11, p99 user_execution 48 min. Cause (read, not guessed): `processStockDocumentEmbed` (`workers/src/processors/stock-document-embed.ts:109`) takes `batchSize = 200` documents per message (`:114`), and per document chunks → ONE `generateBatchEmbeddings` call (`:244`) → upsert → `DELAY_BETWEEN_BATCHES_MS = 1000` sleep (`:360-366`; constant in `stock-document-embed-logic.ts:21`). **No `RUN_TIME_BUDGET_MS`, no self-chain, no in-flight claim** — the only processor in the doc pipeline without them (extract has all three: `stock-document-extract-logic.ts:501`). Publishers: `stock-document-extract.ts:754` (one embed message per extract run, and extract self-chains to depth 20) and `packages/research/src/data-sources/rag-enqueue.ts`. The MONEY-1337 drain restarting is what produced today's 374. | Ticket (T8-1). Exactly the "600 s ceiling" section of CLAUDE.md, live. Also: this is an LLM (embedding) worker — the user_execution monitor will fire on it from day one; correct.                                                                                                                                                                                                                                                                                  |
| F16 | `price-sync` had 5 requests > 600 s in 7 d.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Sync job → out of scope; recorded here, not ticketed.                                                                                                                                                                                                                                                                                                                                                                                                               |
| F17 | 11 prod push subscriptions feed analysis/LLM workers: `stock-research, portfolio-roast, l3-analysis, research-preview-plan, login-briefing, comparison-analysis, strategy-scan, studio-render, proactive-analysis, stock-document-ingest, us-filing-insight` (`-prod-push`). Add `stock-document-embed-prod-push` as the 12th (F15).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The board's second Pub/Sub row names these 12.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| F18 | `ml_obs.*`: zero series until a QA deploy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | §3 queries stay uncoded.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| F19 | Linear projects (ids verified today): **StockSage 2.0 — Vertex RAG · Doc/Video Intelligence · Self-Learning Memory** `9cd1af66-69ae-4c8c-85f0-4db1010027a0`; **Broker Integration** `65c9a910-f8ac-4c9c-9494-e3d9d74057d8`; **Performance, Observability & Reliability** `f04892fd-0155-4119-81ee-35f1643ba0ec`. Existing related issue: MONEY-1307 (extract in-flight claim, In Progress, no project).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | T8 targets.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

## A. The two scheduler failures — PROBED, cause found, fix decided

**Jobs:** `news-rss-sync-market-hours-prod` (`*/5 9-15 * * 1-5`) and
`alert-evaluator-market-hours-prod` (`* 9-15 * * 1-5`), both `Asia/Kolkata`,
rows :862 and :867 of `scripts/ops/setup-scheduler.sh`.

**What they are (`gcloud scheduler jobs describe <job> --location=asia-south1 --format=yaml`):**
both are **`pubsubTarget`** (topics `news-rss-sync-prod`, `alert-evaluator-prod`),
NOT `httpTarget`. `attemptDeadline` is absent because it does not exist for
Pub/Sub targets (`gcloud scheduler jobs create pubsub --help` has no
`--attempt-deadline`; the http variant does). `retryConfig.retryCount` is
absent = **0** (`--max-retry-attempts` default 0, range 0–5);
`minBackoffDuration: 5s`, `maxBackoffDuration: 3600s`, `maxDoublings: 5`,
`maxRetryDuration: 0s`. `state: ENABLED`, `status: {}`.

**So `DEADLINE_EXCEEDED` is Cloud Scheduler's own PUBLISH RPC to the topic
timing out** — a GCP-internal transient. It is NOT our handler being slow: the
handler is on the far side of the topic and is never contacted by the
scheduler. The worker saturation in the same hour (F15) is coincident — both
happen at market open — not causal. Do not "fix" the handler for this.

**How often:** `sum:gcp.logging.log_entry_count{severity:error,log:cloudscheduler.googleapis.com/executions} by {job_id}` over 30 d = **2 per job**.
Denominators (7 d, `severity<ERROR` entries): 840 attempts (news-rss) and
4,198 (alert-evaluator) → **0.12 % and 0.02 %**. Repo-wide over 30 d: 7 ERROR
entries across 6 jobs (also `edgar-detect-minutely-prod` ×2,
`newsletter-publish-check-{prod,qa}` ×1 each; plus 2 `NOT_FOUND` on
`mf-nav-backfill-daily-prod` / `edgar-detect-minutely-prod`, a different class —
one-offs during re-provisioning, not pursued).

**Impact:** with `retryCount 0`, one failed publish = one SKIPPED TICK. Both
jobs are catch-up jobs whose next tick (1 min / 5 min later) covers the same
window, so nothing is lost — it self-heals. Nothing can SEE it today.

**Verdict — positive, fix it, cheaply.** Two parts, both on this branch:

1. **T0a · `--max-retry-attempts=1` for an ALLOW-LIST of named Pub/Sub-target jobs** (the `news-rss-sync` family only — `alert-evaluator` was removed on review, and the original sub-hourly heuristic with it), in
   `scripts/ops/setup-scheduler.sh` `upsert_scheduler()` (:1460-1497), both the
   `update pubsub` (:1475) and `create pubsub` (:1485) branches. Not for daily
   jobs: a scheduler retry publishes a NEW message with a NEW `messageId`, which
   the dedupe middleware (F13) cannot recognise as a duplicate — and in the
   ambiguous case (publish succeeded server-side, response timed out) that is a
   genuine second run. For a job that fires every minute a second run 5 s later
   is indistinguishable from the next tick arriving early; for `us-eod-sync`
   (once a day, metered Tiingo) it is a double spend. The rule is derived from
   the schedule string, not a per-row flag: minute field contains `*`, `/` or
   `,` → sub-hourly → retry 1; otherwise explicit 0 (present-and-explicit,
   MONEY-1214). Exact edit:

   ```bash
   # in upsert_scheduler(), after `local rc=0`:
   #
   # A scheduler retry re-PUBLISHES — a new messageId the dedupe middleware
   # cannot pair with the first, so in the ambiguous case (publish landed,
   # response timed out) it is a real second run. For a job that fires every
   # minute that is the next tick arriving 5s early; for a daily metered job
   # it is a double spend. So: sub-hourly schedules retry ONCE, everything
   # else stays at an explicit 0 (MONEY-1214: absent and 0 must not be the
   # same state). Measured 2026-09-11: 2 DEADLINE_EXCEEDED per month on each
   # of the two market-hours jobs, 0.02-0.12% of attempts, GCP-side.
   local MINUTE="${SCHEDULE%% *}" RETRY=0
   case "$MINUTE" in *\**|*/*|*,*) RETRY=1 ;; esac
   ```

   and add `--max-retry-attempts="$RETRY" \` to BOTH gcloud invocations (after
   `--description`). `min-backoff` stays at the 5 s default — no flag.

2. **T0b · a monitor over the executions log** — row 9 in T3, preflighted on
   the `info` slice (F8). Thresholds: **warning `> 0`, critical `> 1`** per
   `job_id` over `last_1h`: after T0a, one ERROR followed by a successful retry
   is a transient (warn); two in an hour means the retry ALSO failed or two
   ticks were lost (page). `notify_no_data: false` — no errors is the healthy
   state and is also what "no series" looks like.

**Test (T0c)** — `packages/core/__tests__/market-data/scheduler-retry.test.ts`
(new; the existing scheduler-scanning tests live in that directory —
`prod-only-sync-coverage.test.ts` is the pattern: read
`scripts/ops/setup-scheduler.sh` as text). Cases: (1) `upsert_scheduler` passes
`--max-retry-attempts="$RETRY"` in BOTH branches (count the literal = 2);
(2) the `case` derives 1 for `*/5 9-15 * * 1-5`, `* 9-15 * * 1-5`, `0,30 9-15 * * 1-5`
and 0 for `0 22 * * *`, `45 0 * * *`, `15 21 * * 1-5` — assert by extracting
the `case` line and evaluating the six schedules through `bash -c` with the
same expression (spawn `bash`, not a re-implementation in TS — the point is the
SHELL rule); (3) mutation: delete the `case` line → (1) still passes, (2) reads
0 for every schedule → red. **Runbook after merge:** `./scripts/ops/setup-scheduler.sh prod`
(idempotent `update` path) then `gcloud scheduler jobs describe alert-evaluator-market-hours-prod --location=asia-south1 --format="value(retryConfig.retryCount)"` → `1`.

---

## B. The embed worker — the real performance defect (TICKET, not this branch)

Facts in F13/F15. The mechanism, end to end, for one message today:

```
t=0      extract chain publishes {batchSize:200}      → embed leaf starts (up to 200 docs × ~6-10 s)
t=600s   ack deadline → Pub/Sub redelivers            → dedupe: lease live → 409 RETRY_LATER (attempt 2)
t=+10s…+600s  backoff redeliveries                    → 409, 409, 409 (attempts 3-5)
t≈20-25m attempts exhausted                           → DEAD-LETTER → founder notified (false alarm)
t=20-35m original finishes 200                         (or 504 at 60 min — Cloud Run kills it; then NOT dead-lettered, and the batch is REDONE from scratch on the next delivery)
```

Fix shape (the pattern already in `stock-document-extract-logic.ts` — copy it,
do not invent): `RUN_TIME_BUDGET_MS = 420_000` checked BETWEEN documents
(`for (const doc of documents)` at `stock-document-embed.ts:199`), stop and
publish a follow-up `{ ...message, chainDepth: depth+1 }` up to
`MAX_CHAIN_DEPTH = 20` when documents remain; `batchSize` default 200 is fine
once the budget binds (it becomes a page size, exactly the extract lesson in
CLAUDE.md). Second lever, optional: `DELAY_BETWEEN_BATCHES_MS = 1000` is
5–15 % of the run and protects Vertex from nothing measurable at one
in-flight document per instance — measure before removing. Third: the embed
publisher at `stock-document-extract.ts:754` fires once per extract chain link
(up to 20 per chain) — with the budget in place these become cheap and
self-limiting, so no change there. **This is a ~60-line change plus a
`-logic.ts` seam test and a mutation test, on a worker with a live drain
behind it — a ticket (T8-1).** Until it lands, the p95 and dead-letter monitors
will (correctly) fire on it.

---

## C. Keeping coded and Datadog monitors in sync

Today: every `apply-*.sh` UPSERTS by title and never deletes; `apply-monitors.sh:684`
says so explicitly ("REMOVING A ROW HERE DOES NOT DELETE THE MONITOR") and
documents a manual step. So a row deleted from a script leaves an orphan in
Datadog that still pages, and a monitor hand-edited in the UI silently
diverges from its row. The rule the founder asked for — coded and DD in sync —
is delivered as two lib helpers used by every apply script:

- `dd_verify_managed TAG NAME…` — read-only. Lists live monitors carrying the
  managed TAG, compares the set of NAMES to the rendered set, prints a three-way
  table (`in both / only in Datadog (orphan) / only in code (not applied)`) and
  returns **0 in sync / 3 drift / 1 could not list**. Every apply script gains
  `--only=verify` which renders (dry-run path, no writes) and calls it.
  **`apply-perf-monitors.sh` ALSO compares the `query` field** for names in
  both, because a UI edit to the query is the drift that matters most; the
  older two scripts compare names only (their rows carry env-dependent queries
  the verify path would have to re-render — a second PR if wanted).
- `dd_prune_managed TAG NAME…` — DELETEs live monitors carrying TAG whose name
  is not in the rendered set. **Used by `apply-perf-monitors.sh` on every
  non-dry run** (its tag is its own namespace; a monitor there that the script
  did not render is by definition an orphan), printing `pruned <name> (#id)`.
  Dry-run never lists, so it never prunes (nothing to compare against). NOT
  wired into `apply-monitors.sh` / `apply-service-monitors.sh` — their
  documented policy is manual delete, and changing it is not this ticket.

Idempotency stays: a second `prod` run is 9 PUT, 0 POST, 0 DELETE. The
morning-triage routine can run `apply-perf-monitors.sh prod --only=verify` and
alert on exit 3.

---

## D. Broker-sync — a correctness defect found on the way (FIXED ON THIS BRANCH — founder decision 2026-09-11)

F14. Not performance, but it is 3,733 5xx and 928 dead-letters a day, it
dominates the Pub/Sub failure-ratio monitor (it would be the first thing that
monitor pages about), and the founder decided both the direction —
**broker-sync is Zerodha-only for now, both connectors** — and the venue: this
branch, not a ticket. Task **T0-B** carries the full fix.

One more thing the fix must not break, found while reading the leaf: after
`syncBrokerConnections` succeeds, the leaf ALSO calls `syncHistoricalTradebook`
when `historicalDays > 0` (`sync.ts:206-225`, enabled whenever
`NODE_ENV=production`), and passes `userId:"*"` with NO `syncBucket` —
`SyncHistoricalTradesParams` (:852-859) has no such field. So on
`broker-sync-historical-weekly` (`0 1 * * 0`, `historicalDays:30`) every
POPULATED leaf backfills ALL users' connections: ~6 leaves × the whole table
today (derived from code, not yet measured — verify on the next Sunday's
`historical backfill synced` log lines). The throw at `sync.ts:156` has been
accidentally hiding this for the ~58 EMPTY shards; make the empty shard a
success without touching the historical call and it becomes 64×. Hence T0-B
steps 3 and 4 are mandatory, not tidy-ups.

---

## 1. Decisions (defaults proposed — "defaults" accepts all)

- **D1 · New script, not a new KIND.** `scripts/ops/datadog/apply-perf-monitors.sh`,
  managed tag `managed-by:apply-perf-monitors`. Extending `apply-service-monitors.sh`
  would put a subscription filter in a column named `service` and a metric in
  one named `span`.
- **D2 · Nine monitors, thresholds sustained never single-point, UNITS stated:**

  | #   | id                       | Query core (rendered, prod)                                                                                                                                                                                                                                                                                                                                                                                                    | Warn   | **Crit**   | Window | Unit                  | Fires today?                                                                          |
  | --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---------- | ------ | --------------------- | ------------------------------------------------------------------------------------- |
  | 1   | `pubsub-oldest-unacked`  | `max(last_10m):max:gcp.pubsub.subscription.oldest_unacked_message_age{subscription_id:*-prod-push} by {subscription_id} > 480`                                                                                                                                                                                                                                                                                                 | 300    | **480**    | 10m    | s                     | no (quiet now; 705 at 03:00 UTC)                                                      |
  | 2   | `pubsub-dead-letter`     | `max(last_5m):max:gcp.pubsub.subscription.dead_letter_message_count{subscription_id:*-prod-push} by {subscription_id} > 0`                                                                                                                                                                                                                                                                                                     | —      | **0**      | 5m     | count                 | **YES** — embed (F15, ticket T8-1); broker-sync until T0-B reaches the RELEASE deploy |
  | 3   | `pubsub-handler-failure` | `sum(last_15m):( sum:gcp.pubsub.subscription.push_request_count{subscription_id:*-prod-push,response_class:remote_server_5xx} by {subscription_id}.as_count() + sum:gcp.pubsub.subscription.push_request_count{subscription_id:*-prod-push,response_class:unreachable} by {subscription_id}.as_count() ) / sum:gcp.pubsub.subscription.push_request_count{subscription_id:*-prod-push} by {subscription_id}.as_count() > 0.20` | 0.05   | **0.20**   | 15m    | ratio                 | **YES** — broker-sync at 0.976 until T0-B is deployed                                 |
  | 4   | `workers-handler-time`   | `avg(last_15m):avg:gcp.run.request_latency.user_execution.p95{service_name:stockbook-workers-prod} > 540000`                                                                                                                                                                                                                                                                                                                   | 480000 | **540000** | 15m    | **ms**                | **YES** while an embed batch runs                                                     |
  | 5   | `workers-saturation`     | `max(last_10m):max:gcp.run.container.instance_count{service_name:stockbook-workers-prod} by {service_name} > 18`                                                                                                                                                                                                                                                                                                               | 16     | **18**     | 10m    | instances (max 20)    | intermittently                                                                        |
  | 6   | `usfund-saturation`      | same, `service_name:us-fundamentals-prod`, `> 9`                                                                                                                                                                                                                                                                                                                                                                               | 8      | **9**      | 10m    | instances (max 10)    | no                                                                                    |
  | 7   | `workers-queueing`       | `max(last_10m):max:gcp.run.pending_queue.pending_requests{service_name:stockbook-workers-prod} by {service_name} > 5`                                                                                                                                                                                                                                                                                                          | 1      | **5**      | 10m    | requests              | intermittently (11 today)                                                             |
  | 8   | `gemini-token-quota`     | `avg(last_15m):avg:gcp.generativelanguage.quota.generate_content_paid_tier_3_input_token_count.usage{*} by {model} / avg:gcp.generativelanguage.quota.generate_content_paid_tier_3_input_token_count.limit{*} by {model} > 0.85`                                                                                                                                                                                               | 0.70   | **0.85**   | 15m    | ratio (limit 20M/min) | no (~0.01)                                                                            |
  | 9   | `scheduler-errors`       | `sum(last_1h):sum:gcp.logging.log_entry_count{log:cloudscheduler.googleapis.com/executions,severity:error,job_id:*-prod} by {job_id}.as_count() > 1`                                                                                                                                                                                                                                                                           | 0      | **1**      | 1h     | count                 | no (2/month/job)                                                                      |

  Derivations: 480/540 s — 600 is Pub/Sub's ceiling, `RUN_TIME_BUDGET_MS = 420_000`
  (`stock-document-extract-logic.ts:501`) is the worst-case handler budget, 480
  is where `xbrl-sync` cuts itself off (`xbrl-sync.ts:284`); a p95 past 540
  means the tail is already redelivering. Row 9's `> 1` is `retryCount + 1`
  after T0a. Row 3 excludes `remote_server_4xx` (F3/F13). `notify_no_data`:
  **true** for rows 1, 4, 7, 8 (a stopped crawl must page; `no_data_timeframe`
  = 3× window in minutes); **false** for rows 2, 3, 9 (zero events = no series =
  healthy) and — added on review — for rows 5 and 6, which group by
  `revision_name`: a revision name changes on every release and Datadog keeps a
  metric monitor's groups ~24h, so no-data there is a page on every DEPLOY.

- **D3 · Scope by name, never wildcard.** `*-prod-push` / `*-qa-push` for
  subscriptions; explicit `service_name:` for Cloud Run. `tiingo-realtime` has
  no saturation row (`minScale = maxScale = 1`). Row 8 is the one permitted `{*}`
  (one project, one quota) and row 9 scopes `job_id:*-prod`; both are on an
  explicit allow-list in the script AND the test.
- **D4 · Envs.** Rows 1–3 `prod,qa`; rows 4–9 `prod` (rows 8/9 have no env
  dimension and are created once). QA is gated by `DD_QA_MONITORING` as
  everywhere else.
- **D5 · One board**, `UseMoney — workers performance` (T6).
- **D6 · No SLOs** (20-id cap; no observed baselines).
- **D7 · Sync rule** as §C: verify everywhere, prune only in the new script.
- **D8 · Large code changes → tickets** (T8), with ONE founder-directed
  exception: the broker-sync fix (T0-B) ships on this branch. Other on-branch
  code changes are limited to: the scheduler retry flag, the lib helpers, the
  new script, templates, tests, board, docs.

---

## 2. Todo — branch `fix/MONEY-1379`, in this order

Legend per task: **files · how · test · done when**. Every assertion is
mutation-verified before commit (the standing rule; the named mutation must be
SEEN red).

### T0 · Scheduler retry flag (§A)

- **files** `scripts/ops/setup-scheduler.sh` (`upsert_scheduler`, :1460-1497);
  new `packages/core/__tests__/market-data/scheduler-retry.test.ts`.
- **how** the exact edit in §A.1. Do NOT touch the http-target blocks
  (:1565-1640, :1711) — they have their own retry semantics and are not the
  jobs that failed.
- **test** §A T0c (3 cases + mutation).
- **done when** `bash -n scripts/ops/setup-scheduler.sh` passes; test green;
  `grep -c 'max-retry-attempts="\$RETRY"' scripts/ops/setup-scheduler.sh` = 2.

### T0-B · broker-sync: an empty shard is a no-op, and the sync is Zerodha-only (§D — founder decision: on this branch)

- **files** `packages/services/src/broker-sync.service.ts` (`buildConnectionWhere` :120-131; `syncBrokerConnections` :741-755; `SyncHistoricalTradesParams` :852-859; `syncHistoricalTradebook` :874-887); `workers/src/processors/sync.ts` (leaf call :141-156, success path :155, historical branch :206-225, COMPLETED block :118-124 to reuse); `workers/src/processors/sync-logic.ts` (delete the dead duplicate `buildConnectionWhere` :78-106 — no importer anywhere in `workers/src`; `yarn type-check` proves it); `packages/services/__tests__/broker-sync.test.ts` (:77-100, three deepEqual expectations change — expected); new `workers/__tests__/sync-leaf.test.ts`.
- **how**
  1. **Zerodha-only, both connectors — in the ONE `buildConnectionWhere` (:120).** Export the constant and apply it only when no explicit `broker` was given, so a user syncing one NAMED connection keeps working:
     ```ts
     /**
      * Founder decision 2026-09-11: broker sync works for Zerodha ONLY today —
      * both connectors. The other six BrokerType members are not syncable; a
      * scheduled fan-out that includes them only manufactures empty work.
      * Widening this is a one-line edit HERE, visible in a diff, and a test
      * pins the exact membership so it cannot widen by accident.
      */
     export const SYNC_ENABLED_BROKERS = ["ZERODHA", "ZERODHA_CONNECT"] as const satisfies readonly BrokerType[];
     …
     if (broker) where.broker = broker;
     else where.broker = { in: [...SYNC_ENABLED_BROKERS] };
     ```
  2. **Empty SHARD → success, not error** (`syncBrokerConnections` :753). Keep the error for a USER-scoped call — `apps/web/lib/actions/broker-connection.ts:1566` maps that exact string to "Broker not connected":
     ```ts
     if (connections.length === 0) {
       // A scheduled SHARD with no connections is the normal state of most of
       // the 64 buckets — measured 2026-09-11: ~58 of 64 empty on every fan-out,
       // 3,733 5xx and 928 dead-letters a day, each an in-app notification to
       // the founder. Nothing to do is not a failure. `Number.isInteger`, not
       // truthiness: bucket 0 is a real shard.
       if (Number.isInteger(params.syncBucket)) {
         return {
           success: true,
           data: { synced: {}, total: 0, perConnection: [] },
         };
       }
       return { success: false, error: "No broker connections found" };
     }
     ```
  3. **Shard the historical call too.** Add `syncBucket?: number` to `SyncHistoricalTradesParams` (:852); pass it as the 4th argument of `buildConnectionWhere` at :885; give its empty branch (:891) the same shard rule with `data: { synced: 0, connectionCount: 0, perConnection: [] }`. Without this, step 2 turns the weekly job's ~6× amplification (§D) into 64×.
  4. **The leaf returns early on an empty shard** (`sync.ts`, right after `const { synced, total, perConnection } = result.data;` :155): `if (total === 0 && Number.isInteger(data.syncBucket)) { console.log(\`Sync job ${jobId}: shard ${data.syncBucket} has no syncable connections — nothing to do\`); await prisma.backgroundJob.updateMany({ where: { jobId }, data: buildSyncJobStatusUpdate("COMPLETED", { result: { success: true, synced: {}, total: 0 } }) }); return; }`— BEFORE the metrics loop, the historical branch and the pairing block (:325-361). And in the historical call (:218) pass`syncBucket: data.syncBucket`.
  5. Delete `buildConnectionWhere` from `workers/src/processors/sync-logic.ts` (:78-106): one rule, one spelling — this repo's recurring defect class is two copies of one rule disagreeing. Fix the doc comment on `isFanoutTrigger` if it points at it.
- **test**
  - `packages/services/__tests__/broker-sync.test.ts`, `describe("buildConnectionWhere")`: update the three no-broker expectations to carry `broker: { in: ["ZERODHA", "ZERODHA_CONNECT"] }`; add (a) explicit `broker: "UPSTOX"` → `broker: "UPSTOX"` (explicit wins; no `in`); (b) `SYNC_ENABLED_BROKERS` deep-equals exactly `["ZERODHA", "ZERODHA_CONNECT"]` — widening must be a visible diff; (c) `buildConnectionWhere("*", undefined, undefined, 0)` carries `syncBucket: 0` (bucket 0 is real).
  - Same file: the empty-branch decision. The file tests "pure guards" (TEST-COVERAGE:492) and has no prisma seam, so extract the decision into a pure `emptyShardResult(syncBucket)` → `ServiceResult` used by BOTH service functions, and test it: bucket `0` → `success:true` (a truthiness check is the bug); bucket `undefined` → `success:false` with the EXACT string `"No broker connections found"` (the web action depends on it); bucket `3` → success. _Mutation:_ `Number.isInteger(syncBucket)` → `syncBucket` → the bucket-0 case goes red.
  - `workers/__tests__/sync-leaf.test.ts` (new): `processSync({ userId:"*", isScheduled:true, syncBucket:3, historicalDays:30 })` with injected stubs — `syncBrokerConnections` returning the empty-shard success, `syncHistoricalTradebook` a spy, prisma `backgroundJob.updateMany` a spy — asserts: the historical spy is NOT called; `updateMany` was called with a COMPLETED status exactly once after PROCESSING; no throw. Then with `syncBucket:3` and ONE connection: the historical spy IS called and its argument carries `syncBucket: 3`. Check first how `processSync` takes dependencies; if it has no `deps` parameter, add one the way `processStockDocumentEmbed` does (`StockDocumentEmbedDeps`, `stock-document-embed.ts:98-107`) — an optional trailing `deps` object defaulting to the real modules. _Mutation:_ remove the early return of step 4 → the first assertion goes red.
  - Source scan (in the new test): no file under `workers/src/` contains `function buildConnectionWhere` (pins the deletion).
- **done when** all green + both mutations seen red; `yarn type-check` clean; `TEST-COVERAGE.md` updated (services 17 → 23, new workers file 3). After the RELEASE deploy of workers: `sum:gcp.pubsub.subscription.push_request_count{subscription_id:broker-sync-prod-push,response_class:remote_server_5xx}` = 0 over 24 h; `dead_letter_message_count{subscription_id:broker-sync-prod-push}` = 0; the founder's in-app dead-letter notifications stop; the next `broker-sync-historical-weekly` (Sun 01:00 IST) logs one `historical backfill synced` line per POPULATED shard, not per user-table scan.

### T1 · Open the door in the dashboards inventory

- **files** `packages/datadog/__tests__/dashboards-agreement.test.ts` — `VENDOR_EXEMPT` (:361-374) and `EXPECTED_BOARDS`.
- **how** append to `VENDOR_EXEMPT`:
  ```ts
  {
    prefix: "gcp.",
    why:
      "Supplied by Datadog's Google Cloud integration (MONEY-1379), not emitted " +
      "by this repo — 798 series observed active on 2026-09-11. There is no local " +
      "constant to compare against; apply-perf-monitors.sh preflights every " +
      "series it alerts on against the live org, which is the only check that " +
      "can exist for a name we do not control. A gcp.* series that stops " +
      "arriving is caught by that preflight (three outcomes: points / none / " +
      "did-not-run), not by this file.",
  },
  ```
  and add `"workers-performance"` to `EXPECTED_BOARDS`. Bump the widget floor
  at line ~500 (`widgets >= 30`) only if it fails; do not lower it.
- **test** the existing "vendor exemption is narrow, used, and cannot cover our
  own series" case now has a second exemption to iterate; add one case: a
  synthetic `q` of `avg:gcp.does_not_exist{*}` passes `isExempt`, and
  `avg:stockbook.job.written{*}` does not; also assert every exemption prefix
  ends with `.` (mutation: change the prefix to `"g"` → the existing "would
  swallow our own series" assertion goes red; change it to `"gcp"` without the
  dot → the new trailing-dot assertion goes red).
- **done when** `yarn workspace @usemoney/datadog test -- --test-name-pattern=dashboards` green (23 → 25 cases; T6 adds more).

### T2 · Three monitor templates

- **files** new in `scripts/ops/datadog/`: `monitor-gcp-gauge-by-group.json`,
  `monitor-gcp-ratio-by-group.json`, `monitor-gcp-percentile.json`. Mirror
  `monitor-rt-health.json`'s shape (`_readme`, `name`, `type`, `query`,
  `message`, `tags`, `options`, `_placeholders`). All documentation in `_` keys
  only (stripped at every depth). Thresholds and booleans as STRINGS (F11).
- **content** (placeholders: `env label agg metric scope group suffix window critical warning family message notify notify_no_data no_data_timeframe`; the ratio template uses `num den` instead of `metric/scope/group/suffix`; the percentile template uses `metric` = the `.p95` sub-metric name):

  `monitor-gcp-gauge-by-group.json`

  ```json
  {
    "_readme": [
      "MONEY-1379 — a GCP-integration GAUGE (or count), grouped, compared to a ceiling.",
      "Used by: pubsub-oldest-unacked, pubsub-dead-letter, workers-saturation,",
      "usfund-saturation, workers-queueing, scheduler-errors.",
      "`max` over the window for gauges: a gauge that TOUCHED the ceiling once in",
      "the window is the question, not its average. `sum` + `.as_count()` for the",
      "scheduler-errors count (agg/suffix placeholders). Scope is always a NAMED",
      "subscription, service or job pattern — never {*} — because the same project",
      "carries local pull subscriptions that are never drained and two algo-*",
      "services we do not own."
    ],
    "name": "[{{env}}] {{label}}",
    "type": "query alert",
    "query": "{{agg}}(last_{{window}}):{{agg}}:{{metric}}{{{scope}}} by {{{group}}}{{suffix}} > {{critical}}",
    "message": "{{message}}\n\n@{{notify}}",
    "tags": [
      "managed-by:apply-perf-monitors",
      "money:1379",
      "family:{{family}}",
      "env:{{env}}"
    ],
    "options": {
      "thresholds": { "critical": "{{critical}}", "warning": "{{warning}}" },
      "notify_no_data": "{{notify_no_data}}",
      "no_data_timeframe": "{{no_data_timeframe}}",
      "renotify_interval": 60,
      "require_full_window": false,
      "include_tags": true
    },
    "_placeholders": [
      "env",
      "label",
      "agg",
      "metric",
      "scope",
      "group",
      "suffix",
      "window",
      "critical",
      "warning",
      "family",
      "message",
      "notify",
      "notify_no_data",
      "no_data_timeframe"
    ]
  }
  ```

  NOTE on `{{{scope}}}` / `{{{group}}}`: the outer braces are literal query
  braces, the inner `{{scope}}` is the placeholder — `fill()` matches
  `\{\{(\w+)\}\}` so the third brace is left alone. `agg` is `max` for rows
  1, 2, 5, 6, 7 and `sum` for row 9; `suffix` is `""` or `.as_count()`.

  `monitor-gcp-ratio-by-group.json` — same skeleton; query
  `"{{agg}}(last_{{window}}):( {{num}} ) / ( {{den}} ) > {{critical}}"` where the
  script passes fully-formed numerator/denominator expressions (row 3's
  two-term numerator and row 8's single term both fit); `agg` is `sum` (row 3)
  or `avg` (row 8). `_readme`: "Used by pubsub-handler-failure and
  gemini-token-quota. remote_server_4xx is NOT in the numerator: it is our own
  dedupe middleware answering 409 RETRY_LATER to a redelivery (F13), a healthy
  signal. The requests quota is NOT a row: its limit is INT64_MAX (measured
  2026-09-11), a ratio that can never cross a threshold."

  `monitor-gcp-percentile.json` — query
  `"avg(last_{{window}}):avg:{{metric}}{{{scope}}} > {{critical}}"`. `_readme`
  must carry the histogram lesson verbatim from `monitor-latency-p95.json`'s
  `_query_form_rationale` first paragraph, then: "`user_execution.p95` is a
  SUB-METRIC the GCP integration ships from Cloud Run's bucketed distribution.
  Query it with `avg:`; `p95:` on the base name asks for a distribution that
  does not exist. Milliseconds: 540000 is 540 s."

- **messages** (the part that matters at 3 a.m.; passed by the script per row via `message_for`):
  - row 1: `Oldest unacked message on {{subscription_id.name}} is past 480s of the 600s ack deadline. A handler is overrunning; at 600s Pub/Sub REDELIVERS while the first copy is still running, the dedupe middleware answers 409 until the lease expires, and after 5 attempts the message is DEAD-LETTERED while the original still succeeds. Check gcp.run.request_latency.user_execution.p95 for the same window, then that handler's RUN_TIME_BUDGET_MS (stock-document-embed has none — MONEY-13xx).`
  - row 2: `Pub/Sub dead-lettered messages on {{subscription_id.name}}. Known causes as of 2026-09-11: stock-document-embed's 600s overrun (MONEY-13xx), and broker-sync's empty-shard 500s — FIXED on fix/MONEY-1379 (T0-B), so broker-sync here after that deploy means the shard guard or the Zerodha-only filter regressed. Anything else is new — read /jobs/dead-letter's [dead-letter] log line for sourceJob.`
  - row 3: `Pub/Sub's OWN count of our push endpoint failing (5xx + unreachable) on {{subscription_id.name}} — independent of app logging. remote_server_5xx is the route throwing; unreachable is the SERVICE down or timing out. 409s are excluded (dedupe RETRY_LATER).`
  - row 4: `p95 handler time on stockbook-workers-prod is past 540s. The ack deadline is 600s; the tail is already being redelivered. Find the route: gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="stockbook-workers-prod" AND httpRequest.latency>"600s"' --freshness=1h --format="value(httpRequest.requestUrl)" | sort | uniq -c`
  - rows 5/6: `{{service_name.name}} is at {{value}} of its maxScale (20 workers / 10 us-fundamentals). New pushes queue (see pending_requests). Either the work per message is too large (the usual cause here) or maxScale needs raising in workers/cloudbuild.prod.yaml.`
  - row 7: `{{value}} requests are queued on stockbook-workers-prod with no instance to take them — instances are at the cap or cold-starting. Pair with instance_count and startup_latencies.p95 on the workers-performance board.`
  - row 8: `Gemini input-token quota for {{model.name}} is at {{value}} of the 20,000,000 tokens/min limit (Google's own gauge). At 100% every research/analysis/chat call gets a 429 and the credit-refund path fires. The REQUESTS quota is unlimited on this tier and is deliberately not monitored.`
  - row 9: `Cloud Scheduler failed to publish {{job_id.name}}'s tick {{value}} times in the last hour (DEADLINE_EXCEEDED on the Publish RPC — GCP-side, not our handler). Sub-hourly jobs retry once automatically (setup-scheduler.sh); 2+ in an hour means the retry also failed or two ticks were lost. gcloud logging read 'resource.type="cloud_scheduler_job" AND severity>=ERROR' --freshness=2h`
    Replace `MONEY-13xx` with the ticket numbers T8 creates (do T8 before T2's
    final commit, or amend). Datadog template variables (`{{value}}`,
    `{{subscription_id.name}}`) use the SAME `{{…}}` syntax as `dd_render`'s
    placeholders — `fill()` throws on any `{{word}}` it has no variable for, so
    these must be written `{{ '{{' }}`-free: pass them from the script as part of
    the `message` VARIABLE VALUE (fill substitutes values verbatim and does not
    re-scan them), never as literal text inside the template file. That is why
    `message` is a placeholder and `message_for` lives in the script.
- **test** T5.
- **done when** `node -e 'JSON.parse(require("fs").readFileSync(f))'` on each; `datadog-scripts-portability.test.ts` unaffected (JSON).

### T3 · `apply-perf-monitors.sh`

- **files** new `scripts/ops/datadog/apply-perf-monitors.sh` (chmod 755); `scripts/README.md` section (T7).
- **how** `cp scripts/ops/datadog/apply-service-monitors.sh scripts/ops/datadog/apply-perf-monitors.sh`, then replace these sections (anchors in F10):
  1. **Header comment (1-37)** — rewrite: what it covers (Pub/Sub, Cloud Run workers, Gemini token quota, scheduler executions), the preflight contract (three outcomes), the scope rule, the sync rule (§C), the F13/F14/F15 findings in two lines each, usage `{qa|prod} [--dry-run] [--only=verify]`.
  2. **Arg parse (40-51)** — add `--only=verify) ONLY=verify ;;` (default `ONLY=`). `--only=verify` renders without writing but DOES list (needs keys).
  3. **`MANAGED_TAG` (90)** → `managed-by:apply-perf-monitors`. Keep `NOTIFY`.
  4. **`ROWS=(` (98-201)** → schema `id|template|agg|metric_or_num|den|scope|group|warn|crit|window|suffix|notify_no_data|envs|family|label` — one row per D2 line. `{{envsuffix}}` in `scope` is substituted by the script from `ENV_ARG` (`prod`/`qa`) BEFORE preflight. Row 3's `metric_or_num` is the two-term expression; row 8's `metric_or_num`/`den` are the usage/limit terms. Messages via a `message_for() { case "$1" in … esac; }` function (bash 3.2: no `declare -A`).
  5. **Loop (252-371)** — per row, in this order:
     - envs skip (unchanged);
     - **scope guard**: `if [[ "$SCOPE" == "*" || -z "$SCOPE" ]] && [[ "$METRIC" == gcp.pubsub.* || "$METRIC" == gcp.run.* ]]; then echo "FATAL: ${ID}: a gcp.pubsub/gcp.run row may not use scope '*' (F1/F2)" >&2; exit 1; fi` — the allow-list for `*` is exactly rows whose metric starts with `gcp.generativelanguage.`; row 9 is scoped so needs no exemption;
     - **preflight** (skipped in dry-run by the helper itself):
       ```bash
       PRE="$(preflight_query "$ROW")"   # rows 1,2,4-7: "max:${METRIC}{${SCOPE}}"; row 3: the denominator "sum:gcp.pubsub.subscription.push_request_count{${SCOPE}}" AND the 5xx term (two calls); row 8: usage AND limit (two calls); row 9: "sum:gcp.logging.log_entry_count{log:cloudscheduler.googleapis.com/executions,job_id:*-prod}" — the UN-sliced series
       rc=0; dd_metric_has_points "$PRE" 3600 || rc=$?
       case "$rc" in
         0) ;;
         1) FAILED+=("${ID}: no points in 1h for ${PRE} — the GCP crawl has stopped, or the scope names nothing; a monitor over it would sit in NO DATA. Not created."); continue ;;
         *) echo "FATAL: ${ID}: preflight did not run (HTTP ${RESPONSE_STATUS}) — DD_APP_KEY, site, or rate limit; refusing to continue" >&2; exit 1 ;;
       esac
       ```
       Row 9's preflight window is 3600 like the rest (info entries arrive every minute during market hours and hourly jobs fill the rest — verified 5,050/6 h);
     - render `VARS` JSON with every placeholder in T2 (`no_data_timeframe` = `3 × window-minutes` computed in bash: `W=${WINDOW%m}; [[ "$WINDOW" == *h ]] && W=$((${WINDOW%h}*60)); NDT=$((W*3))`), `dd_render "$HERE/$TPL" "$VARS"`;
     - **step 6 — empty warning**: `[[ -z "$WARN" ]] && BODY="$(BODY="$BODY" node -e 'const b=JSON.parse(process.env.BODY); delete b.options.thresholds.warning; console.log(JSON.stringify(b))')"` (F11: `Number("")` is 0, and a warning of 0 on a `> 0` monitor is nonsense);
     - collect `RENDERED_NAMES+=("$(name of BODY)")` and `RENDERED_QUERIES+=("$(query of BODY)")`; if `ONLY=verify` → skip upsert; else `dd_upsert_monitor "$ID" "$BODY" || true`.
  6. **After the loop** — `if [[ "$ONLY" == verify ]]; then dd_verify_managed "$MANAGED_TAG" "${RENDERED_NAMES[@]}"; rc=$?; verify_queries; exit $rc; fi` where `verify_queries` compares each rendered query to the live monitor's `query` for names in both and prints `query differs: <name>` (exit 3 if any); then, on a non-dry run, `dd_prune_managed "$MANAGED_TAG" "${RENDERED_NAMES[@]}"`; then the existing FAILED / accounting / summary, with the summary line extended: `applied A, skipped S, pruned P of N rows (env)`.
- **done when** `bash -n` clean; `--dry-run prod` prints 9 bodies + `applied 9, skipped 0, pruned 0 of 9 rows (prod)`; `--dry-run qa` with `DD_QA_MONITORING=on` prints 3 + skips 6 with the "not in envs" line; `qa` without the flag exits 0 with the "disabled" line; `--only=verify prod` against the live org BEFORE the first apply exits 3 with 9 names under "only in code".

### T4 · Sync helpers in `lib-datadog.sh` + `--only=verify` on the two older scripts

- **files** `scripts/ops/datadog/lib-datadog.sh` (append after `dd_upsert_monitor`, :~294); `apply-monitors.sh`, `apply-service-monitors.sh` (arg parse + one call).
- **how**
  ```bash
  # dd_verify_managed TAG NAME...  — 0 in sync / 3 drift / 1 could not list.
  # Read-only. The names are what the caller RENDERED this run; the listing is
  # what Datadog HOLDS under the managed tag. Three sets are printed because
  # each is a different action: an orphan is deleted (or pruned), a missing
  # name is applied, and "in both" is the only state that means what the
  # script says it means.
  dd_verify_managed() {
    local tag="$1"; shift
    dd_list_managed "$tag"        # exits 1 itself on an unreadable listing
    RENDERED="$(printf '%s\n' "$@")" EXISTING="$EXISTING_JSON" node -e '
      const live = new Set(JSON.parse(process.env.EXISTING).map((m) => m.name));
      const code = new Set(process.env.RENDERED.split("\n").filter(Boolean));
      const both = [...code].filter((n) => live.has(n));
      const orphan = [...live].filter((n) => !code.has(n));
      const missing = [...code].filter((n) => !live.has(n));
      const row = (h, xs) => console.log(`${h.padEnd(22)} ${xs.length}` + (xs.length ? "\n  - " + xs.join("\n  - ") : ""));
      row("in both", both); row("only in Datadog", orphan); row("only in code", missing);
      process.exit(orphan.length + missing.length ? 3 : 0);
    '
  }
  # dd_prune_managed TAG NAME... — DELETE every live monitor under TAG whose
  # name was not rendered. Sets PRUNED. Never called in dry-run (no listing).
  dd_prune_managed() {
    local tag="$1"; shift
    PRUNED=0
    dd_list_managed "$tag"
    local victims
    victims="$(RENDERED="$(printf '%s\n' "$@")" EXISTING="$EXISTING_JSON" node -e '
      const code = new Set(process.env.RENDERED.split("\n").filter(Boolean));
      for (const m of JSON.parse(process.env.EXISTING)) if (!code.has(m.name)) console.log(`${m.id}\t${m.name}`);
    ')"
    [[ -z "$victims" ]] && return 0
    while IFS=$'\t' read -r id name; do
      if dd_request DELETE "https://${DD_API_HOST}/api/v1/monitor/${id}"; then
        echo "   pruned ${name} (#${id})"; PRUNED=$((PRUNED + 1))
      else
        FAILED+=("prune ${name} (#${id}): HTTP ${RESPONSE_STATUS} ${RESPONSE_BODY}")
      fi
    done <<< "$victims"
  }
  ```
  bash 3.2: no `mapfile`, no `${x^^}`, no `declare -A` (the portability test scans every `*.sh` here). In `apply-monitors.sh` and `apply-service-monitors.sh`: add `--only=verify` to the arg parse, collect rendered names in their loops (lift the `node -e … .name` line from `dd_upsert_monitor` into the loop before the upsert), and after the loop `[[ "$ONLY" == verify ]] && { dd_verify_managed "$MANAGED_TAG" "${RENDERED_NAMES[@]}"; exit $?; }`. Under `ONLY=verify` the loop must not write (set a `WRITE=false` guard around `dd_upsert_monitor`, NOT `DRY_RUN=true` — dry-run skips preflights and listing, verify needs the listing).
- **test** in T5 (helpers are exercised through the new script); plus one case each in `monitor-agreement.test.ts` and `service-monitors-agreement.test.ts`: `--only=verify` against a stub listing that holds every rendered name → exit 0 and NO `-X POST`/`-X PUT` in the curl log; drop one name from the stub listing → exit 3 and the name printed under `only in code`.
- **done when** all three scripts answer `--only=verify`; portability test green.

### T5 · `perf-monitors-agreement.test.ts`

- **files** new `packages/datadog/__tests__/perf-monitors-agreement.test.ts`. Copy `service-monitors-agreement.test.ts:37-215` (constants, NO_NET stub, `render()`, `runWithStubbedCurl()`), change `SCRIPT`, and extend the stub with two env-driven behaviours: `STUB_EMPTY_FOR` (if `"$*"` contains it → body `{"series":[]}`), and a `-X DELETE` branch (status `$STUB_WRITE_STATUS`, body `{"deleted_monitor_id":1}`), logging every call. Give `runWithStubbedCurl` an `args` parameter (default `["prod"]`) so `--only=verify` can be driven.
- **cases** (each with the mutation that must be seen red):
  1. PREMISE: `render("prod")` yields exactly **9** bodies; each parses; no key starting with `_` at ANY depth (walk recursively); `render("qa")` (with `DD_QA_MONITORING=on`) yields 3. _Mutation:_ comment out a row → 8 → red.
  2. **Scope by name:** every query whose metric starts with `gcp.pubsub.` or `gcp.run.` contains `subscription_id:*-prod-push` or `service_name:stockbook-workers-prod` / `us-fundamentals-prod`, and none contains `{*}`; the only `{*}` bodies are the `gcp.generativelanguage.` one. _Mutation:_ set row 1's scope to `*` → the SCRIPT exits 1 with the FATAL (assert the dry-run itself fails — the guard is in code, not only in this test).
  3. **Sub-metric with `avg:`:** the `workers-handler-time` body's query matches `/^avg\(last_15m\):avg:gcp\.run\.request_latency\.user_execution\.p95\{/` and does NOT contain `p95:gcp`. _Mutation:_ `avg:` → `p95:` in the template → red.
  4. **Derived thresholds, with units:** parse `critical` from the query; row 1's < 600 and > 420 (read `RUN_TIME_BUDGET_MS` from `workers/src/processors/stock-document-extract-logic.ts` by regex `/export const RUN_TIME_BUDGET_MS = ([\d_]+)/`, `/1000`); row 4's critical is **540000** and its warning **480000** (ms) — assert `> 100000` so a future "540" (seconds, wrong) is red; row 9's critical is 1 and warning 0; `options.thresholds.critical` is a NUMBER (not string) in every body. _Mutation:_ write 540 → red.
  5. **Empty warning is ABSENT:** row 2's body has no `options.thresholds.warning` key; every other body has one. _Mutation:_ delete the post-render `delete` line in the script → row 2 carries `warning: 0` → red.
  6. **Preflight, three outcomes:** (a) `STUB_EMPTY_FOR=oldest_unacked` → exit 1, stderr contains `pubsub-oldest-unacked: no points in 1h`, curl log has 8 writes not 9; (b) status `403` on preflight → exit 1, stderr contains `preflight did not run (HTTP 403)`, curl log has ZERO `-X POST`; (c) row 9 preflights the UN-sliced query — the curl log's GET for `log_entry_count` must NOT contain `severity` (URL-decoded). _Mutation:_ make (a) and (b) share a message → (b)'s assertion on "did not run" goes red.
  7. **Upsert idempotent:** listing holds all 9 names → 9 `-X PUT`, 0 `-X POST`, 0 `-X DELETE`.
  8. **Prune:** listing holds the 9 PLUS `[production] stale perf monitor` (any tags) → exactly one `-X DELETE …/monitor/<id>` and stdout `pruned [production] stale perf monitor (#<id>)`; `--dry-run` reaches curl NEVER (the NO*NET case already proves it), so there is no dry-run prune to assert. \_Mutation:* remove the prune call → red.
  9. **Verify:** `--only=verify` with the full listing → exit 0, stdout has `in both 9`, no writes; listing minus one → exit 3, `only in code 1` naming it; listing plus a stranger → exit 3, `only in Datadog 1`; listing holds all 9 names but row 4's `query` altered → exit 3 with `query differs: [production] …handler time…`.
  10. `notify_no_data` true on rows 1,4,5,6,7,8 with `no_data_timeframe` = 3× window; false on 2,3,9. _Mutation:_ flip row 2 → red.
  11. Tags: every body has `managed-by:apply-perf-monitors` and `money:1379`, and NO body carries `managed-by:apply-monitors` (an `apply-slos.sh` listing must not see them).
  12. Messages: every body's `message` ends with `@deepshaswat@gmail.com` (default `NOTIFY`); rows 1 and 2 mention the embed ticket number (regex `MONEY-\d{4}`) and row 2 names `T0-B`; no body's message contains the literal text `{{` followed by a word that is one of dd_render's placeholders (i.e. the Datadog template variables survived as `{{value}}`, `{{subscription_id.name}}` — assert those two ARE present in rows 1 and 5).
  13. Portability: `datadog-scripts-portability.test.ts` picks the file up by glob — just run it.
- **done when** all green; mutations 2, 3, 4, 5, 6, 8 each seen red; `TEST-COVERAGE.md` row added.

### T6 · The board — `scripts/ops/datadog/dashboards/workers-performance.json`

- **files** new; `apply-dashboards.sh` globs `dashboards/*.json` (`:80`) and upserts by title — no script change. T1 adds the name to `EXPECTED_BOARDS`.
- **shape** copy `job-health.json`'s top level: `_ticket: "MONEY-1379"`, `_why: [...]`, `title: "UseMoney — workers performance"`, `description: "managed-by:apply-dashboards — edit the file, not the UI"`, `layout_type: "ordered"`, `template_variables: [{"name":"env","prefix":"env","default":"production"}]` — NOTE `gcp.*` series carry NO `env` tag; scope by name instead and leave `$env` in the variable list only for symmetry (do not put `{$env}` in any `gcp.` query — it would match nothing). Widgets are `{ "definition": { "type", "title", "_why", "requests": [{ "q": … }], "time": { "live_span": … }, "markers": [...] } }`. Every `q` must match `METRIC_RE` — i.e. start `<agg>:<metric>{` (a `top(…)` wrapper still contains `max:gcp.…{`, which matches). Widgets, in order (`_why` each; 17 widgets):
  1. `note` — `"Every series here is supplied by the GCP integration (MONEY-1379) and preflighted by apply-perf-monitors.sh before any monitor exists over it. No env tag on gcp.* — scoped by name. LLM Observability widgets land in the phase-2 PR once ml_obs.* has been observed (MONEY-1380)."`
  2. `timeseries` "Pub/Sub — oldest unacked message age, top 10 (s)": `q: "top(max:gcp.pubsub.subscription.oldest_unacked_message_age{subscription_id:*-prod-push} by {subscription_id}, 10, 'max', 'desc')"`, markers `[{"value":"y = 600","display_type":"error dashed","label":"ack deadline 600s"},{"value":"y = 480","display_type":"warning dashed","label":"monitor crit 480"}]`, `live_span: "4h"`.
  3. `timeseries` "Pub/Sub — the 12 analysis/LLM subscriptions, oldest unacked (s)": `max:gcp.pubsub.subscription.oldest_unacked_message_age{subscription_id IN (stock-research-prod-push,portfolio-roast-prod-push,l3-analysis-prod-push,research-preview-plan-prod-push,login-briefing-prod-push,comparison-analysis-prod-push,strategy-scan-prod-push,studio-render-prod-push,proactive-analysis-prod-push,stock-document-ingest-prod-push,us-filing-insight-prod-push,stock-document-embed-prod-push)} by {subscription_id}`, same markers.
  4. `toplist` "Pub/Sub — undelivered messages by subscription": `top(max:gcp.pubsub.subscription.num_undelivered_messages{subscription_id:*-prod-push} by {subscription_id}, 20, 'max', 'desc')`, `1h`.
  5. `query_value` "Dead-lettered (24h)": `sum:gcp.pubsub.subscription.dead_letter_message_count{subscription_id:*-prod-push}.as_count()`, `conditional_formats: [{"comparator":">","value":0,"palette":"white_on_red"}]`, `1d`.
  6. `timeseries` "Pub/Sub — push responses by class (stacked)": `sum:gcp.pubsub.subscription.push_request_count{subscription_id:*-prod-push} by {response_class}.as_count()`, `display_type: "bars"`, `4h`.
  7. `toplist` "Pub/Sub — 5xx + unreachable by subscription (1h)": `top(sum:gcp.pubsub.subscription.push_request_count{subscription_id:*-prod-push,response_class IN (remote_server_5xx,unreachable)} by {subscription_id}.as_count(), 15, 'sum', 'desc')`.
  8. `timeseries` "Cloud Run — instances vs cap": two requests `max:gcp.run.container.instance_count{service_name:stockbook-workers-prod}` and `…{service_name:us-fundamentals-prod}`, markers `y = 20` (error, "workers maxScale") and `y = 10` (warning, "us-fundamentals maxScale"), `4h`.
  9. `timeseries` "Cloud Run workers — handler time p95 / p99 / avg (ms)": three requests over `gcp.run.request_latency.user_execution.{p95,p99,avg}{service_name:stockbook-workers-prod}` with `avg:` aggregator; markers `y = 600000` (error, "ack deadline"), `y = 540000` (warning, "monitor crit"), `y = 420000` (info, "RUN_TIME_BUDGET_MS"), `4h`.
  10. `timeseries` "Cloud Run workers — pending requests": `max:gcp.run.pending_queue.pending_requests{service_name:stockbook-workers-prod}`, marker `y = 5`, `4h`.
  11. `timeseries` "Cloud Run workers — CPU / memory utilisation p95": `avg:gcp.run.container.cpu.utilizations.p95{service_name:stockbook-workers-prod}` and `avg:gcp.run.container.memory.utilizations.p95{…}`, `4h`.
  12. `timeseries` "Cloud Run workers — requests by response class": `sum:gcp.run.request_count{service_name:stockbook-workers-prod} by {response_code_class}.as_count()`, bars, `4h`.
  13. `timeseries` "Cloud Run workers — cold-start latency p95 (ms)": `avg:gcp.run.container.startup_latencies.p95{service_name:stockbook-workers-prod}`, `1d`.
  14. `timeseries` "Cloud Run workers — max request concurrency p95": `avg:gcp.run.container.max_request_concurrencies.p95{service_name:stockbook-workers-prod}`, `4h`.
  15. `timeseries` "Gemini — input-token quota utilisation by model": `avg:gcp.generativelanguage.quota.generate_content_paid_tier_3_input_token_count.usage{*} by {model} / avg:gcp.generativelanguage.quota.generate_content_paid_tier_3_input_token_count.limit{*} by {model}`, markers `y = 0.85` (error), `y = 0.7` (warning), `4h`. `_why`: "requests quota limit is INT64_MAX — unlimited — so tokens are the only ceiling."
  16. `timeseries` "Gemini — requests/min by model (no ceiling)": `avg:gcp.generativelanguage.quota.generate_content_paid_tier_3_requests.usage{*} by {model}`, `1d`.
  17. `timeseries` "Cloud Scheduler — failed attempts by job (executions log)": `sum:gcp.logging.log_entry_count{log:cloudscheduler.googleapis.com/executions,severity:error,job_id:*-prod} by {job_id}.as_count()`, bars, `1w`.
- **test** `dashboards-agreement.test.ts`: the render/inventory cases pick the board up automatically once it is in `EXPECTED_BOARDS`; add three cases: (i) the oldest-unacked widget (#2) carries a marker at exactly `y = 600` derived from `workers/scripts/setup-pubsub.sh` (`/--ack-deadline=(\d+)/`, first match); (ii) the handler-time widget (#9) carries a marker at `y = 600000` and the `workers-handler-time` monitor's critical (rendered via `apply-perf-monitors.sh --dry-run prod`) is < that marker — the board and the alarm agree on units; (iii) no `gcp.` query on this board contains `$env` (would match nothing). _Mutation:_ change the marker to `y = 600000` on #2 → (i) red.
- **done when** `apply-dashboards.sh prod --dry-run` renders it; a real run creates it; opened, every widget has data within one crawl (~10 min).

### T7 · Docs

- `CLAUDE.md` §Datadog Observability: the script table gains `apply-perf-monitors.sh | 9 prod / 3 qa-when-enabled PERF monitors — Pub/Sub, Cloud Run workers, Gemini tokens, scheduler executions; prunes its own orphans; every apply script answers --only=verify`; a paragraph on UNITS (ms vs s) and the INT64_MAX quota; replace the "No monitors yet, same rule. The first candidates…" paragraph in the GCP-integration section with the 9-row summary; in "Job throughput — the 600s ceiling": add a row `stock-document-embed | 200 | 1,200–3,600s WALL CLOCK, no budget | NEGATIVE — MONEY-13xx` and the dedupe→409→dead-letter mechanism (F13) in two sentences.
- `docs/reference/datadog-monitoring-plan.md`: T14 → "monitors DONE for Pub/Sub + workers + Gemini tokens + scheduler; ml_obs rows written (§3), gated on observation".
- `scripts/README.md`: new section `### ops/datadog/apply-perf-monitors.sh {qa|prod} [--dry-run] [--only=verify] (MONEY-1379)` after the `apply-service-monitors.sh` section (:467), same depth; note `--only=verify` on the other two; note the retry rule under the `setup-scheduler.sh` section.
- `TEST-COVERAGE.md`: rows for `perf-monitors-agreement.test.ts` (13), `scheduler-retry.test.ts` (3) and `sync-leaf.test.ts` (3); `broker-sync.test.ts` 17 → 23; `dashboards-agreement` count +5, `monitor-agreement` +1, `service-monitors-agreement` +1; headline file count +3 (`yarn test:coverage-check` must pass).
- `CLAUDE.md` MONEY-837 block (Environment Variables → Broker APIs): one line — "**Broker SYNC is Zerodha-only (both connectors) as of 2026-09-11** — `SYNC_ENABLED_BROKERS` in `packages/services/src/broker-sync.service.ts`; the scheduled fan-out selects only those, an empty shard is a no-op, and the historical leg is sharded by `syncBucket` like the daily one (T0-B)."
- **The plans live in the repo too** (founder rule 2026-09-11: "all docs should be available in the repo"): `docs/reference/money-1379-perf-monitors-plan.md` (this document) and `docs/reference/money-1379-1380-datadog-gcp-llmobs-plan.md` (the original) are already copied into the working tree, UNTRACKED — commit them on `fix/MONEY-1379` in the first docs commit. The repo copy is canonical once committed; when a task changes the plan, edit the repo copy and `cp` it back to `archive-docs/reports/2026-09-11-…` so the two do not drift. `datadog-monitoring-plan.md` gets a one-line pointer to both.

### T8 · Tickets — created by Opus via the Linear MCP (plugin tools), team `UseMoney`

Dup-check first with `list_issues query:"<title keyword>"` (done for "stock-document-embed" today: MONEY-1307 is the EXTRACT in-flight-claim ticket, In Progress, no project — related, not a duplicate; link it). Labels: use existing `worker`, `ai`, `infrastructure` (verified on MONEY-783/277); check `list_issue_labels` for `performance` and add it if present. Priority per body. Then comment on MONEY-1379 with the two ticket ids plus a one-paragraph note that the broker-sync defect (F14) is fixed on the branch (T0-B), and on MONEY-1380 with T8-1's id (it is the embeddings follow-up CLAUDE.md already names).

**T8-1 · `stock-document-embed` runs 20–60 min per message against a 600s ack deadline — no run budget, no chain; 423 overruns in 7d, 368 dead-letters/day, workers pinned at maxScale**

- project **StockSage 2.0 — Vertex RAG · Doc/Video Intelligence · Self-Learning Memory** (`9cd1af66-69ae-4c8c-85f0-4db1010027a0`) — the doc-ingest pipeline's home (MONEY-783/798 live there); labels `worker`, `ai` (+`performance` if it exists); priority **High**; link MONEY-1307, MONEY-1337, MONEY-1379.
- body: F15 verbatim (numbers, file:line), the timeline in §B, the fix shape in §B with the exact anchors (`stock-document-embed.ts:109` signature, `:199` loop, `:360-366` delay; copy `RUN_TIME_BUDGET_MS`/`MAX_CHAIN_DEPTH`/chain-publish from `stock-document-extract-logic.ts:501` and `stock-document-extract.ts:727-760`), acceptance: (a) `-logic.ts` seam: `shouldStopForBudget(startedAt, now)` pure + test; (b) processor stops between documents past 420 s and publishes ONE follow-up with `chainDepth+1`, none at depth 20; (c) mutation test: remove the budget check → a 3-doc fixture with a 1 ms budget still processes 3 → red; (d) measured after deploy: `gcloud logging read … httpRequest.latency>"600s" AND requestUrl:"stock-document-embed"` = 0 over 24 h, `dead_letter_message_count{subscription_id:stock-document-embed-prod-push}` = 0; (e) `CLAUDE.md` 600 s table row updated. Out of scope: removing `DELAY_BETWEEN_BATCHES_MS` (measure first), Pub/Sub ack-deadline extension (600 is the maximum).

**T8-2 · WITHDRAWN — the broker-sync fix is on this branch as T0-B** (founder decision 2026-09-11). No ticket; the MONEY-1379 comment records it. If a follow-up is wanted later — skipping the publish of leaves for buckets with zero Zerodha connections in `fanOutScheduledSync` (`sync.ts:443`, one `groupBy syncBucket` query) — file it in **Broker Integration** (`65c9a910-f8ac-4c9c-9494-e3d9d74057d8`) only after T0-B's 24 h numbers show the 64 cheap 200s matter.

**T8-3 · (optional, Low) dead-letter consumer: a redelivery that exhausted 5 attempts on 409 RETRY_LATER is not a failure**

- project **Performance, Observability & Reliability** (`f04892fd-0155-4119-81ee-35f1643ba0ec`); labels `worker`, `infrastructure`; priority Low; link T8-1.
- body: F13. The consumer (`dead-letter-consumer.ts`) could read the dedupe store for the messageId: if a claim is LIVE or COMPLETED, log `parked-while-running` and do not notify. Note it is a symptom of T8-1 and may be moot once every handler respects the budget; file it so the founder decides.

### T9 · Gates

`yarn build` before each commit (workers are NOT type-checked by build — `verify:push` runs type-check first and is required) · `yarn verify:push` (full suite) · **`/code-review high` on the DELTA** (from `3bb85e93` onward; the review's own fixes get a second pass) · push only after the marker is fresh; commit, wait for the graphify rebuild to go idle, THEN gate, THEN push in a separate call (the hook regex-matches `git push` inside heredocs and chains).

### T10 · Founder runbook after merge

1. `./scripts/ops/setup-scheduler.sh prod` — the four `news-rss-sync` jobs get `retryCount: 1`; EVERY OTHER JOB gets an explicit `0`, including `alert-evaluator-market-hours-prod`, which was removed from the allow-list on review (its cooldown is a read-then-write, so two overlapping runs both notify a user). Verify with `gcloud scheduler jobs describe news-rss-sync-market-hours-prod --location=asia-south1 --format="value(retryConfig.retryCount)"` → `1`; the same command on `alert-evaluator-market-hours-prod` correctly returns `0`.
2. `scripts/ops/datadog/apply-perf-monitors.sh prod --only=verify` → exit 3, 9 names "only in code". Then `… prod` → 9 created, 0 pruned. Re-run → 9 updated. **Expect three alerts within 15 minutes:** `pubsub-dead-letter` (broker-sync, embed), `pubsub-handler-failure` (broker-sync 0.98), and `workers-handler-time` whenever an embed batch is running. They are real; do not mute them. The two broker-sync ones resolve once this branch reaches the RELEASE deploy of the workers (T0-B ships in the same PR — main → release → Cloud Build); the embed ones resolve when T8-1 lands.
3. `scripts/ops/datadog/apply-dashboards.sh prod` — the board appears.
4. `DD_QA_MONITORING=on` decision → `apply-perf-monitors.sh qa` creates the 3 Pub/Sub rows for QA.
5. Add `apply-perf-monitors.sh prod --only=verify` to the morning-triage routine; exit 3 = drift.
6. After the QA workers deploy (MONEY-1380): once `ml_obs.*` has points, the phase-2 PR codes §3.
7. SDS for LLM Obs is a console step (SDS → _Agent Observability Settings_), before prod LLM Obs arms.

---

## 3. Phase 2 — LLM Obs monitors, WRITTEN NOW, CODED AFTER OBSERVATION

| Monitor                         | Query core                                                                                                                  | Threshold                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Research run duration           | `avg(last_30m):avg:ml_obs.span.duration{ml_app:research,span_kind:workflow}`                                                | warn 240 s, crit 420 s                  |
| Model error rate per ml_app     | `sum:ml_obs.span.error{span_kind:llm} by {ml_app}.as_count() / sum:ml_obs.span.count{span_kind:llm} by {ml_app}.as_count()` | crit 10 % over 30 m                     |
| Token spend velocity per ml_app | `sum(last_1h):sum:ml_obs.span.llm.output_tokens{env:production} by {ml_app}.as_count()`                                     | crit = 3× the observed 7-day hourly p95 |
| Claude router share             | `{model_provider:anthropic}` / `{span_kind:llm}`                                                                            | widget only                             |

The implementer confirms the exact names in the catalogue the day spans arrive (F18); none is created until `dd_metric_has_points` returns 0 for it.

---

## 4. Out of scope in this pass (deliberate, recorded)

- Cloud Logging → Datadog forwarding (Push subscriptions deprecated by Datadog; Dataflow pull recommended) — not needed for scheduler visibility any more (F8). `stdout`/`stderr` from `cloud_run_revision` must NEVER be forwarded — pino multistreams to Datadog already (`packages/logger/src/index.ts`), so a sink would bill every app line twice.
- Resource-change collection, BQ toggles, GCE/GCS boards, `host_filters`.
- SLOs (D6). `price-sync` overruns (F16). Pruning for the two older apply scripts (§C).

## 5. Re-derivation commands (so nothing above has to be trusted)

```bash
G="gcloud --account=founder@disdigital.in --project=stock-book-483718"; export CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook
# scheduler target type + retry
$G scheduler jobs describe alert-evaluator-market-hours-prod --location=asia-south1 --format=yaml
# scheduler failures 30d
$G logging read 'resource.type="cloud_scheduler_job" AND severity>=ERROR' --freshness=30d --format="value(jsonPayload.jobName,jsonPayload.status,timestamp)"
# embed overruns 7d
$G logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="stockbook-workers-prod" AND httpRequest.latency>"600s"' --freshness=7d --limit=2000 --format="value(httpRequest.requestUrl)" | sort | uniq -c
# broker-sync cause (pino lines land at DEFAULT severity — never filter severity>=ERROR for app text)
$G logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="stockbook-workers-prod" AND jsonPayload.msg:"No broker connections found"' --freshness=3h --limit=5 --format="value(jsonPayload.msg)"
# dead-letter sources 24h
$G logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="stockbook-workers-prod" AND textPayload:"dead-letter"' --freshness=1d --limit=1500 --format="value(textPayload)" | grep -o 'sourceSubscription":"[^"]*' | sort | uniq -c
# Datadog (keys from Secret Manager DD_API_KEY_PROD / DD_APP_KEY_PROD; site us5)
#   units:      GET /api/v1/query?query=max:gcp.run.request_latency.user_execution.p95{service_name:stockbook-workers-prod}
#   quota:      GET /api/v1/query?query=max:gcp.generativelanguage.quota.generate_content_paid_tier_3_requests.limit{*} by {model}   -> 9223372036854775807
#   scheduler:  GET /api/v1/query?query=sum:gcp.logging.log_entry_count{log:cloudscheduler.googleapis.com/executions,job_id:*-prod} by {severity}.as_count()
#   classes:    GET /api/v2/metrics/gcp.pubsub.subscription.push_request_count/all-tags
#   catalogue:  GET /api/v1/metrics?from=<epoch-24h>
```
