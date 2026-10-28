#!/usr/bin/env bash
#
# setup-lake-jobs.sh — the Cloud Run JOBS that run as lake-writer-{env}@.
#
#   ./scripts/ops/setup-lake-jobs.sh qa   [--dry-run] [--image=IMG]
#   ./scripts/ops/setup-lake-jobs.sh prod [--dry-run] [--image=IMG]
#
#   lake-release-{env}      scripts/jobs/lake-release.ts     MONEY-1518 (B7)
#                           Cuts an immutable parquet release. MANUAL: no trigger.
#   event-lake-sink-{env}   scripts/jobs/event-lake-sink.ts  MONEY-1507 / MONEY-1521
#                           Mongo instrument_events -> lake_silver.instrument_event,
#                           then stamps expiresAt. HOURLY.
#
#   MONEY-1609 — the long lake LOADS. MANUAL, no trigger, NO default args:
#   `--args` is passed per execution (the printed commands at the end).
#   lake-replay-in-{env}        archived NSE/BSE files -> price_bar_d1 (IN),
#                               derivatives_eod_in, delivery_daily, index_eod
#   lake-replay-us-{env}        Mongo candles + GCS cold shards -> price_bar_d1 (US),
#                               us_fund_nav -> fund_nav_d1
#   filing-registry-sync-{env}  Mongo us_filings -> filing_registry (one MERGE)
#   corp-action-lake-sink-{env} Mongo corporate_actions -> corporate_action
#   identity-sync-{env}         instrument masters -> listing (+ --rebase-history)
#
#   They were laptop runs until 2026-09-23, when the Workspace session policy
#   expired gcloud AND application-default credentials twice in one day
#   (`invalid_grant … invalid_rapt`) and killed every one of them mid-walk.
#   In-region, as a service account, there is no user session to expire.
#
# ## ALL RUN AS lake-writer-{env}@, NEVER AS stockbook-api@
#
# lake-layout.md §10: `stockbook-api@` holds nothing on BigQuery, and that is
# the version of "the web request path never queries BigQuery" that survives
# someone not having read it. Every sibling job provisioner mounts
# GCP_SERVICE_ACCOUNT_KEY_BASE64, and THESE JOBS MUST NOT: an explicit key beats
# the runtime service account wherever a client reads it, so the key would
# silently turn both jobs back into stockbook-api@. Both construct their
# BigQuery and Storage clients with ADC, which resolves to the runtime SA.
#
# ## WHO GRANTS WHAT
#
# setup-lake.sh owns the lake's identity: the SA, its dataset ACLs (WRITER on
# bronze/silver/gold), project jobUser, and objectCreator + objectViewer on
# gs://stockbook-lake-{env} (4c). This script VERIFIES that bucket grant
# read-only and refuses without it, rather than making a second copy of it.
# What only these two jobs need is granted here:
#
#   DD_API_KEY_{ENV}         secretAccessor                  every job: telemetry
#   DATABASE_URL_{ENV}       secretAccessor                  every job that reads
#                                                            Mongo (all but
#                                                            lake-release and
#                                                            lake-replay-in)
#   event-lake-sink-{env}    run.invoker (on that job only)  the hourly trigger runs
#                                                            as the job's own SA
#   gs://stockbook-content-{env}  objectViewer, CONDITIONED  the two replays: READ
#     feeds/   (lake-replay-in: the archived exchange files)   only, and only these
#     candles/ (lake-replay-us: the US cold shards)            two prefixes
#
# DATABASE_URL_{ENV} widens lake-writer-{env}@ to that environment's Mongo URI.
# event-lake-sink cannot do its job without it; a dedicated sink SA would be
# the narrower shape.
#
# The content-bucket read is scoped per PREFIX, like setup-databento-jobs.sh's
# `databento/` grant (which this SA already holds): the replays GET objects by
# COMPUTED key and never list, so a condition on the object name is the whole
# grant. The content bucket is uniform-access, which a conditioned binding
# requires.
#
# ## IMAGE: pinned from the LIVE service, and printed
#
# Cloud Run JOBS pin their image at provision time; a deploy of the SERVICE does
# not move them. So this resolves the image off the live stockbook-workers-{env}
# service and PRINTS the tag and the commit SHA inside it — that SHA is what
# each job's `[build-provenance]` line must echo back. Re-run this script after
# every workers deploy until the release's re-pin loop names both jobs.
#
# ## ORDER
#
#   1. workers/tsup.config.ts carries an entry for every job here, and workers
#      is DEPLOYED (otherwise the job dies at start with
#      "Cannot find module /app/dist/<job>.js").
#   2. ./scripts/ops/setup-lake.sh {env}    (the SA, the bucket, the datasets)
#   3. this script.
#
# ## WHICH JOB IS ARMED
#
# event-lake-sink: `--apply` is in the DEPLOYED args, because the scheduler POSTs
# `:run` with no overrides — without it the hourly run is a permanent dry run
# and nothing ever expires. It has no arm variable to set.
#
# lake-release: PLAN. Its args carry no `--apply`, and LAKE_RELEASE_APPLY ships
# PRESENT and "false" (absent and "false" must not be the same state,
# MONEY-1214). A cut is a per-EXECUTION override, printed at the end, so the
# job spec itself is never left armed.
#
# The five LOADS: deployed with `--args=""`. A bare `jobs execute` therefore
# refuses (`--env must be qa or prod`) rather than running a default nobody
# chose — each needs a window, a table set or a mode that is an operator
# decision per run. Every one is a DRY RUN without `--apply`, so the deployed
# spec is never armed either.
#
# ALWAYS PASS `--env` EQUAL TO THE JOB'S OWN ENV. Inside a Cloud Run job
# `pinJobEnv` uses the MOUNTED DATABASE_URL, which belongs to the job's env —
# so a mismatch such as `identity-sync-prod --args=--env,qa` is REFUSED at
# startup: `databaseUrlForEnv` (packages/core/src/ops/gcp-secrets.ts) throws
# when the job's `-{qa|prod}` suffix disagrees with `--env`, naming the job to
# execute instead. The printed commands carry the right one.

set -euo pipefail

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
GCLOUD_ACCOUNT="founder@disdigital.in"

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

# EXPLICIT per-env mapping. `job-metrics-path.test.ts` requires the literals, and
# a computed secret name cannot be grepped for.
case "$ENV" in
    prod)
        DB_SECRET="DATABASE_URL_PROD"
        DD_SECRET="DD_API_KEY_PROD"
        ;;
    qa)
        DB_SECRET="DATABASE_URL_QA"
        DD_SECRET="DD_API_KEY_QA"
        ;;
    *)
        echo "Usage: ./scripts/ops/setup-lake-jobs.sh {qa|prod} [--dry-run] [--image=IMG]" >&2
        exit 1
        ;;
esac

GC=(gcloud --project="$PROJECT_ID" --account="$GCLOUD_ACCOUNT")
SERVICE_NAME="stockbook-workers-${ENV}"
JOB_SA="lake-writer-${ENV}@${PROJECT_ID}.iam.gserviceaccount.com"
LAKE_BUCKET="stockbook-lake-${ENV}"
CONTENT_BUCKET="stockbook-content-${ENV}"

# Every caller is an IAM binding, whose stdout is the whole policy — noise.
run() {
    if [ "$DRY_RUN" = true ]; then
        echo "   [dry-run] gcloud ${*:2}"
    else
        "$@" >/dev/null
    fi
}

# ── 1. Preflight — read-only, and it runs on a dry run too ──────────────────
echo -e "${BLUE}━━━ 1/6: Preflight (${ENV}) ━━━${NC}"
if ! "${GC[@]}" iam service-accounts describe "$JOB_SA" >/dev/null 2>&1; then
    echo -e "   ${RED}REFUSING: ${JOB_SA} does not exist.${NC} Run ./scripts/ops/setup-lake.sh ${ENV} first." >&2
    exit 1
fi
if ! "${GC[@]}" storage buckets describe "gs://${LAKE_BUCKET}" >/dev/null 2>&1; then
    echo -e "   ${RED}REFUSING: gs://${LAKE_BUCKET} does not exist.${NC} Run ./scripts/ops/setup-lake.sh ${ENV} first." >&2
    exit 1
fi

# setup-lake.sh 4c's grant, read back. Without it lake-release dies at its first
# EXPORT DATA (BigQuery writes the parquet to GCS as the CALLER).
BUCKET_IAM="$("${GC[@]}" storage buckets get-iam-policy "gs://${LAKE_BUCKET}" --format=json)"
for ROLE in roles/storage.objectCreator roles/storage.objectViewer; do
    if ! BUCKET_IAM="$BUCKET_IAM" ROLE="$ROLE" MEMBER="serviceAccount:${JOB_SA}" node -e '
        const p = JSON.parse(process.env.BUCKET_IAM || "{}");
        const ok = (p.bindings || []).some((b) => b.role === process.env.ROLE && !b.condition
          && (b.members || []).includes(process.env.MEMBER));
        process.exit(ok ? 0 : 1);
    '; then
        echo -e "   ${RED}REFUSING: ${JOB_SA%%@*} lacks ${ROLE} on gs://${LAKE_BUCKET}.${NC} Run ./scripts/ops/setup-lake.sh ${ENV} first." >&2
        [ "$DRY_RUN" = true ] || exit 1
    fi
done

IMAGE_SOURCE="explicit --image"
if [ -z "$IMAGE" ]; then
    IMAGE_SOURCE="live ${SERVICE_NAME} service"
    IMAGE="$("${GC[@]}" run services describe "$SERVICE_NAME" --region="$REGION" \
        --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
fi
# FAILS CLOSED. An empty IMAGE would either error mid-deploy or be read as
# "keep whatever is there", which silently preserves a stale pin.
if [ -z "$IMAGE" ]; then
    echo -e "   ${RED}Could not resolve the ${SERVICE_NAME} image.${NC} Deploy workers, or pass --image=..." >&2
    exit 1
fi
IMAGE_TAG="${IMAGE##*:}"
IMAGE_SHA="${IMAGE_TAG#"${ENV}"-}"
echo -e "   SA     : ${GREEN}${JOB_SA}${NC}"
echo -e "   image  : ${GREEN}${IMAGE}${NC}  (${IMAGE_SOURCE})"
echo -e "   commit : ${GREEN}${IMAGE_SHA}${NC}"
echo -e "   ${YELLOW}PREFLIGHT: this image must contain a dist/<job>.js for every job below"
echo -e "   (workers/tsup.config.ts entries; the five loads landed with MONEY-1609). On"
echo -e "   an older image the job dies instantly with \"Cannot find module\".${NC}"

# ── 2. Grants — idempotent; a failure aborts rather than warns ──────────────
echo -e "${BLUE}━━━ 2/6: Grants to ${JOB_SA%%@*} ━━━${NC}"
for SECRET in "$DD_SECRET" "$DB_SECRET"; do
    echo "   roles/secretmanager.secretAccessor on ${SECRET}"
    run "${GC[@]}" secrets add-iam-policy-binding "$SECRET" \
        --member="serviceAccount:${JOB_SA}" --role=roles/secretmanager.secretAccessor \
        --quiet
done

# Object READS on the content bucket, one conditioned binding per prefix.
# NO COMMA anywhere in the value: gcloud splits --condition on commas into
# KEY=VALUE pairs, so a comma inside the expression or the description breaks
# the parse (see setup-databento-jobs.sh). Reads only — neither replay lists.
for PREFIX_GRANT in "feeds:lake-replay-in reads the archived exchange files only" \
                    "candles:lake-replay-us reads the US candle cold shards only"; do
    PREFIX="${PREFIX_GRANT%%:*}"
    COND="expression=resource.name.startsWith(\"projects/_/buckets/${CONTENT_BUCKET}/objects/${PREFIX}/\"),title=${PREFIX}-read-lake-writer,description=${PREFIX_GRANT#*:}"
    echo "   roles/storage.objectViewer on gs://${CONTENT_BUCKET}/${PREFIX}/ (conditioned)"
    run "${GC[@]}" storage buckets add-iam-policy-binding "gs://${CONTENT_BUCKET}" \
        --member="serviceAccount:${JOB_SA}" --role=roles/storage.objectViewer \
        --condition="$COND"
done

# $1 job BASE (the helper appends -${ENV}), $2 entrypoint, $3 memory,
# $4 task timeout, $5 args, $6 extra env (",": terminated), $7 extra secrets.
# The first two are passed LITERALLY at the call sites, which is what
# `job-build-provenance.test.ts` parses: a name built by string arithmetic is a
# name no guard can read, and an un-re-pinned job runs last release's code and
# exits 0 (MONEY-1205/1250/1314/1317).
deploy_job() {
    local suffix=$1 entrypoint=$2 memory=$3 timeout=$4 args=$5 env_extra=$6 secrets_extra=$7
    local job_name="${suffix}-${ENV}"
    # A Cloud Run JOB inherits NO service env block, so this is the whole env.
    # DD_TRACE_ENABLED=false overrides the `true` the image bakes in (a job has
    # no agent); DD_API_KEY is what makes the job's logs and metrics leave the
    # container at all (MONEY-1278 / MONEY-1375). DD_VERSION is absent on
    # purpose — it is baked into the image and must stay a property of it.
    local env_vars="${env_extra}DD_ENV=${ENV},DD_TRACE_ENABLED=false"
    local deploy_args=(
        run jobs deploy "$job_name"
        --image="$IMAGE"
        --region="$REGION"
        --service-account="$JOB_SA"
        # The script path belongs in --command, NOT --args: `jobs execute
        # --args` REPLACES the container's args, so an entrypoint there would be
        # dropped by every parameterised execution.
        --command="node,$entrypoint"
        --args="$args"
        # A retry is a second run with no human looking: for lake-release that
        # mints a SECOND release id, for the sink it overlaps the next hour.
        --max-retries=0
        --task-timeout="$timeout"
        --memory="$memory"
        --cpu=1
        --set-env-vars="$env_vars"
        --set-secrets="${secrets_extra}DD_API_KEY=${DD_SECRET}:latest"
    )
    if [ "$DRY_RUN" = true ]; then
        echo "   [dry-run] ${GC[*]} ${deploy_args[*]}"
        return
    fi
    "${GC[@]}" "${deploy_args[@]}"
    echo -e "   ${GREEN}${job_name} deployed${NC}"
}

# ── 3. lake-release — manual, PLAN by default ───────────────────────────────
#
# 2Gi: no row passes through Node (EXPORT DATA writes the parquet), and the
# sha256 read-back streams. 6h: ~80 EXPORT statements (India D1 is ~32 years,
# US M1 is month-grained) plus the read-back of every object.
echo -e "${BLUE}━━━ 3/6: Cloud Run Job — lake-release-${ENV} ━━━${NC}"
deploy_job "lake-release" "dist/lake-release.js" "2Gi" "21600" \
    "--env,${ENV}" \
    "LAKE_RELEASE_APPLY=false,LAKE_PROJECT=${PROJECT_ID},GCP_PROJECT_ID=${PROJECT_ID}," \
    ""

# ── 4. event-lake-sink — hourly, ARMED ──────────────────────────────────────
#
# 50 minutes, under the 60-minute cadence ON PURPOSE: two overlapping runs read
# the same "not yet in silver" keys and both append them. A run killed at the
# limit is safe — every unstamped row is re-read by the next one.
# NO LAKE_ENV in its env: `pinJobEnv(--env)` is that job's only writer of it.
echo -e "${BLUE}━━━ 4/6: Cloud Run Job — event-lake-sink-${ENV} ━━━${NC}"
deploy_job "event-lake-sink" "dist/event-lake-sink.js" "1Gi" "3000" \
    "--env,${ENV},--apply" \
    "" \
    "DATABASE_URL=${DB_SECRET}:latest,"
run "${GC[@]}" run jobs add-iam-policy-binding "event-lake-sink-${ENV}" --region="$REGION" \
    --member="serviceAccount:${JOB_SA}" --role=roles/run.invoker --quiet

# ── 5. The long lake loads — manual, NO default args (MONEY-1609) ───────────
#
# Sized from the 2026-09-22/23 laptop runs, read back off the prod ledger
# (`lake_bronze_prod.partition_load`) rather than remembered:
#
#   lake-replay-in   24h (the Cloud Run max), 4Gi. price_bar_d1 v2 accepted a
#                    month per ~106 s locally (247 months in 7h13m) and F&O
#                    ran 136-298 s/month, so one table's whole history is
#                    ~9-12 h by laptop. A kill costs only time — the ledger
#                    resumes per month — but a whole history per execution is
#                    the point. 4Gi: it streams one session file at a time, and
#                    an NSE F&O UDiFF day is every strike on every underlying.
#   lake-replay-us   24h, 4Gi. SYMBOL-major over ~232k symbol-years and it
#                    finishes partitions only at the END of the walk, so a kill
#                    loses the whole execution — shard by --from/--to rather
#                    than lean on the timeout. Its buffer is capped at 200k rows.
#   filing-registry-sync  6h, 2Gi. 18.8M us_filings rows in 5,000-row pages
#                    (~2h from a laptop) + 188 stage objects of 100k rows (~54MB
#                    NDJSON each, held once) + one load + one MERGE. Atomic: a
#                    killed run changed nothing, so 3x headroom rather than 24h.
#   corp-action-lake-sink 1h, 1Gi. 59k rows, a ~8 s scan, ~30 INSERTs.
#   identity-sync    2h, 2Gi. ~100k listings built in memory, DML in 2,000-row
#                    chunks.
#
# NO extra env on any of them: each pins its own environment from `--env`
# (`pinJobEnv`, or for lake-replay-in LAKE_ENV + GCP_STORAGE_BUCKET directly),
# and a second spelling here could only disagree with it. DATABASE_URL is
# mounted on exactly the four that call `pinJobEnv` — inside a Cloud Run job it
# THROWS without the mount rather than falling back to gcloud; lake-replay-in
# never reads Mongo and gets none.
echo -e "${BLUE}━━━ 5/6: Cloud Run Jobs — the lake loads (manual, args per execution) ━━━${NC}"
deploy_job "lake-replay-in" "dist/lake-replay-in.js" "4Gi" "86400" "" \
    "" \
    ""
deploy_job "lake-replay-us" "dist/lake-replay-us.js" "4Gi" "86400" "" \
    "" \
    "DATABASE_URL=${DB_SECRET}:latest,"
deploy_job "filing-registry-sync" "dist/filing-registry-sync.js" "2Gi" "21600" "" \
    "" \
    "DATABASE_URL=${DB_SECRET}:latest,"
deploy_job "corp-action-lake-sink" "dist/corp-action-lake-sink.js" "1Gi" "3600" "" \
    "" \
    "DATABASE_URL=${DB_SECRET}:latest,"
deploy_job "identity-sync" "dist/identity-sync.js" "2Gi" "7200" "" \
    "" \
    "DATABASE_URL=${DB_SECRET}:latest,"

# ── 6. The hourly trigger ───────────────────────────────────────────────────
#
# Hourly is plenty: the sink re-reads a 2h overlap past its watermark plus every
# unstamped row, so a missed hour is caught by the next. A bare POST to `:run`
# executes with the DEPLOYED args, which carry `--apply` and never `--reload`
# (a one-time operator step after a parser-version bump).
#
# Called with the job BASE and a literal cron, so monitor-agreement.test.ts's
# `cronsForJob` can read the schedule the day an absence monitor is added.
echo -e "${BLUE}━━━ 6/6: Cloud Scheduler ━━━${NC}"
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
schedule_job_run "event-lake-sink-hourly" "event-lake-sink" "10 * * * *" \
    "MONEY-1521 event-lake-sink: Mongo instrument_events -> lake_silver.instrument_event, then stamps expiresAt (90-day TTL). The ONLY writer of expiresAt - while this does not run, nothing expires."
echo -e "   ${YELLOW}lake-release: none, deliberately. A release is a human decision.${NC}"
echo -e "   ${YELLOW}the five loads: none, deliberately. Each is an operator run.${NC}"

# Unquoted heredoc so every command names the env that was provisioned.
if [ "$DRY_RUN" = true ]; then OUTCOME="DRY RUN (${ENV}) — nothing was changed"; else OUTCOME="Provisioned (${ENV})"; fi
cat <<EOF

────────────────────────────────────────────────────────────────
${OUTCOME}. Image ${IMAGE_TAG}.

lake-release-${ENV} — PLAN (writes nothing):
  gcloud run jobs execute lake-release-${ENV} --region=${REGION}

lake-release-${ENV} — CUT. Arms THIS execution only; the job spec stays "false":
  gcloud run jobs execute lake-release-${ENV} --region=${REGION} \\
    --args="--env,${ENV},--apply" --update-env-vars=LAKE_RELEASE_APPLY=true

lake-release-${ENV} — verify a cut against the bucket (exit 2 = disagreement).
RELEASE_ID is the id the cut logged; unset, the shell refuses rather than guessing:
  gcloud run jobs execute lake-release-${ENV} --region=${REGION} \\
    --args="--env,${ENV},--verify,\${RELEASE_ID:?set RELEASE_ID to the id the cut printed}"

event-lake-sink-${ENV} — runs hourly at :10 IST with --env ${ENV} --apply.
  Dry run by hand:   gcloud run jobs execute event-lake-sink-${ENV} --region=${REGION} --args="--env,${ENV}"

The five LOADS — deployed with NO args; each is a DRY RUN until --apply.
Always pass --env ${ENV}, the job's own env (see the header). One table per
execution: gcloud splits --args on commas, so a --tables LIST cannot ride it. Examples:
  gcloud run jobs execute lake-replay-in-${ENV} --region=${REGION} \\
    --args="--env,${ENV},--from,2019-06-01,--to,2026-09-22,--tables,price_bar_d1,--apply"
  gcloud run jobs execute lake-replay-us-${ENV} --region=${REGION} \\
    --args="--env,${ENV},--from,2015-01-01,--to,2026-09-30,--tables,price_bar_d1,--apply"
  gcloud run jobs execute filing-registry-sync-${ENV} --region=${REGION} --args="--env,${ENV},--apply"
  gcloud run jobs execute corp-action-lake-sink-${ENV} --region=${REGION} --args="--env,${ENV},--apply,--reload"
  gcloud run jobs execute identity-sync-${ENV} --region=${REGION} --args="--env,${ENV},--rebase-history"
Follow one:  gcloud run jobs executions list --job=<job>-${ENV} --region=${REGION}

Each job's first log line is [build-provenance]; its SHA must be ${IMAGE_SHA}.
EOF
