# UseMoney - Setup & Deployment Guide

Complete guide for setting up, configuring, and deploying the UseMoney monorepo
across all environments.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Development Setup](#local-development-setup)
- [Monorepo Architecture](#monorepo-architecture)
- [Third-Party Service Setup](#third-party-service-setup)
- [Environment Variables Reference](#environment-variables-reference)
- [Database Setup](#database-setup)
- [Deploying Web Apps (Vercel)](#deploying-web-apps-vercel)
- [Deploying API Server (GCP Cloud Run)](#deploying-api-server-gcp-cloud-run)
- [Deploying Workers (GCP Cloud Run Jobs)](#deploying-workers-gcp-cloud-run-jobs)
- [DNS & Domain Configuration](#dns--domain-configuration)
- [Post-Deployment Checklist](#post-deployment-checklist)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Tool       | Version | Purpose                         |
| ---------- | ------- | ------------------------------- |
| Node.js    | >= 18   | Runtime                         |
| Yarn       | 1.22.x  | Package manager                 |
| Docker     | Latest  | Container builds (API, Workers) |
| gcloud CLI | Latest  | GCP deployments                 |
| gh CLI     | Latest  | GitHub operations (optional)    |

---

## Local Development Setup

### 1. Clone and Install

```bash
git clone https://github.com/dis-digital/usemoney-monorepo.git
cd usemoney-monorepo
yarn install
```

### 2. Environment Files

Copy the example env files and fill in values:

```bash
# Web app (main)
cp apps/web/.env.example apps/web/.env

# API server
cp apps/api/.env.example apps/api/.env.local

# Admin dashboard
cp apps/admin/.env.example apps/admin/.env

# Content CMS
cp apps/content/.env.example apps/content/.env.local

# Workers
cp workers/.env.example workers/.env.local
```

See [Environment Variables Reference](#environment-variables-reference) for
details on each variable.

### 3. Generate Prisma Client

```bash
yarn db:generate
```

### 4. Push Database Schema (first-time only)

```bash
yarn db:push
```

### 5. Start Development

```bash
# All apps simultaneously
yarn dev

# Or individual apps
yarn workspace @usemoney/web dev          # http://localhost:3000
yarn workspace @usemoney/admin dev        # http://localhost:3001
yarn workspace @usemoney/content dev      # http://localhost:3002
yarn workspace @usemoney/api-server dev   # http://localhost:8080

# Workers (Hono HTTP server)
yarn workspace @usemoney/workers dev      # http://localhost:8080
```

### 6. Other Commands

```bash
yarn build          # Build all packages and apps
yarn test           # Run all tests
yarn lint           # Lint all packages
yarn check-types    # Type-check all packages
yarn db:studio      # Open Prisma Studio
yarn full-clean     # Remove all node_modules and dist folders
```

---

## Monorepo Architecture

### Deployable Units

| Unit       | Package Name           | Platform      | Port | URL (Production)            |
| ---------- | ---------------------- | ------------- | ---- | --------------------------- |
| Web        | `@usemoney/web`        | Vercel        | 3000 | https://usemoney.ai         |
| Admin      | `@usemoney/admin`      | Vercel        | 3001 | https://admin.usemoney.ai   |
| Content    | `@usemoney/content`    | Vercel        | 3002 | https://content.usemoney.ai |
| API Server | `@usemoney/api-server` | GCP Cloud Run | 8080 | https://api.usemoney.ai     |
| Workers    | `@usemoney/workers`    | GCP Cloud Run | 8080 | N/A (Pub/Sub push endpoint) |

### Shared Packages

| Package                | Purpose                                |
| ---------------------- | -------------------------------------- |
| `@usemoney/core`       | Business logic (brokers, pairing, etc) |
| `@usemoney/database`   | Prisma schema & client                 |
| `@usemoney/types`      | Shared TypeScript types                |
| `@usemoney/cache`      | Redis caching utilities                |
| `@usemoney/security`   | Encryption, token management           |
| `@usemoney/auth`       | Authentication utilities               |
| `@usemoney/storage`    | GCS storage client                     |
| `@usemoney/email`      | Resend email client & templates        |
| `@usemoney/logger`     | Structured logging                     |
| `@usemoney/validation` | Zod schemas                            |
| `@usemoney/ui`         | Shared UI components                   |
| `@usemoney/trpc`       | tRPC router definitions                |
| `@usemoney/api-utils`  | Shared API utilities                   |

---

## Third-Party Service Setup

### 1. MongoDB Atlas

1. Create a cluster at https://cloud.mongodb.com
2. Create three databases: `stockbook_local`, `stockbook_qa`, `stockbook_prod`
3. Create a database user with readWrite access
4. Whitelist IPs (or allow `0.0.0.0/0` for serverless)
5. Copy the connection string as `DATABASE_URL`

### 2. Redis (DigitalOcean Managed Redis)

1. Create a Redis database at https://cloud.digitalocean.com/databases
2. Create separate databases for QA and production
3. Use the connection string from Connection Details (starts with `rediss://`)
4. Copy the connection string as `REDIS_URL`
5. Redis is used for **application caching only** (job queuing uses Cloud
   Pub/Sub)

### 3. Clerk (Authentication)

1. Create an application at https://dashboard.clerk.com
2. Configure sign-in methods (Google, Email)
3. Copy `Publishable Key` → `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
4. Copy `Secret Key` → `CLERK_SECRET_KEY`
5. Set up webhook:
   - Endpoint: `https://usemoney.ai/api/webhooks/clerk`
   - Events: `user.created`, `user.updated`, `user.deleted`
   - Copy signing secret → `CLERK_WEBHOOK_SECRET`
6. For admin access, set user public metadata:
   ```json
   { "role": "admin" }
   ```

### 4. Resend (Email)

1. Create an account at https://resend.com
2. Verify domain `usemoney.ai` (add DNS records - see
   [DNS Configuration](#dns--domain-configuration))
3. Create API key → `RESEND_API_KEY`
4. Generate HMAC secret: `openssl rand -hex 32` → `EMAIL_UNSUBSCRIBE_SECRET`

### 5. Dodo Payments

1. Register at https://dodopayments.com
2. Create test and live API keys → `DODO_PAYMENTS_API_KEY`
3. Set up webhook:
   - Endpoint: `https://usemoney.ai/api/webhooks/dodo`
   - Copy signing secret → `DODO_WEBHOOK_SECRET`
4. Create a brand → `DODO_BRAND_ID`

### 6. Google Cloud Platform (GCP)

**Project:** `stock-book-483718` | **Region:** `asia-south1`

#### Step 1: Enable Required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  containerregistry.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  pubsub.googleapis.com \
  cloudscheduler.googleapis.com \
  aiplatform.googleapis.com \
  storage.googleapis.com
```

| API                                | Purpose                                        |
| ---------------------------------- | ---------------------------------------------- |
| `run.googleapis.com`               | Cloud Run (API server + Workers deployment)    |
| `cloudbuild.googleapis.com`        | Cloud Build (CI/CD pipelines)                  |
| `containerregistry.googleapis.com` | Container Registry (Docker images via GCR)     |
| `artifactregistry.googleapis.com`  | Artifact Registry (alternative image store)    |
| `secretmanager.googleapis.com`     | Secret Manager (inject secrets into Cloud Run) |
| `pubsub.googleapis.com`            | Cloud Pub/Sub (job queue for workers)          |
| `cloudscheduler.googleapis.com`    | Cloud Scheduler (cron-triggered Pub/Sub)       |
| `aiplatform.googleapis.com`        | Vertex AI (Gemini AI chat)                     |
| `storage.googleapis.com`           | Cloud Storage (GCS learning content)           |

#### Step 2: Service Accounts & IAM Roles

There are 4 service accounts. Below is the exact purpose and IAM roles each one
needs:

---

**SA 1: `vertex-express@stock-book-483718.iam.gserviceaccount.com`**

|             |                                                                        |
| ----------- | ---------------------------------------------------------------------- |
| **Name**    | Vertex AI Express                                                      |
| **Type**    | GCP-managed (auto-created when Vertex AI Express is enabled)           |
| **Used by** | Google internally for Vertex AI Express features                       |
| **Action**  | No manual role assignment needed - GCP manages this automatically      |
| **Note**    | Can be left as-is. Do not delete unless you disable Vertex AI Express. |

---

**SA 2: `790437168332-compute@developer.gserviceaccount.com`**

|             |                                                                                |
| ----------- | ------------------------------------------------------------------------------ |
| **Name**    | Compute Engine default service account                                         |
| **Type**    | GCP-managed (auto-created with the project)                                    |
| **Used by** | Cloud Build pipelines (builds Docker images, pushes to GCR, deploys Cloud Run) |

**Project-level IAM roles:**

| Role                        | Role ID                           | Why                                                                               |
| --------------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| Cloud Build Service Account | `roles/cloudbuild.builds.builder` | Run Cloud Build steps (auto-granted)                                              |
| Cloud Run Admin             | `roles/run.admin`                 | Deploy and manage Cloud Run services                                              |
| Service Account User        | `roles/iam.serviceAccountUser`    | Act as `stockbook-api@...` when deploying Cloud Run with `--service-account` flag |
| Storage Admin               | `roles/storage.admin`             | Push/pull Docker images to GCR (GCR uses GCS buckets internally)                  |
| Logs Writer                 | `roles/logging.logWriter`         | Write build logs (auto-granted)                                                   |

```bash
SA_COMPUTE="790437168332-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding stock-book-483718 \
  --member="serviceAccount:$SA_COMPUTE" \
  --role="roles/run.admin" --condition=None --quiet

gcloud projects add-iam-policy-binding stock-book-483718 \
  --member="serviceAccount:$SA_COMPUTE" \
  --role="roles/iam.serviceAccountUser" --condition=None --quiet

gcloud projects add-iam-policy-binding stock-book-483718 \
  --member="serviceAccount:$SA_COMPUTE" \
  --role="roles/storage.admin" --condition=None --quiet
```

---

**SA 3: `gemini-stockbook-qa@stock-book-483718.iam.gserviceaccount.com`**

|             |                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------- |
| **Name**    | gemini-stockbook-qa                                                                           |
| **Type**    | User-created                                                                                  |
| **Used by** | Web app + Content CMS on Vercel (QA/Preview deployments) via `GCP_SERVICE_ACCOUNT_KEY_BASE64` |
| **Key**     | JSON key downloaded and base64-encoded for Vercel env vars                                    |

**Project-level IAM roles:**

| Role                 | Role ID                     | Why                                                                             |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------- |
| Vertex AI User       | `roles/aiplatform.user`     | Gemini AI chat - create predictions and use Vertex AI models                    |
| Storage Object Admin | `roles/storage.objectAdmin` | GCS learning content - upload, read, delete, list objects in buckets            |
| Pub/Sub Publisher    | `roles/pubsub.publisher`    | Publish job messages (trade-pairing, csv-import, broker-sync) to Pub/Sub topics |

```bash
SA_QA="gemini-stockbook-qa@stock-book-483718.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding stock-book-483718 \
  --member="serviceAccount:$SA_QA" \
  --role="roles/aiplatform.user" --condition=None --quiet

gcloud projects add-iam-policy-binding stock-book-483718 \
  --member="serviceAccount:$SA_QA" \
  --role="roles/storage.objectAdmin" --condition=None --quiet

gcloud projects add-iam-policy-binding stock-book-483718 \
  --member="serviceAccount:$SA_QA" \
  --role="roles/pubsub.publisher" --condition=None --quiet
```

> **Why `storage.objectAdmin` instead of `storage.admin`?** `objectAdmin` allows
> create/read/update/delete of objects within buckets but not bucket
> creation/deletion. Follows least-privilege principle.

---

**SA 4: `stockbook-api@stock-book-483718.iam.gserviceaccount.com`**

|             |                                                                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**    | UseMoney API                                                                                                                                                                                        |
| **Type**    | User-created                                                                                                                                                                                        |
| **Used by** | Cloud Run services (API server + Workers) via `--service-account` flag; Web app + Content CMS on Vercel (Production) via `GCP_SERVICE_ACCOUNT_KEY_BASE64`; Pub/Sub push subscription authentication |
| **Key**     | JSON key downloaded and base64-encoded for Vercel production env vars                                                                                                                               |

**Project-level IAM roles:**

| Role                           | Role ID                              | Why                                                                              |
| ------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------- |
| Secret Manager Secret Accessor | `roles/secretmanager.secretAccessor` | Read secrets (DATABASE_URL, REDIS_URL, CLERK_SECRET_KEY) injected into Cloud Run |
| Pub/Sub Publisher              | `roles/pubsub.publisher`             | Publish job messages from web app to Pub/Sub topics                              |
| Vertex AI User                 | `roles/aiplatform.user`              | Gemini AI chat - create predictions and use Vertex AI models                     |
| Storage Object Admin           | `roles/storage.objectAdmin`          | GCS learning content - upload, read, delete, list objects in buckets             |

**Service-level IAM roles (applied per Cloud Run service, not project-wide):**

| Role              | Role ID             | Applied To               | Why                                                               |
| ----------------- | ------------------- | ------------------------ | ----------------------------------------------------------------- |
| Cloud Run Invoker | `roles/run.invoker` | `stockbook-workers-qa`   | Allows Pub/Sub push subscriptions to invoke QA worker endpoints   |
| Cloud Run Invoker | `roles/run.invoker` | `stockbook-workers-prod` | Allows Pub/Sub push subscriptions to invoke Prod worker endpoints |

**SA-level IAM binding (on the `stockbook-api` SA itself):**

| Granted To                                                     | Role                                   | Why                                                                                                |
| -------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `service-PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com` | `roles/iam.serviceAccountTokenCreator` | Allows Pub/Sub service agent to create OIDC tokens as this SA for push subscription authentication |

```bash
SA_API="stockbook-api@stock-book-483718.iam.gserviceaccount.com"

# Project-level roles
gcloud projects add-iam-policy-binding stock-book-483718 \
  --member="serviceAccount:$SA_API" \
  --role="roles/secretmanager.secretAccessor" --condition=None --quiet

gcloud projects add-iam-policy-binding stock-book-483718 \
  --member="serviceAccount:$SA_API" \
  --role="roles/pubsub.publisher" --condition=None --quiet

gcloud projects add-iam-policy-binding stock-book-483718 \
  --member="serviceAccount:$SA_API" \
  --role="roles/aiplatform.user" --condition=None --quiet

gcloud projects add-iam-policy-binding stock-book-483718 \
  --member="serviceAccount:$SA_API" \
  --role="roles/storage.objectAdmin" --condition=None --quiet

# Service-level: allow Pub/Sub to invoke Cloud Run workers
gcloud run services add-iam-policy-binding stockbook-workers-qa \
  --region=asia-south1 \
  --member="serviceAccount:$SA_API" \
  --role="roles/run.invoker" --quiet

gcloud run services add-iam-policy-binding stockbook-workers-prod \
  --region=asia-south1 \
  --member="serviceAccount:$SA_API" \
  --role="roles/run.invoker" --quiet

# SA-level: allow Pub/Sub service agent to create OIDC tokens as this SA
PROJECT_NUMBER=$(gcloud projects describe stock-book-483718 --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding $SA_API \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator" --quiet
```

---

#### Summary: Which SA Uses What

| GCP Service         | `vertex-express` |      `compute-default`      | `gemini-stockbook-qa` |        `stockbook-api`         |
| ------------------- | :--------------: | :-------------------------: | :-------------------: | :----------------------------: |
| Vertex AI (Gemini)  |   GCP-managed    |              -              |   `aiplatform.user`   |       `aiplatform.user`        |
| Cloud Storage (GCS) |        -         |    `storage.admin` (GCR)    | `storage.objectAdmin` |     `storage.objectAdmin`      |
| Cloud Pub/Sub       |        -         |              -              |  `pubsub.publisher`   |       `pubsub.publisher`       |
| Secret Manager      |        -         |              -              |           -           | `secretmanager.secretAccessor` |
| Cloud Run           |        -         |         `run.admin`         |           -           |  `run.invoker` (per-service)   |
| Cloud Build         |        -         | `cloudbuild.builds.builder` |           -           |               -                |
| IAM                 |        -         |  `iam.serviceAccountUser`   |           -           |               -                |

#### Step 3: Download Service Account Keys

```bash
# QA key (for Vercel Preview/QA deployments)
gcloud iam service-accounts keys create qa-key.json \
  --iam-account=gemini-stockbook-qa@stock-book-483718.iam.gserviceaccount.com
cat qa-key.json | base64  # → GCP_SERVICE_ACCOUNT_KEY_BASE64 in Vercel (Preview)

# Production key (for Vercel Production deployments)
gcloud iam service-accounts keys create prod-key.json \
  --iam-account=stockbook-api@stock-book-483718.iam.gserviceaccount.com
cat prod-key.json | base64  # → GCP_SERVICE_ACCOUNT_KEY_BASE64 in Vercel (Production)

# For local development, use the key file directly:
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/qa-key.json
```

> **Cloud Run services** use the `--service-account` flag during deployment - no
> key file needed.

#### Step 4: Create GCS Bucket

```bash
gsutil mb -l asia-south1 gs://stockbook-learning-content
```

Set `GCP_STORAGE_BUCKET=stockbook-learning-content` in environment variables.

#### Step 5: Run Setup Scripts

```bash
# Worker GCP setup (APIs, SA, secrets)
cd workers && ./scripts/setup-gcp.sh

# After deploying workers, setup Pub/Sub topics and subscriptions
cd workers && ./scripts/setup-pubsub.sh qa
```

### 7. PostHog (Analytics - Optional)

1. Create project at https://posthog.com
2. Copy Project API Key → `NEXT_PUBLIC_POSTHOG_KEY`
3. Host is `https://app.posthog.com` by default

### 8. Broker APIs (Optional - per broker)

Each broker requires developer registration. OAuth redirect URI pattern:
`https://usemoney.ai/api/brokers/{broker}/callback`

| Broker    | Portal                            | Keys Needed         |
| --------- | --------------------------------- | ------------------- |
| Zerodha   | https://kite.trade/connect        | API Key, API Secret |
| Upstox    | https://developer.upstox.com      | API Key, API Secret |
| Angel One | https://smartapi.angelbroking.com | API Key             |
| Dhan      | https://dhanhq.co/docs            | Client ID, API Key  |
| Fyers     | https://myapi.fyers.in            | App ID, Secret Key  |
| Groww     | Partner API                       | API Key, API Secret |

---

## Environment Variables Reference

### Web App (`apps/web/.env`)

See `apps/web/.env.example` for the full annotated list. Key categories:

| Category     | Variables                                                                       | Required            |
| ------------ | ------------------------------------------------------------------------------- | ------------------- |
| Database     | `DATABASE_URL`                                                                  | Yes                 |
| Auth (Clerk) | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` | Yes                 |
| Redis        | `REDIS_URL`                                                                     | Recommended         |
| Encryption   | `ENCRYPTION_KEY` (64-char hex)                                                  | Yes (brokers)       |
| GCP          | `GCP_PROJECT_ID`, `GCP_LOCATION`, `GCP_STORAGE_BUCKET`, credentials             | Yes (AI/storage)    |
| AI           | `USE_GEMINI`, `GEMINI_MAX_RETRIES`, `GEMINI_TIMEOUT_MS`                         | No                  |
| Payments     | `DODO_PAYMENTS_API_KEY`, `DODO_WEBHOOK_SECRET`, `DODO_BRAND_ID`                 | Yes (subscriptions) |
| Email        | `RESEND_API_KEY`, `EMAIL_UNSUBSCRIBE_SECRET`                                    | Yes (email)         |
| Brokers      | Per-broker API keys (see .env.example)                                          | No                  |
| Analytics    | `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`                           | No                  |
| URLs         | `NEXT_PUBLIC_BASE_URL`, `NEXT_PUBLIC_APP_URL`                                   | Yes                 |
| Cron         | `CRON_SECRET`                                                                   | Yes (Dodo sync)     |

### API Server (`apps/api/.env.local`)

| Variable                  | Description                       | Required |
| ------------------------- | --------------------------------- | -------- |
| `NODE_ENV`                | `local` / `qa` / `production`     | Yes      |
| `PORT`                    | Server port (default: 8080)       | No       |
| `DATABASE_URL`            | MongoDB connection string         | Yes      |
| `REDIS_URL`               | Redis connection string           | Yes      |
| `CLERK_SECRET_KEY`        | Clerk secret for JWT verification | Yes      |
| `WEB_URL`                 | Web app URL (CORS)                | Yes      |
| `ADMIN_URL`               | Admin app URL (CORS)              | Yes      |
| `GCP_PROJECT_ID`          | GCP project                       | No       |
| `GCP_REGION`              | GCP region (asia-south1)          | No       |
| `RATE_LIMIT_WINDOW_MS`    | Rate limit window (default: 60s)  | No       |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window (100)     | No       |
| `LOG_LEVEL`               | debug / info / warn / error       | No       |

### Admin App (`apps/admin/.env`)

See `apps/admin/.env.example` for the template.

| Variable                            | Description                     | Required |
| ----------------------------------- | ------------------------------- | -------- |
| `DATABASE_URL`                      | MongoDB connection string       | Yes      |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key           | Yes      |
| `CLERK_SECRET_KEY`                  | Clerk secret key                | Yes      |
| `NEXT_PUBLIC_BASE_URL`              | App URL (http://localhost:3001) | Yes      |
| `NEXT_PUBLIC_POSTHOG_KEY`           | PostHog analytics key           | No       |
| `NEXT_PUBLIC_POSTHOG_HOST`          | PostHog host URL                | No       |

> Admin does **not** need GCP keys - it only accesses the database and Clerk.

### Content CMS (`apps/content/.env.local`)

See `apps/content/.env.example` for the template.

| Variable                            | Description                     | Required         |
| ----------------------------------- | ------------------------------- | ---------------- |
| `DATABASE_URL`                      | MongoDB connection string       | Yes              |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key           | Yes              |
| `CLERK_SECRET_KEY`                  | Clerk secret key                | Yes              |
| `NEXT_PUBLIC_APP_URL`               | App URL (http://localhost:3002) | Yes              |
| `GCP_PROJECT_ID`                    | GCP project ID                  | Yes (storage/AI) |
| `GCP_LOCATION`                      | Vertex AI region (us-central1)  | Yes (AI)         |
| `GCP_STORAGE_BUCKET`                | GCS bucket for content images   | Yes (storage)    |
| `GOOGLE_APPLICATION_CREDENTIALS`    | Path to SA key (local dev)      | Yes (local)      |
| `GCP_SERVICE_ACCOUNT_KEY_BASE64`    | Base64 SA key (Vercel)          | Yes (Vercel)     |
| `RESEND_API_KEY`                    | Resend API key for newsletter   | Yes (newsletter) |
| `EMAIL_UNSUBSCRIBE_SECRET`          | HMAC secret for unsubscribe     | Yes (newsletter) |

### Workers (`workers/.env.local`)

| Variable       | Description                       | Required |
| -------------- | --------------------------------- | -------- |
| `DATABASE_URL` | MongoDB connection string         | Yes      |
| `REDIS_URL`    | Redis connection string (caching) | Yes      |
| `PORT`         | HTTP port (default: 8080)         | No       |
| `NODE_ENV`     | `local` / `qa` / `production`     | No       |

On GCP Cloud Run, `DATABASE_URL` and `REDIS_URL` are injected as secrets from
Secret Manager (see Cloud Build configs).

---

## Database Setup

### Initial Setup

```bash
# Generate Prisma client
yarn db:generate

# Push schema to database (creates collections and indexes)
yarn db:push
```

### After Schema Changes

```bash
# Regenerate client
yarn db:generate

# Push changes to database
yarn db:push
```

### MongoDB Atlas Indexes

For production performance, ensure these indexes exist in MongoDB Atlas:

- `trades`: compound index on `userId + symbol + exchange`
- `paired_trade_views`: compound index on `userId + symbol`
- `newsletter_subscribers`: unique index on `email`
- `email_logs`: indexes on `to` and `template`

Prisma manages most indexes automatically via `@@index` directives in the
schema.

---

## Deploying Web Apps (Vercel)

All three Next.js apps (web, admin, content) deploy to Vercel.

### Setup Per App

1. **Import project** in Vercel dashboard
2. **Set root directory:**
   - Web: `apps/web`
   - Admin: `apps/admin`
   - Content: `apps/content`
3. **Framework preset:** Next.js
4. **Build command:** (auto-detected or
   `cd ../.. && yarn build --filter=@usemoney/web`)
5. **Install command:** `yarn install`
6. **Node.js version:** 18.x or 20.x

### Environment Variables

Add all required env vars for the app in Vercel's project settings under
**Settings → Environment Variables**. Set different values per environment
(Production, Preview, Development).

Key differences between environments (all apps share these):

| Variable                | Production             | QA/Preview               |
| ----------------------- | ---------------------- | ------------------------ |
| `DATABASE_URL`          | `...stockbook_prod...` | `...stockbook_qa...`     |
| `NEXT_PUBLIC_BASE_URL`  | `https://usemoney.ai`  | `https://qa.usemoney.ai` |
| `NEXT_PUBLIC_APP_URL`   | `https://usemoney.ai`  | `https://qa.usemoney.ai` |
| `CLERK_SECRET_KEY`      | `sk_live_...`          | `sk_test_...`            |
| `NEXT_PUBLIC_DODO_MODE` | `live`                 | `test`                   |

### GCP Service Account Keys (Vercel)

Only `apps/web` and `apps/content` need GCP keys. `apps/admin` does **not**.

| Vercel App     | Environment | `GCP_SERVICE_ACCOUNT_KEY_BASE64`    | SA Used               |
| -------------- | ----------- | ----------------------------------- | --------------------- |
| `apps/web`     | Preview/QA  | base64 of `gemini-stockbook-qa` key | `gemini-stockbook-qa` |
| `apps/web`     | Production  | base64 of `stockbook-api` key       | `stockbook-api`       |
| `apps/content` | Preview/QA  | base64 of `gemini-stockbook-qa` key | `gemini-stockbook-qa` |
| `apps/content` | Production  | base64 of `stockbook-api` key       | `stockbook-api`       |
| `apps/admin`   | All         | Not needed                          | -                     |

### Domain Configuration

In Vercel project settings → Domains:

| App     | Production Domain                | QA Domain                |
| ------- | -------------------------------- | ------------------------ |
| Web     | `usemoney.ai`, `www.usemoney.ai` | `qa.usemoney.ai`         |
| Admin   | `admin.usemoney.ai`              | `admin.qa.usemoney.ai`   |
| Content | `content.usemoney.ai`            | `content.qa.usemoney.ai` |

### Deployment Triggers

- **Production:** Merges to `main` branch
- **Preview/QA:** Every push to any branch or PR

---

## Deploying API Server & Workers (GCP Cloud Run)

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Vercel                                                       │
│  ├── apps/web      → usemoney.ai                         │
│  ├── apps/content  → content.usemoney.ai                 │
│  └── apps/admin    → admin.usemoney.ai                   │
└──────────────┬───────────────────────────────────────────────┘
               │ Pub/Sub.publish()
               ▼
┌──────────────────────────────────────────────────────────────┐
│  Google Cloud Pub/Sub                                         │
│  Topics: trade-pairing | csv-import | broker-sync            │
└──────────────┬───────────────────────────────────────────────┘
               │ Push subscription (OIDC auth)
               ▼
┌──────────────────────────────────────────────────────────────┐
│  GCP Cloud Run                                                │
│  ├── stockbook-api-{qa|prod}      → api.usemoney.ai      │
│  │   └── REST API for mobile app                             │
│  └── stockbook-workers-{qa|prod}  → Pub/Sub push endpoints   │
│      ├── POST /jobs/trade-pairing                            │
│      ├── POST /jobs/csv-import                               │
│      └── POST /jobs/broker-sync                              │
└──────────────────────────────────────────────────────────────┘
```

### Complete Setup (Step-by-Step)

Follow these steps in order. All commands run from the **monorepo root** unless
stated otherwise.

---

#### Step 1: Authenticate and Set Project

```bash
gcloud auth login
gcloud config set project stock-book-483718
```

---

#### Step 2: Enable Required APIs

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com containerregistry.googleapis.com secretmanager.googleapis.com pubsub.googleapis.com cloudscheduler.googleapis.com aiplatform.googleapis.com
```

---

#### Step 3: Grant IAM Roles to Service Accounts

See [Service Accounts & IAM Roles](#step-2-service-accounts--iam-roles) for the
full breakdown. Quick version:

**Compute Engine SA (used by Cloud Build):**

```bash
gcloud projects add-iam-policy-binding stock-book-483718 --member="serviceAccount:790437168332-compute@developer.gserviceaccount.com" --role="roles/run.admin" --condition=None --quiet
gcloud projects add-iam-policy-binding stock-book-483718 --member="serviceAccount:790437168332-compute@developer.gserviceaccount.com" --role="roles/iam.serviceAccountUser" --condition=None --quiet
gcloud projects add-iam-policy-binding stock-book-483718 --member="serviceAccount:790437168332-compute@developer.gserviceaccount.com" --role="roles/storage.admin" --condition=None --quiet
```

**UseMoney API SA (used by Cloud Run services):**

```bash
gcloud projects add-iam-policy-binding stock-book-483718 --member="serviceAccount:stockbook-api@stock-book-483718.iam.gserviceaccount.com" --role="roles/secretmanager.secretAccessor" --condition=None --quiet
gcloud projects add-iam-policy-binding stock-book-483718 --member="serviceAccount:stockbook-api@stock-book-483718.iam.gserviceaccount.com" --role="roles/pubsub.publisher" --condition=None --quiet
gcloud projects add-iam-policy-binding stock-book-483718 --member="serviceAccount:stockbook-api@stock-book-483718.iam.gserviceaccount.com" --role="roles/aiplatform.user" --condition=None --quiet
gcloud projects add-iam-policy-binding stock-book-483718 --member="serviceAccount:stockbook-api@stock-book-483718.iam.gserviceaccount.com" --role="roles/storage.objectAdmin" --condition=None --quiet
```

---

#### Step 4: Create Secrets in Secret Manager

```bash
# Check if secrets already exist
gcloud secrets list

# Create QA secrets (replace with actual values)
echo -n 'mongodb+srv://USER:PASS@cluster.mongodb.net/stockbook_qa' | gcloud secrets create DATABASE_URL_QA --data-file=- --replication-policy="automatic"
echo -n 'rediss://default:PASS@host:25061' | gcloud secrets create REDIS_URL_QA --data-file=- --replication-policy="automatic"
echo -n 'sk_test_...' | gcloud secrets create CLERK_SECRET_KEY_QA --data-file=- --replication-policy="automatic"

# Create Production secrets (replace with actual values)
echo -n 'mongodb+srv://USER:PASS@cluster.mongodb.net/stockbook_prod' | gcloud secrets create DATABASE_URL_PROD --data-file=- --replication-policy="automatic"
echo -n 'rediss://default:PASS@host:25061' | gcloud secrets create REDIS_URL_PROD --data-file=- --replication-policy="automatic"
echo -n 'sk_live_...' | gcloud secrets create CLERK_SECRET_KEY_PROD --data-file=- --replication-policy="automatic"
```

To update an existing secret value:

```bash
echo -n 'new-value' | gcloud secrets versions add DATABASE_URL_QA --data-file=-
```

Grant the `stockbook-api` SA access to all secrets:

```bash
for secret in DATABASE_URL_QA REDIS_URL_QA CLERK_SECRET_KEY_QA DATABASE_URL_PROD REDIS_URL_PROD CLERK_SECRET_KEY_PROD; do
  gcloud secrets add-iam-policy-binding $secret --member="serviceAccount:stockbook-api@stock-book-483718.iam.gserviceaccount.com" --role="roles/secretmanager.secretAccessor" --quiet
done
```

---

#### Step 5: Deploy Workers (QA)

**Option A - Cloud Build (recommended, no Docker needed locally):**

```bash
gcloud builds submit --config=workers/cloudbuild.qa.yaml .
```

**Option B - Manual deploy (requires Docker):**

```bash
cd workers && ./scripts/deploy.sh qa
```

Verify the deployment:

```bash
gcloud run services describe stockbook-workers-qa --region=asia-south1 --format="value(status.url)"
```

---

#### Step 6: Setup Pub/Sub Topics and Subscriptions

Run **after** workers are deployed (needs the Cloud Run service URL):

```bash
cd workers && ./scripts/setup-pubsub.sh qa
```

This creates:

| Resource     | Name                    | Purpose                                   |
| ------------ | ----------------------- | ----------------------------------------- |
| Topic        | `trade-pairing`         | FIFO trade pairing jobs                   |
| Topic        | `csv-import`            | CSV/XLS trade import jobs                 |
| Topic        | `broker-sync`           | Broker data sync jobs                     |
| Topic        | `dead-letter`           | Failed message storage                    |
| Subscription | `trade-pairing-push-qa` | Push to `{worker-url}/jobs/trade-pairing` |
| Subscription | `csv-import-push-qa`    | Push to `{worker-url}/jobs/csv-import`    |
| Subscription | `broker-sync-push-qa`   | Push to `{worker-url}/jobs/broker-sync`   |

It also grants:

| Permission                                             | Why                                          |
| ------------------------------------------------------ | -------------------------------------------- |
| `pubsub.publisher` on project                          | Web app can publish job messages             |
| `iam.serviceAccountTokenCreator` on `stockbook-api` SA | Pub/Sub can create OIDC tokens for push auth |
| `run.invoker` on worker service                        | Pub/Sub can call the Cloud Run endpoints     |

Verify topics and subscriptions:

```bash
gcloud pubsub topics list
gcloud pubsub subscriptions list
```

---

#### Step 7: Deploy API Server (QA)

**Option A - Cloud Build (recommended):**

```bash
gcloud builds submit --config=apps/api/cloudbuild.qa.yaml .
```

**Option B - Manual deploy (requires Docker):**

```bash
# Build from monorepo root
docker build -t gcr.io/stock-book-483718/stockbook-api:qa-latest -f apps/api/Dockerfile .
docker push gcr.io/stock-book-483718/stockbook-api:qa-latest

# Deploy
gcloud run deploy stockbook-api-qa --image=gcr.io/stock-book-483718/stockbook-api:qa-latest --region=asia-south1 --platform=managed --allow-unauthenticated --port=8080 --memory=512Mi --cpu=1 --min-instances=0 --max-instances=5 --timeout=300 --concurrency=80 --set-env-vars="NODE_ENV=qa,WEB_URL=https://qa.usemoney.ai,ADMIN_URL=https://admin.qa.usemoney.ai" --set-secrets="DATABASE_URL=DATABASE_URL_QA:latest,REDIS_URL=REDIS_URL_QA:latest,CLERK_SECRET_KEY=CLERK_SECRET_KEY_QA:latest"
```

Verify:

```bash
# Get service URL
gcloud run services describe stockbook-api-qa --region=asia-south1 --format="value(status.url)"

# Test health endpoint
curl $(gcloud run services describe stockbook-api-qa --region=asia-south1 --format="value(status.url)")/health
```

---

#### Step 8: Custom Domain Mapping (once per service)

```bash
# API QA
gcloud run domain-mappings create --service=stockbook-api-qa --domain=api.qa.usemoney.ai --region=asia-south1

# API Production (after prod deploy)
gcloud run domain-mappings create --service=stockbook-api-prod --domain=api.usemoney.ai --region=asia-south1
```

Then add DNS records (see [DNS Configuration](#dns--domain-configuration)):

```
api.qa.usemoney.ai  → CNAME → ghs.googlehosted.com
api.usemoney.ai     → CNAME → ghs.googlehosted.com
```

---

#### Step 9: Deploy Production

Repeat steps 5-7 with `prod`:

```bash
# Workers Production
gcloud builds submit --config=workers/cloudbuild.prod.yaml .

# Pub/Sub Production (only needed if using separate topics, otherwise QA topics are shared)
cd workers && ./scripts/setup-pubsub.sh prod

# API Production
gcloud builds submit --config=apps/api/cloudbuild.prod.yaml .
```

Verify production:

```bash
curl $(gcloud run services describe stockbook-api-prod --region=asia-south1 --format="value(status.url)")/health
curl $(gcloud run services describe stockbook-workers-prod --region=asia-south1 --format="value(status.url)")/health
```

---

### Quick Reference: All Deploy Commands

| Service     | QA                                                            | Production                                                      |
| ----------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| **Workers** | `gcloud builds submit --config=workers/cloudbuild.qa.yaml .`  | `gcloud builds submit --config=workers/cloudbuild.prod.yaml .`  |
| **API**     | `gcloud builds submit --config=apps/api/cloudbuild.qa.yaml .` | `gcloud builds submit --config=apps/api/cloudbuild.prod.yaml .` |
| **Pub/Sub** | `cd workers && ./scripts/setup-pubsub.sh qa`                  | `cd workers && ./scripts/setup-pubsub.sh prod`                  |
| **Web**     | Auto (Vercel, push to any branch)                             | Auto (Vercel, merge to `main`)                                  |
| **Content** | Auto (Vercel, push to any branch)                             | Auto (Vercel, merge to `main`)                                  |
| **Admin**   | Auto (Vercel, push to any branch)                             | Auto (Vercel, merge to `main`)                                  |

---

### Auto CI/CD with Cloud Build Triggers (Optional)

Set up in **GCP Console → Cloud Build → Triggers** after connecting your GitHub
repo:

| Trigger Name             | Branch Pattern           | Config File                     |
| ------------------------ | ------------------------ | ------------------------------- |
| `stockbook-api-qa`       | `^develop$` or `^qa/.*$` | `apps/api/cloudbuild.qa.yaml`   |
| `stockbook-api-prod`     | `^main$`                 | `apps/api/cloudbuild.prod.yaml` |
| `stockbook-workers-qa`   | `^develop$` or `^qa/.*$` | `workers/cloudbuild.qa.yaml`    |
| `stockbook-workers-prod` | `^main$`                 | `workers/cloudbuild.prod.yaml`  |

---

### Cloud Run Service Specs

| Service                  | Environment | Memory | CPU | Min/Max Instances | Concurrency | Timeout |
| ------------------------ | ----------- | ------ | --- | ----------------- | ----------- | ------- |
| `stockbook-api-qa`       | QA          | 512Mi  | 1   | 0/5               | 80          | 300s    |
| `stockbook-api-prod`     | Prod        | 1Gi    | 2   | 1/20              | 100         | 300s    |
| `stockbook-workers-qa`   | QA          | 1Gi    | 1   | 0/5               | 10          | 600s    |
| `stockbook-workers-prod` | Prod        | 1Gi    | 2   | 1/20              | 10          | 600s    |

> Workers use low concurrency (10) because each job is CPU-intensive. API uses
> higher concurrency for parallel HTTP requests.

---

### Viewing Logs

```bash
# API logs
gcloud run services logs read stockbook-api-qa --region=asia-south1 --limit=50

# Worker logs
gcloud run services logs read stockbook-workers-qa --region=asia-south1 --limit=50

# Or use Cloud Console: https://console.cloud.google.com/run?project=stock-book-483718
```

---

### Test Locally

```bash
# Start the worker service
cd workers && yarn dev

# Send a test Pub/Sub message (base64 of {"jobId":"test","userId":"u1"})
curl -X POST http://localhost:8080/jobs/trade-pairing \
  -H "Content-Type: application/json" \
  -d '{"message":{"data":"eyJqb2JJZCI6InRlc3QiLCJ1c2VySWQiOiJ1MSJ9","messageId":"123","publishTime":"2026-01-30T00:00:00Z"},"subscription":"test"}'

# Start the API server
cd apps/api && yarn dev

# Test API health
curl http://localhost:8080/health
```

### Docker Compose (Local Development)

```bash
# Start all services (redis, api, workers)
docker compose up
```

---

## DNS & Domain Configuration

### Vercel DNS (for web apps)

Add these records at your domain registrar:

| Type  | Name     | Value                  | Purpose       |
| ----- | -------- | ---------------------- | ------------- |
| A     | @        | `76.76.21.21`          | Web app       |
| CNAME | www      | `cname.vercel-dns.com` | Web app (www) |
| CNAME | admin    | `cname.vercel-dns.com` | Admin app     |
| CNAME | content  | `cname.vercel-dns.com` | Content CMS   |
| CNAME | qa       | `cname.vercel-dns.com` | QA web        |
| CNAME | admin.qa | `cname.vercel-dns.com` | QA admin      |

### GCP DNS (for API server)

After running `gcloud run domain-mappings create`, add the records provided:

| Type  | Name   | Value                  | Purpose    |
| ----- | ------ | ---------------------- | ---------- |
| CNAME | api    | `ghs.googlehosted.com` | API server |
| CNAME | api.qa | `ghs.googlehosted.com` | QA API     |

### Resend DNS (for email)

Add these records to verify `usemoney.ai` for email sending:

| Type  | Name                 | Value                   | Purpose     |
| ----- | -------------------- | ----------------------- | ----------- |
| TXT   | `resend._domainkey`  | (from Resend dashboard) | DKIM        |
| TXT   | @                    | `v=spf1 include:...`    | SPF         |
| CNAME | `em####.usemoney.ai` | (from Resend dashboard) | Return path |

Check verification status in Resend dashboard → Domains.

---

## Post-Deployment Checklist

### After Every Deployment

- [ ] Verify health endpoints respond:
  - Web: `https://usemoney.ai`
  - Content: `https://content.usemoney.ai`
  - Admin: `https://admin.usemoney.ai`
  - API: `https://api.usemoney.ai/health`
  - Workers: check Cloud Run logs
- [ ] Check database connectivity (API detailed health: `/health/detailed`)
- [ ] Verify Clerk sign-in works on all apps
- [ ] Check Redis connectivity (via API health)

### First Deployment

- [ ] All environment variables set in Vercel and GCP
- [ ] GCP secrets created in Secret Manager
- [ ] MongoDB Atlas IP whitelist configured
- [ ] `yarn db:push` run against production database
- [ ] Clerk webhook endpoints registered and verified
- [ ] Dodo webhook endpoints registered and verified
- [ ] Resend domain verified (DNS records propagated)
- [ ] GCS bucket created with correct permissions
- [ ] Custom domains configured in Vercel and GCP
- [ ] DNS records propagated (use `dig` or `nslookup` to verify)
- [ ] SSL certificates provisioned (automatic on both Vercel and GCP)
- [ ] Workers deployed as Cloud Run Service
- [ ] Pub/Sub topics and push subscriptions created (`setup-pubsub.sh`)
- [ ] PostHog project created (if using analytics)

### Email-Specific (New)

- [ ] `RESEND_API_KEY` set in Vercel (web app) and content app
- [ ] `EMAIL_UNSUBSCRIBE_SECRET` set in Vercel (web app) and content app
- [ ] Resend domain verification complete (DKIM, SPF records)
- [ ] Test newsletter subscribe flow end-to-end
- [ ] Test transactional email delivery (create a test user via Clerk)

### Security Checklist

- [ ] `ENCRYPTION_KEY` is unique per environment (64-char hex)
- [ ] Clerk secret keys differ between test and live
- [ ] `CRON_SECRET` set for authenticated cron endpoints
- [ ] No secrets committed to git (check `.gitignore`)
- [ ] GCP `gemini-stockbook-qa` key used only for Preview/QA in Vercel
- [ ] GCP `stockbook-api` key used only for Production in Vercel
- [ ] GCP service accounts have minimal required roles (see
      [Service Accounts & IAM Roles](#step-2-service-accounts--iam-roles))
- [ ] MongoDB Atlas users have minimal required permissions

---

## Troubleshooting

### `prisma db push` fails

- Ensure `DATABASE_URL` is set and the MongoDB cluster is accessible
- Check IP whitelist in MongoDB Atlas
- Run `yarn db:generate` first

### Vercel build fails

- Check build logs for missing environment variables
- Ensure `NEXT_PUBLIC_*` variables are set (they're inlined at build time)
- Run `yarn build --filter=@usemoney/web` locally to reproduce

### API server returns 503

- Check Cloud Run logs:
  `gcloud run services logs read stockbook-api --region=asia-south1`
- Verify secrets are accessible: check IAM bindings on Secret Manager
- Ensure MongoDB Atlas allows connections from GCP IP ranges

### Workers not processing jobs

- Verify Pub/Sub topics and subscriptions exist: `gcloud pubsub topics list`
- Check push subscription endpoints point to correct Cloud Run service URL
- Verify IAM: service account has `roles/run.invoker` on the Cloud Run service
- Check worker service health: `curl https://<service-url>/health`
- Check worker logs:
  `gcloud run services logs read stockbook-workers-qa --region=asia-south1`

### Emails not sending

- Verify `RESEND_API_KEY` is valid at https://resend.com/api-keys
- Check Resend domain verification status
- Ensure DNS records (SPF, DKIM) have propagated
- Check `EmailLog` collection in MongoDB for error details

### Clerk webhook not working

- Verify the webhook URL is reachable
- Check `CLERK_WEBHOOK_SECRET` matches the signing secret in Clerk dashboard
- Ensure webhook events are selected (user.created, user.updated, user.deleted)

---

_Last Updated: January 2026_
