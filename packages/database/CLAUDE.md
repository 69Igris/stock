# @usemoney/database - CLAUDE.md

## Overview

Prisma ORM configuration and database client for MongoDB. Contains the schema definitions and exports the Prisma client.

**Package:** `@usemoney/database`
**Database:** MongoDB Atlas
**ORM:** Prisma

---

## Exports

```typescript
import prisma from "@usemoney/database";
import { User, Trade, Holding, Position, ... } from "@usemoney/database";
```

---

## Directory Structure

```
packages/database/
├── index.ts           # Exports prisma client
├── prisma/
│   └── schema.prisma  # Database schema
└── package.json
```

---

## Schema Models

### User Models

| Model              | Description                     |
| ------------------ | ------------------------------- |
| `User`             | User accounts (linked to Clerk) |
| `BrokerConnection` | Connected broker accounts       |
| `Subscription`     | User subscription info          |

### Portfolio Models

| Model             | Description                   |
| ----------------- | ----------------------------- |
| `Holding`         | Stock holdings                |
| `Position`        | F&O positions (day/overnight) |
| `Trade`           | Trade history                 |
| `MutualFund`      | Mutual fund holdings          |
| `PairedTradeView` | FIFO paired trades            |

### Paper Trading Models

| Model            | Description        |
| ---------------- | ------------------ |
| `PaperPortfolio` | Virtual portfolios |
| `PaperPosition`  | Virtual positions  |
| `PaperOrder`     | Virtual orders     |

### Other Models

| Model           | Description                 |
| --------------- | --------------------------- |
| `FireScenario`  | FIRE calculator scenarios   |
| `ChatHistory`   | AI chat sessions & messages |
| `BackgroundJob` | Async job tracking          |
| `ImportLog`     | Trade import logs           |

---

## Key Enums

| Enum                 | Values                                         |
| -------------------- | ---------------------------------------------- |
| `BrokerType`         | ZERODHA, UPSTOX, DHAN, FYERS, ANGEL_ONE, GROWW |
| `TradeSource`        | SYNCED, IMPORTED, MANUAL                       |
| `PairedTradeStatus`  | OPEN, CLOSED, PARTIAL                          |
| `SubscriptionStatus` | ACTIVE, CANCELLED, EXPIRED                     |

---

## Commands

```bash
# Generate Prisma client
yarn db:generate

# Push schema to database
yarn db:push

# QA / Prod pushes (env-scoped .env.qa / .env.prod)
yarn workspace @usemoney/database db:push:qa
yarn workspace @usemoney/database db:push:prod
# NOTE: Prisma Migrate is NOT supported on MongoDB — `db:migrate` errors; `db:push` is the only schema flow

# Open Prisma Studio
yarn db:studio
```

---

## Usage

```typescript
import prisma from "@usemoney/database";

// Query
const users = await prisma.user.findMany();

// Create
const trade = await prisma.trade.create({
  data: { ... }
});

// Transaction
await prisma.$transaction([
  prisma.trade.create({ data: trade1 }),
  prisma.trade.create({ data: trade2 }),
]);
```

---

## What's Been Completed

- [x] User and auth models
- [x] Portfolio models (holdings, positions, trades)
- [x] Mutual fund model
- [x] Paired trade view model
- [x] Paper trading models
- [x] FIRE scenario model
- [x] AI chat models
- [x] Background job tracking
- [x] Import log tracking
- [x] Notification model
- [x] Watchlist model
- [x] Document model
- [x] Instrument & MutualFundInstrument models
- [x] ResearchSession & RoastSession models
- [x] Learning models (Course, Chapter, Lesson, Quiz, Enrollment, GlossaryTerm)
- [x] Content CMS models (Post, Tag, ContentAuthor, Idea, NewsletterSubscriber, EmailLog)

---

## What Needs to Be Done

- [x] Corporate actions model (`CorporateAction`, MONEY-797 / C3b — dividends /
      bonuses / splits / rights / AGM / buyback; system-level reference data, no
      userId/cascade; populated via the stock-detail read-through warm-up,
      nightly bulk sync is a follow-up). Dividend history is a filtered view of
      the same table.
- [ ] Price alerts model

---

## Sharing one table between MARKETS (MONEY-980)

> Share one table between markets only when the market discriminator is part of
> the row's **UNIQUE KEY** and **every reader carries it**. Otherwise separate
> the tables.

Both halves are required. A discriminator in the key with a reader that omits
it is the worse case of the two: the writes are correct and distinct, so the
table looks healthy, and only the reads are wrong.

The rule came out of the US price backbone, where the same six-table question
was asked six times and answered differently each time. The answers are the
test — a proposal for a seventh table should land somewhere in this table.

| Table                  | Unique key                              | Discriminator in key? | Every reader carries it?                | Verdict                     |
| ---------------------- | --------------------------------------- | --------------------- | --------------------------------------- | --------------------------- |
| `fx_rates`             | `(pair, date)`                          | YES — the pair IS it  | yes, trivially                          | **SHARED**                  |
| `candles`              | `(symbol, exchange, timeframe, ts)`     | YES                   | yes                                     | **shared shape**            |
| `us_corporate_actions` | `(permaTicker, type, exDate)`           | n/a — India differs   | **NO — two readers drop it on purpose** | **SEPARATE**                |
| `us_stock_news`        | `(symbol, link)`                        | **NO**                | no — India filters on `symbol` alone    | **SEPARATE**                |
| `us_instruments`       | `(listingId)`                           | n/a — India differs   | no — 37 India read sites, no venue      | **SEPARATE**                |
| `Holding` / `Position` | `(userId, broker, …, symbol, exchange)` | YES, already          | yes — every read is user-scoped         | **SHARE**, after `currency` |

Row by row, because the reasoning is the point:

- **`fx_rates` — SHARED, trivially correct.** The pair (`USDINR`) _is_ the
  identity; there is no separate market attribute to forget.

- **`candles` — the discriminator is in the key, so sharing is SAFE.** It is
  US-only in practice for an unrelated reason: India's prices live in
  `daily_prices`, keyed on `instrumentId`. That coexistence is deliberate
  (MONEY-1043) and is not evidence against the rule.

- **`us_corporate_actions` — SEPARATE, and the clearest case in the set.**
  India keys `(symbol, exchange, type, exDate)`; the US has no exchange to key
  on and uses `permaTicker`. But the key is not what decides it — the READERS
  are. Two India readers deliberately DROP `exchange`:
  `apps/web/app/api/market/udf/marks/route.ts` and
  `apps/web/lib/market/corporate-action-adjust.ts`, both commented "a corporate
  action belongs to the COMPANY", both citing RELIANCE's Oct-2024 bonus that
  arrived from BSE only. Scoping those reads by exchange would blank the NSE
  line, so the omission is CORRECT and cannot be fixed away.
  **A reader that legitimately drops the discriminator cannot share a table.**
  There are 214 real India/US ticker collisions, so a shared table would hand a
  US split to an Indian lot through a reader doing exactly the right thing.

- **`us_stock_news` — SEPARATE.** `(symbol, link)` carries no market at all,
  and every India reader filters on `symbol` alone (`news.service.ts`,
  `stock-tabs.service.ts`, `apps/web/lib/actions/news.ts`). Both halves of the
  rule fail at once.

- **`us_instruments` — SEPARATE.** India keys `(symbol, exchange)` plus
  `yahooSymbol`; the US keys `listingId` (`{symbol}:{exchange}:{listingStartDate}`,
  because a ticker is not a security — `DOW` is two companies). An audit found
  143 read sites of `instrument_mappings`, **37** of them India-facing with no
  venue clause at all. Adding a `market` column would have left all 37 wrong.

- **`Holding` / `Position` — SHARE, once they carry `currency`.** The only row
  in this table that passes both halves without any change: `exchange` is
  ALREADY in the unique key (`@@unique([userId, broker, brokerUserId, symbol,
exchange])`), and every read is user-scoped and carries it. What is still
  missing is `currency` — not for identity, but because summing a portfolio
  across two currencies without one silently adds dollars to rupees.

The failure mode when the rule is broken is always the same shape: nothing
errors, no row is malformed, and one market's data answers the other market's
question. See also the ABSENT-vs-`null` rule in the root `CLAUDE.md` — that one
is about a column a query cannot see; this one is about a column a query never
asks for.

---

## Restrictions

- Schema changes ship via `db:push` only (Prisma Migrate is NOT supported on MongoDB)
- Always use `yarn db:push` for dev
- Never manually edit generated client
- Indexes defined in schema

---

_Last Updated: July 2026_
