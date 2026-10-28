# Payment Callback Handling

> 14 nodes

## Key Concepts

- **payments-callback.test.ts** (11 connections) — `__tests__/api/payments-callback.test.ts`
- **payments/callback/route.ts** (10 connections) — `app/api/payments/callback/route.ts`
- **callback-logic.ts** (7 connections) — `app/api/payments/callback/callback-logic.ts`
- **GET()** (6 connections) — `app/api/payments/callback/route.ts`
- **buildPricingErrorPath()** (4 connections) — `app/api/payments/callback/callback-logic.ts`
- **buildSubscriptionPendingPath()** (4 connections) — `app/api/payments/callback/callback-logic.ts`
- **getCallbackBaseUrl()** (4 connections) — `app/api/payments/callback/callback-logic.ts`
- **validateCallbackParams()** (4 connections) — `app/api/payments/callback/callback-logic.ts`
- **SUBSCRIPTION_SUCCESS_PATH** (3 connections) — `app/api/payments/callback/callback-logic.ts`
- **applyClaimThenRead()** (2 connections) — `__tests__/api/payments-callback.test.ts`
- **claimFulfillment()** (2 connections) — `__tests__/api/payments-callback.test.ts`
- **ClaimablePayment** (1 connections) — `__tests__/api/payments-callback.test.ts`
- **SubRow** (1 connections) — `__tests__/api/payments-callback.test.ts`
- **pushAddon()** (1 connections) — `__tests__/api/payments-callback.test.ts`

## Relationships

- [Holdings & Analysis Actions](Holdings_&_Analysis_Actions.md) (3 shared connections)
- [Auth & Integration Routes](Auth_&_Integration_Routes.md) (1 shared connections)

## Source Files

- `__tests__/api/payments-callback.test.ts`
- `app/api/payments/callback/callback-logic.ts`
- `app/api/payments/callback/route.ts`

## Audit Trail

- EXTRACTED: 32 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*