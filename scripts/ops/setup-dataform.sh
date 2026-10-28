#!/usr/bin/env bash
#
# setup-dataform.sh — the `lake-gold-{env}` Cloud Run job that builds gold with
# the Dataform CLI, and its two schedules. MONEY-1611.
#
#   ./scripts/ops/setup-dataform.sh qa   [--dry-run] [--image=IMG]
#   ./scripts/ops/setup-dataform.sh prod [--dry-run] [--image=IMG]
#
#   lake-gold-{env}             scripts/jobs/lake-gold.ts -> dist/lake-gold.js
#   lake-gold-after-us-{env}    scheduler, 06:45 IST
#   lake-gold-after-in-{env}    scheduler, 20:15 IST
#
# ## A JOB, NOT THE MANAGED DATAFORM SERVICE (founder decision 2026-09-23)
#
# This script used to provision a managed Dataform repository, a release
# config and two workflow configs (MONEY-1506). It never ran in either
# environment: the managed service clones the repo from GitHub, which needs a
# DATAFORM_GIT_TOKEN secret that was never created, and it compiles a BRANCH at
# 06:00 rather than what was deployed. No Dataform repository exists (read
# 2026-09-23: `repositories` list is empty), so there is nothing to tear down.
#
# The job runs the Dataform CLI over the `dataform/` directory baked into the
# workers image (workers/Dockerfile), so it builds exactly the SQL of the
# release it is pinned to, and its `[build-provenance]` line names that commit.
# The release's re-pin loop moves it with every workers deploy.
#
# ## RUNS AS lake-dataform-{env}@, WHOSE BIGQUERY IAM IS setup-lake.sh's
#
# That account exists (both envs, verified 2026-09-23) and holds exactly what a
# gold build needs: WRITER on lake_gold_{env}, READER on lake_silver_{env},
# project jobUser — and nothing on bronze's DATASET, which is why it exists
# rather than reusing lake-writer-{env}@: a bad model in a merged .sqlx must not
# be able to drop the ledger. It stays granted there so
# `lake-infra-coverage.test.ts` holds all four lake accounts against the
# contract. What only this JOB needs is granted here:
#
#   DD_API_KEY_{ENV}                  secretAccessor  logs and outcome metric
#   lake-gold-{env}                   run.invoker     the triggers run as the SA
#   lake_bronze_{env}.partition_load  dataViewer      TABLE-level, READ only
#
# The ledger read is the MID-RELOAD GATE (`goldLoadingQuery`): before building,
# the job looks for live LOADING claims — or any claim in the last 30 min, a
# walk between months — on the silver tables gold reads, and skips with
# `SKIPPED_LOADING <table>: <partitions>` rather than build over a month that
# is deleted and not yet reloaded: exit 0 on a plain scheduled run, exit 1 with
# a retry time on a TARGETED one (--actions / --full-refresh), which the
# deployed args would never redo. It is granted on that ONE TABLE,
# never the dataset: the rest of bronze stays out of reach.
#
# NO GCP_SERVICE_ACCOUNT_KEY_BASE64 and NO key file of any kind: the CLI's
# BigQuery client reads Application Default Credentials, which inside Cloud Run
# is the runtime service account. A mounted key would silently beat it and turn
# the build into stockbook-api@, which holds nothing on BigQuery. NO
# DATABASE_URL either: gold reads silver, never Mongo.
#
# ## SCHEDULES: 06:45 AND 20:15 IST, BOTH ENVS
#
# The slots MONEY-1506 gave the managed workflow configs: after the overnight
# American daily load, and after India's. Both runs build EVERYTHING — `market`
# is a column, never a dataset (lake-layout.md §4), so a per-market run would
# leave each view holding whichever market ran last. The 45-minute offsets were
# chosen against a managed COMPILE at 06:00; the job compiles at run time, so
# that reason is gone and the slots are kept as the plan's. India can land
# after 20:15 (rolling_stats.sqlx records 22:40 IST on 2026-09-22), in which
# case it reaches gold at 06:45.
#
# A bare POST to `:run` executes the DEPLOYED args, `--env {env}`: every model
# tagged `gold`, incremental tables incrementally. Anything else — one model, a
# full refresh — is a per-execution `--args` override, printed at the end.
#
# ## IMAGE: pinned from the LIVE service, and printed
#
# Same as setup-lake-jobs.sh: resolved off the live stockbook-workers-{env}
# service. The image must be one built AFTER MONEY-1611, or it has neither
# dist/lake-gold.js nor the CLI and the job dies at start.
#
# ## ORDER
#
#   1. workers deployed from a commit carrying MONEY-1611
#   2. ./scripts/ops/setup-lake.sh {env}   (the SA and its dataset grants)
#   3. QA ONLY: the first prod->QA lake copy (MONEY-1610, sync-prod-to-qa).
#      Measured 2026-09-23, QA's silver `corporate_action` has no
#      `observed_ratio` column — its DDL is behind prod's — so `adjusted_bar_d1`
#      fails "Unrecognized name: observed_ratio" and every model downstream is
#      skipped. The copy replaces QA's silver schema with prod's. Provisioning
#      QA before it just schedules a red run twice a day.
#   4. this script
#
# AFTER ANY HISTORICAL REPLAY of an input (lake-replay-in / lake-replay-us),
# rebuild the one incremental model from scratch. The gate keeps a build off a
# walk in progress, but a replay STARTED after a build began is invisible to
# it, and `event_return_outcome` never re-reads a COMPLETE row:
#   gcloud run jobs execute lake-gold-{env} --region=asia-south1 \
#     --args="--env,{env},--full-refresh,--actions,event_return_outcome,--include-dependents"

set -euo pipefail

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
GCLOUD_ACCOUNT="founder@disdigital.in"
# `bq` has no --account flag; this pins its actor too (as setup-lake.sh does).
export CLOUDSDK_CORE_ACCOUNT="$GCLOUD_ACCOUNT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

ENV="${1:-}"
shift || true
IMAGE=""
DRY_RUN=false
while [ $# -gt 0 ]; do
    case "$1" in
        --image=*) IMAGE="${1#*=}"; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

# EXPLICIT per-env mapping: `job-metrics-path.test.ts` requires the literals.
case "$ENV" in
    prod) DD_SECRET="DD_API_KEY_PROD" ;;
    qa)   DD_SECRET="DD_API_KEY_QA" ;;
    *)
        echo "Usage: ./scripts/ops/setup-dataform.sh {qa|prod} [--dry-run] [--image=IMG]" >&2
        exit 1
        ;;
esac

GC=(gcloud --project="$PROJECT_ID" --account="$GCLOUD_ACCOUNT")
SERVICE_NAME="stockbook-workers-${ENV}"
JOB_SA="lake-dataform-${ENV}@${PROJECT_ID}.iam.gserviceaccount.com"
JOB_NAME="lake-gold-${ENV}"
ENTRYPOINT="dist/lake-gold.js"

run() {
    if [ "$DRY_RUN" = true ]; then
        echo "   [dry-run] gcloud ${*:2}"
    else
        "$@" >/dev/null
    fi
}

# ── 1. Preflight — read-only, and it runs on a dry run too ──────────────────
echo -e "${BLUE}━━━ 1/4: Preflight (${ENV}) ━━━${NC}"
if ! "${GC[@]}" iam service-accounts describe "$JOB_SA" >/dev/null 2>&1; then
    echo -e "   ${RED}REFUSING: ${JOB_SA} does not exist.${NC} Run ./scripts/ops/setup-lake.sh ${ENV} first." >&2
    exit 1
fi
IMAGE_SOURCE="explicit --image"
if [ -z "$IMAGE" ]; then
    IMAGE_SOURCE="live ${SERVICE_NAME} service"
    IMAGE="$("${GC[@]}" run services describe "$SERVICE_NAME" --region="$REGION" \
        --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
fi
# FAILS CLOSED: an empty IMAGE would error mid-deploy or keep a stale pin.
if [ -z "$IMAGE" ]; then
    echo -e "   ${RED}Could not resolve the ${SERVICE_NAME} image.${NC} Deploy workers, or pass --image=..." >&2
    exit 1
fi
IMAGE_TAG="${IMAGE##*:}"
IMAGE_SHA="${IMAGE_TAG#"${ENV}"-}"
echo -e "   SA     : ${GREEN}${JOB_SA}${NC}"
echo -e "   image  : ${GREEN}${IMAGE}${NC}  (${IMAGE_SOURCE})"
echo -e "   commit : ${GREEN}${IMAGE_SHA}${NC}"
echo -e "   ${YELLOW}PREFLIGHT: this image must carry dist/lake-gold.js, /app/dataform and the"
echo -e "   Dataform CLI (MONEY-1611). An older one dies at start.${NC}"

# ── 2. Grants — idempotent; a failure aborts rather than warns ──────────────
echo -e "${BLUE}━━━ 2/4: Grants to ${JOB_SA%%@*} ━━━${NC}"
echo "   roles/secretmanager.secretAccessor on ${DD_SECRET}"
run "${GC[@]}" secrets add-iam-policy-binding "$DD_SECRET" \
    --member="serviceAccount:${JOB_SA}" --role=roles/secretmanager.secretAccessor \
    --quiet
# TABLE-level, idempotent: re-adding an existing binding is a no-op.
LEDGER_TABLE="${PROJECT_ID}:lake_bronze_${ENV}.partition_load"
echo "   roles/bigquery.dataViewer on ${LEDGER_TABLE} (that table only)"
if [ "$DRY_RUN" = true ]; then
    echo "   [dry-run] bq add-iam-policy-binding --member=serviceAccount:${JOB_SA} --role=roles/bigquery.dataViewer ${LEDGER_TABLE}"
else
    bq --project_id="$PROJECT_ID" add-iam-policy-binding \
        --member="serviceAccount:${JOB_SA}" --role=roles/bigquery.dataViewer \
        "$LEDGER_TABLE" >/dev/null
fi

# ── 3. The job ───────────────────────────────────────────────────────────────
#
# 3h task timeout, max-retries 0. A full build is five views, one TABLE rebuilt
# whole and one incremental table, plus 16 assertions that each re-read the
# adjusted view; the first run and a --full-refresh build event_return_outcome
# from nothing. 3h is well under the SHORTER gap between the two slots, 10.5h
# (20:15 -> 06:45), so a slow run can never overlap the next. No retry: a failed ASSERTION is the data being
# wrong, and re-running it is the same answer twice.
#
# A Cloud Run JOB inherits no service env block, so this is the whole env.
# DD_TRACE_ENABLED=false overrides the image's `true` (a job has no agent).
echo -e "${BLUE}━━━ 3/4: Cloud Run Job — ${JOB_NAME} ━━━${NC}"
DEPLOY_ARGS=(
    run jobs deploy "$JOB_NAME"
    --image="$IMAGE"
    --region="$REGION"
    --service-account="$JOB_SA"
    # The script path is --command, not --args: `jobs execute --args` REPLACES
    # the container's args, so an entrypoint there would be dropped.
    --command="node,$ENTRYPOINT"
    --args="--env,${ENV}"
    --max-retries=0
    --task-timeout=10800
    --memory=1Gi
    --cpu=1
    --set-env-vars="DD_ENV=${ENV},DD_TRACE_ENABLED=false"
    --set-secrets="DD_API_KEY=${DD_SECRET}:latest"
)
if [ "$DRY_RUN" = true ]; then
    echo "   [dry-run] ${GC[*]} ${DEPLOY_ARGS[*]}"
else
    "${GC[@]}" "${DEPLOY_ARGS[@]}"
    echo -e "   ${GREEN}${JOB_NAME} deployed${NC}"
fi
run "${GC[@]}" run jobs add-iam-policy-binding "$JOB_NAME" --region="$REGION" \
    --member="serviceAccount:${JOB_SA}" --role=roles/run.invoker --quiet

# ── 4. The two triggers ─────────────────────────────────────────────────────
#
# Called with the job BASE and a literal cron, so monitor-agreement.test.ts's
# `cronsForJob` can read the schedule the day a monitor is added.
echo -e "${BLUE}━━━ 4/4: Cloud Scheduler ━━━${NC}"
schedule_job_run() {
    local sched_name="${1}-${ENV}" job_name="${2}-${ENV}" cron="$3" desc="$4"
    local uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${job_name}:run"
    local sched_args=(
        --location="$REGION"
        --schedule="$cron"
        --time-zone="Asia/Kolkata"
        --uri="$uri"
        --http-method=POST
        --oauth-service-account-email="$JOB_SA"
        --description="$desc"
    )
    if [ "$DRY_RUN" = true ]; then
        echo "   [dry-run] gcloud scheduler jobs create/update http ${sched_name} (${cron} IST) -> ${job_name}:run"
        return
    fi
    if "${GC[@]}" scheduler jobs describe "$sched_name" --location="$REGION" >/dev/null 2>&1; then
        "${GC[@]}" scheduler jobs update http "$sched_name" "${sched_args[@]}" --quiet
    else
        "${GC[@]}" scheduler jobs create http "$sched_name" "${sched_args[@]}" --quiet
    fi
    echo -e "   ${GREEN}Scheduled ${sched_name} (${cron} IST) -> ${job_name}${NC}"
}
schedule_job_run "lake-gold-after-us" "lake-gold" "45 6 * * *" \
    "MONEY-1611 gold build after the overnight american daily load: every gold-tagged Dataform model and assertion. A failed assertion fails the execution."
schedule_job_run "lake-gold-after-in" "lake-gold" "15 20 * * *" \
    "MONEY-1611 gold build after the india daily load: every gold-tagged Dataform model and assertion. A failed assertion fails the execution."

if [ "$DRY_RUN" = true ]; then OUTCOME="DRY RUN (${ENV}) — nothing was changed"; else OUTCOME="Provisioned (${ENV})"; fi
cat <<EOF

────────────────────────────────────────────────────────────────
${OUTCOME}. Image ${IMAGE_TAG}.

BEFORE ANY MANUAL RUN, check that no execution is still running. Two runs race
the MERGE on event_return_outcome:
  gcloud run jobs executions list --job=${JOB_NAME} --region=${REGION} --limit=5

${JOB_NAME} — the scheduled build, now (every gold model and every assertion):
  gcloud run jobs execute ${JOB_NAME} --region=${REGION}

Rebuild ONE model from scratch, with its assertions (--include-dependents is
what brings them; without it the model is rebuilt and nothing checks it):
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} \\
    --args="--env,${ENV},--actions,event_return_outcome,--full-refresh,--include-dependents"

Full refresh of every incremental table:
  gcloud run jobs execute ${JOB_NAME} --region=${REGION} --args="--env,${ENV},--full-refresh"

Always pass --env ${ENV}, the job's own env: lake-dataform-${ENV}@ can write
lake_gold_${ENV} and nothing else, and the job refuses a mismatch at startup.
Follow one:  gcloud run jobs executions list --job=${JOB_NAME} --region=${REGION}

Its first log line is [build-provenance]; its SHA must be ${IMAGE_SHA}. The
last is "[lake-gold] outcome {...}" — tables built, assertions passed/failed —
or SKIPPED_LOADING lines: an input was being reloaded and nothing was built. A
scheduled run then exits 0 and the next slot builds. A run given --actions or
--full-refresh exits 1 and prints "Retry after <UTC time>": run the SAME --args
again after it, because no scheduled slot will.
EOF
