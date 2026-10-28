#!/bin/sh
# run-verify.sh — the full pre-push verification:
#   prisma generate -> coverage-check -> python tests -> type-check ->
#   build -> test --force.
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
# ## The gate's contract (MONEY-1164)
#
# This gate exists to guarantee CI will be green. That is only true while its
# phases are a SUPERSET of `.github/workflows/test.yml`'s steps — a gate that
# checks less than CI is worse than no gate, because it converts "CI is red"
# into "CI is red AND I was told it wouldn't be". Two divergences had already
# opened up:
#
#   1. CI runs `yarn test:coverage-check`; the gate did not. PR #285 passed
#      here (23/23 build, 24,478 tests, marker written) and went red on GitHub
#      with "TEST-COVERAGE.md says 930 test files; 931 exist on disk". That
#      check counts a SHARED file, so it breaks whenever another branch lands
#      test files — precisely the drift a pre-push gate should catch.
#
#   2. CI sets `NODE_OPTIONS: --max-old-space-size=4096` for the typecheck
#      (test.yml); the gate set nothing. `apps/web#build` then OOMs on a normal
#      dev machine (SIGABRT after ~5 minutes of otherwise-green work). The
#      failure mode is what makes this urgent rather than annoying: the natural
#      reaction to a spurious OOM is `VERIFY_GATE_BYPASS=1`, which defeats the
#      gate entirely.
#
#   3. CI runs `yarn db:generate`; the gate did not. See PHASE 0.
#
# If a step is added to test.yml, add it here too — and that is not left to
# memory: apps/web/__tests__/ci/verify-gate-parity.test.ts parses both files
# and fails when a CI step has no counterpart here.
#
# Env:
#   VERIFY_SERIAL=1  use the authoritative serialized run
#                    (`turbo run test --concurrency=1 --force`) instead of
#                    `yarn test --force`. Slower; use when the parallel run
#                    fails at TASK level with zero failing test cases
#                    (resource-contention flake — see TEST-COVERAGE.md).
#   NODE_OPTIONS     respected if already set; otherwise defaulted to CI's
#                    --max-old-space-size=4096 (see PHASE 0 below).

set -u

# Heap ceiling for the COMPILE phases only — deliberately not exported.
#
# Node sizes its default old-space from total system RAM, which is why this
# bites unevenly: a dev machine gets ~4.1 GB and a CI runner ~2.08 GB, so the
# same tree can OOM in one place and pass in the other. Pinning the same
# explicit ceiling is what makes the gate's answer mean something.
#
# It is applied per-phase rather than exported because CI applies it per-step:
# test.yml sets it on `Typecheck` and NOT on `Run tests`. Exporting it globally
# would ALSO raise the ceiling for every `node:test` worker, and apps/web forks
# a lot of them — each then grows its heap further before collecting, which on a
# memory-pressured machine turns into 30s `testTimeoutFailure`s in files that
# pass in isolation. Observed exactly that: four unrelated files timing out per
# run, a different four each time, all green when run alone.
#
# APPENDED to the caller's NODE_OPTIONS, never substituted for it.
#
# This was `${NODE_OPTIONS:---max-old-space-size=4096}`, which REPLACES. Any
# unrelated value already in the environment — `--trace-warnings`, `--inspect`,
# a corporate TLS setting — silently removed the heap ceiling this phase exists
# to provide, and the build died with the exact SIGABRT the phase prevents. The
# notice below was guarded by `[ -z "$NODE_OPTIONS" ]`, so it was suppressed in
# precisely the failing case and the operator got no hint their own env var was
# the cause.
#
# Ours goes FIRST so a caller's own value still wins: Node takes the LAST
# occurrence of a duplicated V8 flag, so
# `NODE_OPTIONS=--max-old-space-size=8192 yarn verify:push` still raises the
# ceiling, while an unrelated flag now composes instead of clobbering.
VERIFY_NODE_OPTIONS="--max-old-space-size=4096 ${NODE_OPTIONS:-}"
# Printed unconditionally — the case worth seeing is the one where the caller
# HAS set something.
echo "verify: compile phases use NODE_OPTIONS=$VERIFY_NODE_OPTIONS (matching .github/workflows/test.yml)"

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

# [0/4] Generate the Prisma client BEFORE anything type-checks against it.
#
# A third CI-parity gap, and the least obvious: test.yml runs
# `yarn db:generate` as its own step BEFORE the coverage/typecheck/test steps
# (the "Generate Prisma client" step). The gate had no equivalent.
#
# It matters locally more than in CI, because CI checks out one branch into a
# clean tree. turbo's `build` task declares
# `dependsOn: ["^build", "db:generate"]`, so a build always regenerates;
# `type-check` declares only `["^type-check"]`. Since type-check runs before
# build here, it reads whatever client happens to be in node_modules. After
# switching branches that is the OTHER branch's schema, and the failure
# surfaces as a baffling type error in application code rather than as "your
# client is stale":
#
#   src/documents.service.ts(118,11): error TS2353: Object literal may only
#   specify known properties, and 'processingError' does not exist in type
#   'UserDocumentSelect<DefaultArgs>'.
#
# There is no `postinstall` generate either, so a fresh clone has the same gap.
# `db:generate` is `cache: false` in turbo.json, so this is always a real run.
echo "verify: [0/5] prisma generate (schema -> client)"
if ! yarn turbo run db:generate; then
  echo "" >&2
  echo "verify: PRISMA GENERATE FAILED — no marker written." >&2
  rm -f "$MARKER"
  exit 1
fi

# [1/4] TEST-COVERAGE.md freshness — CI's first gate, and the cheapest.
#
# Ordered first to mirror test.yml, and because it is the only phase whose
# input is a SHARED file: it compares the doc's headline against the test files
# on disk, so another branch landing tests can turn it red without this branch
# changing. Catching that in seconds beats catching it after a 5-minute build
# and a push.
echo "verify: [1/5] yarn test:coverage-check"
if ! yarn test:coverage-check; then
  echo "" >&2
  echo "verify: COVERAGE DOC STALE — no marker written." >&2
  echo "verify: TEST-COVERAGE.md's headline disagrees with the test files on" >&2
  echo "verify: disk. Update it (it is the source of truth), then re-run." >&2
  echo "verify: CI runs this same check, so pushing would go red on GitHub." >&2
  rm -f "$MARKER"
  exit 1
fi

# [2/5] The Python suite — services/us-fundamentals (MONEY-979).
#
# Placed here, third, for the reason the coverage check is placed first: it is
# CHEAP (~1.5 s against minutes for build and test) and it is INDEPENDENT of
# everything below it, so a Python failure surfaces before five minutes of
# TypeScript work rather than after.
#
# `yarn test` cannot cover this. turbo builds its task graph from the Yarn
# workspaces, and a Python directory is not one — which is exactly why
# services/ sits outside apps/* and packages/*. Without this phase the gate
# would promise "CI will be green" while never running a suite CI runs.
#
# The runner HARD-FAILS when no Python 3.12 is present rather than skipping.
# SKIP_PYTHON_TESTS=1 is the deliberate, loud opt-out.
echo "verify: [2/5] yarn test:python"
if ! yarn test:python; then
  echo "" >&2
  echo "verify: PYTHON TESTS FAILED — no marker written." >&2
  echo "verify: CI runs this same suite (the 'yarn test:python' job), so" >&2
  echo "verify: pushing would go red on GitHub." >&2
  rm -f "$MARKER"
  exit 1
fi

# [2/4] Typecheck — the one `build` cannot provide: Next/tsup compile via
# esbuild, which strips types without checking them, so a build can be green
# while the tree does not typecheck. CI blocks on this step (MONEY-1157), so
# verifying without it would let a push pass here and fail there.
echo "verify: [3/5] yarn type-check"
if ! NODE_OPTIONS="$VERIFY_NODE_OPTIONS" yarn type-check; then
  echo "" >&2
  echo "verify: TYPECHECK FAILED — no marker written. Fix the types, then re-run yarn verify:push" >&2
  rm -f "$MARKER"
  exit 1
fi

# The ceiling applies here too, even though CI has no build step: the OOM that
# motivated MONEY-1164 was `apps/web#build` (SIGABRT), not the typecheck.
echo "verify: [4/5] yarn build"
if ! NODE_OPTIONS="$VERIFY_NODE_OPTIONS" yarn build; then
  echo "" >&2
  echo "verify: BUILD FAILED — no marker written. Fix the build, then re-run yarn verify:push" >&2
  echo "verify: an OOM here (SIGABRT / 'heap out of memory') means the ceiling" >&2
  echo "verify: needs raising, not bypassing: NODE_OPTIONS=--max-old-space-size=8192 yarn verify:push" >&2
  rm -f "$MARKER"
  exit 1
fi

echo "verify: [5/5] tests"
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
  # Records what was actually verified, so a marker from an older revision of
  # this script is legible rather than silently over-trusted.
  echo "command=yarn test:coverage-check && yarn type-check && yarn build && $test_cmd"
  echo "node_options=$VERIFY_NODE_OPTIONS (compile phases only)"
} > "$MARKER"

echo ""
echo "verify: PASS — marker written ($MARKER)"
echo "verify: git push is now unlocked for this exact tree content."
