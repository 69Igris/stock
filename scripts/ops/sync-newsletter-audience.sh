#!/bin/bash
# ============================================
# UseMoney - Sync Newsletter Audience (backfill)
# ============================================
# Upserts every registered User into the Resend NEWSLETTER audience for the
# target environment.
#
# Unlike trigger-resend-sync.sh (which publishes a Pub/Sub message so the Cloud
# Run worker does the work with its own env), the newsletter-audience sync runs
# LOCALLY against the env's MongoDB + Resend. So — like seed-env.sh — this
# wrapper resolves the env's secrets from GCP Secret Manager and runs
# apps/web/scripts/sync-newsletter-audience.ts with them. No local .env juggling,
# no risk of pointing dev creds (or the wrong audience) at prod.
#
# Resolves per env (from GCP Secret Manager):
#   DATABASE_URL_{QA|PROD}                   -> MongoDB connection
#   RESEND_API_KEY_{QA|PROD}                 -> Resend API key
#   RESEND_AUDIENCE_NEWSLETTER_ID_{QA|PROD}  -> target newsletter audience
#
# Prerequisites:
#   - gcloud CLI installed + authenticated (gcloud auth login)
#   - Secret Manager accessor role on those secrets in the target project
#   - Node.js + tsx
#
# Usage:
#   ./scripts/ops/sync-newsletter-audience.sh qa                 # backfill QA
#   ./scripts/ops/sync-newsletter-audience.sh prod               # backfill prod (confirms)
#   ./scripts/ops/sync-newsletter-audience.sh all                # both, sequentially
#   ./scripts/ops/sync-newsletter-audience.sh qa --dry-run       # list, no Resend calls
#   ./scripts/ops/sync-newsletter-audience.sh prod --limit=50    # first 50 users only
# ============================================

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-stock-book-483718}"
SYNC_SCRIPT="apps/web/scripts/sync-newsletter-audience.ts"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

# ── Parse args ──
TARGET=""
DRY="false"
PASSTHRU=()
while [ $# -gt 0 ]; do
  case "$1" in
    qa|prod|all) TARGET="$1"; shift ;;
    --dry-run)   DRY="true"; PASSTHRU+=("--dry-run"); shift ;;
    --limit=*)   PASSTHRU+=("$1"); shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [ -z "$TARGET" ]; then
  echo "Usage: ./scripts/ops/sync-newsletter-audience.sh [qa|prod|all] [--dry-run] [--limit=N]"
  echo ""
  echo "  qa         Backfill the QA newsletter audience (secrets from GCP)"
  echo "  prod       Backfill the prod newsletter audience (secrets from GCP, confirms)"
  echo "  all        Both, sequentially (qa then prod)"
  echo "  --dry-run  List emails without calling the Resend API"
  echo "  --limit=N  Process only the first N users (smoke test)"
  exit 1
fi

# ── Helper: fetch a secret (status -> stderr, value -> stdout) ──
get_secret() {
  local NAME=$1
  echo -e "${BLUE}  Fetching ${NAME}...${NC}" >&2
  local VAL
  VAL=$(gcloud secrets versions access latest --secret="$NAME" --project="$PROJECT_ID" 2>/dev/null || true)
  if [ -z "$VAL" ]; then
    echo -e "${RED}  Failed to fetch ${NAME} from Secret Manager.${NC}" >&2
    echo "  Check: gcloud secrets versions list ${NAME} --project=${PROJECT_ID}" >&2
    exit 1
  fi
  echo "$VAL"
}

# ── Run for one environment ──
sync_env() {
  local ENV=$1
  local SUFFIX
  SUFFIX=$(echo "$ENV" | tr '[:lower:]' '[:upper:]')   # qa->QA, prod->PROD

  echo ""
  echo "╔════════════════════════════════════════════╗"
  echo "║  Sync Newsletter Audience                   ║"
  echo "╠════════════════════════════════════════════╣"
  printf "║  Env     : %-32s║\n" "$ENV"
  printf "║  Project : %-32s║\n" "$PROJECT_ID"
  printf "║  Mode    : %-32s║\n" "$([ "$DRY" == "true" ] && echo "DRY-RUN (no Resend calls)" || echo "LIVE")"
  echo "╚════════════════════════════════════════════╝"

  echo ""
  echo -e "${CYAN}━ Step 1/2 · resolve secrets from GCP Secret Manager${NC}"
  local DB_URL API_KEY AUD_ID
  DB_URL=$(get_secret "DATABASE_URL_${SUFFIX}")
  API_KEY=$(get_secret "RESEND_API_KEY_${SUFFIX}")
  AUD_ID=$(get_secret "RESEND_AUDIENCE_NEWSLETTER_ID_${SUFFIX}")
  echo -e "${GREEN}  Resolved (newsletter audience …${AUD_ID: -6}).${NC}"

  # prod live runs confirm before touching the production audience
  if [ "$ENV" == "prod" ] && [ "$DRY" != "true" ]; then
    read -r -p "  Upsert ALL prod users into the prod newsletter audience. Continue? [y/N] " ans
    case "$ans" in
      [yY] | [yY][eE][sS]) ;;
      *) echo -e "${YELLOW}  Skipped prod.${NC}"; return 0 ;;
    esac
  fi

  echo ""
  echo -e "${CYAN}━ Step 2/2 · upsert users → newsletter audience${NC}"
  DATABASE_URL="$DB_URL" \
  RESEND_API_KEY="$API_KEY" \
  RESEND_AUDIENCE_NEWSLETTER_ID="$AUD_ID" \
    npx tsx "$SYNC_SCRIPT" ${PASSTHRU[@]+"${PASSTHRU[@]}"}

  echo -e "${GREEN}  ${ENV} newsletter sync complete.${NC}"
}

if [ "$TARGET" == "all" ]; then
  sync_env "qa"
  sync_env "prod"
else
  sync_env "$TARGET"
fi

echo ""
echo -e "${GREEN}✓ Newsletter audience sync done.${NC}"
