# Datadog monitoring build-out — implementation appendix

Verbatim artefacts for `datadog-monitoring-plan.md`. One section per task.
Paths are repo-relative; line anchors are as of commit `2cd685e7` and are hints,
not contracts — re-read the file before every edit (a second session edits
this tree). Everything marked **RUNTIME CHECK** needs a live call and is the
only research the implementer does.

---

## A1 — T1: TypeScript Cloud Run jobs get a metrics path (MONEY-1278)

### A1.1 Provisioner edits

Every provisioner has an env `case` that picks `DB_SECRET`. Add `DD_SECRET`
beside it, then extend the two flags. `--set-env-vars` REPLACES the list, so
the additions go INTO the existing string.

`scripts/ops/setup-feed-backfill-job.sh` (`case` :133-134, `deploy_job` :230-262):

```bash
    prod) BUCKET="stockbook-content-prod"; DB_SECRET="DATABASE_URL_PROD"; DD_SECRET="DD_API_KEY_PROD" ;;
    qa)   BUCKET="stockbook-content-qa";   DB_SECRET="DATABASE_URL_QA";   DD_SECRET="DD_API_KEY_QA" ;;
```

```bash
    local env_vars="FEED_ARCHIVE_MODE=archive,GCP_STORAGE_BUCKET=${BUCKET},GCP_PROJECT_ID=${PROJECT_ID},DD_ENV=${ENV},DD_TRACE_ENABLED=false"
    …
        --set-secrets="DATABASE_URL=${DB_SECRET}:latest,GCP_SERVICE_ACCOUNT_KEY_BASE64=GCP_SERVICE_ACCOUNT_KEY_BASE64:latest,DD_API_KEY=${DD_SECRET}:latest"
```

(`${ENV}` is whatever variable that script's `case` switches on — read the
`case` line.) Every `deploy_job` call in the file (feed-backfill, feed-parse,
feed-repair, fo-summary) inherits it because both flags are built inside
`deploy_job()`.

Same two edits, same shape, in:

| file                                             | `case` lines | `--set-env-vars` | `--set-secrets` |
| ------------------------------------------------ | ------------ | ---------------- | --------------- |
| `scripts/ops/setup-xbrl-backfill-job.sh`         | :179, :184   | :305             | :306            |
| `scripts/ops/setup-xbrl-projection-drain-job.sh` | :185, :188   | :321             | :322            |
| `scripts/ops/setup-xbrl-reparse-job.sh`          | :168, :173   | :289             | :290            |
| `scripts/ops/setup-tiingo-backfill-job.sh`       | :202, :211   | :338             | :345            |
| `scripts/ops/setup-bse-backfill-job.sh`          | :141, :145   | :231             | :232            |
| `scripts/ops/setup-doc-ingest-backfill-job.sh`   | :271, :277   | :565             | :566            |

Add a one-line comment above each `--set-env-vars`: `# DD_ENV + DD_TRACE_ENABLED=false + DD_API_KEY: MONEY-1278 — a job with no key emits nothing; the image bakes DD_TRACE_ENABLED=true and a job has no agent.`

### A1.2 `scripts/jobs/xbrl-reparse.ts`

```ts
import { flushMetrics } from "@usemoney/datadog/metrics";
```

End of `main()` (:467-470 today):

```ts
  process.exitCode = code;
  // MONEY-1278 — datadog-metrics flushes on a 15 s timer; a job that exits
  // first loses the batch, so the outcome above never leaves the process.
  await flushMetrics();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[xbrl-reparse] FAILED", err);
  await flushMetrics().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(1);
});
```

### A1.3 `packages/core/__tests__/ops/job-metrics-path.test.ts` (new)

```ts
/**
 * MONEY-1278 — a Cloud Run JOB that declares Datadog env has a WORKING metrics
 * path. Measured 2026-09-05: all 17 TypeScript jobs carried no DD_* env at all,
 * so `datadog-metrics` no-op'd and `feed-parse`'s monitored series never
 * existed. Two halves, both scanned as text (the provisioners are bash):
 *   1. every provisioner that deploys a job passes DD_API_KEY (secret), DD_ENV
 *      and DD_TRACE_ENABLED=false (the image bakes it true; a job has no agent)
 *   2. every scripts/jobs/*.ts that reports an outcome flushes before exit
 * Exemptions are dated and RATCHET: a file that now complies must leave the map.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const OPS = join(ROOT, "scripts", "ops");
const JOBS = join(ROOT, "scripts", "jobs");

/**
 * file -> reason. EMPTY at the start of this batch — PR #401 merged the
 * doc-ingest lane, so nothing is deferred. Kept as a map, and ratcheted by the
 * two tests below, so a future deferral must carry a dated reason rather than
 * quietly dropping a file out of the scan.
 */
const PROVISIONER_EXEMPT: ReadonlyMap<string, string> = new Map();
const JOB_EXEMPT: ReadonlyMap<string, string> = new Map();

const provisioners = readdirSync(OPS)
  .filter((f) => /^setup-.*-job(s)?\.sh$/.test(f))
  .filter((f) => /run jobs deploy/.test(readFileSync(join(OPS, f), "utf8")))
  .filter((f) => !/us-fundamentals/.test(f)) // Python; covered by test_deploy_contract.py
  .filter((f) => !/setup-sync-job/.test(f)); // cloud-sdk image, no Node runtime, nothing to emit
const jobScripts = readdirSync(JOBS)
  .filter((f) => /\.(ts|mts)$/.test(f))
  .filter((f) =>
    /reportJobOutcome\(/.test(readFileSync(join(JOBS, f), "utf8")),
  );

describe("MONEY-1278 — every TypeScript job has a working metrics path", () => {
  it("PREMISE: the scans found the population", () => {
    assert.ok(
      provisioners.length >= 6,
      `provisioners: ${provisioners.join(",")}`,
    );
    assert.ok(
      jobScripts.length >= 3,
      `reporting job scripts: ${jobScripts.join(",")}`,
    );
  });

  for (const f of provisioners) {
    it(`${f} passes DD_API_KEY, DD_ENV and DD_TRACE_ENABLED=false to every job`, (t) => {
      if (PROVISIONER_EXEMPT.has(f)) {
        t.diagnostic(`exempt: ${PROVISIONER_EXEMPT.get(f)}`);
        return;
      }
      const src = readFileSync(join(OPS, f), "utf8");
      const secrets = [...src.matchAll(/--set-secrets="([^"]+)"/g)].map(
        (m) => m[1],
      );
      const envs = [...src.matchAll(/--set-env-vars="([^"]+)"/g)].map(
        (m) => m[1],
      );
      assert.ok(
        secrets.length >= 1 && envs.length >= 1,
        `${f}: no flags found`,
      );
      for (const s of secrets)
        assert.match(
          s,
          /DD_API_KEY=\$\{DD_SECRET\}:latest|DD_API_KEY=DD_API_KEY_/,
          `${f}: secrets lack DD_API_KEY`,
        );
      for (const e of envs) {
        assert.match(e, /DD_ENV=/, `${f}: env lacks DD_ENV`);
        assert.match(
          e,
          /DD_TRACE_ENABLED=false/,
          `${f}: env lacks DD_TRACE_ENABLED=false`,
        );
      }
    });
  }

  it("the provisioner exemption map only names files that still fail (ratchet)", () => {
    for (const [f] of PROVISIONER_EXEMPT) {
      const src = readFileSync(join(OPS, f), "utf8");
      assert.ok(
        !/DD_API_KEY=/.test(src),
        `${f} now complies — delete its exemption`,
      );
    }
  });

  for (const f of jobScripts) {
    it(`${f} flushes metrics before it exits`, (t) => {
      if (JOB_EXEMPT.has(f)) {
        t.diagnostic(`exempt: ${JOB_EXEMPT.get(f)}`);
        return;
      }
      const src = readFileSync(join(JOBS, f), "utf8");
      assert.match(
        src,
        /flushMetrics\(/,
        `${f} reports an outcome and never flushes — the batch dies with the process`,
      );
    });
  }

  it("the job exemption map only names files that still fail (ratchet)", () => {
    for (const [f] of JOB_EXEMPT) {
      assert.ok(
        !/flushMetrics\(/.test(readFileSync(join(JOBS, f), "utf8")),
        `${f} now complies — delete its exemption`,
      );
    }
  });
});
```

Mutation checks: remove `DD_API_KEY=` from `setup-bse-backfill-job.sh` → red; remove `flushMetrics` from `feed-parse.ts` → red; restore both.
TEST-COVERAGE row: `packages/core/__tests__/ops/job-metrics-path.test.ts` (count after writing).

---

## A2 — T2: Python jobs emit over HTTP (MONEY-1278)

### A2.1 `services/us-fundamentals/app/settings.py`

After `DD_SERVICE_DEFAULT` (:41):

```python
#: Datadog site — mirrors ``DD_SITE`` in ``packages/datadog/src/constants.ts``
#: (us5 since the Sep-2026 org move, MONEY-1229). Only the HTTP metrics path
#: reads it; the service's DogStatsD/ddtrace go to the sidecar on localhost.
DD_SITE = "us5.datadoghq.com"


def metrics_transport() -> str:
    """``"http"`` iff DD_METRICS_TRANSPORT is exactly ``"http"``; else ``"statsd"``.

    Literal comparison, like every flag in this service: a Cloud Run JOB has no
    sidecar, so its counters must go over HTTP (MONEY-1278); the SERVICE keeps
    DogStatsD. Absent or anything else is statsd, the shipped default.
    """
    return "http" if _env("DD_METRICS_TRANSPORT") == "http" else "statsd"
```

### A2.2 `services/us-fundamentals/app/store/outcome.py`

Add imports `import os, time, urllib.request` (json already imported). After the statsd seam (:84-108):

```python
_http_sender: Callable[[list[dict[str, Any]]], None] | None = None


def set_http_sender_for_tests(sender: Callable[[list[dict[str, Any]]], None] | None) -> None:
    global _http_sender
    _http_sender = sender


def _count(metric: str, value: int, tags: list[str]) -> dict[str, Any]:
    return {"metric": metric, "type": "count", "points": [[int(time.time()), value]], "tags": tags}


def _http_send_series(series: list[dict[str, Any]]) -> None:
    """POST the series to the v1 intake. NO-OP without DD_API_KEY (the TS contract)."""
    api_key = os.environ.get("DD_API_KEY")
    if not api_key:
        return
    req = urllib.request.Request(
        f"https://api.{settings.DD_SITE}/api/v1/series",
        data=json.dumps({"series": series}).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "DD-API-KEY": api_key},
    )
    with urllib.request.urlopen(req, timeout=5):  # noqa: S310 — fixed https host
        pass
```

In `report_job_outcome`, replace the statsd block with:

```python
    if settings.metrics_transport() == "http":
        series = [
            _count(JOB_METRIC_SELECTED, selected, tags),
            _count(JOB_METRIC_WRITTEN, written, tags),
            _count(JOB_METRIC_FAILED, failed, tags),
            _count(JOB_METRIC_TRANSPORT_FAILURES, transport_failures, tags),
        ]
        try:
            (_http_sender or _http_send_series)(series)
        except Exception:
            pass
    else:
        statsd = _get_statsd()
        if statsd is not None:
            try:
                … (existing four increments) …
            except Exception:
                pass
```

`record_latency` is unchanged (statsd only; the service has the sidecar).

### A2.3 `scripts/ops/setup-us-fundamentals-jobs.sh`

`case` (:195-208): add `DD_SECRET="DD_API_KEY_PROD"` / `"DD_API_KEY_QA"`.
`:363` append `,DD_METRICS_TRANSPORT=http` to `--set-env-vars`.
`:387` → `--set-secrets="DATABASE_URL=${DB_SECRET}:latest,REDIS_URL=${REDIS_SECRET}:latest,OPENFIGI_API_KEY=${OPENFIGI_SECRET}:latest,DD_API_KEY=${DD_SECRET}:latest"`.
Service specs (`cloudbuild.{qa,prod}.yaml`): add `- name: DD_METRICS_TRANSPORT` / `value: "statsd"` to the `us-fundamentals` container env (present-and-explicit).

### A2.4 Tests

`tests/test_outcome.py` — add (fixture pattern: `monkeypatch.setenv`, `set_http_sender_for_tests`):

```python
def test_http_transport_posts_the_four_counters_once(monkeypatch) -> None:
    from app.store import outcome
    monkeypatch.setenv("DD_METRICS_TRANSPORT", "http")
    sent: list[list[dict]] = []
    outcome.set_http_sender_for_tests(lambda series: sent.append(series))
    try:
        outcome.report_job_outcome("j", selected=3, written=0)
    finally:
        outcome.set_http_sender_for_tests(None)
    assert len(sent) == 1
    names = [s["metric"] for s in sent[0]]
    assert names == [
        "stockbook.job.selected", "stockbook.job.written",
        "stockbook.job.failed", "stockbook.job.transport_failures",
    ]
    assert all(s["type"] == "count" for s in sent[0])
    assert "job:j" in sent[0][0]["tags"]
    assert any(t.startswith("env:") for t in sent[0][0]["tags"])


def test_http_transport_never_raises(monkeypatch) -> None:
    from app.store import outcome
    monkeypatch.setenv("DD_METRICS_TRANSPORT", "http")
    def boom(_): raise RuntimeError("intake down")
    outcome.set_http_sender_for_tests(boom)
    try:
        outcome.report_job_outcome("j", selected=1, written=1)  # must not raise
    finally:
        outcome.set_http_sender_for_tests(None)


def test_http_transport_is_a_no_op_without_a_key(monkeypatch) -> None:
    import urllib.request
    from app.store import outcome
    monkeypatch.setenv("DD_METRICS_TRANSPORT", "http")
    monkeypatch.delenv("DD_API_KEY", raising=False)
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: (_ for _ in ()).throw(AssertionError("socket opened")))
    outcome.report_job_outcome("j", selected=1, written=1)


def test_statsd_stays_the_default(monkeypatch, statsd) -> None:
    monkeypatch.delenv("DD_METRICS_TRANSPORT", raising=False)
    from app.store import outcome
    outcome.report_job_outcome("j", selected=1, written=1)
    assert statsd.calls, "statsd path must still emit when the flag is absent"
```

`tests/test_deploy_contract.py` — add, using `_env_entries` (:200) and the `deploy_job` regex (:268-269):

```python
def test_every_job_posts_metrics_over_http_with_a_key() -> None:
    src = JOBS_SCRIPT.read_text()
    env_line = re.search(r'--set-env-vars="([^"]+)"', src).group(1)
    secrets_line = re.search(r'--set-secrets="([^"]+)"', src).group(1)
    assert "DD_METRICS_TRANSPORT=http" in env_line
    assert "DD_API_KEY=${DD_SECRET}:latest" in secrets_line
    for env in ("prod", "qa"):
        assert re.search(rf'{env}\)[\s\S]*?DD_SECRET="DD_API_KEY_{env.upper()}"', src)


@pytest.mark.parametrize("env", ["qa", "prod"])
def test_the_service_keeps_dogstatsd(env: str) -> None:
    entries = _env_entries(env)
    assert entries.get("DD_METRICS_TRANSPORT", {}).get("value") == "statsd"
    assert "datadog-agent" in _containers(env)
```

---

## A3 — T3: `tiingo-realtime` wiring (MONEY-1357)

### A3.1 `packages/datadog/src/constants.ts`

```ts
export const DD_SERVICES = {
  WEB: "stockbook-web",
  API: "stockbook-api",
  WORKERS: "stockbook-workers",
  /** MONEY-1357 — its own name; it ran under stockbook-workers and reported nothing. */
  REALTIME: "tiingo-realtime",
} as const;
```

### A3.2 `workers/src/realtime/main.ts` :55-56

```ts
import { initTracer } from "@usemoney/datadog";
import { DD_SERVICES } from "@usemoney/datadog/constants";
initTracer({ service: DD_SERVICES.REALTIME });
```

### A3.3 `workers/cloudbuild.prod.yaml` realtime heredoc (:768-823). QA is identical with `-qa`, `_QA`, `env: qa`.

Under `spec.template.metadata.annotations` (after `cpu-throttling`, :781):

```yaml
run.googleapis.com/container-dependencies: '{"tiingo-realtime":["datadog-agent"]}'
```

In the `tiingo-realtime` container `env:` (:809), add before `TIINGO_API_KEY`:

```yaml
- name: DD_TRACE_ENABLED
  value: "true"
- name: DD_SERVICE
  value: tiingo-realtime
- name: DD_ENV
  value: production
- name: DD_VERSION
  value: "$COMMIT_SHA"
- name: DD_TRACE_AGENT_URL
  value: "http://localhost:8126"
- name: DD_API_KEY
  valueFrom:
    secretKeyRef:
      name: DD_API_KEY_PROD
      key: latest
```

After the `tiingo-realtime` container's `resources:` block, a second container (copy of the workers sidecar, `DD_SERVICE` changed):

```yaml
- name: datadog-agent
  image: gcr.io/datadoghq/serverless-init:latest
  env:
    - name: DD_SITE
      value: us5.datadoghq.com
    - name: DD_ENV
      value: production
    - name: DD_SERVICE
      value: tiingo-realtime
    - name: DD_APM_ENABLED
      value: "true"
    - name: DD_HEALTH_PORT
      value: "5555"
    - name: DD_VERSION
      value: "$COMMIT_SHA"
    - name: DD_API_KEY
      valueFrom:
        secretKeyRef:
          name: DD_API_KEY_PROD
          key: latest
  startupProbe:
    tcpSocket:
      port: 5555
    periodSeconds: 10
    failureThreshold: 5
  resources:
    limits:
      memory: 256Mi
```

`$COMMIT_SHA` and `$PROJECT_ID` are Cloud Build substitutions inside this heredoc already (see `image:`), so they render.

### A3.4 `workers/__tests__/realtime/realtime-wiring.test.ts` — new describe

```ts
describe("MONEY-1357 — tiingo-realtime is wired to Datadog under its own name", () => {
  const heredoc = (file: string) => {
    const src = readFileSync(join(ROOT, "workers", file), "utf8");
    const m =
      /cat > \/tmp\/tiingo-realtime\.yaml << EOF\n([\s\S]*?)\n\s*EOF/.exec(src);
    assert.ok(m, `${file}: realtime heredoc not found`);
    return m[1];
  };
  for (const file of ["cloudbuild.prod.yaml", "cloudbuild.qa.yaml"]) {
    it(`${file}: sidecar, key, service name, dependency annotation`, () => {
      const y = heredoc(file);
      assert.match(
        y,
        /- name: datadog-agent\n\s+image: gcr\.io\/datadoghq\/serverless-init:latest/,
      );
      assert.equal(
        [...y.matchAll(/name: DD_SERVICE\n\s+value: tiingo-realtime/g)].length,
        2,
        "both containers",
      );
      assert.match(
        y,
        /name: DD_API_KEY\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: DD_API_KEY_(PROD|QA)/,
      );
      assert.match(
        y,
        /container-dependencies: '\{"tiingo-realtime":\["datadog-agent"\]\}'/,
      );
      assert.match(
        y,
        /DD_TRACE_AGENT_URL\n\s+value: "http:\/\/localhost:8126"/,
      );
    });
  }
  it("main.ts initialises the tracer as DD_SERVICES.REALTIME", () => {
    const src = readFileSync(
      join(ROOT, "workers/src/realtime/main.ts"),
      "utf8",
    );
    assert.match(src, /initTracer\(\{ service: DD_SERVICES\.REALTIME \}\)/);
    assert.doesNotMatch(src, /service: "stockbook-workers"/);
  });
});
```

(`ROOT` — reuse the file's existing repo-root constant.) Mutation: delete the sidecar block → red.

---

## A4 — T3b: realtime metrics + liveness (MONEY-1357)

### A4.1 `workers/src/realtime/rt-metrics-logic.ts` (new)

```ts
/**
 * MONEY-1357 — the realtime holder's counters, as Datadog series.
 *
 * Pure: takes two snapshots, returns the deltas to emit. Kept out of main.ts
 * so the arithmetic is testable and so the metric NAME LIST is importable by
 * the dashboard-inventory test (a widget on a series nobody emits is NO DATA).
 */
export interface RtCounterSnapshot {
  barsClosed: number;
  candlesWritten: number;
  refusedMixedSource: number;
  quotesWritten: number;
  quoteWriteFailures: number;
  framesDropped: number;
  leaderTransitions: number;
  bytesRecorded: number;
}

/** Bare names — `datadog-metrics` prepends `stockbook.`; monitors query `stockbook.rt.*`. */
export const RT_COUNTER_METRICS: Readonly<
  Record<keyof RtCounterSnapshot, string>
> = {
  barsClosed: "rt.bars_closed",
  candlesWritten: "rt.candles_written",
  refusedMixedSource: "rt.refused_mixed_source",
  quotesWritten: "rt.quotes_written",
  quoteWriteFailures: "rt.quote_write_failures",
  framesDropped: "rt.frames_dropped",
  leaderTransitions: "rt.leader_transitions",
  bytesRecorded: "rt.bytes_recorded",
};

export const RT_GAUGE_METRICS = {
  healthOk: "rt.health_ok",
  leader: "rt.leader",
  subscribed: "rt.subscribed",
  openBars: "rt.open_bars",
} as const;

export function emptyRtSnapshot(): RtCounterSnapshot {
  return {
    barsClosed: 0,
    candlesWritten: 0,
    refusedMixedSource: 0,
    quotesWritten: 0,
    quoteWriteFailures: 0,
    framesDropped: 0,
    leaderTransitions: 0,
    bytesRecorded: 0,
  };
}

/**
 * Non-negative, finite deltas. A counter that went DOWN (a reset) reads as 0,
 * never negative — a negative count would subtract from the series.
 */
export function computeRtMetricDeltas(
  prev: RtCounterSnapshot,
  curr: RtCounterSnapshot,
): Array<{ metric: string; value: number }> {
  const out: Array<{ metric: string; value: number }> = [];
  for (const key of Object.keys(RT_COUNTER_METRICS) as Array<
    keyof RtCounterSnapshot
  >) {
    const a = prev[key],
      b = curr[key];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const d = b - a;
    out.push({ metric: RT_COUNTER_METRICS[key], value: d > 0 ? d : 0 });
  }
  return out;
}
```

### A4.2 `workers/src/realtime/main.ts` — in `flushTick()` (:333), inside the `try`, as the LAST statements before `finally` (after `await candleSink.write(due)` and also on the early-return paths — so put the emit in the `finally` block instead):

```ts
import { gauge, incrementCounter } from "@usemoney/datadog/metrics";
import {
  RT_GAUGE_METRICS,
  computeRtMetricDeltas,
  emptyRtSnapshot,
  type RtCounterSnapshot,
} from "./rt-metrics-logic";

let lastEmitted: RtCounterSnapshot = emptyRtSnapshot();

function snapshot(): RtCounterSnapshot {
  return {
    barsClosed: counters.barsClosed,
    candlesWritten: candleSink.counters.written,
    refusedMixedSource: candleSink.counters.refusedMixedSource,
    quotesWritten: counters.quotesWritten,
    quoteWriteFailures: counters.quoteWriteFailures,
    framesDropped: counters.framesDropped,
    leaderTransitions: counters.leaderTransitions,
    bytesRecorded: counters.bytesRecorded,
  };
}

function emitRtMetrics(): void {
  try {
    const curr = snapshot();
    for (const { metric, value } of computeRtMetricDeltas(lastEmitted, curr)) {
      if (value > 0) incrementCounter(metric, value);
    }
    lastEmitted = curr;
    const h = healthy();
    gauge(RT_GAUGE_METRICS.healthOk, h.ok ? 1 : 0, {
      reason: h.reason.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60),
    });
    gauge(RT_GAUGE_METRICS.leader, view.state === "leader" ? 1 : 0);
    gauge(RT_GAUGE_METRICS.subscribed, socket?.subscribedSymbols().length ?? 0);
    gauge(RT_GAUGE_METRICS.openBars, aggregator.openCount());
  } catch {
    // metrics must never take the socket down
  }
}
```

and in `flushTick`'s `finally`: `emitRtMetrics(); flushBusy = false;`. `healthy()` is declared later in the file (function hoisting makes that fine). Add `flushMetrics()` to the shutdown path next to the existing server close.

### A4.3 `workers/__tests__/realtime/rt-metrics-logic.test.ts` (new)

Cases: (1) deltas are curr-prev per key with the mapped names; (2) a reset (curr < prev) yields 0, never negative; (3) NaN/Infinity on either side is skipped; (4) `RT_COUNTER_METRICS` values all start with `rt.` and are unique; (5) `emptyRtSnapshot` has every key of `RT_COUNTER_METRICS`. Mutation: drop the `Number.isFinite` guard → (3) red; drop the `d > 0 ? d : 0` clamp → (2) red.

In `realtime-wiring.test.ts` add: `main.ts` calls `emitRtMetrics()` inside `flushTick`'s `finally`, and imports every name in `RT_GAUGE_METRICS` (source scan).

---

## A5 — T4: Python outcomes in Cloud Logging + reachability (MONEY-1331)

### A5.1 RUNTIME CHECK (do first, record the result in the commit body)

```bash
export CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook
G="gcloud --account=founder@disdigital.in --project=stock-book-483718"
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
$G run jobs execute edgar-bulk-ftd-qa --region=asia-south1 --wait
$G logging read "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"edgar-bulk-ftd-qa\" AND timestamp>=\"$START\"" --limit=200 --format=json \
  | jq -r '.[] | [.timestamp, (.textPayload // ""), (.jsonPayload.msg // .jsonPayload.message // "")] | @tsv'
```

- no lines but `Container called exit(0)` → A5.2 (handler replaced after import)
- lines as `textPayload` → the formatter is not one-JSON-object-per-line → fix `JsonFormatter`
- lines as `jsonPayload` → the ticket's query was wrong; document the working one

### A5.2 Defensive fallback in `report_job_outcome` (only if the check shows no lines)

```python
    _emit_line(level, line)  # replaces the three _logger.* calls' final act

def _emit_line(level: int, text: str) -> None:
    root = logging.getLogger()
    if any(getattr(h, "_usemoney_json", False) for h in root.handlers):
        _logger.log(level, text)
        return
    # The JSON handler installed at import is GONE (a library reset the root
    # logger). Write the line ourselves so the outcome still reaches stdout.
    sys.stdout.write(json.dumps({"severity": logging.getLevelName(level), "message": text}) + "\n")
    sys.stdout.flush()
```

plus `tests/test_logging_survives_imports.py`: for each entry point in `tests/test_logging_install_sites.py::_entry_points()`, `subprocess.run([sys.executable, "-c", "import importlib, logging; importlib.import_module('<mod>'); h=logging.getLogger().handlers; print(any(getattr(x,'_usemoney_json',False) for x in h))"])` must print `True`.

### A5.3 `tests/test_outcome_reachability.py` (new)

```python
"""MONEY-1331 — every Python job reports its outcome from a `finally`.

The Python analogue of packages/datadog/__tests__/job-outcome-reachability.test.ts.
Scope: app/bulk/*.py (five `main()` jobs) and app/jobs/{detect,evict}.py (push
handlers that report). The parse_* handlers are event-driven and do not report;
they are watched through edgar-detect's zero-write monitor and are EXEMPT here
by name, with that reason.
"""
import ast
from pathlib import Path
import pytest

APP = Path(__file__).resolve().parents[1] / "app"
EXEMPT = {
    "jobs/parse_13dg.py": "event-driven parser; watched via edgar-detect",
    "jobs/parse_13f.py": "event-driven parser; watched via edgar-detect",
    "jobs/parse_8k.py": "event-driven parser; watched via edgar-detect",
    "jobs/parse_financials.py": "event-driven parser; watched via edgar-detect",
    "jobs/parse_ownership.py": "event-driven parser; watched via edgar-detect",
}

def _files():
    return sorted(list((APP / "bulk").glob("*.py")) + list((APP / "jobs").glob("*.py")))

def _report_calls_in_finally(tree: ast.AST) -> tuple[int, int]:
    """(calls inside a Try.finalbody, calls anywhere)"""
    everywhere = 0
    in_finally = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "id", getattr(node.func, "attr", "")) == "report_job_outcome":
            everywhere += 1
    for node in ast.walk(tree):
        if isinstance(node, ast.Try):
            for stmt in node.finalbody:
                for sub in ast.walk(stmt):
                    if isinstance(sub, ast.Call) and getattr(sub.func, "id", getattr(sub.func, "attr", "")) == "report_job_outcome":
                        in_finally += 1
    return in_finally, everywhere

def test_premise_population():
    assert len(_files()) >= 10

@pytest.mark.parametrize("path", _files(), ids=lambda p: str(p.relative_to(APP)))
def test_outcome_is_reported_from_a_finally(path: Path):
    rel = str(path.relative_to(APP))
    if path.name == "__init__.py" or rel in EXEMPT:
        return
    tree = ast.parse(path.read_text())
    in_finally, everywhere = _report_calls_in_finally(tree)
    assert everywhere >= 1, f"{rel}: no report_job_outcome call at all"
    assert in_finally >= 1, f"{rel}: report_job_outcome is reachable only on the happy path"

def test_exemptions_only_name_files_that_do_not_report():
    for rel in EXEMPT:
        assert "report_job_outcome(" not in (APP / rel).read_text(), f"{rel} now reports — remove its exemption"
```

Mutation: move `report_job_outcome` in `ftd.py` above its `try` → red. **RUNTIME CHECK** the AST claim for `bulk/*` first: the plan's grep showed ≥1 `finally:` per module; if one reports from a non-finally exit helper, extend the rule the way the TS guard does (an exit helper reached from every return) rather than baselining.

---

## A6 — T5: absence template file, US rows, guard reads both lists (MONEY-1266, MONEY-1293, MONEY-1358)

### A6.1 `scripts/ops/datadog/monitor-job-absence.json` (new) — the heredoc body at `apply-monitors.sh:218-267` VERBATIM (name, type, query, message, tags, options, `_notify_no_data_rationale`, `_threshold_rationale`, `_placeholders`). Then in the script: delete :215-217 (`mktemp`, `trap`, `cat >`) and :268 (`ABSENCE_TEMPLATE_JSON`), and set `ABSENCE_TEMPLATE="$HERE/monitor-job-absence.json"` beside `LATENCY_TEMPLATE` (:159). Update the header comment at :162-170 ("Written to a temp file at run time…") to say it is a file now.

### A6.2 Rows

```bash
declare -a ABSENCE_MONITORS=(
  "news-sync|24h|4x daily 09/11/13/15 IST; 15:00 -> 09:00 = 18h"
  # MONEY-1266 — disarmed run reports selected>0 written=0, so the zero-write
  # template would page nightly; the failure mode is SILENCE. PROD_ONLY.
  "candle-evict|36h|daily 15:00 IST"
  # MONEY-1293 — max gap is Sat/Sun 09:00-16:00 uncovered = 7h15m, not the 2h
  # the ticket guessed from the nominal cadence.
  "news-rss-sync|12h|every 5 min mkt hours + 15 min off-hours"
  # MONEY-1358 — every 2 min, all days, PROD_ONLY.
  "tiingo-news-poll|2h|every 2 min, all days"
)
```

`MONITORED_JOBS`: change `"feed-parse|36h|daily"` → `"feed-parse|96h|weekdays 22:35; Fri -> Mon = 72h (MONEY-1358)"`; add

```bash
  # ── MONEY-1358: US jobs ──
  "tiingo-news-poll|2h|every 2 min, all days; selected = work OWED a write (MONEY-1250)"
  "edgar-bulk-ftd|12d|semimonthly 3rd/10th/18th/25th 19:00 IST; longest gap 9d"
```

and, ONLY after the runtime check in the plan (selected=0 on a no-op day):

```bash
  "edgar-bulk-submissions|36h|daily 13:00 + 16:00 retry"
  "edgar-bulk-companyfacts|36h|daily 13:00 + 16:00 retry"
```

Rewrite the exclusion paragraphs at :658-712 to state the current flag state and point at these rows; replace the candle-evict "deliberately absent" paragraph (~:560-580) with two lines pointing at the absence row.

### A6.3 `job_is_prod_only` fallback (:143-156)

```bash
job_is_prod_only() {
  local job="$1" sched sn any=0 all=1
  sched="$(grep -oE "\"[a-z0-9-]+\|[^|]*\|${job}\|" "$SCHEDULER_FILE" \
    | sed 's/^"//' | cut -d'|' -f1 | sort -u)"
  if [[ -z "$sched" ]]; then
    # MONEY-1358 — the EDGAR bulk triggers are created by a FUNCTION, not a
    # SCHEDULER_DEFS row, so the grep above cannot see them. PROD_ONLY_JOBS
    # still lists them by trigger name; a trigger named "<job>-…" counts.
    grep -qE "^${job}-" <<< "$PROD_ONLY_SCHED" && return 0
    return 1
  fi
  for sn in $sched; do any=1; grep -qx "$sn" <<< "$PROD_ONLY_SCHED" || all=0; done
  [[ "$any" == 1 && "$all" == 1 ]]
}
```

### A6.4 `packages/datadog/__tests__/job-outcome-coverage.test.ts`

- `monitoredJobIds()` (:587-591): also parse `/declare -a ABSENCE_MONITORS=\(([\s\S]*?)\n\)/` and take the first `|` field of each quoted row.
- Python id rule (:137-138 area): besides the module-level `JOB`/`JOB_NAME` literal, read `app/bulk/common.py`'s `JOB_NAMES: dict[str, str] = { … }` and treat every string VALUE as an id owned by the files that `import` `JOB_NAMES` and call `report_job_outcome`.
- Mutation: add `"nope|1h|x"` to `ABSENCE_MONITORS` → red; rename a `JOB_NAMES` value → red.

### A6.5 `monitor-agreement.test.ts`

Update `PROD_ABSENCE`/`PROD` counts and the qa expectations: prod = 36 zero-write + 2 new (tiingo-news-poll, edgar-bulk-ftd) [+2 daily EDGAR rows once their runtime check passes] + 1 latency + 4 absence (news-sync, candle-evict, news-rss-sync, tiingo-news-poll) = 43 [45]; qa = 12 + 1 (news-rss-sync absence) = 13. Re-render with `--dry-run` for both envs and pin the exact numbers you see; assert the qa render contains no `edgar-bulk-` name.

---

## A7 — T6: shared library, service monitors, templates (MONEY-1359)

### A7.1 `scripts/ops/datadog/lib-datadog.sh` (new; sourced, never executed)

```bash
#!/usr/bin/env bash
# Shared by apply-monitors.sh, apply-service-monitors.sh, apply-slos.sh,
# apply-dashboards.sh, apply-log-config.sh — MONEY-1359. Callers set
# DD_API_KEY / DD_APP_KEY / DD_API_HOST / DRY_RUN before sourcing.

RESPONSE_BODY=""; RESPONSE_STATUS=""

# dd_request METHOD URL [BODY] — sets RESPONSE_STATUS/RESPONSE_BODY; non-zero on
# curl failure or a non-2xx. NOT `curl -f`: -f discards the body that says WHY.
dd_request() {
  local method="$1" url="$2" body="${3:-}" raw
  if [[ -n "$body" ]]; then
    raw="$(curl -sS -X "$method" "$url" -H "Content-Type: application/json" \
      -H "DD-API-KEY: ${DD_API_KEY}" -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
      -d "$body" -w $'\n%{http_code}')" || return 1
  else
    raw="$(curl -sS -X "$method" "$url" \
      -H "DD-API-KEY: ${DD_API_KEY}" -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
      -w $'\n%{http_code}')" || return 1
  fi
  RESPONSE_STATUS="${raw##*$'\n'}"; RESPONSE_BODY="${raw%$'\n'*}"
  [[ "$RESPONSE_STATUS" == 2* ]]
}

# dd_render TEMPLATE_PATH VARS_JSON — prints the rendered JSON. Strips `_`-keys
# at EVERY depth, throws on an unknown or unsubstituted placeholder, coerces
# options.no_data_timeframe (when present) and every options.thresholds.* that
# arrived as a string to Number. This is apply-monitors.sh's render() body,
# generalised: the vars come in as JSON instead of nine positional env vars.
dd_render() {
  TPL="$1" VARS_JSON="$2" node -e '
    const fs = require("node:fs");
    const strip = (v) => Array.isArray(v) ? v.map(strip)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("_")).map(([k, x]) => [k, strip(x)]))
      : v;
    const doc = strip(JSON.parse(fs.readFileSync(process.env.TPL, "utf8")));
    const vars = JSON.parse(process.env.VARS_JSON);
    const fill = (v) => typeof v === "string"
      ? v.replace(/\{\{(\w+)\}\}/g, (m, k) => { if (!(k in vars)) throw new Error(`unknown placeholder ${m}`); return String(vars[k]); })
      : Array.isArray(v) ? v.map(fill)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
      : v;
    const filled = fill(doc);
    if (filled.options && "no_data_timeframe" in filled.options) filled.options.no_data_timeframe = Number(filled.options.no_data_timeframe);
    for (const k of Object.keys(filled.options?.thresholds ?? {})) {
      const t = filled.options.thresholds[k]; if (typeof t === "string") filled.options.thresholds[k] = Number(t);
    }
    const left = JSON.stringify(filled).match(/\{\{\w+\}\}/g);
    if (left) throw new Error(`unsubstituted placeholders: ${left.join(", ")}`);
    console.log(JSON.stringify(filled));
  '
}

# dd_list_managed TAG — GET the monitors carrying TAG into EXISTING_JSON (a JSON
# array) or exit 1. An unreadable listing must NEVER read as "no monitors".
dd_list_managed() {
  local tag="$1"
  dd_request GET "https://${DD_API_HOST}/api/v1/monitor?monitor_tags=$(printf %s "$tag" | sed 's/:/%3A/')" \
    || { echo "FATAL: could not list monitors (HTTP ${RESPONSE_STATUS}): ${RESPONSE_BODY}" >&2; exit 1; }
  EXISTING_JSON="$RESPONSE_BODY"
  EXISTING="$EXISTING_JSON" node -e 'const v = JSON.parse(process.env.EXISTING); if (!Array.isArray(v)) throw 0' 2>/dev/null \
    || { echo "FATAL: monitor listing was not a JSON array — refusing to POST" >&2; exit 1; }
}

# dd_find_monitor_id NAME — prints the id of the managed monitor with that exact name, or nothing.
dd_find_monitor_id() {
  EXISTING="$EXISTING_JSON" NAME="$1" node -e '
    const hit = JSON.parse(process.env.EXISTING).find((m) => m.name === process.env.NAME);
    if (hit) console.log(hit.id);'
}

# dd_upsert_monitor LABEL BODY — PUT when the rendered name exists, POST when not.
# Appends "LABEL (verb, HTTP n)" to FAILED on error; increments APPLIED on success.
dd_upsert_monitor() {
  local label="$1" body="$2" name id
  name="$(BODY="$body" node -e 'console.log(JSON.parse(process.env.BODY).name)')"
  if $DRY_RUN; then echo "$body"; APPLIED=$((APPLIED + 1)); return 0; fi
  id="$(dd_find_monitor_id "$name")"
  if [[ -n "$id" ]]; then
    dd_request PUT "https://${DD_API_HOST}/api/v1/monitor/${id}" "$body" && { echo "updated ${label} (#${id})"; APPLIED=$((APPLIED + 1)); return 0; }
    FAILED+=("${label} (PUT ${id}, HTTP ${RESPONSE_STATUS}) ${RESPONSE_BODY}")
  else
    dd_request POST "https://${DD_API_HOST}/api/v1/monitor" "$body" && { echo "created ${label}"; APPLIED=$((APPLIED + 1)); return 0; }
    FAILED+=("${label} (POST, HTTP ${RESPONSE_STATUS}) ${RESPONSE_BODY}")
  fi
  return 1
}

# ── Series-exists preflights: a monitor on a series nobody emits is NO DATA forever.
# Each prints nothing and returns 0 when data exists in the last 24h, 1 otherwise.
# Skipped (return 0) on --dry-run: no credentials there.
dd_metric_has_points() {   # dd_metric_has_points "sum:trace.http.request.hits{service:x,env:production}.as_count()"
  $DRY_RUN && return 0
  local now; now=$(date +%s)
  dd_request GET "https://${DD_API_HOST}/api/v1/query?from=$((now - 86400))&to=${now}&query=$(printf %s "$1" | jq -sRr @uri)" || return 1
  BODY="$RESPONSE_BODY" node -e 'const s = JSON.parse(process.env.BODY).series; process.exit(Array.isArray(s) && s.length > 0 ? 0 : 1)'
}
dd_logs_have_events() {    # dd_logs_have_events "service:stockbook-workers env:production"
  $DRY_RUN && return 0
  dd_request POST "https://${DD_API_HOST}/api/v2/logs/events/search" \
    "{\"filter\":{\"query\":$(printf %s "$1" | jq -Rs .),\"from\":\"now-24h\",\"to\":\"now\"},\"page\":{\"limit\":1}}" || return 1
  BODY="$RESPONSE_BODY" node -e 'process.exit((JSON.parse(process.env.BODY).data ?? []).length > 0 ? 0 : 1)'
}
dd_rum_has_events() {      # dd_rum_has_events "@type:view service:stockbook-web env:production"
  $DRY_RUN && return 0
  dd_request POST "https://${DD_API_HOST}/api/v2/rum/events/search" \
    "{\"filter\":{\"query\":$(printf %s "$1" | jq -Rs .),\"from\":\"now-24h\",\"to\":\"now\"},\"page\":{\"limit\":1}}" || return 1
  BODY="$RESPONSE_BODY" node -e 'process.exit((JSON.parse(process.env.BODY).data ?? []).length > 0 ? 0 : 1)'
}
```

`jq` is used only inside the preflights (which never run on `--dry-run`); the repo's CI image has it. If it turns out absent, replace the two `jq` calls with `node -e` encoders.

Then in `apply-monitors.sh`: `source "$HERE/lib-datadog.sh"` after `DD_API_HOST` is derived (:307), delete its own `dd_request` (:750-771), keep its positional `render()` as a wrapper that builds the vars JSON and calls `dd_render` (so the nine call sites are untouched), and replace the listing block (:895-912) with `dd_list_managed "$MANAGED_TAG"`. Keep the three apply loops as they are — they already do the PUT/POST by id; they may call `dd_upsert_monitor` instead, which is the same code. Run `monitor-agreement.test.ts` + the two edgar tests after the extraction: they spawn the real script and must stay green with identical counts.

### A7.2 Templates (all in `scripts/ops/datadog/`)

`monitor-apm-error-rate.json`

```json
{
  "_readme": [
    "MONEY-1359 — request error rate on an APM service. notify_no_data is FALSE: traffic is legitimately zero for hours (jobs run on schedules; RUM is empty overnight IST)."
  ],
  "name": "[{{env}}] {{service}} — request error rate over 5%",
  "type": "query alert",
  "query": "sum(last_15m):sum:trace.{{span}}.errors{service:{{service}},env:{{env}}}.as_count() / sum:trace.{{span}}.hits{service:{{service}},env:{{env}}}.as_count() > 0.05",
  "message": "More than 5% of {{service}} requests errored in the last 15 minutes.\n\nAPM: filter service:{{service}} env:{{env}} status:error and read the top resource. For stockbook-workers a resource is a JOB route (/jobs/<name>) — the job's own zero-write monitor and its [job-outcome] log line say what it did.\n\n@{{notify}}",
  "tags": [
    "managed-by:apply-monitors",
    "family:apm-error-rate",
    "service:{{service}}",
    "env:{{env}}"
  ],
  "options": {
    "thresholds": { "critical": 0.05 },
    "notify_no_data": false,
    "renotify_interval": 0,
    "require_full_window": false,
    "include_tags": true
  }
}
```

`monitor-log-errors.json`

```json
{
  "_readme": [
    "MONEY-1359 — error-level log volume per service. Threshold per row. notify_no_data FALSE."
  ],
  "name": "[{{env}}] {{service}} — more than {{threshold}} error logs in an hour",
  "type": "log alert",
  "query": "logs(\"service:{{service}} env:{{env}} status:error\").index(\"*\").rollup(\"count\").last(\"1h\") > {{threshold}}",
  "message": "{{service}} logged more than {{threshold}} error-level lines in the last hour.\n\nLogs: service:{{service}} env:{{env}} status:error, group by @msg. Redaction is client-side (MONEY-1209 / MONEY-716) — a credential in a message is a bug, not a Datadog setting.\n\n@{{notify}}",
  "tags": [
    "managed-by:apply-monitors",
    "family:log-errors",
    "service:{{service}}",
    "env:{{env}}"
  ],
  "options": {
    "thresholds": { "critical": "{{threshold}}" },
    "notify_no_data": false,
    "renotify_interval": 0,
    "enable_logs_sample": true,
    "include_tags": true
  }
}
```

`monitor-log-fatal.json` — same shape, `name` `[{{env}}] a FATAL log line anywhere`, `query` `logs("env:{{env}} status:(fatal OR critical)").index("*").rollup("count").last("15m") > 0`, threshold 0, no `{{service}}` tag.
`monitor-log-unhandled.json` — `name` `[{{env}}] unhandled promise rejection`, `query` `logs("env:{{env}} (\"unhandledRejection\" OR \"Unhandled promise rejection\")").index("*").rollup("count").last("15m") > 0`.
`monitor-rum-errors.json`

```json
{
  "name": "[{{env}}] stockbook-web — more than 20 browser errors in 15 minutes",
  "type": "rum alert",
  "query": "rum(\"@type:error service:stockbook-web env:{{env}}\").rollup(\"count\").last(\"15m\") > 20",
  "message": "The web app raised more than 20 RUM errors in 15 minutes.\n\nRUM Explorer: @type:error service:stockbook-web env:{{env}}, group by @error.message, then @view.url_path. Boundary errors carry @context.boundary (MONEY-726).\n\n@{{notify}}",
  "tags": [
    "managed-by:apply-monitors",
    "family:rum-errors",
    "service:stockbook-web",
    "env:{{env}}"
  ],
  "options": {
    "thresholds": { "critical": 20 },
    "notify_no_data": false,
    "renotify_interval": 0,
    "include_tags": true
  }
}
```

`monitor-rum-lcp.json` — `name` `[{{env}}] stockbook-web — LCP p75 over 2.5 s for 30 minutes`, `query` `rum("@type:view service:stockbook-web env:{{env}}").rollup("pc75", "@view.largest_contentful_paint").last("30m") > 2500000000`, threshold `2500000000`, message names the unit (nanoseconds) and points at the web-vitals dashboard. **RUNTIME CHECK**: one `dd_rum_has_events` result's `attributes.view.largest_contentful_paint` must be in the 1e8–1e10 range for a normal page; if it is in the 100–10000 range the unit is ms and the threshold is `2500`.
`monitor-rt-health.json`

```json
{
  "name": "[{{env}}] tiingo-realtime — unhealthy or silent",
  "type": "query alert",
  "query": "min(last_10m):min:stockbook.rt.health_ok{env:{{env}}} < 1",
  "message": "tiingo-realtime reported unhealthy for 10 minutes, or stopped reporting at all (no-data at 20 minutes — the gauge is emitted every 5 s by the one process that must not die; silence IS the signal).\n\nCheck /health on the service and the [tiingo-rt] log lines (stepping down / disconnected). Runbook: workers/src/realtime/main.ts header.\n\n@{{notify}}",
  "tags": [
    "managed-by:apply-monitors",
    "family:rt-liveness",
    "service:tiingo-realtime",
    "env:{{env}}"
  ],
  "options": {
    "thresholds": { "critical": 1 },
    "notify_no_data": true,
    "no_data_timeframe": 20,
    "renotify_interval": 0,
    "require_full_window": false,
    "include_tags": true
  }
}
```

`monitor-rt-bars-absence.json` — `query` `sum(last_96h):default_zero(sum:stockbook.rt.bars_closed{env:{{env}}}.as_count()) < 1`, threshold 1, `notify_no_data: true`, `no_data_timeframe: 17280` (3 × 96 h, in minutes).
`monitor-rt-stepdown.json` — `log alert`, `logs("service:tiingo-realtime env:{{env}} \"[tiingo-rt] stepping down\"").index("*").rollup("count").last("15m") > 0`.

### A7.3 `scripts/ops/datadog/apply-service-monitors.sh` (new)

```bash
#!/usr/bin/env bash
# MONEY-1359 — service-level monitors: APM error rate, log errors, RUM errors +
# LCP, realtime liveness. One row per monitor; every row carries a PREFLIGHT
# that proves the series exists on this org before the monitor is created.
#   ./scripts/ops/datadog/apply-service-monitors.sh {qa|prod} [--dry-run]
set -euo pipefail
ENV_ARG="${1:-}"; DRY_RUN=false
for a in "${@:2}"; do case "$a" in --dry-run) DRY_RUN=true ;; *) echo "unknown argument: $a" >&2; exit 2 ;; esac; done
case "$ENV_ARG" in prod) DD_ENV_TAG="production" ;; qa) DD_ENV_TAG="qa" ;; *) echo "usage: $0 {qa|prod} [--dry-run]" >&2; exit 2 ;; esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DD_SRC="$HERE/../../../packages/datadog/src"
DD_API_HOST="api.$(node -e 'const s=require("node:fs").readFileSync(process.argv[1],"utf8"); console.log(/DD_SITE\s*=\s*\n?\s*"([^"]+)"/.exec(s)[1])' "$DD_SRC/constants.ts")"
if ! $DRY_RUN; then : "${DD_API_KEY:?export DD_API_KEY first}"; : "${DD_APP_KEY:?export DD_APP_KEY first}"; fi
source "$HERE/lib-datadog.sh"
NOTIFY="${DD_NOTIFY:-deepshaswat@gmail.com}"
MANAGED_TAG="managed-by:apply-monitors"
FAILED=(); APPLIED=0; SKIPPED=0; EXISTING_JSON="[]"
$DRY_RUN || dd_list_managed "$MANAGED_TAG"

# template|service|span|threshold|envs(prod,qa or prod)|preflight kind
ROWS=(
  "monitor-apm-error-rate.json|stockbook-workers|http.request||prod,qa|metric"
  "monitor-apm-error-rate.json|us-fundamentals|fastapi.request||prod,qa|metric"
  "monitor-apm-error-rate.json|tiingo-realtime|http.request||prod,qa|metric"
  "monitor-log-errors.json|stockbook-workers||100|prod,qa|logs"
  "monitor-log-errors.json|stockbook-web||50|prod,qa|logs"
  "monitor-log-errors.json|stockbook-api||50|prod,qa|logs"
  "monitor-log-errors.json|us-fundamentals||50|prod,qa|logs"
  "monitor-log-fatal.json||||prod,qa|logs-any"
  "monitor-log-unhandled.json||||prod,qa|logs-any"
  "monitor-rum-errors.json|stockbook-web|||prod,qa|rum"
  "monitor-rum-lcp.json|stockbook-web|||prod|rum"
  "monitor-rt-health.json|tiingo-realtime|||prod,qa|metric-rt"
  "monitor-rt-bars-absence.json|tiingo-realtime|||prod|metric-rt"
  "monitor-rt-stepdown.json|tiingo-realtime|||prod,qa|logs"
)
for ROW in "${ROWS[@]}"; do
  IFS='|' read -r TPL SERVICE SPAN THRESHOLD ENVS KIND <<< "$ROW"
  LABEL="${TPL%.json} ${SERVICE}"
  if [[ ",${ENVS}," != *",${ENV_ARG},"* ]]; then echo "skipping (${ENV_ARG} not in ${ENVS}): ${LABEL}"; SKIPPED=$((SKIPPED+1)); continue; fi
  case "$KIND" in
    metric)    dd_metric_has_points "sum:trace.${SPAN}.hits{service:${SERVICE},env:${DD_ENV_TAG}}.as_count()" || { FAILED+=("${LABEL}: no trace.${SPAN}.hits points in 24h — wrong span name or service not tracing"); continue; } ;;
    metric-rt) dd_metric_has_points "min:stockbook.rt.health_ok{env:${DD_ENV_TAG}}" || { FAILED+=("${LABEL}: stockbook.rt.health_ok has no points — T3b not deployed?"); continue; } ;;
    logs)      dd_logs_have_events "service:${SERVICE} env:${DD_ENV_TAG}" || { FAILED+=("${LABEL}: no logs for service:${SERVICE} in 24h"); continue; } ;;
    logs-any)  dd_logs_have_events "env:${DD_ENV_TAG}" || { FAILED+=("${LABEL}: no logs for env in 24h"); continue; } ;;
    rum)       dd_rum_has_events "@type:view service:${SERVICE} env:${DD_ENV_TAG}" || { FAILED+=("${LABEL}: no RUM views in 24h"); continue; } ;;
  esac
  VARS="$(node -e 'console.log(JSON.stringify({env:process.argv[1],service:process.argv[2],span:process.argv[3],threshold:process.argv[4],notify:process.argv[5]}))' "$DD_ENV_TAG" "$SERVICE" "$SPAN" "$THRESHOLD" "$NOTIFY")"
  BODY="$(dd_render "$HERE/$TPL" "$VARS")" || { FAILED+=("${LABEL}: render failed"); continue; }
  dd_upsert_monitor "$LABEL" "$BODY" || true
done
if ((${#FAILED[@]} > 0)); then printf 'NOT applied:\n  %s\n' "${FAILED[@]}" >&2; exit 1; fi
echo "applied ${APPLIED}, skipped ${SKIPPED} of ${#ROWS[@]}"
```

`dd_render` throws on an unknown placeholder, so a template that names `{{span}}` renders only where a span is given; the rows that leave a field empty still pass the key (empty string), which a template that does not use it never reads. The log-fatal/unhandled templates must not contain `{{service}}`.

### A7.4 `packages/datadog/__tests__/service-monitors-agreement.test.ts` (new)

Copy the harness of `monitor-agreement.test.ts` :90-222 (offline `curl` stub on PATH, credentials stripped, `DD_NOTIFY` deleted; `render(env)` spawns `--dry-run` and parses the JSON bodies; `runWithStub(...)` logs curl calls). Assert: prod renders ≥ 13 bodies and qa ≥ 11; every body has `managed-by:apply-monitors` and an `env:` tag; every `message` ends with `@deepshaswat@gmail.com`; `type` ∈ {`query alert`,`log alert`,`rum alert`}; no `{{` anywhere; `notify_no_data === false` for every body except the two `family:rt-liveness` query alerts, which are `true` with `no_data_timeframe` numeric; the stubbed live run makes exactly one GET listing and one write per rendered body (preflights are skipped on dry-run and answered 200 by the stub on the live run — the stub returns `{"series":[{}]}` for `/api/v1/query` and `{"data":[{}]}` for the two `/search` endpoints). Mutation: remove `@` before `{{notify}}` in one template → red; remove the managed tag → red.

---

## A8 — T7: SLOs (MONEY-1360)

`scripts/ops/datadog/slos.json`

```json
[
  {
    "name": "[production] Scheduled jobs write what they select",
    "type": "monitor",
    "monitor_name_pattern": "^\\[production\\] .* wrote nothing but had work to do$",
    "thresholds": [{ "timeframe": "30d", "target": 99.5 }]
  },
  {
    "name": "[production] Scheduled jobs run",
    "type": "monitor",
    "monitor_name_pattern": "^\\[production\\] .* has not reported a run in .*$",
    "thresholds": [{ "timeframe": "30d", "target": 99.9 }]
  },
  {
    "name": "[production] Workers request success",
    "type": "metric",
    "query": {
      "numerator": "sum:trace.http.request.hits{service:stockbook-workers,env:production}.as_count() - sum:trace.http.request.errors{service:stockbook-workers,env:production}.as_count()",
      "denominator": "sum:trace.http.request.hits{service:stockbook-workers,env:production}.as_count()"
    },
    "thresholds": [{ "timeframe": "30d", "target": 99 }]
  },
  {
    "name": "[production] EDGAR detection under 5 minutes",
    "type": "monitor",
    "monitor_name_pattern": "^\\[production\\] edgar-detect — p95 latency over 300s$",
    "thresholds": [{ "timeframe": "30d", "target": 99 }]
  }
]
```

`apply-slos.sh prod [--dry-run]`: source the lib; `dd_list_managed managed-by:apply-monitors`; for each entry, resolve `monitor_ids` by regex over `EXISTING_JSON` names (abort the entry with a named failure when zero match); for the metric entry run `dd_metric_has_points` on the denominator; body = `{name, type, monitor_ids|query, thresholds, tags:["managed-by:apply-slos","env:production"]}`; upsert by name via `GET /api/v1/slo?query=<name>` → `data[]` exact-name match → `PUT /api/v1/slo/{id}` else `POST /api/v1/slo`. Exit non-zero listing failures. Test `slos-agreement.test.ts`: dry-run prints four bodies with the right `type`; the stub listing (names from `apply-monitors.sh prod --dry-run` render) resolves ≥ 30 ids for the first pattern and exactly 1 for the fourth; a pattern matching nothing aborts.

---

## A9 — T8: dashboards (MONEY-1361)

`apply-dashboards.sh prod [--dry-run]`: for each `dashboards/*.json`: substitute `{{slo:<name>}}` with the SLO id from `GET /api/v1/slo?query=<name>`; `GET /api/v1/dashboard` → find `dashboards[].title` equal → `PUT /api/v1/dashboard/{id}` else `POST`. Every JSON carries `"description": "managed-by:apply-dashboards — edit the file, not the UI"` and `"template_variables":[{"name":"env","prefix":"env","default":"production"}]`, `"layout_type":"ordered"`.

Widget shapes (v1 API, legacy request format — all verified shapes):

```json
{ "definition": { "type": "query_value", "title": "Rows written, 24h", "requests": [{ "q": "sum:stockbook.job.written{$env}.as_count()", "aggregator": "sum" }], "precision": 0, "time": { "live_span": "1d" } } }
{ "definition": { "type": "timeseries", "title": "Workers: hits vs errors", "requests": [{ "q": "sum:trace.http.request.hits{service:stockbook-workers,$env}.as_count(), sum:trace.http.request.errors{service:stockbook-workers,$env}.as_count()", "display_type": "bars" }] } }
{ "definition": { "type": "timeseries", "title": "Error logs by service", "requests": [{ "log_query": { "index": "*", "compute": { "aggregation": "count" }, "search": { "query": "status:error $env" }, "group_by": [{ "facet": "service", "limit": 10, "sort": { "aggregation": "count", "order": "desc" } }] }, "display_type": "bars" }] } }
{ "definition": { "type": "timeseries", "title": "LCP p75 by route (ns)", "requests": [{ "rum_query": { "index": "*", "compute": { "aggregation": "pc75", "facet": "@view.largest_contentful_paint" }, "search": { "query": "@type:view service:stockbook-web $env" }, "group_by": [{ "facet": "@view.url_path", "limit": 10, "sort": { "aggregation": "pc75", "facet": "@view.largest_contentful_paint", "order": "desc" } }] }, "display_type": "line" }] } }
{ "definition": { "type": "query_table", "title": "Selected but wrote nothing (36h) — the monitor's own query", "requests": [{ "q": "clamp_max(sum:stockbook.job.selected{$env} by {job}.as_count(),1) - clamp_max(sum:stockbook.job.written{$env} by {job}.as_count(),1)", "aggregator": "last", "limit": 60, "order": "desc" }], "time": { "live_span": "36h" } } }
{ "definition": { "type": "toplist", "title": "Rows written by job, 7d", "requests": [{ "q": "top(sum:stockbook.job.written{$env} by {job}.as_count(), 50, 'sum', 'desc')" }], "time": { "live_span": "1w" } } }
{ "definition": { "type": "slo", "slo_id": "{{slo:[production] Scheduled jobs write what they select}}", "view_type": "detail", "time_windows": ["30d"], "view_mode": "overall", "title": "Jobs write what they select" } }
```

Boards and their widgets:

- `prod-health.json`: rows-written 24h; workers hits vs errors; us-fundamentals `trace.fastapi.request` hits vs errors; error logs by service; RUM errors (`rum_query` count, `@type:error service:stockbook-web $env`); the four SLO widgets; `stockbook.rt.health_ok` min.
- `job-health.json`: the clamped-difference table; rows written by job (toplist 7d); `sum:stockbook.job.selected{$env} by {job}.as_count()` timeseries; `sum:stockbook.job.transport_failures{$env} by {job}.as_count()`; `sum:stockbook.job.failed{$env} by {job}.as_count()`.
- `web-vitals.json`: LCP p75 by route; INP p75 by route (`@view.interaction_to_next_paint`); CLS p75 by route (`@view.cumulative_layout_shift`); RUM errors by `@error.message` (toplist via `rum_query` count group_by `@error.message`); sessions count (`@type:session`); resources p75 by `@resource.url_host` (`@resource.duration`).
- `us-market.json`: job outcomes for `us-eod-sync`, `us-instrument-master-sync`, `tiingo-news-poll`, `edgar-detect`, `edgar-bulk-ftd`, `edgar-bulk-submissions`, `edgar-bulk-companyfacts` (`q` with `job:<id>` filters); `avg:stockbook.edgar.detect_latency_seconds.95percentile{$env}`; `min:stockbook.rt.health_ok{$env}`; `max:stockbook.rt.leader{$env}`; `max:stockbook.rt.subscribed{$env}`; `sum:stockbook.rt.bars_closed{$env}.as_count()`; `sum:stockbook.rt.candles_written{$env}.as_count(), sum:stockbook.rt.refused_mixed_source{$env}.as_count()`; `sum:stockbook.rt.quote_write_failures{$env}.as_count()`; `trace.fastapi.request` hits/errors; `trace.http.request` hits/errors for `service:tiingo-realtime`.
- `cache-and-brokers.json`: `sum:stockbook.cache.hit{$env} by {layer}.as_count(), sum:stockbook.cache.miss{$env}.as_count()`; `p95:stockbook.broker.sync.duration{$env} by {broker}` — **RUNTIME CHECK** `histogram()` in `metrics.ts` produces `.avg/.max/.95percentile` sub-series via the HTTP client's own aggregation (`datadog-metrics` sends `broker.sync.duration.avg`, `.count`, `.max`, `.median`, `.95percentile`, `.min`); query `avg:stockbook.broker.sync.duration.95percentile{$env} by {broker}` and confirm points; `sum:stockbook.broker.sync.failure{$env} by {broker}.as_count()`; `sum:stockbook.pairing.trades_processed{$env}.as_count()`.

`dashboards-agreement.test.ts`: parse every JSON; collect every metric name in every `q` (regex `(?:sum|avg|min|max|count|p\d+):([a-z0-9_.]+)\{`) and every `rum_query`/`log_query` facet; assert metric names are a subset of the emitted inventory: `stockbook.` + (`JOB_METRICS` values, `RT_COUNTER_METRICS`/`RT_GAUGE_METRICS` values, the `incrementCounter/gauge/histogram` literals scanned from `apps/web`, `workers/src`, `packages/*/src`, plus `.95percentile/.avg/.max/.count` suffixes for histogram names, plus `edgar.detect_latency_seconds` from `outcome.py`) ∪ `trace.*`; assert every board has ≥ 4 widgets and the template variable; stubbed-curl upsert by title. Mutation: a widget on `stockbook.job.wrote` → red.

---

## A10 — T9: log config (MONEY-1362)

`apply-log-config.sh prod [--dry-run]`:

1. `dd_request GET https://${DD_API_HOST}/api/v1/logs/config/indexes` → pick `indexes[] | select(.name=="main")` (fail closed if absent: print the names and exit 1).
2. Desired exclusion filters: `[{"name":"debug-and-trace","is_enabled":true,"filter":{"query":"status:(debug OR trace)","sample_rate":1.0}},{"name":"health-checks","is_enabled":true,"filter":{"query":"@http.url_details.path:/health*","sample_rate":1.0}}]`. Merge by `name` into the existing `exclusion_filters`; if nothing changed, print "unchanged" and skip the PUT; else `PUT /api/v1/logs/config/indexes/main` with the FULL index body.

   **CORRECTED AFTER IMPLEMENTATION.** "retention fields untouched" was ambiguous between OMIT and ECHO BACK, and only one is safe: omitting hands the value to whatever the API defaults to on a live index. ECHO `num_retention_days` back exactly as read. The list above is also INCOMPLETE for a safe round trip — `daily_limit` and `disable_daily_limit` live on the index too, and they CONFLICT if both are sent, so `daily_limit` is echoed only when `disable_daily_limit` is not true. Note `sample_rate: 1.0` serialises as `1`, so a test asserting the literal `1.0` checks a string that never appears.

3. Status remap. **CORRECTED: the helper is `dd_events_exist logs "<query>"`.** `dd_logs_have_events` does not exist and never did — under `set -e` a call to a missing function aborts the script AFTER the PUT has already landed, leaving the config half applied. Two further facts the original spec missed: `dd_events_exist` returns 0 on `--dry-run`, so this gate is UNSATISFIABLE in dry-run mode and the pipeline body would never print — the script must short-circuit and print both bodies before any probe, evaluating the gate only on a live run. And whether the remap is needed at all is a RUNTIME measurement, because Datadog may already auto-install an integration pipeline for a recognised source under a name this check does not look for. Create nothing unless the defect can be demonstrated.

   Only when `dd_events_exist logs "level:error service:stockbook-workers env:production"` succeeds AND `dd_events_exist logs "status:error service:stockbook-workers env:production"` fails: `GET /api/v1/logs/config/pipelines` → if no pipeline named `usemoney-nodejs-status`, `POST` `{"name":"usemoney-nodejs-status","is_enabled":true,"filter":{"query":"source:nodejs"},"processors":[{"type":"status-remapper","name":"level -> status","is_enabled":true,"sources":["level"]},{"type":"service-remapper","name":"service","is_enabled":true,"sources":["service"]}]}`.
   Test: dry-run prints the two filter objects and the pipeline body; a stubbed GET returning an index with `debug-and-trace` already present yields "unchanged" and no PUT.

---

## A11 — T10: RUM addError in the boundaries (MONEY-726)

### A11.1 `apps/web/lib/datadog/rum-init.ts` (new, leaf module)

```ts
import { DD_SITE } from "@usemoney/datadog/constants";

/** The RUM init object, or null when the public env is absent (local dev, previews without keys). */
export function rumInitConfig() {
  const applicationId = process.env.NEXT_PUBLIC_DD_APPLICATION_ID;
  const clientToken = process.env.NEXT_PUBLIC_DD_CLIENT_TOKEN;
  if (!applicationId || !clientToken) return null;
  return {
    applicationId,
    clientToken,
    site: DD_SITE,
    service: "stockbook-web",
    env: process.env.NEXT_PUBLIC_DD_ENV || "production",
    version: process.env.NEXT_PUBLIC_DD_VERSION || "1.0.0",
    sessionSampleRate: 100,
    sessionReplaySampleRate: 20,
    trackUserInteractions: true,
    trackResources: true,
    trackLongTasks: true,
    defaultPrivacyLevel: "mask-user-input" as const,
    allowedTracingUrls: [
      {
        match: (url: string) =>
          /https:\/\/.*\.usemoney\.ai/.test(url) &&
          !url.includes("clerk.usemoney.ai"),
        propagatorTypes: ["datadog" as const],
      },
    ],
  };
}
```

`DatadogRumProvider.tsx`: replace the inline object (:22-42) with `const cfg = rumInitConfig(); if (!cfg) return; … datadogRum.init(cfg);` — keep the two `.catch`es.

### A11.2 `apps/web/app/error.tsx` (:184-190)

```ts
useEffect(() => {
  if (error?.digest) console.error(`[error.tsx] digest=${error.digest}`, error);
  else console.error("[error.tsx]", error);
  // MONEY-726 — report explicitly. The SDK buffers addError before init and
  // drains on init, so this is safe whichever effect runs first.
  import("@datadog/browser-rum")
    .then(({ datadogRum }) =>
      datadogRum.addError(error, { digest: error?.digest, boundary: "error" }),
    )
    .catch(() => undefined);
}, [error]);
```

### A11.3 `apps/web/app/global-error.tsx` (:172-175) — the provider never mounted here, so init first:

```ts
useEffect(() => {
  console.error("[global-error.tsx]", error);
  // MONEY-726 — nothing above this boundary initialised RUM, so do it here.
  // Both imports are dynamic and caught: a failed chunk degrades to the
  // console line above, never to a second crash inside the crash page.
  Promise.all([
    import("@datadog/browser-rum"),
    import("@/lib/datadog/rum-init"),
  ])
    .then(([{ datadogRum }, { rumInitConfig }]) => {
      const cfg = rumInitConfig();
      if (!cfg) return;
      if (!datadogRum.getInitConfiguration()) datadogRum.init(cfg);
      datadogRum.addError(error, {
        digest: error?.digest,
        boundary: "global-error",
      });
    })
    .catch(() => undefined);
}, [error]);
```

### A11.4 Tests

- `analytics-imports-guarded.test.ts` `TARGETS` (:48-52): add `"apps/web/app/error.tsx"`, `"apps/web/app/global-error.tsx"`.
- New `apps/web/__tests__/components/error-boundaries-report-to-rum.test.ts`: read both files; assert `addError(error, {` with `boundary: "error"` / `"global-error"`; assert `global-error.tsx` calls `datadogRum.init(` only inside `if (!datadogRum.getInitConfiguration())`; assert `rum-init.ts` imports `DD_SITE` from `@usemoney/datadog/constants` and `DatadogRumProvider.tsx` imports `rumInitConfig` (no inline `applicationId:`). Mutation: delete `addError` in one file → red. Run from `apps/web`.

---

## A12 — T11: pino redact paths (MONEY-716)

`packages/logger/src/config.ts`, inside `pinoConfig` after `level:` (:85):

```ts
  // MONEY-716 — a second, cheaper layer under the serializer redaction:
  // pino drops these paths BEFORE serialisation. Serializers (below) still
  // cover shapes this path syntax cannot express. `email`/`phone` are the
  // DPDP additions — an audit line that must carry an address logs it as
  // `actorEmail`, which is deliberately not on this list.
  redact: {
    paths: [
      "*.authorization", "*.cookie", "*.set-cookie",
      "req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]',
      "*.password", "*.token", "*.accessToken", "*.refreshToken", "*.sessionToken",
      "*.apiKey", "*.api_key", "*.secret", "*.clientSecret",
      "*.DATABASE_URL", "*.REDIS_URL",
      "*.email", "*.phone",
    ],
    censor: REDACTED,
  },
```

(`REDACTED` from `@usemoney/utils/log-redaction`, already imported at :2.) Tests in `config-redaction.test.ts`, driving the REAL `pino(pinoConfig, sink)` the file already uses: `logger.info({ req: { headers: { authorization: "Bearer x", cookie: "__session=y" } }, user: { email: "a@b.c", phone: "9" }, data: { accessToken: "t" }, actorEmail: "ops@usemoney.ai" }, "m")` → the five sensitive values are `[REDACTED]`, `actorEmail` survives. Mutation: delete `redact` → red.

---

## A13 — T12: cutover commands and the Vercel table

All commands assume `export CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook; G="gcloud --account=founder@disdigital.in --project=stock-book-483718"` and, for the Datadog API, `export DD_API_KEY=$($G secrets versions access latest --secret=DD_API_KEY_PROD)` and `export DD_APP_KEY=$($G secrets versions access latest --secret=DD_APP_KEY_PROD)` (never echo them).

```bash
# QA key, minted through the API, straight into Secret Manager
curl -sS -X POST https://api.us5.datadoghq.com/api/v2/api_keys -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" -H 'Content-Type: application/json' \
  -d '{"data":{"type":"api_keys","attributes":{"name":"stockbook-qa"}}}' | jq -r .data.attributes.key | tr -d '\n' | $G secrets versions add DD_API_KEY_QA --data-file=-
curl -sS -X DELETE https://api.us5.datadoghq.com/api/v2/api_keys/f20f6ba9-f581-46e6-a1da-8e34d70ffe40 -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" -w ' %{http_code}\n'

# RUM apps (ids/tokens are public by design — print them for the Vercel table)
for name in stockbook-web stockbook-web-qa; do
  curl -sS -X POST https://api.us5.datadoghq.com/api/v2/rum/applications -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" -H 'Content-Type: application/json' \
    -d "{\"data\":{\"type\":\"rum_application_create\",\"attributes\":{\"name\":\"$name\",\"type\":\"browser\"}}}" | jq -r '.data.attributes | "\(.name) application_id=\(.application_id) client_token=\(.client_token)"'
done

# Roll the sidecar services so warm instances restart on the new key
for svc in stockbook-workers-prod stockbook-workers-qa us-fundamentals-prod us-fundamentals-qa tiingo-realtime-prod tiingo-realtime-qa; do
  $G run services update "$svc" --region=asia-south1 --update-labels=dd-org=us5 --quiet
done

# Prove ingest BEFORE applying anything
NOW=$(date +%s); curl -sS "https://api.us5.datadoghq.com/api/v1/query?from=$((NOW-86400))&to=$NOW&query=sum:stockbook.job.selected{env:production}.as_count()" -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" | jq '.series | length'

# Negative test on the QA feed-parse monitor (never touches a real job)
TS=$(date +%s); curl -sS -X POST https://api.us5.datadoghq.com/api/v1/series -H "DD-API-KEY: $DD_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"series\":[{\"metric\":\"stockbook.job.selected\",\"type\":\"count\",\"points\":[[$TS,3]],\"tags\":[\"job:feed-parse\",\"env:qa\",\"service:stockbook-workers\"]},{\"metric\":\"stockbook.job.written\",\"type\":\"count\",\"points\":[[$TS,0]],\"tags\":[\"job:feed-parse\",\"env:qa\",\"service:stockbook-workers\"]}]}"
# … wait for "[qa] feed-parse wrote nothing but had work to do" to ALERT and the email to land, then recover:
TS=$(date +%s); curl -sS -X POST https://api.us5.datadoghq.com/api/v1/series -H "DD-API-KEY: $DD_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"series\":[{\"metric\":\"stockbook.job.written\",\"type\":\"count\",\"points\":[[$TS,3]],\"tags\":[\"job:feed-parse\",\"env:qa\",\"service:stockbook-workers\"]}]}"

# Retire the bootstrap prod key (it sat in a chat transcript): mint a successor into the secret, roll, then delete the old id
curl -sS -X POST https://api.us5.datadoghq.com/api/v2/api_keys -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" -H 'Content-Type: application/json' \
  -d '{"data":{"type":"api_keys","attributes":{"name":"stockbook-prod-2"}}}' | jq -r .data.attributes.key | tr -d '\n' | $G secrets versions add DD_API_KEY_PROD --data-file=-
# (roll the services again, re-export DD_API_KEY from the new version, then:)
curl -sS -X DELETE https://api.us5.datadoghq.com/api/v2/api_keys/929a3b6a-4754-4694-872e-fed037625086 -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" -w ' %{http_code}\n'
```

Vercel (founder sets; values from the RUM step above):

| Project  | Variable                                                        | Value                                                         |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| web prod | `DD_API_KEY`                                                    | prod key (from Secret Manager `DD_API_KEY_PROD`)              |
| web prod | `DD_SERVICE` / `DD_ENV` / `DD_TRACE_ENABLED`                    | `stockbook-web` / `production` / `false`                      |
| web prod | `NEXT_PUBLIC_DD_APPLICATION_ID` / `NEXT_PUBLIC_DD_CLIENT_TOKEN` | `stockbook-web` application_id / client_token                 |
| web prod | `NEXT_PUBLIC_DD_ENV`                                            | `production`                                                  |
| web qa   | same five                                                       | qa key, `qa`, `stockbook-web-qa` ids, `NEXT_PUBLIC_DD_ENV=qa` |
| api prod | `DD_API_KEY` / `DD_SERVICE` / `DD_ENV` / `DD_TRACE_ENABLED`     | prod key / `stockbook-api` / `production` / `false`           |
| api qa   | same four                                                       | qa key / `stockbook-api` / `qa` / `false`                     |
