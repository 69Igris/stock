/**
 * EVERY workspace's test glob must be QUOTED — MONEY-1093, re-closed by
 * MONEY-1489's review.
 *
 * ## Why this exists at the repo level rather than in one package
 *
 * MONEY-1093: `--test __tests__/**\/*.test.ts` left UNQUOTED is expanded by the
 * shell, which reads `**` as a single `*` and hands node a truncated file list.
 * It failed ASYMMETRICALLY — where the shell glob matched nothing the literal
 * pattern reached node, whose own glob IS recursive, and everything ran; where
 * it matched something the shell won and silently truncated the set. 45 files
 * and 3,093 cases never executed while `TEST-COVERAGE.md` counted them.
 *
 * MONEY-1489 added a per-invocation case-count FLOOR and cited this defect as
 * its reason to exist. Review measured that the floor **cannot see it**, and
 * for two independent reasons — after shell expansion the trailing argument is
 * a concrete PATH, so (a) the wrapper's `isGlobRun` test is false and no floor
 * is looked up at all, and (b) the derived key names a single file, which is
 * unrecorded, and an unrecorded key reports rather than fails. Measured on a
 * 7-case fixture with a recorded floor of 7: quoted-with-a-file-missing fires
 * and exits 1; UNQUOTED drops 4 of 7 cases, prints `floor n/a — file-list run`,
 * and exits 0.
 *
 * Patching `isGlobRun` would trade a silent skip for a silent "not recorded".
 * The defect is the QUOTING, so this asserts the quoting — directly, on every
 * workspace, which is also the only form that covers `apps/web`, where
 * MONEY-1093 actually bit and which carries the largest floor.
 *
 * The pre-existing pin (`spawntest-lane-wiring.test.ts`) asserts the same
 * property for `packages/core` alone — 1 of 21 workspaces.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { parseLanes } from "./test-lane-harness";

/** packages/core/__tests__/ops -> repo root. */
const repoRoot = (): string =>
  join(import.meta.dirname, "..", "..", "..", "..");

/** Every workspace package.json that defines a `test` script. */
function workspaceTestScripts(): Array<{ name: string; script: string }> {
  const root = repoRoot();
  const dirs: string[] = [join(root, "workers")];
  for (const group of ["apps", "packages"]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(base, entry.name));
    }
  }

  const out: Array<{ name: string; script: string }> = [];
  for (const dir of dirs) {
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.test;
    if (typeof script !== "string" || !script.includes("--test")) continue;
    out.push({ name: pkg.name ?? dir, script });
  }
  return out;
}

const WORKSPACES = workspaceTestScripts();

describe("every workspace's test glob is quoted (MONEY-1093 / MONEY-1489)", () => {
  /**
   * PREMISE. Without this the suite is vacuous: if the enumeration broke, or
   * the scripts moved to a runner this parser does not recognise, every
   * assertion below would pass over an empty list. Two counts compared with
   * `>=` are exactly how an empty population reads OK for ever.
   */
  it("[premise] finds the workspaces it reasons over", () => {
    assert.ok(
      WORKSPACES.length >= 15,
      `only found ${WORKSPACES.length} workspaces with a node --test script — ` +
        `the enumeration is stale`,
    );
  });

  it("[premise] parses at least one lane out of every one of them", () => {
    const unparsed = WORKSPACES.filter(
      (w) => parseLanes(w.script).length === 0,
    ).map((w) => w.name);
    assert.deepEqual(
      unparsed,
      [],
      `parseLanes read no invocation from these scripts, so their quoting is ` +
        `unchecked — the parser has drifted from how they are written:\n  ` +
        `${unparsed.join("\n  ")}`,
    );
  });

  it("REGRESSION: no workspace passes an unquoted glob to node --test", () => {
    const offenders: string[] = [];
    for (const { name, script } of WORKSPACES) {
      for (const lane of parseLanes(script)) {
        // A literal path carries no wildcard, so the shell cannot rewrite it.
        if (!lane.glob.includes("*")) continue;
        if (!lane.quoted) offenders.push(`${name}: ${lane.glob}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `These globs are UNQUOTED, so the shell expands them before node sees ` +
        `them and silently truncates the file set (MONEY-1093). Node's own ` +
        `glob is recursive; the shell's is not. Quote them:\n  ` +
        `${offenders.join("\n  ")}`,
    );
  });

  it("the parser SEES an unquoted glob (mutation check)", () => {
    // Without this, a parser that reported `quoted: true` unconditionally — or
    // one that matched nothing — would make the assertion above unfalsifiable.
    const bad = parseLanes(
      "node --test --test-timeout=30000 __tests__/**/*.test.ts",
    );
    assert.equal(bad.length, 1, "parser did not read the unquoted sample");
    assert.equal(
      bad[0]?.quoted,
      false,
      "parser called an unquoted glob quoted",
    );

    const good = parseLanes(
      'node --test --test-timeout=30000 "__tests__/**/*.test.ts"',
    );
    assert.equal(good[0]?.quoted, true, "parser called a quoted glob unquoted");
  });
});
