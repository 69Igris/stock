/**
 * MONEY-1135 — a hung single-flight leader must not stall every follower.
 *
 * `singleFlight` collapses concurrent resolves of the same key onto ONE
 * execution. That is exactly right until the one execution hangs: before this
 * ticket, the entry stayed in the map forever, so every current waiter AND
 * every caller that arrived later awaited a promise that would never settle.
 *
 * The blast radius is new rather than theoretical. MONEY-1126 put `singleFlight`
 * on the dashboard, holdings and screener paths, so one stuck leader now stalls
 * the same page for everyone asking the same question — and, because the key
 * was never evicted, kept doing so for the life of the process.
 *
 * TIMING DISCIPLINE: every case below drives an injected timeout of a few
 * milliseconds and resolves its own promises. No real sleeps, no wall-clock
 * dependence — the standing rule is that tests must never orphan, and a suite
 * that waits 15s to prove a 15s timeout is the worst possible way to test one.
 *
 * Source: packages/core/src/cache/stale-while-error.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  singleFlight,
  SingleFlightTimeoutError,
  SINGLE_FLIGHT_TIMEOUT_MS,
  __resetSingleFlight,
} from "../../src/cache/stale-while-error";

/** A promise the test settles by hand — stands in for a hung compute. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const TINY = 5; // ms — the injected deadline for these cases

describe("MONEY-1135 — singleFlight leader timeout", () => {
  beforeEach(() => __resetSingleFlight());

  it("[regression] a hung leader does NOT hang the caller forever", async () => {
    const hung = deferred<string>();
    let calls = 0;

    await assert.rejects(
      () =>
        singleFlight(
          "k",
          () => {
            calls += 1;
            return hung.promise;
          },
          TINY,
        ),
      (e: unknown) => e instanceof SingleFlightTimeoutError,
      "a compute that never settles must surface as a timeout, not a hang",
    );

    assert.equal(calls, 1);
    // Settle it late so the runner is not left with a pending promise.
    hung.resolve("late");
  });

  it("[regression] a FOLLOWER is released too, not just the leader", async () => {
    // The original bug's worst shape: N users on the same key, all waiting on
    // one stuck execution.
    const hung = deferred<string>();
    const leader = singleFlight("k", () => hung.promise, TINY);
    const follower = singleFlight("k", () => hung.promise, TINY);

    await assert.rejects(() => leader, SingleFlightTimeoutError);
    await assert.rejects(() => follower, SingleFlightTimeoutError);
    hung.resolve("late");
  });

  it("[regression] the key is EVICTED, so the next caller computes fresh", async () => {
    // Without eviction, a hung leader poisons the key for the life of the
    // process: every later caller joins a flight that will never finish.
    const hung = deferred<string>();
    let calls = 0;

    await assert.rejects(
      () =>
        singleFlight(
          "k",
          () => {
            calls += 1;
            return hung.promise;
          },
          TINY,
        ),
      SingleFlightTimeoutError,
    );

    const after = await singleFlight(
      "k",
      async () => {
        calls += 1;
        return "fresh";
      },
      TINY,
    );

    assert.equal(after, "fresh");
    assert.equal(calls, 2, "the later caller must run its OWN compute");
    hung.resolve("late");
  });

  it("a late-completing leader does not evict a NEWER flight", async () => {
    // The subtle race: leader times out, is evicted, a replacement starts, then
    // the original finally-block runs. An unconditional delete would drop the
    // REPLACEMENT and silently un-share the next round of callers.
    const slow = deferred<string>();
    await assert.rejects(
      () => singleFlight("k", () => slow.promise, TINY),
      SingleFlightTimeoutError,
    );

    const second = deferred<string>();
    let secondCalls = 0;
    const b1 = singleFlight(
      "k",
      () => {
        secondCalls += 1;
        return second.promise;
      },
      1000,
    );

    // The original leader finishes AFTER the replacement was registered.
    slow.resolve("stale-leader");
    await Promise.resolve();
    await Promise.resolve();

    // A third caller must still JOIN the replacement, not start a third run.
    const b2 = singleFlight(
      "k",
      () => {
        secondCalls += 1;
        return second.promise;
      },
      1000,
    );

    second.resolve("shared");
    assert.equal(await b1, "shared");
    assert.equal(await b2, "shared");
    assert.equal(
      secondCalls,
      1,
      "the replacement flight must still be shared — the late leader's cleanup " +
        "must not have deleted it",
    );
  });

  it("does not change the happy path: one compute, shared result", async () => {
    let calls = 0;
    const d = deferred<string>();
    const a = singleFlight(
      "k",
      () => {
        calls += 1;
        return d.promise;
      },
      1000,
    );
    const b = singleFlight(
      "k",
      () => {
        calls += 1;
        return d.promise;
      },
      1000,
    );

    d.resolve("ok");
    assert.equal(await a, "ok");
    assert.equal(await b, "ok");
    assert.equal(calls, 1, "concurrent callers must still share ONE execution");
  });

  it("a rejected compute still propagates, and still frees the key", async () => {
    const boom = new Error("compute failed");
    await assert.rejects(
      () => singleFlight("k", () => Promise.reject(boom), 1000),
      (e: unknown) => e === boom,
      "a real failure must reach the caller unchanged, not become a timeout",
    );

    const after = await singleFlight("k", async () => "recovered", 1000);
    assert.equal(after, "recovered", "a failed flight must not poison the key");
  });

  it("[regression] a leader that REJECTS after every waiter timed out is observed", async () => {
    // Race (b). A leader that rejects after every waiter has timed out must not
    // escape as an unhandled rejection — that takes the process down over an
    // error already reported to callers as a timeout. Every other case here
    // settles its hung promise with `resolve("late")`, so none of them reach it.
    //
    // This asserts the INVARIANT, not a mechanism, and it is green under two
    // independent implementations — worth stating plainly, because a review
    // deleted `run.catch(() => {})` and this test stayed green. That is not a
    // vacuous test: `withDeadline`'s `Promise.race` attaches a rejection handler
    // to BOTH inputs at construction, which marks the loser handled forever
    // (probed, not assumed). The catch is redundant belt-and-braces for a future
    // `withDeadline` that returns without racing. What this case actually
    // defends is a change that removes BOTH.
    const hung = deferred<string>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      await assert.rejects(
        () => singleFlight("k", () => hung.promise, TINY),
        SingleFlightTimeoutError,
      );

      // Now REJECT the leader, after its only waiter has given up.
      const late = new Error("leader failed after everyone left");
      hung.reject(late);

      // Give the microtask queue and one macrotask tick a chance to surface an
      // unhandled rejection, which node reports asynchronously.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      assert.deepEqual(
        unhandled,
        [],
        "the leader's late rejection escaped as an unhandled rejection — " +
          "`run.catch(() => {})` is what keeps it observed",
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("the default budget is bounded and shorter than a function timeout", () => {
    assert.ok(
      SINGLE_FLIGHT_TIMEOUT_MS > 0 && SINGLE_FLIGHT_TIMEOUT_MS <= 30_000,
      "the budget must let the caller's own error path run before the platform " +
        "kills the request with nothing to show",
    );
  });
});
