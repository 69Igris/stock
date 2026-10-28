# UseMoney Monorepo

AI-powered trading portfolio management platform for Indian stock markets with
multi-broker support.

**Website:** [usemoney.ai](https://usemoney.ai)

---

## Project Structure

Turborepo monorepo with Yarn workspaces.

### Apps

| App            | Description                                       | Port |
| -------------- | ------------------------------------------------- | ---- |
| `apps/web`     | Main Next.js web app - portfolio management       | 3000 |
| `apps/api`     | Hono REST API - mobile & third-party integrations | 8080 |
| `apps/admin`   | Admin dashboard - users, content, courses         | 3001 |
| `apps/content` | Content CMS - blog, glossary, newsletters         | 3002 |

### Packages

| Package                      | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `packages/core`              | Business logic (brokers, pairing, payments)        |
| `packages/database`          | Prisma schema & client (MongoDB)                   |
| `packages/types`             | Shared TypeScript type definitions                 |
| `packages/services`          | Unified service layer (25 service modules)         |
| `packages/cache`             | Redis caching utilities (Memory + Redis)           |
| `packages/auth`              | Authentication utilities (Clerk)                   |
| `packages/security`          | Encryption & token management (AES-256-GCM)        |
| `packages/storage`           | Google Cloud Storage client                        |
| `packages/email`             | Transactional & newsletter email (Resend)          |
| `packages/research`          | AI research agent (9 skills, 45+ tools)            |
| `packages/roast`             | Portfolio roast analysis engine (6-step pipeline)  |
| `packages/content-engine`    | Learning content generation & quiz system (Gemini) |
| `packages/datadog`           | Datadog APM, metrics & logging                     |
| `packages/logger`            | Structured logging                                 |
| `packages/trpc`              | tRPC router definitions                            |
| `packages/validation`        | Zod schemas for input validation                   |
| `packages/api-utils`         | Shared API utilities                               |
| `packages/utils`             | General utilities                                  |
| `packages/ui`                | Shared React component library                     |
| `packages/eslint-config`     | Shared ESLint configurations                       |
| `packages/typescript-config` | Shared TypeScript configurations                   |

### Workers

| Directory  | Description                                             |
| ---------- | ------------------------------------------------------- |
| `workers/` | Background job processors - Pub/Sub + Hono on Cloud Run |

11 processors: trade-pairing, csv-import, broker-sync, instrument-sync,
price-sync, sector-enrichment, mf-sync, mf-metadata-sync, stock-research,
document-process, portfolio-roast.

---

## Tech Stack

| Layer          | Technology                                                     |
| -------------- | -------------------------------------------------------------- |
| **Frontend**   | Next.js 14.2, React 18, TypeScript, Tailwind CSS, shadcn/ui    |
| **Backend**    | Next.js API Routes, tRPC, Hono (API server)                    |
| **Database**   | MongoDB Atlas (via Prisma ORM)                                 |
| **Cache**      | Redis (DigitalOcean) with multi-layer caching (Memory + Redis) |
| **Auth**       | Clerk (authentication & user management)                       |
| **AI**         | Google Gemini (2.5 Pro + 2.5 Flash)                            |
| **Payments**   | Dodo Payments                                                  |
| **Email**      | Resend (transactional + newsletters)                           |
| **Storage**    | Google Cloud Storage (GCS)                                     |
| **Messaging**  | Google Cloud Pub/Sub (job queuing)                             |
| **Analytics**  | PostHog (product analytics), Datadog (APM & metrics)           |
| **Deployment** | Vercel (web, api, admin, content), GCP Cloud Run (workers)     |
| **Monorepo**   | Turborepo with Yarn workspaces                                 |

---

## Getting Started

### Prerequisites

- **Node.js 22 LTS** — pinned via [`.nvmrc`](./.nvmrc). Supported range: `^20.19 || ^22.13 || >=24` (the Next.js 16 / ESLint 9 toolchain supports LTS Node lines only, so non-LTS versions such as **23.x are rejected** by `yarn`). With [nvm](https://github.com/nvm-sh/nvm): `nvm install 22 && nvm use`.
- Yarn Classic (1.x)
- MongoDB database
- Clerk account
- Google Cloud account (for storage and AI)

### Installation

```bash
git clone <repository-url>
cd usemoney-monorepo
nvm use          # switch to the pinned Node (reads .nvmrc → Node 22)
yarn install
```

> **On the wrong Node?** `yarn` enforces `engines.node`, so an unsupported version
> (e.g. Node 23.x) fails the install with `The engine "node" is incompatible … Got "23.x.x"`.
> Run `nvm use` (or `nvm install 22 && nvm use`) and retry. CI/Vercel run an LTS Node,
> so this only affects local setups on the wrong version.

### Generate Prisma Client

```bash
yarn workspace @usemoney/database prisma generate
```

### Development

```bash
# Run all apps
yarn dev

# Run specific app
yarn workspace @usemoney/web dev
yarn workspace @usemoney/api-server dev
yarn workspace @usemoney/admin dev
yarn workspace @usemoney/content dev

# Workers
yarn workspace @usemoney/workers dev
```

### Build

```bash
# Build all
yarn build

# Build specific app
yarn build --filter=web
```

---

## Features

### Web Application

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
- **Stock/MF Discovery**: Atlas Search-powered browsing
- **Notifications**: In-app notification system
- **Watchlist**: Multi-watchlist management
- **Document Management**: PDF upload, text extraction, report generation
- **Quiz System**: Learning quizzes
- **Demo Mode**: Full walkthrough without sign-up

### Admin Dashboard

- User management
- Content management (videos, PDFs)
- Course & lesson management
- Glossary management

### Content CMS

- Blog post editor (BlockNote)
- Glossary term management
- Newsletter composition & scheduling
- Content calendar & analytics
- Tag management

### API Server

- REST API for mobile apps
- Hono-based, deployed on Vercel
- Clerk JWT authentication

---

## Environment Variables

See each app's `.env.example` or CLAUDE.md for the full list. Key variables:

```bash
DATABASE_URL=mongodb+srv://...
REDIS_URL=redis://...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
GOOGLE_GENAI_API_KEY=...
DODO_API_KEY=...
GCP_PROJECT_ID=...
GCP_STORAGE_BUCKET=...
GCP_SERVICE_ACCOUNT_KEY_BASE64=...
```

---

## Testing

| Metric          | Value                                               |
| --------------- | --------------------------------------------------- |
| **Test Files**  | 271                                                 |
| **Test Cases**  | 11,501                                              |
| **Pass Rate**   | 100%                                                |
| **Test Runner** | Node.js native (`node:test` + `node:assert/strict`) |

See [TEST-COVERAGE.md](./TEST-COVERAGE.md) for the full report.

```bash
# Run all tests
yarn test

# Run web app tests
yarn workspace @usemoney/web test

# Run worker tests
yarn workspace @usemoney/workers test
```

---

## Deployment

| Component  | Platform      | Trigger        |
| ---------- | ------------- | -------------- |
| Web App    | Vercel        | Push to `main` |
| API Server | Vercel        | Push to `main` |
| Admin      | Vercel        | Push to `main` |
| Content    | Vercel        | Push to `main` |
| Workers    | GCP Cloud Run | Cloud Build CI |

---

## Project Conventions

- **Database**: All Prisma schema changes in `packages/database`
- **Business Logic**: Core logic in `packages/core` and `packages/services`
- **Components**: Shared UI in `packages/ui`, app-specific in
  `apps/*/components`
- **Types**: Shared types in `packages/types`
- **Testing**: Update `TEST-COVERAGE.md` when adding/modifying tests
- **Code Style**: TypeScript strict mode, no `any` types, Zod validation

---

## License

Private - All rights reserved.
