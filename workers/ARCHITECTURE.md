# Workers - Architecture

> Deep technical reference for `@usemoney/workers`. Complements
> [`README.md`](./README.md) (quick start) and [`CLAUDE.md`](./CLAUDE.md)
> (project memory & rules).

**Stack:** Hono 4 · Node.js (Cloud Run) · Prisma (MongoDB) · Google Cloud
Pub/Sub (push subscriptions) · Datadog APM **Deploy target:** GCP Cloud Run
Service (stockbook-workers-{env}) **Invocation model:** Pub/Sub push → HTTP POST
→ processor

---

## 1. Purpose

Offloads long-running / periodic / asynchronous work from the web app:

- **Trade pairing** (FIFO algorithm across hundreds of trades)
- **Broker syncs** (holdings, positions, trades, mutual funds)
- **Market data pipelines** (instrument master, prices, MF NAVs, sector
  enrichment)
- **AI research jobs** (L3/L4 multi-segment analyses)
- **Portfolio roasts** (multi-step AI pipeline)
- **Document processing** (text extraction, report generation)
- **Scheduled maintenance** (resend segment sync, newsletter delivery)

Nothing user-facing. All triggered by Pub/Sub messages from the web app or Cloud
Scheduler.

---

## 2. System architecture

```
          ┌──────────────────────────────────┐
          │       Web app / Cloud Scheduler  │
          │  (publishes to Pub/Sub topics)    │
          └─────────────────┬────────────────┘
                            │
                            ▼
              ┌────────────────────────────┐
              │  Google Cloud Pub/Sub      │
              │  (12+ topics, dead-letter) │
              └──────────────┬─────────────┘
                             │
              Push subscriptions (OIDC-signed)
                             │
                             ▼
          ┌───────────────────────────────────┐
          │   Cloud Run Service (workers)     │
          │   Hono HTTP server :8081          │
          │                                   │
          │   OIDC middleware (verify token)  │
          │           │                       │
          │           ▼                       │
          │   Message parser (base64 decode)  │
          │           │                       │
          │           ▼                       │
          │   Route handler → Processor       │
          └──────────┬────────────────────────┘
                     │
        ┌────────────┼────────────┬─────────────┐
        ▼            ▼            ▼             ▼
   ┌──────────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐
   │ MongoDB  │ │  Redis  │ │  Gemini  │ │   GCS    │
   │ (Prisma) │ │ (cache) │ │    AI    │ │ (storage)│
   └──────────┘ └─────────┘ └──────────┘ └──────────┘
```

---

## 3. Job flow (generic)

```
Web app (or Cloud Scheduler)
    ↓ publishes {jobId, userId, ...payload}
Pub/Sub topic (e.g., "trade-pairing-prod")
    ↓ push subscription with OIDC token
Cloud Run: POST /jobs/trade-pairing
    ↓ OIDC middleware verifies token signature + audience
Route handler: validate payload, update BackgroundJob → PROCESSING
    ↓
Processor: actual work (can be 10+ minutes)
    ↓
Update BackgroundJob → COMPLETED | FAILED
    ↓
Return 200 OK (Pub/Sub acks) or 500 (Pub/Sub retries with backoff)
```

---

## 4. Topics and processors

**12 primary topics**, all suffixed with `-qa` or `-prod`:

| Topic               | Processor                                      | Trigger                        |
| ------------------- | ---------------------------------------------- | ------------------------------ |
| `trade-pairing`     | FIFO pairing, creates `PairedTradeView`        | On trade insert/update         |
| `csv-import`        | CSV parsing + duplicate detection + insert     | User uploads CSV               |
| `broker-sync`       | Fetch holdings/positions/trades/MF from broker | User clicks sync, or scheduled |
| `instrument-sync`   | Daily NSE/BSE instrument master dump           | Cloud Scheduler                |
| `price-sync`        | Post-market price backfill + quote refresh     | Cloud Scheduler                |
| `sector-enrichment` | Yahoo-based sector/industry enrichment         | Cloud Scheduler (weekly)       |
| `mf-sync`           | AMFI NAV daily sync                            | Cloud Scheduler                |
| `mf-metadata-sync`  | AMFI-based MF metadata enrichment              | Cloud Scheduler (weekly)       |
| `stock-research`    | AI research session processing                 | User queries chat              |
| `document-process`  | Document text extraction + report generation   | User uploads docs              |
| `portfolio-roast`   | Portfolio roast analysis pipeline              | User triggers roast            |

Plus:

- **Dead-letter topic** for unprocessable messages
- `resend-contact-sync` (weekly Resend audience reconciliation)
- `newsletter-publish` (scheduled newsletter delivery)

---

## 5. Processing patterns

### 5.1 OIDC authentication

- Pub/Sub push subscriptions authenticate via Google-signed OIDC tokens
- `workers/__tests__/auth-middleware.test.ts` - verifies this middleware
- Rejects any request without valid token (audience must match `CLOUD_RUN_URL`)

### 5.2 Idempotency

- Each job has a unique `jobId` (client-generated or derived)
- `BackgroundJob` table used to detect duplicate deliveries
- Processors check job state before doing work

### 5.3 Retry semantics

| HTTP response            | Pub/Sub behavior                              |
| ------------------------ | --------------------------------------------- |
| 200                      | Acknowledge, remove from queue                |
| 5xx                      | Retry with exponential backoff (up to 7 days) |
| Eventually: max attempts | Moved to dead-letter topic                    |

### 5.4 Pull mode (local dev)

- Set `ENABLE_PULL_SUBSCRIBER=true` to pull messages locally
- Useful when testing workers without exposing a public URL
- Same code path as push - just a different transport

---

## 6. Subsystem deep-dives

### 6.1 Trade pairing (`processors/pairing.ts`)

- FIFO algorithm: oldest BUY paired with earliest SELL per
  `symbol+exchange+broker`
- Handles partial fills by splitting trade rows
- Produces denormalized `PairedTradeView` records for fast dashboard queries
- Idempotent: re-running produces same output (important for retries)

### 6.2 Broker sync (`processors/sync.ts`)

- Decrypts stored AES-256-GCM credentials
- Calls broker adapter (shared with web app's `lib/brokers/clients/*`)
- Delete-then-insert for holdings (handles removed holdings)
- Upsert for trades (preserves manual ones, dedupes by hash)
- Publishes follow-up jobs: `trade-pairing`, cache invalidation

### 6.3 AI research (`processors/research.ts`)

- Multi-step pipeline with skills (stock-analysis, peer-comparison, etc.)
- Each step streams progress updates back to the user via `ResearchSession`
- Credits reserved at start, committed on success, refunded on failure
- Gemini retries on rate limits with exponential backoff

### 6.4 Portfolio roast (`processors/roast.ts`)

- Multi-step pipeline: fetch → analyze-stocks → analyze-mf → score → generate →
  assemble
- Each step persists intermediate state to `PortfolioRoast` table
- Resumable if worker crashes mid-pipeline
- Produces final JSON report with score (0-100)

### 6.5 Resend contact sync (`processors/resend-contact-sync.ts`)

- Weekly job (Sunday 1 AM IST via Cloud Scheduler)
- Syncs all DB users to Resend audiences
- 3-way segment resolution: paid / downgraded / free (based on subscription +
  payment history)
- Removes from opposite segments (reconciles drift from webhook failures)

---

## 7. Deployment model

- **Hosting:** GCP Cloud Run Service (2 vCPU, 2 GB mem, 10 concurrency)
- **Image:** Docker, pushed to Google Container Registry
- **Build:** Cloud Build via `workers/cloudbuild.qa.yaml` and
  `cloudbuild.prod.yaml`
- **Secrets:** Injected from GCP Secret Manager at runtime
- **Monitoring:** Datadog APM sidecar (trace, logs, metrics)

### Environments

| Env   | Project           | DB                   | Cloud Run service         |
| ----- | ----------------- | -------------------- | ------------------------- |
| Local | Local Node.js     | QA MongoDB (GCP VM)  | Hono :8081 with pull mode |
| QA    | stock-book-483718 | QA MongoDB           | stockbook-workers-qa      |
| Prod  | stock-book-483718 | MongoDB Atlas (prod) | stockbook-workers-prod    |

---

## 8. Security boundaries

- **All endpoints require OIDC token** - no public access
- **Broker credentials decryption** happens only inside processors, never logged
- **Error sanitization** via `@usemoney/logger` - no PII / tokens in logs
- **Cloud Run service account** has minimal IAM (Pub/Sub subscriber, Secret
  accessor, Cloud SQL client)

---

## 9. Scaling considerations

- **Concurrency per instance:** 10 (configurable per topic)
- **Max instances:** 100 per service (can scale to 0 when idle)
- **Cold start:** ~2-3 s for Hono + Prisma + dd-trace
- **Long-running jobs:** Up to 60 min timeout on Cloud Run; research pipelines
  chunked into sub-messages if longer

---

## 10. Observability

- **Structured logs** via `@usemoney/logger` (pino-based)
- **APM traces** via Datadog `dd-trace` (sidecar container)
- **Custom metrics** published to Datadog for job duration, failure rates
- **Dead-letter topic alerts** when jobs fail too many times

---

## See also

- [README.md](./README.md) - quick start + route reference
- [CLAUDE.md](./CLAUDE.md) - project memory, conventions
- [`workers/scripts/setup-pubsub.sh`](./scripts/setup-pubsub.sh) - topic +
  subscription provisioning
- [`workers/scripts/gcp-setup.sh`](./scripts/gcp-setup.sh) - one-time IAM +
  secrets setup
- [`docs/reference/3-tier-analysis-deployment.md`](../docs/reference/3-tier-analysis-deployment.md) -
  L3/L4 AI pipeline details
