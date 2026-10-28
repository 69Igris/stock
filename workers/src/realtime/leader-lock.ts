/**
 * The Redis half of leader election. Decisions live in
 * `@usemoney/core/market-data/tiingo/tiingo-rt-leader-logic`; this file only
 * talks to Redis and reports what happened.
 *
 * ## Why the release is a Lua script and not a DEL
 *
 * `cache/client.ts`'s `releaseLock` is a bare `DEL`, which means any process can
 * release any other process's lock. For a cache single-flight that is harmless.
 * Here it is the whole failure: a leader that paused past its TTL, lost the
 * lock to a successor, then woke up and tidied up on its way out would delete
 * the NEW leader's lock and hand the socket to a third instance. Compare-and-
 * delete has to be atomic, and in Redis that means a script.
 *
 * The renewal is the same shape for the same reason — a blind `PEXPIRE` would
 * let a stale leader extend a lock it no longer owns.
 */

import { getRedisClient } from "@usemoney/core/cache";
import {
  LEADER_TTL_MS,
  makeLeaderToken,
} from "@usemoney/core/market-data/tiingo/tiingo-rt-leader-logic";
import { RT_LEADER_KEY } from "@usemoney/core/market-data/tiingo/tiingo-rt-keys";

/** Delete only if we still own it. */
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/** Extend only if we still own it. */
const RENEW_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

export type LockOutcome = "acquired" | "refused" | "unknown";

export function newToken(): string {
  return makeLeaderToken({
    pid: process.pid,
    startedAtMs: Date.now(),
    random: Math.random().toString(36).slice(2, 10),
  });
}

/**
 * Try to take the lock, or confirm we still hold it.
 *
 * Returns `unknown` — never a thrown error and never a silent `true` — when
 * Redis cannot answer. That third value is the entire point: the caller must be
 * able to tell "someone else leads" from "I have no idea", because only the
 * second one obliges a leader to stand down.
 */
export async function acquireOrRenew(token: string): Promise<LockOutcome> {
  const redis = getRedisClient();
  if (!redis) {
    // NOT `true`. Without Redis there is no mutual exclusion at all, so every
    // instance would lead — the exact fail-open behaviour this election exists
    // to avoid.
    return "unknown";
  }
  try {
    const set = await redis.set(RT_LEADER_KEY, token, "PX", LEADER_TTL_MS, "NX");
    if (set === "OK") return "acquired";
    // Not ours to take — unless it is already ours, in which case extend it.
    const renewed = (await redis.eval(
      RENEW_LUA,
      1,
      RT_LEADER_KEY,
      token,
      String(LEADER_TTL_MS),
    )) as number;
    return renewed === 1 ? "acquired" : "refused";
  } catch {
    return "unknown";
  }
}

/**
 * Give up the lock, but only if it is still ours.
 *
 * Best-effort by design: a failure here costs one TTL of nobody leading, which
 * is bounded and self-healing. Blocking shutdown on it would be worse.
 */
export async function releaseLeadership(token: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.eval(RELEASE_LUA, 1, RT_LEADER_KEY, token);
  } catch {
    // Deliberately swallowed. See above: the lock expires on its own.
  }
}
