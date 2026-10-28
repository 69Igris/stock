/**
 * Payment Error Handling Tests
 *
 * De-shadowed (MONEY-620): previously this file re-implemented the
 * refreshPendingPayments decision logic (is404, status→patch mapping, sanitized
 * message) inline and asserted the copy. It now imports the REAL exports from
 * `@usemoney/services` subscription-logic — the same functions
 * `subscription.service.ts:refreshPendingPayments` calls. The only thing left in
 * the test is a thin driver loop standing in for the Prisma `findMany`/`update`
 * iteration (which is the DB-coupled half, not source logic).
 *
 * Source: packages/services/src/subscription-logic.ts
 *   - is404PaymentError, get404PaymentErrorMessage, getPaymentRefreshUpdate
 *   (called from packages/services/src/subscription.service.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  is404PaymentError,
  get404PaymentErrorMessage,
  getPaymentRefreshUpdate,
  type DodoPaymentStatusLike,
  type PaymentRefreshUpdate,
} from "../../../../packages/services/src/subscription-logic";

// ============== TEST-ONLY DRIVER (mirrors the Prisma loop in the service) ====
// This stands in for `findMany` + per-payment `update`; the DECISION it makes
// (getPaymentRefreshUpdate / is404PaymentError / get404PaymentErrorMessage) is
// the REAL source, so a production regression in those would fail this test.

interface PendingPayment {
  id: string;
  dodoPaymentId: string | null;
}

interface ServiceResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Optional grant hook mirroring the real service's MONEY-1074 wiring: after a
 * payment is patched to COMPLETED, `refreshPendingPayments` invokes the
 * claim-once `provisionPaymentCallbackGrant`. A grant throw is swallowed (logged)
 * so it never aborts the remaining pending rows. The COMPLETED gate here is the
 * REAL `getPaymentRefreshUpdate` decision, so this driver can't drift from the
 * source condition that decides whether a grant fires.
 */
type GrantFn = (paymentId: string) => Promise<void>;

/**
 * The Dodo wire payload as it actually arrives.
 *
 * `DodoPaymentStatusLike` deliberately declares ONLY `status` (and carries no
 * index signature, so the concrete Dodo SDK `Payment` type stays assignable) —
 * but `getPaymentRefreshUpdate` JSON-clones the WHOLE payload into
 * `metadata`, so these extra wire fields are load-bearing in the metadata
 * assertions below. Declared explicitly rather than cast away.
 */
type DodoPaymentWire = DodoPaymentStatusLike & {
  payment_id?: string;
  amount?: number;
  currency?: string;
  customer?: { email: string };
};

async function refreshPayments(
  pendingPayments: PendingPayment[],
  retrieveFn: (dodoPaymentId: string) => Promise<DodoPaymentStatusLike>,
  updateFn: (paymentId: string, data: PaymentRefreshUpdate) => Promise<void>,
  grantFn?: GrantFn
): Promise<ServiceResult<{ updated: number }>> {
  if (pendingPayments.length === 0) {
    return { success: true, data: { updated: 0 } };
  }

  let updated = 0;

  for (const payment of pendingPayments) {
    if (!payment.dodoPaymentId) continue;

    try {
      const dodoPayment = await retrieveFn(payment.dodoPaymentId);
      const updateData = getPaymentRefreshUpdate(dodoPayment);

      if (updateData) {
        await updateFn(payment.id, updateData);
        updated++;
        // MONEY-1074: apply the plan grant when the poll resolves COMPLETED.
        if (updateData.status === "COMPLETED" && grantFn) {
          try {
            await grantFn(payment.id);
          } catch {
            // Payment stays COMPLETED; the webhook / next refresh retries. One
            // bad grant must not abort the remaining pending rows.
          }
        }
      }
    } catch (err: unknown) {
      if (is404PaymentError(err)) {
        await updateFn(payment.id, {
          status: "FAILED",
          errorMessage: get404PaymentErrorMessage(),
        });
        updated++;
        // No grant on a 404→FAILED transition.
      }
      // Non-404 errors are logged but payment is NOT marked as FAILED
    }
  }

  return { success: true, data: { updated } };
}

// ============== HELPERS ==============

function makePayment(overrides: Partial<PendingPayment> = {}): PendingPayment {
  return {
    id: "pay_internal_001",
    dodoPaymentId: "dodo_pay_001",
    ...overrides,
  };
}

function make404Error(message?: string): Error {
  return new Error(message || "Resource not found - 404");
}

function make404ErrorWithStatus(): Error & { status?: number } {
  const err = new Error("Not Found") as Error & { status?: number };
  err.status = 404;
  return err;
}

function makeNetworkError(): Error {
  return new Error("ECONNREFUSED: Connection refused");
}

function makeTimeoutError(): Error {
  return new Error("Request timed out after 30000ms");
}

// ============== TESTS ==============

describe("Payment Error Handling", () => {
  // ── is404PaymentError detection ────────────────────────────

  describe("is404PaymentError", () => {
    it("should detect 404 in error message", () => {
      const err = new Error("Request failed with status 404");
      assert.strictEqual(is404PaymentError(err), true);
    });

    it("should detect 404 status property on error", () => {
      const err = make404ErrorWithStatus();
      assert.strictEqual(is404PaymentError(err), true);
    });

    it("should not detect non-404 error messages", () => {
      const err = new Error("Request failed with status 500");
      assert.strictEqual(is404PaymentError(err), false);
    });

    it("should not detect network errors as 404", () => {
      assert.strictEqual(is404PaymentError(makeNetworkError()), false);
    });

    it("should not detect timeout errors as 404", () => {
      assert.strictEqual(is404PaymentError(makeTimeoutError()), false);
    });

    it("should return false for non-Error objects", () => {
      assert.strictEqual(is404PaymentError("string error"), false);
      assert.strictEqual(is404PaymentError(null), false);
      assert.strictEqual(is404PaymentError(undefined), false);
      assert.strictEqual(is404PaymentError(404), false);
    });

    it("should return false for Error with status 500", () => {
      const err = new Error("Server error") as Error & { status?: number };
      err.status = 500;
      assert.strictEqual(is404PaymentError(err), false);
    });

    it("should detect error with both message and status 404", () => {
      const err = new Error("Not found 404") as Error & { status?: number };
      err.status = 404;
      assert.strictEqual(is404PaymentError(err), true);
    });
  });

  // ── Error message sanitization ─────────────────────────────

  describe("Error message sanitization", () => {
    it("should use sanitized message for 404 errors", () => {
      const msg = get404PaymentErrorMessage();
      assert.strictEqual(msg, "Payment could not be verified");
      // Must not contain raw API details
      assert.strictEqual(msg.includes("404"), false);
      assert.strictEqual(msg.includes("Dodo"), false);
      assert.strictEqual(msg.includes("API"), false);
    });

    it("succeeded payment should not have an error message", () => {
      const update = getPaymentRefreshUpdate({ status: "succeeded" });
      assert.ok(update);
      assert.strictEqual(update.errorMessage, undefined);
    });

    it("failed payment should have sanitized error message", () => {
      const update = getPaymentRefreshUpdate({ status: "failed" });
      assert.ok(update);
      assert.strictEqual(update.errorMessage, "Payment failed");
      // Must not contain raw API details
      assert.strictEqual(update.errorMessage!.includes("Dodo"), false);
    });

    it("cancelled payment should have sanitized error message", () => {
      const update = getPaymentRefreshUpdate({ status: "cancelled" });
      assert.ok(update);
      assert.strictEqual(update.errorMessage, "Payment was cancelled");
    });
  });

  // ── getPaymentRefreshUpdate status mapping ─────────────────

  describe("getPaymentRefreshUpdate", () => {
    it("should return COMPLETED for succeeded payment", () => {
      const update = getPaymentRefreshUpdate({ status: "succeeded" });
      assert.ok(update);
      assert.strictEqual(update.status, "COMPLETED");
      assert.ok(update.paidAt instanceof Date);
    });

    it("should return FAILED for failed payment", () => {
      const update = getPaymentRefreshUpdate({ status: "failed" });
      assert.ok(update);
      assert.strictEqual(update.status, "FAILED");
    });

    it("should return FAILED for cancelled payment", () => {
      const update = getPaymentRefreshUpdate({ status: "cancelled" });
      assert.ok(update);
      assert.strictEqual(update.status, "FAILED");
    });

    it("should return null for pending payment (no update needed)", () => {
      const update = getPaymentRefreshUpdate({ status: "pending" });
      assert.strictEqual(update, null);
    });

    it("should include metadata from Dodo response (deep clone)", () => {
      const dodoPayment: DodoPaymentWire = {
        status: "succeeded",
        amount: 999,
        currency: "INR",
        customer: { email: "user@test.com" },
      };
      const update = getPaymentRefreshUpdate(dodoPayment);
      assert.ok(update);
      assert.ok(update.metadata);
      assert.strictEqual(
        (update.metadata as Record<string, unknown>).amount,
        999
      );
      // Should be a deep clone, not the same reference
      assert.notStrictEqual(update.metadata, dodoPayment);
    });
  });

  // ── refreshPayments: 404 marking ──────────────────────────

  describe("refreshPayments - 404 handling", () => {
    it("should mark payment as FAILED when Dodo returns 404 in message", async () => {
      const payments = [makePayment()];
      const updates: Array<{ id: string; data: PaymentRefreshUpdate }> = [];

      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        throw make404Error("Payment not found - 404");
      };
      const updateFn = async (
        id: string,
        data: PaymentRefreshUpdate
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await refreshPayments(payments, retrieveFn, updateFn);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.updated, 1);
      assert.strictEqual(updates.length, 1);
      assert.strictEqual(updates[0].data.status, "FAILED");
      assert.strictEqual(
        updates[0].data.errorMessage,
        "Payment could not be verified"
      );
    });

    it("should mark payment as FAILED when Dodo returns 404 via status property", async () => {
      const payments = [makePayment()];
      const updates: Array<{ id: string; data: PaymentRefreshUpdate }> = [];

      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        throw make404ErrorWithStatus();
      };
      const updateFn = async (
        id: string,
        data: PaymentRefreshUpdate
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await refreshPayments(payments, retrieveFn, updateFn);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.updated, 1);
      assert.strictEqual(updates[0].data.status, "FAILED");
    });

    it("should NOT mark payment as FAILED for network errors", async () => {
      const payments = [makePayment()];
      const updates: Array<{ id: string; data: PaymentRefreshUpdate }> = [];

      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        throw makeNetworkError();
      };
      const updateFn = async (
        id: string,
        data: PaymentRefreshUpdate
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await refreshPayments(payments, retrieveFn, updateFn);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.updated, 0);
      assert.strictEqual(updates.length, 0);
    });

    it("should NOT mark payment as FAILED for timeout errors", async () => {
      const payments = [makePayment()];
      const updates: Array<{ id: string; data: PaymentRefreshUpdate }> = [];

      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        throw makeTimeoutError();
      };
      const updateFn = async (
        id: string,
        data: PaymentRefreshUpdate
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await refreshPayments(payments, retrieveFn, updateFn);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.updated, 0);
      assert.strictEqual(updates.length, 0);
    });

    it("should NOT mark payment as FAILED for 500 server errors", async () => {
      const payments = [makePayment()];
      const updates: Array<{ id: string; data: PaymentRefreshUpdate }> = [];

      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        throw new Error("Internal Server Error - 500");
      };
      const updateFn = async (
        id: string,
        data: PaymentRefreshUpdate
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await refreshPayments(payments, retrieveFn, updateFn);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.updated, 0);
      assert.strictEqual(updates.length, 0);
    });
  });

  // ── refreshPayments: mixed payments ────────────────────────

  describe("refreshPayments - mixed payment scenarios", () => {
    it("should handle mix of valid and 404 payments", async () => {
      const payments = [
        makePayment({ id: "pay_1", dodoPaymentId: "dodo_1" }),
        makePayment({ id: "pay_2", dodoPaymentId: "dodo_2" }),
        makePayment({ id: "pay_3", dodoPaymentId: "dodo_3" }),
      ];
      const updates: Array<{ id: string; data: PaymentRefreshUpdate }> = [];

      let callIndex = 0;
      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        callIndex++;
        if (callIndex === 1) return { status: "succeeded" }; // pay_1 succeeds
        if (callIndex === 2) throw make404Error(); // pay_2 is 404
        return { status: "failed" }; // pay_3 failed at Dodo
      };
      const updateFn = async (
        id: string,
        data: PaymentRefreshUpdate
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await refreshPayments(payments, retrieveFn, updateFn);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.updated, 3);
      assert.strictEqual(updates.length, 3);

      // pay_1: succeeded -> COMPLETED
      assert.strictEqual(updates[0].id, "pay_1");
      assert.strictEqual(updates[0].data.status, "COMPLETED");

      // pay_2: 404 -> FAILED with sanitized message
      assert.strictEqual(updates[1].id, "pay_2");
      assert.strictEqual(updates[1].data.status, "FAILED");
      assert.strictEqual(
        updates[1].data.errorMessage,
        "Payment could not be verified"
      );

      // pay_3: Dodo says failed -> FAILED
      assert.strictEqual(updates[2].id, "pay_3");
      assert.strictEqual(updates[2].data.status, "FAILED");
      assert.strictEqual(updates[2].data.errorMessage, "Payment failed");
    });

    it("should handle mix of 404 and network errors", async () => {
      const payments = [
        makePayment({ id: "pay_1", dodoPaymentId: "dodo_1" }),
        makePayment({ id: "pay_2", dodoPaymentId: "dodo_2" }),
      ];
      const updates: Array<{ id: string; data: PaymentRefreshUpdate }> = [];

      let callIndex = 0;
      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        callIndex++;
        if (callIndex === 1) throw make404Error(); // 404 -> mark FAILED
        throw makeNetworkError(); // network error -> skip
      };
      const updateFn = async (
        id: string,
        data: PaymentRefreshUpdate
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await refreshPayments(payments, retrieveFn, updateFn);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.updated, 1); // only the 404 one
      assert.strictEqual(updates.length, 1);
      assert.strictEqual(updates[0].id, "pay_1");
      assert.strictEqual(updates[0].data.status, "FAILED");
    });

    it("should skip payments with null dodoPaymentId", async () => {
      const payments = [
        makePayment({ id: "pay_1", dodoPaymentId: null }),
        makePayment({ id: "pay_2", dodoPaymentId: "dodo_2" }),
      ];
      const updates: Array<{ id: string; data: PaymentRefreshUpdate }> = [];
      let retrieveCalls = 0;

      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        retrieveCalls++;
        return { status: "succeeded" };
      };
      const updateFn = async (
        id: string,
        data: PaymentRefreshUpdate
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await refreshPayments(payments, retrieveFn, updateFn);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.updated, 1);
      assert.strictEqual(retrieveCalls, 1); // only called for pay_2
      assert.strictEqual(updates[0].id, "pay_2");
    });

    it("should return updated: 0 for empty array", async () => {
      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        return { status: "succeeded" };
      };
      const updateFn = async (): Promise<void> => {};

      const result = await refreshPayments([], retrieveFn, updateFn);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.updated, 0);
    });

    it("should handle all payments being pending at Dodo (no updates needed)", async () => {
      const payments = [
        makePayment({ id: "pay_1", dodoPaymentId: "dodo_1" }),
        makePayment({ id: "pay_2", dodoPaymentId: "dodo_2" }),
      ];
      const updates: Array<{ id: string; data: PaymentRefreshUpdate }> = [];

      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        return { status: "pending" };
      };
      const updateFn = async (
        id: string,
        data: PaymentRefreshUpdate
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await refreshPayments(payments, retrieveFn, updateFn);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.updated, 0);
      assert.strictEqual(updates.length, 0);
    });

    it("should handle cancelled payment from Dodo", async () => {
      const payments = [makePayment()];
      const updates: Array<{ id: string; data: PaymentRefreshUpdate }> = [];

      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        return { status: "cancelled" };
      };
      const updateFn = async (
        id: string,
        data: PaymentRefreshUpdate
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await refreshPayments(payments, retrieveFn, updateFn);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.updated, 1);
      assert.strictEqual(updates[0].data.status, "FAILED");
      assert.strictEqual(updates[0].data.errorMessage, "Payment was cancelled");
    });
  });

  // ── Error message sanitization in DB ──────────────────────

  describe("DB error message sanitization", () => {
    it("404 error message should not contain raw Dodo API URL", () => {
      const msg = get404PaymentErrorMessage();
      assert.strictEqual(msg.includes("https://"), false);
      assert.strictEqual(msg.includes("api.dodopayments.com"), false);
    });

    it("404 error message should not contain HTTP status code", () => {
      const msg = get404PaymentErrorMessage();
      assert.strictEqual(msg.includes("404"), false);
      assert.strictEqual(msg.includes("status"), false);
    });

    it("404 error message should not contain payment IDs", () => {
      const msg = get404PaymentErrorMessage();
      assert.strictEqual(msg.includes("dodo_pay_"), false);
      assert.strictEqual(msg.includes("pay_"), false);
    });

    it("failed payment message should be user-friendly", () => {
      const update = getPaymentRefreshUpdate({ status: "failed" });
      assert.ok(update);
      assert.strictEqual(update.errorMessage, "Payment failed");
      // Should not contain stack traces or error codes
      assert.strictEqual(update.errorMessage!.includes("Error:"), false);
      assert.strictEqual(update.errorMessage!.includes("at "), false);
    });

    it("cancelled payment message should be user-friendly", () => {
      const update = getPaymentRefreshUpdate({ status: "cancelled" });
      assert.ok(update);
      assert.strictEqual(update.errorMessage, "Payment was cancelled");
    });

    it("succeeded payment should store metadata without error message", () => {
      const dodoResponse: DodoPaymentWire = {
        status: "succeeded",
        payment_id: "dodo_pay_123",
        amount: 999,
      };
      const update = getPaymentRefreshUpdate(dodoResponse);
      assert.ok(update);
      assert.strictEqual(update.status, "COMPLETED");
      assert.strictEqual(update.errorMessage, undefined);
      assert.ok(update.metadata);
    });
  });

  // ── Edge cases ────────────────────────────────────────────

  describe("Edge cases", () => {
    it("should process all payments even if first one is 404", async () => {
      const payments = [
        makePayment({ id: "pay_1", dodoPaymentId: "dodo_1" }),
        makePayment({ id: "pay_2", dodoPaymentId: "dodo_2" }),
        makePayment({ id: "pay_3", dodoPaymentId: "dodo_3" }),
      ];
      const updates: Array<{ id: string; data: PaymentRefreshUpdate }> = [];

      let callIndex = 0;
      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        callIndex++;
        if (callIndex === 1) throw make404Error();
        return { status: "succeeded" };
      };
      const updateFn = async (
        id: string,
        data: PaymentRefreshUpdate
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await refreshPayments(payments, retrieveFn, updateFn);

      assert.strictEqual(result.data!.updated, 3);
      assert.strictEqual(updates.length, 3);
      assert.strictEqual(updates[0].data.status, "FAILED"); // 404
      assert.strictEqual(updates[1].data.status, "COMPLETED");
      assert.strictEqual(updates[2].data.status, "COMPLETED");
    });

    it("should process all payments even if middle one has network error", async () => {
      const payments = [
        makePayment({ id: "pay_1", dodoPaymentId: "dodo_1" }),
        makePayment({ id: "pay_2", dodoPaymentId: "dodo_2" }),
        makePayment({ id: "pay_3", dodoPaymentId: "dodo_3" }),
      ];
      const updates: Array<{ id: string; data: PaymentRefreshUpdate }> = [];

      let callIndex = 0;
      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        callIndex++;
        if (callIndex === 2) throw makeNetworkError();
        return { status: "succeeded" };
      };
      const updateFn = async (
        id: string,
        data: PaymentRefreshUpdate
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await refreshPayments(payments, retrieveFn, updateFn);

      assert.strictEqual(result.data!.updated, 2); // skipped pay_2
      assert.strictEqual(updates.length, 2);
      assert.strictEqual(updates[0].id, "pay_1");
      assert.strictEqual(updates[1].id, "pay_3");
    });

    it("should handle all payments being 404", async () => {
      const payments = [
        makePayment({ id: "pay_1", dodoPaymentId: "dodo_1" }),
        makePayment({ id: "pay_2", dodoPaymentId: "dodo_2" }),
      ];
      const updates: Array<{ id: string; data: PaymentRefreshUpdate }> = [];

      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        throw make404Error();
      };
      const updateFn = async (
        id: string,
        data: PaymentRefreshUpdate
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await refreshPayments(payments, retrieveFn, updateFn);

      assert.strictEqual(result.data!.updated, 2);
      assert.strictEqual(updates.length, 2);
      for (const update of updates) {
        assert.strictEqual(update.data.status, "FAILED");
        assert.strictEqual(
          update.data.errorMessage,
          "Payment could not be verified"
        );
      }
    });

    it("should handle all payments having network errors (none updated)", async () => {
      const payments = [
        makePayment({ id: "pay_1", dodoPaymentId: "dodo_1" }),
        makePayment({ id: "pay_2", dodoPaymentId: "dodo_2" }),
      ];
      const updates: Array<{ id: string; data: PaymentRefreshUpdate }> = [];

      const retrieveFn = async (): Promise<DodoPaymentStatusLike> => {
        throw makeNetworkError();
      };
      const updateFn = async (
        id: string,
        data: PaymentRefreshUpdate
      ): Promise<void> => {
        updates.push({ id, data });
      };

      const result = await refreshPayments(payments, retrieveFn, updateFn);

      assert.strictEqual(result.data!.updated, 0);
      assert.strictEqual(updates.length, 0);
    });
  });

  // ── MONEY-1074: grant-on-COMPLETED wiring ──────────────────────────
  // The COMPLETED gate is the REAL getPaymentRefreshUpdate decision; these lock
  // the policy: grant exactly when a payment resolves to COMPLETED, never on
  // FAILED/processing/404, and a grant throw never aborts the batch.

  describe("grant-on-COMPLETED (MONEY-1074)", () => {
    const succeeded: DodoPaymentStatusLike = { status: "succeeded" };
    const failed: DodoPaymentStatusLike = { status: "failed" };
    const processing: DodoPaymentStatusLike = { status: "processing" };

    const noopUpdate = async (): Promise<void> => {};

    it("grants exactly once for a succeeded payment", async () => {
      const granted: string[] = [];
      const result = await refreshPayments(
        [makePayment({ id: "pay_ok" })],
        async () => succeeded,
        noopUpdate,
        async (id) => {
          granted.push(id);
        }
      );
      assert.deepStrictEqual(granted, ["pay_ok"]);
      assert.strictEqual(result.data!.updated, 1);
    });

    it("does NOT grant on failed / processing / 404", async () => {
      const granted: string[] = [];
      const grant = async (id: string): Promise<void> => {
        granted.push(id);
      };
      // failed → FAILED patch, no grant
      await refreshPayments(
        [makePayment()],
        async () => failed,
        noopUpdate,
        grant
      );
      // processing → no patch, no grant
      await refreshPayments(
        [makePayment()],
        async () => processing,
        noopUpdate,
        grant
      );
      // 404 → FAILED patch, no grant
      await refreshPayments(
        [makePayment()],
        async () => {
          throw make404Error();
        },
        noopUpdate,
        grant
      );
      assert.strictEqual(granted.length, 0);
    });

    it("a grant throw is swallowed and the batch continues (still success)", async () => {
      const granted: string[] = [];
      const result = await refreshPayments(
        [makePayment({ id: "a" }), makePayment({ id: "b" })],
        async () => succeeded,
        noopUpdate,
        async (id) => {
          if (id === "a") throw new Error("grant boom");
          granted.push(id);
        }
      );
      // 'a' threw but 'b' still granted; updated counts both COMPLETED rows.
      assert.deepStrictEqual(granted, ["b"]);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data!.updated, 2);
    });
  });
});
