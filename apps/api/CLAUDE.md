# UseMoney API Server - CLAUDE.md

## Overview

A standalone Hono-based REST API server for UseMoney. This API serves as the backend for mobile apps and any client that cannot use Next.js server actions.

**Framework:** Hono
**Runtime:** Node.js
**Package:** `@usemoney/api-server`

---

## Purpose

The web app uses Next.js server actions for data operations (optimal for web). However:

- Mobile apps (React Native/Expo) cannot use server actions
- Third-party integrations need REST APIs
- Some clients prefer standard REST over server actions

This API server provides the same functionality as server actions via REST endpoints.

---

## Directory Structure

```
apps/api/
├── src/
│   ├── index.ts              # Local dev entry (starts server)
│   ├── app.ts                # Hono app setup & middleware; AppContext type
│   ├── app-logic.ts          # Pure helpers: CORS allow-list, root/404/500 bodies
│   ├── middleware/
│   │   ├── auth.ts           # Clerk JWT verify → resolve Mongo _id (calls auth-logic.ts)
│   │   ├── auth-logic.ts     # Pure token-extraction + decision flow (unit-tested)
│   │   ├── ratelimit.ts      # Rate limiting (wraps ratelimit-logic.ts)
│   │   ├── ratelimit-logic.ts
│   │   └── request-id.ts     # Mints X-Request-Id, sets c.get("requestId") (first in stack)
│   ├── routes/
│   │   ├── health.ts         # Health check endpoints
│   │   ├── trpc.ts           # tRPC adapter
│   │   └── v1/
│   │       ├── index.ts      # V1 aggregator + exported V1_ENDPOINTS catalogue (38 families)
│   │       ├── pagination.ts # Shared page/limit clamps + keyset (cursor) helpers
│   │       └── <domain>.ts   # 38 route modules (see API Endpoints below)
│   └── lib/
│       └── response.ts       # Response + request-parse helpers (re-exports @usemoney/api-utils)
├── __tests__/                # HTTP contract + helper tests
├── dist/                     # Compiled output
├── vercel.json
├── package.json
└── tsconfig.json
```

---

## Key Files

### Entry Point (`src/index.ts`)

Starts the Hono server on port 8080 (or PORT env).

### App Setup (`src/app.ts`)

| Export       | Description                                                                      |
| ------------ | -------------------------------------------------------------------------------- |
| `app`        | Hono app instance                                                                |
| `AppContext` | Type-safe context: `userId` (Mongo \_id), `clerkUserId` (Clerk sub), `requestId` |

**Middleware Stack (in order):**

1. `requestIdMiddleware` - Mints `X-Request-Id` FIRST so every downstream handler + the error/404 bodies carry it (on `*`)
2. `logger()` - Request logging
3. `prettyJSON()` - JSON formatting
4. `secureHeaders()` - Security headers
5. `cors()` - CORS with environment-specific origins (exposes `X-Request-Id`)
6. `rateLimitMiddleware` - Rate limiting (on `/v1/*` and `/trpc/*`)
7. `authMiddleware` - Clerk JWT verification + Mongo-id resolution (on `/v1/*` and `/trpc/*`)

### Auth Middleware (`src/middleware/auth.ts`)

Verifies the Clerk JWT from the `Authorization: Bearer <token>` header, then
**resolves the Clerk subject to the internal Mongo user `_id` ONCE** (via
`resolveUserId` from `@usemoney/services`) and stores THAT as `c.get("userId")`.

```typescript
// c.set("userId", <Mongo _id>)      ← every handler scopes ownership by this
// c.set("clerkUserId", <Clerk sub>) ← raw JWT sub, kept for reference
```

- Pre-MONEY-1062, `c.get("userId")` held the CLERK sub; now it is ALWAYS the
  resolved Mongo `_id`. This closed an IDOR-inconsistency (e.g. research
  `/status` + `/result` scoped by the wrong id).
- A verified token with **no matching DB user → 401** (`"User not found"`).
- `optionalAuthMiddleware` keeps the same invariant when a token is present, but
  never blocks anonymous requests.
- The token-extraction + verify→check-sub→decision flow lives in
  `auth-logic.ts` as pure functions (unit-tested against the real source).

### Response Helpers (`src/lib/response.ts`)

Re-exports from `@usemoney/api-utils` (+ subpaths) with Hono-specific helpers.

| Function                         | Description                                                          |
| -------------------------------- | -------------------------------------------------------------------- |
| `success(data, meta?)`           | Standard success response                                            |
| `error(code, message, details?)` | Standard error response (`ErrorCodes` enum)                          |
| `paginated(items, meta)`         | Offset-paginated envelope (`total`/`page`/`limit`)                   |
| `paginatedCursor(items, next)`   | Keyset (cursor) envelope for list endpoints                          |
| `safeJson(c)`                    | Parse the request body, mapping malformed JSON → typed failure (400) |
| `zodParse(schema, data)`         | Zod validation → `{ ok, data }` or `{ ok:false, issues }` (400)      |
| `encodeCursor` / `decodeCursor`  | Opaque cursor codec (`@usemoney/api-utils/pagination`)               |

`safeJson` + `zodParse` come from `@usemoney/api-utils/request`; the cursor
codec from `@usemoney/api-utils/pagination` — both added in the mobile-parity
build so handlers validate input instead of trusting it.

**Response Format:**

```typescript
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  meta?: { total?: number; page?: number; limit?: number };
}
```

---

## API Endpoints

### Health (`/health`)

| Endpoint        | Method | Auth | Description                             |
| --------------- | ------ | ---- | --------------------------------------- |
| `/health`       | GET    | No   | Basic health check                      |
| `/health/ready` | GET    | No   | Readiness + dependency status (200/503) |
| `/health/live`  | GET    | No   | Liveness probe ("OK")                   |

### V1 Routes (`/v1/`)

All V1 routes require authentication (Bearer token).

#### Dashboard (`/v1/dashboard`)

| Endpoint                  | Method | Description                    |
| ------------------------- | ------ | ------------------------------ |
| `/v1/dashboard`           | GET    | Portfolio summary stats        |
| `/v1/dashboard/portfolio` | GET    | Portfolio breakdown (segments) |
| `/v1/dashboard/returns`   | GET    | Returns aggregates             |

> There is **no** `/v1/dashboard/summary` or `/v1/dashboard/stats` REST route
> (both were stale doc drift). The `dashboard.summary` tRPC procedure is
> **mounted but NOT implemented** — it throws `NOT_IMPLEMENTED` (MONEY-1062).
> Use the REST route `GET /v1/dashboard` for the summary.

#### Holdings (`/v1/holdings`)

| Endpoint               | Method | Description                         |
| ---------------------- | ------ | ----------------------------------- |
| `/v1/holdings`         | GET    | List holdings (opt-in cursor paged) |
| `/v1/holdings/summary` | GET    | Holdings summary aggregates         |
| `/v1/holdings/:id`     | DELETE | Delete a manual holding             |

> Holdings are broker-synced, so there is no create/update REST route (only
> list + summary + delete of manual rows).

#### Positions (`/v1/positions`)

| Endpoint                     | Method | Description                    |
| ---------------------------- | ------ | ------------------------------ |
| `/v1/positions`              | GET    | List positions (day/overnight) |
| `/v1/positions/summary`      | GET    | Positions summary aggregates   |
| `/v1/positions/closed-today` | GET    | Intraday squared-off positions |
| `/v1/positions/:id/close`    | POST   | Close position                 |

#### Trades (`/v1/trades`)

| Endpoint         | Method | Description             |
| ---------------- | ------ | ----------------------- |
| `/v1/trades`     | GET    | List trades (paginated) |
| `/v1/trades`     | POST   | Create trade            |
| `/v1/trades/:id` | PUT    | Update trade            |
| `/v1/trades/:id` | DELETE | Delete trade            |

> Update is **`PUT /:id`** (not PATCH), and there is no `GET /v1/trades/:id`
> single-trade route.

#### Paired Trades (`/v1/paired`)

Real (MONEY-729) — backed by the persisted `PairedTradeView` the Cloud Run
worker writes on every sync/import (was a stub pre-migration).

| Endpoint           | Method | Description                            |
| ------------------ | ------ | -------------------------------------- |
| `/v1/paired`       | GET    | List FIFO paired trades (cursor-paged) |
| `/v1/paired/stats` | GET    | Paired-trade summary stats             |

### Full v1 catalogue (38 families)

`GET /v1/` returns the canonical list from the exported `V1_ENDPOINTS` array
(`src/routes/v1/index.ts`) — the source of truth (the info handler and the
contract test both read it). The 38 mounted families:

| Family                | Notes                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `/v1/dashboard`       | `/`, `/portfolio`, `/returns`                                                                |
| `/v1/holdings`        | CRUD; list supports opt-in cursor pagination                                                 |
| `/v1/positions`       | list, `/summary`, `/closed-today`, `POST /:id/close`                                         |
| `/v1/trades`          | CRUD + `GET /fys` (available financial years); list emits paginate meta                      |
| `/v1/paired`          | real FIFO view + `/stats`                                                                    |
| `/v1/paper`           | Paper trading — `GET /`, `POST /` (buy), `POST /:id/close` (sell), `DELETE /:id`             |
| `/v1/fire`            | FIRE scenarios + `POST /:id/chat` (append message) + `POST /:id/turn` (Ask FIRE engine turn) |
| `/v1/mutualfunds`     | MF holdings (cursor-paged list) + manual `POST /` + `DELETE /:id`                            |
| `/v1/watchlists`      | Watchlist CRUD + `PATCH /:id`, `POST /:id/reorder`, `POST /:id/items/batch`                  |
| `/v1/notifications`   | List + mark-read + `GET /unread-count`                                                       |
| `/v1/research`        | AI research sessions + `POST /` start (credits-gated, 202 + poll)                            |
| `/v1/risk`            | Portfolio risk analysis                                                                      |
| `/v1/tax`             | Tax analysis & reports                                                                       |
| `/v1/subscription`    | Subscription status + `GET /access` (computed entitlement gates)                             |
| `/v1/brokers`         | Broker connections + sync triggers (`POST /:id/sync`, `/sync-all`, historical)               |
| `/v1/jobs`            | `GET /:jobId` — poll async job status (ownership-scoped in the service)                      |
| `/v1/market`          | India delayed quotes / OHLC / indices / MF-NAV / composition; `us/quotes` DERIVES `delayed`  |
| `/v1/discover`        | Discovery & search + the P14 data-engine sections; see the list below                        |
| `/v1/me`              | Profile; persona/preferences; terms + trial; research/composer prefs; delete-OTP             |
| `/v1/roast`           | Roast start (`POST /`, credits-gated) + can-use, history, status, cancel, delete             |
| `/v1/documents`       | User document list, detail & `DELETE /:id` (soft)                                            |
| `/v1/learning`        | Courses, lessons, progress + `POST /enroll`, `GET /glossary`                                 |
| `/v1/credits`         | Credit balance & usage history                                                               |
| `/v1/chat-history`    | Chat history + archive/unarchive/rename (`PATCH`)                                            |
| `/v1/quizzes`         | Lesson quizzes (read & score)                                                                |
| `/v1/feedback`        | Feedback tickets (submit & list) + thread/replies/close                                      |
| `/v1/alerts`          | Price/news alert CRUD                                                                        |
| `/v1/consent`         | AI-advisory consent ledger (SEBI 18(9))                                                      |
| `/v1/imports`         | Trade import — async enqueue (`POST /`, 202+jobId), history, retry, delete                   |
| `/v1/compare`         | Comparison sessions — start (reservation-gated) + status/result polling                      |
| `/v1/analysis`        | L3 comprehensive analysis — start, status, result, cancel                                    |
| `/v1/stocks`          | `GET /:symbol/<section>` — 18 sections; see the list below                                   |
| `/v1/news`            | News feed, per-stock news, market pulse, events, daily brief (personalized)                  |
| `/v1/result-feedback` | Per-AI-result thumbs (submit/clear/hydrate; bandit outcome recorded)                         |
| `/v1/screener`        | Stock/MF/ETF screeners (POST, filter payloads; Atlas-vs-regex dual path)                     |
| `/v1/scans`           | Scan catalog (166) + fail-closed inline runs                                                 |
| `/v1/strategies`      | Presets + custom strategies CRUD + async run (202+jobId)                                     |
| `/v1/saved-screens`   | Saved screener configs (CRUD, userId-scoped)                                                 |

#### `/v1/stocks/:symbol/<section>` (all `GET`, global, Bearer required)

Legacy stock-detail tabs (MONEY-1062 P4): `financials` (`?periodType=`), `peers`,
`news` (`?limit=`), `returns`, `shareholding`, `ratios`, `technicals`,
`corporate-actions`.

MONEY-1204 / P14 data-engine sections: `flags`, `delivery`, `derivatives`,
`shareholding-pattern`, `insider-activity`, `deals`, `filings`,
`financials-source`, `funds-holding`, `circulars`
(`?departments=`&`?limit=`&`?days=`).

`shareholding-pattern` is NOT a variant of `shareholding` — they read different
tables whose `quarter` strings do not join. All P14 sections return the
provenance envelope `{ data, source, asOf, empty }`; `empty: true` is a **200**,
never a 404.

#### `/v1/discover/*` (all `GET`, global, Bearer required)

Discovery: `markets`, `search`, `mfs`, `mfs/by-scheme-codes`, `mf-compare`,
`sectors`, `sectors/:sector`, `sectors/:sector/stocks`, `heatmap`, `etfs`,
`instruments`.

MONEY-1204 / P14 data-engine sections (provenance envelope, same contract as
above): `flows`, `positioning`, `macro`, `ipos`, `ipos/dashboard`, `circulars`,
`indices/:slug`, `mfs/:schemeCode/portfolio`.

`mfs/:schemeCode/portfolio` (a fund's SEBI-disclosed holdings) is here rather
than on `/v1/mutualfunds` because it is **global** reference data —
`/v1/mutualfunds` is entirely the caller's own holdings and every handler in it
is `userId`-scoped. `indices/:slug` 404s only when the slug names no index at
all; an index with no constituent list is a normal 200 with an empty
constituents block.

**Cross-cutting invariants (MONEY-1062 / mobile-parity):**

- **Ownership** everywhere is the resolved Mongo `_id` from `authMiddleware`.
- **`/v1/me`** is a real profile (was a `clerkId` echo). GET composes profile +
  subscription (best-effort); PATCH is mass-assignment-guarded in the service.
- **`/v1/market`** is Yahoo/MFAPI **delayed** data for INDIA — never a live
  broker feed. Those payloads carry `{ source, delayed: true }` (and each quote
  object echoes `delayed: true`) so a client can't render one as a real-time
  tick. Market endpoints require a Bearer token but pass **no** userId (data is
  global).
  - **`/v1/market/us/quotes` is the exception** (MONEY-1309). It reads our own
    realtime Redis keys with the `candles` EOD close behind them — zero vendor
    requests — so `delayed` is **derived**, never asserted: per quote via
    `isLiveQuoteProvenance(q.provenance)`, and for the envelope pessimistically
    (live only when EVERY quote in the batch is). Still explicit in the payload,
    still not a broker feed. A client must read the per-quote `provenance
{source, asOf, fallback}` rather than assume the batch flag applies to each
    row.
- **Cursor pagination** on the portfolio list endpoints (holdings / positions /
  mutual funds) is **opt-in** via `?limit` — absent `?limit` returns the full
  unbounded list (pre-pagination behaviour preserved); present, it clamps to
  `[1, 100]` and decodes the opaque `?cursor`.
- **`X-Request-Id`** response header is present on every response.

### tRPC (`/trpc/*`)

Mounts the shared `@usemoney/trpc` router (behind auth + rate-limit). **Every
procedure currently throws `NOT_IMPLEMENTED`** (MONEY-1062) and names the REST
`/v1` route to use instead — the tRPC surface is a typed skeleton, not a working
data source. Use the `/v1` REST endpoints above.

---

## Dependencies

| Package               | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `hono`                | Web framework                                      |
| `@hono/node-server`   | Node.js adapter                                    |
| `@hono/trpc-server`   | tRPC-over-HTTP adapter                             |
| `@clerk/backend`      | JWT verification                                   |
| `@usemoney/core`      | Business logic                                     |
| `@usemoney/services`  | Service layer — every v1 handler + `resolveUserId` |
| `@usemoney/database`  | Prisma client                                      |
| `@usemoney/cache`     | Redis caching                                      |
| `@usemoney/types`     | Shared types                                       |
| `@usemoney/trpc`      | tRPC router                                        |
| `@usemoney/api-utils` | Shared API utilities (safeJson, zodParse, cursor)  |

---

## Environment Variables

```bash
# Required
PORT=8080
DATABASE_URL=mongodb+srv://...
REDIS_URL=redis://...
CLERK_SECRET_KEY=sk_...

# CORS Origins
WEB_URL=https://usemoney.ai
ADMIN_URL=https://admin.usemoney.ai
NODE_ENV=production  # production, qa, development
```

---

## CORS Configuration

| Environment | Origins                                         |
| ----------- | ----------------------------------------------- |
| Production  | usemoney.ai, www.usemoney.ai, admin.usemoney.ai |
| QA          | qa.usemoney.ai, admin.qa.usemoney.ai, localhost |
| Development | localhost:3000, localhost:3001, localhost:8080  |

---

## Development

```bash
# Run dev server with hot reload
yarn dev

# Build
yarn build

# No start script — deployed as Vercel serverless (vercel.json); locally run node dist/index.js after build

# Type check
yarn type-check

# Lint
yarn lint
```

---

## What's Been Completed

- [x] Hono app setup with middleware
- [x] Clerk JWT authentication → **Mongo `_id` resolution** (resolved once; no-DB-user → 401)
- [x] Rate limiting
- [x] CORS configuration (env-aware)
- [x] `X-Request-Id` correlation middleware
- [x] Health check endpoints
- [x] Full mobile-parity REST surface — **38 `/v1` endpoint families** (dashboard,
      holdings, positions, trades, paired, paper, fire, mutualfunds, watchlists,
      notifications, research, risk, tax, subscription, brokers, jobs, market,
      discover, me, roast, documents, learning, credits, chat-history, quizzes,
      feedback, alerts, consent, imports, compare, analysis, stocks, news,
      result-feedback, screener, scans, strategies, saved-screens)
- [x] Real `/v1/me` profile, `/v1/jobs/:jobId` polling, real `/v1/paired`
- [x] Delayed India market data with a `delayed:true` compliance flag, and US
      quotes with a DERIVED per-quote `delayed` + `provenance` (MONEY-1309)
- [x] Request validation (Zod via `safeJson` + `zodParse`)
- [x] Cursor (keyset) pagination on portfolio list endpoints
- [x] First HTTP contract tests
- [x] tRPC adapter
- [x] Standard response format

---

## What Needs to Be Done

### High Priority

- [x] Paper, FIRE, mutual funds, broker endpoints — shipped
- [x] Market data endpoints — shipped (`/v1/market/*`, delayed)
- [x] Request validation (Zod) — shipped (`safeJson` + `zodParse`)
- [x] Engagement surface (me, roast, documents, learning, credits, chat-history,
      quizzes, feedback, alerts, consent) — `src/routes/v1/index.ts` now mounts
      **38** modules (incl. the P2 async-trigger + P4 heavy-extraction families)

### Medium Priority

- [ ] OpenAPI/Swagger documentation — **deferred (MONEY-1069 / MONEY-719)**.
      The root-info body (`GET /`) advertises `documentation: "/docs"`, but that
      route is not built yet — treat it as aspirational until the OpenAPI work lands.
- [ ] API versioning strategy
- [ ] Better error codes
- [ ] Chat SSE streaming over REST — deferred (chat stays on the web app)

### Low Priority

- [ ] GraphQL adapter (optional)
- [ ] WebSocket support
- [ ] API key authentication (non-Clerk)

---

## Deployment

### Vercel

Currently deployed on Vercel with `vercel.json`:

- Serverless function deployment
- Automatic scaling

### GCP Cloud Run (Planned)

For mobile app production:

- Docker container
- Auto-scaling
- Lower latency in India (asia-south1)

---

## Test Coverage

See [`../../TEST-COVERAGE.md`](../../TEST-COVERAGE.md) for the full report.

> **Rule:** When adding tests for this app, update `TEST-COVERAGE.md` in the repo root.

---

## Restrictions & Guidelines

### Code Standards

- TypeScript strict mode
- Use `@usemoney/core` for business logic
- Don't duplicate logic from web app
- Standard response format for all endpoints

### Security

- All data routes require auth
- Rate limiting on all authenticated routes
- Never expose internal errors
- Log errors server-side only

### Architecture

- Routes are thin wrappers around core services
- No database access in route handlers
- Use core package services for all operations

---

_Last Updated: July 2026_
