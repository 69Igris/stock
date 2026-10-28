/**
 * OAuth CSRF state - MONEY-287
 *
 * Generates and verifies a cryptographically-random `state` parameter
 * for every broker OAuth init. The state is bound to the authenticated
 * user + the broker via the Redis key, and is single-use: verify()
 * deletes the entry on a hit so a captured callback URL cannot be
 * replayed.
 *
 * Threat model: pre-MONEY-287 every broker OAuth init generated an
 * authorization redirect with no `state` param and every callback
 * accepted whatever code/token landed unconditionally. An attacker
 * could trick a logged-in user into hitting the attacker's broker
 * callback URL, silently linking the attacker's broker account to
 * the victim's UseMoney account (login-CSRF). The state value below
 * binds the round-trip to the user's own browser session.
 *
 * Redis layout:
 *   key   = oauth:state:{userId}:{broker}:{state}
 *   value = "1"  (presence-only; state itself is in the key)
 *   ttl   = 10 minutes
 *
 * The state itself lives in the key (not the value) so verify() can
 * use a single `DEL` and treat a non-zero return as success. This is
 * race-free across concurrent callback attempts.
 *
 * MIGRATION NOTE (W0-α): copied from apps/web/lib/security/oauth-state.ts. The
 * only source change is the redis import — the web copy pulled the app-local
 * `@/lib/redis`; this copy uses core's own redis client (`../cache/redis`,
 * same `getRedisClient(): Redis | null` contract). A test seam
 * (`__setRedisClientGetterForTests`) is added because this package is ESM,
 * where the CJS `require.cache` module-swap the web suite used to inject a fake
 * redis does not work.
 */

import crypto from "crypto";
import { getRedisClient as coreGetRedisClient } from "../cache/redis";
import { authLogger as logger } from "@usemoney/logger";
import type { BrokerType } from "@usemoney/types";

/**
 * Test seam (ESM): the apps/web suite swapped `@/lib/redis` via the CJS
 * `require.cache` trick, which is unavailable in this ESM package (and
 * `node:test`'s `mock.module` needs an experimental flag, unused in this repo).
 * Expose an overridable getter so tests can inject a fake redis client.
 * Production code NEVER calls the setter — the getter defaults to core's client.
 */
let redisClientGetter: typeof coreGetRedisClient = coreGetRedisClient;

/** Inject a redis-client getter for tests (pass null to restore the default). */
export function __setRedisClientGetterForTests(
  fn: typeof coreGetRedisClient | null,
): void {
  redisClientGetter = fn ?? coreGetRedisClient;
}

/** State TTL - Redis expires the key automatically after this. */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** Entropy of the random state (bytes; hex-encoded → 64 chars). */
const OAUTH_STATE_BYTES = 32;

/** Redis key prefix shared by generate + verify. */
function stateKey(
  userId: string,
  broker: BrokerType | string,
  state: string,
): string {
  return `oauth:state:${userId}:${broker}:${state}`;
}

/**
 * Generate a fresh state and persist it to Redis under the user+broker
 * tuple. Caller appends the returned value as `&state=<state>` on the
 * outgoing OAuth authorization URL.
 *
 * Returns `null` if Redis is unavailable - callers should treat this
 * as a soft failure (log + proceed without state, since the OAuth
 * flow still works) rather than blocking auth. Most environments have
 * Redis up; the null path mainly matters for local dev without Redis.
 *
 * The user input (userId, broker) is sanity-checked but not strictly
 * validated - the keyspace `oauth:state:*` is namespaced so even a
 * malicious userId can only collide within its own subtree.
 */
export async function generateOAuthState(
  userId: string,
  broker: BrokerType | string,
): Promise<string | null> {
  if (!userId) return null;
  const redis = redisClientGetter();
  if (!redis) {
    logger.warn(
      { broker },
      "[oauth-state] Redis unavailable - proceeding without CSRF state",
    );
    return null;
  }
  const state = crypto.randomBytes(OAUTH_STATE_BYTES).toString("hex");
  try {
    // SET … EX … NX: only write if the key doesn't already exist. Even
    // though collisions on 256 bits of entropy are astronomically
    // unlikely, NX makes the intent explicit and is no slower.
    await redis.set(
      stateKey(userId, broker, state),
      "1",
      "EX",
      OAUTH_STATE_TTL_SECONDS,
      "NX",
    );
    return state;
  } catch (error) {
    logger.error(
      { error, broker },
      "[oauth-state] Failed to persist state to Redis",
    );
    return null;
  }
}

/**
 * Verify a callback's `state` against what we stored for this user +
 * broker. Returns true exactly once per (userId, broker, state) tuple
 * - the verify deletes the key on success so the same callback URL
 * cannot be replayed.
 *
 * Returns false for:
 *   - Missing/empty state (caller forgot to extract from the query)
 *   - State that doesn't exist (TTL expired, never generated, or
 *     belongs to another user/broker)
 *   - Redis unavailable (fail CLOSED — there is no store to check against)
 *
 * Fail-CLOSED policy when Redis is down (MONEY-1062 W0 regression fix): a CSRF
 * verify with no store to check the callback's `state` against MUST reject.
 * BACKGROUND: the pre-W0 web redis client cached its singleton forever, so
 * `!redis` was effectively unreachable in prod and this verify was fail-CLOSED.
 * Core's `getRedisClient()` returns null PERMANENTLY after MAX_CONNECTION_ATTEMPTS,
 * so the former soft-pass (`return true`) became a LIVE login-CSRF hole
 * (MONEY-287 class): any attacker `state` was accepted during a Redis outage.
 * verify is now ALWAYS strict; the `OAUTH_STATE_STRICT` env flag is obsolete here
 * (generate stays soft/best-effort — a null redis there just stores no state, and
 * this verify then correctly rejects the un-stored state).
 */
export async function verifyOAuthState(
  userId: string,
  broker: BrokerType | string,
  state: string | undefined | null,
): Promise<boolean> {
  if (!state || !userId) return false;
  const redis = redisClientGetter();
  if (!redis) {
    logger.error(
      { broker },
      "[oauth-state] Redis unavailable - rejecting OAuth callback (fail-closed)",
    );
    return false;
  }
  try {
    // DEL returns the number of keys deleted. A successful single-use
    // verify therefore returns 1, while a missing key returns 0.
    const removed = await redis.del(stateKey(userId, broker, state));
    return removed > 0;
  } catch (error) {
    logger.error(
      { error, broker },
      "[oauth-state] Redis del failed during verify - treating as miss",
    );
    return false;
  }
}

// ── Re-auth intent (MONEY-837) ──────────────────────────────────────
//
// Kite has no login_hint, so when a user with MULTIPLE accounts on the same
// broker clicks "Re-auth" on a SPECIFIC connection, the Kite login page comes
// up pre-filled with whatever account was used last — and the callback would
// otherwise update whichever account they actually log into (by brokerUserId),
// silently rewriting the WRONG connection. We stash the connection being
// re-authed here (keyed per user+broker, separate from the CSRF state so that
// security path is untouched) and the callback rejects a mismatch.

export interface ReauthIntent {
  connectionId: string;
  /** The brokerUserId the user MUST log in as for this re-auth. */
  expectedBrokerUserId: string;
}

function reauthKey(userId: string, broker: BrokerType | string): string {
  return `oauth:reauth:${userId}:${broker}`;
}

/** Record which connection a re-auth is for (best-effort; Redis-down = no-op). */
export async function storeReauthIntent(
  userId: string,
  broker: BrokerType | string,
  intent: ReauthIntent,
): Promise<void> {
  if (!userId) return;
  const redis = redisClientGetter();
  if (!redis) return;
  try {
    await redis.set(
      reauthKey(userId, broker),
      JSON.stringify(intent),
      "EX",
      OAUTH_STATE_TTL_SECONDS,
    );
  } catch (error) {
    logger.warn({ error, broker }, "[oauth-state] storeReauthIntent failed");
  }
}

/**
 * Read + clear the re-auth intent for this user+broker (single-use). Returns
 * null when there was none (a fresh connect, not a re-auth) or Redis is down.
 */
export async function consumeReauthIntent(
  userId: string,
  broker: BrokerType | string,
): Promise<ReauthIntent | null> {
  if (!userId) return null;
  const redis = redisClientGetter();
  if (!redis) return null;
  const key = reauthKey(userId, broker);
  try {
    const raw = await redis.get(key);
    if (raw) await redis.del(key);
    return raw ? (JSON.parse(raw) as ReauthIntent) : null;
  } catch (error) {
    logger.warn({ error, broker }, "[oauth-state] consumeReauthIntent failed");
    return null;
  }
}

/**
 * Test-only: returns true if the key currently exists in Redis. Used
 * by integration tests to assert generate() persisted the state.
 */
export async function __peekOAuthStateForTests(
  userId: string,
  broker: BrokerType | string,
  state: string,
): Promise<boolean> {
  const redis = redisClientGetter();
  if (!redis) return false;
  try {
    const exists = await redis.exists(stateKey(userId, broker, state));
    return exists > 0;
  } catch {
    return false;
  }
}
