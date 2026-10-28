/**
 * MONEY-1611 — `lake-gold`'s EXIT CODE, end to end.
 *
 * "Gold assertions must fail the job (exit non-zero), never pass silently" is
 * a property of a PROCESS, so it is asserted on one: the real job entry point
 * (`scripts/jobs/lake-gold.ts`) is launched through tsx with a FAKE `dataform`
 * first on PATH, which records what it was given and prints a canned CLI 3.0.0
 * transcript, and a FAKE `@google-cloud/bigquery` (a loader hook, see
 * fixtures/lake-gold/) standing in for the lake ledger read. No BigQuery, no
 * network, no credentials.
 *
 * `.spawntest.ts` because every case is a process launch (MONEY-1316).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GOLD_QUIET_MS,
  GOLD_SILVER_INPUTS,
} from "../../src/ops/lake-gold-logic";
import { CLAIM_LEASE_MS } from "../../../lake/src/ledger-logic";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const JOB = join(ROOT, "scripts", "jobs", "lake-gold.ts");
const FAKE_BQ = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "lake-gold",
  "register-fake-bigquery.mjs",
);

const BIN = mkdtempSync(join(tmpdir(), "fake-dataform-"));
writeFileSync(
  join(BIN, "dataform"),
  [
    "#!/bin/sh",
    'for a in "$@"; do printf "%s\\n" "$a"; done > "$FAKE_DF_LOG"',
    'printf "offline=%s\\n" "$npm_config_offline" >> "$FAKE_DF_LOG"',
    'printf "%s" "$FAKE_DF_OUT"',
    // FAKE_DF_OUT2 set: the stderr write lands BETWEEN two halves of one
    // stdout line, each its own pipe chunk.
    'if [ -n "$FAKE_DF_OUT2" ]; then sleep 0.3; fi',
    'printf "%s" "$FAKE_DF_ERR" >&2',
    'if [ -n "$FAKE_DF_OUT2" ]; then sleep 0.3; printf "%s" "$FAKE_DF_OUT2"; fi',
    'exit "$FAKE_DF_EXIT"',
    "",
  ].join("\n"),
);
chmodSync(join(BIN, "dataform"), 0o755);

const GREEN =
  "Compiling...\n\nCompiled successfully.\n\nRunning...\n\n" +
  "Table created:  lake_gold_prod.adjusted_bar_d1 [view]\n" +
  "Assertion passed:  lake_gold_prod.assert_latest_bar_is_unadjusted\n";
const FAILED_ASSERTION =
  "Assertion failed:  lake_gold_prod.assert_india_split_is_adjusted\n" +
  "    > SELECT …\n";

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** What the fake CLI was given, or null when it was never started. */
  log: string | null;
  /** What the job sent to the fake BigQuery client, one entry per query. */
  bq: Array<{
    client: unknown;
    query: { query: string; params: Record<string, unknown> };
  }>;
}

function run(
  args: string[],
  fake: { out?: string; out2?: string; err?: string; exit?: number },
  extraEnv: Record<string, string> = {},
): Run {
  const dir = mkdtempSync(join(tmpdir(), "fake-dataform-log-"));
  const log = join(dir, "argv");
  const bqLog = join(dir, "bq");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${BIN}:${process.env.PATH ?? ""}`,
    FAKE_DF_LOG: log,
    FAKE_DF_OUT: fake.out ?? "",
    FAKE_DF_ERR: fake.err ?? "",
    FAKE_DF_OUT2: fake.out2 ?? "",
    FAKE_DF_EXIT: String(fake.exit ?? 0),
    FAKE_BQ_LOG: bqLog,
    ...extraEnv,
  };
  // No telemetry leaves a test, and no ambient job identity leaks in.
  delete env.DD_API_KEY;
  if (!("CLOUD_RUN_JOB" in extraEnv)) delete env.CLOUD_RUN_JOB;
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", FAKE_BQ, JOB, ...args],
    { cwd: ROOT, encoding: "utf8", env, timeout: 90_000 },
  );
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    log: existsSync(log) ? readFileSync(log, "utf8") : null,
    bq: existsSync(bqLog)
      ? readFileSync(bqLog, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Run["bq"][number])
      : [],
  };
}

describe("lake-gold exits by what the CLI's transcript says — MONEY-1611", () => {
  it("[control] a green transcript and exit 0 is exit 0", () => {
    const r = run(["--env", "prod"], { out: GREEN });
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /"built":1,"assertionsPassed":1,"assertionsFailed":0/,
    );
  });

  it("a FAILED ASSERTION exits non-zero and names it", () => {
    const r = run(["--env", "prod"], {
      out: GREEN,
      err: FAILED_ASSERTION,
      exit: 1,
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(
      r.stderr,
      /1 assertion\(s\) FAILED: lake_gold_prod\.assert_india_split_is_adjusted/,
    );
  });

  it("a failed assertion exits non-zero EVEN IF the CLI exits 0", () => {
    const r = run(["--env", "prod"], {
      out: GREEN,
      err: FAILED_ASSERTION,
      exit: 0,
    });
    assert.equal(r.status, 1, r.stderr);
  });

  it("a run that executed NOTHING exits non-zero", () => {
    const r = run(["--env", "prod", "--actions", "event_retrun_outcome"], {
      out: "Compiling...\n\nCompiled successfully.\n\nRunning...\n",
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /no action ran/);
  });

  it("an assertion failure on stderr is not lost inside a SPLIT stdout line", () => {
    // One buffer for both streams would read "...adjusted_Assertion failed:"
    // and the failure line would no longer start a line. The CLI exits 0 here
    // so the transcript alone has to carry the verdict.
    const r = run(["--env", "prod"], {
      out: "Running...\n\nTable created:  lake_gold_prod.adjusted_",
      err: FAILED_ASSERTION,
      out2: "bar_d1 [view]\n",
      exit: 0,
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /1 assertion\(s\) FAILED/);
    assert.match(r.stdout, /"built":1/);
  });

  it("a PARTLY misspelled --actions list exits non-zero and names the dropped one", () => {
    const r = run(
      [
        "--env",
        "prod",
        "--actions",
        "adjusted_bar_d1",
        "--actions",
        "event_retrun_outcome",
      ],
      { out: GREEN },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /`event_retrun_outcome` did not run/);
  });

  it("an env that disagrees with the job's suffix is refused BEFORE the CLI starts", () => {
    const r = run(
      ["--env", "qa"],
      { out: GREEN },
      { CLOUD_RUN_JOB: "lake-gold-prod" },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Execute lake-gold-qa instead/);
    assert.equal(r.log, null, "the CLI was started for a refused run");
  });

  it("a missing CLI exits non-zero, not 0", () => {
    const r = run(
      ["--env", "prod"],
      {},
      { PATH: mkdtempSync(join(tmpdir(), "empty-path-")) },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /could not start the Dataform CLI/);
  });

  it("the CLI receives this repo's dataform/, prod everywhere, offline npm, a keyless credentials file", () => {
    const r = run(["--env", "prod"], { out: GREEN });
    assert.equal(r.status, 0, r.stderr);
    const argv = (r.log ?? "").trim().split("\n");
    assert.deepEqual(argv.slice(0, 2), ["run", join(ROOT, "dataform")]);
    for (const want of [
      "--vars=env=prod",
      "--default-schema=lake_gold_prod",
      "--assertion-schema=lake_gold_prod",
      "--tags=gold",
      "offline=true",
    ]) {
      assert.ok(
        argv.includes(want),
        `CLI argv lacks ${want}: ${argv.join(" ")}`,
      );
    }
    const creds = argv.find((a) => a.startsWith("--credentials="))!.slice(14);
    assert.deepEqual(JSON.parse(readFileSync(creds, "utf8")), {
      projectId: "stock-book-483718",
      location: "asia-south1",
    });
  });
});

const LOADING_ROWS = JSON.stringify([
  {
    table: "price_bar_d1",
    partitions: "US/2019-03, US/2019-04",
    clears_at: "2026-09-24T01:04:03Z",
  },
]);

describe("lake-gold will not build over a silver table that is mid-reload — MONEY-1611", () => {
  it("asks the ledger with the LEDGER's own lease, for gold's own inputs, in this env", () => {
    const r = run(["--env", "prod"], { out: GREEN });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.bq.length, 1, "exactly one ledger read before the build");
    const { query, params } = r.bq[0]!.query;
    assert.equal(params.lease, CLAIM_LEASE_MS);
    assert.equal(params.quiet, GOLD_QUIET_MS);
    assert.equal(params.dataset, "lake_silver_prod");
    assert.deepEqual(params.tables, [...GOLD_SILVER_INPUTS]);
    assert.match(
      query,
      /`stock-book-483718\.lake_bronze_prod\.partition_load`/,
    );
    assert.match(
      query.split(/\bWHERE\b/)[1] ?? "",
      /state = 'LOADING' AND TIMESTAMP_DIFF\(CURRENT_TIMESTAMP\(\), loaded_at, MILLISECOND\) <= @lease/,
    );
  });

  it("a live LOADING claim SKIPS the build, names it, and exits 0", () => {
    const r = run(
      ["--env", "prod"],
      { out: GREEN },
      { FAKE_BQ_ROWS: LOADING_ROWS },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stderr,
      /SKIPPED_LOADING price_bar_d1: US\/2019-03, US\/2019-04/,
    );
    assert.match(r.stdout, /skipped_loading .*clear at 2026-09-24T01:04:03Z/);
    assert.doesNotMatch(r.stdout + r.stderr, /skipped_loading_targeted/);
    assert.equal(r.log, null, "the CLI ran over a table that is mid-reload");
  });

  it("the documented post-replay FULL REFRESH, skipped, exits 1 and says when to retry", () => {
    const r = run(
      [
        "--env",
        "prod",
        "--full-refresh",
        "--actions",
        "event_return_outcome",
        "--include-dependents",
      ],
      { out: GREEN },
      { FAKE_BQ_ROWS: LOADING_ROWS },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(
      r.stderr,
      /Retry after 2026-09-24T01:04:03Z with the same --args/,
    );
    assert.match(
      r.stderr,
      /reported itself UNHEALTHY — skipped_loading_targeted: price_bar_d1; retry after 2026-09-24T01:04:03Z/,
    );
    assert.equal(r.log, null, "the CLI ran over a table that is mid-reload");
  });

  it("a bare --full-refresh is targeted too", () => {
    const r = run(
      ["--env", "prod", "--full-refresh"],
      { out: GREEN },
      { FAKE_BQ_ROWS: LOADING_ROWS },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Retry after 2026-09-24T01:04:03Z/);
  });

  it("an UNREADABLE ledger exits 1, named, and does not build", () => {
    const r = run(
      ["--env", "prod"],
      { out: GREEN },
      { FAKE_BQ_THROW: "Access Denied: Table partition_load" },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /could not read lake_bronze_prod\.partition_load/);
    assert.equal(
      r.log,
      null,
      "the CLI ran without the ledger having been read",
    );
  });
});
