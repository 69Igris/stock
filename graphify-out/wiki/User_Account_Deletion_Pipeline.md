# User Account Deletion Pipeline

> 52 nodes

## Key Concepts

- **account-deletion.service.ts** (51 connections) — `packages/services/src/account-deletion.service.ts`
- **processors/account-deletion.ts** (20 connections) — `workers/src/processors/account-deletion.ts`
- **processAccountDeletionJob()** (14 connections) — `workers/src/processors/account-deletion.ts`
- **processors/clerk-delete-sweep.ts** (12 connections) — `workers/src/processors/clerk-delete-sweep.ts`
- **generateDeleteOtp()** (8 connections) — `packages/services/src/account-deletion.service.ts`
- **verifyDeleteOtp()** (7 connections) — `packages/services/src/account-deletion.service.ts`
- **processClerkDeleteSweepJob()** (7 connections) — `workers/src/processors/clerk-delete-sweep.ts`
- **clearOtp()** (5 connections) — `packages/services/src/account-deletion.service.ts`
- **markDeletionFailed()** (5 connections) — `packages/services/src/account-deletion.service.ts`
- **otpAttemptsKey()** (5 connections) — `packages/services/src/account-deletion.service.ts`
- **AccountDeletedEmail()** (4 connections) — `packages/email/src/templates/account-deleted.tsx`
- **cancelDodoFromAudit()** (4 connections) — `packages/services/src/account-deletion.service.ts`
- **captureSnapshotIntoAudit()** (4 connections) — `packages/services/src/account-deletion.service.ts`
- **incrAttempts()** (4 connections) — `packages/services/src/account-deletion.service.ts`
- **incrRateCounter()** (4 connections) — `packages/services/src/account-deletion.service.ts`
- **otpKey()** (4 connections) — `packages/services/src/account-deletion.service.ts`
- **captureUserAuditSnapshot()** (3 connections) — `packages/services/src/account-deletion.service.ts`
- **completeDeletionAfterClerkPurge()** (3 connections) — `packages/services/src/account-deletion.service.ts`
- **finalizeUserDelete()** (3 connections) — `packages/services/src/account-deletion.service.ts`
- **findClerkDeletionsReadyForPurge()** (3 connections) — `packages/services/src/account-deletion.service.ts`
- **getOrCreateInProgressAudit()** (3 connections) — `packages/services/src/account-deletion.service.ts`
- **hardDeleteUser()** (3 connections) — `packages/services/src/account-deletion.service.ts`
- **markClerkUserLocked()** (3 connections) — `packages/services/src/account-deletion.service.ts`
- **markDeletionEmailSent()** (3 connections) — `packages/services/src/account-deletion.service.ts`
- **processAccountDeletion()** (3 connections) — `packages/services/src/account-deletion.service.ts`
- *... and 27 more nodes in this community*

## Relationships

- [PubSub Message Handlers](PubSub_Message_Handlers.md) (8 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (6 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (6 shared connections)
- [Dodo Payments Client Integration](Dodo_Payments_Client_Integration.md) (5 shared connections)
- [Transactional Email Templates](Transactional_Email_Templates.md) (3 shared connections)
- [Email Broadcast Analytics](Email_Broadcast_Analytics.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (1 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (1 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (1 shared connections)
- [Worker Package Dependencies](Worker_Package_Dependencies.md) (1 shared connections)

## Source Files

- `packages/email/src/templates/account-deleted.tsx`
- `packages/services/__tests__/account-deletion-otp.test.ts`
- `packages/services/src/account-deletion.service.ts`
- `workers/package.json`
- `workers/src/processors/account-deletion.ts`
- `workers/src/processors/clerk-delete-sweep.ts`

## Audit Trail

- EXTRACTED: 132 (99%)
- INFERRED: 1 (1%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*