/**
 * `run-market-data-job.sh` — every declared job must be REACHABLE, and every
 * dry-run-by-default job must declare its opt-in flag. MONEY-1255.
 *
 * This wrapper has now produced the same defect three times, in three different
 * shapes, and each one FAILED SILENTLY:
 *
 *   1. MONEY-1252 — `xbrl-reparse` is dry-run-by-default and takes `--apply`,
 *      but the wrapper consumed `--apply` and forwarded NOTHING. The flag
 *      reached the job as neither flag, so it did what its own default says:
 *      41,924 rows read, 24,165 reported as changed, NOTHING written, exit 0,
 *      54 minutes. The only tell was `apply=false` in a line nobody diffs
 *      against the command they typed. Fixed with a per-job `APPLY_FLAG`.
 *
 *   2. This ticket — `docfinrecon` was given a `SCRIPT=` and an `APPLY_FLAG=`
 *      but never added to the argument allowlist, so the job NAME fell through
 *      to the catch-all, `JOB` stayed empty, and the wrapper printed usage and
 *      exited. A fully-declared job that could not be invoked at all.
 *
 *   3. `bseresults` was about to ship the same way.
 *
 * The through-line: a DECLARATION that nothing forwards is indistinguishable
 * from a working job until someone runs it, and these are jobs people run
 * quarterly at best. So the contract is asserted here rather than trusted.
 *
 * A note on what this file can and cannot see: it reads the shell script as
 * TEXT. It cannot prove the wrapper works; it proves the three lists that must
 * agree do agree. That is exactly the gap all three defects lived in — each
 * one was a single list disagreeing with another.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Package-relative, matching the sibling guard `no-feed-fetch-bypass.test.ts`
// (`join("..", "..", "workers", …)`): these suites run with the workspace as
// cwd. `__dirname` is unavailable — packages/core is ESM.
const WRAPPER = join("..", "..", "scripts", "ops", "run-market-data-job.sh");

const src = readFileSync(WRAPPER, "utf8");

/** Job names the argument parser will actually bind to `JOB`. */
function allowlistedJobs(src: string): string[] {
  // The `case` arm that assigns JOB, e.g. `aliases|derive|…) JOB="$1"; shift ;;`
  const m = src.match(/^\s*([a-z|]+)\)\s*JOB="\$1"/m);
  return m ? m[1].split("|").filter(Boolean) : [];
}

/** Job names that carry a `SCRIPT=` declaration. */
function declaredJobs(src: string): string[] {
  return [...src.matchAll(/^\s*([a-z]+)\)\s*SCRIPT="/gm)].map((m) => m[1]);
}

/** Job names whose declaration also sets a non-empty APPLY_FLAG. */
function jobsDeclaringApplyFlag(src: string): string[] {
  return [
    ...src.matchAll(/^\s*([a-z]+)\)\s*SCRIPT="[^\n]*APPLY_FLAG="--/gm),
  ].map((m) => m[1]);
}

const allowlisted = allowlistedJobs(src);
const declared = declaredJobs(src);
const withApplyFlag = jobsDeclaringApplyFlag(src);

describe("run-market-data-job.sh job contract (MONEY-1255)", () => {
  // ── Falsifiable ceiling ───────────────────────────────────────────
  // Every assertion below is "list A ⊆ list B". If a regex stopped matching,
  // both lists would be empty and every one of them would pass vacuously —
  // which is the same shape as the defects being guarded against.

  it("[meta] the parsers find real jobs — no assertion may pass vacuously", () => {
    assert.ok(
      allowlisted.length >= 10,
      `parsed ${allowlisted.length} allowlisted jobs; the case-arm regex has drifted`,
    );
    assert.ok(
      declared.length >= 10,
      `parsed ${declared.length} declared jobs; the SCRIPT= regex has drifted`,
    );
    // Pin known members so a half-working parser cannot hide either.
    for (const known of ["aliases", "docqueue", "xbrlreparse"]) {
      assert.ok(
        allowlisted.includes(known),
        `allowlist parser missed the known job "${known}"`,
      );
      assert.ok(
        declared.includes(known),
        `declaration parser missed the known job "${known}"`,
      );
    }
    assert.ok(
      withApplyFlag.length >= 2,
      `parsed ${withApplyFlag.length} APPLY_FLAG declarations; regex drifted`,
    );
  });

  // ── The contract ──────────────────────────────────────────────────

  it("every DECLARED job is reachable from the argument parser", () => {
    const unreachable = declared.filter((j) => !allowlisted.includes(j));
    assert.deepStrictEqual(
      unreachable,
      [],
      `these jobs have a SCRIPT= declaration but are NOT in the case arm that ` +
        `binds JOB, so the name falls through to the catch-all, JOB stays ` +
        `empty, and the wrapper prints usage and exits. A declared job nobody ` +
        `can invoke is how docfinrecon shipped dead.`,
    );
  });

  it("every ALLOWLISTED job actually has a script to run", () => {
    const dangling = allowlisted.filter((j) => !declared.includes(j));
    assert.deepStrictEqual(
      dangling,
      [],
      `these job names are accepted by the parser but have no SCRIPT= ` +
        `declaration, so they would resolve to an empty script path`,
    );
  });

  it("every job is named in the usage line", () => {
    const usage = src.match(/echo "Usage: \$0 \{([^}]+)\}/)?.[1] ?? "";
    const named = usage.split("|").filter(Boolean);
    assert.ok(named.length >= 10, "usage line did not parse — regex drifted");
    const missing = allowlisted.filter((j) => !named.includes(j));
    assert.deepStrictEqual(
      missing,
      [],
      "a job the parser accepts but the usage line never mentions is " +
        "undiscoverable — the operator cannot find out it exists",
    );
  });

  it("the dry-run-by-default jobs declare their opt-in flag", () => {
    // These take `--apply` to opt IN. The wrapper CONSUMES `--apply` and
    // re-emits only $APPLY_FLAG, so a missing declaration means the flag
    // reaches the job as NEITHER flag and the run silently does nothing.
    // `xbrl-backfill` is deliberately NOT here: it applies BY DEFAULT and
    // takes `--dry-run` to opt out, the exact OPPOSITE contract. Declaring
    // one for it would arm a job whose default is already armed.
    for (const job of [
      "docqueue",
      "xbrlreparse",
      "docfinrecon",
      "bseresults",
    ]) {
      assert.ok(
        withApplyFlag.includes(job),
        `${job} is dry-run-by-default and MUST declare APPLY_FLAG="--apply", ` +
          `or the wrapper swallows the flag and the run reads everything, ` +
          `reports what it would change, writes nothing, and exits 0`,
      );
    }
  });

  it("the OPPOSITE-contract job does not declare an opt-in flag", () => {
    // The other half of the pairing. Without this, "declare APPLY_FLAG
    // everywhere" would look like the safe default — and it would arm
    // xbrl-backfill's already-armed default a second time.
    assert.ok(
      declared.includes("xbrl"),
      "ceiling: the apply-by-default job is missing entirely",
    );
    assert.ok(
      !withApplyFlag.includes("xbrl"),
      "xbrl-backfill applies BY DEFAULT and opts out with --dry-run; " +
        "declaring an --apply flag for it inverts its contract",
    );
  });
});
