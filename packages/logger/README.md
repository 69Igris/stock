# @usemoney/logger

> Structured logging utilities for UseMoney

## Usage

```typescript
import { logger } from "@usemoney/logger";

logger.info("User logged in", { userId: "123" });
logger.error("Failed to sync", { error: err.message });
logger.debug("Processing trade", { tradeId: "..." });
logger.warn("Rate limit approaching", { remaining: 10 });
```

## Log Levels

| Level   | Description         |
| ------- | ------------------- |
| `debug` | Development details |
| `info`  | Normal operations   |
| `warn`  | Potential issues    |
| `error` | Errors and failures |

## Documentation

See **CLAUDE.md** for details.
