/**
 * Broker market-data status — pure logic + cache orchestration (MONEY-1124).
 *
 * `getBrokerMarketDataStatus` ran TWO Prisma queries — a `user.findFirst` with
 * an `OR: [{clerkId},{email}]` and a `brokerConnection.findMany` — on every
 * call, purely to decide which UI disclaimer to render. `/api/market/quote`
 * calls it on a path the UI polls every 5 seconds, so a single open positions
 * tab was doing 24 DB queries a minute for a string.
 *
 * This module holds the resolution with all I/O behind {@link BrokerStatusPorts}
 * so the caching, the freshness boundary and the status derivation are testable
 * without Prisma, Clerk or Redis. `./broker-status.ts` supplies the real ports.
 *
 * ── What is cached, and what is NOT ──────────────────────────────────────
 * The cache stores the RAW connection rows, not the derived status. Token
 * expiry is therefore re-evaluated against the live clock on every call: a
 * token that lapses inside the cache window still flips to `needs_reauth`
 * immediately. Only "which connections exist" can go stale.
 *
 * ── Which way staleness errs ─────────────────────────────────────────────
 * `status: "active"` is the only value that HIDES the exchange-delayed
 * disclaimer (`components/market/DelayedDataNote.tsx`), so a stale "active" is
 * the unsafe direction. Two things bound it:
 *   1. the connections cache lives under the `brokers` module keyed by the
 *      INTERNAL user id, which the existing disconnect path already sweeps via
 *      `clearBrokerConnectionCache(userId)` → `clearUserCache(userId,
 *      "brokers")` (`packages/services/src/broker-connection.service.ts`, and
 *      `workers/src/processors/sync.ts` after a sync);
 *   2. the TTL is 60s — exactly the window `/api/market/broker-status` already
 *      grants the browser via `Cache-Control: private, max-age=60`, so no
 *      consumer sees staleness it wasn't already accepting.
 * The opposite direction (a just-CONNECTED user briefly still seeing "delayed
 * data") is the safe/compliant one and is left to expire naturally.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface BrokerMarketDataStatus {
  hasBroker: boolean;
  broker: string | null;
  status: "active" | "needs_reauth" | "none";
  brokerDisplayName: string | null;
  reauthUrl: string | null;
}

/** A Zerodha connection row as stored in the cache (JSON-safe). */
export interface BrokerConnectionSnapshot {
  status: string;
  /** ISO string, or null when the row has no expiry. */
  tokenExpiry: string | null;
}

/** Row shape as Prisma returns it. */
export interface BrokerConnectionRow {
  status: string;
  tokenExpiry: Date | string | null;
}

export interface BrokerStatusPorts {
  /** Cached clerkId → internal user id. `null` = cache miss. */
  readUserIdCache(clerkUserId: string): Promise<{ id: string | null } | null>;
  writeUserIdCache(
    clerkUserId: string,
    value: { id: string | null }
  ): Promise<void>;
  findUserId(clerkUserId: string): Promise<string | null>;

  /** Cached connection rows for a user. `null` = cache miss. */
  readConnectionsCache(
    userId: string
  ): Promise<BrokerConnectionSnapshot[] | null>;
  writeConnectionsCache(
    userId: string,
    snapshots: BrokerConnectionSnapshot[]
  ): Promise<void>;
  findConnections(userId: string): Promise<BrokerConnectionRow[]>;

  /** Re-auth URL for the current environment, or null when unconfigured. */
  reauthUrl(): string | null;
  now(): number;
}

// ─── Constants ───────────────────────────────────────────────────────

/**
 * Cache lifetime, in seconds, for both the clerkId→userId mapping and the
 * connection rows. Matches the `max-age=60` the broker-status route already
 * hands the browser, so this introduces no staleness the product wasn't
 * already living with.
 */
export const BROKER_STATUS_CACHE_TTL_SECONDS = 60;

/** Cache identifier for the clerkId → internal user id mapping. */
export const BROKER_USER_CACHE_IDENTIFIER = "market-data-user-id";

/**
 * Cache identifier for the Zerodha connection rows.
 *
 * Lives under the `brokers` module so `clearBrokerConnectionCache(userId)`
 * (which clears `brokers:<userId>:*`) invalidates it on disconnect/sync.
 */
export const BROKER_CONNECTIONS_CACHE_IDENTIFIER = "market-data-connections";

/** The "no broker at all" answer — also the safe degrade for any failure. */
export const NO_BROKER_STATUS: BrokerMarketDataStatus = {
  hasBroker: false,
  broker: null,
  status: "none",
  brokerDisplayName: null,
  reauthUrl: null,
};

// ─── Pure helpers ────────────────────────────────────────────────────

/** Normalise a Prisma row into the JSON-safe cached shape. */
export function toConnectionSnapshots(
  rows: readonly BrokerConnectionRow[]
): BrokerConnectionSnapshot[] {
  return rows.map((row) => ({
    status: row.status,
    tokenExpiry:
      row.tokenExpiry instanceof Date
        ? row.tokenExpiry.toISOString()
        : typeof row.tokenExpiry === "string"
          ? row.tokenExpiry
          : null,
  }));
}

/** Epoch ms of a snapshot's expiry, or null when absent/unparseable. */
export function snapshotExpiryMs(
  snapshot: BrokerConnectionSnapshot
): number | null {
  if (!snapshot.tokenExpiry) return null;
  const ms = Date.parse(snapshot.tokenExpiry);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * MONEY-837: evaluate ALL Zerodha connections, not "the newest single row".
 * This page-level banner is a coarse "your Zerodha sync is paused" signal, so
 * suppress it as long as ANY Zerodha connection is healthy — one account being
 * re-authed today must not be hidden behind another account's stale token, and
 * a healthy account must not be drowned by a banner. Per-account re-auth nudges
 * live on the /brokers page, which shows a badge per connection.
 *
 * `nowMs` is passed in (never read from the cache) so token expiry is always
 * judged against the live clock even when the rows themselves came from cache.
 */
export function deriveBrokerMarketDataStatus(
  snapshots: readonly BrokerConnectionSnapshot[],
  nowMs: number,
  reauthUrl: string | null
): BrokerMarketDataStatus {
  if (snapshots.length === 0) return NO_BROKER_STATUS;

  const anyActive = snapshots.some((c) => {
    if (c.status !== "CONNECTED") return false;
    const expiry = snapshotExpiryMs(c);
    return expiry !== null && expiry > nowMs;
  });

  if (anyActive) {
    return {
      hasBroker: true,
      broker: "ZERODHA",
      status: "active",
      brokerDisplayName: "Zerodha",
      reauthUrl: null,
    };
  }

  // No healthy Zerodha connection remains — surface the re-auth nudge.
  return {
    hasBroker: true,
    broker: "ZERODHA",
    status: "needs_reauth",
    brokerDisplayName: "Zerodha",
    reauthUrl,
  };
}

// ─── Resolver ────────────────────────────────────────────────────────

/**
 * Resolve the caller's broker market-data status, reading through a 60s
 * user-scoped cache for both DB queries.
 *
 * Never throws — every failure degrades to {@link NO_BROKER_STATUS}, which is
 * the direction that SHOWS the delayed-data disclaimer. Nothing is written to
 * the cache on a failed read, so an outage cannot poison the entry.
 */
export async function resolveBrokerMarketDataStatus(
  clerkUserId: string | null,
  ports: BrokerStatusPorts
): Promise<BrokerMarketDataStatus> {
  if (!clerkUserId) return NO_BROKER_STATUS;

  try {
    // 1. clerkId → internal user id. Cached as an OBJECT so a genuine
    //    "no such user" (`{ id: null }`) is distinguishable from a cache miss.
    let userId: string | null;
    const cachedUser = await ports.readUserIdCache(clerkUserId);
    if (cachedUser) {
      userId = cachedUser.id;
    } else {
      userId = await ports.findUserId(clerkUserId);
      await ports.writeUserIdCache(clerkUserId, { id: userId });
    }

    if (!userId) return NO_BROKER_STATUS;

    // 2. Connection rows (raw, so expiry stays live-evaluated).
    let snapshots = await ports.readConnectionsCache(userId);
    if (snapshots === null) {
      snapshots = toConnectionSnapshots(await ports.findConnections(userId));
      await ports.writeConnectionsCache(userId, snapshots);
    }

    if (snapshots.length === 0) return NO_BROKER_STATUS;

    return deriveBrokerMarketDataStatus(
      snapshots,
      ports.now(),
      ports.reauthUrl()
    );
  } catch (error) {
    console.error("getBrokerMarketDataStatus error:", error);
    return NO_BROKER_STATUS;
  }
}
