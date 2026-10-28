# Subscription Proration Billing Logic

> 35 nodes

## Key Concepts

- **subscription-management.service.ts** (33 connections) — `packages/services/src/subscription-management.service.ts`
- **proration.ts** (17 connections) — `packages/core/src/subscription/proration.ts`
- **parity-p4e-subscription-management.service.test.ts** (10 connections) — `packages/services/__tests__/parity-p4e-subscription-management.service.test.ts`
- **proration.test.ts** (9 connections) — `packages/core/__tests__/subscription/proration.test.ts`
- **computeFulfillmentBonusDays()** (8 connections) — `packages/core/src/subscription/proration.ts`
- **PlanConfig** (6 connections) — `packages/core/src/subscription/plans.ts`
- **computeTierUpgradeBonusDays()** (6 connections) — `packages/core/src/subscription/proration.ts`
- **previewSubscriptionChange()** (6 connections) — `packages/services/src/subscription-management.service.ts`
- **classifyTransition()** (5 connections) — `packages/core/src/subscription/proration.ts`
- **computeCycleAppendDays()** (5 connections) — `packages/core/src/subscription/proration.ts`
- **daysRemaining()** (5 connections) — `packages/core/src/subscription/proration.ts`
- **scheduleSubscriptionCancel()** (4 connections) — `packages/services/src/subscription-management.service.ts`
- **unscheduleSubscriptionChange()** (4 connections) — `packages/services/src/subscription-management.service.ts`
- **update()** (4 connections) — `packages/services/src/subscription-management.service.ts`
- **BillingCycle** (3 connections) — `packages/core/src/subscription/proration.ts`
- **TransitionKind** (3 connections) — `packages/core/src/subscription/proration.ts`
- **listPricePerDay()** (3 connections) — `packages/core/src/subscription/proration.ts`
- **resolveDodo()** (3 connections) — `packages/services/src/subscription-management.service.ts`
- **scheduleSubscriptionDowngrade()** (3 connections) — `packages/services/src/subscription-management.service.ts`
- **STANDARD_TERM_DAYS** (3 connections) — `packages/core/src/subscription/proration.ts`
- **TierUpgradeInput** (2 connections) — `packages/core/src/subscription/proration.ts`
- **DodoSubscriptionUpdater** (2 connections) — `packages/services/src/subscription-management.service.ts`
- **PlanChangePreviewData** (2 connections) — `packages/services/src/subscription-management.service.ts`
- **SubscriptionMgmtDeps** (2 connections) — `packages/services/src/subscription-management.service.ts`
- **computeAiCreditsPreflight()** (2 connections) — `packages/services/src/subscription-management.service.ts`
- *... and 10 more nodes in this community*

## Relationships

- [Dynamic Run Credits Estimation](Dynamic_Run_Credits_Estimation.md) (7 shared connections)
- [Subscription Billing Plans](Subscription_Billing_Plans.md) (5 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (3 shared connections)
- [Dodo Payments Client Integration](Dodo_Payments_Client_Integration.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (1 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (1 shared connections)

## Source Files

- `packages/core/__tests__/subscription/proration.test.ts`
- `packages/core/src/subscription/plans.ts`
- `packages/core/src/subscription/proration.ts`
- `packages/services/__tests__/parity-p4e-subscription-management.service.test.ts`
- `packages/services/src/subscription-management.service.ts`

## Audit Trail

- EXTRACTED: 91 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*