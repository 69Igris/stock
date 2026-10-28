/**
 * Leader election for the single-socket holder — the PURE half.
 *
 * ## Why not `cache/client.ts`'s `acquireLock`
 *
 * That one is documented FAIL-OPEN and means it: no Redis configured returns
 * `true`, a Redis throw returns `true`, and `releaseLock` is a bare `DEL` with
 * no owner check. Those are the right properties for what it does — a
 * cache-stampede single-flight must never stall a request — and they are
 * exactly the three properties a singleton election must not have:
 *
 *   fail-open        two pods both believe they lead, so two sockets open, the
 *                    tick path double-writes and the subscription budget is
 *                    spent twice
 *   bare DEL         any process can release any other process's lock
 *   no renewal       a fixed TTL either expires under a healthy leader or
 *                    outlives a dead one; there is no length that is right
 *
 * So this is FAIL-CLOSED: no Redis, or Redis in doubt, means NOT LEADER and the
 * socket closes. A feed that goes quiet is visible within one staleness alarm
 * period. Two feeds writing the same minute bars from two pods is not visible at
 * all — it looks like data.
 *
 * ## Why an owner token
 *
 * Renewal without an owner check is worse than no renewal: a leader that paused
 * long enough to lose its lock, then resumed, would happily extend the NEW
 * leader's lock and both would continue. Every write carries the token and the
 * release compares it, so a stale leader can only ever fail to renew.
 *
 * This module holds the DECISIONS. The Redis calls live in the worker half,
 * which is what keeps every branch below testable without a server.
 */

/** Lock lifetime. A dead leader is replaced within this. */
export const LEADER_TTL_MS = 30_000;

/**
 * Renewal interval — deliberately TTL/3, not TTL/2.
 *
 * At TTL/2 a single missed renewal (one GC pause, one network hiccup) loses the
 * lock outright. At TTL/3 ONE missed renewal is survivable and the second is a
 * genuine signal. The cost is one extra round trip every ten seconds against a
 * connection that is already open.
 *
 * Traced, because this comment used to claim TWO were survivable and that is
 * off by one: with TTL 30000 and renew 10000 the self-fence is 20000, so
 * miss #1 at t=10000 holds (10000 < 20000) and miss #2 at t=20000 steps down
 * (20000 is not < 20000). That is the CORRECT behaviour — stepping down at
 * 20000 leaves 10s of margin before the lock could actually expire, whereas
 * surviving to 30000 would keep writing right up to the moment a successor
 * could legitimately take it. The arithmetic was right and the sentence
 * describing it was wrong, which is the more dangerous of the two.
 */
export const LEADER_RENEW_MS = LEADER_TTL_MS / 3;

/**
 * How long a leader may go without a CONFIRMED renewal before standing down.
 *
 * Not the same as the TTL: the TTL is what Redis enforces, this is what the
 * process enforces on ITSELF. It is shorter, so a leader that cannot reach
 * Redis steps down BEFORE its lock lapses rather than after — the window where
 * a successor could start while the incumbent still believes it leads is the
 * one that produces two sockets.
 */
export const LEADER_SELF_FENCE_MS = LEADER_TTL_MS - LEADER_RENEW_MS;

export type LeaderState = "follower" | "leader" | "stepping-down";

export interface LeaderView {
  state: LeaderState;
  /** Epoch ms of the last renewal Redis CONFIRMED. */
  lastConfirmedMs: number | null;
  token: string;
}

/** What the caller should do after an attempt. */
export type LeaderAction =
  | { do: "hold" }
  | { do: "become-leader" }
  | { do: "step-down"; reason: string }
  | { do: "stay-follower" };

/**
 * Decide what to do given the outcome of an acquire/renew attempt.
 *
 * `outcome` is deliberately three-valued. "Redis said no" and "Redis did not
 * answer" are different facts and must not collapse: the first means someone
 * else leads and we are healthy, the second means we know nothing — and a
 * leader that knows nothing must stand down, because the alternative is two
 * writers.
 */
export function decideLeadership(args: {
  view: LeaderView;
  outcome: "acquired" | "refused" | "unknown";
  nowMs: number;
}): LeaderAction {
  const { view, outcome, nowMs } = args;

  if (outcome === "unknown") {
    if (view.state !== "leader") return { do: "stay-follower" };
    const since =
      view.lastConfirmedMs === null ? Infinity : nowMs - view.lastConfirmedMs;
    if (since >= LEADER_SELF_FENCE_MS) {
      return {
        do: "step-down",
        reason: `no confirmed renewal for ${Math.round(since)}ms (fence ${LEADER_SELF_FENCE_MS}ms)`,
      };
    }
    // Inside the fence a single failure is tolerated: the lock has not lapsed,
    // nobody else can hold it, and dropping the socket for one hiccup would
    // cost a reconnect and a full REST snapshot against a metered API.
    return { do: "hold" };
  }

  if (outcome === "refused") {
    if (view.state === "leader") {
      // Someone else holds the lock while we thought we led. Only possible if
      // we lost it and it was taken; the other pod is already writing.
      return { do: "step-down", reason: "lock is held by another instance" };
    }
    return { do: "stay-follower" };
  }

  return view.state === "leader" ? { do: "hold" } : { do: "become-leader" };
}

/**
 * Is this leader still entitled to write?
 *
 * Called on the WRITE path, not just the renewal timer. A renewal loop that has
 * stalled — an event loop blocked, a timer starved — would otherwise let a
 * process keep writing on a lock that expired minutes ago. The check is cheap
 * and local; the failure it prevents is two writers.
 */
export function mayWrite(view: LeaderView, nowMs: number): boolean {
  if (view.state !== "leader") return false;
  if (view.lastConfirmedMs === null) return false;
  return nowMs - view.lastConfirmedMs < LEADER_SELF_FENCE_MS;
}

/**
 * A per-process owner token.
 *
 * Must be unique per PROCESS, not per host: two revisions of the same Cloud Run
 * service can share a host, and a token derived only from a hostname would let
 * one release the other's lock.
 */
export function makeLeaderToken(seed: {
  pid: number;
  startedAtMs: number;
  random: string;
}): string {
  return `${seed.pid}-${seed.startedAtMs}-${seed.random}`;
}
