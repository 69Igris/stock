/**
 * The liveness decision, as a pure function.
 *
 * It lives here rather than inside `main.ts` for one reason: `main.ts` calls
 * `start()` at import, so it cannot be imported by a test, and the only check
 * available there is a source scan. A source scan is what let a VACUOUS test
 * through — asserting that the identifier `lastSocketHealthyMs` appears in the
 * file stays green when the grace-window logic is deleted, because the
 * declaration still appears. Naming a bug is not protection from it.
 *
 * ## Why a grace window exists at all
 *
 * `/health` used to return 200 unconditionally, which made it useless as a
 * Cloud Run liveness probe: the failure this service actually has is a leader
 * holding a socket that receives nothing, and a probe that cannot express that
 * will never restart it.
 *
 * But the obvious repair — fail as soon as the socket is not connected — is
 * WORSE than the original, and worse in a way that hides:
 *
 *   disconnect -> probe fails -> Cloud Run restarts the container
 *              -> a fresh TiingoSocket is constructed with `attempt = 0`
 *              -> the backoff ladder can never reach its second rung
 *              -> the reconnect storm the ladder exists to prevent happens
 *                 anyway, while both the probe and the ladder look correct
 *                 in their own files
 *
 * A disconnect is normal and self-healing. The ladder waits up to
 * `BACKOFF_MAX_MS` between attempts, and the watchdog needs
 * `HEARTBEAT_TIMEOUT_MS` to notice a socket that went quiet without erroring.
 * So the threshold has to exceed a whole cycle of both — that is not a comfort
 * margin, it is the condition under which the two fixes stop cancelling.
 */

export interface HealthInput {
  /** Only a LEADER is expected to hold a socket. */
  leader: boolean;
  /** Is the socket object present and in OPEN state? */
  socketConnected: boolean;
  /** Age of the last frame, ms. `Infinity` before the first one. */
  msSinceLastFrame: number;
  /** Last moment the socket was demonstrably working, epoch ms. */
  lastHealthyAtMs: number;
  nowMs: number;
  heartbeatTimeoutMs: number;
  unhealthyAfterMs: number;
}

export interface HealthVerdict {
  ok: boolean;
  /** Push this back into `lastHealthyAtMs`; unchanged unless the socket is live. */
  lastHealthyAtMs: number;
  reason: string;
}

export function decideHealth(input: HealthInput): HealthVerdict {
  // A FOLLOWER with no socket is healthy. That is the design, not a hole: only
  // one instance may hold the feed, and restarting the others would churn the
  // leader election for nothing.
  if (!input.leader) {
    return {
      ok: true,
      lastHealthyAtMs: input.lastHealthyAtMs,
      reason: "follower",
    };
  }

  const live =
    input.socketConnected && input.msSinceLastFrame <= input.heartbeatTimeoutMs;

  if (live) {
    return { ok: true, lastHealthyAtMs: input.nowMs, reason: "socket live" };
  }

  const downFor = input.nowMs - input.lastHealthyAtMs;
  if (downFor < input.unhealthyAfterMs) {
    return {
      ok: true,
      lastHealthyAtMs: input.lastHealthyAtMs,
      reason: `reconnecting (${downFor}ms, grace ${input.unhealthyAfterMs}ms)`,
    };
  }

  return {
    ok: false,
    lastHealthyAtMs: input.lastHealthyAtMs,
    reason: input.socketConnected
      ? `socket open but silent for ${input.msSinceLastFrame}ms`
      : `no socket for ${downFor}ms`,
  };
}
