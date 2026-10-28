/**
 * The XBRL backfill job must be pinned to the LIVE service image — MONEY-1220 E.
 *
 * `job-build-provenance.test.ts` proves a job can SAY which commit it is running.
 * This file proves the other half, one step earlier: that the script which
 * provisions `xbrl-backfill-{env}` pins the image it was told to pin, refuses to
 * retry, and cannot quietly acquire a second owner.
 *
 * ## The bug class this closes
 *
 * Cloud Run JOBS pin their image at provision time and a deploy of the SERVICE
 * does not move them. Measured on this repo, twice:
 *
 *   MONEY-1189  the fix shipped and then sat un-executed on the nightly jobs.
 *   MONEY-1205  feed-parse-prod ran nightly on a 14-Aug image for 10 days,
 *               exited 0, reported SUCCEEDED_COUNT 1, and skipped four bond
 *               families it had never heard of. bond_master / bond_eod: 0 rows.
 *
 * And it is STILL TRUE at the time of writing — verified 2026-08-19:
 *
 *   stockbook-workers-prod SERVICE  prod-6abc3278...
 *   feed-parse-prod JOB             prod-ed432f72...   (behind)
 *
 * The only thing standing between that and a permanently-stale XBRL walk is
 * that the setup script reads `gcloud run services describe … image` every time
 * it runs. A hardcoded tag, a `:latest`, or a fallback that tolerates an empty
 * resolution would each restore the bug in a form nothing else here can see —
 * so each of those is asserted against directly.
 *
 * ## Why the assertions read the SHELL SOURCE
 *
 * There is no other observable. The script's whole output is a gcloud
 * invocation, and gcloud is exactly what must not be run from a test. Reading
 * the source is the honest version of "did the flag survive"; a mock of gcloud
 * would only assert that the mock was written correctly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** CWD is packages/core when this suite runs. */
const ROOT = join(process.cwd(), "..", "..");
const OPS_DIR = join(ROOT, "scripts", "ops");
const OWNER_NAME = "setup-xbrl-backfill-job.sh";
const OWNER = join(OPS_DIR, OWNER_NAME);
const TSUP = join(ROOT, "workers", "tsup.config.ts");

const ownerSrc = readFileSync(OWNER, "utf8");
const tsupSrc = readFileSync(TSUP, "utf8");

const opsScripts = readdirSync(OPS_DIR)
  .filter((f) => f.endsWith(".sh"))
  .sort();

/**
 * Drop whole-line `#` comments, keeping line numbering intact.
 *
 * Load-bearing for the ownership scan below: `setup-feed-backfill-job.sh`
 * DISCUSSES `xbrl-backfill` at length in its header (it delegates here, and the
 * header says why). Prose that names a job is not a second owner of it, and a
 * guard that cannot tell those apart is one that gets deleted the first time it
 * fires on a comment.
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

/** Entry points tsup bundles into `workers/dist/`, derived not listed. */
const tsupJobEntries = (() => {
  const start = tsupSrc.indexOf("entry: {");
  const end = tsupSrc.indexOf("}", start);
  const block = tsupSrc.slice(start, end);
  const out = new Set<string>();
  for (const m of block.matchAll(
    /"?([\w-]+)"?\s*:\s*"\.\.\/scripts\/jobs\/([\w-]+)\.ts"/g,
  )) {
    out.add(m[1]!);
  }
  return out;
})();

describe("setup-xbrl-backfill-job.sh resolves its inputs (MONEY-1220 E)", () => {
  it("reads the files it reasons over — a silent zero here proves nothing", () => {
    // This suite's own failure mode is matching nothing and passing, which
    // would restore exactly the blind spot it closes.
    assert.ok(
      ownerSrc.length > 2000,
      `${OWNER_NAME} did not read (got ${ownerSrc.length} bytes)`,
    );
    assert.ok(
      opsScripts.length >= 10,
      `found only ${opsScripts.length} .sh files under scripts/ops`,
    );
    assert.ok(
      tsupJobEntries.size >= 4,
      `parsed only ${tsupJobEntries.size} scripts/jobs entry points from tsup.config.ts`,
    );
  });
});

describe("the job is pinned to the SERVICE's CURRENT image (MONEY-1210)", () => {
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

  it("hands that resolved value — not a literal — to `run jobs deploy`", () => {
    assert.match(
      ownerCode,
      /--image="\$IMAGE"/,
      "the deploy must pass the RESOLVED $IMAGE variable",
    );

    // A hardcoded registry path is the tempting "fix" when a resolution fails
    // once. It pins the job to a tag forever and every later release silently
    // misses it.
    const literalImage = /--image=(?!"?\$)[^\s\\]*(gcr\.io|docker\.pkg\.dev)/;
    assert.doesNotMatch(
      ownerCode,
      literalImage,
      "--image= must never be a hardcoded registry path. Cloud Run JOBS pin " +
        "their image at provision time, so a literal tag here is a job that " +
        "can never be re-pointed by re-running setup",
    );

    // `:latest` is worse than a stale pin: it LOOKS current while Cloud Run
    // still resolves it to a digest once, at deploy time.
    assert.doesNotMatch(
      ownerCode,
      /--image=[^\s\\]*:latest/,
      "--image=…:latest is not a pin. Cloud Run resolves the tag to a digest " +
        "at deploy time, so the job freezes on whatever :latest meant that day " +
        "while reading as if it tracked head",
    );
  });

  it("FAILS CLOSED when the image cannot be resolved", () => {
    // An empty IMAGE must never reach gcloud. Deploying without --image is read
    // as "keep the existing image", which on a re-provision silently preserves
    // the stale pin this script exists to move — a fail-open default in the one
    // place that must not have one.
    assert.match(
      ownerCode,
      /if \[ -z "\$IMAGE" \][\s\S]{0,400}?exit 1/,
      "an unresolved image must abort with exit 1, not fall through to a " +
        "deploy that omits --image",
    );
  });

  it("PRINTS what it pinned, so the operator can verify it", () => {
    // The pin is only checkable if it is stated. The job's own
    // [build-provenance] line reports the commit it is RUNNING; this is the
    // other side of that comparison, and without it there is nothing to compare
    // against.
    //
    // Checked against ECHO lines specifically, not the whole file. A bare
    // "does the string appear anywhere" test passes on `--image="$IMAGE"`,
    // which is the deploy flag rather than anything the operator ever sees —
    // it reported a pass for the one variable that was already covered by the
    // pinning assertions above, while `IMAGE_TAG` was genuinely unprinted.
    const echoedLines = ownerCode
      .split("\n")
      .filter((l) => /^\s*echo\b/.test(l))
      .join("\n");

    for (const varName of ["IMAGE", "IMAGE_TAG", "IMAGE_SHA"]) {
      assert.match(
        echoedLines,
        new RegExp(`\\$\\{?${varName}\\}?[^_A-Za-z0-9]`),
        `${OWNER_NAME} must ECHO ${varName} — the pinned image, its tag and the ` +
          "commit inside it are what the job's [build-provenance] line is " +
          "checked against, and an unprinted pin cannot be verified by anyone",
      );
    }
    assert.match(
      ownerCode,
      /IMAGE_DIGEST=/,
      "the digest should be reported too (best-effort is fine) — it is the " +
        "strongest identity a tag resolves to",
    );
  });
});

describe("the job spec keeps its safety flags (MONEY-1220 E)", () => {
  it("sets --max-retries=0", () => {
    // A retry re-walks the SAME window from the top. That is cheap in rows —
    // the pre-download skip makes a stored filing one indexed read — but it is
    // NOT cheap against NSE: a task killed by the timeout, or aborted by a
    // stop-loss after sustained throttling, would be restarted straight back
    // into the host that just cut us off. A protective abort becomes a tight
    // retry loop against the one host this whole feature depends on.
    assert.match(
      ownerCode,
      /--max-retries=0/,
      "xbrl-backfill must deploy with --max-retries=0",
    );
    assert.doesNotMatch(
      ownerCode,
      /--max-retries=(?!0\b)\d+/,
      "--max-retries must be exactly 0",
    );
  });

  it("runs an entry point workers/tsup.config.ts actually builds", () => {
    // A `dist/*.js` tsup does not emit means the container starts and dies
    // instantly with "Cannot find module". Deriving the set from tsup rather
    // than listing it means a renamed entry point fails here instead of at
    // 3am in Cloud Run.
    const m = /ENTRYPOINT="dist\/([\w-]+)\.js"/.exec(ownerCode);
    assert.ok(m, "could not find the ENTRYPOINT assignment");
    assert.ok(
      tsupJobEntries.has(m![1]!),
      `${OWNER_NAME} deploys dist/${m![1]!}.js, which workers/tsup.config.ts ` +
        `does not build. Known entries: ${[...tsupJobEntries].join(", ")}`,
    );
  });

  it("sets FEED_ARCHIVE_MODE per env — archive on prod, replay on QA", () => {
    // Unset, getFeedAsset() passes through and stores nothing: a multi-hour
    // walk that fetches every byte from NSE and throws it away while every
    // counter reports success. A job spec does NOT inherit the service's env
    // block, so this has to be stated here.
    //
    // replay on QA is the scrape-once contract (MONEY-1085): prod fetches each
    // file once and archives it, QA replays those bytes rather than scraping
    // the exchange a second time.
    assert.match(
      ownerCode,
      /FEED_ARCHIVE_MODE=\$\{ARCHIVE_MODE\}/,
      "FEED_ARCHIVE_MODE must be set explicitly in --set-env-vars",
    );
    assert.match(
      ownerCode,
      /prod\)[\s\S]{0,300}?ARCHIVE_MODE="archive"/,
      "prod must archive — it is the env that OWNS the feed archive",
    );
    assert.match(
      ownerCode,
      /qa\)[\s\S]{0,300}?ARCHIVE_MODE="replay"/,
      "QA must replay prod's archived bytes, not scrape NSE a second time",
    );
    assert.match(
      ownerCode,
      /GCP_STORAGE_BUCKET=/,
      "requireArchiveWired() crashes without a bucket to wire the store — " +
        "which is the correct behaviour, but only if the bucket is passed",
    );
  });

  it("never forges DD_VERSION or EXPECTED_BUILD_SHA into the job spec", () => {
    // The whole reason `[build-provenance]` can be trusted is that DD_VERSION
    // is baked into the IMAGE by workers/Dockerfile from the same $COMMIT_SHA
    // that forms the tag, and `gcloud run jobs deploy --set-env-vars` rewrites
    // only the job's own env list. Setting it here would make the reported SHA
    // a property of the JOB SPEC — so a job pinned to a stale image could
    // report a fresh commit, which is precisely the lie the guard exists to
    // make impossible.
    //
    // EXPECTED_BUILD_SHA is refused for the reason written up in
    // packages/core/src/ops/build-provenance.ts: it would be read from the same
    // image being pinned, so it would match by construction, forever, and
    // detect nothing. A green that cannot go red is worse than the WARN it
    // replaces, because the WARN at least carries the SHA.
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

describe("exactly ONE script owns xbrl-backfill-{env} (MONEY-1220 E)", () => {
  /**
   * `gcloud run jobs deploy --set-env-vars` REPLACES the env list rather than
   * merging into it. Two scripts deploying one job therefore means "whichever
   * ran last wins", silently — and here they WOULD differ, because this job
   * takes FEED_ARCHIVE_MODE=replay on QA while the feed jobs take archive on
   * both. Re-running the wrong setup script would flip a whole environment's
   * archive mode with no error and no output saying so.
   *
   * This repo has already paid for that lesson once: two setup scripts owning
   * one Cloud Scheduler schedule, where whichever ran last silently won.
   */
  it("only the owner ASSIGNS the job name", () => {
    const owners = opsScripts.filter((f) =>
      /^\s*\w+="xbrl-backfill-\$\{ENV\}"/m.test(
        stripShellComments(readFileSync(join(OPS_DIR, f), "utf8")),
      ),
    );
    assert.deepEqual(
      owners,
      [OWNER_NAME],
      "xbrl-backfill-{env} must be named in exactly one ops script. A second " +
        "one is a second owner, and --set-env-vars means last-writer-wins with " +
        "no error.\n  found: " +
        owners.join(", "),
    );
  });

  it("only the owner deploys the entry point", () => {
    const deployers = opsScripts.filter((f) => {
      const code = stripShellComments(readFileSync(join(OPS_DIR, f), "utf8"));
      return code.includes("dist/xbrl-backfill.js");
    });
    assert.deepEqual(
      deployers,
      [OWNER_NAME],
      "only setup-xbrl-backfill-job.sh may hand dist/xbrl-backfill.js to a " +
        "Cloud Run job deploy. setup-feed-backfill-job.sh DELEGATES to it " +
        "instead (its step 4b), which is what keeps one spec.\n  found: " +
        deployers.join(", "),
    );
  });

  it("setup-feed-backfill-job.sh delegates rather than duplicating", () => {
    // The delegation is what makes single-ownership free: `setup-feed-backfill-job.sh
    // {env}` still provisions all four data-engine jobs, so no runbook or
    // muscle memory breaks — there is just one place the spec lives.
    const feedSrc = stripShellComments(
      readFileSync(join(OPS_DIR, "setup-feed-backfill-job.sh"), "utf8"),
    );
    assert.match(
      feedSrc,
      /XBRL_SETUP=.*setup-xbrl-backfill-job\.sh/,
      "setup-feed-backfill-job.sh must point at the owner script",
    );
    assert.match(
      feedSrc,
      /"\$XBRL_SETUP" "\$\{xbrl_args\[@\]\}"/,
      "…and actually invoke it",
    );
    assert.match(
      feedSrc,
      /xbrl_args=\("\$ENV" "--image=\$IMAGE"\)/,
      "the parent must pass ITS resolved $IMAGE through, so one provisioning " +
        "run pins every job in the env to the same image rather than each " +
        "script re-resolving independently and straddling a deploy",
    );
  });
});

describe("run-market-data-job.sh dispatches xbrl to Cloud Run (MONEY-1220 E)", () => {
  const runnerSrc = stripShellComments(
    readFileSync(join(OPS_DIR, "run-market-data-job.sh"), "utf8"),
  );

  it("routes the xbrl case to the Cloud Run job, not to tsx", () => {
    // A local `npx tsx` walk is archive-blind (this wrapper's GCS branch sets
    // FEED_ARCHIVE_MODE=replay, under which the walk fetches from NSE and DROPS
    // every byte) and cannot survive a laptop sleeping — which is how two runs
    // were lost on 2026-08-19.
    assert.match(
      runnerSrc,
      /xbrl\)[^\n]*RUNNER="cloudrun"/,
      "the xbrl case must set RUNNER=cloudrun",
    );
    assert.match(
      runnerSrc,
      /xbrl\)[^\n]*CLOUD_JOB="xbrl-backfill"/,
      "…and name the Cloud Run job it dispatches to",
    );
    assert.match(
      runnerSrc,
      /run jobs execute "\$job_name"/,
      "the cloudrun path must actually execute the job",
    );
  });

  it("keeps DRY-RUN the default and --apply explicit", () => {
    // Same contract as every other job in this wrapper, expressed in the job's
    // own vocabulary: --apply is the wrapper's word, --dry-run is the job's.
    assert.match(
      runnerSrc,
      /if \[ "\$applying" = false \][\s\S]{0,400}?job_args\+=\("--dry-run"\)/,
      "without --apply the wrapper must execute the job with --dry-run, which " +
        "prints the window plan and makes ZERO NSE requests",
    );
    // --apply must be CONSUMED, not forwarded: xbrl-backfill.ts does not know
    // the flag and would reject it.
    assert.match(
      runnerSrc,
      /--apply\)\s*applying=true/,
      "--apply must be consumed by the wrapper, not passed to the job",
    );
  });

  it("refuses a bare --apply, which would walk 2018→today in one execution", () => {
    // xbrl-backfill.ts's DEFAULTS are --from-year=2018 through today. Running
    // that unsharded does not fit the 24h task timeout (one FY is ~5h of paced
    // downloads), so it gets killed part-way and surfaces as a FAILED task
    // rather than as the "you asked for too much" it actually is. Same guard,
    // same reason, as feed-backfill's "do not execute with no --families".
    assert.match(
      runnerSrc,
      /\*" --from"\*\|\*" --annual-existing "\*\|\*" --archive-existing "\*\)/,
      "--apply must require a window (--from…) or a named repair pass",
    );
    assert.match(
      runnerSrc,
      /ERROR: --apply needs a scope[\s\S]{0,900}?exit 1/,
      "…and the refusal must exit 1 while naming the FY shards",
    );
  });

  it("preflights that the job exists, naming the script that creates it", () => {
    // Without this an unprovisioned job surfaces as a raw gcloud NOT_FOUND and
    // the next move is a guess. That was the live state on 2026-08-19: no
    // xbrl-* job existed in any env while this wrapper documented the walk as
    // if it did.
    assert.match(
      runnerSrc,
      /run jobs describe "\$job_name"/,
      "the cloudrun path must check the job exists before executing",
    );
    assert.match(
      runnerSrc,
      /setup-xbrl-backfill-job\.sh/,
      "…and the error must name the script that provisions it",
    );
  });
});
