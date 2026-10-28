/**
 * `dist-clean` must not delete git-tracked artefacts — including ones inside a
 * SUBMODULE.
 *
 * Some `dist/` paths are checked in (the TradingView UDF bundle, because Vercel
 * cannot run rollup at deploy time), so the script skips any `dist/` that holds
 * tracked files. That guard asked the SUPERPROJECT's index:
 *
 *     git ls-files vendor/charting_library/datafeeds/udf/dist/bundle.js
 *     -> "did not match any file(s) known to git"
 *
 * A submodule's files are not in the superproject's index, so the guard
 * answered "untracked" for a file the submodule tracks perfectly well, and
 * every `yarn build` deleted it. That is why `vendor/charting_library` showed as
 * permanently modified — not a stray local edit, the build doing it each time.
 *
 * It also made the verify-gate's tree hash depend on whether a build had run
 * since the marker was written, which blocks the gated remote update with a
 * content-changed error that `git status` alone cannot explain.
 *
 * The fix is `git -C "$rel" ls-files .` — run the query INSIDE the directory so
 * it resolves to whichever repository owns it.
 *
 * ## Why the vendored bundle is checked CONDITIONALLY
 *
 * `actions/checkout` does not fetch submodules unless asked, and this repo's
 * workflow does not ask. So on CI `vendor/charting_library` is an EMPTY
 * directory backed by a gitlink, and any assertion that requires the file to
 * exist fails there while passing on every developer machine. The first version
 * of this test did exactly that and turned CI red.
 *
 * The behavioural rule is therefore asserted against whichever tracked `dist/`
 * artefacts are actually present, and the premise below refuses to let that
 * degrade into "none, so nothing was checked". The SOURCE assertion — that the
 * script queries the owning repo — needs no artefact and always runs, which is
 * the part that would catch a revert of the fix.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SCRIPT = join(ROOT, "scripts", "ops", "dist-clean.sh");

/** Tracked files directly inside `dir`, as the OWNING repo sees them. */
function trackedInside(dir: string): number {
  try {
    const out = execFileSync("git", ["-C", dir, "ls-files", "."], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Tracked files as only the SUPERPROJECT sees them — the old, broken query. */
function trackedFromRoot(rel: string): number {
  try {
    const out = execFileSync("git", ["ls-files", rel], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** `dist/` artefacts that are checked in and must survive a clean. */
const TRACKED_DISTS = [
  {
    label: "apps/web UDF bundle",
    rel: "apps/web/public/datafeeds/udf/dist",
    /** Tracked by the PARENT repo, so present in every checkout including CI. */
    alwaysPresent: true,
  },
  {
    label: "vendored charting_library UDF bundle",
    rel: "vendor/charting_library/datafeeds/udf/dist",
    /** Inside a SUBMODULE — absent on CI, which does not check submodules out. */
    alwaysPresent: false,
  },
] as const;

const present = TRACKED_DISTS.filter((d) => existsSync(join(ROOT, d.rel)));

describe("dist-clean protects tracked artefacts, submodules included", () => {
  it("PREMISE: at least one tracked dist/ artefact is present to check", () => {
    // Without this the loops below iterate an empty list and "pass" having
    // verified nothing — the vacuous-guard shape this repo has shipped before.
    assert.ok(
      present.length > 0,
      "no tracked dist/ artefact found in this checkout; the behavioural " +
        "assertions would be vacuous",
    );
    // The parent-tracked one must ALWAYS be there. If it is not, the checkout
    // is broken rather than merely submodule-less, and skipping would hide it.
    for (const d of TRACKED_DISTS.filter((x) => x.alwaysPresent)) {
      assert.ok(
        existsSync(join(ROOT, d.rel)),
        `${d.rel} is missing — it is tracked by the parent repo and should be ` +
          "in every checkout",
      );
    }
  });

  it("the script asks the OWNING repo, not the superproject", () => {
    // Needs no artefact, so this runs everywhere and is what catches a revert.
    const src = readFileSync(SCRIPT, "utf8");
    assert.match(
      src,
      /git -C "\$rel" ls-files/,
      "the tracked-file check must run inside the directory; querying from the " +
        "repo root silently answers 'untracked' for every submodule artefact",
    );
    assert.doesNotMatch(
      src,
      /^\s*if git ls-files --error-unmatch "\$rel"/m,
      "the superproject-only query is back",
    );
  });

  it("every tracked dist/ present in this checkout is seen as tracked", () => {
    for (const d of present) {
      assert.ok(
        trackedInside(join(ROOT, d.rel)) > 0,
        `${d.label} (${d.rel}) holds no tracked file by the owning repo's ` +
          "index, so dist-clean would delete it",
      );
    }
  });

  it("REGRESSION: the superproject alone cannot see a submodule's file", () => {
    // The defect in one assertion — but only meaningful where the submodule is
    // actually checked out, since an absent directory trivially reports zero.
    const vendored = TRACKED_DISTS.find((d) => !d.alwaysPresent)!;
    if (!existsSync(join(ROOT, vendored.rel))) {
      // Not a silent skip: assert the reason, so "submodule missing" cannot be
      // confused with "rule verified".
      assert.equal(
        trackedFromRoot(vendored.rel),
        0,
        "the submodule is not checked out here (CI), yet the superproject " +
          "reports tracked files under it — that contradicts the premise this " +
          "whole guard rests on",
      );
      return;
    }
    assert.ok(
      trackedInside(join(ROOT, vendored.rel)) > 0,
      "submodule tracks it",
    );
    assert.equal(
      trackedFromRoot(vendored.rel),
      0,
      "the superproject now tracks these files; re-check the guard's reasoning",
    );
  });
});
