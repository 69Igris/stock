# Subscription Billing Plans

> 73 nodes

## Key Concepts

- **subscription-grants.service.ts** (41 connections) — `packages/services/src/subscription-grants.service.ts`
- **payment-provisioning.service.ts** (38 connections) — `packages/services/src/payment-provisioning.service.ts`
- **plan-config.ts** (33 connections) — `packages/core/src/payments/plan-config.ts`
- **invalidateEntitlement()** (16 connections) — `packages/services/src/entitlement-invalidation.ts`
- **payment-provisioning-logic.ts** (13 connections) — `packages/services/src/payment-provisioning-logic.ts`
- **grantWebhookSubscription()** (12 connections) — `packages/services/src/subscription-grants.service.ts`
- **provisionPaymentCompleted()** (11 connections) — `packages/services/src/payment-provisioning.service.ts`
- **grantCallbackSubscription()** (11 connections) — `packages/services/src/subscription-grants.service.ts`
- **provisionDodoWebhookEvent()** (10 connections) — `packages/services/src/payment-provisioning.service.ts`
- **entitlement-invalidation.ts** (9 connections) — `packages/services/src/entitlement-invalidation.ts`
- **applyDodoRenewal()** (8 connections) — `packages/services/src/subscription-grants.service.ts`
- **PaymentNotifier** (7 connections) — `packages/services/src/payment-provisioning-logic.ts`
- **provisionPaymentCallbackGrant()** (7 connections) — `packages/services/src/payment-provisioning.service.ts`
- **buildProEntitlementFields()** (7 connections) — `packages/services/src/subscription-logic.ts`
- **getAddonQueries()** (5 connections) — `packages/core/src/payments/plan-config.ts`
- **claimPaymentFulfillment()** (5 connections) — `packages/services/src/payment-grant.service.ts`
- **extractDodoSubscriptionId()** (5 connections) — `packages/services/src/payment-provisioning-logic.ts`
- **provisionSubscriptionCancelled()** (5 connections) — `packages/services/src/payment-provisioning.service.ts`
- **applyDodoCancellation()** (5 connections) — `packages/services/src/subscription-grants.service.ts`
- **payment-provisioning.test.ts** (5 connections) — `packages/services/__tests__/payment-provisioning.test.ts`
- **calculatePackCreditLimit()** (4 connections) — `packages/core/src/payments/plan-config.ts`
- **calculateQueryPackLimits()** (4 connections) — `packages/core/src/payments/plan-config.ts`
- **determineQueryPackEndDate()** (4 connections) — `packages/core/src/payments/plan-config.ts`
- **extractCreditPackSize()** (4 connections) — `packages/core/src/payments/plan-config.ts`
- **getReadablePlanName()** (4 connections) — `packages/core/src/payments/plan-config.ts`
- *... and 48 more nodes in this community*

## Relationships

- [Dynamic Run Credits Estimation](Dynamic_Run_Credits_Estimation.md) (22 shared connections)
- [Dodo Payments Client Integration](Dodo_Payments_Client_Integration.md) (10 shared connections)
- [Coupon and Discount Logic](Coupon_and_Discount_Logic.md) (10 shared connections)
- [Admin Audit and Consent](Admin_Audit_and_Consent.md) (8 shared connections)
- [Subscription Proration Billing Logic](Subscription_Proration_Billing_Logic.md) (5 shared connections)
- [Cache Key Management](Cache_Key_Management.md) (3 shared connections)
- [Application Logging Framework](Application_Logging_Framework.md) (3 shared connections)
- [Content Access and Pagination](Content_Access_and_Pagination.md) (2 shared connections)
- [Database Client and Migrations](Database_Client_and_Migrations.md) (2 shared connections)

## Source Files

- `packages/core/__tests__/payments/plan-config.test.ts`
- `packages/core/src/payments/plan-config.ts`
- `packages/services/__tests__/payment-provisioning.test.ts`
- `packages/services/src/entitlement-invalidation.ts`
- `packages/services/src/payment-grant.service.ts`
- `packages/services/src/payment-provisioning-logic.ts`
- `packages/services/src/payment-provisioning.service.ts`
- `packages/services/src/subscription-grants.service.ts`
- `packages/services/src/subscription-logic.ts`
- `packages/services/src/subscription.service.ts`

## Audit Trail

- EXTRACTED: 210 (97%)
- INFERRED: 6 (3%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*