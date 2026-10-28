# Dodo Payments Client Integration

> 46 nodes

## Key Concepts

- **scheduled-plan-changes.service.ts** (20 connections) — `packages/services/src/scheduled-plan-changes.service.ts`
- **product-sync-logic.ts** (19 connections) — `packages/services/src/product-sync-logic.ts`
- **product-sync.service.ts** (18 connections) — `packages/services/src/product-sync.service.ts`
- **payments/index.ts** (14 connections) — `packages/core/src/payments/index.ts`
- **product-sync-logic.test.ts** (12 connections) — `packages/services/__tests__/product-sync-logic.test.ts`
- **dodo.ts** (10 connections) — `packages/core/src/payments/dodo.ts`
- **scheduled-plan-changes-logic.ts** (9 connections) — `packages/services/src/scheduled-plan-changes-logic.ts`
- **dodoClient** (7 connections) — `packages/core/src/payments/dodo.ts`
- **isDodoConfigured()** (6 connections) — `packages/core/src/payments/dodo.ts`
- **getDodoClient()** (5 connections) — `packages/core/src/payments/dodo.ts`
- **cancelDodoSubscription()** (5 connections) — `packages/services/src/account-deletion.service.ts`
- **buildCreatePayload()** (5 connections) — `packages/services/src/product-sync-logic.ts`
- **buildUpdatePayload()** (5 connections) — `packages/services/src/product-sync-logic.ts`
- **mapProductToPlan()** (5 connections) — `packages/services/src/product-sync-logic.ts`
- **syncProductsCore()** (5 connections) — `packages/services/src/product-sync-logic.ts`
- **getDodoProductInfo()** (5 connections) — `packages/services/src/product-sync.service.ts`
- **syncDodoProducts()** (5 connections) — `packages/services/src/product-sync.service.ts`
- **applyScheduledChanges()** (5 connections) — `packages/services/src/scheduled-plan-changes.service.ts`
- **buildListParams()** (4 connections) — `packages/services/src/product-sync-logic.ts`
- **buildProductQuery()** (4 connections) — `packages/services/src/product-sync-logic.ts`
- **buildRebaseFields()** (4 connections) — `packages/services/src/scheduled-plan-changes-logic.ts`
- **paymentsLogger** (4 connections) — `packages/logger/src/index.ts`
- **getDodoMode()** (3 connections) — `packages/core/src/payments/dodo.ts`
- **WEBHOOK_PLANS** (3 connections) — `packages/core/src/payments/plan-config.ts`
- **PRODUCT_PLAN_MAPPING** (3 connections) — `packages/services/src/product-sync-logic.ts`
- *... and 21 more nodes in this community*

## Relationships

- [Subscription Billing Plans](Subscription_Billing_Plans.md) (10 shared connections)
- [Dynamic Run Credits Estimation](Dynamic_Run_Credits_Estimation.md) (7 shared connections)
- [User Account Deletion Pipeline](User_Account_Deletion_Pipeline.md) (5 shared connections)
- [Subscription Proration Billing Logic](Subscription_Proration_Billing_Logic.md) (3 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (3 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (3 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (3 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (1 shared connections)
- [Core Package Configuration](Core_Package_Configuration.md) (1 shared connections)

## Source Files

- `packages/core/package.json`
- `packages/core/src/payments/dodo.ts`
- `packages/core/src/payments/index.ts`
- `packages/core/src/payments/plan-config.ts`
- `packages/logger/src/index.ts`
- `packages/services/__tests__/product-sync-logic.test.ts`
- `packages/services/__tests__/scheduled-plan-changes.test.ts`
- `packages/services/src/account-deletion.service.ts`
- `packages/services/src/product-sync-logic.ts`
- `packages/services/src/product-sync.service.ts`
- `packages/services/src/scheduled-plan-changes-logic.ts`
- `packages/services/src/scheduled-plan-changes.service.ts`

## Audit Trail

- EXTRACTED: 128 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*