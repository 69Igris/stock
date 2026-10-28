# Web App - Architecture

> Deep technical reference for `@usemoney/web`. Complements [`README.md`](./README.md) (quick start) and [`CLAUDE.md`](./CLAUDE.md) (project memory & rules).

**Stack:** Next.js 14.2 (App Router) · React 18 · TypeScript · Clerk · MongoDB via Prisma · Redis · Google Cloud Pub/Sub · Dodo Payments
**Deploy target:** Vercel (production: [usemoney.ai](https://usemoney.ai))
**Runtime:** Node.js (some streaming routes on Edge)

---

## 1. System architecture

```
                         ┌──────────────────────────────┐
                         │         Browser              │
                         │  (Next.js SSR + client JS)   │
                         └──────────────┬───────────────┘
                                        │
                     ┌──────────────────┼──────────────────┐
                     │                  │                  │
                     ▼                  ▼                  ▼
            ┌─────────────────┐ ┌─────────────────┐ ┌───────────────────┐
            │  Next.js Pages  │ │  Server Actions │ │   API Routes      │
            │  (RSC + Client) │ │  (lib/actions)  │ │  (app/api/*)      │
            └────────┬────────┘ └────────┬────────┘ └─────────┬─────────┘
                     │                   │                    │
                     └───────┬───────────┴──────┬─────────────┘
                             │                  │
                             ▼                  ▼
                     ┌───────────────┐  ┌─────────────────┐
                     │ Auth (Clerk)  │  │ Subscription    │
                     │ Middleware    │  │ Access Guard    │
                     └───────┬───────┘  └────────┬────────┘
                             │                   │
                  ┌──────────┼───────────────────┼──────────────┐
                  │          │                   │              │
                  ▼          ▼                   ▼              ▼
          ┌──────────┐ ┌──────────┐     ┌──────────────┐ ┌──────────┐
          │ MongoDB  │ │  Redis   │     │  Pub/Sub     │ │  Gemini  │
          │ (Prisma) │ │ (cache)  │     │  (workers)   │ │   AI     │
          └──────────┘ └──────────┘     └──────┬───────┘ └──────────┘
                                               │
                                               ▼
                                      ┌────────────────┐
                                      │  Cloud Run     │
                                      │  Workers       │
                                      │  (apps/workers)│
                                      └────────────────┘
```

---

## 2. Request flow

### Page load (authenticated)

1. Browser requests `/dashboard`
2. **Clerk middleware** (`middleware.ts`) validates session cookie
   - Unauthenticated → redirect to `/sign-in?redirect_url=...`
   - Authenticated → attach `userId` to request
3. **Next.js App Router** resolves the RSC for the route
4. RSC calls **server action** (e.g., `getDashboardStatsAction()`)
5. Server action:
   - `getAuthenticatedUser()` - deduped via React `cache()`, returns `{ userId }`
   - Prisma query against MongoDB (pooled connection, `maxPoolSize=10`)
   - Redis L2 cache (stale-while-revalidate for expensive aggregations)
6. RSC renders HTML with streamed data

### Server action call from client

1. Client component calls `someAction()` (looks like a function, but is a POST)
2. Next.js framework does `POST /<pathname>` with encoded action args
3. Middleware validates auth
4. Server action runs, returns `{ success, data, error }`
5. Client receives typed response, updates state

### Broker OAuth flow (example: Zerodha)

1. User clicks "Connect Zerodha" → redirected to Zerodha's OAuth URL
2. User approves → Zerodha redirects to `/api/brokers/zerodha/callback?request_token=...`
3. Callback route:
   - Exchanges `request_token` for `access_token` via Zerodha API
   - AES-256-GCM encrypts the token with per-user key
   - Stores in `BrokerConnection.encryptedCreds`
   - Publishes `broker-sync` message to Pub/Sub
4. Worker picks up job, syncs holdings/positions/trades
5. User redirected to `/brokers?connected=zerodha`

---

## 3. Subsystem deep-dives

### 3.1 Auth layer (`middleware.ts` + `lib/auth.ts`)

- **`middleware.ts`** - Clerk `clerkMiddleware` at the edge. Checks route category (public / API / app), performs auth.
- **`lib/auth.ts`** - `getAuthenticatedUser()` wraps `auth()` + `getOrCreateDbUser()` in React `cache()`. Used by ALL server actions.
- **`lib/db/user.ts`** - `getOrCreateDbUser(clerkUserId)`:
  - Fast path: `findUnique({ clerkId })` - single indexed query, no Clerk API call
  - Slow path (new user): `currentUser()` from Clerk → create
- **`lib/subscription/access.ts`** - `getSubscriptionAccess()` uses `findUnique({ clerkId })` directly, no `currentUser()` call.

**Perf:** ~200-600 ms saved per authenticated request by avoiding `currentUser()` on the hot path.

### 3.2 Caching (`lib/cache/`)

Three-tier cache:

| Layer | Where                                | TTL              | Purpose                |
| ----- | ------------------------------------ | ---------------- | ---------------------- |
| L1    | In-memory (LRUCache, process-scoped) | 10 s             | Hot data dedup         |
| L2    | Redis (DigitalOcean managed)         | 5 min            | Cross-request cache    |
| L3    | Stale-while-revalidate               | 1 h stale window | Expensive aggregations |

- Graceful fallback: Redis unavailable → serve from memory
- Stats/hit rates exposed at `/api/cache/stats`

### 3.3 Broker integration (`lib/brokers/`)

Six brokers, adapter pattern:

```
                     ┌───────────────────────┐
                     │  BrokerAdapter        │  ← shared interface
                     │  - syncHoldings()     │
                     │  - syncPositions()    │
                     │  - syncTrades()       │
                     │  - refreshToken()     │
                     └────────┬──────────────┘
                              │
         ┌──────────┬─────────┼─────────┬──────────┬──────────┐
         ▼          ▼         ▼         ▼          ▼          ▼
     Zerodha    Upstox    Angel One  Dhan      Fyers      Groww
     (Kite)    (OAuth2)   (SmartAPI)  (API key) (OAuth2)   (SHA256)
```

- Credentials encrypted at rest (AES-256-GCM, per-user key)
- Token refresh strategy per broker (some daily, some on-demand)
- Only Zerodha supports Mutual Funds API (others: stocks/F&O only)
- Normalized types in `lib/brokers/types.ts`

### 3.4 Trade pairing (FIFO) (`lib/pairing/`)

- Groups trades by `symbol + exchange + broker`
- FIFO matching (oldest BUY paired with earliest SELL)
- Row splitting for partial fills
- Produces `PairedTradeView` records (denormalized for fast querying)
- Runs asynchronously via Pub/Sub → `workers/src/processors/pairing.ts`

### 3.5 AI integration (`lib/gemini/`, `lib/chat/`, `lib/chat-tools/`)

Multi-tier AI routing:

| Tier | Model                             | Use case                             | Credits |
| ---- | --------------------------------- | ------------------------------------ | ------- |
| L1   | Gemini 2.5 Flash                  | Intent classification, simple Q&A    | Free    |
| L2   | Gemini 2.5 Flash (advanced tools) | Stock analysis, research             | 3       |
| L3   | Gemini 2.5 Pro                    | Multi-segment comprehensive analysis | 8-10    |
| L4   | Gemini 2.5 Pro (extended tools)   | Tijori/StockEdge-level research      | 12+     |

- **Tool registry** (`lib/chat-tools/registry.ts`) maps tool names → server actions
- **Guardrails** (`lib/gemini/guardrails.ts`) - finance-focused content filter
- **Cost tracker** (`lib/gemini/cost-tracker.ts`) - token accounting per user

### 3.6 Payments (`lib/payments/`)

- **Dodo Payments** (`dodopayments` SDK) for subscriptions and one-time purchases
- Webhook handler at `/api/webhooks/dodo` processes:
  - `payment.completed` → upgrade subscription, move Resend contact free→paid
  - `subscription.cancelled` → downgrade, move contact paid→downgraded
  - `subscription.renewed` → extend billing period
- **Credit system**: plan-based credits + add-on packs (`CreditReservation` for expensive operations)

### 3.7 Demo mode (`lib/demo/`)

- **HMAC-signed demo cookie** (24 h TTL, Edge-compatible verification)
- All server actions check `isDemoSession()` first
- Demo users get read-only data from `lib/demo/data.ts` (static fixtures)
- Mutations return friendly error: "Demo mode: Sign up to use this feature"

---

## 4. Data flow

### Portfolio sync (broker → user)

```
User clicks "Sync"
  ↓
Server action: syncBrokerDataAction
  ↓
Decrypt credentials → call broker API
  ↓
Publish Pub/Sub msg → workers/sync processor
  ↓
Worker fetches holdings / positions / trades
  ↓
Upsert to MongoDB (delete-then-insert for holdings)
  ↓
Publish trade-pairing msg if trades changed
  ↓
Invalidate user's Redis cache
  ↓
Create in-app notification
```

### AI chat message

```
User types message in /dashboard chat
  ↓
Client calls /api/chat (streaming endpoint)
  ↓
Guardrails check (finance-focused topics only)
  ↓
Intent classifier (Flash) → routes to L1/L2/L3 skill
  ↓
Tool executor calls server actions in parallel
  ↓
Gemini synthesizes response, streams back
  ↓
Save to ChatHistory (DB) + token usage (TokenUsage)
```

---

## 5. External integrations

| Integration                   | Purpose                                 | Critical path?                  |
| ----------------------------- | --------------------------------------- | ------------------------------- |
| **Clerk**                     | Auth, user management                   | Yes - every request             |
| **MongoDB Atlas**             | Primary datastore                       | Yes                             |
| **Redis (DigitalOcean)**      | L2 cache                                | No (graceful fallback)          |
| **Google Cloud Pub/Sub**      | Async job queue                         | No (API degrades, doesn't fail) |
| **Google Vertex AI / Gemini** | LLM for chat, research, analysis        | Only for AI features            |
| **Google Cloud Storage**      | Secure content streaming (videos, PDFs) | Only for learning content       |
| **Dodo Payments**             | Subscriptions + one-time                | Only for paid upgrades          |
| **Resend**                    | Transactional + marketing email         | No (fire-and-forget)            |
| **PostHog**                   | Analytics + feature flags               | No (proxied via `/ingest`)      |
| **Datadog**                   | RUM + logs + metrics                    | No                              |
| **Broker APIs**               | Zerodha / Upstox / etc.                 | Only during broker sync         |
| **Yahoo Finance**             | Market quotes fallback                  | No                              |

---

## 6. Deployment model

- **Hosting:** Vercel (auto-deploys from `main` branch for production, PR branches for previews)
- **Build:** `next build` via Turborepo (cached)
- **Cron:** Vercel Cron for daily tasks (product sync, etc.)
- **Serverless functions:** Default Node.js runtime; some AI streaming routes use Edge
- **Environment variables:** Production in Vercel dashboard, QA/dev in `.env` files + GCP Secret Manager for workers

See [`docs/setup/VERCEL_DEPLOYMENT.md`](./docs/setup/VERCEL_DEPLOYMENT.md) for full deploy steps.

---

## 7. Security boundaries

- **Client never talks directly to:** MongoDB, Redis, Pub/Sub, broker APIs, payment processors, AI providers
- **All mutations go through server actions** (server-only code, typed boundary)
- **All broker credentials** encrypted with AES-256-GCM using per-user key
- **Error sanitization** - all DB/system errors transformed via `lib/utils/error-sanitization.ts` before reaching the user
- **Rate limiting** in `lib/security/rate-limit.ts` for auth-sensitive endpoints

---

## 8. Testing strategy

- **Test runner:** Node.js native (`node:test` + `node:assert/strict`), executed via `yarn test`
- **Total coverage:** see [`../../TEST-COVERAGE.md`](../../TEST-COVERAGE.md) for authoritative counts
- **Integration tests:** `tests/integration/` (env-gated, requires real DB)

---

## See also

- [README.md](./README.md) - quick start + features overview
- [CLAUDE.md](./CLAUDE.md) - project memory, conventions, in-flight work
- [docs/setup/](./docs/setup/) - integration setup guides
- [docs/runbooks/](./docs/runbooks/) - operational runbooks
- [docs/reference/](./docs/reference/) - architecture analyses
