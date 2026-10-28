/**
 * MONEY-1379 — `apply-perf-monitors.sh` and what it actually renders.
 *
 * The performance monitors read series supplied by Datadog's Google Cloud
 * integration, not by this repo. So there is no local constant to compare a
 * metric name against, and the checks that CAN exist are of three kinds:
 *
 *   1. SHAPE — the rendered bodies are fully substituted, correctly typed, and
 *      carry the scope, threshold and units the estate was measured at.
 *   2. REFUSAL — a row whose series has no points is not created, and a
 *      preflight that could not RUN stops the whole script rather than reading
 *      as an empty series.
 *   3. AGREEMENT — what the script renders and what Datadog holds under its
 *      managed tag are the same set, with the same queries.
 *
 * (3) is the founder's requirement that coded monitors and Datadog monitors
 * stay in sync, and it is why this script prunes and answers `--only=verify`
 * where the two older ones only upsert.
 *
 * Everything here spawns the REAL script against a stubbed `curl`, the pattern
 * `service-monitors-agreement.test.ts` established. Asserting on a re-derived
 * copy of the row table would agree with the script only until somebody edited
 * one of them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(ROOT, "scripts/ops/datadog/apply-perf-monitors.sh");
const SCRIPT_SRC = readFileSync(SCRIPT, "utf8");

interface Rendered {
  name: string;
  type: string;
  query: string;
  message: string;
  tags: string[];
  options: {
    notify_no_data: boolean;
    no_data_timeframe: number;
    thresholds: Record<string, number>;
    renotify_interval: number;
    require_full_window: boolean;
    include_tags: boolean;
  };
}

/** A `curl` that cannot reach the network — proves `--dry-run` stays offline. */
const NO_NET = mkdtempSync(join(tmpdir(), "perf-monitors-offline-"));
const NO_NET_LOG = join(NO_NET, "calls.log");
writeFileSync(
  join(NO_NET, "curl"),
  [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$STUB_LOG"',
    // DRAIN `-K -`. A stub that never reads stdin makes the credential writer
    // die of SIGPIPE; `pipefail` then reports "curl exited 141" and the real
    // failure is invisible on macOS and fatal on Linux.
    "cat > /dev/null",
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

const PROD = render("prod");
const byName = (needle: string): Rendered => {
  const hit = PROD.filter((m) => m.name.includes(needle));
  assert.equal(
    hit.length,
    1,
    `expected exactly one monitor matching ${needle}`,
  );
  return hit[0]!;
};

/**
 * Run the REAL script against a stubbed `curl` and report what curl saw.
 *
 * Routes by URL because this script makes three KINDS of request and they need
 * different bodies: the managed listing must be a JSON ARRAY, a metric
 * preflight must be `{series:[...]}`, and a DELETE answers an object. A single
 * stub body cannot satisfy the first two, and answering the listing with a
 * preflight object makes the script abort on "not a JSON array" — which looks
 * exactly like the fail-closed behaviour under test and would make these cases
 * pass for the wrong reason.
 */
function run(opts: {
  args?: string[];
  /** Monitors Datadog is pretending to hold under the managed tag. */
  listing?: { id: number; name: string; query: string }[];
  /** A substring of the preflight query that should answer "no points". */
  emptyFor?: string;
  /** HTTP status for preflight GETs (403 exercises the did-not-run path). */
  preflightStatus?: string;
  /** Extra env for the child — e.g. DD_QA_MONITORING for a qa run. */
  env?: Record<string, string>;
  /** Which env the stubbed monitors belong to (the stub filters like the API). */
  listingEnv?: string;
}): { code: number; stdout: string; stderr: string; curlLog: string } {
  const dir = mkdtempSync(join(tmpdir(), "perf-monitors-"));
  const log = join(dir, "calls.log");
  try {
    writeFileSync(
      join(dir, "curl"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$STUB_LOG"',
        "cat > /dev/null",
        'case "$*" in',
        // A monitor id path (DELETE) and the collection (GET/POST/PUT) both
        // match */api/v1/monitor*, so the verb decides the body.
        '  *"/api/v1/monitor"*)',
        '    case "$*" in',
        // Models the API's tag filter. An UNSCOPED listing returns every
        // monitor under the managed tag INCLUDING the other environment's —
        // which is the bug — while a listing scoped to an env returns only
        // that env's. Without this the stub answers the same thing either
        // way and the case below passes against broken code.
        '      *"-X GET"*)',
        '        body="$STUB_LISTING"',
        // The MANAGED-TAG term. Without it the API returns every monitor
        // carrying the other terms — including the ~79 owned by the two OTHER
        // apply scripts, which share `env:` tags. Modelling it is what lets a
        // test catch a LIST_TAG that drops the managed term and prunes them.
        '        case "$*" in',
        '          *"managed-by%3Aapply-perf-monitors"*) ;;',
        '          *) body="$STUB_LISTING_FOREIGN" ;;',
        "        esac",
        '        case "$*" in',
        '          *"env%3A"*)',
        '            case "$*" in',
        '              *"env%3A$STUB_LISTING_ENV"*) ;;',
        '              *) body="[]" ;;',
        "            esac ;;",
        "        esac",
        '        status="200" ;;',
        '      *"-X DELETE"*) body="{\\"deleted_monitor_id\\":1}"; status="200" ;;',
        '      *) body="{\\"id\\":1}"; status="200" ;;',
        "    esac",
        "    ;;",
        '  *"/api/v1/query"*)',
        '    status="$STUB_PREFLIGHT_STATUS"',
        '    body="{\\"series\\":[{\\"pointlist\\":[[1,1]]}]}"',
        '    if [ -n "$STUB_EMPTY_FOR" ]; then',
        '      case "$*" in *"$STUB_EMPTY_FOR"*) body="{\\"series\\":[]}" ;; esac',
        "    fi",
        "    ;;",
        '  *) body="{}"; status="200" ;;',
        "esac",
        'printf "%s\\n%s\\n" "$body" "$status"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(log, "");
    const res = spawnSync("bash", [SCRIPT, ...(opts.args ?? ["prod"])], {
      encoding: "utf8",
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        STUB_LOG: log,
        STUB_LISTING: JSON.stringify(opts.listing ?? []),
        STUB_LISTING_ENV: opts.listingEnv ?? "production",
        // What a listing missing the managed term would ALSO return.
        STUB_LISTING_FOREIGN: JSON.stringify([
          ...(opts.listing ?? []),
          {
            id: 9001,
            name: "[production] a JOB monitor owned by apply-monitors.sh",
            query: "j",
          },
        ]),
        STUB_EMPTY_FOR: opts.emptyFor ?? "",
        STUB_PREFLIGHT_STATUS: opts.preflightStatus ?? "200",
        DD_API_KEY: "stub-api-key",
        DD_APP_KEY: "stub-app-key",
        DD_NOTIFY: "ops@example.com",
        ...(opts.env ?? {}),
      },
    });
    return {
      code: res.status ?? -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      curlLog: readFileSync(log, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Monitor-endpoint calls by verb — never a bare verb count. */
const monitorCalls = (curlLog: string, verb: string): number =>
  curlLog
    .split("\n")
    .filter((l) => l.includes(`-X ${verb} `) && l.includes("/api/v1/monitor"))
    .length;

/** The listing the org would hold if the script had just been applied. */
const listingFor = (
  ms: Rendered[],
): { id: number; name: string; query: string }[] =>
  ms.map((m, i) => ({ id: 100 + i, name: m.name, query: m.query }));

describe("apply-perf-monitors — premise", () => {
  it("renders every row, and the dry run never touches the network", () => {
    // The floor. Every assertion below iterates PROD, and an empty array
    // satisfies all of them — so a render that produced nothing has to fail
    // here or it fails nowhere.
    assert.equal(
      PROD.length,
      9,
      `expected 9 prod monitors, got ${PROD.length}`,
    );
    assert.equal(
      readFileSync(NO_NET_LOG, "utf8"),
      "",
      "a --dry-run reached curl; the offline guarantee is on the PROCESS, " +
        "not on the script's own --dry-run branch",
    );
  });

  it("qa renders only the three Pub/Sub rows", () => {
    // Cloud Run saturation on a QA worker says nothing about the platform, and
    // us-fundamentals has no QA deployment at all — a monitor there would never
    // once have been green.
    const qa = render("qa");
    assert.equal(qa.length, 3);
    for (const m of qa)
      assert.match(
        m.name,
        /^\[qa\] Pub\/Sub/,
        `${m.name} is not a qa Pub/Sub row`,
      );
  });

  it("no documentation key survives at ANY depth", () => {
    // `dd_render` strips `_` keys recursively. The earlier version of that
    // stripper walked only the top level, and every template happened to be
    // clean — so the bug was one `"_note"` inside `options` away, and Datadog
    // rejects an unknown field there with a 400.
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v))
        return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          assert.ok(!k.startsWith("_"), `${path}.${k} is a documentation key`);
          walk(x, `${path}.${k}`);
        }
    };
    PROD.forEach((m) => walk(m, m.name));
  });
});

describe("apply-perf-monitors — scope is a NAME, never a wildcard", () => {
  it("every gcp.pubsub / gcp.run query names its subscription or service", () => {
    // `oldest_unacked_message_age by {subscription_id}` returns 190 series,
    // including `*-pull-local` subscriptions nothing drains — their oldest
    // message is always old, so a `*` monitor alerts forever on a healthy
    // estate. And `algo-api-prod` / `algo-workers-prod` are Cloud Run services
    // in the same project owned by a different repo.
    for (const m of PROD) {
      if (!/:gcp\.(pubsub|run)\./.test(m.query)) continue;
      assert.ok(
        m.query.includes("subscription_id:*-prod-push") ||
          /service_name:(stockbook-workers|us-fundamentals)-prod/.test(m.query),
        `${m.name} does not scope to a named subscription or service:\n  ${m.query}`,
      );
      assert.ok(
        !/\{\*\}/.test(m.query),
        `${m.name} carries a bare {*} scope:\n  ${m.query}`,
      );
    }
  });

  it("the ONLY wildcard scope is the Gemini quota, and it is argued for", () => {
    const wild = PROD.filter((m) => /\{\*\}/.test(m.query));
    assert.equal(wild.length, 1, "exactly one row may use {*}");
    assert.match(wild[0]!.query, /gcp\.generativelanguage\./);
  });

  it("the guard lives in the SCRIPT, not only in this file", () => {
    // A rule enforced only by a test is a rule somebody argues past at 2 a.m.
    assert.match(
      SCRIPT_SRC,
      /may not use scope '\*'/,
      "apply-perf-monitors.sh must refuse a wildcard gcp.pubsub/gcp.run scope itself",
    );
  });
});

describe("apply-perf-monitors — query form and UNITS", () => {
  it("the p95 sub-metric is queried with avg:, never p95:", () => {
    // `gcp.run.request_latency.user_execution.p95` is a SUB-METRIC the
    // integration ships from Cloud Run's own bucketed distribution. `p95:` is
    // the DISTRIBUTION query form and would ask for a series that does not
    // exist — the monitor would sit in NO DATA forever. Same class as the
    // histogram-vs-distribution defect in monitor-latency-p95.json.
    const m = byName("p95 handler time");
    assert.match(
      m.query,
      /^avg\(last_15m\):avg:gcp\.run\.request_latency\.user_execution\.p95\{/,
    );
    assert.ok(
      !m.query.includes("p95:gcp"),
      "p95: on the base name asks for a distribution that does not exist",
    );
  });

  it("latency thresholds are MILLISECONDS, and are three orders above the seconds figure", () => {
    // gcp.run.request_latency.* is in ms — measured 2026-09-11, last-hour p95 on
    // stockbook-workers-prod was 93,695 (~94s). Writing 540 here would create a
    // monitor that fires on every request over half a second.
    const m = byName("p95 handler time");
    assert.equal(m.options.thresholds.critical, 540_000);
    assert.equal(m.options.thresholds.warning, 480_000);
    assert.ok(
      m.options.thresholds.critical > 100_000,
      "a threshold under 100000 means somebody wrote seconds into a ms series",
    );
  });

  it("the Pub/Sub age threshold is SECONDS, under the ack deadline and over the handler budget", () => {
    // Derived, not chosen: 600 is Pub/Sub's ceiling (its maximum, so there is
    // nowhere to raise it to), and RUN_TIME_BUDGET_MS is where the worst-case
    // handler cuts itself off. A critical between them means "the tail is
    // already being redelivered" without firing on a handler using its budget.
    const budgetMs = Number(
      /export const RUN_TIME_BUDGET_MS = ([\d_]+)/
        .exec(
          readFileSync(
            join(
              ROOT,
              "workers/src/processors/stock-document-extract-logic.ts",
            ),
            "utf8",
          ),
        )?.[1]
        ?.replace(/_/g, ""),
    );
    assert.ok(Number.isFinite(budgetMs), "RUN_TIME_BUDGET_MS not found");

    const ackDeadline = Number(
      /--ack-deadline=(\d+)/.exec(
        readFileSync(join(ROOT, "workers/scripts/setup-pubsub.sh"), "utf8"),
      )?.[1],
    );
    assert.equal(ackDeadline, 600, "the ack deadline moved; re-derive these");

    const crit = byName("oldest unacked").options.thresholds.critical;
    // Narrowed rather than asserted away: a missing critical would otherwise
    // make both comparisons below compare against `undefined`, which is false
    // in each direction — the assertions would pass by never being about
    // anything.
    assert.ok(
      typeof crit === "number",
      "the oldest-unacked row rendered no critical threshold",
    );
    assert.ok(
      crit < ackDeadline,
      `${crit} is not under the ${ackDeadline}s deadline`,
    );
    assert.ok(
      crit > budgetMs / 1000,
      `${crit}s is below the ${budgetMs / 1000}s handler budget — it would fire ` +
        "on a handler that is using the budget it was given",
    );
  });

  it("every threshold is a NUMBER, never the string dd_render was handed", () => {
    // Datadog rejects `"critical": "480"` with a 400 naming the field.
    for (const m of PROD)
      for (const [k, v] of Object.entries(m.options.thresholds))
        assert.equal(
          typeof v,
          "number",
          `${m.name} threshold ${k} is a ${typeof v}`,
        );
  });

  it("an absent warning is ABSENT, not zero", () => {
    // `Number("")` is 0. On the dead-letter row, which alerts at `> 0`, a
    // warning of 0 reads as a permanently breached warning.
    const dl = byName("dead-lettered");
    assert.ok(
      !("warning" in dl.options.thresholds),
      "the dead-letter row must carry no warning threshold at all",
    );
    assert.equal(dl.options.thresholds.critical, 0);
    for (const m of PROD.filter((x) => x !== dl))
      assert.ok(
        "warning" in m.options.thresholds,
        `${m.name} lost its warning threshold`,
      );
  });

  it("the failure ratio excludes 409s, which are our own dedupe working", () => {
    // remote_server_4xx is pubsubDedupeMiddleware answering RETRY_LATER to a
    // redelivery whose claim is still live. Counting it would put a permanent
    // floor under the ratio (1,622 of them on stock-document-embed in 7 days)
    // and force the threshold up past the signal.
    const m = byName("push handler failure rate");
    assert.ok(m.query.includes("response_class:remote_server_5xx"));
    assert.ok(m.query.includes("response_class:unreachable"));
    assert.ok(
      !m.query.includes("remote_server_4xx"),
      "4xx must not be in the failure numerator",
    );
  });
});

describe("apply-perf-monitors — SPACE aggregation is chosen per metric", () => {
  // Datadog's monitor grammar is `time_aggr(window):space_aggr:metric{...}`, so
  // the SECOND aggregator combines SERIES and the first combines samples over
  // the window. They are not the same question. Getting it wrong here can only ever
  // UNDER-report, so the failure mode is a silent miss rather than a false page.

  it("instance_count SUMS across the state tag, never max", () => {
    // `gcp.run.container.instance_count` carries `state` (active / idle) —
    // verified against the live org 2026-09-11, both states present. `max:`
    // would read max(active, idle), so a service at its cap of 20 as 12 active
    // + 8 idle evaluates to 12 and never crosses the `> 18` critical the
    // threshold was sized for.
    for (const n of ["workers — instances", "us-fundamentals — instances"]) {
      const q = byName(n).query;
      assert.match(q, /:sum:gcp\.run\.container\.instance_count\{/, n);
      assert.ok(!/:max:gcp\.run\.container\.instance_count/.test(q), n);
    }
  });

  it("pending_requests SUMS across revisions", () => {
    // Cloud Run reports this per REVISION and two overlap on every deploy, so
    // `max:` would report the deeper of two queues rather than the real one.
    assert.match(
      byName("requests queued").query,
      /:sum:gcp\.run\.pending_queue\.pending_requests\{/,
    );
  });

  it("an AGE still uses max — the oldest message IS the question", () => {
    // The counter-example, so "always sum" does not become the new cargo cult.
    assert.match(
      byName("oldest unacked").query,
      /^max\(last_10m\):max:gcp\.pubsub\.subscription\.oldest_unacked_message_age\{/,
    );
  });

  it("the board and the monitor agree on aggregation", () => {
    // A board drawn with max: beside a monitor evaluated with sum: is two
    // answers to one question, and the board is the thing somebody checks
    // BEFORE deciding the monitor is wrong.
    const board = readFileSync(
      join(ROOT, "scripts/ops/datadog/dashboards/workers-performance.json"),
      "utf8",
    );
    const refs = [
      ...board.matchAll(
        /"(max|sum|avg):gcp\.run\.container\.instance_count\{/g,
      ),
    ];
    assert.ok(refs.length >= 1, "the board no longer charts instance_count");
    for (const r of refs)
      assert.equal(
        r[1],
        "sum",
        "the board must aggregate instance_count the way the monitor does",
      );
  });
});

describe("apply-perf-monitors — a preflight never names a series whose emptiness is health", () => {
  it("the dead-letter row preflights the CRAWL, not its own metric", () => {
    // Measured 2026-09-11: on a subscription with no dead letters,
    // `dead_letter_message_count` returns NO SERIES AT ALL — it is not a gauge
    // reporting 0, it does not exist until something is parked. Preflighting it
    // would refuse this row on exactly the healthy estate it exists to watch.
    const r = run({});
    const preflights = r.curlLog
      .split("\n")
      .filter((l) => l.includes("/api/v1/query"));
    assert.ok(
      !preflights.some((l) => l.includes("dead_letter_message_count")),
      "the dead-letter row must not preflight its own series:\n" +
        preflights.filter((l) => l.includes("dead_letter")).join("\n"),
    );
    assert.ok(
      preflights.some((l) => l.includes("push_request_count")),
      "it should preflight push_request_count, which proves Pub/Sub is crawled",
    );
  });

  it("an empty dead-letter series does not refuse the row", () => {
    // The direct statement of the same property: the healthiest possible
    // estate must still get its poison-message alarm.
    const r = run({ emptyFor: "dead_letter_message_count" });
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /applied 9/);
  });
});

describe("apply-perf-monitors — a refused row must not get its monitor DELETED", () => {
  it("a preflight refusal suppresses the prune entirely", () => {
    // The worst bug the review found. A refused row `continue`s before it can
    // add its name to the rendered set, so the pruner would see that row's
    // EXISTING monitor as an orphan and delete it — destroying the monitor, its
    // history and its mute state, and making that deletion the only lasting
    // effect of a run that reports failure. One transient hour of a vendor
    // crawl not reporting is enough to trigger it.
    const r = run({
      listing: listingFor(PROD),
      emptyFor: "oldest_unacked_message_age",
    });
    assert.notEqual(r.code, 0, "the run should still fail");
    assert.equal(
      monitorCalls(r.curlLog, "DELETE"),
      0,
      "NOTHING may be deleted on a run whose rendered set is incomplete",
    );
    assert.match(r.stdout, /NOT pruning/);
  });

  it("a clean run still prunes — the guard is not a blanket disable", () => {
    const r = run({
      listing: [
        ...listingFor(PROD),
        { id: 999, name: "[production] stale", query: "x" },
      ],
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(monitorCalls(r.curlLog, "DELETE"), 1);
  });
});

describe("apply-perf-monitors — no-data policy", () => {
  it("a gauge pages on silence; an event count does not", () => {
    // A stopped GCP crawl must page — a gauge that stops arriving is an
    // outage. But zero dead letters, zero 5xx and zero scheduler errors are
    // the HEALTHY states, and they look identical to no series at all, so
    // those three must not.
    const pages = [
      "oldest unacked",
      "p95 handler time",
      "requests queued",
      "quota utilisation",
    ];
    // The two saturation rows moved OUT of `pages` when they started grouping
    // by `revision_name`: a revision name changes on every release and the
    // retired revision stops emitting within minutes, so notify_no_data there
    // is a page on every deploy that re-notifies hourly for ~24h. Their own
    // describe block below covers that, and the four rows left in `pages`
    // group by nothing ephemeral, so the crawl-alive signal survives.
    const quiet = [
      "dead-lettered",
      "failure rate",
      "failed publish attempts",
      "workers — instances",
      "us-fundamentals — instances",
    ];
    for (const n of pages)
      assert.equal(
        byName(n).options.notify_no_data,
        true,
        `${n} must page on silence`,
      );
    for (const n of quiet)
      assert.equal(
        byName(n).options.notify_no_data,
        false,
        `${n} alerts on events whose ABSENCE is health — it must not page on no data`,
      );
  });

  it("no_data_timeframe is three times the window, in minutes", () => {
    for (const m of PROD) {
      const w = /\(last_(\d+)([mh])\)/.exec(m.query);
      assert.ok(w, `${m.name} has no readable window`);
      const minutes = w[2] === "h" ? Number(w[1]) * 60 : Number(w[1]);
      assert.equal(
        m.options.no_data_timeframe,
        minutes * 3,
        `${m.name}: no_data_timeframe should be 3x its ${minutes}m window`,
      );
    }
  });
});

describe("apply-perf-monitors — the message is what somebody reads at 3 a.m.", () => {
  it("every message ROUTES — the @handle is the whole mechanism", () => {
    // The SHAPE, not one literal: `render()` deliberately strips DD_NOTIFY so
    // these bodies carry the built-in default, while `run()` sets it. A monitor
    // with no `@handle` is delivered nowhere and looks entirely healthy.
    for (const m of PROD)
      assert.match(
        m.message.trimEnd(),
        /\n@[^\s@]+@[^\s@]+$/,
        `${m.name} does not end in an @handle, so it notifies nobody`,
      );
  });

  it("the handle comes from DD_NOTIFY, and falls back to the founder", () => {
    assert.ok(
      PROD.every((m) => m.message.trimEnd().endsWith("@deepshaswat@gmail.com")),
      "the documented default changed",
    );
    const overridden = run({ args: ["prod", "--dry-run"] })
      .stdout.split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Rendered);
    assert.equal(overridden.length, 9);
    assert.ok(
      overridden.every((m) => m.message.trimEnd().endsWith("@ops@example.com")),
      "DD_NOTIFY did not override the default",
    );
  });

  it("no message carries a BARE Datadog template variable", () => {
    // THE trap. `dd_render`'s final guard is
    // `JSON.stringify(filled).match(/\{\{\w+\}\}/g)` and it runs over the whole
    // body AFTER substitution — so `{{value}}` arriving inside a message VALUE
    // still trips it and the render dies with "unsubstituted placeholders".
    // Dotted variables are safe because `\w+` cannot cross a `.`.
    for (const m of PROD) {
      const bare = /\{\{(\w+)\}\}/.exec(m.message);
      assert.equal(
        bare,
        null,
        `${m.name} carries {{${bare?.[1]}}}, which dd_render refuses to render. ` +
          "Use a dotted group variable or state the threshold in prose.",
      );
    }
  });

  it("the grouped rows still name their group in the alert", () => {
    // Dropping {{value}} must not mean dropping WHICH subscription or service.
    assert.match(
      byName("oldest unacked").message,
      /\{\{subscription_id\.name\}\}/,
    );
    assert.match(
      byName("workers — instances").message,
      /\{\{service_name\.name\}\}/,
    );
    assert.match(byName("quota utilisation").message, /\{\{model\.name\}\}/);
    assert.match(
      byName("failed publish attempts").message,
      /\{\{job_id\.name\}\}/,
    );
  });

  it("the two rows that fire on day one name the tickets that resolve them", () => {
    for (const n of ["oldest unacked", "dead-lettered"])
      assert.match(
        byName(n).message,
        /MONEY-\d{4}/,
        `${n} fires immediately on prod; its message must say which ticket fixes it`,
      );
  });

  it("tags carry this script's own namespace and no other script's", () => {
    for (const m of PROD) {
      assert.ok(m.tags.includes("managed-by:apply-perf-monitors"), m.name);
      assert.ok(m.tags.includes("money:1379"), m.name);
      assert.ok(
        !m.tags.includes("managed-by:apply-monitors"),
        `${m.name} would be swept up by apply-slos.sh's listing of the OTHER tag`,
      );
    }
  });
});

describe("apply-perf-monitors — the preflight has THREE outcomes", () => {
  it("a series with no points REFUSES that row by name, and fails the run", () => {
    const r = run({ emptyFor: "oldest_unacked_message_age" });
    assert.notEqual(r.code, 0, "a refused row must fail the run");
    assert.match(r.stderr, /pubsub-oldest-unacked: no points in 1h/);
    assert.match(r.stderr, /would sit in NO DATA/);
    assert.equal(
      monitorCalls(r.curlLog, "POST") + monitorCalls(r.curlLog, "PUT"),
      8,
      "the other eight rows should still have been written",
    );
  });

  it("a preflight that could not RUN is FATAL, and writes NOTHING", () => {
    // 1 and 2 were one code once. Collapsed, a bad app key or a single 429
    // makes every row read as "the series is empty" — a measurement that never
    // happened, reported as a fact about the org.
    const r = run({ preflightStatus: "403" });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /preflight DID NOT RUN \(HTTP 403\)/);
    assert.equal(monitorCalls(r.curlLog, "POST"), 0, "nothing may be created");
    assert.equal(monitorCalls(r.curlLog, "PUT"), 0, "nothing may be updated");
  });

  it("the two outcomes are distinguishable by MESSAGE, not just by exit code", () => {
    // Both exit non-zero. If they said the same thing an operator could not
    // tell "fix your key" from "the crawl stopped".
    const empty = run({ emptyFor: "oldest_unacked_message_age" });
    const broken = run({ preflightStatus: "403" });
    assert.ok(!empty.stderr.includes("DID NOT RUN"));
    assert.ok(!broken.stderr.includes("no points in 1h"));
  });

  it("the failure RATIO preflights its denominator, never its numerator", () => {
    // A numerator preflight would refuse this row in exactly the state it
    // exists to detect the end of: no 5xx anywhere is the healthy estate, and a
    // healthy estate must not be a reason to skip creating the alarm.
    const r = run({ emptyFor: "remote_server_5xx" });
    assert.equal(
      r.code,
      0,
      "an empty 5xx series is HEALTH — it must not refuse the failure-rate row",
    );
    assert.match(r.stdout, /applied 9/);
  });

  it("the scheduler row preflights the UN-SLICED log series", () => {
    // `severity:error` is empty on a healthy day (2 entries per job per month)
    // while the log itself carries one INFO entry per attempt. Preflighting the
    // sliced series would refuse the row on every healthy estate.
    const r = run({});
    const preflights = r.curlLog
      .split("\n")
      .filter(
        (l) => l.includes("/api/v1/query") && l.includes("log_entry_count"),
      );
    assert.ok(preflights.length >= 1, "the scheduler row never preflighted");
    for (const p of preflights)
      assert.ok(
        !p.includes("severity"),
        `the scheduler preflight is sliced by severity:\n  ${p}`,
      );
  });
});

describe("apply-perf-monitors — idempotence and pruning", () => {
  it("a second run UPDATES all nine and creates none", () => {
    const r = run({ listing: listingFor(PROD) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(monitorCalls(r.curlLog, "PUT"), 9);
    assert.equal(monitorCalls(r.curlLog, "POST"), 0);
    assert.equal(monitorCalls(r.curlLog, "DELETE"), 0, "nothing to prune");
  });

  it("an orphan under this script's tag is DELETED", () => {
    // This managed tag is the script's own namespace, so a monitor carrying it
    // that the script did not render is an orphan by definition. The two older
    // scripts SHARE a tag and therefore cannot do this.
    const r = run({
      listing: [
        ...listingFor(PROD),
        {
          id: 999,
          name: "[production] stale perf monitor",
          query: "avg(last_5m):avg:gcp.gone{*} > 1",
        },
      ],
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(monitorCalls(r.curlLog, "DELETE"), 1);
    assert.match(r.curlLog, /\/api\/v1\/monitor\/999/);
    assert.match(r.stdout, /pruned \[production\] stale perf monitor \(#999\)/);
    assert.match(r.stdout, /pruned 1 of 9 rows/);
  });

  it("the prune sits behind BOTH guards — not a dry run, and nothing refused", () => {
    // Without a listing there is nothing to compare against, so a dry run's
    // claim about orphans would have no evidence behind it. (The offline stub
    // in `render` already proves a dry run reaches no network at all.) And a
    // run with a refused row has an INCOMPLETE rendered set, so "not in the
    // rendered set" is not evidence of an orphan either.
    const at = SCRIPT_SRC.indexOf("dd_prune_managed ");
    assert.notStrictEqual(at, -1, "the prune call is gone");
    const before = SCRIPT_SRC.slice(0, at);
    const dryGuard = before.lastIndexOf("if ! $DRY_RUN; then");
    const failedGuard = before.lastIndexOf("${#FAILED[@]} > 0");
    assert.ok(dryGuard !== -1, "the prune is not guarded on DRY_RUN");
    assert.ok(
      failedGuard > dryGuard,
      "the prune is not guarded on the refused-row count inside the DRY_RUN guard",
    );
  });
});

describe("apply-perf-monitors — --only=verify answers 'are we in sync?'", () => {
  const VERIFY = ["prod", "--only=verify"];

  it("in sync: exit 0, and NOT ONE write", () => {
    const r = run({ args: VERIFY, listing: listingFor(PROD) });
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /in both\s+9/);
    assert.equal(monitorCalls(r.curlLog, "POST"), 0);
    assert.equal(monitorCalls(r.curlLog, "PUT"), 0);
    assert.equal(monitorCalls(r.curlLog, "DELETE"), 0);
  });

  it("a row never applied is reported as 'only in code', exit 3", () => {
    const r = run({ args: VERIFY, listing: listingFor(PROD).slice(1) });
    assert.equal(r.code, 3);
    assert.match(r.stdout, /only in code\s+1/);
    assert.ok(r.stdout.includes(PROD[0]!.name));
  });

  it("a monitor the script no longer renders is reported as an orphan, exit 3", () => {
    const r = run({
      args: VERIFY,
      listing: [
        ...listingFor(PROD),
        { id: 999, name: "[production] a monitor nobody renders", query: "x" },
      ],
    });
    assert.equal(r.code, 3);
    assert.match(r.stdout, /only in Datadog\s+1/);
    assert.ok(r.stdout.includes("a monitor nobody renders"));
  });

  it("a monitor EDITED IN THE UI is caught, even though its title still matches", () => {
    // The drift that matters most, and the one a name comparison cannot see:
    // somebody widening a threshold or rewriting a scope in the browser keeps
    // the title. Names alone would report "in sync 9".
    const listing = listingFor(PROD);
    listing[3] = {
      ...listing[3]!,
      query:
        "avg(last_15m):avg:gcp.run.request_latency.user_execution.p95{*} > 9999999",
    };
    const r = run({ args: VERIFY, listing });
    assert.equal(r.code, 3);
    assert.match(r.stdout, /in both\s+9/, "the NAME still matches");
    assert.ok(
      r.stdout.includes(`query differs: ${PROD[3]!.name}`),
      `expected a query-drift report, got:\n${r.stdout}`,
    );
  });
});

describe("apply-perf-monitors — a QA run must never touch PRODUCTION", () => {
  it("the listing is ENV-SCOPED, so a qa run cannot prune prod monitors", () => {
    // The worst bug either review found, reproduced before it was fixed:
    // `monitor_tags` filtered on the managed tag ALONE, so a qa listing
    // contained the production monitors. Rows 4-9 are prod-only and `continue`
    // with SKIPPED++ without reaching the rendered set — exactly like a refused
    // row, but FAILED stays EMPTY, so the refused-row guard did not catch it.
    // `DD_QA_MONITORING=on apply-perf-monitors.sh qa` then issued DELETEs
    // against `[production]` monitors: the first qa run after that switch is
    // flipped would have deleted every prod perf monitor with its history and
    // its mute state, and reported success.
    const r = run({
      args: ["qa"],
      env: { DD_QA_MONITORING: "on" },
      listing: [
        {
          id: 100,
          name: "[production] Pub/Sub — oldest unacked message age",
          query: "x",
        },
        {
          id: 101,
          name: "[production] Cloud Run workers — instances at maxScale",
          query: "y",
        },
      ],
    });
    assert.equal(
      monitorCalls(r.curlLog, "DELETE"),
      0,
      `a qa run deleted production monitors:\n${r.stdout}`,
    );
    assert.ok(!/pruned \[production\]/.test(r.stdout), r.stdout);
  });

  it("the env term is actually in the listing request", () => {
    // The mechanism, not just its effect — so this stays red if somebody
    // "simplifies" the tag back to the managed one alone.
    const r = run({ args: ["qa"], env: { DD_QA_MONITORING: "on" } });
    const listings = r.curlLog
      .split("\n")
      .filter((l) => l.includes("-X GET") && l.includes("/api/v1/monitor"));
    assert.ok(listings.length >= 1, "the script never listed");
    for (const l of listings)
      assert.match(
        l,
        /env%3Aqa/,
        `the managed listing is not env-scoped:\n  ${l}`,
      );
  });
});

describe("apply-perf-monitors — saturation is judged per REVISION", () => {
  it("instance_count groups by revision_name as well as service_name", () => {
    // maxScale is a per-REVISION annotation and two revisions overlap on every
    // deploy, so summing them into one service figure crosses 18 while neither
    // revision is near its own cap of 20 — trading the silent miss `max:` gave
    // for a false page on every rollout. Per revision, the threshold means what
    // it was sized to mean.
    for (const n of ["workers — instances", "us-fundamentals — instances"])
      assert.match(
        byName(n).query,
        /by \{service_name,revision_name\}/,
        `${n} is not grouped per revision`,
      );
  });
});

describe("dd_verify_managed — the EXCLUSIVE flag is validated", () => {
  it("refuses anything but the literal true/false", () => {
    // A caller that omits the flag consumes the first rendered NAME as it: that
    // name vanishes from the code side, lands in the ignored bucket, and the
    // run reports in sync while under-reporting by one.
    const lib = readFileSync(
      join(ROOT, "scripts/ops/datadog/lib-datadog.sh"),
      "utf8",
    );
    const fn = lib.slice(lib.indexOf("dd_verify_managed() {"));
    assert.match(
      fn.slice(0, fn.indexOf("dd_list_managed")),
      /case "\$exclusive" in\s*\n\s*true\|false\)/,
      "the flag is not validated before use",
    );
    const r = execFileSync(
      "bash",
      [
        "-c",
        // No `-e`: the subshell exits non-zero BY DESIGN here, and under
        // `set -e` that would kill the harness before it could report.
        `set -uo pipefail; DRY_RUN=false; DD_API_HOST=x; ` +
          `source ${JSON.stringify(join(ROOT, "scripts/ops/datadog/lib-datadog.sh"))}; ` +
          // A SUBSHELL: the guard calls `exit`, which terminates the shell
          // rather than returning a status, so `||` on a bare call never runs.
          `( dd_verify_managed tag NOT_A_FLAG name ) 2>&1; echo "EXIT=$?"`,
      ],
      { encoding: "utf8" },
    );
    assert.match(r, /must be literally/, r);
    assert.match(r, /EXIT=1/, "the guard must be fatal, not a warning");
  });

  it("every call site passes it, and the perf script is the only exclusive one", () => {
    // `exclusive=true` on a SHARED tag is the permanently-red verify this flag
    // exists to prevent; `false` on the perf script would silently disable the
    // only orphan detection that works.
    const dir = join(ROOT, "scripts/ops/datadog");
    const calls: Record<string, string> = {};
    for (const f of [
      "apply-monitors.sh",
      "apply-service-monitors.sh",
      "apply-perf-monitors.sh",
    ]) {
      const src = readFileSync(join(dir, f), "utf8");
      const m = /dd_verify_managed "\$LIST_TAG" (true|false)/.exec(src);
      assert.ok(m, `${f} does not call dd_verify_managed with a literal flag`);
      calls[f] = m[1]!;
    }
    assert.equal(calls["apply-perf-monitors.sh"], "true");
    assert.equal(calls["apply-monitors.sh"], "false");
    assert.equal(calls["apply-service-monitors.sh"], "false");
  });
});

describe("apply-perf-monitors — LIST_TAG keeps the MANAGED tag, not just the env", () => {
  it("is derived from MANAGED_TAG, in the one script that can DELETE", () => {
    // The env term is the one the surrounding comment argues for, which makes
    // `LIST_TAG="env:${DD_ENV_TAG}"` a plausible "simplification". It would be
    // the same wipe this branch already fixed, arriving through the other door:
    // `dd_list_managed` would return every monitor tagged env:production — the
    // ~79 owned by the two other scripts included — and this is the ONLY script
    // that prunes. The equivalent guard elsewhere sits on apply-monitors.sh,
    // which cannot delete and whose worst case is a duplicate POST.
    assert.match(
      SCRIPT_SRC,
      /LIST_TAG="\$\{MANAGED_TAG\},env:\$\{DD_ENV_TAG\}"/,
      "LIST_TAG must be the managed tag AND the env — dropping either end is a " +
        "cross-scope listing, and this script deletes what it does not render",
    );
  });

  it("a correctly scoped listing never sees another script's monitors", () => {
    // Driven through the stub so the CONSEQUENCE fails rather than the spelling:
    // the stub returns the foreign monitors only when the managed term is
    // absent from the request.
    const r = run({ listing: listingFor(PROD) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      monitorCalls(r.curlLog, "DELETE"),
      0,
      `a correctly scoped listing pruned something:\n${r.stdout}`,
    );
    assert.ok(
      !/apply-monitors\.sh/.test(r.stdout),
      "another script's monitor appeared in this script's listing",
    );
  });
});

describe("apply-perf-monitors — a retired revision must not page", () => {
  it("the revision-grouped rows do NOT notify on no data", () => {
    // A Cloud Run revision name changes on every release and the retired
    // revision stops emitting within minutes — measured 2026-09-11: two
    // revisions in 24h, the older one's series already ended. Datadog keeps a
    // metric monitor's groups for ~24h and `group_retention_duration` is not
    // settable here, so notify_no_data on a revision-grouped row is a page on
    // every deploy, re-notifying hourly. That is the false page that grouping
    // by revision was introduced to REMOVE.
    for (const n of ["workers — instances", "us-fundamentals — instances"]) {
      const m = byName(n);
      assert.match(m.query, /by \{service_name,revision_name\}/, n);
      assert.equal(
        m.options.notify_no_data,
        false,
        `${n} groups by an EPHEMERAL key, so it must not page when a group ` +
          "disappears — that happens on every deploy",
      );
    }
  });

  it("the crawl-alive signal is carried by rows that are NOT ephemeral", () => {
    // Dropping notify_no_data above is only safe because these rows keep it
    // and group by nothing that changes on a deploy.
    const keepers = PROD.filter((m) => m.options.notify_no_data);
    assert.ok(
      keepers.length >= 4,
      `only ${keepers.length} rows page on silence`,
    );
    for (const m of keepers)
      assert.ok(
        !/revision_name/.test(m.query),
        `${m.name} pages on no-data while grouping by an ephemeral key`,
      );
  });

  it("the saturation rows are preflighted BY THE GROUP", () => {
    // "the metric has points" says nothing about whether the crawl imports
    // `revision_name`; a `by {}` over a tag nobody emits returns zero series
    // and the monitor sits in permanent NO DATA — the one thing this file
    // exists to refuse.
    const r = run({});
    const grouped = r.curlLog
      .split("\n")
      .filter(
        (l) => l.includes("instance_count") && l.includes("/api/v1/query"),
      );
    assert.ok(grouped.length >= 2, "the saturation rows never preflighted");
    for (const l of grouped)
      assert.match(
        l,
        /revision_name/,
        `the preflight does not cover the group it alerts on:\n  ${l}`,
      );
  });
});
