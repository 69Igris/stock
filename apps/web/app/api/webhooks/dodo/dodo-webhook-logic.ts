/**
 * Backward-compat re-export shim — MONEY-1062 (W1-B).
 *
 * `sanitizePaymentError` + `extractDodoSubscriptionId` were the two pure webhook
 * helpers that used to live here. The subscription-provisioning grant moved into
 * `@usemoney/services` (a package cannot import from `apps/web`), so their single
 * source of truth moved down with it — see
 * packages/services/src/payment-provisioning-logic.ts.
 *
 * This shim keeps the original import path working for the edge-case contract
 * test (`apps/web/__tests__/api/webhooks-dodo-edge-cases.test.ts`), which asserts
 * these helpers directly. The thin webhook route no longer imports from here.
 */

export {
  sanitizePaymentError,
  extractDodoSubscriptionId,
} from "@usemoney/services/payment-provisioning-logic";
