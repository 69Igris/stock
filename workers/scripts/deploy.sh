#!/bin/bash
# ============================================
# UseMoney Workers - Deploy to GCP Cloud Run Service
# ============================================
# Builds Docker image, pushes to GCR, deploys multi-container
# (worker + Datadog sidecar) to Cloud Run, and sets up Cloud Scheduler.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Docker daemon running (or use Cloud Build instead)
#   - GCP setup completed (./scripts/setup-gcp.sh)
#   - All secrets set in Secret Manager (including DD_API_KEY_*)
#
# Usage:
#   ./scripts/deploy.sh qa      # Deploy to QA
#   ./scripts/deploy.sh prod    # Deploy to Production
#
# Alternative (no local Docker needed):
#   gcloud builds submit --config=workers/cloudbuild.qa.yaml
# ============================================

set -e

ENV=${1:-qa}

if [ "$ENV" != "qa" ] && [ "$ENV" != "prod" ]; then
    echo "Usage: ./scripts/deploy.sh [qa|prod]"
    exit 1
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
SA_EMAIL="stockbook-api@${PROJECT_ID}.iam.gserviceaccount.com"
SERVICE_NAME="stockbook-workers-${ENV}"

if [ "$ENV" == "prod" ]; then
    IMAGE_TAG="stockbook-workers-prod"
    NODE_ENV="production"
    DD_ENV="production"
    BROKER_SUFFIX="PROD"
    PUBSUB_ENV="prod"
    GCS_BUCKET="stockbook-content-prod"
    MIN_INSTANCES=1
    MAX_INSTANCES=20
    MEMORY="1Gi"
    CPU=2
    echo -e "${RED}Deploying to PRODUCTION${NC}"
else
    IMAGE_TAG="stockbook-workers-qa"
    NODE_ENV="qa"
    DD_ENV="qa"
    BROKER_SUFFIX="QA"
    PUBSUB_ENV="qa"
    GCS_BUCKET="stockbook-content-qa"
    MIN_INSTANCES=0
    MAX_INSTANCES=5
    MEMORY="1Gi"
    CPU=1
    echo -e "${YELLOW}Deploying to QA${NC}"
fi

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  UseMoney Workers Deployment              ║"
echo "╠════════════════════════════════════════════╣"
echo "║  Environment: ${ENV}"
echo "║  Service: ${SERVICE_NAME}"
echo "║  Project: ${PROJECT_ID}"
echo "║  Region: ${REGION}"
echo "╚════════════════════════════════════════════╝"
echo ""

# Set project
gcloud config set project $PROJECT_ID

# ============================================
# Step 1: Build and Push Docker Image
# ============================================
echo -e "${BLUE}Step 1: Building Docker image...${NC}"

# Navigate to monorepo root
cd "$(dirname "$0")/../.."

COMMIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Build image with DD_VERSION
docker build \
    -t gcr.io/${PROJECT_ID}/${IMAGE_TAG}:latest \
    --build-arg DD_VERSION=${COMMIT_SHA} \
    -f workers/Dockerfile .

echo -e "${GREEN}Image built${NC}"

echo -e "${BLUE}Step 2: Pushing to Container Registry...${NC}"
docker push gcr.io/${PROJECT_ID}/${IMAGE_TAG}:latest

echo -e "${GREEN}Image pushed${NC}"

# ============================================
# Step 3: Deploy Cloud Run Service (multi-container with Datadog sidecar)
# ============================================
echo -e "${BLUE}Step 3: Deploying Cloud Run Service with Datadog sidecar...${NC}"

# Resolve CLOUD_RUN_URL from existing service (needed for OIDC token verification)
CLOUD_RUN_URL=$(gcloud run services describe ${SERVICE_NAME} \
    --region=${REGION} --format='value(status.url)' 2>/dev/null) || true
if [ -z "$CLOUD_RUN_URL" ]; then
    echo -e "   ${YELLOW}WARNING: Could not resolve CLOUD_RUN_URL (first deploy?). OIDC verification will fail.${NC}"
    echo "   After deploy, re-run this script to set CLOUD_RUN_URL correctly."
    CLOUD_RUN_URL="https://${SERVICE_NAME}-placeholder.run.app"
fi
echo "   CLOUD_RUN_URL: ${CLOUD_RUN_URL}"

# Generate Knative service YAML for multi-container deployment
cat > /tmp/stockbook-workers-service.yaml << EOF
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${SERVICE_NAME}
  annotations:
    run.googleapis.com/ingress: internal
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "${MIN_INSTANCES}"
        autoscaling.knative.dev/maxScale: "${MAX_INSTANCES}"
        run.googleapis.com/container-dependencies: '{"stockbook-workers":["datadog-agent"]}'
    spec:
      containerConcurrency: 10
      timeoutSeconds: 600
      serviceAccountName: ${SA_EMAIL}
      containers:
        - name: stockbook-workers
          image: gcr.io/${PROJECT_ID}/${IMAGE_TAG}:latest
          ports:
            - containerPort: 8080
          env:
            - name: NODE_ENV
              value: ${NODE_ENV}
            - name: DD_TRACE_ENABLED
              value: "true"
            - name: DD_SERVICE
              value: stockbook-workers
            - name: DD_ENV
              value: ${DD_ENV}
            - name: DD_VERSION
              value: "${COMMIT_SHA}"
            - name: DD_TRACE_AGENT_URL
              value: "http://localhost:8126"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: DATABASE_URL_${BROKER_SUFFIX}
                  key: latest
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: REDIS_URL_${BROKER_SUFFIX}
                  key: latest
            - name: ENCRYPTION_KEY
              valueFrom:
                secretKeyRef:
                  name: ENCRYPTION_KEY_${BROKER_SUFFIX}
                  key: latest
            - name: ZERODHA_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ZERODHA_API_KEY_${BROKER_SUFFIX}
                  key: latest
            - name: ZERODHA_API_SECRET
              valueFrom:
                secretKeyRef:
                  name: ZERODHA_API_SECRET_${BROKER_SUFFIX}
                  key: latest
            - name: UPSTOX_API_KEY
              valueFrom:
                secretKeyRef:
                  name: UPSTOX_API_KEY_${BROKER_SUFFIX}
                  key: latest
            - name: UPSTOX_API_SECRET
              valueFrom:
                secretKeyRef:
                  name: UPSTOX_API_SECRET_${BROKER_SUFFIX}
                  key: latest
            - name: ANGEL_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ANGEL_API_KEY_${BROKER_SUFFIX}
                  key: latest
            - name: DHAN_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: DHAN_CLIENT_ID_${BROKER_SUFFIX}
                  key: latest
            - name: DHAN_API_KEY
              valueFrom:
                secretKeyRef:
                  name: DHAN_API_KEY_${BROKER_SUFFIX}
                  key: latest
            - name: FYERS_APP_ID
              valueFrom:
                secretKeyRef:
                  name: FYERS_APP_ID_${BROKER_SUFFIX}
                  key: latest
            - name: FYERS_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: FYERS_SECRET_KEY_${BROKER_SUFFIX}
                  key: latest
            - name: GCP_PROJECT_ID
              value: "${PROJECT_ID}"
            - name: GCP_STORAGE_BUCKET
              value: "${GCS_BUCKET}"
            - name: PUBSUB_ENV
              value: "${PUBSUB_ENV}"
            - name: CLOUD_RUN_URL
              value: "${CLOUD_RUN_URL}"
            - name: DD_API_KEY
              valueFrom:
                secretKeyRef:
                  name: DD_API_KEY_${BROKER_SUFFIX}
                  key: latest
          resources:
            limits:
              memory: ${MEMORY}
              cpu: "${CPU}"
        - name: datadog-agent
          image: gcr.io/datadoghq/serverless-init:latest
          env:
            - name: DD_SITE
              value: us5.datadoghq.com
            - name: DD_ENV
              value: ${DD_ENV}
            - name: DD_SERVICE
              value: stockbook-workers
            - name: DD_APM_ENABLED
              value: "true"
            - name: DD_HEALTH_PORT
              value: "5555"
            - name: DD_VERSION
              value: "${COMMIT_SHA}"
            - name: DD_API_KEY
              valueFrom:
                secretKeyRef:
                  name: DD_API_KEY_${BROKER_SUFFIX}
                  key: latest
          startupProbe:
            tcpSocket:
              port: 5555
            periodSeconds: 10
            failureThreshold: 5
          resources:
            limits:
              memory: 256Mi
              cpu: "0.5"
EOF

gcloud run services replace /tmp/stockbook-workers-service.yaml --region=${REGION}
rm -f /tmp/stockbook-workers-service.yaml

echo -e "${GREEN}Service deployed${NC}"

# ============================================
# Done
# ============================================

SERVICE_URL=$(gcloud run services describe $SERVICE_NAME \
    --region=$REGION --format='value(status.url)')

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  Deployment Complete!                      ║"
echo "╚════════════════════════════════════════════╝"
echo ""
echo "Cloud Run Service: $SERVICE_NAME"
echo "URL: $SERVICE_URL"
echo ""
echo ""
echo "NOTE: This script only deploys the workers service."
echo "For full infra setup (db + pubsub + scheduler + deploy), use:"
echo "  ./scripts/setup-infra.sh ${ENV}"
echo ""
