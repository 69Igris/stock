# UseMoney Workers

> Background job processors for UseMoney

Hono HTTP server on GCP Cloud Run that receives Google Cloud Pub/Sub push messages and processes long-running tasks.

---

## Quick Start

```bash
# From monorepo root
yarn install
yarn workspace @usemoney/workers dev

# Or from workers directory
cd workers && yarn dev
```

Server runs at `http://localhost:8081`

---

## Processors

| Route                     | Pub/Sub Topic       | Description                             |
| ------------------------- | ------------------- | --------------------------------------- |
| `/jobs/trade-pairing`     | `trade-pairing`     | FIFO trade pairing computation          |
| `/jobs/csv-import`        | `csv-import`        | CSV/XLS trade import processing         |
| `/jobs/broker-sync`       | `broker-sync`       | Broker data synchronization             |
| `/jobs/instrument-sync`   | `instrument-sync`   | Instrument master data sync (daily)     |
| `/jobs/price-sync`        | `price-sync`        | Price data sync (daily post-market)     |
| `/jobs/sector-enrichment` | `sector-enrichment` | Sector/industry enrichment (weekly)     |
| `/jobs/mf-sync`           | `mf-sync`           | AMFI mutual fund NAV sync (daily)       |
| `/jobs/mf-metadata-sync`  | `mf-metadata-sync`  | MF metadata enrichment via AMFI         |
| `/jobs/stock-research`    | `stock-research`    | AI research job processing              |
| `/jobs/document-process`  | `document-process`  | Document extraction & report generation |
| `/jobs/portfolio-roast`   | `portfolio-roast`   | Portfolio roast analysis                |

---

## Architecture

```
Web App (Vercel)
  → Pub/Sub.publish(jobData)
    → Google Cloud Pub/Sub (push subscription)
      → Workers (Cloud Run Service, port 8081)
        → Route handler → Processor → Database
```

**Processing pattern:**

1. Update `BackgroundJob` status to `PROCESSING`
2. Run business logic (from `@usemoney/core`)
3. Update status to `COMPLETED` or `FAILED`

**HTTP responses:** `200` = Pub/Sub acknowledges, `500` = Pub/Sub retries with backoff.

---

## Project Structure

```
workers/
├── src/
│   ├── index.ts              # Hono server entry (port 8081)
│   ├── routes/               # 12 job route handlers
│   ├── processors/           # 12 business logic processors
│   └── lib/                  # Shared utilities
│       ├── message.ts        # Pub/Sub push envelope parser
│       ├── notifications.ts  # Notification helpers
│       ├── pull-subscriber.ts # Local dev pull subscriber
│       ├── gcs.ts            # GCS utilities
│       ├── embeddings.ts     # Document embeddings
│       └── report-renderer.ts # PDF report rendering
├── report-templates/         # PDF report templates (React/JSX)
├── __tests__/                # Worker tests
├── scripts/
│   ├── deploy.sh             # Cloud Run deployment
│   ├── build.sh              # Local Docker build
│   ├── setup-pubsub.sh       # Create 12 topics & subscriptions
│   └── gcp-setup.sh          # One-time GCP setup
├── Dockerfile                # Docker config (Cloud Run)
├── cloudbuild.yaml           # Cloud Build (parameterized)
└── package.json
```

---

## Commands

```bash
# Dev (Hono server with hot reload)
yarn dev

# Build
yarn build

# Production
yarn start

# Type check
yarn type-check

# Run tests
yarn test
```

---

## Environment Variables

```bash
PORT=8081
DATABASE_URL=mongodb+srv://...
REDIS_URL=redis://...
GCP_PROJECT_ID=<project-id>
CLOUD_RUN_URL=https://...       # OIDC token verification
ENABLE_PULL_SUBSCRIBER=true     # Local dev only
```

---

## Deployment

```bash
# Deploy to Cloud Run
./scripts/deploy.sh qa     # QA
./scripts/deploy.sh prod   # Production

# Setup Pub/Sub topics & subscriptions
./scripts/setup-pubsub.sh qa

# Cloud Scheduler (automated syncs, from repo root)
./scripts/ops/setup-scheduler.sh qa
```

---

## Testing

See [TEST-COVERAGE.md](../TEST-COVERAGE.md) for the full report.

---

## Documentation

See **CLAUDE.md** for technical details.

---

_Part of the UseMoney monorepo_
