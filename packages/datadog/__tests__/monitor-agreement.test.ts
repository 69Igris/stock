/**
 * MONEY-1238 — the monitor must query the series the code actually emits.
 *
 * ## Why this file exists as a separate check
 *
 * The zero-write monitor is the detection layer for the whole "job runs,
 * reports success, writes nothing" class — six incidents in one week, and the
 * reason `reportJobOutcome` exists at all. It could not fire for ANY job in ANY
 * environment, for five independent reasons, and the one assertion that was
 * supposed to catch the first of them was a shadow:
 *
 *     assert.ok(
 *       monitor.includes(JOB_METRICS.written),
 *       "the monitor queries a metric name the code does not emit",
 *     );
 *
 * `JOB_METRICS.written` is `"job.written"`. `datadog-metrics` is initialised
 * with `prefix: "stockbook."`, so the series is `stockbook.job.written` — and
 * `"stockbook.job.written".includes("job.written")` is TRUE. A substring test
 * passes identically whether the prefix is there or not, so the assertion held
 * while the condition its own message described was the live state of the file.
 * A test that cannot distinguish the bug from the fix is worse than no test: it
 * occupies the slot where the real one would go.
 *
 * ## What is asserted instead
 *
 * The rendered artefact, not the template. Every check below runs
 * `apply-monitors.sh <env> --dry-run` and reads the JSON it would POST, so the
 * chain under test is the whole one: template -> env mapping -> metric-name
 * extraction -> substitution. Anything a reviewer could get wrong in the middle
 * of that chain shows up here, including a `{{placeholder}}` nobody filled.
 *
 * The five faults this pins, all of them measured on the file as it stood:
 *
 *   (a) METRIC NAME — the query asked for `job.written`, the emitted series is
 *       `stockbook.job.written`. Permanent NO DATA.
 *   (b) ENV TAG — the script substituted `env:prod`; workers/cloudbuild.prod.yaml
 *       sets DD_ENV=production and getDatadogEnv maps it to `production`. QA
 *       matched by coincidence, which is how it survived.
 *   (c) NO `job.selected` IN THE QUERY — the template's own comment and
 *       docs/reference/xbrl-switchover-runbook.md both state the condition is
 *       `selected > 0 && written == 0`. The query was `written < 1`, which
 *       fires on every genuinely idle run.
 *   (d) THE API HOST — the POST went to api.datadoghq.com (US1) while DD_SITE
 *       was `us3.datadoghq.com` (us5 since MONEY-1229). Even with (a)-(c) fixed the monitor would have
 *       been created in an org that never receives the metric.
 *   (e) NOT IDEMPOTENT, FAILS OPEN — one unconditional POST (so a re-run
 *       duplicates all eight) and `curl -sS` with no status check (so a 403
 *       printed its body and the script exited 0 having applied nothing).
 *   (f) THE FIX'S OWN FAIL-OPEN — the create-vs-update lookup added for (e)
 *       read the listing without checking its SHAPE, and Datadog answers some
 *       errors with a 200 and an `{"errors": […]}` body. A body that is not an
 *       array parses fine and finds no match, so every job POSTs as new and the
 *       whole set duplicates: the exact outcome the lookup was added to
 *       prevent, reached through the door marked success.
 *
 * The (e) and (f) checks RUN THE SCRIPT against a stubbed `curl` rather than
 * grepping its source, because a source-level assertion is what let (e) ship:
 * the header claimed name-matching that no code performed, and every regex a
 * reviewer could write over that header would have passed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMITTED_JOB_METRICS, JOB_METRICS } from "../src/job-outcome";
import { DD_SITE, METRIC_PREFIX, toDatadogEnv } from "../src/constants";
/**
 * MONEY-1373 — IMPORTED, across a package boundary, deliberately.
 *
 * `monitor-databento-d1.json` spells `stockbook.databento.displaced_d1` out in
 * its query, because apply-monitors.sh supplies placeholders only for the two
 * JOB counters. That second spelling is MONEY-1238 fault (a) waiting to happen,
 * and on THIS monitor it is the worst possible one: a wrong name renders as
 * permanent NO DATA, which is indistinguishable from a tripwire that has never
 * tripped. So the expected string is COMPUTED from the constant the emitters
 * use, never retyped here — a retyped expectation would agree with a retyped
 * query for exactly as long as both were wrong.
 *
 * The rest of this file reads other packages as TEXT (`node:fs`) rather than as
 * modules. This one is a real import because the point IS the identity of the
 * value, not the presence of a string in a file.
 */
import {
  DATABENTO_METRICS,
  EMITTED_DATABENTO_METRICS,
} from "@usemoney/core/market-data/databento/databento-metrics";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(ROOT, "scripts/ops/datadog/apply-monitors.sh");
/**
 * The script AND the library it sources — MONEY-1359.
 *
 * `dd_request`, the renderer, the managed listing and the upsert moved into
 * `lib-datadog.sh` so `apply-service-monitors.sh` shares one copy rather than
 * growing a second that drifts. Every assertion below about HOW a request is
 * made is about the same code it always was; reading only the script would
 * report those properties as GONE the moment they were shared. Concatenated
 * rather than switched, so an assertion still passes wherever the code lives.
 */
const SCRIPT_SRC = [
  readFileSync(SCRIPT, "utf8"),
  readFileSync(join(ROOT, "scripts/ops/datadog/lib-datadog.sh"), "utf8"),
].join("\n");

interface RenderedMonitor {
  name: string;
  type: string;
  query: string;
  message: string;
  tags: string[];
  options: {
    notify_no_data: boolean;
    no_data_timeframe: number;
    thresholds: { critical: number };
  };
}

/**
 * A `curl` that cannot reach the network, on PATH for every dry-run spawn.
 *
 * MONEY-979 review. `render()` used to spawn the real script with the AMBIENT
 * environment and no stub, relying on `--dry-run` alone to keep it offline.
 * `--dry-run` is a BRANCH in a shell script, and this repo has already shipped
 * two bugs in exactly that branch — `[[ "${2:-}" == "--dry-run" ]]` reading one
 * position, and `[[ "$DRY_RUN" == "1" ]]` comparing against a value the
 * variable never holds. Breaking it measurably turns this file's renders into
 * live Datadog traffic, and the runbook instructs CI to export DD_API_KEY /
 * DD_APP_KEY, which is precisely the environment that makes them succeed.
 *
 * So the guarantee is moved off the branch and onto the process: the child gets
 * a PATH whose first entry holds a `curl` that logs and exits non-zero, and it
 * gets no credentials. Three independent things now have to fail before a
 * packet leaves — the flag parse, the `:?` credential guards, and this stub.
 */
const NO_NET = mkdtempSync(join(tmpdir(), "apply-monitors-offline-"));
const NO_NET_LOG = join(NO_NET, "calls.log");
writeFileSync(
  join(NO_NET, "curl"),
  [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$STUB_LOG"',
    "cat > /dev/null", // DRAIN `-K -`. A stub that never reads stdin makes the
    // credential writer die of SIGPIPE; `pipefail` then surfaces 141 and
    // `dd_request` misreports it as "curl exited 141". Invisible on macOS,
    // fatal on Linux — which is how CI caught it and a local run did not.
    'echo "curl reached during a --dry-run" >&2',
    "exit 99",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
writeFileSync(NO_NET_LOG, "");

/**
 * Run the real script in dry-run and parse the bodies it would send.
 *
 * `--dry-run` deliberately needs no credentials and makes no request, so this
 * exercises the rendering path end to end without reaching Datadog.
 *
 * `DD_NOTIFY` is stripped along with the credentials so the rendered `@handle`
 * is the script's own default rather than whatever the ambient shell exports.
 * The routing assertion below compares against that default, and a test whose
 * expected value comes from the environment it happens to run in is a test that
 * passes on the developer's laptop for a reason unrelated to the code.
 */
function render(env: "prod" | "qa"): RenderedMonitor[] {
  const childEnv = { ...process.env };
  delete childEnv.DD_API_KEY;
  delete childEnv.DD_APP_KEY;
  delete childEnv.DD_NOTIFY;
  // Stripped for the same reason as DD_NOTIFY: the switch below must be this
  // file's decision, not the developer's shell. A qa render is TURNED ON here
  // because qa monitoring ships OFF (founder decision — `dd_qa_monitoring_enabled`
  // in lib-datadog.sh), and an unset switch makes `apply-monitors.sh qa` exit 0
  // rendering nothing, which would leave every qa assertion in this file
  // iterating an empty array and passing. The switch ITSELF is asserted in
  // "MONEY-1229 — the qa kill-switch", which is what stops this line from
  // hiding a guard that was deleted.
  delete childEnv.DD_QA_MONITORING;
  const out = execFileSync("bash", [SCRIPT, env, "--dry-run"], {
    encoding: "utf8",
    // The script only reads files under the repo; nothing here depends on cwd.
    cwd: ROOT,
    env: {
      ...childEnv,
      ...(env === "qa" ? { DD_QA_MONITORING: "on" } : {}),
      PATH: `${NO_NET}:${childEnv.PATH ?? ""}`,
      STUB_LOG: NO_NET_LOG,
    },
  });
  return out
    .split("\n")
    .filter((l) => l.startsWith("  {"))
    .map((l) => JSON.parse(l.trim()) as RenderedMonitor);
}

/**
 * Render a PATCHED copy of the script, in a scratch tree — MONEY-1359 finding 9.
 *
 * The clamp bugs this file cares about are dormant until a row crosses a limit,
 * and no committed row does. Asserting them by grepping the source is what let
 * fault (e) ship (a header claiming behaviour no code performed), so the row is
 * ADDED instead and the real script runs over it.
 *
 * The tree is symlinks plus one real file: `apply-monitors.sh` resolves its
 * templates and `lib-datadog.sh` from `$HERE`, `setup-scheduler.sh` from
 * `$HERE/..`, and `packages/datadog/src` from `$HERE/../../..`, so all three
 * anchors have to exist. Nothing under the repo is written to.
 */
function renderPatched(
  patch: (src: string) => string,
  env: "prod" | "qa" = "prod",
): RenderedMonitor[] {
  const dir = mkdtempSync(join(tmpdir(), "apply-monitors-patched-"));
  try {
    const ddDir = join(ROOT, "scripts/ops/datadog");
    mkdirSync(join(dir, "scripts/ops/datadog"), { recursive: true });
    symlinkSync(join(ROOT, "packages"), join(dir, "packages"));
    symlinkSync(
      join(ROOT, "scripts/ops/setup-scheduler.sh"),
      join(dir, "scripts/ops/setup-scheduler.sh"),
    );
    for (const f of readdirSync(ddDir)) {
      if (f === "apply-monitors.sh") continue;
      symlinkSync(join(ddDir, f), join(dir, "scripts/ops/datadog", f));
    }
    const src = readFileSync(SCRIPT, "utf8");
    const patched = patch(src);
    assert.notEqual(
      patched,
      src,
      "the patch matched nothing — the assertion below would run against the " +
        "UNMODIFIED script and pass for the wrong reason",
    );
    const copy = join(dir, "scripts/ops/datadog/apply-monitors.sh");
    writeFileSync(copy, patched, { mode: 0o755 });
    const childEnv = { ...process.env };
    delete childEnv.DD_API_KEY;
    delete childEnv.DD_APP_KEY;
    delete childEnv.DD_NOTIFY;
    delete childEnv.DD_QA_MONITORING;
    const out = execFileSync("bash", [copy, env, "--dry-run"], {
      encoding: "utf8",
      cwd: dir,
      env: {
        ...childEnv,
        ...(env === "qa" ? { DD_QA_MONITORING: "on" } : {}),
        PATH: `${NO_NET}:${childEnv.PATH ?? ""}`,
        STUB_LOG: NO_NET_LOG,
      },
    });
    return out
      .split("\n")
      .filter((l) => l.startsWith("  {"))
      .map((l) => JSON.parse(l.trim()) as RenderedMonitor);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the REAL script against a stubbed `curl`, and report what curl saw.
 *
 * The create-vs-update decision cannot be checked by reading the source — that
 * is how fault (e) shipped in the first place, behind a header comment claiming
 * name-matching that no code performed. So `curl` is replaced on PATH with a
 * shell stub that logs its arguments and answers with a body and status this
 * function chooses. The script itself is unmodified: same file, same `set -euo
 * pipefail`, same node renderer, real exit code.
 *
 * The stub logs `"$*"`, which flattens each invocation onto one line except for
 * the literal newline inside `-w $'\n%{http_code}'`. Callers therefore count
 * `-X POST` / `-X PUT` occurrences in the whole log rather than splitting it
 * into lines.
 */
function runWithStubbedCurl(
  body: string,
  status = "200",
  writeStatus = status,
  /** Appended after `prod`. Defaults to nothing, so every existing call is a
   *  plain live run and only the `--only=verify` cases opt in. */
  extraArgs: string[] = [],
): { code: number; stderr: string; stdout: string; curlLog: string } {
  const dir = mkdtempSync(join(tmpdir(), "apply-monitors-"));
  const log = join(dir, "calls.log");
  try {
    writeFileSync(
      join(dir, "curl"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$STUB_LOG"',
        "cat > /dev/null", // DRAIN `-K -`. A stub that never reads stdin makes the
        // credential writer die of SIGPIPE; `pipefail` then surfaces 141 and
        // `dd_request` misreports it as "curl exited 141". Invisible on macOS,
        // fatal on Linux — which is how CI caught it and a local run did not.
        // The listing and the writes can be given different statuses, so a
        // healthy GET followed by a rejected PUT/POST is reachable.
        'case "$*" in',
        '  *"-X GET"*) status="$STUB_STATUS" ;;',
        '  *) status="$STUB_WRITE_STATUS" ;;',
        "esac",
        'printf "%s\\n%s\\n" "$STUB_BODY" "$status"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(log, "");
    const res = spawnSync("bash", [SCRIPT, "prod", ...extraArgs], {
      encoding: "utf8",
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        STUB_LOG: log,
        STUB_BODY: body,
        STUB_STATUS: status,
        STUB_WRITE_STATUS: writeStatus,
        // Present but meaningless: the stub never reaches Datadog. They exist
        // only so the script's own `:?` guards do not short-circuit the run.
        DD_API_KEY: "stub-api-key",
        DD_APP_KEY: "stub-app-key",
      },
    });
    return {
      code: res.status ?? -1,
      stderr: res.stderr ?? "",
      stdout: res.stdout ?? "",
      curlLog: readFileSync(log, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const countCalls = (curlLog: string, method: string): number =>
  curlLog.split(`-X ${method} `).length - 1;

/** The `job|window|cadence` rows the script declares. */
function monitoredJobs(): Array<{ job: string; window: string }> {
  const block = /declare -a MONITORED_JOBS=\(([\s\S]*?)\n\)/.exec(SCRIPT_SRC);
  assert.ok(block, "could not find MONITORED_JOBS in apply-monitors.sh");
  return [...block[1]!.matchAll(/"([^|"]+)\|([^|"]+)\|[^"]*"/g)].map((m) => ({
    job: m[1]!,
    window: m[2]!,
  }));
}

/**
 * The `job|window|kind|cadence` rows of the THIRD template (MONEY-1293).
 *
 * THE `kind` FIELD IS READ, not skipped — MONEY-1399. This parser had TWO
 * capture groups and matched the third field only to throw it away, which is
 * precisely why the rule the script states in prose was never enforced:
 * `apply-monitors.sh` says two constraints size a window, and only the first
 * one had anywhere to live or anything to check it.
 */
function absenceMonitors(): Array<{
  job: string;
  window: string;
  kind: string;
}> {
  const block = /declare -a ABSENCE_MONITORS=\(([\s\S]*?)\n\)/.exec(SCRIPT_SRC);
  assert.ok(block, "could not find ABSENCE_MONITORS in apply-monitors.sh");
  const rows = [
    ...block[1]!.matchAll(/"([^|"]+)\|([^|"]+)\|([^|"]+)\|[^"]*"/g),
  ].map((m) => ({ job: m[1]!, window: m[2]!, kind: m[3]! }));
  // A row that lost its kind field simply stops matching the 4-group pattern
  // and VANISHES from this list, taking every assertion below with it. Pin the
  // count against the raw quoted-row count so a silent drop cannot pass.
  const quoted = [...block[1]!.matchAll(/^\s*"[^"]+"/gm)].length;
  assert.equal(
    rows.length,
    quoted,
    `parsed ${rows.length} absence rows but the block holds ${quoted} quoted ` +
      `rows — a row is missing its "kind" field and fell out of the scan`,
  );
  for (const { job, kind } of rows) {
    assert.ok(
      kind === "standing" || kind === "sparse",
      `absence row for ${job} has kind "${kind}" — expected "standing" or ` +
        `"sparse". apply-monitors.sh exits 1 on this too.`,
    );
  }
  return rows;
}

/** The `job|metric|threshold|window` rows of the SECOND template (MONEY-979). */
function latencyMonitors(): Array<{
  job: string;
  metric: string;
  threshold: string;
}> {
  const block = /declare -a LATENCY_MONITORS=\(([\s\S]*?)\n\)/.exec(SCRIPT_SRC);
  assert.ok(block, "could not find LATENCY_MONITORS in apply-monitors.sh");
  return [...block[1]!.matchAll(/"([^|"]+)\|([^|"]+)\|([^|"]+)\|[^"]*"/g)].map(
    (m) => ({
      job: m[1]!,
      metric: m[2]!,
      threshold: m[3]!,
    }),
  );
}

/** The `gate_job|note` rows of the FOURTH template (MONEY-1373). */
function d1Monitors(): Array<{ job: string; note: string }> {
  const block = /declare -a D1_MONITORS=\(([\s\S]*?)\n\)/.exec(SCRIPT_SRC);
  assert.ok(block, "could not find D1_MONITORS in apply-monitors.sh");
  return [...block[1]!.matchAll(/"([^|"]+)\|([^"]*)"/g)].map((m) => ({
    job: m[1]!,
    note: m[2]!,
  }));
}

/**
 * Split the rendered bodies by TEMPLATE.
 *
 * `apply-monitors.sh` rendered exactly one template until MONEY-979 added a p95
 * latency monitor, which the zero-write template structurally cannot express
 * (it is a fixed two-counter difference with `thresholds.critical` at 0). Every
 * assertion in this file below is about the zero-write shape, so partitioning
 * keeps them exact instead of relaxing them to accommodate a body they were
 * never written for.
 *
 * The split is on the QUERY FORM, not on a name: asking for a percentile is
 * what makes a percentile monitor, and a zero-write body renaming itself would
 * still be checked here.
 *
 * MONEY-979 review — this used to be `query.startsWith("percentile(")`, which
 * recognised ONE of the two ways Datadog spells a percentile and happened to be
 * the wrong one for the series we emit. `percentile(…)` / `pNN:` addresses a
 * DISTRIBUTION; a DogStatsD histogram is read through an Agent-computed
 * sub-metric (`….95percentile`). Both spellings are matched here so the
 * partition survives the fix and would survive a future switch back.
 */
const PERCENTILE_QUERY_FORM =
  /(?:^|[\s(])percentile\(|:p(?:50|75|80|90|95|98|99):|\.\d{1,2}percentile\b/;

function isLatencyBody(m: RenderedMonitor): boolean {
  return PERCENTILE_QUERY_FORM.test(m.query);
}

/**
 * The ABSENCE query form — MONEY-1293's third template.
 *
 * Recognised POSITIVELY, on the one function that makes an absence check an
 * absence check: `default_zero()` renders a window with no points as a real
 * zero, so the monitor evaluates on silence instead of going grey. Neither
 * other template uses it, and a body that stopped using it would stop being an
 * absence monitor — so this matches the property rather than a name, the same
 * choice `isLatencyBody` makes.
 */
const SELECTED_RE = EMITTED_JOB_METRICS.selected.replace(/\./g, "\\.");

/**
 * MONEY-1399 — the `count_not_null(` group is OPTIONAL, and widening it was a
 * REQUIREMENT of that change rather than tidying.
 *
 * The sparse variant wraps the same counter one level deeper. Left as
 * `default_zero(\s*sum:` this recogniser stops matching every sparse body, they
 * drop out of `PROD_ABSENCE`, and every assertion in the MONEY-1293 block below
 * silently checks a population that no longer contains them — green, and
 * covering ten fewer monitors than it reports.
 */
const ABSENCE_QUERY_FORM = new RegExp(
  `\\bdefault_zero\\(\\s*(?:count_not_null\\(\\s*)?sum:${SELECTED_RE}\\{`,
);

/**
 * The SPARSE absence form specifically — `count_not_null` present.
 *
 * A sparse row counts SUBMISSIONS rather than summing work, so a checkpointed
 * job that ran and honestly found nothing does not read as "did not run".
 */
const SPARSE_ABSENCE_QUERY_FORM = new RegExp(
  `\\bdefault_zero\\(\\s*count_not_null\\(\\s*sum:${SELECTED_RE}\\{`,
);

function isAbsenceBody(m: RenderedMonitor): boolean {
  return ABSENCE_QUERY_FORM.test(m.query);
}

function isSparseAbsenceBody(m: RenderedMonitor): boolean {
  return SPARSE_ABSENCE_QUERY_FORM.test(m.query);
}

/**
 * The D1 TRIPWIRE query form — MONEY-1373's fourth template.
 *
 * Recognised on the METRIC, which is the only thing that makes this monitor
 * what it is: it has no `job:` filter (both Databento jobs emit the counter and
 * the invariant belongs to the DATA), no window sized from a cron, and no
 * threshold anyone tuned — so every structural property the other three
 * recognisers key on is absent here.
 *
 * IT ALSO USES `default_zero(`, which is why the absence recogniser above had
 * to be narrowed in the same change. That regex was `/\bdefault_zero\(/` and
 * would have matched this body too, making the "no catch-all" partition
 * non-disjoint — the failure `assertEveryBodyIsClassified` names as fatal.
 * Narrowing it to `default_zero(sum:<the job SELECTED counter>` keeps both
 * rules POSITIVE, which is the property this file argues for at length: a body
 * that stopped matching either one becomes UNRECOGNISED and fails loudly,
 * rather than falling into a residue bucket whose size then disagrees with a
 * declared total by one.
 */
const D1_QUERY_FORM = new RegExp(
  `sum:${EMITTED_DATABENTO_METRICS.displacedD1.replace(/\./g, "\\.")}\\{`,
);

function isD1Body(m: RenderedMonitor): boolean {
  return D1_QUERY_FORM.test(m.query);
}

/**
 * The ZERO-WRITE query form — recognised POSITIVELY, MONEY-1293.
 *
 * This used to be `!isLatencyBody(m)`, i.e. a catch-all, and that is exactly
 * how the absence family landed in the wrong bucket: the only symptom was an
 * off-by-one in a total ("38 != 37"), not "I do not know what this monitor is".
 *
 * `clamp_max` is the signature and not an incidental detail — it IS the
 * conjunction trick the zero-write monitor is built on (`clamp_max(selected,1)
 * - clamp_max(written,1) > 0`, see monitor-zero-write.json's
 * `_query_rationale`). A body that stopped using it would have stopped being
 * a zero-write monitor.
 */
const ZERO_WRITE_QUERY_FORM = /clamp_max\(/;

function isZeroWriteBody(m: RenderedMonitor): boolean {
  return ZERO_WRITE_QUERY_FORM.test(m.query);
}

/**
 * Datadog's measured `no_data_timeframe` ceiling, in minutes.
 *
 * Module scope because TWO rules read it and they must read the same number:
 * the per-window notify rule below, and the directory-wide literal scan that
 * covers the templates `apply-monitors.sh` never renders (MONEY-1359 finding 1).
 */
const NO_DATA_CEILING = 4320;

const RENDERED_PROD = render("prod");
const RENDERED_QA = render("qa");
const PROD = RENDERED_PROD.filter(isZeroWriteBody);
const QA = RENDERED_QA.filter(isZeroWriteBody);
const PROD_LATENCY = RENDERED_PROD.filter(isLatencyBody);
const PROD_ABSENCE = RENDERED_PROD.filter(isAbsenceBody);
const PROD_D1 = RENDERED_PROD.filter(isD1Body);
const JOBS = monitoredJobs();
const LATENCY_JOBS = latencyMonitors();
const ABSENCE_JOBS = absenceMonitors();
const D1_JOBS = d1Monitors();

/**
 * Expand a 5-field cron over one WEEK and return the largest gap, in hours,
 * between consecutive fires (wrapping Sunday->Monday).
 *
 * Simulated rather than reasoned about, because the arithmetic that replaced
 * it could only read a comma-list of hours on a daily cron — it asserted
 * `maxGap === 18`, news-sync's number, and applied it to every absence job.
 * The moment a second job joined the list that constant was wrong, and the
 * shapes it could not read at all are exactly the ones where the answer is
 * surprising: `*` / 9-15 / 1-5 is not "every 5 minutes", it is 7h15m, because
 * SATURDAY AND SUNDAY 09:00-15:59 are covered by neither of news-rss-sync's
 * two crons. Getting that wrong in the safe direction pages every weekend.
 */
const matchesField = (
  field: string,
  value: number,
  min: number,
  max: number,
): boolean => {
  for (const part of field.split(",")) {
    if (part === "*") return true;
    const step = /^(\*|\d+-\d+)\/(\d+)$/.exec(part);
    if (step) {
      const [lo, hi] =
        step[1] === "*" ? [min, max] : step[1]!.split("-").map(Number);
      if (value >= lo! && value <= hi! && (value - lo!) % Number(step[2]) === 0)
        return true;
      continue;
    }
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      if (value >= Number(range[1]) && value <= Number(range[2])) return true;
      continue;
    }
    if (Number(part) === value) return true;
  }
  return false;
};

/**
 * A cron whose DAY-OF-MONTH field is not `*` — MONEY-1359 finding 10.
 *
 * `maxGapHours` expands ONE WEEK and reads minute, hour and day-of-week only.
 * A day-of-month cron therefore looks to it like "every day at that time":
 * `30 8 12 * *` (monthly) is answered 24h when the real gap is ~31 days, off by
 * a factor of 31 IN THE UNSAFE DIRECTION — it reports a window as generous when
 * it is nowhere near.
 *
 * That is a blind spot rather than a bug, and it is handled by NAMING it: a job
 * whose crons are ALL day-of-month has no simulable gap and must be justified
 * deliberately, never sized from a number the simulator never computed.
 */
const isDayOfMonthCron = (cron: string): boolean =>
  cron.trim().split(/\s+/)[2] !== "*";

const maxGapHours = (crons: readonly string[]): number => {
  const fires: number[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute++) {
        const hit = crons.some((cron) => {
          const f = cron.trim().split(/\s+/);
          return (
            matchesField(f[0]!, minute, 0, 59) &&
            matchesField(f[1]!, hour, 0, 23) &&
            matchesField(f[4]!, dow, 0, 6)
          );
        });
        if (hit) fires.push(dow * 1440 + hour * 60 + minute);
      }
    }
  }
  if (fires.length === 0) return Number.POSITIVE_INFINITY;
  let gap = 0;
  for (let i = 0; i < fires.length; i++) {
    const next = fires[(i + 1) % fires.length]!;
    const d =
      i === fires.length - 1 ? 10080 - fires[i]! + next : next - fires[i]!;
    gap = Math.max(gap, d);
  }
  return gap / 60;
};

/**
 * Every cron that fires a given monitored job, read out of the repo.
 *
 * THREE places, because this estate provisions schedules in three ways and a
 * lookup that knew only the first reported two jobs as unschedulable:
 *
 *   1. A `SCHEDULER_DEFS` row whose TOPIC field is the job id — the common case.
 *   2. A `SCHEDULER_DEFS` row whose topic is a DIFFERENT job. `price-backfill`
 *      rides the `price-sync` topic with an `incremental` payload, so it is
 *      named only by its ENTRY name (`price-backfill-incremental-daily`).
 *   3. `schedule_job_run` in a Cloud Run JOB provisioner. `feed-parse`'s
 *      nightly trigger is created by `setup-feed-backfill-job.sh`, and nothing
 *      about it appears in `setup-scheduler.sh` at all.
 *
 * The entry-name match requires a `-` boundary so `price-sync` cannot absorb
 * `price-sync-something-else`'s cron, and it is only consulted when the topic
 * match found nothing — a job that owns a topic is described by that topic's
 * rows, not by whatever else happens to share its prefix.
 */
function cronsForJob(job: string): string[] {
  const scheduler = readFileSync(
    join(ROOT, "scripts/ops/setup-scheduler.sh"),
    "utf8",
  );
  const byTopic = [
    ...scheduler.matchAll(new RegExp(`"[a-z0-9-]+\\|([^|]*)\\|${job}\\|`, "g")),
  ].map((m) => m[1]!);
  if (byTopic.length > 0) return byTopic;

  const byEntryName = [
    ...scheduler.matchAll(
      new RegExp(`"${job}(?:-[a-z0-9-]+)?\\|([^|]*)\\|`, "g"),
    ),
  ].map((m) => m[1]!);
  if (byEntryName.length > 0) return byEntryName;

  const opsDir = join(ROOT, "scripts/ops");
  const out: string[] = [];
  for (const file of readdirSync(opsDir).filter((f) => f.endsWith(".sh"))) {
    const src = readFileSync(join(opsDir, file), "utf8");
    for (const m of src.matchAll(
      new RegExp(
        `schedule_job_run\\s+"${job}(?:-[a-z0-9-]+)?"\\s+"[^"]*"\\s+"([^"]+)"`,
        "g",
      ),
    )) {
      out.push(m[1]!);
    }
  }
  if (out.length > 0) return out;

  //   4. A pair of SHELL VARIABLES, `<JOB>_SCHEDULE_PRIMARY` /
  //      `_RETRY` — MONEY-1373. `databento-append`'s two triggers are created
  //      by `setup_edgar_bulk_job_schedulers`, a generic FUNCTION taking the
  //      crons as arguments, so there is no SCHEDULER_DEFS row and no
  //      `schedule_job_run` call: all three lookups above return nothing and
  //      the job reads as UNSCHEDULABLE.
  //
  //      That answer is not neutral. `simulableGapHours` returning null puts a
  //      job on the named not-simulable list, and a window on that list is a
  //      window NOBODY SIZED — which is how `bhavcopy-sync` and `feed-parse`
  //      both shipped a 36h window against a 72h weekend gap. Reading the crons
  //      out of the variables the function is CALLED with keeps the two generic
  //      window rules covering this job instead of exempting it.
  //
  //      Deliberately NOT tried before the three above: a job that owns a
  //      SCHEDULER_DEFS row is described by that row.
  const prefix = job.toUpperCase().replace(/-/g, "_");
  return [
    ...readFileSync(
      join(ROOT, "scripts/ops/setup-scheduler.sh"),
      "utf8",
    ).matchAll(new RegExp(`^${prefix}_SCHEDULE(?:_[A-Z]+)?="([^"]+)"`, "gm")),
  ].map((m) => m[1]!);
}

/**
 * The job's real max gap between runs, or `null` when the simulation cannot
 * answer — MONEY-1359 finding 10.
 *
 * Two ways it cannot answer, and both must be a refusal rather than a number:
 *
 *   * NO CRON AT ALL. The EDGAR bulk triggers are created by a FUNCTION
 *     (`setup_edgar_bulk_job_schedulers`), so `cronsForJob` finds nothing.
 *   * EVERY cron is DAY-OF-MONTH. `mf-portfolio-sync` is `30 8 12 * *` +
 *     `30 8 20 * *`; the week-long expansion reads dow `*` and answers 24h
 *     against a real gap of up to 23 days.
 *
 * A MIXTURE is answered from the non-DOM crons alone, and that is safe in the
 * one direction that matters: dropping crons only REMOVES fires, so the gap can
 * only come out LONGER than the truth, and a window is required to exceed it.
 * `report-archive-sync` is the live case — its `0 8 3 * *` monthly entry made
 * the simulator say 24h where its weekday/Saturday crons alone say 47h30m.
 */
function simulableGapHours(job: string): number | null {
  const crons = cronsForJob(job);
  if (crons.length === 0) return null;
  const nonDom = crons.filter((c) => !isDayOfMonthCron(c));
  if (nonDom.length === 0) return null;
  return maxGapHours(nonDom);
}

/**
 * Every monitor a prod run writes, across ALL THREE templates.
 *
 * The curl-stub tests below count writes, and a run writes the zero-write
 * monitors, the latency ones AND the absence ones. Counting only `JOBS.length`
 * was right while there was one template; naming the total keeps the next
 * template a one-line change here instead of three silent off-by-ones.
 */
const PROD_WRITES =
  JOBS.length + LATENCY_JOBS.length + ABSENCE_JOBS.length + D1_JOBS.length;

/** The three recognisers, by name, so a failure can say which one matched. */
const TEMPLATE_FORMS: Array<[string, (m: RenderedMonitor) => boolean]> = [
  ["zero-write", isZeroWriteBody],
  ["latency", isLatencyBody],
  ["absence", isAbsenceBody],
  ["databento-d1", isD1Body],
];

/**
 * NO CATCH-ALL — MONEY-1293.
 *
 * Every rendered body must match EXACTLY ONE positive form. Matching none is
 * fatal and names the body and its query, rather than being swept into a
 * residue bucket whose size then disagrees with a declared total by one.
 *
 * Matching more than one is fatal too: the partition assertions below (each
 * bucket's size against its declared array) are only meaningful while the
 * buckets are disjoint, and two overlapping recognisers would let one body be
 * counted twice while another went missing and the totals still balanced.
 */
function assertEveryBodyIsClassified(
  bodies: RenderedMonitor[],
  env: string,
): void {
  assert.ok(
    bodies.length > 0,
    `[${env}] nothing rendered — every classification below would be vacuous`,
  );
  for (const m of bodies) {
    const kinds = TEMPLATE_FORMS.filter(([, test]) => test(m)).map(([k]) => k);
    assert.ok(
      kinds.length !== 0,
      `[${env}] UNRECOGNISED MONITOR "${m.name}" matches none of the ` +
        `${TEMPLATE_FORMS.length} known template forms. Add a positive ` +
        `recogniser for it and give it its own count — do NOT widen an ` +
        `existing one. query: ${m.query}`,
    );
    assert.equal(
      kinds.length,
      1,
      `[${env}] "${m.name}" matches ${kinds.length} template forms ` +
        `(${kinds.join(", ")}) — the partition is no longer a partition. ` +
        `query: ${m.query}`,
    );
  }
}

describe("MONEY-1238 — the rendered monitor and the emitting code agree", () => {
  it("[meta] the render is live and covers every monitored job", () => {
    // Guards every assertion below. A parse that silently yields [] makes each
    // `for` loop vacuous, and this file would then pass while asserting nothing
    // — the same failure mode as the shadow assertion it replaces.
    assert.ok(
      JOBS.length >= 8,
      `expected 8+ monitored jobs, got ${JOBS.length}`,
    );
    assert.equal(
      PROD.length,
      JOBS.length,
      "one rendered monitor per MONITORED_JOBS row",
    );
    assert.deepEqual(
      PROD.map((m) => m.query.match(/job:([^,}]+)/)?.[1]),
      JOBS.map((j) => j.job),
      "the rendered monitors must be the declared jobs, in order",
    );
    // QA renders FEWER, and by exactly the right amount — MONEY-1250.
    //
    // Twenty monitored jobs are scrape-once-in-prod and have no QA schedule at
    // all, so a QA monitor for them sat in NO DATA from birth: finding #1(d) of
    // MONEY-1238, at scale, in the script that fixes #1(d). Asserted as an
    // EXACT set rather than `QA.length <= JOBS.length`, which a script that
    // skipped everything would also satisfy.
    const scheduler = readFileSync(
      join(ROOT, "scripts/ops/setup-scheduler.sh"),
      "utf8",
    );
    const block = /^PROD_ONLY_JOBS=\(([\s\S]*?)\n\)/m.exec(scheduler);
    assert.ok(block, "could not find PROD_ONLY_JOBS in setup-scheduler.sh");
    const prodOnlyEntries = new Set(
      [...block[1]!.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!),
    );
    // PROD_ONLY_JOBS holds SCHEDULER ENTRY names; MONITORED_JOBS holds JOB IDS.
    // Comparing the two namespaces directly answers "nothing is prod-only",
    // which is exactly how this went unnoticed.
    const expectedQa = JOBS.filter((j) => {
      const rows = [
        ...scheduler.matchAll(
          new RegExp(`"([a-z0-9-]+)\\|[^|]*\\|${j.job}\\|`, "g"),
        ),
      ].map((m) => m[1]!);
      if (rows.length > 0) return !rows.every((r) => prodOnlyEntries.has(r));
      // NO SCHEDULER_DEFS ROW. Two situations, one answer would be wrong for
      // the other — MONEY-1358, and this derivation has to make the same
      // distinction `job_is_prod_only` does or the two disagree about QA.
      //
      // The EDGAR bulk triggers are created by a FUNCTION
      // (`setup_edgar_bulk_job_schedulers`), not a row, so the match above
      // finds nothing. They ARE prod-only, listed in PROD_ONLY_JOBS under
      // trigger names that EXTEND the job id (`edgar-bulk-ftd-semimonthly`).
      // Reading "no row" as "runs in QA" would expect three QA monitors for
      // jobs QA never runs.
      return ![...prodOnlyEntries].some((e) => e.startsWith(`${j.job}-`));
    }).map((j) => j.job);

    assert.ok(
      expectedQa.length < JOBS.length,
      "no monitored job resolved as prod-only — the id/entry-name mapping broke",
    );
    assert.deepEqual(
      QA.map((m) => m.query.match(/job:([^,}]+)/)?.[1]),
      expectedQa,
      "qa must render exactly the jobs that have a QA schedule",
    );

    // AND, independently, three jobs named outright — MONEY-1358.
    //
    // The derivation above reads PROD_ONLY_JOBS, and so does the SCRIPT. When
    // both read the same list, deleting an entry moves both together and the
    // comparison still passes: measured, dropping the four edgar-bulk triggers
    // from PROD_ONLY_JOBS left this test GREEN while QA gained three monitors
    // for jobs it does not run. That is MONEY-1318's shape — a guard deriving
    // its expectation from the thing it checks — reproduced inside the guard
    // for it.
    //
    // These three are anchored to a fact about the WORLD instead: QA has
    // SEC_EGRESS=off and runs the EDGAR bulk jobs DISARMED
    // (EDGAR_PARSE_APPLY=false), so a QA monitor for them can only ever sit in
    // NO DATA or page on a disarmed run.
    for (const job of [
      "edgar-bulk-ftd",
      "edgar-bulk-submissions",
      "edgar-bulk-companyfacts",
    ]) {
      assert.ok(
        !QA.some((m) => m.query.includes(`job:${job},`)),
        `qa rendered a monitor for ${job}, which QA does not run — it has no ` +
          `SEC egress and ships the parse flag false`,
      );
    }
  });

  it("every ZERO-WRITE window exceeds its job's real max gap between runs", () => {
    // The rule this file argues at length for in prose, and has shipped wrong
    // TWICE — bhavcopy-sync at 36h on a `1-5` cron (NO DATA every weekend,
    // MONEY-1238), and feed-parse the same way until MONEY-1358. Nothing
    // enforced it: the absence list got a window check and the zero-write list,
    // which is 40 of the 45 monitors, did not. Mutation-checked — putting
    // feed-parse back to 36h left every test green.
    //
    // `notify_no_data: true` is what makes it matter. A window under the gap
    // means the series is legitimately empty for part of every cycle, so the
    // monitor goes NO DATA on a healthy schedule, and a monitor that cries wolf
    // is one somebody mutes.
    const scheduler = readFileSync(
      join(ROOT, "scripts/ops/setup-scheduler.sh"),
      "utf8",
    );
    const unresolved: string[] = [];
    const checked: string[] = [];
    for (const { job, window } of JOBS) {
      const m = /^(\d+)([hd])$/.exec(window);
      assert.ok(m, `unparsable window "${window}" for ${job}`);
      const hours = Number(m[1]) * (m[2] === "d" ? 24 : 1);
      const crons = cronsForJob(job);
      if (crons.length === 0) {
        // No SCHEDULER_DEFS row: the EDGAR bulk jobs (function-provisioned) and
        // any chained-only job. Collected and asserted below rather than
        // silently skipped — a scan that quietly drops rows is how a rule ends
        // up covering three of five.
        unresolved.push(job);
        continue;
      }
      const gap = simulableGapHours(job);
      if (gap === null) {
        // Crons exist but every one is DAY-OF-MONTH, which the week-long
        // expansion reads as "every day" — MONEY-1359 finding 10.
        // `mf-portfolio-sync` is the live case: `30 8 12 * *` + `30 8 20 * *`
        // simulates as 24h against a real gap of up to 23 days. A number that
        // wrong is worse than none, so it joins the named list below.
        unresolved.push(job);
        continue;
      }
      checked.push(job);
      assert.ok(
        hours > gap,
        `${job}'s window is ${hours}h but its runs can legitimately be ${gap}h ` +
          `apart, so the monitor sits in NO DATA on a healthy schedule`,
      );
    }
    assert.ok(
      checked.length >= 30,
      `only ${checked.length} windows were actually checked — the cron lookup broke`,
    );
    assert.deepEqual(
      unresolved.sort(),
      [
        "edgar-bulk-companyfacts",
        "edgar-bulk-ftd",
        "edgar-bulk-submissions",
        "mf-portfolio-sync",
      ],
      "a job the simulation cannot size has to be justified deliberately. The " +
        "three EDGAR bulk jobs are provisioned by a FUNCTION so they have no " +
        "SCHEDULER_DEFS row at all; mf-portfolio-sync's crons are DAY-OF-MONTH, " +
        "which the week-long expansion reads as 'every day' and answers 24h " +
        "against a real gap of ~23 days. Both are argued in their row comments. " +
        "A NEW name here is an unchecked window.",
    );
  });

  it("[meta] the prefix is not empty, so the name assertions are not vacuous", () => {
    // If METRIC_PREFIX were ever emptied, `stockbook.job.written` and
    // `job.written` would become the same string and every check in this file
    // would pass for the wrong reason.
    assert.ok(METRIC_PREFIX.length > 0, "METRIC_PREFIX must not be empty");
    assert.equal(
      EMITTED_JOB_METRICS.written,
      `${METRIC_PREFIX}${JOB_METRICS.written}`,
    );
    assert.notEqual(EMITTED_JOB_METRICS.written, JOB_METRICS.written);
  });

  it("(a) queries the PREFIXED series, not the bare name", () => {
    for (const m of PROD) {
      // Whole-token, not `includes`: the bare name is a SUBSTRING of the
      // prefixed one, so `includes(JOB_METRICS.written)` is true either way.
      // That exact substring test is what let the defect ship.
      assert.match(
        m.query,
        new RegExp(
          `sum:${EMITTED_JOB_METRICS.written.replace(/\./g, "\\.")}\\{`,
        ),
        `${m.name} does not query ${EMITTED_JOB_METRICS.written}`,
      );
      assert.ok(
        !/sum:job\.(written|selected)\{/.test(m.query),
        `${m.name} queries the UNPREFIXED name — datadog-metrics prepends ` +
          `"${METRIC_PREFIX}", so that series does not exist`,
      );
    }
  });

  it("(b) tags the env the WORKERS emit, not the CLI argument", () => {
    // prod -> production is the whole fault. Derived from toDatadogEnv rather
    // than written out, so the mapping cannot be corrected in one place and
    // left stale in the other.
    for (const m of PROD) {
      assert.match(
        m.query,
        new RegExp(`env:${toDatadogEnv("prod")}[,}]`),
        `${m.name} must tag env:${toDatadogEnv("prod")}`,
      );
      assert.ok(
        !/env:prod[,}]/.test(m.query),
        `${m.name} tags env:prod — no worker has ever emitted that tag`,
      );
    }
    for (const m of QA) {
      assert.match(m.query, new RegExp(`env:${toDatadogEnv("qa")}[,}]`));
    }
    // …and the two environments must not render the same tag, which would mean
    // the mapping had collapsed to a constant.
    assert.notEqual(toDatadogEnv("prod"), toDatadogEnv("qa"));
  });

  it("(c) the alert is the CONJUNCTION selected > 0 AND written < 1", () => {
    for (const m of PROD) {
      assert.ok(
        m.query.includes(`sum:${EMITTED_JOB_METRICS.selected}{`),
        `${m.name} does not mention ${EMITTED_JOB_METRICS.selected} — without ` +
          `it a genuinely idle run is indistinguishable from a broken one, ` +
          `which is the entire reason both counters exist`,
      );
      // clamp_max(x,1) - clamp_max(y,1) > 0 is the truth table; see the
      // template's _query_rationale for why it is not a composite monitor.
      assert.match(
        m.query,
        /clamp_max\([^)]*job\.selected[^)]*\)\s*,?\s*1\)\s*-\s*clamp_max\(/,
        `${m.name} must clamp SELECTED then subtract clamped WRITTEN`,
      );
      assert.match(m.query, />\s*0$/, `${m.name} must alert on > 0`);
      assert.equal(
        m.options.thresholds.critical,
        0,
        "Datadog rejects a monitor whose threshold disagrees with its query",
      );
    }
  });

  it("(c) the clamped-difference formula has the truth table it claims", () => {
    // The formula reduced to arithmetic. If someone "simplifies" the query to a
    // ratio or a bare subtraction, the shape assertions above may still pass —
    // this one says what the shape has to MEAN.
    const clampMax = (x: number, cap: number): number => Math.min(x, cap);
    const fires = (selected: number, written: number): boolean =>
      clampMax(selected, 1) - clampMax(written, 1) > 0;

    assert.equal(fires(100, 0), true, "found work, produced nothing -> ALERT");
    assert.equal(fires(100, 97), false, "partial write is not an alert");
    assert.equal(fires(1, 1), false, "healthy");
    assert.equal(fires(0, 0), false, "genuinely idle is NOT an alert");
    assert.equal(fires(0, 5), false, "wrote without selecting is not an alert");
  });

  it("(d) targets the Datadog SITE the metrics are submitted to", () => {
    const line = execFileSync("bash", [SCRIPT, "prod", "--dry-run"], {
      encoding: "utf8",
      cwd: ROOT,
    })
      .trim()
      .split("\n")
      .at(-1)!;
    assert.match(
      line,
      new RegExp(`api\\.${DD_SITE.replace(/\./g, "\\.")}`),
      `apply-monitors must call api.${DD_SITE} — DD_SITE is the org the ` +
        `metrics go to, and a monitor created on another site can never see them`,
    );
    assert.ok(
      !/https:\/\/api\.datadoghq\.com/.test(SCRIPT_SRC),
      "api.datadoghq.com is US1; this org is on " + DD_SITE,
    );
  });

  it("(e) looks the monitor up and UPDATES it instead of duplicating", () => {
    assert.match(
      SCRIPT_SRC,
      /dd_request GET /,
      "a re-run must LIST existing monitors before deciding create-vs-update",
    );
    assert.match(
      SCRIPT_SRC,
      /dd_request PUT "\$\{DD_BASE_URL\}\/\$\{EXISTING_ID\}"/,
      "a monitor that already exists must be PUT, not POSTed a second time",
    );
    assert.match(
      SCRIPT_SRC,
      /m\.name === process\.env\.MONITOR_NAME/,
      "the lookup must match on the rendered NAME",
    );
  });

  it("(e) every request checks its HTTP status and failures exit non-zero", () => {
    // `curl` exits 0 on a 403. Without an explicit status check the loop
    // continues, `set -euo pipefail` sees nothing, and the script reports
    // success having applied nothing — the script's own bug class.
    assert.match(
      SCRIPT_SRC,
      /\[\[ "\$RESPONSE_STATUS" == 2\* \]\] \|\| return 1/,
      "dd_request must fail on a non-2xx status",
    );
    assert.match(
      SCRIPT_SRC,
      /FAILED_JOBS\+=\(/,
      "failures must be accumulated, not printed and forgotten",
    );
    assert.match(
      SCRIPT_SRC,
      /if \(\(\$\{#FAILED_JOBS\[@\]\} > 0\)\); then[\s\S]*?exit 1/,
      "the script must exit non-zero when any monitor failed to apply",
    );
    // APPLIED **+ SKIPPED** — MONEY-1250. Prod-only jobs are now skipped on qa
    // (they have no QA schedule, so `notify_no_data` would leave them in NO DATA
    // from birth), and a skip must not read as a lost job. Both terms are
    // required: dropping SKIPPED makes every qa run FATAL, and dropping APPLIED
    // makes the check meaningless.
    assert.match(
      SCRIPT_SRC,
      /if \(\(APPLIED \+ SKIPPED != \$\{#MONITORED_JOBS\[@\]\}\)\); then/,
      "…and must not claim success on a loop that ended early",
    );
  });

  it("(f) an EXISTING monitor is PUT — a re-run does not duplicate", () => {
    // The idempotency claim, executed rather than read. The stub answers the
    // listing with exactly the monitors this script would create, so a correct
    // run issues one GET and eight PUTs and zero POSTs. Asserting on the source
    // text instead is what let the original defect ship: the header described
    // name-matching that no code performed.
    // RENDERED_PROD, not PROD: the listing has to contain EVERY monitor the run
    // would write, across both templates. Built from the narrowed zero-write
    // set, the latency monitor is absent from the listing, looks new, and gets
    // POSTed — which is the duplicate this test exists to reject.
    const listing = JSON.stringify(
      RENDERED_PROD.map((m, i) => ({ id: 1000 + i, name: m.name })),
    );
    const run = runWithStubbedCurl(listing);
    assert.equal(run.code, 0, `script failed: ${run.stderr}`);
    assert.equal(
      countCalls(run.curlLog, "POST"),
      0,
      "a second run POSTed a monitor that already exists — this is the " +
        "duplication that makes every alert fire twice",
    );
    assert.equal(countCalls(run.curlLog, "PUT"), PROD_WRITES);
    assert.equal(countCalls(run.curlLog, "GET"), 1, "one listing per run");
  });

  it("MONEY-1379 — --only=verify compares without writing, and NAMES the drift", () => {
    // Two directions of drift, neither of which announces itself: this script
    // UPSERTS by title and never deletes, so a row deleted from the table
    // leaves a live monitor still alerting (an ORPHAN) and a row added but
    // never applied leaves the repo claiming a monitor the org has never heard
    // of (MISSING).
    //
    // Built from RENDERED_PROD rather than a hand-written list of titles, and
    // from ALL FOUR loops rather than the zero-write set: a loop whose names go
    // uncollected reports every monitor it owns as an orphan, which is drift
    // the run invented. That is precisely what this case fails on.
    const names = RENDERED_PROD.map((m) => m.name);
    const listing = (ns: string[]): string =>
      JSON.stringify(ns.map((name, i) => ({ id: 2000 + i, name })));

    const inSync = runWithStubbedCurl(listing(names), "200", "200", [
      "--only=verify",
    ]);
    assert.equal(inSync.code, 0, `verify failed: ${inSync.stderr}`);
    // The whole point of not implementing this as `--dry-run`: verify is a LIVE
    // run that holds credentials and lists. It must still never write.
    assert.equal(
      countCalls(inSync.curlLog, "POST"),
      0,
      "--only=verify POSTed — a read-only check that writes is not a check",
    );
    assert.equal(countCalls(inSync.curlLog, "PUT"), 0);
    assert.match(inSync.stdout, new RegExp(`in both\\s+${names.length}\\b`));

    // …and it goes red on a real disagreement, naming the monitor. A verify
    // that only ever prints "in sync" is the mute button, not the alarm.
    const absent = names[names.length - 1]!;
    const drifted = runWithStubbedCurl(
      listing(names.slice(0, -1)),
      "200",
      "200",
      ["--only=verify"],
    );
    assert.equal(drifted.code, 3, "drift must exit 3, not 0");
    assert.match(
      drifted.stdout.split("only in code")[1] ?? "",
      new RegExp(absent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${absent} is in the code and not in Datadog; verify must say so`,
    );
  });

  it("MONEY-1379 — a SIBLING script's monitor under the shared tag is not drift", () => {
    // `apply-monitors.sh` and `apply-service-monitors.sh` both tag with AND
    // list by `managed-by:apply-monitors` — measured on the live org, 75
    // monitors carry it. So each script sees the other's as unrendered. Counted
    // as orphans, `--only=verify` would exit 3 on a perfectly synced estate,
    // every single run, and an alarm that always fires is the mute button.
    //
    // Hence the EXCLUSIVE=false flag: the extra set is REPORTED and does not
    // fail, because from one script alone it cannot be told apart from a
    // sibling's monitors. The MISSING half stays authoritative — that is the
    // half that catches "somebody edited the script and never applied it".
    const names = RENDERED_PROD.map((m) => m.name);
    const listing = (ns: string[]): string =>
      JSON.stringify(ns.map((name, i) => ({ id: 4000 + i, name })));

    const withSibling = runWithStubbedCurl(
      listing([...names, "[production] a monitor the OTHER script renders"]),
      "200",
      "200",
      ["--only=verify"],
    );
    assert.equal(
      withSibling.code,
      0,
      `a sibling's monitor failed verify:\n${withSibling.stdout}`,
    );
    assert.match(withSibling.stdout, /under the tag, not mine\s+1/);
    assert.match(withSibling.stdout, /The tag is SHARED/);

    // The flag must not have disabled the half that DOES work.
    const missing = runWithStubbedCurl(
      listing(names.slice(0, -1)),
      "200",
      "200",
      ["--only=verify"],
    );
    assert.equal(missing.code, 3, "a row never applied must still fail verify");
    assert.match(missing.stdout, /only in code\s+1/);
  });

  it("(f) a listing that is NOT an array aborts instead of POSTing", () => {
    // The fail-open path this file exists to close, and the one the fix itself
    // opened. Datadog answers some errors with 200 and an `{"errors": […]}`
    // body; read as "no monitors exist", every job is POSTed as new and the
    // whole set duplicates — arrived at through the door marked success, which
    // is the same class as the zero-write bug being monitored.
    const run = runWithStubbedCurl('{"errors":["Forbidden"]}');
    assert.notEqual(run.code, 0, "an unreadable listing must be fatal");
    assert.match(run.stderr, /not a JSON array/);
    assert.equal(
      countCalls(run.curlLog, "POST"),
      0,
      "POSTed after a listing it could not read — every monitor duplicates",
    );
    assert.equal(countCalls(run.curlLog, "PUT"), 0);
  });

  it("(f) a listing request that FAILS aborts instead of POSTing", () => {
    // Same door, different knock: a 403 from a wrong/expired app key. `curl`
    // exits 0 on an HTTP error, so without the explicit status check this
    // returns an error body that parses as "not found" for every job.
    const run = runWithStubbedCurl('{"errors":["Forbidden"]}', "403");
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /could not list existing monitors \(HTTP 403\)/);
    assert.equal(countCalls(run.curlLog, "POST"), 0);
    assert.equal(countCalls(run.curlLog, "PUT"), 0);
  });

  it("(f) …but a genuinely EMPTY listing still creates", () => {
    // The other half of the guard, and the reason it validates SHAPE rather
    // than refusing anything unexpected: `[]` is a real, correct answer on a
    // first run. A guard that aborted here would be a script that can never
    // create its monitors — fail-closed is only right when it can still say yes.
    const run = runWithStubbedCurl("[]");
    assert.equal(run.code, 0, `script failed: ${run.stderr}`);
    assert.equal(countCalls(run.curlLog, "POST"), PROD_WRITES);
    assert.equal(countCalls(run.curlLog, "PUT"), 0);
  });

  it("(f) a per-monitor write failure is fatal, not swallowed", () => {
    // Fault (e)'s accumulate-and-exit path, end to end: the listing succeeds
    // and every CREATE is rejected. `curl` exits 0 on a 500, so without the
    // explicit status check this run prints eight error bodies and exits 0
    // having applied nothing — which is the script's own bug class.
    const run = runWithStubbedCurl("[]", "200", "500");
    assert.notEqual(run.code, 0, "a 500 on every write must not exit 0");
    // DERIVED from the table, not hardcoded — MONEY-1238 Group C took this
    // from 8 to 21 and a literal count would have to be edited every time the
    // monitored set grows, which is how a guard ends up loosened to shut it up.
    // PROD_WRITES, not JOBS.length: the run writes BOTH templates and the
    // script's own denominator is the sum, so a JOBS-only count would fail
    // here for a script that is behaving correctly.
    assert.match(
      run.stderr,
      new RegExp(`${PROD_WRITES} of ${PROD_WRITES} monitors did NOT apply`),
    );
    // …and it must name them, or the operator has an exit code and no lead.
    // Both populations: a latency monitor that fails silently is a latency
    // monitor nobody knows they are missing.
    for (const job of [
      ...JOBS.map((j) => j.job),
      ...LATENCY_JOBS.map((j) => j.job),
      ...ABSENCE_JOBS.map((j) => j.job),
    ]) {
      assert.ok(
        run.stderr.includes(job),
        `${job} failed but is not named in the summary`,
      );
    }
  });

  it("the header no longer asserts idempotency it does not implement", () => {
    assert.ok(
      !/Idempotent: monitors are matched by NAME/.test(SCRIPT_SRC),
      "the old header claimed name-matching that no code performed",
    );
  });

  it("leaves no unsubstituted placeholder in what it would POST", () => {
    for (const m of [...PROD, ...QA]) {
      assert.ok(
        !/\{\{\w+\}\}/.test(JSON.stringify(m)),
        `${m.name} still carries a template placeholder`,
      );
    }
  });

  it("drops the documentation-only keys the API would reject", () => {
    for (const m of PROD) {
      assert.deepEqual(
        Object.keys(m).filter((k) => k.startsWith("_")),
        [],
      );
    }
  });

  it("every query window is inside Datadog's 30-day maximum", () => {
    // The OTHER ceiling, and it is expressed twice: `d` must be 1..30 and `h`
    // must be 1..720, which are the same span. Both were learned by being
    // refused — `last_32d` first, then `last_768h` when that was "fixed" by
    // switching units.
    //
    // Without this the 720h clamp could be removed and nothing would notice
    // until an apply run failed, which is precisely how the first one was
    // discovered.
    let checked = 0;
    for (const m of [...PROD, ...RENDERED_PROD]) {
      const w = /last_(\d+)([hd])\b/.exec(m.query);
      if (!w) continue;
      checked += 1;
      const [, n, unit] = w;
      const hours = unit === "d" ? Number(n) * 24 : Number(n);
      assert.ok(
        hours >= 1 && hours <= 720,
        `${m.name} queries last_${n}${unit} (${hours}h). Datadog refuses ` +
          "anything past 30 days: d must be 1..30 and h must be 1..720.",
      );
      if (unit === "d") {
        assert.ok(
          Number(n) <= 30,
          `${m.name} uses last_${n}d and the d unit is capped at 30`,
        );
      }
    }
    assert.ok(checked >= 20, `only ${checked} windows were checked`);
  });

  it("alerts on no-data wherever Datadog's ceiling allows it", () => {
    // A job emitting nothing at all is not a quiet success — it is a job that
    // did not run, or one whose reporting call was deleted. Both are what this
    // monitor exists to catch, and both look like health without it.
    //
    // This asserted `true` for EVERY monitor, and that turned out to be
    // unshippable: Datadog caps `no_data_timeframe` at 4320 minutes (72h) and
    // refused 35 of 37 monitors on the first live apply with
    // "No data timeframe must be <= 4320".
    //
    // The rule that replaced it is the one the ceiling forces, and it is
    // STRICTER than a blanket `true` because it ties each monitor to its own
    // window: a no-data alarm is meaningful only when its timeframe EXCEEDS the
    // job's legitimate maximum gap, and the window is already sized to exceed
    // that gap. So where the window fits under the ceiling, no-data is ON;
    // where it does not, no valid timeframe exists and no-data is OFF —
    // deliberately, because a 72h alarm on a job that legitimately gaps 72h
    // (Fri -> Mon) fires every single weekend, which is how bhavcopy-sync's
    // monitor got muted in the first place.
    const CEILING = NO_DATA_CEILING;
    const windows = new Map(monitoredJobs().map((j) => [j.job, j.window]));
    let on = 0;
    let off = 0;
    for (const m of PROD) {
      const job = /^\[production\] (\S+) wrote nothing/.exec(m.name)?.[1];
      assert.ok(job, `could not read a job out of ${m.name}`);
      const w = windows.get(job);
      assert.ok(w, `${job} rendered a monitor but is not in MONITORED_JOBS`);
      const mins = /^(\d+)h$/.test(w)
        ? Number(w.slice(0, -1)) * 60
        : Number(w.slice(0, -1)) * 24 * 60;

      assert.ok(
        m.options.no_data_timeframe > 0 &&
          m.options.no_data_timeframe <= CEILING,
        `${m.name}: no_data_timeframe ${m.options.no_data_timeframe} is outside ` +
          `1..${CEILING}, which Datadog refuses outright`,
      );
      assert.equal(
        m.options.notify_no_data,
        mins < CEILING,
        `${m.name} has a ${w} window (${mins} min) and notify_no_data=` +
          `${m.options.notify_no_data}. Under the ${CEILING}-minute ceiling a ` +
          "no-data alarm can only be meaningful when the window fits under it.",
      );
      m.options.notify_no_data ? (on += 1) : (off += 1);
    }
    // Both arms must be populated. A rule where every monitor lands on one side
    // is a rule that is not doing any work — and "all false" would be the
    // cheapest way to make the assertion above pass.
    assert.ok(on >= 10, `only ${on} monitors have no-data ON`);
    assert.ok(off >= 5, `only ${off} monitors have no-data OFF`);
  });

  it("NO TEMPLATE in the directory carries an over-ceiling no_data_timeframe", () => {
    // MONEY-1359 finding 1. `monitor-rt-bars-absence.json` shipped
    // `no_data_timeframe: 17280` — four times the ceiling — and nothing could
    // see it. The rule above iterates `apply-monitors.sh`'s rendered ZERO-WRITE
    // output (it matches `[production] X wrote nothing`), and that template is
    // rendered by `apply-service-monitors.sh`, which has no `window_limits`
    // clamp at all. So the enforcement covered one of the two scripts and the
    // literal sat in the other's input.
    //
    // Checked at the TEMPLATE, not at either script's output, because that is
    // the level at which the rule is script-independent: a third apply script
    // rendering the same directory inherits it for free. A `{{placeholder}}`
    // value is skipped and counted — those come from `window_limits`, which the
    // rule above already pins — and the count is asserted so "everything was a
    // placeholder" cannot be how this passes.
    const dir = join(ROOT, "scripts/ops/datadog");
    let literals = 0;
    let placeholders = 0;
    const templates = readdirSync(dir).filter(
      (f) => f.startsWith("monitor-") && f.endsWith(".json"),
    );
    for (const file of templates) {
      const doc = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        options?: { no_data_timeframe?: unknown; notify_no_data?: unknown };
      };
      const v = doc.options?.no_data_timeframe;
      if (v === undefined) continue;
      if (typeof v === "string") {
        assert.match(
          v,
          /^\{\{\w+\}\}$/,
          `${file} has a STRING no_data_timeframe that is not a placeholder`,
        );
        placeholders += 1;
        continue;
      }
      assert.equal(
        typeof v,
        "number",
        `${file}: no_data_timeframe is ${typeof v}`,
      );
      literals += 1;
      assert.ok(
        (v as number) > 0 && (v as number) <= NO_DATA_CEILING,
        `${file} hardcodes no_data_timeframe ${v as number}, outside ` +
          `1..${NO_DATA_CEILING}. Datadog refuses the whole monitor with 400 ` +
          `"No data timeframe must be <= ${NO_DATA_CEILING}" — and if the ` +
          `template is rendered by apply-service-monitors.sh there is no ` +
          `window_limits clamp between the literal and the API.`,
      );
    }
    // Falsifiable floors. Without them a scan that matched no files, or one
    // that only ever saw placeholders, reports green having checked nothing.
    //
    // The DIRECTORY floor is the load-bearing one: most templates omit
    // `no_data_timeframe` entirely (Datadog's default applies), so only two
    // carry a literal today — rt-health at 20 and rt-bars at 4320, and both are
    // service-monitor templates, i.e. exactly the ones the rule above cannot
    // reach. A low literal count is the healthy state; a low FILE count means
    // the scan stopped reading.
    assert.ok(
      templates.length >= 8,
      `only ${templates.length} monitor templates were scanned — expected the ` +
        `whole directory`,
    );
    assert.ok(
      literals >= 2,
      `only ${literals} literal timeframes were checked`,
    );
    assert.ok(
      placeholders >= 1,
      "no placeholder timeframe was seen — monitor-job-absence.json should " +
        "supply one, so the skip branch above is exercised",
    );
    // …and the row this finding is about, by name: a scan that stopped reading
    // service-monitor templates would still satisfy the floors above.
    const rtBars = JSON.parse(
      readFileSync(join(dir, "monitor-rt-bars-absence.json"), "utf8"),
    ) as { options: { no_data_timeframe: number; notify_no_data: boolean } };
    assert.ok(
      rtBars.options.no_data_timeframe <= NO_DATA_CEILING,
      `monitor-rt-bars-absence.json is back over the ceiling at ` +
        `${rtBars.options.no_data_timeframe}`,
    );
    // Its window is 96h, which is at-or-past the ceiling, so the SAME rule
    // `window_limits` applies to every other monitor says no valid timeframe
    // exists and the alarm must be off. default_zero() is the mechanism here
    // and the metric-rt-bars preflight covers the never-existed-tag case.
    assert.equal(
      rtBars.options.notify_no_data,
      false,
      "monitor-rt-bars-absence.json has a 96h window, so a 72h no-data alarm " +
        "fires on a healthy US holiday weekend — the muted-monitor shape",
    );
  });

  it("the LATENCY loop renders the CLAMPED window, not the raw one", () => {
    // MONEY-1359 finding 9. The loop called `window_limits "$L_HOURS"` — which
    // sets QUERY_WINDOW=720h and prints a loud clamp NOTE past 30 days — and
    // then rendered with the raw "$L_WINDOW". Both sibling loops read the clamp
    // back (`${QUERY_WINDOW:-$WINDOW}`, `A_QWINDOW`); this one computed it and
    // threw it away, so the operator saw "clamped to 720h" and Datadog was sent
    // `last_32d` and refused it 400.
    //
    // Dormant on the committed list, which holds one 1h row — so the row is
    // ADDED to a scratch copy and the real script runs over it. Asserting this
    // by grepping the source is the shape that let fault (e) ship.
    const rows = renderPatched((src) =>
      src.replace(
        /(declare -a LATENCY_MONITORS=\(\n)/,
        '$1  "scratch-clamp-probe|stockbook.edgar.detect_latency_seconds|300|32d"\n',
      ),
    );
    const probe = rows.find((m) => m.name.includes("scratch-clamp-probe"));
    assert.ok(probe, "the scratch latency row rendered nothing");
    assert.match(
      probe.query,
      /last_720h/,
      `a 32d latency window must render clamped to Datadog's 30-day maximum; ` +
        `got ${probe.query}`,
    );
    assert.doesNotMatch(
      probe.query,
      /last_32d/,
      "the raw 32d window reached the query — Datadog refuses it with " +
        '"unit d must have value between 1 and 30"',
    );
    // The committed 1h row is UNDER the limit, so it must pass through
    // untouched: a "fix" that clamped everything to 720h would satisfy the
    // assertions above and destroy every real window.
    //
    // Selected by TEMPLATE FORM, not by name: `edgar-detect` also has a
    // zero-write row, whose name contains the same job id and whose window is
    // 6h — matching on the name picks that one and this assertion fails for a
    // reason unrelated to the latency loop.
    const real = rows
      .filter(isLatencyBody)
      .find((m) => m.name.includes("edgar-detect"));
    assert.ok(real, "the real latency monitor disappeared");
    assert.match(
      real.query,
      /last_1h/,
      `1h window was rewritten: ${real.query}`,
    );
  });

  it("gives a WEEKLY job a window longer than a week", () => {
    // A weekly job with a 24h window is a pager that fires six days out of
    // seven. The window has to exceed the cadence or the monitor is noise.
    const weekly = JOBS.find((j) => j.job === "mf-metadata-sync");
    assert.ok(weekly, "mf-metadata-sync not monitored");
    assert.equal(weekly.window, "8d", "weekly job has a sub-week window");
    const rendered = PROD.find((m) => m.name.includes("mf-metadata-sync"))!;
    assert.match(rendered.query, /sum\(last_8d\)/);
  });

  it("carries the tag its own lookup filters on", () => {
    for (const m of PROD) {
      assert.ok(
        m.tags.includes("managed-by:apply-monitors"),
        `${m.name} would not be found by the script's own GET`,
      );
    }
  });
});

/**
 * The THIRD template (MONEY-1293) — job ABSENCE.
 *
 * A third question, not a variation on the first two. The zero-write monitor
 * asks "was selected work written"; the latency monitor asks "how long did it
 * take"; this asks "did it run at all" — and the first one structurally cannot,
 * because its query is a DIFFERENCE of two counters and a job that never ran
 * emits neither operand.
 *
 * Measured cause: on 2026-08-29 there were ZERO `news-sync` invocations for the
 * whole day. The 08-28 03:30Z slot took a 503 and then four 409s and never
 * succeeded; the next success was 08-30 05:30Z, ~62h later. The zero-write
 * monitor's no-data backstop is 3x its 36h window = 108h, so 62h of total
 * silence passed underneath it without a single alert.
 */
describe("MONEY-1293 — the absence monitor watches for silence, not for a bad write", () => {
  it("[meta] an absence monitor is declared and rendered", () => {
    // Guards every assertion below: a parse that yields [] makes each loop
    // vacuous and this block would pass while asserting nothing.
    assert.ok(
      ABSENCE_JOBS.length > 0,
      "ABSENCE_MONITORS is empty — every assertion below would be vacuous",
    );
    assert.equal(
      PROD_ABSENCE.length,
      ABSENCE_JOBS.length,
      "one rendered absence monitor per ABSENCE_MONITORS row",
    );
  });

  it("EVERY rendered body is classified by a positive rule — no catch-all", () => {
    // The condition MONEY-1293 was asked to add. Before this, "not latency"
    // meant "zero-write", so a third family landed in the wrong bucket and the
    // only symptom was an off-by-one in a total.
    assertEveryBodyIsClassified(RENDERED_PROD, "prod");
    assertEveryBodyIsClassified(RENDERED_QA, "qa");
    // And the three buckets must exhaust the render — a body counted twice or
    // not at all breaks the arithmetic every count assertion in this file uses.
    assert.equal(
      PROD.length + PROD_LATENCY.length + PROD_ABSENCE.length + PROD_D1.length,
      RENDERED_PROD.length,
      "the four partitions must be disjoint AND exhaustive",
    );
  });

  it("asks a DIFFERENT question from the zero-write monitor for the same job", () => {
    // Same job, two monitors, and they must not be two spellings of one alarm.
    for (const { job } of ABSENCE_JOBS) {
      const zero = PROD.filter((m) => m.query.includes(`job:${job},`));
      const absent = PROD_ABSENCE.filter((m) =>
        m.query.includes(`job:${job},`),
      );
      assert.ok(absent.length === 1, `no absence monitor rendered for ${job}`);
      // The names must differ, or apply-monitors.sh's name-matched idempotency
      // would treat them as one monitor and each run would overwrite the other.
      for (const z of zero) {
        assert.notEqual(
          z.name,
          absent[0]!.name,
          `${job}'s absence and zero-write monitors share a name — the ` +
            `script matches on name, so they would clobber each other`,
        );
      }
      // The absence query must NOT reference `written`: the whole point is
      // that it evaluates for a job that produced no counters at all.
      assert.ok(
        !absent[0]!.query.includes(EMITTED_JOB_METRICS.written),
        `${job}'s absence monitor reads the written counter — a job that ` +
          `never ran emits neither counter, so this would be the zero-write ` +
          `monitor with extra steps`,
      );
      assert.ok(
        absent[0]!.query.includes(EMITTED_JOB_METRICS.selected),
        `${job}'s absence monitor must sum the selected counter`,
      );
    }
  });

  it("watches a metric the job actually emits, with the prefix", () => {
    // The MONEY-1238 fault (a) in the third template: a hand-typed `job.selected`
    // here and a `prefix` in metrics.ts are two spellings of one fact.
    for (const body of PROD_ABSENCE) {
      assert.ok(
        body.query.includes(EMITTED_JOB_METRICS.selected),
        `${body.name} does not watch ${EMITTED_JOB_METRICS.selected}`,
      );
      assert.ok(
        body.query.includes(".as_count()"),
        `${body.name} sums a counter without .as_count() — sum() of a ` +
          `counter without it is a rate average`,
      );
    }
  });

  it("[meta] the gap simulation reproduces the numbers this file reasons about", () => {
    // A calculator nothing checks is a calculator that can be quietly wrong,
    // and every window below is sized from its output. These four are the
    // shapes the old arithmetic could and could not read.
    assert.equal(
      maxGapHours(["0 9,11,13,15 * * *"]),
      18,
      "news-sync 15:00 -> 09:00",
    );
    assert.equal(maxGapHours(["0 15 * * *"]), 24, "a once-daily job");
    assert.equal(
      maxGapHours(["35 22 * * 1-5"]),
      72,
      "weekday-only: Fri -> Mon",
    );
    assert.equal(
      maxGapHours(["*/5 9-15 * * 1-5", "*/15 0-8,16-23 * * *"]),
      7.25,
      "news-rss-sync: Sat/Sun 09:00-15:59 is covered by NEITHER cron",
    );
  });

  it("its WINDOW exceeds the job's real max gap between runs", () => {
    // The rule this file already enforces for the zero-write list, applied to
    // the third. A window under the real gap goes below threshold on a
    // perfectly healthy schedule — the bhavcopy-sync 36h-on-a-`1-5`-cron shape
    // (MONEY-1238), which is how a real alert gets muted.
    const scheduler = readFileSync(
      join(ROOT, "scripts/ops/setup-scheduler.sh"),
      "utf8",
    );
    const notSimulable: string[] = [];
    let checked = 0;
    for (const { job, window } of ABSENCE_JOBS) {
      const m = /^(\d+)([hd])$/.exec(window);
      assert.ok(m, `unparsable absence window "${window}" for ${job}`);
      const hours = Number(m[1]) * (m[2] === "d" ? 24 : 1);
      // Datadog's OTHER ceiling. A window past 30 days cannot be expressed in
      // either unit, so a job whose legitimate gap exceeds it can have no valid
      // absence monitor at all — see `mf-portfolio-sync`'s exclusion below.
      assert.ok(
        hours <= 720,
        `${job}'s absence window is ${hours}h; Datadog refuses anything past ` +
          `30 days (d is 1..30, h is 1..720)`,
      );
      // Read the job's crons out of the repo rather than restating them.
      const gap = simulableGapHours(job);
      if (gap === null) {
        notSimulable.push(job);
        continue;
      }
      checked += 1;
      assert.ok(
        hours > gap,
        `${job}'s absence window is ${hours}h but its runs can legitimately ` +
          `be ${gap}h apart — this monitor would fire on a healthy schedule, ` +
          `which is how a real alert gets muted`,
      );
    }
    assert.ok(
      checked >= 20,
      `only ${checked} absence windows were actually sized — the cron lookup broke`,
    );
    // Collected and named, never silently skipped: a scan that quietly drops
    // rows is how a rule ends up covering three of five.
    assert.deepEqual(
      notSimulable.sort(),
      ["edgar-bulk-ftd"],
      "an absence window the cron simulation cannot size must be justified in " +
        "its row comment. edgar-bulk-ftd's four triggers are created by " +
        "`setup_edgar_bulk_job_schedulers`, a FUNCTION, so there is no " +
        "SCHEDULER_DEFS row to read. A NEW name here is an unsized window.",
    );
  });

  it("covers every job whose zero-write monitor lost its no-data alarm", () => {
    // MONEY-1359 finding 10, and the reason this list grew from four rows to
    // twenty-five. `window_limits` turns `notify_no_data` OFF for every
    // zero-write row whose window is >= Datadog's 4320-minute ceiling — forced,
    // and correct, because a 72h alarm on a job that legitimately gaps 72h
    // fires every weekend. What it leaves behind is not forced: for those jobs
    // "stopped running entirely" is watched by NOTHING. The zero-write query is
    // a DIFFERENCE of two counters, so a job that never ran emits neither
    // operand and the threshold cannot fire; this template is the only one that
    // evaluates on silence.
    //
    // Derived from the RENDERED bodies rather than from the window strings, so
    // it follows whatever `window_limits` actually decides.
    const covered = new Set(ABSENCE_JOBS.map((j) => j.job));
    const uncovered = PROD.filter((m) => m.options.notify_no_data === false)
      .map((m) => /^\[production\] (\S+) wrote nothing/.exec(m.name)?.[1])
      .filter((job): job is string => Boolean(job))
      .filter((job) => !covered.has(job));

    // `mf-portfolio-sync` IS THE ONE PERMITTED HOLE, and it is named rather
    // than skipped. Its crons are `30 8 12 * *` + `30 8 20 * *` — day-of-month,
    // which the simulation cannot read — and the real gap is the 20th -> the
    // 12th of the next month, up to 23 days WITH the retry entry and a full
    // month (744h) without it. Datadog's query window maxes at 720h, so a
    // window that exceeds the gap either does not exist or sits in a band whose
    // whole width depends on a second trigger continuing to exist. There is no
    // honest number, so there is no row.
    assert.deepEqual(
      uncovered.sort(),
      ["mf-portfolio-sync"],
      "these jobs have notify_no_data:false on their zero-write monitor and no " +
        "absence row, so nothing watches for them stopping entirely. Add an " +
        "ABSENCE_MONITORS row sized from the job's real cron, or — if no window " +
        "under Datadog's 30-day maximum can exceed the legitimate gap — say so " +
        "in the row comment and add the name here.",
    );

    // Falsifiable floor. An empty `uncovered` is also what a broken name regex
    // produces, and that reads as full coverage.
    const clamped = PROD.filter(
      (m) => m.options.notify_no_data === false,
    ).length;
    assert.ok(
      clamped >= 20,
      `only ${clamped} zero-write monitors have no-data off — the ceiling rule ` +
        `changed, so this test is checking a population that no longer exists`,
    );
  });

  it("evaluates on silence — default_zero, not a second no-data monitor", () => {
    const windows = new Map(ABSENCE_JOBS.map((j) => [j.job, j.window]));
    let on = 0;
    let off = 0;
    for (const body of PROD_ABSENCE) {
      assert.match(
        body.query,
        /default_zero\(/,
        `${body.name} has no default_zero() — without it a window with no ` +
          `points is NO DATA, which is the state that already failed to fire`,
      );
      assert.equal(typeof body.options.no_data_timeframe, "number");
      assert.ok(
        body.options.no_data_timeframe > 0 &&
          body.options.no_data_timeframe <= NO_DATA_CEILING,
        `${body.name}: no_data_timeframe ${body.options.no_data_timeframe} is ` +
          `outside 1..${NO_DATA_CEILING}, which Datadog refuses outright`,
      );
      // notify_no_data is a BACKSTOP here, not the mechanism, and it follows
      // the same ceiling rule every other monitor does — this asserted a
      // blanket `true` while all four rows were under 72h, and MONEY-1359's
      // twenty-one new rows are not. `window_limits` turns it off at or past
      // the ceiling because a 72h alarm on a job that legitimately gaps 72h
      // fires every weekend. Nothing is lost: `default_zero()` renders an empty
      // window as a real 0, so these monitors alert from their own threshold.
      const job = /^\[production\] (\S+) has not reported/.exec(body.name)?.[1];
      assert.ok(job, `could not read a job out of ${body.name}`);
      const w = windows.get(job);
      assert.ok(w, `${job} rendered an absence monitor but is not declared`);
      const mins = /^(\d+)h$/.test(w)
        ? Number(w.slice(0, -1)) * 60
        : Number(w.slice(0, -1)) * 24 * 60;
      assert.equal(
        body.options.notify_no_data,
        mins < NO_DATA_CEILING,
        `${body.name} has a ${w} window (${mins} min) and notify_no_data=` +
          `${body.options.notify_no_data}`,
      );
      body.options.notify_no_data ? (on += 1) : (off += 1);
    }
    // Both arms populated, for the reason the zero-write rule states it: a rule
    // where every row lands on one side is doing no work, and "all false" is
    // the cheapest way to satisfy the equality above.
    assert.ok(on >= 3, `only ${on} absence monitors have no-data ON`);
    assert.ok(off >= 15, `only ${off} absence monitors have no-data OFF`);
  });

  it("is discoverable by the script's own idempotency listing", () => {
    // Without the managed-by tag the GET does not return it and every run
    // POSTs it as new — the duplication that listing exists to prevent.
    for (const body of PROD_ABSENCE) {
      assert.ok(
        body.tags.includes("managed-by:apply-monitors"),
        `${body.name} would not be found by the script's own GET`,
      );
    }
  });

  it("is not created for an environment that never runs the job", () => {
    // news-sync-market-hours is in PROD_ONLY_JOBS. A QA absence monitor would
    // alert continuously from birth — worse here than in either other loop,
    // because this monitor's whole premise is that silence is a fault.
    const qaAbsence = RENDERED_QA.filter(isAbsenceBody);
    for (const { job } of ABSENCE_JOBS) {
      const rows = [
        ...readFileSync(
          join(ROOT, "scripts/ops/setup-scheduler.sh"),
          "utf8",
        ).matchAll(new RegExp(`"([a-z0-9-]+)\\|[^|]*\\|${job}\\|`, "g")),
      ].map((m) => m[1]!);
      const prodOnlyBlock = /^PROD_ONLY_JOBS=\(([\s\S]*?)\n\)/m.exec(
        readFileSync(join(ROOT, "scripts/ops/setup-scheduler.sh"), "utf8"),
      );
      assert.ok(prodOnlyBlock);
      const prodOnly = new Set(
        [...prodOnlyBlock[1]!.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!),
      );
      if (rows.length > 0 && rows.every((r) => prodOnly.has(r))) {
        assert.ok(
          !qaAbsence.some((m) => m.query.includes(`job:${job},`)),
          `${job} is prod-only but a QA absence monitor was rendered`,
        );
      }
    }
  });

  it("the script accounts for the absence loop separately", () => {
    // Same guarantee the other two loops carry: the number of monitors REACHED
    // must equal the number DECLARED. A single summed check could be satisfied
    // by one loop over-counting while another ended early.
    assert.match(
      SCRIPT_SRC,
      /if \(\(A_APPLIED \+ A_SKIPPED != \$\{#ABSENCE_MONITORS\[@\]\}\)\); then/,
      "the absence loop has no completeness check",
    );
  });
});

/**
 * MONEY-1399 — an absence row's KIND decides WHICH QUESTION it asks.
 *
 * Both templates answer "is this job still running". They disagree about what a
 * `selected: 0` means, and the disagreement is a property of the JOB:
 *
 *   standing  a zero IS the defect. The population always has rows, so a gate
 *             matching none of them is broken (news-sync: 782 rows selecting
 *             nothing for months, MONEY-1215). Query sums `selected`.
 *   sparse    a zero is the DESIGNED STEADY STATE. A checkpoint or a novelty
 *             gate means a caught-up run finds nothing. Query counts
 *             SUBMISSIONS via `count_not_null`, so the value is ignored.
 *
 * Measured 2026-09-13, and the reason this exists: Datadog already distinguishes
 * the two states — edgar-bulk-ftd's 2026-09-10 run left ONE non-null point of
 * value 0.0, while a job that did not run has NO SERIES AT ALL — and
 * `default_zero(sum:...)` fills the gaps with zeros and erases it. That monitor
 * was created 2026-09-06, alerted 11 seconds later and had never once been OK,
 * while `us_cusip_map.SEC_FTD` (23,406 rows) filled correctly underneath it.
 */
describe("MONEY-1399 — an absence row's kind decides which question it asks", () => {
  const ABSENCE_TPL = JSON.parse(
    readFileSync(
      join(ROOT, "scripts/ops/datadog/monitor-job-absence.json"),
      "utf8",
    ),
  );
  const SPARSE_TPL = JSON.parse(
    readFileSync(
      join(ROOT, "scripts/ops/datadog/monitor-job-absence-sparse.json"),
      "utf8",
    ),
  );

  /** The job id out of a rendered absence query's scope. */
  const jobOf = (m: RenderedMonitor): string => {
    const hit = /\{job:([^,}]+)[,}]/.exec(m.query);
    assert.ok(hit, `could not read a job id out of: ${m.query}`);
    return hit![1]!;
  };

  it("the two templates render the SAME name — the upsert is BY NAME", () => {
    // THE CONTRACT THAT MAKES THIS CHANGE SAFE TO APPLY. Both scripts upsert on
    // the monitor's name, so a row that switches kind PUTs over its own
    // existing monitor. A name differing by one character would instead CREATE
    // a second monitor beside the first, leave the original alerting forever
    // with nothing rendering it, and `--only=verify` would then report it as an
    // orphan under a tag two scripts share — which nothing is allowed to prune.
    assert.equal(
      SPARSE_TPL.name,
      ABSENCE_TPL.name,
      "the sparse absence template's name drifted from the standing one — " +
        "applying it would create a second monitor rather than update the first",
    );
    // Same reasoning for everything the operator tunes: only the QUESTION may
    // differ between kinds, never the alerting behaviour around it.
    assert.equal(SPARSE_TPL.type, ABSENCE_TPL.type);
    assert.deepEqual(SPARSE_TPL.options, ABSENCE_TPL.options);
  });

  it("the sparse template asks the COUNTING question, and still evaluates on silence", () => {
    assert.match(
      SPARSE_TPL.query,
      /default_zero\(\s*count_not_null\(/,
      "the sparse template must wrap count_not_null in default_zero",
    );
    // default_zero is LOAD-BEARING here and looks like the thing this variant
    // exists to remove. Measured against the live org: count_not_null ALONE
    // returns NO SERIES on a window with no points, so the threshold never
    // evaluates and the monitor sits grey instead of alerting — the exact
    // MONEY-1359 finding-10 hole this template was built to close.
    assert.ok(
      SPARSE_TPL.query.includes("default_zero("),
      "dropping default_zero() makes a silent window NO DATA, not a real 0",
    );
    assert.ok(
      !ABSENCE_TPL.query.includes("count_not_null("),
      "the STANDING template must keep summing `selected` — a zero there is " +
        "the defect it exists to catch (MONEY-1215)",
    );
  });

  it("every rendered body asks the question its row's kind declares", () => {
    const kindOf = new Map(ABSENCE_JOBS.map((r) => [r.job, r.kind]));
    assert.ok(
      PROD_ABSENCE.length >= 20,
      `only ${PROD_ABSENCE.length} absence bodies were recognised — the ` +
        `recogniser stopped matching a whole kind, and every assertion here ` +
        `would then pass over a population that no longer contains it`,
    );
    for (const body of PROD_ABSENCE) {
      const job = jobOf(body);
      const kind = kindOf.get(job);
      assert.ok(kind, `rendered absence monitor for unknown job "${job}"`);
      if (kind === "sparse") {
        assert.ok(
          isSparseAbsenceBody(body),
          `${job} is declared sparse but rendered the summing query — a ` +
            `checkpointed job that ran and found nothing will read as dead`,
        );
      } else {
        assert.ok(
          !isSparseAbsenceBody(body),
          `${job} is declared standing but rendered the counting query — a ` +
            `population gate matching no rows would stop alarming (MONEY-1215)`,
        );
      }
    }
  });

  it("the sparse set is pinned BY VALUE — moving a job between kinds is deliberate", () => {
    // Checkpointing is what puts a job here, and it was a perfect predictor
    // across all 25 rows when this was measured: every checkpointed or
    // novelty-gated job could idle at zero, and none of the re-selecting ones
    // could. A job arriving in or leaving this list is a claim about its
    // selection semantics, so it is typed out rather than inferred.
    assert.deepEqual(
      ABSENCE_JOBS.filter((r) => r.kind === "sparse")
        .map((r) => r.job)
        .sort(),
      [
        "candle-evict",
        "databento-append",
        "edgar-bulk-ftd",
        "feed-parse",
        "news-rss-sync",
        "price-backfill",
        "report-archive-sync",
        "resend-contact-sync",
        "tiingo-news-poll",
      ],
    );
  });

  it("the job whose window was demonstrably too short is sparse", () => {
    // Named rather than left to the list above, because this is the evidence
    // the whole change rests on and a silent reclassification would put it
    // straight back into a permanent alert.
    //
    //   edgar-bulk-ftd  SEC publishes twice monthly onto a 3/10/18/25
    //                   detection grid, so the legitimate zero-stretch is ~15d
    //                   and reaches ~24d, against a 16d window.
    const kindOf = new Map(ABSENCE_JOBS.map((r) => [r.job, r.kind]));
    assert.equal(
      kindOf.get("edgar-bulk-ftd"),
      "sparse",
      "edgar-bulk-ftd must stay sparse — its legitimate run of selected:0 " +
        "exceeds any window Datadog will accept (30d ceiling)",
    );

    // This case named TWO jobs until MONEY-1404. The second,
    // `etf-expense-enrichment`, left the sparse set by being RETIRED — not by
    // being reclassified — and those are different claims: the sparse
    // exemption is what hid a job that could never write at all. So the
    // assertion is that it has NO absence row in either kind. A row coming
    // back as `standing` would alarm forever on a retired job; a row coming
    // back as `sparse` would re-arm the exemption that hid it.
    assert.equal(
      kindOf.get("etf-expense-enrichment"),
      undefined,
      "etf-expense-enrichment is retired (MONEY-1404) — it must have no " +
        "absence row at all, not a reclassified one",
    );
  });
});

/**
 * The SECOND template (MONEY-979) — a p95 over a histogram.
 *
 * `monitor-zero-write.json` is a fixed two-counter difference with
 * `thresholds.critical` at 0; no substitution of its placeholders can express a
 * percentile, which is why a second template exists at all. These assertions
 * are the same kind this file makes for the first one: the monitor and the code
 * that emits the series must agree, checked by reading both.
 *
 * The emitter here is PYTHON (`services/us-fundamentals/app/store/outcome.py`),
 * so the agreement crosses a language boundary — which is exactly the seam most
 * likely to drift, because no compiler or import spans it.
 */
describe("MONEY-979 — the latency monitor agrees with the Python emitter", () => {
  it("[meta] a latency monitor is declared and rendered", () => {
    assert.ok(
      LATENCY_JOBS.length > 0,
      "LATENCY_MONITORS is empty — every assertion below would be vacuous",
    );
    assert.equal(
      PROD_LATENCY.length,
      LATENCY_JOBS.length,
      "one rendered latency monitor per LATENCY_MONITORS row",
    );
  });

  it("the metric it watches is the metric the service EMITS", () => {
    // Read the Python constant rather than restating the string. A monitor
    // watching a series nothing writes sits in NO DATA forever, which reads
    // exactly like a healthy quiet system.
    const emitter = readFileSync(
      join(ROOT, "services", "us-fundamentals", "app", "store", "outcome.py"),
      "utf8",
    );
    const declared =
      /DETECT_LATENCY_METRIC\s*=\s*settings\.METRIC_PREFIX\s*\+\s*"([^"]+)"/.exec(
        emitter,
      );
    assert.ok(
      declared,
      "could not find DETECT_LATENCY_METRIC in outcome.py — this check is no " +
        "longer reading the emitter it claims to",
    );
    const emitted = `${METRIC_PREFIX}${declared[1]!}`;

    for (const { metric } of LATENCY_JOBS) {
      assert.equal(
        metric,
        emitted,
        `LATENCY_MONITORS watches "${metric}" but the service emits ` +
          `"${emitted}". A monitor on a series nobody writes stays in NO DATA, ` +
          `which is indistinguishable from a healthy quiet system.`,
      );
    }
  });

  it("the threshold is a NUMBER, and it is the declared one", () => {
    // Datadog rejects a monitor whose threshold is the string "300" with a 400
    // naming the field — obvious once seen, invisible until then. The
    // zero-write template hardcodes 0 (already numeric); this one substitutes.
    for (const [i, body] of PROD_LATENCY.entries()) {
      const critical = body.options?.thresholds?.critical;
      assert.equal(
        typeof critical,
        "number",
        `thresholds.critical rendered as ${typeof critical}, not a number`,
      );
      assert.equal(critical, Number(LATENCY_JOBS[i]!.threshold));
    }
  });

  it("it is a p95 query on the prefixed series, scoped to the env", () => {
    for (const body of PROD_LATENCY) {
      // The HISTOGRAM percentile form. This read
      // `/^percentile\(last_\w+\):p95:/` for one release — the DISTRIBUTION
      // form, over a series emitted as `statsd.histogram(...)`, i.e. a query
      // against a name that cannot exist. The type is what decides the form;
      // see monitor-latency-p95.json's `_query_form_rationale`, and the
      // emit-type check below, which is the one that fails on the class rather
      // than on this instance.
      assert.match(body.query, /^avg\(last_\w+\):max:/);
      assert.match(
        body.query,
        /\.95percentile\{/,
        `a histogram's percentile is an Agent SUB-METRIC, not its base name: ${body.query}`,
      );
      assert.ok(
        body.query.includes(METRIC_PREFIX),
        `the query must watch the PREFIXED series: ${body.query}`,
      );
      assert.match(body.query, /\{env:production\}/);
    }
  });

  it("notify_no_data is OFF — this monitor watches SLOW, not ABSENT", () => {
    // This read `true` for one release, on the argument that "a detection loop
    // that stops emitting is indistinguishable from a market with no filings
    // unless silence itself pages, and 'no filings at all' is never true on a
    // US weekday". The premise is correct; the conclusion is not, because it
    // reasons about weekdays and the monitor evaluates every day.
    //
    // The latency series has a point only when a NEW filing was claimed, so it
    // is empty in two states we ship on purpose. FROM BIRTH: `EDGAR_DETECT`
    // ships "off" and detect.py returns via `_skipped()` before the fan-out
    // loop that is the metric's only emit site, while `apply-monitors.sh prod`
    // runs in the runbook's FIRST-DEPLOY block, ahead of arming. EVERY WEEKEND:
    // SEC accepts filings on business days, so Sat 00:00 ET -> Mon 06:00 ET is
    // ~54h with no sample against a 180-minute window, fully armed.
    //
    // Absence is not unwatched — it is watched by the instrument that can see
    // it. `edgar-detect` also has a ZERO-WRITE monitor (asserted below), and
    // ITS counters come from a `report_job_outcome` call in a `finally` that
    // wraps the flag check, so all 1,440 daily runs emit 0/0 in every weather.
    // NO DATA there really does mean the scheduler or the service stopped.
    //
    // Do not flip this back to recover coverage; there is none to recover.
    // Full argument: monitor-latency-p95.json's `_notify_no_data_rationale`.
    for (const body of PROD_LATENCY) {
      assert.equal(body.options?.notify_no_data, false, body.name);
      assert.equal(typeof body.options?.no_data_timeframe, "number");
    }
    // The zero-write population keeps a DIFFERENT contract, asserted here so
    // the two cannot be conflated by a future edit that "unifies" them.
    //
    // This used to read "every zero-write monitor has notify_no_data: true",
    // which Datadog's 4320-minute ceiling has since made unshippable — the
    // long-window jobs now carry `false` because no valid timeframe exists for
    // them. The distinction the case exists to protect survives, and is now
    // sharper: LATENCY is uniformly false because its template hardcodes it,
    // while ZERO-WRITE is MIXED because it is derived per job from the window.
    // A future edit that unified them would make the zero-write population
    // uniform, which is exactly what this now catches.
    const nd = new Set(PROD.map((m) => m.options.notify_no_data));
    assert.deepEqual(
      [...nd].sort(),
      [false, true],
      "the zero-write population is uniform on notify_no_data — it is derived " +
        "PER JOB from the window, so both values must appear. Uniformity means " +
        "the derivation was replaced by a constant, most likely the latency " +
        "template's.",
    );

    // The specific safety claim this whole case rests on: the latency monitor
    // may ignore silence ONLY because edgar-detect's zero-write monitor does
    // not. Asserting the monitor merely EXISTS is not enough — it has to be one
    // that actually alerts on no-data, which under the ceiling is a property of
    // its window rather than a given.
    const detect = PROD.find((m) => m.name.includes("edgar-detect"));
    assert.ok(
      detect,
      "edgar-detect must keep a zero-write monitor — it is what makes the " +
        "latency monitor's notify_no_data:false safe rather than a blind spot",
    );
    assert.equal(
      detect.options.notify_no_data,
      true,
      "edgar-detect's zero-write monitor no longer alerts on no-data, so " +
        "nothing covers the silence the latency monitor deliberately ignores",
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * MONEY-979 review — the CLASS behind the latency monitor's broken query.
 *
 * The block above checks that a monitor names the metric the code emits. That
 * check was green while the latency monitor could not resolve, because the NAME
 * was right the whole time and the FORM was wrong:
 *
 *     percentile(last_1h):p95:stockbook.edgar.detect_latency_seconds{…}
 *
 * `percentile(…)` / `pNN:` is how Datadog addresses a DISTRIBUTION. outcome.py
 * emits `statsd.histogram(...)` — wire packet `…:12.5|h|`, DogStatsD type `h`.
 * The Agent aggregates a histogram client-side into `.avg`, `.count`,
 * `.median`, `.max` and `.95percentile` and ships THOSE; the base name is never
 * a percentile-queryable series. Name-correct, type-wrong, permanently empty,
 * and indistinguishable from "nothing has been slow" from the outside.
 *
 * So the type is read out of the code that emits it — Python AND TypeScript,
 * because the monitors span both — and matched against the form of every query
 * that names it. A name check alone provably cannot see this defect; it sat
 * next to one for a release.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** How a metric reaches Datadog. The thing that decides what may query it. */
type EmitType = "counter" | "gauge" | "histogram" | "distribution" | "timing";

const PY_EMIT_TO_TYPE: Record<string, EmitType> = {
  increment: "counter",
  decrement: "counter",
  gauge: "gauge",
  histogram: "histogram",
  distribution: "distribution",
  timing: "timing",
};

/**
 * Every metric this repo emits, mapped to the call that emits it.
 *
 * Read out of the SOURCE both sides, never restated. A hand-kept table here
 * would be a third spelling of the same fact, which is the drift this whole
 * file exists to prevent.
 */
function emittedMetricTypes(): Map<string, EmitType> {
  const types = new Map<string, EmitType>();

  // ── Python (services/us-fundamentals) ────────────────────────────────────
  // `NAME = settings.METRIC_PREFIX + "x.y"` gives the series; `statsd.<m>(NAME`
  // gives the type. Two passes because the constant and its emit site are ~80
  // lines apart, and the emit site is the only place the type is stated.
  const py = readFileSync(
    join(ROOT, "services", "us-fundamentals", "app", "store", "outcome.py"),
    "utf8",
  );
  const pyNames = new Map<string, string>();
  for (const m of py.matchAll(
    /^([A-Z][A-Z0-9_]*)\s*=\s*settings\.METRIC_PREFIX\s*\+\s*"([^"]+)"/gm,
  )) {
    pyNames.set(m[1]!, `${METRIC_PREFIX}${m[2]!}`);
  }
  for (const m of py.matchAll(/statsd\.(\w+)\(\s*([A-Z][A-Z0-9_]*)\s*,/g)) {
    const name = pyNames.get(m[2]!);
    const type = PY_EMIT_TO_TYPE[m[1]!];
    if (name && type) types.set(name, type);
  }

  // ── TypeScript (packages/datadog) ────────────────────────────────────────
  // `incrementCounter(JOB_METRICS.<key>, …)`. The emitted name comes from the
  // imported EMITTED_JOB_METRICS rather than from a regex, so the prefix is the
  // real one rather than a second copy of it.
  const ts = readFileSync(
    join(ROOT, "packages/datadog/src/job-outcome.ts"),
    "utf8",
  );
  for (const m of ts.matchAll(
    /incrementCounter\(\s*\n?\s*JOB_METRICS\.(\w+)\s*,/g,
  )) {
    const key = m[1]! as keyof typeof EMITTED_JOB_METRICS;
    if (key in EMITTED_JOB_METRICS)
      types.set(EMITTED_JOB_METRICS[key], "counter");
  }

  // ── TypeScript (scripts/jobs/databento-*) ────────────────────────────────
  // MONEY-1373. Same rule as the pass above and for the same reason: the emit
  // SITE states the type, and the name comes from the imported constant rather
  // than from a regex, so the prefix is the real one. Both call forms are read
  // — `incrementCounter` is a counter, `gauge` is a gauge — because
  // `spend_usd` is deliberately a LEVEL (a running monthly total incremented
  // once per run would sum the same month over and over), and a scan that saw
  // only one form would type it wrong and pass the wrong query shape.
  for (const file of ["databento-harvest.ts", "databento-append.ts"]) {
    let src: string;
    try {
      src = readFileSync(join(ROOT, "scripts", "jobs", file), "utf8");
    } catch {
      continue;
    }
    for (const [fn, type] of [
      ["incrementCounter", "counter"],
      ["gauge", "gauge"],
    ] as const) {
      for (const m of src.matchAll(
        new RegExp(
          `\\b${fn}\\(\\s*\\n?\\s*DATABENTO_METRICS\\.(\\w+)\\s*,`,
          "g",
        ),
      )) {
        const key = m[1]! as keyof typeof EMITTED_DATABENTO_METRICS;
        if (key in EMITTED_DATABENTO_METRICS)
          types.set(EMITTED_DATABENTO_METRICS[key], type);
      }
    }
  }

  return types;
}

const EMIT_TYPES = emittedMetricTypes();

/** How a query reads one metric occurrence. */
type Access = "bare" | "submetric" | "as_count";

/** The Agent's histogram sub-metrics: `histogram_aggregates` + `histogram_percentiles`. */
const HISTOGRAM_SUBMETRIC =
  /^\.(?:avg|count|median|max|min|sum|\d{1,2}percentile)\b/;

interface Reference {
  metric: string;
  type: EmitType;
  access: Access;
  at: number;
}

/**
 * Every emitted metric a query names, and how it addresses each one.
 *
 * Longest name first so `stockbook.job.selected` is not shadowed by a shorter
 * name that prefixes it, and every OCCURRENCE is returned — the zero-write
 * query names two metrics and would otherwise be checked as if it named one.
 */
function referencesIn(query: string): Reference[] {
  const found: Reference[] = [];
  const names = [...EMIT_TYPES.keys()].sort((a, b) => b.length - a.length);
  const claimed: Array<[number, number]> = [];
  for (const metric of names) {
    let from = 0;
    for (;;) {
      const at = query.indexOf(metric, from);
      if (at === -1) break;
      from = at + metric.length;
      // A longer name already covering this span wins; skip the sub-match.
      if (claimed.some(([s, e]) => at >= s && at < e)) continue;
      claimed.push([at, from]);
      const tail = query.slice(from);
      const access: Access = HISTOGRAM_SUBMETRIC.test(tail)
        ? "submetric"
        : /^\{[^}]*\}\.as_count\(\)/.test(tail)
          ? "as_count"
          : "bare";
      found.push({ metric, type: EMIT_TYPES.get(metric)!, access, at });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

describe("MONEY-979 — a monitor's query FORM matches the metric's EMIT TYPE", () => {
  it("[meta] the emit types were read from both languages", () => {
    // FALSIFIABLE CEILING. Either regex silently matching nothing makes every
    // loop below vacuous — the shadow-assertion failure mode this file's header
    // is about, rebuilt one layer up.
    assert.ok(
      EMIT_TYPES.size >= 5,
      `parsed ${EMIT_TYPES.size} emitted metrics; expected >= 5 (four job ` +
        "counters + the detect-latency histogram). The emit sites moved and " +
        "this check is no longer reading them.",
    );
    assert.equal(
      EMIT_TYPES.get(EMITTED_JOB_METRICS.written),
      "counter",
      "the TypeScript half did not parse",
    );
    assert.equal(
      EMIT_TYPES.get(`${METRIC_PREFIX}edgar.detect_latency_seconds`),
      "histogram",
      "the Python half did not parse",
    );
  });

  it("every rendered query names at least one metric we actually emit", () => {
    for (const body of [...RENDERED_PROD, ...RENDERED_QA]) {
      assert.ok(
        referencesIn(body.query).length > 0,
        `${body.name} queries no metric this repo emits: ${body.query}`,
      );
    }
  });

  it("the form each query uses is legal for the type it queries", () => {
    /**
     * THE RULE, stated once and applied to every monitor:
     *
     *   counter       must be read with `.as_count()`, never as a percentile.
     *                 `sum(last_36h)` of a counter WITHOUT it is a rate
     *                 average, which can round a small run to a value that
     *                 clamps wrong.
     *   histogram     its percentiles are AGENT SUB-METRICS (`.95percentile`).
     *                 `percentile(…)`/`pNN:` on the base name resolves to
     *                 nothing — the MONEY-979 defect, verbatim.
     *   distribution  the opposite: percentiles come from `percentile(…):pNN:`
     *                 on the BARE name, and there are no `.NNpercentile`
     *                 sub-metrics to address.
     *   gauge         bare, no percentile.
     */
    for (const body of [...RENDERED_PROD, ...RENDERED_QA]) {
      const distributionForm =
        /(?:^|[\s(])percentile\(|:p(?:50|75|80|90|95|98|99):/.test(body.query);
      for (const ref of referencesIn(body.query)) {
        const where = `${body.name}\n  query: ${body.query}\n  metric: ${ref.metric} (emitted as a ${ref.type})`;

        if (ref.type === "counter") {
          assert.equal(
            ref.access,
            "as_count",
            `${where}\n  A counter must be read with .as_count().`,
          );
          assert.equal(
            distributionForm,
            false,
            `${where}\n  A counter has no percentile.`,
          );
          continue;
        }

        if (ref.type === "histogram") {
          assert.equal(
            distributionForm,
            false,
            `${where}\n  percentile(…)/pNN: is the DISTRIBUTION form. A ` +
              "DogStatsD histogram sends |h|; the Agent aggregates it into " +
              `${ref.metric}.avg / .count / .median / .max / .95percentile and ` +
              "the BASE name is not percentile-queryable. Query the " +
              "sub-metric, or change the emit to statsd.distribution() — and " +
              "read monitor-latency-p95.json's _query_form_rationale first, " +
              "because that switch also needs percentile aggregation enabled " +
              "in the Datadog org before pNN: resolves.",
          );
          if (isLatencyBody(body as RenderedMonitor)) {
            assert.match(
              body.query.slice(ref.at + ref.metric.length),
              /^\.\d{1,2}percentile\b/,
              `${where}\n  A percentile monitor over a histogram must address ` +
                "the Agent's .NNpercentile sub-metric.",
            );
          }
          continue;
        }

        if (ref.type === "distribution") {
          assert.equal(
            ref.access,
            "bare",
            `${where}\n  A distribution has no Agent-computed sub-metrics — ` +
              "there is no .95percentile series to query. Use " +
              "percentile(last_…):p95: on the bare name.",
          );
          if (isLatencyBody(body as RenderedMonitor)) {
            assert.equal(
              distributionForm,
              true,
              `${where}\n  A percentile of a distribution is spelled ` +
                "percentile(last_…):p95:.",
            );
          }
          continue;
        }

        assert.equal(
          distributionForm,
          false,
          `${where}\n  A ${ref.type} has no percentile.`,
        );
      }
    }
  });
});

describe("MONEY-979 — every monitor's message actually ROUTES somewhere", () => {
  /**
   * Datadog routes a notification on an `@handle` DIRECTIVE inside the message
   * body. `monitor-latency-p95.json` ended `\n{{notify}}` — no `@` — so the
   * rendered message was `…edgar-engine.md\ndeepshaswat@gmail.com` and the
   * handle was ordinary prose. The monitor could trigger and notify nobody, and
   * nothing asserted otherwise; `monitor-zero-write.json` has always ended
   * `@{{notify}}`, so the two templates disagreed on the one character that
   * does the work.
   *
   * Worth its own check rather than a fixed string in the latency block,
   * because the defect is per-TEMPLATE and the next template starts from a
   * copy of one of these two.
   */
  const NOTIFY_DEFAULT = (() => {
    const m = /NOTIFY="\$\{DD_NOTIFY:-([^}"]+)\}"/.exec(SCRIPT_SRC);
    assert.ok(m, "could not read the NOTIFY default out of apply-monitors.sh");
    return m[1]!;
  })();

  it("[meta] the handle was parsed and it is in the rendered output", () => {
    // FALSIFIABLE CEILING: a handle that appears in no message would make the
    // per-occurrence loop below iterate zero times and pass.
    assert.ok(NOTIFY_DEFAULT.length > 0);
    const carrying = [...RENDERED_PROD, ...RENDERED_QA].filter((m) =>
      m.message.includes(NOTIFY_DEFAULT),
    );
    assert.equal(
      carrying.length,
      RENDERED_PROD.length + RENDERED_QA.length,
      `${RENDERED_PROD.length + RENDERED_QA.length - carrying.length} rendered ` +
        `monitor(s) do not mention "${NOTIFY_DEFAULT}" at all — they notify ` +
        "nobody by omission rather than by syntax",
    );
  });

  it("every occurrence of the handle is an @directive, not prose", () => {
    for (const body of [...RENDERED_PROD, ...RENDERED_QA]) {
      let from = 0;
      let seen = 0;
      for (;;) {
        const at = body.message.indexOf(NOTIFY_DEFAULT, from);
        if (at === -1) break;
        from = at + NOTIFY_DEFAULT.length;
        seen += 1;
        assert.equal(
          body.message[at - 1],
          "@",
          `${body.name} names "${NOTIFY_DEFAULT}" with no leading @, so ` +
            "Datadog reads it as message TEXT and routes nothing. Message " +
            `tail: ${JSON.stringify(body.message.slice(-70))}`,
        );
      }
      assert.ok(seen > 0, `${body.name} carries no notification handle`);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * MONEY-1229 — the qa kill-switch is load-bearing, so it is asserted.
 *
 * QA monitoring is OFF by founder decision (`dd_qa_monitoring_enabled` in
 * lib-datadog.sh, default `off`). QA runs a subset of the schedules over data
 * copied down from prod, so a qa monitor either duplicates a prod alarm or
 * watches a job qa never runs — and the second kind pages at 03:00 about
 * nothing, which is how a channel gets ignored.
 *
 * This block exists BECAUSE `render()` turns the switch back on for every qa
 * render in this file. That is the right call — the qa rendering logic still
 * deserves coverage — but it means nothing else here ever runs the script in
 * its SHIPPED configuration, so deleting the guard would change no other
 * assertion in the suite.
 *
 * BOTH directions are asserted. A switch that cannot be moved back is not a
 * switch, and a case that only checked the refusal would score "qa monitoring
 * can never be re-enabled" as a pass.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("MONEY-1229 — the qa kill-switch", () => {
  /** The real script, with DD_QA_MONITORING set to exactly `value` (or unset). */
  function runWithSwitch(
    env: "prod" | "qa",
    value: string | undefined,
    dryRun = true,
  ): { status: number | null; stdout: string; bodies: number } {
    const childEnv = { ...process.env };
    delete childEnv.DD_API_KEY;
    delete childEnv.DD_APP_KEY;
    delete childEnv.DD_NOTIFY;
    delete childEnv.DD_QA_MONITORING;
    const res = spawnSync(
      "bash",
      [SCRIPT, env, ...(dryRun ? ["--dry-run"] : [])],
      {
        encoding: "utf8",
        cwd: ROOT,
        env: {
          ...childEnv,
          ...(value === undefined ? {} : { DD_QA_MONITORING: value }),
          PATH: `${NO_NET}:${childEnv.PATH ?? ""}`,
          STUB_LOG: NO_NET_LOG,
        },
      },
    );
    const stdout = res.stdout ?? "";
    return {
      status: res.status,
      stdout,
      bodies: stdout.split("\n").filter((l) => l.startsWith("  {")).length,
    };
  }

  it("qa renders NOTHING while the switch is off, and SAYS so", () => {
    // Exit 0, not 1: this is a configured state, and a non-zero exit would make
    // the cutover runner report a failure. Which makes the MESSAGE the only
    // thing separating "deliberately disabled" from "ran and found no work" —
    // the exact ambiguity this whole directory exists to remove — so it is
    // asserted rather than assumed, along with the way back.
    //
    // The comparison is against the LITERAL string "on". Every other value is
    // off, including the ones a reader would expect to arm it: this repo has
    // shipped `Boolean("false")` arming a job in the one configuration meant to
    // keep it off, and the same class inverted would be `[[ -n "$X" ]]` arming
    // it on any value at all.
    for (const value of [undefined, "off", "", "true", "1", "ON", "yes"]) {
      const run = runWithSwitch("qa", value);
      const label = value === undefined ? "(unset)" : JSON.stringify(value);
      assert.equal(run.status, 0, `DD_QA_MONITORING=${label} exited nonzero`);
      assert.equal(
        run.bodies,
        0,
        `DD_QA_MONITORING=${label} rendered ${run.bodies} qa monitors`,
      );
      assert.match(run.stdout, /qa monitoring is disabled/);
      assert.match(run.stdout, /DD_QA_MONITORING=on/);
    }
  });

  it("DD_QA_MONITORING=on renders the qa estate again", () => {
    // The reversal, and the floor that stops the case above from passing
    // because the script is broken for qa in every configuration.
    const run = runWithSwitch("qa", "on");
    assert.equal(run.status, 0);
    assert.ok(
      run.bodies >= 12,
      `qa rendered only ${run.bodies} with the switch on`,
    );
    assert.equal(
      run.bodies,
      RENDERED_QA.length,
      "the qa estate this file asserts over is not what the switch restores",
    );
  });

  it("never gates prod, and refuses BEFORE it needs credentials", () => {
    // Two failure modes of a guard placed wrong, and neither shows up in a qa
    // render. Gating on the switch alone rather than on `ENV_ARG == qa` would
    // silently stop provisioning PROD, which is the estate that pages anyone.
    const prod = runWithSwitch("prod", undefined);
    assert.equal(prod.status, 0);
    assert.equal(
      prod.bodies,
      RENDERED_PROD.length,
      "prod rendered a different set with DD_QA_MONITORING unset",
    );

    // And the guard sits ahead of the `:?` credential expansions, so the real
    // (non-dry-run) call the cutover runner makes exits 0 with no keys and no
    // request — rather than dying on a missing DD_API_KEY it never needed.
    const live = runWithSwitch("qa", undefined, false);
    assert.equal(
      live.status,
      0,
      "a live qa run demanded credentials to do nothing",
    );
    assert.match(live.stdout, /qa monitoring is disabled/);
    assert.equal(
      readFileSync(NO_NET_LOG, "utf8"),
      "",
      "the disabled qa path reached curl",
    );
  });
});

describe("MONEY-979 — the dry-run renders cannot reach the network", () => {
  it("no curl invocation was made while rendering every monitor", () => {
    // Every `render()` above ran with a logging, non-zero-exit `curl` first on
    // PATH. This asserts the property the file depends on — "the dry run is
    // offline" — instead of trusting the shell branch that provides it. See the
    // NO_NET comment: breaking that branch made these renders issue live
    // Datadog requests, from a green suite.
    assert.equal(
      readFileSync(NO_NET_LOG, "utf8"),
      "",
      "apply-monitors.sh --dry-run invoked curl. A dry run must not reach " +
        "the Datadog API, and CI exports DD_API_KEY/DD_APP_KEY.",
    );
  });
});

/**
 * The FOURTH template (MONEY-1373) — the Databento D1 tripwire.
 *
 * A fourth QUESTION, not a fourth variation. The three above all ask something
 * about a JOB — did it write what it selected, how long did it take, did it run
 * at all — and all three are sized against a cron. This one asks about the
 * DATA: has any Databento writer ever displaced a DAILY session. The healthy
 * answer is a permanent, literal zero, because `DATABENTO_SCHEMAS` (the Zod
 * enum the manifest is parsed against) has no `ohlcv-1d` member, so no manifest
 * entry can name a daily schema and no harvest or append can produce a daily
 * bar.
 *
 * That is exactly what makes it the most dangerous monitor in the directory to
 * get wrong. Every other monitor here announces a broken name by going quiet
 * where data is expected. This one EXPECTS quiet. A misspelled metric renders
 * as permanent NO DATA and reads, correctly and forever, as "the tripwire has
 * never tripped" — so the name is the whole of the agreement, and it is checked
 * against the constant the emitters import rather than against a second copy of
 * the string.
 */
describe("MONEY-1373 — the Databento D1 tripwire and the emitting code agree", () => {
  it("[meta] a d1 monitor is declared and rendered", () => {
    // Guards both assertions below. A parse that yields [] makes each loop
    // vacuous and this block would pass while asserting nothing — the shadow
    // failure mode this whole file exists to reject.
    assert.ok(
      D1_JOBS.length > 0,
      "D1_MONITORS is empty — every assertion below would be vacuous",
    );
    assert.equal(
      PROD_D1.length,
      D1_JOBS.length,
      "one rendered d1 monitor per D1_MONITORS row",
    );
  });

  it("queries the metric the emitters emit, by CONSTANT and not by retyping", () => {
    // MONEY-1238 fault (a), in the one template where it would be invisible.
    //
    // WHOLE-TOKEN equality, never `includes`: the bare `databento.displaced_d1`
    // is a SUBSTRING of the prefixed `stockbook.databento.displaced_d1`, so a
    // containment test passes identically whether the prefix is there or not.
    // That exact substring test is what let the original defect ship, and the
    // assertion that was supposed to catch it read as a real check for a
    // release.
    const expected = `${METRIC_PREFIX}${DATABENTO_METRICS.displacedD1}`;
    // …and the imported derived constant must BE that, or the comparison below
    // is one wrong value against another wrong value.
    assert.equal(EMITTED_DATABENTO_METRICS.displacedD1, expected);
    assert.notEqual(
      EMITTED_DATABENTO_METRICS.displacedD1,
      DATABENTO_METRICS.displacedD1,
      "the prefix vanished, so every name check here would pass for the wrong " +
        "reason",
    );

    for (const body of PROD_D1) {
      const named = /sum:([A-Za-z0-9_.]+)\{/.exec(body.query)?.[1];
      assert.equal(
        named,
        expected,
        `${body.name} queries "${named ?? "(no metric)"}" but the emitters ` +
          `emit "${expected}". A wrong name here renders as permanent NO DATA, ` +
          "which on a tripwire is indistinguishable from health.",
      );
      // The threshold has to agree with the query or Datadog refuses the whole
      // monitor, and `> 0` is the entire condition — there is nothing to tune.
      assert.match(body.query, />\s*0$/, `${body.name} must alert on > 0`);
      assert.equal(body.options.thresholds.critical, 0);
    }
  });

  it("neither job re-types a metric name the constant already spells", () => {
    // The regression this module was created to prevent, asserted rather than
    // asked for. `databento-append.ts` emitted `databento.displaced_sessions`
    // while every other reader of that number called it `sessions_displaced`,
    // and NOTHING failed — a metric name is only ever compared to itself by a
    // human, so the two spellings simply became two series, one with a monitor
    // pointed at it and one with the data.
    //
    // Only `displaced_d1` is protected by the name check above, and only
    // because a monitor happens to query it. The other six are protected by
    // this: a string literal starting `"databento.` inside either emitter is a
    // second spelling by construction, wherever it is used.
    for (const file of ["databento-harvest.ts", "databento-append.ts"]) {
      const src = readFileSync(join(ROOT, "scripts", "jobs", file), "utf8");
      const literals = [...src.matchAll(/"databento\.[a-z0-9_]+"/g)].map(
        (m) => m[0],
      );
      assert.deepEqual(
        literals,
        [],
        `scripts/jobs/${file} spells a Databento metric name inline: ` +
          `${literals.join(", ")}. Use DATABENTO_METRICS — a literal here and ` +
          "the constant in databento-metrics.ts are two spellings of one fact, " +
          "and they have already disagreed once.",
      );
    }
    // FALSIFIABLE FLOOR: the assertion above is also satisfied by a file that
    // does not exist or that emits nothing at all.
    for (const file of ["databento-harvest.ts", "databento-append.ts"]) {
      const src = readFileSync(join(ROOT, "scripts", "jobs", file), "utf8");
      assert.match(
        src,
        /DATABENTO_METRICS\./,
        `scripts/jobs/${file} emits no Databento metric at all`,
      );
    }
  });

  it("[meta] the gap simulation can size databento-append at all", () => {
    // WITHOUT THIS THE TWO WINDOW RULES BELOW ARE VACUOUS, and silently so.
    // `databento-append`'s triggers are created by
    // `setup_edgar_bulk_job_schedulers` — a generic FUNCTION taking the crons
    // as arguments — so it has no SCHEDULER_DEFS row and no `schedule_job_run`
    // call, and `cronsForJob`'s first three lookups all return nothing. A
    // fourth lookup reads `DATABENTO_APPEND_SCHEDULE_{PRIMARY,RETRY}`; if that
    // ever stops matching, `simulableGapHours` answers null and both rules
    // below would compare a window against nothing.
    const crons = cronsForJob("databento-append");
    assert.deepEqual(
      crons.sort(),
      ["0 15 * * 2-6", "0 18 * * 2-6"],
      "the cron lookup no longer reads databento-append's two triggers",
    );
    // TUE-SAT, so the longest gap is SATURDAY 18:00 -> TUESDAY 15:00: 6h to
    // Sunday 00:00 is not how it decomposes — Sat 18:00 -> Tue 18:00 is 72h,
    // less the 3h the Tuesday PRIMARY run arrives early = 69h. Asserted as a
    // number rather than described, because every window below is sized from it
    // and a calculator nothing checks can be quietly wrong.
    assert.equal(maxGapHours(crons), 69);
  });

  it("databento-append's ABSENCE window exceeds its longest cron gap", () => {
    // The rule this file enforces for every other absence row, asserted by
    // NAME as well so a regression in the generic loop cannot hide it. A window
    // under the real gap goes below threshold on a perfectly healthy schedule —
    // and for THIS job that is every Sunday and Monday, because its crons are
    // Tue-Sat.
    const row = ABSENCE_JOBS.find((j) => j.job === "databento-append");
    assert.ok(row, "databento-append has no ABSENCE_MONITORS row");
    const m = /^(\d+)([hd])$/.exec(row.window);
    assert.ok(m, `unparsable absence window "${row.window}"`);
    const hours = Number(m[1]) * (m[2] === "d" ? 24 : 1);
    const gap = simulableGapHours("databento-append");
    assert.equal(typeof gap, "number", "the gap simulation refused to answer");
    assert.ok(
      hours > gap!,
      `the absence window is ${hours}h but runs can legitimately be ${gap}h ` +
        "apart, so this monitor would fire on a healthy schedule",
    );
  });

  it("…and so does its ZERO-WRITE window", () => {
    // Same rule, other list. Both are needed: they are sized independently (the
    // absence window also has to clear the longest legitimate stretch with
    // `selected == 0`, which for this job is a whole run of UP_TO_DATE
    // evenings), and this repo has shipped a window under the gap three times
    // — bhavcopy-sync, feed-parse and xbrl-ratios — each time in a list where
    // the sibling rule was already being applied by hand.
    const row = JOBS.find((j) => j.job === "databento-append");
    assert.ok(row, "databento-append has no MONITORED_JOBS row");
    const m = /^(\d+)([hd])$/.exec(row.window);
    assert.ok(m, `unparsable zero-write window "${row.window}"`);
    const hours = Number(m[1]) * (m[2] === "d" ? 24 : 1);
    const gap = simulableGapHours("databento-append");
    assert.equal(typeof gap, "number", "the gap simulation refused to answer");
    assert.ok(
      hours > gap!,
      `the zero-write window is ${hours}h but runs can legitimately be ` +
        `${gap}h apart, so the monitor sits in NO DATA on a healthy schedule`,
    );
  });
});
