#!/bin/bash
# ============================================
# User.isActive backfill (MONEY-1050)
# ============================================
# Wraps backfill-user-isactive.ts by fetching the env-specific DATABASE_URL
# from GCP Secret Manager (DATABASE_URL_{ENV}). Stamps isActive=true onto
# legacy User documents PHYSICALLY missing the field (it was added after some
# users were created; Prisma's @default(true) only applies to new writes).
# Idempotent — only matches { isActive: { $exists: false } }.
#
# DRY-RUN by default — pass --apply to write.
#
# Usage:
#   ./scripts/ops/backfill-user-isactive.sh qa             # preview (dry-run) on QA
#   ./scripts/ops/backfill-user-isactive.sh prod           # preview (dry-run) on PROD
#   ./scripts/ops/backfill-user-isactive.sh prod --apply   # write on PROD
#   ./scripts/ops/backfill-user-isactive.sh all --apply    # write on QA then PROD
# ============================================

set -e

ENV=""
EXTRA_ARGS=""

while [ $# -gt 0 ]; do
    case "$1" in
        qa|prod|all) ENV="$1"; shift ;;
        --apply|--dry-run) EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

if [ -z "$ENV" ]; then
    echo "Usage: $0 [qa|prod|all] [--apply]"
    exit 1
fi

PROJECT_ID="stock-book-483718"

run_one() {
    local env="$1"
    local db_secret="DATABASE_URL_$(echo "$env" | tr '[:lower:]' '[:upper:]')"

    echo "Fetching ${db_secret} from GCP Secret Manager..."
    local db_url
    db_url=$(gcloud secrets versions access latest --secret="${db_secret}" --project="${PROJECT_ID}" 2>/dev/null)
    if [ -z "${db_url}" ]; then
        echo "ERROR: Could not fetch ${db_secret}" >&2
        echo "  gcloud secrets versions list ${db_secret} --project=${PROJECT_ID}" >&2
        exit 1
    fi

    echo "Running backfill against ${env}..."
    DATABASE_URL="${db_url}" npx tsx scripts/ops/backfill-user-isactive.ts ${EXTRA_ARGS}
}

if [ "${ENV}" = "all" ]; then
    run_one qa
    run_one prod
else
    run_one "${ENV}"
fi
