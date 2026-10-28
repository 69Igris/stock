# Dynamic Run Credits Estimation

> 106 nodes

## Key Concepts

- **subscription.service.ts** (60 connections) — `packages/services/src/subscription.service.ts`
- **subscription-logic.ts** (52 connections) — `packages/services/src/subscription-logic.ts`
- **core/src/subscription/index.ts** (42 connections) — `packages/core/src/subscription/index.ts`
- **resolvePlanId()** (33 connections) — `packages/core/src/subscription/plans.ts`
- **plans.ts** (22 connections) — `packages/core/src/subscription/plans.ts`
- **dynamic-credits.ts** (15 connections) — `packages/core/src/subscription/dynamic-credits.ts`
- **hasFeatureAccess()** (12 connections) — `packages/core/src/subscription/features.ts`
- **reconcile-paid-plans.ts** (11 connections) — `scripts/migrations/reconcile-paid-plans.ts`
- **getPlanCredits()** (10 connections) — `packages/core/src/subscription/plans.ts`
- **resolveEntitlementPlan()** (10 connections) — `packages/services/src/subscription-logic.ts`
- **getSubscription()** (10 connections) — `packages/services/src/subscription.service.ts`
- **computeRunCredits()** (9 connections) — `packages/core/src/subscription/dynamic-credits.ts`
- **features.ts** (9 connections) — `packages/core/src/subscription/features.ts`
- **plan-display.ts** (9 connections) — `packages/core/src/subscription/plan-display.ts`
- **PLAN_CONFIG** (9 connections) — `packages/core/src/subscription/plans.ts`
- **PlanId** (8 connections) — `packages/core/src/subscription/plans.ts`
- **isValidDate()** (8 connections) — `packages/services/src/subscription-logic.ts`
- **resolveBasePlan()** (8 connections) — `packages/services/src/subscription-logic.ts`
- **getPlanConfigSafe()** (8 connections) — `packages/services/src/subscription.service.ts`
- **getPlanConfig()** (5 connections) — `packages/core/src/subscription/plans.ts`
- **getCreditBalance()** (5 connections) — `packages/services/src/credit.service.ts`
- **buildSubscriptionAccess()** (5 connections) — `packages/services/src/subscription-logic.ts`
- **deriveNextBillingDate()** (5 connections) — `packages/services/src/subscription-logic.ts`
- **downgradeWithGracePeriod()** (5 connections) — `packages/services/src/subscription.service.ts`
- **refreshPendingPayments()** (5 connections) — `packages/services/src/subscription.service.ts`
- *... and 81 more nodes in this community*

## Relationships

- [Subscription Billing Plans](Subscription_Billing_Plans.md) (22 shared connections)
- [Comprehensive Analysis Service](Comprehensive_Analysis_Service.md) (16 shared connections)
- [Gemini Model Registry](Gemini_Model_Registry.md) (13 shared connections)
- [Coupon and Discount Logic](Coupon_and_Discount_Logic.md) (8 shared connections)
- [Dodo Payments Client Integration](Dodo_Payments_Client_Integration.md) (7 shared connections)
- [Subscription Proration Billing Logic](Subscription_Proration_Billing_Logic.md) (7 shared connections)
- [Portfolio Roast Scoring](Portfolio_Roast_Scoring.md) (4 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (4 shared connections)
- [Content Metrics and Slugs](Content_Metrics_and_Slugs.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (3 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (3 shared connections)
- [Learning Course Progress Tracking](Learning_Course_Progress_Tracking.md) (2 shared connections)

## Source Files

- `packages/core/__tests__/dynamic-credits.test.ts`
- `packages/core/src/subscription/dynamic-credits.ts`
- `packages/core/src/subscription/features.ts`
- `packages/core/src/subscription/index.ts`
- `packages/core/src/subscription/plan-display.ts`
- `packages/core/src/subscription/plans.ts`
- `packages/services/__tests__/pro-entitlement.test.ts`
- `packages/services/__tests__/subscription-access-logic.test.ts`
- `packages/services/src/credit.service.ts`
- `packages/services/src/subscription-logic.ts`
- `packages/services/src/subscription.service.ts`
- `scripts/migrations/reconcile-paid-plans.ts`

## Audit Trail

- EXTRACTED: 328 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*