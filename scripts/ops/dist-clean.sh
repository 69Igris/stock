#!/usr/bin/env bash
# Remove untracked `dist/` directories across the monorepo.
#
# Why this exists:
#   The original script was `find . -name "dist" -type d -prune -exec rm -rf`,
#   which nukes EVERY `dist/` it finds - including
#   `apps/web/public/datafeeds/udf/dist/bundle.js`, a 600+ KB pre-built
#   TradingView UDF bundle that lives inside the public folder and IS
#   committed to git (Vercel can't run rollup at deploy time).
#
#   After `yarn full-clean && yarn install`, the bundle was missing
#   because:
#     a. dist-clean removed it
#     b. yarn install does NOT restore tracked files (only deps)
#     c. the postinstall sync hook is gated behind
#        SYNC_CHARTING_LIBRARY=1 (intentional - see
#        feedback_chart_sync_explicit.md)
#     d. `yarn build` doesn't rebuild the UDF bundle (it's its own
#        subproject not wired into the main turbo graph)
#
#   So the user saw `git status` reporting bundle.js as deleted on every
#   full-clean cycle.
#
# Fix:
#   Iterate every `dist/` directory and ask git whether it tracks any
#   files inside. If it does, skip - those files belong to the repo,
#   not to a build artefact. Otherwise rm -rf.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# Find all `dist/` directories outside node_modules (npm-clean already
# nukes those). The /usr/bin/find -prune avoids descending into
# matched dirs (faster on a clean tree, harmless on a dirty one).
find . \
  -path "*/node_modules" -prune -o \
  -name "dist" -type d -print 2>/dev/null \
  | while read -r dir; do
    # Strip leading ./ for git's path comparison
    rel="${dir#./}"

    # Does git track ANY file inside this dist/ ? If so, it's a
    # checked-in artefact (e.g. apps/web/public/datafeeds/udf/dist/) -
    # leave it alone.
    #
    # `git -C "$rel"` runs the query INSIDE the directory, so it resolves to
    # whichever repository actually owns it. Asking from $ROOT instead only ever
    # consults the SUPERPROJECT's index, and a submodule's files are not in it —
    # `git ls-files vendor/charting_library/datafeeds/udf/dist/bundle.js` from
    # the root answers "did not match any file(s) known to git" for a file the
    # submodule tracks perfectly well. So the guard returned "untracked" and the
    # clean deleted it, on every single build.
    #
    # That is why `vendor/charting_library` showed as permanently modified: not
    # a stray local edit, the build doing it each time. It also made the
    # push-gate's tree hash depend on whether a build had run since the marker
    # was written, which blocks `git push` with a content-changed error nobody
    # can explain from `git status` alone.
    if [ -n "$(git -C "$rel" ls-files . 2>/dev/null)" ]; then
      echo "[dist-clean] skip $rel (git-tracked artefact)"
      continue
    fi

    echo "[dist-clean] rm -rf $rel"
    rm -rf "$dir"
  done
