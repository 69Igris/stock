# UseMoney Test Index

This document provides an overview of all test files in the monorepo.

## Test Summary

| Metric          | Value |
| --------------- | ----- |
| **Total Tests** | 937   |
| **Suites**      | 219   |
| **Passing**     | 937   |
| **Failing**     | 0     |

---

## Test Files (27 files)

```
apps/web/__tests__/
├── TEST_INDEX.md                    # This file - test inventory
├── actions/                         # Server action tests (7 files)
│   ├── broker-connection.test.ts  # Broker connection & sync logic
│   ├── dashboard.test.ts           # Dashboard statistics logic
│   ├── holdings.test.ts            # Holdings CRUD actions
│   ├── paper.test.ts               # Paper trading actions
│   ├── positions.test.ts           # Positions CRUD actions
│   ├── trade-import.test.ts        # CSV import with duplicate detection
│   └── trades.test.ts              # Trades CRUD actions
├── brokers/                         # Broker client tests (5 files)
│   ├── config.test.ts              # Broker configuration
│   ├── zerodha.test.ts             # Zerodha API client normalization
│   ├── upstox.test.ts              # Upstox API client normalization
│   ├── dhan.test.ts                # Dhan API client normalization
│   └── fyers.test.ts               # Fyers API client normalization
├── cache/                           # Cache tests (4 files)
│   ├── client.test.ts              # Cache client operations
│   ├── invalidation.test.ts        # Cache invalidation patterns
│   ├── keys.test.ts                # Cache key generation
│   └── wrapper.test.ts             # SWR cache wrapper
├── dashboard/                       # Dashboard tests (1 file)
│   └── stats.test.ts               # Dashboard statistics
├── market/                          # Market data tests (2 files)
│   ├── hooks.test.ts               # Market data hooks
│   └── symbol-mapper.test.ts       # NSE/BSE to Yahoo mapping
├── pairing/                         # Trade pairing tests (1 file)
│   └── algorithm.test.ts           # FIFO pairing algorithm
├── positions/                       # Position tests (1 file)
│   └── calculations.test.ts        # Position P&L calculations
├── security/                        # Security tests (1 file)
│   └── encryption.test.ts          # AES-256-GCM encryption
├── utils/                           # Utility tests (3 files)
│   ├── error-sanitization.test.ts  # Error message sanitization
│   ├── financial.test.ts           # Financial calculations
│   └── format.test.ts              # Formatting utilities
└── validation/                      # Validation tests (2 files)
    ├── holding.test.ts             # Holding schema validation
    └── trade.test.ts               # Trade schema validation
```

---

## Running Tests

```bash
# Run all web app tests
yarn workspace @usemoney/web test

# Or from root
yarn test

# Run specific test file
yarn workspace @usemoney/web test __tests__/utils/financial.test.ts

# Run with pattern match
yarn workspace @usemoney/web test --test-name-pattern="calculate"
```

---

## Test Categories

### 1. Server Action Tests (`actions/`)

Tests for Next.js server actions with mocked database and auth.

| File                      | Tests | Description                                                        |
| ------------------------- | ----- | ------------------------------------------------------------------ |
| broker-connection.test.ts | 88    | Trial expiry, account validation, MF normalization, OAuth/API auth |
| dashboard.test.ts         | 23    | Portfolio stats, P&L calculations, broker aggregation              |
| holdings.test.ts          | 27    | Holdings CRUD, sync, aggregation                                   |
| paper.test.ts             | 32    | Paper trading buy/sell, P&L, portfolio management                  |
| positions.test.ts         | 26    | Position CRUD, close actions, aggregation                          |
| trade-import.test.ts      | 103   | CSV import, duplicate detection, date parsing, column mapping      |
| trades.test.ts            | 35    | Trades CRUD, filtering, statistics                                 |

### 2. Broker Tests (`brokers/`)

Tests for broker configuration and API client normalization.

| File            | Tests | Description                                                         |
| --------------- | ----- | ------------------------------------------------------------------- |
| config.test.ts  | 55    | All 8 brokers: configs, features, env keys, tier grouping           |
| zerodha.test.ts | 40+   | Zerodha: segment mapping, holdings, positions, trades normalization |
| upstox.test.ts  | 35+   | Upstox: segment mapping, holdings, positions, trades normalization  |
| dhan.test.ts    | 35+   | Dhan: segment mapping, holdings, positions, trades normalization    |
| fyers.test.ts   | 40+   | Fyers: symbol parsing, segment mapping, normalization               |

### 3. Cache Tests (`cache/`)

Tests for multi-layer caching system.

| File                 | Tests | Description                                                   |
| -------------------- | ----- | ------------------------------------------------------------- |
| client.test.ts       | 35    | Memory cache operations, stats, versioning, concurrent access |
| invalidation.test.ts | 35    | Pattern-based invalidation, cascading, multi-user isolation   |
| keys.test.ts         | 26    | Cache key generation                                          |
| wrapper.test.ts      | 32    | SWR wrapper, TTL, staleness detection                         |

### 4. Market Data Tests (`market/`)

Tests for market data utilities and hooks.

| File                  | Tests | Description                            |
| --------------------- | ----- | -------------------------------------- |
| hooks.test.ts         | 25+   | useMarketData, useHistoricalData hooks |
| symbol-mapper.test.ts | 55+   | NSE/BSE ↔ Yahoo Finance mapping        |

### 5. Trade Pairing Tests (`pairing/`)

Tests for FIFO trade pairing algorithm.

| File              | Tests | Description                                 |
| ----------------- | ----- | ------------------------------------------- |
| algorithm.test.ts | 35+   | FIFO matching, row splitting, partial fills |

### 6. Utility Tests (`utils/`)

Tests for utility functions.

| File                       | Tests | Description                             |
| -------------------------- | ----- | --------------------------------------- |
| error-sanitization.test.ts | 32    | DB error sanitization, pattern matching |
| financial.test.ts          | 50+   | XIRR, CAGR, P&L, win rate calculations  |
| format.test.ts             | 35+   | Currency, percentage, date formatting   |

### 7. Validation Tests (`validation/`)

Tests for Zod schemas.

| File            | Tests | Description                                             |
| --------------- | ----- | ------------------------------------------------------- |
| holding.test.ts | 18    | HoldingFormSchema validation                            |
| trade.test.ts   | 28    | TradeFormSchema, ClosePositionSchema, TradeFilterSchema |

### 8. Security Tests (`security/`)

Tests for encryption utilities.

| File               | Tests | Description                                            |
| ------------------ | ----- | ------------------------------------------------------ |
| encryption.test.ts | 30+   | AES-256-GCM encryption, key handling, tamper detection |

---

## Test Patterns Used

### Node.js Test Runner

```typescript
import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

describe("Feature Name", () => {
  it("should do something", () => {
    const result = functionUnderTest(input);
    assert.strictEqual(result, expected);
  });
});
```

### Mock Data Generators

```typescript
function createMockHolding(overrides: Partial<MockHolding> = {}): MockHolding {
  return {
    id: `holding-${crypto.randomUUID()}`,
    symbol: "RELIANCE",
    // ... default values
    ...overrides,
  };
}
```

### Mocking Functions

```typescript
const mockFn = mock.fn(() => expectedValue);
assert.strictEqual(mockFn.mock.calls.length, 1);
```

---

## What's Tested

### Financial Calculations

- XIRR with variable cash flows
- CAGR for multi-year returns
- Absolute return percentage
- P&L (profit/loss) calculations
- Win rate from trade history
- Edge cases (zero, negative, large values)

### Broker Integration

- All 8 broker configs (Zerodha, Upstox, Dhan, Fyers, Angel One, Groww, ICICI, HDFC)
- Auth types (OAuth2, API key, TOTP)
- Feature flags (holdings, positions, trades, mutual funds)
- API client methods with mocked responses
- Data normalization from broker-specific formats
- Trial expiry and token expiry calculations
- Account name validation and generation
- Mutual fund name normalization with fuzzy matching
- OAuth vs API key authentication detection
- Redirect URI generation per broker

### Trade Import

- Duplicate hash generation (SHA256)
- Priority-based duplicate resolution (SYNCED > IMPORTED > MANUAL)
- Cross-broker duplicate detection with user prompts
- Date parsing (ISO, DD-MM-YYYY, DD/MM/YYYY formats)
- DateTime parsing for trade timestamps
- Trade type normalization (BUY/SELL/B/S)
- Exchange normalization (NSE, BSE, NFO, MCX)
- Segment normalization (EQUITY, FO, MF, CURRENCY, COMMODITY)
- Column name normalization for CSV parsing
- ISIN detection for Indian securities
- CSV delimiter detection (comma, semicolon, tab, pipe)
- Header row detection with metadata handling
- Broker-specific column mappings (Zerodha, Upstox, Angel, Groww)
- Import status and result structure validation
- Batch ID generation for import tracking

### Trade Pairing

- FIFO matching algorithm
- Partial fills with row splitting
- Multi-symbol grouping
- Open/Closed/Partial status
- P&L calculation from pairs

### Caching

- Cache key generation patterns
- SWR (Stale-While-Revalidate) logic
- TTL and staleness detection
- Pattern-based invalidation
- Deduplication of concurrent requests

### Validation Schemas

- Required field validation
- Type transformations (uppercase, trim)
- Default value application
- Array parsing (comma-separated tags)
- Range validation (min/max)
- Custom error messages

### Security

- AES-256-GCM encryption/decryption
- Key generation and handling
- Tamper detection (auth tag, IV, ciphertext)
- Secure comparison

---

## Adding New Tests

1. Create test file in appropriate directory
2. Follow existing patterns (mock data generators, describe/it structure)
3. Run tests to verify: `yarn workspace @usemoney/web test`
4. Update this index if adding new category

---

_Last Updated: January 27, 2026_
