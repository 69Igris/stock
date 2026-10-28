/**
 * The MongoDB DBM agent config is rendered ONE BLOCK PER REPLICA MEMBER, and
 * the whole point is that getting it wrong is silent — MONEY-1377.
 *
 * ## The defect this file exists to catch
 *
 * `hosts:` takes a list and the cluster publishes an SRV record, so the two
 * obvious configurations are one instance block naming the SRV name, or one
 * block listing all three members. BOTH ARE WRONG AND NEITHER FAILS.
 *
 * Most MongoDB metrics are monotonic counters, and the agent reports RATES by
 * subtracting the previous collection's value from this one's. If the
 * connection lands on a different member between two intervals — which is
 * precisely what an SRV connection string is FOR — the agent subtracts node B's
 * counter from node A's and publishes the difference. The check stays green,
 * `datadog-agent status` says OK, the dashboards keep drawing, and every rate is
 * fiction. There is no error anywhere to find.
 *
 * So the cases below assert the SHAPE of the rendered YAML rather than that the
 * script exited 0. An exit code cannot see this class of defect.
 *
 * ## Why the metric-name case is here
 *
 * `stage_verify`'s first draft queried `mongodb.opcounters.query.count`. That
 * name is plausible, reads correctly, and does not exist — the real series is a
 * per-second rate, `mongodb.opcounters.queryps`. It was caught only because the
 * verify stage asks the Datadog API whether a point ARRIVED instead of trusting
 * the agent's own OK. Had it gone into a monitor it would have sat in NO DATA
 * forever, which after one mute is indistinguishable from a healthy quiet
 * database (MONEY-1238). The fixture below is the set observed live on
 * 2026-09-06, so a future edit cannot reintroduce a guessed name.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(ROOT, "scripts/ops/datadog/setup-dbm-host.sh");
const SRC = readFileSync(SCRIPT, "utf8");

/** The three members the prod cluster's SRV record actually returns. */
const MEMBERS = [
  "stockbook-shard-00-00.lizbtx.mongodb.net",
  "stockbook-shard-00-01.lizbtx.mongodb.net",
  "stockbook-shard-00-02.lizbtx.mongodb.net",
];

/**
 * Metric names OBSERVED arriving in the us5 org on 2026-09-06, from
 * `GET /api/v1/metrics`. Anything the verify stage queries must be in here —
 * see the header. This is deliberately a small allow-list rather than a regex:
 * a regex over `mongodb\..*` would have accepted the wrong name too.
 */
const OBSERVED_METRICS = new Set([
  "mongodb.opcounters.queryps",
  "mongodb.opcounters.insertps",
  "mongodb.opcounters.updateps",
  "mongodb.opcounters.deleteps",
  "mongodb.opcounters.commandps",
  "mongodb.connections.current",
  "mongodb.connections.available",
  "mongodb.oplog.timediff",
  "mongodb.oplog.logsizemb",
  "mongodb.oplog.usedsizemb",
  "mongodb.replset.health",
  "mongodb.replset.state",
  "mongodb.replset.replicationlag",
  "mongodb.replset.optime_lag",
  "mongodb.mem.resident",
  "mongodb.uptime",
]);

/** The only four values Datadog's mongo check accepts for `additional_metrics`. */
const VALID_ADDITIONAL = new Set([
  "metrics.commands",
  "tcmalloc",
  "top",
  "collection",
]);

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** Every `gcloud …` invocation, one per line. */
  calls: string;
  /** Whatever was pushed to /etc/datadog-agent/conf.d/mongo.d/conf.yaml. */
  mongoConf: string;
  /** Whatever was pushed to /etc/datadog-agent/datadog.yaml. */
  agentConf: string;
  /** Every `curl` invocation, one per line — the Datadog query URLs. */
  curlLog: string;
}

/**
 * Run the REAL script with `gcloud` and `dig` stubbed.
 *
 * `node` stays real, because lib-datadog uses it to read DD_SITE out of
 * packages/datadog/src/constants.ts — which is the single source of truth this
 * script derives its site from, and stubbing it would make that derivation
 * unobservable.
 */
function run(
  stage: string,
  opts: {
    members?: string[];
    agentVersion?: string;
    /** Make the ssh that pushes conf.yaml fail, as a timeout would. */
    failConfigPush?: boolean;
    /** How many distinct hosts the Datadog query reports. */
    reportingHosts?: number;
    /** Replace the agent's mongo status block (empty = unreadable). */
    statusBlock?: string;
    /** The password the stubbed Secret Manager hands back. */
    mongoPassword?: string;
    /** Make `instances describe …natIP` answer differently from the reservation. */
    instanceIp?: string;
  } = {},
): Run {
  const members = opts.members ?? MEMBERS;
  const dir = mkdtempSync(join(tmpdir(), "dbm-host-"));
  const bin = join(dir, "bin");
  const captured = join(dir, "captured");
  spawnSync("mkdir", ["-p", bin, captured]);

  // `dig +short SRV _mongodb._tcp.<cluster>` — the real output shape is
  // "0 0 27017 host." with a TRAILING DOT, which the script has to strip.
  // Emitting it without the dot would let a broken stripper pass.
  writeFileSync(
    join(bin, "dig"),
    ["#!/bin/sh", ...members.map((m) => `echo "0 0 27017 ${m}."`), ""].join(
      "\n",
    ),
  );
  chmodSync(join(bin, "dig"), 0o755);

  // The gcloud stub. `compute ssh` reads its payload from STDIN — that is how
  // the real script moves both the remote script and the secret-bearing config
  // — so the stub saves stdin to a file the assertions can read.
  writeFileSync(
    join(bin, "gcloud"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$STUB_CALLS"',
      'case "$*" in',
      // Not-yet-existing IP / VM, so the create paths are exercised.
      '  *"addresses describe"*)  echo "8.231.90.169" ;;',
      // The IP lookup and the existence check are both `instances describe`;
      // only the IP one asks for natIP. Order matters — the specific case first.
      '  *"instances describe"*natIP*) echo "$STUB_INSTANCE_IP" ;;',
      '  *"instances describe"*)  exit 1 ;;',
      '  *"secrets versions access"*)',
      '    case "$*" in',
      '      *DD_MONGO_MONITOR_PASSWORD_PROD*) printf "%s\\n" "$STUB_MONGO_PW" ;;',
      '      *DD_APP_KEY_PROD*)                echo "STUB-APP-KEY" ;;',
      '      *)                                echo "STUB-API-KEY" ;;',
      "    esac ;;",
      '  *"compute ssh"*)',
      "    payload=$(cat)",
      '    case "$*" in',
      // A config push: the destination path is in the command, the bytes on stdin.
      '      *"conf.d/mongo.d/conf.yaml"*)',
      '        if [ -n "$STUB_FAIL_PUSH" ]; then echo "ssh: connect to host port 22: Connection timed out" >&2; exit 255; fi',
      '        printf "%s" "$payload" > "$STUB_CAPTURED/mongo.conf" ;;',
      '      *"datadog-agent/datadog.yaml"*) printf "%s" "$payload" > "$STUB_CAPTURED/agent.conf" ;;',
      "      *)",
      '        case "$payload" in',
      '          *"datadog-agent version"*) echo "Agent $STUB_AGENT_VERSION - Commit: abc" ;;',
      '          *"datadog-agent status"*) printf "%s\\n" "$STUB_STATUS_BLOCK" ;;',
      "          *) : ;;",
      "        esac ;;",
      "    esac ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "gcloud"), 0o755);

  // `sleep` is stubbed to nothing so the 120s verify wait does not run here.
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "sleep"), 0o755);

  // `curl` answers the Datadog query. dd_request reads `-K -` from stdin (the
  // credentials) and expects body then status, each on its own line.
  const hosts = opts.reportingHosts ?? 3;
  const series = Array.from({ length: hosts }, (_, i) => ({
    scope: `database_instance:atlas-shard-00-0${i}.example.mongodb.net:27017`,
    pointlist: [[Date.now(), 1]],
  }));
  writeFileSync(
    join(bin, "curl"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$STUB_CURL_LOG"',
      "cat > /dev/null", // drain the -K - credential config
      'printf "%s\\n200\\n" "$STUB_QUERY_BODY"',
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "curl"), 0o755);

  const r = spawnSync("bash", [SCRIPT, `--only=${stage}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_CALLS: join(dir, "calls.log"),
      STUB_CAPTURED: captured,
      STUB_AGENT_VERSION: opts.agentVersion ?? "7.83.0",
      STUB_FAIL_PUSH: opts.failConfigPush ? "1" : "",
      // Carries BOTH quote kinds. With a quote-free stub the single-quote
      // doubling could not be observed at all — only the quote STYLE was pinned.
      STUB_MONGO_PW: opts.mongoPassword ?? 'it\'s a "hard" p@ss',
      STUB_STATUS_BLOCK:
        opts.statusBlock ??
        "    mongo (1.2.3)\n      Instance ID: mongo:abc [OK]\n      Total Runs: 4\n      Total Errors: 0",
      STUB_QUERY_BODY: JSON.stringify({ series }),
      // Deliberately DIFFERENT from the reservation the stub reports for
      // `addresses describe`, so the two sources are distinguishable.
      STUB_INSTANCE_IP: opts.instanceIp ?? "203.0.113.77",
      STUB_CURL_LOG: join(dir, "curl.log"),
      DD_API_KEY: "stub-api-key",
      DD_APP_KEY: "stub-app-key",
    },
  });

  const read = (f: string) => {
    try {
      return readFileSync(join(captured, f), "utf8");
    } catch {
      return "";
    }
  };
  const calls = (() => {
    try {
      return readFileSync(join(dir, "calls.log"), "utf8");
    } catch {
      return "";
    }
  })();

  const curlLog = (() => {
    try {
      return readFileSync(join(dir, "curl.log"), "utf8");
    } catch {
      return "";
    }
  })();

  const out = {
    code: r.status ?? -1,
    curlLog,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    calls,
    mongoConf: read("mongo.conf"),
    agentConf: read("agent.conf"),
  };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

/**
 * The values under every `additional_metrics:` key, in render order.
 *
 * Deliberately reads the BLOCK — the key line, then the `- value` lines that
 * follow it until the list ends — so that every value the script emits is
 * returned, including one that is not a legal choice. A looser scan that
 * filtered for plausible values could not fail on an implausible one.
 */
function additionalMetrics(conf: string): string[] {
  const lines = conf.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s+additional_metrics:\s*$/.test(lines[i] ?? "")) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const m = /^\s+- (\S+)\s*$/.exec(lines[j] ?? "");
      if (!m) break;
      out.push(m[1] ?? "");
    }
  }
  return out;
}

/** Split the rendered YAML into its `- hosts:` instance blocks. */
function instanceBlocks(conf: string): string[] {
  const idx = conf.indexOf("instances:");
  assert.ok(idx >= 0, "rendered config has no `instances:` key");
  return conf
    .slice(idx)
    .split(/^\s*- hosts:/m)
    .slice(1);
}

describe("setup-dbm-host.sh renders one instance block per replica member", () => {
  it("renders exactly one block per member, each naming exactly ONE host", () => {
    const r = run("config");
    assert.equal(r.code, 0, `script failed:\n${r.stderr}`);

    const blocks = instanceBlocks(r.mongoConf);
    assert.equal(
      blocks.length,
      MEMBERS.length,
      `expected ${MEMBERS.length} instance blocks, got ${blocks.length}`,
    );

    // THE case. A block carrying two hosts is the counter-delta defect, and it
    // is what a well-meaning "just list them all" edit produces.
    for (const [i, block] of blocks.entries()) {
      const hosts = block
        .split("\n")
        .filter((l) => /^\s+- \S+:\d+\s*$/.test(l))
        .map((l) => l.trim().replace(/^- /, ""));
      assert.equal(
        hosts.length,
        1,
        `block ${i} names ${hosts.length} hosts (${hosts.join(", ")}); ` +
          `the agent deltas counters per connection, so a block must name exactly one member`,
      );
    }
  });

  it("covers every member the SRV record returned, with the trailing dot stripped", () => {
    const r = run("config");
    for (const m of MEMBERS) {
      assert.match(
        r.mongoConf,
        new RegExp(`- ${m.replace(/\./g, "\\.")}:27017$`, "m"),
        `member ${m} is missing, or kept its trailing dot`,
      );
    }
  });

  it("never names the SRV/cluster address as a host", () => {
    const r = run("config");
    // The bare cluster name resolves to a DIFFERENT member per connection —
    // exactly the failure the per-member blocks exist to prevent.
    const hostLines = r.mongoConf
      .split("\n")
      .filter((l) => /^\s+- \S+:\d+\s*$/.test(l));
    for (const line of hostLines) {
      assert.doesNotMatch(
        line,
        /(^|\s)-\s*stockbook\.lizbtx\.mongodb\.net:/,
        `a host line points at the SRV name: ${line.trim()}`,
      );
    }
  });

  it("sets tls, dbm and cluster_name in EVERY block", () => {
    const r = run("config");
    for (const [i, block] of instanceBlocks(r.mongoConf).entries()) {
      // Without tls Atlas refuses the connection (a ServerSelectionTimeoutError
      // that reads like a network problem); without cluster_name the agent
      // rejects a dbm-enabled instance outright.
      assert.match(block, /^\s+tls: true$/m, `block ${i} is missing tls: true`);
      assert.match(block, /^\s+dbm: true$/m, `block ${i} is missing dbm: true`);
      assert.match(
        block,
        /^\s+cluster_name: \S+$/m,
        `block ${i} is missing cluster_name`,
      );
    }
  });

  it("uses a cluster_name that Datadog will not silently rewrite", () => {
    const r = run("config");
    const names = [...r.mongoConf.matchAll(/^\s+cluster_name: (\S+)$/gm)].map(
      (m) => m[1] ?? "",
    );
    // Both halves matter: zero matches means nothing was rendered, and an EMPTY
    // capture would satisfy the normalisation check below vacuously.
    assert.ok(names.length > 0, "no cluster_name rendered");
    assert.ok(
      names.every((n) => n !== ""),
      "a cluster_name rendered empty",
    );
    for (const n of names) {
      // cluster_name is a tag VALUE: Datadog lowercases it and turns spaces into
      // underscores without telling you. A name that survives normalisation
      // unchanged is the only one that cannot drift from what a monitor queries.
      assert.equal(
        n,
        n.toLowerCase().replace(/\s+/g, "_"),
        `cluster_name ${n} would be rewritten`,
      );
    }
    assert.equal(
      new Set(names).size,
      1,
      "all blocks must share one cluster_name",
    );
  });

  it("does NOT set reported_database_hostname", () => {
    const r = run("config");
    // Datadog's own template shows this field, which is why it needs a case
    // rather than an absence nobody notices. One value across three blocks
    // gives all three members the SAME identity and collapses the replica set
    // into a single host; the agent already derives distinct, stable names from
    // serverStatus.host.
    assert.doesNotMatch(
      r.mongoConf,
      /reported_database_hostname/,
      "a single reported_database_hostname would collapse three members into one",
    );
  });

  it("requests only additional_metrics values the mongo check accepts", () => {
    const r = run("config");
    // Parse the actual `additional_metrics:` block rather than grepping the whole
    // file for anything list-shaped. The first version filtered candidates down
    // to values that already looked valid and THEN asserted they were valid,
    // which meant an arbitrary bad value (`tcmallocXYZ`, `oplog`) was discarded
    // before it could fail anything — the assertion could only ever catch a
    // `metrics.*` typo. Reading the block means every rendered value is judged.
    const listed = additionalMetrics(r.mongoConf);
    assert.ok(listed.length > 0, "no additional_metrics rendered");
    for (const v of listed) {
      assert.ok(
        VALID_ADDITIONAL.has(v),
        `${v} is not one of the four accepted additional_metrics`,
      );
    }
  });
});

describe("setup-dbm-host.sh fails closed", () => {
  it("refuses to render when the SRV record returns fewer than three members", () => {
    // A partial DNS answer would otherwise render two blocks and leave one
    // member unmonitored — which looks like a partial outage, not a config bug.
    const r = run("config", { members: MEMBERS.slice(0, 2) });
    assert.notEqual(r.code, 0, "a 2-member SRV answer must stop the run");
    assert.match(r.stderr, /SRV resolved 2 member/);
    assert.equal(
      r.mongoConf,
      "",
      "nothing may be pushed after a failed resolution",
    );
  });

  it("refuses an agent below the MongoDB DBM version floor", () => {
    // Below 7.58.0 the mongo check loads, runs, and reports metrics while
    // emitting no DBM payload at all — a silent partial.
    const r = run("agent", { agentVersion: "7.40.0" });
    assert.notEqual(r.code, 0, "an agent below the floor must stop the run");
    assert.match(r.stderr, /below the 7\.58\.0 MongoDB DBM floor/);
  });

  it("accepts an agent at or above the floor", () => {
    const r = run("agent", { agentVersion: "7.58.0" });
    assert.equal(r.code, 0, `the floor version itself must pass:\n${r.stderr}`);
  });
});

describe("setup-dbm-host.sh handles credentials and the site correctly", () => {
  it("moves the Mongo password over stdin, never on a command line", () => {
    const r = run("config");
    // Single-quoted: a double-quoted YAML scalar processes escapes, so a
    // password with a backslash or a quote either fails to parse or silently
    // becomes a different string.
    assert.match(
      r.mongoConf,
      /password: 'it''s a "hard" p@ss'/,
      "password never reached the file",
    );
    // Every gcloud invocation is logged with its full argv. The secret must
    // appear in none of them — a remote `--command=` string is readable through
    // `ps` on the target host for as long as it runs.
    assert.doesNotMatch(
      r.calls,
      /it's a "hard" p@ss/,
      "the Mongo password appeared in a command line",
    );
    assert.doesNotMatch(
      r.calls,
      /STUB-API-KEY/,
      "the Datadog API key appeared in a command line",
    );
  });

  it("derives the Datadog site from constants.ts rather than hardcoding it", () => {
    // The us3 -> us5 move cost this estate a silent, 403-shaped outage precisely
    // because the site had several spellings. A literal here would be another.
    assert.doesNotMatch(
      SRC.replace(/^\s*#.*$/gm, ""),
      /us[0-9]\.datadoghq\.com/,
      "the site is spelled literally in setup-dbm-host.sh instead of being derived",
    );
    const r = run("config");
    assert.match(
      r.agentConf,
      /^site: us5\.datadoghq\.com$/m,
      "the derived site did not reach datadog.yaml",
    );
  });

  it("only queries metric names that have been observed arriving", () => {
    // See the file header: the first draft queried a plausible name that does
    // not exist. Anything added here must be a series someone has actually seen.
    const loop = /for metric in ([^;]+); do/.exec(SRC);
    assert.ok(loop, "could not find the verify stage's metric list");
    const names = (loop[1] ?? "").trim().split(/\s+/).filter(Boolean);
    assert.ok(names.length >= 3, "expected at least three sampled metrics");
    for (const n of names) {
      assert.ok(
        OBSERVED_METRICS.has(n),
        `${n} has never been observed arriving in the us5 org`,
      );
    }
  });
});

describe("setup-dbm-host.sh provisions a VM that cannot be quietly lost", () => {
  it("creates the instance with deletion protection and identifying labels", () => {
    const r = run("vm");
    assert.equal(r.code, 0, `vm stage failed:\n${r.stderr}`);
    const create = r.calls
      .split("\n")
      .find((l) => l.includes("instances create"));
    assert.ok(create, "no instance create was issued");
    // The VM is dedicated so that database monitoring does not die with an
    // unrelated workload; deletion protection is the other half of that.
    assert.match(
      create,
      /--deletion-protection/,
      "the agent VM must be deletion-protected",
    );
    assert.match(
      create,
      /ticket=money-1377/,
      "the VM must carry its ticket label",
    );
    assert.match(
      create,
      /purpose=datadog-dbm/,
      "the VM must say what it is for",
    );
    assert.match(
      create,
      /--address=usemoney-prod-datadog-agent-ip/,
      "the VM must take the reserved static IP",
    );
  });
});

/**
 * The stage that proves arrival was, until this suite covered it, the one stage
 * that could not report a failure.
 *
 * `run_stage X && stage_X` exempts the whole call from `errexit`, so every
 * `return 1` inside a stage was swallowed and the script exited 0 regardless.
 * Measured on bash 3.2: a failed config push printed "wrote 3 instance blocks
 * and restarted the agent", and verify then passed on the PREVIOUS run's
 * points. None of it was visible to the suite because no case ran `verify` and
 * no case asserted an exit code on a failing stage.
 */
describe("setup-dbm-host.sh can actually fail", () => {
  it("aborts, and claims nothing, when the config push fails", () => {
    const r = run("config", { failConfigPush: true });
    assert.notEqual(r.code, 0, "a failed push must fail the run");
    assert.doesNotMatch(
      r.stdout,
      /wrote \d+ instance blocks/,
      "the run announced a write that did not happen",
    );
  });

  it("fails verify when fewer members report than were rendered", () => {
    // One member silent is the stale-block signature, and a cluster-scoped
    // query cannot see it — the other two keep every series alive.
    const r = run("verify", { reportingHosts: 1 });
    assert.notEqual(
      r.code,
      0,
      "a partially-reporting cluster must fail verify",
    );
    assert.match(r.stderr, /PARTIAL|members reporting/);
  });

  it("passes verify only when every member reports", () => {
    const r = run("verify", { reportingHosts: 3 });
    assert.equal(
      r.code,
      0,
      `a fully-reporting cluster must pass:\n${r.stderr}`,
    );
    assert.match(
      r.stdout,
      /all 3 sampled metrics are arriving from all 3 members/,
    );
  });

  it("refuses to call the check healthy when the status block is unreadable", () => {
    // ssh failing, the agent being stopped, and the sed range not matching all
    // produced an EMPTY block, which `grep -c` scored as zero errors.
    const r = run("verify", { statusBlock: "" });
    assert.notEqual(
      r.code,
      0,
      "an unreadable status block must not read as healthy",
    );
    assert.match(r.stderr, /could not read the mongo check's status block/);
  });

  it("counts only points that arrived after the stage began", () => {
    // The shared helper looks back 24h. Re-running after a topology change
    // would then be satisfied by yesterday's points — the run meant to catch a
    // bad render is exactly the run that window forgives.
    const r = run("verify", { reportingHosts: 3 });
    const froms = [...r.curlLog.matchAll(/[?&]from=(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    assert.ok(froms.length > 0, "verify issued no Datadog query");
    const now = Math.floor(Date.now() / 1000);
    for (const from of froms) {
      assert.ok(
        now - from < 3600,
        `verify looked back ${now - from}s; a window that wide passes on a previous run's points`,
      );
    }
  });

  it("groups by database_instance, or it cannot see a stale member at all", () => {
    const r = run("verify", { reportingHosts: 3 });
    // Decode the `query=` parameter only. The whole log contains other `%`
    // sequences that are not valid escapes, so decoding it wholesale throws.
    const queries = [...r.curlLog.matchAll(/[?&]query=([^&\s]+)/g)].map((m) => {
      try {
        return decodeURIComponent(m[1] ?? "");
      } catch {
        return m[1] ?? "";
      }
    });
    assert.ok(queries.length > 0, "verify issued no Datadog query");
    for (const q of queries) {
      // `host` is the AGENT VM and carries one value for the whole cluster —
      // measured. Grouping by it can never reach 3/3 and reports PARTIAL 1/3
      // against a healthy replica set. `database_instance` is the tag with one
      // value per member.
      assert.match(
        q,
        /by\s*\{database_instance\}/,
        "a cluster-scoped query stays green while one member reports nothing",
      );
      assert.doesNotMatch(
        q,
        /by\s*\{host\}/,
        "host is the agent VM, not the member",
      );
    }
  });
});

/**
 * The fixes round 1 asked for, each pinned so it cannot silently revert.
 *
 * Round 2 measured that six of them had no test at all: reverting the quote
 * doubling, the 0600 mode, the single-`install` push, the instance-sourced /32,
 * `sort -u`, and the empty `--only=` guard each left the suite fully green. A
 * fix nothing asserts lasts until the next refactor.
 */
describe("setup-dbm-host.sh keeps the round-1 fixes", () => {
  it("writes the agent config in one install at 0600, never tee-then-chmod", () => {
    const r = run("config");
    const push = r.calls
      .split("\n")
      .find((l) => l.includes("conf.d/mongo.d/conf.yaml"));
    assert.ok(push, "no config push was issued");
    // tee creates the file under root's umask (0644) and the mode is narrowed
    // two links later, so a failing chown leaves the Atlas password readable.
    assert.match(
      push,
      /install -m 0600/,
      "the config is not created 0600 in one step",
    );
    assert.doesNotMatch(
      push,
      /\btee\b/,
      "tee creates the file before the mode is set",
    );
  });

  it("takes the Atlas /32 from the instance, not the address reservation", () => {
    // `addresses describe` answers whether or not the VM is attached to it, so a
    // rebuilt host would have us print an IP the agent does not egress from.
    const r = run("vm", { instanceIp: "203.0.113.77" });
    assert.match(
      r.stdout,
      /203\.0\.113\.77\/32/,
      "the printed /32 is not the instance's address",
    );
  });

  it("refuses a duplicated SRV target rather than counting it twice", () => {
    const first = MEMBERS[0] ?? "";
    const second = MEMBERS[1] ?? "";
    const r = run("config", { members: [first, first, second] });
    assert.notEqual(
      r.code,
      0,
      "a duplicated SRV target must not satisfy the member gate",
    );
    assert.match(r.stderr, /SRV resolved 2 member/);
  });

  it("refuses a password containing a newline", () => {
    // It cannot be represented in a single-quoted scalar, and `--only=config`
    // would otherwise push an unparseable file and exit 0.
    const r = run("config", { mongoPassword: "line1\nline2" });
    assert.notEqual(r.code, 0, "a newline in the password must stop the run");
    assert.match(r.stderr, /contains a newline/);
  });

  it("cleans up on a signal AND stops, rather than carrying on", () => {
    // A handler with no `exit` returns control to the line after the interrupted
    // command, so `timeout N setup-dbm-host.sh` used to delete the temp dir and
    // then print "done." with exit 0.
    assert.match(
      SRC,
      /trap '[^']*exit 130' INT TERM/,
      "the INT/TERM handler must exit, not fall through to the next line",
    );
  });

  it("only demands Datadog credentials for the stage that uses them", () => {
    // `config` reads its agent key from Secret Manager and `vm`/`agent` touch no
    // Datadog API, so requiring both keys on every invocation broke --only=vm.
    assert.match(
      SRC,
      /if ! \$DRY_RUN && run_stage verify; then/,
      "the credential gate must be scoped to the verify stage",
    );
  });

  it("reports the HTTP status when the Datadog query fails", () => {
    // `n="$(dbm_reporting_hosts …)"` ran the function in a command-substitution
    // SUBSHELL, so dd_request's RESPONSE_STATUS was set in a child and the error
    // line always printed `(HTTP ?)` — on the one stage whose job is diagnosis.
    // Comments stripped: the fix's own explanation quotes the broken form.
    assert.doesNotMatch(
      SRC.replace(/^\s*#.*$/gm, ""),
      /\$\(dbm_reporting_hosts/,
      "calling it in a subshell discards RESPONSE_STATUS and RESPONSE_BODY",
    );
    assert.match(
      SRC,
      /DBM_HOSTS=/,
      "the count must come back through a global",
    );
  });
});
