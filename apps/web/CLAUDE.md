# UseMoney Web App - CLAUDE.md

## Overview

The main Next.js web application for UseMoney. This is the primary user-facing application that provides portfolio management, broker integration, AI chat, paper trading, and FIRE planning features.

**Framework:** Next.js 16.2 (App Router)
**Runtime:** Node.js (Vercel Edge for streaming APIs)
**URL:** https://usemoney.ai

---

## Directory Structure

```
apps/web/
├── app/                    # Next.js App Router pages
│   ├── (auth)/            # Auth pages (sign-in, sign-up)
│   ├── api/               # API routes (webhooks, callbacks, streaming)
│   ├── dashboard/         # Portfolio dashboard
│   ├── holdings/          # Holdings view
│   ├── positions/         # Positions view
│   ├── tradebook/         # Trade book with import
│   ├── brokers/           # Broker connections
│   ├── analysis/          # AI research analysis
│   ├── fire/              # FIRE calculator
│   ├── paper-trading/     # Paper trading simulator
│   ├── discover/          # Stock discovery
│   │                      #  markets/ is the canonical markets+sectors page
│   │                      #  (MONEY-1092). sectors/ and sectors/[sector] are
│   │                      #  now redirects → /discover/markets?sector=<slug>;
│   │                      #  the tile heatmap + ranked table + drill-down all
│   │                      #  live on one canvas with a Sectors|Stocks toggle.
│   ├── tutor/             # AI tutor
│   ├── roast/             # Portfolio roast analysis
│   ├── risk/              # Risk analysis dashboard
│   ├── sage-tutor/        # AI tutor
│   ├── documents/         # Document management
│   ├── compare/           # Fund comparison
│   ├── quizzes/           # Quiz system
│   ├── mf/                # Mutual fund details
│   ├── settings/          # User settings
│   └── ...                # Other pages
├── components/            # React components
│   ├── ui/               # shadcn/ui components
│   ├── charts/           # Chart components
│   ├── content/          # Secure content players
│   ├── security/         # Screen protection
│   └── [feature]/        # Feature-specific components
├── lib/                   # Core business logic
│   ├── actions/          # Server actions
│   ├── brokers/          # Broker adapters & clients
│   ├── cache/            # Caching utilities
│   ├── db/               # Database queries
│   ├── demo/             # Demo session system
│   ├── chat/             # Chat system with slash commands
│   ├── chat-tools/       # Chat tool executor
│   ├── gemini/           # AI integration
│   ├── market/           # Market data
│   ├── pairing/          # Trade pairing
│   ├── storage/          # GCS storage
│   ├── subscription/     # Subscription access
│   └── utils/            # Utilities (page-access, feature-flag cache, retry)
│   # NOTE: lib/security, lib/pubsub, lib/logger, lib/payments, lib/billing were
│   # removed in MONEY-1062 — see "Moved to shared packages" below.
├── hooks/                 # React hooks
├── public/               # Static assets
└── __tests__/            # Test files
```

---

## Key Features & Files

### 1. Server Actions (`lib/actions/`)

| File                   | Description                                                                                                                                                                                                                                           | Key Functions                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `holdings.ts`          | Holdings CRUD operations                                                                                                                                                                                                                              | `getHoldingsAction`, `syncHoldingsAction`, `addManualHoldingAction` |
| `positions.ts`         | Positions CRUD operations                                                                                                                                                                                                                             | `getPositionsAction`, `closePositionAction`                         |
| `trades.ts`            | Trades CRUD operations                                                                                                                                                                                                                                | `getTradesAction`, `createTradeAction`, `updateTradeAction`         |
| `broker-connection.ts` | Broker sync logic                                                                                                                                                                                                                                     | `syncBrokerDataAction`, `disconnectBrokerAction`                    |
| `trade-import.ts`      | CSV import with duplicate detection                                                                                                                                                                                                                   | `importTradesFromCSVAction`, `getImportHistoryAction`               |
| `dashboard.ts`         | Dashboard stats                                                                                                                                                                                                                                       | `getDashboardStatsAction`, `getPortfolioSummaryAction`              |
| `paper.ts`             | Paper trading                                                                                                                                                                                                                                         | `buyPaperPositionAction`, `sellPaperPositionAction`                 |
| `fire.ts`              | FIRE calculator                                                                                                                                                                                                                                       | `createFireScenarioAction`, `calculateProjectionAction`             |
| `fire-chat.ts`         | Ask FIRE chat turn (MONEY-1079; replaced the deleted `/api/fire-chat` route). Two tiers: deterministic parser first, Gemini function-calling on a miss. Tools execute client-side on the FIRE page. Engine shared with apps/api via `@usemoney/fire`. | `fireChatTurnAction`                                                |
| `subscription.ts`      | Subscription management                                                                                                                                                                                                                               | `getSubscriptionAction`, `createCheckoutAction`                     |
| `mutualfunds.ts`       | Mutual fund operations                                                                                                                                                                                                                                | `getMutualFundsAction`, `syncMutualFundsAction`                     |
| `notifications.ts`     | Notification management                                                                                                                                                                                                                               | `getNotificationsAction`, `markAsReadAction`, `clearAllReadAction`  |
| `roast.ts`             | Portfolio roast                                                                                                                                                                                                                                       | `startRoastAction`, `getRoastResultAction`                          |
| `roast-history.ts`     | Roast history                                                                                                                                                                                                                                         | `getRoastHistoryAction`                                             |
| `research.ts`          | AI research                                                                                                                                                                                                                                           | `getResearchSessionsAction`, `getResearchDetailAction`              |
| `risk.ts`              | Risk analysis                                                                                                                                                                                                                                         | `getRiskAnalysisAction`                                             |
| `tax.ts`               | Tax analysis                                                                                                                                                                                                                                          | `getTaxAnalysisAction`                                              |
| `documents.ts`         | Document management                                                                                                                                                                                                                                   | `getDocumentsAction`, `uploadDocumentAction`                        |
| `watchlist.ts`         | Watchlist management                                                                                                                                                                                                                                  | `getWatchlistsAction`, `createWatchlistAction`                      |
| `learning.ts`          | Learning system                                                                                                                                                                                                                                       | `getCoursesAction`, `getLessonAction`                               |
| `quiz.ts`              | Quiz system                                                                                                                                                                                                                                           | `getQuizzesAction`, `submitQuizAction`                              |
| `discover.ts`          | Stock/MF discovery                                                                                                                                                                                                                                    | `searchInstrumentsAction`, `getTopGainersAction`                    |
| `strategy.ts`          | Strategy builder                                                                                                                                                                                                                                      | `getStrategiesAction`                                               |

### 2. Broker Integration (`lib/brokers/`)

| File                  | Description                                                                   |
| --------------------- | ----------------------------------------------------------------------------- |
| `clients/zerodha.ts`  | Zerodha API client with holdings, positions, trades, MF                       |
| `*-adapter.ts`        | Thin adapters here: upstox, dhan, fyers, angel-one, groww, hdfc, icici        |
| _(moved — MONEY-837)_ | Rich API clients for ALL brokers live in `packages/core/src/brokers/clients/` |
| `base-client.ts`      | Abstract base class for broker clients                                        |
| `types.ts`            | Normalized types for broker data                                              |
| `config.ts`           | Broker configuration and OAuth URLs                                           |
| `ws/*.ts`             | WebSocket clients for real-time data                                          |

### 3. Trade Pairing (`lib/pairing/`)

| File         | Description                  |
| ------------ | ---------------------------- |
| `service.ts` | FIFO trade pairing algorithm |

**Algorithm:**

- Groups trades by symbol + exchange + broker
- FIFO matching (First In First Out)
- Row splitting for partial fills
- Creates `PairedTradeView` records

### 4. AI Integration (`lib/gemini/`)

| File              | Description                           |
| ----------------- | ------------------------------------- |
| `client.ts`       | Vertex AI (Gemini) client             |
| `models.ts`       | Model configuration (Flash/Pro)       |
| `prompts.ts`      | System prompts for different contexts |
| `guardrails.ts`   | Finance-focused content guardrails    |
| `cost-tracker.ts` | Token usage and cost tracking         |
| `conversation.ts` | Multi-turn conversation handling      |

### 5. Demo System (`lib/demo/`)

| File         | Description                                         |
| ------------ | --------------------------------------------------- |
| `session.ts` | HMAC-signed demo cookies (24h TTL, Edge-compatible) |
| `data.ts`    | Static demo data for all features                   |

### 6. Chat System (`lib/chat/`)

| File                 | Description                              |
| -------------------- | ---------------------------------------- |
| `ChatContext.tsx`    | React context for chat state             |
| `research-blocks.ts` | Research result block rendering          |
| `slash-commands/`    | Slash command parser, registry, executor |

### 7. Chat Tools (`lib/chat-tools/`)

| File                  | Description                             |
| --------------------- | --------------------------------------- |
| `executor.ts`         | Tool execution engine                   |
| `registry.ts`         | Tool registry mapping to server actions |
| `output-validator.ts` | AI output validation                    |
| `intent-mapper.ts`    | Intent detection                        |

### 8. Caching (`lib/cache/`)

| File              | Description                   |
| ----------------- | ----------------------------- |
| `client.ts`       | Cache client (Memory + Redis) |
| `keys.ts`         | Cache key generators          |
| `wrapper.ts`      | Cache wrapper with TTL        |
| `invalidation.ts` | Cache invalidation utilities  |

**Strategy:**

- L1: In-memory (10s TTL)
- L2: Redis (5min TTL)
- Stale-while-revalidate for expensive ops

### 9. Storage (`lib/storage/`)

| File             | Description                      |
| ---------------- | -------------------------------- |
| `gcp-client.ts`  | GCP Cloud Storage client         |
| `signed-urls.ts` | Generate signed URLs for content |
| `upload.ts`      | File upload utilities            |

### 10. Moved to shared packages (MONEY-1062)

Several `lib/` modules were extracted into shared packages so `apps/web`,
`apps/api`, and the workers consume ONE copy. Import them via subpaths:

| Old location                      | Now import from                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `lib/security/encryption.ts`      | `@usemoney/security/encryption`                                                                         |
| `lib/security/rate-limit.ts`      | `@usemoney/security/rate-limit`                                                                         |
| `lib/security/cron-auth*`         | `@usemoney/security/cron-auth`                                                                          |
| `lib/pubsub/*`                    | `@usemoney/pubsub/client`, `@usemoney/pubsub/publish`                                                   |
| `lib/utils/error-sanitization.ts` | `@usemoney/utils/error-sanitization`                                                                    |
| `lib/payments/*` / plan config    | `@usemoney/core/payments` (`/plan-config`, `/checkout-logic`) + `@usemoney/core/subscription/proration` |
| broker OAuth state                | `@usemoney/core/brokers/oauth-state`                                                                    |

Advice/recommendation scrubbing and the soft-timeout wrapper also live in
`@usemoney/utils` (`/sanitize-recommendation`, `/with-soft-timeout`).

> `lib/cache/`, `lib/market/`, and `lib/storage/` are **still web-local** — their
> extraction to shared packages is deferred (MONEY-1067 / MONEY-1068).

### 11. Utilities (`lib/utils/`)

| File                                      | Description                    |
| ----------------------------------------- | ------------------------------ |
| `page-access.ts` / `page-access-logic.ts` | Subscription-based page access |
| `feature-flag-cache.ts`                   | Feature flag caching           |
| `retry.ts`                                | Retry helper                   |
| `in-app-browser.ts`                       | In-app browser detection       |

> `error-sanitization.ts` moved to `@usemoney/utils/error-sanitization`
> (MONEY-1062).

---

## API Routes (`app/api/`)

### Kept in Web App (Webhooks & Callbacks)

| Route                            | Purpose                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `/api/brokers/[broker]/callback` | OAuth callback for broker auth                                                               |
| `/api/auth/clerk/webhook`        | Clerk user sync webhook                                                                      |
| `/api/webhooks/dodo`             | Dodo Payments webhook                                                                        |
| `/api/payments/verify`           | Payment verification                                                                         |
| `/api/storage/stream/[...path]`  | Secure content streaming                                                                     |
| `/api/chat`                      | AI chat with streaming                                                                       |
| `/api/screener-chat`             | Ask Screener chat (Gemini function-calling proxy; tools execute client-side on the screener) |
| `/api/uploadthing`               | File upload endpoint                                                                         |
| `/api/demo/start`                | Start demo session                                                                           |
| `/api/demo/end`                  | End demo session                                                                             |
| `/api/market/autocomplete`       | Instrument search autocomplete                                                               |
| `/api/market/indices`            | Market indices data                                                                          |
| `/api/market/search`             | Full-text instrument search                                                                  |
| `/api/market/quote`              | Quotes. `?exchange=` takes NSE/BSE **or a US venue** — see below                             |
| `/api/market/stream`             | SSE quote stream, both markets (`POLL_INTERVAL` 5s)                                          |
| `/api/backtest`                  | Backtesting API                                                                              |
| `/api/cache/clear`               | Cache clearing                                                                               |
| `/api/cache/stats`               | Cache statistics                                                                             |
| Route                            | Purpose                                                                                      |
| -------------------------------- | ---------------------------------------------------------                                    |
| `/api/brokers/[broker]/callback` | OAuth callback for broker auth                                                               |
| `/api/webhooks/clerk`            | Clerk user sync webhook                                                                      |
| `/api/webhooks/dodo`             | Dodo Payments webhook                                                                        |
| `/api/payments/callback`         | Dodo payment callback (+ `/api/payments/create-checkout`)                                    |
| `/api/storage/stream/[...path]`  | Secure content streaming                                                                     |
| `/api/chat`                      | AI chat with streaming                                                                       |
| `/api/demo/start`                | Start demo session                                                                           |
| `/api/demo/end`                  | End demo session                                                                             |
| `/api/market/autocomplete`       | Instrument search autocomplete                                                               |
| `/api/market/indices`            | Market indices data                                                                          |
| `/api/market/search`             | Full-text instrument search                                                                  |
| `/api/backtest`                  | Backtesting API                                                                              |
| `/api/cache/clear`               | Cache clearing                                                                               |
| `/api/cache/stats`               | Cache statistics                                                                             |

#### US quotes on the market routes (MONEY-1309)

`?exchange=NASDAQ|NYSE|AMEX|NYSE ARCA|NYSE MKT|NYSE NAT|BATS|NMFQS` routes
`/api/market/quote` and `/api/market/stream` to the US path. Four things about
it are load-bearing:

- **ZERO vendor requests.** It reads the `rt:us:quote:*` Redis keys the socket
  holder writes, with the `candles` EOD close behind them. Tiingo is paid,
  metered and internal-use-only, and these routes are polled every 5-10s per
  open tab. `packages/core/__tests__/market-data/us-quote-read-no-vendor.test.ts`
  enforces it in TWO walks, and what each one covers is worth knowing before
  citing it (MONEY-1309 A5 — this bullet used to say "walks the import graph and
  fails if that ever stops being true", which was an overclaim: the walk
  followed only `.`-relative specifiers, so it never left `packages/core` and
  had never looked at a route. Appending a live `fetchTiingoEod` call to
  `app/api/market/quote/route.ts` passed every guard in the repo):
  - a walk rooted at the three CORE read modules, following relative imports;
  - a walk rooted at the FOUR app entry points that serve a US quote —
    `app/api/market/quote/route.ts`, `app/api/market/stream/route.ts`,
    `lib/market/us-interest.ts` and `apps/api/src/routes/v1/market.ts` —
    descending through `.` and `@/` imports and CHECKING, by name, every
    `@usemoney/*` specifier that crosses the package boundary. A vendor-client
    import now fails whether it is static or dynamic, in the route or one of
    the 19 modules behind it.

  Descent stops at the package boundary on purpose. Following `@usemoney/*`
  into `packages/*` grows the graph from 19 modules to 784 and reaches
  `tiingo-client.ts` from every entry point — through the
  `@usemoney/core/market-data` BARREL, which re-exports it, and which
  `apps/api/src/routes/v1/market.ts:30` imports. Module reachability is not a
  request, so that rule would be red today for a bundling fact. The residual
  gap is stated rather than implied: a route importing a vendor function OFF
  the barrel names no vendor module and is not caught. Closing it needs the
  barrel to stop re-exporting the client, or the routes to stop importing the
  barrel — a source change, not a test.

- **`Exchange` was NOT widened.** `lib/market/symbol-mapper.ts` still says
  `"NSE" | "BSE"`, because `toYahooSymbol` suffixes anything that is not BSE
  with `.NS` — `DOW` on NASDAQ becomes `DOW.NS`, a real NSE symbol for a
  different company. The union happens in `lib/market/quote-exchange.ts`
  (`QuoteExchange`), whose `isUsExchange` is a TYPE PREDICATE so the else branch
  narrows back to `Exchange` and every India call site keeps its old type.
- **No shared cache.** `fetchUsQuotesUncached` bypasses `fetchQuotesCached`
  entirely: the `_global` scope is cross-user and the Commercial licence is
  internal-use-only.
- **`delayed` is derived, not asserted, and it is derived from BOTH fields.**
  `isLiveQuote` (re-exported from core's `isLiveQuoteProvenance` by
  `app/api/market/quote/quote-logic.ts`) is the ONE place that decides; the
  response envelope, `DelayedDataNote` and apps/api's per-quote `delayed` all
  read it. It takes the provenance OBJECT, not a source string — liveness is a
  property of the pair `(source, fallback)`, and the source-only predicate this
  bullet used to name let `DelayedDataNote` render `{source:"TIINGO_RT",
fallback:true}` as a green "Live quote" badge IN PLACE OF the exchange-delayed
  disclaimer. Each quote carries its own `provenance {source, asOf, fallback}`
  — a batch can mix a live quote with yesterday's close, and the envelope label
  is pessimistic.
- **A US quote needs a session bar.** `decideUsQuote` will not emit one without
  it: with no bar there is no previous close, so `change`/`changePercent`/OHLC
  have no basis, and the branch that used to emit them anyway served a real
  price beside a fabricated 0.00% for every symbol past
  `US_EOD_FALLBACK_MAX_SYMBOLS` (12) — 8 of a 20-symbol watchlist. Those
  symbols now arrive in `unresolved`, and the cap logs a warning.

`useMarketData` returns that freshness as `meta {cached, asOf, delayed,
partial}`; it used to drop it. `delayed` defaults to **true** on an absent
field — never assume live.

The apps/api mirror is `GET /v1/market/us/quotes` (same core module).

### Data APIs (to be moved to `apps/api`)

| Route                | Purpose                                    |
| -------------------- | ------------------------------------------ |
| `/api/[[...path]]`   | Main API handler (dashboard, trades, etc.) |
| `/api/market/*`      | Market data endpoints                      |
| `/api/trades/paired` | Paired trades query                        |

---

## Database Queries (`lib/db/`)

| File               | Description                 |
| ------------------ | --------------------------- |
| `user.ts`          | User CRUD, Clerk ID mapping |
| `holdings.ts`      | Holdings queries            |
| `positions.ts`     | Positions queries           |
| `trades.ts`        | Trades queries, paired view |
| `dashboard.ts`     | Dashboard aggregations      |
| `paper.ts`         | Paper trading data          |
| `fire.ts`          | FIRE scenarios              |
| `mutualfunds.ts`   | Mutual fund queries         |
| `chat-history.ts`  | AI chat history             |
| `notifications.ts` | Notification queries        |
| `roast.ts`         | Portfolio roast data        |

---

## Components

### UI Components (`components/ui/`)

Standard shadcn/ui components (button, card, dialog, etc.)

### Feature Components

| Category      | Components                                                       |
| ------------- | ---------------------------------------------------------------- |
| **Charts**    | `TradingChart`, `CandlestickChart`, `VolumeChart`                |
| **Content**   | `SecureVideoPlayer`, `SecureAudioPlayer`, `SecureDocumentViewer` |
| **Security**  | `ScreenProtection` (anti-screenshot, watermark)                  |
| **Dashboard** | `PortfolioSummary`, `HoldingsCard`, `RecentTrades`               |
| **Tradebook** | `TradeTable`, `ImportDialog`, `DuplicatePrompt`                  |

---

## Hooks (`hooks/`)

| Hook                | Description                        |
| ------------------- | ---------------------------------- |
| `useMarketData`     | Real-time market data subscription |
| `useHistoricalData` | Historical OHLCV data              |
| `useFeatureFlags`   | PostHog feature flags              |

---

## Environment Variables

```bash
# Required
DATABASE_URL=mongodb+srv://...
REDIS_URL=redis://...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
ENCRYPTION_KEY=... # 64-char hex for AES-256

# AI
GOOGLE_GENAI_API_KEY=...

# Payments
DODO_PAYMENTS_API_KEY=...   # exact name — packages/core/src/payments/dodo.ts throws if missing
DODO_WEBHOOK_SECRET=...

# Storage
GCP_PROJECT_ID=...
GCP_STORAGE_BUCKET=...
GCP_SERVICE_ACCOUNT_KEY_BASE64=...

# Brokers (for each)
ZERODHA_API_KEY=...
ZERODHA_API_SECRET=...
UPSTOX_API_KEY=...
# ... etc
```

---

## What's Been Completed

### Core Features

- [x] Multi-broker integration (6 brokers)
- [x] Holdings, Positions, Trades views
- [x] Trade book with FIFO pairing
- [x] CSV import with duplicate detection
- [x] Paper trading simulator
- [x] FIRE calculator
- [x] AI chat (Gemini)
- [x] Subscription management (Dodo)
- [x] Secure content streaming
- [x] Demo session system (HMAC-signed, Edge-compatible)
- [x] Portfolio roast analysis (AI-powered)
- [x] Risk analysis dashboard (VaR, drawdown, correlation)
- [x] Notification system (DB + real-time)
- [x] Watchlist management
- [x] Document management & processing
- [x] AI research with streaming
- [x] TradingView Advanced Charts integration (MONEY-121) - proprietary v31.0.0 library, served from `apps/web/public/charting_library/`, backed by `/api/market/udf/*` endpoints. Used on stock detail, MF detail, paper-trading, and chat-embedded stock chart. The legacy `TradingChart` (lightweight-charts) and `AdvancedChart` (klinecharts) live under `components/charts/archive/`

  **Library upgrade workflow** (do NOT auto-sync - committed copies in `public/charting_library/` are the source of truth for Vercel since the submodule is private):
  1. `git -C vendor/charting_library checkout <new-tag>`
  2. `yarn sync:chart` (sets `SYNC_CHARTING_LIBRARY=1` and runs the script)
  3. Review the resulting `public/` diff and commit in a dedicated PR.

  Bare `yarn install` is a no-op for charting library - the postinstall hook is gated behind `SYNC_CHARTING_LIBRARY=1` so 957 bundle files never silently drift again (regression seen twice before this guardrail).

- [x] Slash commands in chat
- [x] Quiz system
- [x] Stock/MF discovery with Atlas Search
- [x] Market indices integration
- [x] Tax analysis
- [x] Strategy builder

### Infrastructure

- [x] Multi-layer caching (Memory + Redis)
- [x] AES-256-GCM encryption for credentials
- [x] Error sanitization for user-facing messages
- [x] Clerk authentication
- [x] PostHog analytics & feature flags

### Import System

- [x] CSV parsing with broker format detection
- [x] Duplicate detection (cross-source)
- [x] Import history tracking
- [x] Priority-based resolution (Synced > Manual > Import)

---

## What Needs to Be Done

### High Priority

- [ ] Mobile PWA improvements

### Medium Priority

- [ ] Social features
- [ ] Advanced strategy builder (currently basic)

---

## Restrictions & Guidelines

### Code Standards

- TypeScript strict mode
- No `any` types
- Server actions for mutations
- Client components only where needed

### Security

- Never log sensitive data
- Encrypt all broker credentials
- Sanitize all error messages
- Validate inputs with Zod

### Performance

- Use caching for expensive operations
- Avoid N+1 queries
- Stream large responses
- Lazy load components

### Architecture

- Business logic in `lib/`
- Components only render, no data fetching
- Use server actions, not direct API calls
- Database access via Prisma only

---

## Testing

**Test Runner:** Node.js native (`node:test` + `node:assert/strict`)
**Full coverage report:** [`../../TEST-COVERAGE.md`](../../TEST-COVERAGE.md) (repo root)

```bash
# Run all tests
yarn test

# Specific suites
yarn workspace @usemoney/web test:cache
yarn workspace @usemoney/web test:cache:redis     # Requires RUN_REDIS_TESTS=true
yarn workspace @usemoney/web test:email
yarn workspace @usemoney/web test:newsletter
yarn workspace @usemoney/web test:market
yarn workspace @usemoney/web test:pubsub

# Watch mode
yarn workspace @usemoney/web test:watch

# Single file
node --import tsx --test __tests__/actions/holdings.test.ts
```

### Test Directory Structure

```
__tests__/
├── actions/          # Server action tests (holdings, trades, roast, risk, etc.)
├── api/              # API infrastructure tests
├── brokers/          # Broker client tests
├── cache/            # Cache system tests
├── chat/             # Chat system & slash command tests
├── chat-tools/       # Chat tool executor tests
├── core/             # packages/core tests
├── dashboard/        # Dashboard stats tests
├── db/               # Database layer tests
├── demo/             # Demo session system tests
├── documents/        # Document management tests
├── email/            # Email sending tests
├── gemini/           # Gemini/AI tests
├── market/           # Market data tests
├── newsletter/       # Newsletter tests
├── notifications/    # Notification system tests
├── pairing/          # FIFO algorithm tests
├── positions/        # Position calculation tests
├── pubsub/           # Pub/Sub messaging tests
├── quiz/             # Quiz system tests
├── research/         # AI research tests
├── risk/             # Risk analysis tests
├── roast/            # Portfolio roast tests
├── security/         # Encryption tests
├── strategy/         # Strategy builder tests
├── utils/            # Utility tests
├── validation/       # Zod schema tests
├── watchlist/        # Watchlist tests
└── workers/          # Worker processor tests
```

**Stats:** see [`../../TEST-COVERAGE.md`](../../TEST-COVERAGE.md) — the single
source of truth for test counts (not duplicated here to avoid drift; MONEY-838).

> **Rule:** When adding or modifying test files, update `TEST-COVERAGE.md` in the repo root.
> See the [Maintenance Rules](../../TEST-COVERAGE.md#maintenance-rules) section for details.

---

## Development

```bash
# Install dependencies
yarn install

# Run dev server
yarn dev

# Build
yarn build

# Type check
yarn check-types  # (root script — apps/web has no type-check script)

# Lint
yarn lint
```

---

_Last Updated: July 2026_
