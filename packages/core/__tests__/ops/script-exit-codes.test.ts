/**
 * Ops scripts must not report success over work that failed — MONEY-1238.
 *
 * ## The defect class these guard against
 *
 * Three scripts computed a failure and then discarded it, each in a slightly
 * different way, and all three ended on a green banner and exit 0. Because a
 * Cloud Run job's status IS its entrypoint's exit code, "exit 0" is not a
 * cosmetic detail — it is the difference between an alert and a silent gap.
 *
 * ## Why `set -e` produced two of the three
 *
 * All three files set `-e`. Under it a BARE failing command aborts the shell
 * immediately, so the idiom
 *
 *     cmd
 *     if [ $? -ne 0 ]; then ...handle... fi
 *
 * has an UNREACHABLE handler: `$?` can only be 0 by the time the test runs.
 * `seed-env.sh` therefore promised "Continuing..." while hard-aborting, and
 * `update-prod-analysis-engine.sh` lost its build diagnostic entirely.
 *
 * The one-character fix, `cmd || true`, is the DANGEROUS direction: it makes
 * the handler reachable while still throwing the failure away. The correct
 * shape captures the code (`|| rc=$?`), records it, and gates the exit.
 *
 * ## Why the first test EXECUTES the script
 *
 * The audit that produced this ticket found two guards that asserted a STRING
 * was present rather than that a DECISION changed — both passed while the
 * behaviour they were named for was false. `seed-env.sh` can be run for real
 * (its `--url` mode skips GCP entirely and every step shells out to `npx`), so
 * the exit code is observed rather than inferred. The other two need extensive
 * `gcloud` stubbing to run, so they are pinned structurally — but on the
 * WIRING (an append reachable from each failure site, and a gate that consumes
 * it), never on prose.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const read = (rel: string): string => readFileSync(join(REPO, rel), "utf8");

/**
 * Drop whole-line shell comments. Shell has no block comments, and a `#` can
 * appear inside a quoted string, so ONLY lines whose first non-space character
 * is `#` are removed — never a trailing `#` on a code line.
 */
const stripShellComments = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/**
 * Run seed-env.sh with a stubbed `npx` whose exit code we choose.
 *
 * `--url` short-circuits every GCP call (see the tail of the script), and
 * `--step 1` limits the run to a single step, so nothing but the stub executes.
 * The stub is a shell script on PATH — the same mechanism the real run uses to
 * find npx — so this exercises the actual code path, not a reimplementation.
 */
function runSeedEnv(npxExitCode: number): { status: number; out: string } {
  const bin = mkdtempSync(join(tmpdir(), "seed-env-stub-"));
  const stub = join(bin, "npx");
  writeFileSync(
    stub,
    `#!/bin/sh\necho "stub npx invoked: $*"\nexit ${npxExitCode}\n`,
  );
  chmodSync(stub, 0o755);

  const r = spawnSync(
    "bash",
    [
      join(REPO, "scripts", "seed-env.sh"),
      "--url",
      "mongodb://stub/db",
      "--step",
      "1",
    ],
    {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      timeout: 60_000,
    },
  );
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("MONEY-1238 — seed-env.sh carries a failed step to its exit code", () => {
  it("a failing step makes the SCRIPT fail, and says which step", () => {
    // THE DEFECT: every failure printed "Step N FAILED. Continuing..." (a line
    // that could not actually be reached under `set -e`) and the run still
    // ended on "All Seeding Complete!" with exit 0. A caller — including the
    // founder reading the last line after a 3-hour run — had no signal.
    const { status, out } = runSeedEnv(1);
    assert.notEqual(status, 0, `expected non-zero exit, got ${status}\n${out}`);
    assert.match(
      out,
      /step\(s\) FAILED/i,
      "the run must name the failed step(s) in its final output",
    );
    assert.doesNotMatch(
      out,
      /All Seeding Complete!/,
      "a run with a failed step must not print the success banner",
    );
  });

  it("an all-green run still exits 0 and still prints the success banner", () => {
    // The control. Without it, a test that only checks the failure path would
    // also pass if the script had been broken to fail unconditionally.
    const { status, out } = runSeedEnv(0);
    assert.equal(status, 0, `expected exit 0, got ${status}\n${out}`);
    assert.match(out, /All Seeding Complete!/);
    assert.doesNotMatch(out, /step\(s\) FAILED/i);
  });

  it("run-to-completion is preserved — the step is not aborted mid-run", () => {
    // The reason this is NOT fixed by letting `set -e` abort: the script
    // documents 2-3 hours across 15 steps and offers --step/--from to resume.
    // Aborting would discard completed work AND contradict the documented
    // contract. Continue, accumulate, fail at the end.
    const { out } = runSeedEnv(1);
    assert.match(
      out,
      /Continuing\.\.\./,
      "a failed step must still let the remaining steps run",
    );
  });
});

describe("MONEY-1238 — setup-scheduler.sh records failed deletes", () => {
  const SRC = read("scripts/ops/setup-scheduler.sh");
  const CODE = stripShellComments(SRC);

  it("no `jobs delete` swallows its failure with `|| true`", () => {
    // Each of the three sites had a distinct, silent consequence: a renamed job
    // firing beside its replacement; the legacy weekly prod->QA sync surviving
    // so BOTH it and the daily one run `mongorestore --drop` over QA; and a
    // prod-only scrape job left enabled in QA, which is the entire thing
    // PROD_ONLY_JOBS exists to prevent.
    const offenders = CODE.split("\n").filter(
      (l) => /gcloud scheduler jobs delete/.test(l) && /\|\|\s*true/.test(l),
    );
    assert.deepEqual(
      offenders,
      [],
      `these deletes still discard their failure:\n${offenders.join("\n")}`,
    );
  });

  it("every `jobs delete` site reaches a FAILED_JOBS append", () => {
    // Structural, but on the WIRING rather than on prose: `FAILED_JOBS+=(` is
    // an append, which a comment mentioning the array cannot satisfy.
    const lines = CODE.split("\n");
    const sites = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /gcloud scheduler jobs delete/.test(l));
    assert.ok(
      sites.length >= 3,
      `expected >=3 delete sites, found ${sites.length}`,
    );
    for (const { l, i } of sites) {
      const window = lines.slice(i, i + 8).join("\n");
      assert.match(
        window,
        /FAILED_JOBS\+=\(/,
        `delete site has no FAILED_JOBS append within 8 lines: ${l.trim()}`,
      );
    }
  });

  it("FAILED_JOBS decides the exit code", () => {
    // The append is only worth anything because something consumes it.
    assert.match(
      CODE,
      /if \[ "\$\{#FAILED_JOBS\[@\]\}" -ne 0 \]; then\s*\n\s*exit 1/,
      "a non-empty FAILED_JOBS must exit non-zero",
    );
  });
});

describe("MONEY-1238 — update-prod-analysis-engine.sh fails on an unhealthy deploy", () => {
  const SRC = read("scripts/ops/update-prod-analysis-engine.sh");
  const CODE = stripShellComments(SRC);

  it("a non-200 health check sets the verdict", () => {
    // THE DEFECT: "✗ Workers unhealthy (HTTP 503)" was followed immediately by
    // a green "Done!" and exit 0. After ~300 lines of build output the red line
    // has scrolled off, so a crash-looping revision read as a good deploy.
    assert.match(
      CODE,
      /Workers unhealthy[\s\S]{0,200}?VERIFY_FAILED=1/,
      "the unhealthy branch must set the verdict flag",
    );
  });

  it("the verdict decides the exit code, and does so LAST", () => {
    // Last on purpose: the summary and manual-steps list are what the operator
    // acts on, so they must still print. What must not survive is exit 0.
    assert.match(
      CODE,
      /VERIFY_FAILED:-0\}" -ne 0 \][\s\S]*exit 1/,
      "an unhealthy deploy must exit non-zero",
    );
    const tail = CODE.trimEnd().split("\n").slice(-12).join("\n");
    assert.match(
      tail,
      /VERIFY_FAILED/,
      "the gate must be at the end of the script",
    );
  });

  it("the build-failure diagnostic is reachable", () => {
    // `gcloud builds submit` was called bare, so under `set -e` the script
    // aborted before its own `if [ $? -ne 0 ]` could print where to look.
    assert.match(CODE, /gcloud builds submit[\s\S]{0,400}?\|\| BUILD_RC=\$\?/);
    assert.match(CODE, /if \[ "\$BUILD_RC" -ne 0 \]; then/);
    assert.doesNotMatch(
      CODE,
      /gcloud builds submit[\s\S]{0,400}?\n\s*if \[ \$\? -ne 0 \]/,
      "an unreachable `$?` check must not come back",
    );
  });
});
