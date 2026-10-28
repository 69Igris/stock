# @usemoney/core

> Core business logic for the UseMoney platform

Contains broker integrations, subscription management, payment processing, AI integration, and caching utilities.

## Installation

```bash
# In monorepo
yarn workspace @usemoney/core add <dependency>
```

## Usage

```typescript
// Main exports
import { ... } from "@usemoney/core";

// Broker clients
import { ZerodhaClient, UpstoxClient } from "@usemoney/core/brokers";

// Subscription
import { checkFeatureAccess, SubscriptionTier } from "@usemoney/core/subscription";

// Payments
import { createCheckout, verifyPayment } from "@usemoney/core/payments";

// AI
import { GeminiClient } from "@usemoney/core/gemini";

// Trade pairing
import { pairTradesFIFO } from "@usemoney/core/pairing";
```

## Modules

### Brokers

| Export             | Description             |
| ------------------ | ----------------------- |
| `ZerodhaClient`    | Zerodha Kite API client |
| `UpstoxClient`     | Upstox API client       |
| `DhanClient`       | Dhan API client         |
| `FyersClient`      | Fyers API client        |
| `BaseBrokerClient` | Abstract base class     |

### Subscription

| Export                    | Description          |
| ------------------------- | -------------------- |
| `SubscriptionTier`        | FREE, PREMIUM, PRO   |
| `checkFeatureAccess()`    | Check feature access |
| `getSubscriptionLimits()` | Get tier limits      |

### Payments

| Export             | Description          |
| ------------------ | -------------------- |
| `createCheckout()` | Create Dodo checkout |
| `verifyPayment()`  | Verify payment       |
| `handleWebhook()`  | Process webhook      |

### Gemini (AI)

| Export              | Description      |
| ------------------- | ---------------- |
| `GeminiClient`      | Vertex AI client |
| `getSystemPrompt()` | Get prompts      |

### Pairing

| Export             | Description            |
| ------------------ | ---------------------- |
| `pairTradesFIFO()` | FIFO pairing algorithm |

## Documentation

See **CLAUDE.md** for technical details.
