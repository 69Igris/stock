/**
 * Stale-while-error cache primitive (MONEY-1092).
 *
 * This is the state machine that decides whether the discover heatmap
 * serves fresh data, serves a last-known-good copy, or reports a failure.
 * Before it existed, one slow query became a full-page "Failed to load
 * market heatmap" even though a correct copy from sixty seconds earlier
 * was sitting right there.
 *
 * The ports are injected, so every branch is exercised with in-memory
 * fakes — no Redis, no timers, no wall-clock dependency.
 *
 * Source: packages/core/src/cache/stale-while-error.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolveWithStaleFallback,
  cachedWithStaleFallback,
  singleFlight,
  __resetSingleFlight,
  type Stamped,
  type StaleWhileErrorPorts,
} from "../../src/cache/stale-while-error";

interface Payload {
  n: number;
}

/** Build ports over mutable in-memory slots, recording every call. */
function makePorts(overrides: Partial<StaleWhileErrorPorts<Payload>> = {}) {
  const state = {
    fresh: null as Payload | null,
    lastGood: null as Stamped<Payload> | null,
    computeCalls: 0,
    freshWrites: [] as Payload[],
    lastGoodWrites: [] as Stamped<Payload>[],
  };
  const ports: StaleWhileErrorPorts<Payload> = {
    readFresh: async () => state.fresh,
    readLastGood: async () => state.lastGood,
    writeFresh: async (v) => {
      state.freshWrites.push(v);
      state.fresh = v;
    },
    writeLastGood: async (s) => {
      state.lastGoodWrites.push(s);
      state.lastGood = s;
    },
    compute: async () => {
      state.computeCalls += 1;
      return { n: 1 };
    },
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return { ports, state };
}

describe("resolveWithStaleFallback — fresh path", () => {
  it("serves a fresh cache hit without computing", async () => {
    const { ports, state } = makePorts();
    state.fresh = { n: 42 };
    const out = await resolveWithStaleFallback(ports);
    assert.equal(out.status, "fresh");
    if (out.status === "fresh") assert.deepEqual(out.data, { n: 42 });
    assert.equal(state.computeCalls, 0, "a cache hit must not recompute");
  });

  it("computes on a miss and writes BOTH entries", async () => {
    const { ports, state } = makePorts();
    const out = await resolveWithStaleFallback(ports);
    assert.equal(out.status, "fresh");
    assert.equal(state.computeCalls, 1);
    assert.deepEqual(state.freshWrites, [{ n: 1 }]);
    assert.deepEqual(state.lastGoodWrites, [
      { value: { n: 1 }, computedAt: 1_700_000_000_000 },
    ]);
  });

  it("stamps the last-good copy with the injected clock", async () => {
    const { ports, state } = makePorts({ now: () => 123 });
    await resolveWithStaleFallback(ports);
    assert.equal(state.lastGoodWrites[0]!.computedAt, 123);
  });
});

describe("resolveWithStaleFallback — degraded paths", () => {
  it("serves the last-good copy when the recompute throws", async () => {
    const boom = new Error("heatmap fetch timed out after 10000ms");
    const { ports, state } = makePorts({
      compute: async () => {
        throw boom;
      },
    });
    state.lastGood = { value: { n: 7 }, computedAt: 999 };

    const out = await resolveWithStaleFallback(ports);
    assert.equal(out.status, "stale");
    if (out.status === "stale") {
      assert.deepEqual(out.data, { n: 7 });
      assert.equal(out.computedAt, 999);
      // The cause rides along so the caller can log the REAL failure —
      // the user-facing string is generic on purpose.
      assert.equal(out.error, boom);
    }
  });

  it("reports failure only when there is no last-good copy", async () => {
    const { ports } = makePorts({
      compute: async () => {
        throw new Error("nope");
      },
    });
    const out = await resolveWithStaleFallback(ports);
    assert.equal(out.status, "failed");
  });

  it("does NOT overwrite the last-good copy on a failed recompute", async () => {
    const { ports, state } = makePorts({
      compute: async () => {
        throw new Error("nope");
      },
    });
    state.lastGood = { value: { n: 7 }, computedAt: 999 };
    await resolveWithStaleFallback(ports);
    assert.deepEqual(
      state.lastGood,
      { value: { n: 7 }, computedAt: 999 },
      "a failure must not clobber the fallback it depends on",
    );
    assert.equal(state.lastGoodWrites.length, 0);
  });
});

describe("resolveWithStaleFallback — permanent errors bypass the fallback", () => {
  class NotFound extends Error {}

  it("reports a permanent error instead of serving last-good", async () => {
    // Stale-fallback is for OUTAGES. A permanent answer ("this sector has no
    // instruments") served from a 24h-old copy resurrects something that no
    // longer exists, and keeps resurrecting it for the whole window.
    const { ports, state } = makePorts({
      compute: async () => {
        throw new NotFound("no such sector");
      },
      isPermanentError: (e) => e instanceof NotFound,
    });
    state.lastGood = { value: { n: 7 }, computedAt: 999 };

    const out = await resolveWithStaleFallback(ports);
    assert.equal(
      out.status,
      "failed",
      "a permanent error must not degrade to stale",
    );
  });

  it("still serves last-good for a TRANSIENT error when a classifier is present", async () => {
    const { ports, state } = makePorts({
      compute: async () => {
        throw new Error("timed out");
      },
      isPermanentError: (e) => e instanceof NotFound,
    });
    state.lastGood = { value: { n: 7 }, computedAt: 999 };
    const out = await resolveWithStaleFallback(ports);
    assert.equal(out.status, "stale");
  });

  it("treats every error as transient when no classifier is given", async () => {
    const { ports, state } = makePorts({
      compute: async () => {
        throw new NotFound("no such sector");
      },
    });
    state.lastGood = { value: { n: 7 }, computedAt: 999 };
    const out = await resolveWithStaleFallback(ports);
    assert.equal(out.status, "stale", "default must stay backwards-compatible");
  });
});

describe("resolveWithStaleFallback — the cache never breaks the request", () => {
  it("treats a throwing fresh-read as a miss and computes", async () => {
    const { ports, state } = makePorts({
      readFresh: async () => {
        throw new Error("redis down");
      },
    });
    const out = await resolveWithStaleFallback(ports);
    assert.equal(out.status, "fresh");
    assert.equal(state.computeCalls, 1);
  });

  it("still returns data when BOTH writes throw", async () => {
    // A Redis blip while persisting a value we already computed must not
    // turn a successful response into an error.
    const { ports } = makePorts({
      writeFresh: async () => {
        throw new Error("redis down");
      },
      writeLastGood: async () => {
        throw new Error("redis down");
      },
    });
    const out = await resolveWithStaleFallback(ports);
    assert.equal(out.status, "fresh");
    if (out.status === "fresh") assert.deepEqual(out.data, { n: 1 });
  });

  it("falls back to failed when the last-good read also throws", async () => {
    const { ports } = makePorts({
      compute: async () => {
        throw new Error("nope");
      },
      readLastGood: async () => {
        throw new Error("redis down");
      },
    });
    const out = await resolveWithStaleFallback(ports);
    assert.equal(out.status, "failed");
  });
});

describe("singleFlight", () => {
  beforeEach(() => __resetSingleFlight());

  it("collapses concurrent calls on one key into a single execution", async () => {
    // This is the thundering-herd fix: when a 60s TTL expires, every
    // in-flight request used to launch its own 3000-row scan.
    let calls = 0;
    let release!: (v: number) => void;
    const gate = new Promise<number>((r) => {
      release = r;
    });
    const fn = () => {
      calls += 1;
      return gate;
    };

    const all = Promise.all([
      singleFlight("k", fn),
      singleFlight("k", fn),
      singleFlight("k", fn),
    ]);
    release(5);
    assert.deepEqual(await all, [5, 5, 5]);
    assert.equal(calls, 1, "three concurrent callers must share one compute");
  });

  it("keeps distinct keys independent", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return calls;
    };
    await Promise.all([singleFlight("a", fn), singleFlight("b", fn)]);
    assert.equal(calls, 2);
  });

  it("does not poison the key after a rejection", async () => {
    // A failed compute must not wedge the key — the next caller has to be
    // able to try again, or one timeout would break the key until restart.
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("boom");
    };
    await assert.rejects(() => singleFlight("k", failing));
    await assert.rejects(() => singleFlight("k", failing));
    assert.equal(
      calls,
      2,
      "the second caller must re-run, not reuse the reject",
    );
  });

  it("releases the key once a successful call settles", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return calls;
    };
    assert.equal(await singleFlight("k", fn), 1);
    assert.equal(await singleFlight("k", fn), 2);
  });
});

/* ---------------------------------------------------------------------
   The BOUND helper — the layer production actually calls
   ------------------------------------------------------------------ */

/**
 * These exist because unit-testing `resolveWithStaleFallback` was NOT enough.
 * An earlier revision destructured `isPermanentError` from the args and then
 * forgot to forward it into the ports object, so every caller that passed a
 * classifier silently got default transient behaviour. The unit tests above
 * all passed — they call the state machine directly and never traverse this
 * wiring. A mutation test on the guard also passed, for the same reason.
 *
 * The lesson generalises: a guard proven to work in isolation is not a guard
 * proven to be REACHED. These cover the seam.
 */
describe("cachedWithStaleFallback — options actually reach the state machine", () => {
  beforeEach(() => __resetSingleFlight());

  class Permanent extends Error {}

  it("forwards isPermanentError, so a permanent error is not served stale", async () => {
    // No cache is configured in this environment, so reads miss and the
    // compute runs. What matters is which BRANCH the thrown error takes.
    let seen: unknown = null;
    const out = await cachedWithStaleFallback<{ n: number }>({
      module: "discover",
      scope: "_test",
      identifier: `perm-${Math.trunc(1)}-a`,
      ttlSeconds: 1,
      staleTtlSeconds: 1,
      isPermanentError: (e) => {
        seen = e;
        return e instanceof Permanent;
      },
      compute: async () => {
        throw new Permanent("no such sector");
      },
    });

    assert.ok(
      seen instanceof Permanent,
      "isPermanentError was never invoked — the option is not being forwarded",
    );
    assert.equal(out.status, "failed");
  });

  it("leaves the classifier optional — omitting it still resolves", async () => {
    const out = await cachedWithStaleFallback<{ n: number }>({
      module: "discover",
      scope: "_test",
      identifier: "perm-b",
      ttlSeconds: 1,
      staleTtlSeconds: 1,
      compute: async () => ({ n: 5 }),
    });
    assert.ok(out.status === "fresh" || out.status === "stale");
  });
});
