/**
 * UNIT TEST — the history route's two preconditions run CONCURRENTLY
 * (MONEY-1383 L1).
 *
 * Measured on prod 2026-09-08, demo session, medians of 3: `/api/market/udf/
 * history` cost 1.05 s warm. NOT a cache hit — a review corrected that claim,
 * and the correction matters. Both cache gates require `countback === null`,
 * and charting library v31 declares `PeriodParams.countBack` REQUIRED, so every
 * widget request carries it and the shared Redis cache is unreachable from the
 * chart entirely. The 1.05 s was a warm MISS. What the request actually spent
 * it on is still real: `auth()` evaluated three times (the handler,
 * `isDemoSession`, and `getBrokerMarketDataStatus`), then the corporate-action
 * lookup and the broker-status read awaited IN SEQUENCE though neither reads
 * the other's result.
 * Every one of those hops is cross-region while the Vercel region is unpinned
 * (MONEY-1122), so serialising them is pure added latency on the fastest path
 * the route has.
 *
 * WHY A BEHAVIOURAL TEST AND NOT A SOURCE SCAN: a regex for `Promise.all(`
 * proves a call site exists, not that these two calls overlap. A future edit
 * that re-sequences the awaits — or awaits one inside the other's callback —
 * would leave such a scan green while restoring the exact defect. This test
 * watches the second task START before the first RESOLVES, which is the
 * property itself.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadHistoryPreconditions } from "../../app/api/market/udf/history/route-logic";

/** A task that records when it started and resolves only when told to. */
function deferred<T>(value: T) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const state = { started: false };
  const run = async (): Promise<T> => {
    state.started = true;
    await gate;
    return value;
  };
  return { run, state, release };
}

describe("MONEY-1383 — loadHistoryPreconditions", () => {
  it("starts the second task before the first resolves", async () => {
    const first = deferred("adjustment");
    const second = deferred("brokerStatus");

    const pending = loadHistoryPreconditions(first.run, second.run);

    // Let the microtask queue drain. Both tasks must have entered their bodies
    // even though NEITHER has resolved — that is exactly what a sequential
    // `await a; await b;` cannot do.
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(first.state.started, true, "first task should have started");
    assert.equal(
      second.state.started,
      true,
      "second task must start before the first resolves — this is the whole point"
    );

    first.release();
    second.release();
    assert.deepEqual(await pending, ["adjustment", "brokerStatus"]);
  });

  it("returns results positionally, adjustment first", async () => {
    // The caller destructures `[adjustment, marketStatus]`. Swapping them
    // would type-check if both were `unknown` and would poison the cache key
    // with a broker status.
    const out = await loadHistoryPreconditions(
      async () => ({ kind: "adjustment" as const }),
      async () => ({ kind: "brokerStatus" as const })
    );
    assert.equal(out[0].kind, "adjustment");
    assert.equal(out[1].kind, "brokerStatus");
  });

  it("does not swallow a rejection", async () => {
    // Each caller owns its own error contract — the adjustment lookup degrades
    // to unadjusted bars inside its OWN catch. Swallowing here would turn a
    // broker-status failure into an undefined status that reads as "no broker".
    await assert.rejects(
      loadHistoryPreconditions(
        async () => "ok",
        async () => {
          throw new Error("broker status exploded");
        }
      ),
      /broker status exploded/
    );
  });

  it("a slow first task does not delay the second", async () => {
    // The measured shape: the adjustment lookup is two Mongo queries on a
    // per-instance memo miss, the broker status up to two cache reads. Under
    // sequencing the request paid their SUM; concurrently it pays the MAX.
    const order: string[] = [];
    await loadHistoryPreconditions(
      async () => {
        await new Promise((r) => setTimeout(r, 30));
        order.push("slow");
        return 1;
      },
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        order.push("fast");
        return 2;
      }
    );
    assert.deepEqual(
      order,
      ["fast", "slow"],
      "the fast task must finish first, proving it did not wait its turn"
    );
  });
});
