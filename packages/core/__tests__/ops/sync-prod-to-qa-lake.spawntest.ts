/**
 * `sync-prod-to-qa.sh --tier=lake` — BigQuery silver, prod -> QA (MONEY-1610).
 *
 * Runs the REAL script against a stub `bq` on PATH, the way
 * `market-data/sync-prod-to-qa-exit-code.spawntest.ts` drives the Mongo tier.
 * The stub answers the two inventory queries from canned lines, records every
 * `cp` it is asked for, and answers `show -j` / `show <table>` with the counts
 * a copy would produce. Nothing here reaches BigQuery: `CLOUDSDK_CONFIG` points
 * at an empty directory, so even a stub that failed to shadow the real `bq`
 * would have no credentials.
 *
 * What is pinned, each by behaviour:
 *   - the table list is DERIVED: BASE TABLEs in both datasets, nothing else
 *   - no `--apply` means no `cp`, ever
 *   - a destination that is *_prod, bronze, private, or not lake_silver_qa is
 *     REFUSED — proven by editing the script's own constant and running it
 *   - partition / cluster drift, QA-ahead columns and same-name type/mode
 *     conflicts are refused per table
 *   - a table with a LIVE LOADING claim in prod's ledger is skipped (exit 0),
 *     at plan time AND at the per-table re-read; an unreadable ledger is fatal;
 *     the lease is the ledger's own CLAIM_LEASE_MS; a STALE claim is copied
 *     with a WARN STALE_LOADING
 *   - "nothing to copy" says whether the tables were refused or absent
 *   - a QA count that disagrees with the job's copiedRows fails the run, and so
 *     does a copy loop that ends before every planned table is accounted for
 *
 * `.spawntest.ts` because every case launches bash (MONEY-1316).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAIM_LEASE_MS } from "../../../lake/src/ledger-logic";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SCRIPT = join(ROOT, "scripts", "ops", "sync-prod-to-qa.sh");
const SETUP = join(ROOT, "scripts", "ops", "setup-sync-job.sh");
const P = "stock-book-483718";

const DIR = mkdtempSync(join(tmpdir(), "sync-lake-"));
const STUBS = join(DIR, "bin");
const NO_CREDS = join(DIR, "gcloud-config");
mkdirSync(STUBS);
mkdirSync(NO_CREDS);
after(() => rmSync(DIR, { recursive: true, force: true }));

// argv: global flags, then the command word, then its args. The inventory is
// told apart by the dataset named in the SQL; a copy's rows come from the
// canned PROD inventory, keyed by the table in the source ref.
writeFileSync(
  join(STUBS, "bq"),
  `#!/bin/bash
echo "BQ $*" >> "$STUB_LOG"
cmd=""; job=""; jflag=0
for a in "$@"; do
  case "$a" in
    --job_id=*) job="\${a#--job_id=}" ;;
    -j) jflag=1 ;;
    -*) ;;
    *) [ -z "$cmd" ] && cmd="$a" ;;
  esac
done
last="\${@: -1}"
rows_of() { awk -F'|' -v t="$1" '$1 == t { print $3 }' "$STUB_INV_PROD"; }
case "$cmd" in
  query)
    case "$last" in
      *partition_load*)
        [ -n "$STUB_LEDGER_FAIL" ] && exit 1
        echo "$last" > "$STUB_LOG.ledger-sql"
        n=$(( $(cat "$STUB_LOG.ledger-n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_LOG.ledger-n"
        [ -n "$STUB_LEDGER_FAIL_AFTER" ] && [ "$n" -gt "$STUB_LEDGER_FAIL_AFTER" ] && exit 1
        echo line
        [ "$n" -gt "\${STUB_LOADING_AFTER:-0}" ] && [ -n "$STUB_LOADING" ] && printf '%s\n' "$STUB_LOADING"
        exit 0 ;;
      *lake_silver_prod.INFORMATION_SCHEMA*) echo "$last" > "$STUB_LOG.inv-sql"; [ "$STUB_QUERY_FAIL" = prod ] && exit 1; echo line; cat "$STUB_INV_PROD" ;;
      *lake_silver_qa.INFORMATION_SCHEMA*)   [ "$STUB_QUERY_FAIL" = qa ] && exit 1; echo line; cat "$STUB_INV_QA" ;;
      *) exit 1 ;;
    esac ;;
  cp)
    src="\${@: -2:1}"; t="\${src##*.}"
    echo "CP $src $last" >> "$STUB_LOG"
    [ -n "$STUB_EAT_STDIN" ] && cat > /dev/null
    [ "$t" = "$STUB_CP_FAIL" ] && exit 1
    echo "$t" > "$STUB_DIR/job-$job"
    ;;
  show)
    if [ "$jflag" = 1 ]; then
      t="$(cat "$STUB_DIR/job-$last")"
      if [ -n "$STUB_NO_COPIED_ROWS" ]; then echo '{"statistics":{"copy":{}}}'
      else echo "{\\"statistics\\":{\\"copy\\":{\\"copiedRows\\":\\"$(rows_of "$t")\\"}}}"; fi
    else
      t="\${last##*.}"; n="$(rows_of "$t")"
      [ "$t" = "$STUB_OFF_BY_ONE" ] && n=$((n + 1))
      echo "{\\"numRows\\":\\"$n\\",\\"schema\\":{}}"
    fi ;;
  *) exit 1 ;;
esac
`,
);
chmodSync(join(STUBS, "bq"), 0o755);

/**
 * name|type|rows|partition|clustering|columns — what lake_inventory emits, with
 * columns as `name:TYPE:IS_NULLABLE;…` (commas in a type arrive as `~`).
 */
const row = (
  name: string,
  rows: number,
  o: { type?: string; part?: string; clus?: string; cols?: string } = {},
): string =>
  [
    name,
    o.type ?? "BASE_TABLE",
    rows,
    o.part ?? "DATE_TRUNC(session_date; MONTH)",
    o.clus ?? "market; listing_id",
    o.cols ?? "listing_id:STRING:NO;market:STRING:NO;session_date:DATE:NO",
  ].join("|");

const PROD = [
  row("price_bar_d1", 14_291_560),
  row("listing", 131_459, { part: "-" }),
  row("trade_bar_m1", 0),
  row("filing_registry_stage_run_1", 0, { part: "-", clus: "-" }),
  row("instrument_current", 0, { type: "VIEW", part: "-", clus: "-" }),
];
const QA = [
  row("price_bar_d1", 0),
  row("listing", 0, { part: "-" }),
  row("trade_bar_m1", 0),
  row("qa_only_table", 5),
];

type Run = {
  status: number;
  out: string;
  log: string;
  cps: string[];
  ledgerSql: string;
  invSql: string;
};

function run(
  args: string[],
  o: {
    prod?: string[];
    qa?: string[];
    env?: Record<string, string>;
    script?: string;
  } = {},
): Run {
  const id = Math.random().toString(36).slice(2);
  const log = join(DIR, `log-${id}`);
  const invP = join(DIR, `prod-${id}`);
  const invQ = join(DIR, `qa-${id}`);
  writeFileSync(log, "");
  writeFileSync(invP, (o.prod ?? PROD).join("\n") + "\n");
  writeFileSync(invQ, (o.qa ?? QA).join("\n") + "\n");
  const r = spawnSync("bash", [o.script ?? SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${STUBS}:${process.env.PATH ?? ""}`,
      CLOUDSDK_CONFIG: NO_CREDS,
      STUB_LOG: log,
      STUB_DIR: DIR,
      STUB_INV_PROD: invP,
      STUB_INV_QA: invQ,
      ...o.env,
    },
  });
  assert.equal(r.signal, null, `killed by ${r.signal}`);
  const text = readFileSync(log, "utf8");
  return {
    status: r.status ?? -1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    log: text,
    cps: text.split("\n").filter((l) => l.startsWith("CP ")),
    ledgerSql: existsSync(`${log}.ledger-sql`)
      ? readFileSync(`${log}.ledger-sql`, "utf8")
      : "",
    invSql: existsSync(`${log}.inv-sql`)
      ? readFileSync(`${log}.inv-sql`, "utf8")
      : "",
  };
}

const copiedTables = (r: Run): string[] =>
  r.cps.map((l) => l.split(" ")[2]!.split(".").pop()!).sort();

describe("--tier=lake: the table list is DERIVED (MONEY-1610)", () => {
  it("copies exactly the BASE TABLEs present in both datasets, prod -> qa", () => {
    const r = run(["--tier=lake", "--apply"]);
    assert.equal(r.status, 0, r.out.slice(-2000));
    // Not the prod-only stage table, not the view, not the QA-only table.
    assert.deepEqual(copiedTables(r), [
      "listing",
      "price_bar_d1",
      "trade_bar_m1",
    ]);
    for (const l of r.cps) {
      const [, src, dst] = l.split(" ");
      assert.match(src!, new RegExp(`^${P}:lake_silver_prod\\.[a-z0-9_]+$`), l);
      assert.match(dst!, new RegExp(`^${P}:lake_silver_qa\\.[a-z0-9_]+$`), l);
    }
    assert.match(r.out, /filing_registry_stage_run_1\s+prod-only/);
    assert.match(r.out, /instrument_current\s+VIEW in prod/);
    assert.match(r.out, /qa_only_table\s+QA-only \(left alone\)/);
    assert.match(r.out, /Lake sync complete: 3 copied, 0 skipped \(loading\)/);
    assert.match(
      r.out,
      /QA gold: the lake-gold-qa job \(Dataform CLI\) rebuilds from this silver at 06:45\/20:15 IST/,
    );
    assert.doesNotMatch(r.out, /release config/);
  });

  it("every copy is WRITE_TRUNCATE (`cp -f`) in the dataset's region", () => {
    const r = run(["--tier=lake", "--apply"]);
    const cpCalls = r.log
      .split("\n")
      .filter((l) => / cp /.test(l) && l.startsWith("BQ "));
    assert.equal(cpCalls.length, 3);
    for (const l of cpCalls) {
      assert.match(l, / cp -f /, l);
      assert.match(l, /--location=asia-south1/, l);
      assert.match(l, /--job_id=lake_sync_/, l);
    }
  });

  it("without --apply it is a PLAN: both inventories read, zero copies", () => {
    const r = run(["--tier=lake"]);
    assert.equal(r.status, 0, r.out.slice(-2000));
    assert.deepEqual(r.cps, []);
    assert.doesNotMatch(r.log, / cp /);
    assert.match(r.out, /PLAN complete — re-run with --apply/);
    assert.match(r.out, /Plan \(3 table\(s\) to copy, 0 mid-load in prod\)/);
    assert.equal(
      (r.log.match(/^BQ .* query /gm) ?? []).length,
      3,
      "both inventories + the ledger — and no per-table re-read on a plan",
    );
  });

  it("an empty intersection is a failure, not a quiet night", () => {
    const r = run(["--tier=lake", "--apply"], { qa: [row("unrelated", 0)] });
    assert.equal(r.status, 1, r.out.slice(-2000));
    assert.deepEqual(r.cps, []);
    assert.match(
      r.out,
      /Nothing to copy: no BASE TABLE exists in both datasets/,
    );
    assert.doesNotMatch(r.out, /REFUSED/);
  });

  it("an EMPTY QA inventory reads every prod table as prod-only, never as QA", () => {
    // The NR == FNR trap: with an empty first file, awk would file prod's
    // tables under QA.
    const r = run(["--tier=lake", "--apply"], { qa: [] });
    assert.equal(r.status, 1, r.out.slice(-2000));
    assert.deepEqual(r.cps, []);
    assert.match(r.out, /price_bar_d1\s+prod-only/);
  });

  for (const which of ["prod", "qa"]) {
    it(`a failed ${which} inventory read refuses before any copy`, () => {
      const r = run(["--tier=lake", "--apply"], {
        env: { STUB_QUERY_FAIL: which },
      });
      assert.equal(r.status, 1, r.out.slice(-2000));
      assert.deepEqual(r.cps, []);
      assert.match(r.out, /Could not read .*inventory — refusing/);
    });
  }
});

describe("--tier=lake: schema drift", () => {
  it("the inventory reads name, TYPE and MODE per column — never descriptions", () => {
    const sql = run(["--tier=lake"]).invSql;
    assert.match(
      sql,
      /FORMAT\('%s:%s:%s', column_name, REPLACE\(data_type, ',', '~'\), is_nullable\)/,
    );
    assert.match(sql, /ORDER BY ordinal_position/);
    assert.doesNotMatch(sql, /description/i);
  });

  it("prod-only column: copied, and the plan names it", () => {
    const r = run(["--tier=lake", "--apply"], {
      prod: [
        row("corporate_action", 57_316, {
          cols: "a:STRING:NO;b:INT64:YES;observed_ratio:NUMERIC(18~ 6):YES",
        }),
      ],
      qa: [row("corporate_action", 0, { cols: "a:STRING:NO;b:INT64:YES" })],
    });
    assert.equal(r.status, 0, r.out.slice(-2000));
    assert.deepEqual(copiedTables(r), ["corporate_action"]);
    assert.match(
      r.out,
      /prod adds observed_ratio \(prod's schema replaces QA's\)/,
    );
  });

  it("description-only / column-order differences copy as identical", () => {
    // Descriptions are not in the inventory at all; order is a set compare.
    const r = run(["--tier=lake", "--apply"], {
      prod: [row("listing", 1, { cols: "a:STRING:NO;b:INT64:YES" })],
      qa: [row("listing", 0, { cols: "b:INT64:YES;a:STRING:NO" })],
    });
    assert.equal(r.status, 0, r.out.slice(-2000));
    assert.deepEqual(copiedTables(r), ["listing"]);
    assert.match(r.out, /listing\s+prod=1\s+qa=0\s+schema identical/);
  });

  const conflict = (prodCol: string, qaCol: string): Run =>
    run(["--tier=lake", "--apply"], {
      prod: [
        row("listing", 1, { cols: `a:STRING:NO;${prodCol}` }),
        row("price_bar_d1", 2),
      ],
      qa: [
        row("listing", 0, { cols: `a:STRING:NO;${qaCol}` }),
        row("price_bar_d1", 0),
      ],
    });

  for (const [label, prodCol, qaCol, why] of [
    [
      "QA relaxed a mode",
      "v:INT64:NO",
      "v:INT64:YES",
      /v QA relaxed REQUIRED->NULLABLE \(QA ahead\)/,
    ],
    [
      "prod relaxed a mode",
      "v:INT64:YES",
      "v:INT64:NO",
      /v prod relaxed REQUIRED->NULLABLE \(prod ahead\)/,
    ],
    [
      "QA widened a type",
      "v:INT64:YES",
      "v:NUMERIC:YES",
      /v QA widened INT64->NUMERIC \(QA ahead\)/,
    ],
    [
      "QA widened NUMERIC->FLOAT64",
      "v:NUMERIC:YES",
      "v:FLOAT64:YES",
      /v QA widened NUMERIC->FLOAT64 \(QA ahead\)/,
    ],
    [
      "prod widened a type",
      "v:BIGNUMERIC:YES",
      "v:NUMERIC:YES",
      /v prod widened NUMERIC->BIGNUMERIC \(prod ahead\)/,
    ],
    [
      "a type change with no known direction",
      "v:STRING:YES",
      "v:NUMERIC(18~ 6):YES",
      /v type prod=STRING qa=NUMERIC\(18, 6\)/,
    ],
  ] as const) {
    it(`SCHEMA_CONFLICT: ${label} is refused per table, direction named`, () => {
      const r = conflict(prodCol, qaCol);
      assert.equal(r.status, 1, r.out.slice(-2000));
      assert.deepEqual(
        copiedTables(r),
        ["price_bar_d1"],
        "the healthy table still copies",
      );
      assert.match(r.out, /listing\s+SCHEMA_CONFLICT: /);
      assert.match(r.out, why);
      assert.match(r.out, /listing \(SCHEMA_CONFLICT\)/);
    });
  }

  it("QA_AHEAD (QA has a column prod lacks) is refused and fails the run", () => {
    const r = run(["--tier=lake", "--apply"], {
      prod: [
        row("listing", 1, { cols: "a:STRING:NO;b:STRING:NO" }),
        row("price_bar_d1", 2),
      ],
      qa: [
        row("listing", 0, {
          cols: "a:STRING:NO;b:STRING:NO;new_in_qa:INT64:YES",
        }),
        row("price_bar_d1", 0),
      ],
    });
    assert.equal(r.status, 1, r.out.slice(-2000));
    assert.deepEqual(
      copiedTables(r),
      ["price_bar_d1"],
      "the healthy table still copies",
    );
    assert.match(
      r.out,
      /listing\s+QA_AHEAD: QA has column\(s\) prod lacks \(new_in_qa\)/,
    );
  });

  it("every shared table REFUSED: fails, and says so rather than 'no table exists'", () => {
    const r = run(["--tier=lake", "--apply"], {
      prod: [
        row("a_tbl", 1, { part: "DATE(x)" }),
        row("b_tbl", 1, { clus: "m" }),
      ],
      qa: [row("a_tbl", 0, { part: "-" }), row("b_tbl", 0, { clus: "n" })],
    });
    assert.equal(r.status, 1, r.out.slice(-2000));
    assert.deepEqual(r.cps, []);
    assert.match(
      r.out,
      /Nothing to copy: 2 table\(s\) REFUSED \(see the REFUSE lines above\) and none left to copy/,
    );
    assert.doesNotMatch(r.out, /no BASE TABLE exists in both datasets/);
  });

  it("partition drift and cluster drift are refused per table", () => {
    const r = run(["--tier=lake", "--apply"], {
      prod: [
        row("a_tbl", 1, { part: "DATE(x)" }),
        row("b_tbl", 1, { clus: "m" }),
        row("c_tbl", 1),
      ],
      qa: [
        row("a_tbl", 0, { part: "-" }),
        row("b_tbl", 0, { clus: "n" }),
        row("c_tbl", 0),
      ],
    });
    assert.equal(r.status, 1, r.out.slice(-2000));
    assert.deepEqual(copiedTables(r), ["c_tbl"]);
    assert.match(r.out, /a_tbl\s+PARTITION DRIFT/);
    assert.match(r.out, /b_tbl\s+CLUSTER DRIFT/);
  });
});

describe("--tier=lake: counts", () => {
  it("a QA count that disagrees with the job's copiedRows fails the run", () => {
    const r = run(["--tier=lake", "--apply"], {
      env: { STUB_OFF_BY_ONE: "listing" },
    });
    assert.equal(r.status, 1, r.out.slice(-2000));
    assert.match(
      r.out,
      /listing: COUNT MISMATCH — copied=131459 qa_after=131460/,
    );
    assert.match(
      r.out,
      /Lake sync FAILED: 2 copied, 0 skipped \(loading\), 1 failed/,
    );
  });

  it("a failed copy job fails the run and the rest still copy", () => {
    const r = run(["--tier=lake", "--apply"], {
      env: { STUB_CP_FAIL: "price_bar_d1" },
    });
    assert.equal(r.status, 1, r.out.slice(-2000));
    assert.match(r.out, /price_bar_d1: copy FAILED/);
    assert.match(r.out, /2 copied, 0 skipped \(loading\), 1 failed/);
  });

  it("no copiedRows on the job falls back to prod's pre-copy count, and says so", () => {
    const r = run(["--tier=lake", "--apply"], {
      env: { STUB_NO_COPIED_ROWS: "1" },
    });
    assert.equal(r.status, 0, r.out.slice(-2000));
    assert.match(
      r.out,
      /reported no copiedRows — compared with prod's pre-copy count/,
    );
  });
});

describe("--tier=lake: a table mid-load in prod is skipped", () => {
  // The ledger query's own line shape: LIVE|STALE, table, partitions.
  const M1 = "LIVE|trade_bar_m1|US/M1/2024-11;US/M1/2024-12";

  it("a live LOADING claim skips that table with a named WARN, and exits 0", () => {
    const r = run(["--tier=lake", "--apply"], { env: { STUB_LOADING: M1 } });
    assert.equal(r.status, 0, r.out.slice(-2000));
    assert.deepEqual(copiedTables(r), ["listing", "price_bar_d1"]);
    assert.match(
      r.out,
      /WARN SKIPPED_LOADING trade_bar_m1: US\/M1\/2024-11, US\/M1\/2024-12/,
    );
    assert.match(r.out, /Lake sync complete: 2 copied, 1 skipped \(loading\)/);
  });

  it("the plan shows it too, and copies nothing", () => {
    const r = run(["--tier=lake"], { env: { STUB_LOADING: M1 } });
    assert.equal(r.status, 0, r.out.slice(-2000));
    assert.deepEqual(r.cps, []);
    assert.match(r.out, /Plan \(2 table\(s\) to copy, 1 mid-load in prod\)/);
    assert.match(r.out, /SKIPPED_LOADING trade_bar_m1: US\/M1\/2024-11/);
  });

  it("the per-table RE-READ catches a load that claimed after the plan", () => {
    // Read #1 is the plan's and sees nothing; every later read sees the claim.
    const r = run(["--tier=lake", "--apply"], {
      env: { STUB_LOADING: M1, STUB_LOADING_AFTER: "1" },
    });
    assert.equal(r.status, 0, r.out.slice(-2000));
    assert.match(r.out, /Plan \(3 table\(s\) to copy, 0 mid-load in prod\)/);
    assert.deepEqual(copiedTables(r), ["listing", "price_bar_d1"]);
    assert.match(r.out, /WARN SKIPPED_LOADING trade_bar_m1: /);
    assert.match(r.out, /2 copied, 1 skipped \(loading\)/);
  });

  it("every intersecting table mid-load: nothing copied, still exit 0", () => {
    const r = run(["--tier=lake", "--apply"], {
      env: {
        STUB_LOADING:
          "LIVE|listing|IN/2024-01\nLIVE|price_bar_d1|IN/2024-07\n" + M1,
      },
    });
    assert.equal(r.status, 0, r.out.slice(-2000));
    assert.deepEqual(r.cps, []);
    assert.match(r.out, /0 copied, 3 skipped \(loading\)/);
  });

  it("a ledger RE-READ that fails refuses that table's copy and fails the run", () => {
    const r = run(["--tier=lake", "--apply"], {
      env: { STUB_LEDGER_FAIL_AFTER: "1" },
    });
    assert.equal(r.status, 1, r.out.slice(-2000));
    assert.deepEqual(r.cps, []);
    assert.match(r.out, /listing: ledger unreadable — not copied/);
    assert.match(r.out, /0 copied, 0 skipped \(loading\), 3 failed/);
  });

  it("an unreadable ledger is fatal before any copy", () => {
    const r = run(["--tier=lake", "--apply"], {
      env: { STUB_LEDGER_FAIL: "1" },
    });
    assert.equal(r.status, 1, r.out.slice(-2000));
    assert.deepEqual(r.cps, []);
    assert.match(
      r.out,
      /Could not read lake_bronze_prod\.partition_load — refusing/,
    );
  });

  it("asks prod's ledger for LIVE LOADING claims on prod silver, at the ledger's own lease", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const lease = /^LAKE_CLAIM_LEASE_MS=(\d+)$/m.exec(src)?.[1];
    assert.equal(
      Number(lease),
      CLAIM_LEASE_MS,
      "LAKE_CLAIM_LEASE_MS != ledger-logic CLAIM_LEASE_MS",
    );
    // The SQL the stub was handed, not the script's text.
    const logs = run(["--tier=lake"]).ledgerSql;
    assert.match(logs, /`stock-book-483718\.lake_bronze_prod\.partition_load`/);
    assert.match(
      logs,
      /p\.dataset = 'lake_silver_prod' AND p\.state = 'LOADING'/,
    );
    assert.match(
      logs,
      new RegExp(
        `IF\\(TIMESTAMP_DIFF\\(CURRENT_TIMESTAMP\\(\\), p\\.loaded_at, MILLISECOND\\) <= ${CLAIM_LEASE_MS}, 'LIVE', 'STALE'\\)`,
      ),
    );
    assert.match(logs, /WHERE lease_state = 'LIVE' OR NOT reloaded/);
  });

  it("a stale claim is cleared by a LATER ACCEPTED row, or a later REJECTED row that landed rows", () => {
    // The ledger's own table, same (dataset, table, partition_key), strictly later.
    const logs = run(["--tier=lake"]).ledgerSql;
    const reloaded =
      /EXISTS \(SELECT 1 FROM [^)]*?partition_load` a\s+WHERE ([\s\S]*?)\) AS reloaded/.exec(
        logs,
      );
    assert.ok(reloaded, "the `reloaded` subquery is gone");
    const where = reloaded[1]!.replace(/\s+/g, " ");
    assert.match(where, /a\.dataset = p\.dataset AND a\.`table` = p\.`table`/);
    assert.match(
      where,
      /a\.partition_key = p\.partition_key AND a\.loaded_at > p\.loaded_at/,
    );
    // lake-replay-in's coverage refusal: REJECTED only after replaceMonth
    // landed the month, so it must clear an old-hash LOADING (MONEY-1612).
    // lake-load-databento's failed load: REJECTED with row_count 0 AFTER its
    // purge — possibly an empty month — so it must NOT clear the warning.
    assert.match(
      where,
      /AND \(a\.state = 'ACCEPTED' OR \(a\.state = 'REJECTED' AND a\.row_count > 0\)\)$/,
    );
  });

  const STALE = "STALE|trade_bar_m1|US/M1/2023-05;US/M1/2023-06";
  const STALE_WARN =
    /WARN STALE_LOADING trade_bar_m1: US\/M1\/2023-05, US\/M1\/2023-06 \(claim older than the lease — possibly a crashed loader holding a deleted month\)/;

  it("a STALE claim is copied (decideClaim parity) but WARNs, and exits 0", () => {
    const r = run(["--tier=lake", "--apply"], { env: { STUB_LOADING: STALE } });
    assert.equal(r.status, 0, r.out.slice(-2000));
    assert.deepEqual(copiedTables(r), [
      "listing",
      "price_bar_d1",
      "trade_bar_m1",
    ]);
    assert.match(r.out, STALE_WARN);
    assert.doesNotMatch(r.out, /SKIPPED_LOADING/);
    assert.match(r.out, /3 copied, 0 skipped \(loading\)/);
  });

  it("the plan shows the STALE warning too", () => {
    const r = run(["--tier=lake"], { env: { STUB_LOADING: STALE } });
    assert.equal(r.status, 0, r.out.slice(-2000));
    assert.match(r.out, /Plan \(3 table\(s\) to copy, 0 mid-load in prod\)/);
    assert.match(r.out, STALE_WARN);
  });

  it("LIVE and STALE on one table: skipped for the live claim, warned for the stale one", () => {
    const r = run(["--tier=lake", "--apply"], {
      env: { STUB_LOADING: `${M1}\n${STALE}` },
    });
    assert.equal(r.status, 0, r.out.slice(-2000));
    assert.deepEqual(copiedTables(r), ["listing", "price_bar_d1"]);
    assert.match(
      r.out,
      /SKIPPED_LOADING trade_bar_m1: US\/M1\/2024-11, US\/M1\/2024-12/,
    );
    assert.match(r.out, STALE_WARN);
  });
});

describe("--tier=lake: every planned table is accounted for", () => {
  it("a loop that ends early fails the run instead of reporting success", () => {
    // Simulated in a copy of the real script: the copy loop is fed only the
    // plan's first line (a SKIP), so it reaches none of the 3 COPY tables.
    const src = readFileSync(SCRIPT, "utf8");
    const LOOP_INPUT = '    done 3< "$work/plan"\n';
    assert.equal(
      src.split(LOOP_INPUT).length,
      2,
      "the copy loop's input line moved",
    );
    const edited = join(DIR, "sync-early-end.sh");
    writeFileSync(
      edited,
      src.replace(LOOP_INPUT, '    done 3< <(head -n 1 "$work/plan")\n'),
    );
    const r = run(["--tier=lake", "--apply"], { script: edited });
    assert.equal(r.status, 1, r.out.slice(-2000));
    assert.deepEqual(r.cps, []);
    assert.match(
      r.out,
      /accounted for 0 of 3 planned table\(s\) — it ended early/,
    );
    assert.match(r.out, /loop \(3 unreached\)/);
  });

  it("a command that drains stdin inside the loop cannot end it early", () => {
    // The plan is read on fd 3; a `bq` that swallows stdin used to be able to
    // eat the rest of a `while read … done < file` loop.
    const r = run(["--tier=lake", "--apply"], { env: { STUB_EAT_STDIN: "1" } });
    assert.equal(r.status, 0, r.out.slice(-2000));
    assert.deepEqual(copiedTables(r), [
      "listing",
      "price_bar_d1",
      "trade_bar_m1",
    ]);
  });
});

describe("--tier=lake: the destination guard, by behaviour", () => {
  // The script's own constant, edited in a copy of the script and RUN — so a
  // guard that exists but is not consulted before the write fails here.
  const src = readFileSync(SCRIPT, "utf8");
  const CONST = /^LAKE_DST_DATASET="lake_silver_qa"$/m;
  assert.match(src, CONST, "LAKE_DST_DATASET is no longer lake_silver_qa");

  const cases: Array<[string, RegExp]> = [
    ["lake_silver_prod", /a \*_prod dataset/],
    ["lake_gold_prod", /a \*_prod dataset/],
    ["lake_bronze_prod", /a \*_prod dataset/],
    ["lake_private_prod", /a \*_prod dataset/],
    ["lake_bronze_qa", /a bronze LEDGER/],
    ["lake_private_qa", /lake_private_\* is never mirrored/],
    ["lake_gold_qa", /the only dataset this tier writes is/],
  ];
  for (const [ds, reason] of cases) {
    for (const apply of [true, false]) {
      it(`refuses to target ${ds}${apply ? " (--apply)" : " (plan)"}`, () => {
        const edited = join(DIR, `sync-${ds}-${apply}.sh`);
        writeFileSync(edited, src.replace(CONST, `LAKE_DST_DATASET="${ds}"`));
        // The QA inventory must answer under the edited name too, so the
        // guard — not a failed read — is what stops the run.
        const r = run(apply ? ["--tier=lake", "--apply"] : ["--tier=lake"], {
          script: edited,
          qa: QA,
        });
        assert.equal(r.status, 1, r.out.slice(-2000));
        assert.match(r.out, new RegExp(`REFUSING to write ${ds}: `));
        assert.match(r.out, reason);
        assert.deepEqual(
          r.cps,
          [],
          "a refused destination must never see a copy",
        );
        assert.doesNotMatch(r.log, / query /, "the guard runs before any read");
      });
    }
  }
});

describe("--tier=lake: argument handling", () => {
  it("--apply on another tier is refused", () => {
    const r = run(["--tier=feeds", "--apply", "--dry-run"]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /--apply is only for --tier=lake/);
  });
  it("--apply with --dry-run is refused", () => {
    const r = run(["--tier=lake", "--apply", "--dry-run"]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /contradict/);
    assert.equal(r.log, "");
  });
  for (const flag of ["--gcs-only", "--collections-only", "--status"]) {
    it(`${flag} with --tier=lake is refused`, () => {
      const r = run(["--tier=lake", flag]);
      assert.equal(r.status, 1, r.out);
      assert.equal(r.log, "");
    });
  }
});

describe("setup-sync-job.sh agrees with the lake tier", () => {
  const setup = readFileSync(SETUP, "utf8");
  const script = readFileSync(SCRIPT, "utf8");
  const val = (src: string, name: string): string | undefined =>
    new RegExp(`^${name}="([^"]+)"`, "m").exec(src)?.[1];

  it("names the same source and destination datasets as the script", () => {
    for (const k of [
      "LAKE_SRC_DATASET",
      "LAKE_DST_DATASET",
      "LAKE_LEDGER_DATASET",
    ]) {
      assert.ok(val(setup, k), `${k} missing from setup-sync-job.sh`);
      assert.equal(val(setup, k), val(script, k), `${k} disagrees`);
    }
  });

  it("grants READER on prod silver + prod bronze, WRITER on QA silver, dataset-scoped", () => {
    assert.equal(val(setup, "LAKE_LEDGER_DATASET"), "lake_bronze_prod");
    assert.match(setup, /^grant_dataset "\$LAKE_SRC_DATASET" "READER"$/m);
    assert.match(setup, /^grant_dataset "\$LAKE_DST_DATASET" "WRITER"$/m);
    assert.match(setup, /^grant_dataset "\$LAKE_LEDGER_DATASET" "READER"$/m);
    assert.equal(
      (setup.match(/^grant_dataset "/gm) ?? []).length,
      3,
      "the sync SA gets exactly three dataset grants",
    );
    // Project-level: jobUser only, never a data role.
    assert.match(
      setup,
      /--role="roles\/bigquery\.jobUser" \\\n\s+--condition=None/,
    );
    // Comments stripped: the header explains the roles by name.
    const code = setup
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    assert.doesNotMatch(code, /roles\/bigquery\.data(Editor|Viewer|Owner)/);
  });

  it("deploys the lake job ARMED, on its own daily trigger", () => {
    assert.match(setup, /--args="--tier=lake,--apply"/);
    assert.equal(val(setup, "LAKE_SCHEDULE"), "30 2 * * *");
    assert.match(setup, /upsert_trigger "\$LAKE_SCHED_NAME" "\$LAKE_SCHEDULE"/);
  });
});

describe("setup-sync-job.sh --skip-build cannot create the lake job", () => {
  // Its own stub dir: a `gcloud` that logs, says the lake job exists only when
  // told to, and FAILS every `iam` call — so a run that gets past the gate
  // stops at step 2 having touched nothing.
  const GSTUBS = join(DIR, "gcloud-bin");
  mkdirSync(GSTUBS);
  writeFileSync(
    join(GSTUBS, "gcloud"),
    `#!/bin/bash
echo "GCLOUD $*" >> "$STUB_LOG"
case "$1 $2 $3" in
  "run jobs describe") [ -n "$STUB_LAKE_JOB_EXISTS" ] && exit 0; exit 1 ;;
esac
[ "$1" = "iam" ] && exit 1
exit 0
`,
  );
  chmodSync(join(GSTUBS, "gcloud"), 0o755);

  const runSetup = (
    env: Record<string, string>,
  ): { status: number; out: string; log: string } => {
    const log = join(DIR, `setup-log-${Math.random().toString(36).slice(2)}`);
    writeFileSync(log, "");
    const r = spawnSync("bash", [SETUP, "--skip-build"], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: `${GSTUBS}:${process.env.PATH ?? ""}`,
        CLOUDSDK_CONFIG: NO_CREDS,
        STUB_LOG: log,
        ...env,
      },
    });
    return {
      status: r.status ?? -1,
      out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
      log: readFileSync(log, "utf8"),
    };
  };

  it("refuses when sync-prod-to-qa-lake does not exist yet — before deploying anything", () => {
    const r = runSetup({});
    assert.equal(r.status, 1, r.out.slice(-1500));
    assert.match(
      r.out,
      /REFUSING --skip-build: sync-prod-to-qa-lake does not exist yet/,
    );
    assert.match(r.log, /GCLOUD run jobs describe sync-prod-to-qa-lake/);
    assert.doesNotMatch(r.log, /deploy|builds|iam|scheduler/);
  });

  it("lets --skip-build through once the lake job exists", () => {
    const r = runSetup({ STUB_LAKE_JOB_EXISTS: "1" });
    assert.doesNotMatch(r.out, /REFUSING --skip-build/);
    // Reached step 2 (the stub fails `iam` there on purpose).
    assert.match(r.log, /GCLOUD iam service-accounts describe/);
    assert.doesNotMatch(r.log, /builds submit/);
  });
});
