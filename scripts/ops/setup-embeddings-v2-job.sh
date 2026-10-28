#!/bin/bash
# ============================================
# UseMoney - document_embeddings -> _v2 migration (Cloud Run Job) — MONEY-1499
# ============================================
# Deploys ONE Cloud Run JOB off the EXISTING stockbook-workers image:
#
#   embeddings-v2-backfill-{env}
#       scripts/jobs/embeddings-v2-backfill.ts -> dist/embeddings-v2-backfill.js
#
# It quantizes every `document_embeddings` vector to int8 BinData and writes it
# into `document_embeddings_v2`, executing docs/reference/embeddings-decision-2026-09.md §5.
#
# ## Why a JOB and not the Pub/Sub push worker
#
# 5.95M rows and ~67 GiB read, measured by B0 on 2026-09-17. Pub/Sub's ack
# deadline maxes out at 600 s and cannot be raised; past it the message is
# REDELIVERED and a second copy of the migration runs beside the first, against
# the same cursor. A job has no ack deadline at all, and this one resumes from
# a checkpoint rather than from a process.
#
# ## THIS JOB DELETES NOTHING
#
# Not a row, not a collection, not an index. Its `--rename-v1` mode RENAMES v1
# to `document_embeddings_v1_retired`, which preserves every document, and
# refuses outright unless v2 already holds at least as many rows AND the
# EMBEDDINGS_V2 flag is already `on`. The DROP after B0's 30-day window is a
# founder action with no code anywhere in this repo.
#
# ## TWO ARM FLAGS, ONE PER IRREVERSIBILITY
#
#   EMBEDDINGS_V2_BACKFILL_APPLY   arms the migration's writes
#   EMBEDDINGS_V2_RENAME_APPLY     arms the cut-over rename
#
# SEPARATE on purpose, and for the same reason XBRL_PROJECTION_APPLY and
# XBRL_RATIOS_APPLY were split: the steady state is "backfill armed, rename
# not", and one switch could not express it. Both ship PRESENT and "false" —
# absent and explicitly-off must never be the same state (MONEY-1214) — and
# both are compared against the LITERAL string in code, never Boolean(),
# because Boolean("false") is true.
#
# ## IMAGE: pinned from the LIVE service, and printed
#
# Cloud Run JOBS pin their image at provision time; a deploy of the SERVICE does
# not move them. On 2026-08-18 `feed-parse-prod` was still running a four-day-old
# image, exiting 0 nightly while skipping four feed families it had never heard
# of. So this resolves the image off the live service and PRINTS the tag and the
# commit SHA inside it — that SHA is what the job's own logs must echo back.
#
# ## NO SCHEDULER TRIGGER, EVER
#
# This is a ONE-TIME migration a human supervises, exactly like
# `databento-harvest`. A cron would be a standing authorisation to keep
# rewriting a 67 GiB collection.

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
JOB_SA="stockbook-api@${PROJECT_ID}.iam.gserviceaccount.com"

ENV=${1:-""}
shift || true

IMAGE=""
DRY_RUN=false
# 6h. The migration reads ~67 GiB and writes ~38, which is hours rather than a
# day; and the job stops CLEANLY at --max-minutes (default 330 = 5.5h) so the
# final checkpoint always lands inside the timeout rather than being killed
# mid-page. Re-running resumes from that checkpoint.
TASK_TIMEOUT="21600"
while [ $# -gt 0 ]; do
    case "$1" in
        --image=*)        IMAGE="${1#*=}"; shift ;;
        --task-timeout=*) TASK_TIMEOUT="${1#*=}"; shift ;;
        --dry-run)        DRY_RUN=true; shift ;;
        -h|--help)        grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

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
        echo "Usage: ./scripts/ops/setup-embeddings-v2-job.sh [qa|prod] [options]"
        echo ""
        echo "Options:"
        echo "  --image=IMG            Pin an explicit image instead of resolving it"
        echo "                         from the live stockbook-workers-{env} service"
        echo "  --task-timeout=SECS    Cloud Run task timeout (default 21600 = 6h)"
        echo "  --dry-run              Print the gcloud calls, change nothing"
        echo ""
        echo "Deploys the Cloud Run job embeddings-v2-backfill-{env} (MONEY-1499)."
        echo "Ships DISARMED. No Scheduler trigger, ever — see the header."
        exit 1
        ;;
esac

SERVICE_NAME="stockbook-workers-${ENV}"
JOB_NAME="embeddings-v2-backfill-${ENV}"
ENTRYPOINT="dist/embeddings-v2-backfill.js"

# Per the repo's GCP isolation rule: never activate a config, always pass the
# account/project explicitly on each call.
GC=(gcloud --project="$PROJECT_ID" --account=founder@disdigital.in)

# ── 1. Resolve the image from the live service ────────────────────────────
echo -e "${BLUE}━━━ 1/3: Resolve image from ${SERVICE_NAME} ━━━${NC}"
IMAGE_SOURCE="explicit --image"
if [ -z "$IMAGE" ]; then
    IMAGE_SOURCE="live ${SERVICE_NAME} service"
    IMAGE="$("${GC[@]}" run services describe "$SERVICE_NAME" \
        --region="$REGION" \
        --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
fi

# FAILS CLOSED. An empty IMAGE must never reach `gcloud run jobs deploy` — it
# would either error mid-deploy or be read as "keep whatever is there", which
# silently preserves the stale pin this script exists to move.
if [ -z "$IMAGE" ]; then
    echo -e "${RED}Could not resolve the ${SERVICE_NAME} image.${NC}"
    echo "Is the workers service deployed to ${ENV}? Otherwise pass --image=..."
    exit 1
fi

IMAGE_TAG="${IMAGE##*:}"
IMAGE_SHA="${IMAGE_TAG#"${ENV}"-}"
echo -e "   image  : ${GREEN}${IMAGE}${NC}"
echo -e "   source : ${IMAGE_SOURCE}"
echo -e "   tag    : ${GREEN}${IMAGE_TAG}${NC}"
echo -e "   commit : ${GREEN}${IMAGE_SHA}${NC}"
echo -e "   ${YELLOW}PREFLIGHT: this image must contain ${ENTRYPOINT}"
echo -e "   (the 'embeddings-v2-backfill' entry in workers/tsup.config.ts). On an"
echo -e "   older image the container dies instantly with"
echo -e "   \"Cannot find module /app/${ENTRYPOINT}\".${NC}"

# ── 2. Deploy the job ─────────────────────────────────────────────────────
echo -e "${BLUE}━━━ 2/3: Cloud Run Job — ${JOB_NAME} ━━━${NC}"

# 2Gi: one page is 500 v1 rows at ~12 KiB each (~6 MiB of BSON), plus the
# extended-JSON expansion of 500 float64 arrays. The control is the page size,
# not the container — the checkpoint means an interruption costs one page.
deploy_args=(
    run jobs deploy "$JOB_NAME"
    --image="$IMAGE"
    --region="$REGION"
    --service-account="$JOB_SA"
    # The script path belongs in --command, NOT --args: `gcloud run jobs
    # execute --args=...` REPLACES the container's args rather than appending,
    # so with the entrypoint in --args every parameterised execution would drop
    # it. `--args=""` clears the list (there is no --clear-args on jobs deploy);
    # without it a re-deploy KEEPS the old args and the container runs
    # `node dist/embeddings-v2-backfill.js dist/embeddings-v2-backfill.js`.
    --command="node,$ENTRYPOINT"
    --args=""
    # A retry would re-enter the migration from its checkpoint with no human
    # looking. Resuming is free and idempotent — a re-run of an un-checkpointed
    # page collides on `_id` — but re-running is a decision, not a reflex.
    --max-retries=0
    --task-timeout="$TASK_TIMEOUT"
    --memory=2Gi
    --cpu=1
    # Set EXPLICITLY: a Cloud Run JOB does not inherit the SERVICE's env block.
    #
    # Both arm flags ship PRESENT and "false". To arm, use --update-env-vars
    # (NOT --set-env-vars, which replaces the whole block and would wipe the
    # DD_* wiring):
    #
    #   gcloud run jobs update embeddings-v2-backfill-prod --region=asia-south1 \
    #     --update-env-vars=EMBEDDINGS_V2_BACKFILL_APPLY=true
    #
    # DD_VERSION is absent ON PURPOSE — it is baked into the image and must stay
    # a property of the image. MONEY-1278: a JOB has no Datadog agent, so
    # DD_API_KEY is what makes `datadog-metrics` emit at all, and
    # DD_TRACE_ENABLED=false overrides the `true` the image bakes in so dd-trace
    # does not boot against a socket that is not there.
    --set-env-vars="EMBEDDINGS_V2_BACKFILL_APPLY=false,EMBEDDINGS_V2_RENAME_APPLY=false,GCP_PROJECT_ID=${PROJECT_ID},DD_ENV=${ENV},DD_TRACE_ENABLED=false"
    --set-secrets="DATABASE_URL=${DB_SECRET}:latest,GCP_SERVICE_ACCOUNT_KEY_BASE64=GCP_SERVICE_ACCOUNT_KEY_BASE64:latest,DD_API_KEY=${DD_SECRET}:latest"
)

if [ "$DRY_RUN" = true ]; then
    echo "   [dry-run] gcloud ${deploy_args[*]}"
    echo "   [dry-run] gcloud run jobs add-iam-policy-binding ${JOB_NAME} --region=${REGION} --member=serviceAccount:${JOB_SA} --role=roles/run.invoker"
else
    "${GC[@]}" "${deploy_args[@]}"
    "${GC[@]}" run jobs add-iam-policy-binding "$JOB_NAME" --region="$REGION" \
        --member="serviceAccount:${JOB_SA}" --role=roles/run.invoker \
        --quiet >/dev/null
    echo -e "   ${GREEN}${JOB_NAME} deployed (DISARMED)${NC}"
fi

# ── 3. No Scheduler trigger — deliberate ──────────────────────────────────
echo -e "${BLUE}━━━ 3/3: Cloud Scheduler ━━━${NC}"
echo -e "   ${YELLOW}None, deliberately. A one-time migration does not get a cron.${NC}"
echo ""
echo -e "${BLUE}Order of operations:${NC}"
echo "   0. Take an Atlas snapshot. B0 §6 requires it BEFORE the first write."
echo "   1. npx tsx scripts/ops/apply-atlas-search-indexes.ts --env=${ENV} --probe --apply"
echo "      (proves subtype 9 survives \$runCommandRaw and Atlas accepts a BinData"
echo "       queryVector — neither is provable by reading, both are silent when wrong)"
echo "   2. npx tsx scripts/ops/apply-atlas-search-indexes.ts --env=${ENV} --apply"
echo "   3. Set PlatformConfig EMBEDDINGS_V2 = \"dual\"   (writes go to both)"
echo "   4. Arm EMBEDDINGS_V2_BACKFILL_APPLY=true, then execute this job until"
echo "      --verify reports 'outstanding 0'"
echo "   5. npx tsx scripts/ops/embeddings-parity.ts --env=${ENV} --out=parity.json"
echo "   6. Set EMBEDDINGS_V2 = \"on\". Watch Datadog p95 for 7 days."
echo "   7. Execute --census, and land the numbers back in the decision doc."
echo "   8. Only then: arm EMBEDDINGS_V2_RENAME_APPLY and execute --rename-v1 --apply."
echo "   9. The DROP is a founder action, after B0's 30-day window. Not in this repo."
