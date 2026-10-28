/**
 * The doc-ingest backfill job is provisioned correctly, and counts honestly —
 * MONEY-1314.
 *
 * Two artifacts, one suite, because the defects they guard against are the same
 * defects wearing different clothes:
 *
 *   scripts/ops/setup-doc-ingest-backfill-job.sh   what Cloud Run is TOLD
 *   scripts/jobs/doc-ingest-backfill.ts            what the run REPORTS
 *
 * ## Why the assertions read SOURCE
 *
 * There is no other observable. The shell script's entire output is a gcloud
 * invocation, and gcloud is exactly what must not be run from a test; a mock of
 * it would assert only that the mock was written correctly. The job's counters
 * are equally unobservable without a database, a bucket and a metered model
 * quota. What CAN be asserted from the bytes is the STRUCTURE that makes the
 * defect impossible, and each of the properties below is one this repo has
 * already been bitten by:
 *
 *   - Cloud Run JOBS pin their image at PROVISION time and a deploy of the
 *     SERVICE does not move them. `feed-parse-prod` ran nightly on a 10-day-old
 *     image, exited 0, reported SUCCEEDED_COUNT 1 and skipped four bond feed
 *     families it had never heard of (MONEY-1205; MONEY-1189 one ticket
 *     earlier). The only thing standing between that and a permanently stale
 *     backfill is that this script re-reads the live service's image every time.
 *
 *   - Peak RSS during PDF conversion is 2.3-4.8x FILE SIZE, measured across 26
 *     real filings, worst observed 618 MB for a 129.81 MB PDF. 109 archive
 *     objects exceed 40 MB. A 512 MiB task is OOM-killed mid-page, which is the
 *     one failure the job cannot report on itself — the summary line dies with
 *     it.
 *
 *   - A job spec does NOT inherit the service's env block. An unset
 *     `GCP_STORAGE_BUCKET` is a 6-hour run that reads nothing; an unset
 *     `GOOGLE_GENAI_API_KEY` is a batch that is never submitted.
 *
 *   - A counter incremented BEFORE the call it counts reports a full-looking
 *     number for a source that fails every request. That is how Tickertape's
 *     403 hid for five months (`stock-document-sync` bumped each per-source
 *     counter before the fetch), and it is why this job may only move a write
 *     counter inside one helper, after the awaited operation resolves.
 *
 *   - `--apply` swallowed by a wrapper is how `feed-repair` read 41,924 rows,
 *     wrote nothing and exited 0. A fail-SAFE default became a fail-SILENT run.
 *
 * Pure `readFileSync`. No subprocess, no timer, nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolved from THIS FILE, not from `process.cwd()`.
 *
 * The house idiom is `join(process.cwd(), "..", "..")`, which is correct under
 * `yarn workspace @usemoney/core test` and wrong under a bare
 * `npx tsx --test <path>` from the repo root — where it silently resolves to a
 * directory two levels ABOVE the repo, every `readFileSync` throws, and the
 * suite fails for a reason that has nothing to do with what it tests.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..", "..");

const OPS_DIR = join(ROOT, "scripts", "ops");
const JOBS_DIR = join(ROOT, "scripts", "jobs");
const OWNER_NAME = "setup-doc-ingest-backfill-job.sh";
const OWNER = join(OPS_DIR, OWNER_NAME);
const JOB_SOURCE = join(JOBS_DIR, "doc-ingest-backfill.ts");
const TSUP = join(ROOT, "workers", "tsup.config.ts");

const ownerSrc = readFileSync(OWNER, "utf8");
const jobSrc = readFileSync(JOB_SOURCE, "utf8");
const tsupSrc = readFileSync(TSUP, "utf8");

const opsScripts = readdirSync(OPS_DIR)
  .filter((f) => f.endsWith(".sh"))
  .sort();

/**
 * Drop whole-line `#` comments, keeping line numbering intact.
 *
 * Load-bearing: this script's header DISCUSSES `--apply`, `DD_VERSION` and
 * `:latest` at length, precisely because each is a trap. Prose that names a
 * flag is not a use of it, and a guard that cannot tell those apart is one that
 * gets deleted the first time it fires on a comment.
 *
 * Only leading-`#` lines: a `#` inside a quoted value is not worth the
 * quote-tracking, and dropping the trailing half of a real line would make this
 * blind to actual config.
 */
function stripShellComments(src: string): string {
  return src
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? "" : line))
    .join("\n");
}

const ownerCode = stripShellComments(ownerSrc);

/**
 * The value this script PROVISIONS for env var `name`, or null.
 *
 * "Provisions" means the assignment appears inside a `--set-env-vars="…"`
 * argument of the deploy call, in the EXECUTED half of the file. A `#` comment
 * naming the same `--set-env-vars=…,NAME=${VALUE}` string is NOT a provision,
 * and this script's header discusses the whole env line at length — so a
 * `src.includes()` or a bare `assert.match(src, /NAME=/)` reports the variable
 * present after the deploy line has been commented out. Measured: commenting
 * the real line and leaving the comment above it left BOTH the assertion and
 * its "control" green while the job went out without the variable.
 *
 * An EMPTY value comes back as `""` — falsy on purpose. `NAME=` inside the
 * list provisions nothing, and the converter would read its 1024 MiB default
 * exactly as if the variable were absent.
 */
function provisionsEnvVar(src: string, name: string): string | null {
  for (const m of stripShellComments(src).matchAll(
    /--set-env-vars="([^"]*)"/g,
  )) {
    for (const pair of m[1]!.split(",")) {
      const eq = pair.indexOf("=");
      if (eq > 0 && pair.slice(0, eq) === name) return pair.slice(eq + 1);
    }
  }
  return null;
}

/**
 * Whole-line `//` and `*` comment lines dropped, numbering intact.
 *
 * The job's own docstrings QUOTE the selectors they must not hand-roll — the
 * `scannedPageCount: { isSet: false }` cursor is explained in prose twice —
 * and a scan that cannot tell prose from a query would fire on the
 * explanation of the rule rather than on a breach of it.
 */
function stripTsComments(src: string): string {
  return src
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line))
    .join("\n");
}

const jobCode = stripTsComments(jobSrc);

/**
 * Backslash continuations folded away, so a scan sees whole COMMANDS.
 *
 * Both best-effort reads in this script span four lines with `|| true` on the
 * last one, so a line-by-line scan finds a bare `|| true)` with no verb on it
 * and cannot tell a tolerated DESCRIBE from a tolerated DELETE.
 */
function logicalLines(src: string): string[] {
  return src.replace(/\\\n\s*/g, " ").split("\n");
}

/**
 * The EXECUTED half of the script, i.e. everything before the trailing
 * heredoc's operator-facing runbook.
 *
 * The heredoc prints example `gcloud run jobs execute --args="…,--apply,…"`
 * lines. Those are documentation, not this script's own argument handling, and
 * a scan that cannot separate them would report that the script "handles
 * --apply" when it deliberately does not.
 */
const HEREDOC_AT = ownerCode.indexOf("cat <<EOF");
const ownerExecuted =
  HEREDOC_AT > 0 ? ownerCode.slice(0, HEREDOC_AT) : ownerCode;

/** Entry points tsup bundles into `workers/dist/`, derived not listed. */
const tsupJobEntries = (() => {
  const start = tsupSrc.indexOf("entry: {");
  const end = tsupSrc.indexOf("}", start);
  const block = tsupSrc.slice(start, end);
  const out = new Set<string>();
  for (const m of block.matchAll(
    /"?([\w-]+)"?\s*:\s*"(?:\.\.\/scripts\/(?:jobs|data)\/[\w-]+\.ts|src\/[\w/.-]+)"/g,
  )) {
    out.add(m[1]!);
  }
  return out;
})();

// ---------------------------------------------------------------------------

describe("the suite reads what it reasons over (MONEY-1314)", () => {
  it("loads both artifacts — a silent zero here would prove nothing", () => {
    // This suite's own failure mode is matching nothing and passing, which
    // would restore exactly the blind spots it closes.
    assert.ok(
      ownerSrc.length > 5_000,
      `${OWNER_NAME} did not read (got ${ownerSrc.length} bytes)`,
    );
    assert.ok(
      jobSrc.length > 10_000,
      `doc-ingest-backfill.ts did not read (got ${jobSrc.length} bytes)`,
    );
    assert.ok(
      opsScripts.length >= 10,
      `found only ${opsScripts.length} .sh files under scripts/ops`,
    );
    assert.ok(
      tsupJobEntries.size >= 4,
      `parsed only ${tsupJobEntries.size} entry points from tsup.config.ts`,
    );
    assert.ok(
      HEREDOC_AT > 0,
      "could not find the trailing heredoc — the executed/printed split " +
        "below would silently degrade to 'the whole file'",
    );
  });
});

describe("MONEY-1339 — parallel tasks and per-slot memory", () => {
  const src = readFileSync(OWNER, "utf8");

  it("provisions four parallel tasks by default", () => {
    assert.match(src, /^TASKS="4"$/m);
    assert.match(src, /^CONCURRENCY="4"$/m);
  });

  it("passes BOTH --tasks and --parallelism", () => {
    // `--tasks` without `--parallelism` queues the shards behind each other and
    // gives back exactly the wall-clock this change buys.
    assert.match(src, /--tasks="\$TASKS"/);
    assert.match(src, /--parallelism="\$TASKS"/);
  });

  it("asks for 2 vCPU, which Cloud Run REQUIRES above 4Gi", () => {
    assert.match(
      src,
      /--cpu=2/,
      "Cloud Run refuses a task over 4Gi with fewer than 2 vCPU, so the " +
        "deploy would fail — or worse, an operator would drop the memory to " +
        "make it pass",
    );
    assert.doesNotMatch(src, /--cpu=1\b/);
  });

  it("REFUSES more tasks than the 36-character shard alphabet", () => {
    // Past the alphabet a task gets an empty prefix set, selects nothing, and
    // reports `selected=0 remaining=0` — a drained queue's exact signature.
    assert.match(src, /-gt 36/);
  });

  it("refuses a slot ceiling too small to hold a real document", () => {
    assert.match(src, /SLOT_MI" -lt 512/);
  });
});

describe("the job is pinned to the SERVICE's CURRENT image (MONEY-1205)", () => {
  it("resolves the image from the live stockbook-workers-{env} service", () => {
    assert.match(
      ownerCode,
      /SERVICE_NAME="stockbook-workers-\$\{ENV\}"/,
      "the image source must be the per-env workers SERVICE — the deployed " +
        "services are stockbook-workers-prod / -qa, never a bare name",
    );
    assert.match(
      ownerCode,
      /run services describe "\$SERVICE_NAME"/,
      "the image must be READ from the live service at setup time. Anything " +
        "else pins a tag chosen when the script was written, which is the " +
        "MONEY-1205 bug with the drift baked in from day one",
    );
    assert.match(
      ownerCode,
      /spec\.template\.spec\.containers\[0\]\.image/,
      "must read the container image field off the service description",
    );
  });

  it("hands that resolved value — not a literal — to the deploy", () => {
    assert.match(
      ownerCode,
      /--image="\$IMAGE"/,
      "the deploy must pass the RESOLVED $IMAGE variable",
    );
    // A hardcoded registry path is the tempting "fix" when a resolution fails
    // once. It pins the job to a tag forever and every later release misses it.
    assert.doesNotMatch(
      ownerCode,
      /--image=(?!"?\$)[^\s\\]*(gcr\.io|docker\.pkg\.dev)/,
      "--image= must never be a hardcoded registry path",
    );
    // `:latest` is worse than a stale pin: it LOOKS current while Cloud Run
    // resolves it to a digest once, at deploy time.
    assert.doesNotMatch(
      ownerCode,
      /--image=[^\s\\]*:latest/,
      "--image=…:latest is not a pin",
    );
  });

  it("FAILS CLOSED when the image cannot be resolved", () => {
    // An empty IMAGE must never reach gcloud. A deploy without --image is read
    // as "keep the existing image", which on a re-provision silently preserves
    // the stale pin this script exists to move — a fail-open default in the one
    // place that must not have one.
    assert.match(
      ownerCode,
      /if \[ -z "\$IMAGE" \][\s\S]{0,500}?exit 1/,
      "an unresolved image must abort with exit 1, not fall through to a " +
        "deploy that omits --image",
    );
  });

  it("PRINTS what it pinned, so the operator can verify it", () => {
    // The pin is only checkable if it is stated. The job's own
    // [build-provenance] line reports the commit it is RUNNING; this is the
    // other side of that comparison. Checked against ECHO lines specifically:
    // a bare "does the string appear anywhere" test passes on `--image="$IMAGE"`,
    // which is the deploy flag rather than anything an operator ever sees.
    const echoedLines = ownerCode
      .split("\n")
      .filter((l) => /^\s*echo\b/.test(l))
      .join("\n");

    for (const varName of ["IMAGE", "IMAGE_TAG", "IMAGE_SHA"]) {
      assert.match(
        echoedLines,
        new RegExp(`\\$\\{?${varName}\\}?[^_A-Za-z0-9]`),
        `${OWNER_NAME} must ECHO ${varName} — an unprinted pin cannot be verified`,
      );
    }
    assert.match(
      ownerCode,
      /IMAGE_DIGEST=/,
      "the digest should be reported too (best-effort is fine)",
    );
  });
});

describe("MEMORY is 8Gi and 1Gi is a hard floor (MONEY-1314 / MONEY-1334 / MONEY-1339)", () => {
  it("deploys with the resolved --memory, defaulting to 8Gi", () => {
    // Was 2Gi, from PER-FILE measurements: peak RSS 2.3-4.8x file size, 618 MB
    // for a 129.81 MB PDF, largest object projecting ~1.13 GB. Every one of
    // those is about a single document, and that is what they missed. Prod
    // execution doc-ingest-backfill-prod-qj22v was OOM-killed at 2Gi AFTER
    // completing a 500-document page that read 3.383 GB — no file in it comes
    // near 2 GB, so the binding term is CUMULATIVE across the page.
    assert.match(
      ownerCode,
      /^MEMORY="8Gi"$/m,
      "the default must be 8Gi. 2Gi was OOM-killed on a real 500-document " +
        "page (signal 9, 3.383 GB read), and the kill is SILENT — it takes " +
        "the summary line with it. MONEY-1339 then put FOUR documents in " +
        "flight per task, so the container holds four peaks at once: at the " +
        "measured 4.8x and a 222.3 MB largest object that is ~4.3 GB",
    );
    assert.match(
      ownerCode,
      /--memory="\$MEMORY"/,
      "the deploy must actually pass --memory. Without it Cloud Run's 512 MiB " +
        "default applies and the task is OOM-killed on every large object — " +
        "silently, because the kill takes the SUMMARY line with it",
    );
  });

  it("REFUSES an override below the measured floor", () => {
    assert.match(
      ownerCode,
      /MEMORY_FLOOR_MI=1024/,
      "the floor must be stated as a constant, not buried in a comparison",
    );
    assert.match(
      ownerCode,
      /if \[ "\$MEM_MI" -lt "\$MEMORY_FLOOR_MI" \][\s\S]{0,700}?exit 1/,
      "a --memory below the floor must abort with exit 1. Accepting it would " +
        "deploy cleanly and then die on exactly the documents that matter most",
    );
    // A malformed size is a DIFFERENT failure from a too-small one and must not
    // fall through the numeric comparison as an empty string.
    assert.match(
      ownerCode,
      /\^\(\[0-9\]\+\)\(Mi\|Gi\)\$/,
      "--memory must be validated against a Cloud Run size pattern first",
    );
  });
});

describe("a JOB spec inherits NOTHING — every variable is explicit", () => {
  const envLine = /--set-env-vars="([^"]*)"/.exec(ownerCode)?.[1] ?? "";
  const secretLine = /--set-secrets="([^"]*)"/.exec(ownerCode)?.[1] ?? "";

  it("found the two spec lines it grades", () => {
    // Without this the four assertions below pass against empty strings.
    assert.ok(envLine.length > 20, "no --set-env-vars in the deploy args");
    assert.ok(secretLine.length > 20, "no --set-secrets in the deploy args");
  });

  it("passes the plain env the run cannot work without", () => {
    for (const name of [
      // Every GCS read and every `${gcsPath}.md` write.
      "GCP_STORAGE_BUCKET",
      // The Storage client refuses to construct without it.
      "GCP_PROJECT_ID",
      // An UNREGISTERED id here is IGNORED with a warning and the run falls
      // back to the PREMIUM chat model — a 4x price difference across ~48,000
      // documents, reported nowhere but the bill.
      "DOC_PARSE_MODEL",
    ]) {
      assert.ok(
        envLine.includes(`${name}=`),
        `--set-env-vars must carry ${name}. A job spec does NOT inherit the ` +
          `service's env block.\n  got: ${envLine}`,
      );
    }
  });

  it("passes the secrets the run cannot work without", () => {
    for (const name of [
      // The selectors, and every stamp.
      "DATABASE_URL",
      // Nothing reads it today; passed so a cache reach cannot degrade
      // silently inside a six-hour run.
      "REDIS_URL",
      // batch-submit / batch-ingest / sweep. The Developer-API batch path is
      // the rung this branch took and there is no fallback.
      "GOOGLE_GENAI_API_KEY",
      // `googleCredentials()` resolves this FIRST, and prod's runtime SA is
      // not the identity the buckets were granted to.
      "GCP_SERVICE_ACCOUNT_KEY_BASE64",
    ]) {
      assert.ok(
        secretLine.includes(`${name}=`),
        `--set-secrets must carry ${name}.\n  got: ${secretLine}`,
      );
    }
  });

  it("names the per-env secret, never a bare one", () => {
    assert.match(ownerCode, /DB_SECRET="DATABASE_URL_PROD"/);
    assert.match(ownerCode, /DB_SECRET="DATABASE_URL_QA"/);
    assert.match(ownerCode, /GENAI_SECRET="GOOGLE_GENAI_API_KEY_PROD"/);
    assert.match(ownerCode, /GENAI_SECRET="GOOGLE_GENAI_API_KEY_QA"/);
    assert.match(ownerCode, /BUCKET="stockbook-content-prod"/);
    assert.match(ownerCode, /BUCKET="stockbook-content-qa"/);
  });

  it("never forges DD_VERSION or EXPECTED_BUILD_SHA into the job spec", () => {
    // `[build-provenance]` can only be trusted because DD_VERSION is baked into
    // the IMAGE by workers/Dockerfile from the same $COMMIT_SHA that forms the
    // tag. Setting it here would make the reported SHA a property of the JOB
    // SPEC — so a job pinned to a stale image could report a fresh commit,
    // which is precisely the lie the guard exists to make impossible.
    assert.doesNotMatch(
      ownerCode,
      /--set-env-vars=[^\n]*\bDD_VERSION=/,
      "DD_VERSION must stay a property of the IMAGE, never of the job spec",
    );
    assert.doesNotMatch(
      ownerCode,
      /EXPECTED_BUILD_SHA=/,
      "EXPECTED_BUILD_SHA set at provision time matches by construction and " +
        "detects nothing — see build-provenance.ts",
    );
  });
});

describe("the job spec's safety flags (MONEY-1314)", () => {
  it("sets --max-retries=0", () => {
    // A retry re-runs the whole subcommand from the top with the SAME
    // arguments. For batch-submit that is a SECOND batch job against a metered
    // quota — the same documents paid for twice.
    assert.match(ownerCode, /--max-retries=0/);
    assert.doesNotMatch(
      ownerCode,
      /--max-retries=(?!0\b)\d+/,
      "--max-retries must be exactly 0",
    );
  });

  it("keeps the entrypoint in --command and CLEARS --args", () => {
    // `gcloud run jobs execute --args=` REPLACES the container's args. With the
    // script in --args, every parameterised execution would become
    // `node scan-convert` and die. And without an explicit `--args=""` a
    // re-provision KEEPS the previous operator's subcommand.
    assert.match(ownerCode, /--command="node,\$ENTRYPOINT"/);
    assert.match(
      ownerCode,
      /--args=""/,
      "--args must be cleared on every provision (there is no --clear-args)",
    );
  });

  it("preflights its OWN entrypoint against workers/tsup.config.ts", () => {
    // A `dist/*.js` tsup does not emit means the container starts and dies
    // instantly with "Cannot find module". The sibling scripts PRINT a warning
    // about this; a warning is what you read after the job has been provisioned
    // and executed, so this one refuses instead.
    const m = /ENTRYPOINT="dist\/([\w-]+)\.js"/.exec(ownerCode);
    assert.ok(m, "could not find the ENTRYPOINT assignment");
    const entry = m![1]!;

    assert.match(
      ownerCode,
      new RegExp(`grep -q '"${entry}"' "\\$TSUP_CONFIG"[\\s\\S]{0,900}?exit 1`),
      `the script must grep workers/tsup.config.ts for "${entry}" and exit 1 ` +
        "when it is absent",
    );

    // Informational rather than fatal ONLY in the direction that cannot lie:
    // if tsup DOES build an entry by this name, it must point at this job.
    if (tsupJobEntries.has(entry)) {
      assert.match(
        tsupSrc,
        new RegExp(`"${entry}":\\s*"\\.\\./scripts/jobs/${entry}\\.ts"`),
        `workers/tsup.config.ts builds "${entry}" from the wrong source`,
      );
    }
  });

  it("preflights the CONVERTER dependency it cannot run without", () => {
    // scan-convert is 309.8 GB of this job's work and cannot convert one
    // document without @firecrawl/pdf-inspector. The job also fails closed on
    // this at runtime; catching it at provision time costs nothing.
    assert.match(
      ownerCode,
      /CONVERTER_PKG="@firecrawl\/pdf-inspector"/,
      "the converter package must be named as a constant",
    );
    assert.match(
      ownerCode,
      /grep -q "\$CONVERTER_PKG" "\$WORKERS_PKG"[\s\S]{0,900}?exit 1/,
      "a missing converter dependency must abort with exit 1",
    );
  });

  it("is IDEMPOTENT by describe-then-update, create otherwise", () => {
    assert.match(
      ownerCode,
      /run jobs describe "\$JOB_NAME"/,
      "the script must ask whether the job exists before writing it",
    );
    assert.match(ownerCode, /ACTION="update"/);
    assert.match(ownerCode, /ACTION="create"/);
    assert.match(
      ownerCode,
      /run jobs "\$ACTION" "\$JOB_NAME"/,
      "…and dispatch on that answer, so the output says which it did",
    );
  });

  it("never hides a mutating gcloud call behind `|| true`", () => {
    // A swallowed failure in a provisioning script is a job that reports
    // success and is not there — the same shape as a swallowed --apply one
    // layer down. The two legitimate uses are best-effort READS.
    const tolerant = logicalLines(ownerCode).filter((l) =>
      /\|\|\s*true/.test(l),
    );

    // CONTROL: the detector must be finding something, or the assertion below
    // is vacuous and would keep passing after someone adds `|| true` to a
    // delete in a form this scan cannot see.
    assert.ok(
      tolerant.length >= 2,
      "expected the two best-effort `|| true` reads (the service image and " +
        `the registry digest); found ${tolerant.length}. If they were ` +
        "rewritten, re-derive this control rather than deleting it",
    );

    for (const line of tolerant) {
      assert.match(
        line,
        /describe/,
        "`|| true` is only allowed on a best-effort DESCRIBE. A create, " +
          "update, delete or IAM binding that fails must fail the script:\n  " +
          line.trim(),
      );
    }
  });
});

describe("`--apply` belongs to the JOB and this script never eats it", () => {
  it("defines no --apply case in its own argument loop", () => {
    // THE feed-repair SHAPE: a wrapper consumed `--apply`, the job never saw
    // it, 41,924 rows were read, nothing was written and the exit code was 0.
    // Fail-SAFE became fail-SILENT. Checked against the EXECUTED half only —
    // the heredoc prints `--apply` inside example commands on purpose.
    assert.doesNotMatch(
      ownerExecuted,
      /--apply\)/,
      "this script must never handle --apply. It is an EXECUTION argument " +
        "passed straight through to the job: " +
        'gcloud run jobs execute … --args="scan-convert,--apply"',
    );
    assert.doesNotMatch(
      ownerExecuted,
      /\bAPPLY(ING)?=/,
      "no apply state may exist in this script at all",
    );
  });

  it("still TELLS the operator how to pass it", () => {
    // Not handling the flag is only correct if the runbook says where it goes.
    assert.match(
      ownerSrc,
      /--args="scan-convert,--apply/,
      "the printed runbook must show --apply inside --args=",
    );
  });
});

describe("exactly ONE script owns doc-ingest-backfill-{env}", () => {
  /**
   * `gcloud run jobs update --set-env-vars` REPLACES the env list rather than
   * merging into it. Two scripts deploying one job means "whichever ran last
   * wins", silently. This repo has already paid for that lesson once, with two
   * setup scripts owning one Cloud Scheduler schedule.
   */
  it("only the owner ASSIGNS the job name", () => {
    const owners = opsScripts.filter((f) =>
      /^\s*\w+="doc-ingest-backfill-\$\{ENV\}"/m.test(
        stripShellComments(readFileSync(join(OPS_DIR, f), "utf8")),
      ),
    );
    assert.deepEqual(
      owners,
      [OWNER_NAME],
      "doc-ingest-backfill-{env} must be named in exactly one ops script.\n" +
        `  found: ${owners.join(", ")}`,
    );
  });

  it("only the owner deploys the entry point", () => {
    const deployers = opsScripts.filter((f) =>
      stripShellComments(readFileSync(join(OPS_DIR, f), "utf8")).includes(
        "dist/doc-ingest-backfill.js",
      ),
    );
    assert.deepEqual(
      deployers,
      [OWNER_NAME],
      `only ${OWNER_NAME} may hand dist/doc-ingest-backfill.js to a Cloud Run ` +
        `job.\n  found: ${deployers.join(", ")}`,
    );
  });
});

// ---------------------------------------------------------------------------
// THE JOB SOURCE
// ---------------------------------------------------------------------------

describe("counters are WRITES, not attempts (MONEY-1255 class)", () => {
  /**
   * Every mutation of the `writes` record, wherever it appears.
   *
   * `\bwrites` with a lowercase `w` deliberately does not match `newWrites`,
   * `interface Writes` or `outcome.writes`; the operator suffix deliberately
   * does not match `writes,` in an argument list or `writes.converted}` inside
   * a template.
   */
  const mutations =
    jobSrc.match(/\bwrites(\.\w+|\[[^\]]*\])\s*(\+\+|--|\+=|-=|=[^=])/g) ?? [];

  it("has exactly ONE mutation site, inside countedWrite", () => {
    assert.deepEqual(
      mutations,
      ["writes[key] +="],
      "a write counter may only move inside countedWrite(). A bare " +
        "`writes.x++` at a call site can be reached without the operation " +
        "having succeeded, which is how a source that 403s on every request " +
        "reports a full-looking number.\n  found: " +
        mutations.join(" | "),
    );
  });

  it("increments AFTER the awaited operation resolves", () => {
    const start = jobSrc.indexOf("async function countedWrite");
    assert.ok(start > 0, "countedWrite is gone");
    const end = jobSrc.indexOf("\n}", start);
    assert.ok(end > start, "could not bound countedWrite's body");
    const body = jobSrc.slice(start, end);

    const awaitAt = body.indexOf("await op()");
    const incAt = body.indexOf("writes[key] +=");
    assert.ok(awaitAt > 0, "countedWrite no longer awaits the operation");
    assert.ok(incAt > 0, "countedWrite no longer increments");
    assert.ok(
      incAt > awaitAt,
      "the increment must come AFTER `await op()`. Counting first means a " +
        "throw leaves the count claiming a write that never landed — and a " +
        "run that fails on every object reports the number it attempted",
    );
  });

  it("reports the write total, never the attempt total, to Datadog", () => {
    // The zero-write alert is `selected - written > 0`. It is only meaningful
    // if `written` cannot be satisfied by a counter that moved before its call.
    assert.match(
      jobSrc,
      /written: Object\.values\(outcome\.writes\)\.reduce/,
      "reportJobOutcome's `written` must be summed from the writes record",
    );
  });
});

describe("an empty selection is distinguishable from a drained queue", () => {
  it("the summary line carries selected AND remaining", () => {
    const summaryAt = jobSrc.indexOf("SUMMARY ${args.subcommand}");
    assert.ok(summaryAt > 0, "the SUMMARY line is gone");
    const summary = jobSrc.slice(summaryAt, summaryAt + 700);

    assert.match(
      summary,
      /selected=\$\{outcome\.selected\}/,
      "the summary must state how many rows the run took on",
    );
    assert.match(
      summary,
      /remaining=\$\{outcome\.remaining\}/,
      "…and how many the SAME predicate still matches. Without both, " +
        '"nothing to do" and "the whole corpus is unreachable" print the ' +
        "identical line and exit 0 (MONEY-1050 / 1205 / 1234 / 1236)",
    );
    assert.match(
      summary,
      /describeApply\(args\)/,
      "…and whether the run was writing. A narrowed --apply reads exactly " +
        "like a run that was never armed",
    );
  });

  it("every subcommand recounts with the predicate it selected on", () => {
    // Counting a DIFFERENT population is the wrong-granularity completeness
    // report MONEY-1189 catalogued five times.
    assert.match(
      jobSrc,
      /const remainingBefore = await prisma\.stockDocument\.count/,
    );
    assert.ok(
      (jobSrc.match(/prisma\.stockDocument\.count\(\{ where/g) ?? []).length >=
        4,
      "each subcommand must count its own scope before and after",
    );
  });
});

describe("--apply is parsed HERE, dry run is the default", () => {
  it("reads the flag in this file and nowhere else", () => {
    assert.match(
      jobSrc,
      /const apply = flags\.has\("--apply"\)/,
      "the job itself must read --apply. Nothing between the command line " +
        "and this line may consume it",
    );
  });

  it("lets --dry-run NARROW --apply, never the reverse", () => {
    assert.match(
      jobSrc,
      /function resolveApply\(args: Args\): boolean \{\s*return args\.apply && !args\.dryRun;/,
      "a flag may always narrow a run and never widen one — so a --dry-run " +
        "appended to a copied command cannot be defeated by an earlier --apply",
    );
  });

  it("treats an unrecognised argument as fatal", () => {
    // gcloud splits --args on COMMAS, so a stray comma inside a flag is a
    // routine mistake. A mistyped --apply that parses as "no flags given" runs
    // a silent dry run and exits 0.
    assert.match(
      jobSrc,
      /unknown argument "\$\{token\}"/,
      "an unknown argument must be reported by name",
    );
    assert.match(
      jobSrc,
      /process\.exitCode = EXIT\.USAGE/,
      "…and must refuse to run",
    );
  });
});

describe("the run is bounded by a WALL CLOCK", () => {
  it("has a budget checked against elapsed time, not a row count", () => {
    assert.match(
      jobSrc,
      /if \(this\.elapsedMs\(\) >= this\.budgetMs\) return "budget";/,
      "the bound must be a clock. Per-document cost is a GCS read plus a " +
        "conversion dominated by a fixed ~150-200ms and unpredictable from " +
        "page count (a 123-page image PDF ran 12.0s), so a row budget is a guess",
    );
    assert.match(
      jobSrc,
      /"--budget-sec=N"|budget-sec/,
      "the budget must be operator-settable",
    );
  });

  it("names the stop reason in the outcome line", () => {
    assert.match(jobSrc, /stop=\$\{outcome\.stop\}/);
  });

  it("checks the clock BEFORE EVERY DOCUMENT, not merely between pages", () => {
    // Checked only between PAGES, a 250-row page of large PDFs overruns the
    // budget by hours and the task timeout takes the summary with it.
    //
    // The SHAPE changed in MONEY-1339 and the property did not. The serial
    // `for (const doc of page) { const stopMid = budget.check(); … }` became a
    // bounded pool, and the pool consults `shouldStop` before it CLAIMS each
    // item — so the clock is still read once per document, and a document
    // already in flight still finishes (an abandoned one would have paid its
    // download and parse and stamped nothing).
    //
    // Asserted against the CALL SITE that passes the predicate, so deleting
    // the check or hoisting it out of the pool fails here.
    const call = jobSrc.slice(
      jobSrc.indexOf("await runPool("),
      jobSrc.indexOf("convertOne,\n    );"),
    );
    assert.ok(call.length > 0, "the scan-convert pool call is gone");
    assert.match(
      call,
      /const s = budget\.check\(\);/,
      "the pool's stop predicate no longer reads the budget, so a page runs " +
        "to completion however long it takes",
    );
    assert.match(
      call,
      /return s !== null;/,
      "the stop predicate no longer reports the budget verdict to the pool",
    );
    // And the pool itself must consult it per item rather than once.
    const poolStart = jobSrc.indexOf("export async function runPool");
    assert.ok(poolStart > 0, "runPool is gone");
    const pool = jobSrc.slice(
      poolStart,
      jobSrc.indexOf("export const DEFAULT_CONCURRENCY", poolStart),
    );
    assert.ok(pool.length > 0, "could not bound the runPool body");
    assert.match(
      pool,
      /for \(;;\) \{\s*if \(shouldStop\(\)\) \{/,
      "runPool checks its stop predicate outside the claim loop, so it would " +
        "read the clock once per WORKER rather than once per document",
    );
  });
});

describe("the exit-code table (MONEY-1314)", () => {
  it("has no distinct code for `nothing to do`", () => {
    const start = jobSrc.indexOf("const EXIT = {");
    assert.ok(start > 0, "the EXIT table is gone");
    const table = jobSrc.slice(start, jobSrc.indexOf("} as const;", start));

    const codes = [...table.matchAll(/^\s*(\w+): (\d),$/gm)].map((m) => [
      m[1]!,
      Number(m[2]!),
    ]) as Array<[string, number]>;
    assert.deepEqual(
      codes,
      [
        ["OK", 0],
        ["USAGE", 1],
        ["FAILED", 2],
        ["INCOMPLETE", 3],
      ],
      "an empty queue is a SUCCESS. Once the corpus is converted it is the " +
        "NORMAL state, and a non-zero exit for it trains an operator to " +
        "ignore the one signal that matters",
    );
  });

  it("maps a budget stop to INCOMPLETE and everything else to OK", () => {
    const start = jobSrc.indexOf("function exitCodeFor");
    assert.ok(start > 0, "exitCodeFor is gone");
    const body = jobSrc.slice(start, jobSrc.indexOf("\n}", start));

    assert.match(body, /outcome\.stop === "failed"[\s\S]{0,80}EXIT\.FAILED/);
    assert.match(
      body,
      /"budget" \|\| outcome\.stop === "max-batches"[\s\S]{0,90}EXIT\.INCOMPLETE/,
      "a truncated run must be distinguishable from a finished one — resume " +
        "is free, but only if somebody knows to resume",
    );
    assert.match(body, /return EXIT\.OK;/);
    assert.doesNotMatch(
      body,
      /"drained"|"dry-run"/,
      "a drained queue and a dry run are ordinary successes and must not " +
        "acquire a code of their own",
    );
  });
});

describe("selections go through the ONE selector module", () => {
  it("imports the selectors rather than hand-writing an isSet arm", () => {
    // A Mongo `db push` creates INDEXES, never FIELDS, so `convertStatus`,
    // `parsePath` and `batchJobId` are ABSENT — not null — on all ~79,884
    // pre-existing rows. `{ convertStatus: "PENDING" }` matches ZERO of them,
    // and the failure is silent in BOTH directions. Four tickets so far.
    assert.match(
      jobSrc,
      /from "\.\.\/\.\.\/workers\/src\/processors\/doc-ingest-selectors-logic"/,
      "the selectors must be imported from the module that owns the isSet arms",
    );
    for (const fn of [
      "buildConvertQuery",
      "buildBatchIngestQuery",
      "buildSweepQuery",
    ]) {
      assert.ok(
        jobSrc.includes(`${fn}(`),
        `${fn} must be USED, not merely imported`,
      );
    }
  });

  it("writes no isSet filter of its own over a MONEY-1314 field", () => {
    const handRolled =
      /(convertStatus|batchJobId|parsePath|scannedPageCount)\s*:\s*\{\s*isSet/g;
    const hits = jobCode.match(handRolled) ?? [];
    // `markdownGcsPath: { isSet: true }` in batch-build is deliberately NOT in
    // this list: it is a POSITIVE test for a field this job itself writes, not
    // one of the absent-on-the-whole-corpus arms the selector module owns.
    assert.deepEqual(
      hits,
      [],
      "an isSet arm over a pre-existing-corpus field belongs in " +
        "doc-ingest-selectors-logic.ts, where a reviewer can check it.\n  " +
        `found: ${hits.join(", ")}`,
    );
  });
});

describe("the runbook this job needs is written down", () => {
  it("scripts/README.md documents the job and its entry", () => {
    const readme = join(ROOT, "scripts", "README.md");
    assert.ok(existsSync(readme), "scripts/README.md is missing");
    const src = readFileSync(readme, "utf8");
    assert.match(
      src,
      /doc-ingest-backfill/,
      "the repo requires scripts/README.md to be updated on every scripts/ " +
        "change, and this job's five subcommands are not guessable",
    );
    assert.match(
      src,
      /setup-doc-ingest-backfill-job\.sh/,
      "…including the script that provisions it",
    );
  });
});

describe("MONEY-1314 — --model is VALIDATED against the registry", () => {
  // The one hazard this file's own header names — an unregistered id runs the
  // PREMIUM chat model at 4x the batch rate across ~48,000 documents, with a
  // single warning line as the symptom — was the one thing it accepted
  // unvalidated, while hard-gating two smaller preflights.
  const src = readFileSync(OWNER, "utf8");

  it("refuses an id that is not in model-registry.ts", () => {
    assert.match(
      src,
      /model-registry\.ts/,
      "the setup script does not consult the model registry at all",
    );
    assert.match(
      src,
      /is not registered in/,
      "there is no refusal message for an unregistered model id",
    );
  });

  it("the refusal is FATAL, not a warning", () => {
    const i = src.indexOf("is not registered in");
    assert.ok(i > 0);
    const after = src.slice(i, i + 1200);
    assert.match(
      after,
      /exit 1/,
      "an unregistered model prints a warning and provisions anyway — the " +
        "job would then quietly overspend by 4x",
    );
  });

  it("it names the registered ids, so the operator can fix it", () => {
    assert.match(src, /Registered ids:/);
  });

  it("[control] the scan can tell a gated preflight from an ungated one", () => {
    // Proves the `exit 1` proximity check means something: the script's own
    // help text mentions the model too, and that is not a gate.
    const helpOnly =
      "  --model=ID   DOC_PARSE_MODEL (default gemini-3.7-flash)";
    assert.ok(!/exit 1/.test(helpOnly));
  });
});

describe("MONEY-1314 — the JOB is told how much memory it has", () => {
  // Found by verifying the PROVISIONED job rather than the script: it came up
  // 2Gi with DOC_CONVERT_CONTAINER_MI absent.
  //
  // That is not a harmless omission. The converter sizes its OOM refusal
  // ceiling from this variable and defaults to 1024 when it is missing, so the
  // job would budget for HALF the memory it has and decline documents by
  // estimated peak RSS (2.3-4.8x file size). The result is the exact opposite
  // of the intent: the large documents the 1 GiB SERVICE defers to this job
  // would be declined here too, and nothing would ever read them.
  const src = readFileSync(OWNER, "utf8");

  it("passes DOC_CONVERT_CONTAINER_MI to the job", () => {
    // Read off the `--set-env-vars=` argument, not off the file. The variable
    // is NAMED in the header comment above, so a substring test passes with the
    // deploy line commented out — verified: it did.
    assert.equal(
      provisionsEnvVar(src, "DOC_CONVERT_CONTAINER_MI"),
      "${SLOT_MI}",
      "the job is provisioned without the PER-SLOT ceiling. With " +
        "${CONTAINER_MI} every one of the concurrent slots budgets for the " +
        "WHOLE container, so four documents each sized against 8Gi run " +
        "together and the task is OOM-killed — the 2026-09-02 failure, " +
        "reintroduced by the concurrency that was meant to end it",
    );
  });

  it("divides the container ceiling by the slot count, and both come from flags", () => {
    // Two spellings of one fact again, one level down: --memory sets the
    // container and --concurrency sets how many documents share it. Hardcoding
    // either lets an operator move one without the other.
    assert.match(src, /SLOT_MI=\$\(\(\s*CONTAINER_MI \/ CONCURRENCY\s*\)\)/);
    assert.equal(
      provisionsEnvVar(src, "DOC_CONVERT_CONCURRENCY"),
      "${CONCURRENCY}",
      "the job is not told how many slots it was sized for, so its own " +
        "default could run more documents than the ceiling was divided by",
    );
  });

  it("derives it from --memory rather than hardcoding it", () => {
    // Two spellings of one fact. Hardcoding 2048 beside a `--memory=` flag
    // lets an operator move one without the other, which is how the ceiling
    // ends up ABOVE the container limit — the defect this branch already fixed
    // once, on the service.
    assert.match(src, /case "\$MEMORY" in/);
    assert.match(
      src,
      /\*Gi\)\s*CONTAINER_MI=\$\(\(\s*\$\{MEMORY%Gi\} \* 1024\s*\)\)/,
    );
    assert.match(src, /\*Mi\)\s*CONTAINER_MI=\$\{MEMORY%Mi\}/);
  });

  it("refuses a --memory it cannot read, rather than guessing", () => {
    // A silent fallback here reintroduces the absent-variable bug under a
    // different name.
    //
    // Bounded by the block's OWN `esac`, never by a byte count. A fixed
    // 900-char window starting at `case` reaches 190 chars past it into the
    // REGISTRY validation, which carries its own `FATAL:` and `exit 1` — so
    // both assertions below were satisfied by an UNRELATED guard, and deleting
    // the entire `*) … exit 1 ;;` arm left this case green. Verified.
    const i = src.indexOf('case "$MEMORY" in');
    assert.ok(i > 0, "the --memory case block is gone");
    const rest = src.slice(i);
    const esacAt = rest.search(/^[ \t]*esac\b/m);
    assert.ok(
      esacAt > 0,
      "could not find the `esac` closing the --memory case — without it this " +
        "check would silently degrade to 'the rest of the file'",
    );
    const block = rest.slice(0, esacAt);
    // Belt and braces on the bound itself: the real block is 190 bytes, and a
    // `case` that has grown past 400 has stopped being the three-arm size
    // derivation this reasons about.
    assert.ok(
      block.length < 400,
      `the --memory case is ${block.length} bytes — too large to still be the ` +
        "three-arm derivation, and the FATAL below may belong to something else",
    );
    assert.match(block, /FATAL/);
    assert.match(block, /exit 1/);
  });

  it("[control] the scan distinguishes the derivation from a mention", () => {
    // Drives the SAME helper the assertion above uses, against synthetic input.
    // The old control ran a regex over a hardcoded string literal and read no
    // file at all, so it could not go red for any change to anything — and the
    // literal it tested did not even contain the pattern.
    //
    // The negative is the one a naive `src.includes()` gets wrong: a whole-line
    // `#` comment carrying the EXACT provisioning text.
    const commentedOut =
      '    # --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},' +
      'DOC_CONVERT_CONTAINER_MI=${CONTAINER_MI}"\n' +
      '    --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID}"';
    assert.equal(
      provisionsEnvVar(commentedOut, "DOC_CONVERT_CONTAINER_MI"),
      null,
      "a commented-out --set-env-vars must not count as provisioning",
    );
    assert.equal(
      provisionsEnvVar(
        "#   DOC_CONVERT_CONTAINER_MI  sizes the converter's OOM ceiling\n" +
          'echo "DOC_CONVERT_CONTAINER_MI=${CONTAINER_MI}"',
        "DOC_CONVERT_CONTAINER_MI",
      ),
      null,
      "neither does a header mention or an echo — only a --set-env-vars= list",
    );
    // …and the positive still resolves, or the negatives above are vacuous.
    assert.equal(
      provisionsEnvVar(
        '    --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},' +
          'DOC_CONVERT_CONTAINER_MI=${CONTAINER_MI}"',
        "DOC_CONVERT_CONTAINER_MI",
      ),
      "${CONTAINER_MI}",
    );
  });
});
