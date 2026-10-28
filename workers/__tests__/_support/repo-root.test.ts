/**
 * MONEY-1327 — the one repo-root resolver, and the arm that must never fall open.
 *
 * ## What is being tested, and why it is not obvious
 *
 * A repo-root helper looks untestable: it returns a directory, and the only
 * directory available to compare against is the one it returned. The three
 * properties that actually matter are all falsifiable, though, and each one
 * corresponds to a defect this repo has already paid for:
 *
 *   IT THROWS         A miss must be an error, never a plausible directory.
 *                     Three of the eleven copies returned `process.cwd()`, so a
 *                     source-scanning guard built on one would read the wrong
 *                     tree, match zero files and PASS. That is MONEY-1314.
 *   IT IGNORES cwd    The answer must not depend on whether the suite was run
 *                     by `yarn workspace @usemoney/workers test` (cwd =
 *                     `workers/`) or by `node --test workers/__tests__/…` from
 *                     the repo root. This is the property the anchor buys and
 *                     the walk only approximated.
 *   IT IS THE ONLY ONE  A twelfth hand-pasted copy re-creates the divergence
 *                     the ticket removed, and nothing else in the tree would
 *                     notice.
 *
 * The first is exercised through `assertRepoRoot`, which exists precisely so
 * the failure arm can be reached WITHOUT breaking the module. A guard whose
 * only failure path requires sabotaging the guard is a guard nobody has ever
 * seen fail.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertRepoRoot,
  declaresOwnRepoRootWalk,
  repoRoot,
  REPO_ROOT_WALK_PATTERNS,
} from "./repo-root";

describe("MONEY-1327 — repoRoot() resolves the workspace root", () => {
  it("lands on a directory that is REALLY the root, cross-checked three ways", () => {
    // Not "it returned a string". `yarn.lock` alone is what the helper itself
    // checks, so asserting only that would be the helper marking its own
    // homework — these are independent facts about the same directory.
    const root = repoRoot();
    assert.ok(existsSync(join(root, "yarn.lock")), `${root}/yarn.lock`);
    assert.ok(existsSync(join(root, "workers", "src")), `${root}/workers/src`);
    assert.ok(existsSync(join(root, "packages")), `${root}/packages`);
    const pkg = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { workspaces?: unknown };
    assert.ok(
      Array.isArray(pkg.workspaces),
      "the resolved root's package.json declares no workspaces, so it is a " +
        "PACKAGE root rather than the monorepo root — the exact miss that " +
        "`packages/core/turbo.json` caused when the anchor was `turbo.json`",
    );
  });

  it("gives the same answer from any cwd", () => {
    // THE property the anchor buys. The walk it replaces started at
    // `process.cwd()`, so it was correct only because every caller happened to
    // be run from inside the tree. Run from `/` the old walk found no
    // `yarn.lock` in eight steps and — in three of the eleven copies —
    // cheerfully returned `/`.
    if (typeof process.chdir !== "function") {
      // Under `--experimental-test-isolation=none` node runs files in worker
      // threads, where `chdir` is absent. Skipping is honest; silently passing
      // a cwd test that never changed the cwd is not.
      assert.ok(true, "chdir unavailable in this runner — property not driven");
      return;
    }
    const before = process.cwd();
    const expected = repoRoot();
    try {
      process.chdir(tmpdir());
      assert.notEqual(
        process.cwd(),
        before,
        "the chdir did not take, so this case proves nothing",
      );
      assert.equal(
        repoRoot(),
        expected,
        "the resolved root moved with the cwd — the helper is searching from " +
          "the cwd again rather than anchoring on its own location",
      );
    } finally {
      process.chdir(before);
    }
  });
});

describe("MONEY-1327 — the failure arm THROWS and never falls back", () => {
  it("refuses a directory with no yarn.lock", () => {
    const notARoot = mkdtempSync(join(tmpdir(), "money1327-"));
    assert.throws(
      () => assertRepoRoot(notARoot),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /no yarn.lock/);
        assert.match(
          err.message,
          /REFUSING to fall back/,
          "the message must name the refusal, because the whole finding is " +
            "that three copies did fall back",
        );
        return true;
      },
      "a directory with no lockfile was accepted as the workspace root",
    );
  });

  it("does not hand back process.cwd() — the shape that reads as green", () => {
    // The mutation this file exists for, run as an assertion instead. A
    // fallback returns a REAL directory, so everything downstream keeps
    // working: `join()` succeeds, `existsSync` is false, the read yields "" and
    // a scan over "" matches nothing and reports no violations.
    //
    // Proved rather than asserted: build the wrong root the fallback would have
    // produced, and show a guard over it finds ZERO of something that really
    // does exist under the right one.
    const notARoot = mkdtempSync(join(tmpdir(), "money1327-"));
    const target = join("workers", "src", "processors", "circulars-sync.ts");
    assert.ok(
      existsSync(join(repoRoot(), target)),
      "fixture drift: the file this case scans for must exist",
    );
    assert.equal(
      existsSync(join(notARoot, target)),
      false,
      "a wrong root must not accidentally contain the target",
    );
    // …and the helper refuses to be that wrong root in the first place.
    assert.throws(() => assertRepoRoot(notARoot));
  });
});

describe("MONEY-1327 — there is exactly ONE copy of the walk", () => {
  it("no test file re-declares its own repo-root walk", () => {
    // The ratchet. Eleven copies drifted into two incompatible failure
    // policies; nothing in the tree could have noticed a twelfth. This fires on
    // the SHAPE (a cwd walk looking for the lockfile), not on the name, because
    // the copies were called `repoRoot`, `REPO_ROOT` and — in one apps/web
    // case — nothing at all.
    const ROOT_DIR = join(import.meta.dirname, "..");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) files.push(full);
      }
    };
    walk(ROOT_DIR);
    assert.ok(
      files.length > 50,
      `expected 50+ files under workers/__tests__, walked ${files.length} — ` +
        `a scan that finds nothing passes`,
    );

    // Two exemptions, and both are the file that OWNS the rule: the helper
    // itself (the one legitimate lockfile check, and where the patterns are
    // declared) and this suite (whose `[meta]` case below must contain the
    // forbidden shape verbatim, or it cannot prove the scan fires on it).
    // Nothing else is exempt, and the list is two literals rather than a
    // pattern so a third cannot join it quietly.
    const EXEMPT = new Set([
      join(import.meta.dirname, "repo-root.ts"),
      join(import.meta.dirname, "repo-root.test.ts"),
    ]);
    const offenders = files.filter((f) => {
      if (EXEMPT.has(f)) return false;
      return declaresOwnRepoRootWalk(readFileSync(f, "utf8"));
    });
    assert.deepEqual(
      offenders.map((f) => f.slice(ROOT_DIR.length + 1)),
      [],
      "These re-declare the repo-root walk instead of importing " +
        "`_support/repo-root`. Eleven copies is how the tree ended up with " +
        "two contradictory answers to `what if we cannot find the root` — " +
        "eight throwing, three returning a plausible-but-wrong directory that " +
        "makes a source scan match nothing and pass.",
    );
  });

  it("[meta] the scan FIRES on the shape it forbids — driving the REAL filter", () => {
    // Both arms, through `declaresOwnRepoRootWalk` ITSELF.
    //
    // This case used to re-declare the two regexes and assert them against its
    // own sample. So weakening the arms the scan above runs left THIS case —
    // the one whose entire job is to prove they fire — green against a private
    // duplicate: measured, both arms replaced with patterns matching nothing,
    // 6/6 still passing. That is the stale-copy defect this module was written
    // to delete, rebuilt one layer up inside the file deleting it. Nothing
    // below restates a pattern; every assertion runs the exported one.
    const copy = [
      "function repoRoot(): string {",
      "  let dir = resolve(process.cwd());",
      "  for (let i = 0; i < 8; i++) {",
      '    if (existsSync(join(dir, "yarn.lock"))) return dir;',
      "  }",
      "  return resolve(process.cwd());",
      "}",
    ].join("\n");
    assert.ok(
      declaresOwnRepoRootWalk(copy),
      "the filter does not fire on a verbatim copy of the walk it forbids, so " +
        "the scan above reports an empty offender list for any reason at all",
    );

    // ONE WITNESS PER ARM, each carrying only its own shape. The whole-copy
    // sample cannot separate "both arms fire" from "one arm fires and the
    // other matches nothing" — which is exactly what a weakening leaves behind.
    const WITNESSES: readonly string[] = [
      '    if (existsSync(join(dir, "yarn.lock"))) return dir;',
      "  return resolve(process.cwd());",
    ];
    assert.equal(
      WITNESSES.length,
      REPO_ROOT_WALK_PATTERNS.length,
      "an arm was added to REPO_ROOT_WALK_PATTERNS with no witness here, so " +
        "nothing proves that arm fires — add the sample it is meant to catch",
    );
    for (const [i, witness] of WITNESSES.entries()) {
      const firing = REPO_ROOT_WALK_PATTERNS.filter((p) => p.test(witness));
      assert.equal(
        firing.length,
        1,
        `witness ${i} must be matched by EXACTLY ONE arm. 0 means that arm has ` +
          `been weakened into matching nothing; 2+ means an arm has been ` +
          `loosened until the witnesses no longer isolate it, and a per-arm ` +
          `weakening would stop being visible here`,
      );
      assert.ok(
        declaresOwnRepoRootWalk(witness),
        `witness ${i} is not recognised by the filter the scan actually runs`,
      );
    }

    // The other direction. A pattern loosened until it matches everything
    // turns the scan permanently red, which is a different way of ceasing to
    // be read.
    assert.equal(
      declaresOwnRepoRootWalk(
        'import { repoRoot } from "../_support/repo-root";\n' +
          "const ROOT = repoRoot();\n",
      ),
      false,
      "the filter fires on a COMPLIANT file, so the scan reports offenders " +
        "that are not offenders",
    );
  });
});
