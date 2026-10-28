/**
 * MONEY-1514 / MONEY-1515 — the three lake jobs pin their environment from
 * `--env` instead of inheriting it, and `lake-load-databento` releases a claim
 * when a load fails.
 *
 * ## THE HAZARD THESE CASES EXIST FOR
 *
 * `packages/database/client.ts` builds its Prisma singleton at MODULE SCOPE
 * from `process.env.DATABASE_URL`. Three jobs imported it while their `--env`
 * flag steered only the BigQuery dataset, so `--env prod` from a shell carrying
 * the repo's QA `.env` read QA Mongo and wrote `lake_silver_prod` — silently.
 *
 * And the obvious fix does not work: calling `pinJobEnv` inside `main()` while
 * keeping the import leaves the connection resolving the OLD host, because the
 * import-time capture already happened. Probe-verified on the ticket. That
 * combination is strictly WORSE than the bug, because today an unset
 * `DATABASE_URL` at least fails closed.
 *
 * ## WHY ONE RUNTIME PROBE AND THEN SCANS
 *
 * `lake-load-databento`'s fix rests on a claim about the module GRAPH — that
 * `databento-repo` is the only door from its static imports to
 * `@usemoney/database`, so one dynamic import after the pin closes it. A source
 * scan cannot see a transitive import, so that claim is MEASURED: load every
 * other specifier the job imports and assert the database never arrives, then
 * load the repo and assert it does. If a future edit puts Prisma behind the
 * ledger or the storage client, the dynamic import silently stops helping and
 * this case goes red.
 *
 * The rest is what a scan CAN honestly assert: which import statements a file
 * carries, and whether a call site sits inside a handler. That is the same
 * shape `withDatabentoBudget`'s coverage uses, and for the same reason — the
 * decision is "is this call wrapped", not "which of two expressions is here".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { deployJobCalls } from "./deploy-job-calls";

// packages/core/__tests__/ops -> repo root
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/**
 * The file with its COMMENT LINES dropped.
 *
 * Load-bearing, not tidiness: these jobs DOCUMENT the defects they fixed, so a
 * prose mention of `process.env.LAKE_ENV = env` in a comment explaining why the
 * line is gone matches the same regex as the line itself. A scan that reads
 * prose asserts the opposite of what it says — the better the comment, the more
 * certainly it fails.
 *
 * LINE-ORIENTED, never a block-comment regex. Measured while writing this: the
 * loader's own refusal message contains the literal path glob
 * `databento/<star>/{schema}/`, whose slash-star opens a block comment that a
 * lazy regex then closes at the next star-slash — hundreds of lines later,
 * silently swallowing real code and making an assertion pass or fail for a
 * reason that has nothing to do with the job. Here a line whose first
 * non-space characters are a comment marker is dropped and nothing else is
 * touched, so no string literal can ever eat a statement.
 */
const code = (src: string): string =>
  src
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join("\n");

/** The three jobs MONEY-1514 names, read as text. */
const JOBS = {
  // MONEY-1514 review: both do the right thing today (pinJobEnv + explicit
  // `datasources`), but the guard that PINS that pattern could not see
  // them — a later edit reintroducing the singleton would pass.
  "lake-replay-us": readFileSync(
    join(ROOT, "scripts/jobs/lake-replay-us.ts"),
    "utf8",
  ),
  "corp-action-lake-sink": readFileSync(
    join(ROOT, "scripts/jobs/corp-action-lake-sink.ts"),
    "utf8",
  ),
  "event-lake-sink": readFileSync(
    join(ROOT, "scripts/jobs/event-lake-sink.ts"),
    "utf8",
  ),
  "filing-registry-sync": readFileSync(
    join(ROOT, "scripts/jobs/filing-registry-sync.ts"),
    "utf8",
  ),
  "lake-load-databento": readFileSync(
    join(ROOT, "scripts/jobs/lake-load-databento.ts"),
    "utf8",
  ),
  // MONEY-1523: READ-ONLY, but it compares two environments' data, so reading
  // Mongo from the ambient `.env` (QA) under `--env prod` produced a verdict
  // about the wrong pair of tables.
  "lake-parity-in": readFileSync(
    join(ROOT, "scripts/jobs/lake-parity-in.ts"),
    "utf8",
  ),
} as const;

/** The shape `identity-sync` established and MONEY-1514 propagates. */
const REFERENCE = readFileSync(
  join(ROOT, "scripts/jobs/identity-sync.ts"),
  "utf8",
);

describe("every extraction read something", () => {
  it("all four job files are non-trivial", () => {
    for (const [name, src] of Object.entries({
      ...JOBS,
      "identity-sync": REFERENCE,
    })) {
      assert.ok(
        src.length > 2_000,
        `${name} read ${src.length} bytes — the scans below would be vacuous`,
      );
      assert.match(src, /async function (main|run)\(/, `${name} has an entry`);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   MONEY-1514 — the import-time singleton
   ──────────────────────────────────────────────────────────────────────── */

describe("no lake job imports the import-time Prisma singleton", () => {
  for (const [name, src] of Object.entries(JOBS)) {
    const body = code(src);

    it(`${name} does not import @usemoney/database`, () => {
      assert.doesNotMatch(
        body,
        /from\s+"@usemoney\/database"/,
        `${name} must build its client from the URI --env resolves. The ` +
          `singleton captures DATABASE_URL at import, so a later pinJobEnv ` +
          `cannot repoint it — it only makes the mismatch silent.`,
      );
    });

    it(`${name} resolves its database URL from --env`, () => {
      assert.match(
        body,
        /pinJobEnv\(/,
        `${name} must call pinJobEnv, which resolves DATABASE_URL from Secret ` +
          `Manager for the requested environment`,
      );
    });

    it(`${name} has exactly ONE writer of LAKE_ENV`, () => {
      // MONEY-1515 #1: `pinJobEnv` already sets LAKE_ENV / LAKE_PROJECT /
      // GCP_PROJECT_ID. A surviving `process.env.LAKE_ENV = …` beside it is
      // one fact with two spellings, and the two can disagree.
      assert.doesNotMatch(
        body,
        /process\.env\.LAKE_ENV\s*=/,
        `${name} must not assign LAKE_ENV itself — pinJobEnv is the writer`,
      );
    });
  }

  // Every job that holds a client DIRECTLY. `lake-load-databento` reaches
  // Mongo through `databento-repo`, whose own singleton is correct once the
  // pin has run first — see the next describe.
  //
  // `lake-replay-us` and `corp-action-lake-sink` were added to the three
  // assertions above and NOT to this one — MONEY-1529. The comment on that
  // change advertised "pinJobEnv + explicit datasources" while this loop still
  // named two jobs, so reverting either of the new ones to a bare
  // `new PrismaClient()` passed all 45 cases. A bare client reads ambient
  // `DATABASE_URL`, which is the MONEY-1514 trap this file exists for — and a
  // comment asserting a guard that does not exist is worse than no comment,
  // because it stops the next reader looking.
  for (const name of [
    "event-lake-sink",
    "filing-registry-sync",
    "lake-replay-us",
    "corp-action-lake-sink",
    "lake-parity-in",
  ] as const) {
    it(`${name} passes the RESOLVED uri as an explicit datasource`, () => {
      // `pinJobEnv` also exports it through `process.env`, so a client built
      // without this would be back to reading an ambient variable — correct
      // today and one import-order change away from wrong.
      assert.match(
        code(JOBS[name]),
        /new PrismaClient\(\{\s*datasources:\s*\{\s*db:\s*\{\s*url:\s*databaseUrl\s*\}\s*\}\s*\}\)/,
      );
    });
  }

  it("identity-sync — the shape being propagated — still has it", () => {
    // A reference that has drifted makes every assertion above an assertion
    // about nothing in particular.
    assert.match(code(REFERENCE), /const \{ databaseUrl \} = pinJobEnv\(/);
    assert.doesNotMatch(code(REFERENCE), /from\s+"@usemoney\/database"/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   MONEY-1514 — lake-load-databento's indirect door, MEASURED
   ──────────────────────────────────────────────────────────────────────── */

describe("databento-repo is the only door to the Prisma singleton", () => {
  const require_ = createRequire(import.meta.url);
  const databaseLoaded = (): string[] =>
    Object.keys(require_.cache).filter((k) => /packages\/database\//.test(k));

  /**
   * Every specifier `lake-load-databento` still imports STATICALLY, as
   * relative paths into this package where it has one. The job's non-core
   * imports (`@usemoney/lake/*`, `@usemoney/storage`, `@usemoney/datadog/*`,
   * the worker telemetry helper) are listed by package specifier.
   */
  const STATIC_SPECIFIERS = [
    // MONEY-1514 review: the job imports this too, and the docstring above
    // claimed it was covered while the array omitted it — the one hole a source
    // scan cannot see, which is why this probe is a RUNTIME one.
    "../../../../workers/src/lib/job-telemetry",
    "../../src/ops/gcp-secrets",
    "../../src/ops/build-provenance",
    "../../src/ops/lake-layout",
    "../../src/market-data/databento/databento-logic",
    "../../src/market-data/databento/databento-stream",
    "../../src/market-data/databento/databento-symbology",
    "../../src/market-data/databento/databento-lake-logic",
    "../../src/market-data/databento/databento-spread-logic",
    "../../src/market-data/us-market-hours",
    "../../src/market-data/csv-line",
    "@usemoney/datadog/job-outcome",
    "@usemoney/datadog/metrics",
    "@usemoney/storage",
    "@usemoney/lake/ledger",
    "@usemoney/lake/ledger-logic",
    "@usemoney/lake/load",
    "@usemoney/lake/stage-logic",
  ];

  it("the job's whole STATIC graph loads without touching the database", () => {
    assert.deepEqual(
      databaseLoaded(),
      [],
      "the probe must start from a clean graph",
    );
    for (const spec of STATIC_SPECIFIERS) {
      require_(spec);
      assert.deepEqual(
        databaseLoaded(),
        [],
        `${spec} pulled @usemoney/database into the graph. The dynamic ` +
          `import in lake-load-databento then closes nothing: the singleton ` +
          `is built from the ambient DATABASE_URL before pinJobEnv runs.`,
      );
    }
  });

  it("…and loading databento-repo DOES pull it in", () => {
    // Without this the case above passes trivially on a job that never
    // touched Mongo at all, and the dynamic import reads as decoration.
    require_("../../src/market-data/databento/databento-repo");
    assert.ok(
      databaseLoaded().length > 0,
      "databento-repo is supposed to be the door — if it no longer is, the " +
        "dynamic import in lake-load-databento is guarding nothing and the " +
        "real door is somewhere else",
    );
  });

  it("lake-load-databento names the repo only in a TYPE or a dynamic import", () => {
    const src = JOBS["lake-load-databento"];
    for (const line of src.split("\n")) {
      if (!line.includes("databento-repo")) continue;
      if (!/^\s*(import|})/.test(line) && !line.includes("await import(")) {
        continue; // prose in a comment
      }
      assert.ok(
        line.includes("import type") || line.includes("await import("),
        `a VALUE import of databento-repo defeats the pin — the singleton ` +
          `would be built at module load. Offending line: ${line.trim()}`,
      );
    }
    // Both halves must actually be present, or the loop above iterates over
    // nothing and asserts nothing.
    assert.match(
      src,
      /import type \{ ArchivedVendorFile \} from "@usemoney\/core\/market-data\/databento\/databento-repo"/,
    );
    assert.match(
      src,
      /repo = await import\(\s*"@usemoney\/core\/market-data\/databento\/databento-repo"\s*\)/,
    );
  });

  it("the pin happens BEFORE the repo is loaded", () => {
    const src = JOBS["lake-load-databento"];
    const pin = src.indexOf("pinJobEnv(args.env)");
    const load = src.indexOf("repo = await import(");
    assert.ok(pin > 0 && load > 0, "both statements must exist");
    assert.ok(
      pin < load,
      "pinJobEnv must run first — a pin after the import is the exact " +
        "no-op the ticket probe measured",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   MONEY-1515 #2 — a failed load releases its claim
   ──────────────────────────────────────────────────────────────────────── */

describe("lake-load-databento rejects rather than stranding a claim", () => {
  const src = JOBS["lake-load-databento"];

  it("the loadNdjson call sits inside a try whose catch rejects and quarantines", () => {
    // `loadNdjson` throws LoadJobFailedError on `status.errorResult`, and
    // `run()`'s catch only does endRun(FAILED) and rethrows. The job claims
    // every month UP FRONT and CLAIM_LEASE_MS is six hours, so an unwrapped
    // throw stranded up to twelve months for six hours.
    const at = src.indexOf("await loadNdjson({");
    assert.ok(at > 0, "the call site must exist");

    const before = src.slice(0, at);
    const tryAt = before.lastIndexOf("try {");
    assert.ok(
      tryAt > 0 && !before.slice(tryAt).includes("}"),
      "loadNdjson must be the first statement of a try block",
    );

    // The handler, up to the end of the catch.
    const after = src.slice(at);
    const catchAt = after.indexOf("} catch (err) {");
    assert.ok(catchAt > 0, "the try must have a catch");
    const handler = after.slice(catchAt, after.indexOf("\n  }\n", catchAt));
    for (const call of ["rejectPartition(", "quarantine(", "return;"]) {
      assert.ok(
        handler.includes(call),
        `the catch must ${call} — every other anticipated failure in this ` +
          `job does, and without it the claim is held for its full lease`,
      );
    }
    assert.ok(
      handler.includes("monthsRejected++"),
      "the rejection must be counted, or the run exits 0 having lost a month",
    );
  });

  it("there is only ONE loadNdjson call site, so wrapping one covers them all", () => {
    assert.equal(
      src.split("await loadNdjson({").length - 1,
      1,
      "a second, unwrapped call site would reintroduce the whole defect",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   MONEY-1515 #3 — an empty plan refuses
   ──────────────────────────────────────────────────────────────────────── */

describe("lake-load-databento refuses a selection that plans nothing", () => {
  const src = JOBS["lake-load-databento"];

  it("planStages routes through assertPlannedMonths", () => {
    // Both modes share `planStages`, so the guard belongs there rather than
    // twice at the call sites — `loadBars` and `buildSpread` had the same hole.
    assert.match(src, /assertPlannedMonths\(result, \{/);
    assert.equal(
      src.split("planMonthPartitions(").length - 1,
      1,
      "a second planner call would bypass the refusal",
    );
  });

  it("both modes hand it the schema and year it has to name", () => {
    // A refusal that cannot name what the operator asked for is one nobody can
    // act on — and `--year` is the flag whose meaning the message corrects.
    const body = code(src);
    assert.equal(
      body.split("planStages({").length - 1,
      2,
      "loadBars and buildSpread are the two callers",
    );
    // Both blocks carry BOTH fields. Counting `year: args.year` across the
    // file instead would be brittle in a way that hides the real question:
    // `planStages` forwards the same pair on to `assertPlannedMonths`, so the
    // literal appears a third time there.
    //
    // loadBars passes the `--schema` it was given; buildSpread's coverage
    // denominator is always bbo-1m and never tbbo, so it names that one.
    assert.match(
      body,
      /planStages\(\{\n\s*files,\n\s*schema,\n\s*year: args\.year,\n/,
    );
    assert.match(
      body,
      /planStages\(\{\n\s*files: planned,\n\s*schema: "bbo-1m",\n\s*year: args\.year,\n/,
    );
  });
});

/**
 * MONEY-1609 — the replay jobs pin their READ bucket from `--env`.
 *
 * `getFileMetadata` / `downloadFile` take no bucket and read
 * `GCP_STORAGE_BUCKET`, and `.env` is QA — so `lake-replay-in --env prod` from
 * a dev shell read QA's archived bhavcopies while logging prod. The runtime
 * half asserts what the pinned value IS; the scan asserts the job sets it
 * before the first read, which is the only order in which it helps.
 */
describe("the replay jobs read the --env bucket, not the shell's", () => {
  const cases = [
    {
      job: "lake-replay-in",
      prefix: "feeds/",
      firstRead: "await replayMonth(",
    },
    {
      job: "lake-replay-us",
      prefix: "candles/",
      firstRead: "await replayPriceBars(",
    },
  ];
  for (const { job, prefix, firstRead } of cases) {
    it(`${job} pins GCP_STORAGE_BUCKET from ${prefix} before its first read`, () => {
      const body = code(
        readFileSync(join(ROOT, `scripts/jobs/${job}.ts`), "utf8"),
      );
      const main = body.slice(body.indexOf("async function main("));
      const pin = main.indexOf(
        `process.env.GCP_STORAGE_BUCKET = bucketForPrefix("${prefix}", args.env)`,
      );
      assert.ok(pin > 0, `${job} must pin GCP_STORAGE_BUCKET inside main()`);
      const read = main.indexOf(firstRead);
      assert.ok(
        read > pin,
        `${job} pins AFTER its first read (${read} < ${pin})`,
      );
    });
  }

  it("--env prod pins the PROD content bucket, --env qa the QA one", async () => {
    const { bucketForPrefix } = await import("../../src/ops/lake-layout");
    assert.equal(bucketForPrefix("feeds/", "prod"), "stockbook-content-prod");
    assert.equal(bucketForPrefix("feeds/", "qa"), "stockbook-content-qa");
    assert.equal(bucketForPrefix("candles/", "prod"), "stockbook-content-prod");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   MONEY-1609 — the Cloud Run jobs get what `pinJobEnv` needs, as lake-writer@
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Inside a Cloud Run job `databaseUrlForEnv` reads the MOUNTED `DATABASE_URL`
 * and THROWS without it — it deliberately does not fall back to gcloud, which
 * is not in the image. So a job that calls `pinJobEnv` and is deployed without
 * the mount dies on its first line, and one that never reads Mongo but gets the
 * mount holds a credential for nothing. Derived from each job's SOURCE, so a
 * job that starts pinning tomorrow goes red here until its deploy follows.
 *
 * And the identity: these jobs exist because `lake-writer-{env}@` holds the
 * BigQuery grants and `stockbook-api@` holds none. `googleCredentials()`
 * resolves `GCP_SERVICE_ACCOUNT_KEY_BASE64` BEFORE the runtime SA, so mounting
 * that key — as every sibling provisioner does — would silently turn every job
 * here back into stockbook-api@ (MONEY-783; measured again 2026-09-23 on
 * lake-load-databento, which died on its first DELETE).
 */
describe("setup-lake-jobs.sh mounts exactly what each job's --env pin needs", () => {
  const setup = readFileSync(
    join(ROOT, "scripts/ops/setup-lake-jobs.sh"),
    "utf8",
  );
  const calls = deployJobCalls(setup);
  const pins = (entry: string) =>
    /pinJobEnv\(/.test(
      code(readFileSync(join(ROOT, `scripts/jobs/${entry}.ts`), "utf8")),
    );

  it("PREMISE: both populations are non-empty, so the iff below is not vacuous", () => {
    const entries = calls.map((c) => c.entry!);
    assert.ok(
      calls.length >= 7,
      `resolved only ${calls.length} deploy_job calls`,
    );
    assert.ok(
      entries.filter(pins).length >= 4,
      "too few pinning jobs resolved",
    );
    assert.ok(
      entries.some((e) => !pins(e)),
      "no non-pinning job resolved",
    );
  });

  for (const call of calls) {
    it(`${call.entry} gets DATABASE_URL iff it calls pinJobEnv`, () => {
      const mounted = call.secrets.includes("DATABASE_URL=${DB_SECRET}:latest");
      assert.equal(
        mounted,
        pins(call.entry!),
        `${call.entry}: pinJobEnv ${pins(call.entry!) ? "is" : "is NOT"} called, ` +
          `and the effective --set-secrets is "${call.secrets}"`,
      );
    });
  }

  it("no job mounts the stockbook-api@ key, and every job runs as lake-writer", () => {
    const body = setup
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    assert.doesNotMatch(body, /GCP_SERVICE_ACCOUNT_KEY_BASE64/);
    assert.match(body, /JOB_SA="lake-writer-\$\{ENV\}@/);
    assert.match(body, /--service-account="\$JOB_SA"/);
    assert.equal(
      body.match(/--service-account=/g)?.length,
      1,
      "a second --service-account is a second identity nobody reviewed",
    );
  });
});

describe("inside Cloud Run, --env must match the job's own environment", () => {
  // Mutation: drop the suffix check in databaseUrlForEnv -> RED (the prod job
  // hands back prod's mounted URI for `--env qa`).
  const { databaseUrlForEnv } = createRequire(import.meta.url)(
    "../../src/ops/gcp-secrets",
  ) as typeof import("../../src/ops/gcp-secrets");
  const withEnv = (vars: Record<string, string>, fn: () => void): void => {
    const saved = {
      job: process.env.CLOUD_RUN_JOB,
      db: process.env.DATABASE_URL,
    };
    Object.assign(process.env, vars);
    try {
      fn();
    } finally {
      if (saved.job === undefined) delete process.env.CLOUD_RUN_JOB;
      else process.env.CLOUD_RUN_JOB = saved.job;
      if (saved.db === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved.db;
    }
  };

  it("refuses --env qa in a -prod job, naming the job to run instead", () => {
    withEnv(
      { CLOUD_RUN_JOB: "identity-sync-prod", DATABASE_URL: "mongodb://prod" },
      () => {
        assert.throws(
          () => databaseUrlForEnv("qa"),
          /Execute identity-sync-qa instead/,
        );
      },
    );
  });

  it("returns the mounted URI when the suffix agrees, or when a job has no env suffix", () => {
    withEnv(
      { CLOUD_RUN_JOB: "identity-sync-prod", DATABASE_URL: "mongodb://prod" },
      () => {
        assert.equal(databaseUrlForEnv("prod"), "mongodb://prod");
      },
    );
    withEnv(
      { CLOUD_RUN_JOB: "one-off-job", DATABASE_URL: "mongodb://x" },
      () => {
        assert.equal(databaseUrlForEnv("qa"), "mongodb://x");
      },
    );
  });
});
