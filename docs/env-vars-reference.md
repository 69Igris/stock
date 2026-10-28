# Environment Variables - Reference

> Single source of truth for "what env vars exist, where each app reads them,
> and where to add new ones."

When you ship a feature that introduces a new env var, **edit this doc in the
same PR** - otherwise the next person to hit a missing var has to re-read the
source.

---

## Where each app reads its env vars

| App            | `.env` location                                                       | Production source                      |
| -------------- | --------------------------------------------------------------------- | -------------------------------------- |
| `apps/web`     | `apps/web/.env.local` (local dev), `apps/web/.env.example` (template) | Vercel project env vars                |
| `apps/admin`   | `apps/admin/.env.local`, `apps/admin/.env.example`                    | Vercel project env vars                |
| `apps/content` | `apps/content/.env.local`, `apps/content/.env.example`                | Vercel project env vars                |
| `apps/api`     | `apps/api/.env`, `apps/api/.env.example`                              | GCP Cloud Run secret manager           |
| `workers/`     | `workers/.env`, `workers/.env.example`                                | GCP Cloud Run secret manager (sidecar) |

**Local dev:** copy `.env.example` → `.env.local` in each app and fill in
values. **Production:** set via Vercel dashboard (web/admin/content) or GCP
Secret Manager (api/workers). NEVER commit `.env.local`.

---

## When you add a new env var, update these places

1. **The relevant app's `.env.example`** - add the var with a default + comment
   explaining what it does and which ticket introduced it.
2. **This doc (`docs/env-vars-reference.md`)** - add a row in the right section.
3. **Production secret store** - add the var to Vercel/Secret Manager BEFORE
   merging the PR that depends on it.
4. **`docs/gst/monthly-process.md`** or the relevant runbook - if the var is
   operator-facing (e.g. `GST_LUT_ARN` needs annual rotation), document the
   rotation cadence.

---

## Currently in use

### Database + cache

| Var            | App | Purpose                         | Source                                                      |
| -------------- | --- | ------------------------------- | ----------------------------------------------------------- |
| `DATABASE_URL` | all | MongoDB Atlas connection string | GCP Secret Manager: `DATABASE_URL_PROD` / `DATABASE_URL_QA` |
| `REDIS_URL`    | all | DigitalOcean Redis              | GCP Secret Manager                                          |

### Auth (Clerk)

| Var                                 | App                 | Purpose                                |
| ----------------------------------- | ------------------- | -------------------------------------- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | web, admin, content | Clerk public key (frontend)            |
| `CLERK_SECRET_KEY`                  | web, admin, content | Clerk private key (server)             |
| `CLERK_WEBHOOK_SECRET`              | web                 | Clerk → DB user-sync webhook signature |
| `ADMIN_EMAILS`                      | admin               | Comma-separated admin email allow-list |

### AI (Vertex AI / Gemini)

| Var                              | App                 | Purpose                                      |
| -------------------------------- | ------------------- | -------------------------------------------- |
| `GOOGLE_GENAI_API_KEY`           | web, workers        | Vertex AI API key                            |
| `GCP_PROJECT_ID`                 | web, workers, admin | Project for Vertex + GCS                     |
| `GCP_SERVICE_ACCOUNT_KEY_BASE64` | web, workers        | Base64-encoded SA key (when ADC unavailable) |

### Payments (Dodo)

| Var                           | App | Purpose                                                                                   |
| ----------------------------- | --- | ----------------------------------------------------------------------------------------- |
| `DODO_PAYMENTS_API_KEY`       | web | Dodo API for checkout sessions                                                            |
| `DODO_WEBHOOK_SECRET`         | web | Svix-signed webhook verification                                                          |
| `FEATURE_DODO_WEBHOOK_INGEST` | web | OFF by default (MONEY-213). Set `true` to route Dodo payout webhooks → GST staging table. |

### GST / Billing (MONEY-212 → MONEY-217 + MONEY-227)

> Lives in `apps/web/.env.example` lines 208–250. All required for invoice
> generation; engine throws `LutArnNotConfiguredError` if `GST_LUT_ARN` is
> missing.

| Var                              | Purpose                                                                                                                  | Rotation              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `GST_SELLER_LEGAL_NAME`          | "DIS Digital LLP" - printed on every PDF                                                                                 | Frozen                |
| `GST_SELLER_GSTIN`               | Seller GSTIN                                                                                                             | Frozen                |
| `GST_SELLER_PAN`                 | Seller PAN                                                                                                               | Frozen                |
| `GST_SELLER_ADDRESS`             | Multi-line seller address                                                                                                | Frozen                |
| `GST_SELLER_STATE_CODE`          | GST state code (e.g. `27` for Maharashtra). Determines intra-state vs inter-state split for domestic invoices.           | Frozen                |
| `GST_DEFAULT_SAC`                | Default SAC code on line items (`998314` SaaS)                                                                           | Annual review         |
| **`GST_LUT_ARN`**                | **LUT acknowledgement number for the current FY. Re-filed every FY.**                                                    | **Annual - Apr 1**    |
| `BILLING_PERIOD_DAYS`            | Half-month cadence (default `15`)                                                                                        | Frozen                |
| `GCS_BUCKET_GST_INVOICES`        | GCS private bucket for invoice PDFs (`usemoney-gst-invoices` prod / `-qa` QA)                                            | Per-env               |
| `GST_BANK_BENEFICIARY`           | Bank account name printed on PDFs                                                                                        | On bank change        |
| `GST_BANK_ACCOUNT`               | Account number                                                                                                           | On bank change        |
| `GST_BANK_IFSC`                  | IFSC code                                                                                                                | On bank change        |
| `GST_BANK_SWIFT`                 | SWIFT code                                                                                                               | On bank change        |
| `GST_DOMESTIC_RATE`              | Default GST rate (%) for domestic invoices (default `18`)                                                                | Per CA classification |
| `GST_FX_RATE_<CCY>_<YYYY-MM-DD>` | Optional ops override per (currency, date) when RBI archive is unreachable. Example: `GST_FX_RATE_USD_2026-04-30=83.42`. | Per-incident          |

### Datadog Observability

| Var                             | App             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DD_TRACE_ENABLED`              | workers / web   | `true` on Cloud Run (sidecar agent), `false` on Vercel                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DD_API_KEY`                    | all             | Datadog API key                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DD_APP_KEY`                    | ops laptop      | Datadog APPLICATION key, read by every `scripts/ops/datadog/apply-*.sh` plus `create-rum-apps.sh` and `setup-datadog.sh` (GCP Secret Manager `DD_APP_KEY_PROD` / `DD_APP_KEY_QA`). It used to say "for apply-monitors.sh"; nine scripts read it. Never set on a service. Store it with `set-dd-secret.sh`, which validates against the live site BEFORE writing — a wrong key is answered 403 and dropped, which looks exactly like a healthy idle system |
| `DD_SERVICE`                    | all             | `stockbook-web` / `stockbook-api` / `stockbook-workers`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DD_ENV`                        | all             | `production` / `qa`                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DD_VERSION`                    | all             | Set to commit SHA on deploy                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DD_SITE`                       | sidecars        | `us5.datadoghq.com` on the serverless-init sidecar (workers, us-fundamentals). Must equal `DD_SITE` in `packages/datadog/src/constants.ts`, which every TypeScript emitter and the RUM init derive from; pinned by `site-agreement.test.ts`                                                                                                                                                                                                               |
| `DD_TRACE_AGENT_URL`            | workers         | `http://localhost:8126` (sidecar)                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DD_QA_MONITORING`              | ops laptop      | `on` re-enables the QA monitor rows. Default OFF, founder decision 2026-09-06. QA runs a subset of the schedules on data copied down from prod, so a QA monitor either duplicates a prod alarm or watches a job QA never runs — and the second kind pages at 03:00 about nothing and teaches everyone to ignore the channel. Read by `dd_qa_monitoring_enabled` in `lib-datadog.sh`; both monitor apply scripts exit 0 rendering nothing while it is off  |
| `DD_METRICS_TRANSPORT`          | us-fundamentals | `http` on the five Cloud Run JOBS (no sidecar — DogStatsD packets were dropped by a closed port), `statsd` on the SERVICE (which has one). Literal comparison; absent means statsd. The `http` path needs `DD_API_KEY` and no-ops without it (MONEY-1278)                                                                                                                                                                                                 |
| `NEXT_PUBLIC_DD_APPLICATION_ID` | web             | RUM application ID                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `NEXT_PUBLIC_DD_CLIENT_TOKEN`   | web             | RUM client token                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `NEXT_PUBLIC_DD_ENV`            | web             | RUM env tag                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Brokers (one set per broker)

| Pattern                                                 | Used by                                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ZERODHA_API_KEY` / `ZERODHA_API_SECRET`                | web, workers (FREE "Personal" Kite app — portfolio sync; MONEY-837)                                               |
| `UPSTOX_API_KEY` / `UPSTOX_API_SECRET`                  | web                                                                                                               |
| `ANGEL_ONE_API_KEY` / `ANGEL_ONE_CLIENT_ID`             | web                                                                                                               |
| `GROWW_API_KEY` / `GROWW_API_SECRET`                    | web (paid API)                                                                                                    |
| `DHAN_API_KEY` / `DHAN_ACCESS_TOKEN`                    | web                                                                                                               |
| `FYERS_APP_ID` / `FYERS_APP_SECRET`                     | web                                                                                                               |
| `ZERODHA_SYSTEM_API_KEY`                                | workers (instrument master sync)                                                                                  |
| `ZERODHA_CONNECT_API_KEY` / `_SECRET` / `_REDIRECT_URI` | apps/web (founder-only Connect connector `/api/brokers/zerodha-connect`) + dormant workers/src/connect; MONEY-837 |
| `CONNECT_FOUNDER_EMAILS`                                | apps/web (optional CSV extending the Connect founder allowlist; default deepshaswat@gmail.com)                    |

### Content + Email

| Var                  | App          | Purpose                                                   |
| -------------------- | ------------ | --------------------------------------------------------- |
| `GCP_STORAGE_BUCKET` | web, content | GCS bucket for learning content                           |
| `RESEND_API_KEY`     | web, content | Resend transactional email                                |
| `RESEND_AUDIENCE_*`  | web, content | Resend audience IDs (free / paid / downgraded / security) |

### US market data — Databento (MONEY-1373)

Read ONLY by the two Cloud Run JOBS (`databento-harvest-{env}`,
`databento-append-{env}`), provisioned by `scripts/ops/setup-databento-jobs.sh`.
A Cloud Run JOB does NOT inherit the workers SERVICE env block, so these are
set on the jobs and are deliberately absent from `workers/cloudbuild.*.yaml` —
adding them there would look like configuration and do nothing.

| Var                            | App  | Purpose                                                                                                                                                                                                               |
| ------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABENTO_API_KEY`            | jobs | SECRET. Secret Manager `DATABENTO_API_KEY_QA` / `_PROD`. HTTP **Basic** auth with the key as the username and an empty password — not Bearer.                                                                         |
| `DATABENTO_HARVEST_APPLY`      | jobs | Ships PRESENT and `"false"`. `"true"` ARMS the one-time history buy. Compared to the literal string, never `Boolean()`, and read per call. `--apply` on the command line ASKS; this ARMS; both are required to spend. |
| `DATABENTO_APPEND_APPLY`       | jobs | Ships PRESENT and `"false"`. `"true"` ARMS the nightly extension. Same literal comparison, same per-call read. Separate from the harvest flag so one can be armed without the other.                                  |
| `DATABENTO_MONTHLY_BUDGET_USD` | jobs | Default 25. A REFUSAL threshold, not a trim: a submission that would cross it throws rather than narrowing the window, because a narrowed window buys a slice nobody asked for and reports success.                   |
| `DATABENTO_ENV`                | jobs | `prod` / `qa`. Stamped on every inventory row so one ledger can hold both environments' purchases without them summing together.                                                                                      |

Both jobs also need `DATABASE_URL`, `GCP_STORAGE_BUCKET`,
`GCP_SERVICE_ACCOUNT_KEY_BASE64` and `DD_API_KEY` (mounted from
`DD_API_KEY_{QA,PROD}`), and `DD_TRACE_ENABLED=false` — a JOB has no Datadog
sidecar, so tracing has nowhere to send spans.

**Arming is a deploy, and the verb matters.** Use `--update-env-vars`, which
MERGES. `--set-env-vars` REPLACES the entire block and would drop
`DATABASE_URL`, `GCP_STORAGE_BUCKET` and the rest in one command:

```
gcloud run jobs update databento-append-prod --region=asia-south1 \
  --update-env-vars=DATABENTO_APPEND_APPLY=true
```

### Optional / debug

| Var                             | App              | Purpose                                                                                                                     |
| ------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_DEBUG_FEATURES`         | web              | Never set in production                                                                                                     |
| `MONGODB_VECTOR_SEARCH_ENABLED` | web              | Atlas Vector Search (production-only)                                                                                       |
| `SYNC_CHARTING_LIBRARY`         | root postinstall | Set to `1` ONLY when running `yarn sync:chart` to refresh the TradingView submodule (otherwise the postinstall is a no-op). |

---

## Future / pending tickets that will add env vars

| Ticket                                                        | Likely new vars                     | Notes                                                    |
| ------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| **MONEY-219** Research preferences schema                     | none                                | Stored on `User.preferences` Json - no env config needed |
| **MONEY-222** Planner consumes researchFocus                  | `RESEARCH_DEFAULT_STYLE` (optional) | Optional global default if user hasn't picked one        |
| **MONEY-226** GST diagnostics + backfill                      | `GST_DIAGNOSTICS_ENABLED`           | Gates the QA-only diagnostics page                       |
| Pub/Sub auto-trigger of domestic invoice on payment.completed | `GST_AUTO_DOMESTIC_INVOICE`         | Feature flag to enable webhook-driven invoice generation |
