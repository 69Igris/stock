# @usemoney/core - CLAUDE.md

## Overview

Core business logic package for UseMoney. Contains broker integrations, subscription management, payment processing, AI (Gemini) integration, and caching utilities.

NOTE (2026-07 audit): the directory tree and exports list below predate MONEY-837 — `brokers/` is now `adapters/` (9 brokers incl. hdfc, icici, interactive-brokers) + `clients/` under `src/brokers/`, and ~45 subpath exports exist (see package.json `exports`; always import subpaths, never the root barrel). Trust package.json + src/ over the tree below until it is rewritten. Also: `./db` and `./auth` in the exports map point at directories that no longer exist — those imports fail.

**Package:** `@usemoney/core`

---

## Exports

```typescript
import { ... } from "@usemoney/core";
import { ... } from "@usemoney/core/brokers";
import { ... } from "@usemoney/core/subscription";
import { ... } from "@usemoney/core/payments";
import { ... } from "@usemoney/core/gemini";
import { ... } from "@usemoney/core/cache";
import { ... } from "@usemoney/core/pairing";
import { ... } from "@usemoney/core/import";
```

---

## Directory Structure

```
packages/core/src/
├── index.ts               # Main exports
├── brokers/               # Broker integrations
│   ├── index.ts
│   ├── base-client.ts     # Abstract broker client
│   ├── zerodha.ts         # Zerodha implementation
│   ├── upstox.ts          # Upstox implementation
│   ├── dhan.ts            # Dhan implementation
│   ├── fyers.ts           # Fyers implementation
│   └── types.ts           # Normalized types
├── subscription/          # Subscription management
│   ├── index.ts
│   ├── types.ts           # Subscription types
│   └── access.ts          # Access control
├── payments/              # Dodo Payments integration
│   ├── index.ts
│   ├── dodo.ts            # Dodo client
│   └── types.ts           # Payment types
├── gemini/                # AI integration
│   ├── index.ts
│   ├── client.ts          # Vertex AI client
│   ├── prompts.ts         # System prompts
│   └── types.ts           # AI types
├── cache/                 # Caching utilities
│   ├── index.ts
│   ├── client.ts          # Cache client
│   └── keys.ts            # Key generators
└── pairing/               # Trade pairing
    ├── index.ts
    ├── algorithm.ts       # FIFO algorithm
    └── types.ts           # Pairing types
```

---

## Key Modules

### Brokers (`/brokers`)

Broker API clients for fetching holdings, positions, trades, and mutual funds.

| Export                 | Description            |
| ---------------------- | ---------------------- |
| `BaseBrokerClient`     | Abstract base class    |
| `ZerodhaClient`        | Zerodha Kite API       |
| `UpstoxClient`         | Upstox API             |
| `DhanClient`           | Dhan API               |
| `FyersClient`          | Fyers API              |
| `NormalizedHolding`    | Standard holding type  |
| `NormalizedPosition`   | Standard position type |
| `NormalizedTrade`      | Standard trade type    |
| `NormalizedMutualFund` | Standard MF type       |

### Subscription (`/subscription`)

Subscription tier management and feature access control.

| Export                                  | Description                                                                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAN_CONFIG` / `getPlanConfig()`       | Plan definitions — single source of truth (the Dodo CATALOG `PLAN_CONFIG` at `./payments/plan-config` is a different, payments-only table — entitlements ALWAYS come from subscription) |
| `hasFeatureAccess()` / `FEATURE_ACCESS` | Per-plan feature gating                                                                                                                                                                 |
| `type PlanId` / `resolvePlanId()`       | Plan ids (FREE, PRO, PREMIUM, ULTIMATE, …)                                                                                                                                              |

### Payments (`/payments`)

Dodo Payments integration.

| Export                                | Description                           |
| ------------------------------------- | ------------------------------------- |
| `getDodoClient()` / `dodoClient`      | Lazy Dodo Payments SDK client (Proxy) |
| `getDodoMode()` / `getDodoSdkMode()`  | test_mode / live_mode resolution      |
| `isDodoConfigured()` / `isLiveMode()` | Env guards                            |

### Gemini (`/gemini`)

Google Vertex AI (Gemini) integration.

| Export              | Description                |
| ------------------- | -------------------------- |
| `GeminiClient`      | AI client                  |
| `getSystemPrompt()` | Get system prompt          |
| `GUARDRAILS`        | Finance-focused guardrails |

### Pairing (`/pairing`)

FIFO trade pairing algorithm.

| Export             | Description                                                                     |
| ------------------ | ------------------------------------------------------------------------------- |
| `pairTradesFIFO()` | Main pairing algorithm (corporate-action-aware — see `pairing/corp-actions.ts`) |
| `PairingResult`    | Pairing result type                                                             |

---

## What's Been Completed

- [x] Broker clients (Zerodha, Upstox, Dhan, Fyers)
- [x] Normalized types for cross-broker data
- [x] Subscription tier management
- [x] Dodo Payments integration
- [x] Gemini AI client
- [x] FIFO trade pairing algorithm

---

## What Needs to Be Done

- [x] Angel One broker client — shipped in src/brokers/clients/
- [x] Groww broker client — shipped in src/brokers/clients/
- [ ] Historical data fetching
- [ ] Real-time WebSocket clients
- [ ] Advanced analytics calculations

---

## Test Coverage

**Current coverage: ~75%** - 30 test files covering broker adapters, cache, content, gemini, market-data, pairing, payments, and subscription modules.

See [`../../TEST-COVERAGE.md`](../../TEST-COVERAGE.md) for the full report.

> **Rule:** When adding tests for this package, update `TEST-COVERAGE.md` in the repo root.

---

## Restrictions

- Business logic only - no UI
- No direct database access (use with @usemoney/database)
- Pure TypeScript, no framework dependencies
- Test coverage for critical algorithms

---

_Last Updated: July 2026_
