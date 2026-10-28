# UseMoney API Server

> **REST API for UseMoney Mobile & Third-Party Integrations**

A Hono-based REST API server deployed on **Vercel**. Provides REST endpoints for mobile apps and third-party integrations that cannot use Next.js server actions.

[![Hono](https://img.shields.io/badge/Hono-4.x-orange)](https://hono.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)

---

## Environments

| Environment | API URL                      | Web URL                  | Branch            |
| ----------- | ---------------------------- | ------------------------ | ----------------- |
| Local       | `http://localhost:8080`      | `http://localhost:3000`  | -                 |
| QA          | `https://api.qa.usemoney.ai` | `https://qa.usemoney.ai` | `develop`, `qa/*` |
| Production  | `https://api.usemoney.ai`    | `https://usemoney.ai`    | `main`            |

---

## Quick Start

```bash
# From monorepo root
yarn install
yarn workspace @usemoney/api-server dev

# Or from apps/api
cd apps/api && yarn dev
```

Server runs at `http://localhost:8080`

---

## API Endpoints Reference

### Health Check (No Auth)

| Endpoint           | Method | Description        |
| ------------------ | ------ | ------------------ |
| `/health`          | GET    | Basic health check |
| `/health/ready`    | GET    | Readiness probe    |
| `/health/live`     | GET    | Liveness probe     |
| `/health/detailed` | GET    | DB + Redis status  |

### Dashboard (`/v1/dashboard`)

| Endpoint                      | Method | Description                    |
| ----------------------------- | ------ | ------------------------------ |
| `GET /v1/dashboard`           | GET    | Portfolio summary stats        |
| `GET /v1/dashboard/portfolio` | GET    | Portfolio breakdown (segments) |
| `GET /v1/dashboard/returns`   | GET    | Returns aggregates             |

> No `GET /v1/dashboard/summary` REST route exists — the detailed summary is a
> tRPC procedure (`dashboard.summary`).

### Holdings (`/v1/holdings`)

| Endpoint                   | Method | Description                         |
| -------------------------- | ------ | ----------------------------------- |
| `GET /v1/holdings`         | GET    | List holdings (opt-in cursor paged) |
| `GET /v1/holdings/summary` | GET    | Holdings summary aggregates         |
| `DELETE /v1/holdings/:id`  | DELETE | Delete a manual holding             |

### Positions (`/v1/positions`)

| Endpoint                         | Method | Description                    |
| -------------------------------- | ------ | ------------------------------ |
| `GET /v1/positions`              | GET    | List positions                 |
| `GET /v1/positions/summary`      | GET    | Positions summary aggregates   |
| `GET /v1/positions/closed-today` | GET    | Intraday squared-off positions |
| `POST /v1/positions/:id/close`   | POST   | Close position                 |

### Trades (`/v1/trades`)

| Endpoint                | Method | Description             |
| ----------------------- | ------ | ----------------------- |
| `GET /v1/trades`        | GET    | List trades (paginated) |
| `POST /v1/trades`       | POST   | Create trade            |
| `PUT /v1/trades/:id`    | PUT    | Update trade            |
| `DELETE /v1/trades/:id` | DELETE | Delete trade            |

### Paired Trades (`/v1/paired`)

| Endpoint         | Method | Description             |
| ---------------- | ------ | ----------------------- |
| `GET /v1/paired` | GET    | List FIFO paired trades |

### Paper Trading (`/v1/paper`)

| Endpoint              | Method | Description           |
| --------------------- | ------ | --------------------- |
| `GET /v1/paper`       | GET    | Get paper portfolio   |
| `POST /v1/paper/buy`  | POST   | Buy virtual position  |
| `POST /v1/paper/sell` | POST   | Sell virtual position |

### FIRE Calculator (`/v1/fire`)

| Endpoint        | Method | Description         |
| --------------- | ------ | ------------------- |
| `GET /v1/fire`  | GET    | List FIRE scenarios |
| `POST /v1/fire` | POST   | Create scenario     |

### Mutual Funds (`/v1/mutualfunds`)

| Endpoint              | Method | Description       |
| --------------------- | ------ | ----------------- |
| `GET /v1/mutualfunds` | GET    | List mutual funds |

### Watchlists (`/v1/watchlists`)

| Endpoint              | Method | Description      |
| --------------------- | ------ | ---------------- |
| `GET /v1/watchlists`  | GET    | List watchlists  |
| `POST /v1/watchlists` | POST   | Create watchlist |

### Notifications (`/v1/notifications`)

| Endpoint                      | Method | Description        |
| ----------------------------- | ------ | ------------------ |
| `GET /v1/notifications`       | GET    | List notifications |
| `PATCH /v1/notifications/:id` | PATCH  | Mark as read       |

### Research (`/v1/research`)

| Endpoint           | Method | Description            |
| ------------------ | ------ | ---------------------- |
| `GET /v1/research` | GET    | List research sessions |

### Risk & Tax (`/v1/risk`, `/v1/tax`)

| Endpoint       | Method | Description   |
| -------------- | ------ | ------------- |
| `GET /v1/risk` | GET    | Risk analysis |
| `GET /v1/tax`  | GET    | Tax analysis  |

### Subscription (`/v1/subscription`)

| Endpoint               | Method | Description      |
| ---------------------- | ------ | ---------------- |
| `GET /v1/subscription` | GET    | Get subscription |

### Brokers, Jobs, Market & Discover

| Endpoint                    | Method | Description                                            |
| --------------------------- | ------ | ------------------------------------------------------ |
| `GET /v1/brokers`           | GET    | Broker connections (read/manage)                       |
| `GET /v1/jobs/:jobId`       | GET    | Poll async job status (ownership-scoped)               |
| `GET /v1/market/quotes`     | GET    | Batch **delayed** quotes — `{ source, delayed: true }` |
| `GET /v1/market/us/quotes`  | GET    | US quotes — per-quote provenance, `delayed` DERIVED    |
| `GET /v1/market/historical` | GET    | Delayed OHLC candles                                   |
| `GET /v1/market/indices`    | GET    | Market indices (delayed)                               |
| `GET /v1/market/mf-nav`     | GET    | Mutual-fund NAV history (EOD)                          |
| `GET /v1/discover/*`        | GET    | Stock/MF/sector discovery & search                     |

> Every INDIA route under `/v1/market/*` is Yahoo/MFAPI **delayed** data (not a
> live broker feed) and carries a `delayed: true` compliance flag.
>
> `GET /v1/market/us/quotes` is the one exception and it is deliberate: a US
> quote comes from our own realtime store or from the `candles` EOD close
> standing in for one. Each quote therefore carries its own provenance
> (`source`, `asOf`, `fallback`) and `delayed` is **derived** — per quote, and
> pessimistically for the envelope (live only when every quote in the batch is).
> Still explicit in the payload, still never a live broker feed; just not always
> `true`.

### Engagement surface (mobile-parity)

| Endpoint                   | Method     | Description                                |
| -------------------------- | ---------- | ------------------------------------------ |
| `GET /v1/me`               | GET        | Authenticated profile + subscription       |
| `PATCH /v1/me/persona`     | PATCH      | Set StockSage chat persona                 |
| `PATCH /v1/me/preferences` | PATCH      | Update editable profile settings (guarded) |
| `GET /v1/roast`            | GET        | Portfolio roast history & results          |
| `GET /v1/documents`        | GET        | User documents                             |
| `GET /v1/learning`         | GET        | Courses, lessons & progress                |
| `GET /v1/credits`          | GET        | Credit balance & usage                     |
| `GET /v1/chat-history`     | GET        | AI chat session history                    |
| `/v1/quizzes`              | GET        | Lesson quizzes (read & score)              |
| `/v1/feedback`             | GET / POST | Feedback tickets                           |
| `/v1/alerts`               | CRUD       | Price/news alerts                          |
| `/v1/consent`              | GET / POST | AI-advisory consent ledger (SEBI 18(9))    |

**28 `/v1` endpoint families total** — the canonical list is the exported
`V1_ENDPOINTS` array in `src/routes/v1/index.ts`, surfaced by `GET /v1/`.
Ownership is always the resolved Mongo `_id`; list endpoints support opt-in
cursor pagination; every response carries an `X-Request-Id` header.

### tRPC (`/trpc/*`)

| Endpoint                       | Description       |
| ------------------------------ | ----------------- |
| `POST /trpc/dashboard.summary` | Dashboard summary |
| `POST /trpc/holdings.list`     | List holdings     |
| `POST /trpc/positions.list`    | List positions    |
| `POST /trpc/trades.list`       | List trades       |
| `POST /trpc/trades.paired`     | Paired trades     |

---

## Authentication

All `/v1/*` endpoints require Bearer token authentication:

```bash
curl -H "Authorization: Bearer <clerk_jwt_token>" \
     https://api.usemoney.ai/v1/holdings
```

---

## Response Format

```typescript
// Success
{
  "success": true,
  "data": { ... },
  "meta": { "total": 100, "page": 1, "limit": 20 }
}

// Error
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Resource not found"
  }
}
```

---

## Project Structure

```
apps/api/
├── src/
│   ├── index.ts              # Local dev entry
│   ├── app.ts                # Hono app setup
│   ├── middleware/
│   │   ├── auth.ts           # Clerk JWT verification
│   │   └── ratelimit.ts      # Rate limiting
│   ├── routes/
│   │   ├── health.ts         # Health endpoints
│   │   ├── trpc.ts           # tRPC adapter
│   │   └── v1/               # REST API v1
│   │       ├── index.ts      # Route aggregator
│   │       ├── dashboard.ts  # Dashboard routes
│   │       ├── holdings.ts   # Holdings CRUD
│   │       ├── positions.ts  # Positions CRUD
│   │       ├── trades.ts     # Trades CRUD
│   │       └── paired.ts     # Paired trades
│   └── lib/
│       └── response.ts       # Response helpers
├── dist/                     # Build output
├── vercel.json               # Vercel config
└── package.json
```

---

## Middleware Reference

| Middleware            | File                           | Description                                                    |
| --------------------- | ------------------------------ | -------------------------------------------------------------- |
| `requestIdMiddleware` | `src/middleware/request-id.ts` | Mints `X-Request-Id` (first in stack)                          |
| `authMiddleware`      | `src/middleware/auth.ts`       | Clerk JWT verify → resolves & sets the internal Mongo `userId` |
| `rateLimitMiddleware` | `src/middleware/ratelimit.ts`  | Request rate limiting                                          |

---

## Response Helpers (`src/lib/response.ts`)

| Function                         | Description             |
| -------------------------------- | ----------------------- |
| `success(data, meta?)`           | Create success response |
| `error(code, message, details?)` | Create error response   |

---

## Dependencies

| Package               | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `hono`                | Web framework                                      |
| `@hono/node-server`   | Node.js adapter                                    |
| `@hono/trpc-server`   | tRPC integration                                   |
| `@clerk/backend`      | JWT verification                                   |
| `@usemoney/core`      | Business logic                                     |
| `@usemoney/services`  | Service layer — every v1 handler + `resolveUserId` |
| `@usemoney/database`  | Prisma client                                      |
| `@usemoney/cache`     | Redis caching                                      |
| `@usemoney/trpc`      | tRPC router                                        |
| `@usemoney/api-utils` | Shared API utilities (safeJson, zodParse, cursor)  |

---

## Environment Variables

```bash
# Server
PORT=8080
NODE_ENV=production

# Database
DATABASE_URL=mongodb+srv://...

# Redis
REDIS_URL=redis://...

# Auth
CLERK_SECRET_KEY=sk_...

# CORS
WEB_URL=https://usemoney.ai
ADMIN_URL=https://admin.usemoney.ai

# GCP (optional)
GCP_PROJECT_ID=stock-book-483718
GCP_STORAGE_BUCKET=stockbook-learning-content
GCP_SERVICE_ACCOUNT_KEY_BASE64=...
```

---

## Development Commands

```bash
# Dev server with hot reload
yarn dev

# Build
yarn build

# Type check
yarn type-check

# Lint
yarn lint
```

---

## Vercel Deployment

### Setup

```bash
cd apps/api
vercel link
```

Or in Vercel Dashboard:

1. Import from GitHub
2. Select `usemoney-monorepo`
3. Set Root Directory: `apps/api`
4. Framework Preset: `Other`

### Domain Configuration

| Domain               | Environment |
| -------------------- | ----------- |
| `api.qa.usemoney.ai` | Preview     |
| `api.usemoney.ai`    | Production  |

### Git Branch Configuration

- **Production Branch:** `main`
- **Preview Branches:** `develop`, `qa/*`, `feature/*`

---

## GCP Infrastructure

### Storage

- **Project ID:** `stock-book-483718`
- **Region:** `asia-south1`
- **Bucket:** `stockbook-learning-content`

### Service Account

```bash
# Storage access
gcloud projects add-iam-policy-binding stock-book-483718 \
  --member="serviceAccount:stockbook-api@stock-book-483718.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"
```

### Background Workers (Cloud Run)

Long-running tasks are processed by the workers service via Google Cloud Pub/Sub:

```
Vercel (API Server) → Pub/Sub Topics → Cloud Run (Workers)
```

See [workers/README.md](../../workers/README.md) for details.

---

## Troubleshooting

### Local Development

```bash
# Check if port is in use
lsof -i :8080

# Run with debug
DEBUG=* yarn dev
```

### Vercel Deployment

```bash
# Check logs
vercel logs --follow
```

### GCP Storage

```bash
# Test access
gsutil ls gs://stockbook-learning-content
```

---

## Testing

See [TEST-COVERAGE.md](../../TEST-COVERAGE.md) for the full report.

---

## Documentation

- **CLAUDE.md** - Technical details for AI assistants
- **Root CLAUDE.md** - Project-wide context

---

_Part of the UseMoney monorepo_
