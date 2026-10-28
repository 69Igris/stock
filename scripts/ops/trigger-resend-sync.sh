#!/bin/bash
# ============================================
# UseMoney - Trigger Resend Contact Sync (backfill)
# ============================================
# Publishes a one-off message to the `resend-contact-sync` Pub/Sub topic so
# the Cloud Run worker (workers/src/processors/resend-contact-sync.ts) runs
# immediately, instead of waiting for the weekly Sunday scheduler.
#
# Use this to backfill new signups that missed real-time Resend sync (e.g. the
# MONEY-523 webhook regression). It reuses the exact production worker code
# path, so it needs no local DATABASE_URL / RESEND_API_KEY — only gcloud auth.
#
# Modes:
#   (default)  DIFFERENTIAL — only touches users whose User/Subscription
#              changed since lastResendSyncAt, plus never-synced users
#              (lastResendSyncAt = null). This is exactly the set of missed
#              signups, and is cheap. Use this for the MONEY-523 backfill.
#   --force    FORCE — re-syncs every user (heavy; thousands of Resend API
#              calls). Only for schema migrations / full audience rebuilds.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - Publish rights on the topic in the target project
#
# Usage:
#   ./scripts/ops/trigger-resend-sync.sh qa            # differential, QA
#   ./scripts/ops/trigger-resend-sync.sh prod          # differential, prod
#   ./scripts/ops/trigger-resend-sync.sh prod --force  # full re-sync, prod
# ============================================

set -euo pipefail

TARGET="${1:-}"
FORCE_FLAG="${2:-}"

GCP_PROJECT_ID="${GCP_PROJECT_ID:-stock-book-483718}"
TOPIC_BASE="resend-contact-sync"

if [ "$TARGET" != "qa" ] && [ "$TARGET" != "prod" ]; then
  echo "Usage: ./scripts/ops/trigger-resend-sync.sh [qa|prod] [--force]"
  echo ""
  echo "  qa      Publish to ${TOPIC_BASE}-qa (differential backfill)"
  echo "  prod    Publish to ${TOPIC_BASE}-prod (differential backfill)"
  echo "  --force (optional) Re-sync ALL users, not just changed/never-synced ones"
  exit 1
fi

TOPIC="${TOPIC_BASE}-${TARGET}"

if [ "$FORCE_FLAG" == "--force" ]; then
  MESSAGE='{"forceResync":true}'
  MODE="FORCE (all users)"
elif [ -n "$FORCE_FLAG" ]; then
  echo "Unknown flag: $FORCE_FLAG (did you mean --force?)"
  exit 1
else
  MESSAGE='{}'
  MODE="DIFFERENTIAL (changed + never-synced users)"
fi

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  Trigger Resend Contact Sync                ║"
echo "╠════════════════════════════════════════════╣"
printf "║  Project : %-32s║\n" "$GCP_PROJECT_ID"
printf "║  Topic   : %-32s║\n" "$TOPIC"
printf "║  Mode    : %-32s║\n" "$MODE"
echo "╚════════════════════════════════════════════╝"
echo ""

if [ "$TARGET" == "prod" ] && [ "$FORCE_FLAG" == "--force" ]; then
  read -r -p "FORCE re-sync of ALL prod users will make thousands of Resend API calls. Continue? [y/N] " ans
  case "$ans" in
    [yY] | [yY][eE][sS]) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

gcloud pubsub topics publish "$TOPIC" \
  --project="$GCP_PROJECT_ID" \
  --message="$MESSAGE"

echo ""
echo "Published. Follow the worker run with:"
echo "  gcloud logging read 'resource.type=cloud_run_revision AND textPayload:\"[resend-sync]\"' \\"
echo "    --project=$GCP_PROJECT_ID --limit=50 --freshness=15m"
