#!/usr/bin/env bash
#
# Migrate PortfolioRoast to async model (sessionId, status, progress fields).
#
# Steps:
#   1. Backfill existing records with unique sessionId + default status fields
#   2. Push Prisma schema (creates unique index on sessionId, status index, etc.)
#
# Usage:
#   ./packages/database/scripts/migrate-roast-async.sh           # dev (uses root .env)
#   ./packages/database/scripts/migrate-roast-async.sh qa        # QA database
#   ./packages/database/scripts/migrate-roast-async.sh prod      # Production database
#
# For QA/prod, set DATABASE_URL in environment or pass it inline:
#   DATABASE_URL="mongodb+srv://..." ./packages/database/scripts/migrate-roast-async.sh prod
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DB_PKG="$REPO_ROOT/packages/database"

ENV="${1:-dev}"

echo "================================================"
echo "  Roast Async Migration - $ENV"
echo "================================================"
echo ""

# ── Load DATABASE_URL ────────────────────────────────────────────────────────

if [ -z "${DATABASE_URL:-}" ]; then
  case "$ENV" in
    dev)
      if [ -f "$REPO_ROOT/.env" ]; then
        echo "Loading DATABASE_URL from .env"
        export DATABASE_URL
        DATABASE_URL=$(grep -E '^DATABASE_URL=' "$REPO_ROOT/.env" | cut -d '=' -f2-)
      fi
      ;;
    qa)
      if [ -f "$REPO_ROOT/.env.qa" ]; then
        echo "Loading DATABASE_URL from .env.qa"
        export DATABASE_URL
        DATABASE_URL=$(grep -E '^DATABASE_URL=' "$REPO_ROOT/.env.qa" | cut -d '=' -f2-)
      fi
      ;;
    prod|production)
      if [ -f "$REPO_ROOT/.env.prod" ]; then
        echo "Loading DATABASE_URL from .env.prod"
        export DATABASE_URL
        DATABASE_URL=$(grep -E '^DATABASE_URL=' "$REPO_ROOT/.env.prod" | cut -d '=' -f2-)
      fi
      ;;
    *)
      echo "Unknown environment: $ENV"
      echo "Usage: $0 [dev|qa|prod]"
      exit 1
      ;;
  esac
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo ""
  echo "ERROR: DATABASE_URL is not set."
  echo ""
  echo "Either:"
  echo "  1. Create .env / .env.qa / .env.prod at the repo root with DATABASE_URL=..."
  echo "  2. Pass it inline:  DATABASE_URL=\"mongodb+srv://...\" $0 $ENV"
  echo ""
  exit 1
fi

# Mask the URL for display (show host only)
DB_HOST=$(echo "$DATABASE_URL" | sed -E 's|.*@([^/]+)/.*|\1|')
echo "Target database host: $DB_HOST"
echo ""

# ── Safety prompt for production ─────────────────────────────────────────────

if [[ "$ENV" == "prod" || "$ENV" == "production" ]]; then
  echo "⚠️  WARNING: You are about to migrate the PRODUCTION database."
  echo ""
  read -rp "Type 'yes' to continue: " CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    echo "Aborted."
    exit 0
  fi
  echo ""
fi

# ── Step 1: Backfill existing records ────────────────────────────────────────

echo "Step 1/2: Backfilling existing roasts with sessionId..."
echo "─────────────────────────────────────────────────────────"

npx tsx "$DB_PKG/scripts/backfill-roast-sessionid.ts"

echo ""
echo "Step 1/2: ✓ Backfill complete"
echo ""

# ── Step 2: Push Prisma schema ───────────────────────────────────────────────

echo "Step 2/2: Pushing Prisma schema..."
echo "─────────────────────────────────────────────────────────"

cd "$DB_PKG"
npx prisma db push

echo ""
echo "Step 2/2: ✓ Schema pushed"
echo ""

echo "================================================"
echo "  Migration complete for $ENV!"
echo "================================================"
