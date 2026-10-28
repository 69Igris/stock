#!/bin/bash
# ============================================
# Document-repair runner (MONEY-1319 / 1321)
# ============================================
# One wrapper for the three one-shot document repairs, invoked the way every
# other data job in this repo is: `{job} {qa|prod} [--apply]`.
#
# ## Why a wrapper, when each script already takes --env
#
# NOT for secret plumbing — each script resolves DATABASE_URL_{ENV} and its
# bucket from Secret Manager itself. The wrapper exists for ONE reason:
#
#     THE ORDER IS LOAD-BEARING AND GETTING IT WRONG IS UNRECOVERABLE.
#
# `recover` must run BEFORE `quarantine`. The quarantine blanks `gcsPath` on
# rows whose stored bytes are a web page. The recovery reads those same bytes to
# find the real document link inside them. Run the quarantine first and the
# bytes are gone: 604 SEBI + 196 ICRA rows classify `noBytes`, the census reads
# clean, and the process exits 0 while the content is unrecoverable.
#
# Both scripts CLAIMED the order did not matter — they said the recovery
# "re-fetches sourceUrl" when gcsPath is blank. There was no such code path.
# That is now guarded in the quarantine itself (it refuses --apply while any row
# it would clear is one the recovery could still save), and `all` below encodes
# the same order so the guard is never the only thing standing between an
# operator and 790 destroyed rows.
#
# ## The jobs
#
#   recover     recover-html-stock-documents.ts
#               1,320 rows whose stored bytes are HTML. TWO lanes:
#                 800 one-hop  the page carries a link to the real document
#                              (SEBI 604 + ICRA 196) — fetched and stored.
#                 520 text     CRISIL 442 / Brickwork 69 / Acuite 9, where the
#                              HTML *is* the rating rationale. NOTHING is
#                              fetched; the content is already held.
#
#   retype      repair-doc-containers.ts
#               172 rows stored as `application/pdf` whose bytes are a ZIP from
#               nsearchives.nseindia.com holding a real document. 126 of them
#               are already FAILED, so Document AI calls have been spent on
#               archive bytes. Re-queued to PENDING once the type is honest.
#               6 further objects are 11-20 MB of NUL and need a re-fetch
#               (MONEY-1329 — they sit in PROCESSING, which no job selects).
#
#   quarantine  quarantine-html-stock-documents.ts
#               321 rows whose bytes are a page and are NOT recoverable.
#               Sets gcsPath: "", fileSize: 0, processingStatus UNSUPPORTED,
#               keeping sourceUrl / title / description.
#               511 rating-agency rows are structurally EXCLUDED — they classify
#               `htmlIsTheDocument`, and ids reach the write set only inside the
#               `html` branch. Quarantining them would destroy content we hold.
#
#   all         recover -> retype -> quarantine, in that order, stopping on the
#               first failure.
#
# ## Dry run is the default, everywhere
#
# Without --apply every job prints what it WOULD do and writes nothing. Run the
# dry run and READ IT before applying: these populations move as the nightly
# syncs add rows, so a count from yesterday is not a count from today.
#
# --apply on each underlying script is TTY-GATED and that is deliberate. It is
# an anti-wrapper guard: there is no --yes, and this wrapper does not and must
# not defeat it. An agent runs the dry runs; a human runs the write.
#
# ## Usage
#
#   ./scripts/ops/run-doc-repair.sh recover    prod
#   ./scripts/ops/run-doc-repair.sh recover    prod --apply
#   ./scripts/ops/run-doc-repair.sh retype     prod --doc-type annual_report   # DRY RUN ONLY
#       (repair-doc-containers.ts refuses --doc-type together with --apply)
#   ./scripts/ops/run-doc-repair.sh quarantine prod --apply
#   ./scripts/ops/run-doc-repair.sh all        prod --apply
#
# Extra arguments after the environment are forwarded VERBATIM to the script.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The `|| exit 1` on `cd` CANNOT fire on its own: a failed command substitution
# yields an EMPTY string and `cd ""` returns 0 in bash, so the script would
# continue from the caller's cwd and the relative script paths below would fail
# with an opaque MODULE_NOT_FOUND. Test the variable, not the cd.
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ]; then
    echo "run-doc-repair: could not resolve the repository root" >&2
    exit 1
fi
cd "$REPO_ROOT" || exit 1

# POSITIONAL, NOT BY VALUE.
#
# This loop used to match JOB and ENV_NAME by VALUE anywhere in argv, last-wins.
# Reproduced on this repo's bash 3.2.57:
#
#   run-doc-repair.sh retype prod --doc-type all   ->  JOB=all
#       a single retype silently promoted into the full recover -> retype ->
#       quarantine chain, i.e. the destructive one.
#   run-doc-repair.sh recover qa --host prod       ->  ENV_NAME=prod
#       a QA run silently retargeted at PRODUCTION.
#
# Any flag whose VALUE happens to be a job name or an environment name rewrites
# the run. The job and the environment are positional by contract, so they are
# read positionally.
JOB="${1:-}"
ENV_NAME="${2:-}"
shift 2 2>/dev/null || true
EXTRA_ARGS=("$@")

case "$JOB" in
    recover|retype|quarantine|all) ;;
    *) JOB="" ;;
esac
case "$ENV_NAME" in
    qa|prod) ;;
    *) ENV_NAME="" ;;
esac

usage() {
    echo "Usage: $0 {recover|retype|quarantine|all} {qa|prod} [--apply] [script args…]" >&2
    echo "" >&2
    echo "  recover     1,320 HTML-bodied rows: 800 one-hop fetch + 520 text-is-the-document" >&2
    echo "  retype      172 rows typed application/pdf whose bytes are a ZIP (126 already FAILED)" >&2
    echo "  quarantine  321 unrecoverable pages; 511 rating-agency rows are EXCLUDED by class" >&2
    echo "  all         recover -> retype -> quarantine, in that order" >&2
    echo "" >&2
    echo "Dry-run is the default. --apply is TTY-gated by each script, deliberately." >&2
    exit 1
}

[ -n "$JOB" ] || usage
[ -n "$ENV_NAME" ] || usage

# The scripts take --env themselves and resolve their own secrets from Secret
# Manager. Passing it through rather than exporting a DATABASE_URL here is what
# keeps the bucket and the database resolving from ONE source — a hand-set
# DATABASE_URL beside a defaulted bucket is how a QA run writes prod bytes into
# QA rows.
run_one() {
    local name="$1" script="$2"
    echo ""
    echo "=============================================================="
    echo "  ${name}  (${ENV_NAME})"
    echo "=============================================================="
    CLOUDSDK_ACTIVE_CONFIG_NAME="${CLOUDSDK_ACTIVE_CONFIG_NAME:-stockbook}" \
        node --import tsx "$script" --env "$ENV_NAME" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
    local rc=$?
    if [ $rc -ne 0 ]; then
        echo "" >&2
        echo "${name} exited ${rc} — stopping. Nothing after this point ran." >&2
        return $rc
    fi
}

RECOVER="scripts/migrations/recover-html-stock-documents.ts"
RETYPE="scripts/data/repair-doc-containers.ts"
QUARANTINE="scripts/migrations/quarantine-html-stock-documents.ts"

case "$JOB" in
    recover)    run_one "recover"    "$RECOVER" ;;
    retype)     run_one "retype"     "$RETYPE" ;;
    quarantine) run_one "quarantine" "$QUARANTINE" ;;
    all)
        # ONLY --apply may accompany `all`. The three scripts have DISJOINT
        # KNOWN_FLAGS sets and each asserts them before doing any work, so a
        # flag valid for one is fatal to another — and it is fatal LATE:
        # `all prod --apply --concurrency 8` performs the recover WRITES and the
        # retype WRITES, then quarantine aborts on an unknown flag, leaving the
        # order-critical repair HALF APPLIED. Refusing up front is the only
        # place that failure can be made harmless.
        for arg in ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}; do
            if [ "$arg" != "--apply" ]; then
                echo "run-doc-repair: '$arg' cannot be used with 'all'." >&2
                echo "  The three scripts take DIFFERENT flags, and one they do not" >&2
                echo "  share aborts the chain PART WAY THROUGH — after earlier" >&2
                echo "  writes have landed. Run the job that takes it on its own:" >&2
                echo "    $0 retype $ENV_NAME $arg" >&2
                exit 1
            fi
        done
        # The order is the entire reason this branch exists. `recover` reads the
        # bytes that `quarantine` blanks, so reversing them destroys 790 rows
        # and reports success.
        run_one "recover"    "$RECOVER"    || exit $?
        run_one "retype"     "$RETYPE"     || exit $?
        run_one "quarantine" "$QUARANTINE" || exit $?
        ;;
esac
