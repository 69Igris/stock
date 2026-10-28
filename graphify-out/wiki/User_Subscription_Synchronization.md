# User Subscription Synchronization

> 28 nodes

## Key Concepts

- **user-sync.service.ts** (17 connections) — `packages/services/src/user-sync.service.ts`
- **user-sync-logic.ts** (13 connections) — `packages/services/src/user-sync-logic.ts`
- **backfill-clerk-user-sync.ts** (13 connections) — `scripts/migrations/backfill-clerk-user-sync.ts`
- **main()** (7 connections) — `scripts/migrations/backfill-clerk-user-sync.ts`
- **runUserSyncTx()** (6 connections) — `packages/services/src/user-sync-logic.ts`
- **ensureUserAndSubscription()** (5 connections) — `packages/services/src/user-sync.service.ts`
- **countMissingSubscriptions()** (3 connections) — `packages/services/src/user-sync.service.ts`
- **UserSyncTx** (2 connections) — `packages/services/src/user-sync-logic.ts`
- **create()** (2 connections) — `packages/services/src/user-sync-logic.ts`
- **findUnique()** (2 connections) — `packages/services/src/user-sync-logic.ts`
- **update()** (2 connections) — `packages/services/src/user-sync-logic.ts`
- **isRetryableSyncError()** (2 connections) — `packages/services/src/user-sync.service.ts`
- **fetchClerkUsersPage()** (2 connections) — `scripts/migrations/backfill-clerk-user-sync.ts`
- **getFullName()** (2 connections) — `scripts/migrations/backfill-clerk-user-sync.ts`
- **getPrimaryEmail()** (2 connections) — `scripts/migrations/backfill-clerk-user-sync.ts`
- **parseArgs()** (2 connections) — `scripts/migrations/backfill-clerk-user-sync.ts`
- **UserSyncSubscriptionRow** (1 connections) — `packages/services/src/user-sync-logic.ts`
- **UserSyncTxInput** (1 connections) — `packages/services/src/user-sync-logic.ts`
- **UserSyncTxResult** (1 connections) — `packages/services/src/user-sync-logic.ts`
- **UserSyncUserRow** (1 connections) — `packages/services/src/user-sync-logic.ts`
- **ClerkUserSyncInput** (1 connections) — `packages/services/src/user-sync.service.ts`
- **SyncDriftSummary** (1 connections) — `packages/services/src/user-sync.service.ts`
- **UserSyncResult** (1 connections) — `packages/services/src/user-sync.service.ts`
- **ClerkUser** (1 connections) — `scripts/migrations/backfill-clerk-user-sync.ts`
- **CliArgs** (1 connections) — `scripts/migrations/backfill-clerk-user-sync.ts`
- *... and 3 more nodes in this community*

## Relationships

- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (5 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (1 shared connections)
- [Database Migration Scripts](Database_Migration_Scripts.md) (1 shared connections)

## Source Files

- `packages/services/src/user-sync-logic.ts`
- `packages/services/src/user-sync.service.ts`
- `scripts/migrations/backfill-clerk-user-sync.ts`

## Audit Trail

- EXTRACTED: 53 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*