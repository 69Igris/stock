/**
 * Checkout 404 Retry Flow Tests
 *
 * De-shadowed (MONEY-620): previously this file re-implemented the checkout
 * 404-retry decision logic (isCheckout404, canRetryWithRefreshed, sanitized
 * messages) inline and asserted the copy. It now imports the REAL exports from
 * `@/lib/payments/checkout-logic` — the same functions
 * `createCheckoutAction` (apps/web/lib/actions/subscription.ts) calls. The thin
 * `attemptCheckoutWithRetry` driver below stands in for the Prisma-coupled
 * orchestration; the DECISIONS it makes are the real source.
 *
 * Source: packages/core/src/payments/checkout-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isCheckout404,
  canRetryWithRefreshed,
  getCheckoutFailedErrorMessage,
  getCheckoutFailedUserMessage,
  getPlanUnavailableUserMessage,
  type RefreshedProductInfo,
} from "../../src/payments/checkout-logic";

// ============== TYPES ==============

interface CheckoutResult {
  paymentId: string;
  url: string | null | undefined;
  subscriptionId?: string;
}

interface PaymentRecord {
  id: string;
  status: string;
  errorMessage?: string;
  dodoPaymentId?: string;
  metadata?: Record<string, unknown>;
}

interface CheckoutOutcome {
  success: boolean;
  checkoutUrl?: string;
  paymentId?: string;
  error?: string;
}

// ============== TEST-ONLY DRIVER (mirrors createCheckoutAction's retry flow) ==
// Stands in for the Prisma `update` + Dodo `create` orchestration; the
// 404-detect / retry-gate / sanitized-message DECISIONS are the REAL source.

async function attemptCheckoutWithRetry(opts: {
  originalProductId: string;
  isRecurring: boolean;
  paymentId: string;
  createCheckoutFn: (
    productId: string,
    isRecurring: boolean,
  ) => Promise<CheckoutResult>;
  syncProductsFn: () => Promise<void>;
  getProductInfoFn: () => Promise<RefreshedProductInfo | null>;
  updatePaymentFn: (id: string, data: Partial<PaymentRecord>) => Promise<void>;
}): Promise<CheckoutOutcome> {
  const {
    originalProductId,
    isRecurring,
    paymentId,
    createCheckoutFn,
    syncProductsFn,
    getProductInfoFn,
    updatePaymentFn,
  } = opts;

  try {
    let checkoutResult: CheckoutResult;

    try {
      checkoutResult = await createCheckoutFn(originalProductId, isRecurring);
    } catch (firstError: unknown) {
      if (!isCheckout404(firstError)) throw firstError;

      // Re-sync products from Dodo
      await syncProductsFn();

      const refreshedInfo = await getProductInfoFn();
      if (!canRetryWithRefreshed(refreshedInfo, originalProductId)) {
        // Same ID or still missing - product genuinely doesn't exist in Dodo
        throw firstError;
      }

      // Retry with new product ID (narrowed by the guard above)
      checkoutResult = await createCheckoutFn(
        refreshedInfo.productId,
        refreshedInfo.isRecurring,
      );
    }

    // Update payment with Dodo payment ID
    await updatePaymentFn(paymentId, {
      dodoPaymentId: checkoutResult.paymentId,
    });

    return {
      success: true,
      checkoutUrl: checkoutResult.url ?? undefined,
      paymentId,
    };
  } catch {
    // Mark the payment as failed with sanitized message
    await updatePaymentFn(paymentId, {
      status: "FAILED",
      errorMessage: getCheckoutFailedErrorMessage(),
    });

    return {
      success: false,
      error: getCheckoutFailedUserMessage(),
    };
  }
}

// ============== HELPERS ==============

function makeCheckoutResult(
  overrides: Partial<CheckoutResult> = {},
): CheckoutResult {
  return {
    paymentId: "dodo_pay_new_001",
    url: "https://checkout.dodopayments.com/session/abc123",
    ...overrides,
  };
}

function make404CheckoutError(productId?: string): Error {
  return new Error(`Product ${productId || "prod_stale"} not found - 404`);
}

function makeDoesNotExistError(productId?: string): Error {
  return new Error(`Product ${productId || "prod_stale"} does not exist`);
}

function makeNon404Error(): Error {
  return new Error("Internal server error: payment gateway unavailable");
}

function makeRateLimitError(): Error {
  return new Error("Rate limit exceeded - 429");
}

// ============== TESTS ==============

describe("Checkout 404 Retry Flow", () => {
  // ── isCheckout404 detection ────────────────────────────────

  describe("isCheckout404", () => {
    it("should detect 404 in error message", () => {
      assert.strictEqual(isCheckout404(make404CheckoutError()), true);
    });

    it("should detect 'does not exist' in error message", () => {
      assert.strictEqual(isCheckout404(makeDoesNotExistError()), true);
    });

    it("should not detect non-404 errors", () => {
      assert.strictEqual(isCheckout404(makeNon404Error()), false);
    });

    it("should not detect rate limit errors as 404", () => {
      assert.strictEqual(isCheckout404(makeRateLimitError()), false);
    });

    it("should return false for non-Error objects", () => {
      assert.strictEqual(isCheckout404("string error"), false);
      assert.strictEqual(isCheckout404(null), false);
      assert.strictEqual(isCheckout404(42), false);
    });
  });

  // ── canRetryWithRefreshed ──────────────────────────────────

  describe("canRetryWithRefreshed", () => {
    it("should allow retry when refreshed ID differs from original", () => {
      const refreshed: RefreshedProductInfo = {
        productId: "prod_new_123",
        isRecurring: false,
      };
      assert.strictEqual(
        canRetryWithRefreshed(refreshed, "prod_stale_456"),
        true,
      );
    });

    it("should deny retry when refreshed ID is the same as original", () => {
      const refreshed: RefreshedProductInfo = {
        productId: "prod_stale_456",
        isRecurring: false,
      };
      assert.strictEqual(
        canRetryWithRefreshed(refreshed, "prod_stale_456"),
        false,
      );
    });

    it("should deny retry when refreshed info is null (no product found)", () => {
      assert.strictEqual(canRetryWithRefreshed(null, "prod_stale_456"), false);
    });

    it("should allow retry with different recurring status", () => {
      const refreshed: RefreshedProductInfo = {
        productId: "prod_new_789",
        isRecurring: true,
      };
      assert.strictEqual(
        canRetryWithRefreshed(refreshed, "prod_old_789"),
        true,
      );
    });
  });

  // ── Retry with new product ID after 404 ────────────────────

  describe("Retry with new product ID after 404 re-sync", () => {
    it("should succeed by retrying with refreshed product ID", async () => {
      let createCallCount = 0;
      const createCheckoutFn = async (
        productId: string,
        _isRecurring: boolean,
      ): Promise<CheckoutResult> => {
        createCallCount++;
        if (createCallCount === 1) {
          throw make404CheckoutError(productId);
        }
        return makeCheckoutResult({
          paymentId: "dodo_pay_retry_success",
          url: "https://checkout.dodopayments.com/retry",
        });
      };

      let syncCalled = false;
      const syncProductsFn = async (): Promise<void> => {
        syncCalled = true;
      };

      const getProductInfoFn =
        async (): Promise<RefreshedProductInfo | null> => ({
          productId: "prod_refreshed_001",
          isRecurring: false,
        });

      const updates: Array<{ id: string; data: Partial<PaymentRecord> }> = [];
      const updatePaymentFn = async (
        id: string,
        data: Partial<PaymentRecord>,
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await attemptCheckoutWithRetry({
        originalProductId: "prod_stale_001",
        isRecurring: false,
        paymentId: "pay_internal_001",
        createCheckoutFn,
        syncProductsFn,
        getProductInfoFn,
        updatePaymentFn,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        result.checkoutUrl,
        "https://checkout.dodopayments.com/retry",
      );
      assert.strictEqual(createCallCount, 2);
      assert.strictEqual(syncCalled, true);
      // Payment should be updated with new Dodo payment ID
      assert.strictEqual(updates.length, 1);
      assert.strictEqual(
        updates[0].data.dodoPaymentId,
        "dodo_pay_retry_success",
      );
    });

    it("should pass refreshed isRecurring flag on retry", async () => {
      const checkoutCalls: Array<{
        productId: string;
        isRecurring: boolean;
      }> = [];

      const createCheckoutFn = async (
        productId: string,
        isRecurring: boolean,
      ): Promise<CheckoutResult> => {
        checkoutCalls.push({ productId, isRecurring });
        if (checkoutCalls.length === 1) {
          throw make404CheckoutError(productId);
        }
        return makeCheckoutResult();
      };

      const syncProductsFn = async (): Promise<void> => {};
      const getProductInfoFn =
        async (): Promise<RefreshedProductInfo | null> => ({
          productId: "prod_new_recurring",
          isRecurring: true, // changed from original false
        });
      const updatePaymentFn = async (): Promise<void> => {};

      await attemptCheckoutWithRetry({
        originalProductId: "prod_old_one_time",
        isRecurring: false, // original was not recurring
        paymentId: "pay_001",
        createCheckoutFn,
        syncProductsFn,
        getProductInfoFn,
        updatePaymentFn,
      });

      assert.strictEqual(checkoutCalls.length, 2);
      assert.strictEqual(checkoutCalls[0].productId, "prod_old_one_time");
      assert.strictEqual(checkoutCalls[0].isRecurring, false);
      assert.strictEqual(checkoutCalls[1].productId, "prod_new_recurring");
      assert.strictEqual(checkoutCalls[1].isRecurring, true);
    });
  });

  // ── Fail when re-sync returns same stale ID ────────────────

  describe("Fail gracefully when re-sync returns same stale ID", () => {
    it("should fail and mark payment as FAILED when product ID unchanged", async () => {
      const createCheckoutFn = async (
        productId: string,
      ): Promise<CheckoutResult> => {
        throw make404CheckoutError(productId);
      };

      let syncCalled = false;
      const syncProductsFn = async (): Promise<void> => {
        syncCalled = true;
      };

      // Re-sync returns same stale ID
      const getProductInfoFn =
        async (): Promise<RefreshedProductInfo | null> => ({
          productId: "prod_stale_same",
          isRecurring: false,
        });

      const updates: Array<{ id: string; data: Partial<PaymentRecord> }> = [];
      const updatePaymentFn = async (
        id: string,
        data: Partial<PaymentRecord>,
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await attemptCheckoutWithRetry({
        originalProductId: "prod_stale_same",
        isRecurring: false,
        paymentId: "pay_stale_001",
        createCheckoutFn,
        syncProductsFn,
        getProductInfoFn,
        updatePaymentFn,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(syncCalled, true);
      assert.ok(result.error);
      assert.strictEqual(result.error, getCheckoutFailedUserMessage());

      // Payment record should be marked FAILED with sanitized message
      assert.strictEqual(updates.length, 1);
      assert.strictEqual(updates[0].data.status, "FAILED");
      assert.strictEqual(
        updates[0].data.errorMessage,
        getCheckoutFailedErrorMessage(),
      );
    });

    it("should not attempt a second checkout call when product ID is same", async () => {
      let createCallCount = 0;
      const createCheckoutFn = async (
        productId: string,
      ): Promise<CheckoutResult> => {
        createCallCount++;
        throw make404CheckoutError(productId);
      };

      const syncProductsFn = async (): Promise<void> => {};
      const getProductInfoFn =
        async (): Promise<RefreshedProductInfo | null> => ({
          productId: "prod_unchanged",
          isRecurring: false,
        });
      const updatePaymentFn = async (): Promise<void> => {};

      await attemptCheckoutWithRetry({
        originalProductId: "prod_unchanged",
        isRecurring: false,
        paymentId: "pay_001",
        createCheckoutFn,
        syncProductsFn,
        getProductInfoFn,
        updatePaymentFn,
      });

      // Should only have called createCheckout once (the initial attempt)
      assert.strictEqual(createCallCount, 1);
    });
  });

  // ── Fail when re-sync finds no product ─────────────────────

  describe("Fail gracefully when re-sync finds no product", () => {
    it("should fail and mark payment as FAILED when no product found after sync", async () => {
      const createCheckoutFn = async (
        productId: string,
      ): Promise<CheckoutResult> => {
        throw make404CheckoutError(productId);
      };

      let syncCalled = false;
      const syncProductsFn = async (): Promise<void> => {
        syncCalled = true;
      };

      // Re-sync returns null - product not found
      const getProductInfoFn = async (): Promise<RefreshedProductInfo | null> =>
        null;

      const updates: Array<{ id: string; data: Partial<PaymentRecord> }> = [];
      const updatePaymentFn = async (
        id: string,
        data: Partial<PaymentRecord>,
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await attemptCheckoutWithRetry({
        originalProductId: "prod_deleted",
        isRecurring: false,
        paymentId: "pay_deleted_001",
        createCheckoutFn,
        syncProductsFn,
        getProductInfoFn,
        updatePaymentFn,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(syncCalled, true);
      assert.strictEqual(result.error, getCheckoutFailedUserMessage());

      // Payment record marked FAILED with sanitized message
      assert.strictEqual(updates.length, 1);
      assert.strictEqual(updates[0].data.status, "FAILED");
      assert.strictEqual(
        updates[0].data.errorMessage,
        getCheckoutFailedErrorMessage(),
      );
    });
  });

  // ── Non-404 errors should not trigger retry ────────────────

  describe("Non-404 errors should not trigger retry", () => {
    it("should fail immediately for non-404 errors without syncing", async () => {
      const createCheckoutFn = async (): Promise<CheckoutResult> => {
        throw makeNon404Error();
      };

      let syncCalled = false;
      const syncProductsFn = async (): Promise<void> => {
        syncCalled = true;
      };

      const getProductInfoFn =
        async (): Promise<RefreshedProductInfo | null> => ({
          productId: "prod_new",
          isRecurring: false,
        });

      const updates: Array<{ id: string; data: Partial<PaymentRecord> }> = [];
      const updatePaymentFn = async (
        id: string,
        data: Partial<PaymentRecord>,
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await attemptCheckoutWithRetry({
        originalProductId: "prod_original",
        isRecurring: false,
        paymentId: "pay_non404",
        createCheckoutFn,
        syncProductsFn,
        getProductInfoFn,
        updatePaymentFn,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(syncCalled, false); // sync should NOT be called
      assert.strictEqual(updates.length, 1);
      assert.strictEqual(updates[0].data.status, "FAILED");
    });

    it("should fail immediately for rate limit errors without syncing", async () => {
      const createCheckoutFn = async (): Promise<CheckoutResult> => {
        throw makeRateLimitError();
      };

      let syncCalled = false;
      const syncProductsFn = async (): Promise<void> => {
        syncCalled = true;
      };
      const getProductInfoFn = async (): Promise<RefreshedProductInfo | null> =>
        null;
      const updatePaymentFn = async (): Promise<void> => {};

      const result = await attemptCheckoutWithRetry({
        originalProductId: "prod_any",
        isRecurring: false,
        paymentId: "pay_ratelimit",
        createCheckoutFn,
        syncProductsFn,
        getProductInfoFn,
        updatePaymentFn,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(syncCalled, false);
    });
  });

  // ── Error message sanitization in payment record ───────────

  describe("Error message sanitization in payment record", () => {
    it("should store sanitized message, not raw Dodo error", async () => {
      const rawDodoError =
        "DodoPayments API Error: POST https://api.dodopayments.com/v1/payments 404 - Product prod_abc123 not found in merchant account biz_xyz789";

      const createCheckoutFn = async (): Promise<CheckoutResult> => {
        throw new Error(rawDodoError);
      };
      const syncProductsFn = async (): Promise<void> => {};
      const getProductInfoFn = async (): Promise<RefreshedProductInfo | null> =>
        null;

      const updates: Array<{ id: string; data: Partial<PaymentRecord> }> = [];
      const updatePaymentFn = async (
        id: string,
        data: Partial<PaymentRecord>,
      ): Promise<void> => {
        updates.push({ id, data });
      };

      await attemptCheckoutWithRetry({
        originalProductId: "prod_abc123",
        isRecurring: false,
        paymentId: "pay_sanitize_test",
        createCheckoutFn,
        syncProductsFn,
        getProductInfoFn,
        updatePaymentFn,
      });

      assert.strictEqual(updates.length, 1);
      const storedMessage = updates[0].data.errorMessage!;

      // Stored message must be sanitized
      assert.strictEqual(
        storedMessage,
        "Payment checkout could not be created",
      );
      // Must NOT contain raw API details
      assert.strictEqual(storedMessage.includes("api.dodopayments.com"), false);
      assert.strictEqual(storedMessage.includes("prod_abc123"), false);
      assert.strictEqual(storedMessage.includes("biz_xyz789"), false);
      assert.strictEqual(storedMessage.includes("POST"), false);
      assert.strictEqual(storedMessage.includes("merchant"), false);
    });

    it("should return sanitized user-facing error message", async () => {
      const createCheckoutFn = async (): Promise<CheckoutResult> => {
        throw makeNon404Error();
      };
      const syncProductsFn = async (): Promise<void> => {};
      const getProductInfoFn = async (): Promise<RefreshedProductInfo | null> =>
        null;
      const updatePaymentFn = async (): Promise<void> => {};

      const result = await attemptCheckoutWithRetry({
        originalProductId: "prod_any",
        isRecurring: false,
        paymentId: "pay_user_msg",
        createCheckoutFn,
        syncProductsFn,
        getProductInfoFn,
        updatePaymentFn,
      });

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      // User-facing message must not contain technical details
      assert.strictEqual(result.error!.includes("Error"), false);
      assert.strictEqual(result.error!.includes("500"), false);
      assert.strictEqual(result.error!.includes("gateway"), false);
    });

    it("DB error message should not contain HTTP status codes", () => {
      const msg = getCheckoutFailedErrorMessage();
      assert.strictEqual(msg.includes("404"), false);
      assert.strictEqual(msg.includes("500"), false);
      assert.strictEqual(msg.includes("429"), false);
    });

    it("DB error message should not contain API URLs", () => {
      const msg = getCheckoutFailedErrorMessage();
      assert.strictEqual(msg.includes("https://"), false);
      assert.strictEqual(msg.includes("http://"), false);
    });

    it("User-facing error message should be actionable", () => {
      const msg = getCheckoutFailedUserMessage();
      assert.ok(msg.includes("try again"));
    });

    it("plan-unavailable message is actionable, distinct, and leaks nothing (MONEY-1074)", () => {
      const msg = getPlanUnavailableUserMessage();
      assert.ok(msg.length > 0);
      assert.ok(msg.includes("try again"));
      // Distinct from the generic checkout-failed copy so the two cases read
      // differently to the user.
      assert.notStrictEqual(msg, getCheckoutFailedUserMessage());
      // No raw Dodo/HTTP detail leaked.
      assert.strictEqual(msg.includes("404"), false);
      assert.strictEqual(msg.includes("https://"), false);
      assert.strictEqual(msg.toLowerCase().includes("dodo"), false);
    });
  });

  // ── Retry succeeds on second attempt ───────────────────────

  describe("Successful retry scenarios", () => {
    it("should succeed when first call gets 'does not exist' and retry works", async () => {
      let callCount = 0;
      const createCheckoutFn = async (
        productId: string,
      ): Promise<CheckoutResult> => {
        callCount++;
        if (callCount === 1) {
          throw makeDoesNotExistError(productId);
        }
        return makeCheckoutResult({
          paymentId: "dodo_retry_ok",
          url: "https://checkout.dodopayments.com/ok",
        });
      };

      const syncProductsFn = async (): Promise<void> => {};
      const getProductInfoFn =
        async (): Promise<RefreshedProductInfo | null> => ({
          productId: "prod_new_after_sync",
          isRecurring: true,
        });
      const updatePaymentFn = async (): Promise<void> => {};

      const result = await attemptCheckoutWithRetry({
        originalProductId: "prod_old",
        isRecurring: false,
        paymentId: "pay_retry_ok",
        createCheckoutFn,
        syncProductsFn,
        getProductInfoFn,
        updatePaymentFn,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(callCount, 2);
      assert.strictEqual(
        result.checkoutUrl,
        "https://checkout.dodopayments.com/ok",
      );
    });

    it("should handle checkout returning null URL", async () => {
      const createCheckoutFn = async (): Promise<CheckoutResult> => {
        return makeCheckoutResult({ url: null });
      };
      const syncProductsFn = async (): Promise<void> => {};
      const getProductInfoFn = async (): Promise<RefreshedProductInfo | null> =>
        null;
      const updatePaymentFn = async (): Promise<void> => {};

      const result = await attemptCheckoutWithRetry({
        originalProductId: "prod_001",
        isRecurring: false,
        paymentId: "pay_null_url",
        createCheckoutFn,
        syncProductsFn,
        getProductInfoFn,
        updatePaymentFn,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.checkoutUrl, undefined); // null coerced to undefined
    });

    it("should update payment record with new Dodo payment ID on success", async () => {
      const createCheckoutFn = async (): Promise<CheckoutResult> => {
        return makeCheckoutResult({ paymentId: "dodo_final_id" });
      };
      const syncProductsFn = async (): Promise<void> => {};
      const getProductInfoFn = async (): Promise<RefreshedProductInfo | null> =>
        null;

      const updates: Array<{ id: string; data: Partial<PaymentRecord> }> = [];
      const updatePaymentFn = async (
        id: string,
        data: Partial<PaymentRecord>,
      ): Promise<void> => {
        updates.push({ id, data });
      };

      await attemptCheckoutWithRetry({
        originalProductId: "prod_001",
        isRecurring: false,
        paymentId: "pay_update_test",
        createCheckoutFn,
        syncProductsFn,
        getProductInfoFn,
        updatePaymentFn,
      });

      assert.strictEqual(updates.length, 1);
      assert.strictEqual(updates[0].id, "pay_update_test");
      assert.strictEqual(updates[0].data.dodoPaymentId, "dodo_final_id");
      // Should NOT have a FAILED status on success
      assert.strictEqual(updates[0].data.status, undefined);
    });
  });

  // ── Retry fails on second attempt ──────────────────────────

  describe("Retry fails on second attempt", () => {
    it("should fail when retry also throws 404", async () => {
      let callCount = 0;
      const createCheckoutFn = async (
        productId: string,
      ): Promise<CheckoutResult> => {
        callCount++;
        throw make404CheckoutError(productId);
      };

      const syncProductsFn = async (): Promise<void> => {};
      const getProductInfoFn =
        async (): Promise<RefreshedProductInfo | null> => ({
          productId: "prod_different_but_also_bad",
          isRecurring: false,
        });

      const updates: Array<{ id: string; data: Partial<PaymentRecord> }> = [];
      const updatePaymentFn = async (
        id: string,
        data: Partial<PaymentRecord>,
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await attemptCheckoutWithRetry({
        originalProductId: "prod_original_bad",
        isRecurring: false,
        paymentId: "pay_double_fail",
        createCheckoutFn,
        syncProductsFn,
        getProductInfoFn,
        updatePaymentFn,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(callCount, 2);
      assert.strictEqual(updates.length, 1);
      assert.strictEqual(updates[0].data.status, "FAILED");
      assert.strictEqual(
        updates[0].data.errorMessage,
        getCheckoutFailedErrorMessage(),
      );
    });

    it("should fail when retry throws a non-404 error", async () => {
      let callCount = 0;
      const createCheckoutFn = async (
        productId: string,
      ): Promise<CheckoutResult> => {
        callCount++;
        if (callCount === 1) {
          throw make404CheckoutError(productId);
        }
        throw makeNon404Error(); // different error on retry
      };

      const syncProductsFn = async (): Promise<void> => {};
      const getProductInfoFn =
        async (): Promise<RefreshedProductInfo | null> => ({
          productId: "prod_new_but_fails",
          isRecurring: false,
        });

      const updates: Array<{ id: string; data: Partial<PaymentRecord> }> = [];
      const updatePaymentFn = async (
        id: string,
        data: Partial<PaymentRecord>,
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await attemptCheckoutWithRetry({
        originalProductId: "prod_original",
        isRecurring: false,
        paymentId: "pay_retry_non404",
        createCheckoutFn,
        syncProductsFn,
        getProductInfoFn,
        updatePaymentFn,
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(callCount, 2);
      assert.strictEqual(updates[0].data.status, "FAILED");
    });
  });
});
