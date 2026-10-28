/**
 * ONE repo-root resolver for the workers test suite — MONEY-1327.
 *
 * ## The eleven copies, and the three that failed open
 *
 * Eleven files under `workers/__tests__` each carried their own `repoRoot()`,
 * every one of them the same eight-iteration walk up from `process.cwd()`
 * looking for `yarn.lock`. The walk itself is fine — it is self-correcting, and
 * it is NOT the cwd defect MONEY-1326 fixed. What eleven copies could not agree
 * on was **what to do when the walk finds nothing**:
 *
 *     8 files   `throw new Error("repoRoot(): no yarn.lock above …")`
 *     3 files   `return resolve(process.cwd())`
 *
 * The three that fall back are `log-boundary.test.ts`, `auth-middleware.test.ts`
 * and `us-eod-sync-logic.test.ts`. A fallback returns a PLAUSIBLE directory, so
 * every path built on it resolves against the wrong tree, every source read
 * comes back empty, and a scan that matches zero files reports zero
 * violations — a guard that has silently stopped guarding while staying green.
 * That is MONEY-1314's defect exactly, and it is worse here than a crash would
 * be, because a crash is visible.
 *
 * Two of the eleven had already WRITTEN THIS DOWN and reached opposite
 * conclusions in the same directory: `write-authority-and-perscheme.test.ts`
 * says "Throws rather than falling back to cwd — a structural test that cannot
 * find its subject must fail loudly", while `us-eod-sync-logic.test.ts` keeps
 * the fallback and compensates one layer down by making its own `readRepoFile`
 * throw instead. A rule stated twice and disagreeing is the shape MONEY-1255
 * measured at 1,211 unreachable rows.
 *
 * ## Why this ANCHORS instead of walking
 *
 * This module sits a FIXED distance from the repo root
 * (`workers/__tests__/_support/` → three up), so it does not need to search for
 * it. That removes `process.cwd()` from the question altogether — the answer no
 * longer depends on whether the suite was run by `yarn workspace @usemoney/workers
 * test` (cwd = `workers/`) or by `node --test workers/__tests__/…` from the repo
 * root. It is also the dominant idiom in this very directory: of the workers
 * test files that read from disk, 25 already anchor on `import.meta.dirname`
 * and only these 11 searched.
 *
 * The `yarn.lock` check SURVIVES the change, as an ASSERTION rather than as the
 * search key. Anchoring alone would fail silently if this file ever moved —
 * `join(dirname, "..", "..", "..")` always produces *a* directory — so the
 * marker is what makes the anchor falsifiable. `yarn.lock` and not `turbo.json`:
 * Turborepo 2.x package configurations mean a `turbo.json` can and does live
 * inside a package (`packages/core/turbo.json` exists), so it is not a root
 * marker at all, while a Yarn workspace has exactly one lockfile at its root by
 * definition (MONEY-1198).
 *
 * ## It THROWS. Always.
 *
 * There is no fallback and no "" — a caller that cannot find its subject must
 * fail loudly rather than assert about an empty string. {@link assertRepoRoot}
 * is exported separately so that failure arm can be EXERCISED by a test without
 * anyone having to break this module to see it work.
 *
 * ## The filename is load-bearing
 *
 * `repo-root.ts`, not `repo-root.test.ts`. `TEST_FILE_SUFFIX_SRC` in
 * `scripts/gen-test-coverage.ts` is `\.(?:spawn)?test\.tsx?`, so a `.test.ts`
 * suffix would make this a test file declaring no tests: `node --test` would
 * load it as a suite and the coverage inventory would count a file with 0
 * cases, drifting the headline the doc-freshness gate compares against. Same
 * constraint, and the same reason, as `packages/core/__tests__/ops/test-lane-harness.ts`
 * and `packages/datadog/__tests__/job-outcome-source-scan.ts`.
 *
 * ## Scope
 *
 * Workers only, deliberately. Eleven more copies of the same walk live in
 * `packages/core`, `packages/services` and `apps/web`, and reaching them from
 * here would mean either a cross-workspace relative import into another
 * package's `__tests__` (which no test in this repo does — the two existing
 * shared test modules are both imported by a `./`-relative path inside their
 * own workspace) or a new `"./test-support"` entry in a published `exports`
 * map, i.e. shipping a test helper as part of a runtime package's public
 * surface. Neither is worth a build edge; each workspace should get its own
 * copy of THIS file, which is one small module rather than eleven divergent
 * functions.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The repo root, derived from this file's own location.
 *
 * `workers/__tests__/_support/repo-root.ts` → three levels up. Not exported:
 * everything goes through {@link repoRoot}, so the marker check cannot be
 * skipped by reaching around it.
 */
const ANCHORED_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/**
 * Return `candidate` if it is the workspace root, else THROW.
 *
 * Exported for one reason: it makes the failure arm testable without editing
 * this module. A guard whose only failure path can be reached by breaking the
 * guard is a guard nobody ever sees fail.
 */
export function assertRepoRoot(candidate: string): string {
  if (existsSync(join(candidate, "yarn.lock"))) return candidate;
  throw new Error(
    `repoRoot(): ${candidate} has no yarn.lock, so it is not the workspace ` +
      `root. REFUSING to fall back to process.cwd() (${process.cwd()}) — a ` +
      `plausible-but-wrong root makes every source read return "" and turns a ` +
      `scanning guard into one that matches nothing and passes.`,
  );
}

/** The monorepo root. Throws if the anchor no longer lands on it. */
export function repoRoot(): string {
  return assertRepoRoot(ANCHORED_ROOT);
}

/**
 * The SHAPES that constitute a hand-rolled repo-root walk, one per arm.
 *
 * Exported, and living HERE rather than inline in the ratchet, for the same
 * reason `assertRepoRoot` is exported: so the check can be DRIVEN by a test
 * instead of RESTATED by one. The `[meta]` case in `repo-root.test.ts` used to
 * carry its own copy of these two regexes and assert them against its own
 * sample — which meant weakening the ratchet's arms left the case that exists
 * to prove they fire entirely green, against a private duplicate. That is the
 * stale-copy defect this whole module was written to remove, rebuilt one layer
 * up inside the file removing it.
 *
 * Matched on the SHAPE, not the name: the eleven copies were called `repoRoot`,
 * `REPO_ROOT` and — in one apps/web case — nothing at all.
 *
 * Arms are kept SEPARATE rather than alternated into one pattern so each can be
 * driven by its own witness; a single `|` regex cannot tell "both arms work"
 * from "one arm works and the other matches nothing". No `g` flag anywhere:
 * `lastIndex` on a shared RegExp would make `.test()` stateful across files.
 */
export const REPO_ROOT_WALK_PATTERNS: readonly RegExp[] = [
  /existsSync\(join\(\s*dir\s*,\s*["']yarn\.lock["']\)\)/,
  /resolve\(process\.cwd\(\)\)/,
];

/**
 * Does `src` re-declare its own repo-root walk instead of importing this module?
 *
 * THE filter the ratchet runs. One definition, two callers (the scan and the
 * case that proves the scan fires), so a weakened arm cannot stay green.
 */
export function declaresOwnRepoRootWalk(src: string): boolean {
  return REPO_ROOT_WALK_PATTERNS.some((pattern) => pattern.test(src));
}
