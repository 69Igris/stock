/**
 * `scripts/` is type-checked, and the gate stays wired — MONEY-1238.
 *
 * ## The gap this closes
 *
 * `yarn type-check` is `turbo run type-check`, and turbo only reaches
 * WORKSPACES (`apps/*`, `packages/*`, `workers`). `scripts/` is none of those,
 * so the ~73 files under it — `feed-parse`, `xbrl-backfill`, the F3 reconcile
 * whose verdict gates the XBRL switchover, and the one-shot migrations that
 * write to production — were type-checked by NOTHING. A `scripts/tsconfig.json`
 * existed the whole time and was never executed by anything: config without a
 * caller reads as coverage, which is worse than an obvious absence.
 *
 * `build` cannot substitute. `tsup` and Next compile through esbuild, which
 * strips types without checking them — the reason `run-verify.sh` runs
 * type-check FIRST and calls it "the one gate `build` cannot provide".
 *
 * ## Why this test does NOT run tsc
 *
 * The real check runs where it belongs: inside `yarn type-check`, which
 * `run-verify.sh` step [1/3] and CI's `Typecheck` step both execute, AFTER
 * `yarn db:generate` has produced the Prisma client the scripts import. Running
 * a second compiler from inside the test suite would take ~9s of a unit-test
 * run, and would go red for the wrong reason in any environment where the
 * generated client is absent — a flake that teaches people to ignore it.
 *
 * What this asserts instead is the WIRING, because the wiring is the part that
 * was missing for the config's entire life and is the part a refactor deletes
 * without noticing. The three ways this gate can die are each pinned:
 *
 *   1. the root `type-check` script stops invoking the runner;
 *   2. the tsconfig stops covering the tree (a narrowed `include`, a broadened
 *      `exclude`, or `noEmit` dropped so the check starts emitting);
 *   3. the baseline is used as a dumping ground — a file that never had
 *      pre-existing errors acquiring an allowance, which is how a ratchet turns
 *      into a rubber stamp.
 *
 * Pure `readFileSync` + `JSON.parse`. No subprocess, no timer, nothing to
 * orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** CWD is packages/core when this suite runs. */
const ROOT = join(process.cwd(), "..", "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
  scripts: Record<string, string>;
};
const TSCONFIG_RAW = readFileSync(
  join(ROOT, "scripts", "tsconfig.json"),
  "utf-8",
);
const RUNNER = join(ROOT, "scripts", "ops", "typecheck-scripts.ts");
const BASELINE_PATH = join(
  ROOT,
  "scripts",
  "ops",
  "typecheck-scripts-baseline.json",
);

/** The tsconfig carries `//` comments, which `JSON.parse` rejects. */
function parseJsonc<T>(raw: string): T {
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as T;
}

describe("scripts/ reaches the type-check gate", () => {
  it("`yarn type-check` runs the scripts checker, not only turbo", () => {
    // The whole defect in one assertion: `turbo run type-check` alone cannot
    // see a non-workspace directory, so for as long as this was the entire
    // command, `scripts/` was unchecked.
    const cmd = PKG.scripts["type-check"];
    assert.ok(cmd, "root package.json has no type-check script");
    assert.match(
      cmd,
      /turbo run type-check/,
      "the workspace half of the gate must survive",
    );
    assert.match(
      cmd,
      /type-check:scripts/,
      "type-check must also check scripts/ — turbo cannot reach it",
    );
    // `&&`, never `;` or `||`: a scripts failure has to fail the command, or
    // the gate reports success over a tree that does not compile.
    assert.match(cmd, /turbo run type-check\s*&&/);
  });

  it("the scripts checker points at the runner that exists", () => {
    const cmd = PKG.scripts["type-check:scripts"];
    assert.ok(cmd, "no type-check:scripts script");
    assert.match(cmd, /scripts\/ops\/typecheck-scripts\.ts/);
    assert.ok(existsSync(RUNNER), "the runner the script names does not exist");
  });

  it("the runner FAILS the process on a new error", () => {
    // A checker that prints and exits 0 is the shape MONEY-1238's sibling
    // findings are full of. Both arms must exit non-zero: new errors, and a
    // baseline that has gone stale in the generous direction.
    //
    // Each arm is sliced to its OWN block, bounded by the next block's first
    // line — NOT by a character count. A fixed window is how this assertion
    // first passed vacuously: at 900 chars the regression slice reached past
    // its own `process.exit(1)` into the improvement branch's, so setting the
    // regression branch to `exit(0)` still matched. Mutation-checked both ways.
    const src = readFileSync(RUNNER, "utf-8");
    const regressionAt = src.indexOf("NEW type errors under scripts/");
    const improvementAt = src.indexOf("the baseline is now too generous");
    const tailAt = src.indexOf("const remaining", improvementAt);
    assert.ok(regressionAt > 0, "the runner does not report new errors");
    assert.ok(
      improvementAt > regressionAt,
      "the runner does not report a stale baseline after the regression block",
    );
    assert.ok(tailAt > improvementAt, "the improvement block has no end");
    for (const [name, block] of [
      ["regression", src.slice(regressionAt, improvementAt)],
      ["improvement", src.slice(improvementAt, tailAt)],
    ] as const) {
      assert.match(
        block,
        /process\.exit\(1\)/,
        `the ${name} branch prints without failing the process`,
      );
    }
  });
});

describe("the scripts tsconfig still covers the tree", () => {
  const cfg = parseJsonc<{
    compilerOptions?: Record<string, unknown>;
    include?: string[];
    exclude?: string[];
  }>(TSCONFIG_RAW);

  it("includes BOTH .ts and .mts", () => {
    // `scripts/jobs/xbrl-projection-drain-logic.mts` is the drain's own
    // decision logic and was outside `./**/*.ts` — unchecked even once the
    // gate existed.
    assert.deepEqual(
      [...(cfg.include ?? [])].sort(),
      ["./**/*.mts", "./**/*.ts"],
      "a narrowed include silently drops files from the gate",
    );
  });

  it("excludes nothing but node_modules", () => {
    // The cheapest way to make a red gate green is to exclude the file. This
    // is the assertion that makes that a visible decision.
    assert.deepEqual(cfg.exclude, ["node_modules"]);
  });

  it("is a CHECK, not a build — noEmit stays on", () => {
    assert.equal(cfg.compilerOptions?.noEmit, true);
  });
});

describe("the baseline is a ratchet, not a dumping ground", () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as Record<
    string,
    Record<string, number>
  >;

  it("names only files that exist", () => {
    // A stale entry is an allowance nobody can spend and nobody can see is
    // dead — and it keeps the total looking worse than it is.
    for (const file of Object.keys(baseline)) {
      assert.ok(
        existsSync(join(ROOT, file)),
        `${file} is in the baseline but gone`,
      );
    }
  });

  it("covers only scripts/ — never a workspace file", () => {
    // A diagnostic outside `scripts/` is a statement about this TSCONFIG (a
    // missing `jsx`, a wrong `moduleResolution`), not about any script. Fix the
    // config; do not grant a package an allowance from here, where the package's
    // own `type-check` cannot see it.
    for (const file of Object.keys(baseline)) {
      assert.match(
        file,
        /^scripts\//,
        `${file} is outside scripts/ — fix scripts/tsconfig.json instead`,
      );
    }
  });

  it("records COUNTS per TS error code, never line numbers", () => {
    // Line numbers move on every edit above them, so a line-keyed baseline
    // goes red on unrelated changes and gets regenerated blindly — which is
    // the same as having no baseline.
    for (const [file, codes] of Object.entries(baseline)) {
      const entries = Object.entries(codes);
      assert.ok(entries.length > 0, `${file} has an empty allowance`);
      for (const [code, count] of entries) {
        assert.match(
          code,
          /^TS\d+$/,
          `${file}: ${code} is not a TS error code`,
        );
        assert.ok(
          Number.isInteger(count) && count > 0,
          `${file}: ${code} allowance must be a positive integer`,
        );
      }
    }
  });

  it("does not grant an allowance to the XBRL scripts this ticket touched", () => {
    // The files MONEY-1238 works in are clean and must stay clean. If one of
    // them ever appears here, the baseline absorbed a regression instead of the
    // gate catching it.
    for (const file of [
      "scripts/data/xbrl-ratios-validate.ts",
      "scripts/data/xbrl-reconcile.ts",
      "scripts/jobs/xbrl-backfill.ts",
      "scripts/jobs/xbrl-projection-drain.ts",
      "scripts/jobs/xbrl-projection-drain-logic.mts",
      "scripts/ops/typecheck-scripts.ts",
    ]) {
      assert.equal(
        baseline[file],
        undefined,
        `${file} must type-check clean, not carry an allowance`,
      );
    }
  });
});
