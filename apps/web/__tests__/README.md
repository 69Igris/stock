# UseMoney Web App - Test Suite

Test suite for the UseMoney web application using Node's built-in test runner.

**Source of truth:** [TEST-COVERAGE.md](../../../TEST-COVERAGE.md) in the repo root.

---

## Running Tests

```bash
# Run all tests
yarn test

# Specific suites
yarn test:cache                  # Cache tests
yarn test:cache:redis            # Cache + Redis integration (requires RUN_REDIS_TESTS=true)
yarn test:email                  # Email tests
yarn test:newsletter             # Newsletter tests
yarn test:market                 # Market data tests
yarn test:pubsub                 # Pub/Sub messaging tests

# Watch mode
yarn test:watch

# Single file
node --import tsx --test __tests__/actions/holdings.test.ts
```

---

## Test Directories

```
__tests__/
├── actions/          # Server action tests (39 files)
├── api/              # API infrastructure tests
├── brokers/          # Broker client & adapter tests
├── cache/            # Cache system tests
├── chat/             # Chat system & slash command tests
├── chat-tools/       # Chat tool executor tests
├── core/             # packages/core tests (broker adapters)
├── dashboard/        # Dashboard stats tests
├── db/               # Database layer tests
├── demo/             # Demo session system tests
├── documents/        # Document management tests
├── email/            # Email sending tests
├── gemini/           # Gemini/AI tests
├── market/           # Market data tests
├── newsletter/       # Newsletter tests
├── notifications/    # Notification system tests
├── pairing/          # FIFO algorithm tests
├── positions/        # Position calculation tests
├── pubsub/           # Pub/Sub messaging tests
├── quiz/             # Quiz system tests
├── research/         # AI research tests
├── risk/             # Risk analysis tests
├── roast/            # Portfolio roast tests
├── security/         # Encryption tests
├── strategy/         # Strategy builder tests
├── utils/            # Utility tests
├── validation/       # Zod schema tests
├── watchlist/        # Watchlist tests
└── workers/          # Worker processor tests
```

---

## Test Framework

- **Runner:** Node.js native `node:test`
- **Assertions:** `node:assert/strict`
- **TypeScript:** via `tsx` (--import tsx)
- No external test framework required (Node 18+)

---

## Adding New Tests

```typescript
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

describe("My Feature", () => {
  beforeEach(async () => {
    // Setup
  });

  it("should do something", async () => {
    assert.strictEqual(actual, expected);
  });
});
```

When adding or modifying test files, update [TEST-COVERAGE.md](../../../TEST-COVERAGE.md) in the repo root.
