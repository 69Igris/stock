#!/bin/bash
# ============================================
# UseMoney - 3-Tier Analysis Engine Production Update
# ============================================
#
# Usage:
#   ./scripts/ops/update-prod-analysis-engine.sh qa              # All steps on QA
#   ./scripts/ops/update-prod-analysis-engine.sh prod             # All steps on Prod
#   ./scripts/ops/update-prod-analysis-engine.sh qa --step 2      # Only step 2 on QA
#   ./scripts/ops/update-prod-analysis-engine.sh qa --from 4      # Steps 4-6 on QA
#   ./scripts/ops/update-prod-analysis-engine.sh status           # Check infra status
#
# Steps:
#   1. Prisma schema push (new models + fields)
#   2. Pub/Sub topics + subscriptions (3 new)
#   3. Cloud Scheduler jobs (credit cleanup)
#   4. Cloud Run deploy (2 new worker routes)
#   5. Set comprehensive credits on subscriptions
#   6. Verify health
# ============================================

set -e

# Deploy-verification verdict — MONEY-1238. `set -e` aborts on a hard failure,
# but a deploy that BUILDS fine and then serves 503 is not a shell failure: the
# health check printed "✗ Workers unhealthy" and the very next line printed a
# green "Done!", exit 0. After ~300 lines of build output the red line has
# scrolled away, so a crash-looping revision read as a successful deploy. The
# flag is consulted at the very end so the summary and its manual-steps list
# still print — the operator gets the information AND a non-zero status.
VERIFY_FAILED=0

TARGET=${1:-""}
STEP_FLAG=${2:-""}
STEP_VALUE=${3:-""}
PROJECT_ID="stock-book-483718"
REGION="asia-south1"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

ENV_UPPER() { echo "$1" | tr '[:lower:]' '[:upper:]'; }

# ── Parse arguments ─────────────────────────────────────────────────
STEP_ONLY=""
STEP_FROM=""

if [ "$STEP_FLAG" = "--step" ] && [ -n "$STEP_VALUE" ]; then
    STEP_ONLY="$STEP_VALUE"
elif [ "$STEP_FLAG" = "--from" ] && [ -n "$STEP_VALUE" ]; then
    STEP_FROM="$STEP_VALUE"
fi

should_run_step() {
    local step=$1
    if [ -n "$STEP_ONLY" ]; then
        [ "$step" = "$STEP_ONLY" ]
    elif [ -n "$STEP_FROM" ]; then
        [ "$step" -ge "$STEP_FROM" ]
    else
        true
    fi
}

# ── Usage ───────────────────────────────────────────────────────────
if [ "$TARGET" != "qa" ] && [ "$TARGET" != "prod" ] && [ "$TARGET" != "status" ]; then
    echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║  3-Tier Analysis Engine - Production Update Script          ║${NC}"
    echo -e "${CYAN}╠══════════════════════════════════════════════════════════════╣${NC}"
    echo -e "${CYAN}║                                                              ║${NC}"
    echo -e "${CYAN}║  Usage:                                                      ║${NC}"
    echo -e "${CYAN}║    $0 qa                  # All steps     ║${NC}"
    echo -e "${CYAN}║    $0 prod                # All steps     ║${NC}"
    echo -e "${CYAN}║    $0 qa --step 2         # Only step 2   ║${NC}"
    echo -e "${CYAN}║    $0 qa --from 4         # Steps 4-6     ║${NC}"
    echo -e "${CYAN}║    $0 status              # Check status  ║${NC}"
    echo -e "${CYAN}║                                                              ║${NC}"
    echo -e "${CYAN}║  Steps:                                                      ║${NC}"
    echo -e "${CYAN}║    1. Prisma schema push (new models + fields)               ║${NC}"
    echo -e "${CYAN}║    2. Pub/Sub topics + subscriptions (3 new)                 ║${NC}"
    echo -e "${CYAN}║    3. Cloud Scheduler jobs (credit cleanup)                  ║${NC}"
    echo -e "${CYAN}║    4. Cloud Run deploy (2 new worker routes)                 ║${NC}"
    echo -e "${CYAN}║    5. Set comprehensive credits on subscriptions             ║${NC}"
    echo -e "${CYAN}║    6. Verify health                                          ║${NC}"
    echo -e "${CYAN}║                                                              ║${NC}"
    echo -e "${CYAN}║  Manual steps (not automated):                               ║${NC}"
    echo -e "${CYAN}║    - Clerk: add session.created webhook event                ║${NC}"
    echo -e "${CYAN}║    - Vercel: merges to main auto-deploy                      ║${NC}"
    echo -e "${CYAN}║    - Gemini: request quota increase via GCP console          ║${NC}"
    echo -e "${CYAN}║                                                              ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
    exit 1
fi

# ── Helper: get DATABASE_URL from Secret Manager ────────────────────
get_db_url() {
    local secret_name="DATABASE_URL_$(ENV_UPPER "$1")"
    echo "   Fetching ${secret_name} from Secret Manager..." >&2
    gcloud secrets versions access latest \
        --secret="${secret_name}" \
        --project="$PROJECT_ID" 2>/dev/null
}

# ── Status check ────────────────────────────────────────────────────
if [ "$TARGET" = "status" ]; then
    echo -e "${BLUE}Checking infrastructure status...${NC}"
    echo ""

    echo -e "${YELLOW}Pub/Sub Topics:${NC}"
    # MONEY-1205 - proactive-analysis dropped: the topic was declared and
    # created but had no publisher, no route and no processor.
    for topic in l3-analysis login-briefing; do
        for env in qa prod; do
            if gcloud pubsub topics describe "${topic}-${env}" --project="$PROJECT_ID" &>/dev/null; then
                echo -e "  ${GREEN}✓${NC} ${topic}-${env}"
            else
                echo -e "  ${RED}✗${NC} ${topic}-${env} (missing)"
            fi
        done
    done

    echo ""
    echo -e "${YELLOW}Cloud Scheduler:${NC}"
    for env in qa prod; do
        if gcloud scheduler jobs describe "credit-reservation-cleanup-${env}" --location="$REGION" --project="$PROJECT_ID" &>/dev/null 2>&1; then
            echo -e "  ${GREEN}✓${NC} credit-reservation-cleanup-${env}"
        else
            echo -e "  ${RED}✗${NC} credit-reservation-cleanup-${env} (missing)"
        fi
    done

    echo ""
    echo -e "${YELLOW}Cloud Run Services:${NC}"
    for env in qa prod; do
        svc_url=$(gcloud run services describe "stockbook-workers-${env}" \
            --region="$REGION" --project="$PROJECT_ID" \
            --format="value(status.url)" 2>/dev/null)
        if [ -n "$svc_url" ]; then
            health=$(curl -s -o /dev/null -w "%{http_code}" "${svc_url}/health" 2>/dev/null || echo "000")
            if [ "$health" = "200" ]; then
                echo -e "  ${GREEN}✓${NC} stockbook-workers-${env} (healthy)"
            else
                echo -e "  ${YELLOW}!${NC} stockbook-workers-${env} (HTTP ${health})"
            fi
        else
            echo -e "  ${RED}✗${NC} stockbook-workers-${env} (not found)"
        fi
    done

    echo ""
    echo -e "${YELLOW}Database collections (QA):${NC}"
    QA_URL=$(get_db_url "qa" 2>/dev/null)
    if [ -n "$QA_URL" ] && command -v mongosh &>/dev/null; then
        mongosh "$QA_URL" --quiet --eval '
            ["analysis_sessions","credit_reservations","login_briefings"].forEach(c => {
                const count = db.getCollection(c).countDocuments();
                print("  " + (count >= 0 ? "✓" : "✗") + " " + c + " (" + count + " docs)");
            });
        ' 2>/dev/null || echo "  (could not connect)"
    else
        echo "  (mongosh not available or no QA URL)"
    fi

    echo ""
    exit 0
fi

# ── Production confirmation ─────────────────────────────────────────
if [ "$TARGET" = "prod" ]; then
    echo -e "${RED}╔═══════════════════════════════════════╗${NC}"
    echo -e "${RED}║  WARNING: PRODUCTION DEPLOYMENT       ║${NC}"
    echo -e "${RED}║  This will modify production infra.   ║${NC}"
    echo -e "${RED}╚═══════════════════════════════════════╝${NC}"
    echo ""
    read -p "Have you validated on QA first? (yes/no): " confirm
    if [ "$confirm" != "yes" ]; then
        echo -e "${RED}Aborting. Run on QA first.${NC}"
        exit 1
    fi
fi

ENV="$TARGET"
ENV_UP=$(ENV_UPPER "$ENV")

echo ""
echo -e "${BLUE}═══════════════════════════════════════════${NC}"
if [ -n "$STEP_ONLY" ]; then
    echo -e "${BLUE}  Running step ${STEP_ONLY} on ${ENV_UP}${NC}"
elif [ -n "$STEP_FROM" ]; then
    echo -e "${BLUE}  Running steps ${STEP_FROM}-6 on ${ENV_UP}${NC}"
else
    echo -e "${BLUE}  Deploying 3-Tier Analysis Engine to ${ENV_UP}${NC}"
fi
echo -e "${BLUE}═══════════════════════════════════════════${NC}"
echo ""

# Fetch DB URL once (used by steps 1 and 5)
DB_URL=""
if should_run_step 1 || should_run_step 5; then
    DB_URL=$(get_db_url "$ENV")
    if [ -z "$DB_URL" ]; then
        echo -e "${RED}  ✗ Failed to get DATABASE_URL for ${ENV}${NC}"
        echo "    Make sure DATABASE_URL_${ENV_UP} exists in Secret Manager:"
        echo "    gcloud secrets list --project=$PROJECT_ID | grep DATABASE_URL"
        exit 1
    fi
fi

# ── Step 1: Prisma Schema Push ──────────────────────────────────────
if should_run_step 1; then
    echo -e "${YELLOW}Step 1/6: Pushing Prisma schema to ${ENV_UP} database...${NC}"
    echo "   (Using DATABASE_URL from GCP Secret Manager - not local .env)"

    DATABASE_URL="$DB_URL" npx prisma db push \
        --schema=packages/database/prisma/schema.prisma \
        --skip-generate

    echo -e "${GREEN}  ✓ Schema pushed to ${ENV_UP}${NC}"
    echo ""
fi

# ── Step 2: Pub/Sub Topics ──────────────────────────────────────────
if should_run_step 2; then
    echo -e "${YELLOW}Step 2/6: Creating Pub/Sub topics & subscriptions...${NC}"
    ./workers/scripts/setup-pubsub.sh "$ENV"
    echo -e "${GREEN}  ✓ Pub/Sub configured${NC}"
    echo ""
fi

# ── Step 3: Cloud Scheduler ─────────────────────────────────────────
if should_run_step 3; then
    echo -e "${YELLOW}Step 3/6: Setting up Cloud Scheduler...${NC}"
    ./scripts/ops/setup-scheduler.sh "$ENV"
    echo -e "${GREEN}  ✓ Scheduler configured${NC}"
    echo ""
fi

# ── Step 4: Deploy Workers ──────────────────────────────────────────
if should_run_step 4; then
    echo -e "${YELLOW}Step 4/6: Building and deploying workers...${NC}"

    COMMIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "manual")

    # `|| BUILD_RC=$?` rather than a bare call — MONEY-1238. Under `set -e` a
    # bare failing command aborts the script immediately, which made the
    # `if [ $? -ne 0 ]` below UNREACHABLE: $? was always 0 by the time it ran,
    # so the operator lost the "check gcloud builds list" pointer and got a
    # bare non-zero exit instead. Capturing the code makes the diagnostic
    # reachable without swallowing the failure — the `exit 1` still fires.
    BUILD_RC=0
    if [ "$ENV" = "prod" ]; then
        gcloud builds submit \
            --config=workers/cloudbuild.prod.yaml \
            --project="$PROJECT_ID" || BUILD_RC=$?
    else
        gcloud builds submit \
            --config=workers/cloudbuild.yaml \
            --project="$PROJECT_ID" \
            --substitutions="_ENV=${ENV},_SERVICE_NAME=stockbook-workers-${ENV},COMMIT_SHA=${COMMIT_SHA}" || BUILD_RC=$?
    fi

    if [ "$BUILD_RC" -ne 0 ]; then
        echo -e "${RED}  ✗ Workers build/deploy FAILED${NC}"
        echo "    Check: gcloud builds list --project=$PROJECT_ID --limit=1"
        exit 1
    fi

    echo -e "${GREEN}  ✓ Workers deployed${NC}"
    echo ""

    # Re-run Pub/Sub to update push endpoints
    echo -e "${YELLOW}Step 4b: Updating Pub/Sub endpoints after deploy...${NC}"
    ./workers/scripts/setup-pubsub.sh "$ENV"
    echo -e "${GREEN}  ✓ Endpoints updated${NC}"
    echo ""
fi

# ── Step 5: Set Comprehensive Credits ───────────────────────────────
if should_run_step 5; then
    echo -e "${YELLOW}Step 5/6: Setting comprehensive credits on subscriptions...${NC}"

    if command -v mongosh &>/dev/null; then
        mongosh "$DB_URL" --quiet --eval '
            db.subscriptions.updateMany(
                { planId: "PRO", comprehensiveCreditsLimit: { $in: [null, 0] } },
                { $set: { comprehensiveCreditsLimit: 2, comprehensiveCreditsUsed: 0 } }
            );
            db.subscriptions.updateMany(
                { planId: "PREMIUM", comprehensiveCreditsLimit: { $in: [null, 0] } },
                { $set: { comprehensiveCreditsLimit: 10, comprehensiveCreditsUsed: 0 } }
            );
            db.subscriptions.updateMany(
                { planId: "ULTIMATE", comprehensiveCreditsLimit: { $in: [null, 0] } },
                { $set: { comprehensiveCreditsLimit: 20, comprehensiveCreditsUsed: 0 } }
            );
            print("Credits configured:");
            print("  PRO: " + db.subscriptions.countDocuments({ planId: "PRO", comprehensiveCreditsLimit: 2 }));
            print("  PREMIUM: " + db.subscriptions.countDocuments({ planId: "PREMIUM", comprehensiveCreditsLimit: 10 }));
            print("  ULTIMATE: " + db.subscriptions.countDocuments({ planId: "ULTIMATE", comprehensiveCreditsLimit: 20 }));
        '
        echo -e "${GREEN}  ✓ Credits set${NC}"
    else
        echo -e "${YELLOW}  ! mongosh not installed. Run manually:${NC}"
        echo ""
        echo "    DATABASE_URL=\$(gcloud secrets versions access latest --secret=DATABASE_URL_${ENV_UP} --project=$PROJECT_ID)"
        echo "    mongosh \"\$DATABASE_URL\" --eval '"
        echo "      db.subscriptions.updateMany({planId:\"PRO\",comprehensiveCreditsLimit:{\$in:[null,0]}},{\$set:{comprehensiveCreditsLimit:2,comprehensiveCreditsUsed:0}});'"
        echo "      db.subscriptions.updateMany({planId:\"PREMIUM\",comprehensiveCreditsLimit:{\$in:[null,0]}},{\$set:{comprehensiveCreditsLimit:10,comprehensiveCreditsUsed:0}});'"
        echo "      db.subscriptions.updateMany({planId:\"ULTIMATE\",comprehensiveCreditsLimit:{\$in:[null,0]}},{\$set:{comprehensiveCreditsLimit:20,comprehensiveCreditsUsed:0}});'"
        echo "    '"
        echo ""
    fi
    echo ""
fi

# ── Step 6: Health Check ────────────────────────────────────────────
if should_run_step 6; then
    echo -e "${YELLOW}Step 6/6: Verifying deployment...${NC}"

    SERVICE_URL=$(gcloud run services describe "stockbook-workers-${ENV}" \
        --region="$REGION" --project="$PROJECT_ID" \
        --format="value(status.url)" 2>/dev/null)

    if [ -n "$SERVICE_URL" ]; then
        echo "   Waiting 10s for new revision to stabilize..."
        sleep 10
        HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${SERVICE_URL}/health" 2>/dev/null || echo "000")
        if [ "$HEALTH" = "200" ]; then
            echo -e "${GREEN}  ✓ Workers healthy (HTTP 200)${NC}"
            echo "    URL: ${SERVICE_URL}"
        else
            echo -e "${RED}  ✗ Workers unhealthy (HTTP ${HEALTH})${NC}"
            echo "    URL: ${SERVICE_URL}/health"
            # A non-200 from a revision we just deployed is unambiguous
            # evidence the deploy is broken, so it decides the exit code.
            # (The "could not get service URL" arm below is left non-fatal: on
            # a first-ever deploy the service legitimately may not exist yet.)
            VERIFY_FAILED=1
        fi
    else
        echo -e "${YELLOW}  ! Could not get service URL (service may not exist yet)${NC}"
    fi
    echo ""
fi

# ── Summary ─────────────────────────────────────────────────────────
echo -e "${BLUE}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Done!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}Manual steps (if not done already):${NC}"
echo "  1. Clerk Dashboard: Add 'session.created' to webhook events"
echo "  2. Vercel: Merge to main triggers auto-deploy for web + api"
echo "  3. GCP Console: Request Gemini quota increase if needed"
echo ""
echo -e "${YELLOW}Verify:${NC}"
echo "  ./scripts/ops/update-prod-analysis-engine.sh status"
echo "  See docs/reference/3-tier-analysis-deployment.md section 8 for full checklist"
echo ""

# Exit non-zero if the deployed revision failed its health check — MONEY-1238.
# Deliberately the LAST statement: the summary and manual-steps list above are
# what the operator needs in order to act, so they print either way. What must
# not happen is a green "Done!" and exit 0 over a revision serving 503.
if [ "${VERIFY_FAILED:-0}" -ne 0 ]; then
    echo -e "${RED}Deploy verification FAILED — the new revision did not answer 200 on /health.${NC}"
    echo -e "${YELLOW}  gcloud run services logs read stockbook-workers-${ENV} --region=${REGION} --limit=50${NC}"
    exit 1
fi
