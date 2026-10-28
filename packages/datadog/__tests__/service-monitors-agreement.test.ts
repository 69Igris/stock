/**
 * MONEY-1359 — the service-level monitors say what they mean, and reach nobody
 * they should not.
 *
 * ## Why this file exists separately from monitor-agreement.test.ts
 *
 * That one guards the JOB monitors, whose whole subject is a metric this repo
 * emits — so its strongest assertions are about the series name matching the
 * emitter. These monitors read series we do NOT emit: `trace.*` comes from
 * dd-trace, log events come from the intake pipeline, RUM events from the
 * browser SDK. There is no local constant to compare a query against.
 *
 * What can still be checked, and is:
 *
 *   - Every body is well formed and fully substituted. `dd_render` throws on an
 *     unknown placeholder, but a template that simply never NAMES a placeholder
 *     renders fine and silently drops the value — a `{{service}}` missing from
 *     a query is a monitor watching the whole org.
 *   - Every message ROUTES. The `@` before the handle is the entire mechanism;
 *     a bare handle is text, and monitor-latency-p95.json shipped exactly that
 *     for a release — it triggered and notified nobody.
 *   - `notify_no_data` matches the family. This is the one option in the set
 *     that is a judgement rather than a fact, and it is wrong in both
 *     directions: TRUE on a series that is legitimately empty pages on a
 *     healthy night, FALSE on the singleton socket holder throws away the only
 *     signal that says the process died.
 *   - The script fails CLOSED. `curl` exits 0 on a 403, so a run that cannot
 *     list must abort rather than POST a duplicate of every monitor.
 *
 * The renders are driven by SPAWNING THE REAL SCRIPT, so the chain under test
 * is template -> lib-datadog.sh -> substitution -> body. Anything a reviewer
 * could get wrong in the middle of that shows up here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DD_SERVER_SPAN, DD_SERVICES } from "../src/constants";

/** A service's declared SERVER span (MONEY-1534), or undefined when it has none. */
const spanOf = (service: string): string | undefined =>
  (DD_SERVER_SPAN as Record<string, string | undefined>)[service];

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(ROOT, "scripts/ops/datadog/apply-service-monitors.sh");
const LIB = join(ROOT, "scripts/ops/datadog/lib-datadog.sh");
const SCRIPT_SRC = readFileSync(SCRIPT, "utf8");

interface Rendered {
  name: string;
  type: string;
  query: string;
  message: string;
  tags: string[];
  options: {
    notify_no_data: boolean;
    no_data_timeframe?: number;
    thresholds: Record<string, number>;
    enable_logs_sample?: boolean;
  };
}

/**
 * A `curl` that cannot reach the network, first on PATH for every dry-run.
 *
 * `--dry-run` is a BRANCH in a shell script, and this repo has shipped two bugs
 * in exactly that branch. The guarantee is therefore moved off the branch and
 * onto the process: no credentials, and a `curl` that logs and exits non-zero.
 * The log is asserted empty below, so "the dry run is offline" is a checked
 * property rather than a comment.
 */
const NO_NET = mkdtempSync(join(tmpdir(), "svc-monitors-offline-"));
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

function render(env: "prod" | "qa"): Rendered[] {
  const childEnv = { ...process.env };
  delete childEnv.DD_API_KEY;
  delete childEnv.DD_APP_KEY;
  delete childEnv.DD_NOTIFY;
  // Stripped, then set explicitly for qa. QA monitoring ships OFF (founder
  // decision — `dd_qa_monitoring_enabled` in lib-datadog.sh), so an unset
  // switch makes `apply-service-monitors.sh qa` exit 0 rendering nothing and
  // every qa assertion below would iterate an empty array and pass. The switch
  // itself is asserted in "MONEY-1229 — the qa kill-switch"; letting it come
  // from the ambient shell would make these renders depend on the developer's
  // environment, which is the DD_NOTIFY argument one variable over.
  delete childEnv.DD_QA_MONITORING;
  const out = execFileSync("bash", [SCRIPT, env, "--dry-run"], {
    encoding: "utf8",
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
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Rendered);
}

/**
 * Run the REAL script against a stubbed curl and report what curl saw.
 *
 * TWO bodies, because this script makes two KINDS of read and they need
 * different shapes: the managed-monitor listing must be a JSON ARRAY, and every
 * preflight is an object carrying `series` or `data`. A single stub body cannot
 * satisfy both, and answering the listing with a preflight object makes the
 * script abort on "not a JSON array" — which looks exactly like the fail-closed
 * behaviour under test and would have made these cases pass for the wrong
 * reason.
 */
function runWithStubbedCurl(
  listingBody: string,
  preflightBody: string,
  status = "200",
  writeStatus = status,
  /**
   * Serve garbage to RUM searches AFTER this many have succeeded.
   *
   * The `rum-lcp` row hits `/api/v2/rum/events/search` TWICE — once for the
   * preflight and once for `report_lcp_magnitude` — so a single stub body
   * cannot make the second fail while the first passes, and the diagnostic's
   * failure path is unreachable without counting.
   */
  poisonRumSearchAfter = 0,
  /** Appended after `prod`. Defaults to nothing, so every existing call is a
   *  plain live run and only the `--only=verify` cases opt in. */
  extraArgs: string[] = [],
): { code: number; stderr: string; stdout: string; curlLog: string } {
  const dir = mkdtempSync(join(tmpdir(), "svc-monitors-"));
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
        "# The monitor endpoint answers the listing and the writes; everything",
        "# else on this host is a preflight (a metric query or an events search).",
        'case "$*" in',
        '  *"/api/v1/monitor"*|*"/api/v1/monitor/"*)',
        '    body="$STUB_LISTING_BODY"',
        '    case "$*" in',
        '      *"-X GET"*) status="$STUB_STATUS" ;;',
        '      *) status="$STUB_WRITE_STATUS" ;;',
        "    esac",
        "    ;;",
        '  *"/api/v2/rum/events/search"*)',
        '    n=$(cat "$STUB_RUM_COUNT" 2>/dev/null || echo 0); n=$((n + 1))',
        '    printf "%s" "$n" > "$STUB_RUM_COUNT"',
        '    if [ -n "$STUB_POISON_RUM_AFTER" ] && [ "$n" -gt "$STUB_POISON_RUM_AFTER" ]; then',
        '      body="<html>gateway error</html>"',
        "    else",
        '      body="$STUB_PREFLIGHT_BODY"',
        "    fi",
        '    status="$STUB_STATUS"',
        "    ;;",
        '  *) body="$STUB_PREFLIGHT_BODY"; status="$STUB_STATUS" ;;',
        "esac",
        'printf "%s\\n%s\\n" "$body" "$status"',
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
        STUB_LISTING_BODY: listingBody,
        STUB_PREFLIGHT_BODY: preflightBody,
        STUB_STATUS: status,
        STUB_WRITE_STATUS: writeStatus,
        STUB_RUM_COUNT: join(dir, "rum.count"),
        STUB_POISON_RUM_AFTER: poisonRumSearchAfter
          ? String(poisonRumSearchAfter)
          : "",
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

/**
 * Calls to the MONITOR endpoint specifically, by method.
 *
 * A bare method count cannot express "the script listed once" or "the row was
 * not written", because this script reads two OTHER endpoints with the same two
 * verbs: the metric preflight is `GET /api/v1/query` and the log/RUM preflights
 * are `POST .../events/search`. Counting the verb alone mixes reads of
 * somebody else's series in with writes of ours — which is how "one listing per
 * run" reads as six, and how a created monitor could hide inside a POST count
 * that the preflights already inflate.
 */
const countMonitorCalls = (curlLog: string, method: string): number =>
  curlLog
    .split("\n")
    .filter((l) => l.includes(`-X ${method} `) && l.includes("/api/v1/monitor"))
    .length;

const familyOf = (m: Rendered): string =>
  m.tags.find((t) => t.startsWith("family:"))?.slice("family:".length) ??
  "(none)";

/**
 * The script's own ROW table, all five fields.
 *
 * Parsed rather than restated: a second copy of this list in the test would
 * agree with the script only until somebody edits one of them, and the
 * assertions below are about the AGREEMENT between the table and what it
 * renders — which a restated copy cannot see at all.
 */
interface Row {
  tpl: string;
  service: string;
  threshold: string;
  envs: string[];
  kind: string;
}
const ROWS: Row[] = [
  ...SCRIPT_SRC.matchAll(
    /^\s+"([a-z0-9-]+\.json)\|([a-z0-9-]*)\|([0-9]*)\|([a-z,]+)\|([a-z-]+)"$/gm,
  ),
].map((m) => ({
  tpl: m[1]!,
  service: m[2]!,
  threshold: m[3]!,
  envs: m[4]!.split(","),
  kind: m[5]!,
}));

/**
 * The BODY of each `case "$KIND" in` branch, keyed by every label that reaches
 * it (labels can be alternations — `rum|rum-lcp)`).
 *
 * Parsed so a row's preflight can be compared against the series its own
 * MONITOR queries. A row pointed at the wrong branch is invisible from every
 * other angle in this file: it renders correctly, it is fully substituted, it
 * carries the right tags, and its preflight PASSES — against somebody else's
 * series.
 */
const CASE_BODY = new Map<string, string>();
{
  let labels: string[] = [];
  let body: string[] | null = null;
  const close = () => {
    if (body) for (const l of labels) CASE_BODY.set(l, body.join("\n"));
    body = null;
    labels = [];
  };
  for (const line of SCRIPT_SRC.split("\n")) {
    const m = /^ {4}([a-z|*-]+)\)$/.exec(line);
    if (m) {
      close();
      labels = m[1]!.split("|");
      body = [];
      continue;
    }
    if (/^\s*esac$/.test(line)) close();
    else body?.push(line);
  }
}

const PROD = render("prod");
const QA = render("qa");

describe("MONEY-1359 — the service monitors render correctly", () => {
  it("PREMISE: both environments rendered something to assert on", () => {
    // Without a floor, every assertion below passes over an empty array — the
    // shape where a spawn silently produces nothing and the suite reports green.
    assert.ok(PROD.length >= 12, `prod rendered ${PROD.length}`);
    assert.ok(QA.length >= 9, `qa rendered ${QA.length}`);
  });

  it("PREMISE: the dry-run renders made no HTTP call", () => {
    assert.equal(
      readFileSync(NO_NET_LOG, "utf8"),
      "",
      "a --dry-run reached curl; it must never touch the Datadog API",
    );
  });

  it("QA renders FEWER — the RUM rows are prod-only", () => {
    // Asserted as an exact difference rather than `QA.length < PROD.length`,
    // which a script that skipped everything would also satisfy.
    const prodFamilies = PROD.map(familyOf).sort();
    const qaFamilies = QA.map(familyOf).sort();
    assert.ok(prodFamilies.includes("rum-errors"));
    assert.ok(prodFamilies.includes("rum-lcp"));
    assert.ok(
      !qaFamilies.includes("rum-errors") && !qaFamilies.includes("rum-lcp"),
      "QA's web app has essentially no human traffic, so a RUM monitor there " +
        "sits permanently empty — the never-green monitor somebody mutes",
    );
  });

  for (const [envName, monitors] of [
    ["prod", PROD],
    ["qa", QA],
  ] as const) {
    describe(envName, () => {
      it("every body is fully substituted", () => {
        for (const m of monitors) {
          const raw = JSON.stringify(m);
          const left = raw.match(/\{\{\w+\}\}/g);
          assert.equal(left, null, `${m.name} has unsubstituted ${left}`);
        }
      });

      it("every body carries the managed tag and an env tag", () => {
        // apply-monitors.sh finds the monitor it is about to update by LISTING
        // `managed-by:apply-monitors` and matching on name. A body without the
        // tag is never in that listing, so EXISTING_ID is empty on every run
        // and every run POSTs a NEW one — two after the second run, three after
        // the third, each alerting independently. That is MONEY-1238 fault (e),
        // and monitor-latency-p95.json shipped exactly it.
        for (const m of monitors) {
          assert.ok(
            m.tags.includes("managed-by:apply-monitors"),
            `${m.name} is not discoverable by the upsert listing`,
          );
          assert.ok(
            m.tags.some((t) => t.startsWith("env:")),
            `${m.name} has no env tag`,
          );
        }
      });

      it("every message ROUTES — the @ is the mechanism", () => {
        // A bare handle renders as text and notifies nobody. The monitor
        // triggers, resolves, and no one ever knows.
        for (const m of monitors) {
          assert.match(
            m.message,
            /@[^\s@]+@[^\s@]+$/,
            `${m.name}'s message does not end in an @handle`,
          );
        }
      });

      it("every type is one Datadog accepts for its query form", () => {
        for (const m of monitors) {
          assert.ok(
            ["query alert", "log alert", "rum alert"].includes(m.type),
            `${m.name} has type "${m.type}"`,
          );
          // The query form and the type have to agree: a `logs(...)` query on a
          // `query alert` is a 400, and the reverse is a monitor that evaluates
          // against nothing.
          if (m.type === "log alert") assert.match(m.query, /^logs\(/);
          if (m.type === "rum alert") assert.match(m.query, /^rum\(/);
          if (m.type === "query alert")
            assert.doesNotMatch(m.query, /^(logs|rum)\(/);
        }
      });

      it("notify_no_data matches the family, in BOTH directions", () => {
        // The one option here that is a judgement. Wrong TRUE pages on a
        // healthy quiet night until somebody mutes the channel; wrong FALSE on
        // the singleton socket holder throws away the only signal that says the
        // process is gone.
        //
        // `default_zero()` SPLITS the rt-liveness family, and the family alone
        // could not express it — MONEY-1359 finding 1. `rt.health_ok` is a
        // gauge: an empty window goes GREY, so no-data is the only thing that
        // sees a dead process. `rt.bars_closed` is wrapped in `default_zero()`,
        // which renders an empty window as a real 0, so that monitor alerts
        // from its own threshold and needs no no-data alarm — and cannot have
        // one, because its 96h window is past Datadog's 4320-minute ceiling and
        // a 72h alarm on a series that legitimately gaps a US holiday weekend
        // fires on a healthy schedule. Its never-existed-tag case is covered at
        // apply time by the `metric-rt-bars` preflight instead.
        for (const m of monitors) {
          const family = familyOf(m);
          const evaluatesOnSilence = /\bdefault_zero\(/.test(m.query);
          const silenceIsTheSignal =
            family === "rt-liveness" &&
            m.type === "query alert" &&
            !evaluatesOnSilence;
          assert.equal(
            m.options.notify_no_data,
            silenceIsTheSignal,
            `${m.name} (family:${family}) has notify_no_data=${m.options.notify_no_data}. ` +
              (silenceIsTheSignal
                ? "tiingo-realtime is a singleton emitting every 5s from a finally, so silence means it died."
                : evaluatesOnSilence
                  ? "This query is wrapped in default_zero(), so an empty window is a real 0 and the threshold already fires."
                  : "This series is legitimately empty in a state we ship on purpose."),
          );
          if (silenceIsTheSignal) {
            assert.equal(
              typeof m.options.no_data_timeframe,
              "number",
              `${m.name} notifies on no-data with a non-numeric timeframe`,
            );
          }
          // DATADOG'S CEILING, on every body regardless of the flag — 4320
          // minutes, measured. This script has no `window_limits` clamp, so
          // whatever a template hardcodes is what gets POSTed:
          // monitor-rt-bars-absence.json carried 17280 and would have been
          // refused 400 the day its preflight started passing.
          if (m.options.no_data_timeframe !== undefined) {
            assert.ok(
              m.options.no_data_timeframe > 0 &&
                m.options.no_data_timeframe <= 4320,
              `${m.name} has no_data_timeframe ${m.options.no_data_timeframe}; ` +
                `Datadog refuses the monitor with 400 "No data timeframe must ` +
                `be <= 4320" and there is no clamp in this script`,
            );
          }
        }
      });

      it("every threshold is a NUMBER, never the string it was substituted as", () => {
        // Datadog rejects `"critical": "100"` with a 400 naming the field, which
        // is only obvious once you have seen it. The threshold arrives as a
        // placeholder string and `dd_render` coerces it back.
        for (const m of monitors) {
          for (const [k, v] of Object.entries(m.options.thresholds ?? {})) {
            assert.equal(
              typeof v,
              "number",
              `${m.name} threshold.${k} is a ${typeof v}`,
            );
          }
        }
      });
    });
  }

  it("the APM rows name a service in the QUERY, not only in the tags", () => {
    // A tag is metadata; the QUERY is what is evaluated. A row whose template
    // forgot `{{service}}` inside the query renders cleanly, carries the right
    // tags, and silently measures the error rate of the whole org.
    for (const m of PROD.filter((x) => familyOf(x) === "apm-error-rate")) {
      const service = m.tags
        .find((t) => t.startsWith("service:"))!
        .slice("service:".length);
      assert.ok(
        m.query.includes(`service:${service}`),
        `${m.name} does not scope its query to service:${service}`,
      );
    }
  });

  it("the LCP threshold is in NANOSECONDS", () => {
    // RUM view timings are stored in ns. Written in ms this is a million times
    // too small and the monitor fires on every page forever; written in the
    // wrong direction it never fires, which is invisible. 2.5s = 2.5e9.
    const lcp = PROD.find((m) => familyOf(m) === "rum-lcp");
    assert.ok(lcp, "no rum-lcp monitor rendered");
    assert.equal(lcp.options.thresholds.critical, 2_500_000_000);
    assert.match(lcp.query, /> 2500000000$/);
  });

  it("a monitor over a SHARED signal is scoped to the service its row names", () => {
    // The defect this whole file is named for, one layer in. `trace.*`, logs
    // and RUM are multi-service streams, so a query that reads one without a
    // `service:` predicate is watching the WHOLE ORG under a name that claims
    // one service — it fires on somebody else's incident and stays quiet
    // through its own. `dd_render` cannot catch it: a template that never NAMES
    // `{{service}}` renders perfectly and silently drops the value.
    //
    // The rows are joined to the renders BY POSITION, which is checked first —
    // the script emits one JSON line per applied row, in table order.
    const prodRows = ROWS.filter((r) => r.envs.includes("prod"));
    assert.equal(
      prodRows.length,
      PROD.length,
      "a row rendered nothing, or something rendered twice — the positional " +
        "join below is only meaningful when the two agree",
    );

    // `stockbook.rt.*` is emitted by ONE process, so `env:` alone already
    // identifies it; that is a property of the series, not a licence, so it is
    // decided from the query's source rather than from the row's kind.
    const SHARED = /(?:^|[(:])(?:trace\.|logs\(|rum\()/;
    let checked = 0;
    prodRows.forEach((row, i) => {
      const rendered = PROD[i]!;
      if (!row.service || !SHARED.test(rendered.query)) return;
      checked += 1;
      assert.ok(
        rendered.query.includes(`service:${row.service}`),
        `${row.tpl} names service "${row.service}" and reads a shared signal, ` +
          `but its query scopes to no service: ${rendered.query}`,
      );
    });
    assert.ok(checked >= 8, `only ${checked} rows were actually checked`);
  });

  it("every service we run is watched by at least one prod monitor", () => {
    // The floor is anchored on the SERVICES THAT EXIST, not on the row table's
    // own length. A `>= 12` count passes after a row is deleted; this does not,
    // because the thing it measures is outside the file being edited.
    const services = [...Object.values(DD_SERVICES), "us-fundamentals"];
    for (const service of services) {
      assert.ok(
        PROD.some((m) => m.query.includes(`service:${service}`)),
        `no prod monitor mentions service:${service} — it ships with no ` +
          "service-level alarm at all",
      );
    }
  });
});

describe("MONEY-1359 — the apply script fails closed", () => {
  it("aborts when the listing cannot be read, without writing anything", () => {
    // An unreadable listing read as "no monitors exist" makes the next step
    // POST a duplicate of every monitor in the set, and duplicates alert
    // independently. curl exits 0 on a 403, so only an explicit check catches it.
    const run = runWithStubbedCurl("not json at all", "{}", "200");
    assert.notEqual(run.code, 0);
    assert.equal(countCalls(run.curlLog, "POST"), 0);
    assert.equal(countCalls(run.curlLog, "PUT"), 0);
  });

  it("aborts on a 403 to the listing", () => {
    const run = runWithStubbedCurl("[]", "{}", "403");
    assert.notEqual(run.code, 0);
    assert.equal(countCalls(run.curlLog, "POST"), 0);
  });

  it("exits non-zero and NAMES the rows when a preflight finds no series", () => {
    // The whole point of the file. An empty `series`/`data` answer means the
    // monitor would be NO DATA forever, so the row is refused BY NAME rather
    // than created and hoped for.
    const run = runWithStubbedCurl("[]", '{"series":[],"data":[]}', "200");
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /did NOT apply/);
    // Each APM row names ITS OWN declared span, which is what proves every row
    // resolved it from DD_SERVER_SPAN (MONEY-1534) rather than sharing one.
    const apmRows = ROWS.filter((r) => r.kind === "metric-apm");
    assert.ok(apmRows.length >= 4, `only ${apmRows.length} APM rows parsed`);
    for (const row of apmRows) {
      assert.ok(
        run.stderr.includes(
          `monitor-apm-error-rate ${row.service}: no trace.${spanOf(row.service)}.hits points`,
        ),
        `the ${row.service} refusal does not name its declared span:\n${run.stderr}`,
      );
    }
    // Scoped to the monitor endpoint. Written against the bare verb this read
    // `POST + PUT === POST`, i.e. only `PUT === 0` — so a refused row that got
    // CREATED anyway would have satisfied it, which is the one thing the case
    // exists to catch.
    assert.equal(
      countMonitorCalls(run.curlLog, "POST") +
        countMonitorCalls(run.curlLog, "PUT"),
      0,
      "a refused row must not be written",
    );
  });

  it("CREATES when the preflights pass and nothing matches by name", () => {
    // The positive control. Without it "no writes" above would also pass if the
    // script were broken in some unrelated way — a fail-closed assertion needs
    // a demonstration that the open path works.
    const run = runWithStubbedCurl(
      "[]",
      '{"series":[{"pointlist":[[0,1]]}],"data":[{"attributes":{"attributes":{"view":{"largest_contentful_paint":1840000000}}}}]}',
      "200",
    );
    assert.equal(run.code, 0, run.stderr);
    assert.equal(
      countMonitorCalls(run.curlLog, "POST"),
      PROD.length,
      "expected exactly one CREATE per rendered monitor",
    );
    assert.equal(
      countMonitorCalls(run.curlLog, "GET"),
      1,
      "the managed set is listed ONCE per run, not once per row",
    );
    assert.equal(countMonitorCalls(run.curlLog, "PUT"), 0, "nothing to update");
  });

  it("the LCP magnitude REPORT cannot abort the run it is reporting on", () => {
    // `report_lcp_magnitude` is a diagnostic, and it is called as the last
    // command of an `&&` list under `set -euo pipefail`. Anything that exits
    // non-zero inside it therefore kills the whole apply PART WAY THROUGH —
    // after some monitors are written and before the rest — which is the
    // opposite of what a report about a threshold should ever do.
    //
    // Reachable in production: Datadog answers a 200 carrying an error
    // envelope, or a proxy returns HTML. The stub reproduces it by counting RUM
    // searches: 1 is the rum-errors preflight, 2 is the rum-lcp preflight, and
    // 3 is the diagnostic — so poisoning after 2 leaves every preflight passing
    // and hands the bad body to the report alone.
    const good =
      '{"series":[{"pointlist":[[0,1]]}],"data":[{"attributes":{"attributes":{"view":{"largest_contentful_paint":1840000000}}}}]}';
    const run = runWithStubbedCurl("[]", good, "200", "200", 2);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(
      countMonitorCalls(run.curlLog, "POST"),
      PROD.length,
      "the run stopped early — every monitor after rum-lcp went unwritten",
    );
    assert.match(
      run.stdout,
      /LCP magnitude: .*not JSON/,
      "it must SAY it could not read the sample, not fail silently",
    );
  });

  it("MONEY-1379 — --only=verify compares without writing, and NAMES the drift", () => {
    // This script UPSERTS by title and never deletes, so the estate can
    // disagree with the ROWS table in two directions and neither announces
    // itself: a deleted row leaves a live monitor still alerting (an ORPHAN),
    // and a row nobody has applied leaves the repo claiming a monitor the org
    // has never heard of (MISSING).
    //
    // The listing is built from the titles the script actually RENDERS, not
    // from a hand-written list — a restated copy agrees with the script only
    // until somebody edits one of them, which is the drift under test one layer
    // up.
    const good =
      '{"series":[{"pointlist":[[0,1]]}],"data":[{"attributes":{"attributes":{"view":{"largest_contentful_paint":1840000000}}}}]}';
    const names = PROD.map((m) => m.name);
    const listing = (ns: string[]): string =>
      JSON.stringify(ns.map((name, i) => ({ id: 3000 + i, name })));

    const inSync = runWithStubbedCurl(listing(names), good, "200", "200", 0, [
      "--only=verify",
    ]);
    assert.equal(inSync.code, 0, `verify failed: ${inSync.stderr}`);
    // Scoped to the MONITOR endpoint, for the reason `countMonitorCalls`
    // exists: every preflight here is itself a POST to `…/events/search`, so a
    // bare verb count cannot express "wrote nothing" and would fail a correct
    // run. Verify holds credentials and reads on purpose — what it must never
    // do is PUT or POST a monitor.
    assert.equal(
      countMonitorCalls(inSync.curlLog, "POST"),
      0,
      "--only=verify POSTed — a read-only check that writes is not a check",
    );
    assert.equal(countMonitorCalls(inSync.curlLog, "PUT"), 0);
    assert.match(inSync.stdout, new RegExp(`in both\\s+${names.length}\\b`));

    // …and it goes red on a real disagreement, naming the monitor. A verify
    // that only ever prints "in sync" is the mute button, not the alarm.
    const absent = names[names.length - 1]!;
    const drifted = runWithStubbedCurl(
      listing(names.slice(0, -1)),
      good,
      "200",
      "200",
      0,
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
    const good =
      '{"series":[{"pointlist":[[0,1]]}],"data":[{"attributes":{"attributes":{"view":{"largest_contentful_paint":1840000000}}}}]}';
    const names = PROD.map((m) => m.name);
    const listing = (ns: string[]): string =>
      JSON.stringify(ns.map((name, i) => ({ id: 4000 + i, name })));

    const withSibling = runWithStubbedCurl(
      listing([...names, "[production] a monitor the OTHER script renders"]),
      good,
      "200",
      "200",
      0,
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
      good,
      "200",
      "200",
      0,
      ["--only=verify"],
    );
    assert.equal(missing.code, 3, "a row never applied must still fail verify");
    assert.match(missing.stdout, /only in code\s+1/);
  });

  it("rejects an unknown argument rather than running for real", () => {
    // `apply-monitors.sh` parsed one position against one exact string, so
    // `--dryrun` and `prod --json --dry-run` both went on to write to Datadog
    // for real — 78 live requests from a mistyped dry run.
    const res = spawnSync("bash", [SCRIPT, "prod", "--dryrun"], {
      encoding: "utf8",
      cwd: ROOT,
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /unknown argument/);
  });

  it("requires both credentials for a live run", () => {
    const childEnv = { ...process.env };
    delete childEnv.DD_API_KEY;
    delete childEnv.DD_APP_KEY;
    const res = spawnSync("bash", [SCRIPT, "prod"], {
      encoding: "utf8",
      cwd: ROOT,
      env: childEnv,
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /DD_API_KEY|DD_APP_KEY/);
  });

  it("MONEY-1229 — qa applies NOTHING while the kill-switch is off", () => {
    // QA monitoring is OFF by founder decision (`dd_qa_monitoring_enabled` in
    // lib-datadog.sh, default `off`): qa runs a subset of the schedules over
    // data copied down from prod, so a qa monitor either duplicates a prod
    // alarm or watches a job qa never runs.
    //
    // Asserted HERE and not only in monitor-agreement.test.ts because this is a
    // DIFFERENT script with its own copy of the guard — the shared library
    // provides the predicate, not the `exit 0`. `render()` above turns the
    // switch back on for every qa render in this file, so without this case
    // deleting that block would change nothing else in the suite.
    //
    // Exit 0, not 1: a configured state must not read as a failed cutover. That
    // makes the MESSAGE the only thing distinguishing "deliberately disabled"
    // from "ran and found no work", so it is asserted, along with the way back.
    //
    // A LIVE run (no `--dry-run`), because that is what the cutover runner
    // invokes and `--dry-run` short-circuits before the write path anyway. The
    // credentials are STUBBED rather than stripped: measured, this script puts
    // its `:?` credential expansions ABOVE the qa guard, so a live qa run
    // without keys dies on DD_API_KEY before reaching it — where
    // `apply-monitors.sh` has the same two blocks in the opposite order and
    // exits 0. Nothing here depends on which order is right; the stub keys keep
    // the case measuring the GUARD rather than that difference, and the empty
    // curl log is what proves nothing was applied.
    const childEnv = { ...process.env };
    delete childEnv.DD_QA_MONITORING;
    for (const [label, value] of [
      ["(unset)", undefined],
      ["off", "off"],
      // Compared against the LITERAL "on", so a value a reader might expect to
      // arm it does not. The inverse of this repo's `Boolean("false")` class.
      ["true", "true"],
    ] as const) {
      const res = spawnSync("bash", [SCRIPT, "qa"], {
        encoding: "utf8",
        cwd: ROOT,
        env: {
          ...childEnv,
          ...(value === undefined ? {} : { DD_QA_MONITORING: value }),
          DD_API_KEY: "stub-api-key",
          DD_APP_KEY: "stub-app-key",
          PATH: `${NO_NET}:${childEnv.PATH ?? ""}`,
          STUB_LOG: NO_NET_LOG,
        },
      });
      assert.equal(res.status, 0, `DD_QA_MONITORING=${label}: ${res.stderr}`);
      assert.match(res.stdout ?? "", /qa monitoring is disabled/);
      assert.match(res.stdout ?? "", /DD_QA_MONITORING=on/);
      assert.equal(
        (res.stdout ?? "").split("\n").filter((l) => l.startsWith("{")).length,
        0,
        `DD_QA_MONITORING=${label} rendered a body`,
      );
      assert.equal(
        readFileSync(NO_NET_LOG, "utf8"),
        "",
        `DD_QA_MONITORING=${label} reached curl`,
      );
    }
    // The reversal, so the case above cannot pass because qa is simply broken.
    assert.ok(QA.length >= 9, `the switch restores only ${QA.length} rows`);
  });
});

describe("MONEY-1359 — the script and the library agree", () => {
  it("sources the shared library rather than carrying its own copy", () => {
    // A second copy of dd_request/dd_render would start identical and drift,
    // which is the defect class this directory's whole history is made of.
    assert.match(SCRIPT_SRC, /source "\$HERE\/lib-datadog\.sh"/);
    assert.doesNotMatch(SCRIPT_SRC, /^dd_request\(\) \{/m);
    assert.doesNotMatch(SCRIPT_SRC, /^dd_render\(\) \{/m);
  });

  it("derives the API host from DD_SITE rather than hardcoding one", () => {
    // apply-monitors.sh POSTed to US1 for two releases while DD_SITE said
    // otherwise, creating monitors in an org that never receives the metric.
    // The derivation MOVED to lib-datadog.sh (five scripts had five copies of
    // it, and the site is the one fact a 403 answers silently). So the property
    // is now checked across the SEAM: this script must call the shared
    // resolver, and the resolver must read the constant. Asserting only the
    // first half would pass against a library that hardcoded a host, which is
    // the very thing being prevented.
    const LIB_SRC = readFileSync(
      join(ROOT, "scripts/ops/datadog/lib-datadog.sh"),
      "utf8",
    );
    assert.match(
      SCRIPT_SRC,
      /dd_resolve_api_host/,
      "this script does not reach the shared API-host resolver",
    );
    assert.match(LIB_SRC, /DD_SITE\\s\*=/);
    assert.doesNotMatch(SCRIPT_SRC, /api\.datadoghq\.com/);
    assert.doesNotMatch(SCRIPT_SRC, /api\.us[0-9]\.datadoghq\.com/);
  });

  it("every preflight kind in the row table has a branch that handles it", () => {
    // A kind with no branch hits the `*)` arm and exits 1 — loud rather than
    // silent, but only if somebody runs it. This catches it at test time.
    const rows = [
      ...SCRIPT_SRC.matchAll(/^\s+"[a-z0-9-]+\.json\|[^"]*\|([a-z-]+)"$/gm),
    ].map((m) => m[1]!);
    assert.ok(rows.length >= 12, `only ${rows.length} rows parsed`);
    // Case labels can be alternations (`rum|rum-lcp)`), so the branch is parsed
    // and its labels split rather than pattern-matched — a regex for `rum)`
    // reports a handled kind as unhandled.
    const handled = new Set(
      [...SCRIPT_SRC.matchAll(/^\s{4}([a-z|-]+)\)$/gm)].flatMap((m) =>
        m[1]!.split("|"),
      ),
    );
    assert.ok(handled.size >= 4, `parsed only ${handled.size} case labels`);
    for (const kind of new Set(rows)) {
      assert.ok(
        handled.has(kind),
        `preflight kind "${kind}" is used by a row and has no case branch — ` +
          `handled: ${[...handled].join(", ")}`,
      );
    }
  });

  it("the library it depends on exists and exports what the script calls", () => {
    const lib = readFileSync(LIB, "utf8");
    for (const fn of [
      "dd_request",
      "dd_render",
      "dd_list_managed",
      "dd_upsert_monitor",
      "dd_metric_has_points",
      "dd_events_exist",
    ]) {
      assert.match(lib, new RegExp(`^${fn}\\(\\) \\{`, "m"), `${fn} missing`);
      assert.ok(SCRIPT_SRC.includes(fn), `${fn} is exported and never called`);
    }
  });
});

describe("MONEY-1359 — each row watches what it claims to", () => {
  it("the APM rows name the SERVER span, never dd-trace's CLIENT span", () => {
    // `trace.http.request.*` is dd-trace-js's HTTP CLIENT span and
    // `trace.web.request.*` is its SERVER span — both declared in
    // node_modules/dd-trace/packages/dd-trace/src/service-naming/schemas/v0/
    // web.js (`client.http.opName` :16, `server.http.opName` :78). v0 is what
    // applies: DD_TRACE_SPAN_ATTRIBUTE_SCHEMA appears nowhere in this repo.
    //
    // These rows carried `http.request` for a release, so the error-rate
    // monitors scored our OUTBOUND calls to NSE, BSE, Screener, Tiingo and
    // Gemini rather than our own request handling. A vendor's holiday 404 storm
    // pages; a job route 500ing on every Pub/Sub push does not. THE PREFLIGHT
    // CANNOT CATCH THIS — the client series genuinely has points, so
    // `dd_metric_has_points` passes and the monitor looks healthy.
    //
    // THE EXPECTATION IS THE DECLARATION — MONEY-1534. The span is a
    // per-SERVICE fact (ddtrace-py's `fastapi.request`, dd-trace-js's generic
    // `web.request`, and `hono.request` once its Hono plugin renames that same
    // span), declared once in DD_SERVER_SPAN, which the script reads through
    // `dd_server_span`. This used to be a map in THIS file agreeing with a span
    // column in the script: two copies, and the workers' pair went on agreeing
    // on `web.request` for twelve days after the service stopped emitting it.
    assert.ok(
      Object.keys(DD_SERVER_SPAN).length >= 4,
      "DD_SERVER_SPAN collapsed",
    );
    for (const [service, span] of Object.entries(DD_SERVER_SPAN)) {
      assert.notEqual(
        span,
        "http.request",
        `${service} is declared with dd-trace-js's HTTP CLIENT span — that ` +
          "measures our outbound vendor calls, not our request handling",
      );
    }
    const apmRows = ROWS.filter((r) => r.kind === "metric-apm");
    assert.ok(apmRows.length >= 4, `only ${apmRows.length} APM rows parsed`);
    for (const row of apmRows) {
      assert.ok(
        spanOf(row.service),
        `${row.service} has an APM row and no DD_SERVER_SPAN entry — the row ` +
          "is refused by name on every run",
      );
    }
    // And the RENDERED query carries it, on BOTH terms of the ratio. A
    // template that dropped `{{span}}`, or hardcoded one, would satisfy the
    // loops above and query somebody else's series.
    const apm = PROD.filter((m) => familyOf(m) === "apm-error-rate");
    assert.equal(apm.length, apmRows.length, "an APM row rendered nothing");
    for (const m of apm) {
      const service = m.tags
        .find((t) => t.startsWith("service:"))!
        .slice("service:".length);
      for (const series of ["errors", "hits"]) {
        const want = `trace.${spanOf(service)}.${series}{service:${service},`;
        assert.ok(
          m.query.includes(want),
          `${m.name} does not query ${want}: ${m.query}`,
        );
      }
      assert.ok(
        !m.query.includes("trace.http.request."),
        `${m.name} queries the CLIENT span: ${m.query}`,
      );
    }
  });

  it("MONEY-1534 — the APM preflight asks about HITS of the declared span, never errors", () => {
    // A preflight must never name a series whose emptiness is HEALTH. A
    // healthy service has NO errors series at all — measured 2026-09-23, none
    // in 24h for any of the four APM services while every hits series was
    // live — so a probe over errors would refuse every healthy row, and the
    // apply would be permanently red. HITS is the series whose absence means
    // "nobody is measuring this", which is the question.
    const branch = CASE_BODY.get("metric-apm");
    assert.ok(branch, "no metric-apm case branch");
    assert.match(
      branch,
      /SPAN="\$\(dd_server_span "\$SERVICE"\)"/,
      "the metric-apm branch no longer reads the span from its declaration",
    );
    // The QUERY the preflight sends, not the branch text — the FAILED+=
    // message names the same series, so scanning the branch would pass a probe
    // pointed anywhere.
    assert.equal(
      /dd_metric_has_points "([^"]*)"/.exec(branch)?.[1],
      "sum:trace.${SPAN}.hits{service:${SERVICE},env:${DD_ENV_TAG}}.as_count()",
    );
  });

  it("every row PREFLIGHTS the series its own monitor queries", () => {
    // MONEY-1359 finding 10. `monitor-rt-bars-absence.json` ran the `metric-rt`
    // preflight, which checks `stockbook.rt.health_ok` — a gauge emitted every
    // 5s from flushTick's `finally`, so it has points whenever the PROCESS is
    // alive. The monitor itself watches `stockbook.rt.bars_closed`, which
    // `main.ts`'s flush path increments only AFTER the `mayWrite` entitlement
    // gate passes (:450), and whose zero deltas the emitter skips. (The drain
    // in `closeSocket` at :268 does increment unconditionally, but it fires on
    // shutdown or a step-down, so it cannot hold the series up.) On a fresh
    // prod, or wherever
    // US_MARKET_ALLOWED_EMAILS keeps `mayWrite` false, the preflight passed and
    // the monitor was created over a series nobody emits — and with
    // no_data_timeframe 17280 it then sits silent for twelve days.
    //
    // Checked as an AGREEMENT rather than a restated pair, so it also covers
    // the next `stockbook.*` row somebody adds.
    const prodRows = ROWS.filter((r) => r.envs.includes("prod"));
    assert.equal(
      prodRows.length,
      PROD.length,
      "the positional join is only meaningful when the two agree",
    );
    let checked = 0;
    prodRows.forEach((row, i) => {
      const metrics = new Set(
        [...PROD[i]!.query.matchAll(/stockbook\.[a-z0-9_.]+/g)].map(
          (m) => m[0],
        ),
      );
      if (metrics.size === 0) return;
      const branch = CASE_BODY.get(row.kind);
      assert.ok(
        branch,
        `row ${row.tpl} uses preflight kind "${row.kind}", which has no case ` +
          `branch — parsed: ${[...CASE_BODY.keys()].join(", ")}`,
      );
      // The QUERY the preflight sends, not the branch text. Written against the
      // whole branch this assertion was VACUOUS: the FAILED+= message names the
      // metric too, so pointing dd_metric_has_points at a different series
      // still matched. Verified by mutating the branch's query alone.
      const probe = /dd_metric_has_points "([^"]*)"/.exec(branch)?.[1];
      assert.ok(
        probe,
        `${row.tpl} watches ${[...metrics].join(", ")} but its "${row.kind}" ` +
          "preflight never calls dd_metric_has_points",
      );
      for (const metric of metrics) {
        checked += 1;
        assert.ok(
          probe.includes(metric),
          `${row.tpl} watches ${metric} but its "${row.kind}" preflight asks ` +
            `about \`${probe}\`. A preflight over the wrong series is worse ` +
            `than none: it reports the monitor as verified.`,
        );
      }
    });
    assert.ok(
      checked >= 2,
      `only ${checked} metric/preflight pairs were checked — the scan broke`,
    );

    // ── LOG ROWS — MONEY-1359 finding 3 ───────────────────────────────────
    //
    // The loop above scans `stockbook.*` out of the query, so it excludes every
    // log row BY CONSTRUCTION — and the log rows had the same defect the
    // metric-rt-bars split was made for. They preflighted
    // `dd_events_exist logs "service:X env:Y"` — does ANY log exist — while
    // their monitors query `status:error` and `status:(fatal OR critical)`.
    //
    // The gap between those two questions is not hypothetical: our nodejs lines
    // carry `level`, not `status`, until `apply-log-config.sh` installs the
    // remapper, and `setup-datadog.sh` runs the service monitors BEFORE it. So
    // the row passed on the presence of logs, was created against an attribute
    // nothing emits, and sat in permanent NO DATA — with `notify_no_data:false`
    // underneath it, which is the state a preflight exists to refuse.
    //
    // The rule asserted is the DEPENDENCY, not a restated pair: a monitor whose
    // log query reads the `status` attribute must be preflighted by a query
    // that also reads it. Datadog DEFAULTS an unmapped log's status to `info`,
    // so a probe that would match an info line proves nothing in either
    // direction — which is why "any log for the service" was vacuous here.
    let logsChecked = 0;
    prodRows.forEach((row, i) => {
      const body = PROD[i]!;
      if (body.type !== "log alert") return;
      const filter = /logs\("((?:[^"\\]|\\.)*)"\)/.exec(body.query)?.[1];
      assert.ok(
        filter,
        `${row.tpl} is a log alert whose query has no logs("…") filter: ` +
          body.query,
      );
      const branch = CASE_BODY.get(row.kind);
      assert.ok(
        branch,
        `row ${row.tpl} uses preflight kind "${row.kind}", which has no case ` +
          `branch — parsed: ${[...CASE_BODY.keys()].join(", ")}`,
      );
      // The QUERY the preflight sends, not the branch text — the FAILED+=
      // message names the same terms, so scanning the whole branch would pass
      // against a probe pointed anywhere.
      const probe = /dd_events_exist logs "([^"]*)"/.exec(branch)?.[1];
      assert.ok(
        probe,
        `${row.tpl} is a log alert but its "${row.kind}" preflight never ` +
          `calls dd_events_exist logs`,
      );
      logsChecked += 1;

      if (/\bstatus:/.test(filter)) {
        assert.match(
          probe,
          /\bstatus:/,
          `${row.tpl} queries \`${filter}\` — which reads the \`status\` ` +
            `attribute — but its "${row.kind}" preflight asks \`${probe}\`, ` +
            `which does not. Our nodejs lines carry \`level\` until ` +
            `apply-log-config.sh installs the status remapper, and ` +
            `setup-datadog.sh runs THIS script first, so that probe passes in ` +
            `exactly the state it exists to refuse.`,
        );
        // …and it must be a value the remapper is the ONLY source of. Datadog
        // defaults an unmapped line to `info`, so `status:info` (or a bare
        // wildcard) matches whether or not the pipeline exists.
        assert.doesNotMatch(
          probe,
          /\bstatus:(?:\*|info\b)/,
          `${row.tpl}'s preflight probes \`${probe}\`. Datadog DEFAULTS an ` +
            `unmapped log's status to \`info\`, so that matches with or ` +
            `without the remapper — a vacuous preflight, which is worse than ` +
            `none because it reports the monitor as verified.`,
        );
      }
      // Scope has to agree too: a service-scoped monitor preflighted on the
      // whole environment is verified by somebody else's logs.
      //
      // The probe is read out of the SHELL SOURCE, so it carries `${SERVICE}`
      // and `${DD_ENV_TAG}` unexpanded while the monitor filter carries the
      // rendered values. The agreement is therefore made in two steps: the
      // filter's service must be the ROW's service (that is the value the shell
      // substitutes), and the probe must be scoped by that same variable.
      // Written with string concatenation rather than a template literal —
      // `${SERVICE}` inside one interpolates and silently becomes "".
      const service = /\bservice:([^\s")]+)/.exec(filter)?.[1];
      if (service) {
        assert.equal(
          service,
          row.service,
          `${row.tpl} renders service:${service} from a row whose service ` +
            `field is "${row.service}"`,
        );
        assert.ok(
          probe.includes("service:${SERVICE}"),
          `${row.tpl} watches service:${service} but its preflight asks ` +
            "`" +
            probe +
            "` — a different service's logs would verify it",
        );
      }
      assert.ok(
        probe.includes("env:${DD_ENV_TAG}"),
        "" +
          row.tpl +
          "'s preflight `" +
          probe +
          "` is not scoped to the environment being applied",
      );
    });
    assert.ok(
      logsChecked >= 6,
      `only ${logsChecked} log/preflight pairs were checked — the scan broke`,
    );
  });

  it("no tiingo-realtime LOG row while that process ships no logs", () => {
    // MONEY-1359 finding 3. `monitor-rt-stepdown.json` is a log alert on
    // service:tiingo-realtime, and that service sends nothing to the log intake:
    // `initLogger()` — the only thing that attaches pino's Datadog multistream
    // — is called in workers/src/index.ts and nowhere else, while
    // workers/src/realtime/main.ts is its OWN tsup entry point whose log sites
    // are all bare `console.*`. (Its datadog-agent sidecar sets DD_APM_ENABLED
    // and no DD_LOGS_ENABLED, so that route is closed too.)
    //
    // The cost is not a quiet monitor. `dd_events_exist` returns empty, the row
    // is REFUSED, and the script exits 1 AFTER writing every row above it — a
    // permanently red apply, which is how an operator learns to ignore an exit
    // code.
    //
    // Read as TEXT rather than imported: importing main.ts opens a socket.
    const rtMain = readFileSync(
      join(ROOT, "workers/src/realtime/main.ts"),
      "utf8",
    );
    assert.match(
      rtMain,
      /\[tiingo-rt\]/,
      "read the wrong file — this check is vacuous unless it is main.ts",
    );
    const shipsLogs = /\binitLogger\s*\(/.test(rtMain);
    const logRows = ROWS.filter(
      (r) => r.service === "tiingo-realtime" && r.kind.startsWith("logs"),
    );
    if (!shipsLogs) {
      assert.deepEqual(
        logRows.map((r) => r.tpl),
        [],
        "a log-alert row names service:tiingo-realtime, but that process " +
          "never calls initLogger() so it ships no logs to Datadog. The row " +
          "would be refused on every live run and take the whole apply " +
          "non-zero with it. Land initLogger() in " +
          "workers/src/realtime/main.ts (and move its console.* calls onto " +
          "getLogger()) before restoring the row.",
      );
    }
  });
});

/**
 * MONEY-1534 — one server span per service, and every artifact agrees with it.
 *
 * MONEY-1380 started stockbook-workers with `--import dd-trace/register.js`
 * (~2026-09-11). That let dd-trace's Hono plugin patch the ESM bundle, and the
 * plugin RENAMES the server span (`setFramework`, dd-trace
 * packages/dd-trace/src/plugins/util/web.js:87): `web.request` became
 * `hono.request`. The monitor, the SLO and the dashboard widget all spelled
 * `web.request`, so the monitor sat in No Data from 2026-09-12, the SLO apply
 * refused its row, and the widget charted nothing — no error anywhere.
 *
 * The span is now declared ONCE, in DD_SERVER_SPAN. The monitors read it through
 * `dd_server_span`; `slos.json` and `dashboards/*.json` are JSON and cannot, so
 * they carry it as a literal and the second case below holds every one of them
 * to the declaration — the arrangement site-agreement.test.ts uses for DD_SITE.
 */
describe("MONEY-1534 — one server span per service, in every artifact", () => {
  const DIR = join(ROOT, "scripts/ops/datadog");

  it("the shell resolver reads the SAME declaration the tests import", () => {
    // `dd_server_span` reads constants.ts with a REGEX, because a shell script
    // cannot import TypeScript. Two readings of one file agree only while this
    // says so — test the JOIN, not each half.
    const resolve = (service: string) =>
      spawnSync(
        "bash",
        ["-c", 'source "$1"; dd_server_span "$2"', "_", LIB, service],
        {
          encoding: "utf8",
          cwd: ROOT,
        },
      );
    const declared = Object.entries(DD_SERVER_SPAN);
    assert.ok(declared.length >= 4, "DD_SERVER_SPAN collapsed");
    for (const [service, span] of declared) {
      const r = resolve(service);
      assert.equal(r.status, 0, `${service}: ${r.stderr}`);
      assert.equal(
        r.stdout.trim(),
        span,
        `the shell reads ${service}'s span as "${r.stdout.trim()}", the ` +
          `constant says "${span}"`,
      );
    }
    // FAILS CLOSED on a service with no declaration. A default would be a
    // guess, and a guessed span is a query over a series nobody emits — the
    // exact defect this ticket is.
    const miss = resolve("stockbook-web");
    assert.notEqual(miss.status, 0, "an undeclared service was given a span");
    assert.equal(miss.stdout, "", `printed a span anyway: ${miss.stdout}`);
    assert.match(miss.stderr, /no server span declared for "stockbook-web"/);
  });

  it("every trace.* query in the monitors, the SLOs and the dashboards uses its service's declared span", () => {
    // `_`-prefixed keys are documentation and never reach Datadog — dropped at
    // every depth, as `dd_render` does, so prose about an old span cannot
    // fail this and a query can never hide inside one.
    const stripDocs = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(stripDocs)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .filter(([k]) => !k.startsWith("_"))
                .map(([k, x]) => [k, stripDocs(x)]),
            )
          : v;
    const jsonText = (path: string): string =>
      JSON.stringify(stripDocs(JSON.parse(readFileSync(path, "utf8"))));

    const boards = readdirSync(join(DIR, "dashboards")).filter((f) =>
      f.endsWith(".json"),
    );
    const sources = [
      // RENDERED, so the span `dd_server_span` substituted is what is checked.
      ...[...PROD, ...QA].map((m) => ({
        kind: "monitor",
        label: m.name,
        text: m.query,
      })),
      {
        kind: "slo",
        label: "slos.json",
        text: jsonText(join(DIR, "slos.json")),
      },
      ...boards.map((f) => ({
        kind: "dashboard",
        label: `dashboards/${f}`,
        text: jsonText(join(DIR, "dashboards", f)),
      })),
    ];

    // `trace.<span>.<hits|errors|…>{scope}`. The span is matched LAZILY, so
    // `trace.hono.request.hits{` reads as span `hono.request`, series `hits`.
    const TRACE_REF =
      /\btrace\.([a-z0-9_]+(?:\.[a-z0-9_]+)*?)\.(hits|errors|duration|apdex)\b[a-z0-9_.]*\{([^}]*)\}/g;
    const counts = new Map<string, number>();
    const servicesSeen = new Set<string>();
    for (const s of sources) {
      for (const ref of s.text.matchAll(TRACE_REF)) {
        const span = ref[1]!;
        const service = /(?:^|,)\s*service:([a-z0-9_-]+)/.exec(ref[3]!)?.[1];
        assert.ok(
          service,
          `${s.label} reads ${ref[0]} with no service: in its scope — a ` +
            "trace.* query over the whole org cannot be held to any one " +
            "service's span",
        );
        const declared = spanOf(service);
        assert.ok(
          declared,
          `${s.label} reads trace.* for service:${service}, which has no ` +
            "DD_SERVER_SPAN entry in packages/datadog/src/constants.ts",
        );
        assert.equal(
          span,
          declared,
          `${s.label} reads trace.${span}.* for service:${service}, whose ` +
            `declared server span is ${declared}. Either the artifact is stale ` +
            "or the declaration is — re-measure against the org and fix the one " +
            "that is wrong",
        );
        counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
        servicesSeen.add(service);
      }
    }
    // Falsifiable floors: a scan that read nothing would pass every assertion
    // above. At least one hits/errors pair from each kind of artifact…
    for (const kind of ["monitor", "slo", "dashboard"]) {
      assert.ok(
        (counts.get(kind) ?? 0) >= 2,
        `only ${counts.get(kind) ?? 0} trace.* refs read from the ${kind}s — ` +
          "the scan broke",
      );
    }
    // …and no declaration that nothing reads. A span nobody queries is a
    // measurement nobody re-checks.
    assert.deepEqual(
      Object.keys(DD_SERVER_SPAN).filter((svc) => !servicesSeen.has(svc)),
      [],
      "a DD_SERVER_SPAN entry is queried by no monitor, SLO or dashboard",
    );
  });

  it("the error-rate NUMERATOR is zero-filled, and nothing else is", () => {
    // A healthy service has NO errors series (measured 2026-09-23: none in 24h
    // for all four), so `default_zero()` states "no errors" as a real 0.
    //
    // And ONLY there. Over the dead span, measured on the query API, a filled
    // NUMERATOR over no hits is all-null — the monitor goes No Data, grey and
    // visible, which is how this ticket was found. A filled RATIO is zeros: the
    // monitor would have read OK for ever over a service nobody was measuring.
    // A filled denominator makes 0/0 of the same silence.
    const NUMERATOR =
      /default_zero\((sum:trace\.[a-z0-9_.]+\.errors\{[^}]*\}\.as_count\(\))\)/;
    const apm = [...PROD, ...QA].filter(
      (m) => familyOf(m) === "apm-error-rate",
    );
    assert.ok(apm.length >= 8, `only ${apm.length} APM monitors rendered`);
    for (const m of apm) {
      const hit = NUMERATOR.exec(m.query);
      assert.ok(
        hit,
        `${m.name}: the errors term is not wrapped in default_zero() on its ` +
          `own: ${m.query}`,
      );
      const rest = m.query.replace(hit[0], "");
      assert.doesNotMatch(
        rest,
        /default_zero\(/,
        `${m.name}: default_zero() reaches past the numerator — over a ` +
          `renamed span that reads 0, i.e. OK, for ever: ${m.query}`,
      );
      assert.match(
        rest,
        / \/ sum:trace\.[a-z0-9_.]+\.hits\{[^}]*\}\.as_count\(\) > /,
        `${m.name}: the denominator is not a bare hits series: ${m.query}`,
      );
    }
  });
});
