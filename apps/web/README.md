# UseMoney Web App

> **AI-Powered Portfolio Management Platform for Indian Stock Markets**

The main user-facing Next.js application for UseMoney - a comprehensive platform for tracking investments, analyzing performance, and planning financial goals.

[![Next.js](https://img.shields.io/badge/Next.js-14.2-black)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-blue)](https://react.dev/)

---

## Quick Start

```bash
# From monorepo root
yarn install
yarn workspace @usemoney/web dev

# Or from apps/web
cd apps/web
yarn dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Features

- **Multi-Broker Integration**: Zerodha, Upstox, Dhan, Fyers, Angel One, Groww
- **Portfolio Dashboard**: Real-time P&L, performance charts, segment breakdown
- **Trade Book**: FIFO paired trades, CSV import, duplicate detection
- **Paper Trading**: Practice with virtual money
- **FIRE Calculator**: Retirement planning scenarios
- **AI Chat**: Portfolio analysis with Gemini
- **Portfolio Roast**: AI-powered portfolio scoring & analysis
- **Risk Analysis**: VaR, drawdown, correlation heatmaps
- **Tax Analysis**: Capital gains & tax planning
- **AI Research**: Autonomous stock research agent (StockSage)
- **Stock/MF Discovery**: Atlas Search-powered browsing & screening
- **Notifications**: In-app notification system
- **Watchlist**: Multi-watchlist management
- **Document Management**: PDF upload, text extraction, report generation
- **Quiz System**: Learning quizzes with progress tracking
- **Premium Content**: Secure video/document streaming
- **Demo Mode**: Full app walkthrough without sign-up

---

## Project Structure

```
apps/web/
├── app/                    # Next.js App Router pages
├── components/             # React components
├── lib/                    # Business logic
│   ├── actions/           # Server actions
│   ├── brokers/           # Broker integrations
│   ├── cache/             # Caching layer
│   ├── db/                # Database queries
│   ├── gemini/            # AI integration
│   ├── pairing/           # Trade pairing
│   └── ...
├── hooks/                  # React hooks
└── public/                # Static assets
```

---

## Server Actions Reference

### Holdings (`lib/actions/holdings.ts`)

| Function                        | Description                         |
| ------------------------------- | ----------------------------------- |
| `getHoldingsAction()`           | Fetch all holdings for current user |
| `syncHoldingsAction(brokerId)`  | Sync holdings from broker           |
| `addManualHoldingAction(data)`  | Add manual holding entry            |
| `updateHoldingAction(id, data)` | Update holding                      |
| `deleteHoldingAction(id)`       | Delete holding                      |

### Positions (`lib/actions/positions.ts`)

| Function                        | Description                     |
| ------------------------------- | ------------------------------- |
| `getPositionsAction(filter?)`   | Fetch positions (day/overnight) |
| `syncPositionsAction(brokerId)` | Sync positions from broker      |
| `closePositionAction(id)`       | Mark position as closed         |

### Trades (`lib/actions/trades.ts`)

| Function                         | Description                  |
| -------------------------------- | ---------------------------- |
| `getTradesAction(filter?)`       | Fetch trades with pagination |
| `getPairedTradesAction(filter?)` | Fetch FIFO paired trades     |
| `createTradeAction(data)`        | Create manual trade          |
| `updateTradeAction(id, data)`    | Update trade                 |
| `deleteTradeAction(id)`          | Delete trade                 |

### Trade Import (`lib/actions/trade-import.ts`)

| Function                                       | Description                |
| ---------------------------------------------- | -------------------------- |
| `importTradesFromCSVAction(file, options)`     | Import trades from CSV     |
| `getImportHistoryAction()`                     | Get import history         |
| `deleteImportBatchAction(batchId)`             | Delete entire import batch |
| `switchImportBrokerAction(batchId, newBroker)` | Change broker linking      |

### Broker Connection (`lib/actions/broker-connection.ts`)

| Function                                    | Description              |
| ------------------------------------------- | ------------------------ |
| `getBrokerConnectionsAction()`              | List connected brokers   |
| `syncBrokerDataAction(connectionId, types)` | Full broker sync         |
| `disconnectBrokerAction(connectionId)`      | Remove broker connection |
| `refreshBrokerTokenAction(connectionId)`    | Refresh OAuth token      |

### Dashboard (`lib/actions/dashboard.ts`)

| Function                       | Description                  |
| ------------------------------ | ---------------------------- |
| `getDashboardStatsAction()`    | Portfolio summary stats      |
| `getPortfolioSummaryAction()`  | Detailed portfolio breakdown |
| `getRecentTradesAction(limit)` | Recent trades for dashboard  |

### Paper Trading (`lib/actions/paper.ts`)

| Function                                  | Description              |
| ----------------------------------------- | ------------------------ |
| `getPaperPortfolioAction()`               | Get virtual portfolio    |
| `buyPaperPositionAction(data)`            | Buy virtual position     |
| `sellPaperPositionAction(id, qty, price)` | Sell virtual position    |
| `resetPaperPortfolioAction()`             | Reset to initial balance |

### FIRE Calculator (`lib/actions/fire.ts`)

| Function                             | Description           |
| ------------------------------------ | --------------------- |
| `getFireScenariosAction()`           | List FIRE scenarios   |
| `createFireScenarioAction(data)`     | Create new scenario   |
| `updateFireScenarioAction(id, data)` | Update scenario       |
| `deleteFireScenarioAction(id)`       | Delete scenario       |
| `calculateProjectionAction(params)`  | Calculate projections |

### Subscription (`lib/actions/subscription.ts`)

| Function                       | Description              |
| ------------------------------ | ------------------------ |
| `getSubscriptionAction()`      | Get current subscription |
| `createCheckoutAction(planId)` | Create payment checkout  |
| `cancelSubscriptionAction()`   | Cancel subscription      |

### Mutual Funds (`lib/actions/mutualfunds.ts`)

| Function                          | Description            |
| --------------------------------- | ---------------------- |
| `getMutualFundsAction()`          | Fetch all mutual funds |
| `syncMutualFundsAction(brokerId)` | Sync MF from broker    |

### Notifications (`lib/actions/notifications.ts`)

| Function                   | Description               |
| -------------------------- | ------------------------- |
| `getNotificationsAction()` | List user notifications   |
| `markAsReadAction(id)`     | Mark notification as read |
| `clearAllReadAction()`     | Clear read notifications  |

### Watchlist (`lib/actions/watchlist.ts`)

| Function                      | Description          |
| ----------------------------- | -------------------- |
| `getWatchlistsAction()`       | List all watchlists  |
| `createWatchlistAction(data)` | Create new watchlist |

### Portfolio Roast (`lib/actions/roast.ts`)

| Function                 | Description         |
| ------------------------ | ------------------- |
| `startRoastAction(data)` | Start roast session |
| `getRoastResultAction()` | Get roast result    |

### Risk Analysis (`lib/actions/risk.ts`)

| Function                  | Description       |
| ------------------------- | ----------------- |
| `getRiskAnalysisAction()` | Get risk analysis |

### Tax Analysis (`lib/actions/tax.ts`)

| Function                 | Description      |
| ------------------------ | ---------------- |
| `getTaxAnalysisAction()` | Get tax analysis |

### AI Research (`lib/actions/research.ts`)

| Function                      | Description            |
| ----------------------------- | ---------------------- |
| `getResearchSessionsAction()` | List research sessions |
| `getResearchDetailAction(id)` | Get research detail    |

### Documents (`lib/actions/documents.ts`)

| Function                     | Description     |
| ---------------------------- | --------------- |
| `getDocumentsAction()`       | List documents  |
| `uploadDocumentAction(data)` | Upload document |

### Discovery (`lib/actions/discover.ts`)

| Function                     | Description        |
| ---------------------------- | ------------------ |
| `searchInstrumentsAction(q)` | Search stocks/MF   |
| `getTopGainersAction()`      | Top gainers/losers |

### Learning & Quiz (`lib/actions/learning.ts`, `quiz.ts`)

| Function                 | Description        |
| ------------------------ | ------------------ |
| `getCoursesAction()`     | List courses       |
| `getLessonAction(id)`    | Get lesson content |
| `getQuizzesAction()`     | List quizzes       |
| `submitQuizAction(data)` | Submit quiz answer |

---

## Broker Clients Reference

### Base Client (`lib/brokers/base-client.ts`)

Abstract class all broker clients extend.

| Method             | Description                |
| ------------------ | -------------------------- |
| `getHoldings()`    | Fetch normalized holdings  |
| `getPositions()`   | Fetch normalized positions |
| `getTrades()`      | Fetch normalized trades    |
| `getMutualFunds()` | Fetch normalized MF        |
| `refreshToken()`   | Refresh OAuth token        |

### Zerodha (`lib/brokers/clients/zerodha.ts`)

| Method                | Description               |
| --------------------- | ------------------------- |
| `getHoldings()`       | Kite holdings API         |
| `getPositions()`      | Day + overnight positions |
| `getTrades()`         | Today's trades            |
| `getMutualFunds()`    | MF holdings with XIRR     |
| `generateLoginUrl()`  | OAuth URL generation      |
| `exchangeToken(code)` | Token exchange            |

---

## Utility Functions Reference

### Error Sanitization (`lib/utils/error-sanitization.ts`)

| Function                      | Description                               |
| ----------------------------- | ----------------------------------------- |
| `sanitizeErrorMessage(error)` | Convert DB error to user-friendly message |
| `sanitizeErrors(errors[])`    | Batch sanitize errors                     |

### Cache (`lib/cache/`)

| Function                      | Description                       |
| ----------------------------- | --------------------------------- |
| `getFromCache(key)`           | Get cached value                  |
| `setInCache(key, value, ttl)` | Set cache with TTL                |
| `invalidateCache(pattern)`    | Invalidate by pattern             |
| `getCacheKey.*`               | Key generators for different data |

### Encryption (`lib/security/encryption.ts`)

| Function                        | Description         |
| ------------------------------- | ------------------- |
| `encryptCredentials(data)`      | AES-256-GCM encrypt |
| `decryptCredentials(encrypted)` | Decrypt credentials |

---

## Trade Pairing Algorithm

**File:** `lib/pairing/service.ts`

### `computeAndStorePairedTrades(userId, options?)`

Computes FIFO paired trades for a user.

**Algorithm:**

1. Groups trades by symbol + exchange + broker
2. Sorts by trade time (FIFO)
3. Matches BUY → SELL for LONG positions
4. Splits rows for partial fills
5. Creates `PairedTradeView` records

**Returns:**

```typescript
{
  processed: number;
  created: number;
  open: number;
  closed: number;
  partial: number;
}
```

---

## Database Queries Reference

### User (`lib/db/user.ts`)

| Function                     | Description                      |
| ---------------------------- | -------------------------------- |
| `getOrCreateDbUser(clerkId)` | Get or create user from Clerk ID |
| `getUserByClerkId(clerkId)`  | Get user by Clerk ID             |
| `updateUser(id, data)`       | Update user data                 |

### Holdings (`lib/db/holdings.ts`)

| Function                    | Description              |
| --------------------------- | ------------------------ |
| `getHoldingsByUser(userId)` | All holdings for user    |
| `upsertHolding(data)`       | Create or update holding |
| `deleteHolding(id)`         | Delete holding           |

### Trades (`lib/db/trades.ts`)

| Function                                | Description        |
| --------------------------------------- | ------------------ |
| `getTradesByUser(userId, filter)`       | Paginated trades   |
| `getPairedTradesByUser(userId, filter)` | Paired trade views |
| `createTrade(data)`                     | Create trade       |
| `bulkCreateTrades(trades)`              | Bulk import        |

---

## API Routes

### Webhooks & Callbacks (kept in web app)

| Route                            | Method | Description         |
| -------------------------------- | ------ | ------------------- |
| `/api/brokers/[broker]/callback` | GET    | OAuth callback      |
| `/api/auth/clerk/webhook`        | POST   | Clerk user sync     |
| `/api/webhooks/dodo`             | POST   | Payment webhook     |
| `/api/storage/stream/[...path]`  | GET    | Content streaming   |
| `/api/chat`                      | POST   | AI chat (streaming) |
| `/api/demo/start`                | POST   | Start demo session  |
| `/api/demo/end`                  | POST   | End demo session    |
| `/api/market/autocomplete`       | GET    | Instrument search   |
| `/api/market/indices`            | GET    | Market indices data |

---

## Environment Variables

```bash
# Database
DATABASE_URL=mongodb+srv://...

# Redis
REDIS_URL=redis://...

# Auth
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...

# Security
ENCRYPTION_KEY=... # 64-char hex

# AI
GOOGLE_GENAI_API_KEY=...

# Payments
DODO_API_KEY=...
DODO_WEBHOOK_SECRET=...

# Storage
GCP_PROJECT_ID=...
GCP_STORAGE_BUCKET=...
GCP_SERVICE_ACCOUNT_KEY_BASE64=...

# Brokers
ZERODHA_API_KEY=...
ZERODHA_API_SECRET=...
UPSTOX_API_KEY=...
UPSTOX_API_SECRET=...
# ... other brokers
```

---

## Development

```bash
# Dev server
yarn dev

# Build
yarn build

# Type check
yarn type-check

# Lint
yarn lint

# Tests
yarn test
```

---

## Testing

**Test Runner:** Node.js native (`node:test` + `node:assert/strict`)

See [TEST-COVERAGE.md](../../TEST-COVERAGE.md) for the full report.

```bash
yarn test                    # Run all tests
yarn test:cache              # Cache tests only
yarn test:market             # Market data tests only
yarn test:watch              # Watch mode
```

---

## Documentation

- **CLAUDE.md** - Technical details for AI assistants
- **docs/BROKER_INTEGRATION.md** - Broker setup guide
- **docs/DODO_PAYMENTS_SETUP.md** - Payment configuration
- **Root CLAUDE.md** - Project-wide context

---

## Tech Stack

- **Framework**: Next.js 14.2 (App Router)
- **Language**: TypeScript 5.x
- **UI**: React 18, Tailwind CSS, shadcn/ui
- **Database**: MongoDB (Prisma ORM)
- **Cache**: Redis (Memory + Redis dual-layer)
- **Auth**: Clerk
- **AI**: Google Gemini (2.5 Pro + 2.5 Flash)
- **Payments**: Dodo Payments
- **Storage**: GCP Cloud Storage
- **Analytics**: PostHog, Datadog

---

_Part of the UseMoney monorepo_
