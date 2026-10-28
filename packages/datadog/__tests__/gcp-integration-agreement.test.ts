/**
 * The Google Cloud integration is a GRANT and a PURCHASE, and both are easy to
 * widen by accident — MONEY-1379.
 *
 * ## The two defects this file exists to catch
 *
 * **A quiet widening of the grant.** `setup-gcp-integration.sh` hands a third
 * party impersonation rights over a service account in the production project.
 * The four roles are all READ. Swapping one for `roles/editor` — which is what
 * anyone debugging a permission error reaches for first — works identically on
 * the day it is done, produces no error, and leaves Datadog with write access to
 * the project forever. Nothing in a dry run, a log line or a metric can show it,
 * so the exact four are pinned here and a fifth role of any kind fails.
 *
 * **A cost config written over an empty dataset.** Cloud Cost Management needs
 * the Detailed Usage Cost BigQuery export, which is console-only to enable and
 * accumulates only from the day it is switched on. A best-effort stage 4 would
 * register the config against a dataset with no export in it, report success,
 * and leave someone waiting 72 hours for data that was never coming — then
 * another 72 after the export is finally turned on. So the precondition is
 * behavioural here, not a grep: the script is RUN against a dataset with no
 * billing table and must exit 2 having issued no request at all.
 *
 * ## Why there is an observe-first case in a script test
 *
 * MONEY-1238: a monitor over a series nobody emits renders NO DATA, which after
 * one mute is indistinguishable from health. This repo has shipped that four
 * times. The integration introduces a whole `gcp.*` namespace that has never
 * been seen in our org, so the rule is enforced rather than written down — no
 * monitor and no dashboard may query one until stage 5 has watched it arrive.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DD_DIR = join(ROOT, "scripts/ops/datadog");
const SCRIPT = join(DD_DIR, "setup-gcp-integration.sh");
const SRC = readFileSync(SCRIPT, "utf8");

/** Strip `#` comments, so prose ABOUT a forbidden role is not a forbidden role. */
const withoutComments = (src: string): string =>
  src
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");

const CODE = withoutComments(SRC);

/**
 * The whole grant. All four are READ roles, and Datadog's v2 integration needs
 * nothing else: `browser` to enumerate the project, `compute.viewer` to
 * discover GCE instances as hosts, `monitoring.viewer` for the metrics
 * themselves, `cloudasset.viewer` for resource collection.
 */
const EXPECTED_ROLES = [
  "roles/browser",
  "roles/cloudasset.viewer",
  "roles/compute.viewer",
  "roles/monitoring.viewer",
];

const EXPECTED_APIS = [
  "monitoring.googleapis.com",
  "compute.googleapis.com",
  "cloudasset.googleapis.com",
  "cloudresourcemanager.googleapis.com",
  "iam.googleapis.com",
  "cloudbilling.googleapis.com",
  "bigquery.googleapis.com",
  "storage.googleapis.com",
];

const PROJECT_ID = "stock-book-483718";
const SA_EMAIL = `datadog-integration@${PROJECT_ID}.iam.gserviceaccount.com`;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** Every `gcloud …` and `bq …` invocation, one per line. */
  calls: string;
  /** Every `curl` invocation — i.e. everything written to Datadog. */
  curlLog: string;
}

/**
 * Run the REAL script with `gcloud`, `bq`, `curl` and `sleep` stubbed.
 *
 * `node` stays real: lib-datadog.sh uses it to read DD_SITE out of
 * packages/datadog/src/constants.ts, which is the single source this script
 * derives its API host from, and stubbing it would make that derivation — one
 * of the properties asserted below — unobservable.
 */
function run(
  stage: string,
  opts: {
    /** What `bq ls` answers. Default: the detailed export table is present. */
    bqTables?: string;
    /** What `bq show` answers for the dataset. */
    bqDataset?: string;
    /** What `GET /api/v2/integration/gcp/accounts` answers. */
    accounts?: string;
    /** HTTP status for that listing. Datadog answers 404 when none exist. */
    accountsStatus?: string;
    /** What `GET /api/v1/hosts` answers. */
    hosts?: string;
    /** What `GET /api/v2/cost/gcp_uc_config` answers. */
    costConfigs?: string;
    /** What `GET /api/v1/query` answers — `{"series":[]}` is "no points". */
    query?: string;
  } = {},
): Run {
  const dir = mkdtempSync(join(tmpdir(), "gcp-integration-"));
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);

  const write = (name: string, body: string[]) => {
    writeFileSync(join(bin, name), [...body, ""].join("\n"));
    chmodSync(join(bin, name), 0o755);
  };

  write("gcloud", [
    "#!/bin/sh",
    'printf "gcloud %s\\n" "$*" >> "$STUB_CALLS"',
    'case "$*" in',
    // Everything the script probes for existence answers "already there", so
    // the idempotent paths are the ones exercised.
    '  *"billing projects describe"*) echo "billingAccounts/01ABCD-234567-89ABCD" ;;',
    // The project NUMBER, which is what the BigQuery Data Transfer service
    // agent's address is built from. Deliberately DIFFERENT from the project
    // id, so a case that substituted the id would be visibly wrong.
    '  *"projects describe"*projectNumber*) echo "790437168332" ;;',
    "esac",
    "exit 0",
  ]);

  write("bq", [
    "#!/bin/sh",
    'printf "bq %s\\n" "$*" >> "$STUB_CALLS"',
    'case "$*" in',
    '  *" ls "*) printf "%s" "$STUB_BQ_LS" ;;',
    '  *" show "*) printf "%s" "$STUB_BQ_SHOW" ;;',
    "esac",
    "exit 0",
  ]);

  // `cat > /dev/null` first, always: dd_request feeds the credentials through
  // `-K -`, and a stub that exits without draining the pipe hands the writer an
  // EPIPE that reads as a transport failure.
  write("curl", [
    "#!/bin/sh",
    'printf "curl %s\\n" "$*" >> "$STUB_CURL_LOG"',
    "cat > /dev/null",
    'case "$*" in',
    `  *sts_delegate*)  printf '%s\\n200\\n' '{"data":{"attributes":{"delegate_account_email":"dd-delegate@datadog-gcp.iam.gserviceaccount.com"}}}' ;;`,
    // The accounts endpoint answers by METHOD, because the real one does: the
    // LIST 404s when nothing is registered while the POST that fixes it
    // succeeds. A stub that keyed on the URL alone made the 404 case
    // unreproducible — it 404'd the POST too, which is not a state Datadog can
    // be in.
    "  *gcp/accounts*)",
    '    case "$*" in',
    `      *"-X POST"*|*"-X PATCH"*) printf '%s\\n200\\n' '{"data":{"id":"created-id"}}' ;;`,
    '      *) printf "%s\\n%s\\n" "$STUB_ACCOUNTS" "${STUB_ACCOUNTS_STATUS:-200}" ;;',
    "    esac ;;",
    '  *api/v1/query*)  printf "%s\\n200\\n" "$STUB_QUERY" ;;',
    '  *api/v1/hosts*)  printf "%s\\n200\\n" "$STUB_HOSTS" ;;',
    '  *gcp_uc_config*) printf "%s\\n200\\n" "$STUB_COST" ;;',
    `  *)               printf '%s\\n200\\n' '{}' ;;`,
    "esac",
    "exit 0",
  ]);

  // The verify stage waits 60s between attempts; nothing here should.
  write("sleep", ["#!/bin/sh", "exit 0"]);

  const r = spawnSync("bash", [SCRIPT, `--only=${stage}`], {
    encoding: "utf8",
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      STUB_CALLS: join(dir, "calls.log"),
      STUB_CURL_LOG: join(dir, "curl.log"),
      STUB_BQ_LS:
        opts.bqTables ??
        '[{"tableReference":{"tableId":"gcp_billing_export_resource_v1_01ABCD_234567_89ABCD"}}]',
      STUB_BQ_SHOW:
        opts.bqDataset ??
        '{"location":"asia-south1","access":[{"role":"OWNER","userByEmail":"founder@disdigital.in"}]}',
      STUB_ACCOUNTS: opts.accounts ?? '{"data":[]}',
      STUB_ACCOUNTS_STATUS: opts.accountsStatus ?? "200",
      STUB_HOSTS: opts.hosts ?? '{"total_matching":9}',
      STUB_COST: opts.costConfigs ?? '{"data":[]}',
      STUB_QUERY:
        opts.query ?? '{"series":[{"pointlist":[[1757000000000,1]]}]}',
      DD_API_KEY: "stub-api-key",
      DD_APP_KEY: "stub-app-key",
    },
  });

  const read = (f: string) => {
    try {
      return readFileSync(join(dir, f), "utf8");
    } catch {
      return "";
    }
  };
  const out: Run = {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    calls: read("calls.log"),
    curlLog: read("curl.log"),
  };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

/** The `curl` lines, reduced to `METHOD path` so order can be asserted. */
function requests(curlLog: string): string[] {
  return curlLog
    .split("\n")
    .map((l) => /-X (\w+) (\S+)/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${m[1]} ${(m[2] ?? "").replace(/^https:\/\/[^/]+/, "")}`);
}

describe("setup-gcp-integration.sh grants exactly the four read roles", () => {
  it("PREMISE: the script parses on this machine's bash", () => {
    // Every behavioural case below is worthless if the file does not run, and a
    // parse error on bash 3.2 is the failure mode this directory keeps hitting.
    const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    assert.equal(r.status, 0, `bash -n failed:\n${r.stderr}`);
  });

  it("declares EXACTLY the four documented roles, no more", () => {
    const block = /SA_ROLES=\(([^)]*)\)/.exec(CODE);
    assert.ok(block, "could not find the SA_ROLES array");
    const roles = [...(block[1] ?? "").matchAll(/"([^"]+)"/g)]
      .map((m) => m[1] ?? "")
      .sort();
    // deepEqual on the SORTED set, so a swap (`roles/compute.viewer` ->
    // `roles/editor`), an addition and a removal all fail — a containment check
    // would only have caught the removal.
    assert.deepEqual(
      roles,
      EXPECTED_ROLES,
      "the GCP integration grant changed. All four are READ roles; a widening " +
        "here hands a third party standing access to the production project and " +
        "produces no error, no log line and no metric.",
    );
  });

  it("grants no owner, editor or admin role ANYWHERE in the script", () => {
    // The array above is not the only place a binding can be made — stage 2
    // binds the token-creator role and stage 4 binds three more. This scans the
    // whole file, so a widening added outside SA_ROLES fails too.
    const granted = [...CODE.matchAll(/roles\/[A-Za-z][A-Za-z0-9.]*/g)].map(
      (m) => m[0],
    );
    assert.ok(granted.length >= 4, "no role references found — bad scan");
    for (const role of granted) {
      assert.doesNotMatch(
        role,
        /^roles\/(owner|editor|viewer)$|\.admin$|^roles\/iam\.securityAdmin$/,
        `${role} is a primitive or admin role. The integration is read-only; ` +
          "the two write grants it does need are dataset-scoped and bucket-scoped.",
      );
    }
  });

  it("enables all eight APIs the crawl and the cost export read through", () => {
    const block = /GCP_APIS=\(([^)]*)\)/.exec(CODE);
    assert.ok(block, "could not find the GCP_APIS array");
    const apis = [...(block[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    for (const api of EXPECTED_APIS) {
      assert.ok(
        apis.includes(api),
        `${api} is not enabled. A missing API does not fail the setup — the ` +
          "crawl simply returns nothing for that product, which reads as an idle project.",
      );
    }
    assert.equal(
      apis.length,
      EXPECTED_APIS.length,
      `enabled: ${apis.join(", ")}`,
    );
  });
});

describe("setup-gcp-integration.sh refuses to write a cost config over an empty dataset", () => {
  it("exits 2, and writes NOTHING, when the detailed export is missing", () => {
    const r = run("cost", { bqTables: "[]" });
    // 2, specifically: it is an operator action, not a script failure, and the
    // exit code is how a wrapper tells the two apart.
    assert.equal(
      r.code,
      2,
      `expected exit 2 for a missing export, got ${r.code}:\n${r.stderr}`,
    );
    assert.match(r.stderr, /gcp_billing_export_resource_v1/);
    assert.match(
      r.stderr,
      /console\.cloud\.google\.com\/billing/,
      "the refusal must name the console path the founder has to click",
    );
    // The whole point: nothing may have been created or registered first.
    assert.equal(
      r.curlLog,
      "",
      "it reached Datadog before checking the precondition",
    );
    assert.doesNotMatch(
      r.calls,
      /buckets create|roles create|add-iam-policy-binding|bq update/,
      `it provisioned something before refusing:\n${r.calls}`,
    );
  });

  it("proceeds when the export IS there (the positive control)", () => {
    // Without this, refusing everything would satisfy the case above.
    const r = run("cost");
    assert.equal(r.code, 0, `the happy path failed:\n${r.stderr}`);
    assert.match(r.stdout, /found the detailed usage cost export/);
  });

  it("refuses a bucket that is not co-located with the dataset", () => {
    // BigQuery rejects a load job whose source bucket is in another location,
    // with an error that names neither side.
    const r = run("cost", {
      bqDataset: '{"location":"us-central1","access":[]}',
    });
    assert.notEqual(r.code, 0, "a cross-region dataset must stop the run");
    assert.match(r.stderr, /co-located/);
  });
});

describe("setup-gcp-integration.sh upserts, and never blindly POSTs", () => {
  it("registers the account GET-then-POST when the org has none", () => {
    const r = run("register", { accounts: '{"data":[]}' });
    assert.equal(r.code, 0, r.stderr);
    const seen = requests(r.curlLog);
    assert.deepEqual(seen, [
      "GET /api/v2/integration/gcp/accounts",
      "POST /api/v2/integration/gcp/accounts",
    ]);
  });

  it("PATCHes the existing account instead of creating a second", () => {
    // Datadog does not reject a duplicate `client_email`; it keeps both and the
    // org crawls the project twice under two ids — double the billable hosts,
    // double the Google API quota, and nothing downstream shows it.
    const r = run("register", {
      accounts: `{"data":[{"id":"abc123","attributes":{"client_email":"${SA_EMAIL}"}}]}`,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(requests(r.curlLog), [
      "GET /api/v2/integration/gcp/accounts",
      "PATCH /api/v2/integration/gcp/accounts/abc123",
    ]);
  });

  it("refuses to POST when the account listing could not be read", () => {
    // Reading an unreadable listing as "nothing exists" is how one duplicate
    // becomes one per run.
    const r = run("register", { accounts: "not json at all" });
    assert.notEqual(r.code, 0, "an unreadable listing must stop the run");
    assert.doesNotMatch(
      r.curlLog,
      /-X POST/,
      "it POSTed after failing to list",
    );
  });

  it("treats a 404 listing as EMPTY and registers — the first-ever run", () => {
    // Measured against the live org on 2026-09-11: with no GCP integration
    // configured, Datadog answers this LIST endpoint
    //   404 {"errors":[{"status":"404","detail":"Datadog GCP Integration not found"}]}
    // Refusing there made the FIRST registration impossible — the one run this
    // script exists to perform. It is a DETERMINATE answer ("there are none"),
    // which is what separates it from the 403 case below.
    const r = run("register", {
      accountsStatus: "404",
      accounts:
        '{"errors":[{"status":"404","detail":"Datadog GCP Integration not found"}]}',
    });
    assert.equal(r.code, 0, `a 404 listing must proceed:\n${r.stderr}`);
    assert.match(r.curlLog, /-X POST/, "it should have created the account");
  });

  it("still REFUSES on an indeterminate failure (403), where 404 proceeds", () => {
    // The pair is the point: the rule is determinacy, not the status code. A
    // 403 leaves us unable to say whether an account exists, and creating one
    // there is how the org crawls this project twice under two ids — double
    // the cost, double the Google quota, invisible downstream.
    const r = run("register", {
      accountsStatus: "403",
      accounts: '{"errors":["Forbidden"]}',
    });
    assert.notEqual(r.code, 0, "an indeterminate listing must stop the run");
    assert.doesNotMatch(r.curlLog, /-X POST/, "it POSTed without knowing");
  });

  it("grants the BigQuery Data Transfer agent tokenCreator BEFORE the cost POST", () => {
    // Learned from a live 400 on 2026-09-11, not from any doc:
    //   [key=CROSS_ACCOUNT_TOKEN_ACCCESS] Missing Cross Account Token Creator
    //   access on the Google Cloud Bigquery Data Transfer service account.
    // Datadog does not read the export table — it creates a BigQuery Data
    // TRANSFER, which runs as Google's own service agent and must impersonate
    // our integration SA. So `$SA_EMAIL` carries TWO tokenCreator grants, for
    // two different callers: Datadog's STS delegate (stage 2) and this agent.
    //
    // This case cannot prove the vendor accepts the config — `curl` is stubbed,
    // so the suite asserts the REQUEST and never the validation. What it CAN
    // pin is that the grant is made at all, which is what was missing.
    const r = run("cost");
    assert.equal(r.code, 0, r.stderr);
    assert.match(
      r.calls,
      /add-iam-policy-binding[^\n]*gcp-sa-bigquerydatatransfer[^\n]*serviceAccountTokenCreator|add-iam-policy-binding[^\n]*serviceAccountTokenCreator[^\n]*gcp-sa-bigquerydatatransfer/,
      `stage 4 must grant tokenCreator to the BigQuery Data Transfer agent:\n${r.calls}`,
    );
  });

  it("resolves the project NUMBER for that agent, never the project id", () => {
    // The agent is `service-<PROJECT_NUMBER>@gcp-sa-bigquerydatatransfer…`.
    // Substituting the project ID produces a principal that does not exist and
    // a binding that fails — with an IAM error that names neither the cost
    // config nor the transfer.
    const r = run("cost");
    assert.match(r.calls, /projects describe[\s\S]*projectNumber/);
  });

  it("creates the service identity first — it does not exist until first use", () => {
    // A fresh project has no BigQuery Data Transfer agent, so the binding would
    // fail with "does not exist". `services identity create` is idempotent and
    // returns the existing one, so it is safe on every run.
    const r = run("cost");
    assert.match(
      r.calls,
      /services identity create[^\n]*bigquerydatatransfer/,
      `stage 4 must ensure the agent exists before binding to it:\n${r.calls}`,
    );
  });

  it("upserts the cost config the same way", () => {
    const created = run("cost", { costConfigs: '{"data":[]}' });
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual(requests(created.curlLog), [
      "GET /api/v2/cost/gcp_uc_config",
      "POST /api/v2/cost/gcp_uc_config",
    ]);

    const patched = run("cost", {
      costConfigs: `{"data":[{"id":"cfg-1","attributes":{"service_account":"${SA_EMAIL}"}}]}`,
    });
    assert.equal(patched.code, 0, patched.stderr);
    assert.deepEqual(requests(patched.curlLog), [
      "GET /api/v2/cost/gcp_uc_config",
      "PATCH /api/v2/cost/gcp_uc_config/cfg-1",
    ]);
  });

  it("binds the delegate it was GIVEN, never an empty member", () => {
    // The sts_delegate response schema is not documented, so the email is
    // extracted defensively. A miss must abort rather than run
    // `add-iam-policy-binding --member=serviceAccount:` against nothing.
    const ok = run("delegate");
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(
      ok.calls,
      /--member=serviceAccount:dd-delegate@datadog-gcp\.iam\.gserviceaccount\.com/,
    );
    assert.match(
      ok.calls,
      /--role=roles\/iam\.serviceAccountTokenCreator/,
      "the token-creator binding IS the v2 integration",
    );
    assert.match(
      ok.stdout,
      /raw sts_delegate response/,
      "the raw body must be printed — it is the only record of the field name",
    );
  });
});

describe("setup-gcp-integration.sh proves arrival before anything alerts", () => {
  it("fails verify when the GCE hosts never appeared", () => {
    // Metrics can arrive from Cloud Run and Pub/Sub with zero instances
    // discovered, so the host count is a separate claim and must be able to fail.
    const r = run("verify", { hosts: '{"total_matching":4}' });
    assert.notEqual(r.code, 0, "a missing host population must fail verify");
    assert.match(r.stderr, /only 4 hosts/);
  });

  it("does NOT fail verify for a cost row that has not landed yet", () => {
    // Cost lags 48-72h. Failing for it on setup day trains everyone to ignore
    // this stage's exit code, which is the only thing standing between a broken
    // integration and a muted monitor.
    const r = run("verify", { costConfigs: '{"data":[]}' });
    assert.equal(r.code, 0, `cost lag must not fail verify:\n${r.stderr}`);
    assert.match(r.stdout, /cost: pending — re-run --only=verify after 72h/);
  });

  // ── MONEY-1379: the gcp.* namespace is now monitored, under one condition ──
  //
  // This block REPLACES a case that read "no monitor and no dashboard queries a
  // gcp.* metric yet", whose own comment said to delete it in the same change
  // that adds the first gcp.* monitor and only after stage 5 had watched the
  // series arrive. Both conditions are met: the integration is live, the series
  // were observed (798 of them on 2026-09-11), and `apply-perf-monitors.sh`
  // preflights every one it alerts on against the live org before writing.
  //
  // Deleting the case outright would have thrown away the rule with the
  // precondition. MONEY-1238's finding was never "gcp is forbidden" — it was
  // "do not monitor a series nobody has seen arriving". So the rule becomes the
  // narrower one it always meant: a gcp.* series may be alerted on ONLY through
  // the script that checks it is live first.

  it("only the perf-monitor templates and their board may name a gcp.* series", () => {
    // An allow-list rather than a free-for-all. A gcp.* query appearing in, say,
    // monitor-zero-write.json would be a monitor created by a script that does
    // NOT preflight — which is the original defect wearing the new permission.
    const ALLOWED = [
      "monitor-gcp-gauge-by-group.json",
      "monitor-gcp-ratio-by-group.json",
      "monitor-gcp-percentile.json",
      "dashboards/workers-performance.json",
    ];
    const files = [
      ...readdirSync(DD_DIR)
        .filter((f) => f.startsWith("monitor-") && f.endsWith(".json"))
        .map((f) => f),
      ...readdirSync(join(DD_DIR, "dashboards"))
        .filter((f) => f.endsWith(".json"))
        .map((f) => `dashboards/${f}`),
    ];
    assert.ok(files.length >= 10, `only ${files.length} definitions scanned`);
    const offenders = files.filter(
      (rel) =>
        !ALLOWED.includes(rel) &&
        /\bgcp\.[a-z_]+/.test(readFileSync(join(DD_DIR, rel), "utf8")),
    );
    assert.deepEqual(
      offenders,
      [],
      "these name a gcp.* series but are not applied by apply-perf-monitors.sh, " +
        "so nothing preflights them — a NO DATA monitor waiting to be muted",
    );
  });

  it("every gcp.* template is actually applied by the script that preflights", () => {
    // A template nobody renders is worse than absent: it looks like coverage.
    const script = readFileSync(join(DD_DIR, "apply-perf-monitors.sh"), "utf8");
    const templates = readdirSync(DD_DIR).filter(
      (f) => f.startsWith("monitor-gcp-") && f.endsWith(".json"),
    );
    assert.ok(templates.length >= 3, `only ${templates.length} gcp templates`);
    for (const t of templates)
      assert.ok(
        script.includes(t),
        `${t} is never referenced by apply-perf-monitors.sh`,
      );
  });

  it("the perf script refuses a row whose series has no points, and STOPS when the check did not run", () => {
    // The three-outcome contract is what makes the permission above safe, so it
    // is asserted here as well as exercised functionally in
    // perf-monitors-agreement.test.ts. Collapsing "no points" into "could not
    // ask" is how a bad app key or one 429 becomes "the series is empty".
    const script = readFileSync(join(DD_DIR, "apply-perf-monitors.sh"), "utf8");
    assert.match(
      script,
      /dd_metric_has_points "\$Q" 3600/,
      "every row must preflight before it is written",
    );
    assert.match(
      script,
      /the preflight DID NOT RUN/,
      "a preflight that could not run must be FATAL, not an empty series",
    );
    // And the write must come AFTER the preflight, not beside it.
    assert.ok(
      script.indexOf("dd_metric_has_points") <
        script.indexOf("dd_upsert_monitor "),
      "the upsert must follow the preflight",
    );
  });
});

describe("setup-gcp-integration.sh spells its facts once", () => {
  it("names the GCP project in exactly one place", () => {
    const hits = CODE.split(PROJECT_ID).length - 1;
    assert.equal(
      hits,
      1,
      `the project id appears ${hits} times in code. Everything else — the ` +
        "service-account address, the bucket, the metric scope, the console " +
        "URLs — must interpolate ${GCP_PROJECT}, or repointing this leaves a survivor.",
    );
    assert.match(
      CODE,
      new RegExp(`^GCP_PROJECT="${PROJECT_ID}"$`, "m"),
      "the one occurrence must be the variable assignment",
    );
  });

  it("never spells the Datadog site out for itself", () => {
    // The org moved us3 -> us5 and a stale copy is answered 403, which an
    // intake swallows — so it renders as NO DATA rather than as an error. The
    // host comes from lib-datadog.sh's `dd_resolve_api_host`, which reads the
    // one constant.
    assert.doesNotMatch(
      CODE,
      /datadoghq\.com/,
      "the site is spelled literally here instead of being derived",
    );
    assert.match(
      CODE,
      /dd_resolve_api_host/,
      "it must call the shared resolver",
    );
    // The positive control for the two assertions above: the derived host is
    // what the requests actually went to.
    const r = run("register");
    assert.match(
      r.curlLog,
      /https:\/\/api\.us5\.datadoghq\.com\//,
      "the derived API host did not reach the request",
    );
  });

  it("runs every stage it declares, and declares every stage it runs", () => {
    const declared = /STAGES=\(([^)]*)\)/.exec(CODE);
    assert.ok(declared, "could not find the STAGES list");
    const names = (declared[1] ?? "").trim().split(/\s+/).filter(Boolean);
    assert.deepEqual(names, [
      "apis",
      "sa",
      "delegate",
      "register",
      "cost",
      "verify",
    ]);
    const invoked = [
      ...CODE.matchAll(/if run_stage (\w+);\s*then stage_(\w+);/g),
    ];
    assert.deepEqual(
      invoked.map((m) => m[1]),
      names,
      "a declared stage is never run, or is run out of order",
    );
    for (const m of invoked) {
      assert.equal(m[1], m[2], `run_stage ${m[1]} calls stage_${m[2]}`);
      assert.match(
        CODE,
        new RegExp(`^stage_${m[1]}\\(\\)`, "m"),
        `stage_${m[1]} is invoked but not defined`,
      );
    }
  });
});
