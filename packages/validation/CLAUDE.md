# @usemoney/validation - CLAUDE.md

## Overview

Zod validation schemas for UseMoney. Provides type-safe validation for trades, holdings, mutual funds, FIRE scenarios, and common fields.

**Package:** `@usemoney/validation`

---

## Exports

```typescript
import {
  TradeFormSchema,
  HoldingFormSchema,
  validateBlockData,
} from "@usemoney/validation";
import {
  TradeFormSchema,
  ClosePositionSchema,
  TradeFilterSchema,
} from "@usemoney/validation/trade";
import { HoldingFormSchema } from "@usemoney/validation/holding";
import { MutualFundFormSchema } from "@usemoney/validation/mutual-fund";
import {
  FireScenarioSchema,
  FireParametersSchema,
} from "@usemoney/validation/fire";
import type {
  ActionResponse,
  PaginatedResponse,
} from "@usemoney/validation/common"; // common = types only, NO schemas
```

---

## Key Schemas

### Trade Schemas

| Schema                | Description                           |
| --------------------- | ------------------------------------- |
| `TradeFormSchema`     | Trade form validation (create/update) |
| `ClosePositionSchema` | Close position validation             |
| `TradeFilterSchema`   | Trade filter validation               |

### Holding Schemas

| Schema              | Description             |
| ------------------- | ----------------------- |
| `HoldingFormSchema` | Holding form validation |

### Mutual Fund Schemas

| Schema                 | Description        |
| ---------------------- | ------------------ |
| `MutualFundFormSchema` | MF form validation |

### FIRE Schemas

| Schema                                          | Description                |
| ----------------------------------------------- | -------------------------- |
| `FireScenarioSchema`                            | FIRE scenario validation   |
| `FireParametersSchema`                          | FIRE parameters validation |
| `MonthlyExpenseSchema` / `OneTimeExpenseSchema` | Expense validation         |

### Common (`/common`)

No schemas — types only: `ActionResponse`, `PaginatedResponse`.

Also exported: content, coupon (MONEY-866), chat-blocks (`BLOCK_SCHEMAS`,
`validateBlockData`), paper (`PlaceOrderSchema`), document, feedback modules + a
`z` re-export; 9 node:test files under `__tests__/`.

---

## Usage

```typescript
import {
  TradeFormSchema,
  type TradeFormInput,
  type TradeFormData,
} from "@usemoney/validation/trade";

// Validate input — note z.input vs z.output: TradeFormInput (pre-coerce) vs TradeFormData (parsed)
const result = TradeFormSchema.safeParse(input);
if (!result.success) {
  throw new Error(result.error.message);
}
const validData = result.data;
```

---

_Last Updated: July 2026_
