/**
 * MONEY-1126 — `withTimeout` must not leak its deadline timer.
 *
 * `app/holdings/page.tsx` raced three server actions against a `setTimeout`
 * that was never cleared. In the common case (the query wins) the timer stayed
 * armed for the FULL 4s after the render had already finished — three orphaned
 * handles per holdings render, and a test importing the page would sit past its
 * assertions waiting for them.
 *
 * `globalThis.setTimeout` / `clearTimeout` are swapped for counting wrappers
 * that delegate to the captured originals, so "is a timer still armed?" is
 * observed directly rather than inferred from wall-clock behaviour. Nothing
 * sleeps for longer than a few ms.
 *
 * Source: apps/web/lib/utils/with-timeout.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { withTimeout } from "@/lib/utils/with-timeout";

type TimerId = ReturnType<typeof setTimeout>;

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** Timers created through the patched global that are still pending. */
let armed: Set<TimerId>;
/** Total timers created through the patched global. */
let created: number;

/** Sleep on the REAL timer so it is never counted as "armed" by the harness. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

beforeEach(() => {
  armed = new Set<TimerId>();
  created = 0;

  globalThis.setTimeout = ((
    fn: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    created += 1;
    const id: TimerId = realSetTimeout(() => {
      armed.delete(id);
      fn(...args);
    }, ms);
    armed.add(id);
    return id;
  }) as unknown as typeof setTimeout;

  globalThis.clearTimeout = ((id?: TimerId) => {
    if (id !== undefined) armed.delete(id);
    realClearTimeout(id as TimerId);
  }) as unknown as typeof clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

describe("withTimeout: timer lifetime", () => {
  it("[regression] disarms the deadline when the promise wins", async () => {
    // A 50s deadline: under the un-cleared version this handle would outlive
    // the whole test file.
    const out = await withTimeout(Promise.resolve("fast"), 50_000);

    assert.equal(out, "fast");
    assert.equal(created, 1, "exactly one deadline timer per call");
    assert.equal(armed.size, 0, "deadline timer must be cleared");
  });

  it("[regression] disarms the deadline when the promise rejects", async () => {
    await assert.rejects(
      () => withTimeout(Promise.reject(new Error("boom")), 50_000),
      /boom/
    );

    assert.equal(armed.size, 0, "a rejection must still clear the timer");
  });

  it("leaves nothing armed after the deadline itself fires", async () => {
    const never = new Promise<string>(() => {});

    const out = await withTimeout(never, 5);

    assert.equal(out, null);
    assert.equal(armed.size, 0);
  });

  it("arms exactly one timer per call, and clears all of them", async () => {
    const results = await Promise.all([
      withTimeout(Promise.resolve(1), 50_000),
      withTimeout(Promise.resolve(2), 50_000),
      withTimeout(Promise.resolve(3), 50_000),
    ]);

    assert.deepEqual(results, [1, 2, 3]);
    assert.equal(created, 3);
    assert.equal(armed.size, 0);
  });
});

describe("withTimeout: resolution semantics", () => {
  it("resolves null on timeout (the caller's 'no data' signal)", async () => {
    const slow = new Promise<{ ok: boolean }>((resolve) => {
      realSetTimeout(() => resolve({ ok: true }), 60);
    });

    assert.equal(await withTimeout(slow, 5), null);

    // Let the loser settle so it cannot bleed into a later test.
    await sleep(80);
  });

  it("returns the value verbatim when it beats the deadline", async () => {
    const payload = { portfolio: { totalValue: 1234 } };

    assert.equal(await withTimeout(Promise.resolve(payload), 50_000), payload);
  });

  it("preserves a falsy resolution rather than confusing it with a timeout", async () => {
    assert.equal(await withTimeout(Promise.resolve(0), 50_000), 0);
    assert.equal(await withTimeout(Promise.resolve(false), 50_000), false);
  });

  it("does NOT abort the loser — it only stops waiting for it", async () => {
    let finished = false;
    const slow = new Promise<string>((resolve) => {
      realSetTimeout(() => {
        finished = true;
        resolve("late");
      }, 40);
    });

    assert.equal(await withTimeout(slow, 5), null);
    assert.equal(finished, false, "still running when we gave up");

    await sleep(60);
    assert.equal(finished, true, "the underlying work ran to completion");
  });

  it("a pre-caught late rejection cannot become an unhandled rejection (the page call-site shape)", async () => {
    // `app/dashboard/page.tsx` catches BEFORE racing precisely because nothing
    // is awaiting the promise once the deadline wins.
    const slowFailure = new Promise<string>((_, reject) => {
      realSetTimeout(() => reject(new Error("late failure")), 30);
    }).catch(() => null);

    assert.equal(await withTimeout(slowFailure, 5), null);

    await sleep(60); // the rejection lands here; it must stay swallowed
    assert.equal(armed.size, 0);
  });
});
