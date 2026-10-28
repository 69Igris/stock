# Resend Audience Segment Migration

> 11 nodes

## Key Concepts

- **migrate-resend-segments.ts** (7 connections) — `scripts/migrations/migrate-resend-segments.ts`
- **reconcile-resend-segments.ts** (7 connections) — `scripts/ops/reconcile-resend-segments.ts`
- **resend** (5 connections) — `packages/email/package.json`
- **main()** (2 connections) — `scripts/migrations/migrate-resend-segments.ts`
- **sleep()** (2 connections) — `scripts/migrations/migrate-resend-segments.ts`
- **main()** (1 connections) — `scripts/ops/reconcile-resend-segments.ts`
- **PAID_PLANS** (1 connections) — `scripts/migrations/migrate-resend-segments.ts`
- **REQUIRED_ENV** (1 connections) — `scripts/migrations/migrate-resend-segments.ts`
- **PAID_PLANS** (1 connections) — `scripts/ops/reconcile-resend-segments.ts`
- **prisma** (1 connections) — `scripts/ops/reconcile-resend-segments.ts`
- **resend** (1 connections) — `scripts/ops/reconcile-resend-segments.ts`

## Relationships

- [Database Client and Migrations](Database_Client_and_Migrations.md) (2 shared connections)
- [Database Migration Scripts](Database_Migration_Scripts.md) (2 shared connections)
- [Email Package Configuration](Email_Package_Configuration.md) (1 shared connections)
- [Email Broadcast Analytics](Email_Broadcast_Analytics.md) (1 shared connections)
- [Resend Contact Sync Processor](Resend_Contact_Sync_Processor.md) (1 shared connections)

## Source Files

- `packages/email/package.json`
- `scripts/migrations/migrate-resend-segments.ts`
- `scripts/ops/reconcile-resend-segments.ts`

## Audit Trail

- EXTRACTED: 18 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*