# @usemoney/validation

> Zod validation schemas for UseMoney

## Usage

```typescript
import { createTradeSchema } from "@usemoney/validation/trade";
import { holdingSchema } from "@usemoney/validation/holding";
import { paginationSchema } from "@usemoney/validation/common";

// Validate
const result = createTradeSchema.safeParse(input);
if (!result.success) {
  console.error(result.error);
}
```

## Schema Categories

| Path           | Description        |
| -------------- | ------------------ |
| `/trade`       | Trade validation   |
| `/holding`     | Holding validation |
| `/mutual-fund` | MF validation      |
| `/fire`        | FIRE schemas       |
| `/common`      | Common schemas     |

## Documentation

See **CLAUDE.md** for details.
