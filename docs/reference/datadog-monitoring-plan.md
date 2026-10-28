# Datadog monitoring build-out — task list

Branch: `feat/MONEY-1229`, cut from `main` at `e8daf609` after PR #401 merged
(the earlier `fix/MONEY-1332` carried the US5 site change and the candle-sink
fix into `main`; both are already in place here). Everything in this batch
rides this one branch. Umbrella ticket: MONEY-1229. Goal: every scheduled job, service and
the web app report to the new Datadog org (US5) with monitors that FIRE, one
week of clean data, and then the performance work starts on top of it.

This file is written so the implementing session does not have to research:
every task names its files, line anchors (as of commit `2cd685e7`), the exact
design, the tests with their mutation checks, the docs to touch, the
verification commands and the acceptance. Runtime facts that only a live call
can answer are marked **RUNTIME CHECK** with the exact command.

Companion documents: the founder runbook and measured state are in
`archive-docs/reports/datadog-account-migration-sep2026.md` (outside the repo);
the ticket trail is on MONEY-1229.

---

## Ticket map

| Task       | Ticket                                                                                      | State 2026-09-05                          |
| ---------- | ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| T1, T2     | MONEY-1278                                                                                  | Backlog; fix chosen in a comment          |
| T3, T3b    | MONEY-1357                                                                                  | Backlog, new                              |
| T4         | MONEY-1331                                                                                  | Backlog                                   |
| T5         | MONEY-1266, MONEY-1293 (monitoring half), MONEY-1358 (US rows)                              | Backlog / Todo / new                      |
| T6         | MONEY-1359                                                                                  | Backlog, new                              |
| T7         | MONEY-1360                                                                                  | Backlog, new                              |
| T8         | MONEY-1361                                                                                  | Backlog, new                              |
| T9         | MONEY-1362                                                                                  | Backlog, new                              |
| T10        | MONEY-726                                                                                   | Backlog                                   |
| T11        | MONEY-716                                                                                   | Backlog                                   |
| T12        | MONEY-1229                                                                                  | In Progress                               |
| T13        | MONEY-1380                                                                                  | Done, new                                 |
| T14        | MONEY-1379                                                                                  | Done — 9 perf monitors + board; see below |
| deferred   | MONEY-718 (Vercel APM), MONEY-455 (status page)                                             | Backlog / Todo                            |
| superseded | MONEY-1363 (hand-rolled LLM token/cost counters) — by MONEY-1380's native LLM Observability | Close it; see T13                         |

---

## 0. Ground rules for this branch

### 0.1 A second Claude session is editing this working tree

Same checkout, same branch, at the same time. The rules that keep the two from
overwriting each other:

1. **Before every task**, run `git status --short`. Every file that is dirty
   and NOT yours is LOCKED. Do not edit it. If a task needs a locked file,
   finish the rest of the task, leave that file's step in the "deferred"
   list at the bottom of this document, and say so in the commit body.
   **Lock state at the start of this batch: NONE.** The other session's lane
   (doc-ingest, MONEY-1332/1334) merged as PR #401 (`e8daf609`) and left its
   files clean, so this batch covers them too: T1 has no deferred step and its
   guard needs no exemption. That is a snapshot, not a standing fact — if a
   second session starts again its files become locked the moment they go
   dirty, which is why rule 1 is re-read `git status` every task, not once.
2. **Edit, never rewrite.** Use exact-string edits on existing files, and
   re-read the file immediately before each edit. Use whole-file writes ONLY
   for new files. A whole-file write of an existing file is how the other
   session's work gets silently erased.
3. **Stage by explicit path.** Never `git add -A`, `git add .`, `git add -u`.
   Never `git stash`, `git checkout -- <file>`, `git reset`, or switch branch.
4. **Shared documents are the collision points**: `TEST-COVERAGE.md`,
   `CLAUDE.md`, `scripts/README.md`, `docs/env-vars-reference.md`. Edit them
   with one-line anchors, in the SAME commit as the code they describe, and
   commit promptly. Re-read right before the edit.
5. **Commit after every task**, once its own tests are green. One commit per
   task, message `type(MONEY-n): …`, ending with the Co-Authored-By and
   Claude-Session trailers the session uses.
6. **The verify marker is content-hash keyed.** `.claude/.verify-ok` is
   invalidated by ANY edit, including the other session's. Run
   `yarn verify:push` ONCE at the end of the batch, when the founder confirms
   the other session is idle. Concurrent full-suite runs fail at the TASK
   level under CPU contention (memory: `VERIFY_SERIAL=1` is the fallback).
   Per-task, run only the targeted test files named in each task.
7. **Never touch `.claude/.verify-ok`.**

### 0.2 Verification cadence per task

```
targeted tests (named in the task)  ->  mutation check (named)  ->
prettier --check on touched files   ->  commit
```

`yarn build` once per phase (it is ~2.5 min), `yarn verify:push` once at the
end. `packages/datadog` has no ESLint 9 config, so its `lint` script fails on
every file regardless — pre-existing, ignore.

### 0.3 What "wired" means here

A monitor, dashboard or SLO is not done when the JSON exists. It is done when
the series it reads has POINTS on the new org and the object was seen in the
Datadog UI (or listed by the API). Every apply script in this plan therefore
carries a "series has points" preflight and fails closed. This is the whole
history of `packages/datadog` (MONEY-1238: five ways a monitor could not fire).

---

## 1. Measured state (2026-09-05)

| Surface                                             | State                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Org                                                 | US5. Code moved to `us5.datadoghq.com` in commit `4350a4e9`; `site-agreement.test.ts` pins all 7 surfaces.                                                                                                                                                                                                                           |
| Secrets                                             | `DD_API_KEY_PROD` / `DD_API_KEY_QA` exist (old org's values still live on us3). `DD_APP_KEY_PROD` / `DD_APP_KEY_QA` do not exist yet — founder mints in the UI.                                                                                                                                                                      |
| Sidecar + key                                       | `stockbook-workers-{prod,qa}`, `us-fundamentals-{prod,qa}`.                                                                                                                                                                                                                                                                          |
| Dark                                                | `tiingo-realtime-{prod,qa}`: no DD env, no sidecar, no key. Image bakes `DD_TRACE_ENABLED=true`, `DD_SERVICE=stockbook-workers`.                                                                                                                                                                                                     |
| Python jobs                                         | 5 `edgar-*` × 2 envs: `DD_SERVICE`+`DD_ENV` only, one container. DogStatsD to 127.0.0.1:8125 with nobody listening.                                                                                                                                                                                                                  |
| TS jobs                                             | All 17: NO `DD_*` env. `datadog-metrics` no-ops without `DD_API_KEY`. `feed-parse` is in `MONITORED_JOBS` for both envs → born NO DATA.                                                                                                                                                                                              |
| Monitor set                                         | `apply-monitors.sh prod --dry-run` = 38 (36 zero-write + 1 latency + 1 absence); `qa` = 12.                                                                                                                                                                                                                                          |
| Custom metrics that EXIST (TS, prefix `stockbook.`) | `job.selected/written/failed/transport_failures{job}`, `cache.hit{layer}`, `cache.miss`, `broker.sync.duration/records/failure`, `pairing.trades_processed`, `trade.pairing.failure`, `feed.archive.replay.degraded`. Python: the same four `job.*` + `edgar.detect_latency_seconds` (histogram). There is NO LLM token/cost metric. |
| Logs                                                | Workers/web/api ship pino JSON to the HTTP intake with `level` as a LABEL (`config.ts:90-92`), `ddsource:nodejs`, `service`, `ddtags:env:…`. Python service logs JSON to stdout (sidecar) via `install_logging()`.                                                                                                                   |
| RUM                                                 | `DatadogRumProvider.tsx`; SDK 6.26.0 buffers `addError` before `init` (`browser-rum-core/cjs/boot/preStartRum.js` `bufferApiCalls`).                                                                                                                                                                                                 |

---

## 1.5 US stack coverage map

Every US-market surface, the signal that watches it after this batch, and the
task that wires it. "None" today means dark.

| Surface                                                                   | Runs as                                                          | Signal after the batch                                                                                                                          | Task / ticket                         |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `us-eod-sync` (Tiingo EOD + NAV legs)                                     | workers service, Tue–Sat 11:00 IST, PROD_ONLY                    | zero-write row (96h) — already in the set                                                                                                       | none needed                           |
| `us-instrument-master-sync`                                               | workers service, both envs                                       | zero-write row (96h) — already in the set                                                                                                       | none needed                           |
| `tiingo-news-poll`                                                        | workers service, every 2 min all days, PROD_ONLY                 | **new** zero-write row (2h) + absence row (2h)                                                                                                  | T5 / MONEY-1358                       |
| `tiingo-realtime` service (24×5 socket, quotes, M1 bars)                  | its own Cloud Run service, minScale 1                            | **new** APM service, `rt.*` metrics, `rt.health_ok` liveness monitor, `rt.bars_closed` absence 96h, `stepping down` log monitor, APM error rate | T3, T3b / MONEY-1357, T6 / MONEY-1359 |
| `candle-evict`                                                            | workers service, daily 15:00, PROD_ONLY, disarmed                | **new** absence row (36h) — zero-write is the wrong signal while disarmed                                                                       | T5 / MONEY-1266                       |
| `tiingo-us-*-backfill`, `bse-backfill`, `feed-*`, `xbrl-*` Cloud Run JOBS | TS jobs                                                          | metrics path (key + flush); `feed-parse` monitored at 96h                                                                                       | T1 / MONEY-1278, T5 / MONEY-1358      |
| `edgar-detect` (+ hourly reconcile, weekly full-index)                    | us-fundamentals service, minutely, PROD_ONLY                     | zero-write row (6h) + p95 latency (300 s) — already in the set; APM error rate on `fastapi.request`                                             | T6 / MONEY-1359                       |
| `edgar-bulk-ftd`                                                          | Python job, 3rd/10th/18th/25th, PROD_ONLY, **armed on prod**     | **new** zero-write row (12d) after the HTTP metrics path                                                                                        | T2 / MONEY-1278, T5 / MONEY-1358      |
| `edgar-bulk-submissions`, `edgar-bulk-companyfacts`                       | Python jobs, daily 13:00 + 16:00 retry, PROD_ONLY, armed on prod | **new** zero-write rows (36h) — only after the `selected=0`-on-no-op runtime check                                                              | T5 / MONEY-1358                       |
| `edgar-xbrl-backfill`, `edgar-ownership-backfill`                         | Python jobs, hand-run                                            | metrics path only; no clock, so no monitor (documented)                                                                                         | T2 / MONEY-1278                       |
| `edgar-evict`                                                             | Python job, daily, `EDGAR_EVICT_APPLY=false` by design           | stays excluded until armed (MONEY-979 §11)                                                                                                      | none                                  |
| `edgar-parse-*` (5 event-driven parsers)                                  | us-fundamentals service via Pub/Sub                              | watched through `edgar-detect`'s zero-write row; outcome lines in Cloud Logging                                                                 | T4 / MONEY-1331                       |
| Python job outcome lines                                                  | all `app/bulk` + `app/jobs`                                      | land in Cloud Logging; reachability guard                                                                                                       | T4 / MONEY-1331                       |
| US dashboards                                                             | —                                                                | `us-market` board                                                                                                                               | T8 / MONEY-1361                       |
| US licence gate (`US_MARKET_ALLOWED_EMAILS`)                              | apps/web, apps/api                                               | not a monitoring concern; unchanged                                                                                                             | —                                     |

Site: the org is US5 (`us5.datadoghq.com`), already pinned in code by commit
`4350a4e9` and `site-agreement.test.ts`; no task in this plan changes it.

---

## 2. Tasks, in execution order

Verbatim code, YAML, JSON and test skeletons for each task: `docs/reference/datadog-monitoring-appendix.md` (A1 ↔ T1 … A13 ↔ T12). The execution protocol is §5, the progress log §6.

Phases: **A** ingest paths (nothing else can be proven without them) → **B**
monitors → **C** app-side signal quality → **D** dashboards/SLOs/log config →
**E** cutover and proof. Founder gates are marked ⛔.

### T0 ⛔ Founder inputs (no code)

1. Application key `apply-monitors` (unscoped) into Secret Manager:
   `printf '%s' '<key>' | gcloud secrets create DD_APP_KEY_PROD --replication-policy=automatic --data-file=- --account=founder@disdigital.in --project=stock-book-483718`
   The same value goes into `DD_APP_KEY_QA` (one org; the script reads per env).
2. Confirm the other session is idle before the end-of-batch `verify:push`.
3. Vercel variables are set by the founder ONLY at the cutover step (T12.6).

---

### T1 — Every TypeScript Cloud Run job gets a metrics path (MONEY-1278, TS half)

**Why.** `reportJobOutcome` → `datadog-metrics`, which is initialised only when
`DD_API_KEY` is set (`packages/datadog/src/metrics.ts:17-31`). No TS job has it.
`feed-parse` is monitored on both envs; its monitor would sit in NO DATA and
page at 3× window, forever. The image also bakes `DD_TRACE_ENABLED=true`
(`workers/Dockerfile:97`), so every job boots dd-trace against an agent that is
not there.

**Files.**

- `scripts/ops/setup-feed-backfill-job.sh` — `--set-env-vars="$env_vars"` :272, `--set-secrets=` :273; deploys `feed-backfill` (:286), `feed-parse` (:293), and `feed-repair` (its `deploy_job` line; grep `feed-repair`). `DB_SECRET` chosen :133-134.
- `scripts/ops/setup-xbrl-backfill-job.sh` :305-306
- `scripts/ops/setup-xbrl-projection-drain-job.sh` :321-322
- `scripts/ops/setup-xbrl-reparse-job.sh` :289-290
- `scripts/ops/setup-tiingo-backfill-job.sh` :338, :345 (three jobs :366-369+)
- `scripts/ops/setup-bse-backfill-job.sh` :231-232
- `scripts/ops/setup-doc-ingest-backfill-job.sh` :495-496 — **LOCKED** (other session). Defer; list at the bottom.
- `fo-summary-{prod,qa}` exists as a deployed job: find its provisioner with `grep -l "fo-summary" scripts/ops/*.sh` and treat it like the others.
- `scripts/jobs/xbrl-reparse.ts` — calls `reportJobOutcome` and never `flushMetrics` (`datadog-metrics` flushes on a 15 s timer; a job that exits first loses the batch). `scripts/jobs/feed-parse.ts` already flushes (3 sites). `scripts/jobs/doc-ingest-backfill.ts` needs the same and is LOCKED.
- Not in scope: `sync-prod-to-qa*` (cloud-sdk image, no Node).

**Design.**

1. In each provisioner, next to `DB_SECRET`, derive `DD_SECRET="DD_API_KEY_PROD"` / `"DD_API_KEY_QA"` in the same `case`.
2. Append to the existing `--set-secrets` value: `,DD_API_KEY=${DD_SECRET}:latest`.
3. Append to the existing `--set-env-vars` value: `,DD_ENV=${ENV},DD_TRACE_ENABLED=false`. `toDatadogEnv("prod")` → `production`, `"qa"` → `qa` (`constants.ts:46-56`), so passing the CLI env is correct. Remember `--set-env-vars` REPLACES the list (every provisioner says so in its header) — append to the existing string, never add a second flag.
4. `xbrl-reparse.ts`: `import { flushMetrics } from "@usemoney/datadog/metrics";` and `await flushMetrics()` on every exit path after the `reportJobOutcome` call (put it in a `finally` around `main()`, before `process.exit`).
5. Do NOT set `DD_VERSION` (baked into the image; every provisioner header explains why).

**Tests.**

- New `packages/core/__tests__/ops/job-metrics-path.test.ts` (node:test, reads files as text like `job-build-provenance.test.ts`):
  - for every `scripts/ops/setup-*-job.sh` that contains `run jobs deploy` and a `--set-secrets=` line: assert the secrets value contains `DD_API_KEY=DD_API_KEY_` and the env value contains `DD_ENV=` and `DD_TRACE_ENABLED=false`. A dated exemption map holds `setup-doc-ingest-backfill-job.sh` until the lock lifts (ratchet: an exemption for a file that now complies must be removed → assert that too, both directions).
  - for every `scripts/jobs/*.ts` whose text contains `reportJobOutcome(`: assert it contains `flushMetrics(`. Same exemption map for the locked file.
  - PREMISE checks: ≥6 provisioners scanned, ≥3 job scripts scanned (a scan over nothing must fail).
- Mutation: remove `DD_API_KEY=` from one provisioner → red; remove `flushMetrics` from `feed-parse.ts` → red; restore.
- Add rows to `TEST-COVERAGE.md` (+1 file in the headline).

**Runtime (gcloud lane, after merge or with `--dry-run` first).** Re-run each provisioner for qa then prod; every one has an image preflight — read the dry run and confirm it pins the CURRENTLY deployed image (they read it off the running service or a tag). Then:
`gcloud run jobs describe feed-parse-qa --region=asia-south1 --format=yaml | grep -A3 "name: DD_"`.
Proof: after the next `feed-parse-nightly` (22:35 IST weekdays), `stockbook.job.selected{job:feed-parse,env:qa}` has a point (Datadog metrics explorer or `GET /api/v1/query`).

**Commit.** `fix(MONEY-1278): every TypeScript Cloud Run job gets a Datadog API key and flushes its outcome before exit`

---

### T2 — Python jobs emit over HTTP instead of DogStatsD (MONEY-1278, Python half)

**Why.** The five `edgar-*` jobs have no sidecar; DogStatsD is fire-and-forget
UDP so the packets vanish silently (`Connection refused` in the job log, exit 0).
Option 2 from the ticket: the same agentless HTTP path `apps/web` uses. A
sidecar on Cloud Run JOBS is the alternative and is NOT chosen: it adds a
container per execution and the sidecar's lifecycle on jobs is not something
this repo has measured.

**Files.**

- `services/us-fundamentals/app/settings.py` — add `DD_SITE = "us5.datadoghq.com"` (mirror of the TS constant, same comment pattern as `METRIC_PREFIX` at :36-38) and `def metrics_transport() -> str` reading `DD_METRICS_TRANSPORT`, returning `"statsd"` unless the value is exactly `"http"` (literal comparison, like every flag in this service).
- `services/us-fundamentals/app/store/outcome.py` — `_get_statsd()` :84-101, `report_job_outcome()` :150-227, `record_latency()` (histogram stays statsd-only; the service has the sidecar).
- `scripts/ops/setup-us-fundamentals-jobs.sh` — env :363, secrets :387.
- `services/us-fundamentals/tests/test_outcome.py` (exists; asserts the emitted metric name list EXACTLY — extend, do not weaken).
- `services/us-fundamentals/tests/test_deploy_contract.py` (exists; `_containers(env)`, env-entry parsing ~:300-360).
- `services/us-fundamentals/cloudbuild.{qa,prod}.yaml` — the SERVICE keeps statsd; add nothing there except, if you want symmetry, `DD_METRICS_TRANSPORT=statsd` explicitly (present-and-explicit beats absent, per the MF_METADATA_PROVIDER lesson in CLAUDE.md).

**Design (outcome.py).**

```python
# transport seam — statsd (service, sidecar) or http (jobs, no sidecar)
_http_sender: Callable[[dict], None] | None = None  # injectable for tests

def _http_send_series(series: list[dict]) -> None:
    api_key = os.environ.get("DD_API_KEY")
    if not api_key:
        return  # no key: no-op, same contract as the TS side
    body = json.dumps({"series": series}).encode()
    req = urllib.request.Request(
        f"https://api.{settings.DD_SITE}/api/v1/series",
        data=body, method="POST",
        headers={"Content-Type": "application/json", "DD-API-KEY": api_key},
    )
    with urllib.request.urlopen(req, timeout=5):  # noqa: S310 — fixed https host
        pass

def _count(metric: str, value: int, tags: list[str]) -> dict:
    return {"metric": metric, "type": "count", "points": [[int(time.time()), value]], "tags": tags}
```

In `report_job_outcome`, when `settings.metrics_transport() == "http"`: build the
four `_count(...)` series and call the sender (injected or `_http_send_series`)
inside the same `try/except Exception: pass` the statsd branch uses. Never raise.
Keep the JSON log line unchanged. Use stdlib `urllib` — no new dependency, and
ddtrace's httpx patch is irrelevant to it.

**Design (provisioner).** `--set-env-vars` gains `,DD_METRICS_TRANSPORT=http`;
add `DD_SECRET` in the env `case` (:195-208) and append `,DD_API_KEY=${DD_SECRET}:latest`
to `--set-secrets` (:387).

**Tests.**

- `test_outcome.py`: with `DD_METRICS_TRANSPORT=http` and an injected sender, `report_job_outcome("j", 3, 0)` produces ONE call with four series, names exactly `stockbook.job.{selected,written,failed,transport_failures}`, `type == "count"`, tags include `job:j` and `env:` from `default_metric_tags()`; the sender raising does not propagate; with no `DD_API_KEY` the real sender is a no-op (assert no socket: patch `urllib.request.urlopen` to fail loudly).
- `test_deploy_contract.py`: every `deploy_job` in the jobs provisioner carries `DD_METRICS_TRANSPORT=http` AND `DD_API_KEY=DD_API_KEY_` in its secrets; the SERVICE spec has the `datadog-agent` container and does NOT set `DD_METRICS_TRANSPORT=http`. Mutation: drop the secret → red; set the service to http → red.
- Python reachability (see T4) covers the call sites.

**Runtime.** Re-run `setup-us-fundamentals-jobs.sh qa --dry-run` then for real; execute `edgar-bulk-ftd-qa` (QA has `SEC_EGRESS=off`, so it exits fast) and look for `stockbook.job.selected{job:edgar-bulk-ftd,env:qa}` on the new org.

**Commit.** `fix(MONEY-1278): Python jobs post their outcome counters over HTTP — no sidecar on a Cloud Run job`

---

### T3 — `tiingo-realtime` gets its own service name, a sidecar and a key (MONEY-1357)

**Why.** Fully dark today. It is the one process that must not die (24×5
socket), and it has no traces, no metrics, no logs in Datadog.

**Files.**

- `workers/src/realtime/main.ts:55-56` — `initTracer({ service: "stockbook-workers" })` → `"tiingo-realtime"`.
- `packages/datadog/src/constants.ts` — `DD_SERVICES` gains `REALTIME: "tiingo-realtime"`; use it in `main.ts`.
- `workers/cloudbuild.prod.yaml` realtime block (`cat > /tmp/tiingo-realtime.yaml` :739, containers :758-823) and `workers/cloudbuild.qa.yaml` (:742+).
- `workers/__tests__/realtime/realtime-wiring.test.ts` — add a describe.

**Design (YAML, both envs).** Under `spec.template.metadata.annotations` add
`run.googleapis.com/container-dependencies: '{"tiingo-realtime":["datadog-agent"]}'`.
In the `tiingo-realtime` container env add: `DD_TRACE_ENABLED=true`,
`DD_SERVICE=tiingo-realtime`, `DD_ENV=production|qa`, `DD_VERSION=$COMMIT_SHA`,
`DD_TRACE_AGENT_URL=http://localhost:8126`, `DD_API_KEY` from
`DD_API_KEY_PROD|QA`. Add a second container, a copy of the workers'
`datadog-agent` block (`workers/cloudbuild.prod.yaml:503-530`) with
`DD_SERVICE=tiingo-realtime`, `DD_SITE=us5.datadoghq.com`, the same
startupProbe on 5555 and `memory: 256Mi`. Keep `minScale`/`maxScale` 1 and
`cpu-throttling: "false"` untouched. Note the realtime service uses
`NODE_ENV: prod` (not `production`) — `toDatadogEnv` maps both, but set
`DD_ENV` explicitly anyway.

**Tests.** In `realtime-wiring.test.ts`: read both cloudbuild files, extract the
`tiingo-realtime.yaml` heredoc, assert (a) a `datadog-agent` container exists
inside it, (b) `DD_SERVICE` is `tiingo-realtime` on BOTH containers, (c)
`DD_API_KEY` secret ref present, (d) the container-dependencies annotation
names both, (e) `main.ts` passes `DD_SERVICES.REALTIME` to `initTracer`.
`site-agreement.test.ts` already covers the new sidecar's `DD_SITE` (it scans
the whole file). Mutation: delete the sidecar block → red.

**Runtime.** After the next release, APM service list shows `tiingo-realtime`.

**Commit.** `fix(MONEY-1278): tiingo-realtime reports under its own service name, with the sidecar and key it never had`

---

### T3b — `tiingo-realtime` emits its counters and gets a liveness monitor (MONEY-1357)

**Why.** Even with T3 in place there is nothing to alert on: the service keeps
rich counters (`main.ts:176` `counters`, `candle-sink.ts:44`
`CandleSinkCounters`, socket/aggregator/subscription counters, all surfaced on
`/health` at `main.ts:433-452`) and emits **none** of them as a metric. Its
only external signal is Cloud Run's liveness probe restarting it.

**Files.** `workers/src/realtime/main.ts` (`flushTick()` :333, every
`FLUSH_MS` = 5 s; `healthy()` :412), new `workers/src/realtime/rt-metrics-logic.ts`,
new `workers/__tests__/realtime/rt-metrics-logic.test.ts`,
`workers/__tests__/realtime/realtime-wiring.test.ts`.

**Design.**

1. `rt-metrics-logic.ts` (pure): `computeRtMetricDeltas(prev, curr)` over a
   flat `RtCounterSnapshot` (`barsClosed`, `quotesWritten`,
   `quoteWriteFailures`, `framesDropped`, `leaderTransitions`,
   `bytesRecorded`, `candlesWritten`, `refusedMixedSource`) returning
   non-negative finite deltas (a counter reset reads as 0, never negative;
   `Number.isFinite` guard on every field).
2. In `flushTick()`, after the flush: build the snapshot from `counters`,
   `candleSink.counters`, `socket?.counters`; emit each delta with
   `incrementCounter("rt.<name>", delta)`; emit gauges `rt.health_ok`
   (0/1, tag `reason:<healthy().reason>`), `rt.leader` (0/1),
   `rt.subscribed` (`socket?.subscribedSymbols().length ?? 0`),
   `rt.open_bars` (`aggregator.openCount()`). Import from
   `@usemoney/datadog/metrics` (subpath). The HTTP reporter needs `DD_API_KEY`,
   which T3 supplies; without it every call is a no-op, which is the existing
   contract.
3. Monitors (rows in T6's `apply-service-monitors.sh`, type `query alert`):
   - `min(last_10m):min:stockbook.rt.health_ok{env:production} < 1`,
     `notify_no_data: true`, `no_data_timeframe: 20` — silence means the
     process is gone, and this is the one process that must not die.
   - `sum(last_96h):default_zero(sum:stockbook.rt.bars_closed{env:production}.as_count()) < 1`
     — data-level backstop; 96h clears the Fri 20:00 ET → Mon 04:00 ET gap.
   - log alert: `logs("service:tiingo-realtime env:production \"[tiingo-rt] stepping down\"").index("*").rollup("count").last("15m") > 0`.

**Tests.** `rt-metrics-logic.test.ts`: deltas, reset-to-zero, NaN guard
(mutation: drop the guard → red). `realtime-wiring.test.ts`: `flushTick`
names every metric above (source scan against a list exported from
`rt-metrics-logic.ts`, so the dashboard inventory in T8 reads the same list).

**Commit.** `feat(MONEY-1357): tiingo-realtime emits its counters every flush, and a liveness monitor watches the one process that must not die`

---

### T4 — Python job outcomes reach Cloud Logging, and a Python reachability guard (MONEY-1331)

**What is known.** `report_job_outcome` logs at INFO via
`logging.getLogger("us-fundamentals.job-outcome")` (`outcome.py:224`);
`install_logging()` (`logging_setup.py:183`) installs ONE `StreamHandler(sys.stdout)`
with `JsonFormatter` on the root logger at import time of every bulk module
(`companyfacts.py:58`). `StreamHandler.emit` flushes per record, so plain
buffering is not the explanation for "nothing but `Container called exit(0)`".

**RUNTIME CHECK first (do not guess).** Execute `edgar-bulk-ftd-qa`, then:

```
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="edgar-bulk-ftd-qa" AND timestamp>="<start ISO>"' --limit=100 --format=json --project=stock-book-483718 | jq '.[] | {t:.timestamp, text:.textPayload, json:.jsonPayload.msg}'
```

Three outcomes and the fix for each:

- **No lines at all** → the root handler is being replaced after `install_logging()` (a library calling `logging.basicConfig(force=True)` or assigning `root.handlers`). Fix: in `report_job_outcome`, after the logger call, ALSO write the line straight to `sys.stdout` when the root logger has no `_usemoney_json` handler (defensive fallback), and add `tests/test_logging_survives_imports.py`: import each bulk module in a subprocess and assert `logging.getLogger().handlers[0]._usemoney_json is True` after import.
- **Lines present but as `textPayload`** → the JSON formatter is not producing single-line JSON (Cloud Logging parses one JSON object per line into `jsonPayload`). Fix the formatter output; assert single-line in `tests/test_logging_setup.py`.
- **Lines present as `jsonPayload` under a different key** → the ticket's query was wrong; document the working query in `docs/reference/edgar-engine.md` and close the ticket with it.

**Reachability guard (the Python analogue of MONEY-1325).** New
`services/us-fundamentals/tests/test_outcome_reachability.py`: for every module
under `app/bulk/*.py` and `app/jobs/*.py` that defines `def main(`, parse with
`ast`, find the `report_job_outcome(` call, and assert it sits inside a
`finally:` block of a `try` whose body contains the run (i.e. the call's
enclosing `Try` node has it in `finalbody`). Print the survey (`finally` /
`guarded` / `bypassed`) like the TS guard does, and fail on `bypassed`. The
five bulk modules each have ≥1 `finally` today; `app/jobs/detect.py` reports
from a `finally` per its docstring; the parse jobs (`parse_*.py`) are
event-driven — decide per file and baseline with a reason if one is exempt.
Mutation: move one call above its `try` → red.

**Docs.** `docs/reference/edgar-engine.md` section on outcomes: the greppable
line, the working Cloud Logging query.

**Commit.** `fix(MONEY-1331): Python job outcomes land in Cloud Logging, and a reachability guard covers app/bulk and app/jobs`

---

### T5 — Absence template as a file, absence rows, the US rows, one window fix, guard reads both lists (MONEY-1266, MONEY-1293, MONEY-1358)

**Files.** `scripts/ops/datadog/apply-monitors.sh` (ABSENCE_TEMPLATE heredoc
:162-268, `ABSENCE_MONITORS` :383-385, `MONITORED_JOBS` :389+, the candle-evict
"deliberately absent" comment ~:560-580), new
`scripts/ops/datadog/monitor-job-absence.json`,
`packages/datadog/__tests__/job-outcome-coverage.test.ts` (`monitoredJobIds()` :587-591),
`packages/datadog/__tests__/monitor-agreement.test.ts`, `scripts/README.md`
(the apply-monitors section :261-352 — rule: README changes with every
`scripts/` change).

**Design.**

1. Move the heredoc JSON verbatim into `monitor-job-absence.json`; set
   `ABSENCE_TEMPLATE="$HERE/monitor-job-absence.json"`; delete the `mktemp`
   and the `trap`. The header comment already says "promote it the day a second
   job needs one".
2. `ABSENCE_MONITORS` rows (format `job|window|max gap`):
   - `candle-evict|36h|daily 15:00 IST; disarmed run still reports selected>0` — PROD_ONLY (`candle-evict-daily` is in `PROD_ONLY_JOBS`), so no QA monitor. The zero-write template would page nightly while `CANDLE_EVICT_APPLY=false` (MONEY-1266); absence is the right question. Its reporter is guarded on all three exits (`candle-evict.ts:182,381,435`).
   - `news-rss-sync|12h|every 5 min mkt hours + 15 min off-hours; Sat/Sun 09-16 uncovered = 7h15m` — the ticket's "2h" is wrong, the measured max gap is 7h15m (the zero-write row's own comment). 12h.
   - `tiingo-news-poll|2h|every 2 min, all days` — PROD_ONLY.
3. `MONITORED_JOBS` additions/fixes:
   - `"tiingo-news-poll|2h|every 2 min, all days"` — its `selected` is `state.owed` (MONEY-1250 semantics: work owed a write), so the standard zero-write query is right-shaped. Reporter at `tiingo-news-poll.ts:885`.
   - `"feed-parse|96h|weekdays 22:35"` (was 36h on a `1-5` cron — the `bhavcopy-sync` shape the same file corrects).
4. Replace the candle-evict "deliberately absent" comment with two lines
   pointing at the absence row.
5. `job-outcome-coverage.test.ts`: `monitoredJobIds()` also parses
   `declare -a ABSENCE_MONITORS=(` so an absence row with no emit site fails.
6. `monitor-agreement.test.ts`: the `isAbsenceBody` filter and counts
   (`PROD_ABSENCE`) must be updated for 3 absence bodies on prod and 1 on qa
   (`news-rss-sync` is the only non-prod-only one). Expected totals after this
   task: prod 36 zero-write + 2 new zero-write (tiingo-news-poll, edgar-bulk-ftd) + 1 latency + 4 absence (news-sync, candle-evict, news-rss-sync, tiingo-news-poll) = **43**, or **45** once the two daily EDGAR rows pass their runtime check; qa 12 + 1 (news-rss-sync absence) = **13**. Re-render with `--dry-run` and
   pin the numbers.

**Tests.** dry-run both envs; `monitor-agreement.test.ts`,
`job-outcome-coverage.test.ts`, `edgar-infra-coverage.test.ts` (bare-name rule
on `MONITORED_JOBS`), `edgar-monitor-and-scheduler.spawntest.ts`. Mutation:
add a bogus `"nope|1h|x"` absence row → coverage guard red.

**Commit.** `feat(MONEY-1266): absence monitors for candle-evict, news-rss-sync and tiingo-news-poll; the absence template becomes a file`

---

**US rows (MONEY-1358).** `apply-monitors.sh:658-712` excludes
`edgar-bulk-submissions`, `edgar-bulk-companyfacts` and `edgar-bulk-ftd`
because "`EDGAR_PARSE_APPLY` ships false". It does not: `setup-us-fundamentals-jobs.sh:202`
sets `PARSE_APPLY="true"` on prod and the deployed `edgar-bulk-ftd-prod` carries
`EDGAR_PARSE_APPLY: 'true'` (read 2026-09-05). The comment's precondition (a)
is met; (b) and (c) are the work:

7. `job_is_prod_only` (`apply-monitors.sh:140-156`) greps `SCHEDULER_DEFS`
   rows, and the EDGAR bulk triggers are created by
   `setup_edgar_bulk_job_schedulers` (not rows). Add a fallback: when no row
   matches, treat the job as prod-only if any `PROD_ONLY_JOBS` entry starts
   with `${job}-` (`edgar-bulk-ftd-semimonthly`, `edgar-bulk-ftd-retry` are
   there). Pin: the qa dry-run must render NO `edgar-bulk-*` body (QA runs
   these jobs DISARMED — `PARSE_APPLY="false"` :210 — and a disarmed run
   reports `selected=N written=0`).
8. `job-outcome-coverage.test.ts`'s Python emit-site scan reads a
   module-level `JOB`/`JOB_NAME` literal; submissions and companyfacts take
   their id from `JOB_NAMES` in `app/bulk/common.py`. Extend the scan to read
   that dict (mutation: rename a key → red).
9. Rows: `"edgar-bulk-ftd|12d|semimonthly 3rd/10th/18th/25th 19:00 IST; longest gap 9d"`
   (the exclusion block already computed the 12d);
   `"edgar-bulk-submissions|36h|daily 13:00 + 16:00 retry"`;
   `"edgar-bulk-companyfacts|36h|daily 13:00 + 16:00 retry"`.
   **RUNTIME CHECK before the two daily rows**: after T2 lands, read one
   no-op day's `[job-outcome]` line for each and confirm `selected=0` on the
   NOT_YET_PUBLISHED / fully-checkpointed path (MONEY-1331's 10:51 run wrote 0
   by design — if it reported `selected>0`, the row pages on every healthy
   skip). If it does not, fix the counter semantics first (MONEY-1250: selected
   means work owed a write), then add the row.
10. `edgar-evict` stays excluded (`EDGAR_EVICT_APPLY=false` by design).
11. Rewrite the exclusion block's stale "ships false" paragraphs to say what
    is true now and to point at these rows.

---

### T6 — Service-level monitors: APM error rate, log errors, RUM errors and LCP, realtime liveness (MONEY-1359)

**Why.** The zero-write family watches jobs. Nothing watches request errors on
the two APM services, error-level logs, or the browser. These are the alerts
from the canceled MONEY-450/452/454 that cost nothing to keep.

**Files.** New `scripts/ops/datadog/lib-datadog.sh` (extract `dd_request`,
`render`, the managed-tag listing and the upsert-by-name loop body from
`apply-monitors.sh` :12-52, :53-133, :134-157, :196-231 into functions;
`apply-monitors.sh` sources it — behaviour identical, and
`monitor-agreement.test.ts` runs the real script so the extraction is
covered). New `scripts/ops/datadog/apply-service-monitors.sh` and four
templates. New `packages/datadog/__tests__/service-monitors-agreement.test.ts`.

**Templates (placeholders rendered by the same `render()`).**

- `monitor-apm-error-rate.json` — `"type": "query alert"`,
  `sum(last_15m):sum:trace.{{span}}.errors{service:{{service}},env:{{env}}}.as_count() / sum:trace.{{span}}.hits{service:{{service}},env:{{env}}}.as_count() > 0.05`,
  `notify_no_data: false` (traffic is legitimately zero for hours). Rows:
  `stockbook-workers|http.request`, `us-fundamentals|fastapi.request`,
  `tiingo-realtime|http.request` (after T3). **RUNTIME CHECK**: the span name
  is `http.request` for dd-trace-js's http server plugin on the default
  (v0) attribute schema and `fastapi.request` for ddtrace-py; the apply script
  must verify with `GET /api/v1/query?from=$(($(date +%s)-86400))&to=$(date +%s)&query=sum:trace.<span>.hits{service:<svc>,env:production}.as_count()`
  that `.series` is non-empty and ABORT that row with a named error otherwise.
  No APM latency monitor: the workers' HTTP requests ARE the jobs (up to 600 s),
  so a p95 alarm there is wrong-shaped.
- `monitor-log-errors.json` — `"type": "log alert"`,
  `logs("service:{{service}} env:{{env}} status:error").index("*").rollup("count").last("1h") > {{threshold}}`;
  rows: `stockbook-workers|100`, `stockbook-web|50`, `stockbook-api|50`,
  `us-fundamentals|50`. Plus two fixed ones: FATAL anywhere
  (`status:(fatal OR critical) env:{{env}}` > 0 over 15m) and
  `unhandledRejection` (`env:{{env}} ("unhandledRejection" OR "Unhandled promise rejection")` > 0 over 15m).
  Preflight: `POST /api/v2/logs/events/search` with `service:<svc> env:production`
  over 24h returns ≥1 event, else abort the row. **RUNTIME CHECK** that
  `status:error` matches pino errors: pino emits `level:"error"` as a label
  (`config.ts:90-92`) and Datadog's `nodejs` integration pipeline remaps
  `level` → `status`; if a search for `service:stockbook-workers status:error`
  returns 0 while `level:error` returns >0, add a pipeline with a status
  remapper on `level` via `POST /api/v1/logs/config/pipelines` (T9).
- `monitor-rum-errors.json` — `"type": "rum alert"`,
  `rum("@type:error service:stockbook-web env:{{env}}").rollup("count").last("15m") > 20`.
- `monitor-rum-lcp.json` — `"type": "rum alert"`,
  `rum("@type:view service:stockbook-web env:{{env}}").rollup("pc75", "@view.largest_contentful_paint").last("30m") > 2500000000`
  (RUM stores view timings in NANOSECONDS; 2.5 s = 2 500 000 000). **RUNTIME
  CHECK** the unit with one `POST /api/v2/rum/events/search` before applying.
  `notify_no_data: false` on both RUM monitors (no sessions overnight IST is normal).
- Every template: tags `managed-by:apply-monitors`, `env:{{env}}`,
  `service:{{service}}`, message ending `@{{notify}}` (the `@` is the routing
  mechanism — `monitor-latency-p95.json` `_notify_routing_rationale`).

- realtime liveness rows from T3b (MONEY-1357): `rt.health_ok` min < 1 over 10m with `notify_no_data: true` at 20 min; `rt.bars_closed` absence 96h; the `stepping down` log alert. These are the only rows in this script whose no-data notification is ON, because for the singleton process silence IS the signal.

**Script.** `apply-service-monitors.sh {qa|prod} [--dry-run]`, same flag
parsing and fail-closed listing as `apply-monitors.sh`, `DD_NOTIFY` override,
prod-only rows skipped on qa where the service does not exist (`tiingo-realtime`
exists on both; `stockbook-api` qa exists). Exit non-zero listing every row
that did not apply, including preflight aborts.

**Tests.** `service-monitors-agreement.test.ts`: dry-run renders, every body
has the managed tag, `@` before the notify handle, `type` in the allowed set,
no unsubstituted `{{`; the RUM/log bodies set `notify_no_data: false`; the
stubbed-curl run makes exactly one GET listing and N upserts (copy the
harness from `monitor-agreement.test.ts` :155-222). Mutation: drop the `@` →
red; drop the managed tag → red.

**Docs.** `scripts/README.md` new subsection; `CLAUDE.md` one line under the
Datadog table pointing at both apply scripts.

**Commit.** `feat(MONEY-1229): service-level monitors — APM error rate, log errors, RUM errors and LCP — with series-exists preflights`

---

### T7 — SLOs as code (MONEY-1360)

**Files.** New `scripts/ops/datadog/slos.json`, new
`scripts/ops/datadog/apply-slos.sh` (sources `lib-datadog.sh`), test
`packages/datadog/__tests__/slos-agreement.test.ts`.

**SLOs (all 30d, prod only).**

1. _Scheduled jobs write what they select_ — `type: "monitor"`, `monitor_ids` = every managed monitor whose name matches `wrote nothing but had work to do` on `[production]`, target 99.5.
2. _Scheduled jobs run_ — monitor-based on the absence monitors, target 99.9.
3. _Workers request success_ — `type: "metric"`, numerator `sum:trace.http.request.hits{service:stockbook-workers,env:production}.as_count() - sum:trace.http.request.errors{service:stockbook-workers,env:production}.as_count()`, denominator `sum:trace.http.request.hits{service:stockbook-workers,env:production}.as_count()`, target 99 (same span-name preflight as T6).
4. _EDGAR detection under 5 minutes_ — monitor-based on `[production] edgar-detect — p95 latency over 300s`, target 99.

**Script.** Resolve monitor IDs from `GET /api/v1/monitor?monitor_tags=managed-by:apply-monitors` by name; upsert by SLO name via `GET /api/v1/slo?query=<name>` then `PUT /api/v1/slo/{id}` or `POST /api/v1/slo`; tag `managed-by:apply-slos`. Fail closed if a monitor-based SLO resolves zero monitors.

**Tests.** dry-run renders four bodies with the right `type`, thresholds
`[{"timeframe":"30d","target":…}]`, and the stub listing maps names → ids.

**Commit.** `feat(MONEY-1229): four SLOs as code over the managed monitors`

---

### T8 — Dashboards as code (MONEY-1361)

**Files.** New `scripts/ops/datadog/dashboards/{prod-health,job-health,web-vitals,cache-and-brokers}.json`,
new `scripts/ops/datadog/apply-dashboards.sh` (list `GET /api/v1/dashboard`,
match `title`, `PUT /api/v1/dashboard/{id}` or `POST`), test
`packages/datadog/__tests__/dashboards-agreement.test.ts` (every widget query
names only metrics in the emitted inventory — read the names out of
`job-outcome.ts`, `metrics.ts` call sites and `outcome.py` the way
`monitor-agreement.test.ts` reads `EMITTED_JOB_METRICS`; a query on a metric
nobody emits is the whole defect class).

**Widget queries (all `env:production`; use template variable `$env`).**

- _prod-health_: query_value `sum:stockbook.job.written{$env}.as_count()` last 24h; timeseries `sum:trace.http.request.errors{service:stockbook-workers,$env}.as_count()` vs hits; `logs` count by `service` where `status:error` (log query widget); RUM `@type:error` count; SLO summary widgets for T7's four (SLO ids resolved at apply time — the script substitutes `{{slo:<name>}}`).
- _job-health_: heatmap/toplist `sum:stockbook.job.written{$env} by {job}.as_count()` 7d; `sum:stockbook.job.selected{$env} by {job}.as_count()`; `sum:stockbook.job.transport_failures{$env} by {job}.as_count()`; a table widget of `clamp_max(sum:stockbook.job.selected{$env} by {job}.as_count(),1) - clamp_max(sum:stockbook.job.written{$env} by {job}.as_count(),1)` last 36h (the monitor's own query, so the board and the alarm cannot disagree); `stockbook.edgar.detect_latency_seconds.95percentile{$env}`.
- _web-vitals_ (the board the performance week starts from): RUM timeseries pc75 of `@view.largest_contentful_paint`, `@view.interaction_to_next_paint`, `@view.cumulative_layout_shift` by `@view.url_path` (top 10); RUM error count by `@error.message`; session count; `@resource.duration` pc75 by `@resource.url_host`. Data source `rum` in the formulas-and-functions request shape (`{"data_source":"rum","query_string":"@type:view service:stockbook-web env:production","compute":{"aggregation":"pc75","metric":"@view.largest_contentful_paint"},"group_by":[{"facet":"@view.url_path","limit":10}]}`).
- _us-market_ (the US stack on one board): `stockbook.job.{selected,written,transport_failures}` by job for `us-eod-sync`, `us-instrument-master-sync`, `tiingo-news-poll`, `edgar-detect`, `edgar-bulk-*`; `stockbook.edgar.detect_latency_seconds.95percentile`; realtime `rt.health_ok`, `rt.leader`, `rt.subscribed`, `rt.bars_closed`, `rt.candles_written` vs `rt.refused_mixed_source`, `rt.quote_write_failures` (T3b); `trace.fastapi.request` hits vs errors for `us-fundamentals`; `trace.http.request` for `tiingo-realtime`.
- _cache-and-brokers_: `sum:stockbook.cache.hit{$env} by {layer}.as_count()` vs `stockbook.cache.miss`; `broker.sync.duration` p95 by broker; `broker.sync.failure` by broker; `pairing.trades_processed`.
- NOT built here: an "AI cost" board. **The parenthetical this bullet used to carry was FALSE, and the correction is the reason MONEY-1363 is superseded rather than deferred.** It read "Gemini usage is counted for billing only in `packages/core/src/gemini/client.ts`". That file reads NOTHING: `grep -n usageMetadata packages/core/src/gemini/client.ts` returns two lines, `:21` and `:308`, and both are doc comments describing the SDK's response shape. Re-verified 2026-09-11. The only real reader of `usageMetadata` in the repo is `workers/src/lib/gemini-pdf.ts:381`, on the document-ingest path.

  What actually drives billing is an **estimate**, and it is arithmetic, not telemetry. `estimateTokenCount()` (`packages/core/src/gemini/models.ts:302`) is `Math.ceil(text.length / 4)`. Research calls it at `packages/research/src/planner.ts:128,138` and `packages/research/src/validator.ts:35,45`; those feed `packages/research/src/agent.ts:837`, which SUMS input + output into one `tokensUsed` column — destroying the split it still had three lines further down at `:863-864` — and `workers/src/processors/research.ts:273-278` then RE-SPLITS that sum with a hardcoded 80/20 guess before it reaches `computeRunCredits` → `calculateCost` → `consumeCredits`. Chat bills off the same estimator (`apps/web/app/api/chat/route.ts:1247,2174,2348` and `lib/chat-tools/flash-responder.ts:196,290`), so this is not a research-only path.

  **Fixing the estimate is OUT OF SCOPE and stays out.** Founder decision: "billing — we will change along with new pricing model later". A more accurate token count changes what users are CHARGED, so it is a pricing change wearing a telemetry costume, and it belongs to the pricing-model rework. Nobody should re-open it from this document.

  What is measured, and what is charged, are now two different numbers from two different sources, deliberately. T13 (MONEY-1380) ships native Datadog LLM Observability, whose token counts come from the provider's own response via dd-trace's auto-instrumentation — so the observability estate reports real usage per `ml_app` without touching the billing arithmetic above. The board itself waits for the series to arrive, per MONEY-1238.

**Commit.** `feat(MONEY-1361): five dashboards as code, applied idempotently by title`

---

### T9 — Log index hygiene and the status remap (MONEY-1362)

**Files.** New `scripts/ops/datadog/apply-log-config.sh` (sources `lib-datadog.sh`).

**Design.**

1. `GET /api/v1/logs/config/indexes` → find `main`. If absent, add exclusion
   filters (`PUT /api/v1/logs/config/indexes/main` with the EXISTING filters
   preserved + the new ones): `status:(debug OR trace)` sample 100%, and
   `@http.url_details.path:/health*`. Retention stays at the org default
   (founder decides cost later).
2. If T6's runtime check showed `status:error` empty while `level:error` has
   events: `POST /api/v1/logs/config/pipelines` with a `status-remapper` on
   `level` (and `service-remapper` on `service`), filter `source:nodejs`.
3. Idempotent: every write is preceded by a GET and skipped when already present.

**Tests.** A dry-run render test asserting the exclusion filter shapes; the live
behaviour is a runtime step recorded in the commit body.

**Commit.** `chore(MONEY-1229): log index exclusion filters and the nodejs status remap, as code`

---

### T10 — RUM captures boundary errors explicitly (MONEY-726)

**Files.** `apps/web/app/error.tsx` (client component, has `useEffect`),
`apps/web/app/global-error.tsx` (:172-175 logs to console only; MUST stay
self-contained — no app CSS/Clerk imports), `apps/web/components/DatadogRumProvider.tsx`,
new `apps/web/lib/datadog/rum-init.ts`,
`apps/web/__tests__/components/analytics-imports-guarded.test.ts` (`TARGETS` :48-52).

**Design.**

1. `rum-init.ts` (leaf module, imports only `@usemoney/datadog/constants`):
   `export function rumInitConfig(): RumInitConfiguration | null` returning the
   object currently inline in the provider (:22-42) or `null` when the two
   `NEXT_PUBLIC_DD_*` vars are absent. The provider uses it.
2. `error.tsx`: in its `useEffect`, `import("@datadog/browser-rum").then(({ datadogRum }) => datadogRum.addError(error, { digest: error.digest, boundary: "error" })).catch(() => {})`. The SDK buffers `addError` before `init` and drains on `init` (`preStartRum.js` `bufferApiCalls`), so ordering against the provider does not matter.
3. `global-error.tsx`: the provider never mounted, so init it here:
   `Promise.all([import("@datadog/browser-rum"), import("@/lib/datadog/rum-init")]).then(([{ datadogRum }, { rumInitConfig }]) => { const cfg = rumInitConfig(); if (!cfg) return; if (!datadogRum.getInitConfiguration()) datadogRum.init(cfg); datadogRum.addError(error, { digest: error.digest, boundary: "global-error" }); }).catch(() => {})`. Keep the existing `console.error`. Both imports are dynamic and caught, which keeps the file's "self-contained" promise: a failed import degrades to the console line.
4. Add both boundary files to `TARGETS` in the guard test (every dynamic import must have a `.catch`).

**Tests.** The guard test now covers 5 files. New
`apps/web/__tests__/components/error-boundaries-report-to-rum.test.ts`: source
scan of both files asserting `addError(` is called with the error and a
`boundary` tag, and that `global-error.tsx` calls `init(` only behind
`getInitConfiguration()`. Mutation: remove `addError` → red.
Run from `apps/web` (the `@/` alias needs its tsconfig).

**Commit.** `feat(MONEY-726): error boundaries report to RUM explicitly, and global-error initialises RUM itself`

---

### T11 — Structured logger redacts by key path (MONEY-716)

**Files.** `packages/logger/src/config.ts` (pino options :85-147; serializers
already wrap `redactSensitive`), `packages/utils/src/log-redaction.ts`
(`SENSITIVE_KEY_PATTERN` :79, `SESSION_COOKIE_NAMES` :92 — reuse, do not
duplicate), `packages/logger/__tests__/config-redaction.test.ts` (extend).

**Design.** Add pino's own `redact` option as a second, cheaper layer that
runs before serialization:

```ts
redact: {
  paths: [
    "*.authorization", "*.cookie", "*.set-cookie", "headers.authorization",
    "req.headers.authorization", "req.headers.cookie", "res.headers[\"set-cookie\"]",
    "*.password", "*.token", "*.accessToken", "*.refreshToken", "*.apiKey",
    "*.api_key", "*.secret", "*.clientSecret", "*.sessionToken",
    "*.DATABASE_URL", "*.REDIS_URL", "*.email", "*.phone",
  ],
  censor: REDACTED,
}
```

Derive the key list from `SENSITIVE_KEY_PATTERN`'s vocabulary rather than
retyping where the pattern is a plain alternation; `email`/`phone` are the DPDP
additions the ticket asks for (audit-log call sites that NEED an email must log
it under a different key, e.g. `actorEmail`, and the test must show one such
key survives). Keep the `redactSensitive` serializers — they cover nested
shapes pino's path syntax cannot express.

**Tests.** In `config-redaction.test.ts`: a log call with `{ req: { headers: { authorization: "Bearer x", cookie: "__session=y" } }, user: { email: "a@b.c" } }` emits `[REDACTED]` in all three and keeps `actorEmail`; a broker token under `data.accessToken` is redacted; mutation: delete `redact` → red.

**Commit.** `feat(MONEY-716): pino redact paths for credentials and PII, on top of the serializer redaction`

---

### T12 ⛔ Cutover and proof on the new org (gcloud + API lane; founder gates marked)

Order matters because the OLD org is still live and Cloud Run resolves
`latest` at instance start.

1. Founder: T0 done (`DD_APP_KEY_PROD` exists). Verify: `gcloud secrets versions access latest --secret=DD_APP_KEY_PROD | wc -c` (never print it).
2. Mint the QA API key through the API, straight into Secret Manager:
   `curl -sS -X POST https://api.us5.datadoghq.com/api/v2/api_keys -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" -H 'Content-Type: application/json' -d '{"data":{"type":"api_keys","attributes":{"name":"stockbook-qa"}}}' | jq -r .data.attributes.key | tr -d '\n' | gcloud secrets versions add DD_API_KEY_QA --data-file=-`
   Then delete the UI-created `stockbook-qa` key (it was never copied):
   `DELETE /api/v2/api_keys/f20f6ba9-f581-46e6-a1da-8e34d70ffe40`.
3. Create the two RUM apps: `POST /api/v2/rum/applications` with
   `{"data":{"type":"rum_application_create","attributes":{"name":"stockbook-web","type":"browser"}}}` and `stockbook-web-qa`; read `data.attributes.application_id` and `client_token` (public by design) and hand them to the founder in a table.
4. Merge this branch (founder). QA workers deploy from `main`; Vercel web/api deploy from `main`; prod workers and us-fundamentals deploy from `release`.
5. **In the same window as the `main` deploy**: `printf '%s' '<stockbook-prod key>' | gcloud secrets versions add DD_API_KEY_PROD --data-file=-` (founder-minted key already validated on us5). Because prod Cloud Run reads it at the NEXT instance start and prod's code still points at us3 until the `release` promote, do the prod version add immediately before the release deploy, not before the main merge.
6. ⛔ Founder sets Vercel variables (web prod/qa, api prod/qa) per the runbook table, then redeploys.
7. Roll the four sidecar services so warm instances restart on the new key (workers-prod is minScale 1): a no-op revision via `gcloud run services update <svc> --region=asia-south1 --update-labels=dd-org=us5`.
8. Re-run the job provisioners (T1, T2) for qa then prod, `--dry-run` first.
9. **Prove ingest before any monitor exists**: `stockbook.job.selected` has points per env (`GET /api/v1/query`); APM services `stockbook-workers`, `us-fundamentals`, `tiingo-realtime` listed (`GET /api/v1/service_dependencies` or the UI); one RUM session; one log line per service (`POST /api/v2/logs/events/search`).
10. Apply in order, dry-run first each: `apply-monitors.sh prod` (41) and `qa` (13), `apply-service-monitors.sh`, `apply-slos.sh prod`, `apply-dashboards.sh prod`, `apply-log-config.sh prod`.
11. **Negative test (MONEY-1229 "done")** without touching a real job: on QA, `POST /api/v1/series` with `stockbook.job.selected{job:feed-parse,env:qa}=3` and `stockbook.job.written{job:feed-parse,env:qa}=0` (type count). The `[qa] feed-parse wrote nothing but had work to do` monitor must go ALERT within its evaluation and the email must arrive. Then post `written=3` to recover. Record monitor id, timestamps and the notification in the ticket.
12. Revoke the pasted prod key: mint `stockbook-prod-2` via the API into `DD_API_KEY_PROD`, roll the services again, then `DELETE /api/v2/api_keys/929a3b6a-4754-4694-872e-fed037625086`. The pasted value sat in a chat transcript; it is bootstrap only.
13. Old org: nothing to revoke there until (9) is green everywhere; then the founder closes it.
14. Re-authenticate the claude.ai Datadog connector (the 08:00 IST morning-triage routine `trig_01NWVmaKfg5J7NWJLNeNmXZw` uses it).

---

### T12b — Docs and ticket close-out

Renumbered from T13. It is the close-out half of T12's cutover and carries no
ticket of its own, and T13/T14 below are real tasks with real tickets — two
sections numbered T13 in one document is exactly the kind of quiet ambiguity
this plan spends its length avoiding.

- `CLAUDE.md` Datadog section: the apply-script family (monitors, service monitors, SLOs, dashboards, log config), `DD_METRICS_TRANSPORT`, the job metrics path rule ("a job that declares `DD_*` has a working path, and a test says so").
- `docs/env-vars-reference.md`: `DD_METRICS_TRANSPORT`, `DD_NOTIFY`.
- `scripts/README.md`: each new script.
- `TEST-COVERAGE.md`: every new test file (headline count) — one edit per task, in that task's commit.
- Linear: MONEY-1278 (T1+T2), 1357 (T3+T3b), 1331 (T4), 1266 + 1358 (T5; MONEY-1293's monitoring half — leave its discovery-widening half open with a note), 1359 (T6), 1360 (T7), 1361 (T8), 1362 (T9), 726 (T10), 716 (T11) → Done with evidence links; MONEY-1229 → Done after T12.11; MONEY-1356 → Done on merge. MONEY-1380 (T13) → Done. MONEY-1379 (T14) → Done: the GCP integration and cost config are live, and the monitoring layer on top of them shipped as `apply-perf-monitors.sh` (9 prod / 3 qa) plus the `workers-performance` board. Pub/Sub backlog, dead letters and push-failure rate; Cloud Run handler time, instance saturation and queueing; the Gemini input-token quota; and Cloud Scheduler publish failures — that last one because the executions LOG arrives as `gcp.logging.log_entry_count` even though Scheduler emits no Cloud Monitoring metric. LLM Obs rows are WRITTEN but not coded (see the phase-2 section of `money-1379-perf-monitors-plan.md`), gated on `ml_obs.*` being observed — MONEY-1238's rule, honoured rather than skipped. Two defects found while measuring: MONEY-1389 (stock-document-embed overruns the 600s ack deadline 423 times in 7d) and MONEY-1390 (the dead-letter consumer notifies for work that is still running); broker-sync's empty-shard 500s were fixed on the same branch. MONEY-1363 → **Superseded by MONEY-1380**, close it with a link to T13 rather than leaving it open (the reason is in the "Deferred, deliberately" table at the bottom of this file — its emit site never existed). MONEY-718 (Vercel APM) stays open as the next decision.

---

### T13 — LLM Observability (MONEY-1380)

**Why.** Every model call in the product was untraced. `packages/datadog`
carried an APM tracer, RUM, a logs path and a metrics path, and nothing at all
for the thing that costs the most per request. dd-trace auto-instruments
`@google/genai` and `@anthropic-ai/sdk`, so the LLM spans exist the moment the
tracer is wired; what the SDK cannot know is WHICH FEATURE a call belongs to,
and that grouping (`ml_app`) is what every LLM Obs dashboard, monitor and cost
breakdown hangs off.

**Files.**

- `packages/datadog/src/llmobs.ts` (new) — `llmWorkflow(mlApp, name, fn, opts)` and the `MlApp` union; re-exported from `src/index.ts:6` and reached as the `@usemoney/datadog/llmobs` subpath.
- `packages/datadog/src/tracer.ts` — `llmobsConfig(opts, envSource)`, spread into `tracerConfig` so the key is ABSENT rather than present-and-off.
- `apps/api/src/tracer.ts` (new), side-effect imported at `apps/api/src/app.ts:11`.
- `workers/Dockerfile:155` — the service CMD.
- `workers/cloudbuild.prod.yaml:345`, `workers/cloudbuild.qa.yaml:340` — `DD_LLMOBS_ENABLED`, on the `stockbook-workers` container only.
- `apps/web/next.config.js:106-107` — `serverExternalPackages`.
- Tests: `packages/datadog/__tests__/llmobs-wired.test.ts`, `llmobs-deploy-contract.test.ts`, `llmobs-wrap-coverage.test.ts`.

**The facts that decided the design.** Every one of them is silent when wrong,
which is why every one is pinned by a test rather than by a comment.

1. **The `llmobs` key is ABSENT from the tracer config unless `DD_LLMOBS_ENABLED` is truthy.** `dd-trace/src/config/index.js:1023` self-enables LLM Obs on the mere PRESENCE of an `llmobs` option (`if (this.#env['llmobs.enabled'] == null && options.llmobs)`). Passing a block with `enabled: false` inside it would therefore turn the product ON for every `initTracer` caller in the repo — local `yarn dev`, every test that boots the tracer, every environment that never opted in. And enabling it where there is no agent and no API key does not degrade quietly: `setAgentStrategy` probes the agent, fails, selects agentless, and `llmobs/index.js:69` THROWS from inside an async callback no caller's try/catch can reach. That is every local dev shell and every CI run killed by a telemetry feature. `llmobsConfig()` returns `undefined` and `tracerConfig` spreads it, so "off" is genuinely absent.

2. **`agentlessEnabled` is always an explicit boolean** — `false` on Cloud Run, `true` on Vercel. Same function, the other branch: `setAgentStrategy` returns immediately when the field is non-null and otherwise probes the agent's `/info` for `/evp_proxy/v2/`. That probe is a BOOT RACE against the `datadog-agent` sidecar. An app container that wins its own start against the sidecar gets an error, flips to agentless, and — with no `DD_API_KEY` on the app container, which is exactly how `workers/cloudbuild.*.yaml` is written — throws and kills the process. Resolving the field removes the race instead of narrowing it.

3. **`workers/Dockerfile` CMD gains `--import dd-trace/register.js`.** tsup emits ESM with the LLM SDKs external, and dd-trace patches ESM only through import-in-the-middle, which must be registered before the process loads anything. `register.js`, NOT `initialize.mjs` — the latter installs the loader hook AND calls `tracer.init()` from the environment, which overrides the `tracerConfig` this repo computes. Deliberately NOT applied to the `tiingo-realtime` command override or to the Cloud Run jobs: neither makes a model call, and the loader hook is not free. `llmobs-deploy-contract.test.ts` pins the CMD, the `register.js`-not-`initialize.mjs` choice, and the realtime exclusion.

4. **`DD_LLMOBS_ENABLED="1"` fits, and nothing else does.** Measured after the edit: the longest inline Cloud Build argument is 9,259 chars on prod and 9,237 on qa, leaving **41** and **63** characters over the 700-char headroom floor (`workers/__tests__/cloudbuild-arg-limit.test.ts`). One env var was the entire budget. That is why `ml_app` is sourced from CODE — `llmWorkflow()` at each entry point — instead of from a `DD_LLMOBS_ML_APP` variable per service, and the deploy contract asserts that variable appears NOWHERE.

5. **apps/api never initialised a tracer in production.** The Vercel entry imports `dist/app.js`; `initTracer` lived in `src/index.ts`, the local-dev entry. So the API's APM had been dark since it shipped, and LLM Obs would have been dark with it. The new `apps/api/src/tracer.ts` is side-effect imported from the TOP of `app.ts` — ESM evaluates imports in order, and a tracer imported second patches nothing that was loaded first.

6. **`next.config.js` externalizes `@google/genai` and `@anthropic-ai/sdk`.** A webpack-inlined module is never `require`d, so dd-trace's hook never fires and the auto-instrumentation produces zero spans while looking correctly configured.

7. **Vercel needs `DD_TRACE_ENABLED=true` AND `DD_APM_TRACING_ENABLED=false`.** LLM Obs initialises INSIDE `if (config.tracing !== false)` in `dd-trace/src/proxy.js`, so the `DD_TRACE_ENABLED=false` this document has recommended since §1 would have kept the whole product off. Tracing on so LLM Obs can start; APM spans off because there is no agent to receive them (`apps/api/src/tracer.ts:36`). Plus `DD_LLMOBS_ENABLED=1`, `DD_LLMOBS_AGENTLESS_ENABLED=1`, and `NODE_OPTIONS=--import dd-trace/register.js` on **api only** (it is the ESM bundle; web is not). These are FOUNDER-APPLIED — nothing in this repo touches Vercel, which is the same lane rule as T12's F4.

**The `ml_app` vocabulary.** One value per user-facing FEATURE, not one per
service or package: a research run spans `packages/research`, the worker and the
web preview route, and it is one thing to the person paying for it. `ml_app`
resolves as `explicit ‖ parent span's ‖ propagated tag ‖ config ‖ service name`
(`dd-trace/src/llmobs/tagger.js`), so wrapping ONE entry point tags every model
call underneath it, including calls several packages deep.

| `ml_app`     | Wrapped at                                                                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `research`   | `workers/src/processors/research.ts:31`, `comparison.ts:59`, `preview-plan.ts:55`, and `apps/web/app/api/research/preview-plan/route.ts:231` — the web route has its own lane                                                                        |
| `analysis`   | `workers/src/processors/l3-analysis.ts:111`                                                                                                                                                                                                          |
| `roast`      | `workers/src/processors/roast.ts:28`                                                                                                                                                                                                                 |
| `briefing`   | `workers/src/processors/login-briefing.ts:127`                                                                                                                                                                                                       |
| `doc-ingest` | `workers/src/processors/stock-document-ingest.ts:120`, `stock-document-parse.ts:95`                                                                                                                                                                  |
| `video`      | `workers/src/processors/studio-render.ts:68`                                                                                                                                                                                                         |
| `chat`       | `apps/web/app/api/chat/route.ts:285`, `apps/web/app/api/screener-chat/route.ts:108`                                                                                                                                                                  |
| `fire`       | `apps/web/lib/actions/fire-chat.ts:108` AND `apps/api/src/routes/v1/fire.ts:317` — wrapped at both CALLERS, because `packages/fire` is a shared library and wrapping it there would put a web turn and a mobile turn in one undistinguishable bucket |

An unwrapped call site is not lost: it lands under the SERVICE name, which reads
as a visible "not yet attributed" bucket rather than a drop. The long tail of
small web actions stays unwrapped until observed spend says which of them are
worth their own row.

**Prompt and completion text is captured, by default, with no toggle.** The JS
SDK parses only `DD_LLMOBS_ENABLED` / `_ML_APP` / `_AGENTLESS_ENABLED`, and
applies no span character limit. Decision: allow it, and scrub Datadog-side with
a Sensitive Data Scanner rule scoped to the LLM Obs product. Pinned as an
assertion in `llmobs-wired.test.ts:349` ("prompt AND completion text are on the
span by default") so the policy cannot be forgotten silently — a captured
payload nobody remembers capturing is the failure mode here, not a missing one.

**Scope corrections against the ticket.** Two of MONEY-1380's named surfaces
make ZERO model calls and were dropped: `services/us-fundamentals` (edgartools
is an XBRL parser, not a model) and `tiingo-realtime` (a websocket). And
embeddings are NOT covered: `packages/core/src/embeddings.ts:115` calls the
Vertex `:predict` endpoint through raw `fetch`, not `ai.models.embedContent`, so
auto-instrumentation never sees it. Worth its own follow-up ticket; do not read
an empty embeddings row as "we spend nothing there".

**NO monitors, deliberately** — MONEY-1238, which this directory has now shipped
four separate times. Instrument, watch the series arrive, then alert. The first
candidates once `ml_obs.*` has points: token spend per `ml_app`, p95 latency per
model, and error/refusal rate. A monitor built today would render NO DATA, which
after one mute is indistinguishable from health.

**Commit.** `feat(MONEY-1380): every model call reports to LLM Observability under the feature that made it`

---

### T14 — GCP integration and Cloud Cost Management (MONEY-1379)

**Why.** Everything monitored so far is something this repo EMITS. The platform
underneath it — Pub/Sub backlogs, Cloud Run instance saturation, GCE, Cloud
SQL — emits nothing to us at all, and the one number that sizes every batch in
this codebase (the 600 s ack deadline, see CLAUDE.md) is invisible today.

**Files.** `scripts/ops/datadog/setup-gcp-integration.sh` (new),
`packages/datadog/__tests__/gcp-integration-agreement.test.ts` (new).

**Six stages, `[--dry-run] [--from=STAGE] [--only=STAGE]`.**

| #   | Stage      | What it does                                                                                                                                   |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `apis`     | enables the eight Google APIs the crawl and the cost export read through; `services enable` is idempotent and silent on an already-enabled API |
| 1   | `sa`       | creates the integration service account and grants it exactly four roles                                                                       |
| 2   | `delegate` | `GET /api/v2/integration/gcp/sts_delegate` (POST only if absent), then grants that delegate `roles/iam.serviceAccountTokenCreator` on ours     |
| 3   | `register` | upserts the service account into the Datadog org — `resource_collection_enabled: true`, `automute: true`, `host_filters: []`                   |
| 4   | `cost`     | wires Cloud Cost Management, **fail-closed** on a missing BigQuery export                                                                      |
| 5   | `verify`   | polls until `gcp.*` points and the GCE hosts have actually ARRIVED                                                                             |

**Impersonation, not a key file.** The v1 integration wanted a downloaded JSON
key uploaded into Datadog: a long-lived credential for a project-wide reader,
living in two places at once, rotatable only by remembering to. v2 uses STS —
Datadog holds its own delegate service account, we grant that delegate token-
creator on ours, and Datadog mints a short-lived token per crawl. Nothing is
downloaded, so nothing can leak from a laptop, a backup or a screenshot, and
revocation is one IAM binding rather than a key hunt.

**Exactly four roles, all read.** `roles/monitoring.viewer` (the metrics),
`roles/compute.viewer` (GCE instances, so they can be reported as hosts),
`roles/cloudasset.viewer` (inventory and tags for Resource Collection), and
`roles/browser` — without which the crawl cannot even enumerate what it has been
given access to. A widening to `roles/editor` would work identically on day one
and hand a third party write access to the project forever, so
`gcp-integration-agreement.test.ts` pins the exact four and that edit cannot be
made quietly.

**The one thing the script cannot do.** Cloud Cost Management needs the
**Detailed Usage Cost** BigQuery export, and turning it on is a console action —
no API, no gcloud surface, no Terraform resource. It is also the step where
delay is PERMANENT: the export is not a query over history, it is a firehose
that starts the day it is switched on, so every day it stays off is a day of
cost data that will never exist, for any amount of money, later. Stage 4
therefore refuses rather than improvising: it lists the dataset, demands a
`gcp_billing_export_resource_v1_*` table, and exits **2** with the exact console
URL (resolved from the billing account id, so the message names the real page)
when there is none. A best-effort version would register a cost config against
an empty dataset, report success, and leave someone waiting 72 hours for numbers
that were never going to arrive — then another 72 after the export is finally
enabled. **This is the outstanding founder step, and it is the whole reason T14
is Todo rather than Done.**

**`verify` reports `pending`, not failure, for cost.** The metric poll is scoped
to this project (`{project_id:stock-book-483718}`) — an unscoped `gcp.*` query
would be satisfied by any other integration in the org, the same false pass as
querying a 24h window right after a config change — and the crawl takes 5-10
minutes. Cost lags 48-72 HOURS behind everything else, so it is deliberately not
a failure condition: the stage prints `cost: pending — re-run --only=verify
after 72h`. Treating a known lag as a red would train someone to ignore the
output of the one stage whose job is to be believed.

**What it costs.** The integration discovers Compute Engine instances and
reports them as billable Datadog infrastructure HOSTS. This project has four —
`usemoney-prod-redis`, `usemoney-qa-mongodb`, `algo-prod-worker`,
`algo-research-worker` — and all four become billable the moment the crawl
completes. That is the intended trade for GCE, Cloud Run, Pub/Sub and Cloud SQL
metrics arriving with no agent on anything. `host_filters` is the lever if only
the two `usemoney-*` boxes turn out to be worth paying for: it is sent EMPTY
today, and narrowing it is a one-field edit to stage 3's body plus a re-run, no
teardown.

**No `{qa|prod}` argument.** One GCP project, one Datadog org, nothing to choose
between. An environment argument here could only be accepted and ignored, and a
silently-ignored argument is how a mistyped dry run made 78 live requests against
a sibling script in this same directory. It is refused with a usage line.

**NO monitors yet, deliberately.** Not an omission and not an unfiled follow-up:
these series have never been seen in our org, and a monitor over a series nobody
emits renders NO DATA, which after one mute is indistinguishable from health
(MONEY-1238 again). The agreement test enforces it by scanning `monitor-*.json`
and `dashboards/` for any `gcp.*` query. The two worth having once stage 5 has
watched them arrive, in order:

1. `gcp.pubsub.subscription.oldest_unacked_message_age` — the 600 s ack deadline that sizes every batch in this repo is currently INVISIBLE. A handler that runs past it gets its message redelivered and a second copy of the job starts concurrently; nothing in the estate can see that today.
2. `gcp.run.container.instance_count` against max-instances — Cloud Run saturation, which presents as latency rather than as an error.

**Commit.** `feat(MONEY-1379): the GCP integration and Cloud Cost Management, as an idempotent six-stage script`

---

## 3. Deliberately deferred (founder decisions, not this batch)

- **MONEY-718 Vercel APM (web + api traces).** dd-trace needs an agent; Datadog has no agentless OTLP intake. Options: (a) an OpenTelemetry collector on Cloud Run with the Datadog exporter, `@vercel/otel` in web/api pointing at it; (b) accept RUM + logs as the web signal for the performance week. 8 points either way. Decide before the perf week; the RUM board (T8) is the fallback.
- **MONEY-455 status page** vendor.
- **Slack integration** for `@slack-…` routing (email works today).

## 4. Definition of done for the week

- Every scheduled job on both envs has a `stockbook.job.*` series on the new org (T1, T2, T5) and the zero-write / absence monitors are green-or-alerting, never NO DATA.
- The three APM services trace; workers, web, api and us-fundamentals logs arrive; RUM sessions arrive with boundary errors attributed.
- The negative test fired and was recorded.
- Four dashboards and four SLOs exist and read non-empty.
- `yarn verify:push` green on the final tree; PR merged; tickets closed with evidence.

---

## 5. Execution protocol (read once per session, follow per task)

Implementation runs on **Opus**, on branch **`fix/MONEY-1332`** (or the branch
the founder names at hand-off), with a second Claude session editing the same
tree. Verbatim code for every task is in
`docs/reference/datadog-monitoring-appendix.md` (sections A1–A13). Do not
research; read the appendix section, apply, test, commit, log.

### 5.1 Session start (every time)

```bash
git branch --show-current            # must be the hand-off branch
git status --short                   # every dirty file NOT yours is LOCKED
node -v                              # v22.x (husky needs it)
git log --oneline -3                 # the last commit should be the previous task's
```

Then read §6 (progress log) and take the first row that is not `done`. If the
row is `in-progress`, resume from its "Notes" cell.

### 5.2 Per task

1. Read the task in §2 and its appendix section. No other reading is needed
   unless the appendix marks a **RUNTIME CHECK**; run exactly that command.
2. Re-read each file immediately before editing it. Edit by exact string;
   whole-file writes only for NEW files.
3. Run the task's named tests, then its mutation checks, then restore.
4. `npx prettier --check <touched files>`; `--write` if needed and re-run the tests.
5. `TEST-COVERAGE.md`: add one row per new test file (measured case count) and
   bump the `**Total Test Files:**` headline by the number of new files; run
   `yarn test:coverage-check`.
6. Commit ONLY the task's files by explicit path, message
   `type(MONEY-n): <one line>` + body + the two trailers. Then update the §6 row
   (status, commit sha) and commit that one-line doc change with
   `docs(MONEY-1229): progress log — Tn`.
7. Move the task's Linear ticket to In Progress at step 1 and post a
   two-line comment at step 6 (commit sha, tests run, any RUNTIME CHECK result).

### 5.3 Phase gates

- After T4 (end of phase A): `yarn build` (must be green, ~2.5 min).
- After T9 (end of phase D): `yarn build` again.
- After T11 (all code): ask the founder to confirm the other session is idle,
  then `yarn verify:push` (build + full suite + marker). If red: fix the SOURCE
  (`.claude/skills/fixing-bugs`), never the test. `VERIFY_SERIAL=1` on a
  task-level (not case-level) failure.
- T12 needs the founder's gates (T0 application key, merge, Vercel). Stop and
  report at each ⛔; do not improvise around one.

### 5.4 Never

`git add -A`/`.`/`-u`; `git stash`; `git checkout -- <file>`; `git reset`;
branch switches; editing a LOCKED file; touching `.claude/.verify-ok`; pushing
without the marker; pasting a key into any file or message.

### 5.5 Hand-off to the founder (one message at the end of the batch)

Commits (sha + task), what `verify:push` said, the monitor/SLO/dashboard
counts rendered by each `--dry-run`, the RUNTIME CHECK results, and the exact
founder steps left in T12.

---

## 6. Todo list

Regenerated 2026-09-05. This table IS the todo list — the plan's tasks with a
state, a commit and what is left. `BLOCKED` means blocked on the founder and is
not something an implementation session can clear.

**Legend.** `DONE` committed on `feat/MONEY-1229` · `RUNNING` a subagent is
building it now · `TODO` not started · `BLOCKED` needs a founder action first.

### Build tasks

| #   | Ticket                   | State       | Commit                     | What it is / what is left                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------ | ----------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0  | —                        | **BLOCKED** | —                          | `DD_APP_KEY_PROD` / `_QA` into Secret Manager. Gates RUM app creation, the QA key mint, and EVERY apply script — nothing below can be run for real until this lands                                                                                                                                                                                                                                                                                                                                  |
| T1  | MONEY-1278               | **DONE**    | `469025a7`                 | 7 provisioners + `xbrl-reparse` + `doc-ingest-backfill`; population DERIVED from `--command="node,…"`, the `$env_vars` indirection resolved; 6 mutations                                                                                                                                                                                                                                                                                                                                             |
| T2  | MONEY-1278               | **DONE**    | `becc36ea`                 | `DD_METRICS_TRANSPORT` http on the 5 Python jobs / statsd on the service; v1-intake POST, no-op without a key; 6 mutations, one of which caught a vacuous no-key case swallowed by the module's own catch-all                                                                                                                                                                                                                                                                                        |
| T3  | MONEY-1357               | **DONE**    | `e9a3e40b`                 | sidecar + key + own service name on both realtime specs; the guard extracts the HEREDOC and asserts PER CONTAINER, because a block-wide key regex was satisfied by the sidecar                                                                                                                                                                                                                                                                                                                       |
| T3b | MONEY-1357               | **DONE**    | `47c5a50d`                 | 12 counters + 4 gauges from `flushTick`'s `finally`; reconnect-reset clamp, non-finite skip, tag cardinality collapse; 9 mutations                                                                                                                                                                                                                                                                                                                                                                   |
| T4  | MONEY-1331               | **DONE**    | `cf367e9d`                 | RUNTIME CHECK falsified the ticket's premise — the outcome line IS in Cloud Logging as `jsonPayload`; the ticket read `textPayload`. No fallback shipped (machinery for a non-problem); Python reachability ratchet added instead, 7/7 already correct                                                                                                                                                                                                                                               |
| T5  | MONEY-1266 / 1293 / 1358 | **DONE**    | `bcc66a57`, `2eeb103a`     | prod 45 / qa 13. Absence template promoted to a file; 3 new absence rows + 3 EDGAR + `tiingo-news-poll`; `PROD_ONLY_JOBS` completed 2 -> 6 edgar triggers. The week-long cron simulation found TWO live defects: `feed-parse` and `xbrl-ratios` at 36h on `1-5` crons, i.e. NO DATA every weekend                                                                                                                                                                                                    |
| T6  | MONEY-1359               | **DONE**    | `6efc930e`, fix `d3032ad5` | prod 14 / qa 11 across 9 templates; transport extracted to `lib-datadog.sh`. Every row preflights. 13 mutations; TWO assertions were vacuous when written and are now anchored outside the file. The follow-up commit fixed a live defect I shipped: the LCP diagnostic could abort the run part-way under `set -euo pipefail`                                                                                                                                                                       |
| T7  | MONEY-1360               | **DONE**    | `557fc35e`                 | four 30d prod SLOs; qa renders zero and SAYS so. Fails closed BELOW a per-row `min_monitors`, not only at zero — a pattern narrowed 40 -> 1 still resolves something and reads 100% compliant forever. 30 cases, 12 mutations; its strongest case JOINS against the real `apply-monitors.sh` render                                                                                                                                                                                                  |
| T8  | MONEY-1361               | **DONE**    | `8045c537`                 | five boards, 37 widgets, upserted by TITLE; the env argument selects credentials only. Every metric checked against the emitted inventory. DROPPED `broker.sync.duration` and `pairing.trades_processed` — JSDoc examples with zero call sites, so the planned runtime check understated it: there is no base series to have sub-series of. 21 cases, 13 mutations                                                                                                                                   |
| T9  | MONEY-1362               | **DONE**    | `cc65057d`                 | Org-level, so it takes NO env argument and REFUSES one. The PUT REPLACES the filter array, so existing filters merge BY NAME and retention is ECHOED not omitted. The remapper half is UNVERIFIED against live data by design. 26 cases, 15 mutations. Found the spec named `dd_logs_have_events`, which does not exist                                                                                                                                                                              |
| T10 | MONEY-726                | **DONE**    | `efe36ef5`                 | `addError` from both boundaries with a `boundary` tag + the Next `digest`; `global-error.tsx` self-inits behind `getInitConfiguration()` because it renders OUTSIDE the provider. Init object extracted to `lib/datadog/rum-init.ts`. 16 mutations                                                                                                                                                                                                                                                   |
| T11 | MONEY-716                | **DONE**    | `5c5d02bd`                 | `redact.paths` beside the existing shape matcher. TWO honest limits in the test: `*` matches exactly ONE level so `*.email` is inert against all 12 live sites, and a bare `email` path would blank the two audit lines. Spun off MONEY-1366                                                                                                                                                                                                                                                         |
| T13 | MONEY-1380               | **DONE**    | —                          | LLM Obs on every model call. `llmWorkflow()` at 15 entry points across 8 `ml_app` values; `llmobsConfig()` keeps the key ABSENT when off, because merely PASSING one self-enables the product and then throws from an async callback with no agent and no key. Found and fixed a pre-existing dark surface: apps/api never initialised a tracer in production at all. `DD_LLMOBS_ENABLED` was the ONLY variable that fit — 41 chars of headroom left on prod, 63 on qa — so `ml_app` comes from code |
| T14 | MONEY-1379               | **TODO**    | —                          | Six-stage `setup-gcp-integration.sh`: STS impersonation, four read-only roles, org registration, Cloud Cost, verify. Blocked on ONE founder console action (the Detailed Usage Cost BigQuery export, which has no API) — and stage 4 refuses rather than registering a config over an empty dataset. Turns 4 GCE VMs into billable hosts; `host_filters` is the lever. No monitors until stage 5 has watched the series arrive                                                                       |

### Close-out sequence — run in this order

| #   | Step                               | State    | Notes                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Integrate T7 + T8                  | **DONE** | both dry runs and both mutation tables re-derived here rather than taken on trust; T8's own report was accurate                                                                                                                                                                                                                                                                              |
| C2  | Fold `DD_API_HOST` into the lib    | **DONE** | it was FIVE copies, not the three the T9 agent could see — `apply-monitors.sh` derived it inside a combined `read`, which an assignment-only scan reports as compliant. `dd_resolve_api_host` owns it now (`931cd150`)                                                                                                                                                                       |
| C3  | Restamp `TEST-COVERAGE.md`         | **DONE** | 1330 -> 1334, four new rows, counts measured per file from `# tests`                                                                                                                                                                                                                                                                                                                         |
| C4  | `scripts/README.md`                | **DONE** | sections for `apply-slos.sh`, `apply-dashboards.sh`, `set-dd-secret.sh`                                                                                                                                                                                                                                                                                                                      |
| C5  | `yarn build`                       | **DONE** | green, exit 0; re-run inside the serial gate below                                                                                                                                                                                                                                                                                                                                           |
| C6  | `VERIFY_SERIAL=1 yarn verify:push` | **DONE** | Green at 36/36. Took five runs and the cause was NOT the flake the gate's own advice names: serial mode serializes turbo tasks ACROSS packages while node still forks per-core INSIDE one, so five slow cache files in apps/web timed out at 30s. Capped node at 4 — 20,780 pass, 0 cancelled, +24s. Re-running after the review fixes                                                       |
| C7  | `/code-review` on the branch diff  | **DONE** | 15 findings + a 7-item sweep. The biggest: `trace.http.request.*` is the dd-trace CLIENT span, so the APM monitors, the SLO and two widgets measured our OUTBOUND vendor calls. Verified in the vendored schema before acting                                                                                                                                                                |
| C8  | Fix review findings                | **DONE** | 4 parallel agents on disjoint file sets, 5 commits. 39 mutations across the four, all red; FOUR assertions were green first time and were fixed rather than the bar lowered. Two of my own instructions were WRONG and the agents said so: `level:` would have been as dormant as `status:` (it is `@level:`), and dropping the realtime health spans would have killed two live instruments |
| C9  | Push + PR                          | **TODO** | blocked on C6 re-running green                                                                                                                                                                                                                                                                                                                                                               |
| C10 | Close MONEY-1360 / 1361 / 1229     | **TODO** | 1359, 1362, 726, 716 are already closed with evidence                                                                                                                                                                                                                                                                                                                                        |

### Cutover — EXECUTED 2026-09-06

Ran for real against us5. Everything below is measured, not planned.

| Step                     | State        | Result                                                                                                                                                                               |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Secrets                  | **DONE**     | all four stored via `set-dd-secret.sh`, each validated against us5 BEFORE it was written. The QA API key first supplied was the Key ID pasted twice, and the pairing check caught it |
| RUM applications         | **DONE**     | `stockbook-web` and `stockbook-web-qa`. One already existed and was REUSED, not duplicated — the idempotency guard earned itself on its first live run                               |
| Sidecars rolled          | **DONE**     | all six services onto the new keys                                                                                                                                                   |
| Ingest proof             | **PASSED**   | `stockbook.job.selected` returned a series. The gate is what allowed the applies to proceed                                                                                          |
| Job + service monitors   | **DONE**     | 47 on prod, 0 on qa                                                                                                                                                                  |
| SLOs                     | **DONE**     | 4                                                                                                                                                                                    |
| Dashboards               | **DONE**     | 5                                                                                                                                                                                    |
| Log config               | **NOT YET**  | the org has no `main` index because it has ingested no logs. Datadog creates it on the first one. Reported as a not-yet, correctly, rather than as a failure                         |
| Service monitors refused | **11 of 13** | correctly — no logs, no RUM views, and `stockbook.rt.*` does not exist until this branch is deployed                                                                                 |

### SIX Datadog limits found by applying, none of them documented anywhere we read

Every one of these had already shipped, and all six were invisible until a real
apply. This is the argument for the runtime step in one table.

| Limit                                           | Symptom                             |
| ----------------------------------------------- | ----------------------------------- |
| `no_data_timeframe` <= 4320 min                 | 35 of 37 monitors refused 400       |
| query window <= 30 days (`d` 1..30, `h` 1..720) | a 32d window refused in BOTH units  |
| SLO `monitor_ids` <= 20                         | one SLO resolved 40 and was refused |
| dashboard `live_span` is a fixed enum           | `36h` is not a member               |
| SLO widgets require `show_error_budget`         | one board refused                   |
| `new_group_delay` is multi-alert only           | one monitor refused                 |

The no-data cap needed a RULE, not a clamp. A no-data alarm means something only
when its timeframe exceeds the job's legitimate maximum gap; clamping 21
long-window monitors to 72h would have made them fire every weekend, which is
exactly how the original set got muted. So no-data is ON where the window fits
under the ceiling and OFF where it does not.

### QA monitoring is OFF — founder decision, 2026-09-06

One switch: `DD_QA_MONITORING`, default `off`, in `lib-datadog.sh`. Both apply
scripts refuse `qa` and exit 0; the runner no longer calls them. The 13 QA
monitors that had been created were deleted. `DD_QA_MONITORING=on` restores all
of it, because everything is keyed by name and tagged.

### Founder actions — none of these are executable from a session here

| #   | Step                          | State       | Notes                                                                                                                                                                   |
| --- | ----------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | App key into Secret Manager   | **BLOCKED** | `DD_APP_KEY_PROD` / `_QA`. This is T0 and it gates F2-F6                                                                                                                |
| F2  | Mint the QA key via the API   | **BLOCKED** | straight into Secret Manager, never through a chat transcript. Then DELETE key id `f20f6ba9…`                                                                           |
| F3  | Create both RUM applications  | **BLOCKED** | `stockbook-web` and `stockbook-web-qa`; the ids and client tokens are public by design and go into the Vercel table                                                     |
| F4  | Vercel variables              | **BLOCKED** | the table is in appendix A13. NOTHING in this repo touches Vercel — the executable lane is gcloud and code only                                                         |
| F5  | Roll the sidecar services     | **BLOCKED** | so warm instances pick up the new key                                                                                                                                   |
| F6  | Prove ingest, THEN apply      | **BLOCKED** | query `stockbook.job.selected` for a non-empty series BEFORE running any apply script — applying against an org with no data is how a monitor set gets muted on day one |
| F7  | The negative test             | **BLOCKED** | push a synthetic selected=3/written=0 at `[qa] feed-parse`, wait for the ALERT and the email, then recover it. The monitor exists — verified in the qa dry run          |
| F8  | Retire the bootstrap prod key | **BLOCKED** | it sat in a chat transcript. Mint a successor into the secret, roll, then delete key id `929a3b6a…`                                                                     |

### Deferred, deliberately

| Ticket     | Why it is not in this branch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MONEY-1363 | **SUPERSEDED by MONEY-1380 (T13) — close it, do not defer it.** It proposed hand-rolled `llm.tokens.*` / `llm.cost_inr` counters emitted "at the single point where `usageMetadata` is read in `client.ts`". That anchor DOES NOT EXIST: `packages/core/src/gemini/client.ts` mentions `usageMetadata` only in two doc comments (`:21`, `:308`) and reads it nowhere — see the corrected T8 bullet. Native LLM Observability now emits token counts plus model and provider metadata as first-class `ml_obs.*` data, with no counters to maintain and no emit site to keep true. Its one surviving good idea was its `surface` vocabulary (chat, research, roast, doc-ingest, filing-insight), which became the `ml_app` vocabulary in T13 |
| MONEY-1366 | Emails reach Cloud Logging through `console.*` message TEXT. `redact` matches object keys and can never see a `msg` string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| MONEY-718  | APM distributed tracing on Vercel. `DD_TRACE_ENABLED=false` there because there is no agent to reach                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
