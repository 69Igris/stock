/**
 * MONEY-1611 — the `lake-gold` job: the Dataform CLI builds gold in a Cloud
 * Run job, as `lake-dataform-{env}@`, from the `dataform/` the image carries.
 *
 * Two halves. The PURE one (`lake-gold-logic.ts`): the argv the job accepts
 * and refuses, the CLI invocation it builds, and the verdict it reads off the
 * CLI's transcript — where "exit 0" is not trusted alone, because CLI 3.0.0
 * exits 0 on a run that executed nothing. The WIRING one: the image carries
 * the CLI at the project's pinned core version, the release re-pins the job,
 * and the provisioner runs it as the right account on the planned slots.
 *
 * The process-level exit codes (a failed assertion -> non-zero, end to end
 * through a real `node` process) are in `lake-gold-job.spawntest.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { setupScriptFor } from "../../src/ops/build-provenance";
import {
  GOLD_QUIET_MS,
  GOLD_SILVER_INPUTS,
  goldCliArgs,
  goldCredentials,
  goldLoadingQuery,
  goldLoadingSkip,
  goldVerdict,
  parseGoldArgs,
  tallyGoldOutput,
} from "../../src/ops/lake-gold-logic";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// ── the transcript CLI 3.0.0 prints (`printExecutedAction`), one per action ──
const TABLES = [
  "adjusted_bar_d1 [view]",
  "chart_tile_manifest [view]",
  "coverage_price_bar_d1 [view]",
  "returns_daily [view]",
  "rolling_stats [table]",
  "event_return_outcome [incremental]",
];
const ASSERTIONS = [
  "assert_latest_bar_is_unadjusted",
  "assert_india_split_is_adjusted",
  "lake_gold_prod_rolling_stats_assertions_uniqueKey_0",
];
const GREEN = [
  "Compiling...",
  "",
  "Compiled successfully.",
  "",
  "Running...",
  "",
  ...TABLES.map((t) => `Table created:  lake_gold_prod.${t}`),
  ...ASSERTIONS.map((a) => `Assertion passed:  lake_gold_prod.${a}`),
].join("\n");

const FULL = parseGoldArgs(["--env", "prod"]);
const TARGETED = parseGoldArgs([
  "--env",
  "prod",
  "--actions",
  "event_return_outcome",
]);

describe("parseGoldArgs — what the job accepts", () => {
  it("requires --env qa|prod", () => {
    assert.throws(() => parseGoldArgs([]), /--env must be qa or prod/);
    assert.throws(
      () => parseGoldArgs(["--env", "staging"]),
      /--env must be qa or prod/,
    );
    assert.equal(parseGoldArgs(["--env", "qa"]).env, "qa");
  });

  it("REFUSES an --env that disagrees with the Cloud Run job's suffix", () => {
    // lake-dataform-prod@ writes lake_gold_prod only: a prod job told qa would
    // fail at the first write, halfway through, instead of before it starts.
    assert.throws(
      () => parseGoldArgs(["--env", "qa"], "lake-gold-prod"),
      /--env qa inside Cloud Run job lake-gold-prod.*lake_gold_prod only.*Execute lake-gold-qa instead/,
    );
    assert.throws(
      () => parseGoldArgs(["--env", "prod"], "lake-gold-qa"),
      /Execute lake-gold-prod instead/,
    );
    assert.equal(
      parseGoldArgs(["--env", "prod"], "lake-gold-prod").env,
      "prod",
    );
    // Outside Cloud Run there is no suffix to disagree with.
    assert.equal(parseGoldArgs(["--env", "prod"], undefined).env, "prod");
  });

  it("REFUSES every flag it does not own — no way to split vars from schema", () => {
    for (const smuggled of [
      ["--vars=env=qa"],
      ["--default-schema=lake_gold_qa"],
      ["--assertion-schema", "lake_gold_qa"],
      ["--tags", "gold"],
      ["--credentials", "/tmp/key.json"],
      ["--dry-run"],
      // Prototype keys: `in` walked the prototype and accepted these.
      ["constructor"],
      ["__proto__"],
      ["toString"],
      ["hasOwnProperty"],
    ]) {
      assert.throws(
        () => parseGoldArgs(["--env", "prod", ...smuggled]),
        /unknown argument/,
        smuggled.join(" "),
      );
    }
  });

  it("an action is one BARE name — dotted and wildcard names are dropped by the CLI", () => {
    for (const bad of [
      "lake_gold_prod.event_return_outcome",
      "event_*",
      "a,b",
      "--full-refresh",
    ]) {
      assert.throws(
        () => parseGoldArgs(["--env", "prod", "--actions", bad]),
        /--actions needs one action name/,
        bad,
      );
    }
    assert.throws(
      () => parseGoldArgs(["--env", "prod", "--actions"]),
      /--actions needs one action name/,
    );
    assert.deepEqual(
      parseGoldArgs([
        "--env",
        "prod",
        "--actions",
        "rolling_stats",
        "--actions",
        "returns_daily",
      ]).actions,
      ["rolling_stats", "returns_daily"],
    );
  });

  it("the dependency flags need --actions, or they would widen the scheduled run", () => {
    for (const f of ["--include-deps", "--include-dependents"]) {
      assert.throws(
        () => parseGoldArgs(["--env", "prod", f]),
        /need --actions/,
      );
    }
  });
});

describe("goldCliArgs — the invocation", () => {
  it("the scheduled run: every model tagged gold, prod everywhere, qa nowhere", () => {
    const argv = goldCliArgs(FULL, "/app/dataform", "/tmp/c.json");
    assert.deepEqual(argv.slice(0, 2), ["run", "/app/dataform"]);
    for (const want of [
      "--credentials=/tmp/c.json",
      "--default-database=stock-book-483718",
      "--default-location=asia-south1",
      "--default-schema=lake_gold_prod",
      "--assertion-schema=lake_gold_prod",
      "--vars=env=prod",
      "--tags=gold",
    ]) {
      assert.ok(argv.includes(want), `missing ${want}`);
    }
    assert.ok(!argv.some((a) => /_qa\b|env=qa/.test(a)), argv.join(" "));
    assert.ok(
      !argv.some((a) => /^--actions|^--full-refresh|^--include/.test(a)),
    );
  });

  it("the event_return_outcome backfill: one model, from scratch, with its assertions", () => {
    const argv = goldCliArgs(
      parseGoldArgs([
        "--env",
        "prod",
        "--actions",
        "event_return_outcome",
        "--full-refresh",
        "--include-dependents",
      ]),
      "/app/dataform",
      "/tmp/c.json",
    );
    // `--flag=value`: a yargs array flag followed by a bare value list would
    // swallow the next token.
    assert.ok(argv.includes("--actions=event_return_outcome"));
    assert.ok(argv.includes("--full-refresh"));
    assert.ok(argv.includes("--include-dependents"));
    assert.ok(
      !argv.includes("--tags=gold"),
      "a targeted run must not ALSO select the tag",
    );
  });

  it("the credentials file carries NO key, so the CLI uses the runtime SA", () => {
    assert.deepEqual(goldCredentials(), {
      projectId: "stock-book-483718",
      location: "asia-south1",
    });
  });
});

describe("tallyGoldOutput + goldVerdict — exit 0 is not trusted alone", () => {
  it("a green transcript with exit 0 is a success", () => {
    const t = tallyGoldOutput(GREEN);
    assert.equal(t.built.length, 6);
    assert.equal(t.assertionsPassed.length, 3);
    const v = goldVerdict(t, 0, FULL);
    assert.deepEqual(v.problems, []);
    assert.equal(v.ok, true);
  });

  it("a FAILED ASSERTION fails the run, and is named", () => {
    const out =
      GREEN +
      "\nAssertion failed:  lake_gold_prod.assert_no_double_adjustment_witness\n" +
      "    > SELECT * FROM x\n" +
      "    Assertion failed: query returned 3 row(s).\n";
    const t = tallyGoldOutput(out);
    assert.deepEqual(t.assertionsFailed, [
      "lake_gold_prod.assert_no_double_adjustment_witness",
    ]);
    const v = goldVerdict(t, 1, FULL);
    assert.equal(v.ok, false);
    assert.ok(
      v.problems.some((p) =>
        /1 assertion\(s\) FAILED: lake_gold_prod\.assert_no_double_adjustment_witness/.test(
          p,
        ),
      ),
      v.problems.join("\n"),
    );
    // …and the transcript's own verdict decides even when the CLI exits 0.
    assert.equal(goldVerdict(t, 0, FULL).ok, false);
  });

  it("a failed build, and the actions skipped behind it, fail the run", () => {
    const out = [
      "Dataset creation failed:  lake_gold_prod.adjusted_bar_d1 [view]",
      "    > CREATE OR REPLACE VIEW …",
      "    Unrecognized name: observed_ratio",
      "Skipping dataset creation:  lake_gold_prod.returns_daily [view]",
      "Skipping assertion execution:  lake_gold_prod.assert_latest_bar_is_unadjusted",
    ].join("\n");
    const t = tallyGoldOutput(out);
    assert.deepEqual(t.buildFailed, ["lake_gold_prod.adjusted_bar_d1"]);
    assert.equal(t.skipped.length, 2);
    const v = goldVerdict(t, 1, FULL);
    assert.equal(v.ok, false);
    assert.equal(v.problems.length, 3); // exit, build failed, skipped
  });

  it("NOTHING RAN is a failure — CLI 3.0.0 drops an unknown --actions name and exits 0", () => {
    const v = goldVerdict(
      tallyGoldOutput("Compiling...\n\nCompiled successfully.\n\nRunning...\n"),
      0,
      parseGoldArgs(["--env", "prod", "--actions", "event_retrun_outcome"]),
    );
    assert.equal(v.ok, false);
    assert.match(v.problems.join("\n"), /no action ran/);
  });

  it("a non-zero exit fails the run even over a green transcript", () => {
    assert.equal(goldVerdict(tallyGoldOutput(GREEN), 1, FULL).ok, false);
  });

  it("an INDENTED line is never a verdict — the SQL of a failed task is echoed", () => {
    const t = tallyGoldOutput(
      "    > -- Assertion passed:  lake_gold_prod.fake\n" +
        "    Table created:  lake_gold_prod.fake [view]\n",
    );
    assert.equal(t.built.length + t.assertionsPassed.length, 0);
  });

  it("ANSI colour is stripped (NO_COLOR is a request, not a guarantee)", () => {
    const t = tallyGoldOutput(
      "\x1b[32mAssertion passed: \x1b[0m \x1b[36mlake_gold_prod.a\x1b[0m\n",
    );
    assert.deepEqual(t.assertionsPassed, ["lake_gold_prod.a"]);
  });

  it("a targeted rebuild that ran no assertion WARNS toward --include-dependents", () => {
    const v = goldVerdict(
      tallyGoldOutput(
        "Table created:  lake_gold_prod.event_return_outcome [incremental]\n",
      ),
      0,
      TARGETED,
    );
    assert.equal(v.ok, true);
    assert.match(v.warnings.join("\n"), /--include-dependents/);
    // The scheduled run selects assertions by tag, so it never gets the warning.
    assert.deepEqual(goldVerdict(tallyGoldOutput(GREEN), 0, FULL).warnings, []);
  });

  it("a PARTLY misspelled --actions list fails, naming the name that did not run", () => {
    const v = goldVerdict(
      tallyGoldOutput(
        "Table created:  lake_gold_prod.rolling_stats [table]\n" +
          "Assertion passed:  lake_gold_prod.lake_gold_prod_rolling_stats_assertions_uniqueKey_0\n",
      ),
      0,
      parseGoldArgs([
        "--env",
        "prod",
        "--actions",
        "rolling_stats",
        "--actions",
        "event_retrun_outcome",
      ]),
    );
    assert.equal(v.ok, false);
    assert.deepEqual(v.problems, [
      "`event_retrun_outcome` did not run (dropped by the CLI)",
    ]);
    // …matched on the LAST dotted segment, so a real name is not flagged.
    assert.equal(
      goldVerdict(
        tallyGoldOutput(
          "Table created:  lake_gold_prod.rolling_stats [table]\n",
        ),
        0,
        parseGoldArgs(["--env", "prod", "--actions", "rolling_stats"]),
      ).problems.length,
      0,
    );
  });

  it("a DISABLED action is tallied apart and WARNED, never counted as built", () => {
    const t = tallyGoldOutput(
      GREEN +
        "\nDataset creation disabled:  lake_gold_prod.chart_tile_manifest [view] [disabled]\n" +
        "Assertion execution disabled:  lake_gold_prod.assert_x [disabled]\n",
    );
    assert.deepEqual(t.disabled, [
      "lake_gold_prod.chart_tile_manifest",
      "lake_gold_prod.assert_x",
    ]);
    assert.equal(t.built.length, 6);
    assert.equal(t.assertionsPassed.length, 3);
    const v = goldVerdict(t, 0, FULL);
    assert.equal(v.ok, true);
    assert.match(v.warnings.join("\n"), /2 action\(s\) are DISABLED/);
  });
});

describe("the mid-reload gate — goldLoadingQuery", () => {
  const LEASE = 6 * 3600_000;

  it("reads this env's ledger for this env's silver, gold's inputs only", () => {
    for (const env of ["qa", "prod"] as const) {
      const { query, params } = goldLoadingQuery(env, LEASE);
      assert.match(
        query,
        new RegExp(
          `\`stock-book-483718\\.lake_bronze_${env}\\.partition_load\``,
        ),
      );
      assert.equal(params.dataset, `lake_silver_${env}`);
      assert.deepEqual(params.tables, [...GOLD_SILVER_INPUTS]);
      assert.equal(params.lease, LEASE);
      assert.equal(params.quiet, GOLD_QUIET_MS);
    }
  });

  it("a LIVE LOADING claim by the ledger's own arithmetic, OR any claim inside the quiet window", () => {
    // The WHERE clause alone: `clears_at` repeats the LOADING test in the
    // SELECT list, and a scan of the whole query was satisfied by that copy
    // with the filter's own LOADING test deleted.
    const where =
      goldLoadingQuery("prod", LEASE).query.split(/\bWHERE\b/)[1] ?? "";
    assert.match(
      where,
      /\(\(state = 'LOADING' AND TIMESTAMP_DIFF\(CURRENT_TIMESTAMP\(\), loaded_at, MILLISECOND\) <= @lease\)\s*OR TIMESTAMP_DIFF\(CURRENT_TIMESTAMP\(\), loaded_at, MILLISECOND\) <= @quiet\)/,
    );
    assert.match(where, /`table` IN UNNEST\(@tables\)/);
    assert.match(where, /dataset = @dataset/);
  });

  it("the quiet window outlasts the slowest per-month replay cycle, and is far under the lease", () => {
    assert.ok(
      GOLD_QUIET_MS >= 5 * 298_000,
      "under 5x the slowest F&O month (298 s)",
    );
    assert.ok(GOLD_QUIET_MS < LEASE);
  });

  it("says WHEN each table clears: a live claim's lease end, else 30 min after the newest claim", () => {
    const { query } = goldLoadingQuery("prod", LEASE);
    assert.match(
      query,
      /MAX\(IF\(\s*state = 'LOADING' AND TIMESTAMP_DIFF\(CURRENT_TIMESTAMP\(\), loaded_at, MILLISECOND\) <= @lease,\s*TIMESTAMP_ADD\(loaded_at, INTERVAL @lease MILLISECOND\),\s*TIMESTAMP_ADD\(loaded_at, INTERVAL @quiet MILLISECOND\)\)\)\) AS clears_at/,
    );
    assert.match(query, /FORMAT_TIMESTAMP\('%Y-%m-%dT%H:%M:%SZ'/);
  });

  const ROWS = [
    {
      table: "price_bar_d1",
      partitions: "US/1971-01, US/1971-02",
      clearsAt: "2026-09-24T01:04:03Z",
    },
    {
      table: "index_eod",
      partitions: "IN/2023-04",
      clearsAt: "2026-09-23T19:30:00Z",
    },
  ];

  it("a PLAIN scheduled run skips with exit 0 — the next slot builds", () => {
    const skip = goldLoadingSkip(ROWS, FULL);
    assert.equal(skip.exitCode, 0);
    assert.equal(skip.targeted, false);
    assert.equal(skip.reason, "skipped_loading: price_bar_d1, index_eod");
    assert.deepEqual(skip.lines, [
      "SKIPPED_LOADING price_bar_d1: US/1971-01, US/1971-02",
      "SKIPPED_LOADING index_eod: IN/2023-04",
    ]);
  });

  it("a TARGETED run exits 1 with a retry time — the deployed args would never redo it", () => {
    for (const argv of [
      [
        "--env",
        "prod",
        "--full-refresh",
        "--actions",
        "event_return_outcome",
        "--include-dependents",
      ],
      ["--env", "prod", "--actions", "rolling_stats"],
      ["--env", "prod", "--full-refresh"],
    ]) {
      const skip = goldLoadingSkip(ROWS, parseGoldArgs(argv));
      assert.equal(skip.exitCode, 1, argv.join(" "));
      assert.equal(skip.targeted, true);
      assert.equal(
        skip.reason,
        "skipped_loading_targeted: price_bar_d1, index_eod; retry after 2026-09-24T01:04:03Z",
      );
    }
  });

  it("the retry time is the LATEST clear time, whatever the row order", () => {
    assert.equal(
      goldLoadingSkip(ROWS, FULL).retryAfter,
      "2026-09-24T01:04:03Z",
    );
    assert.equal(
      goldLoadingSkip([...ROWS].reverse(), FULL).retryAfter,
      "2026-09-24T01:04:03Z",
    );
  });
});

describe("agreement with dataform/definitions", () => {
  const GOLD_DIR = join(ROOT, "dataform", "definitions", "gold");

  it("GOLD_SILVER_INPUTS is exactly the silver tables the project declares", () => {
    const decl = read("dataform/definitions/silver_views/declarations.js");
    const declared = [
      ...decl.matchAll(
        /^declare\(\{\s*schema:\s*datasets\.silver\(\),\s*name:\s*"(\w+)"\s*\}\);/gm,
      ),
    ].map((m) => m[1]);
    assert.ok(
      declared.length >= 5,
      `parsed only ${declared.length} declarations`,
    );
    assert.deepEqual([...declared].sort(), [...GOLD_SILVER_INPUTS].sort());
  });

  it("EVERY gold definition carries the `gold` tag — the scheduled run selects by it", () => {
    const files = readdirSync(GOLD_DIR).filter((f) => f.endsWith(".sqlx"));
    assert.ok(files.length >= 10, `only ${files.length} gold definitions`);
    const untagged = files.filter((f) => {
      const config = /^config\s*\{[\s\S]*?^\}/m.exec(
        readFileSync(join(GOLD_DIR, f), "utf8"),
      )?.[0];
      const tags = /tags:\s*\[([^\]]*)\]/.exec(config ?? "")?.[1] ?? "";
      return !/"gold"/.test(tags);
    });
    assert.deepEqual(
      untagged,
      [],
      "a gold definition without the `gold` tag is never built by the scheduled run",
    );
  });
});

describe("wiring — the image, the release, the provisioner", () => {
  const settings = read("dataform/workflow_settings.yaml");
  const dockerfile = read("workers/Dockerfile");
  const setup = read("scripts/ops/setup-dataform.sh");
  const job = read("scripts/jobs/lake-gold.ts");
  const coreVersion = /^dataformCoreVersion:\s*(\S+)/m.exec(settings)?.[1];

  it("[premise] the pinned core version was read", () => {
    assert.match(coreVersion ?? "", /^\d+\.\d+\.\d+$/);
  });

  it("the CLI comes from a LOCKFILE, pinned at the project's core version", () => {
    // The job runs npm OFFLINE: a cached core that is not the pinned one is a
    // compile error, and a CLI of another major may not compile it at all.
    const pkg = JSON.parse(read("tools/dataform-cli/package.json")) as {
      dependencies: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const lock = JSON.parse(read("tools/dataform-cli/package-lock.json")) as {
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    assert.equal(
      pkg.dependencies["@dataform/cli"],
      coreVersion,
      "exact, no range",
    );
    const cli = lock.packages["node_modules/@dataform/cli"];
    assert.equal(cli?.version, coreVersion);
    assert.match(cli?.integrity ?? "", /^sha512-/);
    assert.equal(
      pkg.scripts,
      undefined,
      "nothing here for a test or build runner to find",
    );
  });

  it("the image installs it with `npm ci --ignore-scripts`, and caches core at the same version", () => {
    assert.match(
      dockerfile,
      /^COPY tools\/dataform-cli \.\/tools\/dataform-cli$/m,
    );
    assert.match(
      dockerfile,
      /cd \/app\/tools\/dataform-cli \\\s*\n\s*&& npm ci --ignore-scripts --omit=dev/,
    );
    assert.match(
      dockerfile,
      /ln -s \/app\/tools\/dataform-cli\/node_modules\/\.bin\/dataform \/usr\/local\/bin\/dataform/,
    );
    assert.doesNotMatch(
      dockerfile,
      /npm install -g|npm i -g/,
      "an unlocked install",
    );
    assert.equal(
      /npm cache add @dataform\/core@(\S+)/.exec(dockerfile)?.[1],
      coreVersion,
    );
    assert.match(dockerfile, /^COPY dataform \.\/dataform$/m);
  });

  it("tools/dataform-cli is NOT a yarn workspace, so yarn and turbo never see it", () => {
    const { workspaces } = JSON.parse(read("package.json")) as {
      workspaces: string[];
    };
    assert.ok(workspaces.length > 0);
    const asRegex = (glob: string) =>
      new RegExp(`^${glob.replace(/\*/g, "[^/]+")}$`);
    assert.ok(
      !workspaces.some((w) => asRegex(w).test("tools/dataform-cli")),
      `a workspace glob matches tools/dataform-cli: ${workspaces.join(", ")}`,
    );
  });

  it("the image build COMPILES the project, offline, for both envs", () => {
    // The loop BODY, up to its own `done`: the file has another `|| exit 1`
    // (the HEALTHCHECK), and a pattern allowed to run past `done` found it
    // after the compile's own had been deleted.
    const body = /for GOLD_ENV in qa prod; do([\s\S]*?)\bdone\b/.exec(
      dockerfile,
    )?.[1];
    assert.ok(body, "no compile loop in workers/Dockerfile");
    assert.match(
      body,
      /npm_config_offline=true dataform compile \/app\/dataform[\s\S]*--vars=env=\$\{GOLD_ENV\}[\s\S]*--assertion-schema=lake_gold_\$\{GOLD_ENV\}[\s\S]*\|\| exit 1/,
    );
  });

  it("the job runs the CLI offline — a cache miss is an error, never a fetch", () => {
    assert.match(job, /npm_config_offline:\s*"true"/);
  });

  it("tsup builds the job, and BOTH release loops re-pin it", () => {
    assert.match(
      read("workers/tsup.config.ts"),
      /"lake-gold":\s*"\.\.\/scripts\/jobs\/lake-gold\.ts"/,
    );
    for (const spec of [
      "workers/cloudbuild.prod.yaml",
      "workers/cloudbuild.qa.yaml",
    ]) {
      const loop = /for BASE in ([^\n;]+);/.exec(read(spec))?.[1] ?? "";
      assert.ok(loop.split(/\s+/).includes("lake-gold"), spec);
      assert.match(read(spec), /lake-gold\)\s+SETUP="setup-dataform\.sh"/);
    }
    assert.equal(setupScriptFor("lake-gold"), "scripts/ops/setup-dataform.sh");
  });

  it("the provisioner runs it as lake-dataform-{env}@ with no key and no Mongo", () => {
    assert.match(setup, /JOB_SA="lake-dataform-\$\{ENV\}@/);
    assert.match(setup, /--service-account="\$JOB_SA"/);
    // A mounted key would beat the runtime SA wherever a client reads it.
    const secrets = /--set-secrets="([^"]+)"/.exec(setup)?.[1];
    assert.equal(secrets, "DD_API_KEY=${DD_SECRET}:latest");
    assert.doesNotMatch(
      setup.replace(/^\s*#.*$/gm, ""),
      /GCP_SERVICE_ACCOUNT_KEY_BASE64|GOOGLE_APPLICATION_CREDENTIALS|DATABASE_URL/,
    );
  });

  it("the ledger read is granted on the partition_load TABLE, never bronze's dataset", () => {
    assert.match(
      setup,
      /LEDGER_TABLE="\$\{PROJECT_ID\}:lake_bronze_\$\{ENV\}\.partition_load"/,
    );
    assert.match(
      setup,
      /bq --project_id="\$PROJECT_ID" add-iam-policy-binding \\\s*\n\s*--member="serviceAccount:\$\{JOB_SA\}" --role=roles\/bigquery\.dataViewer \\\s*\n\s*"\$LEDGER_TABLE"/,
    );
    const code = setup.replace(/^\s*#.*$/gm, "");
    assert.doesNotMatch(
      code,
      /bigquery\.dataEditor|WRITER/,
      "no write anywhere",
    );
    assert.doesNotMatch(
      code,
      /lake_bronze_\$\{ENV\}(?!\.partition_load)/,
      "bronze named without the table",
    );
  });

  it("ORDER says to full-refresh event_return_outcome after a historical replay", () => {
    assert.match(
      setup,
      /AFTER ANY HISTORICAL REPLAY[\s\S]*?--full-refresh,--actions,event_return_outcome,--include-dependents/,
    );
  });

  it("the runbook checks for a running execution before a manual run", () => {
    assert.match(
      setup,
      /BEFORE ANY MANUAL RUN[\s\S]{0,200}executions list --job=\$\{JOB_NAME\}/,
    );
  });

  it("the scheduled run is the DEPLOYED args, and they name only the env", () => {
    // A bare POST to `:run` executes these, so they must be the full build.
    assert.match(setup, /--args="--env,\$\{ENV\}"$/m);
    assert.match(setup, /--max-retries=0/);
  });

  it("two triggers, 06:45 and 20:15 IST, both POSTing to the job as its own SA", () => {
    const crons = [
      ...setup.matchAll(
        /^schedule_job_run\s+"(lake-gold-[a-z-]+)"\s+"lake-gold"\s+"([^"]+)"/gm,
      ),
    ].map((m) => [m[1], m[2]]);
    assert.deepEqual(crons, [
      ["lake-gold-after-us", "45 6 * * *"],
      ["lake-gold-after-in", "15 20 * * *"],
    ]);
    assert.match(setup, /--time-zone="Asia\/Kolkata"/);
    assert.match(setup, /--oauth-service-account-email="\$JOB_SA"/);
    assert.match(
      setup,
      /run jobs add-iam-policy-binding "\$JOB_NAME"[\s\S]{0,120}--role=roles\/run\.invoker/,
    );
  });
});
