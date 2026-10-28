# @usemoney/services

> Unified service layer for UseMoney - 25 service modules

Shared business logic consumed by web (server actions), API (Hono routes), and
workers.

## Pattern

All services accept a MongoDB user ID and return `ServiceResult<T>`:

```typescript
type ServiceResult<T> =
  | { success: true; data: T; message?: string }
  | { success: false; error: string; code?: string };
```

## Services

### Core Data

| Service               | Description                   |
| --------------------- | ----------------------------- |
| `holdings.service`    | Holdings queries & enrichment |
| `positions.service`   | Day/overnight positions       |
| `trades.service`      | Trade book with filters       |
| `dashboard.service`   | Portfolio summary dashboard   |
| `mutualfunds.service` | Mutual fund holdings          |

### Portfolio Features

| Service                 | Description              |
| ----------------------- | ------------------------ |
| `paper.service`         | Paper trading management |
| `fire.service`          | FIRE scenario CRUD       |
| `watchlist.service`     | Watchlist management     |
| `notifications.service` | Notification management  |
| `chat-history.service`  | Chat message history     |

### AI & Premium

| Service             | Description                 |
| ------------------- | --------------------------- |
| `roast.service`     | Portfolio roast CRUD        |
| `research.service`  | Research session management |
| `risk.service`      | Risk analysis queries       |
| `tax.service`       | Tax analysis queries        |
| `documents.service` | Document upload/processing  |

### Discovery & Content

| Service                    | Description              |
| -------------------------- | ------------------------ |
| `discover.service`         | Stock/MF discovery       |
| `learning.service`         | Learning content queries |
| `strategy.service`         | Trading strategy queries |
| `fund-comparison.service`  | MF comparison logic      |
| `fund-composition.service` | MF composition analysis  |

### Orchestration

| Service                     | Description                    |
| --------------------------- | ------------------------------ |
| `subscription.service`      | Subscription & plan management |
| `broker-connection.service` | Broker OAuth, refresh, sync    |
| `trade-import.service`      | CSV import orchestration       |
| `user.service`              | User profile & settings        |
| `content.service`           | Content management             |

## Usage

```typescript
import { holdingsService } from "@usemoney/services";

const result = await holdingsService.getHoldings(userId);
if (result.success) {
  console.log(result.data);
}
```

## Documentation

See **CLAUDE.md** for technical details.
