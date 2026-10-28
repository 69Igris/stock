# Production Deployment Checklist - March 2026

Covers all changes from the last 2-week sprint: rebranding, plan system
overhaul, content platform, newsletter, Pub/Sub fixes, legal pages, and worker
refactors.

---

## Data lake (S1 / MONEY-1465) — run after the PR merges

The lake is provisioned by `scripts/ops/setup-lake.sh`, which is idempotent: every
resource is read before it is created, so a re-run is safe and reports what already
exists. The contract it implements is `docs/reference/lake-layout.md`.

```bash
# 1. QA first — already done for MONEY-1465, re-run is a no-op
./scripts/ops/setup-lake.sh qa

# 2. PROD. Dry-run first and read the plan; nothing in the lake is load-bearing
#    yet, but this creates service accounts and IAM bindings.
./scripts/ops/setup-lake.sh prod --dry-run
./scripts/ops/setup-lake.sh prod

# 3. Prove the writer can actually run a job, in the right region
npx tsx scripts/ops/lake-smoke.ts qa
npx tsx scripts/ops/lake-smoke.ts prod

# 4. Confirm what exists
bq --project_id=stock-book-483718 ls
```

### Founder step the script cannot do: the BigQuery budget

`billingbudgets.googleapis.com` was **not enabled** as of 2026-09-15, and budget
creation needs **Billing Account** permissions rather than project ones — so
`setup-lake.sh` prints the command and skips. It is listed here because a budget
nobody created is indistinguishable from a budget that never fired.

```bash
gcloud services enable billingbudgets.googleapis.com --project=stock-book-483718
gcloud billing budgets create --billing-account=01B38C-B39E04-644C3D \
  --display-name='BigQuery prod $50/mo' \
  --budget-amount=50USD --filter-services=services/24E6-581D-38E5
```

### What must stay true

- **`stockbook-api@` has no BigQuery role.** The web request path never queries
  BigQuery; serving reads Mongo, Redis or a pre-built tile.
- **No dataset has a default table expiration.** A dataset-level default silently
  attaches an expiry to every table created afterwards, and a table that vanishes
  raises no alert.
- **`billing_export` is not ours** — it is MONEY-1379's Detailed Usage Cost export.
  No lake service account is granted on it.

---

## Quick Reference: GCP Setup

The stockbook project uses gcloud configuration `stockbook` with project
`stock-book-483718`.

### Activate GCP Config & Authenticate

```bash
# Switch to stockbook gcloud configuration
gcloud config configurations activate stockbook

# Re-authenticate (if token expired)
gcloud auth login

# Verify
gcloud config list
# Should show: project = stock-book-483718, account = founder@disdigital.in
```

### Fetch DATABASE_URL from Secret Manager

```bash
# Production
DATABASE_URL_PROD=$(gcloud secrets versions access latest \
  --secret="DATABASE_URL_PROD" --project="stock-book-483718")

# QA
DATABASE_URL_QA=$(gcloud secrets versions access latest \
  --secret="DATABASE_URL_QA" --project="stock-book-483718")

# Verify (prints first 40 chars only - never log full connection string)
echo "${DATABASE_URL_PROD:0:40}..."
```

### Schema Push Using GCP Secret

```bash
# Activate stockbook config first
gcloud config configurations activate stockbook

# Push to production
DATABASE_URL=$(gcloud secrets versions access latest \
  --secret="DATABASE_URL_PROD" --project="stock-book-483718") \
  yarn workspace @usemoney/database prisma db push

# Push to QA
DATABASE_URL=$(gcloud secrets versions access latest \
  --secret="DATABASE_URL_QA" --project="stock-book-483718") \
  yarn workspace @usemoney/database prisma db push
```

### Run Migration Scripts Against Production

```bash
# Activate GCP config
gcloud config configurations activate stockbook

# Plan ID migration (AI_UNLIMITED → PREMIUM, AI_ADDON → QUERY_PACK)
DATABASE_URL=$(gcloud secrets versions access latest \
  --secret="DATABASE_URL_PROD" --project="stock-book-483718") \
  npx tsx scripts/migrations/migrate-plan-ids.ts prod

# Resend segment migration (all secrets pulled from GCP Secret Manager)
# Segments: free (never paid), paid (active sub), downgraded (previously paid), security (all)
P=stock-book-483718 && G(){ gcloud secrets versions access latest --secret="$1" --project=$P; } && \
  DATABASE_URL="$(G DATABASE_URL_PROD)" \
  RESEND_API_KEY="$(G RESEND_API_KEY_PROD)" \
  RESEND_AUDIENCE_FREE_ID="$(G RESEND_AUDIENCE_FREE_ID_PROD)" \
  RESEND_AUDIENCE_PAID_ID="$(G RESEND_AUDIENCE_PAID_ID_PROD)" \
  RESEND_AUDIENCE_DOWNGRADED_ID="$(G RESEND_AUDIENCE_DOWNGRADED_ID_PROD)" \
  RESEND_AUDIENCE_USEMONEY_SECURITY_ID="$(G RESEND_AUDIENCE_USEMONEY_SECURITY_ID_PROD)" \
  RESEND_AUDIENCE_MARKETING_ID="$(G RESEND_AUDIENCE_MARKETING_ID_PROD)" \
  npx tsx scripts/migrations/migrate-resend-segments.ts



# Glossary seed
DATABASE_URL=$(gcloud secrets versions access latest \
  --secret="DATABASE_URL_PROD" --project="stock-book-483718") \
  npx tsx scripts/seed/seed-glossary.ts prod
```

---

## Scope of Changes

| Area               | What Changed                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **Rebranding**     | stockbook → usemoney (URLs, emails, .env files, Dodo brand)                                                         |
| **Plan System**    | `AI_UNLIMITED` → `PREMIUM`, `AI_ADDON` → `QUERY_PACK`, new `ULTIMATE` tier, Pro plan mode toggle                    |
| **New DB Models**  | `PlatformConfig`, `InviteToken`, `ContentInvite`                                                                    |
| **Schema Fields**  | `User.emailPreferences`, `NewsletterSubscriber.{segments, resendContactIds, note, location}`, `ContentType.DOCS`    |
| **New API Routes** | `/api/invite/[token]/redeem`, `/api/email/preferences/unsubscribe`, `/api/content/docs`                             |
| **Middleware**     | 7 new public routes: `/subprocessors`, `/legal`, `/api/newsletter`, `/blog`, `/newsletter`, `/glossary`, `/pricing` |
| **Workers**        | Import processor refactored, all processors updated to common service layer, analysis score Pub/Sub fix             |
| **Content App**    | Newsletter with Resend audiences, blog publishing, GCS public images, PostHog analytics                             |
| **Frontend**       | Legal hub page, subprocessors page, footer unification, PublicHeader on legal pages, pricing now public route       |
| **Pub/Sub**        | Analysis score fix, tradebook pairing fix                                                                           |

---

## Phase 0: Pre-Flight Checks

```bash
# Activate GCP
gcloud config configurations activate stockbook

# Run full test suite
yarn test

# Type check (expect only pre-existing __tests__/ errors - no source errors)
yarn type-check 2>&1 | grep -v '__tests__' | tail -5

# Build all apps
yarn build
```

- [ ] All tests pass (11,500+ test cases)
- [ ] No new type errors in source code
- [ ] All apps build successfully
- [ ] Branch is rebased on latest `main`

---

## Phase 1: Database (Do FIRST - before deploying any app)

### 1.1 Schema Push

The schema has breaking enum changes (`AI_UNLIMITED` removed, `ULTIMATE` and
`QUERY_PACK` added) plus 3 new models. Push schema first so all apps can use the
new types on deploy.

```bash
gcloud config configurations activate stockbook

# Push to QA first, verify, then push to prod
DATABASE_URL=$(gcloud secrets versions access latest \
  --secret="DATABASE_URL_QA" --project="stock-book-483718") \
  yarn workspace @usemoney/database prisma db push

# Verify QA schema looks correct, then push to prod
DATABASE_URL=$(gcloud secrets versions access latest \
  --secret="DATABASE_URL_PROD" --project="stock-book-483718") \
  yarn workspace @usemoney/database prisma db push
```

**What this creates/changes:**

- Enum `PlanType`: removes `AI_UNLIMITED`, adds `ULTIMATE`, `QUERY_PACK` (keeps
  `AI_ADDON` for backward compat)
- New collection: `platform_config` (PlatformConfig model)
- New collection: `invite_tokens` (InviteToken model)
- New collection: `content_invites` (ContentInvite model)
- New field: `User.emailPreferences` (Json, nullable)
- New fields on `NewsletterSubscriber`: `segments`, `resendContactIds`, `note`,
  `location`
- New enum value: `ContentType.DOCS`

### 1.2 Data Migrations

```bash
# Plan ID migration - updates existing Subscription, Payment, DodoProduct records
DATABASE_URL=$(gcloud secrets versions access latest \
  --secret="DATABASE_URL_PROD" --project="stock-book-483718") \
  npx tsx scripts/migrations/migrate-plan-ids.ts prod
```

This migrates:

- `Subscription.planId`: `AI_UNLIMITED` → `PREMIUM`, `AI_ADDON` → `QUERY_PACK`
- `Payment.planId`: same mapping
- `Subscription.addons[]`: same mapping
- `DodoProduct.planType`: same mapping

Script is **idempotent** - safe to re-run.

### 1.3 Resend Segment Migration

```bash
DATABASE_URL=$(gcloud secrets versions access latest \
  --secret="DATABASE_URL_PROD" --project="stock-book-483718") \
  npx tsx scripts/migrations/migrate-resend-segments.ts prod
```

### 1.4 Seed Platform Config

```bash
# Via mongosh (connect to Atlas prod):
db.platform_config.insertOne({
  key: "pro_plan_mode",
  value: { mode: "lifetime" },
  updatedAt: new Date()
})
```

### 1.5 Seed Glossary (if not already done)

```bash
DATABASE_URL=$(gcloud secrets versions access latest \
  --secret="DATABASE_URL_PROD" --project="stock-book-483718") \
  npx tsx scripts/seed/seed-glossary.ts prod
```

### 1.6 Verification

- [ ] Check `subscriptions` collection - no docs with `planId: "AI_UNLIMITED"`
- [ ] Check `platform_config` collection - `pro_plan_mode` doc exists
- [ ] Check `invite_tokens` collection exists (empty is fine)
- [ ] Check `newsletter_subscribers` - schema has new fields

---

## Phase 2: Environment Variables

### Web App (Vercel - usemoney.ai)

| Variable                               | Action               | Value                                    |
| -------------------------------------- | -------------------- | ---------------------------------------- |
| `NEXT_PUBLIC_APP_URL`                  | **Update**           | `https://usemoney.ai`                    |
| `NEXT_PUBLIC_WEB_URL`                  | **Update**           | `https://usemoney.ai`                    |
| `EMAIL_FROM`                           | **Update**           | `noreply@email.usemoney.ai`              |
| `EMAIL_REPLY_TO`                       | **Update**           | `support@usemoney.ai`                    |
| `RESEND_API_KEY`                       | **Add** (if missing) | from Resend dashboard                    |
| `EMAIL_UNSUBSCRIBE_SECRET`             | **Add**              | `openssl rand -hex 32`                   |
| `RESEND_AUDIENCE_FREE_ID`              | **Add**              | from Resend (never-paid users)           |
| `RESEND_AUDIENCE_PAID_ID`              | **Add**              | from Resend (active paid subs)           |
| `RESEND_AUDIENCE_DOWNGRADED_ID`        | **Add**              | from Resend (previously paid → free now) |
| `RESEND_AUDIENCE_USEMONEY_SECURITY_ID` | **Add**              | from Resend (all users)                  |
| `RESEND_AUDIENCE_MARKETING_ID`         | **Add**              | from Resend (explicit opt-in only)       |

### Content App (Vercel - content.usemoney.ai)

| Variable                               | Action             | Notes                                        |
| -------------------------------------- | ------------------ | -------------------------------------------- |
| `NEXT_PUBLIC_WEB_URL`                  | **Add**            | `https://usemoney.ai`                        |
| `GCP_PUBLIC_STORAGE_BUCKET`            | **Add**            | Public GCS bucket for blog/newsletter images |
| `REDIS_URL`                            | **Add**            | Same Redis instance as web app               |
| `RESEND_API_KEY`                       | **Add**            | Same as web app                              |
| `EMAIL_UNSUBSCRIBE_SECRET`             | **Add**            | Same value as web app                        |
| `RESEND_AUDIENCE_FREE_ID`              | **Add**            | from Resend (never-paid users)               |
| `RESEND_AUDIENCE_PAID_ID`              | **Add**            | from Resend (active paid subs)               |
| `RESEND_AUDIENCE_DOWNGRADED_ID`        | **Add**            | from Resend (previously paid → free now)     |
| `RESEND_AUDIENCE_USEMONEY_SECURITY_ID` | **Add**            | from Resend (all users)                      |
| `CONTENT_ADMIN_EMAILS`                 | **Add**            | Comma-separated CMS admin emails             |
| `GOOGLE_GENAI_API_KEY`                 | **Add** (optional) | For AI-assisted content generation           |
| `NEXT_PUBLIC_POSTHOG_KEY`              | **Add** (optional) | Same PostHog project as web                  |

### Admin App (Vercel - admin.usemoney.ai)

| Variable                | Action  | Notes                        |
| ----------------------- | ------- | ---------------------------- |
| `DODO_PAYMENTS_API_KEY` | **Add** | Same key as web app          |
| `NEXT_PUBLIC_DODO_MODE` | **Add** | `live` for production        |
| `ADMIN_EMAILS`          | **Add** | Comma-separated admin emails |

### API App (Vercel - api.usemoney.ai)

| Variable    | Action     | Value                       |
| ----------- | ---------- | --------------------------- |
| `WEB_URL`   | **Update** | `https://usemoney.ai`       |
| `ADMIN_URL` | **Update** | `https://admin.usemoney.ai` |

### Workers (GCP Cloud Run - Secret Manager)

No new secrets required. Verify these exist:

- [ ] `DATABASE_URL_PROD`
- [ ] `REDIS_URL_PROD`
- [ ] `ENCRYPTION_KEY_PROD`
- [ ] `GOOGLE_GENAI_API_KEY`
- [ ] `DD_API_KEY_PROD`

---

## Phase 3: Clerk Migration (Domain + Webhook)

The rebranding from `stockbook.space` → `usemoney.ai` requires updating Clerk's
configuration. Source code is already updated (no `stockbook.space` references
remain), but the Clerk dashboard and GCP OAuth console need manual changes.

### 3.1 Clerk Dashboard (https://dashboard.clerk.com)

- [ ] **Production instance → Domains:**
  - Add `usemoney.ai` as the primary domain
  - Remove old `stockbook.space` domain (after transition period)
- [ ] **Webhook endpoint:**
  - Update endpoint URL: `https://usemoney.ai/api/webhooks/clerk`
  - (old: `https://stockbook.space/api/webhooks/clerk`)
  - Events: `user.created`, `user.updated`, `user.deleted`
  - Copy the new signing secret → update `CLERK_WEBHOOK_SECRET` in Vercel env
    vars
  - **Note:** If the endpoint URL changes, Clerk generates a new signing secret.
    The old `CLERK_WEBHOOK_SECRET` will stop working.
- [ ] **Redirect URLs:**
  - Sign-in redirect: `https://usemoney.ai/dashboard`
  - Sign-up redirect: `https://usemoney.ai/dashboard`
  - After sign-out: `https://usemoney.ai/home`
  - Add `https://usemoney.ai` to allowed redirect URLs
- [ ] **Social login (Google OAuth) - GCP Console:**
  - Go to GCP Console → APIs & Services → Credentials → OAuth 2.0 Client ID
  - **Authorized JavaScript Origins** - add:
    - `https://usemoney.ai`
    - `https://qa.usemoney.ai`
    - `http://localhost:3000` (for dev)
  - **Authorized Redirect URIs** - add Clerk's redirect URI for the new domain
    (check Clerk dashboard → SSO Connections → Google → Redirect URI)
  - This is required for **Google One Tap** (`<GoogleOneTap />` in layout.tsx)
    to work

### 3.2 Clerk Env Vars

| App                  | Variable                            | Action     | Notes                                            |
| -------------------- | ----------------------------------- | ---------- | ------------------------------------------------ |
| **Web** (Vercel)     | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | **Verify** | Should be `pk_live_...` for prod                 |
| **Web** (Vercel)     | `CLERK_SECRET_KEY`                  | **Verify** | Should be `sk_live_...` for prod                 |
| **Web** (Vercel)     | `CLERK_WEBHOOK_SECRET`              | **Update** | New signing secret from updated webhook endpoint |
| **Admin** (Vercel)   | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | **Verify** | Same as web                                      |
| **Admin** (Vercel)   | `CLERK_SECRET_KEY`                  | **Verify** | Same as web                                      |
| **Content** (Vercel) | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | **Verify** | Same as web                                      |
| **Content** (Vercel) | `CLERK_SECRET_KEY`                  | **Verify** | Same as web                                      |
| **API** (Cloud Run)  | `CLERK_SECRET_KEY`                  | **Verify** | In GCP Secret Manager (`CLERK_SECRET_KEY_PROD`)  |

### 3.3 Verification

- [ ] Sign up with email → webhook fires → user created in DB
- [ ] Sign in with Google → Google One Tap popup appears on `/home`
- [ ] Sign out → redirects to `/home`
- [ ] Update profile in Clerk → `user.updated` webhook fires
- [ ] Delete account in Clerk → `user.deleted` webhook fires → user soft-deleted

---

## Phase 4: GCS Buckets

### 4.1 Verify Private Bucket (learning content, documents, reports)

```bash
gcloud config configurations activate stockbook
gsutil ls gs://stockbook-content-prod 2>/dev/null && echo "EXISTS" || echo "MISSING"
```

If missing, create it:

```bash
gsutil mb -p stock-book-483718 -l us-central1 gs://stockbook-content-prod
SA_EMAIL="stockbook-api@stock-book-483718.iam.gserviceaccount.com"
gsutil iam ch serviceAccount:${SA_EMAIL}:objectViewer gs://stockbook-content-prod
gsutil iam ch serviceAccount:${SA_EMAIL}:objectCreator gs://stockbook-content-prod
```

### 4.2 Create Public Bucket (blog images, email assets)

```bash
# Create bucket
gsutil mb -p stock-book-483718 -l us-central1 gs://stockbook-public-content

# Make publicly readable
gsutil iam ch allUsers:objectViewer gs://stockbook-public-content

# Grant service account write access
SA_EMAIL="stockbook-api@stock-book-483718.iam.gserviceaccount.com"
gsutil iam ch serviceAccount:${SA_EMAIL}:objectCreator gs://stockbook-public-content
gsutil iam ch serviceAccount:${SA_EMAIL}:objectViewer gs://stockbook-public-content

# Set CORS
cat > /tmp/cors.json << 'EOF'
[
  {
    "origin": [
      "https://usemoney.ai",
      "https://qa.usemoney.ai",
      "https://content.usemoney.ai",
      "http://localhost:3000",
      "http://localhost:3002"
    ],
    "method": ["GET", "HEAD"],
    "responseHeader": ["Content-Type", "Content-Length"],
    "maxAgeSeconds": 3600
  }
]
EOF
gsutil cors set /tmp/cors.json gs://stockbook-public-content

# Upload logo asset
gsutil cp path/to/UseMoney.png gs://stockbook-public-content/assets/UseMoney.png
```

### 4.3 GCS Env Vars

| App                     | Variable                    | Prod Value                                                                    |
| ----------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| **Web** (Vercel)        | `GCP_STORAGE_BUCKET`        | `stockbook-content-prod`                                                      |
| **Web** (Vercel)        | `GCP_PUBLIC_STORAGE_BUCKET` | `stockbook-public-content`                                                    |
| **Web** (Vercel)        | `EMAIL_LOGO_URL`            | `https://storage.googleapis.com/stockbook-public-content/assets/UseMoney.png` |
| **Content** (Vercel)    | `GCP_STORAGE_BUCKET`        | `stockbook-content-prod`                                                      |
| **Content** (Vercel)    | `GCP_PUBLIC_STORAGE_BUCKET` | `stockbook-public-content`                                                    |
| **Content** (Vercel)    | `EMAIL_LOGO_URL`            | `https://storage.googleapis.com/stockbook-public-content/assets/UseMoney.png` |
| **API** (Vercel)        | `GCP_STORAGE_BUCKET`        | `stockbook-content-prod`                                                      |
| **Workers** (Cloud Run) | `GCP_STORAGE_BUCKET`        | `stockbook-content-prod` (already in cloudbuild.prod.yaml)                    |

---

## Phase 5: Dodo Payments Setup

- [ ] Create products in Dodo dashboard:
  - `usemoney_pro` - PRO (one-time or annual depending on mode)
  - `usemoney_query_pack` - QUERY_PACK (one-time)
  - `usemoney_premium` - PREMIUM (monthly)
  - `usemoney_premium_annual` - PREMIUM (annual)
- [ ] Keep old `tradebook_*` product mappings active during transition period
- [ ] Archive old products **only after** confirming no active subscriptions use
      them

---

## Phase 6: Deploy Applications

**Order matters** - workers must be up before web app sends Pub/Sub messages.

### 6.1 Workers (GCP Cloud Run)

```bash
gcloud config configurations activate stockbook

# Deploy to production
gcloud builds submit --config workers/cloudbuild.prod.yaml \
  --project=stock-book-483718
```

Verify:

- [ ] Cloud Run service is running
- [ ] Pub/Sub subscriptions are pointing to correct Cloud Run URL
- [ ] Check logs:
      `gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=stockbook-workers" --project=stock-book-483718 --limit=10`

### 6.2 Web App (Vercel)

Merge to `main` → auto-deploys to Vercel.

### 6.3 Content App (Vercel)

Deploy via Vercel dashboard or CLI after setting env vars.

### 6.4 Admin App (Vercel)

Deploy via Vercel dashboard or CLI after setting env vars.

---

## Phase 7: Post-Deployment Verification

### Critical Path (Must Work)

- [ ] **Homepage** - `https://usemoney.ai/home` loads
- [ ] **Auth** - Sign up and Sign in work (Clerk)
- [ ] **Dashboard** - existing user sees portfolio data
- [ ] **Broker sync** - trigger manual sync → worker processes Pub/Sub message
- [ ] **Trade pairing** - import a trade → pairing completes via Pub/Sub

### Auth & Clerk

- [ ] **Sign up** - new user → Clerk webhook fires → user created in DB +
      welcome email sent
- [ ] **Sign in (email)** - existing user can log in
- [ ] **Sign in (Google)** - Google OAuth works on `usemoney.ai` domain
- [ ] **Google One Tap** - popup appears on `/home` for unauthenticated users
- [ ] **Sign out** - redirects to `/home`
- [ ] **Webhook** - update user profile → `user.updated` webhook fires → DB
      updated

### Plan & Payments

- [ ] **Pricing page** - shows correct plans (PRO, PREMIUM, QUERY_PACK)
- [ ] **Checkout** - test each plan: PRO, PREMIUM monthly, PREMIUM annual,
      QUERY_PACK
- [ ] **Dodo webhook** - verify subscription updates correctly
- [ ] **Legacy mapping** - webhook with old `AI_UNLIMITED` plan ID maps to
      `PREMIUM`
- [ ] **Settings page** - existing users see correct plan name
- [ ] **Invite tokens** - create and redeem via admin
- [ ] **Demo mode** - still bypasses all subscription checks

### New Pages & Features

- [ ] `/legal` - hub page loads with 3 cards, full navbar + footer
- [ ] `/privacy` - full navbar + footer, content renders
- [ ] `/terms` - full navbar + footer, content renders
- [ ] `/subprocessors` - full navbar + footer, data correct (PostHog = US, not
      EU)
- [ ] `/blog` - posts load correctly
- [ ] `/glossary` - terms render
- [ ] `/pricing` - loads without auth (now a public route)

### Email & Newsletter

- [ ] `/newsletter/subscribe` - subscription flow works
- [ ] Newsletter verify email sends
- [ ] `/api/email/preferences/unsubscribe` - unsubscribe link works
- [ ] Rebranded email from/reply-to addresses deliver correctly

### Workers & Background Jobs

- [ ] Trade import CSV processing completes
- [ ] Instrument sync runs successfully
- [ ] Price sync runs successfully
- [ ] Portfolio roast / analysis score completes (Pub/Sub fix verified)

### Content App

- [ ] Blog post creation and publishing works
- [ ] Newsletter sending with Resend audiences works
- [ ] GCS public image upload works

---

## PostHog Feature Flags

- [ ] Verify all `page-visibility-*` flags exist and are correctly configured
- [ ] No plan-specific FF changes needed (plan gating is code-based)

## MongoDB Atlas Search Indexes

- [ ] No changes needed (indexes don't reference plan types)

---

## Rollback Plan

If critical issues arise:

1. **Plan system**: `resolvePlanId()` handles legacy IDs at all entry points -
   old webhook payloads still work
2. **Dodo products**: Old `tradebook_*` product names are kept in
   `PRODUCT_PLAN_MAPPING` during transition
3. **Migration scripts**: Both `migrate-plan-ids.ts` and
   `migrate-resend-segments.ts` are idempotent - safe to re-run
4. **Schema**: New models (`PlatformConfig`, `InviteToken`, `ContentInvite`) are
   additive - rolling back code won't break existing data
5. **Vercel**: Instant rollback via Vercel dashboard → Deployments → Promote
   previous deployment
6. **Workers**: Redeploy previous Cloud Run revision:
   ```bash
   gcloud run services update-traffic stockbook-workers \
     --to-revisions=PREVIOUS_REVISION=100 \
     --project=stock-book-483718 --region=us-central1
   ```

---

## GCP Quick Commands Reference

```bash
# Activate stockbook project
gcloud config configurations activate stockbook

# Authenticate
gcloud auth login

# Verify current config
gcloud config list

# Fetch any secret
gcloud secrets versions access latest \
  --secret="SECRET_NAME" --project="stock-book-483718"

# List all secrets
gcloud secrets list --project=stock-book-483718

# Schema push (prod)
DATABASE_URL=$(gcloud secrets versions access latest \
  --secret="DATABASE_URL_PROD" --project="stock-book-483718") \
  yarn workspace @usemoney/database prisma db push

# Schema push (QA)
DATABASE_URL=$(gcloud secrets versions access latest \
  --secret="DATABASE_URL_QA" --project="stock-book-483718") \
  yarn workspace @usemoney/database prisma db push

# Seed data (prod)
./scripts/seed-env.sh prod

# Seed data (QA)
./scripts/seed-env.sh qa

# Deploy workers (prod)
gcloud builds submit --config workers/cloudbuild.prod.yaml \
  --project=stock-book-483718

# Deploy workers (QA)
gcloud builds submit --config workers/cloudbuild.qa.yaml \
  --project=stock-book-483718

# Check worker logs
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=stockbook-workers" \
  --project=stock-book-483718 --limit=20 --format="table(timestamp,textPayload)"

# Setup Pub/Sub (if needed)
./workers/scripts/setup-pubsub.sh prod

# Setup Cloud Scheduler (if needed)
./scripts/ops/setup-scheduler.sh prod
```

---

_Last Updated: March 2026_
