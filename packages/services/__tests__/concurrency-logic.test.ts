/**
 * MONEY-712 — bounded concurrency, asserted by OBSERVATION not by regex.
 *
 * The bound started life inline in `syncBrokerConnections`, guarded by source
 * -text assertions that a concurrency constant existed and that
 * `connections.slice(` appeared. A review mutated the service to
 * `const chunkSize = connections.length` — full unbounded fan-out over every
 * connection, precisely what the bound prevents — and all 51 tests stayed
 * green. A regex cannot see how many things are in flight.
 *
 * So the windowing moved into `mapWithConcurrency` and is tested here by
 * watching PEAK in-flight count. Every case resolves its own promises: no real
 * sleeps, no wall-clock dependence.
 *
 * Why the bound matters at all: the wildcard "*" scheduled sync can carry
 * thousands of broker connections (MONEY-841 removed the ~5k cliff). Unbounded,
 * that stampedes the brokers' APIs and our Mongo pool — trading a slow sync for
 * a rate-limited or banned API key, which is far more expensive.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mapWithConcurrency } from "../src/concurrency-logic";

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("MONEY-712 — mapWithConcurrency", () => {
  it("[regression] never exceeds the limit — the mutation a regex missed", async () => {
    const N = 20;
    const LIMIT = 4;
    let inFlight = 0;
    let peak = 0;
    const gates = Array.from({ length: N }, () => deferred<void>());

    const run = mapWithConcurrency(
      Array.from({ length: N }, (_, i) => i),
      LIMIT,
      async (i) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gates[i]!.promise;
        inFlight -= 1;
        return i * 2;
      },
    );

    // Let the initial window start, then release everything.
    await Promise.resolve();
    assert.strictEqual(
      peak,
      LIMIT,
      `expected at most ${LIMIT} tasks in flight, saw ${peak} — this is the ` +
        `assertion that fails when the bound is removed`,
    );

    for (const g of gates) g.resolve();
    const out = await run;
    assert.strictEqual(out.length, N);
    assert.ok(peak <= LIMIT, `peak ${peak} exceeded the limit ${LIMIT}`);
  });

  it("[regression] results come back in INPUT order, not completion order", async () => {
    // `perConnection` is surfaced per-broker in the UI, so a completion-order
    // result set would be a visible reordering.
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const run = mapWithConcurrency([0, 1, 2], 3, async (i) => {
      await gates[i]!.promise;
      return `item-${i}`;
    });

    // Settle in REVERSE order.
    gates[2]!.resolve();
    gates[1]!.resolve();
    gates[0]!.resolve();

    assert.deepEqual(await run, ["item-0", "item-1", "item-2"]);
  });

  it("keeps the window FULL — a slow item does not idle the others", async () => {
    // The reason this uses index-cursor workers rather than fixed chunks: with
    // chunks, a window waits for its slowest member before the next begins, so
    // one slow broker stalls three healthy ones.
    const slow = deferred<void>();
    const started: number[] = [];
    const fast = Array.from({ length: 5 }, () => deferred<void>());

    const run = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (i) => {
      started.push(i);
      if (i === 0) await slow.promise;
      else await fast[i - 1]!.promise;
      return i;
    });

    // Release the fast ones; item 0 stays pending throughout.
    for (const f of fast) f.resolve();
    await new Promise((r) => setImmediate(r));

    assert.ok(
      started.length > 2,
      `only ${started.length} tasks ever started while one was slow — the ` +
        `window is draining instead of refilling`,
    );

    slow.resolve();
    assert.deepEqual(await run, [0, 1, 2, 3, 4, 5]);
  });

  it("an empty input does no work and returns []", async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 4, async () => {
      calls += 1;
      return 1;
    });
    assert.deepEqual(out, []);
    assert.strictEqual(calls, 0);
  });

  it("a limit below 1 is clamped, not left to hang", async () => {
    // Degrading to serial is recoverable; hanging looks like a slow network and
    // is not.
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => n * 10);
    assert.deepEqual(out, [10, 20, 30]);
  });

  it("does NOT swallow — a rejecting task rejects the call", async () => {
    // Deliberate. Broker sync needs per-item isolation and catches INSIDE its
    // own task; swallowing here would silently turn a caller's failures into
    // undefined holes in the result array.
    const boom = new Error("task failed");
    await assert.rejects(
      () =>
        mapWithConcurrency([1, 2, 3], 2, async (n) => {
          if (n === 2) throw boom;
          return n;
        }),
      (e: unknown) => e === boom,
    );
  });

  it("a limit larger than the input does not over-spawn workers", async () => {
    let peak = 0;
    let inFlight = 0;
    const out = await mapWithConcurrency([1, 2], 50, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return n;
    });
    assert.deepEqual(out, [1, 2]);
    assert.ok(peak <= 2, `spawned ${peak} workers for 2 items`);
  });
});
