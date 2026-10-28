# @usemoney/database

> Prisma ORM configuration and database client for MongoDB

## Usage

```typescript
import prisma from "@usemoney/database";
import { User, Trade, Holding } from "@usemoney/database";

// Query
const users = await prisma.user.findMany();

// Create
const trade = await prisma.trade.create({
  data: { ... }
});
```

## Commands

```bash
# Generate Prisma client
yarn db:generate

# Push schema to database
yarn db:push

# Run migrations
yarn db:migrate

# Open Prisma Studio
yarn db:studio
```

## Models

### User & Auth

| Model              | Description                     |
| ------------------ | ------------------------------- |
| `User`             | User accounts (linked to Clerk) |
| `BrokerConnection` | Connected broker accounts       |
| `Subscription`     | User subscription info          |

### Portfolio

| Model             | Description                   |
| ----------------- | ----------------------------- |
| `Holding`         | Stock holdings                |
| `Position`        | F&O positions (day/overnight) |
| `Trade`           | Trade history                 |
| `MutualFund`      | Mutual fund holdings          |
| `PairedTradeView` | FIFO paired trades            |

### Paper Trading

| Model           | Description       |
| --------------- | ----------------- |
| `PaperPosition` | Virtual positions |
| `PaperTrade`    | Virtual trades    |

### Features

| Model          | Description               |
| -------------- | ------------------------- |
| `FireScenario` | FIRE calculator scenarios |
| `Chat`         | AI chat sessions          |
| `ChatMessage`  | Chat messages             |
| `Notification` | User notifications        |
| `Watchlist`    | Watchlist management      |
| `Document`     | Uploaded documents        |

### Discovery & Market

| Model                  | Description               |
| ---------------------- | ------------------------- |
| `Instrument`           | Stock/ETF instrument data |
| `MutualFundInstrument` | Mutual fund master data   |

### AI & Research

| Model             | Description              |
| ----------------- | ------------------------ |
| `ResearchSession` | AI research sessions     |
| `RoastSession`    | Portfolio roast sessions |

### Learning

| Model          | Description          |
| -------------- | -------------------- |
| `Course`       | Learning courses     |
| `Chapter`      | Course chapters      |
| `Lesson`       | Chapter lessons      |
| `Quiz`         | Lesson quizzes       |
| `Enrollment`   | User enrollments     |
| `GlossaryTerm` | Glossary definitions |

### Content CMS

| Model                  | Description              |
| ---------------------- | ------------------------ |
| `Post`                 | Blog/glossary/newsletter |
| `Tag`                  | Content tags             |
| `ContentAuthor`        | CMS authors              |
| `Idea`                 | Content ideas            |
| `NewsletterSubscriber` | Newsletter subscribers   |
| `EmailLog`             | Email sending log        |

### System

| Model           | Description        |
| --------------- | ------------------ |
| `BackgroundJob` | Async job tracking |
| `ImportLog`     | Trade import logs  |

## Documentation

See **CLAUDE.md** for technical details.
