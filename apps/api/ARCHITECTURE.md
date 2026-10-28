# API Server - Architecture

> Deep technical reference for `@usemoney/api-server`. Complements
> [`README.md`](./README.md) (quick start) and [`CLAUDE.md`](./CLAUDE.md)
> (project memory & rules).

**Stack:** Hono 4 · tRPC 11 · Node.js · Clerk (JWT verification) · Prisma
(MongoDB) **Deploy target:** Vercel Functions (mirrors server actions for mobile
& third-party consumers) **Why it exists:** Mobile apps and third-party
integrations can't call Next.js server actions. This app exposes the same
business logic as REST + tRPC endpoints.

---

## 1. System architecture

```
       ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐
       │ Mobile app   │   │ 3rd-party    │   │ Internal tools  │
       │ (React Native)│  │ integrations │   │ (CLI, scripts)  │
       └──────┬───────┘   └──────┬───────┘   └────────┬────────┘
              │                  │                    │
              └──────────────────┼────────────────────┘
                                 │
                                 ▼
                       ┌──────────────────┐
                       │   Hono router    │   ← apps/api/src/index.ts
                       │  (Vercel Fns)    │
                       └────────┬─────────┘
                                │
             ┌──────────────────┼──────────────────┐
             ▼                  ▼                  ▼
      ┌─────────────┐   ┌────────────────┐   ┌─────────────┐
      │ Clerk JWT   │   │ tRPC router    │   │ REST routes │
      │ middleware  │   │ (@usemoney/trpc)│  │ (Hono)      │
      └──────┬──────┘   └───────┬────────┘   └──────┬──────┘
             │                  │                   │
             └──────────────────┼───────────────────┘
                                │
                                ▼
                      ┌──────────────────┐
                      │ Prisma (MongoDB) │
                      │  + Redis cache   │
                      └──────────────────┘
```

---

## 2. Request flow

### tRPC call (preferred for typed clients)

1. Mobile client calls `trpc.holdings.list.query()`
2. Hono receives `POST /trpc/holdings.list` with JWT in `Authorization` header
3. **Auth middleware** verifies the Clerk JWT and resolves it to the internal
   Mongo `userId` (see §3.1)
4. tRPC handler invokes procedure from `@usemoney/trpc`
5. Procedure calls service layer, queries Prisma
6. Response serialized back through tRPC transformer

### REST call

1. External tool calls `GET /v1/holdings?broker=ZERODHA`
2. Hono router matches the route
3. Same auth middleware pattern
4. Hono route handler calls service layer, returns JSON

---

## 3. Subsystem deep-dives

### 3.1 Auth (`src/middleware/auth.ts`)

- Uses `@clerk/backend` to verify the JWT server-side (no session cookie —
  stateless)
- **Resolves the Clerk subject to the internal Mongo user `_id` ONCE** here (via
  `resolveUserId` from `@usemoney/services`) and stores THAT as `c.get("userId")`.
  Every downstream handler scopes ownership by the Mongo `_id` — never the Clerk
  id. The raw Clerk sub is kept separately as `c.get("clerkUserId")`.
  (MONEY-1062: pre-migration `c.get("userId")` held the Clerk sub, which caused
  an IDOR-inconsistency on the research routes.)
- Rejects a request without a valid Bearer token with 401, **and** a verified
  token whose subject has no matching DB user with 401 (`"User not found"`).
- The pure token-extraction + decision flow lives in `auth-logic.ts`
  (unit-tested); `optionalAuthMiddleware` keeps the same invariant but never
  blocks anonymous requests.
- `requestIdMiddleware` runs first in the stack, minting the `X-Request-Id`
  correlation header carried on every response.

### 3.2 tRPC layer (`@usemoney/trpc` shared package)

- Shared with web app so the same procedures work on both
- Adapters:
  - Web app: direct invocation (server actions → tRPC procedures)
  - API server: `@hono/trpc-server` over HTTP
- Type safety end-to-end for mobile clients using `@trpc/client`

### 3.3 REST routes (`src/routes/v1/`)

Mobile-parity surface — **28 endpoint families**, aggregated in
`src/routes/v1/index.ts` and enumerated by the exported `V1_ENDPOINTS` array
(the source of truth; `GET /v1/` and the contract test both read it). A
representative slice:

| Route                      | Purpose                                                         |
| -------------------------- | --------------------------------------------------------------- |
| `GET /v1/dashboard`        | Portfolio summary (`/portfolio`, `/returns` sub-routes)         |
| `GET /v1/holdings`         | List holdings (opt-in cursor pagination)                        |
| `GET /v1/positions`        | List positions (`/summary`, `/closed-today`, `POST /:id/close`) |
| `GET /v1/trades`           | Trade list                                                      |
| `GET /v1/paired`           | Real FIFO paired view (persisted `PairedTradeView`)             |
| `GET /v1/jobs/:jobId`      | Poll async job status (ownership-scoped)                        |
| `GET /v1/market/quotes`    | India: delayed quotes — `{ source, delayed: true }`             |
| `GET /v1/market/us/quotes` | US: per-quote provenance; `delayed` DERIVED, not asserted       |
| `GET /v1/me`               | Real profile + subscription; `PATCH /persona`, `/preferences`   |
| `GET /v1/subscription`     | Subscription status                                             |

Plus paper, fire, mutualfunds, watchlists, notifications, research, risk, tax,
brokers, discover, roast, documents, learning, credits, chat-history, quizzes,
feedback, alerts, consent — see [`CLAUDE.md`](./CLAUDE.md) for the full table.

**Cross-cutting:** ownership is always the resolved Mongo `_id`; list endpoints
support opt-in keyset (`?limit` + `?cursor`) pagination; `/v1/market/*` is
Yahoo/MFAPI **delayed** data (never a live broker feed); every response carries
`X-Request-Id`. Input is Zod-validated via `safeJson` + `zodParse`.

> There is **no** `GET /v1/dashboard/stats` or `/v1/dashboard/summary` REST
> route (stale doc drift) — the summary is served over tRPC as `dashboard.summary`.

### 3.4 Caching

- Reuses `@usemoney/cache` package (same L1 memory + L2 Redis as web app)
- Cache keys prefixed to avoid collision with web app cache

---

## 4. Deployment model

- **Hosting:** Vercel Functions (same project type as web app)
- **Regions:** Singapore (sin1) for low latency to Indian mobile users
- **Cold start:** Optimized via Hono (small bundle, no Next.js framework
  overhead)
- **Scaling:** Auto-scaled by Vercel based on traffic

---

## 5. Why Hono (not Express/Fastify)?

- **Tiny bundle:** ~14 KB gzipped vs 300+ KB for Express → faster cold starts on
  Vercel
- **Edge-compatible:** Can run on Vercel Edge if needed (not currently required)
- **Type-safe routing:** First-class TypeScript support
- **Middleware model:** Composable, testable

---

## 6. Data flow - portfolio sync example

Mobile app triggers a sync:

```
POST /v1/brokers/zerodha/sync
  ↓ Authorization: Bearer <clerk-jwt>
Hono auth middleware verifies JWT → resolves Mongo userId
  ↓
Service layer: decrypt stored Zerodha creds
  ↓
Publish Pub/Sub message → workers/sync processor
  ↓
Return 202 Accepted { jobId }
  ↓
Mobile polls GET /v1/jobs/:jobId for status
```

Worker does the actual sync asynchronously (see `workers/` app).

---

## 7. External integrations

| Integration              | Purpose                                 |
| ------------------------ | --------------------------------------- |
| **Clerk** (backend SDK)  | Stateless JWT verification              |
| **MongoDB Atlas**        | Primary datastore (shared with web app) |
| **Redis**                | L2 cache (shared with web app)          |
| **Google Cloud Pub/Sub** | Async job dispatch                      |
| **Broker APIs**          | Called during sync triggers             |

---

## 8. Security boundaries

- **JWT-only auth** - no session cookies, no CSRF concern
- **CORS** restricted to allowed origins
- **Rate limiting** per user ID
- **Same encryption conventions** as web app (AES-256-GCM for broker creds)
- **Never exposes** webhook endpoints, internal schedulers, or admin operations

---

## 9. Relationship to web app

The API server is a **thin HTTP layer over the same business logic** as the web
app:

| Layer          | Web (`apps/web`)                                                | API (`apps/api`)   |
| -------------- | --------------------------------------------------------------- | ------------------ |
| Entry          | Server actions                                                  | Hono routes + tRPC |
| Auth           | Clerk session cookie                                            | Clerk JWT          |
| Business logic | Shared (`packages/core`, `packages/services`, `@usemoney/trpc`) | Same               |
| Data           | Shared Prisma client                                            | Same               |

**Never duplicate business logic in the API server.** Put it in a shared package
so both apps consume it.

---

## See also

- [README.md](./README.md) - quick start + endpoint reference
- [CLAUDE.md](./CLAUDE.md) - project memory, conventions
- [`packages/trpc/`](../../packages/trpc/) - shared tRPC procedures
- [`packages/services/`](../../packages/services/) - business logic layer
