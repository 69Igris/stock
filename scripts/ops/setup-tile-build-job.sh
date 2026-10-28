#!/usr/bin/env bash
#
# setup-tile-build-job.sh — the D1 tile builder Cloud Run jobs. MONEY-1467 (A2).
#
#   ./scripts/ops/setup-tile-build-job.sh qa
#   ./scripts/ops/setup-tile-build-job.sh prod [--dry-run]
#
# Provisions TWO jobs per environment, `tile-build-d1-in-{env}` and
# `tile-build-d1-us-{env}`, from the workers image. They differ only in the
# `--market` argument, and they are two jobs rather than one parameterised job
# because they are on DIFFERENT SCHEDULES following DIFFERENT producers — India
# after bhavcopy-sync (21:00 IST prod / 21:30 qa), US after us-eod-sync (11:00
# IST). One job with a cron-supplied argument would make "which market am I"
# a property of the trigger rather than of the job, and a mis-set argument
# would silently build the wrong market's tiles.
#
# ## BOTH ENVIRONMENTS, unlike the metered jobs
#
# This reads our own Mongo and spends nothing with any vendor. QA holds its own
# `daily_prices` (QA-DIRECT — QA re-ingests from the replayed feed rather than
# receiving rows), so QA must build its own tiles or its charts have none.
#
# ## A JOB'S CONFIG IS PINNED AT SETUP TIME
#
# Re-run this after ANY change to the job's env or to the workers image the
# jobs should pin. Fixing this script alone reaches nothing: MONEY-1278 corrected
# the provisioners and the live jobs kept the env they were created with for
# months, while a monitor watched a series that had never been emitted.

set -euo pipefail

PROJECT_ID="stock-book-483718"
GCLOUD_ACCOUNT="founder@disdigital.in"
REGION="asia-south1"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

ENV_ARG="${1:-}"
shift || true
DRY_RUN=false
TASK_TIMEOUT=10800   # 3h — a full India build is ~24k listings; 24h is the cap.
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --task-timeout=*) TASK_TIMEOUT="${1#*=}"; shift ;;
        --allow-qa-build) ALLOW_QA_BUILD=true; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# ── QA RECEIVES TILES; IT DOES NOT BUILD THEM — MONEY-1478 ───────────────────
#
# `sync-prod-to-qa.sh --tier=feeds` mirrors `gs://stockbook-lake-prod/tiles/` to
# the QA lake, on the same two triggers as the feeds and candle-shard pairs. A
# tile is keyed `{market}/d1/{listingId}/` — a symbol, an exchange and a date,
# no ObjectId — so it is PORTABLE, and QA can take prod's output rather than
# recompute it. Same argument as `candles`, which QA has received as rows since
# MONEY-1373.
#
# It is not only redundant, it was FAILING. Measured 2026-09-18:
# `tile-build-d1-us-qa` was provisioned 2Gi/1CPU/1 task against the 8Gi/2CPU/4
# this very script specifies — the jobs were created before the MONEY-1479
# sizing and a job PINS its config at provision time — so it was OOM-killed
# every night ("Container terminated on signal 9") and
# `gs://stockbook-lake-qa/tiles/US/` HAS NEVER EXISTED. Re-sizing it would fix
# the crash and still leave QA spending an hour a night recomputing what prod
# already computed correctly.
#
# The override stays, because "QA cannot exercise the builder at all" is a
# worse place to be than "QA does not run it nightly": a change to
# `tile-build-d1` needs somewhere to be run for real before it reaches prod.
ALLOW_QA_BUILD="${ALLOW_QA_BUILD:-false}"

case "$ENV_ARG" in
    qa)
        if [ "$ALLOW_QA_BUILD" != true ]; then
            cat >&2 <<'QAMSG'
REFUSING to provision the tile-build jobs in QA.

QA RECEIVES tiles from prod — `sync-prod-to-qa.sh --tier=feeds` mirrors
gs://stockbook-lake-prod/tiles/ -> gs://stockbook-lake-qa/tiles/ on the same
schedule as the feeds and candle cold shards. A tile carries no ObjectId, so it
is portable and QA has no reason to recompute it.

The QA jobs this would create were also failing: the US one was sized
2Gi/1CPU/1task against the 8Gi/2CPU/4 below and was OOM-killed nightly, which is
why tiles/US/ has never existed in the QA lake.

To exercise the BUILDER in QA anyway (e.g. before shipping a change to
tile-build-d1), pass --allow-qa-build. That provisions the jobs AND their
nightly schedulers, so delete them again when you are done.
QAMSG
            exit 1
        fi
        ENV="qa"
        ;;
    prod) ENV="$ENV_ARG" ;;
    *)
        cat >&2 <<'USAGE'
Usage: ./scripts/ops/setup-tile-build-job.sh {qa|prod} [--dry-run] [--task-timeout=SECS] [--allow-qa-build]

Deploys the Cloud Run jobs tile-build-d1-in-{env} and tile-build-d1-us-{env}
from the workers image. Re-run after every workers deploy: a job PINS its image
at provision time and deploying the workers service does not move it.
USAGE
        exit 1
        ;;
esac

GC=(gcloud --project="$PROJECT_ID" --account="$GCLOUD_ACCOUNT")
IMAGE="gcr.io/${PROJECT_ID}/stockbook-workers:${ENV}-latest"
JOB_SA="stockbook-api@${PROJECT_ID}.iam.gserviceaccount.com"
# EXPLICIT per-env mapping, not `DD_API_KEY_${UPPER}`. `job-metrics-path.test.ts`
# requires the literal, and the reason is greppability: a computed secret name
# cannot be searched for, and a job pointed at a secret that does not exist
# fails at REVISION creation — after the image has already built and pushed.
if [ "$ENV" = "prod" ]; then
    DB_SECRET="DATABASE_URL_PROD"
    DD_SECRET="DD_API_KEY_PROD"
else
    DB_SECRET="DATABASE_URL_QA"
    DD_SECRET="DD_API_KEY_QA"
fi
BUCKET="stockbook-content-${ENV}"
LAKE_BUCKET="stockbook-lake-${ENV}"

echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  tile-build-d1 jobs — ${ENV}${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"

# The LAKE bucket must exist, because that is where tiles go — NOT the content
# bucket. A job that runs without it writes nothing and reports success.
if ! "${GC[@]}" storage buckets describe "gs://${LAKE_BUCKET}" >/dev/null 2>&1; then
    echo -e "   ${RED}REFUSING: gs://${LAKE_BUCKET} does not exist.${NC}" >&2
    echo "   Run ./scripts/ops/setup-lake.sh ${ENV} first — tiles live in the LAKE" >&2
    echo "   bucket (the tiles/ prefix routes there), not in the content bucket." >&2
    exit 1
fi

# $1 market (IN|US), $2 the bundle/job BASE — passed LITERALLY rather than
# derived, so `job-build-provenance.test.ts` can see which jobs this script
# creates. A name built by string arithmetic is a name no guard can read, and
# an unre-pinned job runs last release's code and exits 0.
# $1 JOB NAME, $2 ENTRYPOINT, $3 market — the first two passed LITERALLY at the
# call site, which is what `job-build-provenance.test.ts` parses. A name built
# by string arithmetic is a name no guard can read, and an un-re-pinned job runs
# last release's code and exits 0 (MONEY-1205/1250/1314/1317).
# MEMORY AND TASKS ARE PER MARKET. MONEY-1479.
#
# ## THE SIZING IS NOT WHAT FIXED THE OOM, AND SAYING SO MATTERS
#
# The US job was OOM-KILLED EVERY NIGHT — signal 9, tile store registered, ZERO
# objects written, `tiles/US/` never created — while its execution carried a
# completionTime and read as finished.
#
# It was raised 2Gi -> 8Gi and sharded 1 -> 4 tasks first. THAT DID NOT WORK:
# all four tasks were killed at 8Gi. The real cause was a query that is
# unbounded by construction — `usListings` used Prisma's `distinct`, which on
# MongoDB is a CLIENT-SIDE step, so it streamed 20,268,060 candle rows into
# Node to produce 14,258 listings. Moving the `distinct` into a `$group`
# (tile-build-d1.ts) made the same work cost 5.8 MiB and 2.3 s, measured.
#
# The sizing below is KEPT because the walk itself is real — 14,258 listings x
# 5 years of bars, against India's ~5,610 — and 2 CPU is forced by the memory
# anyway (see below). But it is headroom, not the fix. If this job OOMs again,
# read what ALLOCATES before raising a number: it died before any progress
# output both times, which is the tell for a first-load problem rather than a
# walk problem.
#
# `loadManifest` also reads EVERY shard's manifest and merges them, so each
# task holds the whole market's manifest regardless of `--tasks` — sharding
# buys throughput, never footprint.
# CPU IS RAISED WITH MEMORY BECAUSE CLOUD RUN REQUIRES IT. Deploying 8Gi at
# 1 CPU is REFUSED: "For 1.0 CPU, memory must be between 128Mi and 4Gi
# inclusive." The ratio is a platform constraint, not a performance choice —
# and it failed the deploy loudly rather than silently accepting a smaller
# limit, which is the one thing that would have hidden this.
mem_for_market() { [ "$1" = "US" ] && echo "8Gi" || echo "2Gi"; }
cpu_for_market() { [ "$1" = "US" ] && echo "2" || echo "1"; }
tasks_for_market() { [ "$1" = "US" ] && echo "4" || echo "1"; }

deploy_job() {
    local base=$1
    local ENTRYPOINT=$2
    local MARKET=$3
    # The helper appends the env, so the CALL SITES carry the bare base and are
    # greppable. `job-build-provenance.test.ts` parses exactly this shape.
    local job_name="${base}-${ENV}"
    local JOB_NAME="$job_name"

    local deploy_args=(
        run jobs deploy "$JOB_NAME"
        --image="$IMAGE"
        --region="$REGION"
        --service-account="$JOB_SA"
        # The script path belongs in --command, NOT --args: `jobs execute
        # --args=...` REPLACES the container's args, so a parameterised
        # execution would become `node --market=IN` and die with "bad option".
        --command="node,$ENTRYPOINT"
        # `--apply` IS IN THE DEPLOYED ARGS, and it has to be. The scheduler
        # POSTs `:run` with no overrides, so the nightly execution uses exactly
        # these args — without `--apply` the scheduled job is a PERMANENT DRY
        # RUN: no manifest, no tiles, and an execution that succeeds every
        # night. An operator wanting a dry run passes `--args="--market=X"`
        # explicitly at `jobs execute`, which REPLACES this list.
        #
        # Safe to arm by default, unlike XBRL_*_APPLY or DATABENTO_*_APPLY:
        # tiles are DERIVED output in a bucket of their own. There is no
        # one-way door here and nothing to re-purchase — a wrong tile is fixed
        # by rebuilding it.
        --args="--market=${MARKET},--apply"
        # A retry re-walks from the same listing set. That is idempotent (the
        # manifest skips what is current), but a task that died because Mongo
        # or GCS was refusing would be restarted straight back into it.
        --max-retries=0
        --task-timeout="$TASK_TIMEOUT"
        --memory="$(mem_for_market "$MARKET")"
        # Sharding needs NO code change: the builder reads Cloud Run's own
        # CLOUD_RUN_TASK_INDEX / CLOUD_RUN_TASK_COUNT (tile-build-d1.ts:124),
        # and `Number.isInteger` there rather than truthiness, so task 0 is a
        # real shard.
        --tasks="$(tasks_for_market "$MARKET")"
        --cpu="$(cpu_for_market "$MARKET")"
        # Set EXPLICITLY — a Cloud Run JOB does NOT inherit the service's env
        # block. LAKE_ENV is what `initTileStore()` reads to pick the lake
        # bucket; without it no store registers and the job refuses to run
        # under --apply rather than walking every listing storing nothing.
        #
        # DD_TRACE_ENABLED=false overrides the `true` the image bakes in, so
        # dd-trace does not boot against a sidecar that is not there.
        # DD_API_KEY is what makes reportJobOutcome emit at all (MONEY-1278).
        --set-env-vars="LAKE_ENV=${ENV},GCP_STORAGE_BUCKET=${BUCKET},GCP_PROJECT_ID=${PROJECT_ID},DD_ENV=${ENV},DD_TRACE_ENABLED=false"
        --set-secrets="DATABASE_URL=${DB_SECRET}:latest,GCP_SERVICE_ACCOUNT_KEY_BASE64=GCP_SERVICE_ACCOUNT_KEY_BASE64:latest,DD_API_KEY=${DD_SECRET}:latest"
    )

    if [ "$DRY_RUN" = true ]; then
        echo -e "   ${YELLOW}[dry-run]${NC} gcloud ${deploy_args[*]}"
    else
        "${GC[@]}" "${deploy_args[@]}"
        "${GC[@]}" run jobs add-iam-policy-binding "$JOB_NAME" --region="$REGION" \
            --member="serviceAccount:${JOB_SA}" --role=roles/run.invoker --quiet >/dev/null
        echo -e "   ${GREEN}${JOB_NAME} deployed${NC}"
    fi
}

deploy_job "tile-build-d1-in" "dist/tile-build-d1-in.js" IN
deploy_job "tile-build-d1-us" "dist/tile-build-d1-us.js" US

echo ""
echo "Tiles are written to gs://${LAKE_BUCKET}/tiles/{IN,US}/d1/ — NOT the content bucket."
echo "Schedulers: ./scripts/ops/setup-scheduler.sh ${ENV}"
echo "  tile-build-d1-in-daily-${ENV}   $([ "$ENV" = prod ] && echo '21:45' || echo '22:15') IST Mon-Fri  (AFTER bhavcopy-sync)"
echo "  tile-build-d1-us-daily-${ENV}   11:45 IST Tue-Sat  (AFTER us-eod-sync)"
echo ""
echo "The SCHEDULED run is ARMED: --apply is in the deployed args, because the"
echo "scheduler POSTs :run with no overrides and would otherwise write nothing."
echo ""
echo "A manual execution REPLACES the arg list, so a dry run is explicit:"
echo "  gcloud run jobs execute tile-build-d1-in-${ENV} --region=${REGION} --args=\"--market=IN,--limit=50\"            # dry run"
echo "  gcloud run jobs execute tile-build-d1-in-${ENV} --region=${REGION} --args=\"--market=IN,--limit=50,--apply\"   # writes"
