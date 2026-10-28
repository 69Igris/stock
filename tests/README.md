# Integration Tests

Integration tests run against the QA environment (QA MongoDB, QA Redis, QA Cloud Run workers). They are gated behind the `RUN_INTEGRATION_TESTS=true` environment variable so they never run accidentally during normal development.

## Directory Structure

```
tests/
├── integration/
│   ├── setup.ts          # before() hook: connects Prisma + Redis
│   ├── teardown.ts       # after() hook: disconnects clients
│   ├── helpers.ts        # Factory functions (createTestUser, etc.)
│   ├── env.ts            # Env var validation + typed config
│   ├── db/               # Database integration tests
│   ├── cache/            # Redis cache integration tests
│   ├── workers/          # Cloud Run worker integration tests
│   └── cross-service/    # Tests spanning multiple services
```

## Prerequisites

1. **gcloud CLI** installed and authenticated:

   ```bash
   gcloud auth login
   gcloud config set project stock-book-483718
   ```

2. **GCP Secrets** must exist in Secret Manager:
   - `DATABASE_URL_QA` -- QA MongoDB connection string
   - `REDIS_URL_QA` -- QA Redis connection string
   - `WORKER_URL_QA` -- QA Cloud Run worker base URL

3. **Node.js >= 18** with `tsx` available (installed via root devDependencies).

## Running Locally

### Step 1: Load QA environment

```bash
source scripts/ops/test-env.sh
```

This fetches secrets from GCP Secret Manager and exports `DATABASE_URL`, `REDIS_URL`, `WORKER_URL`, and `RUN_INTEGRATION_TESTS=true` into your current shell.

### Step 2: Run tests

```bash
# All integration tests
yarn test:integration

# Specific suites
yarn test:integration:db
yarn test:integration:cache
yarn test:integration:workers
```

### One-liner

```bash
source scripts/ops/test-env.sh && yarn test:integration
```

## Running in CI

Set the following environment variables in your CI pipeline:

```yaml
env:
  RUN_INTEGRATION_TESTS: "true"
  DATABASE_URL: ${{ secrets.DATABASE_URL_QA }}
  REDIS_URL: ${{ secrets.REDIS_URL_QA }}
  WORKER_URL: ${{ secrets.WORKER_URL_QA }}
```

Then run:

```bash
yarn test:integration
```

## Writing Tests

Every integration test file should import setup and teardown:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { db, redis } from "../setup.js";
import "../teardown.js";
import { createTestUser, cleanupTestUser } from "../helpers.js";

describe("Feature: my integration test", () => {
  let userId: string;

  it("should do something against QA", async () => {
    const user = await createTestUser();
    userId = user.id;

    // ... test logic using db, redis ...

    // Always clean up
    await cleanupTestUser(userId);
  });
});
```

### Test data conventions

- Test users are created with email prefix `test_integration_` so they are easy to identify and purge.
- Always clean up test data in each test or in an `after()` hook.
- Use `waitForCondition()` from helpers when testing eventually-consistent operations (e.g., Pub/Sub processing).

## Timeout

Integration tests use a 30-second timeout by default (`--test-timeout=30000`). For tests that wait on async processing, use `waitForCondition()` with an appropriate timeout.
