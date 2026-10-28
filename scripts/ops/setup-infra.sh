#!/bin/bash
# ============================================
# UseMoney - Infrastructure Setup (Single Command)
# ============================================
# Runs all infra steps for a given environment:
#   1. Prisma db push (schema → MongoDB)
#   2. Pub/Sub topics + subscriptions (idempotent)
#   3. Cloud Scheduler jobs (upsert)
#   4. Service deploys (Cloud Build → Cloud Run) — ALL deployables
#   5. EDGAR push subscriptions — step 2 again, now that step 4 minted the URL
#
# All steps are idempotent - safe to re-run.
# Skips existing topics/subscriptions, upserts scheduler jobs.
#
# ── WHY THERE IS A STEP 5, AND WHY IT IS A RE-RUN OF STEP 2 (MONEY-979) ───────
#
# The seven `edgar-*-{env}-push` subscriptions need the Cloud Run URL of
# `us-fundamentals-{env}` as BOTH their push endpoint and their OIDC audience,
# and that URL does not exist until step 4 has deployed the service. On a cold
# environment step 2 therefore cannot create them — it says so loudly and
# carries on — and nothing later in the ladder went back for them. The result
# was seven topics with no subscriber, which is the worst possible shape: a
# topic with no subscription DROPS messages silently. No DLQ, no error, no
# metric, while `edgar-detect-minutely-{env}` publishes 1,440 times a day.
#
# So the deploy is followed by a second `setup-pubsub.sh` run, this time with
# EDGAR_PUSH_REQUIRED=1 — the service has just been built, so its absence is now
# a real error and exits non-zero rather than degrading.
#
# It only runs when step 4 ACTUALLY deployed us-fundamentals in this invocation
# (or when the operator selects step 5 directly). A re-run after `--skip-deploy`
# would ask a question whose answer step 2 already gave.
#
# ── STEP 4 DEPLOYS TWO SERVICES, NOT ONE (MONEY-979) ─────────────────────────
#
# This repo has three Cloud Run deployables and step 4 used to know about one.
# `services/us-fundamentals` is the SEC EDGAR engine: steps 2 and 3 create its
# seven Pub/Sub topics and its three Scheduler entries, all of which target
# `us-fundamentals-{env}`. A run that provisioned those and skipped the deploy
# left every one of them firing at a service that does not exist — a push
# subscription 404ing five times and dead-lettering, once a minute, which reads
# as a failing job rather than a missing service.
#
# So the deploy step now walks DEPLOY_TARGETS. `--only deploy` runs both;
# `--only workers` / `--only us-fundamentals` run one.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - GCP setup completed (workers/scripts/gcp-setup.sh)
#   - Secrets in GCP Secret Manager (DATABASE_URL_QA/PROD, etc.)
#
# Usage:
#   ./scripts/ops/setup-infra.sh qa                       # Full setup for QA
#   ./scripts/ops/setup-infra.sh prod                     # Full setup for Production
#   ./scripts/ops/setup-infra.sh qa --skip-deploy         # Skip Cloud Build + deploy
#   ./scripts/ops/setup-infra.sh qa --only db             # Only run db push
#   ./scripts/ops/setup-infra.sh qa --only us-fundamentals # Deploy just that service
#   ./scripts/ops/setup-infra.sh qa --step 2              # Run only step 2 (pubsub)
#   ./scripts/ops/setup-infra.sh qa --from 3              # Run steps 3-5
#   ./scripts/ops/setup-infra.sh qa --only edgar-push     # Just the EDGAR push subs
#
# NOT covered here, and each has its own script — they are one-time or
# separately-approved, so folding them into a routine re-run would be wrong.
#
# THIS LIST IS MACHINE-CHECKED. `setup-infra-coverage.test.ts` fails when a
# `scripts/ops/setup-*.sh` exists that neither list here names, because a
# discovery list nobody can check is a discovery list that rots: it named three
# of ten scripts for seven tickets, and every provisioner added after EDGAR —
# Tiingo, three XBRL jobs, BSE, doc-ingest, feed-backfill, the sync job and
# Databento — was invisible to an operator reading it.
#
#   scripts/ops/setup-cloudbuild-triggers.sh       the push-to-build triggers
#   scripts/ops/setup-gcs-lifecycle.sh             bucket lifecycle rules
#   scripts/ops/setup-sync-job.sh                  the prod->QA mirror job
#   scripts/ops/setup-document-ai.sh               the Document OCR processor
#   scripts/ops/setup-vertex-rag.sh                the managed RAG corpus
#   scripts/ops/setup-stocksage2.sh                the StockSage 2.0 provisioner
#   market-data (Cloud Run SERVICE + CDN), and the ORDER is load-bearing:
#     setup-market-data-sa.sh          SA + grants   — BEFORE the Cloud Build deploy
#     setup-market-data-lb.sh          NEG/backend/CDN/cert — AFTER it, and the
#                                      script REFUSES to run while the service is
#                                      absent: a serverless NEG pointed at nothing
#                                      provisions clean and 404s every request.
#   Cloud Run JOBS, one script per family:
#     setup-us-fundamentals-jobs.sh    the five SEC EDGAR jobs
#     setup-tiingo-backfill-job.sh     the three Tiingo backfills
#     setup-databento-jobs.sh          databento-harvest + databento-append
#     setup-lake.sh                    the BigQuery lake: bucket, 4 datasets, SAs
#     setup-dataform.sh                the Dataform project: silver -> gold
#     setup-xbrl-backfill-job.sh       XBRL history
#     setup-xbrl-reparse-job.sh        XBRL re-parse from the archive
#     setup-xbrl-projection-drain-job.sh  the stock_financials drain
#     setup-bse-backfill-job.sh        BSE corpfiling attachments
#     setup-doc-ingest-backfill-job.sh the historical document corpus
#     setup-feed-backfill-job.sh       historical feed backfill + parse
#     setup-tile-build-job.sh          the D1 tile builders (IN + US) — MONEY-1467
#     setup-embeddings-v2-job.sh       the v1 -> v2 embedding migration — MONEY-1499
#     setup-lake-jobs.sh               lake-release + event-lake-sink (lake-writer SA) — MONEY-1518/1521
#                                      + the five manual lake loads: lake-replay-in/-us,
#                                      filing-registry-sync, corp-action-lake-sink,
#                                      identity-sync — MONEY-1609
# ============================================

set -e

ENV=${1:-""}
SKIP_DEPLOY=false
ONLY=""
STEP_FLAG=""   # "step" or "from"
STEP_VALUE=""

# Parse arguments
shift || true
while [ $# -gt 0 ]; do
    case "$1" in
        --skip-deploy) SKIP_DEPLOY=true; shift ;;
        --only) ONLY="$2"; shift 2 ;;
        --step) STEP_FLAG="step"; STEP_VALUE="$2"; shift 2 ;;
        --from) STEP_FLAG="from"; STEP_VALUE="$2"; shift 2 ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

usage() {
    echo "Usage: ./scripts/ops/setup-infra.sh [local|qa|prod] [options]"
    echo ""
    echo "Options:"
    echo "  --skip-deploy     Skip Cloud Build + Cloud Run deploy"
    echo "  --only <name>     Run only one step by name: db, pubsub, scheduler, deploy,"
    echo "                    edgar-push …or one deploy TARGET: workers, us-fundamentals,"
    echo "                    market-data"
    echo "  --step <N>        Run only step N, 1-5 (1=db, 2=pubsub, 3=scheduler,"
    echo "                    4=deploy, 5=edgar-push)"
    echo "  --from <N>        Run from step N onwards, N in 1-5"
    echo ""
    echo "\"Only\" has ONE exception, and it is deliberate — step 5 needs the URL that"
    echo "deploying us-fundamentals MINTS, so anything that deploys it also runs step 5:"
    echo "  --step 4 / --from 4          run steps 4 AND 5"
    echo "  --only deploy                runs step 4 (every target) AND step 5"
    echo "  --only us-fundamentals       runs that one deploy AND step 5"
    echo "  --only workers               runs ONLY that deploy — no step 5, because"
    echo "                               nothing minted a us-fundamentals URL"
    echo "  --skip-deploy                suppresses step 4, and therefore step 5 too"
    echo ""
    echo "Steps (in order):"
    echo "  1. db         - Prisma db push (schema → MongoDB)"
    echo "  2. pubsub     - Pub/Sub topics + push/pull subscriptions"
    echo "  3. scheduler  - Cloud Scheduler jobs (upsert)"
    echo "  4. deploy     - Cloud Build + push + Cloud Run deploy, for BOTH"
    echo "                  deployables: workers, us-fundamentals, market-data"
    echo "  5. edgar-push - The 7 EDGAR push subscriptions, which need the URL"
    echo "                  step 4 mints. Runs only when step 4 deployed"
    echo "                  us-fundamentals, or when selected directly."
    echo ""
    echo "Environment notes:"
    echo "  local - Only step 2 (pubsub) does meaningful work. Steps 1 (db push),"
    echo "          3 (scheduler), 4 (deploy) and 5 (edgar-push) are skipped because"
    echo "          local dev shares the QA database and has no Cloud Run / Scheduler."
    echo "  qa    - All 5 steps run against QA infrastructure"
    echo "  prod  - All 5 steps run against PROD infrastructure (be careful)"
}

if [ "$ENV" != "qa" ] && [ "$ENV" != "prod" ] && [ "$ENV" != "local" ]; then
    usage
    exit 1
fi

# Map step numbers to names
STEP_NAMES=("" "db" "pubsub" "scheduler" "deploy" "edgar-push")

# ── The deployables step 4 builds ────────────────────────────────────────────
#
# `name|cloudbuild-config-prefix`. The config is "<prefix>.<env>.yaml", which is
# the naming every deployable already uses — workers/cloudbuild.qa.yaml,
# services/us-fundamentals/cloudbuild.prod.yaml — so a third service is one row
# here and nothing else.
declare -a DEPLOY_TARGETS=(
    "workers|workers/cloudbuild"
    "us-fundamentals|services/us-fundamentals/cloudbuild"
    # MONEY-1466. Its SERVICE ACCOUNT must exist first — `services replace`
    # naming an absent SA fails the deploy — so run
    # `setup-market-data-sa.sh ${ENV}` before the first deploy of an env, and
    # `setup-market-data-lb.sh ${ENV}` after it.
    "market-data|apps/market-data/cloudbuild"
)

deploy_target_names() {
    local row
    for row in "${DEPLOY_TARGETS[@]}"; do echo "${row%%|*}"; done
}

is_deploy_target() {
    local want=$1 name
    while read -r name; do
        [ "$name" == "$want" ] && return 0
    done < <(deploy_target_names)
    return 1
}

# --only takes a STEP name or a DEPLOY TARGET name. Validated up front:
# an unrecognised value used to match no step, run nothing, and still print
# "Infrastructure Setup Complete!" — a typo that reads as a successful run,
# which is this repo's most expensive bug shape and the one `--only
# us-fundamentals` would hit first.
if [ -n "$ONLY" ]; then
    VALID_ONLY=false
    for _name in "${STEP_NAMES[@]}"; do
        [ -n "$_name" ] && [ "$ONLY" == "$_name" ] && VALID_ONLY=true
    done
    is_deploy_target "$ONLY" && VALID_ONLY=true
    if [ "$VALID_ONLY" != true ]; then
        echo "Unknown --only target: ${ONLY}"
        echo ""
        usage
        exit 1
    fi
fi

# --step / --from take the same treatment, for the same reason. They were
# UNVALIDATED while `--only` was guarded: `--step 6` matched no step, ran zero
# gcloud calls, printed every checklist row `[ ]` and still ended on
# "Infrastructure Setup Complete!" — the exact "typo that reads as a successful
# run" the block above exists to stop, and the range only got wider when step 5
# was added. A non-numeric value is worse than useless: `[ "$step_num" -ge
# "$STEP_VALUE" ]` is a bash ERROR on it, which under `set -e` aborts mid-ladder
# with no explanation.
if [ -n "$STEP_FLAG" ]; then
    case "$STEP_VALUE" in
        1|2|3|4|5) ;;
        *)
            echo "Invalid --${STEP_FLAG} value: '${STEP_VALUE}' (must be 1-5)"
            echo ""
            usage
            exit 1
            ;;
    esac
fi

# Determine which steps to run
should_run() {
    local step_name=$1
    local step_num=$2

    # --only takes priority
    if [ -n "$ONLY" ]; then
        [ "$ONLY" == "$step_name" ] && return 0
        # A deploy TARGET selects the deploy STEP; the per-target gate inside
        # step 4 then narrows it to the one target.
        [ "$step_name" == "deploy" ] && is_deploy_target "$ONLY" && return 0
        return 1
    fi

    # --step N: run only that step
    if [ "$STEP_FLAG" == "step" ]; then
        [ "$step_num" == "$STEP_VALUE" ] && return 0 || return 1
    fi

    # --from N: run step N and onwards
    if [ "$STEP_FLAG" == "from" ]; then
        [ "$step_num" -ge "$STEP_VALUE" ] && return 0 || return 1
    fi

    # Default: run all
    return 0
}

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_ID="stock-book-483718"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Script lives at <repo>/scripts/ops/, so the repo root is two levels up.
# Was a single `..` until 2026-05-09 - that resolved to <repo>/scripts/
# and broke `bash workers/scripts/setup-pubsub.sh` from inside the
# wrapper.
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Build mode description
MODE="full setup"
if [ -n "$ONLY" ]; then
    MODE="only ${ONLY}"
elif [ "$STEP_FLAG" == "step" ]; then
    MODE="step ${STEP_VALUE} (${STEP_NAMES[$STEP_VALUE]:-?})"
elif [ "$STEP_FLAG" == "from" ]; then
    MODE="from step ${STEP_VALUE} (${STEP_NAMES[$STEP_VALUE]:-?}) onwards"
elif [ "$SKIP_DEPLOY" == "true" ]; then
    MODE="skip deploy"
fi

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  UseMoney Infrastructure Setup             ║"
echo "╠════════════════════════════════════════════╣"
echo "║  Environment: ${ENV}"
echo "║  Project: ${PROJECT_ID}"
echo "║  Mode: ${MODE}"
echo "╚════════════════════════════════════════════╝"
echo ""

# ============================================
# Step 1: Prisma db push
# ============================================
# Local mode shares the QA database (per current architecture), so a db push
# from local would target the same DB QA already manages - redundant. Skip.
if [ "$ENV" == "local" ]; then
    echo -e "${YELLOW}━━━ Step 1/5: Prisma db push (SKIPPED for local - shares QA db) ━━━${NC}"
elif should_run "db" 1; then
    echo -e "${BLUE}━━━ Step 1/5: Prisma db push ━━━${NC}"

    if [ "$ENV" == "qa" ]; then
        SECRET_NAME="DATABASE_URL_QA"
    else
        SECRET_NAME="DATABASE_URL_PROD"
    fi

    echo -e "   Fetching DATABASE_URL from Secret Manager (${SECRET_NAME})..." >&2
    DB_URL=$(gcloud secrets versions access latest --secret="$SECRET_NAME" --project="$PROJECT_ID" 2>/dev/null)

    if [ -z "$DB_URL" ]; then
        echo -e "   ${RED}Failed to fetch DATABASE_URL from Secret Manager${NC}"
        echo -e "   Make sure ${SECRET_NAME} exists in project ${PROJECT_ID}"
        exit 1
    fi

    echo -e "   Pushing schema to ${ENV} database..."
    cd "$ROOT_DIR"
    DATABASE_URL="$DB_URL" yarn workspace @usemoney/database prisma db push --skip-generate
    echo -e "   ${GREEN}Schema pushed${NC}"
    echo ""
else
    echo -e "${YELLOW}━━━ Step 1/5: Prisma db push (SKIPPED) ━━━${NC}"
fi

# ============================================
# Step 2: Pub/Sub setup
# ============================================
# MONEY-979 round-2 — the ladder's own verdict, read from setup-pubsub rather
# than inferred.
#
# setup-pubsub exits 0 for BOTH "everything is attached" and "the seven EDGAR
# push subscriptions could not be created because nothing has built
# us-fundamentals yet" — that is the whole point of the NOT-BUILT state, and it
# is why the exit code cannot answer this question. So it writes its verdict to
# a file, and this script reads it. Without that, `--from 2 --skip-deploy` on a
# cold environment printed, one screen apart: "Pub/Sub Setup INCOMPLETE", then a
# GREEN "Pub/Sub complete", then "Infrastructure Setup Complete!" — with `[ ] 5.`
# as the only honest signal in the whole run.
EDGAR_STATUS_FILE=$(mktemp "${TMPDIR:-/tmp}/edgar-push-status.XXXXXX")
trap 'rm -f "$EDGAR_STATUS_FILE"' EXIT
LADDER_INCOMPLETE=false

if should_run "pubsub" 2; then
    echo -e "${BLUE}━━━ Step 2/5: Pub/Sub setup ━━━${NC}"
    cd "$ROOT_DIR"
    : > "$EDGAR_STATUS_FILE"
    EDGAR_PUSH_STATUS_FILE="$EDGAR_STATUS_FILE" bash workers/scripts/setup-pubsub.sh "$ENV"
    PUBSUB_STATUS=$(cat "$EDGAR_STATUS_FILE" 2>/dev/null || true)
    # BROKEN never reaches here — setup-pubsub exits 1 and `set -e` stops us.
    if [ "$ENV" != "local" ] && [ "$PUBSUB_STATUS" == "NOT_BUILT" ]; then
        LADDER_INCOMPLETE=true
        echo -e "   ${YELLOW}Pub/Sub done EXCEPT the EDGAR push subscriptions — us-fundamentals-${ENV}${NC}"
        echo -e "   ${YELLOW}has no URL yet, so they were NOT created. Step 5 is what attaches them.${NC}"
    else
        echo -e "   ${GREEN}Pub/Sub complete${NC}"
    fi
    echo ""
else
    echo -e "${YELLOW}━━━ Step 2/5: Pub/Sub setup (SKIPPED) ━━━${NC}"
fi

# ============================================
# Step 3: Cloud Scheduler setup
# ============================================
if should_run "scheduler" 3; then
    echo -e "${BLUE}━━━ Step 3/5: Cloud Scheduler setup ━━━${NC}"
    cd "$ROOT_DIR"
    bash scripts/ops/setup-scheduler.sh "$ENV"
    echo -e "   ${GREEN}Scheduler complete${NC}"
    echo ""
else
    echo -e "${YELLOW}━━━ Step 3/5: Cloud Scheduler setup (SKIPPED) ━━━${NC}"
fi

# MONEY-979 — set by step 4 when it builds `us-fundamentals`, read by step 5.
# Declared out here so step 5 reads a defined value even when step 4 is skipped,
# filtered out by `--only workers`, or never selected at all.
US_FUNDAMENTALS_DEPLOYED=false

# ============================================
# Step 4: Service deploys (via Cloud Build - no local Docker needed)
# ============================================
# Local mode never deploys to Cloud Run - workers run via `tsx watch` on the
# developer's machine, and us-fundamentals via `uvicorn app.main:app`. Skip
# unconditionally.
if [ "$ENV" == "local" ]; then
    echo -e "${YELLOW}━━━ Step 4/5: Service deploys (SKIPPED for local - no Cloud Run target) ━━━${NC}"
elif should_run "deploy" 4 && [ "$SKIP_DEPLOY" != "true" ]; then
    echo -e "${BLUE}━━━ Step 4/5: Service deploys (Cloud Build) ━━━${NC}"
    cd "$ROOT_DIR"

    # MONEY-839: pass a UNIQUE COMMIT_SHA so the image tag (qa-$COMMIT_SHA /
    # prod-$COMMIT_SHA) differs every deploy. With the empty default the tag is
    # just "qa-", the Cloud Run service spec is byte-identical, and
    # `gcloud run services replace` NO-OPS — no new revision rolls, so the freshly
    # built image is never served (the running revision stays pinned to its
    # original digest). Appending a timestamp guarantees a new revision even when
    # re-deploying the same commit.
    #
    # Computed ONCE, above the loop, and shared by every deployable. They build
    # different images, so there is no tag collision — and one release then
    # carries ONE version string across both services, which is what makes
    # DD_VERSION comparable between them when a trace crosses the seam.
    DEPLOY_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo manual)-$(date +%Y%m%d%H%M%S)"
    echo -e "   COMMIT_SHA=${DEPLOY_SHA}"

    DEPLOYED=0
    for TARGET_ROW in "${DEPLOY_TARGETS[@]}"; do
        TARGET_NAME="${TARGET_ROW%%|*}"
        TARGET_PREFIX="${TARGET_ROW##*|}"

        # `--only <target>` narrows to one deployable. `--only deploy`, --step 4,
        # --from N and a plain run all build every target.
        if [ -n "$ONLY" ] && is_deploy_target "$ONLY" && [ "$ONLY" != "$TARGET_NAME" ]; then
            echo -e "   ${YELLOW}skip${NC} ${TARGET_NAME} (--only ${ONLY})"
            continue
        fi

        CLOUDBUILD_FILE="${TARGET_PREFIX}.${ENV}.yaml"
        if [ ! -f "$CLOUDBUILD_FILE" ]; then
            # Refuse rather than skip. `gcloud builds submit --config` on a
            # missing file fails anyway, but late and inside a build submission;
            # saying it here names which deployable is unconfigured for this env.
            echo -e "   ${RED}Missing ${CLOUDBUILD_FILE} for target ${TARGET_NAME}${NC}"
            exit 1
        fi

        echo -e "   ${BLUE}${TARGET_NAME}${NC}: ${CLOUDBUILD_FILE}"
        gcloud builds submit --config="$CLOUDBUILD_FILE" --project="$PROJECT_ID" \
            --substitutions=COMMIT_SHA="$DEPLOY_SHA" .
        echo -e "   ${GREEN}${TARGET_NAME} deployed${NC}"
        DEPLOYED=$((DEPLOYED + 1))
        # Step 5 keys off THIS, not off "the deploy step ran": the EDGAR push
        # subscriptions only need re-asserting when the service whose URL they
        # carry has actually been (re)built in this invocation.
        [ "$TARGET_NAME" == "us-fundamentals" ] && US_FUNDAMENTALS_DEPLOYED=true
    done

    # A loop that built nothing must not report a deploy. With `--only <target>`
    # this can only be 1; without it, every target.
    if [ "$DEPLOYED" -eq 0 ]; then
        echo -e "   ${RED}No deployable was built — the target filter matched nothing${NC}"
        exit 1
    fi

    echo -e "   ${GREEN}Deploy complete (${DEPLOYED} service(s), COMMIT_SHA=${DEPLOY_SHA})${NC}"
    echo ""
else
    echo -e "${YELLOW}━━━ Step 4/5: Service deploys (SKIPPED) ━━━${NC}"
fi

# ============================================
# Step 5: EDGAR push subscriptions (post-deploy) — MONEY-979
# ============================================
# Step 2 runs before anything is built, so on a cold environment it CANNOT
# create the seven `edgar-*-{env}-push` subscriptions: their push endpoint and
# their OIDC audience are both the Cloud Run URL of `us-fundamentals-{env}`, and
# `gcloud run services describe` has nothing to describe. It reports that
# loudly and — since the fix for this exact deadlock — exits 0 so the ladder can
# continue to the deploy that mints the URL.
#
# This step is the other half. Same script, run again, with
# EDGAR_PUSH_REQUIRED=1: the service has just been deployed, so if it still
# cannot be described that is a genuine failure and must exit non-zero rather
# than degrade a second time.
#
# WHY A FULL RE-RUN AND NOT A SURGICAL ONE: setup-pubsub.sh is idempotent by
# construction (topics skip if present, worker subscriptions are updated in
# place, IAM bindings are additive), and it is the command every operator
# already knows. A second, EDGAR-only entry point would be a second thing to
# keep in step with the first — the drift shape this repo has paid for before.
# WHEN THIS STEP RUNS, and why the rule is not just `should_run`.
#
# Two triggers, and BOTH of them mean "the service should be up right now":
#
#   (a) step 4 deployed us-fundamentals in THIS invocation — the URL has just
#       been minted, and this is the half of the ladder step 2 could not do.
#   (b) the operator TARGETED step 5 (`--only edgar-push`, `--step 5`,
#       `--from 5`) — "the service is already up, attach the subscriptions".
#
# `should_run` alone is WRONG here, and the difference is the whole bug this
# step exists to fix. `--from 2 --skip-deploy` on a cold environment satisfies
# `should_run "edgar-push" 5` (5 >= 2) while nothing was ever built, so step 5
# would run with EDGAR_PUSH_REQUIRED=1 and exit 1 — re-creating the
# self-blocking ladder one step further down. A range that merely CONTAINS step
# 5 is not an instruction to demand a service nobody deployed.
EDGAR_PUSH_TARGETED=false
if [ "$ONLY" == "edgar-push" ]; then
    EDGAR_PUSH_TARGETED=true
elif [ "$STEP_FLAG" == "step" ] && [ "$STEP_VALUE" == "5" ]; then
    EDGAR_PUSH_TARGETED=true
elif [ "$STEP_FLAG" == "from" ] && [ "$STEP_VALUE" == "5" ]; then
    EDGAR_PUSH_TARGETED=true
fi

EDGAR_PUSH_SELECTED=false
if [ "$US_FUNDAMENTALS_DEPLOYED" == true ] || [ "$EDGAR_PUSH_TARGETED" == true ]; then
    EDGAR_PUSH_SELECTED=true
fi

if [ "$ENV" == "local" ]; then
    echo -e "${YELLOW}━━━ Step 5/5: EDGAR push subscriptions (SKIPPED for local - no Cloud Run target) ━━━${NC}"
elif [ "$EDGAR_PUSH_SELECTED" == true ]; then
    echo -e "${BLUE}━━━ Step 5/5: EDGAR push subscriptions (post-deploy) ━━━${NC}"
    cd "$ROOT_DIR"
    : > "$EDGAR_STATUS_FILE"
    # No `|| true` here, and that is load-bearing: EDGAR_PUSH_REQUIRED=1 exists
    # so this re-run FAILS when the service it just deployed still cannot be
    # described, and swallowing that would print "Complete!" over the one state
    # step 5 was added to detect.
    EDGAR_PUSH_REQUIRED=1 EDGAR_PUSH_STATUS_FILE="$EDGAR_STATUS_FILE" \
        bash workers/scripts/setup-pubsub.sh "$ENV"
    # Under EDGAR_PUSH_REQUIRED=1 both non-COMPLETE verdicts exit non-zero, so
    # reaching this line means the subscriptions are attached — which also
    # clears anything step 2 flagged.
    LADDER_INCOMPLETE=false
    echo -e "   ${GREEN}EDGAR push subscriptions complete${NC}"
    echo ""
else
    echo -e "${YELLOW}━━━ Step 5/5: EDGAR push subscriptions (SKIPPED - us-fundamentals was not deployed in this run) ━━━${NC}"
    echo -e "   Nothing minted a new URL, so step 2's result still stands. To attach"
    echo -e "   them against an already-deployed service: --only edgar-push"
fi

# ============================================
# Done
# ============================================
echo ""
if [ "$LADDER_INCOMPLETE" == true ]; then
    # Not a failure and not exit 1 — `--skip-deploy` on a cold environment is a
    # legitimate operator action, and the NOT-BUILT state exists precisely so
    # the ladder can continue. But the banner must not say "Complete!" over
    # seven topics with no subscriber, because a topic with no subscription
    # DROPS every message silently: no DLQ, no error, no metric.
    echo -e "${YELLOW}╔════════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}║  Infrastructure Setup INCOMPLETE           ║${NC}"
    echo -e "${YELLOW}╚════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}The ${ENV} EDGAR push subscriptions were NOT created: us-fundamentals-${ENV}${NC}"
    echo -e "${YELLOW}has no URL, and nothing in this run deployed it. Finish the ladder with${NC}"
    echo -e "${YELLOW}either of:${NC}"
    echo "  ./scripts/ops/setup-infra.sh ${ENV}                  # deploys, then attaches them"
    echo "  ./scripts/ops/setup-infra.sh ${ENV} --only edgar-push  # if it is ALREADY deployed"
else
    echo "╔════════════════════════════════════════════╗"
    echo "║  Infrastructure Setup Complete!            ║"
    echo "╚════════════════════════════════════════════╝"
fi
echo ""
echo "What ran:"
should_run "db" 1 && echo "  [x] 1. Prisma db push (${ENV})" || echo "  [ ] 1. Prisma db push"
should_run "pubsub" 2 && echo "  [x] 2. Pub/Sub topics + subscriptions (${ENV})" || echo "  [ ] 2. Pub/Sub"
should_run "scheduler" 3 && echo "  [x] 3. Cloud Scheduler jobs (${ENV})" || echo "  [ ] 3. Scheduler"
if should_run "deploy" 4 && [ "$SKIP_DEPLOY" != "true" ] && [ "$ENV" != "local" ]; then
    for TARGET_ROW in "${DEPLOY_TARGETS[@]}"; do
        TARGET_NAME="${TARGET_ROW%%|*}"
        if [ -n "$ONLY" ] && is_deploy_target "$ONLY" && [ "$ONLY" != "$TARGET_NAME" ]; then
            echo "  [ ] 4. ${TARGET_NAME} deploy"
        else
            echo "  [x] 4. ${TARGET_NAME} deployed (${ENV})"
        fi
    done
else
    for TARGET_ROW in "${DEPLOY_TARGETS[@]}"; do
        echo "  [ ] 4. ${TARGET_ROW%%|*} deploy"
    done
fi
if [ "$ENV" != "local" ] && [ "$EDGAR_PUSH_SELECTED" == true ]; then
    echo "  [x] 5. EDGAR push subscriptions (${ENV})"
else
    echo "  [ ] 5. EDGAR push subscriptions"
fi
echo ""
# Not run by this script, and each is deliberately its own step.
# ONE LINE PER PROVISIONER, and the list is machine-checked — see the header.
# A Cloud Run JOB pins its image at provision time, so a script missing from
# here is a job an operator never re-pins after a workers deploy, running
# whatever it was created with, indefinitely, with nothing failing.
echo "Not covered by this script:"
echo "  - Cloud Build TRIGGERS      ./scripts/ops/setup-cloudbuild-triggers.sh ${ENV}"
echo "  - GCS bucket lifecycle      ./scripts/ops/setup-gcs-lifecycle.sh ${ENV}"
echo "                              (edgar/bulk/, edgar/filings/, databento/, feeds/TIINGO/ws/)"
echo "  - prod->QA mirror job       ./scripts/ops/setup-sync-job.sh          (no env arg)"
echo "  - Document AI processor     ./scripts/ops/setup-document-ai.sh ${ENV}"
echo "  - Vertex RAG corpus         ./scripts/ops/setup-vertex-rag.sh ${ENV}"
echo "  - StockSage 2.0             ./scripts/ops/setup-stocksage2.sh"
echo "  - market-data SA            ./scripts/ops/setup-market-data-sa.sh ${ENV}   (BEFORE its deploy)"
echo "  - market-data LB + CDN      ./scripts/ops/setup-market-data-lb.sh ${ENV}   (AFTER its deploy)"
echo "  - Datadog monitors          ./scripts/ops/datadog/apply-monitors.sh ${ENV}"
echo ""
echo "  Cloud Run JOBS — re-run after EVERY workers deploy (a job pins its image):"
echo "  - SEC EDGAR (5)             ./scripts/ops/setup-us-fundamentals-jobs.sh ${ENV}"
echo "  - Tiingo backfills (3)      ./scripts/ops/setup-tiingo-backfill-job.sh ${ENV}"
echo "  - Databento (3)             ./scripts/ops/setup-databento-jobs.sh ${ENV}"
echo "  - Lake (BigQuery)           ./scripts/ops/setup-lake.sh ${ENV}"
echo "  - Dataform (silver->gold)   ./scripts/ops/setup-dataform.sh ${ENV}"
echo "  - XBRL history              ./scripts/ops/setup-xbrl-backfill-job.sh ${ENV}"
echo "  - XBRL re-parse             ./scripts/ops/setup-xbrl-reparse-job.sh ${ENV}"
echo "  - XBRL projection drain     ./scripts/ops/setup-xbrl-projection-drain-job.sh ${ENV}"
echo "  - BSE backfill              ./scripts/ops/setup-bse-backfill-job.sh ${ENV}"
echo "  - doc-ingest backfill       ./scripts/ops/setup-doc-ingest-backfill-job.sh ${ENV}"
echo "  - feed backfill + parse     ./scripts/ops/setup-feed-backfill-job.sh ${ENV}"
echo "  - D1 tile builders (2)      ./scripts/ops/setup-tile-build-job.sh ${ENV}"
echo "  - embeddings v1 -> v2       ./scripts/ops/setup-embeddings-v2-job.sh ${ENV}"
echo "  - lake release, sink, loads ./scripts/ops/setup-lake-jobs.sh ${ENV}   (after setup-lake.sh)"
echo ""
