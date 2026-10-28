#!/bin/bash
# ============================================
# Clerk → DB User/Subscription backfill (MONEY-144)
# ============================================
# Wraps backfill-clerk-user-sync.ts by fetching env-specific secrets
# from GCP Secret Manager (DATABASE_URL_{ENV}, CLERK_SECRET_KEY_{ENV}).
#
# Usage:
#   ./scripts/migrations/backfill-clerk-user-sync.sh qa
#   ./scripts/migrations/backfill-clerk-user-sync.sh prod
#   ./scripts/migrations/backfill-clerk-user-sync.sh prod --dry-run
#   ./scripts/migrations/backfill-clerk-user-sync.sh prod --limit=50
#
# Falls back to the current shell env if a Clerk secret is not in GCP
# (so local dev can run it without provisioning a separate secret).
# ============================================

set -e

ENV=""
EXTRA_ARGS=""

while [ $# -gt 0 ]; do
    case "$1" in
        qa|prod) ENV="$1"; shift ;;
        --dry-run|--limit=*) EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

if [ -z "$ENV" ]; then
    echo "Usage: $0 [qa|prod] [--dry-run] [--limit=N]"
    exit 1
fi

PROJECT_ID="stock-book-483718"
DB_SECRET="DATABASE_URL_$(echo "$ENV" | tr '[:lower:]' '[:upper:]')"
CLERK_SECRET="CLERK_SECRET_KEY_$(echo "$ENV" | tr '[:lower:]' '[:upper:]')"

echo "Fetching $DB_SECRET from GCP Secret Manager..."
DB_URL=$(gcloud secrets versions access latest --secret="$DB_SECRET" --project="$PROJECT_ID" 2>/dev/null)
if [ -z "$DB_URL" ]; then
    echo "ERROR: Could not fetch $DB_SECRET"
    exit 1
fi

# Clerk secret: try GCP first, fall back to shell env
CLERK_KEY=$(gcloud secrets versions access latest --secret="$CLERK_SECRET" --project="$PROJECT_ID" 2>/dev/null || true)
if [ -z "$CLERK_KEY" ]; then
    if [ -z "$CLERK_SECRET_KEY" ]; then
        echo "ERROR: No $CLERK_SECRET in GCP Secret Manager, and CLERK_SECRET_KEY is not set in shell env."
        echo "Either provision $CLERK_SECRET, or export CLERK_SECRET_KEY locally before running."
        exit 1
    fi
    CLERK_KEY="$CLERK_SECRET_KEY"
    echo "Using CLERK_SECRET_KEY from shell env (no GCP secret found)"
fi

echo "Running backfill against $ENV..."
DATABASE_URL="$DB_URL" CLERK_SECRET_KEY="$CLERK_KEY" \
    npx tsx scripts/migrations/backfill-clerk-user-sync.ts $EXTRA_ARGS
