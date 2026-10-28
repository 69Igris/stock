#!/bin/bash
# ============================================
# UseMoney - Integration Test Environment Loader
# ============================================
# Fetches QA secrets from GCP Secret Manager and exports them
# as environment variables for running integration tests locally.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Secrets exist in GCP Secret Manager:
#       DATABASE_URL_QA, REDIS_URL_QA, WORKER_URL_QA
#
# Usage:
#   source scripts/ops/test-env.sh            # Load env vars into current shell
#   source scripts/ops/test-env.sh && yarn test:integration   # Load + run
#
# After sourcing, these env vars will be set:
#   DATABASE_URL, REDIS_URL, WORKER_URL, RUN_INTEGRATION_TESTS=true
# ============================================

set -e

PROJECT_ID="stock-book-483718"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ============================================
# Helper: fetch a secret from GCP Secret Manager
# ============================================
fetch_secret() {
    local SECRET_NAME=$1
    local DISPLAY_NAME=$2

    echo -e "${BLUE}Fetching ${DISPLAY_NAME} from GCP Secret Manager...${NC}" >&2
    local VALUE
    VALUE=$(gcloud secrets versions access latest --secret="$SECRET_NAME" --project="$PROJECT_ID" 2>/dev/null)

    if [ -z "$VALUE" ]; then
        echo -e "${RED}Failed to fetch ${SECRET_NAME} from Secret Manager.${NC}" >&2
        echo "Make sure the secret exists:" >&2
        echo "  gcloud secrets versions list ${SECRET_NAME} --project=${PROJECT_ID}" >&2
        return 1
    fi

    echo -e "${GREEN}Got ${DISPLAY_NAME}${NC}" >&2
    echo "$VALUE"
}

# ============================================
# Fetch all QA secrets
# ============================================
echo -e "${YELLOW}Loading QA environment for integration tests...${NC}"
echo ""

DATABASE_URL=$(fetch_secret "DATABASE_URL_QA" "DATABASE_URL") || exit 1
REDIS_URL=$(fetch_secret "REDIS_URL_QA" "REDIS_URL") || exit 1
WORKER_URL=$(fetch_secret "WORKER_URL_QA" "WORKER_URL") || exit 1

# ============================================
# Export env vars
# ============================================
export DATABASE_URL
export REDIS_URL
export WORKER_URL
export RUN_INTEGRATION_TESTS=true

echo ""
echo -e "${GREEN}Environment loaded successfully.${NC}"
echo -e "  DATABASE_URL  = ${BLUE}(set)${NC}"
echo -e "  REDIS_URL     = ${BLUE}(set)${NC}"
echo -e "  WORKER_URL    = ${BLUE}(set)${NC}"
echo -e "  RUN_INTEGRATION_TESTS = ${GREEN}true${NC}"
echo ""
echo -e "${YELLOW}Run integration tests with:${NC}"
echo "  yarn test:integration"
echo "  yarn test:integration:db"
echo "  yarn test:integration:cache"
echo "  yarn test:integration:workers"
