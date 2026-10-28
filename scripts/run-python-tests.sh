#!/usr/bin/env bash
# run-python-tests.sh — the Python half of the test suite (MONEY-979).
#
# Invoked as `yarn test:python`, from BOTH `.github/workflows/test.yml` and
# `.claude/hooks/run-verify.sh`. That it is one yarn script called from both is
# not cosmetic: `apps/web/__tests__/ci/verify-gate-parity.test.ts` extracts every
# `run:` command from the workflow, strips `yarn `, and asserts the gate invokes
# the same script. A CI job that ran `pytest` directly would make the parity
# guard demand `yarn pytest` in the gate, and the honest fix is to have one
# entry point rather than to add an exemption.
#
# Discovers every `services/*/pyproject.toml`, so a second Python service is
# picked up with no change here.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 3.12 is what the Dockerfile and ruff's `target-version` pin. 3.13 is the
# default python3 on a dev machine and is NOT interchangeable — running the
# suite on an interpreter the image does not have proves nothing about the
# image.
#
# Resolved by VERSION, not by binary NAME. GitHub's setup-python installs the
# requested version as `python` / `python3` and does not always expose a
# `python3.12` on PATH, so a name-only check would fail in CI while passing on
# a laptop — the parity gap in the opposite direction.
WANT_MAJOR_MINOR="3.12"

resolve_python() {
  for cand in ${PYTHON_BIN:-} python3.12 python3 python; do
    [ -n "$cand" ] || continue
    command -v "$cand" >/dev/null 2>&1 || continue
    v="$("$cand" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" || continue
    if [ "$v" = "$WANT_MAJOR_MINOR" ]; then echo "$cand"; return 0; fi
  done
  return 1
}

fail() { echo "" >&2; echo "test:python: $*" >&2; exit 1; }

if [ "${SKIP_PYTHON_TESTS:-0}" = "1" ]; then
  echo "test:python: SKIPPED by SKIP_PYTHON_TESTS=1 — the Python suite was NOT run."
  echo "test:python: CI still runs it, so a push may go red on GitHub."
  exit 0
fi

PY_REQUIRED="$(resolve_python)" || PY_REQUIRED=""
if [ -z "$PY_REQUIRED" ]; then
  # Deliberately a HARD FAIL, not a skip. This script is a phase of a gate whose
  # entire promise is "CI will be green", and CI installs 3.12 and runs these
  # tests. Skipping silently would convert "CI is red" into "CI is red AND I was
  # told it wouldn't be" — the exact failure MONEY-1164 documents.
  fail "no Python $WANT_MAJOR_MINOR interpreter found (tried \$PYTHON_BIN,
  python3.12, python3, python).
  Install it (macOS: brew install python@3.12), set PYTHON_BIN to a 3.12
  interpreter, or set SKIP_PYTHON_TESTS=1 to proceed WITHOUT verifying the
  Python suite — which CI will still run."
fi
echo "test:python: interpreter $PY_REQUIRED ($("$PY_REQUIRED" --version 2>&1))"

found=0
status=0

for pyproject in "$ROOT"/services/*/pyproject.toml; do
  [ -e "$pyproject" ] || continue
  found=1
  svc_dir="$(dirname "$pyproject")"
  svc="$(basename "$svc_dir")"
  venv="$svc_dir/.venv"
  stamp="$venv/.deps-stamp"

  echo "test:python: --- $svc ---"

  if [ ! -x "$venv/bin/python" ]; then
    echo "test:python: creating venv ($PY_REQUIRED)"
    "$PY_REQUIRED" -m venv "$venv" || fail "could not create $venv"
  fi

  # Reinstall only when the dependency declaration actually changed. Hashing the
  # file rather than comparing mtimes: a checkout, a stash pop or a rebase all
  # rewrite mtimes without changing content, and reinstalling on every push
  # would make this phase too slow to keep.
  want="$(shasum -a 256 "$pyproject" 2>/dev/null | cut -d' ' -f1)"
  have="$(cat "$stamp" 2>/dev/null || true)"
  if [ "$want" != "$have" ]; then
    echo "test:python: installing deps (pyproject.toml changed)"
    "$venv/bin/python" -m pip install --quiet --upgrade pip || fail "pip upgrade failed in $svc"
    (cd "$svc_dir" && "$venv/bin/python" -m pip install --quiet -e ".[dev]") \
      || fail "dependency install failed in $svc"
    printf '%s' "$want" > "$stamp"
  fi

  # `network` is deselected ALWAYS: a test that reaches sec.gov is not a test,
  # it is an outage waiting to be blamed on us, and it would spend the shared
  # per-IP fair-access budget from a developer laptop. The `redis` marker is NOT
  # deselected — those tests self-skip when no server answers, so CI (which runs
  # a redis service container) executes them and a laptop without redis does not
  # pretend to.
  (cd "$svc_dir" && "$venv/bin/python" -m pytest -q -m "not network") || status=1
done

if [ "$found" -eq 0 ]; then
  # Not "nothing to do" — this script exists because there IS a Python service.
  # An empty glob means services/ moved or the pyproject vanished, and reporting
  # that as success is how a whole suite stops running unnoticed.
  fail "no services/*/pyproject.toml found. If the Python services moved, update
  this script — do not let an empty glob report success."
fi

[ "$status" -eq 0 ] || fail "Python tests FAILED (see output above)."
echo "test:python: all Python suites passed"
