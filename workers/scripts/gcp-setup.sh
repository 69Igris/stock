#!/bin/bash
# ============================================
# UseMoney - Complete GCP Setup Script
# ============================================
# One-time setup for ALL GCP infrastructure:
#   - APIs, service accounts, IAM roles
#   - Cloud Build permissions
#   - Secret Manager secrets (DB, Redis, Clerk, Encryption, Broker keys)
#   - Pub/Sub topics
#   - Storage buckets
#
# Usage: ./gcp-setup.sh
# ============================================

set -e

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
SA_NAME="stockbook-api"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  UseMoney - Complete GCP Setup              ║"
echo "╠══════════════════════════════════════════════╣"
echo -e "║  Project:  ${BLUE}${PROJECT_ID}${NC}"
echo -e "║  Region:   ${BLUE}${REGION}${NC}"
echo -e "║  SA:       ${BLUE}${SA_EMAIL}${NC}"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ============================================
# Step 1: Set Project & Enable APIs
# ============================================
echo -e "${BLUE}1. Setting project and enabling APIs...${NC}"
gcloud config set project $PROJECT_ID

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  containerregistry.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  pubsub.googleapis.com \
  cloudscheduler.googleapis.com \
  --quiet

echo -e "${GREEN}   All APIs enabled${NC}"

# ============================================
# Step 2: Get Project Number (needed for SA references)
# ============================================
echo ""
echo -e "${BLUE}2. Getting project number...${NC}"
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
echo "   Project number: ${PROJECT_NUMBER}"

# Cloud Build uses the default Compute Engine SA in newer projects
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
# Legacy Cloud Build SA (may also exist)
CLOUDBUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
# Pub/Sub service agent
PUBSUB_SA="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

echo "   Compute SA:     ${COMPUTE_SA}"
echo "   Cloud Build SA: ${CLOUDBUILD_SA}"
echo "   Pub/Sub SA:     ${PUBSUB_SA}"

# ============================================
# Step 3: Create Application Service Account
# ============================================
echo ""
echo -e "${BLUE}3. Creating application service account...${NC}"

if gcloud iam service-accounts describe $SA_EMAIL &>/dev/null; then
  echo -e "${GREEN}   Service account already exists: ${SA_EMAIL}${NC}"
else
  gcloud iam service-accounts create $SA_NAME \
    --display-name="UseMoney API Service Account" \
    --description="Shared service account for UseMoney API and Workers on Cloud Run"
  echo -e "${GREEN}   Created: ${SA_EMAIL}${NC}"
fi

# ============================================
# Step 4: Grant IAM Roles to Application SA
# ============================================
echo ""
echo -e "${BLUE}4. Granting IAM roles to application SA (${SA_NAME})...${NC}"

declare -a APP_SA_ROLES=(
  "roles/secretmanager.secretAccessor"
  "roles/pubsub.publisher"
  "roles/storage.objectAdmin"
  "roles/run.invoker"
  "roles/aiplatform.user"
)

for role in "${APP_SA_ROLES[@]}"; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="${role}" \
    --condition=None --quiet 2>/dev/null
  echo "   ${SA_EMAIL} <- ${role}"
done

# ============================================
# Step 5: Grant IAM Roles to Cloud Build SAs
# ============================================
echo ""
echo -e "${BLUE}5. Granting IAM roles to Cloud Build service accounts...${NC}"

# Roles needed by Cloud Build to build images, push to GCR, deploy to Cloud Run, read secrets
declare -a BUILD_ROLES=(
  "roles/cloudbuild.builds.builder"
  "roles/storage.admin"
  "roles/run.admin"
  "roles/secretmanager.secretAccessor"
  "roles/iam.serviceAccountUser"
  "roles/logging.logWriter"
)

# Grant to default Compute Engine SA (used by Cloud Build in newer projects)
for role in "${BUILD_ROLES[@]}"; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${COMPUTE_SA}" \
    --role="${role}" \
    --condition=None --quiet 2>/dev/null
  echo "   ${COMPUTE_SA} <- ${role}"
done

# Also grant to legacy Cloud Build SA if it exists
if gcloud iam service-accounts describe $CLOUDBUILD_SA &>/dev/null 2>&1; then
  echo ""
  echo "   Also granting to legacy Cloud Build SA..."
  for role in "${BUILD_ROLES[@]}"; do
    gcloud projects add-iam-policy-binding $PROJECT_ID \
      --member="serviceAccount:${CLOUDBUILD_SA}" \
      --role="${role}" \
      --condition=None --quiet 2>/dev/null
    echo "   ${CLOUDBUILD_SA} <- ${role}"
  done
fi

# Cloud Build SA needs to impersonate the app SA (for --service-account on Cloud Run)
echo ""
echo "   Granting serviceAccountUser on app SA to Cloud Build..."
gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL \
  --member="serviceAccount:${COMPUTE_SA}" \
  --role="roles/iam.serviceAccountUser" \
  --quiet 2>/dev/null
echo "   ${COMPUTE_SA} can act as ${SA_EMAIL}"

if gcloud iam service-accounts describe $CLOUDBUILD_SA &>/dev/null 2>&1; then
  gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL \
    --member="serviceAccount:${CLOUDBUILD_SA}" \
    --role="roles/iam.serviceAccountUser" \
    --quiet 2>/dev/null
  echo "   ${CLOUDBUILD_SA} can act as ${SA_EMAIL}"
fi

# ============================================
# Step 6: Create Secrets
# ============================================
echo ""
echo -e "${BLUE}6. Creating secrets in Secret Manager...${NC}"

# All secrets are per-environment (QA + PROD)
# Broker API keys differ between QA (test) and PROD (live)
declare -a ALL_SECRETS=(
  # Infrastructure
  "DATABASE_URL_QA"
  "REDIS_URL_QA"
  "CLERK_SECRET_KEY_QA"
  "ENCRYPTION_KEY_QA"
  "DATABASE_URL_PROD"
  "REDIS_URL_PROD"
  "CLERK_SECRET_KEY_PROD"
  "ENCRYPTION_KEY_PROD"
  # Broker API keys - QA
  "ZERODHA_API_KEY_QA"
  "ZERODHA_API_SECRET_QA"
  "UPSTOX_API_KEY_QA"
  "UPSTOX_API_SECRET_QA"
  "ANGEL_API_KEY_QA"
  "DHAN_CLIENT_ID_QA"
  "DHAN_API_KEY_QA"
  "FYERS_APP_ID_QA"
  "FYERS_SECRET_KEY_QA"
  # Broker API keys - PROD
  "ZERODHA_API_KEY_PROD"
  "ZERODHA_API_SECRET_PROD"
  "UPSTOX_API_KEY_PROD"
  "UPSTOX_API_SECRET_PROD"
  "ANGEL_API_KEY_PROD"
  "DHAN_CLIENT_ID_PROD"
  "DHAN_API_KEY_PROD"
  "FYERS_APP_ID_PROD"
  "FYERS_SECRET_KEY_PROD"
  # Resend (email) - QA
  "RESEND_API_KEY_QA"
  "RESEND_AUDIENCE_FREE_ID_QA"
  "RESEND_AUDIENCE_PAID_ID_QA"
  "RESEND_AUDIENCE_DOWNGRADED_ID_QA"
  "RESEND_AUDIENCE_USEMONEY_SECURITY_ID_QA"
  "RESEND_AUDIENCE_MARKETING_ID_QA"
  "RESEND_AUDIENCE_NEWSLETTER_ID_QA"
  # Resend (email) - PROD
  "RESEND_API_KEY_PROD"
  "RESEND_AUDIENCE_FREE_ID_PROD"
  "RESEND_AUDIENCE_PAID_ID_PROD"
  "RESEND_AUDIENCE_DOWNGRADED_ID_PROD"
  "RESEND_AUDIENCE_USEMONEY_SECURITY_ID_PROD"
  "RESEND_AUDIENCE_MARKETING_ID_PROD"
  "RESEND_AUDIENCE_NEWSLETTER_ID_PROD"
  # Datadog — API keys feed the services and sidecars; the APPLICATION key is
  # read only by scripts/ops/datadog/apply-monitors.sh (monitor CRUD needs both
  # headers, and an application key can only be minted in the Datadog UI —
  # MONEY-1229). Org is on us5.datadoghq.com since Sep 2026.
  "DD_API_KEY_QA"
  "DD_API_KEY_PROD"
  "DD_APP_KEY_QA"
  "DD_APP_KEY_PROD"
  # MONEY-980 - Tiingo API token for the US price backbone. Sent as
  # `Authorization: Token <key>`; every api.tiingo.com call needs it, and the
  # client THROWS rather than fetching unauthenticated when it is absent, so a
  # missing secret is a loud failure instead of a nightly job that quietly
  # writes nothing. NOTE the companion `TIINGO_PLAN` is deliberately NOT a
  # secret - it is a plain env var in the cloudbuild specs, because it selects
  # which rate ceilings to obey and an operator needs to read it at a glance
  # (MONEY-1262).
  "TIINGO_API_KEY_QA"
  "TIINGO_API_KEY_PROD"
  # GCP Service Account Key (for GCS + PubSub on Cloud Run)
  "GCP_SERVICE_ACCOUNT_KEY_BASE64"
)

echo ""
echo "   Creating all secrets (42 total)..."
for secret in "${ALL_SECRETS[@]}"; do
  if gcloud secrets describe $secret &>/dev/null; then
    echo -e "   ${GREEN}${secret} already exists${NC}"
  else
    echo "placeholder" | gcloud secrets create $secret \
      --data-file=- --replication-policy="automatic" --quiet
    echo -e "   ${YELLOW}Created: ${secret}${NC}"
  fi
done

# Grant app SA access to each secret
echo ""
echo "   Granting per-secret access to app SA..."
for secret in "${ALL_SECRETS[@]}"; do
  gcloud secrets add-iam-policy-binding $secret \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet 2>/dev/null || true
done
echo -e "${GREEN}   Done${NC}"

# ============================================
# Step 7: Create Pub/Sub Topics
# ============================================
echo ""
echo -e "${BLUE}7. Creating Pub/Sub topics...${NC}"

# THIS IS gcp-setup.sh's OWN, THIRD COPY OF THE TOPIC LIST — MONEY-1314.
#
# The authoritative one is workers/scripts/setup-pubsub.sh, which also creates
# the push subscriptions; packages/types/src/pubsub.ts (PUBSUB_TOPICS) is what
# the publishers actually resolve. This copy exists because gcp-setup.sh is the
# FRESH-PROJECT bootstrap and runs before setup-pubsub.sh has ever been used.
#
# It had drifted badly and silently. Measured 2026-09-01, before this rewrite it
# carried 26 entries against setup-pubsub.sh's 64: it was missing the ENTIRE
# document pipeline (stock-document-extract / -parse / -embed /
# document-financials-projection), every XBRL topic, every EDGAR topic and 30
# more — while still carrying `financial-data-sync`, RETIRED in MONEY-1220. A
# fresh-project bootstrap therefore produced a broken doc pipeline and a topic
# nothing has published to since March.
#
# Nothing could fail on that, which is why it lasted: three lists, no guard.
# packages/core/__tests__/pubsub/topic-list-agreement.test.ts is now that guard —
# it asserts all three agree, so a topic added to one and forgotten in another
# fails by name. KEEP THIS LIST IN setup-pubsub.sh's ORDER so the two diff
# cleanly by eye.
#
# `dead-letter` is the one deliberate extra: it is transport infrastructure, not
# a job topic, so it has no PUBSUB_TOPICS entry, and setup-pubsub.sh creates it
# outside BASE_TOPICS. The guard carries it as a NAMED, ratcheted exemption.
declare -a BASE_TOPICS=(
  "trade-pairing"
  "csv-import"
  "broker-sync"
  "instrument-sync"
  "price-sync"
  "intraday-sync"
  "sector-enrichment"
  "mf-sync"
  "mf-metadata-sync"
  "mf-nav-propagate"
  "mf-nav-backfill"
  "peers-sync"
  "ownership-sync"
  "annual-reports-sync"
  "ipo-sync"
  "stock-research"
  "document-process"
  "portfolio-roast"
  "comparison-analysis"
  "newsletter-publish"
  "l3-analysis"
  "login-briefing"
  "news-sync"
  "filings-sync"
  "chartink-strategy-sync"
  "intent-learning"
  "strategy-scan"
  "stock-document-sync"
  "stock-document-extract"
  "stock-document-parse"
  "stock-document-ingest"
  "document-financials-projection"
  "stock-document-embed"
  "corporate-actions-sync"
  "bhavcopy-sync"
  "bse-announcements-sync"
  "nse-announcements-sync"
  "report-archive-sync"
  "resend-contact-sync"
  "sparkline-sync"
  "research-preview-plan"
  "index-constituent-sync"
  "surveillance-sync"
  "institutional-flow-sync"
  "market-movers-sync"
  "macro-sync"
  "xbrl-sync"
  "xbrl-projection"
  "xbrl-ratios"
  "mf-portfolio-sync"
  "circulars-sync"
  "news-rss-sync"
  "events-sync"
  "alert-evaluator"
  "strategy-stats-sync"
  "account-deletion"
  "clerk-delete-sweep"
  "investor-rollup"
  "studio-render"
  "us-eod-sync"
  "us-instrument-master-sync"
  "candle-evict"
  "tiingo-news-poll"
  # MONEY-1324 (P17) - the 8-K/6-K exhibit insight lane. Consumed by
  # stockbook-workers (it reads text us-fundamentals already wrote to GCS), so
  # it belongs with the worker topics above and not with the EDGAR block below.
  "us-filing-insight"
  # MONEY-1520 - claimed SEC filings -> InstrumentEvent. The one topic whose
  # PUBLISHER is the Python service and whose CONSUMER is the workers, so it
  # sits here rather than in the EDGAR block below.
  "us-filing-events"
  # The EDGAR topics (MONEY-979). Consumed by services/us-fundamentals, a
  # SEPARATE Python Cloud Run service — which is exactly why they are easy to
  # leave out of a bootstrap that only thinks about the TypeScript workers.
  # setup-pubsub.sh keeps them in its own EDGAR_TOPICS array for the same
  # reason; the TOPICS still have to exist in a fresh project.
  "edgar-detect"
  "edgar-parse-ownership"
  "edgar-parse-13f"
  "edgar-parse-13dg"
  "edgar-parse-8k"
  "edgar-parse-financials"
  "edgar-evict"
  # Transport infrastructure, not a job topic — no PUBSUB_TOPICS entry.
  # setup-pubsub.sh creates this one outside BASE_TOPICS.
  "dead-letter"
)

# Create env-suffixed topics for both QA and Prod
for env_suffix in qa prod; do
  for base_topic in "${BASE_TOPICS[@]}"; do
    topic="${base_topic}-${env_suffix}"
    gcloud pubsub topics create $topic --quiet 2>/dev/null \
      && echo -e "   ${YELLOW}Created topic: ${topic}${NC}" \
      || echo -e "   ${GREEN}Topic ${topic} already exists${NC}"
  done
done

# ============================================
# Step 8: Grant Pub/Sub Push Auth Permissions
# ============================================
echo ""
echo -e "${BLUE}8. Granting Pub/Sub push authentication permissions...${NC}"

# Pub/Sub service agent needs to create OIDC tokens as the app SA
gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL \
  --member="serviceAccount:${PUBSUB_SA}" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --quiet 2>/dev/null
echo "   ${PUBSUB_SA} can create tokens as ${SA_EMAIL}"

# ============================================
# Step 9: Create Storage Buckets
# ============================================
echo ""
echo -e "${BLUE}9. Creating storage buckets...${NC}"

for BUCKET_ENV in qa prod; do
  BUCKET_NAME="stockbook-content-${BUCKET_ENV}"
  if gsutil ls -b gs://$BUCKET_NAME &>/dev/null 2>&1; then
    echo -e "   ${GREEN}Bucket ${BUCKET_NAME} already exists${NC}"
  else
    gsutil mb -p $PROJECT_ID -l $REGION gs://$BUCKET_NAME 2>/dev/null || true
    echo -e "   ${YELLOW}Created bucket: ${BUCKET_NAME}${NC}"
  fi
  # Always ensure SA has objectAdmin (needed for uploads, overwrites, deletes).
  # gcloud + `--condition=None`, NOT `gsutil iam ch`: the content buckets hold
  # a CONDITIONAL binding (setup-databento-jobs.sh's `databento/`-scoped read),
  # and `gsutil iam ch` refuses any policy with conditions — which the old
  # `|| true` swallowed while this line still printed success.
  if gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
      --member="serviceAccount:${SA_EMAIL}" --role=roles/storage.objectAdmin \
      --condition=None --quiet >/dev/null 2>&1; then
    echo "   ${SA_EMAIL} <- objectAdmin on ${BUCKET_NAME}"
  else
    echo -e "   ${RED}FAILED: ${SA_EMAIL} objectAdmin on ${BUCKET_NAME}${NC}"
  fi
done

# Also ensure permissions on local dev bucket if it exists
LOCAL_BUCKET="stockbook-content-local"
if gsutil ls -b gs://$LOCAL_BUCKET &>/dev/null 2>&1; then
  gsutil iam ch "serviceAccount:${SA_EMAIL}:objectAdmin" gs://$LOCAL_BUCKET 2>/dev/null || true
  echo "   ${SA_EMAIL} <- objectAdmin on ${LOCAL_BUCKET}"
fi

# And the learning content bucket
LEARNING_BUCKET="stockbook-learning-content"
if gsutil ls -b gs://$LEARNING_BUCKET &>/dev/null 2>&1; then
  gsutil iam ch "serviceAccount:${SA_EMAIL}:objectAdmin" gs://$LEARNING_BUCKET 2>/dev/null || true
  echo "   ${SA_EMAIL} <- objectAdmin on ${LEARNING_BUCKET}"
fi

# ============================================
# Step 9b: GST Invoice Buckets (MONEY-212 → MONEY-217 + MONEY-227)
# Tax invoices, credit notes, FIRC PDFs. MUST be private - public access
# would leak buyer details + bank routing info. Uniform bucket-level IAM
# + public-access-prevention enforced for belt-and-suspenders.
# ============================================
echo ""
echo -e "${BLUE}9b. Creating GST invoice buckets...${NC}"

for BUCKET_ENV in qa prod; do
  GST_BUCKET="usemoney-gst-invoices-${BUCKET_ENV}"
  if gsutil ls -b gs://$GST_BUCKET &>/dev/null 2>&1; then
    echo -e "   ${GREEN}Bucket ${GST_BUCKET} already exists${NC}"
  else
    # `-b on` enables uniform bucket-level access (no per-object ACLs)
    gsutil mb -p $PROJECT_ID -l $REGION -b on gs://$GST_BUCKET 2>/dev/null || true
    echo -e "   ${YELLOW}Created bucket: ${GST_BUCKET}${NC}"
  fi
  # Re-assert uniform access + public-access-prevention every run (idempotent)
  gsutil uniformbucketlevelaccess set on gs://$GST_BUCKET 2>/dev/null || true
  gsutil pap set enforced gs://$GST_BUCKET 2>/dev/null || true
  gsutil iam ch "serviceAccount:${SA_EMAIL}:objectAdmin" gs://$GST_BUCKET 2>/dev/null || true
  echo "   ${SA_EMAIL} <- objectAdmin on ${GST_BUCKET} (private, PAP enforced)"
done

# ============================================
# Step 9c: GST Secret Manager entries
# Frozen seller / bank details + LUT ARN (rotates annually on Apr 1).
# Stored as separate _QA / _PROD secrets so QA can use test ARNs without
# risking a wrong number on a real invoice.
# ============================================
echo ""
echo -e "${BLUE}9c. Initialising GST secret-manager entries...${NC}"

GST_SECRETS=(
  "GST_LUT_ARN"
  "GST_SELLER_LEGAL_NAME"
  "GST_SELLER_GSTIN"
  "GST_SELLER_PAN"
  "GST_SELLER_ADDRESS"
  "GST_SELLER_STATE_CODE"
  "GST_BANK_BENEFICIARY"
  "GST_BANK_ACCOUNT"
  "GST_BANK_IFSC"
  "GST_BANK_SWIFT"
)

for SECRET_BASE in "${GST_SECRETS[@]}"; do
  for ENV_SUFFIX in QA PROD; do
    SECRET_NAME="${SECRET_BASE}_${ENV_SUFFIX}"
    if gcloud secrets describe $SECRET_NAME --project=$PROJECT_ID &>/dev/null; then
      echo -e "   ${GREEN}Secret ${SECRET_NAME} already exists${NC}"
    else
      # Create empty secret. Operator must populate with: gcloud secrets versions add $SECRET_NAME --data-file=...
      printf "" | gcloud secrets create $SECRET_NAME \
        --project=$PROJECT_ID \
        --replication-policy=automatic \
        --data-file=- 2>/dev/null || true
      echo -e "   ${YELLOW}Created EMPTY secret: ${SECRET_NAME}${NC}"
      echo "   → populate with: gcloud secrets versions add ${SECRET_NAME} --data-file=<file>"
    fi
    # Workers SA can read at runtime
    gcloud secrets add-iam-policy-binding $SECRET_NAME \
      --member="serviceAccount:${SA_EMAIL}" \
      --role="roles/secretmanager.secretAccessor" \
      --quiet 2>/dev/null || true
  done
done

echo ""
echo -e "${YELLOW}>>> Action required:${NC}"
echo "   Populate the empty GST secrets above before invoice generation can run."
echo "   Recommended order:"
echo "     1. Get LUT ARN from CA after FY filing → set GST_LUT_ARN_QA + _PROD"
echo "     2. Set GST_SELLER_* and GST_BANK_* (frozen across QA + prod, but kept"
echo "        env-segregated to allow QA-only test data if needed)"
echo "   See docs/env-vars-reference.md for the canonical list."

# ============================================
# Done
# ============================================
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  GCP Setup Complete!                         ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo -e "${YELLOW}NEXT STEPS:${NC}"
echo ""
echo "── Step A: Set secret values ──"
echo ""
echo "  # Per-environment secrets (QA)"
echo "  echo -n 'mongodb+srv://...' | gcloud secrets versions add DATABASE_URL_QA --data-file=-"
echo "  echo -n 'rediss://...'      | gcloud secrets versions add REDIS_URL_QA --data-file=-"
echo "  echo -n 'sk_test_...'       | gcloud secrets versions add CLERK_SECRET_KEY_QA --data-file=-"
echo "  echo -n '<64-char-hex>'     | gcloud secrets versions add ENCRYPTION_KEY_QA --data-file=-"
echo ""
echo "  # Per-environment secrets (Production)"
echo "  echo -n 'mongodb+srv://...' | gcloud secrets versions add DATABASE_URL_PROD --data-file=-"
echo "  echo -n 'rediss://...'      | gcloud secrets versions add REDIS_URL_PROD --data-file=-"
echo "  echo -n 'sk_live_...'       | gcloud secrets versions add CLERK_SECRET_KEY_PROD --data-file=-"
echo "  echo -n '<64-char-hex>'     | gcloud secrets versions add ENCRYPTION_KEY_PROD --data-file=-"
echo ""
echo "  # Broker API keys (QA - test credentials)"
echo "  echo -n '...' | gcloud secrets versions add ZERODHA_API_KEY_QA --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add ZERODHA_API_SECRET_QA --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add UPSTOX_API_KEY_QA --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add UPSTOX_API_SECRET_QA --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add ANGEL_API_KEY_QA --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add DHAN_CLIENT_ID_QA --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add DHAN_API_KEY_QA --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add FYERS_APP_ID_QA --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add FYERS_SECRET_KEY_QA --data-file=-"
echo ""
echo "  # Broker API keys (PROD - live credentials)"
echo "  echo -n '...' | gcloud secrets versions add ZERODHA_API_KEY_PROD --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add ZERODHA_API_SECRET_PROD --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add UPSTOX_API_KEY_PROD --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add UPSTOX_API_SECRET_PROD --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add ANGEL_API_KEY_PROD --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add DHAN_CLIENT_ID_PROD --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add DHAN_API_KEY_PROD --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add FYERS_APP_ID_PROD --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add FYERS_SECRET_KEY_PROD --data-file=-"
echo ""
echo "  # Datadog API keys"
echo "  echo -n '...' | gcloud secrets versions add DD_API_KEY_QA --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add DD_API_KEY_PROD --data-file=-"
echo "  # Datadog APPLICATION key (apply-monitors.sh; mint in the Datadog UI)"
echo "  echo -n '...' | gcloud secrets versions add DD_APP_KEY_QA --data-file=-"
echo "  echo -n '...' | gcloud secrets versions add DD_APP_KEY_PROD --data-file=-"
echo ""
echo "  # Generate encryption key (if you don't have one):"
echo "  openssl rand -hex 32"
echo ""
echo "── Step B: Deploy Workers (from monorepo root) ──"
echo ""
echo "  gcloud builds submit --config=workers/cloudbuild.qa.yaml"
echo ""
echo "── Step C: Setup Pub/Sub subscriptions (after workers deploy) ──"
echo ""
echo "  cd workers && ./scripts/setup-pubsub.sh qa"
echo ""
echo "── Step D: Deploy API (from monorepo root) ──"
echo ""
echo "  gcloud builds submit --config=apps/api/cloudbuild.qa.yaml"
echo ""
echo "── Step E: Add DNS CNAME records ──"
echo ""
echo "  api.qa.usemoney.ai  -> CNAME -> ghs.googlehosted.com"
echo "  api.usemoney.ai     -> CNAME -> ghs.googlehosted.com"
echo ""
echo "── Step F: Create Cloud Build triggers (GCP Console) ──"
echo "  https://console.cloud.google.com/cloud-build/triggers?project=${PROJECT_ID}"
echo ""
echo "  Workers QA:   branch ^develop$|^qa/.*$  -> workers/cloudbuild.qa.yaml"
echo "  Workers Prod: branch ^main$             -> workers/cloudbuild.prod.yaml"
echo "  API QA:       branch ^develop$|^qa/.*$  -> apps/api/cloudbuild.qa.yaml"
echo "  API Prod:     branch ^main$             -> apps/api/cloudbuild.prod.yaml"
echo ""
