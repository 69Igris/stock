#!/usr/bin/env bash
#
# setup-us-fundamentals-jobs.sh — provision the five SEC EDGAR backfill Cloud Run
# jobs for one environment.
#
# MONEY-979. The history side of the US fundamentals engine, moved off the
# operator's laptop and off the push worker.
#
#   edgar-bulk-submissions-{env}    python -m app.bulk.submissions      2Gi   3h
#   edgar-bulk-companyfacts-{env}   python -m app.bulk.companyfacts     4Gi   6h
#   edgar-xbrl-backfill-{env}       python -m app.bulk.xbrl_backfill    4Gi  24h
#   edgar-ownership-backfill-{env}  python -m app.bulk.ownership_backfill 2Gi 24h
#   edgar-bulk-ftd-{env}            python -m app.bulk.ftd               2Gi   2h
#
# ── WHY JOBS AND NOT A PUSH WORKER ────────────────────────────────────────────
#
# Every push subscription in this project carries a 600s ack deadline, which is
# Pub/Sub's MAXIMUM and cannot be raised. A handler that runs past it is not
# merely slow: Pub/Sub treats the message as unacked and REDELIVERS it, so a
# second copy starts while the first is still running.
#
# `companyfacts.zip` is 1,407,685,214 bytes and `submissions.zip` is
# 1,560,992,008 bytes — measured, not documented. Streaming and iterating either
# one is tens of minutes at best. The Form 4 walk is ~1.4M filings and is
# EXPECTED to span multiple 24h executions. 600 seconds is not a tuning problem.
#
# The nightly freshness legs (`edgar-detect`, the parsers, `edgar-evict`) ARE
# push workers and are different work: a bounded page, sized to fit the
# deadline. These four are HISTORY, and history is one-shot.
#
# ── WHY FOUR JOBS AND NOT ONE PARAMETERISED JOB ───────────────────────────────
#
# Considered and rejected, for the reason `setup-tiingo-backfill-job.sh` gives:
# `gcloud run jobs execute --args=...` REPLACES the container's args rather than
# appending to them, so an entrypoint carried in `--args` is dropped by every
# parameterised execution and the run that forgot would execute the WRONG WALK
# under the right job name. The module path therefore goes in `--command`.
#
# Their argument specs also differ (`--from-fy/--to-fy/--ciks/--tasks` vs
# `--class/--from-date/--to-date`), and their memory and timeout differ by
# design — see the sizing table below.
#
# ── THE ARGV CONTRACT: EQUALS FORM ────────────────────────────────────────────
#
# `--args` is gcloud's `ArgList()`, a COMMA-separated list, so
#   --args=--apply,--from-fy=2020,--to-fy=2026
# arrives as ["--apply", "--from-fy=2020", "--to-fy=2026"].
#
# The Python entry points use argparse, which accepts BOTH `--flag value` and
# `--flag=value`. Use the EQUALS form anyway: the space form becomes two
# comma-separated list items, which works but reads as two flags, and
# `setup-bse-backfill-job.sh` and `setup-tiingo-backfill-job.sh` are exact
# INVERSES of each other on this point — MONEY-1261 lost a whole chain to that
# disagreement. One dialect across every job in this repo is worth more than the
# convenience.
#
# `--ciks` takes a comma-separated list and therefore COLLIDES with `--args`'
# own delimiter. Use gcloud's `^delim^` escape:
#   --args=^:^--apply:--ciks=0000320193,0000789019
#
# ── EGRESS IS ASSUMED, NOT PROVEN — PROBE FIRST ───────────────────────────────
#
# `api.tickertape.in` answers 200 from a laptop and 403 from Cloud Run
# (MONEY-1220), and that block went unnoticed for five months. Nothing in this
# repo has yet fetched sec.gov FROM Cloud Run.
#
# SEC's failure mode is specific and worth knowing before the first long walk:
# an undeclared User-Agent gets 403 with body "Undeclared Automated Tool", and
# exceeding 10 req/s gets "limited for a brief period" for ~10 minutes. Neither
# is a 429 and neither carries Retry-After, so the client classifies on BODY
# TEXT. The banner below names the cheapest probe.
#
# Usage:
#   ./scripts/ops/setup-us-fundamentals-jobs.sh prod
#   ./scripts/ops/setup-us-fundamentals-jobs.sh qa --dry-run
#   ./scripts/ops/setup-us-fundamentals-jobs.sh prod --image=IMG
#   ./scripts/ops/setup-us-fundamentals-jobs.sh prod --only=submissions
#   ./scripts/ops/setup-us-fundamentals-jobs.sh prod --only=ftd
#
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
JOB_SA="stockbook-api@${PROJECT_ID}.iam.gserviceaccount.com"

ENV=${1:-""}
shift || true

IMAGE=""
DRY_RUN=false
ONLY=""

# ── TASK TIMEOUTS, DERIVED PER JOB ────────────────────────────────────────────
#
# Sized from the real walk shapes, not copied from a sibling.
#
#                        work                                  chosen  why
#   bulk-submissions     1.56 GB zip, 988,373 members           24h     see MONEY-1283
#   bulk-companyfacts    1.41 GB zip, ~15k members, 3 writes   6h      2x submissions' per-member cost
#   xbrl-backfill        ~8k CIKs x 6 FY of 10-K/10-Q parses   24h     Cloud Run's MAXIMUM
#   ownership-backfill   ~1.4M Form 4 filings                  24h     EXPECTED to need several runs
#   bulk-ftd             1 index page + 2 files/month, ~1.6MB   2h     48 small downloads at --months=24
#
# All four checkpoint (`backfill_checkpoints`), so a run killed at the timeout
# costs TIME and never WORK — which is what makes `--max-retries=0` right below
# survivable, and what makes the 24h ceiling a budget rather than a promise.
# MONEY-1283. This was 3h, sized from "~15k members" in the table above. The
# real count is 988,373 — a 66x underestimate — and the resume WAS O(members
# already done): the loop READ each finished member back from the GCS stream to
# hash it before it could recognise it as done. Measured 1,691 members/min, so a
# 150-min budget could only ever skip 253,650, and the walk stalled at 25.7% of
# the universe writing nothing. 24h with a 23h in-process budget clears the
# whole universe in one run from any starting position.
#
# THE FIX HAS LANDED, AND THIS 24h STAYS ANYWAY — for now, deliberately. The
# walkers now compare the member CRC + uncompressed size that `zipfile` already
# holds in memory from the central directory, so recognising a finished member
# costs a dict lookup and ZERO GCS requests (app/bulk/common.py, MONEY-1283
# section). That removes the reads rather than buying time to repeat them.
#
# It does NOT justify shrinking these two numbers yet, for two measurable
# reasons:
#
#   1. Every checkpoint written before the fix carries a digest and NO stamp, so
#      the FIRST run after this deploys still reads each of them once to upgrade
#      it in place. That run is the old cost, not the new one. Only the SECOND
#      run measures the fix.
#   2. Nothing has yet measured what a converged pass over 988,373 members
#      actually costs end to end — the central-directory parse of a 1.56 GB zip,
#      ~988k dict lookups, and the members that genuinely did change.
#
# So: after this image is live, let ONE full run upgrade the legacy checkpoints,
# then read the SECOND run's wall clock out of its execution logs. The
# expectation is that ~6h (TASK_TIMEOUT 21600 / BULK_BUDGET 18000, matching
# companyfacts) is ample. Cut them to what that run measured plus headroom —
# never to what this comment guesses. Reducing them before that second run
# exists would be replacing a measurement with a hope, which is how the 3h in
# the first place got written.
TASK_TIMEOUT_SUBMISSIONS="86400"   # 24h — Cloud Run's maximum
TASK_TIMEOUT_COMPANYFACTS="21600"  # 6h
TASK_TIMEOUT_XBRL="86400"          # 24h — Cloud Run's maximum
TASK_TIMEOUT_OWNERSHIP="86400"     # 24h
# 2h against a 1h in-process budget (backfill_logic.FTD_BUDGET_SECONDS). The
# task timeout must exceed budget + one worst item, and an FTD file is ~1.6 MB.
TASK_TIMEOUT_FTD="7200"            # 2h

# MONEY-1283. The in-process budget each bulk job stops itself at lives in CODE,
# per feed, one hour inside that job's own TASK_TIMEOUT so the run checkpoints
# and exits cleanly rather than being killed mid-member:
#
#   submissions   82800  common.DEFAULT_BUDGET_SECONDS[FEED_SUBMISSIONS]
#   companyfacts  18000  common.DEFAULT_BUDGET_SECONDS[FEED_COMPANYFACTS]
#   xbrl          82800  backfill_logic.XBRL_BUDGET_SECONDS
#   ownership     82800  backfill_logic.OWNERSHIP_BUDGET_SECONDS
#   ftd            3600  backfill_logic.FTD_BUDGET_SECONDS
#
# This script deliberately sets NO `EDGAR_BULK_BUDGET_SECONDS`. It used to, at a
# uniform 82800, in the env string every `deploy_job` call shares — which is not
# an override of one job but a FLATTENING of all five. companyfacts (timeout
# 21600) and ftd (timeout 7200) would each have been handed a 23h budget they
# can never reach, so instead of stopping cleanly at their own budget they would
# run until Cloud Run hard-kills them at the task timeout, losing every
# checkpoint since the last flush. Production never had this: only submissions
# carries the variable today, which is why the other four are still correct.
#
# The comment that justified it cited "absent and deliberately-set must be
# distinguishable, that is how MF_METADATA_PROVIDER disabled its job silently".
# True of an ARMING FLAG, where absent means silently OFF. A budget's absent
# means "use the per-feed default above" — a tested value, not a disable — so
# the lesson was imported from the wrong category. `test_every_job_budget_fits_
# inside_its_own_task_timeout` now pins the pairing instead of a comment.
#
# The env var remains an operator override for a single run
# (`--update-env-vars` on one job), which is its documented purpose.

while [ $# -gt 0 ]; do
    case "$1" in
        --image=*)              IMAGE="${1#*=}"; shift ;;
        --only=*)               ONLY="${1#*=}"; shift ;;
        --submissions-timeout=*)  TASK_TIMEOUT_SUBMISSIONS="${1#*=}"; shift ;;
        --companyfacts-timeout=*) TASK_TIMEOUT_COMPANYFACTS="${1#*=}"; shift ;;
        --xbrl-timeout=*)         TASK_TIMEOUT_XBRL="${1#*=}"; shift ;;
        --ownership-timeout=*)    TASK_TIMEOUT_OWNERSHIP="${1#*=}"; shift ;;
        --ftd-timeout=*)          TASK_TIMEOUT_FTD="${1#*=}"; shift ;;
        --dry-run)              DRY_RUN=true; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

case "$ENV" in
    prod)
        BUCKET="stockbook-content-prod"
        DB_SECRET="DATABASE_URL_PROD"
        REDIS_SECRET="REDIS_URL_PROD"
        OPENFIGI_SECRET="OPENFIGI_API_KEY_PROD"
        DD_SECRET="DD_API_KEY_PROD"
        # Matches services/us-fundamentals/cloudbuild.prod.yaml. Prod is the env
        # that MAY fetch sec.gov and archives every bundle it fetches; QA reads
        # that archive rather than spending a second copy of SEC's rate ceiling.
        EGRESS="archive"
        PARSE_APPLY="true"
        ;;
    qa)
        BUCKET="stockbook-content-qa"
        DB_SECRET="DATABASE_URL_QA"
        REDIS_SECRET="REDIS_URL_QA"
        OPENFIGI_SECRET="OPENFIGI_API_KEY_QA"
        DD_SECRET="DD_API_KEY_QA"
        EGRESS="off"
        PARSE_APPLY="false"
        ;;
    *)
        echo "Usage: $0 {prod|qa} [--image=IMG]"
        echo "          [--only=submissions|companyfacts|xbrl|ownership|ftd]"
        echo "          [--submissions-timeout=SECS] [--companyfacts-timeout=SECS]"
        echo "          [--xbrl-timeout=SECS] [--ownership-timeout=SECS] [--ftd-timeout=SECS]"
        echo "          [--dry-run]"
        echo
        echo "Deploys the five SEC EDGAR backfill Cloud Run jobs (MONEY-979)."
        echo "No Scheduler trigger for the two backfills, ever — see the header."
        exit 1
        ;;
esac

# Sent VERBATIM as User-Agent and UNVALIDATED by edgartools. SEC's template is
# `Name email`; an undeclared agent gets 403 "Undeclared Automated Tool". Set
# explicitly and identically to both cloudbuild specs — a job spec does NOT
# inherit the service's env block, and an unset identity here would 403 the
# whole walk in a way that reads like a permissions problem.
EDGAR_IDENTITY="UseMoney deepshaswat@gmail.com"

# One below SEC's documented 10 req/s. Set explicitly so "absent" and
# "explicitly 9" are different states (MONEY-1214), and because the limiter is
# PROACTIVE: SEC documents no 429 and no Retry-After, so an overrun is only
# visible as a 10-minute block after the fact.
SEC_RATE_LIMIT_PER_SEC="9"

SERVICE_NAME="us-fundamentals-${ENV}"

# Per the repo's GCP isolation rule: never activate a config, always pass the
# account/project explicitly on each call.
GC=(gcloud --project="$PROJECT_ID" --account=founder@disdigital.in)

# ── 1. Resolve the image from the live service ────────────────────────────────
echo -e "${BLUE}━━━ 1/3: Resolve image from ${SERVICE_NAME} ━━━${NC}"
IMAGE_SOURCE="explicit --image"
if [ -z "$IMAGE" ]; then
    IMAGE_SOURCE="live ${SERVICE_NAME} service"
    IMAGE="$("${GC[@]}" run services describe "$SERVICE_NAME" \
        --region="$REGION" \
        --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
fi

# FAILS CLOSED. An empty IMAGE must never reach `gcloud run jobs deploy`: it is
# read as "keep whatever is there", which on a re-provision silently preserves
# the stale pin this script exists to move.
if [ -z "$IMAGE" ]; then
    echo -e "${RED}Could not resolve the ${SERVICE_NAME} image.${NC}"
    echo "Is us-fundamentals deployed to ${ENV}? Otherwise pass --image=..."
    exit 1
fi

IMAGE_TAG="${IMAGE##*:}"
IMAGE_SHA="${IMAGE_TAG#"${ENV}"-}"
echo -e "   image  : ${GREEN}${IMAGE}${NC}"
echo -e "   source : ${IMAGE_SOURCE}"
echo -e "   commit : ${GREEN}${IMAGE_SHA}${NC}"

# >>> Cloud Run JOBS pin their image at provision time. A deploy of the SERVICE
# >>> does not move them.
#
# The service's own cloudbuild carries a re-pin step naming these jobs
# EXPLICITLY, so a normal release DOES move them. This script is what CREATES
# them (the re-pin step cannot: `jobs update` fails on a job that does not
# exist) and what owns their env/secret block. Re-run it after any change to the
# five entry points' arguments or to the env they need.
#
# ALL FIVE, including edgar-bulk-ftd, are named in that step as of MONEY-979 —
# and a test derives the list from the `deploy_job` calls below rather than
# trusting this comment, because a job the step does not name keeps the image it
# was provisioned with forever while the others move on every release, and
# nothing reports the difference: the job just runs older code.
echo -e "   ${YELLOW}PREFLIGHT: this image must contain app/bulk/{submissions,companyfacts,"
echo -e "   xbrl_backfill,ownership_backfill,ftd}.py (T5 and T8). On an older image the"
echo -e "   container exits instantly with \"No module named app.bulk.submissions\".${NC}"

# ── 2. Deploy the jobs ────────────────────────────────────────────────────────
echo -e "${BLUE}━━━ 2/3: Cloud Run Jobs ━━━${NC}"

# deploy_job <job-suffix> <python-module> <task-timeout> <memory>
deploy_job() {
    local suffix="$1" module="$2" timeout="$3" memory="$4"
    local job_name="${suffix}-${ENV}"

    local deploy_args=(
        run jobs deploy "$job_name"
        --image="$IMAGE"
        --region="$REGION"
        --service-account="$JOB_SA"
        # The module path belongs in --command, NOT --args. `gcloud run jobs
        # execute --args=...` REPLACES the container's args rather than
        # appending, so with the entry point in --args every parameterised
        # execution would drop it and run a bare `python`. `--args=""` clears
        # the list (there is no --clear-args on jobs deploy); without it a
        # re-deploy KEEPS the old args.
        --command="python,-m,${module}"
        --args=""
        # A retry restarts a multi-hour walk from the top. Cheap in ROWS — all
        # four checkpoint, so re-walking is mostly skips — but NOT cheap against
        # SEC: a task killed by the timeout or by the rate-limit breaker would
        # be restarted straight back into the host that just throttled us,
        # turning a protective abort into a retry loop against a fair-access
        # policy whose penalty is a 10-minute block. Re-running is a human
        # decision.
        --max-retries=0
        --task-timeout="$timeout"
        --memory="$memory"
        --cpu=2
        # Set EXPLICITLY: a job spec does NOT inherit the service's env block.
        #
        # Without GCP_STORAGE_BUCKET the archive writes go nowhere and the walk
        # reports success having stored no bytes — measured on the BSE job, 59
        # rows with an empty gcsPath (MONEY-1258).
        #
        # EDGAR_LOCAL_DATA_DIR is also in the Dockerfile ENV; repeated here so
        # it survives any future base-image change. edgartools mkdirs its data
        # directory AT IMPORT and Cloud Run's FS is read-only outside /tmp, so
        # an unset value kills the container before the first log line.
        #
        # APP_ENV is what the OIDC gate reads. A job has no inbound HTTP, so it
        # never reaches that gate — but /health, the metric env: tag and the
        # flag reporting all key off it, and an unset APP_ENV would tag every
        # job metric env:development.
        # DEFAULT comma delimiter, deliberately — NOT gcloud's `^:^` escape.
        # `--set-env-vars` is an ArgDict split on commas, and no value here
        # contains one (EDGAR_IDENTITY's space is fine; the array element is one
        # argv entry, so the space never reaches a splitter). Switching to `:`
        # to be "safe" would make the far more likely future value — any URL, or
        # a host:port — split SILENTLY into two malformed pairs. The hazard is
        # asymmetric, so the delimiter matches `--set-secrets` below and the
        # rest of scripts/ops.
        #
        # EDGAR_PARSE_APPLY tracks the SERVICE's posture for this environment:
        # "true" on prod, "false" on QA, matching cloudbuild.{prod,qa}.yaml and
        # `INTENDED_FLAG_STATE` in tests/test_deploy_contract.py.
        #
        # It was hardcoded "false" for BOTH environments while the service specs
        # were armed. That is not a harmless mismatch: `submissions` and
        # `companyfacts` take NO `--apply` flag, so the env is their only gate —
        # a prod backfill would have fetched the whole universe from a shared,
        # per-IP rate-limited host and written NOTHING, reporting a clean run.
        # Exactly the `selected > 0, written == 0` shape the outcome metric
        # exists to catch, caused by the provisioning script rather than by code.
        #
        # It ships PRESENT either way so that "absent" and "deliberately off"
        # stay different states — absent is how MF_METADATA_PROVIDER disabled its
        # job for months with every dashboard green (MONEY-1214).
        #
        # `xbrl_backfill`, `ownership_backfill` and `ftd` ALSO accept `--apply`
        # per execution (`applying = bool(args.apply) or settings.parse_apply()`),
        # which is the per-run operator decision and overrides a disarmed env.
        # The other two have no such override.
        # MONEY-1278 — DD_METRICS_TRANSPORT=http + DD_API_KEY.
        #
        # These JOBS have no datadog-agent sidecar (the SERVICE does), and
        # DogStatsD is fire-and-forget UDP: every counter was refused by a
        # closed port and dropped in silence while `[job-outcome]` kept
        # logging perfectly. `app/store/outcome.py` posts to the v1 intake
        # instead when this flag is exactly "http", which needs the key.
        # A sidecar per JOB EXECUTION was the alternative and costs a
        # container every run for a path apps/web already solves this way.
        --set-env-vars="APP_ENV=${ENV},NODE_ENV=${ENV},PUBSUB_ENV=${ENV},GCP_PROJECT_ID=${PROJECT_ID},GCP_STORAGE_BUCKET=${BUCKET},SEC_EGRESS=${EGRESS},EDGAR_IDENTITY=${EDGAR_IDENTITY},SEC_RATE_LIMIT_PER_SEC=${SEC_RATE_LIMIT_PER_SEC},EDGAR_PARSE_APPLY=${PARSE_APPLY},EDGAR_LOCAL_DATA_DIR=/tmp/edgar,DD_SERVICE=us-fundamentals,DD_ENV=${ENV},DD_METRICS_TRANSPORT=http"
        # REDIS_URL is the one secret these jobs need that the Tiingo jobs do
        # not, and it is NOT optional. edgartools' limiter is a per-PROCESS
        # InMemoryBucket, so a backfill task pacing itself to 9 req/s while the
        # detect service also paces itself to 9 req/s puts 18 req/s on a host
        # whose ceiling is 10 — and neither process can see the other. The
        # shared Redis bucket is the only thing that makes the FLEET rate real,
        # and T3 fails CLOSED when it is unreachable rather than silently
        # falling back in-process.
        #
        # NO GCP_SERVICE_ACCOUNT_KEY_BASE64, and its absence is the point.
        # These jobs used to mount it and NOTHING READ IT: grep app/, scripts/
        # and tests/ in services/us-fundamentals and the only hit is a constant
        # in a test. `app/sec/archive.py` builds a plain `storage.Client()`, so
        # the job authenticates as --service-account above (${JOB_SA}) via ADC,
        # and THAT is the principal that needs object read/write on ${BUCKET}.
        #
        # The comment that used to sit here said the mounted key OUTRANKED
        # --service-account because googleCredentials() resolves it first. That
        # is true of the TYPESCRIPT helper (packages/core/src/gemini/
        # credentials.ts) and false of this Python service. Following it grants
        # the bucket to the wrong principal, and the 403 arrives inside
        # `SecClient.fetch_bundle` AFTER the SEC GET has been spent — so a long
        # walk burns its shared per-IP budget and archives nothing.
        --set-secrets="DATABASE_URL=${DB_SECRET}:latest,REDIS_URL=${REDIS_SECRET}:latest,OPENFIGI_API_KEY=${OPENFIGI_SECRET}:latest,DD_API_KEY=${DD_SECRET}:latest"
    )

    if [ "$DRY_RUN" = true ]; then
        echo "   [dry-run] gcloud ${deploy_args[*]}"
        echo "   [dry-run] gcloud run jobs add-iam-policy-binding ${job_name} --region=${REGION} --member=serviceAccount:${JOB_SA} --role=roles/run.invoker"
    else
        "${GC[@]}" "${deploy_args[@]}"
        "${GC[@]}" run jobs add-iam-policy-binding "$job_name" --region="$REGION" \
            --member="serviceAccount:${JOB_SA}" --role=roles/run.invoker \
            --quiet >/dev/null
        echo -e "   ${GREEN}${job_name} deployed${NC}  (timeout ${timeout}s, ${memory})"
    fi
}

# ── The bucket grant the SA-key removal made load-bearing ───────────────────
#
# `GCP_SERVICE_ACCOUNT_KEY_BASE64` used to be mounted into the service and all
# five jobs. Nothing read it — `app/sec/archive.py` builds a bare
# `storage.Client()` — so it was dropped. That makes the RUNTIME service account
# the one and only GCS principal, and nothing in this repo granted it object
# access: the only `storage buckets add-iam-policy-binding` in scripts/ops is in
# setup-sync-job.sh, for a different SA.
#
# The failure this prevents is expensive and late. `archive.write_bytes` is
# called from inside `SecClient.fetch_bundle`, AFTER the SEC GET has completed —
# so without the grant every parse spends a request from a shared, per-IP,
# rate-limited budget and then throws, the archive never accumulates, and QA
# (which replays it rather than fetching) has nothing to read.
#
# `objectAdmin` rather than `objectCreator`: the evictor DELETES cold shards it
# has superseded, and the archive overwrites `current/`-keyed feeds in place.
grant_bucket_access() {
    local bucket="${GCP_STORAGE_BUCKET:-stockbook-content-${ENV}}"
    if [ "$DRY_RUN" = true ]; then
        echo "   [dry-run] gcloud storage buckets add-iam-policy-binding gs://${bucket} --member=serviceAccount:${JOB_SA} --role=roles/storage.objectAdmin"
        return 0
    fi
    if "${GC[@]}" storage buckets add-iam-policy-binding "gs://${bucket}" \
        --member="serviceAccount:${JOB_SA}" --role=roles/storage.objectAdmin \
        --condition=None --quiet >/dev/null 2>&1; then
        echo -e "   ${GREEN}bucket grant${NC}  gs://${bucket} -> ${JOB_SA} (objectAdmin)"
    else
        # Counted and LOUD rather than `|| true`. An unconditional success line
        # over a failed grant is the exact reporting shape this branch has
        # already had to remove twice.
        echo -e "   ${RED}WARNING${NC}  could not grant objectAdmin on gs://${bucket} to ${JOB_SA}."
        echo -e "   ${RED}WARNING${NC}  Every archive write will 403 AFTER its SEC request is spent."
        echo -e "   ${RED}WARNING${NC}  Grant it by hand, or re-run with an account that can set bucket IAM."
        return 1
    fi
}

# MEMORY. The two bulk jobs open a ~1.5 GB zip through a SEEKABLE GCS stream and
# iterate members WITHOUT extracting, so peak is one member plus the zip's
# central directory — not the archive. companyfacts gets 4Gi anyway because a
# single large filer's fact set (AAPL, BRK.B) deserialises into a dict of every
# concept x every period, and the xbrl backfill gets 4Gi because edgartools
# materialises statement DataFrames per filing.
# BEFORE the deploys, and idempotent: the grant is what makes the archive
# writable, and learning it is missing after five jobs are live is learning it
# from a 403 in a nightly log.
BUCKET_GRANT_OK=true
grant_bucket_access || BUCKET_GRANT_OK=false

if [ -z "$ONLY" ] || [ "$ONLY" = "submissions" ]; then
    deploy_job "edgar-bulk-submissions" "app.bulk.submissions" "$TASK_TIMEOUT_SUBMISSIONS" "2Gi"
fi
if [ -z "$ONLY" ] || [ "$ONLY" = "companyfacts" ]; then
    deploy_job "edgar-bulk-companyfacts" "app.bulk.companyfacts" "$TASK_TIMEOUT_COMPANYFACTS" "4Gi"
fi
if [ -z "$ONLY" ] || [ "$ONLY" = "xbrl" ]; then
    deploy_job "edgar-xbrl-backfill" "app.bulk.xbrl_backfill" "$TASK_TIMEOUT_XBRL" "4Gi"
fi
if [ -z "$ONLY" ] || [ "$ONLY" = "ownership" ]; then
    deploy_job "edgar-ownership-backfill" "app.bulk.ownership_backfill" "$TASK_TIMEOUT_OWNERSHIP" "2Gi"
fi
# 2Gi: one ~1.6 MB zip at a time plus the union CUSIP map (~40k entries over 24
# months). Nothing here opens a 1.5 GB archive.
if [ -z "$ONLY" ] || [ "$ONLY" = "ftd" ]; then
    deploy_job "edgar-bulk-ftd" "app.bulk.ftd" "$TASK_TIMEOUT_FTD" "2Gi"
fi

if [ "$BUCKET_GRANT_OK" = false ]; then
    echo -e "   ${RED}The jobs are deployed but CANNOT WRITE THE ARCHIVE until the"
    echo -e "   bucket grant above succeeds. Do not arm them first.${NC}"
fi

# ── 3. Scheduler ──────────────────────────────────────────────────────────────
echo -e "${BLUE}━━━ 3/3: Cloud Scheduler ━━━${NC}"
echo -e "   ${YELLOW}THREE of the five are scheduled by scripts/ops/setup-scheduler.sh"
    echo -e "   (prod only): edgar-bulk-submissions 13:00 IST + 16:00 IST retry,"
    echo -e "   edgar-bulk-companyfacts 13:20 IST + 16:20 IST retry, and"
    echo -e "   edgar-bulk-ftd 19:00 IST on the 3rd and 18th + a retry on the"
    echo -e "   10th and 25th. All compare Last-Modified/ETag (or a per-period"
    echo -e "   checkpoint) first and exit 0 unchanged, which is why a second"
    echo -e "   attempt is cheap and why four FTD runs a month cost almost nothing."
    echo
    echo -e "   The TWO BACKFILLS get no trigger, deliberately. They fetch HISTORY,"
    echo -e "   which is one-shot; a nightly re-walk would spend SEC fair-access"
    echo -e "   budget rewriting rows we already hold. Re-run them by hand to go"
    echo -e "   deeper (--from-fy/--to-fy, --from-date) — a DONE checkpoint skips"
    echo -e "   before the fetch, so a re-run only costs what it has not done.${NC}"

# Unquoted heredoc so the printed commands name the env actually provisioned.
cat <<EOF

────────────────────────────────────────────────────────────────
Provisioned the SEC EDGAR backfill jobs (${ENV}).

  image    ${IMAGE}
  commit   ${IMAGE_SHA}
  bucket   ${BUCKET}   SEC_EGRESS ${EGRESS}
  identity ${EDGAR_IDENTITY}
  rate     ${SEC_RATE_LIMIT_PER_SEC} req/s, SHARED across the fleet via ${REDIS_SECRET}
  retry    --max-retries=0

  edgar-bulk-submissions-${ENV}     timeout ${TASK_TIMEOUT_SUBMISSIONS}s   2Gi
  edgar-bulk-companyfacts-${ENV}    timeout ${TASK_TIMEOUT_COMPANYFACTS}s   4Gi
  edgar-xbrl-backfill-${ENV}        timeout ${TASK_TIMEOUT_XBRL}s   4Gi
  edgar-ownership-backfill-${ENV}   timeout ${TASK_TIMEOUT_OWNERSHIP}s   2Gi
  edgar-bulk-ftd-${ENV}             timeout ${TASK_TIMEOUT_FTD}s    2Gi

ARGV: the EQUALS form. "--args=--apply,--from-fy=2020" arrives as
["--apply","--from-fy=2020"]. "--ciks" COLLIDES with gcloud's own comma
delimiter — change the separator with ^:^ (example below).

STEP 0 — PROBE FROM CLOUD RUN BEFORE THE LONG WALK.
Nothing in this repo has fetched sec.gov from Cloud Run yet, and
api.tickertape.in answers 200 from a laptop and 403 from here (MONEY-1220).
The cheapest probe is the SERVICE, not a job:

  gcloud run services proxy ${SERVICE_NAME} --region=${REGION} \\
    --project=${PROJECT_ID} --account=founder@disdigital.in
  # then: curl localhost:8080/health

/health reports the Mongo ping, the Redis ping, the pinned edgartools version,
the resolved limiter mode and every EDGAR_* flag's state — which is every piece
the long walks depend on, without spending one SEC request.

Then a single-CIK backfill, ~20 requests:

  gcloud run jobs execute edgar-xbrl-backfill-${ENV} --region=${REGION} \\
    --project=${PROJECT_ID} --account=founder@disdigital.in \\
    --args=^:^--ciks=0000320193:--from-fy=2025:--to-fy=2026

RUN THEM IN THIS ORDER. submissions SEEDS us_filings and us_filers, and both
backfills SELECT from us_filings — running a backfill first walks an empty
table and reports a healthy zero.

  1. gcloud run jobs execute edgar-bulk-submissions-${ENV} --region=${REGION} \\
       --project=${PROJECT_ID} --account=founder@disdigital.in --wait
  2. gcloud run jobs execute edgar-bulk-companyfacts-${ENV} --region=${REGION} \\
       --project=${PROJECT_ID} --account=founder@disdigital.in --wait
  3. gcloud run jobs execute edgar-xbrl-backfill-${ENV} --region=${REGION} \\
       --project=${PROJECT_ID} --account=founder@disdigital.in \\
       --args=--apply,--from-fy=2020,--to-fy=2026
  4. gcloud run jobs execute edgar-ownership-backfill-${ENV} --region=${REGION} \\
       --project=${PROJECT_ID} --account=founder@disdigital.in \\
       --args=--apply,--class=ownership,--from-date=2021-01-01,--to-date=2026-08-29
  5. gcloud run jobs execute edgar-bulk-ftd-${ENV} --region=${REGION} \\
       --project=${PROJECT_ID} --account=founder@disdigital.in \\
       --args=--apply,--months=24

edgar-bulk-ftd fills the SEC_FTD tier of us_cusip_map, which app/parsers/cusip_map.py
reports as "unavailable" until it has archived at least one file. Its coverage is
PARTIAL AND ROLLING by construction — a security is in a fails file only while it
has an open fail — so read cusipsResolved/cusipsSeen in the job outcome as a hit
count, never as a completion percentage.

DO NOT RUN TWO AT ONCE unless the shared Redis limiter is confirmed live
(/health -> limiter.mode == "redis-shared"). Without it each task paces to
${SEC_RATE_LIMIT_PER_SEC} req/s independently against a 10 req/s ceiling, and
SEC's only feedback is a ~10-minute block with no Retry-After.

WATCH IT:
  gcloud run jobs executions list --job=edgar-bulk-submissions-${ENV} \\
    --region=${REGION} --project=${PROJECT_ID} --account=founder@disdigital.in

  gcloud logging read \\
    'resource.type="cloud_run_job" AND resource.labels.job_name="edgar-bulk-submissions-${ENV}"' \\
    --project=${PROJECT_ID} --account=founder@disdigital.in \\
    --freshness=1h --limit=30 --format='value(timestamp,textPayload)'

Grep the logs for \`"msg": "job-outcome"\`. \`selected > 0\` with
\`"written": 0\` is the one shape that is never normal.

An interrupted run is SAFE to re-run: all four checkpoint into
\`backfill_checkpoints\`, so a re-run skips what already landed. Interruption
costs time, never work.

VERIFY THE PIN. A Cloud Run JOB keeps the image it was provisioned with. The
service's cloudbuild re-pins these four on every release, and re-running THIS
SCRIPT is what creates them and owns their env. Check the pin against
${IMAGE_SHA}:

  gcloud run jobs describe edgar-bulk-submissions-${ENV} --region=${REGION} \\
    --project=${PROJECT_ID} --account=founder@disdigital.in \\
    --format='value(spec.template.spec.template.spec.containers[0].image)'
────────────────────────────────────────────────────────────────
EOF
