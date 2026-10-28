#!/usr/bin/env bash
# ============================================
# UseMoney - StockSage 2.0 one-shot provisioner (MONEY-779 … MONEY-797)
# ============================================
# A single idempotent orchestrator that provisions + enables EVERYTHING the
# StockSage 2.0 stack needs: Document AI (layout-aware PDF extraction), the
# Vertex AI RAG Engine corpus (optional retriever seam), the new Pub/Sub topics
# (investor-rollup + stock-document-extract), their Cloud Scheduler jobs, the
# new Prisma models (incl. corporate_actions / InvestorProfile / AIGenerationLog),
# and — optionally — a worker redeploy. It finishes by echoing the exact env
# block to set locally and on the Vercel web + worker runtimes.
#
# Modelled on:
#   - scripts/ops/setup-infra.sh        (qa/prod arg, --step/--from/--only,
#                                        step-runner structure, banners)
#   - scripts/ops/setup-vertex-rag.sh   (gcloud isolation via gc(), dry-run
#                                        default + --apply, SA-token handling,
#                                        never printing secrets/tokens)
#
# DRY-RUN by default — prints the plan. Pass --apply to mutate cloud + DB.
#
#   ./scripts/ops/setup-stocksage2.sh qa                       # show the plan
#   ./scripts/ops/setup-stocksage2.sh qa --apply               # provision everything
#   ./scripts/ops/setup-stocksage2.sh qa --apply --step 2      # only Document AI
#   ./scripts/ops/setup-stocksage2.sh qa --apply --from 4      # pubsub → end
#   ./scripts/ops/setup-stocksage2.sh qa --apply --only db     # only Prisma db push
#   ./scripts/ops/setup-stocksage2.sh qa --apply --deploy-workers   # also redeploy
#
# Steps (in order, each step-selectable):
#   1. apis        Enable documentai + aiplatform (+ pubsub/run/scheduler, idempotent)
#   2. documentai  bash scripts/ops/setup-document-ai.sh --apply   → DOCUMENT_AI_PROCESSOR_ID
#   3. vertexrag   bash scripts/ops/setup-vertex-rag.sh  --apply   → VERTEX_RAG_CORPUS
#   4. pubsub      bash workers/scripts/setup-pubsub.sh  <env>     (new topics + subs)
#   5. scheduler   bash scripts/ops/setup-scheduler.sh   <env>     (new daily jobs)
#   6. db          Prisma db push → <env> (new models incl. corporate_actions)
#   7. deploy      gcloud builds submit --config=workers/cloudbuild.<env>.yaml  (OFF by default)
#   8. env         Echo the final env block (VERTEX_RAG_* + DOCUMENT_AI_*)
#
# ── AUTH / ISOLATION (IMPORTANT) ─────────────────────────────────────────────
# Operator gcloud is pinned to an isolated `stockbook` config + founder account
# so this NEVER disturbs a second terminal whose GLOBAL active config points at
# a different GCP project. We NEVER run `gcloud config configurations activate`
# and NEVER use the `gcp-stockbook` alias:
#   CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook \
#     gcloud ... --account=founder@disdigital.in --project=stock-book-483718
# The stockbook config's own account (shaswat@orbizza.com) LACKS IAM — only
# founder@disdigital.in has access, so every gc() call pins --account explicitly.
#
# The Vertex RAG step (3) needs a SERVICE-ACCOUNT key (its corpus WRITE methods
# reject end-user tokens). If ./gcp-sa.json is absent but
# GCP_SERVICE_ACCOUNT_KEY_BASE64 is set (env or .env), we materialize a TEMP
# key under $TMPDIR, export VERTEX_RAG_SA_KEY to it, and delete it on exit
# (trap). The key is never committed and never printed.
#
# This is a DOCUMENTED script for the operator to run by hand. CI never runs it.
# ============================================

set -euo pipefail

# ── config ───────────────────────────────────────────────────────────────────
PROJECT_ID="${STOCKSAGE2_PROJECT:-stock-book-483718}"
ACCOUNT="${STOCKSAGE2_ACCOUNT:-founder@disdigital.in}"
GCLOUD_CONFIG="${CLOUDSDK_ACTIVE_CONFIG_NAME:-stockbook}"
RUN_REGION="${STOCKSAGE2_RUN_REGION:-asia-south1}"
VERTEX_RAG_LOCATION="${VERTEX_RAG_LOCATION:-us-central1}"
DOCUMENT_AI_LOCATION="${DOCUMENT_AI_LOCATION:-us}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Script lives at <repo>/scripts/ops/, so the repo root is two levels up.
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── argument parsing (mirrors setup-infra.sh) ─────────────────────────────────
ENV="${1:-}"
APPLY=0
DEPLOY_WORKERS=0
ONLY=""
STEP_FLAG=""   # "step" or "from"
STEP_VALUE=""

shift || true
while [ $# -gt 0 ]; do
    case "$1" in
        --apply)          APPLY=1; shift ;;
        --deploy-workers) DEPLOY_WORKERS=1; shift ;;
        --only)           ONLY="$2"; shift 2 ;;
        --step)           STEP_FLAG="step"; STEP_VALUE="$2"; shift 2 ;;
        --from)           STEP_FLAG="from"; STEP_VALUE="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

if [ "$ENV" != "qa" ] && [ "$ENV" != "prod" ]; then
    cat >&2 <<'USAGE'
Usage: ./scripts/ops/setup-stocksage2.sh [qa|prod] [options]

Provisions everything for StockSage 2.0. DRY-RUN by default — pass --apply to mutate.

Options:
  --apply             Actually mutate cloud + DB (default: dry-run, prints plan)
  --deploy-workers    Also run step 7 (worker redeploy via Cloud Build); OFF by default
  --only <name>       Run only one step by name:
                      apis | documentai | vertexrag | pubsub | scheduler | db | deploy | env
  --step <N>          Run only step N (1=apis 2=documentai 3=vertexrag 4=pubsub
                      5=scheduler 6=db 7=deploy 8=env)
  --from <N>          Run from step N onwards

Steps (in order):
  1. apis        Enable documentai.googleapis.com + aiplatform.googleapis.com
                 (+ pubsub/run/cloudscheduler — harmless + idempotent)
  2. documentai  Provision the Document AI OCR processor  → DOCUMENT_AI_PROCESSOR_ID
  3. vertexrag   Provision the Vertex AI RAG Engine corpus → VERTEX_RAG_CORPUS
  4. pubsub      Pub/Sub topics + subscriptions (investor-rollup, stock-document-extract)
  5. scheduler   Cloud Scheduler jobs (investor-rollup-daily, stock-document-extract-daily)
  6. db          Prisma db push (new models incl. corporate_actions)
  7. deploy      Worker redeploy (Cloud Build → Cloud Run); only with --deploy-workers
  8. env         Echo the final env block to set locally + on Vercel/worker runtime
USAGE
    exit 1
fi

# Map step numbers → names (index 0 unused so step N == STEP_NAMES[N]).
STEP_NAMES=("" "apis" "documentai" "vertexrag" "pubsub" "scheduler" "db" "deploy" "env")

# ── step selection (mirrors setup-infra.sh::should_run) ───────────────────────
should_run() {
    local step_name="$1" step_num="$2"
    if [ -n "$ONLY" ]; then
        [ "$ONLY" == "$step_name" ] && return 0 || return 1
    fi
    if [ "$STEP_FLAG" == "step" ]; then
        [ "$step_num" == "$STEP_VALUE" ] && return 0 || return 1
    fi
    if [ "$STEP_FLAG" == "from" ]; then
        [ "$step_num" -ge "$STEP_VALUE" ] && return 0 || return 1
    fi
    return 0
}

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Operator gcloud, pinned to the isolated `stockbook` config + founder account.
# NEVER `gcloud config configurations activate`; NEVER the `gcp-stockbook` alias.
gc() {
    CLOUDSDK_ACTIVE_CONFIG_NAME="$GCLOUD_CONFIG" \
        gcloud "$@" --account="$ACCOUNT" --project="$PROJECT_ID"
}

MODE="full setup"
if [ -n "$ONLY" ]; then
    MODE="only ${ONLY}"
elif [ "$STEP_FLAG" == "step" ]; then
    MODE="step ${STEP_VALUE} (${STEP_NAMES[$STEP_VALUE]:-?})"
elif [ "$STEP_FLAG" == "from" ]; then
    MODE="from step ${STEP_VALUE} (${STEP_NAMES[$STEP_VALUE]:-?}) onwards"
fi

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  UseMoney StockSage 2.0 Provisioner        ║"
echo "╠════════════════════════════════════════════╣"
echo "║  Environment   : ${ENV}"
echo "║  Project       : ${PROJECT_ID}"
echo "║  Run region    : ${RUN_REGION}"
echo "║  Vertex region : ${VERTEX_RAG_LOCATION}"
echo "║  DocAI region  : ${DOCUMENT_AI_LOCATION}"
echo "║  Mode          : ${MODE}"
echo "║  Apply         : $([ "$APPLY" -eq 1 ] && echo APPLY || echo 'dry-run (pass --apply to mutate)')"
echo "║  Deploy workers: $([ "$DEPLOY_WORKERS" -eq 1 ] && echo yes || echo 'no (pass --deploy-workers)')"
echo "╚════════════════════════════════════════════╝"
echo ""

# These carry the generated ids from steps 2 & 3 down to the step-8 echo.
DOCUMENT_AI_PROCESSOR_ID=""
VERTEX_RAG_CORPUS=""

# ── Vertex RAG SA-key preflight + auto-cleanup trap ──────────────────────────
# setup-vertex-rag.sh mints an aiplatform token from VERTEX_RAG_SA_KEY (default
# ./gcp-sa.json). If that file is absent but GCP_SERVICE_ACCOUNT_KEY_BASE64 is
# available, materialize a throwaway key under $TMPDIR and clean it up on exit.
TMP_SA_KEY=""
cleanup() {
    if [ -n "$TMP_SA_KEY" ] && [ -f "$TMP_SA_KEY" ]; then
        rm -f "$TMP_SA_KEY"
    fi
}
trap cleanup EXIT INT TERM

prepare_vertex_sa_key() {
    # Already have an explicit key on disk → nothing to do.
    if [ -f "${VERTEX_RAG_SA_KEY:-${ROOT_DIR}/gcp-sa.json}" ]; then
        return 0
    fi
    # Pull GCP_SERVICE_ACCOUNT_KEY_BASE64 from .env if not already exported.
    if [ -z "${GCP_SERVICE_ACCOUNT_KEY_BASE64:-}" ] && [ -f "${ROOT_DIR}/.env" ]; then
        local from_env
        from_env="$(grep -E '^GCP_SERVICE_ACCOUNT_KEY_BASE64=' "${ROOT_DIR}/.env" | tail -1 | cut -d= -f2- || true)"
        # Strip optional surrounding quotes.
        from_env="${from_env%\"}"; from_env="${from_env#\"}"
        from_env="${from_env%\'}"; from_env="${from_env#\'}"
        [ -n "$from_env" ] && export GCP_SERVICE_ACCOUNT_KEY_BASE64="$from_env"
    fi
    if [ -z "${GCP_SERVICE_ACCOUNT_KEY_BASE64:-}" ]; then
        echo -e "   ${YELLOW}No ./gcp-sa.json and no GCP_SERVICE_ACCOUNT_KEY_BASE64 — step 3 may fail to mint an SA token.${NC}" >&2
        echo -e "   ${YELLOW}Set VERTEX_RAG_SA_KEY=/path/to/sa-key.json or export GCP_SERVICE_ACCOUNT_KEY_BASE64.${NC}" >&2
        return 0
    fi
    TMP_SA_KEY="$(mktemp "${TMPDIR:-/tmp}/stocksage2-sa.XXXXXX.json")"
    # Decode WITHOUT echoing contents; chmod 600 before VERTEX_RAG_SA_KEY points at it.
    if ! printf '%s' "$GCP_SERVICE_ACCOUNT_KEY_BASE64" | base64 -d > "$TMP_SA_KEY" 2>/dev/null; then
        rm -f "$TMP_SA_KEY"; TMP_SA_KEY=""
        echo -e "   ${RED}Failed to base64-decode GCP_SERVICE_ACCOUNT_KEY_BASE64.${NC}" >&2
        return 0
    fi
    chmod 600 "$TMP_SA_KEY"
    export VERTEX_RAG_SA_KEY="$TMP_SA_KEY"
    echo -e "   Materialized a temp SA key for Vertex RAG (path hidden; auto-deleted on exit)."
}

# ============================================
# Step 1: Enable APIs
# ============================================
if should_run "apis" 1; then
    echo -e "${BLUE}━━━ Step 1/8: Enable APIs ━━━${NC}"
    SS2_APIS=(
        documentai.googleapis.com
        aiplatform.googleapis.com
        pubsub.googleapis.com
        run.googleapis.com
        cloudscheduler.googleapis.com
    )
    echo "   Will enable: ${SS2_APIS[*]}"
    if [ "$APPLY" -eq 1 ]; then
        gc services enable "${SS2_APIS[@]}"
        echo -e "   ${GREEN}APIs enabled${NC}"
    else
        echo "   [dry-run] gc services enable ${SS2_APIS[*]}"
    fi
    echo ""
else
    echo -e "${YELLOW}━━━ Step 1/8: Enable APIs (SKIPPED) ━━━${NC}"
fi

# ============================================
# Step 2: Document AI processor  → DOCUMENT_AI_PROCESSOR_ID
# ============================================
# Delegates to setup-document-ai.sh, which creates the OCR processor and prints
# a `DOCUMENT_AI_PROCESSOR_ID=<id>` line on stdout. We tee its output so the
# operator sees the full log AND we can grep the id out to thread to step 8.
if should_run "documentai" 2; then
    echo -e "${BLUE}━━━ Step 2/8: Document AI processor ━━━${NC}"
    echo "   Will run: bash scripts/ops/setup-document-ai.sh ${ENV} $([ "$APPLY" -eq 1 ] && echo --apply || echo '(dry-run)')"
    if [ "$APPLY" -eq 1 ]; then
        cd "$ROOT_DIR"
        # Capture-then-print (NOT `| tee /dev/tty` — /dev/tty is absent in
        # non-interactive / piped execution and aborts under pipefail).
        DOCAI_OUT="$(bash scripts/ops/setup-document-ai.sh "$ENV" --apply)"
        printf '%s\n' "$DOCAI_OUT"
        # Capture the id the helper printed (DOCUMENT_AI_PROCESSOR_ID=<id>).
        DOCUMENT_AI_PROCESSOR_ID="$(printf '%s\n' "$DOCAI_OUT" \
            | grep -Eo 'DOCUMENT_AI_PROCESSOR_ID=[A-Za-z0-9_-]+' | tail -1 | cut -d= -f2- || true)"
        if [ -z "$DOCUMENT_AI_PROCESSOR_ID" ]; then
            echo -e "   ${RED}ERROR: setup-document-ai.sh did not emit a DOCUMENT_AI_PROCESSOR_ID.${NC}" >&2
            echo -e "   ${RED}Cannot thread the processor id to the final env block — aborting.${NC}" >&2
            exit 1
        fi
        echo -e "   ${GREEN}Captured DOCUMENT_AI_PROCESSOR_ID${NC} (hidden until step 8 echo)"
    else
        echo "   [dry-run] bash scripts/ops/setup-document-ai.sh ${ENV} --apply  (would emit DOCUMENT_AI_PROCESSOR_ID)"
        DOCUMENT_AI_PROCESSOR_ID="<dry-run-not-resolved>"
    fi
    echo ""
else
    echo -e "${YELLOW}━━━ Step 2/8: Document AI processor (SKIPPED) ━━━${NC}"
fi

# ============================================
# Step 3: Vertex RAG corpus  → VERTEX_RAG_CORPUS
# ============================================
# Delegates to setup-vertex-rag.sh, which prints `VERTEX_RAG_CORPUS=<name>` in
# its final echo block. Same tee+grep capture as step 2.
if should_run "vertexrag" 3; then
    echo -e "${BLUE}━━━ Step 3/8: Vertex AI RAG Engine corpus ━━━${NC}"
    if [ "$APPLY" -eq 1 ]; then
        prepare_vertex_sa_key
        cd "$ROOT_DIR"
        echo "   Will run: bash scripts/ops/setup-vertex-rag.sh ${ENV} --apply"
        # Capture-then-print (see step 2 note — avoid /dev/tty under pipefail).
        RAG_OUT="$(bash scripts/ops/setup-vertex-rag.sh "$ENV" --apply)"
        printf '%s\n' "$RAG_OUT"
        VERTEX_RAG_CORPUS="$(printf '%s\n' "$RAG_OUT" \
            | grep -Eo 'VERTEX_RAG_CORPUS=[^[:space:]]+' | tail -1 | cut -d= -f2- || true)"
        # The helper prints an empty value if the create LRO hasn't settled yet.
        # NON-FATAL by design: the Vertex corpus is OPTIONAL — Atlas $vectorSearch
        # is the primary, authoritative RAG (it holds the Document-AI-extracted,
        # per-docType smart chunks). With VERTEX_RAG_CORPUS empty the retriever
        # safely falls back to Atlas (vertexRagConfigured() is false). So a corpus
        # that didn't resolve must NOT block the rest of the setup (pubsub /
        # scheduler / db push / env). Warn and continue.
        # setup-vertex-rag.sh echoes `VERTEX_RAG_CORPUS=` (empty) when the corpus
        # LRO hasn't settled — the "<not ready…>" placeholder lives only on its
        # separate "Resolved corpus:" log line, never on the VERTEX_RAG_CORPUS=
        # line we grep, so an empty check is sufficient here (MONEY-807).
        if [ -z "$VERTEX_RAG_CORPUS" ]; then
            VERTEX_RAG_CORPUS=""
            echo -e "   ${YELLOW}WARN: no VERTEX_RAG_CORPUS resolved — leaving it empty (retriever stays on Atlas, the primary).${NC}" >&2
            echo -e "   ${YELLOW}Provision/ingest Vertex deliberately later (see docs/reference/stocksage2-setup.md — extracted text, NOT raw PDFs).${NC}" >&2
        else
            echo -e "   ${GREEN}Captured VERTEX_RAG_CORPUS${NC} (hidden until step 8 echo)"
        fi
    else
        echo "   [dry-run] bash scripts/ops/setup-vertex-rag.sh ${ENV} --apply  (would emit VERTEX_RAG_CORPUS)"
        VERTEX_RAG_CORPUS="projects/${PROJECT_ID}/locations/${VERTEX_RAG_LOCATION}/ragCorpora/<dry-run-not-resolved>"
    fi
    echo ""
else
    echo -e "${YELLOW}━━━ Step 3/8: Vertex AI RAG Engine corpus (SKIPPED) ━━━${NC}"
fi

# ============================================
# Step 4: Pub/Sub topics + subscriptions
# ============================================
# Ensures the new investor-rollup + stock-document-extract topics (and their
# worker push subscriptions) exist. Idempotent — skips existing.
if should_run "pubsub" 4; then
    echo -e "${BLUE}━━━ Step 4/8: Pub/Sub topics + subscriptions ━━━${NC}"
    echo "   Will run: bash workers/scripts/setup-pubsub.sh ${ENV}"
    echo "   (ensures investor-rollup-${ENV} + stock-document-extract-${ENV} topics + subs)"
    if [ "$APPLY" -eq 1 ]; then
        cd "$ROOT_DIR"
        bash workers/scripts/setup-pubsub.sh "$ENV"
        echo -e "   ${GREEN}Pub/Sub complete${NC}"
    else
        echo "   [dry-run] bash workers/scripts/setup-pubsub.sh ${ENV}"
    fi
    echo ""
else
    echo -e "${YELLOW}━━━ Step 4/8: Pub/Sub topics + subscriptions (SKIPPED) ━━━${NC}"
fi

# ============================================
# Step 5: Cloud Scheduler jobs
# ============================================
# Upserts the new daily jobs: investor-rollup-daily, stock-document-extract-daily.
if should_run "scheduler" 5; then
    echo -e "${BLUE}━━━ Step 5/8: Cloud Scheduler jobs ━━━${NC}"
    echo "   Will run: bash scripts/ops/setup-scheduler.sh ${ENV}"
    echo "   (upserts investor-rollup-daily + stock-document-extract-daily)"
    if [ "$APPLY" -eq 1 ]; then
        cd "$ROOT_DIR"
        bash scripts/ops/setup-scheduler.sh "$ENV"
        echo -e "   ${GREEN}Scheduler complete${NC}"
    else
        echo "   [dry-run] bash scripts/ops/setup-scheduler.sh ${ENV}"
    fi
    echo ""
else
    echo -e "${YELLOW}━━━ Step 5/8: Cloud Scheduler jobs (SKIPPED) ━━━${NC}"
fi

# ============================================
# Step 6: Prisma db push to <env>
# ============================================
# Mirrors setup-infra.sh / seed-env.sh EXACTLY: fetch DATABASE_URL_<ENV> from
# GCP Secret Manager (via the isolated gc() wrapper) and run the database
# workspace's prisma db push. Pushes the new StockSage 2.0 models — including
# corporate_actions, InvestorProfile, AIGenerationLog.
if should_run "db" 6; then
    echo -e "${BLUE}━━━ Step 6/8: Prisma db push (${ENV}) ━━━${NC}"
    if [ "$ENV" == "qa" ]; then
        SECRET_NAME="DATABASE_URL_QA"
    else
        SECRET_NAME="DATABASE_URL_PROD"
    fi
    echo "   Will fetch ${SECRET_NAME} from Secret Manager, then:"
    echo "   DATABASE_URL=<${SECRET_NAME}> yarn workspace @usemoney/database prisma db push --skip-generate"
    if [ "$APPLY" -eq 1 ]; then
        if [ "$ENV" == "prod" ]; then
            echo -e "   ${RED}WARNING: this pushes schema to the PRODUCTION database.${NC}"
            read -r -p "   Are you sure? (yes/no): " CONFIRM
            if [ "$CONFIRM" != "yes" ]; then
                echo -e "   ${YELLOW}Skipping prod db push.${NC}"
            else
                APPLY_DB=1
            fi
        else
            APPLY_DB=1
        fi
        if [ "${APPLY_DB:-0}" -eq 1 ]; then
            echo -e "   Fetching ${SECRET_NAME} from Secret Manager..." >&2
            DB_URL="$(gc secrets versions access latest --secret="$SECRET_NAME" 2>/dev/null)"
            if [ -z "$DB_URL" ]; then
                echo -e "   ${RED}ERROR: failed to fetch ${SECRET_NAME} from Secret Manager.${NC}" >&2
                echo -e "   Make sure ${SECRET_NAME} exists in project ${PROJECT_ID}." >&2
                exit 1
            fi
            echo -e "   Pushing schema to ${ENV} database..."
            cd "$ROOT_DIR"
            DATABASE_URL="$DB_URL" yarn workspace @usemoney/database prisma db push --skip-generate
            echo -e "   ${GREEN}Schema pushed${NC}"
        fi
    else
        echo "   [dry-run] gc secrets versions access latest --secret=${SECRET_NAME}"
        echo "   [dry-run] DATABASE_URL=<redacted> yarn workspace @usemoney/database prisma db push --skip-generate"
    fi
    echo ""
else
    echo -e "${YELLOW}━━━ Step 6/8: Prisma db push (SKIPPED) ━━━${NC}"
fi

# ============================================
# Step 7: Worker redeploy (OFF by default, behind --deploy-workers)
# ============================================
if should_run "deploy" 7 && [ "$DEPLOY_WORKERS" -eq 1 ]; then
    echo -e "${BLUE}━━━ Step 7/8: Worker redeploy (Cloud Build) ━━━${NC}"
    if [ "$ENV" == "qa" ]; then
        CLOUDBUILD_FILE="workers/cloudbuild.qa.yaml"
    else
        CLOUDBUILD_FILE="workers/cloudbuild.prod.yaml"
    fi
    echo "   Will run: gc builds submit --config=${CLOUDBUILD_FILE} ."
    if [ "$APPLY" -eq 1 ]; then
        cd "$ROOT_DIR"
        gc builds submit --config="$CLOUDBUILD_FILE" .
        echo -e "   ${GREEN}Deploy complete${NC}"
    else
        echo "   [dry-run] gc builds submit --config=${CLOUDBUILD_FILE} ."
    fi
    echo ""
else
    echo -e "${YELLOW}━━━ Step 7/8: Worker redeploy (SKIPPED — pass --deploy-workers) ━━━${NC}"
fi

# ============================================
# Step 8: Echo the final env block
# ============================================
# Threads the ids captured in steps 2 & 3. If we ran those steps under --apply
# but an id failed to resolve, fail loudly (don't print a broken block).
if should_run "env" 8; then
    echo -e "${BLUE}━━━ Step 8/8: Final env block ━━━${NC}"

    if [ "$APPLY" -eq 1 ]; then
        if should_run "documentai" 2 && { [ -z "$DOCUMENT_AI_PROCESSOR_ID" ] || [ "$DOCUMENT_AI_PROCESSOR_ID" = "<dry-run-not-resolved>" ]; }; then
            echo -e "   ${RED}ERROR: DOCUMENT_AI_PROCESSOR_ID never resolved — cannot emit env block.${NC}" >&2
            exit 1
        fi
        # VERTEX_RAG_CORPUS is OPTIONAL — empty means the retriever uses Atlas
        # (the primary). Only blank a dry-run placeholder; NEVER abort on empty.
        if [[ "$VERTEX_RAG_CORPUS" == *"<dry-run-not-resolved>"* ]]; then
            VERTEX_RAG_CORPUS=""
        fi
    fi

    echo ""
    echo "   Set these locally (.env) AND on the Vercel web + the worker runtime:"
    echo ""
    echo "   # ── StockSage 2.0 retriever seam (Vertex RAG) ──"
    echo "   VERTEX_RAG_ENABLED=true"
    echo "   VERTEX_RAG_LOCATION=${VERTEX_RAG_LOCATION}"
    echo "   VERTEX_RAG_CORPUS=${VERTEX_RAG_CORPUS}"
    if [ -z "$VERTEX_RAG_CORPUS" ]; then
        echo "   #   ^ empty on purpose — retriever stays on Atlas (the primary RAG)."
        echo "   #     Provision/ingest Vertex deliberately later (extracted text, NOT raw PDFs)."
    fi
    echo ""
    echo "   # ── StockSage 2.0 layout-aware PDF extraction (Document AI) ──"
    echo "   DOCUMENT_AI_PROCESSOR_ID=${DOCUMENT_AI_PROCESSOR_ID:-<run step 2 with --apply to resolve>}"
    echo "   DOCUMENT_AI_LOCATION=${DOCUMENT_AI_LOCATION}"
    echo ""
    echo "   (Atlas RAG + pdf-parse stay the defaults until VERTEX_RAG_ENABLED=true"
    echo "    AND VERTEX_RAG_CORPUS / DOCUMENT_AI_PROCESSOR_ID are set on the runtime.)"
    echo ""
else
    echo -e "${YELLOW}━━━ Step 8/8: Final env block (SKIPPED) ━━━${NC}"
fi

# ============================================
# Done
# ============================================
echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  StockSage 2.0 provisioning complete!      ║"
echo "╚════════════════════════════════════════════╝"
echo ""
echo "What ran ($([ "$APPLY" -eq 1 ] && echo APPLY || echo dry-run)):"
should_run "apis"       1 && echo "  [x] 1. Enable APIs"                       || echo "  [ ] 1. Enable APIs"
should_run "documentai" 2 && echo "  [x] 2. Document AI processor"             || echo "  [ ] 2. Document AI processor"
should_run "vertexrag"  3 && echo "  [x] 3. Vertex RAG corpus"                 || echo "  [ ] 3. Vertex RAG corpus"
should_run "pubsub"     4 && echo "  [x] 4. Pub/Sub topics + subscriptions"    || echo "  [ ] 4. Pub/Sub"
should_run "scheduler"  5 && echo "  [x] 5. Cloud Scheduler jobs"              || echo "  [ ] 5. Scheduler"
should_run "db"         6 && echo "  [x] 6. Prisma db push (${ENV})"           || echo "  [ ] 6. Prisma db push"
if should_run "deploy" 7 && [ "$DEPLOY_WORKERS" -eq 1 ]; then
    echo "  [x] 7. Worker redeploy (${ENV})"
else
    echo "  [ ] 7. Worker redeploy"
fi
should_run "env"        8 && echo "  [x] 8. Final env block"                   || echo "  [ ] 8. Final env block"
echo ""
