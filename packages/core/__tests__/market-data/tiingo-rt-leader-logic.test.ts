/**
 * Leader election decisions.
 *
 * The case that matters is the THREE-VALUED outcome. "Redis refused" and "Redis
 * did not answer" are different facts, and collapsing them is how two pods end
 * up both holding a socket — which does not look like an outage, it looks like
 * data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideLeadership,
  mayWrite,
  makeLeaderToken,
  LEADER_TTL_MS,
  LEADER_RENEW_MS,
  LEADER_SELF_FENCE_MS,
  type LeaderView,
} from "../../src/market-data/tiingo/tiingo-rt-leader-logic";

const NOW = 1_800_000_000_000;
const view = (over: Partial<LeaderView> = {}): LeaderView => ({
  state: "leader",
  lastConfirmedMs: NOW,
  token: "t-1",
  ...over,
});

describe("PREMISE: the timing constants leave room to survive a hiccup", () => {
  it("renews at TTL/3 and fences BEFORE the lock lapses", () => {
    // At TTL/2 a single missed renewal loses the lock. At TTL/3 two consecutive
    // failures are survivable and the third is signal rather than noise.
    assert.equal(LEADER_RENEW_MS, LEADER_TTL_MS / 3);
    assert.ok(
      LEADER_SELF_FENCE_MS < LEADER_TTL_MS,
      "the process must stand down BEFORE Redis expires the lock, or a successor " +
        "can start while the incumbent still believes it leads",
    );
    assert.ok(
      LEADER_SELF_FENCE_MS > LEADER_RENEW_MS,
      "one missed renewal must not fence",
    );
  });
});

describe("acquiring", () => {
  it("a follower that acquires becomes leader", () => {
    const a = decideLeadership({
      view: view({ state: "follower", lastConfirmedMs: null }),
      outcome: "acquired",
      nowMs: NOW,
    });
    assert.deepEqual(a, { do: "become-leader" });
  });

  it("a leader that renews holds", () => {
    assert.deepEqual(
      decideLeadership({ view: view(), outcome: "acquired", nowMs: NOW }),
      { do: "hold" },
    );
  });

  it("a follower refused stays a follower — that is the normal steady state", () => {
    assert.deepEqual(
      decideLeadership({
        view: view({ state: "follower", lastConfirmedMs: null }),
        outcome: "refused",
        nowMs: NOW,
      }),
      { do: "stay-follower" },
    );
  });
});

describe("REFUSED and UNKNOWN are different facts", () => {
  it("a leader REFUSED steps down immediately — someone else already writes", () => {
    const a = decideLeadership({
      view: view(),
      outcome: "refused",
      nowMs: NOW,
    });
    assert.equal(a.do, "step-down");
  });

  it("a leader with an UNKNOWN outcome HOLDS inside the fence", () => {
    // The lock has not lapsed and nobody else can hold it. Dropping the socket
    // for one hiccup costs a reconnect and a full REST snapshot against a
    // metered API — more expensive than the risk it avoids.
    const a = decideLeadership({
      view: view({ lastConfirmedMs: NOW - (LEADER_SELF_FENCE_MS - 1) }),
      outcome: "unknown",
      nowMs: NOW,
    });
    assert.deepEqual(a, { do: "hold" });
  });

  it("a leader with an UNKNOWN outcome STEPS DOWN past the fence", () => {
    // FAIL-CLOSED. A leader that cannot confirm it still holds the lock must
    // stop writing: a quiet feed is visible within one alarm period, two feeds
    // writing the same bars is not visible at all.
    const a = decideLeadership({
      view: view({ lastConfirmedMs: NOW - LEADER_SELF_FENCE_MS }),
      outcome: "unknown",
      nowMs: NOW,
    });
    assert.equal(a.do, "step-down");
    if (a.do === "step-down") assert.match(a.reason, /no confirmed renewal/);
  });

  it("a leader that has NEVER confirmed steps down on the first unknown", () => {
    const a = decideLeadership({
      view: view({ lastConfirmedMs: null }),
      outcome: "unknown",
      nowMs: NOW,
    });
    assert.equal(a.do, "step-down");
  });

  it("a FOLLOWER with an unknown outcome simply stays a follower", () => {
    // No socket to close, nothing to fence. Not an error state.
    assert.deepEqual(
      decideLeadership({
        view: view({ state: "follower", lastConfirmedMs: null }),
        outcome: "unknown",
        nowMs: NOW,
      }),
      { do: "stay-follower" },
    );
  });
});

describe("mayWrite guards the WRITE path, not just the timer", () => {
  it("a healthy leader may write", () => {
    assert.equal(mayWrite(view(), NOW), true);
  });

  it("a follower may never write", () => {
    assert.equal(mayWrite(view({ state: "follower" }), NOW), false);
    assert.equal(mayWrite(view({ state: "stepping-down" }), NOW), false);
  });

  it("a leader whose RENEWAL LOOP HAS STALLED may not write", () => {
    // The case a renewal timer alone cannot catch: a blocked event loop or a
    // starved timer would otherwise let a process keep writing on a lock that
    // expired minutes ago. The check is local and cheap; the failure it
    // prevents is two writers.
    assert.equal(
      mayWrite(view({ lastConfirmedMs: NOW - LEADER_SELF_FENCE_MS }), NOW),
      false,
    );
    assert.equal(mayWrite(view({ lastConfirmedMs: null }), NOW), false);
  });

  it("is exactly the fence, not the TTL", () => {
    assert.equal(
      mayWrite(view({ lastConfirmedMs: NOW - LEADER_SELF_FENCE_MS + 1 }), NOW),
      true,
    );
    assert.equal(
      mayWrite(view({ lastConfirmedMs: NOW - LEADER_TTL_MS }), NOW),
      false,
    );
  });
});

describe("owner token", () => {
  it("differs between two processes on the same host", () => {
    // Two revisions of one Cloud Run service can share a host. A token derived
    // from the hostname alone would let one release the other's lock.
    const a = makeLeaderToken({ pid: 1, startedAtMs: NOW, random: "aaa" });
    const b = makeLeaderToken({ pid: 2, startedAtMs: NOW, random: "bbb" });
    assert.notEqual(a, b);
  });

  it("differs between restarts of the same pid", () => {
    const a = makeLeaderToken({ pid: 1, startedAtMs: NOW, random: "x" });
    const b = makeLeaderToken({ pid: 1, startedAtMs: NOW + 1, random: "x" });
    assert.notEqual(a, b);
  });
});

describe("two instances can never both lead", () => {
  it("simulated race: only one acquires, the other stays a follower", () => {
    // The whole point, expressed as the sequence Redis would produce: one SET
    // NX wins, every other attempt is refused.
    let held: string | null = null;
    const attempt = (token: string): "acquired" | "refused" => {
      if (held === null || held === token) {
        held = token;
        return "acquired";
      }
      return "refused";
    };
    const a = decideLeadership({
      view: view({ state: "follower", lastConfirmedMs: null, token: "A" }),
      outcome: attempt("A"),
      nowMs: NOW,
    });
    const b = decideLeadership({
      view: view({ state: "follower", lastConfirmedMs: null, token: "B" }),
      outcome: attempt("B"),
      nowMs: NOW,
    });
    assert.deepEqual(a, { do: "become-leader" });
    assert.deepEqual(b, { do: "stay-follower" });
  });

  it("after the leader steps down, the follower can take over", () => {
    let held: string | null = "A";
    const attempt = (token: string): "acquired" | "refused" => {
      if (held === null || held === token) {
        held = token;
        return "acquired";
      }
      return "refused";
    };
    held = null; // A's lock lapsed
    assert.deepEqual(
      decideLeadership({
        view: view({ state: "follower", lastConfirmedMs: null, token: "B" }),
        outcome: attempt("B"),
        nowMs: NOW,
      }),
      { do: "become-leader" },
    );
  });
});
