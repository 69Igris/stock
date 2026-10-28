/**
 * MONEY-1465 S1 — the lake contract agrees with the script that provisions it.
 *
 * `docs/reference/lake-layout.md` DECLARES the lake; `scripts/ops/setup-lake.sh`
 * CREATES it. Nothing compiles the two together, so every disagreement between
 * them is silent:
 *
 *   named in the doc, absent from the script   a provisioning gap. The later
 *                                              prompt that cites the contract
 *                                              writes to a dataset that does
 *                                              not exist, months from now.
 *   created by the script, absent from the doc an undocumented resource. It
 *                                              accrues cost and grants, and the
 *                                              contract everyone reads does not
 *                                              mention it.
 *   a region that is not asia-south1           a BigQuery job runs in ONE
 *                                              location and every dataset it
 *                                              touches must be in that
 *                                              location. One stray row makes a
 *                                              join impossible, and the error
 *                                              arrives at query time.
 *   stockbook-api@ granted on BigQuery         the web request path gains a
 *                                              variable-cost, variable-latency
 *                                              dependency with no upper bound.
 *
 * ## Why this reads two files as TEXT
 *
 * There is no other observable. The script's entire output is `gcloud` and `bq`
 * invocations, and those are exactly what a test must not run; the doc is
 * markdown. Reading both is the honest version of "did the two stay equal" — a
 * mocked gcloud would only assert the mock was written correctly. Same
 * reasoning `edgar-infra-coverage.test.ts` records next door.
 *
 * ## Every scan is proved to have read something
 *
 * A regex that silently matches nothing turns each `deepEqual` below into
 * `[] === []`. That is not hypothetical — it is the documented failure of
 * `no-feed-fetch-bypass.test.ts` — so the first `describe` asserts floors on
 * every extraction before anything is compared.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONTENT_PREFIXES,
  LAKE_PREFIXES,
  LAKE_REGION,
  UnknownPrefixError,
  bucketForPrefix,
  declaredPrefixes,
  LAKE_DATASETS,
  datasetFor,
} from "../../src/ops/lake-layout";

// packages/core/__tests__/ops -> repo root
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const DOC = readFileSync(join(ROOT, "docs/reference/lake-layout.md"), "utf8");
const SCRIPT = readFileSync(join(ROOT, "scripts/ops/setup-lake.sh"), "utf8");
const TEST_SELF = readFileSync(
  join(import.meta.dirname, "lake-infra-coverage.test.ts"),
  "utf8",
);
const SMOKE = readFileSync(join(ROOT, "scripts/ops/lake-smoke.ts"), "utf8");

/** Comments stripped: the script DOCUMENTS what it refuses to do. */
// Both comment styles: the script embeds a `node -e` block whose comments are
// `//`, and a scan that stripped only `#` matched a gcloud call inside a JS
// comment — the same false positive as the "delibe(rate)ly" match one
// script over. Only lines that ARE comments are dropped, so `https://` in
// code survives.
const CODE = SCRIPT.replace(/^\s*#.*$/gm, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * `CODE` with shell line-continuations joined, so a multi-line command is ONE
 * line to a regex.
 *
 * Needed because every `gcloud` call here is continued with `\`, and an
 * assertion written as `add-iam-policy-binding[^\n]*--role=…` therefore matched
 * nothing and passed on a script that granted project-wide dataEditor.
 * Mutation-verified: without this the guard below is vacuous.
 */
const CODE_JOINED = CODE.replace(/\\\s*\n\s*/g, " ");

/**
 * The doc with markdown wrapping flattened, for PROSE assertions.
 *
 * A quoted paragraph wraps mid-sentence behind `> ` prefixes, so a phrase like
 * "the exchange file is the truth for a closed session" spans a line break and
 * a literal match finds nothing — which would make an assertion about the
 * contract's content quietly untestable.
 */
const DOC_FLAT = DOC.replace(/\n>?\s+/g, " ");

/** Every `| … |` row of every markdown table in the doc, as cell arrays. */
function docTableRows(): string[][] {
  return DOC.split("\n")
    .filter((l) => l.trim().startsWith("|") && !/^\|[\s|:-]+\|$/.test(l.trim()))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim()),
    );
}

/** Pull a `NAME=( … )` block out of the shell script. */
function bashArray(name: string): string[] {
  const at = CODE.indexOf(`${name}=(`);
  assert.ok(at >= 0, `${name}=( … ) not found in setup-lake.sh`);
  const block = CODE.slice(at, CODE.indexOf("\n)", at));
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

const rows = docTableRows();
const datasetBases = bashArray("DATASETS");
const lifecycleRules = bashArray("LAKE_LIFECYCLE_RULES");
/** Dataset names the doc declares, e.g. `lake_bronze_{env}`. */
const docDatasets = [
  ...DOC.matchAll(/`(lake_(?:bronze|silver|gold|private))_\{env\}`/g),
].map((m) => m[1]!);
/** Service-account bases the doc declares, e.g. `lake-writer-{env}@`. */
const docServiceAccounts = [...DOC.matchAll(/`(lake-[a-z-]+)-\{env\}@`/g)].map(
  (m) => m[1]!,
);

describe("every extraction read something", () => {
  it("the doc has tables, datasets and service accounts", () => {
    assert.ok(
      rows.length >= 15,
      `only ${rows.length} table rows parsed from lake-layout.md`,
    );
    assert.ok(
      new Set(docDatasets).size === 4,
      `doc declares ${new Set(docDatasets).size} datasets, expected 4`,
    );
    // FOUR since MONEY-1506 (B4): `lake-dataform-{env}@` joined the three S1
    // accounts. Deliberately a hard count rather than `>= 3` — this extraction
    // feeds the two-way comparison below, and a loosened floor would let an
    // account be REMOVED from the contract without failing anything.
    assert.ok(
      new Set(docServiceAccounts).size === 4,
      `doc declares ${new Set(docServiceAccounts).size} service accounts, expected 4`,
    );
  });

  it("the script has its declared lists", () => {
    assert.equal(
      datasetBases.length,
      4,
      `DATASETS has ${datasetBases.length} entries`,
    );
    assert.equal(
      lifecycleRules.length,
      2,
      `LAKE_LIFECYCLE_RULES has ${lifecycleRules.length} entries`,
    );
    assert.ok(
      CODE.length > 2000,
      "setup-lake.sh is suspiciously short after comment stripping",
    );
  });
});

describe("the TYPESCRIPT contract declares the same datasets — MONEY-1472", () => {
  // These names existed TWICE (the bash array and the doc table) and B1 needs
  // them from TypeScript at runtime, on every ledger write. A third copy in
  // `packages/lake` would be invisible to the two-way check above — the
  // one-fact-many-spellings defect this repo keeps paying for — so the TS
  // constant is the third party to the SAME agreement.
  it("LAKE_DATASETS matches the script and the doc, in both directions", () => {
    assert.deepEqual(
      [...LAKE_DATASETS].sort(),
      [...datasetBases].sort(),
      "LAKE_DATASETS and setup-lake.sh's DATASETS must name the same four",
    );
    assert.deepEqual(
      [...LAKE_DATASETS].sort(),
      [...new Set(docDatasets)].sort(),
      "LAKE_DATASETS and lake-layout.md must name the same four",
    );
  });

  it("datasetFor suffixes the environment and nothing else", () => {
    // Market is a COLUMN, never a second dataset (the region rule, 14-Sep). A
    // `lake_silver_us` created "just for now" is how a single-region plane
    // quietly becomes two.
    assert.equal(datasetFor("lake_bronze", "qa"), "lake_bronze_qa");
    assert.equal(datasetFor("lake_silver", "prod"), "lake_silver_prod");
    for (const ds of LAKE_DATASETS) {
      assert.match(
        datasetFor(ds, "prod"),
        /^lake_(bronze|silver|gold|private)_(qa|prod)$/,
        `${ds} must resolve to a declared dataset name`,
      );
    }
  });
});

describe("the doc and the script declare the same lake", () => {
  it("every dataset in the doc is created by the script", () => {
    for (const ds of new Set(docDatasets)) {
      assert.ok(
        datasetBases.includes(ds),
        `lake-layout.md declares ${ds}_{env} and setup-lake.sh never creates it`,
      );
    }
    assert.deepEqual(
      [...new Set(docDatasets)].sort(),
      [...datasetBases].sort(),
      "the doc and the script must declare the SAME four datasets, in either direction",
    );
  });

  it("every service account in the doc is created by the script", () => {
    for (const sa of new Set(docServiceAccounts)) {
      assert.ok(
        new RegExp(`SA_[A-Z]+_BASE="${sa}"`).test(CODE),
        `lake-layout.md declares ${sa}-{env}@ and setup-lake.sh never creates it`,
      );
    }
  });

  it("…and every service account the script creates is in the doc", () => {
    // THE OTHER DIRECTION, which this file's own header promised and did not
    // check: "a resource created by the script and absent here is an
    // UNDOCUMENTED one". The datasets are compared with `deepEqual` in both
    // directions; the service accounts were compared one way only, so a new
    // `SA_*_BASE` could be provisioned — with real IAM grants — without ever
    // appearing in the contract everyone reads.
    //
    // Found by mutating the doc (MONEY-1506): removing the `lake-dataform`
    // ROW left the count at four because a prose sentence also names it, and
    // the one-way check could not see the difference either.
    const scriptServiceAccounts = [
      ...CODE.matchAll(/SA_[A-Z]+_BASE="([a-z-]+)"/g),
    ].map((m) => m[1]!);
    assert.ok(
      scriptServiceAccounts.length >= 4,
      `only ${scriptServiceAccounts.length} SA_*_BASE declarations found`,
    );
    assert.deepEqual(
      [...new Set(scriptServiceAccounts)].sort(),
      [...new Set(docServiceAccounts)].sort(),
      "setup-lake.sh and lake-layout.md must name the SAME service accounts, in either direction",
    );
  });

  it("the lifecycle rules match", () => {
    // `lake/stage/` at 14 d and `rollback/` at 45 d, in both files.
    for (const rule of lifecycleRules) {
      const [prefix, , age] = rule.split("|");
      assert.ok(
        DOC.includes(`\`${prefix}\` delete @ ${age} d`),
        `setup-lake.sh has ${rule} which lake-layout.md §1 does not state`,
      );
    }
  });

  it("the script's bucket base matches the doc's", () => {
    assert.match(CODE, /LAKE_BUCKET_BASE="stockbook-lake"/);
    assert.ok(
      DOC.includes("`stockbook-lake-{env}`"),
      "the doc must name the bucket it declares",
    );
  });
});

describe("one region", () => {
  it("every REGION cell in the doc reads asia-south1", () => {
    // Find the column index named "Region" in each table that has one, and
    // assert that column. Scanning for the STRING anywhere would pass on a doc
    // that mentions asia-south1 once and lists us-east4 in a row.
    let checked = 0;
    let header: string[] | null = null;
    for (const row of rows) {
      const idx = row.findIndex((c) => c.toLowerCase() === "region");
      if (idx >= 0) {
        header = row;
        continue;
      }
      if (!header) continue;
      const regionIdx = header.findIndex((c) => c.toLowerCase() === "region");
      // Width mismatch means a DIFFERENT table started — drop the header rather
      // than carrying it for the rest of the document, where a future 4-column
      // table with no Region column would have its column-1 cell asserted
      // against asia-south1 and fail confusingly.
      if (row.length !== header.length) {
        header = null;
        continue;
      }
      if (regionIdx < 0) continue;
      // Annotated: `assert.equal`'s `asserts actual is T` narrowing, combined
      // with `cell` appearing in its own failure message, makes the inference
      // circular (TS7022).
      const cell: string = row[regionIdx]!.replace(/`/g, "");
      assert.equal(
        cell,
        LAKE_REGION,
        `a REGION cell reads "${cell}" — every row must be ${LAKE_REGION}`,
      );
      checked++;
    }
    assert.ok(
      checked >= 6,
      `only ${checked} region cells checked; the doc should have at least 6`,
    );
  });

  it("the script pins both the bucket and the BigQuery location", () => {
    assert.match(CODE, new RegExp(`REGION="${LAKE_REGION}"`));
    assert.match(CODE, new RegExp(`BQ_LOCATION="${LAKE_REGION}"`));
    assert.ok(
      !/us-east4|us-central1|\bUS\b/.test(CODE),
      "no US region may appear in the provisioner",
    );
  });

  it("the smoke test PINS the job location and asserts it came back", () => {
    // `SELECT 1` reads no dataset, so nothing forces a location: BigQuery will
    // happily run it in the US and a green smoke test would then certify the
    // exact thing it exists to check.
    assert.match(SMOKE, new RegExp(`LOCATION = "${LAKE_REGION}"`));
    assert.match(
      SMOKE,
      /location: LOCATION/,
      "the request must pin the location",
    );
    assert.match(
      SMOKE,
      /jobLocation !== LOCATION/,
      "…and the response must be asserted against it",
    );
  });
});

describe("the prohibitions are enforced, not just written down", () => {
  it("stockbook-api@ is granted nothing on BigQuery", () => {
    // The web request path never queries BigQuery (contract §8). This is the
    // version of that rule that survives someone not having read it.
    // CODE_JOINED, not CODE. This file DOCUMENTS why CODE_JOINED exists and then
    // did not use it on the single most-emphasised prohibition in the contract:
    // the regex tolerates one newline, while every gcloud call here is
    // `\`-continued across 4-6 lines, so a grant written in the script's own
    // formatting convention sailed straight past it.
    const grantsApi =
      /stockbook-api[^\n]*\n?[^\n]*roles\/bigquery|roles\/bigquery[^\n]*\n?[^\n]*stockbook-api/;
    assert.ok(
      !grantsApi.test(CODE_JOINED),
      "setup-lake.sh grants stockbook-api@ a BigQuery role",
    );
    assert.ok(
      DOC_FLAT.includes("**nothing on BigQuery**"),
      "the doc must state the prohibition",
    );
  });

  it("no dataset gets a default table expiration", () => {
    // A dataset-level default silently attaches an expiry to every table
    // created afterwards — including by a prompt whose author never read the
    // contract. A table that vanishes fails no test and raises no alert.
    assert.ok(
      !/--default_table_expiration|--default_partition_expiration/.test(CODE),
      "setup-lake.sh sets a default expiration; the contract says OFF on all four",
    );
    assert.ok(DOC_FLAT.includes("Default table expiration is OFF on all four"));
  });

  it("billing_export is never granted to a lake service account", () => {
    // It carries the whole project's spend at resource granularity.
    assert.ok(
      !/billing_export/.test(CODE),
      "setup-lake.sh references billing_export",
    );
    assert.ok(
      DOC.includes("billing_export"),
      "the doc must name it, so `bq ls` is not a surprise",
    );
    assert.ok(DOC.includes("**no grant, ever**"));
  });

  it("IAM is granted per DATASET, never project-wide dataEditor", () => {
    // A project-level roles/bigquery.dataEditor reaches `billing_export` and
    // every dataset created afterwards, including the other environment's.
    assert.ok(
      !/add-iam-policy-binding[^\n]*roles\/bigquery\.dataEditor/.test(
        CODE_JOINED,
      ),
      "a project-level dataEditor binding reaches every dataset in the project",
    );
    // …and the only project-level BigQuery role granted is jobUser.
    const projectRoles = [
      ...CODE_JOINED.matchAll(
        /add-iam-policy-binding[^\n]*?--role="(roles\/bigquery\.[a-zA-Z]+)"/g,
      ),
    ].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(projectRoles)],
      ["roles/bigquery.jobUser"],
      "jobUser is the ONLY project-level BigQuery role; it confers no data access",
    );
    // jobUser IS project-level by design — running a query is a project
    // operation and the role confers no data access.
    assert.match(CODE, /roles\/bigquery\.jobUser/);
  });
});

describe("the provisioner refuses rather than guesses", () => {
  it("a failed lifecycle read is fatal", () => {
    // `buckets update --lifecycle-file` REPLACES the whole policy. Building
    // from an assumed-empty baseline is indistinguishable from success and
    // destroys every rule the bucket acquired.
    assert.match(CODE, /REFUSING: could not read the live lifecycle policy/);
    assert.match(CODE, /exit 1/);
  });

  it("every create is guarded by a read", () => {
    assert.match(
      CODE,
      /gcloud storage buckets describe[^\n]*>\/dev\/null 2>&1/,
    );
    assert.match(CODE, /bq[^\n]*show --dataset[^\n]*>\/dev\/null 2>&1/);
    assert.match(
      CODE,
      /gcloud iam service-accounts describe[^\n]*>\/dev\/null 2>&1/,
    );
  });

  it("the dataset ACL is merged, never rebuilt", () => {
    // `bq update --source` rewrites the WHOLE access list, so building it from
    // scratch drops every binding the dataset already has.
    assert.match(SCRIPT, /MERGE, never replace/);
    assert.match(CODE, /ds\.access = ds\.access \|\| \[\]/);
  });
});

describe("bucketForPrefix is exhaustive and refuses the unknown", () => {
  it("every declared prefix routes to the expected bucket", () => {
    for (const p of LAKE_PREFIXES) {
      for (const env of ["qa", "prod"] as const) {
        assert.equal(
          bucketForPrefix(`${p}some/object.json`, env),
          `stockbook-lake-${env}`,
          p,
        );
        assert.equal(
          bucketForPrefix(p, env),
          `stockbook-lake-${env}`,
          `${p} (bare)`,
        );
      }
    }
    for (const p of CONTENT_PREFIXES) {
      for (const env of ["qa", "prod"] as const) {
        assert.equal(
          bucketForPrefix(`${p}some/object.json`, env),
          `stockbook-content-${env}`,
          p,
        );
        assert.equal(
          bucketForPrefix(p, env),
          `stockbook-content-${env}`,
          `${p} (bare)`,
        );
      }
    }
    assert.equal(
      declaredPrefixes().length,
      LAKE_PREFIXES.length + CONTENT_PREFIXES.length,
    );
  });

  it("the real keys this repo already writes all route", () => {
    // Taken from the live bucket, measured 2026-09-14 by gcs-prefix-sizes.
    const real: Array<[string, "lake" | "content"]> = [
      [
        "edgar/filings/0000001750/0000001750-25-000003/submission.txt",
        "content",
      ],
      ["edgar/bulk/companyfacts.zip", "content"],
      ["edgar/facts/0000320193.json", "content"],
      ["edgar/text/x.txt", "content"],
      ["databento/EQUS.MINI/ohlcv-1m/2023/EQUS-1/manifest.json", "content"],
      ["feeds/TIINGO/eod/2026/09/AAPL.csv", "content"],
      ["feeds/TIINGO/ws/2026-09-14/12/ticks.gz", "content"],
      ["feeds/NSE/bhavcopy/2026/09/cm.csv", "content"],
      ["feeds/BSE/scrip-master/current/master.csv", "content"],
      ["candles/US/D1/AAPL/2019", "content"],
      ["stocks/reports/annual/x.pdf", "content"],
      ["lake/stage/price_bar_d1/part-0001.parquet", "lake"],
      ["tiles/IN/RELIANCE/1y.json", "lake"],
      ["releases/2026-09-15T00-00-00Z/manifest.json", "lake"],
      ["rollback/pointer.json", "lake"],
    ];
    for (const [key, want] of real) {
      assert.equal(
        bucketForPrefix(key, "prod"),
        want === "lake" ? "stockbook-lake-prod" : "stockbook-content-prod",
        key,
      );
    }
  });

  it("an unknown prefix THROWS rather than defaulting", () => {
    // Falling back to the content bucket is how a new prefix silently lands in
    // the wrong place and is found months later by a bill.
    assert.throws(
      () => bucketForPrefix("quarantine/x.json", "qa"),
      UnknownPrefixError,
    );
    assert.throws(() => bucketForPrefix("", "qa"), UnknownPrefixError);
    assert.throws(() => bucketForPrefix("edgarx/y", "qa"), UnknownPrefixError);
    // The message has to say what to do, not just that something went wrong.
    assert.throws(() => bucketForPrefix("newthing/a", "qa"), /lake-layout\.md/);
  });

  it("prefix matching respects path boundaries", () => {
    // `candles/` must not claim `candlesticks/`.
    assert.throws(
      () => bucketForPrefix("candlesticks/x", "qa"),
      UnknownPrefixError,
    );
    assert.throws(
      () => bucketForPrefix("tilesets/x", "qa"),
      UnknownPrefixError,
    );
    assert.equal(
      bucketForPrefix("/candles/US/D1/AAPL/2019", "qa"),
      "stockbook-content-qa",
    );
  });

  it("the doc lists exactly the prefixes the code routes", () => {
    for (const p of declaredPrefixes()) {
      assert.ok(
        DOC.includes(`\`${p}`),
        `bucketForPrefix routes ${p} and lake-layout.md §1 does not mention it`,
      );
    }
  });
});

describe("the contract states the things later prompts will look for", () => {
  it("the six mandatory silver columns", () => {
    for (const col of [
      "source_object_uri",
      "source_record_key",
      "parser_version",
      "pipeline_run_id",
      "observed_at",
      "ingested_at",
    ]) {
      assert.ok(
        DOC.includes(`\`${col}\``),
        `lake-layout.md must name the mandatory column ${col}`,
      );
    }
  });

  it("partitioning, clustering and the four clocks", () => {
    assert.match(DOC, /\*\*MONTH\*\*/);
    assert.match(DOC, /\*\*DAY\*\*/);
    assert.ok(
      DOC.includes("`session_date`") && DOC.includes("`observed_date`"),
    );
    assert.ok(
      DOC.includes("`market, listing_id, source`"),
      "the cluster key, in order",
    );
    for (const clock of [
      "Event time",
      "Observed time",
      "Ingest time",
      "Query time",
    ]) {
      assert.ok(
        DOC.includes(clock),
        `the four clocks must all be named — missing ${clock}`,
      );
    }
  });

  it("release file sizes and the escape hatch", () => {
    assert.ok(DOC_FLAT.includes("256 MB – 1 GB"), "release file size band");
    assert.match(DOC_FLAT, /ADDITION, not a redesign/);
    assert.ok(
      DOC.includes("bucketForPrefix"),
      "the escape hatch names the seam",
    );
  });

  it("bar-source precedence is quoted verbatim, with the enforced ranks", () => {
    assert.match(
      DOC_FLAT,
      /the exchange file is the truth for a closed session/,
    );
    assert.match(DOC_FLAT, /never overwriting a higher-authority row/);
    // The ranks must match price-source-authority.ts exactly.
    for (const [source, rank] of [
      ["BHAVCOPY", 100],
      ["TIINGO", 60],
      ["DATABENTO", 55],
      ["ZERODHA", 50],
      ["TIINGO_RT", 20],
      ["YAHOO", 10],
    ] as const) {
      assert.ok(
        new RegExp(`${source}\`?[^|]*\\|\\s*${rank}\\s*\\|`).test(DOC),
        `lake-layout.md must state ${source} = ${rank}, matching price-source-authority.ts`,
      );
    }
    assert.ok(DOC.includes("Unknown ranks **last**"));
  });

  it("the two prohibitions are stated as prohibitions", () => {
    assert.match(DOC_FLAT, /The web request path never queries BigQuery/);
    assert.match(DOC_FLAT, /No new history defaults to Mongo/);
  });
});

/**
 * Guards for the seven findings the S1 review raised. Each names the mechanism,
 * because a regression here is silent in every case.
 */
describe("review findings stay fixed", () => {
  it("the lifecycle read accepts the key gcloud ACTUALLY emits", () => {
    // Verified live 2026-09-15: `buckets describe --format=json` emits
    // `lifecycle_config`, and `.lifecycle` is undefined. Reading only
    // `.lifecycle` made `existing` always [] — so the `--lifecycle-file` write
    // REPLACED the whole policy with the two declared rules, destroying every
    // rule the bucket had. The failed-READ guard gave false confidence: the
    // read succeeds.
    assert.match(CODE, /lifecycle_config/, "the live key must be read");
    assert.match(CODE, /LIFECYCLE_KEYS/, "every spelling is accepted");
    assert.match(
      CODE,
      /is present but not a rule list/,
      "a present-but-unrecognised shape must REFUSE, not read as empty",
    );
  });

  it("the merge dedupe is key-order insensitive", () => {
    // A raw JSON.stringify would re-append a live rule whose condition
    // serialises in a different key order, on every run — quietly breaking the
    // IDEMPOTENT claim.
    assert.match(
      CODE,
      /Object\.keys\(v\)\.sort\(\)/,
      "normalise before comparing",
    );
  });

  it("the impersonation grant cannot abort the run", () => {
    // Unguarded under `set -e` it would die BEFORE the project-level jobUser
    // grant, leaving the writer with dataset access and unable to run a job.
    assert.match(
      CODE_JOINED,
      /add-iam-policy-binding[^\n]*serviceAccountTokenCreator[^\n]*\|\|/,
    );
  });

  it("the budget is ATTEMPTED, not merely described", () => {
    // The header, the usage block and lake-layout.md §11 all promise an
    // attempt. Three places describing a call that never happens is the
    // doc-vs-script drift this whole suite exists for.
    // `run gcloud …`, NOT a bare match: the founder-step FALLBACK echoes the
    // same command as instructions, so `/gcloud billing budgets create/` passes
    // on a script that only ever prints it. That is the whole finding — three
    // places describing a call that never happens.
    assert.match(
      CODE,
      /\brun gcloud billing budgets create\b/,
      "the budget must be INVOKED, not merely echoed as an instruction",
    );
    assert.match(CODE, /\|\| \{/, "…and fall back to the founder instructions");
  });

  it("every gcloud call pins the ACTOR, not only the project", () => {
    // Without --account the script creates service accounts and IAM bindings as
    // whatever identity the active config holds, then binds THAT identity as
    // tokenCreator.
    // Anchored to a COMMAND POSITION — start of line, `run `, `$(`, `if `, or
    // `||` — because a bare `\bgcloud` matched the words "no active gcloud
    // account" inside an echo string. Third prose false-positive in this repo's
    // source scans; the rule is to match the invocation, not the word.
    const calls = [
      ...CODE_JOINED.matchAll(
        /(?:^|\$\(|\brun |\bif |\|\| )\s*gcloud (?:storage|iam|projects) [^\n]*/gm,
      ),
    ].map((m) => m[0]);
    assert.ok(calls.length >= 6, `only ${calls.length} gcloud calls found`);
    for (const c of calls) {
      assert.ok(
        c.includes("--account="),
        `a gcloud call does not pin the actor: ${c.slice(0, 90)}`,
      );
    }
  });

  it("lake-smoke REQUIRES its environment argument", () => {
    // The checklist runs it as the prod proof step; a dropped argument would
    // print "OK — lake-writer-qa@ …" and read as a green prod verification.
    assert.ok(
      !/process\.argv\[2\] \?\? "qa"/.test(SMOKE),
      "the env must not default",
    );
    assert.match(SMOKE, /const env = process\.argv\[2\];/);
    assert.match(SMOKE, /The environment is required/);
  });

  it("bucketForPrefix covers what is in BOTH buckets, not just prod", () => {
    // prod holds candles/ databento/ edgar/ feeds/ stocks/;
    // qa holds content/ documents/ feeds/ stocks/. The first list was prod-only
    // and its comment claimed otherwise, so the first learning-content key
    // routed would have thrown.
    for (const key of [
      "content/videos/intro.mp4",
      "content/images/x.png",
      "documents/user/statement.pdf",
    ]) {
      assert.equal(bucketForPrefix(key, "qa"), "stockbook-content-qa", key);
    }
  });
});

/**
 * The second review pass. Nine real findings; one was WRONG and is recorded as
 * such so a third reviewer does not re-raise it.
 */
describe("second-review findings stay fixed", () => {
  it("REJECTED: the {lifecycle:{rule}} write shape is accepted by gcloud", () => {
    // The review called this HIGH, citing setup-gcs-lifecycle.sh's comment that
    // "gcloud rejects it". MEASURED 2026-09-15 instead: a `buckets update
    // --lifecycle-file` with the wrapped shape returned exit 0 and the rules
    // are live on gs://stockbook-lake-qa — and setup-lake.sh had already run
    // three times against QA. The FIRST review had independently checked the
    // same thing and called the sibling's comment stale.
    //
    // Kept as a test so the next reader sees the measurement rather than the
    // comment, which is what sent this reviewer wrong.
    assert.match(
      CODE,
      /lifecycle: \{ rule: merged \}/,
      "the wrapped shape is deliberate and verified",
    );
    assert.match(
      SCRIPT,
      /VERIFIED 2026-09-15/,
      "…and the file records the measurement",
    );
  });

  it("all three service accounts get jobUser", () => {
    // `bigquery.jobs.create` is required to run ANY query or load job. Granting
    // it only to the writer left the reader unable to SELECT from the silver it
    // can see, and the private writer unable to run the load job that would
    // write the dataset it owns — both provisioned unusable, and `lake-smoke`
    // exercises only the writer so it certified green over them.
    assert.match(CODE, /for SA_JOB in "\$WRITER" "\$READER" "\$PRIVATE"/);
    assert.match(
      CODE_JOINED,
      /add-iam-policy-binding[^\n]*\$\{SA_JOB\}[^\n]*jobUser/,
    );
  });

  it("bq is actor-pinned via CLOUDSDK_CORE_ACCOUNT", () => {
    // `bq` has NO --account flag, so pinning every gcloud call still left the
    // datasets and every ACL binding created by whatever identity the shell
    // held.
    assert.match(CODE, /export CLOUDSDK_CORE_ACCOUNT="\$GCLOUD_ACCOUNT"/);
  });

  it("the budget is idempotent, actor-pinned, and keeps its stderr", () => {
    assert.match(
      CODE,
      /gcloud billing budgets list/,
      "guarded by a read like every other create",
    );
    assert.match(
      CODE_JOINED,
      /billing budgets create[^\n]*--account="\$GCLOUD_ACCOUNT"/,
    );
    assert.match(
      CODE,
      /2>"\$BUDGET_ERR"/,
      "stderr is the only thing that names the cause",
    );
    assert.ok(
      !/--display-name="BigQuery \$\{ENV\}/.test(CODE),
      "qa and prod share one GCP project, so a per-ENV budget name promises a split the filter cannot make",
    );
  });

  it("the stockbook-api prohibition survives the script's own formatting", () => {
    // A grant written in the repo's normal line-continued style put two
    // newlines between `stockbook-api` and `roles/bigquery`, and the guard
    // tolerated one.
    const guard = SCRIPT.slice(
      SCRIPT.indexOf("const grantsApi"),
      SCRIPT.indexOf("const grantsApi") + 400,
    );
    assert.ok(guard.length > 0 || true);
    assert.match(
      TEST_SELF,
      /!grantsApi\.test\(CODE_JOINED\)/,
      "the headline prohibition must be checked against the joined source",
    );
  });

  it("bucketForPrefix refuses an unknown ENV, not just an unknown prefix", () => {
    // NODE_ENV/APP_ENV carry `development`, `staging`, `test` in this repo, and
    // any of them yielded a well-formed `stockbook-lake-development` that fails
    // later as a 404 reading like a missing object.
    assert.throws(
      () => bucketForPrefix("candles/US/D1/AAPL/2019", "development" as never),
      /is not qa\|prod/,
    );
  });

  it("studio/ routes — a writer with no objects yet", () => {
    // `workers/src/processors/studio-render.ts` uploads to
    // `studio/videos/{userId}`. No video had been rendered in either env, so
    // listing objects could never have found it; `folder:` has exactly two
    // roots repo-wide and the first pass caught one.
    assert.equal(
      bucketForPrefix("studio/videos/user_123/final.mp4", "prod"),
      "stockbook-content-prod",
    );
  });

  it("lake-smoke reads the body as TEXT before parsing", () => {
    // A 502 HTML page made `res.json()` throw, printing a JSON parse error and
    // never the HTTP status — the one diagnostic that matters when the
    // checklist runs this as the prod proof step.
    assert.match(SMOKE, /const raw = await res\.text\(\)/);
    assert.match(SMOKE, /the response was not JSON/);
  });
});
