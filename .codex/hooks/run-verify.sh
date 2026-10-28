#!/bin/sh
# run-verify.sh — the full pre-push verification: yarn type-check + yarn build + yarn test --force.
#
# On success writes .claude/.verify-ok with a content hash of the working
# tree. pre-push-gate.sh (a Claude Code PreToolUse hook) blocks `git push`
# unless that marker matches the CURRENT tree content, enforcing the standing
# rules "yarn build before commit" and "full yarn test --force before every
# push" deterministically instead of by memory.
#
# Invoke via `yarn verify:push` (or directly). Committing after verifying is
# fine — the hash is content-based, so commit/staging changes don't
# invalidate it; any file edit does.
#
# Env:
#   VERIFY_SERIAL=1  use the authoritative serialized run
#                    (`turbo run test --concurrency=1 --force`) instead of
#                    `yarn test --force`. Slower; use when the parallel run
#                    fails at TASK level with zero failing test cases
#                    (resource-contention flake — see TEST-COVERAGE.md).

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib-tree-hash.sh"

REPO_ROOT=$(git rev-parse --show-toplevel) || exit 1
cd "$REPO_ROOT" || exit 1

MARKER=$(verify_marker_path)

hash_before=$(tree_state_hash) || {
  echo "verify: could not hash the working tree" >&2
  exit 1
}

echo "verify: tree state $hash_before"

# [1/3] Typecheck FIRST — it is the fastest gate and the one `build` cannot
# provide: Next/tsup compile via esbuild, which strips types without checking
# them, so a build can be green while the tree does not typecheck. CI blocks on
# this step (MONEY-1157), so verifying without it would let a push pass here and
# fail there.
echo "verify: [1/3] yarn type-check"
if ! yarn type-check; then
  echo "" >&2
  echo "verify: TYPECHECK FAILED — no marker written. Fix the types, then re-run yarn verify:push" >&2
  rm -f "$MARKER"
  exit 1
fi

echo "verify: [2/3] yarn build"
if ! yarn build; then
  echo "" >&2
  echo "verify: BUILD FAILED — no marker written. Fix the build, then re-run yarn verify:push" >&2
  rm -f "$MARKER"
  exit 1
fi

echo "verify: [3/3] tests"
if [ "${VERIFY_SERIAL:-0}" = "1" ]; then
  test_cmd="turbo run test --concurrency=1 --force"
  yarn turbo run test --concurrency=1 --force
else
  test_cmd="yarn test --force"
  yarn test --force
fi
test_status=$?
if [ $test_status -ne 0 ]; then
  echo "" >&2
  echo "verify: TESTS FAILED — no marker written." >&2
  echo "verify: if zero test CASES failed but a turbo TASK died (parallel resource" >&2
  echo "verify: contention), re-run serialized: VERIFY_SERIAL=1 yarn verify:push" >&2
  rm -f "$MARKER"
  exit 1
fi

# The suite is only proof for the tree it actually ran against. If files
# changed while it ran (another session editing, a background job), the
# marker would certify content the tests never saw — refuse it.
hash_after=$(tree_state_hash) || exit 1
if [ "$hash_before" != "$hash_after" ]; then
  echo "" >&2
  echo "verify: working tree CHANGED during the run ($hash_before -> $hash_after)." >&2
  echo "verify: no marker written — re-run yarn verify:push on the settled tree." >&2
  rm -f "$MARKER"
  exit 1
fi

{
  echo "hash=$hash_after"
  echo "verified_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "command=yarn build && $test_cmd"
} > "$MARKER"

echo ""
echo "verify: PASS — marker written ($MARKER)"
echo "verify: git push is now unlocked for this exact tree content."
