/**
 * Broker-connection pure-logic helpers (service layer).
 *
 * Side-effect-free derivation/formatting helpers used by
 * `./broker-connection.service.ts` (the LIVE brokers-page money path:
 * `apps/web/lib/actions/broker-connection.ts` →
 * `getBrokerConnectionsAction` / `disconnectBrokerAction`, plus the
 * `getBrokerSyncStatus` / `getLastSyncTime` library exports). Isolated here
 * (away from the Prisma-importing service) so they can be unit-tested without
 * pulling in the Prisma client at import time, and — critically — so the LIVE
 * user-facing path runs the SAME guarded mapping the tests assert (no shadow,
 * no inline unguarded `.toISOString()`).
 *
 * Behaviour here is identical, for VALID inputs, to the mapping that previously
 * lived inline (twice) in `getBrokerConnections` / `getBrokerConnection`; the
 * service now CALLS these helpers. The only intentional behavioural differences
 * are defensive and security-hardening:
 *
 *   - CREDENTIAL LEAK (highest priority): `toBrokerConnectionInfo` /
 *     `toBrokerSyncStatus` build the returned shape from an explicit WHITELIST
 *     of non-secret fields. Even if a future careless `select` widening (or a
 *     `findUnique` without a `select`) pulls `encryptedCreds` / `iv` /
 *     `authTag` / `accessToken` / `refreshToken` / `apiSecret` into the row,
 *     those fields can NEVER reach the client/api response shape — the mapper
 *     copies named fields only and drops everything else.
 *   - INVALID DATE: a corrupt `tokenExpiry` / `lastSync` / `connectedAt`
 *     (a malformed Mongo timestamp deserialises to an `Invalid Date`, which is
 *     a NON-null Date) no longer throws `RangeError: Invalid time value` on
 *     `.toISOString()`. The previous inline `conn.lastSync?.toISOString()`
 *     looked null-safe but optional chaining does NOT guard an *invalid* (yet
 *     non-null) Date — one corrupt row used to 500 the entire brokers page /
 *     sync-status panel (the service catch turned it into a generic
 *     "Failed to fetch …"). `safeISOString` returns `undefined` for null AND
 *     invalid, so a bad row degrades gracefully instead of taking down the list.
 *   - EXPIRY STATE MACHINE: `isTokenExpired` treats an Invalid-Date expiry as
 *     EXPIRED (deterministic), not as "not expired" (the old `expiry < now`
 *     yielded `false` for `NaN`, silently marking a connection with a corrupt
 *     expiry as healthy). `deriveNeedsReauth` maps EXPIRED / NEEDS_REAUTH /
 *     expired-token → reauth; an unknown / missing status is NOT treated as
 *     CONNECTED for the active check (`isConnectionActive` requires an exact
 *     CONNECTED + a non-expired token).
 *
 * Mirrors the Invalid-Date precedent in `./dashboard-logic.ts`.
 *
 * @see apps/web/__tests__/services/broker-connection-logic-unit.test.ts
 * @see apps/web/__tests__/services/broker-connection-poison-live.test.ts
 */

import type { BrokerType } from "@usemoney/types";

// ---------------------------------------------------------------------------
// Date safety
// ---------------------------------------------------------------------------

/**
 * True only for a real, finite Date. An `Invalid Date` (`new Date("garbage")`,
 * a malformed Mongo timestamp) is a NON-null Date whose `getTime()` is `NaN`,
 * so `date != null` / optional chaining do NOT exclude it — this does.
 */
export function isValidDate(date: Date | null | undefined): date is Date {
  return date instanceof Date && Number.isFinite(date.getTime());
}

/**
 * Invalid-Date-safe ISO serialisation.
 *
 * `conn.tokenExpiry?.toISOString()` THROWS `RangeError: Invalid time value`
 * when `tokenExpiry` is an Invalid Date (optional chaining only guards
 * null/undefined, not an invalid-but-present Date). Returns `undefined` for
 * null/undefined AND for an Invalid Date so one corrupt timestamp can never
 * 500 the whole connection list.
 */
export function safeISOString(
  date: Date | null | undefined,
): string | undefined {
  return isValidDate(date) ? date.toISOString() : undefined;
}

/**
 * `safeISOString` variant returning `null` (not `undefined`) for the
 * absent/invalid case — matches the `lastSync: string | null` contract of the
 * sync-status shape and `getLastSyncTime`.
 */
export function safeISOStringOrNull(
  date: Date | null | undefined,
): string | null {
  return isValidDate(date) ? date.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Expiry / status state machine
// ---------------------------------------------------------------------------

/**
 * Is the broker token expired as of `now`?
 *
 * - A null/undefined `tokenExpiry` → NOT expired (no expiry recorded; matches
 *   prior `conn.tokenExpiry ? … : false` behaviour).
 * - A VALID expiry strictly before `now` → expired.
 * - An INVALID-DATE expiry → treated as EXPIRED (fail-safe + deterministic).
 *   The old `expiry < now` returned `false` for an Invalid Date (`NaN < now`
 *   is `false`), silently marking a corrupt-expiry connection as healthy;
 *   a token we can't reason about must force re-auth, not be trusted.
 */
export function isTokenExpired(
  tokenExpiry: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (tokenExpiry == null) return false;
  if (!isValidDate(tokenExpiry)) return true;
  return tokenExpiry.getTime() < now.getTime();
}

/**
 * Does this connection need re-authentication?
 *
 * Reauth when the stored status is `EXPIRED` or `NEEDS_REAUTH`, OR when the
 * token is expired (incl. the Invalid-Date fail-safe above). An unknown /
 * empty / corrupt status with a still-valid token does NOT force reauth
 * (preserves prior behaviour for `ERROR`/`CONNECTED`/etc.).
 */
export function deriveNeedsReauth(
  status: string | null | undefined,
  tokenExpiry: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  return (
    status === "EXPIRED" ||
    status === "NEEDS_REAUTH" ||
    isTokenExpired(tokenExpiry, now)
  );
}

/**
 * Is this connection active for sync purposes?
 *
 * Active iff the status is EXACTLY `"CONNECTED"` AND the token is not expired
 * (null expiry = no expiry recorded = fine). An unknown / missing / corrupt
 * status is NOT active — it never defaults to "connected". Mirrors the inline
 * `status === "CONNECTED" && (!tokenExpiry || tokenExpiry >= now)` but routes
 * the expiry through the Invalid-Date-safe `isTokenExpired`.
 */
export function isConnectionActive(
  status: string | null | undefined,
  tokenExpiry: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  return status === "CONNECTED" && !isTokenExpired(tokenExpiry, now);
}

// ---------------------------------------------------------------------------
// Relative-time (last-synced)
// ---------------------------------------------------------------------------

/**
 * Human "last synced" relative time, derived defensively.
 *
 * - null/undefined OR an Invalid Date → `"Never synced"` (never a crash, never
 *   the literal "Invalid Date").
 * - a future timestamp (clock skew) → `"Just now"`.
 * - otherwise the coarse age ("Just now" / "Nm ago" / "Nh ago" / "Nd ago").
 *
 * Pure (takes `now`), so it can never throw on a corrupt date.
 */
export function formatLastSyncedRelative(
  lastSync: Date | null | undefined,
  now: Date = new Date(),
): string {
  if (!isValidDate(lastSync)) return "Never synced";
  const diffMs = now.getTime() - lastSync.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "Just now";

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Whitelisted DB row -> client/api shapes (credential-leak guard)
// ---------------------------------------------------------------------------

/**
 * Structural subset of a Prisma `BrokerConnection` row consumed by the
 * connection-info mapper. Intentionally NARROW: only the non-secret fields the
 * UI needs. `extends Record<string, unknown>` lets a caller pass a wider row
 * (incl. `encryptedCreds`/`iv`/`authTag`) WITHOUT widening what the mapper
 * copies out — the credential-leak guard is the explicit field list below.
 */
export interface BrokerConnectionRow extends Record<string, unknown> {
  id: string;
  broker: string;
  brokerUserId: string | null;
  accountName: string | null;
  status: string;
  connectedAt?: Date | null;
  lastSync?: Date | null;
  tokenExpiry?: Date | null;
}

export interface BrokerConnectionInfo {
  id: string;
  broker: BrokerType;
  brokerUserId: string | null;
  accountName: string | null;
  status: string;
  connectedAt?: string;
  lastSync?: string;
  tokenExpiry?: string;
  isExpired: boolean;
  needsReauth: boolean;
}

export interface BrokerSyncStatusRow extends Record<string, unknown> {
  id: string;
  broker: string;
  brokerUserId: string | null;
  accountName: string | null;
  status: string;
  lastSync?: Date | null;
  tokenExpiry?: Date | null;
}

export interface BrokerSyncStatus {
  id: string;
  broker: BrokerType;
  brokerUserId: string | null;
  accountName: string | null;
  isActive: boolean;
  lastSync: string | null;
}

/**
 * The ONLY fields that may leave the service in a connection shape. Anything
 * NOT in this list (encrypted credentials, iv, authTag, raw tokens, internal
 * userId, …) is dropped by construction. This is the credential-leak guard: a
 * future `select`-widening or a no-`select` `findUnique` can pass secrets in,
 * but they can never come out.
 */
const CONNECTION_INFO_ALLOWED_FIELDS = [
  "id",
  "broker",
  "brokerUserId",
  "accountName",
  "status",
  "connectedAt",
  "lastSync",
  "tokenExpiry",
  "isExpired",
  "needsReauth",
] as const;

/** Field names that must NEVER appear in a returned connection shape. */
export const SECRET_FIELD_NAMES = [
  "encryptedCreds",
  "iv",
  "authTag",
  "accessToken",
  "refreshToken",
  "apiSecret",
  "apiKey",
  "token",
  "credentials",
  "encrypted",
] as const;

/**
 * Map a DB connection row to the client/api `BrokerConnectionInfo` shape.
 *
 * Builds the result field-by-field from the whitelist (NO spread of the row),
 * so encrypted credentials / tokens can never leak. Dates are serialised with
 * the Invalid-Date-safe `safeISOString`. Expiry + reauth are derived through
 * the hardened state machine.
 */
export function toBrokerConnectionInfo(
  conn: BrokerConnectionRow,
  now: Date = new Date(),
): BrokerConnectionInfo {
  // Field-by-field copy (whitelist) — never spread the raw row.
  return {
    id: conn.id,
    broker: conn.broker as BrokerType,
    brokerUserId: conn.brokerUserId,
    accountName: conn.accountName,
    status: conn.status,
    connectedAt: safeISOString(conn.connectedAt),
    lastSync: safeISOString(conn.lastSync),
    tokenExpiry: safeISOString(conn.tokenExpiry),
    isExpired: isTokenExpired(conn.tokenExpiry, now),
    needsReauth: deriveNeedsReauth(conn.status, conn.tokenExpiry, now),
  };
}

/** Map a DB row to the sync-status shape (whitelist + Invalid-Date safe). */
export function toBrokerSyncStatus(
  conn: BrokerSyncStatusRow,
  now: Date = new Date(),
): BrokerSyncStatus {
  return {
    id: conn.id,
    broker: conn.broker as BrokerType,
    brokerUserId: conn.brokerUserId,
    accountName: conn.accountName,
    isActive: isConnectionActive(conn.status, conn.tokenExpiry, now),
    lastSync: safeISOStringOrNull(conn.lastSync),
  };
}

/**
 * Runtime assertion (defense-in-depth): no secret field name appears as an own
 * key of a mapped connection shape. The mapper above already guarantees this by
 * construction; this is exported so a test can pin it and a `JSON.stringify`
 * audit is cheap. Returns the offending key, or `null` when clean.
 */
export function findLeakedSecretField(
  shape: Record<string, unknown>,
): string | null {
  for (const k of Object.keys(shape)) {
    if ((SECRET_FIELD_NAMES as readonly string[]).includes(k)) return k;
  }
  return null;
}

/** The exact set of keys a `BrokerConnectionInfo` is allowed to expose. */
export function allowedConnectionInfoKeys(): readonly string[] {
  return CONNECTION_INFO_ALLOWED_FIELDS;
}
