#!/bin/bash
# ============================================
# UseMoney - Broker-Trial Reset (Goodwill, MONEY-877)
# ============================================
# Grants ALL current FREE-plan users a fresh 30-day broker trial by stamping
#   User.brokerTrialEndsAt = now + 30d
# The broker connection was broken on our side, so affected free users couldn't
# use their original trial. Paid plans are never broker-gated, so they're
# excluded. The trial reads (brokerTrialEndsAt ?? createdAt + 30d), so this never
# touches the real signup date and is reversible (clear the field to revert).
#
# IMPORTANT: the trial-logic code that READS brokerTrialEndsAt must be DEPLOYED
# first (merge fix/MONEY-877 -> Vercel ships it). Until then the live gate reads
# createdAt and this write has NO effect.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - DATABASE_URL_QA / DATABASE_URL_PROD in GCP Secret Manager
#   - Node.js + tsx
#
# Usage:
#   DRY_RUN=1 ./scripts/ops/reset-broker-trial.sh qa     # preview, no writes (run first)
#             ./scripts/ops/reset-broker-trial.sh qa     # apply on QA
#   DRY_RUN=1 ./scripts/ops/reset-broker-trial.sh prod   # preview prod
#             ./scripts/ops/reset-broker-trial.sh prod   # apply prod
# ============================================

set -e

ENV=${1:-""}

if [ "$ENV" != "qa" ] && [ "$ENV" != "prod" ]; then
    echo "Usage: DRY_RUN=1 ./scripts/ops/reset-broker-trial.sh [qa|prod]"
    echo ""
    echo "  Sets User.brokerTrialEndsAt = now + 30d for all FREE-plan users."
    echo "  DRY_RUN=1   Preview the counts without writing (always run this first)."
    echo ""
    echo "  Requires the brokerTrialEndsAt trial logic to be DEPLOYED first."
    exit 1
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_ID="stock-book-483718"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Script lives at <repo>/scripts/ops/, so the repo root is two levels up.
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ "$ENV" == "qa" ]; then
    SECRET_NAME="DATABASE_URL_QA"
else
    SECRET_NAME="DATABASE_URL_PROD"
fi

if [ "${DRY_RUN:-0}" == "1" ] || [ "${DRY_RUN:-0}" == "true" ]; then
    DRY="1"; MODE="DRY_RUN (no writes)"
else
    DRY="0"; MODE="APPLY (writes)"
fi

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  UseMoney Broker-Trial Reset               ║"
echo "╠════════════════════════════════════════════╣"
echo "║  Environment: ${ENV}"
echo "║  Project: ${PROJECT_ID}"
echo "║  Mode: ${MODE}"
echo "╚════════════════════════════════════════════╝"
echo ""

echo -e "${BLUE}Fetching DATABASE_URL from Secret Manager (${SECRET_NAME})...${NC}" >&2
DB_URL=$(gcloud secrets versions access latest --secret="$SECRET_NAME" --project="$PROJECT_ID" 2>/dev/null)

if [ -z "$DB_URL" ]; then
    echo -e "${RED}Failed to fetch ${SECRET_NAME} from project ${PROJECT_ID}${NC}"
    echo -e "Make sure ${SECRET_NAME} exists and you are authenticated (gcloud auth login)."
    exit 1
fi

cd "$ROOT_DIR"
DATABASE_URL="$DB_URL" DRY_RUN="$DRY" yarn tsx scripts/ops/reset-broker-trial.ts

echo ""
echo -e "${GREEN}Broker-trial reset finished (${ENV}, ${MODE}).${NC}"
echo ""
