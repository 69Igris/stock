/**
 * The Dataform project agrees with the lake contract. MONEY-1506 (B4).
 *
 * `dataform/` is SQL and YAML — no TypeScript compiles it, no test in that
 * directory can run, and a Dataform compilation error surfaces at the first
 * scheduled workflow invocation rather than in CI. So the few facts it shares
 * with the rest of the repo are held here, the same way
 * `lake-infra-coverage.test.ts` holds `setup-lake.sh` against the contract.
 *
 * ## WHAT THIS DOES NOT DO
 *
 * It does not compile the project, and it must not be read as if it did.
 * The COMPILE runs in `workers/Dockerfile` since MONEY-1611 — both envs,
 * offline, against the CLI the `lake-gold` job uses — so a project that does
 * not compile fails the image build. The ALGEBRA of the one model that matters is proven by
 * execution instead, in
 * `packages/core/__tests__/market-data/adjustment-sql-parity.test.ts`, which
 * runs the SQL and compares it to the TypeScript.
 *
 * ## EVERY SCAN IS PROVED TO HAVE READ SOMETHING
 *
 * A regex that silently matches nothing turns each assertion below into
 * `[] === []` — the documented failure of `no-feed-fetch-bypass.test.ts` — so
 * the first case asserts floors on every extraction before anything is
 * compared.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { LAKE_DATASETS, LAKE_REGION } from "../../src/ops/lake-layout";
import { goldCliArgs, parseGoldArgs } from "../../src/ops/lake-gold-logic";
import { ADJUSTMENT_POLICY_VERSION as RELEASE_POLICY_VERSION } from "../../src/ops/lake-release-logic";

// packages/core/__tests__/ops -> repo root
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const DATAFORM = join(ROOT, "dataform");

const SETTINGS = readFileSync(join(DATAFORM, "workflow_settings.yaml"), "utf8");
const DATASETS_JS = readFileSync(
  join(DATAFORM, "includes/datasets.js"),
  "utf8",
);
const ADJUSTMENT_JS = readFileSync(
  join(DATAFORM, "includes/adjustment.js"),
  "utf8",
);
const SETUP = readFileSync(join(ROOT, "scripts/ops/setup-dataform.sh"), "utf8");
const SETUP_LAKE = readFileSync(
  join(ROOT, "scripts/ops/setup-lake.sh"),
  "utf8",
);

const GOLD_DIR = join(DATAFORM, "definitions/gold");
const SQLX = readdirSync(GOLD_DIR)
  .filter((f) => f.endsWith(".sqlx"))
  .map((f) => ({ file: f, text: readFileSync(join(GOLD_DIR, f), "utf8") }));

/**
 * Comments stripped, because these files DOCUMENT the things they must not do.
 *
 * Both halves were found by this file's own first run:
 * `coverage_price_bar_d1.sqlx` explains that a whole-market ingest gap is
 * "visible as a hole in `lake_bronze.partition_load`", and a scan for the
 * ledger matched the sentence saying the model does not read it. The same
 * false positive `lake-infra-coverage.test.ts` records next door — a script
 * that documents what it refuses to do fails a scan for the refusal.
 */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(--|\/\/|#)/.test(l))
    .join("\n");
}

describe("every extraction read something", () => {
  it("the project has models and the scripts have content", () => {
    assert.ok(SQLX.length >= 5, `only ${SQLX.length} .sqlx models found`);
    assert.ok(
      SETTINGS.length > 200,
      "workflow_settings.yaml is suspiciously short",
    );
    assert.ok(SETUP.length > 2000, "setup-dataform.sh is suspiciously short");
    assert.ok(
      ADJUSTMENT_JS.includes("adjustedBarD1Sql"),
      "the adjustment include no longer exports the model's SQL",
    );
  });
});

describe("one region, stated everywhere it can be overridden", () => {
  it("workflow_settings.yaml pins the location", () => {
    assert.match(SETTINGS, new RegExp(`defaultLocation:\\s*${LAKE_REGION}\\b`));
  });

  it("the provisioner pins the SAME region", () => {
    assert.match(SETUP, new RegExp(`REGION="${LAKE_REGION}"`));
  });

  it("the gold job passes the SAME region on every run (MONEY-1611)", () => {
    // `--default-location` OVERRIDES workflow_settings.yaml, so pinning only
    // the file would leave the job free to run in another region — and the
    // failure reads as "Dataset not found in location US", which looks like a
    // missing table. It replaces the managed release config's
    // `codeCompilationConfig.defaultLocation`, which this used to assert.
    for (const env of ["qa", "prod"] as const) {
      assert.ok(
        goldCliArgs(parseGoldArgs(["--env", env]), "/p", "/c").includes(
          `--default-location=${LAKE_REGION}`,
        ),
      );
    }
  });

  it("the two CONFIG surfaces name no other region, including bare US", () => {
    // `\bUS\b` catches BigQuery's MULTI-REGION, which is what a missing
    // location falls back to — and in a settings file or a provisioner the
    // token can only mean that.
    for (const { file, text } of [
      { file: "workflow_settings.yaml", text: SETTINGS },
      { file: "setup-dataform.sh", text: SETUP },
    ]) {
      assert.ok(
        !/us-east4|us-central1|\beu\b|\bUS\b/.test(stripComments(text)),
        `${file} names a region that is not ${LAKE_REGION}`,
      );
    }
  });

  it("no MODEL names a region", () => {
    // Deliberately WITHOUT `\bUS\b`: in a model that token is a market value
    // (`market = 'US'`, lake-layout.md §4 — market is a column, never a
    // dataset), so the strict pattern above would fail on correct SQL. This
    // file's first run did exactly that, on `adjusted_bar_d1.sqlx`'s column
    // description. A test that cannot be satisfied by correct code gets
    // weakened until it asserts nothing; narrowing it to what the token can
    // actually mean HERE is the honest fix.
    for (const { file, text } of SQLX) {
      assert.ok(
        !/us-east4|us-central1|asia-south2|\bmulti-?region\b/i.test(
          stripComments(text),
        ),
        `${file} names a region`,
      );
    }
  });
});

describe("the env suffix is derived, never hardcoded", () => {
  it("datasets.js builds both layer names from vars.env", () => {
    // ONE mechanism. `workflow_settings.yaml` also carries `defaultDataset`,
    // and a release config can override the two independently — so a prod run
    // whose `defaultSchema` moved and whose `vars.env` did not would read QA
    // silver and write prod gold, silently and across environments.
    assert.match(
      DATASETS_JS,
      /lake_silver_\$\{dataform\.projectConfig\.vars\.env\}/,
    );
    assert.match(
      DATASETS_JS,
      /lake_gold_\$\{dataform\.projectConfig\.vars\.env\}/,
    );
  });

  it("the layers it names are the contract's layers", () => {
    for (const layer of ["lake_silver", "lake_gold"]) {
      assert.ok(
        (LAKE_DATASETS as readonly string[]).includes(layer),
        `${layer} is not one of the contract's datasets`,
      );
      assert.ok(
        DATASETS_JS.includes(layer),
        `datasets.js does not name ${layer}`,
      );
    }
  });

  it("no model hardcodes a dataset name", () => {
    for (const { file, text } of SQLX) {
      // STRIPPED, for the reason this file's own header gives: a scan over raw
      // text cannot tell a hardcoded dataset from PROSE ABOUT one.
      // `assert_india_split_is_adjusted` explains that it is gated to prod
      // because `lake_silver_qa` holds zero rows — a sentence that documents
      // why the model does NOT name a dataset, failing the scan for naming
      // one. Same false positive as the `partition_load` case above, and the
      // mirror of MONEY-1516 review #16, where prose SATISFIED a scan instead
      // of violating one. Prose must do neither.
      assert.ok(
        !/lake_(?:bronze|silver|gold|private)_(?:qa|prod)\b/.test(
          stripComments(text),
        ),
        `${file} hardcodes an environment-suffixed dataset`,
      );
      assert.match(
        text,
        /schema:\s*datasets\.gold\(\)/,
        `${file} must take its schema from datasets.gold()`,
      );
    }
  });

  it("the gold job's schema, assertion schema and vars.env are ONE value", () => {
    // All three are overridden per run; a split between them is the exact
    // cross-environment write the single-mechanism rule above prevents in the
    // models, so the job must not reintroduce it. The assertion schema is not
    // optional: left at the file's QA default, a prod run would write its
    // built-in assertion views into lake_gold_qa. MONEY-1611.
    for (const env of ["qa", "prod"] as const) {
      const argv = goldCliArgs(parseGoldArgs(["--env", env]), "/p", "/c");
      for (const want of [
        `--default-schema=lake_gold_${env}`,
        `--assertion-schema=lake_gold_${env}`,
        `--vars=env=${env}`,
      ]) {
        assert.ok(argv.includes(want), `${env}: missing ${want}`);
      }
    }
  });
});

describe("the project reads gold and silver, and never bronze", () => {
  it("no model references the ledger", () => {
    for (const { file, text } of SQLX) {
      assert.ok(
        !/lake_bronze|source_object|partition_load|quarantine/.test(
          stripComments(text),
        ),
        `${file} reaches into the bronze ledger`,
      );
    }
  });

  it("the Dataform service account is granted gold + silver only", () => {
    // Least privilege, and the reason `lake-dataform-{env}@` exists at all
    // rather than reusing `lake-writer-{env}@`, which holds dataEditor on
    // BRONZE — the table that records what every loader has already done.
    assert.match(SETUP_LAKE, /SA_DATAFORM_BASE="lake-dataform"/);
    assert.match(
      SETUP_LAKE,
      /grant_dataset "lake_gold_\$\{ENV\}" "\$DATAFORM" "WRITER"/,
    );
    assert.match(
      SETUP_LAKE,
      /grant_dataset "lake_silver_\$\{ENV\}" "\$DATAFORM" "READER"/,
    );
    assert.ok(
      !/grant_dataset "lake_bronze_\$\{ENV\}" "\$DATAFORM"/.test(SETUP_LAKE),
      "the Dataform account must never be granted on bronze",
    );
    assert.ok(
      !/grant_dataset "lake_private_\$\{ENV\}" "\$DATAFORM"/.test(SETUP_LAKE),
      "the Dataform account must never be granted on private",
    );
  });

  it("the gold job runs AS that account, not as the default compute one", () => {
    // MONEY-1611: the managed workflow config's `serviceAccount` became the
    // Cloud Run job's `--service-account`.
    assert.match(SETUP, /--service-account="\$JOB_SA"/);
    assert.match(SETUP, /JOB_SA="lake-dataform-\$\{ENV\}@/);
  });
});

describe("the SQL nobody can compile is still the SQL that was tested", () => {
  it("adjusted_bar_d1 takes its body from the include, not from prose", () => {
    const model = SQLX.find((s) => s.file === "adjusted_bar_d1.sqlx");
    assert.ok(model, "adjusted_bar_d1.sqlx is missing");
    assert.match(
      model.text,
      /\$\{adjustment\.adjustedBarD1Sql\(ref\("price_bar_d1"\), ref\("corporate_action"\)\)\}/,
      "the model must call the include — SQL pasted into a .sqlx is SQL nothing can test",
    );
    // …and the model must not ALSO carry its own SELECT, which would make the
    // tested string and the deployed string two different things.
    assert.ok(
      !/^\s*SELECT\b/im.test(model.text.replace(/\/\*[\s\S]*?\*\//g, "")),
      "adjusted_bar_d1.sqlx carries a second SELECT beside the include's",
    );
  });

  it("money is NUMERIC in the emitted SQL, never FLOAT64", () => {
    // The lake's own rule (packages/lake/ddl/002_silver_price_bars.sql):
    // BigQuery FLOAT64 is IEEE-754 binary, so a close of 1234.55 does not
    // round-trip. The FACTORS are not money and are deliberately FLOAT64.
    for (const col of ["adj_open", "adj_high", "adj_low", "adj_close"]) {
      assert.match(
        ADJUSTMENT_JS,
        new RegExp(`CAST\\([a-z]+ \\* price_factor AS NUMERIC\\) AS ${col}`),
        `${col} must be CAST to NUMERIC`,
      );
    }
    assert.ok(
      !/AS FLOAT64\) AS adj_/.test(ADJUSTMENT_JS),
      "an adjusted price is money and must not be emitted as FLOAT64",
    );
  });

  it("a release manifest names the policy the view stamps on its rows", async () => {
    // TWO SPELLINGS OF ONE FACT, now held together — MONEY-1528. The view
    // stamps `adjustment_policy_version` on every row from the include; the
    // release job writes its OWN copy into every manifest and compares it
    // with nothing. Bump one alone and a release says one policy over rows
    // stamped with another, which is the confusion the string exists to
    // prevent. The comparison is against the include's EXPORT, not a regex.
    const mod = (await import(
      pathToFileURL(join(DATAFORM, "includes/adjustment.js")).href
    )) as { default?: { ADJUSTMENT_POLICY_VERSION: string } } & {
      ADJUSTMENT_POLICY_VERSION?: string;
    };
    const include = mod.default ?? {
      ADJUSTMENT_POLICY_VERSION: String(mod.ADJUSTMENT_POLICY_VERSION),
    };
    assert.equal(
      include.ADJUSTMENT_POLICY_VERSION,
      RELEASE_POLICY_VERSION,
      "adjustment.js and lake-release-logic.ts must bump the policy version together",
    );
  });

  it("the factors are FLOAT64 where they are BORN, or BigQuery keeps them NUMERIC", () => {
    // MONEY-1528 (A). A TEXT pin, and deliberately so: SQLite has no NUMERIC,
    // so the parity test cannot see this, and the one proof that can —
    // `scripts/ops/adjustment-parity.ts` — needs credentials. Without these
    // three casts BigQuery computes every factor in NUMERIC(38,9) (LN and EXP
    // of a NUMERIC return NUMERIC, and even `1.0 / split_eff` coerces the
    // literal): measured 3.95e-8 against the 1e-9 bound and an adjusted
    // volume 101 shares off on the harness fixture.
    const sql = stripComments(ADJUSTMENT_JS);
    for (const [where, pattern] of [
      ["prev_close", /\) AS FLOAT64\) AS prev_close/],
      [
        "action_split",
        /EXP\(SUM\(LN\(CAST\([\s\S]*?AS FLOAT64\)\)\)\) AS action_split/,
      ],
      ["bar_split", /AS FLOAT64\) AS bar_split/],
    ] as const) {
      assert.match(sql, pattern, `${where} is not widened to FLOAT64`);
    }
  });

  it("every model declares assertions", () => {
    // A Dataform assertion FAILS the workflow invocation. A model with none
    // publishes whatever silver happened to contain, and a wrong number in a
    // view is invisible in a way a wrong number in a job log is not.
    for (const { file, text } of SQLX) {
      if (/type:\s*"assertion"/.test(text)) continue;
      assert.match(text, /assertions:\s*\{/, `${file} declares no assertions`);
    }
  });

  it("the latest-bar assertion exists and is a real query", () => {
    const a = SQLX.find(
      (s) => s.file === "assert_latest_bar_is_unadjusted.sqlx",
    );
    assert.ok(a, "the latest-bar assertion is missing");
    assert.match(a.text, /type:\s*"assertion"/);
    assert.match(a.text, /ABS\(adj_close - close\)/);
    assert.match(a.text, /rn = 1/);
  });

  it("a pinned real split proves the India adjustment actually ran", () => {
    // MONEY-1516: `assert_latest_bar_is_unadjusted` CANNOT see a zeroed
    // adjustment — under CRSP back-adjustment the newest bar is unadjusted by
    // construction, which is exactly what it asserts. This is the assertion
    // that can, and deleting it would leave that blind spot uncovered with
    // every other check still green.
    const a = SQLX.find(
      (s) => s.file === "assert_india_split_is_adjusted.sqlx",
    );
    assert.ok(a, "the India-split assertion is missing");
    assert.match(a.text, /type:\s*"assertion"/);
    // The PIN itself: a real prod split, and a bar BEFORE its ex-date. In the
    // ONE India spelling (MONEY-1522): after the v2 reload a two-part id matches
    // no bar, and the assertion's not-measured arm would fire on every run.
    assert.match(a.text, /'TATASTEEL:NSE:unknown'/);
    assert.doesNotMatch(a.text, /'TATASTEEL:NSE'/);
    assert.match(a.text, /DATE '2022-07-26'/);
    // NOT-MEASURED IS NOT PASSED. A Dataform assertion passes on zero rows, so
    // an absent bar has to be its own failure or a join that dropped every
    // India row would read green.
    //
    // COMMENTS STRIPPED FIRST, and that is not tidiness. The header above this
    // query explains itself with the words "LEFT JOINed", so a regex over the
    // whole file matched a version of the SQL with the LEFT JOIN removed — the
    // prose describing the guard satisfied the check for the guard. Naming a
    // defect in a comment is not protection from it.
    // `stripComments`, not a block-comment-only replace — MONEY-1516 review.
    // This used to strip `/* */` alone, so a LINE comment reading
    // `-- LEFT JOIN actual a` satisfied the guard for the join it describes.
    const sql = stripComments(a.text);
    assert.match(
      sql,
      /LEFT JOIN actual a/,
      "the expectation must LEFT JOIN the view, so an absent bar still yields a row",
    );
    // Matched as a PREDICATE, not as the literal start of the WHERE: the
    // prod gate (#9) turned `WHERE a.listing_id IS NULL OR ...` into
    // `WHERE <env> AND (a.listing_id IS NULL OR ...)`. The guarantee is that
    // an absent bar is a failure ROW, which the LEFT JOIN above plus this
    // disjunct give together.
    assert.match(
      sql,
      /a\.listing_id IS NULL/,
      "an absent bar must be its own named failure",
    );

    // THE EX BAR, which is the row that can see a DOUBLE adjustment. The cum
    // bar at 07-26 is divided under BOTH carrier rules, so pinning it alone
    // left the guard blind to the defect it most needs to catch: deleting the
    // whole `UNION ALL` used to run green.
    assert.match(
      sql,
      /DATE '2022-07-28'/,
      "the EX bar must be pinned — the cum bar cannot see a double adjustment",
    );
    assert.match(
      sql,
      /split_factor_cum - e\.want_split_cum/,
      "the EX bar is discriminated by split_factor_cum, not by price_factor",
    );

    // PROD-ONLY. Existentially quantified over data QA does not have.
    assert.match(
      sql,
      /vars\.env === "prod"/,
      "an existential assertion over prod-only data must be gated, or QA goes red twice daily and someone mutes it",
    );
  });

  it("the double-witness assertion watches the US double-count hazard", () => {
    const a = SQLX.find(
      (s) => s.file === "assert_no_double_adjustment_witness.sqlx",
    );
    assert.ok(a, "the double-witness assertion is missing");
    assert.match(a.text, /type:\s*"assertion"/);

    // STRIPPED — MONEY-1516 review (#16). These matched the RAW file, whose
    // `description` and header prose both contain the literal
    // "corporate_action", so deleting `JOIN ${ref("corporate_action")} a`
    // left every assertion green while the query degraded to a full scan of
    // `price_bar_d1` that can never fire. Same defect the sibling case above
    // already documents, one test down.
    const wit = stripComments(a.text);
    assert.match(wit, /price_bar_d1/);
    assert.match(
      wit,
      /JOIN \$\{ref\("corporate_action"\)\}/,
      "the assertion must actually JOIN the action table — prose naming it is not the join",
    );
    // Trivial values are excluded BY VALUE. Including `splitFactor` 1 and
    // `divCash` 0 — what a US bar carries on an ordinary day — would make this
    // permanently red for every US listing with any action history, and a muted
    // assertion is worse than none.
    assert.match(wit, /split_factor <> 1/);
    assert.match(wit, /div_cash > 0/);

    // …which is exactly why that half can never see a DISCARD — MONEY-1528
    // (D). The second half must come from the include's own chain, so it
    // judges the witnesses the view actually resolved; what it reports is
    // proven by execution in adjustment-sql-parity.test.ts.
    assert.match(
      wit,
      /\$\{adjustment\.discardedActionSql\(ref\("price_bar_d1"\), ref\("corporate_action"\)\)\}/,
      "the DISCARD half must render the include's discardedActionSql, not a copy of it",
    );
    assert.match(wit, /'DISCARD' AS finding/);
    assert.match(wit, /'OVERLAP' AS finding/);
  });
});

describe("event_return_outcome — MONEY-1596 (C5a)", () => {
  const DECLARATIONS = readFileSync(
    join(DATAFORM, "definitions/silver_views/declarations.js"),
    "utf8",
  );
  const model = SQLX.find((s) => s.file === "event_return_outcome.sqlx");
  const pit = SQLX.find(
    (s) => s.file === "assert_event_outcome_point_in_time.sqlx",
  );

  it("is an incremental MERGE on event_id, partitioned on observed_date, clustered by market", () => {
    assert.ok(model, "event_return_outcome.sqlx is missing");
    assert.match(model.text, /type:\s*"incremental"/);
    // Without a uniqueKey an incremental run APPENDS: an OPEN row re-measured
    // tomorrow would sit beside today's copy instead of replacing it. Matched
    // at the CONFIG's own indent — `assertions.uniqueKey` (one level deeper)
    // is a check, not the MERGE key, and satisfied this pattern on its own.
    assert.match(model.text, /^  uniqueKey:\s*\["event_id"\]/m);
    assert.match(
      model.text,
      /partitionBy:\s*"DATE_TRUNC\(observed_date, MONTH\)"/,
    );
    assert.match(model.text, /clusterBy:\s*\["market"\]/);
  });

  it("takes its body from the include, reading ADJUSTED bars, never raw silver bars", () => {
    assert.ok(model, "event_return_outcome.sqlx is missing");
    const sql = stripComments(model.text);
    assert.match(sql, /\$\{event_outcome\.eventReturnOutcomeSql\(\{/);
    assert.match(sql, /events:\s*ref\("instrument_event"\)/);
    // A split inside a window read off price_bar_d1 is a -50% "reaction".
    assert.match(sql, /bars:\s*ref\("adjusted_bar_d1"\)/);
    assert.doesNotMatch(sql, /ref\("price_bar_d1"\)/);
    assert.match(sql, /indexEod:\s*ref\("index_eod"\)/);
    // Incremental runs narrow the candidates; a full refresh measures all.
    assert.match(
      sql,
      /incremental\(\)\s*\?\s*event_outcome\.incrementalCandidatesSql\(self\(\)\)\s*:\s*"TRUE"/,
    );
    assert.ok(
      !/^\s*SELECT\b/im.test(sql),
      "event_return_outcome.sqlx carries a SELECT beside the include's — the tested string and the deployed one would differ",
    );
  });

  it("the point-in-time assertion renders the include's executed SQL", () => {
    assert.ok(pit, "assert_event_outcome_point_in_time.sqlx is missing");
    assert.match(pit.text, /type:\s*"assertion"/);
    assert.match(
      stripComments(pit.text),
      /\$\{event_outcome\.pointInTimeViolationsSql\(ref\("event_return_outcome"\), ref\("instrument_event"\)\)\}/,
    );
  });

  it("the two silver inputs are declared, from vars.env like the rest", () => {
    for (const name of ["instrument_event", "index_eod"]) {
      assert.match(
        stripComments(DECLARATIONS),
        new RegExp(
          `declare\\(\\{ schema: datasets\\.silver\\(\\), name: "${name}" \\}\\)`,
        ),
        `${name} is not declared — ref("${name}") would not compile`,
      );
    }
  });
});

describe("rolling_stats is materialised, and still derives from the one adjustment — MONEY-1606", () => {
  const model = SQLX.find((s) => s.file === "rolling_stats.sqlx");

  it("is a TABLE rebuilt whole — never incremental", () => {
    assert.ok(model, "rolling_stats.sqlx is missing");
    // An incremental table would append tomorrow's rows on the new adjustment
    // basis and keep every earlier SMA and 52-week range on the old one the
    // day a split lands — a step on real prices, with no error anywhere.
    assert.match(model.text, /type:\s*"table"/);
    assert.doesNotMatch(model.text, /type:\s*"incremental"/);
  });

  it("is partitioned and clustered for the query_lake reads", () => {
    assert.ok(model, "rolling_stats.sqlx is missing");
    // MONTH: US history reaches 1962, and a day-partitioned full rebuild
    // would write ~23,000 partitions against BigQuery's 4,000-per-job limit.
    assert.match(
      model.text,
      /partitionBy:\s*"DATE_TRUNC\(session_date, MONTH\)"/,
    );
    // `rolling_stats_for` filters one listing, `universe_top_by` one market.
    assert.match(model.text, /clusterBy:\s*\["market", "listing_id"\]/);
  });

  it("reads the adjusted chain and computes no adjustment of its own", () => {
    assert.ok(model, "rolling_stats.sqlx is missing");
    const sql = stripComments(model.text);
    assert.match(sql, /FROM \$\{ref\("returns_daily"\)\}/);
    // price_bar_d1 is read for the session's ISIN and nothing else — a price
    // taken from it would be RAW, and a factor computed here would be a
    // second copy of includes/adjustment.js.
    assert.match(
      sql,
      /SELECT market, listing_id, session_date, MAX\(isin\) AS isin\s+FROM \$\{ref\("price_bar_d1"\)\}/,
    );
    assert.equal(sql.split('ref("price_bar_d1")').length - 1, 1);
    assert.doesNotMatch(
      sql,
      /price_factor|split_factor|adjustment\.|\bclose\b/,
    );
    assert.match(sql, /i\.isin/);
  });
});
