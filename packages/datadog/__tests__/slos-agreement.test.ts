/**
 * MONEY-1360 — the four SLOs measure the estate that exists, and refuse to
 * measure nothing.
 *
 * ## The defect this file is aimed at
 *
 * A monitor-based SLO over ZERO monitors is 100% compliant forever. It renders
 * green, burns no error budget, and is indistinguishable from a pipeline that
 * never failed. So is one over 1 monitor when the estate has 40. Both are the
 * "reads healthy because it measures nothing" shape of MONEY-1238, promoted one
 * layer up — and an SLO is worse than a monitor there, because a monitor in NO
 * DATA at least shows a grey dot, while an empty SLO shows 100.00%.
 *
 * The strongest thing available is therefore not a shape check on the JSON. It
 * is a JOIN: take the monitor names `apply-monitors.sh` actually renders for
 * prod, apply the patterns and name lists `slos.json` stores, and assert on the
 * COUNT. Both
 * sides come from the repo, so the assertion is about their agreement rather
 * than about either one's contents — which is the only kind that survives an
 * edit to one of them.
 *
 * ## Why the renders are spawned rather than imported
 *
 * The chain under test is slos.json -> apply-slos.sh -> lib-datadog.sh ->
 * body. Every historical defect in this directory lives in the middle of that
 * chain (an unstripped `_` key rejected with a 400, a threshold sent as a
 * string, a name that never matches so every run POSTs a duplicate). Only
 * running the real script sees them.
 *
 * The dry-run spawns get a `curl` that cannot reach the network and logs every
 * call; the log is asserted EMPTY, so "a dry run touches nothing" is a checked
 * property rather than a comment. The live-path cases get a `curl` that answers
 * each endpoint kind with a different body, because one body cannot satisfy
 * both the monitor listing (a JSON array) and the SLO search (an object with
 * `data`) — and answering the listing with the wrong shape aborts the script on
 * "not a JSON array", which looks exactly like the fail-closed behaviour under
 * test and would make these cases pass for the wrong reason.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The emitted names, from the module that emits them — the same derivation
// `dashboards-agreement.test.ts` builds its inventory on. Restating
// "stockbook.job.written" here would agree with the emitter exactly until
// someone renames it, which is the day the SLO silently becomes 0/0.
import { EMITTED_JOB_METRICS } from "../src/job-outcome";
// The workers' SERVER span, from its one declaration — MONEY-1534. slos.json is
// JSON and cannot import it, so the row carries a literal and this holds the
// literal to the constant, as site-agreement.test.ts does for DD_SITE.
import { DD_SERVER_SPAN } from "../src/constants";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DIR = join(ROOT, "scripts/ops/datadog");
const SCRIPT = join(DIR, "apply-slos.sh");
const MONITORS_SCRIPT = join(DIR, "apply-monitors.sh");
const LIB = join(DIR, "lib-datadog.sh");
const SLOS_FILE = join(DIR, "slos.json");
const SCRIPT_SRC = readFileSync(SCRIPT, "utf8");

interface SloRow {
  name: string;
  type: "monitor" | "metric";
  monitor_name_pattern?: string;
  min_monitors?: number;
  /** An exact set, used where Datadog's 20-monitor cap forces a declared subset. */
  monitor_names?: string[];
  description?: string;
  query?: { numerator: string; denominator: string };
  thresholds: { timeframe: string; target: number }[];
}
interface SloBody {
  name: string;
  type: string;
  thresholds: { timeframe: string; target: number }[];
  tags: string[];
  description?: string;
  monitor_ids?: number[];
  query?: { numerator: string; denominator: string };
}

/** Datadog refuses a monitor SLO carrying more than this many ids, with a 400. */
const MONITOR_IDS_CAP = 20;

const ROWS: SloRow[] = JSON.parse(readFileSync(SLOS_FILE, "utf8"));

/**
 * A `curl` that cannot reach the network, first on PATH for every dry-run.
 *
 * `--dry-run` is a BRANCH in a shell script, and this directory has shipped two
 * bugs in exactly that branch. The guarantee is moved off the branch and onto
 * the process: no credentials, and a `curl` that logs and exits non-zero.
 */
const NO_NET = mkdtempSync(join(tmpdir(), "slos-offline-"));
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

function offlineRun(script: string, args: string[]): string {
  const childEnv = { ...process.env };
  delete childEnv.DD_API_KEY;
  delete childEnv.DD_APP_KEY;
  delete childEnv.DD_NOTIFY;
  return execFileSync("bash", [script, ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: {
      ...childEnv,
      PATH: `${NO_NET}:${childEnv.PATH ?? ""}`,
      STUB_LOG: NO_NET_LOG,
    },
  });
}

const bodiesIn = <T>(stdout: string): T[] =>
  stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as T);

const PROD_STDOUT = offlineRun(SCRIPT, ["prod", "--dry-run"]);
const QA_STDOUT = offlineRun(SCRIPT, ["qa", "--dry-run"]);
const PROD = bodiesIn<SloBody>(PROD_STDOUT);
const QA = bodiesIn<SloBody>(QA_STDOUT);

/**
 * The names `apply-monitors.sh` actually renders for prod.
 *
 * THE OTHER HALF OF THE JOIN, and the reason this file is not a JSON schema
 * test. A pattern is only correct relative to the estate it is matched
 * against, and the estate lives in a different script — so it is rendered here
 * rather than restated. A restated list agrees with the templates exactly until
 * somebody renames one, which is the day the SLO silently starts measuring
 * nothing.
 *
 * Its dry-run indents each body by two spaces, hence the trim in `bodiesIn`.
 */
const MONITOR_BODIES = bodiesIn<{ name: string; query: string }>(
  offlineRun(MONITORS_SCRIPT, ["prod", "--dry-run"]),
);
const MONITOR_NAMES: string[] = MONITOR_BODIES.map((m) => m.name);

/**
 * The monitors a row resolves against the REAL estate — mirroring the two
 * selection shapes `apply-slos.sh` supports, name list first.
 */
const matchesFor = (row: SloRow): string[] =>
  row.monitor_names
    ? MONITOR_NAMES.filter((n) => row.monitor_names!.includes(n))
    : MONITOR_NAMES.filter((n) =>
        new RegExp(row.monitor_name_pattern!).test(n),
      );

/**
 * The two monitor FAMILIES `apply-monitors.sh` renders, as the estate has them.
 *
 * Both are the denominator of a declared subset, and both are over Datadog's
 * 20-id cap — 40 and 24 as of MONEY-1229. Derived rather than restated so the
 * coverage arithmetic below moves with the estate.
 */
const ZERO_WRITE_NAMES = MONITOR_NAMES.filter((n) =>
  / wrote nothing but had work to do$/.test(n),
);
const ABSENCE_NAMES = MONITOR_NAMES.filter((n) =>
  / has not reported a run in .*$/.test(n),
);

/** The family a declared name belongs to, and how many of them exist. */
const familyOf = (name: string): string[] =>
  ZERO_WRITE_NAMES.includes(name) ? ZERO_WRITE_NAMES : ABSENCE_NAMES;

/** The rows that name their monitors outright because the cap forced a subset. */
const DECLARED = (): SloRow[] => ROWS.filter((r) => r.monitor_names);

/**
 * How many managed monitors each pattern MUST reach, stated here and not read
 * from `slos.json`.
 *
 * Reading the floor out of the file it guards is the vacuous version: narrow
 * the pattern and drop `min_monitors` to 0 in the same edit and the test still
 * passes. These are the measured estate as of MONEY-1360 (40 zero-write, 4
 * absence, 1 latency), floored well below so that adding a job does not turn
 * this red — the direction that matters is DOWNWARD.
 *
 * MONEY-1229 — the zero-write row is EXACT, and that is the one place the
 * "floored well below" rule is inverted on purpose. It names 16 monitors
 * outright because Datadog refused the whole estate ("Maximum number of
 * elements in parameter 'monitor_ids' should be 20" against 40 ids), and a
 * declared subset is only honest while it is exactly what it says: 15 means a
 * template was renamed and one job fell out silently, 17 means somebody widened
 * the budget without touching the caveat on the object.
 *
 * THREE entries. The count is asserted explicitly below so that deleting a row
 * from `slos.json` and its floor from here in one edit still fails.
 */
const REQUIRED_MATCHES: Record<string, { atLeast: number; exactly?: number }> =
  {
    "[production] Scheduled jobs write what they select": {
      atLeast: 16,
      exactly: 16,
    },
    "[production] Scheduled jobs run": { atLeast: 11, exactly: 11 },
    "[production] EDGAR detection under 5 minutes": { atLeast: 1, exactly: 1 },
  };

/**
 * The `stockbook.`/`trace.` series names a query reads, in order.
 *
 * Used to join an SLO's ratio to the code that emits it. A ratio is only as
 * good as its series existing: name one nothing emits and it is 0/0, which
 * Datadog renders as no data and a reader renders as fine — the same
 * "reads healthy because it measures nothing" shape this file is about, in the
 * one SLO type `min_monitors` cannot protect.
 */
const seriesIn = (query: string): string[] =>
  [...query.matchAll(/\bsum:([a-z][a-z0-9_.]*)\{/g)].map((m) => m[1]!);

/**
 * Run the REAL script against a stubbed curl and report what curl saw AND what
 * it was handed.
 *
 * Bodies are captured by scanning the argv for `-d`, not by regexing the joined
 * command line: `dd_request` passes `-w $'\n%{http_code}'`, whose literal
 * newline splits a logged call across two lines, so any line-oriented parse of
 * the sent JSON is wrong in a way that reads as "no body was sent".
 */
function runWithStubbedCurl(opts: {
  listing: string;
  sloSearch?: string;
  preflight?: string;
  status?: string;
  /**
   * Answer `{"series":[]}` only to the `/api/v1/query` whose URL contains this.
   *
   * There are TWO metric SLOs since MONEY-1229 and one `preflight` body answers
   * both, so "an empty denominator" would refuse every metric row at once —
   * which cannot distinguish "one row was refused and the rest still applied"
   * from "the run stopped". Pass a METRIC NAME: `encodeURIComponent` leaves
   * dots alone, so the name survives into the URL verbatim while the braces and
   * colons around it do not.
   */
  emptyPreflightFor?: string;
}): {
  code: number;
  stdout: string;
  stderr: string;
  curlLog: string;
  sent: SloBody[];
} {
  const dir = mkdtempSync(join(tmpdir(), "slos-stub-"));
  const log = join(dir, "calls.log");
  const bodies = join(dir, "bodies.log");
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
        "prev=",
        'for a in "$@"; do',
        '  if [ "$prev" = "-d" ]; then printf "%s\\n" "$a" >> "$STUB_BODIES"; fi',
        "  prev=$a",
        "done",
        'case "$*" in',
        '  *"/api/v1/monitor"*) body="$STUB_LISTING" ;;',
        '  *"/api/v1/query"*)',
        '    body="$STUB_PREFLIGHT"',
        // Guarded on non-empty: `*""*` matches every string, so an unset
        // override would empty EVERY preflight — the stub silently answering
        // the opposite of what the default says.
        '    if [ -n "$STUB_EMPTY_FOR" ]; then',
        '      case "$*" in *"$STUB_EMPTY_FOR"*) body=\'{"series":[]}\' ;; esac',
        "    fi",
        "    ;;",
        '  *"/api/v1/slo"*)     body="$STUB_SLO_SEARCH" ;;',
        '  *) body="{}" ;;',
        "esac",
        'printf "%s\\n%s\\n" "$body" "$STUB_STATUS"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(log, "");
    writeFileSync(bodies, "");
    const res = spawnSync("bash", [SCRIPT, "prod"], {
      encoding: "utf8",
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        STUB_LOG: log,
        STUB_BODIES: bodies,
        STUB_LISTING: opts.listing,
        STUB_SLO_SEARCH: opts.sloSearch ?? '{"data":[]}',
        STUB_PREFLIGHT: opts.preflight ?? '{"series":[{"pointlist":[[0,1]]}]}',
        STUB_EMPTY_FOR: opts.emptyPreflightFor ?? "",
        STUB_STATUS: opts.status ?? "200",
        DD_API_KEY: "stub-api-key",
        DD_APP_KEY: "stub-app-key",
      },
    });
    return {
      code: res.status ?? -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      curlLog: readFileSync(log, "utf8"),
      sent: readFileSync(bodies, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as SloBody),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Calls to one endpoint by verb, so a preflight GET is not counted as a listing. */
const countCalls = (curlLog: string, method: string, path: string): number =>
  curlLog
    .split("\n")
    .filter((l) => l.includes(`-X ${method} `) && l.includes(path)).length;

/** A listing whose names are the real estate, with ids assigned positionally. */
const REAL_LISTING = JSON.stringify(
  MONITOR_NAMES.map((name, i) => ({ id: 1000 + i, name })),
);

describe("MONEY-1360 — slos.json describes four SLOs over the real estate", () => {
  it("PREMISE: the prod dry run rendered something to assert on", () => {
    // Without a floor every assertion below passes over an empty array — the
    // shape where a spawn silently produces nothing and the suite reports green.
    assert.ok(PROD.length >= 4, `prod rendered ${PROD.length} bodies`);
    assert.equal(PROD.length, ROWS.length, "a row rendered nothing");
  });

  it("PREMISE: apply-monitors.sh rendered an estate to match against", () => {
    // The other half of the join. If this spawn produced nothing, every count
    // assertion below would be comparing 0 to 0.
    assert.ok(
      MONITOR_NAMES.length >= 40,
      `only ${MONITOR_NAMES.length} prod monitors rendered`,
    );
  });

  it("PREMISE: neither dry run made an HTTP call", () => {
    assert.equal(
      readFileSync(NO_NET_LOG, "utf8"),
      "",
      "a --dry-run reached curl; it must never touch the Datadog API",
    );
  });

  it("renders exactly the four SLOs the plan names", () => {
    // An exact set, not a count: a deleted row and a renamed row are the same
    // failure from the board's point of view — the SLO the dashboard widget
    // resolves by name is gone — and a length check sees neither.
    assert.deepEqual(
      PROD.map((s) => s.name).sort(),
      [
        "[production] EDGAR detection under 5 minutes",
        "[production] Scheduled jobs run",
        "[production] Scheduled jobs write what they select",
        "[production] Workers request success",
      ],
      "the SLO set changed; dashboards resolve these BY NAME",
    );
  });

  it("each SLO has the type and target the plan fixes", () => {
    // Type and target together. `type` decides which half of the body Datadog
    // reads — a `monitor` SLO carrying a `query` is an SLO over no monitors,
    // which is 100% forever — and the target is the number the budget is
    // arithmetic over: 99.5 over 30d is 3.6h of budget, 99 is 7.2h.
    const expected: Record<string, { type: string; target: number }> = {
      // MONITOR, over a DECLARED subset. It was a metric SLO for one release —
      // `sum(job.written) / sum(job.selected)` across every job — on the claim
      // that a ratio asks the monitors' question of the counters they are
      // computed from. It does not: the counters are per-job units (documents
      // vs rows, funds vs NAV rows, symbols vs event rows), so the estate-wide
      // numerator EXCEEDS the denominator and Datadog clamps the SLI to 100%
      // forever. The `type` here is therefore load-bearing rather than
      // bookkeeping, and `no metric SLO is built from the per-job counters`
      // below is the guard that keeps it from being converted back.
      "[production] Scheduled jobs write what they select": {
        type: "monitor",
        target: 99.5,
      },
      "[production] Scheduled jobs run": { type: "monitor", target: 99.9 },
      "[production] Workers request success": { type: "metric", target: 99 },
      "[production] EDGAR detection under 5 minutes": {
        type: "monitor",
        target: 99,
      },
    };
    for (const slo of PROD) {
      const want = expected[slo.name];
      assert.ok(want, `unexpected SLO "${slo.name}"`);
      assert.equal(slo.type, want.type, `${slo.name} type`);
      assert.equal(slo.thresholds.length, 1, `${slo.name} threshold count`);
      assert.equal(
        slo.thresholds[0]!.target,
        want.target,
        `${slo.name} target`,
      );
      assert.equal(
        typeof slo.thresholds[0]!.target,
        "number",
        `${slo.name} target is a ${typeof slo.thresholds[0]!.target} — Datadog ` +
          "rejects a threshold that arrives as a string",
      );
    }
  });

  it("every threshold is a 30-day window", () => {
    // 30d is what makes the number comparable month to month and what the
    // dashboard SLO widgets are configured for. A 7d window is a different
    // measurement wearing the same name.
    for (const slo of PROD) {
      for (const t of slo.thresholds) {
        assert.equal(t.timeframe, "30d", `${slo.name} timeframe`);
      }
    }
  });

  it("the body carries the apply-slos tag and an env tag, not the monitor tag", () => {
    // The upsert finds an existing SLO by NAME, but the tag is how a human (and
    // T8's dashboards) tells generated SLOs from hand-made ones. Tagging them
    // `managed-by:apply-monitors` would put them in the listing THIS script
    // reads to resolve monitor ids.
    for (const slo of PROD) {
      assert.ok(
        slo.tags.includes("managed-by:apply-slos"),
        `${slo.name} tags: ${JSON.stringify(slo.tags)}`,
      );
      assert.ok(
        slo.tags.includes("env:production"),
        `${slo.name} has no env:production tag`,
      );
      assert.ok(
        !slo.tags.includes("managed-by:apply-monitors"),
        `${slo.name} would appear in the monitor listing it resolves against`,
      );
    }
  });

  it("no body leaks a field Datadog does not accept", () => {
    // `_why`, `monitor_name_pattern` and `min_monitors` are OURS. Datadog
    // rejects an unknown field with a 400 that names it, and lib-datadog.sh
    // carries the scar of a strip that only reached the top level.
    const allowed = new Set([
      "name",
      "type",
      "thresholds",
      "tags",
      "monitor_ids",
      "query",
      "description",
    ]);
    for (const slo of PROD) {
      for (const key of Object.keys(slo)) {
        assert.ok(allowed.has(key), `${slo.name} carries "${key}"`);
      }
      assert.equal(
        JSON.stringify(slo).includes("{{"),
        false,
        `${slo.name} has an unsubstituted placeholder`,
      );
    }
  });

  it("qa renders NOTHING and says so", () => {
    // A script that accepts an environment and silently does nothing is
    // indistinguishable from one that ran and found no work. The message is the
    // difference, so it is asserted rather than assumed.
    assert.equal(QA.length, 0, "qa rendered an SLO body");
    assert.match(QA_STDOUT, /prod-only/);
    assert.match(QA_STDOUT, /of 0 rows \(qa\)/);
  });
});

describe("MONEY-1360 — the patterns resolve the estate that exists", () => {
  it("every monitor SLO's pattern reaches enough real monitors", () => {
    // THE JOIN. A pattern is only correct relative to the estate, and the
    // estate is rendered by another script from templates in the same
    // directory — so a template rename that orphans a pattern is caught here
    // and nowhere else. The floors are stated in this file on purpose: read out
    // of slos.json they would move with the pattern in a single edit.
    let checked = 0;
    for (const row of ROWS.filter((r) => r.type === "monitor")) {
      const want = REQUIRED_MATCHES[row.name];
      assert.ok(want, `no floor declared for "${row.name}"`);
      const hits = matchesFor(row);
      checked += 1;
      assert.ok(
        hits.length >= want.atLeast,
        `"${row.name}" matches ${hits.length} of ${MONITOR_NAMES.length} ` +
          `monitors, needs >= ${want.atLeast}. pattern: ${row.monitor_name_pattern}`,
      );
      if (want.exactly !== undefined) {
        assert.equal(
          hits.length,
          want.exactly,
          `"${row.name}" names one specific monitor and matched ${hits.length}: ` +
            JSON.stringify(hits),
        );
      }
      // The declared floor, whichever shape the row uses. A name list IS its
      // own floor — every name must resolve — so it is read from the list
      // length, and a row that declares neither has no fail-closed guard at
      // all.
      const declaredFloor = row.monitor_names
        ? row.monitor_names.length
        : (row.min_monitors ?? 0);
      assert.ok(
        declaredFloor >= want.atLeast,
        `"${row.name}" declares a floor of ${declaredFloor}, which is ` +
          `below the ${want.atLeast} the estate supports — the script's own ` +
          "fail-closed guard would let a narrowed selection through",
      );
    }
    // THREE. Asserted as an exact count so that deleting a monitor SLO — the
    // way an estate silently stops being measured — cannot pass as "every
    // remaining pattern is fine".
    assert.equal(checked, 3, `${checked} monitor SLOs were checked, not 3`);
    assert.equal(
      ROWS.filter((r) => r.type === "metric").length,
      1,
      "the metric SLO count changed; the case below covers it by name",
    );
  });

  it("the monitor SLOs do not overlap — one monitor, one SLO", () => {
    // Overlap is not fatal to Datadog, but it double-counts a failure against
    // two budgets and makes the two numbers move together for a reason nobody
    // can see on the board.
    const seen = new Map<string, string>();
    for (const row of ROWS.filter((r) => r.type === "monitor")) {
      for (const name of matchesFor(row)) {
        const prior = seen.get(name);
        assert.equal(
          prior,
          undefined,
          `"${name}" is claimed by both "${prior}" and "${row.name}"`,
        );
        seen.set(name, row.name);
      }
    }
    // 16 zero-write + 4 absence + 1 latency. It still bites in the direction
    // that matters: narrowing the absence pattern to a single job takes this
    // to 18, and dropping the zero-write name list to a token few takes it
    // below 21 without anything else changing.
    assert.ok(
      seen.size >= 21,
      `the three monitor SLOs cover only ${seen.size}`,
    );
  });

  it("the workers SLO's numerator subtracts errors from hits", () => {
    // The mutation that matters and is invisible: drop the `- errors` term and
    // the numerator EQUALS the denominator, so the SLO is 100.00% every day
    // forever — a perfect score for a service that is on fire.
    //
    // Found BY NAME. `ROWS.find(r => r.type === "metric")` was correct while
    // there was one metric SLO and silently became a test of the OTHER one when
    // MONEY-1229 added a second — passing over the wrong row is how an
    // assertion stops covering what it was written for without ever going red.
    const metric = ROWS.find(
      (r) => r.name === "[production] Workers request success",
    );
    assert.ok(metric?.query, "the workers SLO is gone from slos.json");
    assert.equal(metric.type, "metric");
    const { numerator, denominator } = metric.query;
    assert.notEqual(
      numerator,
      denominator,
      "numerator === denominator — this SLO is 100% forever by construction",
    );
    // MONEY-1534 — the DECLARED span, not a literal. This pinned
    // `trace.web.request.*` and stayed green for twelve days after the
    // workers' ESM loader let dd-trace's Hono plugin rename that span
    // `hono.request`, because a literal here can only agree with a literal in
    // slos.json. Now the SLO, the monitors and the dashboards answer to ONE
    // declaration, which the monitor preflight checks against the org on every
    // apply.
    const span = DD_SERVER_SPAN["stockbook-workers"];
    assert.ok(
      numerator.includes(
        `- sum:trace.${span}.errors{service:stockbook-workers,env:production}.as_count()`,
      ),
      `numerator does not subtract ${span} errors: ${numerator}`,
    );
    assert.equal(
      denominator,
      `sum:trace.${span}.hits{service:stockbook-workers,env:production}.as_count()`,
    );
    // It is the SERVER span. `http.request` is dd-trace-js's HTTP CLIENT span
    // (`client.http.opName`, node_modules/dd-trace/packages/dd-trace/src/
    // service-naming/schemas/v0/web.js:16), and this SLO read it for a release —
    // so a 99%/30d availability target was scored on our OUTBOUND calls to
    // NSE, BSE, Screener, Tiingo and Gemini. A vendor's holiday 404 storm
    // burned the budget; a job route 500ing on every Pub/Sub push did not
    // touch it. The denominator preflight cannot see this: the client series
    // genuinely has points, so `dd_metric_has_points` passes.
    for (const q of [numerator, denominator]) {
      assert.ok(
        !q.includes("trace.http.request."),
        `this reads dd-trace-js's CLIENT span, not the server span: ${q}`,
      );
    }
    for (const q of [numerator, denominator]) {
      // A ratio missing either predicate measures the whole org, or both
      // environments, under a name that claims one service in production.
      assert.ok(q.includes("service:stockbook-workers"), `unscoped: ${q}`);
      assert.ok(q.includes("env:production"), `unscoped: ${q}`);
    }
  });

  it("every DECLARED monitor name is one the estate actually renders", () => {
    // MONEY-1229. Two rows name an EXACT set rather than matching a pattern,
    // because Datadog caps a monitor SLO at 20 monitor_ids while the two
    // populations are 40 and 24 — so each subset is a decision, and a decision
    // has to be written down.
    //
    // THE JOIN is what makes a written-down list safe: every name is checked
    // against the monitors `apply-monitors.sh` actually renders. A template
    // rename, a retuned window (the window is IN an absence monitor's name) or
    // a job dropped from MONITORED_JOBS turns a name here into a dead string,
    // and Datadog would accept the smaller SLO without a word.
    const declared = DECLARED();
    assert.equal(declared.length, 2, "the declared-subset rows changed");
    for (const row of declared) {
      assert.equal(row.type, "monitor", `${row.name} is not a monitor SLO`);
      // Ours-only fields the PATTERN path reads. Left behind on a declared row
      // they are dead config that reads like an active guard.
      assert.equal(row.monitor_name_pattern, undefined, row.name);
      assert.equal(row.min_monitors, undefined, row.name);

      const missing = row.monitor_names!.filter(
        (n) => !MONITOR_NAMES.includes(n),
      );
      assert.deepEqual(
        missing,
        [],
        `"${row.name}": ${missing.length} declared monitors are not rendered ` +
          "by apply-monitors.sh — the SLO would silently cover fewer jobs",
      );
      assert.ok(
        row.monitor_names!.length <= MONITOR_IDS_CAP,
        `"${row.name}" declares ${row.monitor_names!.length} ids — Datadog ` +
          `refuses more than ${MONITOR_IDS_CAP} with a 400 that names the ` +
          "parameter and not the row",
      );
      // ONE FAMILY per row. The two subsets ask different questions of the same
      // spine, and a name from the other family would double-count one failure
      // against two budgets while looking like wider coverage.
      const family = familyOf(row.monitor_names![0]!);
      for (const n of row.monitor_names!) {
        assert.ok(
          family.includes(n),
          `"${row.name}" mixes monitor families: ${n}`,
        );
      }
      // The cap is only interesting while the population is bigger than it. If
      // one ever shrinks to fit, that subset should stop being a subset.
      assert.ok(
        family.length > MONITOR_IDS_CAP,
        `"${row.name}" covers a population of ${family.length}, which now fits ` +
          `under the ${MONITOR_IDS_CAP}-id cap — widen it to the whole set`,
      );
    }
  });

  it("each DECLARED subset states its real coverage in its description", () => {
    // The caveat has to travel WITH the object. `_why` lives in this repo; a
    // board reader sees a widget titled "Jobs write what they select" and a
    // number, and the number is over 16 of 40 jobs. `description` is the only
    // field that reaches them.
    //
    // Both numbers are RE-DERIVED from the rendered estate, so adding a
    // monitored job makes the description stale and this red — which is the
    // whole point. A hand-typed "16 of 40" that nobody re-checks is how a
    // scoped number quietly becomes believed to be a total one.
    for (const row of DECLARED()) {
      assert.ok(row.description, `${row.name} carries no description`);
      const covered = matchesFor(row).length;
      const total = familyOf(row.monitor_names![0]!).length;
      assert.ok(
        row.description.includes(`${covered} of the ${total}`),
        `"${row.name}" description does not say "${covered} of the ${total}": ` +
          row.description,
      );
      // And it reaches Datadog. The body is built field by field, so a field
      // the script does not copy is a caveat that exists only in git.
      const sent = PROD.find((s) => s.name === row.name);
      assert.equal(sent?.description, row.description, row.name);
    }
  });

  it("no metric SLO is built from the per-job counters", () => {
    // THE REGRESSION GUARD, and the reason this row is a monitor SLO at all.
    //
    // For one release it was `sum(stockbook.job.written){env:production} /
    // sum(stockbook.job.selected){env:production}`, on the claim that this asks
    // the zero-write monitors' question of the counters they are computed from.
    // It cannot, for three independent reasons:
    //
    //   1. THE COUNTERS ARE NOT COMMENSURABLE ACROSS JOBS. They are per-job
    //      units, not a shared one — `stock-document-ingest` reports
    //      `selected: 1` (one document) against `written: extractedRows`,
    //      `mf-nav-backfill` reports funds against NAV rows, `events-sync`
    //      symbols against event rows. Estate-wide, the numerator EXCEEDS the
    //      denominator and Datadog clamps the SLI to 100%. Permanently.
    //   2. AN UNFILTERED ENV TAG IS NOT A JOB FILTER — see the case below.
    //   3. It is insensitive to its own defect: one job selecting 500 and
    //      writing 0 for a month moves an estate-wide denominator by far less
    //      than the 0.5% budget.
    //
    // None of it is repairable in a ratio: a metric SLO takes one series per
    // side and cannot group by `job`, so the per-job conjunction the monitors
    // express with `clamp_max` has nowhere to live. The monitors are joined to
    // the emitted names by `monitor-agreement.test.ts`; what this asserts is
    // that no SLO tries to re-derive them from a sum.
    // `string[]`, not the literal union `Object.values` infers off the
    // `as const` — `includes` on a union type refuses a plain `string`, and
    // `yarn build` does not typecheck a test file (tsconfig.test.json does).
    const emitted: string[] = Object.values(EMITTED_JOB_METRICS);
    assert.ok(emitted.length >= 4, "EMITTED_JOB_METRICS collapsed");
    for (const row of ROWS.filter((r) => r.type === "metric")) {
      const series = [
        ...seriesIn(row.query!.numerator),
        ...seriesIn(row.query!.denominator),
      ];
      assert.ok(
        series.length > 0,
        `${row.name}: no series parsed from its query`,
      );
      for (const s of series) {
        assert.ok(
          !emitted.includes(s),
          `"${row.name}" divides ${s}, a per-job counter. Estate-wide these ` +
            "are not commensurable across jobs and the SLI pins at 100% — the " +
            "zero-write question belongs to the per-job MONITORS",
        );
      }
    }
  });

  it("PREMISE for the case above: a job outside MONITORED_JOBS emits the same counters", () => {
    // `candle-evict` is the measured example, and it is not hypothetical: it
    // ships disarmed (`CANDLE_EVICT_APPLY=false`), so a correct run reports
    // `selected: N, written: 0` every night. apply-monitors.sh excludes it from
    // MONITORED_JOBS for exactly that reason — an entry there would page
    // nightly in the configuration we ship.
    //
    // An estate-wide `{env:production}` sum has no such exclusion, so it burns
    // budget on the one job whose zero is correct. Asserted from both sides so
    // the case cannot pass because the file moved: it emits, and it is not
    // watched.
    const src = readFileSync(
      join(ROOT, "workers/src/processors/candle-evict.ts"),
      "utf8",
    );
    assert.match(
      src,
      /reportJobOutcome\(\{[\s\S]{0,200}?job: "candle-evict"/,
      "candle-evict no longer reports a job outcome — re-check the premise",
    );
    assert.ok(
      !ZERO_WRITE_NAMES.some((n) => n.includes("candle-evict")),
      "candle-evict is monitored now; the unfiltered-sum argument above needs " +
        "a new example",
    );
  });

  it("no pattern or query contains the ROW delimiter this repo's scripts use", () => {
    // Cheap, and it has bitten: the sibling scripts parse pipe-delimited rows.
    // A `|` inside a stored query is a field boundary somebody's next loop
    // splits on.
    for (const row of ROWS) {
      assert.doesNotMatch(JSON.stringify(row), /\|/, `"${row.name}" holds a |`);
    }
  });
});

describe("MONEY-1360 — the apply script fails closed", () => {
  it("CREATES one SLO per row, with the ids the pattern resolved", () => {
    // The positive control, and the count guard. `monitor_ids.length` is
    // asserted against the SAME estate the patterns were matched against, so
    // this catches a resolver that returns only the first hit, or one that
    // substring-matches where the pattern anchors — neither of which a
    // "resolved something" check can see.
    const run = runWithStubbedCurl({ listing: REAL_LISTING });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(
      countCalls(run.curlLog, "POST", "/api/v1/slo"),
      ROWS.length,
      "expected exactly one CREATE per row",
    );
    assert.equal(
      countCalls(run.curlLog, "GET", "/api/v1/monitor"),
      1,
      "the managed set is listed ONCE per run, not once per row",
    );
    assert.equal(countCalls(run.curlLog, "PUT", "/api/v1/slo"), 0);

    const byName = new Map(run.sent.map((b) => [b.name, b]));
    assert.equal(byName.size, ROWS.length, "a row was not sent");
    let totalIds = 0;
    for (const row of ROWS.filter((r) => r.type === "monitor")) {
      const sent = byName.get(row.name);
      assert.ok(sent, `${row.name} was never sent`);
      assert.equal(
        sent.monitor_ids?.length,
        matchesFor(row).length,
        `${row.name} was sent ${sent.monitor_ids?.length} ids for ` +
          `${matchesFor(row).length} matching monitors`,
      );
      totalIds += sent.monitor_ids!.length;
    }
    // An absolute floor on the estate covered, anchored outside slos.json: a
    // narrowed selection that drops its own floor in the same edit still fails
    // here. 21 = 16 zero-write + 4 absence + 1 latency.
    assert.ok(totalIds >= 21, `the three monitor SLOs cover only ${totalIds}`);

    // EVERY metric SLO must be sent WITHOUT monitor_ids and WITH a query — a
    // `monitor` type carrying a query is an SLO over no monitors, which is 100%
    // forever, and this loop is the one place the SENT body is inspected rather
    // than the row. Iterated rather than spot-checked on one name, so a second
    // metric SLO is covered by the case rather than by somebody remembering.
    const metrics = ROWS.filter((r) => r.type === "metric");
    assert.equal(metrics.length, 1, "the metric SLO set changed");
    for (const row of metrics) {
      const sent = byName.get(row.name);
      assert.ok(sent, `${row.name} was never sent`);
      assert.equal(sent.type, "metric");
      assert.equal(sent.monitor_ids, undefined, `${row.name} carries ids`);
      assert.ok(sent.query?.numerator, `${row.name} lost its numerator`);
      assert.ok(sent.query?.denominator, `${row.name} lost its denominator`);
    }
  });

  it("ABORTS when a pattern resolves fewer monitors than it needs", () => {
    // The heart of the ticket. A listing of real monitors that none of the
    // patterns reach must produce zero writes and a named failure, never an
    // empty SLO that reads 100%.
    const run = runWithStubbedCurl({
      listing: JSON.stringify([{ id: 1, name: "[production] something else" }]),
    });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /resolved 0 monitors/);
    // The FIRST monitor row in slos.json — the run stops there. Named rather
    // than left to `resolved 0 monitors` alone, because which row failed is
    // what an operator acts on.
    assert.match(
      run.stderr,
      /"\[production\] Scheduled jobs write what they select" resolved 0/,
    );
    assert.equal(countCalls(run.curlLog, "POST", "/api/v1/slo"), 0);
    assert.equal(countCalls(run.curlLog, "PUT", "/api/v1/slo"), 0);
    assert.equal(run.sent.length, 0, "a body was sent during an abort");
  });

  it("ABORTS on the PATTERN floor when the row it guards resolves nothing", () => {
    // The other selection shape. `min_monitors` is the floor under a pattern,
    // and the EDGAR latency row is the one that still uses it — an exact-name
    // pattern with a floor of 1, so a renamed latency template leaves an SLO
    // over nothing rather than an SLO over the wrong thing.
    //
    // Both DECLARED rows are SATISFIED here on purpose, so the abort under test
    // is the pattern floor and not an earlier row failing first. Without that,
    // this case would keep passing while the guard it names had been deleted.
    const satisfied = DECLARED()
      .flatMap((r) => r.monitor_names!)
      .map((name, i) => ({ id: 500 + i, name }));
    const run = runWithStubbedCurl({
      listing: JSON.stringify([
        ...satisfied,
        { id: 900, name: "[production] edgar-detect — p95 latency over 900s" },
      ]),
    });
    assert.notEqual(run.code, 0);
    // Both numbers, so a floor quietly lowered to match a narrowed pattern is
    // visible here rather than only in the row it was lowered in.
    assert.match(run.stderr, /resolved 0 monitors, needs at least 1\b/);
    assert.match(
      run.stderr,
      /"\[production\] EDGAR detection under 5 minutes"/,
    );
    assert.match(run.stderr, /pattern: /, "the pattern was not printed");
    assert.equal(countCalls(run.curlLog, "POST", "/api/v1/slo"), 0);
  });

  it("ABORTS when a DECLARED monitor name no longer exists", () => {
    // Zero is not the only bad count, and the name-list shape fails closed
    // differently from a pattern: there is no floor to fall below, every name
    // must resolve. 15 of 16 is an SLO over a subset of a subset, which Datadog
    // accepts without a word and which reads exactly like the full one.
    const names = DECLARED()[0]!.monitor_names!;
    const run = runWithStubbedCurl({
      listing: JSON.stringify(
        MONITOR_NAMES.filter((n) => n !== names[0]).map((name, i) => ({
          id: 1000 + i,
          name,
        })),
      ),
    });
    assert.notEqual(run.code, 0);
    assert.match(
      run.stderr,
      new RegExp(
        `resolved ${names.length - 1} monitors, needs at least ${names.length}\\b`,
      ),
    );
    assert.match(run.stderr, /names: /, "the declared set was not printed");
    assert.equal(countCalls(run.curlLog, "POST", "/api/v1/slo"), 0);
  });

  it("REFUSES a monitor SLO that would exceed Datadog's 20-id cap", () => {
    // The 400 this subset exists to avoid, refused locally instead. Datadog
    // answers "Maximum number of elements in parameter 'monitor_ids' should be
    // 20" — which names the parameter, not the row, and arrives after earlier
    // rows have already been written.
    //
    // Forced by DUPLICATING the declared names in the listing rather than by
    // editing slos.json: ids are what count, and a listing may legitimately
    // carry two monitors with one name (that is how the duplicate-monitor bug
    // in this directory presented).
    const names = DECLARED()[0]!.monitor_names!;
    const dupes = [
      ...MONITOR_NAMES.map((name, i) => ({ id: 1000 + i, name })),
      ...names.map((name, i) => ({ id: 9000 + i, name })),
    ];
    const run = runWithStubbedCurl({ listing: JSON.stringify(dupes) });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /caps a monitor SLO at 20 monitor_ids/);
    assert.equal(countCalls(run.curlLog, "POST", "/api/v1/slo"), 0);
  });

  it("aborts when the monitor listing cannot be parsed", () => {
    // curl exits 0 on a 403, so only an explicit check catches it. Read as "no
    // monitors exist", this is the previous case wearing a different hat.
    const run = runWithStubbedCurl({ listing: "not json at all" });
    assert.notEqual(run.code, 0);
    assert.equal(countCalls(run.curlLog, "POST", "/api/v1/slo"), 0);
  });

  it("aborts on a non-2xx to the monitor listing", () => {
    const run = runWithStubbedCurl({ listing: "[]", status: "403" });
    assert.notEqual(run.code, 0);
    assert.equal(countCalls(run.curlLog, "POST", "/api/v1/slo"), 0);
  });

  it("REFUSES EACH metric SLO when its own denominator has no points", () => {
    // Same preflight T6 uses, for the same reason: a server span's name is a
    // dd-trace convention, not a guarantee. Renamed — MONEY-1534 measured it,
    // the workers' `web.request` became `hono.request` under the ESM loader —
    // its ratio is 0/0, which Datadog renders as no data and a reader renders
    // as fine.
    //
    // ONE ROW AT A TIME, over every metric SLO. Emptying the preflight for all
    // of them refuses all of them, which cannot distinguish "the refused row was
    // dropped and the rest applied" from "the run stopped at the first refusal"
    // — and that distinction is the entire claim. Looping also means a second
    // metric SLO would be covered by the case rather than by a name somebody
    // remembered to add.
    const metrics = ROWS.filter((r) => r.type === "metric");
    assert.equal(metrics.length, 1, "the metric SLO set changed");
    for (const row of metrics) {
      const denomSeries = seriesIn(row.query!.denominator);
      assert.equal(
        denomSeries.length,
        1,
        `${row.name}'s denominator names ${denomSeries.length} series; the ` +
          "preflight targets one",
      );
      const run = runWithStubbedCurl({
        listing: REAL_LISTING,
        emptyPreflightFor: denomSeries[0]!,
      });
      assert.notEqual(run.code, 0, `${row.name} was not refused`);
      assert.match(
        run.stderr,
        new RegExp(
          `no points in 24h for sum:${denomSeries[0]!.replace(/\./g, "\\.")}`,
        ),
      );
      assert.match(run.stderr, /did NOT apply/);
      // The other three rows still apply — a refused row must not take the
      // healthy ones with it, and it must not be written itself.
      assert.equal(
        countCalls(run.curlLog, "POST", "/api/v1/slo"),
        ROWS.length - 1,
        `${row.name}: the refusal took other rows down with it`,
      );
      assert.ok(
        !run.sent.some((b) => b.name === row.name),
        `${row.name} was written anyway`,
      );
    }
  });

  it("UPDATES rather than duplicating when the name already exists", () => {
    // Without this the second run creates a second SLO with the same name, and
    // both then appear on every board. That is MONEY-1238 fault (e) on a
    // different resource.
    const existing = JSON.stringify({
      data: ROWS.map((r, i) => ({ id: `slo-${i}`, name: r.name })),
    });
    const run = runWithStubbedCurl({
      listing: REAL_LISTING,
      sloSearch: existing,
    });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(countCalls(run.curlLog, "PUT", "/api/v1/slo"), ROWS.length);
    assert.equal(countCalls(run.curlLog, "POST", "/api/v1/slo"), 0);
  });

  it("does NOT match an SLO whose name merely CONTAINS ours", () => {
    // `GET /api/v1/slo?query=` is a SEARCH, not a lookup: it returns anything
    // matching. Taking `data[0]` would PUT over somebody else's SLO, which is
    // worse than creating a duplicate.
    const run = runWithStubbedCurl({
      listing: REAL_LISTING,
      sloSearch: JSON.stringify({
        data: [{ id: "other", name: "[production] Scheduled jobs run — old" }],
      }),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(
      countCalls(run.curlLog, "PUT", "/api/v1/slo"),
      0,
      "PUT over an SLO whose name is not ours",
    );
    assert.equal(countCalls(run.curlLog, "POST", "/api/v1/slo"), ROWS.length);
  });

  it("refuses to create when the SLO search answer is unreadable, and NAMES why", () => {
    // An unparsable search read as "nothing exists" POSTs a duplicate of every
    // SLO, and duplicates diverge from that moment on.
    //
    // The DIAGNOSIS is asserted, not only the refusal. Dropping the explicit
    // `Array.isArray` check still refuses — `"not-an-array".find` throws a
    // TypeError and the shell turns any non-zero `node` into the same refusal —
    // so a test that only counts POSTs cannot tell the deliberate guard from an
    // accident, and would score its removal as harmless. What the operator gets
    // is the difference: "slo search did not return data[]" names the endpoint
    // and the field; "d.find is not a function" names a variable in a `node -e`.
    const run = runWithStubbedCurl({
      listing: REAL_LISTING,
      sloSearch: '{"data":"not-an-array"}',
    });
    assert.notEqual(run.code, 0);
    assert.equal(countCalls(run.curlLog, "POST", "/api/v1/slo"), 0);
    assert.match(run.stderr, /refusing to POST a possible duplicate/);
    assert.match(run.stderr, /slo search did not return data\[\]/);
  });

  it("rejects an unknown argument rather than running for real", () => {
    // `apply-monitors.sh` parsed one position against one exact string, so
    // `--dryrun` went on to write to Datadog for real.
    const res = spawnSync("bash", [SCRIPT, "prod", "--dryrun"], {
      encoding: "utf8",
      cwd: ROOT,
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /unknown argument/);
  });

  it("rejects an unknown environment", () => {
    const res = spawnSync("bash", [SCRIPT, "staging"], {
      encoding: "utf8",
      cwd: ROOT,
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /usage:/);
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
});

describe("MONEY-1360 — the script and the library agree", () => {
  it("sources the shared library rather than carrying its own copy", () => {
    // A second copy of dd_request/dd_render would start identical and drift,
    // which is the defect class this directory's whole history is made of.
    assert.match(SCRIPT_SRC, /source "\$HERE\/lib-datadog\.sh"/);
    assert.doesNotMatch(SCRIPT_SRC, /^dd_request\(\) \{/m);
    assert.doesNotMatch(SCRIPT_SRC, /^dd_list_managed\(\) \{/m);
    assert.doesNotMatch(SCRIPT_SRC, /^dd_metric_has_points\(\) \{/m);
  });

  it("calls the library functions it depends on, and they exist", () => {
    const lib = readFileSync(LIB, "utf8");
    for (const fn of [
      "dd_request",
      "dd_list_managed",
      "dd_metric_has_points",
    ]) {
      assert.match(lib, new RegExp(`^${fn}\\(\\) \\{`, "m"), `${fn} missing`);
      assert.ok(SCRIPT_SRC.includes(fn), `${fn} is never called`);
    }
  });

  it("derives the API host from DD_SITE rather than hardcoding one", () => {
    // apply-monitors.sh POSTed to US1 for two releases while DD_SITE said
    // otherwise, creating resources in an org that never receives the metric.
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

  it("avoids bash-4-only expansions — /bin/bash here is 3.2", () => {
    // apply-service-monitors.sh uses ${ENV_ARG^^} inside a `:?` message and
    // prints "bad substitution" on macOS's /bin/bash. It happens to still exit
    // non-zero, so its own test passes; the same construct in a value rather
    // than a message would be a silent wrong string.
    assert.doesNotMatch(SCRIPT_SRC, /\$\{[A-Za-z_]+\^\^\}/);
    assert.doesNotMatch(SCRIPT_SRC, /^\s*mapfile\b/m);
    assert.doesNotMatch(SCRIPT_SRC, /^\s*readarray\b/m);
  });

  it("reads the SLO rows from slos.json, not from a copy in the script", () => {
    // The file is the source of truth; a second list inside the script would
    // agree with it until the day somebody edits one.
    assert.match(SCRIPT_SRC, /slos\.json/);
    for (const row of ROWS) {
      assert.ok(
        !SCRIPT_SRC.includes(row.name),
        `"${row.name}" is restated inside the script`,
      );
    }
  });
});
