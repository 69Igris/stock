/**
 * `--test-force-exit` is BANNED from test scripts — MONEY-1083.
 *
 * ## What it was doing
 *
 * The flag makes `node --test` exit the moment the top-level run reports
 * complete, killing any test FILE still in flight. It does not fail. It just
 * reports fewer tests, and CI goes green either way.
 *
 * Measured on this repo, same command and same shell, only the flag differing:
 *
 *   apps/web   with --test-force-exit   15,552 tests
 *   apps/web   without                  15,844 tests   (stable across runs)
 *
 * 292 tests silently dropped from a single run of the largest suite, and which
 * 292 varied run to run — three consecutive runs on an unchanged tree gave
 * 15,691 / 15,712 / 15,797, all reporting `# fail 0`. Diffing the suite lists
 * showed whole files appearing and disappearing (`core/import parseCSVRow`,
 * `pure import pipeline`, `coupon.service — recordCouponRedemption`).
 *
 * That means a green suite was not evidence that a given test ran — which
 * quietly undermines every gate built on it, including `yarn verify:push`.
 *
 * ## Why removing it is safe
 *
 * The flag existed to stop orphaned handles wedging a run. That job now
 * belongs to `scripts/test-timeout.ts`, a wall-clock watchdog that SIGKILLs
 * the whole process group after a hard deadline — a strictly better mechanism,
 * because it kills a genuinely stuck run instead of truncating a healthy one.
 * Every workspace was verified to exit cleanly without the flag before it was
 * removed.
 *
 * If a suite ever starts hanging, fix the orphaning test (clear the timer,
 * close the client) — do NOT bring this flag back. Silently dropping tests is
 * a worse failure than a visible hang.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// CWD is apps/web; walk up to the repo root.
const REPO_ROOT = join("..", "..");
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  ".git",
  ".turbo",
  "vendor",
  // `.claude/worktrees/**` holds git worktree checkouts of OTHER branches
  // (git-ignored via .git/info/exclude). Scanning them made this repo's result
  // depend on whatever a parallel session happened to have on disk: every
  // in-tree manifest was already clean, yet the check failed on ~60 stale
  // copies. A worktree cut from an old commit would re-break it at any time.
  ".claude",
]);

function* findPackageJsons(dir: string, depth = 0): Generator<string> {
  if (depth > 3) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* findPackageJsons(full, depth + 1);
    else if (entry === "package.json") yield full;
  }
}

describe("no --test-force-exit in any test script (MONEY-1083)", () => {
  const manifests = [...findPackageJsons(REPO_ROOT)];

  it("finds the workspaces (scan is live)", () => {
    // Guards against the scan passing vacuously because the walk broke.
    assert.ok(
      manifests.length >= 10,
      `expected to find the monorepo's package.json files, found ${manifests.length}`
    );
  });

  it("no package.json script uses --test-force-exit", () => {
    const offenders: string[] = [];

    for (const file of manifests) {
      let pkg: { scripts?: Record<string, string> };
      try {
        pkg = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        if (
          typeof script === "string" &&
          script.includes("--test-force-exit")
        ) {
          offenders.push(`${file} → "${name}"`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "--test-force-exit silently truncates a run: it kills test FILES still " +
        "in flight and still reports `# fail 0`, so CI goes green while tests " +
        "never ran (292 dropped from apps/web alone). scripts/test-timeout.ts " +
        "is the wall-clock guard now. Fix the orphaning test instead.\n" +
        offenders.join("\n")
    );
  });

  it("the wall-clock watchdog that replaces it still exists", () => {
    // Removing the flag is only safe because this is here. If it goes, the
    // reasoning above no longer holds.
    const guard = readFileSync(
      join(REPO_ROOT, "scripts", "test-timeout.ts"),
      "utf8"
    );
    assert.match(guard, /SIGKILL/);
    assert.match(guard, /TEST_TIMEOUT_MS/);
  });

  it("test scripts still route through the watchdog where they did before", () => {
    // apps/web has the largest suite and the longest history of wedging; its
    // script must keep the wrapper.
    const web = JSON.parse(
      readFileSync(join(REPO_ROOT, "apps", "web", "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };
    assert.match(
      web.scripts?.test ?? "",
      /scripts\/test-timeout\.ts/,
      "apps/web's test script must keep the wall-clock watchdog"
    );
  });
});
