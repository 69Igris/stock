/**
 * Quote Service - Write Conflict Retry Logic Tests
 *
 * Tests the REAL retry/freshness logic extracted from
 *   packages/core/src/market-data/prices/quote-service.ts
 * into
 *   packages/core/src/market-data/prices/quote-logic.ts
 *
 * `quote-service.ts` imports and calls runWithWriteConflictRetry,
 * isWriteConflictError, calcBackoff, isFresh and the retry constants, so this
 * exercises production code (no inline reimplementation, no DB/network).
 *
 * A no-op `sleep` is injected so backoff delays don't slow the suite.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_QUOTE_TTL_MS,
  UPSERT_MAX_RETRIES,
  REFRESH_MAX_RETRIES,
  UPSERT_BACKOFF_BASE_MS,
  REFRESH_BACKOFF_BASE_MS,
  isWriteConflictError,
  calcBackoff,
  shouldFetchFromApi,
  runWithWriteConflictRetry,
} from "@usemoney/core/market-data/prices/quote-logic";

// Injected no-op sleeper so retry tests run instantly.
const noSleep = async (): Promise<void> => {};

// Wrappers mirroring the two production retry shapes (upsert: 3 retries @150ms,
// refresh: 5 retries @200ms), driving the real runWithWriteConflictRetry.
function upsertWithRetry(
  fn: () => Promise<unknown>,
  maxRetries = UPSERT_MAX_RETRIES
) {
  return runWithWriteConflictRetry(fn, {
    maxRetries,
    backoffBaseMs: UPSERT_BACKOFF_BASE_MS,
    sleep: noSleep,
  });
}

function refreshWithRetry(
  fn: () => Promise<unknown>,
  maxRetries = REFRESH_MAX_RETRIES
) {
  return runWithWriteConflictRetry(fn, {
    maxRetries,
    backoffBaseMs: REFRESH_BACKOFF_BASE_MS,
    sleep: noSleep,
  });
}

const calcUpsertBackoff = (attempt: number) =>
  calcBackoff(UPSERT_BACKOFF_BASE_MS, attempt);
const calcRefreshBackoff = (attempt: number) =>
  calcBackoff(REFRESH_BACKOFF_BASE_MS, attempt);

function makeWriteConflictError(
  variant: "write conflict" | "deadlock" = "write conflict"
): Error {
  return new Error(`MongoDB: ${variant} detected during transaction`);
}

function makeNetworkError(): Error {
  return new Error("ECONNREFUSED: Connection refused");
}

function makeTimeoutError(): Error {
  return new Error("Query timeout after 5000ms");
}

function makeCachedQuote(updatedAt: Date): { updatedAt: Date } {
  return { updatedAt };
}

describe("Quote Service - Write Conflict Retry Logic (real source)", () => {
  // ── runWithWriteConflictRetry (upsert shape) ──────────────────────────

  describe("upsertWithRetry - success paths", () => {
    it("succeeds on first attempt: returns attempt=1, success=true", async () => {
      let callCount = 0;
      const result = await upsertWithRetry(async () => {
        callCount++;
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts, 1);
      assert.strictEqual(callCount, 1);
    });

    it("write conflict on 1st, success on 2nd: returns attempt=2, success=true", async () => {
      let callCount = 0;
      const result = await upsertWithRetry(async () => {
        callCount++;
        if (callCount === 1) throw makeWriteConflictError();
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts, 2);
      assert.strictEqual(callCount, 2);
    });

    it("write conflict on 1st and 2nd, success on 3rd: returns attempt=3, success=true", async () => {
      let callCount = 0;
      const result = await upsertWithRetry(async () => {
        callCount++;
        if (callCount < 3) throw makeWriteConflictError();
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts, 3);
      assert.strictEqual(callCount, 3);
    });

    it("captures side effects from a successful upsert", async () => {
      const fakeUpserted = { instrumentId: "inst_001", price: 2500 };
      let captured: unknown = null;

      const result = await upsertWithRetry(async () => {
        captured = fakeUpserted;
      });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(captured, fakeUpserted);
    });
  });

  describe("upsertWithRetry - exhausted retries", () => {
    it("all 3 write conflicts → success=false, attempts=3 (max retries)", async () => {
      let callCount = 0;
      const result = await upsertWithRetry(async () => {
        callCount++;
        throw makeWriteConflictError();
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.attempts, UPSERT_MAX_RETRIES);
      assert.strictEqual(callCount, UPSERT_MAX_RETRIES);
    });

    it("exactly maxRetries attempts are made before giving up", async () => {
      const calls: number[] = [];
      const result = await upsertWithRetry(async () => {
        calls.push(Date.now());
        throw makeWriteConflictError();
      });

      assert.strictEqual(calls.length, UPSERT_MAX_RETRIES);
      assert.strictEqual(result.success, false);
    });

    it("custom maxRetries=1: fails immediately after 1 write conflict", async () => {
      let callCount = 0;
      const result = await upsertWithRetry(async () => {
        callCount++;
        throw makeWriteConflictError();
      }, 1);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.attempts, 1);
      assert.strictEqual(callCount, 1);
    });

    it("custom maxRetries=5: allows 5 attempts on write conflict", async () => {
      let callCount = 0;
      const result = await upsertWithRetry(async () => {
        callCount++;
        throw makeWriteConflictError();
      }, 5);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.attempts, 5);
      assert.strictEqual(callCount, 5);
    });
  });

  describe("upsertWithRetry - non-write-conflict errors throw immediately", () => {
    it("network error throws immediately without retry", async () => {
      let callCount = 0;
      await assert.rejects(
        async () =>
          await upsertWithRetry(async () => {
            callCount++;
            throw makeNetworkError();
          }),
        (err: Error) => {
          assert.ok(err.message.includes("ECONNREFUSED"));
          return true;
        }
      );
      assert.strictEqual(callCount, 1);
    });

    it("timeout error throws immediately without retry", async () => {
      let callCount = 0;
      await assert.rejects(
        async () =>
          await upsertWithRetry(async () => {
            callCount++;
            throw makeTimeoutError();
          }),
        (err: Error) => {
          assert.ok(err.message.includes("timeout"));
          return true;
        }
      );
      assert.strictEqual(callCount, 1);
    });

    it("non-Error throw is treated as non-write-conflict, throws immediately", async () => {
      let callCount = 0;
      await assert.rejects(
        async () =>
          await upsertWithRetry(async () => {
            callCount++;
            // eslint-disable-next-line @typescript-eslint/no-throw-literal
            throw "raw string error";
          })
      );
      assert.strictEqual(callCount, 1);
    });

    it("generic database error (not write conflict) throws immediately", async () => {
      let callCount = 0;
      await assert.rejects(
        async () =>
          await upsertWithRetry(async () => {
            callCount++;
            throw new Error("Unique constraint violation on instrumentId");
          })
      );
      assert.strictEqual(callCount, 1);
    });

    it("write conflict on 1st, non-write-conflict error on 2nd → throws on 2nd attempt", async () => {
      let callCount = 0;
      await assert.rejects(
        async () =>
          await upsertWithRetry(async () => {
            callCount++;
            if (callCount === 1) throw makeWriteConflictError();
            throw makeNetworkError();
          }),
        (err: Error) => {
          assert.ok(err.message.includes("ECONNREFUSED"));
          return true;
        }
      );
      assert.strictEqual(callCount, 2);
    });
  });

  describe("isWriteConflictError - deadlock detection", () => {
    it('"deadlock" in message triggers retry, not immediate throw', async () => {
      let callCount = 0;
      const result = await upsertWithRetry(async () => {
        callCount++;
        if (callCount === 1) throw makeWriteConflictError("deadlock");
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts, 2);
      assert.strictEqual(callCount, 2);
    });

    it('"deadlock" exhausted across all retries → success=false', async () => {
      let callCount = 0;
      const result = await upsertWithRetry(async () => {
        callCount++;
        throw makeWriteConflictError("deadlock");
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.attempts, UPSERT_MAX_RETRIES);
    });

    it('"write conflict" in message triggers retry', async () => {
      let callCount = 0;
      const result = await upsertWithRetry(async () => {
        callCount++;
        if (callCount === 1) throw new Error("write conflict on document");
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts, 2);
    });

    it('"Write Conflict" (uppercase) does NOT trigger retry (case-sensitive)', async () => {
      let callCount = 0;
      await assert.rejects(async () =>
        upsertWithRetry(async () => {
          callCount++;
          throw new Error("Write Conflict on document");
        })
      );
      assert.strictEqual(callCount, 1);
    });

    it("isWriteConflictError returns true for write conflict / deadlock, false otherwise", () => {
      assert.strictEqual(
        isWriteConflictError(new Error("write conflict")),
        true
      );
      assert.strictEqual(isWriteConflictError(new Error("deadlock")), true);
      assert.strictEqual(
        isWriteConflictError(new Error("Write Conflict")),
        false
      );
      assert.strictEqual(isWriteConflictError(new Error("timeout")), false);
      assert.strictEqual(isWriteConflictError("raw string"), false);
      assert.strictEqual(isWriteConflictError(null), false);
    });
  });

  describe("upsert backoff calculations", () => {
    it("attempt 1 base delay: 150ms (150 * 2^0)", () => {
      assert.strictEqual(calcUpsertBackoff(1), 150);
    });

    it("attempt 2 base delay: 300ms (150 * 2^1)", () => {
      assert.strictEqual(calcUpsertBackoff(2), 300);
    });

    it("attempt 3 base delay: 600ms (150 * 2^2)", () => {
      assert.strictEqual(calcUpsertBackoff(3), 600);
    });

    it("backoff doubles with each attempt (exponential)", () => {
      const d1 = calcUpsertBackoff(1);
      const d2 = calcUpsertBackoff(2);
      const d3 = calcUpsertBackoff(3);
      assert.strictEqual(d2 / d1, 2);
      assert.strictEqual(d3 / d2, 2);
    });

    it("UPSERT_BACKOFF_BASE_MS constant is 150", () => {
      assert.strictEqual(UPSERT_BACKOFF_BASE_MS, 150);
    });

    it("UPSERT_MAX_RETRIES constant is 3", () => {
      assert.strictEqual(UPSERT_MAX_RETRIES, 3);
    });
  });

  // ── runWithWriteConflictRetry (refresh shape) ─────────────────────────

  describe("refreshWithRetry - success paths", () => {
    it("succeeds on first attempt: attempt=1, success=true", async () => {
      let callCount = 0;
      const result = await refreshWithRetry(async () => {
        callCount++;
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts, 1);
      assert.strictEqual(callCount, 1);
    });

    it("write conflict on 1st, success on 2nd: attempt=2, success=true", async () => {
      let callCount = 0;
      const result = await refreshWithRetry(async () => {
        callCount++;
        if (callCount === 1) throw makeWriteConflictError();
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts, 2);
    });

    it("4 write conflicts, success on 5th: attempt=5, success=true", async () => {
      let callCount = 0;
      const result = await refreshWithRetry(async () => {
        callCount++;
        if (callCount < 5) throw makeWriteConflictError();
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts, 5);
      assert.strictEqual(callCount, 5);
    });
  });

  describe("refreshWithRetry - 5 max retries (vs upsert's 3)", () => {
    it("all 5 write conflicts → success=false, attempts=5", async () => {
      let callCount = 0;
      const result = await refreshWithRetry(async () => {
        callCount++;
        throw makeWriteConflictError();
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.attempts, REFRESH_MAX_RETRIES);
      assert.strictEqual(callCount, REFRESH_MAX_RETRIES);
    });

    it("REFRESH_MAX_RETRIES constant is 5 (more than upsert's 3)", () => {
      assert.strictEqual(REFRESH_MAX_RETRIES, 5);
      assert.ok(REFRESH_MAX_RETRIES > UPSERT_MAX_RETRIES);
    });

    it("3 write conflicts doesn't exhaust refreshWithRetry (it has 5 retries)", async () => {
      let callCount = 0;
      const result = await refreshWithRetry(async () => {
        callCount++;
        if (callCount <= 3) throw makeWriteConflictError();
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts, 4);
    });

    it("non-write-conflict error throws immediately even within 5 retries", async () => {
      let callCount = 0;
      await assert.rejects(
        async () =>
          refreshWithRetry(async () => {
            callCount++;
            throw makeNetworkError();
          }),
        (err: Error) => {
          assert.ok(err.message.includes("ECONNREFUSED"));
          return true;
        }
      );
      assert.strictEqual(callCount, 1);
    });

    it("write conflict on 1st then non-write-conflict on 2nd → throws on 2nd", async () => {
      let callCount = 0;
      await assert.rejects(
        async () =>
          refreshWithRetry(async () => {
            callCount++;
            if (callCount === 1) throw makeWriteConflictError();
            throw makeNetworkError();
          }),
        (err: Error) => {
          assert.ok(err.message.includes("ECONNREFUSED"));
          return true;
        }
      );
      assert.strictEqual(callCount, 2);
    });
  });

  describe("refresh backoff calculations", () => {
    it("attempt 1 base delay: 200ms (200 * 2^0)", () => {
      assert.strictEqual(calcRefreshBackoff(1), 200);
    });

    it("attempt 2 base delay: 400ms (200 * 2^1)", () => {
      assert.strictEqual(calcRefreshBackoff(2), 400);
    });

    it("attempt 3 base delay: 800ms (200 * 2^2)", () => {
      assert.strictEqual(calcRefreshBackoff(3), 800);
    });

    it("attempt 4 base delay: 1600ms (200 * 2^3)", () => {
      assert.strictEqual(calcRefreshBackoff(4), 1600);
    });

    it("backoff doubles each attempt (exponential pattern)", () => {
      for (let attempt = 1; attempt <= 4; attempt++) {
        const current = calcRefreshBackoff(attempt);
        const next = calcRefreshBackoff(attempt + 1);
        assert.strictEqual(next / current, 2);
      }
    });

    it("REFRESH_BACKOFF_BASE_MS is 200ms (larger than upsert's 150ms)", () => {
      assert.strictEqual(REFRESH_BACKOFF_BASE_MS, 200);
      assert.ok(REFRESH_BACKOFF_BASE_MS > UPSERT_BACKOFF_BASE_MS);
    });
  });

  describe("refreshWithRetry - deadlock keyword", () => {
    it('"deadlock" in message triggers retry in refreshWithRetry', async () => {
      let callCount = 0;
      const result = await refreshWithRetry(async () => {
        callCount++;
        if (callCount === 1) throw makeWriteConflictError("deadlock");
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts, 2);
    });

    it("deadlock exhausted across all 5 retries → success=false", async () => {
      let callCount = 0;
      const result = await refreshWithRetry(async () => {
        callCount++;
        throw makeWriteConflictError("deadlock");
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(callCount, REFRESH_MAX_RETRIES);
    });
  });

  // ── shouldFetchFromApi ────────────────────────────────────────────────

  describe("shouldFetchFromApi - null cache always fetches", () => {
    it("null cachedQuote → returns true (must fetch)", () => {
      const now = new Date();
      assert.strictEqual(
        shouldFetchFromApi(null, DEFAULT_QUOTE_TTL_MS, now),
        true
      );
    });

    it("null cachedQuote with TTL=0 → returns true", () => {
      const now = new Date();
      assert.strictEqual(shouldFetchFromApi(null, 0, now), true);
    });

    it("null cachedQuote with very large TTL → returns true", () => {
      const now = new Date();
      assert.strictEqual(
        shouldFetchFromApi(null, 30 * 24 * 60 * 60 * 1000, now),
        true
      );
    });
  });

  describe("shouldFetchFromApi - fresh cache returns false", () => {
    it("just-updated quote (updatedAt = now) → not stale", () => {
      const now = new Date();
      assert.strictEqual(
        shouldFetchFromApi(makeCachedQuote(now), DEFAULT_QUOTE_TTL_MS, now),
        false
      );
    });

    it("quote updated 30s ago with 60s TTL → not stale", () => {
      const now = new Date();
      const quote = makeCachedQuote(new Date(now.getTime() - 30_000));
      assert.strictEqual(
        shouldFetchFromApi(quote, DEFAULT_QUOTE_TTL_MS, now),
        false
      );
    });

    it("quote updated 59s ago with 60s TTL → not yet stale", () => {
      const now = new Date();
      const quote = makeCachedQuote(new Date(now.getTime() - 59_000));
      assert.strictEqual(
        shouldFetchFromApi(quote, DEFAULT_QUOTE_TTL_MS, now),
        false
      );
    });

    it("quote from the future → definitely not stale", () => {
      const now = new Date();
      const quote = makeCachedQuote(new Date(now.getTime() + 10_000));
      assert.strictEqual(
        shouldFetchFromApi(quote, DEFAULT_QUOTE_TTL_MS, now),
        false
      );
    });

    it("custom TTL=5min: quote 3min old → not stale", () => {
      const now = new Date();
      const quote = makeCachedQuote(new Date(now.getTime() - 3 * 60 * 1000));
      assert.strictEqual(shouldFetchFromApi(quote, 5 * 60 * 1000, now), false);
    });
  });

  describe("shouldFetchFromApi - stale cache returns true", () => {
    it("quote updated just past the TTL boundary → stale", () => {
      const now = new Date();
      const quote = makeCachedQuote(
        new Date(now.getTime() - DEFAULT_QUOTE_TTL_MS - 1)
      );
      assert.strictEqual(
        shouldFetchFromApi(quote, DEFAULT_QUOTE_TTL_MS, now),
        true
      );
    });

    it("quote updated 2 minutes ago with 60s TTL → stale", () => {
      const now = new Date();
      const quote = makeCachedQuote(new Date(now.getTime() - 2 * 60 * 1000));
      assert.strictEqual(
        shouldFetchFromApi(quote, DEFAULT_QUOTE_TTL_MS, now),
        true
      );
    });

    it("quote from yesterday → stale", () => {
      const now = new Date();
      const quote = makeCachedQuote(
        new Date(now.getTime() - 24 * 60 * 60 * 1000)
      );
      assert.strictEqual(
        shouldFetchFromApi(quote, DEFAULT_QUOTE_TTL_MS, now),
        true
      );
    });

    it("epoch date quote → stale", () => {
      const now = new Date();
      assert.strictEqual(
        shouldFetchFromApi(
          makeCachedQuote(new Date(0)),
          DEFAULT_QUOTE_TTL_MS,
          now
        ),
        true
      );
    });

    it("custom TTL=5min: quote 6min old → stale", () => {
      const now = new Date();
      const quote = makeCachedQuote(new Date(now.getTime() - 6 * 60 * 1000));
      assert.strictEqual(shouldFetchFromApi(quote, 5 * 60 * 1000, now), true);
    });

    it("TTL=0 with quote updated 1ms ago → stale (0ms TTL means always stale)", () => {
      const now = new Date();
      const quote = makeCachedQuote(new Date(now.getTime() - 1));
      assert.strictEqual(shouldFetchFromApi(quote, 0, now), true);
    });

    it("TTL=0 with quote updatedAt=now → stale (isFresh uses strict <, so 0<0 is false)", () => {
      // shouldFetchFromApi === !isFresh; isFresh(elapsed=0, ttl=0) = (0 < 0) =
      // false → not fresh → must fetch. This matches the production
      // getLatestQuote guard exactly.
      const now = new Date();
      assert.strictEqual(
        shouldFetchFromApi(makeCachedQuote(now), 0, now),
        true
      );
    });
  });

  describe("Constants", () => {
    it("DEFAULT_QUOTE_TTL_MS is 60 seconds", () => {
      assert.strictEqual(DEFAULT_QUOTE_TTL_MS, 60_000);
    });
  });
});
