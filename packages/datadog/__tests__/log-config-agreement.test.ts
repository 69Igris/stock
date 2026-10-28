/**
 * MONEY-1362 — the log index script adds filters without deleting any, and
 * creates the status remapper at most once.
 *
 * ## The defect this file exists for
 *
 * `PUT /api/v1/logs/config/indexes/main` REPLACES `exclusion_filters`. It is
 * not additive and it is not a merge. A PUT carrying only the two filters this
 * script wants silently DELETES every exclusion filter the org already had —
 * no error, no diff, and nothing in the response that says so. Rendering the
 * body correctly is not enough here: a body that is perfectly well formed is
 * exactly what does the damage.
 *
 * So the strongest cases below are not about shape. They spawn the REAL script
 * against a stubbed `curl` whose index listing already carries a filter this
 * script knows nothing about, and assert that filter is still in the body that
 * goes back. Same for retention: it is echoed back as READ, because cost is a
 * founder decision and a script that quietly re-plans an index is a bill.
 *
 * ## What is NOT verified here
 *
 * Whether the status remapper is NEEDED. That is a runtime measurement against
 * an org we have no application key for yet — does `status:error` come back
 * empty while `level:error` has events. The script performs and REPORTS it on
 * every live run and creates nothing when it cannot show the defect; these
 * cases prove the gate, the idempotency and the body, never the premise.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(ROOT, "scripts/ops/datadog/apply-log-config.sh");
const LIB = join(ROOT, "scripts/ops/datadog/lib-datadog.sh");
const SCRIPT_SRC = readFileSync(SCRIPT, "utf8");

/**
 * A `curl` that cannot reach the network, first on PATH for the dry run.
 *
 * `--dry-run` is a BRANCH in a shell script and this directory has shipped two
 * bugs in exactly that branch, one of which made 78 live requests. The
 * guarantee is therefore moved off the branch and onto the process: no
 * credentials in the environment, and a `curl` that logs and fails. The log is
 * asserted EMPTY below, so "the dry run is offline" is checked rather than
 * claimed.
 */
const NO_NET = mkdtempSync(join(tmpdir(), "log-config-offline-"));
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

function dryRun(): { stdout: string; lines: string[] } {
  const childEnv = { ...process.env };
  delete childEnv.DD_API_KEY;
  delete childEnv.DD_APP_KEY;
  const stdout = execFileSync("bash", [SCRIPT, "--dry-run"], {
    encoding: "utf8",
    cwd: ROOT,
    env: {
      ...childEnv,
      PATH: `${NO_NET}:${childEnv.PATH ?? ""}`,
      STUB_LOG: NO_NET_LOG,
    },
  });
  return { stdout, lines: stdout.split("\n") };
}

const DRY = dryRun();
const DRY_BODIES = DRY.lines
  .filter((l) => l.startsWith("{"))
  .map((l) => JSON.parse(l) as Record<string, unknown>);

interface ExclusionFilter {
  name: string;
  is_enabled: boolean;
  filter: { query: string; sample_rate: number };
}
interface IndexPut {
  filter: { query: string };
  exclusion_filters: ExclusionFilter[];
  num_retention_days?: number;
  daily_limit?: number;
  disable_daily_limit?: boolean;
}
interface PipelinePost {
  name: string;
  is_enabled: boolean;
  filter: { query: string };
  processors: { type: string; sources: string[] }[];
}

/** A filter the script knows nothing about — the thing a bad PUT deletes. */
const ORG_FILTER = {
  name: "someone-elses-filter",
  is_enabled: true,
  filter: { query: "service:legacy-thing", sample_rate: 0.9 },
};

const indexListing = (
  exclusionFilters: unknown[],
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    indexes: [
      { name: "audit", exclusion_filters: [] },
      {
        name: "main",
        filter: { query: "" },
        num_retention_days: 30,
        daily_limit: 5_000_000,
        exclusion_filters: exclusionFilters,
        ...extra,
      },
    ],
  });

/** The exact query, spelled once — the addendum finding is about this string. */
const DEBUG_QUERY = "status:(debug OR trace) OR @level:(debug OR trace)";

const DESIRED = [
  {
    name: "debug-and-trace",
    is_enabled: true,
    filter: { query: DEBUG_QUERY, sample_rate: 1 },
  },
  {
    name: "health-checks",
    is_enabled: true,
    filter: { query: "@http.url_details.path:/health*", sample_rate: 1 },
  },
];

interface StubOpts {
  /** Body for `GET /api/v1/logs/config/indexes`. */
  indexes?: string;
  /** Body for `GET /api/v1/logs/config/pipelines`. */
  pipelines?: string;
  /** Body for the `level:error` events search. */
  level?: string;
  /** Body for the `status:error` events search. */
  status?: string;
  /** HTTP status for reads. */
  http?: string;
  /** HTTP status for the index PUT. */
  writeHttp?: string;
  /** HTTP status for the `status:error` search alone. */
  statusHttp?: string;
  /** HTTP status for the `level:error` search alone. */
  levelHttp?: string;
  /** Make `curl` itself EXIT with this code, having answered nothing. */
  curlExit?: string;
}

/**
 * Run the REAL script against a stubbed `curl` that answers PER ENDPOINT.
 *
 * One stub body cannot serve this script: the index listing is
 * `{indexes:[…]}`, the pipeline listing is a bare ARRAY, and the two
 * observations are `{data:[…]}` searches that differ only by the query inside
 * the POST body. Answering them all with one shape makes the script abort on
 * its own fail-closed guards, which looks exactly like the behaviour under
 * test and would make those cases pass for the wrong reason.
 */
function runWithStubbedCurl(opts: StubOpts = {}): {
  code: number;
  stdout: string;
  stderr: string;
  curlLog: string;
  curlStdin: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "log-config-"));
  const log = join(dir, "calls.log");
  const stdinLog = join(dir, "stdin.log");
  try {
    writeFileSync(
      join(dir, "curl"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$STUB_LOG"',
        "# The credentials arrive on STDIN as a curl config (-K -), so they are",
        "# captured separately from argv. Real curl reads this to EOF at option",
        "# parse time, before it opens a socket.",
        'cat >> "$STUB_STDIN"',
        "# A curl that DIES rather than answering — a DNS failure, a proxy",
        "# refusing the connect, a TLS error. It logs the attempt first, so the",
        "# case can still assert nothing was written afterwards.",
        '[ "$STUB_CURL_EXIT" = "0" ] || exit "$STUB_CURL_EXIT"',
        'status="$STUB_HTTP"',
        "# Endpoint first, THEN the query — the index PUT carries",
        '# "status:(debug OR trace)" in its body and would otherwise be',
        "# answered as if it were the status:error observation.",
        'case "$*" in',
        '  *"/logs/config/indexes"*)',
        '    body="$STUB_INDEXES"',
        '    case "$*" in *"-X PUT"*) status="$STUB_WRITE_HTTP" ;; esac',
        "    ;;",
        '  *"/logs/config/pipelines"*) body="$STUB_PIPELINES" ;;',
        '  *"level:error"*)  body="$STUB_LEVEL";  status="$STUB_LEVEL_HTTP" ;;',
        '  *"status:error"*) body="$STUB_STATUS"; status="$STUB_STATUS_HTTP" ;;',
        '  *) body="{}" ;;',
        "esac",
        'printf "%s\\n%s\\n" "$body" "$status"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(log, "");
    writeFileSync(stdinLog, "");
    const res = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        STUB_LOG: log,
        STUB_STDIN: stdinLog,
        STUB_INDEXES: opts.indexes ?? indexListing([ORG_FILTER]),
        STUB_PIPELINES: opts.pipelines ?? "[]",
        STUB_LEVEL: opts.level ?? '{"data":[{"id":"a"}]}',
        STUB_STATUS: opts.status ?? '{"data":[]}',
        STUB_HTTP: opts.http ?? "200",
        STUB_WRITE_HTTP: opts.writeHttp ?? opts.http ?? "200",
        STUB_LEVEL_HTTP: opts.levelHttp ?? opts.http ?? "200",
        STUB_STATUS_HTTP: opts.statusHttp ?? opts.http ?? "200",
        STUB_CURL_EXIT: opts.curlExit ?? "0",
        DD_API_KEY: "stub-api-key",
        DD_APP_KEY: "stub-app-key",
      },
    });
    return {
      code: res.status ?? -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      curlLog: readFileSync(log, "utf8"),
      curlStdin: readFileSync(stdinLog, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const callsTo = (
  curlLog: string,
  method: string,
  urlFragment: string,
): string[] =>
  curlLog
    .split("\n")
    .filter((l) => l.includes(`-X ${method} `) && l.includes(urlFragment));

/** The `-d` payload of the first matching call, or null when there is none. */
function bodyOf(
  curlLog: string,
  method: string,
  urlFragment: string,
): string | null {
  const line = callsTo(curlLog, method, urlFragment)[0];
  if (!line) return null;
  const i = line.indexOf(" -d ");
  if (i < 0) return null;
  const rest = line.slice(i + " -d ".length);
  const w = rest.lastIndexOf(" -w ");
  return w < 0 ? rest : rest.slice(0, w);
}

const INDEX_PUT = "/logs/config/indexes/main";
const PIPELINES = "/logs/config/pipelines";

function indexPut(curlLog: string): IndexPut {
  const raw = bodyOf(curlLog, "PUT", INDEX_PUT);
  assert.ok(raw, "the script made no PUT to the main index");
  return JSON.parse(raw) as IndexPut;
}

describe("MONEY-1362 — the dry run renders what it would write, offline", () => {
  it("PREMISE: the dry run printed three bodies to assert on", () => {
    // Without a floor every case below passes over an empty array — the shape
    // where a spawn silently produces nothing and the suite reports green.
    assert.equal(
      DRY_BODIES.length,
      3,
      `the dry run printed ${DRY_BODIES.length} JSON bodies: ${DRY.stdout}`,
    );
  });

  it("PREMISE: the dry run made ZERO network calls", () => {
    assert.equal(
      readFileSync(NO_NET_LOG, "utf8"),
      "",
      "a --dry-run reached curl; it must never touch the Datadog API",
    );
  });

  it("prints both exclusion filters, each dropping 100% of its match", () => {
    // sample_rate is the rate of what is EXCLUDED, so 1.0 drops every matching
    // line. Anything less is a random hole in the debug logs somebody later
    // tries to read, and it looks like a conservative choice.
    const filters = DRY_BODIES.slice(0, 2) as unknown as ExclusionFilter[];
    assert.deepEqual(
      filters.map((f) => f.name),
      ["debug-and-trace", "health-checks"],
    );
    assert.equal(filters[0]!.filter.query, DEBUG_QUERY);
    assert.equal(filters[1]!.filter.query, "@http.url_details.path:/health*");
    for (const f of filters) {
      assert.equal(f.filter.sample_rate, 1, `${f.name} does not drop 100%`);
      assert.equal(f.is_enabled, true, `${f.name} would be created disabled`);
    }
  });

  it("the debug filter matches TODAY's lines, not only post-pipeline ones", () => {
    // The dormant-then-arming defect. `sample_rate: 1.0` is DROP ALL, and this
    // filter is PUT unconditionally in step 1 — but `status` does not exist on
    // our lines until step 2 creates the remapper, which is gated on a runtime
    // measurement and may not happen for weeks. A `status:`-only query is
    // therefore a permanent no-op applied under the words "exclusion filters
    // applied", which silently ARMS the day the pipeline lands: every debug and
    // trace line in the org stops being indexed, a retention change nobody made
    // and nobody can attribute.
    //
    // Both halves are asserted. Dropping `status:` would miss sources that
    // already carry one; dropping `@level:` restores the dormancy. And the `@`
    // is checked explicitly: `level` is a top-level JSON attribute, not one of
    // Datadog's reserved fields, so a BARE `level:debug` matches a TAG of that
    // name — which nothing here emits, leaving the filter exactly as dead.
    const q = (DRY_BODIES[0] as unknown as ExclusionFilter).filter.query;
    assert.match(q, /status:\(debug OR trace\)/, "the status half is missing");
    assert.match(
      q,
      /@level:\(debug OR trace\)/,
      "the filter only matches `status`, which no line carries until the " +
        "pipeline in step 2 exists — it is a no-op today that arms itself later",
    );
    assert.doesNotMatch(
      q,
      /(^|[^@\w])level:/,
      "a BARE `level:` searches TAGS, not the pino JSON attribute",
    );
  });

  it("prints the pipeline body, scoped to source:nodejs", () => {
    // The filter is the blast radius. `source:nodejs` is what the pino
    // transport stamps (`ddsource: "nodejs"`); widened, this rewrites the
    // status of every log line in the org, including sources whose `level`
    // means something else.
    const p = DRY_BODIES[2] as unknown as PipelinePost;
    assert.equal(p.name, "usemoney-nodejs-status");
    assert.equal(p.filter.query, "source:nodejs");
    assert.equal(p.is_enabled, true);
    const byType = Object.fromEntries(p.processors.map((x) => [x.type, x]));
    assert.deepEqual(byType["status-remapper"]?.sources, ["level"]);
    assert.deepEqual(byType["service-remapper"]?.sources, ["service"]);
  });

  it("names no environment, and the API host comes from DD_SITE", () => {
    // Both objects are ORG-level. A `{qa|prod}` argument here would change
    // nothing, and an argument that changes nothing is how `--dryrun` ran 78
    // live requests against this org.
    assert.match(DRY.stdout, /api\.us5\.datadoghq\.com/);
    assert.doesNotMatch(SCRIPT_SRC, /api\.datadoghq\.com/);
    assert.doesNotMatch(SCRIPT_SRC, /api\.us[0-9]\.datadoghq\.com/);
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
  });
});

describe("MONEY-1362 — the PUT adds filters and deletes none", () => {
  it("PREMISE: the happy path actually reaches the PUT", () => {
    const run = runWithStubbedCurl();
    assert.equal(run.code, 0, run.stderr);
    assert.equal(callsTo(run.curlLog, "PUT", INDEX_PUT).length, 1);
  });

  it("KEEPS a pre-existing filter the script knows nothing about", () => {
    // THE case this file exists for. The PUT replaces the array, so a body
    // built from the desired filters alone deletes the org's own — silently,
    // with a 200 and nothing in the diff.
    const body = indexPut(runWithStubbedCurl().curlLog);
    assert.deepEqual(
      body.exclusion_filters.find((f) => f.name === ORG_FILTER.name),
      ORG_FILTER,
      "the org's own exclusion filter was dropped or rewritten by the PUT",
    );
    assert.deepEqual(
      body.exclusion_filters.map((f) => f.name),
      [ORG_FILTER.name, "debug-and-trace", "health-checks"],
      "existing filters must keep their position — they are evaluated in order",
    );
  });

  it("echoes retention and the daily limit back EXACTLY as read", () => {
    // Cost is a founder decision. Omitting `num_retention_days` hands the
    // choice to whatever the API defaults to; changing it silently re-plans
    // every log already in the index.
    const body = indexPut(runWithStubbedCurl().curlLog);
    assert.equal(body.num_retention_days, 30);
    assert.equal(body.daily_limit, 5_000_000);
    assert.equal(body.filter.query, "", "the index's own filter must survive");
  });

  it("sends both new filters verbatim, at 100%", () => {
    const body = indexPut(runWithStubbedCurl().curlLog);
    for (const want of DESIRED) {
      assert.deepEqual(
        body.exclusion_filters.find((f) => f.name === want.name),
        want,
      );
    }
  });

  it("replaces BY NAME rather than appending a second copy", () => {
    // An org that already has `debug-and-trace` at the wrong rate must end up
    // with ONE filter of that name at 1.0, not two that both evaluate.
    const stale = {
      name: "debug-and-trace",
      is_enabled: false,
      filter: { query: "status:debug", sample_rate: 0.1 },
    };
    const body = indexPut(
      runWithStubbedCurl({ indexes: indexListing([stale]) }).curlLog,
    );
    const hits = body.exclusion_filters.filter(
      (f) => f.name === "debug-and-trace",
    );
    assert.equal(hits.length, 1, "the stale filter was duplicated");
    assert.deepEqual(hits[0], DESIRED[0]);
  });

  it("is idempotent: an index that already has both is left alone", () => {
    const run = runWithStubbedCurl({
      indexes: indexListing([ORG_FILTER, ...DESIRED]),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /exclusion filters unchanged/);
    assert.equal(
      callsTo(run.curlLog, "PUT", INDEX_PUT).length,
      0,
      "a second run re-wrote an index that was already correct",
    );
  });
});

describe("MONEY-1362 — the script fails closed", () => {
  it("aborts on a 403 to the index listing, writing nothing", () => {
    // `curl` exits 0 on a 403. Read as "no filters exist", the next step PUTs
    // an array containing only ours — which is the deletion, performed by the
    // error path rather than by a bug in the merge.
    const run = runWithStubbedCurl({
      http: "403",
      indexes: '{"errors":["x"]}',
    });
    assert.notEqual(run.code, 0);
    assert.equal(callsTo(run.curlLog, "PUT", INDEX_PUT).length, 0);
    assert.equal(callsTo(run.curlLog, "POST", PIPELINES).length, 0);
  });

  it("aborts when the listing is 200 but not {indexes:[…]}", () => {
    const run = runWithStubbedCurl({ indexes: "not json at all" });
    assert.notEqual(run.code, 0);
    assert.equal(callsTo(run.curlLog, "PUT", INDEX_PUT).length, 0);
  });

  it("REPORTS the absent index, writes no filters, and does NOT exit 0", () => {
    // MONEY-1229. This case read "REPORTS the absent index and exits 0", and
    // the exit-0 half was the defect: `run_apply` in setup-datadog.sh counts a
    // zero exit as an applied step, so a run that configured NOTHING was
    // reported as one of "5 of 5 apply steps" clean. The monitoring plan
    // records the real cutover as "Log config — NOT YET" against exactly that
    // output.
    //
    // WRITING NOTHING is still the half that has to survive — PUTting an
    // exclusion-filter array to an index that does not exist is the damage —
    // but silence about it is not.
    const run = runWithStubbedCurl({
      indexes: JSON.stringify({ indexes: [{ name: "audit" }] }),
    });
    assert.notEqual(run.code, 0, "a skipped step reported success");
    assert.match(run.stderr, /no log index named main/);
    assert.match(run.stderr, /audit/, "the available names were not printed");
    assert.match(
      run.stdout,
      /exclusion filters \(main\): SKIPPED/,
      "the summary does not distinguish skipped from applied",
    );
    assert.equal(callsTo(run.curlLog, "PUT", INDEX_PUT).length, 0);
  });

  it("names the absent index's TWO possible causes, and asserts neither", () => {
    // The message used to state one: "an org that has never ingested a log has
    // no index". That is a real cause and it is not the only one — logs routed
    // to a custom index produce the same response with every log the org will
    // ever have, and get told to "re-run once logs are flowing" on every run
    // forever while the filters are never applied anywhere.
    const run = runWithStubbedCurl({
      indexes: JSON.stringify({ indexes: [{ name: "custom-app-logs" }] }),
    });
    assert.match(run.stderr, /has not ingested a log yet/);
    assert.match(run.stderr, /routed to one of the indexes listed above/);
    assert.match(
      run.stderr,
      /custom-app-logs/,
      "the index that DOES exist was not named",
    );
    assert.doesNotMatch(
      run.stderr,
      /this is a true "not yet"/,
      "the message still asserts a cause it has not established",
    );
  });

  it("still applies the INTAKE half when the index is absent", () => {
    // The two halves are independent: an exclusion filter is a property of an
    // index, a pipeline is a property of the intake. The `exit 0` this replaces
    // sat before BOTH, so a missing `main` skipped the remapper too — and the
    // configuration where that is most wrong is the one where logs exist and
    // are simply indexed elsewhere, which is precisely when the remapper is
    // wanted.
    const run = runWithStubbedCurl({
      indexes: JSON.stringify({ indexes: [{ name: "custom-app-logs" }] }),
    });
    assert.equal(
      callsTo(run.curlLog, "POST", PIPELINES).length,
      1,
      "the missing index took the intake pipeline down with it",
    );
    assert.match(run.stdout, /status remap.*created/s);
    // ...and the run is still not a success, because half of it was skipped.
    assert.notEqual(run.code, 0);
  });

  it("exits 0 and says so when BOTH halves actually landed", () => {
    // The positive control. Without it every assertion above passes against a
    // script that exits non-zero unconditionally, which would be "honest" and
    // useless — the runner would report a failure on every clean cutover.
    const run = runWithStubbedCurl();
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /exclusion filters \(main\): applied/);
    assert.match(run.stdout, /status remap.*created/s);
    assert.doesNotMatch(run.stdout, /SKIPPED/);
  });

  it("aborts when the PUT itself is refused", () => {
    const run = runWithStubbedCurl({ writeHttp: "400" });
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /PUT main failed/);
  });

  it("rejects an unknown argument rather than running for real", () => {
    // `apply-monitors.sh` matched one position against one exact string, so
    // `--dryrun` went on to write to Datadog for real — 78 live requests.
    for (const arg of ["--dryrun", "-n", "--dry-run=true"]) {
      const res = spawnSync("bash", [SCRIPT, arg], {
        encoding: "utf8",
        cwd: ROOT,
      });
      assert.notEqual(res.status, 0, `${arg} was accepted`);
      assert.match(res.stderr, /unknown argument/);
    }
  });

  it("REFUSES an environment argument instead of ignoring it", () => {
    // The sibling scripts take `{qa|prod}`, so this is the argument somebody
    // types from habit. Accepted and ignored, it reads as "I applied qa" while
    // having written to the org.
    for (const arg of ["prod", "qa"]) {
      const res = spawnSync("bash", [SCRIPT, arg, "--dry-run"], {
        encoding: "utf8",
        cwd: ROOT,
      });
      assert.notEqual(res.status, 0, `${arg} was silently accepted`);
      assert.match(res.stderr, /unknown argument/);
    }
  });

  it("requires both credentials for a live run", () => {
    const childEnv = { ...process.env };
    delete childEnv.DD_API_KEY;
    delete childEnv.DD_APP_KEY;
    const res = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      cwd: ROOT,
      env: childEnv,
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /DD_API_KEY|DD_APP_KEY/);
  });
});

describe("MONEY-1362 — the status remap is gated on a measurement", () => {
  it("creates the pipeline when level:error has events and status:error does not", () => {
    const run = runWithStubbedCurl();
    assert.equal(run.code, 0, run.stderr);
    const raw = bodyOf(run.curlLog, "POST", PIPELINES);
    assert.ok(
      raw,
      "the pipeline was not created on the one path that needs it",
    );
    const body = JSON.parse(raw) as PipelinePost;
    assert.equal(body.filter.query, "source:nodejs");
    assert.deepEqual(
      body.processors.find((p) => p.type === "status-remapper")?.sources,
      ["level"],
    );
    assert.match(run.stdout, /created pipeline usemoney-nodejs-status/);
  });

  it("REPORTS the observation rather than assuming it", () => {
    // The measurement cannot be made until an app key exists, so the run has
    // to say what it saw. A silent assumption here is a pipeline created
    // against a status field that was already fine.
    const run = runWithStubbedCurl();
    assert.match(
      run.stdout,
      /observation .*level:error events=true, status:error events=false/,
    );
  });

  it("creates nothing when status:error already returns events", () => {
    // The remap is already happening — Datadog auto-installs an integration
    // pipeline for a recognised source, under a name this script does not
    // check for. A second remapper is not inert: pipelines are ordered and
    // both would run.
    const run = runWithStubbedCurl({ status: '{"data":[{"id":"b"}]}' });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(callsTo(run.curlLog, "POST", PIPELINES).length, 0);
    assert.match(run.stdout, /status:error already returns events/);
  });

  it("PASSES when status:error resolves and level:error is empty — the steady state", () => {
    // The combination that broke on prod 2026-09-08, and the one this file did
    // not cover: the sibling case above leaves `level` at its default (has
    // events), so it never reaches the branch that mattered.
    //
    // Once the remapper is unnecessary, `level:error` NEVER has events again.
    // With the level check first, that made the "already resolves" pass
    // unreachable in the exact state it describes: the run printed
    // `level:error events=false, status:error events=true` and still exited 3,
    // permanently, so `setup-datadog.sh` carried a failing step forever.
    //
    // The order is the fix — ask the question that can settle it on its own
    // first — and this asserts the OUTCOME rather than the ordering, so a
    // future rewrite is free to restructure as long as this state still passes.
    const run = runWithStubbedCurl({
      status: '{"data":[{"id":"b"}]}',
      level: '{"data":[]}',
    });
    assert.equal(run.code, 0, `must exit 0, not 3:\n${run.stderr}`);
    assert.match(run.stdout, /status:error already returns events/);
    assert.doesNotMatch(
      run.stdout,
      /nothing was measured/,
      "reported as unmeasurable when status:error had already settled it",
    );
    assert.equal(callsTo(run.curlLog, "POST", PIPELINES).length, 0);
  });

  it("creates nothing when NEITHER query has events — that measures nothing", () => {
    // Two empty answers are not evidence of the defect; they are evidence the
    // service logged no errors in 24h. Treating that as "status is broken" is
    // how a config change gets made on an absence.
    //
    // And it is a SKIP, not a pass (MONEY-1229): the gate could not be
    // evaluated, so whether this org needs the remapper is still unknown. The
    // filters DID apply, which is why the summary reports the two halves
    // separately rather than one verdict for the run.
    const run = runWithStubbedCurl({ level: '{"data":[]}' });
    assert.notEqual(run.code, 0, "an unevaluated gate reported success");
    assert.equal(callsTo(run.curlLog, "POST", PIPELINES).length, 0);
    assert.match(run.stdout, /nothing was measured/);
    assert.match(run.stdout, /exclusion filters \(main\): applied/);
    assert.match(run.stdout, /status remap.*SKIPPED/s);
  });

  it("exits 0 when the remap is genuinely NOT NEEDED", () => {
    // "Already correct" is not the same as "could not tell", and only the
    // second is a skip. Collapsing them would make a healthy org fail its
    // cutover step forever — the mirror image of the defect above.
    const run = runWithStubbedCurl({ status: '{"data":[{"id":"b"}]}' });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /status remap.*not needed/s);
    assert.doesNotMatch(run.stdout, /SKIPPED/);
  });

  it("does not create a second pipeline when ours already exists", () => {
    const run = runWithStubbedCurl({
      pipelines: JSON.stringify([
        { name: "somebody else", id: "1" },
        { name: "usemoney-nodejs-status", id: "2" },
      ]),
    });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(callsTo(run.curlLog, "POST", PIPELINES).length, 0);
    assert.match(run.stdout, /already exists/);
  });

  it("aborts rather than POSTing when the pipeline listing is unreadable", () => {
    // Read as "no pipelines exist", every run adds another copy.
    const run = runWithStubbedCurl({ pipelines: '{"errors":["x"]}' });
    assert.notEqual(run.code, 0);
    assert.equal(callsTo(run.curlLog, "POST", PIPELINES).length, 0);
    assert.match(run.stderr, /not a JSON array/);
  });
});

describe("lib-datadog — a curl that never answers is DIAGNOSABLE", () => {
  // FINDING 2. `dd_request` returned before assigning RESPONSE_STATUS /
  // RESPONSE_BODY, and every caller reports a failure by printing them under
  // `set -u`. So a curl that exits non-zero killed the script INSIDE the handler
  // that was supposed to report the failure — `unbound variable`, at a line
  // number in the library, naming neither the request nor the reason.
  //
  // Driven through the LIVE path deliberately: `--dry-run` never reaches
  // `dd_request` at all, so a dry-run case would pass against the defect.
  //
  // The library is shared, so this covers apply-dashboards.sh,
  // apply-service-monitors.sh and apply-slos.sh through the same function.
  // `apply-monitors.sh` was never affected — it still pre-initialises both
  // variables at its own top level, which is the line the extraction dropped.
  const CURL_DIED = runWithStubbedCurl({ curlExit: "6" });

  it("PREMISE: the stub was reached, and the run failed", () => {
    // Without this, a script that exited before ever calling curl would satisfy
    // every assertion below by never producing the string.
    assert.ok(
      CURL_DIED.curlLog.includes("/logs/config/indexes"),
      `curl was never called: ${CURL_DIED.stderr}`,
    );
    assert.notEqual(CURL_DIED.code, 0, "a dead curl was treated as success");
  });

  it("does not die with `unbound variable` inside its own error handler", () => {
    assert.doesNotMatch(
      CURL_DIED.stderr,
      /unbound variable/,
      `the failure reporter itself crashed:\n${CURL_DIED.stderr}`,
    );
  });

  it("names the request that failed and how", () => {
    // The diagnosis has to survive: which script step, and that there was no
    // HTTP response at all rather than a refused one.
    assert.match(CURL_DIED.stderr, /could not read the log index listing/);
    assert.match(
      CURL_DIED.stderr,
      /HTTP 000/,
      "a transport failure must not report the PREVIOUS request's status",
    );
    assert.match(
      CURL_DIED.stderr,
      /curl exited 6/,
      "curl's exit code is the only evidence of WHY, and it is not printed",
    );
  });

  it("writes nothing", () => {
    assert.equal(callsTo(CURL_DIED.curlLog, "PUT", INDEX_PUT).length, 0);
    assert.equal(callsTo(CURL_DIED.curlLog, "POST", PIPELINES).length, 0);
  });

  it("keeps the credentials OFF curl's command line", () => {
    // FINDING 6. `-H "DD-API-KEY: …"` puts the key on argv, where any process
    // on the box can read it through `ps` — ~50 times per apply run. It goes
    // through `-K -` instead, a config curl reads from stdin.
    const run = runWithStubbedCurl();
    assert.ok(run.curlLog.includes("-K -"), "curl is not reading a config");
    assert.ok(
      !/DD-API-KEY|DD-APPLICATION-KEY|stub-api-key|stub-app-key/.test(
        run.curlLog,
      ),
      `a credential reached curl's argv:\n${run.curlLog}`,
    );
    // …and they ARRIVE. Without this the assertion above is satisfied by
    // sending no credentials at all, which is a script that authenticates
    // against nothing and reads as a permissions problem forever.
    assert.match(run.curlStdin, /^header = "DD-API-KEY: stub-api-key"$/m);
    assert.match(
      run.curlStdin,
      /^header = "DD-APPLICATION-KEY: stub-app-key"$/m,
    );
    // Every request, not just the first — this is ~50 per apply run.
    assert.equal(
      (run.curlStdin.match(/DD-API-KEY/g) ?? []).length,
      callsTo(run.curlLog, "GET", "/").length +
        callsTo(run.curlLog, "PUT", "/").length +
        callsTo(run.curlLog, "POST", "/").length,
      "some request went out without the credential config",
    );
    // The BODY still has to arrive — `-K -` occupies stdin, so the JSON stays
    // on `-d`, and every case in this file that reads a request body would
    // otherwise pass vacuously on `null`.
    assert.ok(bodyOf(run.curlLog, "PUT", INDEX_PUT), "the PUT body was lost");
  });
});

describe("MONEY-1362 — a FAILED log search is not an empty one", () => {
  // FINDING 7. `dd_events_exist` returned 1 both on an HTTP failure and on an
  // empty `data[]`, and this script uses EMPTINESS to AUTHORISE an org-wide
  // status- and service-remapper that reprocesses every line. So an app key
  // scoped without `logs_read_data`, or one transient 429 on the second search,
  // made both gates pass and created a permanent pipeline on a measurement that
  // never happened — against this file's own promise that "a run that cannot
  // show the defect creates nothing".
  it("aborts when the status:error search is refused, rather than POSTing", () => {
    // The dangerous one: it needs no help from the first search. level:error
    // answers normally, status:error 403s, and BOTH gates read as satisfied.
    const run = runWithStubbedCurl({
      statusHttp: "403",
      status: '{"errors":["Forbidden"]}',
    });
    assert.notEqual(run.code, 0, "a refused search was read as 'no events'");
    assert.equal(
      callsTo(run.curlLog, "POST", PIPELINES).length,
      0,
      "an org-wide pipeline was created on a search that never ran",
    );
    assert.match(run.stderr, /did not run/);
    assert.match(run.stderr, /logs_read_data/, "the likely cause is not named");
  });

  it("aborts when the level:error search is refused", () => {
    const run = runWithStubbedCurl({
      levelHttp: "500",
      level: "gateway error",
    });
    assert.notEqual(run.code, 0);
    assert.equal(callsTo(run.curlLog, "POST", PIPELINES).length, 0);
    assert.match(run.stderr, /did not run/);
  });

  it("aborts when a search answers 200 with a body that is not {data:[…]}", () => {
    // `JSON.parse` throwing used to exit 1, which is byte-for-byte the same
    // answer as a genuine empty result.
    const run = runWithStubbedCurl({ status: "<html>maintenance</html>" });
    assert.notEqual(run.code, 0);
    assert.equal(callsTo(run.curlLog, "POST", PIPELINES).length, 0);
  });

  it("still creates the pipeline when both searches genuinely RAN", () => {
    // The positive control. Without it, `dd_events_exist` returning 2 for
    // everything would satisfy all three cases above.
    const run = runWithStubbedCurl();
    assert.equal(run.code, 0, run.stderr);
    assert.equal(callsTo(run.curlLog, "POST", PIPELINES).length, 1);
  });
});

describe("MONEY-1362 — the script and the library agree", () => {
  it("sources the shared library rather than carrying its own copy", () => {
    // A second copy of dd_request would start identical and drift, which is the
    // defect class this directory's whole history is made of.
    assert.match(SCRIPT_SRC, /source "\$HERE\/lib-datadog\.sh"/);
    assert.doesNotMatch(SCRIPT_SRC, /^dd_request\(\) \{/m);
    assert.doesNotMatch(SCRIPT_SRC, /^dd_events_exist\(\) \{/m);
  });

  it("calls only helpers the library actually defines", () => {
    // The design note asks for `dd_logs_have_events`, which does not exist —
    // the real helper is `dd_events_exist logs "<query>"`. A call to a missing
    // function under `set -e` aborts the run where it is reached, which here is
    // AFTER the PUT: half applied, non-zero exit, and no way to tell from the
    // message which half.
    const lib = readFileSync(LIB, "utf8");
    const defined = new Set(
      [...lib.matchAll(/^(dd_\w+)\(\) \{/gm)].map((m) => m[1]!),
    );
    assert.ok(defined.size >= 4, `parsed only ${defined.size} lib functions`);

    // Invocations only — a `dd_*` word at the head of a command, so the prose
    // in the comments above is not mistaken for a call.
    const called = new Set(
      [...SCRIPT_SRC.matchAll(/^\s*(?:if !\s+|! )?(dd_\w+) /gm)].map(
        (m) => m[1]!,
      ),
    );
    assert.ok(called.size >= 2, `parsed only ${called.size} call sites`);
    for (const fn of called) {
      assert.ok(defined.has(fn), `${fn} is called and not defined in the lib`);
    }
    assert.ok(called.has("dd_request") && called.has("dd_events_exist"));
  });
});
