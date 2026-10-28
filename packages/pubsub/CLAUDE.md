# @usemoney/pubsub - CLAUDE.md

## Overview

Shared Google Cloud Pub/Sub client + job publishers (2-file package: `client.ts`

- `publish.ts`). Extracted in MONEY-1062 by reconciling the two pre-migration
  copies into ONE:

* `apps/web/lib/pubsub/*` (publisher, Vercel)
* `workers/src/lib/pubsub-client.ts` (client factory, Cloud Run)

The web app is the only publisher; workers consume. Both prior copies exposed
`getPubSubClient()` and the worker also had `validateProjectId()` — this package
keeps every name 1:1 so consumers swapped import paths mechanically.

**Package:** `@usemoney/pubsub` (ESM — `"type": "module"`)

---

## Exports

```typescript
// Client factory
import {
  getPubSubClient,
  validateProjectId,
  __setPubSubClientForTests, // test seam only — production never calls it
} from "@usemoney/pubsub/client";

// Job publishers
import {
  publishPairingJob,
  publishImportJob,
  publishSyncJob,
  publishResearchJob,
  publishResearchPreviewPlanJob,
  publishDocumentProcessJob,
  publishRoastJob,
  publishComparisonJob,
  publishLoginBriefingJob,
  publishL3AnalysisJob,
  publishStrategyScanJob,
  publishAccountDeletionJob,
  publishClerkDeleteSweepJob,
} from "@usemoney/pubsub/publish";
```

Subpaths (`./client`, `./publish`) are the preferred imports; the `.` barrel
exists only for the package `main` and parity with sibling packages.

---

## Key Functions

| Function                       | Description                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getPubSubClient()`            | Get/init the singleton `PubSub`. Constructing does NOT open a connection, so it's created lazily and cached process-wide.                                |
| `validateProjectId(projectId)` | Discriminated `{ valid: true, projectId } \| { valid: false, error }`; `getPubSubClient` throws when invalid.                                            |
| `publish*Job(message)`         | 13 publishers. Each resolves the env-suffixed topic via `getTopicName(PUBSUB_TOPICS.*)`, publishes the JSON payload, and returns the Pub/Sub message id. |
| `__setPubSubClientForTests(c)` | Inject a fake `PubSub` (or `null` to reset). Needed because ESM breaks the CJS `require.cache` module-swap trick.                                        |

**Topics & message types** come from `@usemoney/types`
(`PUBSUB_TOPICS`, `getTopicName`, and the `*JobMessage` types).

---

## Credentials & project id

Credentials resolve via the shared `googleCredentials()` resolver
(`@usemoney/core/gemini/credentials`) — the worker's behaviour, a strict
superset of the old web copy (production precedence unchanged):

1. `GCP_SERVICE_ACCOUNT_KEY_BASE64` (production / Vercel) — precedence 1
2. `GOOGLE_APPLICATION_CREDENTIALS_JSON` (raw JSON or base64)
3. `GOOGLE_APPLICATION_CREDENTIALS` file path (local dev)
4. else Application Default Credentials (Cloud Run attached SA)

`projectId` is ALWAYS taken from the explicit `GCP_PROJECT_ID` env (never the
resolver's derived value) — without it the gRPC transport in google-gax may fail
to attach credentials from the metadata server on Cloud Run.

---

## Usage

```typescript
import { publishSyncJob } from "@usemoney/pubsub/publish";

const messageId = await publishSyncJob({ userId, broker: "ZERODHA" });
```

Consumed by `apps/web` (server actions + API routes) and `@usemoney/services`.

---

## Configuration

```bash
GCP_PROJECT_ID=stock-book-483718          # REQUIRED — pinned explicitly onto the client
GCP_SERVICE_ACCOUNT_KEY_BASE64=...        # production / Vercel (precedence 1)
# or GOOGLE_APPLICATION_CREDENTIALS_JSON / GOOGLE_APPLICATION_CREDENTIALS / ADC
```

Topics are provisioned by `workers/scripts/setup-pubsub.sh {qa|prod}` (suffixed
`-qa` / `-prod`).

---

## Test Coverage

Tests live in `packages/pubsub/__tests__/`. See
[`../../TEST-COVERAGE.md`](../../TEST-COVERAGE.md) for the full report.

> **Rule:** When adding tests, update `TEST-COVERAGE.md` in the repo root.

---

## What's Been Completed

- [x] Singleton Pub/Sub client factory (lazy, cached)
- [x] `validateProjectId` guard
- [x] 13 job publishers (env-suffixed topic resolution)
- [x] Shared credentials resolver (base64 / JSON / file / ADC)
- [x] Test seam for ESM

---

_Last Updated: July 2026_
