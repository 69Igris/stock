# Checkout Flow and Retry Logic

> 17 nodes

## Key Concepts

- **checkout-logic.test.ts** (16 connections) — `packages/core/__tests__/payments/checkout-logic.test.ts`
- **checkout-logic.ts** (7 connections) — `packages/core/src/payments/checkout-logic.ts`
- **attemptCheckoutWithRetry()** (5 connections) — `packages/core/__tests__/payments/checkout-logic.test.ts`
- **canRetryWithRefreshed()** (3 connections) — `packages/core/src/payments/checkout-logic.ts`
- **getCheckoutFailedErrorMessage()** (3 connections) — `packages/core/src/payments/checkout-logic.ts`
- **getCheckoutFailedUserMessage()** (3 connections) — `packages/core/src/payments/checkout-logic.ts`
- **isCheckout404()** (3 connections) — `packages/core/src/payments/checkout-logic.ts`
- **RefreshedProductInfo** (2 connections) — `packages/core/src/payments/checkout-logic.ts`
- **getPlanUnavailableUserMessage()** (2 connections) — `packages/core/src/payments/checkout-logic.ts`
- **CheckoutOutcome** (1 connections) — `packages/core/__tests__/payments/checkout-logic.test.ts`
- **CheckoutResult** (1 connections) — `packages/core/__tests__/payments/checkout-logic.test.ts`
- **PaymentRecord** (1 connections) — `packages/core/__tests__/payments/checkout-logic.test.ts`
- **make404CheckoutError()** (1 connections) — `packages/core/__tests__/payments/checkout-logic.test.ts`
- **makeCheckoutResult()** (1 connections) — `packages/core/__tests__/payments/checkout-logic.test.ts`
- **makeDoesNotExistError()** (1 connections) — `packages/core/__tests__/payments/checkout-logic.test.ts`
- **makeNon404Error()** (1 connections) — `packages/core/__tests__/payments/checkout-logic.test.ts`
- **makeRateLimitError()** (1 connections) — `packages/core/__tests__/payments/checkout-logic.test.ts`

## Relationships

- No strong cross-community connections detected

## Source Files

- `packages/core/__tests__/payments/checkout-logic.test.ts`
- `packages/core/src/payments/checkout-logic.ts`

## Audit Trail

- EXTRACTED: 26 (100%)
- INFERRED: 0 (0%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [index](index.md) to navigate.*