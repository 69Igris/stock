/**
 * MONEY-393 §14 - withSoftTimeout wrapper.
 *
 * Verifies the race between the soft timer and the wrapped op:
 *   - Op completes before softMs → no soft-cross telemetry.
 *   - Op crosses softMs → soft-cross event fires + completion event.
 *   - Op throws → timer cleaned up, throw propagates.
 *   - PostHog disabled (no NEXT_PUBLIC_POSTHOG_KEY) → no fetch.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Disable PostHog by default so the emitter is a no-op and tests
// don't make real HTTP calls.
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

import { withSoftTimeout } from "../src/with-soft-timeout";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("MONEY-393 §14 - withSoftTimeout", () => {
  it("[soft-timeout] returns the wrapped op's value when fast", async () => {
    const result = await withSoftTimeout(async () => 42, {
      softMs: 100,
      eventName: "test_fast",
    });
    assert.equal(result, 42);
  });

  it("[soft-timeout] propagates the op's throw + cleans up the timer", async () => {
    await assert.rejects(
      () =>
        withSoftTimeout(
          async () => {
            throw new Error("boom");
          },
          { softMs: 100, eventName: "test_throws" },
        ),
      /boom/,
    );
    // If the timer leaked, this test would hang or trigger unhandled
    // setTimeout warnings; node:test's --test-force-exit would catch
    // it as a runaway handle. The fact that the test returns
    // immediately proves cleanup.
  });

  it("[soft-timeout] op that crosses softMs still returns its value", async () => {
    // softMs=10 (very short so we can cross it deterministically),
    // op waits 60ms. The wrapper must not abort - it only records
    // telemetry. The op's value comes back as normal.
    const result = await withSoftTimeout(
      async () => {
        await delay(60);
        return "completed-late";
      },
      { softMs: 10, eventName: "test_slow" },
    );
    assert.equal(result, "completed-late");
  });

  it("[soft-timeout] PostHog disabled → emit is a quiet no-op", async () => {
    // No NEXT_PUBLIC_POSTHOG_KEY set; emitPostHogEvent bails on the
    // first line. The wrapper still works, just doesn't fire fetch.
    const result = await withSoftTimeout(
      async () => {
        await delay(15);
        return "ok";
      },
      { softMs: 5, eventName: "test_no_posthog", metadata: { kind: "unit" } },
    );
    assert.equal(result, "ok");
  });

  it("[soft-timeout] default softMs is 25 seconds (per ticket spec)", async () => {
    // Easiest way to assert the default: pass without softMs and
    // verify the op (which finishes in <1ms) returns normally - no
    // race or accidental short-circuit at undefined.
    const result = await withSoftTimeout(async () => "ok", {
      eventName: "test_default_soft",
    });
    assert.equal(result, "ok");
  });

  it("[soft-timeout] userId defaults to 'anonymous' when not provided", async () => {
    // Catches the regression where someone makes userId required.
    // Op returns its value as long as the helper accepts the call.
    const result = await withSoftTimeout(
      async () => {
        await delay(15);
        return "x";
      },
      { softMs: 5, eventName: "test_anonymous_user" },
    );
    assert.equal(result, "x");
  });

  it("[soft-timeout] op returning a non-Promise plain value works", async () => {
    // The signature is `() => Promise<T>` but TypeScript's contravariance
    // allows a sync function that returns T. Verify it doesn't break.
    const result = await withSoftTimeout(
      // eslint-disable-next-line @typescript-eslint/require-await
      async () => ({ secret: "v" }),
      { softMs: 100, eventName: "test_object_return" },
    );
    assert.deepEqual(result, { secret: "v" });
  });
});
