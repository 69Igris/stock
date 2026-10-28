/**
 * MONEY-1373 — the Databento deploy contract.
 *
 * Every assertion here answers one question: would the thing that was built
 * actually RUN, and would it run DISARMED? The repo's own history is the
 * argument for asking in a test rather than in a review:
 *
 *   - MONEY-1214: `MF_METADATA_PROVIDER` was ABSENT rather than "false", so a
 *     job sat disabled for months and nothing said so. Both Databento flags
 *     therefore ship PRESENT-and-"false" in both specs, and BOTH directions are
 *     pinned — a silent ARM fails this suite as loudly as a silent disarm.
 *   - MONEY-1189: a fix sat un-executed on the nightly jobs after release,
 *     because Cloud Run JOBS pin their image at PROVISION time and deploying
 *     the SERVICE does not move them. So the re-pin loop must name both
 *     entrypoints.
 *   - MONEY-1115: a perfect engine with no clock attached writes nothing,
 *     forever, silently.
 *
 * Read as SOURCE, not as a running deployment. That is the ceiling of this
 * file and it is stated so nobody reads it as runtime proof: it asserts the
 * scripts and specs SAY the right thing. What is actually deployed is a
 * separate question the runbook answers with `gcloud run jobs describe`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/**
 * Source with its comments removed.
 *
 * A negative source scan that cannot tell code from prose punishes the one
 * thing this repo asks for: a comment that QUOTES the defect it replaced.
 * `// It was readFileSync(join(process.cwd(), …))` is the explanation, not the
 * bug, and an `includes()` over the raw file cannot see the difference.
 *
 * LINE FIRST, THEN BLOCK, and the order is the whole correctness of it —
 * MONEY-1143, which this repo has now fixed six times. A `//` comment that
 * CONTAINS a `/*` opens a phantom block running to the next `*` `/`, which can
 * be hundreds of lines away; stripping blocks first therefore deletes real
 * code, and every assertion below is an ABSENCE check that then passes because
 * the code is gone rather than because the wire is. Measured elsewhere in this
 * repo: 11,192 characters eaten from one file.
 *
 * This helper shipped in the wrong order and `apps/web`'s repo-wide guard
 * caught it — in a file whose comments quote code constantly, which is exactly
 * the population the phantom block feeds on.
 *
 * Deliberately crude otherwise — it is not a parser and does not need to be. A
 * `//` inside a string literal is over-stripped, which can only make an
 * assertion here weaker, never falsely red.
 */
/**
 * The `const request = { … };` literal a job hands to the budget guard.
 *
 * Sliced from the declaration to its closing `};` rather than to a named
 * anchor: the obvious anchor (`currentSymbolSetLabel =`) also appears at
 * module scope ABOVE the block, so `indexOf` found the earlier one and
 * returned an EMPTY slice — every assertion over it then passed against
 * nothing, which is the vacuous-scan shape this file has already been caught
 * by twice.
 */
function requestBlock(src: string): string {
  const start = src.indexOf("const request = {");
  if (start < 0) return "";
  const end = src.indexOf("\n    };", start);
  return end < 0 ? "" : src.slice(start, end);
}

const codeOf = (src: string): string =>
  src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const SETUP = read("scripts/ops/setup-databento-jobs.sh");
const RUNNER = read("scripts/ops/run-market-data-job.sh");
const SCHED = read("scripts/ops/setup-scheduler.sh");
const TSUP = read("workers/tsup.config.ts");
const CB_PROD = read("workers/cloudbuild.prod.yaml");
const CB_QA = read("workers/cloudbuild.qa.yaml");
const LIFECYCLE = read("scripts/ops/gcs-lifecycle.json");
const LIFECYCLE_SH = read("scripts/ops/setup-gcs-lifecycle.sh");
const SYNC = read("scripts/ops/sync-prod-to-qa.sh");
const HARVEST = read("scripts/jobs/databento-harvest.ts");
const APPEND = read("scripts/jobs/databento-append.ts");
const PROBE = read("scripts/data/databento-probe.ts");
const MANIFEST_RAW = read("scripts/data/databento-manifest.json");
const MANIFEST = JSON.parse(MANIFEST_RAW) as {
  dataset: string;
  historyFloor: string;
  entries: Array<{
    id: string;
    schema: string;
    order: number;
    load: boolean;
    append: boolean;
    dataset?: string;
    start: string;
    splitSymbols: boolean;
    splitDuration: string;
  }>;
};

const ENTRYPOINTS = ["databento-harvest", "databento-append"] as const;

/* ─────────────────────────────────────────────────────────────────────────
   1 · The clock and the command reach the code
   ──────────────────────────────────────────────────────────────────────── */

describe("both entry points are buildable and runnable", () => {
  it("each is a tsup ENTRY pointing at a file that exists", () => {
    // Without the entry there is no `dist/<name>.js`, and the Cloud Run job's
    // `--command=node,dist/databento-harvest.js` fails at container start with
    // "Cannot find module" — which reads as an infrastructure fault rather
    // than a missing build step.
    for (const name of ENTRYPOINTS) {
      assert.match(
        TSUP,
        new RegExp(`"${name}":\\s*"\\.\\./scripts/jobs/${name}\\.ts"`),
        `${name} is not a tsup entry`,
      );
      assert.doesNotThrow(
        () => read(`scripts/jobs/${name}.ts`),
        `scripts/jobs/${name}.ts does not exist`,
      );
    }
  });

  it("each reports its build provenance as the FIRST thing it does", () => {
    // A Cloud Run JOB pins its image at provision time, so this line is the
    // only runtime answer to "is the running job the code I pushed?".
    for (const [name, src] of [
      ["databento-harvest", HARVEST],
      ["databento-append", APPEND],
    ] as const) {
      assert.match(
        src,
        new RegExp(`reportBuildProvenance\\(\\s*log\\s*,\\s*"${name}"\\s*\\)`),
        `${name} does not report build provenance under its own name`,
      );
    }
  });

  it("the wrapper knows all three commands and points them at real files", () => {
    for (const [alias, script] of [
      ["dbharvest", "scripts/jobs/databento-harvest.ts"],
      ["dbappend", "scripts/jobs/databento-append.ts"],
      ["dbprobe", "scripts/data/databento-probe.ts"],
    ] as const) {
      assert.ok(
        RUNNER.includes(`${alias})`),
        `run-market-data-job.sh has no ${alias} case`,
      );
      assert.ok(
        RUNNER.includes(script),
        `${alias} does not point at ${script}`,
      );
      assert.doesNotThrow(() => read(script), `${script} does not exist`);
    }
  });

  it("both jobs are in BOTH cloudbuild re-pin loops", () => {
    // MONEY-1189. Deploying the workers SERVICE does not move a JOB's pinned
    // image; the re-pin loop is what does. A job missing from the loop keeps
    // running whatever it was provisioned with, indefinitely, with nothing
    // failing.
    for (const [label, spec] of [
      ["prod", CB_PROD],
      ["qa", CB_QA],
    ] as const) {
      for (const name of ENTRYPOINTS) {
        assert.ok(
          spec.includes(name),
          `${name} is not in the ${label} re-pin loop`,
        );
      }
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   1b · What the FIRST live probe found — MONEY-1373 phase 2
   ──────────────────────────────────────────────────────────────────────── */

describe("the manifest travels in the IMAGE, not in the working directory", () => {
  it("neither job reads it from process.cwd()", () => {
    // MEASURED: the workers runtime stage copies only `workers/dist`,
    // `workers/package.json` and the two node_modules trees, with
    // `WORKDIR /app/workers`. `join(process.cwd(), "scripts/data/…")` therefore
    // resolved to a path that does not exist in the image, and EVERY execution
    // — armed or not — died with ENOENT before its first free metadata call.
    for (const [name, src] of [
      ["databento-harvest", HARVEST],
      ["databento-append", APPEND],
    ] as const) {
      const code = codeOf(src);
      assert.ok(
        !code.includes("process.cwd()"),
        `${name} still resolves a path against the working directory`,
      );
      assert.ok(
        !code.includes("MANIFEST_PATH"),
        `${name} still reads the manifest off the filesystem`,
      );
    }
  });

  it("both IMPORT the manifest, so it is bundled with the job", () => {
    for (const [name, src] of [
      ["databento-harvest", HARVEST],
      ["databento-append", APPEND],
    ] as const) {
      assert.match(
        src,
        /import manifestJson from "\.\.\/data\/databento-manifest\.json"/,
        `${name} does not import the manifest`,
      );
      assert.match(
        src,
        /parseManifest\(manifestJson\)/,
        `${name} does not parse the imported manifest`,
      );
    }
  });

  it("the manifest file the import names actually exists", () => {
    // The import is relative to `scripts/jobs/`, so `../data/` is
    // `scripts/data/` — the file this suite already reads at the top.
    assert.ok(MANIFEST.entries.length > 0);
  });
});

describe("DATABENTO_ENV is read, not merely set", () => {
  it("both jobs resolve the env through resolveDatabentoEnv", () => {
    // `setup-databento-jobs.sh` sets DATABENTO_ENV on both jobs and NOTHING
    // read it: both derived the env from NODE_ENV, which the Dockerfile bakes
    // to "production" for BOTH environments (a JOB does not inherit the
    // SERVICE's env block). Every QA execution therefore stamped its ledger
    // rows `env: "prod"`, and the spend sum and the idempotent window lookup
    // are both env-scoped.
    for (const [name, src] of [
      ["databento-harvest", HARVEST],
      ["databento-append", APPEND],
    ] as const) {
      assert.match(
        src,
        /const ENV = resolveDatabentoEnv\(\)/,
        `${name} does not resolve its env through resolveDatabentoEnv`,
      );
      assert.ok(
        !/NODE_ENV.*production.*\?\s*"prod"/.test(codeOf(src)),
        `${name} still derives its env from NODE_ENV`,
      );
    }
  });

  it("the setup script still SETS what the jobs now read", () => {
    assert.ok(SETUP.includes("DATABENTO_ENV=${ENV}"));
  });
});

describe("every request end is clamped to the vendor's range", () => {
  it("the harvest reads a dataset range PER DATASET and threads it", () => {
    // The vendor's range end sits at UTC MIDNIGHT (measured
    // 2026-09-05T00:00:00Z) while our ET session end for the same session is
    // 4-5 h later, and any `end` past the range end is answered 422
    // `data_end_after_available_end`. `resolveEntryRange` has always applied
    // the clamp when given the value; nothing passed it.
    //
    // PER DATASET, because an entry may override the manifest's: EQUS.MINI
    // begins 2023-03-28 and EQUS.SUMMARY 2024-07-01, so one shared range would
    // clamp one dataset's window to another's end — the same 422, arrived at
    // from the other side.
    assert.match(HARVEST, /await loadVendorRange\(ds\)/);
    assert.match(
      HARVEST,
      /vendorRanges = new Map<string, DatabentoDatasetRange>/,
    );
    const passes = HARVEST.match(/datasetRangeEndMs:/g) ?? [];
    assert.ok(
      passes.length >= 2,
      `datasetRangeEndMs is passed at ${passes.length} call site(s); both ` +
        "resolveEntryRange calls (quote and coverage) need it",
    );
    assert.equal(
      (HARVEST.match(/resolveEntryRange\(/g) ?? []).length,
      passes.length,
      "every resolveEntryRange call must carry the clamp",
    );
  });

  it("the harvest LOGS the range end it is clamping to", () => {
    assert.match(HARVEST, /vendorRangeEnd=/);
  });

  it("every submission names the ENTRY's dataset, never the manifest's", () => {
    // A submission that hardcodes `manifest.dataset` for an entry that
    // overrode it buys the WRONG DATA under the right entry id, and records
    // the wrong provenance on a purchase that cannot be undone.
    for (const [name, src] of [
      ["databento-harvest", HARVEST],
      ["databento-append", APPEND],
    ] as const) {
      assert.match(
        src,
        /datasetForEntry\(entry, manifest\)/,
        `${name} does not resolve the entry's dataset`,
      );
      assert.ok(
        !/dataset: manifest\.dataset/.test(codeOf(src)),
        `${name} still submits the manifest's dataset directly`,
      );
    }
  });

  it("an override carries an explicit start — floors are per dataset", () => {
    // `historyFloor` is the MANIFEST dataset's floor. EQUS.SUMMARY begins
    // 2024-07-01 and EQUS.MINI 2023-03-28, so an override that inherited the
    // manifest floor is answered 422 data_start_before_available_start.
    for (const e of MANIFEST.entries) {
      if (e.dataset === undefined) continue;
      assert.notEqual(
        e.start,
        "historyFloor",
        `${e.id} overrides the dataset and still inherits the manifest floor`,
      );
    }
  });

  it("statistics is bought from a dataset that HAS it", () => {
    // MEASURED 2026-09-07 against the vendor: EQUS.MINI's schema list is
    // [mbp-1, tbbo, trades, bbo-1s, bbo-1m, ohlcv-1s/1m/1h/1d, definition] —
    // no `statistics`. The entry asking for it was answered 422
    // `dataset_schema_not_supported` on the first live prod dry run.
    const stats = MANIFEST.entries.find((e) => e.schema === "statistics");
    if (stats === undefined) return; // dropping the entry is a valid choice
    assert.notEqual(
      stats.dataset ?? MANIFEST.dataset,
      "EQUS.MINI",
      "EQUS.MINI does not carry the statistics schema",
    );
  });

  it("the probe clamps its own window before quoting", () => {
    assert.match(PROBE, /clamped to the vendor's range end/);
  });

  it("the probe asks symbology for end_date STRICTLY after start_date", () => {
    // Measured: the same day for both is a 422
    // (`data_date_range_start_on_or_after_end`).
    assert.match(PROBE, /86_400_000/);
    assert.ok(
      !/startDate: date,\s*\n\s*endDate: date,/.test(codeOf(PROBE)),
      "the probe still resolves symbology over a zero-width date range",
    );
  });
});

describe("the download resumes instead of re-buying", () => {
  it("stepDownload stamps each file as it lands", () => {
    // `ohlcv-1s-baseline` is ~850 daily files. A whole-array replace after the
    // loop persisted nothing until the row finished, so a task killed at file
    // 800 re-downloaded all 800 from a metered vendor.
    const step = HARVEST.slice(
      HARVEST.indexOf("async function stepDownload"),
      HARVEST.indexOf("function toRecord("),
    );
    assert.ok(step.length > 0, "stepDownload not found");
    assert.ok(
      step.includes("stampFileVerified("),
      "stepDownload does not stamp per file",
    );
    assert.ok(
      !codeOf(step).includes("record.verified = true"),
      "stepDownload still mutates the record in memory only",
    );
    assert.ok(
      step.includes("store.exists("),
      "stepDownload does not skip a file already in the archive",
    );
  });
});

describe("the expiry watch is not gated on the arm", () => {
  it("stepExpiry runs whenever this task is the leader", () => {
    // Files expire 30 days after SUBMISSION and the harvest has no cron, so a
    // clock watched only by an armed run is a clock nobody watches once the
    // buy is done.
    assert.match(HARVEST, /if \(leader\) await stepExpiry\(now\);/);
    assert.ok(
      !/apply && leader\) await stepExpiry/.test(codeOf(HARVEST)),
      "stepExpiry is still gated on --apply",
    );
  });
});

describe("the spend gauge outlives the harvest", () => {
  it("BOTH jobs emit spendUsd", () => {
    // The harvest retires once history lands. A gauge that stops renders as NO
    // DATA, which is indistinguishable from a month that spent nothing.
    for (const [name, src] of [
      ["databento-harvest", HARVEST],
      ["databento-append", APPEND],
    ] as const) {
      assert.match(
        src,
        /gauge\(DATABENTO_METRICS\.spendUsd,/,
        `${name} does not emit the spend gauge`,
      );
      assert.match(
        src,
        /sumMonthSpendUsd\(/,
        `${name} does not read the month's spend`,
      );
    }
  });

  it("the append emits it BEFORE flushing", () => {
    // `datadog-metrics` buffers; a point emitted after the flush is dropped
    // silently, which is the same NO DATA the gauge exists to prevent.
    assert.ok(
      APPEND.indexOf("gauge(DATABENTO_METRICS.spendUsd") <
        APPEND.indexOf("await flushMetrics()"),
      "the append emits its spend gauge after flushMetrics()",
    );
  });
});

describe("the tbbo trade leg is wired, not merely archived", () => {
  it("the append declares listTbboFiles", () => {
    // The manifest has bought `tbbo-top50` since the first harvest and NOTHING
    // read it: `effectiveSpreadBps` and `effectiveSampleCount` were null on
    // every cost-model row while the builder's header promised them.
    assert.match(APPEND, /listTbboFiles:/);
    assert.match(APPEND, /listArchivedFilesBySchema\(\s*"tbbo",/);
  });

  it("the window is anchored at the ARCHIVE, through the pure helper", () => {
    // A source scan cannot tell `archiveEnd` from `now` — they differ by one
    // identifier and by three months of silence — so the decision lives in
    // `tbboFoldWindow` and is tested there. This asserts the WIRING, and the
    // whole case rests on the exact-argument match below: a review found the
    // negative regex this replaced (`Date.now() … TBBO_FOLD_DAYS`) was
    // decoration, because `TBBO_FOLD_DAYS` is not imported into this file at
    // all and no plausible mutation could put the two on one line.
    assert.match(
      APPEND,
      /tbboFoldWindow\(await latestArchivedTbboEnd\(ENV\)\)/,
      "the fold window is not computed from the archive anchor",
    );
    // The window's own fields must reach the query unmodified. Reassigning
    // `window.to` after the call survives the match above, so the argument
    // positions are pinned too.
    assert.match(
      APPEND,
      /listArchivedFilesBySchema\(\s*"tbbo",\s*window\.from,\s*window\.to,\s*ENV,\s*\)/,
      "the anchored window is not what reaches the file query",
    );
    assert.ok(
      !/window\.(from|to)\s*=/.test(codeOf(APPEND)),
      "the anchored window is reassigned after it is computed",
    );
  });

  it("the manifest still carries the entry the leg folds", () => {
    const tbbo = MANIFEST.entries.find((e) => e.schema === "tbbo");
    assert.ok(tbbo !== undefined, "no tbbo entry in the manifest");
    // `append: false` is WHY the fold window is anchored at the archive: the
    // entry is bought once and never topped up.
    assert.equal(tbbo.append, false);
    assert.equal(tbbo.load, false, "tbbo is archive-only; it is not a candle");
  });
});

describe("the SPLIT SHAPE the manifest asks for reaches the vendor", () => {
  it("the harvest passes splitSymbols and splitDuration from the ENTRY", () => {
    // MEASURED on the first real harvest, 2026-09-08. The request carried
    // neither field, so `buildSubmitJobForm` fell back to `split_symbols:
    // false, split_duration: "day"` and the vendor confirmed receiving exactly
    // that — while the manifest said `true` / `"year"`.
    //
    // The loader is BUILT around one file being one symbol-year:
    // `DEFAULT_MAX_BUFFERED_ROWS_PER_SYMBOL` is 120,000 because a symbol-year
    // of M1 is 98,280 rows, so the buffer flushes once and writes ONE shard.
    // Daily files carrying every symbol flush 507 buffers per file into shards
    // that grow all year: 439,569 shard writes against 2,028, load time rising
    // 92 s -> 358 s over 124 files, extrapolating to 78 h against a 24 h cap.
    const req = requestBlock(HARVEST);
    assert.ok(req.length > 0, "the harvest request block was not found");
    assert.match(
      req,
      /splitSymbols: entry\.splitSymbols/,
      "the harvest does not pass the entry's splitSymbols",
    );
    assert.match(
      req,
      /splitDuration: entry\.splitDuration/,
      "the harvest does not pass the entry's splitDuration",
    );
  });

  it("the APPEND sets them deliberately, and NOT from the manifest", () => {
    // Not an oversight and not the same bug: an append window is ONE session,
    // so one file is one download, one checksum and one load. Splitting it
    // would multiply the bookkeeping for no benefit. The literal values are
    // the point — reading the manifest here would inherit a harvest-shaped
    // split for a session-shaped window.
    const req = requestBlock(APPEND);
    assert.ok(req.length > 0, "the append request block was not found");
    assert.match(req, /splitSymbols: false/);
    assert.match(req, /splitDuration: "none"/);
  });

  it("every LOADABLE entry asks for the shape the loader is sized for", () => {
    // A loadable entry that split by day would reproduce the defect above.
    // Archive-only entries are exempt: nothing buffers them per symbol.
    for (const e of MANIFEST.entries) {
      if (!e.load) continue;
      assert.equal(
        e.splitSymbols,
        true,
        `${e.id} is loadable but does not split by symbol`,
      );
      assert.ok(
        e.splitDuration === "year" || e.splitDuration === "none",
        `${e.id} splits by ${e.splitDuration}: a loadable entry must produce ` +
          "one file per symbol-year (or per symbol), or the loader rewrites " +
          "every growing cold shard once per file",
      );
    }
  });
});

describe("the load is newest-first", () => {
  it("orders pending files by session date, DESCENDING", () => {
    // A harvest is a backfill of years and it can be interrupted. Oldest-first
    // leaves the survivor holding 2023 and missing everything a backtest reads.
    const step = HARVEST.slice(
      HARVEST.indexOf("async function stepLoad"),
      HARVEST.indexOf("async function stepCoverage"),
    );
    assert.match(
      step,
      /fileSessionDate\(b\.filename\)[\s\S]{0,80}fileSessionDate\(a\.filename\)/,
      "stepLoad does not sort b-before-a; the load is not newest-first",
    );
  });
});

describe("smaller certain defects", () => {
  it("listJobs asks for the `received` state it knows how to map", () => {
    // A job the vendor had accepted but not yet queued was invisible to every
    // summary, so stepPoll never advanced it and burned --max-wait-min.
    assert.match(HARVEST, /states: \["received", "queued"/);
  });

  it("an unknown vendor state is WARNED about, not silently polled", () => {
    const fn = HARVEST.slice(
      HARVEST.indexOf("function mapVendorState"),
      HARVEST.indexOf("/** Pull the full record"),
    );
    assert.ok(fn.includes("log.warn("), "mapVendorState maps silently");
  });

  it("the coverage aggregation is leader-only", () => {
    assert.match(HARVEST, /if \(leader && wants\("coverage"\)\)/);
  });

  it("the failure verdict counts the units it attempted", () => {
    // `attempted` is chunks plus files; `totals.errors` also carries per-job
    // and per-row failures, so a run whose every chunk and file succeeded
    // could be judged failed — and `succeeded` could go negative.
    assert.match(
      HARVEST,
      /const unitsFailed = totals\.chunksFailed \+ totals\.filesFailed;/,
    );
    assert.ok(
      !/failed: totals\.errors,/.test(
        codeOf(HARVEST.slice(HARVEST.indexOf("judgeBackfillOutcome({"))),
      ),
      "the verdict still counts every error against a unit denominator",
    );
  });

  it("sharding is refused with --step=all", () => {
    // The first three steps are leader-only, so tasks 1..N-1 reach the load
    // before anything is downloaded and exit 0 having done nothing.
    assert.match(HARVEST, /sharding applies to --step=load only/);
    assert.ok(SETUP.includes("--step=load"));
  });

  it("the append lists a job's files ONCE per row", () => {
    const fn = APPEND.slice(
      APPEND.indexOf("async function downloadAndLoad"),
      APPEND.indexOf("async function maybeRebuildCostModel"),
    );
    assert.ok(fn.length > 0, "downloadAndLoad not found");
    assert.equal(
      (codeOf(fn).match(/await listFiles\(/g) ?? []).length,
      1,
      "downloadAndLoad still calls batch.list_files more than once per row",
    );
  });

  it("the 4Gi rationale does not name a format we never decode", () => {
    // The transfer is CSV+zstd; there is no DBN decoder in this repo.
    assert.ok(
      !SETUP.includes("It holds a DBN decode buffer"),
      "the 4Gi rationale still claims a DBN decode buffer",
    );
    assert.ok(SETUP.includes("DEFAULT_MAX_BUFFERED_ROWS_PER_SYMBOL"));
  });

  it("the setup banner agrees with the scheduler about the append", () => {
    // It read "No Scheduler trigger, ever"; setup-scheduler.sh provisions two
    // append triggers and the append's own header says so.
    assert.ok(!SETUP.includes("No Scheduler trigger, ever"));
    assert.ok(SETUP.includes("databento-append-daily-prod"));
    assert.ok(SCHED.includes("databento-append-daily"));
  });

  it("the setup banner does not document a flag the job would reject", () => {
    assert.ok(
      !SETUP.includes("--symbols=AAPL,MSFT"),
      "the ARGV example still uses --symbols, which is not a harvest flag",
    );
  });

  it("stepLoad counts the files it attempted", () => {
    // `judgeBackfillOutcome` divides `filesFailed` by `filesConsidered`, and
    // only `stepDownload` incremented the denominator — so `--step=load`, the
    // ONLY legal sharded invocation, ran with `attempted === 0`, took the
    // judge's early return, and exited 0 reporting a healthy run even when
    // every file in the shard failed.
    const step = HARVEST.slice(
      HARVEST.indexOf("async function stepLoad"),
      HARVEST.indexOf("async function stepCoverage"),
    );
    assert.ok(step.length > 0, "stepLoad not found");
    assert.ok(
      step.includes("totals.filesConsidered++"),
      "stepLoad does not count the files it attempts",
    );
  });

  it("a resumed file is not counted as a metered download", () => {
    assert.match(HARVEST, /totals\.filesResumed\+\+/);
  });

  it("the archive shortcut refuses a record that already FAILED", () => {
    // `downloadToArchive` writes to GCS BEFORE it digests, and its cleanup
    // delete on a checksum mismatch is `.catch(() => {})` — so a corrupt
    // object can outlive the failure. Adopting it on `exists()` alone would
    // promote a file that failed its checksum to `verified` and load it.
    assert.match(
      HARVEST,
      /record\.detail === undefined && \(await store\.exists\(/,
      "the exists() shortcut is not gated on a clean record",
    );
  });

  it("the probe resolves its env through the shared validator", () => {
    assert.match(PROBE, /env: resolveDatabentoEnv\(\)/);
    assert.ok(
      !/process\.env\["DATABENTO_ENV"\]/.test(codeOf(PROBE)),
      "the probe still reads DATABENTO_ENV unvalidated",
    );
  });

  it("the local runner's bucket follows the env", () => {
    // `dbprobe qa --apply` archived into the PROD bucket.
    assert.ok(
      !RUNNER.includes('REGION_BUCKET="stockbook-content-prod"'),
      "the runner still hardcodes the prod bucket for every env",
    );
    assert.ok(RUNNER.includes("stockbook-content-qa"), "no qa bucket");
    // THE CALL SITE, not the definition. Asserting the helper merely EXISTS
    // passes against a version that defines it and never calls it — which is
    // the "wired at one of five legs" hole (MONEY-1309) in miniature.
    assert.match(
      RUNNER,
      /GCP_STORAGE_BUCKET="\$\(bucket_for_env "\$env"\)"/,
      "GCP_STORAGE_BUCKET is not resolved through bucket_for_env",
    );
  });

  it("POLL_TIMEOUT can actually reach the outcome line", () => {
    // It is set AFTER an entry has planned sessions and submitted, so a gate
    // of `sessionsPlanned === 0` made the one skip meaning "the vendor is
    // still working" unreachable — and a run that waited out --max-wait-min
    // and wrote nothing carried no reason at all.
    assert.match(APPEND, /totals\.rowsWritten === 0 && skips\.size > 0/);
    assert.ok(
      !/totals\.sessionsPlanned === 0 && skips\.size > 0/.test(codeOf(APPEND)),
      "the skip reason is still gated on sessionsPlanned",
    );
    assert.ok(APPEND.includes('skips.set(entry.id, "POLL_TIMEOUT")'));
  });

  it("the probe declares no flag it does not read", () => {
    // A bare flag that parses, reports success and changes nothing is the
    // TIINGO_RT_BOATS shape: flipping it looks like it worked.
    const declared = /bare:\s*\[([^\]]*)\]/.exec(codeOf(PROBE))?.[1] ?? "";
    for (const raw of declared.split(",")) {
      const flag = raw.trim().replace(/^["']|["']$/g, "");
      if (flag === "") continue;
      assert.ok(
        codeOf(PROBE).includes(`ARGS.has("${flag}")`) ||
          codeOf(PROBE).includes(`ARGS.flag("${flag}")`),
        `the probe declares --${flag} and never reads it`,
      );
    }
  });

  it("the local runner exports the key the probe authenticates with", () => {
    assert.ok(RUNNER.includes("DATABENTO_API_KEY_$("));
    assert.ok(RUNNER.includes('DATABENTO_API_KEY="${db_key}"'));
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   2 · Both flags, both specs, both directions
   ──────────────────────────────────────────────────────────────────────── */

describe("the arms ship PRESENT — harvest true, append false", () => {
  const FLAGS = ["DATABENTO_HARVEST_APPLY", "DATABENTO_APPEND_APPLY"] as const;

  it("the harvest arm DEFAULTS to true and the append arm to false, as LITERAL strings", () => {
    // PRESENT, not absent. Absent and explicitly-set must not be the same
    // state — that is how MF_METADATA_PROVIDER disabled its job silently for
    // months (MONEY-1214).
    //
    // The env block interpolates `${harvest_arm}` / `${append_arm}` rather
    // than hardcoding a value, because `--set-env-vars` REPLACES the block and
    // every re-provision was silently disarming a job the runbook had just
    // told the operator to arm. So the property lives in the two shell
    // variables' INITIALISERS.
    //
    // FOUNDER DECISION 2026-09-08: the HARVEST initialises to true. It is
    // safe to ship armed because the env flag is one of two keys — the job
    // buys nothing without `--apply --entry=<id>` on the command line as
    // well — whereas the APPEND is a standing schedule with no human on the
    // trigger, so its initialiser stays false and may only become true by
    // reading the deployed job.
    assert.match(
      SETUP,
      /local harvest_arm="true" append_arm="false"/,
      "the harvest must default to true and the append to false",
    );
    for (const flag of FLAGS) {
      assert.match(
        SETUP,
        new RegExp(`${flag}=\\$\\{(harvest|append)_arm\\}`),
        `${flag} is not driven by the carried-forward arm variable`,
      );
    }
    // Beyond that initialiser, the ONLY way either becomes true is the
    // live-state read — the append in particular must never be armed by a
    // default anywhere else. The initialiser is asserted above and exempted.
    const trueAssignments = [
      ...SETUP.matchAll(/^\s*(?:local\s+)?(harvest_arm|append_arm)="true"/gm),
    ].filter((m) => !/^\s*local harvest_arm="true"$/.test(m[0]));
    for (const m of trueAssignments) {
      const at = m.index ?? 0;
      const context = SETUP.slice(Math.max(0, at - 400), at);
      assert.match(
        context,
        /live_env|run jobs describe/,
        `${m[1]} is set true outside the live-state read: ${m[0].trim()}`,
      );
    }
    // And --disarm forces both back.
    assert.match(SETUP, /if \[ "\$DISARM" != true \]/);
  });

  it("NEITHER is shipped true in any DEPLOYED env block", () => {
    // The other direction, and the one a disarm-only assertion would miss. A
    // silent ARM is worse than a silent disarm: it spends money.
    //
    // Scoped to `--set-env-vars=` / `--update-env-vars=` values that a script
    // actually EXECUTES. The setup script's banner prints the arming command
    // for an operator to copy, which is documentation and must stay — so a
    // whole-file grep for `=true` would fail on the very text that tells a
    // human how to arm deliberately.
    const executed = (src: string): string[] => {
      // Drop heredoc BODIES. `cat <<EOF ... EOF` is text the script PRINTS,
      // and stripping it by marker is the only way to tell a command from a
      // banner that quotes one. Shell comments go too.
      const out: string[] = [];
      let inHeredoc = false;
      for (const line of src.split("\n")) {
        if (!inHeredoc && /<<-?\s*'?[A-Z_]+'?\s*$/.test(line)) {
          inHeredoc = true;
          continue;
        }
        if (inHeredoc) {
          if (/^\s*[A-Z_]+\s*$/.test(line)) inHeredoc = false;
          continue;
        }
        if (/^\s*#/.test(line)) continue;
        if (/--(set|update)-env-vars=/.test(line)) out.push(line);
      }
      return out;
    };
    // PREMISE, in the same test so it cannot drift from it: the stripper must
    // still find the REAL env block. A filter that matched nothing would make
    // every assertion below pass over an empty list — the vacuous-guard shape
    // this repo has been caught by before.
    const setupLines = executed(SETUP);
    assert.ok(
      setupLines.some((l) =>
        l.includes("DATABENTO_HARVEST_APPLY=${harvest_arm}"),
      ),
      `the deployed env block was stripped away; found:\n${setupLines.join("\n")}`,
    );

    for (const [label, src] of [
      ["setup-databento-jobs.sh", SETUP],
      ["cloudbuild.prod.yaml", CB_PROD],
      ["cloudbuild.qa.yaml", CB_QA],
      ["setup-scheduler.sh", SCHED],
    ] as const) {
      for (const line of executed(src)) {
        for (const flag of FLAGS) {
          // A LITERAL true in a deployed block. `${harvest_arm}` is not a
          // literal — it is the carried-forward live value, guarded above.
          assert.ok(
            !line.includes(`${flag}=true`),
            `${label} deploys ${flag}=true: ${line.trim()}`,
          );
        }
      }
    }
  });

  it("PREMISE: the arming instruction IS in the banner, for a human", () => {
    // Guards the assertion above from being scoped into vacuity. If the
    // banner's copy-paste arming command ever disappears, an operator has no
    // documented way to arm and would invent one — likely `--set-env-vars`,
    // which REPLACES the whole block and would drop DATABASE_URL.
    assert.match(SETUP, /--update-env-vars=DATABENTO_HARVEST_APPLY=true/);
    assert.match(SETUP, /--update-env-vars=DATABENTO_APPEND_APPLY=true/);
    assert.match(
      SETUP,
      /--update-env-vars/,
      "the banner must teach --update-env-vars, never --set-env-vars",
    );
  });

  it("both jobs compare the flag to the LITERAL string, never Boolean()", () => {
    // `Boolean("false")` is true, which would arm the job in the one
    // configuration meant to keep it off.
    const LOGIC = read(
      "packages/core/src/market-data/databento/databento-harvest-logic.ts",
    );
    assert.match(LOGIC, /env\["DATABENTO_HARVEST_APPLY"\] === "true"/);
    assert.match(LOGIC, /env\["DATABENTO_APPEND_APPLY"\] === "true"/);
    assert.doesNotMatch(
      LOGIC,
      /Boolean\(\s*env\[/,
      "the arm is read through a coercion",
    );
  });

  it("neither job reads the arm at MODULE scope", () => {
    // A module-level read freezes at import, and on a warm Cloud Run container
    // that turns a redeployed switch into no switch at all. Both call
    // `isHarvestArmed()` / `isAppendArmed()` inside `main()`.
    for (const [name, src] of [
      ["databento-harvest", HARVEST],
      ["databento-append", APPEND],
    ] as const) {
      // ASSERT THE PROPERTY, not one spelling. The old regex matched a bare
      // `const X = process.env["DATABENTO_..."]` and nothing else — so
      // `const ARMED = isHarvestArmed();` at module scope, which is the
      // NATURAL way to write the bug, was invisible. So were `let`, dot
      // notation, and any read through a helper.
      //
      // The real property is that the arm is resolved INSIDE `main()`, after
      // the process has started, so a redeployed switch is seen on a warm
      // container.
      const mainAt = src.indexOf("async function main(");
      assert.ok(mainAt > 0, `${name} has no main()`);
      for (const call of ["isHarvestArmed(", "isAppendArmed("]) {
        let from = 0;
        for (;;) {
          const at = src.indexOf(call, from);
          if (at === -1) break;
          // The import line and the declaration itself are not call sites.
          const line = src.slice(
            src.lastIndexOf("\n", at) + 1,
            src.indexOf("\n", at),
          );
          if (!/^\s*(import|export|\*|\/\/)/.test(line)) {
            assert.ok(
              at > mainAt,
              `${name} resolves the arm at module scope (${line.trim()}); a ` +
                "module-level read freezes at import and turns a redeployed " +
                "switch into no switch at all on a warm container",
            );
          }
          from = at + call.length;
        }
      }
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   3 · The scope guard on the harvest
   ──────────────────────────────────────────────────────────────────────── */

describe("--apply without --entry cannot walk the whole manifest", () => {
  it("the job refuses it and exits 1", () => {
    // The last entry is the TB-scale 1s archive. A bare apply would reach it
    // in the same 24-hour execution as everything else.
    assert.match(HARVEST, /apply && ENTRIES\.length === 0/);
    assert.match(HARVEST, /--apply requires at least one --entry/);
    assert.match(HARVEST, /process\.exitCode = 1/);
  });

  it("the WRAPPER refuses it too, so the guard is not one deep", () => {
    // The `xbrl` rule. A wrapper-side check fails before the container starts,
    // which is the difference between a wasted second and a wasted execution.
    const at = RUNNER.indexOf('if [ "$JOB" = "dbharvest" ]');
    assert.ok(at > 0, "run-market-data-job.sh has no dbharvest scope guard");
    assert.match(RUNNER.slice(at, at + 2000), /--entry=/);
  });

  it("there is NO scheduler trigger for the harvest", () => {
    // A cron would be a standing authorisation to spend against a
    // subscription that is meant to be cancelled once the harvest completes.
    assert.doesNotMatch(SCHED, /databento-harvest-(daily|retry|weekly)/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   4 · The append's clock
   ──────────────────────────────────────────────────────────────────────── */

describe("the append is scheduled, prod-only, and after the embargo", () => {
  it("both triggers exist with the T+1 crons", () => {
    // 15:00 IST = 09:30 UTC, after the ~09:00 UTC release. Tue-Sat because a
    // US session closing 16:00 ET lands after midnight IST.
    assert.match(SCHED, /DATABENTO_APPEND_SCHEDULE_PRIMARY="0 15 \* \* 2-6"/);
    assert.match(SCHED, /DATABENTO_APPEND_SCHEDULE_RETRY="0 18 \* \* 2-6"/);
  });

  it("the crons are NOT the pre-embargo 13:00 slot", () => {
    // 13:00 IST is 07:30 UTC, before the release. It would ask for a session
    // that does not exist and get an empty result — indistinguishable from a
    // market holiday.
    for (const cron of ["0 13 * * 2-6", "0 13 * * *"]) {
      assert.doesNotMatch(
        SCHED,
        new RegExp(
          `DATABENTO_APPEND_SCHEDULE_\\w+="${cron.replace(/[*]/g, "\\*")}"`,
        ),
        `the append is scheduled at ${cron}, before the T+1 embargo lifts`,
      );
    }
  });

  it("the setup function is actually CALLED", () => {
    // MONEY-1115: a perfect engine with no clock attached writes nothing,
    // forever, silently. Declaring `setup_databento_schedulers` is not the
    // same as invoking it.
    assert.match(SCHED, /^setup_databento_schedulers\(\)/m);
    assert.match(SCHED, /^\s+setup_databento_schedulers "\$ENV"/m);
  });

  it("both triggers are PROD_ONLY", () => {
    // Databento is a paid metered vendor and QA receives both tables by copy,
    // so a QA trigger would spend real money to produce rows the next restore
    // deletes.
    const block = SCHED.slice(
      SCHED.indexOf("PROD_ONLY_JOBS=("),
      SCHED.indexOf("\n)", SCHED.indexOf("PROD_ONLY_JOBS=(")),
    );
    assert.ok(block.length > 100, "PROD_ONLY_JOBS block not found");
    for (const t of ["databento-append-daily", "databento-append-retry"]) {
      assert.ok(block.includes(`"${t}"`), `${t} is not PROD_ONLY`);
    }
  });

  it("the append reads the dataset range BEFORE it computes a gap", () => {
    // The cron is the cheap half of the embargo guard; this is the other half.
    // Without it a vendor running late produces an empty purchase instead of a
    // named NOT_YET_PUBLISHED skip.
    const rangeAt = APPEND.indexOf("getDatasetRange(");
    const gapAt = APPEND.indexOf("computeAppendGap(");
    assert.ok(rangeAt > 0 && gapAt > 0, "one of the two calls is missing");
    assert.ok(
      rangeAt < gapAt,
      "computeAppendGap runs before getDatasetRange, so the gap is unclamped",
    );
    // TEXTUAL POSITION IS NOT EXECUTION ORDER, and on its own this case was
    // decorative: moving the gap computation above the range read AND feeding
    // it null passed the whole suite, while making the append return
    // NOT_YET_PUBLISHED on every entry forever. The occurrence of
    // `getDatasetRange(` sits inside the `datasetRangeOnce` helper near the
    // top of the file and cannot move.
    //
    // So assert the VALUE property too: a range read that succeeded and
    // produced no usable bound must THROW rather than fall through to a skip
    // reason that reads as a late vendor.
    assert.match(APPEND, /rangeReadOk/);
    assert.match(
      APPEND,
      /rangeReadOk && !Number\.isFinite\(rangeEndMs\)/,
      "a successful range read with no usable end is not refused",
    );
  });
});

describe("sharding partitions the LOAD and nothing else", () => {
  it("stepDownload takes no shard at all", () => {
    // The first version ran on the leader AND filtered by shard, so a
    // four-task execution downloaded one quarter of the files and never
    // fetched the rest — while reporting success. Downloading is a whole-JOB
    // operation; only the load has a partitionable unit.
    assert.match(HARVEST, /async function stepDownload\(\): Promise<void>/);
    assert.match(HARVEST, /await stepDownload\(\)/);
  });

  it("stepLoad DOES shard, so the capability is not merely removed", () => {
    // The premise. Without it the assertion above passes on a build that
    // deleted sharding entirely, which is a different (and much slower) thing
    // from fixing it.
    assert.match(
      HARVEST,
      /async function stepLoad\(shard: ShardSpec \| null\)/,
    );
    assert.match(HARVEST, /shardOwns\(r\.filename, shard\)/);
  });

  it("REFUSES a sharded load using the shape the ROW was BOUGHT with", () => {
    // `shardOwns` hashes the FILENAME, which partitions the FILES. That equals
    // partitioning the WRITES only when one file maps to one cold shard — i.e.
    // when the vendor split by symbol. Under a day-split job every file carries
    // every symbol, so two tasks read-merge-write the same shard and one task's
    // rows are lost while both report success.
    //
    // THE SOURCE OF THE SHAPE IS THE WHOLE FINDING. This guard first read the
    // MANIFEST, which says what the entry would be bought as TODAY — and the
    // one job in existence that is day-split belongs to an entry whose manifest
    // was since corrected to `splitSymbols: true`. So the check answered
    // "symbol-split" about the exact job it was written to refuse. It must read
    // the row.
    const load = HARVEST.slice(
      HARVEST.indexOf("async function stepLoad("),
      HARVEST.indexOf("let listingIndexCache"),
    );
    assert.ok(load.length > 0, "stepLoad body not located");
    assert.match(load, /if \(shard !== null && row\.splitSymbols !== true\)/);
    // The row must actually be SELECTED, or the field is undefined and the
    // guard refuses everything instead of the right things.
    assert.match(load, /splitSymbols: true,/);
    // And it must NOT have gone back to the manifest.
    assert.doesNotMatch(load, /entriesById/);

    const guard = load.slice(load.indexOf("if (shard !== null"));
    assert.match(guard.slice(0, 1200), /continue;/);
    assert.match(guard.slice(0, 1200), /totals\.shardRefusals\+\+/);
  });

  it("a run that REFUSED every row cannot exit 0", () => {
    // `judgeBackfillOutcome` divides failures by units ATTEMPTED, and a
    // `--step=load` execution that refuses every row attempts neither a chunk
    // nor a file — so the judge takes its `attempted === 0` early return and
    // hands back exitCode 0. `gcloud run jobs execute --wait` then prints a
    // green result for a task that loaded nothing.
    //
    // The previous version of this test asserted only `totals.errors++`, with a
    // comment claiming that stopped the run exiting 0. It did not: that counter
    // reaches the job-outcome report and never `process.exitCode`. The
    // assertion pinned a counter whose effect it had asserted backwards.
    assert.match(
      HARVEST,
      /if \(totals\.shardRefusals > 0\) \{[\s\S]{0,400}?process\.exitCode = 1;/,
    );
  });

  it("the download step is a BOUNDED POOL, not a serial loop", () => {
    // ~1.5 s per file, essentially all of it waiting on the vendor and on GCS.
    // Serially that is 23.4 h for `ohlcv-1h-master`'s 56,220 files, which does
    // not fit inside the job's own 24 h task cap — the step could not finish
    // however long it was left alone.
    const dl = HARVEST.slice(
      HARVEST.indexOf("async function stepDownload("),
      HARVEST.indexOf("function toRecord("),
    );
    assert.ok(dl.length > 0, "stepDownload body not located");
    assert.match(
      dl,
      /await mapWithConcurrency\(records, DOWNLOAD_CONCURRENCY,/,
    );
    // The serial loop it replaced must be GONE, not merely bypassed.
    assert.doesNotMatch(dl, /for \(const record of records\)/);
  });

  it("the sharded load stamps files ATOMICALLY, never a whole-array write", () => {
    // Every shard reads the same `files` JSON. A read-modify-write of the
    // whole array is last-writer-wins, so three quarters of a four-task load
    // would vanish with every task reporting success. The loadable manifest
    // entries carry splitSymbols with a yearly split, so a 503-symbol
    // three-year job really does produce ~1,500 files.
    const at = HARVEST.indexOf("async function stepLoad(");
    assert.ok(at > 0, "stepLoad not found");
    const body = HARVEST.slice(
      at,
      HARVEST.indexOf("\nlet listingIndexCache", at),
    );
    assert.match(body, /stampFileLoaded\(/);
    assert.doesNotMatch(
      body,
      /files: records as unknown as object\[\]/,
      "the sharded load writes the whole files array back",
    );
    assert.match(body, /advanceJobStateIfComplete\(/);
  });

  it("a load failure is PERSISTED, not mutated in memory", () => {
    // Once the load stopped writing the whole `files` array back, an in-memory
    // `record.verified = false` was discarded — so a file whose archive object
    // is missing would be re-attempted every night, forever, with the reason
    // recorded nowhere. Found by re-reading the diff, not by a failing test.
    const at = HARVEST.indexOf("async function stepLoad(");
    const body = HARVEST.slice(
      at,
      HARVEST.indexOf("\nlet listingIndexCache", at),
    );
    const missingAt = body.indexOf("archive object absent at load time");
    assert.ok(missingAt > 0, "the missing-object branch is gone");
    const branch = body.slice(missingAt - 400, missingAt + 400);
    assert.match(branch, /stampFileVerified\(/);
    assert.doesNotMatch(
      branch,
      /record\.verified\s*=/,
      "the branch mutates the record in memory, which is now discarded",
    );
  });

  it("the state transition RE-READS rather than trusting one task", () => {
    const REPO = read(
      "packages/core/src/market-data/databento/databento-repo.ts",
    );
    const at = REPO.indexOf("export async function advanceJobStateIfComplete");
    assert.ok(at > 0, "advanceJobStateIfComplete not found");
    // To the NEXT export, not to the first `\n}` — the function body contains
    // nested closing braces, so the short slice ended before the read.
    const nextExport = REPO.indexOf("\nexport ", at + 1);
    const body = REPO.slice(at, nextExport === -1 ? REPO.length : nextExport);
    assert.match(body, /findUnique/, "it does not re-read the row");
    assert.match(body, /readFileRecords\(row\.files\)/);
  });

  it("the positional operator is used, not an index", () => {
    // `files.$.loadedAt` matches the element the query found. A numeric index
    // would be computed from a stale read and stamp somebody else's file.
    const REPO = read(
      "packages/core/src/market-data/databento/databento-repo.ts",
    );
    assert.match(REPO, /"files\.\$\.loadedAt"/);
    assert.match(REPO, /"files\.\$\.verified"/);

    // THE FILTER MUST PIN THE FILENAME. Changing it to `{$exists: true}` makes
    // the positional `$` stamp the FIRST array element — "somebody else's
    // file", the outcome this case names — and the two assertions above still
    // match. Measured: that mutation survived the whole suite.
    for (const fn of ["stampFileLoaded", "stampFileVerified"]) {
      const at = REPO.indexOf(`export async function ${fn}`);
      assert.ok(at > 0, `${fn} not found`);
      const next = REPO.indexOf("\nexport ", at + 1);
      const body = REPO.slice(at, next === -1 ? REPO.length : next);
      assert.match(
        body,
        /"files\.filename":\s*args\.filename/,
        `${fn} does not pin the positional match to the filename`,
      );
      assert.doesNotMatch(
        body,
        /"files\.filename":\s*\{/,
        `${fn} matches the file with an operator instead of an equality`,
      );
    }

    // AND `stampFileVerified` MUST RECORD WHAT IT WAS TOLD. Hardcoding
    // `verified: true` — so a download that FAILED verification is recorded as
    // verified — also survived, because the caller-side case asserts only that
    // the branch calls the function.
    const vAt = REPO.indexOf("export async function stampFileVerified");
    const vBody = REPO.slice(vAt, REPO.indexOf("\nexport ", vAt + 1));
    assert.match(
      vBody,
      /"files\.\$\.verified":\s*args\.verified/,
      "stampFileVerified writes a literal instead of the argument",
    );
    assert.doesNotMatch(
      REPO,
      /"files\.\d+\./,
      "a hardcoded array index is used — it would be computed from a stale " +
        "read and stamp somebody else's file",
    );
  });
});

describe("the append's high-water mark cannot skip a lagging chunk", () => {
  it("it is the MINIMUM across chunks, not the maximum", () => {
    // A symbol set above 2,000 names splits into several jobs sharing an
    // entryId and differing by symbolsHash — `ohlcv-1h-master` is many chunks.
    // Taking the max lets one chunk's success speak for all of them: chunk A
    // reaches session D, chunk B fails, the mark reads D, the next run starts
    // after D, and chunk B is permanently short of that session with nothing
    // to reveal it.
    const at = APPEND.indexOf("async function readHighWaterMark");
    assert.ok(at > 0, "readHighWaterMark not found");
    const body = APPEND.slice(at, APPEND.indexOf("\n/*", at));
    assert.match(body, /symbolsHash/, "the mark ignores the chunk identity");
    assert.doesNotMatch(
      body,
      /orderBy:\s*\{\s*end:\s*"desc"\s*\}/,
      "the mark is still the single furthest row",
    );
    // WHICH mark it picks is asserted in `databento-append-logic.test.ts`, on
    // the pure `highWaterMarkFromChunks`. It was inlined here for one commit
    // and a source scan could not distinguish `marks[0]` from
    // `marks[marks.length - 1]` — two opposite policies that read almost
    // identically, and the mutation proving it survived is why the selection
    // moved out of the script.
    assert.match(body, /highWaterMarkFromChunks\(/);
  });

  it("only TERMINAL states count toward it", () => {
    // A window that was bought but never loaded is spend, not coverage.
    const at = APPEND.indexOf("async function readHighWaterMark");
    const body = APPEND.slice(at, APPEND.indexOf("\n/*", at));
    // WHICH states is now a decision with its own unit test
    // (`terminalStatesFor` in databento-append-logic.test.ts). Forbidding two
    // literals here could not see `"QUOTED"` being added — a row written
    // BEFORE anything is bought — and that mutation survived the whole suite.
    // This asserts only what a source scan can prove: that the query
    // DELEGATES rather than spelling the set inline.
    assert.match(body, /terminalStatesFor\(entry\)/);
    assert.doesNotMatch(body, /"SUBMITTED"/);
    assert.doesNotMatch(body, /"DONE"/);
    assert.doesNotMatch(body, /"QUOTED"/);
  });

  it("the dataset range is read ONCE per run", () => {
    // Three entries would otherwise make three calls that could straddle a
    // release and return different `end` values, so two entries would compute
    // their gaps against different beliefs about what exists.
    assert.match(APPEND, /function datasetRangeOnce\(/);
    assert.match(APPEND, /datasetRangeCache \?\?=/);
    const direct = [...APPEND.matchAll(/[^a-zA-Z]getDatasetRange\(/g)];
    assert.equal(
      direct.length,
      1,
      `getDatasetRange is called directly ${direct.length} times; it should be reached only through datasetRangeOnce`,
    );
  });
});

describe("a stale QUOTED/FAILED row is re-armed, not re-inserted", () => {
  it("the ledger's createQuotedJob UPDATES the row the guard names", () => {
    // MONEY-1539. WHEN to take a row over is the guard's decision and has a
    // unit test (databento-budget.test.ts); this pins only that the ledger
    // acts on it. An insert beside the stale row violates the window's
    // @@unique — 7 same-day retries died on exactly that on prod.
    const REPO = read(
      "packages/core/src/market-data/databento/databento-repo.ts",
    );
    const at = REPO.indexOf("async createQuotedJob(");
    assert.ok(at > 0, "createQuotedJob not found");
    const body = REPO.slice(at, REPO.indexOf("async markSubmitted(", at));
    assert.match(
      body,
      /if \(spec\.reclaimRowId !== null\) \{\s*return prisma\.databentoBatchJob\.update\(\{\s*where: \{ id: spec\.reclaimRowId \}/,
    );
  });
});

describe("the archive-orphan check runs where a job actually runs", () => {
  it("the nightly append calls it after the purchases, and it compares", () => {
    // MONEY-1540. The rule lives in `archiveJobsWithoutLedgerRow` and has its
    // own unit test; this pins only that the job that runs twice a day on
    // prod reaches it — a check nothing calls reports nothing, for ever.
    const main = APPEND.slice(APPEND.indexOf("async function main("));
    const call = main.indexOf("await reportArchiveOrphans(archiveReady)");
    assert.ok(call > 0, "main() does not run the archive-orphan check");
    assert.ok(
      call > main.indexOf("for (const entry of candidates)"),
      "the orphan check runs before the purchases — a two-minute listing " +
        "must not be able to delay one",
    );
    const at = APPEND.indexOf("async function reportArchiveOrphans(");
    const body = APPEND.slice(at, APPEND.indexOf("\n}\n", at));
    assert.match(body, /archiveJobsWithoutLedgerRow\(/);
    assert.match(body, /streamObjectSummaries\(DATABENTO_ARCHIVE_PREFIX\)/);
  });
});

describe("the cost model has a trigger attached", () => {
  it("the append CALLS the builder, not just imports it", () => {
    // MONEY-1115: a perfect engine with no clock attached writes nothing,
    // forever, silently. The builder shipped for one commit behind a flag that
    // logged "not wired yet"; an import-only assertion would have passed then.
    assert.match(APPEND, /buildCostModel\(/);
    assert.match(APPEND, /shouldRebuildCostModel\(/);
    assert.match(APPEND, /await maybeRebuildCostModel\(/);
  });

  it("a failed rebuild does NOT fail the append", () => {
    // The bars are the product. The cost model is derived from bytes already
    // bought and archived, so it can be rebuilt tomorrow at no vendor cost —
    // letting it take the run down would turn a recoverable derived-data
    // problem into a gap in the price series.
    const at = APPEND.indexOf("async function maybeRebuildCostModel");
    assert.ok(at > 0, "maybeRebuildCostModel not found");
    const body = APPEND.slice(at, APPEND.indexOf("\n}", at));
    assert.match(body, /catch \(err\)/);
    const catchBody = body.slice(body.indexOf("catch (err)"));
    // BOTH ROUTES. Forbidding only `throw` left `process.exitCode = 1` in the
    // same catch, which fails the job just as thoroughly — a mutation sweep
    // proved it survived.
    assert.doesNotMatch(
      catchBody,
      /\bthrow\b/,
      "the cost-model catch re-throws, which would fail the whole append",
    );
    assert.doesNotMatch(
      catchBody,
      /process\.exitCode/,
      "the cost-model catch sets process.exitCode, which fails the run as " +
        "surely as a throw — the bars are the product and the model is " +
        "rebuildable tomorrow at no vendor cost",
    );
  });

  it("the two Mongo collection names have ONE declaration", () => {
    // The quant engine is Python and spells them as strings that nothing
    // type-checks. Two consumers hardcoding one name is how a collection ends
    // up read under a name nothing writes.
    const TYPES = read("packages/types/src/us-cost-model.ts");
    assert.match(TYPES, /versions: "us_cost_model_versions"/);
    assert.match(TYPES, /rows: "us_cost_model_rows"/);
    const SCHEMA = read("packages/database/prisma/schema.prisma");
    assert.match(SCHEMA, /@@map\("us_cost_model_versions"\)/);
    assert.match(SCHEMA, /@@map\("us_cost_model_rows"\)/);
  });

  it("both collections reach QA by copy", () => {
    for (const c of ["us_cost_model_versions", "us_cost_model_rows"]) {
      assert.ok(SYNC.includes(`"${c}"`), `${c} is not synced prod -> QA`);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   5 · Storage, hosts, collections
   ──────────────────────────────────────────────────────────────────────── */

describe("the archive prefix is protected", () => {
  it("databento/ has a SetStorageClass rule and NEVER a Delete", () => {
    // These bytes are the only copy of data bought once. Deleting them turns a
    // re-load into a re-purchase of a $199 Standard month.
    const parsed = JSON.parse(LIFECYCLE) as {
      rule: Array<{
        action: { type: string };
        condition: { matchesPrefix?: string[] };
      }>;
    };
    assert.ok(
      Array.isArray(parsed.rule) && parsed.rule.length > 0,
      "gcs-lifecycle.json has no `rule` array — the shape changed",
    );
    const ours = parsed.rule.filter((r) =>
      (r.condition.matchesPrefix ?? []).some((p) => p.startsWith("databento/")),
    );
    assert.ok(ours.length > 0, "no lifecycle rule matches databento/");
    for (const rule of ours) {
      assert.notEqual(
        rule.action.type,
        "Delete",
        "a Delete rule under databento/ would turn a re-load into a re-purchase",
      );
    }
    assert.ok(
      ours.some((r) => r.action.type === "SetStorageClass"),
      "databento/ has no Nearline transition",
    );
  });

  it("databento/ is on BOTH the allow-list and the protected roots", () => {
    for (const marker of ["ALLOW_PREFIXES", "PROTECTED_ROOTS"]) {
      const at = LIFECYCLE_SH.indexOf(marker);
      assert.ok(at > 0, `${marker} not found`);
      const block = LIFECYCLE_SH.slice(at, LIFECYCLE_SH.indexOf("\n)", at));
      assert.ok(
        block.includes('"databento/"'),
        `databento/ is missing from ${marker}`,
      );
    }
  });

  it("the inventory table is synced prod -> QA", () => {
    // QA never spends at Databento, so it must RECEIVE both the ledger and the
    // bars rather than reproduce them.
    assert.match(SYNC, /"databento_batch_jobs"/);
    assert.match(SYNC, /"candles"/);
  });

  it("both vendor hosts are declared feed hosts", () => {
    // Listing only the gateway would leave `api.databento.com` — the host that
    // moves the actual gigabytes — unguarded.
    const GUARD = read(
      "packages/core/__tests__/market-data/no-feed-fetch-bypass.test.ts",
    );
    const at = GUARD.indexOf("const FEED_HOSTS");
    const block = GUARD.slice(at, GUARD.indexOf("\n];", at));
    for (const host of ["hist.databento.com", "api.databento.com"]) {
      assert.ok(block.includes(`"${host}"`), `${host} is not in FEED_HOSTS`);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   6 · The manifest the jobs read
   ──────────────────────────────────────────────────────────────────────── */

describe("the manifest agrees with the code that consumes it", () => {
  it("PREMISE: it parses and holds entries", () => {
    // Without this every assertion below iterates an empty list.
    assert.ok(
      MANIFEST.entries.length >= 5,
      `${MANIFEST.entries.length} entries`,
    );
  });

  it("the 1s archive is LAST and is never loaded", () => {
    // It is the TB-scale one and the founder decision is archive-only. If it
    // were not last, a walk that reached it early would exhaust an execution
    // before the cheap entries ran.
    const ordered = [...MANIFEST.entries].sort((a, b) => a.order - b.order);
    const oneSecond = ordered.filter((e) => e.schema === "ohlcv-1s");
    assert.equal(oneSecond.length, 1, "expected exactly one ohlcv-1s entry");
    assert.equal(
      ordered[ordered.length - 1]!.id,
      oneSecond[0]!.id,
      "the ohlcv-1s archive is not the last entry in submit order",
    );
    assert.equal(oneSecond[0]!.load, false, "ohlcv-1s must not be loaded");
  });

  it("only bar-producing schemas are marked load:true", () => {
    // bbo-1m and tbbo are quote/trade records the cost model reads from the
    // archive. Loading them into `candles` would put quote-derived rows beside
    // trade-derived ones under one timeframe.
    for (const e of MANIFEST.entries) {
      if (!e.load) continue;
      assert.ok(
        ["ohlcv-1m", "ohlcv-1h"].includes(e.schema),
        `${e.id} is load:true on schema ${e.schema}`,
      );
    }
  });

  it("at least one entry is appendable, or the daily job is a no-op forever", () => {
    const appendable = MANIFEST.entries.filter((e) => e.append);
    assert.ok(
      appendable.length > 0,
      "no manifest entry has append:true, so databento-append can never do work",
    );
  });

  it("the history floor is not before what the dataset holds", () => {
    assert.ok(
      MANIFEST.historyFloor >= "2023-03-28",
      `historyFloor ${MANIFEST.historyFloor} predates EQUS.MINI's history`,
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   7 · The probe cannot be automated
   ──────────────────────────────────────────────────────────────────────── */

describe("the probe is interactive by construction", () => {
  it("it refuses a non-TTY and has no --yes", () => {
    // A prompt a wrapper can answer is not a safeguard, and
    // run-market-data-job.sh is exactly such a wrapper.
    assert.match(PROBE, /process\.stdin\.isTTY/);
    assert.doesNotMatch(PROBE, /"yes"\s*\]/, "the probe accepts a --yes flag");
    assert.doesNotMatch(PROBE, /bare:\s*\[[^\]]*"yes"/);
  });

  it("it REFUSES a quote over the cap rather than narrowing the window", () => {
    // A narrowed probe measures something nobody asked about and reports
    // success.
    assert.match(PROBE, /PROBE_MAX_USD/);
    assert.match(PROBE, /Refusing rather than narrowing the/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   8 · The vendor listing is fetched once per job, and the runbook says how to
        run the two-execution entry
   ──────────────────────────────────────────────────────────────────────── */

describe("the file listing is memoised as a PROMISE, not as an array", () => {
  const code = codeOf(HARVEST);

  it("findVendorFile routes through memoisedListFiles", () => {
    // The download step is an 8-wide pool. A cache holding the RESOLVED array
    // is still empty when the first 8 tasks look, so all 8 call
    // `batch.list_files` for the same job — the concurrency that fixed the
    // download made the listing 8x worse, silently and at vendor cost.
    assert.match(
      code,
      /async function findVendorFile\([\s\S]{0,300}?memoisedListFiles\(\s*fileCache/,
      "findVendorFile does not go through memoisedListFiles",
    );
    assert.doesNotMatch(
      code,
      /async function findVendorFile\([\s\S]{0,300}?await listFiles\(/,
      "findVendorFile still calls listFiles directly",
    );
  });

  it("fileCache is typed with a Promise, which is what makes it collapse", () => {
    // The type IS the mechanism: `Map<string, DatabentoFile[]>` cannot hold an
    // in-flight call, so it can only ever be filled after the first await.
    assert.match(
      code,
      /const fileCache = new Map<string,\s*Promise</,
      "fileCache stores resolved arrays, so concurrent misses each fetch",
    );
  });

  it("the first-sight branch primes the SAME cache", () => {
    // Otherwise the inventory listing and the first per-file lookup are two
    // calls for one job — the whole-array replace fetches, then the pool
    // fetches again because nothing was cached.
    assert.match(
      code,
      /records = \(await memoisedListFiles\(fileCache, jobId, listFiles\)\)/,
      "the first-sight branch fetches outside the cache",
    );
  });
});

describe("the runbook carries the ohlcv-1h-master two-execution recipe", () => {
  // A doc-drift guard, not a style check. `--step` runs ONE stage
  // (`wants()` is `STEP === "all" || STEP === step`), and `--tasks` is REFUSED
  // with `--step=all` — so the only way to shard the 8 h load is a second
  // execution, and an operator who does not know that either runs it
  // unsharded or gets a throw they cannot explain.
  const RUNBOOK = read("docs/reference/databento-harvest-runbook.md");
  const recipe = (): string => {
    const start = RUNBOOK.indexOf("### `ohlcv-1h-master` takes TWO executions");
    assert.ok(start >= 0, "the two-execution recipe section is gone");
    const end = RUNBOOK.indexOf("\n### ", start + 1);
    return RUNBOOK.slice(start, end < 0 ? RUNBOOK.length : end);
  };

  it("names both executions for the entry, in ONE block", () => {
    // Matched against the `--args=` LINE, not against the section text. A bare
    // /--tasks=4/ over the block passed with the flag deleted from the command,
    // because the prose two paragraphs up explains why `--step=load --tasks=4`
    // must not be a prefix — measured while mutation-checking this case.
    const block = recipe();
    assert.match(block, /--args=--apply,--entry=ohlcv-1h-master,--step=all\b/);
    assert.match(
      block,
      /--args=--apply,--entry=ohlcv-1h-master,--step=load --tasks=4\b/,
      "the load execution does not shard — the recipe is one 8 h task",
    );
  });

  it("states that --tasks throws with --step=all", () => {
    // The reason the recipe is two executions rather than one. Without this
    // sentence the split reads as a preference.
    assert.match(recipe(), /`--tasks=N` with `--step=all` throws/);
  });
});
